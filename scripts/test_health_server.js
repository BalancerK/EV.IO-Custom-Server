/**
 * test_health_server.js — the public /healthz endpoint.
 *
 * Uses a FAKE `game` object (same pattern as test_admin_page.js) rather than a real running
 * server, so each scenario (healthy / draining / stalled tick loop / a broken getStatus()) is
 * exact and deterministic instead of depending on real timing.
 *
 * The one thing this test exists specifically to guard: the response must NOT leak anything a
 * public, unauthenticated endpoint shouldn't carry — session IDs, IPs, positions, names. Proven by
 * putting a real-looking IP in the fake status and asserting it never appears in the response body,
 * not just by the handler "happening" not to reference the players array.
 *
 * Usage:  node scripts/test_health_server.js
 */
'use strict';

const http = require('http');
const path = require('path');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

process.env.EVIO_HEALTH_HOST = '127.0.0.1';
process.env.EVIO_HEALTH_PORT = '18196';
const health = require(path.join(__dirname, '..', 'health_server.js'));
const URL = 'http://127.0.0.1:18196';

const SENSITIVE_IP = '203.0.113.42'; // TEST-NET-3, never a real address — safe to search for

function fakeGame(statusOverrides) {
  return {
    getStatus: () => ({
      uptimeMs: 123456, playerCount: 2, map: 'HUT8Bishop', tickRate: 19.9, targetTickRate: 20,
      tickErrors: 0, tickOverruns: 0, draining: false,
      // Deliberately included so the leak-check below has something real to catch, matching how
      // getStatus() actually shapes player data for the admin dashboard.
      players: [{ sessionId: 'local-abc123', remoteIp: SENSITIVE_IP, name: 'RealPlayerName' }],
      ...statusOverrides,
    }),
  };
}

function get(path) {
  return new Promise((resolve, reject) => {
    // agent: false — each request gets its own socket rather than pooling through the shared
    // global agent. This file restarts the server on the SAME port between every scenario; a
    // pooled keep-alive socket from a PREVIOUS server instance surfaces as an ECONNRESET on the
    // next request otherwise, which is test plumbing, not the thing being tested.
    http.get(URL + path, { agent: false }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
}

(async () => {
  let server;

  console.log('\n── healthy: tick loop running, not draining ──');
  {
    server = health.startHealthServer(fakeGame({ tickRate: 19.9, draining: false }));
    await new Promise((r) => server.once('listening', r));
    const res = await get('/healthz');
    ok('200 OK', res.status === 200, String(res.status));
    const j = JSON.parse(res.body);
    ok('ok: true', j.ok === true);
    ok('carries the safe summary fields', j.playerCount === 2 && j.map === 'HUT8Bishop'
      && j.tickRate === 19.9, JSON.stringify(j));
    await new Promise((r) => server.close(r));
  }

  console.log('\n── draining (SIGTERM received, mid-shutdown): 503, not 200 ──');
  {
    server = health.startHealthServer(fakeGame({ draining: true }));
    await new Promise((r) => server.once('listening', r));
    const res = await get('/healthz');
    ok('503', res.status === 503, String(res.status));
    const j = JSON.parse(res.body);
    ok('ok: false, draining: true (a monitor can tell WHY, not just that it is down)',
      j.ok === false && j.draining === true, JSON.stringify(j));
    await new Promise((r) => server.close(r));
  }

  console.log('\n── stalled tick loop (process alive, but not actually ticking): 503 ──');
  {
    // This is the failure mode a plain "is the port open" check can never catch — the process is
    // up and accepting TCP connections, but the game itself is dead. Exactly what this endpoint
    // exists to detect that journalctl-only monitoring misses without someone actively watching.
    server = health.startHealthServer(fakeGame({ tickRate: 0, draining: false }));
    await new Promise((r) => server.once('listening', r));
    const res = await get('/healthz');
    ok('503', res.status === 503, String(res.status));
    ok('ok: false', JSON.parse(res.body).ok === false);
    await new Promise((r) => server.close(r));
  }

  console.log('\n── a broken getStatus() reports unhealthy, does not crash the endpoint itself ──');
  {
    server = health.startHealthServer({ getStatus: () => { throw new Error('boom'); } });
    await new Promise((r) => server.once('listening', r));
    const res = await get('/healthz');
    ok('503, not a hang or a raw stack trace', res.status === 503, String(res.status));
    ok('response is still valid JSON', (() => { try { JSON.parse(res.body); return true; } catch (_) { return false; } })());
    await new Promise((r) => server.close(r));
  }

  console.log('\n── the response never leaks per-player data ──');
  {
    server = health.startHealthServer(fakeGame({}));
    await new Promise((r) => server.once('listening', r));
    const res = await get('/healthz');
    ok('no player IP anywhere in the body', !res.body.includes(SENSITIVE_IP), res.body);
    ok('no session id anywhere in the body', !res.body.includes('local-abc123'), res.body);
    ok('no player name anywhere in the body', !res.body.includes('RealPlayerName'), res.body);
    const j = JSON.parse(res.body);
    ok('no "players" key at all — not just an empty one', !('players' in j), JSON.stringify(j));
    await new Promise((r) => server.close(r));
  }

  console.log('\n── anything else (wrong path or method) is 404, no write endpoints exist ──');
  {
    server = health.startHealthServer(fakeGame({}));
    await new Promise((r) => server.once('listening', r));
    const res1 = await get('/api/status'); // the admin server's path — must NOT also work here
    ok('an admin-shaped path 404s', res1.status === 404, String(res1.status));
    const res2 = await get('/');
    ok('the bare root 404s (no dashboard page served here)', res2.status === 404, String(res2.status));
    await new Promise((r) => server.close(r));
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
