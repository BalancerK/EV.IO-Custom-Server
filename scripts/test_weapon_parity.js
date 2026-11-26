/**
 * test_weapon_parity.js — Shotgun aim + hit ids, Burst Rifle fire cadence, projectiles through
 * portals. Each checked against the official client (1-7-1 bundle), transcribed below.
 *
 *   SHOTGUN  The userscript/extension send one "#SHOT#" ray PER PELLET, and the one the server takes
 *            is pellet 0, half a spread radius right of the crosshair. The ring used to be built
 *            around that ray, shifting every blast ~2.9 deg. Every pellet's hit also carried pellet
 *            0's sid, so the hits collided on one playerMap key.
 *   BURST    canPlayerFire's burst exception (:54596) and the burst-window reset (:54611) were never
 *            implemented, and the server ignored action 18 (the client's "fire now" sample, which is
 *            all a burst sends once the button is released).
 *   PORTALS  ProjectileState.tick (:54495) teleports projectiles; the server never did.
 *
 * Usage:  node scripts/test_weapon_parity.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_CLICK_TO_PLAY = process.env.EVIO_CLICK_TO_PLAY || '0';

const THREE = require('three');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const tp = require('../map_teleporters');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const angle = (a, b) => {
  const la = Math.hypot(a.x, a.y, a.z), lb = Math.hypot(b.x, b.y, b.z);
  return Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y + a.z * b.z) / (la * lb))));
};

// ── the client, transcribed ───────────────────────────────────────────────────────────────────
// fb's pellet builder `n` (bundle :54700-54722) + rotateVectorByYawPitch (:41088, Euler YXZ).
function clientPellets(count, spread, yaw, pitch) {
  const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ'));
  const h = Math.ceil(count / 2), out = [];
  for (const s of [0.5, 1]) {
    for (let f = 0; f < h; f++) {
      const g = f / h * Math.PI * 2;
      out.push(new THREE.Vector3(Math.cos(g) * spread * s, Math.sin(g) * spread * s, -1).normalize().applyQuaternion(q));
    }
  }
  return out;
}
const fwdOf = (yaw, pitch) => new THREE.Vector3(0, 0, -1).applyQuaternion(
  new THREE.Quaternion().setFromEuler(new THREE.Euler(pitch, yaw, 0, 'YXZ')));
// The client sends rays rounded to 3 dp (__EVIO_SHOTRAY__ / __EVIO_EXT_SHOTRAY__).
const r3 = (n) => Math.round(n * 1000) / 1000;
const asRay = (v, sid) => ({ ox: 0, oy: 300, oz: 0, dx: r3(v.x), dy: r3(v.y), dz: r3(v.z), sid, t: Date.now() });

// canPlayerFire + applyFiredWeaponStateChange + tickPlayerStateCounters for a burst weapon,
// timeScale 1. Returns the ticks that fire for a given per-tick "fire requested" pattern.
function clientBurstTicks(requested, cooldown, burstCd, burstQty) {
  let tsls = 9999, tslb = 9999;
  const fired = [];
  requested.forEach((req, t) => {
    const burstOk = tsls + 1 >= burstCd && tslb + 1 < burstCd * burstQty;
    const can = req && (tsls + 1 >= cooldown || burstOk);
    tsls++; tslb++;
    if (can) { fired.push(t); tsls = 0; if (tslb > burstCd * burstQty) tslb = 0; }
  });
  return fired;
}

function mkPlayer(id, x, y, z, overrides = {}) {
  const ps = srv.createPlayerSimState({ x, y, z, yaw: 0 }, id);
  Object.assign(ps, overrides);
  return ps;
}
function mkSession(id, ps) { return { playerId: id, sessionId: id, accepted: true, isBot: false, playerState: ps }; }

(async () => {
  await bpw.ready;
  const SG = 7, SPREAD = 0.1, SPREAD_ADS = 0.05;

  console.log('\n── shotgun: server pellet ring == client pellet ring, pellet by pellet ──');
  {
    let worst = 0;
    for (const [yaw, pitch] of [[0, 0], [1.1, 0.3], [-2.4, -0.6], [3.0, 1.2], [0.4, -1.3]]) {
      for (const zoom of [false, true]) {
        const c = clientPellets(12, zoom ? SPREAD_ADS : SPREAD, yaw, pitch);
        const s = srv.pelletDirections(SG, fwdOf(yaw, pitch), 12, zoom);
        for (let i = 0; i < 12; i++) worst = Math.max(worst, angle(c[i], s[i]));
      }
    }
    ok('every pellet index points the same way as the client\'s (same order, up axis not mirrored)',
      worst < 1e-6, `worst ${worst.toExponential(2)} rad (acos floor is ~1e-8)`);
  }

  console.log('\n── shotgun: real aim recovered from the client\'s pellet rays ──');
  {
    const cases = [[0, 0], [1.1, 0.3], [-2.4, -0.6], [0.4, -1.3]];
    let worstFull = 0, worstOne = 0, worstFive = 0, worstOld = 0;
    for (const [yaw, pitch] of cases) {
      for (const zoom of [false, true]) {
        const pellets = clientPellets(12, zoom ? SPREAD_ADS : SPREAD, yaw, pitch);
        const aim = fwdOf(yaw, pitch);
        const suffix = 'shooterX:4242';
        const shooter = { _clientRays: pellets.slice(1).map((v, i) => asRay(v, `${i + 1}:${suffix}`)) };
        const first = asRay(pellets[0], `0:${suffix}`);
        const full = srv.shotgunAimFromClientRay(shooter, first, SG, 12, zoom);
        worstFull = Math.max(worstFull, angle(fwdOf(full.yaw, full.pitch), aim));
        const one = srv.shotgunAimFromClientRay({ _clientRays: [] }, first, SG, 12, zoom);
        worstOne = Math.max(worstOne, angle(fwdOf(one.yaw, one.pitch), aim));
        const five = srv.shotgunAimFromClientRay({ _clientRays: [] }, asRay(pellets[5], `5:${suffix}`), SG, 12, zoom);
        worstFive = Math.max(worstFive, angle(fwdOf(five.yaw, five.pitch), aim));
        // what the server used before: pellet 0's ray taken as the aim
        worstOld = Math.max(worstOld, angle(pellets[0], aim));
      }
    }
    ok('whole ring queued: aim recovered within rounding (< 2e-3 rad)', worstFull < 2e-3, `${worstFull.toExponential(2)} rad`);
    ok('only pellet 0 arrived: aim recovered within rounding', worstOne < 2e-3, `${worstOne.toExponential(2)} rad`);
    ok('only pellet 5 arrived: aim recovered within rounding', worstFive < 2e-3, `${worstFive.toExponential(2)} rad`);
    ok('the old behaviour (pellet 0 as the aim) really was off by ~half a spread radius',
      worstOld > 0.02, `${worstOld.toFixed(4)} rad`);
  }

  console.log('\n── shotgun: each pellet\'s hit carries its own client sid ──');
  {
    const shooter = mkPlayer('sgA', 0, 300, 0, { equippedWeaponId: SG, yaw: 0, pitch: 0 });
    const victim = mkPlayer('sgB', 0, 300, -4, { healthPoints: 1, armorPoints: 0, deathStateTimer: 0 });
    if (victim._ps) victim._ps.Qalaptp = -1;
    const sessions = new Map([['sgA', mkSession('sgA', shooter)], ['sgB', mkSession('sgB', victim)]]);
    const eye = srv.shooterEye(shooter);
    const pellets = clientPellets(12, SPREAD, 0, 0);
    const suffix = 'sgA:777';
    shooter._clientRays = pellets.map((v, i) => ({ ...asRay(v, `${i}:${suffix}`), ox: eye.x, oy: eye.y, oz: eye.z }));
    srv.buildPlayerMapBlock();   // (does not clear; just make sure it runs)
    const before = new Set();
    { const b = srv.buildPlayerMapBlock(); for (let i = 0; i < b.length; i++) if (b[i] === 67) before.add(b[i + 1]); }
    srv.fireWeapon(shooter, sessions);
    const keys = [];
    { const b = srv.buildPlayerMapBlock(); for (let i = 0; i < b.length; i++) if (b[i] === 67 && !before.has(b[i + 1])) keys.push(b[i + 1]); }
    ok('several pellets hit a target 4u ahead', keys.length > 1, `hits=${keys.length}`);
    ok('every hit id is distinct', new Set(keys).size === keys.length, keys.join(' '));
    ok('every hit id is "<pellet>:sgA:777"', keys.every((k) => /^\d+:sgA:777$/.test(String(k))), keys.join(' '));
    ok('the sibling pellet rays were consumed', (shooter._clientRays || []).length === 0,
      `left=${(shooter._clientRays || []).length}`);
  }

  console.log('\n── burst rifle: catalogue ──');
  const BR = 336;
  const burst = srv.weaponBurst(BR);
  ok('Burst Rifle (336) is a burst weapon: 3 shots, 2 ticks apart, cooldown 8',
    burst && burst.quantity === 3 && burst.cooldown === 2 && srv.weaponCooldownTicks(BR) === 8, JSON.stringify(burst));
  ok('Auto Rifle (4) is not', srv.weaponBurst(4) === null);

  // Drive the real per-tick path (preTickFire -> integratePlayerSim) and record which ticks fire.
  function serverTicks(pattern) {
    const sp = bpw.spawnPoints[0];
    const p = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 'br');
    p.equippedWeaponId = BR;
    if (p._ps) p._ps.Qslw9vf = BR;
    const fired = [];
    pattern.forEach((held, t) => {
      const frames = [[1.0, [held, [], [], [0, 0], null, null]]];
      srv.preTickFire(p, frames);
      if (p._firingThisTick) fired.push(t);
      srv.integratePlayerSim(p, 0.05, t, frames);
      p._firingThisTick = false;
    });
    return fired;
  }

  console.log('\n── burst rifle: held fire, server ticks == client ticks ──');
  {
    const N = 40;
    const client = clientBurstTicks(Array(N).fill(true), 8, 2, 3);
    const server = serverTicks(Array.from({ length: N }, () => [5, 18]));
    ok(`client fires 0,2,4,12,14,16,... (${client.join(',')})`, client.slice(0, 6).join(',') === '0,2,4,12,14,16');
    ok('server fires on exactly the same ticks', server.join(',') === client.join(','), `server=${server.join(',')}`);
  }

  console.log('\n── burst rifle: one click (button down for one tick) still fires the whole burst ──');
  {
    // The client keeps sending 18 on its auto-fire timer while ticksSinceLastBurst < 6, with no 5.
    const pattern = [[5, 18], [], [18], [], [18], [], [], [], [], [], [], [], [], [], []];
    const server = serverTicks(pattern);
    ok('three shots: 0, 2, 4', server.join(',') === '0,2,4', `server=${server.join(',')}`);
  }

  console.log('\n── burst rifle: a non-burst weapon is unchanged by the 18 path ──');
  {
    const sp = bpw.spawnPoints[0];
    const p = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 'ar');
    p.equippedWeaponId = 4;
    const fired = [];
    for (let t = 0; t < 12; t++) {
      const frames = [[1.0, [[5], [], [], [0, 0], null, null]]];
      srv.preTickFire(p, frames);
      if (p._firingThisTick) fired.push(t);
      srv.integratePlayerSim(p, 0.05, t, frames);
      p._firingThisTick = false;
    }
    ok('Auto Rifle held fire: every 2 ticks (cooldown 2)', fired.join(',') === '0,2,4,6,8,10', fired.join(','));
  }

  console.log('\n── projectiles through portals ──');
  {
    // Two pads facing each other's opposite way: A at the origin (rotation 0) sends to B at
    // (100, 5, 0) (rotation PI/2).
    const tele = {
      0: { Qdsukt4: { x: 0, y: 0, z: 0 }, Quwa9s1: 2, Qrmqlp: 0, Qcnqzx4: [1], Qrtt124: '' },
      1: { Qdsukt4: { x: 100, y: 5, z: 0 }, Quwa9s1: 2, Qrmqlp: Math.PI / 2, Qcnqzx4: [], Qrtt124: '' },
    };
    const used = [];
    const pos = { x: 0, y: 0, z: -1.5 }, vel = { x: 0, y: 0, z: 10 };
    const moved = tp.applyProjectileTeleporters({ x: 0, y: 0, z: -3 }, pos, vel, tele, 50, used);
    ok('crossing into the radius teleports', moved === true);
    ok('to the destination pad', pos.x === 100 && pos.y === 5 && pos.z === 0, JSON.stringify(pos));
    // client: vec.applyQuaternion(axis Y, k.rotation - M.rotation + PI) = rotate (0,0,10) by 3PI/2
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI / 2 + Math.PI);
    const want = new THREE.Vector3(0, 0, 10).applyQuaternion(q);
    ok('velocity re-based exactly like the client', Math.hypot(vel.x - want.x, vel.y - want.y, vel.z - want.z) < 1e-9,
      `got ${JSON.stringify(vel)} want ${JSON.stringify(want)}`);
    ok('portal VFX ticks stamped on both pads', used[0] === 50 && used[1] === 50);

    const p2 = { x: 0, y: 0, z: -1 }, v2 = { x: 0, y: 0, z: 10 };
    ok('already inside on the previous step: no teleport (fires on entry only)',
      tp.applyProjectileTeleporters({ x: 0, y: 0, z: -1.5 }, p2, v2, tele, 51, []) === false && p2.z === -1);
    const p3 = { x: 0, y: 0, z: -2.5 };
    ok('the radius has no +1 for projectiles (2.5u from a radius-2 pad stays put)',
      tp.applyProjectileTeleporters({ x: 0, y: 0, z: -4 }, p3, { x: 0, y: 0, z: 1 }, tele, 52, []) === false);
    const p4 = { x: 100, y: 5, z: -1 };
    ok('an exit-only pad (no destinations) never teleports',
      tp.applyProjectileTeleporters({ x: 100, y: 5, z: -4 }, p4, { x: 0, y: 0, z: 1 }, tele, 53, []) === false);
  }

  console.log('\n── stepEntity calls the portal step ──');
  {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    const body = src.slice(src.indexOf('function stepEntity('), src.indexOf('function buildActiveEntityBlock('));
    ok('teleport.applyProjectileTeleporters is called on free flight', /teleport\.applyProjectileTeleporters\(/.test(body));
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
