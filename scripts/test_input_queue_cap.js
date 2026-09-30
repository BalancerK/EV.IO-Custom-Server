/**
 * test_input_queue_cap.js — the input queue can never outgrow the client's reconciliation ring.
 *
 * REPORTED SYMPTOM
 * ─────────────────
 * "Under intense combat with not-so-good internet, tick desync sometimes happened — the player
 * still at tick 1 but the server already at tick 100 — and it takes a very long time to reconcile
 * back."
 *
 * THE BUG
 * ────────
 * enqueueClientInput's overflow guard trimmed the queue at a hardcoded 120 entries — a number
 * picked purely to bound memory, unrelated to the client's own reconciliation ring, which this
 * project's earlier reverse-engineering already documented as hard-capped at 100 entries (see the
 * comments at ECHO_LAG_TICKS). So the server was willing to hold MORE backlog than the client could
 * ever match against, even in principle. Once packet loss (WebSocket runs over TCP, so one lost
 * packet stalls everything queued behind it until retransmission, then it all lands in one burst —
 * exactly what "not so good internet" produces) pushed the backlog past the ring's capacity, the
 * server kept draining and echoing correctly, but every echo named a tick too stale for the
 * client's lookup to find — reconciliation silently stopped, and nothing about faster draining
 * fixes that, because the problem was never drain SPEED.
 *
 * THE FIX
 * ────────
 * `inputQueueMaxTicks` replaces the hardcoded 120, defaults to 80 (margin under the ring's 100),
 * and its `max` is hard-capped at 100 in the setting definition itself — so raising it via env,
 * the dashboard, or a saved settings file cannot silently reintroduce this bug.
 *
 * Usage:  node scripts/test_input_queue_cap.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = process.env.EVIO_LOCAL_PORT || '18465';
process.env.EVIO_JOIN_DEADLINE = '0';

const WebSocket = require('ws');
const msgpack = require('@msgpack/msgpack');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const S = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = `ws://127.0.0.1:${process.env.EVIO_LOCAL_PORT}`;

(async () => {
  await bpw.ready;
  srv.startServer();
  await wait(300);

  console.log('\n── the setting exists, defaults under the ring cap, and cannot exceed it ──');
  {
    const e = S.list().find((x) => x.key === 'inputQueueMaxTicks');
    ok('inputQueueMaxTicks is a setting', !!e);
    ok('it defaults to 80 — comfortably under the ring\'s 100-entry hard cap', e && e.value === 80,
      String(e && e.value));
    ok('its declared max IS the ring cap (100) — cannot be configured past it', e && e.max === 100,
      String(e && e.max));
    const attempt = S.set('inputQueueMaxTicks', 150, 'test');
    ok('an attempt to raise it above 100 is REJECTED, not clamped or accepted', attempt.ok === false,
      JSON.stringify(attempt));
    ok('the live value is unchanged after the rejected attempt', S.get('inputQueueMaxTicks') === 80,
      String(S.get('inputQueueMaxTicks')));
  }

  console.log('\n── a session\'s queue never exceeds the cap, however much arrives ──');
  {
    S.set('inputQueueMaxTicks', 20, 'test');   // small, so the test does not need thousands of packets
    const ws = new WebSocket(URL);
    await new Promise((r) => ws.on('open', r));
    ws.send(';' + JSON.stringify({ uid: 17, name: 'Overflow' }));
    await wait(300);
    const session = [...srv.getSessions().values()].find((s) => s.displayName === 'Overflow');
    ok('the session exists', !!session);

    if (session) {
      // Send far more ticks than the cap in one uninterrupted burst — modelling a TCP stall that
      // clears all at once. clientTick must stay strictly increasing (see enqueueClientInput's
      // out-of-order guard) so every one of these is accepted as NEW, not merged into an existing
      // entry — the overflow path is only reachable via genuinely distinct ticks.
      const sendPacket = (ct) => ws.send(msgpack.encode([0, 0, -1, -1, ct, [[1, [[0], [], [], [0, 0]]]]]));
      for (let ct = 1; ct <= 200; ct++) sendPacket(ct);
      await wait(300);   // give the loopback socket time to deliver; server ticks may also drain some

      const depth = (session.inputQueue || []).length;
      ok('queue depth never exceeded the configured cap', depth <= 20, `depth=${depth}`);
      ok('the overflow was counted, not silently absorbed', (session._dropCount || 0) > 0,
        `_dropCount=${session._dropCount}`);
    }
    try { ws.close(); } catch (_) {}
    await wait(200);
  }

  console.log('\n── the trim keeps the NEWEST entries, drops the OLDEST ──');
  {
    // Correctness of the trim direction matters as much as the cap itself: keeping stale entries
    // and dropping fresh ones would be actively worse than no cap at all.
    //
    // Calls enqueueClientInput DIRECTLY rather than sending over a real WebSocket + racing the live
    // tick loop's drain. That used to be a real WS round trip checked after a fixed sleep, tuned
    // once already (250ms -> 15ms) after the FIRST version raced the wrong direction — a longer
    // wait let normal draining empty the queue before the assertion ever looked at it. CI's
    // different scheduling then hit the SAME class of race from the other side: sending 50 packets
    // and reading the result back within a razor-thin 15ms window is exactly the kind of thing a
    // slower/shared runner can blow through, which is what actually happened (queue observed fully
    // drained — "newest kept: undefined"). The fix isn't a bigger number to tune again; it's not
    // racing wall-clock time against the tick loop at all. enqueueClientInput needs nothing from a
    // real connection — it is exported precisely so its queue/overflow logic is testable like this.
    S.set('inputQueueMaxTicks', 10, 'test');
    const session = { inputQueue: [], sessionId: 'fake-trim-order' };
    for (let ct = 1; ct <= 50; ct++) {
      srv.enqueueClientInput(session, [0, 0, -1, -1, ct, [[1, [[0], [], [], [0, 0]]]]]);
    }

    const ticks = session.inputQueue.map((b) => b.clientTick);
    ok('the queue holds a suffix of the sent ticks (newest survive)', ticks.length > 0
      && ticks[ticks.length - 1] >= 40, `newest kept: ${ticks[ticks.length - 1]}, sent up to 50`);
    ok('the queue is still in ascending order after trimming', ticks.every((t, i) => i === 0 || t > ticks[i - 1]),
      JSON.stringify(ticks));
    ok('depth matches the cap exactly (nothing over-trimmed)', ticks.length === 10, String(ticks.length));
    ok('the newest tick sent (50) is the last one in the queue', ticks[ticks.length - 1] === 50,
      String(ticks[ticks.length - 1]));
  }

  console.log('\n── normal, non-overflowing play is completely unaffected ──');
  {
    S.set('inputQueueMaxTicks', 80, 'test');   // restore the real default
    const ws = new WebSocket(URL);
    await new Promise((r) => ws.on('open', r));
    ws.send(';' + JSON.stringify({ uid: 17, name: 'Normal' }));
    await wait(300);
    const session = [...srv.getSessions().values()].find((s) => s.displayName === 'Normal');
    let ct = 1;
    const pump = setInterval(() => {
      try { ws.send(msgpack.encode([0, 0, -1, -1, ct++, [[1, [[0], [], [], [0.001, 0]]]]])); } catch (_) {}
    }, 50);
    await wait(1000);
    clearInterval(pump);
    ok('a normally-paced session never triggers the overflow path', (session && session._dropCount || 0) === 0,
      `_dropCount=${session && session._dropCount}`);
    ok('the tick rate stayed healthy throughout', srv.getStatus().tickRate > 18,
      String(srv.getStatus().tickRate));
    try { ws.close(); } catch (_) {}
  }

  S.reset('inputQueueMaxTicks', 'test');

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
