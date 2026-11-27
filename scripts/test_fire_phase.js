/**
 * test_fire_phase.js — the fire gate reads THIS tick's input, not last tick's.
 *
 * THE BUG
 * ───────
 * The per-tick drain runs
 *
 *     preTickFire(playerState, batch.frames);      // decides the shot
 *     integratePlayerSim(playerState, ..., batch.frames);
 *
 * but preTickFire gated on `playerState.heldActions`, and heldActions is assigned *inside*
 * integratePlayerSim. So the gate saw the PREVIOUS tick's keys while the frames for the current tick
 * sat unread in its own argument.
 *
 * The client merges a tick's sub-frames and fires on that same tick, so its recoil curve ran one tick
 * ahead of ours: holding fire, the server kicked on ticks 2,4,6,8 where the client kicked on 1,3,5,7.
 *
 * A one-tick phase shift is not a small error. The curve moves ~2.5e-3 rad per tick, so pitch was off
 * by that much EVERY tick — 25x the reconciler's 1e-4 tolerance — for as long as the trigger was held,
 * with or without movement keys. That is the "camera stutters while shooting, and keeps stuttering
 * until I release fire" report. Recoil itself was never wrong: driven with matching fire ticks the two
 * implementations agree to 0.0e+0.
 *
 * Zoom (6) and reload (30) read the same set and were equally stale.
 *
 * Usage:  node scripts/test_fire_phase.js
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
const f = (held) => [1.0, [held, [], [], [0, 0], null, null]];

// Weapon 4 (Auto Rifle), straight from the catalogue. Hardcoding the 1/2 defaults here is what made
// an earlier version of this diagnostic "find" a 3e-2 divergence that did not exist.
const KNOCKBACK = 0.75, KNOCKBACK_MAX = 1.5, COOLDOWN = 2;

// ── the client, transcribed (Qwhlcfo :34525, l() :34627, Qmgh2i6 :34614) ─────
function clientArm(s) {
  if (s.Qezh4wz !== 0) return;
  s.Qq1azjr = 20 * (s.Qm2pxgr || 0);
  s.Qq1azd5 = s.Qq1azjr + 0.5 * (KNOCKBACK_MAX - s.Qq1azjr) * KNOCKBACK;
  if (s.Qq1azjr > s.Qq1azd5) s.Qq1azjr = s.Qq1azd5;
}
function clientTick(s, firing) {
  s.Qezh4wz = Number.isFinite(s.Qezh4wz) ? s.Qezh4wz + 1 : 9999;
  s.Qcrzrpr += s.Qd0yy90; s.Qd0yy90 = 0;
  let n = 0;
  const i = s.Qezh4wz;
  if (i <= 9) {
    n = -Math.pow(i - 1, 2) * (s.Qq1azd5 - s.Qq1azjr) + s.Qq1azd5;
    if (i >= 1) n = (Math.cos(1.2 * (i - 1) / Math.PI) + 1) * (0.5 * s.Qq1azd5);
    n *= 0.05;
  }
  if (n === 0) { s.Qq1azd5 = 0; s.Qq1azjr = 0; }
  s.Qd0yy90 += n - s.Qm2pxgr; s.Qm2pxgr = n;
  if (firing) { s.Qezh4wz = 0; clientArm(s); }   // the shot arms AFTER the curve has run
}

(async () => {
  await bpw.ready;
  const sp = bpw.spawnPoints[0];
  const mk = () => {
    const p = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 'p');
    p.equippedWeaponId = 4; p.gunAmmo = 999; p._ammoGunId = 4;
    return p;
  };
  // The REAL drain order from local_ws_server.js (~3053) — deliberately no manual
  // foldClientInputIntoSim, which is the receive path and would mask the staleness.
  const drive = (p, frames, t) => {
    srv.preTickFire(p, frames);
    srv.integratePlayerSim(p, 0.05, t, frames);
  };

  console.log('\n── fire lands on the tick the key is held ──');
  {
    const p = mk(), fired = [];
    for (let t = 1; t <= 10; t++) { drive(p, [f([5])], t); if (p._firingThisTick) fired.push(t); }
    ok('the first shot is on tick 1, not tick 2', fired[0] === 1,
      `fired on ${fired.join(',')} — starting at 2 means the gate read last tick's keys`);
    ok('and the cadence is every 2 ticks (cooldown 2)',
      fired.slice(0, 5).join(',') === '1,3,5,7,9', fired.join(','));
  }

  console.log('\n── the recoil curve stays in phase with the client ──');
  {
    const p = mk();
    const c = { Qcrzrpr: 0, Qd0yy90: 0, Qezh4wz: 9999, Qm2pxgr: 0, Qq1azjr: 0, Qq1azd5: 0 };
    let worst = 0, sFire = [], cFire = [];
    for (let t = 1; t <= 30; t++) {
      drive(p, [f([5])], t);
      const cf = (c.Qezh4wz + 1 >= COOLDOWN);          // the client's own gate
      clientTick(c, cf);
      if (p._firingThisTick) sFire.push(t);
      if (cf) cFire.push(t);
      worst = Math.max(worst, Math.abs((p.pitch || 0) - c.Qcrzrpr));
    }
    ok('server and client fire on the same ticks', sFire.join(',') === cFire.join(','),
      `server ${sFire.slice(0, 6)} vs client ${cFire.slice(0, 6)}`);
    ok('pitch matches within the 1e-4 comparator tolerance', worst < 1e-4,
      `worst ${worst.toExponential(3)} rad over 30 ticks of sustained fire`);
    ok('and it is exact, not merely inside tolerance', worst === 0, worst.toExponential(3));
  }

  console.log('\n── a key present only in an early sub-frame still fires ──');
  {
    // The gate unions the tick's sub-frames, matching the client's merge. Reading just the final
    // sub-frame loses shots while moving, when the client sends several frames per tick.
    const p = mk();
    drive(p, [f([0, 5]), f([0])], 1);
    ok('fire held in sub-frame 1 but not the last one still shoots', p._firingThisTick === true);
  }

  console.log('\n── a real client fires only on its fire pulse (18), not on every ready tick ──');
  {
    // The client's input reader adds 18 on a FRAME-time timer, so a held Auto Rifle (cooldown 2)
    // pulses every 2 ticks with an occasional 3. 5 is held throughout. Official fires on exactly the
    // ticks carrying 18; firing on 5 + cooldown took the extra shot on tick 5 here.
    const p = mk();
    const pulseTicks = [1, 3, 6, 8, 10, 13, 15];
    const fired = [];
    for (let t = 1; t <= 16; t++) {
      drive(p, [f(pulseTicks.includes(t) ? [5, 18] : [5])], t);
      if (p._firingThisTick) fired.push(t);
    }
    ok(`fires on exactly the pulse ticks (${fired.join(',')})`, fired.join(',') === pulseTicks.join(','),
      `expected ${pulseTicks.join(',')}`);
    const bot = mk(), botFired = [];
    for (let t = 1; t <= 6; t++) { drive(bot, [f([5])], t); if (bot._firingThisTick) botFired.push(t); }
    ok(`a bot (5 only, never 18) still fires on the cooldown (${botFired.join(',')})`, botFired.join(',') === '1,3,5');
  }

  console.log('\n── a reload starts on the tick the magazine empties, like the client ──');
  {
    // The client's weapon tick is applyFiredWeaponStateChange THEN handleReloading: the shot that
    // empties the mag starts the reload on that same tick, and the refill lands when the countdown
    // reaches 0, after that tick's fire gate. Running the reload before the shot put both ends a tick
    // late — and zoom (which reads the reload timer) with them.
    const p = mk();
    p.gunAmmo = 1;
    const pulse = (t) => drive(p, [f([5, 18])], t);
    pulse(1);
    ok('the last round fires', p._firingThisTick === true);
    ok('the reload starts on that same tick', p.reloadTicks > 0 && p.gunAmmo === 0, `reloadTicks ${p.reloadTicks}`);
    const R = p.reloadTicks;
    let refillTick = null, firedOnRefill = false, firstShotAfter = null;
    for (let t = 2; t <= R + 4; t++) {
      pulse(t);
      if (refillTick === null && p.gunAmmo > 0) { refillTick = t; firedOnRefill = p._firingThisTick; }
      else if (refillTick !== null && firstShotAfter === null && p._firingThisTick) firstShotAfter = t;
    }
    ok(`the magazine refills ${R} ticks after the reload started (tick ${1 + R})`, refillTick === 1 + R, `refilled on ${refillTick}`);
    ok('no shot on the refill tick (the fire gate saw an empty magazine)', firedOnRefill === false);
    ok('firing resumes on the next tick', firstShotAfter === refillTick + 1, `first shot ${firstShotAfter}`);
  }

  console.log('\n── recoil is armed on the firing tick, with that tick\'s zoom ──');
  {
    // Aimed shot (zoom held) on tick 1, zoom released on tick 2. The client arms on the shot's own
    // tick, so the kick uses the ADS factor 0.6; arming at the start of tick 2 used tick 2's zoom (off).
    const p = mk();
    drive(p, [f([6])], 1);                       // aim first, so the zoom is up when the shot fires
    drive(p, [f([5, 6, 18])], 2);
    const armedMax = p._ps.Qq1azd5;
    ok('the recoil magnitudes are armed on the firing tick itself', armedMax > 0, String(armedMax));
    const want = 0.5 * KNOCKBACK_MAX * KNOCKBACK * 0.6;   // jr = 0 for a first shot
    ok('with the ADS factor of the tick it fired on', Math.abs(armedMax - want) < 1e-9, `${armedMax} vs ${want}`);
    drive(p, [f([])], 3);                        // zoom released
    ok('and releasing zoom afterwards does not change it', Math.abs(p._ps.Qq1azd5 - want) < 1e-9, String(p._ps.Qq1azd5));
  }

  console.log('\n── releasing fire stops it on the same tick ──');
  {
    const p = mk();
    drive(p, [f([5])], 1);
    ok('firing while held', p._firingThisTick === true);
    for (let t = 2; t <= 5; t++) drive(p, [f([])], t);
    ok('not firing after release', p._firingThisTick === false,
      'a stale read would keep shooting a tick past the release');
  }

  console.log('\n── zoom and reload read the same current-tick set ──');
  {
    const p = mk();
    drive(p, [f([6])], 1);
    ok('zoom engages on the tick the key is held', p._ps.Qgk2mcg === true);
    const q = mk();
    q.gunAmmo = 1;
    drive(q, [f([30])], 1);
    ok('reload starts on the tick the key is held', q.reloadTicks > 0, String(q.reloadTicks));
  }

  console.log('\n── no frames (the hybrid no-drain path) falls back to heldActions ──');
  {
    const p = mk();
    p.heldActions = new Set([5]);
    srv.preTickFire(p);                 // called without frames, as at ~2641
    ok('still fires from heldActions', p._firingThisTick === true,
      'the fallback keeps the non-buffered mode working');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
