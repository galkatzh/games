// tests/map/anchors.test.mjs — anchor resolution, sections 12.2 and 14.2.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { ROOT, decodeFile, runtime } from './helpers.mjs';

const TLV = await runtime();
const { anchors } = TLV;
const ORIGIN = [32.075, 34.7775];

/** Lat/lon of a point given in metres. */
const at = (x, y) => [y / 110888 + ORIGIN[0], x / 94415 + ORIGIN[1]];

/** A hand-built World with the shapes in section 10.6. */
function world() {
  const square = (cx, cy, h) => new Float32Array([cx - h, cy - h, cx + h, cy - h, cx + h, cy + h, cx - h, cy + h]);
  const line = (x0, y0, x1, y1) => ({ px: new Float32Array([x0, x1]), py: new Float32Array([y0, y1]) });
  return {
    meta: { origin: ORIGIN },
    blds: [
      { osm: 100, osmT: 1, name: 'בית', nameEn: 'House', rings: [square(0, 0, 10)] },
      { osm: 15311025, osmT: 2, name: 'דיזנגוף סנטר', nameEn: 'Dizengoff Center', rings: [square(100, 0, 10)] },
      { osm: 15311025, osmT: 2, name: 'דיזנגוף סנטר', nameEn: 'Dizengoff Center', rings: [square(140, 0, 10)] },
      { osm: 300, osmT: 1, name: '', nameEn: '', rings: [square(200, 0, 10), square(200, 0, 3)] }
    ],
    pois: [
      { osm: 11238493213, osmT: 0, x: 500, y: 0, nameHe: 'קרפור', nameEn: 'Carrefour' },
      { osm: 100, osmT: 1, x: 0, y: 0, nameHe: '', nameEn: 'House cafe' }
    ],
    edges: [
      { osm: 50, a: 3, b: 7, name: 'המלך ג׳ורג׳', nameEn: 'HaMelekh George', ...line(100, 100, 200, 100) },
      { osm: 50, a: 2, b: 3, name: 'המלך ג׳ורג׳', nameEn: 'HaMelekh George', ...line(0, 100, 100, 100) },
      { osm: 50, a: 7, b: 9, name: 'המלך ג׳ורג׳', nameEn: 'HaMelekh George', ...line(200, 100, 300, 100) },
      { osm: 60, a: 9, b: 11, name: 'אחר', nameEn: 'Other', ...line(300, 100, 400, 100) }
    ]
  };
}

test('exact matches type and id, and a way id is never guessed across tables', () => {
  const W = world();
  const asBuilding = anchors.resolve(W, { osm: 'w100' }, { type: 'building' });
  const asPoi = anchors.resolve(W, { osm: 'w100' }, { type: 'poi' });
  assert.deepEqual(asBuilding, { how: 'exact', type: 'building', id: 0, ids: [0] });
  assert.deepEqual(asPoi, { how: 'exact', type: 'poi', id: 1, ids: [1] });
});

test('osm type counts: a relation id does not match a way row', () => {
  const r = anchors.resolve(world(), { osm: 'w15311025' }, { type: 'building' });
  assert.equal(r.how, 'orphan');
});

test('ids above 2^31 match exactly', () => {
  assert.equal(anchors.resolve(world(), { osm: 'n11238493213' }, { type: 'poi' }).id, 0);
});

test('a multi-row relation lists every row', () => {
  const r = anchors.resolve(world(), { osm: 'r15311025' }, { type: 'building' });
  assert.deepEqual(r.ids, [1, 2]);
  assert.equal(r.id, 1);
});

test('exact edges come back in travel order, not row order', () => {
  const r = anchors.resolve(world(), { osm: 'w50' }, { type: 'edge' });
  assert.deepEqual(r.ids, [1, 0, 2]);
  assert.equal(r.id, 1);
});

test('moved matches a normalized name within 60 m, across geresh and quote forms', () => {
  const r = anchors.resolve(world(), { osm: 'w999', name: "המלך ג'ורג'", at: at(150, 130) }, { type: 'edge' });
  assert.equal(r.how, 'moved');
  assert.equal(r.id, 0);
});

test('moved is nearest first, so id is the row at the anchor', () => {
  const r = anchors.resolve(world(), { osm: 'w999', name: 'HaMelekh George', at: at(205, 110) }, { type: 'edge' });
  assert.equal(r.how, 'moved');
  assert.equal(r.id, 2);
  assert.deepEqual(r.ids, [2, 0]);
});

test('moved does not reach past 60 m', () => {
  const r = anchors.resolve(world(), { osm: 'w999', name: 'Carrefour', at: at(570, 0) }, { type: 'poi' });
  assert.equal(r.how, 'orphan');
});

test('relocated building is point in footprint, and a hole does not count', () => {
  const W = world();
  const inside = anchors.resolve(W, { osm: 'w999', at: at(205, 5) }, { type: 'building' });
  assert.equal(inside.how, 'relocated');
  assert.equal(inside.id, 3);
  assert.equal(anchors.resolve(W, { osm: 'w999', at: at(200, 0) }, { type: 'building' }).how, 'orphan');
});

test('relocated POI and edge take the nearest row within 15 m', () => {
  const W = world();
  assert.equal(anchors.resolve(W, { osm: 'n999', at: at(510, 0) }, { type: 'poi' }).how, 'relocated');
  assert.equal(anchors.resolve(W, { osm: 'n999', at: at(517, 0) }, { type: 'poi' }).how, 'orphan');
  const e = anchors.resolve(W, { osm: 'w999', at: at(350, 110) }, { type: 'edge' });
  assert.equal(e.how, 'relocated');
  assert.equal(e.id, 3);
});

test('an orphan returns id -1 and no ids', () => {
  const r = anchors.resolve(world(), { osm: 'w999', at: at(9000, 9000), name: 'Nowhere' }, { type: 'edge' });
  assert.deepEqual(r, { how: 'orphan', type: 'edge', id: -1, ids: [] });
});

test('bad input is an orphan, never a throw', () => {
  const W = world();
  assert.equal(anchors.resolve(W, null, { type: 'edge' }).how, 'orphan');
  assert.equal(anchors.resolve(W, { osm: 'nonsense' }, { type: 'edge' }).how, 'orphan');
  assert.equal(anchors.resolve(W, { osm: 'w50' }, { type: 'nonsense' }).how, 'orphan');
  assert.equal(anchors.resolve(W, { osm: 'w50' }, {}).how, 'orphan');
  assert.equal(anchors.resolve(null, { osm: 'w50' }, { type: 'edge' }).how, 'orphan');
});

test('an adapter replaces the World, which is how the importer calls it', () => {
  const rows = [{ id: 7, x: 0, y: 0, names: ['Alpha'] }, { id: 8, x: 10, y: 0, names: ['Beta'] }];
  const index = {
    n: rows.length,
    origin: ORIGIN,
    osm: (i) => rows[i].id,
    osmT: () => 1,
    names: (i) => rows[i].names,
    dist: (i, x, y) => Math.hypot(rows[i].x - x, rows[i].y - y)
  };
  assert.equal(anchors.resolve(null, { osm: 'w8' }, { type: 'edge', index }).id, 1);
  assert.equal(anchors.resolve(null, { name: 'alpha', at: at(5, 0) }, { type: 'edge', index }).how, 'moved');
});

test('name normalization drops niqqud, geresh, punctuation and case', () => {
  assert.equal(anchors.normalizeName('  רְחוֹב   Foo-Bar! '), anchors.normalizeName('רחוב foo bar'));
  assert.equal(anchors.normalizeName('ג׳ורג׳'), anchors.normalizeName("ג'ורג'"));
  assert.equal(anchors.normalizeName(null), '');
});

test('project matches section 1.1', () => {
  const p = anchors.project(32.1, 34.8, ORIGIN);
  assert.ok(Math.abs(p.x - 2124.3375) < 1e-6);
  assert.ok(Math.abs(p.y - 2772.2) < 1e-6);
});

test('every anchor the contract names resolves exactly on tlv_center', () => {
  const d = decodeFile(TLV, path.join(ROOT, 'data/maps/tlv_center/map.js'));
  const hit = (osm, type) => anchors.resolve(null, { osm }, { type, index: anchors.decodedIndex(d, type) });
  for (const id of ['w90723265', 'w90723261', 'w90723278', 'w509799257', 'w860931326', 'w149522836', 'w284108856',
    'w31786632', 'r15311025', 'w640627236']) {
    assert.equal(hit(id, 'building').how, 'exact', id);
  }
  assert.equal(hit('n11238493213', 'poi').how, 'exact');
  assert.equal(hit('w149546103', 'poi').how, 'exact');
  assert.equal(hit('w154735772', 'edge').how, 'exact');
});
