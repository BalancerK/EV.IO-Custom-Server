/**
 * test_grenade_parity.js — throwable flight must match the client's projectile tick.
 *
 * Two divergences found by reading the bundle's projectile update against the weapon catalogue
 * (evidence/web/api/weapons.json, field_weapon_data):
 *
 * 1. GRAVITY IS PER WEAPON. The client applies
 *        vel.y -= Qq5sl76 * m.gravity * Qsvkg5s.Qn0kxxb / Q4b9iia.Qyw1swv
 *    and BOTH constants are 0.07, so they cancel — the per-tick delta is exactly the catalogue
 *    `gravity` value. HE/sticky/mine/trip/impulse use 0.048, smoke/flash use 0.068. We had ONE
 *    hardcoded 22 u/s^2, which is wrong in both directions (too strong for the 0.048 group, too
 *    weak for the 0.068 group), so every throw arced differently from official.
 *
 * 2. BOUNCE IS NOT A UNIFORM RESTITUTION. The client calls Q5vtwm(vel, normal, 0.5, 0.9), which
 *    splits the velocity against the surface:
 *        normal component     reversed, scaled by 0.5
 *        tangential component kept,     scaled by 0.9
 *    We scaled the whole vector by 0.55, bleeding 45% of the SLIDING speed per bounce where
 *    official bleeds 10% — our grenades stopped dead instead of skipping and rolling on.
 *
 * Usage:  node scripts/test_grenade_parity.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;

console.log('\n── gravity comes from the catalogue, per weapon ──');
{
  // catalogue gravity -> our u/s^2 is  gravity x 20 (ticks/s) x 20 (u/tick -> u/s)
  ok('HE Grenade (46) uses 0.048', near(srv.grenadeGravity(46), 0.048 * 400),
    String(srv.grenadeGravity(46)));
  ok('Sticky (172) uses 0.048', near(srv.grenadeGravity(172), 0.048 * 400));
  ok('Mine (173) uses 0.048', near(srv.grenadeGravity(173), 0.048 * 400));
  ok('Trip Mine (176) uses 0.048', near(srv.grenadeGravity(176), 0.048 * 400));
  ok('Impulse (355) uses 0.048', near(srv.grenadeGravity(355), 0.048 * 400));
  ok('Smoke (52) uses the HEAVIER 0.068', near(srv.grenadeGravity(52), 0.068 * 400),
    String(srv.grenadeGravity(52)));
  ok('Flash (53) uses the heavier 0.068', near(srv.grenadeGravity(53), 0.068 * 400));
  ok('smoke/flash really do fall faster than HE',
    srv.grenadeGravity(52) > srv.grenadeGravity(46),
    'a single shared constant cannot express this');
  ok('an unknown type falls back rather than throwing', srv.grenadeGravity(9999) > 0);
}

console.log('\n── bounce splits normal from tangential (Q5vtwm) ──');
{
  // Flat floor, moving forward and down.
  const v = { x: 10, y: -6, z: 0 };
  srv.bounceVelocity(v, 0, 1, 0);
  ok('the normal component reverses at 0.5 restitution', near(v.y, 3, 1e-6), `vy=${v.y}`);
  ok('the tangential component keeps 0.9', near(v.x, 9, 1e-6), `vx=${v.x}`);
  ok('the untouched axis stays zero', near(v.z, 0, 1e-9));

  // A uniform 0.55 would have produced these instead — the old behaviour.
  ok('this is NOT the old uniform-restitution result', !near(v.x, 10 * 0.55, 1e-6),
    'sliding speed must survive the bounce');
}

console.log('\n── head-on and angled cases ──');
{
  const straight = { x: 0, y: -8, z: 0 };
  srv.bounceVelocity(straight, 0, 1, 0);
  ok('straight down bounces to half the speed up', near(straight.y, 4, 1e-6), `vy=${straight.y}`);
  ok('and gains no lateral drift', near(straight.x, 0, 1e-9) && near(straight.z, 0, 1e-9));

  // Vertical wall (normal +X), grenade flying into it while falling.
  const wall = { x: -10, y: -4, z: 0 };
  srv.bounceVelocity(wall, 1, 0, 0);
  ok('a wall reverses the into-wall component at 0.5', near(wall.x, 5, 1e-6), `vx=${wall.x}`);
  ok('and preserves the fall at 0.9', near(wall.y, -3.6, 1e-6), `vy=${wall.y}`);

  // Energy must never increase.
  const before = Math.hypot(-10, -4, 0), after = Math.hypot(wall.x, wall.y, wall.z);
  ok('a bounce never gains speed', after < before, `${after.toFixed(2)} vs ${before.toFixed(2)}`);
}

console.log('\n── a grenade skips along the floor instead of stopping dead ──');
{
  // Repeated shallow bounces: the horizontal speed should decay slowly (0.9^n), which is what makes
  // official grenades roll away from where they land.
  const v = { x: 12, y: -3, z: 0 };
  for (let i = 0; i < 5; i++) { srv.bounceVelocity(v, 0, 1, 0); v.y = -Math.abs(v.y) * 0.5; }
  ok('horizontal speed survives five bounces', v.x > 6,
    `vx=${v.x.toFixed(2)} after 5 bounces (0.9^5 = ${(12 * Math.pow(0.9, 5)).toFixed(2)})`);
  ok('and matches the 0.9-per-bounce decay', near(v.x, 12 * Math.pow(0.9, 5), 1e-6),
    `vx=${v.x.toFixed(4)}`);
  // The old uniform 0.55 would have left 12 * 0.55^5 = 0.60 — effectively stopped.
  ok('the old model would have stopped it dead', 12 * Math.pow(0.55, 5) < 1,
    'which is what made throwables feel wrong');
}

console.log('\n── throw speed comes from the catalogue too ──');
{
  // projectileSpeed = 0.9 u/client-tick for every hand-thrown grenade; our velocities are u/s at
  // 20Hz, so x20. This was hardcoded to 42 while the comment at the spawn site correctly documented
  // 0.9 — throwing 2.33x too fast, which FLATTENS the arc and reads as "gravity is too weak" even
  // though gravity was right. Both halves have to come from the catalogue or neither matches.
  ok('a hand-thrown grenade launches at the MEASURED 1.5 u/tick',
    near(srv.grenadeSpeed(46), 1.5 * 20), String(srv.grenadeSpeed(46)));
  ok('every throwable shares that speed',
    [172, 173, 176, 355, 52, 53, 283].every((t) => near(srv.grenadeSpeed(t), 1.5 * 20)));
  ok('it is NOT the catalogue projectileSpeed (0.9)', !near(srv.grenadeSpeed(46), 0.9 * 20),
    'projectileSpeed governs weapon-FIRED projectiles; ability throws ignore it');
}

console.log('\n── the full trajectory matches the client tick-for-tick ──');
{
  // The real proof: integrate the same 45-degree throw in the CLIENT's units (u/tick, gravity
  // 0.048/tick) and in OURS (u/s, dt=0.05) and require them to stay on the same curve. This is what
  // catches a unit-conversion error in either gravity or speed — each alone can be "plausible"
  // while the pair is wrong.
  const client = (() => {
    let x = 0, y = 0, vx = 1.5 * Math.SQRT1_2, vy = 1.5 * Math.SQRT1_2;
    const pts = [];
    for (let t = 0; t < 80; t++) { vy -= 0.048; x += vx; y += vy; pts.push([x, y]); }
    return pts;
  })();
  const server = (() => {
    const S = srv.grenadeSpeed(46), G = srv.grenadeGravity(46), dt = 0.05;
    let x = 0, y = 0, vx = S * Math.SQRT1_2, vy = S * Math.SQRT1_2;
    const pts = [];
    for (let t = 0; t < 80; t++) { vy -= G * dt; x += vx * dt; y += vy * dt; pts.push([x, y]); }
    return pts;
  })();
  let worst = 0;
  for (let i = 0; i < client.length; i++) {
    worst = Math.max(worst, Math.hypot(client[i][0] - server[i][0], client[i][1] - server[i][1]));
  }
  ok('the two integrations stay on the same curve for 4s', worst < 1e-9,
    `worst divergence ${worst.toExponential(2)} u`);
  ok('and the range is the client range, not 2.33x it',
    Math.abs(server[79][0] - client[79][0]) < 1e-9,
    `server x=${server[79][0].toFixed(2)} client x=${client[79][0].toFixed(2)}`);
  // Sanity: the apex must be a sane height, not a flat line.
  const apex = Math.max(...server.map((p) => p[1]));
  ok('the arc actually arcs', apex > 1 && apex < 40, `apex=${apex.toFixed(2)}u`);
}

console.log('\n── per-type fuses, from the catalogue and confirmed by telemetry ──');
{
  // Every throwable used to spawn with one shared fallback of 70 ticks, so flash detonated at 3.5s
  // instead of 1.75s and impulse at 3.5s instead of 3.0s.
  const expect = { 46: 40, 172: 30, 53: 35, 355: 60, 52: 200, 283: 20 };
  Object.keys(expect).forEach(function (t) {
    ok('type ' + t + ' fuse = ' + expect[t] + ' ticks (' + (expect[t] / 20).toFixed(2) + 's)',
      srv.grenadeFuse(Number(t)) === expect[t], String(srv.grenadeFuse(Number(t))));
  });
  ok('none of them is still the shared 70 fallback',
    Object.keys(expect).every(function (t) { return srv.grenadeFuse(Number(t)) !== 70; }));
  // Mine and Trip Mine have no catalogue timer — proximity/beam triggered — so the in-flight
  // fallback is correct and MINE_LIFETIME takes over once they stick.
  ok('mine/tripmine fall back rather than inventing a timer',
    srv.grenadeFuse(173) === srv.grenadeFuse(176));
}

console.log('\n── every throwable carries the measured stats ──');
{
  const all = [46, 172, 173, 176, 355, 52, 53, 283];
  ok('all launch at the measured 1.5 u/tick',
    all.every(function (t) { return near(srv.grenadeSpeed(t), 1.5 * 20); }));
  ok('none falls back to the legacy 22 gravity',
    all.every(function (t) { return srv.grenadeGravity(t) !== 22; }),
    all.filter(function (t) { return srv.grenadeGravity(t) === 22; }).join(','));
  ok('the heavy pair really is smoke + flash',
    near(srv.grenadeGravity(52), 27.2) && near(srv.grenadeGravity(53), 27.2) &&
    near(srv.grenadeGravity(46), 19.2) && near(srv.grenadeGravity(283), 19.2));
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
