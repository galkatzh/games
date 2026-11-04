// tests/traffic/regression.test.mjs — WP-TRAFFIC
// What soak on the real map found, each fixed once and held here: motion of a standing body, axles, doors, the kerb, spawn rules, clocks.
import test from 'node:test';
import { createTLV, createSim } from '../../tools/lib/classic.mjs';
import { assert, realTLV, quietSim, run, runUntil, findLane, car, playerOn, parkPlayer, events } from './helpers.mjs';

const TLV = realTLV();
const W = TLV.world.get('tlv_center');
const Q = TLV.tune.traffic;
const AI = TLV.const.LF.AI_ROUTABLE;

test('a standing car stays put when it changes its mind about the road ahead', () => {
  const S = quietSim();
  const lane = W.lanes.find((l) => (l.flags & AI) && l.conns.length >= 2 && l.len > 40 && W.conns[l.conns[0]].slot >= 0 && !(l.flags & 2));
  TLV.world.signals.force(S, W.conns[lane.conns[0]].junc, 'R', 600);
  const veh = car(S, { laneId: lane.id, s: lane.len - 4, v: 0, kind: 'bus' });
  runUntil(S, () => veh.v < 0.02, 12, 'standing');
  const { x, y, h } = veh;
  veh._t.pn = 0;
  veh._t.pg = 0;
  veh._t.plan[0] = lane.conns[1];
  veh._t.pn = 1;
  run(S, 10);
  assert.deepEqual([veh.x, veh.y, veh.h], [x, y, h]);
});

test('a heading comes from the axles, so it never jumps, on a lane joint or a sharp connector', () => {
  const S = quietSim();
  const conn = W.conns.filter((c) => c.turn !== 'S' && c.turn !== 'U' && c.px.length > 4 && (W.lanes[c.from].flags & AI) && (W.lanes[c.to].flags & AI) &&
    W.lanes[c.from].len > 40 && W.lanes[c.to].len > 40 && c.slot < 0).sort((a, b) => a.vmax - b.vmax)[0];
  const veh = car(S, { laneId: conn.from, s: W.lanes[conn.from].len - 16, v: 4, kind: 'sedan' });
  veh._t.pn = 0;
  veh._t.pg = 0;
  veh._t.plan[0] = conn.id;
  veh._t.pn = 1;
  TLV.traffic.gate.extend(S, veh);
  let most = 0;
  let h = veh.h;
  let crossed = false;
  run(S, 480, () => {
    most = Math.max(most, Math.abs(TLV.math.wrapPi(veh.h - h)));
    h = veh.h;
    crossed = crossed || veh.connId === conn.id;
    return crossed && veh.mode === 'LANE' && veh.s > 8;
  });
  assert.ok(crossed);
  assert.ok(most < 0.25, `largest turn in one tick ${most} rad`);
});

test('a long body lies on the chord of a bend, inside the path a car follows, and its centre stays near the lane', () => {
  const S = quietSim();
  const conn = W.conns.find((c) => c.turn === 'R' && c.len > 12 && (W.lanes[c.from].flags & AI) && (W.lanes[c.to].flags & AI) && c.slot < 0 &&
    W.lanes[c.from].len > 40 && W.lanes[c.to].len > 40 && W.lanes[c.to].width >= 2.9);
  const bus = car(S, { laneId: conn.from, s: W.lanes[conn.from].len - 10, v: 4, kind: 'bus' });
  bus._t.pn = 0;
  bus._t.pg = 0;
  bus._t.plan[0] = conn.id;
  bus._t.pn = 1;
  TLV.traffic.gate.extend(S, bus);
  let off = 0;
  run(S, 360, () => {
    if (bus.mode === 'CONN') {
      const at = TLV.world.lanes.connPointAt(W, bus.connId, bus.s, {});
      off = Math.max(off, TLV.math.dist(at.x, at.y, bus.x, bus.y));
    }
    return bus.mode === 'LANE' && bus.s > 6 && off > 0;
  });
  assert.ok(off > 0.02, 'it does ride inside the path');
  assert.ok(off < 1.2, `by no more than ${off}`);
});

test('a car on the far side of the door keeps it shut: a passenger steps out into a gap, not in front of a passing car', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 200 && l.right < 0 && l.opposite >= 0 && !l.stops.length);
  const veh = car(S, { laneId: lane.id, s: 40, v: 6 });
  TLV.traffic.command(S, veh, { type: 'DROP_OFF', holdS: 20, door: 'traffic', passenger: true });
  runUntil(S, () => veh.beh === 'DROPPED', 12, 'the stop');
  const opp = W.lanes[lane.opposite];
  const proj = TLV.math.polyProject(opp.px, opp.py, opp.cum, veh.x, veh.y, -1, {});
  const passing = car(S, { laneId: opp.id, s: proj.s, v: 6 });
  passing._t.capV = 6;
  run(S, 12);
  assert.equal(veh.door, 0, 'the door waits');
  assert.equal(S.pedsys.spawned.length, 0);
  runUntil(S, () => veh.door !== 0, 5, 'the gap');
  assert.equal(S.pedsys.spawned.length, 1);
});

test('a car pulling aside stops short of anyone at the kerb', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 100 && l.right < 0);
  const veh = car(S, { laneId: lane.id, s: 50, v: 0 });
  run(S, 12);
  const side = veh.width / 2 + 0.5;
  const person = { x: veh.x + Math.sin(veh.h) * side, y: veh.y - Math.cos(veh.h) * side, r: 0.35, onRoad: false };
  const near = TLV.peds.pedsNear;
  TLV.peds.pedsNear = (Sim, x, y, r, out) => {
    if (TLV.math.dist(x, y, person.x, person.y) > r) return 0;
    out[0] = person;
    return 1;
  };
  try {
    TLV.traffic.deadlock.pullOver(S, veh);
    run(S, 120);
    const dx = person.x - veh.x;
    const dy = person.y - veh.y;
    const gap = Math.abs(dy * Math.cos(veh.h) - dx * Math.sin(veh.h)) - veh.width / 2 - person.r;
    assert.ok(gap >= 0, `it stands ${gap} m clear`);
  } finally {
    TLV.peds.pedsNear = near;
  }
});

test('a drop-off on a lane that hugs a wall stays in the lane', () => {
  const S = quietSim();
  let wall = null;
  for (const lane of W.lanes) {
    if (!(lane.flags & AI) || lane.right >= 0 || lane.len < 120 || (lane.flags & 2)) continue;
    const at = TLV.world.lanes.pointAt(W, lane.id, lane.len / 2, {});
    const shift = lane.width / 2 - 0.8;
    if (TLV.world.spatial.pointInBuilding(W, at.x + Math.sin(at.h) * shift, at.y - Math.cos(at.h) * shift) >= 0) {
      wall = lane;
      break;
    }
  }
  if (!wall) return;
  const veh = car(S, { laneId: wall.id, s: wall.len / 2 - 22, v: 4 });
  TLV.traffic.command(S, veh, { type: 'DROP_OFF', holdS: 2 });
  assert.equal(Math.abs(veh._t.latT), 0);
});

test('heavy vehicles only appear on lanes wide enough to pass another', () => {
  const S = quietSim({ spawner: true, density: 100, seed: 5 });
  parkPlayer(S, -62, 139);
  TLV.traffic.prewarm(S);
  let bodies = 0;
  for (const veh of S.vehicles) {
    if (!veh.active || veh.isPlayer || veh.length <= 6 || veh.mode !== 'LANE') continue;
    bodies++;
    assert.ok(W.lanes[veh.laneId].width >= Q.heavyLaneW - 0.3, `${veh.kind} on a ${W.lanes[veh.laneId].width} m lane`);
  }
  assert.ok(bodies > 0);
});

test('the spawner keeps the ring, hides from the player, and sends cars away from the centre', () => {
  const S = quietSim({ spawner: true, density: 100, seed: 8 });
  parkPlayer(S, -62, 139);
  TLV.traffic.prewarm(S);
  run(S, 2);
  const seen = [];
  S.bus.on('traffic.spawn', (e) => {
    const veh = TLV.traffic.byId(S, e.vehId);
    if (veh) seen.push({ x: veh.x, y: veh.y, h: veh.h, shown: TLV.traffic.visibleToPlayer(S, veh.x, veh.y) });
  });
  run(S, 3600);
  assert.ok(seen.length > 10, `${seen.length} spawned`);
  const p = S.player;
  const outward = seen.filter((c) => (c.x - p.fx) * Math.cos(c.h) + (c.y - p.fy) * Math.sin(c.h) >= 0).length;
  assert.ok(seen.every((c) => !c.shown), 'none in view');
  assert.ok(outward / seen.length > 0.6, `${outward} of ${seen.length} head out`);
  for (const c of seen) assert.ok(TLV.math.dist(c.x, c.y, p.fx, p.fy) <= Q.bubbleSpawnMax + 1);
});

test('the ambient clocks give the design\'s rates per car per minute, wherever the car happens to be standing', () => {
  const rng = TLV.rng.create(4);
  let sum = 0;
  for (let i = 0; i < 20000; i++) sum += TLV.traffic.pool.nextDue(rng, Q.phantomRate);
  const mean = sum / 20000;
  assert.ok(Math.abs(mean - 60 / Q.phantomRate) / (60 / Q.phantomRate) < 0.03, `mean ${mean} s`);
});

test('a new car is in its neighbours\' lists from its first tick, and they in its', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 120);
  const a = car(S, { laneId: lane.id, s: 40, v: 0 });
  run(S, 12);
  const b = car(S, { laneId: lane.id, s: 48, v: 0 });
  assert.ok(Array.from(a._t.near.slice(0, a._t.nearN)).includes(b.slot));
  assert.ok(Array.from(b._t.near.slice(0, b._t.nearN)).includes(a.slot));
});

test('a car refused its way back from the next lane keeps driving, and comes back when it can', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.left >= 0 && l.len >= 200);
  const veh = car(S, { laneId: lane.id, s: 40, v: 5 });
  run(S, 2);
  veh.lat = 2.2;
  veh._t.latT = 0;
  const beside = car(S, { laneId: lane.id, s: 41, v: 0 });
  beside._t.capV = 0;
  const from = veh.s;
  run(S, 120);
  assert.ok(veh.s > from + 3, 'it did not stop');
  assert.ok(Math.abs(veh.lat) < 2, 'and it is coming back');
});

test('a lane change refused by a body beside it turns round, instead of pressing for ever', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.left >= 0 && l.len >= 160);
  const veh = car(S, { laneId: lane.id, s: 60, v: 0 });
  veh._t.capV = 0;
  run(S, 2);
  TLV.traffic.lanechange.start(S, veh, lane.left, 2);
  const block = car(S, { laneId: lane.left, s: 60, v: 0 });
  block._t.capV = 0;
  run(S, 6);
  runUntil(S, () => veh._t.lcTo < 0, 8, 'the change ending');
  assert.equal(veh.laneId, lane.id, 'back where it started');
  assert.ok(Math.abs(veh.lat) < 0.3);
  assert.ok(events(S, 'traffic.spawn').length >= 2);
});

test('HONK: the car behind honks within 0.3 s of green, at the queue head in front of it', () => {
  const S = quietSim();
  const lane = W.lanes.find((l) => (l.flags & AI) && l.left < 0 && l.right < 0 && l.len > 90 && !(l.flags & 2) && W.conns[l.conns[0]].slot >= 0 &&
    W.ctrls[W.juncs[W.conns[l.conns[0]].junc].ctrl].slots.length === 2);
  const conn = W.conns[lane.conns[0]];
  TLV.world.signals.alignGreen(S, conn.id, 12);
  const head = car(S, { laneId: lane.id, s: lane.len - 5, v: 0, ag: 0.2 });
  const back = car(S, { laneId: lane.id, s: lane.len - 12, v: 0, ag: 0.5 });
  runUntil(S, () => TLV.world.signals.connState(S, conn.id) === TLV.const.SIG.GREEN, 13, 'green');
  const green = S.t;
  runUntil(S, () => events(S, 'traffic.honk', (e) => e.vehId === back.id).length > 0, 1, 'the honk');
  assert.ok(S.t - green >= Q.honkGreenDelay - 0.02 && S.t - green <= 0.3, `${S.t - green} s after green`);
  assert.equal(back.horn, true);
  assert.equal(events(S, 'bubble', (e) => e.id === back.id)[0].text, '!');
  assert.ok(head.active);
});

test('HONK: a car blocked over 2 s by something that is not a red light leans on the horn', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 150);
  const block = car(S, { laneId: lane.id, s: 80, v: 0 });
  block._t.capV = 0;
  const veh = car(S, { laneId: lane.id, s: 70, v: 0, ag: 0.6 });
  runUntil(S, () => events(S, 'traffic.honk', (e) => e.vehId === veh.id).length > 0, 6, 'the honk');
  assert.equal(events(S, 'traffic.honk', (e) => e.atPlayer).length, 0, 'not at the player');
});

test('the player\'s horn gives cars in a 12 m forward cone +30% acceleration for 2 s, and no one else', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 200);
  const at = TLV.world.lanes.pointAt(W, lane.id, 60, {});
  const ahead = car(S, { laneId: lane.id, s: 68, v: 2 });
  const behind = car(S, { laneId: lane.id, s: 50, v: 2 });
  run(S, 1);
  S.bus.emit('player.horn', { x: at.x, y: at.y, h: at.h });
  assert.equal(ahead._t.hornBoostT, Q.hornBoostS);
  assert.equal(behind._t.hornBoostT, 0);
  run(S, 60);
  assert.ok(ahead.accel > ahead._t.a, 'over its usual limit');
  run(S, 80);
  assert.ok(ahead._t.hornBoostT <= 0);
});

test('adaptive density: over 45% stationary cuts the target 10%, under 25% raises it, within 70-120, and ?density turns it off', () => {
  const S = quietSim({ spawner: true, density: null, seed: 3 });
  const T = S.traffic;
  assert.equal(T.override, null);
  parkPlayer(S, -62, 139);
  run(S, 20);
  T.density = 100;
  const adapt = (share) => {
    T.stats.stationaryShare = share;
    T.shareSum = share * 10;
    T.shareN = 10;
    T.adaptT = 0;
    TLV.traffic.spawner.adapt(S);
  };
  adapt(0.6);
  assert.ok(Math.abs(T.density - 90) < 1e-9);
  adapt(0.1);
  assert.ok(Math.abs(T.density - 99) < 1e-9);
  for (let i = 0; i < 30; i++) adapt(0.6);
  assert.equal(T.density, Q.densityMin);
  for (let i = 0; i < 30; i++) adapt(0.1);
  assert.equal(T.density, Q.densityMax);
  T.laneKm = 5;
  assert.equal(TLV.traffic.spawner.target(T), 55, 'the road caps it at 11 cars per lane-km');
  const fixed = quietSim({ spawner: true, density: 120, seed: 3 });
  fixed.traffic.laneKm = 5;
  assert.equal(TLV.traffic.spawner.target(fixed.traffic), 120, '?density overrides the cap too');
});

test('traffic runs on any map: the small fixture, a thin bubble, and a sim with no world at all', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const files = createTLV({ files: [] }).manifest.sim.filter((f) => f.startsWith('js/core/') || f.startsWith('js/world/') || f.startsWith('js/sim/traffic/'));
    const list = [...files, 'tests/traffic/stubs/player_stub.js', 'tests/traffic/stubs/peds_stub.js'];
    const mini = createTLV({ files: list, map: 'tests/fixtures/mini_map.js', content: false, allowMissing: true, params: { invariants: 1, density: 30 } });
    const S = createSim(mini, { seed: 3, allowMissing: true });
    for (let i = 0; i < 7200; i++) mini.sim.step(S);
    assert.deepEqual(S.invariantFailures, []);
    assert.ok(S.traffic.nAct >= 20, `${S.traffic.nAct} cars on mini`);
    assert.ok(S.traffic.stats.meanSpeed > 2);

    const none = createTLV({ files: list, map: null, content: false, allowMissing: true, params: {} });
    const E = createSim(none, { seed: 1, allowMissing: true });
    for (let i = 0; i < 60; i++) none.sim.step(E);
    assert.equal(none.traffic.spawn(E, { laneId: 0, s: 1 }), null);
    assert.equal(none.traffic.materializeParked(E, 1), null);
    assert.deepEqual(none.traffic.diagnostics(E), {});
  } finally {
    console.warn = warn;
  }
});

// ---- Found by the full matrix on tlv_center: each of these left two bodies overlapping, or a pose jumping, in soak. ------------

/** The longest step a car's centre took in one tick, over a stretch of ticks. */
function longestStep(S, veh, ticks) {
  let most = 0;
  for (let i = 0; i < ticks; i++) {
    TLV.sim.step(S);
    most = Math.max(most, TLV.math.dist(veh.x, veh.y, veh.px, veh.py));
  }
  return most;
}

test('a lane change that turned round plans again from the lane it stands on, not the one it left', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.left >= 0 && l.len >= 160);
  const veh = car(S, { laneId: lane.id, s: 60, v: 0 });
  veh._t.capV = 0;
  run(S, 2);
  TLV.traffic.lanechange.start(S, veh, lane.left, 2);
  assert.equal(W.conns[veh._t.plan[0]].from, lane.left, 'a change plans from its target');
  const block = car(S, { laneId: lane.left, s: 60, v: 0 });
  block._t.capV = 0;
  runUntil(S, () => veh._t.lcTo < 0, 8, 'the change ending');
  assert.equal(veh.laneId, lane.id);
  assert.ok(veh._t.pn > 0);
  assert.equal(W.conns[veh._t.plan[0]].from, lane.id, 'a plan from the other lane would jump the car a lane sideways at the line');
});

test('a slow lane change through a gentle bend moves smoothly, because the frame swap reads the pose off the new lane', () => {
  const S = quietSim();
  const turn = (l, i) => Math.abs(TLV.math.wrapPi(Math.atan2(l.py[i + 1] - l.py[i], l.px[i + 1] - l.px[i]) - Math.atan2(l.py[i] - l.py[i - 1], l.px[i] - l.px[i - 1])));
  const lane = W.lanes.find((l) => {
    if (l.left < 0 || !(l.flags & AI) || l.len < 120 || W.lanes[l.left].len < 120) return false;
    for (let i = 1; i + 1 < l.px.length; i++) {
      if (l.cum[i] > 50 && l.len - l.cum[i] > 40 && turn(l, i) > 0.15 && turn(l, i) < 0.4) return true;
    }
    return false;
  });
  assert.ok(lane, 'the map has a two-lane road with a gentle bend');
  let bendAt = 0;
  for (let i = 1; i + 1 < lane.px.length; i++) {
    if (turn(lane, i) > 0.15) bendAt = lane.cum[i];
  }
  const veh = car(S, { laneId: lane.id, s: bendAt - 4, v: 2 });
  veh._t.capV = 2;
  run(S, 2);
  TLV.traffic.lanechange.start(S, veh, lane.left, 2.5);
  // Slowed further after the start, so that the offsets taken at the start are stale by the midpoint.
  const most = longestStep(S, veh, 170);
  assert.equal(veh.laneId, lane.left);
  assert.ok(most < 0.12, `longest step in a tick ${most}`);
});

test('a bus coming off a narrow lane eases to its road line, with no step at the joint', () => {
  const S = quietSim();
  const conn = W.conns.find((c) => {
    const a = W.lanes[c.from];
    const b = W.lanes[c.to];
    return c.px.length > 6 && c.turn !== 'U' && c.len > 8 && (a.flags & AI) && (b.flags & AI) && !(a.flags & 2) && !(b.flags & 2) &&
      a.width < Q.heavyLaneW && a.len > 40 && b.len > 40;
  });
  assert.ok(conn);
  const lane = W.lanes[conn.from];
  const bus = car(S, { laneId: lane.id, s: lane.len - 20, v: 4, kind: 'bus' });
  bus._t.pn = 1;
  bus._t.pg = 0;
  bus._t.plan[0] = conn.id;
  TLV.world.signals.force(S, conn.junc, 'G', 60);
  const most = longestStep(S, bus, 300);
  assert.ok(bus.mode !== 'LANE' || bus.laneId !== lane.id, 'it left the lane');
  assert.ok(most < 0.6, `longest step in a tick ${most}`);
  assert.ok(bus._t.share >= 0 && bus._t.share <= Q.longChord);
});

test('a car placed between ticks stays in its neighbours\' lists when they refresh', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 120);
  const a = car(S, { laneId: lane.id, s: 40, v: 0 });
  run(S, 12);
  const b = car(S, { laneId: lane.id, s: 48, v: 0 });
  for (let i = 0; i < Q.nearTicks + 1; i++) {
    TLV.sim.step(S);
    assert.ok(Array.from(a._t.near.slice(0, a._t.nearN)).includes(b.slot), 'a refresh from a stale grid would drop it, and the net with it');
  }
});

test('vehiclesNear is safe before the first tick has built the broadphase', () => {
  const S = createSim(TLV, { seed: 5, map: 'tlv_center', allowMissing: true, params: { notitle: 1, density: 0 } });
  const out = [];
  assert.equal(TLV.traffic.vehiclesNear(S, 0, 0, 50, out), 0);
  assert.equal(out.length, 0);
});

test('no lane change or pass crosses a sharp lane vertex, where two lanes stop being parallel', () => {
  const S = quietSim();
  const lane = W.lanes.find((l) => l.left >= 0 && (l.flags & AI) && l.len > 100 && S.traffic.sharpOff[l.id + 1] > S.traffic.sharpOff[l.id] &&
    S.traffic.sharpS[S.traffic.sharpOff[l.id]] > 40 && l.len - S.traffic.sharpS[S.traffic.sharpOff[l.id]] > 30);
  assert.ok(lane, 'the map has such a road');
  const corner = S.traffic.sharpS[S.traffic.sharpOff[lane.id]];
  const lc = TLV.traffic.lanechange;
  assert.equal(lc.sharpBetween(S, lane.id, corner - 1, corner + 1), true);
  assert.equal(lc.sharpBetween(S, lane.id, corner + 1, corner + 2), false);
  const veh = car(S, { laneId: lane.id, s: corner - 12, v: 6 });
  run(S, 2);
  assert.equal(lc.tryChange(S, veh, lane.left, Q.laneGapMin, 8), false, 'the corner is inside the change');
  assert.equal(veh._t.lcTo, -1);
  assert.equal(lc.force(S, veh, lane.left, Q.noseGapMin), false);
});

test('a lane change reads its gaps on the lane it is going to, whose s is not this lane\'s round a bend', () => {
  // Seed 4, patrol, N 120. Lanes 6022 and 6023 differ by 5 m at this spot, so a car 8.6 m ahead by its own s was 3.7 m ahead on the lane it
  // joined, with a body 4.4 m long: the two then stood with a path gap of -0.32 m.
  const S = quietSim();
  const inner = W.lanes[6022];
  const outer = W.lanes[6023];
  assert.equal(inner.left, outer.id, 'the map still has this pair');
  const lc = TLV.traffic.lanechange;
  const mover = car(S, { laneId: outer.id, s: 61.96, v: 0 });
  const onLane = (s) => TLV.math.polyProject(inner.px, inner.py, inner.cum, mover.x, mover.y, s, {}).s;
  run(S, 2);
  const here = onLane(mover.s);
  assert.ok(mover.s - here > 3, `${mover.s} is ${here} over there`);
  const behind = car(S, { laneId: inner.id, s: here - 3.7, v: 0 });
  run(S, 2);
  assert.ok(mover.s - behind.s - 2 * mover._t.halfL > Q.laneGapMin, 'its own s would read a gap wide enough');
  assert.equal(lc.tryChange(S, mover, inner.id, Q.laneGapMin, 8), false);
  assert.equal(lc.force(S, mover, inner.id, Q.noseGapMin), false);
  assert.equal(lc.cutIn(S, mover, inner.id, Q.laneGapMin, 8), false);
  TLV.traffic.despawn(S, behind);
  run(S, 2);
  assert.equal(lc.tryChange(S, mover, inner.id, Q.laneGapMin, 8), true, 'with the gap clear it goes');
});

test('a lane change keeps its tail clear of a car coming in through a connector, which is on no list of that lane yet', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.left >= 0 && l.len >= 160);
  const veh = car(S, { laneId: lane.id, s: 16, v: 4, kind: 'bus' });
  run(S, 2);
  S.traffic.reserved[lane.left] = 11;
  const lc = TLV.traffic.lanechange;
  try {
    assert.equal(lc.tryChange(S, veh, lane.left, Q.laneGapMin, 8), false);
    assert.equal(lc.force(S, veh, lane.left, Q.noseGapMin), false);
  } finally {
    S.traffic.reserved[lane.left] = 0;
  }
  assert.equal(lc.tryChange(S, veh, lane.left, Q.laneGapMin, 8), true, 'with nobody coming it goes');
});

test('a body the lists cannot see brakes a car in good time, so the net need not stop it dead', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 200 && l.left < 0 && l.right < 0);
  const veh = car(S, { laneId: lane.id, s: 40, v: 10 });
  const parked = car(S, { laneId: lane.id, s: 90, v: 0 });
  run(S, 2);
  // Standing on the road but in no list, like a car on a stall with its tail out.
  parked.mode = 'PARKED';
  parked.laneId = -1;
  let hardest = 0;
  let last = veh.v;
  run(S, 480, () => {
    hardest = Math.min(hardest, veh.accel);
    if (last > 1) assert.ok(last - veh.v < 0.3, `speed fell from ${last} to ${veh.v} in one tick, which is the net, not brakes`);
    last = veh.v;
    assert.equal(TLV.math.obbOverlap(veh, parked), false);
  });
  assert.ok(veh.v < 0.3, `it stopped, ${veh.v}`);
  assert.ok(hardest >= -Q.hardBrake - 1e-9 && hardest < -1, `hardest braking ${hardest}`);
});

test('a car brakes for someone its body would sweep, off its path, on the outside of a turn', () => {
  const S = quietSim();
  const conn = W.conns.find((c) => c.turn === 'R' && c.len > 10 && (W.lanes[c.from].flags & AI) && (W.lanes[c.to].flags & AI) && W.lanes[c.from].len > 50 &&
    W.lanes[c.from].width >= Q.heavyLaneW && W.lanes[c.to].width >= Q.heavyLaneW && W.lanes[c.to].len > 40 && !(W.lanes[c.to].flags & 2));
  const lane = W.lanes[conn.from];
  const bus = car(S, { laneId: lane.id, s: lane.len - 8, v: 3, kind: 'bus' });
  bus._t.pn = 1;
  bus._t.pg = 0;
  bus._t.plan[0] = conn.id;
  TLV.world.signals.force(S, conn.junc, 'G', 60);
  run(S, 6);
  const c = Math.cos(bus.h);
  const s = Math.sin(bus.h);
  // Beside the front corner, outside every corridor round the path, in the way of the nose as the body turns.
  const side = bus.width / 2 + 0.45;
  const person = { x: bus.x + c * (bus.length / 2 + 1.2) + s * side, y: bus.y + s * (bus.length / 2 + 1.2) - c * side, r: 0.35, onRoad: false };
  const near = TLV.peds.pedsNear;
  TLV.peds.pedsNear = (Sim, x, y, r, out) => {
    if (TLV.math.dist(x, y, person.x, person.y) > r) return 0;
    out[0] = person;
    return 1;
  };
  try {
    let touched = false;
    run(S, 120, () => {
      if (TLV.math.obbOverlap(bus, { x: person.x, y: person.y, h: 0, length: 0.7, width: 0.7 })) touched = true;
    });
    assert.equal(touched, false, 'the body never reached them');
  } finally {
    TLV.peds.pedsNear = near;
  }
});

test('a lane change only goes to a lane beside the car: an overtake that turned round has nothing to come back from', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.left >= 0 && l.len >= 200);
  const veh = car(S, { laneId: lane.id, s: 60, v: 6 });
  const slow = car(S, { laneId: lane.id, s: 75, v: 3 });
  slow._t.capV = 3;
  run(S, 2);
  const lc = TLV.traffic.lanechange;
  assert.equal(lc.tryChange(S, veh, lane.id, 0.3, 8), false, 'not to its own lane, which would read as a change of zero width');
  assert.equal(lc.force(S, veh, lane.id, Q.noseGapMin), false);
  veh._t.ovMode = 2;
  veh._t.ovLane = lane.id;
  veh._t.ovLead = slow.slot;
  TLV.traffic.behaviours.set(S, veh, 'OVERTAKE_PASS');
  runUntil(S, () => veh.beh === 'CRUISE', 2, 'the pass ending');
  assert.ok(Number.isFinite(veh.x) && Number.isFinite(veh.lat));
});

test('a long body turning onto a lane that runs beside a wall keeps its centre out of the wall, and does not jump to do it', () => {
  // Seed 5, chaos, N 100: lane 757 runs 0.3 m from building 13033, and a bus coming off a tight corner rode 0.34 m inside the lane.
  const S = quietSim();
  const lane = W.lanes[757];
  const spatial = TLV.world.spatial;
  const at = TLV.world.lanes.pointAt(W, lane.id, 0.6, {});
  const side = [1, -1].find((n) => spatial.pointInBuilding(W, at.x - Math.sin(at.h) * n * 0.4, at.y + Math.cos(at.h) * n * 0.4) >= 0);
  assert.ok(side, 'a wall within 0.4 m of the lane');
  const bus = car(S, { kind: 'bus', laneId: lane.id, s: 0.6, v: 2, ag: 0.8 });
  const t = bus._t;
  bus.v = 2;
  t.capV = 2;
  t.share = Q.longChord;
  // The rear axle swung right out on the wall's side, as a tight corner leaves it, so its chord lies across the wall.
  t.rearX = at.x - Math.sin(at.h) * side * bus.wheelbase;
  t.rearY = at.y + Math.cos(at.h) * side * bus.wheelbase;
  let x = bus.x;
  let y = bus.y;
  let jump = 0;
  let inside = 0;
  let ticks = 0;
  run(S, 40, () => {
    // The first tick is the scene being set: the bus was placed on the lane and has only now taken the axles it was given.
    if (++ticks > 1) jump = Math.max(jump, Math.hypot(bus.x - x, bus.y - y));
    x = bus.x;
    y = bus.y;
    if (spatial.pointInBuilding(W, bus.x, bus.y) >= 0) inside++;
  });
  assert.equal(ticks, 40);
  assert.equal(inside, 0, 'ticks with its centre in the building');
  assert.ok(t.share < Q.longChord, 'it came back toward the lane');
  assert.ok(jump < 0.1, `most it moved in one tick ${jump} m`);
});

test('a car is not put down under the nose of a long body on the lane before, which no list of the lane shows yet', () => {
  // Seed 5, patrol, N 120: a sedan placed on lane 6420 with bus 1891 on 6418. The bodies stayed 0.75 m apart, turned as the bus was,
  // but its 6 m of nose read along 6420 the moment its centre arrived: gap -0.54, and the bus stood on its brakes.
  const S = quietSim();
  const from = W.lanes[6418];
  const conn = W.conns[from.conns[0]];
  const bus = car(S, { kind: 'bus', laneId: from.id, s: 2.49, v: 0 });
  bus._t.pn = 0;
  bus._t.pg = 0;
  bus._t.plan[0] = conn.id;
  bus._t.pn = 1;
  // Where it stood, and turned as it was: 0.5 rad off its lane.
  bus.x = -663.8;
  bus.y = -1607.4;
  bus.h = 2.42;
  const reach = bus.length / 2 - (from.len - bus.s) - conn.len;
  assert.ok(reach > 5, `its nose reaches ${reach} m onto the lane`);
  assert.equal(TLV.traffic.spawn(S, { laneId: conn.to, s: 5.39, kind: 'sedan' }), null, 'tail inside the nose, as it was');
  assert.equal(TLV.traffic.spawn(S, { laneId: conn.to, s: reach + 2.2 - 0.1, kind: 'sedan' }), null, 'tail just inside it');
  assert.ok(TLV.traffic.spawn(S, { laneId: conn.to, s: reach + 2.2 + 0.5, kind: 'sedan' }), 'tail clear of it');
});
