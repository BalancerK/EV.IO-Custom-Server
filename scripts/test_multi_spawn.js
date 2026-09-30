/**
 * test_multi_spawn.js
 *
 * Tests the first 5 spawn points — each player should land on the floor
 * within 30 ticks and stay above y = -5 (never fall through the world).
 */
'use strict';

const phys = require('../physics_extracted');
const bpw  = require('../physics_world');

bpw.ready.then(() => {
  const world       = bpw.world;
  const settings    = bpw.gameSettings;
  const spawnPoints = bpw.spawnPoints;

  let passed = 0, failed = 0;
  const TEST_N = Math.min(5, spawnPoints.length);

  for (let i = 0; i < TEST_N; i++) {
    const sp = spawnPoints[i];
    const ps = phys.createPlayerState(`p${i}`, { x: sp.x, y: sp.y, z: sp.z }, sp.yaw || 0);
    phys.registerPlayer(world, ps);

    let landedTick = -1;
    for (let t = 1; t <= 30; t++) {
      phys.tickMovement(settings, ps, null, world, null, null, null);
      if (ps.Q9t2fit && landedTick < 0) landedTick = t;
      if (ps.Qdsukt4.y < -50) break; // fell through world
    }

    const finalY = ps.Qdsukt4.y;
    const ok = landedTick > 0 && finalY > -5;
    if (ok) {
      console.log(`spawn[${i}]: (${sp.x.toFixed(1)}, ${sp.y.toFixed(2)}, ${sp.z.toFixed(1)}) → landed tick=${landedTick} y=${finalY.toFixed(4)} ✓`);
      passed++;
    } else {
      console.error(`spawn[${i}]: (${sp.x.toFixed(1)}, ${sp.y.toFixed(2)}, ${sp.z.toFixed(1)}) → FAIL: landedTick=${landedTick} y=${finalY.toFixed(4)}`);
      failed++;
    }
  }

  console.log(`\n${passed}/${TEST_N} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);

}).catch(err => {
  console.error('load failed:', err);
  process.exit(1);
});
