// tests/peds/lanes.test.mjs — what traffic reads: lane obstacles, zones, dwell. Section 19 item 6.
import test from 'node:test';
import assert from 'node:assert';
import {
  loadBare, loadTLV, sim, quiet, noCrowd, setPlayer, run, until, person, atCrossing, ZEBRA, zebraLanes, record
} from './helpers.mjs';

quiet();

function mini() {
  const TLV = loadBare();
  noCrowd(TLV);
  const S = sim(TLV);
  setPlayer(S, 300, 300);
  return { TLV, S };
}

test('Someone who has left the kerb is on every lane they have yet to clear, from that moment', () => {
  const { TLV, S } = mini();
  const { north, south } = zebraLanes(S);
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  TLV.tune.peds.slowP = 0;
  const p = atCrossing(TLV, S, ZEBRA);
  TLV.peds.cross.start(S, p, path, 1, 'LEGAL');
  const out = [];
  assert.ok(until(TLV, S, 8, () => p.state === 'CROSS_LEGAL'));
  run(TLV, S, 6);
  assert.strictEqual(TLV.peds.obstaclesOnLane(S, north.id, out), 1);
  assert.strictEqual(TLV.peds.obstaclesOnLane(S, south.id, out), 1);
  for (const z of S.world.xings[ZEBRA].zones) assert.ok(TLV.peds.zoneOccupied(S, z), `zone ${z}`);
});

test('A lane cleared is free again, and that is what lets a car go behind them', () => {
  const { TLV, S } = mini();
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  TLV.tune.peds.slowP = 0;
  const p = atCrossing(TLV, S, ZEBRA);
  TLV.peds.cross.start(S, p, path, 1, 'LEGAL');
  const first = path.zZone[0];
  const second = path.zZone[1];
  assert.ok(until(TLV, S, 8, () => p.state === 'CROSS_LEGAL'));
  assert.ok(until(TLV, S, 12, () => !TLV.peds.zoneOccupied(S, first)));
  assert.ok(TLV.peds.zoneOccupied(S, second), 'still on the far lane');
  assert.ok(until(TLV, S, 6, () => !TLV.peds.zoneOccupied(S, second)));
  assert.ok(p.active);
});

test('A walker at the kerb is not on the road, and nor is one on a sidewalk over a parking strip', () => {
  const { TLV, S } = mini();
  const { north, south } = zebraLanes(S);
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  TLV.tune.peds.redP = 0;
  const p = atCrossing(TLV, S, ZEBRA);
  run(TLV, S, 6);
  assert.strictEqual(p.onRoad, false);
  TLV.peds.cross.start(S, p, path, 1, 'LEGAL');
  assert.ok(until(TLV, S, 8, () => p.intent));
  assert.strictEqual(p.onRoad, false);
  assert.strictEqual(TLV.peds.obstaclesOnLane(S, north.id, []), 0);
  assert.strictEqual(TLV.peds.obstaclesOnLane(S, south.id, []), 0);
  assert.ok(until(TLV, S, 4, () => p._p.stage === 'ROAD'));
  run(TLV, S, 12);
  assert.strictEqual(p.onRoad, true);
});

test('A list comes back nearest the lane start first, in caller-owned objects', () => {
  const { TLV, S } = mini();
  const lane = S.world.lanes[0];
  const a = TLV.world.lanes.pointAt(S.world, lane.id, 120, {});
  const b = TLV.world.lanes.pointAt(S.world, lane.id, 40, {});
  const c = TLV.world.lanes.pointAt(S.world, lane.id, 80, {});
  for (const at of [a, b, c]) person(TLV, S, { kind: 'attacker', x: at.x, y: at.y, state: 'SCRIPT' });
  run(TLV, S, 3);
  const out = [{ s: 0, halfLen: 0, v: 0, mine: true }];
  const n = TLV.peds.obstaclesOnLane(S, lane.id, out);
  assert.strictEqual(n, 3);
  assert.strictEqual(out[0].mine, true, 'reuses what it is given');
  assert.ok(out[0].s < out[1].s && out[1].s < out[2].s, JSON.stringify(out));
  assert.ok(Math.abs(out[0].s - 40) < 0.3);
  assert.ok(out[0].halfLen > 0.3);
});

test('The on-foot player is on the lanes too, and on zones, with no clock on him', () => {
  const { TLV, S } = mini();
  const { north } = zebraLanes(S);
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  const k = [...path.zLane.subarray(0, path.nz)].indexOf(north.id);
  S.player.mode = 'FOOT';
  S.player.foot.active = true;
  S.player.foot.x = path.zX[k];
  S.player.foot.y = path.zY[k];
  run(TLV, S, 3);
  const out = [];
  assert.strictEqual(TLV.peds.obstaclesOnLane(S, north.id, out), 1);
  assert.ok(TLV.peds.zoneOccupied(S, path.zZone[k]));
  run(TLV, S, 60 * 30);
  assert.ok(TLV.peds.zoneOccupied(S, path.zZone[k]), 'a person standing there is still there');
  assert.strictEqual(S.pedsys.maxDwell, 0);
  assert.deepStrictEqual(TLV.invariants.run(S).filter((f) => f.startsWith('peds')), []);
  S.player.mode = 'DRIVE';
  run(TLV, S, 3);
  assert.strictEqual(TLV.peds.obstaclesOnLane(S, north.id, out), 0);
});

test('Someone on a connector reports past the end of one lane and before the start of the next', () => {
  const TLV = loadBare();
  noCrowd(TLV);
  const S = sim(TLV);
  setPlayer(S, 300, 300);
  const W = S.world;
  const conn = W.conns.find((c) => c.len > 10 && c.turn === 'S');
  const mid = conn.len / 2;
  const at = TLV.world.lanes.connPointAt(W, conn.id, mid, {});
  person(TLV, S, { kind: 'attacker', x: at.x, y: at.y, state: 'SCRIPT' });
  run(TLV, S, 3);
  const a = [];
  const b = [];
  assert.ok(TLV.peds.obstaclesOnLane(S, conn.from, a) >= 1);
  assert.ok(TLV.peds.obstaclesOnLane(S, conn.to, b) >= 1);
  assert.ok(Math.abs(a[0].s - (W.lanes[conn.from].len + mid)) < 1, JSON.stringify(a[0]));
  assert.ok(Math.abs(b[0].s + (conn.len - mid)) < 1, JSON.stringify(b[0]));
});

test('A crowd on a crossing never holds a zone past 25 s, and new walkers wait until cars have had their turn', () => {
  const { TLV, S } = mini();
  TLV.tune.peds.slowP = 1;
  const zones = [...S.world.xings[ZEBRA].zones];
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  const crowd = [];
  for (let i = 0; i < 90; i++) {
    const side = i % 2 ? 'A' : 'B';
    crowd.push(atCrossing(TLV, S, ZEBRA, i % 3 ? 'walker' : 'trolley', side));
  }
  let free = 0;
  let worst = 0;
  let begun = 0;
  run(TLV, S, 60 * 240, (i) => {
    for (const p of crowd) {
      if (p.active && p._p.mode === 'ROW' && begun < 400 && p._p.crossCool <= 0) {
        begun++;
        TLV.peds.cross.start(S, p, path, path.swA === p._p.sw ? 1 : -1, 'LEGAL');
      }
    }
    worst = Math.max(worst, ...zones.map((z) => S.pedsys.zoneT[z]));
    if (i > 600 && !zones.some((z) => TLV.peds.zoneOccupied(S, z))) free++;
  });
  assert.ok(worst <= 25, `held ${worst} s`);
  assert.ok(worst > 14, `crowd was thin: ${worst} s`);
  assert.ok(free > 60 * 20, `cars had ${free / 60} s of 240 s`);
  assert.deepStrictEqual(S.invariantFailures.filter((f) => f.startsWith('peds')), []);
});

test('A stopped crowd never deadlocks traffic: cars get through a crossing under siege', () => {
  const TLV = loadTLV();
  noCrowd(TLV);
  TLV.tune.peds.slowP = 0.5;
  const S = sim(TLV, { traffic: true, density: 0 });
  setPlayer(S, 0, -100);
  const W = S.world;
  const { north } = zebraLanes(S);
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  const crowd = [];
  for (let i = 0; i < 60; i++) crowd.push(atCrossing(TLV, S, ZEBRA, 'walker', i % 2 ? 'A' : 'B'));
  S.traffic.target = 0;
  let through = 0;
  let next = 0;
  const zoneOnLane = W.zones[north.zones[0]].s1;
  for (let i = 0; i < 60 * 240; i++) {
    for (const p of crowd) {
      if (p.active && p._p.mode === 'ROW' && p._p.crossCool <= 0) TLV.peds.cross.start(S, p, path, path.swA === p._p.sw ? 1 : -1, 'LEGAL');
    }
    if (i >= next) {
      const car = TLV.traffic.spawn(S, { laneId: north.id, s: 40, v: 8 });
      if (car) car._t.passed = false;
      next = i + 60 * 12;
    }
    TLV.sim.step(S);
    for (const v of S.vehicles) {
      if (!v.active || v.isPlayer || v._t.passed) continue;
      if ((v.laneId === north.id && v.s > zoneOnLane + 3) || v.mode === 'CONN') {
        v._t.passed = true;
        through++;
      }
    }
  }
  assert.ok(through >= 10, `${through} cars through in 240 s`);
  assert.deepStrictEqual(S.invariantFailures.filter((f) => f.startsWith('peds.contacts')), []);
  assert.ok(S.pedsys.maxDwell <= 25, `held ${S.pedsys.maxDwell} s`);
});

test('peds.dwell fails loudly if a zone is ever held past the cap', () => {
  const { TLV, S } = mini();
  S.pedsys.maxDwell = 26;
  assert.ok(TLV.invariants.run(S).some((f) => f.startsWith('peds.dwell')));
});

test('Someone caught on a zone at the cap is forced off, past whatever is in the way', () => {
  const { TLV, S } = mini();
  const log = record(S, ['ped.stepOut']);
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  const p = atCrossing(TLV, S, ZEBRA);
  TLV.tune.peds.slowP = 0;
  TLV.peds.cross.start(S, p, path, 1, 'LEGAL');
  assert.ok(until(TLV, S, 8, () => log.length === 1));
  // Stand them still on the road, then wind the zone's clock on. 22.5 s by hand: the cap's margin is what is under test.
  S.pedsys.zoneT[path.zZone[1]] = 22.5;
  run(TLV, S, 9);
  assert.strictEqual(p._p.force, true);
  assert.ok(until(TLV, S, 7, () => p.state === 'WALK'));
});

test('Someone far from the way off a held zone is forced early enough to clear it inside the cap', () => {
  const { TLV, S } = mini();
  const T = TLV.tune.peds;
  const log = record(S, ['ped.stepOut']);
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  const p = atCrossing(TLV, S, ZEBRA);
  T.slowP = 0;
  TLV.peds.cross.start(S, p, path, 1, 'LEGAL');
  assert.ok(until(TLV, S, 8, () => log.length === 1));
  const k = path.nz - 1;
  const zone = path.zZone[k];
  const left = () => (path.zArc[k] - p._p.arc) * p._p.pdir + path.zClear[k];
  // Too far out for a fixed 22.5 s: seed 19 stood 6.1 m out, took 2.8 s at hurry speed, and held the zone 25.3 s.
  assert.ok(left() > (T.dwellMaxS - T.dwellForceS) * T.hurry, `${left()} m to go`);
  // Told to hurry, and stood still by a car in the road, with the clock a moment short of what the walk off needs.
  p._p.hurry = true;
  p._p.pauseT = 1000;
  p._p.pauseAt = p._p.arc;
  const due = T.dwellMaxS - T.dwellSpareS - left() / T.hurry;
  assert.ok(due < T.dwellForceS, `due at ${due} s, before the fixed clock`);
  S.pedsys.zoneT[zone] = due - 0.25;
  run(TLV, S, 3);
  assert.strictEqual(p._p.force, false, 'not yet');
  run(TLV, S, 15);
  assert.strictEqual(p._p.force, true, 'forced by what is left to walk');
  assert.ok(S.pedsys.zoneT[zone] < T.dwellForceS);
  p._p.pauseT = 0;
  assert.ok(until(TLV, S, 7, () => left() < 0));
  run(TLV, S, 3);
  assert.ok(S.pedsys.maxDwell <= T.dwellMaxS, `held ${S.pedsys.maxDwell} s`);
});

test('A zone held 14 s admits nobody new, and stays shut 6 s after, so cars get their turn', () => {
  const { TLV, S } = mini();
  const log = record(S, ['ped.stepOut']);
  const path = TLV.peds.cross.pathOf(S, ZEBRA);
  TLV.tune.peds.slowP = 0;
  const first = atCrossing(TLV, S, ZEBRA);
  TLV.peds.cross.start(S, first, path, 1, 'LEGAL');
  assert.ok(until(TLV, S, 8, () => log.length === 1));
  S.pedsys.zoneT[path.zZone[1]] = 14;
  run(TLV, S, 3);
  assert.ok(S.pedsys.xingHold[ZEBRA] > S.t, 'the crossing shuts');
  const next = atCrossing(TLV, S, ZEBRA, 'walker', 'B');
  TLV.peds.cross.start(S, next, path, -1, 'LEGAL');
  assert.ok(until(TLV, S, 6, () => next.state === 'WAIT_CROSS'));
  run(TLV, S, 120);
  assert.strictEqual(log.length, 1, 'nobody new on a shut crossing');
  assert.ok(until(TLV, S, 16, () => log.length === 2), 'and it opens again');
});
