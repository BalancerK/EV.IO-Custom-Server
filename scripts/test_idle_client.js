/**
 * test_idle_client.js — a client that stops sending must not freeze the world around it.
 *
 * THE REPORT
 * ──────────
 * "if i put my browser tab into the background, my peers saw me freeze at the same place and they
 *  cant kill me, cant impulse me etc"  — and, separately, coming back after a few seconds
 * disconnected the player.
 *
 * TWO CAUSES, BOTH SERVER-SIDE
 * ────────────────────────────
 * 1. processBufferedTick returned early on an empty input queue. That is right for a BRIEF gap (one
 *    dropped packet: the client advanced no tick either, so simulating would drift the authoritative
 *    state away from a prediction that has not moved) and wrong for a tab that has stopped for
 *    seconds. The player became a statue — no gravity, knockback wrote a velocity nothing ever
 *    integrated, and spawn protection stopped counting down because it only decrements inside
 *    integratePlayerSim, so they were invulnerable for as long as the tab stayed hidden.
 *
 * 2. The inbound rate limiter was a hard one-second window. A background tab's timers are throttled
 *    and the client flushes what it buffered when it returns, so a legitimate catch-up burst was
 *    counted as a flood and closed with 4003.
 *
 * The fix keeps the hold for short gaps and simulates with EMPTY input past a grace period, echoing
 * -1 for those ticks because the body is no longer any client tick's state.
 *
 * Usage:  node scripts/test_idle_client.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';

const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const S = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

// A session whose last input arrived `quietMs` ago. Entry is gated on elapsed time rather than on a
// count of ticks that drained nothing, because with inputBufferDepth >= 1 the queue deliberately
// sits at the hold depth and drains nothing on plenty of perfectly healthy ticks.
function quietSession(playerState, quietMs = 10000) {
  return {
    sessionId: 'idle-1', playerId: 'idle-1', accepted: true,
    inputQueue: [], playerState,
    lastClientTick: 500, lastProcessedClientTick: 500,
    _lastInputMs: Date.now() - quietMs,
    _idleTicks: 0, _idleSimStartTick: 0,
  };
}
// A session that is mid-play: input arrived this instant.
const liveSession = (playerState) => quietSession(playerState, 0);

(async () => {
  await bpw.ready;
  const GRACE = S.get('idleSimGraceTicks');

  console.log('\n── a short gap is still held (one dropped packet must not diverge) ──');
  {
    const st = srv.createPlayerSimState();
    // Quiet for less than the grace window: a dropped packet, not a hidden tab.
    const s = quietSession(st, Math.max(0, GRACE * 50 - 200));
    // Put the player in the air so "was physics run" is observable as a change in Y.
    st.position.y += 6; st._ps.Qdsukt4.y += 6;
    const y0 = st._ps.Qdsukt4.y;
    for (let i = 1; i <= 4; i++) srv.processBufferedTick(s, 1000 + i, new Map());
    ok('within the grace period nothing is simulated', st._ps.Qdsukt4.y === y0,
      `y ${y0} -> ${st._ps.Qdsukt4.y}`);
    ok('and the tick is not counted as idle', s._idleTicks === 0, String(s._idleTicks));
  }

  console.log('\n── a queue sitting at inputBufferDepth is NOT idle ──');
  {
    // The trap this guards. With inputBufferDepth >= 1 (which is what the live server runs) the
    // drain deliberately leaves `depth` batches queued, so n === 0 on plenty of healthy ticks. Keying
    // idleness off that count would declare an ACTIVE player idle and clear the keys out from under
    // them mid-movement.
    const prev = S.get('inputBufferDepth');
    S.set('inputBufferDepth', 1, 'test');
    const st = srv.createPlayerSimState();
    const s = liveSession(st);
    st.heldActions = new Set([0]);                       // holding forward
    s.inputQueue.push({ clientTick: 501, frames: [{ held: [0], pressed: [], released: [] }] });
    for (let i = 1; i <= GRACE * 3; i++) {
      s._lastInputMs = Date.now();                       // packets keep arriving
      srv.processBufferedTick(s, 9000 + i, new Map());
    }
    ok('an active player is never flagged idle', s._idleTicks === 0, String(s._idleTicks));
    ok('their held keys are left alone', st.heldActions.has(0),
      'clearing these mid-play would read as movement cutting out');
    S.set('inputBufferDepth', prev, 'test');
  }

  console.log('\n── past the grace period the server simulates them anyway ──');
  {
    const st = srv.createPlayerSimState();
    const s = quietSession(st);
    st.position.y += 6; st._ps.Qdsukt4.y += 6;
    const y0 = st._ps.Qdsukt4.y;
    for (let i = 1; i <= 10; i++) srv.processBufferedTick(s, 2000 + i, new Map());
    ok('gravity applies to an idle player', st._ps.Qdsukt4.y < y0,
      `y ${y0.toFixed(2)} -> ${st._ps.Qdsukt4.y.toFixed(2)} — a frozen tab used to hover`);
  }

  console.log('\n── an idle player can still be pushed ──');
  {
    // This is the "cant impulse me" half of the report: knockback wrote a velocity that nothing
    // integrated, so peers saw the push and the player did not move.
    const st = srv.createPlayerSimState();
    const s = quietSession(st);
    srv.processBufferedTick(s, 3000, new Map());
    const x0 = st._ps.Qdsukt4.x;
    st._ps.Qyaswvo.x = 3;                       // as an impulse grenade would leave it
    for (let i = 1; i <= 5; i++) srv.processBufferedTick(s, 3100 + i, new Map());
    ok('an applied velocity actually moves them', Math.abs(st._ps.Qdsukt4.x - x0) > 0.1,
      `x ${x0.toFixed(2)} -> ${st._ps.Qdsukt4.x.toFixed(2)}`);
  }

  console.log('\n── spawn protection still expires while the tab is hidden ──');
  {
    // The regression this exists to prevent: Qalaptp only decrements inside integratePlayerSim, so
    // freezing a protected player made them permanently invulnerable — exactly "they cant kill me".
    const st = srv.createPlayerSimState();
    const s = quietSession(st);
    ok('the player starts protected', st._ps.Qalaptp > 0, String(st._ps.Qalaptp));
    const need = st._ps.Qalaptp + 2;
    for (let i = 1; i <= need; i++) srv.processBufferedTick(s, 4000 + i, new Map());
    ok('protection has expired', st._ps.Qalaptp <= 0,
      `Qalaptp=${st._ps.Qalaptp} after ${need} quiet ticks`);
    st.healthPoints = 1;
    srv.applyDamage(st, 0.5, null);
    ok('and they can be damaged', st.healthPoints < 1, `hp=${st.healthPoints}`);
  }

  console.log('\n── held keys are released on the way in ──');
  {
    // An idle tick reuses the LAST known held keys by design, so without this a player who
    // backgrounded the tab mid-sprint would keep running in a straight line the whole time.
    const st = srv.createPlayerSimState();
    const s = quietSession(st);
    st.heldActions = new Set([0, 7]);            // forward + sprint
    srv.processBufferedTick(s, 5000, new Map());
    ok('the held keys are cleared', st.heldActions.size === 0,
      `still holding ${[...st.heldActions].join(',')}`);

    const p0 = { x: st._ps.Qdsukt4.x, z: st._ps.Qdsukt4.z };
    for (let i = 1; i <= 40; i++) srv.processBufferedTick(s, 5100 + i, new Map());
    const moved = Math.hypot(st._ps.Qdsukt4.x - p0.x, st._ps.Qdsukt4.z - p0.z);
    ok('they do not keep running', moved < 1.0,
      `drifted ${moved.toFixed(2)}u over 40 idle ticks`);
  }

  console.log('\n── idle ticks are not labelled with a stale client tick ──');
  {
    // The body during idle simulation is the server's continuation PAST the client's last tick, so
    // labelling it with lastProcessedClientTick is the label-disagrees-with-body mistake that caused
    // the rotation stutter. -1 means "do not reconcile", which is also just true for a frozen tab.
    const st = srv.createPlayerSimState();
    const s = quietSession(st);
    const live = srv.computeEchoTick(s.lastProcessedClientTick, s);
    ok('a responsive client still gets a real echo', live === 500, String(live));
    srv.processBufferedTick(s, 6000, new Map());
    ok('an idle client gets -1', srv.computeEchoTick(s.lastProcessedClientTick, s) === -1,
      String(srv.computeEchoTick(s.lastProcessedClientTick, s)));
  }

  console.log('\n── input resuming ends the idle state at once ──');
  {
    const st = srv.createPlayerSimState();
    const s = quietSession(st);
    for (let i = 1; i <= 5; i++) srv.processBufferedTick(s, 7000 + i, new Map());
    ok('idle while quiet', s._idleTicks === 5, String(s._idleTicks));
    s.inputQueue.push({ clientTick: 501, frames: [{ held: [], pressed: [], released: [] }] });
    srv.processBufferedTick(s, 7100, new Map());
    ok('the idle counter resets', s._idleTicks === 0, String(s._idleTicks));
    ok('and the echo is a real tick again',
      srv.computeEchoTick(s.lastProcessedClientTick, s) === 501,
      String(srv.computeEchoTick(s.lastProcessedClientTick, s)));
  }

  console.log('\n── it can be turned off ──');
  {
    const prev = S.get('idleSimGraceTicks');
    S.set('idleSimGraceTicks', 0, 'test');
    const st = srv.createPlayerSimState();
    const s = quietSession(st);
    st.position.y += 6; st._ps.Qdsukt4.y += 6;
    const y0 = st._ps.Qdsukt4.y;
    for (let i = 1; i <= 40; i++) srv.processBufferedTick(s, 8000 + i, new Map());
    ok('0 restores the old freeze behaviour', st._ps.Qdsukt4.y === y0,
      `y ${y0} -> ${st._ps.Qdsukt4.y}`);
    S.set('idleSimGraceTicks', prev, 'test');
  }

  console.log('\n── the rate limiter tolerates a catch-up burst ──');
  {
    // The disconnect half of the report. A returning tab flushes what it buffered while hidden; the
    // old fixed one-second window counted that as a flood.
    const burst = S.get('msgBurstSeconds');
    const rate = S.get('maxMessagesPerSec');
    ok('there is a burst allowance', burst > 0,
      'without one, any catch-up flush above the per-second rate is a disconnect');
    ok('the bucket holds several seconds of traffic', rate * burst >= 600,
      `${rate} msg/s x ${burst}s = ${rate * burst} — a few seconds hidden at ~3 packets/tick`);

    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    ok('the limiter refills over time rather than resetting a window',
      /_msgTokens/.test(src) && !/session\._msgCount > MAX_MSG_PER_SEC/.test(src),
      'a fixed window cannot distinguish a burst from a sustained flood');
    ok('a sustained flood is still closed with 4003', /4003/.test(src));
  }

  console.log('\n── the heartbeat does not kill a tab for one late pong ──');
  {
    const misses = S.list().find((x) => x.key === 'heartbeatMisses');
    ok('heartbeatMisses is configurable', !!misses);
    ok('it allows more than one miss', misses && misses.value >= 2,
      `${misses && misses.value} — a pong is normally answered by the browser network stack, but a `
      + 'frozen renderer can stall it');
    const secs = (misses ? misses.value : 1) * S.get('heartbeatSeconds');
    ok('a genuinely dead socket is still reaped within a minute', secs <= 60, `${secs}s`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
