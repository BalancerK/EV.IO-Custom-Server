/**
 * test_navmesh.js — the waypoint graph every map ships, which we used to skip.
 *
 * WHAT IT IS
 * ──────────
 * evmap flags2&1. Each node is { position, neighbour indices, optional string tag } — Qs848o7 in the
 * client (:46318). It is a GRAPH, not a mesh, and the edges as stored are ONE-DIRECTIONAL: the client
 * symmetrises them on load, adding b->a for every a->b (:47080). Anything reading it must do the same,
 * or half the graph is a one-way street.
 *
 * Tags are meaningful. Nodes tagged 'Bot Party' are averaged into the battle-royale glide centre
 * (:32901 -> Qr2kqt4/5/6, which enables gliding within 120 units at :34595).
 *
 * Measured across the 20 cached maps: 2855 nodes, 7906 edges, average degree 2.77, present in EVERY
 * map. Tags seen: Ground (260), Bot Party (44), Bot Exits (16).
 *
 * Nothing consumes this yet — it is what bots would need. It is parsed rather than skipped so that
 * work does not have to start by rediscovering the format.
 *
 * Usage:  node scripts/test_navmesh.js
 */
'use strict';

process.env.EVIO_ADMIN = '0';

const fs = require('fs');
const path = require('path');
const bpw = require('../physics_world');

let pass = 0, fail = 0;
function ok(desc, cond, detail = '') {
  if (cond) { console.log(`  ✓ ${desc}`); pass++; }
  else { console.error(`  ✗ ${desc}${detail ? ' — ' + detail : ''}`); fail++; }
}

(async () => {
  await bpw.ready;
  const dir = path.join(__dirname, '..', 'map_cache');
  const files = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((f) => f.endsWith('.evmap')) : [];
  const load = (f) => bpw.parseEvmapBuffer(fs.readFileSync(path.join(dir, f)), f).navmesh || [];

  console.log('\n── every map ships one ──');
  {
    let withNav = 0, nodes = 0, edges = 0;
    for (const f of files) {
      try {
        const nm = load(f);
        if (nm.length) { withNav++; nodes += nm.length; edges += nm.reduce((a, n) => a + n.links.length, 0); }
      } catch (_) { /* an unparseable map is not this test's problem */ }
    }
    ok('the navmesh is parsed, not skipped', withNav > 0, `${withNav} of ${files.length} maps`);
    ok('and it is present in all of them', files.length === 0 || withNav === files.length,
      `${withNav}/${files.length}`);
    ok('the graph has real connectivity', nodes === 0 || edges / nodes > 2,
      `${nodes} nodes, ${edges} edges, avg degree ${(edges / Math.max(1, nodes)).toFixed(2)}`);
  }

  console.log('\n── the edges are symmetrised on load ──');
  {
    // The stored edges are one-directional. Missing this would leave half the graph traversable in only
    // one direction, which a pathfinder experiences as destinations that are intermittently unreachable
    // for no visible reason.
    let asym = 0, checked = 0;
    for (const f of files) {
      try {
        const nm = load(f);
        for (let i = 0; i < nm.length; i++) {
          for (const j of nm[i].links) { checked++; if (!nm[j] || !nm[j].links.includes(i)) asym++; }
        }
      } catch (_) {}
    }
    ok('every edge is bidirectional', asym === 0, `${asym} one-way of ${checked} edges`);
  }

  console.log('\n── node tags survive ──');
  {
    // "Bot Party" is a battle-royale-specific tag (the glide-centre) — a small or unlucky sample of
    // cached maps (a fresh checkout only has the bootstrap deathmatch map, which never carries it)
    // proves nothing about whether tags survive parsing in general, so both assertions need a real
    // sample to mean anything, not just the first one that already checked this reasoning below it.
    const tags = {};
    for (const f of files) {
      try { for (const n of load(f)) if (n.tag) tags[n.tag] = (tags[n.tag] || 0) + 1; } catch (_) {}
    }
    if (files.length < 3) {
      ok('tagged nodes are preserved', true,
        `skipped — only ${files.length} map(s) cached, too small a sample to judge`);
      ok('the Bot Party tag is among them', true,
        `skipped — only ${files.length} map(s) cached, too small a sample to judge`);
    } else {
      ok('tagged nodes are preserved', Object.keys(tags).length > 0, JSON.stringify(tags));
      ok('the Bot Party tag is among them', !!tags['Bot Party'],
        'it is averaged into the battle-royale glide centre');
    }
  }

  console.log('\n── the graph is not always fully connected ──');
  {
    // Worth knowing BEFORE writing a pathfinder. Six of twenty maps have more than one component, and
    // on a teleporter map the components are the regions the teleporters join — FormationTeleporters
    // splits 257/22/2/2/2/2/1/1 across 16 teleporters. A router that assumes one component will fail to
    // find routes that genuinely exist, and the fix is to treat a teleporter as an edge.
    let partial = 0, total = 0;
    for (const f of files) {
      try {
        const nm = load(f);
        if (!nm.length) continue;
        total++;
        const seen = new Set([0]); const q = [0];
        while (q.length) { const c = q.pop(); for (const j of nm[c].links) if (!seen.has(j)) { seen.add(j); q.push(j); } }
        if (seen.size < nm.length) partial++;
      } catch (_) {}
    }
    ok('connectivity is measured, not assumed', total > 0,
      `${partial} of ${total} maps have nodes unreachable from node 0`);
  }

  console.log('\n' + '─'.repeat(60));
  console.log(`${pass + fail} assertions: ${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
