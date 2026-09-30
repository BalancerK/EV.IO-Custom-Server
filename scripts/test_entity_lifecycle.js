/**
 * test_entity_lifecycle.js — nothing thrown may become permanent scenery.
 *
 * THE REPORT
 * ──────────
 * "sometime the throwable like grenade, impulse etc cannot explode or trigger, and they will stay on
 *  the map and not dissapear, sometime i can see it but peers cant... also sometimes trip mine and
 *  mine doesnot dissapear after player that place them die or after the round end."
 *
 * FOUR DISTINCT CAUSES
 * ────────────────────
 * 1. NO ERROR ISOLATION. simulateGrenades iterated activeEntities in a bare loop, called straight
 *    from the tick. A throw from any one entity's trigger logic escaped the whole function — losing
 *    firing, death/respawn and the broadcast for that tick — and aborted the loop at the SAME entity
 *    every tick, so that entity and every one after it in the Map stopped advancing permanently.
 *    That is precisely "cannot explode or trigger, and they stay on the map".
 *
 * 2. NO ABSOLUTE LIFETIME. Every removal path went through some rule (a fuse, a proximity trigger, an
 *    owner check). If any rule could not be reached, nothing else would ever remove the entity.
 *
 * 3. REMOVALS WERE SENT ON EXACTLY ONE TICK. A client that did not decode that one entity block kept
 *    the grenade on screen for ever — one player seeing an unexploded grenade that others do not.
 *
 * 4. NO ROUND / MAP CLEANUP AT ALL. There was no activeEntities.clear() anywhere in the server, so a
 *    mine planted in round 1 was still armed in round 2, and after a map change it sat at coordinates
 *    from the previous world.
 *
 * Usage:  node scripts/test_entity_lifecycle.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';

const fs = require('fs');
const path = require('path');
const srv = require('../local_ws_server');
const bpw = require('../physics_world');
const S = require('../settings');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

const E = srv.activeEntities;
const reset = () => { E.clear(); srv._entityRemovalRepeat.clear(); };
// A minimal live entity, shaped like spawnGrenade's.
let _k = 0;
function addEntity(over = {}) {
  const key = `t${++_k}`;
  E.set(key, {
    sessionId: key, ownerSid: 'owner-1',
    pos: { x: 0, y: 5, z: 0 }, vel: { x: 0, y: 0, z: 0 },
    type: 53, spawnTick: 0, fuse: 35, ...over,
  });
  return key;
}
const removalsInBlock = () => {
  const b = srv.buildActiveEntityBlock();
  const out = [];
  for (let i = 0; i < b.length - 2; i++) if (b[i] === 268 && b[i + 1] === -1) out.push(b[i + 2]);
  return out;
};

(async () => {
  await bpw.ready;
  const sessions = new Map();

  console.log('\n── a throwing entity cannot take the tick down with it ──');
  {
    reset();
    // A getter that throws whenever the sim touches this entity's position — a stand-in for any fault
    // in trigger logic. The point is not the specific fault; it is that ONE bad entity used to stop
    // every other entity from advancing, for the rest of the session.
    const badKey = 'bad';
    E.set(badKey, {
      sessionId: badKey, ownerSid: 'owner-1', vel: { x: 0, y: 0, z: 0 },
      type: 53, spawnTick: 0, fuse: 35,
      get pos() { throw new Error('synthetic entity fault'); },
    });
    // `settled` so the only thing that can happen to it this tick is the fuse decrement — a live
    // flash grenade would legitimately detonate on ground contact and removal would prove nothing.
    const goodKey = addEntity({ fuse: 10, settled: true });

    let threw = false;
    try { srv.simulateGrenades(0.05, sessions); } catch (_) { threw = true; }
    ok('simulateGrenades does not throw', !threw,
      'it is called bare from the tick — a throw here also loses firing, respawns and the broadcast');
    ok('the faulty entity is removed, not left to throw again', !E.has(badKey),
      'permanent scenery that also costs everyone a tick every tick');

    // And the healthy one must still be counting down — it used to be skipped entirely.
    const good = E.get(goodKey);
    ok('a healthy entity behind it still advanced', good && good.fuse < 10,
      `fuse=${good && good.fuse} (was 10) — it used to be skipped entirely, every tick, for ever`);
  }

  console.log('\n── the fuse always counts, even if it arrives broken ──');
  {
    reset();
    // A non-finite fuse never satisfies `fuse <= 0`, so the entity would live for ever on the one
    // path that is supposed to guarantee removal.
    for (const bad of [NaN, undefined, null, Infinity]) {
      const key = addEntity({ fuse: bad });
      for (let i = 0; i < 4; i++) srv.simulateGrenades(0.05, sessions);
      const e = E.get(key);
      ok(`fuse ${String(bad)} still resolves`, !e || Number.isFinite(e.fuse),
        `fuse=${e && e.fuse}`);
      reset();
    }
  }

  console.log('\n── the absolute lifetime cap is the backstop ──');
  {
    reset();
    const cap = S.get('entityMaxLifetimeTicks');
    ok('the cap is above the longest legitimate life', cap > 1200,
      `${cap} vs MINE_LIFETIME 1200 — a lower cap would cut working mines short`);

    // An entity contrived to dodge every OTHER removal rule: a stuck, unarmed mine whose fuse is
    // continually refreshed. Only the cap can end this.
    const key = addEntity({
      type: 173, _bornTick: -(cap + 10), isStuck: true, armed: false,
      combat: { behavior: 'mine', dmg: 100, aoe: 8, proxyDistance: 3, fuse: 1200 },
      fuse: 99999,
    });
    // Give it a live owner so the owner-death rule does not remove it first.
    sessions.set('s1', {
      accepted: true,
      playerState: { _ownerSid: 'owner-1', deathStateTimer: 0, healthPoints: 1 },
    });
    srv.simulateGrenades(0.05, sessions);
    ok('an over-age entity is force-removed', !E.has(key),
      'nothing may outlive the cap, whatever its own rules say');
    ok('and its removal is announced', removalsInBlock().includes(key),
      'removing it server-side without telling anyone leaves a ghost on every screen');
    sessions.clear();

    // Two mistakes I made writing this cap, both silent, both caught only by running it:
    //  · `globalTick` is not in module scope (it lives in startServer's closure), so referencing it
    //    threw for EVERY entity on EVERY tick — which the new isolation turned into "every grenade
    //    vanishes instantly" instead of a crash.
    //  · `spawnTick` is the owner's CLIENT tick. Subtracting it from a server tick compares unrelated
    //    counters, so the cap would either never fire or fire immediately depending on the two clocks'
    //    offset.
    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    const step = src.slice(src.indexOf('function stepEntity'), src.indexOf('function stepEntity') + 2500);
    ok('the cap does not reference the closure-scoped globalTick',
      !/[^.\w]globalTick\b/.test(step.replace(/_live\.globalTick/g, '')),
      'it is not in scope here — the reference threw for every entity, every tick');
    ok('age is measured from _bornTick, not the client spawnTick',
      /_bornTick/.test(step) && !/now - g\.spawnTick/.test(step),
      'spawnTick is a CLIENT tick and cannot be compared with a server tick');
    ok('spawnGrenade stamps a server birth tick', /_bornTick: _live\.globalTick/.test(src));
  }

  console.log('\n── a mine dies with its owner, landed or not ──');
  {
    for (const stuck of [true, false]) {
      reset();
      const key = addEntity({
        type: 173, isStuck: stuck, armed: stuck,
        combat: { behavior: 'mine', dmg: 100, aoe: 8, proxyDistance: 3, fuse: 1200 },
        fuse: 1200,
      });
      sessions.clear();
      sessions.set('s1', {
        accepted: true,
        playerState: { _ownerSid: 'owner-1', deathStateTimer: 5, healthPoints: 0 },   // dead
      });
      srv.simulateGrenades(0.05, sessions);
      ok(`a ${stuck ? 'planted' : 'still-airborne'} mine is removed when its owner is dead`,
        !E.has(key),
        stuck ? '' : 'the old rule only checked planted ones, so this slipped through');
    }
    sessions.clear();
  }

  console.log('\n── a mine dies with an owner who left ──');
  {
    reset();
    const key = addEntity({
      type: 176, isStuck: true, armed: true,
      combat: { behavior: 'tripmine', dmg: 100, aoe: 0, tripRayLen: 8, tripRadius: 1, fuse: 1200 },
      fuse: 1200,
    });
    sessions.clear();   // owner is not in the session list at all
    srv.simulateGrenades(0.05, sessions);
    ok('an orphaned trip mine is removed', !E.has(key),
      'a disconnected player must not leave an armed trap behind');
  }

  console.log('\n── a round boundary clears the map ──');
  {
    reset();
    const a = addEntity({ type: 173, isStuck: true, fuse: 1200 });
    const b = addEntity({ type: 176, isStuck: true, fuse: 1200 });
    const n = srv.clearAllEntities('test');
    ok('every entity goes', E.size === 0 && n === 2, `${n} cleared, ${E.size} left`);
    const rem = removalsInBlock();
    ok('and every removal is announced', rem.includes(a) && rem.includes(b),
      JSON.stringify(rem));
    ok('clearing an empty world is a no-op', srv.clearAllEntities('test') === 0);

    const src = fs.readFileSync(path.join(__dirname, '..', 'local_ws_server.js'), 'utf8');
    ok('startNewRound clears entities', /startNewRound[\s\S]{0,600}?clearAllEntities\("round start"\)/.test(src),
      'a mine from round 1 was still armed in round 2');
    ok('a map switch clears entities too', /clearAllEntities\("map switch"\)/.test(src),
      'their coordinates mean nothing in new geometry');
  }

  console.log('\n── a removal is re-announced, not sent once ──');
  {
    reset();
    const repeat = S.get('entityRemovalRepeatTicks');
    ok('there is a repeat window', repeat >= 2,
      `${repeat} — one tick means a client that missed the packet keeps a ghost for ever`);

    // Emulate the post-broadcast bookkeeping the tick does.
    srv._entityRemovalRepeat.set('gone', repeat);
    let seen = 0;
    for (let i = 0; i < repeat + 3; i++) {
      if (removalsInBlock().includes('gone')) seen++;
      const left = srv._entityRemovalRepeat.get('gone');
      if (left !== undefined) {
        if (left <= 1) srv._entityRemovalRepeat.delete('gone');
        else srv._entityRemovalRepeat.set('gone', left - 1);
      }
    }
    ok('the removal appears on several ticks', seen === repeat, `${seen} ticks`);
    ok('and then stops', !srv._entityRemovalRepeat.has('gone'),
      're-announcing for ever would grow without bound');
  }

  console.log('\n── a removal is never sent twice in one block ──');
  {
    // Two `268,-1,key` for the same key in one block would stall the client's single ascending scan,
    // dropping every field after it — the failure mode is silent and total.
    reset();
    const key = addEntity();
    E.delete(key);
    srv._entityRemovalRepeat.set(key, 5);
    const block = srv.buildActiveEntityBlock();
    const removals = [];
    for (let i = 0; i < block.length - 2; i++) if (block[i] === 268 && block[i + 1] === -1) removals.push(block[i + 2]);
    ok('the key appears exactly once', removals.filter((k) => k === key).length === 1,
      JSON.stringify(removals));
  }

  reset();
  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
