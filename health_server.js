/**
 * health_server.js — a minimal, PUBLICLY-SAFE liveness endpoint, separate from the admin dashboard.
 *
 * Before this existed, the only way to check whether the server was actually up (not just "the
 * process exists", but "the tick loop is running and not degraded") was SSH + journalctl, or the
 * admin dashboard — which is loopback-only and behind an SSH tunnel by design (it can kick, kill,
 * teleport and rewrite every gameplay constant; reachability IS its threat model, see
 * admin_server.js). That's the right call for admin, but it means no external uptime monitor
 * (UptimeRobot, a cron+curl check, etc.) has anything to poll without SSH access.
 *
 * This is deliberately NOT the admin server with fewer endpoints bolted on: it serves exactly one
 * route (GET /healthz), returns a small subset of getStatus() picked for being genuinely harmless
 * to expose (uptime, player COUNT, tick health — no session IDs, IPs, positions, or chat), and has
 * no write endpoints at all. Bound to loopback by default, same as admin — a production deploy
 * exposes it by having Caddy reverse-proxy a path on the SAME public domain to this loopback port
 * (see deploy/tls.sh), so no new firewall rule is needed either.
 *
 * Off by default (EVIO_HEALTH unset or "0") so every existing test/local-dev run is unaffected;
 * provision.sh opts production in explicitly.
 *
 * Returns HTTP 200 when the tick loop is actually running and not mid-drain, 503 otherwise — so a
 * monitor can alert on "non-200" alone without parsing the body.
 */
'use strict';

const http = require('http');

const HEALTH_HOST = process.env.EVIO_HEALTH_HOST || '127.0.0.1';
const HEALTH_PORT = Number(process.env.EVIO_HEALTH_PORT || 8082);

function publicHealth(status) {
  const ok = !status.draining && status.tickRate > 0;
  return {
    ok,
    uptimeMs: status.uptimeMs,
    playerCount: status.playerCount,
    map: status.map,
    tickRate: status.tickRate,
    targetTickRate: status.targetTickRate,
    tickErrors: status.tickErrors,
    tickOverruns: status.tickOverruns,
    draining: status.draining,
  };
}

/**
 * @param {object} game  the local_ws_server module (getStatus() is the only thing this reads)
 */
function startHealthServer(game) {
  const server = http.createServer((req, res) => {
    // A public, unauthenticated endpoint WILL see clients that connect and reset/abort mid-request
    // — scanners, monitors with a short timeout, a flaky link. Without a handler here, that surfaces
    // as an uncaught 'error' event and crashes the ENTIRE server process, not just this one request
    // — a health check that can itself take the game down is worse than not having one.
    req.on('error', () => {});
    res.on('error', () => {});

    const path = (req.url || '/').split('?')[0];
    if (req.method !== 'GET' || (path !== '/healthz' && path !== '/health')) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('not found');
    }
    let body;
    try {
      body = JSON.stringify(publicHealth(game.getStatus()));
    } catch (err) {
      // A throw here means getStatus() itself is broken — report that as unhealthy rather than
      // crashing the health check along with it (an external monitor seeing 500 is still useful
      // signal; a health endpoint that can itself 500 the process would defeat the point).
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, err: String(err && err.message || err) }));
    }
    const healthy = JSON.parse(body).ok;
    res.writeHead(healthy ? 200 : 503, {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    });
    res.end(body);
  });

  server.on('error', (err) => {
    console.error(`[evio-health] server error: ${err.stack || err.message}`);
  });

  server.listen(HEALTH_PORT, HEALTH_HOST, () => {
    console.log(`[evio-health] listening on http://${HEALTH_HOST}:${HEALTH_PORT}/healthz`);
  });

  return server;
}

module.exports = { startHealthServer, HEALTH_HOST, HEALTH_PORT };
