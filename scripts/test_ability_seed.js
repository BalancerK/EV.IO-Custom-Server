/**
 * test_ability_seed.js — the ability array is INDEXED BY ABILITY ID, so its length is meaningful.
 *
 * THE BUG THIS EXISTS FOR
 * ───────────────────────
 * A hardening pass length-capped the client's ability array at 16 to stop an oversized one being
 * retained per session. Ability ids run 0..16, so 16 dropped exactly one entry — id 16, the IMPULSE
 * grenade. The reported symptom was odd enough to be worth recording:
 *
 *     "the impulse grenade is gone in my loadout and is not showing on screen, but i can still use it"
 *
 * Gone from the HUD because the client builds the ability slots by walking Q3i8qs3.length (opcode 93,
 * bundle :65096), and the bootstrap carried the truncated array. Still usable because the loadout
 * arrives by THREE separate paths — the join, RPC 7, and the userscript's live push — and only the
 * join had been capped, so the live push quietly restored the full array to the physics state that
 * processGrenadeCast reads.
 *
 * Two lessons, both encoded below: a cap on an id-indexed array must come from the id table rather
 * than a round number, and the same input arriving by several paths must be sanitised in ONE place or
 * the paths drift apart.
 *
 * Usage:  node scripts/test_ability_seed.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';

const fs = require('fs');
const path = require('path');
const srv = require('../local_ws_server');
const sb = require('../state_builder');
const { ABILITY_TABLES, ABILITY_TIMER } = require('../ability_stats');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

const IMPULSE_ID = 16;
const opVal = (arr, op) => { const i = arr.indexOf(op); return i === -1 ? undefined : arr[i + 1]; };

console.log('\n── the cap is derived from the ability table, not chosen ──');
{
  const maxId = Math.max(...Object.keys(ABILITY_TABLES).map(Number));
  ok('every ability id fits', srv.MAX_ABILITY_SEED_LEN === maxId + 1,
    `cap=${srv.MAX_ABILITY_SEED_LEN} maxId=${maxId} — an id-indexed array needs maxId+1 entries`);
  ok('impulse is the last id', maxId === IMPULSE_ID,
    `maxId=${maxId} — it is last, which is why an off-by-one hit exactly it`);
  ok('every timed ability is inside the cap',
    Object.keys(ABILITY_TIMER).every((id) => Number(id) < srv.MAX_ABILITY_SEED_LEN),
    Object.keys(ABILITY_TIMER).join(','));
}

console.log('\n── a full loadout survives sanitisation ──');
{
  const seed = new Array(17).fill(0);
  seed[0] = 1;             // teleport
  seed[IMPULSE_ID] = 2;    // impulse, level 2
  const clean = srv._sanitizeAbilitySeed(seed);
  ok('the array keeps its length', clean.length === 17, String(clean.length));
  ok('impulse survives at its own index', clean[IMPULSE_ID] === 2, String(clean[IMPULSE_ID]));
  ok('and the ids below it are untouched', clean[0] === 1, String(clean[0]));
}

console.log('\n── impulse reaches the wire ──');
{
  // The HUD reads opcode 93. If the entry is absent the slot is simply not drawn, with no error
  // anywhere — which is why this went unnoticed until someone looked at their loadout.
  const seed = new Array(17).fill(0);
  seed[IMPULSE_ID] = 1;
  const body = sb.buildFirstSpawnBody({ playerId: 'p', abilitySeed: srv._sanitizeAbilitySeed(seed) });
  const onWire = opVal(body, 93);
  ok('opcode 93 carries all 17 slots', Array.isArray(onWire) && onWire.length === 17,
    `length ${onWire && onWire.length}`);
  ok('slot 16 is the impulse level, not undefined', onWire[IMPULSE_ID] === 1,
    String(onWire[IMPULSE_ID]));

  // The precise regression: a 16-long array leaves slot 16 undefined on the wire.
  const truncated = opVal(sb.buildFirstSpawnBody(
    { playerId: 'p', abilitySeed: seed.slice(0, 16) }), 93);
  ok('a 16-long array really does lose it', truncated[IMPULSE_ID] === undefined,
    'confirms the mechanism rather than assuming it');
}

console.log('\n── the array is still bounded ──');
{
  const huge = new Array(5000).fill(3);
  const clean = srv._sanitizeAbilitySeed(huge);
  ok('an oversized array is capped', clean.length === srv.MAX_ABILITY_SEED_LEN,
    `${clean.length} — it is retained per session and copied onto the physics state`);
  ok('values are still integers >= 0',
    srv._sanitizeAbilitySeed([-4, 1.9, NaN, 'x', Infinity]).every((v) => Number.isInteger(v) && v >= 0),
    JSON.stringify(srv._sanitizeAbilitySeed([-4, 1.9, NaN, 'x', Infinity])));
  ok('a non-array is survived', Array.isArray(srv._sanitizeAbilitySeed(null))
    && srv._sanitizeAbilitySeed(null).length === 0);
}

console.log('\n── all three loadout paths share one sanitiser ──');
{
  // The paths had drifted: only the join was capped. Whatever the rule is, it has to be the same rule
  // everywhere, or a fix to one path leaves the others behind — which is precisely what produced a
  // grenade that was missing from the HUD but still throwable.
  const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
  const uses = (src.match(/_sanitizeAbilitySeed\(/g) || []).length;
  ok('the join, RPC 7 and the live push all call it', uses >= 4,
    `${uses} references (definition + 3 call sites)`);
  const adhoc = src.split(/\r?\n/).filter((l) =>
    !/^\s*(\/\/|\*)/.test(l)
    && /abilitySeed\s*=/.test(l)
    && /\.map\(/.test(l)
    && !/_sanitizeAbilitySeed/.test(l));
  ok('no path sanitises inline any more', adhoc.length === 0,
    adhoc.map((l) => l.trim().slice(0, 80)).join(' | '));
}

console.log('\n── a cast is gated on the same array the HUD is drawn from ──');
{
  // The two must agree. When they disagreed, "can throw it" and "can see it" came apart, and that is
  // the confusing half of the report — a purely cosmetic-looking bug with a state cause.
  const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
  ok('processGrenadeCast reads ps.weaponStateArray',
    /const arr = ps\.weaponStateArray/.test(src));
  ok('and every path sets it from the sanitised seed',
    (src.match(/weaponStateArray = session\.abilitySeed/g) || []).length >= 3,
    'join + RPC 7 + live push');
}

// The blocks below need a real _ps (the computed stats live on it), which only exists once the
// collision world has been built.
require('../physics_world').ready.then(() => {

console.log('\n── every ability id is accounted for ──');
{
  // Sweeping all 17 rather than only the one that broke. Two had been left as `skip: true` with the
  // note "not implemented", and one of those (Extra Clip Size) is read by the CLIENT to size the
  // magazine — so skipping it server-side was a live ammo divergence, not a missing feature.
  const unimplemented = [];
  for (const id of Object.keys(ABILITY_TABLES).map(Number).sort((a, b) => a - b)) {
    const def = ABILITY_TABLES[id];
    if (def.skip || !def.keys || !def.vals) unimplemented.push(`${id} ${def.name}`);
  }
  ok('no ability is silently skipped', unimplemented.length === 0, unimplemented.join(', '));

  // Every ability must actually change a stat, or its points do nothing.
  const { computeWeaponStats, baseWeaponStats } = require('../ability_stats');
  const base = baseWeaponStats(1);
  const inert = [];
  for (const id of Object.keys(ABILITY_TABLES).map(Number)) {
    const seed = new Array(srv.MAX_ABILITY_SEED_LEN).fill(0);
    seed[id] = 1;
    const withIt = computeWeaponStats(seed);
    if (Object.keys(base).every((k) => base[k] === withIt[k])) inert.push(`${id} ${ABILITY_TABLES[id].name}`);
  }
  ok('spending a point on any ability changes some stat', inert.length === 0, inert.join(', '));
}

console.log('\n── the two abilities our own ammo code has to honour ──');
{
  // These bypass the physics state: the magazine and reload timer are computed by hand-written server
  // code from the weapon catalogue, so unlike the movement stats they do NOT come along for free when
  // the computed stats are assigned onto Qz8l93a.
  const { computeWeaponStats } = require('../ability_stats');
  const NID = 4;   // Auto Rifle

  const plain = srv.createPlayerSimState();
  plain._ammoGunId = NID;
  // Baselines come from the CATALOGUE (no player), not from a fresh player state. A fresh state
  // already carries the default loadout — which includes Quick Load 1, so Qvven1v is 3 before anyone
  // spends a point. Measuring "base" off it made level 1 look like it did nothing.
  const baseClip = srv.weaponClip(NID);
  const baseReload = srv.weaponReloadTicks(NID);

  // Extra Clip Size (id 6): the client uses ceil(clipSize * Qe2qk8v) at bundle :34635.
  for (const [lvl, mult] of [[1, 1.25], [2, 1.5], [3, 1.75]]) {
    const st = srv.createPlayerSimState();
    st._ammoGunId = NID;
    const seed = new Array(srv.MAX_ABILITY_SEED_LEN).fill(0);
    seed[6] = lvl;
    Object.assign(st._ps.Qz8l93a, computeWeaponStats(seed));
    const want = Math.ceil(baseClip * mult);
    ok(`Extra Clip Size ${lvl} -> ${want} rounds`, srv.weaponClip(NID, st) === want,
      `got ${srv.weaponClip(NID, st)} from base ${baseClip}`);
  }

  // Quick Load (id 4): the client uses floor(cooldown2 - Qvven1v) at bundle :43982.
  for (const [lvl, bonus] of [[1, 3], [2, 6], [3, 9]]) {
    const st = srv.createPlayerSimState();
    st._ammoGunId = NID;
    const seed = new Array(srv.MAX_ABILITY_SEED_LEN).fill(0);
    seed[4] = lvl;
    Object.assign(st._ps.Qz8l93a, computeWeaponStats(seed));
    ok(`Quick Load ${lvl} -> ${baseReload - bonus} ticks`,
      srv.weaponReloadTicks(NID, st) === baseReload - bonus,
      `got ${srv.weaponReloadTicks(NID, st)} from base ${baseReload}`);
  }

  // A fresh state carries the DEFAULT loadout, so its reload is already the base minus Quick Load 1.
  // That is correct behaviour, and worth asserting explicitly so the 3-tick offset is documented
  // rather than rediscovered as a mystery.
  ok('a fresh player has the default loadout applied',
    srv.weaponClip(NID, plain) === baseClip
    && srv.weaponReloadTicks(NID, plain) === baseReload - 3,
    `clip ${srv.weaponClip(NID, plain)}/${baseClip}, `
    + `reload ${srv.weaponReloadTicks(NID, plain)} vs base ${baseReload} (default has Quick Load 1)`);
  ok('a call with no player still works', srv.weaponClip(NID) === baseClip,
    'a fresh state has no stats yet, and must get the base value');
  ok('the sword is unaffected', srv.weaponClip(262, plain) === srv.weaponClip(262),
    'it has no magazine');
}

console.log('\n── capacity is applied AFTER the stats, not before ──');
{
  // Every loadout path sets gunAmmo and THEN assigns the computed stats, so the capacity was always
  // derived from a multiplier of 1. The ability existed, the stat was right, and the magazine was
  // still base-sized for the life you joined with.
  const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
  const assigns = (src.match(/Object\.assign\(playerState\._ps\.Qz8l93a, computeWeaponStats/g) || []).length;
  const refreshes = (src.match(/refreshMagazineCapacity\(playerState\)/g) || []).length;
  ok('every stats assignment is followed by a magazine refresh', refreshes >= assigns,
    `${assigns} assignments, ${refreshes} refreshes`);

  const { computeWeaponStats } = require('../ability_stats');
  const st = srv.createPlayerSimState();
  st._ammoGunId = 4;
  st.gunAmmo = srv.weaponClip(4, st);            // sized with base stats, as the join does
  const before = st.gunAmmo;
  const seed = new Array(srv.MAX_ABILITY_SEED_LEN).fill(0);
  seed[6] = 3;
  Object.assign(st._ps.Qz8l93a, computeWeaponStats(seed));
  srv.refreshMagazineCapacity(st);
  ok('the refresh picks up the new capacity', st.gunAmmo > before,
    `${before} -> ${st.gunAmmo}`);
}

console.log('\n── and one we correctly do NOT implement ──');
{
  // Melee Damage (id 7) sets Qc804je, which the CLIENT never reads — it is written in the ability
  // table and consumed nowhere. Implementing it would make our melee damage disagree with the damage
  // the client predicts locally, which is the health-bar-snaps-back artefact. Not-implemented is the
  // parity-correct choice here, so it is recorded rather than left looking like an oversight.
  const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
  ok('Qc804je is not used in damage', !/Qc804je/.test(src),
    'the client defines it but never reads it');
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);

});
