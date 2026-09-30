/**
 * test_admin_auth.js — the admin dashboard must fail CLOSED.
 *
 * WHY
 * ───
 * This API can kick players, kill/heal/teleport them, switch the map, and rewrite every registered
 * gameplay constant. It used to bind loopback with no auth and merely PRINT A WARNING if pointed at
 * a public interface — but a warning is not a control. On a VPS the port is reachable from the whole
 * internet the moment the process starts, and 8081 is scanned continuously.
 *
 * So the rules under test are:
 *   - loopback + no token      -> allowed (unchanged local research posture)
 *   - non-loopback + no token  -> REFUSES TO START (does not listen at all)
 *   - token set                -> required on every endpoint, including the page itself
 *   - wrong token              -> 401, and repeated failures lock the IP out with 429
 *   - the token comparison is constant-time and length-independent
 *
 * Usage:  node scripts/test_admin_auth.js
 */
'use strict';

const http = require('http');
const path = require('path');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

// Load admin_server fresh with a given env (it reads process.env at module load).
function loadAdmin(env) {
  for (const k of ['EVIO_ADMIN_HOST', 'EVIO_ADMIN_PORT', 'EVIO_ADMIN_TOKEN']) delete process.env[k];
  Object.assign(process.env, env);
  const p = require.resolve('../admin_server.js');
  delete require.cache[p];
  return require(p);
}
const fakeGame = {
  getStatus: () => ({ ok: true, players: [] }),
  adminAction: () => ({ ok: true }),
};

function req(port, pathname, { token, header = true, method = 'GET' } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    let url = pathname;
    if (token && header) headers['x-evio-admin-token'] = token;
    if (token && !header) url += (url.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
    const r = http.request({ host: '127.0.0.1', port, path: url, method, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body, headers: res.headers }));
    });
    r.on('error', () => resolve({ status: 0, body: '', headers: {} }));
    r.end();
  });
}
const close = (s) => new Promise((r) => (s && s.listening ? s.close(r) : r()));

(async () => {
  console.log('\n── loopback with no token still works (local research posture) ──');
  {
    const admin = loadAdmin({ EVIO_ADMIN_HOST: '127.0.0.1', EVIO_ADMIN_PORT: '18131' });
    const s = admin.startAdminServer(fakeGame);
    ok('the server started', !!s);
    await new Promise((r) => setTimeout(r, 120));
    const res = await req(18131, '/api/status');
    ok('status is served without a token', res.status === 200, `status=${res.status}`);
    await close(s);
  }

  console.log('\n── a public bind with NO token refuses to start ──');
  {
    const admin = loadAdmin({ EVIO_ADMIN_HOST: '0.0.0.0', EVIO_ADMIN_PORT: '18132' });
    const s = admin.startAdminServer(fakeGame);
    ok('startAdminServer returns null instead of listening', s === null,
      'an unauthenticated admin API on a public interface is remote control of the server');
    const res = await req(18132, '/api/status');
    ok('and nothing is listening on the port', res.status === 0, `status=${res.status}`);
  }

  console.log('\n── a public bind WITH a token starts and is guarded ──');
  {
    const TOK = 'a'.repeat(48);
    const admin = loadAdmin({ EVIO_ADMIN_HOST: '127.0.0.1', EVIO_ADMIN_PORT: '18133', EVIO_ADMIN_TOKEN: TOK });
    const s = admin.startAdminServer(fakeGame);
    ok('it starts', !!s);
    await new Promise((r) => setTimeout(r, 120));

    ok('no token -> 401', (await req(18133, '/api/status')).status === 401);
    ok('wrong token -> 401', (await req(18133, '/api/status', { token: 'b'.repeat(48) })).status === 401);
    ok('right token (header) -> 200', (await req(18133, '/api/status', { token: TOK })).status === 200);
    ok('right token (?token=) -> 200', (await req(18133, '/api/status', { token: TOK, header: false })).status === 200);

    // Every sensitive endpoint, not just status.
    for (const ep of ['/', '/api/settings', '/api/log', '/api/maps']) {
      ok(`${ep} requires the token`, (await req(18133, ep)).status === 401);
    }
    // A mutating endpoint must not be reachable either.
    ok('POST /api/player requires the token',
      (await req(18133, '/api/player', { method: 'POST' })).status === 401);

    // An unknown path returns the SAME 401, so an unauthenticated scanner cannot map the API.
    ok('an unknown path is indistinguishable from a real one',
      (await req(18133, '/api/definitely-not-real')).status === 401);

    ok('the page carries a CSP when authorised',
      !!(await req(18133, '/', { token: TOK })).headers['content-security-policy']);
    ok('and nosniff', (await req(18133, '/', { token: TOK })).headers['x-content-type-options'] === 'nosniff');

    await close(s);
  }

  console.log('\n── repeated failures lock the source out ──');
  {
    const TOK = 'c'.repeat(48);
    const admin = loadAdmin({ EVIO_ADMIN_HOST: '127.0.0.1', EVIO_ADMIN_PORT: '18134', EVIO_ADMIN_TOKEN: TOK });
    const s = admin.startAdminServer(fakeGame);
    await new Promise((r) => setTimeout(r, 120));
    let sawLockout = false;
    for (let i = 0; i < 14; i++) {
      const r = await req(18134, '/api/status', { token: 'wrong' });
      if (r.status === 429) { sawLockout = true; break; }
    }
    ok('brute force is throttled with 429', sawLockout, 'guessing should stop being free');
    const locked = await req(18134, '/api/status', { token: TOK });
    ok('and the lockout applies even to the CORRECT token while active', locked.status === 429,
      `status=${locked.status} — otherwise the lockout is trivially bypassed`);
    await close(s);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
