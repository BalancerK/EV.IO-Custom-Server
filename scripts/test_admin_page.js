/**
 * test_admin_page.js — the dashboard page itself.
 *
 * THE BUG THIS EXISTS FOR
 * ───────────────────────
 * The sparkline renderer sized its canvas like this:
 *
 *     var w = canvas.clientWidth, h = canvas.height;      // <- already DPR-scaled
 *     canvas.height = Math.round(h * dpr);                // <- scales it AGAIN
 *
 * On a 1.0-DPR display that is a no-op and everything looks fine. On anything scaled — a 125%
 * Windows desktop is dpr 1.25, a phone or Retina panel is 2 or 3 — the backing store is multiplied
 * by DPR on EVERY poll: 46 -> 57 -> 72 -> ... past the ~32767px canvas limit in about fifteen
 * seconds. The draw then throws, poll()'s .catch fires, and the dashboard reports "offline" and
 * stops updating — a rendering bug wearing a network bug's clothes.
 *
 * So this test drives the REAL drawSpark out of the served page across several DPRs and asserts the
 * backing store is stable, and checks that a render failure can no longer be reported as offline.
 *
 * Usage:  node scripts/test_admin_page.js
 */
'use strict';

const http = require('http');
const path = require('path');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

process.env.EVIO_ADMIN_HOST = '127.0.0.1';
process.env.EVIO_ADMIN_PORT = '18195';
delete process.env.EVIO_ADMIN_TOKEN;
const admin = require(path.join(__dirname, '..', 'admin_server.js'));

const now = Date.now();
const fakeGame = {
  getStatus: () => ({
    now, uptimeMs: 60000, globalTick: 1200, tickRate: 19.98, targetTickRate: 20,
    playerCount: 0, players: [], simErrors: 0, tickErrors: 0,
    round: 1, map: 'default_map', roundPhase: 'playing', roundSecondsLeft: 100,
    history: Array.from({ length: 60 }, (_, i) => ({
      t: now - (60 - i) * 1000, rate: 20, jitter: 3, players: 1, lag: 2, queued: 1, errs: 0,
    })),
  }),
  adminAction: () => ({ ok: true }),
};

// A canvas stub that behaves like the real one in the way that matters: `height` is the BACKING
// STORE, which is exactly the property the bug fed back into.
function fakeCanvas() {
  const ctx = new Proxy({}, { get: () => () => {}, set: () => true });
  return { clientWidth: 200, width: 0, height: 46, style: {}, getContext: () => ctx };
}

function get(pathname) {
  return new Promise((resolve) => {
    http.get({ host: '127.0.0.1', port: 18195, path: pathname }, (res) => {
      let b = '';
      res.on('data', (c) => { b += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: b, headers: res.headers }));
    }).on('error', () => resolve({ status: 0, body: '', headers: {} }));
  });
}

(async () => {
  const server = admin.startAdminServer(fakeGame);
  await new Promise((r) => setTimeout(r, 200));
  const page = await get('/');

  console.log('\n── the page is served and structurally intact ──');
  ok('200', page.status === 200);
  ok('viewport meta (required for phones to lay out at all)',
    page.body.includes('name="viewport"'));
  ok('telemetry section', page.body.includes('id="charts"'));
  ok('six sparklines', (page.body.match(/<canvas data-k=/g) || []).length === 6);
  ok('settings filter', page.body.includes('id="settingFilter"'));
  ok('the script block is not broken by a stray backtick or </script>',
    page.body.split('</script>').length === 2 && page.body.trim().endsWith('</html>'));

  console.log('\n── responsive rules are present ──');
  ok('narrow-screen column hiding for the 18-column player table',
    page.body.includes('#players th:nth-child(2)'));
  ok('phone breakpoint', page.body.includes('@media (max-width:719px)'));
  ok('multi-column layout on wide displays', page.body.includes('@media (min-width:1600px)'));
  ok('settings rows stack on phones', page.body.includes('.setting { grid-template-columns:minmax(0,1fr)'));

  console.log('\n── THE REGRESSION: canvas backing store must not grow ──');
  {
    // Pull the real function out of the served page rather than re-implementing it.
    const i = page.body.indexOf('function drawSpark');
    ok('drawSpark found in the page', i !== -1);
    const src = page.body.slice(i, page.body.indexOf('\n  }', i) + 4);
    const vals = Array.from({ length: 40 }, (_, k) => 20 + Math.sin(k / 5));

    for (const dpr of [1, 1.25, 2, 3]) {
      global.window = { devicePixelRatio: dpr };
      const drawSpark = new Function('return (' + src + ')')();
      const c = fakeCanvas();
      const seen = [];
      for (let k = 0; k < 60; k++) { drawSpark(c, vals, ''); seen.push(c.height); }
      const first = seen[0], last = seen[seen.length - 1];
      ok(`dpr ${dpr}: backing store stable across 60 polls (${first}px)`, first === last,
        `grew ${first} -> ${last}; this is what made the graphs freeze and report offline`);
      ok(`dpr ${dpr}: stays inside the browser canvas limit`, last < 32767, `${last}px`);
    }
    delete global.window;
  }

  console.log('\n── a render error must not be reported as "offline" ──');
  {
    // poll() has to distinguish a network failure from a bug in the page; conflating them is what
    // disguised the canvas fault as a dropped connection.
    ok('renderStatus is called inside its own try/catch',
      page.body.includes('renderStatus(st);') && page.body.includes('catch (e)'),
      'a throw in rendering must not reach the network .catch');
    ok('offline is only set from the fetch .catch',
      (page.body.match(/dot down"><\/span>offline/g) || []).length === 1);
  }

  await new Promise((r) => server.close(r));
  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
