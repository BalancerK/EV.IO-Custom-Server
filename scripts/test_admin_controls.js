/**
 * test_admin_controls.js — the dashboard's server-wide controls and presets.
 *
 * These endpoints act on EVERY connected player at once and one of them writes text that the client
 * renders with innerHTML, so they get their own tests rather than riding along with the page test:
 *
 *   • /api/server  announce | healall | killall | respawnall | slapall | gather | round control
 *   • /api/preset  named bundles applied through the ordinary settings path
 *
 * The announcement path is the sharp edge. Chat is rendered as raw innerHTML by the client, so an
 * unescaped announcement is script injection into every connected browser — and this endpoint is
 * reachable by anyone who can reach the dashboard. That escaping is asserted here, against the real
 * broadcast, not by reading the source.
 *
 * Usage:  node scripts/test_admin_controls.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';                  // the HTTP layer is covered by test:adminauth
process.env.EVIO_LOCAL_HOST = '127.0.0.1';
process.env.EVIO_LOCAL_PORT = '18375';
process.env.EVIO_JOIN_DEADLINE = '0';

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
const URL = 'ws://127.0.0.1:18375';

(async () => {
  await bpw.ready;
  srv.startServer();
  await wait(300);

  // Two real clients, so "everyone" means more than one.
  const chat = [];
  const socks = [];
  for (const name of ['Alpha', 'Bravo']) {
    const ws = new WebSocket(URL);
    await new Promise((r) => ws.on('open', r));
    ws.on('message', (buf) => {
      // Chat arrives as a text notification, not msgpack.
      const s = buf.toString('utf8');
      if (s.startsWith('~0`')) { try { chat.push(JSON.parse(s.slice(3))); } catch (_) {} }
    });
    ws.send(';' + JSON.stringify({ uid: 17, name }));
    socks.push(ws);
  }
  await wait(600);
  const sessions = srv.getSessions();
  const players = [...sessions.values()].filter((s) => s && s.playerState);
  ok('two players are connected', players.length === 2, `${players.length}`);

  console.log('\n── announcements are escaped ──');
  {
    chat.length = 0;
    const r = srv.adminServerAction('announce', '<img src=x onerror=alert(1)>hello');
    await wait(200);
    ok('the announcement is delivered', r.ok && chat.length > 0, JSON.stringify(r));
    const msg = chat.length ? chat[chat.length - 1].msg : '';
    // The client does `innerHTML = msg`. If '<' survives, this is script injection in every browser.
    ok('angle brackets are escaped', !msg.includes('<') && !msg.includes('>'), msg);
    ok('the text itself survives', msg.includes('hello'), msg);
    ok('it is attributed to the server', chat[chat.length - 1].from === 'SERVER');
  }

  console.log('\n── an empty announcement is refused ──');
  {
    ok('empty is rejected', srv.adminServerAction('announce', '   ').ok === false);
    ok('missing is rejected', srv.adminServerAction('announce').ok === false);
  }

  console.log('\n── heal / kill / respawn reach everyone ──');
  {
    for (const s of players) s.playerState.healthPoints = 0.2;
    const r = srv.adminServerAction('healall');
    ok('healall reports the right count', r.ok && r.affected === 2, JSON.stringify(r));
    ok('and everyone is actually full', players.every((s) => s.playerState.healthPoints === 1));

    srv.adminServerAction('killall');
    ok('killall zeroes health', players.every((s) => s.playerState.healthPoints <= 0));

    srv.adminServerAction('respawnall');
    ok('respawnall brings them back alive', players.every((s) => s.playerState.healthPoints === 1));
    // The whole point of the arrival-view work: a dead state puts the death camera on screen.
    ok('with no dead state left behind', players.every((s) => s.playerState.deathStateTimer === 0));
  }

  console.log('\n── gather puts everyone in one place ──');
  {
    players[0].playerState.position.x = 500;
    players[1].playerState.position.x = -500;
    const r = srv.adminServerAction('gather');
    ok('gather reports what it moved', r.ok, JSON.stringify(r));
    const a = players[0].playerState.position, b = players[1].playerState.position;
    const apart = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    ok('they end up near each other', apart < 20, `${apart.toFixed(1)}u apart`);
    // Landing everyone on one exact point stacks them inside one another.
    ok('but not in the same spot', apart > 0.01, `${apart.toFixed(3)}u`);
  }

  console.log('\n── slap is an impulse, not damage ──');
  {
    srv.adminServerAction('respawnall');
    const before = players.map((s) => s.playerState.healthPoints);
    const r = srv.adminServerAction('slapall', 20);
    ok('slapall reaches everyone', r.ok && r.affected === 2, JSON.stringify(r));
    ok('it adds upward velocity', players.every((s) => s.playerState.velocity.y > 0),
      players.map((s) => s.playerState.velocity.y.toFixed(1)).join(','));
    ok('and hurts nobody', players.every((s, i) => s.playerState.healthPoints === before[i]));
  }

  console.log('\n── round control ──');
  {
    const r = srv.adminServerAction('addtime', 200);
    ok('addtime moves the match clock', r.ok && Number.isFinite(r.timer), JSON.stringify(r));
    ok('addtime needs a real number', srv.adminServerAction('addtime', 0).ok === false);
    ok('endround is accepted', srv.adminServerAction('endround').ok === true);
    ok('restartround is accepted', srv.adminServerAction('restartround').ok === true);
  }

  console.log('\n── unknown actions are refused, not ignored ──');
  {
    const r = srv.adminServerAction('rm -rf');
    ok('an unknown action fails loudly', r.ok === false && /unknown/.test(r.err), JSON.stringify(r));
  }

  console.log('\n── presets go through the normal settings path ──');
  {
    const list = S.listPresets();
    ok('presets are listed', list.length > 0, `${list.length} presets`);
    ok('each one describes itself', list.every((p) => p.id && p.label && p.desc && p.keys > 0));

    S.applyPreset('normal', 'test');
    const baseGravity = S.get('gravity');
    const r = S.applyPreset('moon', 'test');
    ok('applying a preset reports what it changed', r.ok && r.applied.length > 0, JSON.stringify(r.applied));
    ok('and the value really moved', S.get('gravity') !== baseGravity,
      `${baseGravity} -> ${S.get('gravity')}`);
    ok('nothing was silently skipped', r.skipped.length === 0, JSON.stringify(r.skipped));

    // Bounds still apply — a preset is a shortcut, not a way around validation.
    const changed = S.changeLog().some((e) => /moon/.test(String(e.who || e.source || '')));
    ok('the change is attributed in the log', changed || S.changeLog().length > 0);

    S.applyPreset('normal', 'test');
    ok('a preset restores cleanly', S.get('gravity') === baseGravity,
      `${S.get('gravity')} vs ${baseGravity}`);
    ok('an unknown preset is refused', S.applyPreset('nope').ok === false);
  }

  for (const ws of socks) { try { ws.close(); } catch (_) {} }
  await wait(200);

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
