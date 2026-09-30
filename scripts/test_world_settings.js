/**
 * test_world_settings.js
 *
 * Pins the collision world's settings object to the client's.
 *
 * WHY THIS TEST EXISTS
 * ────────────────────
 * `buildPhysicsWorld` passes a settings object that becomes `Qu9lnvy` inside the collision engine.
 * The client's is the literal `{ Qxoxfgm: 0, Qb5sov2: Mh.Q4b9iia.Qxy0ejg }` (served bundle, module
 * Qqg3k19). Ours had BOTH fields wrong, and both are load-bearing:
 *
 *   Qxoxfgm — ground-snap reach. `var r = e.Q9t2fit ? this.Qu9lnvy.Qxoxfgm : 0` extends the
 *     downward ground probe while grounded. We passed 1; the client passes 0. The server therefore
 *     probed a whole extra unit at the top of a downslope, found the slope face, snapped the player
 *     onto it and kept grounded=true — while the client went airborne. Measured on a real captured
 *     trace: 0.13-0.19u of Y error and a flipped grounded flag on every flat->downslope transition.
 *     Fixing it took those transitions from |Δpy| 0.106 / grounded wrong 2-of-3 to 0.0000 / 0-of-3.
 *
 *   Qb5sov2 — step-up height for the ledge probe. Client passes Qxy0ejg = 0.8; we passed 0, so the
 *     server could not step over small ledges the client walks straight across.
 *
 * The trap that makes this worth a test: the engine DEFAULTS Qxoxfgm to 1 when it is undefined
 * (`void 0 === this.Qu9lnvy.Qxoxfgm && (this.Qu9lnvy.Qxoxfgm = 1)`). So simply forgetting the field
 * silently restores the bug — it does not fail loudly.
 *
 * Usage:  node scripts/test_world_settings.js
 */
'use strict';

const phys = require('../physics_extracted');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

// The client's values, from the served bundle. Kept as literals here on purpose: if the extracted
// constants ever drift, this test should fail rather than silently agree with itself.
const CLIENT_GROUND_SNAP = 0;
const CLIENT_STEP_UP = 0.8;   // Mh.Q4b9iia.Qxy0ejg

console.log('\n── collision world settings must match the client ──');
{
  // Build a trivial world and read back the settings the engine actually holds.
  const geom = phys.classifyGeometry(
    new Float32Array([0, 0, 0, 1, 0, 0, 0, 0, 1]),
    new Uint32Array([0, 1, 2]),
    new Uint32Array([1]),
  );
  const world = phys.buildPhysicsWorld(geom, 100);

  // Find the settings object wherever the engine keeps it (Qu9lnvy on the inner engine).
  let settings = null;
  const seen = new Set();
  (function find(o, depth) {
    if (!o || typeof o !== 'object' || depth > 4 || seen.has(o)) return;
    seen.add(o);
    if (Object.prototype.hasOwnProperty.call(o, 'Qxoxfgm')) { settings = o; return; }
    for (const k of Object.keys(o)) find(o[k], depth + 1);
  })(world, 0);

  ok('the engine exposes a settings object with Qxoxfgm', settings !== null,
    'could not locate Qu9lnvy — did the engine internals change?');

  if (settings) {
    ok(`Qxoxfgm (ground-snap reach) is ${CLIENT_GROUND_SNAP}, matching the client`,
      settings.Qxoxfgm === CLIENT_GROUND_SNAP,
      `got ${settings.Qxoxfgm}` + (settings.Qxoxfgm === 1
        ? ' — this is the engine DEFAULT, i.e. the field was omitted. It makes the server stick to'
          + ' downslopes while the client goes airborne.' : ''));
    ok(`Qb5sov2 (step-up height) is ${CLIENT_STEP_UP}, matching the client's Qxy0ejg`,
      Math.abs(settings.Qb5sov2 - CLIENT_STEP_UP) < 1e-9, `got ${settings.Qb5sov2}`);
  }
}

console.log('\n── the extracted constant still holds the client value ──');
{
  // buildPhysicsWorld sources the step-up from Mh.Q4b9iia.Qxy0ejg; if that drifts, so does the world.
  const s = phys.makeGameSettings ? phys.makeGameSettings() : null;
  ok('makeGameSettings() is available', !!s);
  // Qxy0ejg lives on the feature-flag/settings table the extraction carries.
  const flags = (phys.featureFlags || (s && s.Q4b9iia) || null);
  if (flags && flags.Qxy0ejg !== undefined) {
    ok(`Qxy0ejg is ${CLIENT_STEP_UP}`, Math.abs(flags.Qxy0ejg - CLIENT_STEP_UP) < 1e-9,
      `got ${flags.Qxy0ejg}`);
  } else {
    console.log('  · Qxy0ejg not reachable from the module surface — covered indirectly above');
  }
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
