/**
 * test_spawns.js — every spawn point must be somewhere a player can actually stand.
 *
 * THE BUG THIS GUARDS
 * ───────────────────
 * Spawns were broken twice over:
 *
 *  1. Two spawn tables existed. `bpw.spawnPoints` came from the ACTIVE .evmap (mirrored correctly,
 *     seated on the floor); `getSpawnPoints()` came from bishop_heightmap.json — Bishop-only,
 *     un-mirrored, un-seated. Round start used the first, but JOIN, death-respawn and admin
 *     teleport used the second. So on Bishop players got mirrored coordinates, and on every other
 *     map they got BISHOP's coordinates dropped into unrelated geometry: inside walls, in mid-air,
 *     or under the map, dying on arrival. `activeSpawnPoints()` is now the only source.
 *
 *  2. Seating a marker on the floor is not sufficient on its own — a marker buried in a wall still
 *     "seats" onto whatever is beneath it. Candidates must prove a standing capsule FITS.
 *
 * Rather than assert coordinates (which are map data and will change), this simulates: drop a real
 * player at each spawn, tick, and require them to settle alive on the ground.
 *
 * Usage:  node scripts/test_spawns.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const ml = require('../map_loader');
const phys = require('../physics_extracted');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

const FALL_DEATH_Y = phys.CONST.Qq85ufw;
const SETTLE_TICKS = 40;

// Drop a player at `sp` and let physics run. Returns how it went.
function settle(sp, id) {
  const ps = srv.createPlayerSimState(
    { x: sp.x, y: sp.y, z: sp.z, yaw: (sp.yaw || 0) * Math.PI / 180 }, id);
  for (let t = 0; t < SETTLE_TICKS; t++) srv.integratePlayerSim(ps, 0.05, t + 1);
  const p = ps.position;
  return {
    grounded: ps.grounded,
    y: p.y,
    fell: p.y < FALL_DEATH_Y,
    drop: sp.y - p.y,
    driftXZ: Math.hypot(p.x - sp.x, p.z - sp.z),
    finite: Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z),
  };
}

function checkMap(name, spawns) {
  console.log(`\n── ${name}: ${spawns.length} spawns ──`);
  const fellThrough = [], neverLanded = [], nonFinite = [], slid = [];
  spawns.forEach((sp, i) => {
    const r = settle(sp, `${name}-${i}`);
    if (!r.finite) nonFinite.push(i);
    else if (r.fell) fellThrough.push(`#${i} (${sp.x.toFixed(0)},${sp.y.toFixed(0)},${sp.z.toFixed(0)}) -> y=${r.y.toFixed(1)}`);
    else if (!r.grounded) neverLanded.push(`#${i} drop=${r.drop.toFixed(1)}`);
    // A spawn that slides a long way is standing on something it should not be.
    else if (r.driftXZ > 4) slid.push(`#${i} drifted ${r.driftXZ.toFixed(1)}u`);
  });
  ok(`${name}: no spawn produces NaN`, nonFinite.length === 0, nonFinite.join(', '));
  ok(`${name}: nobody falls out of the world`, fellThrough.length === 0,
    fellThrough.slice(0, 4).join('; '));
  ok(`${name}: everyone lands within ${SETTLE_TICKS} ticks`, neverLanded.length === 0,
    neverLanded.slice(0, 4).join('; '));
  ok(`${name}: nobody slides off their spawn`, slid.length === 0, slid.slice(0, 4).join('; '));
}

(async () => {
  await bpw.ready;

  console.log('\n══ the built-in map ══');
  checkMap('Bishop', bpw.spawnPoints);

  console.log('\n══ every map already in the cache ══');
  // Only cached maps: this test must not depend on the network.
  const cached = ml.cachedMaps().filter((m) => m.title !== 'Bishop');
  if (!cached.length) {
    console.log('  (no other maps cached — run a map switch once to widen this test)');
  }
  for (const m of cached) {
    const loaded = await ml.loadMap(m.title);
    bpw.setActiveWorld({
      world: loaded.world, spawns: loaded.spawns, teleporters: loaded.teleporters,
      vertices: loaded.vertices, indices: loaded.indices, groupIds: loaded.groupIds,
      name: loaded.map.title,
    });
    checkMap(m.title, bpw.spawnPoints);
  }

  console.log('\n══ there is only ONE spawn table ══');
  {
    // The regression that made this necessary: the live join path read a different, Bishop-only
    // list than round start did.
    // The second spawn table (bishop_heightmap.json, read via terrain_height) has since been
    // deleted, so there is no longer a rival list to compare against — which is the strongest
    // possible form of "there is only one". What remains to protect is that the live accessor
    // returns the LOADED map's spawns by identity, and that they are real map spawns rather than
    // the degenerate origin fallback.
    // Identity of the ARRAY is no longer the right test: activeSpawnPoints now filters the table down
    // to the general spawns, because a map's spawn list also holds team-1 and team-2 pads that the
    // client keeps in separate lists (see test:spawnflags). The guarantee that matters is unchanged
    // though — every spawn offered must come from the loaded map's table and nowhere else — so assert
    // membership by identity instead, which still catches a rival list.
    const active = srv.activeSpawnPoints();
    ok('every spawn offered comes from the loaded map\'s table',
      active.length > 0 && active.every((p) => bpw.spawnPoints.includes(p)),
      'if these diverge, join and respawn will place players using the wrong map');
    ok('and it is a subset of it, not a copy',
      active.length <= bpw.spawnPoints.length,
      `${active.length} offered of ${bpw.spawnPoints.length} in the map`);
    ok('and those are real map spawns, not the origin fallback',
      active.length > 1 && !(active[0].x === 0 && active[0].z === 0),
      `${active.length} spawns, first=(${active[0].x},${active[0].z}) — the fallback is a single (0,z=0) point`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
