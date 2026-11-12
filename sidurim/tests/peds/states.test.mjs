// tests/peds/states.test.mjs — one scenario for every state of ARCHITECTURE 10.4, each driven by its real trigger.
import test from 'node:test';
import assert from 'node:assert';
import {
  loadBare, sim, quiet, record, noCrowd, setPlayer, run, until, person, atCrossing, ZEBRA, signalCrossing, forceWalk, placeCar
} from './helpers.mjs';

quiet();

function mini() {
  const TLV = loadBare();
  noCrowd(TLV);
  const S = sim(TLV);
  setPlayer(S, 300, 300);
  return { TLV, S };
}

const real = (() => {
  const TLV = loadBare('tlv_center');
  noCrowd(TLV);
  return TLV;
})();

function onReal(seed = 1) {
  const S = sim(real, { seed });
  setPlayer(S, 0, 0);
  return S;
}

test('WALK: walks a sidewalk at 1.1-1.5 m/s, keeping to it, and links on past its end', () => {
  const { TLV, S } = mini();
  const speeds = [];
  for (let i = 0; i < 40; i++) speeds.push(person(TLV, S, { kind: 'walker', x: 0, y: -100 }));
  const sw = S.world.sidewalks;
  let rows = 0;
  const seen = new Set();
  run(TLV, S, 60 * 120, () => {
    for (const p of speeds) {
      if (p.state === 'WALK' && p._p.mode === 'ROW') seen.add(p._p.sw);
    }
  });
  rows = seen.size;
  assert.ok(rows > 3, `only ${rows} rows`);
  for (const p of speeds) {
    assert.ok(p._p.base >= 1.1 && p._p.base <= 1.5);
    assert.ok(p._p.sw < sw.length);
  }
});

test('A row with no way on turns the walker round', () => {
  const TLV = loadBare();
  noCrowd(TLV);
  const S = sim(TLV);
  setPlayer(S, 300, 300);
  const W = S.world;
  const row = W.sidewalks[16];
  row.links.length = 0;
  const p = person(TLV, S, { kind: 'walker', x: 0, y: 0, swId: 16, swS: row.len - 3 });
  p._p.dir = 1;
  TLV.tune.peds.crossP = 0;
  assert.ok(until(TLV, S, 8, () => p._p.dir === -1));
  assert.ok(p._p.s <= row.len);
  assert.ok(p.state === 'WALK');
});

test('WAIT_CROSS, CROSS_LEGAL: a walker at a signal waits for the walk phase, then crosses at 1.3 m/s', () => {
  const S = onReal();
  const TLV = real;
  const xing = signalCrossing(TLV, S);
  const path = TLV.peds.cross.pathOf(S, xing.id);
  TLV.tune.peds.redP = 0;
  TLV.tune.peds.slowP = 0;
  forceWalk(TLV, S, xing, false);
  const p = atCrossing(TLV, S, xing.id);
  TLV.peds.cross.start(S, p, path, 1, 'LEGAL');
  assert.ok(until(TLV, S, 6, () => p.state === 'WAIT_CROSS'));
  run(TLV, S, 60 * 6);
  assert.strictEqual(p.state, 'WAIT_CROSS', 'no walk phase, no crossing');
  forceWalk(TLV, S, xing, true);
  assert.ok(until(TLV, S, 3, () => p.state === 'CROSS_LEGAL'));
  const arc = p._p.arc;
  run(TLV, S, 60);
  assert.ok(Math.abs(p._p.arc - arc - 1.3) < 0.08, `${p._p.arc - arc} m in a second`);
  assert.ok(until(TLV, S, 30, () => p.state === 'WALK'));
  assert.ok(until(TLV, S, 10, () => p._p.mode === 'ROW'));
  assert.strictEqual(p._p.sw, path.swB, 'landed on the far side');
  TLV.tune.peds.redP = 0.15;
  TLV.tune.peds.slowP = 0.12;
});

test('RED_CROSS: 15% of waiters cross against the signal, on a road with cars green', () => {
  const S = onReal(2);
  const TLV = real;
  const xing = signalCrossing(TLV, S);
  const path = TLV.peds.cross.pathOf(S, xing.id);
  forceWalk(TLV, S, xing, false);
  TLV.tune.peds.redP = 1;
  const p = atCrossing(TLV, S, xing.id);
  const log = record(S, ['ped.stepOut']);
  TLV.peds.cross.start(S, p, path, 1, 'LEGAL');
  assert.ok(until(TLV, S, 25, () => p.state === 'RED_CROSS'));
  assert.strictEqual(TLV.world.signals.pedWalk(S, xing.id), false, 'on the road with no walk phase');
  assert.deepStrictEqual(log.map((e) => e.state), ['RED_CROSS']);
  TLV.tune.peds.redP = 0.15;
});

test('RED_CROSS after 25 s: a waiter who has not rolled it still may, and otherwise walks on', () => {
  const S = onReal(3);
  const TLV = real;
  const xing = signalCrossing(TLV, S);
  const path = TLV.peds.cross.pathOf(S, xing.id);
  forceWalk(TLV, S, xing, false);
  TLV.tune.peds.redP = 0;
  TLV.tune.peds.redAfterWaitP = 1;
  const a = atCrossing(TLV, S, xing.id);
  TLV.peds.cross.start(S, a, path, 1, 'LEGAL');
  assert.ok(until(TLV, S, 34, () => a.state === 'RED_CROSS'));
  TLV.tune.peds.redAfterWaitP = 0;
  const b = atCrossing(TLV, S, xing.id, 'walker', 'B');
  TLV.peds.cross.start(S, b, path, -1, 'LEGAL');
  assert.ok(until(TLV, S, 34, () => b.stateT > 0.5 && b.state === 'WALK' && b._p.stage === 'NONE'));
  TLV.tune.peds.redP = 0.15;
  TLV.tune.peds.redAfterWaitP = 0.5;
});

test('CROSS_SLOW: crosses at 0.6 m/s and may pause mid-road 1-3 s, and blocks its lanes throughout', () => {
  const { TLV, S } = mini();
  TLV.tune.peds.slowP = 1;
  const p = atCrossing(TLV, S, ZEBRA, 'walker');
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  TLV.peds.cross.start(S, p, path, 1, 'LEGAL');
  assert.ok(until(TLV, S, 8, () => p.state === 'CROSS_SLOW'));
  const arc = p._p.arc;
  run(TLV, S, 60);
  assert.ok(Math.abs(p._p.arc - arc - 0.6) < 0.05, `${p._p.arc - arc} m in a second`);
  assert.ok(TLV.peds.zoneOccupied(S, S.world.xings[ZEBRA].zones[0]) || TLV.peds.zoneOccupied(S, S.world.xings[ZEBRA].zones[1]));
  assert.ok(until(TLV, S, 40, () => p.state === 'WALK'));
});

test('A slow crosser on a wide road speeds up just enough to be off it in time', () => {
  const { TLV, S } = mini();
  TLV.tune.peds.slowCrossMaxS = 6;
  const p = atCrossing(TLV, S, ZEBRA, 'trolley');
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  TLV.peds.cross.start(S, p, path, 1, 'SLOW');
  assert.ok(until(TLV, S, 8, () => p.state === 'CROSS_SLOW'));
  assert.ok(Math.abs(p._p.speed - path.total / 6) < 1e-6);
});

test('A trolley always crosses slowly', () => {
  const { TLV, S } = mini();
  TLV.tune.peds.slowP = 0;
  const p = atCrossing(TLV, S, ZEBRA, 'trolley');
  TLV.peds.cross.start(S, p, TLV.peds.cross.pathOf(S, ZEBRA), 1, 'LEGAL');
  assert.ok(until(TLV, S, 8, () => p.state === 'CROSS_SLOW'));
});

test('A rider never takes the slow crossing, by the dice or by the plan, and walks no 0.6 m/s', () => {
  for (const kind of ['scooter', 'delivery']) {
    for (const plan of ['LEGAL', 'SLOW']) {
      const { TLV, S } = mini();
      TLV.tune.peds.slowP = 1;
      const p = atCrossing(TLV, S, ZEBRA, kind);
      TLV.peds.cross.start(S, p, TLV.peds.cross.pathOf(S, ZEBRA), 1, plan);
      assert.ok(until(TLV, S, 8, () => p.state !== 'WAIT_CROSS' && p._p.stage === 'ROAD'), `${kind} ${plan} on the road`);
      assert.equal(p.state, 'CROSS_LEGAL', `${kind} ${plan}`);
      assert.ok(p._p.speed >= 6, `${kind} ${plan}: ${p._p.speed} m/s`);
    }
  }
});

test('Moved while they wait at the kerb, a slow crosser leaves from where they stand, with no jump to the line', () => {
  // Seed 2, patrol, tick 40655: a trolley moved 0.43 m in 3 ticks on stepping out, 8.58 m/s, at stateT 0.05.
  const { TLV, S } = mini();
  const p = atCrossing(TLV, S, ZEBRA, 'trolley');
  TLV.peds.cross.start(S, p, TLV.peds.cross.pathOf(S, ZEBRA), 1, 'SLOW');
  assert.ok(until(TLV, S, 8, () => p.state === 'WAIT_CROSS'));
  p.x += 0.35;
  p.y -= 0.25;
  p.px = p.x;
  p.py = p.y;
  assert.ok(until(TLV, S, 8, () => p.state === 'CROSS_SLOW'));
  let most = 0;
  run(TLV, S, 90, () => {
    most = Math.max(most, p.v);
  });
  assert.ok(most < 1, `${most} m/s`);
});

/** A walker on a row, for a car to go by. Row 16 of the fixture runs north along x. */
function onRow(TLV, S) {
  return person(TLV, S, { kind: 'walker', x: 0, y: -100, swId: 16, swS: 40 });
}

test('A car going by beside someone does not shove them: only what it will reach by the next think counts', () => {
  const { TLV, S } = mini();
  const p = onRow(TLV, S);
  run(TLV, S, 6);
  const side = p.r + 0.14;
  const size = TLV.const.VEHICLE_SIZES.sedan;
  const car = placeCar(TLV, S, { x: p.x + side + size.width / 2, y: p.y - 10, h: Math.PI / 2, v: 7, laneId: -1 });
  let most = 0;
  run(TLV, S, 150, () => {
    car.y += 7 / 60;
    car.px = car.x;
    car.py = car.y;
    car.x = p.x + side + size.width / 2;
    most = Math.max(most, p.v);
  });
  assert.ok(most < 2.9, `${most} m/s`);
});

test('A nose that reaches someone moves them at its own speed, and adds no slide on top', () => {
  const { TLV, S } = mini();
  const p = onRow(TLV, S);
  run(TLV, S, 6);
  const size = TLV.const.VEHICLE_SIZES.sedan;
  const car = placeCar(TLV, S, { x: p.x, y: p.y - size.length / 2 - 3, h: Math.PI / 2, v: 4, laneId: -1 });
  let most = 0;
  let touched = 0;
  run(TLV, S, 120, () => {
    car.y += 4 / 60;
    car.py = car.y;
    most = Math.max(most, p.v);
    if (TLV.peds.walk.bodyDist(car, p.x, p.y) < p.r - 0.05) touched++;
  });
  assert.equal(touched, 0, 'never inside the body');
  assert.ok(most < 6, `${most} m/s`);
});

test('JAYWALK: a walker near a road leaves the sidewalk mid-block, with intent first', () => {
  const { TLV, S } = mini();
  const W = S.world;
  const log = record(S, ['ped.intent', 'ped.stepOut']);
  const row = W.sidewalks[16];
  const p = person(TLV, S, { kind: 'walker', x: 0, y: 0, swId: 16, swS: 40 });
  p._p.crossCool = 0;
  assert.ok(TLV.peds.cross.tryJaywalk(S, p));
  assert.ok(until(TLV, S, 12, () => p.state === 'JAYWALK'));
  assert.deepStrictEqual(log.map((e) => e.name), ['ped.intent', 'ped.stepOut']);
  assert.ok(log[1].t - log[0].t >= 0.8 - 1e-9);
  assert.ok(until(TLV, S, 12, () => p.state === 'WALK' && p._p.mode === 'ROW'));
  assert.ok(row);
  assert.strictEqual(p._p.sw, 17, 'crossed to the far row');
});

test('JAYWALK: the ambient rate is about 3% per minute per walker near a road', () => {
  const TLV = loadBare();
  const T = TLV.tune.peds;
  T.bubbleAim = 0;
  T.outerAim = 0;
  T.ambientCap = 0;
  T.strollP = 0;
  T.crossP = 0;
  T.despawnM = 1e6;
  T.roadOutM = 1e6;
  T.roadKeepM = 1e6;
  const S = sim(TLV, { seed: 5 });
  setPlayer(S, 300, 300);
  const list = [];
  for (let i = 0; i < 90; i++) list.push(person(TLV, S, { kind: 'walker', x: 0, y: -100 }));
  const log = record(S, ['ped.stepOut']);
  run(TLV, S, 60 * 60 * 3);
  // 90 walkers for 3 minutes at 3% a minute is 8. A row's ends and failed gaps take a share of that.
  assert.ok(log.length >= 2 && log.length <= 16, `${log.length} jaywalks`);
});

test('STROLL_ROAD: a walker on a service road takes to the edge of it, then back to the sidewalk', () => {
  const TLV = loadBare('tlv_center');
  noCrowd(TLV);
  const S = sim(TLV);
  const W = S.world;
  setPlayer(S, 0, 0);
  let p = null;
  for (const sw of W.sidewalks) {
    const e = W.edges[sw.edge];
    if (e.cls < 5 || sw.len < 60 || e.lanesF + e.lanesB === 0) continue;
    const q = person(TLV, S, { kind: 'walker', x: 0, y: 0, swId: sw.id, swS: 12 });
    q._p.dir = 1;
    q.h = TLV.world.sidewalks.pointAt(W, sw.id, 12).h;
    if (TLV.peds.cross.tryStroll(S, q)) {
      p = q;
      break;
    }
    TLV.peds.despawn(S, q);
  }
  assert.ok(p, 'no quiet road found');
  const log = record(S, ['ped.stepOut']);
  assert.ok(until(TLV, S, 12, () => p.state === 'STROLL_ROAD'));
  assert.deepStrictEqual(log.map((e) => e.state), ['STROLL_ROAD']);
  run(TLV, S, 120);
  assert.strictEqual(p.onRoad, true);
  const lane = W.lanes[p._p.laneId];
  const out = [];
  assert.ok(TLV.peds.obstaclesOnLane(S, lane.id, out) >= 1);
  assert.ok(until(TLV, S, 60, () => p.state === 'WALK'));
  assert.ok(until(TLV, S, 12, () => p._p.mode === 'ROW'));
});

test('STROLL_ROAD: a car on the lane makes the stroller move aside, slowly, and leave', () => {
  const TLV = loadBare('tlv_center');
  noCrowd(TLV);
  const S = sim(TLV);
  const W = S.world;
  setPlayer(S, 0, 0);
  let p = null;
  for (const sw of W.sidewalks) {
    const e = W.edges[sw.edge];
    if (e.cls < 5 || sw.len < 60 || e.lanesF + e.lanesB === 0) continue;
    const q = person(TLV, S, { kind: 'walker', x: 0, y: 0, swId: sw.id, swS: 12 });
    q.h = TLV.world.sidewalks.pointAt(W, sw.id, 12).h;
    if (TLV.peds.cross.tryStroll(S, q)) {
      p = q;
      break;
    }
    TLV.peds.despawn(S, q);
  }
  assert.ok(p);
  assert.ok(until(TLV, S, 12, () => p._p.mode === 'LANE'));
  const at = TLV.world.lanes.pointAt(W, p._p.laneId, p._p.laneS - 10 * p._p.laneDir, {});
  placeCar(TLV, S, { x: at.x, y: at.y, h: at.h, v: 0.5, laneId: p._p.laneId });
  const left = p._p.laneLeft;
  assert.ok(until(TLV, S, 2, () => p._p.aside));
  assert.ok(p._p.laneLeft < left);
  assert.ok(until(TLV, S, 14, () => p.state === 'WALK'));
});

test('DROPPED: a passenger on the traffic side stays hard by the door, steps out into a gap, and walks to the kerb', () => {
  const { TLV, S } = mini();
  const W = S.world;
  const log = record(S, ['ped.spawn', 'ped.intent', 'ped.stepOut']);
  const lane = W.lanes[0];
  const at = TLV.world.lanes.pointAt(W, lane.id, 60, {});
  const car = placeCar(TLV, S, { x: at.x, y: at.y, h: at.h, v: 0, laneId: lane.id });
  const left = car.width / 2 + 0.6;
  const side = { x: car.x - Math.sin(car.h) * left, y: car.y + Math.cos(car.h) * left };
  TLV.traffic = { byId: (s, id) => (id === car.id ? car : null) };
  const p = person(TLV, S, { kind: 'passenger', x: side.x, y: side.y, h: car.h, state: 'DROPPED' });
  assert.strictEqual(log[0].kind, 'passenger');
  assert.strictEqual(p.state, 'DROPPED');
  assert.strictEqual(TLV.peds.walk.bodyDist(car, p.x, p.y), 0, 'still half in the car, inside the 0.6 m an overtaker leaves');
  assert.strictEqual(p.onRoad, false);
  assert.ok(until(TLV, S, 3, () => log.some((e) => e.name === 'ped.stepOut')));
  assert.deepStrictEqual(log.filter((e) => e.name !== 'ped.spawn').map((e) => e.name), ['ped.intent', 'ped.stepOut']);
  assert.strictEqual(log[log.length - 1].state, 'DROPPED');
  assert.ok(log[2].tick - log[1].tick >= 48);
  run(TLV, S, 9);
  assert.strictEqual(p.onRoad, true);
  assert.ok(TLV.peds.obstaclesOnLane(S, lane.id, []) >= 1, 'a car on the lane knows of them');
  assert.ok(until(TLV, S, 15, () => p.state === 'WALK'));
  assert.strictEqual(p._p.mode, 'ROW');
  assert.strictEqual(S.pedsys.contacts, 0);
});

test('DROPPED: an overtaker going by holds them in the door', () => {
  const { TLV, S } = mini();
  const W = S.world;
  const log = record(S, ['ped.stepOut']);
  const lane = W.lanes[0];
  const at = TLV.world.lanes.pointAt(W, lane.id, 60, {});
  const car = placeCar(TLV, S, { x: at.x, y: at.y, h: at.h, v: 0, laneId: lane.id, slot: 1 });
  const left = car.width / 2 + 0.6;
  const side = { x: car.x - Math.sin(car.h) * left, y: car.y + Math.cos(car.h) * left };
  TLV.traffic = { byId: (s, id) => (id === car.id ? car : null) };
  const passer = placeCar(TLV, S, { x: side.x, y: side.y + 1.9, h: at.h, v: 1, laneId: -1, slot: 2 });
  const p = person(TLV, S, { kind: 'passenger', x: side.x, y: side.y, h: car.h, state: 'DROPPED' });
  run(TLV, S, 60 * 4);
  assert.strictEqual(log.length, 0);
  assert.strictEqual(p.state, 'DROPPED');
  passer.active = false;
  assert.ok(until(TLV, S, 3, () => log.length === 1));
});

test('DROPPED: if the car leaves first, they do not stand in the road', () => {
  const { TLV, S } = mini();
  const W = S.world;
  const lane = W.lanes[0];
  const at = TLV.world.lanes.pointAt(W, lane.id, 60, {});
  const car = placeCar(TLV, S, { x: at.x, y: at.y, h: at.h, v: 0, laneId: lane.id, slot: 1 });
  const left = car.width / 2 + 0.6;
  TLV.traffic = { byId: (s, id) => (id === car.id ? car : null) };
  placeCar(TLV, S, { x: car.x - Math.sin(car.h) * left, y: car.y + Math.cos(car.h) * left + 1.9, h: at.h, v: 1, laneId: -1, slot: 2 });
  const p = person(TLV, S, { kind: 'passenger', x: car.x - Math.sin(car.h) * left, y: car.y + Math.cos(car.h) * left, state: 'DROPPED' });
  run(TLV, S, 30);
  car.x += 5;
  assert.ok(until(TLV, S, 1, () => p._p.mode === 'FREE'));
});

test('FLEE: a crash scares the people round it, whoever crashed', () => {
  const { TLV, S } = mini();
  const p = person(TLV, S, { kind: 'walker', x: 0, y: -100, swId: 16, swS: 80 });
  run(TLV, S, 6);
  S.bus.emit('player.contact', { kind: 'static', severity: 'bump', x: p.x, y: p.y });
  assert.strictEqual(p.state, 'WALK', 'a bump is no crash');
  S.bus.emit('player.contact', { kind: 'static', severity: 'crash', x: p.x, y: p.y });
  assert.strictEqual(p.state, 'FLEE');
});

test('FLEE: people near a crash hurry away for 3 s, then walk on', () => {
  const { TLV, S } = mini();
  const p = person(TLV, S, { kind: 'walker', x: 0, y: -100, swId: 16, swS: 80 });
  const q = person(TLV, S, { kind: 'walker', x: 0, y: -100, swId: 12, swS: 80 });
  run(TLV, S, 6);
  const before = p._p.base;
  TLV.peds.scare(S, p.x, p.y + 5, 10);
  assert.strictEqual(p.state, 'FLEE');
  assert.strictEqual(q.state, 'WALK', 'out of range');
  const d0 = Math.hypot(p.x - p.x, 5);
  run(TLV, S, 60);
  assert.strictEqual(p.anim, 'run');
  assert.ok(p.v > before);
  assert.ok(d0 > 0);
  assert.ok(until(TLV, S, 3, () => p.state === 'WALK'));
  assert.ok(p.stateT < 3);
  run(TLV, S, 12);
  assert.ok(Math.abs(p.v - before) < 0.2);
});

test('FLEE: runs the way that takes them from it', () => {
  const { TLV, S } = mini();
  const p = person(TLV, S, { kind: 'walker', x: 0, y: -100, swId: 16, swS: 80 });
  run(TLV, S, 6);
  const dist = (x, y) => Math.hypot(p.x - x, p.y - y);
  const cx = p.x;
  const cy = p.y + 4;
  TLV.peds.scare(S, cx, cy, 10);
  const start = dist(cx, cy);
  run(TLV, S, 120);
  assert.ok(dist(cx, cy) > start + 3);
});

test('STUMBLE: a hit sits them down for 4 s, non-graphically, then they leave and stay gone from play', () => {
  const { TLV, S } = mini();
  const p = person(TLV, S, { kind: 'walker', x: 0, y: -100, swId: 16, swS: 80 });
  run(TLV, S, 6);
  TLV.peds.onHit(S, p, 1, 0, 10);
  assert.strictEqual(p.state, 'STUMBLE');
  assert.strictEqual(p.anim, 'stumble');
  const anims = new Set();
  run(TLV, S, 230, () => { anims.add(p.anim); });
  assert.ok(anims.has('sit'));
  assert.strictEqual(p.state, 'STUMBLE');
  assert.ok(until(TLV, S, 1.2, () => p.state === 'WALK'));
  assert.strictEqual(p._p.recycle, true);
  TLV.peds.onHit(S, p, 1, 0, 10);
  const hitAgain = p.state;
  assert.strictEqual(hitAgain, 'STUMBLE');
  TLV.peds.onHit(S, p, 1, 0, 10);
  assert.strictEqual(p.state, 'STUMBLE', 'a second hit changes nothing');
});

test('STUMBLE: a stumbling person cannot be commanded', () => {
  const { TLV, S } = mini();
  const p = person(TLV, S, { kind: 'walker', x: 0, y: -100 });
  TLV.peds.onHit(S, p, 1, 0, 10);
  assert.strictEqual(TLV.peds.command(S, p, { type: 'CANCEL' }), false);
});

test('SCRIPT: WP-PEDS does not move the record, computes onRoad, and reports it on its lane', () => {
  const { TLV, S } = mini();
  const W = S.world;
  const lane = W.lanes[0];
  const at = TLV.world.lanes.pointAt(W, lane.id, 60, {});
  const p = person(TLV, S, { kind: 'attacker', x: at.x, y: at.y, h: 0, state: 'SCRIPT' });
  p.hasKnife = true;
  run(TLV, S, 12);
  assert.deepStrictEqual([p.x, p.y], [at.x, at.y]);
  assert.strictEqual(p.onRoad, true);
  const out = [];
  assert.strictEqual(TLV.peds.obstaclesOnLane(S, lane.id, out), 1);
  assert.ok(Math.abs(out[0].s - 60) < 0.2);
  p.x = 0;
  p.y = 100;
  run(TLV, S, 6);
  TLV.peds.onHit(S, p, 1, 0, 10);
  TLV.peds.onBrush(S, p);
  TLV.peds.scare(S, p.x, p.y, 10);
  assert.strictEqual(p.state, 'SCRIPT', 'no state change, ever');
  assert.strictEqual(p.hasKnife, true);
  assert.strictEqual(TLV.peds.command(S, p, { type: 'CANCEL' }), false);
});

test('The horn: walkers freeze and glare 1.5 s, so honking at them backfires. A rider rings back', () => {
  const { TLV, S } = mini();
  const log = record(S, ['ped.bell', 'bubble']);
  const p = person(TLV, S, { kind: 'walker', x: 0, y: -100, swId: 16, swS: 80 });
  const r = person(TLV, S, { kind: 'scooter', x: 0, y: -100, swId: 16, swS: 82 });
  const behind = person(TLV, S, { kind: 'walker', x: 0, y: -100, swId: 16, swS: 120 });
  run(TLV, S, 6);
  const h = Math.atan2(p.y - (p.y - 10), 0);
  S.bus.emit('player.horn', { x: p.x, y: p.y - 10, h });
  run(TLV, S, 6);
  assert.strictEqual(p.anim, 'glare');
  assert.strictEqual(p.v, 0);
  assert.deepStrictEqual(log.filter((e) => e.name === 'bubble').map((e) => [e.who, e.id, e.text]), [['ped', p.id, '!?']]);
  assert.ok(log.some((e) => e.name === 'ped.bell' && e.pedId === r.id));
  assert.ok(until(TLV, S, 2, () => p.anim !== 'glare'));
  assert.ok(until(TLV, S, 0.4, () => p.v > 1));
  assert.notStrictEqual(behind.anim, 'glare');
});

test('onBrush: stops a moment and glares, with no penalty anywhere', () => {
  const { TLV, S } = mini();
  const p = person(TLV, S, { kind: 'walker', x: 0, y: -100 });
  run(TLV, S, 6);
  TLV.peds.onBrush(S, p);
  run(TLV, S, 12);
  assert.strictEqual(p.anim, 'glare');
  assert.strictEqual(p.state, 'WALK');
  assert.ok(until(TLV, S, 1, () => p.v > 1));
});

test('The design\'s numbers are the ones in tune.js (GAME_DESIGN 10, ARCHITECTURE 12.6)', () => {
  const T = loadBare().tune.peds;
  const want = {
    walkMin: 1.1, walkMax: 1.5, crossLegal: 1.3, crossSlow: 0.6, slowP: 0.12, redP: 0.15, waitMaxS: 25, jayPerMin: 0.03, strollP: 0.02,
    fleeS: 3, stumbleS: 4, hopTtcS: 1, ttcStartS: 1.5, gateDecel: 16, gateBaseM: 3, dwellMaxS: 25, intentS: 0.8, hornFreezeS: 1.5,
    scooterMin: 6, scooterMax: 7, deliveryMin: 6, deliveryMax: 9, walkerR: 0.35, riderR: 0.6, bubbleM: 120, bubbleMin: 40, bubbleMax: 60
  };
  for (const [key, value] of Object.entries(want)) assert.strictEqual(T[key], value, key);
});

test('STUMBLE: a person sitting where they fell is in the road, so a car will brake, whatever the ground is', () => {
  const { TLV, S } = mini();
  const p = person(TLV, S, { kind: 'walker', x: 0, y: -100, swId: 16, swS: 80 });
  run(TLV, S, 6);
  assert.strictEqual(p.onRoad, false);
  TLV.peds.onHit(S, p, 0, 0, 0);
  run(TLV, S, 6);
  assert.strictEqual(p.onRoad, true);
});

test('Someone a car is moving off their row counts as in the road, so that car brakes', () => {
  const { TLV, S } = mini();
  const p = person(TLV, S, { kind: 'walker', x: 0, y: -100, swId: 16, swS: 80 });
  run(TLV, S, 6);
  assert.strictEqual(p.onRoad, false);
  p._p.ox = 0.5;
  run(TLV, S, 3);
  assert.strictEqual(p.onRoad, true);
  assert.ok(until(TLV, S, 2, () => !p.onRoad), 'and not once they are back on it');
});

test('anim is one of the contract\'s, whatever anyone is doing', () => {
  const { TLV, S } = mini();
  const valid = new Set(['idle', 'walk', 'run', 'ride', 'phone', 'glare', 'tug', 'lunge', 'stumble', 'sit']);
  for (const kind of ['walker', 'phone', 'trolley', 'scooter', 'delivery']) person(TLV, S, { kind, x: 0, y: -100 });
  run(TLV, S, 600, () => {
    for (const p of S.peds) if (p.active) assert.ok(valid.has(p.anim), p.anim);
  });
});
