/**
 * test_sync_channel.js
 *
 * Pins the envelope `sync` field — the server→client CLOCK-SYNC channel.
 *
 * WHY THIS TEST EXISTS
 * ────────────────────
 * The packet is `[sync, clientTick, body]`. `sync` looks like a tick counter and was sent as one
 * for months. It is not: the client assigns it to `lagAccumulator` (bundle :27351) and computes
 * its own tick period from it every frame (:27277):
 *
 *     period = TICK_MS + lagAccumulator * 2 + tickErrorCount
 *
 * So a growing counter tells the client to tick ever more slowly — a stock client stops sending
 * input within seconds. Ours only worked because userscript patch 6d3 clamps sync to ±3, which
 * pinned the client at 56ms (17.86Hz) against our 20Hz server: a permanent ~2Hz desync.
 *
 * All three official captures send `sync = 0` on every server→client packet.
 *
 * This regression is invisible in normal testing — nothing errors, the client just runs slow —
 * so it gets a test.
 *
 * Usage: node scripts/test_sync_channel.js
 */
'use strict';

const S = require('../settings');
const srv = require('../local_ws_server');
const sb = require('../state_builder');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

// The client's own formula, so the assertions read in the units that actually matter: Hz.
const TICK_MS = 50, N = 2;
const periodFor = (sync) => TICK_MS + sync * N;
const hzFor = (sync) => 1000 / periodFor(sync);

const fakeSession = (queueDepth, legacyTick) => ({
  inputQueue: new Array(queueDepth).fill({ clientTick: 0, frames: [] }),
  _legacySyncTick: legacyTick,
});

console.log('\n── default (zero): the client must tick at exactly 20Hz ──');
{
  ok('syncMode defaults to "zero"', S.get('syncMode') === 'zero', `got ${S.get('syncMode')}`);
  const sync = srv.computeSyncValue(fakeSession(0, 12345));
  ok('sync is 0 even at server tick 12345', sync === 0, `got ${sync}`);
  ok('→ client tick period is exactly 50ms', periodFor(sync) === 50);
  ok('→ client ticks at exactly 20Hz', Math.abs(hzFor(sync) - 20) < 1e-9,
    `got ${hzFor(sync).toFixed(3)}Hz`);
  // A deep queue must NOT leak into zero mode — that is what adaptive is for.
  ok('a backed-up queue does not change it in zero mode',
    srv.computeSyncValue(fakeSession(30, 999)) === 0);
}

console.log('\n── the bug this replaces ──');
{
  S.set('syncMode', 'tick', 'test');
  const sync = srv.computeSyncValue(fakeSession(0, 1000));
  ok('legacy "tick" mode reproduces the unbounded counter', sync === 1000, `got ${sync}`);
  ok('→ which would ask a stock client for a 2050ms tick period (0.49Hz)',
    periodFor(sync) === 2050);
  // With userscript 6d3 clamping to ±3, the client sits at the ceiling forever.
  const clamped = Math.max(-3, Math.min(3, sync));
  ok('→ clamped by userscript 6d3 to +3 = 56ms = 17.86Hz (the observed desync)',
    clamped === 3 && periodFor(clamped) === 56 && Math.abs(hzFor(clamped) - 17.857) < 0.01,
    `${periodFor(clamped)}ms / ${hzFor(clamped).toFixed(2)}Hz`);
  S.set('syncMode', 'zero', 'test');
}

console.log('\n── adaptive: nudge only, never negative ──');
{
  S.set('syncMode', 'adaptive', 'test');
  const depth = S.get('inputBufferDepth');
  ok('an on-target queue asks for no correction',
    srv.computeSyncValue(fakeSession(depth, 5)) === 0);
  ok('an empty queue asks for no correction (never negative — that would kill reconcile)',
    srv.computeSyncValue(fakeSession(0, 5)) === 0);
  ok('a surplus of 2 asks the client to ease off by 2',
    srv.computeSyncValue(fakeSession(depth + 2, 5)) === 2);
  ok('the correction is clamped to syncAdaptiveMax',
    srv.computeSyncValue(fakeSession(depth + 500, 5)) === S.get('syncAdaptiveMax'));
  ok('even the clamped maximum stays a nudge (≥17.8Hz), not a brake',
    hzFor(S.get('syncAdaptiveMax')) > 17.8);
  S.set('syncMode', 'zero', 'test');
}

console.log('\n── adaptive burst relief: a struggling client (weak CPU OR network jitter) gets a wider period ──');
{
  // Same signal already used for adaptive peer-broadcast smoothing (session._burstLevel) — see
  // syncAdaptiveBurst's description for the full weak-CPU mechanism this targets.
  const fakeBurstSession = (burstLevel) => ({ inputQueue: [], _legacySyncTick: 0, _burstLevel: burstLevel });
  S.set('syncMode', 'adaptive', 'test');
  S.set('syncAdaptiveBurst', true, 'test');

  ok('a perfectly steady client (burstLevel=1, the floor) asks for no correction',
    srv.computeSyncValue(fakeBurstSession(1)) === 0);
  ok('a client with no burstLevel recorded yet (undefined — brand new session) asks for no correction',
    srv.computeSyncValue(fakeBurstSession(undefined)) === 0);
  ok('a bursty client (burstLevel=3) asks for a correction of 2 (3-1)',
    srv.computeSyncValue(fakeBurstSession(3)) === 2, String(srv.computeSyncValue(fakeBurstSession(3))));
  ok('a severely bursty client is still clamped to syncAdaptiveMax',
    srv.computeSyncValue(fakeBurstSession(999)) === S.get('syncAdaptiveMax'));

  console.log('\n── the burst-driven and queue-driven contributions compose via max(), not by adding ──');
  const composed = (burstLevel, queueDepth) => srv.computeSyncValue(
    { inputQueue: new Array(queueDepth).fill({ clientTick: 0, frames: [] }), _legacySyncTick: 0, _burstLevel: burstLevel });
  const depth = S.get('inputBufferDepth');
  ok('queue surplus alone (burstLevel floor) still works exactly as before',
    composed(1, depth + 2) === 2);
  ok('burst alone (queue on-target) still works',
    composed(4, depth) === 3, String(composed(4, depth)));
  ok('whichever signal is WORSE wins, they do not stack additively',
    composed(4, depth + 2) === 3, String(composed(4, depth + 2)));

  console.log('\n── the on/off switch actually gates the burst contribution ──');
  S.set('syncAdaptiveBurst', false, 'test');
  ok('with syncAdaptiveBurst off, a bursty client gets NO correction from burstLevel alone',
    srv.computeSyncValue(fakeBurstSession(5)) === 0);
  S.set('syncAdaptiveBurst', true, 'test');

  console.log('\n── burst relief is inert outside adaptive mode, same as the queue-surplus path ──');
  S.set('syncMode', 'zero', 'test');
  ok('zero mode ignores burstLevel entirely, even a severe one',
    srv.computeSyncValue(fakeBurstSession(999)) === 0);
  S.set('syncMode', 'zero', 'test');
}

console.log('\n── never emit a negative sync (it disables reconciliation) ──');
{
  // Qak2r7y (:27372) returns -1 — skipping reconciliation entirely — when lagAccumulator < 0.
  for (const mode of ['zero', 'adaptive']) {
    S.set('syncMode', mode, 'test');
    let worst = 0;
    for (const d of [0, 1, 2, 5, 50, 200]) worst = Math.min(worst, srv.computeSyncValue(fakeSession(d, 0)));
    ok(`${mode} mode never returns a negative sync`, worst >= 0, `min ${worst}`);
  }
  S.set('syncMode', 'zero', 'test');
}

console.log('\n── the bootstrap packet carries it too ──');
{
  // A large sync in the bootstrap sets the client's tick period wrong from its first frame.
  const pkt = sb.buildStatePacket({ tick: 4321, playerId: 0 });
  ok('buildStatePacket defaults sync to 0, not the tick', pkt[0] === 0, `got ${pkt[0]}`);
  const explicit = sb.buildStatePacket({ tick: 4321, sync: 2, playerId: 0 });
  ok('an explicit sync is still honoured', explicit[0] === 2);
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
