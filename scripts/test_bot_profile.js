/**
 * test_bot_profile.js — bot identity (name/skin/thumb), loadout, and the sprint/jump behaviour
 * that loadout is meant to make worthwhile.
 *
 * BACKGROUND
 * ──────────
 * A bot used to be named "Bot <word>" with the account default skin — i.e. distinguishable from a
 * real player only by its NAME. Official ev.io does the opposite: bots carry a distinct SKIN
 * (captured from a live official session — work/headless-runs/2026-05-25T02-13-12-372Z/
 * events.json:753-754 — a real '~2' prop push for bot entity id 9900000: skin bot_2.evskin, avatar
 * botred110x110.png), and the name is unremarkable. This file asserts the same here: no "Bot "
 * prefix, and the real captured skin/thumbnail pair actually reaches the prop roster.
 *
 * It also asserts the loadout that backs the "bots sprint and jump" behavior is a REAL stat change
 * (via the same computeWeaponStats path a human's loadout goes through), not just a flag that
 * nothing reads, and that the strafe-jump-while-shooting behavior is gated on botLevel >= 5 as
 * specified — a level 1-4 bot should never add sprint/jump to its combat movement.
 *
 * Usage:  node scripts/test_bot_profile.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = process.env.EVIO_LOCAL_PORT || '18520';
process.env.EVIO_JOIN_DEADLINE = '0';
// A held real player ("Hold new players until they click to play", now the default) is not a
// valid combat target, which would mask the bot-vs-player combat behavior this file tests.
process.env.EVIO_CLICK_TO_PLAY = process.env.EVIO_CLICK_TO_PLAY || '0';

const WebSocket = require('ws');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const botDifficulty = require('../bot_difficulty');
const S = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await bpw.ready;
  srv.startServer();
  await wait(200);

  console.log('\n── identity: no "Bot " name prefix, but a real distinct skin + avatar ──');
  {
    const bot = srv.spawnBot({});
    ok('the display name has no "Bot " prefix', !/^Bot\s/.test(bot.displayName), bot.displayName);
    ok('the display name is still a real, non-empty word', typeof bot.displayName === 'string' && bot.displayName.length > 0);
    ok('the skin is the REAL captured official bot skin, not the account default',
      bot.skinUrl === 'https://ev.io/sites/default/files/skins/bot_2.evskin', String(bot.skinUrl));
    ok('the avatar is the REAL captured official bot thumbnail',
      bot.thumbUrl === 'https://ev.io/sites/default/files/skin_profile_thumbs/botred110x110.png',
      String(bot.thumbUrl));
    ok('NOT the infection-mode zombie-bot skin (a different, wrong asset for deathmatch)',
      !/zombiebot/.test(bot.skinUrl));
    srv.removeBot(bot.playerId);
  }

  console.log('\n── a real connected client actually receives the bot\'s skin via the prop roster ──');
  {
    // test_bot_session.js established that a skin-less bot correctly produces NO roster message
    // (nothing to send). Now that a bot has a real skin, the opposite must be true: a connected
    // client must actually receive it — the whole point of setting skinUrl/thumbUrl on the session.
    const ws = new WebSocket(`ws://127.0.0.1:${process.env.EVIO_LOCAL_PORT}`);
    await new Promise((r) => ws.on('open', r));
    let rosterMsg = null;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) {
        const text = data.toString();
        if (text.startsWith('~3`') && !rosterMsg) rosterMsg = text;
      }
    });
    ws.send(';' + JSON.stringify({ uid: 17, name: 'SkinWatcher' }));
    await wait(300);
    const bot = srv.spawnBot({});
    await wait(400);
    ok('a prop-roster message was actually sent once the bot has a real skin', !!rosterMsg);
    if (rosterMsg) {
      ok('it carries the bot\'s exact skin URL', rosterMsg.includes('bot_2.evskin'), rosterMsg.slice(0, 200));
      ok('and the bot\'s exact avatar thumbnail URL', rosterMsg.includes('botred110x110.png'));
      ok('keyed by the bot\'s own session/player id', rosterMsg.includes(bot.playerId));
    }
    srv.removeBot(bot.playerId);
    try { ws.close(); } catch (_) {}
    await wait(200);
  }

  console.log('\n── the loadout is a REAL stat change, applied the same way a human loadout is ──');
  {
    const bot = srv.spawnBot({});
    const stats = bot.playerState._ps && bot.playerState._ps.Qz8l93a;
    ok('the bot has computed weaponStats', !!stats);
    if (stats) {
      // Base jump power is 0.6 / base max jumps is 1 (see ability_stats.js baseWeaponStats) —
      // BOT_ABILITY_SEED grants Jump level 2, which must move both.
      ok('jump power is above the base 0.6 (Jump ability actually applied)', stats.Qfh4lso > 0.6,
        String(stats.Qfh4lso));
      ok('max air jumps is above the base 1 (double jump granted)', stats.Q7v2lyo > 1,
        String(stats.Q7v2lyo));
      // Base sprint cap is 0.7 — Sprint level 2 must raise it.
      ok('sprint speed cap is above the base 0.7 (Sprint ability actually applied)', stats.Q8i9f3s > 0.7,
        String(stats.Q8i9f3s));
    }
    ok('the session carries the same abilitySeed a real loadout delta would reference',
      Array.isArray(bot.abilitySeed) && bot.abilitySeed[1] === 2 && bot.abilitySeed[2] === 2,
      JSON.stringify(bot.abilitySeed));
    srv.removeBot(bot.playerId);
  }

  console.log('\n── patrol: a bot that is moving sprints and occasionally jumps ──');
  {
    const bot = srv.spawnBot({});
    bot._ai = { path: null, nextRepathTick: 0 };
    // Face and stand exactly on a real navmesh node's position so _navigate immediately commits to
    // walking toward the NEXT one without a turn-in-progress frame confusing "moving" detection.
    const graph = srv._botNavGraph();
    let sawForward = false, sawSprint = false, sawJumpPress = false;
    for (let t = 0; t < 400 && !(sawForward && sawSprint && sawJumpPress); t++) {
      const nav = srv._navigate(bot, t);
      if (nav.held.includes(0)) sawForward = true;
      if (nav.held.includes(7)) sawSprint = true;
      // Jump (4) lives in the wire's `pressed` slot — see _navigate's header comment (the extracted
      // physics's entire jump gate is built from this array, not from held-key diffing).
      if (nav.pressed.includes(4)) sawJumpPress = true;
      // Cheap movement stand-in so the bot actually gets somewhere instead of endlessly "arriving"
      // at the same spot (same technique as test_bot_ai.js's navigation test).
      if (nav.held.includes(0)) {
        bot.playerState.position.x += -Math.sin(bot.playerState.yaw) * 0.5;
        bot.playerState.position.z += -Math.cos(bot.playerState.yaw) * 0.5;
      }
      bot.playerState.yaw += nav.lookDelta[0];
    }
    ok('the bot walks forward while patrolling', sawForward);
    ok('sprint (key 7) accompanies forward movement, not just walking', sawSprint);
    ok('a jump (pressed key 4) occurs at least once over 400 ticks (~20s) of movement', sawJumpPress);
    srv.removeBot(bot.playerId);
  }

  console.log('\n── combat: level 5+ strafe-jumps while shooting; level < 5 never does ──');
  {
    // driveBotFrame itself is not exported (only the pieces it composes are, by design — see the
    // module export comment), so this drives the REAL running server with two REAL bots on REAL
    // ground — jump requires being grounded, so unlike the earlier open-air LOS tricks used
    // elsewhere, these must stand on the actual collision floor for a jump to ever be possible at
    // all.
    //
    // NOT pinning Math.random to a constant here, on purpose, after an earlier version of this test
    // did exactly that and broke in a subtle way: pinning it to 0 makes COMBAT_JUMP_CHANCE's check
    // true on EVERY tick, so jump (key 4) enters heldActions on tick 0 and then NEVER LEAVES —
    // meaning the extracted-physics engine's press-edge detection (which fires only on a transition
    // INTO the held set, not on "still held") sees exactly one edge at the very start and none after,
    // even though the gate itself was working correctly. Real randomness — jump chance rolled fresh
    // and independently EVERY tick — reproduces the actual one-tick pulses this needs; the level gate
    // is checked deterministically instead (level 1 must NEVER jump, however long this runs).
    const spawn = bpw.spawnPoints[0];
    // Probe outward for a direction with genuinely clear LOS rather than assuming one — a prior
    // manual check found spawn[0] has a wall 1.4u away in +x specifically (one-sided collision face:
    // blocks that direction, passes the other), so this cannot be hardcoded as "always +x".
    const phys = require('../physics_extracted');
    const eyeY = 1.6;
    let offset = null;
    for (const [dx, dz] of [[6, 0], [-6, 0], [0, 6], [0, -6], [4, 4], [-4, 4], [4, -4], [-4, -4]]) {
      const dist = Math.hypot(dx, dz);
      const hit = phys.raycastWorld(bpw.world, spawn.x, spawn.y + eyeY, spawn.z, dx, 0, dz, dist);
      if (!hit) { offset = [dx, dz]; break; }
    }
    ok('found a direction with clear LOS from this spawn to build the test on', !!offset,
      'every probed direction was wall-blocked — cannot construct a fair check');

    async function jumpedWhileFighting(level) {
      const a = srv.spawnBot({ name: 'Mover', level });
      const b = srv.spawnBot({ name: 'Target', level: 1 });
      const [dx, dz] = offset || [6, 0];
      for (const [s, ox, oz] of [[a, 0, 0], [b, dx, dz]]) {
        s.playerState._ps.Qdsukt4.x = spawn.x + ox; s.playerState._ps.Qdsukt4.y = spawn.y; s.playerState._ps.Qdsukt4.z = spawn.z + oz;
        s.playerState.position.x = spawn.x + ox; s.playerState.position.y = spawn.y; s.playerState.position.z = spawn.z + oz;
        s.playerState.velocity.x = 0; s.playerState.velocity.y = 0; s.playerState.velocity.z = 0;
      }
      // Pin strafeDir directly rather than relying on curve.strafeProbability's own dice roll to
      // land on "strafing" within the window — that roll is a SEPARATE thing this file already
      // isn't trying to test, and at level 1's strafeProbability (0.15) a run genuinely has a
      // ~20% chance of never once rolling "strafe" in this many re-rolls, which was caught making
      // this exact check flaky. strafeUntilTick pinned far in the future stops driveBotFrame's own
      // periodic re-roll from ever overwriting it. COMBAT_JUMP_CHANCE itself is left to real
      // randomness — that IS what this test verifies — but over ~300 ticks the chance of a level-9
      // bot never once rolling under 4% is astronomically small (0.96^300 ≈ 3e-6).
      a._ai = { targetId: null, targetLockTicks: 0, lastSeenTick: 0, acquiredTick: 0,
        aimNoiseYaw: 0, aimNoisePitch: 0, strafeDir: -1, strafeUntilTick: 1e9 };
      let sawStrafe = false, sawUpwardVelocitySpike = false;
      // Qfh4lso (jump power, 0.77 with the bot's loadout) is stored in u/TICK, not u/s, in this
      // engine — confirmed empirically: velocity.y peaks at ~0.70-0.71 immediately after a real
      // jump fires (matching Qfh4lso closely, the small gap being the `x(n,v)` scale factor inside
      // the extracted physics's jump line), NOT ~15 as a u/s reading of the same number would
      // suggest. An earlier version of this test assumed u/s, set the threshold to 5, and every
      // jump that ACTUALLY fired failed the check purely because of that wrong unit assumption.
      const JUMP_VELOCITY_THRESHOLD = 0.3;   // resting/settling bob stays near 0; a real jump is ~0.7
      // ~300 real server ticks (20Hz): strafeProbability re-rolls every 20-40 ticks and
      // COMBAT_JUMP_CHANCE is checked every grounded+strafing tick, so this window comfortably
      // covers many independent rolls of both — not tuned to just barely pass.
      for (let t = 0; t < 300; t++) {
        await wait(20);
        if (a._ai && a._ai.strafeDir !== 0) sawStrafe = true;
        if (a.playerState.velocity.y > JUMP_VELOCITY_THRESHOLD) sawUpwardVelocitySpike = true;
      }
      srv.removeBot(a.playerId);
      srv.removeBot(b.playerId);
      return { sawStrafe, sawUpwardVelocitySpike };
    }

    // Damage OFF for this check: the target dying and respawning to a random far-away spawn point
    // mid-run would end the "fighting" window early and leave nothing left to observe for whatever
    // ticks remained. This test is about MOVEMENT while engaged, not combat outcome, so removing
    // damage keeps the target alive and in range for the whole window without changing what is
    // actually being measured (strafing + the level-gated jump).
    const prevDamageScale = S.get('damageScale');
    S.set('damageScale', 0, 'test');
    let low, high;
    try {
      low = await jumpedWhileFighting(1);
      high = await jumpedWhileFighting(9);
    } finally {
      S.set('damageScale', prevDamageScale, 'test');
    }
    ok('both levels actually strafed during the check (precondition for the gate to be meaningful)',
      low.sawStrafe && high.sawStrafe, JSON.stringify({ low, high }));
    ok('a level 1 bot NEVER strafe-jumps while fighting, over the whole window',
      low.sawUpwardVelocitySpike === false, JSON.stringify(low));
    ok('a level 9 bot DOES strafe-jump while fighting, given the same real odds over the same window',
      high.sawUpwardVelocitySpike === true, JSON.stringify(high));
  }

  console.log('\n── source check: the level gate is exactly >= 5, matching the request ──');
  {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    ok('the combat sprint/jump block is gated on curve.level >= 5',
      /curve\.level >= 5 && ai\.strafeDir/.test(src));
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
