/**
 * add_map.js — add (or refresh) an ev.io map in maps.json by its node id.
 *
 * maps.json is a snapshot of ev.io's JSON:API map catalogue, and it only holds the maps that
 * existed when it was taken. A map uploaded later (e.g. a community map from ev.io/node/add/map)
 * is added here from its public node record, https://ev.io/node/<nid>?_format=json, written in
 * the same JSON:API shape (a node--map entry in data[] plus its file--file entries in included[]),
 * so map_loader.js — and the extension's bundled copy — read it with no special case.
 *
 * Re-running for the same nid replaces its entry (a re-uploaded file gets the new URL).
 *
 * Usage:  node scripts/add_map.js <nid> [extra/maps.json ...]
 *         (always updates this repo's maps.json; extra paths get the identical result)
 */
'use strict';

const fs = require('fs');
const path = require('path');

const nid = Number(process.argv[2]);
if (!Number.isInteger(nid) || nid <= 0) {
  console.error('usage: node scripts/add_map.js <nid> [extra/maps.json ...]');
  process.exit(2);
}
const targets = [path.join(__dirname, '..', 'maps.json'), ...process.argv.slice(3)];

const first = (v) => (Array.isArray(v) ? v[0] : v);
const relPath = (url) => (url ? new URL(url).pathname : null);   // catalogue stores site-relative URLs

function fileEntity(ref, kind) {
  if (!ref || !ref.url) return null;
  const url = relPath(ref.url);
  return {
    type: 'file--file',
    id: ref.target_uuid,
    attributes: {
      drupal_internal__fid: ref.target_id,
      filename: path.posix.basename(url),
      uri: { value: `public:/${url.replace(/^\/sites\/default\/files/, '')}`, url },
      filemime: kind === 'map' ? 'application/octet-stream' : (/\.png$/i.test(url) ? 'image/png' : 'image/jpeg'),
      status: true,
    },
  };
}

async function main() {
  const res = await fetch(`https://ev.io/node/${nid}?_format=json`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`ev.io/node/${nid}: HTTP ${res.status}`);
  const node = await res.json();
  if (first(node.type)?.target_id !== 'map') throw new Error(`node ${nid} is not a map`);
  const map = first(node.field_map);
  if (!map || !/\.evmap$/i.test(map.url || '')) throw new Error(`node ${nid} has no .evmap file`);

  const thumb = first(node.field_map_thumbnail);
  const large = first(node.field_large_image);
  const files = [fileEntity(map, 'map'), fileEntity(thumb, 'image'), fileEntity(large, 'image')].filter(Boolean);
  const rel = (ref) => (ref && ref.target_uuid ? { data: { type: 'file--file', id: ref.target_uuid } } : { data: null });
  const entry = {
    type: 'node--map',
    id: first(node.uuid).value,
    attributes: {
      drupal_internal__nid: nid,
      title: first(node.title).value,
      status: !!first(node.status)?.value,
      created: first(node.created)?.value,
      changed: first(node.changed)?.value,
      field_allow_private_games: !!first(node.field_allow_private_games)?.value,
      field_in_public_rotation: !!first(node.field_in_public_rotation)?.value,
      field_is_community_map: !!first(node.field_is_community_map)?.value,
    },
    relationships: {
      field_map: rel(map),
      field_map_thumbnail: rel(thumb),
      field_large_image: rel(large),
    },
  };

  for (const target of targets) {
    const cat = JSON.parse(fs.readFileSync(target, 'utf8'));
    const had = cat.data.some((n) => n.attributes && n.attributes.drupal_internal__nid === nid);
    cat.data = cat.data.filter((n) => !(n.attributes && n.attributes.drupal_internal__nid === nid));
    cat.data.push(entry);
    const ids = new Set(files.map((f) => f.id));
    cat.included = (cat.included || []).filter((f) => !ids.has(f.id)).concat(files);
    fs.writeFileSync(target, JSON.stringify(cat));
    console.log(`${had ? 'updated' : 'added'} #${nid} "${entry.attributes.title}" -> ${target}`);
  }
  console.log(`  map file: https://ev.io${relPath(map.url)}`);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
