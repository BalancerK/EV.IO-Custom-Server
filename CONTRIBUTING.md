# Contributing

Thanks for wanting to work on this. This doc assumes you've never touched the codebase before —
if you want the big-picture map of how everything fits together first, read
[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md); this doc is about the *process* of making a
change, not the architecture itself.

## Getting set up

```bash
git clone https://github.com/BalancerK/EV.IO-Custom-Server.git
cd EV.IO-Custom-Server
npm install
npm start
```

That starts the game server on `ws://127.0.0.1:8080` and the admin dashboard on
`http://127.0.0.1:8081`. To actually connect a real client to it and see it play, you need the
userscript in [`userscript/`](userscript/) — see its own README for installation. You don't
strictly need a real client connected to work on most changes (the test suite simulates
connections directly), but for anything about *feel* (movement, combat timing, bot behavior),
playing it for real is the only way to actually tell if a change is good.

Run the test suite before and after your change:

```bash
npm test
```

If `npm test` was already failing before you touched anything, that's a pre-existing issue —
don't let it block your own change, but do mention it in your PR so it's not confused with
something you introduced. (One suite, `test:browser`, drives a real headless browser via
Playwright and needs `npx playwright install chromium` run once first, or it fails on a fresh
clone with no connection to anything you changed.)

## Before you start: is this the right repo?

This repo is the **server**. If your issue is actually about:
- a Chrome extension's lobby UI or hosting flow → that's
  [EV.IO-UI-Enhancer](https://github.com/BalancerK/EV.IO-UI-Enhancer), a separate repo that
  ports this server's own simulation code to run inside a browser extension.
- the client-side userscript specifically (install issues, transport switching) →
  [`userscript/README.md`](userscript/README.md) in this repo covers that, but the userscript's
  own code is small and separate from everything in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md).

If you're not sure, open an issue describing the problem and it can get pointed the right
direction before you invest time in a fix.

## How to find where a bug actually is

A huge fraction of bugs in this project take the same shape: **the client and the server
disagree about something**, and the symptom is a visible correction snap, a wrong HUD value, or
a missed hit. The approach that works, in order:

1. **Reproduce it with a real client**, not just by reading code — reconciliation bugs in
   particular are often invisible from the server's own logs alone.
2. **Find the client's own code for that behavior.** The official client is minified
   (`Qxxxxxx`-style names — see
   [`docs/ARCHITECTURE.md` §4](docs/ARCHITECTURE.md#4-the-wire-protocol-opcodes-msgpack-and-those-qxxxxxx-names)
   if that's unfamiliar), but it's still just JavaScript you can read in a debugger or beautify
   and search. What does it actually do, and what field/opcode does it key that behavior off?
3. **Grep this codebase for that same field name or opcode number.** It's very likely already
   referenced somewhere — either correctly handled, or the exact gap causing your bug. Existing
   comments usually cite the opcode number and sometimes a `bundle :NNNNN` line reference from
   wherever the author was reading the client at the time.
4. **Fix it, then write (or extend) a test that would have caught it** — see below.

Opening an issue with "the client's field is `Qxxxxxx` (opcode NNN), and here's what it does" is
genuinely useful even if you don't have time to fix it yourself — that's most of the hard part of
diagnosing one of these.

## Writing tests

Every `scripts/test_*.js` file is a plain Node script, not a framework-based suite — run directly
(`node scripts/test_whatever.js`) and wired into `npm test` via `package.json`. Look at a few
existing ones (`test_counters.js` is a good example) for the shape:

- A comment block at the top explaining **what bug this guards against** — what the client does,
  what broke, what the fix was. Write this like you're explaining it to someone who's never seen
  the bug, because that's exactly who'll read it next.
- A tiny `ok(description, condition, detail)` helper that logs ✓/✗ and tracks a pass/fail count,
  printed at the end, with a non-zero exit code on any failure (so `npm test`'s chained `&&` stops
  at the first real failure).
- Tests build state directly (`createPlayerSimState`, `appendPlayerTickBody`, etc. — exported from
  `local_ws_server.js`) rather than spinning up a real WebSocket server, where that's enough to
  exercise the behavior. A few do open a real socket (`EVIO_LOCAL_PORT` set to a throwaway port)
  where the thing being tested genuinely needs a real connection.

**If your test creates a player state directly and expects it to act like an actual, in-match
player** (able to take damage, stream weapon slots, move from a real position), set
`process.env.EVIO_CLICK_TO_PLAY = '0'` before requiring `local_ws_server.js` — "Hold new players
until they click to play" defaults ON, and a held player is deliberately a spectator (no damage,
no weapon, zeroed position) until something explicitly lets them in. Nearly every existing test
file does this already; it's at the top, right after the other `process.env` lines.

Add your new test's npm script to `package.json`'s `scripts` block and to the big `test`
chain in the same file, in roughly the same position as conceptually similar existing tests.

## Code conventions this repo actually follows

- **Comments explain *why*, not *what*.** `x += 1 // increment x` would never appear here; a
  comment exists when the reason something is written a particular way isn't obvious from the
  code alone — a client quirk being matched, a bug that was fixed and why the fix looks the way it
  does, a tradeoff that was deliberately made. If you can't explain *why* a line needs to exist
  the way you wrote it, that's worth a comment; if the "why" is just restating the code, skip it.
- **No speculative abstraction.** This codebase doesn't add a config system, an interface, or a
  helper "for future flexibility" — see something that needs to vary, register it as a setting
  (§7 of the architecture doc) when it does, not before.
- **Settings over hardcoded constants** for anything an operator might reasonably want to tune —
  but not for internal implementation details that aren't actually meant to be changed.
- **Parity with the real client is the default assumption**, not a nice-to-have. If you're
  changing combat/physics/netcode behavior and it's not an explicit, intentional departure from
  how the official game behaves, it's probably a bug, not a feature.

## Submitting a change

1. Fork, branch, make your change.
2. `npm test` passes (or you've called out which pre-existing failures aren't yours).
3. Open a PR describing: what the bug/feature was, how you found/verified it (ideally against a
   real client, per the diagnosis section above), and which test covers it now.
4. Be ready to explain *why* your change does what it does if asked — not because your work is
   being doubted, but because "why" is exactly what every other comment in this codebase already
   tries to answer, and it keeps the project navigable for whoever reads this code next.
