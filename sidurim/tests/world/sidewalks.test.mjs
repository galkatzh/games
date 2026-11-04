// tests/world/sidewalks.test.mjs — WP-WORLD: generated sidewalks and solid props (ARCHITECTURE 8.5, 8.6).
import assert from 'node:assert';
import { test } from 'node:test';
import { miniTLV, realTLV, sampler, craftMap } from './helpers.mjs';

const mini = miniTLV();
const M = mini.world.get('mini');
const sidewalks = mini.world.sidewalks;
const real = realTLV();
const R = real.world.get('tlv_center');

test('mini: ribbon offset, trim and shape by hand', () => {
  assert.strictEqual(M.sidewalks.length, 24);
  const e = M.edges.find((x) => x.lanesB === 1 && x.px[0] === 0 && x.py[0] === 0);
  const right = M.sidewalks.find((s) => s.edge === e.id && s.side === 1);
  const left = M.sidewalks.find((s) => s.edge === e.id && s.side === 0);
  // kerbOffset 5.4, sw 2.5, so the centre is 6.65 from the line, to the east on the right side.
  assert.ok(Math.abs(right.px[0] - 6.65) < 1e-4);
  assert.ok(Math.abs(left.px[0] - -6.65) < 1e-4);
  assert.strictEqual(right.width, 2.5);
  // Digitized direction is north, and both junctions trim 6.9.
  assert.ok(Math.abs(right.py[0] - 6.9) < 1e-4);
  assert.ok(Math.abs(right.len - 186.2) < 1e-3);
  assert.deepStrictEqual(Array.from(right.xings), [M.xings.find((x) => x.edge === e.id).id]);
});

test('mini: corners link around, not across the road', () => {
  const e = M.edges.find((x) => x.lanesB === 1 && x.px[0] === 0 && x.py[0] === 0);
  const right = M.sidewalks.find((s) => s.edge === e.id && s.side === 1);
  const atCentre = right.links.filter((l) => !l.atEnd);
  assert.strictEqual(atCentre.length, 1);
  const other = M.sidewalks[atCentre[0].sw];
  // The north-east corner of the centre joins this ribbon to the north side of the road going east.
  assert.ok(other.py[0] > 0 && Math.max(other.px[0], other.px[other.px.length - 1]) > 100);
  assert.strictEqual(M.edges[other.edge].py[0], 0);
  const end = atCentre[0].toStart ? 0 : other.px.length - 1;
  assert.ok(Math.hypot(right.px[0] - other.px[end], right.py[0] - other.py[end]) < 1);
  // Two-way: the link back exists.
  assert.ok(other.links.some((l) => l.sw === right.id && l.toStart === true && l.atEnd === !atCentre[0].toStart));
});

test('links are mutual, and end-to-end within 30 m, on the real map', () => {
  let links = 0;
  for (const s of R.sidewalks) {
    for (const l of s.links) {
      links++;
      const o = R.sidewalks[l.sw];
      assert.ok(o.links.some((b) => b.sw === s.id && b.toStart === !l.atEnd && b.atEnd === !l.toStart), `link ${s.id} to ${l.sw}`);
      const i = l.atEnd ? s.px.length - 1 : 0;
      const k = l.toStart ? 0 : o.px.length - 1;
      assert.ok(Math.hypot(s.px[i] - o.px[k], s.py[i] - o.py[k]) <= 30);
    }
  }
  assert.ok(links > 15000, `links ${links}`);
});

test('crossings join the two sides, and each sidewalk lists its crossings along the road', () => {
  for (const x of M.xings) {
    assert.ok(x.swA >= 0 && x.swB >= 0);
    assert.notStrictEqual(x.swA, x.swB);
    assert.strictEqual(M.sidewalks[x.swA].edge, x.edge);
    assert.strictEqual(M.sidewalks[x.swB].edge, x.edge);
    assert.strictEqual(M.sidewalks[x.swA].side, 0);
    assert.strictEqual(M.sidewalks[x.swB].side, 1);
  }
  let bound = 0;
  for (const x of R.xings) {
    for (const sw of [x.swA, x.swB]) {
      if (sw < 0) continue;
      bound++;
      assert.ok(R.sidewalks[sw].xings.includes(x.id));
    }
  }
  assert.ok(bound > 3000, `bound ${bound}`);
  for (const s of R.sidewalks) {
    for (let i = 1; i < s.xings.length; i++) assert.ok(R.xings[s.xings[i - 1]].s <= R.xings[s.xings[i]].s);
  }
});

test('nearest and pointAt', () => {
  const out = { sw: -1, s: 0, d: 0 };
  const q = sidewalks.nearest(M, 8, 100, out);
  assert.strictEqual(q, out);
  const s = M.sidewalks[q.sw];
  const p = sidewalks.pointAt(M, q.sw, q.s, {});
  assert.ok(Math.hypot(p.x - 6.65, p.y - 100) < 1e-3);
  assert.ok(Math.abs(q.d - 1.35) < 1e-3);
  assert.ok(s);
  assert.strictEqual(sidewalks.pointAt(M, -1, 0, {}), null);
  assert.ok(sidewalks.nearest(M, 300, 300, {}), 'finds one from far away');
  const rnd = sampler(5);
  for (let i = 0; i < 300; i++) {
    const a = R.sidewalks[Math.floor(rnd() * R.sidewalks.length)];
    const t = rnd() * a.len;
    const pt = real.world.sidewalks.pointAt(R, a.id, t, {});
    const n = real.world.sidewalks.nearest(R, pt.x, pt.y, {});
    assert.ok(n.d < 0.01, `sample ${i}: ${n.d}`);
  }
});

test('nextAt follows links, draws only for a real choice, and takes a function or an Rng', () => {
  const e = M.edges.find((x) => x.lanesB === 1 && x.px[0] === 0 && x.py[0] === 0);
  const right = M.sidewalks.find((s) => s.edge === e.id && s.side === 1);
  let draws = 0;
  const next = sidewalks.nextAt(M, right.id, false, () => { draws++; return 0.5; });
  assert.strictEqual(draws, 0, 'one link, no draw');
  assert.strictEqual(next.sw, right.links.find((l) => !l.atEnd).sw);
  assert.strictEqual(sidewalks.nextAt(M, -1, true, () => 0), null);
  const W = mini.world.build(craftMap({
    juncs: [{ x: -300, y: 0, kind: 1, flags: 1 }, { x: 300, y: 0, kind: 1, flags: 1 }],
    edges: [{ a: 0, b: 1 }]
  }));
  assert.strictEqual(sidewalks.nextAt(W, 0, true, () => 0), null, 'a portal end leads nowhere');
  const rng = mini.rng.create(5);
  for (const s of R.sidewalks.slice(0, 500)) {
    for (const end of [false, true]) {
      const n = real.world.sidewalks.nextAt(R, s.id, end, rng);
      if (n) assert.ok(s.links.some((l) => l.sw === n.sw && l.toStart === n.toStart && l.atEnd === end));
      else assert.ok(!s.links.some((l) => l.atEnd === end));
    }
  }
});

test('nothing links at a portal, even with another sidewalk end close by', () => {
  const W = mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1, flags: 3 }, { x: -100, y: 14, kind: 1 }, { x: 100, y: 14, kind: 1, flags: 3 }],
    edges: [{ a: 0, b: 1 }, { a: 2, b: 3 }]
  }));
  for (const s of W.sidewalks) assert.ok(!s.links.some((l) => l.atEnd), `sidewalk ${s.id}`);
});

test('an end the corners left open links to the nearest end over clear ground', () => {
  // Two roads ending apart, with no shared junction: the south sidewalk of one and the north sidewalk of the other face each other.
  const W = mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1, flags: 2 }, { x: 100, y: 0, kind: 1, flags: 2 }, { x: -100, y: 14, kind: 1, flags: 2 }, { x: 100, y: 14, kind: 1, flags: 2 }],
    edges: [{ a: 0, b: 1 }, { a: 2, b: 3 }]
  }));
  const a = W.sidewalks.find((s) => s.edge === 0 && s.side === 0);
  assert.ok(a.links.length >= 2, 'its own cul-de-sac link does not stop this one');
  const walls = mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }, { x: -100, y: 14, kind: 1 }, { x: 100, y: 14, kind: 1 }],
    edges: [{ a: 0, b: 1 }, { a: 2, b: 3 }],
    blds: [{ ring: [[-120, 6.5], [120, 6.5], [120, 7.5], [-120, 7.5]] }]
  }));
  for (const s of walls.sidewalks) {
    for (const l of s.links) assert.strictEqual(walls.sidewalks[l.sw].edge, s.edge, 'no link through the wall');
  }
});

test('a crossing whose ribbon was cut away has no sidewalk on that side', () => {
  const W = mini.world.build(craftMap({
    juncs: [{ x: -200, y: 0, kind: 1 }, { x: 200, y: 0, kind: 1 }, { x: -200, y: 4, kind: 1 }, { x: 0, y: 4, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0 }, { a: 2, b: 3, lanesB: 0 }],
    xings: [{ x: -100, y: 0, edge: 0, s: 100 }]
  }));
  const x = W.xings[0];
  assert.strictEqual(x.swA, -1, 'its left ribbon only survives past the other road');
  assert.ok(x.swB >= 0);
  const kept = W.sidewalks.find((s) => s.edge === 0 && s.side === 0);
  assert.ok(kept && kept.px[0] > -10 && !kept.xings.includes(x.id));
});

test('a cul-de-sac joins its two sidewalks around the end', () => {
  const W = mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1, flags: 2 }, { x: 100, y: 0, kind: 1, flags: 3 }],
    edges: [{ a: 0, b: 1 }],
    moves: [[1, 0, 3]]
  }));
  const [a, b] = W.sidewalks;
  assert.ok(a.links.some((l) => l.sw === b.id && !l.atEnd));
  assert.ok(!a.links.some((l) => l.atEnd), 'not at the portal');
});

test('sidewalks stay off lanes on the real map, and none is water, bridges included', () => {
  const math = real.math;
  const buf = new Int32Array(128);
  let on = 0;
  let total = 0;
  for (const s of R.sidewalks) {
    for (let t = 0; t <= s.len; t += 3) {
      const p = math.polyAt(s.px, s.py, s.cum, t, {});
      total++;
      assert.notStrictEqual(real.world.surface.at(R, p.x, p.y), real.const.SURF.WATER, `sidewalk ${s.id} at ${t}`);
      const n = real.world.lanes.lanesNear(R, p.x, p.y, 6, buf);
      for (let i = 0; i < n; i++) {
        const lane = R.lanes[buf[i]];
        const q = math.polyProject(lane.px, lane.py, lane.cum, p.x, p.y, -1, {});
        if (q.d < lane.width / 2) {
          on++;
          break;
        }
      }
    }
  }
  assert.ok(on / total < 0.001, `${on} of ${total} samples stand in a lane`);
});

test('a ribbon stops where it would run across another road, and side by side carriageways lose the median', () => {
  const W = mini.world.build(craftMap({
    juncs: [{ x: -200, y: 0, kind: 1 }, { x: 200, y: 0, kind: 1 }, { x: -200, y: 7, kind: 1 }, { x: 200, y: 7, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesF: 2, lanesB: 0 }, { a: 3, b: 2, lanesF: 2, lanesB: 0 }]
  }));
  const median = W.sidewalks.filter((s) => s.py[0] > 0 && s.py[0] < 7);
  assert.strictEqual(median.length, 0);
  assert.strictEqual(W.sidewalks.length, 2);
});

test('a ribbon drifts off a wall that stands in it, toward the kerb, and returns', () => {
  const W = mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0, swL: 3, swR: 3 }],
    blds: [{ ring: [[-20, 2.5], [20, 2.5], [20, 30], [-20, 30]] }]
  }));
  const sw = W.sidewalks.find((s) => s.side === 0);
  // Kerb 1.5, sw 3: the centre is at y = 3, inside a wall at 2.5.
  const math = mini.math;
  const mid = math.polyAt(sw.px, sw.py, sw.cum, sw.len / 2, {});
  assert.ok(mid.y < 2.5 && mid.y >= 1.5, `y ${mid.y}`);
  const end = math.polyAt(sw.px, sw.py, sw.cum, 1, {});
  assert.ok(Math.abs(end.y - 3) < 1e-3);
  for (let t = 0; t <= sw.len; t += 1) {
    const p = math.polyAt(sw.px, sw.py, sw.cum, t, {});
    assert.strictEqual(mini.world.spatial.pointInBuilding(W, p.x, p.y), -1, `at ${t}`);
  }
});

/** A block of four roads with a ring of sidewalks around it, from which `wall` cuts. The ring's inner sidewalks are the ones in play. */
function ringMap(blds, extra = {}) {
  return craftMap({
    juncs: [{ x: -100, y: -100, kind: 1 }, { x: 100, y: -100, kind: 1 }, { x: 100, y: 100, kind: 1 }, { x: -100, y: 100, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0, swL: 2, swR: 2 }, { a: 1, b: 2, lanesB: 0, swL: 2, swR: 2 }, { a: 2, b: 3, lanesB: 0, swL: 2, swR: 2 }, { a: 3, b: 0, lanesB: 0, swL: 2, swR: 2 }],
    moves: [[0, 2, 2], [2, 4, 2], [4, 6, 2], [6, 0, 2]],
    blds,
    ...extra
  });
}

/** Rows of a world by their edge side, in order along it. */
function rowsOf(W, edge, side) {
  return W.sidewalks.filter((s) => s.edge === edge && s.side === side);
}

/** Metres of a sidewalk row in solid walls, read every quarter metre. */
function inWall(T, W, s) {
  let n = 0;
  for (let t = 0; t <= s.len; t += 0.25) {
    const p = T.math.polyAt(s.px, s.py, s.cum, t, {});
    const b = T.world.spatial.pointInBuilding(W, p.x, p.y);
    if (b >= 0 && !(W.blds[b].flags & 1)) n++;
  }
  return n * 0.25;
}

/** Sidewalk components by links and crossings, leaving out one row. @returns {number} How many there are. */
function components(W, without = -1) {
  const parent = W.sidewalks.map((_, i) => i);
  const root = (a) => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  for (const s of W.sidewalks) {
    if (s.id === without) continue;
    for (const l of s.links) if (l.sw !== without) parent[root(s.id)] = root(l.sw);
  }
  for (const x of W.xings) {
    if (x.swA >= 0 && x.swB >= 0 && x.swA !== without && x.swB !== without) parent[root(x.swA)] = root(x.swB);
  }
  let n = 0;
  W.sidewalks.forEach((s, i) => { if (i !== without && root(i) === i) n++; });
  return n;
}

test('a wall standing in the parking strip moves the ribbon across the strip, and it stops short of the lanes', () => {
  const W = mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0, parkL: 2.4, swL: 1, swR: 1 }],
    blds: [{ ring: [[-20, 2], [20, 2], [20, 30], [-20, 30]] }]
  }));
  // Lanes end at 1.5, the strip at 3.9, and the ribbon's centre at 4.4. The wall stands 1.9 m into the strip, so the ribbon moves
  // further than one sample's spacing, and only the ramp keeps that from being a jump.
  const rows = rowsOf(W, 0, 0);
  assert.strictEqual(rows.length, 1);
  const sw = rows[0];
  const at = (t) => mini.math.polyAt(sw.px, sw.py, sw.cum, t, {});
  assert.ok(at(sw.len / 2).y <= 2 - mini.tune.world.swWallPad + 1e-3, `y ${at(sw.len / 2).y}: it stands off the wall by its pad`);
  assert.ok(at(sw.len / 2).y >= 1.5 + mini.tune.world.swLaneClear - 1e-3, 'short of the lanes');
  assert.strictEqual(inWall(mini, W, sw), 0);
  assert.ok(Math.abs(at(1).y - 4.4) < 1e-3, 'it returns once past the wall');
  // Sideways against distance along the road. Against the ribbon's own length it could never read over 1.
  let worst = 0;
  for (let i = 1; i < sw.px.length; i++) worst = Math.max(worst, Math.abs(sw.py[i] - sw.py[i - 1]) / Math.abs(sw.px[i] - sw.px[i - 1]));
  assert.ok(worst <= mini.tune.world.swMaxDrift + 1e-3, `steepest ${worst} m per metre`);
  const moved = W.index.swMoved;
  assert.strictEqual(moved.length, W.sidewalks.length * 2);
  assert.ok(moved[sw.id * 2] > 0 && moved[sw.id * 2 + 1] < sw.len && moved[sw.id * 2] < moved[sw.id * 2 + 1]);
});

test('no prop stands on a stretch that moved off a wall, and the rest of the ribbon keeps its own', () => {
  const W = mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0, parkL: 2.4, swL: 3, swR: 3 }],
    blds: [{ ring: [[-20, 2.6], [20, 2.6], [20, 30], [-20, 30]] }]
  }));
  const north = W.props.filter((p) => p.y > 0);
  assert.ok(north.length > 0);
  assert.strictEqual(north.filter((p) => Math.abs(p.x) < 20).length, 0);
});

test('a wall that reaches the lanes cuts the ribbon where the block has another way round', () => {
  const W = mini.world.build(ringMap([{ ring: [[-10, -98.4], [10, -98.4], [10, -60], [-10, -60]] }]));
  const open = mini.world.build(ringMap([]));
  // Edge 0 runs east along y = -100, and its left side is the inside of the block. The wall reaches the lanes across it.
  const rows = rowsOf(W, 0, 0);
  assert.strictEqual(rows.length, 2, `${rows.length} rows`);
  for (const r of rows) assert.strictEqual(inWall(mini, W, r), 0);
  assert.ok(rows[0].px[rows[0].px.length - 1] <= -10 && rows[1].px[0] >= 10);
  assert.ok(!rows[0].links.some((l) => l.sw === rows[1].id), 'no link through the wall');
  assert.strictEqual(components(W), components(open), 'as many as with no wall at all');
  // Each piece still reaches its corner, and a walker turns back at the wall.
  assert.ok(rows[0].links.some((l) => !l.atEnd));
  assert.ok(!rows[0].links.some((l) => l.atEnd));
  assert.strictEqual(mini.world.sidewalks.nextAt(W, rows[0].id, true, () => 0), null);
});

test('a second cut in the same ring stays, because the ring would otherwise fall in two', () => {
  const W = mini.world.build(ringMap([
    { ring: [[-10, -98.4], [10, -98.4], [10, -60], [-10, -60]] },
    { ring: [[-10, 98.4], [10, 98.4], [10, 60], [-10, 60]] }
  ]));
  assert.strictEqual(components(W), components(mini.world.build(ringMap([]))), 'nothing may be stranded');
  const walled = W.sidewalks.filter((s) => inWall(mini, W, s) > 0);
  assert.strictEqual(walled.length, 1, 'and one stretch is all that takes');
  assert.ok(walled[0].len < 30, 'the short way, not a whole road');
});

test('of two cuts in one ring, the shorter is the one that stays', () => {
  const W = mini.world.build(ringMap([
    { ring: [[-40, -98.4], [40, -98.4], [40, -60], [-40, -60]] },
    { ring: [[-10, 98.4], [10, 98.4], [10, 60], [-10, 60]] }
  ]));
  const walled = W.sidewalks.filter((s) => inWall(mini, W, s) > 0);
  assert.strictEqual(walled.length, 1);
  assert.strictEqual(walled[0].edge, 2, 'the 20 m wall, not the 80 m one');
});

test('swMoved stays with its rows when rows go', () => {
  // The cut on edge 0 drops a row, so the rows after it renumber, among them the one that moved on edge 2.
  const W = mini.world.build(craftMap({
    juncs: [{ x: -100, y: -100, kind: 1 }, { x: 100, y: -100, kind: 1 }, { x: 100, y: 100, kind: 1 }, { x: -100, y: 100, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0, swL: 2, swR: 2 }, { a: 1, b: 2, lanesB: 0, swL: 2, swR: 2 }, { a: 2, b: 3, lanesB: 0, swL: 2, swR: 2, parkL: 2.4 }, { a: 3, b: 0, lanesB: 0, swL: 2, swR: 2 }],
    moves: [[0, 2, 2], [2, 4, 2], [4, 6, 2], [6, 0, 2]],
    blds: [{ ring: [[-10, -98.4], [10, -98.4], [10, -60], [-10, -60]] }, { ring: [[-10, 97.4], [10, 97.4], [10, 60], [-10, 60]] }]
  }));
  const moved = W.sidewalks.filter((s) => W.index.swMoved[s.id * 2] < W.index.swMoved[s.id * 2 + 1]);
  assert.deepStrictEqual(moved.map((s) => [s.edge, s.side]), [[2, 0]]);
  const s = moved[0];
  const mid = mini.math.polyAt(s.px, s.py, s.cum, (W.index.swMoved[s.id * 2] + W.index.swMoved[s.id * 2 + 1]) / 2, {});
  assert.ok(Math.abs(mid.x) < 3 && mid.y > 97.4, `the wall is at the middle of what moved, and it passes on the road side: ${mid.x}, ${mid.y}`);
});

test('a crossing beside a wall takes the clear row, so it does not keep the stretch alive for itself', () => {
  const blds = [{ ring: [[-10, -98.4], [10, -98.4], [10, -60], [-10, -60]] }];
  // At x = -8 it is nearer the stretch, and the clear row is still within reach.
  const W = mini.world.build(ringMap(blds, { xings: [{ x: -8, y: -100, edge: 0, s: 92 }] }));
  assert.strictEqual(W.sidewalks.filter((s) => inWall(mini, W, s) > 0).length, 0);
  assert.strictEqual(W.xings[0].swA, rowsOf(W, 0, 0)[0].id);
});

test('more walls on one span than the crossing buffer holds still read true', () => {
  // 130 posts make 260 crossings, more than the buffer's 256, and the long wall past them has to be found all the same.
  const blds = [];
  for (let i = 0; i < 130; i++) blds.push({ ring: [[-190 + i * 2, 2], [-189.7 + i * 2, 2], [-189.7 + i * 2, 4], [-190 + i * 2, 4]] });
  blds.push({ ring: [[120, 1.6], [170, 1.6], [170, 30], [120, 30]] });
  const W = mini.world.build(craftMap({
    bounds: [-300, -300, 300, 300],
    juncs: [{ x: -200, y: 0, kind: 1 }, { x: 200, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0, swL: 2, swR: 2 }],
    blds
  }));
  const rows = rowsOf(W, 0, 0);
  assert.ok(rows.length >= 2, `${rows.length} rows`);
  const first = rows[0];
  assert.ok(first.px[first.px.length - 1] <= 120, `the first row stops at the wall: ${first.px[first.px.length - 1]}`);
});

test('an open end links to the nearest end it can reach, not the first it finds', () => {
  // The first road has only a north sidewalk, so its east end is open. The other two have both, joined round their own ends, so
  // they seek nothing and only this end's choice decides.
  const W = mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: -100, y: 14, kind: 1 }, { x: 0, y: 14, kind: 1 }, { x: 18, y: 0, kind: 1 }, { x: 118, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0, swR: 0 }, { a: 2, b: 3, lanesB: 0 }, { a: 4, b: 5, lanesB: 0 }]
  }));
  const open = W.sidewalks.find((s) => s.edge === 0 && s.side === 0);
  const end = open.links.filter((l) => l.atEnd);
  assert.strictEqual(end.length, 1);
  assert.strictEqual(W.sidewalks[end[0].sw].edge, 1, 'the road 9 m north, not the one 24 m east');
});

test('where a stretch is the only way between two pieces, it stays, and it meets them end to end', () => {
  // Walls on both sides of one road: its west and east halves join only past them, and a single stretch is enough.
  const W = mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0, swL: 2, swR: 2 }],
    blds: [{ ring: [[-10, 1.6], [10, 1.6], [10, 30], [-10, 30]] }, { ring: [[-10, -1.6], [10, -1.6], [10, -30], [-10, -30]] }]
  }));
  assert.strictEqual(components(W), 1);
  const walled = W.sidewalks.filter((s) => inWall(mini, W, s) > 0);
  assert.strictEqual(walled.length, 1);
  assert.ok(inWall(mini, W, walled[0]) > 15, 'it runs through the wall');
  const rows = rowsOf(W, 0, walled[0].side);
  assert.strictEqual(rows.length, 3);
  assert.strictEqual(rows[1].id, walled[0].id);
  const mid = mini.math.polyAt(rows[1].px, rows[1].py, rows[1].cum, rows[1].len / 2, {});
  assert.ok(Math.abs(Math.abs(mid.y) - (1.5 + mini.tune.world.swLaneClear)) < 1e-3, `it hugs the lanes, at y ${mid.y}`);
  for (let i = 0; i + 1 < rows.length; i++) {
    assert.ok(rows[i].links.some((l) => l.sw === rows[i + 1].id && l.atEnd && l.toStart));
    const a = rows[i];
    const b = rows[i + 1];
    assert.ok(Math.hypot(a.px[a.px.length - 1] - b.px[0], a.py[a.py.length - 1] - b.py[0]) < 1e-3, 'the rows meet');
  }
  assert.strictEqual(rowsOf(W, 0, 1 - walled[0].side).length, 2, 'the other side was cut');
});

test('a crossing on a stretch that went lands on the nearest piece in reach, or on none', () => {
  // The crossing at x = -60 joins the two sides of the road, so nothing depends on the stretch for that.
  const beside = { x: -60, y: -100, edge: 0, s: 40 };
  const blds = [{ ring: [[-10, -98.4], [10, -98.4], [10, -60], [-10, -60]] }];
  const near = mini.world.build(ringMap(blds, { xings: [{ x: -12, y: -100, edge: 0, s: 88 }, beside] }));
  const rows = rowsOf(near, 0, 0);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(near.xings[0].swA, rows[0].id, 'its nearer piece');
  assert.ok(rows[0].xings.includes(0) && !rows[1].xings.includes(0));
  const wide = [{ ring: [[-30, -98.4], [30, -98.4], [30, -60], [-30, -60]] }];
  const far = mini.world.build(ringMap(wide, { xings: [{ x: 0, y: -100, edge: 0, s: 100 }, beside] }));
  assert.strictEqual(far.xings[0].swA, -1, 'out of reach of both');
  for (const x of far.xings) {
    for (const sw of [x.swA, x.swB]) assert.ok(sw === -1 || far.sidewalks[sw].id === sw, 'ids follow the rows that went');
  }
  far.sidewalks.forEach((s, i) => {
    assert.strictEqual(s.id, i);
    for (const l of s.links) assert.ok(l.sw >= 0 && l.sw < far.sidewalks.length);
  });
});

test('a crossing keeps a stretch only if it is the crossing that needs it', () => {
  // With no other way across, the far side of the road hangs on this one crossing, so its stretch stays, wall or no wall.
  const blds = [{ ring: [[-30, -98.4], [30, -98.4], [30, -60], [-30, -60]] }];
  const W = mini.world.build(ringMap(blds, { xings: [{ x: 0, y: -100, edge: 0, s: 100 }] }));
  assert.ok(W.xings[0].swA >= 0);
  assert.ok(inWall(mini, W, W.sidewalks[W.xings[0].swA]) > 30);
});

test('a whole ribbon in a wall goes if the block can do without it', () => {
  const W = mini.world.build(ringMap([{ ring: [[-120, -98.4], [120, -98.4], [120, -60], [-120, -60]] }]));
  assert.strictEqual(rowsOf(W, 0, 0).length, 0);
  assert.strictEqual(W.sidewalks.filter((s) => inWall(mini, W, s) > 0).length, 0);
});

test('real map: under 0.5% of sidewalk samples stand in a solid wall, at any spacing', () => {
  for (const step of [2, 0.25]) {
    let solid = 0;
    let total = 0;
    for (const s of R.sidewalks) {
      for (let t = 0; t <= s.len; t += step) {
        const p = real.math.polyAt(s.px, s.py, s.cum, t, {});
        total++;
        if (real.world.spatial._inSolid(R, p.x, p.y)) solid++;
      }
    }
    assert.ok(solid / total < 0.005, `${(100 * solid / total).toFixed(2)}% in solid walls, every ${step} m`);
  }
});

test('real map: the graph holds together, and a stretch through a wall stays only where it is the one way', () => {
  // Before walls cut anything there were 844 components, the largest 308 km, so these are floors, and the map can only help.
  const whole = components(R);
  assert.ok(whole <= 844, `${whole} components`);
  const walled = R.sidewalks.filter((s) => {
    let run = 0;
    for (let t = 0; t <= s.len; t += 2) {
      const p = real.math.polyAt(s.px, s.py, s.cum, t, {});
      run = real.world.spatial._inSolid(R, p.x, p.y) ? run + 1 : 0;
      if (run >= 4) return true;
    }
    return false;
  });
  assert.ok(walled.length > 20, 'this map tests nothing');
  const idle = walled.filter((s) => components(R, s.id) < whole + 1);
  // A row that a stretch of its own could have replaced is not one of these: rows here are stretches, and each must matter.
  assert.ok(idle.length <= walled.length * 0.1, `${idle.length} of ${walled.length} walled rows join nothing`);
});

test('real map: sidewalks that moved stay off the lanes they moved toward', () => {
  const math = real.math;
  const buf = new Int32Array(128);
  let moved = 0;
  let inLane = 0;
  for (const s of R.sidewalks) {
    const from = R.index.swMoved[s.id * 2];
    const to = R.index.swMoved[s.id * 2 + 1];
    if (from > to) continue;
    for (let t = Math.max(0, from); t <= Math.min(s.len, to); t += 1) {
      const p = math.polyAt(s.px, s.py, s.cum, t, {});
      moved++;
      const n = real.world.lanes.lanesNear(R, p.x, p.y, 6, buf);
      for (let i = 0; i < n; i++) {
        const lane = R.lanes[buf[i]];
        if (math.polyProject(lane.px, lane.py, lane.cum, p.x, p.y, -1, {}).d < lane.width / 2) {
          inLane++;
          break;
        }
      }
    }
  }
  assert.ok(moved > 10000, `moved ${moved}`);
  assert.ok(inLane / moved < 0.02, `${inLane} of ${moved} moved samples stand in a lane`);
});

test('props: mini counts, spacing and kinds by hand', () => {
  const kinds = {};
  for (const p of M.props) kinds[p.kind] = (kinds[p.kind] || 0) + 1;
  assert.ok(!kinds.palm, 'no sea on mini');
  assert.ok(kinds.lamp > 100 && kinds.ficus > 200, JSON.stringify(kinds));
  for (const p of M.props) {
    assert.strictEqual(p.r, p.kind === 'lamp' ? 0.15 : 0.3);
    assert.strictEqual(mini.world.surface.at(M, p.x, p.y), mini.const.SURF.SIDEWALK);
    assert.strictEqual(mini.world.spatial.pointInBuilding(M, p.x, p.y), -1);
  }
  // Each 186 m residential ribbon: floor(186.2 / 14) = 13 slots, and floor(186.2 / 30) = 6 lamps. Crossing clearance may
  // take a slot or two.
  const e = M.edges.find((x) => x.lanesB === 1 && x.px[0] === 0 && x.py[0] === 0);
  const onRibbon = M.props.filter((p) => Math.abs(p.x - 6.65) < 2 && p.y > 0 && p.y < 200 && p.kind !== 'lamp');
  assert.ok(onRibbon.length >= 12 && onRibbon.length <= 13, `trees ${onRibbon.length} on edge ${e.id}`);
});

test('prop jitter is hash32(edge, i), so a slot does not move with its neighbours or the map', () => {
  const sw = M.sidewalks[0];
  const T = mini.tune.world;
  const n = Math.floor(sw.len / T.treeResidentialM);
  const pitch = sw.len / n;
  const toKerb = sw.side === 1 ? 1 : -1;
  const trees = M.props.filter((p) => p.kind !== 'lamp');
  let found = 0;
  for (let i = 0; i < n; i++) {
    const h = mini.rng.hash32(sw.edge, i * 2 + sw.side);
    const at = mini.math.polyAt(sw.px, sw.py, sw.cum, (i + 0.5) * pitch + (h / 2 ** 32 - 0.5) * T.propJitter * pitch, {});
    const inset = sw.width / 2 - T.treeKerbM;
    const x = at.x - Math.sin(at.h) * toKerb * inset;
    const y = at.y + Math.cos(at.h) * toKerb * inset;
    if (trees.some((p) => Math.hypot(p.x - x, p.y - y) < 1e-3)) found++;
  }
  assert.ok(found >= n - 2, `${found} of ${n}`);
  const xs = new Set(M.sidewalks.slice(0, 2).map((s) => s.edge));
  assert.ok(xs.size >= 1);
});

test('props are deterministic and independent of the run seed', () => {
  const again = mini.world.build(mini.world.map.payload('mini'));
  assert.deepStrictEqual(again.props, M.props);
  const t2 = realTLV();
  const r2 = t2.world.build(t2.world.map.payload('tlv_center'));
  assert.strictEqual(r2.props.length, R.props.length);
  for (let i = 0; i < R.props.length; i += 97) assert.deepStrictEqual(r2.props[i], R.props[i]);
});

test('props on the real map: real trees first, on open ground, off lanes, and palms by the sea', () => {
  const sf = real.world.surface;
  const sp = real.world.spatial;
  const buf = new Int32Array(64);
  const math = real.math;
  let palms = 0;
  let grazing = 0;
  for (const p of R.props) {
    assert.ok(Number.isFinite(p.x + p.y));
    assert.notStrictEqual(sf.at(R, p.x, p.y), real.const.SURF.ROAD);
    assert.strictEqual(sp.pointInBuilding(R, p.x, p.y), -1);
    const n = real.world.lanes.lanesNear(R, p.x, p.y, 6, buf);
    let worst = Infinity;
    for (let i = 0; i < n; i++) {
      const lane = R.lanes[buf[i]];
      const q = math.polyProject(lane.px, lane.py, lane.cum, p.x, p.y, -1, {});
      worst = Math.min(worst, q.d - lane.width / 2);
    }
    // The road mask reads in one-metre cells, so a very few props touch a lane's edge. None stands in the lane.
    assert.ok(worst >= -0.3, `prop ${p.id} is ${-worst} m into a lane`);
    if (worst < p.r) grazing++;
    if (p.kind === 'palm') palms++;
  }
  assert.ok(grazing <= 8, `${grazing} props touch a lane`);
  assert.ok(palms > 100, `palms ${palms}`);
  assert.ok(R.props.length > 20000);
});

test('props keep clear of crossings, bus stops and doors on their street', () => {
  for (const W of [M, R]) {
    const T = real.tune.world;
    const byEdge = new Map();
    const add = (edge, x, y, r) => {
      if (!byEdge.has(edge)) byEdge.set(edge, []);
      byEdge.get(edge).push([x, y, r]);
    };
    for (const x of W.xings) add(x.edge, x.x, x.y, T.propClearXingM);
    for (const s of W.stops) add(s.edge, s.x, s.y, T.propClearStopM);
    for (const p of W.pois) add(p.edge, p.entX, p.entY, T.propClearDoorM);
    const near = [];
    const reals = W.index.trees.n;
    for (const [edge, list] of byEdge) {
      for (const [x, y, r] of list) {
        near.length = 0;
        real.world.spatial.propsNear(W, x, y, r - 0.01, near);
        for (const id of near) {
          if (id < reals) continue;
          const onEdge = W.sidewalks.some((s) => s.edge === edge && Math.min(...sideDistances(s, W.props[id])) < 1.5);
          assert.ok(!onEdge, `prop ${id} is ${Math.hypot(W.props[id].x - x, W.props[id].y - y)} m from a clearance of ${r}`);
        }
      }
    }
  }
});

/** Distance from a prop to the vertices and midpoints of a sidewalk's spans. */
function sideDistances(s, p) {
  const q = real.math.polyProject(s.px, s.py, s.cum, p.x, p.y, -1, {});
  return [q.d];
}

test('a real tree suppresses synthetic trees within 6 m, and one in a lane is dropped', () => {
  const build = (trees) => mini.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, swL: 3, swR: 3 }],
    trees
  }));
  const plain = build([]);
  const t = plain.props.find((p) => p.kind === 'ficus');
  const W = build([{ x: t.x + 1, y: t.y, species: 2 }, { x: 0, y: 1, species: 1 }]);
  assert.strictEqual(W.props[0].kind, 'palm');
  assert.strictEqual(W.props[0].r, 0.3);
  assert.strictEqual(W.props.filter((p) => Math.hypot(p.x - 0, p.y - 1) < 1).length, 0, 'in a lane');
  for (const p of W.props.slice(1)) {
    if (p.kind !== 'lamp') assert.ok(Math.hypot(p.x - (t.x + 1), p.y - t.y) >= 6);
  }
  assert.ok(W.props.length < plain.props.length + 1);
});

test('seafront sidewalks get palms at 18 m, within 150 m of the sea only', () => {
  const W = mini.world.build(craftMap({
    juncs: [{ x: -200, y: 0, kind: 1 }, { x: 200, y: 0, kind: 1 }, { x: -200, y: -300, kind: 1 }, { x: 200, y: -300, kind: 1 }],
    edges: [{ a: 0, b: 1 }, { a: 2, b: 3 }],
    land: [{ cls: 0, poly: [[-500, 100], [500, 100], [500, 500], [-500, 500]] }]
  }));
  const near = W.props.filter((p) => p.y > -50 && p.kind !== 'lamp');
  const far = W.props.filter((p) => p.y < -250 && p.kind !== 'lamp');
  assert.ok(near.length > 0 && near.every((p) => p.kind === 'palm'));
  assert.ok(far.length > 0 && far.every((p) => p.kind === 'ficus'));
  assert.ok(far.length > near.length, 'residential trees are closer together');
});
