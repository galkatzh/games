// tests/traffic/behaviours.test.mjs — WP-TRAFFIC
// One scenario for each behaviour of ARCHITECTURE 10.3 on real tlv_center lanes: its trigger, its effect and its timeout exit. Each
// one asserts occ and reserved conservation through run or runUntil.
import test from 'node:test';
import {
  assert, realTLV, quietSim, run, runUntil, findLane, signalApproach, holdRed, car, playerOn, parkPlayer, events
} from './helpers.mjs';

const TLV = realTLV();
const W = TLV.world.get('tlv_center');
const C = TLV.const;
const Q = TLV.tune.traffic;
const VL = C.VL;

/** Fires the ambient rates at will, restoring them after the scenario. */
function withTune(values, fn) {
  const before = {};
  for (const key of Object.keys(values)) {
    before[key] = Q[key];
    Q[key] = values[key];
  }
  try {
    return fn();
  } finally {
    Object.assign(Q, before);
  }
}

const twoWay = (l) => l.opposite >= 0 && l.left < 0 && l.right < 0 && l.width >= 3 && l.len >= 150;
const multiLane = (l) => l.left >= 0 && l.right < 0 && l.len >= 140;
const lonely = (l) => l.left < 0 && l.right < 0 && l.opposite < 0 && l.len >= 90;

test('CRUISE: a lone car follows its lane at its desired speed, inside the lane bound', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 300 && l.vmax > 13);
  const veh = car(S, { laneId: lane.id, s: 10, v: 12, ag: 0.5 });
  const want = lane.vmax * (Q.speedBase + Q.speedAg * 0.5);
  run(S, 720);
  assert.equal(veh.beh, 'CRUISE');
  assert.ok(Math.abs(veh.v - want) < 1.5, `speed ${veh.v}, wanted about ${want}`);
  assert.ok(Math.abs(veh.lat) < 1e-9);
});

test('RED_RUN: a commanded car enters on red, takes occupancy, and returns to CRUISE when the connector clears', () => {
  const S = quietSim();
  const lane = signalApproach(W);
  const junc = holdRed(S, lane);
  const veh = car(S, { laneId: lane.id, s: lane.len - 70, v: 12, ag: 0.8 });
  assert.equal(TLV.traffic.command(S, veh, { type: 'RED_RUN' }), true);
  assert.equal(veh.beh, 'RED_RUN');
  const conn = S.world.conns[veh._t.runRed];
  runUntil(S, () => veh.mode === 'CONN', 12, 'the car entering');
  assert.equal(TLV.world.signals.connState(S, conn.id), C.SIG.RED, 'the light is red as it crosses');
  assert.equal(events(S, 'traffic.redRun', (e) => e.vehId === veh.id && e.juncId === junc).length, 1);
  assert.ok(S.traffic.occ[conn.id] > 0, 'it holds the junction, so AI on green yields');
  runUntil(S, () => veh.beh === 'CRUISE', 12, 'RED_RUN to end');
  assert.equal(S.traffic.occ[conn.id], 0);
});

test('RED_RUN: ambient late run fires at the stop decision for an aggressive car, and a timid one stops', () => {
  withTune({ redLateP: 1, redBoostMax: 1 }, () => {
    const lane = signalApproach(W);
    const S = quietSim({ seed: 3 });
    const conn = W.conns[lane.conns[0]];
    const ctrl = W.ctrls[W.juncs[conn.junc].ctrl];
    const rude = car(S, { laneId: lane.id, s: lane.len - 36, v: 13, ag: 0.9 });
    S.sig.epoch = 0;
    // The whole green is spent, so the light turns amber with the car in range.
    TLV.world.signals.alignGreen(S, conn.id, -ctrl.greenS + 0.1);
    runUntil(S, () => rude.beh === 'RED_RUN', 3, 'the late run');
    const timid = quietSim({ seed: 3 });
    const calm = car(timid, { laneId: lane.id, s: lane.len - 36, v: 13, ag: 0.3 });
    TLV.world.signals.alignGreen(timid, conn.id, -ctrl.greenS + 0.1);
    run(timid, 200);
    assert.equal(calm.beh, 'CRUISE');
    assert.equal(calm.mode, 'LANE', 'the calm driver stopped');
  });
});

test('RED_RUN: ambient jump start from the queue head just before green', () => {
  withTune({ redJumpP: 1, redBoostMax: 1 }, () => {
    const S = quietSim({ seed: 5 });
    const lane = signalApproach(W);
    const conn = W.conns[lane.conns[0]];
    const veh = car(S, { laneId: lane.id, s: lane.len - 4, v: 0, ag: 0.9 });
    TLV.world.signals.alignGreen(S, conn.id, 8);
    runUntil(S, () => veh.beh === 'RED_RUN', 8, 'the jump start');
    assert.ok(TLV.world.signals.timeToGreen(S, conn.id) < Q.redJumpS + 0.3);
    runUntil(S, () => events(S, 'traffic.redRun').length > 0, 5, 'crossing on red');
  });
});

test('TAILGATE: fires behind the player, holds close with high beams and the horn, and ends on its timer', () => {
  withTune({ tailMinS: 3, tailMaxS: 3, tailDiveLastS: 0 }, () => {
    const S = quietSim();
    const lane = findLane(W, (l) => l.len >= 220 && l.vmax > 13);
    const veh = car(S, { laneId: lane.id, s: 20, v: 10, ag: 0.8 });
    let s = 45;
    const drive = () => {
      s += 10 * C.DT;
      playerOn(S, lane.id, s, 10);
    };
    playerOn(S, lane.id, s, 10);
    runUntil(S, () => {
      drive();
      return veh.beh === 'TAILGATE';
    }, 4, 'TAILGATE');
    assert.ok(veh.lights & VL.HIGH_BEAM, 'high beams');
    const gap = () => s - S.vehicles[0].length / 2 - veh.s - veh.length / 2;
    assert.ok(gap() > Q.tailCloseM, 'it starts well back');
    runUntil(S, () => {
      drive();
      return gap() <= Q.tailCloseM;
    }, 5, 'closing to 5 m');
    assert.equal(veh.beh, 'TAILGATE', 'the clock does not run while it closes');
    runUntil(S, () => {
      drive();
      return veh.beh === 'CRUISE';
    }, 4, 'the timeout');
    assert.ok(events(S, 'traffic.honk', (e) => e.vehId === veh.id && e.atPlayer).length >= 1, 'horn aimed at the player');
    assert.ok(!(veh.lights & VL.HIGH_BEAM));
  });
});

test('TAILGATE: its clock stands while it is held at a red behind the player, and it gives up if it cannot close', () => {
  withTune({ tailDiveLastS: 0 }, () => {
    const S = quietSim();
    const lane = findLane(W, (l) => l.len >= 220 && l.vmax > 13);
    const veh = car(S, { laneId: lane.id, s: 20, v: 0, ag: 0.8 });
    playerOn(S, lane.id, 45, 0);
    assert.equal(TLV.traffic.command(S, veh, { type: 'TAILGATE', durS: 2, targetId: 0 }), true);
    runUntil(S, () => veh.v > 0 && veh._t.tailClosed, 12, 'it closes on a stopped player');
    run(S, 60 * 6);
    assert.equal(veh.beh, 'TAILGATE', 'six seconds stopped behind him spend none of a two second clock');
    const far = quietSim();
    const gone = car(far, { laneId: lane.id, s: 20, v: 8, ag: 0.8 });
    assert.equal(TLV.traffic.command(far, gone, { type: 'TAILGATE', durS: 8, targetId: 0 }), true);
    // The player stays over the despawn line of any tailgater: it never closes, and the episode has a limit.
    parkPlayer(far, -2000, -2700);
    runUntil(far, () => gone.beh !== 'TAILGATE', 2, 'the car giving up');
  });
});

test('TAILGATE: near the end of its clock a car on a road with room goes past the player', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 300 && l.vmax > 13 && l.left >= 0);
  const veh = car(S, { laneId: lane.id, s: 30, v: 8, ag: 0.8 });
  let s = 40;
  const drive = () => {
    s += 8 * C.DT;
    playerOn(S, lane.id, s, 8);
  };
  playerOn(S, lane.id, s, 8);
  assert.equal(TLV.traffic.command(S, veh, { type: 'TAILGATE', durS: 3, targetId: 0 }), true);
  runUntil(S, () => {
    drive();
    return veh.beh === 'OVERTAKE_OUT';
  }, 6, 'the pass');
  assert.equal(veh._t.ovFast, true);
  runUntil(S, () => {
    drive();
    return veh.beh === 'CUT_IN';
  }, 9, 'the cut back in');
  const ahead = veh.s - s;
  assert.ok(ahead > 0, 'it cut in ahead of him');
  assert.ok(ahead - veh.length / 2 - S.vehicles[0].length / 2 < 8 * 0.8 + 3, `close ahead: ${ahead.toFixed(1)} m centre to centre`);
});

test('TAILGATE: ends when the player leaves the lane', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 220 && l.vmax > 13);
  const veh = car(S, { laneId: lane.id, s: 20, v: 10, ag: 0.8 });
  playerOn(S, lane.id, 45, 0);
  runUntil(S, () => veh.beh === 'TAILGATE', 3, 'TAILGATE');
  parkPlayer(S, -2000, -2700);
  runUntil(S, () => veh.beh === 'CRUISE', 2, 'the car giving up');
});

test('NOSE_IN: a side-road car takes the junction ahead of a granted main-road car, which brakes at -5 or less', () => {
  const S = quietSim({ seed: 2 });
  const side = findLane(W, (l) => {
    if (l.cls < 3 || l.conns.length !== 1 || l.len < 30) return false;
    const c = W.conns[l.conns[0]];
    if (W.juncs[c.junc].kind !== 'PRIORITY' || W.lanes[c.to].cls > 2 || !c.conflicts.length) return false;
    return c.conflicts.some((x) => {
      const o = W.conns[x];
      return W.lanes[o.from].cls <= 2 && o.turn === 'S' && W.lanes[o.from].len > 90 && (W.lanes[o.from].flags & 1);
    });
  });
  const conn = W.conns[side.conns[0]];
  const mainConn = W.conns[Array.from(conn.conflicts).find((x) => W.lanes[W.conns[x].from].cls <= 2 && W.conns[x].turn === 'S' && W.lanes[W.conns[x].from].len > 90)];
  const main = W.lanes[mainConn.from];
  // The main road car comes first, and holds a grant from 40 m out, as it would on a busy road.
  const follower = car(S, { laneId: main.id, s: main.len - 38, v: 13, ag: 0.5 });
  follower._t.pn = 0;
  follower._t.pg = 0;
  follower._t.plan[0] = mainConn.id;
  follower._t.pn = 1;
  TLV.traffic.gate.extend(S, follower);
  run(S, 8);
  assert.ok(S.traffic.occ[mainConn.id] > 0, 'the main road car holds its grant');
  const nudger = car(S, { laneId: side.id, s: side.len - 5, v: 0, ag: 0.9 });
  nudger._t.pn = 0;
  nudger._t.pg = 0;
  nudger._t.plan[0] = conn.id;
  nudger._t.pn = 1;
  TLV.traffic.gate.extend(S, nudger);
  let hardest = 0;
  runUntil(S, () => {
    hardest = Math.min(hardest, follower.accel);
    return nudger.beh === 'NOSE_IN';
  }, 8, 'NOSE_IN');
  const gap = TLV.traffic.gate.noseTo(S, follower, 0) / follower.v;
  assert.ok(gap < 3, `gap ${gap} s, far under a normal 3-4 s`);
  assert.ok(gap >= 0.5);
  assert.equal(S.traffic.occ[mainConn.id], 0, 'the main road car lost its grant');
  runUntil(S, () => {
    hardest = Math.min(hardest, follower.accel);
    return nudger.beh === 'CRUISE';
  }, Q.noseTimeoutS, 'NOSE_IN to end');
  assert.ok(follower.v < 13, 'the follower had to slow down');
  assert.ok(hardest >= -Q.hardBrake, `braking ${hardest}`);
});

test('NOSE_IN: the command forces a merge into a named lane at a gap no normal driver takes, and the follower is capped at -5', () => {
  const S = quietSim();
  const lane = findLane(W, multiLane);
  const veh = car(S, { laneId: lane.id, s: 60, v: 8, ag: 0.5 });
  const behind = car(S, { laneId: lane.left, s: 48, v: 9, ag: 0.5 });
  run(S, 2);
  // Row 14: bumper to bumper along the road, in seconds at the follower's speed.
  const gapS = () => (((veh.x - behind.x) * Math.cos(veh.h) + (veh.y - behind.y) * Math.sin(veh.h)) - veh.length / 2 - behind.length / 2) / Math.max(behind.v, 0.1);
  const accepted = gapS();
  assert.equal(TLV.traffic.command(S, veh, { type: 'NOSE_IN', targetLaneId: lane.left }), true);
  assert.equal(veh.beh, 'NOSE_IN');
  assert.ok(accepted > 0 && accepted < 1.5, `merge accepted at a gap of ${accepted} s`);
  run(S, 12);
  assert.equal(veh.beh, 'NOSE_IN', 'it lasts the whole change');
  let hardest = 0;
  let tightest = accepted;
  runUntil(S, () => {
    hardest = Math.min(hardest, behind.accel);
    tightest = Math.min(tightest, gapS());
    return veh.beh === 'CRUISE';
  }, 5, 'the merge');
  assert.equal(veh.laneId, lane.left);
  assert.ok(Math.abs(veh.lat) < 0.1);
  assert.ok(hardest < 0 && hardest >= -Q.noseFollowBrake - 1e-9, `the follower braked at ${hardest}`);
  assert.ok(tightest > 0 && tightest < 1.5, `the gap through the merge fell to ${tightest} s and they never touched`);
});

test('NOSE_IN: the command at a junction waits for its grant and lasts through the connector', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len > 60 && l.conns.length === 1 && W.conns[l.conns[0]].px.length > 2 && W.conns[l.conns[0]].slot < 0);
  const veh = car(S, { laneId: lane.id, s: lane.len - 40, v: 6, ag: 0.4 });
  assert.equal(TLV.traffic.command(S, veh, { type: 'NOSE_IN' }), true);
  const c = veh._t.noseConn;
  assert.equal(c, lane.conns[0]);
  run(S, 60);
  assert.equal(veh.beh, 'NOSE_IN', 'still on its way to the junction');
  runUntil(S, () => veh.mode === 'CONN', 10, 'the junction');
  assert.equal(veh.beh, 'NOSE_IN');
  runUntil(S, () => veh.beh === 'CRUISE', 8, 'the end');
  assert.equal(S.traffic.occ[c], 0);
});

test('OVERTAKE: on a multi-lane road it weaves round through the next lane, and cuts back in front', () => {
  const S = quietSim({ seed: 2 });
  const lane = findLane(W, (l) => multiLane(l) && l.len >= 200);
  const slow = car(S, { laneId: lane.id, s: 70, v: 5, ag: 0.1 });
  slow._t.capV = 5;
  const veh = car(S, { laneId: lane.id, s: 48, v: 8, ag: 0.9 });
  const beh = [];
  S.bus.on('traffic.behaviour', (e) => { if (e.vehId === veh.id) beh.push(e.beh); });
  runUntil(S, () => beh.includes('CRUISE'), 30, 'the whole overtake');
  assert.deepEqual(beh.slice(0, 4), ['OVERTAKE_OUT', 'OVERTAKE_PASS', 'CUT_IN', 'CRUISE']);
  assert.equal(veh.laneId, lane.id, 'back on its lane');
  assert.ok(veh.s > slow.s, 'ahead of the car it passed');
});

test('OVERTAKE: out, pass and cut in through the opposite lane, at a lateral gap under 1 m and a headway under 0.8 s', () => {
  const S = quietSim({ seed: 4 });
  const lane = findLane(W, (l) => twoWay(l) && l.len >= 200 && W.lanes[l.opposite].flags & 1);
  const slow = car(S, { laneId: lane.id, s: 90, v: 5, ag: 0.1 });
  slow._t.capV = 5;
  const veh = car(S, { laneId: lane.id, s: 60, v: 8, ag: 0.9 });
  const beh = [];
  S.bus.on('traffic.behaviour', (e) => { if (e.vehId === veh.id) beh.push(e.beh); });
  let lateral = Infinity;
  let cutHeadway = Infinity;
  runUntil(S, () => {
    if (veh.beh === 'OVERTAKE_PASS' || veh.beh === 'CUT_IN') {
      const beside = Math.abs((veh.x - slow.x) * Math.cos(slow.h) + (veh.y - slow.y) * Math.sin(slow.h)) < veh.length;
      if (beside) lateral = Math.min(lateral, Math.abs(veh.lat - slow.lat) - veh.width / 2 - slow.width / 2);
    }
    if (veh.beh === 'CUT_IN' && cutHeadway === Infinity) {
      const gap = veh.s - veh.length / 2 - slow.s - slow.length / 2;
      cutHeadway = gap / slow.v;
    }
    return beh.includes('CRUISE') && beh.length >= 3;
  }, 25, 'the whole overtake');
  assert.deepEqual(beh.slice(0, 4), ['OVERTAKE_OUT', 'OVERTAKE_PASS', 'CUT_IN', 'CRUISE']);
  assert.ok(lateral < 1, `lateral gap ${lateral}`);
  assert.ok(cutHeadway < 0.8, `cut-in headway ${cutHeadway}`);
  assert.ok(veh.s > slow.s, 'it is ahead');
  assert.ok(Math.abs(veh.lat) < 0.1, 'back on its lane');
});

test('OVERTAKE: aborts when an oncoming car comes within 2 s', () => {
  const S = quietSim({ seed: 4 });
  const lane = findLane(W, (l) => twoWay(l) && l.len >= 200 && W.lanes[l.opposite].flags & 1);
  const slow = car(S, { laneId: lane.id, s: 60, v: 5, ag: 0.1 });
  slow._t.capV = 5;
  const veh = car(S, { laneId: lane.id, s: 35, v: 7, ag: 0.9 });
  runUntil(S, () => veh.beh === 'OVERTAKE_OUT', 8, 'the overtake');
  const opp = W.lanes[lane.opposite];
  const coming = TLV.math.polyProject(opp.px, opp.py, opp.cum, veh.x, veh.y, -1, {}).s - 32;
  car(S, { laneId: opp.id, s: coming, v: 12, ag: 0.5 });
  runUntil(S, () => veh.beh === 'CUT_IN' || veh.beh === 'CRUISE', 4, 'the abort');
  runUntil(S, () => veh.beh === 'CRUISE', Q.overTimeoutS + 1, 'the car back on its lane');
  assert.ok(Math.abs(veh.lat) < 1.5);
});

test('PHANTOM_STOP: fires by chance, brakes at 4-7 m/s2 with nothing ahead, holds, and resumes', () => {
  withTune({ phantomRate: 6000, phantomMinS: 2, phantomMaxS: 2 }, () => {
    const S = quietSim();
    const lane = findLane(W, (l) => l.len >= 150 && !l.stops.length);
    const veh = car(S, { laneId: lane.id, s: 30, v: 12, ag: 0.5 });
    runUntil(S, () => veh.beh === 'PHANTOM_STOP', 2, 'PHANTOM_STOP');
    assert.ok(veh._t.forceA <= -Q.phantomBrakeMin && veh._t.forceA >= -Q.phantomBrakeMax);
    let hardest = 0;
    let dark = 0;
    runUntil(S, () => {
      hardest = Math.min(hardest, veh.accel);
      if (veh.accel <= -Q.phantomBrakeMin + 0.01 && !(veh.lights & VL.BRAKE)) dark++;
      return veh.v === 0;
    }, 4, 'stopping');
    assert.ok(hardest <= -Q.phantomBrakeMin + 0.01 && hardest >= -Q.phantomBrakeMax - 0.01, `braking ${hardest}`);
    assert.equal(dark, 0, 'brake lights on through the whole stop (GAME_DESIGN 9)');
    const stoppedAt = S.t;
    runUntil(S, () => {
      if (veh.beh === 'PHANTOM_STOP' && !(veh.lights & VL.BRAKE)) dark++;
      return veh.beh === 'CRUISE';
    }, 5, 'the exit');
    assert.equal(dark, 0, 'and for as long as it sits in the lane');
    assert.ok(S.t - stoppedAt >= 1.7);
    veh._t.duePhantom = Infinity;
    run(S, 120);
    assert.ok(veh.v > 1, 'it drives off');
    assert.ok(!(veh.lights & VL.BRAKE), 'with the lights out');
  });
});

test('brake lights: a steady car shows none, a car stopping for a red shows them, and they hold while it waits', () => {
  const S = quietSim();
  const lane = signalApproach(W);
  holdRed(S, lane);
  const veh = car(S, { laneId: lane.id, s: Math.max(5, lane.len - 90), v: 8, ag: 0.5 });
  veh._t.capV = 8;
  run(S, 30);
  assert.ok(Math.abs(veh.accel) < Q.brakeLightOff, `steady, accel ${veh.accel}`);
  assert.ok(!(veh.lights & VL.BRAKE), 'no brake lights at a steady speed');
  veh._t.capV = Infinity;
  runUntil(S, () => veh.lights & VL.BRAKE, 12, 'the lights');
  assert.ok(veh.v > Q.stationaryV, 'on before it has stopped');
  assert.ok(veh.accel < 0);
  // IDM ends a stop in a long creep, which slows by too little to light them. They must not go out for it.
  let dark = 0;
  runUntil(S, () => {
    if (!(veh.lights & VL.BRAKE)) dark++;
    return veh.v < 0.1;
  }, 14, 'the stop');
  run(S, 60, () => { if (!(veh.lights & VL.BRAKE)) dark++; });
  assert.equal(dark, 0, 'on all the way down and while it waits');
});

test('brake lights: only that bit changes, so a blinker or hazards set by a behaviour survive it', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 150 && !l.stops.length);
  const veh = car(S, { laneId: lane.id, s: 30, v: 10, ag: 0.5 });
  veh.lights |= VL.BLINK_L | VL.HIGH_BEAM;
  assert.equal(TLV.traffic.command(S, veh, { type: 'DOUBLE_PARK', holdS: 4 }), true);
  veh.lights |= VL.BLINK_L;
  runUntil(S, () => veh.lights & VL.BRAKE, 1, 'braking');
  assert.ok(veh.lights & VL.HAZARD, 'hazards stay on with the brake lights');
  assert.ok(veh.lights & VL.BLINK_L, 'and so does a blinker');
  runUntil(S, () => veh.v === 0, 6, 'the stop');
  run(S, 12);
  assert.ok(!(veh.lights & VL.BRAKE), 'double-parked, the driver has gone, and nobody is on the pedal');
  assert.ok(veh.lights & VL.HAZARD);
});

test('brake lights: none on a car backing up at speed, on a parked car, or on a car with no driver at the wheel', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 150 && !l.stops.length);
  const veh = car(S, { laneId: lane.id, s: 100, v: 0, ag: 0.5 });
  assert.equal(TLV.traffic.command(S, veh, { type: 'REVERSE_FOR_SPOT', distM: 30 }), true);
  runUntil(S, () => veh.v < -Q.reverseSpeed * 0.9, 5, 'backing');
  assert.ok(veh.lights & VL.REVERSE);
  assert.ok(!(veh.lights & VL.BRAKE), 'speeding up backward is not braking');
  runUntil(S, () => veh.beh === 'CRUISE', 14, 'the end of it');

  const ids = [];
  TLV.world.parking.spotsNear(W, veh.x, veh.y, 80, ids);
  const parked = TLV.traffic.materializeParked(S, ids[0]);
  run(S, 30);
  assert.equal(parked.mode, 'PARKED');
  assert.ok(!(parked.lights & VL.BRAKE));

  const hit = car(S, { laneId: lane.id, s: 20, v: 0, ag: 0.5 });
  run(S, 6);
  hit.lights |= VL.BRAKE;
  TLV.traffic.applyImpact(S, hit, 0, 12);
  assert.equal(hit.mode, 'DYNAMIC');
  run(S, 1);
  assert.ok(!(hit.lights & VL.BRAKE), 'a car knocked loose has no foot on anything');
});

test('PHANTOM_STOP: never within 15 m of a junction, on an exclusive lane, and capped at 2', () => {
  withTune({ phantomRate: 6000 }, () => {
    const S = quietSim();
    const lane = findLane(W, (l) => l.len >= 150);
    const near = car(S, { laneId: lane.id, s: lane.len - 16, v: 6 });
    run(S, 60);
    assert.notEqual(near.beh, 'PHANTOM_STOP', 'too close to the junction');
    const other = quietSim({ seed: 2 });
    const lanes = W.lanes.filter((l) => (l.flags & 1) && l.len > 120).slice(0, 5).map((l) => car(other, { laneId: l.id, s: 30, v: 10 }));
    run(other, 24);
    assert.equal(lanes.filter((v) => v.beh === 'PHANTOM_STOP').length, Q.phantomMax);
  });
});

test('DROP_APPROACH, DROPPED, PULLOUT: half out of the lane, hazards before the stop, door on the traffic side, a passenger, then out', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.right < 0 && l.len >= 160 && l.width >= 3 && !l.stops.length);
  const veh = car(S, { laneId: lane.id, s: 40, v: 10, ag: 0.6 });
  assert.equal(TLV.traffic.command(S, veh, { type: 'DROP_OFF', holdS: 3, door: 'traffic', passenger: true }), true);
  assert.equal(veh.beh, 'DROP_APPROACH');
  let hazardLead = 0;
  runUntil(S, () => {
    if ((veh.lights & VL.HAZARD) && veh.v > 0.2) hazardLead += C.DT;
    return veh.beh === 'DROPPED';
  }, 12, 'the stop');
  assert.ok(hazardLead >= 0.5, `hazards ${hazardLead} s before stopping`);
  assert.ok(veh.lat < -0.3, 'pulled toward the kerb');
  assert.ok(Math.abs(veh.lat) + veh.width / 2 > lane.width / 2 - 0.2, 'at the edge of its lane');
  runUntil(S, () => veh.door === 1, 2, 'the door');
  assert.equal(events(S, 'traffic.door', (e) => e.vehId === veh.id && e.open).length, 1);
  const spec = S.pedsys.spawned[0];
  assert.equal(spec.kind, 'passenger');
  assert.equal(spec.state, 'DROPPED');
  const side = (spec.x - veh.x) * -Math.sin(veh.h) + (spec.y - veh.y) * Math.cos(veh.h);
  assert.ok(side > 0, 'the passenger gets out on the traffic side');
  runUntil(S, () => veh.beh === 'PULLOUT', 4, 'the end of the stop');
  assert.equal(veh.door, 0);
  assert.ok(!(veh.lights & VL.HAZARD));
  runUntil(S, () => veh.beh === 'NOSE_IN', 7, 'the merge');
  runUntil(S, () => veh.beh === 'CRUISE', 6, 'CRUISE');
  assert.ok(Math.abs(veh.lat) < 0.2);
});

test('BUS_APPROACH, BUS_STOPPED, BUS_PULLOUT: a bus takes the stop on its lane, half out, and leaves with no blinker', () => {
  withTune({ busStopMinS: 2, busStopMaxS: 2 }, () => {
    const S = quietSim();
    const stopAt = (l) => TLV.math.polyProject(l.px, l.py, l.cum, W.stops[l.stops[0]].x, W.stops[l.stops[0]].y, -1, {}).s;
    const lane = W.lanes.find((l) => l.stops.length === 1 && (l.flags & 1) && l.right < 0 && l.left < 0 && l.width >= 3 && !(l.flags & 2) &&
      stopAt(l) > 45 && l.len - stopAt(l) > 15);
    const at = stopAt(lane);
    const bus = car(S, { laneId: lane.id, s: at - 30, v: 6, kind: 'bus', ag: 0.5 });
    runUntil(S, () => bus.beh === 'BUS_APPROACH', 2, 'BUS_APPROACH');
    runUntil(S, () => bus.beh === 'BUS_STOPPED', 16, 'BUS_STOPPED');
    assert.ok(Math.abs(bus.s - at) < 3, 'at the stop');
    assert.ok(bus.lat < -0.1, 'out of the lane');
    runUntil(S, () => bus.beh === 'BUS_PULLOUT', 3, 'BUS_PULLOUT');
    assert.equal(bus.lights & (VL.BLINK_L | VL.BLINK_R), 0, 'no blinker: it is the bus');
    runUntil(S, () => bus.beh === 'CRUISE', 8, 'CRUISE');
    assert.ok(Math.abs(bus.lat) < 0.2);
  });
});

test('DOUBLE_PARK: hazards, stands in the lane, then leaves on its timer', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 150);
  const veh = car(S, { laneId: lane.id, s: 30, v: 10 });
  assert.equal(TLV.traffic.command(S, veh, { type: 'DOUBLE_PARK', holdS: 2 }), true);
  assert.equal(veh.beh, 'DOUBLE_PARK');
  assert.ok(veh.lights & VL.HAZARD);
  runUntil(S, () => veh.v === 0, 5, 'stopping');
  runUntil(S, () => veh.beh === 'CRUISE', 4, 'the exit');
  assert.ok(!(veh.lights & VL.HAZARD));
});

test('REVERSE_FOR_SPOT: backs down the lane the given distance with reverse lights, then cruises', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 120);
  const veh = car(S, { laneId: lane.id, s: 70, v: 0 });
  run(S, 2);
  const from = veh.s;
  assert.equal(TLV.traffic.command(S, veh, { type: 'REVERSE_FOR_SPOT', distM: 20 }), true);
  assert.ok(veh.lights & VL.REVERSE);
  runUntil(S, () => veh.v < -1, 2, 'moving backward');
  runUntil(S, () => veh.beh === 'CRUISE', 15, 'the exit');
  assert.ok(Math.abs(from - veh.s - 20) < 2.5, `backed ${from - veh.s} m`);
  assert.ok(!(veh.lights & VL.REVERSE));
  run(S, 120);
  assert.ok(veh.v > 0.5, 'and it drives on');
});

test('REVERSE_FOR_SPOT: with an aim it backs at the speed that meets it', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 120);
  const veh = car(S, { laneId: lane.id, s: 80, v: 0 });
  run(S, 2);
  const at = TLV.world.lanes.pointAt(W, lane.id, 70, {});
  const aim = { x: at.x, y: at.y, tImpact: S.t + 5, frozen: false };
  TLV.traffic.command(S, veh, { type: 'REVERSE_FOR_SPOT', distM: 30, aim });
  run(S, 120);
  assert.ok(veh.v < -1.5 && veh.v > -2.6, `speed ${veh.v}, about 2 m/s to make 10 m in 5 s`);
  aim.tImpact = S.t + 0.5;
  run(S, 12);
  assert.ok(veh.v < -2.6, 'the caller moved the aim, and the car took it up');
});

test('REVERSE_FOR_SPOT: stops short of a car behind it', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 120);
  const behind = car(S, { laneId: lane.id, s: 60, v: 0 });
  behind._t.capV = 0;
  const veh = car(S, { laneId: lane.id, s: 80, v: 0 });
  run(S, 2);
  TLV.traffic.command(S, veh, { type: 'REVERSE_FOR_SPOT', distM: 30 });
  run(S, 600);
  assert.ok(veh.s - veh.length / 2 - (behind.s + behind.length / 2) > 0.5);
});

/** A materialized parked car on a stall with a clear lane. */
function parkedCar(S) {
  const ids = [];
  const lane = findLane(W, (l) => l.right < 0 && l.len > 120 && W.edges[l.edge].parkR > 0);
  const mid = TLV.world.lanes.pointAt(W, lane.id, lane.len / 2, {});
  TLV.world.parking.spotsNear(W, mid.x, mid.y, 60, ids);
  const spot = ids.map((id) => TLV.world.parking.spot(W, id)).find((s) => s.laneId === lane.id);
  const veh = TLV.traffic.materializeParked(S, spot.id);
  assert.ok(veh);
  return { veh, spot, lane };
}

test('DOOR_OPEN: needs a parked car, opens on the asked side, closes on its timer', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 120);
  const moving = car(S, { laneId: lane.id, s: 40, v: 5 });
  assert.equal(TLV.traffic.command(S, moving, { type: 'DOOR_OPEN', side: 'traffic', holdS: 2 }), false);
  const { veh } = parkedCar(S);
  assert.equal(TLV.traffic.command(S, veh, { type: 'DOOR_OPEN', side: 'traffic', holdS: 1 }), true);
  assert.equal(veh.door, 1);
  assert.equal(veh.beh, 'DOOR_OPEN');
  runUntil(S, () => veh.door === 0, 2, 'the door closing');
  assert.equal(veh.beh, 'CRUISE');
  assert.equal(events(S, 'traffic.door', (e) => e.vehId === veh.id).map((e) => e.open).join(), 'true,false');
});

test('PULLOUT: a parked car signals, leaves through NOSE_IN, and frees its stall once clear', () => {
  const S = quietSim();
  const { veh, spot, lane } = parkedCar(S);
  assert.equal(TLV.traffic.command(S, veh, { type: 'PULLOUT' }), true);
  assert.equal(veh.beh, 'PULLOUT');
  assert.ok(veh.lights & (VL.BLINK_L | VL.BLINK_R), 'signalling');
  assert.equal(TLV.world.parking.state(S, spot.id), C.OCC.VEHICLE);
  runUntil(S, () => veh.mode === 'LANE', 6, 'the lane');
  assert.equal(veh.laneId, lane.id);
  assert.equal(TLV.world.parking.state(S, spot.id), C.OCC.FREE);
  assert.equal(veh.beh, 'NOSE_IN');
  runUntil(S, () => veh.beh === 'CRUISE', 3, 'CRUISE');
  run(S, 60);
  assert.ok(veh.v > 0.5);
});

test('PARK_RACE: BLINK, CREEP, COMMIT and IN_SPOT, in order, with the stall taken at the last', () => {
  const S = quietSim();
  const { spot, lane } = parkedCar(S);
  const rival = car(S, { laneId: lane.id, s: 8, v: 8, ag: 0.7 });
  TLV.traffic.despawn(S, TLV.traffic.byId(S, S.log.find(([n]) => n === 'traffic.spawn')[1].vehId), 'script');
  TLV.world.parking.setState(S, spot.id, C.OCC.FREE);
  const ctl = { speedScale: 1, mayBlink: true, holdCreep: false };
  assert.equal(TLV.traffic.command(S, rival, { type: 'PARK_RACE', spotId: spot.id, ctl }), true);
  assert.equal(rival.beh, 'PARK_RACE');
  runUntil(S, () => rival.mode === 'PARKED', 40, 'parking');
  const stages = events(S, 'traffic.parkRace', (e) => e.vehId === rival.id).map((e) => e.stage);
  assert.deepEqual(stages, ['BLINK', 'CREEP', 'COMMIT', 'IN_SPOT']);
  assert.equal(TLV.world.parking.state(S, spot.id), C.OCC.VEHICLE);
  assert.ok(TLV.math.dist(rival.x, rival.y, spot.x, spot.y) < 0.2);
  assert.equal(rival.beh, 'CRUISE');
  TLV.traffic.despawn(S, rival, 'script');
  assert.equal(TLV.world.parking.state(S, spot.id), C.OCC.PARKED, 'a rival who won becomes a static car');
});

test('PARK_RACE: times out at 60 s with FAILED', () => {
  const S = quietSim();
  const { spot, lane } = parkedCar(S);
  const rival = car(S, { laneId: lane.id, s: 8, v: 0 });
  TLV.traffic.command(S, rival, { type: 'PARK_RACE', spotId: spot.id, ctl: { speedScale: 0.5, mayBlink: false, holdCreep: false } });
  runUntil(S, () => rival.beh === 'CRUISE', Q.parkRaceMaxS + 2, 'the timeout');
  assert.equal(events(S, 'traffic.parkRace', (e) => e.stage === 'FAILED').length, 1);
  assert.ok(!(rival.lights & (VL.BLINK_L | VL.BLINK_R)));
});

test('PARK_HOLD: stops in the lane, blinker on, and goes back to CRUISE after maxS', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 120);
  const veh = car(S, { laneId: lane.id, s: 30, v: 8 });
  assert.equal(TLV.traffic.command(S, veh, { type: 'PARK_HOLD', maxS: 3 }), true);
  assert.equal(veh.beh, 'PARK_HOLD');
  runUntil(S, () => veh.v === 0, 3, 'stopping');
  const held = veh.s;
  assert.ok(veh.lights & (VL.BLINK_L | VL.BLINK_R));
  run(S, 60);
  assert.equal(veh.s, held, 'it stays put');
  assert.equal(veh.beh, 'PARK_HOLD');
  runUntil(S, () => veh.beh === 'CRUISE', 3, 'the exit');
});

test('RIVAL_BLOCK: stops, sounds the horn, says it in symbols, and leaves on its timer', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 120);
  const veh = car(S, { laneId: lane.id, s: 30, v: 8 });
  assert.equal(TLV.traffic.command(S, veh, { type: 'RIVAL_BLOCK', holdS: 2 }), true);
  runUntil(S, () => veh.horn, 4, 'the horn');
  assert.equal(events(S, 'bubble', (e) => e.who === 'veh' && e.id === veh.id).length, 1);
  assert.ok(/^[^a-zA-Z]+$/.test(events(S, 'bubble')[0].text), 'symbols only');
  runUntil(S, () => veh.beh === 'CRUISE', 3, 'the exit');
  assert.equal(veh.horn, false);
});

test('RIVAL_STANDOFF: blends to the pose, opens the door, and holds until TOWED, then despawns', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 120);
  const veh = car(S, { laneId: lane.id, s: 30, v: 0 });
  const at = TLV.world.lanes.pointAt(W, lane.id, 42, {});
  assert.equal(TLV.traffic.command(S, veh, { type: 'RIVAL_STANDOFF', x: at.x, y: at.y, h: at.h + 0.7, durS: 1 }), true);
  assert.equal(veh.mode, 'SCRIPT');
  runUntil(S, () => veh.door === 1, 1.5, 'the door');
  assert.ok(TLV.math.dist(veh.x, veh.y, at.x, at.y) < 0.01);
  run(S, 120);
  assert.equal(veh.beh, 'RIVAL_STANDOFF', 'it holds');
  assert.equal(TLV.traffic.command(S, veh, { type: 'TOWED' }), true);
  assert.equal(veh.beh, 'TOWED');
  const id = veh.id;
  runUntil(S, () => !veh.active || veh.id !== id, Q.towS + 1, 'the tow');
  assert.equal(events(S, 'traffic.despawn', (e) => e.vehId === id)[0].reason, 'script');
});

test('TOWED: a tow never touches the player standing in its way: it waits, and goes once the way is clear', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 120);
  const veh = car(S, { laneId: lane.id, s: 30, v: 0 });
  // Bumper to bumper, as a car that has just rear-ended the player stands.
  playerOn(S, lane.id, 30 + veh.length / 2 + S.player.veh.length / 2 + 0.3);
  const contacts = [];
  S.bus.on('player.contact', (c) => contacts.push(c));
  const id = veh.id;
  assert.equal(TLV.traffic.command(S, veh, { type: 'TOWED' }), true);
  run(S, 60 * (Q.towS + 2));
  assert.equal(contacts.length, 0, 'no second charge');
  assert.ok(veh.active && veh.id === id, 'still waiting behind the player');
  assert.ok(TLV.math.obbGap(veh, S.player.veh) > 0, 'and not overlapping');
  playerOn(S, lane.id, lane.len - 10);
  runUntil(S, () => !veh.active || veh.id !== id, Q.towS + 1, 'the tow');
  assert.equal(events(S, 'traffic.despawn', (e) => e.vehId === id)[0].reason, 'script');
});

test('TOWED: a player who never moves does not hold a wreck in the lane for ever', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 120);
  const veh = car(S, { laneId: lane.id, s: 30, v: 0 });
  playerOn(S, lane.id, 30 + veh.length / 2 + S.player.veh.length / 2 + 0.3);
  const contacts = [];
  S.bus.on('player.contact', (c) => contacts.push(c));
  const id = veh.id;
  assert.equal(TLV.traffic.command(S, veh, { type: 'TOWED' }), true);
  runUntil(S, () => !veh.active || veh.id !== id, Q.towWaitS + 1, 'the tow gives up');
  assert.equal(contacts.length, 0);
});

test('RIVAL_STANDOFF: gives up after 60 s', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 120);
  const veh = car(S, { laneId: lane.id, s: 30, v: 0 });
  const at = TLV.world.lanes.pointAt(W, lane.id, 42, {});
  TLV.traffic.command(S, veh, { type: 'RIVAL_STANDOFF', x: at.x, y: at.y, h: at.h, durS: 1 });
  runUntil(S, () => veh.beh === 'CRUISE', Q.standoffMaxS + 1, 'the timeout');
});

test('PULL_OVER: the watchdog takes a stuck car in view off the lists at once, and it leaves', () => {
  const S = quietSim();
  const lane = signalApproach(W);
  holdRed(S, lane);
  const veh = car(S, { laneId: lane.id, s: lane.len - 4, v: 0 });
  run(S, 240);
  const ahead = TLV.world.lanes.pointAt(W, lane.id, lane.len - 45, {});
  TLV.player.setPose(S, ahead.x, ahead.y, ahead.h, 0);
  run(S, 2);
  assert.ok(TLV.traffic.visibleToPlayer(S, veh.x, veh.y));
  veh.stuckT = TLV.traffic.deadlock.watchdog(S, veh) + 1;
  const id = veh.id;
  run(S, 15);
  assert.equal(veh.beh, 'PULL_OVER');
  assert.equal(veh.mode, 'SCRIPT');
  assert.ok(veh.lights & VL.HAZARD);
  assert.equal(TLV.traffic.leadOn(S, lane.id, 0, lane.len), null, 'off the lane lists');
  runUntil(S, () => !veh.active || veh.id !== id, Q.pullOverMaxS * 2 + 1, 'leaving');
});
