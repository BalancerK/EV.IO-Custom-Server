/**
 * test_guest.js — guests get a numbered name and a real loadout.
 *
 * TWO THINGS WERE MISSING
 * ───────────────────────
 * 1. NAME. Every guest shares ev.io's single guest account (uid 17), so without a per-player name
 *    the scoreboard and kill feed showed an indistinguishable column of "Guest". The official server
 *    assigns "Guest" + 1..9999 on join. It has to be the SERVER that does this: uniqueness is a
 *    property of the lobby, which only the server can see, and a client-chosen name could collide
 *    or be spoofed.
 *
 * 2. LOADOUT. A guest has no server-side account fields, so the /me response carries no weapon and
 *    no abilities. The client fills them in itself, from its local settings store, right before use:
 *        account.field_primary_weapon[0].value    = settings.primaryWeaponId
 *        account.field_abilities_loadout[0].value = settings.abilityBuild
 *    The userscript captured the RAW response, which is before that step, so guests always joined
 *    with an empty loadout and the server fell back to defaults — stock Auto Rifle, no abilities,
 *    whatever the player had actually chosen. The userscript now reads the same store
 *    (localStorage 'ev_settings_k') and uses it to fill gaps only; a registered account's
 *    server-side loadout still wins.
 *
 * Usage:  node scripts/test_guest.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

console.log('\n── which names may be replaced ──');
{
  // Anything a guest arrives with by default is fair game...
  for (const n of [undefined, null, '', '   ', 'Guest', 'local-p1', 'Guest42']) {
    ok(`replaceable: ${JSON.stringify(n)}`, srv.isGuestName(n) === true);
  }
  // ...but a name the player actually chose is theirs.
  for (const n of ['Balan', 'xX_sniper_Xx', 'Guest of Honour', 'GuestStar']) {
    ok(`kept: ${JSON.stringify(n)}`, srv.isGuestName(n) === false);
  }
}

console.log('\n── the generated name matches the official format ──');
{
  const seen = new Set();
  for (let i = 0; i < 400; i++) {
    const n = srv.allocateGuestName(new Map());
    seen.add(n);
    if (!/^Guest([1-9]\d{0,3})$/.test(n)) {
      ok('format Guest1..Guest9999', false, `got ${n}`);
      break;
    }
  }
  ok('format Guest1..Guest9999 across 400 draws', true);
  ok('the number actually varies', seen.size > 50, `${seen.size} distinct names in 400 draws`);
  const nums = [...seen].map((n) => parseInt(n.slice(5), 10));
  ok('never 0 and never above 9999',
    Math.min(...nums) >= 1 && Math.max(...nums) <= 9999,
    `range ${Math.min(...nums)}..${Math.max(...nums)}`);
}

console.log('\n── it does not collide with names already in the lobby ──');
{
  // Fill the lobby with everything except one free slot; the allocator must find it rather than
  // hand out a duplicate.
  const sessions = new Map();
  for (let n = 1; n <= 9999; n++) {
    if (n === 7777) continue;
    sessions.set('s' + n, { displayName: `Guest${n}` });
  }
  ok('finds the single remaining free name', srv.allocateGuestName(sessions) === 'Guest7777',
    'a duplicate would make two players indistinguishable on the scoreboard');

  // The common case: a few players, no collision.
  const small = new Map([['a', { displayName: 'Guest1' }], ['b', { displayName: 'Balan' }]]);
  const got = srv.allocateGuestName(small);
  ok('avoids an existing guest name', got !== 'Guest1', got);
  ok('and ignores non-guest names', /^Guest\d+$/.test(got), got);
}

console.log('\n── a full lobby degrades gracefully instead of hanging ──');
{
  // Every name taken. The allocator must still return promptly rather than loop for ever.
  const full = new Map();
  for (let n = 1; n <= 9999; n++) full.set('s' + n, { displayName: `Guest${n}` });
  const t0 = Date.now();
  const got = srv.allocateGuestName(full);
  const ms = Date.now() - t0;
  ok('returns a name', /^Guest\d+$/.test(got), String(got));
  ok('and returns quickly', ms < 500, `${ms} ms`);
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
