/**
 * test_rounds.js — deathmatch round lifecycle, timer sync, and per-round stats.
 *
 * PROTOCOL (from the bundle)
 * ──────────────────────────
 *   opcode 7   Qpm8qez  match time remaining in TICKS. The decoder AUTO-DECREMENTS it when the
 *                       opcode is absent (`7===n[a] ? Qpm8qez=n[++a] : Qpm8qez--`), so the HUD
 *                       clock free-runs between updates; we send it every tick, which is always
 *                       correct and self-correcting.
 *   opcode 42  Qdh8um3  lobbyData.matchDuration = TICKS PER SECOND (20), NOT the match length.
 *                       The HUD does Qapcs0u(Qpm8qez / matchDuration) and Qapcs0u formats SECONDS
 *                       as m:ss, so omitting 42 renders NaN:NaN.
 *   opcode 280 Qbu40n9  gameMode: 0 playing, 2 round over (weapons hidden + "Next round in X"),
 *                       1 whole game over.
 *   opcodes 214/215/216 Qty774u kills / deaths / score.
 *
 * The timer counts DOWN THROUGH ZERO into negative for the intermission, because the client
 * computes the next-round countdown as `(Qywx2mi + Qpm8qez) / matchDuration` with
 * Qywx2mi = Qxhitt4 = 400 ticks (20s). Round length is Q5vkher = 4800 ticks = 4 min at 20Hz.
 *
 * Usage:  node scripts/test_rounds.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const S = require('../settings');
const srv = require('../local_ws_server');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

const readOp = (body, op) => {
  for (let i = 0; i < body.length - 1; i++) if (body[i] === op && body[i - 1] !== op) return body[i + 1];
  return undefined;
};
function mkSession(id) {
  return {
    sessionId: id, playerId: id, accepted: true, displayName: id, uid: 7,
    playerState: srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, id),
    ws: { readyState: 1, OPEN: 1, send() {} },
  };
}

console.log('\n── the bundle constants we key off ──');
{
  ok('round length defaults to 4800 ticks (Q5vkher = 4 min @20Hz)', S.get('roundTicks') === 4800,
    String(S.get('roundTicks')));
  ok('intermission defaults to 400 ticks (Qxhitt4 = 20s)', S.get('intermissionTicks') === 400,
    String(S.get('intermissionTicks')));
  ok('4800 ticks really is 4 minutes at 20Hz', 4800 / 20 === 240);
}

console.log('\n── the round clock reaches the client ──');
{
  const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'p');
  const body = srv.buildTickBody('p', 1, ps, new Map());
  const t = readOp(body, 7);
  ok('opcode 7 carries the live match timer, not a constant', t === srv.match.timer, String(t));
  ok('it is a tick count, not milliseconds', Math.abs(t) <= 200000, String(t));
  ok('opcode 42 (matchDuration) is sent', readOp(body, 42) === 20, String(readOp(body, 42)));
  // Without 42 the HUD divides by undefined -> NaN:NaN.
  ok('42 is ticks-per-second so the HUD shows m:ss', 4800 / readOp(body, 42) === 240);
  ok('opcode 280 carries gameMode', readOp(body, 280) === srv.match.gameMode);
}

console.log('\n── round -> intermission -> new round ──');
{
  const a = mkSession('a'), b = mkSession('b');
  const sessions = new Map([['a', a], ['b', b]]);
  srv.startNewRound(sessions);                 // clean slate
  const startRound = srv.match.round;
  ok('a fresh round is in the playing phase', srv.match.gameMode === 0);
  ok('and the clock is full', srv.match.timer === S.get('roundTicks'), String(srv.match.timer));

  // Score something so we can prove it resets.
  a.playerState.kills = 5; a.playerState.deaths = 2; a.playerState.score = 5;
  b.playerState.deaths = 5;

  // Run out the clock.
  for (let i = 0; i < S.get('roundTicks'); i++) srv.tickMatch(sessions);
  // gameMode 1 = GAME over: the client shows the end-game scoreboard (its leaderboard/earn/
  // performance tabs are gated on `1 === l.gameMode`) plus "Next game in X". gameMode 2 is a
  // SUB-round end and shows neither, so deathmatch must use 1.
  ok('at zero the round ends with the end-game scoreboard mode',
    srv.match.gameMode === S.get('roundEndGameMode'), `gameMode=${srv.match.gameMode}`);
  ok('and that mode is 1 — the one that shows the scoreboard tabs',
    S.get('roundEndGameMode') === 1, String(S.get('roundEndGameMode')));
  ok('the timer keeps going NEGATIVE for the intermission', srv.match.timer <= 0, String(srv.match.timer));
  ok('stats survive the intermission (the scoreboard is being shown)',
    a.playerState.kills === 5, String(a.playerState.kills));

  // The client's countdown is (400 + timer) / 20 seconds; it must stay in range.
  const secs = (S.get('intermissionTicks') + srv.match.timer) / 20;
  ok('the client-side countdown starts at ~20s', secs > 19 && secs <= 20, secs.toFixed(1));

  // Burn the intermission.
  for (let i = 0; i < S.get('intermissionTicks'); i++) srv.tickMatch(sessions);
  ok('a new round starts', srv.match.round === startRound + 1, String(srv.match.round));
  ok('and it is playing again', srv.match.gameMode === 0);
  ok('the clock is reset to full', srv.match.timer === S.get('roundTicks'), String(srv.match.timer));

  console.log('\n── stats reset on the new round ──');
  ok('kills are cleared', a.playerState.kills === 0, String(a.playerState.kills));
  ok('deaths are cleared', a.playerState.deaths === 0 && b.playerState.deaths === 0);
  ok('score is cleared', a.playerState.score === 0);
  ok('players are alive again', a.playerState.healthPoints === 1 && a.playerState.deathStateTimer === 0);
  ok('and emotes are cleared', a.playerState.isDancing === false);
}

console.log('\n── map cycle on round start ──');
{
  // Changing the map is a two-part signal: bump Qy1p5xf (opcode 8, the GENERATION id — the loader
  // fires when it differs from the last loaded value) and send the new URL in Qsj9eqq (opcode 15).
  const sessions = new Map([['m', mkSession('m')]]);
  const genBefore = srv.match.mapGeneration;
  srv.startNewRound(sessions);
  // A single-map rotation must NOT bump the generation. Bumping it makes the client tear its game
  // state down (Qrn6ykl -> predictState null -> canSendInput=false, isGameActive=false, signal 4),
  // which is precisely what left peers invisible and shooting/grenades dead after every round.
  ok('a single-map rotation does NOT force a reload',
    srv.match.mapGeneration === genBefore, genBefore + ' -> ' + srv.match.mapGeneration);

  // With two maps it must rotate and bump.
  const savedRot = S.get('mapRotation');
  S.set('mapRotation', savedRot + ',https://ev.io/sites/default/files/maps/Rotation_9.evmap', 'test');
  const gen2 = srv.match.mapGeneration;
  srv.startNewRound(sessions);
  ok('a multi-map rotation DOES advance and bump the generation',
    srv.match.mapGeneration === gen2 + 1, gen2 + ' -> ' + srv.match.mapGeneration);
  ok('and every client is flagged for a full re-bootstrap on a real map change',
    [...sessions.values()].every((x) => x.pendingFullBootstrap === true),
    'a movement tick body has no weapon/stats/identity and cannot rebuild an entity');
  S.set('mapRotation', savedRot, 'test');

  const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'm');
  const body = srv.buildTickBody('m', 1, ps, new Map());
  ok('opcode 8 carries the current generation', readOp(body, 8) === srv.match.mapGeneration);
  ok('opcode 15 carries the map URL to load', typeof readOp(body, 15) === 'string'
    && String(readOp(body, 15)).endsWith('.evmap'), String(readOp(body, 15)));

  // The rotation must stay on maps the SERVER can actually simulate. Its physics world is built
  // from default_map.evmap; rotating the client elsewhere would desync everyone completely.
  ok('the default rotation is Bishop only (server physics is Bishop-only)',
    String(S.get('mapRotation')).split(',').length === 1
    && String(S.get('mapRotation')).includes('Bishop'), String(S.get('mapRotation')));
}

console.log('\n── kill attribution ──');
{
  const killer = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'k');
  const victim = srv.createPlayerSimState({ x: 5, y: 2, z: 0, yaw: 0 }, 'v');
  srv.applyDamage(victim, 999, killer);
  ok('the killer gets the kill', killer.kills === 1, String(killer.kills));
  ok('the victim gets the death', victim.deaths === 1, String(victim.deaths));
  ok('the killer scores the official 100 per kill', killer.score === 100, String(killer.score));
  ok('the victim is dead', victim.healthPoints <= 0 && victim.deathStateTimer > 0);

  // A world kill (fall damage) credits nobody but still counts a death.
  const faller = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'f');
  srv.applyDamage(faller, 999, null);
  ok('a world kill counts a death with no killer', faller.deaths === 1);

  // Suicide must not reward: -100 floored at 0, no kill (client: Math.max(score - 100, 0)).
  const suicide = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 's');
  suicide.score = 250;
  srv.applyDamage(suicide, 999, suicide);
  ok('a suicide costs 100 and grants no kill',
    suicide.kills === 0 && suicide.deaths === 1 && suicide.score === 150,
    `k=${suicide.kills} d=${suicide.deaths} s=${suicide.score}`);
}

console.log('\n── stats reach the wire ──');
{
  const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'w');
  ps.kills = 3; ps.deaths = 1; ps.score = 3;
  // 214/215/216 are now send-on-change, gated on _statsSendCount (see test_stats_send_window.js) —
  // that bookkeeping normally runs in _cachedPlayerBlock (which detects the change and opens the
  // window), which this direct appendPlayerTickBody call bypasses. Open the window explicitly, same
  // as production would have after a genuine kills/deaths/score change.
  ps._statsSendCount = 1;
  const body = [];
  srv.appendPlayerTickBody(body, 'w', ps);
  ok('214 kills', readOp(body, 214) === 3, String(readOp(body, 214)));
  ok('215 deaths', readOp(body, 215) === 1, String(readOp(body, 215)));
  ok('216 score', readOp(body, 216) === 3, String(readOp(body, 216)));
}

console.log('\n── a player joining MID-round gets the live clock ──');
{
  // The bootstrap used to hardcode 7,72000. A newcomer would then see a 4:00 clock while everyone
  // else was at 1:30, and the HUD would jump on the very next tick.
  const sb = require('../state_builder');
  srv.match.timer = 1234;
  const body = sb.buildFirstSpawnBody({ playerId: 'j', matchTimer: srv.match.timer, matchDuration: 20 });
  ok('the bootstrap carries the CURRENT match timer', readOp(body, 7) === 1234, String(readOp(body, 7)));
  ok('and matchDuration so the clock formats', readOp(body, 42) === 20, String(readOp(body, 42)));
  // Defaults must still be sane if a caller omits them.
  const dflt = sb.buildFirstSpawnBody({ playerId: 'j' });
  ok('it falls back to a full round, never 0', readOp(dflt, 7) === 4800, String(readOp(dflt, 7)));
}


console.log('\n── rounds can be turned off ──');
{
  S.set('roundsEnabled', false, 'test');
  const sessions = new Map([['a', mkSession('a')]]);
  const before = srv.match.timer;
  for (let i = 0; i < 50; i++) srv.tickMatch(sessions);
  ok('the clock does not advance when rounds are disabled', srv.match.timer === before);
  S.set('roundsEnabled', true, 'test');
}


console.log('\n── OPCODE ORDER: the decoder is one strictly-ascending forward scan ──');
{
  // The client decodes a body with a SINGLE forward scan: `1===n[a] ? … , 4===n[a] ? … ,
  // 7===n[a] && … , 8===n[a] && …` and so on, with the cursor only moving forward. An out-of-order
  // opcode therefore does not error — the scan simply never matches the ones it has already passed,
  // and those fields silently keep their previous/default values.
  //
  // This bit us for real: opcode 42 (matchDuration) was inserted between 7 and 8, which made the
  // scan skip 8, 15, 17, 18 and 19. Opcode 15 is the MAP URL, so the client hung on the loading
  // screen forever with no console error and no failed request. Guard every builder.
  // The header is the flat `op, value` run at the front. Everything from the first ENTRY-LOOP
  // opcode onward is a repeating sub-structure the client consumes with its own `while` loop, and
  // fields inside an entry ascend independently of the header — so the flat ascending rule stops
  // there. Loops: 55 bullets, 67 hit events (Qh8gbjd), 74 medals (Qfw5vdx), 244 players.
  const LOOP_OPS = [55, 67, 74, 244];
  const headerOps = (body) => {
    const ops = [];
    for (let i = 0; i < body.length && !LOOP_OPS.includes(body[i]); i += 2) ops.push(body[i]);
    return ops;
  };
  const ascending = (ops) => {
    for (let i = 1; i < ops.length; i++) if (ops[i] <= ops[i - 1]) return `${ops[i - 1]} -> ${ops[i]}`;
    return null;
  };

  const sb = require('../state_builder');
  const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'o');

  // Every OPTION COMBINATION must stay ascending — the real join path passes customMap:true, and
  // that combination was broken (…19, 42, 37): the scan stalled at 37, the 244 loop never ran, and
  // the client showed a black screen / "Waiting for 2 players" with no error anywhere.
  for (const opts of [{}, { customMap: true }, { officialBootstrapFields: true },
                      { customMap: true, officialBootstrapFields: true }]) {
    const b = sb.buildFirstSpawnBody(Object.assign({ playerId: 'o', matchTimer: 4800, matchDuration: 20 }, opts));
    const brk = ascending(headerOps(b));
    ok('bootstrap header ascending with ' + (JSON.stringify(opts) || '{}'), brk === null, 'break at ' + brk);
    ok('  ...and the 244 player block is still reachable with ' + JSON.stringify(opts),
      b.indexOf(244) > 0, 'a stalled scan means NO player entity decodes');
  }
  const boot = sb.buildFirstSpawnBody({ playerId: 'o', matchTimer: 4800, matchDuration: 20, customMap: true });
  ok('bootstrap still carries the map URL (opcode 15)',
    boot.includes(15) && typeof boot[boot.indexOf(15) + 1] === 'string',
    'a mis-ordered opcode silently drops this and the client hangs at loading');

  const tick = srv.buildTickBody('o', 1, ps, new Map());
  ok('tick-body header is strictly ascending', ascending(headerOps(tick)) === null,
    'break at ' + ascending(headerOps(tick)));

  // The loops themselves must also appear in ascending order, because the client runs them one
  // after another in a single forward pass: bullets, then hit events, then medals, then players.
  {
    const at = (op) => tick.indexOf(op);
    const present = LOOP_OPS.filter((op) => at(op) >= 0);
    let brk = null;
    for (let i = 1; i < present.length; i++) {
      if (at(present[i]) < at(present[i - 1])) brk = `${present[i - 1]} before ${present[i]}`;
    }
    ok('entry loops appear in ascending opcode order', brk === null, brk || '');
  }

  const peerPkt = srv.buildPeerSpawnPacketForRecipient({
    playerId: 'q', tick: 1, displayName: 'q', uid: 1, weaponId: 4, teamId: 0, clanImgUrl: null,
    playerState: srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'q'),
  }, 3, 0);
  ok('peer-spawn packet header is strictly ascending', ascending(headerOps(peerPkt[2])) === null,
    'break at ' + ascending(headerOps(peerPkt[2])));
}


console.log('\n── the 244 PLAYER block must also be ascending (peer visibility) ──');
{
  // The client's 244 loop decodes each player block with the SAME ascending forward scan. If it
  // stalls inside one block the cursor never advances, so the loop cannot reach the NEXT 244 entry
  // either — every later peer silently stops decoding and becomes INVISIBLE, while server-side hit
  // detection keeps working (it never touched the client). That is exactly what happened when
  // 214/215/216 were emitted between 186 and 187.
  //
  // Simulating a full decode is impractical (variable-length opcodes), so we verify the ordering
  // property that matters: every known single-value opcode appears, in ascending positional order.
  const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'z');
  ps.kills = 2; ps.deaths = 1; ps.score = 2; ps.isDancing = true;
  // 214/215/216 are send-on-change (see test_stats_send_window.js) — open the window explicitly
  // since this direct call bypasses the _cachedPlayerBlock change-detection that normally does it.
  ps._statsSendCount = 1;
  const body = [];
  srv.appendPlayerTickBody(body, 'z', ps);

  const expect = [90, 91, 129, 130, 138, 139, 140, 141, 142, 143, 144, 145, 146, 149, 150, 151,
                  157, 158, 166, 167, 168, 185, 186, 187, 188, 197, 198, 207, 214, 215, 216];
  let cursor = -1, problem = null;
  for (const op of expect) {
    const at = body.indexOf(op, cursor + 1);
    if (at < 0) { problem = 'opcode ' + op + ' never appears'; break; }
    cursor = at;
  }
  ok('every player-block opcode is reachable by a single ascending scan', problem === null, problem);

  // Two players in one body: the second block must still be reachable.
  const a = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'a');
  const b = srv.createPlayerSimState({ x: 5, y: 2, z: 0, yaw: 0 }, 'b');
  a._statsSendCount = 1; b._statsSendCount = 1;   // open the send-on-change window (see above)
  const two = [];
  srv.appendPlayerTickBody(two, 'a', a);
  const firstEnd = two.length;
  srv.appendPlayerTickBody(two, 'b', b);
  ok('a second 244 block follows the first', two.indexOf(244, firstEnd) === firstEnd,
    'peers decode only if the scan reaches their block');
  const last = two.lastIndexOf(216);
  ok('and the second block ends with the stats opcodes', last > firstEnd);
}


console.log('\n── OFFICIAL scoring: medals, not a flat +1 ──');
{
  // The client awards score through MEDALS (Qmblb53):
  //   u = medal.Qcqgb7h;  if (victim is bot) u = round(u * 0.3);  if (victim is guest) u = round(u * 0.3)
  // Extracted base scores: kill 100, headshot 10, sword 20, frag/sticky/mine/tripmine 10.
  // Suicide is `score = Math.max(score - 100, 0)` — floored, and no kill credited.
  const mk = () => srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'x');

  let k = mk(), v = mk();
  srv.creditKill(k, v, {});
  ok('a plain kill is worth 100, not 1', k.score === 100, String(k.score));
  ok('and counts one kill / one death', k.kills === 1 && v.deaths === 1);

  k = mk(); v = mk();
  srv.creditKill(k, v, { headshot: true });
  ok('a headshot adds the +10 medal (110)', k.score === 110, String(k.score));

  k = mk(); v = mk();
  srv.creditKill(k, v, { weaponMedal: 'sword' });
  ok('a sword kill adds +20 (120)', k.score === 120, String(k.score));

  // The guest penalty is now a SETTING that defaults to 1.0 (fair), because on a private server
  // "you didn't sign in, so you're worth a third" is a strange thing to ask of an invited friend.
  // Both facts are worth pinning: the default, and that the official 0.3 math still works when asked
  // for — the assertions below set it explicitly so they keep documenting the client's own rounding.
  const _S = require('../settings');
  k = mk(); v = mk();
  srv.creditKill(k, v, { victimUid: 17 });
  ok('by DEFAULT a guest is worth a full kill (100)', k.score === 100, String(k.score));

  const _prevGuestMult = _S.get('guestScoreMultiplier');
  _S.set('guestScoreMultiplier', 0.3, 'test');
  k = mk(); v = mk();
  srv.creditKill(k, v, { victimUid: 17 });
  ok('with the official 0.3, killing a GUEST scores 30', k.score === 30, String(k.score));

  k = mk(); v = mk(); v.isBot = true;
  srv.creditKill(k, v, {});
  ok('killing a BOT scores x0.3 -> 30', k.score === 30, String(k.score));

  k = mk(); v = mk();
  srv.creditKill(k, v, { headshot: true, victimUid: 17 });
  ok('multipliers apply per-medal and round like the client (30 + 3)', k.score === 33, String(k.score));
  _S.set('guestScoreMultiplier', _prevGuestMult, 'test');

  // ...and with the fair default the same kill pays both medals in full.
  k = mk(); v = mk();
  srv.creditKill(k, v, { headshot: true, victimUid: 17 });
  ok('fair default pays a guest headshot in full (110)', k.score === 110, String(k.score));

  // Suicide: -100, floored at zero, no kill.
  const s1 = mk(); s1.score = 250;
  srv.creditKill(s1, s1, {});
  ok('a suicide costs exactly 100', s1.score === 150, String(s1.score));
  ok('and credits no kill', s1.kills === 0);
  const s2 = mk(); s2.score = 40;
  srv.creditKill(s2, s2, {});
  ok('suicide score is floored at 0, never negative', s2.score === 0, String(s2.score));

  // World kill: death only.
  const w = mk();
  srv.creditKill(null, w, {});
  ok('a world kill counts a death and no score change', w.deaths === 1 && w.score === 0);
}


console.log('\n── round restart must FULLY re-bootstrap every client ──');
{
  // A map reload rebuilds the client's world state, and the 244 tick loop then recreates each
  // entity as an EMPTY object (`w in playerList || (playerList[w] = {})`). A movement tick body
  // carries no weapon (127/135), no stats (95-123) and no identity (210/212/231), so after a
  // restart the LOCAL player has no weapon — attacks and grenades do nothing — and peers have no
  // model and stay invisible. Only a first-spawn body can rebuild them.
  const a = mkSession('a'), b = mkSession('b');
  const sessions = new Map([['a', a], ['b', b]]);
  // Signal 4 is the client saying "I tore down my state, resend everything" — it fires whenever
  // predictState returns null (e.g. a map-generation change). Answering it is what actually
  // recovers the session; ignoring it left the client permanently inactive.
  a.pendingFullBootstrap = false;
  srv.handleClientSignal(a, 4);
  ok('signal 4 queues a full re-bootstrap for that client', a.pendingFullBootstrap === true,
    'the client cannot recover on its own — it stops sending input until re-bootstrapped');
  b.pendingFullBootstrap = false;
  srv.handleClientSignal(b, 3);
  ok('other signals do not', b.pendingFullBootstrap === false);

  // What that bootstrap must contain, versus what a tick body has.
  const sb = require('../state_builder');
  const boot = sb.buildFirstSpawnBody({ playerId: 'a', displayName: 'a', uid: 7, weaponId: 4,
    customMap: true, matchTimer: srv.match.timer, matchDuration: 20,
    mapGeneration: srv.match.mapGeneration });
  const has = (body, op) => body.indexOf(op) >= 0;
  ok('the bootstrap carries the weapon (127)', has(boot, 127));
  ok('the bootstrap carries weapon slots (135)', has(boot, 135));
  ok('the bootstrap carries the stat block (95)', has(boot, 95));
  ok('the bootstrap carries identity (210)', has(boot, 210));

  const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'a');
  const tick = srv.buildTickBody('a', 1, ps, new Map());
  // A tick body carries NO IDENTITY (210 = display name, and no weapon slots), which is what makes
  // a re-bootstrap necessary after the 244 loop recreates a peer as a bare object.
  //
  // Opcode 95 (MAX health) is the deliberate exception. It is the divisor for the peer health bar
  // (bundle :52501, `m /= c.Qz8l93a.Qtgt1xt`), so on a rebuilt peer it was undefined and the bar
  // rendered NaN-wide — appearing irregularly and far too long. Streaming it every tick costs two
  // numbers and makes the bar correct even before the re-bootstrap lands.
  ok('a TICK body carries no identity — proving it cannot rebuild an entity',
    !has(tick, 210),
    'if a tick body could rebuild entities, no re-bootstrap would be needed');
  ok('but it does carry max health, so a rebuilt peer still gets a valid health bar',
    has(tick, 95), 'without it the bar divides by undefined');

  // And it must advertise the new map generation, or the client reloads again.
  ok('the bootstrap carries the current map generation',
    boot[boot.indexOf(8) + 1] === srv.match.mapGeneration, String(boot[boot.indexOf(8) + 1]));
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
