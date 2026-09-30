/**
 * test_combat.js
 *
 * Unit tests for the server-authoritative combat loop (Milestone 6):
 * hitscan geometry → damage (armor then health) → death → respawn.
 *
 * WHY THIS TEST EXISTS
 * ────────────────────
 * The combat loop in local_ws_server.js computes damage that the client's
 * reconciler will REVERT if it doesn't match the client's own formula
 * (dmg * 0.01 * hitMult * lobbyMult). These tests pin the pure pieces of that
 * loop — the ray/box intersection, the armor-then-health absorption, and the
 * death→respawn state machine — so a regression is caught without needing a
 * full two-client browser session.
 *
 * Full end-to-end line-of-sight hitscan (ray vs the real Bishop collision mesh)
 * is verified live in-browser; here we lock down the deterministic math.
 *
 * Usage:
 *   node scripts/test_combat.js
 */
'use strict';

// Lag comp defaults ON; keep it on for the history test (recordPositionSnapshot no-ops when off).
process.env.EVIO_LAGCOMP = process.env.EVIO_LAGCOMP || '1';

const srv = require('../local_ws_server');
const {
  rayVsPlayerBox,
  applyDamage,
  processDeathRespawn,
  activeSpawnPoints,
  WEAPON_DMG,
  WEAPON_COOLDOWN,
  WEAPON_KNOCKBACK,
  weaponCooldownTicks,
  armRecoil,
  recordPositionSnapshot,
  positionAtTick,
  combatConstants: C,
} = srv;

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else      { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
function approx(a, b, eps = 1e-4) { return Math.abs(a - b) <= eps; }

// ── 1. rayVsPlayerBox geometry ────────────────────────────────────────────────
// Victim feet at origin: box spans x∈[-0.5,0.5], y∈[0,1.8], z∈[-0.5,0.5].
console.log('\n── rayVsPlayerBox (ray vs axis-aligned player box) ──');
{
  const victim = { x: 0, y: 0, z: 0 };

  // Level body shot from 5 units back along +z, eye at chest height.
  const body = rayVsPlayerBox({ x: 0, y: 1.0, z: -5 }, { x: 0, y: 0, z: 1 }, victim);
  ok('level shot hits the body', body !== null && body.head === false,
    body ? `head=${body.head}` : 'returned null');
  ok('hit distance is the near box face (z=-0.5 → 4.5u)',
    body !== null && approx(body.dist, 4.5), body ? `dist=${body.dist}` : 'null');

  // Shot aimed above HEAD_Y (1.65) lands in the top slab → headshot.
  const head = rayVsPlayerBox({ x: 0, y: 1.7, z: -5 }, { x: 0, y: 0, z: 1 }, victim);
  ok('shot above HEAD_Y registers as a headshot', head !== null && head.head === true,
    head ? `y@hit=1.7 head=${head.head}` : 'null');

  // Ray parallel to +z but offset in x past the half-width → miss.
  const sideMiss = rayVsPlayerBox({ x: 5, y: 1.0, z: -5 }, { x: 0, y: 0, z: 1 }, victim);
  ok('shot wide of the body misses (x past half-width)', sideMiss === null);

  // Target is behind the shooter (shooter past the box, still facing +z) → miss.
  const behindMiss = rayVsPlayerBox({ x: 0, y: 1.0, z: 5 }, { x: 0, y: 0, z: 1 }, victim);
  ok('target behind the shooter is not hit', behindMiss === null);

  // A shot just below the feet plane that never enters the box → miss.
  const lowMiss = rayVsPlayerBox({ x: 0, y: -1.0, z: -5 }, { x: 0, y: 0, z: 1 }, victim);
  ok('shot below the feet plane misses', lowMiss === null);
}

// ── 2. applyDamage (armor absorbs first, then health; death at 0) ──────────────
console.log('\n── applyDamage (armor → health absorption, death trigger) ──');
{
  // Plain health damage, no armor.
  const a = { armorPoints: 0, healthPoints: 1, deathStateTimer: 0 };
  applyDamage(a, 0.3);
  ok('health-only damage reduces HP', approx(a.healthPoints, 0.7) && a.deathStateTimer === 0,
    `hp=${a.healthPoints}`);

  // Armor fully absorbs a small hit — health untouched.
  const b = { armorPoints: 0.5, healthPoints: 1, deathStateTimer: 0 };
  applyDamage(b, 0.3);
  ok('armor absorbs damage before health',
    approx(b.armorPoints, 0.2) && approx(b.healthPoints, 1),
    `armor=${b.armorPoints} hp=${b.healthPoints}`);

  // Damage exceeding armor spills the remainder into health.
  const c = { armorPoints: 0.2, healthPoints: 1, deathStateTimer: 0 };
  applyDamage(c, 0.5);
  ok('overflow past armor spills into health',
    approx(c.armorPoints, 0) && approx(c.healthPoints, 0.7),
    `armor=${c.armorPoints} hp=${c.healthPoints}`);

  // Lethal hit floors HP at 0 and arms the death timer exactly once.
  const d = { armorPoints: 0, healthPoints: 0.2, deathStateTimer: 0 };
  applyDamage(d, 0.5);
  ok('lethal hit floors HP at 0 (no negative)', approx(d.healthPoints, 0), `hp=${d.healthPoints}`);
  ok('lethal hit starts the death state (timer=1)', d.deathStateTimer === 1, `timer=${d.deathStateTimer}`);

  // A second hit on an already-dead player must not re-arm / reset the timer.
  d.deathStateTimer = 5;       // simulate the death timer already advancing
  applyDamage(d, 0.5);
  ok('extra damage on a dead player does not reset the death timer',
    d.deathStateTimer === 5, `timer=${d.deathStateTimer}`);
}

// ── 3. processDeathRespawn (timer advance → respawn after RESPAWN_TICKS) ────────
console.log('\n── processDeathRespawn (death timer → respawn) ──');
{
  const p = {
    healthPoints: 0, armorPoints: 0, deathStateTimer: 1, fireCooldown: 0, spawnSeed: 0,
    position: { x: 999, y: 999, z: 999 },
    velocity: { x: 5, y: 5, z: 5 },
    _ps: { Qdsukt4: { x: 999, y: 999, z: 999 }, Qyaswvo: { x: 5, y: 5, z: 5 } },
  };
  const sessions = new Map([['s', { accepted: true, playerState: p }]]);

  // Advance up to (but not past) the respawn threshold: still dead.
  for (let i = 0; i < C.RESPAWN_TICKS - 1; i++) processDeathRespawn(sessions);
  ok(`still dead before ${C.RESPAWN_TICKS} ticks elapse`,
    p.deathStateTimer > 0 && p.healthPoints === 0,
    `timer=${p.deathStateTimer} hp=${p.healthPoints}`);

  // A couple more ticks cross the threshold and trigger respawn.
  processDeathRespawn(sessions);
  processDeathRespawn(sessions);
  ok('respawn clears the death state', p.deathStateTimer === 0, `timer=${p.deathStateTimer}`);
  ok('respawn restores full health, no armor', approx(p.healthPoints, 1) && approx(p.armorPoints, 0),
    `hp=${p.healthPoints} armor=${p.armorPoints}`);
  ok('respawn zeroes velocity',
    p.velocity.x === 0 && p.velocity.y === 0 && p.velocity.z === 0,
    `vel=(${p.velocity.x},${p.velocity.y},${p.velocity.z})`);

  const spawns = activeSpawnPoints();
  const movedToSpawn = Array.isArray(spawns) && spawns.length > 0
    ? spawns.some(s => approx(s.x, p.position.x) && approx(s.z, p.position.z))
    : (p.position.x !== 999);   // fallback GROUND spawn still moves off the death position
  ok('respawn moves the player to a real spawn point', movedToSpawn,
    `pos=(${p.position.x},${p.position.y},${p.position.z})`);
  ok('respawn syncs the physics-state position to the sim position',
    p._ps.Qdsukt4.x === p.position.x && p._ps.Qdsukt4.z === p.position.z);
}

// ── 4. Damage formula sanity (matches the client getDmg formula) ───────────────
console.log('\n── damage formula (dmg × 0.01 × hitMult × lobbyMult) ──');
{
  const weaponCount = WEAPON_DMG && typeof WEAPON_DMG === 'object' ? Object.keys(WEAPON_DMG).length : 0;
  if (weaponCount === 0) {
    console.log('  (skipped: weapon catalogue not loaded in this environment)');
  } else {
    // nid 4 is the default equipped weapon; fall back to the first catalogue entry.
    const nid = WEAPON_DMG[4] != null ? 4 : Number(Object.keys(WEAPON_DMG)[0]);
    const base = WEAPON_DMG[nid];
    const bodyDmg = base * C.DMG_GLOBAL_MULT * 1 * C.LOBBY_DAMAGE_MULT;
    const headDmg = base * C.DMG_GLOBAL_MULT * C.HEADSHOT_MULT * C.LOBBY_DAMAGE_MULT;
    const shotsToKill = Math.ceil(1 / bodyDmg);
    console.log(`  weapon nid=${nid} base=${base} bodyDmg=${bodyDmg.toFixed(4)} headDmg=${headDmg.toFixed(4)} shotsToKill=${shotsToKill}`);

    ok('a single body shot is not an instant kill (bodyDmg < 1.0 HP)', bodyDmg < 1.0,
      `bodyDmg=${bodyDmg.toFixed(4)}`);
    ok('a headshot does 1.5× a body shot', approx(headDmg, bodyDmg * 1.5),
      `head=${headDmg.toFixed(4)} body*1.5=${(bodyDmg * 1.5).toFixed(4)}`);
    ok('shots-to-kill is a sane positive count', shotsToKill >= 1 && shotsToKill <= 100,
      `shotsToKill=${shotsToKill}`);
  }
}

// ── 5. Per-weapon fire cooldown (replaces the old fixed FIRE_COOLDOWN_TICKS=3) ──────────────
console.log('\n── weaponCooldownTicks (per-weapon fire rate from the catalogue) ──');
{
  const have = WEAPON_COOLDOWN && Object.keys(WEAPON_COOLDOWN).length > 0;
  if (!have) {
    console.log('  (skipped: weapon catalogue not loaded in this environment)');
  } else {
    // Catalogue values: Auto Rifle(4)=2, Sniper(6)=26, Sweeper(701)=1.
    ok('Auto Rifle (nid 4) fires fast (cooldown 2 ticks)', weaponCooldownTicks(4) === 2,
      `got ${weaponCooldownTicks(4)}`);
    ok('Sniper (nid 6) fires slow (cooldown 26 ticks)', weaponCooldownTicks(6) === 26,
      `got ${weaponCooldownTicks(6)}`);
    ok('a fast weapon is no longer throttled to the old fixed 3', weaponCooldownTicks(4) < 3,
      `Auto Rifle=${weaponCooldownTicks(4)}`);
    ok('a slow weapon is no longer sped up to the old fixed 3', weaponCooldownTicks(6) > 3,
      `Sniper=${weaponCooldownTicks(6)}`);
  }
  ok('unknown weapon falls back to a sane cooldown (3)', weaponCooldownTicks(999999) === 3,
    `got ${weaponCooldownTicks(999999)}`);
  ok('cooldown never drops below 1 tick', weaponCooldownTicks(701) >= 1,
    `Sweeper=${weaponCooldownTicks(701)}`);
}

// ── 6. Lag-comp position history keyed by SERVER tick (rewind to the shooter's view tick) ─────
console.log('\n── lag-comp position history (recordPositionSnapshot / positionAtTick) ──');
{
  ok('lag compensation is enabled for this test', C.LAGCOMP === true, `LAGCOMP=${C.LAGCOMP}`);

  // A session whose physics-state feet position we move one unit per server tick along +x:
  // at server tick T the player is at x=T.
  const ps = { Qdsukt4: { x: 0, y: 5, z: 0 } };
  const session = { playerState: { _ps: ps } };
  for (let t = 10; t <= 20; t++) {
    ps.Qdsukt4.x = t;
    recordPositionSnapshot(session, t);     // keyed by server tick T
  }
  ok('history records one entry per server tick', session._posHistory.length === 11,
    `len=${session._posHistory.length}`);

  // Rewind to where the shooter saw the target: its position AT the shooter's view tick.
  const at15 = positionAtTick(session, 15);
  ok('positionAtTick returns the position at that exact server tick', at15 && approx(at15.x, 15),
    at15 ? `x=${at15.x}` : 'null');

  // A view tick with no exact entry falls back to the nearest earlier tick (interp-floor).
  const at20 = positionAtTick(session, 20);
  ok('positionAtTick(latest) = latest position', at20 && approx(at20.x, 20), at20 ? `x=${at20.x}` : 'null');

  ok('view tick older than all history returns null (caller uses live pos)',
    positionAtTick(session, 5) === null);

  // Catch-up: many client ticks within ONE server tick collapse to a single (final) entry.
  ps.Qdsukt4.x = 99; recordPositionSnapshot(session, 20);   // same server tick 20 again
  ps.Qdsukt4.x = 100; recordPositionSnapshot(session, 20);
  ok('repeated same-tick records overwrite (one entry per server tick)',
    session._posHistory.filter(e => e.tick === 20).length === 1 && approx(positionAtTick(session, 20).x, 100),
    `count=${session._posHistory.filter(e => e.tick === 20).length}`);

  // Ring cap.
  for (let t = 21; t <= 300; t++) { ps.Qdsukt4.x = t; recordPositionSnapshot(session, t); }
  ok('history is ring-capped (does not grow unbounded)', session._posHistory.length <= 64,
    `len=${session._posHistory.length}`);

  // Interpolated rewind: lerp between the two server ticks the client interpolated (x = tick).
  const { positionAtTickInterp } = srv;
  const mid = positionAtTickInterp(session, 280, 281, 0.5);   // halfway between x=280 and x=281
  ok('interp rewind lerps between prev/curr tick (alpha 0.5 = midpoint)', mid && approx(mid.x, 280.5),
    mid ? `x=${mid.x}` : 'null');
  const at1 = positionAtTickInterp(session, 280, 281, 1);
  ok('interp alpha 1 = the newer (curr) tick position', at1 && approx(at1.x, 281), at1 ? `x=${at1.x}` : 'null');
  const at0 = positionAtTickInterp(session, 280, 281, 0);
  ok('interp alpha 0 = the older (prev) tick position', at0 && approx(at0.x, 280), at0 ? `x=${at0.x}` : 'null');
  ok('interp with invalid window (prev>=curr) falls back to curr',
    approx(positionAtTickInterp(session, 281, 280, 0.5).x, 280));

  // Sub-frame shot: the firing render alpha = frameDeltaTime of the FIRST Shoot-held sub-frame.
  const { firingAlphaFromFrames } = srv;
  // frame = [frameDeltaTime, [held, pressed, released, mouseAxes, ...]]; held includes 5 = Shoot.
  const frames = [
    [0.20, [[0, 7], [], [], [0, 0]]],         // moving, not shooting
    [0.55, [[0, 7, 5], [], [], [0, 0]]],      // shoot held here → alpha 0.55
    [0.90, [[0, 5], [], [], [0, 0]]],
  ];
  ok('firing alpha = first shoot-held sub-frame frameDeltaTime', approx(firingAlphaFromFrames(frames), 0.55),
    `got ${firingAlphaFromFrames(frames)}`);
  ok('no shoot-held sub-frame → alpha 1 (end-of-tick)',
    firingAlphaFromFrames([[0.3, [[0], [], [], [0, 0]]]]) === 1);
  ok('missing/garbage frames → alpha 1', firingAlphaFromFrames(null) === 1);
}

// ── 7. Server-side recoil arming (the per-shot-stutter fix) ──────────────────────────────────
// The client kicks PITCH on every shot (reconciled field); the server must reproduce it or the
// prediction diverges each shot. armRecoil mirrors the client's Qmgh2i6: it only arms when the
// action-tick counter (Qezh4wz) is 0, scaling the kick by the weapon's knockback/knockbackMax.
console.log('\n── armRecoil (server reproduces the client recoil curve) ──');
{
  // Arms only on the shot tick (Qezh4wz === 0).
  const psArmed = { Qezh4wz: 0, Qm2pxgr: 0, Qq1azjr: 0, Qq1azd5: 0, Qgk2mcg: false };
  armRecoil(psArmed, 4);   // Auto Rifle (knockback 0.75 / knockbackMax 1.5)
  ok('a shot (counter=0) arms a positive recoil magnitude', psArmed.Qq1azd5 > 0,
    `Qq1azd5=${psArmed.Qq1azd5}`);

  // Does NOT arm when the counter is non-zero (mid-cooldown ticks).
  const psMid = { Qezh4wz: 4, Qm2pxgr: 0, Qq1azjr: 0, Qq1azd5: 0, Qgk2mcg: false };
  armRecoil(psMid, 4);
  ok('no recoil arming on non-shot ticks (counter≠0)', psMid.Qq1azd5 === 0, `Qq1azd5=${psMid.Qq1azd5}`);

  // Matches the exact Qmgh2i6 formula for a known weapon.
  if (WEAPON_KNOCKBACK && WEAPON_KNOCKBACK[4]) {
    const kb = WEAPON_KNOCKBACK[4];
    const expected = 0 + 0.5 * (kb.knockbackMax - 0) * kb.knockback * 1;  // Qm2pxgr=0, not zooming
    ok('recoil magnitude matches the client Qmgh2i6 formula', approx(psArmed.Qq1azd5, expected),
      `got ${psArmed.Qq1azd5}, expected ${expected}`);
  }

  // Zooming reduces recoil by the 0.6 factor.
  const psHip = { Qezh4wz: 0, Qm2pxgr: 0, Qq1azjr: 0, Qq1azd5: 0, Qgk2mcg: false };
  const psAds = { Qezh4wz: 0, Qm2pxgr: 0, Qq1azjr: 0, Qq1azd5: 0, Qgk2mcg: true };
  armRecoil(psHip, 4); armRecoil(psAds, 4);
  ok('zooming (ADS) reduces recoil vs hip-fire', psAds.Qq1azd5 < psHip.Qq1azd5,
    `ads=${psAds.Qq1azd5} hip=${psHip.Qq1azd5}`);
}

// ── 8. Hitscan eye height (the headshot-as-body-shot fix) ────────────────────────────────────
// The client raycasts shots from the camera eye: feet + (crouching ? 1.0 : 1.8) (bundle 64718,
// Qyohfua/Qymlxst). The old flat 1.6 started ~0.2u low → level shots landed below the aim point
// → headshots (capsule head region) scored as body shots.
console.log('\n── hitscan eye height (matches the client camera) ──');
{
  ok('standing eye height = 1.8 (Qyohfua), not the old 1.6', C.STAND_EYE_Y === 1.8,
    `got ${C.STAND_EYE_Y}`);
  ok('crouching eye height = 1.0 (Qymlxst)', C.CROUCH_EYE_Y === 1.0, `got ${C.CROUCH_EYE_Y}`);
  ok('standing eye is higher than crouching', C.STAND_EYE_Y > C.CROUCH_EYE_Y);
}

// ── 9. lastHitInfo hit-event emission (damage-direction / hit-reaction feedback) ─────────────
console.log('\n── lastHitInfo emission in the player block (opcodes 170-176) ──');
{
  const { appendPlayerTickBody } = srv;
  // No pending hit → no hit-event opcodes in the body.
  const clean = createPlayerStateLike();
  const b1 = []; appendPlayerTickBody(b1, 'p1', clean);
  ok('no hit → no lastHitInfo opcodes (170-176 absent)',
    !b1.includes(170) && !b1.includes(171) && !b1.includes(176));

  // Pending hit → opcodes present, in strict ascending order, between 168 and 187.
  const hurt = createPlayerStateLike();
  hurt._pendingHit = { attackerSid: 'shooter9', dmg: 0.15, wpnType: 4, headshot: true, src: { x: 1.5, y: 2.6, z: -3.2 } };
  const b2 = []; appendPlayerTickBody(b2, 'p2', hurt);
  const i168 = b2.indexOf(168), i170 = b2.indexOf(170), i171 = b2.indexOf(171),
        i172 = b2.indexOf(172), i173 = b2.indexOf(173), i174 = b2.indexOf(174), i176 = b2.indexOf(176), i187 = b2.indexOf(187);
  ok('hit emits 170 attackerSid with the shooter id', i170 !== -1 && b2[i170 + 1] === 'shooter9');
  ok('hit emits 171 hitDamage = applied damage', i171 !== -1 && approx(b2[i171 + 1], 0.15));
  ok('hit emits 172 hitWeaponType = weapon nid', i172 !== -1 && b2[i172 + 1] === 4);
  ok('hit emits 173 headshot flag', i173 !== -1 && b2[i173 + 1] === true);
  ok('hit emits 174 = 0 (resets the Qpgzeeg fade counter)', i174 !== -1 && b2[i174 + 1] === 0);
  ok('hit emits 176 hitSrcPos (sub-mode 0 + xyz)', i176 !== -1 && b2[i176 + 1] === 0 && approx(b2[i176 + 2], 1.5));
  ok('hit-event opcodes are in strict ascending order between 168 and 187',
    i168 < i170 && i170 < i171 && i171 < i172 && i172 < i173 && i173 < i174 && i174 < i176 && i176 < i187,
    `168@${i168} 170@${i170} 176@${i176} 187@${i187}`);
}

// ── 10. Bullet/tracer stream (worldState.bulletMap, block marker 55) ─────────────────────────
console.log('\n── bullet/tracer block (opcode 55 entries, before the 244 player blocks) ──');
{
  const { spawnBullet, buildBulletBlock } = srv;
  spawnBullet('shooterA', { x: 1, y: 2.8, z: -3 }, { x: 0, y: 0, z: 1 }, 0.1, 4);
  const blk = buildBulletBlock();
  ok('bullet block starts with marker 55', blk[0] === 55);
  ok('entry carries 46 sessionId, 47 age=0, 48 ownerSid', blk.includes(46) && blk[blk.indexOf(47) + 1] === 0
    && blk[blk.indexOf(48) + 1] === 'shooterA');
  ok('49 rayOrigin sub-mode 0 + xyz', blk[blk.indexOf(49) + 1] === 0 && approx(blk[blk.indexOf(49) + 2], 1)
    && approx(blk[blk.indexOf(49) + 4], -3));
  ok('50 rayDirection sub-mode 0 + xyz', blk[blk.indexOf(50) + 1] === 0 && approx(blk[blk.indexOf(50) + 4], 1));
  ok('51 hitDamage + 54 weaponType', approx(blk[blk.indexOf(51) + 1], 0.1) && blk[blk.indexOf(54) + 1] === 4);
  // ascending order within the entry
  const order = [55, 46, 47, 48, 49, 50, 51, 54].map(op => blk.indexOf(op));
  ok('entry opcodes are in strict ascending order', order.every((v, i) => i === 0 || v > order[i - 1]),
    order.join(','));

  // Appears in a tick body BEFORE the first 244 player block.
  const body = srv.buildTickBody('p1', 5, createPlayerStateLike(), null);
  const i55 = body.indexOf(55), i244 = body.indexOf(244);
  ok('bullet block is emitted before the 244 player blocks', i55 !== -1 && i55 < i244,
    `55@${i55} 244@${i244}`);
}

// ── 11. playerMap hit-event stream (op 67) + melee weapon detection ──────────────────────────
console.log('\n── playerMap hit-event block (op 67) + melee detection ──');
{
  const { spawnHitEvent, buildPlayerMapBlock, WEAPON_MELEE } = srv;
  // Melee weapon table from the catalogue.
  ok('Sword (262) is detected as melee', WEAPON_MELEE[262] === true);
  ok('Auto Rifle (4) is NOT melee', !WEAPON_MELEE[4]);

  spawnHitEvent('shooterA', 'victimB', 0.5, 1, { x: 2, y: 3, z: -4 }, { x: 0, y: 1.8, z: 0 });
  const blk = buildPlayerMapBlock();
  ok('hit-event block starts with marker 67', blk[0] === 67);
  ok('59 string_prop = victim, 60 Qo8o780 = attacker',
    blk[blk.indexOf(59) + 1] === 'victimB' && blk[blk.indexOf(60) + 1] === 'shooterA');
  ok('61 hitDamage + 62 crit mult', approx(blk[blk.indexOf(61) + 1], 0.5) && approx(blk[blk.indexOf(62) + 1], 1));
  ok('63 smoothPos (impact, submode 0 + xyz)', blk[blk.indexOf(63) + 1] === 0 && approx(blk[blk.indexOf(63) + 2], 2)
    && approx(blk[blk.indexOf(63) + 4], -4));
  ok('64 aimPos (shooter eye, submode 0)', blk[blk.indexOf(64) + 1] === 0 && approx(blk[blk.indexOf(64) + 3], 1.8));
  const order = [67, 57, 58, 59, 60, 61, 62, 63, 64, 65, 66].map(op => blk.indexOf(op));
  ok('entry opcodes are in strict ascending order', order.every((v, i) => i === 0 || v > order[i - 1]), order.join(','));
  // No forwarded sessionId → key falls back to the numeric counter (server-reconstructed shot).
  ok('playerMap key (after 67) is the numeric id when no shot sid', typeof blk[1] === 'number' && blk[blk.indexOf(57) + 1] === blk[1]);

  // THE DOUBLE-DAMAGE FIX: when the client forwards the shot sessionId "f:p:a", the playerMap entry
  // must be KEYED by that exact string so the client's hit-prediction prune (Qkszhck in playerMap,
  // bundle :67131) matches and clears the prediction atomically with the HP drop. Without this the
  // prune only fires on the 3-tick stale path → the predicted damage double-subtracts on the bar.
  spawnHitEvent('shooterA', 'victimB', 0.5, 1, { x: 1, y: 2, z: 3 }, { x: 0, y: 1.8, z: 0 }, '0:52053:12400');
  const sblk = buildPlayerMapBlock();
  // The sid-keyed entry is the last one appended; find its 67 marker (token after it must be the sid).
  let keyedAt = -1;
  for (let i = 0; i < sblk.length - 1; i++) if (sblk[i] === 67 && sblk[i + 1] === '0:52053:12400') { keyedAt = i; break; }
  ok('playerMap KEY (token after 67) = the client shot sessionId string', keyedAt !== -1);
  ok('57 sessionId field = the same shot sessionId string', keyedAt !== -1 && sblk[keyedAt + 2] === 57 && sblk[keyedAt + 3] === '0:52053:12400');

  // Block appears in a tick body after bullets, before the 244 player blocks.
  spawnHitEvent('s2', 'v2', 0.1, 1.5, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 });
  const body = srv.buildTickBody('p1', 9, createPlayerStateLike(), null);
  const i67 = body.indexOf(67), i244 = body.indexOf(244);
  ok('hit-event block is emitted before the 244 player blocks', i67 !== -1 && i67 < i244, `67@${i67} 244@${i244}`);
}

// ── 12. Section 4: damage grenades (HE / Sticky / Mine / Trip Mine) ───────────────────────────
console.log('\n── damage grenades: AoE falloff, mine proximity, trip-mine beam ──');
{
  const { GRENADE_COMBAT, GRENADE_ACTIONS, GRENADE_TYPE,
          applyExplosionDamage, nearestEnemyWithin, enemyCrossingRay, combatConstants } = srv;
  const D = combatConstants.DMG_GLOBAL_MULT;   // 0.01

  // Wiring: the four damage grenades resolve action → sid → projectile weaponTypeId → combat params.
  ok('HE action 19 → sid 8 → wt 46 (timer, aoe 11)',
    GRENADE_ACTIONS[19] === 8 && GRENADE_TYPE[8] === 46 && GRENADE_COMBAT[46].behavior === 'timer' && GRENADE_COMBAT[46].aoe === 11);
  ok('Sticky action 22 → sid 13 → wt 172 (sticky, aoe 8)',
    GRENADE_ACTIONS[22] === 13 && GRENADE_TYPE[13] === 172 && GRENADE_COMBAT[172].behavior === 'sticky');
  ok('Mine action 23 → sid 14 → wt 173 (mine, proxy 6)',
    GRENADE_ACTIONS[23] === 14 && GRENADE_TYPE[14] === 173 && GRENADE_COMBAT[173].behavior === 'mine' && GRENADE_COMBAT[173].proxyDistance === 6);
  ok('Trip Mine action 24 → sid 15 → wt 176 (tripmine, direct, ray 50)',
    GRENADE_ACTIONS[24] === 15 && GRENADE_TYPE[15] === 176 && GRENADE_COMBAT[176].behavior === 'tripmine' && GRENADE_COMBAT[176].aoe === 0);

  const sess = (list) => new Map(list.map((p, i) => [i, { accepted: true, playerState: p }]));
  const mk = (sid, x, y, z, hp = 1) => ({ _ownerSid: sid, position: { x, y, z }, healthPoints: hp, armorPoints: 0, deathStateTimer: 0 });

  // AoE falloff: center takes far more than edge; outside the radius takes nothing.
  const he = GRENADE_COMBAT[46];               // dmg 250, aoe 11
  const center = mk('v1', 0, 0, 0), edge = mk('v2', 10.5, 0, 0), outside = mk('v3', 20, 0, 0);
  const s = sess([center, edge, outside]);
  const n = applyExplosionDamage({ x: 0, y: 1, z: 0 }, he.dmg, he.aoe, 'thrower', 46, s);
  ok('explosion hits the two players inside the radius, not the one outside', n === 2);
  ok('center player is killed (full HP gone)', center.healthPoints <= 0);
  ok('edge player takes the .2·dmg floor, not full', edge.healthPoints > 0 && edge.healthPoints < 1);
  ok('center loses strictly more HP than edge (distance falloff)', (1 - center.healthPoints) > (1 - edge.healthPoints));
  ok('player outside aoe is untouched', outside.healthPoints === 1);
  ok('explosion sets lastHitInfo on a victim (damage direction)', !!center._pendingHit && center._pendingHit.attackerSid === 'thrower');

  // Mine proximity (dontTriggerOnSelf): owner inside the radius does NOT trip; an enemy does.
  const minePos = { x: 0, y: 0, z: 0 };
  const ownerNear = sess([mk('owner', 1, 0, 0)]);
  ok('mine ignores its OWNER within proxyDistance', nearestEnemyWithin(minePos, 6, 'owner', ownerNear) === null);
  const enemyNear = sess([mk('owner', 1, 0, 0), mk('enemy', 3, 0, 0)]);
  ok('mine trips on an ENEMY within proxyDistance', nearestEnemyWithin(minePos, 6, 'owner', enemyNear) !== null);
  ok('mine does NOT trip on an enemy beyond proxyDistance', nearestEnemyWithin(minePos, 6, 'owner', sess([mk('enemy', 9, 0, 0)])) === null);

  // Trip-mine beam: a ray along +X from origin; an enemy standing on the line trips it, off-line does not.
  const beam = { ox: 0, oy: 1, oz: 0, dx: 1, dy: 0, dz: 0 };
  ok('enemy standing on the beam trips the trip mine',
    enemyCrossingRay(beam, 50, 0.6, 'owner', sess([mk('enemy', 10, 0, 0)])) !== null);
  ok('enemy off to the side of the beam does NOT trip it',
    enemyCrossingRay(beam, 50, 0.6, 'owner', sess([mk('enemy', 10, 0, 5)])) === null);
  ok('enemy past the end of the beam does NOT trip it',
    enemyCrossingRay(beam, 50, 0.6, 'owner', sess([mk('enemy', 60, 0, 0)])) === null);
  ok('trip mine ignores its OWNER on the beam',
    enemyCrossingRay(beam, 50, 0.6, 'owner', sess([mk('owner', 10, 0, 0)])) === null);
}

// ── 13. Grenade entity rendering fields: stuck orientation + trip-mine beam ───────────────────
console.log('\n── grenade entity stream: isStuck/stuckNormal orientation + trip-mine beam ──');
{
  const { buildActiveEntityBlock, activeEntities } = srv;
  activeEntities.clear();
  // A planted MINE: stuck to the floor with an up normal — should emit 253 isStuck + 255 stuckNormal
  // (which orients the model flat AND stops the flight trail "smoke"), but NO 265 aimTarget.
  activeEntities.set('m1', {
    sessionId: 'm1', ownerSid: 'o', pos: { x: 1, y: 0, z: 2 }, vel: { x: 0, y: 0, z: 0 },
    type: 173, numberProp: 8, spawnTick: 0, qt6bqft: null, isStuck: 1, armed: true,
    stuckNormal: { x: 0, y: 1, z: 0 }, aimTarget: null,
  });
  let blk = buildActiveEntityBlock();
  const i253 = blk.indexOf(253), i255 = blk.indexOf(255);
  ok('planted mine emits 253 isStuck = true', i253 !== -1 && blk[i253 + 1] === true);
  ok('planted mine emits 255 stuckNormal (submode 0 + up vector)',
    i255 !== -1 && blk[i255 + 1] === 0 && blk[i255 + 3] === 1);   // 255, submode 0, x, y(=1 floor normal), z
  ok('planted mine does NOT emit 265 aimTarget (no beam)', blk.indexOf(265) === -1);

  // A planted TRIP MINE on a +X wall: normal -X, beam endpoint down the corridor → emits 265 aimTarget.
  activeEntities.clear();
  activeEntities.set('t1', {
    sessionId: 't1', ownerSid: 'o', pos: { x: 5, y: 1, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    type: 176, numberProp: 0, spawnTick: 0, qt6bqft: null, isStuck: 1, armed: true,
    stuckNormal: { x: -1, y: 0, z: 0 }, aimTarget: { x: -45, y: 1, z: 0 },
  });
  blk = buildActiveEntityBlock();
  const j265 = blk.indexOf(265);
  ok('trip mine emits 265 aimTarget (visible tripwire endpoint)',
    j265 !== -1 && blk[j265 + 1] === 0 && blk[j265 + 2] === -45);
  ok('trip mine also emits 253 isStuck + 255 stuckNormal', blk.indexOf(253) !== -1 && blk.indexOf(255) !== -1);
  // Entity opcodes must stay strictly ascending (the decoder scans them in order).
  const ents = blk.slice(0, blk.indexOf(268, 1) === -1 ? blk.length : blk.indexOf(268, 1));
  const codes = [246, 247, 248, 249, 250, 251, 253, 255, 260, 261, 262, 265].map(c => blk.indexOf(c)).filter(i => i !== -1);
  ok('entity field opcodes are in strict ascending order', codes.every((v, i) => i === 0 || v > codes[i - 1]), codes.join(','));
  activeEntities.clear();
}

// ── 14. Mine arming delay (must NOT detonate the instant it lands) ────────────────────────────
console.log('\n── mine arming delay: stays put on landing, arms ~1.5s later ──');
{
  const { simulateGrenades, activeEntities, GRENADE_COMBAT } = srv;
  const sess = (list) => new Map(list.map((p, i) => [i, { accepted: true, playerState: p }]));
  const mk = (sid, x, y, z) => ({ _ownerSid: sid, position: { x, y, z }, healthPoints: 1, armorPoints: 0, deathStateTimer: 0 });

  // An enemy stands 2u from a freshly-PLANTED mine (well within proxyDistance 6). It must survive the
  // arming delay (30 ticks) before it detonates — otherwise it "disappears the moment it lands".
  const enemy = mk('enemy', 2, 0, 0);
  const s = sess([mk('owner', 10, 0, 0), enemy]);
  activeEntities.clear();
  activeEntities.set('mine1', {
    sessionId: 'mine1', ownerSid: 'owner', pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    type: 173, numberProp: 8, spawnTick: 0, qt6bqft: null, isStuck: 1,
    armed: false, armDelay: 30, fuse: srv.combatConstants ? 1200 : 1200,
    combat: GRENADE_COMBAT[173], stuckNormal: { x: 0, y: 1, z: 0 },
  });
  // Tick 28 times — still disarmed, must still be present (no detonation despite the enemy at 2u).
  for (let i = 0; i < 28; i++) simulateGrenades(0.05, s);
  ok('mine is still present during the arming delay (does not vanish on landing)', activeEntities.has('mine1') && enemy.healthPoints === 1);
  // A couple more ticks crosses the 30-tick threshold → arms → detonates on the nearby enemy.
  for (let i = 0; i < 4; i++) simulateGrenades(0.05, s);
  ok('mine arms after the delay and detonates on the nearby enemy', !activeEntities.has('mine1') && enemy.healthPoints < 1);
  activeEntities.clear();
}

// ── 15. Explosion knockback + shootable mines + owner-death cleanup ───────────────────────────
console.log('\n── explosion knockback, shootable mines, owner-death cleanup ──');
{
  const { applyExplosionDamage, applyExplosionKnockback, destroyMineInLineOfFire,
          simulateGrenades, activeEntities, GRENADE_COMBAT } = srv;
  const sess = (list) => new Map(list.map((p, i) => [i, { accepted: true, playerState: p }]));
  // A victim with a physics state so knockback can write velocity (Qyaswvo) + grounded (Q9t2fit).
  const mkPhys = (sid, x, y, z) => ({
    _ownerSid: sid, position: { x, y, z }, healthPoints: 1, armorPoints: 0, deathStateTimer: 0,
    _ps: { Qyaswvo: { x: 0, y: 0, z: 0 }, Q9t2fit: true },
  });

  // Knockback: an HE blast next to a player flings them away-and-up and lifts them off the ground.
  const v = mkPhys('victim', 3, 0, 0);
  applyExplosionDamage({ x: 0, y: 0, z: 0 }, GRENADE_COMBAT[46].dmg, GRENADE_COMBAT[46].aoe, 'thrower', 46, sess([v]));
  ok('explosion knockback flings the victim away on +X', v._ps.Qyaswvo.x > 0);
  ok('explosion knockback adds upward velocity', v._ps.Qyaswvo.y > 0);
  ok('explosion knockback lifts the victim off the ground', v._ps.Q9t2fit === false);

  // Shooting a planted MINE detonates it (removed + AoE damages a nearby enemy).
  activeEntities.clear();
  const enemy = mkPhys('enemy', 0, 0, 1);   // 1u from the mine → inside aoe 8
  activeEntities.set('m', {
    sessionId: 'm', ownerSid: 'owner', pos: { x: 0, y: 1, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    type: 173, isStuck: 1, armed: true, combat: GRENADE_COMBAT[173], stuckNormal: { x: 0, y: 1, z: 0 },
  });
  // Shoot from −5 on X straight toward the mine at origin (clear line in open space).
  const shot = destroyMineInLineOfFire({ x: -5, y: 1, z: 0 }, { x: 1, y: 0, z: 0 }, sess([enemy]));
  ok('shooting a planted mine destroys it', shot === true && !activeEntities.has('m'));
  ok('the shot mine detonates its AoE on a nearby enemy', enemy.healthPoints < 1);
  // A shot that misses the mine leaves it intact.
  activeEntities.set('m2', {
    sessionId: 'm2', ownerSid: 'owner', pos: { x: 0, y: 1, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    type: 173, isStuck: 1, armed: true, combat: GRENADE_COMBAT[173], stuckNormal: { x: 0, y: 1, z: 0 },
  });
  destroyMineInLineOfFire({ x: -5, y: 1, z: 9 }, { x: 1, y: 0, z: 0 }, sess([])); // parallel, 9u off → miss
  ok('a shot that misses the mine leaves it intact', activeEntities.has('m2'));
  activeEntities.clear();

  // Owner-death cleanup: a planted mine despawns once its owner is dead.
  activeEntities.set('m3', {
    sessionId: 'm3', ownerSid: 'owner', pos: { x: 0, y: 1, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    type: 173, isStuck: 1, armed: true, combat: GRENADE_COMBAT[173], stuckNormal: { x: 0, y: 1, z: 0 }, fuse: 1200,
  });
  const deadOwner = { _ownerSid: 'owner', position: { x: 50, y: 0, z: 0 }, healthPoints: 0, armorPoints: 0, deathStateTimer: 5 };
  simulateGrenades(0.05, sess([deadOwner]));
  ok('a planted mine despawns when its owner is dead', !activeEntities.has('m3'));
  activeEntities.clear();
}

// ── 16. Impulse DEFUSES nearby grenades (disableGrenades) ─────────────────────────────────────
console.log('\n── impulse defuses nearby traps (disableGrenades), defused traps are inert ──');
{
  const { disableNearbyGrenades, simulateGrenades, activeEntities, GRENADE_COMBAT,
          buildActiveEntityBlock } = srv;
  const sess = (list) => new Map(list.map((p, i) => [i, { accepted: true, playerState: p }]));
  const mk = (sid, x, y, z) => ({ _ownerSid: sid, position: { x, y, z }, healthPoints: 1, armorPoints: 0, deathStateTimer: 0 });
  const mineAt = (key, x, y, z) => ({
    sessionId: key, ownerSid: 'enemy', pos: { x, y, z }, vel: { x: 0, y: 0, z: 0 },
    type: 173, isStuck: 1, armed: true, combat: GRENADE_COMBAT[173], stuckNormal: { x: 0, y: 1, z: 0 }, fuse: 1200,
  });

  activeEntities.clear();
  activeEntities.set('near', mineAt('near', 3, 0, 0));    // within 0.65·11 = 7.15 of the blast
  activeEntities.set('far',  mineAt('far', 20, 0, 0));    // outside
  disableNearbyGrenades({ x: 0, y: 0, z: 0 }, 11, 'impulse');   // impulse aoe 11
  ok('impulse defuses the nearby mine (disabled + dearmed)', activeEntities.get('near').disabled === true && activeEntities.get('near').armed === false);
  ok('impulse does NOT defuse the far mine', !activeEntities.get('far').disabled);

  // A defused mine is INERT: an enemy standing on it does NOT get hurt, and it despawns after the linger.
  const victim = mk('victim', 3, 0, 0);   // standing right on the defused 'near' mine
  let before = victim.healthPoints;
  for (let i = 0; i < 5; i++) simulateGrenades(0.05, sess([victim]));
  ok('a defused mine cannot trigger (enemy on it takes no damage)', victim.healthPoints === before && before === 1);
  ok('a defused mine streams Qi98px5=true while it lingers', (() => {
    const blk = buildActiveEntityBlock(); const i = blk.indexOf(267); return i !== -1 && blk[i + 1] === true;
  })());
  // After the linger (~12 ticks) the defused mine is silently removed.
  for (let i = 0; i < 12; i++) simulateGrenades(0.05, sess([victim]));
  ok('a defused mine is silently removed after its linger', !activeEntities.has('near') && victim.healthPoints === 1);
  activeEntities.clear();
}

// ── 17. Grenade charge costs match the client + dead players signal alive=0 ────────────────────
console.log('\n── grenade costs match client, death sets alive=0 ──');
{
  const { ABILITY_COST } = require('../ability_stats');
  // Costs MUST equal the client's Qoxvbp3 or the cooldown desyncs (server refilled in half the time).
  ok('Sticky/Mine/Trip Mine cost 1.0 (1 charge, matches client)',
    ABILITY_COST[13][0] === 1 && ABILITY_COST[14][0] === 1 && ABILITY_COST[15][0] === 1);
  ok('HE/Impulse cost 0.5 (2 charges)', ABILITY_COST[8][0] === 0.5 && ABILITY_COST[16][0] === 0.5);

  // A dead player must emit alive=4 (opcode 91) — the third-person death killcam (Q8m0587, else branch);
  // alive=0 froze first-person + hid the corpse, alive=2/3 are the free-cam spectator.
  const dead = createPlayerStateLike(); dead.deathStateTimer = 3; dead.healthPoints = 0;
  const dbody = srv.buildTickBody('p1', 7, dead, null);
  const di = dbody.indexOf(91);
  ok('a dead player emits alive=4 (third-person death killcam)', di !== -1 && dbody[di + 1] === 4);
  const abody = srv.buildTickBody('p1', 7, createPlayerStateLike(), null);
  ok('a living player emits alive=1', abody[abody.indexOf(91) + 1] === 1);
  // respawnTimer1 (129) counts down while dead, -1 while alive.
  ok('dead player streams respawnTimer1 (129) > 0', dbody[dbody.indexOf(129) + 1] > 0);
  ok('living player streams respawnTimer1 = -1', abody[abody.indexOf(129) + 1] === -1);
  // reloadTimer (130) is streamed (-1 when not reloading).
  ok('reloadTimer (130) is streamed', abody.indexOf(130) !== -1 && abody[abody.indexOf(130) + 1] === -1);
}

// ── 18. Ammo consumption + auto-reload ────────────────────────────────────────────────────────
console.log('\n── ammo: drains per shot, auto-reloads at 0, refills to clip ──');
{
  const { weaponClip, weaponReloadTicks, preTickFire } = srv;
  const clip = weaponClip(4);                 // Auto Rifle = 50
  ok('Auto Rifle clip size = 50 (from catalogue)', clip === 50);
  ok('Auto Rifle reload = 60 ticks (cooldown2)', weaponReloadTicks(4) === 60);

  // A gun player holding fire: each firing tick consumes one round.
  const p = {
    equippedWeaponId: 4, heldActions: new Set([5]), fireCooldown: 0,
    gunAmmo: 3, reloadTicks: 0, _ammoGunId: 4, deathStateTimer: 0, healthPoints: 1, _ps: null,
  };
  preTickFire(p, []); ok('shot 1 consumes a round (3→2) and fires', p.gunAmmo === 2 && p._firingThisTick === true);
  p.fireCooldown = 0; preTickFire(p, []); ok('shot 2 consumes a round (2→1)', p.gunAmmo === 1);
  p.fireCooldown = 0; preTickFire(p, []); ok('shot 3 empties the magazine (1→0)', p.gunAmmo === 0);
  // Next firing tick with an empty mag: no shot, reload begins.
  p.fireCooldown = 0; preTickFire(p, []);
  ok('empty magazine → no shot fired, reload started', p._firingThisTick === false && p.reloadTicks > 0);
  // Run out the reload countdown → magazine refills to the clip size.
  let guard = 0;
  while (p.reloadTicks > 0 && guard++ < 200) { p.fireCooldown = 0; p.heldActions = new Set(); preTickFire(p, []); }
  ok('reload refills the magazine to the clip size', p.gunAmmo === clip);
}

// ── 18b. No firing (or reloading) mid weapon-switch ─────────────────────────────────────────────
// The client refuses to fire while Q3igok2 (switchTimer here) > 0 (bundle :43956 — "you cannot fire
// mid-swap") and refuses to reload while it's >= 1 (:43981). We already replicated the TIMER's
// value (startWeaponSwitch sets it, the post-broadcast sweep counts it down, opcode 129 streams it)
// but never actually gated firing on it — found live as "damage registered but the sword didn't
// swing": the CLIENT correctly refused to play the swing locally mid-switch, but the server had
// nothing stopping it from confirming the hit anyway. Applies to guns AND melee alike.
console.log('\n── no firing (or reloading) while switchTimer is counting down ──');
{
  const { preTickFire } = srv;
  const p = {
    equippedWeaponId: 4, heldActions: new Set([5]), fireCooldown: 0,
    gunAmmo: 10, reloadTicks: 0, _ammoGunId: 4, deathStateTimer: 0, healthPoints: 1, _ps: null,
    switchTimer: 5,
  };
  preTickFire(p, []);
  ok('a shot mid-switch is refused (ammo unchanged, no fire)',
    p.gunAmmo === 10 && p._firingThisTick === false, `gunAmmo=${p.gunAmmo} firing=${p._firingThisTick}`);

  const m = {
    equippedWeaponId: 262, heldActions: new Set([5]), fireCooldown: 0,
    reloadTicks: 0, _ammoGunId: 262, deathStateTimer: 0, healthPoints: 1, _ps: null,
    switchTimer: 5,
  };
  preTickFire(m, []);
  ok('a MELEE swing mid-switch is also refused — this is the exact reported bug',
    m._firingThisTick === false, `firing=${m._firingThisTick}`);

  // A missing switchTimer (older/synthetic callers that never set it) must NOT be treated as
  // "permanently switching" — undefined <= 0 is false in JS, which would silently block every shot.
  const u = {
    equippedWeaponId: 4, heldActions: new Set([5]), fireCooldown: 0,
    gunAmmo: 10, reloadTicks: 0, _ammoGunId: 4, deathStateTimer: 0, healthPoints: 1, _ps: null,
  };
  preTickFire(u, []);
  ok('a player with no switchTimer field at all can still fire (undefined treated as "not switching")',
    u.gunAmmo === 9 && u._firingThisTick === true, `gunAmmo=${u.gunAmmo} firing=${u._firingThisTick}`);

  // Once the timer actually reaches 0, firing resumes.
  p.switchTimer = 0;
  preTickFire(p, []);
  ok('firing resumes once switchTimer reaches 0', p.gunAmmo === 9 && p._firingThisTick === true,
    `gunAmmo=${p.gunAmmo} firing=${p._firingThisTick}`);

  // Reload is likewise refused mid-switch (bundle's Q3igok2>=1 rule).
  const r = {
    equippedWeaponId: 4, heldActions: new Set(), fireCooldown: 0,
    gunAmmo: 0, reloadTicks: 0, _ammoGunId: 4, deathStateTimer: 0, healthPoints: 1, _ps: null,
    switchTimer: 3,
  };
  preTickFire(r, []);
  ok('an empty mag does NOT start reloading while still switching', r.reloadTicks === 0,
    `reloadTicks=${r.reloadTicks}`);
  r.switchTimer = 0;
  preTickFire(r, []);
  ok('and starts reloading once the switch settles', r.reloadTicks > 0, `reloadTicks=${r.reloadTicks}`);
}

// ── 19. Fall death (below the kill plane) routes through the respawn path ──────────────────────
console.log('\n── fall death: below Y=-30 kills the player so they can respawn ──');
{
  const sess = (p) => new Map([[0, { accepted: true, playerState: p }]]);
  const base = () => ({
    _ownerSid: 'o', position: { x: 0, y: 5, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
    healthPoints: 1, armorPoints: 0, deathStateTimer: 0, spawnSeed: 0, equippedWeaponId: 4,
    _ammoGunId: 4, gunAmmo: 50, reloadTicks: 0,
    _ps: { Qdsukt4: { x: 0, y: 5, z: 0 }, Qyaswvo: { x: 0, y: 0, z: 0 }, Qz8l93a: { Qtgt1xt: 1 } },
  });
  const alive = base();
  srv.processDeathRespawn(sess(alive));
  ok('a player above the kill plane stays alive', alive.deathStateTimer === 0 && alive.healthPoints === 1);
  const fallen = base(); fallen.position.y = -40; fallen._ps.Qdsukt4.y = -40;
  srv.processDeathRespawn(sess(fallen));
  ok('a player below Y=-30 is killed (enters the respawn path)', fallen.healthPoints <= 0 && fallen.deathStateTimer > 0);
}

// ── actionTickCounter (opcode 146) — drives PEER attack animations ────────────
// Regression test: this was hardcoded to 9999 every tick, so every peer read as "has not
// attacked in ages". The client plays SWORD_SLASH only on `0 === actionTickCounter`
// (bundle :51539) and the gun fire pose likewise (:48137) — so peers took damage from a
// model that never swung or fired. It must now stream the live per-player value.
console.log('\n── actionTickCounter (146): peers must see the attack animation ──');
{
  // Read the value the tick body carries for opcode 146. It sits in the strict positional
  // block between 145 and 149, so anchor on that to avoid matching an unrelated 146 payload.
  const read146 = (body) => {
    for (let i = 0; i < body.length - 3; i++) {
      if (body[i] === 145 && body[i + 2] === 146 && body[i + 4] === 149) return body[i + 3];
    }
    return undefined;
  };
  const tickBody = (ps) => { const b = []; srv.appendPlayerTickBody(b, 1, ps); return b; };

  const p = srv.createPlayerSimState(0, 'atc-test');
  p.equippedWeaponId = 262;                 // sword

  ok('146 is streamed in the tick body', read146(tickBody(p)) !== undefined);
  ok('146 is no longer the hardcoded 9999 sentinel for an attacking player',
    (() => {
      p._firingThisTick = true;
      p._ps = null;                          // exercise the fallback path too
      srv.integratePlayerSim(p, 0.05, 1);
      return read146(tickBody(p));
    })() === 0, 'the slash animation only plays when the peer sees exactly 0');

  // After the attack tick the counter must climb again, or the client would restart the
  // slash clip every single tick (`time = 0; play()`) and the animation would never advance.
  p._firingThisTick = false;
  srv.integratePlayerSim(p, 0.05, 2);
  const after1 = read146(tickBody(p));
  srv.integratePlayerSim(p, 0.05, 3);
  const after2 = read146(tickBody(p));
  ok('counter increments after the attack tick (slash plays once, then advances)',
    after1 === 1 && after2 === 2, `got ${after1}, ${after2}`);

  // A fresh player has never attacked → must NOT read as mid-swing.
  const idle = srv.createPlayerSimState(1, 'atc-idle');
  ok('a freshly spawned player is not mid-attack', read146(tickBody(idle)) > 10,
    `got ${read146(tickBody(idle))}`);

  // The sprint gate (:51480) suppresses the whole sword branch while
  // `sprinting && actionTickCounter > 10` — so a sprinting attacker must still report 0.
  const sprinter = srv.createPlayerSimState(2, 'atc-sprint');
  sprinter.equippedWeaponId = 262;
  sprinter.sprinting = true;
  sprinter._ps = null;
  sprinter._firingThisTick = true;
  srv.integratePlayerSim(sprinter, 0.05, 1);
  ok('a sprinting attacker still reports 0 (sprint gate must not hide the slash)',
    read146(tickBody(sprinter)) === 0);
}

console.log(`\n${'─'.repeat(60)}`);
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);

// Minimal playerState shaped enough for appendPlayerTickBody.
function createPlayerStateLike() {
  return {
    position: { x: 0, y: 2, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, pitchOffset: 0, grounded: true, crouching: false, sprinting: false,
    sliding: false, heldActions: new Set(), healthPoints: 1, armorPoints: 0, deathStateTimer: 0,
    airJumps: 0, stamina: 1, grenadeCharge: 0, abilityCharge: 1, impulseCharge: 0,
    slideBoostTick: 0, weaponSendCount: 0, equippedWeaponId: 4, qwv47ix: 0, energyCharge: 0,
    justUsedActiveAbility: false, justTeleported: false,
  };
}
