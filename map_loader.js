/**
 * map_loader.js — on-demand map catalogue, download, and physics build.
 *
 * WHY ON DEMAND
 * ─────────────
 * ev.io ships ~50 maps and the .evmap files total a few hundred MB. Shipping them all would make
 * the server repo huge and deployment slow, and almost all of them would never be used in a given
 * session. So maps are fetched from ev.io's CDN the first time they are selected, converted to a
 * collision world in memory, and cached on disk (map_cache/, gitignored) for next time.
 *
 * WHAT A MAP ACTUALLY NEEDS
 * ─────────────────────────
 * Only the .evmap file. The parser produces both the collision triangles AND the spawn points, so
 * there is NO heightmap to build — bishop_heightmap.json exists solely for the legacy hand-rolled
 * fallback sim, which never runs on the extracted-physics path. That is what makes runtime map
 * loading cheap: parse once (~0.5s for Bishop's 16.7k triangles) and keep the world in memory.
 *
 * The catalogue comes from the same JSONAPI payload the client uses
 * (server/maps.json): `data[]` are the map nodes and `included[]` holds the file
 * entities, joined via relationships.field_map.data.id.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');
const bpw = require('./physics_world');
const phys = require('./physics_extracted');

const CMS_BASE = 'https://ev.io';
const CATALOGUE = path.join(__dirname, 'maps.json');
const CACHE_DIR = process.env.EVIO_MAP_CACHE || path.join(__dirname, 'map_cache');

// Built worlds, keyed by evmap URL. A world is a few MB of typed arrays plus the spatial grid, so
// we keep a small bounded number rather than every map ever loaded.
const _worldCache = new Map();
const WORLD_CACHE_MAX = Number(process.env.EVIO_MAP_WORLD_CACHE || 3);

let _catalogue = null;

/**
 * All maps from the catalogue: { nid, title, evmapUrl, thumbUrl, inRotation }.
 * Maps without an .evmap file are skipped — they cannot be loaded.
 */
function listMaps() {
  if (_catalogue) return _catalogue;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(CATALOGUE, 'utf8'));
  } catch (err) {
    console.warn(`[map-loader] catalogue unavailable (${err.message}); only the built-in map is selectable`);
    _catalogue = [];
    return _catalogue;
  }
  // included[] is a flat list of related entities; index it by id so relationships resolve.
  const byId = new Map();
  for (const inc of raw.included || []) byId.set(inc.id, inc);
  const fileUrl = (rel) => {
    const id = rel && rel.data && rel.data.id;
    const ent = id && byId.get(id);
    const url = ent && ent.attributes && ent.attributes.uri && ent.attributes.uri.url;
    return url ? CMS_BASE + url : null;
  };

  const out = [];
  for (const node of raw.data || []) {
    const a = node.attributes || {};
    const r = node.relationships || {};
    const evmapUrl = fileUrl(r.field_map);
    if (!evmapUrl || !/\.evmap$/i.test(evmapUrl)) continue;   // not loadable
    out.push({
      nid: a.drupal_internal__nid,
      title: a.title || 'Untitled',
      evmapUrl,
      thumbUrl: fileUrl(r.field_map_thumbnail),
      // field_large_image is the full-resolution art (map_large_image/*.jpg); field_map_thumbnail is
      // the small scoreboard/picker icon (map_thumbs/*.png). The LOADING screen wants the large one —
      // we were sending the thumbnail, which the client scaled up to fill the screen, hence the blurry
      // map picture while loading. Not every map defines one, so callers fall back to the thumbnail.
      largeImageUrl: fileUrl(r.field_large_image),
      inRotation: a.field_in_public_rotation !== false,
    });
  }
  out.sort((x, y) => String(x.title).localeCompare(String(y.title)));
  _catalogue = out;
  return out;
}

function findMap(idOrTitleOrUrl) {
  const maps = listMaps();
  const key = String(idOrTitleOrUrl);
  return maps.find((m) => String(m.nid) === key)
      || maps.find((m) => m.title.toLowerCase() === key.toLowerCase())
      || maps.find((m) => m.evmapUrl === key)
      || null;
}

function cachePathFor(url) {
  // Keep the CDN filename; it is already unique per map and keeps the cache readable.
  const base = path.basename(new URL(url).pathname).replace(/[^\w.\-]/g, '_');
  return path.join(CACHE_DIR, base);
}

function download(url, redirectsLeft = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'user-agent': 'evio-local-server' } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) return reject(new Error('too many redirects'));
        const next = new URL(res.headers.location, url).toString();
        return resolve(download(next, redirectsLeft - 1));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
    }).on('error', reject);
  });
}

/** Fetch the .evmap bytes, using the disk cache when present. */
async function fetchEvmap(url) {
  const cached = cachePathFor(url);
  if (fs.existsSync(cached)) {
    const buf = fs.readFileSync(cached);
    if (buf.length > 0) return { buf, fromCache: true, path: cached };
  }
  const t0 = Date.now();
  const buf = await download(url);
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  // Write via a temp file so an interrupted download can never leave a truncated cache entry that
  // would then be parsed as a valid map.
  const tmp = cached + '.part';
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, cached);
  console.log(`[map-loader] downloaded ${path.basename(cached)} `
    + `(${(buf.length / 1048576).toFixed(1)} MB in ${Date.now() - t0} ms) -> ${CACHE_DIR}`);
  return { buf, fromCache: false, path: cached };
}

/**
 * Load a map and build its collision world. Resolves to
 * { map, world, spawns, tris, fromCache, buildMs }.
 */
async function loadMap(idOrTitleOrUrl) {
  const map = findMap(idOrTitleOrUrl);
  if (!map) throw new Error(`unknown map: ${idOrTitleOrUrl}`);

  const hit = _worldCache.get(map.evmapUrl);
  if (hit) return { ...hit, fromCache: true, buildMs: 0 };

  const { buf, fromCache } = await fetchEvmap(map.evmapUrl);
  const t0 = Date.now();
  const built = bpw.buildWorldFromEvmapBuffer(buf, map.title);
  const buildMs = Date.now() - t0;
  if (!built.spawns || !built.spawns.length) {
    throw new Error(`${map.title} has no spawn points — cannot host it`);
  }

  // Shared with the built-in map path so every map is seated identically.
  const spawns = bpw.resolveSpawnsToFloor(built.world, built.spawns, map.title);
  const entry = { map, world: built.world, spawns, teleporters: built.teleporters || [],
                  navmesh: built.navmesh || [], pickupPoints: built.pickupPoints || [],
                  vertices: built.vertices, indices: built.indices, groupIds: built.groupIds,
                  tris: built.indices.length / 3 };
  _worldCache.set(map.evmapUrl, entry);
  // Bound the in-memory cache (worlds are multi-MB); evict the oldest.
  while (_worldCache.size > WORLD_CACHE_MAX) {
    _worldCache.delete(_worldCache.keys().next().value);
  }
  return { ...entry, fromCache, buildMs };
}

/** Which maps are already on disk (so the dashboard can show what is instant). */
function cachedMaps() {
  if (!fs.existsSync(CACHE_DIR)) return [];
  const names = new Set(fs.readdirSync(CACHE_DIR).filter((f) => f.endsWith('.evmap')));
  return listMaps().filter((m) => names.has(path.basename(new URL(m.evmapUrl).pathname)));
}

module.exports = { listMaps, findMap, loadMap, fetchEvmap, cachedMaps, CACHE_DIR };
