/**
 * test_survival_official.js — the parts of the official-numbers survival switch that need a live
 * server instance: a wave's bots really carry that wave's stats, a dead bot waits the official
 * 20s and rejoins, a dead boss is removed instead of respawning, and trip mines do nothing to a
 * boss (survivalParams.tripMinesKillBosses = false).
 *
 * Usage:  node scripts/test_survival_official.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = process.env.EVIO_LOCAL_PORT || '18477';
process.env.EVIO_JOIN_DEADLINE = '0';
process.env.EVIO_CLICK_TO_PLAY = process.env.EVIO_CLICK_TO_PLAY || '0';

const S = require('../settings');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

(async () => {
  await bpw.ready;
  srv.startServer();
  await new Promise((r) => setTimeout(r, 200));
  S.set('gameMode', 'survival', 'test');
  S.set('survivalWaveTicks', 100, 'test');
  S.set('survivalStartDelayTicks', 0, 'test');
  S.set('survivalBaseBotCount', 3, 'test');
  S.set('survivalBotCountPerWave', 0, 'test');
  S.set('survivalSpecialWaveChance', 0, 'test');
  S.set('survivalBossEveryNWaves', 10, 'test');
  const sessions = srv.getSessions();
  const real = {
    sessionId: 'off-real', playerId: 'off-real', accepted: true, displayName: 'r', uid: 7, isBot: false,
    playerState: srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'off-real'),
    ws: { readyState: 1, OPEN: 1, send() {} },
    inputQueue: [],
  };
  real.playerState._ownerSid = 'off-real';
  sessions.set(real.sessionId, real);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // Bots get their physics state on their first simulated tick; the survival hook then finishes
  // their loadout — give the live loop a moment and run the hook once more to be deterministic.
  const settle = async () => { await wait(300); srv.tickSurvivalWaves(sessions); };
  const jump = (wave, zombieRatio) => {
    S.set('survivalMeleeBotRatio', zombieRatio, 'test');
    for (const b of srv.listBots()) srv.removeBot(b.playerId);
    srv.match.roundStartTick = srv.getStatus().globalTick - wave * 100;
    const st = srv.getSurvivalState();
    st.currentWave = -1; st.bossPlayerIds = []; st.activeSpecialWave = null;
    srv.tickSurvivalWaves(sessions);
  };
  // The live loop grants fresh bots spawn protection, which applyDamage honours — clear it the
  // way it would expire on its own, then land the damage.
  const unprotect = (b) => { if (b.playerState._ps) b.playerState._ps.Qalaptp = -1; };
  const kill = (b) => { unprotect(b); srv.applyDamage(b.playerState, 99999, null); };
  const horde = () => srv.listBots().filter((b) => b.isSurvivalBot && !b.isBoss);
  const boss = () => srv.listBots().find((b) => b.isBoss);

  console.log('\n── a zombie wave: every bot is a zombie carrying that wave\'s stats ──');
  jump(4, 1); await settle();
  const want = srv.survivalBotStatsForWave(4, { zombie: true });
  ok('the whole wave is zombies, never mixed', horde().length === 3 && horde().every((b) => b.isZombie));
  ok('each one is stamped with the wave-4 zombie damage and health',
    horde().every((b) => b.playerState._survDmgMult === want.dmgMult && b.playerState._survHpMult === want.hpMult
      && b.playerState._survDmgCap === 0.45));
  ok('and moves at 0.9 of its base walk speed (0.5 + 0.1 x 4)',
    horde().every((b) => Math.abs(b.playerState._ps.Qz8l93a.Q6o3kdb - b._survBaseSpeed.walk * 0.9) < 1e-9),
    JSON.stringify(horde().map((b) => b.playerState._ps.Qz8l93a.Q6o3kdb)));
  const walkBefore = horde()[0].playerState._ps.Qz8l93a.Q6o3kdb;
  srv.getSurvivalState().currentWave = 3;           // re-run the same wave boundary
  srv.tickSurvivalWaves(sessions); await settle();
  ok('re-applying a wave does not compound the speed scale',
    Math.abs(horde()[0].playerState._ps.Qz8l93a.Q6o3kdb - walkBefore) < 1e-9);

  console.log('\n── a gunman wave ──');
  jump(4, 0); await settle();
  ok('the whole wave is gunmen', horde().length === 3 && horde().every((b) => !b.isZombie && b.playerState.equippedWeaponId === 4));
  ok('with the official flat 0.3 damage and 0.15 per-hit ceiling',
    horde().every((b) => b.playerState._survDmgMult === 0.3 && b.playerState._survDmgCap === 0.15));

  console.log('\n── a dead bot waits the official 20s, then rejoins as the current wave\'s kind ──');
  {
    const b = horde()[0];
    kill(b);
    b.playerState.deathStateTimer = 100;
    srv.processDeathRespawn(sessions);
    ok('still down well before 20s', b.playerState.deathStateTimer > 0 && b.playerState.healthPoints <= 0);
    b.playerState.deathStateTimer = S.get('survivalBotRespawnTicks');
    srv.processDeathRespawn(sessions);
    ok('back up once the delay has passed', b.playerState.deathStateTimer <= 0 && b.playerState.healthPoints > 0);
    ok('the pool size is unchanged', horde().length === 3);

    S.set('survivalMeleeBotRatio', 1, 'test');
    srv.getSurvivalState().waveIsZombie = true;      // the wave has since turned to zombies
    const g = horde().find((x) => !x.isZombie);
    kill(g);
    g.playerState.deathStateTimer = S.get('survivalBotRespawnTicks');
    srv.processDeathRespawn(sessions);
    ok('a gunman killed during a zombie wave is replaced by a zombie',
      !srv.listBots().includes(g) && horde().length === 3 && horde().filter((x) => x.isZombie).length === 1,
      'zombies=' + horde().filter((x) => x.isZombie).length);
  }

  console.log('\n── boss: official health, removed on death, immune to trip mines ──');
  jump(10, 0); await settle();
  {
    const bs = boss();
    ok('a boss spawns on wave 10', !!bs);
    ok('with 30x health', bs && Math.abs(bs.playerState._survHpMult - 30) < 1e-9, bs && String(bs.playerState._survHpMult));
    bs.playerState.position = { x: 50, y: 2, z: 50 }; unprotect(bs);
    const hp0 = bs.playerState.healthPoints;
    srv.applyExplosionDamage({ x: 50, y: 3, z: 50 }, 100, 10, 'off-real', 176, sessions);
    ok('a trip mine on top of it does no damage', bs.playerState.healthPoints === hp0, String(bs.playerState.healthPoints));
    srv.applyExplosionDamage({ x: 50, y: 3, z: 50 }, 100, 10, 'off-real', 46, sessions);
    ok('an HE grenade still does', bs.playerState.healthPoints < hp0, String(bs.playerState.healthPoints));
    kill(bs);
    srv.processDeathRespawn(sessions);
    ok('a dead boss is scheduled for removal, not respawned', !!bs._survivalPendingRemoveAtTick);
    bs.playerState.deathStateTimer = 5000;
    srv.processDeathRespawn(sessions);
    ok('and stays dead however long it lies there', bs.playerState.healthPoints <= 0);
  }

  console.log('\n── Teleporters special wave raises the Teleport ability, and it is undone after ──');
  {
    jump(4, 1); await settle();
    const z = horde()[0];
    const baseTp = z.playerState._ps.weaponStateArray[0];
    const st = srv.getSurvivalState();
    st.activeSpecialWave = { name: 'Teleporters', weaponId: null, abilityLevels: { 0: 3 } };
    st.currentWave = 3;
    S.set('survivalSpecialWaveChance', 0, 'test');
    // Re-run only the loadout step the wave tick performs for every bot.
    for (const b of horde()) srv.getLiveHooks().setBotAbilityLevels(b, st.activeSpecialWave.abilityLevels);
    ok('Teleport goes to level 3 for the wave', z.playerState._ps.weaponStateArray[0] === 3, String(z.playerState._ps.weaponStateArray[0]));
    for (const b of horde()) srv.getLiveHooks().setBotAbilityLevels(b, null);
    ok('and back to the bot\'s own level afterwards', z.playerState._ps.weaponStateArray[0] === baseTp);
  }

  for (const b of srv.listBots()) srv.removeBot(b.playerId);
  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
