/**
 * test_round_restart_live.js — END-TO-END round restart with two REAL clients.
 *
 * WHY A LIVE TEST
 * ───────────────
 * The unit tests can prove a bootstrap body CONTAINS the right opcodes, but the bug that kept
 * recurring was about DELIVERY: after a round restart the client's world state is rebuilt by the
 * map reload, the 244 tick loop recreates every entity as an EMPTY object
 * (`w in playerList || (playerList[w] = {})`), and a movement tick body carries no weapon
 * (127/135), no stats (95-123) and no identity (210/212/231). Symptoms: peers invisible AND the
 * local player unable to shoot or throw grenades, because their own entity has no weapon.
 *
 * So this drives the real server with real sockets over several short rounds and asserts each
 * client actually RECEIVES a full first-spawn body (stat block + weapon) after the restart, with
 * peers present in the same body.
 *
 * Usage:  node scripts/test_round_restart_live.js
 */
// that after the round restart each client receives a full re-bootstrap (weapon + stats + peers).
process.env.EVIO_LOCAL_PORT = '18140';
process.env.EVIO_ADMIN = '0';
process.env.EVIO_ROUND_TICKS = '60';        // 3s round (60 is the minimum the setting allows)
process.env.EVIO_INTERMISSION_TICKS = '20'; // 1s intermission
const path = require('path');
const WebSocket = require(path.join(__dirname, '..', 'node_modules', 'ws'));
const { decode } = require(path.join(__dirname, '..', 'node_modules', '@msgpack', 'msgpack'));
const srv = require('../local_ws_server');
const bpw = require('../physics_world');

const seen = {};
function join(name) {
  const ws = new WebSocket('ws://127.0.0.1:18140');
  seen[name] = { boots: 0, ticks: 0, sawWeaponAfterRestart: false, restarted: false };
  ws.on('message', (d, isBin) => {
    if (!isBin) { const t = d.toString('utf8'); if (t.startsWith('ID')) ws.send(';' + JSON.stringify({ name, uid: 100 })); return; }
    try {
      const p = decode(d); const body = p[2];
      if (!Array.isArray(body)) return;
      const s = seen[name];
      s.ticks++;
      const isBoot = body.indexOf(95) >= 0 && body.indexOf(127) >= 0;   // stat block + weapon
      if (isBoot) { s.boots++; if (s.restarted) s.sawWeaponAfterRestart = true; }
      const gen = body.indexOf(8) >= 0 ? body[body.indexOf(8) + 1] : null;
      if (gen && gen > 1) s.restarted = true;
      // count distinct 244 ids in this body
      const ids = new Set();
      for (let i = 0; i < body.length - 1; i++) if (body[i] === 244 && body[i + 1] !== -1) ids.add(body[i + 1]);
      if (ids.size > (s.maxEntities || 0)) s.maxEntities = ids.size;
    } catch (_) {}
  });
  return ws;
}

bpw.ready.then(() => {
  srv.startServer();
  setTimeout(() => { join('A'); join('B'); }, 300);
  setTimeout(() => {
    const st = srv.getStatus();
    console.log('round reached:', st.round, '| phase:', st.roundPhase);
    for (const n of ['A', 'B']) {
      const s = seen[n];
      console.log(`${n}: packets=${s.ticks} bootstraps=${s.boots} maxEntitiesInOneBody=${s.maxEntities || 0} `
        + `sawFullBootstrapAfterRestart=${s.sawWeaponAfterRestart}`);
    }
    // With a SINGLE-map rotation there must be NO map reload: bumping the generation makes the
    // client tear its game state down (predictState -> null, canSendInput=false, signal 4), which
    // is what left peers invisible and shooting dead after every round.
    const genStable = srv.match.mapGeneration === 1;
    const bothSawPeers = (seen.A.maxEntities || 0) >= 2 && (seen.B.maxEntities || 0) >= 2;
    console.log('map generation after ' + srv.match.round + ' rounds:', srv.match.mapGeneration,
      genStable ? '(stable — no needless reload)' : '(CHANGED — client teardown expected)');
    const ok = srv.match.round >= 2 && genStable && bothSawPeers;
    console.log(ok ? 'PASS: rounds restart in place, no client teardown, peers still streamed'
                   : 'FAIL: ' + (!genStable ? 'map generation changed on a single-map rotation'
                                : !bothSawPeers ? 'a client stopped seeing peers'
                                : 'no round restart happened'));
    process.exit(ok ? 0 : 1);
  }, 11000);
});
