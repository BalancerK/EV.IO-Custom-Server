/**
 * test_graceful_shutdown.js — SIGTERM used to just process.exit(0) immediately, dropping every
 * connected player mid-match with zero warning on every single deploy. beginGracefulShutdown
 * (wired to SIGTERM; SIGINT/Ctrl+C stays immediate for fast local dev) instead: stops accepting new
 * joins, announces the restart to whoever's connected, and gives them up to drainGraceSeconds to
 * leave naturally before exiting anyway.
 *
 * Runs against a REAL srv.startServer() with REAL ws clients (same pattern as
 * test_admin_controls.js), not mocks — the one thing that can't be real is process.exit itself,
 * which would tear down the test runner; _setExitImplForTest injects a stand-in for exactly that.
 *
 * Usage:  node scripts/test_graceful_shutdown.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = '18390';
process.env.EVIO_JOIN_DEADLINE = '0';

const WebSocket = require('ws');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const S = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = 'ws://127.0.0.1:18390';

function join(name) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    const chat = [];
    ws.on('message', (buf) => {
      const s = buf.toString('utf8');
      if (s.startsWith('~0`')) { try { chat.push(JSON.parse(s.slice(3))); } catch (_) {} }
    });
    ws.on('open', () => {
      ws.send(';' + JSON.stringify({ uid: 17, name }));
      resolve({ ws, chat });
    });
  });
}

(async () => {
  await bpw.ready;
  srv.startServer();
  await wait(300);

  // Never let a real process.exit fire during this file — every path below is captured instead.
  let exitCalled = false, exitCode = null;
  srv._setExitImplForTest((code) => { exitCalled = true; exitCode = code; });
  const resetExit = () => { exitCalled = false; exitCode = null; };

  console.log('\n── no players connected: exits immediately regardless of the grace period ──');
  {
    S.set('drainGraceSeconds', 20, 'test');
    resetExit();
    srv.beginGracefulShutdown();
    ok('exited with code 0', exitCalled && exitCode === 0);
    srv._resetDrainStateForTest();
  }

  console.log('\n── with a player connected: does not exit immediately, and announces the restart ──');
  {
    S.set('drainGraceSeconds', 5, 'test');
    const { ws, chat } = await join('Drainee');
    await wait(400);
    ok('one player connected', [...srv.getSessions().values()].filter((s) => s && s.playerState).length === 1);

    resetExit();
    srv.beginGracefulShutdown();
    ok('does not exit immediately with a player still connected', !exitCalled);

    await wait(200);
    ok('announced the restart to the connected player',
      chat.some((c) => /restarting/i.test(c.msg || '')), JSON.stringify(chat));

    console.log('\n── a new connection attempt while draining is refused with close code 4008 ──');
    const closeInfo = await new Promise((resolve) => {
      const ws2 = new WebSocket(URL);
      ws2.on('close', (code, reasonBuf) => resolve({ code, reason: reasonBuf.toString() }));
    });
    ok('new join refused with 4008 ("server restarting")', closeInfo.code === 4008, JSON.stringify(closeInfo));

    ws.close();
    await wait(1300); // poll interval is 1000ms
    ok('exits once the last player leaves, before the 5s grace period would have elapsed', exitCalled);
    srv._resetDrainStateForTest();
  }

  console.log('\n── grace period elapses with a player still connected: exits anyway ──');
  {
    S.set('drainGraceSeconds', 1, 'test');
    const { ws } = await join('Stays');
    await wait(400);
    resetExit();
    srv.beginGracefulShutdown();
    ok('not exited yet', !exitCalled);
    await wait(1500); // 1s grace + buffer
    ok('exited after the grace period elapsed even though the player never left', exitCalled);
    ws.close();
    srv._resetDrainStateForTest();
  }

  console.log('\n── drainGraceSeconds=0 skips the wait even with a player connected ──');
  {
    S.set('drainGraceSeconds', 0, 'test');
    const { ws } = await join('Zero');
    await wait(400);
    resetExit();
    srv.beginGracefulShutdown();
    ok('exits immediately when the grace period is 0', exitCalled);
    ws.close();
    srv._resetDrainStateForTest();
  }

  console.log('\n── a second call while already draining is a no-op (no duplicate announcement) ──');
  {
    S.set('drainGraceSeconds', 5, 'test');
    const { ws, chat } = await join('Idempotent');
    await wait(400);
    resetExit();
    srv.beginGracefulShutdown();
    await wait(200);
    const firstCount = chat.length;
    srv.beginGracefulShutdown(); // second "SIGTERM" while already draining
    await wait(200);
    ok('a second call does not send a second announcement', chat.length === firstCount,
      `${firstCount} -> ${chat.length}`);
    ws.close();
    await wait(1300);
    ok('still eventually exits once the player leaves', exitCalled);
    srv._resetDrainStateForTest();
  }

  S.set('drainGraceSeconds', 20, 'test'); // restore the default
  srv._setExitImplForTest(null); // restore the real process.exit for anything that runs after this file

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
