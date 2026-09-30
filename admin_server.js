/**
 * admin_server.js — local web dashboard for the ev.io custom server.
 *
 * Serves a single self-contained page on http://127.0.0.1:8081 that shows live server status
 * (tick rate, connected players, their position/health/weapon/netcode state) and lets every
 * registered setting be changed while the server runs — no restart, no dropped players.
 *
 * SECURITY POSTURE — FAIL CLOSED. This API can kick, kill, heal and teleport players, switch the
 * map, and rewrite every registered gameplay constant, so reachability is the whole threat model:
 *
 *   loopback + no token       -> served (unchanged local research posture)
 *   non-loopback + no token   -> REFUSES TO START (it used to warn and serve anyway)
 *   token set                 -> required on every endpoint, constant-time compare, per-IP lockout
 *
 * On a VPS, leave this on loopback and reach it through an SSH tunnel — SSH supplies the
 * authentication and the encryption, and the port never faces the internet:
 *
 *     ssh -N -L 8081:127.0.0.1:8081 user@host     then browse http://127.0.0.1:8081
 *
 * A token over plain HTTP travels in CLEARTEXT. It exists so that an accidental public bind is not
 * instantly fatal; it is not a substitute for a tunnel or for HTTPS. EVIO_ADMIN=0 disables the
 * dashboard entirely. Guarded by `npm run test:adminauth`.
 *
 * Endpoints:
 *   GET  /                      the dashboard
 *   GET  /api/status            live status snapshot (polled by the page)
 *   GET  /api/settings          registry: every setting, its value, bounds, and description
 *   POST /api/settings          {key, value} → change one setting
 *   POST /api/settings/reset    {key}        → back to its env/default value
 *   GET  /api/log               recent setting changes
 *   POST /api/player            {sessionId, action, arg} → kick | kill | heal | respawn | slap
 *                                                          | sethealth | teleport
 *   POST /api/server            {action, arg} → announce | healall | killall | respawnall | slapall
 *                                               | gather | restartround | endround | addtime
 *   GET  /api/presets           named bundles of settings
 *   POST /api/preset            {preset} → apply one
 *   GET  /api/maps              map catalogue + which are already cached on disk
 *   POST /api/map               {map} → switch the live map (downloads + converts on first use)
 */
'use strict';

const http = require('http');
const crypto = require('crypto');
const S = require('./settings');

const ADMIN_HOST = process.env.EVIO_ADMIN_HOST || '127.0.0.1';
const ADMIN_PORT = Number(process.env.EVIO_ADMIN_PORT || 8081);
const ADMIN_TOKEN = process.env.EVIO_ADMIN_TOKEN || '';

// ── Authentication ───────────────────────────────────────────────────────────
// The posture is FAIL-CLOSED. Previously a non-loopback bind merely printed a warning and then
// served the full API to anyone who could route to the port — kick, kill, teleport, and rewrite of
// every gameplay constant. A warning is not a control: on a VPS the port is reachable from the
// whole internet the moment the process starts, and port 8081 is scanned constantly.
//
// So: binding off-loopback WITHOUT a token is now a startup ERROR, not a warning. With a token, it
// is required on every request, compared in constant time, and brute force is throttled per IP.
//
// READ THIS BEFORE EXPOSING THE PORT: a token over plain HTTP is sent in cleartext on every
// request. Anyone able to observe the traffic gets it. The token exists so that an accidental or
// deliberate off-loopback bind is not instantly fatal — it is NOT a substitute for a tunnel.
// The supported way to reach this dashboard on a VPS is an SSH tunnel, which keeps the port bound
// to loopback and gives you SSH's authentication and encryption for free:
//
//     ssh -N -L 8081:127.0.0.1:8081 user@your-vps      then browse http://127.0.0.1:8081
//
function isLoopbackHost(h) {
  return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '::ffff:127.0.0.1';
}
const ADMIN_LOOPBACK = isLoopbackHost(ADMIN_HOST);

// Constant-time comparison. A plain === leaks the shared secret one character at a time through
// timing, which is exactly the kind of thing that is invisible in testing and fatal in the field.
function tokenMatches(supplied) {
  if (!ADMIN_TOKEN) return true;                       // no token configured (loopback-only mode)
  if (typeof supplied !== 'string' || supplied.length === 0) return false;
  const a = Buffer.from(String(supplied));
  const b = Buffer.from(ADMIN_TOKEN);
  // timingSafeEqual throws on length mismatch, which would itself leak the length — hash both to a
  // fixed width first so every comparison costs the same regardless of what was supplied.
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// Per-IP failure throttle. Small and in-memory: enough to make online guessing useless without
// pretending to be a full rate limiter.
const FAIL_MAX = 10;              // failures before lockout
const FAIL_WINDOW_MS = 60_000;    // lockout duration
const failures = new Map();       // ip -> { n, until }
function throttleState(ip) {
  const f = failures.get(ip);
  if (!f) return null;
  if (f.until && Date.now() < f.until) return f;
  if (f.until && Date.now() >= f.until) { failures.delete(ip); return null; }
  return f;
}
function noteFailure(ip) {
  const f = failures.get(ip) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= FAIL_MAX) {
    f.until = Date.now() + FAIL_WINDOW_MS;
    console.warn(`[evio-admin] locking out ${ip} for ${FAIL_WINDOW_MS / 1000}s after ${f.n} failed auth attempts`);
  }
  failures.set(ip, f);
}
function clearFailures(ip) { failures.delete(ip); }

// The token may arrive as a header (what the page uses) or as ?token= (so a fresh browser can do
// the first load). Never logged.
function suppliedToken(req, url) {
  return req.headers['x-evio-admin-token'] || url.searchParams.get('token') || '';
}

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  });
  res.end(payload);
}

function readBody(req, limitBytes = 64 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) { reject(new Error('body too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); } catch (err) { reject(new Error('invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

/**
 * @param {object} game  the local_ws_server module (getStatus / adminAction)
 */
function startAdminServer(game) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const path = url.pathname;
    const ip = (req.socket && req.socket.remoteAddress) || 'unknown';

    // ── Gate every request ───────────────────────────────────────────────────
    // Ordered so that a locked-out or unauthenticated caller learns nothing about what exists:
    // the 401 is identical for a real endpoint and a made-up one.
    if (ADMIN_TOKEN) {
      const locked = throttleState(ip);
      if (locked && locked.until && Date.now() < locked.until) {
        res.setHeader('retry-after', Math.ceil((locked.until - Date.now()) / 1000));
        return json(res, 429, { ok: false, err: 'too many failed attempts' });
      }
      if (!tokenMatches(suppliedToken(req, url))) {
        noteFailure(ip);
        return json(res, 401, { ok: false, err: 'unauthorised' });
      }
      clearFailures(ip);
    }
    // Only these two verbs are ever used; anything else is a scanner or a mistake.
    if (req.method !== 'GET' && req.method !== 'POST') {
      return json(res, 405, { ok: false, err: 'method not allowed' });
    }

    // ── CSRF: every POST must be a "non-simple" CORS request ──────────────────────────────────
    // In the DEFAULT posture (loopback, no token — see the header above), there is no per-request
    // secret at all, and a token check would not help here anyway: this defends against a request
    // that never carries one.
    //
    // The gap: a page from ANY other origin that the operator merely has open in the same browser
    // can fire `fetch('http://127.0.0.1:8081/api/server', { method:'POST', headers:{'Content-Type':
    // 'text/plain'}, body: JSON.stringify({action:'killall'}) })`. `text/plain` (like
    // `application/x-www-form-urlencoded` and `multipart/form-data`, and like a plain HTML <form>
    // submission) is a CORS "simple request" — the browser sends it with NO preflight and no
    // permission check, purely because it targets localhost. readBody() does not look at
    // Content-Type, so that request was parsed and executed exactly like a real one, entirely
    // without a token, purely by the operator having a malicious tab open. This is the same class of
    // attack used historically against Docker's and various routers' localhost APIs.
    //
    // `application/json` is NOT in that safelist, so requiring it turns every legitimate call into a
    // "non-simple" request: the browser must first send an OPTIONS preflight and get back an
    // `Access-Control-Allow-Origin` it accepts before the real request is ever transmitted. This
    // server never sends CORS headers, so no preflight can succeed and no cross-origin POST — with
    // any Content-Type an attacker can actually set — ever reaches here. The dashboard's own JS
    // already sends `application/json` on every call, so this changes nothing for legitimate use.
    if (req.method === 'POST') {
      const ct = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      if (ct !== 'application/json') {
        return json(res, 415, { ok: false,
          err: 'Content-Type must be application/json (rejecting a CORS "simple request" — see CSRF note)' });
      }
    }

    try {
      if (req.method === 'GET' && (path === '/' || path === '/index.html')) {
        const html = PAGE;
        res.writeHead(200, {
          'content-type': 'text/html; charset=utf-8',
          'content-length': Buffer.byteLength(html),
          // The page is fully self-contained — no external CSS, JS, fonts or images — so the policy
          // can be strict: nothing loads from anywhere, and it may not be framed (clickjacking a
          // dashboard that can kick players is a real risk once the port is reachable at all).
          'content-security-policy':
            "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; "
            + "connect-src 'self'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
          'x-content-type-options': 'nosniff',
          'referrer-policy': 'no-referrer',
          'cache-control': 'no-store',
        });
        return res.end(html);
      }
      if (req.method === 'GET' && path === '/api/status') {
        return json(res, 200, game.getStatus());
      }
      if (req.method === 'GET' && path === '/api/settings') {
        // persistence rides along so the UI can say whether a change will survive a restart — a
        // read-only /opt/evio would otherwise lose every edit silently.
        return json(res, 200, { settings: S.list(), persistence: S.persistenceStatus() });
      }
      if (req.method === 'GET' && path === '/api/log') {
        return json(res, 200, { log: S.changeLog() });
      }
      if (req.method === 'POST' && path === '/api/settings') {
        const body = await readBody(req);
        const r = S.set(body.key, body.value, 'admin-ui');
        return json(res, r.ok ? 200 : 400, r);
      }
      if (req.method === 'POST' && path === '/api/settings/reset') {
        const body = await readBody(req);
        const r = S.reset(body.key, 'admin-ui');
        return json(res, r.ok ? 200 : 400, r);
      }
      if (req.method === 'GET' && path === '/api/maps') {
        // Catalogue + which maps are already on disk (those load instantly).
        const cached = new Set(game.mapLoader.cachedMaps().map((m) => m.nid));
        return json(res, 200, {
          active: game.getStatus().map,
          maps: game.mapLoader.listMaps().map((m) => ({
            nid: m.nid, title: m.title, cached: cached.has(m.nid), inRotation: m.inRotation,
          })),
        });
      }
      if (req.method === 'POST' && path === '/api/map') {
        // Switch the live map. Downloads + converts on first use (a few seconds), then cached.
        const body = await readBody(req);
        try {
          const r = await game.switchMap(game.getSessions(), body.map);
          return json(res, 200, r);
        } catch (err) {
          return json(res, 400, { ok: false, err: String(err && err.message || err) });
        }
      }
      if (req.method === 'GET' && path === '/api/parity') {
        // The server's per-client-tick state ring, for diffing against a client parity trace.
        // Empty unless parityRingTicks > 0 — see recordParitySample.
        return json(res, 200, { rings: game.getParityRings() });
      }
      if (req.method === 'GET' && path === '/api/presets') {
        return json(res, 200, { presets: S.listPresets() });
      }
      if (req.method === 'POST' && path === '/api/preset') {
        const body = await readBody(req);
        const r = S.applyPreset(body.preset, 'admin-ui');
        return json(res, r.ok ? 200 : 400, r);
      }
      if (req.method === 'POST' && path === '/api/server') {
        // Match-wide actions: announce, heal/kill/respawn/slap everyone, gather, round control.
        const body = await readBody(req);
        const r = game.adminServerAction(body.action, body.arg);
        return json(res, r.ok ? 200 : 400, r);
      }
      if (req.method === 'POST' && path === '/api/player') {
        const body = await readBody(req);
        const r = game.adminAction(body.sessionId, body.action, body.arg);
        return json(res, r.ok ? 200 : 400, r);
      }
      return json(res, 404, { ok: false, err: 'not found' });
    } catch (err) {
      return json(res, 400, { ok: false, err: String(err && err.message || err) });
    }
  });

  // FAIL CLOSED. An unauthenticated admin API on a public interface is a remote-control handle for
  // the whole server, so refuse to open the socket at all rather than warn and serve it.
  if (!ADMIN_LOOPBACK && !ADMIN_TOKEN) {
    console.error(
      `\n[evio-admin] REFUSING TO START.\n`
      + `  EVIO_ADMIN_HOST is ${ADMIN_HOST} (not loopback) and EVIO_ADMIN_TOKEN is not set.\n`
      + `  This API can kick players, teleport them, and rewrite every gameplay constant, so it must\n`
      + `  not be reachable without authentication.\n\n`
      + `  Preferred fix — leave it on loopback and tunnel in over SSH:\n`
      + `      ssh -N -L ${ADMIN_PORT}:127.0.0.1:${ADMIN_PORT} user@host\n`
      + `      then browse http://127.0.0.1:${ADMIN_PORT}\n\n`
      + `  If you really must bind a public interface, set a strong token:\n`
      + `      EVIO_ADMIN_TOKEN=$(openssl rand -hex 32)\n`
      + `  and be aware it travels in cleartext unless you put HTTPS in front of it.\n`
      + `  To disable the dashboard entirely: EVIO_ADMIN=0\n`);
    return null;
  }

  server.listen(ADMIN_PORT, ADMIN_HOST, () => {
    const auth = ADMIN_TOKEN ? 'token required' : 'no auth (loopback only)';
    console.log(`[evio-admin] dashboard on http://${ADMIN_HOST}:${ADMIN_PORT} — ${auth}`);
    if (!ADMIN_LOOPBACK) {
      console.warn(`[evio-admin] bound to ${ADMIN_HOST} (not loopback). The token is sent in `
        + `CLEARTEXT over plain HTTP — prefer an SSH tunnel, or put HTTPS in front of this port.`);
    }
  });
  server.on('error', (err) => {
    console.error(`[evio-admin] could not start on ${ADMIN_HOST}:${ADMIN_PORT}: ${err.message}`);
  });
  return server;
}

// ── The dashboard page (self-contained: no external CSS/JS/fonts) ─────────────────────────
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>ev.io custom server — admin</title>
<style>
  /* ── Tokens ──────────────────────────────────────────────────────────────
     One scale for space/radius/type so panels, controls and charts agree
     instead of each carrying ad-hoc pixel values. */
  :root {
    --bg:#0d1117; --panel:#161b22; --panel2:#1c2230; --line:#2a323d; --line2:#39414d;
    --fg:#e6edf3; --dim:#8d96a0; --accent:#4c9aff; --ok:#3fb950; --warn:#d29922; --bad:#f85149;
    --mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    --sans: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    --r1:6px; --r2:9px; --r3:14px;
    --s1:6px; --s2:10px; --s3:14px; --s4:18px;
    --shadow: 0 1px 2px rgba(0,0,0,.28), 0 8px 24px rgba(0,0,0,.22);
    --ring: 0 0 0 2px color-mix(in srgb, var(--accent) 55%, transparent);
  }
  @media (prefers-color-scheme: light) {
    :root { --bg:#f4f6f9; --panel:#fff; --panel2:#f2f5f8; --line:#dde3ea; --line2:#c9d2dc;
            --fg:#1a1f26; --dim:#5b6672; --accent:#0b62d6;
            --shadow: 0 1px 2px rgba(16,24,40,.06), 0 8px 24px rgba(16,24,40,.08); }
  }

  *, *::before, *::after { box-sizing:border-box; }
  html { -webkit-text-size-adjust:100%; }
  body { margin:0; background:var(--bg); color:var(--fg); font:14px/1.55 var(--sans);
         -webkit-font-smoothing:antialiased; }
  :focus-visible { outline:none; box-shadow:var(--ring); border-radius:var(--r1); }
  @media (prefers-reduced-motion: reduce) { * { transition:none !important; animation:none !important; } }

  /* ── Header ──────────────────────────────────────────────────────────── */
  header { position:sticky; top:0; z-index:5; background:color-mix(in srgb, var(--panel) 92%, transparent);
           backdrop-filter:saturate(1.6) blur(8px); border-bottom:1px solid var(--line);
           padding:var(--s2) var(--s3); display:flex; align-items:center; gap:var(--s2) var(--s3); flex-wrap:wrap; }
  h1 { font-size:14px; margin:0; font-weight:650; letter-spacing:.2px; white-space:nowrap; }
  .pill { font:12px/1 var(--mono); padding:6px 10px; border-radius:999px;
          background:var(--panel2); border:1px solid var(--line); white-space:nowrap; }
  .pill b { font-weight:650; }
  .dot { display:inline-block; width:7px; height:7px; border-radius:50%; margin-right:6px; vertical-align:1px; }
  .up { background:var(--ok); box-shadow:0 0 0 3px color-mix(in srgb, var(--ok) 22%, transparent); }
  .down { background:var(--bad); box-shadow:0 0 0 3px color-mix(in srgb, var(--bad) 22%, transparent); }

  /* ── Tab navigation ──────────────────────────────────────────────────────
     The page had grown into one long scroll where the settings list buried everything below it.
     Tabs keep each concern one click away and make room for panels that would otherwise never be
     seen. Panels are plain sections tagged with data-panel, so the markup stays readable and the
     whole thing degrades to a normal scrolling page if the script fails. */
  nav#tabs { position:sticky; top:41px; z-index:4; display:flex; align-items:center; gap:2px;
             padding:0 var(--s3); background:color-mix(in srgb, var(--bg) 92%, transparent);
             backdrop-filter:saturate(1.4) blur(8px); border-bottom:1px solid var(--line);
             overflow-x:auto; scrollbar-width:none; }
  nav#tabs::-webkit-scrollbar { display:none; }
  nav#tabs button { background:none; border:none; border-bottom:2px solid transparent; color:var(--dim);
                    padding:10px 12px; font:13px/1 var(--sans); font-weight:600; white-space:nowrap;
                    border-radius:0; cursor:pointer; transition:color .12s, border-color .12s; }
  nav#tabs button:hover { color:var(--fg); }
  nav#tabs button[aria-selected="true"] { color:var(--accent); border-bottom-color:var(--accent); }
  .navSpacer { flex:1; }
  .navHint { font-size:11px; white-space:nowrap; padding-right:2px; }
  kbd { font:11px/1 var(--mono); background:var(--panel2); border:1px solid var(--line);
        border-bottom-width:2px; border-radius:4px; padding:2px 5px; }
  section[hidden] { display:none !important; }

  /* ── Controls ────────────────────────────────────────────────────────── */
  .row { display:flex; gap:var(--s2); align-items:center; flex-wrap:wrap; }
  .grow { flex:1; min-width:200px; font:13px/1 inherit; padding:9px 10px; border-radius:var(--r1);
          border:1px solid var(--line); background:var(--bg); color:var(--fg); }
  .chipRow { display:flex; gap:var(--s1); flex-wrap:wrap; margin-top:var(--s2); }
  .chipRow button { font-size:12.5px; padding:7px 11px; }
  button.primary { border-color:var(--accent); color:var(--accent);
                   background:color-mix(in srgb, var(--accent) 12%, transparent); }
  button.danger:hover { border-color:var(--bad); color:var(--bad); }
  button.fun:hover { border-color:var(--warn); color:var(--warn); }
  .chip { border-radius:999px !important; }
  h3 { font-size:12px; text-transform:uppercase; letter-spacing:.6px; color:var(--dim);
       margin:var(--s4) 0 0; font-weight:650; }
  .note { margin:var(--s3) 0 0; font-size:12px; }

  .presetGrid { display:grid; gap:var(--s2);
                grid-template-columns:repeat(auto-fill, minmax(190px, 1fr)); }
  .preset { text-align:left; padding:var(--s3); border-radius:var(--r2); border:1px solid var(--line);
            background:var(--panel2); cursor:pointer; transition:border-color .12s, transform .08s; }
  .preset:hover { border-color:var(--accent); }
  .preset:active { transform:translateY(1px); }
  .preset .pTitle { display:block; font-weight:650; font-size:13.5px; margin-bottom:3px; }
  .preset .pDesc { display:block; font-size:11.5px; color:var(--dim); line-height:1.45; }

  /* ── Layout ──────────────────────────────────────────────────────────────
     Single column by default (phones), two columns once there is genuinely
     room, three on very wide displays so the settings list stops being a
     kilometre of scroll. */
  main { padding:var(--s3); display:grid; gap:var(--s3); grid-template-columns:minmax(0,1fr);
         max-width:1680px; margin:0 auto; }
  @media (min-width:1080px) { main { grid-template-columns:minmax(0,1.2fr) minmax(0,1fr); } }
  @media (min-width:1600px) { main { grid-template-columns:minmax(0,1.3fr) minmax(0,1fr) minmax(0,1fr); } }

  section { background:var(--panel); border:1px solid var(--line); border-radius:var(--r3);
            overflow:hidden; box-shadow:var(--shadow); }
  section > h2 { margin:0; font-size:11px; text-transform:uppercase; letter-spacing:.09em; color:var(--dim);
                 padding:var(--s2) var(--s3); border-bottom:1px solid var(--line); background:var(--panel2);
                 display:flex; justify-content:space-between; align-items:center; gap:var(--s2); font-weight:650; }
  .body { padding:var(--s3); }
  .empty { color:var(--dim); padding:26px var(--s3); text-align:center; font-size:13px; }
  .muted { color:var(--dim); }

  /* ── Tables ──────────────────────────────────────────────────────────────
     18 columns will never fit a phone, so columns are ranked by how often you
     actually need them and the long tail is dropped at each breakpoint via
     nth-child — no markup changes, and the full set returns on a desktop. */
  .scroll { overflow-x:auto; -webkit-overflow-scrolling:touch; overscroll-behavior-x:contain; }
  table { border-collapse:collapse; width:100%; font:12px/1.5 var(--mono); }
  th, td { text-align:left; padding:7px var(--s2); border-bottom:1px solid var(--line); white-space:nowrap; }
  th { color:var(--dim); font-weight:650; position:sticky; top:0; background:var(--panel);
       font-size:11px; letter-spacing:.03em; }
  tbody tr:hover { background:var(--panel2); }
  tbody tr:last-child td { border-bottom:0; }
  .num { text-align:right; font-variant-numeric:tabular-nums; }

  /* name(1) state(3) hp(4) actions(18) are always shown. */
  @media (max-width:1079px) {
    #players th:nth-child(2),  #players td:nth-child(2),      /* id    */
    #players th:nth-child(5),  #players td:nth-child(5),      /* x     */
    #players th:nth-child(6),  #players td:nth-child(6),      /* y     */
    #players th:nth-child(7),  #players td:nth-child(7),      /* z     */
    #players th:nth-child(11), #players td:nth-child(11),     /* atc   */
    #players th:nth-child(12), #players td:nth-child(12),     /* cTick */
    #players th:nth-child(16), #players td:nth-child(16),     /* look  */
    #players th:nth-child(17), #players td:nth-child(17) { display:none; }
  }
  @media (max-width:719px) {
    #players th:nth-child(8),  #players td:nth-child(8),      /* spd  */
    #players th:nth-child(9),  #players td:nth-child(9),      /* wpn  */
    #players th:nth-child(10), #players td:nth-child(10),     /* ammo */
    #players th:nth-child(13), #players td:nth-child(13),     /* echo */
    #players th:nth-child(14), #players td:nth-child(14),     /* q    */
    #players th:nth-child(15), #players td:nth-child(15) { display:none; }
  }

  .tag { font:11px/1 var(--mono); padding:4px 7px; border-radius:var(--r1);
         background:var(--panel2); border:1px solid var(--line); }
  .tag.dead { color:var(--bad); border-color:color-mix(in srgb, var(--bad) 55%, var(--line)); }
  .tag.alive { color:var(--ok); border-color:color-mix(in srgb, var(--ok) 55%, var(--line)); }

  /* ── Controls ───────────────────────────────────────────────────────────── */
  button { font:12px/1 var(--sans); font-weight:550; padding:7px 11px; border-radius:var(--r1);
           border:1px solid var(--line2); background:var(--panel2); color:var(--fg); cursor:pointer;
           transition:border-color .12s, color .12s, background .12s; min-height:32px; }
  button:hover { border-color:var(--accent); color:var(--accent); }
  button:active { transform:translateY(1px); }
  button.danger:hover { border-color:var(--bad); color:var(--bad); }
  input[type=checkbox] { width:16px; height:16px; accent-color:var(--accent); cursor:pointer; }
  input, select { font-family:var(--mono); }

  /* ── Charts ─────────────────────────────────────────────────────────────── */
  .charts { display:grid; gap:var(--s2); grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); }
  @media (max-width:520px) { .charts { grid-template-columns:repeat(2,minmax(0,1fr)); } }
  .chart { background:var(--panel2); border:1px solid var(--line); border-radius:var(--r2);
           padding:var(--s2); transition:border-color .15s; }
  .chartHead { display:flex; justify-content:space-between; align-items:baseline; gap:var(--s1);
               font-size:10px; text-transform:uppercase; letter-spacing:.05em; color:var(--dim); margin-bottom:5px; }
  .chartHead b { font:650 13px/1 var(--mono); color:var(--fg); font-variant-numeric:tabular-nums; }
  .chart canvas { width:100%; display:block; }
  .chart.warn { border-color:color-mix(in srgb, var(--warn) 60%, var(--line)); }
  .chart.bad  { border-color:color-mix(in srgb, var(--bad) 60%, var(--line)); }

  /* ── Settings ───────────────────────────────────────────────────────────── */
  .filterBar { display:flex; gap:var(--s2); align-items:center; flex-wrap:wrap; padding:var(--s2) var(--s3);
               border-bottom:1px solid var(--line); background:var(--panel2); }
  .filterBar input[type=search] { flex:1 1 200px; min-width:0; font:13px/1 var(--sans); padding:8px 10px;
    background:var(--bg); color:var(--fg); border:1px solid var(--line2); border-radius:var(--r1); }
  .filterBar label { font-size:12px; color:var(--dim); white-space:nowrap; display:flex; gap:6px;
                     align-items:center; cursor:pointer; }
  .cat { border-bottom:1px solid var(--line); }
  .cat:last-child { border-bottom:0; }
  .cat > summary { cursor:pointer; padding:10px var(--s3); font-weight:650; font-size:13px;
                   display:flex; justify-content:space-between; align-items:center; list-style:none; }
  .cat > summary:hover { background:var(--panel2); }
  .cat > summary::-webkit-details-marker { display:none; }
  .cat > summary::before { content:'▸'; color:var(--dim); margin-right:8px; transition:transform .15s;
                           display:inline-block; }
  .cat[open] > summary::before { transform:rotate(90deg); }
  .cat > summary span.count { color:var(--dim); font-weight:400; font:12px/1 var(--mono); }
  .setting { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:4px var(--s3);
             padding:11px var(--s3) 11px 32px; border-top:1px solid var(--line); align-items:center; }
  .setting .name { font-weight:600; }
  .setting .env { font:11px/1 var(--mono); color:var(--dim); }
  .setting .desc { grid-column:1/-1; color:var(--dim); font-size:12px; }
  .setting .ctl { display:flex; gap:var(--s1); align-items:center; }
  .setting input[type=number], .setting input[type=text], .setting select {
    font:12px/1 var(--mono); padding:7px 8px; width:120px; border-radius:var(--r1);
    border:1px solid var(--line2); background:var(--bg); color:var(--fg); min-height:32px; }
  .setting.changed { background:color-mix(in srgb, var(--accent) 7%, transparent); }
  .setting.changed .name::after { content:'changed'; margin-left:8px; font:10px/1 var(--mono);
    color:var(--warn); border:1px solid color-mix(in srgb, var(--warn) 60%, var(--line));
    border-radius:4px; padding:2px 5px; vertical-align:middle; }
  .badge { font:10px/1 var(--mono); padding:3px 6px; border-radius:4px;
           border:1px solid var(--warn); color:var(--warn); }
  .badge.set { border-color:var(--accent); color:var(--accent); }
  /* A setting that does nothing must LOOK like it does nothing, or it reads as a working knob. */
  .badge.inert { border-color:var(--warn); color:var(--warn); }
  .inertRow { opacity:.55; }
  .inertRow:hover, .inertRow:focus-within { opacity:1; }

  /* On a phone a two-column setting row squeezes the control to nothing —
     stack instead, and let the control span the full width. */
  @media (max-width:719px) {
    .setting { grid-template-columns:minmax(0,1fr); padding-left:var(--s3); }
    .setting .ctl { justify-content:flex-start; flex-wrap:wrap; }
    .setting input[type=number], .setting input[type=text], .setting select { width:100%; max-width:220px; }
  }

  /* ── Toasts ─────────────────────────────────────────────────────────────── */
  .toast { position:fixed; right:var(--s3); bottom:var(--s3); z-index:20; display:flex;
           flex-direction:column; gap:var(--s1); max-width:min(360px, calc(100vw - 2*var(--s3))); }
  .toast div { background:var(--panel); border:1px solid var(--line); border-left:3px solid var(--ok);
               padding:10px 14px; border-radius:var(--r2); font-size:13px; box-shadow:var(--shadow); }
  .toast div.err { border-left-color:var(--bad); }

  /* ── Phone trim ─────────────────────────────────────────────────────────── */
  @media (max-width:719px) {
    main { padding:var(--s2); gap:var(--s2); }
    header { padding:var(--s2); gap:var(--s1) var(--s2); }
    .pill { font-size:11px; padding:5px 8px; }
    section > h2 { padding:var(--s2); }
    .body, .filterBar { padding:var(--s2); }
    th, td { padding:7px 8px; }
  }
</style>
</head>
<body>
<header>
  <h1>ev.io custom server</h1>
  <span class="pill" id="conn"><span class="dot down"></span>connecting…</span>
  <span class="pill">tick <b id="tick">–</b></span>
  <span class="pill">rate <b id="rate">–</b> / <span id="rateTarget">–</span> Hz</span>
  <span class="pill">players <b id="pcount">0</b></span>
  <span class="pill">uptime <b id="uptime">–</b></span>
  <span class="pill" id="modePill">–</span>
  <span class="pill" id="netPill" title="Netcode health — see the netcode notes in local_ws_server.js">net –</span>
  <span class="pill">map <b id="mapPill">–</b></span>
  <span class="pill">round <b id="roundPill">–</b></span>
</header>

<nav id="tabs" role="tablist" aria-label="Dashboard sections">
  <button role="tab" data-tab="overview" aria-selected="true">📊 Overview</button>
  <button role="tab" data-tab="players"  aria-selected="false">👥 Players</button>
  <button role="tab" data-tab="controls" aria-selected="false">🎛️ Controls</button>
  <button role="tab" data-tab="map"      aria-selected="false">🗺️ Map</button>
  <button role="tab" data-tab="settings" aria-selected="false">⚙️ Settings</button>
  <span class="navSpacer"></span>
  <span class="muted navHint">press <kbd>1</kbd>–<kbd>5</kbd></span>
</nav>

<main>
  <section data-panel="overview">
    <h2>Telemetry <span class="muted" id="telemetryRange"></span></h2>
    <div class="charts" id="charts">
      <div class="chart"><div class="chartHead"><span>tick rate</span><b id="cvRate">–</b></div><canvas data-k="rate"    height="46"></canvas></div>
      <div class="chart"><div class="chartHead"><span>jitter (ms)</span><b id="cvJitter">–</b></div><canvas data-k="jitter" height="46"></canvas></div>
      <div class="chart"><div class="chartHead"><span>players</span><b id="cvPlayers">–</b></div><canvas data-k="players" height="46"></canvas></div>
      <div class="chart"><div class="chartHead"><span>reconcile lag</span><b id="cvLag">–</b></div><canvas data-k="lag"    height="46"></canvas></div>
      <div class="chart"><div class="chartHead"><span>queued input</span><b id="cvQueued">–</b></div><canvas data-k="queued" height="46"></canvas></div>
      <div class="chart"><div class="chartHead"><span>errors/s</span><b id="cvErrs">–</b></div><canvas data-k="errs"   height="46"></canvas></div>
    </div>
    <div class="muted" id="telemetryNote" style="margin-top:8px; font-size:12px"></div>
  </section>

  <section data-panel="players">
    <h2>Live players <span class="muted" id="wsUrl"></span></h2>
    <div class="scroll"><table id="players">
      <thead><tr>
        <th>name</th><th>id</th><th>state</th><th class="num">hp</th><th class="num">x</th><th class="num">y</th>
        <th class="num">z</th><th class="num">spd</th><th class="num">wpn</th><th class="num">ammo</th>
        <th class="num">atc</th><th class="num">cTick</th><th class="num">echo</th><th class="num">q</th><th class="num">err</th><th class="num">look</th><th class="num">appl</th><th>actions</th>
      </tr></thead>
      <tbody></tbody>
    </table></div>
    <div class="empty" id="noPlayers">No players connected. Join at
      <code>https://ev.io/?evioCustom=1&amp;server=ws://127.0.0.1:8080</code></div>
  </section>

  <section data-panel="controls">
    <h2>Announce <span class="muted">say something to everyone in game chat</span></h2>
    <div class="body">
      <div class="row">
        <input id="announceText" type="text" maxlength="200" placeholder="Message to all players…"
               autocomplete="off" class="grow">
        <button id="announceSend" class="primary">Send</button>
      </div>
      <div class="chipRow" id="announceQuick">
        <button class="chip" data-msg="Round starting — good luck!">🏁 Round starting</button>
        <button class="chip" data-msg="Server restarting shortly.">🔧 Restarting soon</button>
        <button class="chip" data-msg="Switching map — hold on.">🗺️ Map change</button>
        <button class="chip" data-msg="gg!">👏 gg</button>
      </div>
      <p class="muted note">Announcements are HTML-escaped before they are sent. The client renders
        chat with <code>innerHTML</code>, so this is what stops a message becoming script injection
        in every connected browser.</p>
    </div>
  </section>

  <section data-panel="controls">
    <h2>Match <span class="muted" id="matchInfo"></span></h2>
    <div class="body">
      <div class="chipRow">
        <button data-srv="restartround">🔄 Restart round</button>
        <button data-srv="endround">⏭️ End round now</button>
        <button data-srv="addtime" data-arg="1200">➕ 1 min</button>
        <button data-srv="addtime" data-arg="-1200">➖ 1 min</button>
      </div>
      <h3>Everyone</h3>
      <div class="chipRow">
        <button data-srv="healall">💚 Heal all</button>
        <button data-srv="respawnall">♻️ Respawn all</button>
        <button data-srv="gather">🧲 Gather all</button>
        <button data-srv="slapall" data-arg="18" class="fun">👋 Slap all</button>
        <button data-srv="killall" class="danger">💀 Kill all</button>
      </div>
      <p class="muted note">“Gather” pulls everyone to spawn 0 in a ring so they do not land inside
        one another. “Slap” is the grenade impulse path, so the client reconciles it as ordinary
        knockback instead of snapping.</p>
    </div>
  </section>

  <section data-panel="controls">
    <h2>Presets <span class="muted">one click, several settings</span></h2>
    <div class="body">
      <div class="presetGrid" id="presets"></div>
      <p class="muted note">Presets go through the ordinary settings path, so bounds, the change log
        and persistence all behave exactly as if each value had been typed by hand.</p>
    </div>
  </section>

  <section data-panel="map">
    <h2>Map <span class="muted" id="mapActive"></span></h2>
    <div class="body">
      <div style="display:flex; gap:8px; align-items:center; flex-wrap:wrap;">
        <select id="mapSelect" style="flex:1; min-width:220px; font:13px/1 inherit; padding:7px;
                border-radius:6px; border:1px solid var(--line); background:var(--bg); color:var(--fg);"></select>
        <button id="mapLoad">Load map</button>
      </div>
      <p class="muted" style="margin:10px 0 0; font-size:12px;">
        Maps are downloaded from ev.io on first use and cached on disk, so nothing large ships with
        the server. <b>&#9679;</b> marks maps already cached (instant). Switching reloads the map for
        every connected player and starts a fresh round.
      </p>
      <div id="mapStatus" class="muted" style="margin-top:8px; font:12px/1.5 var(--mono);"></div>
    </div>
  </section>

  <section data-panel="settings">
    <h2>Settings <button id="refreshSettings">reload</button></h2>
    <div class="filterBar">
      <input id="settingFilter" type="search" placeholder="Filter settings — name, key, or description…"
             autocomplete="off" spellcheck="false">
      <label><input type="checkbox" id="changedOnly"> changed only</label>
      <span class="muted" id="settingCount"></span>
    </div>
    <div id="settings"></div>
  </section>
</main>

<div class="toast" id="toast"></div>

<script>
  // Admin token plumbing. The token may arrive as ?token=... on the first load; stash it in
  // sessionStorage (per-tab, cleared on close) and strip it from the address bar so it does not
  // linger in history or get shoulder-surfed. Every later request sends it as a header.
  (function () {
    try {
      var u = new URL(location.href);
      var t = u.searchParams.get('token');
      if (t) {
        sessionStorage.setItem('evioAdminToken', t);
        u.searchParams.delete('token');
        history.replaceState(null, '', u.pathname + (u.search || '') + u.hash);
      }
    } catch (e) {}
    var real = window.fetch;
    window.fetch = function (input, init) {
      init = init || {};
      var tok = null;
      try { tok = sessionStorage.getItem('evioAdminToken'); } catch (e) {}
      if (tok) {
        init.headers = Object.assign({}, init.headers || {}, { 'x-evio-admin-token': tok });
      }
      return real(input, init).then(function (r) {
        if (r.status === 401) {
          document.body.innerHTML =
            '<div style="font:14px system-ui;padding:24px;color:#e57373">' +
            'Unauthorised. Reload with <code>?token=YOUR_TOKEN</code> (the value of ' +
            'EVIO_ADMIN_TOKEN on the server).</div>';
        } else if (r.status === 429) {
          document.body.innerHTML =
            '<div style="font:14px system-ui;padding:24px;color:#e57373">' +
            'Too many failed attempts — locked out briefly. Check the token and try again.</div>';
        }
        return r;
      });
    };
  })();

(function () {
  'use strict';
  var $ = function (id) { return document.getElementById(id); };
  var settingsCache = [];
  var openCats = {};

  function toast(msg, isErr) {
    var d = document.createElement('div');
    if (isErr) d.className = 'err';
    d.textContent = msg;
    $('toast').appendChild(d);
    setTimeout(function () { d.remove(); }, isErr ? 6000 : 2600);
  }

  function fmtUptime(ms) {
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    if (h) return h + 'h ' + m + 'm';
    if (m) return m + 'm ' + (s % 60) + 's';
    return s + 's';
  }

  // ── Status polling ──────────────────────────────────────────────────────
  // ── Sparklines ─────────────────────────────────────────────────────────────
  // Drawn on a canvas with no library: the page ships with a strict CSP that forbids loading
  // anything external, and a chart dependency would be far more code than the 30 lines below.
  var SERIES = {
    rate:    { fmt: function (v) { return v.toFixed(1) + ' Hz'; }, el: 'cvRate',
               // The known failure here is the tick loop sagging to ~16Hz on Windows timer
               // granularity, so judge against the TARGET rather than a fixed number.
               grade: function (v, st) { var t = st.targetTickRate || 20;
                 return v < t * 0.9 ? 'bad' : v < t * 0.98 ? 'warn' : ''; } },
    jitter:  { fmt: function (v) { return v.toFixed(0) + ' ms'; }, el: 'cvJitter',
               grade: function (v) { return v > 25 ? 'bad' : v > 10 ? 'warn' : ''; } },
    players: { fmt: function (v) { return String(v); }, el: 'cvPlayers', grade: function () { return ''; } },
    lag:     { fmt: function (v) { return v + ' ticks'; }, el: 'cvLag',
               // Beyond ~3 ticks the client is predicting well past what we have confirmed.
               grade: function (v) { return v > 6 ? 'bad' : v > 3 ? 'warn' : ''; } },
    queued:  { fmt: function (v) { return String(v); }, el: 'cvQueued',
               grade: function (v) { return v > 4 ? 'bad' : v > 2 ? 'warn' : ''; } },
    errs:    { fmt: function (v) { return String(v); }, el: 'cvErrs',
               grade: function (v) { return v > 0 ? 'bad' : ''; } },
  };

  function drawSpark(canvas, values, cls) {
    // Backing-store sizing. The CSS height is the source of truth and is read ONCE into a data
    // attribute; never read it back off canvas.height, because that property already holds the
    // DPR-scaled value. Doing so multiplies by DPR on every render — on a 125%-scaled Windows
    // display the canvas grew 46 -> 57 -> 72 -> ... and blew past the ~32767px limit in about
    // fifteen seconds, at which point the draw threw, poll()'s .catch fired, and the dashboard
    // showed "offline" and stopped updating. On a 1.0-DPR screen it was invisible.
    var dpr = window.devicePixelRatio || 1;
    if (!canvas._cssH) canvas._cssH = canvas.height || 46;
    var w = Math.max(1, canvas.clientWidth || 160), h = canvas._cssH;
    canvas.style.height = h + 'px';
    var bw = Math.round(w * dpr), bh = Math.round(h * dpr);
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    var ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    if (!values.length) return;
    var min = Math.min.apply(null, values), max = Math.max.apply(null, values);
    // A flat series should read as flat, not as noise amplified to fill the box.
    if (max - min < 1e-9) { min -= 1; max += 1; }
    var pad = 3, iw = w - pad * 2, ih = h - pad * 2;
    var x = function (i) { return pad + (values.length === 1 ? iw / 2 : (i / (values.length - 1)) * iw); };
    var y = function (v) { return pad + ih - ((v - min) / (max - min)) * ih; };
    var stroke = cls === 'bad' ? '#f85149' : cls === 'warn' ? '#d29922' : '#3fb950';
    ctx.beginPath(); ctx.moveTo(x(0), y(values[0]));
    for (var i = 1; i < values.length; i++) ctx.lineTo(x(i), y(values[i]));
    ctx.lineTo(x(values.length - 1), pad + ih); ctx.lineTo(x(0), pad + ih); ctx.closePath();
    ctx.fillStyle = stroke + '22'; ctx.fill();
    ctx.beginPath(); ctx.moveTo(x(0), y(values[0]));
    for (var j = 1; j < values.length; j++) ctx.lineTo(x(j), y(values[j]));
    ctx.strokeStyle = stroke; ctx.lineWidth = 1.5; ctx.lineJoin = 'round'; ctx.stroke();
  }

  function renderTelemetry(st) {
    var hist = st.history || [];
    var range = $('telemetryRange');
    if (range) range.textContent = hist.length ? '· last ' + hist.length + 's' : '· collecting…';
    var note = $('telemetryNote');
    if (note) {
      note.textContent = hist.length < 5
        ? 'Graphs fill in at 1 sample/second once the game loop is running (it idles with no players).'
        : '';
    }
    Object.keys(SERIES).forEach(function (k) {
      var cfg = SERIES[k];
      var canvas = document.querySelector('canvas[data-k="' + k + '"]');
      if (!canvas) return;
      var vals = hist.map(function (h) { return Number(h[k]) || 0; });
      var last = vals.length ? vals[vals.length - 1] : 0;
      var cls = cfg.grade(last, st);
      drawSpark(canvas, vals, cls);
      var lab = $(cfg.el);
      if (lab) lab.textContent = vals.length ? cfg.fmt(last) : '–';
      var box = canvas.parentElement;
      if (box) { box.classList.remove('warn', 'bad'); if (cls) box.classList.add(cls); }
    });
  }

  function renderStatus(st) {
    renderTelemetry(st);
    $('conn').innerHTML = '<span class="dot up"></span>online';
    $('tick').textContent = st.globalTick;
    $('rate').textContent = st.tickRate.toFixed(1);
    $('rateTarget').textContent = st.targetTickRate;
    // Colour the tick rate by health. It is the single best indicator of overload: it holds a flat
    // 20.00 right up to saturation and then falls off a cliff, and a slow tick desyncs everyone.
    // Overruns climb BEFORE the rate visibly drops, so they are the earlier warning of the two.
    (function () {
      var el = $('rate');
      var over = st.tickOverruns || 0;
      var behind = st.targetTickRate ? (st.tickRate / st.targetTickRate) : 1;
      var bad = st.tickRate > 0 && behind < 0.95;
      var warn = !bad && over > (el.__lastOver || 0);
      el.__lastOver = over;
      el.style.color = bad ? 'var(--bad)' : (warn ? 'var(--warn)' : '');
      el.title = 'last tick ' + (st.tickMsLast || 0) + 'ms / budget ' + (st.tickBudgetMs || 50)
        + 'ms · worst ' + (st.tickMsWorst || 0) + 'ms · overruns ' + over
        + (bad ? ' — OVERLOADED: the tick rate has dropped, players will desync' : '');
    })();
    $('pcount').textContent = st.playerCount;
    $('uptime').textContent = fmtUptime(st.uptimeMs);
    $('wsUrl').textContent = st.listening || '';
    $('mapPill').textContent = st.map || '–';
    $('roundPill').textContent = st.round + ' · ' + st.roundPhase + ' · ' + st.roundSecondsLeft + 's';
    $('modePill').textContent = (st.swordOnly ? 'sword-only' : 'all weapons')
      + ' · ' + st.tickModel + ' · echo ' + st.echoLagTicks;

    // ── Netcode health ────────────────────────────────────────────────────
    // Three faults here were each invisible for weeks, so surface them permanently rather than
    // relying on someone thinking to look:
    //   tick/sim errors — a throwing tick used to kill the whole game loop silently.
    //   echo lag > 0    — moves the echo LABEL without moving the state BODY, so the client
    //                     compares its prediction against the wrong tick and corrects every tick
    //                     while rotating. Depth is the correct knob; this one should stay 0.
    //   input loss      — look = received vs queued, appl = queued vs applied.
    var net = [], bad = false;
    if (st.tickErrors) { net.push(st.tickErrors + ' tick err'); bad = true; }
    if (st.simErrors)  { net.push(st.simErrors + ' sim err');  bad = true; }
    if (st.echoLagTicks > 0) { net.push('echo lag ' + st.echoLagTicks + '!'); bad = true; }
    var worstLook = null;
    st.players.forEach(function (p) {
      if (p.lookKept != null && (worstLook === null || p.lookKept < worstLook)) worstLook = p.lookKept;
      if (p.lookApplied != null && (worstLook === null || p.lookApplied < worstLook)) worstLook = p.lookApplied;
    });
    if (worstLook !== null && worstLook < 0.99) { net.push('input ' + worstLook.toFixed(2)); bad = true; }
    var np = $('netPill');
    np.textContent = 'net ' + (net.length ? net.join(' · ') : 'ok');
    np.style.color = bad ? '#ff5f56' : '';
    np.title = bad
      ? 'Something is wrong: ' + net.join(', ')
      : 'No tick/sim faults, echo label matches the state body, and all client input reaches the sim';

    var tb = document.querySelector('#players tbody');
    $('noPlayers').style.display = st.players.length ? 'none' : 'block';
    tb.innerHTML = '';
    st.players.forEach(function (p) {
      var tr = document.createElement('tr');
      function td(txt, cls) {
        var e = document.createElement('td');
        if (cls) e.className = cls;
        e.textContent = txt;
        return e;
      }
      var nameTd = td(p.name || '—');
      if (p.isBot) {
        var botBadge = document.createElement('span');
        botBadge.className = 'badge';
        botBadge.textContent = 'BOT';
        botBadge.title = 'Server-driven bot (see the Bots setting category for count/level)';
        botBadge.style.marginLeft = '6px';
        nameTd.appendChild(botBadge);
      }
      tr.appendChild(nameTd);
      tr.appendChild(td(p.playerId == null ? '—' : p.playerId, 'num'));
      var stateTd = document.createElement('td');
      var tag = document.createElement('span');
      tag.className = 'tag ' + (p.dead ? 'dead' : 'alive');
      tag.textContent = p.dead ? 'dead' : (p.grounded ? (p.sprinting ? 'sprint' : (p.crouching ? 'crouch' : 'ground')) : 'air');
      stateTd.appendChild(tag);
      tr.appendChild(stateTd);
      tr.appendChild(td(p.health == null ? '—' : Math.round(p.health * 100), 'num'));
      tr.appendChild(td(p.position ? p.position.x.toFixed(1) : '—', 'num'));
      tr.appendChild(td(p.position ? p.position.y.toFixed(1) : '—', 'num'));
      tr.appendChild(td(p.position ? p.position.z.toFixed(1) : '—', 'num'));
      tr.appendChild(td(p.speed == null ? '—' : p.speed.toFixed(1), 'num'));
      tr.appendChild(td(p.weapon == null ? '—' : p.weapon, 'num'));
      tr.appendChild(td(p.ammo == null ? '—' : p.ammo, 'num'));
      tr.appendChild(td(p.actionTickCounter == null ? '—' : p.actionTickCounter, 'num'));
      tr.appendChild(td(p.lastClientTick == null ? '—' : p.lastClientTick, 'num'));
      tr.appendChild(td(p.processedClientTick == null ? '—' : p.processedClientTick, 'num'));
      tr.appendChild(td(p.queuedInputs == null ? '—' : p.queuedInputs, 'num'));
      // err: this player's sim threw and was contained. Non-zero explains a desync that hits one
      // player while everyone else is fine, so make it stand out rather than blend into the row.
      var errTd = td(p.simErrors ? p.simErrors : '—', 'num');
      if (p.simErrors) errTd.style.color = '#ff5f56';
      tr.appendChild(errTd);
      // look: fraction of the client's rotation that actually reached the sim. Below ~0.99 the
      // server turns less far than the client, which reads in-game as stutter while rotating.
      var lk = p.lookKept;
      var lkTd = td(lk == null ? '—' : lk.toFixed(3), 'num');
      if (lk != null && lk < 0.99) lkTd.style.color = '#ff5f56';
      lkTd.title = p.lostBy ? JSON.stringify(p.lostBy) : 'no input discarded';
      tr.appendChild(lkTd);
      // appl: fraction of received rotation that actually reached the simulation. The look
      // column can read 1.0 (nothing discarded on ingest) while this is low — sub-frames that were
      // queued and then never folded.
      var ap = p.lookApplied;
      var apTd = td(ap == null ? '—' : ap.toFixed(3), 'num');
      if (ap != null && ap < 0.99) apTd.style.color = '#ff5f56';
      apTd.title = 'received rotation that reached the sim (queue -> applied)';
      tr.appendChild(apTd);
      var act = document.createElement('td');
      // [action, label, class, arg]
      [['heal', 'heal', '', undefined],
       ['respawn', 'respawn', '', undefined],
       ['slap', 'slap', 'fun', 18],
       ['teleport', 'tp', '', undefined],
       ['kill', 'kill', 'danger', undefined],
       ['kick', 'kick', 'danger', undefined]]
        .forEach(function (a) {
          var b = document.createElement('button');
          b.textContent = a[1];
          if (a[2]) b.className = a[2];
          b.onclick = function () { playerAction(p.sessionId, a[0], a[3]); };
          act.appendChild(b);
        });
      tr.appendChild(act);
      tb.appendChild(tr);
    });
  }

  // Separate the two failure modes. A NETWORK failure means offline; a RENDER failure is a bug in
  // this page and must not be reported as the server being down — that conflation is what made a
  // canvas-sizing bug look like a dropped connection. A render throw is logged once and the poll
  // keeps running, so one bad panel cannot take the whole dashboard with it.
  var renderFailed = false;
  function poll() {
    fetch('/api/status')
      .then(function (r) { return r.json(); })
      .then(function (st) {
        try {
          renderStatus(st);
          renderFailed = false;
        } catch (e) {
          if (!renderFailed) { renderFailed = true; console.error('[admin] render error', e); }
        }
      })
      .catch(function () { $('conn').innerHTML = '<span class="dot down"></span>offline'; });
  }

  function playerAction(sessionId, action, arg) {
    fetch('/api/player', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ sessionId: sessionId, action: action, arg: arg })
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r.ok) { toast(action + ' ok'); poll(); }
      else toast(action + ' failed: ' + r.err, true);
    });
  }

  // ── Tabs ────────────────────────────────────────────────────────────────
  // Several sections can share a data-panel name, so a tab can group more than one panel (Controls
  // is three). The choice is remembered per tab so a poll-driven refresh never yanks you back.
  function showTab(name) {
    var panels = document.querySelectorAll('section[data-panel]');
    for (var i = 0; i < panels.length; i++) {
      panels[i].hidden = panels[i].getAttribute('data-panel') !== name;
    }
    var tabs = document.querySelectorAll('nav#tabs button[data-tab]');
    for (var j = 0; j < tabs.length; j++) {
      tabs[j].setAttribute('aria-selected', tabs[j].getAttribute('data-tab') === name ? 'true' : 'false');
    }
    try { sessionStorage.setItem('evio.tab', name); } catch (e) {}
  }
  (function initTabs() {
    var tabs = document.querySelectorAll('nav#tabs button[data-tab]');
    for (var i = 0; i < tabs.length; i++) {
      (function (b) {
        b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
      })(tabs[i]);
    }
    var saved = null;
    try { saved = sessionStorage.getItem('evio.tab'); } catch (e) {}
    showTab(saved || 'overview');

    // Number keys jump between tabs — but never while typing, or the announce box becomes unusable.
    document.addEventListener('keydown', function (ev) {
      var t = ev.target || {};
      var tag = (t.tagName || '').toLowerCase();
      if (tag === 'input' || tag === 'textarea' || tag === 'select' || ev.metaKey || ev.ctrlKey || ev.altKey) return;
      var idx = '12345'.indexOf(ev.key);
      if (idx === -1) return;
      var order = ['overview', 'players', 'controls', 'map', 'settings'];
      if (order[idx]) { showTab(order[idx]); ev.preventDefault(); }
    });
  })();

  // ── Server-wide actions ─────────────────────────────────────────────────
  function serverAction(action, arg) {
    return fetch('/api/server', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ action: action, arg: arg })
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r.ok) {
        var extra = (r.affected !== undefined) ? ' (' + r.affected + ')' : '';
        toast(action + ' ok' + extra); poll();
      } else toast(action + ' failed: ' + r.err, true);
      return r;
    });
  }
  (function initServerButtons() {
    var btns = document.querySelectorAll('button[data-srv]');
    for (var i = 0; i < btns.length; i++) {
      (function (b) {
        b.addEventListener('click', function () {
          var act = b.getAttribute('data-srv');
          var arg = b.getAttribute('data-arg');
          // The irreversible ones ask first. Everything else is cheap to undo.
          if (act === 'killall' && !confirm('Kill every connected player?')) return;
          serverAction(act, arg === null ? undefined : (isNaN(Number(arg)) ? arg : Number(arg)));
        });
      })(btns[i]);
    }
  })();

  // ── Announcements ───────────────────────────────────────────────────────
  (function initAnnounce() {
    var box = $('announceText'), send = $('announceSend');
    if (!box || !send) return;
    function fire() {
      var msg = box.value.trim();
      if (!msg) { toast('nothing to announce', true); return; }
      serverAction('announce', msg).then(function (r) { if (r.ok) box.value = ''; });
    }
    send.addEventListener('click', fire);
    box.addEventListener('keydown', function (ev) { if (ev.key === 'Enter') fire(); });
    var quick = document.querySelectorAll('#announceQuick button[data-msg]');
    for (var i = 0; i < quick.length; i++) {
      (function (b) {
        b.addEventListener('click', function () { serverAction('announce', b.getAttribute('data-msg')); });
      })(quick[i]);
    }
  })();

  // ── Presets ─────────────────────────────────────────────────────────────
  function loadPresets() {
    fetch('/api/presets').then(function (r) { return r.json(); }).then(function (d) {
      var host = $('presets');
      if (!host) return;
      host.textContent = '';
      (d.presets || []).forEach(function (p) {
        var b = document.createElement('button');
        b.className = 'preset';
        // textContent throughout — preset text is ours, but building DOM by string concatenation is
        // how an injection bug eventually arrives.
        var t = document.createElement('span'); t.className = 'pTitle';
        t.textContent = (p.emoji ? p.emoji + '  ' : '') + p.label;
        var d2 = document.createElement('span'); d2.className = 'pDesc';
        d2.textContent = p.desc + ' (' + p.keys + ' settings)';
        b.appendChild(t); b.appendChild(d2);
        b.addEventListener('click', function () {
          fetch('/api/preset', {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ preset: p.id })
          }).then(function (r) { return r.json(); }).then(function (r) {
            if (r.ok) {
              toast(r.label + ' applied (' + r.applied.length + ' settings)');
              loadSettings();
            } else toast('preset failed: ' + r.err, true);
          });
        });
        host.appendChild(b);
      });
    }).catch(function () { /* dashboard still works without presets */ });
  }

  // ── Settings ────────────────────────────────────────────────────────────
  function loadSettings() {
    var fi = $('settingFilter'), co = $('changedOnly');
    if (fi && !fi._wired) { fi._wired = 1; fi.addEventListener('input', renderSettings); }
    if (co && !co._wired) { co._wired = 1; co.addEventListener('change', renderSettings); }
    fetch('/api/settings').then(function (r) { return r.json(); }).then(function (d) {
      settingsCache = d.settings;
      renderSettings();
    });
  }

  function commit(key, value, el) {
    fetch('/api/settings', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: key, value: value })
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (!r.ok) { toast(key + ': ' + r.err, true); loadSettings(); return; }
      toast(key + ' = ' + r.value + (r.restartRequired ? ' (restart required)' : ''));
      if (el) { el.closest('.setting').classList.add('changed'); }
      // Refresh so derived settings (crouch speed, sprint thresholds) show their new values.
      loadSettings();
    });
  }

  function resetSetting(key) {
    fetch('/api/settings/reset', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ key: key })
    }).then(function (r) { return r.json(); }).then(function (r) {
      if (r.ok) { toast(key + ' reset to ' + r.value); loadSettings(); }
      else toast(key + ': ' + r.err, true);
    });
  }

  // A setting counts as "changed" when its live value differs from the value it would have had
  // from env/default — that is what the registry's 'explicit' flag tracks, and it is the single
  // most useful thing to know at a glance when a server is misbehaving. NOTE: this text lives
  // inside the PAGE template literal, so it must never contain a backtick.
  // see at a glance when a server is behaving oddly.
  function isChanged(s) {
    if (s.explicit) return true;
    return s.default !== undefined && s.default !== null && String(s.value) !== String(s.default);
  }
  function settingMatches(s, q) {
    if (!q) return true;
    var hay = (s.label + ' ' + s.key + ' ' + (s.env || '') + ' ' + (s.desc || '') + ' ' + s.category).toLowerCase();
    // AND across terms so "combat zoom" narrows instead of widening.
    return q.split(/\s+/).every(function (t) { return hay.indexOf(t) !== -1; });
  }

  function renderSettings() {
    var q = (($('settingFilter') || {}).value || '').trim().toLowerCase();
    var onlyChanged = !!(($('changedOnly') || {}).checked);
    var visible = settingsCache.filter(function (s) {
      return settingMatches(s, q) && (!onlyChanged || isChanged(s));
    });
    var cnt = $('settingCount');
    if (cnt) {
      cnt.textContent = (q || onlyChanged)
        ? visible.length + ' / ' + settingsCache.length
        : settingsCache.length + ' settings';
    }
    var byCat = {};
    visible.forEach(function (s) { (byCat[s.category] = byCat[s.category] || []).push(s); });
    var order = ['Gameplay', 'Combat', 'Bots', 'Movement', 'Netcode', 'Grenades', 'Feedback', 'Protocol', 'Server', 'Debug'];
    var cats = Object.keys(byCat).sort(function (a, b) {
      var ia = order.indexOf(a), ib = order.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
    var root = $('settings');
    root.innerHTML = '';
    cats.forEach(function (cat) {
      var det = document.createElement('details');
      det.className = 'cat';
      if (openCats[cat] === undefined) openCats[cat] = (cat === 'Gameplay' || cat === 'Combat' || cat === 'Bots');
      // While a filter is active every surviving category is opened — otherwise a match can sit
      // hidden inside a collapsed group and the search looks broken.
      det.open = (q || onlyChanged) ? true : openCats[cat];
      det.addEventListener('toggle', function () { openCats[cat] = det.open; });
      var sum = document.createElement('summary');
      sum.innerHTML = '<span>' + cat + '</span><span class="count">' + byCat[cat].length + '</span>';
      det.appendChild(sum);
      byCat[cat].forEach(function (s) { det.appendChild(settingRow(s)); });
      root.appendChild(det);
    });
  }

  function settingRow(s) {
    var row = document.createElement('div');
    row.className = 'setting' + (isChanged(s) ? ' changed' : '');

    var left = document.createElement('div');
    var name = document.createElement('div');
    name.className = 'name';
    name.textContent = s.label;
    if (!s.live) {
      var b = document.createElement('span');
      b.className = 'badge';
      b.textContent = 'restart';
      b.title = 'Changing this only takes effect when the server restarts';
      name.appendChild(document.createTextNode(' '));
      name.appendChild(b);
    }
    // INERT: declared and persisted, but consumed by nothing that runs. Marked loudly, because a
    // knob that silently does nothing makes an operator conclude the GAME is broken rather than the
    // setting. Kept in the list (not hidden) so a documented EVIO_* var is still discoverable.
    if (s.inert) {
      var bi = document.createElement('span');
      bi.className = 'badge inert';
      bi.textContent = 'no effect';
      bi.title = 'This setting does nothing: ' + s.inert;
      name.appendChild(document.createTextNode(' '));
      name.appendChild(bi);
      row.className += ' inertRow';
    }
    if (s.explicit) {
      var b2 = document.createElement('span');
      b2.className = 'badge set';
      b2.textContent = 'set';
      b2.title = 'Explicitly set (env or here) rather than the default';
      name.appendChild(document.createTextNode(' '));
      name.appendChild(b2);
    }
    left.appendChild(name);
    if (s.env) {
      var env = document.createElement('div');
      env.className = 'env';
      env.textContent = s.env;
      left.appendChild(env);
    }
    row.appendChild(left);

    var ctl = document.createElement('div');
    ctl.className = 'ctl';
    var input;
    if (s.type === 'bool') {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = !!s.value;
      input.onchange = function () { commit(s.key, input.checked, input); };
    } else if (s.type === 'enum') {
      input = document.createElement('select');
      s.choices.forEach(function (c) {
        var o = document.createElement('option');
        o.value = c; o.textContent = c;
        if (c === s.value) o.selected = true;
        input.appendChild(o);
      });
      input.onchange = function () { commit(s.key, input.value, input); };
    } else if (s.type === 'string') {
      input = document.createElement('input');
      input.type = 'text';
      input.value = s.value;
      input.onchange = function () { commit(s.key, input.value, input); };
    } else {
      input = document.createElement('input');
      input.type = 'number';
      input.value = s.value;
      if (s.min !== null) input.min = s.min;
      if (s.max !== null) input.max = s.max;
      if (s.step !== null) input.step = s.step;
      else if (s.type === 'int') input.step = 1;
      input.onchange = function () { commit(s.key, input.value, input); };
    }
    ctl.appendChild(input);

    var rst = document.createElement('button');
    rst.textContent = '↺';
    rst.title = 'Reset to default (' + s['default'] + ')';
    rst.onclick = function () { resetSetting(s.key); };
    ctl.appendChild(rst);
    row.appendChild(ctl);

    if (s.desc) {
      var d = document.createElement('div');
      d.className = 'desc';
      d.textContent = s.desc;
      row.appendChild(d);
    }
    return row;
  }

  // ── Maps ────────────────────────────────────────────────────────────────
  function loadMaps() {
    fetch('/api/maps').then(function (r) { return r.json(); }).then(function (d) {
      var sel = $('mapSelect');
      var keep = sel.value;
      sel.innerHTML = '';
      d.maps.forEach(function (m) {
        var o = document.createElement('option');
        o.value = m.nid;
        // A filled dot marks maps already on disk — those switch instantly.
        o.textContent = (m.cached ? '● ' : '○ ') + m.title;
        sel.appendChild(o);
      });
      if (keep) sel.value = keep;
      $('mapActive').textContent = d.active ? 'active: ' + d.active : '';
    });
  }
  $('mapLoad').onclick = function () {
    var sel = $('mapSelect');
    var title = sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent.slice(2) : '';
    $('mapStatus').textContent = 'loading ' + title + ' (first use downloads ~2-10 MB)...';
    $('mapLoad').disabled = true;
    fetch('/api/map', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ map: sel.value })
    }).then(function (r) { return r.json(); }).then(function (r) {
      $('mapLoad').disabled = false;
      if (!r.ok) { $('mapStatus').textContent = 'failed: ' + r.err; toast('map load failed: ' + r.err, true); return; }
      $('mapStatus').textContent = r.map + ' loaded — ' + r.tris + ' triangles, ' + r.spawns
        + ' spawns, ' + (r.fromCache ? 'from cache' : 'downloaded') + ' (generation ' + r.generation + ')';
      toast('map -> ' + r.map);
      loadMaps();
    }).catch(function (e) {
      $('mapLoad').disabled = false;
      $('mapStatus').textContent = 'failed: ' + e.message;
    });
  };
  loadMaps();

  $('refreshSettings').onclick = loadSettings;
  loadSettings();
  loadPresets();
  poll();
  setInterval(poll, 500);
})();
</script>
</body>
</html>`;

module.exports = { startAdminServer, ADMIN_HOST, ADMIN_PORT };
