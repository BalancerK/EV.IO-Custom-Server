/**
 * test_stats_send_window.js — kills/deaths/score/assists/killStreak/multiKill (opcodes
 * 214/215/216/226/228/229) are send-on-change, not unconditional every tick.
 *
 * WHY THIS EXISTS
 * ────────────────
 * These six fields are NOT reconciler-compared (verified directly against the client's Qqx5i3b
 * comparator, which checks only position/yaw/pitch/grounded/weapon/crouch/sprint/zoom/airJumps/
 * dance/examine/ability/teleport) and — unlike opcode 227 right next to them — omitting them is a
 * plain "keep the client's current value", not an implicit auto-increment. They change only on a
 * kill/death/round-reset event, so resending all six every tick for every visible peer was pure
 * waste: real parse/apply cost for a weak-CPU client, for no reason 99%+ of the time (see this
 * session's investigation into the client's requestAnimationFrame-driven render loop compounding
 * under CPU stall).
 *
 * THE REAL BUG THIS TEST CAUGHT DURING DEVELOPMENT
 * ─────────────────────────────────────────────────
 * The peer-broadcast variant of _cachedPlayerBlock calls appendPlayerTickBody with a SHALLOW-SPREAD
 * COPY of playerState (`{ ...playerState, position: playerState._broadcastPos }`). Doing the
 * change-detection bookkeeping (_lastSentKills etc.) INSIDE appendPlayerTickBody would write to that
 * throwaway copy — the write would never persist back to the real object, "changed" would
 * re-evaluate true every single tick, and the mechanism would silently be a complete no-op for
 * peers specifically, the exact case it exists to help. The fix moved the bookkeeping into
 * _cachedPlayerBlock (which holds the real object) via _updateStatsSendWindow, guarded so it only
 * runs once per (subject, tick) even though both the self and peer variant can trigger it.
 *
 * Usage:  node scripts/test_stats_send_window.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = process.env.EVIO_LOCAL_PORT || '18620';
process.env.EVIO_JOIN_DEADLINE = '0';

const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const WebSocket = require('ws');

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
function opVal(body, op, fromIdx = 0) {
  for (let i = fromIdx; i < body.length - 1; i++) if (body[i] === op) return body[i + 1];
  return undefined;
}
function has(body, op) { return body.includes(op); }
// The real sweep decrements _statsSendCount once per real server tick — simulated here directly
// since these tests drive buildTickBody in isolation rather than the whole tick loop.
function simulateSweepTick(sessions) {
  for (const s of sessions.values()) {
    if (s.playerState && s.playerState._statsSendCount > 0) s.playerState._statsSendCount -= 1;
  }
}

(async () => {
  await bpw.ready;

  console.log('\n── a brand new subject sends stats on its FIRST tick (0 differs from unset) ──');
  {
    const subject = mkSession('subj1', 0);
    const watcher = mkSession('watch1', 5);
    const sessions = new Map([['subj1', subject], ['watch1', watcher]]);
    const body = srv.buildTickBody('watch1', 1, watcher.playerState, sessions);
    ok('214 (kills) is present for the peer on its very first tick', has(body, 214));
    ok('and carries the correct value (0)', opVal(body, 214) === 0);
  }

  console.log('\n── once the reliability window expires with no change, stats stop being resent ──');
  {
    const subject = mkSession('subj2', 0);
    const watcher = mkSession('watch2', 5);
    const sessions = new Map([['subj2', subject], ['watch2', watcher]]);
    let tick = 1;
    // Drain the reliability window (STATS_SEND_RELIABILITY_TICKS ticks) with no change in between.
    for (; tick <= 8; tick++) {
      srv.buildTickBody('watch2', tick, watcher.playerState, sessions);
      simulateSweepTick(sessions);
    }
    const body = srv.buildTickBody('watch2', tick, watcher.playerState, sessions);
    ok('214/215/216/226/228/229 are all ABSENT once the window has fully decayed with nothing changed',
      !has(body, 214) && !has(body, 226) && !has(body, 228) && !has(body, 229),
      JSON.stringify(body.filter((x) => [214, 215, 216, 226, 228, 229].includes(x))));
    ok('227 (ticksSinceKill) is STILL present regardless — it is unconditional, always', has(body, 227));
  }

  console.log('\n── a real kill reopens the window immediately and it is visible to a PEER ──');
  {
    // This is the exact scenario the peer-variant spread-copy bug broke: a change on the subject
    // must be visible to a WATCHER (peer path), not just the subject's own self-view.
    const subject = mkSession('subj3', 0);
    const watcher = mkSession('watch3', 5);
    const sessions = new Map([['subj3', subject], ['watch3', watcher]]);
    let tick = 1;
    for (; tick <= 8; tick++) {
      srv.buildTickBody('watch3', tick, watcher.playerState, sessions);
      simulateSweepTick(sessions);
    }
    // Confirm it decayed first (same as the previous block), THEN change something.
    const before = srv.buildTickBody('watch3', tick, watcher.playerState, sessions);
    ok('sanity: decayed to absent before the kill', !has(before, 216));

    subject.playerState.kills = 1;
    subject.playerState.score = 100;
    tick++;
    const afterKill = srv.buildTickBody('watch3', tick, watcher.playerState, sessions);
    ok('the PEER (watcher) sees the new kill count immediately', opVal(afterKill, 214) === 1,
      String(opVal(afterKill, 214)));
    ok('the PEER sees the new score immediately too', opVal(afterKill, 216) === 100,
      String(opVal(afterKill, 216)));

    // And it should keep resending for the reliability window even with no FURTHER change, for
    // packet-loss safety — exactly mirroring weaponSendCount's own reasoning.
    simulateSweepTick(sessions);
    tick++;
    const nextTick = srv.buildTickBody('watch3', tick, watcher.playerState, sessions);
    ok('it keeps resending for a few more ticks after the change (packet-loss safety window)',
      opVal(nextTick, 214) === 1);
  }

  console.log('\n── the SELF view and the PEER view of the SAME subject agree (shared bookkeeping) ──');
  {
    // Both variants must observe the SAME change-detection state — this is the guard against
    // running _updateStatsSendWindow twice and getting inconsistent windows for self vs peer.
    const subject = mkSession('subj4', 0);
    const watcher = mkSession('watch4', 5);
    const sessions = new Map([['subj4', subject], ['watch4', watcher]]);
    let tick = 1;
    for (; tick <= 8; tick++) {
      // Build BOTH the subject's own body (self variant) and the watcher's body (peer variant of
      // the subject) on the SAME tick, in the same order production does it.
      srv.buildTickBody('subj4', tick, subject.playerState, sessions);
      srv.buildTickBody('watch4', tick, watcher.playerState, sessions);
      simulateSweepTick(sessions);
    }
    const selfBody = srv.buildTickBody('subj4', tick, subject.playerState, sessions);
    const peerBody = srv.buildTickBody('watch4', tick, watcher.playerState, sessions);
    ok('self view has decayed to absent', !has(selfBody, 214));
    ok('peer view ALSO decayed to absent (not stuck resending forever, not stuck NEVER sending)',
      !has(peerBody, 214));
  }

  console.log('\n── a new player joining forces every EXISTING session\'s window back open ──');
  {
    // The new joiner's own bootstrap hardcodes every existing peer's stats to 0
    // (state_builder.js buildFirstSpawnBody) — without a forced reset, a peer whose stats simply
    // hadn't changed recently would leave the new joiner stuck seeing 0 for them.
    srv.startServer();
    await new Promise((r) => setTimeout(r, 200));

    // A bot with real kills already on the board, decayed past its send window.
    const veteran = srv.spawnBot({ name: 'Veteran', level: 3 });
    veteran.playerState.kills = 7;
    veteran.playerState.score = 700;
    for (let t = 0; t < 10; t++) {
      srv.buildTickBody(veteran.playerId, 1000 + t, veteran.playerState, srv.getSessions());
      simulateSweepTick(srv.getSessions());
    }
    const decayed = srv.buildTickBody(veteran.playerId, 2000, veteran.playerState, srv.getSessions());
    ok('sanity: the veteran\'s stats had decayed to absent before anyone joined', !has(decayed, 214));

    // Now a real join arrives.
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.EVIO_LOCAL_PORT}`);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WS did not open within 5s')), 5000);
      ws.on('open', () => { clearTimeout(timer); resolve(); });
      ws.on('error', (err) => { clearTimeout(timer); reject(err); });
    });
    ws.send(';' + JSON.stringify({ uid: 17, name: 'NewJoiner' }));
    // Short wait — just enough for the join message to be processed (well under one tick's worth of
    // real ticks elapsing). STATS_SEND_RELIABILITY_TICKS worth of REAL ticks will run on the live
    // game loop while we wait, each decrementing _statsSendCount by 1 via the post-broadcast sweep
    // (this test uses a REAL running server here, unlike the manual simulateSweepTick() calls above)
    // — waiting anywhere close to that full window would race the assertion below against the same
    // decrement that (correctly) closes the window again after a few ticks.
    await new Promise((r) => setTimeout(r, 80));

    ok('the join actually forced the veteran\'s window back open',
      veteran.playerState._statsSendCount > 0, String(veteran.playerState._statsSendCount));
    const afterJoin = srv.buildTickBody(veteran.playerId, 3000, veteran.playerState, srv.getSessions());
    ok('a body built right after the join includes the veteran\'s real (non-zero) kill count again',
      opVal(afterJoin, 214) === 7, String(opVal(afterJoin, 214)));

    try { ws.close(); } catch (_) {}
    await new Promise((r) => setTimeout(r, 200));
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
