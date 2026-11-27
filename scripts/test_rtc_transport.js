/**
 * test_rtc_transport.js — WebRTC state/input transport.
 *
 *   - the "unreliable" data channel is unordered (no stall behind a lost packet) and the channel
 *     labels stay netlib's, in netlib's order (peers number them 0, 1, 2 and must agree)
 *   - the extension's late-state guard reads the server tick straight from the packet bytes
 *   - an input that lands after a newer one is merged into its own tick, not dropped
 *
 * Usage:  node scripts/test_rtc_transport.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_CLICK_TO_PLAY = '0';
const fs = require('fs');
const path = require('path');
const { encode } = require('@msgpack/msgpack');
const { encodeWire } = require('../wire_encode');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

console.log('\n── data channels ──');
{
  const { RTC_DATA_CHANNELS } = require('../netlib_adapter');
  ok('state/input channel is unordered with no retransmits',
    RTC_DATA_CHANNELS.unreliable.ordered === false && RTC_DATA_CHANNELS.unreliable.maxRetransmits === 0);
  ok('reliable stays ordered and reliable', RTC_DATA_CHANNELS.reliable.ordered === true && RTC_DATA_CHANNELS.reliable.maxRetransmits === undefined);
  ok('labels in netlib\'s order (reliable, unreliable, control)', Object.keys(RTC_DATA_CHANNELS).join() === 'reliable,unreliable,control');
}

// The extension's guard (offscreen.js) — browser code, so its two parser functions are lifted out.
const EXT = path.join(__dirname, '..', '..', 'evioreverseengineer', 'EV.IO UI Enhancer', 'offscreen.js');
if (fs.existsSync(EXT)) {
  console.log('\n── the extension reads a state packet\'s tick from its bytes ──');
  const src = fs.readFileSync(EXT, 'utf8');
  const grab = (name) => { const m = src.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n}\\n`)); return m && m[0]; };
  // eslint-disable-next-line no-new-func
  const stateTick = new Function(`${grab('readInt')}\n${grab('stateTick')}\nreturn stateTick;`)();
  const toAB = (u8) => u8.buffer.slice(u8.byteOffset, u8.byteOffset + u8.byteLength);
  const cases = [
    [[0, -1, [1, 5, 4, 5]], 5], [[0, 1234, [1, 200, 7, 1]], 200], [[3, -1, [1, 70000, 7, 1]], 70000],
    [[0, 99, [1, 4294967295]], 4294967295], [[-5, -1, [1, 40000, ...new Array(30).fill(0)]], 40000],
    [[0, -1, [1, 300, ...new Array(70000).fill(1)]], 300],
  ];
  ok('ticks of every size, short and long bodies, both encoders',
    cases.every(([pkt, t]) => stateTick(toAB(encode(pkt))) === t && stateTick(toAB(encodeWire(pkt))) === t),
    cases.map(([pkt]) => stateTick(toAB(encode(pkt)))).join(','));
  ok('a typed-array view works too', stateTick(encode([0, -1, [1, 77]])) === 77);
  ok('anything that is not a tick body is left alone (null)',
    [[0, -1, [244, 'p1']], [0, -1, []], 'hello', [1, 2], { a: 1 }].every((v) => stateTick(toAB(encode(v))) === null)
    && stateTick(new ArrayBuffer(2)) === null);
}

console.log('\n── an input that arrives after a newer one ──');
{
  const srv = require('../local_ws_server');
  const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'pa');
  const session = { sessionId: 'pa', playerId: 'pa', accepted: true, playerState: ps, inputQueue: [], lastProcessedClientTick: 9 };
  const f = (n) => [[n, [[0], [], [], [0.01 * n, 0]]]];
  const send = (ct, n) => srv.enqueueClientInput(session, [0, 0, -1, -1, ct, f(n)]);
  send(10, 1); send(12, 2); send(11, 3); send(10, 4); send(12, 5);
  const q = session.inputQueue;
  ok('queue stays in tick order', q.map((e) => e.clientTick).join() === '10,11,12', q.map((e) => e.clientTick).join());
  ok('the late tick-11 input is kept', q[1] && q[1].frames.length === 1);
  ok('a late extra packet for tick 10 is merged into tick 10', q[0] && q[0].frames.length === 2);
  ok('and the newest tick still merges as before', q[2] && q[2].frames.length === 2);
  const before = q.length;
  send(8, 6);   // already simulated: the carry path, not the queue
  ok('an input for a tick already simulated does not enter the queue', q.length === before);
}

console.log(`\n${'─'.repeat(60)}\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
