/**
 * test_socket_limits.js — the game port faces the internet, so a client is untrusted input.
 *
 * None of this existed: unlimited connections, 100 MiB frames (the `ws` default), unlimited message
 * rate, and no way to notice a connection that died without closing. That last one is not even an
 * attack — a closed laptop or a phone losing signal leaves the socket open from the server's side
 * for ever, because `close` never fires for a silently dropped TCP connection, so the session keeps
 * its player slot and its scoreboard row indefinitely.
 *
 * These tests connect over a REAL socket rather than poking the limiter functions, because the
 * point is whether the running server refuses a bad client, not whether a helper returns true.
 *
 * Usage:  node scripts/test_socket_limits.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = '18310';
process.env.EVIO_MAX_PLAYERS = '3';
process.env.EVIO_MAX_CONN_PER_IP = '2';
process.env.EVIO_MAX_MSG_PER_SEC = '25';
process.env.EVIO_MAX_PAYLOAD = '4096';
process.env.EVIO_HEARTBEAT_SEC = '1';
process.env.EVIO_JOIN_DEADLINE = '1';

const WebSocket = require('ws');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

const URL = 'ws://127.0.0.1:18310';
// Open a socket and report how it ended: 'open' | close code | 'error'.
// `join` sends the join message, as a real client does within a second of connecting. Without it a
// socket held longer than the join deadline is legitimately closed with 4004, which would make every
// other assertion in this file report a timeout instead of what it is testing.
function connect(hold = 300, join = true) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    let settled = false;
    const done = (how) => { if (!settled) { settled = true; resolve({ how, ws }); } };
    ws.on('open', () => {
      if (join) { try { ws.send(';{"uid":17,"name":"Guest1234"}'); } catch (_) {} }
      setTimeout(() => done('open'), hold);
    });
    ws.on('close', (code) => done(code));
    ws.on('error', () => done('error'));
    setTimeout(() => done('timeout'), hold + 2000);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await bpw.ready;
  srv.startServer();
  await wait(400);

  const open = [];
  console.log('\n── connections are capped ──');
  {
    // maxConnectionsPerIp is 2 and every connection here is from 127.0.0.1, so the third is
    // refused by the per-IP rule before the global cap is even reached.
    const a = await connect(1200); open.push(a.ws);
    const b = await connect(1200); open.push(b.ws);
    ok('first two connections are accepted', a.how === 'open' && b.how === 'open',
      `${a.how} / ${b.how}`);
    const c = await connect(600);
    ok('a third from the same address is refused', c.how === 4002,
      `close code ${c.how} (expected 4002)`);

    // Release them before the next sections, or those connections would themselves be refused by
    // the per-IP cap and every later assertion would see 4002 instead of what it is testing.
    for (const ws of open) { try { ws.close(); } catch (_) {} }
    open.length = 0;
    await wait(400);
  }

  console.log('\n── an oversized frame does not get allocated ──');
  {
    // ws enforces maxPayload itself and closes with 1009 (message too big). Without it the server
    // would happily allocate whatever a hostile client claimed to send.
    const r = await new Promise((resolve) => {
      const ws = new WebSocket(URL);
      ws.on('open', () => ws.send(Buffer.alloc(64 * 1024)));   // 64 KiB vs the 4 KiB cap
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => resolve('error'));
      setTimeout(() => resolve('stayed open'), 2500);
    });
    ok('an over-cap frame closes the connection', r === 1009 || r === 'error',
      `got ${r} — 1009 is "message too big"`);
  }

  console.log('\n── a flood is disconnected, not silently dropped ──');
  {
    // Silently discarding input would look like an unexplained desync to a legitimate client that
    // burst; a clean close is diagnosable.
    const r = await new Promise((resolve) => {
      const ws = new WebSocket(URL);
      ws.on('open', () => { for (let i = 0; i < 200; i++) ws.send('#PING#'); });
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => resolve('error'));
      setTimeout(() => resolve('stayed open'), 2500);
    });
    ok('exceeding the message rate closes the connection', r === 4003 || r === 'error',
      `got ${r} (expected 4003)`);
  }

  for (const ws of open) { try { ws.close(); } catch (_) {} }
  await wait(300);

  console.log('\n── a dead connection is reaped ──');
  {
    // Simulate a peer that vanished without closing: stop answering pings. The heartbeat must
    // notice and terminate, freeing the player slot.
    const ws = new WebSocket(URL);
    await new Promise((r) => ws.on('open', r));
    ws.pong = () => {};                       // never answer another ping
    ws._receiver.removeAllListeners('ping');
    ws.on('ping', () => {});                  // swallow it — no automatic pong
    const before = srv.getStatus().playerCount;
    const closed = await new Promise((resolve) => {
      ws.on('close', () => resolve(true));
      setTimeout(() => resolve(false), 6000);  // heartbeat is 1s, so two rounds is plenty
    });
    ok('the server terminates a connection that stops answering', closed,
      `still connected after 6s (players before=${before})`);
  }

  console.log('\n── a connection that never joins does not keep a player slot ──');
  {
    // maxPlayers counts SESSIONS, and a session exists from the moment the socket opens — so a client
    // that connects and stays silent occupies a slot indefinitely. The heartbeat cannot reap it: the
    // connection is genuinely alive and answers pings, it just never says who it is. Without a
    // deadline, maxConnectionsPerIp from four addresses fills a 24-slot server with zero players and
    // nothing in the logs looks wrong.
    const r = await new Promise((resolve) => {
      const ws = new WebSocket(URL);
      ws.on('close', (code) => resolve(code));
      ws.on('error', () => resolve('error'));
      setTimeout(() => resolve('still holding a slot'), 4000);   // deadline is 1s in this run
    });
    ok('a silent connection is closed', r === 4004 || r === 'error',
      `got ${r} — 4004 is "join timeout"`);
  }

  console.log('\n── ...but joining clears the deadline ──');
  {
    // The deadline must not kill a player who joined and then went quiet — that is the backgrounded
    // tab case, which is handled by idle simulation, not by disconnection.
    const r = await new Promise((resolve) => {
      const ws = new WebSocket(URL);
      ws.on('open', () => ws.send(';{"uid":17,"name":"Guest1234"}'));
      ws.on('close', (code) => resolve(`closed ${code}`));
      ws.on('error', () => resolve('error'));
      setTimeout(() => { try { ws.close(); } catch (_) {} resolve('stayed open'); }, 3500);
    });
    ok('a joined connection survives well past the deadline', r === 'stayed open', String(r));
  }

  console.log('\n── the limits are configurable, and payload is restart-only ──');
  {
    const S = require('../settings');
    const get = (k) => S.list().find((x) => x.key === k);
    ok('maxPlayers is live-editable', get('maxPlayers').live === true);
    ok('maxMessagesPerSec is live-editable', get('maxMessagesPerSec').live === true);
    ok('maxPayloadBytes is NOT live', get('maxPayloadBytes').live === false,
      'it is applied when the socket is constructed');
    ok('heartbeat can be disabled', get('heartbeatSeconds').min === 0);
    ok('the join deadline is configurable', !!get('joinDeadlineSeconds'));
    ok('and can be disabled', get('joinDeadlineSeconds').min === 0);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
