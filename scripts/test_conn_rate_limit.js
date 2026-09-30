/**
 * test_conn_rate_limit.js — a connect/disconnect flood from one address is rate-limited
 * independently of the concurrent-connection cap.
 *
 * WHY THIS EXISTS
 * ────────────────
 * maxConnectionsPerIp bounds how many connections from one address can be OPEN AT ONCE — it does
 * nothing to bound how FAST new ones can be opened. An address that opens and immediately closes a
 * connection thousands of times a second never exceeds that concurrent cap, yet every attempt still
 * pays for a TCP/WS handshake, an O(N) scan of `sessions` (the concurrent-count check itself),
 * session-object allocation and a join-deadline timer — real, avoidable cost on the same shared
 * single-threaded tick loop this project has already found blows its budget when a session pays
 * real cost (see inputBufferMaxCatchup). This test proves the independent rate limiter added for it.
 *
 * Usage:  node scripts/test_conn_rate_limit.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = process.env.EVIO_LOCAL_PORT || '18550';
process.env.EVIO_JOIN_DEADLINE = '0';
process.env.EVIO_MAX_CONN_ATTEMPTS_PER_MIN = '5';   // low, so the test doesn't need thousands of attempts
process.env.EVIO_MAX_CONN_PER_IP = '50';            // high, so the CONCURRENT cap never interferes

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
const URL = `ws://127.0.0.1:${process.env.EVIO_LOCAL_PORT}`;

function connectAndWatch() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL);
    let closeCode = null;
    ws.on('open', () => {
      // Close it ourselves right away — this test is about ATTEMPT rate, not concurrency, so each
      // connection should be short-lived (the flood pattern the limiter exists for).
      setTimeout(() => { try { ws.close(); } catch (_) {} }, 20);
    });
    ws.on('close', (code) => { closeCode = code; resolve({ accepted: true, closeCode: code }); });
    ws.on('error', () => resolve({ accepted: false, closeCode }));
    // A connection the server refuses closes almost immediately with 4007 — distinguish that from a
    // normal accepted-then-we-closed-it round trip by the code.
  });
}

(async () => {
  await bpw.ready;
  srv.startServer();
  await wait(200);

  console.log('\n── the setting is registered with the expected shape ──');
  {
    const e = S.list().find((s) => s.key === 'maxConnAttemptsPerMin');
    ok('maxConnAttemptsPerMin is a setting', !!e);
    ok('it is live (no restart needed)', e && e.live !== false);
  }

  console.log('\n── attempts beyond the per-minute limit are refused with code 4007 ──');
  {
    const limit = Number(process.env.EVIO_MAX_CONN_ATTEMPTS_PER_MIN);
    const results = [];
    // One at a time (not Promise.all) so attempt ORDER is deterministic — the token bucket is
    // consumed in the order attempts actually reach the server.
    for (let i = 0; i < limit + 5; i++) {
      results.push(await connectAndWatch());
    }
    const refused = results.filter((r) => r.closeCode === 4007);
    const notRefused = results.filter((r) => r.closeCode !== 4007);
    ok(`the first ${limit} attempts are NOT refused for rate`, notRefused.length === limit,
      `notRefused=${notRefused.length}, codes=${JSON.stringify(results.map((r) => r.closeCode))}`);
    ok('every attempt beyond the limit IS refused with 4007', refused.length === 5,
      `refused=${refused.length}`);
  }

  console.log('\n── the bucket refills over time, not permanently exhausted ──');
  {
    // At 5/min, tokens refill at ~1 every 12s. Wait long enough for at least one to come back.
    await wait(13000);
    const r = await connectAndWatch();
    ok('a connection attempt after waiting for refill is accepted', r.closeCode !== 4007,
      `closeCode=${r.closeCode}`);
  }

  console.log('\n── a DIFFERENT source is unaffected by another address\'s flood ──');
  {
    // Every connection in this test process comes from 127.0.0.1, so there is no independent second
    // address to actually dial from here — asserted instead via source inspection, matching this
    // project's established pattern for protocol facts that cannot be driven end-to-end from a
    // single-machine test harness (see e.g. test_bot_profile.js's LOS-offset probing rationale).
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    ok('the bucket is keyed per-IP (a Map, not a single global counter)',
      /_connAttempts\.get\(ip\)/.test(src) && /const _connAttempts = new Map/.test(src));
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
