/**
 * test_melee_parity.js — melee must behave exactly as the client predicts it.
 *
 * The hit GEOMETRY is parity by construction: phys.meleeHit calls the client's own extracted
 * Qex8ya5 (a 0.75-radius sphere started at eye + 0.75·dir and swept 2.5u along the aim), so there is
 * no second implementation to drift. What can still diverge is everything around it — the swing
 * cadence, the recoil kick, whether a swing consumes ammo or spawns a tracer, and the damage.
 *
 * Sword (nid 262) from the catalogue: dmg 50, cooldown 16, knockback 2, melee true, clipSize 999999.
 * It defines NO knockbackMax, so the client's default of 2 applies (`typeof n.knockbackMax ==
 * 'number' ? n.knockbackMax : 2`) — a detail worth pinning, because assuming the wrong default is
 * exactly what produced a phantom recoil divergence during the gun work.
 *
 * Usage:  node scripts/test_melee_parity.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const S = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const f = (held) => [1.0, [held, [], [], [0, 0], null, null]];
const SWORD = 262;

// The sword's real values, read from the catalogue rather than assumed.
const KB = srv.WEAPON_KNOCKBACK[SWORD];
const COOLDOWN = srv.weaponCooldownTicks(SWORD);

// ── the client, transcribed (Qmgh2i6 :34614, l() :34627) ────────────────────
function clientArm(s) {
  if (s.Qezh4wz !== 0) return;
  s.Qq1azjr = 20 * (s.Qm2pxgr || 0);
  s.Qq1azd5 = s.Qq1azjr + 0.5 * (KB.knockbackMax - s.Qq1azjr) * KB.knockback;
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
  if (firing) { s.Qezh4wz = 0; clientArm(s); }
}

(async () => {
  await bpw.ready;
  const sp = bpw.spawnPoints[0];
  const mk = () => {
    const p = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 'p');
    p.equippedWeaponId = SWORD; p._ammoGunId = SWORD; p.weaponList = [SWORD];
    return p;
  };
  const drive = (p, frames, t) => {
    srv.preTickFire(p, frames);
    srv.integratePlayerSim(p, 0.05, t, frames);
  };

  console.log('\n── the sword uses its catalogue stats, not gun defaults ──');
  {
    ok('melee flag is set', !!srv.WEAPON_MELEE[SWORD]);
    ok('cooldown is 16 ticks', COOLDOWN === 16, String(COOLDOWN));
    ok('knockback 2', KB.knockback === 2, String(KB.knockback));
    ok('knockbackMax defaults to 2 (the catalogue omits it)', KB.knockbackMax === 2,
      `${KB.knockbackMax} — the client uses 2 when the field is absent`);
    ok('damage is 50', srv.WEAPON_DMG[SWORD] === 50, String(srv.WEAPON_DMG[SWORD]));
  }

  console.log('\n── swing cadence matches the cooldown ──');
  {
    const p = mk(), swings = [];
    for (let t = 1; t <= 40; t++) { drive(p, [f([5])], t); if (p._firingThisTick) swings.push(t); }
    ok('first swing lands on tick 1', swings[0] === 1, swings.join(','));
    ok('and repeats every 16 ticks', swings.slice(0, 3).join(',') === '1,17,33', swings.join(','));
  }

  console.log('\n── the recoil kick matches the client exactly ──');
  {
    // The sword DOES kick the camera: Qmgh2i6 is not melee-gated, and knockback 2 with the default
    // knockbackMax 2 gives a full-strength arm. It is only tolerable because the 16-tick cooldown
    // outlasts the 9-tick curve, so it fully decays between swings.
    const p = mk();
    const c = { Qcrzrpr: 0, Qd0yy90: 0, Qezh4wz: 9999, Qm2pxgr: 0, Qq1azjr: 0, Qq1azd5: 0 };
    let worst = 0, sFire = [], cFire = [];
    for (let t = 1; t <= 40; t++) {
      drive(p, [f([5])], t);
      const cf = (c.Qezh4wz + 1 >= COOLDOWN);
      clientTick(c, cf);
      if (p._firingThisTick) sFire.push(t);
      if (cf) cFire.push(t);
      worst = Math.max(worst, Math.abs((p.pitch || 0) - c.Qcrzrpr));
    }
    ok('server and client swing on the same ticks', sFire.join(',') === cFire.join(','),
      `server ${sFire.slice(0, 4)} vs client ${cFire.slice(0, 4)}`);
    ok('pitch matches within the comparator tolerance', worst < 1e-4,
      `worst ${worst.toExponential(3)} rad over 40 ticks`);
    ok('and it is exact', worst === 0, worst.toExponential(3));
  }

  console.log('\n── the kick fully decays before the next swing ──');
  {
    const p = mk();
    let peak = 0, atNext = 0;
    for (let t = 1; t <= 16; t++) {
      drive(p, [f([5])], t);
      const off = Math.abs(p._ps.Qm2pxgr || 0);
      if (off > peak) peak = off;
      if (t === 16) atNext = off;
    }
    ok('the swing produces a real kick', peak > 0.01, peak.toExponential(2));
    ok('and it is back to zero by the next swing', atNext === 0,
      `${atNext} — the 9-tick curve must finish inside the 16-tick cooldown`);
  }

  console.log('\n── a swing is not a gunshot ──');
  {
    const p = mk();
    const ammoBefore = p.gunAmmo;
    drive(p, [f([5])], 1);
    ok('melee does not consume magazine ammo', p.gunAmmo === ammoBefore,
      `${ammoBefore} -> ${p.gunAmmo}`);
    ok('and never starts a reload', (p.reloadTicks || 0) === 0, String(p.reloadTicks));
  }

  console.log('\n── melee never headshots ──');
  {
    // Qwsv9a9 = 1 in Qex8ya5 — the client applies no head multiplier to a swing, so neither may we.
    const world = bpw.world;
    const hit = srv.WEAPON_MELEE[SWORD]
      ? require('../physics_extracted').meleeHit(world, sp.x, sp.y + 1, sp.z, 1, 0, 0, 'nobody')
      : null;
    ok('a swing into empty space misses cleanly', hit === null || hit.headshot === false,
      JSON.stringify(hit));
  }

  console.log('\n── meleeForgivenessMargin: a deliberate, OFF-by-default parity deviation ──');
  {
    // Requested live ("client shows a hit, server says miss") after confirming the real cause is
    // NOT a bug: the exact client swing ray already reaches the server (rayDebug confirmed ray=YES
    // on every real swing) and lag-comp is already active — the true official reach is just tight.
    // This finds the actual miss boundary empirically (rather than hand-deriving the swept-sphere
    // geometry) and checks the margin can turn a just-past-reach miss into a hit, and confirms 0
    // (the default) changes nothing.
    // yaw 0's forward is -Z (phys.aimDirection(0,0) = {x:0,y:0,z:-1} — confirmed empirically, not
    // assumed), so the victim is placed along -Z from the shooter, not +X.
    //
    // Positioned well away from the real spawn point (500,500,500 — same convention
    // test_weapon_pickups.js uses), not at sp.x/y/z: this file's earlier blocks (mk()) leave their
    // 'p' player objects registered in the world at the real spawn point, and the sweep found and
    // hit THAT leftover capsule instead of the intended victim, silently, every single time —
    // "a swing found SOMETHING nearer" rather than a real reach-boundary result.
    const ox = 500, oy = 500, oz = 500;
    const shooter = srv.createPlayerSimState({ x: ox, y: oy, z: oz, yaw: 0 }, 'forgiveA');
    shooter.equippedWeaponId = SWORD; shooter._ammoGunId = SWORD; shooter.weaponList = [SWORD];
    const victim = srv.createPlayerSimState({ x: ox, y: oy, z: oz - 0.5, yaw: 0 }, 'forgiveB');
    victim._ps.Qalaptp = 0;   // clear spawn protection — a fresh state's default silently ate every hit
    const sessions = new Map([
      ['sA', { accepted: true, sessionId: 'sA', playerState: shooter }],
      ['sB', { accepted: true, sessionId: 'sB', playerState: victim }],
    ]);
    // Move the SAME registered victim rather than re-creating one per distance (re-creating under
    // the same id left a stale capsule behind and every check missed, point-blank included).
    const placeVictimAt = (dist) => {
      victim.position.x = ox; victim.position.y = oy; victim.position.z = oz - dist;
      victim._ps.Qdsukt4.x = ox; victim._ps.Qdsukt4.y = oy; victim._ps.Qdsukt4.z = oz - dist;
      srv._syncPhysWorldCapsules(shooter._ps.Q7q6byi);
    };
    // fireMelee has no return value (its normal caller only needs the side effect), so a hit is
    // observed the same way the real game would confirm one: the victim's HP actually drops.
    const swingHits = (dist) => {
      placeVictimAt(dist);
      victim.healthPoints = 1;
      srv.fireMelee(shooter, sessions, null);   // null clientRay -> server-reconstructed aim (yaw 0 = -Z)
      return victim.healthPoints < 1;
    };

    ok('at true point-blank range (0.5u) the swing hits with the default (0 margin)', swingHits(0.5));

    // Step outward from a known hit until it becomes a miss — the boundary itself, empirically.
    let missDist = null;
    for (let d = 1; d <= 6; d += 0.25) {
      if (!swingHits(d)) { missDist = d; break; }
    }
    ok('found a distance just past the real reach where the default (0 margin) misses',
      missDist !== null, `no miss found up to 6u`);

    if (missDist !== null) {
      ok('margin=0 (the default) really does miss at that distance — precondition for the next check',
        !swingHits(missDist));
      S.set('meleeForgivenessMargin', 1, 'test');
      ok('with a real margin set, that SAME swing now hits',
        swingHits(missDist), `distance=${missDist}`);
      S.set('meleeForgivenessMargin', 0, 'test');
      ok('back at margin=0, it misses again (nothing left over from the retry)',
        !swingHits(missDist));
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
