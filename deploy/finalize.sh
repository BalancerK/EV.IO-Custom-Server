#!/usr/bin/env bash
# finalize.sh — the last provisioning steps, which need a sudo password.
#
# Run ON THE VPS:   bash finalize.sh
#
# Separate from provision.sh so it can be re-run on its own: the sudoers rule is what lets the
# deploy script restart the service unattended, and it is the one step most likely to need a retry.
set -euo pipefail

RUN_USER="${RUN_USER:-$(id -un)}"
SYSTEMCTL="$(command -v systemctl)"

say() { printf '\n\033[1;36m== %s\033[0m\n' "$1"; }

say "Scoped passwordless sudo for service control"
# Written in place as root:root 0440 BEFORE validating: visudo -c rejects any file that is not
# already root-owned and 0440, so validating a temp file in /tmp always fails. If the resulting
# config is invalid the file is removed again, so a bad edit can never lock sudo out.
sudo tee /etc/sudoers.d/evio-deploy >/dev/null <<SUDO
${RUN_USER} ALL=(root) NOPASSWD: ${SYSTEMCTL} start evio, ${SYSTEMCTL} stop evio, ${SYSTEMCTL} restart evio, ${SYSTEMCTL} status evio
SUDO
sudo chown root:root /etc/sudoers.d/evio-deploy
sudo chmod 0440 /etc/sudoers.d/evio-deploy
if sudo visudo -c >/dev/null 2>&1; then
  echo "ok — ${RUN_USER} may now start/stop/restart/status ONLY the evio unit without a password"
else
  sudo rm -f /etc/sudoers.d/evio-deploy
  echo "REFUSED: validation failed, file removed, sudo untouched"
  exit 1
fi

say "Start the service"
sudo systemctl enable evio >/dev/null 2>&1 || true
sudo systemctl restart evio
sleep 2
sudo systemctl status evio --no-pager | head -12

say "Firewall"
sudo ufw status verbose | head -12

say "Done"
echo "From your workstation:"
echo "  bash deploy/sync.sh            # push code + restart, no password needed now"
echo "  bash deploy/admin-tunnel.sh    # dashboard at http://127.0.0.1:8081"
