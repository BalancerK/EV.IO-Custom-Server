# Deploying the ev.io custom server

Three scripts, run in this order. Everything assumes a deploy key at `~/.ssh/evio_vps` and a
VPS reachable at `YOUR_VPS_IP` (substitute your own server's IP or hostname everywhere below).

| script | runs on | what it does |
|---|---|---|
| `provision.sh` | the VPS, once | Node 20, `/opt/evio`, systemd unit, firewall, SSH hardening |
| `sync.sh` | your workstation | pushes this repo, installs deps on the target, restarts the service |
| `admin-tunnel.sh` | your workstation | forwards the admin dashboard over SSH |

## 1. Install the deploy key

The only step that needs a password:

```bash
ssh gameserver@YOUR_VPS_IP -p 22 \
  "mkdir -p ~/.ssh && chmod 700 ~/.ssh && \
   echo '<PUBLIC KEY>' >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys"
```

Verify it works before going further — `provision.sh` disables password auth, and doing that
without a working key locks you out of your own box:

```bash
ssh -i ~/.ssh/evio_vps gameserver@YOUR_VPS_IP "echo ok"
```

## 2. Provision

```bash
scp -i ~/.ssh/evio_vps deploy/provision.sh gameserver@YOUR_VPS_IP:~/
ssh -i ~/.ssh/evio_vps gameserver@YOUR_VPS_IP "bash provision.sh"
```

Ports afterwards:

| port | exposure | why |
|---|---|---|
| 22 | public | SSH |
| 8080 | **public** | the game WebSocket — clients must reach this |
| 8081 | **loopback only** | admin dashboard; tunnelled, never exposed |

`provision.sh` only disables password authentication if it finds a non-empty `authorized_keys`.
That check exists so a mis-ordered run cannot lock you out.

## 3. Deploy the code

```bash
VPS_HOST=YOUR_VPS_IP bash deploy/sync.sh              # one-shot
VPS_HOST=YOUR_VPS_IP WATCH=1 bash deploy/sync.sh      # keep syncing as you edit
```

`node_modules` is installed **on the VPS**, not synced — native modules (`@roamhq/wrtc`) must be
built for the target platform. `map_cache/` is excluded too: it regenerates on demand.

Then start it:

```bash
ssh -i ~/.ssh/evio_vps gameserver@YOUR_VPS_IP "sudo systemctl start evio && journalctl -u evio -f"
```

## 4. Point the client at it

In the userscript's gear menu, set the server address to:

```
YOUR_VPS_IP:8080
```

Official play stays the default; the custom server is only used when you press **Join Test Server**.

## 5. Reach the dashboard

```bash
VPS_HOST=YOUR_VPS_IP bash deploy/admin-tunnel.sh      # then http://127.0.0.1:8081
```

Do **not** open 8081 in the firewall. The dashboard can kick, kill and teleport players, switch maps
and rewrite every gameplay constant, so reachability is the entire threat model. The server refuses
to start on a public interface unless `EVIO_ADMIN_TOKEN` is set — and even then the token crosses
plain HTTP in cleartext, so the tunnel is the supported route. `EVIO_ADMIN=0` disables it entirely.

## Operating it

```bash
systemctl status evio            # is it running
journalctl -u evio -f            # live logs
journalctl -u evio --since -1h   # recent history
sudo systemctl restart evio
```

The unit restarts on crash (`Restart=always`) and starts at boot. It runs under systemd containment:
`ProtectSystem=strict` with `ReadWritePaths=/opt/evio`, no new privileges, private `/tmp`.

## Security notes

- Keep `EVIO_ADMIN_HOST=127.0.0.1`. The systemd unit sets it; don't override it.
- The game port is public by necessity — that is the one service that must accept arbitrary
  connections. Chat is escaped server-side (the client renders it as raw innerHTML), and the input
  path is validated, but treat the server as reachable by anyone who finds the port.
- `ufw status verbose` should show exactly 22 and 8080 open. If 8081 ever appears there, close it.
- Rotate any password used for initial key installation once the deploy key is confirmed working;
  `provision.sh` disables password login entirely after that point anyway.
