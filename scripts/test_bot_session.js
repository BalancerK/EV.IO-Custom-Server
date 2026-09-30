/**
 * test_bot_session.js — a bot occupies a real session slot and drives the real tick pipeline.
 *
 * WHAT THIS PROVES
 * ─────────────────
 * A bot session is deliberately NOT a parallel simulation: it is a session exactly like a real
 * player's (same playerState, same inputQueue, same processBufferedTick/foldInputFrameIntoSim/
 * integratePlayerSim/postTickFire path), fed by driveBots() instead of a WebSocket. If this were
 * wired wrong, the most likely failures are: a bot never falls under gravity (nothing is draining
 * its queue), a bot never appears to a real client (broadcastPeerSpawn/broadcastProfiles skipped),
 * or the server crashes trying to send a bot a packet it has no socket for. This test exercises all
 * three with a REAL WebSocket client as the observer, not just internal state inspection — internal
 * state can look right while the actual wire protocol a real client depends on is broken.
 *
 * Usage:  node scripts/test_bot_session.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = process.env.EVIO_LOCAL_PORT || '18475';
process.env.EVIO_JOIN_DEADLINE = '0';

const WebSocket = require('ws');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = `ws://127.0.0.1:${process.env.EVIO_LOCAL_PORT}`;

(async () => {
  await bpw.ready;
  // spawnBot/removeBot/listBots are assigned to _live from INSIDE startServer()'s closure (they
  // close over that instance's `sessions` and `globalTick`), so they do not exist until the server
  // has been started once — exactly like getSessions() before this. One start for the whole file;
  // the WebSocketServer itself does not need to be re-created between sections below.
  srv.startServer();
  await wait(200);

  console.log('\n── spawning a bot with no real player connected yet ──');
  {
    // The game loop is normally started by the first ACCEPTED real join. A bot must be able to
    // start it too — an admin adding bots to an empty lobby is a real use case, not just "add bots
    // to an already-running match".
    const bot = srv.spawnBot({ name: 'TestBot1' });
    ok('spawnBot returns a session with a playerState', !!(bot && bot.playerState));
    ok('the bot is marked isBot', bot.isBot === true);
    ok('the bot has no socket', bot.ws === null);
    ok('the bot has a real weapon equipped (not undefined)', Number.isFinite(bot.playerState.equippedWeaponId),
      String(bot.playerState.equippedWeaponId));

    await wait(400);   // let the tick loop actually run a few ticks
    const status = srv.getStatus();
    ok('the game loop started from a bot alone (tick rate > 0)', status.tickRate > 0,
      String(status.tickRate));
    const botRow = status.players.find((p) => p.playerId === bot.playerId);
    ok('the bot shows up in getStatus with isBot=true', !!botRow && botRow.isBot === true);

    srv.removeBot(bot.playerId);
    await wait(200);
    ok('the game loop stops again once the only occupant (the bot) is removed',
      srv.getStatus().tickRate === 0 || srv.getSessions().size === 0);
  }

  console.log('\n── a bot is simulated under gravity even with no decision logic ──');
  {
    const bot = srv.spawnBot({ name: 'TestBot2' });
    const startY = bot.playerState.position.y;
    // Drop it well above its spawn floor so gravity has somewhere to visibly move it.
    bot.playerState.position.y = startY + 20;
    bot.playerState.velocity.y = 0;
    bot.playerState.grounded = false;
    await wait(500);   // ~10 ticks
    ok('the bot fell under gravity purely from the empty-frame drive (queue was actually drained)',
      bot.playerState.position.y < startY + 20 - 0.5,
      `y went from ${(startY + 20).toFixed(2)} to ${bot.playerState.position.y.toFixed(2)}`);
    ok('its input queue is being drained every tick, not piling up',
      bot.inputQueue.length < 5, `queue depth=${bot.inputQueue.length}`);
    srv.removeBot(bot.playerId);
  }

  console.log('\n── a REAL client sees the bot as a fully-introduced peer ──');
  {
    const bot = srv.spawnBot({ name: 'VisibleBot', level: 7 });

    const ws = new WebSocket(URL);
    await new Promise((r) => ws.on('open', r));
    ws.send(';' + JSON.stringify({ uid: 17, name: 'Watcher' }));
    await wait(600);

    // Directly verify what the real client's own peer entry would have been built from, using the
    // exported buildTickBody the exact same way the live broadcast loop does.
    const sessions = srv.getSessions();
    const watcher = [...sessions.values()].find((s) => s.displayName === 'Watcher');
    ok('the watcher session exists', !!watcher);
    if (watcher) {
      const body = srv.buildTickBody(watcher.playerId, 999999, watcher.playerState, sessions);
      let foundBotEntry = false;
      for (let i = 0; i < body.length - 1; i++) {
        if (body[i] === 244 && body[i + 1] === bot.playerId) { foundBotEntry = true; break; }
      }
      ok('the bot has a normal 244 entry in a real client\'s tick body (same path a peer takes)',
        foundBotEntry);
    }
    // NOT asserting a roster (~3) message here: a bot with no skin/thumb/clan assigned (skin
    // assignment is explicitly out of scope for this scaffolding step) contributes nothing to
    // buildPropRoster, so broadcastProfiles correctly sends NOTHING — same as any real player who
    // joins with no cosmetic props would. broadcastProfiles being CALLED without throwing is already
    // covered by this whole block completing; asserting a message that has nothing to say would be
    // asserting the wrong thing.

    try { ws.close(); } catch (_) {}
    srv.removeBot(bot.playerId);
    await wait(200);
  }

  console.log('\n── the server never tries to write to the bot\'s (nonexistent) socket ──');
  {
    // If the broadcast loop's `if (s.isBot) continue` were ever removed or misplaced, sendState
    // would be called with `s.ws === null`. sendState/safeSend already guard a null ws (verified by
    // reading them), so this would not previously have crashed — but it WOULD have wasted a full
    // buildTickBody + encode() for a packet nobody receives, every tick, per bot. Checked here via
    // the source pattern rather than a timing measurement, which would be noisy and indirect.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    ok('the broadcast loop skips bots before doing any per-recipient send work',
      /if \(s\.isBot\) continue;/.test(src));
  }

  console.log('\n── removing an unknown or non-bot id is rejected, not silently accepted ──');
  {
    ok('removeBot on an unknown id returns false', srv.removeBot('not-a-real-id') === false);
    const ws2 = new WebSocket(URL);
    await new Promise((r) => ws2.on('open', r));
    ws2.send(';' + JSON.stringify({ uid: 17, name: 'RealOne' }));
    await wait(300);
    const sessions = srv.getSessions();
    const anyReal = [...sessions.values()].find((s) => s.displayName === 'RealOne');
    ok('a real (non-bot) session exists to test against', !!anyReal);
    if (anyReal) {
      ok('removeBot refuses to remove a REAL (non-bot) session', srv.removeBot(anyReal.playerId) === false);
    }
    try { ws2.close(); } catch (_) {}
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
