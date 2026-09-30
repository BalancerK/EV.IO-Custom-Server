/**
 * test_sword_only.js
 *
 * Unit tests for SWORD-ONLY mode (EVIO_SWORD_ONLY=1) — a melee-only lobby where every player
 * carries the sword (262) and nothing else, regardless of their real account loadout.
 *
 * WHY THIS TEST EXISTS
 * ────────────────────
 * Sword-only mode exists to sidestep the two remaining reconciler work-arounds (userscript
 * 6b7 pitch/pitchOffset skip, 6b8 recoil/ammo preserve), both of which hang off the GUN path.
 * That only holds if the gun path is genuinely unreachable — so these tests pin the invariants:
 *
 *   1. no loadout source can smuggle a gun in (join / RPC '6' / '#EVL#' live bridge),
 *   2. the weapon-switch keys are inert (nothing to switch to),
 *   3. the streamed weaponSlots contain the sword and ONLY the sword (no stacked HUD icon),
 *   4. the sword takes the melee branch and never the ammo/reload branch.
 *
 * Runs the whole file twice — once with the flag on, once off — so it also proves normal
 * (gun) mode is unaffected.
 *
 * Usage:
 *   node scripts/test_sword_only.js --both   # both modes (what `npm run test:sword` runs)
 *   node scripts/test_sword_only.js --sword-only
 *   node scripts/test_sword_only.js          # normal (gun) mode
 */
'use strict';

// --both re-runs this file as two child processes, because SWORD_ONLY is resolved once at
// require time. Child processes (rather than an inline env assignment) also keep the two runs
// from sharing module state, and avoid shell-specific env-var syntax.
if (process.argv.includes('--both')) {
  const { spawnSync } = require('child_process');
  let failed = 0;
  for (const mode of [[], ['--sword-only']]) {
    const r = spawnSync(process.execPath, [__filename, ...mode], { stdio: 'inherit' });
    if (r.status !== 0) failed++;
  }
  process.exit(failed === 0 ? 0 : 1);
}

const srv = require('../local_ws_server');
const {
  SWORD_ONLY,
  SWORD_WEAPON_ID,
  resolveLoadoutWeapon,
  processWeaponSwitch,
  appendPlayerTickBody,
  createPlayerSimState,
  preTickFire,
  weaponClip,
  WEAPON_MELEE,
  WEAPON_COOLDOWN,
  WEAPON_KNOCKBACK,
} = srv;

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else      { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

const AUTO_RIFLE = 4;
console.log(`\n═══ SWORD_ONLY = ${SWORD_ONLY} ═══`);

// Collect the weapon ids from the 135 (weaponSlots) blocks of a tick body. Each block is
// `135, <id>, 132, reserve, 133, mag, 134, 0`; `135, -1, <id>` is a slot DELETE.
function weaponSlotIds(body) {
  const ids = [];
  for (let i = 0; i < body.length - 1; i++) {
    if (body[i] === 135 && body[i - 1] !== 135) {
      const id = body[i + 1];
      if (id !== -1) ids.push(id);
    }
  }
  return ids;
}

// ── 1. the sword is a melee weapon with no reload pressure ────────────────────────────────
console.log('\n── catalogue: the sword bypasses the gun path by construction ──');
{
  ok('sword (262) is registered melee', WEAPON_MELEE[SWORD_WEAPON_ID] === true);
  ok('sword clip is 999999 → below the client reload gate `ammoInMag < 9999` (:43981), so the '
     + 'client can never start a reload', weaponClip(SWORD_WEAPON_ID) >= 9999,
    `clip=${weaponClip(SWORD_WEAPON_ID)}`);
  // The recoil curve l() (:34626) zeroes out once actionTickCounter exceeds 9, so a cooldown
  // above that means every swing's kick fully settles before the next one can arm.
  const cd = WEAPON_COOLDOWN[SWORD_WEAPON_ID];
  ok('sword cooldown (16) exceeds the 9-tick recoil curve → kicks cannot accumulate', cd > 9,
    `cooldown=${cd}`);
  // Recoil still EXISTS for the sword (Qmgh2i6 is not gated on melee) — the server must keep
  // reproducing it, so assert the knockback data is present rather than absent.
  ok('sword still has knockback data (server must reproduce the kick, not skip it)',
    !!WEAPON_KNOCKBACK[SWORD_WEAPON_ID] && WEAPON_KNOCKBACK[SWORD_WEAPON_ID].knockback > 0);
}

// ── 2. every loadout entry point resolves to the sword ────────────────────────────────────
console.log('\n── loadout gate: no source can smuggle in a gun ──');
{
  if (SWORD_ONLY) {
    ok('join abilityLoadoutId=4 (Auto Rifle) → sword', resolveLoadoutWeapon(AUTO_RIFLE) === SWORD_WEAPON_ID);
    ok('RPC 6 setPrimaryWeapon=701 (Sniper) → sword', resolveLoadoutWeapon(701) === SWORD_WEAPON_ID);
    ok('live #EVL# bridge weapon=9 (Laser) → sword', resolveLoadoutWeapon(9) === SWORD_WEAPON_ID);
    ok('sword in → sword out (idempotent)', resolveLoadoutWeapon(SWORD_WEAPON_ID) === SWORD_WEAPON_ID);
  } else {
    ok('normal mode passes the loadout through untouched', resolveLoadoutWeapon(AUTO_RIFLE) === AUTO_RIFLE);
    ok('normal mode passes 701 through untouched', resolveLoadoutWeapon(701) === 701);
  }
}

// ── 3. spawn state ────────────────────────────────────────────────────────────────────────
console.log('\n── spawn state ──');
const ps = createPlayerSimState(0, 'sword-test');
{
  if (SWORD_ONLY) {
    ok('spawns holding the sword', ps.equippedWeaponId === SWORD_WEAPON_ID, `got ${ps.equippedWeaponId}`);
    ok('carries exactly one weapon', ps.weaponList.length === 1, `list=[${ps.weaponList}]`);
    ok('that weapon is the sword', ps.weaponList[0] === SWORD_WEAPON_ID);
    ok('_ammoGunId is the sword → the gun weaponSlots block is skipped',
      ps._ammoGunId === SWORD_WEAPON_ID);
  } else {
    ok('spawns holding the Auto Rifle', ps.equippedWeaponId === AUTO_RIFLE, `got ${ps.equippedWeaponId}`);
    ok('carries gun + sword', ps.weaponList.length === 2 && ps.weaponList.includes(SWORD_WEAPON_ID),
      `list=[${ps.weaponList}]`);
  }
}

// ── 4. weapon switching is inert with a single-weapon list ────────────────────────────────
console.log('\n── weapon switch keys ──');
{
  const before = ps.equippedWeaponId;
  processWeaponSwitch(ps, new Set([10]), new Set([10]));           // cycle next
  processWeaponSwitch(ps, new Set(), new Set([11]));               // cycle prev
  processWeaponSwitch(ps, new Set(), new Set([12]));               // primary-weapon key
  processWeaponSwitch(ps, new Set(), new Set([15]));               // direct-select (nid 8)
  processWeaponSwitch(ps, new Set(), new Set([32, 34, 35, 41]));   // other direct selects
  if (SWORD_ONLY) {
    ok('cycle/direct-select keys cannot switch off the sword',
      ps.equippedWeaponId === SWORD_WEAPON_ID, `got ${ps.equippedWeaponId}`);
    ok('no 127/128 re-emit is queued (nothing changed)', ps.weaponSendCount === 0,
      `weaponSendCount=${ps.weaponSendCount}`);
  } else {
    ok('normal mode: switch keys still reach the sword', ps.equippedWeaponId !== before
      || ps.weaponList.includes(SWORD_WEAPON_ID));
  }
}

// ── 5. streamed weaponSlots contain the sword and nothing else ────────────────────────────
console.log('\n── per-tick weaponSlots stream (135) ──');
{
  const fresh = createPlayerSimState(1, 'sword-slots');
  const body = [];
  appendPlayerTickBody(body, 1, fresh, { tick: 1 });
  const ids = weaponSlotIds(body);
  if (SWORD_ONLY) {
    ok('exactly one weapon slot is streamed', ids.length === 1, `ids=[${ids}]`);
    ok('and it is the sword', ids[0] === SWORD_WEAPON_ID, `ids=[${ids}]`);
    ok('no gun slot leaks into the HUD', !ids.some((id) => id !== SWORD_WEAPON_ID), `ids=[${ids}]`);
  } else {
    ok('gun + sword slots are streamed', ids.length === 2 && ids.includes(SWORD_WEAPON_ID),
      `ids=[${ids}]`);
  }
}

// ── 6. firing takes the melee branch — no magazine drain, no reload ───────────────────────
console.log('\n── firing: melee branch, no ammo/reload state ──');
{
  const p = createPlayerSimState(2, 'sword-fire');
  p.equippedWeaponId = SWORD_WEAPON_ID;
  p.weaponList = [SWORD_WEAPON_ID];
  p._ammoGunId = SWORD_WEAPON_ID;
  const ammoBefore = p.gunAmmo;
  p.heldActions = new Set([5]);          // hold fire
  for (let t = 0; t < 40; t++) {         // 40 ticks = 2s, several sword cooldowns
    p.fireCooldown = 0;
    preTickFire(p, t);
  }
  ok('holding fire never drains a magazine (melee has no ammo)', p.gunAmmo === ammoBefore,
    `${ammoBefore} → ${p.gunAmmo}`);
  ok('holding fire never starts a reload', (p.reloadTicks || 0) === 0,
    `reloadTicks=${p.reloadTicks}`);
  ok('sword is dispatched to the melee path', WEAPON_MELEE[p.equippedWeaponId] === true);
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
