/**
 * test_input_hardening.js — client-supplied data must not be able to cost the server unbounded work.
 *
 * The game port faces the internet and every field below is chosen by the client. None of this is
 * about cheating; it is about one connection being able to stall the tick loop for EVERYONE, which is
 * the failure mode that looks like "the server is lagging" with nothing obviously wrong in the logs.
 *
 * WHAT WAS ACTUALLY WRONG (measured, not theorised)
 * ────────────────────────────────────────────────
 *  · A 60,000-element `held` array in one sub-frame cost 11ms of map+filter inside the tick loop.
 *    At the permitted message rate that is more CPU than the server has. maxPayload bounds the
 *    MESSAGE, but 64 KiB of small msgpack integers is still tens of thousands of elements.
 *  · MAX_SUBFRAMES_PER_TICK was only applied when MERGING into an existing batch and when prepending
 *    the carry — the first packet for a tick could queue any number. 5,000 were accepted, and every
 *    one gets folded on the drain.
 *  · The action list has FOUR independent readers (foldInputFrameIntoSim, heldThisTick, the physics
 *    merge, firingAlphaFromFrames). Capping one left the others iterating everything — the first fix
 *    only took the cost from 56x normal to 56x normal, because the expensive reader was elsewhere.
 *  · Cosmetic URLs and the client ray's `sid` are echoed to every peer, so an unbounded one arrives
 *    once and goes out N times.
 *
 * Usage:  node scripts/test_input_hardening.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';

const srv = require('../local_ws_server');
const bpw = require('../physics_world');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

const mkFrame = (held, look = [0, 0], pressed = [], released = []) =>
  [0, [held, pressed, released, look]];
const mkSession = (st) => ({
  sessionId: 'h1', playerId: 'h1', accepted: true, inputQueue: [], playerState: st,
  lastClientTick: 0, lastProcessedClientTick: -1, _idleTicks: 0, _lastInputMs: Date.now(),
});

// Median per-tick cost of driving the real ingest+drain path with a given held array.
function costPerTick(held, ticks = 200) {
  const st = srv.createPlayerSimState();
  const s = mkSession(st);
  for (let i = 1; i <= 30; i++) {          // warm the JIT before measuring
    srv.enqueueClientInput(s, [0, 0, 0, 0, i, [mkFrame(held)]]);
    srv.processBufferedTick(s, i, new Map());
  }
  const t0 = process.hrtime.bigint();
  for (let i = 31; i <= 30 + ticks; i++) {
    srv.enqueueClientInput(s, [0, 0, 0, 0, i, [mkFrame(held)]]);
    srv.processBufferedTick(s, i, new Map());
  }
  return Number(process.hrtime.bigint() - t0) / 1e6 / ticks;
}

(async () => {
  await bpw.ready;

  console.log('\n── an oversized action list is not iterated ──');
  {
    const st = srv.createPlayerSimState();
    const s = mkSession(st);
    // 40 DISTINCT ids so the Set cannot hide the truncation behind de-duplication.
    const many = Array.from({ length: 40 }, (_, i) => i);
    srv.enqueueClientInput(s, [0, 0, 0, 0, 1, [mkFrame(many)]]);
    srv.processBufferedTick(s, 1, new Map());
    ok('the held set is capped', st.heldActions.size <= 32,
      `${st.heldActions.size} actions — there are about a dozen real ones`);
    ok('the ids kept are the low ones', st.heldActions.has(0) && !st.heldActions.has(39),
      'slicing from the front keeps the real action range');
  }

  console.log('\n── and the cost does not scale with the hostile length ──');
  {
    // The property that matters is CPU, so measure it. The bound is deliberately loose (10x) because
    // this runs on whatever machine happens to be free; before the fix it was 56x, so the signal is
    // far larger than the noise.
    const normal = costPerTick([3]);
    const hostile = costPerTick(new Array(60000).fill(3));
    const ratio = hostile / normal;
    // 20x, not 10x: at 10x this flaked on a busy machine (measured 10.1x) while the regression it
    // exists to catch was 56x. A threshold that close to the noise floor reports a problem that is not
    // there, which costs more than the resolution it buys.
    ok('a 60k-element action list costs about the same as a real one', ratio < 20,
      `${normal.toFixed(4)}ms normal vs ${hostile.toFixed(4)}ms hostile = ${ratio.toFixed(1)}x`
      + ' (was 56x — one reader was left uncapped)');
    ok('a normal tick is still fast', normal < 2,
      `${normal.toFixed(4)}ms — the whole tick budget is 50ms for every player`);
  }

  console.log('\n── every reader of the action list is capped, not just one ──');
  {
    // Regression guard for the actual mistake made here: the cap was added to
    // foldInputFrameIntoSim and the benchmark did not move, because heldThisTick and the physics
    // merge were reading the raw array. A grep is the honest test — the cost is only visible when
    // ALL of them are bounded, so any single omission reopens it.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    const raw = [];
    const lines = src.split(/\r?\n/);
    lines.forEach((raw0, i) => {
      if (/^\s*(\/\/|\*)/.test(raw0)) return;                    // comments describe the pattern
      const l = raw0.replace(/\/\/.*$/, '');                     // and so do TRAILING ones
      // A loop or scan over packed[0..2] / f[1][0] that does not go through the bounding helper.
      if (/(packed\[[012]\]|f\[1\]\[0\]|frame\[1\]\[[012]\])/.test(l) && !/_boundedActions/.test(l)
          && /(for \(|indexOf|\.map\(|\.forEach|new Set\()/.test(l)) {
        raw.push(`${i + 1}: ${l.trim().slice(0, 90)}`);
      }
    });
    ok('no reader iterates a raw client action array', raw.length === 0, raw.join(' | '));
  }

  console.log('\n── sub-frames are capped at INGEST, not only on merge ──');
  {
    const st = srv.createPlayerSimState();
    const s = mkSession(st);
    const frames = Array.from({ length: 5000 }, () => mkFrame([], [0.001, 0]));
    srv.enqueueClientInput(s, [0, 0, 0, 0, 7, frames]);
    const queued = s.inputQueue[s.inputQueue.length - 1].frames.length;
    ok('the first packet for a tick is capped too', queued <= 64,
      `${queued} sub-frames queued — the client legitimately sends about three`);

    // The NEWEST must be kept: they are the freshest input, and dropping them instead would throw
    // away the most recent aim.
    const st2 = srv.createPlayerSimState();
    const s2 = mkSession(st2);
    const tagged = Array.from({ length: 200 }, (_, i) => mkFrame([], [i, 0]));
    srv.enqueueClientInput(s2, [0, 0, 0, 0, 8, tagged]);
    const kept = s2.inputQueue[s2.inputQueue.length - 1].frames;
    ok('the newest sub-frames are the ones kept', kept[kept.length - 1][1][3][0] === 199,
      `last look delta ${kept[kept.length - 1][1][3][0]} (expected 199)`);
  }

  console.log('\n── the look delta cannot poison the sim ──');
  {
    // A NaN in the local player's position permanently bricks the client (every NaN comparison is
    // false, so the divergence comparator reports a MATCH for ever and nothing self-heals).
    for (const bad of [[Infinity, 0], [-Infinity, 0], [NaN, NaN], [1e308, 1e308], ['x', {}]]) {
      const st = srv.createPlayerSimState();
      const s = mkSession(st);
      for (let i = 1; i <= 8; i++) {
        srv.enqueueClientInput(s, [0, 0, 0, 0, i, [mkFrame([], bad)]]);
        srv.processBufferedTick(s, i, new Map());
      }
      const finite = Number.isFinite(st.position.x) && Number.isFinite(st.position.y)
        && Number.isFinite(st.position.z) && Number.isFinite(st.pitch);
      ok(`lookDelta ${JSON.stringify(bad)} leaves the sim finite`, finite,
        `pos=(${st.position.x},${st.position.y},${st.position.z}) pitch=${st.pitch}`);
    }
  }

  console.log('\n── rebroadcast strings are bounded ──');
  {
    // These arrive once and go out to every peer, so an unbounded one is amplification.
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    ok('cosmetic URLs go through a bounding helper',
      (src.match(/_boundedUrl\(/g) || []).length >= 4,
      'skinUrl (join + live update), thumbUrl, clanImgUrl');
    ok('the client ray sid is length-capped', /String\(tok\[6\]\)\.slice\(0, ?64\)/.test(src),
      'it is echoed back as a playerMap key');
    // The ability seed goes through a shared sanitiser whose cap is DERIVED from the ability id table.
    // It was briefly a literal 16 here, which silently dropped ability id 16 (the impulse grenade) —
    // see test:abilityseed for that regression in full. A hand-written bound is the bug, so this
    // asserts the helper is used rather than asserting any particular number.
    ok('the ability seed goes through the shared sanitiser',
      /_sanitizeAbilitySeed\(join\.abilitySeed\)/.test(src)
      && /MAX_ABILITY_SEED_LEN = Math\.max\(/.test(src),
      'it is retained on the session and copied onto the physics state');
  }

  console.log('\n── a URL that cannot be used is dropped, not truncated ──');
  {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    ok('only http(s) or site-relative URLs are accepted',
      /\^\(https\?:\\\/\\\/\|\\\/\)/.test(src),
      'a peer should not get to choose the scheme of a URL other browsers will load');
    ok('over-long URLs are rejected rather than cut', /s\.length > MAX_URL_LEN\) return null/.test(src),
      'half a URL is not better than none');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
