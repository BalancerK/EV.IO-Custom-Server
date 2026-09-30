'use strict';

// netlib_adapter.js — WebRTC transport for the game socket, running ALONGSIDE the existing
// `ws`-based WebSocketServer (see the netlib migration plan). Wraps each connected netlib
// peer in an EventEmitter shaped enough like a `ws` WebSocket that local_ws_server.js's
// existing connection-handling code — built entirely around that library's interface —
// needs no changes at all. This file is the ONLY place in the server that knows netlib or
// WebRTC exists; everything past "how do bytes get from A to B" is untouched.
//
// `vendor/netlib.js` is a BUILD ARTIFACT, copied from `../netlib-vendor/dist/netlib.js`
// (itself a pinned, modified fork of proofnetworks/netlib — see that directory's
// VENDORED.md) so that `server/` stays self-contained and deployable via the existing
// deploy/sync.sh, which only syncs this directory. Rebuild it there and re-copy; do not
// hand-edit the copy.
//
// PROTOCOL SAFETY NOTE: netlib's receiver inspects the FIRST BYTE of any incoming binary
// message to detect its own internal tagged formats (sendJSON=0x01, sendAuto's
// 0x02-0x04 — see lib/peer.ts's onmessage handler in the vendored source). We never call
// sendJSON/sendAuto ourselves, and the one binary payload this protocol ever sends (the
// msgpack-encoded tick body, appendPlayerTickBody's output) is always a msgpack ARRAY,
// whose leading byte is always >= 0x90 (fixarray) or 0xdc/0xdd (array16/32) — never
// 0x01-0x04 — so this cannot collide in practice. If a future change ever sends binary
// data that is NOT a msgpack array on this transport, re-verify this note still holds.

const EventEmitter = require('events');

const WS_CONNECTING = 0;
const WS_OPEN = 1;
const WS_CLOSING = 2;
const WS_CLOSED = 3;

// Every lobby this server creates carries this in customData, so a client can find the
// right one via list()-filtering and pin its idea of "the server" to whichever peer's id
// is named here — NOT to netlib's own `leader` field, which is real but electable (see the
// migration plan for why that matters), and NOT to a `creator` field, which does not exist
// in this version of the library despite being documented in its README.
const LOBBY_APP_MARKER = 'evio-custom-server';

// ── The ws-compatible peer wrapper ──────────────────────────────────────────────────────
class NetlibPeerSocket extends EventEmitter {
  constructor(network, peer, remoteLabel) {
    super();
    this._network = network;
    this._peer = peer;
    this._closed = false;
    this.readyState = WS_OPEN; // a peer only reaches us once netlib itself calls it 'connected'
    this.isAlive = true; // read/written by the existing heartbeat sweep, same as a real ws socket
    // Stand-in for req.socket.remoteAddress/remotePort — a netlib peer has no IP the way a raw
    // TCP/WS connection does (WebRTC negotiates its own transport underneath); per-peer-id is
    // already a unique, server-assigned identifier, so IP-based admission checks (rate limits,
    // maxConnectionsPerIp) are given this instead. Documented Phase-1 limitation, not a bypass:
    // those checks still run, they just key on the peer id rather than a shared residential IP.
    this.remoteLabel = remoteLabel;
  }

  get OPEN() { return WS_OPEN; }
  get CONNECTING() { return WS_CONNECTING; }
  get CLOSING() { return WS_CLOSING; }
  get CLOSED() { return WS_CLOSED; }

  // WebRTC data channels DO expose bufferedAmount natively, but netlib's Peer does not surface
  // it through its own public API, so there is nothing real to read here. Reporting 0
  // unconditionally means SEND_BUFFER_SKIP_BYTES's skip logic never engages for netlib peers in
  // this phase — a known, deliberate simplification, not an oversight (see the migration plan).
  // It matters less here than it did for the WS transport: the unreliable channel drops under
  // real congestion instead of queuing without bound the way a TCP socket does, which is a large
  // part of why this migration exists in the first place.
  get bufferedAmount() { return 0; }

  send(data, opts) {
    if (this.readyState !== WS_OPEN) return;
    // Routing rule from the migration plan: per-tick state/input (binary, msgpack) tolerates
    // loss by design already (a skip already behaves "like a dropped packet" in the existing
    // protocol) — unreliable channel, which is the actual fix for head-of-line blocking. Join,
    // chat, RPCs and admin/control messages (always plain strings here) need guaranteed ordered
    // delivery — reliable channel. This is transport routing, not a protocol change: the exact
    // same bytes/string are sent either way.
    const channel = (opts && opts.binary) ? 'unreliable' : 'reliable';
    try {
      this._network.send(channel, this._peer.id, data);
    } catch (err) {
      this.emit('error', err);
    }
  }

  close(code, reason) {
    if (this.readyState === WS_CLOSED) return;
    this.readyState = WS_CLOSING;
    try { this._peer.close(reason); } catch (_) {}
    // Several existing call sites do `s.ws.close(...)` then immediately act as though the
    // connection is gone (e.g. session cleanup) — finishing synchronously here matches how those
    // call sites already assume a real ws.close() behaves close enough to synchronous for their
    // purposes, rather than waiting for netlib's own async 'disconnected' event.
    this._finishClose(code, reason);
  }

  terminate() { this.close(1006, 'terminated'); }

  // No native ping/pong over a data channel (unlike raw WebSocket). Emulated with a tiny
  // reliable control message; the receiving end's message router (see wrapPeer below) replies
  // automatically and synthesizes a 'pong' event on ITS OWN socket for the heartbeat sweep on
  // that side — mirroring what a real WS pong frame does, without needing one to exist.
  ping() {
    if (this.readyState !== WS_OPEN) return;
    try { this._network.send('reliable', this._peer.id, PING_CONTROL_MESSAGE); } catch (_) {}
  }

  _finishClose(code, reason) {
    if (this._closed) return;
    this._closed = true;
    this.readyState = WS_CLOSED;
    this.emit('close', Number.isFinite(code) ? code : 1000, reason || '');
  }
}

// Reserved control-message strings, distinct from anything the real wire protocol ever sends
// (which is always `;`/`` ` ``-prefixed JSON, or a msgpack array — never these exact literal
// strings) — used only for the synthetic ping/pong emulated above.
const PING_CONTROL_MESSAGE = '\u0000EVIO_PING';
const PONG_CONTROL_MESSAGE = '\u0000EVIO_PONG';

// ── Network bootstrap ───────────────────────────────────────────────────────────────────
// Polyfills the WebRTC globals netlib's browser-oriented source calls directly (`new
// RTCPeerConnection(...)`, `new WebSocket(...)`) with no injection point of their own — see
// lib/peer.ts and lib/signaling.ts in the vendored source. Node 20+ already has a native
// global WebSocket (used for the signaling connection itself), so only RTCPeerConnection needs
// a real polyfill, via @roamhq/wrtc (the same package the vendored library's own test suite
// uses for exactly this — see netlib-vendor/README.md's "Star topology" section).
function ensureWebRtcPolyfill() {
  if (!globalThis.RTCPeerConnection) {
    const wrtc = require('@roamhq/wrtc');
    globalThis.RTCPeerConnection = wrtc.RTCPeerConnection;
    globalThis.RTCSessionDescription = wrtc.RTCSessionDescription;
    globalThis.RTCIceCandidate = wrtc.RTCIceCandidate;
  }
  // netlib's signaling connection does a plain browser-style `new WebSocket(url)` (see
  // lib/signaling.ts's connect()). Node only ships a global WebSocket from v22 — found live on
  // this VPS's Node v20.20.2 (`ReferenceError: WebSocket is not defined`, thrown from inside
  // netlib.js itself, well past this file's own code, on every netlib listener start attempt).
  // The `ws` package is already a dependency of this project for the real game socket; its
  // top-level `WebSocket` export is the browser-API-compatible wrapper (not the server class),
  // so it drops in here with no other change needed.
  if (!globalThis.WebSocket) {
    globalThis.WebSocket = require('ws').WebSocket;
  }
}

// Starts the netlib Network, creates (or, on failure, discovers-and-verifies) our lobby, and
// calls `onConnection(fakeWs, fakeReq)` for every peer that joins — the exact same shape
// `wss.on("connection", (ws, req) => ...)` already uses, so the caller can feed it into the
// identical connection-handling code path with zero changes there.
//
// `fakeReq` carries only what local_ws_server.js's connection handler actually reads from a
// real req (checked against its call sites): `.socket.remoteAddress`/`.remotePort` and
// `.headers`. A WebRTC peer has neither a real remote IP the way a TCP connection does nor
// HTTP headers at all — remoteAddress is set to a synthetic, uniquely-identifying label
// (`netlib:<peerId>`) instead, and headers is empty. IP-scoped admission checks therefore key
// on the peer id rather than a shared residential IP for netlib connections specifically; see
// NetlibPeerSocket's own comment for why this is an accepted Phase-1 simplification, not a
// bypass of those checks.
async function startNetlibListener(opts) {
  const {
    gameId,
    signalingUrl,
    maxPlayers = 32,
    onConnection,
    log = console.log,
    logError = console.error,
  } = opts || {};

  if (!gameId) throw new Error('startNetlibListener: gameId is required');
  if (!signalingUrl) throw new Error('startNetlibListener: signalingUrl is required');
  if (typeof onConnection !== 'function') throw new Error('startNetlibListener: onConnection is required');

  ensureWebRtcPolyfill();

  // eslint-disable-next-line global-require -- deferred until actually enabled, matching the
  // rest of this codebase's `_maybeStart*` pattern for optional subsystems.
  const { Network, DefaultRTCConfiguration } = require('./vendor/netlib.js');
  const network = new Network(gameId, DefaultRTCConfiguration, signalingUrl);

  const sockets = new Map(); // peer.id -> NetlibPeerSocket

  function wrapPeer(peer) {
    const label = `netlib:${peer.id}`;
    const sock = new NetlibPeerSocket(network, peer, label);
    sockets.set(peer.id, sock);
    const fakeReq = { socket: { remoteAddress: label, remotePort: 0 }, headers: {} };
    try {
      onConnection(sock, fakeReq);
    } catch (err) {
      logError('[netlib] onConnection handler threw', err);
      try { sock.close(1011, 'internal error'); } catch (_) {}
    }
    return sock;
  }

  network.on('connected', (peer) => {
    log(`[netlib] peer connected: ${peer.id}`);
    wrapPeer(peer);
  });

  network.on('disconnected', (peer) => {
    const sock = sockets.get(peer.id);
    sockets.delete(peer.id);
    if (sock) sock._finishClose(1000, 'peer disconnected');
  });

  network.on('message', (peer, channel, data) => {
    const sock = sockets.get(peer.id);
    if (!sock) return; // message from a peer we never finished wrapping (or already closed)
    if (data === PING_CONTROL_MESSAGE) {
      try { network.send('reliable', peer.id, PONG_CONTROL_MESSAGE); } catch (_) {}
      return;
    }
    if (data === PONG_CONTROL_MESSAGE) {
      sock.isAlive = true;
      sock.emit('pong');
      return;
    }
    // isBinary mirrors what `ws` itself reports: true for anything that isn't a plain string.
    // Real WebRTC data channels always deliver non-string payloads as ArrayBuffer — never a
    // Node Buffer — so this covers both this-process-is-the-Node-signaling-peer's own binary
    // sends AND anything a browser peer ever sends.
    const isBinary = typeof data !== 'string';
    sock.emit('message', isBinary ? Buffer.from(data) : data, isBinary);
  });

  network.on('rtcerror', (err) => logError('[netlib] rtc error', err));
  network.on('signalingerror', (err) => logError('[netlib] signaling error', err));

  await new Promise((resolve, reject) => {
    const onReady = () => { network.off('failed', onFailed); resolve(); };
    const onFailed = () => { network.off('ready', onReady); reject(new Error('netlib signaling failed')); };
    network.once('ready', onReady);
    network.once('failed', onFailed);
  });

  log(`[netlib] ready, peer id = ${network.id}`);

  const lobbyCode = await joinOrCreateOwnLobby(network, { maxPlayers, log, logError });
  log(`[netlib] hosting lobby ${lobbyCode} as the authoritative peer (id ${network.id})`);

  return {
    network,
    lobbyCode,
    close() {
      for (const sock of sockets.values()) { try { sock.close(1001, 'server shutting down'); } catch (_) {} }
      sockets.clear();
      try { network.close(); } catch (_) {}
    },
  };
}

// Always tries create() first — every call gets a fresh, server-assigned random code (there is
// no way to request a specific one; see LobbySettings in the vendored types), so a PREVIOUS run
// of this same server cannot collide with a code THIS run picks. create() only fails (returns
// '', per the vendored source — it does not throw) on a genuine signaling/store problem, in
// which case this retries a few times with a short backoff rather than silently falling back to
// joining an unrelated lobby, which would be a real authority-model change, not a transient
// hiccup.
async function joinOrCreateOwnLobby(network, { maxPlayers, log, logError }) {
  const attempts = 5;
  for (let i = 0; i < attempts; i++) {
    const code = await network.create({
      maxPlayers,
      // Required for client-side discovery: the signaling server's list() query filters on
      // `public = true` at the store level (internal/signaling/stores/postgres.go) — a private
      // lobby is simply invisible to list(), full stop, regardless of any customData filter
      // passed alongside it. Not a weaker trust model than the WS transport: "public" here only
      // means "returned by list()", not "guessable" — the actual authority check is the
      // customData.serverPeerId verification every client performs after list()+join().
      public: true,
      canUpdateBy: 'creator',
      customData: { app: LOBBY_APP_MARKER, serverPeerId: network.id },
    });
    if (code) return code;
    logError(`[netlib] create() attempt ${i + 1}/${attempts} failed, retrying shortly`);
    await new Promise((r) => setTimeout(r, 1000 * (i + 1)));
  }
  throw new Error('netlib: could not create a lobby after retries — refusing to start without one');
}

module.exports = {
  startNetlibListener,
  NetlibPeerSocket,
  LOBBY_APP_MARKER,
  PING_CONTROL_MESSAGE,
  PONG_CONTROL_MESSAGE,
};
