// ==UserScript==
// @name         ev.io - Custom Server
// @namespace    evio-local-research
// @version      1.2
// @description  Play ev.io on a custom server, over WebSocket or WebRTC. Official by default; press "Join Test Server" to switch.
// @match        https://ev.io/*
// @run-at       document-start
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @require      https://your-netlib-signaling-domain.example/netlib-client.js
// ==/UserScript==

// EDIT THE @require ABOVE before using the WebRTC transport: it must point at the
// netlib-client.js your OWN netlib-signaling deployment serves (see netlib-signaling/README.md —
// it's served as a static file alongside the signaling server itself, same domain). The
// `your-netlib-signaling-domain.example` placeholder deliberately does not resolve (.example is
// reserved by IANA for exactly this) — until you edit it, the WebRTC transport fails closed with
// a clear console error, and you can still play over WebSocket from the gear menu in the meantime.
//
// This loads proofnetworks/netlib's browser build (netlib-vendor/dist/legacy.js). Tampermonkey
// runs @require'd scripts in the SAME sandbox as this file, so the global it sets (`window.netlib`)
// lands on the userscript's own sandbox `window` — the bare identifier below, NOT
// `unsafeWindow`/`PAGE` (those are the real page's globals, a different object entirely; see where
// PAGE is defined just below). Getting this backwards is a silent failure: `netlib` would read as
// undefined with no error, since `unsafeWindow.netlib` is simply never set by @require.

// Play ev.io on a custom server.
//
// Official play is the DEFAULT — nothing is routed until you press "Join Test Server".
// The gear button sets the server address(es) and transport; all of it is remembered.
//
// See userscript/README.md for setup (especially the @require line, if you want WebRTC).


(function () {
    'use strict';

    var _con = console;
    var PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

    var MAX_TICKS_PER_FRAME = 6;
    var MAX_BULLET_TRAILS   = 40;

    var BLOCKED_DOMAINS = [
        'intergient.com','iqzonertb.live','criteo.com','ssp-sync.criteo.com',
        'sync.iqzonertb.live','pb.intergient.com','cdn.intergient.com',
        'gamedistribution.com','html5.api.gamedistribution.com',
        'gto5.com','adnxs.com','rubiconproject.com','openx.net',
        'pubmatic.com','adsrvr.org','casalemedia.com','smartadserver.com',
        'contextweb.com','bidswitch.net','taboola.com',
    ];
    var BLOCKED_URL_PATTERNS = ['ramp.js','ramp.min.js'];

    function isDomainBlocked(url) {
        try {
            var h = new URL(url).hostname, p = new URL(url).pathname;
            if (BLOCKED_DOMAINS.some(function(d){ return h===d || h.slice(-(d.length+1))==='.'+ d; })) return true;
            return BLOCKED_URL_PATTERNS.some(function(pat){ return p.indexOf(pat)!==-1; });
        } catch(e){ return false; }
    }

    _con.log('%c[evio-fix] v14.0 loading','background:#1565c0;color:#fff;font-weight:bold;padding:3px 8px;border-radius:4px');

    function readCustomConfig() {
        var q = new URLSearchParams(location.search || '');
        var enabled = q.get('evioCustom') === '1' || localStorage.getItem('evioCustomEnabled') === '1';
        var serverUrl = q.get('server') || localStorage.getItem('evioCustomServer') || 'ws://127.0.0.1:8080/';
        if (serverUrl && !/\/$/.test(serverUrl)) serverUrl += '/';
        return {
            enabled: !!enabled,
            serverUrl: serverUrl,
            lobbyId: q.get('lobby') || localStorage.getItem('evioCustomLobby') || 'custom-local',
            region: q.get('region') || localStorage.getItem('evioCustomRegion') || 'custom',
            gamemode: q.get('mode') || localStorage.getItem('evioCustomMode') || 'deathmatch',
            map: q.get('map') || localStorage.getItem('evioCustomMap') || '',
            // 'ws' is the default — it works against a server the moment it's running, no extra
            // setup. netlib/WebRTC (routes the game socket over a WebRTC data channel instead of
            // raw WebSocket, to avoid TCP head-of-line blocking on lossy connections) is opt-in:
            // switch to it in the gear menu, or ?transport=netlib — but it also needs a
            // netlib-signaling deployment on the server side (see netlib-signaling/README.md) and
            // the @require line pointed at it, neither of which exist until you set them up.
            transport: q.get('transport') || localStorage.getItem('evioCustomTransport') || 'ws',
            netlibGameId: q.get('netlibGameId') || localStorage.getItem('evioCustomNetlibGameId')
                || '0d6a3b8e-6b8b-4f0a-9a2b-3a6e7b7a2b39', // must match the server's netlibGameId setting
            // No default here on purpose — unlike the WS address (loopback is a real, working
            // default), a netlib signaling URL always needs to be a real wss:// endpoint (a plain
            // ws:// one is blocked as mixed content on this https:// page even for localhost), so
            // there is no default that would actually work. Set it in the gear menu once you have
            // your own netlib-signaling deployment (see netlib-signaling/README.md).
            netlibSignalingUrl: q.get('netlibSignalingUrl') || localStorage.getItem('evioCustomNetlibSignalingUrl') || '',
            socketLog: [],
            networkLog: [],
        };
    }

    if (localStorage.getItem('evioCS_initialised') !== '1') {
        localStorage.setItem('evioCS_initialised', '1');
        localStorage.setItem('evioCustomEnabled', '0');
    }

    PAGE.__EVIO_CUSTOM__ = readCustomConfig();

    PAGE.__EVIO_HB2__ = false;

    PAGE.__EVIO_PRESERVE_RECON__ = function (oldState, newState) {
        try {
            var cfg = PAGE.__EVIO_CUSTOM__;
            if (cfg && cfg.enabled && oldState && newState) {
                newState.Qcrzrpr = oldState.Qcrzrpr;
                newState.Qd0yy90 = oldState.Qd0yy90;

                newState.Qq1azjr = oldState.Qq1azjr;
                newState.Qq1azd5 = oldState.Qq1azd5;
                newState.Qm2pxgr = oldState.Qm2pxgr;
                if (oldState.Qwf7j5k) newState.Qwf7j5k = oldState.Qwf7j5k;
            }
        } catch (e) { }
        return newState;

    };

    PAGE.__EVIO_SHOTRAY__ = function (origin, dir, sid) {
        try {
            var cfg = PAGE.__EVIO_CUSTOM__;
            if (!cfg || !cfg.enabled || !origin || !dir) return;
            var sock = PAGE.__EVIO_GAME_SOCKET__;
            if (!sock || sock.readyState !== 1) return;
            var r = function (n) { return Math.round(n * 1000) / 1000; };
            var msg = '#SHOT#' + r(origin.x) + ',' + r(origin.y) + ',' + r(origin.z) + ','
                    + r(dir.x) + ',' + r(dir.y) + ',' + r(dir.z);
            if (sid != null && sid !== '') msg += ',' + sid;
            sock.send(msg);
        } catch (e) { }
    };

    PAGE.__EVIO_CUSTOM__.snapWatchdog = {
        enabled: true,
        thresholdUnits: 6,
        minTicks: 5,
        cooldownMs: 500,
        snaps: 0,
        nanRecoveries: 0,
        streak: 0, lastSnapAt: 0, lastDist: 0, maxDist: 0,
        log: true,
    };
    PAGE.__EVIO_CUSTOM__.snapStats = function () {
        var W = this.snapWatchdog;
        _con.log('[evio-snapwd] snaps=' + W.snaps + ' nanRecoveries=' + W.nanRecoveries
            + ' lastDist=' + W.lastDist.toFixed(2) + 'u maxDist=' + W.maxDist.toFixed(2)
            + 'u threshold=' + W.thresholdUnits + 'u enabled=' + W.enabled);
        return W;
    };

    PAGE.__EVIO_SNAPWD__ = function (recon, serverState) {
        var W = PAGE.__EVIO_CUSTOM__ && PAGE.__EVIO_CUSTOM__.snapWatchdog;
        if (!W || !W.enabled || !PAGE.__EVIO_CUSTOM__.enabled) return;

        var sid = recon.Qa1zep6;
        var pd  = serverState && serverState.Qaol467;
        var se  = pd && pd.Qa7phk3 && pd.Qa7phk3[sid];
        var cur = recon.Qobex5y && recon.Qobex5y.Qcvr9bt;
        var ce  = cur && cur.Qh33ug3;
        if (!se || !ce || !se.Qdsukt4 || !ce.Qdsukt4) return;

        if (se.Qyxhj60 !== 1) { W.streak = 0; return; }

        var fin3 = function (v) { return !!v && isFinite(v.x) && isFinite(v.y) && isFinite(v.z); };
        var now = performance.now(), dist = 0;

        if (!fin3(ce.Qdsukt4) || (ce.Qyaswvo && !fin3(ce.Qyaswvo))) {
            if (!fin3(se.Qdsukt4)) return;
            W.nanRecoveries++;
            W.streak = W.minTicks;
            W.lastSnapAt = 0;
            if (W.log) _con.log('%c[evio-snapwd] NaN in prediction — forcing recovery snap',
                'background:#b71c1c;color:#fff;padding:2px 6px;border-radius:3px');
        } else {
            var dx = se.Qdsukt4.x - ce.Qdsukt4.x,
                dy = se.Qdsukt4.y - ce.Qdsukt4.y,
                dz = se.Qdsukt4.z - ce.Qdsukt4.z;
            dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            W.lastDist = dist;
            if (dist > W.maxDist) W.maxDist = dist;
            if (dist < W.thresholdUnits) { W.streak = 0; return; }
            if (++W.streak < W.minTicks) return;
            if (now - W.lastSnapAt < W.cooldownMs) return;
        }
        if (!fin3(se.Qdsukt4)) return;

        var apply = function (entity) {
            if (!entity || !entity.Qdsukt4) return;
            entity.Qdsukt4.x = se.Qdsukt4.x;
            entity.Qdsukt4.y = se.Qdsukt4.y;
            entity.Qdsukt4.z = se.Qdsukt4.z;
            if (entity.Qyaswvo) {
                var sv = fin3(se.Qyaswvo) ? se.Qyaswvo : { x: 0, y: 0, z: 0 };
                entity.Qyaswvo.x = sv.x; entity.Qyaswvo.y = sv.y; entity.Qyaswvo.z = sv.z;
            }
            entity.Q9t2fit = se.Q9t2fit;
            entity.Qac6dfa = se.Qac6dfa;
            entity.Q2r3ysn = se.Q2r3ysn;
        };

        apply(ce);
        if (recon.Qobex5z && recon.Qobex5z.Qcvr9bt) apply(recon.Qobex5z.Qcvr9bt.Qh33ug3);

        W.snaps++; W.streak = 0; W.lastSnapAt = now;
        if (W.log) _con.log('%c[evio-snapwd] SNAP #' + W.snaps + ' — ' + dist.toFixed(2)
            + 'u gap held for ' + W.minTicks + ' packets; position+velocity reset to server',
            'background:#b71c1c;color:#fff;padding:2px 6px;border-radius:3px');
    };

    (function installIdentityCapture() {
        if (PAGE.__EVIO_IDENTITY_HOOK__ || typeof PAGE.fetch !== 'function') return;
        PAGE.__EVIO_IDENTITY_HOOK__ = true;
        var nativeFetch = PAGE.fetch;

        function resolveSkinUrl(skinNid) {
            var skins = PAGE.__EVIO_SKINS__;
            if (skinNid == null || !skins) return null;
            var e = skins[String(skinNid)];
            if (e && e.field_skin) return 'https://ev.io' + e.field_skin;
            return null;
        }
        var _clan = { img: null, link: null };
        function clanOverrideLoaded() {
            try {
                var i = localStorage.getItem('evioClanImg'), l = localStorage.getItem('evioClanLink');
                if (i) _clan.img = i;
                if (l) _clan.link = l;
            } catch (_) {}
            return !!(_clan.img && _clan.link);
        }
        function scanForClan(node, depth) {
            if (!node || depth > 6 || (_clan.img && _clan.link)) return;
            if (typeof node === 'string') {
                if (!_clan.img && node.indexOf('/insignias/') !== -1) {
                    _clan.img = /^https?:/i.test(node) ? node : ('https://ev.io/' + node.replace(/^\/*/, '/'));
                } else if (!_clan.link) {
                    var m = /^\/?group\/(\d+)$/.exec(node);
                    if (m) _clan.link = '/group/' + m[1];
                }
                return;
            }
            if (typeof node !== 'object') return;
            if (Array.isArray(node)) { for (var i = 0; i < node.length; i++) scanForClan(node[i], depth + 1); return; }
            for (var k in node) {
                if (!Object.prototype.hasOwnProperty.call(node, k)) continue;
                if (!_clan.link && /^(gid|group_?id|clan_?id)$/i.test(k)) {
                    var v = node[k];
                    if (typeof v === 'number' || (typeof v === 'string' && /^\d+$/.test(v))) _clan.link = '/group/' + v;
                }
                scanForClan(node[k], depth + 1);
            }
        }

        PAGE.__EVIO_SOCIAL_SEEN__ = {};
        PAGE.__EVIO_SOCIAL_MSG__ = function (raw) {
            var m;
            try { m = JSON.parse(raw); } catch (_) { return; }
            if (!m || typeof m !== 'object') return;
            var _h = m.header || '(no header)';
            if (!PAGE.__EVIO_SOCIAL_SEEN__) PAGE.__EVIO_SOCIAL_SEEN__ = {};
            if (!PAGE.__EVIO_SOCIAL_SEEN__[_h]) {
                PAGE.__EVIO_SOCIAL_SEEN__[_h] = 0;
                _con.log('%c[evio-social] first ' + _h, 'color:#9c27b0');
            }
            PAGE.__EVIO_SOCIAL_SEEN__[_h]++;
            var img = null, link = null;
            if (m.header === 'clanInfo') {
                img = m.insignia || null;
                link = m.homepage || null;
            } else if ((m.header === 'channelMessage' || m.header === 'whisperReceive') && m.insignia) {
                var prof0 = PAGE.__EVIO_PROFILE__;
                var mine = m.uid !== undefined ? m.uid : m.fromUid;
                if (prof0 && mine !== undefined && parseInt(mine, 10) === parseInt(prof0.uid, 10)) {
                    img = m.insignia;
                }
            }
            if (!img && !link) return;
            if (img && !_clan.img) {
                _clan.img = /^https?:/i.test(img) ? img : ('https://ev.io/' + String(img).replace(/^\/*/, '/'));
            }
            if (link && !_clan.link) {
                _clan.link = /^https?:/i.test(link) ? link : ('/' + String(link).replace(/^\/*/, ''));
            }
            PAGE.__EVIO_CLAN__ = { img: _clan.img, link: _clan.link, raw: m };
            var prof = PAGE.__EVIO_PROFILE__;
            if (prof) {
                prof.clanImgUrl = _clan.img;
                prof.clanLink = _clan.link;
                maybePushLoadoutUpdate(prof);
            }
            _con.log('%c[evio-identity] clan captured (' + m.header + '): img=' + _clan.img
                + ' link=' + _clan.link, 'color:#00bcd4;font-weight:bold');
        };

        function extractClanForUid(data, uid, username) {
            var uidStr = String(uid), nameStr = String(username || "").toLowerCase();
            var best = null;
            (function walk(n, depth) {
                if (!n || depth > 8 || typeof n !== "object" || best) return;
                if (Array.isArray(n)) { for (var i = 0; i < n.length && !best; i++) walk(n[i], depth + 1); return; }
                var insignia = null, link = null, cid = null, ids = {}, names = [];
                for (var k in n) {
                    if (!Object.prototype.hasOwnProperty.call(n, k)) continue;
                    var v = n[k];
                    if (typeof v === "string" && v.indexOf("/insignias/") !== -1) insignia = v;
                    else if (typeof v === "string" && /homepage|clan_?url|link|path/i.test(k)) link = v;
                    if (/^(cid|gid|id|group_?id|clan_?id|nid)$/i.test(k)) cid = String(v);
                    if (!/^(deployed|members?|players?|uids?|users?|roster)$/i.test(k)) continue;
                    var flat = (typeof v === "string") ? v : (typeof v === "number" ? String(v)
                             : (Array.isArray(v) ? v.join(",") : null));
                    if (!flat) continue;
                    var t = flat.match(/[0-9]+/g);
                    if (t) for (var j = 0; j < t.length; j++) ids[t[j]] = 1;
                    var nm = flat.toLowerCase().split(/\s*,\s*/);
                    for (var q = 0; q < nm.length; q++) if (nm[q]) names.push(nm[q]);
                }
                if (insignia && (ids[uidStr] || (nameStr && names.indexOf(nameStr) !== -1))) {
                    best = { insignia: insignia, link: link, gid: cid, node: n };
                    return;
                }
                for (var k2 in n) if (Object.prototype.hasOwnProperty.call(n, k2)) walk(n[k2], depth + 1);
            })(data, 0);
            return best;
        }
        function fetchClanData(prof) {
            if (!prof || prof.isGuest) return;
            if (_clan.img && _clan.link) return;
            try {
                nativeFetch('https://ev.io/clans-all3', { credentials: 'include' })
                    .then(function (r) { return r.ok ? r.json() : null; })
                    .then(function (data) {
                        if (!data) { _con.log('[evio-identity] clans-all3 returned no JSON'); return; }
                        PAGE.__EVIO_CLANS_RAW__ = data;
                        var hit = extractClanForUid(data, prof.uid, prof.name);
                        if (!hit) {
                            _con.log('%c[evio-identity] clans-all3 fetched but no clan matches uid='
                                + prof.uid + ' — inspect __EVIO_CLANS_RAW__', 'color:#ff9800');
                            return;
                        }
                        if (!_clan.img) {
                            _clan.img = /^https?:/i.test(hit.insignia) ? hit.insignia
                                : ('https://ev.io/' + String(hit.insignia).replace(/^\/*/, '/'));
                        }
                        if (!_clan.link) {
                            if (hit.link) _clan.link = (hit.link.charAt(0) === "/" || /^https?:/i.test(hit.link)) ? hit.link : ("/" + hit.link);
                            else if (hit.gid) _clan.link = "/group/" + hit.gid;
                        }
                        prof.clanImgUrl = _clan.img;
                        prof.clanLink = _clan.link;
                        PAGE.__EVIO_CLAN__ = { img: _clan.img, link: _clan.link, raw: hit.node };
                        _con.log('%c[evio-identity] clan resolved from clans-all3: img=' + _clan.img
                            + ' link=' + _clan.link, 'color:#00bcd4;font-weight:bold');
                        maybePushLoadoutUpdate(prof);
                    })
                    .catch(function (e) { _con.log('[evio-identity] clans-all3 fetch failed:', e && e.message); });
            } catch (_) {}
        }

        function resolveThumbUrl(skinNid) {
            var skins = PAGE.__EVIO_SKINS__;
            if (skinNid == null || !skins) return null;
            var e = skins[String(skinNid)];
            if (e && e.field_profile_thumb) return 'https://ev.io/' + e.field_profile_thumb;
            return null;
        }
        function resolveSkinRarity(skinNid) {
            var skins = PAGE.__EVIO_SKINS__;
            if (skinNid == null || !skins) return null;
            var e = skins[String(skinNid)];
            return (e && (e.field_tier || e.field_rarity)) || null;
        }
        function resolveWeaponSkinUrl(skinNid) {
            var skins = PAGE.__EVIO_SKINS__;
            if (skinNid == null || !skins) return null;
            var e = skins[String(skinNid)];
            if (e && e.field_model) return 'https://ev.io/' + e.field_model;
            return null;
        }
        var WEAPON_SKIN_MAP = [
            { acct: 'field_auto_rifle_skin',  prop: 'Qcdgi7s' },
            { acct: 'field_hand_cannon_skin', prop: 'Qy8jpjd' },
            { acct: 'field_laser_rifle_skin', prop: 'Qclpb4q' },
            { acct: 'field_burst_rifle_skin', prop: 'Qb9vw3f' },
            { acct: 'field_sweeper_skin',     prop: 'Ql3d4qw' },
            { acct: 'field_sword_skin',       prop: 'Q53m0bo' }
        ];
        function resolveWeaponSkins(acc) {
            var out = {};
            WEAPON_SKIN_MAP.forEach(function (m) {
                var fld = acc[m.acct];
                var nid = fld && fld[0] && fld[0].target_id;
                nid = (nid === undefined || nid === null) ? null : parseInt(nid, 10);
                if (!nid) return;
                var url = resolveWeaponSkinUrl(nid);
                if (url) out[m.prop] = url;
            });
            return out;
        }

        function looksLikeAccount(o) {
            return o && o.uid && o.uid[0] && o.uid[0].value !== undefined && o.uid[0].value !== null;
        }
        function extractAccount(data) {
            if (looksLikeAccount(data)) return data;
            if (data && looksLikeAccount(data.account)) return data.account;
            if (Array.isArray(data)) {
                var guest = null;
                for (var i = 0; i < data.length; i++) {
                    var a = looksLikeAccount(data[i]) ? data[i] : (data[i] && data[i].account);
                    if (!looksLikeAccount(a)) continue;
                    if (a.uid[0].value === 17) guest = a; else return a;
                }
                return guest;
            }
            return null;
        }

        function readLocalLoadout() {
            try {
                var raw = localStorage.getItem('ev_settings_k');
                if (!raw) return null;
                var s = JSON.parse(raw);
                if (!s || typeof s !== 'object') return null;
                var build = s.abilityBuild;
                if (typeof build === 'string') { try { build = JSON.parse(build); } catch (_) { build = null; } }
                var pw = parseInt(s.primaryWeaponId, 10);
                return {
                    primaryWeaponId: Number.isFinite(pw) ? pw : NaN,
                    abilityBuild: Array.isArray(build) ? build : null,
                };
            } catch (e) { return null; }
        }

        function captureAccount(data) {
            var acc = extractAccount(data);
            if (!acc) return;
            var loadoutRaw = (acc.field_abilities_loadout && acc.field_abilities_loadout[0] && acc.field_abilities_loadout[0].value) || null;
            var abilitySeed = null;
            if (loadoutRaw) { try { abilitySeed = JSON.parse(loadoutRaw); } catch (_) {} }
            var primaryWeapon = (acc.field_primary_weapon && acc.field_primary_weapon[0] && acc.field_primary_weapon[0].value);
            primaryWeapon = (primaryWeapon === undefined || primaryWeapon === null) ? NaN : parseInt(primaryWeapon, 10);

            var localCfg = readLocalLoadout();
            if (!Number.isFinite(primaryWeapon) && localCfg && Number.isFinite(localCfg.primaryWeaponId)) {
                primaryWeapon = localCfg.primaryWeaponId;
            }
            if ((!Array.isArray(abilitySeed) || !abilitySeed.length) && localCfg && Array.isArray(localCfg.abilityBuild)) {
                abilitySeed = localCfg.abilityBuild;
            }
            var prof = {
                uid: acc.uid[0].value,
                name: (acc.name && acc.name[0] && acc.name[0].value) || 'Guest',
                isGuest: acc.uid[0].value === 17,
                abilityLoadoutId: Number.isFinite(primaryWeapon) ? primaryWeapon : null,
                skinTargetId: (acc.field_eq_skin && acc.field_eq_skin[0] && acc.field_eq_skin[0].target_id) || null,
                abilitySeed: Array.isArray(abilitySeed) ? abilitySeed : null,
            };
            prof.skinUrl = resolveSkinUrl(prof.skinTargetId);
            prof.thumbUrl = resolveThumbUrl(prof.skinTargetId);
            prof.skinRarity = resolveSkinRarity(prof.skinTargetId);
            clanOverrideLoaded();
            scanForClan(acc, 0);
            prof.clanImgUrl = _clan.img;
            prof.clanLink = _clan.link;
            fetchClanData(prof);
            prof.weaponSkins = resolveWeaponSkins(acc);
            PAGE.__EVIO_AUTH__ = acc;
            PAGE.__EVIO_PROFILE__ = prof;
            _con.log('%c[evio-identity] captured profile uid=' + prof.uid + ' name=' + JSON.stringify(prof.name)
                + (prof.isGuest ? ' (guest)' : ' (registered)') + ' primaryWeapon=' + prof.abilityLoadoutId
                + ' skin=' + prof.skinTargetId + ' skinUrl=' + prof.skinUrl
                + ' weaponSkins=' + Object.keys(prof.weaponSkins).length, 'color:#00bcd4;font-weight:bold');
            maybePushLoadoutUpdate(prof);
        }

        function watchLocalLoadout() {
            setInterval(function () {
                try {
                    var cfg = PAGE.__EVIO_CUSTOM__;
                    if (!cfg || !cfg.enabled) return;
                    var prof = PAGE.__EVIO_PROFILE__;
                    if (!prof) return;
                    var local = readLocalLoadout();
                    if (!local) return;
                    var changed = false;
                    if (Number.isFinite(local.primaryWeaponId) && local.primaryWeaponId !== prof.abilityLoadoutId) {
                        prof.abilityLoadoutId = local.primaryWeaponId;
                        changed = true;
                    }
                    if (Array.isArray(local.abilityBuild)
                        && JSON.stringify(local.abilityBuild) !== JSON.stringify(prof.abilitySeed)) {
                        prof.abilitySeed = local.abilityBuild;
                        changed = true;
                    }
                    if (changed) maybePushLoadoutUpdate(prof);
                } catch (e) { }
            }, 1000);
        }

        var _lastLoadoutKey = null;
        function maybePushLoadoutUpdate(prof) {
            try {
                var key = JSON.stringify([prof.abilityLoadoutId, prof.abilitySeed, prof.skinUrl,
                                          prof.weaponSkins, prof.thumbUrl, prof.skinRarity,
                                          prof.clanImgUrl, prof.clanLink]);
                if (key === _lastLoadoutKey) return;
                var firstCapture = _lastLoadoutKey === null;
                _lastLoadoutKey = key;
                if (firstCapture) return;
                var sock = PAGE.__EVIO_GAME_SOCKET__;
                if (!sock || sock.readyState !== 1) return;
                sock.send('#EVL#' + JSON.stringify({
                    abilityLoadoutId: prof.abilityLoadoutId,
                    abilitySeed: prof.abilitySeed,
                    skinUrl: prof.skinUrl,
                    weaponSkins: prof.weaponSkins,
                    thumbUrl: prof.thumbUrl,
                    skinRarity: prof.skinRarity,
                    clanImgUrl: prof.clanImgUrl,
                    clanLink: prof.clanLink,
                }));
                _con.log('%c[evio-identity] pushed LIVE loadout update -> server (weapon=' + prof.abilityLoadoutId
                    + ' sprintLvl=' + (prof.abilitySeed ? prof.abilitySeed[2] : '?') + ')', 'color:#00bcd4;font-weight:bold');
            } catch (_) {}
        }

        function captureSkins(list) {
            if (!Array.isArray(list)) return;
            var map = {};
            for (var i = 0; i < list.length; i++) {
                var s = list[i];
                if (s && s.nid !== undefined) map[String(s.nid)] = s;
            }
            PAGE.__EVIO_SKINS__ = map;
            _con.log('%c[evio-identity] skins catalogue captured: ' + list.length + ' entries', 'color:#00bcd4');
            var prof = PAGE.__EVIO_PROFILE__;
            if (prof) {
                if (!prof.skinUrl && prof.skinTargetId != null) prof.skinUrl = resolveSkinUrl(prof.skinTargetId);
                if (!prof.thumbUrl && prof.skinTargetId != null) prof.thumbUrl = resolveThumbUrl(prof.skinTargetId);
                if (!prof.skinRarity && prof.skinTargetId != null) prof.skinRarity = resolveSkinRarity(prof.skinTargetId);
                if (PAGE.__EVIO_AUTH__ && (!prof.weaponSkins || !Object.keys(prof.weaponSkins).length)) {
                    prof.weaponSkins = resolveWeaponSkins(PAGE.__EVIO_AUTH__);
                }
                _con.log('%c[evio-identity] resolved own skinUrl=' + prof.skinUrl + ' weaponSkins=' + Object.keys(prof.weaponSkins || {}).length, 'color:#00bcd4');
            }
        }

        PAGE.fetch = function (input, init) {
            var url = '';
            try { url = typeof input === 'string' ? input : (input && input.url) || ''; } catch (_) {}
            var p = nativeFetch.apply(this, arguments);
            try {
                if (/\/(me|user\/\d+)\?_format=json/.test(url)) {
                    p.then(function (res) {
                        try { res.clone().json().then(captureAccount).catch(function () {}); } catch (_) {}
                    }).catch(function () {});
                } else if (/\/all-skins(\?|$)/.test(url)) {
                    p.then(function (res) {
                        try { res.clone().json().then(captureSkins).catch(function () {}); } catch (_) {}
                    }).catch(function () {});
                }
            } catch (_) {}
            return p;
        };
        _con.log('%c[evio-identity] fetch hook installed', 'color:#00bcd4');
        watchLocalLoadout();

        try {
            nativeFetch('https://ev.io/all-skins', { headers: { Accept: 'application/json' } })
                .then(function (r) { return r.json(); })
                .then(captureSkins)
                .catch(function (e) { _con.warn('[evio-identity] all-skins fetch failed', e); });
        } catch (_) {}
    })();

    // ── netlib/WebRTC fake WebSocket (see the netlib migration plan) ──────────────────────────
    // A WebSocket-SHAPED object backed by a netlib Network instead of a real browser WebSocket —
    // there is no native object to wrap here, unlike RoutedWebSocket's normal path, so every
    // property/method the ev.io bundle might touch on a WebSocket has to be emulated by hand:
    // readyState/CONNECTING..CLOSED, binaryType, send()/close(), addEventListener/removeEventListener,
    // AND the on* property form (some code sets .onmessage directly rather than addEventListener,
    // same as native WebSocket supports both — this must too).
    //
    // Authority protocol (see server/netlib_adapter.js + the migration plan's corrected
    // "Authority protocol" section): there is no fixed lobby code and no `lobby.creator` field in
    // this library version, so trust is established by (1) list()-discovering the one lobby
    // carrying customData.app === LOBBY_APP_MARKER, (2) joining it, (3) reading
    // customData.serverPeerId from what join() returns, and (4) accepting messages ONLY from a
    // peer whose id matches that value. Any other peer that somehow ends up in this lobby is
    // silently ignored, never trusted, at the message-dispatch level below.
    var NETLIB_LOBBY_APP_MARKER = 'evio-custom-server';
    var NETLIB_PING = '\u0000EVIO_PING';
    var NETLIB_PONG = '\u0000EVIO_PONG';

    function NetlibFakeSocket(cfg) {
        this.readyState = 0; // CONNECTING
        this.binaryType = 'blob'; // matches native WebSocket's own default; bundle may override it
        this.url = 'netlib://' + cfg.netlibGameId;
        this._listeners = { open: [], message: [], close: [], error: [] };
        this.onopen = null; this.onmessage = null; this.onclose = null; this.onerror = null;
        this._network = null;
        this._serverPeerId = null;
        this._closedAlready = false;
        this._connect(cfg);
    }
    NetlibFakeSocket.prototype.CONNECTING = 0;
    NetlibFakeSocket.prototype.OPEN = 1;
    NetlibFakeSocket.prototype.CLOSING = 2;
    NetlibFakeSocket.prototype.CLOSED = 3;

    NetlibFakeSocket.prototype.addEventListener = function (type, fn) {
        if (!this._listeners[type]) this._listeners[type] = [];
        this._listeners[type].push(fn);
    };
    NetlibFakeSocket.prototype.removeEventListener = function (type, fn) {
        var list = this._listeners[type];
        if (!list) return;
        var idx = list.indexOf(fn);
        if (idx !== -1) list.splice(idx, 1);
    };
    NetlibFakeSocket.prototype._dispatch = function (type, evt) {
        evt = evt || {};
        evt.type = type;
        evt.target = this;
        var direct = this['on' + type];
        if (typeof direct === 'function') {
            try { direct.call(this, evt); } catch (e) { _con.error('[evio-netlib] on' + type + ' handler threw', e); }
        }
        var list = this._listeners[type];
        if (list) {
            list.slice().forEach(function (fn) {
                try { fn.call(this, evt); } catch (e) { _con.error('[evio-netlib] ' + type + ' listener threw', e); }
            }, this);
        }
    };

    NetlibFakeSocket.prototype.send = function (data) {
        if (this.readyState !== 1) {
            _con.warn('[evio-netlib] send() while not OPEN (readyState=' + this.readyState + '); dropped, same as a real WebSocket would refuse it');
            return;
        }
        // Same channel-routing rule as the server adapter (server/netlib_adapter.js): binary
        // (per-tick input) already tolerates loss by design in this protocol, so it goes on the
        // unreliable channel — the actual fix for head-of-line blocking. Strings (join, RPCs)
        // need guaranteed ordered delivery, so they go on the reliable channel.
        var isBinary = typeof data !== 'string';
        var channel = isBinary ? 'unreliable' : 'reliable';
        try {
            this._network.send(channel, this._serverPeerId, data);
        } catch (e) {
            _con.error('[evio-netlib] send failed', e);
        }
    };

    NetlibFakeSocket.prototype.close = function (code, reason) {
        if (this._closedAlready) return;
        this._closedAlready = true;
        this.readyState = 3;
        try { if (this._network) this._network.leave(); } catch (_) {}
        this._dispatch('close', { code: code || 1000, reason: reason || '', wasClean: true });
    };

    NetlibFakeSocket.prototype._connect = function (cfg) {
        var self = this;
        var lib = (typeof window !== 'undefined' && window.netlib) || (typeof unsafeWindow !== 'undefined' && unsafeWindow.netlib);
        if (!lib || !lib.Network) {
            _con.error('[evio-netlib] netlib client library not found (window.netlib) — check the @require URL actually loaded and is reachable');
            setTimeout(function () {
                self.readyState = 3;
                self._dispatch('error', {});
                self._dispatch('close', { code: 1006, reason: 'netlib library missing', wasClean: false });
            }, 0);
            return;
        }

        var network = new lib.Network(cfg.netlibGameId, lib.DefaultRTCConfiguration, cfg.netlibSignalingUrl);
        self._network = network;

        network.on('message', function (peer, channel, data) {
            // The core of the authority check: a message from anyone other than the verified
            // server peer is discarded here, before it ever reaches the ev.io bundle's own
            // message handler. Mirrors how local_ws_server.js already never trusts client-
            // reported state — this is the client-side half of the same rule.
            if (peer.id !== self._serverPeerId) return;
            if (data === NETLIB_PING) { try { network.send('reliable', peer.id, NETLIB_PONG); } catch (_) {} return; }
            if (data === NETLIB_PONG) return; // no client-side heartbeat sweep reads this yet
            var isBinary = typeof data !== 'string';
            var payload = data;
            if (isBinary && self.binaryType === 'blob' && typeof Blob !== 'undefined' && !(data instanceof Blob)) {
                payload = new Blob([data]);
            }
            self._dispatch('message', { data: payload });
        });

        network.on('disconnected', function (peer) {
            if (peer.id !== self._serverPeerId) return;
            self.close(1006, 'server peer disconnected');
        });
        network.on('signalingerror', function (err) { _con.error('[evio-netlib] signaling error', err); });
        network.on('rtcerror', function (err) { _con.error('[evio-netlib] rtc error', err); });

        new Promise(function (resolve, reject) {
            network.once('ready', resolve);
            network.once('failed', function () { reject(new Error('netlib signaling failed')); });
        })
            .then(function () { return network.list({}, {}, 50); })
            .then(function (lobbies) {
                var target = (lobbies || []).filter(function (l) {
                    return l && l.customData && l.customData.app === NETLIB_LOBBY_APP_MARKER;
                })[0];
                if (!target) throw new Error('no ' + NETLIB_LOBBY_APP_MARKER + ' lobby found via list() — is the server running with netlibEnabled=true?');
                return network.join(target.code).then(function (info) { return info || target; });
            })
            .then(function (lobbyInfo) {
                var serverPeerId = lobbyInfo && lobbyInfo.customData && lobbyInfo.customData.serverPeerId;
                if (!serverPeerId) throw new Error('joined lobby has no customData.serverPeerId — refusing to trust it as the server');
                self._serverPeerId = serverPeerId;
                // The data-channel handshake with the server peer can finish before OR after
                // join() resolves — check both, rather than only ever listening forward.
                var already = network.peers.get(serverPeerId);
                if (already) {
                    self.readyState = 1;
                    self._dispatch('open', {});
                    return;
                }
                network.on('connected', function onConnected(peer) {
                    if (peer.id !== serverPeerId) return;
                    network.off('connected', onConnected);
                    self.readyState = 1;
                    self._dispatch('open', {});
                });
            })
            .catch(function (err) {
                _con.error('[evio-netlib] connect failed', err);
                self.readyState = 3;
                self._dispatch('error', {});
                self._dispatch('close', { code: 1006, reason: String((err && err.message) || err), wasClean: false });
            });
    };

    function isEvioSocialSocket(url) {
        return typeof url === 'string' && url.indexOf('social.ev.io') !== -1;
    }

    function isEvioGameSocket(url) {
        if (typeof url !== 'string') return false;
        if (isEvioSocialSocket(url)) return false;
        return /wss?:\/\/evio-[^/]+\.rivet\.game\/?/i.test(url) || /wss?:\/\/evio-[^/]+/i.test(url);
    }

    (function installCustomWebSocketRouter() {
        if (!PAGE.WebSocket || PAGE.__EVIO_CUSTOM_WS_ROUTER__) return;
        PAGE.__EVIO_CUSTOM_WS_ROUTER__ = true;

        var NativeWebSocket = PAGE.WebSocket;

        function RoutedWebSocket(url, protocols) {
            var originalUrl = String(url || '');
            var finalUrl = url;
            var cfg = PAGE.__EVIO_CUSTOM__ || { enabled:false };
            var rewrite = false;

            try {
                if (cfg.enabled && cfg.serverUrl && isEvioGameSocket(originalUrl)) {
                    finalUrl = cfg.serverUrl;
                    rewrite = true;
                    cfg.serverAuthoritativeSlide = cfg.forceServerAuthoritativeSlide === true;
                }

                if (cfg.socketLog && cfg.socketLog.length < 200) {
                    cfg.socketLog.push({
                        at: Date.now(),
                        originalUrl: originalUrl,
                        finalUrl: String(finalUrl || ''),
                        rewrite: rewrite,
                        social: isEvioSocialSocket(originalUrl),
                        game: isEvioGameSocket(originalUrl),
                    });
                }

                if (rewrite) {
                    if (cfg.transport === 'netlib') {
                        _con.log('%c[evio-custom] game socket routed over netlib/WebRTC', 'color:#ff9800;font-weight:bold', originalUrl);
                    } else {
                        _con.log('%c[evio-custom] game WebSocket routed', 'color:#ff9800;font-weight:bold', originalUrl, '=>', finalUrl);
                    }
                } else if (cfg.enabled) {
                    _con.debug('[evio-custom] WebSocket left untouched:', originalUrl);
                }
            } catch (e) {
                _con.warn('[evio-custom] WebSocket router error; using original URL', e);
                finalUrl = url;
            }

            // netlib is only ever substituted for the GAME socket (rewrite === true); the social
            // socket and any other WebSocket the page opens always get a real native one, same as
            // before this transport existed.
            var sock = (rewrite && cfg.transport === 'netlib')
                ? new NetlibFakeSocket(cfg)
                : (protocols !== undefined ? new NativeWebSocket(finalUrl, protocols) : new NativeWebSocket(finalUrl));

            if (isEvioSocialSocket(originalUrl)) {
                try {
                    sock.addEventListener('message', function (ev) {
                        try {
                            if (typeof ev.data !== 'string') return;
                            if (PAGE.__EVIO_SOCIAL_MSG__) PAGE.__EVIO_SOCIAL_MSG__(ev.data);
                        } catch (_) {}
                    });
                } catch (_) {}
            }

            if (rewrite) {
                PAGE.__EVIO_GAME_SOCKET__ = sock;
                try {
                    var nativeSend = sock.send.bind(sock);
                    sock.send = function (data) {
                        try {
                            if (typeof data === 'string' && data.charAt(0) === ';' && data.length > 1) {
                                var prof = PAGE.__EVIO_PROFILE__;
                                if (prof) {
                                    var obj = JSON.parse(data.slice(1));
                                    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
                                        if (obj.name === undefined && prof.name) obj.name = prof.name;
                                        if (obj.uid === undefined && prof.uid !== undefined) obj.uid = prof.uid;
                                        if (obj.abilityLoadoutId === undefined && prof.abilityLoadoutId != null) obj.abilityLoadoutId = prof.abilityLoadoutId;
                                        if (obj.abilitySeed === undefined && prof.abilitySeed) obj.abilitySeed = prof.abilitySeed;
                                        if (obj.skinUrl === undefined && prof.skinUrl) obj.skinUrl = prof.skinUrl;
                                        if (obj.thumbUrl === undefined && prof.thumbUrl) obj.thumbUrl = prof.thumbUrl;
                                        if (obj.skinRarity === undefined && prof.skinRarity) obj.skinRarity = prof.skinRarity;
                                        if (obj.clanImgUrl === undefined && prof.clanImgUrl) obj.clanImgUrl = prof.clanImgUrl;
                                        if (obj.clanLink === undefined && prof.clanLink) obj.clanLink = prof.clanLink;
                                        if (obj.weaponSkins === undefined && prof.weaponSkins && Object.keys(prof.weaponSkins).length) obj.weaponSkins = prof.weaponSkins;
                                        data = ';' + JSON.stringify(obj);
                                        _con.log('%c[evio-identity] join augmented: name=' + JSON.stringify(prof.name) + ' uid=' + obj.uid + ' skinUrl=' + (prof.skinUrl || '(default)'), 'color:#00bcd4;font-weight:bold');
                                    }
                                }
                            }
                        } catch (_) {  }
                        return nativeSend(data);
                    };
                } catch (e) {
                    _con.warn('[evio-identity] join-augment wrap failed', e);
                }
            }
            return sock;
        }

        RoutedWebSocket.prototype = NativeWebSocket.prototype;
        RoutedWebSocket.CONNECTING = NativeWebSocket.CONNECTING;
        RoutedWebSocket.OPEN = NativeWebSocket.OPEN;
        RoutedWebSocket.CLOSING = NativeWebSocket.CLOSING;
        RoutedWebSocket.CLOSED = NativeWebSocket.CLOSED;
        PAGE.WebSocket = RoutedWebSocket;
        _con.log('%c[evio-custom] WebSocket router installed (guarded)', 'color:#4caf50');
    })();


    var _intercepted = false;

    function patchAndInject(src) {
        if (_intercepted) return;
        _intercepted = true;
        _con.log('%c[evio-fix] intercepted ' + src.split('?')[0],'color:#2196f3;font-weight:bold');

        GM_xmlhttpRequest({
            method : 'GET',
            url    : src,
            headers: { 'Cache-Control':'no-cache', 'Pragma':'no-cache' },
            onload : function(res) {
                try {
                    var patched = patchBundle(res.responseText);
                    var blob    = new Blob([patched], { type:'text/javascript' });
                    var s = _origCE.call(document, 'script');
                    s.src = URL.createObjectURL(blob);
                    document.head.appendChild(s);
                    _con.log('%c[evio-fix] patched bundle injected','background:#4caf50;color:#000;font-weight:bold;padding:2px 6px;border-radius:3px');
                } catch(e) {
                    _con.error('[evio-fix] patch error, falling back to original:', e);
                    var s2 = _origCE.call(document, 'script');
                    s2.src = src;
                    document.head.appendChild(s2);
                }
            },
            onerror: function() {
                _con.error('[evio-fix] fetch failed, loading original');
                var s3 = _origCE.call(document, 'script');
                s3.src = src;
                document.head.appendChild(s3);
            },
        });
    }

    function isBundle(v) { return typeof v==='string' && v.indexOf('bundle.js')!==-1; }

    var _bundleObserver = new MutationObserver(function(muts) {
        for (var mi=0; mi<muts.length; mi++) {
            var nodes = muts[mi].addedNodes;
            for (var ni=0; ni<nodes.length; ni++) {
                var nd = nodes[ni];
                if (nd.tagName==='SCRIPT' && isBundle(nd.src || nd.getAttribute('src'))) {
                    if (_intercepted) return;
                    var url = nd.src || nd.getAttribute('src');
                    nd.type = 'javascript/blocked';
                    nd.removeAttribute('src');
                    try { nd.parentNode && nd.parentNode.removeChild(nd); } catch(e){}
                    patchAndInject(url);
                    return;
                }
            }
        }
    });

    function startBundleObserver() {
        var root = document.documentElement || document.head || document;
        if (!root || !root.nodeType) {
            setTimeout(startBundleObserver, 0);
            return;
        }
        try {
            _bundleObserver.observe(root, { childList:true, subtree:true });
        } catch (e) {
            _con.warn('[evio-fix] bundle observer delayed:', e.message);
            setTimeout(startBundleObserver, 0);
        }
    }
    startBundleObserver();

    var _origCE   = Document.prototype.createElement;
    var _srcDesc  = Object.getOwnPropertyDescriptor(HTMLScriptElement.prototype,'src')
                 || Object.getOwnPropertyDescriptor(HTMLElement.prototype,'src')
                 || Object.getOwnPropertyDescriptor(Element.prototype,'src');
    var _ifDesc   = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype,'src');

    Document.prototype.createElement = (function(_super) {
        return function(tag) {
            var el = _super.apply(this, arguments);
            if (typeof tag !== 'string') return el;
            var t = tag.toLowerCase();

            if (t === 'script') {
                var _v = '';
                Object.defineProperty(el, 'src', {
                    get: function(){ return _v; },
                    set: function(val){
                        _v = val;
                        if (typeof val==='string' && isDomainBlocked(val)){ _con.debug('[evio-fix] blocked script:',val); return; }
                        if (isBundle(val)){ patchAndInject(val); return; }
                        if (_srcDesc && _srcDesc.set) _srcDesc.set.call(el, val);
                    },
                    configurable: true,
                });
            }

            if (t === 'iframe') {
                var _iv = '';
                Object.defineProperty(el, 'src', {
                    get: function(){ return _iv; },
                    set: function(val){
                        if (isDomainBlocked(val)){ _con.debug('[evio-fix] blocked iframe:',val); return; }
                        _iv = val;
                        if (_ifDesc && _ifDesc.set) _ifDesc.set.call(el, val);
                    },
                    configurable: true,
                });
            }

            return el;
        };
    }(Document.prototype.createElement));

    var _origSA = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function(name, value) {
        var n = name.toLowerCase();
        if (this.tagName==='SCRIPT' && n==='src' && isBundle(value)){ patchAndInject(value); return; }
        if (this.tagName==='IFRAME' && n==='src' && isDomainBlocked(value)) return;
        return _origSA.apply(this, arguments);
    };

    var _fetchOrig = PAGE.fetch;
    PAGE.fetch = function(input, init) {
        var url = typeof input==='string' ? input : (input && input.url)||'';
        if (isDomainBlocked(url)) return Promise.resolve(new Response('',{status:200}));
        return _fetchOrig.apply(this, arguments);
    };

    var XHR = PAGE.XMLHttpRequest || XMLHttpRequest;
    var _xhrOpen = XHR.prototype.open;
    var _xhrSend = XHR.prototype.send;
    XHR.prototype.open = function(m, url){
        this._evioUrl = url;
        this._evioMethod = m;
        return _xhrOpen.apply(this, arguments);
    };
    XHR.prototype.send = function(){
        if (isDomainBlocked(this._evioUrl||'')) {
            var self = this;
            Object.defineProperty(self,'readyState',  {get:function(){return 4;}});
            Object.defineProperty(self,'status',      {get:function(){return 200;}});
            Object.defineProperty(self,'responseText',{get:function(){return '';}});
            Object.defineProperty(self,'response',    {get:function(){return '';}});
            setTimeout(function(){
                self.dispatchEvent(new ProgressEvent('readystatechange'));
                if (self.onreadystatechange) self.onreadystatechange();
                self.dispatchEvent(new ProgressEvent('load'));
                if (self.onload) self.onload();
            }, 0);
            return;
        }
        return _xhrSend.apply(this, arguments);
    };
    _con.log('%c[evio-fix] runtime fix 1 — ad blocker active','color:#4caf50');

    function patchBundle(src) {

        var patches = [

            {
                name: '6a  undefined player crash guard',
                from: 'var Q=n.Qa7phk3[p.Qxluan],f=hb.Qhkjwni.Qqg43ev().dataById[Q.Qslw9vf];',
                to:   'var Q=n.Qa7phk3[p.Qxluan];if(void 0===Q)continue;var f=hb.Qhkjwni.Qqg43ev().dataById[Q.Qslw9vf];',
            },
            {

                name: '6b7 custom-mode: skip pitch + pitchOffset (production comparator; see 6b9)',
                from: 'Math.abs(e.Qcrzrpr-t.Qcrzrpr)>1e-4||Math.abs(e.Qd0yy90-t.Qd0yy90)>1e-4||',
                to:   '(!(window.__EVIO_CUSTOM__&&window.__EVIO_CUSTOM__.enabled)&&(Math.abs(e.Qcrzrpr-t.Qcrzrpr)>1e-4||Math.abs(e.Qd0yy90-t.Qd0yy90)>1e-4))||',
            },
            {

                name: '6b9 custom-mode: skip pitch + pitchOffset in the DEBUG comparator (the live one)',
                from: "Math.abs(e.Qcrzrpr-t.Qcrzrpr)>1e-4&&n.push('pitch  =>  Server: '+JSON.stringify(e.Qcrzrpr)+'   Client: '+JSON.stringify(t.Qcrzrpr)),Math.abs(e.Qd0yy90-t.Qd0yy90)>1e-4&&n.push('pitchOffset  =>  Server: '+JSON.stringify(e.Qd0yy90)+'   Client: '+JSON.stringify(t.Qd0yy90)),",
                to:   "!(window.__EVIO_CUSTOM__&&window.__EVIO_CUSTOM__.enabled)&&(Math.abs(e.Qcrzrpr-t.Qcrzrpr)>1e-4&&n.push('pitch  =>  Server: '+JSON.stringify(e.Qcrzrpr)+'   Client: '+JSON.stringify(t.Qcrzrpr)),Math.abs(e.Qd0yy90-t.Qd0yy90)>1e-4&&n.push('pitchOffset  =>  Server: '+JSON.stringify(e.Qd0yy90)+'   Client: '+JSON.stringify(t.Qd0yy90))),",
            },
            {
                name: '6b8 custom-mode: preserve recoil + ammo through reconcile reset',
                from: 'this.Qxo2o14[t].Qt03jhz.Qcvr9bt=this.Qh23rk3.Q820rrc(e.body)',
                to:   'this.Qxo2o14[t].Qt03jhz.Qcvr9bt=(window.__EVIO_PRESERVE_RECON__?window.__EVIO_PRESERVE_RECON__(this.Qxo2o14[t].Qt03jhz.Qcvr9bt,this.Qh23rk3.Q820rrc(e.body)):this.Qh23rk3.Q820rrc(e.body))',
            },
            {
                name: 'CH1 custom-mode: send all chat over the game socket (social is dead)',
                from: "a.includes('/examine')||a.includes('/dance'))lb.Ql1g6nk.Qam4u9w.Qm0eht4({msg:a})",
                to:   "(window.__EVIO_CUSTOM__&&window.__EVIO_CUSTOM__.enabled)||a.includes('/examine')||a.includes('/dance'))lb.Ql1g6nk.Qam4u9w.Qm0eht4({msg:a})",
            },
            {
                name: 'SW1 desync watchdog: snap position+velocity on large sustained gap',
                from: 'this.Qy431ao=t,this.Qorty0h.push({sync:e.sync,clientTick:e.clientTick,body:t})',
                to:   'this.Qy431ao=t,this.Qorty0h.push({sync:e.sync,clientTick:e.clientTick,body:t});try{window.__EVIO_SNAPWD__&&window.__EVIO_SNAPWD__(this,t);}catch(_){}',
            },
            {
                name: 'CS1 expose latest confirmed server state (custom mode)',
                from: 'this.Qy431ao=t,this.Qorty0h.push({sync:e.sync,clientTick:e.clientTick,body:t})',
                to:   'this.Qy431ao=t,(window.__EVIO_CUSTOM__&&window.__EVIO_CUSTOM__.enabled&&(window.__EVIO_CONFIRMED__=t)),this.Qorty0h.push({sync:e.sync,clientTick:e.clientTick,body:t})',
            },
            {
                name: 'SR1 forward exact shot ray + sessionId to custom server',
                from: "u.push({Q7q6byi:f+':'+p+':'+a,Q616y7o:0,Qxluan:p,Qtql1ud:l.clone(),Qsjaj00:v,",
                to:   "(window.__EVIO_SHOTRAY__&&window.__EVIO_SHOTRAY__(l,v,f+':'+p+':'+a)),u.push({Q7q6byi:f+':'+p+':'+a,Q616y7o:0,Qxluan:p,Qtql1ud:l.clone(),Qsjaj00:v,",
            },
            {

                name: 'HB3 health-bar: guard the position lerp against a missing previous frame',
                from: 'n.copy(h.Qdsukt4).lerp(c.Qdsukt4,e.Qzh2kcz)',
                to:   'n.copy((h||c).Qdsukt4).lerp(c.Qdsukt4,e.Qzh2kcz)',
            },
            {
                name: 'HB2 health-bar: current HP from confirmed state (OFF by default, see __EVIO_HB2__)',
                from: 'var m=c.Qq7zdfv>h.Qq7zdfv?h.Qq7zdfv+(c.Qq7zdfv-h.Qq7zdfv)*e.Qzh2kcz:c.Qq7zdfv,g=c.Qd032mo>h.Qd032mo?h.Qd032mo+(c.Qd032mo-h.Qd032mo)*e.Qzh2kcz:c.Qd032mo,',

                to:   'var QhG=h||c,Qcc=(window.__EVIO_HB2__!==false&&window.__EVIO_CUSTOM__&&window.__EVIO_CUSTOM__.enabled&&window.__EVIO_CONFIRMED__&&window.__EVIO_CONFIRMED__.Qaol467&&window.__EVIO_CONFIRMED__.Qaol467.Qa7phk3&&window.__EVIO_CONFIRMED__.Qaol467.Qa7phk3[r])||c,m=Qcc.Qq7zdfv>QhG.Qq7zdfv?QhG.Qq7zdfv+(Qcc.Qq7zdfv-QhG.Qq7zdfv)*e.Qzh2kcz:Qcc.Qq7zdfv,g=Qcc.Qd032mo>QhG.Qd032mo?QhG.Qd032mo+(Qcc.Qd032mo-QhG.Qd032mo)*e.Qzh2kcz:Qcc.Qd032mo,',
            },
            {
                name: '6d3 clamp incoming Q1o1c43 to ±3',
                from: 'this.Qjdbmai=o.body,this.Q1o1c43=o.sync;',
                to:   'this.Qjdbmai=o.body,this.Q1o1c43=Math.max(-3,Math.min(3,o.sync));',
            },
            {
                name: '6d4 clamp Q1o1c43 in loading path',
                from: 'this.Q1o1c43=this.Qorty0h.length-1,this.Qobex5z',
                to:   'this.Q1o1c43=Math.min(this.Qorty0h.length-1,3),this.Qobex5z',
            },

            {
                name: 'K1  cap Qgx464 from server RTT delta to 3 ticks (150ms max)',
                from: 's>=0&&(this.Qgx464=s)',
                to:   's>=0&&(this.Qgx464=Math.min(s,3))',
            },
            {
                name: 'K2  cap Qgx464 no-state-increment to 3 ticks (150ms max)',
                from: 'this.Qjdbmah=this.Qjdbmai,this.Qgx464++,this.Qjtawf1',
                to:   'this.Qjdbmah=this.Qjdbmai,this.Qgx464=Math.min(this.Qgx464+1,3),this.Qjtawf1',
            },
        ];

        var applied = 0, skipped = [];
        for (var pi = 0; pi < patches.length; pi++) {
            var p = patches[pi];
            if (src.indexOf(p.from) !== -1) {
                src = src.replace(p.from, p.to);
                applied++;
                _con.log('%c[evio-fix] ✓ ' + p.name, 'color:#4caf50;font-weight:bold');
            } else {
                skipped.push(p.name);
                _con.warn('[evio-fix] ✗ ' + p.name + ' — not found (bundle may have updated)');
            }
        }

        var colour = applied === patches.length ? '#4caf50' : '#ff9800';
        _con.log(
            '%c[evio-fix] ' + applied + '/' + patches.length + ' patches applied' +
            (skipped.length ? ' | missed: ' + skipped.join(', ') : ' — ALL OK'),
            'background:' + colour + ';color:#000;font-weight:bold;padding:2px 6px;border-radius:3px'
        );
        return src;
    }

})();

(function customServerUI() {
    'use strict';
    var PAGE = (typeof unsafeWindow !== 'undefined' && unsafeWindow) || window;
    var K_ON = 'evioCustomEnabled', K_URL = 'evioCustomServer';
    var K_TRANSPORT = 'evioCustomTransport', K_NETLIB_URL = 'evioCustomNetlibSignalingUrl';
    var DEFAULT_URL = 'ws://127.0.0.1:8080/';

    function url()  { return localStorage.getItem(K_URL) || DEFAULT_URL; }
    function isOn() { return localStorage.getItem(K_ON) === '1'; }
    // 'ws' is the default transport — see readCustomConfig's own comment for why.
    function transport() { return localStorage.getItem(K_TRANSPORT) || 'ws'; }
    function netlibUrl()  { return localStorage.getItem(K_NETLIB_URL) || ''; }

    function hostPort() {
        try {
            var u = new URL(url().replace(/^ws/, 'http'));
            return u.host;
        } catch (e) { return '127.0.0.1:8080'; }
    }

    // Returns the normalized ws(s):// URL on success, or null on a malformed host:port — does NOT
    // write to localStorage itself, so the caller can validate everything before saving anything.
    function normalizeHostPort(hp) {
        var raw = String(hp || '').trim();
        var forced = /^wss?:\/\//i.test(raw) ? raw.slice(0, raw.indexOf(':')).toLowerCase() : null;
        hp = raw.replace(/^wss?:\/\//i, '').replace(/\/+$/, '');
        if (!hp) return null;
        if (!/^[\w.\-]+(:\d+)?$/.test(hp)) return null;
        var host = hp.split(':')[0];
        var loopback = (host === '127.0.0.1' || host === 'localhost' || host === '::1');
        var scheme = forced || (loopback ? 'ws' : 'wss');
        return scheme + '://' + hp + '/';
    }

    // A netlib signaling URL is a full URL (typically with a path, e.g. /netlib/v0/signaling),
    // not a bare host:port — validated as shape-only (scheme + something after it), not
    // reachability; the actual connection attempt is what surfaces a real failure.
    function normalizeNetlibUrl(raw) {
        raw = String(raw || '').trim();
        if (!raw) return null;
        if (!/^wss?:\/\/.+/i.test(raw)) return false; // false = "given but invalid", distinct from null = "not given"
        return raw;
    }

    function build() {
        if (document.getElementById('evio-cs-bar')) return;
        var bar = document.createElement('div');
        bar.id = 'evio-cs-bar';
        bar.style.cssText = 'position:fixed;left:450px;top:12px;z-index:2147483647;display:flex;' +
            'gap:14px;align-items:center;font:600 13px/1.2 system-ui,sans-serif;';

        var join = document.createElement('button');
        var gear = document.createElement('button');
        var btn = 'padding:8px 12px;border:0;border-radius:6px;cursor:pointer;color:#fff;' +
                  'box-shadow:0 2px 8px rgba(0,0,0,.4);';
        gear.style.cssText = btn + 'background:#455a64;padding:8px 10px;';
        gear.textContent = '⚙';
        gear.title = 'Set custom server address / transport';

        function paint() {
            var on = isOn();
            join.textContent = on ? 'Leave Test Server' : 'Join Test Server';
            join.style.cssText = btn + 'background:' + (on ? '#c62828' : '#2e7d32') + ';';
            join.title = on ? 'Click to return to official' : 'Connect to the test server';
        }
        join.onclick = function () {
            var turningOn = !isOn();
            localStorage.setItem(K_ON, turningOn ? '1' : '0');
            var base = location.origin + location.pathname;
            location.replace(turningOn ? base + '?evioCustom=1' : base);
        };

        var panel = document.createElement('div');
        panel.style.cssText = 'display:none;position:fixed;left:450px;top:56px;z-index:2147483647;' +
            'background:#263238;color:#fff;padding:12px;border-radius:8px;width:290px;' +
            'box-shadow:0 4px 16px rgba(0,0,0,.5);font:13px/1.4 system-ui,sans-serif;';
        var fieldStyle = 'width:100%;box-sizing:border-box;padding:6px;border-radius:4px;' +
            'border:1px solid #546e7a;background:#1c262b;color:#fff;';
        var miniLab = 'font-size:11px;color:#90a4ae;margin:8px 0 3px;';

        var lab = document.createElement('div');
        lab.textContent = 'Custom server';
        lab.style.cssText = 'font-weight:600;margin-bottom:6px;';

        var transLab = document.createElement('div');
        transLab.textContent = 'Transport';
        transLab.style.cssText = miniLab + 'margin-top:0;';
        var transSelect = document.createElement('select');
        transSelect.style.cssText = fieldStyle;
        [['ws', 'WebSocket — default'], ['netlib', 'WebRTC (UDP)']].forEach(function (opt) {
            var o = document.createElement('option');
            o.value = opt[0]; o.textContent = opt[1];
            transSelect.appendChild(o);
        });
        transSelect.value = transport();

        var wsLab = document.createElement('div');
        wsLab.textContent = 'WebSocket address';
        wsLab.style.cssText = miniLab;
        var wsInput = document.createElement('input');
        wsInput.value = hostPort();
        wsInput.placeholder = 'host:port';
        wsInput.style.cssText = fieldStyle;

        // Grouped in its own container so both the label and the input hide together — only
        // relevant (and only shown) while WebRTC is the selected transport, to avoid a WS-only
        // player wondering what this field is or whether they need to fill it in too.
        var netlibGroup = document.createElement('div');
        var netlibLab = document.createElement('div');
        netlibLab.textContent = 'WebRTC signaling URL';
        netlibLab.style.cssText = miniLab;
        var netlibInput = document.createElement('input');
        netlibInput.value = netlibUrl();
        netlibInput.placeholder = 'wss://your-domain/netlib/v0/signaling';
        netlibInput.style.cssText = fieldStyle;
        netlibGroup.appendChild(netlibLab);
        netlibGroup.appendChild(netlibInput);

        function updateFieldVisibility() {
            netlibGroup.style.display = transSelect.value === 'netlib' ? 'block' : 'none';
        }
        transSelect.onchange = updateFieldVisibility;
        updateFieldVisibility();

        var msg = document.createElement('div');
        msg.style.cssText = 'margin-top:6px;min-height:16px;font-size:12px;color:#90a4ae;';
        msg.textContent = 'Both addresses are remembered — switch transport any time without retyping either.';
        var save = document.createElement('button');
        save.textContent = 'Save';
        save.style.cssText = btn + 'background:#1565c0;margin-top:8px;width:100%;';
        save.onclick = function () {
            // Each address field only overwrites its saved value if the user actually typed
            // something — leaving one blank keeps whatever was there, so setting up WS and
            // WebRTC addresses is two independent, non-destructive edits, not one shared slot.
            var wsRaw = wsInput.value.trim();
            if (wsRaw) {
                var normalizedWs = normalizeHostPort(wsRaw);
                if (!normalizedWs) {
                    msg.style.color = '#ef9a9a';
                    msg.textContent = 'WebSocket address: expected host:port, e.g. 127.0.0.1:8080';
                    return;
                }
                localStorage.setItem(K_URL, normalizedWs);
            }
            var netlibRaw = netlibInput.value.trim();
            if (netlibRaw) {
                var normalizedNetlib = normalizeNetlibUrl(netlibRaw);
                if (normalizedNetlib === false) {
                    msg.style.color = '#ef9a9a';
                    msg.textContent = 'WebRTC signaling URL: expected a full wss:// URL';
                    return;
                }
                localStorage.setItem(K_NETLIB_URL, normalizedNetlib);
            }
            localStorage.setItem(K_TRANSPORT, transSelect.value);

            msg.style.color = '#a5d6a7';
            msg.textContent = 'Saved (' + (transSelect.value === 'netlib' ? 'WebRTC' : 'WebSocket') + ' active)'
                + (isOn() ? ' — reloading…' : '');
            paint();
            if (isOn()) setTimeout(function () {
                location.replace(location.origin + location.pathname + '?evioCustom=1');
            }, 600);
        };
        wsInput.onkeydown = function (e) { if (e.key === 'Enter') save.onclick(); };
        netlibInput.onkeydown = function (e) { if (e.key === 'Enter') save.onclick(); };
        gear.onclick = function () {
            panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
            if (panel.style.display === 'block') {
                transSelect.value = transport();
                wsInput.value = hostPort();
                netlibInput.value = netlibUrl();
                updateFieldVisibility();
                wsInput.focus();
            }
        };

        panel.appendChild(lab);
        panel.appendChild(transLab); panel.appendChild(transSelect);
        panel.appendChild(wsLab); panel.appendChild(wsInput);
        panel.appendChild(netlibGroup);
        panel.appendChild(msg); panel.appendChild(save);
        bar.appendChild(gear); bar.appendChild(join);
        paint();
        document.body.appendChild(bar);
        document.body.appendChild(panel);

    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', build);
    } else {
        build();
    }
    setInterval(function () { if (!document.getElementById('evio-cs-bar') && document.body) build(); }, 2000);
})();
