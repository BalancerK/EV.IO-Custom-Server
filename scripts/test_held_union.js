/**
 * test_held_union.js — a tick's held keys are the UNION of its sub-frames.
 *
 * THE BUG
 * ───────
 * The movement step correctly built `curHeld` as the union across a tick's sub-frames — matching
 * the client, which merges a tick by UNIONing held/pressed and summing look (bundle ~18652) — and
 * then overwrote `playerState.heldActions` with only the LAST sub-frame's keys:
 *
 *     playerState._prevHeldKeys = new Set(lastHeldArr...);
 *     playerState.heldActions   = new Set(playerState._prevHeldKeys);   // last frame only
 *
 * `preTickFire` reads `heldActions` on the NEXT tick to gate firing, zoom and reload. A key held
 * earlier in the tick but absent from the final sub-frame was therefore dropped.
 *
 * That is invisible when standing still — few sub-frames, and the last one carries everything — but
 * while MOVING the client sends several sub-frames per tick, so fire (action 5) could vanish. Losing
 * it costs `_firingThisTick`, which costs the `Qezh4wz = 0` reset, which costs the RECOIL ARM. The
 * symptom was recoil that worked stationary and disappeared while moving, visible on peers because
 * the server streamed an un-recoiled pitch while the client predicted a recoiled one — so every
 * shot-while-moving reconciled the camera.
 *
 * `_prevHeldKeys` deliberately stays the last sub-frame: it exists to detect press EDGES on the
 * following idle tick, and an edge is about the final state.
 *
 * Usage:  node scripts/test_held_union.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');
const bpw = require('../physics_world');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
// One sub-frame with the given held keys.
const f = (held, pressed = []) => [1.0, [held, pressed, [], [0, 0], null, null]];

(async () => {
  await bpw.ready;
  const sp = bpw.spawnPoints[0];
  const mk = () => srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 'p');

  console.log('\n── held keys survive a tick whose last sub-frame drops them ──');
  {
    // Moving (0 = forward) and firing (5), but the final sub-frame carries movement only.
    const ps = mk();
    srv.integratePlayerSim(ps, 0.05, 1, [f([0, 5]), f([0, 5]), f([0])]);
    ok('fire is preserved from an earlier sub-frame', ps.heldActions.has(5),
      `heldActions = [${[...ps.heldActions]}] — taking only the last sub-frame loses it`);
    ok('movement is still there too', ps.heldActions.has(0));
  }

  console.log('\n── and in the other order ──');
  {
    const ps = mk();
    srv.integratePlayerSim(ps, 0.05, 1, [f([0]), f([0, 5])]);
    ok('a key that appears only in the LAST sub-frame is kept', ps.heldActions.has(5));
  }

  console.log('\n── zoom and reload use the same set, so they are covered too ──');
  {
    const ps = mk();
    srv.integratePlayerSim(ps, 0.05, 1, [f([0, 6, 30]), f([0])]);
    ok('zoom (6) survives', ps.heldActions.has(6));
    ok('reload (30) survives', ps.heldActions.has(30));
  }

  console.log('\n── standing still was always fine (why this hid) ──');
  {
    const ps = mk();
    srv.integratePlayerSim(ps, 0.05, 1, [f([5])]);
    ok('a single sub-frame holding fire keeps it', ps.heldActions.has(5),
      'with one sub-frame the union and the last frame are identical');
  }

  console.log('\n── releasing a key still clears it ──');
  {
    // The union is per-TICK; a key absent from every sub-frame of the next tick must go away, or
    // fire would latch on forever.
    const ps = mk();
    srv.integratePlayerSim(ps, 0.05, 1, [f([0, 5])]);
    ok('fire held on tick 1', ps.heldActions.has(5));
    srv.integratePlayerSim(ps, 0.05, 2, [f([0])]);
    ok('fire released on tick 2 is gone', !ps.heldActions.has(5),
      `heldActions = [${[...ps.heldActions]}] — the union must not latch across ticks`);
    ok('movement still held', ps.heldActions.has(0));
  }

  console.log('\n── the press-edge snapshot stays last-frame ──');
  {
    // _prevHeldKeys exists to detect edges on the next idle tick, so it must remain the FINAL
    // state, not the union — otherwise a key released mid-tick would look still-held.
    const ps = mk();
    srv.integratePlayerSim(ps, 0.05, 1, [f([0, 5]), f([0])]);
    ok('_prevHeldKeys is the last sub-frame, not the union',
      ps._prevHeldKeys && !ps._prevHeldKeys.has(5) && ps._prevHeldKeys.has(0),
      `_prevHeldKeys = [${ps._prevHeldKeys ? [...ps._prevHeldKeys] : ''}]`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
