// tests/game/parking.test.mjs — WP-GAME
// ARCHITECTURE 19 item 3 on tlv_center: capture at each quality by scripted controls from lane centre, the limits, cancel in each
// stage, the Q options and the inspector. Stalls are the real bays a run binds, with their neighbours parked.
import test from 'node:test';
import { assert, realTLV, sim, step, until, toDrive, events, bayOf, inBay, atLaneCentre, parker, hold } from './helpers.mjs';

const TLV = realTLV();
const W = TLV.world.get('tlv_center');
const T = TLV.tune.game;
const OCC = TLV.const.OCC;

/** A run on some errand, in DRIVE, the car on lane centre short of its bay. */
function atBay(seed, errand = 2, back = 25, params = {}) {
  const S = sim({ seed, errand, ...params });
  toDrive(S);
  const spot = bayOf(S);
  atLaneCentre(S, spot, back);
  TLV.game.flow._setPhase(S, 'SEARCH');
  return { S, spot };
}

function park(S, source, seconds = 30) {
  S.controlSource = source;
  until(S, (s) => s.game.phase === 'PAYOUT' || s.game.phase === 'RUN_END', seconds, 'parked');
  return S.game.errand;
}

/** As park, for a script that can miss: a car wedged on a neighbour reads as no quality. */
function tryPark(S, source) {
  S.controlSource = source;
  for (let i = 0; i < 60 * 14 && S.game.phase !== 'PAYOUT'; i++) step(S);
  return S.game.errand;
}

test('item 3: PERFECT by scripted controls from lane centre, past parked neighbours', () => {
  let perfect = 0;
  for (let seed = 1; seed <= 8; seed++) {
    const { S, spot } = atBay(seed);
    const before = S.game.money;
    const e = park(S, parker(spot));
    if (e.quality === 'PERFECT') perfect++;
    assert.equal(e.parkMethod, 'BAY');
    if (S.game.contacts === 0 && e.quality === 'PERFECT') {
      const parked = events(S, 'errand.parked')[0];
      assert.equal(parked.quality, 'PERFECT');
      assert.equal(parked.spotless, true);
      assert.equal(parked.pay, Math.round((T.payBase + T.payPerM * e.routeLen) * 1.5 * 1.5));
      assert.equal(S.game.money, before + parked.pay);
      assert.ok(Math.abs(parked.award - e.award) < 1e-9, 'M is 1 in a bay');
    }
    assert.equal(TLV.math.dist(S.player.veh.x, S.player.veh.y, spot.x, spot.y) < 0.01, true, 'snapped into the bay');
  }
  assert.ok(perfect >= 7, `${perfect} of 8 PERFECT`);
});

test('item 3: GOOD by scripted controls: on line, 0.5 m out', () => {
  let good = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const { S, spot } = atBay(seed);
    const side = Math.sign(inBay(spot, S.player.veh).l);
    // Aimed 0.65 m out, the S-curve is about 0.5 m out when the car stops.
    const e = park(S, parker(spot, { endL: side * 0.65 }));
    if (e.quality === 'GOOD') good++;
    assert.notEqual(e.quality, 'PERFECT');
  }
  assert.ok(good >= 5, `${good} of 6 GOOD`);
});

test('item 3: UGLY by scripted controls: a late dive braked in the funnel', () => {
  let ugly = 0;
  for (let seed = 1; seed <= 6; seed++) {
    const { S, spot } = atBay(seed);
    const e = tryPark(S, parker(spot, { startA: -8, endA: 2, stopA: -1.2, v: 3.2 }));
    if (e.quality === 'UGLY') ugly++;
  }
  assert.ok(ugly >= 4, `${ugly} of 6 UGLY`);
});

test('quality reads offset, yaw and the kerb at capture', () => {
  const { S, spot } = atBay(3);
  const veh = S.player.veh;
  const cases = [
    { l: 0, yaw: 0, q: 'PERFECT' },
    { l: 0.3, yaw: 5, q: null },
    { l: 0.6, yaw: 0, q: 'GOOD' },
    { l: 0, yaw: 11, q: 'GOOD' },
    { l: 0.8, yaw: 0, q: 'UGLY' },
    { l: 0, yaw: 14, q: 'UGLY' }
  ];
  for (const c of cases) {
    const s2 = sim({ seed: 3, errand: 2 });
    toDrive(s2);
    const bay = bayOf(s2);
    const h = bay.h + c.yaw * Math.PI / 180;
    TLV.player.setPose(s2, bay.x - Math.sin(bay.h) * c.l, bay.y + Math.cos(bay.h) * c.l, h, 0);
    step(s2, 3);
    if (c.q) assert.equal(s2.game.errand.quality, c.q, JSON.stringify(c));
    else assert.ok(s2.game.errand.quality);
  }
  assert.ok(veh);
});

test('row 22: a car that stops at the door, or runs past the bay, completes nothing', () => {
  for (const seed of [1, 2, 3, 4]) {
    const S = sim({ seed, errand: 2 });
    toDrive(S);
    const e = S.game.errand;
    const clock = S.game.clock;
    const at = TLV.world.lanes.pointAt(S.world, e._doorLane, e._doorLaneS, {});
    TLV.player.setPose(S, at.x, at.y, at.h, 0);
    assert.ok(TLV.math.dist(at.x, at.y, e.doorX, e.doorY) < 50, `seed ${seed}: the lane point is at the door`);
    S.controlSource = hold({});
    step(S, 30 * 60);
    assert.equal(events(S, 'errand.parked').length, 0, `seed ${seed}: stopped at the door`);
    assert.equal(S.game.stats.errandsDone, 0);
    assert.equal(S.game.errandIndex, 1);
    assert.equal(e.quality, null);
    assert.equal(S.game.park.stage, null);
    assert.ok(S.game.phase === 'DRIVE' || S.game.phase === 'SEARCH', S.game.phase);
    assert.ok(Math.abs(clock - S.game.clock - 30) < 0.1, 'the clock runs on: the car is not parked');

    // Past it down the lane, on through the far end of the block.
    atLaneCentre(S, bayOf(S), 20, 10);
    S.controlSource = hold({ throttle: 0.3 });
    step(S, 3 * 60);
    assert.equal(events(S, 'errand.parked').length, 0, `seed ${seed}: past the bay`);
    assert.equal(S.game.park.stage, null, `seed ${seed}: never armed`);
  }
});

test('capture waits for the car to stop or for 2.5 s, so a crawl has time to straighten up', () => {
  const { S, spot } = atBay(2);
  const c = Math.cos(spot.h);
  const s = Math.sin(spot.h);
  TLV.player.setPose(S, spot.x - c * 2.5, spot.y - s * 2.5, spot.h, 0.8);
  assert.equal(TLV.game.parking.tryArm(S), true);
  S.controlSource = hold({});
  step(S, 6);
  assert.equal(S.game.park.stage, 'ARMED', 'rolling at 0.8 m/s is not stopping');
  until(S, (x) => x.game.park.stage !== 'ARMED', 2, 'it stops');
  assert.equal(S.game.park.stage, 'SNAP');
  assert.ok(Math.abs(S.player.veh.v) <= T.captureV + 0.02, `${S.player.veh.v}`);

  const late = atBay(3);
  const lc = Math.cos(late.spot.h);
  const ls = Math.sin(late.spot.h);
  TLV.player.setPose(late.S, late.spot.x - lc * 3, late.spot.y - ls * 3, late.spot.h, 1);
  assert.equal(TLV.game.parking.tryArm(late.S), true);
  const crawl = TLV.const._newControls();
  late.S.controlSource = (x) => {
    crawl.throttle = x.player.veh.v < 1 ? 0.2 : 0;
    return crawl;
  };
  const t0 = late.S.t;
  until(late.S, (x) => x.game.park.stage !== 'ARMED', 4, 'the timer');
  assert.equal(late.S.game.park.stage, 'SNAP');
  assert.ok(Math.abs(late.S.t - t0 - T.armedMaxS) < 0.05, `${late.S.t - t0} s`);
});

test('errand.parked carries the offset and yaw that quality locked from, and null where nothing was captured', () => {
  for (const c of [{ l: 0.8, yaw: 0, q: 'UGLY' }, { l: 0, yaw: 14, q: 'UGLY' }, { l: 0.5, yaw: 7, q: 'GOOD' }, { l: 0.1, yaw: 2, q: 'PERFECT' }]) {
    const s2 = sim({ seed: 3, errand: 2 });
    toDrive(s2);
    const bay = bayOf(s2);
    TLV.player.setPose(s2, bay.x - Math.sin(bay.h) * c.l, bay.y + Math.cos(bay.h) * c.l, bay.h + c.yaw * Math.PI / 180, 0);
    until(s2, () => events(s2, 'errand.parked').length > 0, 4, 'parked');
    const e = events(s2, 'errand.parked')[0];
    assert.equal(e.quality, c.q, JSON.stringify(e));
    assert.ok(Math.abs(e.offM - c.l) < 1e-6, `offM ${e.offM}`);
    assert.ok(Math.abs(e.yawDeg - c.yaw) < 1e-6, `yawDeg ${e.yawDeg}`);
  }
  const q = sim({ seed: 3, errand: 2 });
  toDrive(q);
  TLV.debug.parkNow({ method: 'DOUBLE' });
  const e = events(q, 'errand.parked')[0];
  assert.equal(e.method, 'DOUBLE');
  assert.equal(e.offM, null);
  assert.equal(e.yawDeg, null);
});

test('a touch of the bay\'s own kerb costs PERFECT', () => {
  const S = sim({ seed: 3, errand: 2 });
  toDrive(S);
  const bay = bayOf(S);
  const curb = (bay.side === 0) === (W.lanes[bay.laneId].dirEdge % 2 === 0) ? 1 : -1;
  // 0.34 m toward the kerb at 3 deg: inside the offset and yaw limits, with the corner over the line.
  TLV.player.setPose(S, bay.x - Math.sin(bay.h) * 0.34 * curb, bay.y + Math.cos(bay.h) * 0.34 * curb, bay.h + 3 * Math.PI / 180, 0);
  step(S, 3);
  assert.equal(S.game.errand.quality, 'GOOD');
});

test('item 3: arming takes 7 m/s, or 12 with the handbrake, and HANDBRAKE PARK is paid when the bar fills', () => {
  const { S, spot } = atBay(2);
  const near = (v) => {
    TLV.player.setPose(S, spot.x - Math.cos(spot.h) * 3, spot.y - Math.sin(spot.h) * 3, spot.h, v);
  };
  near(8);
  assert.equal(TLV.game.parking.tryArm(S), false, '8 m/s does not arm');
  assert.equal(S.game.park.stage, null);
  near(6.5);
  S.controls.handbrake = false;
  assert.equal(TLV.game.parking.tryArm(S), true, '6.5 m/s arms');
  // A fresh run, with the handbrake held.
  const b = atBay(2);
  b.S.controlSource = hold({ handbrake: true });
  TLV.player.setPose(b.S, b.spot.x - Math.cos(b.spot.h) * 3.5, b.spot.y - Math.sin(b.spot.h) * 3.5, b.spot.h, 11);
  step(b.S, 1);
  assert.equal(b.S.game.park.stage, 'ARMED');
  until(b.S, (s) => s.game.phase === 'PAYOUT', 6, 'PAYOUT');
  assert.equal(events(b.S, 'score.bonus', (e) => e.id === 'HANDBRAKE_PARK').length, 1);
  const c = atBay(2);
  c.S.controlSource = hold({ handbrake: true });
  TLV.player.setPose(c.S, c.spot.x - Math.cos(c.spot.h) * 3.5, c.spot.y - Math.sin(c.spot.h) * 3.5, c.spot.h, 12.5);
  c.S.controls.handbrake = true;
  assert.equal(TLV.game.parking.tryArm(c.S), false, '12.5 m/s does not arm, handbrake or not');
});

test('item 3: within 30 deg of the axis in either direction', () => {
  for (const [deg, ok] of [[0, true], [29, true], [31, false], [180, true], [151, true], [149, false], [-29, true], [-179, true]]) {
    const { S, spot } = atBay(4);
    TLV.player.setPose(S, spot.x, spot.y, spot.h + deg * Math.PI / 180, 0);
    assert.equal(TLV.game.parking.tryArm(S), ok, `${deg} deg`);
  }
});

test('reversing in counts: the snap keeps the way the car faces', () => {
  const { S, spot } = atBay(4);
  TLV.player.setPose(S, spot.x, spot.y, spot.h + Math.PI, 0);
  until(S, (s) => s.game.phase === 'PAYOUT', 5, 'PAYOUT');
  assert.ok(Math.abs(TLV.math.wrapPi(S.player.veh.h - spot.h - Math.PI)) < 1e-6);
});

test('item 3: only errand.bayId arms: no decoy stall and no other free stall', () => {
  const S = sim({ seed: 5, errand: 2 });
  toDrive(S);
  const e = S.game.errand;
  const bay = bayOf(S);
  const ids = [];
  TLV.world.parking.spotsNear(W, bay.x, bay.y, 100, ids);
  const other = ids.find((id) => id !== e.bayId);
  TLV.world.parking.setState(S, other, OCC.FREE);
  const sp = TLV.world.parking.spot(W, other);
  TLV.player.setPose(S, sp.x, sp.y, sp.h, 0);
  step(S, 120);
  assert.equal(S.game.park.stage, null);
  assert.equal(S.game.phase === 'DRIVE' || S.game.phase === 'SEARCH', true);
  for (const d of e.decoys) {
    const spot = TLV.world.parking.spot(W, d.spotId);
    TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
    step(S, 60);
    assert.equal(S.game.park.stage, null, `decoy ${d.kind}`);
  }
  // A bay another car stands in cannot arm either.
  TLV.world.parking.setState(S, e.bayId, OCC.VEHICLE);
  TLV.player.setPose(S, bay.x, bay.y, bay.h, 0);
  step(S, 30);
  assert.equal(S.game.park.stage, null);
});

test('item 3: cancel in ARMED: leaving the funnel', () => {
  const { S, spot } = atBay(6);
  // Out of the side of the funnel, toward the lane: forward is the next parked car.
  const curb = (spot.side === 0) === (W.lanes[spot.laneId].dirEdge % 2 === 0) ? 1 : -1;
  TLV.player.setPose(S, spot.x, spot.y, spot.h - curb * 25 * Math.PI / 180, 6);
  S.controlSource = hold({ throttle: 1 });
  step(S, 1);
  assert.equal(S.game.park.stage, 'ARMED');
  assert.equal(S.game.phase, 'HOLD');
  until(S, (s) => s.game.park.stage === null, 3, 'cancel');
  assert.equal(S.game.phase, 'SEARCH', 'back to SEARCH with the bay close');
  assert.equal(S.game.errand.quality, null);
  assert.equal(S.player.mode, 'DRIVE');
});

test('item 3: cancel in SNAP and in FILL: throttle above 50%, and the bar resets', () => {
  for (const stage of ['SNAP', 'FILL']) {
    const { S, spot } = atBay(6);
    TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
    until(S, (s) => s.game.park.stage === stage, 3, stage);
    assert.equal(S.player.mode === 'LOCKED' || S.player.mode === 'SNAP', true, 'controls locked from SNAP');
    S.controlSource = hold({ throttle: 0.4 });
    step(S, 5);
    assert.equal(S.game.phase, 'HOLD', '40% does not cancel');
    S.controlSource = hold({ throttle: 0.9 });
    step(S, 1);
    assert.equal(S.game.park.stage, null, stage);
    assert.equal(S.game.park.bar, 0);
    assert.ok(S.game.phase === 'SEARCH' || S.game.phase === 'DRIVE');
    step(S, 60);
    assert.equal(S.player.mode, 'DRIVE');
    assert.equal(S.game.phase === 'PAYOUT', false);
  }
});

test('the bar runs across SNAP and FILL, and the phase table runs HOLD to PAYOUT to CARD', () => {
  const { S, spot } = atBay(6);
  TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
  until(S, (s) => s.game.phase === 'HOLD', 2, 'HOLD');
  let last = -1;
  while (S.game.phase === 'HOLD') {
    assert.ok(S.game.park.bar >= last && S.game.park.bar <= 1);
    last = S.game.park.bar;
    step(S);
  }
  assert.ok(last > 0.95);
  assert.equal(S.game.phase, 'PAYOUT');
  const c0 = S.game.clock;
  until(S, (s) => s.game.phase !== 'PAYOUT', 3, 'end of PAYOUT');
  assert.equal(S.game.phase, 'CARD');
  assert.ok(Math.abs(S.game.clock - c0) < 1e-9, 'clock frozen in PAYOUT');
  step(S, 2);
  assert.equal(S.player.mode, 'SNAP', 'pulling out, since nothing is near');
  const c1 = S.game.clock;
  until(S, (s) => s.game.phase === 'DRIVE', 6, 'DRIVE');
  assert.ok(Math.abs(S.game.clock - c1) < 1e-9, 'clock frozen in CARD');
  assert.equal(S.player.mode, 'DRIVE');
  const lane = TLV.world.lanes.project(W, S.player.veh.x, S.player.veh.y, S.player.veh.h, 2, {});
  assert.ok(lane && lane.dist < 0.2, 'pulled out to lane centre');
});

test('pull-out waits up to 3 s for a car in the slot, and the card outlasts it', () => {
  const { S, spot } = atBay(6, 2, 25, { traffic: 1, density: 0 });
  TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
  until(S, (s) => s.game.phase === 'PAYOUT', 5, 'PAYOUT');
  const car = TLV.traffic.spawn(S, { laneId: spot.laneId, s: spot.laneS, v: 0, force: true });
  assert.ok(car);
  TLV.traffic.command(S, car, { type: 'PHANTOM_STOP', decel: 5, holdS: 30 });
  until(S, (s) => s.game.phase === 'CARD', 3, 'CARD');
  const t0 = S.t;
  until(S, (s) => s.player.mode === 'SNAP', 5, 'snap');
  assert.ok(S.t - t0 > 2.8, `${(S.t - t0).toFixed(1)} s`);
  until(S, (s) => s.game.phase === 'DRIVE', 4, 'DRIVE');
  assert.ok(S.t - t0 >= 3.9, 'CARD outlasts the wait');
});

test('item 3: Q alone parks badly: stationary, near the door, held 1.0 s', () => {
  const { S } = atBay(7);
  const e = S.game.errand;
  S.controlSource = hold({ hazard: true });
  const pose = S.player.veh;
  e.doorX = pose.x + 60;
  e.doorY = pose.y;
  step(S, 2);
  assert.equal(S.game.phase, 'HOLD');
  assert.equal(S.game.park.kind, 'DOUBLE');
  assert.equal(S.game.park.stage, 'FILL');
  S.controlSource = hold({});
  step(S, 2);
  assert.ok(S.game.phase !== 'HOLD', 'letting go cancels');
  assert.equal(S.game.park.bar, 0);
  S.controlSource = hold({ hazard: true });
  const clock = S.game.clock;
  until(S, (s) => s.game.phase === 'PAYOUT', 2, 'PAYOUT');
  const parked = events(S, 'errand.parked')[0];
  assert.equal(parked.method, 'DOUBLE');
  assert.equal(parked.quality, 'DOUBLE');
  assert.equal(parked.spotless, false, 'no SPOTLESS for Q');
  assert.ok(Math.abs(parked.award - e.award * 0.4) < 1e-9, 'M 0.4');
  assert.equal(S.game.clock > clock, true);
  assert.equal(events(S, 'score.bonus', (b) => b.id === 'SPOTLESS').length, 0);
  assert.equal(parked.pay, Math.round((T.payBase + T.payPerM * e.routeLen) * 0.5 * 1.0));
});

test('Q does nothing while moving, far from the door, or past 40 m on the gan', () => {
  const { S } = atBay(7);
  const e = S.game.errand;
  S.controlSource = hold({ hazard: true });
  e.doorX = S.player.veh.x + 200;
  e.doorY = S.player.veh.y;
  step(S, 90);
  assert.ok(S.game.phase !== 'HOLD' && S.game.park.stage === null, 'over 150 m');
  e.doorX = S.player.veh.x + 100;
  S.player.veh.v = 3;
  S.player.veh.vx = 3 * Math.cos(S.player.veh.h);
  S.player.veh.vy = 3 * Math.sin(S.player.veh.h);
  step(S, 1);
  assert.equal(S.game.park.stage, null, 'moving');
  const gan = sim({ seed: 7, errand: 7 });
  toDrive(gan);
  assert.equal(gan.game.errandIndex, 6);
  const v = gan.player.veh;
  gan.controlSource = hold({ hazard: true });
  gan.game.errand.doorX = v.x + 45;
  gan.game.errand.doorY = v.y;
  step(gan, 90);
  assert.equal(gan.game.park.stage, null, '45 m on the gan');
  gan.game.errand.doorX = v.x + 35;
  until(gan, (s) => s.game.phase === 'PAYOUT' || s.game.phase === 'RUN_END', 3, 'parked on the gan');
});

/** A stopped pose on lane centre with a red curb in reach and in line. */
function redCurb(paint) {
  const kerb = { kerb: -1, side: 0, paint: 0, dist: 0, h: 0 };
  for (const lane of W.lanes) {
    if (!(lane.flags & 1) || lane.len < 20) continue;
    for (let s = 3; s < lane.len - 3; s += 3) {
      const at = TLV.world.lanes.pointAt(W, lane.id, s, {});
      const r = TLV.world.parking.kerbAt(W, at.x, at.y, T.curbM, kerb);
      if (r && r.paint === paint && Math.abs(TLV.math.wrapPi(at.h - r.h)) < 0.2) return at;
    }
  }
  return null;
}

test('item 3: red/white and red/yellow curbs by Q: M 0.7, UGLY, no SPOTLESS, Q never fires alone', () => {
  for (const [paint, method] of [[TLV.const.PAINT.RED_WHITE, 'RED_WHITE'], [TLV.const.PAINT.RED_YELLOW, 'RED_YELLOW']]) {
    const at = redCurb(paint);
    assert.ok(at, `a ${method} curb exists`);
    const S = sim({ seed: 8, errand: 2 });
    toDrive(S);
    TLV.player.setPose(S, at.x, at.y, at.h, 0);
    const e = S.game.errand;
    e.doorX = at.x + 40;
    e.doorY = at.y;
    step(S, 120);
    assert.equal(S.game.park.stage, null, 'sitting at a curb does nothing');
    S.controlSource = hold({ hazard: true });
    step(S, 2);
    assert.equal(S.game.park.kind, 'CURB');
    until(S, (s) => s.game.phase === 'PAYOUT', 2, 'PAYOUT');
    const parked = events(S, 'errand.parked')[0];
    assert.equal(parked.method, method);
    assert.equal(parked.quality, 'UGLY');
    assert.equal(parked.spotless, false);
    assert.ok(Math.abs(parked.award - e.award * 0.7) < 1e-9);
    assert.equal(parked.pay, Math.round((T.payBase + T.payPerM * e.routeLen) * 1.0 * 1.0));
  }
});

test('item 3: inspector rolls with fixed seeds: tickets at their rates, in shekels, the same each time', () => {
  function roll(seed, paint) {
    const S = sim({ seed, errand: 2 });
    toDrive(S);
    const at = paint ? redCurb(paint) : null;
    if (at) TLV.player.setPose(S, at.x, at.y, at.h, 0);
    const e = S.game.errand;
    e.doorX = S.player.veh.x + 40;
    e.doorY = S.player.veh.y;
    S.game.money = 1000;
    S.controlSource = hold({ hazard: true });
    until(S, (s) => s.game.phase === 'PAYOUT', 3, 'PAYOUT');
    const t = events(S, 'inspector.ticket');
    const pay = events(S, 'errand.parked')[0].pay;
    const expected = 1000 + pay - t.reduce((a, b) => a + b.amount, 0);
    assert.equal(S.game.money, expected);
    return t[0] || null;
  }
  let double = 0;
  let white = 0;
  let yellow = 0;
  const N = 60;
  for (let seed = 1; seed <= N; seed++) {
    const a = roll(seed, 0);
    if (a) {
      double++;
      assert.deepEqual(a, { amount: 200, kind: 'TICKET' });
    }
    const b = roll(seed, TLV.const.PAINT.RED_WHITE);
    if (b) {
      white++;
      assert.deepEqual(b, { amount: 200, kind: 'TICKET' });
    }
    const c = roll(seed, TLV.const.PAINT.RED_YELLOW);
    if (c) {
      yellow++;
      assert.deepEqual(c, { amount: 300, kind: 'TOW' });
    }
  }
  console.log(`inspector over ${N} seeds: double ${double}, red/white ${white}, red/yellow ${yellow}`);
  assert.ok(double > N * 0.4 && double < N * 0.8);
  assert.ok(white > N * 0.25 && white < N * 0.55);
  assert.ok(yellow > N * 0.4 && yellow < N * 0.8);
  assert.deepEqual(roll(9, 0), roll(9, 0), 'a fixed seed gives a fixed roll');
});

test('stageBlock: the bay is free, the block is full, and it stays out of what the player can see', () => {
  const S = sim({ seed: 9, errand: 3 });
  const e = S.game.errand;
  const veh = S.player.veh;
  const ids = [];
  TLV.world.parking.spotsNear(W, e.doorX, e.doorY, T.fillM, ids);
  assert.ok(ids.length > 20);
  for (const id of ids) {
    const sp = TLV.world.parking.spot(W, id);
    const st = TLV.world.parking.state(S, id);
    if (id === e.bayId) assert.equal(st, OCC.FREE);
    else if (TLV.math.dist(sp.x, sp.y, veh.x, veh.y) > T.fillKeepM && !e.decoys.some((d) => d.spotId === id)) {
      assert.notEqual(st, OCC.FREE, 'the block is full');
    }
  }
  assert.ok(e.decoys.length >= 1 && e.decoys.length <= 2);
  const bay = bayOf(S);
  for (const d of e.decoys) {
    const sp = TLV.world.parking.spot(W, d.spotId);
    const far = TLV.math.dist(sp.x, sp.y, bay.x, bay.y);
    assert.ok(far >= 30 && far <= 60, `decoy at ${far}`);
    if (d.kind === 'MOTORBIKE') assert.equal(TLV.world.parking.state(S, d.spotId), OCC.MOTO);
    else assert.equal(TLV.world.parking.state(S, d.spotId), OCC.FREE);
  }
  assert.ok(e._doorM <= 180 || e._noContest || e._doorM === Infinity, `bay ${e._doorM} m by road from the door`);
});

test('a saver walks into their stall when the player nears, and leaves a live person in it', () => {
  for (let seed = 1; seed <= 12; seed++) {
    const S = sim({ seed, errand: 3, peds: 1 });
    toDrive(S);
    const d = S.game.errand.decoys.find((x) => x.kind === 'SAVER');
    if (!d) continue;
    const spot = TLV.world.parking.spot(W, d.spotId);
    atLaneCentre(S, spot, 60);
    step(S, 4);
    assert.ok(d.pedId >= 0, 'spawned');
    const p = TLV.peds.byId(S, d.pedId);
    assert.equal(p.kind, 'saver');
    until(S, () => TLV.math.dist(p.x, p.y, spot.x, spot.y) < 1, 30, 'in the stall');
    return;
  }
  assert.fail('no seed had a saver');
});

test('while armed the sim publishes the pose and grade capture would lock, and they match what it locks', () => {
  for (const c of [{ l: 0.1, yaw: 2, q: 'PERFECT' }, { l: 0.5, yaw: 7, q: 'GOOD' }, { l: 0.8, yaw: 3, q: 'UGLY' }, { l: 0.1, yaw: 20, q: 'UGLY' }]) {
    const S = sim({ seed: 3, errand: 2 });
    toDrive(S);
    const bay = bayOf(S);
    const h = bay.h + c.yaw * Math.PI / 180;
    TLV.player.setPose(S, bay.x - Math.sin(bay.h) * c.l, bay.y + Math.cos(bay.h) * c.l, h, 1.2);
    assert.equal(S.game.park.offM, null, 'null before it arms');
    assert.equal(S.game.park.would, null);
    assert.equal(TLV.game.parking.tryArm(S), true);
    const p = S.game.park;
    assert.equal(p.stage, 'ARMED');
    assert.ok(Math.abs(p.offM - c.l) < 1e-6, `${p.offM}`);
    assert.ok(Math.abs(p.yawDeg - c.yaw) < 1e-6, `${p.yawDeg}`);
    assert.equal(p.would, c.q);
    const parked = [];
    S.bus.on('errand.parked', (e) => parked.push(e));
    // Brake to a stop on this tick's pose: the fields move with the car and stay live to the last tick of ARMED.
    S.controlSource = hold({ brake: 1 });
    let last = null;
    until(S, (x) => {
      if (x.game.park.stage === 'ARMED') last = { off: x.game.park.offM, yaw: x.game.park.yawDeg, would: x.game.park.would };
      return x.game.park.stage !== 'ARMED';
    }, 4, 'capture');
    assert.equal(p.stage, 'SNAP');
    assert.equal(S.game.park.offM, null, 'null again once captured');
    assert.equal(S.game.park.yawDeg, null);
    assert.equal(S.game.park.would, null);
    assert.equal(S.game.errand.quality, last.would, 'what it said is what it locked');
    until(S, (x) => parked.length > 0 || x.game.phase === 'RUN_END', 6, 'parked');
    assert.ok(Math.abs(parked[0].offM - last.off) < 0.12, `${parked[0].offM} against ${last.off}`);
    assert.ok(Math.abs(parked[0].yawDeg - last.yaw) < 2, `${parked[0].yawDeg} against ${last.yaw}`);
  }
});

test('the pose fields clear on a cancel, and when the run ends with the bay armed', () => {
  const S = sim({ seed: 3, errand: 2 });
  toDrive(S);
  const bay = bayOf(S);
  TLV.player.setPose(S, bay.x, bay.y, bay.h, 1);
  assert.equal(TLV.game.parking.tryArm(S), true);
  assert.equal(S.game.park.would, 'PERFECT');
  TLV.player.setPose(S, bay.x + 50, bay.y + 50, bay.h, 1);
  step(S, 2);
  assert.equal(S.game.park.stage, null, 'left the funnel');
  assert.equal(S.game.park.offM, null);
  assert.equal(S.game.park.would, null);
  TLV.player.setPose(S, bay.x, bay.y, bay.h, 1);
  step(S, 2);
  assert.equal(S.game.park.stage, 'ARMED');
  TLV.game.flow.endRun(S, 'CLOCK');
  assert.equal(S.game.park.stage, null);
  assert.equal(S.game.park.would, null);
});

test('the timer locks no pose that would be UGLY: a car told to keep rolling can, until it stops or leaves the funnel', () => {
  const S = sim({ seed: 3, errand: 2 });
  toDrive(S);
  const bay = bayOf(S);
  const yaw = bay.h + 20 * Math.PI / 180;
  const c = Math.cos(bay.h);
  const s = Math.sin(bay.h);
  TLV.player.setPose(S, bay.x - c * 1.2, bay.y - s * 1.2, yaw, 0.6);
  assert.equal(TLV.game.parking.tryArm(S), true);
  assert.equal(S.game.park.would, 'UGLY');
  // Crawls on a held wheel at 0.6 m/s, past the 2.5 s timer, still crooked.
  const crawl = TLV.const._newControls();
  S.controlSource = (x) => {
    crawl.throttle = Math.abs(x.player.veh.v) < 0.6 ? 0.2 : 0;
    x.player.veh.h = yaw;
    return crawl;
  };
  step(S, Math.round((T.armedMaxS + 0.5) * 60));
  assert.equal(S.game.park.stage, 'ARMED', 'still rolling, not locked');
  assert.equal(S.game.errand.quality, null);
  // Stopping locks it, as it always did.
  S.controlSource = hold({ brake: 1 });
  until(S, (x) => x.game.park.stage !== 'ARMED', 3, 'capture');
  assert.equal(S.game.errand.quality, 'UGLY');
});
