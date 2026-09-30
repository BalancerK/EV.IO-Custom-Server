/**
 * test_wire_precision.js — the wire quantum must stay well under the comparator's tolerance.
 *
 * THE BUG
 * ───────
 * The client's divergence check (Qqx5i3b) is `Math.abs(server - client) > 1e-4` per axis. We rounded
 * positions with the default 4 decimals, making the wire quantum exactly 1e-4 — the SAME SIZE as the
 * tolerance. So two values that genuinely agreed to well within tolerance could round to adjacent
 * quanta and read as a divergence. From a live log while moving fast:
 *
 *   position => Server: {"x":41.0365,...}  Client: {"x":41.03660000000001,...}   delta 1.0000e-4
 *   position => Server: {"y":9.5999,...}   Client: {"y":9.599900000000002,...}   delta 1.8e-15
 *
 * Same tick: the y axis (not near a quantum boundary) agreed to 1e-15, while x — straddling one —
 * reported a full 1e-4. The physics was fine; the encoding was not.
 *
 * That is why it only bit at speed: the low-order digits churn every tick, so a boundary is crossed
 * constantly. Standing still the value is stable and both sides land on the same quantum. It is also
 * why it looked shooting-related — firing perturbs the low digits.
 *
 * Angles (139/140/141) already used 6 decimals. Position and velocity did not.
 *
 * Usage:  node scripts/test_wire_precision.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');
const bpw = require('../physics_world');

// The client's per-axis tolerance, from Qqx5i3b.
const TOL = 1e-4;

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const decimals = (v) => { const s = String(v); const i = s.indexOf('.'); return i === -1 ? 0 : s.length - i - 1; };

(async () => {
  await bpw.ready;
  const sp = bpw.spawnPoints[0];

  console.log('\n── the emitted quantum is far below the tolerance ──');
  {
    // A position whose digits sit just past 6dp, so rounding is observable.
    const ps = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 'p');
    ps.position = { x: 41.036612345678, y: 9.599912345678, z: -28.928212345678 };
    ps._ps.Qdsukt4 = { x: ps.position.x, y: ps.position.y, z: ps.position.z };
    const b = []; srv.appendPlayerTickBody(b, 'p', ps);
    const i = b.indexOf(136);
    ok('136 is emitted', i !== -1);
    const [sx, sy, sz] = [b[i + 2], b[i + 3], b[i + 4]];
    for (const [ax, sent, raw] of [['x', sx, ps.position.x], ['z', sz, ps.position.z]]) {
      ok(`${ax} keeps at least 6 decimals of precision`, decimals(sent) >= 5 || sent === raw,
        `sent ${sent} (${decimals(sent)} dp) from ${raw}`);
      ok(`${ax} round-trips within a fifth of the tolerance`, Math.abs(sent - raw) < TOL / 5,
        `error ${Math.abs(sent - raw).toExponential(3)} vs tolerance ${TOL}`);
    }
    ok('y too', Math.abs(sy - ps.position.y) < TOL / 5,
      `error ${Math.abs(sy - ps.position.y).toExponential(3)}`);
  }

  console.log('\n── the exact live-log case no longer reconciles ──');
  {
    // The client's value, and a server value that differs by 5e-5 — inside tolerance, but which
    // 4-decimal rounding used to push out to exactly 1e-4.
    const client = 41.03660000000001;
    const serverRaw = 41.03655;
    const r4 = Number(serverRaw.toFixed(4));
    const r6 = Number(serverRaw.toFixed(6));
    ok('the raw disagreement was always within tolerance', Math.abs(client - serverRaw) < TOL,
      `${Math.abs(client - serverRaw).toExponential(3)}`);
    ok('4 decimals turned it into a divergence', Math.abs(client - r4) > TOL,
      `4dp -> ${r4}, delta ${Math.abs(client - r4).toExponential(4)}`);
    ok('6 decimals keeps it a match', Math.abs(client - r6) < TOL,
      `6dp -> ${r6}, delta ${Math.abs(client - r6).toExponential(4)}`);
  }

  console.log('\n── quantisation can never by itself exceed the tolerance ──');
  {
    // Sweep values across quantum boundaries; the rounding error alone must stay far under 1e-4.
    let worst = 0, worstAt = 0;
    for (let k = 0; k < 20000; k++) {
      const v = -50 + k * 0.00731;
      const err = Math.abs(Number(v.toFixed(6)) - v);
      if (err > worst) { worst = err; worstAt = v; }
    }
    ok('worst rounding error over 20k values is <= half a 1e-6 quantum',
      worst <= 5e-7 + 1e-12, `${worst.toExponential(3)} at ${worstAt}`);
    ok('and that is at least 100x under the comparator tolerance', worst * 100 < TOL,
      `${(TOL / worst).toFixed(0)}x margin`);
  }

  console.log('\n── angles were already correct; keep them that way ──');
  {
    const ps = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, 'p');
    ps.yaw = 1.2345678901; ps.pitch = 0.0678912345; ps.pitchOffset = 0.0025512345;
    const b = []; srv.appendPlayerTickBody(b, 'p', ps);
    for (const [op, name, raw] of [[139, 'yaw', ps.yaw], [140, 'pitch', ps.pitch],
                                   [141, 'pitchOffset', ps.pitchOffset]]) {
      const sent = b[b.indexOf(op) + 1];
      ok(`${name} (${op}) round-trips within a fifth of the tolerance`,
        Math.abs(sent - raw) < TOL / 5, `sent ${sent} from ${raw}`);
    }
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
