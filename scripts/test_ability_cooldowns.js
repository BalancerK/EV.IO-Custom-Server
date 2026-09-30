/**
 * test_ability_cooldowns.js — tunable cooldowns for throwables and the Teleport ability.
 *
 * Both are gated by ABILITY TIMERS in the extracted physics, not by any server-side timer of ours:
 * casting drains a timer, and g() recharges it a little every tick at a rate that comes from the
 * loadout's weaponStats.
 *
 *   Teleport  = ability id 0  -> abilityTimer3 (Qctsdxd), rate Qn97q6u
 *   Throwables= grenade sids  -> timers 0,1,2,4,5,6,        rates Q51lhke(const)/Q30g2w8/Qpe67c9/
 *                                                            Qvhlqt/Qli8ip8/Qr55etv
 *
 * The scaling tops up the TIMER rather than rewriting the recharge rate in ps.Qz8l93a. Those stats
 * are the loadout's computed values and g() reads them every tick, so scaling them in place would
 * compound tick after tick and permanently corrupt the loadout — the player would end up with a
 * recharge rate of zero or infinity depending on the direction. Reading the rate and adding the
 * difference is idempotent, and this test pins that.
 *
 * Usage:  node scripts/test_ability_cooldowns.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';

const srv = require('../local_ws_server');
const S = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

const TELEPORT_FIELD = 'Qctsdxd';       // abilityTimer3
const GRENADE_FIELD = 'Qctsdxf';        // abilityTimer1 (smoke/flash), rate Q30g2w8

// A player state carrying just what the scaler reads.
function mkPs(over = {}) {
  return {
    Qctsdxg: 0.5, Qctsdxf: 0.5, Qctsdxe: 0.5, Qctsdxd: 0.5,
    Qctsdxc: 0.5, Qctsdxb: 0.5, Qctsdxa: 0.5,
    Qz8l93a: { Q30g2w8: 0.001, Qpe67c9: 0.001, Qn97q6u: 0.0048,
               Qvhlqt: 0.002, Qli8ip8: 0.001, Qr55etv: 0.00125 },
    ...over,
  };
}

(async () => {
  console.log('\n── the settings exist and default to the real game ──');
  {
    const t = S.list().find((x) => x.key === 'throwableCooldownScale');
    const p = S.list().find((x) => x.key === 'teleportCooldownScale');
    ok('throwableCooldownScale is a setting', !!t);
    ok('teleportCooldownScale is a setting', !!p);
    ok('both default to 1 (unchanged behaviour)', t && p && t.value === 1 && p.value === 1,
      `${t && t.value} / ${p && p.value}`);
    ok('and both allow 0', t && p && t.min === 0 && p.min === 0);
  }

  console.log('\n── scale 1 changes nothing at all ──');
  {
    S.set('throwableCooldownScale', 1, 'test');
    S.set('teleportCooldownScale', 1, 'test');
    const ps = mkPs();
    const before = JSON.stringify(ps);
    srv.applyAbilityCooldownScales(ps);
    ok('the state is untouched', JSON.stringify(ps) === before);
  }

  console.log('\n── 0 means NO cooldown ──');
  {
    S.set('teleportCooldownScale', 0, 'test');
    S.set('throwableCooldownScale', 1, 'test');
    const ps = mkPs({ Qctsdxd: 0 });          // just teleported: charge spent
    srv.applyAbilityCooldownScales(ps);
    ok('the teleport timer is refilled immediately', ps[TELEPORT_FIELD] === 1, String(ps[TELEPORT_FIELD]));
    ok('and a grenade timer is NOT touched', ps[GRENADE_FIELD] === 0.5, String(ps[GRENADE_FIELD]));

    S.set('throwableCooldownScale', 0, 'test');
    S.set('teleportCooldownScale', 1, 'test');
    const ps2 = mkPs({ Qctsdxf: 0, Qctsdxd: 0.25 });
    srv.applyAbilityCooldownScales(ps2);
    ok('the throwable timer is refilled immediately', ps2[GRENADE_FIELD] === 1, String(ps2[GRENADE_FIELD]));
    ok('and the teleport timer is NOT touched', ps2[TELEPORT_FIELD] === 0.25, String(ps2[TELEPORT_FIELD]));
  }

  console.log('\n── a fractional scale recharges proportionally faster ──');
  {
    // scale 0.5 => target rate is 2x base, and g() already applied 1x, so one extra base is added.
    S.set('teleportCooldownScale', 0.5, 'test');
    S.set('throwableCooldownScale', 1, 'test');
    const ps = mkPs({ Qctsdxd: 0.5 });
    const rate = ps.Qz8l93a.Qn97q6u;
    srv.applyAbilityCooldownScales(ps);
    ok('half the cooldown adds exactly one extra tick of recharge',
      Math.abs(ps[TELEPORT_FIELD] - (0.5 + rate)) < 1e-12,
      `${ps[TELEPORT_FIELD]} vs ${0.5 + rate}`);

    // scale 2 => target rate is half, so half a tick of recharge is removed.
    S.set('teleportCooldownScale', 2, 'test');
    const ps2 = mkPs({ Qctsdxd: 0.5 });
    srv.applyAbilityCooldownScales(ps2);
    ok('double the cooldown removes half a tick of recharge',
      Math.abs(ps2[TELEPORT_FIELD] - (0.5 - rate / 2)) < 1e-12,
      `${ps2[TELEPORT_FIELD]} vs ${0.5 - rate / 2}`);
  }

  console.log('\n── the loadout stats are never mutated (no compounding) ──');
  {
    // The bug this guards: scaling ps.Qz8l93a in place would compound every tick, so after a few
    // seconds the recharge rate would be zero or enormous and the loadout permanently wrong.
    S.set('teleportCooldownScale', 0.25, 'test');
    S.set('throwableCooldownScale', 0.25, 'test');
    const ps = mkPs();
    const statsBefore = JSON.stringify(ps.Qz8l93a);
    for (let i = 0; i < 200; i++) srv.applyAbilityCooldownScales(ps);
    ok('weaponStats are byte-identical after 200 ticks', JSON.stringify(ps.Qz8l93a) === statsBefore);
    ok('and the timer stays clamped to 1', ps[TELEPORT_FIELD] <= 1 && ps[TELEPORT_FIELD] >= 0,
      String(ps[TELEPORT_FIELD]));
  }

  console.log('\n── timers are clamped, never negative ──');
  {
    S.set('teleportCooldownScale', 10, 'test');
    S.set('throwableCooldownScale', 1, 'test');
    const ps = mkPs({ Qctsdxd: 0 });
    for (let i = 0; i < 50; i++) srv.applyAbilityCooldownScales(ps);
    ok('a very long cooldown cannot drive the timer below 0', ps[TELEPORT_FIELD] >= 0,
      String(ps[TELEPORT_FIELD]));
  }

  console.log('\n── an ability with no recharge rate is left alone ──');
  {
    // Qn97q6u = 0 means "this loadout cannot recharge teleport at all". Scaling zero must not
    // resurrect it, or the setting would hand out an ability the loadout does not grant.
    S.set('teleportCooldownScale', 0.5, 'test');
    const ps = mkPs({ Qctsdxd: 0.3 });
    ps.Qz8l93a.Qn97q6u = 0;
    srv.applyAbilityCooldownScales(ps);
    ok('a zero-rate ability is untouched', ps[TELEPORT_FIELD] === 0.3, String(ps[TELEPORT_FIELD]));
  }

  console.log('\n── gravity reaches the SIM and the WIRE, not just the dashboard ──');
  {
    // This setting was dead: only the legacy hand-rolled sim read it, and that path never runs in
    // production. The value the extracted physics uses is gameSettings.Qn0kxxb (per FRAME), and the
    // client reads its own copy via opcode 26. Changing one without the other desyncs everyone
    // instantly -- which matters far more now that reconciliation runs every tick.
    const bpw = require('../physics_world');
    await bpw.ready;
    const ticks = Math.max(1, Math.round(1000 / (S.get('tickMs') || 50)));
    S.set('gravity', 8, 'test');
    ok('the server sim gets it', Math.abs(bpw.gameSettings.Qn0kxxb - 8 / (ticks * ticks)) < 1e-12,
      String(bpw.gameSettings.Qn0kxxb));
    const tick = srv.buildTickBody('p', 1);
    const i = tick.indexOf(26);
    ok('the tick body streams opcode 26', i >= 0 && Math.abs(tick[i + 1] - bpw.gameSettings.Qn0kxxb) < 1e-12);
    const boot = srv.buildStatePacket({ tick: 1, playerId: 'p', gravityPerFrame: bpw.gameSettings.Qn0kxxb })[2];
    const j = boot.indexOf(26);
    ok('and a joiner has it in their FIRST packet', j >= 0 && boot[j + 1] === bpw.gameSettings.Qn0kxxb);
    // The header decodes in one ascending forward scan; an out-of-order opcode silently drops the rest.
    const ops = [];
    for (let k = 0; k < boot.length - 1; k++) { if (boot[k] === 244) break; if (typeof boot[k] === 'number') { ops.push(boot[k]); k++; } }
    ok('the header is still strictly ascending', ops.every((v, k) => k === 0 || v > ops[k - 1]));
    S.set('gravity', 28, 'test');
    ok('restoring it restores the sim', Math.abs(bpw.gameSettings.Qn0kxxb - 0.07) < 1e-12,
      String(bpw.gameSettings.Qn0kxxb));
  }

  console.log('\n── damage scaling reaches the client, which PREDICTS its own health bar ──');
  {
    // The client does not just render the health the server sends — Q2ngzid subtracts from Qq7zdfv
    // and Qd032mo locally and even decides the kill, ending with `o *= Qsvkg5s.Qbb5ka8`. So a
    // server-only damage change makes the bar show one number and then snap to another.
    // dmgGlobalMult is NOT the knob for this: it is the catalogue -> normalized-HP unit conversion
    // (0.01, matching the constant the client bakes into its own explosion formula).
    const bpw = require('../physics_world');
    await bpw.ready;
    S.set('damageScale', 2, 'test');
    ok('the server sim gets it', bpw.gameSettings.Qbb5ka8 === 2, String(bpw.gameSettings.Qbb5ka8));

    const tick = srv.buildTickBody('p', 1);
    const i = tick.indexOf(27);
    ok('the tick body streams opcode 27', i >= 0 && tick[i + 1] === 2);

    const boot = srv.buildStatePacket({ tick: 1, playerId: 'p', damageScale: 2 })[2];
    const j = boot.indexOf(27);
    ok('and a joiner has it in their FIRST packet', j >= 0 && boot[j + 1] === 2);

    // Every damage source must go through the scale exactly once — bullets, explosions, melee, fall.
    const victim = {
      healthPoints: 1, armorPoints: 0, position: { x: 0, y: 0, z: 0 },
      _ps: { Qalaptp: -1 }, deathStateTimer: 0, _damagedBy: new Map(),
    };
    srv.applyDamage(victim, 0.1, null, {});
    ok('server damage is scaled once', Math.abs(victim.healthPoints - 0.8) < 1e-9,
      `health=${victim.healthPoints}`);

    S.set('damageScale', 0, 'test');
    const invuln = {
      healthPoints: 1, armorPoints: 0, position: { x: 0, y: 0, z: 0 },
      _ps: { Qalaptp: -1 }, deathStateTimer: 0, _damagedBy: new Map(),
    };
    srv.applyDamage(invuln, 0.5, null, {});
    ok('scale 0 means nobody can be hurt', invuln.healthPoints === 1, String(invuln.healthPoints));
    S.set('damageScale', 1, 'test');
  }

  S.reset('damageScale', 'test');
  S.reset('throwableCooldownScale', 'test');
  S.reset('teleportCooldownScale', 'test');

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
