/**
 * test_echo_lag.js — the echoed client tick must never be newer than the client's own prediction.
 *
 * THE BUG
 * ───────
 * Qak2r7y's FIRST gate (bundle :27372):
 *
 *     if (this.Q1o1c43 < 0 || e.clientTick < 0 ||
 *         e.clientTick > this.Qxo2o14[0].Qt03jhz.Qoiudi1) return -1;
 *
 * The client refuses to reconcile against an echo newer than its newest local prediction — the
 * server would be acknowledging a tick it has not simulated yet. Its ring head at reconcile time is
 * the tick BEFORE the one it just sent (the new entry is unshifted AFTER Qak2r7y runs), so echoing
 * the newest processed client tick lands exactly ONE ahead and is refused every single tick.
 *
 * On a real network the round trip supplies that lag for free — official captures show the echo
 * trailing by ~4 ticks. On localhost there is none, so echoLagTicks:0 meant reconciliation was
 * effectively OFF while every other signal looked healthy. Measured in a live session:
 *
 *     echo=1330 ring=[1310..1329] depth=20  ->  calls=1328 ok=22 declined=1306   (98% refused)
 *
 * The floor of 1 in computeEchoTick is what makes that unrepresentable, whatever the setting says.
 *
 * Usage:  node scripts/test_echo_lag.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');
const settings = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

console.log('\n── the echo always trails the client ──');
{
  // The exact numbers from the live capture that exposed this.
  // lastProcessedClientTick is already one behind the newest RECEIVED tick (the buffer holds one
  // back), so echoing it directly still lands at or below the client's ring head.
  const echo = srv.computeEchoTick(1329);
  const ringHead = 1329;   // the client's newest prediction at reconcile time
  const ringTail = 1310;   // oldest entry still held (depth 20)
  ok('the echo is not newer than the client ring head', echo <= ringHead,
    `echo=${echo} ringHead=${ringHead} — anything above this is refused outright`);
  ok('the echo is still inside the ring', echo >= ringTail,
    `echo=${echo} ringTail=${ringTail} — below this the entry is gone and the lookup misses`);
}

console.log('\n── the invariant holds across the whole range ──');
{
  let bad = [];
  for (let t = 10; t < 5000; t += 7) {
    const e = srv.computeEchoTick(t);
    if (e > t) bad.push(`${t}->${e}`);
  }
  // Equal is correct and REQUIRED: the echo labels the tick whose state the body carries. Any
  // offset between label and body is the rotation-stutter bug.
  ok('the echo never labels a tick newer than the state being sent',
    bad.length === 0, bad.slice(0, 5).join(', '));
}

console.log('\n── a misconfigured lag cannot reintroduce the bug ──');
{
  // The echo is only a LABEL; the body carries the state as of lastProcessedClientTick. Pushing
  // the label back without moving the body made the client compare its prediction for tick T-lag
  // against a state that was really tick T — measured at 11.4 deg mean same-tick yaw error while
  // rotating, which is exactly the rotation stutter. The "trails the client" property must come
  // from INPUT_BUFFER_DEPTH holding a tick back instead.
  ok('the echo IS the processed tick', srv.computeEchoTick(100) === 100,
    `echo=${srv.computeEchoTick(100)} — any offset desyncs the label from the body`);
  // The trailing property used to require inputBufferDepth >= 1: holding a tick back was the only
  // way to be sure every sub-frame of that tick had arrived, because stragglers were DISCARDED.
  // With carryLateInput they are applied on the following tick instead, so depth 0 no longer loses
  // input — it just applies some of it a tick late, which self-corrects. Depth 0 is now the default
  // because it removes 50ms of peer-visible latency for everyone.
  //
  // So the invariant is no longer "depth >= 1"; it is "input is never silently dropped": either the
  // buffer holds the tick back, or the carry picks up whatever arrived late.
  const depth = settings.list().find((x) => x.key === 'inputBufferDepth');
  const carry = settings.list().find((x) => x.key === 'carryLateInput');
  ok('late input cannot be silently dropped',
    !!depth && !!carry && (depth.value >= 1 || carry.value === true),
    `inputBufferDepth=${depth && depth.value} carryLateInput=${carry && carry.value}`
    + ' — depth 0 without the carry loses rotation permanently');
}

console.log('\n── reconciliation can still be disabled deliberately ──');
{
  const prev = settings.get('echoLagTicks');
  settings.set('echoLagTicks', -1);
  ok('-1 echoes -1 (client-authoritative, reconcile skipped)', srv.computeEchoTick(1330) === -1,
    'this is an explicit opt-out, not the accidental one');
  settings.set('echoLagTicks', prev);
}

console.log('\n── early ticks degrade safely ──');
{
  // Before enough ticks exist to lag by, -1 is correct: the client has nothing to match against.
  ok('tick 0 yields -1', srv.computeEchoTick(0) === -1);
  ok('a negative processed tick yields -1', srv.computeEchoTick(-1) === -1);
  ok('non-finite input yields -1', srv.computeEchoTick(NaN) === -1);
  ok('once past the lag it produces a real tick', srv.computeEchoTick(50) > 0);
}

console.log('\n── the default is sane ──');
{
  const entry = settings.list().find((x) => x.key === 'echoLagTicks');
  ok('echoLagTicks defaults to 0 — the buffer provides the trailing, not a label offset',
    !!entry && entry.value === 0, entry ? String(entry.value) : 'missing');
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
