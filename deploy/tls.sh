#!/usr/bin/env bash
# tls.sh — put HTTPS/WSS in front of the game socket.
#
# Run ON THE VPS:   bash tls.sh
#
# WHY THIS IS REQUIRED
# ev.io is served over HTTPS, and a secure page may not open an insecure ws:// socket:
#   SecurityError: An insecure WebSocket connection may not be initiated from a page loaded over HTTPS
# Localhost is exempt (browsers treat 127.0.0.1 as a secure context), which is why this only appears
# once the server moves to a real host. The fix is a TLS terminator in front of the game port.
#
# NO DOMAIN NEEDED. sslip.io resolves any IP embedded in the hostname
# (e.g. 203.0.113.5.sslip.io -> 203.0.113.5), and Let's Encrypt will issue for it, so Caddy can get
# a publicly-trusted certificate with no purchase and no DNS setup. A self-signed certificate would
# NOT work here: a WebSocket handshake gives the browser no interstitial to click through, so an
# untrusted cert simply fails.
#
# Caddy terminates TLS on 443 and reverse-proxies to the game server on loopback. The game port
# itself can then be closed to the internet — only 443 needs to be public.
set -euo pipefail

PUBLIC_IP="${PUBLIC_IP:-$(curl -s --max-time 10 https://api.ipify.org)}"
DOMAIN="${DOMAIN:-${PUBLIC_IP}.sslip.io}"
GAME_PORT="${GAME_PORT:-8080}"
HEALTH_PORT="${HEALTH_PORT:-8082}"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }

say "Target"
echo "  public IP : ${PUBLIC_IP}"
echo "  hostname  : ${DOMAIN}"
resolved="$(getent hosts "${DOMAIN}" | awk '{print $1}' | head -1)"
[ "${resolved}" = "${PUBLIC_IP}" ] || { echo "  ${DOMAIN} resolves to '${resolved}', expected ${PUBLIC_IP}"; exit 1; }
echo "  resolves  : ok"

say "Install Caddy"
if ! command -v caddy >/dev/null; then
  sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y caddy
fi
caddy version

say "Firewall: open 80 and 443"
# 80 is needed for the ACME HTTP challenge and for Caddy's automatic HTTP->HTTPS redirect.
sudo ufw allow 80/tcp comment 'caddy acme + redirect'
sudo ufw allow 443/tcp comment 'wss game socket'
# The game port no longer needs to face the internet: traffic arrives on 443 and Caddy forwards it
# over loopback. Closing it means one public entry point instead of two.
sudo ufw delete allow "${GAME_PORT}/tcp" 2>/dev/null || true
sudo ufw status verbose | head -12

say "Caddyfile"
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
${DOMAIN} {
    # Public liveness check (server/health_server.js) — its own small loopback-only server, routed
    # here on the SAME domain so nothing needs a new firewall rule. Matched BEFORE the catch-all
    # below via explicit handle blocks (Caddy evaluates these top-to-bottom, unlike a bare
    # reverse_proxy directive, whose position in the file doesn't determine match order).
    handle /healthz {
        reverse_proxy 127.0.0.1:${HEALTH_PORT}
    }
    handle /health {
        reverse_proxy 127.0.0.1:${HEALTH_PORT}
    }

    # Everything else, including the WebSocket upgrade — Caddy v2 proxies WS transparently, no
    # special config needed.
    handle {
        reverse_proxy 127.0.0.1:${GAME_PORT}
    }

    # The admin dashboard is deliberately NOT proxied here. It stays on loopback and is reached over
    # an SSH tunnel; publishing it on this domain would undo that.
}
CADDY
# NOTE: no `log { output file ... }` block. The packaged caddy.service sandboxes the filesystem, so
# even after chowning /var/log/caddy the process is refused write access and dies at startup with
#   "opening log writer ... /var/log/caddy/access.log: permission denied"
# Caddy logs to journald by default, which needs no directory, is rotated by systemd, and keeps
# everything in one place:  journalctl -u caddy -f
sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile

say "Start Caddy"
sudo systemctl enable caddy >/dev/null 2>&1 || true
sudo systemctl restart caddy
sleep 6
if ! systemctl is-active --quiet caddy; then
  echo "Caddy failed to start — the reason is the Status= line below:"
  systemctl status caddy --no-pager | head -14
  exit 1
fi
echo "active"

say "Certificate"
# The first request triggers issuance; it can take a few seconds.
curl -sI --max-time 25 "https://${DOMAIN}/" | head -3 || echo "  (still provisioning — give it a moment)"

say "Done"
echo "Point the userscript at:"
echo "    ${DOMAIN}"
echo "(the gear now picks wss:// automatically for non-loopback hosts, and 443 is the default port)"
