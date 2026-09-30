/**
 * test_health_regen.js — health regeneration, ported from the bundle (:34554-34558).
 *
 * Two ways to start regenerating, and the kill path is what makes the game feel forgiving:
 *   ordinary   no damage taken for Qmu3ptg = 100 ticks (5s)
 *   after kill regenXTicksAfterKill = 20 ticks (1s) after a kill, bypassing the damage timer
 *
 * Rate is Qewwuid = 0.01 per tick, and HP is 0..1, so a full heal takes 100 ticks / 5s.
 *
 * Taking damage resets the wait AND clears the kill-granted regen (:34472) — a kill does not make
 * you immune to being interrupted. The server had NO regen at all before this.
 *
 * Usage:  node scripts/test_health_regen.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');
const settings = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}
const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const mk = () => ({
  id: 'p', healthPoints: 1, armorPoints: 0, deathStateTimer: 0, kills: 0,
  ticksSinceDamage: 99999, ticksSinceKill: 99999, forceRegen: false,
});
const tick = (p, n) => { for (let i = 0; i < n; i++) srv.tickHealthRegen(p); };

const DELAY = settings.list().find((x) => x.key === 'regenDelayTicks').value;
const KILL = settings.list().find((x) => x.key === 'regenAfterKillTicks').value;
const RATE = settings.list().find((x) => x.key === 'regenRate').value;

console.log('\n── the constants come from the bundle ──');
{
  ok('delay is Qmu3ptg = 100 ticks (5s)', DELAY === 100, String(DELAY));
  ok('post-kill window is regenXTicksAfterKill = 20 (1s)', KILL === 20, String(KILL));
  ok('rate is Qewwuid = 0.01/tick', near(RATE, 0.01), String(RATE));
  ok('so a full heal takes 5 seconds', near((1 / RATE) / 20, 5), `${(1 / RATE) / 20}s`);
}

console.log('\n── damage restarts the wait ──');
{
  const p = mk();
  srv.applyDamage(p, 0.6, null, {});
  ok('health went down', near(p.healthPoints, 0.4), String(p.healthPoints));
  ok('the damage timer reset', p.ticksSinceDamage === 0);

  tick(p, DELAY);
  ok('nothing regenerates before the delay elapses', near(p.healthPoints, 0.4),
    `hp=${p.healthPoints} after ${DELAY} ticks`);
  tick(p, 20);
  ok('then it heals at the bundle rate', near(p.healthPoints, 0.4 + 20 * RATE, 1e-4),
    `hp=${p.healthPoints}`);
  tick(p, 500);
  ok('and stops exactly at full', near(p.healthPoints, 1), String(p.healthPoints));
}

console.log('\n── a kill starts regen early ──');
{
  const p = mk();
  srv.applyDamage(p, 0.5, null, {});
  p.ticksSinceKill = 0;                    // as if this player just got a kill
  tick(p, KILL - 1);
  ok('still waiting one tick before the window', near(p.healthPoints, 0.5),
    String(p.healthPoints));
  tick(p, 1);
  ok('regen starts exactly on the kill tick', p.healthPoints > 0.5, String(p.healthPoints));
  ok('and it beat the ordinary delay', KILL < DELAY, `${KILL} < ${DELAY}`);
}

console.log('\n── being hit interrupts it ──');
{
  const p = mk();
  srv.applyDamage(p, 0.5, null, {});
  p.ticksSinceKill = 0;
  tick(p, KILL + 5);
  ok('regen is running', p.healthPoints > 0.5 && p.forceRegen === true);

  srv.applyDamage(p, 0.1, null, {});
  ok('the kill-granted regen is cancelled', p.forceRegen === false,
    'otherwise a kill would make you un-interruptible');
  const hp = p.healthPoints;
  tick(p, 10);
  ok('and healing stops', near(p.healthPoints, hp), `${hp} -> ${p.healthPoints}`);
}

console.log('\n── a kill actually sets the killer\'s window ──');
{
  const killer = mk(), victim = mk();
  srv.applyDamage(killer, 0.5, null, {});          // killer is hurt
  killer.ticksSinceKill = 99999;
  srv.applyDamage(victim, 2, killer, {});          // killer finishes victim off
  ok('the victim died', victim.deathStateTimer > 0);
  ok('the killer\'s post-kill window opened', killer.ticksSinceKill === 0,
    String(killer.ticksSinceKill));
  tick(killer, KILL);
  ok('so the killer starts healing a second later', killer.healthPoints > 0.5,
    String(killer.healthPoints));
}

console.log('\n── the dead do not heal ──');
{
  const p = mk();
  srv.applyDamage(p, 1, null, {});
  ok('player is down', p.healthPoints === 0 && p.deathStateTimer > 0);
  tick(p, DELAY + 100);
  ok('no regeneration while dead', p.healthPoints === 0, String(p.healthPoints));
}

console.log('\n── regen can be turned off (noHealthRegen gamemodes) ──');
{
  const prev = settings.get('healthRegen');
  settings.set('healthRegen', false);
  const p = mk();
  srv.applyDamage(p, 0.5, null, {});
  tick(p, DELAY + 100);
  ok('the timer path is disabled', near(p.healthPoints, 0.5), String(p.healthPoints));
  settings.set('healthRegen', prev);
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
