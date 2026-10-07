/**
 * test_peer_smoothing.js — peer-broadcast position smoothing is isolated from the source player's
 * own connection quality.
 *
 * REPORTED SYMPTOM
 * ─────────────────
 * A player with a high/unstable connection (200-400ms, packet loss) appeared to OTHER players as
 * constantly teleporting instead of moving smoothly. Root cause: a stalled connection delivers input
 * in BURSTS (TCP head-of-line blocking), and when a burst is drained, processBufferedTick correctly
 * advances the player's TRUE position through every buffered tick — but the broadcast only samples
 * the FINAL result once. Up to inputBufferMaxCatchup ticks of real movement (seconds, at a high
 * setting) could land in a single visible update, which every observer's peer-interpolation renders
 * as an instant jump because it has no way to know how much wall-clock time that jump represents.
 *
 * THE FIX
 * ────────
 * Peers are shown a SEPARATE, speed-capped broadcast position (updateBroadcastPosition) that eases
 * toward the true position — decoupled from however bursty the source connection is. The player's
 * OWN view of themselves, and lag-compensated hit registration, are untouched: both still read the
 * true position every tick. Genuine instant repositioning (teleporter, respawn, admin teleport)
 * snaps instead of easing.
 *
 * Usage:  node scripts/test_peer_smoothing.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = process.env.EVIO_LOCAL_PORT || '18530';
process.env.EVIO_JOIN_DEADLINE = '0';
// A held player ("Hold new players until they click to play", now the default) streams as a
// spectator at a zeroed/held position, not their real one — this file's own peer-position-
// smoothing assertions need the mover and watcher actually playing to mean anything.
process.env.EVIO_CLICK_TO_PLAY = process.env.EVIO_CLICK_TO_PLAY || '0';

const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const S = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const dist3 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

(async () => {
  await bpw.ready;

  console.log('\n── updateBroadcastPosition: pure function behaviour ──');
  {
    const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'p1');
    ok('a brand new player has no broadcast position yet', !ps._broadcastPos);
    srv.updateBroadcastPosition(ps, 0.05);
    ok('the FIRST call snaps straight to the true position (nothing to ease from)',
      ps._broadcastPos.x === 0 && ps._broadcastPos.z === 0);

    // A huge, instantaneous jump in the TRUE position — exactly what a multi-second catch-up burst
    // produces (INPUT_BUFFER_MAX_CATCHUP ticks' worth of real movement resolved in one server tick).
    ps.position.x = 100;
    const maxSpeed = S.get('peerSmoothMaxSpeed');
    srv.updateBroadcastPosition(ps, 0.05);
    const afterOneTick = dist3(ps._broadcastPos, { x: 0, y: 2, z: 0 });
    ok('one tick of easing moves at most maxSpeed*dt toward the true position, not straight to it',
      afterOneTick <= maxSpeed * 0.05 + 1e-6 && afterOneTick > 0,
      `moved ${afterOneTick.toFixed(3)}, cap was ${(maxSpeed * 0.05).toFixed(3)}`);
    ok('the broadcast position has NOT reached the true position after one tick',
      ps._broadcastPos.x < 100, String(ps._broadcastPos.x));

    // Keep calling it every tick, like the real tick loop does, and confirm it eventually arrives.
    let ticks = 0;
    while (ps._broadcastPos.x < 99.999 && ticks < 1000) { srv.updateBroadcastPosition(ps, 0.05); ticks++; }
    ok('repeated ticks eventually converge on the true position', ps._broadcastPos.x >= 99.999,
      `stuck at ${ps._broadcastPos.x} after ${ticks} ticks`);
    ok('convergence took MORE than one tick (i.e. it was actually smoothed, not instant)', ticks > 1);
  }

  console.log('\n── a transient NaN/Infinity true position does not poison the broadcast position ──');
  {
    // Same bug class this project has fought before (see the emit-boundary fin() guards): NaN
    // propagates through every arithmetic op in updateBroadcastPosition and is STICKY once it
    // reaches _broadcastPos (dx = p.x - b.x is NaN forever after), so a single bad tick would
    // otherwise permanently freeze this player as NaN for every peer.
    const ps = srv.createPlayerSimState({ x: 10, y: 2, z: 0, yaw: 0 }, 'p4');
    srv.updateBroadcastPosition(ps, 0.05);
    const goodBefore = { ...ps._broadcastPos };
    ok('a healthy broadcast position was established first', Number.isFinite(goodBefore.x));

    for (const bad of [NaN, Infinity, -Infinity]) {
      ps.position.x = bad;
      srv.updateBroadcastPosition(ps, 0.05);
      ok(`position.x = ${bad}: the update is skipped, not applied`,
        ps._broadcastPos.x === goodBefore.x, String(ps._broadcastPos.x));
      ok(`position.x = ${bad}: _broadcastPos stays fully finite (not poisoned)`,
        Number.isFinite(ps._broadcastPos.x) && Number.isFinite(ps._broadcastPos.y) && Number.isFinite(ps._broadcastPos.z));
    }

    // And once the true position recovers, smoothing must resume normally — not stay stuck because
    // some earlier bad tick left internal state corrupted.
    ps.position.x = 10.5;
    srv.updateBroadcastPosition(ps, 0.05);
    ok('smoothing resumes normally once the true position is valid again',
      ps._broadcastPos.x > goodBefore.x && Number.isFinite(ps._broadcastPos.x),
      String(ps._broadcastPos.x));
  }

  console.log('\n── a teleport/respawn SNAPS instead of easing ──');
  {
    const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'p2');
    srv.updateBroadcastPosition(ps, 0.05);
    ps.position.x = 500;   // a portal or respawn moved them instantly
    ps.justTeleported = true;
    srv.updateBroadcastPosition(ps, 0.05);
    ok('justTeleported makes the broadcast position snap immediately, not ease', ps._broadcastPos.x === 500);
  }

  console.log('\n── close enough to arrive exactly, not overshoot-and-oscillate ──');
  {
    const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'p3');
    srv.updateBroadcastPosition(ps, 0.05);
    const maxSpeed = S.get('peerSmoothMaxSpeed');
    ps.position.x = (maxSpeed * 0.05) * 0.5;   // well within one tick's max step
    srv.updateBroadcastPosition(ps, 0.05);
    ok('a small move within the cap arrives in exactly one tick', ps._broadcastPos.x === ps.position.x,
      `${ps._broadcastPos.x} vs ${ps.position.x}`);
  }

  console.log('\n── integration: peers see the smoothed position, self sees the true one, same tick ──');
  {
    function mkSession(id, x) {
      return {
        playerId: id, sessionId: id, accepted: true, tick: 1, uid: 17, displayName: id,
        playerState: srv.createPlayerSimState({ x, y: 2, z: 0, yaw: 0 }, id),
      };
    }
    function posXVal(body, fromIdx = 0) {
      for (let i = fromIdx; i < body.length - 1; i++) if (body[i] === 136) return body[i + 2];
      return undefined;
    }
    function entryIdx(body, id) {
      for (let i = 0; i < body.length - 1; i++) if (body[i] === 244 && body[i + 1] === id) return i;
      return -1;
    }

    const mover = mkSession('mover', 0);
    const watcher = mkSession('watcher', 5);
    const sessions = new Map([['mover', mover], ['watcher', watcher]]);
    const tick = 700001;

    // Establish a broadcast position, then simulate a catch-up burst: the TRUE position jumps far
    // in one tick (exactly what draining a large backlog in one server tick produces).
    srv.updateBroadcastPosition(mover.playerState, 0.05);
    mover.playerState.position.x = 200;
    srv.updateBroadcastPosition(mover.playerState, 0.05);   // this tick's smoothing pass

    // Self view: mover looking at themselves. Must be the TRUE (jumped) position — their own
    // reconciliation needs the truth, not a smoothed approximation.
    const selfBody = srv.buildTickBody('mover', tick, mover.playerState, sessions);
    ok('the mover\'s OWN view of themselves is the true (jumped) position, unsmoothed',
      posXVal(selfBody) === 200, String(posXVal(selfBody)));

    // Peer view: watcher looking at mover. Must be the SMOOTHED (bounded-step) position.
    const watcherBody = srv.buildTickBody('watcher', tick, watcher.playerState, sessions);
    const moverAsPeerIdx = entryIdx(watcherBody, 'mover');
    ok('mover appears as a peer in the watcher\'s body', moverAsPeerIdx >= 0);
    const peerX = posXVal(watcherBody, moverAsPeerIdx);
    ok('the peer-visible position is NOT the raw jumped value (it was capped)', peerX < 200,
      String(peerX));
    ok('the peer-visible position matches the smoothed value computed above', peerX === mover.playerState._broadcastPos.x,
      `${peerX} vs ${mover.playerState._broadcastPos.x}`);
  }

  console.log('\n── live end-to-end: the REAL tick loop calls this every tick, not just buildTickBody ──');
  {
    // Everything above calls updateBroadcastPosition and buildTickBody directly — it proves the
    // MECHANISM works, but not that runGlobalTickInner's own per-tick pass (_phase("peerSmoothing"))
    // is actually wired up. This drives the real server with a real bot as the "mover" and a real
    // WebSocket client as the observer, and decodes what actually arrives over the wire.
    const WebSocket = require('ws');
    const { decode } = require('@msgpack/msgpack');
    srv.startServer();
    await wait(200);

    // This scenario writes the true position directly (a raw jump, not a burst drained through
    // processBufferedTick), so the adaptive cap would never see any burstLevel and would use the
    // loose STABLE speed instead of the fixed cap this test is actually exercising. Pin adaptive off
    // so this stays a clean test of the underlying smoothing mechanism at a known cap.
    S.set('peerSmoothAdaptive', false, 'test');
    const mover = srv.spawnBot({ name: 'JumpTest', level: 1 });
    const spawn = bpw.spawnPoints[0];
    mover.playerState._ps.Qdsukt4.x = spawn.x; mover.playerState._ps.Qdsukt4.y = spawn.y; mover.playerState._ps.Qdsukt4.z = spawn.z;
    mover.playerState.position.x = spawn.x; mover.playerState.position.y = spawn.y; mover.playerState.position.z = spawn.z;
    await wait(200);   // let a few ticks settle _broadcastPos at the spawn position

    const ws = new WebSocket(`ws://127.0.0.1:${process.env.EVIO_LOCAL_PORT}`);
    await new Promise((r) => ws.on('open', r));
    const seenX = [];
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      try {
        const msg = decode(new Uint8Array(data));
        const body = msg[2];
        if (!Array.isArray(body)) return;
        for (let i = 0; i < body.length - 1; i++) {
          if (body[i] === 244 && body[i + 1] === mover.playerId) {
            for (let j = i; j < body.length - 2; j++) if (body[j] === 136) { seenX.push(body[j + 2]); break; }
            break;
          }
        }
      } catch (_) {}
    });
    ws.send(';' + JSON.stringify({ uid: 17, name: 'RealWatcher' }));
    await wait(300);

    // Simulate a multi-second catch-up burst: the TRUE position jumps 60 units in one instant,
    // exactly like draining a large backlog does — WITHOUT setting justTeleported (a real catch-up
    // is not a teleport, it must be smoothed, not snapped).
    const before = seenX.length;
    mover.playerState._ps.Qdsukt4.x = spawn.x + 60;
    mover.playerState.position.x = spawn.x + 60;
    await wait(600);   // several real server ticks

    const after = seenX.slice(before);
    ok('the real watcher actually received updates after the jump', after.length > 1,
      `${after.length} updates`);
    let maxStep = 0;
    for (let i = 1; i < after.length; i++) maxStep = Math.max(maxStep, Math.abs(after[i] - after[i - 1]));
    const maxAllowedStep = S.get('peerSmoothMaxSpeed') * (S.get('tickMs') / 1000) + 0.05;
    ok('no single update moved the peer-visible x by more than the configured max step',
      maxStep <= maxAllowedStep, `maxStep=${maxStep.toFixed(2)}, allowed=${maxAllowedStep.toFixed(2)}`);
    ok('the position DID eventually move (this was not just frozen)', after[after.length - 1] > after[0] + 1,
      `${after[0]} -> ${after[after.length - 1]}`);
    ok('it has NOT reached the true 60-unit jump within this short window (proves it was smoothed, not instant)',
      after[after.length - 1] < spawn.x + 59, String(after[after.length - 1]));

    S.set('peerSmoothAdaptive', true, 'test');
    try { ws.close(); } catch (_) {}
    srv.removeBot(mover.playerId);
    await wait(200);
  }

  console.log('\n── the setting is real and live-adjustable ──');
  {
    const e = S.list().find((s) => s.key === 'peerSmoothMaxSpeed');
    ok('peerSmoothMaxSpeed is registered', !!e);
    ok('it is marked live (no restart needed)', e && e.live !== false);
    ok('it is not inert', e && !e.inert);
  }

  console.log('\n── adaptive per-player cap: stable connection gets no delay ──');
  {
    const session = { _burstLevel: 1 };
    const cap = srv.peerSmoothCapFor(session);
    ok('a session that has never bursted (burstLevel=1) gets the STABLE cap',
      cap === S.get('peerSmoothStableSpeed'), `cap=${cap}`);
  }

  console.log('\n── adaptive per-player cap: saturated bursty connection gets the tight cap ──');
  {
    const session = { _burstLevel: S.get('peerSmoothBurstSaturation') + 5 };
    const cap = srv.peerSmoothCapFor(session);
    ok('a session bursting at/above saturation gets the BURSTY cap, not looser',
      cap === S.get('peerSmoothBurstySpeed'), `cap=${cap}`);
  }

  console.log('\n── adaptive per-player cap: interpolates in between, monotonically ──');
  {
    const sat = S.get('peerSmoothBurstSaturation');
    const caps = [1, 2, 3, sat / 2, sat].map((level) => srv.peerSmoothCapFor({ _burstLevel: level }));
    let monotonic = true;
    for (let i = 1; i < caps.length; i++) if (caps[i] > caps[i - 1]) monotonic = false;
    ok('cap only ever tightens (or stays flat) as burstLevel rises, never loosens',
      monotonic, JSON.stringify(caps));
  }

  console.log('\n── adaptive per-player cap: two DIFFERENT connections get two DIFFERENT caps, same tick ──');
  {
    // The whole point: a stable player and a bursty player connected at once must not share one
    // global number — each gets a cap derived from THEIR OWN recent behaviour.
    const stable = srv.peerSmoothCapFor({ _burstLevel: 1 });
    const bursty = srv.peerSmoothCapFor({ _burstLevel: S.get('peerSmoothBurstSaturation') });
    ok('the stable player is not penalised for the bursty player existing',
      stable > bursty, `stable=${stable} bursty=${bursty}`);
  }

  console.log('\n── adaptive mode can be switched off, falling back to the single fixed cap ──');
  {
    S.set('peerSmoothAdaptive', false, 'test');
    const cap = srv.peerSmoothCapFor({ _burstLevel: S.get('peerSmoothBurstSaturation') });
    ok('with adaptive off, EVERY session gets the fixed peerSmoothMaxSpeed regardless of burstLevel',
      cap === S.get('peerSmoothMaxSpeed'), `cap=${cap}`);
    S.set('peerSmoothAdaptive', true, 'test');
  }

  console.log('\n── burstLevel itself is driven by real input arrival, live through the tick loop ──');
  {
    const bot = srv.spawnBot({ name: 'BurstTracker' });
    const session = [...srv.getSessions().values()].find((s) => s.playerId === bot.playerId);
    ok('a freshly spawned session starts at the burstLevel floor',
      !session._burstLevel || session._burstLevel <= 1, String(session && session._burstLevel));
    // Feed a 6-tick burst through the real drain path. inputBufferMaxCatchup now caps how much of
    // it a SINGLE call can drain (default 2, down from the old 16) — the burst-tracking mechanism
    // under test here is unchanged, so drain across as many calls as it actually takes, mirroring
    // several real server ticks rather than assuming one call clears an arbitrarily large backlog.
    for (let i = 1; i <= 6; i++) session.inputQueue.push({ clientTick: i, frames: [] });
    for (let t = 500; session.inputQueue.length > 0 && t < 520; t++) {
      srv.processBufferedTick(session, t, new Map());
    }
    ok('draining a 6-tick burst raises burstLevel to (about) 6',
      session._burstLevel >= 5.5, String(session._burstLevel));
    srv.removeBot(bot.playerId);
    await wait(200);
  }

  console.log('\n── peer replay queue: a burst records the REAL intermediate path, not just the final position ──');
  {
    const bot = srv.spawnBot({ name: 'ReplayTracker' });
    const session = [...srv.getSessions().values()].find((s) => s.playerId === bot.playerId);
    const ps = session.playerState;
    ps.position.x = 0; ps.position.y = 2; ps.position.z = 0;
    ps._ps.Qdsukt4.x = 0; ps._ps.Qdsukt4.y = 2; ps._ps.Qdsukt4.z = 0;
    session._peerReplayQueue = [];
    const frame = () => [1, [[0], [], [], [0, 0]]];   // holding forward
    for (let i = 1; i <= 4; i++) session.inputQueue.push({ clientTick: i, frames: [frame()] });
    // inputBufferMaxCatchup (default 2, down from the old 16) now caps how many of these 4 ticks a
    // SINGLE call actually simulates — drain across as many calls as it takes, mirroring several
    // real server ticks. pushReplaySnapshot fires once per REAL sub-tick simulated regardless of how
    // many calls that takes, so the queue should still end up with all 4 real positions.
    for (let t = 500; session.inputQueue.length > 0 && t < 520; t++) {
      srv.processBufferedTick(session, t, new Map());
    }
    ok('draining a 4-tick burst queued 4 distinct real sub-tick positions, not 1',
      session._peerReplayQueue.length === 4, `depth=${session._peerReplayQueue.length}`);
    const xs = session._peerReplayQueue.map((e) => e.x);
    // Forward could move along +x or -x depending on the bot's spawn yaw — only the MAGNITUDE of
    // progress matters here, not which direction. What must hold is: strictly monotonic (a real
    // path advancing every sub-tick) and no two entries identical (not 4 copies of the final result).
    let monotonic = true;
    const dir = Math.sign(xs[1] - xs[0]);
    for (let i = 1; i < xs.length; i++) if (Math.sign(xs[i] - xs[i - 1]) !== dir || xs[i] === xs[i - 1]) monotonic = false;
    ok('the queued positions trace the ACTUAL path forward (each further than the last), not duplicates',
      monotonic, JSON.stringify(xs));

    console.log('\n── peer replay queue: releases exactly one real position per call, oldest first ──');
    const first = srv.popReplayTarget(session);
    ok('the first popped entry is the OLDEST queued position (index 0), not the newest',
      first.x === xs[0], `got x=${first.x}, expected ${xs[0]}`);
    ok('popping drained exactly one entry', session._peerReplayQueue.length === 3,
      `depth=${session._peerReplayQueue.length}`);

    console.log('\n── peer replay queue: caught up (empty queue) falls back to the live true position ──');
    session._peerReplayQueue.length = 0;
    const empty = srv.popReplayTarget(session);
    ok('popping an empty queue returns null (caller falls back to true position)', empty === null);

    console.log('\n── peer replay queue: hard-capped, oldest dropped first ──');
    const cap = S.get('peerReplayQueueMax');
    session._peerReplayQueue = [];
    for (let i = 0; i < cap + 10; i++) srv.pushReplaySnapshot(session, { position: { x: i, y: 2, z: 0 } });
    ok(`queue never exceeds peerReplayQueueMax (${cap})`, session._peerReplayQueue.length === cap,
      `depth=${session._peerReplayQueue.length}`);
    ok('the OLDEST entries were dropped, not the newest (queue still ends at the latest push)',
      session._peerReplayQueue[session._peerReplayQueue.length - 1].x === cap + 9,
      String(session._peerReplayQueue[session._peerReplayQueue.length - 1].x));

    console.log('\n── peer replay queue: a genuine teleport discards the whole backlog ──');
    session._peerReplayQueue = [{ x: 1, y: 2, z: 3 }, { x: 4, y: 5, z: 6 }];
    ps.justTeleported = true;
    const afterTeleport = srv.popReplayTarget(session);
    ok('a teleported player pops null (nothing stale replays after the snap)', afterTeleport === null);
    ok('the queue itself was cleared, not just skipped this one call', session._peerReplayQueue.length === 0,
      `depth=${session._peerReplayQueue.length}`);
    ps.justTeleported = false;

    console.log('\n── peer replay queue: a teleport BURIED mid-burst is tagged, not treated like ordinary motion ──');
    {
      // g() resets justTeleported at the START of every sub-tick and only THIS project's own
      // replay code can see each sub-tick's value in between — by the time a whole burst finishes,
      // playerState.justTeleported reflects only the LAST sub-tick. A portal firing on an EARLIER
      // sub-tick of a multi-tick burst must still be recognisable once its entry is popped later.
      session._peerReplayQueue = [];
      ps.position.x = 0; ps.position.y = 2; ps.position.z = 0;
      ps.justTeleported = false;
      srv.pushReplaySnapshot(session, ps);              // sub-tick 1: ordinary, x=0
      ps.position.x = 5;
      ps.justTeleported = true;
      srv.pushReplaySnapshot(session, ps);               // sub-tick 2: portal fires HERE, x=5
      ps.justTeleported = false;                          // g() resets it before sub-tick 3 runs
      ps.position.x = 5.5;
      srv.pushReplaySnapshot(session, ps);               // sub-tick 3: ordinary again, post-portal
      ok('entry 1 is not tagged teleported', session._peerReplayQueue[0].teleported === false);
      ok('entry 2 (the actual portal sub-tick) IS tagged teleported, even though the burst continued after it',
        session._peerReplayQueue[1].teleported === true);
      ok('entry 3 (after g() reset the flag again) is not tagged teleported',
        session._peerReplayQueue[2].teleported === false);

      // updateBroadcastPosition must SNAP (not ease) when it consumes the tagged entry specifically.
      // A deliberately tiny cap (1 u/s -> 0.05 units/tick) makes "eased" vs "snapped" unambiguous:
      // an eased step from far away barely moves; a snap lands EXACTLY on the target regardless.
      const bp = { position: { x: 999, y: 2, z: 0 }, _broadcastPos: { x: -100, y: 2, z: 0 } };
      const e1 = srv.popReplayTarget(session);
      srv.updateBroadcastPosition(bp, 0.05, 1, e1);
      ok('the ordinary first entry (x=0) only eases a tiny capped step from x=-100, nowhere near x=0',
        Math.abs(bp._broadcastPos.x - (-100)) <= 0.05 + 1e-9, `x=${bp._broadcastPos.x}`);
      const e2 = srv.popReplayTarget(session);
      srv.updateBroadcastPosition(bp, 0.05, 1, e2);
      ok('the TELEPORTED entry (x=5) snaps there EXACTLY, ignoring the same tiny cap entirely',
        bp._broadcastPos.x === 5, `x=${bp._broadcastPos.x}`);
    }

    srv.removeBot(bot.playerId);
    await wait(200);
  }

  console.log('\n── peer replay queue: end to end — updateBroadcastPosition uses the replayed target, not the jumped-to true position ──');
  {
    const ps = { position: { x: 100, y: 2, z: 0 }, _broadcastPos: { x: 0, y: 2, z: 0 } };
    // Simulate what the tick-phase call site does: pop a replay target and pass it through explicitly,
    // as opposed to updateBroadcastPosition defaulting to the (already-jumped) true position.
    srv.updateBroadcastPosition(ps, 0.05, 1000, { x: 1, y: 2, z: 0 });
    ok('with a target override, broadcastPos moves toward the REPLAYED value, not the true (100) one',
      Math.abs(ps._broadcastPos.x - 1) < 0.01, `x=${ps._broadcastPos.x}`);
  }

  console.log('\n── peer extrapolation: OFF by default (0), but the mechanism itself still works if opted into ──');
  {
    // Defaults to 0 (disabled) — turned out to be the wrong direction for the original complaint:
    // it guesses ahead of the STRICT real-data replay this whole queue exists to guarantee, and a
    // wrong guess corrects by easing toward the next real position, which can be a BIGGER, more
    // visible snap than simply staying frozen would have needed. Left in as an explicit, non-default
    // opt-in rather than deleted outright, so this still tests the mechanism itself works correctly
    // for anyone who turns it on — hence enabling it for just this block.
    const prevMs = S.get('peerExtrapolationMs');
    S.set('peerExtrapolationMs', 300, 'test');
    const windowMs = S.get('peerExtrapolationMs');
    const maxSpeed = S.get('peerExtrapolationMaxSpeed');

    {
      const ps = { position: { x: 0, y: 2, z: 0 }, velocity: { x: 5, y: 0, z: 0 },
        _broadcastPos: { x: 0, y: 2, z: 0 } };
      // starved=true, no targetPos — exactly what the tick loop passes during a real gap.
      srv.updateBroadcastPosition(ps, 0.05, 1000, null, true);
      ok('a starved tick with a known velocity moves the broadcast position (extrapolating, not frozen)',
        ps._broadcastPos.x > 0 && ps._broadcastPos.x <= 5 * 0.05 + 1e-6,
        `x=${ps._broadcastPos.x}`);
    }

    {
      // A velocity far past the sanity clamp must still only move at the clamped speed.
      const ps = { position: { x: 0, y: 2, z: 0 }, velocity: { x: 9999, y: 0, z: 0 },
        _broadcastPos: { x: 0, y: 2, z: 0 } };
      srv.updateBroadcastPosition(ps, 0.05, 1000, null, true);
      ok('an absurd velocity is clamped to peerExtrapolationMaxSpeed, not taken at face value',
        Math.abs(ps._broadcastPos.x - maxSpeed * 0.05) < 1e-6, `x=${ps._broadcastPos.x}`);
    }

    {
      // Run past the window and confirm it stops advancing (freezes) rather than sliding forever.
      const ps = { position: { x: 0, y: 2, z: 0 }, velocity: { x: 5, y: 0, z: 0 },
        _broadcastPos: { x: 0, y: 2, z: 0 } };
      const dt = 0.05;
      let ticks = 0;
      const maxTicks = Math.ceil(windowMs / (dt * 1000)) + 5;
      for (; ticks < maxTicks; ticks++) srv.updateBroadcastPosition(ps, dt, 1000, null, true);
      const atCutoff = ps._broadcastPos.x;
      srv.updateBroadcastPosition(ps, dt, 1000, null, true);   // one more starved tick, well past the window
      ok(`extrapolation stops advancing once past the ${windowMs}ms window instead of sliding forever`,
        Math.abs(ps._broadcastPos.x - atCutoff) < 1e-6, `before=${atCutoff} after=${ps._broadcastPos.x}`);
    }

    {
      // Real data resuming must reset the window — a second, later gap should extrapolate again,
      // not stay stuck in "already exhausted" from the first one.
      const ps = { position: { x: 0, y: 2, z: 0 }, velocity: { x: 5, y: 0, z: 0 },
        _broadcastPos: { x: 0, y: 2, z: 0 } };
      const dt = 0.05;
      const maxTicks = Math.ceil(windowMs / (dt * 1000)) + 5;
      for (let i = 0; i < maxTicks; i++) srv.updateBroadcastPosition(ps, dt, 1000, null, true);   // exhaust it
      srv.updateBroadcastPosition(ps, dt, 1000, { x: 0.3, y: 2, z: 0 }, false);   // real data resumes
      const afterResume = ps._broadcastPos.x;
      srv.updateBroadcastPosition(ps, dt, 1000, null, true);   // a NEW gap starts right after
      ok('a fresh gap after real data resumed extrapolates again, not stuck from the first exhaustion',
        ps._broadcastPos.x > afterResume, `resume=${afterResume} after=${ps._broadcastPos.x}`);
    }

    {
      // Real (non-queued) data always wins over a guess — targetPos present means do NOT extrapolate
      // even if starved happens to be true for some other reason.
      const ps = { position: { x: 100, y: 2, z: 0 }, velocity: { x: 5, y: 0, z: 0 },
        _broadcastPos: { x: 0, y: 2, z: 0 } };
      srv.updateBroadcastPosition(ps, 0.05, 1000, { x: 1, y: 2, z: 0 }, true);
      ok('a real replay target overrides extrapolation entirely, even while starved',
        Math.abs(ps._broadcastPos.x - 1) < 0.01, `x=${ps._broadcastPos.x}`);
    }

    S.set('peerExtrapolationMs', prevMs, 'test');
    ok('setting restored to its real default (0 = off) after this block',
      S.get('peerExtrapolationMs') === 0, String(S.get('peerExtrapolationMs')));
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
