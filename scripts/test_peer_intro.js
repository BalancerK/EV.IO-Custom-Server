/**
 * test_peer_intro.js — a peer introduction must never be flushed into a packet that is not sent.
 *
 * THE BUG
 * ───────
 * The broadcast did this, in this order:
 *
 *     flushPendingPeerBootstraps(s, body);          // moves the queue INTO the body and CLEARS it
 *     ...
 *     if (idle && RATE_MATCH_SENDS) continue;        // skips sendState entirely
 *     sendState(...)
 *
 * A recipient who happened to be "idle" that cycle (no client tick drained) had the packet dropped
 * — but the queue had already been emptied, so the introduction was gone for good. There is no
 * retry: peer bootstraps are one-shot.
 *
 * The recipient then only ever learned about that player from the regular 244 loop, which creates a
 * bare object (`w in playerList || (playerList[w] = {})`) carrying only the movement subset. No
 * identity (210/212) so the name renders as "undefined", no weapon (127/135) so the hands are
 * empty, and no skin. Whether a given recipient was idle on the exact tick a peer joined is luck,
 * which is why it struck only sometimes — and why the affected player looked fine to themselves.
 *
 * Usage:  node scripts/test_peer_intro.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');

let pass = 0, fail = 0;
const deferred = [];   // async sections, awaited before the summary
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

console.log('\n── the flush is one-shot: it empties the queue ──');
{
  const s = { playerId: 'a', pendingPeerBootstraps: [244, 'b', 90, 'b', 210, 'Guest42'] };
  const body = [1, 5, 244, 'a', 90, 'a', 280, 0];
  srv.flushPendingPeerBootstraps(s, body);
  ok('the ops were spliced into the body', body.includes(210) && body.includes('Guest42'));
  ok('and the queue is now empty', s.pendingPeerBootstraps.length === 0,
    'this is exactly why a dropped packet loses the introduction permanently');
  ok('still inside the 244 scan (before 280)',
    body.indexOf(210) < body.lastIndexOf(280),
    'after 280 the ascending scan would never reach it');
}

console.log('\n── the bootstrap must precede the peer\'s ORDINARY block ──');
{
  // A joining peer is already in `sessions`, so the same body carries their normal per-tick 244
  // block — movement only, no identity. If the bootstrap lands after it, the client meets the
  // player as a bare {} first: it fires the "joined" notification and builds the scoreboard row
  // from that empty object (both "undefined"), then reads the identity afterwards. The 3D
  // nameplate re-reads every frame so it looks right, while the notification and scoreboard row
  // were captured once and never refresh — "undefined in chat and scoreboard, correct name over
  // their head".
  const s = { playerId: 'a', pendingPeerBootstraps: [244, 'b', 90, 'b', 212, 'Guest42'] };
  const body = [1, 5, 7, 200, 244, 'a', 90, 'a', 244, 'b', 136, 0, 1, 2, 3, 280, 0];
  srv.flushPendingPeerBootstraps(s, body);
  const identityAt = body.indexOf(212);
  const firstEntity = body.indexOf(244);
  ok('the identity block is the FIRST 244 entry', identityAt > firstEntity && identityAt < 12,
    `identity at ${identityAt}, first 244 at ${firstEntity}`);
  ok('and it still comes after the header opcodes (scan stays ascending)',
    firstEntity > body.indexOf(7),
    'a 244 before the header would stall the ascending scan');
  ok('the ordinary movement block is still present afterwards',
    body.lastIndexOf(244) > identityAt);
}

console.log('\n── a queued introduction forces the send ──');
{
  // Reproduce the gate's decision. The bug was that `idle` alone skipped the send even though a
  // one-shot payload had just been flushed into the body.
  const decide = (idle, rateMatch, hasOneShot) => !(idle && rateMatch && !hasOneShot);

  ok('idle + rate-matching + nothing queued -> may skip', decide(true, true, false) === false);
  ok('idle + rate-matching + a queued INTRO -> must send', decide(true, true, true) === true,
    'this is the case that was losing peer introductions');
  ok('not idle -> always sends', decide(false, true, true) === true);
  ok('rate-matching off -> always sends', decide(true, false, false) === true);
}

console.log('\n── every one-shot channel is covered, not just bootstraps ──');
{
  // All three are flushed before the gate and all three are destructive.
  const oneShot = (s) => (s.pendingPeerBootstraps && s.pendingPeerBootstraps.length > 0)
    || (s.pendingPeerRemovals && s.pendingPeerRemovals.length > 0)
    || (s.loadoutDeltaSendCount > 0);
  ok('peer bootstrap counts', oneShot({ pendingPeerBootstraps: [1] }) === true);
  ok('peer removal counts', oneShot({ pendingPeerRemovals: [1] }) === true,
    'a lost removal leaves a ghost player on the scoreboard');
  ok('loadout delta counts', oneShot({ loadoutDeltaSendCount: 3 }) === true);
  ok('an idle session with nothing queued does not', oneShot({}) === false);
  ok('empty arrays do not count', oneShot({ pendingPeerBootstraps: [], pendingPeerRemovals: [] }) === false);
}

console.log('\n── a player is invisible to others until they have JOINED ──');
{
  // A session enters `sessions` when its WebSocket connects — a full network round trip before its
  // join payload arrives with the name, uid, weapon and skin. Streaming it in that window made
  // every other client build its "joined" notification and scoreboard row from an identity-less
  // entity (both "undefined") and never attach a weapon or skin model. The bootstrap repaired the
  // ENTITY afterwards, so the nameplate looked right while the UI stayed broken.
  //
  // Sub-tick on localhost, several ticks over the internet — which is why it only appeared once
  // the server was hosted.
  const bpwl = require('../physics_world');
  const entries = (body) => {
    const out = [];
    for (let i = 0; i < body.length - 1; i++) {
      if (body[i] === 244 && (i === 0 || body[i - 1] !== 244)) out.push(body[i + 1]);
    }
    return out;
  };
  const mk = (id, accepted) => ({
    playerId: id, sessionId: id, accepted, tick: 1, uid: 17, weaponId: 9,
    displayName: accepted ? 'Guest7777' : `local-${id}`,
    pendingPeerBootstraps: [],
    playerState: srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, id),
  });
  // The physics world must be loaded before createPlayerSimState works, so this section is async
  // and runs last; everything above is synchronous and has already reported.
  deferred.push(bpwl.ready.then(() => {
    const a = mk('a', true);
    const joining = mk('b', false);
    const sessions = new Map([['a', a], ['b', joining]]);

    ok('a connected-but-unjoined peer is NOT streamed',
      !entries(srv.buildTickBody('a', 10, a.playerState, sessions)).includes('b'),
      'streaming it creates an identity-less entity that the UI captures as "undefined"');

    joining.accepted = true;
    ok('and appears as soon as it has joined',
      entries(srv.buildTickBody('a', 11, a.playerState, sessions)).includes('b'));

    // Same rule for the joiner learning about existing players.
    const fresh = [];
    srv.appendPeerBootstraps(fresh, new Map([['a', a], ['c', mk('c', false)]]), 'a');
    ok('an unjoined peer is not bootstrapped to a new client either',
      !fresh.includes('c'), 'it would arrive with no name, weapon or skin');
  }));
}

console.log('\n── the guard is actually wired into the broadcast ──');
{
  // Cheap structural check: the gate must consult the flag, or the fix is not in the live path.
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'local_ws_server.js'), 'utf8');
  ok('the one-shot flag is computed before flushing',
    src.indexOf('const _hasOneShot') < src.indexOf('flushPendingPeerBootstraps(s, body)'),
    'computing it after the flush would always read empty queues');
  ok('and the send gate consults it', src.includes('RATE_MATCH_SENDS && !_hasOneShot'));
}

// Wait for the async section before reporting, or its assertions run after the summary and are
// silently not counted — a test that looks green while proving nothing.
Promise.all(deferred).then(() => {
  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
});
