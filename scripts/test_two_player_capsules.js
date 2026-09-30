/**
 * test_two_player_capsules.js
 *
 * Reproduces the "Player B sees Player A stuck at spawn" bug and verifies the fix.
 *
 * Root cause: Qcw4fab deletes capsules for any player NOT present in the
 * incoming game state.  The old registerPlayer(world, ps_B) only included
 * Player B → Player A's capsule was deleted → g() for Player A couldn't
 * resolve collisions → position stopped updating.
 *
 * Fix: _syncPhysWorldCapsules() always calls Qcw4fab with ALL registered
 * players, so no existing capsule is unexpectedly deleted.
 *
 * Test:
 *   1. Spawn Player A at spawn[2], settle on floor
 *   2. Spawn Player B at spawn[3] (different location)
 *   3. Run Player A forward for 10 ticks — must move > 1 unit
 *      (would stay at spawn without the fix)
 *   4. Run Player B forward for 10 ticks — must also move > 1 unit
 *   5. Both players should remain on floor (grounded)
 */
'use strict';

const bpw = require('../physics_world');

bpw.ready.then(() => {
  const srv = require('../local_ws_server');
  runTests(srv);
}).catch(err => {
  console.error('bpw load failed:', err);
  process.exit(1);
});

function runTests(srv) {
  let pass = 0, fail = 0;

  function assert(desc, condition, detail = '') {
    if (condition) {
      console.log(`  ✓ ${desc}`);
      pass++;
    } else {
      console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`);
      fail++;
    }
  }

  // ── Spawn both players ──────────────────────────────────────────────────
  const spA = bpw.spawnPoints[2];   // (46.3, 6.40, -18.1)
  const spB = bpw.spawnPoints[3];   // (22.0, 6.40, -27.0)

  console.log(`\nSpawning Player A at spawn[2]: (${spA.x.toFixed(1)}, ${spA.y.toFixed(2)}, ${spA.z.toFixed(1)})`);
  console.log(`Spawning Player B at spawn[3]: (${spB.x.toFixed(1)}, ${spB.y.toFixed(2)}, ${spB.z.toFixed(1)})`);

  const psA = srv.createPlayerSimState({ x: spA.x, y: spA.y, z: spA.z, yaw: 0 }, 'tA');
  const psB = srv.createPlayerSimState({ x: spB.x, y: spB.y, z: spB.z, yaw: 0 }, 'tB');

  assert('Player A has _ps', psA._ps !== null);
  assert('Player B has _ps', psB._ps !== null);

  // ── Settle both players on floor ────────────────────────────────────────
  // spawn[2] lands in 1 tick, spawn[3] in 14 ticks — use 20 to be safe.
  for (let t = 1; t <= 20; t++) {
    srv.integratePlayerSim(psA, 0.05, t);
    srv.integratePlayerSim(psB, 0.05, t);
  }
  assert('Player A settled on floor', psA.grounded, `grounded=${psA.grounded}`);
  assert('Player B settled on floor', psB.grounded, `grounded=${psB.grounded}`);
  console.log(`  Player A after settle: (${psA.position.x.toFixed(2)}, ${psA.position.y.toFixed(2)}, ${psA.position.z.toFixed(2)})`);
  console.log(`  Player B after settle: (${psB.position.x.toFixed(2)}, ${psB.position.y.toFixed(2)}, ${psB.position.z.toFixed(2)})`);

  // ── Move Player A forward while Player B exists ──────────────────────────
  // This was the failing case: after Player B's registerPlayer deleted Player A's
  // capsule, Player A's g() couldn't run → position stuck at spawn.
  const x0A = psA.position.x, z0A = psA.position.z;
  const x0B = psB.position.x, z0B = psB.position.z;

  for (let t = 21; t <= 35; t++) {
    psA.heldActions = new Set([0, 7]);  // forward + sprint for Player A
    psB.heldActions = new Set([0, 7]);  // forward + sprint for Player B
    srv.integratePlayerSim(psA, 0.05, t);
    srv.integratePlayerSim(psB, 0.05, t);
  }

  const dzA = psA.position.z - z0A;
  const dzB = psB.position.z - z0B;
  console.log(`  Player A moved dz=${dzA.toFixed(3)} (expected < -1.0)`);
  console.log(`  Player B moved dz=${dzB.toFixed(3)} (expected < -1.0)`);

  assert('Player A moved forward (not stuck at spawn)', dzA < -1.0,
    `dz=${dzA.toFixed(3)}`);
  assert('Player B moved forward (not stuck at spawn)', dzB < -1.0,
    `dz=${dzB.toFixed(3)}`);
  assert('Player A stayed on floor', psA.grounded, `grounded=${psA.grounded}`);
  assert('Player B stayed on floor', psB.grounded, `grounded=${psB.grounded}`);

  // ── Verify positions are different (no collision glitch stacking them) ──
  const dx = Math.abs(psA.position.x - psB.position.x);
  const dz = Math.abs(psA.position.z - psB.position.z);
  const dist = Math.hypot(dx, dz);
  console.log(`  Distance between players: ${dist.toFixed(2)} units`);
  assert('Players are separated (no stuck-together glitch)', dist > 1.0,
    `dist=${dist.toFixed(2)}`);

  // ── Summary ────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
