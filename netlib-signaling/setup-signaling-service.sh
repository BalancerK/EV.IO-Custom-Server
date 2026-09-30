#!/usr/bin/env bash
# setup-signaling-service.sh — build the netlib signaling server and install it as a systemd
# service (mirroring the main repo's own evio.service pattern), then expose it through Caddy
# alongside the game server's existing routes.
#
# Run ON THE VPS as the sudo user (paste into an interactive `ssh -t ...` session, or
# `bash setup-signaling-service.sh` if this repo is already checked out there).
#
# Requires:
#   DOMAIN              your server's domain or sslip.io hostname (see the main repo's
#                        deploy/tls.sh for how to get one with no DNS setup)
#   DATABASE_URL         a Postgres connection string — see "Postgres" in this directory's
#                        README.md for how to create the database; the binary migrates its own
#                        schema on startup, nothing to run by hand
#   TURN_SHARED_SECRET   from setup-coturn.sh's output, if you're running your own TURN server
#                        (optional — omit both this and TURN_URL to run STUN-only)
#   TURN_URL             e.g. turn:your-domain:3478?transport=udp (from setup-coturn.sh)
#
# None of these have defaults — this script refuses to run with a placeholder secret baked in.
set -euo pipefail

DOMAIN="${DOMAIN:?set DOMAIN to your server's domain or sslip.io hostname}"
DATABASE_URL="${DATABASE_URL:?set DATABASE_URL to a Postgres connection string — see README.md}"
TURN_SHARED_SECRET="${TURN_SHARED_SECRET:-}"
TURN_URL="${TURN_URL:-}"
APP_DIR="${APP_DIR:-/opt/netlib}"
RUN_USER="$(id -un)"
ADDR="${ADDR:-127.0.0.1:8090}"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }

say "Building the signaling server"
command -v go >/dev/null 2>&1 || { echo "Go toolchain not found — install Go 1.25+ first"; exit 1; }
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
( cd "${HERE}" && CGO_ENABLED=0 go build -o signaling ./cmd/signaling )

say "Moving this directory to ${APP_DIR}"
sudo mkdir -p "${APP_DIR}"
sudo chown -R "${RUN_USER}:${RUN_USER}" "${APP_DIR}"
rsync -a --delete "${HERE}/" "${APP_DIR}/"

say "systemd service"
sudo tee /etc/systemd/system/netlib-signaling.service >/dev/null <<UNIT
[Unit]
Description=netlib signaling server (self-hosted, vendored — see ${APP_DIR}/VENDORED.md)
After=network-online.target postgresql.service coturn.service
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${APP_DIR}/signaling
Restart=always
RestartSec=3

Environment=ADDR=${ADDR}
Environment=DATABASE_URL=${DATABASE_URL}
$( [ -n "${TURN_SHARED_SECRET}" ] && echo "Environment=TURN_SHARED_SECRET=${TURN_SHARED_SECRET}" )
$( [ -n "${TURN_URL}" ] && echo "Environment=TURN_URL=${TURN_URL}" )

# Loopback only — reached through Caddy on the public domain, same pattern as
# the main repo's own health server (EVIO_HEALTH_HOST=127.0.0.1) and admin dashboard.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ReadWritePaths=${APP_DIR}
ProtectKernelTunables=true
ProtectControlGroups=true
RestrictSUIDSGID=true
LockPersonality=true

StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable --now netlib-signaling.service
sleep 1
sudo systemctl is-active netlib-signaling.service && echo "netlib-signaling is active" || {
  echo "netlib-signaling FAILED to start — last 30 log lines:"
  sudo journalctl -u netlib-signaling --no-pager -n 30
  exit 1
}

say "Caddy: add /netlib/* and the browser client alongside the game server's existing routes"
cat <<CADDYEOF
Add this block to your Caddyfile (see the main repo's deploy/tls.sh for the rest of it):

    handle_path /netlib/* {
        reverse_proxy 127.0.0.1:8090
    }

    # netlib's BROWSER build (this directory's static/netlib-client.js) — the userscript's
    # @require loads it from here. Served as a static file, not proxied: it's a static asset
    # with no server-side logic of its own.
    handle /netlib-client.js {
        root * ${APP_DIR}/static
        file_server
    }

handle_path strips the /netlib prefix before proxying, so the signaling server itself never
needs to know it's mounted under a subpath. Then:

    sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
    sudo systemctl reload caddy
CADDYEOF

say "Done"
echo "Once Caddy is updated:"
echo "  signaling server: wss://${DOMAIN}/netlib/v0/signaling"
echo "  health/ready:      https://${DOMAIN}/netlib/health , /netlib/ready"
echo "  browser client:    https://${DOMAIN}/netlib-client.js"
echo ""
echo "Put that last URL in the userscript's @require line (see ../README.md's client section)."
