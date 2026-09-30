/**
 * test_counters.js — the Qvtrxln counters, spawn protection, and the streak/multikill emits.
 *
 * THE BUG CLASS
 * ─────────────
 * The client advances fifteen per-tick counters itself, unconditionally, in Wh.Qvtrxln:
 *
 *     Q3igok2--, Qv7w1q0--, Qalaptp--, Q5vx943--, Qcqj5jb++, Qezh4wz++, Qwx5aeh++,
 *     Qezdgca++, Qezbnmf++, Qwwc9lh++, Qpgzeeg++, Qd2e7ku++, Qett9p1++, Qwv47ix++, Qezc1on++
 *
 * The server calls the movement function g() directly rather than Qwhlcfo, so Qvtrxln never ran here
 * and six of those counters were frozen on our side while the client's copy climbed away every tick.
 * Two of the six have visible consequences:
 *
 *   Qalaptp (181) — SPAWN PROTECTION. The client enforces it in Q2ngzid (:34453, `if (Qalaptp > 0)
 *     return null`), so while it is positive the shooter's own client refuses to register the hit.
 *     Left at its -1 factory default and decremented for ever, it was never positive, so spawn
 *     protection did not exist for anyone.
 *
 *   Qett9p1 (196) — TICKS SINCE SPAWN. Below 2 the client draws a peer at its raw position instead
 *     of interpolating (:51860). Never reset, every respawn stayed on the lerp branch, so a peer
 *     visibly SLID across the map from where they died to where they respawned.
 *
 * And two that must NOT be emitted even though they drift: Qwx5aeh (147, burst window) and Qezdgca
 * (148, movement spread) are reset by paths the client simulates for itself and we do not implement,
 * so our value would overwrite a correct one with a wrong one.
 *
 * Usage:  node scripts/test_counters.js
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

// Read an opcode's value out of a flat player-entry array.
function opVal(arr, op) {
  for (let i = 0; i < arr.length - 1; i++) if (arr[i] === op) return arr[i + 1];
  return undefined;
}
// The decoder is ONE ascending forward scan, so an out-of-order opcode stalls the cursor and every
// later field in the entry is silently dropped. That makes ordering a correctness property.
function ascendingViolations(arr, ops) {
  const seen = ops.filter((o) => arr.includes(o)).map((o) => ({ op: o, at: arr.indexOf(o) }));
  const bad = [];
  for (let i = 1; i < seen.length; i++) if (seen[i].at < seen[i - 1].at) bad.push(`${seen[i - 1].op}@${seen[i - 1].at} before ${seen[i].op}@${seen[i].at}`);
  return bad;
}

(async () => {
  await bpw.ready;

  console.log('\n── the six unowned counters now advance ──');
  {
    const st = srv.createPlayerSimState();
    const ps = st._ps;
    ok('the player has an extracted physics state', !!ps, 'no _ps means the fallback sim');

    const before = {
      Qalaptp: ps.Qalaptp, Q5vx943: ps.Q5vx943, Qwx5aeh: ps.Qwx5aeh,
      Qezdgca: ps.Qezdgca, Qd2e7ku: ps.Qd2e7ku, Qett9p1: ps.Qett9p1,
    };
    // Every value must start FINITE — Qvtrxln's ++/-- on undefined yields NaN, and a NaN reaching
    // the client's position or a comparator field permanently bricks it.
    ok('all six start finite', Object.values(before).every(Number.isFinite),
      JSON.stringify(before));

    for (let i = 0; i < 5; i++) srv.integratePlayerSim(st, 0.05, i + 1);

    ok('Qalaptp counts DOWN', ps.Qalaptp === before.Qalaptp - 5,
      `${before.Qalaptp} -> ${ps.Qalaptp}`);
    ok('Q5vx943 counts DOWN', ps.Q5vx943 === before.Q5vx943 - 5,
      `${before.Q5vx943} -> ${ps.Q5vx943}`);
    ok('Qwx5aeh counts UP', ps.Qwx5aeh === before.Qwx5aeh + 5,
      `${before.Qwx5aeh} -> ${ps.Qwx5aeh}`);
    ok('Qett9p1 counts UP', ps.Qett9p1 === before.Qett9p1 + 5,
      `${before.Qett9p1} -> ${ps.Qett9p1}`);
    ok('nothing became NaN',
      [ps.Qalaptp, ps.Q5vx943, ps.Qwx5aeh, ps.Qezdgca, ps.Qd2e7ku, ps.Qett9p1].every(Number.isFinite),
      'a NaN here would reach the wire and brick the client');
  }

  console.log('\n── the counters that already had an owner are not advanced twice ──');
  {
    // Calling Wh.Qvtrxln wholesale would have been the tidy fix and is exactly wrong: nine of its
    // fifteen fields are maintained elsewhere in the server, and every one of those is a TIMER.
    // At 2x speed the weapon-switch timer, zoom transition and flash blind all end early.
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    // Comments stripped first — the code that replaces Qvtrxln necessarily talks about Qvtrxln.
    const code = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    ok('Qvtrxln is not called wholesale', !/Qvtrxln\s*\)?\s*\(/.test(code),
      'that would double-advance nine already-owned timers');
    for (const f of ['Q3igok2', 'Qcqj5jb', 'Qwv47ix', 'Qezc1on']) {
      const advancedHere = new RegExp(`ps\\.${f}(\\+\\+|--)\\s*;\\s*//\\s*1[0-9][0-9]`).test(src);
      ok(`${f} is not advanced in the Qvtrxln block`, !advancedHere,
        'it already has a server-side owner');
    }
  }

  console.log('\n── spawn protection exists, and both sides agree on it ──');
  {
    const want = S.list().find((x) => x.key === 'spawnProtectTicks');
    ok('spawnProtectTicks is a setting', !!want, 'operators need to be able to turn it off');
    ok('it defaults to the client own Qt2pzu8 (40 ticks = 2s)', want && want.value === 40,
      want ? String(want.value) : 'missing');

    const st = srv.createPlayerSimState();
    ok('a freshly created player IS protected', st._ps.Qalaptp > 0,
      `Qalaptp=${st._ps.Qalaptp} — joining is a spawn too`);

    // The whole point: the server must refuse damage on exactly the ticks the client refuses it.
    st.healthPoints = 1;
    srv.applyDamage(st, 0.5, null);
    ok('damage during protection is refused', st.healthPoints === 1,
      `hp=${st.healthPoints} — the client rejects it in Q2ngzid, so accepting it here is the `
      + 'double-damage snap-back bug');

    // ...and must stop refusing the moment it expires.
    st._ps.Qalaptp = 0;
    srv.applyDamage(st, 0.5, null);
    ok('damage after protection lands', st.healthPoints < 1, `hp=${st.healthPoints}`);
  }

  console.log('\n── protection expires by itself ──');
  {
    const st = srv.createPlayerSimState();
    const ticks = st._ps.Qalaptp;
    for (let i = 0; i < ticks; i++) srv.integratePlayerSim(st, 0.05, i + 1);
    ok('it is spent after exactly its own tick count', st._ps.Qalaptp <= 0,
      `Qalaptp=${st._ps.Qalaptp} after ${ticks} ticks`);
    st.healthPoints = 1;
    srv.applyDamage(st, 0.5, null);
    ok('and damage lands again', st.healthPoints < 1,
      `hp=${st.healthPoints} — permanent protection would be worse than none`);
  }

  console.log('\n── disabling it uses the client -1, not 0 ──');
  {
    // Qalaptp is compared with `> 0`, so 0 also means unprotected — but the client's own default is
    // -1 and it decrements every tick regardless. Seeding 0 would drift to -1, -2… identically, so
    // this is about matching the client exactly rather than about behaviour.
    const prev = S.get('spawnProtectTicks');
    S.set('spawnProtectTicks', 0, 'test');
    const st = srv.createPlayerSimState();
    ok('protection off seeds -1', st._ps.Qalaptp === -1, String(st._ps.Qalaptp));
    st.healthPoints = 1;
    srv.applyDamage(st, 0.5, null);
    ok('and damage is not blocked', st.healthPoints < 1, `hp=${st.healthPoints}`);
    S.set('spawnProtectTicks', prev, 'test');
  }

  console.log('\n── the emits are present, in ascending order ──');
  {
    const st = srv.createPlayerSimState();
    st.killStreak = 4; st.multiKill = 3;
    // 228/229 (and 214/215/216/226) are send-on-change (see test_stats_send_window.js) — open the
    // window explicitly since this direct appendPlayerTickBody call bypasses the _cachedPlayerBlock
    // change-detection that normally does it.
    st._statsSendCount = 1;
    const body = [];
    srv.appendPlayerTickBody(body, 'p1', st);

    ok('181 carries the live protection value', opVal(body, 181) === st._ps.Qalaptp,
      `emitted ${opVal(body, 181)} vs ps ${st._ps.Qalaptp}`);
    ok('196 carries ticks-since-spawn', opVal(body, 196) === st._ps.Qett9p1,
      `emitted ${opVal(body, 196)} vs ps ${st._ps.Qett9p1}`);
    ok('190 carries ticks-since-landing', opVal(body, 190) === st._ps.Qd2e7ku,
      `emitted ${opVal(body, 190)} vs ps ${st._ps.Qd2e7ku}`);
    ok('228 carries the kill streak', opVal(body, 228) === 4, String(opVal(body, 228)));
    ok('229 carries the multikill', opVal(body, 229) === 3, String(opVal(body, 229)));

    const bad = ascendingViolations(body, [176, 181, 185, 188, 190, 196, 197, 227, 228, 229]);
    ok('the new opcodes do not break the ascending scan', bad.length === 0, bad.join('; '));

    // 227 used to be last and is documented as such; 228/229 now follow it.
    ok('228/229 come after 227', body.indexOf(228) > body.indexOf(227)
      && body.indexOf(229) > body.indexOf(228),
      `227@${body.indexOf(227)} 228@${body.indexOf(228)} 229@${body.indexOf(229)}`);
  }

  console.log('\n── 147/148/182 are deliberately withheld ──');
  {
    // Emitting a counter whose RESET we do not implement is worse than silence: the client's value is
    // correct (it simulates its own fire and movement) and ours would overwrite it on reconcile.
    const st = srv.createPlayerSimState();
    const body = [];
    srv.appendPlayerTickBody(body, 'p1', st);
    ok('147 (burst window) is not emitted', opVal(body, 147) === undefined,
      'the server has no burst-fire implementation to reset it');
    ok('148 (movement spread) is not emitted', opVal(body, 148) === undefined,
      'the client resets it from its own movement');
    ok('182 (join countdown) is not emitted', opVal(body, 182) === undefined,
      'there is no spectator queue, and -1 cannot drift from -1');
  }

  console.log('\n── the bootstrap agrees with the tick stream ──');
  {
    // A bootstrap IS a spawn. It used to hardcode -1, telling everyone a joining player was exposed
    // for the frame before the first tick body disagreed.
    const sb = require('../state_builder');
    const body = sb.buildFirstSpawnBody({ playerId: 'p1', spawnProtectTicks: 40 });
    ok('the bootstrap carries the passed protection', opVal(body, 181) === 40,
      String(opVal(body, 181)));
    const dflt = sb.buildFirstSpawnBody({ playerId: 'p1' });
    ok('and falls back to -1 when not given one', opVal(dflt, 181) === -1,
      String(opVal(dflt, 181)));

    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    ok('both bootstrap call sites pass it',
      (src.match(/spawnProtectTicks: _psOf\(/g) || []).length === 2,
      'the peer intro and the self bootstrap');
  }

  console.log('\n── a respawn resets what a respawn should ──');
  {
    const st = srv.createPlayerSimState();
    // Age the player, then respawn.
    for (let i = 0; i < 30; i++) srv.integratePlayerSim(st, 0.05, i + 1);
    ok('the counters have aged', st._ps.Qett9p1 >= 30 && st._ps.Qalaptp < 40,
      `Qett9p1=${st._ps.Qett9p1} Qalaptp=${st._ps.Qalaptp}`);

    srv.applySpawnCounters(st._ps);
    ok('Qett9p1 returns to 0', st._ps.Qett9p1 === 0,
      `${st._ps.Qett9p1} — this is what stops the peer sliding across the map`);
    ok('protection is granted again', st._ps.Qalaptp === 40, String(st._ps.Qalaptp));

    // The reset must survive the very next tick's advance, i.e. still be < 2 on the spawn tick.
    srv.integratePlayerSim(st, 0.05, 99);
    ok('the spawn tick is still inside the no-interpolation window', st._ps.Qett9p1 < 2,
      `Qett9p1=${st._ps.Qett9p1} — at >= 2 the client lerps and the slide is back`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
