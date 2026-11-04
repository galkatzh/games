// tests/world/lanes.test.mjs — WP-WORLD: lane construction and queries (ARCHITECTURE 8.1, section 19 items 2 and 8).
import assert from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import { miniTLV, realTLV, sampler, craftMap, laneContactsOf } from './helpers.mjs';

const mini = miniTLV();
const M = mini.world.get('mini');
const real = realTLV();
const R = real.world.get('tlv_center');
const math = real.math;

/** Signed side of a point against an edge at the same arc: + right of digitized direction. */
function rightOffset(W, e, x, y) {
  const q = math.polyProject(e.px, e.py, e.cum, x, y, -1, {});
  return { s: q.s, off: -q.side * q.d };
}

/** Same-arc samples on a lane, skipping the ends, where a bend's mitre can distort the offset. */
function middle(W, lane, n = 5) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push(math.polyAt(lane.px, lane.py, lane.cum, lane.len * i / (n + 1), {}));
  return out;
}

test('mini: lane positions, lengths and directions by hand', () => {
  // The y = 0 road is one-way east with 2 lanes: idx 0 is 1.5 m right of the line, so south.
  const e = M.edges.find((x) => x.lanesB === 0 && x.px[0] === -200 && x.py[0] === 0);
  const d = M.dirEdges[e.id * 2];
  assert.strictEqual(M.dirEdges[e.id * 2 + 1], null);
  assert.strictEqual(d.lanes.length, 2);
  const a = M.lanes[d.lanes[0]];
  const b = M.lanes[d.lanes[1]];
  assert.ok(Math.abs(a.py[0] - -1.5) < 1e-6, 'idx 0 is south of the line when heading east');
  assert.ok(Math.abs(b.py[0] - 1.5) < 1e-6);
  // Kerb to kerb is 2 * (3 + 2.4) = 10.8, so the trim is 5.4 + 1.5 = 6.9 at both ends.
  assert.ok(Math.abs(a.len - (200 - 2 * 6.9)) < 1e-3, `len ${a.len}`);
  assert.ok(Math.abs(a.px[0] - (-200 + 6.9)) < 1e-3);
  assert.strictEqual(a.left, b.id);
  assert.strictEqual(a.right, -1);
  assert.strictEqual(b.right, a.id);
  assert.strictEqual(b.left, -1);
  assert.strictEqual(a.opposite, -1);
  assert.ok(Math.abs(a.vmax - 50 / 3.6) < 1e-9);
  assert.strictEqual(a.flags & mini.const.LF.AI_ROUTABLE, mini.const.LF.AI_ROUTABLE);

  // A two-way road north from the centre: forward lane east of the line, backward lane west.
  const n = M.edges.find((x) => x.lanesB === 1 && x.px[0] === 0 && x.py[0] === 0);
  const f = M.lanes[M.dirEdges[n.id * 2].lanes[0]];
  const g = M.lanes[M.dirEdges[n.id * 2 + 1].lanes[0]];
  assert.ok(Math.abs(f.px[0] - 1.5) < 1e-6);
  assert.ok(Math.abs(g.px[0] - -1.5) < 1e-6);
  assert.ok(f.py[0] < f.py[f.py.length - 1], 'forward runs north');
  assert.ok(g.py[0] > g.py[g.py.length - 1], 'backward runs south');
  assert.strictEqual(f.opposite, g.id);
  assert.strictEqual(g.opposite, f.id);
});

test('section 19.2: on mini, idx 0 is farthest right and directions do not overlap', () => {
  for (const e of M.edges) {
    checkEdge(M, e);
  }
});

/** One edge: index order per direction, and the gap between the two directions. */
function checkEdge(W, e, gapShare = 0.99) {
  for (const dir of [0, 1]) {
    const d = W.dirEdges[e.id * 2 + dir];
    if (!d) continue;
    for (let i = 0; i + 1 < d.lanes.length; i++) {
      const a = middle(W, W.lanes[d.lanes[i]]);
      const b = middle(W, W.lanes[d.lanes[i + 1]]);
      for (let k = 0; k < a.length; k++) {
        const h = a[k].h;
        const right = (b[k].x - a[k].x) * Math.sin(h) - (b[k].y - a[k].y) * Math.cos(h);
        assert.ok(right < 0, `edge ${e.id} dir ${dir}: idx ${i} is not right of idx ${i + 1}`);
      }
    }
  }
  const fwd = W.dirEdges[e.id * 2];
  const back = W.dirEdges[e.id * 2 + 1];
  if (!fwd || !back) return;
  for (const l of fwd.lanes) {
    const lane = W.lanes[l];
    for (const p of middle(W, lane)) {
      for (const o of back.lanes) {
        const other = W.lanes[o];
        const q = math.polyProject(other.px, other.py, other.cum, p.x, p.y, -1, {});
        assert.ok(q.d >= e.laneW * gapShare, `edge ${e.id}: lanes ${l} and ${o} are ${q.d} m apart, laneW ${e.laneW}`);
      }
    }
  }
}

test('section 19.2: 200 random real two-way edges', () => {
  const rnd = sampler(5);
  const twoWay = R.edges.filter((e) => e.lanesB > 0 && e.len >= 15);
  assert.ok(twoWay.length > 500);
  for (let i = 0; i < 200; i++) checkEdge(R, twoWay[Math.floor(rnd() * twoWay.length)]);
});

test('every real edge: lanes hold their order, and forward lanes are right of the line', () => {
  let tested = 0;
  for (const e of R.edges) {
    if (e.len < 12) continue;
    if (bendiest(e) > 1.2) continue;
    checkEdge(R, e, 0.9);
    tested++;
  }
  assert.ok(tested > 3800, `tested ${tested}`);
});

/** Sharpest turn at a vertex of an edge, radians. */
function bendiest(e) {
  let most = 0;
  for (let i = 1; i + 1 < e.px.length; i++) {
    const a = Math.atan2(e.py[i] - e.py[i - 1], e.px[i] - e.px[i - 1]);
    const b = Math.atan2(e.py[i + 1] - e.py[i], e.px[i + 1] - e.px[i]);
    most = Math.max(most, Math.abs(math.wrapPi(b - a)));
  }
  return most;
}

test('lanes are at least 3 m, finite, and forward along their own cum', () => {
  for (const W of [M, R]) {
    for (const lane of W.lanes) {
      assert.ok(lane.len >= 3, `lane ${lane.id} is ${lane.len} m`);
      assert.strictEqual(lane.px.length, lane.py.length);
      assert.strictEqual(lane.px.length, lane.cum.length);
      for (let i = 0; i < lane.px.length; i++) assert.ok(Number.isFinite(lane.px[i] + lane.py[i] + lane.cum[i]));
      for (let i = 1; i < lane.cum.length; i++) assert.ok(lane.cum[i] >= lane.cum[i - 1]);
      assert.ok(Math.abs(lane.cum[lane.cum.length - 1] - lane.len) < 1e-3);
    }
  }
});

test('trims follow 8.1: PASS is not trimmed, 45% cap, and at least 3 m remains', () => {
  const pass = craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 0 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1 }, { a: 1, b: 2 }],
    moves: [[0, 2, 0], [3, 1, 0]]
  });
  const W = real.world.build(pass);
  const lane = W.lanes[W.dirEdges[0].lanes[0]];
  // Kerb to kerb 6 m, so 3 + 1.5 = 4.5 m at the PRIORITY end, nothing at the PASS end.
  assert.ok(Math.abs(lane.len - 95.5) < 1e-3, `len ${lane.len}`);
  assert.ok(Math.abs(lane.px[lane.px.length - 1] - 0) < 1e-3);

  const short = craftMap({
    juncs: [{ x: 0, y: 0, kind: 1 }, { x: 8, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, laneW: 3.4, lanesF: 3, lanesB: 2, parkL: 2.4, parkR: 2.4 }]
  });
  const S = real.world.build(short);
  for (const l of S.lanes) {
    // Carriageway is 21.8, so the trim would be 12.4. It caps at 45%, 3.6 m each, and leaves 0.8 m, so both scale to leave 3 m.
    assert.ok(Math.abs(l.len - 3) < 0.05, `len ${l.len}`);
  }
});

test('a lane through a PASS junction whose road bends is pulled back into a real curve', () => {
  const bend = craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 0 }, { x: 0, y: 100, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0 }, { a: 1, b: 2, lanesB: 0, laneW: 3 }],
    moves: [[0, 2, 2]]
  });
  const W = real.world.build(bend);
  assert.ok(W.lanes[0].len < 95, 'the lane stops short of the bend');
  const conn = W.conns[0];
  assert.ok(conn.vmax > 3, `vmax ${conn.vmax}`);
  assert.ok(conn.px.length > 3, 'a curve, not a 2-point hop');
});

test('a U-turn onto another road pulls back at a PASS, and one back down its own road does not', () => {
  // Two one-way roads meet at the point of a very thin V, so their lanes share an end and turn 166 deg on the spot.
  const r = 14 * Math.PI / 180;
  const W = real.world.build(craftMap({
    juncs: [{ x: 100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 0 }, { x: 100 * Math.cos(r), y: 100 * Math.sin(r), kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0 }, { a: 1, b: 2, lanesB: 0 }],
    moves: [[0, 2, 3]]
  }));
  const c = W.conns[0];
  // 8 m of V pull-back, then the 1.5 m a 14 deg V still needs for the lanes to stand 2.2 m apart, read on a 2 m grid.
  assert.ok(Math.abs(W.lanes[c.from].len - (100 - 3 - 8 - 1.5)) < 1e-3, `lane ${W.lanes[c.from].len}`);
  assert.ok(c.px.length > 2 && c.vmax > 1.5, `vmax ${c.vmax}`);
  // A two-way road's own U-turn at a PASS has nothing to pull back from: it crosses the road's width whatever the trim.
  const own = real.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 0 }],
    edges: [{ a: 0, b: 1 }],
    moves: [[0, 1, 3]]
  }));
  // Only the far end trims: 4.5 m, half of 6 m of carriageway plus 1.5.
  assert.ok(Math.abs(own.lanes[own.dirEdges[0].lanes[0]].len - 95.5) < 1e-3, `lane ${own.lanes[own.dirEdges[0].lanes[0]].len}`);
});

test('standing back from a V rebuilds its roads with the same ids and links, and leaves other roads alone', () => {
  const r = 120 * Math.PI / 180;
  const end = [-7.5 + Math.cos(r) * 100, 0.2 + Math.sin(r) * 100];
  // The two-way road sets the stop line at 7.5 m, half of 12 m of carriageway plus 1.5, which is where the V's corner must be.
  const roads = (veeOut) => craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: end[0], y: end[1], kind: 1 }, { x: 100, y: 0, kind: 1 }, { x: 200, y: 0, kind: 1 }],
    edges: [
      { a: 0, b: 1, lanesB: 0 },
      veeOut ? { a: 1, b: 2, lanesB: 0, pts: [[0, 0], [-7.5, 0.2], end] } : { a: 1, b: 2, lanesB: 0 },
      { a: 1, b: 3, lanesF: 2, lanesB: 2 },
      { a: 3, b: 4, lanesF: 2, lanesB: 2 }
    ],
    moves: [[0, 2, 2]]
  });
  const plain = real.world.build(roads(false));
  const W = real.world.build(roads(true));
  assert.ok(W.lanes[W.dirEdges[0].lanes[0]].len < plain.lanes[plain.dirEdges[0].lanes[0]].len - 7, 'this map tests nothing');
  assert.strictEqual(W.lanes.length, plain.lanes.length);
  W.lanes.forEach((lane, id) => {
    const twin = plain.lanes[id];
    assert.strictEqual(lane.id, id);
    for (const k of ['dirEdge', 'edge', 'idx', 'left', 'right', 'opposite']) assert.strictEqual(lane[k], twin[k], `lane ${id}, ${k}`);
    assert.ok(W.dirEdges[lane.dirEdge].lanes.includes(id));
    assert.ok(Math.abs(lane.cum[lane.cum.length - 1] - lane.len) < 1e-3, `lane ${id}: cum ends at its length`);
  });
  const twoWay = W.dirEdges[4];
  assert.ok(W.lanes[twoWay.lanes[1]].opposite >= 0, 'a two-way road at the junction keeps its opposite lanes');
  assert.ok(W.lanes[twoWay.lanes[0]].len < plain.lanes[twoWay.lanes[0]].len - 7, 'and stands back with the rest of the junction');
  const far = W.dirEdges[6];
  assert.strictEqual(W.lanes[far.lanes[0]].len, plain.lanes[far.lanes[0]].len, 'a road not at that junction does not move');
  assert.deepStrictEqual(Array.from(W.juncs[1].inDir), Array.from(plain.juncs[1].inDir));
});

test('EXCLUSIVE is len under 12.9, NARROW and AI come from the edge', () => {
  const LF = real.const.LF;
  const EF = real.const.EF;
  for (const lane of R.lanes) {
    assert.strictEqual((lane.flags & LF.EXCLUSIVE) !== 0, lane.len < 12.9);
    const e = R.edges[lane.edge];
    const dir = lane.dirEdge & 1;
    assert.strictEqual((lane.flags & LF.AI_ROUTABLE) !== 0, (e.flags & (dir ? EF.AI_B : EF.AI_F)) !== 0);
    assert.strictEqual((lane.flags & LF.NARROW) !== 0, (e.flags & EF.NARROW) !== 0);
  }
});

test('section 19.8: project then pointAt round-trips within 0.05 m on 1,000 samples', () => {
  const rnd = sampler(11);
  const lanes = real.world.lanes;
  let same = 0;
  for (let i = 0; i < 1000; i++) {
    const lane = R.lanes[Math.floor(rnd() * R.lanes.length)];
    const s = rnd() * lane.len;
    const p = lanes.pointAt(R, lane.id, s, {});
    const q = lanes.project(R, p.x, p.y, p.h, 5, {});
    assert.ok(q, 'project found nothing on a lane');
    const back = lanes.pointAt(R, q.laneId, q.s, {});
    const d = Math.hypot(back.x - p.x, back.y - p.y);
    assert.ok(d < 0.05, `sample ${i}: ${d} m`);
    if (q.laneId === lane.id) same++;
  }
  assert.ok(same > 950, `same lane ${same}`);
});

test('project gives lat and heading error with the right signs, on a point off the lane', () => {
  const lanes = mini.world.lanes;
  const e = M.edges.find((x) => x.lanesB === 0 && x.px[0] === -200);
  // 1 m north of the left lane centre (y = 1.5), heading east: + lat is left of travel.
  const q = lanes.project(M, -100, 2.5, 0, 6, {});
  assert.strictEqual(q.laneId, M.dirEdges[e.id * 2].lanes[1]);
  assert.ok(Math.abs(q.lat - 1) < 1e-4, `lat ${q.lat}`);
  assert.ok(Math.abs(q.dist - 1) < 1e-4);
  assert.ok(Math.abs(q.headingErr) < 1e-6);
  const r = lanes.project(M, -100, -2.5, 0, 6, {});
  assert.ok(Math.abs(r.lat - -1) < 1e-4);
  assert.strictEqual(lanes.project(M, -100, 100, null, 6, {}), null);
});

test('project prefers a lane within 90 deg of the heading, even when another is closer', () => {
  const lanes = mini.world.lanes;
  const e = M.edges.find((x) => x.px[0] === 0 && x.py[0] === 0 && x.lanesB === 1);
  const north = M.lanes[M.dirEdges[e.id * 2].lanes[0]];
  const south = M.lanes[M.dirEdges[e.id * 2 + 1].lanes[0]];
  // x = -1 is on the southbound lane, 2.5 m from the northbound one.
  assert.strictEqual(lanes.project(M, -1, 100, Math.PI / 2, 6, {}).laneId, north.id);
  assert.strictEqual(lanes.project(M, -1, 100, -Math.PI / 2, 6, {}).laneId, south.id);
  assert.strictEqual(lanes.project(M, -1, 100, null, 6, {}).laneId, south.id);
});

test('lanesNear has no duplicates and agrees with a brute-force scan', () => {
  const rnd = sampler(3);
  const out = new Int32Array(512);
  for (let i = 0; i < 40; i++) {
    const x = R.bounds.minX + rnd() * (R.bounds.maxX - R.bounds.minX);
    const y = R.bounds.minY + rnd() * (R.bounds.maxY - R.bounds.minY);
    const r = 20 + rnd() * 100;
    const n = real.world.lanes.lanesNear(R, x, y, r, out);
    const got = Array.from(out.subarray(0, n)).sort((a, b) => a - b);
    assert.strictEqual(new Set(got).size, got.length);
    const want = [];
    for (const lane of R.lanes) {
      let best = Infinity;
      for (let k = 0; k + 1 < lane.px.length; k++) best = Math.min(best, math.pointSegDist(x, y, lane.px[k], lane.py[k], lane.px[k + 1], lane.py[k + 1]));
      if (best <= r) want.push(lane.id);
    }
    assert.deepStrictEqual(got, want);
  }
});

test('zones: one per lane of each crossing, sorted, and a trimmed crossing snaps inside', () => {
  for (const x of M.xings) {
    const e = M.edges[x.edge];
    assert.strictEqual(x.zones.length, e.lanesF + e.lanesB);
    for (const z of x.zones) {
      const zone = M.zones[z];
      assert.strictEqual(zone.xing, x.id);
      assert.ok(Math.abs(zone.s1 - zone.s0 - 3) < 1e-3);
    }
  }
  for (const lane of R.lanes) {
    for (let i = 0; i < lane.zones.length; i++) {
      const z = R.zones[lane.zones[i]];
      assert.strictEqual(z.laneId, lane.id);
      assert.ok(z.s0 >= 0 && z.s1 <= lane.len + 1e-3 && z.s0 < z.s1);
      if (i > 0) assert.ok(R.zones[lane.zones[i - 1]].s0 <= z.s0);
    }
  }
  const W = real.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0 }],
    xings: [{ x: 99, y: 0, edge: 0, s: 199 }, { x: -99, y: 0, edge: 0, s: 1 }]
  }));
  const lane = W.lanes[0];
  const far = W.zones[W.xings[0].zones[0]];
  assert.ok(Math.abs((far.s0 + far.s1) / 2 - (lane.len - 1.5)) < 1e-3, 'before the stop line');
  const near = W.zones[W.xings[1].zones[0]];
  assert.ok(Math.abs((near.s0 + near.s1) / 2 - 1.5) < 1e-3, 'after the start');
});

test('bus stops bind to the kerb lane of their direction, and lanes list them along travel', () => {
  const stop = M.stops[0];
  const lane = M.lanes[stop.laneId];
  assert.strictEqual(lane.edge, stop.edge);
  assert.strictEqual(lane.idx, 0);
  assert.ok(lane.stops.includes(stop.id));
  let bound = 0;
  for (const s of R.stops) {
    if (s.laneId < 0) continue;
    bound++;
    const l = R.lanes[s.laneId];
    assert.strictEqual(l.edge, s.edge);
    assert.strictEqual(l.idx, 0);
    if (R.dirEdges[s.edge * 2 + s.dir]) assert.strictEqual(l.dirEdge, s.edge * 2 + s.dir, `stop ${s.id} is on the wrong direction`);
  }
  assert.strictEqual(bound, R.stops.length);
  const W = real.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1 }],
    stops: [{ x: 0, y: -2, edge: 0, s: 100, dir: 0 }, { x: 40, y: 2, edge: 0, s: 140, dir: 1 }, { x: -40, y: 2, edge: 0, s: 60, dir: 1 }]
  }));
  assert.strictEqual(W.stops[0].laneId, W.dirEdges[0].lanes[0]);
  assert.strictEqual(W.stops[1].laneId, W.dirEdges[1].lanes[0]);
  // A backward lane lists its stops along travel, which is against s.
  assert.deepStrictEqual(Array.from(W.lanes[W.dirEdges[1].lanes[0]].stops), [1, 2]);
});

/** A one-way road into a junction at (0, 0), and two one-way roads leaving it at +-deg, each 100 m long. */
function fork(deg, lanes = 1, length = 100) {
  const r = deg * Math.PI / 180;
  const ends = [[length * Math.cos(r), length * Math.sin(r)], [length * Math.cos(r), -length * Math.sin(r)]];
  return craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: ends[0][0], y: ends[0][1], kind: 1 }, { x: ends[1][0], y: ends[1][1], kind: 1 }],
    edges: [{ a: 0, b: 1, lanesF: 2, lanesB: 0 }, { a: 1, b: 2, lanesF: lanes, lanesB: 0 }, { a: 1, b: 3, lanesF: lanes, lanesB: 0 }],
    moves: [[0, 2, 0], [0, 4, 0]]
  });
}

test('lanes of a shallow fork stop where cars clear each other, on both roads, and the connectors carry the split', () => {
  const W = real.world.build(fork(5));
  const a = W.lanes[W.dirEdges[2].lanes[0]];
  const b = W.lanes[W.dirEdges[4].lanes[0]];
  const gap = Math.hypot(a.px[0] - b.px[0], a.py[0] - b.py[0]);
  assert.ok(gap >= 2.2, `lanes start ${gap} m apart`);
  assert.ok(gap < 2.9, `lanes start ${gap} m apart, further back than they need`);
  assert.ok(Math.abs(a.len - b.len) < 1e-3, 'a symmetrical fork pulls both lanes back alike');
  const c = W.conns.filter((q) => q.to === a.id || q.to === b.id);
  assert.strictEqual(c.length, 2);
  for (const q of c) assert.ok(q.len > 15 && q.px.length > 2, `connector ${q.id} is ${q.len} m`);
  // No lane of the arriving road moved: it stands clear of both, at 4.5 m each end, half of 6 m of carriageway plus 1.5.
  assert.ok(Math.abs(W.lanes[W.dirEdges[0].lanes[0]].len - 91) < 1e-3, `approach ${W.lanes[W.dirEdges[0].lanes[0]].len}`);
});

test('a wide fork is left to the contract, and a direction keeps one stop line across its lanes', () => {
  const wide = real.world.build(fork(45));
  // 4.5 m at the fork, set by the 2-lane road, and 3 m at the far end. The ends are less than a metre out from the polyline's own length.
  assert.ok(Math.abs(wide.lanes[wide.dirEdges[2].lanes[0]].len - 92.5) < 0.05, `lane ${wide.lanes[wide.dirEdges[2].lanes[0]].len}`);
  const two = real.world.build(fork(5, 2));
  const d = two.dirEdges[2];
  const [l0, l1] = Array.from(d.lanes, (l) => two.lanes[l]);
  assert.ok(Math.abs(l0.px[0] - l1.px[0]) < 0.3, `stop lines at x ${l0.px[0]} and ${l1.px[0]}`);
  assert.ok(l0.len < 90, 'the outer lane stops with the lane that needed it to');
});

test('a pull-back never takes a lane under the minimum, and a stop line outranks it', () => {
  const W = real.world.build(fork(2, 1, 20));
  for (const de of [2, 4]) assert.ok(W.lanes[W.dirEdges[de].lanes[0]].len >= 3, `lane ${W.lanes[W.dirEdges[de].lanes[0]].len}`);
});

test('the open end of a V keeps its stop line: the stretch at the point belongs to the point', () => {
  // Two one-way roads leave one junction 40 m apart and meet at another: only the end at the point of the V may move.
  const W = real.world.build(craftMap({
    juncs: [{ x: 0, y: 20, kind: 1 }, { x: 0, y: -20, kind: 1 }, { x: 60, y: 0, kind: 1 }, { x: 160, y: 0, kind: 1 }],
    edges: [
      { a: 0, b: 2, lanesB: 0 }, { a: 1, b: 2, lanesB: 0 }, { a: 2, b: 3, lanesB: 0 }
    ],
    moves: [[0, 4, 0], [2, 4, 0]]
  }));
  const back = W.index.laneBack;
  assert.strictEqual(back[0], 0, 'the far end of the V stays');
  assert.strictEqual(back[4], 0, 'the far end of the V stays');
  assert.ok(back[1] > 0 && back[5] > 0, 'the point of the V pulls back');
});

test('tlv_center: lanes that hold a car stand a car apart, with no allowance at lane ends', () => {
  const AI = real.const.LF.AI_ROUTABLE;
  const allow = JSON.parse(fs.readFileSync(new URL('../../tools/rules/tags.json', import.meta.url), 'utf8')).section.overlapAllow;
  const open = laneContactsOf(real, R, 1.8, (a, b) => ((a.flags | b.flags) & AI) !== 0).filter(({ a, b }) => {
    const ways = [R.edges[a.edge].osm, R.edges[b.edge].osm];
    return !allow.some((w) => w.ways.includes(ways[0]) && w.ways.includes(ways[1]));
  });
  assert.deepStrictEqual(open.map(({ a, b, m, min }) => [a.id, b.id, m, min]), []);
});

test('calls with -1 return null, false or empty', () => {
  const lanes = mini.world.lanes;
  assert.strictEqual(lanes.pointAt(M, -1, 0, {}), null);
  assert.strictEqual(lanes.connPointAt(M, -1, 0, {}), null);
  assert.strictEqual(lanes.nextConns(M, -1).length, 0);
  assert.strictEqual(mini.world.junctions.ahead(M, -1), -1);
  assert.strictEqual(mini.world.junctions.connFor(M, -1, 0), -1);
});
