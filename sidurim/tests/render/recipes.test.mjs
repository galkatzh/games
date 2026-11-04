// tests/render/recipes.test.mjs — WP-RENDER
import test from 'node:test';
import assert from 'node:assert';
import { createTLV } from '../../tools/lib/classic.mjs';
import { pureTLV } from './helpers.mjs';

const ROW = { NO_COLLIDER: 1 };

test('recipes load and run in Node, with no THREE, on mini', () => {
  const TLV = createTLV({ files: ['sim', 'js/render/city/recipes.js'], map: 'tests/fixtures/mini_map.js' });
  const W = TLV.world.get('mini');
  assert.strictEqual(typeof globalThis.THREE, 'undefined');
  const parts = TLV.render.city.recipes.building(W, 0, null);
  assert.strictEqual(parts.form, 'solid');
  assert.strictEqual(parts.top, 15, 'the fixture says 15 m');
  assert.strictEqual(parts.walls.length, 4);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(parts)), parts, 'Parts is plain data');
});

test('a wall gets a whole number of bays, so windows never cut', () => {
  const TLV = createTLV({ files: ['sim', 'js/render/city/recipes.js'], map: 'tests/fixtures/mini_map.js' });
  const W = TLV.world.get('mini');
  const parts = TLV.render.city.recipes.building(W, 0, null);
  for (const w of parts.walls) {
    assert.ok(Number.isInteger(w.bays));
    assert.strictEqual(w.bays, Math.round(40 / 3.4), 'the fixture building is 40 m on a side');
  }
  assert.ok(Number.isInteger(parts.upperFloors));
});

test('walls face outward: on an outer ring the outward normal leaves the footprint', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const R = TLV.render.city.recipes;
  for (let id = 0; id < W.blds.length; id += 37) {
    const b = W.blds[id];
    const parts = R.building(W, id, null);
    for (const w of parts.walls) {
      if (w.ring !== 0 || w.len < 2) continue;
      const mx = (w.ax + w.bx) / 2, my = (w.ay + w.by) / 2;
      assert.ok(!R.inRing(mx + w.nx * 0.05, my + w.ny * 0.05, b.rings[0]) || R.inRing(mx - w.nx * 0.05, my - w.ny * 0.05, b.rings[0]));
    }
  }
});

test('a row height is stable, from its OSM ID and not its row', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const R = TLV.render.city.recipes;
  const b = W.blds.find((x) => !x.h && !(x.flags & ROW.NO_COLLIDER) && R.area(W, x) > 150);
  const moved = { ...b, id: W.blds.length - 1 };
  assert.deepStrictEqual(R.heights(W, moved).top, R.heights(W, b).top);
});

test('no NO_COLLIDER row stands solid from the ground', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const R = TLV.render.city.recipes;
  let lifted = 0;
  let canopy = 0;
  for (const b of W.blds) {
    if (!(b.flags & ROW.NO_COLLIDER)) {
      assert.strictEqual(R.form(W, b), 'solid');
      continue;
    }
    const h = R.heights(W, b);
    assert.notStrictEqual(h.form, 'solid', `row ${b.id}`);
    if (h.form === 'lifted') {
      lifted++;
      assert.ok(h.base >= 5 && h.base <= 6, `base ${h.base}`);
      assert.ok(h.top > h.base);
    } else {
      canopy++;
      assert.ok(h.top - h.base < 0.5, 'a canopy is a thin slab');
    }
  }
  assert.strictEqual(lifted + canopy, 97);
  assert.strictEqual(canopy, 41, 'all 41 canopy rows of the map report');
});

test('Dizengoff Center bridges and the Atarim deck are lifted over the street', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const R = TLV.render.city.recipes;
  const rows = TLV.anchors.resolve(W, { osm: 'r15311025' }, { type: 'building' }).ids;
  assert.strictEqual(rows.length, 4);
  const bridges = rows.filter((id) => W.blds[id].flags & ROW.NO_COLLIDER);
  assert.ok(bridges.length >= 2);
  for (const id of bridges) assert.strictEqual(R.heights(W, W.blds[id]).form, 'lifted');
  const near = (x, y) => bridges.some((id) => Math.hypot(W.blds[id].cx - x, W.blds[id].cy - y) < 20);
  assert.ok(near(-185, 8) && near(-232, 67));
  const atarim = TLV.anchors.resolve(W, { osm: 'w765979741' }, { type: 'building' }).ids[0];
  assert.strictEqual(R.heights(W, W.blds[atarim]).form, 'lifted');
});

test('a post never stands on the road', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const R = TLV.render.city.recipes;
  const ROAD = TLV.const.SURF.ROAD;
  let posts = 0;
  for (const b of W.blds) {
    if (!(b.flags & ROW.NO_COLLIDER)) continue;
    const p = R.building(W, b.id, TLV.render.styles.choose(W, b.id)).posts;
    for (let i = 0; i < p.length; i += 2) {
      assert.notStrictEqual(TLV.world.surface.at(W, p[i], p[i + 1]), ROAD);
      posts++;
    }
  }
  assert.ok(posts > 100, `${posts} posts`);
});

test('swapping one slot leaves every other slot as it was', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const R = TLV.render.city.recipes;
  const id = W.blds.findIndex((b) => b.front && b.front.some((f) => f > 0) && R.area(W, b) > 200 && !(b.flags & ROW.NO_COLLIDER));
  const style = TLV.render.styles.choose(W, id);
  const before = R.building(W, id, style);
  const def = TLV.render.styles.get(style);
  const slots = def.slots;
  def.slots = { ...slots, 'bld.rooftop': [] };
  const after = R.building(W, id, style);
  def.slots = slots;
  const roofOnly = (list) => list.filter((i) => i.z < before.top - 0.01);
  assert.deepStrictEqual(roofOnly(after.instances), roofOnly(before.instances), 'wall details are untouched');
  assert.strictEqual(after.tint, before.tint);
});

test('a throwing provider is caught, and the built-in carries on', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const R = TLV.render.city.recipes;
  TLV.render.styles.onKit({ slot: 'bld.rooftop', id: 'bad', priority: 99, emit() { throw new Error('boom'); } });
  TLV.render.styles.onStyle({ id: 'test_bad', tiles: { wall: 'wall_default' }, palette: ['#ffffff'], bayM: 3.4, floorM: 3.1, slots: { 'bld.rooftop': ['bad'] } });
  const id = W.blds.findIndex((b) => R.area(W, b) > 400 && !b.roof && !(b.flags & 3));
  const parts = R.building(W, id, 'test_bad');
  assert.ok(parts.instances.some((i) => i.mesh === 'boiler'), 'the built-in ran');
  assert.ok(TLV.registry.problems().some((p) => p.id === 'bad'));
});

test('walls follow the footprint exactly, on every ring', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const R = TLV.render.city.recipes;
  for (let id = 0; id < W.blds.length; id += 11) {
    const b = W.blds[id];
    const parts = R.building(W, id, TLV.render.styles.choose(W, id));
    for (const w of parts.walls) {
      const r = b.rings[w.ring];
      const n = r.length >> 1;
      assert.strictEqual(w.ax, r[w.i * 2]);
      assert.strictEqual(w.ay, r[w.i * 2 + 1]);
      assert.strictEqual(w.bx, r[((w.i + 1) % n) * 2]);
      assert.strictEqual(w.by, r[((w.i + 1) % n) * 2 + 1]);
    }
  }
});

test('Azrieli keeps its three tower heights and shapes', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const R = TLV.render.city.recipes;
  const row = (osm) => W.blds[TLV.anchors.resolve(W, { osm }, { type: 'building' }).id];
  assert.strictEqual(R.heights(W, row('w90723265')).top, 187);
  assert.strictEqual(R.heights(W, row('w90723261')).top, 169);
  assert.strictEqual(R.heights(W, row('w90723278')).top, 154);
  assert.ok(row('w90723265').rings[0].length / 2 >= 12, 'the circular tower is round');
  assert.strictEqual(row('w90723261').rings[0].length / 2, 3, 'the triangular tower has three walls');
  assert.strictEqual(row('w90723278').rings[0].length / 2, 4, 'the square tower has four');
});

test('the sea lies west of the city', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const { WATER } = TLV.const.SURF;
  assert.strictEqual(TLV.world.surface.at(W, W.bounds.minX + 30, 0), WATER);
  assert.notStrictEqual(TLV.world.surface.at(W, W.bounds.maxX - 30, 0), WATER);
});
