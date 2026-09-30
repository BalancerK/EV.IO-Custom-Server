/**
 * test_subframe_merge.js — every sub-frame of a client tick must reach the simulation.
 *
 * THE BUG
 * ───────
 * A client rendering above 20fps sends SEVERAL packets per 50ms tick, each carrying the sub-frames
 * produced since the last send, all stamped with the SAME client tick. The client's authoritative
 * state for that tick is the merge of all of them: held/pressed sets are UNIONed, look deltas are
 * SUMMED, and g() runs once.
 *
 * enqueueClientInput used to REPLACE the queued entry when a second packet arrived for a tick it
 * already had, keeping only the final packet's sub-frames.
 *
 * Held keys hid this — a key held across sub-frames reappears in the last packet, so movement was
 * unaffected. Look delta is summed, so every discarded sub-frame was lost rotation. That produced a
 * very specific signature: moving without turning felt perfectly smooth (all deltas zero, nothing
 * diverges), while turning diverged yaw past the comparator's 1e-4 tolerance EVERY tick and the
 * reconciler corrected it every tick — continuous stutter, but only while rotating.
 *
 * It stayed hidden for a long time because reconciliation was ~98% declined (see test_echo_lag.js);
 * with corrections never landing, the divergence was invisible.
 *
 * Usage:  node scripts/test_subframe_merge.js
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

// One sub-frame: [frac, [held, pressed, released, lookDelta, ?, ?]]
const frame = (dx = 0, dy = 0, held = []) => [1.0, [held, [], [], [dx, dy], null, null]];
// A client input packet: index 4 = client tick, index 5 = sub-frames.
const packet = (tick, frames) => [0, 0, 0, 0, tick, frames];
// The buffer depth is a tunable; read it rather than baking its value into assertions.
const DEPTH = require('../settings').list().find((x) => x.key === 'inputBufferDepth').value;

function mkSession(id) {
  return {
    sessionId: id, playerId: id, accepted: true,
    playerState: srv.createPlayerSimState({ x: 0, y: 5, z: 0, yaw: 0 }, id),
    inputQueue: [], lastProcessedClientTick: -1, lastClientTick: 0,
    ws: { readyState: 1, OPEN: 1, send() {} }, positionHistory: [],
  };
}

(async () => {
  await bpw.ready;

  console.log('\n── sub-frames split across packets are merged, not replaced ──');
  {
    const s = mkSession('m1');
    // Three packets, same client tick — a 60fps client during one 50ms server tick.
    srv.enqueueClientInput(s, packet(1, [frame(0.10, 0)]));
    srv.enqueueClientInput(s, packet(1, [frame(0.20, 0)]));
    srv.enqueueClientInput(s, packet(1, [frame(0.30, 0)]));
    ok('they collapse to ONE queued client tick', s.inputQueue.length === 1,
      `${s.inputQueue.length} entries`);
    ok('and every sub-frame is retained', s.inputQueue[0].frames.length === 3,
      `${s.inputQueue[0].frames.length} of 3 — replacing instead of merging keeps only the last`);
    const totalLook = s.inputQueue[0].frames.reduce((a, f) => a + f[1][3][0], 0);
    ok('the summed look delta is complete', Math.abs(totalLook - 0.60) < 1e-9,
      `sum=${totalLook} expected 0.60`);
  }

  console.log('\n── the simulated yaw matches the full input ──');
  {
    // Split across packets vs delivered as one packet must land on the SAME yaw. Any difference
    // above 1e-4 is what the client's comparator sees as a divergence.
    const split = mkSession('split');
    srv.enqueueClientInput(split, packet(1, [frame(0.05, 0)]));
    srv.enqueueClientInput(split, packet(1, [frame(0.05, 0)]));
    srv.enqueueClientInput(split, packet(1, [frame(0.05, 0)]));
    // INPUT_BUFFER_DEPTH holds the newest ticks back — that is what lets the echo trail the client
    // honestly instead of mislabelling current state with an older tick number. So DEPTH further
    // client ticks must arrive before tick 1 is released.
    for (let i = 0; i < DEPTH; i++) srv.enqueueClientInput(split, packet(2 + i, []));
    srv.processBufferedTick(split, 1, new Map([['split', split]]));

    const whole = mkSession('whole');
    srv.enqueueClientInput(whole, packet(1, [frame(0.05, 0), frame(0.05, 0), frame(0.05, 0)]));
    for (let i = 0; i < DEPTH; i++) srv.enqueueClientInput(whole, packet(2 + i, []));
    srv.processBufferedTick(whole, 1, new Map([['whole', whole]]));

    const d = Math.abs(split.playerState.yaw - whole.playerState.yaw);
    ok('split delivery yields the same yaw as one packet', d < 1e-9,
      `split=${split.playerState.yaw.toFixed(6)} whole=${whole.playerState.yaw.toFixed(6)} diff=${d}`);
    ok('and the yaw actually moved', Math.abs(split.playerState.yaw) > 1e-6,
      `yaw=${split.playerState.yaw}`);
    // The tolerance that decides whether the client reconciles.
    ok('the difference is inside the comparator tolerance (1e-4)', d < 1e-4,
      'above this the client corrects every tick while rotating');
  }

  console.log('\n── pure movement is unaffected (why this hid for so long) ──');
  {
    const s = mkSession('move');
    // Held keys with zero look: union semantics mean replacing loses nothing.
    srv.enqueueClientInput(s, packet(1, [frame(0, 0, [0])]));
    srv.enqueueClientInput(s, packet(1, [frame(0, 0, [0])]));
    ok('held actions survive either way', s.inputQueue[0].frames.every((f) => f[1][0].includes(0)));
    const look = s.inputQueue[0].frames.reduce((a, f) => a + f[1][3][0] + f[1][3][1], 0);
    ok('and there is no look delta to lose', look === 0,
      'this is exactly why moving without turning never stuttered');
  }

  console.log('\n── ordering and bounds ──');
  {
    const s = mkSession('ord');
    srv.enqueueClientInput(s, packet(1, [frame(0.1, 0)]));
    srv.enqueueClientInput(s, packet(2, [frame(0.1, 0)]));
    ok('a new client tick starts a new entry', s.inputQueue.length === 2);

    // An out-of-order/stale tick must not corrupt a later one.
    srv.enqueueClientInput(s, packet(1, [frame(9, 9)]));
    ok('a stale tick does not touch the newest entry',
      s.inputQueue[1].clientTick === 2 && s.inputQueue[1].frames.length === 1);

    // Already-simulated ticks are refused.
    const done = mkSession('done');
    done.lastProcessedClientTick = 5;
    srv.enqueueClientInput(done, packet(5, [frame(1, 1)]));
    ok('an already-simulated tick is refused', done.inputQueue.length === 0);

    // Flood protection.
    const flood = mkSession('flood');
    for (let i = 0; i < 500; i++) srv.enqueueClientInput(flood, packet(1, [frame(0.001, 0)]));
    ok('merging one tick forever stays bounded', flood.inputQueue[0].frames.length <= 64,
      `${flood.inputQueue[0].frames.length} sub-frames`);
    ok('and it is still a single entry', flood.inputQueue.length === 1);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
