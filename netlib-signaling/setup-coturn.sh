#!/usr/bin/env bash
# setup-coturn.sh — provision coturn as the TURN server for the netlib signaling service.
#
# Run ON THE VPS as the sudo user (paste this whole file's contents into an
# interactive `ssh -t ...` session — do NOT try to pass this as a one-line
# remote command through PowerShell; the nested quoting does not survive).
#
# Requires REALM to be set to your own domain/IP (see deploy/tls.sh in the main repo for how to
# get a domain via sslip.io with no DNS setup). Generates its own random shared secret unless one
# is passed in via TURN_SECRET — never hardcode a real secret into this file.
set -euo pipefail

REALM="${REALM:?set REALM to your server's domain or sslip.io hostname, e.g. 203.0.113.5.sslip.io}"
TURN_SECRET="${TURN_SECRET:-$(openssl rand -hex 32)}"
MIN_PORT="${MIN_PORT:-49152}"
MAX_PORT="${MAX_PORT:-49452}"

echo "== Installing coturn =="
sudo apt-get update -qq
sudo apt-get install -y coturn

echo "== Enabling the coturn service (disabled by default on Ubuntu) =="
sudo sed -i 's/^#\?TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
grep -q '^TURNSERVER_ENABLED=1' /etc/default/coturn || echo 'TURNSERVER_ENABLED=1' | sudo tee -a /etc/default/coturn >/dev/null

echo "== Writing /etc/turnserver.conf =="
sudo tee /etc/turnserver.conf >/dev/null <<CONF
listening-port=3478
fingerprint
use-auth-secret
static-auth-secret=${TURN_SECRET}
realm=${REALM}
total-quota=100
stale-nonce=600
no-multicast-peers
no-cli
min-port=${MIN_PORT}
max-port=${MAX_PORT}
# Refuse to relay to private/internal address ranges — a public TURN server
# that can reach RFC1918 space is a relay-abuse vector into whatever network
# the VPS itself sits on.
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
log-file=/var/log/turnserver.log
simple-log
CONF

echo "== Firewall: opening 3478 (control) + ${MIN_PORT}-${MAX_PORT} (relay) =="
sudo ufw allow 3478/udp comment 'coturn control'
sudo ufw allow 3478/tcp comment 'coturn control (TCP fallback)'
sudo ufw allow "${MIN_PORT}:${MAX_PORT}/udp" comment 'coturn relay range'

echo "== Starting coturn =="
sudo systemctl enable --now coturn
sleep 1
sudo systemctl is-active coturn && echo "coturn is active" || {
  echo "coturn FAILED to start — showing the last 20 log lines:"
  sudo journalctl -u coturn --no-pager -n 20
  exit 1
}

echo
echo "== Done =="
echo "TURN_URL=turn:${REALM}:3478?transport=udp"
echo "TURN_SHARED_SECRET=${TURN_SECRET}"
echo "(save these two lines — they go into the signaling server's environment. This secret was"
echo " generated fresh by this script and is not printed or stored anywhere else — copy it now.)"
