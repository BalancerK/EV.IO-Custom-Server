/**
 * test_client_server_sync.js  (v2 — in-process, no WebSocket)
 *
 * Compares server physics (bpw.world) vs client physics (independent clientWorld)
 * step-by-step with identical input.  Both simulations run in-process; no
 * network layer is involved so there are no timing/echo-tick issues.
 *
 * Architecture
 * ────────────
 *   SERVER SIM — srv.createPlayerSimState + srv.foldClientInputIntoSim
 *                + srv.integratePlayerSim (uses bpw.world, same capsule map as
 *                the real server).  _pendingRawFrames are populated and drained
 *                exactly as they would be in the live server loop.
 *
 *   CLIENT SIM — ClientSim class uses an INDEPENDENT collision world built
 *                from the same map geometry (no shared capsule state with server).
 *                This mirrors what a real browser tab does.
 *
 * Each test step:
 *   1. srvSim.step(subFrames)   — fold input into srvState, run N physics steps
 *   2. clientSim.step(subFrames)— run same N steps in client world
 *   3. compare srvSim.pos vs clientSim.pos — must match within EPSILON
 *
 * Both simulations are spawned at the same position and yaw (bpw.spawnPoints[0],
 * yaw converted from degrees to radians, matching local_ws_server.js line 1112).
 *
 * Scenarios
 * ─────────
 *   0. Settle on floor   (20 idle ticks)
 *   1. Sprint forward    (30 ticks, 1 sub-frame/tick)
 *   2. Sprint forward    (10 ticks, 3 sub-frames/tick, Qq5sl76=1/3 each)
 *   3. Jump arc          (press once, hold, 30 ticks)
 *   4. Strafe + sprint   (20 ticks, 1 sub-frame/tick)
 *   5. Speed-bug check   (3f/tick ratio ≈ 1.0 vs 1f/tick — Qq5sl76/N fix)
 */
'use strict';

const bpw  = require('../physics_world');
const phys = require('../physics_extracted');

const EPSILON = 0.06;  // max acceptable per-step position error (units)

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — match shapes expected by foldClientInputIntoSim
// ─────────────────────────────────────────────────────────────────────────────

/** Wrap an array of raw frames into the decoded-packet shape decoded[5] expects. */
function makeDecodedPacket(frames) {
  // decoded[0]=prevServerTick, [1]=?, [2]=currentServerTick, [3]=?, [4]=clientTick, [5]=frames
  return [0, 0, 0, 0, 0, frames];
}

/**
 * Build one raw input frame.
 * @param {number[]} held     key indices currently held
 * @param {number[]} pressed  key indices newly pressed this frame (edge)
 * @param {number[]} lookDelta [dyaw, dpitch]
 */
function makeFrame(held = [], pressed = [], lookDelta = [0, 0]) {
  return [1.0, [held, pressed, [], lookDelta, null, null]];
}

// ─────────────────────────────────────────────────────────────────────────────
// ServerSim — wraps a server player-state + integratePlayerSim
// ─────────────────────────────────────────────────────────────────────────────

class ServerSim {
  /**
   * @param {object} srv      local_ws_server module (createPlayerSimState, etc.)
   * @param {object} spawn    {x, y, z, yaw} — yaw in RADIANS
   * @param {string} id       unique player id
   */
  constructor(srv, spawn, id) {
    this._srv   = srv;
    this.state  = srv.createPlayerSimState(spawn, id);
    this._tick  = 0;
  }

  /**
   * Advance the server sim by one physics "tick" applying N sub-frames.
   * @param {{ held: number[], pressed?: number[] }[]} subFrames
   */
  step(subFrames) {
    const rawFrames = subFrames.map(f =>
      makeFrame(f.held || [], f.pressed || [], f.lookDelta || [0, 0]),
    );
    const packet = makeDecodedPacket(rawFrames);
    this._srv.foldClientInputIntoSim(this.state, packet);
    this._srv.integratePlayerSim(this.state, 0.05, ++this._tick);
  }

  get pos()      { return this.state.position; }
  get grounded() { return this.state.grounded; }
}

// ─────────────────────────────────────────────────────────────────────────────
// ClientSim — independent collision world, mirrors real browser tab
// ─────────────────────────────────────────────────────────────────────────────

class ClientSim {
  /**
   * @param {object} world        independent physics world (from buildPhysicsWorld)
   * @param {object} gameSettings from phys.makeGameSettings()
   */
  constructor(world, gameSettings) {
    this.world        = world;
    this.gameSettings = gameSettings;
    this.ps           = null;
    this._tick        = 0;
    this._yaw         = 0;
    this._pitch       = 0;
  }

  /**
   * Spawn in the client sim.
   * @param {{ x, y, z }} pos
   * @param {number}       yaw  in RADIANS (same value passed to ServerSim)
   */
  spawn(pos, yaw = 0) {
    const id  = `cli-${Date.now()}`;
    this._yaw = yaw;
    this.ps   = phys.createPlayerState(id, pos, yaw);
    phys.registerPlayer(this.world, this.ps);
  }

  /**
   * Advance the client sim by exactly ONE physics step, collapsing N sub-frames
   * into a single step.  Mirrors the corrected _integrateWithExtractedPhysics:
   *   held       = last sub-frame's held-key set
   *   pressed    = union of all sub-frames' pressed sets (no edge lost)
   *   Qq5sl76    = 1 (one full game tick per server/client update)
   *
   * @param {{ held: number[], pressed?: number[], lookDelta?: number[] }[]} subFrames
   */
  step(subFrames) {
    const N = subFrames.length || 1;

    // Accumulate look delta from all sub-frames (final look state)
    for (const f of subFrames) {
      this._yaw   += ((f.lookDelta || [])[0] || 0);
      this._pitch += ((f.lookDelta || [])[1] || 0);
    }
    this.ps.Qqg4go0 = this._yaw;
    this.ps.Qcrzrpr = this._pitch;

    // Collapse to 1 physics step (same as server after speed-bug fix)
    const lastFrame = subFrames[N - 1] || {};
    const h  = new Set((lastFrame.held || []).map(Number));
    const p  = new Set();
    for (const f of subFrames) {
      for (const k of (f.pressed || [])) p.add(Number(k));
    }
    const rf = phys.makeRawFrames([{ held: h, pressed: p }]);
    phys.tickMovement(this.gameSettings, this.ps, rf, this.world, {
      Qbu40n9: 1,
      Qwhlcfo: ++this._tick,
      Qsvkg5s: this.gameSettings,
    });
  }

  get pos()      { return { x: this.ps.Qdsukt4.x, y: this.ps.Qdsukt4.y, z: this.ps.Qdsukt4.z }; }
  get grounded() { return this.ps.Q9t2fit; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Entry point
// ─────────────────────────────────────────────────────────────────────────────

bpw.ready.then(() => {
  console.log('[sync-test] Building independent client collision world...');
  const clientGeom  = phys.classifyGeometry(bpw.vertices, bpw.indices);
  const clientWorld = phys.buildPhysicsWorld(clientGeom, 64);
  console.log('[sync-test] Client world ready');

  const srv = require('../local_ws_server');
  const exit = runTests(srv, clientWorld);
  process.exit(exit);
}).catch(err => {
  console.error('[sync-test] bpw load failed:', err);
  process.exit(1);
});

// ─────────────────────────────────────────────────────────────────────────────
// Test scenarios (synchronous — no awaits, no WebSocket)
// ─────────────────────────────────────────────────────────────────────────────

function runTests(srv, clientWorld) {
  let pass = 0, fail = 0;

  function ok(desc, cond, detail = '') {
    if (cond)  { console.log(`  ✓ ${desc}`); pass++; }
    else       { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
  }
  function near(desc, a, b, eps = EPSILON) {
    const d = Math.abs(a - b);
    ok(desc, d <= eps, `|${a.toFixed(4)} - ${b.toFixed(4)}| = ${d.toFixed(4)} (eps=${eps})`);
  }

  // ── Common spawn ─────────────────────────────────────────────────────────
  // Use spawnPoints[0] (x=27, y=13.39, z=33.5) — well-separated from spawnPoints[2/3]
  // used by other tests, so no capsule collision interference.
  // Yaw conversion mirrors local_ws_server.js line 1112: sp.yaw * Math.PI/180.
  const sp0   = bpw.spawnPoints[0];
  const spYaw = (sp0.yaw || 0) * Math.PI / 180;  // degrees → radians
  const spawnPos = { x: sp0.x, y: sp0.y, z: sp0.z };
  console.log(`\n[sync-test] Spawn[0]: (${sp0.x.toFixed(2)}, ${sp0.y.toFixed(2)}, ${sp0.z.toFixed(2)})  yaw=${sp0.yaw}° → ${spYaw.toFixed(4)} rad`);

  // ── Scenario 0: Settle on floor ──────────────────────────────────────────
  console.log('\n── Scenario 0: Settle on floor (20 idle ticks) ──');
  {
    const srv0 = new ServerSim(srv, { ...spawnPos, yaw: spYaw }, 'sync-s0');
    const cli0 = new ClientSim(clientWorld, bpw.gameSettings);
    cli0.spawn(spawnPos, spYaw);

    for (let i = 0; i < 20; i++) {
      srv0.step([{ held: [], pressed: [] }]);
      cli0.step([{ held: [], pressed: [] }]);
    }

    near('Settled Y: server ≈ client', srv0.pos.y, cli0.pos.y, 0.3);
    ok('Server on floor',  srv0.grounded, `grounded=${srv0.grounded}`);
    ok('Client on floor',  cli0.grounded, `grounded=${cli0.grounded}`);
    console.log(`  srv y=${srv0.pos.y.toFixed(4)}  cli y=${cli0.pos.y.toFixed(4)}`);
  }

  // ── Scenario 1: Sprint forward — 1 sub-frame/tick ────────────────────────
  console.log('\n── Scenario 1: Sprint forward (30 ticks × 1 sub-frame) ──');
  {
    // Fresh sims settled at spawn[0]
    const srv1 = new ServerSim(srv, { ...spawnPos, yaw: spYaw }, 'sync-s1');
    const cli1 = new ClientSim(clientWorld, bpw.gameSettings);
    cli1.spawn(spawnPos, spYaw);
    for (let i = 0; i < 20; i++) {        // settle
      srv1.step([{ held: [], pressed: [] }]);
      cli1.step([{ held: [], pressed: [] }]);
    }

    const srvZ0 = srv1.pos.z, cliZ0 = cli1.pos.z;
    let maxErrZ = 0;

    for (let i = 0; i < 30; i++) {
      const f = [{ held: [0, 7], pressed: [] }];
      srv1.step(f);
      cli1.step(f);
      const err = Math.abs((srv1.pos.z - srvZ0) - (cli1.pos.z - cliZ0));
      if (err > maxErrZ) maxErrZ = err;
    }

    const srvDz = srv1.pos.z - srvZ0;
    const cliDz = cli1.pos.z - cliZ0;
    console.log(`  srv dz=${srvDz.toFixed(3)}  cli dz=${cliDz.toFixed(3)}  maxErr=${maxErrZ.toFixed(4)}`);

    near('Sprint 1f: final Z matches',        srvDz, cliDz,       EPSILON);
    ok(  'Sprint 1f: per-step error < 0.06',  maxErrZ < EPSILON,  `maxErr=${maxErrZ.toFixed(4)}`);
    // Yaw may make "forward" any direction; check displacement magnitude
    ok(  'Sprint 1f: moved > 5 units',        Math.abs(srvDz) > 5 || Math.abs(srv1.pos.x - spawnPos.x) > 5,
         `dz=${srvDz.toFixed(3)}`);
  }

  // ── Scenario 2: Sprint forward — 3 sub-frames/tick ───────────────────────
  console.log('\n── Scenario 2: Sprint forward (10 ticks × 3 sub-frames) ──');
  {
    const srv2 = new ServerSim(srv, { ...spawnPos, yaw: spYaw }, 'sync-s2');
    const cli2 = new ClientSim(clientWorld, bpw.gameSettings);
    cli2.spawn(spawnPos, spYaw);
    for (let i = 0; i < 20; i++) {        // settle
      srv2.step([{ held: [], pressed: [] }]);
      cli2.step([{ held: [], pressed: [] }]);
    }

    const srvZ0 = srv2.pos.z, cliZ0 = cli2.pos.z;
    let maxErrZ = 0;

    for (let i = 0; i < 10; i++) {
      const f = [{ held: [0, 7] }, { held: [0, 7] }, { held: [0, 7] }];
      srv2.step(f);
      cli2.step(f);
      const err = Math.abs((srv2.pos.z - srvZ0) - (cli2.pos.z - cliZ0));
      if (err > maxErrZ) maxErrZ = err;
    }

    const srvDz = srv2.pos.z - srvZ0;
    const cliDz = cli2.pos.z - cliZ0;
    console.log(`  srv dz=${srvDz.toFixed(3)}  cli dz=${cliDz.toFixed(3)}  maxErr=${maxErrZ.toFixed(4)}`);

    near('Sprint 3f: final Z matches',        srvDz, cliDz,       EPSILON);
    ok(  'Sprint 3f: per-step error < 0.06',  maxErrZ < EPSILON,  `maxErr=${maxErrZ.toFixed(4)}`);
    ok(  'Sprint 3f: moved > 1 unit',
         Math.abs(srvDz) > 1.0 || Math.abs(srv2.pos.x - spawnPos.x) > 1.0,
         `dz=${srvDz.toFixed(3)}`);
  }

  // ── Scenario 3: Jump arc ─────────────────────────────────────────────────
  console.log('\n── Scenario 3: Jump arc ──');
  {
    const srv3 = new ServerSim(srv, { ...spawnPos, yaw: spYaw }, 'sync-s3');
    const cli3 = new ClientSim(clientWorld, bpw.gameSettings);
    cli3.spawn(spawnPos, spYaw);

    // Settle on floor
    for (let i = 0; i < 20; i++) {
      srv3.step([{ held: [], pressed: [] }]);
      cli3.step([{ held: [], pressed: [] }]);
    }
    near('Pre-jump: Y matches after settle', srv3.pos.y, cli3.pos.y, 0.3);
    ok('Pre-jump: server on floor',  srv3.grounded, `grounded=${srv3.grounded}`);
    ok('Pre-jump: client on floor',  cli3.grounded, `grounded=${cli3.grounded}`);

    const srvY0 = srv3.pos.y, cliY0 = cli3.pos.y;

    // Jump press (edge trigger)
    const jumpEdge = [{ held: [4], pressed: [4] }];
    srv3.step(jumpEdge);
    cli3.step(jumpEdge);
    console.log(`  After jump press: srv y=${srv3.pos.y.toFixed(3)}  cli y=${cli3.pos.y.toFixed(3)}`);
    ok('Jumped upward (server)',  srv3.pos.y > srvY0, `y=${srv3.pos.y.toFixed(3)}`);
    ok('Jumped upward (client)',  cli3.pos.y > cliY0, `y=${cli3.pos.y.toFixed(3)}`);

    // Hold jump, track arc
    let maxErrY = 0, peakSrv = srv3.pos.y, peakCli = cli3.pos.y;
    for (let i = 0; i < 30; i++) {
      const f = [{ held: [4], pressed: [] }];
      srv3.step(f);
      cli3.step(f);
      if (srv3.pos.y > peakSrv) peakSrv = srv3.pos.y;
      if (cli3.pos.y > peakCli) peakCli = cli3.pos.y;
      const err = Math.abs((srv3.pos.y - srvY0) - (cli3.pos.y - cliY0));
      if (err > maxErrY) maxErrY = err;
    }
    console.log(`  Peak: srv=${peakSrv.toFixed(3)} cli=${peakCli.toFixed(3)}  maxErrY=${maxErrY.toFixed(4)}`);

    near('Jump: peak Y matches',            peakSrv, peakCli,  0.3);
    ok(  'Jump: per-tick Y error < 0.15',   maxErrY < 0.15,   `maxErrY=${maxErrY.toFixed(4)}`);
    ok(  'Reached peak > start+1 (server)', peakSrv > srvY0 + 1, `peak=${peakSrv.toFixed(3)}`);
    ok(  'Reached peak > start+1 (client)', peakCli > cliY0 + 1, `peak=${peakCli.toFixed(3)}`);
  }

  // ── Scenario 4: Strafe-left + sprint ────────────────────────────────────
  console.log('\n── Scenario 4: Strafe-left + sprint (20 ticks × 1 sub-frame) ──');
  {
    const srv4 = new ServerSim(srv, { ...spawnPos, yaw: spYaw }, 'sync-s4');
    const cli4 = new ClientSim(clientWorld, bpw.gameSettings);
    cli4.spawn(spawnPos, spYaw);

    // Settle then let velocity drain
    for (let i = 0; i < 20; i++) {
      srv4.step([{ held: [], pressed: [] }]);
      cli4.step([{ held: [], pressed: [] }]);
    }

    const srvXs = srv4.pos.x, srvZs = srv4.pos.z;
    const cliXs = cli4.pos.x, cliZs = cli4.pos.z;
    let maxErr = 0;

    for (let i = 0; i < 20; i++) {
      // forward (0) + strafe-left (2) + sprint (7)
      const f = [{ held: [0, 2, 7], pressed: [] }];
      srv4.step(f);
      cli4.step(f);
      const dSrvX = srv4.pos.x - srvXs, dSrvZ = srv4.pos.z - srvZs;
      const dCliX = cli4.pos.x - cliXs, dCliZ = cli4.pos.z - cliZs;
      const err = Math.hypot(dSrvX - dCliX, dSrvZ - dCliZ);
      if (err > maxErr) maxErr = err;
    }

    const dSrvX = srv4.pos.x - srvXs, dSrvZ = srv4.pos.z - srvZs;
    const dCliX = cli4.pos.x - cliXs, dCliZ = cli4.pos.z - cliZs;
    console.log(`  srv  dz=${dSrvZ.toFixed(3)} dx=${dSrvX.toFixed(3)}`);
    console.log(`  cli  dz=${dCliZ.toFixed(3)} dx=${dCliX.toFixed(3)}  maxErr=${maxErr.toFixed(4)}`);

    near('Strafe: final Z matches',               dSrvZ, dCliZ,       EPSILON);
    near('Strafe: final X matches',               dSrvX, dCliX,       EPSILON);
    ok(  'Strafe: max displacement error < 0.06', maxErr < EPSILON,   `maxErr=${maxErr.toFixed(4)}`);
  }

  // ── Scenario 5: Multi-sub-frame ratio ≈ 1.0 (speed bug fixed) ──────────
  // Server collapses 3 client sub-frames → 1 physics step per tick (Qq5sl76=1).
  // Travel distance with 3f/tick MUST match 1f/tick within ±5% tolerance.
  // (Both paths run the same physics step with the same input; small differences
  // can arise from press-edge detection differences between idle and raw-frame paths.)
  console.log('\n── Scenario 5: Multi-sub-frame ratio check (1-step collapse — ratio must be ≈1.0) ──');
  {
    // Single-sub-frame reference (20 ticks × 1 sub-frame)
    const srvA = new ServerSim(srv, { ...spawnPos, yaw: spYaw }, 'sync-s5a');
    for (let i = 0; i < 10; i++) srvA.step([{ held: [], pressed: [] }]);  // settle
    const zA0 = srvA.pos.z;
    for (let i = 0; i < 20; i++) srvA.step([{ held: [0, 7], pressed: [] }]);
    const dzSingle = srvA.pos.z - zA0;

    // Three-sub-frame (20 ticks × 3 sub-frames → 1 physics step each)
    const srvB = new ServerSim(srv, { ...spawnPos, yaw: spYaw }, 'sync-s5b');
    for (let i = 0; i < 10; i++) srvB.step([{ held: [], pressed: [] }]);  // settle
    const zB0 = srvB.pos.z;
    for (let i = 0; i < 20; i++) srvB.step([{ held: [0, 7] }, { held: [0, 7] }, { held: [0, 7] }]);
    const dzTriple = srvB.pos.z - zB0;

    // Forward direction may be +Z or -Z depending on yaw; use absolute values.
    const ratio = Math.abs(dzTriple) / (Math.abs(dzSingle) || 1);
    console.log(`  single dz=${dzSingle.toFixed(3)}  triple dz=${dzTriple.toFixed(3)}  ratio=${ratio.toFixed(3)}`);
    ok('Triple/single ratio ≥ 0.95 (same physics steps)', ratio >= 0.95,
       `ratio=${ratio.toFixed(3)}`);
    ok('Triple/single ratio ≤ 1.05 (speed bug fixed — was ~3.0 with N×Qq5sl76=1)', ratio <= 1.05,
       `ratio=${ratio.toFixed(3)}`);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log(`\n${'─'.repeat(54)}`);
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  return fail > 0 ? 1 : 0;
}
