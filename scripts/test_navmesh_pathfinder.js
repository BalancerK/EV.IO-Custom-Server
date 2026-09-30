/**
 * test_navmesh_pathfinder.js — navmesh_pathfinder builds a correct graph and finds correct paths.
 *
 * Uses a small SYNTHETIC navmesh rather than a real map's (test_navmesh.js already covers real-map
 * parsing/symmetrisation), so the graph shape — a chain, a branch, a genuinely disconnected island
 * — is exactly known and every assertion has a predictable right answer. A real map's navmesh is
 * good for an integration smoke check but bad for proving A* picked the OPTIMAL path or that an
 * unreachable goal is correctly reported as such.
 *
 * Usage:  node scripts/test_navmesh_pathfinder.js
 */
'use strict';

const { buildGraph, nearestNodeIndex, findPath } = require('../navmesh_pathfinder');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

// A chain 0-1-2-3-4, ten units apart along x — node 2 offset sideways so the chain is NOT collinear
// (used below to prove A* prefers a genuinely shorter route rather than just "fewer hops").
function chainNodes() {
  return [
    { x: 0, y: 0, z: 0, links: [1] },
    { x: 10, y: 0, z: 0, links: [0, 2] },
    { x: 20, y: 0, z: 15, links: [1, 3] },
    { x: 30, y: 0, z: 0, links: [2, 4] },
    { x: 40, y: 0, z: 0, links: [3] },
  ];
}

console.log('\n── basic graph construction from raw (already-symmetrised) navmesh links ──');
{
  const nodes = chainNodes();
  const graph = buildGraph(nodes, []);
  ok('one adjacency list per node', graph.adjacency.length === nodes.length);
  ok('node 0 has exactly its one raw link', graph.adjacency[0].length === 1 && graph.adjacency[0][0].to === 1);
  ok('interior node 2 has both its links', graph.adjacency[2].map((e) => e.to).sort().join() === '1,3');
  ok('no teleport edges were invented with an empty teleporter list',
    graph.adjacency.every((edges) => edges.every((e) => e.teleport === false)));
}

console.log('\n── nearestNodeIndex ──');
{
  const nodes = chainNodes();
  ok('finds the exact node when standing on it', nearestNodeIndex(nodes, { x: 10, y: 0, z: 0 }) === 1);
  ok('finds the closest node from a nearby point', nearestNodeIndex(nodes, { x: 9, y: 0, z: 1 }) === 1);
  ok('respects maxDist — returns -1 when nothing is close enough',
    nearestNodeIndex(nodes, { x: 500, y: 0, z: 0 }, 5) === -1);
  ok('an empty node list is never a crash, just -1', nearestNodeIndex([], { x: 0, y: 0, z: 0 }) === -1);
}

console.log('\n── A* finds the chain path end to end ──');
{
  const graph = buildGraph(chainNodes(), []);
  const path = findPath(graph, { x: 0, y: 0, z: 0 }, { x: 40, y: 0, z: 0 });
  ok('a path was found', !!path, JSON.stringify(path));
  if (path) {
    ok('it starts at node 0 and ends at node 4', path[0].x === 0 && path[path.length - 1].x === 40);
    ok('it visits every node in order (only route that exists)', path.length === 5,
      `length=${path.length}`);
    ok('none of these edges are teleports', path.every((n) => n.teleport === false));
  }
}

console.log('\n── two genuinely disconnected islands are correctly UNREACHABLE without a portal ──');
{
  const nodes = [
    { x: 0, y: 0, z: 0, links: [1] },
    { x: 10, y: 0, z: 0, links: [0] },
    { x: 1000, y: 0, z: 0, links: [3] },   // island B — no links back to island A at all
    { x: 1010, y: 0, z: 0, links: [2] },
  ];
  const graph = buildGraph(nodes, []);
  const path = findPath(graph, { x: 0, y: 0, z: 0 }, { x: 1010, y: 0, z: 0 });
  ok('no path exists — the negative control the teleporter test below proves against',
    path === null, JSON.stringify(path));
}

console.log('\n── a teleporter joins two disconnected islands into one reachable graph ──');
{
  const nodes = [
    { x: 0, y: 0, z: 0, links: [1] },
    { x: 10, y: 0, z: 0, links: [0] },       // island A exit, near teleporter pad 0
    { x: 1000, y: 0, z: 0, links: [3] },     // island B entry, near teleporter pad 1
    { x: 1010, y: 0, z: 0, links: [2] },
  ];
  // Shape matches physics_world's parsed teleporters: Qdsukt4 = position, Qcnqzx4 = destination ids
  // (indices into this same array), Qrtt124 = non-empty means "hub portal, do not route".
  const teleporters = [
    { Qdsukt4: { x: 9, y: 0, z: 0 }, Qcnqzx4: [1], Qrtt124: '' },
    { Qdsukt4: { x: 1001, y: 0, z: 0 }, Qcnqzx4: [0], Qrtt124: '' },
  ];
  const graph = buildGraph(nodes, teleporters);
  const path = findPath(graph, { x: 0, y: 0, z: 0 }, { x: 1010, y: 0, z: 0 });
  ok('a path now exists once the portal edge is present', !!path, JSON.stringify(path));
  if (path) {
    ok('exactly one leg of the path is a teleport', path.filter((n) => n.teleport).length === 1,
      JSON.stringify(path));
    ok('the path ends at the correct final node', path[path.length - 1].x === 1010);
  }

  console.log('\n── negative control: a hub portal (Qrtt124 set) is NOT treated as a routable edge ──');
  const hubTeleporters = teleporters.map((t) => ({ ...t, Qrtt124: 'deathmatch' }));
  const hubGraph = buildGraph(nodes, hubTeleporters);
  const hubPath = findPath(hubGraph, { x: 0, y: 0, z: 0 }, { x: 1010, y: 0, z: 0 });
  ok('marking the portal as a hub portal removes the edge and the islands are unreachable again',
    hubPath === null, JSON.stringify(hubPath));

  console.log('\n── negative control: an exit-only pad (no destinations) is NOT a routable edge ──');
  const exitOnly = teleporters.map((t) => ({ ...t, Qcnqzx4: [] }));
  const exitGraph = buildGraph(nodes, exitOnly);
  const exitPath = findPath(exitGraph, { x: 0, y: 0, z: 0 }, { x: 1010, y: 0, z: 0 });
  ok('an exit-only pad with no destinations does not join the islands', exitPath === null,
    JSON.stringify(exitPath));
}

console.log('\n── A* prefers the genuinely shorter route when both exist ──');
{
  // A short direct link 0->2 (distance 5) versus the long way round 0->1->2 (distance 10+10=20).
  const nodes = [
    { x: 0, y: 0, z: 0, links: [1, 2] },
    { x: 10, y: 0, z: 0, links: [0, 2] },
    { x: 5, y: 0, z: 0, links: [0, 1] },
  ];
  const graph = buildGraph(nodes, []);
  const path = findPath(graph, { x: 0, y: 0, z: 0 }, { x: 5, y: 0, z: 0 });
  ok('the direct 2-node path is chosen over the 3-node detour', path.length === 2,
    JSON.stringify(path));
}

console.log('\n── same start and goal node resolves trivially, not via search ──');
{
  const graph = buildGraph(chainNodes(), []);
  const path = findPath(graph, { x: 0.2, y: 0, z: 0 }, { x: -0.1, y: 0, z: 0 });
  ok('a one-node path is returned when both snap to the same node', path && path.length === 1,
    JSON.stringify(path));
}

console.log('\n── an empty navmesh (a map with none) fails safe, not with a crash ──');
{
  const graph = buildGraph([], []);
  ok('buildGraph on an empty navmesh returns an empty graph', graph.nodes.length === 0);
  ok('findPath on an empty graph returns null, not a throw',
    findPath(graph, { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }) === null);
}

console.log('\n── real map integration smoke check (cached maps, if any) ──');
{
  // A light integration pass over whatever is already in map_cache/ (test_navmesh.js already proves
  // the raw parsing/symmetrisation these graphs are built from) — mainly to catch a shape mismatch
  // between physics_world's parsed teleporter fields and what buildGraph expects.
  const fs = require('fs');
  const path = require('path');
  const bpw = require('../physics_world');
  const dir = path.join(__dirname, '..', 'map_cache');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.evmap')) : [];
  if (!files.length) {
    console.log('  (skipped — no cached maps on disk)');
  } else {
    let built = 0, pathed = 0;
    for (const f of files) {
      try {
        const geo = bpw.parseEvmapBuffer(fs.readFileSync(path.join(dir, f)), f);
        if (!geo.navmesh || !geo.navmesh.length) continue;
        const graph = buildGraph(geo.navmesh, geo.teleporters || []);
        built++;
        const a = geo.navmesh[0], b = geo.navmesh[geo.navmesh.length - 1];
        if (findPath(graph, a, b, { snapDist: 5 })) pathed++;
      } catch (err) {
        ok(`${f} builds a graph without throwing`, false, err.message);
      }
    }
    ok('every map with a navmesh builds a graph without throwing', built > 0, `${built}/${files.length}`);
  }
}

console.log('\n' + '─'.repeat(60));
console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
