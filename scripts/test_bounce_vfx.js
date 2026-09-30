/**
 * test_bounce_vfx.js — the wall-bounce smoke ring.
 *
 * The client plays 'grenadeBounce' only when the STREAMED bounce counter changes AND the streamed
 * impact speed exceeds 0.5 (bundle :50831):
 *
 *   n.Qp9j5e3 !== i.Qp9j5e3 && n.Qxxwo42 > .5 && emit('grenadeBounce', pos, ...)
 *
 * Both values come purely from the entity stream — opcodes 257 (Qp9j5e3, bounce count) and 258
 * (Qxxwo42, impact speed). The server sent neither, so no ring appeared for anyone, thrower or peer.
 *
 * Separate from test_grenade_parity because this one needs the collision world loaded (await
 * bpw.ready) to actually bounce a grenade off the floor.
 *
 * Usage:  node scripts/test_bounce_vfx.js
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

(async () => {
  await bpw.ready;
  const sp = bpw.spawnPoints[0];

  function throwAt(vel) {
    srv.activeEntities.clear();
    srv.activeEntities.set('g1', {
      sessionId: 'g1', ownerSid: 't', type: 46,
      pos: { x: sp.x, y: sp.y + 3, z: sp.z }, vel: { ...vel },
      fuse: 40, spawnTick: 0, isStuck: 0,
      combat: { behavior: 'timer', dmg: 250, aoe: 11, fuse: 40 },
    });
    for (let t = 0; t < 25; t++) {
      srv.simulateGrenades(0.05, new Map());
      const b = srv.buildActiveEntityBlock();
      const i = b.indexOf(257);
      if (i >= 0) return { bounces: b[i + 1], speed: b[b.indexOf(258) + 1], block: b };
    }
    return null;
  }

  console.log('\n── a hard bounce streams the ring state ──');
  {
    const seen = throwAt({ x: 6, y: -25, z: 0 });
    ok('opcode 257 carries the bounce count', !!seen && seen.bounces >= 1,
      seen ? String(seen.bounces) : 'never emitted');
    ok('opcode 258 carries the impact speed', !!seen && typeof seen.speed === 'number');
    ok('the speed clears the 0.5 threshold, so the ring plays',
      !!seen && seen.speed > 0.5, seen ? String(seen.speed) : '-');
    // Speed is streamed in CLIENT units (u/tick); our sim runs in u/s, hence the /20 conversion.
    ok('speed is in client units, not u/s', !!seen && seen.speed < 10,
      seen ? `${seen.speed} — a raw u/s value would be ~25 and always pass` : '-');
  }

  console.log('\n── ordering within the entity block ──');
  {
    const seen = throwAt({ x: 6, y: -25, z: 0 });
    const at = (op) => seen.block.indexOf(op);
    ok('257 precedes 258', at(257) < at(258), `257@${at(257)} 258@${at(258)}`);
    const n259 = at(259);
    ok('both precede 259 when present', n259 < 0 || at(258) < n259,
      `258@${at(258)} 259@${n259}`);
    // The client decodes entity fields in one ascending pass; 257/258 sit between 256 and 259.
    ok('and both follow 256 when present', at(256) < 0 || at(256) < at(257));
  }

  console.log('\n── the counter keeps rising so each bounce re-triggers ──');
  {
    // The client compares against the LAST value it saw, so a static counter would ring once only.
    srv.activeEntities.clear();
    srv.activeEntities.set('g2', {
      sessionId: 'g2', ownerSid: 't', type: 46,
      pos: { x: sp.x, y: sp.y + 3, z: sp.z }, vel: { x: 14, y: -25, z: 0 },
      fuse: 400, spawnTick: 0, isStuck: 0,
      combat: { behavior: 'timer', dmg: 250, aoe: 11, fuse: 400 },
    });
    const counts = new Set();
    for (let t = 0; t < 120; t++) {
      srv.simulateGrenades(0.05, new Map());
      const g = srv.activeEntities.get('g2');
      if (!g) break;
      if (g.bounces) counts.add(g.bounces);
    }
    ok('multiple distinct bounce counts were reached', counts.size >= 2,
      `saw ${[...counts].join(',')}`);
    ok('and they increase monotonically', [...counts].every((v, i, a) => i === 0 || v > a[i - 1]));
  }

  srv.activeEntities.clear();
  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
