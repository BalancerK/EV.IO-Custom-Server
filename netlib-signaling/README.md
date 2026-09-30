# netlib signaling server

This is the piece the [optional WebRTC transport](../README.md#the-webrtc-netlib-transport) needs
that the main server doesn't provide: WebRTC peers can't find each other or exchange connection
info without *some* out-of-band channel first, and this Go service is that channel. The game
server (`../netlib_adapter.js`) only ever talks to it as a client, over `EVIO_NETLIB_SIGNALING_URL`
— it never implements signaling itself.

This is a vendored, lightly modified fork of [proofnetworks/netlib](https://github.com/proofnetworks/netlib)
(itself extending [poki/netlib](https://github.com/poki/netlib)) — see [`VENDORED.md`](VENDORED.md)
for exactly what was changed and why (mainly: generic coturn TURN credentials instead of being
locked to Cloudflare Calls). Licensed ISC — see [`LICENSE`](LICENSE).

You only need any of this if you want `EVIO_NETLIB_ENABLED=1` on the main server. It's entirely
optional; the default WebSocket transport works with none of this.

## What you need to run it

1. **A Postgres database.** The binary migrates its own schema on startup (embedded
   `golang-migrate` migrations in `migrations/`) — you just need an empty database and a
   connection string:
   ```bash
   sudo -u postgres psql -c "CREATE USER netlib WITH PASSWORD 'pick-a-real-password';"
   sudo -u postgres psql -c "CREATE DATABASE netlib OWNER netlib;"
   ```
   ```
   DATABASE_URL=postgres://netlib:pick-a-real-password@127.0.0.1:5432/netlib?sslmode=disable
   ```
   For local development only, you can skip this entirely and set `ENV=local` instead — the
   server will spin up a temporary, disposable Postgres in Docker itself (`dockertest`) and throw
   it away on exit. Don't use `ENV=local` for anything you want to keep running.

2. **(Optional) A TURN server**, for players behind NATs strict enough that direct/STUN-assisted
   WebRTC connections fail. Without one, WebRTC falls back to STUN-only, which works for most
   players but not all. `setup-coturn.sh` provisions [coturn](https://github.com/coturn/coturn)
   with a freshly generated shared secret:
   ```bash
   REALM=your-domain-or-ip.sslip.io bash setup-coturn.sh
   ```
   It prints a `TURN_URL` and `TURN_SHARED_SECRET` — feed both into the signaling server's
   environment (see below). If you'd rather use Cloudflare Calls instead of self-hosted coturn,
   set `CLOUDFLARE_APP_ID` / `CLOUDFLARE_AUTH_KEY` instead (see `internal/cloudflare/`) — the
   server picks whichever one is configured, preferring `TURN_SHARED_SECRET` if both are set, and
   runs STUN-only if neither is.

3. **The signaling server itself**, built from this directory. Three ways to run it:

   **systemd (matches the main repo's own deploy pattern):**
   ```bash
   DOMAIN=your-domain-or-ip.sslip.io \
   DATABASE_URL=postgres://netlib:...@127.0.0.1:5432/netlib?sslmode=disable \
   TURN_SHARED_SECRET=... TURN_URL=... \
   bash setup-signaling-service.sh
   ```
   This builds the binary, installs it to `/opt/netlib`, and sets it up as a `netlib-signaling`
   systemd service bound to loopback — then prints the Caddy config block to add so it's reachable
   publicly through the same TLS terminator the main repo's `deploy/tls.sh` sets up.

   **Docker:**
   ```bash
   docker build -t netlib-signaling .
   docker run -p 8090:8080 \
     -e DATABASE_URL=postgres://netlib:...@host.docker.internal:5432/netlib?sslmode=disable \
     -e TURN_SHARED_SECRET=... -e TURN_URL=... \
     netlib-signaling
   ```

   **Directly, for local testing:**
   ```bash
   ENV=local ADDR=127.0.0.1:8090 go run ./cmd/signaling
   ```

## Environment variables

| var | required? | what it does |
|---|---|---|
| `ADDR` | no (default `:8080`) | bind address |
| `DATABASE_URL` | yes, unless `ENV=local` | Postgres connection string |
| `ENV=local` or `ENV=test` | alternative to `DATABASE_URL` | spins up a disposable Docker Postgres — dev/test only |
| `TURN_SHARED_SECRET` + `TURN_URL` | no | self-hosted coturn credentials (see `setup-coturn.sh`) |
| `CLOUDFLARE_APP_ID` + `CLOUDFLARE_AUTH_KEY` | no | Cloudflare Calls TURN credentials instead of coturn |
| `METRICS_URL` | no | optional metrics sink (see `internal/metrics/`) |

Neither `TURN_*` nor `CLOUDFLARE_*` set means STUN-only — direct connections still work for most
players, just not the ones behind the strictest NATs.

## Pointing the game server at it

Once it's running and reachable (directly, or through Caddy at a public URL), point the main
server at it:

```bash
EVIO_NETLIB_ENABLED=1 \
EVIO_NETLIB_SIGNALING_URL=wss://your-domain/netlib/v0/signaling \
npm start
```

## Testing it built correctly

```bash
go build ./...
go test ./...
```

`internal/turnauth/sharedsecret_test.go` in particular verifies the coturn credential math against
an independently computed reference HMAC, not just against itself.
