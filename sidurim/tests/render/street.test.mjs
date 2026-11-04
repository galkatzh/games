// tests/render/street.test.mjs — WP-RENDER
// What stands between the kerb and the wall: shop tiles by POI, forecourts and gardens, medians, boulevards.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTLV } from '../../tools/lib/classic.mjs';
import { PURE, pureTLV } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @returns {object} A TLV with the road module, on the real map. */
function roadsTLV() {
  const TLV = createTLV({ files: [...PURE, 'js/render/roads.js'], map: 'tlv_center', content: false, allowMissing: true });
  const W = TLV.world.get('tlv_center');
  TLV.render.roads.reset(W);
  return { TLV, W };
}

test('a POI gets the tile of its kind, under its own sign', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const R = TLV.render.city.recipes;
  const S = TLV.render.styles;
  const want = { cafe: 'shop_cafe', restaurant: 'shop_cafe', bank: 'shop_bank', pharmacy: 'shop_pharmacy', clothes: 'shop_clothes', supermarket: 'shop_grocery' };
  const seen = {};
  for (const p of W.pois) {
    const tile = want[p.kind];
    if (!tile || seen[p.kind] >= 10 || p.bld < 0 || p.wall < 0 || (p.flags & (TLV.const.POIF.INTERIOR | TLV.const.POIF.SENSITIVE))) continue;
    const style = S.choose(W, p.bld);
    if (S.get(style).shopChance === 0) continue;
    const wall = R.building(W, p.bld, style).walls.find((w) => w.ring === 0 && w.i === p.wall);
    if (wall.plain || !wall.groundRuns) continue;
    const bay = Math.min(wall.bays - 1, Math.floor(p.t * wall.bays));
    const run = wall.groundRuns.find((r) => r.from <= bay && bay < r.to);
    // Two POIs can share a bay, and the first keeps it, so ask only that some POI of this tile holds the wall.
    assert.ok(wall.groundRuns.some((r) => r.tile === tile), `${p.kind} on building ${p.bld}: ${JSON.stringify(wall.groundRuns)}`);
    assert.ok(run, 'the bay is covered');
    seen[p.kind] = (seen[p.kind] || 0) + 1;
  }
  for (const k of Object.keys(want)) assert.strictEqual(seen[k], 10, k);
});

test('shop runs cover every bay of a wall once, and no city wall is one endless window', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const R = TLV.render.city.recipes;
  const S = TLV.render.styles;
  const tiles = {};
  for (let i = 0; i < W.blds.length; i += 3) {
    for (const w of R.building(W, i, S.choose(W, i)).walls) {
      if (!w.groundRuns) continue;
      let at = 0;
      for (const r of w.groundRuns) {
        assert.strictEqual(r.from, at);
        assert.ok(r.to > r.from);
        at = r.to;
        tiles[r.tile] = (tiles[r.tile] || 0) + r.to - r.from;
      }
      assert.strictEqual(at, w.bays);
    }
  }
  const total = Object.values(tiles).reduce((a, b) => a + b, 0);
  assert.ok(Object.keys(tiles).length >= 7, Object.keys(tiles).join());
  for (const [k, n] of Object.entries(tiles)) assert.ok(n / total < 0.4, `${k} is ${Math.round(n / total * 100)}% of all shop bays`);
});

test('a school or a place of worship does not become a shop', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const R = TLV.render.city.recipes;
  const list = R.poisOf(W);
  for (const rows of list.values()) for (const p of rows) assert.strictEqual(p.flags & TLV.const.POIF.SENSITIVE, 0);
});

test('a style with no shops keeps its own walls', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const b = W.blds.find((x) => x.osm === 149522836);    // Habima
  const parts = TLV.render.city.recipes.building(W, b.id, 'civic_white');
  for (const w of parts.walls) assert.strictEqual(w.groundRuns, null);
});

test('shop walls are paved to the door, and the rest get a garden with a low wall off the road', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const R = TLV.render.city.recipes;
  const S = TLV.render.styles;
  let shops = 0, gardens = 0, lows = 0;
  for (let i = 0; i < W.blds.length; i += 2) {
    const id = S.choose(W, i);
    for (const f of R.frontage(W, i, id)) {
      assert.ok(f.far >= f.near, 'a row has a range');
      if (f.shop) {
        shops++;
        assert.strictEqual(R.gardenDepth(f), 0, 'no garden in front of a shop');
      } else if (R.gardenDepth(f)) {
        gardens++;
        assert.ok(R.gardenDepth(f) <= f.near, 'a garden stops at the sidewalk');
      }
    }
    const p = R.building(W, i, id);
    for (let o = 0; o + 5 < p.lowWalls.length; o += 6) {
      lows++;
      const [ax, ay, bx, by] = p.lowWalls.slice(o, o + 4);
      assert.notStrictEqual(TLV.world.surface.at(W, (ax + bx) / 2, (ay + by) / 2), TLV.const.SURF.ROAD);
    }
  }
  assert.ok(shops > 1000, `shops ${shops}`);
  assert.ok(gardens > 4000, `gardens ${gardens}`);
  assert.ok(lows > 4000, `low walls ${lows}`);
});

test('Ibn Gabirol has a real median: no carriageway pair leaves bare ground', () => {
  const { TLV, W } = roadsTLV();
  const R = TLV.render.roads;
  let rows = 0;
  let flips = 0;
  for (const e of W.edges) {
    if (e.nameEn !== 'Ibn Gabirol') continue;
    for (const side of [0, 1]) {
      const list = R._medianRows(W, e, side);
      rows += list.length;
      for (let i = 1; i < list.length; i++) if (list[i].raised !== list[i - 1].raised) flips++;
    }
  }
  assert.ok(rows > 50, `rows ${rows}`);
  assert.ok(flips <= rows * 0.06, `${flips} flips in ${rows} rows: a stretch must not alternate`);
});

test('every boulevard strip has a walkway and a canopy, and Rothschild is one', () => {
  const { TLV, W } = roadsTLV();
  const strips = TLV.render.roads.strips(W);
  assert.ok(strips.length >= 3, `strips ${strips.length}`);
  // A cross street ends a stretch, so the boulevard is several, between these corners.
  const roth = strips.filter((s) => s.x[0] > -30 && s.x[0] < 180 && s.y[0] > -1010 && s.y[0] < -330);
  assert.ok(roth.length >= 3, `Sderot Rothschild has ${roth.length} stretches`);
  const all = roth.flatMap((s) => s.records);
  const trees = all.filter((r) => r.mesh === 'ficus');
  assert.ok(trees.length >= 100, `trees ${trees.length}`);
  assert.ok(all.some((r) => r.mesh === 'kiosk'), 'kiosks');
  assert.ok(all.some((r) => r.mesh === 'bench'), 'benches');
  for (const s of roth) {
    for (const r of s.records) {
      let best = Infinity;
      for (let i = 0; i < s.x.length; i++) best = Math.min(best, Math.hypot(s.x[i] - r.x, s.y[i] - r.y));
      assert.ok(best >= s.half - 0.05, `${r.mesh} stands ${best.toFixed(2)} m from the spine: the walkway stays clear to drive`);
    }
  }
});

test('Fire and Water carries nothing on its roof', () => {
  const src = fs.readFileSync(path.join(ROOT, 'content/tlv_center/landmarks.js'), 'utf8');
  assert.match(src, /w1019049235/);
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const b = W.blds.find((x) => x.osm === 1019049235);
  const parts = TLV.render.city.recipes.building(W, b.id, 'fountain_agam');
  assert.deepStrictEqual(parts.instances, []);
});

test('parked paint is the live paint, so a car keeps its colour when it pulls out', () => {
  const src = fs.readFileSync(path.join(ROOT, 'js/render/vehicles.js'), 'utf8');
  const TLV = pureTLV();
  const paint = TLV.tune.render.parkedPaint;
  for (const kind of ['hatch', 'taxi']) {
    const row = src.match(new RegExp(`\\b${kind}: \\[((?:'#[0-9a-f]{6}',? ?)+)\\]`));
    assert.ok(row, kind);
    const live = row[1].match(/#[0-9a-f]{6}/g).map((h) => parseInt(h.slice(1), 16));
    assert.deepStrictEqual(paint[kind], live, kind);
  }
  assert.deepStrictEqual(paint.sedan, TLV.tune.render.parkedPalette);
  const trafficSrc = fs.readFileSync(path.join(ROOT, 'js/sim/traffic/traffic.js'), 'utf8');
  assert.match(trafficSrc, /var kinds = \['sedan', 'hatch', 'taxi'\];/, 'details.js copies this order');
});

const TLV_INTERIOR = 2, TLV_SENSITIVE = 4;   // POIF, core/constants.js

/** @returns {object} A TLV with roads and the shipped content, on the real map. */
function fullTLV() {
  const TLV = createTLV({ files: [...PURE, 'js/render/roads.js'], map: 'tlv_center', content: true, allowMissing: true });
  const S = TLV.render.styles;
  TLV.registry.on('style', S.onStyle);
  TLV.registry.on('kit', S.onKit);
  TLV.registry.on('mesh', S.onMesh);
  TLV.registry.on('district', S.onDistrict);
  TLV.registry.drain();
  const W = TLV.world.get('tlv_center');
  TLV.render.roads.reset(W);
  return { TLV, W, S, R: TLV.render.city.recipes, RD: TLV.render.roads };
}

test('no curb lies across another road, and none reaches back to the map origin', () => {
  const { TLV, W, RD } = fullTLV();
  const faces = RD._curbFaces(W);
  const arms = (J) => [...new Set([...J.inDir, ...J.outDir].filter((d) => W.dirEdges[d]).map((d) => W.dirEdges[d].edge))];
  let on = 0;
  for (const f of faces) {
    const L = Math.hypot(f.x1 - f.x0, f.y1 - f.y0);
    if (f.edge >= 0) {
      // Both ends of a face are on its own kerb. A slice that opens on two equal points once drew it from 0,0.
      const e = W.edges[f.edge];
      for (const [x, y] of [[f.x0, f.y0], [f.x1, f.y1]]) {
        const d = TLV.math.polyProject(e.px, e.py, e.cum, x, y, -1, {}).d;
        assert.ok(d < Math.max(e.kerbOffL, e.kerbOffR) + 1.5, `a curb face of edge ${f.edge} ends ${d.toFixed(0)} m off its road, at ${x},${y}`);
      }
    }
    const steps = Math.max(1, Math.round(L));
    const list = f.junc >= 0 ? arms(W.juncs[f.junc]) : null;
    // The gate measures 0.7 m in from a road's edge, a little looser than the 0.5 m the cut works to, so a sample on the line stays out.
    for (let k = 0; k < steps; k++) {
      const t = (k + 0.5) / steps;
      if (RD._onOtherRoad(W, f.x0 + (f.x1 - f.x0) * t, f.y0 + (f.y1 - f.y0) * t, f.edge, f.junc, list, 0.7)) on += L / steps;
    }
  }
  assert.ok(on < 150, `${on.toFixed(0)} m of curb on another road`);
  assert.ok(faces.length > 30000, `only ${faces.length} faces: the kerbs have gone`);
});

test('two buildings never wall one plane: each stretch has one owner, at the storeys and at the ground floor', () => {
  const { W, S, R } = fullTLV();
  const G = 12, grid = new Map(), spans = [];
  const kept = (cuts) => {
    const out = [];
    let f = 0;
    for (let i = 0; cuts && i + 1 < cuts.length; i += 2) {
      if (cuts[i] > f) out.push([f, cuts[i]]);
      f = Math.max(f, cuts[i + 1]);
    }
    if (f < 1) out.push([f, 1]);
    return out;
  };
  const push = (id, w, a, e, z0, z1) => {
    const dx = w.bx - w.ax, dy = w.by - w.ay;
    const s = { id, ax: w.ax + dx * a, ay: w.ay + dy * a, bx: w.ax + dx * e, by: w.ay + dy * e, z0, z1 };
    s.L = Math.hypot(s.bx - s.ax, s.by - s.ay);
    if (s.L < 0.3) return;
    s.ux = (s.bx - s.ax) / s.L;
    s.uy = (s.by - s.ay) / s.L;
    const at = spans.push(s) - 1;
    for (let k = 0, n = Math.ceil(s.L / 6); k <= n; k++) {
      const K = Math.floor((s.ax + (s.bx - s.ax) * k / n) / G) * 100003 + Math.floor((s.ay + (s.by - s.ay) * k / n) / G);
      if (!grid.has(K)) grid.set(K, new Set());
      grid.get(K).add(at);
    }
  };
  let dropped = 0;
  for (let id = 0; id < W.blds.length; id++) {
    const p = R.building(W, id, S.choose(W, id));
    for (const w of p.walls) {
      dropped += w.cutUpper ? 1 : 0;
      const solid = p.form === 'solid';
      for (const [a, e] of kept(w.cutUpper)) push(id, w, a, e, solid ? p.groundTop : p.base, p.top);
      if (solid) for (const [a, e] of kept(w.cutGround)) push(id, w, a, e, 0, p.groundTop);
    }
  }
  assert.ok(dropped > 300, `only ${dropped} walls gave way: the map has about 379 overlapping pairs`);
  const bad = new Set();
  for (const cell of grid.values()) {
    const a = [...cell];
    for (let i = 0; i < a.length; i++) {
      for (let j = i + 1; j < a.length; j++) {
        const p = spans[a[i]], q = spans[a[j]];
        if (p.id === q.id || Math.min(p.z1, q.z1) - Math.max(p.z0, q.z0) < 0.02 || p.ux * q.ux + p.uy * q.uy < 0.9994) continue;
        const d0 = (q.ax - p.ax) * -p.uy + (q.ay - p.ay) * p.ux, d1 = (q.bx - p.ax) * -p.uy + (q.by - p.ay) * p.ux;
        if (Math.abs(d0) > 0.12 || Math.abs(d1) > 0.12) continue;
        const s0 = (q.ax - p.ax) * p.ux + (q.ay - p.ay) * p.uy, s1 = (q.bx - p.ax) * p.ux + (q.by - p.ay) * p.uy;
        if (Math.min(p.L, Math.max(s0, s1)) - Math.max(0, Math.min(s0, s1)) >= 0.3) bad.add(`${p.id}:${q.id}`);
      }
    }
  }
  assert.strictEqual(bad.size, 0, [...bad].slice(0, 6).join(' '));
});

test('a mapped shop keeps its front when two buildings share the wall', () => {
  const { W, S, R } = fullTLV();
  const on = (cuts, t) => {
    for (let i = 0; cuts && i + 1 < cuts.length; i += 2) if (t > cuts[i] && t < cuts[i + 1]) return true;
    return false;
  };
  let shared = 0, lost = 0, swapped = 0;
  for (const p of W.pois) {
    if (p.bld < 0 || p.wall < 0 || (p.flags & (TLV_INTERIOR | TLV_SENSITIVE))) continue;
    const parts = R.building(W, p.bld, S.choose(W, p.bld));
    const w = parts.walls.find((v) => v.ring === 0 && v.i === p.wall);
    if (!w || !on(w.cutUpper, p.t)) continue;
    // This building gave up the storeys here, so it is the shorter one: its shop should have kept the ground floor all the same.
    shared++;
    if (on(w.cutGround, p.t)) lost++;
    else swapped++;
  }
  assert.ok(shared >= 10, `${shared} POIs on a stretch their building gave up`);
  // A low building's ground floor is shorter than its neighbour's and cannot stand in for it, and two shops can face off: those lose.
  assert.ok(swapped > lost, `${swapped} shops kept their front, ${lost} did not`);
});

test('no low wall stands in front of a shop, and every one has a planted bed behind it', () => {
  const { TLV, W, S, R, RD } = fullTLV();
  const rowsAll = [];
  let walls = 0;
  for (let id = 0; id < W.blds.length; id++) {
    const parts = R.building(W, id, S.choose(W, id));
    const style = S.get(parts.style) || {};
    for (let o = 0; o + 5 < parts.lowWalls.length; o += 6) {
      const [ax, ay, bx, by, nx, ny] = parts.lowWalls.slice(o, o + 6);
      const L = Math.hypot(bx - ax, by - ay);
      assert.ok(L >= 3 - 1e-3, `a stub ${L.toFixed(2)} m long on building ${id}`);
      walls++;
      for (const t of [0, 0.5, 1]) {
        const x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
        assert.ok(!RD.paved(W, x, y), `a low wall on paving at ${x.toFixed(1)},${y.toFixed(1)}`);
        assert.ok(!RD.paved(W, x - nx * 0.3, y - ny * 0.3), `no bed behind a low wall at ${x.toFixed(1)},${y.toFixed(1)}`);
      }
      const rows = R.frontage(W, id, parts.style).filter((f) => !f.shop);
      assert.ok(rows.length, `building ${id}, style ${style.id}, has a low wall and no garden`);
    }
    rowsAll.push(...R.frontage(W, id, parts.style).filter((f) => f.shop));
  }
  assert.ok(walls > 500, `only ${walls} low walls`);
  assert.ok(rowsAll.length > 500);
  void TLV;
});

test('clutter stands off every walking line and off the road, and stays out of buildings', () => {
  const { TLV, W, S, RD } = fullTLV();
  const T = TLV.tune.render.clutter;
  const P = TLV.tune.peds;
  const recs = [];
  const emit = (mesh, x, y, yaw, tint) => recs.push({ mesh, x, y, yaw, tint });
  for (let id = 0; id < W.blds.length; id++) RD.clutterOfBuilding(W, id, S.choose(W, id), emit);
  for (let j = 0; j < W.juncs.length; j++) RD.clutterOfJunction(W, j, emit);
  const by = {};
  for (const r of recs) by[r.mesh] = (by[r.mesh] || 0) + 1;
  for (const m of ['cafe_set', 'bin', 'bike_rack', 'scooter', 'e_scooter', 'elec_box', 'street_sign']) assert.ok(by[m] >= 40, `${m}: ${by[m]}`);
  const walkHalf = P.latMax + P.walkerR;
  const q = {};
  for (const r of recs) {
    const rad = T.radius[r.mesh];
    if (r.mesh !== 'cafe_shade') {
      const n = TLV.world.sidewalks.nearest(W, r.x, r.y, q);
      assert.ok(!n || n.d >= walkHalf + rad, `${r.mesh} ${n && n.d.toFixed(2)} m from a walking line, at ${r.x.toFixed(1)},${r.y.toFixed(1)}`);
    }
    assert.notStrictEqual(TLV.world.surface.at(W, r.x, r.y), TLV.const.SURF.ROAD, `${r.mesh} on the road`);
    assert.ok(!RD._onOtherRoad(W, r.x, r.y, -1, -1, null, 0), `${r.mesh} on a carriageway at ${r.x.toFixed(1)},${r.y.toFixed(1)}`);
    assert.strictEqual(TLV.world.spatial.pointInBuilding(W, r.x, r.y), -1, `${r.mesh} in a building`);
  }
});

test('sunshades stand on sand', () => {
  const { TLV, W, RD } = fullTLV();
  const b = W.bounds;
  const recs = [];
  RD.beachOf(W, b.minX, b.minY, b.maxX, b.maxY, (mesh, x, y) => recs.push({ mesh, x, y }));
  const shades = recs.filter((r) => r.mesh === 'umbrella');
  assert.ok(shades.length >= 40, `sunshades ${shades.length}`);
  for (const r of shades) assert.strictEqual(TLV.world.surface.at(W, r.x, r.y), TLV.const.SURF.SAND);
});

// Section 18 gives the background build 4 ms a frame, and a slice is only as exact as its longest step. These count work, not time.

/** @returns {object} A TLV that can run a whole chunk's ground in Node. */
function fillTLV() {
  const TLV = createTLV({ files: [...PURE, 'js/render/coords.js', 'js/render/ground.js', 'js/render/roads.js'], map: 'tlv_center', content: false, allowMissing: true });
  const W = TLV.world.get('tlv_center');
  TLV.render.roads.reset(W);
  return { TLV, W };
}

test('the slow reads of a building are cut into steps, so none of them is a whole building at once', () => {
  const { TLV, W } = fillTLV();
  const R = TLV.render.city.recipes;
  const S = TLV.render.styles;
  const RD = TLV.render.roads;
  const SW = TLV.world.sidewalks;
  const nearest = SW.nearest;
  let wide = 0;
  SW.nearest = function (...args) {
    wide++;
    return nearest.apply(this, args);
  };
  // A read is a point asked of the sidewalks, by either road: the sim's search over whole rows, or the short one from the index.
  const reads = () => wide + RD._walkReads();
  let worst = 0;
  let total = 0;
  for (let id = 0; id < W.blds.length; id++) {
    const style = S.choose(W, id);
    const it = R.buildingSteps(W, id, style);
    for (let r = null; !r || !r.done;) {
      const before = reads();
      r = it.next();
      worst = Math.max(worst, reads() - before);
      total += reads() - before;
    }
    const before = reads();
    R.building(W, id, style);
    assert.strictEqual(reads() - before, 0, `building ${id} read sidewalks again after its steps`);
  }
  // Uncut, one building reads 603 at most. 216 is what the walls of the busiest row cost in one step.
  assert.ok(total > 100000, `${total} reads: this has to be measuring the real thing`);
  assert.ok(worst <= 256, `${worst} sidewalk reads in one step`);
  assert.strictEqual(wide, 0, 'no step of a building falls back on the search over whole rows: that was a fifth of the build');
});

test('the sidewalk index gives the answer sidewalks.nearest gives, row and distance, as far as a read asks', () => {
  const { TLV, W } = fillTLV();
  const RD = TLV.render.roads;
  const SW = TLV.world.sidewalks;
  const hash = TLV.rng.hash32;
  const b = W.bounds;
  const q = { sw: 0, s: 0, d: 0 };
  let found = 0;
  let empty = 0;
  const check = (x, y) => {
    const n = SW.nearest(W, x, y, q);
    for (const R of [1.8, 6, 21.76]) {
      const got = RD._walkNear(W, x, y, R);
      if (n && n.d <= R) {
        assert.ok(got, `nothing at ${x},${y} within ${R}, and a row ${n.d} m off`);
        assert.strictEqual(got.d, n.d, `distance at ${x},${y}`);
        assert.strictEqual(got.sw, n.sw, `row at ${x},${y}`);
        found++;
      } else {
        assert.strictEqual(got, null, `${x},${y} within ${R}`);
        empty++;
      }
    }
  };
  // Anywhere on the map, and just beside each row, where the answers are close together and a tie between two rows can happen.
  for (let i = 0; i < 12000; i++) check(b.minX + (hash(i, 1) / 4294967296) * (b.maxX - b.minX), b.minY + (hash(i, 2) / 4294967296) * (b.maxY - b.minY));
  for (let i = 0; i < W.sidewalks.length; i += 3) {
    const sw = W.sidewalks[i];
    check(sw.px[0], sw.py[0]);
    check(sw.px[sw.px.length - 1] + 0.7, sw.py[sw.py.length - 1] - 1.1);
  }
  assert.ok(found > 8000 && empty > 8000, `${found} found, ${empty} empty: both answers have to be tested`);
});

test('a kerb read through the indexes matches a plain read of every road beside it', () => {
  const { TLV, W } = fillTLV();
  const RD = TLV.render.roads;
  const K = TLV.tune.render.kerbCut;
  const math = TLV.math;
  // The rule as first written, on plain cell lists, with nothing filtered: the indexes must only ever save reading, never change the answer.
  const CELL = 32;
  const key = (cx, cy) => (cx + 512) * 4096 + cy + 512;
  const segs = new Map(), juncs = new Map(), conns = new Map();
  const file = (map, v, x0, y0, x1, y1) => {
    for (let cx = Math.floor(x0 / CELL); cx <= Math.floor(x1 / CELL); cx++) {
      for (let cy = Math.floor(y0 / CELL); cy <= Math.floor(y1 / CELL); cy++) {
        if (!map.has(key(cx, cy))) map.set(key(cx, cy), []);
        map.get(key(cx, cy)).push(v);
      }
    }
  };
  W.edges.forEach((e, id) => {
    for (let i = 0; i + 1 < e.px.length; i++) file(segs, [id, i], Math.min(e.px[i], e.px[i + 1]), Math.min(e.py[i], e.py[i + 1]), Math.max(e.px[i], e.px[i + 1]), Math.max(e.py[i], e.py[i + 1]));
  });
  W.juncs.forEach((J, id) => {
    if (!J.poly || J.poly.length < 6) return;
    const xs = Array.from(J.poly).filter((v, i) => !(i & 1)), ys = Array.from(J.poly).filter((v, i) => i & 1);
    file(juncs, id, Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys));
  });
  W.conns.forEach((c, id) => {
    if (c.px.length >= 3) file(conns, id, Math.min(...c.px) - 3, Math.min(...c.py) - 3, Math.max(...c.px) + 3, Math.max(...c.py) + 3);
  });
  const inPoly = (x, y, r) => {
    let c = false;
    const n = r.length >> 1;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const yi = r[i * 2 + 1], yj = r[j * 2 + 1];
      if ((yi > y) !== (yj > y) && x < (r[j * 2] - r[i * 2]) * (y - yi) / (yj - yi) + r[i * 2]) c = !c;
    }
    return c;
  };
  const deep = (x, y, r, m) => {
    if (!inPoly(x, y, r)) return false;
    const n = r.length >> 1;
    let least = Infinity;
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const ax = r[j * 2], ay = r[j * 2 + 1], dx = r[i * 2] - ax, dy = r[i * 2 + 1] - ay, LL = dx * dx + dy * dy;
      const t = LL > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / LL)) : 0;
      least = Math.min(least, (ax + dx * t - x) ** 2 + (ay + dy * t - y) ** 2);
    }
    return least >= m * m;
  };
  const q = { s: 0, d: 0, side: 0 };
  const onOther = (x, y, self) => {
    const cx = Math.floor(x / CELL), cy = Math.floor(y / CELL);
    for (const j of juncs.get(key(cx, cy)) || []) if (deep(x, y, W.juncs[j].poly, K.marginM)) return true;
    for (const c of conns.get(key(cx, cy)) || []) {
      const cn = W.conns[c], lane = W.lanes[cn.from];
      math.polyProject(cn.px, cn.py, cn.cum, x, y, -1, q);
      if (q.d < (lane ? lane.width : 3) / 2 + 0.25 - K.marginM) return true;
    }
    for (let ax = -1; ax <= 1; ax++) {
      for (let ay = -1; ay <= 1; ay++) {
        for (const [id, i] of segs.get(key(cx + ax, cy + ay)) || []) {
          if (id === self) continue;
          const e = W.edges[id], px = e.px[i], py = e.py[i], dx = e.px[i + 1] - px, dy = e.py[i + 1] - py, LL = dx * dx + dy * dy;
          if (LL < 1e-6) continue;
          const t = ((x - px) * dx + (y - py) * dy) / LL;
          if (t < 0 || t > 1) continue;
          const left = (-dy * (x - px - dx * t) + dx * (y - py - dy * t)) / Math.sqrt(LL);
          if (Math.abs(left) < (left >= 0 ? e.kerbOffL : e.kerbOffR) - K.marginM) return true;
        }
      }
    }
    return false;
  };
  let cut = 0;
  for (const e of W.edges) {
    for (const side of [0, 1]) {
      const off = side === 0 ? e.kerbOffL : e.kerbOffR, sign = side === 0 ? 1 : -1, n = e.px.length;
      const count = Math.max(1, Math.ceil(e.len / K.stepM));
      const want = [];
      let seg = 0, from = -1, last = 0;
      const close = () => {
        if (from >= 0 && last - from >= K.minRunM) want.push(from, last);
        from = -1;
      };
      for (let k = 0; k <= count; k++) {
        const s = e.len * k / count;
        while (seg < n - 2 && e.cum[seg + 1] < s) seg++;
        const dx = e.px[seg + 1] - e.px[seg], dy = e.py[seg + 1] - e.py[seg], L = Math.sqrt(dx * dx + dy * dy);
        if (L < 1e-5) continue;
        const f = (s - e.cum[seg]) / L;
        if (onOther(e.px[seg] + dx * f - dy / L * sign * off, e.py[seg] + dy * f + dx / L * sign * off, e.id)) close();
        else {
          if (from < 0) from = s;
          last = s;
        }
      }
      close();
      assert.deepStrictEqual(RD._curbClear(W, e, side), want, `edge ${e.id} side ${side}`);
      if (want.length > 2 || (want.length && want[1] - want[0] < e.len)) cut++;
    }
  }
  assert.ok(cut > 2000, `${cut} kerbs cut: the rule has to be biting for this to prove anything`);
});

test('roads.paved reads as it did before the index, and frontage is the same with the index and without it', () => {
  const { TLV, W } = fillTLV();
  const RD = TLV.render.roads;
  const SW = TLV.world.sidewalks;
  const hash = TLV.rng.hash32;
  const q = { sw: 0, s: 0, d: 0 };
  let on = 0;
  for (let i = 0; i < W.sidewalks.length; i += 2) {
    const sw = W.sidewalks[i];
    const k = hash(i, 3) % sw.px.length;
    const x = sw.px[k] + ((hash(i, 4) & 255) / 255 - 0.5) * 5, y = sw.py[k] + ((hash(i, 5) & 255) / 255 - 0.5) * 5;
    const n = SW.nearest(W, x, y, q);
    const plain = (n && n.d <= W.sidewalks[n.sw].width / 2) || RD.pavedOver(W, x, y);
    assert.strictEqual(!!RD.paved(W, x, y), !!plain, `paved at ${x},${y}`);
    if (plain) on++;
  }
  assert.ok(on > 500, `${on} on paving`);
  const pure = pureTLV();     // No roads module here, so recipes.frontage asks sidewalks.nearest
  const Wp = pure.world.get('tlv_center');
  assert.ok(!pure.render.roads, 'this copy has to be the one without the index');
  let rows = 0;
  for (let id = 0; id < W.blds.length; id++) {
    const style = TLV.render.styles.choose(W, id);
    const got = TLV.render.city.recipes.frontage(W, id, style);
    assert.strictEqual(JSON.stringify(got), JSON.stringify(pure.render.city.recipes.frontage(Wp, id, style)), `building ${id}`);
    rows += got.length;
  }
  assert.ok(rows > 5000, `${rows} rows`);
});

test('building steps change nothing: the same Parts with them and without them', () => {
  const a = fillTLV();
  const b = fillTLV();
  const S = a.TLV.render.styles;
  let gardens = 0;
  for (let id = 0; id < a.W.blds.length; id += 3) {
    const style = S.choose(a.W, id);
    const plain = a.TLV.render.city.recipes.building(a.W, id, style);
    const it = b.TLV.render.city.recipes.buildingSteps(b.W, id, style);
    while (!it.next().done);
    const stepped = b.TLV.render.city.recipes.building(b.W, id, style);
    assert.strictEqual(JSON.stringify(stepped), JSON.stringify(plain), `building ${id}`);
    if (plain.lowWalls.length) gardens++;
  }
  assert.ok(gardens > 200, `${gardens} buildings with low walls: the steps must be doing something here`);
});

test('low walls read for one building never land on another, and steps left unfinished leave nothing behind', () => {
  const fresh = (id) => {
    const { TLV, W } = fillTLV();
    return TLV.render.city.recipes.building(W, id, TLV.render.styles.choose(W, id));
  };
  const { TLV, W } = fillTLV();
  const R = TLV.render.city.recipes;
  const S = TLV.render.styles;
  const walled = [];
  for (let id = 0; id < W.blds.length && walled.length < 2; id++) {
    if (R.building(W, id, S.choose(W, id)).lowWalls.length) walled.push(id);
  }
  const [a, b] = walled;
  const wantA = JSON.stringify(fresh(a));
  const wantB = JSON.stringify(fresh(b));
  assert.notStrictEqual(JSON.stringify(fresh(a).lowWalls), JSON.stringify(fresh(b).lowWalls));
  // Read for a, then asked for b: what was read for a is not b's.
  const it = R.buildingSteps(W, a, S.choose(W, a));
  while (!it.next().done);
  assert.strictEqual(JSON.stringify(R.building(W, b, S.choose(W, b))), wantB);
  assert.strictEqual(JSON.stringify(R.building(W, a, S.choose(W, a))), wantA);
  // A build dropped part way, as dispose does, leaves nothing the next call could pick up.
  const dropped = R.buildingSteps(W, b, S.choose(W, b));
  dropped.next();
  assert.strictEqual(JSON.stringify(R.building(W, b, S.choose(W, b))), wantB);
});

test('a long kerb is read in pieces, whatever its length, and the pieces make the same answer', () => {
  const { TLV, W } = fillTLV();
  const RD = TLV.render.roads;
  const step = TLV.tune.render.kerbCut.stepM;
  const longest = W.edges.slice().sort((a, b) => b.len - a.len).slice(0, 40);
  for (const e of longest) {
    const samples = Math.ceil(e.len / step) + 1;
    let pieces = 0;
    const it = RD._curbClearSteps(W, e, 0);
    while (!it.next().done) pieces++;
    assert.ok(samples / (pieces + 1) <= 128, `edge ${e.id}: ${samples} samples in ${pieces + 1} steps`);
  }
  assert.ok(longest[0].len / step > 512, `the longest edge is ${longest[0].len} m, so one read would be ${Math.round(longest[0].len / step)} samples`);
});

test('one chunk ground, in steps: stall queries stand alone, each with room asked for ahead of it', () => {
  const { TLV, W } = fillTLV();
  const G = TLV.render.ground;
  const T = TLV.tune.render;
  const P = TLV.world.parking;
  const spotsNear = P.spotsNear;
  let queries = 0;
  P.spotsNear = function (...args) {
    queries++;
    return spotsNear.apply(this, args);
  };
  const buf = new G.GBuf(1 << 16);
  const quad = buf.quad;
  let quads = 0;
  buf.quad = function (...args) {
    quads++;
    return quad.apply(this, args);
  };
  const bin = { blds: [], fronts: [], edges: [], juncs: [], conns: [], lanes: [], walks: [], paths: [], xings: [], kerbs: [], strips: [] };
  const box = { x0: -400, y0: 400, x1: 0, y1: 800 };
  W.edges.forEach((e, i) => {
    if (e.px.some((x, k) => x > box.x0 && x < box.x1 && e.py[k] > box.y0 && e.py[k] < box.y1)) bin.edges.push(i);
  });
  W.kerbs.forEach((k, i) => {
    if (bin.edges.includes(k.edge)) bin.kerbs.push(i);
  });
  buf.setClip(box.x0, box.y0, box.x1, box.y1);
  const q = T.chunkM / 4;
  const centres = [box.x0 + q, box.y0 + q, box.x1 - q, box.y0 + q, box.x0 + q, box.y1 - q, box.x1 - q, box.y1 - q];
  const it = TLV.render.roads.fill(buf, W, bin, centres, q * 1.45 + 1);
  let asked = 0;
  let steps = 0;
  let worst = 0;
  for (let r = null; !r || !r.done;) {
    queries = 0;
    quads = 0;
    r = it.next();
    steps++;
    worst = Math.max(worst, queries);
    if (queries) assert.strictEqual(quads, 0, 'a stall query draws nothing in its own step');
    if (r.value) {
      assert.strictEqual(r.value, T.sliceHeavyMs);
      asked++;
    }
  }
  assert.strictEqual(asked, 4, 'room asked for ahead of each of the four quarters');
  assert.strictEqual(worst, 1, 'stall queries share no step');
  assert.ok(buf.ni > 0 && steps >= bin.kerbs.length, `${buf.ni} indices in ${steps} steps for ${bin.kerbs.length} kerb rows: a step is at most one row`);
});
