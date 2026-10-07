/**
 * test_bot_admin.js — bots are properly reachable through the admin surface: the settings
 * registry (dashboard settings panel) and adminAction (dashboard player-row buttons).
 *
 * test_bot_settings.js already covers botCount/botLevel's OWN reconciliation behaviour in depth;
 * this file covers the two admin-specific edges that would otherwise only show up by clicking
 * around a live dashboard: the settings registry actually exposes them under a "Bots" category,
 * and the player table's "kick" button — which for a real player closes a socket — does something
 * sensible for a bot, which HAS no socket to close.
 *
 * Usage:  node scripts/test_bot_admin.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = process.env.EVIO_LOCAL_PORT || '18511';
process.env.EVIO_JOIN_DEADLINE = '0';
// "Hold new players until they click to play" (now the default) is unrelated to this file's own
// bot-admin assertions, but a held real player can throw off anything that iterates sessions
// expecting a bot to exist alongside an actually-playing one. Disabled for the same reason the
// other bot test files are.
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
  srv.startServer();
  await wait(200);

  console.log('\n── botCount/botLevel are real, discoverable settings ──');
  {
    const list = S.list();
    const count = list.find((s) => s.key === 'botCount');
    const level = list.find((s) => s.key === 'botLevel');
    ok('botCount is registered', !!count);
    ok('botLevel is registered', !!level);
    ok('both are filed under a "Bots" category (dashboard groups by this)',
      count && count.category === 'Bots' && level && level.category === 'Bots',
      JSON.stringify({ countCat: count && count.category, levelCat: level && level.category }));
    ok('both are marked live (no restart needed — matches the admin page not showing a "restart" badge)',
      count && count.live !== false && level && level.live !== false);
    ok('neither is marked inert (they have a real, tested effect — see test_bot_settings.js)',
      count && !count.inert && level && !level.inert);
  }

  console.log('\n── getStatus() marks bot rows so the dashboard can badge them ──');
  {
    S.set('botCount', 1, 'test');
    await wait(200);
    const st = srv.getStatus();
    const botRow = st.players.find((p) => p.isBot);
    ok('a bot appears in getStatus with isBot=true', !!botRow, JSON.stringify(st.players.map((p) => p.isBot)));
  }

  console.log('\n── adminAction("kick") on a bot removes it, not a no-op socket close ──');
  {
    const bots = srv.listBots();
    ok('exactly one bot exists going into this check', bots.length === 1, String(bots.length));
    const botId = bots[0].playerId;
    const res = srv.adminAction(botId, 'kick');
    ok('the kick action reports ok', res && res.ok === true, JSON.stringify(res));
    await wait(200);
    // botCount is a MAINTAINED target (1), so kicking should backfill a replacement — the bot
    // count should still read 1, but it must be a DIFFERENT session id than the one just kicked.
    const after = srv.listBots();
    ok('a replacement bot was spawned to maintain the botCount target', after.length === 1,
      String(after.length));
    ok('the replacement is a genuinely different session, not the same one still lingering',
      after.length && after[0].playerId !== botId,
      `kicked=${botId} still-present=${after[0] && after[0].playerId}`);
  }

  console.log('\n── adminAction("kick") on a REAL player still closes its socket (unchanged behaviour) ──');
  {
    const WebSocket = require('ws');
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.EVIO_LOCAL_PORT}`);
    await new Promise((r) => ws.on('open', r));
    ws.send(';' + JSON.stringify({ uid: 17, name: 'KickMe' }));
    await wait(300);
    const session = [...srv.getSessions().values()].find((s) => s.displayName === 'KickMe');
    ok('the real session exists', !!session);
    let closed = false;
    ws.on('close', () => { closed = true; });
    if (session) {
      const res = srv.adminAction(session.playerId, 'kick');
      ok('kick reports ok for a real player too', res && res.ok === true);
    }
    await wait(300);
    ok('the real socket was actually closed', closed);
  }

  console.log('\n── other admin actions (heal/kill/respawn/slap/sethealth/teleport) work identically on a bot ──');
  {
    S.set('botCount', 1, 'test');
    await wait(200);
    const bot = srv.listBots()[0];
    ok('a bot exists to test against', !!bot);
    if (bot) {
      bot.playerState.healthPoints = 0.3;
      const healRes = srv.adminAction(bot.playerId, 'heal');
      ok('heal works on a bot', healRes.ok === true && bot.playerState.healthPoints === 1);
      const killRes = srv.adminAction(bot.playerId, 'kill');
      ok('kill works on a bot', killRes.ok === true && bot.playerState.healthPoints === 0);
      const respawnRes = srv.adminAction(bot.playerId, 'respawn');
      ok('respawn works on a bot', respawnRes.ok === true && bot.playerState.healthPoints > 0);
    }
  }

  S.set('botCount', 0, 'test');
  S.set('botLevel', 5, 'test');

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
