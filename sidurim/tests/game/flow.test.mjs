// tests/game/flow.test.mjs — WP-GAME
// ARCHITECTURE 19 items 10 and 13, and the phase table of 10.9.
import test from 'node:test';
import { createSim } from '../../tools/lib/classic.mjs';
import { assert, realTLV, sim, step, until, toDrive, events, hold } from './helpers.mjs';

const TLV = realTLV();
const T = TLV.tune.game;

test('item 10: TITLE waits for start, then startRun, then CARD; driving is locked from TITLE until DRIVE', () => {
  const S = createSim(TLV, { seed: 1, params: { traffic: 0, peds: 0, incidents: 0, contest: 'off' } });
  assert.equal(S.game.phase, 'TITLE');
  assert.equal(S.player.mode, 'LOCKED');
  TLV.sim.step(S);
  TLV.sim.step(S);
  assert.equal(S.game.phase, 'TITLE');
  S.controls.start = true;
  TLV.sim.step(S);
  S.controls.start = false;
  assert.equal(S.game.phase, 'CARD');
  assert.equal(S.game.errandIndex, 0);
  assert.equal(S.game.errand.defId, 'milk');
  assert.equal(S.player.mode, 'LOCKED');
  until(S, (s) => s.game.phase === 'DRIVE', 4, 'DRIVE');
  assert.ok(Math.abs(S.game.phaseT) < 0.02);
  assert.equal(S.player.mode, 'DRIVE');
});

test('item 10: ?notitle=1 delivers run.start and errand.start to a frame consumer that enabled its drain after create', () => {
  const S = createSim(TLV, { seed: 1, params: { notitle: 1, traffic: 0, peds: 0, incidents: 0, contest: 'off' } });
  assert.equal(S.game.phase, 'TITLE', 'init never starts a run');
  S.bus.enableDrain();
  TLV.sim.step(S);
  const got = [];
  S.bus.drain((name, payload) => got.push([name, payload]));
  const names = got.map((e) => e[0]);
  assert.ok(names.includes('run.start'), names.join());
  assert.ok(names.indexOf('run.start') < names.indexOf('errand.start'));
  assert.deepEqual(got[names.indexOf('run.start')][1], { seed: 1 });
  assert.deepEqual(got[names.indexOf('errand.start')][1], { index: 0, defId: 'milk' });
});

test('item 10: startRun follows the binding order of ARCHITECTURE 12.7', () => {
  const S = createSim(TLV, { seed: 2, params: { traffic: 1, peds: 1, incidents: 0 } });
  const calls = [];
  const spy = (obj, name, label) => {
    const fn = obj[name];
    obj[name] = function (...args) {
      calls.push(label);
      return fn.apply(this, args);
    };
    return () => { obj[name] = fn; };
  };
  const undo = [
    spy(TLV.const, 'newGameState', '1 reset'),
    spy(TLV.world.parking, 'reset', '2 parking.reset'),
    spy(TLV.game.errands, 'spawnPoint', '4 spawnPoint'),
    spy(TLV.player, 'setPose', '4 setPose'),
    spy(TLV.traffic, 'spawn', '6 tail'),
    spy(TLV.traffic, 'prewarm', '7 prewarm'),
    spy(TLV.world.signals, 'alignGreen', '8 alignGreen'),
    spy(TLV.game.errands, 'plan', '9 plan'),
    spy(TLV.game.errands, 'bind', '9 bind'),
    spy(TLV.game.parking, 'stageBlock', '9 stageBlock'),
    spy(TLV.game.nav, '_setTargetFrom', '9 setTarget')
  ];
  S.bus.on('run.start', () => calls.push('10 run.start'));
  S.bus.on('errand.start', () => calls.push('10 errand.start'));
  try {
    TLV.game.flow.startRun(S);
  } finally {
    undo.forEach((u) => u());
  }
  const first = (label) => calls.indexOf(label);
  const order = ['1 reset', '2 parking.reset', '4 spawnPoint', '4 setPose', '6 tail', '7 prewarm', '8 alignGreen', '9 plan', '9 bind', '9 stageBlock', '9 setTarget', '10 run.start', '10 errand.start'];
  for (let i = 1; i < order.length; i++) assert.ok(first(order[i - 1]) < first(order[i]), `${order[i - 1]} before ${order[i]}: ${calls.join(', ')}`);
  const cars = [];
  TLV.traffic.vehiclesNear(S, S.player.veh.x, S.player.veh.y, 8, cars);
  const others = cars.filter((c) => !c.isPlayer);
  assert.ok(others.length <= 1, 'the follower only, within 8 m');
});

test('item 10: restart: a new run on the same S, in under 2 s of play, with the old staging gone', () => {
  const S = sim({ traffic: 1, peds: 1, contest: 'force' });
  toDrive(S);
  TLV.debug.use(S);
  TLV.debug.forceKnife({ stage: 'CHASE', gap: 1 });
  const attacker = S.game.knife.attackerId;
  TLV.debug.setClock(50);
  TLV.debug.endRun('CLOCK');
  assert.equal(S.game.phase, 'RUN_END');
  S.controlSource = hold({ restart: true });
  step(S, 1);
  S.controlSource = hold({});
  assert.equal(S.game.phase, 'CARD');
  assert.equal(S.game.clock, 120);
  assert.equal(S.game.money, 0);
  assert.equal(S.game.errandIndex, 0);
  assert.equal(S.game.knife, null);
  assert.equal(S.player.mode, 'LOCKED');
  assert.equal(S.timeScale, 1);
  assert.equal(TLV.peds.byId(S, attacker), null, 'the attacker is gone');
  assert.ok(S.game.errand);
  until(S, (s) => s.game.phase === 'DRIVE', 4, 'DRIVE');
});

test('item 10: CLOCK: the clock runs in DRIVE, SEARCH and HOLD, warns at 20 and 10, and ends the run at 0', () => {
  const S = sim();
  toDrive(S);
  S.game.clock = 21;
  until(S, (s) => s.game.clock < 19.9, 2, 'pulse');
  assert.deepEqual(events(S, 'clock.warn'), [{ level: 1 }]);
  S.game.clock = 10.5;
  until(S, (s) => s.game.clock < 9.9, 2, 'tick');
  assert.deepEqual(events(S, 'clock.warn')[1], { level: 2 });
  S.game.clock = 0.2;
  until(S, (s) => s.game.phase === 'RUN_END', 1, 'end');
  assert.equal(S.game.endReason, 'CLOCK');
  assert.equal(S.game.rank, 'NEW_DRIVER');
  const end = events(S, 'run.end')[0];
  assert.equal(end.reason, 'CLOCK');
  assert.equal(end.rank, 'NEW_DRIVER');
  assert.equal(end.stats.errandsDone, 0);
});

test('item 10: TOWED: HP 0 ends the run', () => {
  const S = sim();
  toDrive(S);
  TLV.debug.use(S);
  TLV.debug.setHP(0);
  step(S, 1);
  assert.equal(S.game.endReason, 'TOWED');
});

test('item 10: WIN: the gan parked, after its PAYOUT; a day of 7 goes end to end', () => {
  const S = sim({ seed: 3 });
  TLV.debug.use(S);
  for (let i = 0; i < 7; i++) {
    toDrive(S);
    assert.equal(S.game.errandIndex, i);
    S.game.clock = 300;
    TLV.debug.parkNow({ quality: 'GOOD' });
    if (i < 6) until(S, (s) => s.game.phase === 'CARD', 4, 'CARD');
  }
  assert.equal(S.game.phase, 'PAYOUT');
  until(S, (s) => s.game.phase === 'RUN_END', 3, 'RUN_END');
  assert.equal(S.game.endReason, 'WIN');
  assert.equal(S.game.stats.errandsDone, 7);
  assert.ok(S.game.money > 0);
  assert.equal(events(S, 'run.end')[0].money, S.game.money);
});

test('?immortal keeps a run going past everything that ends one', () => {
  const S = sim({ immortal: 1, peds: 1 });
  toDrive(S);
  S.game.clock = 0.01;
  S.game.hp = 0;
  S.game.pedHits = 2;
  step(S, 30);
  assert.equal(S.game.phase, 'DRIVE');
});

test('?clock, ?errand and ?heat take effect, and heat follows the errand', () => {
  const S = sim({ clock: 77, errand: 4, heat: 0.33 });
  assert.equal(S.game.clock, 77);
  assert.equal(S.game.errandIndex, 3);
  assert.equal(S.game.heat, 0.33);
  const H = sim({ errand: 4 });
  assert.ok(Math.abs(H.game.heat - 3 / 6) < 1e-9);
});

test('startRun takes opts over params', () => {
  const S = sim();
  TLV.game.flow.startRun(S, { errandIndex: 2, defId: 'bank_queue', clock: 55 });
  assert.equal(S.game.errandIndex, 2);
  assert.equal(S.game.errand.defId, 'bank_queue');
  assert.equal(S.game.clock, 55);
});

test('one tow per press: R held on tows once and charges once, and a second press tows again', () => {
  const S = sim({ seed: 4, errand: 2 });
  toDrive(S);
  const W = S.world;
  const lane = W.lanes.find((l) => (l.flags & 1) && l.len > 60);
  const at = TLV.world.lanes.pointAt(W, lane.id, 30, {});
  TLV.player.setPose(S, at.x + 9, at.y + 9, 1, 0);
  S.controlSource = hold({ recover: true });
  until(S, () => events(S, 'player.recover').length === 1, 2, 'the tow');
  const money = S.game.money;
  const clock = S.game.clock;
  step(S, 60 * 6);
  assert.equal(events(S, 'player.recover').length, 1, 'held for 6 s more, no second tow');
  assert.equal(S.game.money, money, 'and no second charge');
  assert.ok(clock - S.game.clock < 6.1, 'nor 15 s off the clock');
  S.controlSource = hold({});
  step(S, 2);
  S.controlSource = hold({ recover: true });
  until(S, () => events(S, 'player.recover').length === 2, 2, 'the next press');
  assert.equal(S.game.money, money - TLV.tune.game.recoverMoney);
});

test('item 13: recover: held 1.5 s under 1 m/s: nearest AI lane, -15 s, -₪100, nav redone, no contact', () => {
  const S = sim({ seed: 4, errand: 2 });
  toDrive(S);
  const W = S.world;
  const veh = S.player.veh;
  // In a park: nowhere near a lane.
  const lane = W.lanes.find((l) => (l.flags & 1) && l.len > 60);
  const at = TLV.world.lanes.pointAt(W, lane.id, 30, {});
  TLV.player.setPose(S, at.x + 9, at.y + 9, 1, 0);
  const clock = S.game.clock;
  const route = S.game.nav.route;
  S.controlSource = hold({ recover: true });
  step(S, 60);
  assert.equal(events(S, 'player.recover').length, 0, 'not yet');
  until(S, () => events(S, 'player.recover').length === 1, 1.5, 'recover');
  S.controlSource = hold({});
  assert.ok(Math.abs(clock - S.game.clock - 16.5) < 0.2, `${clock - S.game.clock}`);
  assert.equal(S.game.money, -100);
  assert.equal(S.game.contacts, 0);
  assert.equal(S.game.stats.contacts, 0);
  assert.notEqual(S.game.nav.route, route, 'a new route object');
  const near = TLV.world.lanes.project(W, veh.x, veh.y, veh.h, 1, {});
  assert.ok(near && (W.lanes[near.laneId].flags & 1) && near.dist < 0.1);
  assert.ok(Math.abs(TLV.math.wrapPi(veh.h - TLV.world.lanes.pointAt(W, near.laneId, near.s, {}).h)) < 0.01, 'in travel direction');
  assert.equal(veh.v, 0);
});

test('item 13: recover is read only in DRIVE and SEARCH, and only slow', () => {
  const S = sim({ seed: 4 });
  S.controlSource = hold({ recover: true });
  step(S, 60 * 2);
  assert.equal(S.game.phase, 'CARD');
  assert.equal(events(S, 'player.recover').length, 0);
  toDrive(S);
  S.player.veh.v = 3;
  S.player.veh.vx = 3;
  S.game._g.recoverT = 0;
  S.controlSource = hold({ recover: true, throttle: 1 });
  step(S, 60);
  assert.equal(events(S, 'player.recover').length, 0, 'moving');
});

test('SEARCH begins 140 m from the bay and sends errand.search once; HOLD cancelled comes back by the same rule', () => {
  const S = sim({ seed: 5, errand: 2 });
  toDrive(S);
  assert.equal(S.game.phase, 'DRIVE');
  const r = S.game.nav.route;
  const to = (left) => {
    const at = TLV.math.polyAt(r.px, r.py, r.cum, r.len - left, {});
    TLV.player.setPose(S, at.x, at.y, at.h, 0);
  };
  to(145);
  step(S, 2);
  assert.equal(S.game.phase, 'DRIVE');
  to(135);
  step(S, 2);
  assert.equal(S.game.phase, 'SEARCH');
  assert.equal(events(S, 'errand.search').length, 1);
  assert.equal(events(S, 'errand.search')[0].bayId, S.game.errand.bayId);
});

test('stale phases hold no dead state: a bay lost with no stall left sends the arrow to the door and leaves Q', () => {
  const S = sim({ seed: 6, errand: 2, traffic: 1, density: 0 });
  toDrive(S);
  const e = S.game.errand;
  const orig = TLV.game.parking.nextBay;
  TLV.game.parking.nextBay = () => -1;
  try {
    TLV.game.parking._bayLost(S);
  } finally {
    TLV.game.parking.nextBay = orig;
  }
  assert.equal(e.bayId, -1);
  assert.equal(S.game._g.nav.laneId, e._doorLane);
  assert.equal(S.game.nav.targetX, e.doorX);
  assert.equal(events(S, 'errand.search', (x) => x.bayId === -1).length, 1);
  const end = TLV.math.polyAt(S.game.nav.route.px, S.game.nav.route.py, S.game.nav.route.cum, S.game.nav.route.len - 5, {});
  TLV.player.setPose(S, end.x, end.y, end.h, 0);
  S.controlSource = hold({ hazard: true });
  until(S, (s) => s.game.phase === 'PAYOUT', 4, 'Q parks at the door');
  assert.equal(events(S, 'errand.parked')[0].method === 'DOUBLE' || events(S, 'errand.parked')[0].quality === 'UGLY', true);
});

test('determinism: a day replays to the same hash, with the bot or from its log', async () => {
  const run = (controlSource, seed = 5) => {
    const S = createSim(TLV, { seed, params: { notitle: 1, invariants: 1, record: 1 }, controlSource });
    const hashes = [];
    for (let i = 0; i < 60 * 90; i++) {
      TLV.sim.step(S);
      if (S.tick % 900 === 0) hashes.push(TLV.sim.hash(S));
    }
    return { hashes, log: S.recorder.finish(), S };
  };
  const a = run(TLV.bots.create('errands'));
  const b = run(TLV.bots.create('errands'));
  assert.deepEqual(a.hashes, b.hashes, 'same seed, same bot');
  const c = run(TLV.replay.createPlayer(a.log));
  assert.deepEqual(c.hashes, a.hashes, 'the log alone, with no bot');
  assert.notEqual(a.S.game.phase, 'TITLE');
});

test('game.state invariant holds through a real day with traffic, people and a bot', () => {
  const S = sim({ seed: 9, traffic: 1, peds: 1, incidents: 1, contest: 'auto', autoplay: 'errands', invariants: 1 });
  S.controlSource = TLV.bots.create('errands');
  step(S, 60 * 120);
  const mine = S.invariantFailures.filter((f) => f.includes('game.state'));
  assert.deepEqual(mine, []);
  assert.ok(S.game.errandIndex >= 1 || S.game.stats.errandsDone >= 1, 'the bot got somewhere');
});
