/**
 * test_bot_settings.js — botCount/botLevel settings reconcile live bots the same way every other
 * live setting in this project works: change it, effect happens immediately, no restart.
 *
 * Usage:  node scripts/test_bot_settings.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = process.env.EVIO_LOCAL_PORT || '18510';
process.env.EVIO_JOIN_DEADLINE = '0';
// Real players here join via a real connection — a held player ("Hold new players until they
// click to play", now the default) is correctly excluded from bot targeting/damage (a spectator
// can't be shot), which would zero out this file's own bot-count/damage-multiplier assertions.
// Not what this file tests (bot settings behavior once players ARE actually playing).
process.env.EVIO_CLICK_TO_PLAY = process.env.EVIO_CLICK_TO_PLAY || '0';

const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const S = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await bpw.ready;

  console.log('\n── botCount is a no-op before the server has started ──');
  {
    // Setting botCount before startServer() must not throw (spawnBot doesn't exist yet) — it should
    // just be picked up later, same as startupMap's two-step apply pattern.
    let threw = null;
    try { S.set('botCount', 2, 'test'); } catch (err) { threw = err; }
    ok('setting botCount pre-start does not throw', threw === null, threw && threw.message);
    ok('and no bots exist yet (nothing to reconcile against)', srv.listBots().length === 0);
    S.set('botCount', 0, 'test');   // reset before the real server starts, below
  }

  srv.startServer();
  await wait(300);

  console.log('\n── raising botCount spawns the difference immediately ──');
  {
    S.set('botCount', 3, 'test');
    ok('3 bots now exist', srv.listBots().length === 3, String(srv.listBots().length));
    S.set('botCount', 5, 'test');
    ok('raising it again spawns only the DIFFERENCE (now 5 total)', srv.listBots().length === 5,
      String(srv.listBots().length));
  }

  console.log('\n── lowering botCount removes the MOST RECENTLY added bots first ──');
  {
    const before = srv.listBots().map((b) => b.playerId);
    S.set('botCount', 2, 'test');
    const after = srv.listBots().map((b) => b.playerId);
    ok('bot count dropped to 2', after.length === 2, String(after.length));
    ok('the two SURVIVING bots are the two EARLIEST of the original five',
      after[0] === before[0] && after[1] === before[1],
      `before=${JSON.stringify(before)} after=${JSON.stringify(after)}`);
  }

  console.log('\n── botLevel applies to every EXISTING bot, not just future spawns ──');
  {
    S.set('botCount', 2, 'test');
    const bots = srv.listBots();
    ok('both existing bots do not already sit at the target level',
      bots.every((b) => b.botLevel !== 8));
    S.set('botLevel', 8, 'test');
    ok('every existing bot is now at level 8', srv.listBots().every((b) => b.botLevel === 8),
      JSON.stringify(srv.listBots().map((b) => b.botLevel)));

    S.set('botCount', 3, 'test');
    ok('a bot spawned AFTER the level change also gets the current level, not the old default',
      srv.listBots()[2].botLevel === 8, String(srv.listBots()[2].botLevel));
  }

  console.log('\n── botCount/botLevel are clamped by the setting definition itself ──');
  {
    const overCount = S.set('botCount', 999, 'test');
    ok('botCount cannot be set above its declared max', overCount.ok === false, JSON.stringify(overCount));
    const overLevel = S.set('botLevel', 11, 'test');
    ok('botLevel cannot be set above 10', overLevel.ok === false, JSON.stringify(overLevel));
    const underLevel = S.set('botLevel', 0, 'test');
    ok('botLevel cannot be set below 1', underLevel.ok === false, JSON.stringify(underLevel));
  }

  console.log('\n── setting botCount to 0 removes every bot ──');
  {
    S.set('botCount', 0, 'test');
    ok('no bots remain', srv.listBots().length === 0);
    ok('the game loop stops once nothing accepted remains', srv.getStatus().tickRate === 0
      || srv.getSessions().size === 0);
  }

  console.log('\n── swordBotCount is INDEPENDENT of botCount ──');
  {
    S.set('botCount', 2, 'test');
    S.set('swordBotCount', 3, 'test');
    const all = srv.listBots();
    ok('total bots = botCount + swordBotCount (2 + 3)', all.length === 5, String(all.length));
    ok('exactly 2 are plain (gun) bots', all.filter((b) => !b.isSwordBot).length === 2,
      JSON.stringify(all.map((b) => b.isSwordBot)));
    ok('exactly 3 are sword bots', all.filter((b) => b.isSwordBot).length === 3,
      JSON.stringify(all.map((b) => b.isSwordBot)));

    S.set('botCount', 0, 'test');
    const afterGunZero = srv.listBots();
    ok('dropping botCount to 0 removes ONLY the gun bots, leaving all 3 sword bots untouched',
      afterGunZero.length === 3 && afterGunZero.every((b) => b.isSwordBot),
      JSON.stringify(afterGunZero.map((b) => b.isSwordBot)));

    S.set('swordBotCount', 0, 'test');
    ok('dropping swordBotCount to 0 removes the rest', srv.listBots().length === 0,
      String(srv.listBots().length));
  }

  console.log('\n── sword bots carry ONLY the sword, and get the Teleport/Impulse ability seed ──');
  {
    S.set('swordBotCount', 1, 'test');
    const [swordBot] = srv.listBots();
    ok('equippedWeaponId is the sword (262)', swordBot.playerState.equippedWeaponId === 262,
      String(swordBot.playerState.equippedWeaponId));
    ok('weaponList carries NOTHING but the sword', JSON.stringify(swordBot.playerState.weaponList) === '[262]',
      JSON.stringify(swordBot.playerState.weaponList));
    ok('isSwordBot is tagged on the session', swordBot.isSwordBot === true);
    const seed = swordBot.playerState._ps.weaponStateArray;
    ok('ability seed grants Teleport level 5 (index 0)', seed[0] === 5, String(seed[0]));
    ok('ability seed grants Impulse level 1 (index 16)', seed[16] === 1, String(seed[16]));
    ok('ability seed grants HE level 1 (index 8)', seed[8] === 1, String(seed[8]));
    ok('ability seed grants Sticky level 1 (index 13)', seed[13] === 1, String(seed[13]));
    // Charges = floor(1 / ABILITY_COST[level-1]) — verify the computed weaponStats actually gives
    // the requested "5 charges of teleportation" via the REAL client ability formula, not just that
    // the raw seed number happens to be 5.
    const stats = require('../ability_stats').computeWeaponStats(seed);
    const teleportCost = require('../ability_stats').ABILITY_COST[0][seed[0] - 1];
    ok('the resulting Teleport ability really does resolve to exactly 5 charges',
      Math.floor(1 / teleportCost) === 5, `cost=${teleportCost}`);
    ok('Qkrh1tv (teleport distance) and Qn97q6u (recharge rate) are both nonzero — the ability is actually equipped, not just labelled',
      stats.Qkrh1tv > 0 && stats.Qn97q6u > 0, `Qkrh1tv=${stats.Qkrh1tv} Qn97q6u=${stats.Qn97q6u}`);

    S.set('swordBotCount', 0, 'test');
  }

  console.log('\n── swordBotLevel is independent of botLevel (separate difficulty pools) ──');
  {
    const botDifficulty = require('../bot_difficulty');
    S.set('botLevel', 2, 'test');
    S.set('swordBotLevel', 9, 'test');
    S.set('botCount', 1, 'test');
    S.set('swordBotCount', 1, 'test');
    const gunBot = srv.listBots().find((b) => !b.isSwordBot);
    const swordBot = srv.listBots().find((b) => b.isSwordBot);
    ok('a gun bot spawns at botLevel, not swordBotLevel', gunBot.botLevel === 2, String(gunBot.botLevel));
    ok('a sword bot spawns at swordBotLevel, not botLevel', swordBot.botLevel === 9, String(swordBot.botLevel));

    // Changing ONE setting live must only retune ITS OWN pool.
    S.set('botLevel', 7, 'test');
    ok('raising botLevel live updates the gun bot', gunBot.botLevel === 7, String(gunBot.botLevel));
    ok('and does NOT touch the sword bot', swordBot.botLevel === 9, String(swordBot.botLevel));
    S.set('swordBotLevel', 1, 'test');
    ok('lowering swordBotLevel live updates the sword bot', swordBot.botLevel === 1, String(swordBot.botLevel));
    ok('and does NOT touch the gun bot', gunBot.botLevel === 7, String(gunBot.botLevel));

    // The actual difficulty CURVE genuinely differs between the two pools now, not just the label.
    const gunCurve = botDifficulty.curveForLevel(gunBot.botLevel);
    const swordCurve = botDifficulty.curveForLevel(swordBot.botLevel);
    ok('the two bots resolve to genuinely different aim cones',
      Math.abs(gunCurve.aimConeInitialDeg - swordCurve.aimConeInitialDeg) > 1,
      `gun=${gunCurve.aimConeInitialDeg} sword=${swordCurve.aimConeInitialDeg}`);

    S.set('botCount', 0, 'test');
    S.set('swordBotCount', 0, 'test');
    S.set('botLevel', 5, 'test');
    S.set('swordBotLevel', 5, 'test');
  }

  console.log('\n── swordBotImpulseEnabled / swordBotGrenadesEnabled gate the TACTIC, not the ability seed ──');
  {
    S.set('swordBotCount', 1, 'test');
    const [swordBot] = srv.listBots();
    const seed = swordBot.playerState._ps.weaponStateArray;
    ok('the ability seed still allocates Impulse/HE/Sticky regardless of the toggles',
      seed[16] === 1 && seed[8] === 1 && seed[13] === 1, JSON.stringify(seed));

    S.set('swordBotImpulseEnabled', false, 'test');
    S.set('swordBotGrenadesEnabled', false, 'test');
    // The ability seed must be UNCHANGED — these toggles gate the AI's choice to use them, not the
    // loadout, so a re-check of the SAME bot's seed after flipping both off should show no change.
    const seedAfter = swordBot.playerState._ps.weaponStateArray;
    ok('the ability seed is unaffected by either toggle', JSON.stringify(seedAfter) === JSON.stringify(seed),
      JSON.stringify(seedAfter));

    // Force a scenario where the bot WOULD throw every ability (wounded, mid-range, everything
    // charged) and confirm nothing fires with both toggles off.
    const botDifficulty = require('../bot_difficulty');
    const p = swordBot.playerState;
    p.healthPoints = 0.2;   // wounded — normally triggers Impulse
    if (p._ps) { p._ps.Qctsdxa = 1; p._ps.Qctsdxg = 1; p._ps.Qctsdxc = 1; }   // full charge on all three
    const targetPs = srv.createPlayerSimState({ x: 0, y: 300, z: -8 }, 'toggleTarget');
    p.position.x = 0; p.position.y = 300; p.position.z = 0;
    const target = { session: { playerState: targetPs }, eye: { x: 0, y: 301.6, z: -8 }, dist: 8 };
    swordBot._ai = { targetId: 'toggleTarget', targetLockTicks: 500, lastSeenTick: 0, acquiredTick: 0,
      aimNoiseYaw: 0, aimNoisePitch: 0 };
    let sawAnyThrow = false;
    for (let t = 0; t < 400; t++) {
      const frame = srv._swordCombatFrame(swordBot, botDifficulty.curveForLevel(swordBot.botLevel), target, t, new Map());
      if (frame.released.length > 0) sawAnyThrow = true;
    }
    ok('with both toggles OFF, the bot never throws Impulse/HE/Sticky over a long window',
      !sawAnyThrow);

    S.set('swordBotImpulseEnabled', true, 'test');
    S.set('swordBotGrenadesEnabled', true, 'test');
    let sawThrowAgain = false;
    for (let t = 0; t < 400; t++) {
      const frame = srv._swordCombatFrame(swordBot, botDifficulty.curveForLevel(swordBot.botLevel), target, t, new Map());
      if (frame.released.length > 0) sawThrowAgain = true;
    }
    ok('turning both back on restores throwing (same charged, wounded, in-range scenario)',
      sawThrowAgain);

    S.set('swordBotCount', 0, 'test');
  }

  console.log('\n── plain botCount bots are UNCHANGED by sword bots existing (no cross-contamination) ──');
  {
    S.set('botCount', 1, 'test');
    const [gunBot] = srv.listBots();
    ok('a plain bot still gets the default weapon, not the sword', gunBot.playerState.equippedWeaponId !== 262
      || gunBot.isSwordBot, `weapon=${gunBot.playerState.equippedWeaponId} isSwordBot=${gunBot.isSwordBot}`);
    ok('isSwordBot is false for a plain bot', gunBot.isSwordBot === false);
    ok('its ability seed is the plain BOT_ABILITY_SEED (no Teleport/Impulse)',
      gunBot.playerState._ps.weaponStateArray[0] === 0 && gunBot.playerState._ps.weaponStateArray[16] === 0,
      JSON.stringify(gunBot.playerState._ps.weaponStateArray));
    S.set('botCount', 0, 'test');
  }

  console.log('\n── botDamageMult: scales damage ONLY when the shooter is a bot ──');
  {
    const mkVictim = (sid) => {
      const ps = srv.createPlayerSimState({ x: 1, y: 0, z: 0 }, sid);
      ps.healthPoints = 1; ps.armorPoints = 0; ps.deathStateTimer = 0;
      // A freshly-spawned playerState starts with spawn protection active (Qalaptp > 0) — applyDamage
      // gates on it FIRST and returns without applying anything (see test_counters.js's own note on
      // this), which would silently zero out every hpLost measurement below. Not the thing under test.
      if (ps._ps) ps._ps.Qalaptp = -1;
      return ps;
    };
    const mkShooter = (sid) => {
      const ps = srv.createPlayerSimState({ x: 0, y: 0, z: 0 }, sid);
      ps.equippedWeaponId = 4;   // matches this project's other combat tests' default weapon
      return ps;
    };
    const eye = { x: 0, y: 1, z: 0 };

    S.set('botDamageMult', 1, 'test');
    const botShooter1 = mkShooter('botShooter1');
    const victim1 = mkVictim('victim1');
    const sessions1 = new Map([
      ['botShooter1', { accepted: true, isBot: true, playerState: botShooter1 }],
      ['victim1', { accepted: true, isBot: false, playerState: victim1 }],
    ]);
    srv.applyHit(botShooter1, sessions1, { victimSid: victim1._ps.Q7q6byi, headshot: false }, eye, 1);
    const hpLostAtMult1 = 1 - victim1.healthPoints;
    ok('a bot shooter at botDamageMult=1 deals some damage (sanity)', hpLostAtMult1 > 0,
      String(hpLostAtMult1));

    S.set('botDamageMult', 2, 'test');
    const botShooter2 = mkShooter('botShooter2');
    const victim2 = mkVictim('victim2');
    const sessions2 = new Map([
      ['botShooter2', { accepted: true, isBot: true, playerState: botShooter2 }],
      ['victim2', { accepted: true, isBot: false, playerState: victim2 }],
    ]);
    srv.applyHit(botShooter2, sessions2, { victimSid: victim2._ps.Q7q6byi, headshot: false }, eye, 1);
    const hpLostAtMult2 = 1 - victim2.healthPoints;
    ok('doubling botDamageMult roughly doubles a BOT shooter\'s damage',
      Math.abs(hpLostAtMult2 - hpLostAtMult1 * 2) < 1e-9,
      `x1=${hpLostAtMult1} x2=${hpLostAtMult2}`);

    // Same botDamageMult=2 still active — a REAL PLAYER shooter must be completely unaffected.
    const humanShooter = mkShooter('human1');
    const victim3 = mkVictim('victim3');
    const sessions3 = new Map([
      ['human1', { accepted: true, isBot: false, playerState: humanShooter }],
      ['victim3', { accepted: true, isBot: false, playerState: victim3 }],
    ]);
    srv.applyHit(humanShooter, sessions3, { victimSid: victim3._ps.Q7q6byi, headshot: false }, eye, 1);
    const hpLostHuman = 1 - victim3.healthPoints;
    ok('a REAL PLAYER shooter deals the botDamageMult=1 amount regardless of the current bot setting',
      Math.abs(hpLostHuman - hpLostAtMult1) < 1e-9, `human=${hpLostHuman} botBaseline=${hpLostAtMult1}`);

    S.set('botDamageMult', 1, 'test');   // restore default before other suites run
  }

  console.log('\n── botFriendlyFire: OFF blocks damage between two DIFFERENT bots only ──');
  {
    const mkVictim = (sid) => {
      const ps = srv.createPlayerSimState({ x: 1, y: 0, z: 0 }, sid);
      ps.healthPoints = 1; ps.armorPoints = 0; ps.deathStateTimer = 0;
      if (ps._ps) ps._ps.Qalaptp = -1;   // clear spawn protection — see the botDamageMult test above
      return ps;
    };
    const mkShooter = (sid) => {
      const ps = srv.createPlayerSimState({ x: 0, y: 0, z: 0 }, sid);
      ps.equippedWeaponId = 4;
      return ps;
    };
    const eye = { x: 0, y: 1, z: 0 };

    ok('defaults to true (bots can kill each other unless turned off)', S.get('botFriendlyFire') === true);

    S.set('botFriendlyFire', false, 'test');

    const botA = mkShooter('ffBotA');
    const botB = mkVictim('ffBotB');
    const bothBotsSessions = new Map([
      ['ffBotA', { accepted: true, isBot: true, playerState: botA }],
      ['ffBotB', { accepted: true, isBot: true, playerState: botB }],
    ]);
    srv.applyHit(botA, bothBotsSessions, { victimSid: botB._ps.Q7q6byi, headshot: false }, eye, 1);
    ok('bot-on-bot damage is fully blocked when off', botB.healthPoints === 1, String(botB.healthPoints));

    const botC = mkShooter('ffBotC');
    const human1 = mkVictim('ffHuman1');
    const botVsHumanSessions = new Map([
      ['ffBotC', { accepted: true, isBot: true, playerState: botC }],
      ['ffHuman1', { accepted: true, isBot: false, playerState: human1 }],
    ]);
    srv.applyHit(botC, botVsHumanSessions, { victimSid: human1._ps.Q7q6byi, headshot: false }, eye, 1);
    ok('a bot shooting a REAL PLAYER is unaffected', human1.healthPoints < 1, String(human1.healthPoints));

    const human2 = mkShooter('ffHuman2');
    const botD = mkVictim('ffBotD');
    const humanVsBotSessions = new Map([
      ['ffHuman2', { accepted: true, isBot: false, playerState: human2 }],
      ['ffBotD', { accepted: true, isBot: true, playerState: botD }],
    ]);
    srv.applyHit(human2, humanVsBotSessions, { victimSid: botD._ps.Q7q6byi, headshot: false }, eye, 1);
    ok('a REAL PLAYER shooting a bot is unaffected', botD.healthPoints < 1, String(botD.healthPoints));

    // A bot's own fall damage (attacker === victim) must still apply — this setting only ever blocks
    // damage between two DIFFERENT bots, never self-damage.
    const botE = mkVictim('ffBotE');
    srv.applyDamage(botE, 0.5, botE, {});
    ok('a bot\'s own self-damage (e.g. a fall) is unaffected', botE.healthPoints < 1, String(botE.healthPoints));

    S.set('botFriendlyFire', true, 'test');
    const botF = mkShooter('ffBotF');
    const botG = mkVictim('ffBotG');
    const bothBotsSessions2 = new Map([
      ['ffBotF', { accepted: true, isBot: true, playerState: botF }],
      ['ffBotG', { accepted: true, isBot: true, playerState: botG }],
    ]);
    srv.applyHit(botF, bothBotsSessions2, { victimSid: botG._ps.Q7q6byi, headshot: false }, eye, 1);
    ok('turning it back on restores bot-on-bot damage', botG.healthPoints < 1, String(botG.healthPoints));
  }

  console.log('\n── botFriendlyFire: OFF also stops bots TARGETING each other, not just harming ──');
  {
    // A bot that keeps picking another bot as its target but can never hurt it just walks up and
    // swings at nothing — that reads as broken, not "friendly". _visibleEnemies is the single choke
    // point both the gun-bot and sword-bot combat branches use to pick a target (via
    // _updateBotTarget), so filtering there covers both without touching either combat frame.
    const mkSession = (id, x, y, z, isBot) => {
      const ps = srv.createPlayerSimState({ x, y, z, yaw: 0 }, id);
      ps.healthPoints = 1; ps.deathStateTimer = 0;
      return { playerId: id, sessionId: id, accepted: true, isBot, playerState: ps };
    };
    // Far above the map (y=300) so no geometry can sit between them, matching test_bot_ai.js's own
    // _visibleEnemies test — the thing under test here is the FRIENDLY-FIRE filter, not LOS geometry.
    const botX = mkSession('vfBotX', 0, 300, 0, true);
    const botY = mkSession('vfBotY', 0, 300, -5, true);
    const human = mkSession('vfHuman', 0, 300, 5, false);
    const sessions = new Map([['vfBotX', botX], ['vfBotY', botY], ['vfHuman', human]]);

    S.set('botFriendlyFire', true, 'test');
    const visibleOn = srv._visibleEnemies(botX, sessions, 60);
    ok('with it ON, a bot sees BOTH the other bot and the human',
      visibleOn.some((v) => v.session === botY) && visibleOn.some((v) => v.session === human),
      JSON.stringify(visibleOn.map((v) => v.session.playerId)));

    S.set('botFriendlyFire', false, 'test');
    const visibleOff = srv._visibleEnemies(botX, sessions, 60);
    ok('with it OFF, the other bot is filtered out of the target list',
      !visibleOff.some((v) => v.session === botY),
      JSON.stringify(visibleOff.map((v) => v.session.playerId)));
    ok('but the REAL PLAYER is still a valid target',
      visibleOff.some((v) => v.session === human),
      JSON.stringify(visibleOff.map((v) => v.session.playerId)));

    const visibleHuman = srv._visibleEnemies(human, sessions, 60);
    ok('a REAL PLAYER still sees every bot regardless of the setting (only bot->bot is filtered)',
      visibleHuman.some((v) => v.session === botX) && visibleHuman.some((v) => v.session === botY),
      JSON.stringify(visibleHuman.map((v) => v.session.playerId)));

    S.set('botFriendlyFire', true, 'test');
  }

  S.set('botCount', 0, 'test');
  S.set('botLevel', 5, 'test');

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
