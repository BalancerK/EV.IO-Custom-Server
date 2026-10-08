# EV.IO Custom Server

A from-scratch, server-authoritative reimplementation of [ev.io](https://ev.io)'s game server —
physics, weapons, grenades, bots, scoring, maps, and netcode — that a stock, unmodified ev.io
client can connect to and play against, once pointed at it. Built by reverse-engineering the
public client protocol and porting its own extracted movement/combat code to run server-side, so
the server and client agree on physics bit-for-bit instead of approximating it.

This is a research/hobby project, not an official ev.io product and not affiliated with ev.io or
its operator. It is meant for private, local, or self-hosted play with people you know — see
[Scope and disclaimer](#scope-and-disclaimer).

**New to this codebase?** [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) explains how everything
fits together from scratch — no prior knowledge of networked games or this project assumed — and
[`CONTRIBUTING.md`](CONTRIBUTING.md) covers how to find a bug, write a test for it, and submit a
change.

## What's actually in here

- **A full server-authoritative simulation** (`physics_extracted.js` + `physics_world.js`):
  movement, jumping, sliding, sprint ramp-up, collision against the real map geometry, all run
  from the client's own extracted logic so the server's physics matches the client's frame-for-frame
  instead of drifting and fighting reconciliation.
- **Weapons and combat** (`local_ws_server.js`): hitscan with lag compensation, shotgun pellets,
  projectiles, melee, grenades (frag, impulse, smoke, flash, mine, tripmine), ability-based
  weapons, magazine/reserve ammo, reload, weapon pickups with a finite ammo pool, official medal-
  based scoring (kills, headshots, streaks, multi-kills, assists).
- **Bots** (`bot_difficulty.js` + bot logic in `local_ws_server.js`): a skill-curve difficulty
  model, pathfinding (`navmesh_pathfinder.js`), and simulated network latency so a bot's reaction
  time and aim are comparable to a real player's, not an instant, unfair read of the true game
  state.
- **Maps** (`map_loader.js`, `map_teleporters.js`): on-demand map loading/conversion/caching, and
  portal/teleporter support.
- **Two transports, same protocol**: the default WebSocket listener, and an optional WebRTC
  transport (`netlib_adapter.js`, built on a vendored fork of
  [netlib](https://github.com/proofnetworks/netlib)) that runs *alongside* it — useful on lossy
  connections where TCP head-of-line blocking makes a WebSocket feel worse than it should. Off by
  default; every peer either transport accepts goes through the exact same connection/session code.
- **A live admin dashboard** (`admin_server.js`): every one of this server's ~160 runtime settings
  is editable while it's running, no restart, no dropped players — tick rate, damage scale, bot
  count/difficulty, netcode smoothing, feature toggles, all of it. Loopback-only by default; see
  [Admin dashboard](#admin-dashboard).
- **A real test suite** (`scripts/test_*.js`, ~80 files, wired into `npm test`): correctness tests
  for physics parity, netcode edge cases, weapon behavior, bot AI, admin auth, and more — written
  against real reported bugs, not just happy paths.

## Quick start

```bash
npm install
npm start
```

This starts the game server on `ws://127.0.0.1:8080` and the admin dashboard on
`http://127.0.0.1:8081`. Point a client at `127.0.0.1:8080` (see
[Connecting a client](#connecting-a-client)) and play.

Run the test suite:

```bash
npm test               # every test
npm run test:combat    # a single suite — see package.json's scripts for the full list
```

One suite (`test:browser`, included in `npm test`) drives a real headless browser via Playwright
and needs its browser binaries installed once first, or it fails on a fresh clone:

```bash
npx playwright install chromium
```

## Connecting a client

This server implements ev.io's own wire protocol, so it's the *client* that needs to be told to
point somewhere other than the official servers. [`userscript/`](userscript/) has a Tampermonkey
userscript that does exactly that — official play stays the default, with a gear-menu button to
switch. See [`userscript/README.md`](userscript/README.md) for installation and how it picks
between the WebSocket and WebRTC transports.

## Configuration

Everything is a `settings.js`-registered value with an environment-variable override, a default,
and (for most of them) a live-editable entry in the admin dashboard. A few of the most commonly
changed ones:

| env var | default | what it does |
|---|---|---|
| `EVIO_LOCAL_HOST` | `127.0.0.1` | game socket bind address |
| `EVIO_LOCAL_PORT` | `8080` | game socket port |
| `EVIO_TICK_MS` | `50` | server tick period (50ms = 20Hz, matching the client) |
| `EVIO_STARTUP_MAP` | (bundled default) | which map to load on boot |
| `EVIO_BOT_COUNT` | `0` | how many bots to fill the match with |
| `EVIO_MAX_PLAYERS` | `32` | connection cap |
| `EVIO_ADMIN` | `1` | set `0` to disable the admin dashboard entirely |
| `EVIO_ADMIN_HOST` | `127.0.0.1` | dashboard bind address — keep this loopback (see below) |
| `EVIO_ADMIN_PORT` | `8081` | dashboard port |
| `EVIO_ADMIN_TOKEN` | (unset) | required if you ever bind the dashboard off loopback |
| `EVIO_NETLIB_ENABLED` | `0` | turn on the optional WebRTC transport (see below) |
| `EVIO_HEALTH_HOST` / `EVIO_HEALTH_PORT` | unset / `8082` | optional `/healthz` liveness endpoint |

There are roughly 150 more, covering everything from movement constants to netcode smoothing
curves to per-weapon damage scaling. The full, current list — each with its description, type,
default, and env var — is queryable at runtime:

```bash
node -e "require('./local_ws_server'); console.log(require('./settings').list())"
```

or just opened in the [admin dashboard](#admin-dashboard), which is the easier way to browse and
tune them live.

## Admin dashboard

`http://127.0.0.1:8081` shows live server status (tick rate, connected players and their
position/health/weapon/netcode state) and lets you edit any registered setting while the server
keeps running — no restart, no dropped players. It can also kick, kill, heal, and teleport
players, and switch maps.

**It is loopback-only by default, and that's deliberate — it has no authentication when reached
from `127.0.0.1`.** If you ever need to reach it remotely, don't bind it to a public interface;
tunnel it over SSH instead (see `deploy/admin-tunnel.sh` and `deploy/README.md`). The server will
refuse to start with `EVIO_ADMIN_HOST` set to anything non-loopback unless `EVIO_ADMIN_TOKEN` is
also set — and even then, the token travels in cleartext over plain HTTP, so treat that as a
last resort, not a real security boundary.

## The WebRTC (netlib) transport

By default this server only speaks WebSocket, same as the official one. Setting
`EVIO_NETLIB_ENABLED=1` starts a second, independent listener using WebRTC data channels
(unreliable channel for per-tick state, reliable channel for chat/RPCs/control messages) via a
vendored, modified fork of [netlib](https://github.com/proofnetworks/netlib) — see
`netlib_adapter.js`'s header comment for exactly how a netlib peer is adapted to look like a `ws`
socket to the rest of the server, and `vendor/NETLIB-LICENSE.txt` for netlib's own (ISC) license.

This is **additive**: the WS transport is completely unaffected whether netlib is on or off, and
every peer either one accepts is handled by the identical connection/session/physics code. The
point is working around TCP head-of-line blocking on lossy connections, where one dropped packet
stalls everything behind it — WebRTC's unreliable channel just drops it and moves on, which is
closer to how this protocol already tolerates loss by design.

Turning it on requires:

```bash
EVIO_NETLIB_ENABLED=1 \
EVIO_NETLIB_SIGNALING_URL=wss://your-signaling-server/v0/signaling \
npm start
```

You need a netlib-compatible signaling server reachable at that URL — WebRTC peers can't find each
other or exchange connection info without one. This repo includes everything to self-host one:
see [`netlib-signaling/`](netlib-signaling/) for the Go source, build/run instructions (systemd,
Docker, or plain `go run`), the Postgres note (the binary migrates its own schema — no manual step
needed), and the optional TURN/coturn setup for players behind strict NATs.

## Deployment

See [`deploy/README.md`](deploy/README.md) for a full walkthrough: provisioning a fresh Linux VPS
(Node 20, a systemd unit, firewall, SSH hardening), syncing this repo to it, putting TLS/WSS in
front of the game port (required — a page served over HTTPS can't open a plain `ws://` socket),
and reaching the admin dashboard safely over an SSH tunnel.

## Repository layout

```
local_ws_server.js       game socket, session/connection handling, weapons, combat, netcode
physics_world.js         loads the map, builds the collision world, spawn resolution
physics_extracted.js     the client's own movement/physics code, ported to run server-side
state_builder.js         builds the wire-format state/spawn/loadout packets
settings.js              the runtime-tunable settings registry (env var + live override)
admin_server.js          the live admin dashboard
health_server.js         optional /healthz liveness endpoint
map_loader.js            on-demand map download/parse/cache
map_teleporters.js       map portal/teleporter handling
bot_difficulty.js        bot skill-curve model
navmesh_pathfinder.js    bot pathfinding
ability_stats.js         ability-weapon cost/timer/table data
netlib_adapter.js        WebRTC transport adapter (see above)
vendor/netlib.js          built netlib library this adapter depends on
default_map.evmap, maps.json, weapons.json   map/weapon data (see note below)
scripts/                 the test suite (test_*.js) plus one shared test helper
deploy/                  VPS provisioning, sync, TLS, and admin-tunnel scripts
netlib-signaling/        self-hostable signaling server for the optional WebRTC transport
userscript/              the client-side userscript that points a browser at this server
```

## A note on the data files

`default_map.evmap`, `maps.json`, and `weapons.json` are data tables (map geometry, the map
catalogue, and the weapon stat catalogue) extracted from the public ev.io client so the server
has something real to simulate against. They are data, not code, and are included so this repo
runs out of the box — but they originate from a third party's game, not from this project. If
you'd rather not redistribute them, they can be replaced with your own extracted copies in the
same format; `physics_world.js` and `map_loader.js` are where they're read from.

## Scope and disclaimer

This project exists to understand and reimplement a public multiplayer game's netcode as a
technical exercise, and to run a private server for people who want to play together outside the
official matchmaking. It does not include, modify, or redistribute the official client or any of
its copyrighted assets beyond the small data tables noted above. Don't use this to interfere with
the official game or its players; this server is a separate, self-hosted instance that a client
must be explicitly pointed at.

## Contributing

Issues and PRs are welcome — see [`CONTRIBUTING.md`](CONTRIBUTING.md) for how to get oriented,
diagnose a client/server mismatch, write a test for it, and submit a change. The test suite
(`npm test`) is the bar for any change that touches simulation or netcode — most of it exists
because a real bug shipped once and got a regression test to match.

## License

MIT — see [`LICENSE`](LICENSE). The vendored `vendor/netlib.js` is separately licensed under ISC;
see `vendor/NETLIB-LICENSE.txt`.
