/**
 * test_floor_landing.js
 *
 * Tests that a player spawned at the Bishop map spawn[0] (27, 13.39, 33.5)
 * falls and lands on the floor at y≈12.8 within 30 ticks.
 *
 * Expected with the groupIds=1 fix:
 *   tick ~4: Q9t2fit=true (grounded), Qdsukt4.y≈12.800
 *
 * Before the fix (groupIds=null → groupId=0 → filter 9&0=0 → no tris):
 *   player fell through floor forever.
 *
 * Player state field names (from physics_extracted.js):
 *   Qdsukt4  → THREE.Vector3 position
 *   Qyaswvo  → THREE.Vector3 velocity
 *   Q9t2fit  → boolean grounded
 */
'use strict';

const phys = require('../physics_extracted');
const bpw  = require('../physics_world');

bpw.ready.then(() => {
  const world       = bpw.world;
  const settings    = bpw.gameSettings;
  const spawnPoints = bpw.spawnPoints;

  const sp = spawnPoints[0];
  console.log(`spawn[0]: (${sp.x.toFixed(3)}, ${sp.y.toFixed(3)}, ${sp.z.toFixed(3)}) yaw=${sp.yaw}`);

  // createPlayerState(id, {x,y,z}, yaw)
  const ps = phys.createPlayerState('p0', { x: sp.x, y: sp.y, z: sp.z }, sp.yaw || 0);
  console.log(`initial: Q9t2fit=${ps.Q9t2fit} Qdsukt4.y=${ps.Qdsukt4.y.toFixed(4)}`);

  // Register player capsule in the physics world before first tick
  phys.registerPlayer(world, ps);

  const MAX_TICKS = 30;
  let landedTick = -1;
  let stableTicks = 0;

  for (let t = 1; t <= MAX_TICKS; t++) {
    phys.tickMovement(settings, ps, null, world, null, null, null);
    const y        = ps.Qdsukt4.y;
    const vy       = ps.Qyaswvo.y;
    const grounded = ps.Q9t2fit;
    console.log(`tick=${t}: y=${y.toFixed(4)} vy=${vy.toFixed(4)} grounded=${grounded}`);

    if (grounded) {
      if (landedTick < 0) landedTick = t;
      stableTicks++;
      if (stableTicks >= 3) break;  // stable for 3 consecutive ticks → done
    } else {
      stableTicks = 0;
    }
  }

  if (landedTick < 0) {
    console.error('\nFAIL: player never landed — still falling through floor');
    process.exit(1);
  }

  const finalY     = ps.Qdsukt4.y;
  const expectedY  = 12.8;
  const tolerance  = 0.5;

  if (Math.abs(finalY - expectedY) > tolerance) {
    console.error(`\nFAIL: landed at y=${finalY.toFixed(4)}, expected ≈${expectedY} (±${tolerance})`);
    process.exit(1);
  }

  console.log(`\nPASS: landed tick=${landedTick}, final y=${finalY.toFixed(4)} ≈ ${expectedY} ✓`);
  process.exit(0);

}).catch(err => {
  console.error('physics_world failed to load:', err);
  process.exit(1);
});
