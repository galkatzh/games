// tests/traffic/contract.test.mjs — WP-TRAFFIC
// ARCHITECTURE 19, items 3, 4, 5, 8, 9 and 10, on real tlv_center lanes. Item 2 is behaviours.test.mjs, item 7 parkrace.test.mjs, and
// items 1 and 6 are the soak (tests/traffic/soak.mjs).
import test from 'node:test';
import {
  assert, realTLV, quietSim, run, runUntil, findLane, signalApproach, holdRed, car, playerOn, parkPlayer, events
} from './helpers.mjs';

const TLV = realTLV();
const W = TLV.world.get('tlv_center');
const C = TLV.const;
const Q = TLV.tune.traffic;

const lonely = (l) => l.left < 0 && l.right < 0 && l.opposite < 0 && l.len >= 120 && l.width >= 2.8;

/** Places an approach of a signal, and a car on a crossing approach of the same junction. */
function crossing() {
  for (const conn of W.conns) {
    if (conn.slot < 0 || conn.turn !== 'S' || conn.len < 8 || !conn.conflicts.length) continue;
    const from = W.lanes[conn.from];
    if (!(from.flags & 1) || from.len < 80 || !(W.lanes[conn.to].flags & 1) || W.lanes[conn.to].len < 60) continue;
    const ctrl = W.ctrls[W.juncs[conn.junc].ctrl];
    if (ctrl.slots.length !== 2) continue;
    for (const x of conn.conflicts) {
      const o = W.conns[x];
      const of = W.lanes[o.from];
      if (o.slot === conn.slot || o.turn !== 'S' || !(of.flags & 1) || of.len < 60 || !(W.lanes[o.to].flags & 1)) continue;
      return { runner: conn, cross: o };
    }
  }
  return assert.fail('no signal crossing on the map');
}

test('item 3: a red runner enters on red, the car on green yields, and no two bodies overlap', () => {
  const S = quietSim({ seed: 7, params: { invariants: 1 } });
  const { runner, cross } = crossing();
  TLV.world.signals.alignGreen(S, cross.id, -1);
  assert.equal(TLV.world.signals.connState(S, cross.id), C.SIG.GREEN);
  const a = car(S, { laneId: runner.from, s: W.lanes[runner.from].len - 26, v: 10, ag: 0.9 });
  a._t.pn = 0; a._t.pg = 0; a._t.plan[0] = runner.id; a._t.pn = 1;
  TLV.traffic.gate.extend(S, a);
  assert.equal(TLV.traffic.command(S, a, { type: 'RED_RUN' }), true);
  runUntil(S, () => S.traffic.occ[runner.id] > 0, 1, 'the runner taking the junction');
  const b = car(S, { laneId: cross.from, s: W.lanes[cross.from].len - 13, v: 3, ag: 0.5 });
  b._t.pn = 0; b._t.pg = 0; b._t.plan[0] = cross.id; b._t.pn = 1;
  TLV.traffic.gate.extend(S, b);
  let yielded = false;
  runUntil(S, () => {
    assert.equal(TLV.math.obbOverlap(a, b), false, 'bodies overlap');
    if (a.mode === 'CONN' && b.mode === 'LANE' && b._t.why === TLV.traffic.gate.WHY.CONFLICT) yielded = true;
    return a.beh === 'CRUISE';
  }, 12, 'the run to end');
  assert.equal(events(S, 'traffic.redRun', (e) => e.vehId === a.id).length, 1, 'it did cross on red');
  assert.ok(yielded, 'the car on green held at its line for the occupied connector');
  run(S, 180);
  assert.deepEqual(S.invariantFailures, []);
});

test('item 4: a tailgater holds 1.4-3 m at 10 m/s for 6 s, and the player braking at 14 m/s2 gets a rear-end contact', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 300 && l.vmax > 13);
  let s = 60;
  const drive = (v) => playerOn(S, lane.id, s, v);
  drive(10);
  const veh = car(S, { laneId: lane.id, s: 30, v: 10, ag: 0.8 });
  assert.equal(TLV.traffic.command(S, veh, { type: 'TAILGATE', durS: 30, targetId: 0 }), true);
  assert.equal(veh.beh, 'TAILGATE');
  const gap = () => s - S.vehicles[0].length / 2 - veh.s - veh.length / 2;
  for (let i = 0; i < 900 && (gap() > 3 || Math.abs(veh.v - 10) > 0.2); i++) {
    s += 10 * C.DT;
    drive(10);
    TLV.sim.step(S);
  }
  let lo = Infinity;
  let hi = 0;
  for (let i = 0; i < 360; i++) {
    s += 10 * C.DT;
    drive(10);
    TLV.sim.step(S);
    lo = Math.min(lo, gap());
    hi = Math.max(hi, gap());
    assert.equal(veh.beh, 'TAILGATE');
  }
  assert.ok(lo >= 1.4 - 0.01 && hi <= 3, `gap ran ${lo} to ${hi} over 6 s`);
  let v = 10;
  let contact = false;
  for (let i = 0; i < 240 && !contact; i++) {
    v = Math.max(0, v - 14 * C.DT);
    s += v * C.DT;
    drive(v);
    TLV.sim.step(S);
    contact = TLV.math.obbOverlap(veh, S.vehicles[0]);
  }
  assert.ok(contact, 'braking above 8 m/s2 gets the player rear-ended');
  assert.ok(veh.accel >= -Q.hardBrake - 1e-9, 'it brakes no harder than the floor');
});

test('OVERTAKE of the player: a follower named by the command passes him at speed, on a road with room, and a car with none is refused', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 300 && l.vmax > 13 && l.left >= 0);
  let s = 60;
  const drive = (v = 10) => {
    s += v * C.DT;
    playerOn(S, lane.id, s, v);
  };
  drive();
  for (let i = 0; i < 2; i++) TLV.sim.step(S);
  const veh = car(S, { laneId: lane.id, s: 44, v: 10, ag: 0.5 });
  TLV.sim.step(S);
  assert.equal(TLV.traffic.command(S, veh, { type: 'OVERTAKE', targetId: 0 }), true, 'the lead need not be read yet');
  assert.equal(veh.beh, 'OVERTAKE_OUT');
  let top = 0;
  for (let i = 0; i < 60 * 9 && veh.beh !== 'CUT_IN'; i++) {
    drive();
    TLV.sim.step(S);
    top = Math.max(top, veh.v);
  }
  assert.equal(veh.beh, 'CUT_IN');
  assert.ok(top > 14, `goes past at ${top.toFixed(1)} m/s`);
  const end = findLane(W, (l) => l.len >= 60 && l.len < 80 && l.left < 0 && l.right < 0 && l.opposite < 0);
  const stuck = quietSim();
  playerOn(stuck, end.id, 50, 10);
  const back = car(stuck, { laneId: end.id, s: 34, v: 10, ag: 0.8 });
  TLV.sim.step(stuck);
  const was = back.beh;
  assert.equal(TLV.traffic.command(stuck, back, { type: 'OVERTAKE', targetId: 0 }), false, 'a lane with no way round');
  assert.equal(back.beh, was, 'and the car is left as it was');
});

test('item 5: every command gives the right bool, on a car that can and one that cannot, and CANCEL restores CRUISE', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 200 && l.right < 0 && l.opposite >= 0);
  const fresh = (s = 40, v = 6) => car(S, { laneId: lane.id, s, v });
  const ctl = () => ({ speedScale: 1, mayBlink: true, holdCreep: false });
  const ids = [];
  const mid = TLV.world.lanes.pointAt(W, lane.id, lane.len / 2, {});
  TLV.world.parking.spotsNear(W, mid.x, mid.y, 150, ids);
  const spotId = ids[0];
  const signal = signalApproach(W);
  const parked = TLV.traffic.materializeParked(S, ids[1]);
  const wreck = fresh(120, 0);
  TLV.traffic.behaviours.wreck(S, wreck);
  const bus = car(S, { laneId: lane.id, s: 150, v: 0, kind: 'bus' });
  const atSignal = car(S, { laneId: signal.id, s: signal.len - 40, v: 8 });

  const cases = [
    ['RED_RUN', atSignal, { type: 'RED_RUN' }, true], ['RED_RUN', wreck, { type: 'RED_RUN' }, false],
    ['TAILGATE', fresh(), { type: 'TAILGATE', durS: 5, targetId: 0 }, true], ['TAILGATE', fresh(), { type: 'TAILGATE', durS: 5, targetId: 99999 }, false],
    ['TAILGATE', parked, { type: 'TAILGATE', durS: 5, targetId: 0 }, false],
    ['NOSE_IN', fresh(), { type: 'NOSE_IN' }, true], ['NOSE_IN', parked, { type: 'NOSE_IN' }, false],
    ['OVERTAKE', fresh(), { type: 'OVERTAKE', targetId: 99999 }, false], ['OVERTAKE', parked, { type: 'OVERTAKE' }, false],
    ['PHANTOM_STOP', fresh(), { type: 'PHANTOM_STOP', decel: 5, holdS: 2 }, true], ['PHANTOM_STOP', parked, { type: 'PHANTOM_STOP', decel: 5, holdS: 2 }, false],
    ['DROP_OFF', fresh(), { type: 'DROP_OFF', holdS: 2, door: 'traffic', passenger: true }, true], ['DROP_OFF', parked, { type: 'DROP_OFF', holdS: 2 }, false],
    ['DOUBLE_PARK', fresh(), { type: 'DOUBLE_PARK', holdS: 2 }, true], ['DOUBLE_PARK', wreck, { type: 'DOUBLE_PARK', holdS: 2 }, false],
    ['REVERSE_FOR_SPOT', fresh(), { type: 'REVERSE_FOR_SPOT', distM: 10 }, true], ['REVERSE_FOR_SPOT', parked, { type: 'REVERSE_FOR_SPOT', distM: 10 }, false],
    ['BUS_PULLOUT', bus, { type: 'BUS_PULLOUT' }, true], ['BUS_PULLOUT', fresh(), { type: 'BUS_PULLOUT' }, false],
    ['DOOR_OPEN', parked, { type: 'DOOR_OPEN', side: 'curb', holdS: 2 }, true], ['DOOR_OPEN', fresh(), { type: 'DOOR_OPEN', side: 'curb', holdS: 2 }, false],
    ['PULLOUT', fresh(), { type: 'PULLOUT' }, false],
    ['PARK_RACE', fresh(), { type: 'PARK_RACE', spotId, ctl: ctl() }, true], ['PARK_RACE', fresh(), { type: 'PARK_RACE', spotId: 1e9, ctl: ctl() }, false],
    ['PARK_RACE', parked, { type: 'PARK_RACE', spotId, ctl: ctl() }, false],
    ['PARK_HOLD', fresh(), { type: 'PARK_HOLD', maxS: 3 }, true], ['PARK_HOLD', parked, { type: 'PARK_HOLD', maxS: 3 }, false],
    ['PARK_ABORT', fresh(), { type: 'PARK_ABORT' }, false],
    ['RIVAL_BLOCK', fresh(), { type: 'RIVAL_BLOCK', holdS: 3 }, true], ['RIVAL_BLOCK', parked, { type: 'RIVAL_BLOCK', holdS: 3 }, false],
    ['RIVAL_STANDOFF', fresh(), { type: 'RIVAL_STANDOFF', x: mid.x, y: mid.y, h: 0, durS: 1 }, true], ['RIVAL_STANDOFF', wreck, { type: 'RIVAL_STANDOFF', x: mid.x, y: mid.y, h: 0, durS: 1 }, false],
    ['TOWED', fresh(), { type: 'TOWED' }, true],
    ['unknown', fresh(), { type: 'NOT_A_COMMAND' }, false]
  ];
  for (const [name, veh, cmd, want] of cases) {
    assert.equal(TLV.traffic.command(S, veh, cmd), want, `${name} on a ${veh.mode} ${veh.beh} car`);
  }
  assert.equal(TLV.traffic.command(S, S.vehicles[0], { type: 'CANCEL' }), false, 'the player takes no command');
  const onEnd = car(S, { laneId: lane.id, s: 20, v: 5 });
  TLV.traffic.command(S, onEnd, { type: 'PARK_RACE', spotId, ctl: ctl() });
  assert.equal(TLV.traffic.command(S, onEnd, { type: 'PARK_ABORT' }), true);
  assert.equal(onEnd.beh, 'CRUISE');
  for (const cmd of [{ type: 'PHANTOM_STOP', decel: 5, holdS: 9 }, { type: 'DOUBLE_PARK', holdS: 9 }, { type: 'TAILGATE', durS: 9, targetId: 0 }, { type: 'DROP_OFF', holdS: 9 }]) {
    const veh = fresh(30, 6);
    assert.equal(TLV.traffic.command(S, veh, cmd), true);
    assert.notEqual(veh.beh, 'CRUISE');
    assert.equal(TLV.traffic.command(S, veh, { type: 'CANCEL' }), true);
    assert.equal(veh.beh, 'CRUISE', `${cmd.type} then CANCEL`);
    assert.equal(veh.lights & (C.VL.HAZARD | C.VL.HIGH_BEAM), 0);
    assert.ok(Number.isNaN(veh._t.forceA));
  }
  assert.equal(TLV.traffic.gate.audit(S), null);
});

test('item 8: prewarm reaches the target with the player\'s lane clear, emits nothing, leaves the tick alone, and is deterministic', () => {
  const run1 = prewarmed();
  const run2 = prewarmed();
  assert.ok(run1.S.traffic.nAct >= 0.9 * 100, `${run1.S.traffic.nAct} cars`);
  assert.ok(run1.S.traffic.nAct <= 100);
  assert.equal(run1.S.tick, run1.tick, 'S.tick unchanged');
  assert.equal(run1.emitted, 0, 'no events');
  assert.equal(TLV.traffic.leadOn(run1.S, run1.lane.id, run1.s, 1000), null, 'the lane ahead of the player is clear');
  assert.equal(TLV.sim.hash(run1.S), TLV.sim.hash(run2.S), 'deterministic');
  const moved = run1.S.vehicles.filter((v) => v.active && !v.isPlayer && v.v > 0.5).length;
  assert.ok(moved > 30, 'traffic is already moving');
  assert.equal(TLV.traffic.gate.audit(run1.S), null);
});

function prewarmed() {
  const S = quietSim({ seed: 9, spawner: true, density: 100 });
  S.bus.emit = ((orig) => function (name, payload) {
    S.emitted = (S.emitted || 0) + 1;
    return orig.call(this, name, payload);
  })(S.bus.emit);
  const lane = findLane(W, (l) => l.len >= 150 && l.cls <= 2 && Math.abs(l.px[0]) < 800 && Math.abs(l.py[0]) < 800);
  const s = lane.len - 120;
  playerOn(S, lane.id, s, 0);
  const tick = S.tick;
  TLV.traffic.prewarm(S);
  return { S, lane, s, tick, emitted: S.emitted || 0 };
}

test('item 9: a despawned materialized car restores the spot, and a PARK_HOLD rival stays put until released', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.right < 0 && l.len > 120 && W.edges[l.edge].parkR > 0);
  const mid = TLV.world.lanes.pointAt(W, lane.id, lane.len / 2, {});
  const ids = [];
  TLV.world.parking.spotsNear(W, mid.x, mid.y, 60, ids);
  for (const prior of [C.OCC.PARKED, C.OCC.FREE, C.OCC.MOTO]) {
    TLV.world.parking.setState(S, ids[0], prior);
    const veh = TLV.traffic.materializeParked(S, ids[0]);
    assert.equal(veh.mode, 'PARKED');
    assert.equal(TLV.world.parking.state(S, ids[0]), C.OCC.VEHICLE);
    assert.equal(TLV.traffic.materializeParked(S, ids[0]), null, 'a stall holds one live car');
    TLV.traffic.despawn(S, veh, 'range');
    assert.equal(TLV.world.parking.state(S, ids[0]), prior);
  }
  const rival = car(S, { laneId: lane.id, s: 30, v: 7 });
  TLV.traffic.command(S, rival, { type: 'PARK_HOLD', maxS: 60 });
  runUntil(S, () => rival.v === 0, 4, 'stopping');
  const at = rival.s;
  run(S, 1200);
  assert.equal(rival.s, at);
  assert.equal(rival.beh, 'PARK_HOLD');
  TLV.traffic.release(S, rival);
  assert.equal(rival.beh, 'CRUISE');
  run(S, 120);
  assert.ok(rival.s > at + 1, 'and it drives on');
});

test('item 9: a later PARK_RACE with the same ctl resumes from COMMIT', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.right < 0 && l.len > 120 && W.edges[l.edge].parkR > 0);
  const mid = TLV.world.lanes.pointAt(W, lane.id, lane.len / 2, {});
  const ids = [];
  TLV.world.parking.spotsNear(W, mid.x, mid.y, 60, ids);
  const spot = ids.map((id) => TLV.world.parking.spot(W, id)).find((sp) => sp.laneId === lane.id);
  TLV.world.parking.setState(S, spot.id, C.OCC.FREE);
  const ctl = { speedScale: 1, mayBlink: true, holdCreep: true };
  const rival = car(S, { laneId: lane.id, s: Math.max(4, spot.laneS - 45), v: 6 });
  TLV.traffic.command(S, rival, { type: 'PARK_RACE', spotId: spot.id, ctl });
  runUntil(S, () => rival.v < 0.05 && events(S, 'traffic.parkRace', (e) => e.stage === 'CREEP').length === 1, 25, 'holding at the line');
  TLV.traffic.command(S, rival, { type: 'PARK_HOLD', maxS: 20 });
  run(S, 60);
  ctl.holdCreep = false;
  assert.equal(TLV.traffic.command(S, rival, { type: 'PARK_RACE', spotId: spot.id, ctl }), true);
  runUntil(S, () => rival.mode === 'PARKED', 8, 'parking');
  assert.equal(events(S, 'traffic.parkRace', (e) => e.stage === 'BLINK').length, 1, 'no second BLINK');
});

test('item 10: a DOUBLE_PARK on a lane with no neighbours ends within 6 s of the player arriving', () => {
  const S = quietSim();
  const lane = findLane(W, lonely);
  const veh = car(S, { laneId: lane.id, s: 60, v: 6 });
  TLV.traffic.command(S, veh, { type: 'DOUBLE_PARK', holdS: 40 });
  runUntil(S, () => veh.v === 0, 5, 'stopping');
  run(S, 120);
  assert.equal(veh.beh, 'DOUBLE_PARK', 'it holds while nobody waits');
  playerOn(S, lane.id, veh.s - 20, 0);
  const took = runUntil(S, () => veh.beh === 'CRUISE', Q.blockerS + 0.5, 'the cap');
  assert.ok(took <= Q.blockerS + 0.4, `ended after ${took} s`);
});

test('item 10: the cap holds for the other blockers, and every commanded holdS is clamped the same way', () => {
  const S = quietSim();
  const lane = findLane(W, lonely);
  playerOn(S, lane.id, 45, 0);
  const veh = car(S, { laneId: lane.id, s: 60, v: 0 });
  run(S, 3);
  TLV.traffic.command(S, veh, { type: 'PHANTOM_STOP', decel: 5, holdS: 25 });
  assert.ok(veh._t.timer <= Q.blockerS);
  TLV.traffic.command(S, veh, { type: 'CANCEL' });
  TLV.traffic.command(S, veh, { type: 'DOUBLE_PARK', holdS: 40 });
  assert.ok(veh._t.timer <= Q.blockerS);
});

test('item 10: a WRECK goes to TOWED within 6 s, in view or not, and leaves', () => {
  for (const view of [false, true]) {
    const S = quietSim();
    const lane = findLane(W, (l) => l.len >= 120);
    const veh = car(S, { laneId: lane.id, s: 80, v: 0 });
    run(S, 2);
    if (view) playerOn(S, lane.id, 40, 0);
    assert.equal(TLV.traffic.visibleToPlayer(S, veh.x, veh.y), view);
    TLV.traffic.applyImpact(S, veh, 0, 20);
    assert.equal(veh.mode, 'DYNAMIC');
    const start = S.t;
    runUntil(S, () => veh.mode === 'WRECK', Q.dynamicMaxS + 1, 'the wreck');
    assert.equal(events(S, 'traffic.wreck', (e) => e.vehId === veh.id).length, 1);
    assert.ok(veh.lights & C.VL.HAZARD);
    const wrecked = S.t;
    runUntil(S, () => veh.beh === 'TOWED', Q.wreckS + 0.1, 'the tow truck');
    assert.ok(S.t - wrecked <= Q.wreckS + 0.05);
    const id = veh.id;
    runUntil(S, () => !veh.active, Q.towS + 1, 'it leaving');
    assert.equal(events(S, 'traffic.despawn', (e) => e.vehId === id)[0].reason, 'wreck');
    assert.ok(S.t - start < 20);
    assert.equal(S.traffic.stats.wrecks, 1);
  }
});

test('a small knock keeps a car on its lane, and a car beside its lane rejoins after the slide', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 120 && l.width >= 3);
  const veh = car(S, { laneId: lane.id, s: 60, v: 5 });
  run(S, 2);
  TLV.traffic.applyImpact(S, veh, 0.5 * Math.cos(veh.h), 0.5 * Math.sin(veh.h));
  assert.equal(veh.mode, 'LANE');
  TLV.traffic.applyImpact(S, veh, 2.2 * Math.cos(veh.h + 0.3), 2.2 * Math.sin(veh.h + 0.3));
  assert.equal(veh.mode, 'DYNAMIC');
  assert.equal(veh._t.hn, 0, 'releaseAll ran');
  runUntil(S, () => veh.mode === 'LANE' || veh.mode === 'WRECK', Q.dynamicMaxS + Q.rejoinS + 1, 'the end of the slide');
  assert.equal(TLV.traffic.gate.audit(S), null);
});

test('the player on foot is braked for, and cross traffic does not yield to a player crossing at speed', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 200);
  const veh = car(S, { laneId: lane.id, s: 40, v: 10 });
  const at = TLV.world.lanes.pointAt(W, lane.id, 80, {});
  S.player.mode = 'FOOT';
  S.player.foot.x = at.x;
  S.player.foot.y = at.y;
  S.vehicles[0].laneId = -1;
  runUntil(S, () => veh.v < 0.05, 8, 'stopping');
  assert.ok(TLV.math.dist(veh.x, veh.y, at.x, at.y) > veh.length / 2);
  S.player.mode = 'DRIVE';
  const B = quietSim();
  const fast = car(B, { laneId: lane.id, s: 40, v: 10 });
  const p = B.vehicles[0];
  TLV.player.setPose(B, at.x, at.y, at.h + Math.PI / 2, 12);
  p.vx = 12 * Math.cos(p.h);
  p.vy = 12 * Math.sin(p.h);
  p.laneId = -1;
  TLV.traffic.idm.scan(B, fast);
  assert.equal(fast._t.sensorGap, Infinity, 'crossing at 12 m/s is not yielded to');
  p.vx = 0;
  p.vy = 0;
  TLV.traffic.idm.scan(B, fast);
  assert.ok(fast._t.sensorGap < 40, 'stopped there, it is');
});

test('the public queries answer for -1 and for unknown ids', () => {
  const S = quietSim();
  assert.equal(TLV.traffic.byId(S, -1), null);
  assert.equal(TLV.traffic.leadOn(S, -1, 0, 10), null);
  assert.equal(TLV.traffic.followerOf(S, null, 10), null);
  assert.equal(TLV.traffic.spawn(S, { laneId: -1, s: 0 }), null);
  assert.equal(TLV.traffic.materializeParked(S, -1), null);
  assert.equal(TLV.traffic.despawn(S, null, 'range'), undefined);
  assert.deepEqual(JSON.parse(JSON.stringify(TLV.traffic.diagnostics(S))).levels, { l2: 0, l3Despawn: 0, l3Pull: 0, l4: 0, tidy: 0 });
  run(S, 1);
  const out = [];
  const at = S.vehicles[0];
  assert.equal(TLV.traffic.vehiclesNear(S, at.x, at.y, 20, out), 1, 'the player is in the broadphase');
  assert.equal(out[0].isPlayer, true);
  parkPlayer(S, 0, 0);
  assert.equal(TLV.debug.spawnCar({ laneId: findLane(W, (l) => l.len > 100).id, s: 50 }) > 0, true);
});
