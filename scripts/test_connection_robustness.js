/**
 * test_connection_robustness.js — the link must survive a client behaving badly by accident.
 *
 * Not about attackers (see test:sockets / test:inputhard). These are the ways a REAL player's
 * connection degrades — a throttled tab, a saturated uplink, a phone on a dying signal — and what the
 * server did about them, which until now was nothing.
 *
 * 1. NO BACKPRESSURE. ws.bufferedAmount was never consulted. A client that stops READING still has a
 *    healthy TCP connection and still answers pings, so the heartbeat keeps it — while we queue a
 *    state packet 20x a second into a buffer it never drains. Server memory grows without limit, and
 *    every packet the client eventually reads is older than the last, so it falls further behind for
 *    as long as it stays connected. Skipping a state packet is safe: each tick is a full snapshot, so
 *    a skip behaves exactly like the dropped packet the protocol already tolerates.
 *
 * 2. NO PER-RECIPIENT ISOLATION IN THE BROADCAST. Same shape as the grenade-loop bug: the send loop
 *    was bare, so one fault while assembling a player's packet abandoned every player later in the
 *    map for that tick — and a deterministic fault starved the same players every tick.
 *
 * The subtle part of (1) is WHERE the check goes. It has to happen before the body is built, because
 * the body build CONSUMES one-shot payloads (peer bootstraps, peer removals, loadout deltas). Skipping
 * a send after consuming them loses them for good: the recipient then only ever meets that peer through
 * the plain 244 loop, which creates a bare {} — no name, no weapon, no skin. That is the "peers join as
 * undefined" bug, and it is exactly what a naive backpressure check would have reintroduced.
 *
 * Usage:  node scripts/test_connection_robustness.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = '18320';
process.env.EVIO_SEND_BUFFER_SKIP = '2048';     // trip easily
process.env.EVIO_SEND_BUFFER_MAX_TICKS = '40';  // 2s at 20Hz
process.env.EVIO_JOIN_DEADLINE = '0';           // not under test here

const fs = require('fs');
const path = require('path');
const net = require('net');
const WebSocket = require('ws');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const S = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const URL = 'ws://127.0.0.1:18320';

(async () => {
  await bpw.ready;
  srv.startServer();
  await wait(300);

  // The global tick loop is started by the first real connection and stopped when the last one goes, so
  // a session spliced into the map on its own is never ticked. Keep one genuine client connected for
  // the whole run — it is also the control for "a normal client is never affected".
  const control = new WebSocket(URL);
  await new Promise((r) => control.on('open', r));
  control.send(';{"uid":17,"name":"Guest7777"}');
  let controlPackets = 0;
  control.on('message', () => { controlPackets++; });
  await wait(500);

  console.log('\n── the settings exist and are sane ──');
  {
    const skip = S.list().find((x) => x.key === 'sendBufferSkipBytes');
    const maxT = S.list().find((x) => x.key === 'sendBufferMaxTicks');
    ok('sendBufferSkipBytes is a setting', !!skip);
    ok('it can be disabled', skip && skip.min === 0, 'operators need an escape hatch');
    ok('sendBufferMaxTicks gives a real grace period', maxT && maxT.value >= 20,
      `${maxT && maxT.value} ticks — too small would drop players over a brief stall`);
  }

  console.log('\n── a client that never reads is skipped, then dropped ──');
  {
    // WHY THIS DOES NOT USE A REAL SOCKET. I tried: a raw TCP socket that completes the handshake and
    // then never reads. bufferedAmount stayed 0 for the full 10s, because a tick body is only a few
    // hundred bytes — at 20Hz that is ~6 KB/s, and the kernel's loopback send buffer swallows all of it
    // without `ws` ever queuing a byte. The OS decides when bufferedAmount rises, so it cannot be
    // provoked on demand from here.
    //
    // So this drives the REAL broadcast loop with a socket whose bufferedAmount we control: a session
    // spliced into the live map with a stub socket. Everything under test — the threshold, the skip, the
    // consecutive-tick counter, the close — is the production code path on a production tick.
    const sessions = srv.getSessions();
    const closeCalls = [];
    let sent = 0;
    const stub = {
      readyState: 1, OPEN: 1,
      bufferedAmount: 999999,                    // wedged: never drains
      send() { sent++; },
      close(code) { closeCalls.push(code); },
      ping() {},
      on() {},
    };
    const st0 = srv.createPlayerSimState();
    const stalled = {
      sessionId: 'stalled-1', playerId: 'stalled-1', displayName: 'Stalled', uid: 17,
      accepted: true, ws: stub, playerState: st0, weaponId: 4,
      inputQueue: [], lastClientTick: 0, lastProcessedClientTick: -1,
      joinedAtTick: 0, tick: 0, _idleTicks: 0, _lastInputMs: Date.now(),
      pendingPeerBootstraps: [], pendingPeerRemovals: new Map(), loadoutDeltaSendCount: 0,
    };
    sessions.set('stalled-1', stalled);

    await wait(700);   // ~14 ticks
    ok('nothing is sent to a wedged socket', sent === 0,
      `${sent} sends — queuing more into a buffer it never drains only makes it worse`);
    ok('the skips are counted', (stalled._backpressureSkips || 0) > 5,
      `${stalled._backpressureSkips} skips in ~14 ticks`);
    ok('and it is not closed immediately', closeCalls.length === 0,
      'a brief stall must be survivable — this is a real player, not an attacker');

    // Past sendBufferMaxTicks (40 here) it must be given up on.
    await wait(2200);
    ok('a sustained stall is closed with 4005', closeCalls.includes(4005),
      `close calls: ${JSON.stringify(closeCalls)}`);
    sessions.delete('stalled-1');
  }

  console.log('\n── a socket that recovers is kept ──');
  {
    // The counter must RESET, or a client that stalls briefly every so often would accumulate ticks
    // across unrelated stalls and eventually be dropped for no reason.
    const sessions = srv.getSessions();
    let sent = 0;
    const closeCalls = [];
    const stub = {
      readyState: 1, OPEN: 1, bufferedAmount: 999999,
      send() { sent++; }, close(c) { closeCalls.push(c); }, ping() {}, on() {},
    };
    const flappy = {
      sessionId: 'flappy-1', playerId: 'flappy-1', displayName: 'Flappy', uid: 17,
      accepted: true, ws: stub, playerState: srv.createPlayerSimState(), weaponId: 4,
      inputQueue: [], lastClientTick: 0, lastProcessedClientTick: -1,
      joinedAtTick: 0, tick: 0, _idleTicks: 0, _lastInputMs: Date.now(),
      pendingPeerBootstraps: [], pendingPeerRemovals: new Map(), loadoutDeltaSendCount: 0,
    };
    sessions.set('flappy-1', flappy);
    await wait(600);
    const peak = flappy._backpressureTicks || 0;
    stub.bufferedAmount = 0;                       // drained
    await wait(400);
    ok('the consecutive counter resets on recovery', (flappy._backpressureTicks || 0) < peak,
      `${peak} -> ${flappy._backpressureTicks}`);
    ok('and sending resumes', sent > 0, `${sent} sends after recovery`);
    ok('it was never closed', !closeCalls.includes(4005), JSON.stringify(closeCalls));
    sessions.delete('flappy-1');
  }

  console.log('\n── a normal client is never affected ──');
  {
    // The control client has been connected throughout, including while the wedged sessions above were
    // being skipped and closed — so this also proves one stalled player does not disrupt the others.
    ok('a draining client keeps receiving state', controlPackets > 20,
      `${controlPackets} packets (expect ~20/s throughout the run)`);
    const st = srv.getStatus();
    const me = (st.players || []).find((p) => p.name === 'Guest7777');
    ok('and is never skipped for backpressure', !me || (me.sendSkips || 0) === 0,
      `sendSkips=${me && me.sendSkips}`);
    ok('with no send errors', !me || (me.sendErrors || 0) === 0,
      `sendErrors=${me && me.sendErrors}`);
  }

  console.log('\n── the check cannot eat a one-shot payload ──');
  {
    // The ordering property. If the backpressure skip ran AFTER the body was assembled, the flushed
    // peer bootstrap / removal / loadout delta would be lost with the unsent body — reintroducing
    // "peers join as undefined". The skip must therefore come before the body is built.
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    const skipAt = src.indexOf('SEND_BUFFER_SKIP_BYTES > 0 && s.ws');
    const bodyAt = src.indexOf('let body;');
    const flushAt = src.indexOf('flushPendingPeerBootstraps(s, body)');
    ok('the backpressure check precedes the body build', skipAt !== -1 && skipAt < bodyAt,
      `skip@${skipAt} body@${bodyAt}`);
    ok('and therefore precedes the one-shot flushes', skipAt < flushAt,
      `skip@${skipAt} flush@${flushAt} — flushing then not sending loses them for good`);
  }

  console.log('\n── one bad packet does not starve the other players ──');
  {
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    // The guard covers the whole packet, not just the write. My first version wrapped only sendState,
    // and a fault while BUILDING the body still escaped and abandoned every player later in the map —
    // so the try has to open before the body build and still contain the send.
    const guardIdx = src.indexOf("One recipient's whole packet, isolated");
    const bodyIdx = src.indexOf('let body;', guardIdx);
    const sendIdx = src.indexOf('totalBytes += sendState(', guardIdx);
    const catchIdx = src.indexOf('} catch (err) {', sendIdx);
    ok('the guard opens before the body is built',
      guardIdx !== -1 && bodyIdx > guardIdx, `guard@${guardIdx} body@${bodyIdx}`);
    ok('and the send is still inside it',
      sendIdx > bodyIdx && catchIdx > sendIdx, `send@${sendIdx} catch@${catchIdx}`);
    ok('a repeatedly failing socket is closed', /4006/.test(src),
      'otherwise it logs a stack trace every tick for ever');
    ok('safeSend cannot throw into its callers', /function safeSend[\s\S]{0,320}catch \(err\)/.test(src),
      'a socket can fail between the readyState check and the write');
  }

  console.log('\n── the dashboard can see it ──');
  {
    // A connection that answers pings while receiving stale state is invisible without this — the whole
    // point is that it looks healthy by every other measure.
    const st = srv.getStatus();
    const p = (st.players || [])[0];
    ok('per-player outbound stats are exposed',
      !p || ('sendBuffered' in p && 'sendSkips' in p && 'sendErrors' in p),
      p ? Object.keys(p).join(',') : 'no players');
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
