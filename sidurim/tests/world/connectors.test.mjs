// tests/world/connectors.test.mjs — WP-WORLD: connectors, conflicts and junction shape (ARCHITECTURE 8.2, section 19 items 3, 4, 11).
import assert from 'node:assert';
import { test } from 'node:test';
import { miniTLV, realTLV, craftMap, closedCycles, ringsOf } from './helpers.mjs';

const mini = miniTLV();
const M = mini.world.get('mini');
const real = realTLV();
const R = real.world.get('tlv_center');
const math = real.math;
const worlds = [M, R];

function cross(p, q) {
  for (let i = 0; i + 1 < p.px.length; i++) {
    for (let j = 0; j + 1 < q.px.length; j++) {
      if (math.segSegHit(p.px[i], p.py[i], p.px[i + 1], p.py[i + 1], q.px[j], q.py[j], q.px[j + 1], q.py[j + 1])) return true;
    }
  }
  return false;
}

function approachConns(W, d) {
  const out = [];
  for (const l of d.lanes) for (const c of W.lanes[l].conns) out.push(W.conns[c]);
  return out;
}

/** Bearing of an exit's lanes from the end of the approach, in the approach's frame. + is left. */
function bearing(W, d, to) {
  const from = W.lanes[d.lanes[0]];
  const target = W.lanes[W.dirEdges[to].lanes[W.dirEdges[to].lanes.length >> 1]];
  const n = from.px.length - 1;
  const dx = target.px[0] - from.px[n];
  const dy = target.py[0] - from.py[n];
  return Math.atan2(Math.cos(d.hOut) * dy - Math.sin(d.hOut) * dx, Math.cos(d.hOut) * dx + Math.sin(d.hOut) * dy);
}

test('mini: the counts section 7.5 implies', () => {
  // 12 edges: the 2 one-way ones hold 2 lanes each, and the 10 two-way ones 2 lanes each. No U-turns.
  assert.strictEqual(M.lanes.length, 24);
  for (const c of M.conns) assert.notStrictEqual(c.turn, 'U');
  const centre = M.juncs.find((j) => j.x === 0 && j.y === 0);
  // Eastbound arm: 2 lanes, 3 exits, which is 4 connectors. North and south arms: 1 lane, 2 exits, because the west arm
  // is one-way toward the centre.
  assert.strictEqual(centre.conns.length, 4 + 2 + 2);
});

test('mini: lane to exit mapping by hand at the centre', () => {
  const e = M.edges.find((x) => x.lanesB === 0 && x.px[1] === 0);
  const d = M.dirEdges[e.id * 2];
  const right = M.lanes[d.lanes[0]];
  const left = M.lanes[d.lanes[1]];
  const turns = (lane) => Array.from(lane.conns, (c) => M.conns[c].turn);
  // k = 3, n = 2. Exit 0 (right) takes lane 0. Exit 1 (straight) lanes 0 and 1. Exit 2 (left) lane 1.
  assert.deepStrictEqual(turns(right), ['R', 'S']);
  assert.deepStrictEqual(turns(left), ['S', 'L']);
  // The straight exit is 2 lanes one-way: lane 0 to idx 0, lane 1 to idx 1.
  const s0 = M.conns[right.conns[1]];
  const s1 = M.conns[left.conns[0]];
  assert.strictEqual(M.lanes[s0.to].idx, 0);
  assert.strictEqual(M.lanes[s1.to].idx, 1);
});

test('mini: connector geometry, priority and slot by hand', () => {
  const e = M.edges.find((x) => x.lanesB === 0 && x.px[1] === 0);
  const right = M.lanes[M.dirEdges[e.id * 2].lanes[0]];
  const s = M.conns[right.conns[1]];
  // Straight at y = -1.5 from x = -6.9 to 6.9.
  assert.ok(Math.abs(s.len - 13.8) < 1e-3);
  for (let i = 0; i < s.px.length; i++) assert.ok(Math.abs(s.py[i] - -1.5) < 1e-5);
  assert.ok(Math.abs(s.vmax - 50 / 3.6) < 1e-6, 'a straight connector keeps lane speed');
  // cls 2: 6 - 2 + 2 for straight.
  assert.strictEqual(s.priority, 6);
  const r = M.conns[right.conns[0]];
  assert.strictEqual(r.turn, 'R');
  assert.strictEqual(r.priority, 5);
  assert.ok(r.vmax > 2 && r.vmax < 50 / 3.6);
  assert.ok(r.slot >= 0);
  const pts = Math.max(...Array.from({ length: r.px.length - 1 }, (_, i) => Math.hypot(r.px[i + 1] - r.px[i], r.py[i + 1] - r.py[i])));
  assert.ok(pts <= 1.55, 'samples every 1.5 m');
  // The priority junction at a corner has no slot.
  const corner = M.juncs.find((j) => j.x === -200 && j.y === -200);
  for (const c of corner.conns) assert.strictEqual(M.conns[c].slot, -1);
});

test('section 19.3: rightmost lane takes the rightmost exit, leftmost the leftmost, on every multi-lane approach', () => {
  let tested = 0;
  for (const W of worlds) {
    for (const d of W.dirEdges) {
      if (!d || d.lanes.length < 2 || d.moves.length < 2) continue;
      const plain = Array.from(d.moves);
      const us = new Set(approachConns(W, d).filter((c) => c.turn === 'U').map((c) => W.lanes[c.to].dirEdge));
      const ranked = plain.filter((to) => !us.has(to)).sort((a, b) => bearing(W, d, a) - bearing(W, d, b));
      if (ranked.length < 2) continue;
      const first = W.lanes[d.lanes[0]];
      const last = W.lanes[d.lanes[d.lanes.length - 1]];
      assert.ok(Array.from(first.conns).some((c) => W.lanes[W.conns[c].to].dirEdge === ranked[0]), `approach ${d.id}: lane 0 misses the rightmost exit`);
      const top = us.size ? null : ranked[ranked.length - 1];
      if (top !== null) assert.ok(Array.from(last.conns).some((c) => W.lanes[W.conns[c].to].dirEdge === top), `approach ${d.id}: top lane misses the leftmost exit`);
      tested++;
    }
  }
  assert.ok(tested > 400, `tested ${tested}`);
});

test('section 19.3: no straight connector crosses a right-turn connector from a lane to its left', () => {
  for (const W of worlds) {
    for (const d of W.dirEdges) {
      if (!d || d.lanes.length < 2) continue;
      const conns = approachConns(W, d);
      for (const s of conns) {
        if (s.turn !== 'S') continue;
        for (const r of conns) {
          if (r.turn !== 'R' || W.lanes[r.from].idx <= W.lanes[s.from].idx) continue;
          assert.ok(!cross(s, r), `approach ${d.id}: connectors ${s.id} and ${r.id}`);
        }
      }
    }
  }
});

/** True for an approach 8.2 would strand: a ring arc of 2 or more lanes, with a way off it and the way round as its leftmost exit. */
function spirals(W, d) {
  const ROUNDABOUT = real.const.EF.ROUNDABOUT;
  const onRing = (de) => (W.edges[W.dirEdges[de].edge].flags & ROUNDABOUT) !== 0;
  const exits = Array.from(d.moves);
  if (d.lanes.length < 2 || exits.length < 2 || !(W.edges[d.edge].flags & ROUNDABOUT)) return false;
  return exits.every((to, t) => onRing(to) === (t === exits.length - 1));
}

test('every lane gets an exit, every exit a lane, and the mapping formula holds', () => {
  let spiralled = 0;
  for (const W of worlds) {
    for (const d of W.dirEdges) {
      if (!d || !d.moves.length) continue;
      const exits = Array.from(d.moves);
      for (const l of d.lanes) assert.ok(W.lanes[l].conns.length >= 1, `lane ${l}`);
      if (spirals(W, d)) {
        spiralled++;
        continue;
      }
      const k = exits.length;
      const n = d.lanes.length;
      exits.forEach((to, t) => {
        const a = Math.floor(t * n / k);
        const b = Math.max(a, Math.ceil((t + 1) * n / k) - 1);
        const nOut = W.dirEdges[to].lanes.length;
        for (let lane = 0; lane < n; lane++) {
          const has = Array.from(W.lanes[d.lanes[lane]].conns).filter((c) => W.lanes[W.conns[c].to].dirEdge === to);
          if (lane < a || lane > b) {
            assert.strictEqual(has.length, 0);
            continue;
          }
          assert.strictEqual(has.length, 1);
          assert.strictEqual(W.lanes[W.conns[has[0]].to].idx, Math.round(lane / Math.max(1, n - 1) * (nOut - 1)));
        }
      });
    }
  }
  assert.strictEqual(spiralled, 22, 'the ring arcs of tlv_center that leave 8.2');
});

/**
 * A ring of four 2-lane arcs. A hub holds an exit road when exits[i], and every road in is a two-way stub, so the only cycle that
 * can close is on the ring. Moves are sorted, as the map's are.
 */
function ringMap(lanes = 2, exits = [true, true, true, true], reach = 150) {
  const hub = [[50, 0], [0, 50], [-50, 0], [0, -50]].map(([x, y]) => ({ x, y, kind: 3 }));
  const far = [[reach, 0], [0, reach], [-reach, 0], [0, -reach]].map(([x, y]) => ({ x, y, kind: 1 }));
  const edges = [];
  for (let i = 0; i < 4; i++) edges.push({ a: i, b: (i + 1) % 4, lanesF: lanes, lanesB: 0, cls: 2, flags: 1 | 8 | 16 });
  for (let i = 0; i < 4; i++) edges.push({ a: i, b: 4 + i, cls: 3 });
  const moves = [];
  for (let i = 0; i < 4; i++) {
    const inArc = 2 * ((i + 3) % 4);
    const stub = 2 * (4 + i);
    moves.push([inArc, 2 * i, 2]);
    if (exits[i]) moves.push([inArc, stub, 1]);
    moves.push([stub + 1, 2 * i, 1]);
  }
  moves.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  return craftMap({ juncs: [...hub, ...far], edges, moves });
}

test('a ring arc with a way off it spirals: the right lane takes every way, and the left lane feeds the right lane of the next arc', () => {
  const W = real.world.build(ringMap());
  const arc = W.dirEdges[0];
  const right = W.lanes[arc.lanes[0]];
  const left = W.lanes[arc.lanes[1]];
  const target = (c) => W.lanes[W.conns[c].to];
  assert.deepStrictEqual(Array.from(right.conns, (c) => [target(c).dirEdge, target(c).idx]), [[2 * 5, 0], [2, 0]]);
  assert.deepStrictEqual(Array.from(left.conns, (c) => [target(c).dirEdge, target(c).idx]), [[2, 0]]);
  // Two connectors merge into the next arc's right lane, so 8.2's shared target makes them conflict.
  assert.ok(W.conns[right.conns[1]].conflicts.includes(left.conns[0]));
  assert.deepStrictEqual(closedCycles(W, real.const.LF.AI_ROUTABLE, Infinity), []);
});

test('a ring hub with no way off keeps 8.2, lane for lane', () => {
  const W = real.world.build(ringMap(2, [true, false, false, false]));
  for (const i of [1, 2]) {
    const arc = W.dirEdges[2 * ((i + 3) % 4)];
    assert.deepStrictEqual(Array.from(arc.lanes, (l) => Array.from(W.lanes[l].conns, (c) => W.lanes[W.conns[c].to].idx)), [[0], [1]]);
  }
  assert.deepStrictEqual(closedCycles(W, real.const.LF.AI_ROUTABLE, Infinity), [], 'one way off is enough');
});

test('a one-lane ring stays as 8.2 has it, and so does an arc whose way round is not its leftmost exit', () => {
  const one = real.world.build(ringMap(1));
  assert.deepStrictEqual(Array.from(one.lanes[one.dirEdges[0].lanes[0]].conns, (c) => one.lanes[one.conns[c].to].dirEdge), [2 * 5, 2]);
  // A road onto the island leaves left of the way round, so the two right-of-way orders disagree and the formula stands.
  const W = real.world.build(ringMap(2, [true, true, true, true], 20));
  const arc = W.dirEdges[0];
  assert.deepStrictEqual(Array.from(arc.lanes, (l) => Array.from(W.lanes[l].conns, (c) => W.lanes[W.conns[c].to].dirEdge)), [[2], [2 * 5]]);
});

test('no AI lane cycle on tlv_center lacks an exit, with lane changes only on lanes of 15 m or more', () => {
  const AI = real.const.LF.AI_ROUTABLE;
  assert.deepStrictEqual(closedCycles(R, AI, 15).map((c) => c.map((l) => [l, R.lanes[l].len])), []);
  assert.deepStrictEqual(closedCycles(M, AI, 15), []);
});

test('every ring lane of tlv_center reaches a lane off its ring by connectors alone', () => {
  const ROUNDABOUT = real.const.EF.ROUNDABOUT;
  const rings = ringsOf(R, ROUNDABOUT);
  assert.ok(rings.length >= 20, `${rings.length} rings`);
  for (const arcs of rings) {
    const own = new Set(arcs.flatMap((e) => [R.dirEdges[e.id * 2], R.dirEdges[e.id * 2 + 1]].filter(Boolean).flatMap((d) => Array.from(d.lanes))));
    for (const start of own) {
      const seen = new Set([start]);
      const stack = [start];
      let out = false;
      while (stack.length && !out) {
        const lane = R.lanes[stack.pop()];
        // A ring cut by the edge of the map ends there, which is a way out.
        if (!lane.conns.length) out = true;
        for (const c of lane.conns) {
          const to = R.conns[c].to;
          if (!own.has(to)) out = true;
          if (!seen.has(to)) {
            seen.add(to);
            stack.push(to);
          }
        }
      }
      assert.ok(out, `lane ${start} on ${arcs[0].nameEn || arcs[0].osm} never leaves its ring`);
    }
  }
});

test('a random walk leaves every ring of tlv_center, by connectors alone', () => {
  const ROUNDABOUT = real.const.EF.ROUNDABOUT;
  const rng = real.rng.create(99);
  const STEPS = 300;
  let entered = 0;
  for (const arcs of ringsOf(R, ROUNDABOUT)) {
    const dirs = arcs.flatMap((e) => [e.id * 2, e.id * 2 + 1]).filter((d) => R.dirEdges[d]);
    const own = new Set(dirs.flatMap((d) => Array.from(R.dirEdges[d].lanes)));
    const hubs = new Set(dirs.flatMap((d) => [R.dirEdges[d].from, R.dirEdges[d].to]));
    const entries = [...hubs].flatMap((j) => Array.from(R.juncs[j].inDir)).filter((d) => !dirs.includes(d) && R.dirEdges[d].aiRoutable);
    for (const d of entries) {
      for (const lane of R.dirEdges[d].lanes) {
        for (let walk = 0; walk < 20; walk++) {
          let cur = lane;
          let on = false;
          let left = false;
          for (let step = 0; step < STEPS && !left; step++) {
            const c = real.world.routing.randomExit(R, cur, rng);
            if (c < 0) {
              left = true;
              break;
            }
            cur = R.conns[c].to;
            if (own.has(cur)) on = true;
            else left = true;
          }
          if (on) entered++;
          assert.ok(left, `a walk from lane ${lane} is still on ${arcs[0].nameEn || arcs[0].osm} after ${STEPS} steps`);
        }
      }
    }
  }
  assert.ok(entered > 1000, `${entered} walks entered a ring`);
});

test('connectors that pass within a car of each other conflict, crossing or not', () => {
  // Two one-way roads pass through one junction in opposite directions, 1.6 m apart, so their connectors never touch.
  const road = (a, b, x0, x1, y) => ({ a, b, lanesB: 0, pts: [[x0, y], [x1, y]] });
  const W = real.world.build(craftMap({
    juncs: [{ x: -60, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: 60, y: 0, kind: 1 }, { x: 60, y: 1, kind: 1 }, { x: -60, y: 1, kind: 1 }],
    edges: [road(0, 1, -60, -5, -0.8), road(1, 2, 5, 60, -0.8), road(3, 1, 60, 5, 0.8), road(1, 4, -5, -60, 0.8)],
    moves: [[0, 2, 0], [4, 6, 0]]
  }));
  const [p, q] = W.conns;
  assert.ok(p.from !== q.from && p.to !== q.to);
  let touch = false;
  for (let i = 0; i + 1 < p.px.length; i++) {
    for (let j = 0; j + 1 < q.px.length; j++) {
      if (math.segSegHit(p.px[i], p.py[i], p.px[i + 1], p.py[i + 1], q.px[j], q.py[j], q.px[j + 1], q.py[j + 1])) touch = true;
    }
  }
  assert.strictEqual(touch, false, 'this map tests nothing if they cross');
  assert.ok(p.conflicts.includes(q.id));
  assert.ok(q.conflicts.includes(p.id));
});

test('tlv_center: no two connectors of a junction pass within a car of each other outside a conflict set', () => {
  const near = real.tune.world.connClearM;
  assert.strictEqual(near, 1.8);
  let pairs = 0;
  for (const j of R.juncs) {
    for (const a of j.conns) {
      for (const b of j.conns) {
        const p = R.conns[a];
        const q = R.conns[b];
        if (a >= b || p.from === q.from || p.to === q.to || p.px.length === 2 || q.px.length === 2 || p.conflicts.includes(b)) continue;
        for (let i = 0; i < p.px.length; i++) {
          for (let k = 0; k + 1 < q.px.length; k++) {
            assert.ok(math.pointSegDist(p.px[i], p.py[i], q.px[k], q.py[k], q.px[k + 1], q.py[k + 1]) >= near, `connectors ${a} and ${b}`);
          }
        }
        pairs++;
      }
    }
  }
  assert.ok(pairs > 1000, `${pairs} pairs`);
});

test('section 19.4: every AI_ROUTABLE lane has a connector, and every AI road has an AI exit', () => {
  const AI = real.const.LF.AI_ROUTABLE;
  for (const W of worlds) {
    for (const lane of W.lanes) {
      if (lane.flags & AI) assert.ok(lane.conns.length >= 1, `lane ${lane.id} is a dead end`);
    }
    for (const d of W.dirEdges) {
      if (d && d.aiRoutable) assert.ok(Array.from(d.moves).some((to) => W.dirEdges[to].aiRoutable), `directed edge ${d.id}`);
    }
  }
});

test('section 19.4: conflicts are symmetric, in one junction, and hold what 8.2 says', () => {
  for (const W of worlds) {
    for (const c of W.conns) {
      for (const o of c.conflicts) {
        assert.ok(W.conns[o].conflicts.includes(c.id), `${c.id} and ${o}`);
        assert.strictEqual(W.conns[o].junc, c.junc);
        assert.notStrictEqual(W.conns[o].from, c.from);
      }
    }
  }
  // Exact on mini, where brute force is cheap.
  for (const j of M.juncs) {
    for (const a of j.conns) {
      for (const b of j.conns) {
        if (a >= b) continue;
        const p = M.conns[a];
        const q = M.conns[b];
        const want = p.from !== q.from && (p.to === q.to || cross(p, q));
        assert.strictEqual(p.conflicts.includes(b), want, `${a} ${b}`);
      }
    }
  }
});

test('section 19.11: no connector has a NaN in len, vmax or any point, and none is dead', () => {
  for (const W of worlds) {
    assert.ok(W.conns.length > 0);
    for (const c of W.conns) {
      assert.ok(Number.isFinite(c.len) && c.len > 0, `len ${c.id}`);
      assert.ok(Number.isFinite(c.vmax) && c.vmax >= 1, `vmax ${c.id}: ${c.vmax}`);
      assert.ok(c.px.length >= 2);
      for (let i = 0; i < c.px.length; i++) assert.ok(Number.isFinite(c.px[i] + c.py[i] + c.cum[i]));
      const from = W.lanes[c.from];
      const to = W.lanes[c.to];
      const n = from.px.length - 1;
      assert.ok(Math.hypot(c.px[0] - from.px[n], c.py[0] - from.py[n]) < 1e-3, 'starts at the lane end');
      assert.ok(Math.hypot(c.px[c.px.length - 1] - to.px[0], c.py[c.py.length - 1] - to.py[0]) < 1e-3, 'ends at the target start');
      assert.strictEqual(W.dirEdges[from.dirEdge].to, c.junc);
      assert.strictEqual(W.dirEdges[to.dirEdge].from, c.junc);
    }
  }
});

/** Heading of each span from the lane before a connector to the lane after it, with each span's length. */
function spans(W, c) {
  const a = W.lanes[c.from];
  const b = W.lanes[c.to];
  const n = a.px.length - 1;
  const list = [[a.px[n] - a.px[n - 1], a.py[n] - a.py[n - 1]]];
  for (let i = 0; i + 1 < c.px.length; i++) list.push([c.px[i + 1] - c.px[i], c.py[i + 1] - c.py[i]]);
  list.push([b.px[1] - b.px[0], b.py[1] - b.py[0]]);
  return list.map(([dx, dy]) => ({ h: Math.atan2(dy, dx), l: Math.hypot(dx, dy) })).filter((q) => q.l > 0);
}

/** Largest turn at any vertex or lane joint, in degrees. */
function sharpest(W, c) {
  const list = spans(W, c);
  let most = 0;
  for (let i = 0; i + 1 < list.length; i++) most = Math.max(most, Math.abs(math.wrapPi(list[i + 1].h - list[i].h)));
  return most * 180 / Math.PI;
}

test('vmax is the 8.2 formula, on the curvature of the sampled path, lane joints included', () => {
  let limited = 0;
  let byJoint = 0;
  for (const W of worlds) {
    for (const c of W.conns) {
      if (c.px.length === 2) continue;
      const limit = Math.min(W.lanes[c.from].vmax, W.lanes[c.to].vmax);
      const list = spans(W, c);
      // A lane brings at most one 1.5 m sample to the arc round a joint, and no arc counts as under 1.5 m.
      list[0].l = Math.min(list[0].l, 1.5);
      list[list.length - 1].l = Math.min(list[list.length - 1].l, 1.5);
      const at = list.slice(0, -1).map((q, i) => Math.abs(math.wrapPi(list[i + 1].h - q.h)) * 2 / Math.max(q.l + list[i + 1].l, 1.5));
      const kappa = Math.max(...at);
      const want = kappa > 0 ? Math.min(limit, Math.sqrt(3 / kappa)) : limit;
      assert.ok(Math.abs(c.vmax - want) < 0.02 * want, `connector ${c.id}: vmax ${c.vmax}, want ${want}`);
      if (want < limit - 0.5) limited++;
      if (Math.max(at[0], at[at.length - 1]) === kappa && want < limit - 0.5) byJoint++;
    }
  }
  assert.ok(limited > 3000, `limited ${limited}`);
  assert.ok(byJoint > 20, `the joint decides on ${byJoint} connectors`);
});

/** Turn from one lane to the next in degrees, over 2 m of each. A 2-point connector's own heading means nothing over a few cm. */
function laneBend(W, c) {
  const lanes = real.world.lanes;
  const f = W.lanes[c.from];
  const t = W.lanes[c.to];
  const a = lanes.pointAt(W, f.id, Math.max(0, f.len - 2), {});
  const b = lanes.pointAt(W, f.id, f.len, {});
  const p = lanes.pointAt(W, t.id, 0, {});
  const q = lanes.pointAt(W, t.id, Math.min(t.len, 2), {});
  return Math.abs(math.wrapPi(Math.atan2(q.y - p.y, q.x - p.x) - Math.atan2(b.y - a.y, b.x - a.x))) * 180 / Math.PI;
}

/** Distance between the lane ends a connector joins. */
function chordOf(W, c) {
  const f = W.lanes[c.from];
  const t = W.lanes[c.to];
  const n = f.px.length - 1;
  return Math.hypot(t.px[0] - f.px[n], t.py[0] - f.py[n]);
}

test('connectors are smooth: tlv_center keeps its sharp turns few, and slows for each', () => {
  // Every connector counts. This test once skipped 2-point ones, which hid three that turned 128 to 154 deg at full speed. On
  // this wider measure the code before that fix had 13 non-U connectors over 60 deg. Before any smoothing: 77, 19 over 90 and
  // 9 over 120, worst 154. Pull-backs at forks left 12, worst 84.4 as before: one connector grew to 60.2 deg.
  const rows = R.conns.map((c) => ({ c, turn: c.px.length > 2 ? sharpest(R, c) : laneBend(R, c) }));
  const plain = rows.filter((r) => r.c.turn !== 'U');
  const over = (list, deg) => list.filter((r) => r.turn > deg);
  assert.ok(over(plain, 60).length <= 12, `over 60: ${over(plain, 60).map((r) => r.c.id)}`);
  assert.strictEqual(over(plain, 90).length, 0, `over 90: ${over(plain, 90).map((r) => r.c.id)}`);
  assert.ok(over(rows.filter((r) => r.c.turn === 'U'), 60).length <= 1);
  for (const r of over(rows, 60)) assert.ok(r.c.vmax < 2.1, `connector ${r.c.id} turns ${r.turn} deg at ${r.c.vmax} m/s`);
});

test('a sharp connector takes gentler control lengths, and meets its lanes in line', () => {
  // The way out starts ahead and to the left of the way in, and leaves heading back past it: as at a merged junction, where
  // the two roads never met. The plain cubic's controls cross, which leaves a cusp.
  const map = (blds) => craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: -42, y: -74.6, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0 }, { a: 1, b: 2, lanesB: 0, pts: [[8, 12], [-42, -74.6]] }],
    moves: [[0, 2, 2]],
    blds
  });
  const W = real.world.build(map([]));
  const c = W.conns[0];
  const from = W.lanes[c.from];
  const to = W.lanes[c.to];
  const last = from.px.length - 1;
  const chord = Math.hypot(to.px[0] - from.px[last], to.py[0] - from.py[last]);
  const u = [1, 0];
  const lv = Math.hypot(to.px[1] - to.px[0], to.py[1] - to.py[0]);
  const v = [(to.px[1] - to.px[0]) / lv, (to.py[1] - to.py[0]) / lv];
  const k = 0.4 * chord;
  const plain = real.world.geom.bezierPoly([from.px[last], from.py[last]], [from.px[last] + u[0] * k, from.py[last] + u[1] * k], [to.px[0] - v[0] * k, to.py[0] - v[1] * k], [to.px[0], to.py[0]], 1.5);
  const stored = { ...c, px: Float32Array.from(plain.px), py: Float32Array.from(plain.py) };
  assert.ok(sharpest(W, stored) > 75, `the plain cubic turns ${sharpest(W, stored)} deg, so this map tests nothing`);
  assert.ok(sharpest(W, c) <= 55, `connector turns ${sharpest(W, c)} deg`);
  assert.ok(Math.hypot(c.px[0] - from.px[last], c.py[0] - from.py[last]) < 1e-3, 'still starts at the lane end');
  assert.ok(Math.hypot(c.px[c.px.length - 1] - to.px[0], c.py[c.py.length - 1] - to.py[0]) < 1e-3, 'still ends at the target');
  assert.ok(Math.abs(c.len - (c.cum[c.cum.length - 1])) < 1e-3, 'len follows the new shape');
  // Walls come first: with a pillar on the gentle shape, the connector takes another, or stays, and never runs through it.
  const k2 = c.px.length >> 1;
  const pillar = [[c.px[k2] - 0.2, c.py[k2] - 0.2], [c.px[k2] + 0.2, c.py[k2] - 0.2], [c.px[k2] + 0.2, c.py[k2] + 0.2], [c.px[k2] - 0.2, c.py[k2] + 0.2]];
  const walled = real.world.build(map([{ ring: pillar }]));
  const q = walled.conns[0];
  for (let i = 0; i + 1 < q.px.length; i++) assert.ok(!real.world.spatial.rayBlocked(walled, q.px[i], q.py[i], q.px[i + 1], q.py[i + 1]), 'a gentle shape never buys its way through a wall');
});

test('smoothing stops at the first control lengths that are not sharp, in list order', () => {
  const W = real.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: -42, y: -74.6, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0 }, { a: 1, b: 2, lanesB: 0, pts: [[8, 12], [-42, -74.6]] }],
    moves: [[0, 2, 2]]
  }));
  const c = W.conns[0];
  const from = W.lanes[c.from];
  const to = W.lanes[c.to];
  const last = from.px.length - 1;
  const [x0, y0, x3, y3] = [from.px[last], from.py[last], to.px[0], to.py[0]];
  const chord = Math.hypot(x3 - x0, y3 - y0);
  const lv = Math.hypot(to.px[1] - x3, to.py[1] - y3);
  const [vx, vy] = [(to.px[1] - x3) / lv, (to.py[1] - y3) / lv];
  const first = real.tune.world.connSmoothShares.find(([a, b]) => {
    const p = real.world.geom.bezierPoly([x0, y0], [x0 + a * chord, y0], [x3 - vx * b * chord, y3 - vy * b * chord], [x3, y3], 1.5);
    return sharpest(W, { ...c, px: Float32Array.from(p.px), py: Float32Array.from(p.py) }) <= 55;
  });
  const want = real.world.geom.bezierPoly([x0, y0], [x0 + first[0] * chord, y0], [x3 - vx * first[1] * chord, y3 - vy * first[1] * chord], [x3, y3], 1.5);
  assert.strictEqual(c.px.length, want.px.length);
  for (let i = 0; i < want.px.length; i++) assert.ok(Math.abs(c.px[i] - want.px[i]) < 1e-3 && Math.abs(c.py[i] - want.py[i]) < 1e-3, `vertex ${i}`);
});

test('smoothing never picks a shape that loops, however gentle', () => {
  // The way out starts 26 m behind the end of the way in and runs on westward beside it. The gentlest control lengths here go
  // round in a full circle.
  const W = real.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: -124.5, y: -20.9, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0 }, { a: 1, b: 2, lanesB: 0, pts: [[-26, -3.5], [-124.5, -20.9]] }],
    moves: [[0, 2, 2]]
  }));
  const c = W.conns[0];
  const loops = (px, py) => {
    for (let i = 0; i + 2 < px.length; i++) {
      for (let j = i + 2; j + 1 < px.length; j++) {
        if (math.segSegHit(px[i], py[i], px[i + 1], py[i + 1], px[j], py[j], px[j + 1], py[j + 1])) return true;
      }
    }
    return false;
  };
  assert.ok(!loops(c.px, c.py));
  const from = W.lanes[c.from];
  const to = W.lanes[c.to];
  const last = from.px.length - 1;
  const [x0, y0, x3, y3] = [from.px[last], from.py[last], to.px[0], to.py[0]];
  const chord = Math.hypot(x3 - x0, y3 - y0);
  const lv = Math.hypot(to.px[1] - x3, to.py[1] - y3);
  const [vx, vy] = [(to.px[1] - x3) / lv, (to.py[1] - y3) / lv];
  const refused = real.tune.world.connSmoothShares.filter(([a, b]) => {
    const p = real.world.geom.bezierPoly([x0, y0], [x0 + a * chord, y0], [x3 - vx * b * chord, y3 - vy * b * chord], [x3, y3], 1.5);
    return loops(p.px, p.py) && sharpest(W, { ...c, px: Float32Array.from(p.px), py: Float32Array.from(p.py) }) < sharpest(W, c);
  });
  assert.ok(refused.length > 0, 'no looping shape here is gentler than the one kept, so this map tests nothing');
});

test('no connector crosses itself', () => {
  for (const W of worlds) {
    for (const c of W.conns) {
      const n = c.px.length;
      for (let i = 0; i + 2 < n; i++) {
        for (let j = i + 2; j + 1 < n; j++) {
          assert.ok(!math.segSegHit(c.px[i], c.py[i], c.px[i + 1], c.py[i + 1], c.px[j], c.py[j], c.px[j + 1], c.py[j + 1]), `connector ${c.id}`);
        }
      }
    }
  }
});

test('a U-turn sorts past every left, so the leftmost lane takes it', () => {
  const W = real.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesF: 2 }, { a: 1, b: 2 }],
    moves: [[0, 2, 0], [0, 1, 3]]
  }));
  const d = W.dirEdges[0];
  assert.deepStrictEqual(Array.from(d.moves), [2, 1]);
  assert.strictEqual(W.conns[W.lanes[d.lanes[1]].conns[0]].turn, 'U');
  assert.strictEqual(W.conns[W.lanes[d.lanes[0]].conns[0]].turn, 'S');
  for (const a of R.dirEdges) {
    if (!a || a.moves.length < 2) continue;
    const us = approachConns(R, a).filter((c) => c.turn === 'U').map((c) => R.lanes[c.to].dirEdge);
    for (const u of us) assert.strictEqual(a.moves[a.moves.length - 1], u, `approach ${a.id}`);
  }
});

test('conflict sets hold ids in ascending order', () => {
  for (const W of worlds) {
    for (const c of W.conns) {
      for (let i = 1; i < c.conflicts.length; i++) assert.ok(c.conflicts[i - 1] < c.conflicts[i], `connector ${c.id}`);
    }
  }
});

test('a chord under 0.5 m is a 2-point polyline with no conflicts', () => {
  const W = real.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 0 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1 }, { a: 1, b: 2 }],
    moves: [[0, 2, 0], [3, 1, 0]]
  }));
  assert.strictEqual(W.conns.length, 2);
  for (const c of W.conns) {
    assert.strictEqual(c.px.length, 2);
    assert.strictEqual(c.len, Math.max(0, 0.1));
    assert.strictEqual(c.conflicts.length, 0);
    assert.ok(Math.abs(c.vmax - 30 / 3.6) < 1e-6);
  }
  assert.ok(R.conns.some((c) => c.px.length === 2));
});

test('a chord under 0.5 m is a 2-point polyline only where its lanes line up', () => {
  let bent = 0;
  for (const W of worlds) {
    for (const c of W.conns) {
      if (chordOf(W, c) >= 0.5) continue;
      if (laneBend(W, c) < 20) {
        assert.strictEqual(c.px.length, 2, `connector ${c.id}`);
        assert.strictEqual(c.conflicts.length, 0);
        assert.strictEqual(c.vmax, Math.min(W.lanes[c.from].vmax, W.lanes[c.to].vmax));
        continue;
      }
      bent++;
      assert.ok(c.px.length > 2, `connector ${c.id} turns ${laneBend(W, c)} deg in ${chordOf(W, c)} m`);
      assert.ok(c.vmax < 3, `connector ${c.id} keeps ${c.vmax} m/s`);
    }
  }
  assert.ok(bent <= 1, `${bent} bent short connectors: only lanes too short to pull back may stay, which is why the rule has a lobe`);
  // Any left is a real connector to the gate too. Only conflicts prove it, since nothing else on it says so. The re-imported
  // tlv_center has none, and the lobe itself is tested on the crafted V below.
  for (const left of R.conns.filter((c) => chordOf(R, c) < 0.5 && laneBend(R, c) >= 20)) {
    assert.ok(left.conflicts.length > 0, 'it holds conflicts, so it has a gate');
    assert.ok(!R.index.connShort[left.id]);
  }
});

/**
 * Two one-way roads that touch at the point of a V: the way out doubles back to the end of the way in, then leaves.
 * @param {number} len Metres of each road.
 * @param {number} tip Where the way in's lane stops, which the way out must reach.
 * @param {number} deg Heading of the way out.
 * @param {boolean} [side] Adds a long road east of the junction, which has no part in the V.
 */
function vee(len, tip, deg, side) {
  const r = deg * Math.PI / 180;
  const corner = [-tip, 0.2];
  const leg = len - Math.hypot(corner[0], corner[1]);
  const end = [corner[0] + Math.cos(r) * leg, corner[1] + Math.sin(r) * leg];
  return craftMap({
    juncs: [{ x: -len, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: end[0], y: end[1], kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0 }, { a: 1, b: 2, lanesB: 0, pts: [[0, 0], corner, end] }].concat(side ? [{ a: 1, b: 3, lanesB: 0 }] : []),
    moves: [[0, 2, 2]]
  });
}

test('lanes that touch at the point of a V stand back, and a real curve joins them', () => {
  const W = real.world.build(vee(100, 3, 120));
  const c = W.conns[0];
  // Each lane gives up 8 m more than the 3 m stop line.
  assert.ok(Math.abs(W.lanes[c.from].len - (100 - 3 - 11)) < 1e-3, `lane ${W.lanes[c.from].len}`);
  assert.ok(chordOf(W, c) > 5, `chord ${chordOf(W, c)}`);
  assert.ok(c.px.length > 2);
  assert.ok(sharpest(W, c) < 60, `turns ${sharpest(W, c)} deg`);
  assert.ok(c.vmax < 30 / 3.6 && c.vmax > 2, `vmax ${c.vmax}`);
  // The same lanes, a bend of 15 deg: they only meet, as a road with a slight kink does. Nothing moves.
  const slight = real.world.build(vee(100, 3, 15));
  const k = slight.conns[0];
  assert.ok(chordOf(slight, k) < 0.5, 'this map tests nothing');
  assert.strictEqual(k.px.length, 2);
  assert.ok(Math.abs(slight.lanes[k.from].len - 94) < 1e-3);
  // A bend of 25 deg is past the joint limit and short of a V: a real connector, and the lanes stay where they are.
  const bent = real.world.build(vee(100, 3, 25));
  const b = bent.conns[0];
  assert.ok(chordOf(bent, b) < 0.5, 'this map tests nothing');
  assert.ok(b.px.length > 2, 'more than a joint');
  assert.ok(Math.abs(bent.lanes[b.from].len - 94) < 1e-3, 'not a V, so nothing stands back');
});

test('at a V whose lanes have no room to give, a lobe joins them, slow but alive', () => {
  // Edges of 6.5 m leave lanes at the 3 m minimum, stopping 1.745 m from the junction.
  const W = real.world.build(vee(6.5, 1.745, 120));
  const c = W.conns[0];
  assert.ok(W.lanes[c.from].len < 3.1 && W.lanes[c.to].len < 3.1, `lanes ${W.lanes[c.from].len}, ${W.lanes[c.to].len}`);
  assert.ok(chordOf(W, c) < 0.5, `chord ${chordOf(W, c)}: this map tests nothing`);
  assert.ok(laneBend(W, c) > 100, `bend ${laneBend(W, c)}: this map tests nothing`);
  assert.ok(c.px.length > 2);
  assert.ok(c.vmax >= 1 && c.vmax < 3, `vmax ${c.vmax}`);
  assert.ok(c.len > 2, `a lobe, not a pivot on the spot: ${c.len} m`);
  assert.ok(sharpest(W, c) < 120, `turns ${sharpest(W, c)} deg`);
  for (let i = 0; i < c.px.length; i++) assert.ok(Number.isFinite(c.px[i] + c.py[i] + c.cum[i]));
  // Lanes that cannot move are no reason to move the junction's others.
  const side = real.world.build(vee(6.5, 1.745, 120, true));
  const other = side.lanes[side.dirEdges[4].lanes[0]];
  assert.ok(Math.abs(other.len - 94) < 1e-3, `lane ${other.len}`);
});

test('a car on a 2-point connector keeps the heading of its lanes, whichever way the chord points', () => {
  const at = real.world.lanes.connPointAt;
  const across = (h, a) => Math.abs(math.wrapPi(h - a)) * 180 / Math.PI;
  const heading = (W, l, s0, s1) => {
    const a = real.world.lanes.pointAt(W, l, s0, {});
    const b = real.world.lanes.pointAt(W, l, s1, {});
    return Math.atan2(b.y - a.y, b.x - a.x);
  };
  let backward = 0;
  for (const c of R.conns) {
    if (c.px.length !== 2) continue;
    const f = R.lanes[c.from];
    const t = R.lanes[c.to];
    const hIn = heading(R, f.id, Math.max(0, f.len - 2), f.len);
    const hOut = heading(R, t.id, 0, Math.min(t.len, 2));
    if (across(Math.atan2(c.py[1] - c.py[0], c.px[1] - c.px[0]), hIn) > 90) backward++;
    assert.ok(across(at(R, c.id, 0, {}).h, hIn) < 1e-3, `connector ${c.id} starts on its way in`);
    assert.ok(across(at(R, c.id, c.len, {}).h, hOut) < 1e-3, `connector ${c.id} ends on its way out`);
    const mid = at(R, c.id, c.len / 2, {});
    assert.ok(across(mid.h, hIn) <= laneBend(R, c) / 2 + 1e-3, `connector ${c.id} turns partway at its middle`);
    // Only the heading: the point stays on the chord.
    const q = math.polyAt(c.px, c.py, c.cum, c.len / 2, {});
    assert.ok(mid.x === q.x && mid.y === q.y);
  }
  assert.ok(backward > 50, `only ${backward} chords run backward: this tests nothing`);
  // A real connector keeps the heading of its own shape.
  const shaped = R.conns.find((c) => c.px.length > 4);
  assert.strictEqual(at(R, shaped.id, 1, {}).h, math.polyAt(shaped.px, shaped.py, shaped.cum, 1, {}).h);
});

test('a short end span cannot hide a bend, on either lane', () => {
  // The way in comes down at 45 deg and only straightens for its last half metre, so its last span agrees with the way out.
  const W = real.world.build(craftMap({
    juncs: [{ x: -100, y: 100, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: 100, y: 0.2, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0, pts: [[-100, 96.5], [-3.5, 0], [0, 0]] }, { a: 1, b: 2, lanesB: 0, pts: [[-6, 0.2], [100, 0.2]] }],
    moves: [[0, 2, 0]]
  }));
  const c = W.conns[0];
  const from = W.lanes[c.from];
  const n = from.px.length - 1;
  assert.ok(Math.hypot(from.px[n] - from.px[n - 1], from.py[n] - from.py[n - 1]) < 1, 'this map tests nothing');
  assert.ok(chordOf(W, c) < 0.5, `chord ${chordOf(W, c)}: this map tests nothing`);
  assert.ok(laneBend(W, c) >= 20, `bend ${laneBend(W, c)}: this map tests nothing`);
  assert.ok(c.px.length > 2, 'a real connector');
});

test('a connector keeps clear of a wall when a small change of shape can', () => {
  const corner = (blds) => craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: 0, y: -100, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0 }, { a: 1, b: 2, lanesB: 0 }],
    moves: [[0, 2, 1]],
    blds
  });
  const blocked = (W, conn) => {
    for (let i = 0; i + 1 < conn.px.length; i++) if (real.world.spatial.rayBlocked(W, conn.px[i], conn.py[i], conn.px[i + 1], conn.py[i + 1])) return true;
    return false;
  };
  const free = real.world.build(corner([]));
  const c = free.conns[0];
  const k = c.px.length >> 1;
  // A pillar on the plain curve's middle, on the inside of the bend.
  const x = c.px[k];
  const y = c.py[k];
  const pillar = [[x - 3, y - 3], [x + 0.2, y - 3], [x + 0.2, y + 0.2], [x - 3, y + 0.2]];
  const W = real.world.build(corner([{ ring: pillar }]));
  assert.ok(!blocked(W, W.conns[0]), 'shape changed to clear the wall');
  assert.ok(W.conns[0].len >= c.len - 0.5, 'by going round the corner, not cutting it');
});

test('tlv_center: no connector runs through a wall, and the world agrees', () => {
  for (const W of worlds) {
    const list = W.conns.filter((c) => {
      for (let i = 0; i + 1 < c.px.length; i++) if (real.world.spatial.rayBlocked(W, c.px[i], c.py[i], c.px[i + 1], c.py[i + 1])) return true;
      return false;
    });
    assert.strictEqual(list.length, 0, `${list.length} connectors: ${list.map((c) => c.id)}`);
    assert.strictEqual(W.index.connWalled.length, W.conns.length);
    assert.deepStrictEqual(W.conns.filter((c) => W.index.connWalled[c.id]).map((c) => c.id), list.map((c) => c.id));
  }
});

test('a connector that smoothing takes clear of a wall stops counting as walled', () => {
  // Shaping finds nothing that clears this wall, and smoothing's longer controls swing round its end. tlv_center has no such case.
  const map = craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: -42, y: -74.6, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0 }, { a: 1, b: 2, lanesB: 0, pts: [[8, 12], [-42, -74.6]] }],
    moves: [[0, 2, 2]],
    blds: [{ ring: [[8, 2.44], [8.21, 2.65], [-0.23, 11.18], [-0.44, 10.97]] }]
  });
  const unsmoothed = miniTLV();
  unsmoothed.tune.world.connSharpDeg = 180;
  assert.strictEqual(unsmoothed.world.build(map).index.connWalled[0], 1, 'this map tests nothing');
  const W = real.world.build(map);
  const c = W.conns[0];
  assert.strictEqual(W.index.connWalled[0], 0);
  for (let i = 0; i + 1 < c.px.length; i++) assert.ok(!real.world.spatial.rayBlocked(W, c.px[i], c.py[i], c.px[i + 1], c.py[i + 1]));
});

test('junction polygons are counter-clockwise and hold every lane end', () => {
  for (const W of worlds) {
    for (const j of W.juncs) {
      assert.ok(j.poly instanceof Float32Array);
      const n = j.poly.length >> 1;
      if (j.kind === 'PASS' || n < 3) continue;
      let area = 0;
      for (let i = 0, k = n - 1; i < n; k = i++) area += j.poly[2 * k] * j.poly[2 * i + 1] - j.poly[2 * i] * j.poly[2 * k + 1];
      assert.ok(area > 0, `junction ${j.id} winds clockwise`);
    }
  }
  // Mini's centre: kerbs at 5.4, stop lines at 6.9, so the polygon is the eight corners (+-6.9, +-5.4) and (+-5.4, +-6.9).
  const centre = M.juncs.find((j) => j.x === 0 && j.y === 0);
  assert.strictEqual(centre.poly.length, 16);
  for (let i = 0; i < 8; i++) {
    const x = Math.abs(centre.poly[2 * i]);
    const y = Math.abs(centre.poly[2 * i + 1]);
    assert.ok(Math.max(x, y) < 6.91 && Math.min(x, y) > 5.39, `corner ${x}, ${y}`);
  }
});

test('dirEdges: ids, moves, headings, and null where there are no lanes', () => {
  for (const W of worlds) {
    assert.strictEqual(W.dirEdges.length, W.edges.length * 2);
    W.dirEdges.forEach((d, i) => {
      const e = W.edges[i >> 1];
      const n = i & 1 ? e.lanesB : e.lanesF;
      if (!n) {
        assert.strictEqual(d, null);
        return;
      }
      assert.strictEqual(d.id, i);
      assert.strictEqual(d.edge, i >> 1);
      assert.strictEqual(d.dir, i & 1);
      assert.strictEqual(d.lanes.length, n);
      assert.strictEqual(d.from, i & 1 ? e.b : e.a);
      assert.strictEqual(d.to, i & 1 ? e.a : e.b);
      for (const to of d.moves) assert.strictEqual(W.dirEdges[to].from, d.to);
    });
  }
  const j = R.juncs[R.dirEdges.find(Boolean).to];
  for (const d of j.inDir) assert.strictEqual(R.dirEdges[d].to, j.id);
  for (const d of j.outDir) assert.strictEqual(R.dirEdges[d].from, j.id);
});

test('junctions.ahead and connFor', () => {
  const junctions = real.world.junctions;
  for (const c of R.conns.slice(0, 2000)) {
    assert.strictEqual(junctions.ahead(R, c.from), c.junc);
    assert.strictEqual(junctions.connFor(R, c.from, R.lanes[c.to].dirEdge), c.id);
  }
  assert.strictEqual(junctions.connFor(R, R.conns[0].from, 999999), -1);
});

test('priority gives 10 to ring traffic', () => {
  const ring = R.conns.filter((c) => R.edges[R.lanes[c.from].edge].flags & real.const.EF.ROUNDABOUT);
  assert.ok(ring.length > 5);
  for (const c of ring) {
    const lane = R.lanes[c.from];
    assert.strictEqual(c.priority, 10 + (6 - lane.cls) + { S: 2, R: 1, L: 0, U: 0 }[c.turn]);
  }
  const ne = M.juncs.find((j) => j.kind === 'RING');
  for (const c of ne.conns) assert.ok(M.conns[c].priority >= 10, 'a ring junction with no ring edge is all ring');
});
