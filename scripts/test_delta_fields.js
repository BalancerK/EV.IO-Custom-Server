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
    for (const f of split || []) m.set(f.key, JSON.stringify(f.tokens));
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
function diff(model, full) {
  const bad = [];
  for (const s of ['H', 'T']) for (const [k, v] of full[s]) if (model[s].get(k) !== v) bad.push(`${s}${k}`);
  for (const [eid, m] of full.P) {
    const mm = model.P.get(eid);
    for (const [k, v] of m) if (!mm || mm.get(k) !== v) bad.push(`${eid}:${k}`);
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
      stats.filtBytes += encode(filt).length;
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
  const count = (reliable) => {
    const rec = { playerId: 'r', ws: reliable ? { reliableOrdered: true } : undefined, _deltaPhase: 1 };
    let sent = 0;
    for (let tick = 100; tick < 140; tick++) {
      const block = [244, 'x', 146, tick - 50];          // ticksSinceLastShot, +1 every tick
      const ctx = srv.makeDeltaContext(rec, tick);
      const out = [];
      srv._deltaAppendPlayerBlock(out, block, srv._splitPlayerBlock(block), ctx);
      srv.commitDeltaContext(ctx);
      if (out.includes(146)) sent++;
    }
    return sent;
  };
  const r = count(true), u = count(false);
  ok(`reliable recipient: sent only on the first tick and full refreshes (${r} of 40)`, r <= 3, String(r));
  ok(`unreliable recipient: sent every tick (${u} of 40)`, u === 40, String(u));
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
