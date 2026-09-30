# Vendored copy of proofnetworks/netlib

Pinned at upstream commit `5ad26fbbeaa1fc02680539f94b9aa632df99c5cc`
(2026-06-25, "Add binary serialization, interest broadcasting, and topology docs").

Built from source deliberately (not `npm install @poki/netlib` / `go get`), for two reasons:
- That npm package name is Poki's own upstream registry entry — it would silently pull the
  unmodified original, not this ProofNetworks-aligned fork's extensions (auto binary
  serialization, area-of-interest broadcasting) that this fork exists for.
- We wanted the freedom to modify it ourselves, and did (see below) — a beta library with
  an unfinished feature we specifically needed is exactly the case where "we can just fix
  it" beats waiting on someone else's roadmap.

Version is intentionally FIXED here — do not `git pull` this into latest. Re-vendoring
(picking a new upstream commit) should be a deliberate, reviewed step, same as any other
dependency bump, not something that happens silently.

## Our modifications vs. upstream

**Generic (coturn) TURN credentials, not just Cloudflare Calls.** Upstream wired
`internal/signaling` directly to the concrete `*cloudflare.CredentialsClient` type, so TURN
was Cloudflare-only by construction — self-hosting meant either taking on a Cloudflare
account as a second third-party dependency, or no TURN relay fallback at all (STUN-only,
which fails for players behind strict/symmetric NATs — exactly the connections most likely
to need TURN in the first place).

Added:
- `internal/turnauth/turnauth.go` — the `Provider` interface (`Run` + `GetCredentials`) and
  a shared `Credentials` type. `cloudflare.Credentials` is now a type ALIAS to this (see
  `internal/cloudflare/types.go`), so `*cloudflare.CredentialsClient` satisfies the new
  interface with no changes to its own code — Go's structural typing does that for free.
- `internal/turnauth/sharedsecret.go` — `SharedSecretProvider`, computing coturn's
  "TURN REST API" convention credentials (`username = expiry timestamp`,
  `password = base64(HMAC-SHA1(secret, username))`) locally and synchronously — no network
  call, unlike Cloudflare's API-fetched-and-cached credentials, so its `Run` is a no-op.
  Verified against an independently-computed reference HMAC in
  `internal/turnauth/sharedsecret_test.go`, not just against itself.
- `internal/turnauth/turnauth.go`'s `NoopProvider` — STUN-only, no TURN at all, for a
  deployment that sets neither `TURN_SHARED_SECRET` nor `CLOUDFLARE_APP_ID`.
- `internal/signaling.go`, `internal/signaling/handler.go`: parameter type changed from
  `*cloudflare.CredentialsClient` to `turnauth.Provider`.
- `cmd/signaling/main.go`: new `newTurnProvider()` picks the provider from the environment —
  `TURN_SHARED_SECRET` (+ `TURN_URL`) takes priority over `CLOUDFLARE_APP_ID`, so a
  deployment that sets both is unambiguous.

Verified: `go build ./...`, `go vet ./...`, and `go test ./internal/...` all clean on this
modified tree (Go 1.25.0), plus the JS/TS half (`npx parcel build`) producing
`dist/netlib.js`, `dist/legacy.js`, `dist/index.d.ts`.

**Node (`@roamhq/wrtc`) `setLocalDescription()` fix, `lib/peer.ts`.** Found live: our signaling
server's `handleNegotiationNeeded()` and its offer-handling branch in `onSignalingMessage()`
both call `this.conn.setLocalDescription()` with NO argument on the happy path, relying on the
modern WebRTC spec feature where the browser infers offer-vs-answer from the current signaling
state. Upstream's own source already knew this fails under Node + `@roamhq/wrtc` — both call
sites had a correct, explicit-description fallback already written, but gated behind
`process.env.NODE_ENV === 'test'`, so any real Node deployment (NODE_ENV unset/'production')
still took the zero-arg path and threw `TypeError: Expected an object` from
`@roamhq/wrtc`'s `setLocalDescription` (it forwards the argument as-is to its native binding,
with no such inference). Fixed by replacing that condition with an `isNodeRuntime()` runtime
check. That check is deliberately written as a function reading `globalThis.process` through a
computed property access, NOT the more obvious top-level `const isNodeRuntime = typeof process
!== 'undefined' && ...` — Parcel's bundler was found silently CONSTANT-FOLDING that exact idiom
to `false` at build time (the standard "eliminate the Node-only branch for a browser build"
isomorphic-library optimization), which shipped a `const isNodeRuntime = false` in
`dist/netlib.js` on the first attempt and looked, from the outside, exactly like the original
bug was still unfixed. Re-verify after any rebuild: `dist/netlib.js` should NOT contain a
literal `= false` next to this function's compiled name. A real browser peer (the userscript's
side of this migration) is unaffected either way — it never takes this branch.

**`eventemitter3` is an external (not bundled) dependency of the `main`/CJS build.** Unlike the
`legacy` (browser) target, which sets `includeNodeModules: true` and bundles it in, `dist/netlib.js`
`require()`s it at runtime. `server/package.json` must list it as a real dependency (added — see
that file) or every `require('./vendor/netlib.js')` throws `Cannot find module 'eventemitter3'`
the moment it's loaded, regardless of anything else being correct.

**Consumers must polyfill `WebSocket`, not just `RTCPeerConnection`, on Node < 22.** Not a
change to this vendored library — a note for `server/netlib_adapter.js` (which does it; see
that file's `ensureWebRtcPolyfill()`). netlib's signaling connection does a plain browser-style
`new WebSocket(url)` (`lib/signaling.ts`'s `connect()`). A global `WebSocket` only shipped
stable in Node 22 — found live on our VPS's Node v20.20.2, where every netlib listener start
threw `ReferenceError: WebSocket is not defined` from deep inside `netlib.js` itself (past our
own code, so easy to misdiagnose as something else). The `ws` package's top-level `WebSocket`
export (not its server class) is a drop-in browser-compatible polyfill and is already a
dependency of this project for the real game socket.

## Current deployment status (as of the netlib migration's Phase 1)

Postgres, coturn, the signaling server (systemd + Caddy), and both transport adapters
(`server/netlib_adapter.js` server-side, `NetlibFakeSocket` in the userscript client-side) are
built, deployed, and verified end-to-end against the real self-hosted stack — including the
PRODUCTION `evio.service`, which now runs with `netlibEnabled=true` and is confirmed hosting a
discoverable, `customData`-verified lobby. See the netlib migration plan
(`C:\Users\Balan\.claude\plans\nested-puzzling-hanrahan.md`) for the full phase breakdown; Phase
2 (validating a REAL browser client, not just the Node-side probes used to verify the protocol)
has not started.
