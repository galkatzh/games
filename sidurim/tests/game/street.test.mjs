// tests/game/street.test.mjs — WP-GAME
// What the street does to the player on the real map, through the real packages: tailgaters at speed, dives past him, a live parked
// car, a car pinned against one, the tutorial road, and the director's pacing.
import test from 'node:test';
import { assert, realTLV, sim, step, until, toDrive, events, hold } from './helpers.mjs';

const TLV = realTLV();
const T = TLV.tune.game;
const Q = TLV.tune.traffic;

/** A long, straight, routable lane with a lane beside it. */
function straight(S, test) {
  const W = S.world;
  for (const l of W.lanes) {
    if (!(l.flags & TLV.const.LF.AI_ROUTABLE) || l.len < 240 || !test(l)) continue;
    let bend = 0;
    for (let i = 2; i < l.px.length; i++) {
      const a = Math.atan2(l.py[i - 1] - l.py[i - 2], l.px[i - 1] - l.px[i - 2]);
      const b = Math.atan2(l.py[i] - l.py[i - 1], l.px[i] - l.px[i - 1]);
      bend = Math.max(bend, Math.abs(TLV.math.wrapPi(b - a)));
    }
    if (bend < 0.12) return l;
  }
  return null;
}

/** Drives the real car along a lane at a speed, with a steady hand. */
function driver(S, lane, want) {
  const W = S.world;
  const me = S.player.veh;
  const pj = {};
  const pt = {};
  const c = TLV.const._newControls();
  return {
    want,
    brake: 0,
    source() {
      Object.assign(c, TLV.const._newControls());
      TLV.math.polyProject(lane.px, lane.py, lane.cum, me.x, me.y, -1, pj);
      TLV.world.lanes.pointAt(W, lane.id, Math.min(lane.len, pj.s + 12), pt);
      c.steer = TLV.math.clamp(TLV.math.wrapPi(Math.atan2(pt.y - me.y, pt.x - me.x) - me.h) * 4, -1, 1);
      if (this.brake > 0) {
        c.brake = me.v > 0.2 ? this.brake / TLV.tune.player.brake : 0;
        return c;
      }
      const a = (this.want - me.v) * 8;
      c.throttle = a > 0 ? Math.min(1, a / 5) : 0;
      c.brake = a < -2 ? Math.min(1, -a / 14) : 0;
      return c;
    }
  };
}

/** A quiet road with the real car on it at speed, and a car some way behind. */
function onStraight(v, back, want = (l) => l.vmax > 13) {
  const S = sim({ seed: 2, traffic: 1, density: 1, peds: 0, incidents: 0, clock: 3000, immortal: 1 });
  toDrive(S);
  TLV.traffic.setDensity(S, 1);
  for (const c of [...S.vehicles]) if (c.active && !c.isPlayer) TLV.traffic.despawn(S, c, 'range');
  const lane = straight(S, want);
  assert.ok(lane, 'a straight lane');
  const at = TLV.world.lanes.pointAt(S.world, lane.id, 10, {});
  TLV.player.setPose(S, at.x, at.y, at.h, 0);
  const d = driver(S, lane, v);
  S.controlSource = () => d.source();
  const me = S.player.veh;
  for (let i = 0; i < 600 && me.v < v - 0.3; i++) step(S);
  const car = back === null ? null : TLV.traffic.spawn(S, { laneId: lane.id, s: S.traffic.pS - back - 4.2, v, kind: 'sedan', ag: 0.8, force: true });
  return { S, lane, d, me, car };
}

const gapOf = (me, car) => (me.x - car.x) * Math.cos(me.h) + (me.y - car.y) * Math.sin(me.h) - (me.length + car.length) / 2;

test('a tailgater closes on a moving car, holds 1.4-3 m above 10 m/s, and its clock starts only then', () => {
  for (const v of [10, 13]) {
    const { S, me, car } = onStraight(v, 28);
    assert.equal(TLV.traffic.command(S, car, { type: 'TAILGATE', durS: 12, targetId: 0 }), true);
    const stood = car._t.timer;
    let closed = null;
    for (let i = 0; i < 60 * 8 && closed === null; i++) {
      step(S);
      if (gapOf(me, car) < Q.tailCloseM) closed = i / 60;
      else assert.equal(car._t.timer, stood, 'no clock while it closes');
    }
    assert.ok(closed !== null && closed < 6, `closed in ${closed} s at ${v} m/s`);
    step(S, 150);
    let lo = Infinity;
    let hi = 0;
    for (let i = 0; i < 60; i++) {
      step(S);
      lo = Math.min(lo, gapOf(me, car));
      hi = Math.max(hi, gapOf(me, car));
    }
    assert.ok(lo >= 1.4 && hi <= 3, `${lo.toFixed(2)} to ${hi.toFixed(2)} m at ${v} m/s`);
  }
});

test('brake checks stay fair: a stop at 8 m/s2 or less is never hit, a stop at 14 is, at half damage, and the car falls back', () => {
  for (const [brake, hit] of [[5, false], [8, false], [14, true]]) {
    const { S, d, me, car } = onStraight(11, 8);
    assert.equal(TLV.traffic.command(S, car, { type: 'TAILGATE', durS: 20, targetId: 0 }), true);
    step(S, 60 * 4);
    assert.ok(gapOf(me, car) <= 3, `on the bumper: ${gapOf(me, car).toFixed(2)}`);
    const hp = S.game.hp;
    const cut = S.game.contacts;
    d.brake = brake;
    const contacts = [];
    S.bus.on('player.contact', (e) => contacts.push(e));
    for (let i = 0; i < 60 * 3; i++) step(S);
    assert.equal(contacts.length > 0, hit, `${brake} m/s2: ${contacts.length} contacts`);
    if (hit) {
      assert.equal(contacts[0].rearEnded, true);
      assert.ok(contacts[0].severity !== 'crash', contacts[0].severity);
      assert.equal(S.game.hp, hp - TLV.tune.game.hpBump * T.rearShare, 'half of a bump');
      assert.equal(S.game.contacts, cut, 'and no contact against the player');
      assert.ok(contacts.length === 1, 'one brake check, one hit');
      assert.notEqual(car.beh, 'TAILGATE', 'it has fallen back');
    }
    assert.ok(car.accel >= -Q.hardBrake - 1e-9, 'no AI brakes past the floor');
  }
});

test('the errands and braker bots do not brake for a car coming up behind them', () => {
  const { S, me, lane } = onStraight(10, null);
  S.controlSource = TLV.bots.create('patrol');
  step(S, 30);
  const s = S.traffic.pS;
  const car = TLV.traffic.spawn(S, { laneId: lane.id, s: s - 12, v: 16, kind: 'sedan', ag: 0.8, force: true });
  assert.ok(car);
  const v0 = me.v;
  let least = v0;
  for (let i = 0; i < 60 && car.active && (car.x - me.x) * Math.cos(me.h) + (car.y - me.y) * Math.sin(me.h) < -3; i++) {
    step(S);
    least = Math.min(least, me.v);
  }
  assert.ok(least > v0 - 2, `slowed from ${v0.toFixed(1)} to ${least.toFixed(1)} for a car behind`);
});

test('OVERTAKE_DIVE fires: staged on a road with room, it comes from behind the player and cuts back in close ahead', () => {
  let found = 0;
  for (const want of [(l) => l.left >= 0 && l.vmax > 13, (l) => l.left >= 0, (l) => l.right >= 0]) {
    const { S, me } = onStraight(9, null, want);
    S.game.heat = 0.5;
    until(S, (s) => s.traffic.pS > 45, 12, 'some way up the lane');
    const inc = TLV.game.incidents.stage(S, 'OVERTAKE_DIVE', {});
    if (!inc) continue;
    found++;
    const car = TLV.traffic.byId(S, inc.actors[0].id);
    assert.ok(car && (me.x - car.x) * Math.cos(me.h) + (me.y - car.y) * Math.sin(me.h) > 0, 'it comes from behind');
    assert.ok(car.beh === 'OVERTAKE_OUT' || car.beh === 'OVERTAKE_PASS', car.beh);
    until(S, () => car.beh === 'CUT_IN' || !car.active, 10, 'CUT_IN');
    assert.equal(car.beh, 'CUT_IN');
    const g = (car.x - me.x) * Math.cos(me.h) + (car.y - me.y) * Math.sin(me.h) - (me.length + car.length) / 2;
    assert.ok(g > 0 && g / me.v < 1.1, `cut in at ${g.toFixed(1)} m, ${(g / me.v).toFixed(2)} s`);
    assert.ok(TLV.traffic.visibleToPlayer(S, car.x, car.y), 'in view');
    until(S, () => car.beh === 'CRUISE', 8, 'CRUISE');
    TLV.game.incidents._tick(S);
    assert.equal(inc.outcome, 'AVOIDED', 'the incident ends with its car');
    break;
  }
  assert.ok(found > 0, 'a dive staged on one of the roads');
});

test('a car already cleared off the player\'s route is no rival: a new route could not turn it back', () => {
  const S = sim({ seed: 2, traffic: 1, peds: 0, incidents: 0, contest: 'off' });
  toDrive(S);
  const W = S.world;
  step(S, 300);
  const route = S.game.nav.route;
  const onRoute = {};
  for (const d of route.dirEdges) onRoute[d] = true;
  const held = S.vehicles.filter((c) => c.active && !c.isPlayer && c.mode === 'LANE' && c._t.pg > 0);
  assert.ok(held.length > 0, 'cars with grants');
  for (const car of held) {
    const to = W.lanes[W.conns[car._t.plan[0]].to].dirEdge;
    assert.equal(TLV.traffic._leavesRoute(S, car, { [to]: true }), car._t.pg > 1 && !Array.from({ length: car._t.pg }, (_, i) => W.lanes[W.conns[car._t.plan[i]].to].dirEdge).every((d) => d === to));
    assert.equal(TLV.traffic._leavesRoute(S, car, {}), true);
  }
});

/** A lane with a crossing far enough up it to have road either side. */
const S0 = (l) => l.zones.length > 0 && TLV.world.get('tlv_center').zones[l.zones[l.zones.length - 1]].s0 > 100;

test('nobody starts a pass of the player down a crossing with someone on it', () => {
  const { S, lane, me } = onStraight(9, null, (l) => l.left >= 0 && l.zones.length > 0 && S0(l));
  const zone = S.world.zones[lane.zones[lane.zones.length - 1]];
  const pose = TLV.world.lanes.pointAt(S.world, lane.id, zone.s0 - 25, {});
  TLV.player.setPose(S, pose.x, pose.y, pose.h, 9);
  step(S, 2);
  const car = TLV.traffic.spawn(S, { laneId: lane.id, s: S.traffic.pS - 10, v: me.v, kind: 'sedan', ag: 0.8, force: true });
  assert.ok(car);
  const real = TLV.peds.zoneOccupied;
  TLV.peds.zoneOccupied = () => true;
  try {
    assert.equal(TLV.traffic.command(S, car, { type: 'OVERTAKE', targetId: 0 }), false, `crossing ${(zone.s0 - S.traffic.pS).toFixed(0)} m ahead`);
  } finally {
    TLV.peds.zoneOccupied = real;
  }
});

test('a live parked car is refused on the player, and on any body in the stall', () => {
  const S = sim({ seed: 3, traffic: 1 });
  toDrive(S);
  const ids = [];
  const me = S.player.veh;
  TLV.world.parking.spotsNear(S.world, me.x, me.y, 80, ids);
  const stall = TLV.world.parking.spot(S.world, ids[0]);
  TLV.player.setPose(S, stall.x, stall.y, stall.h, 0);
  assert.equal(TLV.traffic.materializeParked(S, stall.id), null, 'the player stands in it');
  TLV.player.setPose(S, stall.x + 30, stall.y, stall.h, 0);
  const near = [...ids].map((id) => TLV.world.parking.spot(S.world, id)).find((p) => Math.hypot(p.x - me.x, p.y - me.y) > 12);
  const first = TLV.traffic.materializeParked(S, near.id);
  assert.ok(first, 'a free one works');
  assert.equal(TLV.traffic.materializeParked(S, near.id), null, 'a second car does not land on the first');
});

test('a car pinned against something reads the speed its body has, so Recover is in reach', () => {
  const S = sim({ seed: 3 });
  toDrive(S);
  const me = S.player.veh;
  const dt = TLV.const.DT;
  // Held fast, at a speed it does not have: the pose stands, and the throttle keeps putting a little back.
  const push = () => {
    me.vx += 0.1 * Math.cos(me.h);
    me.vy += 0.1 * Math.sin(me.h);
    TLV.player._syncVelocity(S);
    me.px = me.x;
    me.py = me.y;
    TLV.collide.update(S, dt);
  };
  me.vx = 2.79 * Math.cos(me.h);
  me.vy = 2.79 * Math.sin(me.h);
  for (let i = 0; i < 60; i++) push();
  assert.ok(Math.abs(me.v) < 0.2, `reads ${me.v.toFixed(2)} m/s`);
  for (let i = 0; i < 120; i++) {
    push();
    assert.ok(Math.abs(me.v) < TLV.tune.game.recoverMaxV, 'and stays under what Recover asks for');
  }
  // A car that is really going is left alone.
  const free = sim({ seed: 3 });
  toDrive(free);
  const car = free.player.veh;
  car.vx = 5 * Math.cos(car.h);
  car.vy = 5 * Math.sin(car.h);
  TLV.player._syncVelocity(free);
  for (let i = 0; i < 60; i++) {
    car.px = car.x;
    car.py = car.y;
    car.x += car.vx * dt;
    car.y += car.vy * dt;
    TLV.collide.update(free, dt);
  }
  assert.ok(Math.abs(car.v - 5) < 0.01, 'moving as it says');
});

test('the tutorial rival gives up on a player who overshot, and holds for one on his way', () => {
  const S = sim({ seed: 1, traffic: 1, density: 0, errand: 1, peds: 0, incidents: 0, clock: 3000 });
  toDrive(S);
  const g = S.game;
  const spot = TLV.world.parking.spot(S.world, g.errand.bayId);
  TLV.game.flow._setPhase(S, 'SEARCH');
  g._g.searched = true;
  const c = TLV.game.rival.start(S, spot.id, { force: true, spawnOnly: true, back: 30, etaDelta: 0 });
  assert.ok(c);
  S.controlSource = hold({});
  const rival = TLV.traffic.byId(S, c.rivalId);
  g.nav.remaining = 60;
  const keep = TLV.game.nav.update;
  TLV.game.nav.update = () => {};
  try {
    step(S, 60 * 30);
    assert.equal(c._r.done, false, 'a player 60 m out is on his way');
    g.nav.remaining = 400;
    const t0 = S.t;
    until(S, () => c._r.done, T.tutorialAwayS + 4, 'giving up');
    assert.ok(S.t - t0 >= T.tutorialAwayS - 1, `gave up after ${(S.t - t0).toFixed(1)} s`);
    until(S, () => rival.beh === 'CRUISE' || !rival.active, 2, 'driving on');
  } finally {
    TLV.game.nav.update = keep;
  }
});

test('the tutorial road: nothing long stands on it at the start, and it is light for the first errand only', () => {
  const S = sim({ seed: 4, traffic: 1, peds: 0, incidents: 0, contest: 'auto' });
  const W = S.world;
  const route = S.game.nav.route;
  const lanes = Array.from(route.dirEdges).flatMap((d) => [...W.dirEdges[d].lanes]);
  for (const c of S.vehicles) {
    if (c.active && !c.isPlayer && c.mode === 'LANE' && lanes.includes(c.laneId)) assert.ok(c.length <= Q.longBody, `${c.kind} on the tutorial road`);
  }
  assert.equal(S.traffic.calmOn, true);
  const after = sim({ seed: 4, traffic: 1, peds: 0, incidents: 0, errand: 2 });
  assert.equal(after.traffic.calmOn, false, 'only the first errand');
});

test('an aborted incident is replaced at once, not after the gap', () => {
  const S = sim({ seed: 5, errand: 3, traffic: 1, peds: 1, contest: 'off', incidents: 1, immortal: 1 });
  toDrive(S);
  const d = S.game.director;
  d.nextT = 30;
  S.bus.emit('incident.end', { id: 1, defId: 'SLOW_CROSS', outcome: 'ABORTED' });
  assert.ok(d.nextT < 30, 'the gap is owed back');
  const before = d.nextT;
  S.bus.emit('incident.end', { id: 1, defId: 'SLOW_CROSS', outcome: 'AVOIDED' });
  assert.equal(d.nextT, before);
});

test('pacing: on the road after the tutorial the director runs at the design\'s rate, for a driver who keeps moving', () => {
  const counts = [];
  for (let seed = 1; seed <= 3; seed++) {
    const S = sim({ seed, errand: 2, traffic: 1, peds: 1, incidents: 1, contest: 'off', immortal: 1, clock: 3000 });
    toDrive(S);
    S.controlSource = TLV.bots.create('patrol');
    let drive = 0;
    let n = 0;
    S.bus.on('incident.telegraph', () => { n++; });
    for (let i = 0; i < 60 * 180; i++) {
      step(S);
      if (S.game.phase === 'DRIVE') drive++;
    }
    counts.push(n / (drive / 3600));
  }
  const mean = counts.reduce((a, b) => a + b, 0) / counts.length;
  console.log(`incidents per drive-minute: ${counts.map((c) => c.toFixed(1)).join(' ')}`);
  assert.ok(mean >= 5, `${mean.toFixed(1)} per minute`);
});
