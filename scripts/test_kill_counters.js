/**
 * test_kill_counters.js — opcodes 227 (Qezc1on) and 175 (Q13f0sb).
 *
 * THE BUG
 * ───────
 * Most opcodes are safe to omit: absent means "unchanged". A handful are not. 227 decodes as
 *
 *     227 === n[a] ? (Qezc1on = n[++a], a++) : Qezc1on++
 *
 * so omitting it is an implicit INCREMENT, every tick, forever. Qezc1on is ticksSinceKill, and the
 * client free-ran it — climbing without bound and never resetting on a kill. Both consumers desynced:
 *
 *     Qezc1on < Qph2e3n                       -> the multikill chain window (MULTIKILL_WINDOW)
 *     Qezc1on === regenXTicksAfterKill        -> sets Q13f0sb, the heal-on-kill trigger
 *
 * Q13f0sb (175) is the boolean the client ORs into its heal condition:
 *     hp < max && !dead && ... && (ticksSinceDamage > delay || Q13f0sb)
 * We own both halves in tickHealthRegen, so both must be streamed.
 *
 * ORDERING. The client decodes a player entry with ONE strictly-ascending forward scan, so 175 has to
 * land between 174 and 176 — both of which live inside the conditional _pendingHit block. Emitting it
 * after that block stalls the cursor on any tick a player was hit, which does not merely drop later
 * fields: the enclosing 244 loop never reaches the next player either, so ALL peers stop decoding.
 * That is why this test checks order on a hit tick as well as a quiet one.
 *
 * Usage:  node scripts/test_kill_counters.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const mk = () => {
  const p = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'p');
  p.healthPoints = 1; p.armorPoints = 0; p.deathStateTimer = 0;
  p.kills = 0; p.deaths = 0; p.score = 0; p.assists = 0;
  p.ticksSinceDamage = 99999; p.ticksSinceKill = 7; p.forceRegen = false;
  return p;
};
const bodyFor = (p) => { const b = []; srv.appendPlayerTickBody(b, 'p', p); return b; };
const valueOf = (b, op) => { const i = b.indexOf(op); return i === -1 ? undefined : b[i + 1]; };

// Opcodes whose payload is a sub-mode byte then 1..3 floats — the next number is NOT an opcode.
// Every vector field in a player entry, or the walk mistakes a coordinate for an opcode.
const VEC = { 136: 1, 137: 1, 176: 1, 178: 1, 179: 1, 180: 1, 211: 1 };
// How many floats follow each sub-mode byte, from the decoder's switch:
//   0 xyz · 1 yz · 2 xz · 3 z · 4 xy · 5 y · 6 x
const VEC_LEN = { 0: 3, 1: 2, 2: 2, 3: 1, 4: 2, 5: 1, 6: 1 };
// Walk the top-level entry the way the client's scan does, returning the opcode sequence. The 135
// weaponSlots sub-loop has to be stepped OVER, not stopped at, or the walk never reaches the fields
// this test is about — entries are `135, id, 132, v, 133, v, 134, v` or the delete form `135, -1, id`.
function opcodeSeq(b) {
  const seq = [];
  let i = 2;                                  // skip 244, key
  while (i < b.length) {
    const op = b[i];
    if (typeof op !== 'number' || !Number.isInteger(op)) break;
    if (op === 135) {
      while (b[i] === 135) {
        if (b[i + 1] === -1) { i += 3; continue; }   // delete entry
        i += 2;                                     // 135, slotId
        while (b[i] === 132 || b[i] === 133 || b[i] === 134) i += 2;
      }
      continue;                                     // resume the top-level scan after the loop
    }
    seq.push(op);
    if (VEC[op]) { const n = VEC_LEN[b[i + 1]]; i += 2 + (n === undefined ? 3 : n); }
    else i += 2;
  }
  return seq;
}

console.log('\n── 227 carries ticksSinceKill ──');
{
  const p = mk();
  p.ticksSinceKill = 42;
  ok('227 is present', bodyFor(p).includes(227),
    'omitting it makes the client increment its own copy every tick');
  ok('and carries the real value', valueOf(bodyFor(p), 227) === 42, String(valueOf(bodyFor(p), 227)));
  p.ticksSinceKill = 0;
  ok('a fresh kill streams 0', valueOf(bodyFor(p), 227) === 0);
}

console.log('\n── 227 is always a sane number ──');
{
  // The client does arithmetic against it; NaN/undefined would poison the multikill comparison.
  const p = mk();
  p.ticksSinceKill = undefined;
  ok('undefined becomes 0', valueOf(bodyFor(p), 227) === 0);
  p.ticksSinceKill = NaN;
  ok('NaN becomes 0', valueOf(bodyFor(p), 227) === 0);
  p.ticksSinceKill = -5;
  ok('negatives are clamped', valueOf(bodyFor(p), 227) === 0);
}

console.log('\n── 175 carries forceRegen ──');
{
  const p = mk();
  ok('present when false', bodyFor(p).includes(175));
  ok('and is false', valueOf(bodyFor(p), 175) === false, String(valueOf(bodyFor(p), 175)));
  p.forceRegen = true;
  ok('true after the kill-heal trigger', valueOf(bodyFor(p), 175) === true);
  ok('it is a real boolean, not 1/0',
    typeof valueOf(bodyFor(p), 175) === 'boolean', typeof valueOf(bodyFor(p), 175));
}

console.log('\n── the scan stays strictly ascending ──');
{
  const check = (label, p) => {
    const seq = opcodeSeq(bodyFor(p));
    let bad = null;
    for (let i = 1; i < seq.length; i++) if (seq[i] <= seq[i - 1]) { bad = `${seq[i]} after ${seq[i - 1]}`; break; }
    ok(label, bad === null, bad || '');
  };
  check('quiet tick', mk());

  // The hit tick is the one that matters: 175 must sit BETWEEN 174 and 176.
  const hit = mk();
  hit._pendingHit = { attackerSid: 'x', dmg: 0.3, wpnType: 1, headshot: false, src: { x: 1, y: 2, z: 3 } };
  check('hit tick (170-176 block present)', hit);

  const seq = opcodeSeq(bodyFor(hit));
  const i174 = seq.indexOf(174), i175 = seq.indexOf(175), i176 = seq.indexOf(176);
  ok('175 lands between 174 and 176', i174 !== -1 && i175 > i174 && i175 < i176,
    `174@${i174} 175@${i175} 176@${i176}`);
  ok('175 appears exactly once on a hit tick',
    seq.filter((o) => o === 175).length === 1,
    'it is emitted in both branches of the _pendingHit spread — never both at once');
}

console.log('\n── the tail of the entry stays in ascending order ──');
{
  // This used to assert 227 was the highest opcode in the entry. That was only ever a proxy for the
  // property that matters — the decoder is one ascending forward scan, so a field out of order
  // stalls the cursor and silently drops everything after it. 228 (kill streak) and 229 (multikill)
  // now follow 227, so assert the ordering directly instead of a maximum that any new field breaks.
  const seq = opcodeSeq(bodyFor(mk()));
  const tail = [226, 227, 228, 229].filter((o) => seq.includes(o));
  const positions = tail.map((o) => seq.indexOf(o));
  ok('226 -> 227 -> 228 -> 229 are strictly ascending',
    positions.every((p, i) => i === 0 || p > positions[i - 1]),
    tail.map((o, i) => `${o}@${positions[i]}`).join(' '));
  // 214-216/226/228/229 are now send-on-change (see STATS_SEND_RELIABILITY_TICKS /
  // _updateStatsSendWindow) — that bookkeeping runs in _cachedPlayerBlock, which bodyFor's direct
  // appendPlayerTickBody call deliberately bypasses (same as production's own buildTickBody fallback
  // path when built without peerSessions), so this fresh, never-window-updated playerState correctly
  // never emits them. 227 is unconditional every tick regardless, so it is the true ceiling here —
  // the property this assertion actually cares about (nothing appears OUT of order) is already
  // covered by the ascending check above; see test_stats_send_window.js for the send-on-change
  // mechanism itself.
  ok('227 is the highest UNCONDITIONAL opcode in the entry (214-216/226/228/229 are send-on-change)',
    Math.max(...seq) === 227, String(Math.max(...seq)));
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
