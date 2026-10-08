# Architecture

This doc explains how the whole server fits together, assuming no prior knowledge of
networked multiplayer games, this codebase's conventions, or ev.io itself. If you can read
JavaScript and want to actually change something, start here, then jump into the file the
relevant section points at.

## Table of contents

1. [What this project actually is](#1-what-this-project-actually-is)
2. [The core idea: server-authoritative netcode](#2-the-core-idea-server-authoritative-netcode)
3. [The tick loop — the heartbeat of the whole server](#3-the-tick-loop--the-heartbeat-of-the-whole-server)
4. [The wire protocol: opcodes, msgpack, and those `Qxxxxxx` names](#4-the-wire-protocol-opcodes-msgpack-and-those-qxxxxxx-names)
5. [A player's whole lifecycle, end to end](#5-a-players-whole-lifecycle-end-to-end)
6. [File map, grouped by subsystem](#6-file-map-grouped-by-subsystem)
7. [The settings registry](#7-the-settings-registry)
8. [Bots](#8-bots)
9. [Maps](#9-maps)
10. [The two transports: WebSocket and WebRTC](#10-the-two-transports-websocket-and-webrtc)
11. [The admin dashboard](#11-the-admin-dashboard)
12. [The test suite](#12-the-test-suite)
13. ["I want to change X — where do I look?"](#13-i-want-to-change-x--where-do-i-look)

---

## 1. What this project actually is

[ev.io](https://ev.io) is a browser-based multiplayer first-person shooter. Like almost all
competitive multiplayer games, the *official* version has two halves: a **client** (the
JavaScript that runs in your browser, drawing the game and reading your mouse/keyboard) and a
**server** (a program, running somewhere else, that decides what's actually true — where
everyone really is, who actually got shot, who actually died).

This repo **is a replacement for that server half.** It's not a mod of the official game, and
it doesn't touch the official client's code. It's a completely separate program that happens to
speak the exact same network protocol the official client already expects, well enough that an
unmodified copy of the real ev.io client can connect to it and play, thinking it's talking to the
official server. People use it to self-host private matches — with friends, with bots, on a map
rotation they control, with settings (damage, bot count, round length...) the official game
never exposes.

Getting here required **reverse-engineering**: downloading the public, minified client code,
figuring out what each piece of it does, and porting the parts that matter (movement, combat,
scoring) to run here instead. That history explains a few things that otherwise look strange
about this codebase — see [§4](#4-the-wire-protocol-opcodes-msgpack-and-those-qxxxxxx-names).

## 2. The core idea: server-authoritative netcode

If you've never worked on a multiplayer game before, here's the one concept that makes
everything else in this codebase make sense.

Imagine two players, Alice and Bob, both running around a map. Each of their computers only
*directly* knows what their own keyboard/mouse is doing. For Alice's screen to show Bob moving,
something has to tell her computer where Bob actually is — and that something is the server.

The naive approach — let each player's computer decide its own position and just tell everyone
else — is exactly how cheating happens: a modified client can just lie ("I am standing right next
to you, and I just one-shot you"). **Server-authoritative** means the opposite: the server is the
one and only place that decides where everyone really is, who hit whom, who's dead. Clients send
their *inputs* ("W key held, mouse moved this much"), never their *outcomes*. The server runs the
same physics/combat logic against those inputs and tells every client what actually happened.

This has a real cost: network latency. By the time your "I pressed W" message reaches the server,
some time has passed. By the time the server's "you moved forward" message reaches you back,
more time has passed. A few techniques in this codebase exist specifically to make that latency
invisible (or at least fair) to players:

- **Client-side prediction** (lives in the *client*, not here) — your own screen shows you moving
  immediately, without waiting for the server to confirm it, then quietly corrects itself if the
  server ever disagrees ("reconciliation").
- **Lag compensation** (`local_ws_server.js`, search `withLagComp`) — when you shoot, the server
  doesn't check your shot against where a target *is right now*; it rewinds the target to where
  *your screen was actually showing them* a fraction of a second ago, because that's what you
  were really aiming at. Without this, fast-moving targets are almost always missed "behind."
- **Peer position smoothing** (search `PEER_SMOOTH`) — a laggy player's true position can arrive
  in bursts; everyone else's screen eases toward it instead of snapping, so it doesn't look like
  constant teleporting.

None of this is unique to ev.io — it's the standard toolkit for any real-time multiplayer game.
What *is* specific to this project is that the physics and combat math itself is **ported
directly from the real client's own code**, not re-derived from scratch. That's deliberate: an
approximation that's merely "close enough" still drifts from what the client predicts, and that
drift shows up as visible correction snaps. Running the *exact same math* server-side, bit for
bit, is what makes the server's answer and the client's own prediction agree almost always.

## 3. The tick loop — the heartbeat of the whole server

Real-time games don't process events as they happen; they process the whole world in small,
fixed time slices called **ticks**. This server runs at **20 ticks per second** (one tick every
50ms — see `EVIO_TICK_MS`), matching the official client's own rate exactly. Once a tick starts:

1. Every connected player's buffered inputs (movement keys, mouse look, fire/reload/throw) since
   the last tick are drained and fed through the physics step.
2. Bots get a tick of their own AI logic (see [§8](#8-bots)), producing synthetic "input" exactly
   like a real player's.
3. Game-world things that aren't tied to a specific player advance: grenades fuse and explode,
   weapon pickups respawn, the match/round timer counts down, regeneration ticks.
3. A **state packet** describing everything that changed is built for every connected player and
   sent out.

This whole sequence is `runGlobalTickInner` in `local_ws_server.js` — the single most important
function to read if you want to understand "what happens every 50ms." Almost everything else in
the file is either (a) something that function calls, or (b) a one-time thing that happens
outside the loop (a player joining, a WebSocket message arriving, the admin dashboard changing a
setting).

## 4. The wire protocol: opcodes, msgpack, and those `Qxxxxxx` names

Two things make this codebase look unusual the first time you open `local_ws_server.js`, and
both come directly from how it was reverse-engineered.

**msgpack, not JSON.** Every state update the server sends is a big flat array, encoded with
[MessagePack](https://msgpack.org/) (`encode`/`decode`, from `@msgpack/msgpack`) instead of JSON
— smaller and faster to parse, which matters at 20 messages/second to every connected player.
The array itself is a sequence of **opcode, value, opcode, value, ...** pairs — e.g. `[127, 4,
136, -27.0, 12.8, 33.5]` might mean "opcode 127 (equipped weapon) = 4, then opcode 136 (position)
= (-27.0, 12.8, 33.5)". The official client has its own big internal table mapping each opcode
number to what it means and what it does with it (update a health bar, play a sound, move a
model...). **This server has to emit the exact opcode numbers the real client expects**, or the
client either ignores the field or — worse — misinterprets it as something else entirely.

**Why fields are named `Qxxxxxx` instead of something readable.** The official client ships as
one large, *minified* JavaScript file: every variable and property name has been shortened by the
build tool to something meaningless like `Qdsukt4` or `Qa7phk3`, and that's *all that exists* —
there's no original source, no symbol table, nothing to recover the "real" name from. Reverse
engineering this project means reading that minified code, figuring out what a given `Qxxxxxx`
field actually represents (by tracing how it's used, what triggers it, what changing it visibly
does), and documenting that in a comment — but the identifier itself is left exactly as the
client spells it. This is intentional, not laziness: it means you can **search the actual client
bundle for the exact same string** to verify a comment's claim yourself, or to find the handful of
places this server still needs to match that nobody's looked at yet. Renaming it to something
readable would sever that traceability. So the convention throughout this codebase is:

```js
// Qalaptp / opcode 181. The client enforces spawn protection with this: refuses to register a
// hit on itself while positive (`if (Qalaptp > 0) return null`).
if (victim._ps && victim._ps.Qalaptp > 0) return;
```

— a short, honest field name, immediately followed by a comment that tells you what it actually
means and (usually) exactly where in the client's own code that was confirmed. When you're
reading a `Qxxxxxx` you don't recognize, the comment right above or after it is almost always
where its meaning is explained the first time it appears in the file; after that, later
occurrences assume you've already read that one.

## 5. A player's whole lifecycle, end to end

Reading the whole 11,000-line `local_ws_server.js` top to bottom isn't the way in — following one
player's journey through it is. Function names below are what to search for.

1. **Connection.** A client opens a WebSocket to this server. `wss.on("connection", handleConnection)`
   fires, creating a `session` object (connection-level state: the socket, rate-limit counters,
   what tick they last acknowledged) and a `playerState` (everything about their character:
   position, health, weapon, ability charges — built by `createPlayerSimState`).
2. **Join.** The client's first real message is a join payload (uid, display name, loadout,
   skin). The server validates it, resolves their starting weapon/ability loadout, places them at
   a spawn point, and sends back a **first-spawn packet** — the one-time "here is the entire
   current world, and here is you" bootstrap (`buildFirstSpawnBody`). From here the player is
   `accepted` and included in the tick loop.
3. **Every tick, while they're connected:** their buffered inputs get drained and run through
   `phys` (the ported client physics — movement, jumping, collision), any fire/reload/throw
   actions they queued get resolved (hitscan, grenades, melee — all in `local_ws_server.js`,
   search `fireWeapon`), and a per-recipient tick body describing what changed is built and sent
   (`appendPlayerTickBody`/`buildTickBody`).
4. **Taking damage.** Someone else's shot (or a bot's) resolves against this player's
   lag-compensated hitbox (see [§2](#2-the-core-idea-server-authoritative-netcode)). If it lands,
   `applyDamage` runs — armor first, then health, spawn-protection and hold-state checks, the
   death transition if health hits 0.
5. **Death and respawn.** `deathStateTimer` counts down a fixed number of ticks (matching the
   official respawn delay) before `respawnPlayerNow` picks a fresh spawn point and resets their
   combat state.
6. **Disconnect.** The WebSocket closes (tab closed, crash, kicked from the admin dashboard). The
   session and player state are torn down, and every other connected player gets told this player
   is gone (so their model disappears instead of standing frozen forever).

Grenades, pickups, and bots follow very similar but separate lifecycles of their own — see
`activeEntities` (grenades/thrown items), `processWeaponPickups`, and [§8](#8-bots).

## 6. File map, grouped by subsystem

| File | What it's for |
|---|---|
| `local_ws_server.js` | The big one. WebSocket listener, join/accept, the tick loop, weapons, combat, grenades, scoring, bots, map rotation, settings wiring — most of the actual game lives here. Large because the real client's own protocol doesn't decompose into small independent pieces; see [§13](#13-i-want-to-change-x--where-do-i-look) for how to navigate it by topic instead of by file. |
| `physics_world.js` | Loads one map (geometry, spawn points, pickup locations), builds the 3D collision world physics_extracted.js steps against, and resolves spawn points onto the real floor. |
| `physics_extracted.js` | The client's own movement/physics code (walking, jumping, sliding, collision), ported to run here — see [§2](#2-the-core-idea-server-authoritative-netcode) for why this is ported rather than reimplemented. |
| `state_builder.js` | Builds the specific wire-format packets (full state, first-spawn, loadout delta) that get sent to clients — the "turn server-side state into the opcode arrays described in [§4](#4-the-wire-protocol-opcodes-msgpack-and-those-qxxxxxx-names)" layer. |
| `settings.js` | The live-tunable settings registry — see [§7](#7-the-settings-registry). |
| `admin_server.js` | The live admin dashboard (HTTP server on a separate port) — see [§11](#11-the-admin-dashboard). |
| `health_server.js` | A tiny, optional `/healthz` endpoint for uptime monitoring. Unrelated to gameplay. |
| `map_loader.js` | Downloads, parses, and disk-caches a map on demand — see [§9](#9-maps). |
| `map_teleporters.js` | Map portal/teleporter pairs (a small, self-contained piece of map logic, split out because it's genuinely independent of everything else). |
| `bot_difficulty.js` | The bot skill-curve model (reaction time, aim spread, etc. as a function of bot level) — see [§8](#8-bots). |
| `navmesh_pathfinder.js` | Bot pathfinding over a navigation mesh derived from the map geometry. |
| `ability_stats.js` | Static data tables: what each ability (grenade type, teleport, etc.) costs, how long its cooldown/timer is. |
| `netlib_adapter.js` | Adapts the optional WebRTC transport so a peer connection looks enough like a plain WebSocket that the rest of the server can't tell the difference — see [§10](#10-the-two-transports-websocket-and-webrtc). |
| `vendor/netlib.js` | The built third-party WebRTC/signaling library `netlib_adapter.js` depends on (ISC-licensed, not written by this project). |
| `default_map.evmap`, `maps.json`, `weapons.json` | Data tables (map geometry, the map catalogue, weapon stats) extracted from the public client — data, not code. |
| `scripts/test_*.js` | The test suite — see [§12](#12-the-test-suite). |
| `deploy/` | VPS provisioning/deploy scripts — infrastructure, not game logic. |
| `netlib-signaling/` | A separate, self-hostable Go program: the signaling server WebRTC peers need to find each other. Its own project, vendored in this repo for convenience. |
| `userscript/` | The client-side Tampermonkey script that points a real browser at this server instead of the official one. |

## 7. The settings registry

Nearly every tunable number or toggle in this server (there are roughly 160) goes through one
system, declared in `settings.js`. The file's own top-of-file comment is the authoritative
explanation of exactly how it resolves env-var vs. saved-file vs. default precedence — read that
first if you're touching it. The short version: anywhere you see

```js
let WALK_SPEED = S.define({ key: "walkSpeed", env: "EVIO_WALK_SPEED", type: "number", def: 9 },
  (v) => { WALK_SPEED = v; });
```

that single call (a) reads `EVIO_WALK_SPEED` from the environment at startup if it's set, (b)
registers the setting so the admin dashboard can list, describe, and live-edit it, and (c)
re-assigns the plain `WALK_SPEED` variable whenever it changes — so every other place in the file
that just reads `WALK_SPEED` keeps working unmodified, with no awareness that it's "a setting" at
all.

## 8. Bots

Bots are sessions exactly like a real player's (`isBot: true`, same `playerState` shape), fed
synthetic input once per tick (`driveBotFrame`) instead of real WebSocket messages — which is why
nearly every other system (damage, scoring, the wire protocol) treats them identically to a real
player without needing special cases. What *is* bot-specific:

- **`bot_difficulty.js`** — a skill curve: given a bot's level (1-10), it returns reaction time,
  aim spread, and a few other knobs. Higher level = faster, more accurate, more tactical.
- **`navmesh_pathfinder.js`** — turns the map's collision geometry into a walkable graph so bots
  can path to a target or patrol, rather than walking straight into walls.
- **Simulated latency** (`BOT_SIM_LATENCY_MS`) — a bot's lag-compensation math is deliberately fed
  a fake, nonzero ping, so a bot doesn't get an unfair, instant read of the true game state the
  way an actual zero-latency "AI" would.
- **Sword bots** are a separate flavor (melee-only, their own combat AI frame — search
  `_swordCombatFrame`/`isSwordBot`) with their own count/level settings, since a melee bot's
  tactics (rushing, dodging) don't resemble a gun bot's (holding a position, peeking).

## 9. Maps

ev.io ships with roughly 50 maps. `map_loader.js` downloads one on demand (or uses the disk
cache in `map_cache/` on subsequent loads), and `physics_world.js` parses its geometry into a
real 3D collision world. Switching maps mid-session (from the admin dashboard, or
`EVIO_STARTUP_MAP` at boot) tears down and rebuilds that world without needing to restart the
whole process. `map_teleporters.js` handles the subset of maps that have portal pairs — walking
into one teleports you to its linked partner.

## 10. The two transports: WebSocket and WebRTC

By default, this server only speaks plain WebSocket (`EVIO_LOCAL_PORT`, matching the official
game). There's a second, **optional**, **additive** transport: WebRTC, via a vendored fork of
[netlib](https://github.com/proofnetworks/netlib) (`netlib_adapter.js` + `vendor/netlib.js`).
Turning it on (`EVIO_NETLIB_ENABLED=1`) starts a second listener *alongside* the WebSocket one —
it never replaces it, and every connection either transport accepts is handled by the exact same
join/tick/combat code from here on. The reason it exists: WebSocket runs over TCP, which
guarantees packets arrive in order — at the cost that one lost packet stalls *everything* behind
it until it's resent ("head-of-line blocking"). On a genuinely lossy connection that stall is
worse than just dropping that one stale update and moving on, which is what WebRTC's unreliable
data channel does. `netlib_adapter.js`'s own header comment explains exactly how a WebRTC peer is
wrapped to look enough like a plain `ws` socket that the rest of the server can't tell the two
apart.

## 11. The admin dashboard

A separate HTTP server (`admin_server.js`, default port 8081, loopback-only) that shows live
server status and lets you edit any setting from [§7](#7-the-settings-registry) while the server
keeps running — no restart, no dropped players. It can also kick/kill/heal/teleport players and
switch maps. See the README's own "Admin dashboard" section for the security note on why it's
loopback-only by default and how to reach it remotely safely (an SSH tunnel, not opening it to the
public internet).

## 12. The test suite

`scripts/test_*.js` — currently around 85 files, each run as a plain Node script
(`node scripts/test_whatever.js`) rather than through a test framework, and wired into `npm test`
via `package.json`'s scripts. Nearly every one of them exists **because a real, reported bug got
a regression test written against it**, and most start with a comment block explaining exactly
what went wrong, what the client does that caused it, and what the fix was — read that comment
before the code in any test file you're trying to understand; it's usually more informative than
the assertions themselves. `scripts/open_spawn.js` is the one shared test helper (boots a
minimal physics world a test can spawn a fake session into, without needing a real network
connection).

When you fix a bug or change behavior that a client can observe, the expected contribution is a
new test file (or an addition to an existing relevant one) that fails before your fix and passes
after — see `CONTRIBUTING.md` for the exact pattern to follow.

## 13. "I want to change X — where do I look?"

| If you want to... | Start here |
|---|---|
| Change how fast players move/jump/slide | `physics_extracted.js` (the ported client physics) |
| Change weapon damage, fire rate, or add a weapon | `weapons.json` (the data) + `local_ws_server.js`'s `fireWeapon`/`applyHit`/`WEAPON_*` lookups |
| Change how hit detection/lag compensation works | `local_ws_server.js`, search `withLagComp` |
| Change scoring/medals | `local_ws_server.js`, search `medalScore`/`awardMedal` |
| Change bot behavior or difficulty | `bot_difficulty.js` (the curve), `local_ws_server.js`'s `driveBotFrame`/`_aimAndFire`/`_navigate`/`_swordCombatFrame` |
| Add or change a runtime-tunable setting | `settings.js`'s `S.define` pattern — [§7](#7-the-settings-registry) |
| Change what the admin dashboard shows/can do | `admin_server.js` |
| Add support for a new map feature | `physics_world.js` (geometry/collision) or `map_teleporters.js` (portals) depending on what the feature is |
| Understand a specific wire field (`Qxxxxxx` or an opcode number) | Search `local_ws_server.js` for that exact string first — it's almost certainly already explained the first time it appears — see [§4](#4-the-wire-protocol-opcodes-msgpack-and-those-qxxxxxx-names) |
| Add a WebRTC-specific fix | `netlib_adapter.js` |
| Change deploy/provisioning | `deploy/` |

If none of these fit, `local_ws_server.js`'s own section comments (search for lines starting
`// ──`) are the next-best map — the file is long, but it's organized into named sections in a
fairly consistent order (settings → physics glue → combat → grenades → scoring → bots → the tick
loop → connection handling).
