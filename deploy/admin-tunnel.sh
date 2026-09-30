#!/usr/bin/env bash
# admin-tunnel.sh — reach the admin dashboard safely.
#
#     bash deploy/admin-tunnel.sh     then browse http://127.0.0.1:8081
#
# The dashboard can kick, kill and teleport players, switch maps, and rewrite every gameplay
# constant. It therefore stays bound to loopback ON THE VPS and is never exposed; this forwards it
# over SSH, so the authentication and encryption are SSH's. Nothing extra is opened in the firewall.
#
# Windows PowerShell equivalent, if you prefer:
#   ssh -N -L 8081:127.0.0.1:8081 -i $HOME\.ssh\evio_vps gameserver@<your-vps-ip>
set -euo pipefail

VPS_HOST="${VPS_HOST:?set VPS_HOST to your server's IP or hostname}"
VPS_USER="${VPS_USER:-gameserver}"
VPS_PORT="${VPS_PORT:-22}"
ADMIN_PORT="${ADMIN_PORT:-8081}"
SSH_KEY="${SSH_KEY:-$HOME/.ssh/evio_vps}"

echo "forwarding ${ADMIN_PORT} -> ${VPS_HOST}:127.0.0.1:${ADMIN_PORT}"
echo "open http://127.0.0.1:${ADMIN_PORT}  (Ctrl-C to close the tunnel)"
exec ssh -N \
  -i "${SSH_KEY}" -p "${VPS_PORT}" \
  -L "${ADMIN_PORT}:127.0.0.1:${ADMIN_PORT}" \
  -o ExitOnForwardFailure=yes \
  -o ServerAliveInterval=30 \
  "${VPS_USER}@${VPS_HOST}"
