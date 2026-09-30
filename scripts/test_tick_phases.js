/**
 * test_tick_phases.js — one failing phase of the tick must not cost the others.
 *
 * WHY
 * ───
 * The tick ran its phases as bare statements. runGlobalTick's outer catch keeps the SERVER alive, but
 * a throw anywhere in the sequence abandons every LATER phase — and a deterministic throw abandons
 * them on every tick from then on. That is not theoretical: the grenade loop's fault is what took
 * firing, respawns and the whole broadcast down with it, which is why "grenades never explode" came
 * with symptoms that had nothing to do with grenades.
 *
 * The phases are independent enough that losing one is survivable and losing the rest is not:
 *   · deathRespawn throws  -> nobody ever respawns again
 *   · the broadcast throws -> the server looks frozen to everyone
 *   · the post-broadcast sweep throws -> weapon deltas and switch timers freeze for the players after
 *     the one that failed (the "holding a rifle, rendering a sword" class)
 *
 * These tests inject a REAL fault into a REAL running tick — a poisoned getter on one player's state —
 * and check that the rest of the tick still happened. A guard that is never exercised is not a guard.
 *
 * Usage:  node scripts/test_tick_phases.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = '18330';
process.env.EVIO_JOIN_DEADLINE = '0';

const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = 'ws://127.0.0.1:18330';

(async () => {
  await bpw.ready;
  srv.startServer();
  await wait(300);

  // A real client, so the tick loop runs (it starts on the first connection) and so there is a
  // recipient whose packets prove the broadcast still happened.
  const ws = new WebSocket(URL);
  await new Promise((r) => ws.on('open', r));
  ws.send(';{"uid":17,"name":"Guest1111"}');
  let packets = 0;
  ws.on('message', () => { packets++; });
  await wait(600);
  ok('the tick loop is running', packets > 5, `${packets} packets`);

  // A SECOND client. One player's state gets poisoned, and this one is the bystander whose packets
  // prove the damage was contained. With only one client the measurement is ambiguous: the poisoned
  // player legitimately gets no packet (their own body cannot be built), so "0 packets" would look
  // like a broken broadcast when it is correct behaviour.
  const other = new WebSocket(URL);
  await new Promise((r) => other.on('open', r));
  other.send(';{"uid":17,"name":"Guest2222"}');
  let otherPackets = 0;
  other.on('message', () => { otherPackets++; });
  await wait(500);
  ok('a second client is receiving state', otherPackets > 5, `${otherPackets} packets`);

  console.log('\n── a fault on one player does not starve the others ──');
  {
    // healthPoints is read by regen AND by the body builder, so a throwing getter exercises both the
    // phase guard and the per-recipient guard. That is deliberate: it is the realistic shape of a bad
    // value in one player's state, and my first attempt at this fix only wrapped the SEND, so a fault
    // while building still abandoned every player later in the map.
    // Sessions are keyed in connection order, so [0] is the first client and [1] the second. NOT
    // looked up by name: the server reassigns every guest a unique "Guest####" via allocateGuestName,
    // so the name sent in the join is not the name the session ends up with.
    const sessions = srv.getSessions();
    const live = [...sessions.values()].filter((s) => s.accepted && s.playerState);
    ok('both sessions are live', live.length >= 2, `${live.length} accepted sessions`);
    if (live.length < 2) {
      console.error('cannot continue without two sessions');
      process.exit(1);
    }
    const victim = live[0];
    const st = victim.playerState;
    const real = st.healthPoints;
    let reads = 0;
    Object.defineProperty(st, 'healthPoints', {
      configurable: true,
      get() { reads++; throw new Error('synthetic player-state fault'); },
      set() {},
    });

    const bystander = live[1];
    const beforeOther = otherPackets;
    await wait(800);   // ~16 ticks
    const during = otherPackets - beforeOther;
    ok('the fault really was exercised', reads > 0, `${reads} reads — otherwise this proves nothing`);
    ok('the healthy player keeps receiving state', during > 5,
      `${during} packets while the other player's state threw every tick — this is the whole point`);

    // Restore before anything else runs.
    delete st.healthPoints;
    st.healthPoints = real;
    await wait(300);
  }

  console.log('\n── the failure is counted and named, not swallowed ──');
  {
    // A guard that hides its own bug is worse than no guard — which is exactly what happened when the
    // entity isolation masked an out-of-scope variable and quietly deleted every grenade instead.
    const st = srv.getStatus();
    const pe = st.phaseErrors || (st.live && st.live.phaseErrors) || null;
    ok('phaseErrors is reported in the status', pe && typeof pe === 'object',
      JSON.stringify(pe));
    ok('and it names the phase that failed', pe && Object.keys(pe).length > 0,
      JSON.stringify(pe) + ' — a count with no name is a stack trace hunt');
    ok('the last error message identifies the phase',
      typeof st.lastTickError === 'string' && /:/.test(st.lastTickError),
      String(st.lastTickError));
  }

  console.log('\n── the tick itself never died ──');
  {
    // The outer catch existed before, but the phases were what needed splitting: a phase fault used to
    // present as a TICK error, which meant everything after it was lost.
    const before = otherPackets;
    await wait(500);
    ok('ticks continue after the fault is removed', otherPackets - before > 5,
      `${otherPackets - before} packets`);
    const st = srv.getStatus();
    ok('no tick-level errors were needed', (st.tickErrors || 0) === 0,
      `tickErrors=${st.tickErrors} — a fault contained per phase and per recipient must never ` +
      'escalate to the top of the tick, which would lose every phase after it');
  }

  console.log('\n── the phases that matter are wrapped ──');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    for (const name of ['grenades', 'firing', 'regen', 'deathRespawn', 'match']) {
      ok(`${name} runs inside _phase`, new RegExp(`_phase\\("${name}"`).test(src));
    }
    ok('the post-broadcast sweep is isolated per player',
      /post-broadcast sweep failed for/.test(src),
      'it advances the weapon markers — a partial sweep freezes them for the rest');
    // The layer that actually saved the bystander above. Per-RECIPIENT isolation is not enough,
    // because every recipient's body contains every peer: one unserialisable player broke the body
    // being built for everyone.
    ok('each peer entry is isolated inside the body build',
      /PEER ENTRY FAILED/.test(src),
      'one bad player must not empty the lobby');
    // This used to check for a specific ROLLBACK pattern (write into `body`, remember the mark,
    // splice back out on failure). The per-tick player-block cache replaced that with a STRONGER
    // guarantee: a peer's entry is built into an isolated scratch array first (_cachedPlayerBlock),
    // and only ever copied into a recipient's `body` if that build succeeded — so a failing peer
    // never touches `body` at all, and there is nothing to roll back. Checking for the old regex
    // literally would fail against the improved implementation while the property it existed to
    // protect — no half-written 244 block ever reaches a client — holds even more strongly now,
    // which test_peer_block_cache.js verifies behaviourally (a poisoned peer is provably absent
    // from every other recipient's body, not just rolled back after a partial write).
    // Widened from 200 to 600 chars between the two anchors: this is a source-DISTANCE check, not a
    // behavioral one, and it has already broken once before (see the comment above) when unrelated
    // code was added in between — most recently the peer-broadcast-position shallow-override logic
    // (updateBroadcastPosition's "variant" handling). The property under test — scratch built in
    // isolation, only copied into `entry` on success — doesn't care how much explanatory comment or
    // logic sits between the two lines, only that scratch is never touched by `body` on failure,
    // which test_peer_block_cache.js verifies behaviourally regardless of source layout.
    // Was a raw character-DISTANCE check ({0,N} between the two anchors) — already broken twice
    // before (200->600 chars) purely from unrelated code being inserted between them (most recently
    // the send-on-change stats bookkeeping, _updateStatsSendWindow). Scoped to the actual function
    // body instead: distance within _cachedPlayerBlock no longer matters, only that both anchors
    // exist somewhere inside it, so this stops breaking every time the function gains a line.
    const cachedBlockFn = src.match(/function _cachedPlayerBlock\([\s\S]*?\n\}/);
    ok('_cachedPlayerBlock exists', !!cachedBlockFn);
    ok('a failed peer entry never writes anything into the recipient body (scratch-then-copy)',
      !!cachedBlockFn && /const scratch = \[\];/.test(cachedBlockFn[0])
        && /entry = \{ tick, ok: false/.test(cachedBlockFn[0]),
      'a half-written entry would stall the client\'s single ascending scan and drop every later field');
  }

  console.log('\n── accumulators cannot grow without bound ──');
  {
    // Each is cleared once per tick AFTER the broadcast. That is fine until the broadcast stops
    // happening, which is exactly when an uncapped array becomes a leak.
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    ok('_pendingBullets is capped', /_pendingBullets\.length > \d+/.test(src));
    ok('_pendingHitEvents is capped', /_pendingHitEvents\.length > \d+/.test(src));
    ok('_pendingMedals is capped', /_pendingMedals\.length > \d+/.test(src),
      'it was the only one of the three without a cap');
  }

  console.log('\n── a bootstrap backlog escalates instead of truncating ──');
  {
    // pendingPeerBootstraps is a FLAT opcode stream. Truncating it lands mid-player-entry, and the
    // client decodes with one ascending forward scan — a partial entry stalls the cursor and silently
    // drops everything after it. Escalating to a full bootstrap is self-contained and correct.
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    ok('there is a cap', /MAX_PENDING_BOOTSTRAP_OPS/.test(src));
    ok('overflow sets pendingFullBootstrap',
      /pendingPeerBootstraps\.length > MAX_PENDING_BOOTSTRAP_OPS[\s\S]{0,400}pendingFullBootstrap = true/.test(src));
    ok('and does NOT splice the opcode stream',
      !/pendingPeerBootstraps\.splice/.test(src),
      'a partial player entry stalls the client decoder silently');
  }

  try { ws.close(); } catch (_) {}
  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
