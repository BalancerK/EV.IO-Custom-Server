/**
 * test_abilities.js
 *
 * Verifies three gameplay mechanics that were previously broken on the server:
 *
 *  1. Double jump  — pressing jump while airborne gives a second jump impulse.
 *                    Root cause: Q7v2lyo was 1 (only ground jump); fixed to 2.
 *
 *  2. Slide entry speed boost — crouching while sprinting gives a 1.5× velocity
 *                    boost on the first crouching frame.
 *                    Root cause: tickMovement passed null as prevPlayerState (i);
 *                    slide boost uses null !== i guard.  Fixed: pass snapshot.
 *
 *  3. Teleport (key 9) — pressing 9 while looking forward teleports the player
 *                    ~Qkrh1tv units in the view direction.
 *                    Root cause: ed.Qvxae88() returned undefined; ed.Q94ze8t()
 *                    returned false.  Fixed: both return non-null/true.
 *                    Also: Qkrh1tv was 1 (1-unit jump); fixed to 12.
 *
 * Usage:
 *   node scripts/test_abilities.js
 */
'use strict';

const bpw = require('../physics_world');

bpw.ready.then(() => {
  const srv  = require('../local_ws_server');
  const phys = require('../physics_extracted');
  runTests(srv, phys);
}).catch(err => {
  console.error('[abilities-test] bpw load failed:', err);
  process.exit(1);
});

// ── helpers ─────────────────────────────────────────────────────────────────

function makeFrame(held = [], pressed = []) {
  return [1.0, [held, pressed, [], [0, 0], null, null]];
}
function makePacket(frames) {
  return [0, 0, 0, 0, 0, frames];
}
// The teleport ability dashes the player forward, so the start point needs clear space along the
// facing direction (yaw 0 => -Z). Asking the collision world beats trusting a spawn index: the
// spawn table is map data and moved once already when its transform was corrected.
const { pickOpenSpawn } = require('./open_spawn');
let _openSpawns = null;
function openSpawn(i) {
  if (!_openSpawns) {
    _openSpawns = [];
    const all = bpw.spawnPoints.slice();
    for (let n = 0; n < 4; n++) {
      const pick = pickOpenSpawn(bpw.world, all, { dirX: 0, dirZ: -1, minClear: 12 });
      _openSpawns.push(pick);
      all.splice(all.indexOf(bpw.spawnPoints[pick.index] ?? all[pick.index]), 1);
      if (!all.length) break;
    }
  }
  return _openSpawns[i % _openSpawns.length];
}

function spawnAt(srv, spawnIndex, id) {
  const sp = openSpawn(spawnIndex);
  const ps = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, id);
  // Settle 5 ticks
  for (let t = 0; t < 5; t++) srv.integratePlayerSim(ps, 0.05, t);
  return ps;
}

// ── test runner ──────────────────────────────────────────────────────────────

function runTests(srv, phys) {
  let pass = 0, fail = 0;
  function ok(desc, cond, detail = '') {
    if (cond) { console.log(`  ✓ ${desc}`); pass++; }
    else       { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
  }

  // ── 1. Double jump ────────────────────────────────────────────────────────
  console.log('\n── Test 1: Double jump ──');
  {
    const ps = spawnAt(srv, 0, 'ab-jump');
    ok('settled grounded', ps.grounded, `grounded=${ps.grounded}`);

    // First jump (ground)
    const y0 = ps.position.y;
    srv.foldClientInputIntoSim(ps, makePacket([makeFrame([4], [4])]));
    srv.integratePlayerSim(ps, 0.05, 10);
    const y1 = ps.position.y;
    ok('ground jump: Y increases', y1 > y0, `y0=${y0.toFixed(3)} y1=${y1.toFixed(3)}`);
    ok('ground jump: now airborne', !ps.grounded);

    // Keep key held (no new press) for 3 ticks while rising
    for (let t = 11; t <= 13; t++) {
      srv.foldClientInputIntoSim(ps, makePacket([makeFrame([4], [])]));
      srv.integratePlayerSim(ps, 0.05, t);
    }
    const yMid = ps.position.y;

    // Second jump (air) — press jump again while still airborne
    srv.foldClientInputIntoSim(ps, makePacket([makeFrame([4], [4])]));
    srv.integratePlayerSim(ps, 0.05, 14);
    const y2 = ps.position.y;
    ok('air jump: Y increases after mid-air press',
      y2 > yMid,
      `yMid=${yMid.toFixed(3)} y2=${y2.toFixed(3)}`);

    // Let player land
    for (let t = 15; t <= 50; t++) {
      srv.foldClientInputIntoSim(ps, makePacket([makeFrame([], [])]));
      srv.integratePlayerSim(ps, 0.05, t);
    }
    ok('lands after double jump', ps.grounded,
      `grounded=${ps.grounded} y=${ps.position.y.toFixed(3)}`);
  }

  // ── 2. Slide entry boost ──────────────────────────────────────────────────
  console.log('\n── Test 2: Slide entry speed boost ──');
  {
    const ps = spawnAt(srv, 2, 'ab-slide');
    ok('slide: settled grounded', ps.grounded);

    // Sprint for 10 ticks to reach full speed
    for (let t = 5; t <= 14; t++) {
      srv.foldClientInputIntoSim(ps, makePacket([makeFrame([0, 7], [])]));
      srv.integratePlayerSim(ps, 0.05, t);
    }
    const preBoostSpeed = Math.hypot(ps.velocity.x, ps.velocity.z);
    console.log(`  Pre-slide speed: ${preBoostSpeed.toFixed(4)} u/tick`);

    // Crouch on tick 15 (first slide frame) — should trigger boost
    srv.foldClientInputIntoSim(ps, makePacket([makeFrame([0, 7, 8], [8])]));
    srv.integratePlayerSim(ps, 0.05, 15);
    const postBoostSpeed = Math.hypot(ps.velocity.x, ps.velocity.z);
    console.log(`  Post-slide speed: ${postBoostSpeed.toFixed(4)} u/tick (should be ~1.5× pre)`);

    ok('slide boost: post-slide speed > pre-slide speed',
      postBoostSpeed > preBoostSpeed,
      `pre=${preBoostSpeed.toFixed(4)} post=${postBoostSpeed.toFixed(4)}`);
    ok('slide boost: speed multiplied ≥ 1.2× (1.5× minus decay tolerance)',
      postBoostSpeed >= preBoostSpeed * 1.2,
      `ratio=${(postBoostSpeed/preBoostSpeed).toFixed(3)} (expected ≥ 1.20)`);
    ok('slide boost: speed multiplied ≤ 2.0× (not runaway)',
      postBoostSpeed <= preBoostSpeed * 2.0,
      `ratio=${(postBoostSpeed/preBoostSpeed).toFixed(3)}`);
  }

  // ── 3. Teleport (key 9) ───────────────────────────────────────────────────
  console.log('\n── Test 3: Teleport (key 9) ──');
  {
    const ps = spawnAt(srv, 4, 'ab-tp');
    ok('teleport: settled', ps.grounded);

    const x0 = ps.position.x, z0 = ps.position.z, y0 = ps.position.y;
    console.log(`  Pre-teleport: (${x0.toFixed(3)}, ${y0.toFixed(3)}, ${z0.toFixed(3)})`);

    // Press key 9 (teleport) — single press
    srv.foldClientInputIntoSim(ps, makePacket([makeFrame([9], [9])]));
    srv.integratePlayerSim(ps, 0.05, 20);

    const x1 = ps.position.x, z1 = ps.position.z, y1 = ps.position.y;
    const dist = Math.hypot(x1 - x0, z1 - z0);
    console.log(`  Post-teleport: (${x1.toFixed(3)}, ${y1.toFixed(3)}, ${z1.toFixed(3)})`);
    console.log(`  Horizontal displacement: ${dist.toFixed(3)} units (expected ~12)`);

    ok('teleport: player moved horizontally > 2 units', dist > 2,
      `dist=${dist.toFixed(3)}`);
    ok('teleport: player moved < 30 units (not a launch)', dist < 30,
      `dist=${dist.toFixed(3)}`);

    // After teleport, Qctsdxd should be reduced (< 1 means cooldown started)
    // Access raw physics state via playerState._ps
    const rawPs = ps._ps;
    if (rawPs) {
      const charge = rawPs.Qctsdxd;
      console.log(`  Ability charge after teleport: ${charge.toFixed(3)} (should be < 1.0)`);
      ok('teleport: ability charge deducted (Qctsdxd < 1)', charge < 1,
        `Qctsdxd=${charge.toFixed(3)}`);
    } else {
      ok('teleport: raw physics state accessible', false, '_ps is null');
    }

    // Second teleport immediately should NOT fire (charge used)
    const x2pre = ps.position.x, z2pre = ps.position.z;
    srv.foldClientInputIntoSim(ps, makePacket([makeFrame([9], [9])]));
    srv.integratePlayerSim(ps, 0.05, 21);
    const dist2 = Math.hypot(ps.position.x - x2pre, ps.position.z - z2pre);
    console.log(`  Second teleport distance (should be ~0): ${dist2.toFixed(3)}`);
    ok('teleport: second teleport blocked by cooldown (moved < 1 unit)', dist2 < 1,
      `dist=${dist2.toFixed(3)}`);
  }

  // ── Summary ─────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}
