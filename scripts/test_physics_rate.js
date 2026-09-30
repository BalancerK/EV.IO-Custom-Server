/**
 * test_physics_rate.js
 *
 * Ground-truth test: verifies the server advances player physics at exactly the
 * expected rate — ONE physics step per 50ms game tick — regardless of how many
 * input packets the client sends per tick.
 *
 * WHY THIS TEST EXISTS
 * ────────────────────
 * The server has two paths that can call integratePlayerSim in the same 50ms window:
 *   1. input-paced path  — fires immediately when the first input packet arrives
 *   2. global tick path  — fires every 50ms for idle players OR (if hasPendingFrames
 *                          was enabled) for players with leftover sub-frames
 *
 * Before the fix, a 60fps client sending 3 packets/50ms caused:
 *   • input-paced(packet 1): drains [f1], OLD code ran N=1 step
 *   • global tick hasPendingFrames: drains [f2,f3], OLD code ran N=2 steps
 *   • Total: 3 steps × Qq5sl76=1 = 3× speed  ← exactly the reported bug
 *
 * After the fix (1-step collapse + hasPendingFrames removed):
 *   • input-paced(packet 1): drains [f1,f2,f3], runs 1 step  (or 1 step from [f1] if
 *     packets arrive sequentially within the 50ms window)
 *   • global tick: skipped (lastInputTick === globalTick)
 *   • Total: 1 step per 50ms regardless of packet pattern  ← correct
 *
 * SCENARIOS
 * ─────────
 *  A  Baseline     — 1 call/tick via direct heldActions (idle-tick path, no foldClient)
 *  B  Single 3f pkt — 1 call/tick via foldClientInputIntoSim with 3 sub-frames per call
 *  C  Three 1f pkts — Simulates 60fps client: 3 separate foldClientInputIntoSim calls,
 *                      then ONE integratePlayerSim (no hasPendingFrames second step)
 *  D  Double-step  — Explicitly simulates OLD behaviour: two integratePlayerSim calls
 *                      per tick to verify this doubles displacement (regression guard)
 *
 * Expected results:
 *   A ≈ B ≈ C  (all give ~same displacement per tick, ratio within 5%)
 *   D ≈ 2 × A  (double-step doubles displacement, confirms test sensitivity)
 *
 * Usage:
 *   node scripts/test_physics_rate.js
 */
'use strict';

const bpw  = require('../physics_world');
const TICKS = 25;  // 5 settle + 20 sprint

// Forward + sprint key codes
const FWD    = 0;
const SPRINT = 7;

function makeDecodedPacket(frames) {
  return [0, 0, 0, 0, 0, frames];
}
function makeFrame(held = []) {
  return [1.0, [held, [], [], [0, 0], null, null]];
}

bpw.ready.then(() => {
  const srv = require('../local_ws_server');
  // Use different spawn points per scenario so capsules don't collide with each other.
  // Each player sprints in the same yaw=0 direction but starts from a different
  // absolute position, keeping them far apart.
  // Spawn points for each scenario.
  // A and B share the same -Z corridor from spawn[0] (clear path ~11 units) but
  // are laterally offset by 3.5 units so their capsules never touch.
  // C and D share the same -Z corridor from spawn[2] for the same reason.
  // D uses 2× physics steps/tick, so it needs the same clear corridor as C
  // (spawn[1] and spawn[3] have walls directly in front).
  // Found, not hardcoded: the scenarios need a clear -Z corridor, and spawn indices stopped
  // pointing at one when the spawn transform was corrected (mirrored X, client (270 - w) yaw).
  const { pickTwoOpenSpawns } = require('./open_spawn');
  // Each scenario pair runs side by side 3.5u apart, so BOTH lanes must be clear.
  const [sp0, sp2] = pickTwoOpenSpawns(bpw.world, bpw.spawnPoints, {
    dirX: 0, dirZ: -1, minClear: 14, minApart: 20,
    offsets: [{ dx: 0, dz: 0 }, { dx: 3.5, dz: 0 }],
  });
  const spawnByScenario = {
    a: sp0,
    b: { x: sp0.x + 3.5, y: sp0.y, z: sp0.z },  // same -Z path as A, 3.5 m to the right
    c: sp2,
    d: { x: sp2.x + 3.5, y: sp2.y, z: sp2.z },  // same -Z path as C, 3.5 m to the right
  };

  function fresh(id, spawnKey) {
    const sp = spawnByScenario[spawnKey];
    const ps = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, id);
    // Settle for 5 ticks
    for (let t = 0; t < 5; t++) srv.integratePlayerSim(ps, 0.05, t);
    return ps;
  }

  let pass = 0, fail = 0;
  function ok(desc, cond, detail = '') {
    if (cond) { console.log(`  ✓ ${desc}`); pass++; }
    else       { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
  }
  function near(desc, a, b, pct) {
    const ratio = Math.abs(a) > 1e-6 ? Math.abs(b - a) / Math.abs(a) : Math.abs(b - a);
    ok(desc, ratio <= pct, `a=${a.toFixed(4)} b=${b.toFixed(4)} ratio=${ratio.toFixed(3)} (≤${pct})`);
  }

  // ── Scenario A: baseline — direct heldActions (idle-tick path) ──────────
  console.log('\n── Scenario A: baseline (direct heldActions, 1 integration/tick) ──');
  let dzA, dxA;
  {
    const ps = fresh('rate-a', 'a');
    const z0 = ps.position.z, x0 = ps.position.x;
    for (let t = 5; t < TICKS; t++) {
      ps.heldActions = new Set([FWD, SPRINT]);
      srv.integratePlayerSim(ps, 0.05, t);
    }
    dzA = ps.position.z - z0;
    dxA = ps.position.x - x0;
    const dist = Math.hypot(dzA, dxA);
    console.log(`  displacement: dz=${dzA.toFixed(3)} dx=${dxA.toFixed(3)} |d|=${dist.toFixed(3)} over ${TICKS-5} sprint ticks`);
    ok('Scenario A: moved > 3 units', dist > 3, `dist=${dist.toFixed(3)}`);
  }

  // ── Scenario B: 1 packet with 3 sub-frames per tick ─────────────────────
  console.log('\n── Scenario B: 1 packet × 3 sub-frames/tick (20Hz batched) ──');
  let dzB;
  {
    const ps = fresh('rate-b', 'b');
    const z0 = ps.position.z;
    for (let t = 5; t < TICKS; t++) {
      const pkt = makeDecodedPacket([makeFrame([FWD, SPRINT]), makeFrame([FWD, SPRINT]), makeFrame([FWD, SPRINT])]);
      srv.foldClientInputIntoSim(ps, pkt);
      srv.integratePlayerSim(ps, 0.05, t);  // single integration drains all 3 sub-frames
    }
    dzB = ps.position.z - z0;
    console.log(`  displacement: dz=${dzB.toFixed(3)}`);
  }

  // ── Scenario C: 3 separate packets × 1 sub-frame each (60fps client) ────
  // Mirrors what happens in the live server:
  //   • Only the FIRST packet triggers integratePlayerSim (input-paced)
  //   • Packets 2 & 3 are folded but NOT integrated (guard prevents double-step)
  //   • The global tick is SKIPPED (lastInputTick guards it out)
  //   • Packets 2 & 3 remain in _pendingRawFrames, drained NEXT tick
  console.log('\n── Scenario C: 3 packets × 1 sub-frame (60fps simulation, 1 step/tick) ──');
  let dzC;
  {
    const ps = fresh('rate-c', 'c');
    const z0 = ps.position.z;
    for (let t = 5; t < TICKS; t++) {
      const f = makeFrame([FWD, SPRINT]);
      // Packet 1 → input-paced: fold + 1 integration
      srv.foldClientInputIntoSim(ps, makeDecodedPacket([f]));
      srv.integratePlayerSim(ps, 0.05, t);       // ← 1 step (drains f1)
      // Packet 2 → fold only (no integration — mirrors guard)
      srv.foldClientInputIntoSim(ps, makeDecodedPacket([f]));
      // Packet 3 → fold only
      srv.foldClientInputIntoSim(ps, makeDecodedPacket([f]));
      // Global tick would be SKIPPED in the live server (hasPendingFrames removed).
      // The _pendingRawFrames from packets 2+3 carry over; drained next iteration.
    }
    dzC = ps.position.z - z0;
    console.log(`  displacement: dz=${dzC.toFixed(3)}`);
  }

  // ── Scenario D: deliberate double-step (regression guard) ───────────────
  // Simulates the OLD hasPendingFrames behaviour to verify it gives 2× speed.
  // This SHOULD give approximately 2× Scenario A.
  console.log('\n── Scenario D: deliberate double-step (old bug, expect ~2× speed) ──');
  let dzD;
  {
    const ps = fresh('rate-d', 'd');
    const z0 = ps.position.z;
    for (let t = 5; t < TICKS; t++) {
      const f = makeFrame([FWD, SPRINT]);
      srv.foldClientInputIntoSim(ps, makeDecodedPacket([f]));
      srv.integratePlayerSim(ps, 0.05, t);        // step 1
      // Simulate hasPendingFrames firing a second integration
      srv.foldClientInputIntoSim(ps, makeDecodedPacket([f, f]));
      srv.integratePlayerSim(ps, 0.05, t + 1000); // step 2 (old bug: t+1000 avoids any tick-guard inside tickMovement)
    }
    dzD = ps.position.z - z0;
    const ratioD = Math.abs(dzD) / (Math.abs(dzA) || 1);
    console.log(`  displacement: dz=${dzD.toFixed(3)}  ratio vs A = ${ratioD.toFixed(3)} (expect ~2.0)`);
    ok('Double-step ratio > 1.3 (confirms test catches over-stepping)', ratioD > 1.3,
       `ratio=${ratioD.toFixed(3)}`);
  }

  // ── Compare B and C to A ─────────────────────────────────────────────────
  console.log('\n── Cross-scenario comparison ──');
  near('B / A displacement within 5%', dzA, dzB, 0.05);
  near('C / A displacement within 5%', dzA, dzC, 0.05);

  // ── Physics speed sanity check ───────────────────────────────────────────
  // Sprint speed stat Q8i9f3s = 0.7 units/tick.  Over 20 ticks from rest with
  // 5-tick acceleration ramp, expected total ≈ 5–14 units (0.25–0.70 units/tick avg).
  console.log('\n── Physics speed sanity ──');
  const avgSpeed = Math.abs(dzA) / (TICKS - 5);
  console.log(`  Average speed: ${avgSpeed.toFixed(4)} units/tick (expected 0.50–0.70 for sprint)`);
  ok('Sprint speed within expected range (0.25–0.80 units/tick)',
     avgSpeed >= 0.25 && avgSpeed <= 0.80,
     `avg=${avgSpeed.toFixed(4)}`);

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}).catch(err => {
  console.error('[rate-test] bpw load failed:', err);
  process.exit(1);
});
