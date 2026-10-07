/**
 * test_weapon_swap.js — a loadout change must reach EVERY client, and you respawn holding your gun.
 *
 * THE BUG
 * ───────
 * appendPlayerTickBody runs ONCE PER RECIPIENT. Two pieces of per-tick state were being mutated
 * inside it:
 *
 *   _prevEmitGunId   drives the (135,-1,oldId) delete that removes the OLD weapon icon. Advancing it
 *                    on the first recipient meant only that one client got the delete; everyone else
 *                    stacked the new icon on top of the old one. Whether the player saw their own
 *                    icon replaced depended on where they fell in session iteration order — hence
 *                    "sometimes" — and peers never saw a change at all.
 *
 *   weaponSendCount  the repeat budget for opcode 127/128 (equippedWeaponId). Draining it per
 *                    recipient burns it N times faster with N players and can leave the last
 *                    recipients without the final emission.
 *
 * Both now advance exactly once per tick, after every body is built.
 *
 * Separately, applyLiveLoadout never set weaponSendCount at all, so 127 — which is delta-emitted,
 * absent meaning unchanged — was never re-sent on a loadout change. The player's own HUD updated
 * from the weaponSlots stream while every other client kept rendering the old weapon in their hands.
 *
 * And respawn kept whatever was in hand at death, so dying mid-melee brought you back with the sword.
 *
 * Usage:  node scripts/test_weapon_swap.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
// This test checks weaponSlots delete/add streaming on a playerState built via
// createPlayerSimState, with no "enter the match" step in between — appendPlayerTickBody
// correctly emits NO weapon slots at all for a held player ("Hold new players until they click
// to play", now the default — a spectator has no weapon), so every slot assertion here would
// silently no-op without this. Real, correct behavior, just not what this file tests (weapon-swap
// slot streaming once a player IS in the match).
process.env.EVIO_CLICK_TO_PLAY = process.env.EVIO_CLICK_TO_PLAY || '0';
const srv = require('../local_ws_server');
const bpw = require('../physics_world');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

const RIFLE = 4, LASER = 9, SWORD = 262;

// Read the weaponSlots ops out of a body: [{del:id} | {add:id}]
function slotOps(body) {
  const out = [];
  for (let i = 0; i < body.length - 1; i++) {
    if (body[i] !== 135) continue;
    if (body[i + 1] === -1) out.push({ del: body[i + 2] });
    else out.push({ add: body[i + 1] });
  }
  return out;
}
const has127 = (b) => b.indexOf(127) !== -1;

(async () => {
  await bpw.ready;
  const sp = bpw.spawnPoints[0];
  const mk = (id, weapon) => {
    const p = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, id);
    p.equippedWeaponId = weapon; p._ammoGunId = weapon; p.gunAmmo = 30;
    p.weaponList = [weapon, SWORD];
    return p;
  };

  console.log('\n── the icon delete reaches EVERY recipient, not just the first ──');
  {
    const p = mk('p', RIFLE);
    // Settle via the REAL sweep function (_advanceWeaponSlotTracking), not a manual poke — it's
    // what actually detects a removal and opens the re-announce window now (see its own header
    // comment for why that moved out of appendPlayerTickBody).
    for (let i = 0; i < 3; i++) {
      const b = []; srv.appendPlayerTickBody(b, 'p', p);
      srv._advanceWeaponSlotTracking(p);
    }

    // Loadout change to the laser rifle.
    p._ammoGunId = LASER; p.equippedWeaponId = LASER; p.weaponList = [LASER, SWORD];
    // The sweep runs once per tick regardless of recipient count — it's what OPENS the delete
    // window for RIFLE now that it's left weaponList.
    srv._advanceWeaponSlotTracking(p);

    // Three recipients in ONE tick — the builder must produce the delete for all of them.
    const bodies = [[], [], []];
    for (const b of bodies) srv.appendPlayerTickBody(b, 'p', p);

    bodies.forEach((b, i) => {
      const ops = slotOps(b);
      ok(`recipient ${i + 1} is told to remove the old weapon`,
        ops.some((o) => o.del === RIFLE),
        `ops=${JSON.stringify(ops)} — without the delete the new icon stacks on the old one`);
      ok(`recipient ${i + 1} is given the new weapon`, ops.some((o) => o.add === LASER));
    });
  }

  console.log('\n── and re-announces for a bounded window, then stops (not forever, not just once) ──');
  {
    // The delete used to fire on exactly one tick — found live to be unreliable (a client that
    // missed that one packet, e.g. a backpressure skip, kept the icon forever: "special weapon
    // slot doesn't clear after dying and respawning"). It now repeats for ENTITY_REMOVAL_REPEAT
    // ticks, same idiom as activeEntities' removal stream, then stops.
    const p = mk('p', RIFLE);
    for (let i = 0; i < 3; i++) {
      const b = []; srv.appendPlayerTickBody(b, 'p', p);
      srv._advanceWeaponSlotTracking(p);
    }
    p._ammoGunId = LASER; p.equippedWeaponId = LASER; p.weaponList = [LASER, SWORD];
    srv._advanceWeaponSlotTracking(p);   // detects the removal, opens the window
    const b1 = []; srv.appendPlayerTickBody(b1, 'p', p);
    ok('delete emitted during the change tick', slotOps(b1).some((o) => o.del === RIFLE));

    // Drain the window (a handful of ticks with no further removals) — it must eventually stop.
    let stillDeleting = true;
    for (let i = 0; i < 20 && stillDeleting; i++) {
      srv._advanceWeaponSlotTracking(p);
      const b = []; srv.appendPlayerTickBody(b, 'p', p);
      stillDeleting = slotOps(b).some((o) => o.del === RIFLE);
    }
    ok('and not repeated forever afterwards', !stillDeleting,
      'a permanent delete would fight the client every tick');
  }

  console.log('\n── the 127 repeat budget is per TICK, not per recipient ──');
  {
    const p = mk('p', RIFLE);
    p.weaponSendCount = 2;
    // Four recipients in one tick: all four must receive 127 while the budget is > 0.
    let got = 0;
    for (let i = 0; i < 4; i++) { const b = []; srv.appendPlayerTickBody(b, 'p', p); if (has127(b)) got++; }
    ok('every recipient in the tick gets 127', got === 4, `${got}/4`);
    ok('the budget did not drain per recipient', p.weaponSendCount === 2,
      `weaponSendCount=${p.weaponSendCount} — draining here starves later recipients`);
  }

  console.log('\n── a live loadout change re-emits the equipped weapon ──');
  {
    const p = mk('p', RIFLE);
    p.weaponSendCount = 0;                            // settled: 127 no longer being sent
    const session = { playerId: 'p', weaponId: RIFLE, playerState: p };
    const b0 = []; srv.appendPlayerTickBody(b0, 'p', p);
    ok('quiet before the change (127 absent)', !has127(b0));

    srv.applyLiveLoadout(session, p, JSON.stringify({ abilityLoadoutId: LASER }), new Map());
    ok('the weapon actually changed', p.equippedWeaponId === LASER, String(p.equippedWeaponId));
    ok('127 is scheduled for re-emission', p.weaponSendCount > 0,
      'without this, peers keep rendering the old weapon in hand — 127 is delta-emitted');
    const b1 = []; srv.appendPlayerTickBody(b1, 'p', p);
    ok('and it is on the wire', has127(b1) && b1[b1.indexOf(127) + 1] === LASER);
  }

  console.log('\n── respawn puts the primary back in your hands ──');
  {
    const p = mk('p', RIFLE);
    // Died mid-melee: BOTH the weapon in hand and the magazine pointer are on the sword. Moving the
    // magazine too matters — leaving it on the rifle would let the next assertion pass without the
    // fix doing anything.
    p.equippedWeaponId = SWORD;
    p._ammoGunId = SWORD;
    p.gunAmmo = 0;
    p.healthPoints = 0; p.deathStateTimer = 99999;
    srv.processDeathRespawn(new Map([['p', { accepted: true, playerState: p, playerId: 'p' }]]));
    ok('respawned holding the primary, not the sword', p.equippedWeaponId === RIFLE,
      `equipped=${p.equippedWeaponId}`);
    ok('and the magazine followed it back to the primary',
      p._ammoGunId === RIFLE && p.gunAmmo > 0,
      `ammoGun=${p._ammoGunId} ammo=${p.gunAmmo} — started on the sword with 0 rounds`);
  }

  console.log('\n── sword-only players keep the sword ──');
  {
    // weaponList of [262] is what sword-only produces; respawn must not try to "restore" a primary.
    const p = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 'q');
    p.equippedWeaponId = SWORD; p._ammoGunId = SWORD; p.weaponList = [SWORD];
    p.healthPoints = 0; p.deathStateTimer = 99999;
    srv.processDeathRespawn(new Map([['q', { accepted: true, playerState: p, playerId: 'q' }]]));
    ok('still the sword after respawn', p.equippedWeaponId === SWORD, String(p.equippedWeaponId));
  }

  console.log('\n── a weapon change starts the switch timer (opcode 129 / Q3igok2) ──');
  {
    // Q3igok2 is what the client gates firing (:43956) and reloading (:43981) on, plays the peer
    // 'switch_weapon' animation from (:45718), and dips the FP weapon through (:48111). We only
    // ever sent -1 while alive, so a loadout swap was silent and peers kept the old model until
    // the owner did a manual switch — the one thing that was re-sending opcode 127.
    const p = mk('p', RIFLE);
    p._ps.Qz8l93a.Qhswtsz = 10;                       // switch delay, in ticks
    const at129 = (b) => b[b.indexOf(129) + 1];

    const idle = []; srv.appendPlayerTickBody(idle, 'p', p);
    ok('129 is -1 when not switching', at129(idle) === -1, String(at129(idle)));

    const session = { playerId: 'p', weaponId: RIFLE, playerState: p };
    srv.applyLiveLoadout(session, p, JSON.stringify({ abilityLoadoutId: LASER }), new Map());
    ok('a live loadout change starts the timer', p.switchTimer === 10, String(p.switchTimer));
    const mid = []; srv.appendPlayerTickBody(mid, 'p', p);
    ok('and it goes on the wire', at129(mid) === 10, String(at129(mid)));
    ok('the physics state agrees (g() gates firing on it)',
      p._ps.Q3igok2 === 10, String(p._ps.Q3igok2));
  }

  console.log('\n── opcode 127\'s re-announce window is tunable (weaponSendRepeatTicks) ──');
  {
    // "my peer is holding a sword in my view but he says he's holding a gun" — 127/128 are delta-
    // emitted (absent = unchanged), so a client that misses every packet in the repeat window keeps
    // rendering the OLD weapon on that peer indefinitely. The window used to be a flat 6 ticks
    // (300ms) hardcoded at 7 different call sites; now it's one live setting all of them share, so
    // a bad connection gets more chances without a code change.
    const S = require('../settings');
    S.set('weaponSendRepeatTicks', 33, 'test');
    const p = mk('p', RIFLE);
    p.weaponSendCount = 0;   // settled, matching the adjacent "live loadout change" test's setup
    const session = { playerId: 'p', weaponId: RIFLE, playerState: p };
    srv.applyLiveLoadout(session, p, JSON.stringify({ abilityLoadoutId: LASER }), new Map());
    ok('a loadout change sets weaponSendCount to the CURRENT setting value, not a hardcoded 6',
      p.weaponSendCount === 33, String(p.weaponSendCount));
    S.set('weaponSendRepeatTicks', 20, 'test');   // restore the default
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
