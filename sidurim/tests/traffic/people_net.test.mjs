// tests/traffic/people_net.test.mjs — WP-TRAFFIC
// AI cars never touch anyone (GAME_DESIGN 9, ARCHITECTURE 17.3). In the game soaks every fast contact was a car placed at speed on a person,
// so a new car looks for people first. The rest were cars moving off beside someone, or stepped in front of inside their stopping room,
// and for those a move into a person's radius does not happen.
import test from 'node:test';
import { assert, realTLV, sim, step, toDrive } from '../game/helpers.mjs';

const TLV = realTLV();
const W = TLV.world.get('tlv_center');

/** A long straight AI lane, away from where any test's player starts. */
function longLane(S) {
  const me = S.player.veh;
  return W.lanes.find((l) => l.len > 150 && (l.flags & TLV.const.LF.AI_ROUTABLE) && Math.hypot(l.px[0] - me.x, l.py[0] - me.y) > 300 &&
    Math.abs(TLV.math.wrapPi(Math.atan2(l.py[l.py.length - 1] - l.py[0], l.px[l.px.length - 1] - l.px[0]) - Math.atan2(l.py[1] - l.py[0], l.px[1] - l.px[0]))) < 0.05);
}

/** Parks the player at the far end of a lane, so cars near him stay in the bubble. */
function watch(S, lane) {
  const at = TLV.world.lanes.pointAt(W, lane.id, lane.len - 8, {});
  TLV.player.setPose(S, at.x, at.y, at.h, 0);
  step(S, 2);
}

/** A person standing on a lane at s: the one kind of person a test can put exactly there, and who stays. */
function standing(S, lane, s) {
  const at = TLV.world.lanes.pointAt(W, lane.id, s, {});
  return TLV.game.attacker.spawn(S, at.x, at.y, at.h);
}

test('a new car is not placed on anyone, or where it could not stop for them', () => {
  const S = sim({ seed: 2, errand: 2, traffic: 1, density: 3, peds: 1 });
  toDrive(S);
  const lane = longLane(S);
  watch(S, lane);
  standing(S, lane, 100);
  assert.equal(TLV.traffic.spawn(S, { laneId: lane.id, s: 100, v: 0 }), null, 'on him');
  assert.equal(TLV.traffic.spawn(S, { laneId: lane.id, s: 98, v: 0 }), null, 'its nose on him');
  assert.equal(TLV.traffic.spawn(S, { laneId: lane.id, s: 85, v: 14 }), null, 'at 14 m/s it needs more room than this');
  const car = TLV.traffic.spawn(S, { laneId: lane.id, s: 60, v: 14 });
  assert.ok(car, 'with the room, it is placed');
  step(S, 300);
  assert.equal(S.pedsys.contacts, 0);
  assert.ok(car.active && car.s < 100 - car.length / 2, 'it stopped short of him');
});

test('someone stepping out inside a car\'s stopping room is not touched: the car stops dead', () => {
  const S = sim({ seed: 2, errand: 2, traffic: 1, density: 3, peds: 1 });
  toDrive(S);
  const lane = longLane(S);
  watch(S, lane);
  const car = TLV.traffic.spawn(S, { laneId: lane.id, s: 40, v: 12 });
  step(S, 30);
  const man = standing(S, lane, car.s + car.length / 2 + 4);
  step(S, 120);
  assert.equal(S.pedsys.contacts, 0);
  assert.ok(car.active, 'still here');
  assert.ok(car.s < TLV.world.lanes.project(W, man.x, man.y, car.h, 3, {}).s - car.length / 2, 'stopped short of him');
  assert.ok(TLV.peds.walk.bodyDist(car, man.x, man.y) >= man.r - 0.02);
});

test('a car standing beside someone moves off along them, and never onto them', () => {
  const S = sim({ seed: 2, errand: 2, traffic: 1, density: 3, peds: 1 });
  toDrive(S);
  const lane = longLane(S);
  watch(S, lane);
  const car = TLV.traffic.spawn(S, { laneId: lane.id, s: 60, v: 0 });
  step(S, 2);
  const c = Math.cos(car.h);
  const s = Math.sin(car.h);
  const off = car.width / 2 + 0.4;
  TLV.game.attacker.spawn(S, car.x + c * (car.length / 2 + 1) - s * off, car.y + s * (car.length / 2 + 1) + c * off, car.h);
  const man = S.peds.find((p) => p.active && p.kind === 'attacker');
  man.r = 0.5;
  step(S, 300);
  assert.ok(car.active);
  assert.equal(S.pedsys.contacts, 0);
});

test('nobody appears on a vehicle\'s body', () => {
  const S = sim({ seed: 2, errand: 2, traffic: 1, peds: 1 });
  toDrive(S);
  let near = 0;
  S.bus.on('ped.spawn', (e) => {
    const p = TLV.peds.byId(S, e.pedId);
    if (p.state === 'DROPPED' || p.kind === 'attacker') return;
    for (const v of S.vehicles) if (v.active && TLV.peds.walk.bodyDist(v, p.x, p.y) < 1 && p._p.job === 'AMBIENT') near++;
  });
  step(S, 60 * 40);
  assert.equal(near, 0);
});

test('someone set down clear of a body is checked where they land, not at the place asked for', () => {
  // Seed 1, patrol, N 100: a staged trolley asked for at a crossing 2 m clear of a bus, and landed on the nearest row, 3.9 m off, in its tail.
  const S = sim({ seed: 2, errand: 2, traffic: 1, density: 3, peds: 1 });
  toDrive(S);
  const walks = TLV.world.sidewalks;
  const peds = TLV.peds;
  const lane = longLane(S);
  const xing = W.xings.find((x) => {
    const row = walks.nearest(W, x.x, x.y, {});
    return row && row.d > 3 && row.d < 5 && !peds._bodyAt(S, x.x, x.y);
  });
  const row = walks.nearest(W, xing.x, xing.y, {});
  const at = walks.pointAt(W, row.sw, row.s, {});
  const bus = TLV.traffic.spawn(S, { kind: 'bus', laneId: lane.id, s: 30, v: 0, force: true });
  bus.x = at.x;
  bus.y = at.y;
  bus.h = Math.atan2(at.y - xing.y, at.x - xing.x) + Math.PI / 2;
  TLV.traffic.idm.broadphase(S);
  assert.equal(peds._bodyAt(S, xing.x, xing.y), false, 'the crossing itself looks clear');
  const free = S.pedsys.nFree;
  assert.equal(peds.spawn(S, { kind: 'trolley', x: xing.x, y: xing.y, clear: true }), null);
  assert.equal(S.pedsys.nFree, free, 'and the slot went back');
  const p = peds.spawn(S, { kind: 'trolley', x: xing.x, y: xing.y });
  assert.ok(p, 'without the ask, they are placed');
  peds.despawn(S, p);
});

test('a body someone is standing in stays where it is until they are out, and then goes', () => {
  // Seed 91, tick 13227. A person clearing a held zone walks through a stopped bus, and it pulled away with her inside.
  const S = sim({ seed: 2, errand: 2, traffic: 1, density: 3, peds: 1 });
  toDrive(S);
  const lane = longLane(S);
  watch(S, lane);
  const bus = TLV.traffic.spawn(S, { laneId: lane.id, s: 60, v: 0, kind: 'bus' });
  assert.ok(bus, 'placed');
  const held = standing(S, lane, bus.s - 5);
  // Behind the nose, where nothing but the net can see her: what the scan brakes for is ahead of the body.
  held.x = bus.x - Math.cos(bus.h) * (bus.length / 2 - 1);
  held.y = bus.y - Math.sin(bus.h) * (bus.length / 2 - 1);
  const start = bus.s;
  step(S, 120);
  assert.ok(Math.abs(bus.s - start) < 0.01, `it moved ${bus.s - start} m with someone in it`);
  held.x = bus.x + Math.cos(bus.h) * 60;
  held.y = bus.y + Math.sin(bus.h) * 60;
  step(S, 240);
  assert.ok(bus.s > start + 1, `with them gone it went ${bus.s - start} m`);
});
