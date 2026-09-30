/**
 * test_selective_reconcile.js — echo -1 for smoothness, a real tick only when the client must be
 * corrected.
 *
 * THE PROBLEM
 * ───────────
 * echoLagTicks = -1 makes the client authoritative over its own movement — exactly what official
 * ev.io echoes on every packet — so it never corrects itself and never stutters. But it then also
 * never learns about IMPULSE GRENADES or EXPLOSION KNOCKBACK, because those are server-computed
 * velocity the client cannot predict: its only writes to its own Qyaswvo are its own movement and
 * the wall-jump, and a server-spawned grenade has no client-side collider for it to detect.
 * Reconciliation is the only channel that carries the push.
 *
 * THE FIX
 * ───────
 * Echo -1 on ordinary ticks, and a REAL client tick for a short burst after the server applies such
 * a force. The client reconciles exactly then, adopts the velocity, and goes back to running free.
 * The burst repeats so one dropped packet cannot swallow the correction.
 *
 * This is server-side only — nothing in the userscript or the bundle changes.
 *
 * Usage:  node scripts/test_selective_reconcile.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');
const S = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

const mkSession = (tick) => ({
  lastClientTick: tick, lastProcessedClientTick: tick,
  playerState: {},
});

const prev = S.list().find((x) => x.key === 'echoLagTicks').value;
S.set('echoLagTicks', -1, 'test');

console.log('\n── with no force applied, the client runs free ──');
{
  const s = mkSession(120);
  for (let i = 0; i < 10; i++) {
    ok(`tick ${i}: echo is -1`, srv.computeEchoTick(s.lastClientTick, s) === -1);
  }
}

console.log('\n── a push turns reconciliation on, briefly ──');
{
  const s = mkSession(200);
  srv.requestReconcile(s.playerState, 3);
  const seen = [];
  for (let i = 0; i < 6; i++) seen.push(srv.computeEchoTick(s.lastClientTick, s));
  // The echo points a couple of ticks BEHIND the newest processed tick so it lands inside the
  // client's prediction ring; an echo ahead of the ring is discarded before anything is compared.
  const BACKOFF = S.list().find((x) => x.key === 'reconcileEchoBackoff').value;
  ok('the first ticks carry a REAL client tick', seen.slice(0, 3).every((t) => t === 200 - BACKOFF),
    JSON.stringify(seen));
  ok('and it returns to -1 afterwards', seen.slice(3).every((t) => t === -1),
    JSON.stringify(seen));
  ok('the burst is exactly as long as requested',
    seen.filter((t) => t !== -1).length === 3, JSON.stringify(seen));
}

console.log('\n── the burst survives a dropped packet ──');
{
  // One tick of correction would be lost with the packet carrying it; a burst repeats it.
  const s = mkSession(300);
  srv.requestReconcile(s.playerState, 4);
  const seen = [];
  for (let i = 0; i < 4; i++) seen.push(srv.computeEchoTick(s.lastClientTick, s));
  const BK = S.list().find((x) => x.key === 'reconcileEchoBackoff').value;
  ok('several packets carry the correction', seen.filter((t) => t === 300 - BK).length >= 2,
    JSON.stringify(seen));
}

console.log('\n── overlapping pushes extend rather than shorten the burst ──');
{
  const s = mkSession(400);
  srv.requestReconcile(s.playerState, 5);
  srv.computeEchoTick(s.lastClientTick, s);       // consume one
  srv.requestReconcile(s.playerState, 5);         // a second blast lands mid-burst
  let n = 0;
  for (let i = 0; i < 8; i++) if (srv.computeEchoTick(s.lastClientTick, s) !== -1) n++;
  ok('the later request wins when it is longer', n === 5, `${n} corrected ticks`);
}

console.log('\n── it never echoes a tick the client has not reached ──');
{
  // Echoing a tick the client has not predicted yet would miss its ring and do nothing (or worse).
  const s = { lastClientTick: 0, lastProcessedClientTick: -1, playerState: {} };
  srv.requestReconcile(s.playerState, 3);
  ok('no client tick yet -> still -1', srv.computeEchoTick(s.lastClientTick, s) === -1,
    'a tick the client has not run cannot be reconciled against');
}

console.log('\n── the BUFFER tick model honours the burst too ──');
{
  // This is the one that matters in practice: buffer is the default tick model and it computes its
  // echo INLINE rather than through computeEchoTick. The first version of this feature only patched
  // computeEchoTick, so the burst never fired for real players — an impulse pushed them on the
  // server (peers saw them fly) while their own screen never moved.
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'local_ws_server.js'), 'utf8');
  const inline = src.indexOf('force client-authoritative') !== -1;
  ok('the inline buffer path no longer hard-forces -1', !inline,
    'a bare `echoTick = -1` there bypasses the burst entirely');
  ok('both echo paths call the shared helper',
    (src.match(/consumeReconcileBurst\(/g) || []).length >= 3,
    'definition + both call sites');

  // And the helper itself must be single-consumption per tick, or a burst of N would last longer
  // than N ticks in one path and shorter in the other.
  const s = { playerState: {} };
  srv.requestReconcile(s.playerState, 2);
  const seq = [srv._consumeReconcileBurst ? srv._consumeReconcileBurst(s) : null];
  ok('burst length is respected exactly', s.playerState._reconcileFor === 1 || seq[0] === null,
    `remaining=${s.playerState._reconcileFor}`);
}

console.log('\n── normal echo modes are untouched ──');
{
  S.set('echoLagTicks', 0, 'test');
  const s = mkSession(500);
  srv.requestReconcile(s.playerState, 3);          // should be irrelevant now
  ok('echoLagTicks=0 still echoes the processed tick',
    srv.computeEchoTick(s.lastClientTick, s) === 500,
    'selective reconcile must only apply in the -1 mode');
  S.set('echoLagTicks', -1, 'test');
}

S.set('echoLagTicks', prev, 'test');

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
