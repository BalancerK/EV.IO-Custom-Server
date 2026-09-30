/**
 * test_rpc_backpressure.js — the RPC reply that unblocks a client's chat/ping never sits behind an
 * unbounded amount of already-queued state data.
 *
 * REPORTED SYMPTOM
 * ─────────────────
 * A player on a real degraded connection (250-400ms, packet loss) showed a ~6000ms "ping" and
 * couldn't even send chat, while a 36ms player was unaffected. Root cause: the client's displayed
 * ping and its chat ack both travel as a backtick-RPC reply (handleBacktickRpc), sent via a plain,
 * unconditional safeSend — it MUST always send (the client's sendEvent queue is SERIAL; an
 * unanswered RPC blocks every later one). WebSocket delivers over ONE ordered TCP stream, so that
 * tiny reply queues BEHIND whatever state data is already sitting in the socket's send buffer. At
 * the old default (256 KiB, sendBufferSkipBytes), a degraded connection could have dozens of tick
 * bodies already queued before the reply could even begin to leave the server — measured as multi-
 * second "ping" and an unusable chat, not real network RTT.
 *
 * THE FIX
 * ────────
 * sendBufferSkipBytes lowered from 256 KiB to 16 KiB (~16x sooner reaction), bounding how much can
 * ever be queued ahead of an RPC reply. sendBufferMaxTicks lowered from 200 (10s) to 100 (5s) to
 * match — a connection stuck at the (now much lower) limit is given up on sooner. Lowered AGAIN to
 * 8 KiB after a genuinely long-haul connection (real ~300-400ms RTT) still saw its own ping spike to
 * ~1300ms — 16 KiB was still a meaningful chunk of that on top of real distance.
 *
 * This does NOT fix a connection whose sustained real throughput is below what steady-state play
 * needs (nothing server-side can) — it fixes the server's OWN contribution: piling seconds of
 * backlog onto a connection before reacting to it being stuck.
 *
 * Usage:  node scripts/test_rpc_backpressure.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = process.env.EVIO_LOCAL_PORT || '18540';
process.env.EVIO_JOIN_DEADLINE = '0';

const fs = require('fs');
const path = require('path');
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

(async () => {
  await bpw.ready;

  console.log('\n── the new defaults are the safer, measured values ──');
  {
    const skip = S.list().find((s) => s.key === 'sendBufferSkipBytes');
    const maxT = S.list().find((s) => s.key === 'sendBufferMaxTicks');
    ok('sendBufferSkipBytes now defaults to 8 KiB, not the old 256 KiB (or the once-lowered 16 KiB)',
      skip && skip.default === 8192, String(skip && skip.default));
    ok('sendBufferMaxTicks now defaults to 100 ticks (5s), not the old 200 (10s)',
      maxT && maxT.default === 100, String(maxT && maxT.default));
  }

  console.log('\n── source check: the RPC reply path has NO backpressure gate (by protocol necessity) ──');
  {
    // This MUST stay true — the client's sendEvent queue is serial, so skipping an RPC reply the way
    // a routine state packet can be skipped would permanently wedge every later chat/ping/loadout
    // RPC from that client, not just delay one. This test exists so that invariant is asserted
    // explicitly rather than silently relied upon — if someone "fixes" congestion by making RPC
    // replies skippable too, this is the assertion that should catch it.
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    const fnMatch = src.match(/function handleBacktickRpc\([\s\S]*?\n\}/);
    ok('handleBacktickRpc exists', !!fnMatch);
    if (fnMatch) {
      const body = fnMatch[0];
      ok('it sends its reply unconditionally (no bufferedAmount / backpressure check inside it)',
        !/bufferedAmount|SEND_BUFFER_SKIP/.test(body));
      ok('it does call safeSend with the reply', /safeSend\(ws, ["'`]/.test(body));
    }
  }

  console.log('\n── live: with the OLD default, a chat ack would queue behind a much larger backlog ──');
  {
    // Not re-testing the skip/close MECHANISM itself — test_connection_robustness.js already covers
    // that thoroughly with its own overridden threshold. This proves the QUANTITATIVE claim: at the
    // new default, the worst amount of already-queued state data a reply can ever be stuck behind is
    // bounded far lower than before. Simulated via a fake ws whose bufferedAmount we control, exactly
    // like test_connection_robustness.js's established pattern for this.
    srv.startServer();
    await wait(200);
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.EVIO_LOCAL_PORT}`);
    await new Promise((r) => ws.on('open', r));
    ws.send(';' + JSON.stringify({ uid: 17, name: 'Backpressured' }));
    await wait(300);
    const session = [...srv.getSessions().values()].find((s) => s.displayName === 'Backpressured');
    ok('the session exists', !!session);

    if (session) {
      const skipBytes = S.get('sendBufferSkipBytes');
      // Simulate a connection that is exactly AT the new threshold — the worst case the new default
      // ever tolerates before it starts skipping (and therefore before it stops adding MORE ahead of
      // a future RPC reply).
      const fakeWs = { bufferedAmount: skipBytes + 1, readyState: 1, OPEN: 1, close: () => {} };
      const realWs = session.ws;
      session.ws = fakeWs;
      await wait(150);   // a few ticks
      session.ws = realWs;
      ok(`the skip engages at the NEW, much lower threshold (${skipBytes} bytes, not 262144)`,
        (session._backpressureSkips || 0) > 0, `skips=${session._backpressureSkips}`);
    }
    try { ws.close(); } catch (_) {}
    await wait(200);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
