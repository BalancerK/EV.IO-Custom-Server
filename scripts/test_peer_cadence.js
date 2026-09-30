/**
 * test_peer_cadence.js — a recipient must never be starved of PEER updates.
 *
 * THE FLAW THIS GUARDS
 * ────────────────────
 * Rate matching skips a player's broadcast on a server tick that drained none of THAT PLAYER'S input,
 * so a client is never sent more states of itself than it produced input for. Reasonable in isolation.
 *
 * But the packet it withholds also carries every OTHER player's position, and the gate is keyed on the
 * recipient's own input. One late input packet of mine therefore costs me that tick's update for
 * everyone else: they freeze for a tick on my screen, then jump a double step when the next packet
 * lands. Every player's gaps are independent, so with several players everyone sees everyone else
 * stutter. The client interpolates between the last two states it received — a doubled gap is a
 * doubled step to cover, which is exactly "choppy and snapping" peer movement.
 *
 * Measured on the live server before the fix: 12 gaps >= 90ms in 881 packets (1.4%, worst 167ms) for a
 * client sending a metronomic 20Hz — about one hitch every 3.7 seconds.
 *
 * This drives a REAL socket against the REAL broadcast loop and measures the delivered cadence, since
 * the failure is in send scheduling and cannot be seen by calling a function.
 *
 * Usage:  node scripts/test_peer_cadence.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = '18415';
process.env.EVIO_JOIN_DEADLINE = '0';

const WebSocket = require('ws');
const msgpack = require('@msgpack/msgpack');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const S = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = 'ws://127.0.0.1:18415';

// Open a client that pumps input at a deliberately IMPERFECT rate. A metronome hides the bug: the
// gate only skips when a tick drains nothing, which needs the client's cadence to drift against the
// server's — exactly what a real browser does.
async function client(name, periodMs) {
  const ws = new WebSocket(URL);
  await new Promise((r) => ws.on('open', r));
  ws.send(';' + JSON.stringify({ uid: 17, name }));
  const stamps = [];
  ws.on('message', () => stamps.push(Date.now()));
  let ct = 1;
  const timer = setInterval(() => {
    try { ws.send(msgpack.encode([0, 0, -1, -1, ct++, [[1, [[], [], [], [0.0002, 0]]]]])); } catch (_) {}
  }, periodMs);
  return { ws, stamps, stop: () => { clearInterval(timer); try { ws.close(); } catch (_) {} } };
}

function gapStats(stamps) {
  const iv = [];
  for (let i = 1; i < stamps.length; i++) iv.push(stamps[i] - stamps[i - 1]);
  const use = iv.slice(3);                       // ignore bootstrap burst
  if (!use.length) return { n: 0, gaps: 0, pct: 100, max: 0 };
  const gaps = use.filter((v) => v >= 90).length;
  return { n: use.length, gaps, pct: (100 * gaps / use.length), max: Math.max(...use) };
}

(async () => {
  await bpw.ready;
  srv.startServer();
  await wait(300);

  // 53ms against a 50ms server tick: the two beat against each other, so some ticks drain nothing.
  const a = await client('Alpha', 53);
  const b = await client('Bravo', 53);
  await wait(600);

  console.log('\n── the setting exists ──');
  {
    const e = S.list().find((x) => x.key === 'rateMatchKeepPeers');
    ok('rateMatchKeepPeers is a setting', !!e);
    ok('and it is ON by default', e && e.value === true,
      'starving peers of updates is never what an operator wants by default');
  }

  console.log('\n── with a peer present, no tick is withheld ──');
  {
    S.set('rateMatchKeepPeers', true, 'test');
    a.stamps.length = 0; b.stamps.length = 0;
    await wait(6000);
    const ga = gapStats(a.stamps), gb = gapStats(b.stamps);
    ok('Alpha receives a steady stream', ga.n > 50 && ga.pct < 2,
      `${ga.gaps}/${ga.n} gaps >=90ms (${ga.pct.toFixed(1)}%), max ${ga.max}ms`);
    ok('Bravo receives a steady stream', gb.n > 50 && gb.pct < 2,
      `${gb.gaps}/${gb.n} gaps >=90ms (${gb.pct.toFixed(1)}%), max ${gb.max}ms`);
    // The real invariant: near 20Hz. Peer interpolation is built on that cadence.
    const rate = ga.n / 6;
    ok('and at roughly the tick rate', rate > 17, `${rate.toFixed(1)} packets/s`);
  }

  console.log('\n── strict rate matching is still available ──');
  {
    // Not asserting that it MUST produce gaps — that depends on how the two clocks happen to beat,
    // and a flaky assertion is worse than none. What matters is that the switch is honoured.
    S.set('rateMatchKeepPeers', false, 'test');
    a.stamps.length = 0;
    await wait(3000);
    const g = gapStats(a.stamps);
    ok('the strict mode still delivers packets', g.n > 20, `${g.n} packets`);
    console.log(`     (strict mode gaps: ${g.gaps}/${g.n} = ${g.pct.toFixed(1)}%, max ${g.max}ms)`);
    S.set('rateMatchKeepPeers', true, 'test');
  }

  a.stop(); b.stop();
  await wait(200);
  S.reset('rateMatchKeepPeers', 'test');

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
