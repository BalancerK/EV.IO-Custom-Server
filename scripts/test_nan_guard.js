/**
 * test_nan_guard.js
 *
 * Non-finite values must NEVER reach the wire.
 *
 * WHY THIS IS THE WORST POSSIBLE BUG CLASS HERE
 * ─────────────────────────────────────────────
 * Every NaN comparison is false, so a single NaN in the local player's position makes the
 * client's divergence comparator (Qqx5i3b: `Math.abs(server.x - client.x) > 1e-4`) report a
 * MATCH — forever. Reconciliation then never corrects anything, the client's own physics keep
 * producing NaN from NaN, and nothing self-heals: the only recovery is a page refresh. It also
 * defeats the SW1 watchdog twice over — `NaN < threshold` is false so the streak never resets,
 * and the snap would then COPY the NaN into the client.
 *
 * `round()` does not stop it either: Number(NaN.toFixed(4)) === NaN, and msgpack encodes and
 * decodes NaN happily.
 *
 * Reported symptom that motivated this: throwing an impulse grenade under yourself desyncs
 * roughly 1 in 5 throws, and once it happens only a browser refresh recovers — which is exactly
 * the signature of NaN poisoning rather than a transient reconciliation miss.
 *
 * Usage:  node scripts/test_nan_guard.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');
const bpw = require('../physics_world');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const finite = (v) => Number.isFinite(v);
function scanBody(body) {
  // Every numeric value in a tick body must be finite. A NaN anywhere in the positional block
  // poisons the client's state permanently.
  const bad = [];
  for (let i = 0; i < body.length; i++) {
    const v = body[i];
    if (typeof v === 'number' && !Number.isFinite(v)) bad.push({ index: i, value: v, prev: body[i - 1] });
  }
  return bad;
}

bpw.ready.catch(() => {}).then(() => {
  const spawns = srv.activeSpawnPoints();

  console.log('\n── round() and the emit path do not stop NaN by themselves ──');
  {
    ok('Number(NaN.toFixed(4)) is still NaN (round() is not a guard)',
      !Number.isFinite(Number(NaN.toFixed(4))));
  }

  console.log('\n── impulse knockback over many geometries stays finite ──');
  {
    let nonFinite = 0, cases = 0, worst = null;
    // Sweep blast offsets around the player, including the degenerate ones: exactly at the
    // feet, exactly at the chest reference point, and zero distance.
    const offsets = [];
    for (const dx of [0, 0.0001, -0.0001, 0.5, 3, 8, 10.9, 11.1])
      for (const dy of [0, -1.75, 1.75, 0.0001, 5])
        for (const dz of [0, 0.0001, 2]) offsets.push([dx, dy, dz]);

    for (const sp of spawns.slice(0, 6)) {
      for (const [dx, dy, dz] of offsets) {
        cases++;
        const ps = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 'nan-' + cases);
        ps._ownerSid = 'nan-' + cases;
        const sessions = new Map([['s', { accepted: true, playerState: ps }]]);
        srv.applyImpulse({ x: sp.x + dx, y: sp.y + dy, z: sp.z + dz }, sessions);
        // Then integrate forward — a finite impulse can still become NaN through the sweep.
        for (let t = 0; t < 25; t++) srv.integratePlayerSim(ps, 0.05, t);
        const p = ps.position, v = ps.velocity;
        const bad = !finite(p.x) || !finite(p.y) || !finite(p.z)
                 || !finite(v.x) || !finite(v.y) || !finite(v.z);
        if (bad) { nonFinite++; if (!worst) worst = { offset: [dx, dy, dz], pos: { ...p }, vel: { ...v } }; }
      }
    }
    ok(`${cases} impulse geometries × 25 ticks produce only finite state`, nonFinite === 0,
      nonFinite + ' non-finite' + (worst ? ' e.g. ' + JSON.stringify(worst) : ''));
  }

  console.log('\n── explosion knockback stays finite ──');
  {
    let nonFinite = 0, cases = 0;
    for (const sp of spawns.slice(0, 4)) {
      for (const d of [0, 0.0001, 1, 5, 10]) {
        cases++;
        const ps = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 'ex-' + cases);
        srv.applyExplosionKnockback(ps, { x: sp.x + d, y: sp.y, z: sp.z }, 250, 11, d);
        for (let t = 0; t < 15; t++) srv.integratePlayerSim(ps, 0.05, t);
        const p = ps.position, v = ps.velocity;
        if (!finite(p.x) || !finite(p.y) || !finite(p.z)
         || !finite(v.x) || !finite(v.y) || !finite(v.z)) nonFinite++;
      }
    }
    ok(`${cases} explosion-knockback geometries stay finite`, nonFinite === 0, nonFinite + ' bad');
  }

  console.log('\n── the emit boundary must SANITISE, not propagate ──');
  {
    // Even if some future code path produces NaN, the wire must stay clean. Force a poisoned
    // sim state and confirm the tick body it produces contains no non-finite numbers.
    const ps = srv.createPlayerSimState({ x: 0, y: 5, z: 0, yaw: 0 }, 'poison');
    ps.position.x = NaN; ps.position.y = Infinity; ps.position.z = -Infinity;
    ps.velocity.x = NaN; ps.velocity.y = NaN; ps.velocity.z = NaN;
    ps.yaw = NaN; ps.pitch = NaN; ps.pitchOffset = NaN;
    if (ps._ps) {
      ps._ps.Qdsukt4.x = NaN; ps._ps.Qdsukt4.y = NaN; ps._ps.Qdsukt4.z = NaN;
      ps._ps.Qyaswvo.x = NaN; ps._ps.Qyaswvo.y = NaN; ps._ps.Qyaswvo.z = NaN;
    }
    const body = [];
    srv.appendPlayerTickBody(body, 'poison', ps);
    const bad = scanBody(body);
    ok('a poisoned player state emits NO non-finite values', bad.length === 0,
      bad.length + ' found: ' + JSON.stringify(bad.slice(0, 6)));
    ok('and the emitted position is a usable finite fallback',
      body.some((v, i) => body[i - 1] === 136) && bad.length === 0);
  }

  console.log('\n── a poisoned state gets repaired, not left broken ──');
  {
    const ps = srv.createPlayerSimState({ x: 0, y: 5, z: 0, yaw: 0 }, 'repair');
    if (ps._ps) { ps._ps.Qdsukt4.y = NaN; ps._ps.Qyaswvo.y = NaN; }
    ps.position.y = NaN; ps.velocity.y = NaN;
    srv.integratePlayerSim(ps, 0.05, 1);
    ok('integrating a poisoned state restores finite position',
      finite(ps.position.x) && finite(ps.position.y) && finite(ps.position.z),
      JSON.stringify(ps.position));
    ok('and finite velocity',
      finite(ps.velocity.x) && finite(ps.velocity.y) && finite(ps.velocity.z),
      JSON.stringify(ps.velocity));
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
});
