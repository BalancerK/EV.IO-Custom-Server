/**
 * test_test_map.js — uploaded test maps: built from bytes, served from memory only, never cached or
 * listed, transferable over the netlib chunk protocol, and dropped when another map is loaded.
 *
 * Runs a real server (game port + admin dashboard) on random ports and uploads default_map.evmap
 * through the dashboard's own API, so it needs no network.
 *
 * Usage:  node scripts/test_test_map.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const MAP = fs.readFileSync(path.join(ROOT, 'default_map.evmap'));
const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evio-testmap-cache-'));
const customDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evio-testmap-custom-'));
process.env.EVIO_MAP_CACHE = cacheDir;
process.env.EVIO_CUSTOM_MAPS = customDir;
process.env.EVIO_EXTRA_MAPS_URL = 'off';
// Bishop pre-cached (it is the same file as default_map.evmap) so switching back needs no download.
fs.writeFileSync(path.join(cacheDir, 'HUT8Bishop.evmap'), MAP);
const SEEDED = 'HUT8Bishop.evmap';

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const listing = (dir) => fs.readdirSync(dir).sort().join(',');

async function unit() {
  const bpw = require('../physics_world');
  await bpw.ready;
  const ml = require('../map_loader');
  const na = require('../netlib_adapter');

  console.log('\n── build from bytes ──');
  const t = ml.buildTestMap(MAP, 'C:\\maps\\My_Arena v3.evmap');
  ok('builds a collision world', !!t.world && t.tris > 1000, `${t.tris} tris`);
  ok('has spawns', t.spawns.length > 0);
  ok('key is a 32-hex content hash', /^[0-9a-f]{32}$/.test(t.map.key));
  ok('title comes from the file name', t.map.title === 'My Arena v3', t.map.title);
  ok('URL is /maps/test/<key>.evmap on the public base', t.map.evmapUrl === `${ml.publicBase()}/maps/test/${t.map.key}.evmap`, t.map.evmapUrl);
  for (const [bad, why] of [[Buffer.alloc(0), 'empty'], [Buffer.from('hello, not a map'), 'garbage'], [Buffer.alloc(ml.TEST_MAP_MAX_BYTES + 1), 'too big']]) {
    let err = null; try { ml.buildTestMap(bad, 'x'); } catch (e) { err = e; }
    ok(`refused: ${why}`, !!err, err ? err.message : 'no error');
  }

  console.log('\n── memory only ──');
  ok('nothing served before it is active', ml.testMapBytes(t.map.key) === null);
  ml.setTestMap(t);
  ok('active test map serves its bytes', ml.testMapBytes(t.map.key) === t.buf);
  ok('a different key gets nothing', ml.testMapBytes('0'.repeat(32)) === null && ml.testMapBytes('../x') === null);
  ok('not in the map list', !ml.listAllMaps().some((m) => m.test || String(m.nid).startsWith('test:')));
  ok('not findable by name', ml.findMap('My Arena v3') === null);
  ok('nothing written to the map cache or custom maps', listing(cacheDir) === SEEDED && listing(customDir) === '');

  console.log('\n── netlib chunk protocol ──');
  const sent = [];
  const n = na.answerTestMapRequest(`${na.TEST_MAP_REQ_PREFIX}${t.map.key}|0|1000`, ml.testMapBytes, (m) => sent.push(m));
  const total = Math.ceil(MAP.length / na.TEST_MAP_CHUNK_BYTES);
  ok('a window is capped at 32 chunks', n === Math.min(32, total), `${n}`);
  let all = [...sent];
  for (let from = n; from < total; from += 32) {
    na.answerTestMapRequest(`${na.TEST_MAP_REQ_PREFIX}${t.map.key}|${from}|32`, ml.testMapBytes, (m) => all.push(m));
  }
  const parts = all.map((m) => m.slice(na.TEST_MAP_CHUNK_PREFIX.length).split('|'));
  ok('every chunk names the key, its index and the total', parts.every((p, i) => p[0] === t.map.key && Number(p[1]) === i && Number(p[2]) === total && Number(p[3]) === MAP.length));
  ok('every message stays under 256 KiB', all.every((m) => m.length < 256 * 1024));
  const rebuilt = Buffer.concat(parts.map((p) => Buffer.from(p[4], 'base64')));
  ok('chunks reassemble to the exact file', rebuilt.equals(MAP));
  const errs = [];
  na.answerTestMapRequest(`${na.TEST_MAP_REQ_PREFIX}${'f'.repeat(32)}|0|4`, ml.testMapBytes, (m) => errs.push(m));
  ok('an unknown key gets an error reply', errs.length === 1 && errs[0].startsWith(na.TEST_MAP_ERR_PREFIX));
  ml.clearTestMap();
  ok('clearing drops the bytes', ml.testMapBytes(t.map.key) === null);
}

async function live() {
  console.log('\n── live server ──');
  const port = 18900 + Math.floor(Math.random() * 300);
  const adminPort = port + 1;
  const env = { ...process.env, EVIO_LOCAL_PORT: String(port), EVIO_ADMIN_PORT: String(adminPort), EVIO_NO_PERSIST: '1',
                EVIO_PUBLIC_HTTP_BASE: '', EVIO_STARTUP_MAP: '' };
  const srv = spawn(process.execPath, [path.join(ROOT, 'local_ws_server.js')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  srv.stdout.on('data', (d) => { out += d; });
  srv.stderr.on('data', (d) => { out += d; });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('server did not start\n' + out)), 30000);
    const check = () => { if (out.includes('listening on') && /admin|8081|dashboard/i.test(out)) { clearTimeout(t); resolve(); } };
    srv.stdout.on('data', check);
  });
  await new Promise((r) => setTimeout(r, 300));
  const admin = `http://127.0.0.1:${adminPort}`;
  const game = `http://127.0.0.1:${port}`;
  const post = (p, body) => fetch(admin + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const before = await (await fetch(admin + '/api/maps')).json();
    ok('no test map at start', before.testMap === null);

    const up = await post('/api/testmap', { name: 'Arena Test.evmap', data: MAP.toString('base64') });
    ok('upload loads it', up.status === 200 && up.body.ok && up.body.test === true, JSON.stringify(up.body).slice(0, 200));
    const key = up.body.key;
    const st = await (await fetch(admin + '/api/status')).json();
    ok('it is the live map', st.map === 'Arena Test', st.map);
    const maps = await (await fetch(admin + '/api/maps')).json();
    ok('dashboard reports the test map', maps.testMap && maps.testMap.key === key && maps.testMap.size === MAP.length);
    ok('it is not in the map list', !maps.maps.some((m) => String(m.nid).startsWith('test:') || m.title === 'Arena Test'));

    const r = await fetch(`${game}/maps/test/${key}.evmap`, { headers: { Origin: 'https://ev.io' } });
    const body = Buffer.from(await r.arrayBuffer());
    ok('game port serves the exact bytes', r.status === 200 && body.equals(MAP), `${r.status}`);
    ok('readable cross-origin', r.headers.get('access-control-allow-origin') === '*');
    ok('an unknown key is a 404', (await fetch(`${game}/maps/test/${'0'.repeat(32)}.evmap`)).status === 404);
    ok('not written to the map cache or custom maps', listing(cacheDir) === SEEDED && listing(customDir) === '');

    const settings = await (await fetch(admin + '/api/settings')).json();
    const startup = settings.settings.find((x) => x.key === 'startupMap');
    ok('not remembered as the startup map', startup && startup.value !== 'Arena Test', startup && startup.value);

    const garbage = await post('/api/testmap', { name: 'bad.evmap', data: Buffer.from('nope').toString('base64') });
    ok('a bad file is refused with a reason', garbage.status === 400 && /evmap|readable/.test(garbage.body.err), garbage.body.err);
    const still = await (await fetch(admin + '/api/status')).json();
    ok('a refused upload leaves the test map running', still.map === 'Arena Test');
    const plain = await fetch(admin + '/api/testmap', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    ok('a CORS simple request is refused (CSRF rule)', plain.status === 415);

    const sw = await post('/api/map', { map: 'Bishop' });
    ok('loading a real map works', sw.status === 200 && sw.body.ok, JSON.stringify(sw.body).slice(0, 160));
    ok('the test map is gone afterwards', (await fetch(`${game}/maps/test/${key}.evmap`)).status === 404);
    const after = await (await fetch(admin + '/api/maps')).json();
    ok('dashboard no longer reports it', after.testMap === null);
  } finally {
    srv.kill();
  }
}

unit().then(live).then(() => {
  fs.rmSync(cacheDir, { recursive: true, force: true });
  fs.rmSync(customDir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}).catch((e) => { console.error(e); process.exit(1); });
