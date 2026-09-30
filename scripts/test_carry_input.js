/**
 * test_carry_input.js — late sub-frames are carried, not lost.
 *
 * WHY
 * ───
 * A client above 20fps sends SEVERAL packets per 50ms tick, all stamped with the same client tick.
 * If the server simulates that tick before the last packet arrives, the stragglers used to hit
 *
 *     lose("late-already-simulated");   return;
 *
 * and were dropped. Look deltas are SUMMED, so a dropped sub-frame is rotation the server never
 * applies — the server ends up aiming somewhere the client never did, permanently.
 *
 * The input buffer existed to avoid that: hold each tick until the next one starts arriving, so
 * every sub-frame is in hand. It works, but it costs 50ms of PEER latency for everyone, on top of
 * the client's own 1-2 tick interpolation — a peer you see is (depth+1)*50 to (depth+2)*50 ms old
 * regardless of ping.
 *
 * Carrying the stragglers into the next tick applies the same rotation one tick late instead of
 * never. The error self-corrects on the following tick rather than accumulating, which is what
 * makes inputBufferDepth = 0 viable — and 0 is a straight 50ms off what every peer sees of you.
 *
 * Best paired with echoLagTicks = -1 (client-authoritative, exactly what official ev.io echoes), so
 * the one-tick offset never surfaces as a correction on the local player.
 *
 * Usage:  node scripts/test_carry_input.js
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

// One sub-frame carrying a yaw delta.
const f = (yaw) => [1.0, [[], [], [], [yaw, 0], null, null]];
const packet = (tick, frames) => [0, 0, 0, 0, tick, frames];

(async () => {
  await bpw.ready;
  const sp = bpw.spawnPoints[0];
  const mkSession = (id) => ({
    sessionId: id, playerId: id, accepted: true, displayName: id,
    playerState: srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, id),
    inputQueue: [], lastProcessedClientTick: -1, lastClientTick: 0,
    ws: { readyState: 1, OPEN: 1, send() {} }, positionHistory: [],
  });

  console.log('\n── a straggler is carried, not dropped ──');
  {
    const s = mkSession('a');
    // Tick 5 arrives and is simulated...
    srv.enqueueClientInput(s, packet(5, [f(0.10)]));
    s.lastProcessedClientTick = 5;                    // pretend it was drained
    // ...then a second packet for tick 5 turns up late.
    srv.enqueueClientInput(s, packet(5, [f(0.25)]));
    ok('the late frames are held for the next tick',
      (s._carryFrames || []).length === 1, `${(s._carryFrames || []).length} carried`);
    ok('and are NOT counted as lost', !(s._lookLost > 0),
      `lookLost=${s._lookLost || 0} — carrying must not report a loss`);
    ok('they are tracked separately', (s._lookCarried || 0) > 0, String(s._lookCarried));
  }

  console.log('\n── the carried rotation actually reaches the sim ──');
  {
    // Depth 0 — drain immediately. This is the configuration carry-forward exists FOR: at depth 1
    // a second packet for the same tick is still queued, so it MERGES and was never late to begin
    // with. Only when the tick has already been simulated can a straggler go missing.
    const depthBefore = S.list().find((x) => x.key === 'inputBufferDepth').value;
    S.set('inputBufferDepth', 0, 'test');

    const s = mkSession('b');
    const sessions = new Map([['b', s]]);
    const before = s.playerState.yaw;

    srv.enqueueClientInput(s, packet(1, [f(0.10)]));
    srv.processBufferedTick(s, 100, sessions);              // tick 1 simulated
    ok('depth 0 drains immediately', s.lastProcessedClientTick === 1,
      String(s.lastProcessedClientTick));

    srv.enqueueClientInput(s, packet(1, [f(0.25)]));        // straggler for an already-run tick
    ok('the straggler is carried', (s._carryFrames || []).length === 1);

    srv.enqueueClientInput(s, packet(2, [f(0.05)]));
    srv.processBufferedTick(s, 101, sessions);              // tick 2 + the carry

    const turned = s.playerState.yaw - before;
    ok('total yaw equals the SUM of every sub-frame sent',
      Math.abs(turned - 0.40) < 1e-9,
      `turned ${turned.toFixed(6)}, expected 0.400000 (0.10 + 0.25 carried + 0.05)`);
    ok('the carry is emptied after use', !(s._carryFrames && s._carryFrames.length),
      'leaving it queued would replay the same input every tick');

    // And the same run with carrying OFF must LOSE that rotation — otherwise this test proves
    // nothing about the fix.
    S.set('carryLateInput', false, 'test');
    const t = mkSession('b2');
    const ss = new Map([['b2', t]]);
    const before2 = t.playerState.yaw;
    srv.enqueueClientInput(t, packet(1, [f(0.10)]));
    srv.processBufferedTick(t, 100, ss);
    srv.enqueueClientInput(t, packet(1, [f(0.25)]));
    srv.enqueueClientInput(t, packet(2, [f(0.05)]));
    srv.processBufferedTick(t, 101, ss);
    const turned2 = t.playerState.yaw - before2;
    ok('with carrying OFF the 0.25 is genuinely lost',
      Math.abs(turned2 - 0.15) < 1e-9,
      `turned ${turned2.toFixed(6)}, expected 0.150000 — this is the bug the carry fixes`);
    S.set('carryLateInput', true, 'test');

    S.set('inputBufferDepth', depthBefore, 'test');
  }

  console.log('\n── nothing is carried when input is on time ──');
  {
    const s = mkSession('c');
    const sessions = new Map([['c', s]]);
    for (let t = 1; t <= 5; t++) {
      srv.enqueueClientInput(s, packet(t, [f(0.01)]));
      srv.processBufferedTick(s, 100 + t, sessions);
    }
    ok('no carry accumulates in the healthy case',
      !(s._carryFrames && s._carryFrames.length), String((s._carryFrames || []).length));
    ok('and nothing is reported lost', !(s._lookLost > 0), String(s._lookLost || 0));
  }

  console.log('\n── the carry cannot grow without bound ──');
  {
    // A client that floods one tick index must not be able to grow this for ever.
    const s = mkSession('d');
    s.lastProcessedClientTick = 10;
    for (let i = 0; i < 500; i++) srv.enqueueClientInput(s, packet(10, [f(0.001)]));
    ok('bounded to the per-tick sub-frame cap', (s._carryFrames || []).length <= 64,
      `${(s._carryFrames || []).length} frames`);
  }

  console.log('\n── the behaviour is switchable ──');
  {
    ok('carryLateInput exists and defaults ON',
      S.list().some((x) => x.key === 'carryLateInput' && x.default === true));
    ok('inputBufferDepth can now reach 0',
      S.list().find((x) => x.key === 'inputBufferDepth').min === 0,
      'that floor was only there because late input used to be lost');

    // With it off, the old behaviour must return exactly.
    S.set('carryLateInput', false, 'test');
    const s = mkSession('e');
    s.lastProcessedClientTick = 3;
    srv.enqueueClientInput(s, packet(3, [f(0.2)]));
    ok('off -> the frames are dropped and reported lost',
      !(s._carryFrames && s._carryFrames.length) && s._lookLost > 0,
      `carried=${(s._carryFrames || []).length} lost=${s._lookLost || 0}`);
    S.set('carryLateInput', true, 'test');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
