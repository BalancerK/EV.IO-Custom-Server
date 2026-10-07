/**
 * test_weapon_pickups.js — weapon pickup spawn points: evmap parsing, multi-slot grant/stack/
 * deplete/clear mechanics, proximity detection (incl. the bot on/off toggle), respawn cooldown,
 * the finite-reserve HUD fix, and the opcode 270-278 protocol stream's hide-until-tick mechanism.
 *
 * Usage:  node scripts/test_weapon_pickups.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
// This test checks pickup/weapon-slot streaming and damage on playerStates built via
// createPlayerSimState, with no "enter the match" step in between — a held player ("Hold new
// players until they click to play", now the default) streams no weapon slots at all and refuses
// all damage, which would mask this file's own pickup/stack/deplete mechanics.
process.env.EVIO_CLICK_TO_PLAY = process.env.EVIO_CLICK_TO_PLAY || '0';

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

function mkSession(id, x, y, z, overrides = {}) {
  const ps = srv.createPlayerSimState({ x, y, z, yaw: 0 }, id);
  Object.assign(ps, overrides);
  return { playerId: id, sessionId: id, accepted: !!overrides._skipAccept ? false : true,
    isBot: !!overrides.isBot, playerState: ps };
}

// Captured ONCE, before anything overrides it, so the fake-points tests below can restore the
// REAL getter afterward. Re-requiring '../physics_world' from inside a replacement getter (as an
// earlier version of this file did) is a self-reference — it resolves back to this same cached
// module object, whose OWN getter is the thing being called, i.e. infinite recursion.
const _realPickupPointsDescriptor = Object.getOwnPropertyDescriptor(bpw, 'pickupPoints');
function restoreRealPickupPoints() {
  Object.defineProperty(bpw, 'pickupPoints', _realPickupPointsDescriptor);
}

(async () => {
  await bpw.ready;

  console.log('\n── evmap parsing: pickup points are real, not the old mis-attributed "lights" ──');
  {
    ok('the default map has pickup points', bpw.pickupPoints.length > 0,
      String(bpw.pickupPoints.length));
    for (const p of bpw.pickupPoints) {
      ok(`point has finite, in-range coordinates (${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(1)})`,
        Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z)
        && Math.abs(p.x) < 2000 && Math.abs(p.y) < 2000 && Math.abs(p.z) < 2000);
    }
  }

  console.log('\n── weapon catalogue: every special weapon resolves a positive pickUpSize ──');
  {
    for (const nid of srv.PICKUP_WEAPON_IDS) {
      const size = srv.WEAPON_PICKUP_SIZE[nid];
      ok(`nid ${nid} has a positive pickUpSize`, Number.isFinite(size) && size > 0, String(size));
    }
  }

  console.log('\n── weaponClip caps a pickup weapon at its remaining pool, leaves normal guns alone ──');
  {
    const p = srv.createPlayerSimState({ x: 0, y: 0, z: 0 }, 'clipA');
    ok('a normal gun (AR, nid 4) is NOT capped (no pickupAmmo entry for it)',
      srv.weaponClip(4, p) > 0 && Object.keys(p.pickupAmmo).length === 0);

    p.pickupAmmo[6] = 1;         // Sniper: less than a full clip (2)
    ok('a pickup weapon\'s clip is capped at the remaining pool (1 < clipSize 2)',
      srv.weaponClip(6, p) === 1, String(srv.weaponClip(6, p)));

    p.pickupAmmo[6] = 0;
    ok('an exhausted pool caps the clip at exactly 0', srv.weaponClip(6, p) === 0);

    p.pickupAmmo[6] = 999;
    ok('a pool larger than the normal clip still caps at the WEAPON\'s clip size, not the pool',
      srv.weaponClip(6, p) === 2, String(srv.weaponClip(6, p)));

    // A DIFFERENT weapon than any key in pickupAmmo is never capped by it.
    ok('weaponClip for a nid with no pickupAmmo entry is unaffected', srv.weaponClip(4, p) > 2);
  }

  console.log('\n── _grantPickupWeapon, REAL PLAYER (isBot omitted): NEW weapon adds a slot, does NOT equip ──');
  {
    // Reported live: picking up a weapon mid-fight yanked the gun already in hand out and replaced
    // it — a real player now keeps whatever they're holding and switches to a pickup manually
    // (processWeaponSwitch); see _grantPickupWeapon's own comment. Bots are the one exception
    // (tested in their own section below), since nothing in their AI ever presses a switch action.
    const p = srv.createPlayerSimState({ x: 0, y: 0, z: 0 }, 'grantA');
    p.equippedWeaponId = 4; p.weaponList = [4, 262]; p._ammoGunId = 4; p.gunAmmo = 999999; p.backupWeaponId = -1;
    srv._grantPickupWeapon(p, 8);   // Rocket Launcher, pickUpSize 3, clipSize 1
    ok('pickupAmmo now has an entry for nid 8', Object.prototype.hasOwnProperty.call(p.pickupAmmo, 8));
    ok('weaponList now has 3 entries, primary and sword preserved, Rocket Launcher inserted at '
      + 'its OFFICIAL key-order rank (key 4, before the sword at key Z) — see WEAPON_CYCLE_RANK',
      JSON.stringify(p.weaponList) === JSON.stringify([4, 8, 262]), JSON.stringify(p.weaponList));
    ok('does NOT equip the picked-up weapon', p.equippedWeaponId === 4, String(p.equippedWeaponId));
    ok('_ammoGunId is untouched', p._ammoGunId === 4, String(p._ammoGunId));
    ok('gunAmmo (the equipped gun\'s magazine) is untouched', p.gunAmmo === 999999, String(p.gunAmmo));
    // pickupAmmo[nid] tracks the TOTAL rounds left — including whatever's currently chambered, not
    // a separate "reserve beyond the clip" figure. It starts at the full pickUpSize; only FIRING
    // decrements it (preTickFire); reloading redistributes chamber/reserve without touching the
    // total, so weaponClip's cap stays correct at every reload with no extra bookkeeping.
    ok('pickupAmmo[8] starts at the full pickUpSize (3), not reduced by the initial load',
      p.pickupAmmo[8] === 3, String(p.pickupAmmo[8]));
    ok('backupWeaponId is untouched (no switch happened)', p.backupWeaponId === -1, String(p.backupWeaponId));

    console.log('\n── a SECOND, DIFFERENT special weapon ADDS a slot rather than replacing the first, still no equip ──');
    srv._grantPickupWeapon(p, 282);   // SMG — a genuinely different type
    ok('weaponList now has FOUR entries — both special weapons carried at once; SMG (key 6) ranks '
      + 'AFTER the sword (key Z), so it lands last, not before it',
      JSON.stringify(p.weaponList) === JSON.stringify([4, 8, 262, 282]), JSON.stringify(p.weaponList));
    ok('both pickupAmmo entries exist', p.pickupAmmo[8] === 3 && p.pickupAmmo[282] === 130,
      JSON.stringify(p.pickupAmmo));
    ok('still does not equip the new one either', p.equippedWeaponId === 4, String(p.equippedWeaponId));

    console.log('\n── picking up the SAME type again STACKS ammo, still does not equip or duplicate the slot ──');
    srv._grantPickupWeapon(p, 8);   // grab a SECOND Rocket Launcher pickup
    ok('pickupAmmo[8] added the full pickUpSize again (3 + 3 = 6)', p.pickupAmmo[8] === 6,
      String(p.pickupAmmo[8]));
    ok('weaponList still has exactly 4 entries (no duplicate slot)',
      JSON.stringify(p.weaponList) === JSON.stringify([4, 8, 262, 282]), JSON.stringify(p.weaponList));
    ok('still on the original primary — never equipped at any point',
      p.equippedWeaponId === 4, String(p.equippedWeaponId));
  }

  console.log('\n── _grantPickupWeapon, BOT (isBot=true): NEW weapon adds a slot AND auto-equips ──');
  {
    // Bots have no concept of "manually switch later" — driveBotFrame never presses a switch
    // action — so they keep the original immediate-equip behavior (see _grantPickupWeapon's own
    // comment), otherwise botWeaponPickupsEnabled would be a dead setting.
    const p = srv.createPlayerSimState({ x: 0, y: 0, z: 0 }, 'grantBot');
    p.equippedWeaponId = 4; p.weaponList = [4, 262]; p._ammoGunId = 4;
    srv._grantPickupWeapon(p, 8, true);   // Rocket Launcher, pickUpSize 3, clipSize 1
    ok('weaponList now has 3 entries, same insertion rule as a real player',
      JSON.stringify(p.weaponList) === JSON.stringify([4, 8, 262]), JSON.stringify(p.weaponList));
    ok('auto-equips the picked-up weapon', p.equippedWeaponId === 8);
    ok('_ammoGunId points at it too', p._ammoGunId === 8);
    ok('the first magazine is sized (clipSize 1, capped by the pool of 3)', p.gunAmmo === 1);
    ok('backupWeaponId remembers what was equipped before', p.backupWeaponId === 4);

    srv._grantPickupWeapon(p, 282, true);   // SMG — a genuinely different type
    ok('auto-equips the NEW one too', p.equippedWeaponId === 282);

    p.equippedWeaponId = 4; p._ammoGunId = 4;   // switch back to primary first
    srv._grantPickupWeapon(p, 8, true);   // grab a SECOND Rocket Launcher pickup — already carried
    ok('does NOT re-equip — already-carried stacks never equip, only a genuinely NEW slot does',
      p.equippedWeaponId === 4, String(p.equippedWeaponId));
  }

  console.log('\n── cycle order is ASCENDING NID, regardless of pickup order ──');
  {
    // Confirmed against the real, official HUD's displayed loadout after picking up everything:
    // "1, 3, 2, 4, Z, 7, 6, 8" — those are the weapons' own key LABELS in list order, which comes
    // out scrambled relative to key number precisely because the underlying sort is by nid, not
    // by key: Sniper (nid 6, key 3) sorts before Shotgun (nid 7, key 2); Desert Eagle (nid 281,
    // key 7) sorts before SMG (nid 282, key 6). Grab them in a deliberately SCRAMBLED pickup
    // order here and the final list must still land in ascending-nid order: 6,7,8,262,281,282,283.
    const p = srv.createPlayerSimState({ x: 0, y: 0, z: 0 }, 'scrambled');
    p.equippedWeaponId = 4; p.weaponList = [4, 262]; p._ammoGunId = 4;
    for (const nid of [281, 283, 282, 7, 8, 6]) srv._grantPickupWeapon(p, nid);
    ok('weaponList lands in ascending-nid order, not pickup order',
      JSON.stringify(p.weaponList) === JSON.stringify([4, 6, 7, 8, 262, 281, 282, 283]),
      JSON.stringify(p.weaponList));
  }

  console.log('\n── firing a pickup weapon drains ONLY that slot\'s pool ──');
  {
    const p = srv.createPlayerSimState({ x: 0, y: 0, z: 0 }, 'fireA');
    p.equippedWeaponId = 4; p.weaponList = [4, 262]; p._ammoGunId = 4;
    srv._grantPickupWeapon(p, 8);     // Rocket Launcher: clipSize 1, pickUpSize 3
    srv._grantPickupWeapon(p, 282);   // SMG carried too, untouched by firing the rocket
    p.equippedWeaponId = 8; p._ammoGunId = 8; p.gunAmmo = srv.weaponClip(8, p);
    p.switchTimer = 0;   // settled: not mid weapon-swap (see the "shot refused while switching" fix)
    ok('starts with 1 loaded, total pool 3 (includes the loaded round)',
      p.gunAmmo === 1 && p.pickupAmmo[8] === 3,
      `gunAmmo=${p.gunAmmo} remaining=${p.pickupAmmo[8]}`);

    p.fireCooldown = 0;
    srv.preTickFire(p, [[1, [[5], [], [], [0, 0]]]]);   // one shot
    ok('firing drains the magazine and that slot\'s pool together',
      p.gunAmmo === 0 && p.pickupAmmo[8] === 2,
      `gunAmmo=${p.gunAmmo} remaining=${p.pickupAmmo[8]}`);
    ok('the OTHER carried special weapon (SMG) is untouched', p.pickupAmmo[282] === 130);
    ok('still carrying the rocket launcher — its own pool is not yet exhausted',
      Object.prototype.hasOwnProperty.call(p.pickupAmmo, 8));

    console.log('\n── switching away and back must NOT instantly refill the pickup\'s magazine ──');
    // Reported live: fire the pickup weapon, switch to something else, switch back — the magazine
    // came back full with no reload wait, effectively a free reload exploit (most visible on a
    // clipSize-1 weapon like this one, where every switch looked like the shot never happened).
    p.equippedWeaponId = 282;                    // switch to the SMG
    srv.preTickFire(p, [[1, [[], [], [], [0, 0]]]]);   // let the lazy switch-detect in preTickFire run
    ok('switching to the SMG loads ITS OWN full magazine (unaffected by the rocket\'s state)',
      p.gunAmmo === srv.weaponClip(282, p), `gunAmmo=${p.gunAmmo}`);
    p.equippedWeaponId = 8;                      // switch back to the rocket launcher
    srv.preTickFire(p, [[1, [[], [], [], [0, 0]]]]);
    ok('the rocket launcher comes back EMPTY, exactly as left — not instantly reloaded',
      p.gunAmmo === 0, `gunAmmo=${p.gunAmmo}`);
    ok('the pool is untouched by the round trip (still 2, not re-drawn from or refilled)',
      p.pickupAmmo[8] === 2, `pickupAmmo[8]=${p.pickupAmmo[8]}`);
  }

  console.log('\n── an exhausted pickup weapon clears ONLY that slot, other slots survive ──');
  {
    const p = srv.createPlayerSimState({ x: 0, y: 0, z: 0 }, 'spentA');
    p.equippedWeaponId = 4; p.weaponList = [4, 262]; p._ammoGunId = 4;
    srv._grantPickupWeapon(p, 8);     // will be exhausted
    srv._grantPickupWeapon(p, 282);   // will survive
    p.equippedWeaponId = 8; p._ammoGunId = 8;
    // Simulate having fired every round the pool ever had, without needing to drive the real
    // reload-timer countdown tick by tick — preTickFire's spent check only cares about the two
    // ammo fields, checked every call regardless of whether fire is held this tick.
    p.gunAmmo = 0; p.pickupAmmo[8] = 0; p.fireCooldown = 0; p.reloadTicks = 0;
    srv.preTickFire(p, [[1, [[], [], [], [0, 0]]]]);   // no fire held — just let the check run
    ok('the SPENT slot is gone', !Object.prototype.hasOwnProperty.call(p.pickupAmmo, 8),
      JSON.stringify(p.pickupAmmo));
    ok('the OTHER carried weapon (SMG) survives', p.pickupAmmo[282] === 130);
    ok('auto-cleared back to the primary', p.equippedWeaponId === 4, String(p.equippedWeaponId));
    ok('weaponList lost only the spent slot',
      JSON.stringify(p.weaponList) === JSON.stringify([4, 262, 282]), JSON.stringify(p.weaponList));
  }

  console.log('\n── respawn strips EVERY carried pickup weapon (official: never survives death) ──');
  {
    const p = srv.createPlayerSimState({ x: 0, y: 0, z: 0 }, 'respawnA');
    p.equippedWeaponId = 4; p.weaponList = [4, 262]; p._ammoGunId = 4;
    srv._grantPickupWeapon(p, 6);     // Sniper
    srv._grantPickupWeapon(p, 7);     // Shotgun — carrying TWO different special weapons
    ok('carrying two pickups before respawn', Object.keys(p.pickupAmmo).length === 2,
      JSON.stringify(p.pickupAmmo));
    const session = { accepted: true, playerState: p };
    const sessions = new Map([['respawnA', session]]);
    srv.respawnAll(sessions);
    ok('pickupAmmo is fully cleared by respawnAll', Object.keys(p.pickupAmmo).length === 0,
      JSON.stringify(p.pickupAmmo));
    ok('equippedWeaponId reverted to the primary', p.equippedWeaponId === 4, String(p.equippedWeaponId));
    ok('weaponList is back to [primary, sword]',
      JSON.stringify(p.weaponList) === JSON.stringify([4, 262]), JSON.stringify(p.weaponList));
  }

  console.log('\n── respawnPlayerNow also strips every slot (the join/click-to-play path, not just round reset) ──');
  {
    const p = srv.createPlayerSimState({ x: 0, y: 0, z: 0 }, 'respawnB');
    p.equippedWeaponId = 4; p.weaponList = [4, 262]; p._ammoGunId = 4;
    srv._grantPickupWeapon(p, 7);   // Shotgun
    srv._grantPickupWeapon(p, 283); // Grenade Launcher too
    ok('carrying two pickups before respawn', Object.keys(p.pickupAmmo).length === 2);
    srv.respawnPlayerNow(p);
    ok('pickupAmmo is cleared', Object.keys(p.pickupAmmo).length === 0);
    ok('equippedWeaponId reverted to the primary', p.equippedWeaponId === 4, String(p.equippedWeaponId));
  }

  console.log('\n── processWeaponSwitch already cycles/direct-selects EVERY carried pickup (generic) ──');
  {
    const p = srv.createPlayerSimState({ x: 0, y: 0, z: 0 }, 'switchA');
    p.equippedWeaponId = 4; p.weaponList = [4, 262]; p._ammoGunId = 4;
    srv._grantPickupWeapon(p, 6);   // Sniper — auto-equips it
    // Direct-select back to the sword (action 33 -> nid 262, per ACTION_TO_WEAPON).
    srv.processWeaponSwitch(p, new Set(), new Set([33]));
    ok('direct-select switches off the pickup weapon onto the sword', p.equippedWeaponId === 262,
      String(p.equippedWeaponId));
    // Direct-select BACK onto the pickup (action 14 -> nid 6, Sniper) works because it's still in
    // weaponList (switching away from it does not drop it — only depletion/respawn does).
    srv.processWeaponSwitch(p, new Set(), new Set([14]));
    ok('direct-select switches back onto the still-carried pickup weapon', p.equippedWeaponId === 6,
      String(p.equippedWeaponId));
  }

  console.log('\n── the weaponSlots HUD stream shows FINITE reserve for a pickup weapon, not ∞ ──');
  {
    const p = srv.createPlayerSimState({ x: 0, y: 0, z: 0 }, 'hudA');
    p.equippedWeaponId = 4; p.weaponList = [4, 262]; p._ammoGunId = 4;
    srv._grantPickupWeapon(p, 6);   // Sniper: clipSize 2, pickUpSize 6 -> gunAmmo 2, pool 6
    const body = [];
    srv.appendPlayerTickBody(body, 'hudA', p);
    // Find the 135-block for nid 6 and read its 132 (reserve) field.
    let reserve = null;
    for (let i = 0; i < body.length; i++) {
      if (body[i] === 135 && body[i + 1] === 6) {
        for (let j = i + 2; j < body.length && body[j] !== 135; j += 2) {
          if (body[j] === 132) { reserve = body[j + 1]; break; }
        }
        break;
      }
    }
    ok('reserve (132) for the pickup weapon is FINITE, not the 999999 infinity sentinel',
      reserve !== null && reserve < 999999, `reserve=${reserve}`);
    ok('reserve equals pool minus what\'s chambered (6 - 2 = 4)', reserve === 4, `reserve=${reserve}`);

    // A NORMAL gun (no pickupAmmo entry) still shows infinite reserve — the fix must not regress it.
    const q = srv.createPlayerSimState({ x: 0, y: 0, z: 0 }, 'hudB');
    q.equippedWeaponId = 4; q._ammoGunId = 4;
    const body2 = [];
    srv.appendPlayerTickBody(body2, 'hudB', q);
    let reserve2 = null;
    for (let i = 0; i < body2.length; i++) {
      if (body2[i] === 135 && body2[i + 1] === 4) {
        for (let j = i + 2; j < body2.length && body2[j] !== 135; j += 2) {
          if (body2[j] === 132) { reserve2 = body2[j + 1]; break; }
        }
        break;
      }
    }
    ok('a NORMAL gun still shows the infinity sentinel (999999)', reserve2 === 999999, `reserve=${reserve2}`);
  }

  console.log('\n── a non-equipped pickup weapon\'s HUD icon shows its TRUE remaining ammo ──');
  {
    // Reported live: after firing a pickup weapon and switching away, its icon in the weapon row
    // showed a FULL magazine again — only correcting itself once you switched back to it. The
    // underlying ammo state (playerState._pickupMagAmmo, playerState.pickupAmmo) was already
    // correct at this point (see the switch-restore fix above); this was purely the DISPLAY line
    // for a non-equipped slot still computing a fresh-reload preview instead of reading the same
    // remembered value the switch-restore logic uses.
    function readSlot(body, nid) {
      for (let i = 0; i < body.length; i++) {
        if (body[i] === 135 && body[i + 1] === nid) {
          const out = {};
          for (let j = i + 2; j < body.length && body[j] !== 135; j += 2) {
            if (body[j] === 132) out.reserve = body[j + 1];
            if (body[j] === 133) out.magazine = body[j + 1];
          }
          return out;
        }
      }
      return null;
    }
    const p = srv.createPlayerSimState({ x: 0, y: 0, z: 0 }, 'hudSwitch');
    p.equippedWeaponId = 4; p.weaponList = [4, 262]; p._ammoGunId = 4;
    srv._grantPickupWeapon(p, 8);   // Rocket Launcher: clipSize 1, pickUpSize 3
    // A pickup no longer auto-equips for a real player (see _grantPickupWeapon) — switch to it
    // explicitly, same as the player actually selecting it, before firing it in this test.
    p.equippedWeaponId = 8; p._ammoGunId = 8; p.gunAmmo = srv.weaponClip(8, p);
    p.switchTimer = 0; p.fireCooldown = 0;
    srv.preTickFire(p, [[1, [[5], [], [], [0, 0]]]]);   // fire the one round in the mag
    ok('fired: magazine now 0, pool now 2', p.gunAmmo === 0 && p.pickupAmmo[8] === 2,
      `gunAmmo=${p.gunAmmo} pool=${p.pickupAmmo[8]}`);

    p.equippedWeaponId = 4;   // switch away to the primary
    srv.preTickFire(p, [[1, [[], [], [], [0, 0]]]]);   // let the lazy switch-detect save the cache
    const body = [];
    srv.appendPlayerTickBody(body, 'hudSwitch', p);
    const slot = readSlot(body, 8);
    ok('the icon shows the TRUE remaining magazine (0), not a fresh-reload preview',
      slot && slot.magazine === 0, JSON.stringify(slot));
    ok('the icon\'s reserve reflects the same true state (2 left, none phantom-chambered)',
      slot && slot.reserve === 2, JSON.stringify(slot));
  }

  console.log('\n── weaponSlots shows EVERY carried weapon at once, not just the equipped one ──');
  {
    // This is the fix for "the weapon slots don't show up at once": the OLD implementation only
    // ever emitted a 135 block for the CURRENTLY EQUIPPED gun (+ the sword), and explicitly
    // deleted the previous one on every switch — correct when a player could only ever hold
    // [primary, sword], wrong once several pickups can be carried at once, since switching among
    // gear you still own isn't a removal.
    const p = srv.createPlayerSimState({ x: 0, y: 0, z: 0 }, 'slotsA');
    p.equippedWeaponId = 4; p.weaponList = [4, 262]; p._ammoGunId = 4;
    srv._grantPickupWeapon(p, 6);     // Sniper — auto-equips it
    srv._grantPickupWeapon(p, 282);   // SMG — auto-equips THIS instead; Sniper must NOT disappear
    p.equippedWeaponId = 4; p._ammoGunId = 4; p.gunAmmo = srv.weaponClip(4, p);   // switch to primary

    // Settle _prevEmitWeaponIds via the REAL sweep function first (this is what a real tick loop
    // does every tick, regardless of whether any particular recipient's body gets built).
    srv._advanceWeaponSlotTracking(p);

    const body = [];
    srv.appendPlayerTickBody(body, 'slotsA', p);
    const addedIds = [];
    const deletedIds = [];
    for (let i = 0; i < body.length; i++) {
      if (body[i] !== 135) continue;
      if (body[i + 1] === -1) deletedIds.push(body[i + 2]);
      else addedIds.push(body[i + 1]);
    }
    ok('the primary (4), Sniper (6), and SMG (282) are ALL present in the same tick body',
      [4, 6, 282].every((id) => addedIds.includes(id)), JSON.stringify(addedIds));
    ok('the sword (262) is present too', addedIds.includes(262));
    ok('nothing is deleted just from switching among weapons still carried',
      deletedIds.length === 0, JSON.stringify(deletedIds));

    console.log('\n── a slot is deleted ONLY when the weapon actually leaves weaponList ──');
    // Deplete the Sniper's pool so it auto-clears out of weaponList entirely.
    p.pickupAmmo[6] = 0;
    p.equippedWeaponId = 6; p._ammoGunId = 6; p.gunAmmo = 0;
    p.fireCooldown = 0; p.reloadTicks = 0;
    srv.preTickFire(p, [[1, [[], [], [], [0, 0]]]]);   // runs the spent-slot auto-clear check
    ok('the Sniper actually left weaponList', !p.weaponList.includes(6), JSON.stringify(p.weaponList));
    // The sweep is what actually DETECTS the removal and opens the re-announce window — see
    // _advanceWeaponSlotTracking's header comment for why that can't live inside
    // appendPlayerTickBody itself.
    srv._advanceWeaponSlotTracking(p);

    const body2 = [];
    srv.appendPlayerTickBody(body2, 'slotsA', p);
    const deleted2 = [];
    const added2 = [];
    for (let i = 0; i < body2.length; i++) {
      if (body2[i] !== 135) continue;
      if (body2[i + 1] === -1) deleted2.push(body2[i + 2]);
      else added2.push(body2[i + 1]);
    }
    ok('the Sniper\'s slot is deleted, and ONLY the Sniper\'s', JSON.stringify(deleted2) === JSON.stringify([6]),
      JSON.stringify(deleted2));
    ok('the SMG (still carried) is NOT deleted', !deleted2.includes(282));
    ok('the primary and SMG are still announced', added2.includes(4) && added2.includes(282),
      JSON.stringify(added2));

    console.log('\n── the delete survives a recipient body being SKIPPED entirely (backpressure) ──');
    // This is the actual confirmed live bug ("special weapon slot doesn't clear after dying and
    // respawning"): appendPlayerTickBody can be skipped ENTIRELY for a congested recipient
    // (backpressure, in the real broadcast loop) — so if the removal-detection lived inside that
    // function, the one tick it needed to fire on could be exactly the tick nothing ran, and the
    // re-announce window would never open at all. Simulate that: advance the sweep several times
    // WITHOUT ever calling appendPlayerTickBody in between (the "skipped" ticks), then confirm the
    // delete is still there once a body finally does get built again.
    const q = srv.createPlayerSimState({ x: 0, y: 0, z: 0 }, 'slotsB');
    q.equippedWeaponId = 4; q.weaponList = [4, 262]; q._ammoGunId = 4;
    srv._grantPickupWeapon(q, 7);   // Shotgun
    srv._advanceWeaponSlotTracking(q);
    srv._clearPickupSlot(q, 7);     // drop it (mirrors depletion/death)
    // Three "skipped" ticks — no appendPlayerTickBody call at all, only the sweep, exactly like a
    // backpressure-throttled recipient.
    srv._advanceWeaponSlotTracking(q);
    srv._advanceWeaponSlotTracking(q);
    srv._advanceWeaponSlotTracking(q);
    const body3 = [];
    srv.appendPlayerTickBody(body3, 'slotsB', q);
    const deleted3 = [];
    for (let i = 0; i < body3.length; i++) { if (body3[i] === 135 && body3[i + 1] === -1) deleted3.push(body3[i + 2]); }
    ok('the delete for the dropped Shotgun survived 3 skipped ticks',
      deleted3.includes(7), JSON.stringify(deleted3));
  }

  console.log('\n── processWeaponPickups: proximity grants, respects state, and respawns on cooldown ──');
  {
    S.set('weaponPickupsEnabled', true, 'test');
    S.set('botWeaponPickupsEnabled', true, 'test');
    S.set('weaponPickupRadius', 1.8, 'test');
    S.set('weaponPickupRespawnTicks', 50, 'test');
    // Force a single deterministic pickup point far from the real map's own points.
    Object.defineProperty(bpw, 'pickupPoints', { configurable: true, get: () => [{ x: 500, y: 500, z: 500 }] });
    srv._resetPickupState();

    const near = mkSession('pickA', 500.5, 500, 500.5, { equippedWeaponId: 4, weaponList: [4, 262], _ammoGunId: 4 });
    const far = mkSession('pickB', 900, 500, 900, { equippedWeaponId: 4, weaponList: [4, 262], _ammoGunId: 4 });
    const sessions = new Map([['pickA', near], ['pickB', far]]);

    srv.processWeaponPickups(sessions, 100);
    ok('the near player picked up the weapon', Object.keys(near.playerState.pickupAmmo).length === 1,
      JSON.stringify(near.playerState.pickupAmmo));
    ok('the far player did not', Object.keys(far.playerState.pickupAmmo).length === 0);
    const st = srv.getPickupState();
    ok('the point is now on cooldown (a fresh weapon is pre-rolled but hidden)',
      st[0].availableAtTick === 150, String(st[0].availableAtTick));
    ok('the pre-rolled weapon is a real pickup weapon id',
      srv.PICKUP_WEAPON_IDS.includes(st[0].weaponTypeId), String(st[0].weaponTypeId));

    // Before the cooldown elapses, nobody else can pick anything up there. A FRESH sessions map —
    // `near` (pickA) from the grant above is still standing right on the point, so leaving it in
    // the map would let IT re-grab the respawned weapon first (Map iteration order), masking
    // whether pickC actually could.
    const near2 = mkSession('pickC', 500.2, 500, 500.2, { equippedWeaponId: 4, weaponList: [4, 262], _ammoGunId: 4 });
    const soloSessions = new Map([['pickC', near2]]);
    srv.processWeaponPickups(soloSessions, 120);
    ok('nothing to grant while on cooldown', Object.keys(near2.playerState.pickupAmmo).length === 0);

    // After the cooldown, the point respawns and the still-waiting player grabs it in the same tick.
    srv.processWeaponPickups(soloSessions, 150);
    ok('the respawned weapon is granted once the cooldown elapses',
      Object.keys(near2.playerState.pickupAmmo).length === 1,
      JSON.stringify(near2.playerState.pickupAmmo));

    console.log('\n── a DEAD or held-for-play player never picks anything up ──');
    srv._resetPickupState();
    const dead = mkSession('pickD', 500.1, 500, 500.1,
      { equippedWeaponId: 4, weaponList: [4, 262], _ammoGunId: 4, deathStateTimer: 5 });
    srv.processWeaponPickups(new Map([['pickD', dead]]), 200);
    ok('a dead player does not pick up a weapon', Object.keys(dead.playerState.pickupAmmo).length === 0);

    srv._resetPickupState();
    const held = mkSession('pickE', 500.1, 500, 500.1,
      { equippedWeaponId: 4, weaponList: [4, 262], _ammoGunId: 4, _holdForPlay: true });
    srv.processWeaponPickups(new Map([['pickE', held]]), 200);
    ok('a held-for-play (not yet in match) player does not pick up a weapon',
      Object.keys(held.playerState.pickupAmmo).length === 0);

    console.log('\n── botWeaponPickupsEnabled: OFF blocks bots only, real players unaffected ──');
    srv._resetPickupState();
    S.set('botWeaponPickupsEnabled', false, 'test');
    const bot = mkSession('pickBot', 500.1, 500, 500.1,
      { equippedWeaponId: 4, weaponList: [4, 262], _ammoGunId: 4 }, );
    bot.isBot = true;
    srv.processWeaponPickups(new Map([['pickBot', bot]]), 300);
    ok('a bot does not pick up a weapon while the setting is off',
      Object.keys(bot.playerState.pickupAmmo).length === 0);

    const human = mkSession('pickHuman', 500.1, 500, 500.1,
      { equippedWeaponId: 4, weaponList: [4, 262], _ammoGunId: 4 });
    srv.processWeaponPickups(new Map([['pickHuman', human]]), 300);
    ok('a REAL PLAYER still picks up the weapon with the bot toggle off',
      Object.keys(human.playerState.pickupAmmo).length === 1);
    S.set('botWeaponPickupsEnabled', true, 'test');

    console.log('\n── disabling weaponPickupsEnabled is a hard off-switch for everyone ──');
    S.set('weaponPickupsEnabled', false, 'test');
    srv._resetPickupState();
    const off = mkSession('pickF', 500.1, 500, 500.1, { equippedWeaponId: 4, weaponList: [4, 262], _ammoGunId: 4 });
    srv.processWeaponPickups(new Map([['pickF', off]]), 400);
    ok('nothing is granted while weaponPickupsEnabled is false',
      Object.keys(off.playerState.pickupAmmo).length === 0);
    S.set('weaponPickupsEnabled', true, 'test');

    restoreRealPickupPoints();
  }

  console.log('\n── protocol stream: an index is ANNOUNCED ONCE and toggles hidden/visible, never deleted ──');
  {
    // This is the fix for "the model doesn't disappear after pickup": an EARLIER version of this
    // stream deleted the index (278,-1,i) while on cooldown, mirroring the grenade idiom — but the
    // client's pickup renderer (bundle :48363-48399) only removes an existing mesh from the scene
    // on the "Qwqshlj (273) is in the future" branch; a deleted index just makes it `continue`,
    // never touching whatever mesh was already built. So an index must live forever and toggle via
    // opcode 273 instead.
    Object.defineProperty(bpw, 'pickupPoints', {
      configurable: true, get: () => [{ x: 1, y: 1, z: 1 }, { x: 2, y: 2, z: 2 }],
    });
    srv._resetPickupState();
    const st = srv.getPickupState();
    st[0].weaponTypeId = 6; st[0].availableAtTick = 0;                       // available now
    st[1].weaponTypeId = 7; st[1].availableAtTick = 999999999;               // on cooldown

    const block = srv.buildWeaponPickupBlock();
    // Both indices get a CREATE (278, i) — never a delete (278, -1, i).
    ok('point 0 is announced (278, 0, ...)', block[0] === 278 && block[1] === 0);
    ok('point 1 is ALSO announced, not deleted (278, 1, ...) — this is the fix',
      (() => {
        for (let i = 0; i < block.length; i += 2) {
          if (block[i] === 278 && block[i + 1] === 1) return true;
        }
        return false;
      })());
    ok('the stream never emits a 278,-1 delete at all',
      !(() => { for (let i = 0; i < block.length; i++) if (block[i] === 278 && block[i + 1] === -1) return true; return false; })());

    // Field 273 (Qwqshlj) is what actually toggles visibility.
    const idx0 = block.indexOf(278);
    const field273of0 = block[idx0 + block.slice(idx0).indexOf(273) + 1];
    ok('the AVAILABLE point\'s hide-until-tick (273) is 0 — already in the past, visible',
      field273of0 === 0, String(field273of0));

    let idx1 = -1;
    for (let i = 0; i < block.length; i += 2) { if (block[i] === 278 && block[i + 1] === 1) { idx1 = i; break; } }
    const field273of1 = block[idx1 + block.slice(idx1).indexOf(273) + 1];
    ok('the ON-COOLDOWN point\'s hide-until-tick (273) is the far-future sentinel — hidden',
      field273of1 === srv.PICKUP_HIDE_SENTINEL, String(field273of1));

    // 275 (Qt34en0) must always be sent as null (see the pickup-model-never-renders fix).
    ok('275 is present and null for both points',
      block.filter((v, i) => v === 275).length === 2 && block[block.indexOf(275) + 1] === null);

    // 274 (Qwhlcdr) selects the glow sprite's style index — omitting it entirely made the renderer
    // fall back to its own opacity-0 default style, i.e. a glow sprite that exists but is invisible
    // (see the no-glow-at-all fix). Must be sent as a valid, non-negative palette index.
    ok('274 is present and a valid palette index for both points',
      block.filter((v) => v === 274).length === 2 && block[block.indexOf(274) + 1] === 0);

    const body = [244, 0, 280, 999];
    srv.flushWeaponPickups(body);
    ok('the spliced block sits before the trailing 280', (() => {
      const idx280 = body.indexOf(280);
      const idx278 = body.indexOf(278);
      return idx278 >= 0 && idx278 < idx280;
    })());

    restoreRealPickupPoints();
    srv._resetPickupState();
  }

  console.log('\n── source check: pickups run as an isolated tick phase ──');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    ok('pickups runs inside _phase', /_phase\("pickups"/.test(src));
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
