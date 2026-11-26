/**
 * test_map_environment.js — a map's "Environment Effect" and "Ambient Track" reach the client.
 *
 * The CMS map node carries both (field_environment_effect = taxonomy terms Rain / Snow / Dust /
 * Lightning, field_ambient_track = an .ogg). Official sends them as roomParams: 20 lightning,
 * 21 rain, 22 snow, 23 dust, 24 wind, 25 ambientURL. The client draws the weather and plays its
 * sounds from those flags.
 *
 * Usage:  node scripts/test_map_environment.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
process.env.EVIO_CLICK_TO_PLAY = '0';
const srv = require('../local_ws_server');
const ml = require('../map_loader');
const em = require('../extra_maps');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const byTitle = (t) => ml.listMaps().find((m) => m.title === t);
// Header fields of a tick body: scalar pairs before the first 244 / bullet / hit block.
function header(body) {
  const h = new Map();
  for (let i = 0; i + 1 < body.length && body[i] < 50; i += 2) h.set(body[i], body[i + 1]);
  return h;
}
function tickFor(map, tick, ctx = null) {
  srv.match.mapUrlOverride = map.evmapUrl;
  const sessions = new Map();
  const ps = srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, 'pa');
  const s = { playerId: 'pa', sessionId: 'pa', accepted: true, playerState: ps, _deltaPhase: 1 };
  sessions.set('pa', s);
  return { body: srv.buildTickBody('pa', tick, ps, sessions, ctx), s };
}

console.log('\n── the catalogue reads each map\'s Environment Effect ──');
{
  const fx = (t) => { const m = byTitle(t); return m && m.effects; };
  ok('Frostbite: snow', fx('Frostbite') && fx('Frostbite').snow && !fx('Frostbite').rain, JSON.stringify(fx('Frostbite')));
  ok('Gypsum: dust', fx('Gypsum') && fx('Gypsum').dust);
  ok('Dusk: lightning', fx('Dusk') && fx('Dusk').lightning);
  ok('Pawn: lightning + rain', fx('Pawn') && fx('Pawn').lightning && fx('Pawn').rain && !fx('Pawn').snow);
  ok('Bishop: none', fx('Bishop') && !Object.values(fx('Bishop')).some(Boolean));
  const withAny = ml.listMaps().filter((m) => m.effects && Object.values(m.effects).some(Boolean)).length;
  ok(`most maps have weather (${withAny})`, withAny >= 30);
}

console.log('\n── the server sends it as roomParams 20-24, next to the ambient track (25) ──');
const saved = srv.match.mapUrlOverride;
{
  const pawn = byTitle('Pawn');
  const h = header(tickFor(pawn, 3000).body);
  ok('20 lightning = true, 21 rain = true', h.get(20) === true && h.get(21) === true);
  ok('22 snow, 23 dust, 24 wind = false', h.get(22) === false && h.get(23) === false && h.get(24) === false);
  ok('25 ambient track is the map\'s', h.get(25) === (pawn.ambientUrl || ''), String(h.get(25)));
  const keys = [...h.keys()];
  ok('header stays in ascending opcode order', keys.every((k, i) => i === 0 || k > keys[i - 1]), keys.join(','));
  const bishop = header(tickFor(byTitle('Bishop'), 3001).body);
  ok('a map without weather sends all five off', [20, 21, 22, 23, 24].every((op) => bishop.get(op) === false));
  const frost = header(tickFor(byTitle('Frostbite'), 3002).body);
  ok('switching map switches the weather (Frostbite: snow on, rain off)', frost.get(22) === true && frost.get(21) === false);
}

console.log('\n── unchanged weather is not resent every tick ──');
{
  const map = byTitle('Gypsum');
  const first = tickFor(map, 4000);
  const ctx1 = srv.makeDeltaContext(first.s, 4000);
  // rebuild with the same session so the delta state carries over
  srv.match.mapUrlOverride = map.evmapUrl;
  const sessions = new Map([['pa', first.s]]);
  srv.buildTickBody('pa', 4000, first.s.playerState, sessions, ctx1); srv.commitDeltaContext(ctx1);
  let sentLater = 0;
  for (let t = 4001; t < 4010; t++) {
    const ctx = srv.makeDeltaContext(first.s, t);
    const h = header(srv.buildTickBody('pa', t, first.s.playerState, sessions, ctx));
    srv.commitDeltaContext(ctx);
    if (!ctx.full && t > 4000 + 4 && h.has(23)) sentLater++;
  }
  ok('dust flag goes quiet after its re-send window', sentLater === 0, `${sentLater} ticks`);
}
srv.match.mapUrlOverride = saved;

console.log('\n── hosted extra maps may carry both, validated ──');
{
  const [a, b] = em.parseList({ maps: [
    { nid: 9001, evmapUrl: 'https://ev.io/sites/default/files/maps/a.evmap',
      ambientUrl: 'https://ev.io/sites/default/files/ambient_tracks/rain_loop.ogg', effects: ['Rain', 'Lightning', 'Fire'] },
    { nid: 9002, evmapUrl: 'https://ev.io/sites/default/files/maps/b.evmap', ambientUrl: 'https://example.com/x.ogg' },
  ] });
  ok('an ev.io ambient track is kept', a.ambientUrl === 'https://ev.io/sites/default/files/ambient_tracks/rain_loop.ogg');
  ok('known effects are kept, unknown ones ignored', a.effects.rain && a.effects.lightning && !a.effects.snow);
  ok('a sound from anywhere else is dropped', b.ambientUrl === null);
  ok('no effects listed = none', !Object.values(b.effects).some(Boolean));
}

console.log(`\n${'─'.repeat(60)}\n${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
