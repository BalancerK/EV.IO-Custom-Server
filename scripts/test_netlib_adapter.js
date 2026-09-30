/**
 * test_netlib_adapter.js — NetlibPeerSocket's channel-routing and lifecycle behavior.
 *
 * Isolated from any real signaling server / WebRTC connection on purpose: what this file
 * guards is the ADAPTER's own logic (binary → 'unreliable', text → 'reliable'; ws-compatible
 * readyState/close semantics), not netlib itself. A fake `network` object stands in for the real
 * Network instance, matching the pattern test_health_server.js already uses for a fake `game`.
 *
 * Usage:  node scripts/test_netlib_adapter.js
 */
'use strict';

const path = require('path');
const { NetlibPeerSocket, PING_CONTROL_MESSAGE, PONG_CONTROL_MESSAGE } = require(path.join(__dirname, '..', 'netlib_adapter.js'));

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

function fakeNetwork() {
  const sent = [];
  return {
    sent,
    send(channel, peerId, data) { sent.push({ channel, peerId, data }); },
  };
}

console.log('\n── binary sends go on the unreliable channel ──');
{
  const network = fakeNetwork();
  const sock = new NetlibPeerSocket(network, { id: 'peer-1' }, 'netlib:peer-1');
  const payload = Buffer.from([0x91, 0x01]); // msgpack fixarray — matches the real tick-body shape
  sock.send(payload, { binary: true });
  ok('exactly one send() call reached the fake network', network.sent.length === 1);
  ok('routed to the unreliable channel', network.sent[0] && network.sent[0].channel === 'unreliable');
  ok('addressed to the right peer id', network.sent[0] && network.sent[0].peerId === 'peer-1');
  ok('payload passed through unchanged', network.sent[0] && network.sent[0].data === payload);
}

console.log('\n── string/control sends go on the reliable channel ──');
{
  const network = fakeNetwork();
  const sock = new NetlibPeerSocket(network, { id: 'peer-2' }, 'netlib:peer-2');
  sock.send(';{"uid":17}'); // join message shape — no opts.binary at all, matching real call sites
  sock.send('`8'); // ping RPC shape
  ok('two sends reached the fake network', network.sent.length === 2);
  ok('join message routed reliable', network.sent[0].channel === 'reliable');
  ok('rpc message routed reliable', network.sent[1].channel === 'reliable');
}

console.log('\n── send() after close() is a silent no-op, matching a real ws socket ──');
{
  const network = fakeNetwork();
  const peer = { id: 'peer-3', close() {} };
  const sock = new NetlibPeerSocket(network, peer, 'netlib:peer-3');
  sock.close(1000, 'done');
  sock.send('late message');
  ok('readyState is CLOSED after close()', sock.readyState === sock.CLOSED);
  ok('no send reached the network after close', network.sent.length === 0);
}

console.log('\n── close() emits exactly one close event, with the given code/reason ──');
{
  const network = fakeNetwork();
  const peer = { id: 'peer-4', close() {} };
  const sock = new NetlibPeerSocket(network, peer, 'netlib:peer-4');
  const closes = [];
  sock.on('close', (code, reason) => closes.push({ code, reason }));
  sock.close(4009, 'test reason');
  sock.close(4009, 'test reason'); // second call must not double-emit
  ok('exactly one close event emitted', closes.length === 1);
  ok('close code passed through', closes[0] && closes[0].code === 4009);
  ok('close reason passed through', closes[0] && closes[0].reason === 'test reason');
}

console.log('\n── terminate() behaves like an abnormal close (code 1006) ──');
{
  const network = fakeNetwork();
  const peer = { id: 'peer-5', close() {} };
  const sock = new NetlibPeerSocket(network, peer, 'netlib:peer-5');
  let closeCode = null;
  sock.on('close', (code) => { closeCode = code; });
  sock.terminate();
  ok('terminate() closes with code 1006', closeCode === 1006);
}

console.log('\n── bufferedAmount is always 0 (documented Phase-1 stub, not a real backlog signal) ──');
{
  const network = fakeNetwork();
  const sock = new NetlibPeerSocket(network, { id: 'peer-6' }, 'netlib:peer-6');
  ok('bufferedAmount reads 0 before any sends', sock.bufferedAmount === 0);
  sock.send(Buffer.alloc(1000), { binary: true });
  ok('bufferedAmount still reads 0 after a send (no real queue depth exposed)', sock.bufferedAmount === 0);
}

console.log('\n── ping()/pong control messages never collide with real wire traffic ──');
{
  ok('PING control message is not a valid join (`;`) or RPC (`` ` ``) prefix',
    PING_CONTROL_MESSAGE[0] !== ';' && PING_CONTROL_MESSAGE[0] !== '`');
  ok('PONG control message is not a valid join (`;`) or RPC (`` ` ``) prefix',
    PONG_CONTROL_MESSAGE[0] !== ';' && PONG_CONTROL_MESSAGE[0] !== '`');
  ok('PING and PONG are distinct', PING_CONTROL_MESSAGE !== PONG_CONTROL_MESSAGE);
}

console.log(`\n${'─'.repeat(60)}\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
