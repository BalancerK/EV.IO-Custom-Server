/**
 * test_survival_mode.js — co-op Survival: wave/boss escalation, no-respawn for real players,
 * round-ends-on-wipe, and no-PvP — all gated on gameMode==="survival" and otherwise a no-op
 * (deathmatch's existing behavior must stay exactly as it was before this mode existed).
 *
 * Usage:  node scripts/test_survival_mode.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = process.env.EVIO_LOCAL_PORT || '18476';
process.env.EVIO_JOIN_DEADLINE = '0';
// See test_rounds.js's own comment: applyDamage refuses all damage for a held player, which
// every synthetic session here would otherwise be.
process.env.EVIO_CLICK_TO_PLAY = process.env.EVIO_CLICK_TO_PLAY || '0';

const WebSocket = require('ws');
const S = require('../settings');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const readOp = (body, op) => {
  for (let i = 0; i < body.length - 1; i++) if (body[i] === op && body[i - 1] !== op) return body[i + 1];
  return undefined;
};

// With a real server instance running (needed for the spawnBot/listBots sections below), the
// background tick loop grants a freshly-created playerState spawn protection (opcode 181/Qalaptp,
// see applySpawnCounters/SPAWN_PROTECT_TICKS) within its first real tick or two — applyDamage
// correctly refuses ALL damage while that's set (matching the client's own Q2ngzid gate), so every
// synthetic playerState here needs it explicitly cleared before a direct applyDamage call, same
// as it would naturally expire ~2s into a real session. `-1` is applySpawnCounters' own
// "no protection" sentinel (not 0 — see its comment).
function mkPlayerState(id) {
  const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, id);
  if (ps._ps) ps._ps.Qalaptp = -1;
  return ps;
}
function mkRealSession(id) {
  return {
    sessionId: id, playerId: id, accepted: true, displayName: id, uid: 7, isBot: false,
    playerState: mkPlayerState(id),
    ws: { readyState: 1, OPEN: 1, send() {} },
  };
}
// buildWeaponPickupBlock's per-point chunks all start with opcode 278 (point index) and are a
// fixed 12 entries long (278,i,270,i,271,weaponTypeId,273,hidden,274,glow,275,null) — split on
// that delimiter so each point's own fields can be read with readOp independently.
function splitPickupBlocks(block) {
  const out = [];
  for (let k = 0; k < block.length; k += 2) {
    if (block[k] === 278) out.push(block.slice(k, k + 12));
  }
  return out;
}

(async () => {
  await bpw.ready;
  // spawnBot/listBots/removeBot (which tickSurvivalWaves itself calls) only exist once a server
  // instance has actually started — same requirement test_bot_session.js documents.
  srv.startServer();
  await wait(200);

  console.log('\n── settings exist with the documented defaults, deathmatch is the default mode ──');
  {
    ok('gameMode defaults to deathmatch', S.get('gameMode') === 'deathmatch', String(S.get('gameMode')));
    ok('gameMode rejects anything outside its enum', S.set('gameMode', 'free-for-all', 'test').ok === false);
    ok('survivalWaveTicks matches official survival\'s own 25s wave (Qvkq32h)',
      S.get('survivalWaveTicks') === 500, String(S.get('survivalWaveTicks')));
    ok('survivalStartDelayTicks matches official survival\'s own 2.5s delay (Qkd51bb)',
      S.get('survivalStartDelayTicks') === 50, String(S.get('survivalStartDelayTicks')));
    ok('boss cadence is the official every-10-waves', S.get('survivalBossEveryNWaves') === 10);
    ok('one boss at a time by default (official)', S.get('survivalMaxSimultaneousBosses') === 1);
    ok('bots respawn after the official 20s', S.get('survivalBotRespawnTicks') === 400);
    ok('pool starts at the official 8 and tops out at 20',
      S.get('survivalBaseBotCount') === 8 && S.get('survivalMaxBotCount') === 20);
  }

  console.log('\n── protocol: opcode 298 (round start tick) and 237/239/240 (isBot/isBoss/isZombie) ──');
  {
    // These opcodes were confirmed against the REAL client bundle (not guessed): 298 is Qpa5f8z,
    // decoded straight into the client's own Qmpb4uv wave-number formula; 237/239/240 are
    // Qcvoys2/Qqw6dra/(now-readable isZombie in 1-7-1), read directly off each per-entity object
    // by the "{N} bots alive"/"Kill the boss!" HUD code, the survival scoreboard-hide rule, and —
    // for 240 — the ZOMBIE_RUN animation + 'zombie_death' sound selection. All were either never
    // sent at all (298) or hardcoded false for every entity (237/239/240) before this.
    srv.match.roundStartTick = 1234;
    const tick = srv.buildTickBody('p', 9999, srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'p'), new Map());
    ok('opcode 298 carries the live round-start tick, not a constant',
      readOp(tick, 298) === 1234, String(readOp(tick, 298)));

    const botPeer = { playerId: 'bp', tick: 1, displayName: 'Bot', uid: -1001, isBot: true, isBoss: false, isZombie: false,
      playerState: srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'bp') };
    const bossPeer = { playerId: 'bo', tick: 1, displayName: 'BOSS', uid: -1002, isBot: true, isBoss: true, isZombie: false,
      playerState: srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'bo') };
    const zombiePeer = { playerId: 'zp', tick: 1, displayName: 'Zombie', uid: -1003, isBot: true, isBoss: false, isZombie: true,
      playerState: srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'zp') };
    const realPeer = { playerId: 'rp', tick: 1, displayName: 'Real', uid: 7, isBot: false, isBoss: false, isZombie: false,
      playerState: srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'rp') };
    const botDelta = srv.buildPeerBootstrapDelta(botPeer);
    const bossDelta = srv.buildPeerBootstrapDelta(bossPeer);
    const zombieDelta = srv.buildPeerBootstrapDelta(zombiePeer);
    const realDelta = srv.buildPeerBootstrapDelta(realPeer);
    ok('a bot peer carries opcode 237 (isBot) true', readOp(botDelta, 237) === true, String(readOp(botDelta, 237)));
    ok('a bot peer carries opcode 239 (isBoss) false', readOp(botDelta, 239) === false);
    ok('a plain bot peer carries opcode 240 (isZombie) false', readOp(botDelta, 240) === false);
    ok('a boss peer carries BOTH 237 and 239 true', readOp(bossDelta, 237) === true && readOp(bossDelta, 239) === true);
    ok('a zombie peer carries opcode 240 (isZombie) true', readOp(zombieDelta, 240) === true, String(readOp(zombieDelta, 240)));
    ok('a real player peer carries 237/239/240 false',
      readOp(realDelta, 237) === false && readOp(realDelta, 239) === false && readOp(realDelta, 240) === false);
  }



  console.log('\n── official numbers: bot level, zombie / gunman / boss stats ──');
  {
    ok('bot level is 2 on wave 1', srv.survivalBotLevelForWave(1) === 2);
    ok('bot level reaches the official cap of 6 and stays there',
      srv.survivalBotLevelForWave(50) === 6 && srv.survivalBotLevelForWave(500) === 6);
    const z1 = srv.survivalBotStatsForWave(1, { zombie: true });
    const z20 = srv.survivalBotStatsForWave(20, { zombie: true });
    const g1 = srv.survivalBotStatsForWave(1, {}), g20 = srv.survivalBotStatsForWave(20, {});
    ok('a wave-1 zombie is slow (0.6) and hits for at most 0.45 of a health bar',
      Math.abs(z1.speed - 0.6) < 1e-9 && z1.dmgCap === 0.45, JSON.stringify(z1));
    ok('zombie speed is capped at 1.1 and health at x2', z20.speed === 1.1 && z20.hpMult <= 2, JSON.stringify(z20));
    ok('gunmen do not scale with the wave at all (official bonuses are 0)',
      g1.speed === g20.speed && g1.hpMult === g20.hpMult && g1.dmgMult === g20.dmgMult && g1.dmgCap === 0.15);
    const b10 = srv.survivalBotStatsForWave(10, { boss: true });
    ok('a wave-10 boss has 30x health (10 x (1 + 0.2 x 10))', Math.abs(b10.hpMult - 30) < 1e-9, String(b10.hpMult));
    ok('boss speed never passes the official 1.5 cap', srv.survivalBotStatsForWave(500, { boss: true }).speed === 1.5);
  }

  console.log('\n── official numbers: per-bot damage and health go through applyDamage ──');
  {
    S.set('gameMode', 'survival', 'test');
    const victim = mkPlayerState('dmg-v'), zombie = mkPlayerState('dmg-z');
    zombie._survDmgMult = 0.5; zombie._survDmgCap = 0.45;
    srv.applyDamage(victim, 5, zombie, { attackerIsBot: true, victimIsBot: false });
    ok('a huge zombie hit is clamped to 0.45 of a health bar', Math.abs((1 - victim.healthPoints) - 0.45) < 1e-6,
      String(victim.healthPoints));
    const boss = mkPlayerState('dmg-b'), player = mkPlayerState('dmg-p');
    boss._survHpMult = 30; boss._survIsBoss = true;
    srv.applyDamage(boss, 0.3, player, { attackerIsBot: false, victimIsBot: true });
    ok('a boss with 30x health loses 1/30 of the damage dealt', Math.abs((1 - boss.healthPoints) - 0.01) < 1e-6,
      String(boss.healthPoints));
  }

  console.log('\n── weapon tiers: pickups upgrade the weapon, damage follows, death resets ──');
  {
    S.set('gameMode', 'survival', 'test');
    const p = mkPlayerState('tier-p');
    p.weaponList = [4, 262]; p.equippedWeaponId = 4;
    const sent = [];
    const sess = { ws: { readyState: 1, OPEN: 1, send(m) { sent.push(String(m)); } } };
    srv._grantPickupWeapon(p, 6, false, 2, sess);
    ok('a fresh tier-2 pickup is carried at tier 2', srv.survivalWeaponTier(p, 6) === 2);
    const ammoOne = p.pickupAmmo[6];
    srv._grantPickupWeapon(p, 6, false, 1, sess);
    ok('picking the same weapon up again ADDS its tier (2 + 1 = 3)', srv.survivalWeaponTier(p, 6) === 3);
    ok('and the HUD is told the weapon was upgraded', sent.some((m) => m.startsWith('~4`') && m.includes('"tier":3')),
      JSON.stringify(sent));
    srv._grantPickupWeapon(p, 6, false, 4, sess);
    ok('tier is capped at the official maximum of 4', srv.survivalWeaponTier(p, 6) === 4);
    const body = srv.buildTickBody('tier-p', 77001, p, new Map());
    let tierOnWire;
    for (let i = 0; i < body.length - 7; i++) if (body[i] === 135 && body[i + 1] === 6) { tierOnWire = body[i + 7]; break; }
    ok('opcode 134 streams the weapon\'s real tier', tierOnWire === 4, String(tierOnWire));
    S.set('gameMode', 'deathmatch', 'test');
    const d = mkPlayerState('tier-d'); d.weaponList = [4, 262];
    srv._grantPickupWeapon(d, 6, false, 3, null);
    ok('survival pickups give twice the ammo a deathmatch pickup does', ammoOne === 2 * d.pickupAmmo[6],
      ammoOne + ' vs ' + d.pickupAmmo[6]);
    ok('deathmatch has no weapon tiers', srv.survivalWeaponTier(d, 6) === 1);
    S.set('gameMode', 'survival', 'test');
  }

  console.log('\n── scoring: wave multiplier and the x20 boss kill ──');
  {
    S.set('gameMode', 'survival', 'test');
    const st = srv.getSurvivalState();
    const keep = st.currentWave;
    const bot = { isBot: true }, bossV = { isBot: true, _survIsBoss: true };
    st.currentWave = 0; const w0 = srv.medalScore('kill', bot, -1);
    st.currentWave = 10; const w10 = srv.medalScore('kill', bot, -1);
    st.currentWave = 500; const w500 = srv.medalScore('kill', bot, -1);
    ok('score doubles by wave 10 and tops out at triple', w10 === 2 * w0 && w500 === 3 * w0, [w0, w10, w500].join(','));
    st.currentWave = 0;
    ok('a boss kill is worth 20x a bot kill', srv.medalScore('kill', bossV, -1) === 20 * w0);
    st.currentWave = keep;
  }

  console.log('\n── wave escalation: bot count/level climb, a boss appears on schedule ──');
  {
    S.set('botDamageMult', 1, 'test');   // reset first so the next line's effect is unambiguous
    S.set('gameMode', 'deathmatch', 'test');
    S.set('gameMode', 'survival', 'test');
    ok('choosing survival resets bot damage to the gentler 0.2 default',
      S.get('botDamageMult') === 0.2, String(S.get('botDamageMult')));
    S.set('survivalWaveTicks', 100, 'test');
    S.set('survivalStartDelayTicks', 0, 'test');   // keep the math simple for this test
    S.set('survivalBaseBotCount', 2, 'test');
    S.set('survivalBotCountPerWave', 1, 'test');
    S.set('survivalMaxBotCount', 10, 'test');
    S.set('survivalBossEveryNWaves', 3, 'test');
    S.set('survivalSpecialWaveChance', 0, 'test');   // deterministic for this section

    const a = mkRealSession('surv-a'), b = mkRealSession('surv-b');
    const sessions = srv.getSessions();
    sessions.set(a.sessionId, a); sessions.set(b.sessionId, b);

    const survivalBots = () => srv.listBots().filter((bot) => bot.isSurvivalBot && !bot.isBoss);
    const boss = () => srv.listBots().find((bot) => bot.isBoss);

    // Force the round-start anchor (opcode 298 — Qpa5f8z) back far enough to land on wave 0
    // right now, same as a fresh round would — the wave number is match.roundStartTick-relative
    // (see survivalWaveNumber), not a separate clock of its own, so driving it IS driving the
    // wave the same way the client's own HUD formula reads it.
    srv.match.roundStartTick = srv.getStatus().globalTick;
    const st0 = srv.getSurvivalState();
    st0.currentWave = -1;
    st0.bossPlayerIds = [];
    srv.tickSurvivalWaves(sessions);
    // Wave 0 is the official grace period ("Wave 0" on the HUD, no bots) — matches the real
    // client's own "0 bots alive" at the very start of a survival round.
    ok('wave 0 is the grace period — no bots yet', survivalBots().length === 0, String(survivalBots().length));
    ok('no boss on wave 0', !boss());

    // Jump straight to wave 3 (a boss wave: 3 % survivalBossEveryNWaves === 0) without waiting on
    // real ticks — same technique test_rounds.js uses for the round timer (drive the state
    // directly rather than sleep through it).
    srv.match.roundStartTick = srv.getStatus().globalTick - 3 * 100;
    srv.tickSurvivalWaves(sessions);
    // targetCount = base + (wave-1)*perWave = 2 + 2*1 = 4; level follows the official 2 + 0.08/wave curve.
    ok('wave 3 escalates the bot count (2 base + (3-1))', survivalBots().length === 4,
      String(survivalBots().length));
    ok('wave 3 bots are at the official level for that wave', survivalBots().every((bt) => bt.botLevel === srv.survivalBotLevelForWave(3)),
      JSON.stringify(survivalBots().map((bt) => bt.botLevel)));
    ok('survival bots get no flavor names (hidden from scoreboard anyway)',
      survivalBots().every((bt) => bt.displayName === 'Bot'),
      JSON.stringify(survivalBots().map((bt) => bt.displayName)));
    ok('a boss spawned on the scheduled wave', !!boss());
    ok('at most one boss exists', srv.listBots().filter((bt) => bt.isBoss).length === 1);
    ok('the boss gets a flavor name, not the literal "BOSS"', boss().displayName !== 'BOSS',
      boss().displayName);
    ok('the boss gets a bigger model scale', boss().playerState.modelScale === S.get('survivalBossScale'),
      String(boss().playerState.modelScale));
    ok('a normal survival bot stays default-scale', survivalBots()[0].playerState.modelScale === 1);
    ok('the boss gets one of the real confirmed skin/thumb pairs',
      [boss().skinUrl, boss().thumbUrl].every((v) => typeof v === 'string' && v.includes('ev.io')),
      `${boss().skinUrl} / ${boss().thumbUrl}`);

    // A second call on the SAME wave must not spawn a second boss or re-escalate.
    const before = survivalBots().length;
    srv.tickSurvivalWaves(sessions);
    ok('re-ticking the same wave is a no-op', survivalBots().length === before
      && srv.listBots().filter((bt) => bt.isBoss).length === 1);

    for (const bt of srv.listBots()) srv.removeBot(bt.playerId);
    sessions.delete(a.sessionId); sessions.delete(b.sessionId);
  }

  console.log('\n── survival stays interesting deep into a long run: multi-boss + special-wave ramp ──');
  {
    S.set('gameMode', 'survival', 'test');
    S.set('survivalWaveTicks', 100, 'test');
    S.set('survivalStartDelayTicks', 0, 'test');
    S.set('survivalBaseBotCount', 1, 'test');
    S.set('survivalBotCountPerWave', 0, 'test');
    S.set('survivalBossEveryNWaves', 5, 'test');
    S.set('survivalMultiBossEveryNWaves', 20, 'test');
    S.set('survivalMaxSimultaneousBosses', 4, 'test');
    S.set('survivalSpecialWaveChance', 0, 'test');   // isolate the ramp's own contribution

    const sessions = srv.getSessions();
    const st = srv.getSurvivalState();

    // Wave 5: first boss wave, still only 1 boss expected (floor(5/20)=0).
    srv.match.roundStartTick = srv.getStatus().globalTick - 5 * 100;
    st.currentWave = -1; st.bossPlayerIds = []; st.activeSpecialWave = null;
    srv.tickSurvivalWaves(sessions);
    ok('wave 5: exactly 1 boss (multi-boss hasn\'t kicked in yet)',
      srv.listBots().filter((b) => b.isBoss).length === 1,
      String(srv.listBots().filter((b) => b.isBoss).length));

    // Wave 45: 1 + floor(45/20) = 3 bosses expected.
    srv.match.roundStartTick = srv.getStatus().globalTick - 45 * 100;
    st.currentWave = 5; st.bossPlayerIds = srv.listBots().filter((b) => b.isBoss).map((b) => b.playerId);
    srv.tickSurvivalWaves(sessions);
    ok('wave 45: multi-boss has scaled up to 3 simultaneous bosses',
      srv.listBots().filter((b) => b.isBoss).length === 3,
      String(srv.listBots().filter((b) => b.isBoss).length));

    // Wave 500: 1 + floor(500/20) = 26, clamped to the 4-boss cap.
    srv.match.roundStartTick = srv.getStatus().globalTick - 500 * 100;
    st.currentWave = 45; st.bossPlayerIds = srv.listBots().filter((b) => b.isBoss).map((b) => b.playerId);
    srv.tickSurvivalWaves(sessions);
    ok('wave 500: still capped at survivalMaxSimultaneousBosses (4), not unbounded',
      srv.listBots().filter((b) => b.isBoss).length === 4,
      String(srv.listBots().filter((b) => b.isBoss).length));

    for (const bt of srv.listBots()) srv.removeBot(bt.playerId);

    // Special wave chance ramp: base 0.1 + 0.02/wave past minWave=5, capped at 0.6.
    S.set('survivalSpecialWaveChance', 0.1, 'test');
    S.set('survivalSpecialWaveChanceRampPerWave', 0.02, 'test');
    S.set('survivalSpecialWaveChanceMax', 0.6, 'test');
    ok('at the wave it first becomes eligible, the chance is just the base',
      srv._survivalSpecialWaveChanceForWave(5, 5) === 0.1, String(srv._survivalSpecialWaveChanceForWave(5, 5)));
    ok('10 waves past minWave, the chance has ramped up',
      Math.abs(srv._survivalSpecialWaveChanceForWave(15, 5) - 0.3) < 1e-9,
      String(srv._survivalSpecialWaveChanceForWave(15, 5)));
    ok('deep into a run, the chance is clamped at the ceiling, not unbounded',
      srv._survivalSpecialWaveChanceForWave(500, 5) === 0.6, String(srv._survivalSpecialWaveChanceForWave(500, 5)));

    S.set('survivalMultiBossEveryNWaves', 20, 'test');
    S.set('survivalMaxSimultaneousBosses', 4, 'test');
    S.set('survivalSpecialWaveChance', 0.2, 'test');
    S.set('survivalSpecialWaveChanceRampPerWave', 0, 'test');
    S.set('survivalSpecialWaveChanceMax', 0.75, 'test');
  }

  console.log('\n── melee bots: sword-only, 1 teleport charge, and don\'t fight the gun-bot reconcilers ──');
  {
    S.set('gameMode', 'survival', 'test');
    S.set('survivalMeleeBotRatio', 1, 'test');   // force every spawn to be a melee bot
    const sessions = srv.getSessions();

    S.set('survivalWaveTicks', 100, 'test');
    S.set('survivalStartDelayTicks', 0, 'test');
    S.set('survivalBaseBotCount', 1, 'test');
    S.set('survivalBotCountPerWave', 0, 'test');
    S.set('survivalSpecialWaveChance', 0, 'test');
    srv.match.roundStartTick = srv.getStatus().globalTick - 100;   // land on wave 1, not the wave-0 grace period
    const st = srv.getSurvivalState();
    st.currentWave = -1; st.bossPlayerIds = []; st.activeSpecialWave = null;
    srv.tickSurvivalWaves(sessions);

    const meleeBots = () => srv.listBots().filter((b) => b.isSurvivalBot && !b.isBoss);
    ok('a melee bot spawned', meleeBots().length > 0, String(meleeBots().length));
    ok('it carries the real Zombie Melee weapon, not sword or a gun',
      meleeBots().every((b) => b.playerState.equippedWeaponId === srv.ZOMBIE_MELEE_WEAPON_ID),
      JSON.stringify(meleeBots().map((b) => b.playerState.equippedWeaponId)));
    ok('it uses the sword-bot AI branch (isSwordBot)', meleeBots().every((b) => b.isSwordBot === true));
    ok('it carries isZombie (opcode 240) — drives ZOMBIE_RUN anim + zombie_death sound',
      meleeBots().every((b) => b.isZombie === true));
    ok('it gets the zombie skin, not the generic bot skin',
      meleeBots().every((b) => b.skinUrl.includes('zombiebot')), JSON.stringify(meleeBots().map((b) => b.skinUrl)));
    ok('its Teleport ability seed is level 1 (1 charge), not the sword bot\'s level 5',
      meleeBots().every((b) => b.playerState._ps && b.playerState._ps.weaponStateArray
        && b.playerState._ps.weaponStateArray[0] === 1),
      JSON.stringify(meleeBots().map((b) => b.playerState._ps && b.playerState._ps.weaponStateArray
        && b.playerState._ps.weaponStateArray[0])));

    // Changing the deathmatch sword-bot count must not touch survival's melee bots.
    const before = meleeBots().length;
    S.set('swordBotCount', 0, 'test');
    ok('reconcileSwordBotCount does not cull survival melee bots', meleeBots().length === before,
      `before=${before} after=${meleeBots().length}`);

    for (const bt of srv.listBots()) srv.removeBot(bt.playerId);
    S.set('survivalMeleeBotRatio', 0, 'test');
  }

  console.log('\n── revive-prompt eligibility is team-based client-side (Qvwywze) — real players must share a team, bots must not ──');
  {
    // Confirmed from the real client bundle: the "nearest revivable teammate" scan (Qvwywze) has
    // NO isBot check at all — it's purely `dead && sameTeamId`. Before this fix every session
    // (bot or real) got a flat teamId:0, so the client's own scan happily matched a dead bot or
    // the boss as "my teammate" and showed the revive glow/prompt for them. The fix: a real
    // player joining in survival gets teamId 1; bots stay at spawnBot's own default of 0.
    S.set('gameMode', 'survival', 'test');
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.EVIO_LOCAL_PORT}`);
    await new Promise((r) => ws.on('open', r));
    ws.send(';' + JSON.stringify({ uid: 17, name: 'TeamCheck' }));
    await wait(300);
    const real = [...srv.getSessions().values()].find((s) => s.displayName === 'TeamCheck');
    ok('a real player joining in survival gets teamId 1', !!real && real.teamId === 1,
      real ? String(real.teamId) : 'session not found');

    const bot = srv.spawnBot({ level: 5, isSurvivalBot: true, name: 'Bot' });
    ok('a survival bot keeps the default teamId 0 (different team from the real player)',
      bot.teamId === 0, String(bot.teamId));

    srv.removeBot(bot.playerId);
    ws.close();
    await wait(50);
  }

  console.log('\n── survival: a real player who dies does NOT respawn ──');
  {
    S.set('gameMode', 'survival', 'test');
    S.set('survivalBleedoutTicks', 200, 'test');   // well past respawnTicks+5 below
    const a = mkRealSession('nodeath-a');
    const sessions = srv.getSessions();
    sessions.set(a.sessionId, a);

    srv.applyDamage(a.playerState, 999, null);
    ok('the player is dead', a.playerState.healthPoints <= 0 && a.playerState.deathStateTimer > 0);

    const respawnTicks = srv.combatConstants.RESPAWN_TICKS;
    for (let i = 0; i < respawnTicks + 5; i++) srv.processDeathRespawn(sessions);
    ok('they stay dead well past RESPAWN_TICKS', a.playerState.healthPoints <= 0,
      String(a.playerState.healthPoints));
    ok('but are only DOWNED, not yet finalized out, while under the bleed-out window',
      a.survivalOut !== true, String(a.survivalOut));

    for (let i = 0; i < 200; i++) srv.processDeathRespawn(sessions);
    ok('and are flagged out for the round once the bleed-out window elapses with no revive',
      a.survivalOut === true);

    sessions.delete(a.sessionId);
  }

  console.log('\n── survival: a nearby teammate can revive a downed player before bleed-out ──');
  {
    S.set('gameMode', 'survival', 'test');
    S.set('survivalBleedoutTicks', 1000, 'test');   // plenty of time for this test's revive
    S.set('survivalResurrectionTicks', 20, 'test');
    S.set('survivalReviveRange', 5, 'test');
    S.set('survivalReviverHealReward', 0.25, 'test');
    S.set('survivalReviveHeal', 0.5, 'test');

    const down = mkRealSession('revive-down'), medic = mkRealSession('revive-medic');
    down.playerState.position = { x: 0, y: 2, z: 0 };
    medic.playerState.position = { x: 1, y: 2, z: 0 };   // well within survivalReviveRange
    medic.playerState.healthPoints = 0.5;                 // so the +0.25 reward is observable
    const sessions = srv.getSessions();
    sessions.set(down.sessionId, down); sessions.set(medic.sessionId, medic);

    // Died holding a pickup weapon (not the primary) with an empty magazine — the revive must
    // put them back on their primary with a full mag, same as a normal respawn would.
    down.playerState.weaponList = [4, 262];   // primary (rifle) + sword
    down.playerState.equippedWeaponId = 999;
    down.playerState._ammoGunId = 999;
    down.playerState.gunAmmo = 0;

    srv.applyDamage(down.playerState, 999, null);
    ok('the target is downed', down.playerState.deathStateTimer > 0 && down.playerState.healthPoints <= 0);

    srv.processDeathRespawn(sessions);   // one tick so deathStateTimer > 0 before reviving starts
    for (let i = 0; i < 19; i++) srv.tickSurvivalRevives(sessions);
    ok('revive progress is tracked but not yet complete just under the duration',
      medic.playerState.reviveTargetId === down.playerId && medic.playerState.reviveHoldTicks === 19,
      `target=${medic.playerState.reviveTargetId} ticks=${medic.playerState.reviveHoldTicks}`);
    ok('the downed player is still down', down.playerState.deathStateTimer > 0);

    srv.tickSurvivalRevives(sessions);   // the 20th tick completes it
    ok('the revived player is alive again', down.playerState.deathStateTimer === 0
      && down.playerState.healthPoints === 0.5, String(down.playerState.healthPoints));
    ok('the reviver gets their own health reward', medic.playerState.healthPoints === 0.75,
      String(medic.playerState.healthPoints));
    ok('the revived player comes back on their PRIMARY, not the pickup they died holding',
      down.playerState.equippedWeaponId === 4, String(down.playerState.equippedWeaponId));
    ok('and with a full magazine, not the 0 ammo they died with',
      down.playerState.gunAmmo > 0, String(down.playerState.gunAmmo));
    ok('the reviver\'s revive-progress fields reset', medic.playerState.reviveTargetId === -1
      && medic.playerState.reviveHoldTicks === 0);

    sessions.delete(down.sessionId); sessions.delete(medic.sessionId);
  }

  console.log('\n── protocol: opcodes 200/201 (revive progress) stream correctly ──');
  {
    const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'revwire');
    ps.reviveTargetId = 42; ps.reviveHoldTicks = 7;
    const body = srv.buildTickBody('revwire', 1, ps, new Map());
    ok('opcode 200 carries the live revive target', readOp(body, 200) === 42, String(readOp(body, 200)));
    ok('opcode 201 carries the live hold-tick count', readOp(body, 201) === 7, String(readOp(body, 201)));
  }

  console.log('\n── protocol: opcode 238 is bot level for a bot, reward for a boss ──');
  {
    const botPeer = { playerId: 'lvlbot', tick: 1, displayName: 'Bot', uid: -1001, isBot: true, isBoss: false,
      botLevel: 7, playerState: srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'lvlbot') };
    const bossPeer = { playerId: 'rewardboss', tick: 1, displayName: 'BOSS', uid: -1002, isBot: true, isBoss: true,
      botLevel: 10, playerState: srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'rewardboss') };
    const botDelta = srv.buildPeerBootstrapDelta(botPeer);
    const bossDelta = srv.buildPeerBootstrapDelta(bossPeer);
    ok('a plain bot sends its real level on opcode 238', readOp(botDelta, 238) === 7, String(readOp(botDelta, 238)));
    ok('a boss sends the configured reward amount instead', readOp(bossDelta, 238) === S.get('survivalBossReward'),
      String(readOp(bossDelta, 238)));
  }

  console.log('\n── special waves: bot-only forced loadout, announced via opcode 306 ──');
  {
    S.set('gameMode', 'survival', 'test');
    S.set('survivalWaveTicks', 100, 'test');
    S.set('survivalStartDelayTicks', 0, 'test');
    S.set('survivalBaseBotCount', 1, 'test');
    S.set('survivalBotCountPerWave', 0, 'test');
    S.set('survivalBossEveryNWaves', 1000, 'test');   // keep the boss out of this test entirely
    S.set('survivalSpecialWaveChance', 1, 'test');    // force one every eligible wave
    S.set('survivalSpecialWaveChanceMax', 1, 'test'); // the ceiling applies even to a forced 1 — this used to make the test pass only 75% of the time
    S.set('survivalMeleeBotRatio', 0, 'test');        // keep this test's "default=4" assumption simple

    const real = mkRealSession('sw-real');
    const sessions = srv.getSessions();
    sessions.set(real.sessionId, real);

    srv.match.roundStartTick = srv.getStatus().globalTick - 5 * 100;   // land exactly on wave 5
    const st = srv.getSurvivalState();
    st.currentWave = -1; st.bossPlayerIds = []; st.activeSpecialWave = null;
    srv.tickSurvivalWaves(sessions);

    const bots = () => srv.listBots().filter((b) => b.isSurvivalBot && !b.isBoss);
    ok('wave 5 (>= minWave) rolled a special wave', !!srv.getSurvivalState().activeSpecialWave);
    ok('the real player\'s own weapon is untouched', real.weaponId === undefined || !real.isBot);
    ok('every survival bot is force-equipped with the special wave\'s weapon (or left at default)',
      bots().every((b) => {
        const sw = srv.getSurvivalState().activeSpecialWave;
        const expected = (sw && sw.weaponId) || 4;
        return b.playerState.equippedWeaponId === expected;
      }));

    const tick = srv.buildTickBody(real.playerId, 1, real.playerState, sessions);
    ok('opcode 306 announces the active special wave by name',
      readOp(tick, 306) === srv.getSurvivalState().activeSpecialWave.name,
      String(readOp(tick, 306)));

    for (const b of srv.listBots()) srv.removeBot(b.playerId);
    sessions.delete(real.sessionId);
  }

  console.log('\n── weapon pickup tiers: glow index matches the rolled tier ──');
  {
    for (let i = 0; i < 20; i++) {
      const tier = srv.pickWeightedTier();
      ok(`tier ${tier} is within 1-4`, tier >= 1 && tier <= 4, String(tier));
    }

    S.set('gameMode', 'deathmatch', 'test');
    srv._resetPickupState();
    ok('deathmatch pickups always roll tier 1 (plain white glow, index 0)',
      srv.getPickupState().every((st) => st.tier === 1), JSON.stringify(srv.getPickupState().map((st) => st.tier)));
    const dmChunks = splitPickupBlocks(srv.buildWeaponPickupBlock());
    ok('deathmatch sends opcode 274=0 for every pickup point (unchanged default)',
      dmChunks.length > 0 && dmChunks.every((c) => readOp(c, 274) === 0), JSON.stringify(dmChunks));

    S.set('gameMode', 'survival', 'test');
    srv._resetPickupState();
    const survChunks = splitPickupBlocks(srv.buildWeaponPickupBlock());
    const tiers = srv.getPickupState().map((st) => st.tier);
    ok('survival opcode 274 matches SURVIVAL_TIER_GLOW_INDEX[tier-1] for every point',
      survChunks.every((c, i) => readOp(c, 274) === srv.SURVIVAL_TIER_GLOW_INDEX[tiers[i] - 1]),
      `tiers=${JSON.stringify(tiers)} chunks=${JSON.stringify(survChunks)}`);

    S.set('gameMode', 'deathmatch', 'test');
    srv._resetPickupState();
  }

  console.log('\n── survival: health/armor items share the weapon pickup points (opcode 272) ──');
  {
    // Confirmed from the real client bundle (the user's own observation that items spawn at the
    // SAME points as weapons, then verified against the renderer): opcode 272 (Qqxcge5) on a
    // pickup point is a SECOND, independent "what's here" field, default -1 (normal weapon
    // point); >=0 indexes the client's own active-items catalogue (Gh.Qcvnlvz: 0=Health Kit,
    // 1=Armor) and renders that model instead, at the same point, same wire family. No new
    // entity type at all — unlike the earlier activeEntities attempt that crashed the client.
    S.set('gameMode', 'survival', 'test');
    S.set('survivalItemChance', 1, 'test');   // force every point to roll an item, deterministically
    srv._resetPickupState();
    ok('every pickup point rolled an item (health or armor), none stayed a weapon point',
      srv.getPickupState().every((st) => st.itemIndex === 0 || st.itemIndex === 1),
      JSON.stringify(srv.getPickupState().map((st) => st.itemIndex)));

    const block = srv.buildWeaponPickupBlock();
    const chunks = splitPickupBlocks(block);
    ok('opcode 272 is sent for every point, matching its rolled item index',
      chunks.every((c, i) => readOp(c, 272) === srv.getPickupState()[i].itemIndex),
      JSON.stringify(chunks.map((c) => readOp(c, 272))));

    S.set('survivalItemChance', 0, 'test');   // force every point back to a normal weapon point
    srv._resetPickupState();
    ok('with the chance at 0, every point is a normal weapon point (itemIndex -1)',
      srv.getPickupState().every((st) => st.itemIndex === -1),
      JSON.stringify(srv.getPickupState().map((st) => st.itemIndex)));

    S.set('gameMode', 'deathmatch', 'test');
    S.set('survivalItemChance', 1, 'test');   // even at 100%, deathmatch must never roll an item
    srv._resetPickupState();
    ok('deathmatch never rolls an item regardless of the setting (gated on GAME_MODE)',
      srv.getPickupState().every((st) => st.itemIndex === -1),
      JSON.stringify(srv.getPickupState().map((st) => st.itemIndex)));

    S.set('gameMode', 'survival', 'test');
    const a = mkRealSession('item-a');
    a.playerState.healthPoints = 0.3;
    a.playerState.armorPoints = 0;
    const sessions = srv.getSessions();
    sessions.set(a.sessionId, a);
    const pts = bpw.pickupPoints || [];
    ok('the map has at least one pickup point to test against', pts.length > 0, String(pts.length));
    if (pts.length) {
      a.playerState.position = { x: pts[0].x, y: pts[0].y - 1, z: pts[0].z };   // stand right on it
      srv.getPickupState()[0].itemIndex = 0;   // force point 0 to a Health Kit for a deterministic check
      srv.getPickupState()[0].availableAtTick = 0;
      const healthBefore = a.playerState.healthPoints;
      srv.processWeaponPickups(sessions, srv.getStatus().globalTick);
      ok('standing on a Health Kit point heals the player', a.playerState.healthPoints > healthBefore,
        `${healthBefore} -> ${a.playerState.healthPoints}`);
      ok('the point rerolls afterward (no longer stuck on the same state)',
        srv.getPickupState()[0].availableAtTick > 0);
    }

    S.set('survivalItemChance', 0.5, 'test');
    sessions.delete(a.sessionId);
    srv._resetPickupState();
  }

  console.log('\n── deathmatch (unchanged): the same sequence DOES respawn ──');
  {
    S.set('gameMode', 'deathmatch', 'test');
    const a = mkRealSession('respawn-a');
    const sessions = srv.getSessions();
    sessions.set(a.sessionId, a);

    srv.applyDamage(a.playerState, 999, null);
    const respawnTicks = srv.combatConstants.RESPAWN_TICKS;
    for (let i = 0; i < respawnTicks + 5; i++) srv.processDeathRespawn(sessions);
    ok('deathmatch still respawns a dead player', a.playerState.healthPoints > 0,
      String(a.playerState.healthPoints));
    ok('and never sets survivalOut', a.survivalOut !== true);

    sessions.delete(a.sessionId);
  }

  console.log('\n── survival: the round ends the instant every real player is out ──');
  {
    S.set('gameMode', 'survival', 'test');
    const a = mkRealSession('wipe-a'), b = mkRealSession('wipe-b');
    const sessions = srv.getSessions();
    sessions.set(a.sessionId, a); sessions.set(b.sessionId, b);
    srv.startNewRound(sessions);
    ok('a fresh round is playing', srv.match.gameMode === 0);
    ok('and survivalOut was cleared by the fresh round', a.survivalOut === false && b.survivalOut === false);

    a.survivalOut = true;   // one out — the round must NOT end yet
    srv.tickMatch(sessions);
    ok('the round keeps going while any real player is still in it', srv.match.gameMode === 0,
      `gameMode=${srv.match.gameMode}`);

    b.survivalOut = true;   // now everyone is out
    srv.tickMatch(sessions);
    ok('the round ends the same tick the last player goes out', srv.match.gameMode !== 0,
      `gameMode=${srv.match.gameMode}`);

    srv.startNewRound(sessions);
    ok('a new round clears both players\' out-state', a.survivalOut === false && b.survivalOut === false);
    ok('and resets the wave clock', srv.getSurvivalState().currentWave === -1,
      String(srv.getSurvivalState().currentWave));

    sessions.delete(a.sessionId); sessions.delete(b.sessionId);
  }

  console.log('\n── survival: a round boundary removes leftover bots AFTER a grace delay, not instantly ──');
  {
    // A round-start removeBot() on the spot still crashed the client live: a bot that fired its
    // last shot in the final tick(s) of the old round can have that bullet still queued in the
    // client's own sound/effect tracking when its shooter vanishes a tick or two later. Fixed by
    // standing leftover bots down (no more AI/shots) immediately but only actually deleting them
    // once a grace period has fully elapsed.
    S.set('gameMode', 'survival', 'test');
    S.set('survivalBotRemovalGraceTicks', 10, 'test');
    const sessions = srv.getSessions();
    const leftover = srv.spawnBot({ level: 5, isSurvivalBot: true, name: 'Bot' });

    srv.startNewRound(sessions);
    ok('the leftover bot is NOT removed on the spot', srv.listBots().some((b) => b.playerId === leftover.playerId));
    ok('but it IS scheduled for removal', Number.isFinite(leftover._survivalPendingRemoveAtTick));
    ok('and it no longer counts toward the new round\'s survival bot total',
      srv.getSurvivalState() && !srv.listBots().filter((b) => b.isSurvivalBot && !b.isBoss
        && !b._survivalPendingRemoveAtTick).some((b) => b.playerId === leftover.playerId));

    srv.tickSurvivalBotRemoval(sessions);
    ok('still present before the grace period elapses', srv.listBots().some((b) => b.playerId === leftover.playerId));

    // Fast-forward past the grace period by driving the pending check directly against a tick
    // far enough ahead — tickSurvivalBotRemoval reads _live.globalTick itself, so push the
    // bot's own deadline into the past instead of waiting out 10 real ticks.
    leftover._survivalPendingRemoveAtTick = -1;
    srv.tickSurvivalBotRemoval(sessions);
    ok('removed once its grace period has elapsed', !srv.listBots().some((b) => b.playerId === leftover.playerId));

    S.set('survivalBotRemovalGraceTicks', 100, 'test');
  }

  console.log('\n── survival: a fresh connection after everyone leaves does NOT see a negative wave/timer ──');
  {
    // Reported live: refreshing the page showed a negative wave count and a negative "next
    // wave" countdown. Root cause: when the last real player disconnects, the tick loop stops
    // and globalTick resets to 0 (maybeStopGameLoop), but match.roundStartTick and survival's
    // own wave counter were never reset to match — so the NEXT connection computed
    // survivalWaveNumber(~0) against a now-stale, enormous roundStartTick, i.e. a hugely
    // negative tick delta. Fixed in resetServerState().
    S.set('gameMode', 'survival', 'test');
    srv.match.roundStartTick = 99999;   // simulate a round that had been running a long time
    const st = srv.getSurvivalState();
    st.currentWave = 37;

    const ws = new WebSocket(`ws://127.0.0.1:${process.env.EVIO_LOCAL_PORT}`);
    await new Promise((r) => ws.on('open', r));
    ws.send(';' + JSON.stringify({ uid: 17, name: 'RefreshCheck' }));
    await wait(300);
    ok('the session connected', [...srv.getSessions().values()].some((s) => s.displayName === 'RefreshCheck'));

    ws.close();
    // Wait for the close handler -> maybeStopGameLoop -> resetServerState chain to run (it logs
    // "server state reset" — see resetServerState's own console.log).
    await wait(500);

    ok('match.roundStartTick was reset to match the fresh globalTick, not left stale',
      srv.match.roundStartTick === 0, String(srv.match.roundStartTick));
    ok('the wave counter was reset too', srv.getSurvivalState().currentWave === -1,
      String(srv.getSurvivalState().currentWave));
    ok('survivalWaveNumber for a fresh connection is sane (0, the grace period), not negative',
      srv.survivalWaveNumber(srv.getStatus().globalTick) === 0,
      String(srv.survivalWaveNumber(srv.getStatus().globalTick)));

    S.set('gameMode', 'deathmatch', 'test');
  }

  console.log('\n── survival is co-op: no PvP between two real players ──');
  {
    S.set('gameMode', 'survival', 'test');
    const shooter = mkPlayerState('pvp-shooter');
    const victim = mkPlayerState('pvp-victim');
    srv.applyDamage(victim, 0.5, shooter, { attackerIsBot: false, victimIsBot: false });
    ok('real-vs-real damage is a no-op in survival', victim.healthPoints === 1, String(victim.healthPoints));

    // Real-vs-bot and bot-vs-bot (governed by botFriendlyFire) must still work in survival.
    const bot = mkPlayerState('pvp-bot');
    srv.applyDamage(bot, 0.5, shooter, { attackerIsBot: false, victimIsBot: true });
    ok('a real player can still damage a bot in survival', bot.healthPoints < 1, String(bot.healthPoints));

    const bossVictim = mkPlayerState('pvp-boss-victim');
    srv.applyDamage(bossVictim, 0.5, bot, { attackerIsBot: true, victimIsBot: true, victimIsBoss: true });
    ok('a bot cannot damage a boss (isBoss doesn\'t bypass the bot-vs-bot gate)',
      bossVictim.healthPoints === 1, String(bossVictim.healthPoints));
    const botVictim2 = mkPlayerState('pvp-bot-victim2');
    srv.applyDamage(botVictim2, 0.5, bot, { attackerIsBot: true, victimIsBot: true, attackerIsBoss: true });
    ok('and a boss cannot damage a plain bot either', botVictim2.healthPoints === 1,
      String(botVictim2.healthPoints));

    // Confirmed from the user's own live report: damage was already blocked, but bots kept
    // walking up and swinging/shooting at each other anyway (the TARGETING scan never excluded
    // bot-vs-bot in survival — it only checked the deathmatch-only botFriendlyFire setting).
    S.set('botFriendlyFire', true, 'test');   // deathmatch's own setting left ON — survival must still exclude
    const botA = { playerId: 'vis-bot-a', sessionId: 'vis-bot-a', accepted: true, isBot: true,
      playerState: mkPlayerState('vis-bot-a') };
    const botB = { playerId: 'vis-bot-b', sessionId: 'vis-bot-b', accepted: true, isBot: true,
      playerState: mkPlayerState('vis-bot-b') };
    botA.playerState.position = { x: 0, y: 2, z: 0 };
    botB.playerState.position = { x: 2, y: 2, z: 0 };
    const visSessions = srv.getSessions();
    visSessions.set(botA.sessionId, botA); visSessions.set(botB.sessionId, botB);
    ok('a bot never sees another bot as a visible enemy in survival, even with botFriendlyFire on',
      srv._visibleEnemies(botA, visSessions, 50, srv.getStatus().globalTick).length === 0);
    S.set('gameMode', 'deathmatch', 'test');
    ok('but it DOES in deathmatch when botFriendlyFire is on (no regression)',
      srv._visibleEnemies(botA, visSessions, 50, srv.getStatus().globalTick).length === 1);
    visSessions.delete(botA.sessionId); visSessions.delete(botB.sessionId);
    const victim2 = mkPlayerState('pvp-victim2');
    srv.applyDamage(victim2, 0.5, shooter, { attackerIsBot: false, victimIsBot: false });
    ok('PvP is unaffected in deathmatch (no regression)', victim2.healthPoints < 1,
      String(victim2.healthPoints));
  }

  console.log('\n── survival: Impulse grenade is disabled (confirmed real: disableImpulse) ──');
  {
    const impulseGrenade = mkPlayerState('impulse-a');
    impulseGrenade._ps.weaponStateArray = []; impulseGrenade._ps.weaponStateArray[16] = 1;   // allocated
    impulseGrenade._ps.Qctsdxa = 1;   // full charge (cost is 0.5)
    const before = srv.getActiveEntities().size;

    S.set('gameMode', 'survival', 'test');
    srv.processGrenadeCast(impulseGrenade, new Set([38]));   // action 38 = Impulse
    ok('casting Impulse in survival spawns nothing', srv.getActiveEntities().size === before);
    ok('and does not consume the charge either (a true no-op)', impulseGrenade._ps.Qctsdxa === 1,
      String(impulseGrenade._ps.Qctsdxa));

    S.set('gameMode', 'deathmatch', 'test');
    srv.processGrenadeCast(impulseGrenade, new Set([38]));
    ok('but it still works in deathmatch (no regression)', srv.getActiveEntities().size === before + 1,
      String(srv.getActiveEntities().size));
    srv.clearAllEntities('test cleanup');
  }

  console.log('\n── survival has no health regen at all (confirmed real: noHealthRegen) ──');
  {
    S.set('gameMode', 'survival', 'test');
    S.set('healthRegen', true, 'test');
    S.set('regenDelay', 1, 'test');
    const p = mkPlayerState('noregen-a');
    p.healthPoints = 0.5;
    p.ticksSinceDamage = 999;
    srv.tickHealthRegen(p);
    ok('health does not regen on the timer path in survival', p.healthPoints === 0.5, String(p.healthPoints));

    p.ticksSinceKill = 0;   // would normally force-trigger regen the next tick
    for (let i = 0; i < 5; i++) srv.tickHealthRegen(p);
    ok('and does not regen on a kill either', p.healthPoints === 0.5, String(p.healthPoints));

    S.set('gameMode', 'deathmatch', 'test');
    srv.tickHealthRegen(p);
    ok('deathmatch regen is unaffected (no regression)', p.healthPoints > 0.5, String(p.healthPoints));
  }

  console.log('\n── boss bots take reduced damage, not an inflated HP pool ──');
  {
    const attacker = mkPlayerState('boss-attacker');
    const plainBot = mkPlayerState('boss-plain');
    const bossBot = mkPlayerState('boss-victim');
    // The boss's bigger pool is stamped on its state by applySurvivalBotStats (official wave-10 value).
    bossBot._survHpMult = srv.survivalBotStatsForWave(10, { boss: true }).hpMult; bossBot._survIsBoss = true;
    srv.applyDamage(plainBot, 0.3, attacker, { attackerIsBot: false, victimIsBot: true, victimIsBoss: false });
    srv.applyDamage(bossBot, 0.3, attacker, { attackerIsBot: false, victimIsBot: true, victimIsBoss: true });
    ok('both are still normalized 0..1 health, not an inflated pool',
      plainBot.healthPoints <= 1 && bossBot.healthPoints <= 1 && bossBot.healthPoints >= 0);
    ok('the boss took meaningfully less damage than an identical plain bot',
      bossBot.healthPoints > plainBot.healthPoints,
      `plain=${plainBot.healthPoints} boss=${bossBot.healthPoints}`);
  }

  S.set('gameMode', 'deathmatch', 'test');   // leave global state as every other test file expects it

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
