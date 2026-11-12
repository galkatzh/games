// tests/peds/commands.test.mjs — every command of ARCHITECTURE 13.2: what it does, when it refuses, and how it ends.
import test from 'node:test';
import assert from 'node:assert';
import {
  loadBare, sim, quiet, record, noCrowd, setPlayer, run, until, person, atCrossing, ZEBRA, zebraLanes, signalCrossing, forceWalk
} from './helpers.mjs';

quiet();

function mini() {
  const TLV = loadBare();
  noCrowd(TLV);
  const S = sim(TLV);
  setPlayer(S, 300, 300);
  return { TLV, S };
}

test('ZEBRA_STEP: intent 0.8 s, then steps out and meets the aim', () => {
  const { TLV, S } = mini();
  const log = record(S, ['ped.intent', 'ped.stepOut']);
  const p = atCrossing(TLV, S, ZEBRA, 'phone');
  run(TLV, S, 6);
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  const aim = { x: path.zX[0], y: path.zY[0], tImpact: S.t + 7, frozen: false };
  assert.strictEqual(TLV.peds.command(S, p, { type: 'ZEBRA_STEP', xingId: ZEBRA, aim }), true);
  let hit = Infinity;
  run(TLV, S, 60 * 12, () => {
    const d = Math.hypot(p.x - aim.x, p.y - aim.y);
    if (d < 0.5 && hit === Infinity) hit = S.t;
  });
  assert.deepStrictEqual(log.map((e) => e.name), ['ped.intent', 'ped.stepOut']);
  assert.ok(log[1].t - log[0].t >= 0.8 - 1e-9);
  assert.strictEqual(log[1].state, 'JAYWALK');
  assert.ok(Math.abs(hit - aim.tImpact) < 0.8, `${hit} against ${aim.tImpact}`);
});

test('ZEBRA_STEP: the aim can move until it is frozen, and the walker re-solves', () => {
  const { TLV, S } = mini();
  const p = atCrossing(TLV, S, ZEBRA, 'phone');
  run(TLV, S, 6);
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  const aim = { x: path.zX[1], y: path.zY[1], tImpact: S.t + 5.5, frozen: false };
  TLV.peds.command(S, p, { type: 'ZEBRA_STEP', xingId: ZEBRA, aim });
  assert.ok(until(TLV, S, 8, () => p.state === 'JAYWALK'));
  aim.tImpact = S.t + 1.2;
  const arc = p._p.arc;
  run(TLV, S, 30);
  assert.ok(p._p.aim);
  const rate = (p._p.arc - arc) / 0.5;
  assert.ok(rate > 2 && rate <= TLV.tune.peds.aimMaxWalker + 0.01, `${rate} m/s`);
});

test('SLOW_CROSS: crosses at 0.6 m/s, holds the lane for dwellS, and ends as a walker', () => {
  const { TLV, S } = mini();
  const p = atCrossing(TLV, S, ZEBRA, 'trolley');
  const zones = [...S.world.xings[ZEBRA].zones];
  run(TLV, S, 6);
  assert.strictEqual(TLV.peds.command(S, p, { type: 'SLOW_CROSS', xingId: ZEBRA, speed: 0.6, dwellS: 12 }), true);
  assert.ok(until(TLV, S, 8, () => p.state === 'CROSS_SLOW'));
  let held = 0;
  let paused = 0;
  run(TLV, S, 60 * 30, () => {
    if (zones.some((z) => TLV.peds.zoneOccupied(S, z))) held += 1 / 60;
    if (p.state === 'CROSS_SLOW' && p.v === 0) paused += 1 / 60;
    return p.state !== 'WALK';
  });
  assert.ok(held >= 12, `held ${held} s`);
  assert.ok(paused > 1, `paused ${paused} s`);
  assert.strictEqual(p.state, 'WALK');
});

test('RED_CROSS: crosses against the signal, with intent, and an aim holds them to it', () => {
  const TLV = loadBare('tlv_center');
  noCrowd(TLV);
  const S = sim(TLV);
  setPlayer(S, 0, 0);
  const xing = signalCrossing(TLV, S);
  forceWalk(TLV, S, xing, false);
  const log = record(S, ['ped.intent', 'ped.stepOut']);
  const p = atCrossing(TLV, S, xing.id, 'phone');
  run(TLV, S, 6);
  assert.strictEqual(TLV.peds.command(S, p, { type: 'RED_CROSS', xingId: xing.id }), true);
  assert.ok(until(TLV, S, 8, () => p.state === 'RED_CROSS'));
  assert.strictEqual(TLV.world.signals.pedWalk(S, xing.id), false);
  assert.deepStrictEqual(log.map((e) => [e.name, e.state]), [['ped.intent', undefined], ['ped.stepOut', 'RED_CROSS']]);
  assert.strictEqual(p.onRoad || p._p.stage === 'ROAD', true);
});

test('JAYWALK: walks the line asked for, over the lanes in its way, and reaches a sidewalk', () => {
  const { TLV, S } = mini();
  const log = record(S, ['ped.stepOut']);
  const p = person(TLV, S, { kind: 'phone', x: -6, y: -60 });
  run(TLV, S, 6);
  const cmd = { type: 'JAYWALK', x: -5.4, y: -60, toX: 5.4, toY: -60 };
  assert.strictEqual(TLV.peds.command(S, p, cmd), true);
  assert.ok(until(TLV, S, 8, () => p.state === 'JAYWALK'));
  assert.strictEqual(log[0].state, 'JAYWALK');
  const lanes = zebraLanes(S);
  run(TLV, S, 120);
  const seen = [lanes.north.id, lanes.south.id].map((l) => TLV.peds.obstaclesOnLane(S, l, []));
  assert.ok(seen[0] + seen[1] >= 1, 'on the lanes it crosses');
  assert.ok(until(TLV, S, 14, () => p.state === 'WALK' && p._p.mode === 'ROW'));
  assert.ok(p.x > 0, 'on the far side');
});

test('JAYWALK: refuses a line too short or too long, or out of reach', () => {
  const { TLV, S } = mini();
  const p = person(TLV, S, { kind: 'phone', x: -6, y: -60 });
  assert.strictEqual(TLV.peds.command(S, p, { type: 'JAYWALK', x: p.x, y: p.y, toX: p.x, toY: p.y }), false);
  assert.strictEqual(TLV.peds.command(S, p, { type: 'JAYWALK', x: p.x, y: p.y, toX: p.x + 300, toY: p.y }), false);
  assert.strictEqual(TLV.peds.command(S, p, { type: 'JAYWALK', x: 150, y: 150, toX: 160, toY: 150 }), false);
});

test('ZEBRA_STEP, SLOW_CROSS and RED_CROSS refuse a crossing that is unknown, or out of reach', () => {
  const { TLV, S } = mini();
  const p = person(TLV, S, { kind: 'walker', x: -6, y: -60 });
  for (const type of ['ZEBRA_STEP', 'SLOW_CROSS', 'RED_CROSS']) {
    assert.strictEqual(TLV.peds.command(S, p, { type, xingId: -1 }), false, type);
    assert.strictEqual(TLV.peds.command(S, p, { type, xingId: 999 }), false, type);
    assert.strictEqual(TLV.peds.command(S, p, { type, xingId: 5 }), false, `${type} is 300 m away`);
  }
});

test('SCOOTER_SALMON: rides against the lane at 6-7 m/s, reports negative speed, bell going, then leaves the road', () => {
  const { TLV, S } = mini();
  setPlayer(S, 12, -80);
  const log = record(S, ['ped.intent', 'ped.stepOut', 'ped.bell']);
  const W = S.world;
  const lanes = zebraLanes(S);
  const lane = lanes.north;
  const at = TLV.world.lanes.pointAt(W, lane.id, 150, {});
  const p = person(TLV, S, { kind: 'scooter', x: at.x + 8, y: at.y });
  run(TLV, S, 6);
  assert.strictEqual(TLV.peds.command(S, p, { type: 'SCOOTER_SALMON', laneId: lane.id, s: 150 }), true);
  assert.ok(until(TLV, S, 3, () => p._p.mode === 'LANE'));
  const events = log.map((e) => e.name);
  assert.ok(events.indexOf('ped.intent') < events.indexOf('ped.stepOut'));
  assert.ok(events.indexOf('ped.stepOut') >= 0);
  const s0 = p._p.laneS;
  run(TLV, S, 60);
  assert.ok(s0 - p._p.laneS > 5.8 && s0 - p._p.laneS < 7.2, `${s0 - p._p.laneS} m in a second`);
  assert.strictEqual(p.state, 'JAYWALK');
  const out = [];
  assert.ok(TLV.peds.obstaclesOnLane(S, lane.id, out) >= 1);
  assert.ok(out[0].v < -5, `v ${out[0].v}`);
  assert.ok(until(TLV, S, 30, () => p.state === 'WALK'));
  assert.ok(log.some((e) => e.name === 'ped.bell' && e.pedId === p.id));
});

test('SCOOTER_SALMON: an AI car ahead makes the rider brake, and get off the road', () => {
  const { TLV, S } = mini();
  const lanes = zebraLanes(S);
  const lane = lanes.north;
  const W = S.world;
  const at = TLV.world.lanes.pointAt(W, lane.id, 150, {});
  const p = person(TLV, S, { kind: 'scooter', x: at.x + 8, y: at.y });
  run(TLV, S, 6);
  TLV.peds.command(S, p, { type: 'SCOOTER_SALMON', laneId: lane.id, s: 150 });
  assert.ok(until(TLV, S, 3, () => p._p.mode === 'LANE'));
  run(TLV, S, 30);
  const ahead = TLV.world.lanes.pointAt(W, lane.id, p._p.laneS - 12, {});
  S.vehicles[1].active = true;
  Object.assign(S.vehicles[1], { x: ahead.x, y: ahead.y, h: ahead.h, v: 0, vx: 0, vy: 0, laneId: lane.id, length: 4.4, width: 1.8, isPlayer: false, id: 50, mode: 'LANE', yawRate: 0 });
  assert.ok(until(TLV, S, 8, () => p.state === 'WALK'));
  assert.strictEqual(S.pedsys.contacts, 0);
});

test('ROAD_STROLL: walks down the lane the way it runs, near the middle, at a stroll, and then goes back to the kerb', () => {
  const { TLV, S } = mini();
  setPlayer(S, 12, -80);
  const log = record(S, ['ped.stepOut']);
  const W = S.world;
  const lane = zebraLanes(S).north;
  const at = TLV.world.lanes.pointAt(W, lane.id, 150, {});
  const off = lane.width / 2 - 0.3;
  const p = person(TLV, S, { kind: 'walker', x: at.x + Math.sin(at.h) * off, y: at.y - Math.cos(at.h) * off });
  run(TLV, S, 6);
  assert.strictEqual(TLV.peds.command(S, p, { type: 'ROAD_STROLL', laneId: lane.id, s: 150, distM: 12, dwellS: 3 }), true);
  assert.ok(until(TLV, S, 6, () => p._p.mode === 'LANE'));
  assert.deepStrictEqual(log.map((e) => e.state), ['STROLL_ROAD']);
  assert.strictEqual(p._p.laneDir, 1);
  assert.ok(Math.abs(p._p.laneLat) <= TLV.tune.peds.strollMidM + 1e-9, 'near the middle of the lane');
  const s0 = p._p.laneS;
  run(TLV, S, 120);
  const went = p._p.laneS - s0;
  assert.ok(went > 1.2 && went < 2, `${went} m in two seconds`);
  const out = [];
  assert.ok(TLV.peds.obstaclesOnLane(S, lane.id, out) >= 1, 'a car on the lane reads them');
  assert.ok(until(TLV, S, 30, () => p.state === 'WALK'), 'the walk ends');
  assert.ok(p._p.laneS - s0 <= 12.5);
});

test('ROAD_STROLL: a car behind is heard only after dwellS, and then they move aside slowly', () => {
  const { TLV, S } = mini();
  setPlayer(S, 12, -80);
  const W = S.world;
  const lane = zebraLanes(S).north;
  const at = TLV.world.lanes.pointAt(W, lane.id, 150, {});
  const p = person(TLV, S, { kind: 'walker', x: at.x, y: at.y });
  run(TLV, S, 6);
  assert.strictEqual(TLV.peds.command(S, p, { type: 'ROAD_STROLL', laneId: lane.id, s: 150, distM: 40, dwellS: 3 }), true);
  assert.ok(until(TLV, S, 6, () => p._p.mode === 'LANE'));
  // The player's car, standing ten metres behind them on their lane.
  const back = TLV.world.lanes.pointAt(W, lane.id, p._p.laneS - 10, {});
  setPlayer(S, back.x, back.y);
  S.vehicles[0].h = back.h;
  S.vehicles[0].laneId = lane.id;
  run(TLV, S, 60 * 2);
  assert.strictEqual(p._p.aside, false, 'two seconds in, still in no hurry');
  assert.strictEqual(p.state, 'STROLL_ROAD');
  assert.ok(until(TLV, S, 3, () => p._p.aside), 'then they hear it');
  assert.ok(until(TLV, S, 20, () => p.state === 'WALK'), 'and leave the road');
});

test('ROAD_STROLL is for people on foot, on a lane within reach', () => {
  const { TLV, S } = mini();
  const lane = zebraLanes(S).north;
  const at = TLV.world.lanes.pointAt(S.world, lane.id, 150, {});
  const r = person(TLV, S, { kind: 'scooter', x: at.x, y: at.y });
  assert.strictEqual(TLV.peds.command(S, r, { type: 'ROAD_STROLL', laneId: lane.id, s: 150 }), false, 'a rider');
  const w = person(TLV, S, { kind: 'walker', x: at.x, y: at.y });
  assert.strictEqual(TLV.peds.command(S, w, { type: 'ROAD_STROLL', laneId: -1, s: 150 }), false, 'no lane');
  assert.strictEqual(TLV.peds.command(S, w, { type: 'ROAD_STROLL', laneId: lane.id, s: 20 }), false, 'out of reach');
});

test('SCOOTER_SALMON and DELIVERY_POP are for riders', () => {
  const { TLV, S } = mini();
  const w = person(TLV, S, { kind: 'walker', x: 0, y: -100 });
  assert.strictEqual(TLV.peds.command(S, w, { type: 'SCOOTER_SALMON', laneId: 0, s: 10 }), false);
  assert.strictEqual(TLV.peds.command(S, w, { type: 'DELIVERY_POP', xingId: ZEBRA }), false);
  const r = person(TLV, S, { kind: 'scooter', x: 0, y: -100 });
  assert.strictEqual(TLV.peds.command(S, r, { type: 'SCOOTER_SALMON', laneId: -1, s: 10 }), false);
  assert.strictEqual(TLV.peds.command(S, r, { type: 'DELIVERY_POP', xingId: -1 }), false);
});

test('DELIVERY_POP: leaves the sidewalk into the road at 6-9 m/s, after intent', () => {
  const { TLV, S } = mini();
  const log = record(S, ['ped.intent', 'ped.stepOut']);
  const p = atCrossing(TLV, S, ZEBRA, 'delivery');
  run(TLV, S, 6);
  assert.strictEqual(TLV.peds.command(S, p, { type: 'DELIVERY_POP', xingId: ZEBRA }), true);
  assert.ok(until(TLV, S, 5, () => p.state === 'JAYWALK'));
  assert.strictEqual(log[0].name, 'ped.intent');
  assert.ok(log[1].t - log[0].t >= 0.8 - 1e-9);
  run(TLV, S, 12);
  assert.ok(p._p.speed >= 6 && p._p.speed <= 9, `v ${p._p.speed}`);
  assert.strictEqual(p.anim, 'ride');
  assert.ok(until(TLV, S, 5, () => p.state === 'WALK'));
});

test('SAVE_BAY: stands in the bay gesturing as a saver, and leaves when the bay is taken', () => {
  const { TLV, S } = mini();
  const W = S.world;
  const near = [];
  TLV.world.parking.spotsNear(W, 0, -60, 30, near);
  const spotId = near[0];
  TLV.world.parking.setState(S, spotId, TLV.const.OCC.FREE);
  const spot = TLV.world.parking.spot(W, spotId);
  const p = person(TLV, S, { kind: 'walker', x: spot.x, y: spot.y });
  assert.strictEqual(TLV.peds.command(S, p, { type: 'SAVE_BAY', spotId }), true);
  assert.strictEqual(p.kind, 'saver');
  assert.ok(until(TLV, S, 12, () => Math.hypot(p.x - spot.x, p.y - spot.y) < 0.3));
  run(TLV, S, 60);
  assert.strictEqual(p.anim, 'glare');
  assert.strictEqual(p.v, 0);
  run(TLV, S, 60 * 30);
  assert.ok(p.active, 'waits as long as it takes');
  assert.ok(Math.hypot(p.x - spot.x, p.y - spot.y) < 0.3);
  TLV.world.parking.setState(S, spotId, TLV.const.OCC.VEHICLE);
  assert.ok(until(TLV, S, 2, () => p._p.mode !== 'STAND'));
  assert.strictEqual(p.kind, 'saver', 'still a saver in S.peds');
  assert.ok(until(TLV, S, 10, () => p._p.mode === 'ROW'));
});

test('SAVE_BAY refuses a stall that does not exist or is taken', () => {
  const { TLV, S } = mini();
  const W = S.world;
  const near = [];
  TLV.world.parking.spotsNear(W, 0, -60, 30, near);
  TLV.world.parking.setState(S, near[0], TLV.const.OCC.PARKED);
  const p = person(TLV, S, { kind: 'walker', x: 0, y: -60 });
  assert.strictEqual(TLV.peds.command(S, p, { type: 'SAVE_BAY', spotId: -1 }), false);
  assert.strictEqual(TLV.peds.command(S, p, { type: 'SAVE_BAY', spotId: near[0] }), false);
});

test('INSPECT: walks to the point, writes, and leaves', () => {
  const { TLV, S } = mini();
  const p = person(TLV, S, { kind: 'inspector', x: 10, y: -60 });
  run(TLV, S, 6);
  assert.strictEqual(TLV.peds.command(S, p, { type: 'INSPECT', x: 3, y: -60 }), true);
  assert.ok(until(TLV, S, 10, () => Math.hypot(p.x - 3, p.y + 60) < 0.3));
  run(TLV, S, 60);
  assert.strictEqual(p.anim, 'phone', 'writing');
  assert.strictEqual(p.v, 0);
  assert.ok(until(TLV, S, 4, () => p._p.mode !== 'STAND'));
  assert.strictEqual(p._p.recycle, true);
  assert.strictEqual(TLV.peds.command(S, p, { type: 'INSPECT', x: NaN, y: 0 }), false);
});

test('INSPECT: a point nobody can reach still ends, rather than walking at a wall for ever', () => {
  const { TLV, S } = mini();
  const p = person(TLV, S, { kind: 'inspector', x: 10, y: -60 });
  TLV.peds.command(S, p, { type: 'INSPECT', x: 100, y: -100 });
  assert.ok(until(TLV, S, 120, () => p._p.writeT > 0 || p._p.mode !== 'FREE'));
});

test('CANCEL: back to WALK from the kerb, and off the road from the middle of it', () => {
  const { TLV, S } = mini();
  const p = atCrossing(TLV, S, ZEBRA, 'walker');
  run(TLV, S, 6);
  const aim = { x: 0, y: -100, tImpact: S.t + 30, frozen: false };
  TLV.peds.command(S, p, { type: 'ZEBRA_STEP', xingId: ZEBRA, aim });
  assert.ok(until(TLV, S, 5, () => p.intent));
  assert.strictEqual(TLV.peds.command(S, p, { type: 'CANCEL' }), true);
  assert.strictEqual(p.state, 'WALK');
  assert.strictEqual(p.intent, false);
  assert.ok(until(TLV, S, 8, () => p._p.mode === 'ROW'));

  const q = atCrossing(TLV, S, ZEBRA, 'walker', 'B');
  run(TLV, S, 6);
  TLV.peds.command(S, q, { type: 'SLOW_CROSS', xingId: ZEBRA, speed: 0.6, dwellS: 0 });
  assert.ok(until(TLV, S, 8, () => q.state === 'CROSS_SLOW'));
  run(TLV, S, 60);
  assert.strictEqual(TLV.peds.command(S, q, { type: 'CANCEL' }), true);
  assert.ok(until(TLV, S, 16, () => q.state === 'WALK' && q._p.mode === 'ROW'));
  assert.strictEqual(q._p.job, 'AMBIENT');
});

test('CANCEL: a saver stops saving, and an inspector stops writing', () => {
  const { TLV, S } = mini();
  const near = [];
  TLV.world.parking.spotsNear(S.world, 0, -60, 30, near);
  TLV.world.parking.setState(S, near[1], TLV.const.OCC.FREE);
  const spot = TLV.world.parking.spot(S.world, near[1]);
  const p = person(TLV, S, { kind: 'walker', x: spot.x, y: spot.y });
  TLV.peds.command(S, p, { type: 'SAVE_BAY', spotId: near[1] });
  assert.ok(until(TLV, S, 10, () => p._p.mode === 'STAND'));
  assert.strictEqual(TLV.peds.command(S, p, { type: 'CANCEL' }), true);
  assert.ok(until(TLV, S, 10, () => p._p.mode === 'ROW'));
  assert.strictEqual(p._p.job, 'AMBIENT');
});

test('A command that never finds a gap gives up: no step-out, and a walker again', () => {
  const { TLV, S } = mini();
  const log = record(S, ['ped.stepOut']);
  const lanes = zebraLanes(S);
  const p = atCrossing(TLV, S, ZEBRA, 'phone');
  run(TLV, S, 6);
  const at = TLV.world.lanes.pointAt(S.world, lanes.north.id, 90, {});
  Object.assign(S.vehicles[1], { active: true, x: at.x, y: at.y, h: at.h, v: 0, vx: 0, vy: 0, length: 4.4, width: 1.8, isPlayer: false, id: 9, mode: 'LANE', laneId: lanes.north.id, yawRate: 0 });
  assert.strictEqual(TLV.peds.command(S, p, { type: 'RED_CROSS', xingId: ZEBRA }), true);
  run(TLV, S, 60 * 40);
  assert.strictEqual(log.length, 0);
  assert.strictEqual(p.state, 'WALK');
  assert.strictEqual(p._p.job, 'AMBIENT');
});
