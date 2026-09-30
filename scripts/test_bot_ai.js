/**
 * test_bot_ai.js — bot AI decision logic (vision, target selection, aim/fire, navigation) in
 * isolation from the session/socket/tick-loop plumbing test_bot_session.js already covers.
 *
 * Each piece is exported as a plain function specifically so it can be driven directly with
 * synthetic sessions here, rather than only being reachable by running a real bot for N real ticks
 * and hoping the right thing happened to occur.
 *
 * Usage:  node scripts/test_bot_ai.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';

const fs = require('fs');
const path = require('path');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const botDifficulty = require('../bot_difficulty');
const navPath = require('../navmesh_pathfinder');
const S = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

function mkSession(id, x, y, z, overrides = {}) {
  const ps = srv.createPlayerSimState({ x, y, z, yaw: 0 }, id);
  Object.assign(ps, overrides);
  return { playerId: id, sessionId: id, accepted: true, isBot: id.startsWith('bot'), playerState: ps };
}

(async () => {
  await bpw.ready;

  console.log('\n── _yawPitchToward matches the REAL movement path forward direction ──');
  {
    // Ground truth, not self-referential: integratePlayerSim with held=forward at yaw=PI/2 moves x
    // NEGATIVE (verified directly against a fresh playerState below), i.e. forward = (-sin(yaw),
    // -cos(yaw)). An earlier version of this test built its expected target from the WRONG sign
    // (taken from dead teleport-fallback code, never from the real movement path) and passed
    // anyway, because it round-tripped against itself rather than against real physics — exactly
    // the class of bug this project has hit before with harness artifacts. Both are checked here.
    const probe = srv.createPlayerSimState({ x: 0, y: 20, z: 0, yaw: Math.PI / 2 }, 'yawcheck');
    for (let i = 0; i < 5; i++) srv.integratePlayerSim(probe, 0.05, i, [[1, [[0], [], [], [0, 0]]]]);
    ok('ground truth: forward at yaw=PI/2 moves x NEGATIVE (movement path itself)', probe.position.x < -0.01,
      String(probe.position.x));

    for (const testYaw of [0, 0.7, -1.2, Math.PI / 2, -Math.PI / 2, 3.0]) {
      const dist = 25;
      const tx = -Math.sin(testYaw) * dist, tz = -Math.cos(testYaw) * dist;
      const { yaw } = srv._yawPitchToward(0, 0, 0, tx, 0, tz);
      const err = Math.abs(srv._wrapAngle(yaw - testYaw));
      ok(`yaw ${testYaw.toFixed(2)} round-trips (err=${err.toExponential(2)})`, err < 1e-6);
    }
    // Pitch: a target directly above should read a positive (upward) pitch close to +90 deg.
    const { pitch: pUp } = srv._yawPitchToward(0, 0, 0, 0, 10, 0);
    ok('a target straight up gives pitch near +PI/2', Math.abs(pUp - Math.PI / 2) < 1e-6, String(pUp));
    const { pitch: pDown } = srv._yawPitchToward(0, 10, 0, 0, 0, 0);
    ok('a target straight down gives pitch near -PI/2', Math.abs(pDown + Math.PI / 2) < 1e-6, String(pDown));
  }

  console.log('\n── _visibleEnemies filtering ──');
  {
    // High above the map (y=300) so no geometry can possibly sit between two close-together points,
    // regardless of the map's own layout — the thing under test here is the FILTER logic (self, dead,
    // held, range), not map-specific line-of-sight geometry (that is exercised for real by the
    // integration smoke check further down).
    const bot = mkSession('botA', 0, 300, 0);
    const alive1 = mkSession('p1', 3, 300, 0);
    const dead1 = mkSession('p2', 3, 300, 3, { healthPoints: 0, deathStateTimer: 5 });
    const held1 = mkSession('p3', 3, 300, -3, { _holdForPlay: true });
    const farAway = mkSession('p4', 300, 300, 300);
    const sessions = new Map([['botA', bot], ['p1', alive1], ['p2', dead1], ['p3', held1], ['p4', farAway]]);

    const visible = srv._visibleEnemies(bot, sessions, srv.BOT_ENGAGE_DIST);
    const ids = visible.map((v) => v.session.playerId);
    ok('the bot itself is never in its own visible list', !ids.includes('botA'));
    ok('a dead player is excluded', !ids.includes('p2'));
    ok('a held (spectator) player is excluded', !ids.includes('p3'));
    ok('a player beyond BOT_ENGAGE_DIST is excluded', !ids.includes('p4'));
    ok('a live, in-range, unheld player IS included', ids.includes('p1'), JSON.stringify(ids));
    ok('results are sorted nearest-first', visible.every((v, i) => i === 0 || v.dist >= visible[i - 1].dist));
  }

  console.log('\n── difficulty curve shape: accuracy is LINEAR, other axes stay ease-out ──');
  {
    const c1 = botDifficulty.curveForLevel(1);
    const c5 = botDifficulty.curveForLevel(5);
    const c10 = botDifficulty.curveForLevel(10);
    // Level-1 endpoint widened from 12° to 25° — 12° still landed close to a real hit too often at
    // typical engagement ranges to read as a genuine beginner; see bot_difficulty.js's own comment.
    ok('level 1 cone is 25deg (widened from the old 12deg — a low-level bot should be genuinely sloppy)',
      Math.abs(c1.aimConeInitialDeg - 25) < 1e-9, String(c1.aimConeInitialDeg));
    ok('level 10 cone is unchanged at 1.5deg (still reaches the sharpest point at the top)',
      Math.abs(c10.aimConeInitialDeg - 1.5) < 1e-9, String(c10.aimConeInitialDeg));
    // Straight line from 25 to 1.5 over t=(level-1)/9: at level 5, t=4/9.
    const expectedLinear5 = 25 + (1.5 - 25) * (4 / 9);
    ok('level 5 cone matches a PLAIN LINEAR interpolation, not ease-out',
      Math.abs(c5.aimConeInitialDeg - expectedLinear5) < 1e-6,
      `got=${c5.aimConeInitialDeg} expected=${expectedLinear5}`);
    // The old ease-out value at level 5 was ~4.74deg — well below the linear midpoint on EITHER
    // endpoint. Confirm the regression this was fixing stays fixed: level 5 must not be anywhere
    // near that old figure.
    ok('level 5 is meaningfully less accurate than the old ease-out curve made it (not ~4.7deg)',
      c5.aimConeInitialDeg > 6, String(c5.aimConeInitialDeg));

    // reactionMs is one of the axes that must STILL be ease-out (this fix was scoped to accuracy
    // only) — confirm level 5 is well below the linear midpoint of 700/150, matching ease-out's
    // faster-early shape rather than accidentally having gone linear too.
    const linearMid = (700 + 150) / 2;
    ok('reactionMs at level 5 is still ease-out shaped (below the linear midpoint), unaffected by the accuracy fix',
      c5.reactionMs < linearMid, `got=${c5.reactionMs} linearMid=${linearMid}`);
  }

  console.log('\n── difficulty curve: combat movement floor is not near-frozen at level 1 ──');
  {
    const c1 = botDifficulty.curveForLevel(1);
    const c10 = botDifficulty.curveForLevel(10);
    ok('level 1 strafeProbability is well above the old 0.15 (bots should not stand dead still 85% of the time)',
      c1.strafeProbability >= 0.35 - 1e-9, String(c1.strafeProbability));
    ok('level 10 strafeProbability is raised to match (still highest at the top)',
      Math.abs(c10.strafeProbability - 0.85) < 1e-9, String(c10.strafeProbability));
    ok('level 10 is still more mobile than level 1 (skill axis preserved, just not near-frozen at the bottom)',
      c10.strafeProbability > c1.strafeProbability);
  }

  console.log('\n── vision scan throttling: cuts raycast frequency without breaking correctness ──');
  {
    // This is the actual hot path MEASURED live on the VPS: with real bot combat running,
    // driveBots (which calls this once per bot, every tick) cost 10-24ms on its own and tick
    // overruns climbed measurably during active fights. _visibleEnemiesThrottled caches the
    // raycast-heavy result for botVisionScanIntervalTicks ticks instead of rescanning every tick.
    const bot = mkSession('vsA', 0, 300, 0);
    const enemy = mkSession('vsE', 3, 300, 0);
    const sessions = new Map([['vsA', bot], ['vsE', enemy]]);
    bot._ai = {};
    const interval = S.get('botVisionScanIntervalTicks');

    const first = srv._visibleEnemiesThrottled(bot, sessions, srv.BOT_ENGAGE_DIST, 0);
    ok('first call computes and caches a real result', Array.isArray(first) && first.length === 1);
    ok('the cache tick was stamped', bot._ai._visCacheTick === 0);

    // Remove the enemy WITHOUT advancing far enough to be due for a rescan — the cached (stale)
    // result should still be returned, proving the expensive scan was actually skipped rather than
    // silently running anyway.
    sessions.delete('vsE');
    const stillCached = srv._visibleEnemiesThrottled(bot, sessions, srv.BOT_ENGAGE_DIST, interval - 1);
    ok('within the scan interval, the STALE cached result is reused (the enemy still "appears" visible)',
      stillCached === first && stillCached.length === 1, `length=${stillCached.length}`);

    // Now advance PAST the interval — this call is due for a fresh scan, which must reflect reality.
    const rescanned = srv._visibleEnemiesThrottled(bot, sessions, srv.BOT_ENGAGE_DIST, interval);
    ok('once due for a rescan, the result is fresh (the removed enemy is gone)', rescanned.length === 0,
      `length=${rescanned.length}`);
    ok('the cache tick advanced to the rescan tick', bot._ai._visCacheTick === interval);
  }

  console.log('\n── target acquisition, drop, and reacquisition timing ──');
  {
    const curve = botDifficulty.curveForLevel(5);
    const bot = mkSession('botB', 0, 300, 0);
    const enemy = mkSession('e1', 3, 300, 0);
    let sessions = new Map([['botB', bot], ['e1', enemy]]);
    bot._ai = { targetId: null, targetLockTicks: 0, lastSeenTick: 0, acquiredTick: 0 };

    let { current } = srv._updateBotTarget(bot, sessions, curve, 100);
    ok('a visible enemy is acquired as the target immediately', !!current && current.session.playerId === 'e1');
    ok('acquiredTick is stamped at the acquisition tick', bot._ai.acquiredTick === 100);

    for (let t = 101; t < 110; t++) srv._updateBotTarget(bot, sessions, curve, t);
    ok('targetLockTicks accumulates while the same target stays visible', bot._ai.targetLockTicks >= 9,
      String(bot._ai.targetLockTicks));

    // Enemy vanishes (out of LOS / range) — simulate by removing them from the session map entirely,
    // equivalent to _visibleEnemies no longer reporting them.
    sessions = new Map([['botB', bot]]);
    let stillTarget = true;
    let t = 110;
    for (; t < 110 + 40; t++) {
      const r = srv._updateBotTarget(bot, sessions, curve, t);
      if (!bot._ai.targetId) { stillTarget = false; break; }
    }
    ok('the target is eventually dropped once it is no longer visible', !stillTarget,
      `still tracked at t=${t}`);

    // Re-add the enemy — a fresh acquisition should reset lock/reaction timing rather than resuming
    // the old lock count, since this is (as far as the bot's memory goes) a fresh sighting.
    //
    // Reacquisition is not necessarily instant on the VERY NEXT call: _updateBotTarget's visibility
    // scan is throttled (botVisionScanIntervalTicks, see _visibleEnemiesThrottled) to cut the raycast
    // cost that was measurably eating into the tick budget under real bot combat, so a re-added
    // enemy is picked up within that interval, not necessarily on the first tick after. Loop a
    // generous margin past the configured interval rather than asserting on a single call.
    sessions.set('e1', enemy);
    const before = bot._ai.targetLockTicks;
    const scanMargin = S.get('botVisionScanIntervalTicks') + 2;
    let reacquired = null;
    for (let rt = t + 1; rt < t + 1 + scanMargin && !reacquired; rt++) {
      reacquired = srv._updateBotTarget(bot, sessions, curve, rt).current;
    }
    ok('the same enemy can be reacquired after being dropped', !!reacquired);
    ok('reacquisition resets the lock count rather than continuing the old one',
      bot._ai.targetLockTicks <= before || bot._ai.targetLockTicks === 1, String(bot._ai.targetLockTicks));
  }

  console.log('\n── aim/fire: no target and pre-reaction-time both produce no input ──');
  {
    const curve = botDifficulty.curveForLevel(5);
    const bot = mkSession('botC', 0, 300, 0);
    bot._ai = { targetId: null, targetLockTicks: 0, lastSeenTick: 0, acquiredTick: 50,
      aimNoiseYaw: 0, aimNoisePitch: 0 };

    const noTarget = srv._aimAndFire(bot, curve, null, 0.05, 60);
    ok('no target -> zero look delta and no fire', noTarget.lookDelta[0] === 0
      && noTarget.lookDelta[1] === 0 && noTarget.fire === false);

    const target = { session: mkSession('e2', 5, 300, 0), eye: { x: 5, y: 301.6, z: 0 }, dist: 5 };
    const tooSoon = srv._aimAndFire(bot, curve, target, 0.05, 51);   // 1 tick after acquiredTick=50
    ok('still inside the reaction window -> no fire yet',
      tooSoon.fire === false && tooSoon.lookDelta[0] === 0 && tooSoon.lookDelta[1] === 0);
  }

  console.log('\n── aim/fire: after reaction time, aim converges toward the target and eventually fires ──');
  {
    // Level 10 (fast reaction, fast turn rate, tight cone) should converge and fire in noticeably
    // fewer ticks than level 1 given the SAME starting geometry — the whole point of the curve.
    function simulate(level) {
      const curve = botDifficulty.curveForLevel(level);
      const bot = mkSession(`botD${level}`, 0, 300, 0);
      bot._ai = { targetId: 'e3', targetLockTicks: 0, lastSeenTick: 0, acquiredTick: 0,
        aimNoiseYaw: 0, aimNoisePitch: 0 };
      const target = { session: mkSession('e3', 8, 300, 0), eye: { x: 8, y: 301.6, z: 0 }, dist: 8 };
      let fireTick = -1;
      for (let t = 0; t < 400; t++) {
        bot._ai.targetLockTicks = t;
        const { lookDelta, fire } = srv._aimAndFire(bot, curve, target, 0.05, t);
        bot.playerState.yaw += lookDelta[0];
        bot.playerState.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, bot.playerState.pitch + lookDelta[1]));
        if (fire && fireTick < 0) fireTick = t;
      }
      return fireTick;
    }
    const fireTickLow = simulate(1);
    const fireTickHigh = simulate(10);
    ok('both difficulty levels eventually get a clear enough shot within 400 ticks (20s)',
      fireTickLow >= 0 && fireTickHigh >= 0, `low=${fireTickLow} high=${fireTickHigh}`);
    ok('level 10 reaches its first shot no later than level 1 on identical geometry',
      fireTickHigh <= fireTickLow, `low=${fireTickLow} high=${fireTickHigh}`);
  }

  console.log('\n── aim/fire: bearing far off target never fires, regardless of level ──');
  {
    for (const level of [1, 10]) {
      const curve = botDifficulty.curveForLevel(level);
      const bot = mkSession(`botE${level}`, 0, 300, 0);
      bot.playerState.yaw = Math.PI;   // facing the exact OPPOSITE way from the target
      bot._ai = { targetId: 'e4', targetLockTicks: 500, lastSeenTick: 0, acquiredTick: 0,
        aimNoiseYaw: 0, aimNoisePitch: 0 };
      const target = { session: mkSession('e4', 8, 300, 0), eye: { x: 8, y: 301.6, z: 0 }, dist: 8 };
      const { fire } = srv._aimAndFire(bot, curve, target, 0.05, 1000);
      ok(`level ${level} does not fire while facing 180 degrees away`, fire === false);
    }
  }

  console.log('\n── navigation: path-follow over a synthetic navmesh, with real map geometry underneath ──');
  {
    // Swap in a tiny, fully-known navmesh (3 nodes in a line) on top of the ALREADY-LOADED real
    // world (bpw.world) — the world/collision itself is irrelevant to this test, only the graph
    // shape is, and reusing the loaded world avoids rebuilding physics geometry just for this.
    const savedNavmesh = bpw.navmesh;
    const syntheticNodes = [
      { x: 0, y: 0, z: 0, links: [1], tag: 'Ground' },
      { x: 10, y: 0, z: 0, links: [0, 2], tag: 'Ground' },
      { x: 20, y: 0, z: 0, links: [1], tag: 'Ground' },
    ];
    bpw.setActiveWorld({
      world: bpw.world, spawns: bpw.spawnPoints, teleporters: [], navmesh: syntheticNodes,
      vertices: bpw.vertices, indices: bpw.indices, groupIds: bpw.groupIds, name: 'test-nav',
    });

    try {
      const bot = mkSession('botNav', 0, 0, 0);
      // _pickWanderGoal is RANDOM (by design — a bot always picking the same patrol point would
      // look scripted), and this bot starts exactly ON node 0. A goal pick of node 0 itself is a
      // legitimate, if unlucky, choice — the path is a single node with distance 0, so there is
      // nothing to walk toward and _navigate correctly does not hold forward. Rather than a test
      // that occasionally fails on that 1-in-3 draw, the path is seeded directly here to the FAR
      // node (2) so this assertion is about _navigate's follow logic specifically, not about which
      // goal got picked (that randomness is exercised for real by the live integration check below).
      const graph = srv._botNavGraph();
      bot._ai = {
        path: navPath.findPath(graph, { x: 0, y: 0, z: 0 }, syntheticNodes[2], { snapDist: 40 }),
        nextRepathTick: 0,
      };
      let movedForward = false;
      for (let t = 0; t < 30; t++) {
        const nav = srv._navigate(bot, t);
        if (nav.held.includes(0)) movedForward = true;
        // A cheap stand-in for real physics integration: walking forward moves along +/- the
        // computed yaw direction a small step, enough to let the bot actually reach a waypoint
        // within this loop rather than spinning in place forever.
        if (nav.held.includes(0)) {
          bot.playerState.position.x += -Math.sin(bot.playerState.yaw) * 0.5;
          bot.playerState.position.z += -Math.cos(bot.playerState.yaw) * 0.5;
        }
        bot.playerState.yaw += nav.lookDelta[0];
      }
      ok('the bot picks a path and walks forward along it at least once', movedForward);
      ok('a path was actually assigned', Array.isArray(bot._ai.path));
    } finally {
      // Restore the real navmesh so nothing else in a longer test run (or npm test's chain) is
      // affected by this synthetic override.
      bpw.setActiveWorld({
        world: bpw.world, spawns: bpw.spawnPoints, teleporters: bpw.teleporters, navmesh: savedNavmesh,
        vertices: bpw.vertices, indices: bpw.indices, groupIds: bpw.groupIds, name: 'Bishop',
      });
    }
  }

  console.log('\n── stuck detection: a bot that holds forward but never actually moves triggers recovery ──');
  {
    const savedNavmesh = bpw.navmesh;
    const syntheticNodes = [
      { x: 0, y: 0, z: 0, links: [1], tag: 'Ground' },
      { x: 20, y: 0, z: 0, links: [0], tag: 'Ground' },
    ];
    bpw.setActiveWorld({
      world: bpw.world, spawns: bpw.spawnPoints, teleporters: [], navmesh: syntheticNodes,
      vertices: bpw.vertices, indices: bpw.indices, groupIds: bpw.groupIds, name: 'test-nav-stuck',
    });
    try {
      const bot = mkSession('botStuck', 0, 0, 0);
      const graph = srv._botNavGraph();
      bot._ai = {
        path: navPath.findPath(graph, { x: 0, y: 0, z: 0 }, syntheticNodes[1], { snapDist: 40 }),
        nextRepathTick: 0,
      };
      let sawRecoveryHeld = false;
      let t = 0;
      // Deliberately never move playerState.position — this is the wedged-against-geometry case:
      // the bot keeps trying (held includes forward) but makes zero real progress every tick.
      for (; t < 45; t++) {
        const nav = srv._navigate(bot, t);
        bot.playerState.yaw += nav.lookDelta[0];
        // The recovery frame's signature is held=[0,2,7] (forward+strafe-left+sprint) turned AWAY
        // from the original heading — distinct from normal patrol's held=[0,7].
        if (nav.held.includes(2)) sawRecoveryHeld = true;
      }
      ok('after ~1.5s of zero progress, recovery engages (held includes the strafe-away key)',
        sawRecoveryHeld);
      ok('_recoveryUntilTick was actually set on the ai state', bot._ai._recoveryUntilTick > 0,
        String(bot._ai._recoveryUntilTick));

      // Run up to (not past) the recovery window's end, blocking the immediate same-call repath via
      // the cooldown so the discard itself is observable — otherwise, with this synthetic graph's
      // only 2 nodes, clearing the path and picking a new goal in the same call looks identical to
      // "resumed the old path" even though it genuinely re-planned, which would make this assertion
      // pass regardless of whether the discard actually happened.
      const recoveryEndsAt = bot._ai._recoveryUntilTick;
      for (; t < recoveryEndsAt; t++) srv._navigate(bot, t);
      bot._ai.nextRepathTick = recoveryEndsAt + 1000;   // block the immediate repath attempt
      srv._navigate(bot, t);
      ok('recovery ends and clears itself rather than running forever',
        !bot._ai._recoveryUntilTick, String(bot._ai._recoveryUntilTick));
      ok('the trapping path was discarded, not resumed (repath is on cooldown, so it truly stays empty)',
        !bot._ai.path || bot._ai.path.length === 0, JSON.stringify(bot._ai.path));
    } finally {
      bpw.setActiveWorld({
        world: bpw.world, spawns: bpw.spawnPoints, teleporters: bpw.teleporters, navmesh: savedNavmesh,
        vertices: bpw.vertices, indices: bpw.indices, groupIds: bpw.groupIds, name: 'Bishop',
      });
    }
  }

  console.log('\n── stuck detection: a bot making REAL progress never falsely triggers recovery ──');
  {
    const bot = mkSession('botMoving', 0, 0, 0);
    const graph = srv._botNavGraph();
    const goal = srv._pickWanderGoal(graph);
    bot._ai = {
      path: navPath.findPath(graph, bot.playerState.position, goal, { snapDist: 40 }) || [goal],
      nextRepathTick: 0,
    };
    for (let t = 0; t < 45; t++) {
      const nav = srv._navigate(bot, t);
      if (nav.held.includes(0)) {
        bot.playerState.position.x += -Math.sin(bot.playerState.yaw) * 0.5;
        bot.playerState.position.z += -Math.cos(bot.playerState.yaw) * 0.5;
      }
      bot.playerState.yaw += nav.lookDelta[0];
    }
    ok('a bot that is genuinely covering ground never enters recovery',
      !bot._ai._recoveryUntilTick, String(bot._ai._recoveryUntilTick));
  }

  console.log('\n── sword combat: no target -> idle frame, nothing thrown ──');
  {
    const bot = mkSession('swA', 0, 300, 0);
    bot._ai = { targetId: 't', targetLockTicks: 500, lastSeenTick: 0, acquiredTick: 0,
      aimNoiseYaw: 0, aimNoisePitch: 0 };
    const frame = srv._swordCombatFrame(bot, botDifficulty.curveForLevel(5), null, 100);
    ok('empty held/pressed/released and zero lookDelta with no target',
      frame.held.length === 0 && frame.pressed.length === 0 && frame.released.length === 0
      && frame.lookDelta[0] === 0 && frame.lookDelta[1] === 0, JSON.stringify(frame));
  }

  console.log('\n── sword combat: far from target -> approaches once roughly facing it ──');
  {
    const bot = mkSession('swB', 0, 300, 0);
    bot._ai = { targetId: 't', targetLockTicks: 500, lastSeenTick: 0, acquiredTick: 0,
      aimNoiseYaw: 0, aimNoisePitch: 0 };
    bot.playerState._ps.Qctsdxd = 0; bot.playerState._ps.Qctsdxa = 0;   // no charges -> isolates movement
    const targetSession = mkSession('t', 0, 300, -20);   // 20 units away, well beyond melee range
    const target = { session: targetSession, eye: { x: 0, y: 301.6, z: -20 }, dist: 20 };
    // Turn the bot to roughly face the target first (aim/turn logic is shared and already tested).
    for (let t = 0; t < 40; t++) srv._swordCombatFrame(bot, botDifficulty.curveForLevel(5), target, t);
    const frame = srv._swordCombatFrame(bot, botDifficulty.curveForLevel(5), target, 40);
    ok('holds forward once facing the far-away target', frame.held.includes(0), JSON.stringify(frame.held));
    ok('holds sprint while closing distance', frame.held.includes(7), JSON.stringify(frame.held));
  }

  console.log('\n── sword combat: in melee range and aimed -> eventually swings ──');
  {
    const bot = mkSession('swC', 0, 300, 0);
    bot._ai = { targetId: 't', targetLockTicks: 0, lastSeenTick: 0, acquiredTick: 0,
      aimNoiseYaw: 0, aimNoisePitch: 0 };
    bot.playerState._ps.Qctsdxd = 0; bot.playerState._ps.Qctsdxa = 0;   // isolate melee/aim from abilities
    const targetSession = mkSession('t', 0, 300, -2);   // 2 units — inside SWORD_MELEE_RANGE
    const target = { session: targetSession, eye: { x: 0, y: 301.6, z: -2 }, dist: 2 };
    let sawFire = false;
    for (let t = 0; t < 300; t++) {
      const frame = srv._swordCombatFrame(bot, botDifficulty.curveForLevel(10), target, t);
      bot.playerState.yaw += frame.lookDelta[0];
      // Pitch must converge too, exactly like the existing aim/fire convergence test above — leaving
      // it unapplied means the aim math re-computes the SAME large capped correction every tick
      // forever (p.pitch never actually moves toward the target), permanently blocking fire.
      bot.playerState.pitch = Math.max(-Math.PI / 2, Math.min(Math.PI / 2, bot.playerState.pitch + frame.lookDelta[1]));
      if (frame.held.includes(5)) sawFire = true;
    }
    ok('the bot eventually swings (fire key 5) once in range and aimed', sawFire);
  }

  console.log('\n── sword combat: zero ability charge never presses Teleport, regardless of tactical situation ──');
  {
    const bot = mkSession('swD', 0, 300, 0);
    bot._ai = { targetId: 't', targetLockTicks: 500, lastSeenTick: 0, acquiredTick: 0,
      aimNoiseYaw: 0, aimNoisePitch: 0 };
    bot.playerState._ps.Qctsdxd = 0;   // no teleport charge at all
    bot.playerState.healthPoints = 0.2;   // wounded — would otherwise be very eager to retreat-teleport
    const targetSession = mkSession('t', 0, 300, -15);
    const target = { session: targetSession, eye: { x: 0, y: 301.6, z: -15 }, dist: 15 };
    let sawTeleport = false;
    for (let t = 0; t < 300; t++) {
      const frame = srv._swordCombatFrame(bot, botDifficulty.curveForLevel(5), target, t);
      if (frame.pressed.includes(9)) sawTeleport = true;
    }
    ok('never presses the Teleport action with zero charge, even wounded and eligible otherwise',
      !sawTeleport);
  }

  console.log('\n── sword combat: RUSH teleport — healthy + far + charged -> blinks TOWARD the target ──');
  {
    const bot = mkSession('swE', 0, 300, 0);
    bot._ai = { targetId: 't', targetLockTicks: 500, lastSeenTick: 0, acquiredTick: 0,
      aimNoiseYaw: 0, aimNoisePitch: 0 };
    bot.playerState._ps.Qctsdxd = 1;   // full charge
    bot.playerState.healthPoints = 1;   // healthy -> rules out the retreat branch
    // dist=25: past SWORD_RUSH_TELEPORT_DIST(18) so rush is eligible, and past the juke range
    // (SWORD_MELEE_RANGE*2.5=10) so juke is NOT — isolates this to the rush branch specifically.
    const targetSession = mkSession('t', 0, 300, -25);
    const target = { session: targetSession, eye: { x: 0, y: 301.6, z: -25 }, dist: 25 };
    let teleportFrame = null;
    for (let t = 0; t < 300 && !teleportFrame; t++) {
      const frame = srv._swordCombatFrame(bot, botDifficulty.curveForLevel(5), target, t);
      if (frame.pressed.includes(9)) teleportFrame = frame;
    }
    ok('a rush teleport eventually triggers', !!teleportFrame);
    if (teleportFrame) {
      // toTargetYaw for a target due -z of the bot is 0 (see _navigate's identical atan2 sign
      // convention) — a rush teleport snap-turns TOWARD it, so the resulting delta should aim the
      // bot back near yaw 0, not the reciprocal (retreat) direction.
      const resultingYaw = srv._wrapAngle(bot.playerState.yaw + teleportFrame.lookDelta[0]);
      ok('the resulting facing points TOWARD the target (near yaw 0), not away',
        Math.abs(resultingYaw) < 0.05, String(resultingYaw));
    }
  }

  console.log('\n── sword combat: RETREAT teleport — wounded -> blinks AWAY from the target ──');
  {
    const bot = mkSession('swF', 0, 300, 0);
    bot._ai = { targetId: 't', targetLockTicks: 500, lastSeenTick: 0, acquiredTick: 0,
      aimNoiseYaw: 0, aimNoisePitch: 0 };
    bot.playerState._ps.Qctsdxd = 1;
    bot.playerState.healthPoints = 0.3;   // wounded -> eligible for retreat
    // dist=15: below SWORD_RUSH_TELEPORT_DIST(18) so rush is NOT eligible, above the juke range
    // (10) so juke is NOT either — isolates this to the retreat branch specifically.
    const targetSession = mkSession('t', 0, 300, -15);
    const target = { session: targetSession, eye: { x: 0, y: 301.6, z: -15 }, dist: 15 };
    let teleportFrame = null;
    for (let t = 0; t < 300 && !teleportFrame; t++) {
      const frame = srv._swordCombatFrame(bot, botDifficulty.curveForLevel(5), target, t);
      if (frame.pressed.includes(9)) teleportFrame = frame;
    }
    ok('a retreat teleport eventually triggers while wounded', !!teleportFrame);
    if (teleportFrame) {
      const resultingYaw = srv._wrapAngle(bot.playerState.yaw + teleportFrame.lookDelta[0]);
      ok('the resulting facing points AWAY from the target (near yaw PI), not toward',
        Math.abs(srv._wrapAngle(resultingYaw - Math.PI)) < 0.05, String(resultingYaw));
    }
  }

  console.log('\n── sword combat: JUKE teleport — already close -> blinks to a lateral offset ──');
  {
    const bot = mkSession('swG', 0, 300, 0);
    bot._ai = { targetId: 't', targetLockTicks: 500, lastSeenTick: 0, acquiredTick: 0,
      aimNoiseYaw: 0, aimNoisePitch: 0 };
    bot.playerState._ps.Qctsdxd = 1;
    bot.playerState.healthPoints = 1;   // healthy -> rules out retreat
    // dist=6: within the juke range (10) and well short of the rush distance (18) -> isolates juke.
    const targetSession = mkSession('t', 0, 300, -6);
    const target = { session: targetSession, eye: { x: 0, y: 301.6, z: -6 }, dist: 6 };
    let teleportFrame = null;
    for (let t = 0; t < 400 && !teleportFrame; t++) {
      const frame = srv._swordCombatFrame(bot, botDifficulty.curveForLevel(5), target, t);
      if (frame.pressed.includes(9)) teleportFrame = frame;
    }
    ok('a juke teleport eventually triggers at close range', !!teleportFrame);
    if (teleportFrame) {
      const resultingYaw = srv._wrapAngle(bot.playerState.yaw + teleportFrame.lookDelta[0]);
      // Juke aims neither straight at (0) nor straight away (PI) — somewhere off to a side.
      ok('the resulting facing is a LATERAL offset, neither straight at nor straight away from the target',
        Math.abs(resultingYaw) > 0.3 && Math.abs(srv._wrapAngle(resultingYaw - Math.PI)) > 0.3,
        String(resultingYaw));
    }
  }

  console.log('\n── sword combat: teleport cooldown gate — cannot fire again immediately after one lands ──');
  {
    const bot = mkSession('swH', 0, 300, 0);
    bot._ai = { targetId: 't', targetLockTicks: 500, lastSeenTick: 0, acquiredTick: 0,
      aimNoiseYaw: 0, aimNoisePitch: 0 };
    bot.playerState._ps.Qctsdxd = 1;
    bot.playerState.healthPoints = 1;
    const targetSession = mkSession('t', 0, 300, -25);
    const target = { session: targetSession, eye: { x: 0, y: 301.6, z: -25 }, dist: 25 };
    let firstTeleportTick = -1;
    for (let t = 0; t < 300 && firstTeleportTick < 0; t++) {
      const frame = srv._swordCombatFrame(bot, botDifficulty.curveForLevel(5), target, t);
      if (frame.pressed.includes(9)) firstTeleportTick = t;
    }
    ok('a teleport landed to establish a baseline', firstTeleportTick >= 0, String(firstTeleportTick));
    if (firstTeleportTick >= 0) {
      let retriggeredEarly = false;
      for (let t = firstTeleportTick + 1; t < firstTeleportTick + 40; t++) {
        const frame = srv._swordCombatFrame(bot, botDifficulty.curveForLevel(5), target, t);
        if (frame.pressed.includes(9)) retriggeredEarly = true;
      }
      ok('does not fire again within the ~2s minimum gap (SWORD_TELEPORT_MIN_GAP_TICKS)',
        !retriggeredEarly);
    }
  }

  console.log('\n── sword combat: impulse throw — wounded and charged -> eventually throws at the target ──');
  {
    const bot = mkSession('swI', 0, 300, 0);
    bot._ai = { targetId: 't', targetLockTicks: 500, lastSeenTick: 0, acquiredTick: 0,
      aimNoiseYaw: 0, aimNoisePitch: 0 };
    bot.playerState._ps.Qctsdxd = 0;    // no teleport charge -> isolates this to the impulse path
    bot.playerState._ps.Qctsdxa = 1;    // full impulse charge
    bot.playerState.healthPoints = 0.25;   // wounded
    const targetSession = mkSession('t', 0, 300, -6);   // within SWORD_IMPULSE_RANGE
    const target = { session: targetSession, eye: { x: 0, y: 301.6, z: -6 }, dist: 6 };
    let sawImpulse = false;
    for (let t = 0; t < 400; t++) {
      const frame = srv._swordCombatFrame(bot, botDifficulty.curveForLevel(5), target, t);
      if (frame.released.includes(38)) sawImpulse = true;
    }
    ok('eventually throws the impulse ability (released action 38)', sawImpulse);
  }

  console.log('\n── sword combat: impulse — full health never throws it, regardless of charge/range ──');
  {
    const bot = mkSession('swJ', 0, 300, 0);
    bot._ai = { targetId: 't', targetLockTicks: 500, lastSeenTick: 0, acquiredTick: 0,
      aimNoiseYaw: 0, aimNoisePitch: 0 };
    bot.playerState._ps.Qctsdxd = 0;
    bot.playerState._ps.Qctsdxa = 1;
    bot.playerState.healthPoints = 1;   // full health
    const targetSession = mkSession('t', 0, 300, -6);
    const target = { session: targetSession, eye: { x: 0, y: 301.6, z: -6 }, dist: 6 };
    let sawImpulse = false;
    for (let t = 0; t < 300; t++) {
      const frame = srv._swordCombatFrame(bot, botDifficulty.curveForLevel(5), target, t);
      if (frame.released.includes(38)) sawImpulse = true;
    }
    ok('never throws impulse above the 50% HP threshold', !sawImpulse);
  }

  console.log('\n── source check: teleport and impulse are mutually exclusive within the same tick ──');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    // _swordCombatFrame is module-level (0-indent), not nested inside startServer() like driveBotFrame
    // — its closing brace has no leading spaces, unlike the 2-space-indented pattern this project's
    // other source-checks use for closure-scoped functions.
    const fnMatch = src.match(/function _swordCombatFrame\([\s\S]*?\n\}/);
    ok('_swordCombatFrame exists', !!fnMatch);
    if (fnMatch) {
      ok('the impulse block is guarded on NOT having just teleported this tick',
        /if \(!teleported\) \{/.test(fnMatch[0]));
    }
  }

  console.log('\n── integration smoke check: navigation over the REAL active navmesh does not throw ──');
  {
    const graph = srv._botNavGraph();
    ok('the real navmesh graph has nodes', graph.nodes.length > 0, String(graph.nodes.length));
    const goal = srv._pickWanderGoal(graph);
    ok('a wander goal can be picked from the real graph', !!goal);
    const bot = mkSession('botReal', goal ? goal.x + 5 : 0, goal ? goal.y : 0, goal ? goal.z : 0);
    bot._ai = { path: null, nextRepathTick: 0 };
    let threw = null;
    try { for (let t = 0; t < 5; t++) srv._navigate(bot, t); } catch (err) { threw = err; }
    ok('navigating on the real map does not throw', threw === null, threw && threw.message);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
