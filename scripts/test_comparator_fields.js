/**
 * test_comparator_fields.js — every reconciler-compared field on the wire must equal the SIMULATED
 * value, not a second expression that re-derives it.
 *
 * WHY
 * ───
 * The client snaps the local player if ANY of these 14 differ beyond 1e-4 (Qqx5i3b, bundle :33594):
 *
 *   127 Qslw9vf equippedWeaponId · 136 Qdsukt4 position · 138 Q9t2fit grounded · 139 Qqg4go0 yaw
 *   140 Qcrzrpr pitch · 141 Qd0yy90 pitchOffset · 142 Q2r3ysn crouching · 143 Q2xg3ev sprinting
 *   144 Qgk2mcg zooming · 157 Qac6dfa airJumps · 185 Qcdx4mh isDancing · 186 Qkno30b isExamining
 *   187 Qjb047o justUsedActiveAbility · 188 Qgxywsl justTeleported
 *
 * Opcode 144 used to emit `heldActions.has(6)` — "is the aim key down" — instead of ps.Qgk2mcg,
 * which the client gates on weapon-has-zoom and not-reloading. The two agree in the common case, so
 * ordinary ADS worked; they diverged only when aiming with a zoom-less weapon (sword 262, sweeper
 * 701) or while reloading, and then the camera stuttered for exactly as long as the button was held.
 *
 * That is the general hazard: a parallel derivation at the emit site agrees in the common case and
 * diverges in the corner. This test pins wire == sim for all 14 fields across the corner cases where
 * a re-derivation would differ from the simulation (crouch airborne, sprint while crouched, aim with
 * a zoom-less weapon, aim while reloading, and so on).
 *
 * Usage:  node scripts/test_comparator_fields.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');
const bpw = require('../physics_world');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const f = (held, pressed = []) => [1.0, [held, pressed, [], [0, 0], null, null]];

// opcode -> [label, physics field, kind]. Confirmed against the decoder (work/opcode_map.json).
// NOTE 127 (equippedWeaponId) is NOT here: it is delta-emitted, gated on `weaponSendCount > 0`, so
// it is absent on most ticks. That is correct for a delta protocol — absent means "unchanged", and
// re-sending a compared field every tick makes the comparator re-check it every tick. The invariant
// for a delta field is different (emitted-when-changed, matching when emitted) and is asserted
// separately at the end.
const FIELDS = [
  [138, 'grounded',         'Q9t2fit', 'bool'],
  [139, 'yaw',              'Qqg4go0', 'num'],
  [140, 'pitch',            'Qcrzrpr', 'num'],
  [141, 'pitchOffset',      'Qd0yy90', 'num'],
  [142, 'crouching',        'Q2r3ysn', 'bool'],
  [143, 'sprinting',        'Q2xg3ev', 'bool'],
  [144, 'zooming',          'Qgk2mcg', 'bool'],
  [157, 'airJumps',         'Qac6dfa', 'num'],
  [185, 'isDancing',        'Qcdx4mh', 'bool'],
  [186, 'isExamining',      'Qkno30b', 'bool'],
  [188, 'justTeleported',   'Qgxywsl', 'bool'],
];
// 187 justUsedActiveAbility is mirrored from playerState.justUsedActiveAbility, which the grenade
// cast sets directly rather than g() — checked separately below.

const TOL = 1e-4;   // the comparator's own tolerance

(async () => {
  await bpw.ready;
  const sp = bpw.spawnPoints[0];

  function drive(label, { weapon = 4, held = [], pressed = [], reloading = false, ticks = 4 } = {}) {
    const p = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 'p');
    p.equippedWeaponId = weapon; p._ammoGunId = weapon; p.gunAmmo = 30;
    for (let t = 1; t <= ticks; t++) {
      if (reloading) p.reloadTicks = 40;
      const frames = [f(held, t === 1 ? pressed : [])];
      srv.preTickFire(p, frames);
      srv.integratePlayerSim(p, 0.05, t, frames);
    }
    const body = [];
    srv.appendPlayerTickBody(body, 'p', p);
    const at = (op) => { const i = body.indexOf(op); return i === -1 ? undefined : body[i + 1]; };

    console.log(`\n  ── ${label} ──`);
    for (const [op, name, qf, kind] of FIELDS) {
      const wire = at(op);
      const sim = p._ps[qf];
      let match;
      if (kind === 'bool') match = (!!wire === !!sim);
      else match = Number.isFinite(wire) && Number.isFinite(sim) ? Math.abs(wire - sim) <= TOL : wire === sim;
      ok(`${String(op).padEnd(3)} ${name.padEnd(20)} wire=${String(wire).padEnd(9)} sim=${String(sim)}`,
        match, 'the emitter is not shipping what the simulation computed');
    }
    // Position is a vector: sub-mode byte then x, y, z.
    const pi = body.indexOf(136);
    const px = body[pi + 2], py = body[pi + 3], pz = body[pi + 4];
    const d = p._ps.Qdsukt4;
    ok(`136 position             wire=(${px},${py},${pz})`,
      Math.abs(px - d.x) <= TOL && Math.abs(py - d.y) <= TOL && Math.abs(pz - d.z) <= TOL,
      `sim=(${d.x},${d.y},${d.z}) — note EMIT_POSITION_Y_OFFSET must stay 0`);
    return p;
  }

  console.log('\n══ corner cases where a re-derived value would diverge from the sim ══');

  // Baseline.
  drive('idle, rifle');

  // Crouch: Q2r3ysn is "crouch key AND grounded", so holding crouch in mid-air is the case where
  // emitting the raw key state would differ from the simulation.
  drive('crouch key held, grounded', { held: [8] });
  drive('crouch key held while AIRBORNE', { held: [8, 9], pressed: [9], ticks: 3 });

  // Sprint: g() gates it on stamina, crouch, zoom, weapon noSprint and input direction — several
  // chances for an emit-site shortcut to disagree.
  drive('sprint + forward', { held: [7, 0] });
  drive('sprint + crouch together', { held: [7, 8, 0] });
  drive('sprint while aiming', { held: [7, 0, 6] });

  // Zoom: the case that was actually broken.
  drive('aim held, rifle (zoom weapon)', { held: [6] });
  drive('aim held, SWORD (no zoom field)', { weapon: 262, held: [6] });
  drive('aim held, SWEEPER (no zoom field)', { weapon: 701, held: [6] });
  drive('aim held WHILE RELOADING', { held: [6], reloading: true });

  // Jump/air state.
  drive('jumping', { held: [9], pressed: [9], ticks: 2 });

  console.log('\n── 187 justUsedActiveAbility mirrors the cast flag ──');
  {
    const p = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 'p');
    srv.integratePlayerSim(p, 0.05, 1, [f([])]);
    const b = []; srv.appendPlayerTickBody(b, 'p', p);
    const wire = b[b.indexOf(187) + 1];
    ok('false when no ability was cast', wire === false, String(wire));
    // g() clears Qjb047o at the top of each tick, so the flag is a one-tick pulse either way.
    ok('and it agrees with the sim', !!wire === !!p._ps.Qjb047o,
      `wire=${wire} sim=${p._ps.Qjb047o}`);
  }

  console.log('\n── 127 equippedWeaponId is delta-emitted: absent = unchanged ──');
  {
    const p = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 'p');
    p.equippedWeaponId = 4; p._ammoGunId = 4; p.gunAmmo = 30;
    // Settle: burn off the initial weaponSendCount so we start from "nothing to send".
    for (let t = 1; t <= 8; t++) {
      const b0 = []; srv.appendPlayerTickBody(b0, 'p', p);
      srv.integratePlayerSim(p, 0.05, t, [f([])]);
    }
    const quiet = []; srv.appendPlayerTickBody(quiet, 'p', p);
    ok('absent on a steady tick (delta protocol, saves a compared field re-check)',
      quiet.indexOf(127) === -1);

    // Switch weapons via the real input path: action 33 selects the sword (ACTION_TO_WEAPON).
    srv.integratePlayerSim(p, 0.05, 9, [f([33], [33])]);
    const after = []; srv.appendPlayerTickBody(after, 'p', p);
    const wire = after[after.indexOf(127) + 1];
    ok('emitted after a weapon switch', after.indexOf(127) !== -1,
      'a compared field that changed but was never sent would diverge until the next switch');
    ok('and it carries the new weapon', wire === p.equippedWeaponId,
      `wire=${wire} mirror=${p.equippedWeaponId}`);
    ok('which is what the sim has too', wire === p._ps.Qslw9vf,
      `wire=${wire} sim=${p._ps.Qslw9vf}`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
