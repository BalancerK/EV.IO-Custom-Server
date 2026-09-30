#!/usr/bin/env bash
# provision.sh — one-time VPS setup for the ev.io custom server (Ubuntu).
#
# Run ON THE VPS as the sudo user:   bash provision.sh
#
# What it does, and why:
#   - installs Node 20 LTS (the server needs a modern Node; Ubuntu's default is usually too old)
#   - creates /opt/evio owned by the deploy user, so syncing never needs sudo
#   - installs a systemd unit so the server restarts on crash and survives reboot
#   - configures ufw: the GAME port is public, the ADMIN port is NOT
#   - hardens sshd: keys only, no password auth, no root login
#
# It is idempotent — safe to re-run.
set -euo pipefail

GAME_PORT="${GAME_PORT:-8080}"
ADMIN_PORT="${ADMIN_PORT:-8081}"
HEALTH_PORT="${HEALTH_PORT:-8082}"
APP_DIR="${APP_DIR:-/opt/evio}"
RUN_USER="${RUN_USER:-$(id -un)}"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }

say "Node.js"
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
node --version

say "Packages"
sudo apt-get update -qq
sudo apt-get install -y rsync ufw curl

say "Application directory ${APP_DIR}"
sudo mkdir -p "${APP_DIR}"
sudo chown -R "${RUN_USER}:${RUN_USER}" "${APP_DIR}"

say "Firewall"
# Default deny inbound, allow out. SSH first — locking yourself out here is the classic mistake.
#
# `ufw --force reset` WIPES EVERY RULE, including ones this script did not add — a real incident,
# not a hypothetical one. tls.sh (run separately, once TLS is up) opens 80/443 and DELETES the
# GAME_PORT rule below, since traffic moves to Caddy on 443 at that point. This script is meant to
# be safely re-runnable (e.g. to pick up a new setting further down), but resetting unconditionally
# on every rerun threw away tls.sh's 80/443 rules and put GAME_PORT back — silently killing public
# WSS access with no error anywhere, since the VPS can still reach itself over loopback either way.
# Reset only on a genuinely fresh box (ufw inactive); a rerun instead layers idempotent `ufw allow`
# calls on top of whatever is already there, exactly like every other idempotent step in this script.
if ! sudo ufw status | grep -q "Status: active"; then
  sudo ufw --force reset >/dev/null
  sudo ufw default deny incoming
  sudo ufw default allow outgoing
fi
sudo ufw allow 22/tcp comment 'ssh'
# Only needed before tls.sh moves traffic to 443 — once Caddy is fronting it, tls.sh deletes this
# rule itself. Re-adding it here on a rerun is harmless (ufw allow is idempotent) and keeps a
# fresh box (no Caddy yet) reachable on the raw game port in the meantime.
sudo ufw allow "${GAME_PORT}/tcp" comment 'evio game websocket'
# The admin dashboard is deliberately NOT opened. It stays on loopback and is reached over an SSH
# tunnel; the server itself now refuses to start on a public interface without a token.
sudo ufw --force enable
sudo ufw status verbose

say "systemd service"
sudo tee /etc/systemd/system/evio.service >/dev/null <<UNIT
[Unit]
Description=ev.io custom game server
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}/server
ExecStart=/usr/bin/node local_ws_server.js
Restart=always
RestartSec=3

# Coupled to drainGraceSeconds (server/local_ws_server.js, max 120s): SIGTERM now drains connected
# players for up to that long before exiting on its own (see beginGracefulShutdown). systemd's
# default TimeoutStopSec is 90s — already SHORTER than drainGraceSeconds' own max, so raising that
# setting anywhere near its ceiling would have gotten the process SIGKILLed mid-drain before this was
# explicit. Set with margin above the worst case so the drain always gets to finish on its own terms.
TimeoutStopSec=150

# Resource ceiling: a leak or runaway bug should take down THIS service, not the whole VPS (SSH
# access included) via the OOM killer picking an arbitrary victim. MemoryHigh throttles (reclaimable
# pressure) before MemoryMax hard-kills. Sized generously for one lobby + a handful of bots on one
# map — if this ever trips in practice (journalctl -u evio logs the OOM kill, not silent), that is
# itself useful signal, not just a limit to raise blindly.
MemoryHigh=1536M
MemoryMax=2G
# Node is single-process — not a fork-bomb risk — but a cheap backstop against any future change
# that spawns child processes or worker threads unboundedly.
TasksMax=256

# The game socket must be reachable from the internet, so bind all interfaces.
Environment=EVIO_LOCAL_HOST=0.0.0.0
Environment=EVIO_LOCAL_PORT=${GAME_PORT}
# The admin dashboard stays on loopback. Reach it with:
#   ssh -N -L ${ADMIN_PORT}:127.0.0.1:${ADMIN_PORT} ${RUN_USER}@<vps>
Environment=EVIO_ADMIN_HOST=127.0.0.1
Environment=EVIO_ADMIN_PORT=${ADMIN_PORT}
# Public liveness check (see server/health_server.js) — loopback here too; tls.sh routes a path on
# the SAME public domain to it, so no new firewall rule is needed either. Off by default in the
# server itself; this is the opt-in for a real deploy specifically.
Environment=EVIO_HEALTH=1
Environment=EVIO_HEALTH_HOST=127.0.0.1
Environment=EVIO_HEALTH_PORT=${HEALTH_PORT}
Environment=NODE_ENV=production

# Containment: the service only ever needs to read its own directory and talk to the network.
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
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
sudo systemctl enable evio.service >/dev/null
echo "unit installed (not started yet — deploy the code first)"

say "Scheduled restart"
# A long-running Node process accumulates GC-fragmentation-driven stalls over enough uptime — found
# live after this service ran for 9.9 days straight: tick overruns up to 741ms, bursty and with the
# dominant cost phase shifting randomly between ticks (GC's signature, not one slow function). The
# graceful-drain SIGTERM handler (see local_ws_server.js) makes a periodic restart genuinely low-risk
# now — connected players get a warning and up to drainGraceSeconds to leave naturally — so the fix
# is to restart on a schedule before it degrades enough to notice, not wait and react each time.
#
# A separate timer + oneshot service, not a cron job in evio.service's own unit: systemd timers get
# Persistent=true (catches up after a VPS reboot that happened to land on the scheduled time, instead
# of silently skipping it) and RandomizedDelaySec (a few minutes of jitter, so restarts on many
# deployments of this same script don't all land on the exact same second). Runs as root (the default
# for a system-level oneshot unit), so it needs none of the scoped-sudoers workaround below — that
# exists only because the DEPLOY USER is not root.
#
# Override the schedule with RESTART_SCHEDULE='<systemd OnCalendar expression>' before running this
# script — e.g. 'Sun 04:00' (weekly) or '*-*-01 04:00' (monthly). Uses the VPS's local system
# timezone; check with `timedatectl` if the default below lands somewhere inconvenient for players.
RESTART_SCHEDULE="${RESTART_SCHEDULE:-Sun 04:00}"

sudo tee /etc/systemd/system/evio-restart.service >/dev/null <<'RESTARTUNIT'
[Unit]
Description=Scheduled restart of the ev.io game server (graceful SIGTERM drain, see evio.service)
After=evio.service

[Service]
Type=oneshot
ExecStart=/usr/bin/systemctl restart evio.service
RESTARTUNIT

sudo tee /etc/systemd/system/evio-restart.timer >/dev/null <<TIMERUNIT
[Unit]
Description=Weekly scheduled restart for evio.service, ahead of GC-fragmentation buildup on long uptimes

[Timer]
OnCalendar=${RESTART_SCHEDULE}
Persistent=true
RandomizedDelaySec=300

[Install]
WantedBy=timers.target
TIMERUNIT

sudo systemctl daemon-reload
sudo systemctl enable --now evio-restart.timer >/dev/null
echo "evio-restart.timer active — schedule: ${RESTART_SCHEDULE} (local time)"
systemctl list-timers evio-restart.timer --no-pager 2>/dev/null | head -3

say "Scoped passwordless sudo for service control"
# sync.sh restarts the service on every push, which cannot prompt for a password. Rather than give
# the deploy user blanket NOPASSWD, allow EXACTLY the four systemctl verbs it needs against EXACTLY
# this unit. Everything else still asks. Written via visudo -c so a malformed file can never lock
# sudo out of the machine.
# Write it in place with root ownership and 0440 FIRST, then validate the whole config and remove
# the file again if anything is wrong. Validating a temp file owned by the deploy user does not
# work: visudo -c rejects files that are not root-owned and mode 0440, which is why an earlier
# version of this script silently skipped this step.
SYSTEMCTL="$(command -v systemctl)"
sudo tee /etc/sudoers.d/evio-deploy >/dev/null <<SUDO
${RUN_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL} start evio, ${SYSTEMCTL} stop evio, ${SYSTEMCTL} restart evio, ${SYSTEMCTL} status evio
SUDO
sudo chown root:root /etc/sudoers.d/evio-deploy
sudo chmod 0440 /etc/sudoers.d/evio-deploy
if sudo visudo -c >/dev/null 2>&1; then
  echo "installed /etc/sudoers.d/evio-deploy (service control only, via ${SYSTEMCTL})"
else
  sudo rm -f /etc/sudoers.d/evio-deploy
  echo "REFUSED: sudoers validation failed; the file was removed and sudo is untouched"
fi

say "SSH hardening"
# Only applied once a key is known to work, or you would lock yourself out.
if [ -s "${HOME}/.ssh/authorized_keys" ]; then
  sudo tee /etc/ssh/sshd_config.d/99-evio.conf >/dev/null <<'SSHD'
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
SSHD
  sudo systemctl reload ssh || sudo systemctl reload sshd
  echo "password auth DISABLED (keys only). Keep your current session open until you have"
  echo "confirmed a new key-based login works in a separate terminal."
else
  echo "SKIPPED: ~/.ssh/authorized_keys is empty. Install your key first, then re-run;"
  echo "disabling passwords now would lock you out."
fi

say "Done"
echo "Next: push the code from your workstation (deploy/sync.sh), then:"
echo "  sudo systemctl start evio && journalctl -u evio -f"
