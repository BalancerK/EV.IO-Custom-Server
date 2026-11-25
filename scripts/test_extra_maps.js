/**
 * test_extra_maps.js — the hosted extra-maps list (extra_maps.js) and its merge into map_loader.
 *
 * Serves a list from a local HTTP server standing in for GitHub Pages, with a temporary cache
 * folder, so it needs no network and leaves the real map_cache/ alone.
 *
 * Usage:  node scripts/test_extra_maps.js
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

const FILE = (name) => `https://ev.io/sites/default/files/maps/${name}`;
const entry = (nid, title, file, extra = {}) => ({ nid, title, evmapUrl: FILE(file), ...extra });

let served = { status: 200, body: { version: 1, maps: [entry(830, 'The Field', 'the-field_0.evmap')] } };
const server = http.createServer((req, res) => {
  res.writeHead(served.status, { 'content-type': 'application/json' });
  res.end(typeof served.body === 'string' ? served.body : JSON.stringify(served.body));
});

server.listen(0, '127.0.0.1', async () => {
  const url = `http://127.0.0.1:${server.address().port}/extra-maps.json`;
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'evio-extra-maps-'));
  process.env.EVIO_EXTRA_MAPS_URL = url;
  process.env.EVIO_MAP_CACHE = cacheDir;
  const extra = require('../extra_maps');
  const ml = require('../map_loader');

  console.log('\n── validation ──');
  const parsed = extra.parseList({ maps: [
    entry(1, 'Good', 'good.evmap', { thumbUrl: 'https://ev.io/sites/default/files/map_thumbs/a.png', largeImageUrl: 'https://evil.example/x.jpg' }),
    entry(1, 'Duplicate nid', 'dup.evmap'),
    { nid: 2, title: 'Other host', evmapUrl: 'https://evil.example/sites/default/files/maps/x.evmap' },
    { nid: 3, title: 'Plain http', evmapUrl: 'http://ev.io/sites/default/files/maps/x.evmap' },
    { nid: 4, title: 'Traversal', evmapUrl: 'https://ev.io/sites/default/files/maps/../../user/1.evmap' },
    { nid: 5, title: 'Not an evmap', evmapUrl: 'https://ev.io/sites/default/files/maps/x.php' },
    { nid: 6, title: 'Query string', evmapUrl: 'https://ev.io/sites/default/files/maps/x.evmap?y=1' },
    { nid: -7, title: 'Bad nid', evmapUrl: FILE('x.evmap') },
    { nid: 8, evmapUrl: FILE('untitled.evmap') },
    'junk', null,
  ] });
  ok('only valid entries are kept', JSON.stringify(parsed.map((m) => m.nid)) === '[1,8]', JSON.stringify(parsed.map((m) => m.nid)));
  ok('images off ev.io are dropped, ev.io images kept', parsed[0].largeImageUrl === null && /map_thumbs\/a\.png$/.test(parsed[0].thumbUrl));
  ok('a missing title gets a fallback', parsed[1].title === 'Map 8');
  let threw = false; try { extra.parseList({ nope: 1 }); } catch { threw = true; }
  ok('a document without maps[] is rejected', threw);

  console.log('\n── merge ──');
  const baseCount = ml.listMaps().length;
  ok('before the first fetch, nothing extra is listed (no cache yet)', !ml.findMap(830));
  ok('the first fetch succeeds', (await extra.start()) === true);
  ok('#830 is now selectable by id and title', !!ml.findMap(830) && !!ml.findMap('The Field'));
  ok('the catalogue grew by one', ml.listMaps().length === baseCount + 1, `${baseCount} -> ${ml.listMaps().length}`);
  ok('extra maps are not in public rotation', ml.findMap(830).inRotation === false);
  ok('status reports the list', extra.status().maps === 1 && extra.status().lastError === null);

  const bishop = ml.listMaps().find((m) => /bishop/i.test(m.title));
  served.body = { version: 1, maps: [entry(830, 'The Field', 'the-field_0.evmap'), entry(bishop.nid, 'Bishop (re-upload)', 'bishop_v2.evmap'), entry(831, 'Second Map', 'second.evmap')] };
  await extra.refresh();
  ok('a change to the hosted list shows up without a restart', !!ml.findMap(831));
  ok('an extra entry replaces the snapshot entry with the same nid', ml.findMap(bishop.nid).evmapUrl === FILE('bishop_v2.evmap') && ml.listMaps().filter((m) => m.nid === bishop.nid).length === 1);

  console.log('\n── failures keep the last good list ──');
  served = { status: 500, body: 'oops' };
  ok('a failed fetch reports failure', (await extra.refresh()) === false && /500/.test(extra.status().lastError));
  ok('…and keeps the maps it had', !!ml.findMap(831));
  served = { status: 200, body: '{not json' };
  await extra.refresh();
  ok('malformed JSON keeps them too', !!ml.findMap(831));

  console.log('\n── disk cache ──');
  ok('the last good list was cached', fs.existsSync(path.join(cacheDir, 'extra-maps.json')));
  const probe = `process.env.EVIO_EXTRA_MAPS_URL='http://127.0.0.1:1/unreachable';process.env.EVIO_MAP_CACHE=${JSON.stringify(cacheDir)};`
    + `const ml=require(${JSON.stringify(path.join(__dirname, '..', 'map_loader'))});console.log(JSON.stringify(!!ml.findMap(831)))`;
  const out = execFileSync(process.execPath, ['-e', probe], { encoding: 'utf8' }).split('\n').map((l) => l.trim()).filter((l) => l === 'true' || l === 'false').pop();
  ok('a fresh process finds the cached maps with the host unreachable', out === 'true', out);

  extra.stop();
  server.close();
  fs.rmSync(cacheDir, { recursive: true, force: true });
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
});
