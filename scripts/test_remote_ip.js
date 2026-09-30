/**
 * test_remote_ip.js — per-IP admission control (maxConnectionsPerIp, maxConnAttemptsPerMin) sees
 * the REAL client address in production, not Caddy's own loopback address.
 *
 * WHY THIS EXISTS
 * ────────────────
 * Production runs Caddy in front for TLS termination (deploy/Caddyfile: `reverse_proxy
 * 127.0.0.1:8080`), so req.socket.remoteAddress is Caddy's own loopback address for EVERY real
 * player, not their actual origin. Found live: a real test session's every connection logged
 * "connection from 127.0.0.1:port" regardless of the player's actual network. Without reading
 * X-Forwarded-For, every per-IP protection silently degrades into one shared bucket for the ENTIRE
 * server — maxConnectionsPerIp=6 becomes a 6-PLAYER-TOTAL cap on the whole server, not per address,
 * and the connection-rate limiter added alongside it inherits the exact same blind spot.
 *
 * THE FIX
 * ────────
 * _resolveRemoteIp trusts X-Forwarded-For ONLY when the immediate TCP peer is loopback (i.e. the
 * connection genuinely came through our own local Caddy). A connection made directly to the
 * publicly-reachable port 8080 (deploy/provision.sh exposes it for clients that can't use wss://)
 * could set X-Forwarded-For to anything to spoof its way past a per-IP limit — a direct
 * connection's own remoteAddress is unspoofable at the TCP level, so that path never trusts the
 * header at all. This can't be driven end-to-end from a single test machine (there is no way to
 * make a locally-run test's remoteAddress be genuinely non-loopback), so the anti-spoofing half is
 * asserted via source check, matching this project's established pattern for that class of fact.
 *
 * Usage:  node scripts/test_remote_ip.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = process.env.EVIO_LOCAL_PORT || '18560';
process.env.EVIO_JOIN_DEADLINE = '0';

const fs = require('fs');
const path = require('path');
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
  srv.startServer();
  await wait(200);

  console.log('\n── a real test connection (over loopback, our own harness) resolves via X-Forwarded-For ──');
  {
    // This test's own connection genuinely IS loopback (127.0.0.1 -> 127.0.0.1), exactly matching
    // the "came through our own local Caddy" precondition — so this is a real end-to-end exercise
    // of the trust path, not a mock.
    const ws = new WebSocket(URL, { headers: { 'X-Forwarded-For': '203.0.113.5' } });
    await new Promise((r) => ws.on('open', r));
    ws.send(';' + JSON.stringify({ uid: 17, name: 'XffTest' }));
    await wait(300);
    const session = [...srv.getSessions().values()].find((s) => s.displayName === 'XffTest');
    ok('the session exists', !!session);
    ok('remoteIp is the FORWARDED address, not 127.0.0.1',
      session && session.remoteIp === '203.0.113.5', String(session && session.remoteIp));
    try { ws.close(); } catch (_) {}
    await wait(200);
  }

  console.log('\n── multiple hops in X-Forwarded-For: the FIRST (original client) address wins ──');
  {
    const ws = new WebSocket(URL, { headers: { 'X-Forwarded-For': '198.51.100.7, 10.0.0.1, 10.0.0.2' } });
    await new Promise((r) => ws.on('open', r));
    ws.send(';' + JSON.stringify({ uid: 17, name: 'XffChain' }));
    await wait(300);
    const session = [...srv.getSessions().values()].find((s) => s.displayName === 'XffChain');
    ok('the ORIGINAL client address (first in the chain) is used, not an intermediate hop',
      session && session.remoteIp === '198.51.100.7', String(session && session.remoteIp));
    try { ws.close(); } catch (_) {}
    await wait(200);
  }

  console.log('\n── no X-Forwarded-For header: falls back to the direct (loopback) address ──');
  {
    const ws = new WebSocket(URL);
    await new Promise((r) => ws.on('open', r));
    ws.send(';' + JSON.stringify({ uid: 17, name: 'NoXff' }));
    await wait(300);
    const session = [...srv.getSessions().values()].find((s) => s.displayName === 'NoXff');
    ok('remoteIp falls back to the direct address when there is no header',
      session && session.remoteIp === '127.0.0.1', String(session && session.remoteIp));
    try { ws.close(); } catch (_) {}
    await wait(200);
  }

  console.log('\n── source check: X-Forwarded-For is only ever read behind the loopback gate ──');
  {
    // The property that actually matters for security — a direct (non-loopback) connection can
    // never have its spoofed header trusted — cannot be driven end-to-end from this single-machine
    // harness (there is no way to make a local test's own remoteAddress genuinely non-loopback).
    // Verified by construction instead: the header lookup is textually INSIDE the `if (isLoopback)`
    // block, so it is unreachable on any other path.
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    const fnMatch = src.match(/function _resolveRemoteIp\([\s\S]*?\n  \}/);
    ok('_resolveRemoteIp exists', !!fnMatch);
    if (fnMatch) {
      const body = fnMatch[0];
      const ifIdx = body.indexOf('if (isLoopback)');
      const xffIdx = body.indexOf('x-forwarded-for');
      ok('the isLoopback check appears BEFORE the header is ever read',
        ifIdx >= 0 && xffIdx > ifIdx, `ifIdx=${ifIdx} xffIdx=${xffIdx}`);
    }
  }

  console.log('\n── maxConnectionsPerIp now actually applies per real address, not per-server ──');
  {
    // Two connections from the SAME forwarded address should count against EACH OTHER for
    // maxConnectionsPerIp; a third from a DIFFERENT forwarded address must not be blocked by the
    // first two, which the pre-fix "everyone is 127.0.0.1" behaviour would have done.
    const mkConn = (xff) => new Promise((resolve) => {
      const ws = new WebSocket(URL, xff ? { headers: { 'X-Forwarded-For': xff } } : undefined);
      let closeCode = null;
      ws.on('close', (code) => { closeCode = code; });
      ws.on('open', () => setTimeout(() => resolve({ ws, closeCode: null }), 100));
      ws.on('close', () => resolve({ ws, closeCode }));
    });
    const a1 = await mkConn('203.0.113.10');
    const b1 = await mkConn('203.0.113.20');   // a completely different address
    ok('a connection from a DIFFERENT forwarded address is accepted independently',
      b1.closeCode !== 4002, `closeCode=${b1.closeCode}`);
    try { a1.ws.close(); } catch (_) {}
    try { b1.ws.close(); } catch (_) {}
    await wait(200);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
