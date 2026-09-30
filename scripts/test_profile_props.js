/**
 * test_profile_props.js
 *
 * The scoreboard/kill-feed avatar and the clan insignia must reach the client.
 *
 * HOW THE CLIENT BUILDS THEM
 * ──────────────────────────
 * Avatar — scoreboard and kill feed use the SAME helper, so one prop fixes both:
 *   K = function(entity, props, cfg) { var i = props.Qaalbed; ...zombie override...; return i }
 *   scoreboard: '<div class="msg_profile_score ' + props.Qy58vo2.toLowerCase() + '"><img src="' + K(..) + '">'
 *   kill feed : '<div class="msg_profile '      + props.Qy58vo2.toLowerCase() + '"><img src="' + K(..) + '" />'
 * `Qaalbed` is PlayerPropKey.THUMB_URL and `Qy58vo2` is the rarity frame class — both Public
 * scope, i.e. delivered through the `~3` prop roster exactly like SKIN_URL.
 *
 * Clan insignia — needs TWO sources and silently renders nothing if either is missing:
 *   h = '';
 *   (entity.Qdqucnz === null || props.Q3ap9pp === null || s) ||
 *     (h = '<a href="' + props.Q3ap9pp + '"><img src="' + entity.Qdqucnz + '" /></a>')
 * i.e. the clan IMAGE is a per-entity field (opcode 235) and the clan LINK is a prop.
 *
 * The roster entry shape is unforgiving — the client does
 *   g[e.Qwhkhza] ||= createPlayerPropStore(); g[e.Qwhkhza][e.Qcxi0k5] = e.Qcou9jy
 * so a readable key name silently writes to g["undefined"] and nothing renders.
 *
 * Usage:  node scripts/test_profile_props.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

const THUMB = 'Qaalbed', RARITY = 'Qy58vo2', CLAN_LINK = 'Q3ap9pp', SKIN = 'Qh52c4d';

function session(over) {
  return Object.assign({
    sessionId: 'p1', accepted: true,
    skinUrl: 'https://ev.io/sites/default/files/skins/x.evskin',
    thumbUrl: null, skinRarity: null, clanImgUrl: null, clanLink: null, weaponSkins: null,
  }, over || {});
}
const roster = (s) => srv.buildPropRoster(new Map([['p1', s]]));
const find = (r, key) => r.find((e) => e.Qcxi0k5 === key);

console.log('\n── the avatar prop reaches the roster ──');
{
  const r = roster(session({ thumbUrl: 'https://ev.io//sites/default/files/skin_profile_thumbs/a.png' }));
  const e = find(r, THUMB);
  ok('THUMB_URL (Qaalbed) is present', !!e);
  ok('it carries the thumb URL', e && e.Qcou9jy.indexOf('skin_profile_thumbs') !== -1);
  ok('entity id uses the obfuscated key Qwhkhza', e && e.Qwhkhza === 'p1');
  ok('prop key uses the obfuscated key Qcxi0k5', e && Object.prototype.hasOwnProperty.call(e, 'Qcxi0k5'));
  ok('value uses the obfuscated key Qcou9jy', e && Object.prototype.hasOwnProperty.call(e, 'Qcou9jy'));
  // A readable key would silently write into g["undefined"] and render nothing.
  ok('no readable key names leak into the entry',
    e && !('entityId' in e) && !('propKey' in e) && !('propValue' in e));
}

console.log('\n── rarity frame ──');
{
  const r = roster(session({ skinRarity: 'Rare' }));
  const e = find(r, RARITY);
  ok('rarity prop (Qy58vo2) is present', !!e, 'the avatar frame class comes from this');
  ok('it carries the tier string', e && e.Qcou9jy === 'Rare');
}

console.log('\n── clan insignia needs BOTH halves ──');
{
  // Link prop present but no image -> the client's guard leaves the insignia empty.
  const linkOnly = roster(session({ clanLink: 'https://ev.io/clan/1' }));
  ok('clan link prop (Q3ap9pp) is sent when set', !!find(linkOnly, CLAN_LINK));
  // The image travels as opcode 235 on the entity, not as a prop.
  const sb = require('../state_builder');
  const body = sb.buildFirstSpawnBody({ playerId: 'p1', clan: 'https://ev.io/clanlogo.png' });
  let clanIdx = -1;
  for (let i = 0; i < body.length - 1; i++) if (body[i] === 235) { clanIdx = i; break; }
  ok('clan image rides opcode 235 on the entity', clanIdx >= 0 && body[clanIdx + 1] === 'https://ev.io/clanlogo.png',
    clanIdx < 0 ? 'opcode 235 not emitted' : `got ${body[clanIdx + 1]}`);
  const noClan = sb.buildFirstSpawnBody({ playerId: 'p1' });
  let idx2 = -1;
  for (let i = 0; i < noClan.length - 1; i++) if (noClan[i] === 235) { idx2 = i; break; }
  ok('with no clan it stays null (client guard renders no insignia)', idx2 >= 0 && noClan[idx2 + 1] === null);
}

console.log('\n── nothing is invented when the account has no cosmetics ──');
{
  const r = roster(session());
  ok('no THUMB_URL entry when thumbUrl is unset', !find(r, THUMB));
  ok('no rarity entry when unset', !find(r, RARITY));
  ok('no clan-link entry when unset', !find(r, CLAN_LINK));
  ok('the skin prop is still sent', !!find(r, SKIN));
}

console.log('\n── multiple players each get their own entries ──');
{
  const a = session({ sessionId: 'a', thumbUrl: 'http://x/a.png' });
  const b = session({ sessionId: 'b', thumbUrl: 'http://x/b.png' });
  const r = srv.buildPropRoster(new Map([['a', a], ['b', b]]));
  const thumbs = r.filter((e) => e.Qcxi0k5 === THUMB);
  ok('one avatar entry per player', thumbs.length === 2, `got ${thumbs.length}`);
  ok('keyed by their own sessionId',
    thumbs.some((e) => e.Qwhkhza === 'a') && thumbs.some((e) => e.Qwhkhza === 'b'));
}


console.log('\n── PEERS see each other\'s clan insignia (not just their own) ──');
{
  // The avatar is a PROP (the ~3 roster covers every session), but the clan image is a per-ENTITY
  // opcode. It used to be filled in only for the local player's own bootstrap/loadout delta, so a
  // player saw their OWN logo and never a peer's. Both peer paths build their entity block through
  // buildPeerBootstrapDelta, so it must carry the clan.
  const read235 = (body) => {
    for (let i = 0; i < body.length - 1; i++) if (body[i] === 235 && body[i - 1] !== 235) return body[i + 1];
    return undefined;
  };
  const peer = {
    playerId: 'p2', tick: 1, displayName: 'Peer', uid: 99, weaponId: 4, teamId: 0,
    clanImgUrl: 'https://ev.io//sites/default/files/insignias/peer.png',
    playerState: srv.createPlayerSimState({ x: 1, y: 2, z: 3, yaw: 0 }, 'p2'),
  };
  const delta = srv.buildPeerBootstrapDelta(peer);
  ok('a peer bootstrap carries opcode 235', read235(delta) === peer.clanImgUrl, String(read235(delta)));

  // The mid-match spawn packet reuses the same builder, so it is covered too.
  const pkt = srv.buildPeerSpawnPacketForRecipient(peer, 5, 0);
  ok('the mid-match peer spawn packet carries it as well', read235(pkt[2]) === peer.clanImgUrl);

  // A clanless peer must not emit a bogus insignia.
  const noClan = Object.assign({}, peer, { clanImgUrl: null });
  ok('a peer with no clan sends null (client renders no insignia)',
    read235(srv.buildPeerBootstrapDelta(noClan)) === null);
}

console.log('\n── a LATE clan (resolved after the join) reaches peers ──');
{
  // clans-all3 is fetched asynchronously, so the peer bootstrap almost always goes out with
  // clan=null and the value arrives seconds later over the '#EVL#' channel.
  const mk = (id) => ({
    sessionId: id, playerId: id, accepted: true, displayName: id, uid: 7,
    playerState: srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, id),
    ws: { readyState: 1, OPEN: 1, send() {} },
    pendingPeerBootstraps: [],
  });
  const a = mk('a'), b = mk('b');
  const sessions = new Map([['a', a], ['b', b]]);
  srv.applyLiveLoadout(a, a.playerState,
    JSON.stringify({ clanImgUrl: 'https://ev.io//sites/default/files/insignias/late.png',
                     clanLink: '/group/12192' }), sessions);
  ok('the other player gets a queued re-introduction', b.pendingPeerBootstraps.length > 0,
    'without this the peer keeps the clan=null bootstrap forever');
  const LATE = 'https://ev.io//sites/default/files/insignias/late.png';
  const has235 = b.pendingPeerBootstraps.some((v, i) =>
    v === 235 && b.pendingPeerBootstraps[i + 1] === LATE);
  ok('and that re-introduction carries the new insignia', has235);
  ok('the sender is not re-introduced to itself', a.pendingPeerBootstraps.length === 0);
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
