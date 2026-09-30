/**
 * test_zoom_state.js — opcode 144 (Qgk2mcg) must carry ACTUAL zoom, not "aim key held".
 *
 * THE BUG
 * ───────
 * The tick body emitted `144, playerState.heldActions.has(6)`. The client computes (bundle :34489):
 *
 *     Qgk2mcg = !!(Qq7zdfv > 0 && held(6) && S !== undefined && S.zoom !== undefined && Qv7w1q0 < 1)
 *
 * i.e. holding the aim key only zooms you if the weapon HAS a zoom and you are NOT reloading.
 * preTickFire already computed exactly that into ps.Qgk2mcg — the emitter simply wasn't reading it.
 *
 * With a zoom weapon and no reload the two agree, so ordinary ADS worked and this stayed hidden. It
 * broke in exactly two cases:
 *   - a weapon with no `zoom` field in the catalogue (sword 262, sweeper 701)
 *   - any weapon while reloading
 * In both, the server streamed zooming=true while the client predicted false. zooming is one of the
 * ~14 reconciler-compared fields, so it diverged EVERY tick the button was held — a camera stutter
 * that lasted exactly as long as you held aim, and the debug comparator named it:
 *     zooming  =>  Server: true   Client: false
 *
 * Usage:  node scripts/test_zoom_state.js
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
const f = (held) => [1.0, [held, [], [], [0, 0], null, null]];

const SWORD = 262, SWEEPER = 701, RIFLE = 4;

(async () => {
  await bpw.ready;
  const sp = bpw.spawnPoints[0];

  // Drive the REAL per-tick order, then read opcode 144 back off the wire.
  function streamedZoom(weaponId, { aim = true, reloading = false } = {}) {
    const p = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 'p');
    p.equippedWeaponId = weaponId; p._ammoGunId = weaponId; p.gunAmmo = 30;
    for (let t = 1; t <= 3; t++) {
      if (reloading) p.reloadTicks = 40;          // hold the reload open across the tick
      const frames = [f(aim ? [6] : [])];
      srv.preTickFire(p, frames);
      srv.integratePlayerSim(p, 0.05, t, frames);
    }
    const b = [];
    srv.appendPlayerTickBody(b, 'p', p);
    const i = b.indexOf(144);
    return { wire: i === -1 ? undefined : b[i + 1], ps: p._ps.Qgk2mcg, held: p.heldActions.has(6) };
  }

  console.log('\n── weapons with no zoom never report zooming ──');
  {
    // Neither the sword nor the sweeper defines `zoom` in the weapon catalogue.
    for (const [name, id] of [['sword', SWORD], ['sweeper', SWEEPER]]) {
      const r = streamedZoom(id);
      ok(`${name}: aim held, wire says NOT zooming`, r.wire === false,
        `wire=${r.wire} — the client computes false, so true here diverges every tick`);
      ok(`${name}: and the aim key IS held (so this is not a vacuous pass)`, r.held === true);
    }
  }

  console.log('\n── reloading blocks zoom even on a zoom weapon ──');
  {
    const r = streamedZoom(RIFLE, { reloading: true });
    ok('rifle + aim while reloading, wire says NOT zooming', r.wire === false, `wire=${r.wire}`);
    ok('the aim key is still held', r.held === true);
  }

  console.log('\n── the normal case still works (this is what hid the bug) ──');
  {
    const r = streamedZoom(RIFLE);
    ok('rifle + aim, not reloading -> zooming', r.wire === true, `wire=${r.wire}`);
  }

  console.log('\n── not aiming is never zooming ──');
  {
    for (const [name, id] of [['rifle', RIFLE], ['sword', SWORD]]) {
      const r = streamedZoom(id, { aim: false });
      ok(`${name}: no aim key -> not zooming`, r.wire === false, `wire=${r.wire}`);
    }
  }

  console.log('\n── the wire always equals the simulated state ──');
  {
    // The whole failure was these two disagreeing. Tie them together permanently.
    for (const [name, id, opts] of [
      ['sword', SWORD, {}],
      ['sweeper', SWEEPER, {}],
      ['rifle', RIFLE, {}],
      ['rifle reloading', RIFLE, { reloading: true }],
      ['rifle idle', RIFLE, { aim: false }],
    ]) {
      const r = streamedZoom(id, opts);
      ok(`${name}: opcode 144 === ps.Qgk2mcg`, r.wire === !!r.ps, `wire=${r.wire} ps=${r.ps}`);
    }
  }

  console.log('\n── it is a real boolean ──');
  {
    const r = streamedZoom(RIFLE);
    ok('not 1/0 or undefined', typeof r.wire === 'boolean', typeof r.wire);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
