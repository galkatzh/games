// tests/map/importer.test.mjs — the importer end to end, ARCHITECTURE section 19 WP-MAP items 1, 2, 4, 5 and 6.
// Every run writes to a temporary directory through `--out`, so a test never touches shipped files.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { sourcesToFetch } from '../../tools/import.mjs';
import { enc, mapScript } from '../../tools/lib/encode.mjs';
import { buildGraph } from '../../tools/lib/graph.mjs';
import { fetchExtract, loadSources, makeProjection, nearestOnSeg, projectNodes } from '../../tools/lib/osm.mjs';
import { readMapPayload, verifyMap } from '../../tools/lib/report.mjs';
import { ROOT, decodeFile, edgeLine, report, rows, runImporter, runtime, tempDir } from './helpers.mjs';

const TLV = await runtime();
const SHIPPED = path.join(ROOT, 'data/maps/tlv_center/map.js');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const mapOf = (out, id = 'tlv_center') => path.join(out, 'data/maps', id, 'map.js');

/** Runs a script file and returns its exit code. */
function runNode(file) {
  return spawnSync(process.execPath, [file], { encoding: 'utf8' }).status;
}

test('two runs are byte-identical, and the shipped map is what the importer writes today', (t) => {
  const a = tempDir(t);
  const b = tempDir(t);
  const first = runImporter(['tlv_center', '--out', a]);
  const second = runImporter(['tlv_center', '--out', b]);
  assert.equal(first.code, 0, first.out);
  assert.equal(second.code, 0, second.out);
  assert.equal(sha256(mapOf(a)), sha256(mapOf(b)));
  assert.equal(sha256(mapOf(a)), sha256(SHIPPED));
  for (const name of ['stats', 'orphans']) assert.deepEqual(report(a, 'tlv_center', name), report(b, 'tlv_center', name));
});

test('every gate in section 19 passes on the decoded map', (t) => {
  const out = tempDir(t);
  const r = runImporter(['tlv_center', '--out', out, '--strict']);
  assert.equal(r.code, 0, r.out);
  const { gates } = report(out, 'tlv_center', 'stats');
  const by = Object.fromEntries(gates.map((g) => [g.name, g]));
  for (const g of gates) assert.ok(g.pass && g.enforced, `${g.name}: ${g.value}, want ${g.want}`);
  assert.equal(by['Unique nodes after dedupe'].value, 114284);
  assert.ok(by['Signal nodes retained'].value >= 700);
  assert.ok(by['SIGNAL junctions'].value >= 300 && by['SIGNAL junctions'].value <= 520);
  assert.ok(by['Junction clusters with degree 3 or more'].value >= 2000);
  assert.ok(by['Junction clusters with degree 3 or more'].value <= 2700);
  assert.ok(by.Movements.value >= 9000);
  assert.ok(by['Turn-level SCC share of lane-km'].value >= 0.9);
  assert.equal(by['Same-plane crossings with no junction'].value, 0);
  assert.equal(by['Lane centrelines crossing a walls row'].value, 0);
  assert.equal(by['Lane centrelines crossing a collider building'].value, 0);
  assert.ok(by.Buildings.value >= 14000);
  assert.ok(by['Named POI facade yield'].value >= 0.9);
  assert.equal(by['POIs whose edge is not nearest their door'].value, 0);
  assert.equal(by['Facade doors inside a collider building'].value, 0);
  assert.ok(by['Sensitive POIs'].value >= 150);
  assert.equal(by['Sensitive POIs with amenity=kindergarten'].value, 16, 'building=kindergarten rows do not count');
  assert.equal(by['Road crossings with fence inside their gap'].value, 0);
  assert.ok(by['Kerb stalls at 6.5 m'].value >= 50000);
  assert.ok(by['osm column round-trip, max id'].value > 2 ** 31);
  assert.ok(by['map.js bytes'].value <= 1600000);
});

test('the map carries attribution and the contract meta block', () => {
  const d = decodeFile(TLV, SHIPPED);
  assert.equal(d.meta.attribution, '© OpenStreetMap contributors');
  assert.equal(d.meta.license, 'ODbL-1.0');
  assert.deepEqual(d.schema, [1, 0]);
  assert.deepEqual(d.meta.origin, [32.075, 34.7775]);
  assert.deepEqual(d.meta.bbox, [32.05, 34.755, 32.10, 34.80]);
  assert.deepEqual(d.meta.bounds, [-2124.3, -2772.2, 2124.3, 2772.2]);
  assert.equal(d.meta.osmTime, '2026-11-01T00:38:42Z');
  const text = fs.readFileSync(path.join(ROOT, 'data/maps/tlv_center/ATTRIBUTION.txt'), 'utf8');
  assert.match(text, /© OpenStreetMap contributors/);
  assert.match(text, /ODbL\)? 1\.0/);
  assert.match(text, /2026-11-01T00:38:42Z/);
});

test('the map index is generated and points at a real file', () => {
  const win = { TLV: {} };
  vm.compileFunction(fs.readFileSync(path.join(ROOT, 'data/maps/index.js'), 'utf8'), ['TLV'])(win.TLV);
  const { default: def, maps } = win.TLV.mapIndex;
  assert.equal(def, 'tlv_center');
  assert.deepEqual(maps.tlv_center.schema, [1, 0]);
  assert.equal(maps.tlv_center.title.en, 'Tel Aviv Center');
  assert.ok(fs.existsSync(path.join(ROOT, maps.tlv_center.src)));
});

test('a re-import with nothing changed reports no change', (t) => {
  const out = tempDir(t);
  fs.mkdirSync(path.dirname(mapOf(out)), { recursive: true });
  fs.copyFileSync(SHIPPED, mapOf(out));
  assert.equal(runImporter(['tlv_center', '--out', out]).code, 0);
  const diff = report(out, 'tlv_center', 'diff');
  assert.deepEqual(diff.classes, {});
  const empty = { added: [], removed: [], changed: [] };
  for (const name of ['ways', 'pts', 'kerbs', 'buildings', 'pois', 'juncs', 'moves', 'stops', 'xings', 'walls']) {
    assert.deepEqual(diff.rows[name], empty, name);
  }
  assert.deepEqual(diff.rows.touched, []);
  assert.deepEqual(diff.rows.other, []);
});

test('a class that moves more than 5% is flagged', (t) => {
  const out = tempDir(t);
  const overlays = tempDir(t);
  fs.mkdirSync(path.dirname(mapOf(out)), { recursive: true });
  fs.copyFileSync(SHIPPED, mapOf(out));
  const d = decodeFile(TLV, SHIPPED);
  const primaries = [...new Set(rows(d, 'edges').filter((e) => e.cls === 0).map((e) => e.osm))];
  fs.writeFileSync(path.join(overlays, 'roads.json'), JSON.stringify(primaries.slice(0, 8).map((id) => (
    { op: 'road.set', anchor: { osm: `w${id}` }, set: { highway: 'tertiary' }, why: 'Test: reclassify' }
  ))));
  assert.equal(runImporter(['tlv_center', '--out', out, '--overlays', overlays]).code, 0);
  assert.ok(report(out, 'tlv_center', 'diff').flagged.includes('edges.cls.primary'));
});

test('a second area on a sub-bbox of the same extract imports with no code change', (t) => {
  const out = tempDir(t);
  const areas = tempDir(t);
  const file = path.join(areas, 'tlv_sub.json');
  fs.writeFileSync(file, JSON.stringify({
    id: 'tlv_sub',
    bbox: [32.065, 34.765, 32.085, 34.79],
    origin: [32.075, 34.7775],
    title: { he: 'מרכז קטן', en: 'Small Center' },
    sources: ['tlv_center']
  }));
  const r = runImporter(['tlv_sub', '--area-file', file, '--out', out, '--write-index']);
  assert.equal(r.code, 0, r.out);
  const d = decodeFile(TLV, mapOf(out, 'tlv_sub'));
  assert.equal(d.id, 'tlv_sub');
  assert.ok(d.t.edges.n > 300 && d.t.edges.n < 3000);
  assert.ok(d.t.blds.n > 1000);
  assert.ok(d.t.land.col.cls.includes(0), 'the coast crosses this bbox, so it must have a sea');
  const b = d.meta.bounds;
  for (const x of d.t.pts.col.x) assert.ok(x / 10 >= b[0] && x / 10 <= b[2]);
  for (const y of d.t.pts.col.y) assert.ok(y / 10 >= b[1] && y / 10 <= b[3]);
  for (const x of d.t.bpts.col.x) assert.ok(x / 10 >= b[0] - 0.05 && x / 10 <= b[2] + 0.05);
  assert.deepEqual(report(out, 'tlv_sub', 'stats').gates.filter((g) => g.enforced && !g.pass), []);
  assert.match(fs.readFileSync(path.join(out, 'data/maps/index.js'), 'utf8'), /tlv_sub/);
});

test('an orphan overlay anchor is logged, and fails only under --strict', (t) => {
  const overlays = tempDir(t);
  const a = tempDir(t);
  const b = tempDir(t);
  fs.writeFileSync(path.join(overlays, 'pois.json'), JSON.stringify([
    { op: 'poi.hide', anchor: { osm: 'n1', at: [32.09, 34.76], name: 'Nothing here' }, why: 'Test: gone' }
  ]));
  assert.equal(runImporter(['tlv_center', '--out', a, '--overlays', overlays]).code, 0);
  assert.equal(report(a, 'tlv_center', 'orphans')[0].how, 'orphan');
  const strict = runImporter(['tlv_center', '--out', b, '--overlays', overlays, '--strict']);
  assert.equal(strict.code, 1);
  assert.match(strict.out, /orphan overlay anchor/);
});

test('post overlays reach POIs and kerbs, and hiding a sensitive POI keeps its guard', (t) => {
  const d = decodeFile(TLV, SHIPPED);
  const p = rows(d, 'pois');
  const sensitive = p.find((r) => (r.flags & 4) && (r.flags & 1) && r.osmT === 1);
  const plain = p.find((r) => !(r.flags & 4) && r.nameEn && r.osmT === 0);
  const edge = rows(d, 'edges').find((e) => e.cls === 4 && e.parkR > 0);
  const out = tempDir(t);
  const overlays = tempDir(t);
  fs.writeFileSync(path.join(overlays, 'pois.json'), JSON.stringify([
    { op: 'poi.hide', anchor: { osm: `w${sensitive.osm}` }, why: 'Test: sign removed' },
    { op: 'poi.rename', anchor: { osm: `n${plain.osm}` }, name: { en: 'Renamed' }, why: 'Test: new owner' },
    { op: 'poi.add', at: [32.0749, 34.7820], kind: 'bakery', name: { en: 'Added Bakery' }, why: 'Test: new shop' },
    { op: 'kerb.set', anchor: { osm: `w${edge.osm}` }, side: 'right', range: [0, 30], set: { paint: 1 }, why: 'Test: curb' }
  ]));
  assert.equal(runImporter(['tlv_center', '--out', out, '--overlays', overlays]).code, 0);
  const next = decodeFile(TLV, mapOf(out));
  const q = rows(next, 'pois');
  const was = q.find((r) => r.osm === sensitive.osm && r.osmT === 1);
  assert.ok(was.flags & 4, 'the guard stays');
  assert.equal(was.nameHe + was.nameEn, 0, 'the sign goes');
  assert.equal(next.strings[q.find((r) => r.osm === plain.osm && r.osmT === 0).nameEn], 'Renamed');
  const added = q.find((r) => next.strings[r.nameEn] === 'Added Bakery');
  assert.ok(added);
  assert.equal(added.flags & 8, 0, 'an added POI binds to a real wall');
  const curated = rows(next, 'kerbs').filter((k) => k.tier === 0);
  assert.ok(curated.length >= 1);
  assert.ok(curated.every((k) => k.paint === 1 && k.side === 1 && k.s1 <= 300));
});

test('the spawn road is the contract\'s: King George, contracted, ending at the HaNeviim signal', () => {
  const d = decodeFile(TLV, SHIPPED);
  const r = TLV.anchors.resolve(null, { osm: 'w154735772' }, { type: 'edge', index: TLV.anchors.decodedIndex(d, 'edge') });
  assert.equal(r.how, 'exact');
  assert.equal(r.ids.length, 1);
  const e = rows(d, 'edges')[r.id];
  const line = edgeLine(d, r.id);
  const len = line.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - line[i][0], p[1] - line[i][1]), 0);
  assert.ok(Math.abs(len - 183) < 2, `length ${len}`);
  assert.equal(e.lanesF, 1);
  assert.equal(e.lanesB, 0);
  const end = d.t.juncs.col;
  assert.equal(end.kind[e.b], 2);
  assert.ok(Math.hypot(end.x[e.b] / 10 + 62, end.y[e.b] / 10 - 139) < 3);
});

test('the pinned milk errand POI has a real door on Ibn Gabirol', () => {
  const d = decodeFile(TLV, SHIPPED);
  const hit = TLV.anchors.resolve(null, { osm: 'n11238493213' }, { type: 'poi', index: TLV.anchors.decodedIndex(d, 'poi') });
  const p = rows(d, 'pois')[hit.id];
  assert.equal(d.strings[p.nameEn], 'Carrefour');
  assert.equal(d.strings[p.kind], 'supermarket');
  assert.equal(p.flags & 12, 0);
  assert.equal(d.strings[d.t.edges.col.nameEn[p.edge - 1]], 'Ibn Gabirol');
});

test('shop names land on walls that face their own street', () => {
  const stats = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/reports/tlv_center/stats.json'), 'utf8'));
  assert.ok(stats.pois.addrKnown > 900);
  assert.ok(stats.pois.addrMatched / stats.pois.addrKnown >= 0.82, `${stats.pois.addrMatched} of ${stats.pois.addrKnown}`);
  const d = decodeFile(TLV, SHIPPED);
  const name = (p) => d.strings[p.nameEn];
  const road = (p) => d.strings[d.t.edges.col.nameEn[p.edge - 1]];
  const on = (poi, street) => {
    const p = rows(d, 'pois').find((r) => name(r) === poi);
    assert.ok(p, poi);
    assert.equal(road(p), street, poi);
  };
  on('Carrefour', 'Ibn Gabirol');
  on('Bread Station', 'Ibn Gabirol');
  on('Shi shi', 'Ibn Gabirol');
});

test('a door sits on open ground, 0.5 m off its own wall', () => {
  const d = decodeFile(TLV, SHIPPED);
  const off = d.t.brings.col.pOff;
  const b = d.t.blds.col;
  const { x, y } = d.t.bpts.col;
  const footprints = TLV.anchors.decodedIndex(d, 'building');
  const solid = rows(d, 'blds').filter((r) => !(r.flags & 1)).map((r) => r.id);
  for (const p of rows(d, 'pois')) {
    if (p.flags & 8) continue;
    for (const i of solid) assert.equal(footprints.inside(i, p.entX * 0.1, p.entY * 0.1), false, `poi ${p.id} door is inside building ${i}`);
  }
  let checked = 0;
  for (const p of rows(d, 'pois')) {
    if (!p.wall || p.flags & 2) continue;
    const r = b.rOff[p.bld - 1];
    const n = off[r + 1] - off[r];
    const i = off[r] + p.wall - 1;
    const j = off[r] + (p.wall % n);
    const len = Math.hypot(x[j] - x[i], y[j] - y[i]);
    const c = ((p.entX - x[i]) * (y[j] - y[i]) - (p.entY - y[i]) * (x[j] - x[i])) / len;
    assert.ok(Math.abs(c - 5) < 1.5, `poi ${p.id}: ${c} dm off the wall, outward is positive`);
    assert.ok(p.w >= 30 && p.w <= 90);
    checked++;
  }
  assert.ok(checked > 2000);
});

test('every outer ring is CCW, every hole CW, and nothing strays outside the bounds', () => {
  const d = decodeFile(TLV, SHIPPED);
  const area = (a, z) => {
    let s = 0;
    for (let i = a, j = z - 1; i < z; j = i++) s += d.t.bpts.col.x[j] * d.t.bpts.col.y[i] - d.t.bpts.col.x[i] * d.t.bpts.col.y[j];
    return s;
  };
  const b = d.t.blds.col;
  const off = d.t.brings.col.pOff;
  for (let i = 0; i < d.t.blds.n; i++) {
    for (let r = b.rOff[i]; r < b.rOff[i + 1]; r++) {
      const s = area(off[r], off[r + 1]);
      assert.ok(r === b.rOff[i] ? s > 0 : s < 0, `building ${i} ring ${r}`);
    }
  }
  for (const v of d.t.bpts.col.x) assert.ok(Math.abs(v) <= 21243);
  for (const v of d.t.bpts.col.y) assert.ok(Math.abs(v) <= 27722);
});

test('the Ayalon is walled, and the bridges across it are open', () => {
  const d = decodeFile(TLV, SHIPPED);
  const w = rows(d, 'walls');
  const stats = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/reports/tlv_center/stats.json'), 'utf8'));
  assert.equal(w.filter((r) => r.kind === 0).length, 4);
  assert.ok(w.filter((r) => r.kind === 1).length > 8);
  assert.ok(stats.walls.fenceKeptKm > 9 && stats.walls.fenceKeptKm < stats.walls.fenceKm);
  assert.ok(stats.walls.crossedEdges >= 20);
  const west = (e) => edgeLine(d, e).every(([x]) => x < 1400);
  const east = (e) => edgeLine(d, e).every(([x]) => x > 1500);
  const moves = rows(d, 'edges').filter((e) => e.flags & 24);
  assert.ok(moves.some((e) => west(e.id)) && moves.some((e) => east(e.id)), 'AI roads on both banks');
});

test('sea lies west, the city does not', () => {
  const d = decodeFile(TLV, SHIPPED);
  const l = d.t.land.col;
  const sea = rows(d, 'land').filter((r) => r.cls === 0);
  assert.equal(sea.length, 1);
  const ring = [];
  for (let k = l.pOff[sea[0].id]; k < l.pOff[sea[0].id + 1]; k++) ring.push([d.t.landPts.col.x[k] / 10, d.t.landPts.col.y[k] / 10]);
  const inside = (x, y) => {
    let c = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if ((ring[i][1] > y) !== (ring[j][1] > y) && x < ((ring[j][0] - ring[i][0]) * (y - ring[i][1])) / (ring[j][1] - ring[i][1]) + ring[i][0]) c = !c;
    }
    return c;
  };
  assert.equal(inside(-2000, 0), true);
  assert.equal(inside(-1500, 2000), true);
  assert.equal(inside(0, 0), false);
  assert.equal(inside(1000, -1000), false);
});

test('the file loads as a plain script, and its Hebrew and symbols survive', () => {
  const d = decodeFile(TLV, SHIPPED);
  assert.match(fs.readFileSync(SHIPPED, 'utf8').slice(0, 30), /^TLV\.q\.push\(\['map', /);
  assert.ok(d.strings.includes('דיזנגוף'));
  assert.equal('אבן גבירול'.length, 10);
  assert.ok(d.strings.includes('אבן גבירול'));
});

test('each overlay op reaches the output, and unaffected data stays put', (t) => {
  const d = decodeFile(TLV, SHIPPED);
  const blds = rows(d, 'blds');
  const plain = blds.find((b) => b.osmT === 1 && b.h === 0 && !b.flags);
  const gone = blds.find((b) => b.osmT === 1 && b.id > plain.id && !b.flags);
  const road = rows(d, 'edges').filter((e) => e.cls === 4)[40];
  const poi = rows(d, 'pois').find((p) => p.osmT === 0 && !(p.flags & 4) && p.nameEn);
  const out = tempDir(t);
  const overlays = tempDir(t);
  fs.writeFileSync(path.join(overlays, 'all.json'), JSON.stringify([
    { op: 'building.set', anchor: { osm: `w${plain.osm}` }, set: { height: 44, style: 'glass_blue' }, why: 'Test: resurvey' },
    { op: 'building.delete', anchor: { osm: `w${gone.osm}` }, why: 'Test: demolished' },
    { op: 'road.delete', anchor: { osm: `w${road.osm}` }, why: 'Test: closed for good' },
    { op: 'road.add', points: [[32.084, 34.7616], [32.0846, 34.7616]], tags: { highway: 'residential', name: 'Added Street' }, why: 'Test: new link' },
    { op: 'poi.move', anchor: { osm: `n${poi.osm}` }, at: [32.0749, 34.7820], why: 'Test: moved shop' }
  ]));
  const r = runImporter(['tlv_center', '--out', out, '--overlays', overlays]);
  assert.equal(r.code, 0, r.out);
  const next = decodeFile(TLV, mapOf(out));
  const b = rows(next, 'blds').find((x) => x.osm === plain.osm);
  assert.equal(b.h, 440);
  assert.equal(next.strings[b.style], 'glass_blue');
  assert.ok(!rows(next, 'blds').some((x) => x.osm === gone.osm));
  assert.ok(!rows(next, 'edges').some((x) => x.osm === road.osm));
  assert.ok(rows(next, 'edges').some((x) => next.strings[x.name] === 'Added Street' || next.strings[x.nameEn] === 'Added Street'));
  const moved = rows(next, 'pois').find((x) => x.osm === poi.osm && x.osmT === 0);
  assert.deepEqual([moved.x, moved.y], [4249, -111]);
  assert.equal(report(out, 'tlv_center', 'orphans').length, 0);
});

test('--fetch names the project to Overpass, and nothing about whoever runs it', async (t) => {
  const real = globalThis.fetch;
  t.after(() => { globalThis.fetch = real; });
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push({ url, init });
    return new Response('{"elements":[]}', { status: 200 });
  };
  const dir = tempDir(t);
  const file = await fetchExtract(dir, 'probe', [32.07, 34.77, 32.08, 34.78]);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].init.method, 'POST');
  assert.deepEqual(Object.keys(seen[0].init.headers), ['User-Agent'], 'the name is all it sends about itself');
  assert.equal(seen[0].init.headers['User-Agent'], 'sidurim-map-import/1.0');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"elements":[]}');
});

test('the graph takes more node ids than a call has room for arguments', () => {
  const nodes = new Map();
  for (let i = 1; i <= 400000; i++) nodes.set(-i, { id: -i, x: 0, y: 0 });
  assert.equal(buildGraph([], nodes).nextNodeId, -400001, 'below the lowest id');
  assert.equal(buildGraph([], new Map([[5, { id: 5, x: 0, y: 0 }]])).nextNodeId, -2, 'and below -1 with none under it');
});

test('fetching a new area leaves a shared source alone', () => {
  const cache = path.join(ROOT, 'tools/cache');
  assert.deepEqual(sourcesToFetch({ id: 'tlv_north', sources: ['tlv_center', 'tlv_north'] }, cache), ['tlv_north']);
  assert.deepEqual(sourcesToFetch({ id: 'tlv_center', sources: ['tlv_center'] }, cache), ['tlv_center']);
  assert.deepEqual(sourcesToFetch({ id: 'x', sources: ['tlv_center', 'not_downloaded'] }, cache), ['not_downloaded']);
});

/** The raw extract, projected. */
function rawExtract() {
  const osm = loadSources(path.join(ROOT, 'tools/cache'), ['tlv_center']);
  projectNodes(osm.nodes, makeProjection([32.075, 34.7775]));
  return osm;
}

/** Every step of an edge polyline, in both directions, as comparable text. */
function stepsOf(d, i) {
  const { ptOff } = d.t.edges.col;
  const { x, y } = d.t.pts.col;
  const out = new Set();
  for (let k = ptOff[i] + 1; k < ptOff[i + 1]; k++) {
    out.add(`${x[k - 1]},${y[k - 1]}>${x[k]},${y[k]}`);
    out.add(`${x[k]},${y[k]}>${x[k - 1]},${y[k - 1]}`);
  }
  return out;
}

/** The raw nodes of a way, in travel order. */
function travelNodes(w, nodes) {
  return (w.tags.oneway === '-1' ? w.nodes.slice().reverse() : w.nodes).map((id) => nodes.get(id));
}

/** First step of a raw way, in travel order, that an edge holds. -1 when it holds none. */
function stepOnWay(d, i, w, nodes) {
  const list = travelNodes(w, nodes);
  const steps = stepsOf(d, i);
  for (let j = 1; j < list.length; j++) {
    const a = list[j - 1];
    const b = list[j];
    if (a && b && steps.has(`${a.x},${a.y}>${b.x},${b.y}`)) return j - 1;
  }
  return -1;
}

/** Where an edge sits along a raw way, in steps. A clipped stub shares no step, so its middle is projected onto the way. */
function placeOnWay(d, i, w, nodes) {
  const step = stepOnWay(d, i, w, nodes);
  if (step >= 0) return step;
  const { ptOff } = d.t.edges.col;
  const { x, y } = d.t.pts.col;
  const k = ptOff[i];
  const mx = (x[k] + x[k + 1]) / 2;
  const my = (y[k] + y[k + 1]) / 2;
  const list = travelNodes(w, nodes);
  let best = Infinity;
  let at = -1;
  for (let j = 1; j < list.length; j++) {
    if (!list[j - 1] || !list[j]) continue;
    const q = nearestOnSeg(mx, my, list[j - 1].x, list[j - 1].y, list[j].x, list[j].y);
    if (q.d < best) {
      best = q.d;
      at = j - 1 + q.t;
    }
  }
  return at;
}

test('every POI edge is the edge nearest its door, by brute force, and none goes without one', () => {
  const d = decodeFile(TLV, SHIPPED);
  const { ptOff } = d.t.edges.col;
  const { x, y } = d.t.pts.col;
  const segs = [];
  for (let i = 0; i < d.t.edges.n; i++) for (let k = ptOff[i] + 1; k < ptOff[i + 1]; k++) segs.push({ i, k });
  const all = rows(d, 'pois');
  assert.equal(all.length, 2768);
  for (const p of all) {
    assert.ok(p.edge > 0, `poi ${p.id} has no edge`);
    let best = Infinity;
    let own = Infinity;
    for (const { i, k } of segs) {
      const q = nearestOnSeg(p.entX, p.entY, x[k - 1], y[k - 1], x[k], y[k]).d;
      if (q < best) best = q;
      if (i === p.edge - 1 && q < own) own = q;
    }
    assert.ok(own <= best + 1e-6, `poi ${p.id}: its edge is ${own} dm away, the nearest is ${best} dm`);
  }
});

test('verify refuses a POI bound to a road that is not its nearest', (t) => {
  const payload = readMapPayload(SHIPPED);
  const d = TLV.mapCodec.decodeAll(payload);
  const list = Array.from(d.t.pois.col.edge);
  const victim = rows(d, 'pois').findIndex((p) => p.nameEn && d.strings[p.nameEn] === 'Carrefour');
  const nearestE = list[victim];
  list[victim] = nearestE === 1 ? 2 : 1;
  payload.tables.pois.cols.edge = enc.vu(list);
  const dir = tempDir(t);
  const file = path.join(dir, 'map.js');
  fs.writeFileSync(file, mapScript(payload));
  const v = verifyMap(TLV, file, { uniqueNodes: 114284, signalNodes: 728, maxOsmId: 14333244588 }, true);
  assert.equal(v.ok, false);
  assert.match(v.failures.join('\n'), /not nearest their door: 1 /);
  list[victim] = 0;
  payload.tables.pois.cols.edge = enc.vu(list);
  fs.writeFileSync(file, mapScript(payload));
  assert.match(verifyMap(TLV, file, { uniqueNodes: 114284, signalNodes: 728, maxOsmId: 14333244588 }, true).failures.join('\n'), /not nearest their door: 1 /);
});

test('the fixture keeps the same rule: each door names its nearest edge', () => {
  const d = decodeFile(TLV, path.join(ROOT, 'tests/fixtures/mini_map.js'));
  for (const p of rows(d, 'pois')) {
    const dist = (i) => {
      const [[ax, ay], [bx, by]] = edgeLine(d, i);
      return nearestOnSeg(p.entX * 0.1, p.entY * 0.1, ax, ay, bx, by).d;
    };
    for (let i = 0; i < d.t.edges.n; i++) assert.ok(dist(p.edge - 1) <= dist(i) + 1e-9, `poi ${p.id}, edge ${i}`);
  }
});

test('layer=-1 removes no real building, and the rule is reported', () => {
  const d = decodeFile(TLV, SHIPPED);
  const blds = rows(d, 'blds');
  const mall = blds.find((b) => b.osm === 1295004426);
  assert.ok(mall, 'TLV fashion mall');
  assert.equal(d.strings[mall.nameEn], 'TLV fashion mall');
  assert.ok(blds.find((b) => b.osm === 95201309), 'the station, tagged location=surface');
  const stats = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/reports/tlv_center/stats.json'), 'utf8'));
  assert.equal(stats.buildings.undergroundDropped, 0);
  assert.equal(stats.buildings.count, 14552);
});

/** A point inside ring 0 of the largest row of a building, in lat/lon, plus metres east of its bbox. */
function pointsOn(d, osm, osmT) {
  const b = d.t.blds.col;
  const { pOff } = d.t.brings.col;
  const { x, y } = d.t.bpts.col;
  const index = TLV.anchors.decodedIndex(d, 'building');
  const ll = (mx, my) => [my / 110888 + d.meta.origin[0], mx / 94415 + d.meta.origin[1]];
  const ids = [];
  for (let i = 0; i < d.t.blds.n; i++) if (b.osm[i] === osm && b.osmT[i] === osmT) ids.push(i);
  let best = null;
  for (const i of ids) {
    const r = b.rOff[i];
    const n = pOff[r + 1] - pOff[r];
    if (!best || n > best.n) best = { i, r, n };
  }
  const k = pOff[best.r];
  const xs = Array.from(x.slice(k, k + best.n)).map((v) => v * 0.1);
  const ys = Array.from(y.slice(k, k + best.n)).map((v) => v * 0.1);
  const maxX = Math.max(...xs);
  const midY = (Math.min(...ys) + Math.max(...ys)) / 2;
  for (let fx = 0.5; fx > 0; fx -= 0.05) {
    const mx = Math.min(...xs) + (maxX - Math.min(...xs)) * fx;
    const hits = ids.filter((i) => index.inside(i, mx, midY));
    let others = 0;
    for (let i = 0; i < d.t.blds.n; i++) if (!ids.includes(i) && index.dist(i, mx, midY) === 0) others++;
    if (hits.length && !others) return { ids, inside: ll(mx, midY), near: ll(maxX + 20, midY), name: d.strings[b.name[best.i]] };
  }
  throw new Error('no clear point');
}

test('a renumbered multipolygon building keeps its overlay, through the whole importer', (t) => {
  const d = decodeFile(TLV, SHIPPED);
  const spot = pointsOn(d, 15311025, 2);
  assert.equal(spot.ids.length, 4, 'Dizengoff Center has four rows');
  const runWith = (anchor) => {
    const out = tempDir(t);
    const overlays = tempDir(t);
    fs.writeFileSync(path.join(overlays, 'b.json'), JSON.stringify([
      { op: 'building.set', anchor, set: { style: 'mall_style' }, why: 'Test: OSM renumbered this relation' }
    ]));
    const r = runImporter(['tlv_center', '--out', out, '--overlays', overlays, '--strict']);
    assert.equal(r.code, 0, r.out);
    const next = decodeFile(TLV, mapOf(out));
    const styled = rows(next, 'blds').filter((b) => next.strings[b.style] === 'mall_style');
    return { rows: styled.map((b) => `${b.osmT}:${b.osm}`), how: report(out, 'tlv_center', 'orphans')[0].how };
  };
  const expected = Array(4).fill('2:15311025');
  assert.deepEqual(runWith({ osm: 'r999999999', at: spot.inside }), { rows: expected, how: 'relocated' });
  assert.deepEqual(runWith({ osm: 'r999999999', at: spot.near, name: spot.name }), { rows: expected, how: 'moved' });
});

test('the owner-facing geography gates are all there and all green', () => {
  const stats = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/reports/tlv_center/stats.json'), 'utf8'));
  const gate = (name) => {
    const g = stats.gates.find((x) => x.name.startsWith(name));
    assert.ok(g, name);
    assert.equal(g.pass, true, `${name}: ${g.value}`);
    assert.equal(g.enforced, true, name);
    return g;
  };
  assert.equal(gate('Lane overlaps between carriageways').value, 0);
  assert.equal(gate('Lanes closer than a car on the built World').value, 0);
  assert.equal(gate('Long clusters on narrow streets').value, 0);
  assert.equal(gate('Street names that are only digits').value, 0);
  assert.equal(gate('Dead ends on class 2 or better').value, 0);
  assert.equal(gate('Buildings over 1000 m2').value, 0);
  assert.ok(gate('Kept roundabouts').value >= 20);
  assert.deepEqual(stats.section.overlayLanesReduced, []);
});

test('real squares circulate, and the corners they stand on stay RING', () => {
  const d = decodeFile(TLV, SHIPPED);
  const e = d.t.edges.col;
  const m = d.t.moves.col;
  for (const way of [1284672741, 168983276]) {
    const arcs = [];
    for (let i = 0; i < d.t.edges.n; i++) if (e.osm[i] === way) arcs.push(i);
    assert.ok(arcs.length >= 3, `w${way} has ${arcs.length} arcs`);
    for (const i of arcs) {
      assert.equal(e.flags[i] & 1, 1);
      assert.equal(e.lanesB[i], 0);
      assert.equal(d.t.juncs.col.kind[e.b[i]], 3, `w${way} arc ${i} ends at a RING junction`);
    }
    // Round the circle by moves alone, arc to arc, back to the start.
    let at = arcs[0];
    for (let step = 0; step < arcs.length; step++) {
      let next = -1;
      for (let r = 0; r < d.t.moves.n; r++) if (m.from[r] === at * 2 && arcs.includes(m.to[r] >> 1)) next = m.to[r] >> 1;
      assert.ok(next >= 0, `w${way} stops at arc ${at}`);
      at = next;
    }
    assert.equal(at, arcs[0], `w${way} closes`);
  }
});

test('footprints: the bus station, Shalom Meir and Beit Hadar are solid, the Atarim hotel is the one listed exception', () => {
  const d = decodeFile(TLV, SHIPPED);
  const hollow = new Map(rows(d, 'blds').map((b) => [`${'nwr'[b.osmT]}${b.osm}`, b.flags & 1]));
  for (const id of ['w230605310', 'w203971959', 'w102850853']) assert.equal(hollow.get(id), 0, id);
  assert.equal(hollow.get('w765979741'), 1);
  assert.equal(hollow.get('w1271301616'), 1, 'the Paz canopy is a roof');
  const rules = JSON.parse(fs.readFileSync(path.join(ROOT, 'tools/rules/tags.json'), 'utf8'));
  assert.deepEqual(rules.section.hollowAllow.map((a) => a.osm), ['w765979741']);
  for (const a of rules.section.hollowAllow) assert.ok(a.why.length > 20, 'an exception needs its reason');
  for (const w of rules.section.overlapAllow) assert.ok(w.why.length > 20, 'an exception needs its reason');
});

test('bar Kokhba and King George are back, Mendele has his name, and no way has a number for one', () => {
  const d = decodeFile(TLV, SHIPPED);
  const e = d.t.edges.col;
  const on = (way) => {
    for (let i = 0; i < d.t.edges.n; i++) if (e.osm[i] === way) return i;
    return -1;
  };
  assert.ok(on(35169508) >= 0, 'access=no, motor_vehicle=yes');
  assert.ok(on(206628045) >= 0, 'Arlosoroff eastbound');
  assert.equal(d.strings[e.nameEn[on(24637619)]], 'Mendele Mocher Sforim');
  assert.ok(!d.strings.includes('Mendele Book Seller'));
});

test('an import leaves no temporary file beside the map', (t) => {
  const out = tempDir(t);
  assert.equal(runImporter(['tlv_center', '--out', out]).code, 0);
  assert.deepEqual(fs.readdirSync(path.dirname(mapOf(out))).sort(), ['ATTRIBUTION.txt', 'map.js']);
});

test('a map that fails a gate never replaces the one readers have', (t) => {
  const root = tempDir(t);
  const out = path.join(root, 'out');
  const dir = path.dirname(mapOf(out));
  fs.mkdirSync(dir, { recursive: true });
  const held = `${fs.readFileSync(SHIPPED, 'utf8')}// the map readers have\n`;
  fs.writeFileSync(mapOf(out), held);
  const mod = path.join(ROOT, 'tools/import.mjs');
  const script = `
    import { runImport } from ${JSON.stringify(new URL(`file://${mod}`).href)};
    const r = await runImport({ areaId: 'tlv_center', outRoot: ${JSON.stringify(out)}, root: ${JSON.stringify(ROOT)}, cacheDir: ${JSON.stringify(path.join(ROOT, 'tools/cache'))},
      overlaysDir: undefined, failGate: true });
    process.exit(r.ok ? 0 : 3);
  `;
  fs.writeFileSync(path.join(root, 'run.mjs'), script);
  assert.equal(runNode(path.join(root, 'run.mjs')), 3);
  assert.equal(fs.readFileSync(mapOf(out), 'utf8'), held);
  assert.deepEqual(fs.readdirSync(dir), ['map.js']);
});

test('edges of every way come back in travel order, checked against the raw way', () => {
  const d = decodeFile(TLV, SHIPPED);
  const osm = rawExtract();
  const e = d.t.edges.col;
  const index = TLV.anchors.decodedIndex(d, 'edge');
  const byWay = new Map();
  for (let i = 0; i < d.t.edges.n; i++) {
    if (!byWay.has(e.osm[i])) byWay.set(e.osm[i], []);
    byWay.get(e.osm[i]).push(i);
  }
  let multi = 0;
  for (const [way, list] of byWay) {
    if (list.length < 2) continue;
    multi++;
    const w = osm.ways.get(way);
    const r = TLV.anchors.resolve(null, { osm: `w${way}` }, { type: 'edge', index });
    assert.deepEqual(r.ids, list, `w${way}: anchors and row order agree`);
    const placed = r.ids.map((i) => placeOnWay(d, i, w, osm.nodes));
    for (let k = 1; k < placed.length; k++) assert.ok(placed[k] > placed[k - 1], `w${way}: ${placed}`);
    // A kept roundabout is cut at its hubs, and nothing makes its first node one, so its first edge runs across that node.
    const ring = w.tags.junction === 'roundabout' || w.tags.junction === 'circular';
    if (w.nodes[0] === w.nodes[w.nodes.length - 1] && !ring) assert.equal(placed[0], 0, `closed w${way} starts at its first node: ${placed}`);
  }
  assert.ok(multi > 900, `${multi} multi-edge ways`);
  const first = (way) => placeOnWay(d, TLV.anchors.resolve(null, { osm: `w${way}` }, { type: 'edge', index }).id, osm.ways.get(way), osm.nodes);
  assert.equal(first(505866861), 0, 'a pass 6 cut: nodes 0 to 3 come before 4 and 5');
  assert.ok(first(521643553) < 1, 'a stub near node 0 comes before nodes 2 to 4');
  assert.equal(first(5118376), 0, 'a closed street');
});

test('edges.osm names a way the edge really holds', () => {
  const d = decodeFile(TLV, SHIPPED);
  const osm = rawExtract();
  const e = d.t.edges.col;
  const portal = d.t.juncs.col.flags;
  // Carriageways that do not fit side by side move up to 3 m off the line OSM draws, so a moved edge is held to that, not to a step.
  const beside = (i, w) => {
    const { pts } = d.t;
    const list = travelNodes(w, osm.nodes);
    const near = (k) => {
      let best = Infinity;
      for (let j = 1; j < list.length; j++) {
        if (list[j - 1] && list[j]) best = Math.min(best, nearestOnSeg(pts.col.x[k], pts.col.y[k], list[j - 1].x, list[j - 1].y, list[j].x, list[j].y).d);
      }
      return best <= 32;
    };
    for (let k = e.ptOff[i] + 1; k < e.ptOff[i + 1]; k++) if (near(k - 1) && near(k)) return true;
    return false;
  };
  for (let i = 0; i < d.t.edges.n; i++) {
    if (portal[e.a[i]] & 1 || portal[e.b[i]] & 1) continue;
    const w = osm.ways.get(e.osm[i]);
    assert.ok(stepOnWay(d, i, w, osm.nodes) >= 0 || beside(i, w), `edge ${i} is labelled w${e.osm[i]}`);
  }
});

/** Imports a throwaway area. */
function importArea(t, id, bbox, extra = []) {
  const out = tempDir(t);
  const areas = tempDir(t);
  const file = path.join(areas, `${id}.json`);
  fs.writeFileSync(file, JSON.stringify({ id, bbox, origin: [32.075, 34.7775], title: { he: 'א', en: id }, sources: ['tlv_center'] }));
  const r = runImporter([id, '--area-file', file, '--out', out, ...extra]);
  return { r, out, file: mapOf(out, id) };
}

test('an area of open sea imports as a valid empty map, with its sea and its reports', (t) => {
  const { r, out, file } = importArea(t, 'sub_sea_only', [32.09, 34.755, 32.10, 34.757], ['--strict']);
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /no road survives/);
  const d = decodeFile(TLV, file);
  for (const name of ['juncs', 'edges', 'moves', 'blds', 'pois', 'kerbs', 'xings', 'stops', 'trees', 'lots', 'paths']) {
    assert.equal(d.t[name].n, 0, name);
  }
  assert.equal(d.t.edges.col.ptOff.length, 1);
  assert.equal(d.t.walls.n, 4);
  assert.deepEqual(Array.from(d.t.land.col.cls), [0]);
  const b = d.meta.bounds;
  const area = (b[2] - b[0]) * (b[3] - b[1]);
  const { x, y } = d.t.landPts.col;
  let twice = 0;
  for (let i = 0, j = x.length - 1; i < x.length; j = i++) twice += (x[j] * y[i] - x[i] * y[j]) / 100;
  assert.ok(twice > 0, 'CCW, like every land ring');
  assert.ok(Math.abs(twice / 2 - area) < 1, `${twice / 2} against ${area}`);
  for (const name of ['stats', 'orphans', 'diff']) assert.ok(report(out, 'sub_sea_only', name));
  assert.equal(report(out, 'sub_sea_only', 'stats').graph.scc.sccLaneKm, 0);
});

test('an inland area with no road imports with no sea', (t) => {
  const { r, file } = importArea(t, 'park_only', [32.0975, 34.7945, 32.0985, 34.796]);
  assert.equal(r.code, 0, r.out);
  const d = decodeFile(TLV, file);
  assert.equal(d.t.edges.n, 0);
  assert.equal(d.t.land.col.cls.includes(0), false);
});

test('an area outside the extract imports empty instead of crashing', (t) => {
  const { r, file } = importArea(t, 'nowhere', [32.2, 34.9, 32.21, 34.91]);
  assert.equal(r.code, 0, r.out);
  assert.equal(decodeFile(TLV, file).t.edges.n, 0);
});

test('a box holding one one-way road imports, with no AI flag on a lane that has no exit', (t) => {
  const { r, file } = importArea(t, 'one_road', [32.0752, 34.776, 32.0756, 34.7766]);
  assert.equal(r.code, 0, r.out);
  const d = decodeFile(TLV, file);
  assert.equal(d.t.edges.n, 1);
  assert.equal(d.t.moves.n, 0);
  assert.equal(d.t.edges.col.flags[0] & 24, 0);
});
