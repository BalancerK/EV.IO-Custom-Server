/**
 * test_shot_compare.js — the server's copies of the client's shot randomness match the client.
 *
 * The client's single-ray spread is not random: it is randOnDisc(String(10 * fireTick)), a hash of
 * the tick, scaled by getSpread(ticksSinceLastShot, ticksSinceLastMove, grounded, zooming). The
 * server can only build the same ray as the client (anticheat step 2) if its copies give the SAME
 * numbers. The reference functions below are copied verbatim from the 1-7-1 bundle (module Fd and
 * fb.getSpread, weapon fields already number-converted like the client's fixStringifiedValuesInDict).
 *
 * Usage:  node scripts/test_shot_compare.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

// ── 1-7-1 bundle, verbatim ─────────────────────────────────────────────────────────────────
const ref = {};
ref.hashString = function (e) { for (var t = 4022871197, a = 0; a < e.length; a++) { var n = .02519603282416938 * (t += e.charCodeAt(a)); n -= t = n >>> 0, t = (n *= t) >>> 0, t += 4294967296 * (n -= t) } return 2.3283064365386963e-10 * (t >>> 0) };
ref.randOnDisc = function (e, a) { var n = ref.hashString(e), i = ref.hashString('0' + e), r = ref.hashString('1' + e), o = 2 * Math.PI * n, s = i + r, l = s > 1 ? 2 - s : s; return a.x = l * Math.cos(o), a.y = l * Math.sin(o), a };
ref.getSpread = function (e, t, a, n) { var i = 0, r = void 0 !== n ? n.tier : 0; if ('number' == typeof t.spreadMax && t.spreadMax > 0) { var o = a.zooming && 'number' == typeof t.zoomSpreadMod ? t.zoomSpreadMod : 1; i = ('number' == typeof t.spreadMin ? t.spreadMin : 1) * o; var s, l = a.ticksSinceLastMove * e; (s = a.ticksSinceLastShot * e) <= 10 && (i = Math.max(i, o * t.spreadMax * (9 - s) / 10)), l >= 1 && (i = Math.max(i, Math.min(1.33 * o, 1) * t.spreadMax * .7 * (9 - l) / 10)), a.grounded || a.zooming || (i = Math.max(1.5 * t.spreadMax * Math.min(1.66 * o, 1), .05)), i = Math.max(i, 'number' == typeof t.spreadMinZoom ? t.spreadMinZoom : 1) } return i };
if (require.main === module && process.argv[2] === '--print-ref') { console.log(ref.hashString.toString()); process.exit(0); }

// Weapon data as the client sees it (from weapons.json, numbers converted).
const weapons = require('../weapons.json');
const wdata = {};
for (const it of weapons.data) {
  let d = null; try { d = JSON.parse(it.attributes.field_weapon_data); } catch (e) { continue; }
  for (const k of Object.keys(d)) if (typeof d[k] === 'string' && d[k] !== '' && !isNaN(d[k])) d[k] = parseFloat(d[k]);
  wdata[it.attributes.drupal_internal__nid] = d;
}

console.log('\n── hashString / randOnDisc ──');
{
  let worst = 0, worstDisc = 0;
  for (let tick = 0; tick < 20000; tick += 7) {
    const seed = String(10 * tick);
    worst = Math.max(worst, Math.abs(srv.clientHashString(seed) - ref.hashString(seed)));
    const a = srv.clientRandOnDisc(seed), b = ref.randOnDisc(seed, {});
    worstDisc = Math.max(worstDisc, Math.abs(a.x - b.x), Math.abs(a.y - b.y));
  }
  ok('hashString matches the client exactly over 2,858 fire ticks', worst === 0, `worst ${worst}`);
  ok('randOnDisc matches the client exactly', worstDisc === 0, `worst ${worstDisc}`);
}

console.log('\n── getSpread, every weapon with spread, every state ──');
{
  let checked = 0, worst = 0, where = '';
  for (const nid of Object.keys(wdata)) {
    if (!(wdata[nid].spreadMax > 0)) continue;
    for (const tsls of [0, 1, 2, 5, 9, 10, 11, 30]) for (const tslm of [0, 1, 3, 9, 20])
      for (const grounded of [true, false]) for (const zooming of [true, false]) {
        const mine = srv.clientGetSpread(Number(nid), { tsls, tslm, grounded, zooming });
        const theirs = ref.getSpread(1, wdata[nid], { ticksSinceLastShot: tsls, ticksSinceLastMove: tslm, grounded, zooming });
        const d = Math.abs(mine - theirs);
        if (d > worst) { worst = d; where = `wpn ${nid} tsls=${tsls} tslm=${tslm} g=${grounded} z=${zooming}: ${mine} vs ${theirs}`; }
        checked++;
      }
  }
  ok(`getSpread matches the client in all ${checked} cases`, worst === 0, where);
}

console.log('\n── a whole shot direction ──');
{
  // Auto Rifle (4), a shot right after another one while running: spread > 0.
  const st = { tsls: 2, tslm: 0, grounded: true, zooming: false };
  const tick = 12345, yaw = 0.7, pitch = -0.2;
  const u = ref.getSpread(1, wdata[4], { ticksSinceLastShot: 2, ticksSinceLastMove: 0, grounded: true, zooming: false });
  const c = ref.randOnDisc(String(10 * tick), {});
  const v = { x: u * c.x, y: u * c.y, z: -1 }; const l = Math.hypot(v.x, v.y, v.z);
  // three.js rotateVectorByYawPitch = Euler(pitch, yaw, 0, 'YXZ') = Ry(yaw)·Rx(pitch)
  const x = v.x / l, y = v.y / l, z = v.z / l;
  const y1 = y * Math.cos(pitch) - z * Math.sin(pitch), z1 = y * Math.sin(pitch) + z * Math.cos(pitch);
  const want = { x: x * Math.cos(yaw) + z1 * Math.sin(yaw), y: y1, z: -x * Math.sin(yaw) + z1 * Math.cos(yaw) };
  const got = srv.clientShotDir(4, st, tick, yaw, pitch);
  const err = Math.max(Math.abs(got.x - want.x), Math.abs(got.y - want.y), Math.abs(got.z - want.z));
  ok(`spread is applied (u = ${u.toFixed(4)})`, u > 0);
  ok('the shot direction matches the client formula', err < 1e-12, `err ${err}`);
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
