// tests/map/overlay.test.mjs — overlays through the whole importer, ARCHITECTURE section 19 WP-MAP item 4, plus the diff that
// proves it. Every run writes to a temporary directory.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { runImport } from '../../tools/import.mjs';
import { enc, mapScript } from '../../tools/lib/encode.mjs';
import { fenceLines } from '../../tools/lib/land.mjs';
import { boxOf, loadSources, makeProjection, nearestOnSeg, projectNodes } from '../../tools/lib/osm.mjs';
import { diffMaps, readMapPayload, verifyMap } from '../../tools/lib/report.mjs';
import { ROOT, decodeFile, edgeLine, report, rows, runImporter, runtime, tempDir } from './helpers.mjs';

const TLV = await runtime();
const SHIPPED = path.join(ROOT, 'data/maps/tlv_center/map.js');
const ORIGIN = [32.075, 34.7775];
const CONCURRENT = 8;
const MIN_EDGE_DM = 30;
const mapOf = (out, id = 'tlv_center') => path.join(out, 'data/maps', id, 'map.js');
const latLon = (x, y) => [y / 110888 + ORIGIN[0], x / 94415 + ORIGIN[1]];

/** The raw extract, projected. */
function rawExtract() {
  const osm = loadSources(path.join(ROOT, 'tools/cache'), ['tlv_center']);
  projectNodes(osm.nodes, makeProjection(ORIGIN));
  return osm;
}

/** Runs the importer with one overlay against the shipped map, without blocking the other runs of a sweep. */
function importWith(t, way, lanes) {
  const out = tempDir(t);
  const overlays = tempDir(t);
  fs.mkdirSync(path.dirname(mapOf(out)), { recursive: true });
  fs.copyFileSync(SHIPPED, mapOf(out));
  // The shipped overlays stay in, or the diff against the shipped map would be all about them.
  fs.copyFileSync(path.join(ROOT, 'tools/overlays/tlv_center/roads.json'), path.join(overlays, 'roads.json'));
  fs.writeFileSync(path.join(overlays, 'test.json'), JSON.stringify([
    { op: 'road.set', anchor: { osm: `w${way}` }, set: { lanes }, why: 'Test: tag out of date' }
  ]));
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [path.join(ROOT, 'tools/import.mjs'), 'tlv_center', '--out', out, '--overlays', overlays]);
    let log = '';
    c.stdout.on('data', (b) => { log += b; });
    c.stderr.on('data', (b) => { log += b; });
    c.on('close', (code) => resolve({ way, code, log, out }));
  });
}

/** Runs tasks with a concurrency limit. */
async function pool(items, run) {
  const results = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await run(items[i]);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENT }, worker));
  return results;
}

/** Positions of a raw way's nodes, as the keys in `diff.json` write them. */
function ownPoints(w, nodes) {
  return new Set(w.nodes.filter((id) => nodes.has(id)).map((id) => `${nodes.get(id).x},${nodes.get(id).y}`));
}

/**
 * True for a point of a way, or within 3 m of one. A stretch under 3 m cannot hold a lane, so pass 7 folds it into the edge
 * beside it whatever its tags, and it takes that edge's section.
 */
function onWay(own, key) {
  if (own.has(key)) return true;
  const [x, y] = key.split(',').map(Number);
  return [...own].some((p) => {
    const [a, b] = p.split(',').map(Number);
    return Math.hypot(a - x, b - y) <= MIN_EDGE_DM;
  });
}

/** Row of one table by OSM identity, from its `nwr` key. */
function rowOf(d, table, key) {
  const t = 'nwr'.indexOf(key[0]);
  const id = Number(key.slice(1));
  return rows(d, table).find((r) => r.osm === id && r.osmT === t);
}

/** Outer-ring `front` of a building row. */
function frontsOf(d, b) {
  const { pOff } = d.t.brings.col;
  const r = b.rOff;
  return Array.from(d.t.bpts.col.front.slice(pOff[r], pOff[r + 1]));
}

/**
 * Item 4, as far as the contract allows it to hold: one way's cross-section changes, and nothing else on the ground does.
 * A way that shared an edge with a neighbour must get an edge of its own, by pass 7, and that leaves three named side effects:
 * a `PASS` junction and its moves at the boundary, and the neighbour's own edge label. D18 in the report.
 */
function assertOnlyThatWay(run, before, raw) {
  const { way, out } = run;
  const label = `w${way}`;
  const own = ownPoints(raw.ways.get(way), raw.nodes);
  const diff = report(out, 'tlv_center', 'diff');
  const after = decodeFile(TLV, mapOf(out));
  assert.equal(diff.firstRun, false, label);
  assert.deepEqual(diff.flagged, [], label);
  for (const key of ['pts', 'kerbs']) {
    for (const k of [...diff.rows[key].added, ...diff.rows[key].removed, ...diff.rows[key].changed]) {
      for (const p of k.split(':')[0].split('>')) assert.ok(onWay(own, p), `${label}: ${key} ${k} is not on this way`);
    }
  }
  assert.deepEqual(diff.rows.touched.filter((w) => w !== label), [], `${label}: touched`);
  for (const key of ['stops', 'xings', 'walls']) {
    assert.deepEqual(diff.rows[key], { added: [], removed: [], changed: [] }, `${label}: ${key}`);
  }
  assert.deepEqual(diff.rows.other, [], `${label}: other tables`);
  assert.deepEqual(diff.rows.juncs.changed, [], `${label}: junction kinds`);
  for (const k of [...diff.rows.juncs.added, ...diff.rows.juncs.removed]) assert.ok(own.has(k), `${label}: junction ${k} is not on this way`);
  assert.deepEqual(diff.rows.moves.changed, [], `${label}: turn codes`);
  for (const k of [...diff.rows.moves.added, ...diff.rows.moves.removed]) {
    const c = k.split('>')[0].split(',');
    assert.ok(own.has(`${c[2]},${c[3]}`), `${label}: move ${k} is not at a split on this way`);
  }
  for (const k of diff.rows.buildings.changed) {
    const a = rowOf(before, 'blds', k);
    const b = rowOf(after, 'blds', k);
    assert.deepEqual({ ...a, id: 0, flags: 0, rOff: 0, name: 0, nameEn: 0, colour: 0, style: 0 }, { ...b, id: 0, flags: 0, rOff: 0, name: 0, nameEn: 0, colour: 0, style: 0 }, `${label}: ${k}`);
    assert.deepEqual(frontsOf(before, a), frontsOf(after, b), `${label}: ${k} fronts`);
    assert.equal(a.flags ^ b.flags, 1, `${label}: only NO_COLLIDER may change on ${k}, because lanes now reach it`);
  }
  for (const k of diff.rows.pois.changed) {
    const a = rowOf(before, 'pois', k);
    const b = rowOf(after, 'pois', k);
    assert.ok(a.flags & 8 && b.flags & 8, `${label}: only a door with no facade stands on this way's sidewalk: ${k}`);
    assert.deepEqual([a.x, a.y, a.wall, a.flags], [b.x, b.y, b.wall, b.flags], `${label}: ${k}`);
    assert.equal(after.t.edges.col.osm[b.edge - 1], way, `${label}: ${k}`);
  }
  return { diff, after };
}

const SWEEP = [
  133421378, // Touches nothing else.
  516954917, // Its contraction partner lost sidewalk width.
  1568684634, // The partner the other way round.
  204135831, // Flipped `front` on a building, and shifted a junction cluster by joining it.
  154735772, // The spawn road: the partner lost a bus stop's buffer.
  32604025, // A partner digitized against it: sides were mirrored.
  1235588980, // A partner that keeps its cross-section only as a chain.
  26422967, // A pinch on a partner, in the far half of the road.
  97838109, // Without its partner's section the service road beyond it read as a garage stub.
  938738472, // The same.
  174353028, // Lanes now reach a building, which goes hollow.
  288057426, // Six doors with no facade stand on this sidewalk.
  117192332, // Two more share one door.
  30350767,
  113965368
];

test('a lanes overlay changes one way on the ground, across a sweep of the awkward ones', async (t) => {
  const before = decodeFile(TLV, SHIPPED);
  const raw = rawExtract();
  const runs = await pool(SWEEP, (way) => importWith(t, way, 3));
  for (const run of runs) {
    assert.equal(run.code, 0, run.log);
    assertOnlyThatWay(run, before, raw);
  }
  const reach = (way) => report(runs[SWEEP.indexOf(way)].out, 'tlv_center', 'diff').rows;
  assert.deepEqual(reach(133421378).ways, { added: [], removed: [], changed: ['w133421378'] }, 'a way alone on its edges');
  assert.deepEqual(reach(133421378).buildings, { added: [], removed: [], changed: [] });
  assert.deepEqual(reach(133421378).pois, { added: [], removed: [], changed: [] });
  assert.deepEqual(reach(133421378).touched, ['w133421378']);
  assert.ok(reach(516954917).ways.added.includes('w1568684634') || reach(516954917).ways.changed.includes('w1568684634'), 'the partner has a row of its own now');
  assert.deepEqual(reach(516954917).touched, ['w516954917'], 'and nothing on the ground changed for it');
  // This one has a dual carriageway beside it with no room for three lanes, so the overlay gives way, and the report says so.
  const cut = report(runs[SWEEP.indexOf(288057426)].out, 'tlv_center', 'stats').section.overlayLanesReduced;
  assert.ok(cut.some((w) => w.way === 288057426 && w.from[0] === 3 && w.to[0] < 3), JSON.stringify(cut));
  assert.deepEqual(report(runs[SWEEP.indexOf(133421378)].out, 'tlv_center', 'stats').section.overlayLanesReduced.filter((w) => w.to[0] === 3), []);
});

test('a split-off neighbour reads exactly as before, side by side', async (t) => {
  const before = decodeFile(TLV, SHIPPED);
  const [run] = await pool([516954917], (way) => importWith(t, way, 3));
  assert.equal(run.code, 0, run.log);
  const after = decodeFile(TLV, mapOf(run.out));
  const raw = rawExtract();
  const partner = ownPoints(raw.ways.get(1568684634), raw.nodes);
  const steps = (d) => {
    const out = new Map();
    const e = d.t.edges.col;
    for (let i = 0; i < d.t.edges.n; i++) {
      const line = edgeLine(d, i).map(([x, y]) => `${Math.round(x * 10)},${Math.round(y * 10)}`);
      for (let k = 1; k < line.length; k++) {
        if (!partner.has(line[k - 1]) || !partner.has(line[k])) continue;
        const key = [line[k - 1], line[k]].sort().join('>');
        const lanes = [e.lanesF[i], e.lanesB[i]];
        const parks = [e.parkL[i], e.parkR[i]];
        const walks = [e.swL[i], e.swR[i]];
        out.set(key, { width: e.laneW[i], lanes, parks: parks.slice().sort(), walks: walks.slice().sort() });
      }
    }
    return out;
  };
  const a = steps(before);
  const b = steps(after);
  assert.ok(a.size >= 1);
  assert.deepEqual([...b.keys()].sort(), [...a.keys()].sort());
  for (const [k, v] of a) assert.deepEqual(b.get(k), v, k);
});

test('giving a way the same tags as its neighbour does not join them, so the neighbour stays as it was', async (t) => {
  const before = decodeFile(TLV, SHIPPED);
  const raw = rawExtract();
  const ways = [171266519, 204134164, 239616107, 547574390, 963722492];
  const runs = await pool(ways, (way) => importWith(t, way, 3));
  for (const run of runs) {
    assert.equal(run.code, 0, run.log);
    const { diff } = assertOnlyThatWay(run, before, raw);
    assert.deepEqual(diff.rows.juncs.removed, [], `w${run.way}: the boundary stays`);
  }
});

test('two ways that close a loop are the known limit: the split moves, but stays inside the pair', async (t) => {
  const raw = rawExtract();
  const pair = new Set([...ownPoints(raw.ways.get(31539823), raw.nodes), ...ownPoints(raw.ways.get(31539837), raw.nodes)]);
  const [run] = await pool([31539823], (way) => importWith(t, way, 3));
  assert.equal(run.code, 0, run.log);
  const diff = report(run.out, 'tlv_center', 'diff');
  for (const w of diff.rows.touched) assert.ok(['w31539823', 'w31539837'].includes(w), w);
  for (const key of ['pts', 'kerbs']) {
    for (const k of [...diff.rows[key].added, ...diff.rows[key].removed, ...diff.rows[key].changed]) {
      for (const p of k.split(':')[0].split('>')) assert.ok(pair.has(p), k);
    }
  }
});

test('diff.json sees a change in each table it watches', () => {
  const changed = (mutate) => {
    const next = decodeFile(TLV, SHIPPED);
    mutate(next);
    return diffMaps(decodeFile(TLV, SHIPPED), next).rows;
  };
  const size = (x) => x.added.length + x.removed.length + x.changed.length;
  assert.equal(changed((d) => { d.t.bpts.col.front[5] ^= 1; }).buildings.changed.length, 1);
  assert.equal(changed((d) => { d.t.juncs.col.kind[0] ^= 1; }).juncs.changed.length, 1);
  assert.equal(changed((d) => { d.t.moves.col.turn[0] = (d.t.moves.col.turn[0] + 1) % 3; }).moves.changed.length, 1);
  assert.equal(changed((d) => { d.t.stops.col.dir[0] ^= 1; }).stops.changed.length, 1);
  assert.equal(changed((d) => { d.t.xings.col.flags[0] ^= 1; }).xings.changed.length, 1);
  assert.ok(size(changed((d) => { d.t.pts.col.x[100] += 3; }).pts) >= 1);
  assert.equal(changed((d) => { d.t.edges.col.swL[10] += 1; }).pts.changed.length, edgeLine(decodeFile(TLV, SHIPPED), 10).length - 1);
  const long = rows(decodeFile(TLV, SHIPPED), 'kerbs').find((k) => k.s1 - k.s0 > 500);
  const kerbs = changed((d) => { d.t.kerbs.col.paint[long.id] = 2; }).kerbs;
  assert.ok(kerbs.changed.length >= 1);
  assert.equal(changed((d) => { d.t.walls.col.kind[6] ^= 1; }).walls.added.length, 1);
  assert.deepEqual(changed((d) => { d.t.trees.col.species[0] ^= 1; }).other, ['trees']);
  assert.deepEqual(changed((d) => { d.strings.push('unused'); }).other, []);
  const hostless = changed((d) => { d.t.pois.col.bld[0] = d.t.pois.col.bld[0] === 1 ? 2 : 1; });
  assert.equal(hostless.pois.changed.length, 1, 'a POI on another building counts');
});

test('a kerb row that shifts by rounding at a split is no change, a real stretch is', () => {
  const next = decodeFile(TLV, SHIPPED);
  const list = rows(next, 'kerbs');
  const i = list.findIndex((k, n) => n > 0 && list[n - 1].edge === k.edge && list[n - 1].side === k.side && k.s1 - k.s0 > 200 && list[n - 1].s1 - list[n - 1].s0 > 200);
  next.t.kerbs.col.s0[i] += 2;
  next.t.kerbs.col.s1[i - 1] += 2;
  assert.equal(diffMaps(decodeFile(TLV, SHIPPED), next).rows.kerbs.changed.length, 0);
  next.t.kerbs.col.s0[i] += 30;
  next.t.kerbs.col.s1[i - 1] += 30;
  assert.ok(diffMaps(decodeFile(TLV, SHIPPED), next).rows.kerbs.changed.length >= 1);
});

/** Imports with a POI overlay and returns the decoded map. */
function importOps(t, ops, args = []) {
  const out = tempDir(t);
  const overlays = tempDir(t);
  fs.writeFileSync(path.join(overlays, 'pois.json'), JSON.stringify(ops));
  const r = runImporter(['tlv_center', '--out', out, '--overlays', overlays, ...args]);
  assert.equal(r.code, 0, r.out);
  return { d: decodeFile(TLV, mapOf(out)), out };
}

test('poi.move carries a way POI with a footprint to its target, door and all', (t) => {
  const target = [-462.6, -2084.7];
  const before = rows(decodeFile(TLV, SHIPPED), 'pois').find((p) => p.osm === 238249751 && p.osmT === 1);
  assert.ok(before, 'Haaretz');
  assert.ok(Math.hypot(before.entX / 10 - target[0], before.entY / 10 - target[1]) > 400, 'it starts far away');
  const { d, out } = importOps(t, [{ op: 'poi.move', anchor: { osm: 'w238249751' }, at: latLon(...target), why: 'Test: moved office' }], ['--strict']);
  const p = rows(d, 'pois').find((r) => r.osm === 238249751 && r.osmT === 1);
  assert.ok(Math.hypot(p.x / 10 - target[0], p.y / 10 - target[1]) < 0.5);
  assert.ok(Math.hypot(p.entX / 10 - target[0], p.entY / 10 - target[1]) < 40, `door at ${p.entX / 10}, ${p.entY / 10}`);
  assert.notEqual(p.bld, before.bld);
  assert.deepEqual(report(out, 'tlv_center', 'orphans'), []);
});

test('poi.move works the same on a relation POI', (t) => {
  const d0 = decodeFile(TLV, SHIPPED);
  const blds = rows(d0, 'blds');
  const rel = rows(d0, 'pois').find((p) => p.osmT === 2 && p.bld && blds[p.bld - 1].osmT === 2 && blds[p.bld - 1].osm === p.osm);
  assert.ok(rel, 'a relation POI on its own footprint');
  const target = [-462.6, -2084.7];
  const { d } = importOps(t, [{ op: 'poi.move', anchor: { osm: `r${rel.osm}` }, at: latLon(...target), why: 'Test: moved' }], ['--strict']);
  const p = rows(d, 'pois').find((r) => r.osm === rel.osm && r.osmT === 2);
  assert.ok(Math.hypot(p.entX / 10 - target[0], p.entY / 10 - target[1]) < 40, `door at ${p.entX / 10}, ${p.entY / 10}`);
});

test('a digit-only name is a name: the restaurant called 416', () => {
  const d = decodeFile(TLV, SHIPPED);
  const p = rows(d, 'pois').find((r) => r.osm === 9215660717);
  assert.equal(d.strings[p.nameEn], '416');
  assert.ok(p.flags & 1, 'NAMED');
});

/** Imports through `runImport` with one way of the extract given a new id, as OSM does when a way is redrawn. */
async function renumbered(t, way, id, ops) {
  const cacheDir = tempDir(t);
  const data = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/cache/tlv_center.osm.json'), 'utf8'));
  for (const e of data.elements) if (e.type === 'way' && e.id === way) e.id = id;
  fs.writeFileSync(path.join(cacheDir, 'tlv_center.osm.json'), JSON.stringify(data));
  const outRoot = tempDir(t);
  const overlaysDir = tempDir(t);
  fs.writeFileSync(path.join(overlaysDir, 'pois.json'), JSON.stringify(ops));
  return runImport({ areaId: 'tlv_center', outRoot, overlaysDir, cacheDir, root: ROOT, strict: true });
}

/** Curated kerb rows of a map. */
const curated = (d) => rows(d, 'kerbs').filter((k) => k.tier === 0);

test('kerb.set on a renumbered way gives the rows it gave before, and no others', async (t) => {
  const d0 = decodeFile(TLV, SHIPPED);
  const way = 30132409;
  const edges = rows(d0, 'edges').filter((e) => e.osm === way);
  assert.ok(edges.length >= 1);
  const line = edgeLine(d0, edges[0].id);
  const mid = line[line.length >> 1];
  const anchor = { osm: `w${way}`, at: latLon(mid[0], mid[1]), name: d0.strings[edges[0].name] };
  const op = [{ op: 'kerb.set', anchor, side: 'right', range: [0, 30], set: { paint: 1 }, why: 'Test: curb' }];
  const exact = importOps(t, op);
  const r = await renumbered(t, way, 990000001, op);
  assert.equal(r.ok, true, r.verify.failures.join('\n'));
  assert.equal(r.orphans[0].how, 'moved');
  const next = decodeFile(TLV, r.mapFile);
  assert.equal(curated(next).length, curated(exact.d).length);
  const labels = new Set(curated(next).map((k) => next.t.edges.col.osm[k.edge]));
  assert.deepEqual([...labels], [990000001], 'Ibn Gabirol has other ways within 60 m, and they stay as they were');
});

test('kerb.set on a renumbered multi-edge way reaches its far edges too', async (t) => {
  const d0 = decodeFile(TLV, SHIPPED);
  const named = rows(d0, 'edges').filter((e) => e.name);
  const counts = new Map();
  for (const e of named) counts.set(e.osm, (counts.get(e.osm) || 0) + 1);
  const way = [...counts].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0][0];
  const edges = named.filter((e) => e.osm === way);
  assert.ok(edges.length >= 4, `w${way} has ${edges.length} edges`);
  const a = edgeLine(d0, edges[0].id)[0];
  const anchor = { osm: `w${way}`, at: latLon(a[0], a[1]), name: d0.strings[edges[0].name] };
  const op = [{ op: 'kerb.set', anchor, side: 'both', set: { paint: 1 }, why: 'Test: curb' }];
  const exact = importOps(t, op);
  const r = await renumbered(t, way, 990000002, op);
  assert.equal(r.orphans[0].how, 'moved');
  assert.equal(new Set(curated(decodeFile(TLV, r.mapFile)).map((k) => k.edge)).size, new Set(curated(exact.d).map((k) => k.edge)).size);
});

test('verify refuses a piece of fence left inside a road gap', (t) => {
  const payload = readMapPayload(SHIPPED);
  const d = TLV.mapCodec.decodeAll(payload);
  const osm = rawExtract();
  const box = boxOf(d.meta.bbox, makeProjection(ORIGIN));
  const lines = fenceLines(osm, box).map((l) => l.pts);
  const facts = { uniqueNodes: 114284, signalNodes: 728, maxOsmId: 14333244588, fenceLines: lines, kindergartens: new Set() };
  const dir = tempDir(t);
  const file = path.join(dir, 'map.js');
  fs.writeFileSync(file, mapScript(payload));
  assert.match(verifyMap(TLV, file, facts, false).gates.find((g) => g.name.includes('fence inside')).value.toString(), /^0$/);
  // Begin at (1138.0, -1141.5): a 3 m stub laid back on the centreline, where the road crosses it.
  const cross = { x: 11380, y: -11415 };
  let stub = null;
  for (const pts of lines) {
    for (let i = 2; i < pts.length && !stub; i += 2) {
      const q = nearestOnSeg(cross.x, cross.y, pts[i - 2], pts[i - 1], pts[i], pts[i + 1]);
      if (q.d < 1) {
        const l = Math.hypot(pts[i] - pts[i - 2], pts[i + 1] - pts[i - 1]);
        const ux = (pts[i] - pts[i - 2]) / l;
        const uy = (pts[i + 1] - pts[i - 1]) / l;
        stub = [Math.round(q.x - ux * 15), Math.round(q.y - uy * 15), Math.round(q.x + ux * 15), Math.round(q.y + uy * 15)];
      }
    }
  }
  assert.ok(stub, 'the crossing lies on a centreline');
  const w = d.t.walls.col;
  const pOff = Array.from(w.pOff);
  const x = Array.from(d.t.wallPts.col.x);
  const y = Array.from(d.t.wallPts.col.y);
  pOff.push(pOff[pOff.length - 1] + 2);
  x.push(stub[0], stub[2]);
  y.push(stub[1], stub[3]);
  payload.tables.walls.n += 1;
  payload.tables.walls.cols.pOff = enc.vu(pOff);
  payload.tables.walls.cols.kind = enc.u8([...w.kind, 1]);
  payload.tables.wallPts.n += 2;
  payload.tables.wallPts.cols.x = enc.vd(x);
  payload.tables.wallPts.cols.y = enc.vd(y);
  fs.writeFileSync(file, mapScript(payload));
  const v = verifyMap(TLV, file, facts, false);
  assert.equal(v.ok, false);
  assert.match(v.failures.join('\n'), /fence inside their gap: [1-9]/);
});

test('every directed edge with no exit is a one-way road that ends, and no AI lane is one', () => {
  const d = decodeFile(TLV, SHIPPED);
  const e = d.t.edges.col;
  const j = d.t.juncs.col.flags;
  const exits = new Set(d.t.moves.col.from);
  let interior = 0;
  for (let i = 0; i < d.t.edges.n; i++) {
    for (const de of e.lanesB[i] ? [i * 2, i * 2 + 1] : [i * 2]) {
      if (exits.has(de)) continue;
      const end = de & 1 ? e.a[i] : e.b[i];
      if (j[end] & 1) continue;
      assert.equal(e.lanesB[i], 0, `edge ${i} is two-way, so a U-turn must exist`);
      assert.equal(e.flags[i] & 24, 0, `edge ${i} is AI-routable`);
      interior++;
    }
  }
  assert.ok(interior > 0 && interior < 60, `${interior}`);
});

test('a road that leaves the box past a dropped stub ends at a portal', () => {
  const d = decodeFile(TLV, SHIPPED);
  const j = rows(d, 'juncs');
  for (const [x, y] of [[-21140, -25508], [17389, -27657], [21135, 16868], [21179, 6795]]) {
    const hit = j.find((r) => r.x === x && r.y === y);
    assert.ok(hit, `${x}, ${y}`);
    assert.equal(hit.flags & 3, 3, `junction at ${x}, ${y} is a dead end and a portal`);
  }
});
