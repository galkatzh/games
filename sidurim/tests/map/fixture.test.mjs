// tests/map/fixture.test.mjs — tests/fixtures/mini_map.js matches section 7.5 exactly.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ROOT, decodeFile, edgeLine, rows, runtime } from './helpers.mjs';

const TLV = await runtime();
const FILE = path.join(ROOT, 'tests/fixtures/mini_map.js');
const d = decodeFile(TLV, FILE);
const c = (t) => d.t[t].col;

test('the fixture is what make_fixture writes', () => {
  const before = fs.readFileSync(FILE);
  const r = spawnSync(process.execPath, [path.join(ROOT, 'tools/make_fixture.mjs')], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.deepEqual(fs.readFileSync(FILE), before);
});

test('it is a valid schema 1.0 map with id mini, encoded raw', () => {
  assert.equal(d.id, 'mini');
  assert.deepEqual(d.schema, [1, 0]);
  assert.equal(d.strings[0], '');
  assert.equal(d.meta.unit, 0.1);
  assert.deepEqual(d.meta.bounds, [-400, -400, 400, 400]);
  assert.equal(d.meta.attribution, '© OpenStreetMap contributors');
  for (const table of Object.values(d.t)) for (const col of Object.values(table.col)) assert.ok(col instanceof Float64Array);
});

test('every column has n rows, every *Off has n + 1', () => {
  for (const [name, table] of Object.entries(d.t)) {
    for (const [col, a] of Object.entries(table.col)) {
      assert.equal(a.length, col.endsWith('Off') ? table.n + 1 : table.n, `${name}.${col}`);
    }
  }
});

test('nine junctions on the grid, centre SIGNAL, north-east RING, others PRIORITY', () => {
  assert.equal(d.t.juncs.n, 9);
  for (const j of rows(d, 'juncs')) {
    assert.ok([-2000, 0, 2000].includes(j.x) && [-2000, 0, 2000].includes(j.y));
    let want = 1;
    if (j.x === 0 && j.y === 0) want = 2;
    if (j.x === 2000 && j.y === 2000) want = 3;
    assert.equal(j.kind, want, `junction ${j.x},${j.y}`);
    assert.equal(j.flags, 0);
  }
});

test('twelve straight 2-point edges, a at the west or south end', () => {
  assert.equal(d.t.edges.n, 12);
  for (const e of rows(d, 'edges')) {
    const line = edgeLine(d, e.id);
    assert.equal(line.length, 2);
    assert.ok(line[0][0] <= line[1][0] && line[0][1] <= line[1][1]);
    assert.equal(c('juncs').x[e.a], line[0][0] * 10);
    assert.equal(c('juncs').y[e.b], line[1][1] * 10);
  }
});

test('the middle east-west road is one-way east, the rest two-way, with section 7.5 attributes', () => {
  for (const e of rows(d, 'edges')) {
    const line = edgeLine(d, e.id);
    const middle = line[0][1] === 0 && line[1][1] === 0;
    assert.equal(e.cls, middle ? 2 : 4);
    assert.equal(e.kmh, middle ? 50 : 30);
    assert.equal(e.lanesF, middle ? 2 : 1);
    assert.equal(e.lanesB, middle ? 0 : 1);
    assert.equal(e.flags, middle ? 8 : 24);
    assert.equal(e.laneW, 30);
    assert.equal(e.parkL, 24);
    assert.equal(e.parkR, 24);
    assert.equal(e.swL, 25);
    assert.equal(e.swR, 25);
  }
});

test('moves are every other arm with no U-turns, sorted, with correct turn codes', () => {
  const e = c('edges');
  const end = (de) => (de & 1 ? e.a[de >> 1] : e.b[de >> 1]);
  const start = (de) => (de & 1 ? e.b[de >> 1] : e.a[de >> 1]);
  const exists = (de) => (de & 1 ? e.lanesB[de >> 1] > 0 : e.lanesF[de >> 1] > 0);
  const want = [];
  for (let f = 0; f < 24; f++) {
    for (let g = 0; g < 24; g++) {
      if (exists(f) && exists(g) && end(f) === start(g) && (f >> 1) !== (g >> 1)) want.push([f, g]);
    }
  }
  const got = rows(d, 'moves').map((m) => [m.from, m.to]);
  assert.deepEqual(got, want);
  assert.ok(rows(d, 'moves').every((m) => m.turn !== 3));
  // West mid junction, id 3: coming north up edge 6, north along edge 7 is straight and east along edge 2 is right.
  const fromSouth = 6 * 2;
  const pick = (to) => rows(d, 'moves').find((m) => m.from === fromSouth && m.to === to).turn;
  assert.equal(pick(7 * 2), 0);
  assert.equal(pick(2 * 2), 1);
});

test('one 40 m building per block, 15 m tall, residential, flat, CCW, no front', () => {
  assert.equal(d.t.blds.n, 4);
  const b = c('blds');
  const cx = [-100, 100, -100, 100];
  const cy = [-100, -100, 100, 100];
  for (let i = 0; i < 4; i++) {
    assert.equal(b.h[i], 150);
    assert.equal(b.kind[i], 1);
    assert.equal(b.roof[i], 0);
    const off = c('brings').pOff[b.rOff[i]];
    assert.deepEqual([c('bpts').x[off], c('bpts').y[off]], [(cx[i] - 20) * 10, (cy[i] - 20) * 10]);
    assert.deepEqual([c('bpts').x[off + 1], c('bpts').y[off + 1]], [(cx[i] + 20) * 10, (cy[i] - 20) * 10]);
    assert.deepEqual([c('bpts').x[off + 2], c('bpts').y[off + 2]], [(cx[i] + 20) * 10, (cy[i] + 20) * 10]);
  }
  assert.ok(Array.from(c('bpts').front).every((v) => v === 0));
});

test('one POI on each south wall, with the door 0.5 m south of the wall centre', () => {
  const p = rows(d, 'pois');
  assert.deepEqual(p.map((r) => d.strings[r.kind]), ['pharmacy', 'bakery', 'supermarket', 'school']);
  assert.deepEqual(p.map((r) => r.flags), [0, 0, 0, 4]);
  for (const r of p) {
    assert.equal(r.bld, r.id + 1);
    assert.equal(r.wall, 1);
    assert.ok(Math.abs(r.t / 255 - 0.5) < 0.005);
    assert.equal(r.w, 60);
    assert.equal(r.entX, r.x);
    assert.equal(r.entY, r.y - 5);
    const near = edgeLine(d, r.edge - 1);
    assert.equal(near[0][1], near[1][1]);
    assert.ok(r.x / 10 >= near[0][0] && r.x / 10 <= near[1][0]);
    assert.ok(near[0][1] * 10 < r.y);
  }
});

test('one crossing per edge at s = 100, one bus stop on the western south edge', () => {
  assert.equal(d.t.xings.n, 12);
  for (const x of rows(d, 'xings')) {
    assert.equal(x.s, 1000);
    const line = edgeLine(d, x.edge);
    assert.equal(x.x / 10, (line[0][0] + line[1][0]) / 2);
    assert.equal(x.y / 10, (line[0][1] + line[1][1]) / 2);
  }
  assert.equal(d.t.stops.n, 1);
  const s = rows(d, 'stops')[0];
  assert.deepEqual(edgeLine(d, s.edge), [[-200, -200], [0, -200]]);
  assert.equal(s.dir, 0);
  assert.equal(s.s, 1000);
});

test('each edge side has the five kerb rows in section 7.5', () => {
  const want = [[0, 120, 255], [120, 950, 2], [950, 1050, 255], [1050, 1880, 2], [1880, 2000, 255]];
  assert.equal(d.t.kerbs.n, 12 * 2 * 5);
  const all = rows(d, 'kerbs');
  for (let edge = 0; edge < 12; edge++) {
    for (const side of [0, 1]) {
      const list = all.filter((k) => k.edge === edge && k.side === side);
      assert.deepEqual(list.map((k) => [k.s0, k.s1, k.tier]), want);
      assert.ok(list.every((k) => k.paint === 0 && k.zone === 0));
    }
  }
});

test('four BOUNDS walls on the rectangle, and the empty tables are empty', () => {
  assert.equal(d.t.walls.n, 4);
  assert.ok(Array.from(c('walls').kind).every((k) => k === 0));
  assert.deepEqual(Array.from(c('wallPts').x), [-4000, 4000, 4000, 4000, 4000, -4000, -4000, -4000]);
  assert.deepEqual(Array.from(c('wallPts').y), [-4000, -4000, -4000, 4000, 4000, 4000, 4000, -4000]);
  for (const t of ['trees', 'lots', 'land', 'paths', 'lotPts', 'landPts', 'pathPts']) assert.equal(d.t[t].n, 0, t);
});
