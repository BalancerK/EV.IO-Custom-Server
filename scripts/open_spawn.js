/**
 * open_spawn.js — test support: find a spawn with clear space in front of it.
 *
 * Several physics tests need "somewhere on the map with room to run/dash", and used to spell that
 * as `bpw.spawnPoints[0]` with the coordinates written into a comment. That silently couples them
 * to the spawn TABLE: when the spawn transform was corrected (mirrored X and the client's
 * (270 - w) yaw, bundle :47098) those indices landed on different terrain and the tests failed for
 * reasons that had nothing to do with what they were testing.
 *
 * So ask the collision world instead of trusting an index.
 */
'use strict';

const phys = require('../physics_extracted');

/**
 * Pick a spawn with at least `minClear` units of open space along (dirX, dirZ).
 *
 * The probe runs at chest height (+1) so a floor slope does not count as an obstruction, and the
 * candidate must itself be standing on something.
 *
 * `offsets` additionally requires the same clearance at those lateral displacements from the
 * spawn — for tests that run two players down the same corridor side by side.
 *
 * @returns {{x,y,z,yaw,index}} the spawn, or throws if the map has no such spot.
 */
function pickOpenSpawn(world, spawns, { dirX = 0, dirZ = -1, minClear = 12, height = 1,
                                        offsets = [{ dx: 0, dz: 0 }] } = {}) {
  const len = Math.hypot(dirX, dirZ) || 1;
  const dx = dirX / len, dz = dirZ / len;
  const probes = offsets.length ? offsets : [{ dx: 0, dz: 0 }];
  let best = null;
  for (let i = 0; i < spawns.length; i++) {
    const sp = spawns[i];
    const clear = probes.every((o) => {
      const ox = sp.x + (o.dx || 0), oz = sp.z + (o.dz || 0);
      if (phys.raycastWorld(world, ox, sp.y + height, oz, dx, 0, dz, minClear)) return false;
      return !!phys.raycastWorld(world, ox, sp.y + 2, oz, 0, -1, 0, 20);  // must stand on something
    });
    if (!clear) continue;
    best = { ...sp, index: i };
    break;
  }
  if (!best) {
    throw new Error(`no spawn with ${minClear}u clearance along (${dirX},${dirZ}) on this map`);
  }
  return best;
}

/** Two spawns with clear corridors, far enough apart that their capsules cannot interact. */
function pickTwoOpenSpawns(world, spawns, opts = {}) {
  const minApart = opts.minApart || 20;
  const first = pickOpenSpawn(world, spawns, opts);
  const rest = spawns.filter((sp, i) =>
    i !== first.index && Math.hypot(sp.x - first.x, sp.z - first.z) >= minApart);
  const second = pickOpenSpawn(world, rest, opts);
  return [first, second];
}

module.exports = { pickOpenSpawn, pickTwoOpenSpawns };
