/**
 * test_sim_fault.js — a throwing tick must not strand one player in a permanent desync.
 *
 * WHY THIS EXISTS
 * ───────────────
 * The client's reconciler is TICK-INDEXED: it finds its own prediction by the client tick the
 * server echoes back. In processBufferedTick the batch is `q.shift()`ed BEFORE the sim runs, and
 * the echo (`lastProcessedClientTick`) was only assigned AFTER it. So a throw meant the client tick
 * was consumed but never acknowledged: the server went on echoing a tick the client had already
 * retired while the client kept predicting past it, and the reconciler's lookup missed on every
 * subsequent tick.
 *
 * That is the difference between "one bad tick" (self-correcting — the next authoritative packet
 * fixes it) and "this player is now permanently behind". The echo therefore advances in a `finally`,
 * whatever the sim does.
 *
 * Originally this fault killed the whole server: the scheduler ran `runGlobalTick(); loop();`, so an
 * exception skipped the reschedule and the game loop never ran again.
 *
 * Usage:  node scripts/test_sim_fault.js
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

function mkSession(id, spawn) {
  return {
    sessionId: id, playerId: id, accepted: true, displayName: id,
    playerState: srv.createPlayerSimState({ ...spawn, yaw: 0 }, id),
    inputQueue: [], lastProcessedClientTick: -1, lastClientTick: 0,
    ws: { readyState: 1, OPEN: 1, send() {} },
    positionHistory: [],
  };
}
const batch = (clientTick) => ({ clientTick, frames: [[1.0, [[], [], [], [0, 0], null, null]]] });
// The buffer depth is a tunable; read it rather than baking its value into assertions.
const DEPTH = require('../settings').list().find((x) => x.key === 'inputBufferDepth').value;

(async () => {
  await bpw.ready;
  const sp = bpw.spawnPoints[0];

  console.log('\n── the echo keeps advancing even when the sim throws ──');
  {
    const s = mkSession('faulty', sp);
    const sessions = new Map([['faulty', s]]);
    // Poison the physics state so integratePlayerSim throws: a getter that blows up on read is a
    // stand-in for whatever real fault the sim hits, and keeps this test independent of the cause.
    let boom = false;
    Object.defineProperty(s.playerState, 'yaw', {
      get() { if (boom) throw new Error('synthetic sim fault'); return this._yaw || 0; },
      set(v) { this._yaw = v; },
      configurable: true,
    });

    // Feed one client tick per server tick, the way a live client does. The echo must track the
    // tick just consumed on EVERY tick, faults included — the queue depth policy
    // (INPUT_BUFFER_DEPTH) is deliberately allowed to hold a batch back, so assert the echo
    // against what was actually drained rather than a fixed number.
    boom = true;
    const stalls = [];
    // DEPTH ticks stay buffered, so the echo trails by DEPTH. It must still ADVANCE every tick,
    // which is the property under test.
    for (let i = 0; i < DEPTH; i++) s.inputQueue.push(batch(9 - DEPTH + i + 1));
    for (let t = 10; t <= 15; t++) {
      s.inputQueue.push(batch(t));
      const before = s.lastProcessedClientTick;
      srv.processBufferedTick(s, 100 + t, sessions);
      if (s.lastProcessedClientTick <= before) stalls.push(t);
    }
    boom = false;

    ok('the faulty ticks were counted as errors', (s._simErrors || 0) > 0,
      `simErrors=${s._simErrors || 0}`);
    ok('the echo advanced on every faulting tick', stalls.length === 0,
      `stalled at client ticks ${stalls.join(',')} — a stalled echo strands the reconciler`);
    ok('the echo kept pace with the client', s.lastProcessedClientTick === 15 - DEPTH,
      `echo=${s.lastProcessedClientTick}, client sent up to 15, depth=${DEPTH}`);
    ok('the input queue did not pile up', s.inputQueue.length === DEPTH,
      `${s.inputQueue.length} left — that is the buffer depth, not a backlog`);

    // And it must recover cleanly once the fault clears.
    const errsAtFaultEnd = s._simErrors || 0;
    s.inputQueue.push(batch(16));
    srv.processBufferedTick(s, 200, sessions);
    ok('a healthy tick after the fault is processed normally',
      s.lastProcessedClientTick === 16 - DEPTH, `echo=${s.lastProcessedClientTick}`);
    ok('and records no new error', (s._simErrors || 0) === errsAtFaultEnd);
  }

  console.log('\n── one bad player does not cost the others their tick ──');
  {
    const good = mkSession('good', sp);
    const bad = mkSession('bad', sp);
    const sessions = new Map([['good', good], ['bad', bad]]);
    Object.defineProperty(bad.playerState, 'yaw', {
      get() { throw new Error('synthetic sim fault'); },
      set() {}, configurable: true,
    });
    for (let i = 0; i <= DEPTH; i++) {
      good.inputQueue.push(batch(20 - DEPTH + i));
      bad.inputQueue.push(batch(20 - DEPTH + i));
    }

    // Mirrors the per-player isolation in runGlobalTick.
    for (const s of sessions.values()) {
      try { srv.processBufferedTick(s, 200, sessions); } catch (_) { /* isolated */ }
    }
    ok('the healthy player still advanced', good.lastProcessedClientTick === 20 - DEPTH);
    ok('the faulty player still acknowledged its tick', bad.lastProcessedClientTick === 20 - DEPTH);
    ok('only the faulty player recorded an error',
      (bad._simErrors || 0) > 0 && !(good._simErrors || 0));
  }

  console.log('\n── the fault is visible, not silent ──');
  {
    const st = srv.getStatus();
    ok('status exposes a sim error counter', typeof st.simErrors === 'number', String(st.simErrors));
    ok('status carries the last error message', st.simErrors === 0 || !!st.lastSimError);
    ok('status exposes a tick error counter', typeof st.tickErrors === 'number');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
