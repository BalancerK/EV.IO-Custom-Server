/**
 * test_reconcile_anchor.js — bounded drift while the client is authoritative.
 *
 * WHY
 * ───
 * echoLagTicks = -1 makes the client authoritative over its own movement (what official ev.io does)
 * and stops the constant corrections. The cost is that the client is then NEVER told it is wrong, so
 * any per-tick difference accumulates forever.
 *
 * Normally that is tolerable, because our sim IS the client's extracted g(). SLIDE BOOSTING is not:
 * slide entry is a velocity THRESHOLD and entry multiplies velocity, so it is self-amplifying and
 * chaotically sensitive. A sub-tolerance difference decides whether the boost fires this tick or the
 * next, and one missed boost is a large permanent position difference. Chained, the two sims end up
 * somewhere completely different — invisible until an impulse forces a reconcile and the player snaps
 * across the whole gap. That is the reported bug.
 *
 * reconcileAnchorTicks forces a short reconcile burst every N ticks so drift is bounded by one
 * interval. This checks the mechanism: off by default, fires on schedule when enabled, only while
 * client-authoritative, and never suppresses an event-driven burst (an impulse must still correct
 * immediately, not wait for the next anchor).
 *
 * Usage:  node scripts/test_reconcile_anchor.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = '18405';
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

// A session stub good enough for computeEchoTick: it only reads playerState, _idleTicks and
// lastProcessedClientTick.
function stubSession() {
  return { playerState: { _reconcileFor: 0 }, _idleTicks: 0, lastProcessedClientTick: 500 };
}

(async () => {
  await bpw.ready;
  srv.startServer();
  await wait(300);

  // A REAL connection is required, not optional scaffolding: the global tick loop only runs while at
  // least one client is connected, and the anchor is driven by the global tick. Without this the
  // tick stays at 0, `now - last >= interval` is never true, and the anchor silently never fires —
  // which is exactly how the first run of this test reported a broken anchor against working code.
  const ws = new WebSocket('ws://127.0.0.1:18405');
  await new Promise((r) => ws.on('open', r));
  ws.send(';' + JSON.stringify({ uid: 17, name: 'Anchor' }));
  await wait(400);
  ok('the tick loop is running (required for the anchor)', srv.getStatus().globalTick > 0,
    'tick=' + srv.getStatus().globalTick);

  console.log('\n── the setting exists and is off by default ──');
  {
    const e = S.list().find((x) => x.key === 'reconcileAnchorTicks');
    ok('reconcileAnchorTicks is a setting', !!e);
    ok('it defaults to OFF', e && e.value === 0,
      'enabling it by default would add a periodic nudge nobody asked for');
    ok('and it lives under Netcode', e && e.category === 'Netcode', e && e.category);
  }

  console.log('\n── it does nothing while the SERVER is authoritative ──');
  {
    S.set('echoLagTicks', 0, 'test');
    S.set('reconcileAnchorTicks', 5, 'test');
    const s = stubSession();
    // With echo lag >= 0 every tick already carries a real tick; an anchor would be meaningless.
    const echoes = [];
    for (let i = 0; i < 12; i++) echoes.push(srv.computeEchoTick(500, s));
    ok('every echo is a real tick, unchanged by the anchor',
      echoes.every((e) => e === 500), echoes.slice(0, 6).join(','));
    ok('and no burst was consumed', (s.playerState._reconcileFor || 0) === 0);
  }

  console.log('\n── while CLIENT authoritative it re-anchors on schedule, ON THE WIRE ──');
  {
    // OBSERVED FROM A REAL SOCKET, not by calling computeEchoTick.
    //
    // This is the assertion that matters, and the reason the first version of this test was
    // worthless. The production tick model ("buffer") computes its echo INLINE and never calls
    // computeEchoTick, so a test that calls that function directly passes happily while the feature
    // does nothing whatsoever for real players — which is exactly what shipped. Anything touching
    // the echo has to be verified on the wire. The echo is envelope field 1.
    //
    // A REALISTIC interval too: an interval shorter than one burst leaves the player permanently
    // mid-burst, which measures nothing except that the burst is longer than the interval.
    S.set('echoLagTicks', -1, 'test');
    S.set('reconcileAnchorTicks', 20, 'test');   // 1s
    const echoes = [];
    const onMsg = (buf) => {
      let env; try { env = msgpack.decode(buf); } catch (_) { return; }
      if (Array.isArray(env) && env.length >= 2 && typeof env[1] === 'number') echoes.push(env[1]);
    };
    ws.on('message', onMsg);
    // Keep input flowing, or the session goes idle and BOTH paths force -1 for that reason instead.
    let ct = 1000;
    const pump = setInterval(() => {
      try { ws.send(msgpack.encode([0, 0, -1, -1, ct++, [[1, [[], [], [], [0.001, 0]]]]])); } catch (_) {}
    }, 50);
    await wait(3000);
    clearInterval(pump);
    ws.off('message', onMsg);

    const real = echoes.filter((e) => e > 0).length;
    const free = echoes.filter((e) => e === -1).length;
    ok('the anchor reaches the WIRE on the production path', real > 0,
      `${real} real echoes of ${echoes.length} packets — 0 means the buffer path never anchors`);
    ok('but most packets stay client-authoritative', free > real, `${free} free vs ${real} corrected`);
  }

  console.log('\n── disabled means disabled ──');
  {
    S.set('echoLagTicks', -1, 'test');
    S.set('reconcileAnchorTicks', 0, 'test');
    const s = stubSession();
    const seen = [];
    for (let i = 0; i < 25; i++) { seen.push(srv.computeEchoTick(500, s)); await wait(40); }
    ok('every echo is -1 with the anchor off', seen.every((e) => e === -1),
      `${seen.filter((e) => e !== -1).length} unexpected corrections`);
  }

  console.log('\n── an event-driven burst still fires immediately ──');
  {
    // The whole point of selective reconciliation: an impulse must correct NOW, not at the next
    // anchor. If the anchor logic swallowed these, grenades would stop pushing people again.
    S.set('echoLagTicks', -1, 'test');
    S.set('reconcileAnchorTicks', 600, 'test');   // effectively never
    const s = stubSession();
    ok('idle ticks are client-authoritative', srv.computeEchoTick(500, s) === -1);
    srv.requestReconcile(s.playerState, 3);
    const burst = [srv.computeEchoTick(500, s), srv.computeEchoTick(500, s), srv.computeEchoTick(500, s)];
    // burstEchoTick deliberately backs the echo off by RECONCILE_ECHO_BACKOFF ticks, so it is a real
    // tick but NOT lastProcessedClientTick. Asserting equality with 500 tested the backoff constant,
    // not the burst.
    ok('the requested burst corrects immediately', burst.every((e) => e > 0), burst.join(','));
    ok('and then it goes back to running free', srv.computeEchoTick(500, s) === -1);
  }

  console.log('\n── the burst echo LABELS the body it actually sends ──');
  {
    // The single worst netcode bug found in this project. The burst body is the server's state as of
    // lastProcessedClientTick; backing the echo off labels that body as an OLDER tick, so the client
    // adopts a newer state as an older prediction, replays its inputs on top, and ends up exactly
    // that many ticks AHEAD — permanently, after every knockback.
    //
    // Measured on the live server: backoff 2 gave a permanent 2-tick offset (SRV(t) == CLI(t-2),
    // 27/27 ticks), compounding to 80-120u as the sims hit different geometry, 91-95% of ticks
    // diverging. Backoff 0 gave phase offset ZERO and 10.4% diverging, with no compounding.
    const e = S.list().find((x) => x.key === 'reconcileEchoBackoff');
    ok('reconcileEchoBackoff defaults to 0', e && e.value === 0, String(e && e.value));

    S.set('echoLagTicks', -1, 'test');
    S.set('reconcileAnchorTicks', 0, 'test');
    S.set('reconcileEchoBackoff', 0, 'test');
    const s = stubSession();
    srv.requestReconcile(s.playerState, 2);
    const echo = srv.computeEchoTick(500, s);
    ok('the burst echoes exactly the tick the body describes',
      echo === s.lastProcessedClientTick,
      `echo=${echo} vs body tick ${s.lastProcessedClientTick}`);
  }

  console.log('\n── coming back from idle simulation corrects the client ──');
  {
    // Idle simulation moves a player by an amount their client did not and CANNOT predict. Under
    // echoLagTicks = -1 nothing else ever tells them, so without a burst on resume the gap is
    // PERMANENT.
    //
    // MEASURED: a ~650ms browser hitch while falling left the server 8.3u below the client in a
    // single tick; uncorrected it persisted for 275 ticks and reached 80u — that one event was 273
    // of the 339 diverging ticks in the session, i.e. the entire residual once the echo-label bug
    // was fixed.
    S.set('echoLagTicks', -1, 'test');
    const sessions = srv.getSessions();
    const live = [...sessions.values()].find((x) => x && x.playerState);
    ok('a live session is available', !!live);
    if (live) {
      live.playerState._reconcileFor = 0;
      live._idleTicks = 7;                      // pretend we idle-simulated for 7 ticks
      live.inputQueue = live.inputQueue || [];
      live.inputQueue.push({ clientTick: (live.lastProcessedClientTick || 0) + 1, frames: [] });
      live._lastInputMs = Date.now();
      srv.processBufferedTick(live, (srv.getStatus().globalTick || 0) + 1, sessions);
      ok('the resume clears the idle counter', (live._idleTicks || 0) === 0);
      ok('and requests a reconcile burst so the client adopts what we simulated',
        (live.playerState._reconcileFor || 0) > 0,
        `_reconcileFor=${live.playerState._reconcileFor}`);
    }
  }

  console.log('\n── a held player is still never reconciled ──');
  {
    // The arrival view depends on this: reconciling a held player restores state 1 and puts the
    // first-person camera and weapon back on screen.
    S.set('reconcileAnchorTicks', 1, 'test');
    S.set('echoLagTicks', -1, 'test');
    const s = stubSession();
    s.playerState._holdForPlay = true;
    const seen = [];
    for (let i = 0; i < 10; i++) { seen.push(srv.computeEchoTick(500, s)); await wait(30); }
    ok('a held player is never given a real echo', seen.every((e) => e === -1),
      'the anchor must not resurrect the first-person arrival bug');
  }

  try { ws.close(); } catch (_) {}
  await wait(150);
  S.reset('echoLagTicks', 'test');
  S.reset('reconcileAnchorTicks', 'test');

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
