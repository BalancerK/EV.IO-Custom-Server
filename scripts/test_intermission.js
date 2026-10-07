/**
 * test_intermission.js — between rounds, everyone holds still.
 *
 * THE REQUEST
 * ───────────
 * "when the match enter Intermission state, all player should freeze at the same place whether they
 *  are on ground or flying in air."
 *
 * HOW, AND WHY IT IS NOT A SERVER-ONLY FREEZE
 * ───────────────────────────────────────────
 * The client's movement step opens with
 *
 *     if (r.Qpjho15 > 0) return void r.Qpjho15++;        // bundle :34491
 *
 * — it bails BEFORE gravity, which is exactly "freeze where you are, mid-air included". Qpjho15 is
 * opcode 168, which we already send as the death timer. So the freeze is expressed through the field
 * the client already obeys, and both sides stop on the same rule.
 *
 * Freezing only the server would have been worse than doing nothing: the client STOPS RECONCILING
 * while the match timer is <= 0 (bundle :67052), so a server-only freeze would drift apart silently
 * with no correction until the round restarted and everyone snapped.
 *
 * Overloading 168 is safe because the client reads it as a death timer only alongside Qyxhj60 === 4
 * (the click-to-play condition, :63938) or healthPoints <= 0, and a frozen live player is neither.
 *
 * Usage:  node scripts/test_intermission.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';

const fs = require('fs');
const path = require('path');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const S = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const opVal = (arr, op) => { const i = arr.indexOf(op); return i === -1 ? undefined : arr[i + 1]; };
const mkSession = (st) => ({
  sessionId: 'i1', playerId: 'i1', accepted: true, inputQueue: [], playerState: st,
  lastClientTick: 0, lastProcessedClientTick: -1, _idleTicks: 0, _lastInputMs: Date.now(),
});
const frame = (held = []) => [0, [held, [], [], [0, 0]]];

(async () => {
  await bpw.ready;
  const match = srv.match;
  const restore = match.gameMode;

  console.log('\n── the setting exists and is on ──');
  {
    const e = S.list().find((x) => x.key === 'intermissionFreeze');
    ok('intermissionFreeze is a setting', !!e);
    ok('and defaults to on', e && e.value === true, String(e && e.value));
  }

  console.log('\n── the freeze is only active during the intermission ──');
  {
    match.gameMode = 0;
    ok('playing: not frozen', srv.intermissionFreezeTicks() === 0 && !srv.isIntermission());
    match.gameMode = 2;    // round over
    ok('round over: frozen', srv.intermissionFreezeTicks() > 0 && srv.isIntermission());
    match.gameMode = 1;    // game over
    ok('game over: frozen', srv.intermissionFreezeTicks() > 0);
    match.gameMode = restore;
  }

  console.log('\n── the client is TOLD to freeze, not just the server ──');
  {
    // The whole point. A server-only freeze drifts silently, because the client stops reconciling
    // while the match timer is <= 0.
    match.gameMode = 0;
    const st = srv.createPlayerSimState();
    st._holdForPlay = false;   // this fixture represents a PLAYING player, not the join-hold itself
    const playing = [];
    srv.appendPlayerTickBody(playing, 'p', st);
    ok('opcode 168 is 0 while playing', opVal(playing, 168) === 0, String(opVal(playing, 168)));

    match.gameMode = 2;
    const frozen = [];
    srv.appendPlayerTickBody(frozen, 'p', st);
    ok('opcode 168 goes non-zero at the intermission', opVal(frozen, 168) > 0,
      `${opVal(frozen, 168)} — the client's movement step bails on > 0`);
    ok('the player is still ALIVE, not dead', opVal(frozen, 91) === 1,
      `91=${opVal(frozen, 91)} — 4 would make the client show the click-to-play overlay`);
    match.gameMode = restore;
  }

  console.log('\n── a death timer still wins over the freeze ──');
  {
    // max(), not assignment: a player who died just before the round ended must keep counting toward
    // their respawn, not be pinned at the freeze value.
    match.gameMode = 2;
    const st = srv.createPlayerSimState();
    st.deathStateTimer = 45;
    const body = [];
    srv.appendPlayerTickBody(body, 'p', st);
    ok('the larger of the two is sent', opVal(body, 168) === 45, String(opVal(body, 168)));
    match.gameMode = restore;
  }

  console.log('\n── a player in mid-air does not fall ──');
  {
    // The case named in the request, and the reason a velocity reset alone is not enough: gravity would
    // re-apply the next tick. The client bails before gravity; the server has to bail too.
    match.gameMode = 2;
    const st = srv.createPlayerSimState();
    const s = mkSession(st);
    st.position.y += 8; st._ps.Qdsukt4.y += 8;
    st.velocity.y = -4; st._ps.Qyaswvo.y = -4;
    const y0 = st._ps.Qdsukt4.y;
    for (let i = 1; i <= 20; i++) {
      s.inputQueue.push({ clientTick: i, frames: [frame([0])] });   // holding forward, too
      srv.processBufferedTick(s, 500 + i, new Map());
    }
    ok('they hang in the air', Math.abs(st._ps.Qdsukt4.y - y0) < 1e-6,
      `y ${y0.toFixed(3)} -> ${st._ps.Qdsukt4.y.toFixed(3)}`);
    ok('and the downward velocity is cleared', st._ps.Qyaswvo.y === 0,
      `vy=${st._ps.Qyaswvo.y} — left alone it would resume the fall on the first unfrozen tick`);
    match.gameMode = restore;
  }

  console.log('\n── held keys cannot walk a frozen player ──');
  {
    match.gameMode = 2;
    const st = srv.createPlayerSimState();
    const s = mkSession(st);
    const p0 = { x: st._ps.Qdsukt4.x, z: st._ps.Qdsukt4.z };
    for (let i = 1; i <= 40; i++) {
      s.inputQueue.push({ clientTick: i, frames: [frame([0, 7])] });   // forward + sprint
      srv.processBufferedTick(s, 600 + i, new Map());
    }
    const moved = Math.hypot(st._ps.Qdsukt4.x - p0.x, st._ps.Qdsukt4.z - p0.z);
    ok('they do not move', moved < 1e-6, `drifted ${moved.toFixed(4)}u over 40 frozen ticks`);
    match.gameMode = restore;
  }

  console.log('\n── the tick accounting keeps running while frozen ──');
  {
    // The batch must still be consumed. If the drain stopped, the queue would back up and the echo
    // would stall — the client would be reconciling against a tick that stopped advancing.
    match.gameMode = 2;
    const st = srv.createPlayerSimState();
    const s = mkSession(st);
    for (let i = 1; i <= 5; i++) s.inputQueue.push({ clientTick: i, frames: [frame()] });
    // inputBufferMaxCatchup (default 2) caps how much a SINGLE call drains — loop across as many
    // calls as it takes, mirroring several real server ticks, same as several other tests this
    // session needed after the catchup default dropped from 16.
    for (let t = 700; s.inputQueue.length > 0 && t < 720; t++) {
      srv.processBufferedTick(s, t, new Map());
    }
    ok('input is still consumed', s.inputQueue.length === 0,
      `${s.inputQueue.length} left queued — a backlog here would stall the echo`);
    ok('the processed tick advanced', s.lastProcessedClientTick === 5,
      String(s.lastProcessedClientTick));
    match.gameMode = restore;
  }

  console.log('\n── movement resumes when the round starts ──');
  {
    match.gameMode = 2;
    const st = srv.createPlayerSimState();
    const s = mkSession(st);
    st.position.y += 8; st._ps.Qdsukt4.y += 8;
    for (let i = 1; i <= 10; i++) {
      s.inputQueue.push({ clientTick: i, frames: [frame()] });
      srv.processBufferedTick(s, 800 + i, new Map());
    }
    const yFrozen = st._ps.Qdsukt4.y;
    match.gameMode = 0;
    for (let i = 11; i <= 20; i++) {
      s.inputQueue.push({ clientTick: i, frames: [frame()] });
      srv.processBufferedTick(s, 800 + i, new Map());
    }
    // Asserts that the sim RESUMES, not that the player falls. Teleporting a capsule 8u without
    // re-seating it in the collision world can leave it inside geometry, and the first unfrozen tick
    // then resolves the overlap upward — a fixture artefact, not a physics bug. The property that
    // matters here is only that the freeze ended.
    ok('the sim runs again', Math.abs(st._ps.Qdsukt4.y - yFrozen) > 1e-6,
      `y ${yFrozen.toFixed(2)} -> ${st._ps.Qdsukt4.y.toFixed(2)} (direction depends on the fixture)`);
    match.gameMode = restore;
  }

  console.log('\n── it can be turned off ──');
  {
    const prev = S.get('intermissionFreeze');
    S.set('intermissionFreeze', false, 'test');
    match.gameMode = 2;
    ok('off means no freeze even at the intermission', srv.intermissionFreezeTicks() === 0);
    S.set('intermissionFreeze', prev, 'test');
    match.gameMode = restore;
  }

  console.log('\n── a player held before they choose to play ──');
  {
    // The arrival screen. State 3 gives the spectator camera AND shows CLICK TO PLAY with the
    // [ SPECTATE ] button (:61820); 4 would read as "you died". Both 2 and 3 select the spectator
    // camera — Qbk8noi(Qyxhj60, 2, 3) at :53212 — and whether it follows a player or flies free is a
    // client-side choice inside that mode, so the server picks the mode and the player picks the view.
    const st = srv.createPlayerSimState();
    st._holdForPlay = true;
    const body = [];
    srv.appendPlayerTickBody(body, 'p', st);
    // 0, confirmed by capturing the OFFICIAL server: an arriving player is state 0 with a death timer
    // of 0 and full health. I had tried 3 (which does give the spectator camera) because state 0 alone
    // looked broken — but state 0 is only broken when the client's arrival MENU fails to open, which is
    // the timer condition asserted below.
    // The official server sends 0 here — confirmed by capture. We send 3, deliberately: the client's
    // arrival MENU (the drifting camera behind the blurred canvas) needs roundTime defined on the game
    // mode, and only 3 of the client's 17 modes define it. Deathmatch does not, so on our mode state 0
    // leaves the player as an ordinary first-person player who merely cannot reconcile. 3 gives the
    // spectator camera plus CLICK TO PLAY, which is the closest thing deathmatch can reach.
    // 0, and with NO TRANSFORM — matched field-for-field against a capture of the official server,
    // which sends a held player 91=0, 168=0, 166=1 and position (0,0,0). We were sending a real spawn
    // position, and the client's camera anchored to it: first person, weapon in hand, standing where
    // the player would have spawned.
    // Deliberately NOT the official 0 — see the default's rationale. What matters here is that the
    // held player is put in whatever non-playing state is configured, not that it matches official.
    ok('a held player is put in the configured held state', opVal(body, 91) === S.get('heldPlayerState'),
      `91=${opVal(body, 91)}`);
    ok('and is reported with no transform', (() => {
      const i = body.indexOf(136);
      return i !== -1 && body[i + 2] === 0 && body[i + 3] === 0 && body[i + 4] === 0;
    })(), 'the official server sends (0,0,0) while held');
    ok('with zero yaw and pitch too', body[body.indexOf(139) + 1] === 0
      && body[body.indexOf(140) + 1] === 0,
      'we were sending the spawn yaw (3.927 rad) every tick — measured against the official 0');

    // NO WEAPON while held. This is what actually put the gun in the arrival view's hands: the
    // first-person viewmodel is built from the 135 slots and is VISIBLE BY DEFAULT, and the code that
    // would hide it (gated on state 1, :48138) sits inside the update chain that short-circuits once
    // the client nulls its prediction for state 0. The model was created, shown, and then never
    // touched again — correcting the state could never hide something whose hide-path never runs.
    const entryOps = (b) => {
      const st0 = b.indexOf(244); const o = new Set();
      for (let i = st0 + 2; i < b.length - 1; i += 2) o.add(b[i]);
      return o;
    };
    ok('a held player is given no weapon slots', !entryOps(body).has(135),
      'the viewmodel is built from these and defaults to visible');
    const playingBody = [];
    const playingSt = srv.createPlayerSimState();
    playingSt._holdForPlay = false;   // this fixture represents a PLAYING player, not the join-hold itself
    srv.appendPlayerTickBody(playingBody, 'p', playingSt);
    ok('a playing player still gets them', entryOps(playingBody).has(135));

    // ...and the weapon must come BACK on release. 127/128/135 are delta-emitted, so without forcing
    // a re-send the player would enter the match empty-handed.
    const rel = srv.createPlayerSimState();
    rel._holdForPlay = true;
    srv.handleLobbyIntent({ sessionId: 'r', playerState: rel }, 'play');
    const relBody = [];
    srv.appendPlayerTickBody(relBody, 'p', rel);
    ok('the weapon returns when the player enters the match', entryOps(relBody).has(135),
      `weaponSendCount=${rel.weaponSendCount}`);

    // The BOOTSTRAP has its own `spawn` field, separate from opcode 136. Zeroing only the tick body
    // left the first packet carrying a real spawn position — measured at (19.2, 6.05, 54.4) — and in
    // that ~260ms window the client built a normal local player, showed the first-person weapon and
    // anchored the camera. State 0 then nulled its prediction and every updater is guarded on that
    // being non-null, so both stayed frozen. The first packet has to be held too.
    const srcB = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    // THREE, not two. This assertion used to demand exactly 2 and passed for weeks while the earliest
    // bootstrap of the lot — the join-time buildStatePacket at the connection handler — sent state 1
    // and a real spawn. Counting call sites can only ever confirm the ones you already knew about, so
    // the authoritative check is now behavioural: test:joinstate reads the 91 sequence off a real
    // socket and fails if a held player is shown state 1 even once.
    ok('all three bootstraps place a held player at the origin',
      (srcB.match(/\? \{ x: 0, y: 0, z: 0, yaw: 0 \}/g) || []).length === 3,
      'join-time packet, self bootstrap, peer introduction');

    // A held player must never be reconciled. Reconciliation rebuilds the local player from the
    // CLIENT's prediction, and the client never predicts Qyxhj60 = 0 — only the server sends it — so a
    // reconcile silently restores state 1. The visible symptom was a first-person camera with the
    // weapon in hand on the arrival screen, because the FP weapon is gated on state 1 (:48138).
    // Official echoes -1 on every packet and so never reconciles.
    const heldSess = {
      sessionId: 'h', playerState: st, lastClientTick: 500, lastProcessedClientTick: 500, _idleTicks: 0,
    };
    ok('a held player is never reconciled', srv.computeEchoTick(500, heldSess) === -1,
      `echo=${srv.computeEchoTick(500, heldSess)} — any real tick lets the prediction overwrite state 0`);
    const playingSessState = srv.createPlayerSimState();
    playingSessState._holdForPlay = false;   // this fixture represents a PLAYING player, not the join-hold itself
    const playingSess = {
      sessionId: 'p2', playerState: playingSessState,
      lastClientTick: 500, lastProcessedClientTick: 500, _idleTicks: 0,
    };
    ok('a playing player still reconciles normally', srv.computeEchoTick(500, playingSess) === 500,
      'the suppression must not leak to players in the match');

    const srcE = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    ok('both echo paths suppress it',
      (srcE.match(/_holdForPlay\) return -1|_holdForPlay\) echoTick = -1/g) || []).length === 2,
      'the buffer path computes its echo inline — patching only computeEchoTick has failed before');
    ok('with no death timer, as the official server sends', opVal(body, 168) === 0,
      `168=${opVal(body, 168)} — an inflated one is the respawn screen, not the arrival screen`);

    // The arrival menu opens only when the timer reads near-full (:64553). Officially that holds
    // because you arrive as the round begins — the captured timer was 3616 of ~3600. A mid-round join
    // fails it, and in state 0 the client also skips its whole world step (:45684), so without the menu
    // the player sits frozen in first person. That was the "stuck at the same place" report.
    const heldBody = srv.buildTickBody('p', 5, st, null);
    // The full-timer trick applies only to state 0, the one case it can help — on any other held
    // state it would just show a wrong clock.
    ok('a held player is shown a FULL match timer', opVal(heldBody, 7) === S.get('roundTicks'),
      `7=${opVal(heldBody, 7)} — the arrival menu needs a near-full clock (:64553)`);
    ok('and a game mode the menu opens for',
      opVal(heldBody, 280) === 0 || opVal(heldBody, 280) === 4, `280=${opVal(heldBody, 280)}`);

    // Per-recipient: everyone actually playing must still see the real clock.
    const playing2 = srv.createPlayerSimState();
    playing2._holdForPlay = false;   // this fixture represents a PLAYING player, not the join-hold itself
    srv.match.timer = 1234;
    ok('a playing player still sees the real timer',
      opVal(srv.buildTickBody('p', 5, playing2, null), 7) === 1234,
      'the full-timer trick must not leak to everyone');



    // Not in the match means not shootable. The client refuses damage for any state but 1, so the
    // server agreeing is what avoids a health bar that drops and snaps back.
    st.healthPoints = 1;
    srv.applyDamage(st, 0.5, null);
    ok('a held player cannot be damaged', st.healthPoints === 1, `hp=${st.healthPoints}`);

    // Deliberately NOT frozen server-side. The client's movement bail on Qpjho15 (:34491) is nested
    // inside a conditional, so a held player keeps predicting locally; pinning them on the server made
    // the two drift until the userscript's desync watchdog snapped the position repeatedly, which
    // reads on screen as a teleport effect firing over and over. They are held out of the match by
    // their STATE, not by being stopped.
    const src2 = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    // A plain substring, not a regex: the first version of this check was generated with broken
    // escaping, so `()` and `||` were read as regex operators and it could never match what it meant.
    ok('a held player is not pinned in place',
      !src2.includes('intermissionFreezeTicks() > 0 || playerState._holdForPlay'),
      'pinning them fought the client prediction and produced repeated snaps');
  }

  console.log('\n── idle traffic cannot force a held player into the match ──');
  {
    // End to end through the real ingest path, because this is the bug the player actually saw: the
    // arrival screen appeared and then vanished half a second later on its own.
    const st = srv.createPlayerSimState();
    st._holdForPlay = true;
    const s = mkSession(st);
    const idle = [0, [[], [], [], [0, 0]]];
    for (let t = 1; t <= 40; t++) srv.enqueueClientInput(s, [0, 0, -1, -1, t, [idle]]);
    ok('40 idle frames leave them held', st._holdForPlay === true,
      'two seconds of menu traffic used to be enough to force entry');

    const move = [0, [[], [], [], [0.05, 0]]];
    srv.enqueueClientInput(s, [0, 0, -1, -1, 41, [move]]);
    ok('a mouse movement releases them', st._holdForPlay === false);
    // Assert the EFFECT, not the mechanism. This used to demand deathStateTimer === 1, which was how
    // joining was implemented — and that implementation was the bug: the emitter reports 91 = 4 while
    // that timer runs, so clicking to play put the DEATH CAMERA on screen for RESPAWN_TICKS (3s).
    // The player must arrive alive and immediately; how that happens is not the test's business.
    ok('and they arrive alive and immediately', st.deathStateTimer === 0 && st.healthPoints === 1,
      `deathStateTimer=${st.deathStateTimer} health=${st.healthPoints} — any dead time shows the death cam`);
  }

  console.log('\n── the lobby signal is ON THE WIRE, in the input event map ──');
  {
    // The answer to "how does the official server know?". The packed input is
    //   [held, pressed, released, lookDelta, absoluteAxes, eventMap]
    // and I had only ever read the first four. The client fills the sixth from its lobby flow
    // (bundle :71599): slot 0 when it enters the game (pointer lock acquired, or the [ JOIN ] button),
    // slot 1 when it enters spectate. So the official server READS the click; it does not infer it,
    // and every heuristic before this was working around a field I had not decoded.
    const F = (ev) => [0, [[], [], [], [0, 0], [], ev]];
    ok('slot 0 means play', srv.lobbyEventInFrames([F({ 0: true })]) === 'play');
    ok('slot 1 means spectate', srv.lobbyEventInFrames([F({ 1: true })]) === 'spectate');
    ok('the per-frame slot 4 is not a lobby signal',
      srv.lobbyEventInFrames([F({ 4: 241 })]) === null,
      'slot 4 is written every single frame — treating it as a signal would fire constantly');
    ok('a frame with no event map is not a signal',
      srv.lobbyEventInFrames([[0, [[], [], [], [0, 0]]]]) === null);
    ok('an empty batch is not a signal', srv.lobbyEventInFrames([]) === null);

    // End to end: the signal alone must take a held player into the match.
    const st = srv.createPlayerSimState();
    st._holdForPlay = true;
    const s = mkSession(st);
    srv.enqueueClientInput(s, [0, 0, -1, -1, 1, [F({ 4: 151 })]]);
    ok('idle frames still leave them held', st._holdForPlay === true);
    srv.enqueueClientInput(s, [0, 0, -1, -1, 2, [F({ 1: true })]]);
    ok('the spectate signal moves them to spectating', st._spectating === true && st._holdForPlay === true);
    srv.enqueueClientInput(s, [0, 0, -1, -1, 3, [F({ 0: true })]]);
    ok('the play signal puts them in the match', st._holdForPlay === false);
    ok('alive and immediately, with no dead state to show the death cam',
      st.deathStateTimer === 0 && st.healthPoints === 1,
      `deathStateTimer=${st.deathStateTimer} health=${st.healthPoints}`);
  }

  console.log('\n── choosing SPECTATE is not undone by moving the camera ──');
  {
    // The reported symptom: "i enter free camera view for like a moment, then forced to join". Moving
    // the free camera produces look deltas, the input heuristic read them as "I want to play", and the
    // player was dragged into the match a second after choosing not to be. A client that fills the
    // event map will send the real signal, so the heuristic must switch itself off for that client.
    const F = (ev, look) => [0, [[], [], [], look || [0, 0], [], ev]];
    const st = srv.createPlayerSimState();
    st._holdForPlay = true;
    const s = mkSession(st);

    srv.enqueueClientInput(s, [0, 0, -1, -1, 1, [F({ 4: 241 })]]);
    ok('a client that fills the event map is detected', s._clientSendsLobbyEvents === true,
      'slot 4 is written every frame by the official client, so one frame is enough to know');

    srv.enqueueClientInput(s, [0, 0, -1, -1, 2, [F({ 1: true })]]);
    ok('SPECTATE holds them out of the match', st._spectating === true && st._holdForPlay === true);

    for (let t = 3; t < 12; t++) srv.enqueueClientInput(s, [0, 0, -1, -1, t, [F({ 4: 100 }, [0.5, 0.3])]]);
    ok('large free-camera movement does NOT force them in', st._holdForPlay === true,
      'this is the exact regression — nine frames of vigorous mouse movement');

    srv.enqueueClientInput(s, [0, 0, -1, -1, 20, [F({ 0: true })]]);
    ok('and the real play signal still works', st._holdForPlay === false);
  }

  console.log('\n── the hold ends on INTENT, not on any packet ──');
  {
    // Measured behaviour: the client keeps sending input frames while its own menu is up, so the hold
    // ended about half a second after joining — before the player clicked anything. What actually
    // changes at the click is that the pointer LOCKS, and only then can the client produce mouse-look
    // deltas or route keys to the game. So the signal is a held/pressed/released action or a real look
    // delta, not the mere arrival of a packet.
    const F = (h, p, r, l) => [0, [h, p, r, l]];
    ok('an idle menu frame is not intent', srv.framesShowIntent([F([], [], [], [0, 0])]) === false,
      'this is what the client sends while the overlay is up — the old check released on it');
    ok('sub-noise look jitter is not intent',
      srv.framesShowIntent([F([], [], [], [1e-9, 0])]) === false);
    ok('a real mouse movement is intent', srv.framesShowIntent([F([], [], [], [0.02, 0])]) === true,
      'only reachable once the pointer is locked, which is what the click does');
    ok('a held key is intent', srv.framesShowIntent([F([0], [], [], [0, 0])]) === true);
    ok('a pressed key is intent', srv.framesShowIntent([F([], [5], [], [0, 0])]) === true);
    ok('an empty batch is not intent', srv.framesShowIntent([]) === false);
    ok('a malformed batch is survived', srv.framesShowIntent([null, 'x']) === false);
  }

  console.log('\n── the BOOTSTRAP carries the held state too ──');
  {
    // The bug that made the whole feature look broken: the bootstrap hardcoded `91, 1`. It is the
    // first state the client decodes and the lobby UI is built from it, so every joining player was
    // told "you are in the match" and the menu was torn down before the per-tick body could say
    // otherwise. Both had to agree — exactly like spawn protection, which had the same bootstrap gap.
    const sb = require('../state_builder');
    ok('a held bootstrap carries the held state', opVal(sb.buildFirstSpawnBody({ playerId: 'p', playerState: 0 }), 91) === 0);
    ok('an ordinary bootstrap still says 1', opVal(sb.buildFirstSpawnBody({ playerId: 'p' }), 91) === 1,
      'the default must not change for players who are simply playing');

    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    ok('both bootstrap call sites pass the state',
      (src.match(/playerState: (peer|s)\.playerState && \1\.playerState\._holdForPlay/g) || []).length === 2,
      'the self bootstrap and the peer introduction');
  }

  console.log('\n── and the bootstrap grants no WEAPON to a held player ──');
  {
    // Same shape of bug, one layer deeper, and it cost a full round of "the weapon is still there".
    // The first-person viewmodel is built from the 135 weapon slots and is visible by DEFAULT; the code
    // that hides it is gated on state 1 and sits inside an update chain the client short-circuits once
    // it nulls its prediction for state 0. So a weapon granted at bootstrap can never be taken back —
    // gating the per-tick stream alone changed nothing on screen, because the bootstrap re-granted it.
    const sb = require('../state_builder');
    const held = sb.buildFirstSpawnBody({ playerId: 'p', playerState: 0 });
    const playing = sb.buildFirstSpawnBody({ playerId: 'p' });
    ok('a held bootstrap carries no weapon slot at all', !held.includes(135));
    ok('and no first-person weapon id', opVal(held, 127) === -1,
      'dataById[-1] is undefined, so no model is built');
    ok('a spectating bootstrap is the same', !sb.buildFirstSpawnBody({ playerId: 'p', playerState: 2 }).includes(135));
    ok('an ordinary bootstrap still arms the player', playing.includes(135) && opVal(playing, 127) === 4,
      'the default must not change for players who are simply playing');
  }

  console.log('\n── the held state is configurable, and the join hold is on by default ──');
  {
    const e = S.list().find((x) => x.key === 'heldPlayerState');
    ok('heldPlayerState is a setting', !!e);
    // 0, as official sends. State 0 is what selects the FLYOVER camera (:53213) and draws CLICK TO
    // PLAY + [ SPECTATE ] (:61820). An arrival view stuck at the origin is the flyover running with an
    // empty path list, not a wrong state — moving off 0 trades the arrival screen for the spectator
    // camera and hides the real cause.
    ok('and defaults to 0 (the state that runs the flyover camera)', e && e.value === 0, String(e && e.value));
    const c = S.list().find((x) => x.key === 'clickToPlayJoin');
    // Confirmed live against the real client (no false-start — it stays silent while held), so
    // this now defaults ON (see CLICK_TO_PLAY's own comment). Every OTHER assertion in this file
    // sets playerState._holdForPlay directly rather than relying on the setting's own default, so
    // this is the only one actually exercising the default itself.
    ok('the join hold itself defaults ON', c && c.value === true,
      'the click is on the wire by default — see probe:clicktoplay');
  }

  match.gameMode = restore;
  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
