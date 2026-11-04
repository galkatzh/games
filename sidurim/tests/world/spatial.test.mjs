// tests/world/spatial.test.mjs — WP-WORLD: colliders, queries and surface, by hand on mini (ARCHITECTURE 8.6, 8.7, section 19 items 9, 11).
import assert from 'node:assert';
import { test } from 'node:test';
import { miniTLV, realTLV, sampler, craftMap, simOn } from './helpers.mjs';

const mini = miniTLV();
const M = mini.world.get('mini');
const spatial = mini.world.spatial;
const surface = mini.world.surface;
const SURF = mini.const.SURF;
const real = realTLV();
const R = real.world.get('tlv_center');

test('mini: colliders are the four buildings and four walls', () => {
  const c = M.colliders;
  assert.strictEqual(c.n, 4 * 4 + 4);
  assert.ok(c.ax instanceof Float32Array && c.owner instanceof Int32Array);
  const owners = Array.from(c.owner);
  assert.strictEqual(owners.filter((o) => o === -1).length, 4);
  for (let b = 0; b < M.blds.length; b++) assert.strictEqual(owners.filter((o) => o === b).length, 4);
});

test('real: colliders skip NO_COLLIDER buildings and name fence and bounds owners', () => {
  const c = R.colliders;
  const hollow = R.blds.filter((b) => b.flags & 1).map((b) => b.id);
  const owners = new Set(c.owner);
  for (const b of hollow) assert.ok(!owners.has(b));
  assert.ok(owners.has(-1) && owners.has(-2));
  assert.ok(hollow.length >= 80);
});

test('section 19.9: rayBlocked by hand on mini', () => {
  const ray = (a, b, c, d) => spatial.rayBlocked(M, a, b, c, d);
  // The south-east building spans x 80..120, y -120..-80.
  assert.strictEqual(ray(100, 0, 100, -200), true, 'through the building');
  assert.strictEqual(ray(100, 0, 100, -79), false, 'stops 1 m short of the wall');
  assert.strictEqual(ray(100, 0, 100, -81), true, 'ends inside');
  assert.strictEqual(ray(0, -100, 79, -100), false);
  assert.strictEqual(ray(0, -100, 81, -100), true);
  assert.strictEqual(ray(-200, -60, 200, -60), false, 'a long ray between rows');
  assert.strictEqual(ray(-200, -100, 200, -100), true, 'the same ray through two buildings');
  assert.strictEqual(ray(0, 0, 150, 150), true, 'diagonal into the north-east building');
  assert.strictEqual(ray(390, 0, 410, 0), true, 'the bounds wall blocks');
  assert.strictEqual(ray(50, 50, 50, 50), false, 'no length, no hit');
  assert.strictEqual(ray(100, -100, 110, -110), false, 'wholly inside touches no wall');
});

test('section 19.9: pointInBuilding by hand on mini', () => {
  const b = M.blds.find((x) => x.minX === 80 && x.minY === -120);
  assert.ok(b);
  assert.strictEqual(spatial.pointInBuilding(M, 100, -100), b.id);
  assert.strictEqual(spatial.pointInBuilding(M, 80.1, -119.9), b.id);
  assert.strictEqual(spatial.pointInBuilding(M, 79.9, -100), -1);
  assert.strictEqual(spatial.pointInBuilding(M, 100, -79.9), -1);
  assert.strictEqual(spatial.pointInBuilding(M, 0, 0), -1);
  assert.strictEqual(spatial.pointInBuilding(M, 1e6, 0), -1, 'off the map');
});

test('pointInBuilding honours holes, and a solid building outranks a hollow one', () => {
  const W = mini.world.build(craftMap({
    blds: [
      { ring: [[0, 0], [40, 0], [40, 40], [0, 40]], holes: [[[10, 10], [10, 30], [30, 30], [30, 10]]] },
      { ring: [[100, 0], [140, 0], [140, 40], [100, 40]], flags: 1 },
      { ring: [[110, 10], [130, 10], [130, 30], [110, 30]] }
    ]
  }));
  assert.strictEqual(spatial.pointInBuilding(W, 5, 5), 0);
  assert.strictEqual(spatial.pointInBuilding(W, 20, 20), -1, 'in the courtyard');
  assert.strictEqual(spatial.pointInBuilding(W, 105, 20), 1, 'hollow alone');
  assert.strictEqual(spatial.pointInBuilding(W, 120, 20), 2, 'solid over hollow');
  assert.strictEqual(spatial.rayBlocked(W, 95, 5, 105, 5), false, 'hollow does not block');
});

test('rayBlocked agrees with a brute-force scan', () => {
  const rnd = sampler(31);
  const c = R.colliders;
  const math = real.math;
  const b = R.bounds;
  for (let i = 0; i < 300; i++) {
    const x0 = b.minX + rnd() * (b.maxX - b.minX);
    const y0 = b.minY + rnd() * (b.maxY - b.minY);
    const a = rnd() * 6.3;
    const l = rnd() * 150;
    const x1 = x0 + Math.cos(a) * l;
    const y1 = y0 + Math.sin(a) * l;
    let want = false;
    for (let k = 0; k < c.n && !want; k++) want = math.segSegHit(x0, y0, x1, y1, c.ax[k], c.ay[k], c.bx[k], c.by[k]);
    assert.strictEqual(real.world.spatial.rayBlocked(R, x0, y0, x1, y1), want, `ray ${i}`);
  }
});

test('collidersNear has no duplicates, agrees with brute force, and stops when full', () => {
  const rnd = sampler(32);
  const c = R.colliders;
  const math = real.math;
  const b = R.bounds;
  const out = new Int32Array(4096);
  for (let i = 0; i < 60; i++) {
    const x = b.minX + rnd() * (b.maxX - b.minX);
    const y = b.minY + rnd() * (b.maxY - b.minY);
    const r = rnd() * 60;
    const n = real.world.spatial.collidersNear(R, x, y, r, out);
    const got = Array.from(out.subarray(0, n)).sort((p, q) => p - q);
    assert.strictEqual(new Set(got).size, got.length);
    const want = [];
    for (let k = 0; k < c.n; k++) if (math.pointSegDist(x, y, c.ax[k], c.ay[k], c.bx[k], c.by[k]) <= r) want.push(k);
    assert.deepStrictEqual(got, want);
  }
  const small = new Int32Array(2);
  assert.strictEqual(spatial.collidersNear(M, 100, -100, 30, small), 2);
});

test('section 19.11: no lane centreline crosses a collider on mini', () => {
  for (const lane of M.lanes) {
    for (let i = 0; i + 1 < lane.px.length; i++) {
      assert.strictEqual(spatial.rayBlocked(M, lane.px[i], lane.py[i], lane.px[i + 1], lane.py[i + 1]), false, `lane ${lane.id}`);
    }
  }
});

test('no lane centreline crosses a collider on tlv_center, and none enters a solid building', () => {
  const sp = real.world.spatial;
  const math = real.math;
  for (const lane of R.lanes) {
    for (let i = 0; i + 1 < lane.px.length; i++) {
      assert.strictEqual(sp.rayBlocked(R, lane.px[i], lane.py[i], lane.px[i + 1], lane.py[i + 1]), false, `lane ${lane.id}`);
    }
    for (let s = 0; s <= lane.len; s += 5) {
      const p = math.polyAt(lane.px, lane.py, lane.cum, s, {});
      const b = sp.pointInBuilding(R, p.x, p.y);
      assert.ok(b < 0 || (R.blds[b].flags & 1), `lane ${lane.id} at ${s}`);
    }
  }
});

test('the world.laneColliders invariant runs, passes, and caches', () => {
  const S = simOn(real, R);
  assert.deepStrictEqual(real.invariants.run(S).filter((f) => f.startsWith('world.')), []);
  assert.strictEqual(R.index.laneColliderResult, null);
});

test('the invariant reports a lane forced through a wall', () => {
  const TLV = miniTLV();
  const W = TLV.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0 }],
    blds: [{ ring: [[-5, -5], [5, -5], [5, 5], [-5, 5]] }]
  }));
  const S = simOn(TLV, W);
  const fails = TLV.invariants.run(S).filter((f) => f.startsWith('world.'));
  assert.strictEqual(fails.length, 1);
});

test('section 19.9: surface.at by hand on mini', () => {
  const at = (x, y) => surface.at(M, x, y);
  // The road north from the centre: lanes to +-3, parking strip to +-5.4, sidewalk to +-7.9.
  assert.strictEqual(at(0, 100), SURF.ROAD);
  assert.strictEqual(at(2.5, 100), SURF.ROAD, 'lane');
  assert.strictEqual(at(4.5, 100), SURF.ROAD, 'parking strip');
  assert.strictEqual(at(6.5, 100), SURF.SIDEWALK);
  assert.strictEqual(at(-6.5, 100), SURF.SIDEWALK);
  assert.strictEqual(at(40, 40), SURF.SIDEWALK, 'open ground');
  assert.strictEqual(at(0, 0), SURF.ROAD, 'junction');
  // The corner cut at the centre: inside the junction polygon, outside either road.
  assert.strictEqual(at(5.2, 5.2), SURF.ROAD);
  assert.strictEqual(at(-3000, 0), SURF.SIDEWALK, 'off the map answers with the nearest cell');
});

test('surface: land classes, and the precedence of road, sidewalk, paths, land', () => {
  const box = (x0, y0, x1, y1) => [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
  const W = mini.world.build(craftMap({
    juncs: [{ x: -100, y: -200, kind: 1 }, { x: 100, y: -200, kind: 1 }],
    edges: [{ a: 0, b: 1, swL: 2, swR: 2 }],
    land: [
      { cls: 0, poly: box(-500, 100, 500, 500) },
      { cls: 1, poly: box(-500, 60, 500, 100) },
      { cls: 2, poly: box(-300, -300, 300, 0) },
      { cls: 3, poly: box(310, -40, 360, 40) },
      { cls: 4, poly: box(-200, -60, -100, -30) },
      { cls: 5, poly: box(-420, -40, -360, 40) },
      { cls: 6, poly: box(380, -40, 420, 40) },
      { cls: 7, poly: box(430, -40, 470, 40) },
      { cls: 8, poly: box(-100, -60, -40, -30) }
    ],
    paths: [{ cls: 0, pts: [[0, -300], [0, -100]] }]
  }));
  const at = (x, y) => surface.at(W, x, y);
  assert.strictEqual(at(0, 200), SURF.WATER, 'sea');
  assert.strictEqual(at(0, 80), SURF.SAND, 'beach');
  assert.strictEqual(at(200, -100), SURF.PARK, 'park');
  assert.strictEqual(at(330, 0), SURF.PARK, 'garden');
  assert.strictEqual(at(-150, -40), SURF.WATER, 'pond in a park');
  assert.strictEqual(at(-400, 0), SURF.SIDEWALK, 'a construction site is plain ground');
  assert.strictEqual(at(400, 0), SURF.SAND);
  assert.strictEqual(at(450, 0), SURF.PARK, 'pitch');
  assert.strictEqual(at(-70, -40), SURF.SIDEWALK, 'plaza');
  assert.strictEqual(at(0, -120), SURF.SIDEWALK, 'a path beats the park');
  assert.strictEqual(at(50, -200), SURF.ROAD, 'road beats the park');
  assert.strictEqual(at(50, -196), SURF.SIDEWALK, 'a sidewalk beats the park');
});

test('surface: every lane and connector sample is ROAD on the real map', () => {
  const sf = real.world.surface;
  const math = real.math;
  let n = 0;
  for (const lane of R.lanes) {
    for (let s = 0; s <= lane.len; s += 3) {
      const p = math.polyAt(lane.px, lane.py, lane.cum, s, {});
      assert.strictEqual(sf.at(R, p.x, p.y), SURF.ROAD, `lane ${lane.id} at ${s}`);
      n++;
    }
  }
  for (const c of R.conns) {
    for (let i = 0; i < c.px.length; i++) assert.strictEqual(sf.at(R, c.px[i], c.py[i]), SURF.ROAD, `connector ${c.id}`);
  }
  assert.ok(n > 100000);
});

test('surface: a one-way as narrow as 2.6 m never falls between cells', () => {
  for (const y of [0.1, 0.9, 1.7, 2.5, 3.3]) {
    const W = mini.world.build(craftMap({
      bounds: [-200, -200, 200, 200],
      juncs: [{ x: -100, y, kind: 1 }, { x: 100, y, kind: 1 }],
      edges: [{ a: 0, b: 1, lanesB: 0, laneW: 2.6 }]
    }));
    for (let x = -80; x < 80; x += 0.7) assert.strictEqual(surface.at(W, x, y), SURF.ROAD);
    for (let x = -80; x < 80; x += 0.7) assert.strictEqual(surface.at(W, x, y + 3), SURF.SIDEWALK);
  }
});

test('surface: the real sea is water, the real streets are not, and the west is sea', () => {
  const sf = real.world.surface;
  assert.strictEqual(sf.at(R, -2100, 0), SURF.WATER);
  assert.strictEqual(sf.at(R, 500, 0) === SURF.WATER, false);
  const g = R.index.surface;
  assert.strictEqual(g.cell, 4);
  assert.strictEqual(g.nx, Math.ceil((R.bounds.maxX - R.bounds.minX) / 4));
});

test('propsNear and poisNear agree with a scan, and sensitiveNear reads raw positions', () => {
  const rnd = sampler(33);
  const b = R.bounds;
  const sp = real.world.spatial;
  for (let i = 0; i < 40; i++) {
    const x = b.minX + rnd() * (b.maxX - b.minX);
    const y = b.minY + rnd() * (b.maxY - b.minY);
    const r = rnd() * 80;
    const out = [];
    const n = sp.propsNear(R, x, y, r, out);
    assert.strictEqual(n, out.length);
    const want = R.props.filter((p) => Math.hypot(p.x - x, p.y - y) <= r).map((p) => p.id);
    assert.deepStrictEqual(out.slice().sort((p, q) => p - q), want);
    const pois = new Int32Array(512);
    const m = sp.poisNear(R, x, y, r * 2, pois);
    const wantP = R.pois.filter((p) => Math.hypot(p.x - x, p.y - y) <= r * 2).map((p) => p.id);
    assert.deepStrictEqual(Array.from(pois.subarray(0, m)).sort((p, q) => p - q), wantP);
  }
  const school = M.pois.find((p) => p.flags & mini.const.POIF.SENSITIVE);
  assert.strictEqual(spatial.sensitiveNear(M, school.x, school.y, 1), true);
  assert.strictEqual(spatial.sensitiveNear(M, school.x + 59, school.y, 60), true);
  assert.strictEqual(spatial.sensitiveNear(M, school.x + 61, school.y, 60), false);
  assert.strictEqual(spatial.sensitiveNear(M, -100, -300, 60), false);
});

test('_boxInFootprint by hand on mini: a wall, clearance, inside, outside', () => {
  const box = (x, y, h = 0) => mini.world.geom._setBox({}, x, y, h, 2, 1);
  // The north-east building spans 80 to 120 either way.
  assert.ok(spatial._boxInFootprint(M, box(78.9, 100), 0), 'its nose is through the wall');
  assert.ok(!spatial._boxInFootprint(M, box(77.9, 100), 0), 'stops 0.1 m short');
  assert.ok(spatial._boxInFootprint(M, box(77.9, 100), 0.2), 'and the clearance reaches it');
  assert.ok(spatial._boxInFootprint(M, box(100, 100), 0), 'wholly inside');
  assert.ok(!spatial._boxInFootprint(M, box(50, 50), 0.1));
  assert.ok(spatial._boxInFootprint(M, box(79.1, 100, Math.PI / 2), 0), 'heading north, 1 m to the wall');
  assert.ok(!spatial._boxInFootprint(M, box(78.9, 100, Math.PI / 2), 0), 'and 0.1 m short of it');
  assert.ok(!spatial._boxInFootprint(M, box(9999, 9999), 0), 'off the map');
});

test('_boxInFootprint: a building smaller than the box, a hole, and a hollow building', () => {
  const W = mini.world.build(craftMap({
    blds: [
      { ring: [[0, 0], [0.5, 0], [0.5, 0.5], [0, 0.5]] },
      { ring: [[20, 20], [60, 20], [60, 60], [20, 60]], holes: [[[30, 30], [30, 50], [50, 50], [50, 30]]] },
      { ring: [[-60, -60], [-40, -60], [-40, -40], [-60, -40]], flags: 1 }
    ]
  }));
  const box = (x, y) => mini.world.geom._setBox({}, x, y, 0, 2, 1);
  assert.ok(spatial._boxInFootprint(W, box(0.25, 0.25), 0), 'all of it inside the box');
  assert.strictEqual(spatial.pointInBuilding(W, 2, 1), -1);
  assert.ok(spatial._boxInFootprint(W, box(1.5, 0.25), 0), 'a corner of the car would not have found this');
  assert.ok(!spatial._boxInFootprint(W, box(40, 40), 0), 'wholly in the courtyard');
  assert.ok(spatial._boxInFootprint(W, box(31, 40), 0), 'across the courtyard wall, from inside it');
  assert.ok(spatial._boxInFootprint(W, box(25, 40), 0), 'wholly in the building itself');
  assert.ok(spatial._boxInFootprint(W, box(-50, -50), 0), 'a hollow building is still a footprint');
});

test('_boxOnConnector by hand on mini, and _inJunction', () => {
  const box = (x, y) => mini.world.geom._setBox({}, x, y, 0, 2.2, 0.9);
  assert.ok(spatial._boxOnConnector(M, box(0, 0), 0.1, 2.5), 'the middle of the signal junction');
  assert.ok(!spatial._boxOnConnector(M, box(50, 50), 0.1, 2.5));
  assert.ok(!spatial._boxOnConnector(M, box(9999, 9999), 0.1, 2.5), 'off the map');
  // One 3 m lane straight through on y = 0: 1.5 m to its edge, 0.1 m clearance and 0.9 m to the car's centre make 2.5 m.
  const straight = mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0 }, { a: 1, b: 2, lanesB: 0 }],
    moves: [[0, 2, 0]]
  }));
  assert.ok(!spatial._boxOnConnector(straight, box(0, 2.55), 0.1, 2.5));
  assert.ok(spatial._boxOnConnector(straight, box(0, 2.45), 0.1, 2.5));
  // Grid cells are 20 m from the map's edge, so y = 0 is a cell boundary. A connector on y = -0.5 is in the next row of cells
  // from a car on y = 1.9, and the search must reach it.
  const below = mini.world.build(craftMap({
    juncs: [{ x: -100, y: -0.5, kind: 1 }, { x: 0, y: -0.5, kind: 1 }, { x: 100, y: -0.5, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0 }, { a: 1, b: 2, lanesB: 0 }],
    moves: [[0, 2, 0]]
  }));
  assert.ok(spatial._boxOnConnector(below, box(0, 1.9), 0.1, 2.5));
  assert.ok(spatial._inJunction(M, 0, 0));
  assert.ok(spatial._inJunction(M, 5, 5.2));
  assert.ok(!spatial._inJunction(M, 50, 50));
  assert.ok(!spatial._inJunction(M, 9999, 9999));
  assert.ok(!spatial._inJunction(M, -9999, -9999));
});

test('_rayHits finds what rayBlocked finds, at the right place, and _inSolid agrees with pointInBuilding', () => {
  const rnd = sampler(77);
  const out = new Float64Array(512);
  const b = R.bounds;
  let hits = 0;
  for (let i = 0; i < 3000; i++) {
    const x0 = b.minX + rnd() * (b.maxX - b.minX);
    const y0 = b.minY + rnd() * (b.maxY - b.minY);
    const h = rnd() * Math.PI * 2;
    const l = 5 + rnd() * 80;
    const x1 = x0 + Math.cos(h) * l;
    const y1 = y0 + Math.sin(h) * l;
    const n = real.world.spatial._rayHits(R, x0, y0, x1, y1, out);
    assert.strictEqual(n > 0, real.world.spatial.rayBlocked(R, x0, y0, x1, y1), `ray ${i}`);
    for (let k = 0; k < n; k++) {
      hits++;
      assert.ok(out[k] >= 0 && out[k] <= 1);
      // On a wall: a step either side of each crossing crosses it, and the step is on the line.
      const px = x0 + (x1 - x0) * out[k];
      const py = y0 + (y1 - y0) * out[k];
      assert.ok(real.world.spatial.rayBlocked(R, px - Math.cos(h) * 0.05, py - Math.sin(h) * 0.05, px + Math.cos(h) * 0.05, py + Math.sin(h) * 0.05));
    }
    const id = real.world.spatial.pointInBuilding(R, x0, y0);
    assert.strictEqual(real.world.spatial._inSolid(R, x0, y0), id >= 0 && !(R.blds[id].flags & 1), `point ${i}`);
  }
  assert.ok(hits > 3000, `hits ${hits}`);
  assert.strictEqual(real.world.spatial._rayHits(R, 0, 0, 1, 0, new Float64Array(0)), 0, 'a full buffer stops, and does not throw');
});

test('surface: a land polygon paints exactly the cells whose centres it holds, concave and all', () => {
  const m = miniTLV();
  // A comb: rows through its teeth cross several edges, in no order along the polygon.
  const comb = [[-101, -93], [99, -93], [99, 87], [61, 87], [61, -21], [17, -21], [17, 87], [-27, 87], [-27, -21], [-61, -21], [-61, 87], [-101, 87]];
  const W = m.world.build(craftMap({ land: [{ cls: 2, poly: comb }] }));
  const g = W.index.surface;
  const flat = comb.flat();
  let inside = 0;
  for (let row = 0; row < g.ny; row++) {
    for (let col = 0; col < g.nx; col++) {
      const x = g.minX + (col + 0.5) * g.cell;
      const y = g.minY + (row + 0.5) * g.cell;
      const want = m.math.pointInPoly(x, y, flat);
      if (want) inside++;
      assert.strictEqual(g.base[row * g.nx + col], want ? m.const.SURF.PARK : m.const.SURF.SIDEWALK, `cell ${col}, ${row}`);
    }
  }
  assert.ok(inside > 1000, `inside ${inside}`);
});
