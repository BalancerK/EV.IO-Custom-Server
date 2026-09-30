/**
 * test_weapon_db.js
 *
 * The extracted sim must receive the REAL weapon database.
 *
 * WHY THIS TEST EXISTS
 * ────────────────────
 * The sim looks the equipped weapon up in `weaponData.dataById[player.Qslw9vf]`. physics_extracted's
 * `makeWeaponData()` fallback contains ONE synthetic entry keyed by Mh.Q4b9iia.Qhph812 (= 343), so a
 * player holding 4 (Auto Rifle) or 262 (sword) missed every lookup and the sim took its
 * undefined-fallbacks instead of real catalogue data.
 *
 * SCOPE — what this does and does NOT fix. The zoom computation
 *   `S = dataById[w]; r.Qgk2mcg = !!(hp>0 && held(6) && S !== undefined && S.zoom !== undefined && …)`
 * lives in `Qwhlcfo` (:3304), the client's FULL step — which the server does not call. The server
 * calls `_g` (= g, assigned :3635) directly and sets `Qgk2mcg` itself from this same catalogue in
 * preTickFire, which is exactly why that code exists. So passing the DB does NOT change zoom
 * behaviour, and the assertions below pin that g() leaves `Qgk2mcg` alone.
 *
 * What it DOES buy: the fields g() genuinely reads now come from the real catalogue rather than a
 * synthetic stand-in (`jumpPowerMod` :3623, `noSprint` :3627 — both have safe fallbacks and the
 * catalogue happens to define neither, so behaviour is unchanged today but stops depending on that
 * coincidence), and two lookups that dereference with NO null check can no longer miss:
 *   :3161  `var l = n.dataById[e], u = 'number' == typeof l.startAmmo ? …`
 *   :3430  `h = o.dataById[c]; n.Qwf7j5k[h.id] = …`
 *
 * Usage:  node scripts/test_weapon_db.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const phys = require('../physics_extracted');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

const AR = 4, SWORD = 262, SNIPER = 701;

bpw.ready.then(() => {
  console.log('\n── the DB covers the weapons players actually hold ──');
  {
    const db = srv.WEAPON_DB;
    ok('WEAPON_DB is exported with a dataById map', !!(db && db.dataById));
    // Compare against the catalogue itself rather than a guessed floor — the served snapshot has 23
    // weapons with parseable field_weapon_data, and hardcoding ">50" just encodes a wrong guess.
    const cat = JSON.parse(require('fs').readFileSync(
      require('path').join(__dirname, '..', 'weapons.json'), 'utf8'));
    let expected = 0;
    for (const it of cat.data) {
      const a = it && it.attributes;
      if (!a || a.drupal_internal__nid == null) continue;
      try { if (JSON.parse(a.field_weapon_data)) expected++; } catch (_) {}
    }
    const n = Object.keys(db.dataById).length;
    ok(`it holds every catalogue weapon, not one synthetic entry (${n} of ${expected})`,
      n === expected, `got ${n}, catalogue has ${expected}`);
    for (const [nid, name] of [[AR, 'Auto Rifle'], [SWORD, 'Sword'], [SNIPER, 'Sweeper']]) {
      ok(`${name} (${nid}) is present`, !!db.dataById[nid]);
    }
    ok('entries carry the `id` field the sim reads (:3430 h.id)',
      db.dataById[AR] && db.dataById[AR].id === AR);
    // The catalogue mixes "10" and 30; the sim type-checks with `typeof === 'number'`.
    const clip = db.dataById[AR] && db.dataById[AR].clipSize;
    ok('numeric strings are coerced to real numbers', typeof clip === 'number', `clipSize is ${typeof clip}`);
  }

  console.log('\n── zoom survives the movement tick (the regression) ──');
  {
    // A zoomable weapon, ADS held: g() must KEEP zooming true rather than clearing it.
    const zoomable = Object.values(srv.WEAPON_DB.dataById).find((w) => w.zoom !== undefined);
    ok('the catalogue has at least one zoomable weapon', !!zoomable);

    const run = (weaponData, weapon) => {
      const ps = phys.createPlayerState('z', { x: 0, y: 50, z: 0 }, 0);
      const gs = { Qa7phk3: { z: ps }, Qbu40n9: 1, Qsvkg5s: bpw.gameSettings };
      bpw.world.Qcw4fab([gs, gs], 0, 'z');
      ps.Qslw9vf = weapon;      // equipped weapon
      ps.Qq7zdfv = 1;           // alive
      ps.Qv7w1q0 = -1;          // not reloading
      ps.Qgk2mcg = true;        // what preTickFire sets when ADS is held
      // action 6 = Zoom held, matching the client's `q.Q38tgef.has(6)` gate.
      phys.tickMovement(bpw.gameSettings, ps, phys.makeRawFrames([{ held: [6], pressed: [] }]),
        bpw.world, gs, undefined, weaponData);
      return ps.Qgk2mcg;
    };

    // g() must leave zooming ENTIRELY alone — the zoom rule lives in Qwhlcfo, which the server does
    // not call, so preTickFire owns this field. If a future change makes g() start writing it, these
    // flip and we find out immediately instead of via an ADS reconcile divergence.
    ok('g() preserves zooming=true regardless of the DB (zoom rule is in Qwhlcfo, not g)',
      run(undefined, zoomable.id) === true && run(srv.WEAPON_DB, zoomable.id) === true);
    ok('g() preserves zooming=true even for the sword (it does not consult zoom at all)',
      run(srv.WEAPON_DB, SWORD) === true);
    // And the server's OWN gate — the thing that actually decides ADS — must be catalogue-correct.
    ok('weaponHasZoom() is true for a zoomable weapon', srv.weaponHasZoom(zoomable.id) === true);
    ok('weaponHasZoom() is false for the sword', srv.weaponHasZoom(SWORD) === false);
  }

  console.log('\n── the unguarded lookups no longer miss ──');
  {
    // :3161 and :3430 dereference dataById[...] with no null check. Confirm the ids the server
    // actually equips are present, so those paths cannot throw on a missing entry.
    const db = srv.WEAPON_DB.dataById;
    // ACTION_TO_WEAPON can name weapons absent from this cached catalogue snapshot (129, 687 are
    // not in it). Those are unreachable anyway — processWeaponSwitch only equips ids present in the
    // player's weaponList, which is built from the catalogue. Assert the ones the server can
    // actually equip, and report the rest as informational.
    const equipped = [AR, SWORD, 7, 6, 8, 281, 282, 283, 635];
    const missing = equipped.filter((n) => !db[n]);
    ok('every equippable weapon the server can select is in the DB', missing.length === 0,
      'missing: ' + JSON.stringify(missing));
    const notInSnapshot = [129, 687].filter((n) => !db[n]);
    if (notInSnapshot.length) {
      console.log('  · not in this catalogue snapshot (cannot be equipped): ' + JSON.stringify(notInSnapshot));
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}).catch((e) => { console.error(e); process.exit(1); });
