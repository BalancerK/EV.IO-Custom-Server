/**
 * test_ability_ui.js — the ability bar, a loadout change and the reload bar, against official.
 *
 * The client draws the ability bar from the player's own abilityBuild (opcode 93,
 * abilitiesUI.refreshAbilityIcons) and only lets an ability be cast when abilityBuild[id] > 0
 * (playerCanUseAbility). It redraws the bar only when lastTickBuildChange (194) changes. Official
 * (EU capture, 2026-11-26) sends the guest its default build [1,2,0,2,1,0,0,0,1,1,0,0,0,1,0,0,1,0,0];
 * we sent [] because the client leaves the build out of its join when it is the default, so the
 * bar was empty and no ability worked client-side. A mid-match build change kept 194 at -9999999
 * and never redrew. lastWeaponReloadDuration (152) is set to the reload length (official 57 for
 * the Auto Rifle) — the reload bar shows while reloadTimer === it — and we kept it at -9999.
 *
 * Usage:  node scripts/test_ability_ui.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_CLICK_TO_PLAY = '0';
const srv = require('../local_ws_server');
const { buildFirstSpawnBody, buildLoadoutDelta } = require('../state_builder');
const { DEFAULT_ABILITY_BUILD } = require('../ability_stats');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const field = (body, op, from = 0) => { const i = body.indexOf(op, from); return i < 0 ? undefined : body[i + 1]; };
// First 244 block of a body (the player's own entity).
const playerBlock = (body) => { const i = body.indexOf(244); return body.slice(i); };
const OFFICIAL_DEFAULT = '1,2,0,2,1,0,0,0,1,1,0,0,0,1,0,0,1,0,0';

console.log('\n── opcode 93: the player\'s own build ──');
{
  const b = playerBlock(buildFirstSpawnBody({ playerId: 'me' }));
  const v = field(b, 93);
  ok('no build in the join → the default build (official guest capture)', Array.isArray(v) && v.join(',') === OFFICIAL_DEFAULT, JSON.stringify(v));
  ok('it is a copy, not the frozen constant', v !== DEFAULT_ABILITY_BUILD && !Object.isFrozen(v));
  const seed = [3, 1, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0];
  ok('a build in the join is sent as it is', field(playerBlock(buildFirstSpawnBody({ playerId: 'me', abilitySeed: seed })), 93) === seed);
  ok('a peer\'s view gets [] (official getGameStateDiff)', JSON.stringify(field(playerBlock(buildFirstSpawnBody({ playerId: 'p', abilitySeed: seed, peer: true })), 93)) === '[]');
  const peerDelta = srv.buildPeerBootstrapDelta({ playerId: 'p2', abilitySeed: seed, playerState: srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'p2') });
  ok('the peer bootstrap block sends [] for someone else\'s build', JSON.stringify(field(peerDelta, 93)) === '[]', JSON.stringify(field(peerDelta, 93)));
}

console.log('\n── a build changed mid-match reaches the ability bar ──');
{
  const d = buildLoadoutDelta({ playerId: 'me', abilitySeed: [], buildChangeTick: 4321, clan: 'https://x/c.png' });
  ok('loadout delta with no build carries the default build', field(d, 93).join(',') === OFFICIAL_DEFAULT);
  ok('loadout delta carries lastTickBuildChange (194) = the tick of the change', field(d, 194) === 4321);
  const last135 = d.lastIndexOf(135), i194 = d.indexOf(194), i235 = d.indexOf(235);
  ok('in the client\'s decode order: weapon slots < 194 < 235', last135 < i194 && i194 < i235, `${last135} ${i194} ${i235}`);
  ok('no 194 when no change tick is known', buildLoadoutDelta({ playerId: 'me' }).indexOf(194) < 0);

  const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'me');
  const session = { playerId: 'me', weaponId: 4, abilitySeed: null };
  srv._live.globalTick = 777;
  const build = [2, 2, 0, 2, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 0, 0, 1, 0, 0];
  srv.handleLoadoutRpc(session, ps, '`7`' + JSON.stringify(JSON.stringify(build)));
  ok('RPC 7 records the change tick', session.buildChangeTick === 777, String(session.buildChangeTick));
  ok('the 19-long client build is kept whole', session.abilitySeed.length === 19, String(session.abilitySeed.length));
  const body = [280, 0];
  srv.flushLoadoutDelta(session, ps, body);
  ok('the flushed delta sends the new build and 194 = 777', field(body, 93).join(',') === build.join(',') && field(body, 194) === 777);
  srv._live.globalTick = 900;
  srv.handleLoadoutRpc(session, ps, '`7`' + JSON.stringify(JSON.stringify(build)));
  ok('the same build again does not move the change tick', session.buildChangeTick === 777);
}

console.log('\n── opcode 152: the reload bar ──');
{
  const p = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'r');
  // what a join without a build is given (local_ws_server join path)
  const stats = require('../ability_stats').computeWeaponStats(DEFAULT_ABILITY_BUILD);
  // only the stats object is read by the reload code (a bare state has no physics state yet)
  p._ps = { Qz8l93a: stats };
  let b = []; srv.appendPlayerTickBody(b, 'r', p);
  ok('before any reload: -9999 (client default)', field(b, 152) === -9999, String(field(b, 152)));
  Object.assign(p, { equippedWeaponId: 4, _ammoGunId: 4, gunAmmo: 0, reloadTicks: 0, fireCooldown: 0,
    deathStateTimer: 0, healthPoints: 1, heldActions: new Set() });
  srv.preTickFire(p, []);
  b = []; srv.appendPlayerTickBody(b, 'r', p);
  ok('a reload sets it to the reload length', p.reloadTicks > 0 && field(b, 152) === p.reloadTicks, `${field(b, 152)} / ${p.reloadTicks}`);
  ok('on the first reload tick reloadTimer (130) === 152, which is when the bar shows', field(b, 130) === field(b, 152));
  ok('Auto Rifle with the default build: 57 ticks, as official', field(b, 152) === 57, String(field(b, 152)));
  const i151 = b.indexOf(151), i152 = b.indexOf(152), i155 = b.indexOf(155);
  ok('emitted in decode order (151 < 152 < 155)', i151 < i152 && i152 < i155);
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
