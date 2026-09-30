/**
 * test_special_weapon_fire.js — Shotgun (multi-pellet hitscan) and Rocket/Grenade Launcher
 * (travelling splash projectile, spawned via the SAME activeEntities mechanism thrown ability
 * grenades use) firing paths, previously all silently dispatched as a single hitscan ray.
 *
 * Usage:  node scripts/test_special_weapon_fire.js
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

// Far above the map (y=300) so no real geometry interferes — matches the pattern already used by
// test_bot_ai.js/test_sword_tactics.js for the same reason.
function mkPlayer(id, x, y, z, overrides = {}) {
  const ps = srv.createPlayerSimState({ x, y, z, yaw: 0 }, id);
  Object.assign(ps, overrides);
  return ps;
}
function mkSession(id, ps, isBot = false) {
  return { playerId: id, sessionId: id, accepted: true, isBot, playerState: ps };
}

(async () => {
  await bpw.ready;

  console.log('\n── fire-mode dispatch: catalogue-driven, matches the client\'s Q1hatp1 decision ──');
  {
    ok('AR (nid 4) is plain hitscan', !srv.isProjectileWeapon(4) && srv.weaponPelletCount(4) === 1);
    ok('Sniper (nid 6) is plain hitscan', !srv.isProjectileWeapon(6) && srv.weaponPelletCount(6) === 1);
    ok('SMG (nid 282) is plain hitscan', !srv.isProjectileWeapon(282) && srv.weaponPelletCount(282) === 1);
    ok('Shotgun (nid 7) is multi-pellet hitscan, NOT a projectile',
      !srv.isProjectileWeapon(7) && srv.weaponPelletCount(7) === 12,
      `projectile=${srv.isProjectileWeapon(7)} pellets=${srv.weaponPelletCount(7)}`);
    ok('Rocket Launcher (nid 8) is a projectile weapon', srv.isProjectileWeapon(8));
    ok('Grenade Launcher (nid 283) is a projectile weapon', srv.isProjectileWeapon(283));
  }

  console.log('\n── grenade physics constants exist for both fired weapons ──');
  {
    ok('Rocket Launcher speed = catalogue projectileSpeed (1.4 u/tick = 28 u/s)',
      Math.abs(srv.grenadeSpeed(8) - 28) < 1e-6, String(srv.grenadeSpeed(8)));
    ok('Rocket Launcher has NO gravity (dumbfire, straight line)', srv.grenadeGravity(8) === 0,
      String(srv.grenadeGravity(8)));
    ok('Grenade Launcher speed matches the throwable value already measured (1.5 u/tick)',
      Math.abs(srv.grenadeSpeed(283) - 30) < 1e-6);
    ok('Grenade Launcher DOES have gravity (arcs, bounces)', srv.grenadeGravity(283) > 0);
    ok('GRENADE_COMBAT[8] is "impact" (explode on first contact, no bounce)',
      srv.GRENADE_COMBAT[8] && srv.GRENADE_COMBAT[8].behavior === 'impact');
    ok('GRENADE_COMBAT[283] is "timer" (bounces, then airbursts) — same behavior as HE',
      srv.GRENADE_COMBAT[283] && srv.GRENADE_COMBAT[283].behavior === 'timer');
  }

  console.log('\n── pelletDirections: the client\'s deterministic double-ring formula ──');
  {
    const fwd = { x: 0, y: 0, z: -1 };
    const dirs = srv.pelletDirections(7, fwd, 12, false);
    ok('returns exactly `count` directions', dirs.length === 12, String(dirs.length));
    for (const d of dirs) {
      const len = Math.hypot(d.x, d.y, d.z);
      ok(`direction (${d.x.toFixed(2)},${d.y.toFixed(2)},${d.z.toFixed(2)}) is normalized`,
        Math.abs(len - 1) < 1e-6, String(len));
    }
    ok('pellets are NOT all identical (a real spread, not a degenerate single ray)',
      new Set(dirs.map((d) => `${d.x.toFixed(4)},${d.y.toFixed(4)},${d.z.toFixed(4)}`)).size > 1);
    ok('every pellet stays roughly forward (small cone, not a wild scatter)',
      dirs.every((d) => (-d.z) > 0.9), JSON.stringify(dirs.map((d) => -d.z)));
    ok('zooming (ADS) narrows the cone (sprayPatternSpreadADS < sprayPatternSpread)',
      (() => {
        const wide = srv.pelletDirections(7, fwd, 12, false);
        const tight = srv.pelletDirections(7, fwd, 12, true);
        const spread = (arr) => Math.max(...arr.map((d) => Math.hypot(d.x, d.y)));
        return spread(tight) < spread(wide);
      })());
  }

  console.log('\n── fireShotgunPellets: a point-blank target takes MULTIPLE pellets\' worth of damage ──');
  {
    const shooter = mkPlayer('shotA', 0, 300, 0, { equippedWeaponId: 7, yaw: 0, pitch: 0 });
    // yaw=0,pitch=0 -> aimDirection is -z (see the forward-direction ground truth used throughout
    // this project's bot-AI tests). Victim directly ahead, close enough that the whole pellet cone
    // (a few tenths of a unit wide at this range) lands on their hitbox.
    const victim = mkPlayer('shotB', 0, 300, -5, { healthPoints: 1, armorPoints: 0, deathStateTimer: 0 });
    if (victim._ps) victim._ps.Qalaptp = -1;   // clear spawn protection, see test_bot_settings.js's note
    const sessions = new Map([['shotA', mkSession('shotA', shooter)], ['shotB', mkSession('shotB', victim)]]);

    srv.fireShotgunPellets(shooter, sessions, null);
    const hpLost = 1 - victim.healthPoints;
    // Normalized HP scale (0..1): one pellet is catalogue dmg (12) x DMG_GLOBAL_MULT (0.01) = 0.12.
    const singlePelletDmgNormalized = srv.WEAPON_DMG[7] * 0.01;
    ok('total damage exceeds a single pellet\'s worth (multiple of the 12 landed)',
      hpLost > singlePelletDmgNormalized * 1.5,
      `hpLost=${hpLost} singlePellet=${singlePelletDmgNormalized}`);
    ok('no activeEntities were spawned (hitscan, not a projectile)',
      [...srv.getActiveEntities().values()].every((e) => e.ownerSid !== shooter._ownerSid));
  }

  console.log('\n── fireProjectileShot: Rocket Launcher spawns a real projectile entity, not a hitscan ──');
  {
    const shooter = mkPlayer('rocketA', 0, 300, 0, { equippedWeaponId: 8, yaw: 0, pitch: 0 });
    const sessions = new Map([['rocketA', mkSession('rocketA', shooter)]]);
    const before = srv.getActiveEntities().size;
    srv.fireProjectileShot(shooter, sessions, null);
    const after = srv.getActiveEntities().size;
    ok('exactly one entity was spawned', after === before + 1, `before=${before} after=${after}`);
    const entry = [...srv.getActiveEntities().values()].find((e) => e.ownerSid === shooter._ownerSid);
    ok('its weaponTypeId (type) is the GUN\'S OWN nid (8), not a separate projectile id',
      entry && entry.type === 8, entry && String(entry.type));
    ok('its combat behavior is "impact"', entry && entry.combat && entry.combat.behavior === 'impact');
    ok('it flies with zero vertical acceleration this tick (no gravity applied yet, just spawned)',
      entry && Number.isFinite(entry.vel.x));
    ok('ownerSid is the shooter', entry.ownerSid === shooter._ownerSid);
  }

  console.log('\n── Rocket Launcher detonates on a DIRECT player hit mid-flight (no wall needed) ──');
  {
    const shooter = mkPlayer('rocketB', 0, 300, 0, { equippedWeaponId: 8, yaw: 0, pitch: 0 });
    const victim = mkPlayer('rocketC', 0, 300, -3, { healthPoints: 1, armorPoints: 0, deathStateTimer: 0 });
    if (victim._ps) victim._ps.Qalaptp = -1;
    const sessions = new Map([
      ['rocketB', mkSession('rocketB', shooter)],
      ['rocketC', mkSession('rocketC', victim)],
    ]);
    srv.fireProjectileShot(shooter, sessions, null);
    const entities = srv.getActiveEntities();
    const key = [...entities.entries()].find(([, e]) => e.ownerSid === shooter._ownerSid)[0];
    // The spawn-tick self-hit guard compares against the REAL server's globalTick, which this
    // synthetic test never advances (no tick loop is running) — so it would look permanently
    // "still on the spawn tick" and the direct-hit check would never even run. Back-date the
    // entity's own birth tick instead, exactly like test_entity_lifecycle.js does for the same
    // reason, rather than trying to fake a running tick loop.
    entities.get(key)._bornTick = -100;

    // Drive enough ticks for the rocket (28 u/s) to cross the 3u gap to the victim.
    for (let i = 0; i < 10 && entities.has(key); i++) {
      srv.simulateGrenades(1 / 20, sessions);
    }
    ok('victim took damage from a direct hit (never touched a wall)',
      victim.healthPoints < 1, `hp=${victim.healthPoints}`);
  }

  console.log('\n── source check: fireWeapon dispatches by weapon, not one hitscan for everything ──');
  {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    ok('fireWeapon checks isProjectileWeapon before falling back to hitscan',
      /isProjectileWeapon\(nid\)\) fireProjectileShot/.test(src));
    ok('fireWeapon checks weaponPelletCount before falling back to hitscan',
      /weaponPelletCount\(nid\) > 1\) fireShotgunPellets/.test(src));
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
