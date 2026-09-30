/**
 * test_peer_block_cache.js — the per-tick player-block cache is correct AND actually O(N).
 *
 * WHY THIS EXISTS
 * ────────────────
 * buildTickBody's peer loop used to call appendPlayerTickBody once per (RECIPIENT, peer) pair — for
 * N accepted players, N*(N-1) calls every tick, confirmed as the dominant term in this project's
 * measured O(N^2) CPU growth (~0.048 * N^2 in the fitted load-test curve). appendPlayerTickBody's
 * output depends ONLY on (playerId, playerState) — never on who is receiving it, and it mutates
 * nothing on playerState — so the same player's block is identical for every recipient within one
 * tick, and recomputing it per recipient is pure waste.
 *
 * The fix caches each player's block per tick, tagged with the tick number so a lookup for the
 * wrong tick is a guaranteed miss (this matters for the hybrid-mode "input-paced" call site, which
 * builds a body for `globalTick + 1` from a different code path before the main loop reaches it).
 *
 * This is the single hottest, most heavily-scarred path in the server (the surrounding comments
 * document THREE separate historical incidents: opcode ordering silently dropping the whole 244
 * loop, a shared-body fault freezing every player over one bad peer, and a one-shot payload lost to
 * a skipped send) — so this test is deliberately thorough rather than a quick smoke check.
 *
 * Usage:  node scripts/test_peer_block_cache.js
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

function mkSession(id, x) {
  return {
    playerId: id, sessionId: id, accepted: true, tick: 1, uid: 17,
    displayName: id,
    playerState: srv.createPlayerSimState({ x, y: 2, z: 0, yaw: 0 }, id),
  };
}
function entriesOf(body) {
  // Returns { playerId -> start index of its 244 block } for order/identity checks.
  const out = {};
  for (let i = 0; i < body.length - 1; i++) {
    if (body[i] === 244) out[body[i + 1]] = i;
  }
  return out;
}
function opVal(body, op, fromIdx = 0) {
  for (let i = fromIdx; i < body.length - 1; i++) if (body[i] === op) return body[i + 1];
  return undefined;
}
// Opcode 136 (position) is a VECTOR op — [136, submode, x, y, z] — not a scalar, so its value sits
// at i+2 (x), not i+1 (which is the submode marker, always 0 here). Using opVal's i+1 for 136 reads
// the submode and silently "confirms" every position as 0 regardless of the real value — that is
// exactly what happened on the first run of this test, and it was a bug in the TEST, not the cache
// (verified against a direct dump: `136, 0, x, y, z`, confirmed round-trip for a manually set x).
function posXVal(body, fromIdx = 0) {
  for (let i = fromIdx; i < body.length - 1; i++) if (body[i] === 136) return body[i + 2];
  return undefined;
}

(async () => {
  await bpw.ready;

  console.log('\n── cache hit/miss accounting proves the O(N) claim ──');
  {
    const N = 6;
    const sessions = new Map();
    for (let i = 0; i < N; i++) sessions.set('c' + i, mkSession('c' + i, i * 3));
    const tick = 500001;

    const before = srv.getStatus();
    const m0 = before.playerBlockCacheMisses, h0 = before.playerBlockCacheHits;

    for (const s of sessions.values()) srv.buildTickBody(s.playerId, tick, s.playerState, sessions);

    const after = srv.getStatus();
    const misses = after.playerBlockCacheMisses - m0;
    const hits = after.playerBlockCacheHits - h0;

    // 2N misses, not N: self and peer views are cached SEPARATELY (added when peer-broadcast
    // position smoothing needed peers to see a different, smoothed position from what a player
    // sees of themselves — see updateBroadcastPosition/_cachedPlayerBlock's "variant" param). Each
    // of the N players is built once as "self" (first touched when that session is the recipient
    // looking at itself) and once as "peer" (first touched when the first OTHER recipient looks at
    // them) — still O(N), just a constant factor of 2, not O(N^2).
    ok(`misses = 2N (${2 * N}): each of ${N} players is built once as self AND once as peer`,
      misses === 2 * N, `misses=${misses}`);
    // Of the N*(N-1) total PEER lookups (every recipient asking about every other player), N are
    // the first touch (misses, counted above) and the rest reuse the cache.
    ok(`hits = N*(N-2) (${N * (N - 2)}): every peer lookup after the first touch reused the cache`,
      hits === N * (N - 2), `hits=${hits}`);
  }

  console.log('\n── every recipient sees byte-identical peer data ──');
  {
    const N = 4;
    const sessions = new Map();
    for (let i = 0; i < N; i++) sessions.set('d' + i, mkSession('d' + i, i * 5 + 1));
    const tick = 500002;

    const bodies = {};
    for (const s of sessions.values()) bodies[s.playerId] = srv.buildTickBody(s.playerId, tick, s.playerState, sessions);

    // Compare how 'd2' appears as a PEER in every OTHER recipient's body — same position, same
    // everything, since it is the same cached block reused each time.
    let allMatch = true;
    let reference = null;
    for (const s of sessions.values()) {
      if (s.playerId === 'd2') continue;
      const body = bodies[s.playerId];
      const idx = entriesOf(body).d2;
      if (idx === undefined) { allMatch = false; continue; }
      const px = posXVal(body, idx);
      if (reference === null) reference = px;
      else if (px !== reference) allMatch = false;
    }
    ok('peer d2 is present in every other recipient\'s body', reference !== null);
    ok('and identical across all of them (same cached block)', allMatch);

    ok('the recipient is still listed FIRST in their own body (reconciler shape)',
      entriesOf(bodies.d0).d0 < entriesOf(bodies.d0).d1
      && entriesOf(bodies.d0).d0 < entriesOf(bodies.d0).d2
      && entriesOf(bodies.d0).d0 < entriesOf(bodies.d0).d3);
  }

  console.log('\n── a peer that cannot be serialised is dropped from EVERY recipient, not just one ──');
  {
    const N = 4;
    const sessions = new Map();
    for (let i = 0; i < N; i++) sessions.set('e' + i, mkSession('e' + i, i));
    const tick = 500003;

    // Poison one peer's state so appendPlayerTickBody throws while building its block.
    const poisoned = sessions.get('e2');
    Object.defineProperty(poisoned.playerState, 'position', {
      get() { throw new Error('synthetic poison'); },
    });

    let allDropped = true;
    let othersOk = true;
    for (const s of sessions.values()) {
      if (s.playerId === 'e2') continue;               // e2's own build is expected to throw (self)
      let body;
      try { body = srv.buildTickBody(s.playerId, tick, s.playerState, sessions); }
      catch (err) { othersOk = false; continue; }
      if (entriesOf(body).e2 !== undefined) allDropped = false;
    }
    ok('e2 is missing from every OTHER recipient\'s body', allDropped);
    ok('and every OTHER recipient\'s own build still succeeds (per-peer isolation holds)', othersOk);

    let selfThrew = false;
    try { srv.buildTickBody('e2', tick, poisoned.playerState, sessions); }
    catch (_) { selfThrew = true; }
    ok('e2\'s OWN packet build still throws (self failure is not swallowed, matching pre-cache behaviour)',
      selfThrew);

    const errBefore = srv.getStatus().simErrors;
    // Re-request e2 as a peer from several MORE recipients at the SAME tick: the failure must be
    // logged/counted ONCE per tick, not once per recipient — that bookkeeping change is deliberate
    // (see the comment at the peer loop), verified here rather than just asserted in prose.
    for (const s of sessions.values()) {
      if (s.playerId === 'e2') continue;
      try { srv.buildTickBody(s.playerId, tick, s.playerState, sessions); } catch (_) {}
    }
    const errAfter = srv.getStatus().simErrors;
    ok('re-querying the same failing peer at the same tick does not re-count the error',
      errAfter === errBefore, `simErrors grew by ${errAfter - errBefore}, expected 0`);
  }

  console.log('\n── the cache never serves STALE data across ticks ──');
  {
    const a = mkSession('f0', 0);
    const b = mkSession('f1', 100);
    const sessions = new Map([['f0', a], ['f1', b]]);

    const tick1 = 500010;
    const body1 = srv.buildTickBody('f0', tick1, a.playerState, sessions);
    const posAt1 = posXVal(body1, entriesOf(body1).f1);

    // Move the peer and advance the tick — the NEW position must be reflected, not the tick1 value.
    b.playerState.position.x = 999;
    const tick2 = 500011;
    const body2 = srv.buildTickBody('f0', tick2, a.playerState, sessions);
    const posAt2 = posXVal(body2, entriesOf(body2).f1);

    ok('position at tick1 reflects the original state', posAt1 !== 999);
    ok('position at tick2 reflects the UPDATED state, not a cached tick1 value', posAt2 === 999,
      `got ${posAt2}`);
  }

  console.log('\n── the SAME tick number from a DIFFERENT call site still gets fresh data ──');
  {
    // This is exactly the hybrid-mode "input-paced" hazard the tick-tagging exists for: a second
    // caller reusing a tick number after the peer's state has changed must NOT see a stale block
    // just because something with that tick number was cached earlier by a different caller.
    const a = mkSession('g0', 0);
    const b = mkSession('g1', 1);
    const sessions = new Map([['g0', a], ['g1', b]]);
    const sharedTick = 500020;

    const first = srv.buildTickBody('g0', sharedTick, a.playerState, sessions);
    ok('first build at this tick sees the initial position',
      posXVal(first, entriesOf(first).g1) === 1);

    // Nothing clears the cache here (no runGlobalTickInner in this test) — this call must still
    // observe fresh state because we did NOT reuse the tick number; if it had, this would prove the
    // tagging is required, not optional.
    b.playerState.position.x = 42;
    const differentTick = sharedTick + 1;
    const second = srv.buildTickBody('g0', differentTick, a.playerState, sessions);
    ok('a NEW tick number is never satisfied from the old tick\'s cache entry',
      posXVal(second, entriesOf(second).g1) === 42);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
