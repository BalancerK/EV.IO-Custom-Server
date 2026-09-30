/**
 * test_send_cadence.js — peers are only as smooth as the packet cadence.
 *
 * THE REPORT
 * ──────────
 * "the movement of peers feels choppy, like a bit snapping instead of a smooth movement"
 *
 * THE CAUSE
 * ─────────
 * Peers are drawn by interpolating between the last two positions a client received, so smooth peer
 * motion needs packets to arrive EVENLY. The rate-match gate (rateMatchSends, on by default to stop the
 * client's state queue growing until it discards corrections) allowed one send per server tick that
 * drained any input. But a packet arriving just after a tick boundary — ordinary WAN jitter — leaves the
 * next tick draining TWO client ticks, and it still sent only one. The second was forfeited for ever.
 *
 * Measured with identical simulated jitter (diag:peersmooth, +/-25ms):
 *
 *     drain  (old)  15.5 packets/s   gap sd 23.1ms   36 stalls >80ms   UNEVEN
 *     credit (new)  20.0 packets/s   gap sd  6.1ms    0 stalls         EVEN
 *
 * A forfeited packet is a doubled gap, and a doubled gap is a doubled step for the client to cover in
 * one interpolation — which is exactly what "snapping" looks like.
 *
 * The fix is accounting, not rate: credit is earned per client tick CONSUMED and spent per send, so the
 * total still cannot exceed what the client produces (the point of rate matching) while nothing is
 * silently dropped.
 *
 * Usage:  node scripts/test_send_cadence.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';

const fs = require('fs');
const path = require('path');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const S = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

const mkSession = () => ({
  sessionId: 'c1', playerId: 'c1', accepted: true,
  inputQueue: [], playerState: srv.createPlayerSimState(),
  lastClientTick: 0, lastProcessedClientTick: -1,
  _idleTicks: 0, _lastInputMs: Date.now(),
});
const frame = () => [0, [[], [], [], [0, 0]]];

(async () => {
  await bpw.ready;

  console.log('\n── the default is the mode that does not forfeit ──');
  {
    const e = S.list().find((x) => x.key === 'rateMatchMode');
    ok('rateMatchMode exists', !!e);
    ok('and defaults to credit', e && e.value === 'credit',
      `${e && e.value} — "drain" forfeits a packet whenever two client ticks land in one server tick`);
    ok('the old behaviour is still selectable', e && e.choices.includes('drain'),
      'a rollback should not need a code edit');
  }

  console.log('\n── credit is earned per CLIENT TICK, not per draining server tick ──');
  {
    // The whole bug in one assertion. Two client ticks arrive between server ticks; the drain consumes
    // both. Under the old accounting that funded ONE send and the other was lost.
    const s = mkSession();
    s.inputQueue.push({ clientTick: 1, frames: [frame()] });
    s.inputQueue.push({ clientTick: 2, frames: [frame()] });
    srv.processBufferedTick(s, 100, new Map());
    ok('draining two client ticks earns two credits', (s._sendCredit || 0) === 2,
      `${s._sendCredit} — one per client tick consumed`);
  }

  console.log('\n── one tick of input funds exactly one send ──');
  {
    const s = mkSession();
    s.inputQueue.push({ clientTick: 1, frames: [frame()] });
    srv.processBufferedTick(s, 200, new Map());
    ok('a single drain earns one credit', (s._sendCredit || 0) === 1, String(s._sendCredit));
    // ...and a tick with nothing to drain earns none, so sends can never outpace the client.
    const before = s._sendCredit;
    srv.processBufferedTick(s, 201, new Map());
    ok('an empty tick earns nothing', (s._sendCredit || 0) === before,
      `${s._sendCredit} — otherwise the client's queue would grow until it discards corrections`);
  }

  console.log('\n── banked credit is capped ──');
  {
    // A client that stalls then floods its backlog must not earn a balance we then dump on it in one
    // burst — that is the queue growth rate matching exists to prevent.
    const s = mkSession();
    for (let i = 1; i <= 40; i++) s.inputQueue.push({ clientTick: i, frames: [frame()] });
    srv.processBufferedTick(s, 300, new Map());
    const creditCap = S.get('sendCreditMax');
    ok('credit cannot bank without limit', (s._sendCredit || 0) <= creditCap,
      `${s._sendCredit} after draining a 40-tick backlog (cap=${creditCap})`);
  }

  console.log('\n── the gate and the spend are wired to the accounting ──');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    ok('the gate consults credit in credit mode',
      /RATE_MATCH_MODE === "credit"[\s\S]{0,120}_sendCredit \|\| 0\) <= 0/.test(src));
    ok('and the old drain check is what "drain" selects',
      /: !s\._drainedThisTick;/.test(src));
    ok('every send spends one credit', /if \(s\._sendCredit > 0\) s\._sendCredit -= 1;/.test(src),
      'without the spend, credit only grows and the gate stops gating');
    ok('the cap is applied where credit is earned',
      /Math\.min\(SEND_CREDIT_MAX, \(session\._sendCredit \|\| 0\) \+ n\)/.test(src));
  }

  console.log('\n── rate matching can still be turned off entirely ──');
  {
    const e = S.list().find((x) => x.key === 'rateMatchSends');
    ok('rateMatchSends is still a separate switch', !!e && e.type === 'bool',
      'the accounting mode and whether to gate at all are different questions');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
