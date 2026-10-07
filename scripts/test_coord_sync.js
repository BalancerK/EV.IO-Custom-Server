/**
 * test_coord_sync.js
 *
 * End-to-end WebSocket test: connects two clients to the local server and
 * verifies that Player B sees Player A moving at the CORRECT sprint speed —
 * not the 3× over-speed that existed before the 1-step-collapse fix.
 *
 * WHY THIS TEST EXISTS
 * ────────────────────
 * The 3× speed bug was invisible to Player A (their own prediction was fine)
 * but obvious to Player B watching from outside.  Unit tests on physics rate
 * don't catch network encoding bugs or dispatch bugs that only manifest when
 * positions are relayed through the broadcast path.
 *
 * HOW IT WORKS
 * ────────────
 * 1. Start the server in-process (TICK_MS=100 for reliable test timing)
 * 2. Connect Player A → sends W+Sprint input each tick
 * 3. Connect Player B → records Player A's position from every broadcast tick
 * 4. After SPRINT_TICKS of movement, compute per-tick displacement and average
 *    speed as seen by B.
 *
 * Assertions:
 *   ✓  Server broadcasts Player A's position to Player B (integration check)
 *   ✓  Per-tick displacement is 0.0–2.0 units (no teleports)
 *   ✓  Average speed after ramp-up is in [0.20, 0.80] units/tick (sprint range)
 *   ✓  No tick shows displacement > 2× the previous tick's (no double-step spikes)
 *
 * Expected displacement profile:
 *   Ticks 1-5:  acceleration ramp  (0–0.55 u/tick)
 *   Ticks 6+:   steady sprint      (~0.54 u/tick)
 *   Average over ticks 5-15: ~0.50–0.60 u/tick
 *
 * Usage:
 *   node scripts/test_coord_sync.js
 */
'use strict';

process.env.EVIO_LOCAL_HOST  = process.env.EVIO_LOCAL_HOST  || '127.0.0.1';
process.env.EVIO_LOCAL_PORT  = process.env.EVIO_LOCAL_PORT  || '18091';
process.env.EVIO_TICK_MS     = process.env.EVIO_TICK_MS     || '100';
process.env.EVIO_COORD_LOG   = '0';  // suppress coord log noise in this test
// This test measures tick-to-tick position deltas from a player's very first input, so it isn't
// written to expect the one-time spectator -> spawn teleport "Hold new players until they click
// to play" (now the default) inserts the moment a held player's first input exits the hold — a
// real, correct, one-time discontinuity (see handleLobbyIntent's play branch / the fallback at
// "LOBBY_INTENT_FALLBACK"), not a sync bug, but exactly the kind of jump this test exists to catch
// for everything else. Disabled here so it keeps testing what it was built to test.
process.env.EVIO_CLICK_TO_PLAY = process.env.EVIO_CLICK_TO_PLAY || '0';

const WebSocket   = require('ws');
const { encode, decode } = require('@msgpack/msgpack');
const { startServer } = require('../local_ws_server');

const HOST     = process.env.EVIO_LOCAL_HOST;
const PORT     = Number(process.env.EVIO_LOCAL_PORT);
const URL      = `ws://${HOST}:${PORT}`;
const TICK_MS  = Number(process.env.EVIO_TICK_MS);

// How many sprint ticks to collect before evaluating
const SPRINT_TICKS = 15;
// How many ticks to let the player settle/accelerate before measuring speed
const RAMP_TICKS = 4;

// ── Packet helpers ───────────────────────────────────────────────────────────

/**
 * Build a msgpack-encoded input packet with forward+sprint keys held.
 * Format: [prevServerTick, 0, currentServerTick, 0, clientTick, frames]
 * Frame:  [1.0, [heldKeys, pressedKeys, [], [0,0], null, null]]
 */
function buildSprintInput(prevTick, serverTick, clientTick) {
  const frame = [1.0, [[0, 7], [], [], [0, 0], null, null]];  // 0=fwd, 7=sprint
  return encode([prevTick, 0, serverTick, 0, clientTick, [frame]]);
}

/**
 * Scan the flat opcode body for the 244-block belonging to playerId, then
 * extract the [x, y, z] from the first opcode-136 vector within that block.
 * Returns null if not found.
 *
 * Body layout (from appendPlayerTickBody):
 *   ..., 244, playerId, 90, playerId, 91, 1, 136, 0, x, y, z, ...
 */
function extractPlayerPosition(body, playerId) {
  for (let i = 0; i < body.length - 1; i++) {
    if (body[i] === 244 && body[i + 1] === playerId) {
      // Scan forward within this entity block for opcode 136
      for (let j = i + 2; j < body.length - 4; j++) {
        // Stop when we hit the next entity block or end marker
        if (body[j] === 244 || body[j] === 280) break;
        if (body[j] === 136) {
          // body[j+1] = 0 (subOpcode), body[j+2]=x, body[j+3]=y, body[j+4]=z
          return { x: body[j + 2], y: body[j + 3], z: body[j + 4] };
        }
      }
    }
  }
  return null;
}

// ── Test runner ──────────────────────────────────────────────────────────────

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else       { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

async function runTest() {
  const wss = startServer();
  await new Promise(r => wss.on('listening', r));
  console.log(`[coord-sync] server listening on ${URL} (TICK_MS=${TICK_MS})`);

  // ── Connect Player A ──────────────────────────────────────────────────────
  let playerAId = null;
  let aServerTick = 0;
  let aClientTick = 0;
  let aPrevTick = 0;

  const wsA = new WebSocket(URL);
  const aReady = new Promise((resolve, reject) => {
    wsA.on('error', reject);
    wsA.on('message', (data, isBinary) => {
      if (!isBinary) {
        const text = data.toString('utf8');
        if (text.startsWith('ID')) {
          // Server sends "ID" + sessionId (no space)
          playerAId = text.slice(2).trim();
          // Send join
          wsA.send(`;${JSON.stringify({
            uid: 'coord-sync-a',
            displayName: 'CoordSyncA',
            token: 'test',
          })}`);
        } else if (text === ';1') {
          resolve();
        }
        return;
      }
      // Binary: extract server tick from opcode 1
      const pkt = decode(new Uint8Array(data));
      const body = Array.isArray(pkt[2]) ? pkt[2] : [];
      const tickIdx = body.indexOf(1);
      if (tickIdx !== -1) aServerTick = body[tickIdx + 1];
    });
  });
  await aReady;
  console.log(`[coord-sync] Player A accepted, id=${playerAId}`);

  // ── Connect Player B ──────────────────────────────────────────────────────
  const posHistory = [];    // [{x,z,tick}] as seen by B for Player A
  let bReady = false;
  let bServerTick = 0;

  const wsB = new WebSocket(URL);
  const bAccepted = new Promise((resolve, reject) => {
    wsB.on('error', reject);
    wsB.on('message', (data, isBinary) => {
      if (!isBinary) {
        const text = data.toString('utf8');
        if (text.startsWith('ID')) {
          wsB.send(`;${JSON.stringify({
            uid: 'coord-sync-b',
            displayName: 'CoordSyncB',
            token: 'test',
          })}`);
        } else if (text === ';1') {
          bReady = true;
          resolve();
        }
        return;
      }
      if (!bReady) return;
      // Binary: record Player A's position from each broadcast
      const pkt = decode(new Uint8Array(data));
      const body = Array.isArray(pkt[2]) ? pkt[2] : [];
      const tickIdx = body.indexOf(1);
      if (tickIdx !== -1) bServerTick = body[tickIdx + 1];

      const pos = extractPlayerPosition(body, playerAId);
      if (pos) {
        posHistory.push({ x: pos.x, z: pos.z, tick: bServerTick });
      }
    });
  });
  await bAccepted;
  console.log(`[coord-sync] Player B accepted`);

  // ── Player A sends W+Sprint input for SPRINT_TICKS ticks ─────────────────
  console.log(`\n[coord-sync] Player A sending W+Sprint for ${SPRINT_TICKS} ticks…`);
  for (let i = 0; i < SPRINT_TICKS; i++) {
    aClientTick++;
    wsA.send(buildSprintInput(aPrevTick, aServerTick, aClientTick));
    aPrevTick = aServerTick;
    await new Promise(r => setTimeout(r, TICK_MS));
  }

  // Give one extra tick for the final broadcast to arrive at B
  await new Promise(r => setTimeout(r, TICK_MS * 2));

  // ── Analysis ───────────────────────────────────────────────────────────────
  console.log(`\n[coord-sync] Player B recorded ${posHistory.length} position samples`);
  if (posHistory.length >= 2) {
    console.log('\n  Tick   x        z        dxz (units/tick)');
    const displacements = [];
    for (let i = 1; i < posHistory.length; i++) {
      const prev = posHistory[i - 1];
      const curr = posHistory[i];
      const dxz = Math.hypot(curr.x - prev.x, curr.z - prev.z);
      displacements.push(dxz);
      const mark = (dxz > 2.0) ? ' ← TELEPORT!' : (dxz > 0.9) ? ' ← TOO FAST' : '';
      console.log(`  ${String(curr.tick).padEnd(5)}  ${curr.x.toFixed(3).padEnd(8)} ${curr.z.toFixed(3).padEnd(8)} ${dxz.toFixed(4)}${mark}`);
    }

    // Skip the first RAMP_TICKS displacements (acceleration phase)
    const steadyDisps = displacements.slice(RAMP_TICKS);
    const avgSpeed = steadyDisps.length > 0
      ? steadyDisps.reduce((a, b) => a + b, 0) / steadyDisps.length
      : 0;
    const maxDisp = Math.max(...displacements);
    const hasTeleport = displacements.some(d => d > 2.0);
    // The ratio check alone false-positives on peer extrapolation (see updateBroadcastPosition):
    // a brief real starved tick now takes a small legitimate step (velocity * that tick's dt)
    // instead of freezing at exactly 0, and the very next NORMAL-sized step then reads as a huge
    // ratio purely because the tick before it was small, not because anything actually spiked. The
    // real 3x-speed bug this test exists to catch produces an ABSOLUTE jump (~1.5-1.8u, matching
    // the "TOO FAST" mark above at 0.9u) — require that too, not just a ratio, so a legitimate small
    // extrapolation step followed by a normal-sized step never trips this on its own.
    const hasDoubleStep = displacements.some((d, i) => {
      if (i === 0) return false;
      return displacements[i - 1] > 0.01 && d > displacements[i - 1] * 2.5 && d > 0.9;
    });

    console.log(`\n  Average speed (ticks ${RAMP_TICKS + 1}+): ${avgSpeed.toFixed(4)} units/tick`);
    console.log(`  Max displacement in any tick: ${maxDisp.toFixed(4)}`);

    console.log('\n── Assertions ──');
    ok('Player B received ≥ 5 position samples for Player A',
      posHistory.length >= 5,
      `got ${posHistory.length}`);
    ok('No tick shows teleport-level jump (> 2.0 units)',
      !hasTeleport,
      `max=${maxDisp.toFixed(4)}`);
    ok('No double-step spike (no tick > 2.5× previous tick)',
      !hasDoubleStep,
      'a spike would indicate the 3× speed bug is back');
    ok(`Average sprint speed in [0.20, 0.80] units/tick (expected ~0.50–0.54)`,
      avgSpeed >= 0.20 && avgSpeed <= 0.80,
      `avg=${avgSpeed.toFixed(4)}`);
  } else {
    ok('Player B received ≥ 5 position samples for Player A',
      false,
      `only got ${posHistory.length} — Player A ID "${playerAId}" may not have appeared in B's broadcasts`);
  }

  // ── Cleanup ────────────────────────────────────────────────────────────────
  wsA.close();
  wsB.close();
  await new Promise(r => wss.close(r));

  console.log(`\n${'─'.repeat(60)}`);
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail > 0 ? 1 : 0);
}

runTest().catch(err => {
  console.error('[coord-sync] fatal error:', err);
  process.exit(1);
});
