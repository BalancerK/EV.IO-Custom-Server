/**
 * test_browser_lobby.js
 *
 * Headless Playwright test that connects the public ev.io client to our
 * custom server and verifies the lobby loads without the Qt03jhz crash.
 *
 * Root cause of the crash (now fixed):
 *   Server was sending echoClientTick=0 before any client input arrived.
 *   Reconciler (Qak2r7y) reads Qxo2o14[0].Qt03jhz.
 *   On localhost the bootstrap packet arrives before the first render frame
 *   fills Qxo2o14[0] → "Cannot read properties of undefined (reading 'Qt03jhz')".
 *
 * Fix: server now sends echoClientTick=-1 (the official server sentinel meaning
 *      "no client tick to reconcile") when no input has been received yet.
 *
 * Pass conditions:
 *   1. Server receives at least one connection from the browser
 *   2. No "Qt03jhz" error in the browser console within BOOT_WAIT_MS
 *   3. The page is still alive (title is "ev.io")
 *
 * Usage:
 *   node scripts/test_browser_lobby.js
 *
 * Environment variables:
 *   EVIO_TEST_PORT     — server port (default 18091)
 *   EVIO_BOOT_WAIT_MS  — ms to watch for crashes after connect (default 6000)
 *   EVIO_HEADLESS_SHOW — set to "1" to show the browser window (debug)
 */
'use strict';

process.env.EVIO_LOCAL_PORT     = process.env.EVIO_TEST_PORT || '18091';
process.env.EVIO_INPUT_LOG_ALL  = '0';
process.env.EVIO_TICK_LOG_EVERY = '999999';  // suppress tick spam in test output

const { chromium } = require('playwright');
const bpw = require('../physics_world');

const TEST_PORT    = Number(process.env.EVIO_LOCAL_PORT);
const BOOT_WAIT_MS = Number(process.env.EVIO_BOOT_WAIT_MS || 6000);
const HEADLESS     = process.env.EVIO_HEADLESS_SHOW !== '1';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────────────────────────────────────

bpw.ready.then(async () => {
  const srv = require('../local_ws_server');
  const wss = srv.startServer();
  await new Promise(res => wss.once('listening', res));
  console.log(`[lobby-test] Server listening on port ${TEST_PORT}`);

  // Track server-side connections so we know the browser actually connected.
  let serverConnections = 0;
  let serverAccepts     = 0;
  wss.on('connection', () => { serverConnections++; });

  let exitCode = 0;
  let browser;
  try {
    exitCode = await runTest();
  } catch (err) {
    console.error('[lobby-test] FATAL:', err.stack || err.message);
    exitCode = 1;
  } finally {
    try { if (browser) await browser.close(); } catch (_) {}
    wss.close();
    process.exit(exitCode);
  }

  async function runTest() {
    let pass = 0, fail = 0;

    function ok(desc, cond, detail = '') {
      if (cond) { console.log(`  ✓ ${desc}`); pass++; }
      else       { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
    }

    // ── Launch headless Chromium ─────────────────────────────────────────────
    browser = await chromium.launch({
      headless: HEADLESS,
      args: [
        '--use-gl=swiftshader',
        '--autoplay-policy=no-user-gesture-required',
        '--disable-quic',
        // Required so an https://ev.io/ page can connect to ws://127.0.0.1:PORT
        // (Mixed Content / Private Network Access restriction).
        '--disable-features=BlockInsecurePrivateNetworkRequests,PrivateNetworkAccessSendPreflights,LocalNetworkAccessChecks',
      ],
    });

    const ctx = await browser.newContext({
      viewport: { width: 1280, height: 720 },
      ignoreHTTPSErrors: true,
    });
    const page = await ctx.newPage();

    // ── Collect console errors ───────────────────────────────────────────────
    const crashErrors  = [];    // errors mentioning Qt03jhz (the reconciler crash)
    const otherErrors  = [];    // all other errors
    page.on('console', msg => {
      if (msg.type() === 'error') {
        const text = msg.text();
        if (text.includes('Qt03jhz')) crashErrors.push(text);
        else otherErrors.push(text.slice(0, 120));
      }
    });
    page.on('pageerror', err => {
      const text = (err.message || String(err)).slice(0, 300);
      if (text.includes('Qt03jhz')) crashErrors.push('pageerror: ' + text);
      else otherErrors.push('pageerror: ' + text.slice(0, 120));
    });

    // ── WS shim: redirect external game-server connections → our server ──────
    // Mirrors the pattern in headless_evio_client.js.
    // ev.io reads ?server=ws://... and connects there directly; on localhost
    // that is already our server, so the shim below is a safety net for any
    // fallback connection the client might make to an official endpoint.
    await page.addInitScript(({ localWs }) => {
      const NativeWebSocket = window.WebSocket;
      function RewritingWebSocket(url, protocols) {
        const original = String(url);
        // Redirect external (non-localhost, non-social) game WS connections
        const target = /^wss?:\/\//i.test(original) &&
                       !/(127\.0\.0\.1|localhost|social\.ev\.io)/i.test(original)
          ? localWs : original;
        if (target !== original) {
          console.log('[lobby-test] WS rewrite:', original, '→', target);
        }
        const socket = protocols === undefined
          ? new NativeWebSocket(target)
          : new NativeWebSocket(target, protocols);
        return socket;
      }
      RewritingWebSocket.prototype = NativeWebSocket.prototype;
      Object.setPrototypeOf(RewritingWebSocket, NativeWebSocket);
      Object.defineProperty(window, 'WebSocket', {
        value: RewritingWebSocket, configurable: true, writable: true,
      });
    }, { localWs: `ws://127.0.0.1:${TEST_PORT}` });

    // ── Open ev.io with custom server flag ───────────────────────────────────
    const url = `https://ev.io/?evioCustom=1&server=ws://127.0.0.1:${TEST_PORT}`;
    console.log(`\n[lobby-test] Opening: ${url}`);
    console.log(`[lobby-test] (headless=${HEADLESS}, boot_wait=${BOOT_WAIT_MS}ms)`);

    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    }).catch(e => {
      // Tolerate load errors (third-party fetches often fail in headless)
      console.log('[lobby-test] goto partial error (tolerated):', e.message.slice(0, 80));
    });

    // ── Wait for server connection ────────────────────────────────────────────
    console.log('[lobby-test] Waiting for server connection (up to 10s)...');
    const t0 = Date.now();
    while (Date.now() - t0 < 10000 && serverConnections === 0) {
      await sleep(200);
    }
    console.log(`[lobby-test] serverConnections=${serverConnections} after ${Date.now()-t0}ms`);

    // ── Watch for crash during the boot window ────────────────────────────────
    console.log(`[lobby-test] Watching for Qt03jhz crash over ${BOOT_WAIT_MS}ms...`);
    const watchStart = Date.now();
    while (Date.now() - watchStart < BOOT_WAIT_MS) {
      if (crashErrors.length > 0) break;  // fail fast
      await sleep(250);
    }

    // ── Gather results ────────────────────────────────────────────────────────
    const title = await page.title().catch(() => '(error)');
    const stillAlive = !page.isClosed();

    console.log('\n── Results ──────────────────────────────────────────────────');
    console.log(`  serverConnections: ${serverConnections}`);
    console.log(`  crashErrors:       ${crashErrors.length}`);
    console.log(`  otherErrors:       ${otherErrors.length}`);
    console.log(`  page title:        "${title}"`);
    console.log(`  page alive:        ${stillAlive}`);
    if (crashErrors.length > 0) {
      console.error('  !! Crash error 0:', crashErrors[0].slice(0, 200));
    }

    ok('Browser connected to our server',
       serverConnections > 0,
       `connections=${serverConnections}`);
    ok('No Qt03jhz reconciler crash in browser console',
       crashErrors.length === 0,
       `crash count=${crashErrors.length}${crashErrors.length > 0 ? '; first: ' + crashErrors[0].slice(0, 100) : ''}`);
    ok('Page did not crash (title still "ev.io")',
       title.toLowerCase().includes('ev.io') && stillAlive,
       `title="${title}" alive=${stillAlive}`);

    // ── The map must actually LOAD ───────────────────────────────────────────────────────────
    // "Connected and didn't crash" is not enough: a send-rate optimisation once deadlocked the map
    // load (the client needs a run of authoritative ticks to finish loading, but cannot send input
    // until that load completes — so a server that waits for input before sending hangs forever),
    // and every assertion above still passed.
    //
    // The client only starts producing input once the map is loaded and its game loop runs, so a
    // non-negative processed client tick is direct proof the load completed.
    // POLLED, not sampled once. This assertion was flaky: it read the status at a fixed moment after
    // BOOT_WAIT_MS, and whether the client had finished loading by then depended on how quickly the map
    // downloaded from the CDN that run — so it passed and failed alternately with no code change. A
    // flaky test is worse than a missing one, because it makes every real failure ambiguous. Wait for
    // the condition with a deadline instead of guessing how long it takes.
    const MAP_LOAD_DEADLINE_MS = Number(process.env.EVIO_MAP_LOAD_DEADLINE_MS || 30000);
    const loadStart = Date.now();
    let player = null;
    for (;;) {
      const s = srv.getStatus();
      player = (s.players && s.players[0]) || null;
      if (player && Number(player.processedClientTick) >= 0) break;
      if (Date.now() - loadStart > MAP_LOAD_DEADLINE_MS) break;
      await page.waitForTimeout(500);
    }
    const st = srv.getStatus();
    console.log(`  map load wait:         ${Date.now() - loadStart}ms`
      + ` (deadline ${MAP_LOAD_DEADLINE_MS}ms)`);
    console.log('  processed client tick: ' + (player ? player.processedClientTick : 'no player'));
    console.log('  suppressed sends:      ' + (player ? player.idleSends : '-'));
    ok('the client got far enough to send input (map finished loading)',
       !!player && Number(player.processedClientTick) >= 0,
       player ? 'processedClientTick=' + player.processedClientTick +
                ' — negative means the client never reached its game loop, i.e. the map never loaded'
              : 'no player session on the server');

    console.log(`\n${'─'.repeat(54)}`);
    console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
    return fail > 0 ? 1 : 0;
  }
}).catch(err => {
  console.error('[lobby-test] bpw load failed:', err);
  process.exit(1);
});
