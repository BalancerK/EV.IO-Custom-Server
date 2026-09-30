/**
 * test_impulse_sync.js — the server must not lie about a blast on the tick it happens.
 *
 * THE BUG
 * ───────
 * Tick order is: integrate players -> simulate grenades -> build tick bodies. integratePlayerSim
 * copies the physics state (`_ps`) into the legacy mirror at the END of integration, but grenades
 * run AFTER that. So applyImpulse / applyExplosionKnockback wrote ps.Qyaswvo and ps.Q9t2fit while
 * the mirror — which is what appendPlayerTickBody actually serialises — still held the pre-blast
 * values.
 *
 * The packet for the blast tick therefore said "still grounded, moving exactly as you predicted".
 * Q9t2fit is one of the fields the client's comparator (Qqx5i3b) checks, so that reads as a MATCH
 * and reconciliation does not fire. The client cannot predict the blast itself — grenades are
 * server-streamed entities with no client-side collider — so it just carries on standing still
 * while the server flings the player, and the correction only arrives later.
 *
 * Usage:  node scripts/test_impulse_sync.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';
const srv = require('../local_ws_server');
const bpw = require('../physics_world');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

const readOp = (body, op) => {
  for (let i = 0; i < body.length - 1; i++) if (body[i] === op && body[i - 1] !== op) return body[i + 1];
  return undefined;
};

(async () => {
  await bpw.ready;
  const sp = bpw.spawnPoints[0];

  function settledPlayer(id) {
    const p = srv.createPlayerSimState({ x: sp.x, y: sp.y, z: sp.z, yaw: 0 }, id);
    for (let t = 0; t < 20; t++) srv.integratePlayerSim(p, 0.05, t + 1);
    return p;
  }

  console.log('\n── an impulse at your feet is visible in the SAME tick ──');
  {
    const p = settledPlayer('imp-1');
    ok('player is settled on the ground first', p.grounded === true);
    const before = { vy: p.velocity.y, grounded: p.grounded };

    // Detonate right under the player, exactly as simulateGrenades does after integration.
    const sessions = new Map([['s1', { accepted: true, sessionId: 's1', playerState: p }]]);
    srv.applyImpulse({ x: p.position.x, y: p.position.y, z: p.position.z }, sessions);

    ok('the physics state was flung', p._ps.Qyaswvo.y > 0 && p._ps.Q9t2fit === false,
      `ps.vy=${p._ps.Qyaswvo.y.toFixed(3)} grounded=${p._ps.Q9t2fit}`);
    // The mirror is what gets serialised — it must agree with physics immediately.
    ok('the legacy mirror agrees with physics (velocity)',
      Math.abs(p.velocity.y - p._ps.Qyaswvo.y) < 1e-9,
      `mirror=${p.velocity.y.toFixed(3)} physics=${p._ps.Qyaswvo.y.toFixed(3)}`);
    ok('the legacy mirror agrees with physics (grounded)', p.grounded === p._ps.Q9t2fit,
      `mirror=${p.grounded} physics=${p._ps.Q9t2fit}`);
    ok('grounded actually changed from the pre-blast value', before.grounded !== p.grounded);

    // And it must reach the wire on THIS tick, not the next one.
    const body = [];
    srv.appendPlayerTickBody(body, 'imp-1', p);
    const grounded = readOp(body, 139);
    ok('the emitted packet reports airborne',
      grounded === false || grounded === 0,
      `opcode 139 = ${grounded} (a "grounded" packet reads as a MATCH and suppresses reconcile)`);
  }

  console.log('\n── explosion knockback does the same ──');
  {
    const p = settledPlayer('kb-1');
    const sessions = new Map([['s1', { accepted: true, sessionId: 's1', playerState: p }]]);
    srv.applyExplosionKnockback(p, { x: p.position.x, y: p.position.y, z: p.position.z }, 50, 10, 1);
    ok('mirror velocity matches physics', Math.abs(p.velocity.y - p._ps.Qyaswvo.y) < 1e-9);
    ok('mirror grounded matches physics', p.grounded === p._ps.Q9t2fit && p.grounded === false);
  }

  console.log('\n── a player outside the blast is untouched ──');
  {
    const p = settledPlayer('far-1');
    const v0 = { ...p.velocity }, g0 = p.grounded;
    const sessions = new Map([['s1', { accepted: true, sessionId: 's1', playerState: p }]]);
    srv.applyImpulse({ x: p.position.x + 500, y: p.position.y, z: p.position.z }, sessions);
    ok('velocity unchanged', p.velocity.y === v0.y && p.velocity.x === v0.x);
    ok('still grounded', p.grounded === g0);
  }

  console.log('\n── the fling actually carries into the next tick ──');
  {
    const p = settledPlayer('imp-2');
    const y0 = p.position.y;
    const sessions = new Map([['s1', { accepted: true, sessionId: 's1', playerState: p }]]);
    srv.applyImpulse({ x: p.position.x, y: p.position.y, z: p.position.z }, sessions);
    srv.integratePlayerSim(p, 0.05, 100);
    ok('the player is higher after integrating', p.position.y > y0,
      `y ${y0.toFixed(2)} -> ${p.position.y.toFixed(2)}`);
    ok('position stays finite', Number.isFinite(p.position.y));
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
