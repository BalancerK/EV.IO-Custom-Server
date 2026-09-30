/**
 * test_chat.js — in-game chat, emotes, and the escaping the client forces on us.
 *
 * PROTOCOL (all over the GAME socket; wss://social.ev.io is dead so this is the only chat path):
 *   client -> server : `4`{"msg":"hello","team":<id|undefined>}   (sendChat = sendEvent('4', …))
 *   server -> client : ~0{channel,from,msg,uid,insignia}          (notification 0 -> addChatMessage)
 *
 * EMOTES. '/dance' and '/examine' arrive as ordinary chat on the same endpoint — the client's own
 * dispatcher routes them to the game socket explicitly. They must NOT be echoed as chat; they set
 * isDancing / isExamining (opcodes 185/186). The client NEVER sets these true (Qcdx4mh is only ever
 * assigned !1, at 8 sites) — it only clears them on shoot/zoom — so they are server-authoritative.
 * isDancing is also reconciler-compared (Qqx5i3b), which is why we clear ours on the same events.
 *
 * SECURITY. addChatMessage builds the row with `a.innerHTML += … + e.msg` — raw HTML, no escaping.
 * An unescaped message would execute script in EVERY other player's page, so the server escapes
 * both `msg` and `from`. These assertions are the guard against that regressing.
 *
 * Usage:  node scripts/test_chat.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

// A session whose ws captures whatever the server would send.
function mkSession(id, name, over) {
  const sent = [];
  return Object.assign({
    sessionId: id, playerId: id, accepted: true, displayName: name, uid: 42,
    playerState: srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, id),
    // safeSend compares readyState against ws.OPEN, so the mock must carry both.
    ws: { readyState: 1, OPEN: 1, send: (d) => sent.push(String(d)) },
    _sent: sent,
  }, over || {});
}
const chatOf = (s) => s._sent.filter((m) => m.startsWith('~0`')).map((m) => JSON.parse(m.slice(3)));

console.log('\n── a normal message is broadcast to everyone ──');
{
  const a = mkSession('a', 'Alice'), b = mkSession('b', 'Bob');
  const sessions = new Map([['a', a], ['b', b]]);
  srv.handleChatEvent(a, sessions, { msg: 'hello world' });
  const toA = chatOf(a), toB = chatOf(b);
  ok('sender receives it', toA.length === 1, `got ${toA.length}`);
  ok('other players receive it', toB.length === 1, `got ${toB.length}`);
  ok('it uses notification 0 (addChatMessage)', a._sent[0].startsWith('~0`'));
  ok('carries the sender name', toA[0].from === 'Alice', toA[0].from);
  ok('carries the message', toA[0].msg === 'hello world', toA[0].msg);
  ok('carries the uid (client links the row to a profile)', toA[0].uid === 42);
}

console.log('\n── XSS: the client renders msg as raw innerHTML ──');
{
  const a = mkSession('a', 'Alice'), b = mkSession('b', 'Bob');
  const sessions = new Map([['a', a], ['b', b]]);
  srv.handleChatEvent(a, sessions, { msg: '<img src=x onerror="alert(1)">' });
  const got = chatOf(b)[0];
  ok('angle brackets are escaped', got.msg.indexOf('<') === -1 && got.msg.indexOf('>') === -1, got.msg);
  ok('the payload survives as visible text', got.msg.indexOf('&lt;img') === 0, got.msg);
  ok('quotes are escaped too', got.msg.indexOf('&quot;') !== -1 || got.msg.indexOf('"') === -1, got.msg);

  // The display name is interpolated into innerHTML as well.
  const evil = mkSession('c', '<script>bad()</script>');
  const s2 = new Map([['c', evil]]);
  srv.handleChatEvent(evil, s2, { msg: 'hi' });
  const got2 = chatOf(evil)[0];
  ok('the display NAME is escaped as well', got2.from.indexOf('<') === -1, got2.from);
}

console.log('\n── emotes are consumed, never echoed ──');
{
  const a = mkSession('a', 'Alice');
  const sessions = new Map([['a', a]]);
  const consumed = srv.handleChatEvent(a, sessions, { msg: '/dance' });
  ok('/dance is consumed as an emote', consumed === true);
  ok('it does NOT appear in chat', chatOf(a).length === 0, 'emotes must not render as text');
  ok('isDancing is set', a.playerState.isDancing === true);

  srv.handleChatEvent(a, sessions, { msg: '/dance' });
  ok('repeating it toggles off', a.playerState.isDancing === false);

  srv.handleChatEvent(a, sessions, { msg: '/examine' });
  ok('/examine sets isExamining', a.playerState.isExamining === true);
  srv.handleChatEvent(a, sessions, { msg: '/DANCE' });
  ok('commands are case-insensitive', a.playerState.isDancing === true);
  ok('and dancing clears examining (they are mutually exclusive)', a.playerState.isExamining === false);
}

console.log('\n── emote state reaches the wire (opcodes 185/186) ──');
{
  const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'e');
  const read = (body, op) => {
    for (let i = 0; i < body.length - 1; i++) if (body[i] === op && body[i - 1] !== op) return body[i + 1];
    return undefined;
  };
  let body = [];
  srv.appendPlayerTickBody(body, 'e', ps);
  ok('185 isDancing is streamed', read(body, 185) === false, String(read(body, 185)));
  ok('186 isExamining is streamed', read(body, 186) === false, String(read(body, 186)));

  ps.isDancing = true;
  body = [];
  srv.appendPlayerTickBody(body, 'e', ps);
  ok('185 reflects the dance state', read(body, 185) === true);
}

console.log('\n── unicode / emoji must survive intact ──');
{
  const a = mkSession('a', 'Alice');
  const sessions = new Map([['a', a]]);
  // The client's emoji popup inserts plain unicode characters; escaping must not touch them.
  srv.handleChatEvent(a, sessions, { msg: 'gg 😀🤣❤️ 家門' });
  const got = chatOf(a)[0];
  ok('emoji and non-latin text pass through unchanged', got.msg === 'gg 😀🤣❤️ 家門', got.msg);
}

console.log('\n── robustness ──');
{
  const a = mkSession('a', 'Alice');
  const sessions = new Map([['a', a]]);
  ok('an empty message is dropped',
    srv.handleChatEvent(a, sessions, { msg: '   ' }) === false && chatOf(a).length === 0);
  ok('a non-string message is ignored', srv.handleChatEvent(a, sessions, { msg: 42 }) === false);
  ok('a null arg is ignored', srv.handleChatEvent(a, sessions, null) === false);

  // Flood guard: a burst from one session must not all go out.
  const b = mkSession('b', 'Bob');
  const s2 = new Map([['b', b]]);
  for (let i = 0; i < 10; i++) srv.handleChatEvent(b, s2, { msg: 'spam ' + i });
  ok('rapid repeats are rate-limited', chatOf(b).length < 10, `${chatOf(b).length} of 10 sent`);

  // Length cap.
  const c = mkSession('c', 'Carol');
  const s3 = new Map([['c', c]]);
  srv.handleChatEvent(c, s3, { msg: 'x'.repeat(5000) });
  const got = chatOf(c)[0];
  ok('over-long messages are truncated', got && got.msg.length <= 300, got && String(got.msg.length));
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
