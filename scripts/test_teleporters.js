/**
 * test_teleporters.js — map portals.
 *
 * The .evmap teleporter section (flags2 & 4) used to be parsed as "dynamic objects" and discarded,
 * so maps with portals had none on the server. That is not a cosmetic gap: the client simulates
 * the teleport itself in the same tick as movement, and `justTeleported` (Qgxywsl) is one of the
 * fields the reconciler compares — so a non-teleporting server disagrees on position AND on a
 * compared boolean the instant anyone steps through, which snaps them.
 *
 * These assertions pin the parts that must match the client bit-for-bit:
 *   - the destination hash (multi-exit portals must pick the SAME exit on both sides)
 *   - fire-on-enter semantics (you must not ping-pong on the exit pad)
 *   - the yaw/velocity re-basing
 *
 * Usage:  node scripts/test_teleporters.js
 */
'use strict';

const tp = require('../map_teleporters');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

// A pair of portals facing opposite ways, 100 units apart.
const pair = () => ([
  { Qdsukt4: { x: 0, y: 0, z: 0 },   Qrmqlp: 0,       Quwa9s1: 2, Qcnqzx4: [1], Qrtt124: '' },
  { Qdsukt4: { x: 100, y: 0, z: 0 }, Qrmqlp: Math.PI, Quwa9s1: 2, Qcnqzx4: [0], Qrtt124: '' },
]);
const mkPs = (x, y, z) => ({
  Qdsukt4: { x, y, z }, Qyaswvo: { x: 0, y: 0, z: 0 },
  Qqg4go0: 0, Qu5q59u: -1, Qgxywsl: false, Qte59p5: 0,
});

console.log('\n── the deterministic destination hash (bundle Qvhp9hu) ──');
{
  // Ported bit-for-bit because a multi-exit portal picks its exit with hash(String(player.x)).
  // Math.random() would send client and server to different exits.
  const h = tp.hashUnit('27.5');
  ok('returns a unit float', h >= 0 && h < 1, String(h));
  ok('is deterministic', tp.hashUnit('27.5') === h);
  ok('differs for a different input', tp.hashUnit('27.6') !== h);
  ok('handles the empty string', tp.hashUnit('') >= 0);
}

console.log('\n── entering a portal moves you to its pair ──');
{
  const t = pair(), ps = mkPs(0, 0, 0);
  const moved = tp.applyMapTeleporters(ps, t, 5, []);
  ok('the teleport fires', moved === true);
  ok('position is the destination', ps.Qdsukt4.x === 100 && ps.Qdsukt4.z === 0,
    `${ps.Qdsukt4.x},${ps.Qdsukt4.z}`);
  ok('justTeleported is raised (the reconciler compares it)', ps.Qgxywsl === true);
  ok('you are marked as inside the DESTINATION, not the entrance', ps.Qu5q59u === 1,
    'otherwise you bounce straight back');
}

console.log('\n── it fires on ENTER only, never repeatedly ──');
{
  const t = pair(), ps = mkPs(0, 0, 0), used = [];
  tp.applyMapTeleporters(ps, t, 1, used);
  const afterFirst = { ...ps.Qdsukt4 };
  // Still standing on the exit pad on the next tick.
  const again = tp.applyMapTeleporters(ps, t, 2, used);
  ok('a second tick inside the exit does nothing', again === false);
  ok('position is unchanged', ps.Qdsukt4.x === afterFirst.x && ps.Qdsukt4.z === afterFirst.z);

  // Walk out, then back in.
  ps.Qdsukt4.x = 50;
  tp.applyMapTeleporters(ps, t, 3, used);
  ok('leaving clears the current teleporter', ps.Qu5q59u === -1);
  ps.Qdsukt4.x = 100;
  ok('re-entering teleports again', tp.applyMapTeleporters(ps, t, 4, used) === true);
  ok('and lands back at the first portal', ps.Qdsukt4.x === 0);
}

console.log('\n── trigger volume matches the client (centre probe, radius + 1) ──');
{
  // The client probes at position + (0,1,0) against radius + 1.
  const t = pair();
  ok('dead centre is inside', tp.teleporterAt({ x: 0, y: -1, z: 0 }, t) === 0);
  ok('just inside radius+1 triggers', tp.teleporterAt({ x: 2.9, y: -1, z: 0 }, t) === 0);
  ok('outside radius+1 does not', tp.teleporterAt({ x: 3.1, y: -1, z: 0 }, t) === -1);
  // The probe is 1 unit ABOVE the feet, so a portal at head height still catches you.
  ok('the probe is offset a unit up', tp.teleporterAt({ x: 0, y: 0, z: 0 }, t) === 0);
}

console.log('\n── yaw and velocity are re-based by the portal pair ──');
{
  const t = pair(), ps = mkPs(0, 0, 0);
  ps.Qyaswvo = { x: 10, y: 3, z: 0 };     // running +X into the entrance
  ps.Qqg4go0 = 0;
  tp.applyMapTeleporters(ps, t, 1, []);
  // delta = to.Qrmqlp - from.Qrmqlp + PI = PI - 0 + PI = 2PI -> velocity effectively unchanged.
  ok('vertical speed is preserved', Math.abs(ps.Qyaswvo.y - 3) < 1e-9);
  ok('horizontal speed magnitude is preserved',
    Math.abs(Math.hypot(ps.Qyaswvo.x, ps.Qyaswvo.z) - 10) < 1e-6,
    `${ps.Qyaswvo.x},${ps.Qyaswvo.z}`);
  ok('yaw is rotated by the pair delta',
    Math.abs(ps.Qqg4go0 - (Math.PI + 0 - 0 + Math.PI)) < 1e-9, String(ps.Qqg4go0));

  // A 90-degree pair must actually turn the velocity.
  const t2 = pair();
  t2[1].Qrmqlp = Math.PI / 2;
  const ps2 = mkPs(0, 0, 0);
  ps2.Qyaswvo = { x: 10, y: 0, z: 0 };
  tp.applyMapTeleporters(ps2, t2, 1, []);
  ok('a rotated pair turns the velocity',
    Math.abs(Math.hypot(ps2.Qyaswvo.x, ps2.Qyaswvo.z) - 10) < 1e-6 && Math.abs(ps2.Qyaswvo.x) < 1e-6,
    `${ps2.Qyaswvo.x.toFixed(3)},${ps2.Qyaswvo.z.toFixed(3)}`);
}

console.log('\n── the cases that must NOT teleport ──');
{
  // Qrtt124 is a GAME MODE name, not a destination: hub portals switch lobby, they do not move you.
  const hub = [{ Qdsukt4: { x: 0, y: 0, z: 0 }, Qrmqlp: 0, Quwa9s1: 2, Qcnqzx4: [1], Qrtt124: 'Deathmatch' },
               { Qdsukt4: { x: 9, y: 0, z: 0 }, Qrmqlp: 0, Quwa9s1: 2, Qcnqzx4: [0], Qrtt124: '' }];
  const ps = mkPs(0, 0, 0);
  ok('a game-mode portal does not move the player',
    tp.applyMapTeleporters(ps, hub, 1, []) === false && ps.Qdsukt4.x === 0);
  ok('but it still raises justTeleported (the client does)', ps.Qgxywsl === true);

  // An exit-only pad (no destinations) is not an entrance.
  const exitOnly = [{ Qdsukt4: { x: 0, y: 0, z: 0 }, Qrmqlp: 0, Quwa9s1: 2, Qcnqzx4: [], Qrtt124: '' }];
  ok('a destination-less pad never triggers',
    tp.teleporterAt({ x: 0, y: -1, z: 0 }, exitOnly) === -1);

  // A dangling id must not throw or move you to undefined.
  const broken = [{ Qdsukt4: { x: 0, y: 0, z: 0 }, Qrmqlp: 0, Quwa9s1: 2, Qcnqzx4: [99], Qrtt124: '' }];
  const ps3 = mkPs(0, 0, 0);
  ok('a dangling destination id is ignored', tp.applyMapTeleporters(ps3, broken, 1, []) === false);
  ok('and leaves the position finite', Number.isFinite(ps3.Qdsukt4.x) && ps3.Qdsukt4.x === 0);

  const ps4 = mkPs(0, 0, 0);
  ok('a map with no teleporters is a no-op', tp.applyMapTeleporters(ps4, [], 1, []) === false);
  ok('a null list is a no-op', tp.applyMapTeleporters(ps4, null, 1, []) === false);
}

console.log('\n── multi-exit portals pick one exit, consistently ──');
{
  const multi = [
    { Qdsukt4: { x: 0, y: 0, z: 0 },  Qrmqlp: 0, Quwa9s1: 2, Qcnqzx4: [1, 2], Qrtt124: '' },
    { Qdsukt4: { x: 50, y: 0, z: 0 }, Qrmqlp: 0, Quwa9s1: 2, Qcnqzx4: [0],    Qrtt124: '' },
    { Qdsukt4: { x: 80, y: 0, z: 0 }, Qrmqlp: 0, Quwa9s1: 2, Qcnqzx4: [0],    Qrtt124: '' },
  ];
  const run = (x) => { const ps = mkPs(x, 0, 0); tp.applyMapTeleporters(ps, multi, 1, []); return ps.Qdsukt4.x; };
  ok('lands on one of the exits', [50, 80].includes(run(0.5)), String(run(0.5)));
  ok('the same entry x always picks the same exit', run(0.5) === run(0.5),
    'the pick is hash(String(x)) — anything random would desync client and server');
}

console.log('\n── the VFX stamp (opcode 308) ──');
{
  const t = pair(), used = [], ps = mkPs(0, 0, 0);
  tp.applyMapTeleporters(ps, t, 77, used);
  ok('both ends of the pair are stamped with the tick', used[0] === 77 && used[1] === 77,
    JSON.stringify(used));
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
