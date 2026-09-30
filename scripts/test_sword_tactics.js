/**
 * test_sword_tactics.js — sword bot grenade offense (HE/Sticky) and reactive dodging (gun
 * line-of-fire, live enemy ordnance) built on top of the existing teleport/impulse tactics that
 * test_bot_ai.js already covers.
 *
 * Usage:  node scripts/test_sword_tactics.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = '18476';
process.env.EVIO_JOIN_DEADLINE = '0';

const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const botDifficulty = require('../bot_difficulty');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

function mkSession(id, x, y, z, overrides = {}) {
  const ps = srv.createPlayerSimState({ x, y, z, yaw: 0 }, id);
  Object.assign(ps, overrides);
  return { playerId: id, sessionId: id, accepted: true, isBot: id.startsWith('bot'), playerState: ps };
}

(async () => {
  await bpw.ready;
  srv.startServer();

  console.log('\n── sword bot loadout: HE and Sticky are now allocated ──');
  {
    const bot = srv.spawnBot({ name: 'GrenadeSword', swordOnly: true, level: 5 });
    const arr = bot.playerState._ps.weaponStateArray;
    ok('HE (index 8) is allocated', arr[8] > 0, JSON.stringify(arr));
    ok('Sticky (index 13) is allocated', arr[13] > 0, JSON.stringify(arr));
    ok('Impulse (index 16) is still allocated (pre-existing)', arr[16] > 0, JSON.stringify(arr));
    ok('Mine (index 14) is deliberately NOT allocated', arr[14] === 0, JSON.stringify(arr));
    ok('Trip Mine (index 15) is deliberately NOT allocated', arr[15] === 0, JSON.stringify(arr));
    srv.removeBot(bot.playerId);
  }

  console.log('\n── _findGunLineThreat ──');
  {
    const bot = mkSession('bot1', 0, 300, 0);
    const shooter = mkSession('gunner', 0, 300, -20, { equippedWeaponId: 4, yaw: Math.PI, pitch: 0 });
    // yaw=PI, pitch=0 -> aimDirection points toward +z (see phys.aimDirection/forward convention),
    // i.e. from (0,300,-20) toward (0,300,0): straight at the bot.
    const sessions = new Map([['bot1', bot], ['gunner', shooter]]);
    const threat = srv._findGunLineThreat(bot, sessions);
    ok('a gun aimed straight at us registers as a threat', !!threat, JSON.stringify(threat));

    shooter.playerState.equippedWeaponId = srv.SWORD_WEAPON_ID;
    ok('the SAME aim from a SWORD wielder registers no threat',
      !srv._findGunLineThreat(bot, sessions));

    shooter.playerState.equippedWeaponId = 4;
    shooter.playerState.yaw = 0;   // now aiming away from the bot entirely
    ok('a gun aimed elsewhere (outside the cone) registers no threat',
      !srv._findGunLineThreat(bot, sessions));

    ok('no threat at all when sessions is not provided', !srv._findGunLineThreat(bot, undefined));
  }

  console.log('\n── _findExplosiveThreat ──');
  {
    const bot = mkSession('bot2', 0, 300, 0);
    const activeEntities = srv.getActiveEntities();
    activeEntities.clear();

    activeEntities.set('mine-far', {
      pos: { x: 100, y: 300, z: 100 }, ownerSid: 'enemy', type: 173,
      combat: srv.GRENADE_COMBAT[173], armed: true,
    });
    ok('a far-away armed mine is not a threat', !srv._findExplosiveThreat(bot));

    activeEntities.set('mine-near', {
      pos: { x: 2, y: 300, z: 0 }, ownerSid: 'enemy', type: 173,
      combat: srv.GRENADE_COMBAT[173], armed: true,
    });
    const mineThreat = srv._findExplosiveThreat(bot);
    ok('a nearby ARMED mine is a threat', !!mineThreat && mineThreat.type === 'mine',
      JSON.stringify(mineThreat));

    activeEntities.clear();
    activeEntities.set('mine-unarmed', {
      pos: { x: 2, y: 300, z: 0 }, ownerSid: 'enemy', type: 173,
      combat: srv.GRENADE_COMBAT[173], armed: false,
    });
    ok('an UNARMED mine at the same distance is not a threat (still settling)',
      !srv._findExplosiveThreat(bot));

    activeEntities.clear();
    activeEntities.set('mine-own', {
      pos: { x: 2, y: 300, z: 0 }, ownerSid: bot.playerState._ownerSid, type: 173,
      combat: srv.GRENADE_COMBAT[173], armed: true,
    });
    ok('our OWN armed mine is never a threat to ourselves', !srv._findExplosiveThreat(bot));

    activeEntities.clear();
    activeEntities.set('he-near', {
      pos: { x: 3, y: 300, z: 0 }, ownerSid: 'enemy', type: 46,
      combat: srv.GRENADE_COMBAT[46],
    });
    const heThreat = srv._findExplosiveThreat(bot);
    ok('a live HE grenade within blast range + margin is a threat', !!heThreat && heThreat.type === 'grenade',
      JSON.stringify(heThreat));
    ok('urgency rises toward 1 the closer we are', heThreat.urgency > 0.5, String(heThreat.urgency));

    activeEntities.clear();
    // Trip mine beam running along +x from origin; bot standing 0.5u off the beam at x=10.
    activeEntities.set('trip-near', {
      pos: { x: 0, y: 300, z: 5 }, ownerSid: 'enemy', type: 176,
      combat: srv.GRENADE_COMBAT[176], armed: true,
      ray: { ox: 0, oy: 300, oz: 0, dx: 1, dy: 0, dz: 0 },
    });
    const tripBot = mkSession('bot3', 10, 300, 0.5);
    const tripThreat = srv._findExplosiveThreat(tripBot);
    ok('standing near an armed trip-mine beam is a threat', !!tripThreat && tripThreat.type === 'tripmine',
      JSON.stringify(tripThreat));
    const farBot = mkSession('bot4', 10, 300, 20);
    ok('standing far off the same beam is not a threat', !srv._findExplosiveThreat(farBot));

    activeEntities.clear();
  }

  console.log('\n── _bodyRelativeEscapeKeys: world escape vector -> body-relative keys ──');
  {
    const p = { yaw: 0 };   // facing -z (see the forward-direction ground truth in test_bot_ai.js)
    ok('escaping toward world +x maps to strafe-right (3)',
      srv._bodyRelativeEscapeKeys(p, 1, 0).includes(3));
    ok('escaping toward world -x maps to strafe-left (2)',
      srv._bodyRelativeEscapeKeys(p, -1, 0).includes(2));
    ok('escaping toward world -z (same way we face) includes forward (0)',
      srv._bodyRelativeEscapeKeys(p, 0, -1).includes(0));
    ok('escaping toward world +z (behind us) includes backward (1)',
      srv._bodyRelativeEscapeKeys(p, 0, 1).includes(1));
    ok('a zero vector produces no keys', srv._bodyRelativeEscapeKeys(p, 0, 0).length === 0);
  }

  console.log('\n── _swordCombatFrame: dodges a gun line-of-fire threat with a strafe key ──');
  {
    const bot = mkSession('swK', 0, 300, 0);
    bot._ai = { targetId: 't', targetLockTicks: 500, lastSeenTick: 0, acquiredTick: 0,
      aimNoiseYaw: 0, aimNoisePitch: 0 };
    bot.playerState._ps.Qctsdxd = 0; bot.playerState._ps.Qctsdxa = 0;
    bot.playerState._ps.Qctsdxg = 0; bot.playerState._ps.Qctsdxc = 0;   // isolate: no throws/teleports
    const meleeTargetSession = mkSession('t', 0, 300, -15, { equippedWeaponId: srv.SWORD_WEAPON_ID });
    const target = { session: meleeTargetSession, eye: { x: 0, y: 301.6, z: -15 }, dist: 15 };
    // A THIRD player, a gun-wielder, lined up on the bot from the side.
    const shooter = mkSession('shooter', -20, 300, 0, { equippedWeaponId: 4 });
    shooter.playerState.yaw = -Math.PI / 2;   // aimDirection toward +x -> straight at the bot
    shooter.playerState.pitch = 0;
    const sessions = new Map([['swK', bot], ['t', meleeTargetSession], ['shooter', shooter]]);

    // The shooter sits directly on the bot's world x-axis, so the perpendicular escape vector lands
    // almost exactly along z — which, given the bot's yaw-0 starting facing, resolves to the
    // backward key (1) rather than a strafe key (2/3). Either is a correct "step off the line"
    // dodge; what matters is that SOME escape key beyond the baseline forward+sprint approach shows
    // up, i.e. the dodge branch actually fired.
    let sawDodgeKey = false;
    for (let t = 0; t < 60; t++) {
      const frame = srv._swordCombatFrame(bot, botDifficulty.curveForLevel(5), target, t, sessions);
      if (frame.held.includes(1) || frame.held.includes(2) || frame.held.includes(3)) sawDodgeKey = true;
    }
    ok('a live gun-line threat produces a dodge escape key', sawDodgeKey);
  }

  console.log('\n── _swordCombatFrame: emergency-teleports away from a severe explosive threat ──');
  {
    const bot = mkSession('swL', 0, 300, 0);
    bot._ai = { targetId: 't', targetLockTicks: 500, lastSeenTick: 0, acquiredTick: 0,
      aimNoiseYaw: 0, aimNoisePitch: 0 };
    bot.playerState._ps.Qctsdxa = 0; bot.playerState._ps.Qctsdxg = 0; bot.playerState._ps.Qctsdxc = 0;
    bot.playerState._ps.Qctsdxd = 1;   // full teleport charge
    const targetSession = mkSession('t', 0, 300, -15, { equippedWeaponId: srv.SWORD_WEAPON_ID });
    const target = { session: targetSession, eye: { x: 0, y: 301.6, z: -15 }, dist: 15 };

    const activeEntities = srv.getActiveEntities();
    activeEntities.clear();
    // An armed mine right under the bot's feet — urgency ~1, well above the escape-teleport threshold.
    activeEntities.set('mine-urgent', {
      pos: { x: 0.2, y: 300, z: 0 }, ownerSid: 'enemy', type: 173,
      combat: srv.GRENADE_COMBAT[173], armed: true,
    });

    const sessions = new Map([['swL', bot], ['t', targetSession]]);
    const frame = srv._swordCombatFrame(bot, botDifficulty.curveForLevel(5), target, 1000, sessions);
    ok('teleport (action 9) fires immediately against a severe, close threat',
      frame.pressed.includes(9), JSON.stringify(frame));
    ok('no grenade/impulse is thrown in the same tick as an emergency teleport',
      frame.released.length === 0, JSON.stringify(frame.released));

    activeEntities.clear();
  }

  console.log('\n── _swordCombatFrame: throws HE and Sticky offensively at a gun-wielding target ──');
  {
    const bot = mkSession('swM', 0, 300, 0);
    bot._ai = { targetId: 't', targetLockTicks: 500, lastSeenTick: 0, acquiredTick: 0,
      aimNoiseYaw: 0, aimNoisePitch: 0 };
    bot.playerState._ps.Qctsdxd = 0; bot.playerState._ps.Qctsdxa = 0;   // isolate from teleport/impulse
    bot.playerState._ps.Qctsdxg = 1; bot.playerState._ps.Qctsdxc = 1;   // full HE/Sticky charge
    const targetSession = mkSession('t', 0, 300, -12, { equippedWeaponId: 4 });   // gun-wielding, mid-range
    const target = { session: targetSession, eye: { x: 0, y: 301.6, z: -12 }, dist: 12 };
    const sessions = new Map([['swM', bot], ['t', targetSession]]);

    let sawHe = false, sawSticky = false;
    for (let t = 0; t < 400; t++) {
      const frame = srv._swordCombatFrame(bot, botDifficulty.curveForLevel(5), target, t, sessions);
      if (frame.released.includes(19)) sawHe = true;
      if (frame.released.includes(22)) sawSticky = true;
    }
    ok('HE (action 19) is eventually thrown at mid-range', sawHe);
    ok('Sticky (action 22) is eventually thrown at mid-range', sawSticky);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
