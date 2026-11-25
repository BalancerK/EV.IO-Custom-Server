/**
 * test_custom_maps.js — custom_maps/: listing, lookup, path safety, physics build, and the
 * GET /maps/<file> endpoint clients download custom maps from.
 *
 * Uses a temporary custom-maps folder holding a copy of default_map.evmap, so it needs no network
 * and touches nothing in the real custom_maps/.
 *
 * Usage:  node scripts/test_custom_maps.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evio-custom-maps-'));
fs.copyFileSync(path.join(__dirname, '..', 'default_map.evmap'), path.join(dir, 'test-arena_v2.evmap'));
fs.writeFileSync(path.join(dir, 'notes.txt'), 'not a map');
process.env.EVIO_CUSTOM_MAPS = dir;
process.env.EVIO_PUBLIC_HTTP_BASE = 'http://example.test:9000/';
process.env.EVIO_ADMIN = '0';

const bpw = require('../physics_world');
const ml = require('../map_loader');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

bpw.ready.then(async () => {
  console.log('\n── listing & lookup ──');
  const custom = ml.listCustomMaps();
  ok('only .evmap files are listed', custom.length === 1, JSON.stringify(custom.map((m) => m.nid)));
  const m = custom[0];
  ok('nid is custom:<file name>', m && m.nid === 'custom:test-arena_v2');
  ok('title is readable', m && m.title === 'Test Arena V2', m && m.title);
  ok('clients are sent the public base URL', m && m.evmapUrl === 'http://example.test:9000/maps/test-arena_v2.evmap', m && m.evmapUrl);
  ok('found by nid, title and URL', !!ml.findMap('custom:test-arena_v2') && !!ml.findMap('test arena v2') && !!ml.findMap(m.evmapUrl));
  ok('custom maps lead the dashboard list', ml.listAllMaps()[0].nid === 'custom:test-arena_v2');

  console.log('\n── path safety ──');
  ok('a listed file resolves', !!ml.customMapPath('test-arena_v2.evmap'));
  for (const bad of ['../default_map.evmap', '..\\default_map.evmap', 'notes.txt', '.hidden.evmap', 'sub/x.evmap', 'missing.evmap', '', null]) {
    ok(`refused: ${JSON.stringify(bad)}`, ml.customMapPath(bad) === null);
  }

  console.log('\n── physics build ──');
  const loaded = await ml.loadMap('custom:test-arena_v2');
  ok('builds a collision world from disk', !!loaded.world && loaded.tris > 1000, `${loaded.tris} tris`);
  ok('spawns come through', loaded.spawns.length > 0);
  const again = await ml.loadMap('custom:test-arena_v2');
  ok('an unchanged file is reused from the world cache', again.fromCache === true);

  console.log('\n── GET /maps/<file> on a live server ──');
  const port = 18700 + Math.floor(Math.random() * 200);
  const env = { ...process.env, EVIO_LOCAL_PORT: String(port), EVIO_ADMIN: '0', EVIO_NO_PERSIST: '1', EVIO_PUBLIC_HTTP_BASE: '' };
  const srv = spawn(process.execPath, [path.join(__dirname, '..', 'local_ws_server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start')), 30000);
    srv.stdout.on('data', (d) => { if (String(d).includes('listening on')) { clearTimeout(t); resolve(); } });
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    const r = await fetch(`${base}/maps/test-arena_v2.evmap`, { headers: { Origin: 'https://ev.io' } });
    const body = Buffer.from(await r.arrayBuffer());
    ok('200 with the exact file bytes', r.status === 200 && body.equals(fs.readFileSync(path.join(dir, 'test-arena_v2.evmap'))), `${r.status}`);
    ok('readable cross-origin (CORS)', r.headers.get('access-control-allow-origin') === '*');
    const pre = await fetch(`${base}/maps/test-arena_v2.evmap`, { method: 'OPTIONS', headers: { Origin: 'https://ev.io', 'Access-Control-Request-Private-Network': 'true' } });
    ok('preflight allows the private-network request', pre.status === 204 && pre.headers.get('access-control-allow-private-network') === 'true');
    for (const p of ['/maps/notes.txt', '/maps/..%2Fdefault_map.evmap', '/', '/api/status', '/maps/']) {
      const x = await fetch(base + p);
      ok(`404 for ${p}`, x.status === 404, `${x.status}`);
    }
    const head = await fetch(`${base}/maps/test-arena_v2.evmap`, { method: 'HEAD' });
    ok('HEAD works', head.status === 200);
    const post = await fetch(`${base}/maps/test-arena_v2.evmap`, { method: 'POST', body: 'x' });
    ok('POST is refused', post.status === 404);
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const first = await new Promise((resolve) => { ws.addEventListener('message', (e) => resolve(String(e.data)), { once: true }); setTimeout(() => resolve(''), 5000); });
    ok('the game socket still works on the same port', first.startsWith('ID'), first.slice(0, 20));
    ws.close();
  } finally {
    srv.kill();
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
