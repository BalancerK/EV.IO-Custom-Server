#!/usr/bin/env bash
# sync.sh — push server/ to the VPS and restart the service.
#
# Run FROM YOUR WORKSTATION (Git Bash on Windows is fine):
#     bash deploy/sync.sh              # sync + restart
#     WATCH=1 bash deploy/sync.sh      # keep syncing on every change
#     RESTART=0 bash deploy/sync.sh    # sync only, leave the service alone
#
# Only the runtime payload goes up. node_modules is installed ON the VPS (native builds must match
# the target platform, and shipping Windows-built modules to Linux is a classic way to waste an
# afternoon). map_cache is excluded because it regenerates itself and is >100 MB.
set -euo pipefail

VPS_HOST="${VPS_HOST:?set VPS_HOST to the server IP or hostname}"
VPS_USER="${VPS_USER:-gameserver}"
VPS_PORT="${VPS_PORT:-22}"
APP_DIR="${APP_DIR:-/opt/evio}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/evio_vps}"
RESTART="${RESTART:-1}"
WATCH="${WATCH:-0}"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SRC="${HERE}"
[ -f "${SRC}/local_ws_server.js" ] || { echo "no local_ws_server.js at ${SRC}"; exit 1; }

SSH_OPTS=(-i "${SSH_KEY}" -p "${VPS_PORT}" -o StrictHostKeyChecking=accept-new)
REMOTE="${VPS_USER}@${VPS_HOST}"

EXCLUDES=(node_modules map_cache scripts work prototype)

# settings.local.json is the server's OWN state, written on the VPS by the dashboard. It must never
# be pushed (a local dev copy would overwrite the live tuning) and never deleted (both sync paths
# remove remote files that are absent locally, which would silently reset the server on every deploy).
KEEP_REMOTE=(settings.local.json)

push() {
  echo "→ syncing server/ to ${REMOTE}:${APP_DIR}/server"
  if command -v rsync >/dev/null 2>&1; then
    local args=()
    for e in "${EXCLUDES[@]}"; do args+=(--exclude "${e}/"); done
    for f in "${KEEP_REMOTE[@]}"; do args+=(--exclude "${f}"); done
    rsync -az --delete "${args[@]}" --exclude '*.log' \
      -e "ssh ${SSH_OPTS[*]}" \
      "${SRC}/" "${REMOTE}:${APP_DIR}/server/"
  else
    # rsync is not part of a stock Git-Bash install and is missing from some CI/sandbox images, so
    # fall back to tar over the SSH pipe. Same payload, needs nothing but ssh and tar.
    #
    # --delete has no direct equivalent, so removals are handled explicitly: the remote runtime
    # files are cleared first (node_modules and map_cache are preserved, since they are built on the
    # target and are large). Without that, a file deleted locally would linger on the server for
    # ever, which is exactly how a stale module keeps getting loaded after you thought you removed it.
    echo "  (rsync not found — using tar over ssh)"
    local targs=()
    for e in "${EXCLUDES[@]}"; do targs+=(--exclude="${e}"); done
    for f in "${KEEP_REMOTE[@]}"; do targs+=(--exclude="${f}"); done
    local keep=''
    for f in "${KEEP_REMOTE[@]}"; do keep+=" ! -name ${f}"; done
    ssh "${SSH_OPTS[@]}" "${REMOTE}" \
      "mkdir -p ${APP_DIR}/server && cd ${APP_DIR}/server && \
       find . -maxdepth 1 -mindepth 1 ! -name node_modules ! -name map_cache${keep} -exec rm -rf {} +"
    tar czf - "${targs[@]}" --exclude='*.log' -C "${SRC}" . \
      | ssh "${SSH_OPTS[@]}" "${REMOTE}" "mkdir -p ${APP_DIR}/server && tar xzf - -C ${APP_DIR}/server"
  fi

  # Dependencies are resolved on the target. --omit=dev skips playwright, which is only needed by
  # the browser tests and is a large download.
  ssh "${SSH_OPTS[@]}" "${REMOTE}" \
    "cd ${APP_DIR}/server && npm install --omit=dev --no-audit --no-fund --silent"

  if [ "${RESTART}" = "1" ]; then
    echo "→ restarting evio.service"
    ssh "${SSH_OPTS[@]}" "${REMOTE}" "sudo systemctl restart evio && sleep 1 && systemctl is-active evio"
  fi
  echo "✓ done"
}

if [ "${WATCH}" != "1" ]; then
  push
  exit 0
fi

# Watch mode. Polls a checksum of the tree rather than requiring inotify/fswatch, so it behaves the
# same on Windows, macOS and Linux. 2s is responsive enough for editing and cheap on a small tree.
echo "watching ${SRC} — Ctrl-C to stop"
fingerprint() {
  find "${SRC}" -type f \
    -not -path '*/node_modules/*' -not -path '*/map_cache/*' \
    -not -path '*/work/*' -not -name '*.log' \
    -printf '%T@ %s %p\n' 2>/dev/null | sort | cksum
}
last=""
while true; do
  cur="$(fingerprint)"
  if [ "${cur}" != "${last}" ]; then
    [ -n "${last}" ] && echo "· change detected $(date +%H:%M:%S)"
    push || echo "sync failed — will retry on next change"
    last="${cur}"
  fi
  sleep 2
done
