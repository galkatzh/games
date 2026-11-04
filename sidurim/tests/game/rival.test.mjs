// tests/game/rival.test.mjs — WP-GAME
// ARCHITECTURE 19 items 4 and 5 on tlv_center, with real traffic. The first tests are the hardest integration in the design: a rival
// on the player's own one-lane road, and a capture worth PERFECT with him there.
import test from 'node:test';
import { assert, realTLV, sim, step, until, toDrive, events, bayOf, inBay, atLaneCentre, onRoute, parker, hold } from './helpers.mjs';

const TLV = realTLV();
const W = TLV.world.get('tlv_center');
const T = TLV.tune.game;
const OCC = TLV.const.OCC;

/** A stall on a long one-lane or two-lane road, with road to run up to it and stalls beyond it. */
function findStall(oneLane) {
  const S = sim({ seed: 1 });
  const ids = [];
  for (const lane of W.lanes) {
    if (!(lane.flags & 1) || lane.len < 130 || lane.conns.length === 0) continue;
    if (W.dirEdges[lane.dirEdge].lanes.length !== (oneLane ? 1 : 2) || lane.right >= 0) continue;
    const mid = TLV.world.lanes.pointAt(W, lane.id, 80, {});
    if (TLV.world.spatial.sensitiveNear(W, mid.x, mid.y, 90)) continue;
    TLV.world.parking.spotsNear(W, mid.x, mid.y, 12, ids);
    const spot = ids.map((id) => TLV.world.parking.spot(W, id)).find((sp) => sp.laneId === lane.id && sp.laneS > 70 && sp.laneS < lane.len - 45);
    if (!spot || TLV.game.rival._anchorFor(S, spot) < 0) continue;
    // Straight, because the scripted parker steers in the stall's own frame.
    const near = (s) => inBay(spot, TLV.world.lanes.pointAt(W, lane.id, s, {})).l;
    const line = near(spot.laneS);
    if (Math.abs(near(spot.laneS - 65) - line) < 0.4 && Math.abs(near(spot.laneS + 25) - line) < 0.4) return spot;
  }
  throw new Error('no stall');
}

const ONE_LANE = findStall(true);
console.log(`one-lane stall ${ONE_LANE.id} on ${W.edges[ONE_LANE.edge].nameEn || W.edges[ONE_LANE.edge].name}, lane ${ONE_LANE.laneId}`);

/** Makes a stall the bay of this errand, with parked neighbours, and a door 90 m on along the road. */
function useStall(S, spot) {
  const ids = [];
  TLV.world.parking.spotsNear(W, spot.x, spot.y, 40, ids);
  for (const id of ids) TLV.world.parking.setState(S, id, id === spot.id ? OCC.FREE : OCC.PARKED);
  const e = S.game.errand;
  const door = TLV.world.lanes.pointAt(W, spot.laneId, Math.min(spot.laneS + 90, W.lanes[spot.laneId].len - 2), {});
  e.doorX = door.x;
  e.doorY = door.y;
  e.decoys = [];
  TLV.game.parking._setBay(S, spot.id);
  assert.ok(e._doorM <= 150, `door ${e._doorM} m`);
}

/** The car on lane centre pback short of the bay, and a rival placed back metres short of it. */
function setup(seed, errand, back, pback, opts = {}) {
  const S = sim({ seed, errand, traffic: 1, density: 0, ...opts.params });
  toDrive(S);
  useStall(S, opts.stall || ONE_LANE);
  const spot = bayOf(S);
  atLaneCentre(S, spot, pback, opts.v || 0);
  TLV.game.flow._setPhase(S, 'SEARCH');
  S.game._g.searched = true;
  const c = TLV.game.rival.start(S, spot.id, { force: true, spawnOnly: true, back, etaDelta: opts.etaDelta === undefined ? 0 : opts.etaDelta, rage: opts.rage });
  assert.ok(c, 'contest');
  return { S, spot, c, rival: TLV.traffic.byId(S, c.rivalId) };
}

const seedOne = 1;
const seedTwo = 1;

test('the hardest case: tutorial rival ahead on the road, PERFECT from lane centre, and the #@! bubble', () => {
  const { S, spot, c, rival } = setup(seedOne, 1, 30, 50);
  assert.equal(c.ctl.holdCreep, true, 'errand 1: he holds');
  assert.equal(c._r.plan, 'PAST');
  S.controlSource = parker(spot);
  until(S, (s) => s.game.phase === 'PAYOUT', 30, 'parked');
  const e = S.game.errand;
  assert.equal(e.quality, 'PERFECT');
  assert.equal(S.game.contest.steal, true);
  assert.equal(S.game.contest.winner, 'player');
  assert.equal(S.game.contest.tier, 'CURSE', 'capped at 44, so he only swears');
  assert.ok(S.game.contest.rage <= 44);
  assert.equal(S.game.stats.spotsStolen, 1);
  assert.ok(rival.mode === 'LANE', 'he never touched the stall');
  assert.ok(inBay(spot, rival).a > (spot.len + T.funnelExtraM) / 2 + rival.length / 2 - 0.1, `he stands past the funnel: a ${inBay(spot, rival).a.toFixed(1)}`);
  assert.equal(S.game.contacts, 0);
  step(S, 30);
  assert.equal(events(S, 'contest.result').length, 1);
  assert.deepEqual(events(S, 'contest.result')[0], { winner: 'player', tier: 'CURSE' });
  assert.equal(events(S, 'bubble', (b) => b.who === 'veh' && b.text === '#@!').length, 1);
  assert.equal(S.game.errand.pay, Math.round((T.payBase + T.payPerM * e.routeLen) * 1.5 * 1.5), 'PERFECT and SPOTLESS, as ever');
});

test('the steal: a rival ahead on a one-lane road rolls past, the player takes it PERFECT, and the first knife comes', () => {
  const { S, spot, c, rival } = setup(seedTwo, 2, 30, 38, { v: 5 });
  assert.equal(W.dirEdges[W.lanes[spot.laneId].dirEdge].lanes.length, 1, 'no way round him');
  S.controlSource = parker(spot, { v: 5 });
  until(S, (s) => s.game.phase !== 'SEARCH' && s.game.phase !== 'DRIVE', 30, 'arm');
  assert.equal(c._r.plan, 'PAST', 'he went past the bay');
  assert.equal(c.state, 'DENIED');
  until(S, (s) => s.game.phase === 'PAYOUT', 8, 'parked');
  assert.ok(['PERFECT', 'GOOD'].includes(S.game.errand.quality), S.game.errand.quality);
  assert.equal(c.steal, true);
  assert.equal(c.tier, 'KNIFE', 'floored to 75 on errand 2');
  assert.equal(events(S, 'errand.parked')[0].pay, null);
  until(S, (s) => s.game.phase === 'ENCOUNTER', 2, 'ENCOUNTER');
  assert.equal(S.game.knife.stage, 'STANDOFF');
  assert.ok(rival.active);
});

test('item 4: every state: CRUISE, BLINK, CREEP, COMMIT and WON, with the player far back', () => {
  const { S, c } = setup(seedTwo, 2, 45, 60, { etaDelta: -3 });
  const spot = bayOf(S);
  assert.equal(c.state, 'CRUISE');
  S.controlSource = hold({ brake: 1 });
  TLV.player.setPose(S, S.player.veh.x, S.player.veh.y, S.player.veh.h, 0);
  until(S, (s) => s.game.errand.bayId !== spot.id || c.state === 'FAILED', 20, 'he parks');
  const states = events(S, 'contest.state').map((e) => e.state);
  assert.deepEqual(states, ['BLINK', 'CREEP', 'COMMIT', 'WON']);
  assert.equal(c.winner, 'rival');
  assert.equal(events(S, 'contest.result')[0].winner, 'rival');
});

test('item 4: FAILED: a rival who vanishes ends the contest, the bay stays open, and no state is left', () => {
  const { S, spot, c, rival } = setup(seedTwo, 2, 45, 60);
  TLV.traffic.despawn(S, rival, 'script');
  step(S, 2);
  assert.equal(c.state, 'FAILED');
  assert.deepEqual(events(S, 'contest.result')[0], { winner: null, tier: null });
  S.controlSource = parker(spot);
  until(S, (s) => s.game.phase === 'PAYOUT', 25, 'parks');
  assert.equal(c.tier, null);
});

test('item 4: rival win leads to the next bay, whose car pulls out; the third bay is free', () => {
  const { S, c } = setup(seedTwo, 2, 45, 60, { etaDelta: -3 });
  const first = bayOf(S);
  S.controlSource = hold({ brake: 1 });
  until(S, (s) => s.game.errand.bayId !== first.id, 15, 'he parks');
  const e = S.game.errand;
  assert.equal(c.state, 'WON');
  assert.ok(e.bayId >= 0, 'a next bay');
  const second = bayOf(S);
  assert.notEqual(second.id, first.id);
  assert.equal(S.game.nav.route.dirEdges[S.game.nav.route.dirEdges.length - 1], W.lanes[second.laneId].dirEdge, 'nav follows it');
  assert.equal(events(S, 'errand.search', (x) => x.bayId === second.id).length, 1);
  const route = TLV.world.routing.routeLanes(W, first.laneId, first.laneS, second.laneId, second.laneS, { ai: true });
  assert.ok(route.len <= T.nextBayMaxM, 'within 150 m directed');
  // Its car, if it had one, leaves by a live pull-out, so nothing vanishes in view.
  if (e._pullId >= 0) {
    const car = TLV.traffic.byId(S, e._pullId);
    assert.ok(car && car.beh === 'PULLOUT');
    until(S, () => TLV.world.parking.state(S, second.id) === OCC.FREE, 12, 'pulled out');
  }
  assert.equal(TLV.world.parking.state(S, first.id), OCC.VEHICLE, 'he is in the first bay');
  assert.equal(e.contests, 1);
  // The second contest, then the third bay has none.
  const second2 = TLV.game.rival.start(S, e.bayId, { force: true, spawnOnly: true, back: 20 });
  assert.ok(second2);
  assert.equal(e.contests, 2);
  S.game.contest.winner = 'rival';
  S.game.contest._r.done = true;
  S.game._g.contestDue = false;
  TLV.game.parking._bayLost(S);
  assert.equal(S.game._g.contestDue, false, 'the third bay is free');
  assert.ok(S.game.errand.bayId >= 0);
});

test('item 4: AFTER YOU pays +₪50 and +5 s for waiting behind a committed rival', () => {
  const { S, c, rival } = setup(seedTwo, 2, 17, 25);
  S.controlSource = hold({});
  const money = S.game.money;
  const clock = S.game.clock;
  until(S, () => c.state === 'WON', 14, 'he parks');
  assert.equal(events(S, 'score.bonus', (b) => b.id === 'AFTER_YOU').length, 1);
  assert.equal(S.game.money, money + T.afterYouPay);
  assert.ok(S.game.clock > clock + T.afterYouS - 4, 'and the clock');
  assert.ok(rival.active);
  assert.notEqual(S.game.errand.bayId, ONE_LANE.id, 'the next bay is revealed at once');
});

test('no AFTER YOU for a player who was only slow', () => {
  const { S, c } = setup(seedTwo, 2, 17, 25);
  S.controlSource = hold({ throttle: 0.3 });
  until(S, () => c.state === 'WON', 14, 'he parks');
  assert.equal(events(S, 'score.bonus', (b) => b.id === 'AFTER_YOU').length, 0);
});

test('item 4: a rival rolled past with nobody coming backs up and takes the bay, and AFTER YOU still pays', () => {
  const { S, c } = setup(seedTwo, 2, 30, 38, { v: 5 });
  const spot = bayOf(S);
  S.controlSource = parker(spot, { v: 5 });
  until(S, () => c._r.plan === 'PAST', 12, 'rolled past');
  // Now the player thinks better of it.
  S.controlSource = hold({ brake: 1 });
  until(S, () => c.state === 'WON' || c.state === 'FAILED', 30, 'back in');
  assert.equal(c.state, 'WON');
  assert.equal(TLV.world.parking.state(S, spot.id), OCC.VEHICLE);
});

test('item 4: arm with him at BLINK, then cancel: DENIED, then back to COMMIT', () => {
  const { S, spot, c, rival } = setup(seedTwo, 2, 38, 70);
  S.controlSource = hold({ brake: 1 });
  until(S, () => (c.state === 'BLINK' || c.state === 'CREEP') && inBay(spot, rival).a > -T.stealM + 1, 10, 'blink');
  TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
  step(S, 1);
  assert.equal(S.game.park.kind, 'BAY');
  assert.equal(c.state, 'DENIED');
  assert.equal(c.steal, true);
  until(S, () => rival.beh === 'PARK_HOLD', 1, 'PARK_HOLD');
  until(S, (s) => s.game.park.stage === 'FILL', 3, 'FILL');
  S.controlSource = hold({ throttle: 1 });
  step(S, 1);
  assert.equal(S.game.park.stage, null);
  assert.equal(c.state, 'COMMIT');
  assert.equal(c.steal, false);
  assert.equal(rival.beh, 'PARK_RACE');
  assert.equal(events(S, 'contest.state').map((e) => e.state).slice(-2).join(), 'DENIED,COMMIT');
});

test('item 4: arming with him in CRUISE is not a steal: no tier, no rage, and he drives on', () => {
  const { S, spot, c, rival } = setup(seedTwo, 2, 60, 12);
  assert.equal(c.state, 'CRUISE');
  TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
  until(S, (s) => s.game.phase === 'PAYOUT', 5, 'parked');
  assert.equal(c.steal, false);
  assert.equal(c.tier, null);
  assert.equal(S.game.stats.spotsStolen, 0);
  step(S, 30);
  assert.deepEqual(events(S, 'contest.result')[0], { winner: 'player', tier: null });
  assert.notEqual(S.game.phase, 'ENCOUNTER');
  assert.ok(rival.beh === 'CRUISE');
});

test('a steal needs him within 25 m of the bay', () => {
  const { S, spot, c } = setup(seedTwo, 2, 45, 12);
  c.state = 'BLINK';
  TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
  step(S, 1);
  assert.equal(c.steal, false, 'at 45 m he is not at the bay');
});

test('a steal also needs his car in reach of the bay in a straight line, whatever the road reads', () => {
  const keep = T.stealLineM;
  try {
    T.stealLineM = 10;
    const { S, spot, c } = setup(seedTwo, 2, 20, 12);
    c.state = 'BLINK';
    TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
    step(S, 1);
    assert.equal(c.steal, false, '20 m along his lane, and past the line');
    assert.equal(c.state, 'FAILED');
  } finally {
    T.stealLineM = keep;
  }
});

/** The contest's rival, swapped for a car on another road in the middle of the same race: one who has gone his own way. */
function lostRival(S, c, rival, laneId, s) {
  c._r.abortRes = true;
  TLV.traffic.despawn(S, rival, 'script');
  c._r.abortRes = false;
  const car = TLV.traffic.spawn(S, { laneId, s, v: 0, force: true });
  assert.ok(car, 'placed');
  assert.equal(TLV.traffic.command(S, car, { type: 'PARK_RACE', spotId: c.spotId, ctl: c.ctl }), true);
  c.rivalId = car.id;
  c.state = 'CREEP';
  return car;
}

/** A stall with a lane position beside it that passes wanted(straight, road), from a road that is not the stall's. */
function stallBeside(wanted) {
  const ids = [];
  const buf = new Int32Array(64);
  for (const lane of W.lanes) {
    if (!(lane.flags & 1) || lane.len < 70 || lane.right >= 0 || W.dirEdges[lane.dirEdge].lanes.length !== 1) continue;
    const mid = TLV.world.lanes.pointAt(W, lane.id, lane.len / 2, {});
    if (TLV.world.spatial.sensitiveNear(W, mid.x, mid.y, 90)) continue;
    TLV.world.parking.spotsNear(W, mid.x, mid.y, lane.len / 2, ids);
    for (const id of ids) {
      const spot = TLV.world.parking.spot(W, id);
      if (spot.laneId !== lane.id || spot.laneS < 45) continue;
      const n = TLV.world.lanes.lanesNear(W, spot.x, spot.y, 26, buf);
      for (let i = 0; i < n; i++) {
        const other = W.lanes[buf[i]];
        if (!(other.flags & 1) || other.edge === lane.edge || other.len < 20) continue;
        for (let at = 6; at < other.len - 6; at += 4) {
          const p = TLV.world.lanes.pointAt(W, other.id, at, {});
          const straight = Math.hypot(p.x - spot.x, p.y - spot.y);
          if (straight <= T.offRouteM + 1 || !wanted(straight, TLV.world.parking.roadDistance(W, p.x, p.y, spot.id))) continue;
          return { spot, laneId: other.id, s: at };
        }
      }
    }
  }
  throw new Error('no such stall');
}

test('a rival who has left his route is no steal: he reads as at the bay on that route, and he is not. No tier, no knife', () => {
  const { S, spot, c, rival } = setup(seedTwo, 2, 30, 12);
  // On past the end of the bay's road and the next one, which is where a car that missed the bay ends up.
  let lane = W.lanes[spot.laneId];
  for (let i = 0; i < 2; i++) lane = W.lanes[W.conns[lane.conns[0]].to];
  const lost = lostRival(S, c, rival, lane.id, lane.len - 8);
  const away = Math.hypot(lost.x - spot.x, lost.y - spot.y);
  assert.ok(away > 40, `${away.toFixed(0)} m from the bay`);
  const p = TLV.world.routing.project(c._r.route, lost.x, lost.y, null, {});
  assert.ok(c._r.route.len - p.s <= T.stealM, 'the trap: the route clamps, so its remainder reads as near the bay');
  assert.ok(p.d > T.offRouteM, 'and it says how far off he is');
  TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
  step(S, 1);
  assert.equal(S.game.park.kind, 'BAY');
  assert.equal(c.steal, false);
  assert.equal(c.state, 'FAILED', 'he aborts');
  assert.equal(lost.beh, 'CRUISE', 'and drives on');
  until(S, (s) => s.game.phase === 'PAYOUT', 5, 'parked');
  assert.equal(c.tier, null, 'rage is floored to 75 on errand 2, so a steal here would have been a knife');
  step(S, 30);
  assert.deepEqual(events(S, 'contest.result')[0], { winner: 'player', tier: null });
  assert.notEqual(S.game.phase, 'ENCOUNTER');
  assert.equal(S.game.knife, null);
  assert.equal(S.game.stats.spotsStolen, 0);
});

test('a steal is by road: a rival on the next street is near in a straight line, and is no steal', () => {
  const { spot, laneId, s } = stallBeside((straight, road) => straight < T.stealM - 2 && road > 3 * T.stealM);
  const { S, c, rival } = setup(seedTwo, 2, 30, 12, { stall: spot });
  const lost = lostRival(S, c, rival, laneId, s);
  assert.ok(Math.hypot(lost.x - spot.x, lost.y - spot.y) < T.stealM, 'in reach, but for the buildings');
  TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
  step(S, 1);
  assert.equal(c.steal, false);
  assert.equal(c.state, 'FAILED');
});

test('a rival off his route who really is at the bay, just round the corner from it, is still a steal', () => {
  const { spot, laneId, s } = stallBeside((straight, road) => straight < T.stealM - 2 && road < T.stealM - 2);
  const { S, c, rival } = setup(seedTwo, 2, 30, 12, { stall: spot });
  const lost = lostRival(S, c, rival, laneId, s);
  assert.ok(TLV.world.routing.project(c._r.route, lost.x, lost.y, null, {}).d > T.offRouteM, 'off his route');
  TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
  step(S, 1);
  assert.equal(c.steal, true);
  assert.equal(c.state, 'DENIED');
});

test('the player cannot arm while his body overlaps the bay', () => {
  const { S, spot, c, rival } = setup(seedTwo, 2, 45, 12);
  TLV.traffic.despawn(S, rival, 'script');
  const car = TLV.traffic.spawn(S, { laneId: spot.laneId, s: spot.laneS, v: 0, force: true });
  c.rivalId = car.id;
  c._r.done = false;
  c.state = 'COMMIT';
  c.winner = null;
  car.x = spot.x;
  car.y = spot.y;
  car.h = spot.h;
  TLV.player.setPose(S, spot.x - Math.cos(spot.h) * 3, spot.y - Math.sin(spot.h) * 3, spot.h, 2);
  assert.equal(TLV.game.parking.tryArm(S), false);
});

test('errand 1 with no stall past the bay: he gives way when the player comes up behind him, and no state is left dead', () => {
  const { S, spot, c, rival } = setup(seedTwo, 2, 30, 60);
  // A hold with no anchor: the fallback plan.
  c._r.plan = 'HOLD';
  c._r.target = spot.id;
  c.ctl.holdCreep = true;
  until(S, () => rival.v < 0.2 && rival.beh === 'PARK_RACE' && c.state === 'CREEP', 14, 'holding at the line');
  S.controlSource = hold({ throttle: 0.3 });
  until(S, () => c._r.done, 12, 'he gives way');
  assert.equal(c.state, 'FAILED');
  assert.equal(events(S, 'bubble', (b) => b.text === '#@!' && b.who === 'veh').length >= 1, true);
});

test('the tutorial rival holds for as long as the player takes, past the 60 s his race command allows', () => {
  const { S, spot, c, rival } = setup(seedOne, 1, 30, 62);
  S.controlSource = hold({});
  S.game.clock = 999;
  step(S, 60 * 140);
  assert.equal(c._r.done, false, 'no timeout');
  assert.equal(rival.active, true);
  assert.equal(rival.beh, 'PARK_HOLD', 'the hold the watchdog leaves alone');
  assert.ok(rival.v < 0.3);
  const a = inBay(spot, rival).a;
  assert.ok(a > 6 && a < 30, `he stands past the bay, a ${a.toFixed(1)}`);
  S.controlSource = parker(spot);
  until(S, (s) => s.game.phase === 'PAYOUT', 30, 'parked');
  assert.equal(c.tier, 'CURSE');
});

test('arm and cancel on a no-steal, then arm again: he is gone and it is still no steal', () => {
  const { S, spot, c } = setup(seedTwo, 2, 60, 12);
  TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
  until(S, (s) => s.game.park.stage === 'FILL', 3, 'FILL');
  assert.equal(c.state, 'FAILED');
  S.controlSource = hold({ throttle: 1 });
  step(S, 1);
  S.controlSource = hold({});
  assert.equal(S.game.park.stage, null);
  until(S, (s) => s.game.phase === 'PAYOUT', 5, 'parked');
  assert.equal(c.steal, false);
  assert.equal(c.tier, null);
});

test('contest policy: errand 1 and 2 always, 3-7 by the formula, off and force', () => {
  const n = (seed, errand, contest) => {
    const S = sim({ seed, errand, traffic: 1, density: 0, contest });
    toDrive(S);
    onRoute(S, 100);
    step(S, 3);
    return S.game._g.contestDue || !!S.game.contest;
  };
  assert.equal(n(1, 2, 'off'), false);
  assert.equal(n(1, 2, 'force'), true);
  assert.equal(n(1, 1, 'auto'), true);
  assert.equal(n(1, 2, 'auto'), true);
  let hits = 0;
  for (let seed = 1; seed <= 30; seed++) if (n(seed, 3, 'auto')) hits++;
  assert.ok(hits >= 12 && hits <= 26, `${hits} of 30 at p 0.7`);
});

test('owner decision: a rival stopped in view may signal from up to 45 m on every errand, and only then', () => {
  for (const errand of [1, 2, 3]) {
    const S = sim({ seed: 2, errand, traffic: 1, density: 0, contest: 'force' });
    toDrive(S);
    TLV.debug.use(S);
    const made = TLV.debug.forceContest({});
    const c = S.game.contest;
    assert.ok(made && c, `errand ${errand}: a rival`);
    const veh = TLV.traffic.byId(S, c.rivalId);
    const spot = TLV.world.parking.spot(S.world, c.spotId);
    const rig = (left, v, seen) => {
      const seenBy = TLV.traffic.visibleToPlayer;
      const was = { v: veh.v, s: veh.s, laneId: veh.laneId, mode: veh.mode };
      TLV.traffic.visibleToPlayer = () => seen;
      Object.assign(veh, { v, s: spot.laneS - left, laneId: spot.laneId, mode: 'LANE' });
      S.game.nav.remaining = 80;
      try {
        TLV.game.rival.update(S, TLV.const.DT);
        return { waiting: c.ctl.blinkWaiting, may: c.ctl.mayBlink };
      } finally {
        Object.assign(veh, was);
        TLV.traffic.visibleToPlayer = seenBy;
      }
    };
    assert.deepEqual(rig(44, 0, true), { waiting: true, may: true }, `errand ${errand}: 44 m, stopped, seen`);
    assert.deepEqual(rig(46, 0, true), { waiting: false, may: true }, `errand ${errand}: 46 m is too far`);
    assert.deepEqual(rig(44, 2, true), { waiting: false, may: true }, `errand ${errand}: he is moving, and comes on by himself`);
    assert.deepEqual(rig(44, 0, false), { waiting: true, may: false }, `errand ${errand}: out of view, no leave to blink`);
  }
});

test('errand 1: the tutorial rival gives way: he waits on a side road for a player near the junction, and never touches him', () => {
  // Seed 14 is the one that crossed the player's nose: he rolled into the junction at the blinker's speed with the player 10 m off.
  for (const seed of [14, 3]) {
    const S = sim({ seed, traffic: 1, peds: 1, incidents: 1, contest: 'auto', immortal: 1 });
    toDrive(S);
    S.controlSource = TLV.bots.create('errands');
    const touched = [];
    S.bus.on('player.contact', (e) => {
      const c = S.game.contest;
      if (e.kind === 'vehicle' && c && e.otherId === c.rivalId && S.game.errandIndex === 0) touched.push(S.t);
    });
    for (let i = 0; i < 60 * 150 && S.game.errandIndex === 0 && S.game.phase !== 'RUN_END'; i++) step(S);
    assert.deepEqual(touched, [], `seed ${seed}`);
  }
});
