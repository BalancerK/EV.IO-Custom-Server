/**
 * test_default_build.js — a player who sends no ability build has the DEFAULT build.
 *
 * The client only sends its build when it differs from makeDefaultAbilityObject() (1-7-1 bundle
 * :44324), so "no build in the join" means the default one, not "no abilities". Official servers
 * apply it. A guest captured on an official server (probe of an EU earn room) had, among others,
 * maxJumps 2 and jumpPower 0.77. We had:
 *   - the bootstrap: jumpPower 0.77 but maxJumps 1 (defaultStats, hand-edited from 2 to 1), and
 *   - the physics: jumpPower 0.6 and maxJumps 1 (the zero-point base), and no build at all, so the
 *     grenade cast (which reads the build) never fired for a guest.
 * So guests could not double jump, every jump was corrected down, and they could not throw grenades.
 *
 * Usage:  node scripts/test_default_build.js
 */
'use strict';

const { computeWeaponStats, DEFAULT_ABILITY_BUILD } = require('../ability_stats');
const sb = require('../state_builder');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

// Opcodes 95-123 for a guest on an official server (empty build), keyed by our stat names.
const OFFICIAL_GUEST = {
  Qtgt1xt: 1, Qkrh1tv: 14, Q30g2w8: 0.001, Qpe67c9: 0, Qn97q6u: 0.0048, Qli8ip8: 0, Qr55etv: 0.00125,
  Qcwj9qw: 1, Q3krbfo: 1, Q3dl2jp: 0, Qv2yox8: 1, Qtwdri6: 0, Qxjrmbn: 0, Qmytalm: 1,
  Q7v2lyo: 2, Qfh4lso: 0.77, Qbypopp: 0.006, Qhswtsz: 12, Qvven1v: 3, Qk0k6ey: 1, Qe2qk8v: 1,
  Qpxm6gp: 0, Q8i9f3s: 0.7, Qc804je: 0, Qak7t2v: 0, Q6o3kdb: 0.45, Q3kqjty: 0,
};

console.log('\n── the default build is the client\'s own ──');
ok('19 entries, Jump at level 2',
  DEFAULT_ABILITY_BUILD.length === 19 && DEFAULT_ABILITY_BUILD[1] === 2 && DEFAULT_ABILITY_BUILD.join(',') === '1,2,0,2,1,0,0,0,1,1,0,0,0,1,0,0,1,0,0');

console.log('\n── it reproduces an official guest ──');
{
  const st = computeWeaponStats(DEFAULT_ABILITY_BUILD);
  const bad = Object.entries(OFFICIAL_GUEST).filter(([k, v]) => Math.abs((st[k] ?? NaN) - v) > 1e-9);
  ok(`all ${Object.keys(OFFICIAL_GUEST).length} captured values match`, bad.length === 0,
    bad.map(([k, v]) => `${k}: official ${v}, ours ${st[k]}`).join('; '));
  ok('two jumps', st.Q7v2lyo === 2);
  ok('jump power 0.77', Math.abs(st.Qfh4lso - 0.77) < 1e-9);
}

console.log('\n── the bootstrap for a player with no build ──');
{
  const body = sb.buildFirstSpawnBody({ playerId: 'g', displayName: 'guest' });
  const flat = Array.isArray(body) ? body : (body && body.body) || [];
  // The attribute block is "93, build, 95, v, 96, v, ... 123, v" — find it by its 93 marker.
  const i93 = flat.findIndex((v, i) => v === 93 && Array.isArray(flat[i + 1]) && flat[i + 2] === 95);
  ok('the attribute block is there', i93 >= 0);
  const at = (op) => { for (let i = i93; i < flat.length - 1; i += 2) if (flat[i] === op) return flat[i + 1]; return undefined; };
  ok('it reports the default build (opcode 93), as official does for a guest', Array.isArray(flat[i93 + 1]) && flat[i93 + 1].join(',') === DEFAULT_ABILITY_BUILD.join(','), JSON.stringify(flat[i93 + 1]));
  ok('maxJumps (110) = 2, as official', at(110) === 2, String(at(110)));
  ok('jumpPower (111) = 0.77', Math.abs(at(111) - 0.77) < 1e-9, String(at(111)));
}

console.log('\n── the join applies it to the physics ──');
{
  const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'local_ws_server.js'), 'utf8');
  ok('a join without a build gets computeWeaponStats(DEFAULT_ABILITY_BUILD) and the build on the physics state',
    /computeWeaponStats\(DEFAULT_ABILITY_BUILD\)\);[\s\S]{0,120}weaponStateArray = DEFAULT_ABILITY_BUILD\.slice\(\)/.test(src));
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
