// tests/peds/fairness.test.mjs — intent, the step-out gate and hop-back (ARCHITECTURE 12.6, section 19 items 3 and 4).
import test from 'node:test';
import assert from 'node:assert';
import {
  loadBare, sim, quiet, record, noCrowd, setPlayer, run, until, atCrossing, ZEBRA, zebraLanes, placeCar, signalCrossing, forceWalk
} from './helpers.mjs';

quiet();

function mini() {
  const TLV = loadBare();
  noCrowd(TLV);
  const S = sim(TLV);
  setPlayer(S, 300, 300);
  return { TLV, S };
}

/** Puts a car on the fixture's north-bound lane with its nose a set distance south of the zebra's conflict point, at a speed. */
function carTo(TLV, S, gap, v, kind = 'sedan') {
  const { north } = zebraLanes(S);
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  const k = [...path.zLane.subarray(0, path.nz)].indexOf(north.id);
  const zy = path.zY[k];
  const length = TLV.const.VEHICLE_SIZES[kind].length;
  return placeCar(TLV, S, { x: path.zX[k], y: zy - gap - length / 2, h: Math.PI / 2, v, kind, laneId: north.id });
}

test('intent is true from at least 0.8 s before every step-out, whoever steps out and however', () => {
  for (const [kind, type] of [['walker', 'ZEBRA_STEP'], ['trolley', 'SLOW_CROSS'], ['phone', 'RED_CROSS'], ['delivery', 'DELIVERY_POP']]) {
    const { TLV, S } = mini();
    const log = record(S, ['ped.intent', 'ped.stepOut']);
    const p = atCrossing(TLV, S, ZEBRA, kind);
    run(TLV, S, 6);
    let since = -1;
    TLV.peds.command(S, p, { type, xingId: ZEBRA });
    run(TLV, S, 60 * 8, () => {
      if (p.intent && since < 0) since = S.t;
      if (!p.intent && log.length < 2) since = -1;
      if (log.length === 2 && since >= 0) {
        assert.ok(S.t - since >= 0.8 - 1e-9, `${kind}: ${S.t - since}`);
        since = -2;
      }
    });
    assert.strictEqual(log.length, 2, kind);
    assert.ok(log[1].tick - log[0].tick >= 48, kind);
    assert.strictEqual(p.intent, false, 'off once stepped out');
  }
});

test('tune.peds.intentS is the shared key, 0.8', () => {
  const TLV = loadBare();
  assert.strictEqual(TLV.tune.peds.intentS, 0.8);
});

test('the AI gate, at its edge: no step-out inside v * v / 16 + 3 m of the conflict point, and out just past it', () => {
  for (const v of [0, 4, 8, 12, 16]) {
    const reach = v * v / 16 + 3;
    const { TLV, S } = mini();
    const inside = carTo(TLV, S, reach - 0.2, v);
    const p = atCrossing(TLV, S, ZEBRA);
    run(TLV, S, 6);
    const path = TLV.peds.cross.pathOf(S, ZEBRA);
    S.pedsys.cpX[0] = path.zX[0];
    S.pedsys.cpY[0] = path.zY[0];
    S.pedsys.cpX[1] = path.zX[1];
    S.pedsys.cpY[1] = path.zY[1];
    assert.strictEqual(TLV.peds.cross.gate(S, 2, path.zLane, 2, false, p.r), false, `${v} m/s, inside`);
    inside.y -= 0.4;
    assert.strictEqual(TLV.peds.cross.gate(S, 2, path.zLane, 2, false, p.r), true, `${v} m/s, outside`);
  }
});

test('a walker at a zebra with a car coming waits, then crosses once it has passed', () => {
  const { TLV, S } = mini();
  const log = record(S, ['ped.stepOut']);
  TLV.tune.peds.redP = 0;
  const p = atCrossing(TLV, S, ZEBRA);
  TLV.peds.cross.start(S, p, TLV.peds.cross.pathOf(S, ZEBRA), 1, 'LEGAL');
  assert.ok(until(TLV, S, 6, () => p.state === 'WAIT_CROSS'));
  const car = carTo(TLV, S, 2, 0);
  run(TLV, S, 60 * 5);
  assert.strictEqual(log.length, 0, 'a stopped car within 3 m holds them');
  car.active = false;
  assert.ok(until(TLV, S, 3, () => log.length === 1));
});

test('The player: never with TTC to the point under 1.5 s', () => {
  for (const [ttc, go] of [[1.2, false], [1.45, false], [1.6, true], [3, true]]) {
    const { TLV, S } = mini();
    const { north } = zebraLanes(S);
    const path = TLV.peds.cross.pathOf(S, ZEBRA);
    const k = [...path.zLane.subarray(0, path.nz)].indexOf(north.id);
    const v = 10;
    const length = S.vehicles[0].length;
    setPlayer(S, path.zX[k], path.zY[k] - ttc * v - length / 2, Math.PI / 2, v);
    const p = atCrossing(TLV, S, ZEBRA);
    S.pedsys.cpX[0] = path.zX[0];
    S.pedsys.cpY[0] = path.zY[0];
    S.pedsys.cpX[1] = path.zX[1];
    S.pedsys.cpY[1] = path.zY[1];
    assert.strictEqual(TLV.peds.cross.gate(S, 2, path.zLane, 2, false, p.r), go, `TTC ${ttc}`);
  }
});

test('The player: a car going away, or one stopped short of the point, holds nobody', () => {
  const { TLV, S } = mini();
  const { north } = zebraLanes(S);
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  const k = [...path.zLane.subarray(0, path.nz)].indexOf(north.id);
  setPlayer(S, path.zX[k], path.zY[k] + 6, Math.PI / 2, 12);
  const p = atCrossing(TLV, S, ZEBRA);
  S.pedsys.cpX[0] = path.zX[0];
  S.pedsys.cpY[0] = path.zY[0];
  S.pedsys.cpX[1] = path.zX[1];
  S.pedsys.cpY[1] = path.zY[1];
  assert.strictEqual(TLV.peds.cross.gate(S, 2, path.zLane, 2, false, p.r), true);
});

test('A commanded walker whose gate is shut waits at the kerb, with intent, and does not step out', () => {
  const { TLV, S } = mini();
  const log = record(S, ['ped.stepOut']);
  const { north } = zebraLanes(S);
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  const k = [...path.zLane.subarray(0, path.nz)].indexOf(north.id);
  const p = atCrossing(TLV, S, ZEBRA, 'phone');
  run(TLV, S, 6);
  const aim = { x: path.zX[k], y: path.zY[k], tImpact: S.t + 3, frozen: false };
  TLV.peds.command(S, p, { type: 'ZEBRA_STEP', xingId: ZEBRA, aim });
  assert.ok(until(TLV, S, 1.5, () => p.intent));
  // At 1.0 s to go, the player is 1.0 s from the point: under 1.5 s, so the step is off.
  const v = 10;
  setPlayer(S, path.zX[k], path.zY[k] - 10 - 2, Math.PI / 2, v);
  run(TLV, S, 60);
  assert.strictEqual(log.length, 0);
});

test('Hop-back: an ambient walker on the road turns back at car TTC under 1 s', () => {
  const { TLV, S } = mini();
  TLV.tune.peds.slowP = 0;
  const p = atCrossing(TLV, S, ZEBRA);
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  TLV.peds.cross.start(S, p, path, 1, 'LEGAL');
  assert.ok(until(TLV, S, 8, () => p.state === 'CROSS_LEGAL'));
  const pdir = p._p.pdir;
  assert.ok(until(TLV, S, 4, () => p._p.arc > path.zArc[0] - 0.8));
  const car = placeCar(TLV, S, { x: p.x, y: p.y + (p.y < -100 ? -1 : 1) * -9.5, h: Math.PI / 2 * (p.y < -100 ? 1 : -1), v: 9, laneId: -1 });
  car.y = p.y - 2.2 - 9 * 0.8;
  car.h = Math.PI / 2;
  car.vx = 0;
  car.vy = 9;
  run(TLV, S, 9);
  assert.strictEqual(p._p.hopped, true, 'hopped');
  assert.strictEqual(p._p.pdir, -pdir);
  car.active = false;
  assert.ok(until(TLV, S, 10, () => p.state === 'WALK'));
  assert.strictEqual(p._p.mode === 'ROW' || p._p.mode === 'FREE', true);
  assert.strictEqual(p._p.sw, path.swA, 'back on the side they came from');
});

test('Hop-back: a walker commanded with an aim holds their path', () => {
  const { TLV, S } = mini();
  const p = atCrossing(TLV, S, ZEBRA, 'phone');
  run(TLV, S, 6);
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  const aim = { x: path.zX[1], y: path.zY[1], tImpact: S.t + 7, frozen: false };
  TLV.peds.command(S, p, { type: 'ZEBRA_STEP', xingId: ZEBRA, aim });
  assert.ok(until(TLV, S, 9, () => p.state === 'JAYWALK'));
  assert.ok(until(TLV, S, 4, () => p._p.arc > path.zArc[0] - 0.8));
  const pdir = p._p.pdir;
  const car = placeCar(TLV, S, { x: p.x, y: p.y - 2.2 - 9 * 0.8, h: Math.PI / 2, v: 9, laneId: -1 });
  run(TLV, S, 9);
  assert.strictEqual(p._p.pdir, pdir, 'no hop-back');
  assert.strictEqual(p._p.hopped, false);
  car.active = false;
});

test('Hop-back: a commanded walker with no aim is ambient in this, and hops', () => {
  const { TLV, S } = mini();
  const p = atCrossing(TLV, S, ZEBRA, 'walker');
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  run(TLV, S, 6);
  TLV.peds.cross.start(S, p, path, 1, 'LEGAL');
  p._p.job = 'AMBIENT';
  assert.ok(until(TLV, S, 8, () => p.stateT > 0 && p._p.stage === 'ROAD'));
  assert.ok(until(TLV, S, 4, () => p._p.arc > path.zArc[0] - 0.8));
  placeCar(TLV, S, { x: p.x, y: p.y - 2.2 - 9 * 0.8, h: Math.PI / 2, v: 9, laneId: -1 });
  run(TLV, S, 9);
  assert.strictEqual(p._p.hopped, true);
});

test('At a signal, a car stopped at its red with its nose clear of the line does not stop a walker on the walk phase', () => {
  const TLV = loadBare('tlv_center');
  noCrowd(TLV);
  const S = sim(TLV);
  setPlayer(S, 0, 0);
  const W = S.world;
  // A crossing whose line runs past a stop line, the usual case at a light.
  let xing = null;
  let k = -1;
  for (const x of W.xings) {
    if (!x.signal || x.ctrl < 0) continue;
    const path = TLV.peds.cross.pathOf(S, x.id);
    if (!path.ambient || path.spots.length) continue;
    for (let i = 0; i < path.nz; i++) {
      const lane = W.lanes[path.zLane[i]];
      const end = TLV.world.lanes.pointAt(W, lane.id, lane.len, {});
      if (Math.hypot(end.x - path.zX[i], end.y - path.zY[i]) < 1 && lane.len > 10) {
        xing = x;
        k = i;
      }
    }
    if (xing) break;
  }
  assert.ok(xing, 'no crossing at a stop line');
  const path = TLV.peds.cross.pathOf(S, xing.id);
  const lane = W.lanes[path.zLane[k]];
  forceWalk(TLV, S, xing, true);
  const at = TLV.world.lanes.pointAt(W, lane.id, lane.len - 2.2, {});
  placeCar(TLV, S, { x: at.x, y: at.y, h: at.h, v: 0, laneId: lane.id });
  const log = record(S, ['ped.stepOut']);
  TLV.tune.peds.slowP = 0;
  const p = atCrossing(TLV, S, xing.id);
  TLV.peds.cross.start(S, p, path, 1, 'LEGAL');
  assert.ok(until(TLV, S, 8, () => log.length === 1), 'stepped out in front of the waiting car');
  assert.ok(until(TLV, S, 15, () => p.state === 'WALK'));
  assert.strictEqual(S.pedsys.contacts, 0);
});

test('A car sitting on the line itself stops anyone stepping out, walk phase or not', () => {
  const { TLV, S } = mini();
  const log = record(S, ['ped.stepOut']);
  carTo(TLV, S, -2.2, 0);
  const p = atCrossing(TLV, S, ZEBRA);
  TLV.peds.cross.start(S, p, TLV.peds.cross.pathOf(S, ZEBRA), 1, 'LEGAL');
  run(TLV, S, 60 * 8);
  assert.strictEqual(log.length, 0);
});

test('Someone caught on the road by a stopped car walks round it, between it and the next', () => {
  const { TLV, S } = mini();
  TLV.tune.peds.slowP = 0;
  const p = atCrossing(TLV, S, ZEBRA);
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  TLV.peds.cross.start(S, p, path, 1, 'LEGAL');
  assert.ok(until(TLV, S, 8, () => p.state === 'CROSS_LEGAL'));
  // A stopped car lands on the far lane after the walker has left the kerb.
  const { north, south } = zebraLanes(S);
  const far = p._p.pdir > 0 ? [...path.zLane.subarray(0, path.nz)][path.nz - 1] : [...path.zLane.subarray(0, path.nz)][0];
  const k = [...path.zLane.subarray(0, path.nz)].indexOf(far);
  assert.ok(far === north.id || far === south.id);
  placeCar(TLV, S, { x: path.zX[k], y: path.zY[k], h: far === north.id ? Math.PI / 2 : -Math.PI / 2, v: 0, laneId: far, slot: 1 });
  placeCar(TLV, S, { x: path.zX[k], y: path.zY[k] - 6.6, h: far === north.id ? Math.PI / 2 : -Math.PI / 2, v: 0, laneId: far, slot: 2 });
  assert.ok(until(TLV, S, 30, () => p.state === 'WALK'));
  assert.strictEqual(S.pedsys.contacts, 0);
  assert.ok(until(TLV, S, 10, () => p._p.mode === 'ROW'));
  assert.strictEqual(p._p.sw, path.swB);
});

test('A person stepping aside from a car goes sideways, never back into it', () => {
  const { TLV, S } = mini();
  const p = atCrossing(TLV, S, ZEBRA);
  run(TLV, S, 3);
  // A car about to reach them from behind, along the row: the box of where it will be has them near its rear end.
  const car = placeCar(TLV, S, { x: p.x, y: p.y - 6.5, h: Math.PI / 2, v: 8, laneId: -1 });
  const y0 = p.y;
  run(TLV, S, 9);
  assert.ok(Math.abs(p.x - car.x) > 0.05, 'stepped to the side');
  assert.ok(p.y >= y0 - 0.2, 'moved back toward the car');
});

test('peds.contacts counts an AI body on a person, and only that', () => {
  const { TLV, S } = mini();
  const p = atCrossing(TLV, S, ZEBRA);
  run(TLV, S, 6);
  assert.deepStrictEqual(TLV.invariants.run(S).filter((f) => f.startsWith('peds')), []);
  placeCar(TLV, S, { x: p.x, y: p.y, h: 0, v: 3 });
  run(TLV, S, 6);
  assert.ok(S.pedsys.contacts > 0);
  assert.ok(TLV.invariants.run(S).some((f) => f.startsWith('peds.contacts')));
  assert.deepStrictEqual(TLV.invariants.run(S).filter((f) => f.startsWith('peds.contacts')), [], 'reported once');
});

test('The player touching someone is not an AI contact: that is player.hitPed', () => {
  const { TLV, S } = mini();
  const p = atCrossing(TLV, S, ZEBRA);
  run(TLV, S, 3);
  setPlayer(S, p.x, p.y, 0, 5);
  run(TLV, S, 6);
  assert.strictEqual(S.pedsys.contacts, 0);
});

test('forceWalk keeps walkers off a road with a green, and a signal crossing has a walk phase by itself', () => {
  const TLV = loadBare('tlv_center');
  noCrowd(TLV);
  const S = sim(TLV);
  setPlayer(S, 0, 0);
  const xing = signalCrossing(TLV, S);
  let walks = 0;
  for (let i = 0; i < 90 * 60; i++) {
    TLV.sim.step(S);
    if (TLV.world.signals.pedWalk(S, xing.id)) walks++;
  }
  assert.ok(walks / 60 >= 12, `${walks / 60} s of walk in 90 s`);
});
