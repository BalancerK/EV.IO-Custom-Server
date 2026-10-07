/**
 * test_medals.js — medal popups.
 *
 * Scoring alone was never enough. Qmblb53 adds the points AND returns a medal object which the
 * client renders as the popup; we were doing the first half only, so score climbed while nothing
 * appeared on screen.
 *
 * Medals travel in Qp29ls8.Qfw5vdx, which is NOT the map hit events use:
 *   opcode 67 -> Qp29ls8.Qh8gbjd   (hit events)
 *   opcode 74 -> Qp29ls8.Qfw5vdx   (medals)
 * A medal entry is  74 key · 69 Q7q6byi · 70 Q616y7o · 71 Qwihvgr (recipient) ·
 * 72 Qwhr325 (medal key string) · 73 Qflcwh7 (points).
 *
 * The client runs the 67 loop before the 74 loop in one ascending pass, so hit events must be
 * emitted before medals or the scan stalls.
 *
 * Every key/score below was read from Qkkc81w and matches MEDAL_SCORE exactly.
 *
 * Usage:  node scripts/test_medals.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
// This test inflicts damage/kills directly on playerStates built via createPlayerSimState, with
// no "enter the match" step in between — applyDamage correctly REFUSES all damage for a held
// player ("Hold new players until they click to play", now the default — see its own
// "_holdForPlay" early-return comment), so every medal/score assertion here would silently no-op
// without this. Real, correct behavior, just not what this file tests (medal/scoring bookkeeping
// once a player IS in the match).
process.env.EVIO_CLICK_TO_PLAY = process.env.EVIO_CLICK_TO_PLAY || '0';
const srv = require('../local_ws_server');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
// REAL player states, not hand-rolled mocks. The first version of this test used objects with an
// `.id` field; production playerStates have no such field (the client keys players by _ownerSid,
// passed separately to the 244 block), so every medal shipped with recipient=undefined and the
// test passed while nothing rendered in game. Build them the way the server does.
const mk = (id) => {
  const p = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, id);
  p.healthPoints = 1; p.armorPoints = 0; p.deathStateTimer = 0;
  p.kills = 0; p.deaths = 0; p.score = 0; p.assists = 0;
  p.ticksSinceDamage = 99999; p.ticksSinceKill = 99999; p.forceRegen = false;
  return p;
};
const reset = () => { srv._pendingMedals.length = 0; };
// Read medal entries back off the wire.
function medalsOnWire() {
  const b = srv.buildPlayerMapBlock();
  const out = [];
  for (let i = 0; i < b.length; i++) {
    if (b[i] === 74 && (i === 0 || b[i - 1] !== 74)) {
      out.push({ key: b[i + 1], id: b[i + 3], zero: b[i + 5],
                 recipient: b[i + 7], medal: b[i + 9], points: b[i + 11] });
    }
  }
  return out;
}

console.log('\n── the key map matches the bundle table ──');
{
  const expect = {
    kill: 'Qwhr33n', headshot: 'Qh04ltj', sword: 'Qcq3jgy', sticky: 'Qvnv1p4',
    frag: 'Qwhu3mn', mine: 'Qwhpt32', tripmine: 'Qqfl31j', longshot: 'Qwuvmcb',
    assist: 'Qn4okig',
  };
  for (const k of Object.keys(expect)) {
    ok(`${k} -> ${expect[k]}`, srv.MEDAL_KEY[k] === expect[k], String(srv.MEDAL_KEY[k]));
  }
  ok('every scored medal has a client key',
    Object.keys(expect).every((k) => !!srv.MEDAL_KEY[k]));
}

console.log('\n── a kill emits one medal per award, not one lump ──');
{
  reset();
  const B = mk('B'), V = mk('V');
  srv.applyDamage(V, 2.0, B, { headshot: true, weaponMedal: 'sword' });
  const m = medalsOnWire();
  ok('three separate medals', m.length === 3, String(m.length));
  ok('+1 Kill (100)', m.some((x) => x.medal === 'Qwhr33n' && x.points === 100));
  ok('Headshot (10)', m.some((x) => x.medal === 'Qh04ltj' && x.points === 10));
  ok('Sword Kill (20)', m.some((x) => x.medal === 'Qcq3jgy' && x.points === 20));
  ok('all credited to the killer', m.every((x) => x.recipient === 'B'));
  ok('and the score is their sum', B.score === 130, String(B.score));
}

console.log('\n── a guest is worth the same as a signed-in player ──');
{
  // Official ev.io pays 0.3x for killing a GUEST (Q4b9iia.Qeoxvpg) to stop people farming score off
  // throwaway accounts. On a private server that only means the friends who did not sign in are worth
  // a third as much, so the default here is 1.0. There was NO coverage of this before, in either
  // direction — the multiplier was a bare constant.
  const S = require('../settings');
  ok('the guest multiplier defaults to fair', S.get('guestScoreMultiplier') === 1,
    String(S.get('guestScoreMultiplier')));

  reset();
  const B = mk('B'), G = mk('G');
  srv.applyDamage(G, 2.0, B, { headshot: true, victimUid: 17 });   // 17 = GUEST_UID
  const guestKill = medalsOnWire();
  ok('killing a guest pays the full kill medal',
    guestKill.some((x) => x.medal === 'Qwhr33n' && x.points === 100),
    JSON.stringify(guestKill.map((x) => `${x.medal}:${x.points}`)));
  ok('and the full headshot bonus',
    guestKill.some((x) => x.medal === 'Qh04ltj' && x.points === 10),
    'a 0.3x headshot rounds to 3, which is what players noticed');
  ok('the score matches a normal kill', B.score === 110, String(B.score));

  // Same kill against a signed-in account, for a direct comparison rather than a remembered number.
  reset();
  const B2 = mk('B2'), A = mk('A2');
  srv.applyDamage(A, 2.0, B2, { headshot: true, victimUid: 1234 });
  ok('identical to killing an account player', B2.score === B.score,
    `guest=${B.score} account=${B2.score}`);
}

console.log('\n── ...but the official penalty is still available ──');
{
  // Fair-by-default is a choice, not a loss of the official behaviour: a server that wants the public
  // game's anti-farming rule should be able to have it.
  const S = require('../settings');
  const prev = S.get('guestScoreMultiplier');
  S.set('guestScoreMultiplier', 0.3, 'test');
  reset();
  const B = mk('B'), G = mk('G');
  srv.applyDamage(G, 2.0, B, { headshot: true, victimUid: 17 });
  const m = medalsOnWire();
  ok('0.3 restores the official kill value',
    m.some((x) => x.medal === 'Qwhr33n' && x.points === 30),
    JSON.stringify(m.map((x) => `${x.medal}:${x.points}`)));
  ok('rounding matches the client (10 * 0.3 -> 3)',
    m.some((x) => x.medal === 'Qh04ltj' && x.points === 3),
    'Qmblb53 rounds after each multiply');
  S.set('guestScoreMultiplier', prev, 'test');
}

console.log('\n── a bot is still not worth a person ──');
{
  // Making guests fair must not accidentally pay full price for a bot — they are separate settings.
  const S = require('../settings');
  ok('the bot multiplier keeps the official 0.3', S.get('botScoreMultiplier') === 0.3,
    String(S.get('botScoreMultiplier')));
  reset();
  const B = mk('B'), Bot = mk('Bot');
  Bot.isBot = true;
  srv.applyDamage(Bot, 2.0, B, { victimUid: 1234 });
  const m = medalsOnWire();
  ok('killing a bot still pays 30', m.some((x) => x.medal === 'Qwhr33n' && x.points === 30),
    JSON.stringify(m.map((x) => `${x.medal}:${x.points}`)));
}

console.log('\n── an assist announces itself too ──');
{
  reset();
  const A = mk('A'), B = mk('B'), V = mk('V');
  srv.applyDamage(V, 0.3, A, {});
  srv.applyDamage(V, 2.0, B, {});
  const m = medalsOnWire();
  const assist = m.find((x) => x.medal === 'Qn4okig');
  ok('the assist medal is emitted', !!assist);
  ok('to the assister, not the killer', assist && assist.recipient === 'A', assist && assist.recipient);
  ok('worth 10', assist && assist.points === 10, assist && String(assist.points));
}

console.log('\n── wire shape ──');
{
  reset();
  const B = mk('B'), V = mk('V');
  srv.applyDamage(V, 2.0, B, {});
  const b = srv.buildPlayerMapBlock();
  ok('entries start at opcode 74 (Qfw5vdx), not 67 (Qh8gbjd)',
    b.includes(74), '67 is the hit-event map — a medal sent there is silently ignored');
  const m = medalsOnWire()[0];
  ok('69 carries the entry id', m && m.id === m.key);
  ok('70 is 0', m && m.zero === 0);
  ok('71/72/73 are recipient/medal/points',
    m && m.recipient === 'B' && m.medal === 'Qwhr33n' && m.points === 100);
  // The recipient must equal the id the client keys players by — the 244 block's key. Sending
  // anything else (playerState has no `.id`) leaves the medal unmatched and silently unrendered.
  const pb = [];
  srv.appendPlayerTickBody(pb, 'B', B);
  const key244 = pb[pb.indexOf(244) + 1];
  ok('the recipient matches the 244 player key', m && m.recipient === key244,
    `medal=${m && m.recipient} 244=${key244}`);
  ok('and it is not undefined', m && m.recipient != null, String(m && m.recipient));
  // The client decodes the 67 loop then the 74 loop in one ascending pass.
  const last67 = b.lastIndexOf(67), first74 = b.indexOf(74);
  ok('hit events precede medals', last67 === -1 || last67 < first74,
    `67@${last67} 74@${first74}`);
}

console.log('\n── the queue drains, so medals fire once ──');
{
  reset();
  const B = mk('B'), V = mk('V');
  srv.applyDamage(V, 2.0, B, {});
  ok('queued after the kill', srv._pendingMedals.length === 1, String(srv._pendingMedals.length));
  srv._pendingMedals.length = 0;                 // stands in for the post-broadcast clear
  ok('cleared for the next tick', medalsOnWire().length === 0);
}

console.log('\n── a suicide announces nothing ──');
{
  reset();
  const S = mk('S');
  srv.applyDamage(S, 2.0, S, {});
  ok('no medal for killing yourself', medalsOnWire().length === 0,
    String(medalsOnWire().length));
}

console.log('\n── conditional medals ──');
{
  const kill = (A, V, opts) => { V.healthPoints = 1; V.deathStateTimer = 0; srv.applyDamage(V, 2.0, A, opts || {}); };
  const medals = () => medalsOnWire().map((m) => m.medal);

  // Longshot: Qkkc81w.Qwuvmcb.Qyz05ae = 65 units.
  reset(); const A = mk('A'), V = mk('V');
  kill(A, V, { dist: 80 });
  ok('longshot past 65 units', medals().includes('Qwuvmcb'), medals().join(','));
  reset(); kill(A, V, { dist: 64 });
  ok('but not at 64', !medals().includes('Qwuvmcb'));

  // Kill From The Grave: the killer was already dead.
  reset(); const G = mk('G'), V2 = mk('V2'); G.healthPoints = 0;
  kill(G, V2, {});
  ok('kill from the grave when the killer is dead', medals().includes('Qcwsjt6'));
  reset(); const H = mk('H'); kill(H, V2, {});
  ok('not awarded when alive', !medals().includes('Qcwsjt6'));

  // Noscope: scoped weapon, fired unscoped, not melee.
  reset(); const N = mk('N'), V3 = mk('V3');
  kill(N, V3, { noDefaultCrosshair: true, melee: false, zooming: false });
  ok('noscope with a scoped weapon fired hip', medals().includes('Ql8t342'));
  reset(); kill(N, V3, { noDefaultCrosshair: true, melee: false, zooming: true });
  ok('not while aiming down sights', !medals().includes('Ql8t342'));
  reset(); kill(N, V3, { noDefaultCrosshair: true, melee: true, zooming: false });
  ok('and melee is excluded (the sword also sets noDefaultCrosshair)',
    !medals().includes('Ql8t342'));

  // Usurper: victim led on kills, and it takes more than 2 players.
  reset(); const U = mk('U'), L = mk('L');
  kill(U, L, { victimWasLeader: true, playerCount: 4 });
  ok('usurper for killing the leader', medals().includes('Qc74s4x'));
  reset(); kill(U, L, { victimWasLeader: true, playerCount: 2 });
  ok('not in a duel', !medals().includes('Qc74s4x'));
}

console.log('\n── multikill chains ──');
{
  const kill = (A, V, opts) => { V.healthPoints = 1; V.deathStateTimer = 0; srv.applyDamage(V, 2.0, A, opts || {}); };
  reset(); const C = mk('C'), X = mk('X');
  const seen = [];
  for (let i = 0; i < 4; i++) { C.ticksSinceKill = 10; kill(C, X, {}); }
  const got = medalsOnWire().map((m) => m.medal);
  ok('double at 2', got.includes('Qlnn3me'));
  ok('multi at 3', got.includes('Qlnn3md'));
  ok('ultra at 4', got.includes('Qlnn3mc'));
  ok('monster at 5', got.includes('Qlnn3mb'));

  // A slow kill restarts the chain.
  reset(); const D = mk('D'), Y = mk('Y');
  D.ticksSinceKill = 10; kill(D, Y, {});
  D.ticksSinceKill = 99999; kill(D, Y, {});
  ok('a gap longer than the window resets the chain',
    !medalsOnWire().map((m) => m.medal).includes('Qlnn3md'), 'should not reach Multi Kill');
}

console.log('\n── killstreaks ──');
{
  const kill = (A, V) => { V.healthPoints = 1; V.deathStateTimer = 0; srv.applyDamage(V, 2.0, A, {}); };
  reset(); const E = mk('E'), Z = mk('Z');
  for (let i = 0; i < 5; i++) { E.ticksSinceKill = 99999; kill(E, Z); }
  ok('killing spree at 5', medalsOnWire().map((m) => m.medal).includes('Qvltnhr'));
  ok('the streak is tracked', E.killStreak === 5, String(E.killStreak));

  // Dying breaks it.
  srv.applyDamage(E, 2.0, mk('K'), {});
  ok('dying resets the streak', E.killStreak === 0, String(E.killStreak));
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
