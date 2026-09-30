/**
 * test_grenade_catchup.js — a thrown grenade must fly from the CLIENT's throw tick, not ours.
 *
 * THE BUG THIS PINS, AND HOW IT WAS FOUND
 * ───────────────────────────────────────
 * A live diff of the server's per-tick state against the client's own recording of the same ticks
 * (scripts/live_parity_diff.js) showed the two in PERFECT lockstep — 237 consecutive ticks at 0.000u,
 * identical inputs, identical sub-frame attribution. Then an impulse grenade detonated TWO TICKS
 * LATER on the server, and from that instant the server ran the identical trajectory permanently 2
 * ticks behind: server(t) == client(t-2), exactly, for y, vy and jumpState.
 *
 * That is catastrophic rather than cosmetic, because once the positions differ the two sims interact
 * with DIFFERENT GEOMETRY — one clips a wall the other sails past — so the gap compounds without
 * bound. Measured: 30u after 100 ticks, 90u after 200. Exactly one lag transition occurred in the
 * whole session, and it was within 12 ticks of an impulse throw.
 *
 * The cause is timing, not physics. The client simulates its own grenade from the tick it threw on;
 * the server spawns one only when it PROCESSES that input — one tick of network plus inputBufferDepth
 * later. The fix advances a new grenade by exactly that lag.
 *
 * Usage:  node scripts/test_grenade_catchup.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = '18435';
process.env.EVIO_JOIN_DEADLINE = '0';

const srv = require('../local_ws_server');
const bpw = require('../physics_world');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// Fly a grenade with a given catch-up and report where it ends up after N sim ticks.
function flyWith(catchUp, ticks) {
  const ents = srv.getActiveEntities();
  ents.clear();
  const key = 900000 + catchUp;
  ents.set(key, {
    sessionId: key, ownerSid: 1,
    pos: { x: 0, y: 30, z: 0 },
    vel: { x: 6, y: 0, z: 0 },
    type: 52,                       // smoke: settles rather than damaging anyone
    numberProp: 0, spawnTick: 0, _bornTick: 0, fuse: 100000, isStuck: 0,
    combat: null, armed: false, ray: null,
    _catchUp: catchUp,
  });
  const sessions = new Map();
  for (let i = 0; i < ticks; i++) srv.simulateGrenades(0.05, sessions);
  const g = ents.get(key);
  const out = g ? { x: g.pos.x, y: g.pos.y, z: g.pos.z, alive: true } : { alive: false };
  ents.clear();
  return out;
}

(async () => {
  await bpw.ready;
  srv.startServer();
  await wait(300);

  console.log('\n── catch-up advances a grenade by exactly the input lag ──');
  {
    // A grenade with catchUp=2 simulated for N ticks must be where a catchUp=0 one is after N+2.
    const a = flyWith(0, 8);
    const b = flyWith(2, 6);
    ok('both are still in flight', a.alive && b.alive);
    const d = a.alive && b.alive ? Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) : Infinity;
    ok('catchUp=2 after 6 ticks == catchUp=0 after 8 ticks', d < 1e-9,
      `${d} apart — a=(${a.x},${a.y?.toFixed(3)}) b=(${b.x},${b.y?.toFixed(3)})`);
  }

  console.log('\n── and it is consumed exactly once ──');
  {
    // If catch-up re-applied every tick the grenade would accelerate away down the flight path.
    const one = flyWith(3, 5);
    const zero = flyWith(0, 8);
    const d = Math.hypot(one.x - zero.x, one.y - zero.y, one.z - zero.z);
    ok('a 3-tick catch-up shifts the flight by exactly 3 ticks, not more', d < 1e-9, `${d} apart`);
  }

  console.log('\n── no catch-up leaves behaviour unchanged ──');
  {
    const a = flyWith(0, 10);
    const b = flyWith(0, 10);
    ok('catchUp=0 is deterministic and unchanged', a.alive && b.alive
      && Math.abs(a.x - b.x) < 1e-12 && Math.abs(a.y - b.y) < 1e-12);
  }

  console.log('\n── the lag the server records is sane ──');
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    // Real (non-bot) sessions still measure this from actual queue backlog, clamped so a stalled
    // client cannot request a huge catch-up. Bots take a different branch of the same ternary — see
    // BOT_SIM_LATENCY_MS — so the pattern now allows either side to appear after the `=`.
    ok('the input lag is measured at drain time',
      /_inputLagTicks\s*=\s*session\.isBot[\s\S]{0,80}?Math\.max\(0,\s*\r?\n?\s*Math\.min\(10,/.test(src),
      'clamped so a stalled client cannot request a huge catch-up');
    ok('and spawnGrenade consumes it', /_catchUp:\s*Math\.max\(0,\s*Math\.min\(10,\s*playerState\._inputLagTicks/.test(src));

    // ORDERING. The grenade cast happens INSIDE integratePlayerSim, so the lag must be assigned
    // before it or every throw reads the previous tick's value — which is exactly how the first
    // version of this fix shipped and did nothing. Source order is the only way to check it, since
    // the symptom is a silently stale number rather than an error.
    const iAssign = src.indexOf('playerState._inputLagTicks = session.isBot');
    const iIntegrate = src.indexOf('integratePlayerSim(playerState, TICK_MS / 1000, globalTick, batch.frames)');
    ok('the lag is assigned BEFORE the tick that spawns the grenade',
      iAssign > 0 && iIntegrate > 0 && iAssign < iIntegrate,
      `assign@${iAssign} integrate@${iIntegrate}`);
    ok('the in-flight component is configurable', /key:\s*"grenadeCatchupExtra"/.test(src),
      'tick numbers cannot reveal packet flight time, so it has to be tunable');
  }

  console.log('\n── a grenade that should already have landed detonates immediately ──');
  {
    // Thrown at the ground from very close: with a large catch-up the whole flight is already over,
    // so the entity must be gone after ONE sim tick rather than lingering.
    const ents = srv.getActiveEntities();
    ents.clear();
    ents.set(910001, {
      sessionId: 910001, ownerSid: 1,
      pos: { x: 0, y: 3, z: 0 }, vel: { x: 0, y: -20, z: 0 },
      type: 52, numberProp: 0, spawnTick: 0, _bornTick: 0, fuse: 100000, isStuck: 0,
      combat: null, armed: false, ray: null, _catchUp: 6,
    });
    srv.simulateGrenades(0.05, new Map());
    const g = ents.get(910001);
    ok('it resolved during catch-up rather than flying on',
      !g || g.isStuck || Math.abs(g.vel.y) < 1e-9,
      g ? `still moving: y=${g.pos.y.toFixed(2)} vy=${g.vel.y.toFixed(2)}` : 'removed');
    ents.clear();
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
