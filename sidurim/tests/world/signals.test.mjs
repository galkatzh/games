// tests/world/signals.test.mjs — WP-WORLD: controllers and the signal runtime (ARCHITECTURE 8.3, section 19 items 4, 5, 10).
import assert from 'node:assert';
import { test } from 'node:test';
import { miniTLV, realTLV, sampler, simOn, craftMap } from './helpers.mjs';

const real = realTLV();
const R = real.world.get('tlv_center');
const S = simOn(real, R);
const SIG = real.const.SIG;
const signals = real.world.signals;

/** The formula of ARCHITECTURE 8.3, written out again here on purpose. */
function formula(ctrl, slot, clock) {
  const phase = ((clock + ctrl.offset) % ctrl.cycleS + ctrl.cycleS) % ctrl.cycleS;
  const n = ctrl.slots.length;
  if (phase >= n * ctrl.slotS) return SIG.RED;
  const active = Math.floor(phase / ctrl.slotS);
  const r = phase % ctrl.slotS;
  if (active !== slot) return SIG.RED;
  if (r < ctrl.greenS) return SIG.GREEN;
  return r < ctrl.greenS + ctrl.amberS ? SIG.AMBER : SIG.RED;
}

/** A junction with one approach at each bearing, each leaving on a shared exit. */
function fan(degs) {
  const juncs = [{ x: 0, y: 0, kind: 2 }, { x: 0, y: 300, kind: 1 }];
  const edges = [{ a: 0, b: 1, lanesB: 0 }];
  const moves = [];
  degs.forEach((deg, i) => {
    const r = deg * Math.PI / 180;
    juncs.push({ x: -Math.cos(r) * 200, y: -Math.sin(r) * 200, kind: 1 });
    edges.push({ a: juncs.length - 1, b: 0, lanesB: 0 });
    moves.push([(i + 1) * 2, 0, 0]);
  });
  return craftMap({ juncs, edges, moves });
}

test('section 19.10: every n of the table, over a whole cycle', () => {
  const table = {
    1: [22, 3, 2, 27, 12, 39, 17],
    2: [22, 3, 2, 27, 0, 54, 32],
    3: [14, 3, 2, 19, 0, 57, 43],
    4: [14, 3, 2, 19, 0, 76, 62]
  };
  const bearings = { 1: [0], 2: [0, 90], 3: [0, 60, 120], 4: [0, 45, 90, 135] };
  for (const n of [1, 2, 3, 4]) {
    const TLV = miniTLV();
    const W = TLV.world.build(fan(bearings[n]));
    assert.strictEqual(W.ctrls.length, 1);
    const ctrl = W.ctrls[0];
    assert.strictEqual(ctrl.slots.length, n, `n ${n}`);
    const [green, amber, allRed, slotS, pedS, cycle, wait] = table[n];
    assert.deepStrictEqual([ctrl.greenS, ctrl.amberS, ctrl.allRedS, ctrl.slotS, ctrl.pedS, ctrl.cycleS], [green, amber, allRed, slotS, pedS, cycle]);
    assert.strictEqual(ctrl.offset, TLV.rng.hash32(ctrl.junc, 77) % cycle);
    const sim = simOn(TLV, W);
    for (const conn of W.conns) {
      if (conn.slot < 0) continue;
      const counts = { [SIG.GREEN]: 0, [SIG.AMBER]: 0, [SIG.RED]: 0 };
      const step = 0.05;
      for (let t = 0; t < cycle; t += step) counts[TLV.world.signals.stateAt(sim, conn.id, t)]++;
      assert.ok(Math.abs(counts[SIG.GREEN] * step - green) < 0.2, `n ${n} green ${counts[SIG.GREEN] * step}`);
      assert.ok(Math.abs(counts[SIG.AMBER] * step - amber) < 0.2, `n ${n} amber`);
      assert.ok(Math.abs(counts[SIG.RED] * step - (cycle - green - amber)) < 0.2, `n ${n} red`);
    }
    // The column named Longest wait is everything that is not green.
    assert.strictEqual(cycle - green, wait);
  }
});

test('section 19.10: longest wait is the table value for every n', () => {
  const waits = { 1: 17, 2: 32, 3: 43, 4: 62 };
  const bearings = { 1: [0], 2: [0, 90], 3: [0, 60, 120], 4: [0, 45, 90, 135] };
  for (const n of [1, 2, 3, 4]) {
    const TLV = miniTLV();
    const W = TLV.world.build(fan(bearings[n]));
    const sim = simOn(TLV, W);
    const conn = W.conns.find((c) => c.slot === 0);
    const ctrl = W.ctrls[0];
    let run = 0;
    let longest = 0;
    const step = 0.05;
    for (let t = 0; t < 2 * ctrl.cycleS; t += step) {
      run = TLV.world.signals.stateAt(sim, conn.id, t) === SIG.GREEN ? 0 : run + step;
      longest = Math.max(longest, run);
    }
    assert.ok(Math.abs(longest - waits[n]) < 0.2, `n ${n}: ${longest}`);
  }
});

test('section 19.10: a one-slot controller shows RED 3 s before green', () => {
  const TLV = miniTLV();
  const W = TLV.world.build(fan([0]));
  const sim = simOn(TLV, W);
  const conn = W.conns.find((c) => c.slot === 0);
  const ctrl = W.ctrls[0];
  TLV.world.signals.alignGreen(sim, conn.id, 10);
  assert.strictEqual(TLV.world.signals.stateAt(sim, conn.id, sim.t + 7), SIG.RED);
  assert.strictEqual(TLV.world.signals.stateAt(sim, conn.id, sim.t + 9.99), SIG.RED);
  assert.strictEqual(TLV.world.signals.stateAt(sim, conn.id, sim.t + 10), SIG.GREEN);
  assert.strictEqual(ctrl.pedS, 12);
  const real1 = R.ctrls.filter((c) => c.slots.length === 1);
  assert.ok(real1.length > 50);
  for (const c of real1) assert.strictEqual(c.cycleS, 39);
});

test('section 19.5: state agrees with the pure formula over 10,000 random (conn, t) pairs', () => {
  const rnd = sampler(77);
  const conns = R.conns.filter((c) => c.slot >= 0);
  assert.ok(conns.length > 2000);
  const counts = [0, 0, 0];
  for (let i = 0; i < 10000; i++) {
    const c = conns[Math.floor(rnd() * conns.length)];
    const ctrl = R.ctrls[R.juncs[c.junc].ctrl];
    const t = rnd() * 5000;
    const want = formula(ctrl, c.slot, t + S.sig.epoch);
    assert.strictEqual(signals.stateAt(S, c.id, t), want);
    counts[want]++;
  }
  assert.ok(counts[SIG.GREEN] > 1000 && counts[SIG.AMBER] > 100 && counts[SIG.RED] > 1000, String(counts));
});

test('section 19.5: connState and the tick cache agree with stateAt, and the clock is S.t + epoch', () => {
  const TLV = realTLV();
  const W = TLV.world.get('tlv_center');
  const sim = simOn(TLV, W, 5);
  const rnd = sampler(4);
  const conns = W.conns.filter((c) => c.slot >= 0);
  for (let i = 0; i < 300; i++) {
    sim.t += rnd() * 13;
    TLV.world.signals.update(sim);
    assert.strictEqual(sim.sig.clock, sim.t + sim.sig.epoch);
    const c = conns[Math.floor(rnd() * conns.length)];
    const state = TLV.world.signals.connState(sim, c.id);
    assert.strictEqual(state, TLV.world.signals.stateAt(sim, c.id, sim.t));
    const id = W.juncs[c.junc].ctrl;
    const cached = sim.sig.slot[id] === c.slot ? sim.sig.state[id] : SIG.RED;
    assert.strictEqual(cached, state);
  }
});

test('section 19.5: alignGreen', () => {
  const TLV = realTLV();
  const W = TLV.world.get('tlv_center');
  const sim = simOn(TLV, W, 3);
  const rnd = sampler(8);
  const conns = W.conns.filter((c) => c.slot >= 0);
  const sig = TLV.world.signals;
  for (let i = 0; i < 200; i++) {
    sim.t = rnd() * 1000;
    const c = conns[Math.floor(rnd() * conns.length)];
    const wait = 0.5 + rnd() * 8;
    assert.strictEqual(sig.alignGreen(sim, c.id, wait), true);
    assert.notStrictEqual(sig.stateAt(sim, c.id, sim.t + wait - 0.01), SIG.GREEN);
    assert.strictEqual(sig.stateAt(sim, c.id, sim.t + wait), SIG.GREEN);
    assert.ok(Math.abs(sig.timeToGreen(sim, c.id) - wait) < 1e-6);
    // The cache moved with the epoch, so a reader needs no tick to see it.
    assert.strictEqual(sim.sig.clock, sim.t + sim.sig.epoch);
  }
  const plain = W.conns.find((c) => c.slot < 0);
  assert.strictEqual(sig.alignGreen(sim, plain.id, 3), false);
  assert.strictEqual(sig.alignGreen(sim, -1, 3), false);
});

test('prewarm: lights follow the epoch with the tick held still', () => {
  const TLV = realTLV();
  const W = TLV.world.get('tlv_center');
  const sim = simOn(TLV, W, 3);
  const sig = TLV.world.signals;
  const conn = W.conns.find((c) => c.slot >= 0);
  const seen = new Set();
  for (let i = 0; i < 6000; i++) {
    sim.sig.epoch += TLV.const.DT;
    seen.add(sig.connState(sim, conn.id));
  }
  assert.strictEqual(seen.size, 3);
});

test('timeToGreen and timeToRed agree with stepping the clock', () => {
  const rnd = sampler(21);
  const conns = R.conns.filter((c) => c.slot >= 0);
  const TLV = realTLV();
  const W = TLV.world.get('tlv_center');
  const sim = simOn(TLV, W, 2);
  const sig = TLV.world.signals;
  for (let i = 0; i < 300; i++) {
    const c = conns[Math.floor(rnd() * conns.length)];
    sim.t = rnd() * 2000;
    const toGreen = sig.timeToGreen(sim, c.id);
    const toRed = sig.timeToRed(sim, c.id);
    const state = sig.stateAt(sim, c.id, sim.t);
    if (state === SIG.GREEN) assert.strictEqual(toGreen, 0);
    else {
      assert.ok(toGreen > 0);
      assert.notStrictEqual(sig.stateAt(sim, c.id, sim.t + toGreen - 1e-6), SIG.GREEN);
      assert.strictEqual(sig.stateAt(sim, c.id, sim.t + toGreen + 1e-6), SIG.GREEN);
    }
    if (state === SIG.RED) assert.strictEqual(toRed, 0);
    else {
      assert.notStrictEqual(sig.stateAt(sim, c.id, sim.t + toRed - 1e-6), SIG.RED);
      assert.strictEqual(sig.stateAt(sim, c.id, sim.t + toRed + 1e-6), SIG.RED);
    }
  }
  const plain = W.conns.find((c) => c.slot < 0);
  assert.strictEqual(sig.timeToGreen(sim, plain.id), 0);
  assert.strictEqual(sig.timeToRed(sim, plain.id), Infinity);
  assert.strictEqual(sig.connState(sim, plain.id), SIG.GREEN);
  assert.strictEqual(sig.laneState(sim, plain.from), SIG.GREEN);
  assert.strictEqual(sig.connState(sim, -1), SIG.GREEN);
  assert.strictEqual(sig.laneState(sim, -1), SIG.GREEN);
  assert.strictEqual(sig.timeToGreen(sim, -1), 0);
  assert.strictEqual(sig.pedWalk(sim, -1), false);
});

test('timeToGreen and timeToRed under force agree with stepping the clock', () => {
  const rnd = sampler(22);
  const conns = R.conns.filter((c) => c.slot >= 0);
  const TLV = realTLV();
  const W = TLV.world.get('tlv_center');
  const sim = simOn(TLV, W, 2);
  const sig = TLV.world.signals;
  const hold = () => 1 + rnd() * 30;
  let greenAtEnd = 0;
  let redAtEnd = 0;
  let waited = 0;
  for (let i = 0; i < 500; i++) {
    const c = conns[Math.floor(rnd() * conns.length)];
    sim.t = rnd() * 2000;
    sim.sig.forced = null;
    sig.force(sim, c.junc, i % 3 === 0 ? SIG.AMBER : 'R', hold());
    const until = sim.sig.forced[W.juncs[c.junc].ctrl].until;
    const toGreen = sig.timeToGreen(sim, c.id);
    assert.ok(toGreen >= until - sim.t - 1e-9, `green before the override ends: ${toGreen}`);
    assert.notStrictEqual(sig.stateAt(sim, c.id, sim.t + toGreen - 1e-6), SIG.GREEN);
    assert.strictEqual(sig.stateAt(sim, c.id, sim.t + toGreen + 1e-6), SIG.GREEN);
    if (Math.abs(toGreen - (until - sim.t)) < 1e-9) greenAtEnd++;
    else waited++;
    sim.sig.forced = null;
    sig.force(sim, c.junc, 'G', hold());
    const end = sim.sig.forced[W.juncs[c.junc].ctrl].until;
    const toRed = sig.timeToRed(sim, c.id);
    assert.ok(toRed >= end - sim.t - 1e-9, `red before the override ends: ${toRed}`);
    assert.notStrictEqual(sig.stateAt(sim, c.id, sim.t + toRed - 1e-6), SIG.RED);
    assert.strictEqual(sig.stateAt(sim, c.id, sim.t + toRed + 1e-6), SIG.RED);
    if (Math.abs(toRed - (end - sim.t)) < 1e-9) redAtEnd++;
  }
  assert.ok(greenAtEnd > 30 && redAtEnd > 30 && waited > 30, `this tests nothing: ${greenAtEnd}, ${redAtEnd}, ${waited}`);
  sim.sig.forced = null;
});

test('section 19.4: every approach of every controller is served, exactly once and in range', () => {
  for (const c of R.ctrls) {
    const seen = new Map();
    c.slots.forEach((list, s) => {
      for (const d of list) {
        assert.ok(!seen.has(d), `approach ${d} in two slots`);
        seen.set(d, s);
      }
    });
    const j = R.juncs[c.junc];
    assert.strictEqual(j.ctrl, c.id);
    assert.strictEqual(j.kind, 'SIGNAL');
    assert.strictEqual(seen.size, j.inDir.length, `controller ${c.id}`);
    assert.ok(c.slots.length >= 1 && c.slots.length <= 4);
    for (const conn of j.conns) {
      const k = R.conns[conn];
      assert.strictEqual(k.slot, seen.get(R.lanes[k.from].dirEdge));
      assert.ok(k.slot >= 0 && k.slot < c.slots.length, 'an out-of-range slot is a permanent red');
    }
  }
  assert.ok(R.ctrls.length >= 400 && R.ctrls.length <= 520);
  for (const j of R.juncs) if (j.kind !== 'SIGNAL') assert.strictEqual(j.ctrl, -1);
});

test('slots group opposing approaches, and five bearings cap at four slots', () => {
  const TLV = miniTLV();
  const W = TLV.world.build(fan([0, 180, 90, 270]));
  assert.strictEqual(W.ctrls[0].slots.length, 2);
  const groups = W.ctrls[0].slots.map((s) => Array.from(s));
  assert.ok(groups.every((g) => g.length === 2));
  const capped = TLV.world.build(fan([0, 41, 82, 123, 164]));
  assert.strictEqual(capped.ctrls[0].slots.length, 4);
  assert.strictEqual(capped.ctrls[0].slots.reduce((n, s) => n + s.length, 0), 5);
});

/** Roads through one junction, each straight on at its bearing, so all of them meet at its centre. turns can vary by road. */
function throughRoads(degs, turns = [], lanesF = 1) {
  const juncs = [{ x: 0, y: 0, kind: 2 }];
  const edges = [];
  const moves = [];
  degs.forEach((deg, i) => {
    const r = deg * Math.PI / 180;
    juncs.push({ x: -Math.cos(r) * 200, y: -Math.sin(r) * 200, kind: 1 });
    edges.push({ a: juncs.length - 1, b: 0, lanesB: 0, lanesF });
    juncs.push({ x: Math.cos(r) * 200, y: Math.sin(r) * 200, kind: 1 });
    edges.push({ a: 0, b: juncs.length - 1, lanesB: 0, lanesF });
    moves.push([i * 4, i * 4 + 2, turns[i] || 0]);
  });
  return craftMap({ juncs, edges, moves });
}

/** The straight paths of one slot that cross, from different approaches, by plain geometry: conflicts are not trusted here. */
function crossingsInSlots(W) {
  const hit = real.math.segSegHit;
  const list = [];
  for (const ctrl of W.ctrls) {
    const straight = Array.from(W.juncs[ctrl.junc].conns).map((id) => W.conns[id]).filter((c) => c.turn === 'S');
    for (const p of straight) {
      for (const q of straight) {
        if (q.id <= p.id || p.slot !== q.slot || p.to === q.to) continue;
        if (W.lanes[p.from].dirEdge === W.lanes[q.from].dirEdge) continue;
        let met = false;
        for (let i = 0; i + 1 < p.px.length && !met; i++) {
          for (let k = 0; k + 1 < q.px.length && !met; k++) {
            met = hit(p.px[i], p.py[i], p.px[i + 1], p.py[i + 1], q.px[k], q.py[k], q.px[k + 1], q.py[k + 1]);
          }
        }
        if (met) list.push([p.id, q.id]);
      }
    }
  }
  return list;
}

test('no two approaches that share a slot cross on their straight paths, and no slot is split without cause', () => {
  assert.deepStrictEqual(crossingsInSlots(R), []);
  // 804 slots by bearing alone, plus 26 for the 25 controllers these crossings split.
  const slots = R.ctrls.reduce((n, c) => n + c.slots.length, 0);
  assert.ok(slots <= 830, `${slots} slots`);
});

test('a slot splits where its straight paths cross, and the timing follows the new count', () => {
  const TLV = miniTLV();
  // 15 and 165 deg fold to 30 deg apart, one slot by bearing, and the two roads cross at the centre.
  const W = TLV.world.build(throughRoads([15, 165]));
  const ctrl = W.ctrls[0];
  assert.deepStrictEqual(ctrl.slots.map((s) => Array.from(s)), [[4], [0]], 'the lower id moves out, into a slot after the others');
  assert.strictEqual(ctrl.cycleS, 54, 'the n = 2 row of the table');
  assert.strictEqual(ctrl.greenS, 22);
  for (const c of W.conns) assert.ok(c.slot === 0 || c.slot === 1);
  assert.notStrictEqual(W.conns[0].slot, W.conns[1].slot);
  assert.deepStrictEqual(crossingsInSlots(W), []);
  // A left turn across a straight is the ordinary permissive left, and stays in one slot, whichever road holds it.
  assert.strictEqual(TLV.world.build(throughRoads([15, 165], [2, 2])).ctrls[0].slots.length, 1);
  assert.strictEqual(TLV.world.build(throughRoads([15, 165], [0, 2])).ctrls[0].slots.length, 1);
  assert.strictEqual(TLV.world.build(throughRoads([15, 165], [2, 0])).ctrls[0].slots.length, 1);
  // So does a shared target, which is a merge.
  assert.strictEqual(TLV.world.build(fan([15, 165])).ctrls[0].slots.length, 1);
});

test('three roads that all cross take three slots, though one bearing group holds them', () => {
  const TLV = miniTLV();
  const W = TLV.world.build(throughRoads([0, 12, 24]));
  assert.strictEqual(W.ctrls[0].slots.length, 3);
  assert.deepStrictEqual(crossingsInSlots(W), []);
});

test('a split-off slot takes in another approach it does not cross, so slots stay few', () => {
  // Two X shapes side by side, 40 m apart, at one junction. All four approaches fold to one bearing.
  const juncs = [{ x: 0, y: 0, kind: 2 }];
  const edges = [];
  const moves = [];
  const road = (a, b) => {
    juncs.push({ x: a[0], y: a[1], kind: 1 });
    return { pts: [a, b], lanesB: 0 };
  };
  [-20, 20].forEach((y) => {
    [[-100, -5, 100, 5], [100, -5, -100, 5]].forEach(([x0, dy0, x1, dy1]) => {
      const inner = Math.sign(x0) * 5;
      const inEdge = road([x0, y + dy0], [inner, y + dy0]);
      edges.push({ ...inEdge, a: juncs.length - 1, b: 0 });
      const outEdge = road([x1, y + dy1], [-inner, y + dy1]);
      edges.push({ ...outEdge, a: 0, b: juncs.length - 1, pts: [[-inner, y + dy1], [x1, y + dy1]] });
      moves.push([(edges.length - 2) * 2, (edges.length - 1) * 2, 0]);
    });
  });
  const TLV = miniTLV();
  const W = TLV.world.build(craftMap({ juncs, edges, moves }));
  assert.strictEqual(W.ctrls[0].slots.length, 2);
  assert.ok(W.ctrls[0].slots.every((s) => s.length === 2));
  assert.deepStrictEqual(crossingsInSlots(W), []);
});

test('two lanes of one approach that cross are no reason to split it', () => {
  // No real signal has such a pair, so it is placed by hand: an approach cannot leave its own slot.
  const TLV = miniTLV();
  const W = TLV.world.build(throughRoads([0], [], 2));
  const [a, b] = Array.from(W.juncs[0].conns);
  assert.strictEqual(W.lanes[W.conns[a].from].dirEdge, W.lanes[W.conns[b].from].dirEdge, 'this map tests nothing');
  W.index.straightCrossings[0] = [a, b];
  W.ctrls = [];
  W.zones = [];
  W.juncs[0].ctrl = -1;
  TLV.world.signals._build(W);
  assert.strictEqual(W.ctrls[0].slots.length, 1);
});

test('splitting stops at four slots, and the pair left over stays together', () => {
  const TLV = miniTLV();
  // Bearing groups 50, 95, {140, 165} and 5. All cross at the centre, so only the cap can keep 140 and 165 together.
  const W = TLV.world.build(throughRoads([50, 95, 140, 165, 5]));
  const ctrl = W.ctrls[0];
  assert.strictEqual(ctrl.slots.length, 4);
  assert.strictEqual(ctrl.slots.reduce((n, s) => n + s.length, 0), 5);
  assert.ok(ctrl.slots.some((s) => s.length === 2));
  assert.strictEqual(crossingsInSlots(W).length, 1);
});

test('bearings are grouped across the fold: 5 and 175 deg are one slot', () => {
  const TLV = miniTLV();
  const W = TLV.world.build(fan([5, 175, 90]));
  assert.strictEqual(W.ctrls[0].slots.length, 2);
});

test('pedWalk: true only when the signal says so, and a zebra is false', () => {
  const TLV = realTLV();
  const W = TLV.world.get('tlv_center');
  const sim = simOn(TLV, W, 9);
  const sig = TLV.world.signals;
  const signalled = W.xings.filter((x) => x.signal);
  assert.ok(signalled.length > 700, `signalled ${signalled.length}`);
  for (const x of signalled) {
    const ctrl = W.ctrls[x.ctrl];
    let walk = 0;
    const step = 0.5;
    for (let t = 0; t < ctrl.cycleS; t += step) {
      sim.t = t;
      if (sig.pedWalk(sim, x.id)) walk += step;
    }
    assert.ok(walk >= 12, `crossing ${x.id}: walk ${walk} s of ${ctrl.cycleS}, slots ${ctrl.slots.length}`);
    assert.ok(walk < ctrl.cycleS, `crossing ${x.id} never stops traffic`);
  }
  const zebra = W.xings.find((x) => !x.signal);
  assert.strictEqual(sig.pedWalk(sim, zebra.id), false);
});

test('pedWalk: on a one-slot mid-block light, all the crossing lanes are RED during walk', () => {
  const TLV = miniTLV();
  const W = TLV.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 2 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1 }, { a: 1, b: 2 }],
    moves: [[0, 2, 0], [3, 1, 0]],
    xings: [{ x: -20, y: 0, edge: 0, s: 80, flags: 1 }, { x: 20, y: 0, edge: 1, s: 20, flags: 1 }]
  }));
  const sim = simOn(TLV, W, 1);
  const sig = TLV.world.signals;
  const ctrl = W.ctrls[0];
  assert.strictEqual(ctrl.slots.length, 1);
  for (const x of W.xings) {
    assert.ok(x.signal);
    assert.strictEqual(x.ctrl, 0);
  }
  let walkS = 0;
  for (let t = 0; t < ctrl.cycleS; t += 0.1) {
    sim.t = t;
    const walk = sig.pedWalk(sim, 0);
    if (walk) walkS += 0.1;
    assert.strictEqual(walk, W.conns.every((c) => sig.connState(sim, c.id) === SIG.RED));
  }
  // Two seconds of all-red and twelve of pedestrian slot.
  assert.ok(Math.abs(walkS - 14) < 0.3, `walk ${walkS}`);
});

test('pedWalk: on an arm with an approach, its own lanes decide, whatever slot feeds the far side', () => {
  // Arm A is two-way. Its approach holds one slot. The road feeding its leaving lane straight on holds the other, and a mask
  // of both would leave only the all-reds. Two orientations put A's approach in each slot.
  for (const deg of [60, 120]) {
    const TLV = miniTLV();
    const r = deg * Math.PI / 180;
    const W = TLV.world.build(craftMap({
      juncs: [{ x: 0, y: 0, kind: 2 }, { x: 100, y: 0, kind: 1 }, { x: -Math.cos(r) * 100, y: -Math.sin(r) * 100, kind: 1 }],
      edges: [{ a: 0, b: 1 }, { a: 2, b: 0, lanesB: 0 }],
      moves: [[2, 0, 0], [1, 0, 3]],
      xings: [{ x: 20, y: 0, edge: 0, s: 20, flags: 1 }]
    }));
    const sim = simOn(TLV, W);
    const sig = TLV.world.signals;
    const ctrl = W.ctrls[0];
    assert.strictEqual(ctrl.slots.length, 2);
    const arriving = W.lanes[W.dirEdges[1].lanes[0]].conns[0];
    let walk = 0;
    for (let t = 0; t < ctrl.cycleS; t += 0.25) {
      sim.t = t;
      assert.strictEqual(sig.pedWalk(sim, 0), sig.connState(sim, arriving) === SIG.RED, `deg ${deg} at ${t}`);
      if (sig.pedWalk(sim, 0)) walk += 0.25;
    }
    assert.ok(Math.abs(walk - 29) < 0.5, `walk ${walk}`);
  }
});

test('pedWalk: a road that only leaves the junction follows the straight movement that feeds it', () => {
  const TLV = miniTLV();
  const W = TLV.world.build(craftMap({
    juncs: [{ x: 0, y: 0, kind: 2 }, { x: 100, y: 0, kind: 1 }, { x: -100, y: 0, kind: 1 }, { x: 0, y: -100, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0 }, { a: 2, b: 0, lanesB: 0 }, { a: 3, b: 0, lanesB: 0 }],
    moves: [[2, 0, 0], [4, 0, 1]],
    xings: [{ x: 20, y: 0, edge: 0, s: 20, flags: 1 }]
  }));
  const sim = simOn(TLV, W);
  const sig = TLV.world.signals;
  const ctrl = W.ctrls[0];
  const straight = W.lanes[W.dirEdges[2].lanes[0]].conns[0];
  for (let t = 0; t < ctrl.cycleS; t += 0.25) {
    sim.t = t;
    assert.strictEqual(sig.pedWalk(sim, 0), sig.connState(sim, straight) === SIG.RED);
  }
});

test('a signal crossing with no light in reach is a plain zebra', () => {
  const TLV = miniTLV();
  const W = TLV.world.build(craftMap({
    juncs: [{ x: -300, y: 0, kind: 1 }, { x: 300, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1 }],
    xings: [{ x: 0, y: 0, edge: 0, s: 300, flags: 1 }]
  }));
  assert.strictEqual(W.xings[0].signal, false);
  assert.strictEqual(W.xings[0].ctrl, -1);
});

test('force overrides a junction, then lapses at update', () => {
  const TLV = realTLV();
  const W = TLV.world.get('tlv_center');
  const sim = simOn(TLV, W, 1);
  const sig = TLV.world.signals;
  const conn = W.conns.find((c) => c.slot >= 0);
  const junc = conn.junc;
  sim.t = 100;
  sig.update(sim);
  assert.strictEqual(sig.force(sim, junc, 'R', 10), true);
  assert.strictEqual(sig.connState(sim, conn.id), SIG.RED);
  assert.strictEqual(sim.sig.state[W.juncs[junc].ctrl], SIG.RED);
  assert.strictEqual(sig.force(sim, junc, 'G', 10), true);
  assert.strictEqual(sig.connState(sim, conn.id), SIG.GREEN);
  assert.ok(sig.timeToRed(sim, conn.id) >= 10);
  sim.t = 111;
  sig.update(sim);
  assert.strictEqual(sim.sig.forced, null);
  assert.strictEqual(sig.force(sim, -1, 'G', 10), false);
  const plain = W.juncs.find((j) => j.ctrl < 0);
  assert.strictEqual(sig.force(sim, plain.id, 'G', 10), false);
  TLV.debug.use(sim);
  assert.strictEqual(TLV.debug.forceSignal(junc, 'R', 5), true);
  assert.strictEqual(sig.connState(sim, conn.id), SIG.RED);
});

test('signals run in the tick order: world.signals.update sets the clock each step', () => {
  const TLV = miniTLV();
  const W = TLV.world.get('mini');
  const sim = simOn(TLV, W);
  for (let i = 0; i < 10; i++) TLV.sim.step(sim);
  assert.strictEqual(sim.sig.clock, sim.t + sim.sig.epoch);
  assert.ok(sim.sig.slot instanceof Int8Array && sim.sig.state instanceof Int8Array);
  assert.strictEqual(sim.sig.slot.length, W.ctrls.length);
});
