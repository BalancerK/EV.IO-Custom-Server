/**
 * test_peer_identity.js — a lost peer introduction must not leave that peer broken for the match.
 *
 * Over WebRTC the packet that introduces a peer (its bootstrap: name, weapon, team, bot flag,
 * attributes) rides the lossy channel. If it is lost, the client builds the peer from per-tick blocks
 * alone. Those blocks now carry the peer's identity fields through the delta filter, so:
 *   - a client that never got the introduction has the peer's name, weapon, uid, bot flag and
 *     attributes after one full refresh;
 *   - they cost nothing between refreshes (not resent while unchanged);
 *   - every block stays in ascending opcode order (the client decodes with one forward scan);
 *   - a weapon switch reaches the client even outside the switch's own send window.
 *
 * Usage:  node scripts/test_peer_identity.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_CLICK_TO_PLAY = '0';
const srv = require('../local_ws_server');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

// The peer's block inside a tick body, as { fields: Map(key -> tokens json), ops: [op...] }.
function peerBlock(body, eid) {
  let i = body.indexOf(244);
  while (i >= 0 && i < body.length) {
    let j = i + 2;
    while (j < body.length && body[j] !== 244 && body[j] !== 280) j++;
    let blk = body.slice(i, j), split = srv._splitPlayerBlock(blk);
    while (!split && j < body.length) { j++; while (j < body.length && body[j] !== 244 && body[j] !== 280) j++; blk = body.slice(i, j); split = srv._splitPlayerBlock(blk); }
    if (blk[1] === eid) return { fields: new Map(split.map((f) => [f.key, JSON.stringify(f.tokens)])), ops: split.map((f) => parseInt(f.key, 10)) };
    i = j < body.length && body[j] === 244 ? j : -1;
  }
  return null;
}

const sessions = new Map();
for (const [id, name, weapon] of [['pa', 'Alice', 4], ['pb', 'Bob', 262]]) {
  const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, id);
  ps.equippedWeaponId = weapon;
  sessions.set(id, { playerId: id, sessionId: id, accepted: true, isBot: id === 'pb', playerState: ps,
    displayName: name, uid: id === 'pa' ? 1234 : 17, weaponId: weapon, _deltaPhase: 3 });
}
const pa = sessions.get('pa');
const intro = srv._splitPlayerBlock(srv.buildPeerBootstrapDelta(sessions.get('pb')));
const introOf = (op) => { const f = intro.find((x) => x.key === String(op)); return f && JSON.stringify(f.tokens); };

console.log('\n── pa never receives pb\'s introduction ──');
const client = new Map();   // what pa's client knows about pb (set fields only)
let firstHaveAll = null, steadyIdentityTicks = 0, orderOk = true, orderBad = '';
const want = [210, 212, 231, 237, 127, 110, 121];
for (let tick = 2000; tick < 2045; tick++) {
  const ctx = srv.makeDeltaContext(pa, tick);
  const body = srv.buildTickBody('pa', tick, pa.playerState, sessions, ctx);
  srv.commitDeltaContext(ctx);
  const blk = peerBlock(body, 'pb');
  if (!blk) continue;
  if (tick < 2008) continue;   // sent, but lost on the way: the introduction and the first changes
  for (let k = 1; k < blk.ops.length; k++) if (blk.ops[k] < blk.ops[k - 1]) { orderOk = false; orderBad = `${blk.ops[k - 1]} before ${blk.ops[k]} @${tick}`; }
  for (const [k, v] of blk.fields) client.set(k, v);
  if (blk.fields.has('210')) steadyIdentityTicks++;   // each player refreshes on its own tick (deltaSpreadRefresh)
  if (firstHaveAll === null && want.every((op) => client.has(String(op)))) firstHaveAll = tick - 2008;
}
ok(`name, uid, bot flag, weapon and attributes arrive without the introduction (tick +${firstHaveAll})`,
  firstHaveAll !== null && firstHaveAll <= 20 + 4);
ok('they match what the introduction says', [210, 212, 231, 237, 110, 121].every((op) => client.get(String(op)) === introOf(op)),
  [210, 212, 231, 237].map((op) => `${op}: ${client.get(String(op))} vs ${introOf(op)}`).join(', '));
ok('the weapon is the one actually equipped', client.get('127') === JSON.stringify([127, 262]), client.get('127'));
ok(`identity goes out only on pb's refreshes while unchanged (${steadyIdentityTicks} of 37 ticks)`, steadyIdentityTicks <= 2, `${steadyIdentityTicks} ticks`);
ok('every peer block stays in ascending opcode order', orderOk, orderBad);

console.log('\n── pb switches weapon with no switch send window ──');
{
  const pb = sessions.get('pb').playerState;
  pb.equippedWeaponId = 4; pb.weaponSendCount = 0;
  const tick = 2050;
  const ctx = srv.makeDeltaContext(pa, tick);
  const body = srv.buildTickBody('pa', tick, pa.playerState, sessions, ctx);
  srv.commitDeltaContext(ctx);
  const blk = peerBlock(body, 'pb');
  ok('the new weapon goes out on the next tick', blk && blk.fields.get('127') === JSON.stringify([127, 4]), blk && blk.fields.get('127'));
}

console.log('\n── the recipient\'s own block is unchanged ──');
{
  const tick = 2060;
  const ctx = srv.makeDeltaContext(pa, tick);
  const body = srv.buildTickBody('pa', tick, pa.playerState, sessions, ctx);
  const self = peerBlock(body, 'pa');
  ok('no identity fields added to the local player', self && !self.fields.has('210') && !self.fields.has('231'));
}

console.log(`\n${'─'.repeat(60)}\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
