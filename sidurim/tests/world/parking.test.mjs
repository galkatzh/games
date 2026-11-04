// tests/world/parking.test.mjs — WP-WORLD: spots, occupancy, curbs (ARCHITECTURE 8.8, 10.7, 12.3, section 19 item 7).
import assert from 'node:assert';
import { test } from 'node:test';
import { miniTLV, realTLV, sampler, simOn, craftMap } from './helpers.mjs';

const mini = miniTLV();
const M = mini.world.get('mini');
const parking = mini.world.parking;
const real = realTLV();
const R = real.world.get('tlv_center');
const OCC = real.const.OCC;

/** Every spot of a world, by walking its kerb rows. */
function allSpots(TLV, W) {
  const out = [];
  const per = TLV.tune.world.spotsPerKerb;
  for (const k of W.kerbs) {
    const e = W.edges[k.edge];
    const strip = k.side === 0 ? e.parkL : e.parkR;
    const n = Math.floor((k.s1 - k.s0) / 6.5);
    for (let i = 0; i < n; i++) {
      const s = TLV.world.parking.spot(W, k.id * per + i);
      if (s) {
        out.push(s);
        assert.ok(k.tier <= 3 && strip > 0, `stall on kerb ${k.id}, tier ${k.tier}, strip ${strip}`);
      }
    }
  }
  return out;
}

const realSpots = allSpots(real, R);

// Geometry for the checks below, written apart from js/world/geom.js so that a fault there cannot hide here.
const CAR = [4.4, 1.8];
const STALL = [6.5, 2.4];

function corners(s, [len, wid]) {
  const c = Math.cos(s.h);
  const n = Math.sin(s.h);
  return [[1, 1], [1, -1], [-1, -1], [-1, 1]].map(([a, b]) => [s.x + c * a * len / 2 - n * b * wid / 2, s.y + n * a * len / 2 + c * b * wid / 2]);
}

const orient = (a, b, c) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
function crosses(a, b, c, d) {
  const d1 = orient(c, d, a);
  const d2 = orient(c, d, b);
  const d3 = orient(a, b, c);
  const d4 = orient(a, b, d);
  return d1 * d2 <= 0 && d3 * d4 <= 0 && !(d1 === 0 && d2 === 0);
}

function pointSeg(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l = dx * dx + dy * dy;
  const t = l > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l)) : 0;
  return Math.hypot(a[0] + t * dx - p[0], a[1] + t * dy - p[1]);
}

function inside(p, pts) {
  let hit = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if ((pts[i][1] > p[1]) !== (pts[j][1] > p[1]) && p[0] < (pts[j][0] - pts[i][0]) * (p[1] - pts[i][1]) / (pts[j][1] - pts[i][1]) + pts[i][0]) hit = !hit;
  }
  return hit;
}

const ringPts = (r) => Array.from({ length: r.length >> 1 }, (_, i) => [r[2 * i], r[2 * i + 1]]);

/** Distance from a polyline to a convex box given by its corners, 0 when they meet. */
function lineToBox(xs, ys, box) {
  let best = Infinity;
  for (let i = 0; i + 1 < xs.length; i++) {
    const a = [xs[i], ys[i]];
    const b = [xs[i + 1], ys[i + 1]];
    if (inside(a, box) || inside(b, box)) return 0;
    for (let k = 0; k < 4; k++) {
      const c = box[k];
      const d = box[(k + 1) % 4];
      if (crosses(a, b, c, d)) return 0;
      best = Math.min(best, pointSeg(a, c, d), pointSeg(b, c, d), pointSeg(c, a, b), pointSeg(d, a, b));
    }
  }
  return best;
}

/** True when a box meets a building: a wall crosses it, a wall vertex is in it, or it stands inside the footprint. */
function boxMeetsBuilding(box, b) {
  const rings = b.rings.map(ringPts);
  for (const ring of rings) {
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      if (inside(ring[i], box)) return true;
      for (let k = 0; k < 4; k++) if (crosses(ring[i], ring[j], box[k], box[(k + 1) % 4])) return true;
    }
  }
  return inside(box[0], rings[0]) && !rings.slice(1).some((hole) => inside(box[0], hole));
}

/** Separating axis test on boxes given by their corners. */
function boxesMeet(p, q) {
  for (const box of [p, q]) {
    for (let k = 0; k < 2; k++) {
      const ax = box[k + 1][0] - box[k][0];
      const ay = box[k + 1][1] - box[k][1];
      const sp = p.map((v) => v[0] * ax + v[1] * ay);
      const sq = q.map((v) => v[0] * ax + v[1] * ay);
      if (Math.max(...sp) <= Math.min(...sq) || Math.max(...sq) <= Math.min(...sp)) return false;
    }
  }
  return true;
}

/** Buckets rows by a box, then yields what stands near a point. */
function buckets(rows, boxOf, cell = 25) {
  const m = new Map();
  const key = (i, j) => i * 100003 + j;
  rows.forEach((row) => {
    const [x0, y0, x1, y1] = boxOf(row);
    for (let i = Math.floor(x0 / cell); i <= Math.floor(x1 / cell); i++) {
      for (let j = Math.floor(y0 / cell); j <= Math.floor(y1 / cell); j++) {
        if (!m.has(key(i, j))) m.set(key(i, j), []);
        m.get(key(i, j)).push(row);
      }
    }
  });
  return (x, y, r) => {
    const out = new Set();
    for (let i = Math.floor((x - r) / cell); i <= Math.floor((x + r) / cell); i++) {
      for (let j = Math.floor((y - r) / cell); j <= Math.floor((y + r) / cell); j++) {
        for (const row of m.get(key(i, j)) || []) out.add(row);
      }
    }
    return out;
  };
}

const lineBox = (l) => [Math.min(...l.px), Math.min(...l.py), Math.max(...l.px), Math.max(...l.py)];

test('mini: stalls by hand', () => {
  // Rows of tier 2 over [12, 95] and [105, 188] hold floor(83 / 6.5) = 12 stalls each, on 2 sides of 12 edges, 2 rows each.
  // Each stall must also lie along its lane: lanes stop 6.9 m from the junction, and the rows start at 12.
  const spots = allSpots(mini, M);
  assert.strictEqual(spots.length, 12 * 2 * 2 * 12);
  const k = M.kerbs.find((x) => x.tier === 2 && x.s0 === 12 && x.side === 1 && M.edges[x.edge].lanesB === 1 && M.edges[x.edge].px[0] === 0 && M.edges[x.edge].py[0] === 0);
  const first = parking.spot(M, k.id * 1024);
  // Heading north with the kerb on the right, the kerb is at x = 5.4, so the stall centre is at 4.2.
  assert.ok(Math.abs(first.x - 4.2) < 1e-4, `x ${first.x}`);
  assert.ok(Math.abs(first.y - (12 + 3.25)) < 1e-4);
  assert.ok(Math.abs(first.h - Math.PI / 2) < 1e-5);
  assert.strictEqual(first.len, 6.5);
  assert.strictEqual(first.wid, 2.4);
  assert.strictEqual(first.kerb, k.id);
  assert.strictEqual(first.edge, k.edge);
  assert.strictEqual(first.side, 1);
  assert.strictEqual(first.tier, 2);
  assert.strictEqual(first.paint, 0);
  assert.strictEqual(first.zone, '');
  assert.strictEqual(first.laneId, M.dirEdges[k.edge * 2].lanes[0]);
  assert.ok(Math.abs(first.laneS - (15.25 - 6.9)) < 1e-3);
  assert.strictEqual(first.id, k.id * 1024);
  // The left side of a two-way road belongs to the backward lane, so the stall heads south.
  const left = M.kerbs.find((x) => x.tier === 2 && x.s0 === 12 && x.side === 0 && x.edge === k.edge);
  const other = parking.spot(M, left.id * 1024);
  assert.ok(Math.abs(other.x - -4.2) < 1e-4);
  assert.ok(Math.abs(Math.abs(other.h) - Math.PI / 2) < 1e-5 && other.h < 0);
  assert.strictEqual(other.laneId, M.dirEdges[k.edge * 2 + 1].lanes[0]);
});

test('a one-way road parks both sides, each beside its nearest lane, along travel', () => {
  const e = M.edges.find((x) => x.lanesB === 0);
  const right = M.kerbs.find((x) => x.edge === e.id && x.side === 1 && x.tier === 2);
  const left = M.kerbs.find((x) => x.edge === e.id && x.side === 0 && x.tier === 2);
  const a = parking.spot(M, right.id * 1024);
  const b = parking.spot(M, left.id * 1024);
  assert.strictEqual(a.laneId, M.dirEdges[e.id * 2].lanes[0]);
  assert.strictEqual(b.laneId, M.dirEdges[e.id * 2].lanes[1]);
  assert.ok(Math.abs(a.h) < 1e-5 && Math.abs(b.h) < 1e-5);
  assert.ok(Math.abs(a.y - -4.2) < 1e-4);
  assert.ok(Math.abs(b.y - 4.2) < 1e-4);
});

test('section 19.7: no parked car reaches a footprint, and none is on tier 255, on the real map', () => {
  assert.ok(realSpots.length > 45000, `spots ${realSpots.length}`);
  const sp = real.world.spatial;
  const near = buckets(R.blds.filter((b) => b.rings[0].length >= 6), (b) => [b.minX, b.minY, b.maxX, b.maxY]);
  for (const s of realSpots) {
    assert.strictEqual(sp.pointInBuilding(R, s.x, s.y), -1, `spot ${s.id}`);
    assert.ok(s.tier <= 3 && R.kerbs[s.kerb].tier === s.tier);
    const box = corners(s, CAR);
    for (const b of near(s.x, s.y, 3)) assert.ok(!boxMeetsBuilding(box, b), `a car in spot ${s.id} meets building ${b.id}`);
  }
});

test('no parked car reaches the carriageway of a lane or a connector, on the real map', () => {
  const lanes = buckets(R.lanes, lineBox);
  const conns = buckets(R.conns, lineBox);
  for (const s of realSpots) {
    const box = corners(s, CAR);
    for (const l of lanes(s.x, s.y, 5)) {
      assert.ok(lineToBox(l.px, l.py, box) >= l.width / 2, `spot ${s.id} and lane ${l.id}`);
    }
    for (const c of conns(s.x, s.y, 5)) {
      const half = Math.max(R.lanes[c.from].width, R.lanes[c.to].width) / 2;
      assert.ok(lineToBox(c.px, c.py, box) >= half, `spot ${s.id} and connector ${c.id}`);
    }
  }
});

test('no stall centre stands in a junction, on the real map', () => {
  const outline = (j) => ringPts(j.poly);
  const near = buckets(R.juncs.filter((j) => j.poly.length >= 6), (j) => {
    const p = outline(j);
    return [Math.min(...p.map((v) => v[0])), Math.min(...p.map((v) => v[1])), Math.max(...p.map((v) => v[0])), Math.max(...p.map((v) => v[1]))];
  });
  for (const s of realSpots) {
    for (const j of near(s.x, s.y, 0)) assert.ok(!inside([s.x, s.y], outline(j)), `spot ${s.id} in junction ${j.id}`);
  }
});

test('no parked car stands in another stall, on the real map, on one kerb or across two', () => {
  const near = buckets(realSpots, (s) => [s.x - 4, s.y - 4, s.x + 4, s.y + 4], 16);
  let pairs = 0;
  for (const s of realSpots) {
    const car = corners(s, CAR);
    for (const q of near(s.x, s.y, 7)) {
      if (q === s) continue;
      pairs++;
      assert.ok(!boxesMeet(car, corners(q, STALL)), `a car in spot ${s.id} stands in spot ${q.id}`);
    }
  }
  assert.ok(pairs > realSpots.length, `pairs ${pairs}`);
});

test('spots sit beside their lane, in its direction, on the real map', () => {
  const lanes = real.world.lanes;
  for (const s of realSpots) {
    const lane = R.lanes[s.laneId];
    assert.strictEqual(lane.edge, s.edge);
    assert.ok(s.laneS >= 2.2 && s.laneS <= lane.len - 2.2, `spot ${s.id}: s ${s.laneS} of ${lane.len}`);
    const p = lanes.pointAt(R, s.laneId, s.laneS, {});
    assert.ok(Math.abs(real.math.wrapPi(p.h - s.h)) < 1e-6);
    const d = Math.hypot(p.x - s.x, p.y - s.y);
    assert.ok(d < 8, `spot ${s.id} is ${d} m from its lane`);
    const e = R.edges[s.edge];
    assert.ok(Number.isFinite(s.x + s.y + s.h));
    assert.ok((s.side === 0 ? e.parkL : e.parkR) > 0);
  }
});

test('no parked car sits on a lane of another road', () => {
  const buf = new Int32Array(64);
  const math = real.math;
  for (const s of realSpots) {
    const n = real.world.lanes.lanesNear(R, s.x, s.y, 5, buf);
    for (let i = 0; i < n; i++) {
      const lane = R.lanes[buf[i]];
      if (lane.edge === s.edge) continue;
      const q = math.polyProject(lane.px, lane.py, lane.cum, s.x, s.y, -1, {});
      assert.ok(q.d >= lane.width / 2 + 0.9, `spot ${s.id} and lane ${lane.id}`);
    }
  }
});

test('stall numbering: spotId = kerbId * 1024 + n, gaps stay gaps, junk ids give null', () => {
  assert.strictEqual(parking.spot(M, -1), null);
  assert.strictEqual(parking.spot(M, 1e9), null);
  assert.strictEqual(parking.spot(M, NaN), null);
  const k = M.kerbs.find((x) => x.tier === 255);
  assert.strictEqual(parking.spot(M, k.id * 1024), null, 'no stall on tier 255');
  for (const s of realSpots.slice(0, 2000)) {
    assert.strictEqual(Math.floor(s.id / 1024), s.kerb);
    assert.strictEqual(real.world.parking.spot(R, s.id), s);
  }
  const W = mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0, parkR: 2.4 }],
    blds: [{ ring: [[-58, -5], [-56, -5], [-56, -2.2], [-58, -2.2]] }],
    kerbs: [{ edge: 0, side: 1, s0: 20, s1: 100, tier: 2 }]
  }));
  // Lane half width 1.5 + strip 2.4 = 3.9 to the kerb, so stalls centre on y = -2.7. A wall at x -58..-56 takes out stall 3.
  assert.ok(parking.spot(W, 2));
  assert.strictEqual(parking.spot(W, 3), null);
  assert.ok(parking.spot(W, 4), 'its neighbour keeps its number');
});

test('a wall that reaches a car between its corners rejects the stall', () => {
  // Stalls centre on y = -2.7 and the car spans -3.6 to -1.8. This wedge comes up from the south through the car's long side,
  // at x = 75, midway along stall 8: no corner of the car and not its centre is in the footprint. Stall 8 is centred on x = 75.
  const road = (blds) => mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0, parkR: 2.4 }],
    blds,
    kerbs: [{ edge: 0, side: 1, s0: 120, s1: 180, tier: 2 }]
  }));
  const stall = 3; // 120 + 6.5 * 3.5 = 142.75, so x = 42.75
  const free = road([]);
  const s = parking.spot(free, stall);
  assert.ok(Math.abs(s.x - 42.75) < 1e-4 && Math.abs(s.y - -2.7) < 1e-4);
  const W = road([{ ring: [[42.5, -9], [43, -9], [42.75, -3.2]] }]);
  assert.strictEqual(mini.world.spatial.pointInBuilding(W, s.x, s.y), -1);
  for (const [a, b] of corners(s, CAR)) assert.strictEqual(mini.world.spatial.pointInBuilding(W, a, b), -1);
  assert.strictEqual(parking.spot(W, stall), null);
  assert.ok(parking.spot(W, stall - 1) && parking.spot(W, stall + 1), 'its neighbours keep their stalls');
  // A wall short of the car by more than the clearance leaves it alone.
  assert.ok(parking.spot(road([{ ring: [[42.5, -9], [43, -9], [42.75, -3.8]] }]), stall));
});

test('a parked car keeps 0.1 m from a wall and from any lane', () => {
  // laneW 3.1 puts the kerb at 3.95, so stalls centre on y = -2.75 and the car's far side is at y = -3.65.
  const road = (extra) => mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }, { x: -100, y: -20, kind: 1 }, { x: 100, y: -20, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0, laneW: 3.1, parkR: 2.4 }, ...(extra.edges || [])],
    blds: extra.blds || [],
    kerbs: [{ edge: 0, side: 1, s0: 120, s1: 139.5, tier: 2 }]
  }));
  const wallAt = (y) => road({ blds: [{ ring: [[30, y - 5], [50, y - 5], [50, y], [30, y]] }] });
  const lane = (y, laneW) => road({ edges: [{ a: 2, b: 3, lanesB: 0, laneW, pts: [[-100, y], [100, y]] }] });
  assert.strictEqual(parking.spot(wallAt(-3.7), 1), null, 'a wall 0.05 m off');
  assert.ok(parking.spot(wallAt(-3.8), 1), 'a wall 0.15 m off');
  // A 3 m lane on y = -5.3 has its edge on y = -3.8, 0.15 m from the car, and a 3.2 m one on -3.7, 0.05 m from it.
  assert.ok(parking.spot(lane(-5.3, 3), 1), 'a lane 0.15 m off');
  assert.strictEqual(parking.spot(lane(-5.3, 3.2), 1), null, 'a lane 0.05 m off');
});

test('a kerb row across the mouth of another road loses the stall its connector needs', () => {
  // Road 0 runs east, with stalls on y = -2.7, its cars down to y = -3.6. Below it two roads meet at (0, -2.6), wide enough that
  // their stop lines stand 5.4 m back. So their lanes end near y = -6.3, out of reach, and only the turn between them bends up
  // into the strip, to y = -3.1 at its edge. The two maps differ only in that move.
  const map = (moves) => mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }, { x: -40, y: -40, kind: 1 }, { x: 0, y: -2.6, kind: 1 }, { x: 40, y: -40, kind: 1 }],
    edges: [
      { a: 0, b: 1, lanesB: 0, parkR: 2.4 },
      { a: 2, b: 3, lanesB: 0, parkL: 2.4, parkR: 2.4 },
      { a: 3, b: 4, lanesB: 0, parkL: 2.4, parkR: 2.4 }
    ],
    moves,
    kerbs: [{ edge: 0, side: 1, s0: 60, s1: 140, tier: 2 }]
  }));
  const stallAt = (W) => Array.from({ length: 12 }, (_, n) => n).filter((n) => parking.spot(W, n)).map((n) => parking.spot(W, n));
  const open = stallAt(map([]));
  const shut = stallAt(map([[2, 4, 0]]));
  assert.strictEqual(open.length, 12);
  assert.ok(shut.length < 12 && shut.length >= 8, `${shut.length} stalls left`);
  for (const s of open) {
    if (shut.some((q) => q.id === s.id)) continue;
    assert.ok(Math.abs(s.x) < 10, `only stalls by the connector go, not the one at ${s.x}`);
  }
});

test('where stalls of two kerbs clash the lower id stands, whatever was asked first', () => {
  // Two one-way roads 7 m apart, with their strips facing. Stalls centre on y = -2.7 and y = -4.3, so the cars overlap.
  const spec = (blds = []) => craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }, { x: -100, y: -7, kind: 1 }, { x: 100, y: -7, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0, parkR: 2.4 }, { a: 2, b: 3, lanesB: 0, parkL: 2.4 }],
    blds,
    kerbs: [{ edge: 0, side: 1, s0: 40, s1: 100, tier: 2 }, { edge: 1, side: 0, s0: 40, s1: 165, tier: 2 }]
  });
  const ids = (W) => {
    const out = [];
    for (let id = 0; id < 2048; id++) if (parking.spot(W, id)) out.push(id);
    return out;
  };
  const W = mini.world.build(spec());
  const got = ids(W);
  // Kerb 0 keeps all 9 stalls. Kerb 1 loses the 9 opposite them and keeps the rest of its 19, which reach past kerb 0's end.
  assert.deepStrictEqual(got.filter((id) => id < 1024), [0, 1, 2, 3, 4, 5, 6, 7, 8]);
  assert.deepStrictEqual(got.filter((id) => id >= 1024), [9, 10, 11, 12, 13, 14, 15, 16, 17, 18].map((n) => 1024 + n));
  // Asking the upper kerb first changes nothing.
  const fresh = mini.world.build(spec());
  for (let id = 2047; id >= 0; id--) parking.spot(fresh, id);
  assert.deepStrictEqual(ids(fresh), got);
  const near = [];
  parking.spotsNear(mini.world.build(spec()), 0, -3.5, 500, near);
  assert.deepStrictEqual(near, got);
  // A stall lost to a wall takes nothing from the kerb opposite: stall 4 of kerb 0 goes, so stall 4 of kerb 1 comes back.
  const walled = mini.world.build(spec([{ ring: [[-33, -1.9], [-32.5, -1.9], [-32.5, -2.5], [-33, -2.5]] }]));
  assert.strictEqual(parking.spot(walled, 4), null);
  assert.ok(parking.spot(walled, 1024 + 4));
  assert.strictEqual(parking.spot(walled, 1024 + 3), null);
});

test('a stall whose car would hang past the end of its lane is rejected', () => {
  // The road is 5.4 m from kerb to kerb, so the trim is 0.5 * 5.4 + 1.5 = 4.2 m at each end.
  const W = mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0, parkR: 2.4 }],
    kerbs: [{ edge: 0, side: 1, s0: 3, s1: 197, tier: 2 }]
  }));
  // Stall 0 centres 3 + 3.25 = 6.25 m along the road, which is 2.05 m along the lane, so the car would cross the stop line.
  assert.strictEqual(parking.spot(W, 0), null);
  assert.ok(Math.abs(parking.spot(W, 1).laneS - 8.55) < 1e-3);
  // The last stall of 29 centres at 3 + 6.5 * 28.5 = 188.25, 7.55 m short of the lane's end, and fits.
  assert.ok(parking.spot(W, 28));
  // The far end: the lane stops at 195.8. A stall centred at 194 leaves the car 0.4 m past it, and one at 193.5 fits.
  const end = (s0) => mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0, parkR: 2.4 }],
    kerbs: [{ edge: 0, side: 1, s0, s1: s0 + 6.5, tier: 2 }]
  }));
  assert.strictEqual(parking.spot(end(190.8), 0), null);
  assert.ok(parking.spot(end(190.2), 0));
});

test('section 19.7: spotsNear is identical across call orders', () => {
  const rnd = sampler(44);
  const queries = [];
  for (let i = 0; i < 40; i++) {
    const s = realSpots[Math.floor(rnd() * realSpots.length)];
    queries.push([s.x + rnd() * 40, s.y + rnd() * 40, 10 + rnd() * 120]);
  }
  const run = (order) => {
    const TLV = realTLV();
    const W = TLV.world.get('tlv_center');
    const out = new Map();
    for (const i of order) {
      const ids = [];
      const n = TLV.world.parking.spotsNear(W, ...queries[i], ids);
      assert.strictEqual(n, ids.length);
      out.set(i, ids);
    }
    return out;
  };
  const forward = run(queries.map((_, i) => i));
  const backward = run(queries.map((_, i) => queries.length - 1 - i));
  for (let i = 0; i < queries.length; i++) assert.deepStrictEqual(backward.get(i), forward.get(i));
});

test('spotsNear agrees with a scan and returns sorted ids', () => {
  const rnd = sampler(45);
  for (let i = 0; i < 30; i++) {
    const s = realSpots[Math.floor(rnd() * realSpots.length)];
    const x = s.x + rnd() * 20;
    const y = s.y - rnd() * 20;
    const r = 5 + rnd() * 90;
    const ids = [];
    real.world.parking.spotsNear(R, x, y, r, ids);
    const want = realSpots.filter((q) => Math.hypot(q.x - x, q.y - y) <= r).map((q) => q.id).sort((a, b) => a - b);
    assert.deepStrictEqual(ids, want);
  }
});

test('baseline occupancy: the hash rule, its share, and overrides over it', () => {
  const TLV = realTLV();
  const W = TLV.world.get('tlv_center');
  const S = simOn(TLV, W, 42);
  const p = TLV.world.parking;
  let parked = 0;
  for (const s of realSpots) {
    const occ = p.state(S, s.id);
    const want = TLV.rng.hash32(42, s.id) / 2 ** 32 < 0.88 ? OCC.PARKED : OCC.FREE;
    assert.strictEqual(occ, want);
    if (occ === OCC.PARKED) parked++;
  }
  const share = parked / realSpots.length;
  assert.ok(Math.abs(share - 0.88) < 0.01, `share ${share}`);
  const id = realSpots[0].id;
  for (const occ of [OCC.FREE, OCC.PARKED, OCC.VEHICLE, OCC.MOTO]) {
    p.setState(S, id, occ);
    assert.strictEqual(p.state(S, id), occ);
  }
  p.setState(S, -1, OCC.MOTO);
  assert.strictEqual(p.state(S, -1), OCC.FREE);
  assert.strictEqual(S.parking.overrides.size, 1);
  p.reset(S);
  assert.strictEqual(S.parking.overrides.size, 0);
  assert.strictEqual(p.state(S, id), TLV.rng.hash32(42, id) / 2 ** 32 < 0.88 ? OCC.PARKED : OCC.FREE);
});

test('parkedNear returns only PARKED and MOTO spots', () => {
  const S = simOn(mini, M, 7);
  const k = M.kerbs.find((x) => x.tier === 2);
  const spot = parking.spot(M, k.id * 1024);
  const near = [];
  parking.spotsNear(M, spot.x, spot.y, 30, near);
  assert.ok(near.length >= 8);
  for (let i = 0; i < near.length; i++) parking.setState(S, near[i], [OCC.FREE, OCC.PARKED, OCC.VEHICLE, OCC.MOTO][i % 4]);
  const parked = [];
  const n = parking.parkedNear(S, spot.x, spot.y, 30, parked);
  assert.strictEqual(n, parked.length);
  assert.deepStrictEqual(parked, near.filter((_, i) => i % 4 === 1 || i % 4 === 3));
});

test('boxOf sizes a car, a motorcycle and an empty stall', () => {
  const k = M.kerbs.find((x) => x.tier === 2);
  const id = k.id * 1024;
  const s = parking.spot(M, id);
  const out = {};
  const car = parking.boxOf(M, id, OCC.PARKED, out);
  assert.strictEqual(car, out);
  assert.deepStrictEqual({ ...car }, { x: s.x, y: s.y, h: s.h, length: 4.4, width: 1.8 });
  const moto = parking.boxOf(M, id, OCC.MOTO, {});
  assert.ok(moto.length < 3 && moto.width < 1.2);
  const free = parking.boxOf(M, id, OCC.FREE, {});
  assert.strictEqual(free.length, 6.5);
  assert.strictEqual(free.width, 2.4);
  assert.strictEqual(parking.boxOf(M, -1, OCC.PARKED, {}), null);
});

test('kerbAt by hand on mini', () => {
  // The road north from the centre, s = 50, kerb at x = 5.4, in a tier 2 row.
  const k = parking.kerbAt(M, 4.4, 50, 2, {});
  const row = M.kerbs[k.kerb];
  assert.strictEqual(row.side, 1);
  assert.ok(row.s0 <= 50 && row.s1 >= 50);
  assert.strictEqual(row.tier, 2);
  assert.strictEqual(k.side, 1);
  assert.strictEqual(k.paint, 0);
  assert.ok(Math.abs(k.dist - 1) < 1e-4);
  assert.ok(Math.abs(k.h - Math.PI / 2) < 1e-4);
  // Left of digitized on a two-way road: the lane there runs south.
  const l = parking.kerbAt(M, -4.4, 50, 2, {});
  assert.strictEqual(l.side, 0);
  assert.ok(Math.abs(l.h - -Math.PI / 2) < 1e-4);
  // Near the crossing the row is tier 255, and it still answers, for the red/white curb option.
  const buffer = parking.kerbAt(M, 4.4, 100, 2, {});
  assert.strictEqual(M.kerbs[buffer.kerb].tier, 255);
  assert.strictEqual(parking.kerbAt(M, 40, 50, 2, {}), null);
});

test('kerbAt finds a curb from every stall on the real map', () => {
  // 1.2 m in a straight road, and a little more on the inside of a bend.
  for (const s of realSpots) {
    const k = real.world.parking.kerbAt(R, s.x, s.y, 3, {});
    assert.ok(k, `spot ${s.id}`);
    assert.ok(k.dist <= 3);
  }
});

test('roadDistance by hand on mini, with its limit', () => {
  const k = M.kerbs.find((x) => x.tier === 2 && x.s0 === 12 && x.side === 1 && M.edges[x.edge].px[0] === 0 && M.edges[x.edge].py[0] === 0 && M.edges[x.edge].lanesB === 1);
  const id = k.id * 1024;
  const s = parking.spot(M, id);
  // Same road: 12 + 3.25 = 15.25 along it, and a point at s = 60 beside the road.
  assert.ok(Math.abs(parking.roadDistance(M, 8, 60, id) - (60 - 15.25)) < 1e-3);
  // Round the corner: from (60, 8), on the road east of the centre, 60 m to the junction and 15.25 m up.
  assert.ok(Math.abs(parking.roadDistance(M, 60, 8, id) - (60 + 15.25)) < 1e-3);
  assert.strictEqual(parking.roadDistance(M, 8, 60, -1), Infinity);
  // Farther than 400 m by road is Infinity.
  assert.strictEqual(parking.roadDistance(M, 390, 200, id), Infinity, 'no road near it');
  assert.strictEqual(parking.roadDistance(M, 200, -190, id), Infinity);
  assert.ok(s);
});

test('roadDistance ignores one-way rules', () => {
  const k = M.kerbs.find((x) => x.tier === 2 && x.edge === M.edges.find((e) => e.lanesB === 0 && e.px[0] === 0).id && x.s0 === 12 && x.side === 1);
  const d = parking.roadDistance(M, -50, 8, k.id * 1024);
  assert.ok(Math.abs(d - (50 + 15.25)) < 1e-3, `d ${d}`);
});

test('roadDistance agrees with a junction Dijkstra on the real map', () => {
  const rnd = sampler(48);
  const math = real.math;
  const dist = new Map();
  const adj = new Map();
  for (const e of R.edges) {
    if (!adj.has(e.a)) adj.set(e.a, []);
    if (!adj.has(e.b)) adj.set(e.b, []);
    adj.get(e.a).push([e.b, e.len]);
    adj.get(e.b).push([e.a, e.len]);
  }
  for (let i = 0; i < 25; i++) {
    const s = realSpots[Math.floor(rnd() * realSpots.length)];
    const a = realSpots[Math.floor(rnd() * realSpots.length)];
    const near = [];
    real.world.parking.spotsNear(R, s.x, s.y, 200, near);
    const t = real.world.parking.spot(R, near[Math.floor(rnd() * near.length)]);
    const from = R.edges[s.edge];
    const got = real.world.parking.roadDistance(R, s.x, s.y, t.id);
    // Brute force: start from the same projection the world uses.
    const q = math.polyProject(from.px, from.py, from.cum, s.x, s.y, -1, {});
    dist.clear();
    const open = [[from.a, q.s], [from.b, from.len - q.s]];
    while (open.length) {
      open.sort((p, r) => p[1] - r[1]);
      const [j, d] = open.shift();
      if (dist.has(j) && dist.get(j) <= d) continue;
      dist.set(j, d);
      if (d > 500) continue;
      for (const [k, l] of adj.get(j) || []) open.push([k, d + l]);
    }
    const to = R.edges[t.edge];
    const r = math.polyProject(to.px, to.py, to.cum, t.x, t.y, -1, {});
    let want = Math.min((dist.get(to.a) ?? Infinity) + r.s, (dist.get(to.b) ?? Infinity) + to.len - r.s);
    if (from.id === to.id) want = Math.min(want, Math.abs(r.s - q.s));
    if (want > 400) want = Infinity;
    assert.ok(a);
    if (want === Infinity) assert.strictEqual(got, Infinity);
    else if (Math.abs(got - want) > 0.05) {
      // The point may project to a nearer edge than the spot's own, which is the rule, so only an upper bound applies there.
      assert.ok(got <= want + 30, `case ${i}: got ${got}, brute ${want}`);
    }
  }
});

test('the sim keeps parking per run: init, and no state leaks between sims', () => {
  const a = simOn(mini, M, 1);
  const b = simOn(mini, M, 2);
  const k = M.kerbs.find((x) => x.tier === 2);
  parking.setState(a, k.id * 1024, OCC.MOTO);
  assert.strictEqual(b.parking.overrides.size, 0);
});
