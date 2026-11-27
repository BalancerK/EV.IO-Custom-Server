/**
 * test_wire_encode.js — the state-packet encoder (wire_encode.js) and float32 peer kinematics.
 *
 *   - whatever it encodes decodes (with the reference @msgpack/msgpack decoder, which is what the
 *     client uses) to exactly the value given: no number changes, not even in the last bit
 *   - it is byte-identical to @msgpack/msgpack except where a float fits float32 exactly
 *   - other players' position / velocity / angles go out at float32 precision, the recipient's own
 *     never do, and a real lobby's packets get smaller
 *
 * Usage:  node scripts/test_wire_encode.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_CLICK_TO_PLAY = '0';
const { encode, decode } = require('@msgpack/msgpack');
const { encodeWire } = require('../wire_encode');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
// Exact equality, telling -0 from 0 and comparing NaN to NaN.
function same(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) || (a === 0 && b === 0);
  if (a === undefined) a = null;
  if (b === undefined) b = null;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  if (a instanceof Uint8Array || b instanceof Uint8Array) return Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every((k) => same(a[k], b[k]));
}

console.log('\n── round trip ──');
{
  const edge = [0, 1, 127, 128, 255, 256, 65535, 65536, 2 ** 32 - 1, 2 ** 32, Number.MAX_SAFE_INTEGER,
    -1, -32, -33, -128, -129, -32768, -32769, -(2 ** 31), -(2 ** 31) - 1, Number.MIN_SAFE_INTEGER,
    0.5, -0.25, 1.1, Math.PI, 1e300, -1e-300, 3.4028234663852886e38, 1e39, Math.fround(0.1), 0.1,
    NaN, Infinity, -Infinity, 2 ** 53, -(2 ** 53) - 2];
  ok('edge numbers', edge.every((v) => same(decode(encodeWire(v)), v)),
    edge.filter((v) => !same(decode(encodeWire(v)), v)).join(','));
  const strs = ['', 'a', 'x'.repeat(31), 'x'.repeat(32), 'x'.repeat(255), 'x'.repeat(256), 'x'.repeat(70000),
    'héllo', '日本語', '😀 emoji', 'https://ev.io/sites/default/files/maps/HUT8Bishop.evmap'];
  ok('strings (ASCII and UTF-8, every length class)', strs.every((v) => decode(encodeWire(v)) === v));
  const nested = [1, [2, [3, [true, false, null]]], { a: 1, b: 'two', c: [0.5, { d: null }] }, new Uint8Array([1, 2, 3]),
    new Array(20).fill(7), new Array(70000).fill(0), Object.fromEntries(Array.from({ length: 20 }, (_, i) => ['k' + i, i]))];
  ok('arrays, maps, bytes, every length class', same(decode(encodeWire(nested)), nested));
  ok('undefined goes out as nil, like the reference encoder', decode(encodeWire([undefined]))[0] === null);
  { const m = new Map([['a', 1]]); ok('an unusual value (a Map) is encoded as the reference encoder does', Buffer.compare(Buffer.from(encodeWire(m)), Buffer.from(encode(m))) === 0); }

  let rnd = 12345;
  const r = () => { rnd = (rnd * 1103515245 + 12345) % 2147483648; return rnd / 2147483648; };
  const rv = (d) => {
    const t = r();
    if (d > 3 || t < 0.4) return [() => Math.floor(r() * 1e6) - 5e5, () => (r() - 0.5) * 1e3, () => Math.fround(r() * 100),
      () => r() < 0.5, () => null, () => 's' + Math.floor(r() * 1e6)][Math.floor(r() * 6)]();
    if (t < 0.7) return Array.from({ length: Math.floor(r() * 20) }, () => rv(d + 1));
    return Object.fromEntries(Array.from({ length: Math.floor(r() * 5) }, (_, i) => ['f' + i, rv(d + 1)]));
  };
  let bad = 0, identical = 0, total = 0;
  for (let i = 0; i < 2000; i++) {
    const v = rv(0); total++;
    if (!same(decode(encodeWire(v)), v)) bad++;
  }
  ok(`2000 random structures decode to exactly what was given (${bad} differ)`, bad === 0);
  // Without float32-exact floats the bytes are the reference encoder's, byte for byte.
  for (let i = 0; i < 500; i++) {
    const v = [Math.floor(r() * 1e9) - 5e8, (r() - 0.5) * 1e3 + 1e-9, 'n' + i, [true, null, { x: i }]];
    if (Buffer.compare(Buffer.from(encodeWire(v)), Buffer.from(encode(v))) === 0) identical++;
  }
  ok(`byte-identical to @msgpack/msgpack when no float fits float32 (${identical}/500)`, identical === 500);
  ok('a float32-exact float takes 5 bytes, any other 9', encodeWire(0.5).length === 5 && encodeWire(0.1).length === 9);
  void total;
}

console.log('\n── real packets: peers reduced to float32, self never ──');
const srv = require('../local_ws_server');
const S = require('../settings');
{
  const sessions = new Map();
  for (let i = 0; i < 6; i++) {
    const id = 'p' + i;
    const ps = srv.createPlayerSimState({ x: i * 3, y: 2, z: 0, yaw: 0 }, id);
    sessions.set(id, { playerId: id, sessionId: id, accepted: true, isBot: false, playerState: ps, _deltaPhase: i * 5 });
  }
  const step = (tick) => {
    let k = 0;
    for (const s of sessions.values()) {
      const p = s.playerState, a = tick / 10 + k++;
      p.position.x = Math.cos(a) * 10 + k * 1.3; p.position.z = Math.sin(a) * 10 + 0.123456;
      p.velocity.x = -Math.sin(a) * 8.1; p.velocity.z = Math.cos(a) * 8.1; p.yaw = a * 1.0001; p.pitch = Math.sin(a / 3) * 0.3;
    }
  };
  const peerVals = [], selfVals = [];
  let roundTripBad = 0;
  const bytes = { on: 0, off: 0 };
  for (const mode of ['off', 'on']) {
    S.set('wireFloat32', mode === 'on', 'test');
    for (let tick = 5000; tick < 5100; tick++) {
      step(tick);
      const s = sessions.get('p0');
      const body = srv.buildTickBody('p0', tick, s.playerState, sessions);   // unfiltered: every field
      const pkt = [0, tick, body];
      const wire = mode === 'on' ? encodeWire(pkt) : encode(pkt);
      bytes[mode] += wire.length;
      if (mode === 'on') {
        if (!same(decode(wire), pkt)) roundTripBad++;
        // positions: self is the first 244 block, peers after
        let ent = null;
        for (let i = 0; i < body.length - 4; i++) {
          if (body[i] === 244) ent = body[i + 1];
          if (body[i] === 136 && body[i + 1] === 0 && typeof body[i + 2] === 'number') {
            (ent === 'p0' ? selfVals : peerVals).push(body[i + 2], body[i + 4]);
          }
        }
      }
    }
  }
  const nonInt = (v) => !Number.isInteger(v);
  ok('every packet decodes to exactly what was built', roundTripBad === 0, `${roundTripBad} differ`);
  ok(`peer positions are float32 (${peerVals.length} checked)`, peerVals.length > 100 && peerVals.filter(nonInt).every((v) => Math.fround(v) === v));
  ok('the recipient\'s own position keeps full precision', selfVals.filter(nonInt).some((v) => Math.fround(v) !== v));
  ok(`a 6-player packet with every field is smaller (${(bytes.on / 100).toFixed(0)} vs ${(bytes.off / 100).toFixed(0)} bytes)`,
    bytes.on < bytes.off * 0.95);
  S.set('wireFloat32', true, 'test');
}

console.log(`\n${'─'.repeat(60)}\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
