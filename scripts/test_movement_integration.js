/**
 * test_movement_integration.js
 *
 * Verifies that extracted physics movement through the server's
 * createPlayerSimState + integratePlayerSim path works correctly.
 *
 * Tests:
 *  1. Idle: player falls and lands on Bishop map floor
 *  2. Forward (key 0) + Sprint (key 7): player moves in +Z direction (yaw=0)
 *  3. Jump (key 4): player goes airborne, reaches peak, lands back
 *  4. Press-edge: jump only fires once even if key held for 10 ticks
 */
'use strict';

const bpw = require('../physics_world');

bpw.ready.then(() => {
  // Require the server module AFTER bpw is ready so createPlayerSimState
  // will find bpw.world non-null and create _ps immediately.
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

  // ── Helper: tick N times with optional held keys ─────────────────────────
  function tick(ps, n, heldKeys = [], pressedOnFirst = []) {
    for (let i = 0; i < n; i++) {
      // Simulate what foldInputFrameIntoSim does
      ps.heldActions = new Set(heldKeys);
      // jump queued on first frame only (mimics press detection)
      if (i === 0 && pressedOnFirst.includes(4) && ps.grounded) {
        ps.jumpQueued = true;
      }
      srv.integratePlayerSim(ps, 0.05, i + 1);
    }
  }

  // ── Test 1: Idle fall → land on Bishop floor ──────────────────────────────
  console.log('\nTest 1: Idle fall + floor landing');
  {
    // Lift off the spawn deliberately. Spawn markers are now SEATED on the floor (they used to
    // float a metre or so, which is what made this test start airborne by accident), so a fall
    // test has to create its own drop.
    const sp = bpw.spawnPoints[0];
    const ps = srv.createPlayerSimState({ x: sp.x, y: sp.y + 3, z: sp.z, yaw: 0 }, 't1');
    assert('_ps created', ps._ps !== null);
    assert('starts airborne', !ps.grounded, `grounded=${ps.grounded}`);

    // Tick until grounded (max 30)
    let landedAt = -1;
    for (let t = 1; t <= 30; t++) {
      srv.integratePlayerSim(ps, 0.05, t);
      if (ps.grounded && landedAt < 0) landedAt = t;
    }
    assert('lands within 30 ticks', landedAt > 0, `landedAt=${landedAt}`);
    assert('lands at y≈12.8', Math.abs(ps.position.y - 12.8) < 0.5,
      `y=${ps.position.y.toFixed(4)}`);
    console.log(`    landed tick=${landedAt} y=${ps.position.y.toFixed(4)}`);
  }

  // ── Test 2: Forward + Sprint movement ─────────────────────────────────────
  console.log('\nTest 2: Forward + sprint movement (yaw=0 → moves toward -Z)');
  {
    // Spawn and settle on ground first
    const sp = bpw.spawnPoints[2]; // (46.3, 6.40, -18.1)
    const ps = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 't2');
    // Settle
    for (let t = 0; t < 5; t++) srv.integratePlayerSim(ps, 0.05, t);
    assert('settled on ground', ps.grounded);

    const z0 = ps.position.z;
    // Forward key=0, Sprint key=7, 20 ticks
    for (let t = 5; t < 25; t++) {
      ps.heldActions = new Set([0, 7]);
      srv.integratePlayerSim(ps, 0.05, t);
    }
    const dz = ps.position.z - z0;
    // yaw=0 → forward = -Z in ev.io coords
    assert('moved in -Z direction', dz < -1.0, `dz=${dz.toFixed(3)}`);
    // Sprint speed cap = 14 units/s → over 20 ticks @ 50ms = 14*1.0 = 14 units
    assert('moved reasonable distance', Math.abs(dz) < 20, `|dz|=${Math.abs(dz).toFixed(2)}`);
    console.log(`    dz=${dz.toFixed(3)} (expected < -1.0)`);
  }

  // ── Test 3: Jump goes airborne ─────────────────────────────────────────────
  console.log('\nTest 3: Jump from ground');
  {
    const sp = bpw.spawnPoints[2];
    const ps = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 't3');
    // Settle on ground
    for (let t = 0; t < 5; t++) srv.integratePlayerSim(ps, 0.05, t);
    assert('grounded before jump', ps.grounded);

    const y0 = ps.position.y;
    // Inject jump: put key 4 in heldActions AND _prevHeldKeys must NOT have 4
    ps._prevHeldKeys = new Set();  // ensure 4 is "newly pressed"
    ps.heldActions = new Set([4]);
    srv.integratePlayerSim(ps, 0.05, 6);  // jump fires here
    const yAfterJump = ps.position.y;
    assert('jumps upward', yAfterJump > y0, `y0=${y0.toFixed(3)} → ${yAfterJump.toFixed(3)}`);
    assert('no longer grounded after jump', !ps.grounded, `grounded=${ps.grounded}`);

    // Keep ticking (no keys) until grounded again
    ps._prevHeldKeys = new Set([4]); // 4 was held, now releasing
    ps.heldActions = new Set();
    let peakY = yAfterJump;
    let landedTick = -1;
    for (let t = 7; t <= 40; t++) {
      srv.integratePlayerSim(ps, 0.05, t);
      if (ps.position.y > peakY) peakY = ps.position.y;
      if (ps.grounded && landedTick < 0) landedTick = t;
    }
    assert('reaches higher than start', peakY > y0 + 0.5, `peak=${peakY.toFixed(3)} start=${y0.toFixed(3)}`);
    assert('lands back on ground', landedTick > 0, `landedTick=${landedTick}`);
    assert('returns to near original height', Math.abs(ps.position.y - y0) < 0.3,
      `y=${ps.position.y.toFixed(4)} y0=${y0.toFixed(4)}`);
    console.log(`    peak=${peakY.toFixed(3)} at approx tick ${7} → landed tick=${landedTick} final y=${ps.position.y.toFixed(4)}`);
  }

  // ── Test 4: Jump key press-edge (key held 10 ticks → only one jump) ───────
  console.log('\nTest 4: Jump press-edge — held for 10 ticks, only one jump fires');
  {
    const sp = bpw.spawnPoints[2];
    const ps = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 't4');
    // Settle
    for (let t = 0; t < 5; t++) srv.integratePlayerSim(ps, 0.05, t);
    assert('grounded before jump hold test', ps.grounded);

    // Hold jump key for 10 ticks — should only jump once
    ps._prevHeldKeys = new Set();  // 4 is "newly pressed" on tick 0
    let jumpCount = 0;
    let prevVy = ps.velocity.y;
    for (let t = 5; t < 15; t++) {
      ps.heldActions = new Set([4]);
      srv.integratePlayerSim(ps, 0.05, t);
      // Detect jump fire: vy goes positive
      if (ps.velocity.y > 0 && prevVy <= 0) jumpCount++;
      prevVy = ps.velocity.y;
    }
    assert('jumped exactly once', jumpCount === 1, `jumpCount=${jumpCount}`);
    console.log(`    jumpCount=${jumpCount} (expected 1)`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
