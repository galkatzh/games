// tests/map/pipeline.test.mjs — importer passes on small hand-built inputs, one trap at a time.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import {
  attachSignals, buildGraph, buildMovements, clipRoads, connectivity, dropGarageStubs, filterRoads, finishGraph, gradeSeparate,
  JF, KIND, mergeJunctions, overlayChains, TURN
} from '../../tools/lib/graph.mjs';
import { buildKerbs, partKerb, parseZone } from '../../tools/lib/kerbs.mjs';
import { buildWalls, LAND, seaRings, WALL } from '../../tools/lib/land.mjs';
import {
  boxOf, clipRing, clipRingLeft, joinRings, laneOffsets, loadSources, makeProjection, minTrims, namesOf, offsetPolyline, ringArea, simplifyRing
} from '../../tools/lib/osm.mjs';
import { applyKerbs, applyPois, applyPre, loadOverlays } from '../../tools/lib/overlay.mjs';
import { bindFacades, isSensitive, kindOf, POIF, streetKey } from '../../tools/lib/pois.mjs';
import {
  BuildingIndex, RoadIndex, buildingRecords, crossSection, lanesOf, normalizeEdges, prepareBuildings, separateCarriageways, setFronts
} from '../../tools/lib/section.mjs';
import { carriagewayOverlaps, laneContacts } from '../../tools/lib/report.mjs';
import { ROOT, runtime, tempDir } from './helpers.mjs';

const TLV = await runtime();
const TAGS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/rules/tags.json'), 'utf8'));
const PARKING = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/rules/parking.json'), 'utf8'));
const KINDS = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/rules/kinds.json'), 'utf8'));
const BOX = { minX: -100000, minY: -100000, maxX: 100000, maxY: 100000 };

/** A way record from node ids. */
const way = (id, nodes, tags) => ({ type: 'way', id, nodes, tags: { highway: 'residential', ...tags } });

/** Node map from `{ id: [xMetres, yMetres, tags?] }`. */
function nodesOf(spec) {
  const m = new Map();
  for (const [id, [x, y, tags]] of Object.entries(spec)) {
    m.set(Number(id), { type: 'node', id: Number(id), x: x * 10, y: y * 10, tags });
  }
  return m;
}

/** Runs passes 4 to 12 on a tiny network. */
function graphOf(nodeSpec, ways) {
  const nodes = nodesOf(nodeSpec);
  const osm = { nodes, ways: new Map(ways.map((w) => [w.id, w])), rels: new Map() };
  const clipped = clipRoads(filterRoads(osm).ways, nodes, BOX);
  const graded = gradeSeparate(clipped.pieces, nodes, TAGS.classOrder);
  const G = buildGraph(graded.pieces, nodes);
  mergeJunctions(G);
  finishGraph(G);
  normalizeEdges(G.edges, TAGS);
  buildMovements(G);
  return G;
}

/** Writes an Overpass-shaped extract and loads it. */
function loadExtract(t, elements) {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'x.osm.json'), JSON.stringify({ osm3s: { timestamp_osm_base: '2026-01-01T00:00:00Z' }, elements }));
  return loadSources(dir, ['x']);
}

test('dedupe keeps the tagged copy whichever comes first', (t) => {
  const tagged = { type: 'node', id: 1, lat: 1, lon: 1, tags: { highway: 'traffic_signals' } };
  const bare = { type: 'node', id: 1, lat: 1, lon: 1 };
  assert.ok(loadExtract(t, [tagged, bare]).nodes.get(1).tags);
  assert.ok(loadExtract(t, [bare, tagged]).nodes.get(1).tags);
});

test('dedupe keeps a way with its tags', (t) => {
  const w = { type: 'way', id: 5, nodes: [1, 2], tags: { building: 'yes' } };
  const osm = loadExtract(t, [w, { type: 'way', id: 5, nodes: [1, 2] }]);
  assert.ok(osm.ways.get(5).tags);
  assert.equal(osm.stats.duplicates, 1);
  assert.equal(osm.osmTime, '2026-01-01T00:00:00Z');
});

test('ids above 2^31 stay exact through load', (t) => {
  const osm = loadExtract(t, [{ type: 'node', id: 10693747873, lat: 1, lon: 1 }]);
  assert.ok(osm.nodes.has(10693747873));
});

test('projection matches the contract at the bbox corners', () => {
  const proj = makeProjection([32.075, 34.7775]);
  assert.deepEqual(boxOf([32.05, 34.755, 32.10, 34.80], proj), { minX: -21243, minY: -27722, maxX: 21243, maxY: 27722 });
});

test('pass 4 keeps bridges and drops what the contract lists', () => {
  const keep = (id, tags) => ({ type: 'way', id, nodes: [1, 2], tags });
  const osm = {
    ways: new Map([
      keep(1, { highway: 'residential', bridge: 'yes' }),
      keep(2, { highway: 'motorway' }),
      keep(3, { highway: 'motorway_link' }),
      keep(4, { highway: 'residential', tunnel: 'yes' }),
      keep(5, { highway: 'residential', tunnel: 'building_passage' }),
      keep(6, { highway: 'residential', access: 'private' }),
      keep(7, { highway: 'residential', motor_vehicle: 'no' }),
      keep(8, { highway: 'service', service: 'parking_aisle' }),
      keep(9, { highway: 'service', service: 'driveway' }),
      keep(10, { highway: 'service', name: 'קומה 2' }),
      keep(11, { highway: 'footway' }),
      keep(12, { highway: 'secondary_link' }),
      keep(13, { highway: 'service', name: 'Floor -1' })
    ].map((w) => [w.id, w]))
  };
  assert.deepEqual(filterRoads(osm).ways.map((w) => w.id), [1, 12]);
});

test('pass 5 cuts at the boundary, marks portals, and handles a way that leaves and comes back', () => {
  const box = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
  const nodes = nodesOf({ 1: [0, 0], 2: [200, 0], 3: [200, 50], 4: [0, 50] });
  const { pieces, portals } = clipRoads([way(9, [1, 2, 3, 4], {})], nodes, box);
  assert.equal(pieces.length, 2);
  assert.equal(portals, 2);
  const end = nodes.get(pieces[0].nodes.at(-1));
  assert.ok(end.portal);
  assert.ok(end.x <= 1000 && end.x > 0);
  assert.ok(nodes.get(pieces[1].nodes[0]).portal);
});

test('oneway=-1 reverses the polyline and swaps kerb sides', () => {
  const G = graphOf({ 1: [0, 0], 2: [100, 0] }, [way(9, [1, 2], { oneway: '-1', 'parking:left': 'no', 'parking:right': 'yes' })]);
  const e = G.edges[0];
  assert.equal(G.nodes.get(e.a).x, 1000);
  assert.equal(e.lanesB, 0);
  assert.equal(partKerb(e.parts[0], 1, PARKING).no, true);
  assert.equal(partKerb(e.parts[0], 0, PARKING).tier, PARKING.tiers.explicit);
});

test('pass 6 removes the lower-class crossing segment and leaves no crossing', () => {
  const G = graphOf({ 1: [-100, 0], 2: [100, 0], 3: [0, -100], 4: [0, -5], 5: [0, 5], 6: [0, 100] }, [
    way(1, [1, 2], { highway: 'primary' }),
    way(2, [3, 4, 5, 6], { highway: 'residential' })
  ]);
  const ways = G.edges.map((e) => e.way).sort();
  assert.deepEqual(ways, [1, 2, 2]);
  assert.equal(G.edges.filter((e) => e.way === 2).length, 2);
});

test('pass 6 keeps the bridge when classes tie', () => {
  const nodes = nodesOf({ 1: [-100, 0], 2: [100, 0], 3: [0, -100], 6: [0, 100] });
  const pieces = [
    { way: 1, tags: { highway: 'residential' }, nodes: [1, 2] },
    { way: 2, tags: { highway: 'residential', bridge: 'yes' }, nodes: [3, 6] }
  ];
  const g = gradeSeparate(pieces, nodes, TAGS.classOrder);
  assert.deepEqual(g.pieces.map((p) => p.way), [2]);
});

test('a road crossing at a shared node is a junction, not a grade separation', () => {
  const G = graphOf({ 1: [-100, 0], 2: [100, 0], 3: [0, -100], 4: [0, 0], 5: [0, 100] }, [
    way(1, [1, 4, 2], {}),
    way(2, [3, 4, 5], {})
  ]);
  assert.equal(G.edges.length, 4);
  assert.equal(G.juncs.filter((j) => j.arms === 4).length, 1);
});

test('pass 7 contracts a way boundary only when the tags agree', () => {
  const nodeSpec = { 1: [0, 0], 2: [100, 0], 3: [200, 0] };
  const same = graphOf(nodeSpec, [way(1, [1, 2], { name: 'A', lanes: '2' }), way(2, [2, 3], { name: 'A', lanes: '2' })]);
  assert.equal(same.edges.length, 1);
  for (const tags of [{ name: 'B', lanes: '2' }, { name: 'A', lanes: '4' }, { name: 'A', lanes: '2', maxspeed: '30' },
    { name: 'A', lanes: '2', oneway: 'yes' }, { name: 'A', lanes: '2', highway: 'tertiary' },
    { name: 'A', lanes: '2', 'parking:both': 'no' }]) {
    const differ = graphOf(nodeSpec, [way(1, [1, 2], { name: 'A', lanes: '2' }), way(2, [2, 3], tags)]);
    assert.equal(differ.edges.length, 2, JSON.stringify(tags));
    assert.equal(differ.juncs.filter((j) => j.kind === KIND.PASS).length, 1);
  }
});

test('pass 7 compares kerb tags in travel direction, so opposite digitization still contracts', () => {
  const nodeSpec = { 1: [0, 0], 2: [100, 0], 3: [200, 0] };
  const G = graphOf(nodeSpec, [way(1, [1, 2], { 'parking:left': 'no' }), way(2, [3, 2], { 'parking:right': 'no' })]);
  assert.equal(G.edges.length, 1);
});

test('pass 7 keeps a boundary that an overlay papered over, because the ways differ in OSM', () => {
  const nodes = { 1: [0, 0], 2: [100, 0], 3: [200, 0] };
  const plain = graphOf(nodes, [way(1, [1, 2], { lanes: '2' }), way(2, [2, 3], { lanes: '4' })]);
  assert.equal(plain.edges.length, 2);
  const overlaid = graphOf(nodes, [
    { ...way(1, [1, 2], { lanes: '4' }), baseTags: { highway: 'residential', lanes: '2' } },
    way(2, [2, 3], { lanes: '4' })
  ]);
  assert.equal(overlaid.edges.length, 2);
  assert.equal(overlaid.overlaySplits.size, 0, 'it was never one road, so there is no chain to rebuild');
});

test('pass 7 never contracts one-way ways that meet head to head', () => {
  const G = graphOf({ 1: [0, 0], 2: [100, 0], 3: [200, 0] }, [way(1, [1, 2], { oneway: 'yes' }), way(2, [3, 2], { oneway: 'yes' })]);
  assert.equal(G.edges.length, 2);
});

test('the longest contributing way names the edge', () => {
  const G = graphOf({ 1: [0, 0], 2: [10, 0], 3: [200, 0] }, [way(1, [1, 2], { name: 'A' }), way(2, [2, 3], { name: 'A' })]);
  assert.equal(G.edges[0].way, 2);
});

test('a signal node stays a junction, between two ways or inside one', () => {
  const G = graphOf({ 1: [0, 0], 2: [100, 0, { highway: 'traffic_signals' }], 3: [200, 0] }, [way(1, [1, 2, 3], {})]);
  assert.equal(G.edges.length, 2);
  assert.equal(G.juncs.length, 3);
});

test('a dual carriageway crossing resolves to one junction with one signal', () => {
  const G = graphOf({
    1: [0, 200], 2: [0, 8], 3: [0, -8], 4: [0, -200],
    5: [16, -200], 6: [16, -8], 7: [16, 8], 8: [16, 200],
    9: [-200, -8], 10: [216, -8], 11: [216, 8], 12: [-200, 8],
    13: [8, 8, { highway: 'traffic_signals' }]
  }, [
    way(1, [1, 2, 3, 4], { oneway: 'yes', name: 'Dual' }),
    way(2, [5, 6, 7, 8], { oneway: 'yes', name: 'Dual' }),
    way(3, [9, 3, 6, 10], { oneway: 'yes', name: 'Cross' }),
    way(4, [11, 7, 13, 2, 12], { oneway: 'yes', name: 'Cross' })
  ]);
  const big = G.juncs.filter((j) => j.arms >= 3);
  assert.equal(big.length, 1);
  assert.equal(big[0].members.length >= 4, true);
  const sig = attachSignals(G);
  assert.equal(sig.clusters, 1);
  assert.equal(G.juncs.filter((j) => j.kind === KIND.SIGNAL).length, 1);
  assert.equal(G.edges.filter((e) => e.ja === e.jb).length, 0);
});

test('a merge that stretches a cluster past 50 m is rejected', () => {
  const G = graphOf({
    1: [0, 0], 2: [20, 0], 3: [40, 0], 4: [60, 0], 5: [80, 0],
    11: [0, 100], 12: [20, 100], 13: [40, 100], 14: [60, 100], 15: [80, 100], 16: [-100, 0], 17: [180, 0]
  }, [
    way(1, [16, 1, 2, 3, 4, 5, 17], {}),
    way(2, [1, 11], {}), way(3, [2, 12], {}), way(4, [3, 13], {}), way(5, [4, 14], {}), way(6, [5, 15], {})
  ]);
  for (const j of G.juncs) {
    const xs = j.members.map((id) => G.nodes.get(id).x);
    assert.ok(Math.max(...xs) - Math.min(...xs) <= 500);
  }
});

test('an edge that leaves a cluster and comes back is a street, not an internal link', () => {
  const G = graphOf({ 1: [0, 0], 2: [10, 0], 3: [-100, 0], 4: [110, 0], 5: [0, 100], 6: [10, 100] }, [
    way(1, [3, 1, 2, 4], {}),
    way(2, [1, 5, 6, 2], { name: 'Long loop' })
  ]);
  assert.ok(G.edges.some((e) => e.tags.name === 'Long loop'));
  assert.ok(G.edges.every((e) => e.ja !== e.jb));
});

test('a closed way never yields an edge with a === b', () => {
  const G = graphOf({ 1: [0, 0], 2: [50, 0], 3: [50, 50], 4: [0, 50], 5: [-100, 0] }, [
    way(1, [5, 1], {}),
    way(2, [1, 2, 3, 4, 1], {})
  ]);
  assert.ok(G.edges.every((e) => e.ja !== e.jb));
});

test('movements: an invented turn through a cluster is removed', () => {
  // Two one-way internal links run away from each other, so arm A cannot reach exit B through the cluster.
  const G = graphOf({ 1: [-100, 0], 2: [0, 0], 3: [15, 0], 4: [100, 0], 5: [0, -100], 6: [0, 100], 7: [15, 100], 8: [15, -100] }, [
    way(1, [1, 2], { oneway: 'yes' }),
    way(2, [3, 2], { oneway: 'yes' }),
    way(3, [3, 4], { oneway: 'yes' }),
    way(4, [2, 6], { oneway: 'yes' }),
    way(5, [7, 3], { oneway: 'yes' }),
    way(6, [3, 8], { oneway: 'yes' })
  ]);
  const armOf = (id) => G.edges.findIndex((e) => e.way === id) * 2;
  const has = (from, to) => G.moves.some((m) => m.from === armOf(from) && m.to === armOf(to));
  assert.equal(has(1, 3), false);
  assert.equal(has(1, 4), true);
});

test('movements: U-turns exist only where there is no other way out', () => {
  const G = graphOf({ 1: [0, 0], 2: [100, 0], 3: [200, 0], 4: [100, 100], 5: [100, -100] }, [
    way(1, [1, 2], {}), way(2, [2, 3], {}), way(3, [4, 2], {}), way(4, [2, 5], {})
  ]);
  const us = G.moves.filter((m) => m.turn === TURN.UTURN);
  assert.equal(us.length, 4);
  for (const m of us) assert.equal(m.from ^ 1, m.to);
  const dead = G.juncs.filter((j) => j.arms === 1);
  assert.equal(dead.length, 4);
  assert.ok(dead.every((j) => j.kind === KIND.PRIORITY && j.flags & 2));
});

test('movements: turn codes follow right-hand geometry', () => {
  const G = graphOf({ 1: [-100, 0], 2: [0, 0], 3: [100, 0], 4: [0, 100], 5: [0, -100] }, [
    way(1, [1, 2], { oneway: 'yes' }), way(2, [2, 3], { oneway: 'yes' }), way(3, [2, 4], { oneway: 'yes' }), way(4, [2, 5], { oneway: 'yes' })
  ]);
  const from = G.edges.find((e) => e.way === 1).id * 2;
  const turnTo = (w) => G.moves.find((m) => m.from === from && m.to === G.edges.find((e) => e.way === w).id * 2).turn;
  assert.equal(turnTo(2), TURN.STRAIGHT);
  assert.equal(turnTo(3), TURN.LEFT);
  assert.equal(turnTo(4), TURN.RIGHT);
});

test('roundabouts: small rings become ordinary junctions, middling ones a RING blob, real ones circulate', () => {
  const ring = (r) => {
    const spec = { 1: [r, 0], 2: [0, r], 3: [-r, 0], 4: [0, -r], 5: [r + 100, 0], 6: [0, r + 100], 7: [-r - 100, 0], 8: [0, -r - 100] };
    return graphOf(spec, [
      way(1, [1, 2, 3, 4, 1], { junction: 'roundabout' }),
      way(2, [5, 1], {}), way(3, [6, 2], {}), way(4, [7, 3], {}), way(5, [8, 4], {})
    ]);
  };
  const small = ring(4);
  assert.equal(small.juncs.filter((j) => j.kind === KIND.RING).length, 0);
  assert.equal(small.juncs.filter((j) => j.arms === 4).length, 1);
  const medium = ring(7);
  assert.equal(medium.juncs.filter((j) => j.kind === KIND.RING).length, 1);
  assert.ok(!medium.edges.some((e) => e.ring));
  for (const r of [10, 60]) {
    const large = ring(r);
    assert.equal(large.juncs.filter((j) => j.kind === KIND.RING).length, 4);
    assert.equal(large.edges.filter((e) => e.ring).length, 4, 'every arc stays an edge, or cars cut across the island');
    assert.equal(large.keptRings.length, 1);
  }
});

test('a ring seam with nothing joining it is a bend, not a junction', () => {
  const r = 30;
  const G = graphOf({ 1: [r, 0], 2: [0, r], 3: [-r, 0], 4: [0, -r], 5: [r + 100, 0], 6: [-r - 100, 0], 7: [0, r + 100] }, [
    way(1, [1, 2], { junction: 'roundabout', name: 'A' }), way(2, [2, 3], { junction: 'roundabout', name: 'B' }),
    way(3, [3, 4, 1], { junction: 'roundabout', name: 'A' }), way(4, [5, 1], {}), way(5, [6, 3], {})
  ]);
  assert.equal(G.juncs.filter((j) => j.kind === KIND.RING).length, 2);
  assert.equal(G.juncs.filter((j) => j.kind === KIND.PASS).length, 1);
});

test('pass 12b: a mid-block light beside a junction is the same light, a lone one is real', () => {
  const spec = { 1: [-200, 0], 2: [0, 0], 3: [200, 0], 4: [0, 200], 5: [0, -200], 6: [-20, 0, { highway: 'traffic_signals' }] };
  const near = graphOf(spec, [way(1, [1, 6, 2, 3], { highway: 'tertiary' }), way(2, [4, 2, 5], { highway: 'tertiary' })]);
  const a = attachSignals(near);
  assert.equal(a.clusters, 1);
  assert.equal(a.midBlock, 0);
  assert.equal(a.absorbed, 1);
  // On narrow streets a junction takes a light only from 15 m. At 20 m it is that street's own, mid-block.
  const narrow = graphOf(spec, [way(1, [1, 6, 2, 3], {}), way(2, [4, 2, 5], {})]);
  const n = attachSignals(narrow);
  assert.equal(n.clusters, 0);
  assert.equal(n.midBlock, 1);
  const lone = graphOf({ 1: [-300, 0], 2: [0, 0, { highway: 'traffic_signals' }], 3: [300, 0] }, [way(1, [1, 2, 3], {})]);
  const b = attachSignals(lone);
  assert.equal(b.midBlock, 1);
  assert.equal(lone.juncs.filter((j) => j.kind === KIND.SIGNAL).length, 1);
});

test('a portal is always PRIORITY, never PASS or SIGNAL', () => {
  const nodes = nodesOf({ 1: [0, 0], 2: [300, 0] });
  const box = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
  const osm = { nodes, ways: new Map([[1, way(1, [1, 2], {})]]), rels: new Map() };
  const G = buildGraph(clipRoads(filterRoads(osm).ways, nodes, box).pieces, nodes);
  mergeJunctions(G);
  finishGraph(G);
  const portal = G.juncs.find((j) => j.portal);
  assert.equal(portal.kind, KIND.PRIORITY);
  assert.equal(portal.flags & 1, 1);
});

test('short stubs that cannot hold a lane are removed', () => {
  const G = graphOf({ 1: [0, 0], 2: [100, 0], 3: [200, 0], 4: [100, 1] }, [way(1, [1, 2, 3], {}), way(2, [2, 4], { name: 'Stub' })]);
  assert.ok(G.edges.every((e) => e.lenDm >= 30));
});

test('garage stubs go, a named street into a footprint stays', () => {
  const nodes = nodesOf({ 1: [0, 0], 2: [100, 0], 3: [100, 40], 4: [200, 0], 5: [100, -40] });
  const osm = {
    nodes,
    ways: new Map([1, 2, 3].map((id) => [id, null]))
  };
  const list = [way(1, [1, 2, 4], {}), way(2, [2, 3], { highway: 'service' }), way(3, [2, 5], { highway: 'service', name: 'Named' })];
  osm.ways = new Map(list.map((w) => [w.id, w]));
  const G = buildGraph(clipRoads(filterRoads(osm).ways, nodes, BOX).pieces, nodes);
  const removed = dropGarageStubs(G, (x, y) => Math.abs(y) >= 300 && x === 1000);
  assert.equal(removed, 1);
  mergeJunctions(G);
  finishGraph(G);
  assert.ok(G.edges.some((e) => e.way === 3));
  assert.ok(!G.edges.some((e) => e.way === 2));
});

test('connectivity is measured on turns: a one-way spur into a sink is not AI-routable', () => {
  const G = graphOf({ 1: [0, 0], 2: [100, 0], 3: [200, 0], 4: [100, 100] }, [
    way(1, [1, 2], {}), way(2, [2, 3], {}), way(3, [2, 4], { oneway: 'yes' })
  ]);
  const scc = connectivity(G);
  const sink = G.edges.find((e) => e.way === 3);
  assert.equal(sink.flags & 8, 0);
  assert.ok(G.edges.filter((e) => e.way !== 3).every((e) => (e.flags & 24) === 24));
  assert.ok(scc.share > 0.5);
});

test('lanes follow section 6.2', () => {
  const cases = [
    [{}, false, 'primary', [2, 2]],
    [{}, true, 'primary', [3, 0]],
    [{}, false, 'secondary', [1, 1]],
    [{}, true, 'secondary', [2, 0]],
    [{}, true, 'residential', [1, 0]],
    [{ lanes: '2' }, false, 'residential', [1, 1]],
    [{ lanes: '4' }, false, 'tertiary', [2, 2]],
    [{ lanes: '3' }, false, 'tertiary', [1, 1]],
    [{ lanes: '1' }, false, 'tertiary', [1, 1]],
    [{ lanes: '3', 'lanes:forward': '2' }, false, 'tertiary', [2, 1]],
    [{ lanes: '3', 'lanes:backward': '2' }, false, 'tertiary', [1, 2]],
    [{ lanes: '9' }, true, 'primary', [5, 0]],
    [{ lanes: '12' }, false, 'primary', [5, 5]]
  ];
  for (const [t, oneway, cls, want] of cases) assert.deepEqual(lanesOf(t, oneway, TAGS.classes[cls], TAGS), want, JSON.stringify(t));
});

test('a numeric maxspeed is used, anything else takes the class default', () => {
  const G = graphOf({ 1: [0, 0], 2: [100, 0], 3: [300, 0], 4: [400, 0] }, [
    way(1, [1, 2], { maxspeed: '70' }), way(2, [2, 3], { maxspeed: 'IL:urban' }), way(3, [3, 4], { highway: 'living_street' })
  ]);
  const by = (id) => G.edges.find((e) => e.way === id).kmh;
  assert.equal(by(1), 70);
  assert.equal(by(2), 30);
  assert.equal(by(3), 15);
});

test('lane offsets follow section 8.1', () => {
  assert.deepEqual(laneOffsets(1, 1, 30), [15, -15]);
  assert.deepEqual(laneOffsets(2, 1, 30), [45, 15, -15]);
  assert.deepEqual(laneOffsets(2, 0, 30), [15, -15]);
  assert.deepEqual(laneOffsets(3, 0, 30), [30, 0, -30]);
});

test('the collider check trims no more than a real lane is ever trimmed', () => {
  assert.deepEqual(minTrims(1000, false, false), [30, 30]);
  assert.deepEqual(minTrims(1000, true, false), [0, 30]);
  assert.deepEqual(minTrims(1000, true, true), [0, 0]);
  const [a, b] = minTrims(50, false, false);
  assert.ok(Math.abs(a - 10) < 1e-9 && Math.abs(b - 10) < 1e-9, 'a 5 m edge keeps a 3 m lane');
  assert.deepEqual(minTrims(30, false, false), [0, 0]);
});

test('offsetting goes to the right of travel', () => {
  assert.deepEqual(offsetPolyline([0, 0, 100, 0], 10), [0, -10, 100, -10]);
  const bent = offsetPolyline([0, 0, 100, 0, 100, 100], 10, true);
  assert.ok(Math.abs(bent[2] - 110) < 1e-9 && Math.abs(bent[3] + 10) < 1e-9);
});

test('the zone parser guards the 6sidewalk=both value in the data', () => {
  assert.equal(parseZone('6sidewalk=both'), '6');
  assert.equal(parseZone('10'), '10');
  assert.equal(parseZone(undefined), '');
  assert.equal(parseZone('A;B'), 'A');
});

test('kerb tiers follow section 6.4', () => {
  const kerb = (tags, side, rev = false) => partKerb({ tags: { highway: 'residential', ...tags }, rev }, side, PARKING);
  const { explicit, zone, inferred, none } = PARKING.tiers;
  assert.equal(kerb({ 'parking:right': 'yes' }, 1).tier, explicit);
  assert.equal(kerb({ 'parking:both': 'lane' }, 0).tier, explicit);
  assert.equal(kerb({ 'parking:left': 'street_side' }, 0).tier, explicit);
  assert.equal(kerb({ 'parking:left:zone': '4' }, 0).tier, zone);
  assert.equal(kerb({ 'parking:both:zone': '4' }, 1).tier, zone);
  assert.equal(kerb({}, 0).tier, inferred);
  assert.equal(kerb({ highway: 'tertiary' }, 1).tier, inferred);
  assert.equal(kerb({ highway: 'tertiary' }, 0).tier, none);
  assert.equal(kerb({ highway: 'secondary' }, 1).tier, none);
  assert.equal(kerb({ 'parking:both': 'no' }, 1).tier, none);
  assert.equal(kerb({ highway: 'tertiary_link' }, 1).tier, none);
  assert.equal(kerb({ bridge: 'yes' }, 1).tier, none);
  assert.equal(kerb({ junction: 'roundabout' }, 1).tier, none);
  assert.equal(kerb({ 'parking:left': 'yes', 'parking:right': 'no' }, 1, true).tier, explicit);
  assert.equal(kerb({ 'parking:left': 'yes', 'parking:right': 'no' }, 0, true).tier, none);
  assert.equal(kerb({ 'parking:right:zone': '6sidewalk=both' }, 1).zone, '6');
  assert.equal(kerb({ 'parking:left:orientation': 'diagonal' }, 0).form, 1);
});

test('POI kinds come from the rules, street furniture is out, and a list value uses its first entry', () => {
  assert.equal(kindOf({ amenity: 'pharmacy' }, KINDS), 'pharmacy');
  assert.equal(kindOf({ shop: 'bakery' }, KINDS), 'bakery');
  assert.equal(kindOf({ shop: 'books' }, KINDS), 'shop');
  assert.equal(kindOf({ amenity: 'bench' }, KINDS), undefined);
  assert.equal(kindOf({ amenity: 'bank;restaurant' }, KINDS), 'bank');
  for (const k of ['convenience', 'supermarket', 'laundry', 'dry_cleaning', 'bakery', 'hairdresser', 'greengrocer', 'butcher', 'ice_cream']) {
    assert.equal(kindOf({ shop: k }, KINDS), k);
  }
  for (const k of ['bank', 'pharmacy', 'post_office', 'fuel', 'ice_cream']) assert.equal(kindOf({ amenity: k }, KINDS), k);
});

test('sensitive covers amenity and building tags, as section 6.5 lists them', () => {
  for (const a of ['place_of_worship', 'school', 'kindergarten', 'hospital']) assert.ok(isSensitive({ amenity: a }, KINDS));
  for (const b of ['school', 'kindergarten', 'synagogue', 'mosque', 'church', 'temple', 'chapel', 'cathedral', 'shrine', 'hospital']) {
    assert.ok(isSensitive({ building: b }, KINDS));
  }
  assert.equal(isSensitive({ amenity: 'cafe', building: 'yes' }, KINDS), false);
});

test('names follow section 6.5', () => {
  assert.deepEqual(namesOf({ name: 'אבן גבירול', 'name:en': 'Ibn Gabirol' }), { he: 'אבן גבירול', en: 'Ibn Gabirol' });
  assert.deepEqual(namesOf({ name: 'Carrefour' }), { he: '', en: 'Carrefour' });
  assert.deepEqual(namesOf({ name: 'מאפייה' }), { he: 'מאפייה', en: '' });
  assert.deepEqual(namesOf({ name: 'Café Noir' }), { he: '', en: 'Café Noir' });
  assert.deepEqual(namesOf({ name: 'مسجد' }), { he: '', en: '' });
  assert.deepEqual(namesOf({ name: '416' }), { he: '', en: '416' }, 'an ASCII name need not hold a letter');
  assert.deepEqual(namesOf({ name: '24/7' }), { he: '', en: '24/7' });
  assert.deepEqual(namesOf({ name: '416 מאפייה' }), { he: '416 מאפייה', en: '' });
  assert.deepEqual(namesOf({ name: '416', 'name:en': 'Four Sixteen' }), { he: '', en: 'Four Sixteen' });
});

test('street keys drop the street word, so addr:street matches a bare road name', () => {
  const n = TLV.anchors.normalizeName;
  assert.equal(streetKey('רחוב דיזנגוף', n), streetKey('דיזנגוף', n));
  assert.equal(streetKey("רח' דיזנגוף", n), streetKey('דיזנגוף', n));
  assert.equal(streetKey('Dizengoff St.', n), streetKey('Dizengoff', n));
});

test('rings: join, simplify, clip', () => {
  const j = joinRings([[1, 2, 3], [5, 4, 3], [5, 6, 1]]);
  assert.equal(j.rings.length, 1);
  assert.equal(j.rings[0].length, 6);
  assert.equal(j.open, 0);
  assert.equal(joinRings([[1, 2], [3, 4]]).open, 2);
  assert.equal(simplifyRing([0, 0, 50, 1, 100, 0, 100, 100, 0, 100], 2).length, 8);
  const c = clipRing([-50, -50, 50, -50, 50, 50, -50, 50], { minX: 0, minY: 0, maxX: 100, maxY: 100 });
  assert.equal(Math.abs(ringArea(c)), 2500);
});

test('the sea closes clockwise against the box, with water on the right of the coast', () => {
  const nodes = nodesOf({ 1: [0, 200], 2: [-20, 0], 3: [0, -200] });
  const osm = {
    nodes,
    ways: new Map([[1, { id: 1, type: 'way', nodes: [1, 2, 3], tags: { natural: 'coastline' } }]])
  };
  const box = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
  const rings = seaRings(osm, box);
  assert.equal(rings.length, 1);
  const inside = (x, y) => {
    let c = false;
    const r = rings[0];
    const n = r.length >> 1;
    for (let i = 0, k = n - 1; i < n; k = i++) {
      if ((r[2 * i + 1] > y) !== (r[2 * k + 1] > y) && x < ((r[2 * k] - r[2 * i]) * (y - r[2 * i + 1])) / (r[2 * k + 1] - r[2 * i + 1]) + r[2 * i]) c = !c;
    }
    return c;
  };
  assert.equal(inside(-800, 0), true);
  assert.equal(inside(800, 0), false);
  assert.equal(LAND.SEA, 0);
});

test('overlays need a why, and unknown ops are refused', (t) => {
  const dir = tempDir(t);
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify([{ op: 'road.set', anchor: { osm: 'w1' }, set: { lanes: 3 } }]));
  assert.throws(() => loadOverlays(dir), /needs a why/);
  fs.writeFileSync(path.join(dir, 'a.json'), JSON.stringify([{ op: 'road.paint', why: 'x' }]));
  assert.throws(() => loadOverlays(dir), /unknown op/);
});

test('pre overlays rewrite raw records, and an orphan is reported, not thrown', () => {
  const nodes = nodesOf({ 1: [0, 0], 2: [100, 0] });
  for (const n of nodes.values()) {
    n.lat = n.y / 1108880 + 32.075;
    n.lon = n.x / 944150 + 34.7775;
  }
  const osm = { nodes, ways: new Map([[1, way(1, [1, 2], { name: 'Road' })]]), rels: new Map() };
  const ctx = { anchors: TLV.anchors, proj: makeProjection([32.075, 34.7775]), origin: [32.075, 34.7775] };
  const ops = [
    { op: 'road.set', anchor: { osm: 'w1' }, set: { lanes: 3 }, why: 'a', source: 't[0]' },
    { op: 'road.set', anchor: { osm: 'w999' }, set: { lanes: 3 }, why: 'b', source: 't[1]' },
    { op: 'road.add', points: [[32.075, 34.7775], { osm: 'n2' }], tags: { highway: 'service' }, why: 'c', source: 't[2]' }
  ];
  const orphans = applyPre(ops, osm, ctx);
  assert.equal(osm.ways.get(1).tags.lanes, '3');
  assert.equal(orphans.length, 1);
  assert.equal(orphans[0].how, 'orphan');
  assert.equal(osm.ways.size, 2);
});

/** Scene for the POI tests: `Main` runs north of a 20 m block, and `Side` passes close to its east wall. */
function facadeScene(neighbour = false) {
  const G = graphOf({ 1: [-100, 40], 2: [14, 40], 3: [100, 40], 4: [14, -60] }, [
    way(1, [1, 2, 3], { name: 'Main' }),
    way(2, [4, 2], { name: 'Side' })
  ]);
  const osm = {
    nodes: nodesOf({
      100: [-10, -10], 101: [10, -10], 102: [10, 10], 103: [-10, 10],
      110: [2, 10.2], 111: [12, 10.2], 112: [12, 14], 113: [2, 14]
    }),
    ways: new Map([[50, { type: 'way', id: 50, nodes: [100, 101, 102, 103, 100], tags: { building: 'yes' } }]]),
    rels: new Map()
  };
  if (neighbour) osm.ways.set(51, { type: 'way', id: 51, nodes: [110, 111, 112, 113, 110], tags: { building: 'yes' } });
  const { blds } = prepareBuildings(osm, BOX, TAGS);
  const index = new BuildingIndex(blds);
  const roads = new RoadIndex(G.edges);
  setFronts(blds, roads, index);
  return { G, blds, index, roads };
}

/** A POI record as `collectPois` writes it. */
const poiAt = (x, y, streets = []) => ({
  osm: 1, osmT: 0, x: x * 10, y: y * 10, kind: 'bakery', nameHe: '', nameEn: 'Shop', streets, sensitive: false, guard: false
});

test('edge is the road nearest the door, and the road the wall faces stays private', () => {
  const { G, blds, index, roads } = facadeScene();
  const road = (name) => G.edges.find((e) => e.tags.name === name);
  const [p] = bindFacades([poiAt(8, 8, ['Main'])], blds, index, roads, TLV.anchors.normalizeName).pois;
  assert.equal(p.pick.road.e.tags.name, 'Main', 'addr:street picks the wall that faces Main');
  assert.ok(p.entY > 100, 'the door is on the north wall');
  assert.equal(p.edge, road('Side').id + 1, 'Side is 8.5 m from that door, Main is 29.5 m');
});

test('a door a neighbouring building stands on slides along the wall to the nearest free spot', () => {
  const { blds, index, roads } = facadeScene(true);
  const [p] = bindFacades([poiAt(8, 8, ['Main'])], blds, index, roads, TLV.anchors.normalizeName).pois;
  assert.ok(p.pick, 'the wall is still picked');
  assert.equal(index.at(p.entX, p.entY).length, 0, `door at ${p.entX}, ${p.entY}`);
  assert.equal(p.entY, 105, '0.5 m off the north wall');
  assert.ok(p.entX < 20 && p.entX > 0, `the free spot nearest the sign, not the wall middle: ${p.entX}`);
});

test('a POI with no facade snaps to the nearest edge however far it is, and still gets an edge', () => {
  const { G, blds, index, roads } = facadeScene();
  const [p] = bindFacades([poiAt(14, -400)], blds, index, roads, TLV.anchors.normalizeName).pois;
  const side = G.edges.find((e) => e.tags.name === 'Side');
  assert.ok(p.flags & POIF.NO_FACADE);
  assert.equal(p.edge, side.id + 1);
  assert.ok(Math.hypot(p.entX - 140, p.entY + 600) < 60, `door at ${p.entX}, ${p.entY}`);
});

test('a POI on a map with no roads keeps its raw position and has no edge', () => {
  const { blds, index } = facadeScene();
  const [p] = bindFacades([poiAt(500, 500)], blds, index, new RoadIndex([]), TLV.anchors.normalizeName).pois;
  assert.equal(p.edge, 0);
  assert.deepEqual([p.entX, p.entY], [5000, 5000]);
});

test('the nearest edge is found at any range, beyond the first search radius', () => {
  const G = graphOf({ 1: [-900, -900], 2: [-700, -900], 3: [900, 500], 4: [900, 800] }, [way(1, [1, 2], {}), way(2, [3, 4], {})]);
  const roads = new RoadIndex(G.edges);
  assert.equal(roads.nearest(8900, 6000).e.way, 2);
  const far = roads.nearest(-15000, -9000);
  assert.equal(far.e.way, 1);
  assert.ok(Math.abs(far.d - 6000) < 1e-9, `${far.d}`);
  assert.equal(new RoadIndex([]).nearest(0, 0), null);
});

test('only location=underground removes a building, because layer is stacking order', () => {
  const square = (ox) => ({ [ox]: [ox, 0], [ox + 1]: [ox + 20, 0], [ox + 2]: [ox + 20, 20], [ox + 3]: [ox, 20] });
  const nodes = nodesOf({ ...square(100), ...square(200), ...square(300), ...square(400) });
  const b = (id, ox, tags) => [id, { type: 'way', id, nodes: [ox, ox + 1, ox + 2, ox + 3, ox], tags: { building: 'yes', ...tags } }];
  const osm = {
    nodes,
    ways: new Map([
      b(1, 100, { layer: '-1' }),
      b(2, 200, { layer: '-1', location: 'surface' }),
      b(3, 300, { location: 'underground' }),
      b(4, 400, { layer: '2' })
    ]),
    rels: new Map()
  };
  const { blds, stats } = prepareBuildings(osm, BOX, TAGS);
  assert.deepEqual(blds.map((x) => x.osm).sort(), [1, 2, 4]);
  assert.equal(stats.undergroundDropped, 1);
});

/** A two-outer relation building with a hole in its first outer, plus an unrelated building. */
function relationOsm() {
  const nodes = nodesOf({
    1: [0, 0], 2: [40, 0], 3: [40, 40], 4: [0, 40],
    5: [200, 0], 6: [240, 0], 7: [240, 40], 8: [200, 40],
    11: [15, 15], 12: [25, 15], 13: [25, 25], 14: [15, 25],
    21: [500, 0], 22: [520, 0], 23: [520, 20], 24: [500, 20]
  });
  for (const n of nodes.values()) {
    n.lat = n.y / 1108880 + 32.075;
    n.lon = n.x / 944150 + 34.7775;
  }
  const raw = (id, ids, tags) => [id, { type: 'way', id, nodes: ids, tags }];
  return {
    nodes,
    ways: new Map([
      raw(1, [1, 2, 3, 4, 1], { building: 'yes' }),
      raw(2, [5, 6, 7, 8, 5], undefined),
      raw(3, [11, 12, 13, 14, 11], undefined),
      raw(4, [21, 22, 23, 24, 21], { building: 'yes' })
    ]),
    rels: new Map([[77, {
      type: 'relation',
      id: 77,
      tags: { building: 'retail', name: 'Big Center' },
      members: [
        { type: 'way', ref: 1, role: 'outer' },
        { type: 'way', ref: 2, role: 'outer' },
        { type: 'way', ref: 3, role: 'inner' }
      ]
    }]])
  };
}

/** Runs one `building.set` and reports what happened to the relation. */
function setOnRelation(anchor) {
  const osm = relationOsm();
  const ctx = { anchors: TLV.anchors, proj: makeProjection([32.075, 34.7775]), origin: [32.075, 34.7775] };
  const orphans = applyPre([{ op: 'building.set', anchor, set: { style: 's' }, why: 'test', source: 't[0]' }], osm, ctx);
  return { how: orphans.length ? orphans[0].how : 'exact', style: osm.rels.get(77).tags['tlv:style'], member: osm.ways.get(1).tags['tlv:style'] };
}

/** Lat/lon of a point given in metres. */
const llOf = (x, y) => [y / 110888 + 32.075, x / 94415 + 34.7775];

test('a renumbered relation building relocates by a point in any outer ring', () => {
  assert.deepEqual(setOnRelation({ osm: 'r999', at: llOf(5, 5) }), { how: 'relocated', style: 's', member: undefined });
  assert.deepEqual(setOnRelation({ osm: 'r999', at: llOf(220, 20) }), { how: 'relocated', style: 's', member: undefined });
});

test('a point in a relation hole is not in the building', () => {
  assert.equal(setOnRelation({ osm: 'r999', at: llOf(20, 20) }).how, 'orphan');
});

test('a renumbered relation building moves by name, measured to its nearest outer ring', () => {
  assert.equal(setOnRelation({ osm: 'r999', name: 'big center', at: llOf(280, 20) }).how, 'moved');
  assert.equal(setOnRelation({ osm: 'r999', name: 'big center', at: llOf(320, 20) }).how, 'orphan');
  assert.equal(setOnRelation({ osm: 'r999', name: 'big center', at: llOf(120, 20) }).how, 'orphan');
});

test('a member way the relation claims is no anchor of its own', () => {
  const claimed = setOnRelation({ osm: 'w1', at: llOf(5, 5) });
  assert.deepEqual(claimed, { how: 'relocated', style: 's', member: undefined });
  assert.equal(setOnRelation({ osm: 'w1' }).how, 'orphan');
  const { ways, rels } = buildingRecords(relationOsm());
  assert.deepEqual(ways.map((w) => w.id), [4]);
  assert.deepEqual(rels.map((x) => x.r.id), [77]);
});

test('deleting a relation building also deletes a member way that is a building in its own right', () => {
  const osm = relationOsm();
  const ctx = { anchors: TLV.anchors, proj: makeProjection([32.075, 34.7775]), origin: [32.075, 34.7775] };
  assert.deepEqual(applyPre([{ op: 'building.delete', anchor: { osm: 'r77' }, why: 'test', source: 't[0]' }], osm, ctx), []);
  assert.deepEqual(prepareBuildings(osm, BOX, TAGS).blds.map((b) => b.osm), [4]);
});

test('a plain building anchor is at distance 0 from inside, however big it is', () => {
  const osm = relationOsm();
  const huge = { 31: [1000, 0], 32: [1400, 0], 33: [1400, 400], 34: [1000, 400] };
  for (const [id, n] of nodesOf(huge)) osm.nodes.set(id, n);
  osm.ways.set(9, { type: 'way', id: 9, nodes: [31, 32, 33, 34, 31], tags: { building: 'yes', name: 'Hall' } });
  const ctx = { anchors: TLV.anchors, proj: makeProjection([32.075, 34.7775]), origin: [32.075, 34.7775] };
  const op = { op: 'building.set', anchor: { osm: 'w999', name: 'Hall', at: llOf(1200, 200) }, set: { height: 9 }, why: 'test', source: 't[0]' };
  assert.equal(applyPre([op], osm, ctx)[0].how, 'moved', 'the centre is 200 m from any wall but inside the footprint');
});

test('pass 5 lists the pieces of a way in travel order, also for oneway=-1', () => {
  const box = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
  const nodes = nodesOf({ 1: [0, 0], 2: [200, 0], 3: [200, 50], 4: [0, 50] });
  const { pieces } = clipRoads([way(9, [1, 2, 3, 4], { oneway: '-1' })], nodes, box);
  assert.equal(pieces[0].nodes[0], 4);
  assert.equal(pieces[1].nodes.at(-1), 1);
});

test('both sides of a pass 6 cut stay in way order whatever their node ids', () => {
  const G = graphOf({ 90: [-100, 0], 91: [100, 0], 30: [0, -100], 31: [0, -50], 33: [0, -5], 4: [0, 5], 5: [0, 100] }, [
    way(1, [90, 91], { highway: 'primary' }),
    way(2, [30, 31, 33, 4, 5], { highway: 'residential' })
  ]);
  assert.deepEqual(G.edges.filter((e) => e.way === 2).map((e) => e.ids[0]), [30, 4]);
});

test('pieces cut apart by a node outside the box keep way order for oneway=-1 too', () => {
  const nodes = nodesOf({ 80: [0, 0], 81: [50, 0], 82: [200, 0], 83: [200, 50], 3: [50, 50], 4: [0, 50] });
  const osm = { nodes, ways: new Map([[9, way(9, [80, 81, 82, 83, 3, 4], { oneway: '-1' })]]), rels: new Map() };
  const box = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 };
  const G = buildGraph(clipRoads(filterRoads(osm).ways, nodes, box).pieces, nodes);
  mergeJunctions(G);
  finishGraph(G);
  assert.deepEqual(G.edges.map((e) => e.ids.at(-1) < 0 ? 'to portal' : 'from portal'), ['to portal', 'from portal']);
  assert.equal(G.edges[0].ids[0], 4);
});

test('a closed way begins at its own first node, not at its lowest node id', () => {
  const nodeSpec = { 50: [0, 0], 20: [100, 0], 30: [100, 100], 40: [0, 100], 71: [-50, -50], 72: [150, 0], 73: [-50, 100] };
  const spurs = [way(2, [50, 71], {}), way(3, [20, 72], {}), way(4, [40, 73], {})];
  for (const tags of [{}, { oneway: 'yes' }]) {
    const G = graphOf(nodeSpec, [way(1, [50, 20, 30, 40, 50], tags), ...spurs]);
    assert.deepEqual(G.edges.filter((e) => e.way === 1).map((e) => e.ids[0]), [50, 20, 40], JSON.stringify(tags));
  }
});

test('halves of a split edge stay in way order when contraction reversed the way', () => {
  const G = graphOf({ 50: [0, 0], 2: [10, 0], 3: [0, 100], 4: [60, 150], 5: [120, 100], 60: [-100, 0] }, [
    way(1, [50, 2], {}),
    way(2, [50, 3, 4, 5, 2], {}),
    way(3, [50, 60], {})
  ]);
  const edges = G.edges.filter((e) => e.way === 2);
  assert.deepEqual(edges.map((e) => e.ids[0]), [50, 4], 'way 2 is digitized 50, 3, 4, 5, 2');
});

test('each half of a split edge names only the ways it holds', () => {
  const G = graphOf({ 1: [0, 0], 2: [100, 0], 3: [100, 100], 4: [0, 100], 9: [-100, 0] }, [
    way(1, [1, 2, 3], {}),
    way(2, [3, 4, 1], {}),
    way(3, [1, 9], {})
  ]);
  const loop = G.edges.filter((e) => e.way !== 3);
  assert.deepEqual(loop.map((e) => e.way).sort(), [1, 2]);
  for (const e of loop) assert.deepEqual([...new Set(e.parts.map((p) => p.way))], [e.way]);
});

test('connectivity on no roads is zero, not undefined', () => {
  const G = graphOf({ 1: [0, 0] }, []);
  assert.deepEqual(connectivity(G), { laneKm: 0, sccLaneKm: 0, share: 0, components: 0 });
});

test('a lone one-way edge has no way out, so it is not AI-routable', () => {
  const G = graphOf({ 1: [-300, 0], 2: [300, 0] }, [way(1, [1, 2], { oneway: 'yes' })]);
  const scc = connectivity(G);
  assert.equal(G.edges.length, 1);
  assert.equal(G.moves.length, 0);
  assert.equal(G.edges[0].flags & 24, 0);
  assert.equal(scc.sccLaneKm, 0);
});

/** Sea rings for a box of half-size 100 m at a centre, in metres, against one coast. */
function seaFor(cx, cy, coast) {
  const spec = {};
  coast.forEach((p, i) => {
    spec[i + 1] = p;
  });
  const osm = {
    nodes: nodesOf(spec),
    ways: new Map([[1, { id: 1, type: 'way', nodes: coast.map((_, i) => i + 1), tags: { natural: 'coastline' } }]])
  };
  return seaRings(osm, { minX: (cx - 100) * 10, minY: (cy - 100) * 10, maxX: (cx + 100) * 10, maxY: (cy + 100) * 10 });
}

test('a box no coast enters is all sea on the right of the coast, and nothing on the left', () => {
  const south = [[0, 1000], [0, -1000]];
  const rings = seaFor(-500, 0, south);
  assert.equal(rings.length, 1);
  assert.equal(Math.abs(ringArea(rings[0])), 4000000);
  assert.deepEqual(seaFor(500, 0, south), []);
  const short = [[900, 900], [900, 800]];
  assert.equal(seaFor(0, 0, short).length, 1, 'past the end of a coast, its last segment still decides the side');
  assert.deepEqual(seaFor(1800, 850, short), []);
});

test('side of the coast holds when the nearest coast point is a vertex', () => {
  const rightTurn = [[-500, 1000], [0, 0], [-500, -1000]];
  assert.deepEqual(seaFor(300, 0, rightTurn), [], 'east of the cape, the land side');
  assert.equal(seaFor(-500, 0, rightTurn).length, 1, 'inside the wedge is sea');
  const leftTurn = [[500, 1000], [0, 0], [500, -1000]];
  assert.equal(seaFor(-300, 0, leftTurn).length, 1, 'west of the bay mouth, the wide water side');
  assert.deepEqual(seaFor(500, 0, leftTurn), [], 'inside the wedge is land');
});

test('no coastline at all means no sea', () => {
  assert.deepEqual(seaRings({ nodes: new Map(), ways: new Map() }, BOX), []);
});

/** Runs a network through section 13 with the overlay ways of `overlaid` changed the way `applyPre` changes them. */
function sectionsOf(nodeSpec, ways, overlaid, blds) {
  const nodes = nodesOf(nodeSpec);
  const list = ways.map((w) => ({ ...w, tags: { ...w.tags } }));
  for (const w of list) {
    if (overlaid[w.id]) {
      w.baseTags = w.tags;
      w.tags = { ...w.tags, ...overlaid[w.id] };
    }
  }
  const osm = { nodes, ways: new Map(list.map((w) => [w.id, w])), rels: new Map() };
  const clipped = clipRoads(filterRoads(osm).ways, nodes, BOX);
  const G = buildGraph(gradeSeparate(clipped.pieces, nodes, TAGS.classOrder).pieces, nodes);
  mergeJunctions(G);
  finishGraph(G);
  normalizeEdges(G.edges, TAGS);
  const chains = overlayChains(G);
  buildMovements(G);
  attachSignals(G);
  crossSection(G.edges, G.juncs, new BuildingIndex(blds), TAGS, PARKING, chains);
  return G;
}

/** Sidewalks of the stretch of road at metre `x` on an east-west street, in the street's east-going sense. */
function sideAt(G, x) {
  const e = G.edges.find((q) => {
    const xs = [q.pts[0], q.pts[q.pts.length - 2]];
    return x * 10 > Math.min(...xs) && x * 10 < Math.max(...xs);
  });
  const east = e.pts[0] < e.pts[e.pts.length - 2];
  return { way: e.way, north: east ? e.swL : e.swR, south: east ? e.swR : e.swL, parkN: east ? e.parkL : e.parkR, laneW: e.laneW };
}

/** A street of two ways with a building hard against the north side of its west way, under half the length of the street. */
function streetScene(digitizeEastWayBackwards) {
  const walls = { 100: [-90, 4.5], 101: [-40, 4.5], 102: [-40, 30], 103: [-90, 30] };
  const osm = {
    nodes: nodesOf(walls),
    ways: new Map([[50, { type: 'way', id: 50, nodes: [100, 101, 102, 103, 100], tags: { building: 'yes' } }]]),
    rels: new Map()
  };
  const { blds } = prepareBuildings(osm, BOX, TAGS);
  const nodes = { 1: [-100, 0], 2: [0, 0], 3: [60, 0] };
  const ways = [way(1, [1, 2], { name: 'Long' }), way(2, digitizeEastWayBackwards ? [3, 2] : [2, 3], { name: 'Long' })];
  return { nodes, ways, blds };
}

test('a neighbour split off by an overlay keeps the widths of the road it was part of', () => {
  for (const backwards of [false, true]) {
    const { nodes, ways, blds } = streetScene(backwards);
    const plain = sectionsOf(nodes, ways, {}, blds);
    assert.equal(plain.edges.length, 1, 'without the overlay the two ways are one edge');
    const before = sideAt(plain, 30);
    const split = sectionsOf(nodes, ways, { 1: { lanes: '4' } }, blds);
    assert.equal(split.edges.length, 2, 'pass 7 may not contract across changed tags');
    const after = sideAt(split, 30);
    assert.equal(after.way, 2);
    assert.deepEqual({ ...after, way: 0 }, { ...before, way: 0 }, `digitized backwards: ${backwards}`);
    assert.equal(after.north, before.north);
    assert.ok(before.north < before.south, 'the building narrows the whole road, which is what the east way must keep');
  }
});

test('an overlay chain gives each member only the pinches on its own stretch, in its own arc length', () => {
  for (const backwards of [false, true]) {
    const { nodes, ways, blds } = streetScene(backwards);
    const G = sectionsOf(nodes, ways, { 2: { lanes: '4' } }, blds);
    const west = G.edges.find((e) => e.way === 1);
    const east = G.edges.find((e) => e.way === 2);
    assert.ok(west.lanesF === 1 && east.lanesF === 2, 'the overlay reached only its own way');
    const westward = west.pts[0] > west.pts[west.pts.length - 2];
    const pinched = westward ? west.pinchR : west.pinchL;
    assert.ok(pinched.length >= 1, 'the building narrows the north side of the west way');
    assert.equal((westward ? west.pinchL : west.pinchR).length, 0, 'and that side only');
    for (const [a, b] of pinched) {
      const from = (s) => (westward ? west.lenDm - s : s) / 10 - 100;
      assert.ok(from(a) >= -95 && from(a) <= -35 && from(b) >= -95 && from(b) <= -35, `${from(a)} to ${from(b)}`);
    }
    assert.deepEqual([...east.pinchL, ...east.pinchR], [], 'nothing narrows the east way');
  }
});

test('a pinch lands in the right place on a member that runs against its chain', () => {
  // Way 1 is the longer, so it sets the chain's direction, and way 2 is digitized the other way. The building stands beside it.
  const walls = {
    nodes: nodesOf({ 100: [10, 4.5], 101: [40, 4.5], 102: [40, 30], 103: [10, 30] }),
    ways: new Map([[50, { type: 'way', id: 50, nodes: [100, 101, 102, 103, 100], tags: { building: 'yes' } }]]),
    rels: new Map()
  };
  const { blds } = prepareBuildings(walls, BOX, TAGS);
  const { nodes, ways } = streetScene(true);
  const G = sectionsOf(nodes, ways, { 1: { lanes: '4' } }, blds);
  const east = G.edges.find((e) => e.way === 2);
  assert.ok(east.pts[0] > east.pts[east.pts.length - 2], 'it runs west');
  assert.equal(east.pinchL.length, 0, 'north is its right side');
  assert.ok(east.pinchR.length >= 1);
  for (const [a, b] of east.pinchR) {
    const x = (s) => 60 - s / 10;
    assert.ok(x(a) <= 42 && x(b) >= 8, `pinch from x ${x(a)} to x ${x(b)}`);
  }
});

test('a split keeps the turns at the far junction, however short the piece it leaves there', () => {
  // West of the T the street bends 40 degrees, 6 m from the junction. Read over 10 m the arm points away from the bend, and
  // read over the 6 m piece an overlay would leave, it points along it.
  const nodes = { 1: [0, 0], 2: [100, 0], 3: [100, 100], 4: [-4.6, 3.9], 5: [-60, -40] };
  const ways = [way(1, [1, 2], { name: 'East' }), way(2, [1, 3], { name: 'North' }), way(3, [1, 4], { name: 'West' }), way(4, [4, 5], { name: 'West' })];
  const turns = (overlaid) => {
    const G = sectionsOf(nodes, ways, overlaid, []);
    return G.moves.filter((m) => {
      const j = G.juncs.find((q) => q.members.includes(1));
      const end = (de) => (de & 1 ? G.edges[de >> 1].ja : G.edges[de >> 1].jb);
      return end(m.from) === j.id;
    }).map((m) => `${G.edges[m.from >> 1].way}>${G.edges[m.to >> 1].way}:${m.turn}`).sort();
  };
  const named = (list) => list.map((m) => m.replace(/4/g, '3')).filter((m) => !m.startsWith('3>3'));
  const plain = turns({});
  assert.ok(plain.some((m) => m.endsWith(':0') && m.includes('4')), 'the bend reads as straight on through');
  assert.deepEqual(named(turns({ 4: { lanes: '4' } })), named(plain));
});

test('a chain that closes on itself is left alone, not walked forever', () => {
  // Both boundaries of the ring are overlay joints, and nothing else meets it, so the walk has no free end.
  const G = graphOf({ 1: [0, 0], 2: [100, 0], 3: [100, 100], 4: [0, 100] }, [
    { ...way(1, [1, 2, 3], { name: 'Loop', lanes: '4' }), baseTags: { highway: 'residential', name: 'Loop' } },
    way(2, [3, 4, 1], { name: 'Loop' })
  ]);
  assert.equal(G.overlaySplits.size, 2);
  assert.equal(G.edges.length, 2);
  assert.deepEqual(overlayChains(G), []);
});

test('an overlay chain runs through several ways, and a one-way chain runs the way traffic does', () => {
  const nodes = { 1: [0, 0], 2: [100, 0], 3: [200, 0], 4: [300, 0], 5: [-50, 50], 6: [-50, -50], 7: [350, 50], 8: [350, -50] };
  const road = (id, list, extra) => way(id, list, { name: 'One', oneway: 'yes', ...extra });
  const G = graphOf(nodes, [
    road(1, [1, 2], {}),
    { ...road(2, [2, 3], { lanes: '4' }), baseTags: { highway: 'residential', name: 'One', oneway: 'yes' } },
    road(3, [3, 4], {}),
    way(4, [5, 1, 6], { name: 'A' }),
    way(5, [7, 4, 8], { name: 'B' })
  ]);
  const [v] = overlayChains(G);
  assert.equal(v.members.length, 3);
  assert.deepEqual(v.members.map((m) => m.along), [true, true, true]);
  assert.deepEqual(v.members.map((m) => m.s), [0, 1000, 2000]);
  assert.equal(v.lenDm, 3000);
  assert.deepEqual(v.members.map((m) => m.e.way), [1, 2, 3]);
});

test('an overlay on a way does not remove the short road beyond it as a garage stub', () => {
  const blds = (id) => id === 3;
  const nodes = { 1: [0, 0], 2: [100, 0], 3: [130, 0], 4: [0, 50], 5: [0, -50] };
  const ways = () => [
    way(1, [1, 2], { highway: 'service', lanes: '4' }),
    way(2, [2, 3], { highway: 'service' }),
    way(3, [4, 1, 5], { name: 'Through' })
  ];
  const run = (base) => {
    const list = ways();
    if (base) list[0].baseTags = { highway: 'service' };
    const n = nodesOf(nodes);
    const osm = { nodes: n, ways: new Map(list.map((w) => [w.id, w])), rels: new Map() };
    const G = buildGraph(clipRoads(filterRoads(osm).ways, n, BOX).pieces, n);
    return dropGarageStubs(G, (x, y) => x === n.get(3).x && y === n.get(3).y && blds(3));
  };
  assert.equal(run(false), 1, 'two ways that really differ: the far one is a stub');
  assert.equal(run(true), 0, 'without the overlay they are one street, so it stays');
});

test('what a wall faces does not depend on how the road is cut into edges', () => {
  // The road bends around the block. Its nearest point is behind the wall's back, a farther stretch is in plain view.
  const nodes = { 1: [-60, -30], 2: [-14, -30], 3: [-14, 30], 4: [40, 30], 5: [40, 60] };
  const bend = (extra) => [way(1, [1, 2, 3], { name: 'Bend', ...extra }), way(2, [3, 4, 5], { name: 'Bend' })];
  const walls = {
    nodes: nodesOf({ 100: [-10, -10], 101: [10, -10], 102: [10, 10], 103: [-10, 10] }),
    ways: new Map([[50, { type: 'way', id: 50, nodes: [100, 101, 102, 103, 100], tags: { building: 'yes' } }]]),
    rels: new Map()
  };
  const fronts = (list) => {
    const G = graphOf(nodes, list);
    const { blds } = prepareBuildings(walls, BOX, TAGS);
    const index = new BuildingIndex(blds);
    setFronts(blds, new RoadIndex(G.edges), index);
    return { n: G.edges.length, front: Array.from(blds[0].front) };
  };
  const whole = fronts(bend({}));
  const cut = fronts(bend({ lanes: '4' }));
  assert.equal(whole.n, 1);
  assert.equal(cut.n, 2);
  assert.deepEqual(cut.front, whole.front);
  assert.ok(whole.front.filter((f) => f > 0).length >= 2, 'the wall facing the far stretch counts too');
});

/** Two ways meeting at a pass-through node, with a stop on the west one, for the kerb buffer tests. */
function kerbScene(digitizeEastWayBackwards) {
  const G = graphOf({ 1: [-100, 0], 2: [0, 0], 3: [100, 0] }, [
    way(1, [1, 2], { name: 'Long', lanes: '2' }),
    way(2, digitizeEastWayBackwards ? [3, 2] : [2, 3], { name: 'Long', lanes: '4' })
  ]);
  assert.equal(G.edges.length, 2);
  assert.equal(G.juncs[G.edges[0].jb].kind, KIND.PASS);
  return G;
}

test('a stop near a way boundary paints the curb past it, on its own side of the road', () => {
  for (const backwards of [false, true]) {
    const G = kerbScene(backwards);
    const [west, east] = G.edges;
    const westAlong = west.pts[0] < west.pts[2];
    const dir = westAlong ? 0 : 1;
    const s = westAlong ? 950 : 50;
    const rows = buildKerbs(G.edges, G.juncs, [], [{ edge: west.id, dir, s, x: -50, y: -30, name: 'Stop' }], PARKING);
    const eastAlong = east.pts[0] < east.pts[2];
    const south = eastAlong ? 1 : 0;
    const north = 1 - south;
    const near = (side) => rows.filter((k) => k.edge === east.id && k.side === side && k.paint === PARKING.paint.red_yellow);
    assert.equal(near(north).length, 0, 'the stop is on the south curb only');
    assert.equal(near(south).length, 1, `backwards ${backwards}`);
    const [r] = near(south);
    assert.equal(r.tier, 255);
    assert.equal(r.s1 - r.s0, 100, '15 m buffer, 5 m of it before the boundary');
    assert.equal(eastAlong ? r.s0 : r.s1, eastAlong ? 0 : 1000);
  }
});

test('a crossing near a way boundary buffers both curbs past it, and a real junction stops the buffer', () => {
  const G = kerbScene(false);
  const [west, east] = G.edges;
  const s = west.pts[0] < west.pts[2] ? 990 : 10;
  const rows = buildKerbs(G.edges, G.juncs, [{ edge: west.id, s, x: -1, y: 0, signal: false }], [], PARKING);
  for (const side of [0, 1]) {
    const atBoundary = east.pts[0] === 0 ? (k) => k.s0 === 0 : (k) => k.s1 === 1000;
    const spill = rows.filter((k) => k.edge === east.id && k.side === side && k.tier === 255 && atBoundary(k));
    assert.equal(spill.length, 1, `side ${side}`);
    assert.equal(spill[0].s1 - spill[0].s0, 40);
  }
  const T = graphOf({ 1: [-100, 0], 2: [0, 0], 3: [100, 0], 4: [0, 100] }, [
    way(1, [1, 2], {}), way(2, [2, 3], {}), way(3, [2, 4], {})
  ]);
  const e = T.edges[0];
  const atJunction = e.pts[0] < e.pts[2] ? 990 : 10;
  const none = buildKerbs(T.edges, T.juncs, [{ edge: e.id, s: atJunction, x: -1, y: 0, signal: false }], [], PARKING);
  assert.ok(T.edges.slice(1).every((q) => !none.some((k) => k.edge === q.id && k.paint === 0 && k.tier === 255 && k.s1 - k.s0 === 40)));
});

/** A motorway on the line x = 0 and an east-west road across it at `crossY`, as `buildWalls` sees them. */
function fenceScene(motorways, nodeSpec, crossY) {
  const nodes = nodesOf({ ...nodeSpec, 90: [-100, crossY], 91: [100, crossY] });
  const road = way(90, [90, 91], {});
  const osm = { nodes, ways: new Map([...motorways.map((w) => [w.id, w]), [90, road]]), rels: new Map() };
  const G = graphOf({ 90: [-100, crossY], 91: [100, crossY] }, [road]);
  for (const e of G.edges) e.lanesF = 1;
  return buildWalls(osm, BOX, G.edges, new RoadIndex(G.edges));
}

/** Least distance in metres from any fence vertex or segment to a point on the crossing. */
function fenceClear(w, crossY) {
  let best = Infinity;
  for (const row of w.walls) {
    if (row.kind !== WALL.MOTORWAY_FENCE) continue;
    for (let i = 2; i < row.pts.length; i += 2) {
      const y0 = row.pts[i - 1] / 10;
      const y1 = row.pts[i + 1] / 10;
      const inside = crossY >= Math.min(y0, y1) && crossY <= Math.max(y0, y1);
      best = Math.min(best, inside ? 0 : Math.abs(y0 - crossY), inside ? 0 : Math.abs(y1 - crossY));
    }
  }
  return best;
}

const motorway = (id, nodes) => ({ type: 'way', id, nodes, tags: { highway: 'motorway' } });

test('a fence gap runs on past the end of the OSM way it starts on', () => {
  // Half-gap is (3 m lane + 3 m clearance) = 6 m, and the way ends 2 m from the crossing.
  const w = fenceScene([motorway(10, [1, 2]), motorway(11, [2, 3])], { 1: [0, -100], 2: [0, 2], 3: [0, 100] }, 0);
  assert.ok(Math.abs(fenceClear(w, 0) - 6) < 0.2, `${fenceClear(w, 0)}`);
  assert.equal(w.stats.fenceCuts, 1);
});

test('a fence gap runs through a short way into the one after it', () => {
  const w = fenceScene([motorway(10, [1, 2]), motorway(11, [2, 3]), motorway(12, [3, 4])],
    { 1: [0, -100], 2: [0, 1], 3: [0, 3], 4: [0, 100] }, 0);
  assert.ok(Math.abs(fenceClear(w, 0) - 6) < 0.2, `${fenceClear(w, 0)}`);
});

test('a fence gap runs into both ways of a fork', () => {
  const w = fenceScene([motorway(10, [1, 2]), motorway(11, [2, 3]), motorway(12, [2, 4])],
    { 1: [0, -100], 2: [0, 2], 3: [40, 100], 4: [-40, 100] }, 0);
  for (const row of w.walls.filter((r) => r.kind === WALL.MOTORWAY_FENCE)) {
    for (let i = 0; i < row.pts.length; i += 2) {
      assert.ok(Math.hypot(row.pts[i], row.pts[i + 1]) / 10 >= 5.8, `fence at ${row.pts[i]}, ${row.pts[i + 1]}`);
    }
  }
});

test('a fence gap on a way that ends at the box stops there', () => {
  const w = fenceScene([motorway(10, [1, 2])], { 1: [0, -100], 2: [0, 2] }, 0);
  const rows = w.walls.filter((r) => r.kind === WALL.MOTORWAY_FENCE);
  assert.equal(rows.length, 1);
  assert.ok(Math.max(...rows[0].pts.filter((_, i) => i % 2)) <= -60);
});

test('a dropped portal stub leaves a dead end flagged, and a through street unflagged', () => {
  const box = { minX: -2000, minY: -2000, maxX: 2000, maxY: 2000 };
  const run = (spec, ways) => {
    const nodes = nodesOf(spec);
    const osm = { nodes, ways: new Map(ways.map((w) => [w.id, w])), rels: new Map() };
    const G = buildGraph(clipRoads(filterRoads(osm).ways, nodes, box).pieces, nodes);
    mergeJunctions(G);
    finishGraph(G);
    return G;
  };
  // Way 1 ends 2 m inside the inset line, and way 2 runs on out of the box: its stretch inside is under 8 m.
  const dead = run({ 1: [-50, 0], 2: [192, 0], 3: [260, 0] }, [way(1, [1, 2], { name: 'In' }), way(2, [2, 3], { name: 'Stub', lanes: '4' })]);
  assert.equal(dead.edges.length, 1);
  const end = dead.juncs.filter((j) => j.flags & JF.DEAD_END);
  assert.equal(end.length, 2);
  assert.equal(end.filter((j) => j.flags & JF.PORTAL).length, 1, 'the road leaves the box here, so a barrier belongs at this end');
  const through = run({ 1: [-50, 50], 2: [192, 50], 3: [-50, -50], 4: [192, -50], 5: [192, 0], 6: [260, 0] }, [
    way(1, [1, 2, 5, 4, 3], { name: 'Bend' }),
    way(2, [5, 6], { name: 'Stub' })
  ]);
  assert.equal(through.juncs.filter((j) => j.flags & JF.PORTAL).length, 0, 'a through street has no dead end to bar');
});

/** A way POI with its own footprint, 20 m square at the origin, and a second building 40 m east. */
function movedScene() {
  const G = graphOf({ 1: [-100, 20], 2: [100, 20], 3: [-100, 400], 4: [100, 400] }, [way(1, [1, 2], { name: 'Main' }), way(2, [3, 4], { name: 'Far' })]);
  const osm = {
    nodes: nodesOf({
      100: [-10, -10], 101: [10, -10], 102: [10, 10], 103: [-10, 10],
      110: [40, -10], 111: [60, -10], 112: [60, 10], 113: [40, 10]
    }),
    ways: new Map([
      [50, { type: 'way', id: 50, nodes: [100, 101, 102, 103, 100], tags: { building: 'yes' } }],
      [51, { type: 'way', id: 51, nodes: [110, 111, 112, 113, 110], tags: { building: 'yes' } }]
    ]),
    rels: new Map()
  };
  const { blds } = prepareBuildings(osm, BOX, TAGS);
  const index = new BuildingIndex(blds);
  const roads = new RoadIndex(G.edges);
  setFronts(blds, roads, index);
  const other = blds.find((b) => b.osm === 51).id + 1;
  const own = blds.find((b) => b.osm === 50).id + 1;
  return { blds, index, roads, other, own };
}

/** Applies a `poi.move` through the real overlay code. */
function moveTo(x, y) {
  const proj = makeProjection([32.075, 34.7775]);
  const p = { ...poiAt(0, 0), osm: 50, osmT: 1 };
  const at = [y / 110888 + 32.075, x / 94415 + 34.7775];
  applyPois([{ op: 'poi.move', anchor: { osm: 'w50' }, at, why: 'test', source: 't[0]' }], [p],
    { anchors: TLV.anchors, proj, origin: [32.075, 34.7775] });
  return p;
}

test('poi.move takes a way POI off its own footprint, onto the wall at the new position', () => {
  const { blds, index, roads, other } = movedScene();
  const [p] = bindFacades([moveTo(50, 0)], blds, index, roads, TLV.anchors.normalizeName).pois;
  assert.equal(p.bld, other);
  assert.ok(p.wall > 0);
  assert.ok(Math.hypot(p.entX / 10 - 50, p.entY / 10) < 15, `door at ${p.entX}, ${p.entY}`);
});

test('poi.move inside its own footprint keeps that footprint', () => {
  const { blds, index, roads, own } = movedScene();
  const [p] = bindFacades([moveTo(5, 5)], blds, index, roads, TLV.anchors.normalizeName).pois;
  assert.equal(p.bld, own);
});

test('a way POI that was not moved keeps its own footprint even with its centroid outside it', () => {
  const { blds, index, roads, own } = movedScene();
  const [p] = bindFacades([{ ...poiAt(50, 0), osm: 50, osmT: 1 }], blds, index, roads, TLV.anchors.normalizeName).pois;
  assert.equal(p.bld, own);
});

test('poi.move out onto open ground has no host and snaps to the sidewalk there', () => {
  const { blds, index, roads } = movedScene();
  const [p] = bindFacades([moveTo(0, 200)], blds, index, roads, TLV.anchors.normalizeName).pois;
  assert.equal(p.bld, 0);
  assert.ok(p.flags & POIF.NO_FACADE);
  assert.ok(Math.abs(p.entX) < 20 && p.entY > 200 && p.entY < 300 && Math.abs(p.entY - 200) < 100, `door at ${p.entX}, ${p.entY}`);
});

/** Edges for the `kerb.set` tests: a three-edge way and a neighbouring way of the same name beside it. */
function curbScene() {
  const list = (way2, id, x0, x1) => ({
    id, way: way2, name: 'Same St', nameEn: '', pts: [x0 * 10, 0, x1 * 10, 0], lenDm: Math.abs(x1 - x0) * 10
  });
  const edges = [list(7, 0, 0, 100), list(7, 1, 100, 200), list(7, 2, 200, 300), list(8, 3, 300, 340)];
  const kerbs = edges.flatMap((e) => [0, 1].map((side) => ({ edge: e.id, side, s0: 0, s1: e.lenDm, form: 0, paint: 0, zone: '', tier: 3 })));
  return { edges, kerbs };
}

test('kerb.set on a moved anchor stays on one way, and takes the whole of it', () => {
  const { edges, kerbs } = curbScene();
  const ctx = { anchors: TLV.anchors, origin: [32.075, 34.7775] };
  const at = [32.075, 310 / 94415 + 34.7775];
  const op = (anchor) => [{ op: 'kerb.set', anchor, side: 'both', set: { paint: 1 }, why: 'test', source: 't[0]' }];
  const moved = applyKerbs(op({ osm: 'w999', at, name: 'Same St' }), kerbs, edges, ctx);
  assert.equal(moved.orphans[0].how, 'moved');
  assert.deepEqual([...new Set(moved.kerbs.filter((k) => k.tier === 0).map((k) => k.edge))], [3], 'at the row nearest the point, way 8 only');
  const far = applyKerbs(op({ osm: 'w999', at: [32.075, 150 / 94415 + 34.7775], name: 'Same St' }), kerbs, edges, ctx);
  assert.deepEqual([...new Set(far.kerbs.filter((k) => k.tier === 0).map((k) => k.edge))], [0, 1, 2], 'all of way 7, as an exact anchor gets');
  const exact = applyKerbs(op({ osm: 'w7' }), kerbs, edges, ctx);
  assert.equal(far.kerbs.filter((k) => k.tier === 0).length, exact.kerbs.filter((k) => k.tier === 0).length);
});

test('access=no with motor_vehicle=yes is a car street, and the other blocks still hold', () => {
  const kept = (t) => filterRoads({ ways: new Map([[1, way(1, [1, 2], t)]]) }).ways.length;
  assert.equal(kept({ access: 'no', motor_vehicle: 'yes' }), 1);
  assert.equal(kept({ access: 'private', motor_vehicle: 'permissive' }), 1);
  assert.equal(kept({ access: 'no' }), 0);
  assert.equal(kept({ access: 'no', motor_vehicle: 'no' }), 0);
  assert.equal(kept({ access: 'yes', motor_vehicle: 'no' }), 0);
  assert.equal(kept({ motor_vehicle: 'private' }), 0);
});

test('a planning number is no street name', () => {
  const G = graphOf({ 1: [0, 0], 2: [100, 0], 3: [200, 0] }, [way(1, [1, 2], { name: '1285' }), way(2, [2, 3], { name: 'Dizengoff', 'name:en': '12' })]);
  assert.deepEqual(G.edges.map((e) => [e.name, e.nameEn]), [['', ''], ['Dizengoff', '']]);
});

test('pass 6: a tagged way joins what it crosses at grade, and nothing is cut', () => {
  const spec = { 1: [-100, 0], 2: [100, 0], 3: [0, -100], 4: [0, 100], 5: [-200, 0], 6: [200, 0] };
  const nodes = nodesOf(spec);
  const lower = { highway: 'residential' };
  const higher = { highway: 'primary' };
  const pieces = (tag) => [
    { way: 1, tags: tag, nodes: [5, 1, 2, 6], oneway: false },
    { way: 2, tags: higher, nodes: [3, 4], oneway: false }
  ];
  const cut = gradeSeparate(pieces(lower), nodes, TAGS.classOrder);
  assert.equal(cut.joined, 0);
  assert.equal(cut.pieces.length, 3, 'the old rule: the lower road loses its crossing segment');
  const joined = gradeSeparate(pieces({ ...lower, 'tlv:at_grade': 'yes' }), nodesOf(spec), TAGS.classOrder);
  assert.equal(joined.joined, 1);
  assert.equal(joined.removedKm, 0);
  assert.equal(joined.pieces.length, 2);
  const [a, b] = joined.pieces;
  assert.equal(a.nodes.length, 5);
  assert.equal(b.nodes.length, 3);
  assert.equal(a.nodes[2], b.nodes[1], 'both roads hold the same new node');
});

test('pass 6: two crossings on one long segment come in travel order', () => {
  const nodes = nodesOf({ 1: [-100, 0], 2: [100, 0], 3: [-50, -100], 4: [-50, 100], 5: [50, -100], 6: [50, 100] });
  const r = gradeSeparate([
    { way: 1, tags: { highway: 'tertiary', 'tlv:at_grade': 'yes' }, nodes: [1, 2], oneway: true },
    { way: 2, tags: { highway: 'primary' }, nodes: [3, 4], oneway: true },
    { way: 3, tags: { highway: 'primary' }, nodes: [5, 6], oneway: true }
  ], nodes, TAGS.classOrder);
  const xs = r.pieces[0].nodes.map((id) => nodes.get(id).x);
  assert.deepEqual(xs, xs.slice().sort((p, q) => p - q));
  assert.equal(xs.length, 4);
});

test('the U-turn ban sees through a bend just before the junction', () => {
  // Over 10 m this turn reads 148 degrees, which passes. Over 30 m it reads 175, the U-turn it is.
  const spec = { 1: [-100, 0], 2: [-11, 0], 3: [0, 3], 4: [-20, 9], 5: [-100, 9], 6: [100, 3] };
  const G = graphOf(spec, [
    way(1, [1, 2, 3], { oneway: 'yes' }), way(2, [3, 4, 5], { oneway: 'yes' }), way(3, [3, 6], { oneway: 'yes' })
  ]);
  const into = G.edges.find((e) => e.way === 1).id * 2;
  const back = G.edges.find((e) => e.way === 2).id * 2;
  const on = G.edges.find((e) => e.way === 3).id * 2;
  assert.ok(G.moves.some((m) => m.from === into && m.to === on));
  assert.ok(!G.moves.some((m) => m.from === into && m.to === back));
});

test('narrow streets keep their lanes: pass 10 stops at 24 m there, and still reaches 50 m on a wider road', () => {
  const spec = {
    1: [-200, 0], 2: [0, 0], 3: [15, 0], 4: [30, 0], 5: [200, 0], 6: [0, 200], 7: [15, -200], 8: [30, 200]
  };
  const streets = (tags) => [way(1, [1, 2, 3, 4, 5], tags), way(2, [6, 2], {}), way(3, [7, 3], {}), way(4, [8, 4], {})];
  const narrow = graphOf(spec, streets({}));
  assert.equal(Math.max(...narrow.juncs.map((j) => j.members.length)), 2, 'the third corner stays a street corner');
  assert.ok(narrow.edges.some((e) => e.way === 1 && e.a !== e.b && e.lenDm <= 150));
  const wide = graphOf(spec, streets({ highway: 'tertiary' }));
  assert.equal(Math.max(...wide.juncs.map((j) => j.members.length)), 3);
});

test('a ring keeps its island: every arm reaches every exit by circulating', () => {
  const r = 20;
  const G = graphOf({ 1: [r, 0], 2: [0, r], 3: [-r, 0], 4: [0, -r], 5: [r + 100, 0], 6: [0, r + 100], 7: [-r - 100, 0], 8: [0, -r - 100] }, [
    way(1, [1, 2, 3, 4, 1], { junction: 'roundabout' }),
    way(2, [5, 1], {}), way(3, [6, 2], {}), way(4, [7, 3], {}), way(5, [8, 4], {})
  ]);
  const arcs = G.edges.filter((e) => e.ring);
  assert.equal(arcs.length, 4);
  for (const a of arcs) {
    const next = G.moves.filter((m) => m.from === a.id * 2 && G.edges[m.to >> 1].ring);
    assert.equal(next.length, 1, 'one way on round');
    const ins = G.moves.filter((m) => m.to === a.id * 2 && !G.edges[m.from >> 1].ring);
    assert.equal(ins.length, 1, 'one arm enters each arc');
  }
  assert.ok(connectivity(G).share > 0.99);
});

test('clipRingLeft keeps the left of a line and trims a tip', () => {
  const square = [0, 0, 100, 0, 100, 100, 0, 100];
  assert.equal(Math.abs(ringArea(clipRingLeft(square, [0, 40, 100, 40]))), 6000);
  assert.equal(Math.abs(ringArea(clipRingLeft(square, [100, 40, 0, 40]))), 4000);
  assert.deepEqual(clipRingLeft(square, [0, -10, 100, -10]), square);
  assert.deepEqual(clipRingLeft(square, [100, -10, 0, -10]), []);
});

test('building.clip trims the footprint, and building=roof is no wall', (t) => {
  const nodes = [[1, 0, 0], [2, 0, 0.001], [3, 0.001, 0.001], [4, 0.001, 0]];
  const osm = loadExtract(t, [
    ...nodes.map(([id, dLat, dLon]) => ({ type: 'node', id, lat: 32.075 + dLat, lon: 34.7775 + dLon })),
    { type: 'way', id: 9, nodes: [1, 2, 3, 4, 1], tags: { building: 'yes' } },
    { type: 'way', id: 10, nodes: [1, 2, 3, 4, 1], tags: { building: 'roof' } }
  ]);
  const proj = makeProjection([32.075, 34.7775]);
  for (const n of osm.nodes.values()) {
    n.x = proj.x(n.lon);
    n.y = proj.y(n.lat);
  }
  const before = prepareBuildings(osm, BOX, TAGS).blds.find((b) => b.osm === 9);
  const south = 32.0755;
  const orphans = applyPre([{
    op: 'building.clip',
    anchor: { osm: 'w9' },
    line: [[south, 34.7785], [south, 34.7775]],
    why: 'Test: a road takes the south half',
    source: 't[0]'
  }], osm, { anchors: TLV.anchors, proj, origin: [32.075, 34.7775] });
  assert.deepEqual(orphans, []);
  const { blds } = prepareBuildings(osm, BOX, TAGS);
  const after = blds.find((b) => b.osm === 9);
  assert.ok(Math.abs(Math.abs(ringArea(after.rings[0])) * 2 - Math.abs(ringArea(before.rings[0]))) < 5000);
  assert.equal(after.roofOnly, false);
  assert.equal(blds.find((b) => b.osm === 10).roofOnly, true);
  const index = new BuildingIndex(blds);
  const stats = crossSection([], [], index, TAGS, PARKING);
  assert.equal(stats.roofs, 1);
  assert.equal(blds.find((b) => b.osm === 10).noCollider, true);
  assert.equal(blds.find((b) => b.osm === 9).noCollider, false);
});

test('a building.clip with no line is an error, not a skipped edit', () => {
  assert.throws(() => applyPre([{ op: 'building.clip', anchor: { osm: 'w9' }, why: 'x', source: 't' }], { ways: new Map(), nodes: new Map(), rels: new Map() }, {}), /needs a line/);
});

/** What `laneContacts` reads of the runtime: distance to a segment, and lanes within reach of a point. */
function fakeRuntime() {
  const pointSegDist = (x, y, ax, ay, bx, by) => {
    const dx = bx - ax;
    const dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(x - ax - dx * t, y - ay - dy * t);
  };
  const lanesNear = (W, x, y, r, out) => {
    let n = 0;
    for (const l of W.lanes) if (pointSegDist(x, y, l.px[0], l.py[0], l.px[1], l.py[1]) <= r) out[n++] = l.id;
    return n;
  };
  return { const: { LF: { AI_ROUTABLE: 1 } }, math: { pointSegDist }, world: { lanes: { lanesNear } } };
}

/** A decoded map of two straight parallel roads, for the overlap gate. */
function twoRoads(gap, rows = {}) {
  const pts = { x: [0, 1000, 0, 1000], y: [0, 0, gap, gap] };
  const juncs = { x: [0, 1000, 0, 1000], y: [0, 0, gap, gap], kind: [1, 1, 1, 1], flags: [0, 0, 0, 0] };
  const edges = {
    a: [0, 2], b: [1, 3], ptOff: [0, 2, 4], cls: [1, 1], lanesF: [2, 2], lanesB: [0, 0], laneW: [33, 33], parkL: [0, 0], parkR: [0, 0],
    swL: [0, 0], swR: [0, 0], flags: [0, 0], name: [0, 0], nameEn: [0, 0], osm: [1, 2], ...rows
  };
  return { strings: ['', 'x'], t: { edges: { n: 2, col: edges }, pts: { n: 4, col: pts }, juncs: { n: 4, col: juncs } } };
}

test('the overlap gate measures lanes on the decoded map', () => {
  const close = carriagewayOverlaps(twoRoads(50));
  assert.equal(close.length, 1);
  assert.deepEqual(close[0].ways, [1, 2]);
  assert.equal(close[0].allowed, false);
  assert.ok(close[0].m > 50);
  assert.equal(close[0].opposite, false);
  assert.deepEqual(carriagewayOverlaps(twoRoads(70)), [], 'two 6.6 m carriageways 7 m apart clear each other');
  assert.equal(carriagewayOverlaps(twoRoads(50), [{ ways: [2, 1] }])[0].allowed, true);
  // The second road run the other way is an opposing pair.
  const back = twoRoads(50);
  back.t.edges.col.a = [0, 3];
  back.t.edges.col.b = [1, 2];
  back.t.pts.col.x = [0, 1000, 1000, 0];
  assert.equal(carriagewayOverlaps(back)[0].opposite, true);
});

test('on a built World the overlap gate reads lanes where they end, and allows a fork 6 m, not the 8 m it allows a stop line', () => {
  // Two lanes leave one junction 1 m apart, side by side to x, then part at 30 deg. From x = 6 they stay inside paint for 6 m past
  // the 6 m allowance and 2 m past 8 m, under the 4 m run a pair needs, so 8 m would pass them.
  const line = (pts) => {
    const px = Float32Array.from(pts, (p) => p[0]);
    const py = Float32Array.from(pts, (p) => p[1]);
    return { px, py };
  };
  const world = (x) => ({
    lanes: [
      { id: 0, edge: 0, dirEdge: 0, ...line([[0, 0], [40, 0]]) },
      { id: 1, edge: 1, dirEdge: 2, ...line([[0, 1], [x, 1], [x + 40, 1 + 40 * Math.tan(Math.PI / 6)]]) }
    ]
  });
  const d = twoRoads(10, { a: [0, 0], b: [1, 3] });
  d.t.edges.col.laneW = [30, 30];
  assert.equal(carriagewayOverlaps(d, [], world(6)).length, 1);
  assert.deepEqual(carriagewayOverlaps(d, [], world(3)), [], 'clear of paint by 6 m');
});

test('a lane contact counts at a lane end, skips lanes a car drives between, and needs an AI lane', () => {
  const TLV = fakeRuntime();
  const lane = (id, edge, x0, y0, x1, y1, flags = 1, conns = []) => ({
    id, edge, flags, conns: Int32Array.from(conns), px: Float32Array.of(x0, x1), py: Float32Array.of(y0, y1), cum: Float32Array.of(0, Math.hypot(x1 - x0, y1 - y0))
  });
  const edges = [{ osm: 11, nameEn: 'A' }, { osm: 12, nameEn: 'B' }, { osm: 13, nameEn: 'C' }];
  const side = { edges, conns: [], lanes: [lane(0, 0, 0, 0, 10, 0), lane(1, 1, 0, 1, 10, 1)] };
  const rows = laneContacts(TLV, side);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].ways, [11, 12]);
  assert.equal(rows[0].min, 1);
  assert.ok(rows[0].m >= 10);
  assert.equal(laneContacts(TLV, side, [{ ways: [12, 11] }])[0].allowed, true);
  const noAi = { edges, conns: [], lanes: [lane(0, 0, 0, 0, 10, 0, 0), lane(1, 1, 0, 1, 10, 1, 0)] };
  assert.deepEqual(laneContacts(TLV, noAi), [], 'no AI car can stand on either');
  const tail = { edges, conns: [{ to: 1 }], lanes: [lane(0, 0, 0, 0, 10, 0, 1, [0]), lane(1, 1, 10, 0, 20, 0)] };
  assert.deepEqual(laneContacts(TLV, tail), [], 'head to tail is one road');
  const apart = { edges, conns: [], lanes: [lane(0, 0, 0, 0, 10, 0), lane(1, 1, 0, 1.9, 10, 1.9)] };
  assert.deepEqual(laneContacts(TLV, apart), [], '1.9 m clears a 1.8 m car');
});

test('pass 13 spreads carriageways where the ground is free, and takes width and lanes where it is not', () => {
  const dual = (clear) => {
    const spec = { 1: [0, 0], 2: [300, 0], 3: [300, 5], 4: [0, 5], 5: [-100, 0], 6: [-100, 5], 7: [400, 0], 8: [400, 5] };
    const G = graphOf(spec, [
      way(1, [5, 1, 2, 7], { highway: 'secondary', oneway: 'yes', lanes: '2' }),
      way(2, [8, 3, 4, 6], { highway: 'secondary', oneway: 'yes', lanes: '2' })
    ]);
    const blds = clear ? [] : [
      { rings: [[0, -40, 3000, -40, 3000, -30, 0, -30]] },
      { rings: [[0, 80, 3000, 80, 3000, 90, 0, 90]] }
    ].map((b, id) => ({ ...b, id, osm: id, cx: 0, cy: 0 }));
    const index = new BuildingIndex(blds);
    const moved = separateCarriageways(G, [], index, TAGS);
    crossSection(G.edges, G.juncs, index, TAGS, PARKING);
    return { G, moved };
  };
  const free = dual(true);
  assert.ok(free.moved.nodes > 0);
  const gapOf = (G) => Math.abs(G.edges[0].pts[1] - G.edges[1].pts[1]);
  assert.ok(gapOf(free.G) >= 56, `spread to ${gapOf(free.G)} dm`);
  assert.deepEqual(free.G.edges.map((e) => e.lanesF), [2, 2]);
  assert.ok(free.G.edges.every((e) => e.laneW >= 28));
  const shut = dual(false);
  const half = (e) => (e.lanesF * e.laneW) / 2;
  assert.ok(gapOf(shut.G) >= half(shut.G.edges[0]) + half(shut.G.edges[1]) - 1, 'whatever happened, the lanes fit');
  assert.ok(shut.G.edges.every((e) => e.parkL === 0 && e.parkR === 0 || e.lanesF >= 1));
});
