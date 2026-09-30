# ev.io Custom Server userscript

A [Tampermonkey](https://www.tampermonkey.net/) (or [Violentmonkey](https://violentmonkey.github.io/))
userscript that lets a real, unmodified ev.io session connect to *this* server instead of official
infrastructure. **Official play is the default** — nothing is touched until you click
**Join Test Server**, and clicking **Leave Test Server** puts you straight back.

## Install

1. Install Tampermonkey (or Violentmonkey) in your browser.
2. Create a new script and paste in [`evio-custom-server.user.js`](evio-custom-server.user.js), or
   install it from a raw URL if you're hosting this repo somewhere Tampermonkey can fetch it from.
3. Visit ev.io. A small button bar appears; click the gear icon to set the server's WebSocket
   `host:port`, then **Join Test Server**. That's it for the default (WebSocket) transport —
   nothing else to set up.
4. Want the WebRTC transport instead? See [Setting up WebRTC](#setting-up-webrtc) below — it needs
   a bit more, since (unlike WebSocket) there's a second service to deploy first.

## The gear menu

Click the gear icon (⚙) next to **Join Test Server** to open the config panel:

- **Transport** — `WebSocket` (default) or `WebRTC (UDP)`. Switch any time; both addresses below
  are remembered independently, so switching back and forth never means retyping either one.
- **WebSocket address** — `host:port` of the server's WS listener (e.g. `127.0.0.1:8080` for a
  local server, or your VPS's `host:port` — see the main repo's `deploy/README.md`). Loopback
  addresses use `ws://`; anything else uses `wss://` automatically. Works the moment the server is
  running — nothing else to configure.
- **WebRTC signaling URL** — the full `wss://.../v0/signaling` URL of your
  [netlib-signaling](../netlib-signaling/) deployment. There's no working default for this one
  (unlike the WS address) — a netlib signaling URL always has to be a real `wss://` endpoint, even
  for local testing, so it has to be your own, and it needs that deployment to exist first (see
  below).

Hit **Save**. If you're already on the test server it reconnects automatically; otherwise the new
settings just take effect next time you click **Join Test Server**.

## Setting up WebRTC

This is opt-in, and needs more than flipping the gear-menu dropdown: WebRTC has no server-side
default the way WebSocket does, because it needs a whole second service — see
[netlib-signaling](../netlib-signaling/) — to actually exist first. Skip this section entirely if
WebSocket is working fine for you; there's no benefit to WebRTC beyond better behavior on lossy
connections (it avoids TCP head-of-line blocking).

1. Deploy [netlib-signaling](../netlib-signaling/) (its own README covers this).
2. The userscript's `@require` line loads netlib's browser client library, which Tampermonkey
   fetches once at install/update time — it has to point at a real URL:
   ```
   // @require      https://your-netlib-signaling-domain.example/netlib-client.js
   ```
   Change `your-netlib-signaling-domain.example` to wherever you deployed netlib-signaling — it
   serves this exact file (see that directory's `setup-signaling-service.sh`, which prints the
   Caddy block for it).
3. Set the matching **WebRTC signaling URL** in the gear menu (same domain, `/netlib/v0/signaling`
   path), and switch **Transport** to `WebRTC (UDP)`.

Until you do all three, WebRTC fails closed with a clear console error — WebSocket keeps working
regardless, since the two transports don't depend on each other at all.

## What else this script does

Beyond the transport switch, it also bridges your real identity (name, loadout, skin) into the
custom server's join packet so a test-server session looks like your real account rather than a
guest, routes chat over the game socket (the social/chat service isn't reachable from a custom
server), and includes a few small resilience patches (a position/velocity snap-recovery watchdog
for large desyncs, an NaN guard) — none of which are configurable, and none of which do anything
while you're on official play.

## Scope and disclaimer

This works by patching the official ev.io client bundle *in your own browser, at runtime* to
redirect its network connection — it does not modify, host, or redistribute any part of that
bundle. Only use it to connect to servers you run or trust (like this one), never to interfere
with official ev.io or its players. See the main repo's own
[Scope and disclaimer](../README.md#scope-and-disclaimer) — the same terms apply here.
