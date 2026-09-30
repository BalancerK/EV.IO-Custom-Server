/**
 * test_grenade_hardening.js — the failure modes of thrown entities that break OTHER people.
 *
 * The grenade sim already survives its own faults: every entity steps inside a try/catch and an
 * absolute lifetime cap force-removes anything that outlives it. What was missing is the two ways a
 * throwable can damage the people watching it rather than itself:
 *
 *   1. A NON-FINITE POSITION ON THE WIRE. Player transforms go out through round(), which routes
 *      non-finite values to fin() and substitutes a safe value. Entity positions were pushed RAW.
 *      One NaN in a grenade position is not a cosmetic glitch: the client's reconciler comparator
 *      treats NaN as a MATCH, so the desync is never corrected and the only recovery is a page
 *      refresh. One bad throw would brick every client that could see it.
 *
 *   2. UNBOUNDED ENTITY COUNT. Entities were limited only by the 120s lifetime cap, and every live
 *      entity is streamed to EVERY client EVERY tick — so the cost is entities x players. Long-lived
 *      throwables (mines, trip mines) accumulate, and the packet grows without limit.
 *
 * Usage:  node scripts/test_grenade_hardening.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = '18395';
process.env.EVIO_JOIN_DEADLINE = '0';

const WebSocket = require('ws');
const msgpack = require('@msgpack/msgpack');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const S = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = 'ws://127.0.0.1:18395';

// Walk a decoded body and report any non-finite number anywhere in it.
function nonFiniteIn(body) {
  const bad = [];
  for (let i = 0; i < body.length; i++) {
    const v = body[i];
    if (typeof v === 'number' && !Number.isFinite(v)) bad.push({ index: i, value: String(v) });
  }
  return bad;
}
function entityCount(body) {
  let n = 0;
  for (let i = 0; i < body.length - 1; i++) if (body[i] === 268 && body[i + 1] !== -1) n++;
  return n;
}

(async () => {
  await bpw.ready;
  srv.startServer();
  await wait(300);

  const ws = new WebSocket(URL);
  await new Promise((r) => ws.on('open', r));
  ws.send(';' + JSON.stringify({ uid: 17, name: 'Thrower' }));
  await wait(500);

  const sessions = srv.getSessions();
  const session = [...sessions.values()][0];
  const ents = srv.getActiveEntities ? srv.getActiveEntities() : null;

  const bodies = [];
  ws.on('message', (buf) => {
    let env; try { env = msgpack.decode(buf); } catch (_) { return; }
    if (Array.isArray(env) && Array.isArray(env[2])) bodies.push(env[2]);
  });

  ok('the entity map is reachable for testing', !!ents, 'getActiveEntities export');
  if (!ents) { console.log('cannot continue'); process.exit(1); }

  console.log('\n── a non-finite entity position must never reach the wire ──');
  {
    ents.clear();
    // A grenade whose position has gone bad. This is not hypothetical: the impulse/explosion maths
    // normalises direction vectors, and a zero-length vector there yields NaN.
    ents.set(999001, {
      sessionId: 999001, ownerSid: 1,
      pos: { x: NaN, y: 5, z: 0 },
      vel: { x: 0, y: Infinity, z: 0 },
      type: 355, numberProp: 11, spawnTick: 0, _bornTick: 0, fuse: 200, isStuck: 0,
      combat: null, armed: false, ray: null,
    });
    bodies.length = 0;
    await wait(500);
    let bad = [];
    for (const b of bodies) bad = bad.concat(nonFiniteIn(b));
    ok('no NaN or Infinity is emitted', bad.length === 0,
      bad.length ? JSON.stringify(bad.slice(0, 4)) : '');
    ents.clear();
    await wait(200);
  }

  console.log('\n── a bad position is repaired, not silently streamed ──');
  {
    ents.clear();
    ents.set(999002, {
      sessionId: 999002, ownerSid: 1,
      pos: { x: 10, y: NaN, z: -4 },
      vel: { x: 0, y: 0, z: 0 },
      type: 52, numberProp: 0, spawnTick: 0, _bornTick: 0, fuse: 200, isStuck: 0,
      combat: null, armed: false, ray: null,
    });
    await wait(400);
    // Either it was removed outright or its position was made finite — both are acceptable; what is
    // not acceptable is a live entity carrying NaN.
    const still = ents.get(999002);
    ok('the entity is dropped or its position made finite',
      !still || (Number.isFinite(still.pos.x) && Number.isFinite(still.pos.y) && Number.isFinite(still.pos.z)),
      still ? JSON.stringify(still.pos) : 'removed');
    ents.clear();
    await wait(200);
  }

  console.log('\n── the number of live entities is bounded ──');
  {
    ents.clear();
    const cap = S.get('maxActiveEntities');
    ok('there is a cap setting', Number.isFinite(cap) && cap > 0, String(cap));

    // Far more than the cap, all long-lived, exactly as a match full of mines would accumulate.
    for (let i = 0; i < cap + 120; i++) {
      ents.set(500000 + i, {
        sessionId: 500000 + i, ownerSid: 1,
        pos: { x: i % 50, y: 3, z: (i * 7) % 50 },
        vel: { x: 0, y: 0, z: 0 },
        type: 173, numberProp: 0, spawnTick: 0, _bornTick: 0, fuse: 100000, isStuck: 1,
        combat: null, armed: true, ray: null,
      });
    }
    const before = ents.size;
    await wait(500);
    ok('the map is trimmed back to the cap', ents.size <= cap, `${before} -> ${ents.size}, cap ${cap}`);

    bodies.length = 0;
    await wait(300);
    const worst = bodies.reduce((m, b) => Math.max(m, entityCount(b)), 0);
    ok('and the packet carries no more than the cap', worst <= cap, `${worst} entities in one body`);
    ents.clear();
    await wait(200);
  }

  console.log('\n── the cap keeps the NEWEST entities ──');
  {
    // Trimming must not delete the grenade someone just threw while keeping a two-minute-old mine:
    // the throw that vanishes on release is far more noticeable than an old mine disappearing.
    ents.clear();
    const cap = S.get('maxActiveEntities');
    for (let i = 0; i < cap + 30; i++) {
      ents.set(600000 + i, {
        sessionId: 600000 + i, ownerSid: 1,
        pos: { x: 0, y: 3, z: 0 }, vel: { x: 0, y: 0, z: 0 },
        type: 173, numberProp: 0, spawnTick: 0,
        _bornTick: i,                      // ascending age: higher = newer
        fuse: 100000, isStuck: 1, combat: null, armed: true, ray: null,
      });
    }
    await wait(400);
    const kept = [...ents.keys()];
    const newest = 600000 + cap + 29;
    ok('the most recent entity survives the trim', kept.includes(newest),
      `kept ${kept.length}, newest present: ${kept.includes(newest)}`);
    ents.clear();
  }

  console.log('\n── the lifetime cap and per-entity isolation still hold ──');
  {
    ents.clear();
    // An entity whose step always throws must be removed, not retried forever.
    ents.set(999003, {
      sessionId: 999003, ownerSid: 1,
      pos: { x: 0, y: 3, z: 0 },
      get vel() { throw new Error('synthetic entity fault'); },
      type: 355, numberProp: 0, spawnTick: 0, _bornTick: 0, fuse: 500, isStuck: 0,
      combat: null, armed: false, ray: null,
    });
    await wait(400);
    ok('a faulting entity is removed rather than retried', !ents.has(999003));
    // The tick must still be ADVANCING, not merely non-zero. A throw inside the sim once killed the
    // scheduler permanently, and a snapshot of a stopped counter looks identical to a healthy one.
    // (The field is globalTick — an earlier version of this test read `.tick`, which does not exist,
    // so it compared undefined > 0 and failed against a perfectly healthy server.)
    const t1 = srv.getStatus().globalTick;
    await wait(300);
    const t2 = srv.getStatus().globalTick;
    ok('and the tick scheduler is still advancing', t2 > t1, `${t1} -> ${t2}`);
    ents.clear();
  }

  try { ws.close(); } catch (_) {}
  await wait(200);
  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
