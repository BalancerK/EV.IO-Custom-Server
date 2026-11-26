/**
 * extra_maps.js — the hosted list of extra maps, merged into the map catalogue.
 *
 * maps.json is a snapshot of ev.io's official map catalogue. Maps made later (community uploads at
 * ev.io/node/add/map) are listed in one shared, hosted file instead:
 *
 *   https://balancerk.github.io/EV.IO-MAP-EDITOR/maps/extra-maps.json
 *
 * (maintained in the EV.IO-MAP-EDITOR repo — see its maps/README.md). This module reads it at
 * start-up and every 10 minutes, so a map added there becomes selectable here without a restart.
 * The EV.IO UI Enhancer extension reads the same file, so both always offer the same maps.
 *
 * Robustness: the last good copy is kept on disk (map_cache/extra-maps.json) and loaded
 * synchronously on require, so the list — and a startup map taken from it — works even when GitHub
 * is unreachable. A failed or malformed fetch keeps whatever was loaded before.
 *
 * Trust: the list decides which URLs players' browsers and this server download, so an entry is
 * accepted only if its .evmap is on ev.io's own file store and its images are too (or absent).
 *
 * EVIO_EXTRA_MAPS_URL overrides the URL; EVIO_EXTRA_MAPS_URL=off disables the list.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_URL = 'https://balancerk.github.io/EV.IO-MAP-EDITOR/maps/extra-maps.json';
const URL_SETTING = process.env.EVIO_EXTRA_MAPS_URL;
const LIST_URL = URL_SETTING === undefined || URL_SETTING === '' ? DEFAULT_URL : URL_SETTING;
const ENABLED = LIST_URL.toLowerCase() !== 'off';
const CACHE_FILE = path.join(process.env.EVIO_MAP_CACHE || path.join(__dirname, 'map_cache'), 'extra-maps.json');
const REFRESH_MS = Number(process.env.EVIO_EXTRA_MAPS_REFRESH_MS || 10 * 60 * 1000);
const FETCH_TIMEOUT_MS = 8000;
const MAX_MAPS = 500;

const EVMAP_URL_RE = /^https:\/\/ev\.io\/sites\/default\/files\/maps\/[A-Za-z0-9._%-]+\.evmap$/;
const IMAGE_URL_RE = /^https:\/\/ev\.io\/sites\/default\/files\/[A-Za-z0-9._%\/-]+\.(png|jpe?g)$/i;

let _entries = [];
let _version = 0;          // bumps whenever the list changes, so map_loader can re-merge
let _lastError = null;
let _lastFetched = null;
let _timer = null;

// A map's "Environment Effect" (taxonomy terms Rain / Snow / Dust / Lightning on the CMS map node)
// as the five roomParams flags official sends (opcodes 20-24). The client draws the weather and plays
// its sounds from these: rain loop, lightning strikes + thunder, drifting dust, snow. "Wind" has no
// term in the catalogue today but is a real flag, so a name of that form is honoured too.
const EFFECT_FLAGS = ['lightning', 'rain', 'snow', 'dust', 'wind'];
function effectsFromNames(names) {
  const out = { lightning: false, rain: false, snow: false, dust: false, wind: false };
  for (const n of names || []) {
    const k = String(n || '').trim().toLowerCase();
    if (EFFECT_FLAGS.includes(k)) out[k] = true;
  }
  return out;
}
// Only a sound from ev.io's own ambient-track folder is accepted from a hosted list.
const AMBIENT_URL_RE = /^https:\/\/ev\.io\/sites\/default\/files\/ambient_tracks\/[\w.%-]+\.(ogg|mp3)$/i;

/** Validate a fetched list. Returns catalogue entries (map_loader's shape); bad entries are skipped. */
function parseList(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.maps)) throw new Error('not an extra-maps list');
  const out = [];
  const seen = new Set();
  for (const m of raw.maps.slice(0, MAX_MAPS)) {
    if (!m || typeof m !== 'object') continue;
    const nid = Number(m.nid);
    if (!Number.isInteger(nid) || nid <= 0 || seen.has(nid)) continue;
    if (typeof m.evmapUrl !== 'string' || !EVMAP_URL_RE.test(m.evmapUrl)) continue;
    const img = (u) => (typeof u === 'string' && IMAGE_URL_RE.test(u) ? u : null);
    seen.add(nid);
    out.push({
      nid,
      title: (typeof m.title === 'string' && m.title.trim() ? m.title.trim() : `Map ${nid}`).slice(0, 80),
      evmapUrl: m.evmapUrl,
      thumbUrl: img(m.thumbUrl),
      largeImageUrl: img(m.largeImageUrl),
      ambientUrl: typeof m.ambientUrl === 'string' && AMBIENT_URL_RE.test(m.ambientUrl) ? m.ambientUrl : null,
      effects: effectsFromNames(Array.isArray(m.effects) ? m.effects.slice(0, 5) : []),
      inRotation: false,
      extra: true,
      author: typeof m.author === 'string' ? m.author.slice(0, 40) : null,
    });
  }
  return out;
}

function setEntries(entries) {
  const before = JSON.stringify(_entries);
  _entries = entries;
  if (JSON.stringify(entries) !== before) _version += 1;
}

function loadCacheSync() {
  try {
    setEntries(parseList(JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'))));
  } catch { /* no cache yet, or unreadable: start empty */ }
}

async function fetchJson(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json', 'Cache-Control': 'no-cache' } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(t);
  }
}

/** Fetch the hosted list now. Resolves true on success; never rejects. */
async function refresh() {
  if (!ENABLED) return false;
  try {
    const raw = await fetchJson(LIST_URL);
    const entries = parseList(raw);
    const changed = JSON.stringify(entries) !== JSON.stringify(_entries);
    setEntries(entries);
    _lastFetched = new Date().toISOString();
    _lastError = null;
    try {
      fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
      fs.writeFileSync(CACHE_FILE + '.part', JSON.stringify(raw));
      fs.renameSync(CACHE_FILE + '.part', CACHE_FILE);
    } catch { /* read-only disk: the in-memory list still works */ }
    if (changed) console.log(`[extra-maps] ${entries.length} extra map(s) from ${LIST_URL}: ${entries.map((e) => `#${e.nid} ${e.title}`).join(', ') || '(none)'}`);
    return true;
  } catch (err) {
    _lastError = String(err && err.message || err);
    console.warn(`[extra-maps] could not refresh ${LIST_URL} (${_lastError}); keeping ${_entries.length} known map(s)`);
    return false;
  }
}

/** Start the periodic refresh. Resolves after the first attempt (bounded by the fetch timeout). */
function start() {
  if (!ENABLED || _timer) return Promise.resolve(false);
  _timer = setInterval(refresh, REFRESH_MS);
  if (_timer.unref) _timer.unref();
  return refresh();
}

function stop() { if (_timer) clearInterval(_timer); _timer = null; }

loadCacheSync();

module.exports = {
  entries: () => _entries,
  version: () => _version,
  status: () => ({ enabled: ENABLED, url: ENABLED ? LIST_URL : null, maps: _entries.length, lastFetched: _lastFetched, lastError: _lastError }),
  refresh, start, stop, parseList,
  EVMAP_URL_RE, IMAGE_URL_RE, DEFAULT_URL, AMBIENT_URL_RE,
  effectsFromNames, EFFECT_FLAGS,
};
