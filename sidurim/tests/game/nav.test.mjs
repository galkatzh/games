// tests/game/nav.test.mjs — WP-GAME
// ARCHITECTURE 19 item 13 and GAME_DESIGN 24 row 6: the route to the bay, the arrow, and the rules for losing the route.
import test from 'node:test';
import { assert, realTLV, sim, step, until, toDrive, events, bayOf, hold, onRoute } from './helpers.mjs';

const TLV = realTLV();
const W = TLV.world.get('tlv_center');

test('row 6: the route is legal under one-ways and every turn is in the moves table', () => {
  for (let seed = 1; seed <= 30; seed++) {
    const S = sim({ seed, errand: 1 + (seed % 6) });
    const r = S.game.nav.route;
    assert.ok(r, 'a route');
    const path = r.dirEdges;
    for (let i = 0; i + 1 < path.length; i++) {
      assert.ok(W.dirEdges[path[i]].moves.includes(path[i + 1]), 'a legal move');
      assert.ok(W.dirEdges[path[i]].lanes.length > 0, 'a direction with lanes');
    }
    const bay = bayOf(S);
    assert.equal(path[path.length - 1], W.lanes[bay.laneId].dirEdge, 'it ends at the bay, not the door');
  }
});

test('row 6: the arrow stays within 45 deg of the next route segment, driven along the route, on many seeds', () => {
  let checked = 0;
  let total = 0;
  const worst = [];
  for (const [seed, errand] of [[1, 2], [2, 3], [3, 2], [4, 4], [5, 3], [6, 5], [7, 2], [8, 3], [9, 4], [10, 2], [11, 3], [12, 6]]) {
    const S = sim({ seed, errand });
    toDrive(S);
    const r = S.game.nav.route;
    const n = S.game.nav;
    let good = 0;
    let all = 0;
    for (let s = 0; s < r.len - 40; s += 9) {
      const at = TLV.math.polyAt(r.px, r.py, r.cum, s, {});
      TLV.player.setPose(S, at.x, at.y, at.h, 5);
      step(S, 1);
      const seg = TLV.math.polyAt(r.px, r.py, r.cum, n.s + 3, {});
      all++;
      if (Math.abs(TLV.math.wrapPi(n.arrowH - seg.h)) <= Math.PI / 4) good++;
    }
    checked += good;
    total += all;
    worst.push(good / all);
  }
  // The arrow points 30 m on, so it leads the car through a corner: it is the corners that miss.
  assert.ok(checked >= total * 0.95, `${checked} of ${total}`);
  assert.ok(Math.min(...worst) >= 0.85, `worst seed ${Math.min(...worst)}`);
});

test('the door stays only a marker: remaining and SEARCH read the bay', () => {
  const S = sim({ seed: 3, errand: 2 });
  const n = S.game.nav;
  const bay = bayOf(S);
  assert.equal(n.targetX, bay.x);
  assert.equal(n.targetY, bay.y);
  assert.ok(Math.abs(n.remaining - n.route.len) < 3);
});

test('item 13: off route: 25 m off for 1 s recalculates, at most once a second, and sends nav.recalc', () => {
  const S = sim({ seed: 4, errand: 2 });
  toDrive(S);
  const n = S.game.nav;
  const first = n.route;
  // A lane well away from the route.
  const far = W.lanes.find((l) => {
    if (!(l.flags & 1) || l.len < 40) return false;
    const p = TLV.world.routing.project(first, l.px[0], l.py[0], null, {});
    return p.d > 60 && p.d < 300;
  });
  const at = TLV.world.lanes.pointAt(W, far.id, 20, {});
  TLV.player.setPose(S, at.x, at.y, at.h, 0);
  step(S, 30);
  assert.equal(n.route, first, 'not for half a second');
  assert.equal(n.offRoute, true);
  until(S, () => n.route !== first, 0.8, 'recalc');
  assert.equal(events(S, 'nav.recalc').length, 1);
  assert.ok(n.remaining < Infinity);
  const after = n.route;
  TLV.player.setPose(S, at.x + 2000, at.y, at.h, 0);
  step(S, 20);
  assert.equal(n.route, after, 'at most once a second, even off the map');
});

test('item 13: wrong way: 2 s of it recalculates', () => {
  const S = sim({ seed: 4, errand: 2 });
  toDrive(S);
  const n = S.game.nav;
  const first = n.route;
  S.player.wrongWay = true;
  // Held by the test, as the player's flag would be in a real run.
  for (let i = 0; i < 100; i++) {
    S.player.wrongWay = true;
    step(S, 1);
  }
  assert.equal(n.route, first, 'not at 1.7 s');
  for (let i = 0; i < 30 && n.route === first; i++) {
    S.player.wrongWay = true;
    step(S, 1);
  }
  assert.notEqual(n.route, first);
});

test('item 13: no route from where the car points: the nearest AI lane in 60 m, whichever way it runs', () => {
  const S = sim({ seed: 5, errand: 2 });
  toDrive(S);
  const n = S.game.nav;
  // A lane with no way out in the player's graph: route() from it finds nothing, so the rule has to look wider.
  const orig = TLV.world.routing.route;
  let calls = 0;
  TLV.world.routing.route = (...args) => {
    calls++;
    return null;
  };
  try {
    n.recalcT = 0;
    S.game.nav.offRouteT = 5;
    const bay = bayOf(S);
    TLV.game.nav.setTarget(S, bay.laneId, bay.laneS, bay.x, bay.y);
  } finally {
    TLV.world.routing.route = orig;
  }
  assert.ok(calls >= 1);
  assert.ok(n.route, 'the fallback found a way');
  assert.ok(n.remaining < Infinity);
});

test('item 13: no route at all: the arrow is the direct bearing and remaining is Infinity', () => {
  const S = sim({ seed: 5, errand: 2 });
  toDrive(S);
  const n = S.game.nav;
  const r1 = TLV.world.routing.route;
  const r2 = TLV.world.routing.routeLanes;
  TLV.world.routing.route = () => null;
  TLV.world.routing.routeLanes = () => null;
  try {
    const bay = bayOf(S);
    TLV.game.nav.setTarget(S, bay.laneId, bay.laneS, bay.x, bay.y);
    step(S, 2);
    assert.equal(n.route, null);
    assert.equal(n.remaining, Infinity);
    const bearing = Math.atan2(bay.y - S.player.fy, bay.x - S.player.fx);
    assert.ok(Math.abs(TLV.math.wrapPi(n.arrowH - bearing)) < 1e-6);
  } finally {
    TLV.world.routing.route = r1;
    TLV.world.routing.routeLanes = r2;
  }
  n.recalcT = 0;
  until(S, () => n.route !== null, 2, 'it keeps trying');
});

test('on foot the arrow is the direct bearing to the door, never the car route', () => {
  const S = sim({ seed: 6, errand: 2, traffic: 1, density: 0, peds: 1 });
  toDrive(S);
  TLV.debug.use(S);
  TLV.debug.forceKnife({ stage: 'CHASE', gap: 12 });
  step(S, 5);
  const n = S.game.nav;
  const e = S.game.errand;
  const bearing = Math.atan2(e.doorY - S.player.fy, e.doorX - S.player.fx);
  assert.ok(Math.abs(TLV.math.wrapPi(n.arrowH - bearing)) < 1e-6);
});

test('a route is replaced, never edited in place', () => {
  const S = sim({ seed: 7, errand: 2 });
  const n = S.game.nav;
  const r = n.route;
  const dirs = Array.from(r.dirEdges);
  const bay = bayOf(S);
  TLV.game.nav.setTarget(S, bay.laneId, bay.laneS, bay.x, bay.y);
  assert.notEqual(n.route, r);
  assert.deepEqual(Array.from(r.dirEdges), dirs);
});

test('the first leg is about 460 m to the bay, on HaNeviim, with a right turn out of King George', () => {
  const S = sim({ seed: 1 });
  const r = S.game.nav.route;
  assert.ok(r.len > 400 && r.len < 520, `${r.len.toFixed(0)} m`);
  const names = Array.from(r.dirEdges).map((d) => W.edges[W.dirEdges[d].edge].nameEn);
  assert.equal(names[0], 'HaMelekh George');
  assert.equal(names[1], 'HaNeviim Avenue');
  assert.equal(TLV.world.junctions.connFor(W, S.player.laneId, r.dirEdges[1]) >= 0, true);
});

/** The car on the bay's lane, `past` metres beyond the bay's centre (negative: short of it), with the rival and traffic out of it. */
function byBay(past, o = {}) {
  const S = sim({ seed: 3, errand: 2, traffic: 0, ...o });
  toDrive(S);
  const bay = bayOf(S);
  const lane = W.lanes[bay.laneId];
  const at = TLV.math.polyAt(lane.px, lane.py, lane.cum, bay.laneS + past, {});
  TLV.player.setPose(S, at.x, at.y, at.h, 0);
  step(S, 2);
  return { S, bay, n: S.game.nav };
}

const bearingTo = (S, bay) => Math.atan2(bay.y - S.player.fy, bay.x - S.player.fx);

// Rule changed by decision: the arrow used to aim at the bay's centre from 15 m out, and that line runs through the car parked in front
// of the bay. A driver following it hit that car on 41 of 41 bays. It now holds the lane to the funnel's near end, then leads along the
// box's axis. The distance is still to the box from 15 m.
test('short of the funnel the arrow stays on the lane, and only from the funnel does it turn into the box', () => {
  const funnel = (TLV.tune.world.spotLen + TLV.tune.game.funnelExtraM) / 2;
  for (const back of [14, 8, funnel + 0.5]) {
    const { S, bay, n } = byBay(-back);
    const lane = W.lanes[bay.laneId];
    const beside = TLV.math.polyAt(lane.px, lane.py, lane.cum, bay.laneS, {});
    assert.ok(Math.abs(TLV.math.wrapPi(n.arrowH - Math.atan2(beside.y - S.player.fy, beside.x - S.player.fx))) < 1e-6, `${back} m short: on the lane`);
    assert.ok(Math.abs(TLV.math.wrapPi(n.arrowH - S.player.veh.h)) < 0.1, `${back} m short: straight on`);
    assert.ok(n.remaining >= TLV.math.dist(S.player.fx, S.player.fy, bay.x, bay.y) - 1e-6, 'and the distance is to the box');
  }
  for (const back of [funnel - 0.5, 2, 0]) {
    const { S, bay, n } = byBay(-back);
    const turn = TLV.math.wrapPi(n.arrowH - S.player.veh.h);
    const side = Math.sign(TLV.math.wrapPi(bearingTo(S, bay) - S.player.veh.h));
    assert.ok(turn * side > 0.2, `${back} m short: it turns toward the box, ${turn.toFixed(2)} rad`);
    assert.ok(Math.abs(turn) < Math.PI / 2, `${back} m short: and leads on into it`);
    assert.ok(n.remaining >= TLV.math.dist(S.player.fx, S.player.fy, bay.x, bay.y) - 1e-6, 'and the distance is to the box');
  }
  const { S, bay, n } = byBay(0);
  onRoute(S, 25);
  step(S, 2);
  const end = TLV.math.polyAt(n.route.px, n.route.py, n.route.cum, n.route.len, {});
  assert.ok(Math.abs(TLV.math.wrapPi(n.arrowH - Math.atan2(end.y - S.player.fy, end.x - S.player.fx))) < 1e-6, 'further out it still leads down the route');
  assert.ok(Math.abs(TLV.math.wrapPi(n.arrowH - bearingTo(S, bay))) > 1e-3);
});

/** Steers by nothing but the arrow, at a walking pace, and stops in the box. */
function arrowDriver(bay) {
  const c = TLV.const._newControls();
  return (S) => {
    Object.assign(c, TLV.const._newControls());
    const veh = S.player.veh;
    const alpha = TLV.math.wrapPi(S.game.nav.arrowH - veh.h);
    c.steer = TLV.math.clamp(Math.atan2(2 * veh.wheelbase * Math.sin(alpha), 5) / TLV.player._steerMax(Math.abs(veh.v)), -1, 1);
    const a = (veh.x - bay.x) * Math.cos(bay.h) + (veh.y - bay.y) * Math.sin(bay.h);
    const l = (veh.y - bay.y) * Math.cos(bay.h) - (veh.x - bay.x) * Math.sin(bay.h);
    if (a > 3 || (a > 0.5 && Math.abs(l) < 0.8)) c.brake = 1;
    else if (veh.v < 3.5) c.throttle = 0.5;
    else if (veh.v > 4) c.brake = 0.3;
    return c;
  };
}

test('a driver who only follows the arrow into a bay with a car parked short of it touches nothing, and arms', () => {
  const parking = TLV.world.parking;
  let bays = 0;
  for (let seed = 1; seed <= 24; seed++) {
    const S = sim({ seed, errand: 2 + (seed % 3) });
    toDrive(S);
    const bay = bayOf(S);
    const ids = [];
    parking.spotsNear(W, bay.x, bay.y, 12, ids);
    const short = ids.map((id) => parking.spot(W, id)).find((o) => o.laneId === bay.laneId && bay.laneS - o.laneS > 0 && bay.laneS - o.laneS < 8);
    if (!short) continue;
    parking.setState(S, short.id, TLV.const.OCC.PARKED);
    const lane = W.lanes[bay.laneId];
    const at = TLV.math.polyAt(lane.px, lane.py, lane.cum, Math.max(1, bay.laneS - 25), {});
    TLV.player.setPose(S, at.x, at.y, at.h, 4);
    TLV.game.nav.setTarget(S, bay.laneId, bay.laneS, bay.x, bay.y);
    S.controlSource = arrowDriver(bay);
    until(S, (s) => s.game.phase === 'HOLD', 14, `seed ${seed}: arming`);
    assert.deepEqual(events(S, 'player.contact'), [], `seed ${seed}: no contact`);
    bays++;
  }
  assert.ok(bays >= 12, `${bays} bays`);
});

test('rolled past the box: the arrow turns back, the distance grows, nav.missed says so, once, and backing up clears it', () => {
  const { S, bay, n } = byBay(-1);
  assert.equal(n.missed, null);
  assert.equal(events(S, 'nav.recalc').length, 0);
  const lane = W.lanes[bay.laneId];
  const at = TLV.math.polyAt(lane.px, lane.py, lane.cum, bay.laneS + 9, {});
  TLV.player.setPose(S, at.x, at.y, at.h, 0);
  step(S, 2);
  assert.ok(Math.abs(TLV.math.wrapPi(n.arrowH - S.player.veh.h)) > 2.2, 'it points behind the car');
  assert.ok(Math.abs(TLV.math.wrapPi(n.arrowH - bearingTo(S, bay))) < 1e-6);
  assert.ok(n.remaining > 8.9, `reads ${n.remaining}, never a stuck 0`);
  assert.equal(n.missed, 'BACK_OR_Q');
  assert.equal(events(S, 'nav.recalc').length, 1);
  step(S, 120);
  assert.equal(events(S, 'nav.recalc').length, 1, 'said once');
  const back = TLV.math.polyAt(lane.px, lane.py, lane.cum, bay.laneS + 3, {});
  TLV.player.setPose(S, back.x, back.y, back.h, 0);
  step(S, 2);
  assert.equal(n.missed, null, 'back in the funnel');
});

test('a missed bay out of Q range offers only the reverse', () => {
  const { S, n } = byBay(9);
  const e = S.game.errand;
  e.doorX = S.player.fx + TLV.tune.game.doorQM + 40;
  e.doorY = S.player.fy;
  step(S, 2);
  assert.equal(n.missed, 'BACK');
  assert.ok(n.remaining > 8.9);
});

test('driving on from a missed bay: 25 m off for 1 s still reroutes, and the miss is over', () => {
  const { S, bay, n } = byBay(9);
  const first = n.route;
  assert.equal(n.missed, 'BACK_OR_Q');
  const lane = W.lanes[bay.laneId];
  const at = TLV.math.polyAt(lane.px, lane.py, lane.cum, bay.laneS + 45, {});
  assert.ok(Math.hypot(at.x - bay.x, at.y - bay.y) > TLV.tune.game.navOffM + 2, 'this bay has the road for it');
  TLV.player.setPose(S, at.x, at.y, at.h, 0);
  step(S, 70);
  assert.notEqual(n.route, first, 'a new route');
  assert.equal(n.missed, null);
  assert.ok(n.remaining > TLV.tune.game.navBayAimM);
});

test('a bay on the next street stays behind the route: the arrow never aims through a block', () => {
  const { S, bay, n } = byBay(0);
  const lane = W.lanes[bay.laneId];
  // Off the bay's road, 12 m from the bay, with the route's tail still long: a bay across a block.
  const other = W.lanes.find((l) => l.dirEdge >> 1 !== lane.dirEdge >> 1 && l.len > 30);
  TLV.player.setPose(S, other.px[1], other.py[1], 0, 0);
  S.player.laneId = other.id;
  const save = { x: n.targetX, y: n.targetY };
  n.targetX = S.player.veh.x + 12;
  n.targetY = S.player.veh.y;
  TLV.game.nav.update(S, 1 / 60);
  const left = n.route.len - n.s;
  assert.ok(left > TLV.tune.game.navBayAimM, 'a route still to run');
  assert.ok(Math.abs(n.remaining - left) < 1e-6, 'it reads the road, not the straight line');
  assert.ok(Math.abs(TLV.math.wrapPi(n.arrowH)) > 1e-3, 'and leads along it');
  n.targetX = save.x;
  n.targetY = save.y;
});
