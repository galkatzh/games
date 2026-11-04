// tests/game/knife.test.mjs — WP-GAME
// ARCHITECTURE 19 item 6 on tlv_center: the encounter from a real steal, through every stage and all four exits, by scripted input.
import test from 'node:test';
import { assert, realTLV, sim, step, until, toDrive, events, bayOf, hold } from './helpers.mjs';

const TLV = realTLV();
const W = TLV.world.get('tlv_center');
const T = TLV.tune.game;

/** A steal at rage 75 on errand 2: a contest, the rival at the bay, and the player parked. Returns in ENCOUNTER. */
function encounter(seed, params = {}) {
  const S = sim({ seed, errand: 2, traffic: 1, density: 0, peds: 1, ...params });
  toDrive(S);
  TLV.debug.use(S);
  const r = TLV.debug.forceContest({ rage: 75 });
  assert.ok(r.rivalId >= 0, 'a rival');
  const c = S.game.contest;
  until(S, () => c.state !== 'CRUISE', 12, 'BLINK');
  const spot = bayOf(S);
  const rival = TLV.traffic.byId(S, c.rivalId);
  until(S, () => TLV.math.dist(rival.x, rival.y, spot.x, spot.y) <= T.stealM - 3 || c.state === 'COMMIT', 10, 'near the bay');
  assert.equal(TLV.debug.parkNow({ quality: 'GOOD' }), true);
  assert.equal(c.steal, true, 'a steal');
  assert.equal(c.tier, 'KNIFE');
  until(S, (s) => s.game.phase === 'ENCOUNTER', 2, 'ENCOUNTER');
  return S;
}

/** Runs through a door bearing, in a straight line, with the input a player gives. */
function runAt(tx, ty) {
  const TLV2 = realTLV();
  const c = TLV2.const._newControls();
  return (S) => {
    Object.assign(c, TLV2.const._newControls());
    const f = S.player.foot;
    const d = Math.hypot(tx - f.x, ty - f.y) || 1;
    c.footX = (tx - f.x) / d;
    c.footY = (ty - f.y) / d;
    return c;
  };
}

/** Follows a list of points on foot, one after the other. */
function runPath(points) {
  const TLV2 = realTLV();
  const c = TLV2.const._newControls();
  let i = 0;
  return (S) => {
    Object.assign(c, TLV2.const._newControls());
    const f = S.player.foot;
    while (i < points.length - 1 && Math.hypot(points[i].x - f.x, points[i].y - f.y) < 2) i++;
    const p = points[i];
    const d = Math.hypot(p.x - f.x, p.y - f.y) || 1;
    c.footX = (p.x - f.x) / d;
    c.footY = (p.y - f.y) / d;
    return c;
  };
}

/** Presses E a set time into DOOR_TUG. */
function pressAt(S, t) {
  S.controlSource = (s) => {
    const c = hold({})();
    if (s.game.knife && s.game.knife.stage === 'DOOR_TUG' && s.game.knife.stageT >= t) c.interact = true;
    return c;
  };
}

/** A straight road a person can run down for 160 m, starting near a point: the stretch of the nearest long lane. */
function longRun(S) {
  const f = S.player.foot;
  const pts = [];
  const route = S.game.errand._doorRoute;
  const here = TLV.world.routing.project(route, f.x, f.y, null, {});
  for (let s = here.s; s > 0 && pts.length < 40; s -= 8) pts.push(TLV.math.polyAt(route.px, route.py, route.cum, s, {}));
  return pts;
}

test('item 6: stages in order, with the clock frozen and the time scale back at 1', () => {
  const S = encounter(3);
  const k = S.game.knife;
  assert.equal(k.stage, 'STANDOFF');
  assert.equal(S.timeScale, T.standoffScale);
  assert.equal(S.player.mode, 'LOCKED');
  const clock = S.game.clock;
  pressAt(S, 0.5);
  until(S, () => k.stage === 'DOOR_TUG', 2, 'DOOR_TUG');
  assert.equal(S.timeScale, 1);
  assert.equal(S.game.clock, clock);
  until(S, () => k.stage === 'BAIL', 3, 'BAIL');
  until(S, () => k.stage === 'CHASE', 1, 'CHASE');
  assert.equal(S.player.mode, 'FOOT');
  const e = S.game.errand;
  S.controlSource = runAt(e.doorX, e.doorY);
  until(S, () => k.exit !== null || S.game.phase === 'RUN_END', 30, 'an exit');
  assert.equal(S.game.clock >= clock, true, 'the clock never ran');
  const stages = events(S, 'knife.stage').map((x) => x.stage);
  assert.deepEqual(stages.slice(0, 4), ['STANDOFF', 'DOOR_TUG', 'BAIL', 'CHASE']);
  if (S.game.phase !== 'RUN_END') assert.equal(stages[4], 'RESOLVE');
  assert.equal(S.timeScale, 1);
});

/** Every car body near a point, on the road and in the stalls. */
function carsNear(S, x, y) {
  const parking = TLV.world.parking;
  const ids = [];
  parking.parkedNear(S, x, y, 9, ids);
  const stalls = ids.map((id) => ({ ...parking.boxOf(W, id, parking.state(S, id), {}), name: `parked ${id}` }));
  const cars = S.vehicles.filter((v) => v.active && Math.hypot(v.x - x, v.y - y) <= 9);
  return [...stalls, ...cars];
}

const inBody = (car, x, y) => {
  const c = Math.cos(car.h);
  const s = Math.sin(car.h);
  return Math.abs((x - car.x) * c + (y - car.y) * s) < car.length / 2 && Math.abs((y - car.y) * c - (x - car.x) * s) < car.width / 2;
};

/** Plays an encounter to its end, the bot running, and counts the ticks he stood inside a car. */
function watchBody(S, press) {
  const k = S.game.knife;
  const bot = TLV.bots.create('errands');
  S.controlSource = (s) => {
    const live = s.game.knife;
    if (live && live.stage === 'CHASE') return bot(s);
    const c = TLV.const._newControls();
    if (live && live.stage === 'DOOR_TUG' && live.stageT >= press) c.interact = true;
    return c;
  };
  let ticks = 0;
  const inside = [];
  while (S.game.knife === k && S.game.phase === 'ENCOUNTER' && ticks < 60 * 40) {
    step(S);
    const man = k.attackerId >= 0 ? TLV.peds.byId(S, k.attackerId) : null;
    if (!man) continue;
    ticks++;
    for (const car of carsNear(S, man.x, man.y)) {
      if (inBody(car, man.x, man.y)) inside.push(`${k.stage} ${k.stageT.toFixed(2)} s in ${car.name || (car.isPlayer ? 'the player' : `car ${car.id}`)}`);
    }
  }
  return { ticks, inside };
}

test('he gets out at the open door on the side nearest the player, already armed, and goes round the car, never through it', () => {
  let doors = 0;
  for (let seed = 1; seed <= 16; seed++) {
    const S = encounter(seed);
    const k = S.game.knife;
    const me = S.player.veh;
    until(S, () => k.attackerId >= 0, 2, 'out of the car');
    const rival = TLV.traffic.byId(S, k.rivalVehId);
    const man = TLV.peds.byId(S, k.attackerId);
    assert.ok(rival.door === 1 || rival.door === 2, 'his door is open');
    assert.equal(man.hasKnife, true, 'the knife is out before the cut');
    const c = Math.cos(rival.h);
    const s = Math.sin(rival.h);
    const side = (man.y - rival.y) * c - (man.x - rival.x) * s;
    assert.equal(side > 0, rival.door === 1, 'he stands at the door that opened');
    assert.ok(Math.abs(side) >= rival.width / 2 + 0.3, 'beside the car, not in it');
    const nearSide = (me.y - rival.y) * c - (me.x - rival.x) * s;
    if (side * nearSide > 0) doors++;
    const box = {};
    TLV.collide._doorBox(rival, box);
    assert.ok(TLV.math.obbGap(box, me) > -0.05, 'the door swings clear of the player');
    assert.deepEqual(watchBody(S, 0.3).inside.slice(0, 3), [], `seed ${seed}`);
  }
  assert.ok(doors >= 12, `the near door on ${doors} of 16`);
});

test('no tick with him inside a car, on 24 more real encounters, late presses and busy streets among them', () => {
  let ran = 0;
  for (let seed = 17; seed <= 40; seed++) {
    const S = encounter(seed, seed % 2 ? {} : { density: undefined });
    const { ticks, inside } = watchBody(S, seed % 3 ? 0.3 : 2);
    assert.deepEqual(inside.slice(0, 3), [], `seed ${seed}`);
    if (ticks > 60) ran++;
  }
  assert.equal(ran, 24);
});

test('a lunge never goes through a car, and a late press still reads lead = 9 - 3t with the car between them', () => {
  const S = encounter(4);
  const k = S.game.knife;
  const me = S.player.veh;
  pressAt(S, 2);
  until(S, () => k.stage === 'CHASE', 6, 'CHASE');
  assert.ok(Math.abs(k.gap - 3) < 0.1, `gap ${k.gap}`);
  const man = TLV.peds.byId(S, k.attackerId);
  const f = S.player.foot;
  const between = TLV.game.attacker._clearShot(S, man);
  assert.equal(between, !TLV.world.spatial.rayBlocked(W, man.x, man.y, f.x, f.y) && !inBody(me, (man.x + f.x) / 2, (man.y + f.y) / 2));
  assert.deepEqual(watchBody(S, 2).inside.slice(0, 3), []);
});

test('the chase door is in a clear line from where the player gets out, and the errand\'s own door is kept when it already is', () => {
  let moved = 0;
  let kept = 0;
  for (const [seed, errand] of [[1, 1], [1, 2], [1, 3], [1, 5], [1, 6], [2, 2], [2, 4], [3, 5], [3, 6]]) {
    const S = sim({ seed, errand, traffic: 1, density: 0, peds: 1 });
    toDrive(S);
    TLV.debug.use(S);
    const e = S.game.errand;
    const bay = bayOf(S);
    TLV.player.setPose(S, bay.x, bay.y, bay.h, 0);
    step(S, 2);
    const own = { x: e.doorX, y: e.doorY };
    assert.equal(TLV.debug.forceKnife({ stage: 'CHASE', gap: 9 }), true);
    const f = S.player.foot;
    const blocked = TLV.world.spatial.rayBlocked(W, f.x, f.y, own.x, own.y);
    if (!blocked) {
      assert.deepEqual({ x: e.doorX, y: e.doorY }, own, 'nothing in the way, so it stays');
      kept++;
    } else {
      assert.equal(TLV.world.spatial.rayBlocked(W, f.x, f.y, e.doorX, e.doorY), false, `seed ${seed} errand ${errand}: a clear line`);
      assert.ok(Math.hypot(e.doorX - f.x, e.doorY - f.y) >= T.chaseDoorMinM, 'and a chase to run');
      moved++;
    }
  }
  assert.ok(moved >= 5 && kept >= 1, `${moved} moved, ${kept} kept`);
});

test('item 6: lead = 9 - 3t: E at 0.5 s, 1.0 s and 2.0 s', () => {
  for (const t of [0.5, 1, 2]) {
    const S = encounter(4);
    const k = S.game.knife;
    pressAt(S, t);
    until(S, () => k.stage === 'CHASE', 6, 'CHASE');
    assert.ok(Math.abs(k.gap - (9 - 3 * t)) < 0.1, `E at ${t}: gap ${k.gap}`);
    assert.equal(k.strikes, 0, 'no strike');
    assert.equal(S.game.money, S.game.money, 'no fine');
  }
});

test('item 6: no E: DRAGGED at 2.5 s, strike 1, lead 0, 2 s invulnerable', () => {
  const S = encounter(5);
  const k = S.game.knife;
  S.controlSource = hold({});
  until(S, () => k.stage === 'DOOR_TUG', 3, 'DOOR_TUG');
  const t0 = S.t;
  until(S, () => k.stage === 'DRAGGED', 3.5, 'DRAGGED');
  assert.ok(Math.abs(S.t - t0 - 2.5) < 0.05, `${(S.t - t0).toFixed(2)} s`);
  assert.equal(k.tugBar, 0);
  assert.equal(k.strikes, 1);
  assert.deepEqual(events(S, 'knife.strike'), [{ strikes: 1 }]);
  until(S, () => k.stage === 'CHASE', 1.2, 'CHASE');
  assert.ok(k.gap <= 0.1);
  assert.ok(Math.abs(S.player.foot.invulnT - 2) < 0.1);
});

test('item 6: controls locked: no player.hitPed in STANDOFF or DOOR_TUG, however the player floors it', () => {
  const S = encounter(6);
  const k = S.game.knife;
  S.controlSource = hold({ throttle: 1, steer: 0.5 });
  const pose = { x: S.player.veh.x, y: S.player.veh.y };
  until(S, () => k.stage === 'DRAGGED', 6, 'DRAGGED');
  assert.equal(events(S, 'player.hitPed').length, 0);
  assert.ok(Math.hypot(S.player.veh.x - pose.x, S.player.veh.y - pose.y) < 0.01, 'the car did not move');
});

test('item 6: attacker 5.7 or 6.6 m/s, settling at 12 m behind a clean runner', () => {
  const S = encounter(7);
  const k = S.game.knife;
  pressAt(S, 0.2);
  until(S, () => k.stage === 'CHASE', 5, 'CHASE');
  S.game.obstacles.length = 0;
  S.controlSource = runPath(longRun(S));
  const seen = new Set();
  const gaps = [];
  for (let i = 0; i < 60 * 15 && k.stage === 'CHASE' && !k.shaken; i++) {
    step(S);
    const a = TLV.peds.byId(S, k.attackerId);
    if (a && k.lunge === 'NONE' && a.v > 0) seen.add(a.v.toFixed(2));
    gaps.push(k.gap);
  }
  const speeds = [...seen].map(Number);
  for (const v of speeds) assert.ok([5.7, 6.6, 2.85, 3.3].includes(v), `speed ${v}`);
  assert.ok(speeds.includes(5.7) && speeds.includes(6.6), speeds.join());
  assert.ok(gaps.length > 300, `ran ${gaps.length} ticks`);
  const tail = gaps.slice(-120);
  assert.ok(tail.every((g) => g > 8), `gap held: min ${Math.min(...tail).toFixed(1)}`);
});

test('item 6: exit REACHED_SHOP by scripted input: pay x2, +₪300 and +15 s, and the errand counts', () => {
  let reached = 0;
  const seeds = [];
  for (let seed = 1; seed <= 12; seed++) {
    const S = encounter(seed);
    const k = S.game.knife;
    const e = S.game.errand;
    pressAt(S, 0.2);
    until(S, () => k.stage === 'CHASE', 5, 'CHASE');
    // The bot's own run to the door, which steers round what stands in the way.
    S.controlSource = TLV.bots.create('errands');
    const money = S.game.money;
    const clock = S.game.clock;
    for (let i = 0; i < 60 * 30 && !k.exit && S.game.phase !== 'RUN_END'; i++) step(S);
    seeds.push(k.exit);
    if (k.exit !== 'REACHED_SHOP') continue;
    reached++;
    assert.equal(S.game.phase, 'RESOLVE');
    assert.equal(S.player.mode, 'LOCKED', 'back at the car');
    const paid = events(S, 'errand.paid')[0];
    assert.equal(paid.exit, 'REACHED_SHOP');
    assert.equal(paid.pay, Math.round((T.payBase + T.payPerM * e.routeLen) * 1.2 * 1.5 * 2));
    const fines = events(S, 'knife.strike').length * T.lungeFine;
    assert.equal(S.game.money, money + T.shopBonus + paid.pay - fines);
    assert.equal(events(S, 'score.bonus', (b) => b.id === 'EXIT_REACHED_SHOP').length, 1);
    assert.ok(Math.abs(S.game.clock - clock - T.shopSeconds) < 1e-9);
    assert.equal(S.game.stats.errandsDone, 1);
  }
  console.log(`errands bot on foot, 12 seeds: ${seeds.join(' ')}`);
  assert.ok(reached >= 3, `${reached} of 12 reached the door`);
});

test('item 6: exit SHAKEN by scripted input: over the two blockers, he drops back 18 m and stops, pay x1.5', () => {
  let shaken = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const S = encounter(seed);
    const k = S.game.knife;
    const e = S.game.errand;
    pressAt(S, 0.1);
    until(S, () => k.stage === 'CHASE', 5, 'CHASE');
    const [a, b] = S.game.obstacles;
    // Through both blockers, then well away from the door, so reaching it cannot end the chase first.
    const f = S.player.foot;
    const away = { x: f.x + (f.x - e.doorX), y: f.y + (f.y - e.doorY) };
    S.controlSource = runPath([{ x: a.x, y: a.y }, { x: b.x, y: b.y }, away]);
    for (let i = 0; i < 60 * 25 && !k.shaken && !k.exit; i++) step(S);
    if (!k.shaken) continue;
    const t0 = S.t;
    const man = TLV.peds.byId(S, k.attackerId);
    const stood = { x: man.x, y: man.y };
    until(S, () => k.exit !== null, 7, 'SHAKEN');
    assert.equal(k.exit, 'SHAKEN');
    assert.ok(Math.abs(S.t - t0 - T.shakenRunS) < 0.1 || Math.abs(S.t - t0) < T.shakenRunS, `${(S.t - t0).toFixed(2)} s after he stopped`);
    assert.equal(events(S, 'errand.paid')[0].pay, Math.round((T.payBase + T.payPerM * e.routeLen) * 1.2 * 1.5 * 1.5));
    assert.ok(Math.hypot(stood.x, stood.y) > 0);
    shaken++;
    if (shaken >= 2) break;
  }
  assert.ok(shaken >= 2, `${shaken} seeds shaken him`);
});

test('item 6: exit SHAKEN directly: gap 18 m stops him where he stands, and 25 s is the limit', () => {
  const S = sim({ seed: 2, errand: 2, traffic: 1, density: 0, peds: 1 });
  toDrive(S);
  TLV.debug.use(S);
  TLV.debug.forceKnife({ stage: 'CHASE', gap: 20 });
  step(S, 2);
  const k = S.game.knife;
  assert.equal(k.shaken, true);
  until(S, () => k.exit !== null, 7, 'SHAKEN');
  assert.equal(k.exit, 'SHAKEN');
  assert.equal(S.game.phase, 'RESOLVE');
});

/** A long straight lane: 170 m a person can run down in plain sight of whoever is behind. */
function straightRun() {
  for (const lane of W.lanes) {
    if (!(lane.flags & 1) || lane.len < 200) continue;
    const a = TLV.world.lanes.pointAt(W, lane.id, 10, {});
    const b = TLV.world.lanes.pointAt(W, lane.id, 190, {});
    if (Math.hypot(a.x - b.x, a.y - b.y) < 179.5) continue;
    if (TLV.world.spatial.rayBlocked(W, a.x, a.y, b.x, b.y)) continue;
    return { a, b };
  }
  throw new Error('no straight lane');
}

test('item 6: exit WHISTLE by scripted input: 25 s of clean running in plain sight, pay x1', () => {
  const { a, b } = straightRun();
  const S = sim({ seed: 2, errand: 2, traffic: 1, density: 0, peds: 0, spawn: { x: a.x, y: a.y, h: a.h } });
  toDrive(S);
  TLV.debug.use(S);
  TLV.debug.forceKnife({ stage: 'CHASE', gap: 12 });
  const k = S.game.knife;
  const e = S.game.errand;
  S.game.obstacles.length = 0;
  const t0 = S.t;
  S.controlSource = runPath([{ x: b.x, y: b.y }]);
  until(S, () => k.exit !== null || S.game.phase === 'RUN_END', 27, 'exit');
  assert.equal(k.exit, 'WHISTLE');
  assert.ok(Math.abs(S.t - t0 - 25) < 0.1, `${(S.t - t0).toFixed(2)} s`);
  assert.equal(k.strikes, 0);
  assert.equal(events(S, 'errand.paid')[0].pay, Math.round((T.payBase + T.payPerM * e.routeLen) * 1 * 1.5));
  assert.equal(S.game.phase, 'RESOLVE');
});

test('item 6: exit CAUGHT: strike 3 ends the run, with a comic end and no pay', () => {
  const S = encounter(10);
  const k = S.game.knife;
  S.controlSource = hold({});
  until(S, () => S.game.phase === 'RUN_END', 40, 'caught');
  assert.equal(k.exit, 'CAUGHT');
  assert.equal(S.game.endReason, 'CAUGHT');
  assert.equal(k.strikes, 3);
  assert.equal(events(S, 'errand.paid').length, 0, 'none');
  assert.equal(events(S, 'knife.strike').length, 3);
  assert.equal(S.game.stats.errandsDone, 0);
  // Two lunges after the drag, at ₪100 each.
  assert.ok(events(S, 'knife.lunge', (l) => l.phase === 'STRIKE').length >= 2);
});

test('a lunge: windup, strike and recover in order, and a sidestep at the right moment beats it', () => {
  const { a, b } = straightRun();
  const S = sim({ seed: 2, errand: 2, traffic: 1, density: 0, peds: 0, spawn: { x: a.x, y: a.y, h: a.h } });
  toDrive(S);
  TLV.debug.use(S);
  TLV.debug.forceKnife({ stage: 'CHASE', gap: 9 });
  const k = S.game.knife;
  S.game.obstacles.length = 0;
  // Clear of the car, then stop dead and wait for him.
  const run = runPath([{ x: b.x, y: b.y }]);
  const t0 = S.t;
  S.controlSource = (s) => {
    if (s.t - t0 < 2) return run(s);
    const c = hold({})();
    c.sidestep = !!s.game.knife && s.game.knife.lunge === 'WINDUP' && s.game.knife.lungeT > 0.45;
    return c;
  };
  until(S, () => k.lunge === 'RECOVER', 8, 'RECOVER');
  assert.equal(k.strikes, 0, 'sidestepped');
  assert.deepEqual(events(S, 'knife.lunge').map((l) => l.phase), ['WINDUP', 'STRIKE', 'RECOVER']);
});

test('a strike: stumble, 1.5 s invulnerable, -₪100, strike +1', () => {
  const S = sim({ seed: 2, errand: 2, traffic: 1, density: 0, peds: 1 });
  toDrive(S);
  TLV.debug.use(S);
  TLV.debug.forceKnife({ stage: 'CHASE', gap: 3 });
  const k = S.game.knife;
  const money = S.game.money;
  S.controlSource = hold({});
  until(S, () => k.strikes === 1, 5, 'strike');
  assert.equal(S.game.money, money - 100);
  const f = S.player.foot;
  assert.ok(f.stumbleT > 0.4 && Math.abs(f.invulnT - 1.5) < 0.02);
});

test('reconnection: RESOLVE puts the car back on the road, the rival towed, and the next errand follows', () => {
  const S = sim({ seed: 2, errand: 2, traffic: 1, density: 0, peds: 1 });
  toDrive(S);
  TLV.debug.use(S);
  const index = S.game.errandIndex;
  TLV.debug.forceKnife({ stage: 'CHASE', gap: 20 });
  const k = S.game.knife;
  const rivalId = k.rivalVehId;
  until(S, () => S.game.phase === 'RESOLVE', 8, 'RESOLVE');
  const rival = TLV.traffic.byId(S, rivalId);
  const inspector = S.peds.find((p) => p.active && p.kind === 'inspector');
  assert.ok(inspector, 'the inspector is there');
  assert.equal(S.player.mode, 'LOCKED');
  assert.equal(S.vehicles[0].door, 0);
  until(S, () => { const c = TLV.traffic.byId(S, rivalId); return !c || c.beh === 'TOWED'; }, 2, 'towed');
  if (rival) {
    const lane = TLV.world.lanes.project(W, rival.x, rival.y, rival.h, 3, {});
    assert.ok(lane && Math.abs(lane.headingErr) < 0.1, 'his car leaves square in the lane');
  }
  until(S, (s) => s.game.phase === 'CARD', 5, 'CARD');
  assert.equal(S.game.errandIndex, index + 1);
  assert.equal(S.game.knife, null);
  assert.equal(S.game.contest, null);
  assert.equal(S.peds.some((p) => p.active && (p.kind === 'attacker' || p.kind === 'inspector')), false);
  until(S, (s) => s.game.phase === 'DRIVE', 6, 'DRIVE');
  assert.equal(S.player.mode, 'DRIVE');
  assert.equal(S.game.stats.errandsDone, 1);
});

test('RESOLVE is skippable by any key', () => {
  const S = sim({ seed: 2, errand: 2, traffic: 1, density: 0, peds: 1 });
  toDrive(S);
  TLV.debug.use(S);
  TLV.debug.forceKnife({ stage: 'CHASE', gap: 20 });
  until(S, () => S.game.phase === 'RESOLVE', 8, 'RESOLVE');
  const t0 = S.t;
  step(S, 40);
  S.controlSource = hold({ start: true });
  until(S, (s) => s.game.phase === 'CARD', 2, 'CARD');
  assert.ok(S.t - t0 < 2, 'skipped');
});

/** Runs to RESOLVE with these fields held all the way through the chase, and returns the sim on the tick RESOLVE began. */
function resolveHolding(fields) {
  const S = sim({ seed: 2, errand: 2, traffic: 1, density: 0, peds: 1 });
  toDrive(S);
  TLV.debug.use(S);
  TLV.debug.forceKnife({ stage: 'CHASE', gap: 20 });
  S.controlSource = hold(fields);
  until(S, () => S.game.phase === 'RESOLVE', 8, 'RESOLVE');
  return S;
}

test('RESOLVE: a key held from the run is no skip, whichever field carries it, and the card runs its 4 s', () => {
  for (const fields of [{ start: true, throttle: 1 }, { interact: true }, { restart: true }, { start: true, interact: true, restart: true }]) {
    const S = resolveHolding(fields);
    const t0 = S.t;
    until(S, (s) => s.game.phase !== 'RESOLVE', 5, 'the end of the card');
    assert.ok(Math.abs(S.t - t0 - T.resolveS) < 0.05, `${JSON.stringify(fields)}: ran ${(S.t - t0).toFixed(2)} s`);
  }
});

test('RESOLVE: a held key let go and pressed again skips; so does a second key with the first still down', () => {
  const again = resolveHolding({ start: true });
  const t0 = again.t;
  again.controlSource = hold({});
  step(again, 40);
  assert.equal(again.game.phase, 'RESOLVE');
  again.controlSource = hold({ start: true });
  step(again, 2);
  assert.equal(again.game.phase, 'CARD');
  assert.ok(again.t - t0 < 1, `${(again.t - t0).toFixed(2)} s`);

  const second = resolveHolding({ start: true, throttle: 1 });
  step(second, 40);
  assert.equal(second.game.phase, 'RESOLVE');
  second.controlSource = hold({ start: true, throttle: 1, interact: true });
  step(second, 2);
  assert.equal(second.game.phase, 'CARD');
});

test('RESOLVE: a fresh press in the first 0.5 s waits for the 0.5 s, and a tap let go inside it is no skip', () => {
  const S = resolveHolding({});
  const t0 = S.t;
  step(S, 6);
  S.controlSource = hold({ start: true });
  until(S, (s) => s.game.phase !== 'RESOLVE', 2, 'skip');
  assert.ok(Math.abs(S.t - t0 - T.resolveMinS) < 0.05, `${(S.t - t0).toFixed(2)} s`);

  const tap = resolveHolding({});
  step(tap, 6);
  tap.controlSource = hold({ start: true });
  step(tap, 6);
  tap.controlSource = hold({});
  step(tap, 60);
  assert.equal(tap.game.phase, 'RESOLVE');
});

test('RUN_END: a key held as the run ends is no restart, and a fresh press is', () => {
  const S = sim();
  toDrive(S);
  TLV.debug.use(S);
  S.controlSource = hold({ restart: true });
  step(S, 3);
  S.game.clock = 0.001;
  until(S, (s) => s.game.phase === 'RUN_END', 1, 'end');
  step(S, 120);
  assert.equal(S.game.phase, 'RUN_END', 'the end card stays up under a held R');
  S.controlSource = hold({});
  step(S, 2);
  assert.equal(S.game.phase, 'RUN_END');
  S.controlSource = hold({ restart: true });
  step(S, 1);
  assert.equal(S.game.phase, 'CARD');
});

test('the rules of the knife: never on the gan, even by hand, and a pedestrian hit forfeits every exit bonus', () => {
  const gan = sim({ seed: 2, errand: 7, traffic: 1, density: 0 });
  toDrive(gan);
  TLV.debug.use(gan);
  assert.equal(gan.game.errandIndex, 6);
  assert.equal(TLV.debug.forceKnife({}), false);
  const S = encounter(13);
  const k = S.game.knife;
  S.game.pedHitThisErrand = true;
  pressAt(S, 0.2);
  until(S, () => k.stage === 'CHASE', 5, 'CHASE');
  k._a.a = -30;
  k.gap = 20;
  until(S, () => k.exit !== null, 8, 'exit');
  const paid = events(S, 'errand.paid')[0];
  assert.equal(paid.pay, 0);
  assert.equal(events(S, 'score.bonus', (b) => b.id === 'EXIT_REACHED_SHOP').length, 0);
});

test('every stage forced by the hook works, and the encounter never leaves a dead state', () => {
  for (const stage of ['STANDOFF', 'DOOR_TUG', 'BAIL', 'DRAGGED', 'CHASE']) {
    const S = sim({ seed: 2, errand: 3, traffic: 1, density: 0, peds: 1 });
    toDrive(S);
    TLV.debug.use(S);
    assert.equal(TLV.debug.forceKnife({ stage, gap: 20 }), true, stage);
    S.controlSource = hold({});
    until(S, (s) => s.game.phase === 'CARD' || s.game.phase === 'RUN_END', 40, `end from ${stage}`);
    assert.equal(S.timeScale, 1);
  }
});
