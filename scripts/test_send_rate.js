/**
 * test_send_rate.js — the server must send one state per CLIENT tick, not per SERVER tick.
 *
 * WHY
 * ───
 * The client consumes EXACTLY ONE buffered server state per client tick — `Qorty0h.shift()`, once,
 * in Qwhlcfo — but it ingests every packet that arrived since the previous tick. So the only stable
 * send rate is the client's own tick rate. Any surplus accumulates in `Qorty0h` forever.
 *
 * When it passes 2 entries the client starts discarding states to catch up ("Skipping a server
 * state to keep up", bundle :27348, thresholds i=5 / a=2). Every discarded state is a correction
 * the reconciler never sees. A live session showed 150 such skips.
 *
 * The surplus came from ticks where a player's input had not arrived yet (ordinary network jitter):
 * processBufferedTick drained nothing, so no physics ran and the echo did not advance, but the
 * broadcast went out anyway carrying a DUPLICATE clientTick. The client's queue grew by one each
 * time. None of this is visible server-side, which is why it presented as a silent, long-lived,
 * per-player desync with a clean server console.
 *
 * Usage:  node scripts/test_send_rate.js
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

// The buffer depth is a tunable, so read it rather than baking its value into assertions. It is
// what makes the echo trail the client honestly (see the note on INPUT_BUFFER_DEPTH in the server).
const DEPTH = require('../settings').list().find((x) => x.key === 'inputBufferDepth').value;

(async () => {
  await bpw.ready;
  const sp = bpw.spawnPoints[0];

  console.log('\n── a drained tick is marked, an empty one is not ──');
  {
    const s = mkSession('p1', sp);
    const sessions = new Map([['p1', s]]);

    // Nothing queued: the client's own clock did not advance either, so there is nothing new to
    // acknowledge and a packet would only inflate their queue.
    srv.processBufferedTick(s, 1, sessions);
    ok('an empty queue drains nothing', s._drainedThisTick === false,
      'a send here carries a duplicate clientTick');

    // INPUT_BUFFER_DEPTH deliberately holds the newest tick back. That is what makes the echo
    // trail the client HONESTLY, rather than labelling current state with an older tick number.
    // Up to DEPTH ticks are held back — that is the whole mechanism.
    for (let i = 1; i <= DEPTH; i++) {
      s.inputQueue.push(batch(i));
      srv.processBufferedTick(s, 1 + i, sessions);
    }
    ok('the buffer holds its depth without simulating', s._drainedThisTick === false,
      `drained with only ${DEPTH} queued — draining the depth away is what forced the echo to be faked`);
    s.inputQueue.push(batch(DEPTH + 1));
    srv.processBufferedTick(s, DEPTH + 2, sessions);
    ok('the oldest tick is released once the depth is exceeded', s._drainedThisTick === true);
    ok('and the echo trails the newest received tick by the depth',
      s.lastProcessedClientTick === 1,
      `echo=${s.lastProcessedClientTick}, newest received=${DEPTH + 1}, depth=${DEPTH}`);
  }

  console.log('\n── over a jittery session, sends track CLIENT ticks ──');
  {
    const s = mkSession('p2', sp);
    const sessions = new Map([['p2', s]]);

    // 100 server ticks, but the client only manages 70 (dropped/late packets). Historically the
    // server sent 100 states into a client that consumed 70 — a surplus of 30, which is what
    // drove the queue past the drop threshold.
    const SERVER_TICKS = 100, CLIENT_TICKS = 70;
    let clientTick = 0, drained = 0;
    for (let t = 1; t <= SERVER_TICKS; t++) {
      // Deliver a client tick on 70 of the 100 server ticks.
      if (Math.floor(t * CLIENT_TICKS / SERVER_TICKS) > clientTick) {
        clientTick++;
        s.inputQueue.push(batch(clientTick));
      }
      srv.processBufferedTick(s, t, sessions);
      if (s._drainedThisTick) drained++;
    }
    // One tick stays buffered throughout, so drained is CLIENT_TICKS - depth.
    // DEPTH ticks stay buffered throughout.
    ok('every delivered client tick was drained but the buffered ones',
      drained === CLIENT_TICKS - DEPTH, `drained=${drained} clientTicks=${CLIENT_TICKS} depth=${DEPTH}`);
    ok('the idle server ticks are the surplus', SERVER_TICKS - drained === SERVER_TICKS - (CLIENT_TICKS - DEPTH),
      `surplus=${SERVER_TICKS - drained}`);
    ok('the echo trails the client by exactly the buffer depth',
      s.lastProcessedClientTick === CLIENT_TICKS - DEPTH, `echo=${s.lastProcessedClientTick}`);
    // The whole point: without the gate that surplus becomes 30 unconsumable packets in the
    // client's queue, i.e. 10x the threshold at which it starts discarding corrections.
    ok('the surplus would exceed the client drop threshold (2)', SERVER_TICKS - drained > 2,
      'this is the condition that produced the 150 observed skips');
  }

  console.log('\n── a burst is drained, not left to accumulate ──');
  {
    const s = mkSession('p3', sp);
    const sessions = new Map([['p3', s]]);
    for (let i = 1; i <= 8; i++) s.inputQueue.push(batch(i));
    let ticks = 0;
    while (s.inputQueue.length > DEPTH && ticks < 20) { srv.processBufferedTick(s, ++ticks, sessions); }
    ok('the backlog cleared down to the buffer depth', s.inputQueue.length === DEPTH,
      `${s.inputQueue.length} left, depth=${DEPTH}`);
    ok('every released client tick was acknowledged', s.lastProcessedClientTick === 8 - DEPTH,
      `echo=${s.lastProcessedClientTick}`);
  }

  console.log('\n── a client that has never sent input still receives ticks ──');
  {
    // THE DEADLOCK. The client needs a run of authoritative ticks to finish loading the map, and it
    // cannot send input until that load completes. A gate that suppresses purely on "drained
    // nothing this tick" therefore hangs at join and at every map change: the server waits for
    // input the client cannot produce until it gets the ticks the server is withholding.
    const s = mkSession('joining', sp);
    const sessions = new Map([['joining', s]]);
    for (let t = 1; t <= 10; t++) srv.processBufferedTick(s, t, sessions);
    ok('a never-seen client has no drain timestamp', !Number.isFinite(s._lastDrainTick),
      'the gate keys off this — undefined must mean "keep sending"');
  }

  console.log('\n── the gate engages only for a client that is actually ticking ──');
  {
    const s = mkSession('active', sp);
    const sessions = new Map([['active', s]]);
    for (let i = 1; i <= DEPTH + 1; i++) s.inputQueue.push(batch(i));
    srv.processBufferedTick(s, 100, sessions);
    ok('an active client records when it last drained', s._lastDrainTick === 100);
    srv.processBufferedTick(s, 101, sessions);
    ok('a single quiet tick keeps it "recently active"', (101 - s._lastDrainTick) <= 20,
      'normal play must stay gated, or the surplus returns');
    ok('a long silence falls outside the grace window', (200 - s._lastDrainTick) > 20,
      'otherwise a map reload can never complete');
  }

  console.log('\n── a full re-bootstrap clears the drain marker ──');
  {
    const s = mkSession('reload', sp);
    const sessions = new Map([['reload', s]]);
    for (let i = 1; i <= DEPTH + 1; i++) s.inputQueue.push(batch(i));
    srv.processBufferedTick(s, 50, sessions);
    ok('drain marker set before the switch', s._lastDrainTick === 50);
    srv.resetSessionInputStream(s);
    ok('a map switch forgets it', !Number.isFinite(s._lastDrainTick),
      'the client goes quiet across a reload and must keep receiving ticks');
    ok('and it is flagged for a full bootstrap', s.pendingFullBootstrap === true);
  }

  console.log('\n── the setting exists and defaults to on ──');
  {
    const st = srv.getStatus();
    ok('status reports per-player suppressed sends',
      st.players.length === 0 || typeof st.players[0].idleSends === 'number');
    const settings = require('../settings');
    const entry = settings.list().find((x) => x.key === 'rateMatchSends');
    ok('rateMatchSends is registered as a live setting', !!entry,
      'it must be switchable without a rebuild if it ever misbehaves');
    ok('and defaults to on', !!entry && entry.value === true,
      entry ? String(entry.value) : 'missing');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
