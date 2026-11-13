/**
 * test_profile_props.js
 *
 * The scoreboard/kill-feed avatar and the clan insignia must reach the client.
 *
 * HOW THE CLIENT BUILDS THEM (ev.io 1-7-1 — the old obfuscated getPlayerProps/PlayerPropKey
 * system this test used to check is gone from the bundle entirely, replaced by a now fully
 * readable "AdditionalUserInfo" system; see buildPropRoster's own comment in local_ws_server.js
 * for the full before/after mapping)
 * ──────────────────────────
 * Avatar — scoreboard and kill feed use the SAME helper, so one field fixes both:
 *   K = function(entity, props, cfg) { var i = props.profileURL; ...zombie override...; return i }
 *   scoreboard: '<div class="msg_profile_score ' + props.skinTier.toLowerCase() + '"><img src="' + K(..) + '">'
 *   kill feed : '<div class="msg_profile '      + props.skinTier.toLowerCase() + '"><img src="' + K(..) + '" />'
 * `profileURL` is THUMB_URL and `skinTier` is the rarity frame class — both Public scope, i.e.
 * delivered through the `~3` cosmetics roster exactly like SKIN_URL.
 *
 * Clan insignia — needs TWO sources and silently renders nothing if either is missing:
 *   h = '';
 *   (entity.clanInsignia === null || props.clanHomepage === null || s) ||
 *     (h = '<a href="' + props.clanHomepage + '"><img src="' + entity.clanInsignia + '" /></a>')
 * i.e. the clan IMAGE is a per-entity field (opcode 235) and the clan LINK is a roster field.
 *
 * The roster entry shape is unforgiving — the client does
 *   v[e.user] ||= getNewAdditionalUserInfo(); v[e.user][e.field] = e.value
 * so a wrong key name silently writes to v["undefined"] and nothing renders.
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

const THUMB = 'profileURL', RARITY = 'skinTier', CLAN_LINK = 'clanHomepage', SKIN = 'skinUrl';

function session(over) {
  return Object.assign({
    sessionId: 'p1', accepted: true,
    skinUrl: 'https://ev.io/sites/default/files/skins/x.evskin',
    thumbUrl: null, skinRarity: null, clanImgUrl: null, clanLink: null, weaponSkins: null,
  }, over || {});
}
const roster = (s) => srv.buildPropRoster(new Map([['p1', s]]));
const find = (r, key) => r.find((e) => e.field === key);

console.log('\n── the avatar prop reaches the roster ──');
{
  const r = roster(session({ thumbUrl: 'https://ev.io//sites/default/files/skin_profile_thumbs/a.png' }));
  const e = find(r, THUMB);
  ok('THUMB_URL (profileURL) is present', !!e);
  ok('it carries the thumb URL', e && e.value.indexOf('skin_profile_thumbs') !== -1);
  ok('entity id uses the key "user"', e && e.user === 'p1');
  ok('prop key uses the key "field"', e && Object.prototype.hasOwnProperty.call(e, 'field'));
  ok('value uses the key "value"', e && Object.prototype.hasOwnProperty.call(e, 'value'));
  // The old obfuscated key names would silently write into v["undefined"] and render nothing.
  ok('no stale obfuscated key names leak into the entry',
    e && !('Qwhkhza' in e) && !('Qcxi0k5' in e) && !('Qcou9jy' in e));
}

console.log('\n── rarity frame ──');
{
  const r = roster(session({ skinRarity: 'Rare' }));
  const e = find(r, RARITY);
  ok('rarity prop (skinTier) is present', !!e, 'the avatar frame class comes from this');
  ok('it carries the tier string', e && e.value === 'Rare');
}

console.log('\n── clan insignia needs BOTH halves ──');
{
  // Link prop present but no image -> the client's guard leaves the insignia empty.
  const linkOnly = roster(session({ clanLink: 'https://ev.io/clan/1' }));
  ok('clan link prop (clanHomepage) is sent when set', !!find(linkOnly, CLAN_LINK));
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

console.log('\n── weapon skins: current field names pass the join/live-update allow-list ──');
{
  // applyLiveLoadout's allow-list (and the equivalent one in the join handler) must accept
  // exactly the 6 current AdditionalUserInfo weapon-skin field names and reject anything else —
  // the old obfuscated names (Qcdgi7s etc.) no longer exist in the 1-7-1 bundle at all, so a
  // leftover allow-list still keyed on them would silently drop every weapon skin.
  const mk = (id) => ({
    sessionId: id, playerId: id, accepted: true, displayName: id, uid: 7,
    playerState: srv.createPlayerSimState({ x: 0, y: 2, z: 0, yaw: 0 }, id),
    ws: { readyState: 1, OPEN: 1, send() {} },
    pendingPeerBootstraps: [],
  });
  const a = mk('a');
  const sessions = new Map([['a', a]]);
  srv.applyLiveLoadout(a, a.playerState, JSON.stringify({
    weaponSkins: {
      autoRifleSkinUrl: 'https://ev.io/sites/default/files/skins/auto.evskin',
      swordSkinUrl: 'https://ev.io/sites/default/files/skins/sword.evskin',
      Qcdgi7s: 'https://ev.io/sites/default/files/skins/stale-key.evskin',
      notAWeaponField: 'https://ev.io/should-not-pass.evskin',
    },
  }), sessions);
  ok('a current field name (autoRifleSkinUrl) is kept',
    a.weaponSkins && a.weaponSkins.autoRifleSkinUrl === 'https://ev.io/sites/default/files/skins/auto.evskin');
  ok('another current field name (swordSkinUrl) is kept',
    a.weaponSkins && a.weaponSkins.swordSkinUrl === 'https://ev.io/sites/default/files/skins/sword.evskin');
  ok('the old obfuscated key (Qcdgi7s) is dropped', a.weaponSkins && !('Qcdgi7s' in a.weaponSkins));
  ok('an unrecognized key is dropped', a.weaponSkins && !('notAWeaponField' in a.weaponSkins));

  const roster2 = srv.buildPropRoster(sessions);
  const auto = roster2.find((e) => e.field === 'autoRifleSkinUrl');
  ok('the kept weapon skin reaches the ~3 roster under its own field name',
    !!auto && auto.user === 'a' && auto.value === 'https://ev.io/sites/default/files/skins/auto.evskin');
}

console.log('\n── multiple players each get their own entries ──');
{
  const a = session({ sessionId: 'a', thumbUrl: 'http://x/a.png' });
  const b = session({ sessionId: 'b', thumbUrl: 'http://x/b.png' });
  const r = srv.buildPropRoster(new Map([['a', a], ['b', b]]));
  const thumbs = r.filter((e) => e.field === THUMB);
  ok('one avatar entry per player', thumbs.length === 2, `got ${thumbs.length}`);
  ok('keyed by their own sessionId',
    thumbs.some((e) => e.user === 'a') && thumbs.some((e) => e.user === 'b'));
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
