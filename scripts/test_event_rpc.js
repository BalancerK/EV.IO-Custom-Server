/**
 * test_event_rpc.js
 *
 * EVERY backtick request must get EXACTLY ONE backtick response.
 *
 * WHY THIS MATTERS MORE THAN IT LOOKS
 * ───────────────────────────────────
 * The client's real sendEvent is `NetSyncClient.sendEvent` (bundle :27531), a SERIAL promise queue:
 *
 *     this.eventQueue = this.eventQueue.then(() => new Promise((resolve) => {
 *         socketApi.onEventResponse = resolve;     // resolves ONLY on a server reply
 *         socketApi.sendEvent(code, arg);
 *     }));
 *     return this.eventQueue;
 *
 * So a single unanswered request does not just lose its own reply — it wedges the queue and every
 * later sendEvent behind it, forever. The visible symptom was the HUD ping frozen at a constant:
 * `measureLatency()` (bundle :68082) is `t0 = Date.now(); await sendEvent('8'); return Date.now()-t0`,
 * and `Q942pcu()` writes the result into `#ping_span`. Once the queue stalls that write never runs
 * again and the span keeps ev.io's static placeholder — which reads as "ping stuck".
 *
 * The regression: `handleLoadoutRpc` consumed codes 6/7 and returned without replying.
 *
 * Two replies would be just as wrong — `onEventResponse` is overwritten per request, so a stray
 * extra reply resolves the NEXT request early and mis-pairs every response after it.
 *
 * Usage:  node scripts/test_event_rpc.js
 */
'use strict';

process.env.EVIO_LOCAL_PORT = process.env.EVIO_LOCAL_PORT || '18120';
process.env.EVIO_ADMIN = '0';

const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));
const srv = require('../local_ws_server');
const bpw = require('../physics_world');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

// Codes the client actually sends. 6/7 are the loadout RPCs that used to stall the queue; 8 is the
// ping. The rest are startup requests.
const CODES = ['2', '3', '4', '5', '6', '7', '8', '9', '10', '14', '18', '20', '27', '99'];

bpw.ready.then(() => {
  srv.startServer();
  const ws = new WebSocket(`ws://127.0.0.1:${process.env.EVIO_LOCAL_PORT}`);
  const replies = [];
  let joined = false;

  ws.on('error', (e) => { console.error('client error:', e.message); process.exit(1); });
  ws.on('message', (d, isBinary) => {
    if (isBinary) return;
    const t = d.toString('utf8');
    if (t.startsWith('ID')) { ws.send(';' + JSON.stringify({ name: 'rpc-test', uid: 17 })); return; }
    if (t.startsWith(';')) { joined = true; return; }
    if (t.startsWith('`')) replies.push(t.slice(1));
  });

  ws.on('open', () => {
    // Wait for the join to be accepted, then fire every code and count replies.
    const start = Date.now();
    (function waitJoin() {
      if (!joined && Date.now() - start < 3000) return setTimeout(waitJoin, 20);

      console.log('\n── every backtick request gets exactly one reply ──');
      let i = 0;
      (function next() {
        if (i >= CODES.length) return finish();
        const code = CODES[i++];
        const before = replies.length;
        ws.send('`' + code + '`' + JSON.stringify(0));
        // Give the server a beat to answer this one before sending the next, so replies can be
        // attributed to their request the way the client's serial queue does.
        setTimeout(() => {
          const got = replies.length - before;
          ok(`code ${code.padEnd(2)} → exactly 1 reply`, got === 1, `got ${got}`);
          next();
        }, 60);
      })();

      function finish() {
        console.log('\n── the replies are parseable (client does JSON.parse on them) ──');
        let bad = null;
        for (const r of replies) { try { JSON.parse(r); } catch (e) { bad = r.slice(0, 40); break; } }
        ok('every reply body is valid JSON', bad === null, bad ? `unparseable: ${bad}` : '');

        console.log('\n── the loadout RPCs still apply their side effects ──');
        const st = srv.getStatus();
        ok('a player is still connected after the RPC burst', st.playerCount === 1,
          `playerCount=${st.playerCount}`);

        console.log('\n' + '─'.repeat(60));
        console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
        process.exit(fail === 0 ? 0 : 1);
      }
    })();
  });
});
