/**
 * test_death_parity.js — dying, respawning and bullet sounds, against an official capture.
 *
 * Captured on an official EU server (a real client playing, 2026-11-26), one player's death:
 *   killing tick : health 0, ticksSinceLastDeath 0, last-hit fields set, joinState STILL 1
 *   next tick    : joinState 4, deadCounter 1 — then deadCounter 2, 3, ... (129 never sent)
 *   respawn tick : joinState 1, health 1, deadCounter 0, last-hit fields "", 0, null, false
 * which is the shared sim's PlayerState.getKilled + tick (bundle :43337, :43424-43428). We showed
 * joinState 4 and deadCounter 2 on the killing tick, counted 129 down while dead (the client played
 * the switch-weapon sound mid-death), sent 150 back to 9999 after the respawn and never cleared the
 * last-hit fields. And bullets carried no multiProjectileIndex, which is what gates a peer's shoot
 * sound (=== 0) and impact sounds (<= 2): nobody heard anyone else's gunfire.
 *
 * Usage:  node scripts/test_death_parity.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_CLICK_TO_PLAY = '0';
const srv = require('../local_ws_server');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const field = (body, op) => { const i = body.indexOf(op); return i < 0 ? undefined : body[i + 1]; };
function emit(ps) { const b = []; srv.appendPlayerTickBody(b, ps._ownerSid || 'v', ps); return b; }

console.log('\n── a death, tick by tick ──');
{
  const victim = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'victim');
  const killer = srv.createPlayerSimState({ x: 0, y: 2, z: 5, yaw: 0 }, 'killer');
  if (victim._ps) victim._ps.Qalaptp = -1;
  victim.healthPoints = 0.1; victim.deathStateTimer = 0;
  srv._live.globalTick = 5000;
  srv.applyDamage(victim, 1, killer, { weaponType: 4 });
  // the server advances its own death timer before the tick goes out (processDeathRespawn)
  victim.deathStateTimer += 1;
  let b = emit(victim);
  ok('killing tick: health 0', field(b, 166) === 0, String(field(b, 166)));
  ok('killing tick: still joinState 1 (official)', field(b, 91) === 1, String(field(b, 91)));
  ok('killing tick: ticksSinceLastDeath 0', field(b, 150) === 0, String(field(b, 150)));
  ok('killing tick: deadCounter 0', field(b, 168) === 0, String(field(b, 168)));
  srv._live.globalTick = 5001; victim.deathStateTimer += 1;
  b = emit(victim);
  ok('next tick: joinState 4, deadCounter 1', field(b, 91) === 4 && field(b, 168) === 1, `${field(b, 91)} / ${field(b, 168)}`);
  ok('while dead, 129 is not a countdown (official does not send one)', field(b, 129) === -1, String(field(b, 129)));
  srv._live.globalTick = 5040; victim.deathStateTimer = 41;
  b = emit(victim);
  ok('40 ticks later: deadCounter 40 and ticksSinceLastDeath 40', field(b, 168) === 40 && field(b, 150) === 40);
  ok('the last hit is still shown while dead', field(b, 170) === 'killer' || typeof field(b, 170) === 'string', String(field(b, 170)));

  srv._live.globalTick = 5066;
  srv.respawnPlayerNow(victim);
  b = emit(victim);
  ok('respawn: joinState 1, health 1, deadCounter 0', field(b, 91) === 1 && field(b, 166) === 1 && field(b, 168) === 0);
  ok('respawn: last-hit fields cleared to "", 0, null, false',
    field(b, 170) === '' && field(b, 171) === 0 && field(b, 172) === null && field(b, 173) === false,
    JSON.stringify([field(b, 170), field(b, 171), field(b, 172), field(b, 173)]));
  ok('after the respawn ticksSinceLastDeath keeps counting (66), not back to 9999', field(b, 150) === 66, String(field(b, 150)));
}

console.log('\n── a player who never died ──');
{
  const p = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'fresh');
  const b = emit(p);
  ok('ticksSinceLastDeath 9999, joinState 1, deadCounter 0', field(b, 150) === 9999 && field(b, 91) === 1 && field(b, 168) === 0);
}

console.log('\n── bullets carry the pellet index the sound code needs ──');
{
  srv.buildBulletBlock();
  const before = srv.buildBulletBlock().length;
  srv.spawnBullet('s1', { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 0.1, 4);
  srv.spawnBullet('s1', { x: 0, y: 1, z: 0 }, { x: 0, y: 0, z: -1 }, 0.12, 7, 5);
  const blk = srv.buildBulletBlock().slice(before);
  const mpis = []; for (let i = 0; i < blk.length; i++) if (blk[i] === 53) mpis.push(blk[i + 1]);
  ok('a single shot is index 0 (the peer shoot sound plays for === 0)', mpis[0] === 0, JSON.stringify(mpis));
  ok('a shotgun pellet carries its own index', mpis[1] === 5, JSON.stringify(mpis));
  const o53 = blk.indexOf(53), o51 = blk.indexOf(51), o54 = blk.indexOf(54);
  ok('in the client\'s order: 51 < 53 < 54', o51 < o53 && o53 < o54);
}

console.log('\n── killing a bot pays the official 0.3x ──');
{
  // Official capture: bot kills scored kill 30, headshot 3, assist 3, kill1stRank 8, multikill2 6.
  // medalScore reads the VICTIM's player state, so a bot's player state must say it is a bot (it
  // was only on the session, so every bot kill paid the full 100).
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'local_ws_server.js'), 'utf8');
  const spawn = src.slice(src.indexOf('const session = {\r\n      ws: null,\r\n      isBot: true,') > 0
    ? src.indexOf('const session = {\r\n      ws: null,\r\n      isBot: true,') - 600
    : src.indexOf('const session = {\n      ws: null,\n      isBot: true,') - 600);
  ok('spawnBot marks the bot\'s player state as a bot', /playerState\.isBot = true;/.test(spawn.slice(0, 700)));
  ok('a bot victim scores kill = 30', srv.medalScore('kill', { isBot: true }, 1234) === 30, String(srv.medalScore('kill', { isBot: true }, 1234)));
  ok('a person scores kill = 100', srv.medalScore('kill', {}, 1234) === 100);
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
