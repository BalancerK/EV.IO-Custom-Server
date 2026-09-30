/**
 * test_admin_csrf.js — a POST without a real JSON body cannot reach the admin API.
 *
 * THE HOLE THIS CLOSES
 * ─────────────────────
 * The default posture is loopback + no token (see test_admin_auth.js) — there is no per-request
 * secret at all in that mode, by design, for local research use. Without this check, ANY other page
 * the operator has open in the same browser could do:
 *
 *   fetch('http://127.0.0.1:8081/api/server', {
 *     method: 'POST',
 *     headers: { 'Content-Type': 'text/plain' },     // a CORS "simple" content type
 *     body: JSON.stringify({ action: 'killall' }),
 *   })
 *
 * `text/plain` (along with `application/x-www-form-urlencoded`, `multipart/form-data`, and a bare
 * HTML <form> submission) is a CORS "simple request" — the browser sends it with NO preflight check,
 * purely because the target is reachable. The old readBody() never looked at Content-Type, so that
 * request was parsed and the action executed exactly as if the dashboard itself had sent it. This is
 * the same class of attack historically used against Docker's and various routers' localhost APIs.
 *
 * THE FIX, AND WHY IT WORKS
 * ─────────────────────────
 * Every POST must now carry `Content-Type: application/json`. That is NOT one of the three CORS-safe
 * types, so a cross-origin fetch that sets it is "non-simple": the browser must first get a
 * successful OPTIONS preflight response with a matching `Access-Control-Allow-Origin` before it will
 * even attempt the real request. This server sends no CORS headers at all, so no preflight can ever
 * succeed, so no cross-origin POST reaches this code — regardless of what Content-Type an attacker
 * tries to set, because the ONLY types a page can send without a preflight are the three this check
 * rejects. A bare <form> submission is limited to those same three types, so it is blocked too.
 *
 * Usage:  node scripts/test_admin_csrf.js
 */
'use strict';

const http = require('http');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

function loadAdmin(env) {
  for (const k of ['EVIO_ADMIN_HOST', 'EVIO_ADMIN_PORT', 'EVIO_ADMIN_TOKEN']) delete process.env[k];
  Object.assign(process.env, env);
  const p = require.resolve('../admin_server.js');
  delete require.cache[p];
  return require(p);
}

function req(port, pathname, { method = 'POST', contentType, body } = {}) {
  return new Promise((resolve) => {
    const headers = {};
    if (contentType !== undefined) headers['content-type'] = contentType;
    const payload = body !== undefined ? Buffer.from(JSON.stringify(body)) : undefined;
    if (payload) headers['content-length'] = payload.length;
    const r = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
    });
    r.on('error', () => resolve({ status: 0, body: '' }));
    if (payload) r.write(payload);
    r.end();
  });
}
const close = (s) => new Promise((r) => (s && s.listening ? s.close(r) : r()));

const fakeGame = {
  getStatus: () => ({ ok: true, players: [] }),
  adminAction: () => ({ ok: true }),
  adminServerAction: (action) => ({ ok: true, action }),
  getParityRings: () => ({}),
  mapLoader: { listMaps: () => [], cachedMaps: () => [] },
};

(async () => {
  console.log('\n── the scenario under test: loopback, NO token (the default posture) ──');
  const admin = loadAdmin({ EVIO_ADMIN_HOST: '127.0.0.1', EVIO_ADMIN_PORT: '18141' });
  admin.startAdminServer(fakeGame);
  await new Promise((r) => setTimeout(r, 200));

  console.log('\n── the exact CSRF vector: a POST claiming a CORS-simple Content-Type ──');
  {
    const r1 = await req(18141, '/api/server', { contentType: 'text/plain', body: { action: 'killall' } });
    ok('text/plain is rejected (this is the type that skips a browser preflight)',
      r1.status === 415, `status=${r1.status} body=${r1.body}`);

    const r2 = await req(18141, '/api/server', { contentType: 'application/x-www-form-urlencoded', body: { action: 'killall' } });
    ok('application/x-www-form-urlencoded is rejected (a bare <form> can send this)',
      r2.status === 415, `status=${r2.status}`);

    const r3 = await req(18141, '/api/server', { contentType: undefined, body: { action: 'killall' } });
    ok('no Content-Type at all is rejected', r3.status === 415, `status=${r3.status}`);
  }

  console.log('\n── the legitimate path still works ──');
  {
    const r = await req(18141, '/api/server', { contentType: 'application/json', body: { action: 'noop' } });
    ok('application/json (what the dashboard itself sends) is accepted', r.status === 200, `status=${r.status} body=${r.body}`);

    const r2 = await req(18141, '/api/server', { contentType: 'application/json; charset=utf-8', body: { action: 'noop' } });
    ok('application/json with a charset parameter is still accepted (case/param insensitive)',
      r2.status === 200, `status=${r2.status}`);

    const r3 = await req(18141, '/api/server', { contentType: 'APPLICATION/JSON', body: { action: 'noop' } });
    ok('the check is case-insensitive', r3.status === 200, `status=${r3.status}`);
  }

  console.log('\n── every state-changing endpoint is covered, not just one ──');
  {
    const endpoints = ['/api/settings', '/api/settings/reset', '/api/map', '/api/preset', '/api/server', '/api/player'];
    let allBlocked = true;
    for (const ep of endpoints) {
      const r = await req(18141, ep, { contentType: 'text/plain', body: {} });
      if (r.status !== 415) { allBlocked = false; console.error(`    ${ep} responded ${r.status}, not 415`); }
    }
    ok('every POST endpoint rejects a simple-request Content-Type', allBlocked);
  }

  console.log('\n── GET requests are unaffected ──');
  {
    const r = await req(18141, '/api/status', { method: 'GET' });
    ok('GET has no Content-Type requirement', r.status === 200, `status=${r.status}`);
  }

  await close(admin);

  console.log('\n── the same protection applies when a TOKEN is also configured ──');
  {
    const admin2 = loadAdmin({ EVIO_ADMIN_HOST: '127.0.0.1', EVIO_ADMIN_PORT: '18142', EVIO_ADMIN_TOKEN: 'sekrit' });
    admin2.startAdminServer(fakeGame);
    await new Promise((r) => setTimeout(r, 200));
    const r = await new Promise((resolve) => {
      const request = http.request({ host: '127.0.0.1', port: 18142, path: '/api/server', method: 'POST',
        headers: { 'content-type': 'text/plain', 'x-evio-admin-token': 'sekrit' } }, (res) => {
        let b = ''; res.on('data', (c) => (b += c)); res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      request.end(JSON.stringify({ action: 'killall' }));
    });
    ok('a correct token does not bypass the content-type check', r.status === 415, `status=${r.status}`);
    await close(admin2);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
