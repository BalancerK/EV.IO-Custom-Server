/**
 * test_assists.js — assists, ported from the bundle's Q6q147v (:33538-33547).
 *
 *   var s = worldTick - 100, l = damageLog(victim).Qny6qak;
 *   for (var u in l)
 *     if (u !== victim.id && u !== killerId && l[u] >= s) { medal(Qn4okig); assists++ }
 *
 * So an assist is purely "did you damage them recently" — no damage threshold, one hit inside the
 * window is enough. The victim and the killer are both excluded. The Assist medal
 * (Qkkc81w.Qn4okig.Qcqgb7h) is worth 10, the same as a headshot.
 *
 * The scoreboard column rides opcode 226, which the client decodes AFTER 214/215/216 in its single
 * ascending scan — so it must be emitted last in the player block or the scan stalls and every
 * later player goes missing.
 *
 * Usage:  node scripts/test_assists.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');
const settings = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const mk = (id) => ({
  id, healthPoints: 1, armorPoints: 0, deathStateTimer: 0,
  kills: 0, deaths: 0, score: 0, assists: 0,
  ticksSinceDamage: 99999, ticksSinceKill: 99999, forceRegen: false,
});
const WINDOW = settings.list().find((x) => x.key === 'assistWindowTicks').value;

console.log('\n── the assister gets credit, the killer does not ──');
{
  const A = mk('A'), B = mk('B'), V = mk('V');
  srv.applyDamage(V, 0.4, A, {});     // A softens the victim
  srv.applyDamage(V, 2.0, B, {});     // B finishes
  ok('the victim died', V.deathStateTimer > 0);
  ok('A is credited with an assist', A.assists === 1, String(A.assists));
  ok('A scores the 10-point Assist medal', A.score === 10, String(A.score));
  ok('B gets the kill, not an assist', B.kills === 1 && B.assists === 0,
    `kills=${B.kills} assists=${B.assists}`);
  ok('the victim never assists its own death', V.assists === 0);
}

console.log('\n── a solo kill awards nothing ──');
{
  const C = mk('C'), W = mk('W');
  srv.applyDamage(W, 2.0, C, {});
  ok('no assist for the only attacker', C.assists === 0, String(C.assists));
}

console.log('\n── several assisters all get credit ──');
{
  const A = mk('A'), B = mk('B'), C = mk('C'), V = mk('V');
  srv.applyDamage(V, 0.2, A, {});
  srv.applyDamage(V, 0.2, B, {});
  srv.applyDamage(V, 2.0, C, {});
  ok('both softeners are credited', A.assists === 1 && B.assists === 1,
    `A=${A.assists} B=${B.assists}`);
  ok('each scores 10', A.score === 10 && B.score === 10);
  ok('the finisher is excluded', C.assists === 0);
}

console.log('\n── repeated hits from one player are still ONE assist ──');
{
  const A = mk('A'), B = mk('B'), V = mk('V');
  for (let i = 0; i < 5; i++) srv.applyDamage(V, 0.05, A, {});
  srv.applyDamage(V, 2.0, B, {});
  ok('five hits award a single assist', A.assists === 1, String(A.assists));
}

console.log('\n── damage older than the window stops counting ──');
{
  ok('the window is the bundle\'s 100 ticks (5s)', WINDOW === 100, String(WINDOW));
  const A = mk('A'), B = mk('B'), V = mk('V');
  srv.applyDamage(V, 0.3, A, {});
  // Age A's entry beyond the window by rewriting its recorded tick.
  for (const [k] of V._damagedBy) V._damagedBy.set(k, -(WINDOW + 10));
  srv.applyDamage(V, 2.0, B, {});
  ok('stale damage earns no assist', A.assists === 0, String(A.assists));
}

console.log('\n── the damage log is per life ──');
{
  const A = mk('A'), B = mk('B'), V = mk('V');
  srv.applyDamage(V, 0.3, A, {});
  srv.applyDamage(V, 2.0, B, {});
  ok('A assisted once', A.assists === 1);
  // V dies again with only B involved; A must not be credited a second time.
  V.healthPoints = 1; V.deathStateTimer = 0;
  srv.applyDamage(V, 2.0, B, {});
  ok('the previous life does not carry over', A.assists === 1, String(A.assists));
}

console.log('\n── the scoreboard column reaches the wire ──');
{
  const p = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'w');
  p.assists = 7;
  // 226 (and 214/215/216/228/229) are send-on-change (see test_stats_send_window.js) — open the
  // window explicitly since this direct appendPlayerTickBody call bypasses the _cachedPlayerBlock
  // change-detection that normally does it.
  p._statsSendCount = 1;
  const body = [];
  srv.appendPlayerTickBody(body, 'w', p);
  let idx = -1;
  for (let i = 0; i < body.length - 1; i++) if (body[i] === 226 && body[i - 1] !== 226) { idx = i; break; }
  ok('opcode 226 carries the assist count', idx >= 0 && body[idx + 1] === 7,
    idx < 0 ? 'not emitted' : String(body[idx + 1]));
  // The client decodes 226 after 216, and its scan is a single ascending pass.
  const pos = (op) => { for (let i = 0; i < body.length - 1; i++) if (body[i] === op) return i; return -1; };
  ok('226 is emitted after 214/215/216', pos(226) > pos(216) && pos(216) > pos(214),
    `214@${pos(214)} 216@${pos(216)} 226@${pos(226)}`);
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
