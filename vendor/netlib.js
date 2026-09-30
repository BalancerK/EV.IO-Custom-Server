var $c9i1M$eventemitter3 = require("eventemitter3");


function $parcel$export(e, n, v, s) {
  Object.defineProperty(e, n, {get: v, set: s, enumerable: true, configurable: true});
}

$parcel$export(module.exports, "DefaultSignalingURL", function () { return $87208ee2395edd08$export$f26023e62b577463; });
$parcel$export(module.exports, "DefaultRTCConfiguration", function () { return $87208ee2395edd08$export$34c0e73c967be630; });
$parcel$export(module.exports, "DefaultDataChannels", function () { return $87208ee2395edd08$export$3e03293f7176f9b3; });
$parcel$export(module.exports, "Network", function () { return $a3e583e87a964a6f$export$2e2bcd8739ae039; });
$parcel$export(module.exports, "JSONSerializer", function () { return $a88694565587cf7b$export$8e8b45f0c4469ff5; });
$parcel$export(module.exports, "JSONTag", function () { return $a88694565587cf7b$export$f51b3a85b0eb2345; });
const $21698a8a5c043574$var$FetchTimeout = 5000;
const $21698a8a5c043574$export$3be8bbe0727053e5 = 'turn:turn.rtc.poki.com';
class $21698a8a5c043574$export$2e2bcd8739ae039 {
    signaling;
    cachedCredentials;
    cachedCredentialsExpireAt;
    runningPromise;
    constructor(signaling){
        this.signaling = signaling;
        this.cachedCredentialsExpireAt = 0;
    }
    async fillCredentials(config) {
        const cloned = JSON.parse(JSON.stringify(config));
        if (process.env.NODE_ENV === 'test') return cloned;
        if (config.testproxyURL !== undefined) return cloned;
        const hasPokiTurn = cloned.iceServers?.some((s)=>s.urls === $21698a8a5c043574$export$3be8bbe0727053e5 || s.urls.includes($21698a8a5c043574$export$3be8bbe0727053e5)) ?? false;
        if (!hasPokiTurn || cloned.iceServers === undefined) return cloned;
        if (this.runningPromise === undefined) this.runningPromise = new Promise((resolve)=>{
            if (this.cachedCredentials != null && this.cachedCredentialsExpireAt > performance.now()) {
                resolve(this.cachedCredentials);
                return;
            }
            const timeout = setTimeout(()=>{
                resolve({
                    type: 'credentials'
                });
                this.cachedCredentials = {
                    type: 'credentials'
                };
                this.cachedCredentialsExpireAt = performance.now() + $21698a8a5c043574$var$FetchTimeout;
            }, $21698a8a5c043574$var$FetchTimeout);
            this.signaling.request({
                type: 'credentials'
            }).then((credentials)=>{
                if (credentials.type === 'credentials') {
                    this.cachedCredentials = credentials;
                    this.cachedCredentialsExpireAt = performance.now() + ((credentials.lifetime ?? 0) - 60) * 1000;
                    clearTimeout(timeout);
                    resolve(credentials);
                }
            }).catch(()=>{
                clearTimeout(timeout);
                resolve({
                    type: 'credentials'
                });
                this.cachedCredentials = {
                    type: 'credentials'
                };
                this.cachedCredentialsExpireAt = performance.now() + $21698a8a5c043574$var$FetchTimeout;
            });
        });
        const credentials = await this.runningPromise;
        this.runningPromise = undefined;
        if (credentials.url === undefined) return cloned;
        cloned.iceServers.forEach((s)=>{
            if (s.urls === $21698a8a5c043574$export$3be8bbe0727053e5 || s.urls.includes($21698a8a5c043574$export$3be8bbe0727053e5)) {
                s.urls = credentials.url ?? '';
                s.username = credentials.username;
                s.credential = credentials.credential;
            }
        });
        return cloned;
    }
}





var $faf6d36f88cf8140$exports = {};
$faf6d36f88cf8140$exports = JSON.parse("{\"name\":\"@poki/netlib\",\"version\":\"0.0.20\",\"license\":\"ISC\",\"source\":\"lib/index.ts\",\"main\":\"dist/netlib.js\",\"types\":\"dist/index.d.ts\",\"legacy\":\"dist/legacy.js\",\"sideEffects\":[\"lib/legacy.ts\"],\"targets\":{\"types\":{\"source\":\"lib/index.ts\"},\"main\":{\"source\":\"lib/index.ts\"},\"legacy\":{\"source\":\"lib/legacy.ts\",\"context\":\"browser\",\"outputFormat\":\"global\",\"engines\":{\"browsers\":\"supports es6-module\"},\"includeNodeModules\":true}},\"files\":[\"dist/*\"],\"scripts\":{\"prepare\":\"yarn build\",\"build\":\"parcel build\",\"lint\":\"ts-standard --fix\",\"cucumber\":\"cucumber-js --require 'features/support/**/*.ts' --require-module ts-node/register --order random --retry 2 --retry-tag-filter flakey\",\"watch\":\"parcel --no-hmr example/index.html\"},\"dependencies\":{\"eventemitter3\":\"^5.0.4\"},\"devDependencies\":{\"@cucumber/cucumber\":\"^13.0.0\",\"@parcel/packager-ts\":\"^2.16.4\",\"@parcel/transformer-typescript-types\":\"^2.16.4\",\"@roamhq/wrtc\":\"^0.10.0\",\"@types/node-fetch\":\"^2.6.11\",\"@types/ws\":\"^8.18.1\",\"node-fetch\":\"=2.7.0\",\"parcel\":\"^2.16.4\",\"ts-node\":\"^10.9.2\",\"ts-standard\":\"^12.0.2\",\"typescript\":\"^6.0.3\",\"ws\":\"^8.21.0\"},\"engines\":{\"node\":\">=14\"},\"browserslist\":[\"defaults\",\"not IE 11\"],\"packageManager\":\"yarn@1.22.19+sha1.4ba7fc5c6e704fce2066ecbfb0b0d8976fe62447\"}");


class $9f9f06bbd862f032$export$2e2bcd8739ae039 extends (0, $c9i1M$eventemitter3.EventEmitter) {
    network;
    url;
    ws;
    reconnectAttempt;
    reconnecting;
    receivedID;
    receivedSecret;
    currentLobby;
    currentLobbyInfo;
    currentLeader;
    currentTerm;
    connections;
    replayQueue;
    requests;
    pingInterval;
    messageQueue;
    constructor(network, peers, url){
        super(), this.network = network, this.reconnectAttempt = 0, this.reconnecting = false, this.currentTerm = 0, this.requests = new Map(), this.messageQueue = Promise.resolve();
        this.url = url;
        this.connections = peers;
        this.replayQueue = new Map();
        this.ws = this.connect();
        // Send a ping every 5 seconds to keep the connection alive,
        // and to detect when the connection is lost.
        this.pingInterval = setInterval(()=>{
            this.ping();
        }, 5000);
    }
    connect() {
        const ws = new WebSocket(this.url);
        const onOpen = ()=>{
            this.reconnectAttempt = 0;
            this.reconnecting = false;
            this.send({
                type: 'hello',
                game: this.network.gameID,
                id: this.receivedID,
                secret: this.receivedSecret,
                version: $faf6d36f88cf8140$exports.version
            });
        };
        const onError = (e)=>{
            const error = new $9f9f06bbd862f032$export$4299251c42ef608f('socket-error', 'unexpected websocket error', e);
            this.network._onSignalingError(error);
            if (ws.readyState === WebSocket.CLOSED) {
                this.reconnecting = false;
                ws.removeEventListener('open', onOpen);
                ws.removeEventListener('error', onError);
                ws.removeEventListener('message', onMessage);
                ws.removeEventListener('close', onClose);
                // Don't try to reconnect too quickly, give the server a chance
                // to store our disconnection in the db, so when we reconnect
                // it recognizes us.
                setTimeout(()=>{
                    this.reconnect();
                }, 100);
            }
        };
        const onMessage = (ev)=>this.enqueueSignalingMessage(ev.data);
        const onClose = ()=>{
            if (!this.network.closing) {
                const error = new $9f9f06bbd862f032$export$4299251c42ef608f('socket-error', 'signaling socket closed');
                this.network._onSignalingError(error);
            }
            ws.removeEventListener('open', onOpen);
            ws.removeEventListener('error', onError);
            ws.removeEventListener('message', onMessage);
            ws.removeEventListener('close', onClose);
            // Don't try to reconnect too quickly, give the server a chance
            // to store our disconnection in the db, so when we reconnect
            // it recognizes us.
            setTimeout(()=>{
                this.reconnect();
            }, 100);
        };
        ws.addEventListener('open', onOpen);
        ws.addEventListener('error', onError);
        ws.addEventListener('message', onMessage);
        ws.addEventListener('close', onClose);
        return ws;
    }
    reconnect() {
        if (this.reconnecting || this.network.closing) return;
        this.close();
        this.requests.forEach((r)=>r.reject(new $9f9f06bbd862f032$export$4299251c42ef608f('socket-error', 'signaling socket closed')));
        this.requests.clear();
        if (this.reconnectAttempt > 42) {
            this.network.emit('failed');
            this.network._onSignalingError(new $9f9f06bbd862f032$export$4299251c42ef608f('socket-error', 'giving up on reconnecting to signaling server'));
            return;
        }
        this.event('signaling', 'attempt-reconnect');
        this.reconnecting = true;
        setTimeout(()=>{
            this.ws = this.connect();
        }, Math.random() * 100 * this.reconnectAttempt);
        this.reconnectAttempt += 1;
    }
    close() {
        if (this.pingInterval !== undefined) {
            clearInterval(this.pingInterval);
            this.pingInterval = undefined;
        }
        this.ws.close();
    }
    async request(packet) {
        return await new Promise((resolve, reject)=>{
            if (this.ws.readyState !== WebSocket.OPEN) {
                reject(new $9f9f06bbd862f032$export$4299251c42ef608f('socket-error', 'signaling socket not open'));
                return;
            }
            const rid = Math.random().toString(36).slice(2);
            packet.rid = rid;
            this.network.log('requesting signaling packet:', packet.type);
            const data = JSON.stringify(packet);
            this.requests.set(rid, {
                resolve: resolve,
                reject: reject,
                type: packet.type
            });
            this.ws.send(data);
        });
    }
    send(packet) {
        if (this.ws.readyState === WebSocket.OPEN) {
            this.network.log('sending signaling packet:', packet.type);
            const data = JSON.stringify(packet);
            this.ws.send(data);
        }
    }
    ping() {
        // Send a ping to the server to keep the connection alive,
        // and to detect when the connection is lost.
        // Sending is enough, we don't need to listen for a pong.
        // Don't use this.send() as we don't need every ping to be logged.
        if (this.ws.readyState === WebSocket.OPEN) {
            const data = JSON.stringify({
                type: 'ping'
            });
            this.ws.send(data);
        }
    }
    enqueueSignalingMessage(data) {
        const packet = this.parseSignalingPacket(data);
        if (packet == null) return;
        this.resolveImmediateRequest(packet);
        const handle = this.handleSignalingMessage.bind(this, packet);
        this.messageQueue = this.messageQueue.then(handle, handle);
        this.messageQueue.catch((_)=>{});
    }
    parseSignalingPacket(data) {
        try {
            const packet = JSON.parse(data);
            this.network.log('signaling packet received:', packet.type);
            return packet;
        } catch (e) {
            const error = new $9f9f06bbd862f032$export$4299251c42ef608f('unknown-error', e);
            this.network._onSignalingError(error);
        }
    }
    resolveImmediateRequest(packet) {
        if (packet.rid === undefined) return;
        const request = this.requests.get(packet.rid);
        // Only credential responses can resolve immediately: _addPeer waits for them
        // while handling a queued connect packet, so queueing them would deadlock.
        if (request?.type !== 'credentials') return;
        this.requests.delete(packet.rid);
        this.resolveRequest(packet, request);
    }
    resolveRequest(packet, request) {
        if (packet.type === 'error') request.reject(new $9f9f06bbd862f032$export$4299251c42ef608f('server-error', packet.message, undefined, packet.code));
        else request.resolve(packet);
    }
    async handleSignalingMessage(packet) {
        try {
            if (packet.rid !== undefined) {
                const request = this.requests.get(packet.rid);
                if (request != null) {
                    this.requests.delete(packet.rid);
                    this.resolveRequest(packet, request);
                }
            }
            switch(packet.type){
                case 'error':
                    {
                        const error = new $9f9f06bbd862f032$export$4299251c42ef608f('server-error', packet.message, undefined, packet.code);
                        this.network._onSignalingError(error);
                        if (packet.code === 'missing-recipient' && packet.error?.recipient !== undefined) {
                            const id = packet.error?.recipient;
                            if (this.connections.has(id)) {
                                this.network.log('cleaning up missing recipient', id);
                                this.connections.get(id)?.close('missing-recipient');
                            }
                        } else if (packet.code === 'reconnect-failed') this.network.close('reconnect failed');
                    }
                    break;
                case 'welcome':
                    if (this.receivedID !== undefined) {
                        this.network.log('signaling reconnected');
                        this.network.emit('signalingreconnected');
                        return;
                    }
                    if (packet.id === '') throw new Error('missing id on received welcome packet');
                    this.receivedID = packet.id;
                    this.receivedSecret = packet.secret;
                    this.network.emit('ready');
                    this.network._prefetchTURNCredentials();
                    break;
                case 'joined':
                    {
                        const code = packet.lobbyInfo.code;
                        if (code === '') throw new Error('missing lobby on received connect packet');
                        this.currentLobby = code;
                        this.currentLeader = packet.lobbyInfo.leader;
                        this.currentTerm = packet.lobbyInfo.term;
                        this.network.emit('lobby', code, packet.lobbyInfo);
                        if (this.currentLeader !== undefined) this.network.emit('leader', this.currentLeader);
                    }
                    break;
                case 'leader':
                    if (this.currentLobby === undefined) // We're not in a lobby, ignore leader packets.
                    return;
                    if (packet.term > this.currentTerm) {
                        this.currentLeader = packet.leader;
                        this.currentTerm = packet.term;
                        this.network.emit('leader', packet.leader);
                    }
                    break;
                case 'lobbyUpdated':
                    if (this.currentLobby === undefined) // We're not in a lobby, ignore updated packets.
                    return;
                    this.currentLobbyInfo = packet.lobbyInfo;
                    this.network.emit('lobbyUpdated', packet.lobbyInfo.code, packet.lobbyInfo);
                    break;
                case 'left':
                    this.currentLobby = undefined;
                    this.currentLeader = undefined;
                    this.currentLobbyInfo = undefined;
                    this.network.emit('left');
                    break;
                case 'connect':
                    if (this.receivedID === packet.id) return; // Skip self
                    await this.network._addPeer(packet.id, packet.polite);
                    for (const p of this.replayQueue.get(packet.id) ?? [])await this.connections.get(packet.id)?._onSignalingMessage(p);
                    this.replayQueue.delete(packet.id);
                    break;
                case 'disconnect':
                    if (this.connections.has(packet.id)) this.connections.get(packet.id)?.close();
                    break;
                case 'candidate':
                case 'description':
                    if (this.connections.has(packet.source)) await this.connections.get(packet.source)?._onSignalingMessage(packet);
                    else {
                        const queue = this.replayQueue.get(packet.source) ?? [];
                        queue.push(packet);
                        this.replayQueue.set(packet.source, queue);
                    }
                    break;
                case 'credentials':
                    this.emit('credentials', packet);
                    break;
                case 'ping':
                    break;
            }
        } catch (e) {
            const error = new $9f9f06bbd862f032$export$4299251c42ef608f('unknown-error', e);
            this.network._onSignalingError(error);
        }
    }
    async event(category, action, data) {
        return await new Promise((resolve)=>{
            setTimeout(()=>{
                this.send({
                    type: 'event',
                    game: this.network.gameID,
                    lobby: this.currentLobby,
                    peer: this.network.id,
                    category: category,
                    action: action,
                    data: data
                });
                resolve();
            }, 0);
        });
    }
}
class $9f9f06bbd862f032$export$4299251c42ef608f {
    type;
    message;
    event;
    code;
    /**
   * @internal
   */ constructor(type, message, event, code){
        this.type = type;
        this.message = message;
        this.event = event;
        this.code = code;
    }
    toString() {
        return `[${this.type}: ${this.message}]`;
    }
}



const $dad8d976b416fafe$var$PingInterval = 500;
const $dad8d976b416fafe$var$WindowSampleSize = 50;
const $dad8d976b416fafe$var$PING = 'ping';
const $dad8d976b416fafe$var$PONG = 'pong';
class $dad8d976b416fafe$export$2e2bcd8739ae039 {
    peer;
    control;
    window;
    lastPingSentAt;
    last;
    average;
    jitter;
    max;
    min;
    /**
   * @internal
   */ constructor(peer, control){
        this.peer = peer;
        this.control = control;
        this.window = [];
        this.lastPingSentAt = 0;
        this.last = 0;
        this.average = 0;
        this.jitter = 0;
        this.max = 0;
        this.min = 0;
        if (control !== undefined) {
            this.ping();
            control.addEventListener('message', (e)=>this.onMessage(e.data));
        }
    }
    ping() {
        this.lastPingSentAt = performance.now();
        if (this.control?.readyState === 'open') this.control?.send($dad8d976b416fafe$var$PING);
    }
    onMessage(data) {
        if (data === $dad8d976b416fafe$var$PING) {
            if (this.control?.readyState === 'open') this.control?.send($dad8d976b416fafe$var$PONG);
            return;
        }
        if (data !== $dad8d976b416fafe$var$PONG) return;
        const now = performance.now();
        const delta = now - this.lastPingSentAt;
        this.window.unshift(delta);
        if (this.window.length > $dad8d976b416fafe$var$WindowSampleSize) this.window.pop();
        this.last = delta;
        this.max = Math.max(...this.window);
        this.min = Math.min(...this.window);
        this.average = this.window.reduce((a, b)=>a + b, 0) / this.window.length;
        if (this.window.length > 1) this.jitter = this.window.slice(1).map((x, i)=>Math.abs(x - this.window[i])).reduce((a, b)=>a + b, 0) / (this.window.length - 1);
        setTimeout(()=>this.ping(), Math.max($dad8d976b416fafe$var$PingInterval - delta, 0));
    }
}


/**
 * A Serializer converts an arbitrary JSON-compatible value to bytes and back.
 *
 * The default ({@link JSONSerializer}) is zero-dependency and UTF-8 encodes
 * `JSON.stringify`. It does NOT make messages smaller than a plain JSON string;
 * to actually compact the wire format, plug in a binary serializer such as
 * `@msgpack/msgpack`:
 *
 * ```ts
 * import { encode, decode } from '@msgpack/msgpack'
 * network.serializer = { encode, decode }
 * ```
 */ const $a88694565587cf7b$export$f51b3a85b0eb2345 = 0x01;
const $a88694565587cf7b$var$textEncoder = new TextEncoder();
const $a88694565587cf7b$var$textDecoder = new TextDecoder();
const $a88694565587cf7b$export$8e8b45f0c4469ff5 = {
    encode: (data)=>$a88694565587cf7b$var$textEncoder.encode(JSON.stringify(data)),
    decode: (bytes)=>JSON.parse($a88694565587cf7b$var$textDecoder.decode(bytes))
};


/**
 * Automatic, zero-config binary serialization.
 *
 * Object key *shapes* are interned into small ids that are synchronised in-band:
 * the first message of a given shape is sent self-describing (keys + an id,
 * tag {@link TagDefine}); every later message of that shape is sent as just
 * `id + values` (tag {@link TagUse}), dropping the repeated field names that
 * dominate the size of game packets. Leaf values carry a one-byte type marker,
 * so a field that changes type between messages never corrupts.
 *
 * Synchronisation is loss-tolerant: a sender keeps emitting the self-describing
 * DEFINE form until the receiver acknowledges the shape (see
 * {@link AutoSchema.ackFrame}), then switches to the compact form. A DEFINE is
 * always decodable on its own, so a dropped ack only delays compaction — it
 * never produces an undecodable message.
 */ // Wire tags (share the data-channel tag-byte namespace; 0x01 = sendJSON serializer).
const $af056c401e7b5e07$export$397d96f1c2cacc7c = 0x04 // auto: array/primitive fallback
;
const $af056c401e7b5e07$export$ceb4fb331af35378 = 0x02 // auto: first sight of a shape
;
const $af056c401e7b5e07$export$715f400a5f833b0e = 0x03 // auto: compact, shape already synced
;
const $af056c401e7b5e07$export$abaa404cc7bbc9ad = 0xa0;
// Value type markers.
const $af056c401e7b5e07$var$TNull = 0;
const $af056c401e7b5e07$var$TFalse = 1;
const $af056c401e7b5e07$var$TTrue = 2;
const $af056c401e7b5e07$var$TInt = 3;
const $af056c401e7b5e07$var$TFloat = 4;
const $af056c401e7b5e07$var$TStr = 5;
const $af056c401e7b5e07$var$TArr = 6;
const $af056c401e7b5e07$var$TObj = 7;
const $af056c401e7b5e07$var$TOArr = 8 // homogeneous array of same-shape objects: keys written once
;
const $af056c401e7b5e07$var$textEncoder = new TextEncoder();
const $af056c401e7b5e07$var$textDecoder = new TextDecoder();
class $af056c401e7b5e07$var$Writer {
    bytes = [];
    u8(v) {
        this.bytes.push(v & 0xff);
    }
    varuint(v) {
        v = v >>> 0;
        while(v >= 0x80){
            this.bytes.push(v & 0x7f | 0x80);
            v >>>= 7;
        }
        this.bytes.push(v);
    }
    varint(v) {
        this.varuint((v << 1 ^ v >> 31) >>> 0);
    }
    f64(v) {
        const b = new Uint8Array(8);
        new DataView(b.buffer).setFloat64(0, v);
        for (const x of b)this.bytes.push(x);
    }
    str(s) {
        const u = $af056c401e7b5e07$var$textEncoder.encode(s);
        this.varuint(u.length);
        for (const x of u)this.bytes.push(x);
    }
    out() {
        return new Uint8Array(this.bytes);
    }
}
class $af056c401e7b5e07$var$Reader {
    i = 0;
    u8;
    constructor(u8){
        this.u8 = u8;
    }
    byte() {
        return this.u8[this.i++];
    }
    varuint() {
        let r = 0;
        let s = 0;
        let b;
        do {
            b = this.u8[this.i++];
            r |= (b & 0x7f) << s;
            s += 7;
        }while ((b & 0x80) !== 0);
        return r >>> 0;
    }
    varint() {
        const u = this.varuint();
        return u >>> 1 ^ -(u & 1);
    }
    f64() {
        const v = new DataView(this.u8.buffer, this.u8.byteOffset + this.i, 8).getFloat64(0);
        this.i += 8;
        return v;
    }
    str() {
        const n = this.varuint();
        const s = $af056c401e7b5e07$var$textDecoder.decode(this.u8.subarray(this.i, this.i + n));
        this.i += n;
        return s;
    }
}
// Returns the shared key list iff every element is a plain object with the same
// keys in the same order; otherwise null (the array uses the generic path).
function $af056c401e7b5e07$var$homogeneousKeys(arr) {
    if (arr.length === 0) return null;
    const first = arr[0];
    if (first === null || typeof first !== 'object' || Array.isArray(first)) return null;
    const keys = Object.keys(first);
    const sig = keys.join(' ');
    for (const el of arr){
        if (el === null || typeof el !== 'object' || Array.isArray(el)) return null;
        if (Object.keys(el).join(' ') !== sig) return null;
    }
    return keys;
}
function $af056c401e7b5e07$var$writeAny(w, v) {
    if (v === null || v === undefined) {
        w.u8($af056c401e7b5e07$var$TNull);
        return;
    }
    switch(typeof v){
        case 'boolean':
            w.u8(v ? $af056c401e7b5e07$var$TTrue : $af056c401e7b5e07$var$TFalse);
            return;
        case 'number':
            if (Number.isInteger(v) && Math.abs(v) < 0x40000000) {
                w.u8($af056c401e7b5e07$var$TInt);
                w.varint(v);
            } else {
                w.u8($af056c401e7b5e07$var$TFloat);
                w.f64(v);
            }
            return;
        case 'string':
            w.u8($af056c401e7b5e07$var$TStr);
            w.str(v);
            return;
        case 'object':
            {
                if (Array.isArray(v)) {
                    const keys = $af056c401e7b5e07$var$homogeneousKeys(v);
                    if (keys !== null) {
                        // Object-array: write the shared keys once, then values per element.
                        w.u8($af056c401e7b5e07$var$TOArr);
                        w.varuint(keys.length);
                        for (const k of keys)w.str(k);
                        w.varuint(v.length);
                        for (const el of v){
                            const o = el;
                            for (const k of keys)$af056c401e7b5e07$var$writeAny(w, o[k]);
                        }
                        return;
                    }
                    w.u8($af056c401e7b5e07$var$TArr);
                    w.varuint(v.length);
                    for (const e of v)$af056c401e7b5e07$var$writeAny(w, e);
                    return;
                }
                w.u8($af056c401e7b5e07$var$TObj);
                const keys = Object.keys(v);
                w.varuint(keys.length);
                for (const k of keys){
                    w.str(k);
                    $af056c401e7b5e07$var$writeAny(w, v[k]);
                }
                return;
            }
        default:
            w.u8($af056c401e7b5e07$var$TNull);
    }
}
function $af056c401e7b5e07$var$readAny(r) {
    const t = r.byte();
    switch(t){
        case $af056c401e7b5e07$var$TNull:
            return null;
        case $af056c401e7b5e07$var$TFalse:
            return false;
        case $af056c401e7b5e07$var$TTrue:
            return true;
        case $af056c401e7b5e07$var$TInt:
            return r.varint();
        case $af056c401e7b5e07$var$TFloat:
            return r.f64();
        case $af056c401e7b5e07$var$TStr:
            return r.str();
        case $af056c401e7b5e07$var$TArr:
            {
                const n = r.varuint();
                const a = [];
                for(let i = 0; i < n; i++)a.push($af056c401e7b5e07$var$readAny(r));
                return a;
            }
        case $af056c401e7b5e07$var$TObj:
            {
                const n = r.varuint();
                const o = {};
                for(let i = 0; i < n; i++){
                    const k = r.str();
                    o[k] = $af056c401e7b5e07$var$readAny(r);
                }
                return o;
            }
        case $af056c401e7b5e07$var$TOArr:
            {
                const nk = r.varuint();
                const keys = [];
                for(let i = 0; i < nk; i++)keys.push(r.str());
                const n = r.varuint();
                const a = [];
                for(let i = 0; i < n; i++){
                    const o = {};
                    for (const k of keys)o[k] = $af056c401e7b5e07$var$readAny(r);
                    a.push(o);
                }
                return a;
            }
        default:
            throw new Error(`autoschema: unknown value tag ${t}`);
    }
}
// Only plain objects are interned; arrays/primitives use the schemaless fallback.
function $af056c401e7b5e07$var$shapeKeys(obj) {
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return Object.keys(obj);
}
class $af056c401e7b5e07$export$2e2bcd8739ae039 {
    outBySig = new Map();
    outById = new Map();
    inById = new Map();
    nextId = 16 // leave 0x00–0x0f as reserved tag space; ids are monotonic (never reused)
    ;
    maxShapes;
    /**
   * @param maxShapes Upper bound on distinct interned shapes kept per direction.
   * When exceeded, the least-recently-used shape is evicted (LRU). Because ids
   * are never reused, an evicted shape that recurs is simply re-defined under a
   * new id — a USE referencing an evicted id can only ever be that same dropped
   * shape, so it is safely discarded by the decoder, never mis-decoded.
   */ constructor(maxShapes = 256){
        this.maxShapes = maxShapes;
    }
    /** Encode a JSON-compatible value to a tagged binary frame. */ encode(data) {
        const keys = $af056c401e7b5e07$var$shapeKeys(data);
        const w = new $af056c401e7b5e07$var$Writer();
        if (keys === null) {
            w.u8($af056c401e7b5e07$export$397d96f1c2cacc7c);
            $af056c401e7b5e07$var$writeAny(w, data);
            return w.out();
        }
        const sig = keys.join(' ');
        let entry = this.outBySig.get(sig);
        if (entry !== undefined) {
            this.outBySig.delete(sig);
            this.outBySig.set(sig, entry) // touch (move to most-recent)
            ;
        } else {
            entry = {
                id: this.nextId++,
                acked: false
            };
            this.outBySig.set(sig, entry);
            this.outById.set(entry.id, entry);
            if (this.outBySig.size > this.maxShapes) {
                const oldestSig = this.outBySig.keys().next().value;
                const oldest = this.outBySig.get(oldestSig);
                this.outBySig.delete(oldestSig);
                if (oldest !== undefined) this.outById.delete(oldest.id);
            }
        }
        const obj = data;
        if (!entry.acked) {
            w.u8($af056c401e7b5e07$export$ceb4fb331af35378);
            w.varuint(entry.id);
            w.varuint(keys.length);
            for (const k of keys)w.str(k);
            for (const k of keys)$af056c401e7b5e07$var$writeAny(w, obj[k]);
        } else {
            w.u8($af056c401e7b5e07$export$715f400a5f833b0e);
            w.varuint(entry.id);
            for (const k of keys)$af056c401e7b5e07$var$writeAny(w, obj[k]);
        }
        return w.out();
    }
    /**
   * Decode a tagged binary frame. When `ackId` is non-null the caller should
   * send {@link ackFrame}(ackId) back over the control channel so the sender
   * can switch this shape to the compact form.
   */ decode(u8) {
        const r = new $af056c401e7b5e07$var$Reader(u8);
        const tag = r.byte();
        if (tag === $af056c401e7b5e07$export$397d96f1c2cacc7c) return {
            value: $af056c401e7b5e07$var$readAny(r),
            ackId: null
        };
        if (tag === $af056c401e7b5e07$export$ceb4fb331af35378) {
            const id = r.varuint();
            const n = r.varuint();
            const keys = [];
            for(let i = 0; i < n; i++)keys.push(r.str());
            if (this.inById.has(id)) this.inById.delete(id);
            this.inById.set(id, keys) // most-recent
            ;
            if (this.inById.size > this.maxShapes) {
                const oldestId = this.inById.keys().next().value;
                this.inById.delete(oldestId);
            }
            const o = {};
            for (const k of keys)o[k] = $af056c401e7b5e07$var$readAny(r);
            return {
                value: o,
                ackId: id
            };
        }
        if (tag === $af056c401e7b5e07$export$715f400a5f833b0e) {
            const id = r.varuint();
            const keys = this.inById.get(id);
            if (keys === undefined) throw new Error(`autoschema: unknown schema id ${id}`);
            this.inById.delete(id);
            this.inById.set(id, keys) // touch (move to most-recent)
            ;
            const o = {};
            for (const k of keys)o[k] = $af056c401e7b5e07$var$readAny(r);
            return {
                value: o,
                ackId: null
            };
        }
        throw new Error(`autoschema: unknown frame tag ${tag}`);
    }
    /** True if `u8` is an ack frame (received on the control channel). */ static isAck(u8) {
        return u8.length >= 1 && u8[0] === $af056c401e7b5e07$export$abaa404cc7bbc9ad;
    }
    /** Build an ack frame for a freshly-defined schema id. */ static ackFrame(id) {
        const w = new $af056c401e7b5e07$var$Writer();
        w.u8($af056c401e7b5e07$export$abaa404cc7bbc9ad);
        w.varuint(id);
        return w.out();
    }
    /** Mark the shape behind an acked id as compact-ready. */ applyAck(u8) {
        const r = new $af056c401e7b5e07$var$Reader(u8);
        r.byte() // TagAck
        ;
        const id = r.varuint();
        const entry = this.outById.get(id);
        if (entry !== undefined) entry.acked = true;
    }
}


const $95761353b7ef8987$var$LatencyRestartIceThreshold = 1000 // ms
;
const $95761353b7ef8987$var$ReconnectionWindow = 8000 // ms
;
const $95761353b7ef8987$var$LatencyReportIntervals = [
    10,
    25,
    50,
    75,
    100
];
// Upstream's own two call sites below already knew exactly which description to build (offer vs.
// answer) — they just gated that correct code behind `NODE_ENV === 'test'`, so a real Node
// deployment (NODE_ENV unset or 'production') took the zero-argument `setLocalDescription()`
// path instead. That path only works in a real browser: it relies on the modern WebRTC spec
// feature where the browser infers offer-vs-answer from the current signaling state when no
// argument is given. @roamhq/wrtc's RTCPeerConnection (our own Node polyfill; see
// node_modules/@roamhq/wrtc/lib/peerconnection.js) forwards the argument as-is to its native
// binding with no such inference — calling it with `undefined` throws "Expected an object".
// Detecting the Node runtime itself (rather than NODE_ENV) means this fix also applies outside
// tests, which is exactly where our signaling server hit it live (see VENDORED.md).
//
// Written as a function reading `globalThis['process']` through a computed key, evaluated at
// call time — NOT the more obvious `typeof process !== 'undefined'` top-level const. Parcel
// statically constant-folds that exact idiom to `false` for this bundle (it's the standard
// isomorphic-library "eliminate the Node-only branch for a browser build" optimization), which
// silently broke this fix at build time on the first attempt: the source had the right check,
// the shipped dist/netlib.js had `const isNodeRuntime = false` baked in. Verify after any
// rebuild that this hasn't regressed (search dist/netlib.js for a literal `= false` next to this
// function's compiled name — see netlib-vendor/VENDORED.md).
function $95761353b7ef8987$var$isNodeRuntime() {
    try {
        const proc = globalThis.process;
        return typeof proc === 'object' && proc !== null && typeof proc.versions === 'object' && proc.versions !== null && typeof proc.versions?.node === 'string';
    } catch  {
        return false;
    }
}
class $95761353b7ef8987$export$2e2bcd8739ae039 {
    network;
    signaling;
    id;
    config;
    polite;
    conn;
    // Signaling state:
    makingOffer;
    ignoreOffer;
    isSettingRemoteAnswerPending;
    pendingRemoteCandidates;
    // Connection state:
    opened;
    closing;
    reconnecting;
    abortReconnectionAt;
    allowNextManualRestartIceAt;
    latency;
    lastMessageReceivedAt;
    autoSchema;
    politenessTimeout;
    reportLatencyEventTimeouts;
    checkStateInterval;
    channels;
    testSessionWrapper;
    /**
   * @internal
   */ constructor(network, signaling, id, config, polite){
        this.network = network;
        this.signaling = signaling;
        this.id = id;
        this.config = config;
        this.polite = polite;
        this.makingOffer = false;
        this.ignoreOffer = false;
        this.isSettingRemoteAnswerPending = false;
        this.pendingRemoteCandidates = [];
        this.opened = false;
        this.closing = false;
        this.reconnecting = false;
        this.abortReconnectionAt = 0;
        this.allowNextManualRestartIceAt = 0;
        this.latency = new (0, $dad8d976b416fafe$export$2e2bcd8739ae039)(this);
        this.lastMessageReceivedAt = 0;
        this.autoSchema = new (0, $af056c401e7b5e07$export$2e2bcd8739ae039)();
        this.reportLatencyEventTimeouts = [];
        this.channels = {};
        this.network.log('creating peer');
        this.testSessionWrapper = undefined;
        this.conn = new RTCPeerConnection(config);
        if (config.testproxyURL === undefined) this.conn.addEventListener('icecandidate', (e)=>{
            const candidate = e.candidate;
            if (candidate !== null) signaling.send({
                type: 'candidate',
                source: this.network.id,
                recipient: this.id,
                candidate: candidate
            });
        });
        else this.testSessionWrapper = $95761353b7ef8987$var$wrapSessionDescription;
        this.conn.addEventListener('negotiationneeded', ()=>{
            this.politenessTimeout = setTimeout(()=>{
                this.handleNegotiationNeeded();
            }, this.polite ? 100 : 0);
        });
        this.checkStateInterval = setInterval(()=>{
            this.checkState();
        }, 500);
        this.conn.addEventListener('signalingstatechange', ()=>this.checkState());
        this.conn.addEventListener('connectionstatechange', ()=>this.checkState());
        this.conn.addEventListener('iceconnectionstatechange', ()=>this.checkState());
        this.network.emit('connecting', this);
        let i = 0;
        for(const label in this.network.dataChannels){
            const chan = this.conn.createDataChannel(label, {
                ...this.network.dataChannels[label],
                id: i++,
                negotiated: true
            });
            chan.binaryType = 'arraybuffer';
            chan.addEventListener('error', (e)=>this.onError(e));
            chan.addEventListener('closing', ()=>this.checkState());
            chan.addEventListener('close', ()=>this.checkState());
            chan.addEventListener('open', ()=>{
                if (!this.opened && !Object.values(this.channels).some((c)=>c.readyState !== 'open')) {
                    if ('control' in this.channels) this.latency = new (0, $dad8d976b416fafe$export$2e2bcd8739ae039)(this, this.channels.control);
                    if (this.politenessTimeout !== undefined) clearTimeout(this.politenessTimeout);
                    this.signaling.send({
                        type: 'connected',
                        id: this.id
                    });
                    this.opened = true;
                    this.network.emit('connected', this);
                    this.signaling.event('rtc', 'connected', {
                        target: this.id
                    });
                    for (const seconds of $95761353b7ef8987$var$LatencyReportIntervals)this.reportLatencyEventTimeouts.push(setTimeout(()=>{
                        this.signaling.event('rtc', `avg-latency-at-${seconds}s`, {
                            target: this.id,
                            latency: `${this.latency.average}`
                        });
                    }, seconds * 1000));
                }
            });
            chan.addEventListener('message', (e)=>{
                this.lastMessageReceivedAt = performance.now();
                if (label === 'control') {
                    // Auto-schema acks ride the reliable control channel; let Latency
                    // handle everything else (ping/pong).
                    if (e.data instanceof ArrayBuffer) {
                        const bytes = new Uint8Array(e.data);
                        if ((0, $af056c401e7b5e07$export$2e2bcd8739ae039).isAck(bytes)) this.autoSchema.applyAck(bytes);
                    }
                    return;
                }
                let data = e.data;
                // Decode tagged binary frames by their leading byte; untagged data is
                // passed through raw, exactly as send()/broadcast() delivered it.
                if (data instanceof ArrayBuffer) {
                    const bytes = new Uint8Array(data);
                    const tag = bytes.length > 0 ? bytes[0] : -1;
                    if (tag === (0, $a88694565587cf7b$export$f51b3a85b0eb2345)) // sendJSON(): serializer-encoded value.
                    try {
                        data = this.network.serializer.decode(bytes.subarray(1));
                    } catch (err) {
                        this.network.log('failed to decode tagged message', err);
                    }
                    else if (tag === (0, $af056c401e7b5e07$export$ceb4fb331af35378) || tag === (0, $af056c401e7b5e07$export$715f400a5f833b0e) || tag === (0, $af056c401e7b5e07$export$397d96f1c2cacc7c)) // sendAuto(): self-synchronising schema dictionary.
                    try {
                        const { value: value, ackId: ackId } = this.autoSchema.decode(bytes);
                        data = value;
                        const control = this.channels.control;
                        if (ackId !== null && control?.readyState === 'open') control.send((0, $af056c401e7b5e07$export$2e2bcd8739ae039).ackFrame(ackId));
                    } catch (err) {
                        this.network.log('failed to decode auto-schema message', err);
                    }
                }
                this.network.emit('message', this, label, data);
            });
            this.channels[label] = chan;
        }
    }
    close(reason) {
        if (this.closing) return;
        this.closing = true;
        // Inform signaling server that the peer has been disconnected:
        this.signaling.send({
            type: 'disconnected',
            id: this.id,
            reason: reason ?? 'normal closure'
        });
        Object.values(this.channels).forEach((c)=>c.close());
        this.conn.close();
        this.network._removePeer(this);
        if (this.checkStateInterval != null) clearInterval(this.checkStateInterval);
        for (const reportLatencyEventTimeout of this.reportLatencyEventTimeouts)clearTimeout(reportLatencyEventTimeout);
        this.reportLatencyEventTimeouts.length = 0;
        if (this.opened) {
            this.network.emit('disconnected', this);
            this.signaling.event('rtc', 'disconnected', {
                target: this.id,
                reason: reason ?? '',
                reconnecting: this.reconnecting ? 'true' : 'false'
            });
        }
    }
    checkState() {
        const now = performance.now();
        const connectionState = this.conn.connectionState ?? this.conn.iceConnectionState;
        if (this.closing) return;
        if (!this.opened) {
            if (connectionState === 'failed') this.close('connecting failed');
            return;
        }
        if (Object.values(this.channels).some((c)=>c.readyState !== 'open')) this.close('data channel closed');
        // console.log('state', this.id, this.conn.connectionState, this.conn.iceConnectionState, Object.values(this.channels).map(c => c.readyState))
        if (!this.reconnecting && (connectionState === 'disconnected' || connectionState === 'failed')) {
            this.reconnecting = true;
            this.abortReconnectionAt = now + $95761353b7ef8987$var$ReconnectionWindow;
            this.network.emit('reconnecting', this);
            this.signaling.event('rtc', 'attempt-reconnect', {
                target: this.id
            });
        } else if (this.reconnecting && connectionState === 'connected') {
            this.reconnecting = false;
            this.network.emit('reconnected', this);
            this.signaling.event('rtc', 'attempt-reconnected', {
                target: this.id
            });
        } else if (this.reconnecting && now > this.abortReconnectionAt) this.close('reconnection timed out');
        if (!this.reconnecting && 'control' in this.channels) {
            const lastPing = this.lastMessageReceivedAt;
            if (lastPing !== 0) {
                const delta = now - lastPing;
                if (delta > $95761353b7ef8987$var$LatencyRestartIceThreshold && now > this.allowNextManualRestartIceAt) {
                    this.allowNextManualRestartIceAt = now + 10000;
                    this.conn.restartIce();
                }
            }
        }
    }
    async handleNegotiationNeeded() {
        try {
            if (this.closing) return;
            this.makingOffer = true;
            if ($95761353b7ef8987$var$isNodeRuntime()) await this.conn.setLocalDescription(await this.conn.createOffer());
            else await this.conn.setLocalDescription();
            const description = this.conn.localDescription;
            if (description != null) {
                await this.testSessionWrapper?.(description, this.config, this.network.id, this.id);
                this.signaling.send({
                    type: 'description',
                    source: this.network.id,
                    recipient: this.id,
                    description: description
                });
            }
        } catch (e) {
            const error = new (0, $9f9f06bbd862f032$export$4299251c42ef608f)('unknown-error', e);
            this.network._onSignalingError(error);
        } finally{
            this.makingOffer = false;
        }
    }
    onError(e) {
        this.network.emit('rtcerror', e);
        if (this.network.listenerCount('rtcerror') === 0) console.error('rtcerror not handled:', e);
        this.checkState();
        this.signaling.event('rtc', 'error', {
            target: this.id,
            error: JSON.stringify(e)
        });
    }
    async addIceCandidate(candidate) {
        try {
            await this.conn.addIceCandidate(candidate);
        } catch (e) {
            if (!this.ignoreOffer) throw e;
        }
    }
    async drainPendingCandidates() {
        const candidates = this.pendingRemoteCandidates.splice(0);
        for (const candidate of candidates)await this.addIceCandidate(candidate);
    }
    /**
   * @internal
   */ async _onSignalingMessage(packet) {
        switch(packet.type){
            case 'candidate':
                if (packet.candidate != null) {
                    if (this.conn.remoteDescription == null) {
                        if (!this.ignoreOffer) this.pendingRemoteCandidates.push(packet.candidate);
                        return;
                    }
                    await this.addIceCandidate(packet.candidate);
                }
                break;
            case 'description':
                {
                    const { description: description } = packet;
                    const readyForOffer = !this.makingOffer && (this.conn.signalingState === 'stable' || this.isSettingRemoteAnswerPending);
                    const offerCollision = description.type === 'offer' && !readyForOffer;
                    this.ignoreOffer = !this.polite && offerCollision;
                    if (this.ignoreOffer) return;
                    if (description.type === 'answer' && this.conn.signalingState !== 'have-local-offer') {
                        this.network.log('ignoring stale remote answer from', this.id, 'in state', this.conn.signalingState);
                        return;
                    }
                    this.isSettingRemoteAnswerPending = description.type === 'answer';
                    try {
                        await this.conn.setRemoteDescription(description);
                    } finally{
                        this.isSettingRemoteAnswerPending = false;
                    }
                    await this.drainPendingCandidates();
                    if (description.type === 'offer') {
                        if ($95761353b7ef8987$var$isNodeRuntime()) await this.conn.setLocalDescription(await this.conn.createAnswer());
                        else await this.conn.setLocalDescription();
                        const description = this.conn.localDescription;
                        if (description != null) {
                            await this.testSessionWrapper?.(description, this.config, this.network.id, this.id);
                            this.signaling.send({
                                type: 'description',
                                source: this.network.id,
                                recipient: this.id,
                                description: description
                            });
                        }
                    }
                }
                break;
        }
    }
    send(channel, data) {
        if (!(channel in this.channels)) throw new Error('unknown channel ' + channel);
        const chan = this.channels[channel];
        if (chan.readyState === 'open') chan.send(data);
    }
    /**
   * Serialize a JSON-compatible value with the network's serializer, prefix it
   * with {@link JSONTag}, and send it. The receiver auto-decodes it back to the
   * original value before emitting the `message` event.
   */ sendEncoded(channel, data) {
        if (!(channel in this.channels)) throw new Error('unknown channel ' + channel);
        const chan = this.channels[channel];
        if (chan.readyState === 'open') {
            const payload = this.network.serializer.encode(data);
            const tagged = new Uint8Array(payload.length + 1);
            tagged[0] = (0, $a88694565587cf7b$export$f51b3a85b0eb2345);
            tagged.set(payload, 1);
            chan.send(tagged);
        }
    }
    /**
   * Send a JSON-compatible value using the automatic, zero-config schema codec.
   * Object key shapes are interned and synced in-band, so repeated messages drop
   * their field names. The receiver auto-decodes back to the original value.
   */ sendAuto(channel, data) {
        if (!(channel in this.channels)) throw new Error('unknown channel ' + channel);
        const chan = this.channels[channel];
        if (chan.readyState === 'open') chan.send(this.autoSchema.encode(data));
    }
    get maxMessageSize() {
        return this.conn.sctp?.maxMessageSize ?? null;
    }
    toString() {
        return `[Peer: ${this.id}]`;
    }
}
async function $95761353b7ef8987$var$wrapSessionDescription(desc, config, selfID, otherID) {
    if (config.testproxyURL === undefined) return;
    let lines = desc.sdp.split('\r\n');
    lines = lines.filter((l)=>{
        return !l.startsWith('a=candidate') || l.includes('127.0.0.1') && l.includes('udp');
    });
    for(let i = 0; i < lines.length; i++){
        const l = lines[i];
        if (l.startsWith('a=candidate') && l.includes('127.0.0.1')) {
            const orignalPort = l.split('127.0.0.1 ').pop()?.split(' ')[0] // find port
            ;
            if (orignalPort != null) {
                const resp = await fetch(`${config.testproxyURL}/create?id=${selfID + otherID}&port=${orignalPort}`);
                const substitudePort = await resp.text();
                lines[i] = l.replaceAll(` ${orignalPort} `, ` ${substitudePort} `);
            }
        }
    }
    desc.sdp = lines.join('\r\n');
}




class $a3e583e87a964a6f$export$2e2bcd8739ae039 extends (0, $c9i1M$eventemitter3.EventEmitter) {
    gameID;
    peerConfig;
    _closing;
    peers;
    signaling;
    credentials;
    dataChannels;
    /**
   * Serializer used by sendJSON()/broadcastJSON(). Defaults to a zero-dependency
   * JSON serializer; assign a binary serializer (e.g. `@msgpack/msgpack`'s
   * `{ encode, decode }`) to compact the wire format. Both peers must use a
   * compatible serializer.
   */ serializer;
    log;
    unloadListener;
    constructor(gameID, peerConfig = (0, $87208ee2395edd08$export$34c0e73c967be630), signalingURL = (0, $87208ee2395edd08$export$f26023e62b577463)){
        super(), this.gameID = gameID, this.peerConfig = peerConfig, this._closing = false, this.dataChannels = (0, $87208ee2395edd08$export$3e03293f7176f9b3), this.serializer = (0, $a88694565587cf7b$export$8e8b45f0c4469ff5), this.log = (...args)=>{} // console.log
        ;
        this.peers = new Map();
        this.signaling = new (0, $9f9f06bbd862f032$export$2e2bcd8739ae039)(this, this.peers, signalingURL);
        this.credentials = new (0, $21698a8a5c043574$export$2e2bcd8739ae039)(this.signaling);
        this.unloadListener = ()=>this.close();
        if (typeof window !== 'undefined') window.addEventListener('unload', this.unloadListener);
    }
    async list(filter, sort, limit) {
        if (this._closing || this.signaling.receivedID === undefined) return [];
        const filterString = filter != null ? JSON.stringify(filter) : undefined;
        const sortString = sort != null ? JSON.stringify(sort) : undefined;
        const reply = await this.signaling.request({
            type: 'list',
            filter: filterString,
            sort: sortString,
            limit: limit
        });
        if (reply.type === 'lobbies') return reply.lobbies;
        return [];
    }
    async create(settings) {
        if (this._closing || this.signaling.receivedID === undefined) return '';
        const reply = await this.signaling.request({
            type: 'create',
            ...settings
        });
        if (reply.type === 'joined') return reply.lobbyInfo.code;
        return '';
    }
    async join(lobby, password) {
        if (this._closing || this.signaling.receivedID === undefined) return undefined;
        const reply = await this.signaling.request({
            type: 'join',
            lobby: lobby,
            password: password
        });
        if (reply.type === 'joined') return reply.lobbyInfo;
        return undefined;
    }
    async setLobbySettings(settings) {
        if (this._closing || this.signaling.receivedID === undefined) return new Error('network is closing or not connected');
        await this.signaling.request({
            type: 'lobbyUpdate',
            ...settings
        });
        return true;
    }
    async leave() {
        if (this._closing || this.signaling.receivedID === undefined || this.signaling.currentLobby === undefined) return;
        await this.signaling.request({
            type: 'leave'
        });
        this.peers.forEach((peer)=>peer.close('left lobby'));
    }
    close(reason) {
        if (this._closing || this.signaling.receivedID === undefined) return;
        this._closing = true;
        this.emit('close', reason);
        if (this.id !== '') this.signaling.send({
            type: 'close',
            id: this.id,
            reason: reason ?? 'normal closure'
        });
        this.peers.forEach((peer)=>peer.close(reason));
        this.signaling.close();
        if (typeof window !== 'undefined') window.removeEventListener('unload', this.unloadListener);
    }
    send(channel, peerID, data) {
        if (!(channel in this.dataChannels)) throw new Error('unknown channel ' + channel);
        if (this.peers.has(peerID)) this.peers.get(peerID)?.send(channel, data);
    }
    broadcast(channel, data) {
        if (!(channel in this.dataChannels)) throw new Error('unknown channel ' + channel);
        this.peers.forEach((peer)=>peer.send(channel, data));
    }
    /**
   * Send a JSON-compatible value to a specific peer. The value is serialized to
   * binary (see {@link serializer}) and auto-decoded on the receiving side
   * before the `message` event fires.
   */ sendJSON(channel, peerID, data) {
        if (!(channel in this.dataChannels)) throw new Error('unknown channel ' + channel);
        if (this.peers.has(peerID)) this.peers.get(peerID)?.sendEncoded(channel, data);
    }
    /**
   * Broadcast a JSON-compatible value to all connected peers. See {@link sendJSON}.
   */ broadcastJSON(channel, data) {
        if (!(channel in this.dataChannels)) throw new Error('unknown channel ' + channel);
        this.peers.forEach((peer)=>peer.sendEncoded(channel, data));
    }
    /**
   * Send a JSON-compatible value to a specific peer using the automatic schema
   * codec — zero config, no schema declarations, and far more compact than
   * sendJSON for repeated message shapes. The receiving `message` event fires
   * with the decoded value.
   */ sendAuto(channel, peerID, data) {
        if (!(channel in this.dataChannels)) throw new Error('unknown channel ' + channel);
        if (this.peers.has(peerID)) this.peers.get(peerID)?.sendAuto(channel, data);
    }
    /**
   * Broadcast a JSON-compatible value to all connected peers using the automatic
   * schema codec. See {@link sendAuto}.
   */ broadcastAuto(channel, data) {
        if (!(channel in this.dataChannels)) throw new Error('unknown channel ' + channel);
        this.peers.forEach((peer)=>peer.sendAuto(channel, data));
    }
    /**
   * Broadcast only to peers the `interested` predicate accepts — area-of-interest
   * / relevance filtering. Use it to avoid the full O(N) mesh fan-out: send a
   * packet just to the peers that care about it (spatially near, same team, same
   * region, …). The predicate runs once per connected peer; track whatever state
   * it needs (e.g. positions received from peers) keyed by `peer.id`.
   *
   * @example
   * // only peers within 500 units of the sender
   * network.interestBroadcast('unreliable', state, peer => near(positions.get(peer.id)))
   */ interestBroadcast(channel, data, interested) {
        if (!(channel in this.dataChannels)) throw new Error('unknown channel ' + channel);
        this.peers.forEach((peer)=>{
            if (interested(peer)) peer.send(channel, data);
        });
    }
    /**
   * Like {@link interestBroadcast}, but encodes the value with the automatic
   * schema codec (see {@link sendAuto}). This is the recommended path for game
   * state: interest filtering cuts the number of recipients while the binary
   * codec cuts the bytes per recipient — the two savings compound.
   */ interestBroadcastAuto(channel, data, interested) {
        if (!(channel in this.dataChannels)) throw new Error('unknown channel ' + channel);
        this.peers.forEach((peer)=>{
            if (interested(peer)) peer.sendAuto(channel, data);
        });
    }
    /**
   * @internal
   */ async _addPeer(id, polite) {
        if (this.peers.has(id)) return;
        const config = await this.credentials.fillCredentials(this.peerConfig);
        if (this.peers.has(id)) return;
        config.iceServers = config.iceServers?.filter((server)=>!(server.urls.includes('turn:') && server.username === undefined));
        const peer = new (0, $95761353b7ef8987$export$2e2bcd8739ae039)(this, this.signaling, id, config, polite);
        this.peers.set(id, peer);
    }
    /**
   * @internal
   */ _removePeer(peer) {
        return this.peers.delete(peer.id);
    }
    /**
   * @internal
   */ _prefetchTURNCredentials() {
        this.credentials.fillCredentials(this.peerConfig).catch(()=>{});
    }
    /**
   * @internal
   */ _onSignalingError(e) {
        this.emit('signalingerror', e);
        if (this.listenerCount('signalingerror') === 0) console.error('signallingerror not handled:', e);
        this.signaling.event('signaling', 'error', {
            error: JSON.stringify(e)
        });
    }
    /**
   * @internal
   */ _forceReconnectSignaling() {
        this.signaling.close();
    }
    get id() {
        return this.signaling.receivedID ?? '';
    }
    get closing() {
        return this._closing;
    }
    get size() {
        return this.peers.size;
    }
    get currentLobby() {
        return this.signaling.currentLobby;
    }
    get currentLobbyInfo() {
        return this.signaling.currentLobbyInfo;
    }
    get currentLeader() {
        return this.signaling.currentLeader;
    }
}



const $87208ee2395edd08$export$f26023e62b577463 = process.env.NODE_ENV === 'test' ? 'ws://localhost:8080/v0/signaling' : 'wss://netlib.poki.io/v0/signaling';
const $87208ee2395edd08$export$34c0e73c967be630 = {
    iceServers: [
        {
            urls: [
                'stun:stun.l.google.com:19302'
            ]
        },
        {
            urls: (0, $21698a8a5c043574$export$3be8bbe0727053e5)
        }
    ]
};
const $87208ee2395edd08$export$3e03293f7176f9b3 = {
    reliable: {
        ordered: true
    },
    unreliable: {
        ordered: true,
        maxRetransmits: 0
    },
    control: {
        ordered: false
    }
};


//# sourceMappingURL=netlib.js.map
