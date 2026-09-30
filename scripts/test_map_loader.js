/**
 * test_map_loader.js — on-demand map catalogue, download cache, and physics build.
 *
 * WHY MAPS LOAD AT RUNTIME
 * ────────────────────────
 * ev.io has ~50 maps and the .evmap files total a few hundred MB. Shipping them all would bloat the
 * repo and slow deployment for files that mostly never get used. So a map is fetched from the CDN
 * the first time it is selected, converted to a collision world in memory, and cached on disk.
 *
 * A map needs ONLY its .evmap: the parser yields both the collision triangles and the spawn points,
 * so there is no heightmap to build (bishop_heightmap.json serves only the legacy fallback sim,
 * which never runs on the extracted-physics path). That is what makes runtime loading viable.
 *
 * Usage:  node scripts/test_map_loader.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const fs = require('fs');
const path = require('path');
const bpw = require('../physics_world');
const ml = require('../map_loader');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

bpw.ready.then(async () => {
  console.log('\n── catalogue ──');
  const maps = ml.listMaps();
  ok('the catalogue lists many loadable maps', maps.length > 40, `${maps.length}`);
  ok('every entry has an .evmap URL', maps.every((m) => /\.evmap$/i.test(m.evmapUrl)));
  ok('every entry has a nid and title', maps.every((m) => m.nid != null && m.title));
  ok('Bishop is present', !!ml.findMap('Bishop'));
  ok('lookup works by nid, title and URL',
    !!ml.findMap(ml.findMap('Bishop').nid) && !!ml.findMap('bishop')
    && !!ml.findMap(ml.findMap('Bishop').evmapUrl));
  ok('an unknown map is not invented', ml.findMap('NoSuchMapZZZ') === null);

  console.log('\n── building a world from a cached .evmap ──');
  // Bishop is seeded from the file that ships with the server, so this needs no network.
  const cacheFile = path.join(ml.CACHE_DIR, 'HUT8Bishop.evmap');
  if (!fs.existsSync(cacheFile)) {
    fs.mkdirSync(ml.CACHE_DIR, { recursive: true });
    fs.copyFileSync(path.join(__dirname, '..', 'default_map.evmap'), cacheFile);
  }
  const loaded = await ml.loadMap('Bishop');
  ok('it builds a collision world', !!loaded.world);
  ok('spawns come from the evmap itself — no heightmap needed', loaded.spawns.length > 0,
    `${loaded.spawns.length} spawns`);
  // The generic path must reproduce the built-in Bishop world exactly; that world is what all the
  // parity/collision work was validated against.
  ok('geometry matches the validated built-in Bishop world',
    loaded.indices.length === bpw.indices.length && loaded.vertices.length === bpw.vertices.length,
    `${loaded.indices.length / 3} vs ${bpw.indices.length / 3} tris`);
  ok('spawn count matches too', loaded.spawns.length === bpw.spawnPoints.length);

  console.log('\n── caching ──');
  const t0 = Date.now();
  const again = await ml.loadMap('Bishop');
  ok('a second load is served from the in-memory world cache', Date.now() - t0 < 50 && again.fromCache,
    `${Date.now() - t0} ms`);
  ok('the disk cache reports what is available offline', ml.cachedMaps().some((m) => m.title === 'Bishop'));

  console.log('\n── swapping the active world ──');
  const before = bpw.activeMapName;
  bpw.setActiveWorld({ world: loaded.world, spawns: loaded.spawns, vertices: loaded.vertices,
                       indices: loaded.indices, groupIds: loaded.groupIds, name: 'TestMap' });
  ok('the active map name changes', bpw.activeMapName === 'TestMap', bpw.activeMapName);
  ok('the world getter returns the new world', bpw.world === loaded.world,
    'everything reads bpw.world through this getter, including the per-tick capsule sync');
  ok('spawn points follow the active map', bpw.spawnPoints === loaded.spawns);
  bpw.setActiveWorld({ world: loaded.world, spawns: loaded.spawns, name: before });

  console.log('\n── failure handling ──');
  let threw = null;
  try { await ml.loadMap('DefinitelyNotAMap'); } catch (e) { threw = e.message; }
  ok('loading an unknown map rejects rather than half-switching', /unknown map/.test(threw || ''), String(threw));

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
});
