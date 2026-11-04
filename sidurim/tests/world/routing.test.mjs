// tests/world/routing.test.mjs — WP-WORLD: routing (ARCHITECTURE 12.3, section 19 item 6, section 18).
import assert from 'node:assert';
import { test } from 'node:test';
import { miniTLV, realTLV, sampler, craftMap, perfOnly } from './helpers.mjs';

const mini = miniTLV();
const M = mini.world.get('mini');
const real = realTLV();
const R = real.world.get('tlv_center');
const routing = real.world.routing;
const lanes = real.world.lanes;
const AI = real.const.LF.AI_ROUTABLE;

/** Nearest AI lane to a POI's door. */
function doorLane(W, poi) {
  for (const reach of [30, 80, 200, 500]) {
    const q = real.world.lanes._nearest(W, poi.entX, poi.entY, null, reach, true, {});
    if (q) return q;
  }
  return null;
}

/** Every step of a route must be a legal move, and the polyline must be drivable. */
function assertLegal(W, route, from, to) {
  assert.ok(route.dirEdges instanceof Int32Array);
  assert.strictEqual(route.dirEdges[0], W.lanes[from.laneId].dirEdge);
  assert.strictEqual(route.dirEdges[route.dirEdges.length - 1], W.lanes[to.laneId].dirEdge);
  for (let i = 0; i + 1 < route.dirEdges.length; i++) {
    const d = W.dirEdges[route.dirEdges[i]];
    assert.ok(d.moves.includes(route.dirEdges[i + 1]), `${d.id} to ${route.dirEdges[i + 1]} has no move`);
    assert.ok(d.lanes.some((l) => real.world.junctions.connFor(W, l, route.dirEdges[i + 1]) >= 0), 'no lane holds that move');
  }
  assert.ok(route.px instanceof Float32Array && route.py instanceof Float32Array && route.cum instanceof Float32Array);
  assert.ok(route.len > 0);
  for (let i = 1; i < route.px.length; i++) {
    const d = Math.hypot(route.px[i] - route.px[i - 1], route.py[i] - route.py[i - 1]);
    assert.ok(Number.isFinite(d) && d <= 3.01, `gap ${d} at ${i}`);
  }
  assert.ok(Math.abs(route.cum[route.cum.length - 1] - route.len) < 1e-2);
  const start = lanes.pointAt(W, from.laneId, from.s, {});
  const end = lanes.pointAt(W, to.laneId, to.s, {});
  assert.ok(Math.hypot(route.px[0] - start.x, route.py[0] - start.y) < 0.01, 'starts where asked');
  const last = route.px.length - 1;
  assert.ok(Math.hypot(route.px[last] - end.x, route.py[last] - end.y) < 0.01, 'ends where asked');
}

/** Full cost by the contract's rule: Dijkstra over moves, for checking A*. */
function dijkstraCost(W, from, to) {
  const T = real.tune.world;
  const r = W.index.route;
  const n = W.dirEdges.length;
  const dist = new Float64Array(n).fill(Infinity);
  const startDir = W.lanes[from.laneId].dirEdge;
  const target = W.lanes[to.laneId].dirEdge;
  const open = new Set();
  const startCost = (W.lanes[from.laneId].len - from.s) / W.dirEdges[startDir].vmax;
  const targetCost = to.s / W.dirEdges[target].vmax;
  let best = Infinity;
  const relax = (u, base) => {
    for (let k = r.off[u]; k < r.off[u + 1]; k++) {
      const v = r.to[k];
      if (!W.dirEdges[v].aiRoutable) continue;
      if (v === target) best = Math.min(best, base + r.hop[k] + targetCost);
      const c = base + r.hop[k] + r.whole[v];
      if (c < dist[v]) {
        dist[v] = c;
        open.add(v);
      }
    }
  };
  relax(startDir, startCost);
  while (open.size) {
    let u = -1;
    for (const v of open) if (u < 0 || dist[v] < dist[u]) u = v;
    open.delete(u);
    if (dist[u] >= best) continue;
    relax(u, dist[u]);
  }
  return best;
}

/** Cost of the path a route took, by the same rule. */
function routeCost(W, route, from, to) {
  const r = W.index.route;
  const path = route.dirEdges;
  let cost = (W.lanes[from.laneId].len - from.s) / W.dirEdges[path[0]].vmax;
  for (let i = 1; i < path.length; i++) {
    let hop = Infinity;
    for (let k = r.off[path[i - 1]]; k < r.off[path[i - 1] + 1]; k++) if (r.to[k] === path[i]) hop = r.hop[k];
    cost += hop + (i + 1 === path.length ? to.s / W.dirEdges[path[i]].vmax : r.whole[path[i]]);
  }
  return cost;
}

/** 500 POI pairs as door lanes. The same pairs for the legality check and for the budget. */
function poiPairs() {
  const rnd = sampler(2024);
  const pois = R.pois.filter((p) => !(p.flags & real.const.POIF.NO_FACADE));
  const pairs = [];
  for (let i = 0; i < 500; i++) {
    const a = pois[Math.floor(rnd() * pois.length)];
    const b = pois[Math.floor(rnd() * pois.length)];
    pairs.push({ a, b, from: doorLane(R, a), to: doorLane(R, b) });
  }
  return pairs;
}

test('section 19.6: legal routes for 500 random POI pairs', () => {
  let same = 0;
  for (const { a, b, from, to } of poiPairs()) {
    assert.ok(from && to, 'no AI lane near a POI');
    const route = routing.routeLanes(R, from.laneId, from.s, to.laneId, to.s, { ai: true });
    assert.ok(route, `no route from POI ${a.id} to POI ${b.id}`);
    assertLegal(R, route, from, to);
    for (const d of route.dirEdges) assert.ok(R.dirEdges[d].aiRoutable, 'left the AI network');
    if (route.dirEdges.length === 1) same++;
  }
  assert.ok(same < 25);
});

test('section 19.6: routes are within budget', perfOnly, () => {
  const pairs = poiPairs();
  // Warm code, as in play, with the first round warming it. The best round counts, because the machine may be busy.
  for (const { from, to } of pairs) routing.routeLanes(R, from.laneId, from.s, to.laneId, to.s, { ai: true });
  let best = Infinity;
  for (let round = 0; round < 8 && best > 2; round++) {
    const times = pairs.map(({ from, to }) => {
      const t0 = performance.now();
      routing.routeLanes(R, from.laneId, from.s, to.laneId, to.s, { ai: true });
      return performance.now() - t0;
    });
    times.sort((x, y) => x - y);
    best = Math.min(best, times[Math.floor(times.length * 0.99)]);
  }
  assert.ok(best <= 2, `p99 ${best} ms, budget 2 ms`);
});

test('A* matches Dijkstra on the contract cost: the heuristic is admissible', () => {
  const rnd = sampler(6);
  const ai = R.lanes.filter((l) => l.flags & AI);
  for (let i = 0; i < 60; i++) {
    const a = ai[Math.floor(rnd() * ai.length)];
    const b = ai[Math.floor(rnd() * ai.length)];
    if (a.dirEdge === b.dirEdge) continue;
    const from = { laneId: a.id, s: rnd() * a.len };
    const to = { laneId: b.id, s: rnd() * b.len };
    const route = routing.routeLanes(R, from.laneId, from.s, to.laneId, to.s, { ai: true });
    assert.ok(route);
    const best = dijkstraCost(R, from, to);
    const got = routeCost(R, route, from, to);
    assert.ok(Math.abs(got - best) < 1e-6, `pair ${i}: A* ${got}, Dijkstra ${best}`);
  }
});

test('every moves-table turn the route takes exists, and a banned turn is never taken', () => {
  // Two roads meet, with the left turn at the junction removed from moves: the route must go round.
  const W = real.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }, { x: 0, y: 100, kind: 1 }, { x: 100, y: 100, kind: 1 }],
    edges: [
      { a: 0, b: 1, lanesB: 0 }, { a: 1, b: 2, lanesB: 0 }, { a: 1, b: 3, lanesB: 0 }, { a: 2, b: 4, lanesB: 0 }, { a: 4, b: 3, lanesB: 0 }
    ],
    // Straight on only from edge 0: no move onto edge 2.
    moves: [[0, 2, 0], [2, 6, 2], [6, 8, 2]]
  }));
  const from = { laneId: W.dirEdges[0].lanes[0], s: 10 };
  const to = { laneId: W.dirEdges[8].lanes[0], s: 50 };
  const route = routing.routeLanes(W, from.laneId, from.s, to.laneId, to.s, {});
  assert.deepStrictEqual(Array.from(route.dirEdges), [0, 2, 6, 8]);
  assert.strictEqual(routing.routeLanes(W, from.laneId, from.s, W.dirEdges[4].lanes[0], 10, {}), null);
});

test('cost counts 12 s per signal and 3 s per left', () => {
  const build = (kind, turn) => real.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0, kmh: 36 }, { a: 1, b: 2, lanesB: 0, kmh: 36 }],
    moves: [[0, 2, turn]]
  }));
  const hop = (W) => W.index.route.hop[0];
  const plain = hop(build(1, 0));
  assert.ok(Math.abs(hop(build(2, 0)) - plain - 12) < 1e-9);
  assert.ok(Math.abs(hop(build(1, 2)) - plain - 3) < 1e-9);
});

test('a target behind the car on its own lane needs a loop, and ahead needs none', () => {
  const e = M.edges.find((x) => x.lanesB === 1 && x.px[0] === 0 && x.py[0] === 0);
  const lane = M.dirEdges[e.id * 2].lanes[0];
  const ahead = mini.world.routing.routeLanes(M, lane, 20, lane, 100, {});
  assert.deepStrictEqual(Array.from(ahead.dirEdges), [e.id * 2]);
  assert.ok(Math.abs(ahead.len - 80) < 0.01);
  assert.strictEqual(ahead.fromS, 20);
  assert.strictEqual(ahead.toS, 100);
  const fresh = miniTLV();
  const F = fresh.world.get('mini');
  const behind = fresh.world.routing.routeLanes(F, lane, 100, lane, 20, {});
  assert.ok(behind.dirEdges.length > 2, 'round the block');
  assert.strictEqual(behind.dirEdges[0], e.id * 2);
  assert.strictEqual(behind.dirEdges[behind.dirEdges.length - 1], e.id * 2);
  for (let i = 0; i + 1 < behind.dirEdges.length; i++) assert.ok(F.dirEdges[behind.dirEdges[i]].moves.includes(behind.dirEdges[i + 1]));
  assert.ok(behind.len > 400, `len ${behind.len}`);
});

test('opts.ai never takes a road outside the AI network, even when it is the shorter way', () => {
  const W = real.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }, { x: 200, y: 0, kind: 1 }, { x: 100, y: 200, kind: 1 }],
    edges: [
      { a: 0, b: 1, lanesB: 0 },
      { a: 1, b: 2, lanesB: 0, flags: 0 },
      { a: 2, b: 3, lanesB: 0 },
      { a: 1, b: 4, lanesB: 0 },
      { a: 4, b: 2, lanesB: 0 }
    ],
    moves: [[0, 2, 0], [0, 6, 2], [2, 4, 0], [6, 8, 1], [8, 4, 2]]
  }));
  const from = W.dirEdges[0].lanes[0];
  const to = W.dirEdges[4].lanes[0];
  assert.deepStrictEqual(Array.from(routing.routeLanes(W, from, 10, to, 50, {}).dirEdges), [0, 2, 4]);
  assert.deepStrictEqual(Array.from(routing.routeLanes(W, from, 10, to, 50, { ai: true }).dirEdges), [0, 6, 8, 4]);
  assert.strictEqual(routing.routeLanes(W, from, 10, W.dirEdges[2].lanes[0], 50, { ai: true }), null);
});

test('route snaps by heading and respects opts.ai', () => {
  const r = mini.world.routing;
  const e = M.edges.find((x) => x.lanesB === 1 && x.px[0] === 0 && x.py[0] === 0);
  const target = M.dirEdges[e.id * 2].lanes[0];
  const a = r.route(M, 1.5, 30, Math.PI / 2, target, 150, {});
  assert.strictEqual(a.dirEdges.length, 1);
  assert.ok(Math.abs(a.len - (150 - (30 - 6.9))) < 0.1, `len ${a.len}`);
  const b = r.route(M, -1.5, 30, -Math.PI / 2, target, 150, {});
  assert.ok(b.dirEdges.length > 1, 'southbound must go round');
  assert.strictEqual(r.route(M, 100, 100, 0, target, 150, { maxDist: 10 }), null);
  assert.strictEqual(r.route(M, 0, 0, 0, -1, 0, {}), null);
  assert.strictEqual(r.routeLanes(M, -1, 0, target, 0, {}), null);
  assert.strictEqual(r.routeLanes(M, target, 0, -1, 0, {}), null);
});

test('real map: a route from a free position on a real street, ending at a door lane', () => {
  const rnd = sampler(12);
  const ai = R.lanes.filter((l) => l.flags & AI);
  for (let i = 0; i < 100; i++) {
    const a = ai[Math.floor(rnd() * ai.length)];
    const b = ai[Math.floor(rnd() * ai.length)];
    const p = lanes.pointAt(R, a.id, a.len / 2, {});
    const route = routing.route(R, p.x, p.y, p.h, b.id, b.len / 2, { ai: true });
    assert.ok(route, `pair ${i}`);
  }
});

test('project on a route tracks position along it', () => {
  const e = M.edges.find((x) => x.lanesB === 1 && x.px[0] === 0 && x.py[0] === 0);
  const lane = M.dirEdges[e.id * 2].lanes[0];
  const route = mini.world.routing.routeLanes(M, lane, 10, lane, 150, {});
  const out = { s: 0, d: 0 };
  const q = mini.world.routing.project(route, 4.5, 60, -1, out);
  assert.strictEqual(q, out);
  assert.ok(Math.abs(q.s - (60 - 6.9 - 10)) < 0.01);
  assert.ok(Math.abs(q.d - 3) < 0.01);
  assert.strictEqual(mini.world.routing.project(null, 0, 0, -1, out), null);
});

test('randomExit: weighted by class, stays in the AI network, deterministic, tolerates -1', () => {
  const rnd = { next: sampler(1) };
  const exits = R.lanes.filter((l) => l.conns.length >= 2 && (l.flags & AI));
  for (const lane of exits) {
    const c = routing.randomExit(R, lane.id, rnd);
    assert.ok(lane.conns.includes(c));
    const offNetwork = !(R.lanes[R.conns[c].to].flags & AI);
    if (offNetwork) assert.ok(Array.from(lane.conns).every((k) => !(R.lanes[R.conns[k].to].flags & AI)));
  }
  assert.strictEqual(routing.randomExit(R, -1, rnd), -1);
  const dead = R.lanes.find((l) => l.conns.length === 0);
  assert.strictEqual(routing.randomExit(R, dead.id, rnd), -1);

  // Exits onto primary (5) and service (0.15): the primary wins 5 / 5.15 of the time.
  const W = real.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }, { x: 0, y: 100, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0 }, { a: 1, b: 2, lanesB: 0, cls: 0 }, { a: 1, b: 3, lanesB: 0, cls: 6 }],
    moves: [[0, 2, 0], [0, 4, 2]]
  }));
  const lane = W.dirEdges[0].lanes[0];
  const hits = [0, 0];
  const r2 = { next: sampler(9) };
  for (let i = 0; i < 20000; i++) {
    const c = W.conns[routing.randomExit(W, lane, r2)];
    hits[W.lanes[c.to].cls === 0 ? 0 : 1]++;
  }
  const share = hits[0] / 20000;
  assert.ok(Math.abs(share - 5 / 5.15) < 0.01, `share ${share}`);
});

test('randomExit prefers anything to a U-turn', () => {
  const rnd = { next: sampler(4) };
  const W = real.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1 }, { a: 1, b: 2 }],
    moves: [[0, 2, 0], [0, 1, 3]]
  }));
  const only = W.dirEdges[0].lanes[0];
  assert.strictEqual(W.lanes[only].conns.length, 2);
  for (let i = 0; i < 200; i++) assert.strictEqual(W.conns[routing.randomExit(W, only, rnd)].turn, 'S');
  for (const c of R.conns) {
    if (c.turn !== 'U') continue;
    const lane = R.lanes[c.from];
    if (lane.conns.length < 2) continue;
    const others = Array.from(lane.conns).filter((k) => R.conns[k].turn !== 'U' && (R.lanes[R.conns[k].to].flags & AI));
    if (!others.length) continue;
    for (let i = 0; i < 20; i++) assert.notStrictEqual(routing.randomExit(R, lane.id, rnd), c.id);
  }
});

/**
 * A road east with a detour round the junction's south side. A pillar on the junction's centre stands on the straight-on
 * connector and no other, and a chord of 6 m is too short to bow round it.
 */
function pillarMap(opts = {}) {
  const pillar = { ring: [[-0.1, -0.1], [0.1, -0.1], [0.1, 0.1], [-0.1, 0.1]] };
  return craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }, { x: 0, y: -100, kind: 1 }, { x: 200, y: 0, kind: 1 }],
    edges: [
      { a: 0, b: 1, lanesB: 0 }, { a: 1, b: 2, lanesB: 0 }, { a: 1, b: 3, lanesB: 0, flags: opts.offNetwork ? 0 : 24 },
      { a: 3, b: 2, lanesB: 0 }, { a: 2, b: 4, lanesB: 0 }
    ],
    moves: opts.noDetour ? [[0, 2, 0], [2, 8, 0]] : [[0, 2, 0], [0, 4, 1], [2, 8, 0], [4, 6, 2], [6, 8, 1]],
    blds: opts.open ? [] : [pillar]
  });
}

test('a route goes round a connector through a wall, and through it only if forced', () => {
  const W = real.world.build(pillarMap());
  const start = W.dirEdges[0].lanes[0];
  const end = W.dirEdges[8].lanes[0];
  const straight = real.world.junctions.connFor(W, start, 2);
  const turn = real.world.junctions.connFor(W, start, 4);
  assert.strictEqual(W.index.connWalled[straight], 1, 'this map tests nothing');
  assert.strictEqual(W.index.connWalled[turn], 0);
  const direct = [0, 2, 8];
  assert.deepStrictEqual(Array.from(routing.routeLanes(W, start, 50, end, 50).dirEdges), [0, 4, 6, 8]);
  // With nothing in the way the short road wins, so the wall is what moved the route.
  const open = real.world.build(pillarMap({ open: true }));
  assert.deepStrictEqual(Array.from(routing.routeLanes(open, start, 50, end, 50).dirEdges), direct);
  // With no other way the route still exists.
  const forced = real.world.build(pillarMap({ noDetour: true }));
  assert.deepStrictEqual(Array.from(routing.routeLanes(forced, start, 50, end, 50).dirEdges), direct);
  assert.deepStrictEqual(Array.from(routing.routeLanes(forced, start, 50, end, 50, { ai: true }).dirEdges), direct);
});

test('a move with a clear lane costs nothing extra, and the route draws through that lane', () => {
  // Two 2 m lanes through a junction, a pillar on the right one's connector only. Lanes this narrow leave a 7 m chord, too short
  // to bow round it.
  const W = real.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesF: 2, lanesB: 0, laneW: 2 }, { a: 1, b: 2, lanesF: 2, lanesB: 0, laneW: 2 }],
    moves: [[0, 2, 0]],
    blds: [{ ring: [[-0.1, -1.1], [0.1, -1.1], [0.1, -0.9], [-0.1, -0.9]] }]
  }));
  const right = W.dirEdges[0].lanes[0];
  const left = W.dirEdges[0].lanes[1];
  assert.strictEqual(W.index.connWalled[W.lanes[right].conns[0]], 1, 'this map tests nothing');
  assert.strictEqual(W.index.connWalled[W.lanes[left].conns[0]], 0);
  assert.ok(W.index.route.hop[W.index.route.off[0]] < 1, 'the move is not priced as blocked');
  const route = routing.routeLanes(W, right, 20, W.dirEdges[2].lanes[0], 60);
  for (let i = 0; i + 1 < route.px.length; i++) {
    assert.ok(!real.world.spatial.rayBlocked(W, route.px[i], route.py[i], route.px[i + 1], route.py[i + 1]), `route hits the wall at ${route.px[i]}`);
  }
});

test('randomExit takes an exit through a wall last of all, and still answers when nothing else exists', () => {
  const rnd = { next: sampler(12) };
  const pick = (W, lane) => {
    const seen = new Set();
    for (let i = 0; i < 400; i++) seen.add(routing.randomExit(W, lane, rnd));
    return seen;
  };
  const open = real.world.build(pillarMap({ open: true }));
  const lane = open.dirEdges[0].lanes[0];
  const straight = real.world.junctions.connFor(open, lane, 2);
  const turn = real.world.junctions.connFor(open, lane, 4);
  assert.deepStrictEqual(pick(open, lane), new Set([straight, turn]), 'both are ordinary exits');
  assert.deepStrictEqual(pick(real.world.build(pillarMap()), lane), new Set([turn]));
  // Below even an exit that leaves the AI network.
  assert.deepStrictEqual(pick(real.world.build(pillarMap({ offNetwork: true })), lane), new Set([turn]));
  // All exits walled: still one of them, never -1.
  const both = real.world.build(pillarMap());
  both.index.connWalled[turn] = 1;
  assert.deepStrictEqual(pick(both, lane), new Set([straight, turn]));
  // The only exit: forced.
  const forced = real.world.build(pillarMap({ noDetour: true }));
  const only = real.world.junctions.connFor(forced, lane, 2);
  assert.strictEqual(forced.index.connWalled[only], 1, 'this map tests nothing');
  assert.deepStrictEqual(pick(forced, lane), new Set([only]));
});

/** @returns {boolean} True when directed edge `to` can be reached from `from` by any way but the move straight between them. */
function wayRound(W, from, to) {
  const seen = new Set([from]);
  const queue = [from];
  while (queue.length) {
    const d = queue.pop();
    for (const next of W.dirEdges[d].moves || []) {
      if (d === from && next === to) continue;
      if (next === to) return true;
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
  }
  return false;
}

test('on the real network, no AI walk or route takes a connector marked as walled, however far the way round', () => {
  // tlv_center has no walled connector left, so five ordinary ones stand in. Each is its move's only connector, is not its lane's
  // only exit, and a way round exists, as it did for the 5 real ones.
  const W = real.world.build(real.world.map.payload('tlv_center'));
  const pick = sampler(31);
  const marked = [];
  while (marked.length < 5) {
    const c = W.conns[Math.floor(pick() * W.conns.length)];
    const lane = W.lanes[c.from];
    if (!(lane.flags & AI) || !(W.lanes[c.to].flags & AI) || c.px.length === 2 || lane.conns.length < 2) continue;
    if (W.dirEdges[lane.dirEdge].lanes.length !== 1 || !wayRound(W, lane.dirEdge, W.lanes[c.to].dirEdge)) continue;
    marked.push(c);
    W.index.connWalled[c.id] = 1;
    W.index.walledConns.push(c.id);
  }
  routing._build(W);
  const rnd = { next: sampler(33) };
  for (const c of marked) {
    for (let i = 0; i < 300; i++) assert.notStrictEqual(routing.randomExit(W, c.from, rnd), c.id);
    const route = routing.routeLanes(W, c.from, W.lanes[c.from].len - 1, c.to, 1, {});
    assert.ok(route, `connector ${c.id} has no route at all`);
    const legs = Array.from(route.dirEdges);
    const from = W.lanes[c.from].dirEdge;
    const to = W.lanes[c.to].dirEdge;
    for (let i = 0; i + 1 < legs.length; i++) assert.ok(!(legs[i] === from && legs[i + 1] === to), `route takes connector ${c.id}`);
    assert.ok(route.len > 30, `connector ${c.id} was the short way, so going round must cost something`);
  }
  // Routes through the very junctions that hold them, from the doors around each.
  const choose = sampler(32);
  let routes = 0;
  for (const c of marked) {
    const j = W.juncs[c.junc];
    const near = W.pois.filter((p) => Math.hypot(p.entX - j.x, p.entY - j.y) < 500);
    const from = W.lanes[c.from].dirEdge;
    const to = W.lanes[c.to].dirEdge;
    for (let i = 0; i < 60 && near.length > 1; i++) {
      const a = doorLane(W, near[Math.floor(choose() * near.length)]);
      const b = doorLane(W, near[Math.floor(choose() * near.length)]);
      const route = routing.routeLanes(W, a.laneId, a.s, b.laneId, b.s, {});
      if (!route) continue;
      routes++;
      const legs = Array.from(route.dirEdges);
      for (let k = 0; k + 1 < legs.length; k++) assert.ok(!(legs[k] === from && legs[k + 1] === to), `route ${routes} takes connector ${c.id}`);
    }
  }
  assert.ok(routes > 200, `only ${routes} routes`);
});

test('route results do not depend on what ran before', () => {
  const rnd = sampler(77);
  const ai = R.lanes.filter((l) => l.flags & AI);
  const pairs = [];
  for (let i = 0; i < 30; i++) pairs.push([ai[Math.floor(rnd() * ai.length)], ai[Math.floor(rnd() * ai.length)]]);
  const once = pairs.map(([a, b]) => Array.from(routing.routeLanes(R, a.id, a.len / 2, b.id, b.len / 2, { ai: true }).dirEdges));
  const again = pairs.slice().reverse().map(([a, b]) => Array.from(routing.routeLanes(R, a.id, a.len / 2, b.id, b.len / 2, { ai: true }).dirEdges)).reverse();
  assert.deepStrictEqual(again, once);
});
