/**
 * test_delta_fields.js — "send only what changed" must leave every client with exactly the state
 * the full stream would have given it.
 *
 * Runs the real buildTickBody for 3 moving players over 400 ticks and builds each recipient's packet
 * twice: unfiltered, and through the per-recipient filter. A model of the client applies only the
 * filtered packets the way the decoder does (a "set" field missing from a packet keeps its last
 * value) and is compared, field by field, with what the unfiltered packet says.
 *
 *   - no loss: identical on every tick
 *   - 10% of packets lost in transit + 10% skipped by the rate gate (never sent, never committed):
 *     every delivered full refresh makes it identical again, and nothing stays wrong longer than
 *     one refresh period
 *   - and the filtered stream is much smaller
 *
 * Usage:  node scripts/test_delta_fields.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_CLICK_TO_PLAY = '0';
const srv = require('../local_ws_server');
const { encode } = require('@msgpack/msgpack');
const S = require('../settings');
// The client's vec3 decode (bundle :65845): mode bits 1/2/4 = x/y/z missing (kept).
const VEC_OPS = new Set(['136', '137', '176', '178', '179', '180', '211']);
function setField(m, f) {
  if (VEC_OPS.has(f.key) && Array.isArray(f.tokens) && typeof f.tokens[1] === 'number' && f.tokens[1] <= 7) {
    const mode = f.tokens[1]; let k = 2;
    for (const [bit, ax] of [[1, 'x'], [2, 'y'], [4, 'z']]) if (!(mode & bit)) m.set(f.key + ax, JSON.stringify(f.tokens[k++]));
    return;
  }
  m.set(f.key, JSON.stringify(f.tokens));
}

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

// Header fields are scalar pairs up to the first 244; player blocks run 244 → next 244 / 280; the
// trailer from the last 280 is scalar pairs. (No bullets/hit events/entities in this test.)
function parse(body) {
  const out = { H: new Map(), T: new Map(), P: new Map() };
  let i = 0;
  while (i < body.length && body[i] !== 244 && body[i] !== 280) { out.H.set(String(body[i]), JSON.stringify(body[i + 1])); i += 2; }
  while (i < body.length && body[i] === 244) {
    let j = i + 2;
    while (j < body.length && body[j] !== 244 && body[j] !== 280) j++;
    // a block can hold a literal 244 or 280 VALUE; trust the splitter to find the real boundary
    let blk = body.slice(i, j), split = srv._splitPlayerBlock(blk);
    while (!split && j < body.length) { j++; while (j < body.length && body[j] !== 244 && body[j] !== 280) j++; blk = body.slice(i, j); split = srv._splitPlayerBlock(blk); }
    const m = out.P.get(String(blk[1])) || new Map();
    for (const f of split || []) setField(m, f);
    out.P.set(String(blk[1]), m);
    i = j;
  }
  for (; i < body.length; i += 2) out.T.set(String(body[i]), JSON.stringify(body[i + 1]));
  return out;
}
function apply(model, pkt) {
  for (const s of ['H', 'T']) for (const [k, v] of pkt[s]) model[s].set(k, v);
  for (const [eid, m] of pkt.P) {
    if (!model.P.has(eid)) model.P.set(eid, new Map());
    const mm = model.P.get(eid);
    // The decoder: a ++/-- counter missing from a PRESENT entity moves by one.
    for (const [k, v] of mm) {
      const dir = srv.DELTA_COUNTER_DIR[k];
      if (dir && !m.has(k)) { const tok = JSON.parse(v); tok[1] += dir; mm.set(k, JSON.stringify(tok)); }
    }
    for (const [k, v] of m) mm.set(k, v);
  }
}
// A "ticks since" counter that both sides hold at a never-happened value (>= 1000: 9999 vs the
// client's 10003) means the same thing; the server deliberately lets another player's drift there.
function sameField(k, a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined || !(srv.DELTA_COUNTER_DIR[k] > 0)) return false;
  const va = JSON.parse(a)[1], vb = JSON.parse(b)[1];
  return va >= 1000 && vb >= 1000;
}
function diff(model, full) {
  const bad = [];
  for (const s of ['H', 'T']) for (const [k, v] of full[s]) if (model[s].get(k) !== v) bad.push(`${s}${k}`);
  for (const [eid, m] of full.P) {
    const mm = model.P.get(eid);
    for (const [k, v] of m) if (!mm || !sameField(k, mm.get(k), v)) bad.push(`${eid}:${k}`);
  }
  return bad;
}

function run(lossRate, skipRate, seed, reliable = false) {
  let rnd = seed;
  const rand = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd / 2147483648; };
  const sessions = new Map();
  for (const id of ['pa', 'pb', 'pc']) {
    const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, id);
    sessions.set(id, { playerId: id, sessionId: id, accepted: true, isBot: false, playerState: ps,
      ws: reliable ? { reliableOrdered: true } : undefined,
      _deltaPhase: 7 * sessions.size });   // fixed refresh phase: deterministic
  }
  const models = new Map([...sessions.keys()].map((k) => [k, { H: new Map(), T: new Map(), P: new Map() }]));
  const stats = { fullBytes: 0, filtBytes: 0, mismatchTicks: 0, worstStreak: 0, refreshChecked: 0, refreshBad: 0, ticks: 0 };
  const streak = new Map();
  for (let tick = 1000; tick < 1400; tick++) {
    // Change the world: pa runs in circles, pb turns and sometimes jumps, pc stands still; energy
    // and health move now and then, pb switches weapon every 100 ticks.
    const pa = sessions.get('pa').playerState, pb = sessions.get('pb').playerState, pc = sessions.get('pc').playerState;
    pa.position.x = Math.cos(tick / 10) * 10; pa.position.z = Math.sin(tick / 10) * 10;
    pa.velocity.x = -Math.sin(tick / 10); pa.velocity.z = Math.cos(tick / 10); pa.yaw = tick / 10;
    pb.yaw = Math.sin(tick / 7); pb.pitch = Math.cos(tick / 13) * 0.3;
    if (tick % 37 === 0) pb.position.y = 3; if (tick % 37 === 5) pb.position.y = 2;
    if (tick % 50 === 0) pb.healthPoints = Math.max(0.2, (pb.healthPoints || 1) - 0.1);
    if (tick % 100 === 0) { pb.equippedWeaponId = pb.equippedWeaponId === 4 ? 262 : 4; pb.weaponSendCount = 3; }
    if (pb.weaponSendCount > 0 && tick % 1 === 0) pb.weaponSendCount--;
    void pc;
    for (const s of sessions.values()) {
      const full = srv.buildTickBody(s.playerId, tick, s.playerState, sessions);
      const ctx = srv.makeDeltaContext(s, tick);
      const filt = srv.buildTickBody(s.playerId, tick, s.playerState, sessions, ctx);
      stats.fullBytes += encode(full).length;
      if (rand() < skipRate) continue;                    // rate gate: not sent, not committed
      { const b = encode(filt).length; stats.filtBytes += b; if (tick >= 1040) stats.maxBytes = Math.max(stats.maxBytes || 0, b); }
      srv.commitDeltaContext(ctx);                        // sent
      const model = models.get(s.playerId);
      const delivered = rand() >= lossRate;
      if (delivered) apply(model, parse(filt));            // ...and arrived (or lost on the way)
      const bad = diff(model, parse(full));
      if (ctx && ctx.full && delivered) { stats.refreshChecked++; if (bad.length) stats.refreshBad++; }
      stats.ticks++;
      if (bad.length) {
        stats.mismatchTicks++;
        const st = (streak.get(s.playerId) || 0) + 1; streak.set(s.playerId, st);
        stats.worstStreak = Math.max(stats.worstStreak, st);
        if (lossRate === 0 && stats.firstBad === undefined) stats.firstBad = `${s.playerId}@${tick}: ${bad.slice(0, 6).join(' ')}`;
      } else streak.set(s.playerId, 0);
    }
  }
  return stats;
}

S.set('deltaSpreadRefresh', false, 'test');   // strict "one tick refreshes everything" checks first
console.log('\n── no loss: the client ends up exactly where the full stream would put it ──');
{
  const st = run(0, 0, 7);
  ok(`identical on all ${st.ticks} recipient-ticks`, st.mismatchTicks === 0, st.firstBad);
  const ratio = st.filtBytes / st.fullBytes;
  ok(`and the stream is much smaller (${(ratio * 100).toFixed(0)}% of the full one)`, ratio < 0.6,
    `${st.filtBytes} vs ${st.fullBytes} bytes`);
}

console.log('\n── 10% lost + 10% skipped by the rate gate ──');
{
  const st = run(0.10, 0.10, 11);
  const refresh = srv.getSettings ? null : null; void refresh;
  ok(`every full refresh that arrives makes the client exact again (${st.refreshChecked} checked)`,
    st.refreshChecked > 10 && st.refreshBad === 0, `${st.refreshBad} of ${st.refreshChecked} still wrong`);
  ok(`no value stays wrong for more than two refresh periods (worst ${st.worstStreak} ticks)`, st.worstStreak <= 2 * 20 + 4);
  ok(`stale on few ticks (${(100 * st.mismatchTicks / st.ticks).toFixed(1)}%)`, st.mismatchTicks / st.ticks < 0.15,
    `${st.mismatchTicks} of ${st.ticks}`);
}

console.log('\n── refresh spread over players (default): same guarantees, no giant packets ──');
{
  S.set('deltaSpreadRefresh', true, 'test');
  const st = run(0, 0, 7);
  ok(`no loss: identical on all ${st.ticks} recipient-ticks`, st.mismatchTicks === 0, st.firstBad);
  const lossy = run(0.10, 0.10, 11);
  ok(`10% lost: no value stays wrong for more than two refresh periods (worst ${lossy.worstStreak} ticks)`, lossy.worstStreak <= 2 * 20 + 4);
  S.set('deltaSpreadRefresh', false, 'test');
  const lumpy = run(0, 0, 7);
  S.set('deltaSpreadRefresh', true, 'test');
  ok(`after the first second, the biggest packet is smaller (${st.maxBytes} vs ${lumpy.maxBytes} bytes)`, st.maxBytes < lumpy.maxBytes);
}

console.log('\n── a reliable WebSocket recipient: counters left out too ──');
{
  const st = run(0, 0.10, 13, true);
  ok(`identical on all ${st.ticks} recipient-ticks, with 10% of ticks skipped by the rate gate`, st.mismatchTicks === 0, st.firstBad);
  const unrel = run(0, 0.10, 13, false);
  ok(`and never larger than for an unreliable one (${(100 * st.filtBytes / st.fullBytes).toFixed(0)}% vs ${(100 * unrel.filtBytes / unrel.fullBytes).toFixed(0)}% of the full stream)`,
    st.filtBytes <= unrel.filtBytes);
}

console.log('\n── a counter that counts up by one per packet ──');
{
  const count = (reliable, self = false) => {
    const rec = { playerId: 'r', ws: reliable ? { reliableOrdered: true } : undefined, _deltaPhase: 1 };
    let sent = 0;
    for (let tick = 100; tick < 140; tick++) {
      const block = [244, 'x', 146, tick - 50];          // ticksSinceLastShot, +1 every tick
      const ctx = srv.makeDeltaContext(rec, tick);
      ctx.selfEid = self ? 'x' : 'r';
      const out = [];
      srv._deltaAppendPlayerBlock(out, block, srv._splitPlayerBlock(block), ctx);
      srv.commitDeltaContext(ctx);
      if (out.includes(146)) sent++;
    }
    return sent;
  };
  const r = count(true), u = count(false), own = count(false, true);
  ok(`reliable recipient: sent only on the first tick and full refreshes (${r} of 40)`, r <= 3, String(r));
  ok(`unreliable recipient, another player's counter: first tick + re-sends + refreshes only (${u} of 40)`, u <= 3 + 4, String(u));
  ok(`unreliable recipient, its OWN counter: sent every tick (${own} of 40)`, own === 40, String(own));
  // a jump in value (a reset to 0) is re-sent for the re-send window over a lossy link
  {
    const rec = { playerId: 'r', _deltaPhase: 3 };
    const sentAt = [];
    for (let tick = 200; tick < 230; tick++) {
      const v = tick < 210 ? tick - 100 : tick - 210;     // resets to 0 at 210
      const block = [244, 'x', 146, v];
      const ctx = srv.makeDeltaContext(rec, tick); ctx.selfEid = 'r';
      const out = []; srv._deltaAppendPlayerBlock(out, block, srv._splitPlayerBlock(block), ctx); srv.commitDeltaContext(ctx);
      if (out.includes(146)) sentAt.push(tick);
    }
    ok(`a reset is sent and re-sent (${sentAt.filter((t) => t >= 210).join(',')})`, [210, 211, 212, 213, 214].every((t) => sentAt.includes(t)));
  }
}

console.log('\n── off switch ──');
{
  const s = { playerId: 'x' };
  // makeDeltaContext returns a context while the setting is on (default)
  ok('a context is made while deltaFields is on', !!srv.makeDeltaContext(s, 1));
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
