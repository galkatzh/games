// tests/game/score.test.mjs — WP-GAME
// GAME_DESIGN 8, and ARCHITECTURE 19 items 7 and 12: damage, chain, pay, and hitting a person.
import test from 'node:test';
import { assert, realTLV, sim, step, until, toDrive, events, bayOf, hold } from './helpers.mjs';

const TLV = realTLV();
const T = TLV.tune.game;

const contact = (S, severity, rearEnded = false) => S.bus.emit('player.contact', { kind: 'vehicle', otherId: 9, vn: 2, severity, rearEnded, x: 0, y: 0 });

test('No-Claims: the table, and a rear-end costs half and nothing else', () => {
  const S = sim();
  toDrive(S);
  const g = S.game;
  contact(S, 'scrape');
  assert.equal(g.hp, 96);
  contact(S, 'bump');
  assert.equal(g.hp, 84);
  contact(S, 'crash');
  assert.equal(g.hp, 54);
  assert.equal(g.contacts, 3);
  contact(S, 'crash', true);
  assert.equal(g.hp, 39);
  contact(S, 'bump', true);
  assert.equal(g.hp, 33);
  assert.equal(g.contacts, 3, 'a rear-end is not a contact');
  assert.equal(g.stats.contacts, 3);
});

test('a real scripted impact into a parked car costs what its speed says', () => {
  const S = sim({ seed: 2, errand: 2 });
  toDrive(S);
  const W = S.world;
  const veh = S.player.veh;
  const ids = [];
  TLV.world.parking.parkedNear(S, veh.x, veh.y, 200, ids);
  const spot = TLV.world.parking.spot(W, ids.find((id) => TLV.world.parking.state(S, id) === TLV.const.OCC.PARKED));
  TLV.player.setPose(S, spot.x - Math.cos(spot.h) * 7, spot.y - Math.sin(spot.h) * 7, spot.h, 10);
  S.controlSource = hold({ throttle: 1 });
  step(S, 40);
  assert.equal(events(S, 'player.contact').length >= 1, true);
  assert.equal(S.game.hp, 100 - T.hpCrash, 'over 9 m/s is a crash');
  assert.equal(S.game.contacts, 1);
});

test('the chain: x(1 + n/3) to x5, banks at each near miss, and a contact loses the multiplier and not the bank', () => {
  const S = sim();
  toDrive(S);
  const g = S.game;
  const near = (tier) => S.bus.emit('player.nearMiss', { vehId: 1, gap: 0.5, relSpeed: 7, tier, x: 0, y: 0 });
  near(1);
  assert.equal(g.chain.n, 1);
  assert.ok(Math.abs(g.chain.mult - 4 / 3) < 1e-9);
  assert.ok(Math.abs(g.chain.bank - 15 * 4 / 3) < 1e-9);
  near(2);
  assert.ok(Math.abs(g.chain.bank - (20 + 40 * 5 / 3)) < 1e-9);
  for (let i = 0; i < 20; i++) near(1);
  assert.equal(g.chain.mult, 5);
  const bank = g.chain.bank;
  contact(S, 'scrape', true);
  assert.equal(g.chain.mult, 5, 'a rear-end does not break it');
  contact(S, 'scrape');
  assert.equal(g.chain.n, 0);
  assert.equal(g.chain.mult, 1);
  assert.equal(g.chain.bank, bank);
  assert.equal(g.stats.nearMisses, 22);
});

test('the chain window is 4 s', () => {
  const S = sim();
  toDrive(S);
  S.bus.emit('player.nearMiss', { vehId: 1, gap: 0.5, relSpeed: 7, tier: 1, x: 0, y: 0 });
  step(S, 60 * 3.9);
  assert.equal(S.game.chain.n, 1);
  step(S, 16);
  assert.equal(S.game.chain.n, 0);
});

test('pay: (80 + 0.1 route) x P x C + bank, C for each contact and for none, and the bank is spent once', () => {
  const pay = (quality, method, contacts, bank) => {
    const S = sim({ seed: 3, errand: 2 });
    toDrive(S);
    const g = S.game;
    g.contacts = contacts;
    g.chain.bank = bank;
    TLV.debug.use(S);
    TLV.debug.parkNow({ quality, method });
    const parked = events(S, 'errand.parked')[0];
    assert.equal(g.chain.bank, 0);
    return { pay: parked.pay, base: T.payBase + T.payPerM * g.errand.routeLen };
  };
  let r = pay('PERFECT', 'BAY', 0, 0);
  assert.equal(r.pay, Math.round(r.base * 1.5 * 1.5));
  r = pay('GOOD', 'BAY', 0, 0);
  assert.equal(r.pay, Math.round(r.base * 1.2 * 1.5));
  r = pay('UGLY', 'BAY', 1, 0);
  assert.equal(r.pay, Math.round(r.base * 1 * 0.75));
  r = pay('UGLY', 'BAY', 2, 100);
  assert.equal(r.pay, Math.round(r.base * 1 * 0.5 + 100));
  r = pay('GOOD', 'BAY', 9, 0);
  assert.equal(r.pay, Math.round(r.base * 1.2 * 0.25), 'C floors at 0.25');
  r = pay('DOUBLE', 'DOUBLE', 0, 0);
  assert.equal(r.pay, Math.round(r.base * 0.5 * 1), 'no SPOTLESS C for a double-park');
  r = pay('UGLY', 'RED_WHITE', 0, 0);
  assert.equal(r.pay, Math.round(r.base * 1 * 1));
});

test('SPOTLESS: +8 s and +10 HP in a bay with no contact', () => {
  const S = sim({ seed: 3, errand: 2 });
  toDrive(S);
  const g = S.game;
  g.hp = 50;
  TLV.debug.use(S);
  TLV.debug.parkNow({ quality: 'GOOD' });
  assert.equal(g.hp, 60);
  assert.equal(events(S, 'score.bonus', (b) => b.id === 'SPOTLESS' && b.seconds === 8).length, 1);
  assert.equal(events(S, 'errand.parked')[0].spotless, true);
  const dirty = sim({ seed: 3, errand: 2 });
  toDrive(dirty);
  dirty.game.contacts = 1;
  TLV.debug.use(dirty);
  TLV.debug.parkNow({ quality: 'GOOD' });
  assert.equal(events(dirty, 'score.bonus', (b) => b.id === 'SPOTLESS').length, 0);
});

test('the award: (route/8 + 14) x k x M, on the bay route', () => {
  for (const [errand, k] of [[1, 1], [2, 0.95], [4, 0.85], [7, 0.7]]) {
    const S = sim({ seed: 4, errand });
    const e = S.game.errand;
    assert.ok(Math.abs(e.award - (e.routeLen / 8 + 14) * k) < 1e-9, `errand ${errand}`);
    assert.ok(Math.abs(e.routeLen - S.game.nav.route.len) < 1e-9, 'locked on the route to the bay');
  }
});

test('bonuses: BEAT THE HONK and the tally', () => {
  const S = sim();
  toDrive(S);
  const m = S.game.money;
  S.bus.emit('player.launch', {});
  assert.equal(S.game.money, m + 25);
  S.bus.emit('traffic.honk', { vehId: 1, atPlayer: true, x: 0, y: 0 });
  S.bus.emit('traffic.honk', { vehId: 1, atPlayer: false, x: 0, y: 0 });
  assert.equal(S.game.stats.honksReceived, 1);
  S.bus.emit('player.redRun', { juncId: 1 });
  assert.equal(S.game.stats.redsRun, 1);
});

test('rank: NEW DRIVER to LEGEND', () => {
  const r = TLV.game.score.rank;
  assert.equal(r(799), 'NEW_DRIVER');
  assert.equal(r(800), 'BUS_DRIVER');
  assert.equal(r(1999), 'BUS_DRIVER');
  assert.equal(r(2000), 'TAXI_DRIVER');
  assert.equal(r(3499), 'TAXI_DRIVER');
  assert.equal(r(3500), 'DELIVERY_RIDER');
  assert.equal(r(5499), 'DELIVERY_RIDER');
  assert.equal(r(5500), 'LEGEND');
  assert.equal(r(-500), 'NEW_DRIVER');
});

/** A real hit: a person placed ahead of the moving car. */
function hit(S, kind = 'walker') {
  const veh = S.player.veh;
  const p = TLV.peds.spawn(S, { kind, x: veh.x + Math.cos(veh.h) * 4, y: veh.y + Math.sin(veh.h) * 4, state: 'SCRIPT' });
  TLV.player.setPose(S, veh.x, veh.y, veh.h, 8);
  S.controlSource = hold({ throttle: 0.5 });
  step(S, 60);
  S.controlSource = hold({ brake: 1 });
  step(S, 20);
  return p;
}

test('item 7: a real hit: -₪500, -30 s, chain broken, this errand pays nothing, and no comic bonus', () => {
  const S = sim({ seed: 5, errand: 2, peds: 1 });
  toDrive(S);
  const g = S.game;
  S.bus.emit('player.nearMiss', { vehId: 1, gap: 0.5, relSpeed: 7, tier: 1, x: 0, y: 0 });
  const money = g.money;
  const clock = g.clock;
  hit(S);
  assert.equal(events(S, 'player.hitPed').length, 1);
  assert.equal(g.money, money - 500);
  assert.ok(clock - g.clock >= 30 && clock - g.clock < 33);
  assert.equal(g.chain.n, 0);
  assert.equal(g.pedHits, 1);
  assert.equal(g.pedHitThisErrand, true);
  TLV.debug.use(S);
  TLV.debug.parkNow({ quality: 'PERFECT' });
  const parked = events(S, 'errand.parked')[0];
  assert.equal(parked.pay, 0);
  assert.equal(parked.spotless, false, 'no reward of any kind on that errand');
  until(S, (s) => s.game.phase === 'CARD', 4, 'CARD');
  assert.equal(S.game.pedHitThisErrand, false, 'per errand');
  assert.equal(S.game.pedHits, 1, 'per run');
});

test('item 7: the second hit in a run ends it: LICENCE REVOKED', () => {
  const S = sim({ seed: 5, errand: 2, peds: 1 });
  toDrive(S);
  hit(S);
  assert.notEqual(S.game.phase, 'RUN_END');
  hit(S);
  assert.equal(S.game.phase, 'RUN_END');
  assert.equal(S.game.endReason, 'REVOKED');
  assert.equal(events(S, 'run.end')[0].reason, 'REVOKED');
});

test('item 7: one accident is one hit: driving on through it pays once, and the licence stays', () => {
  const S = sim({ seed: 5, errand: 2, peds: 1 });
  toDrive(S);
  const veh = S.player.veh;
  const p = TLV.peds.spawn(S, { kind: 'trolley', x: veh.x + Math.cos(veh.h) * 4, y: veh.y + Math.sin(veh.h) * 4, state: 'SCRIPT' });
  p.state = 'WALK';
  p._p.mode = 'STAND';
  p._p.after = 'BAY';
  p._p.job = 'SAVE';
  p._p.spot = -1;
  const money = S.game.money;
  TLV.player.setPose(S, veh.x, veh.y, veh.h, 6);
  S.controlSource = hold({ throttle: 0.2 });
  until(S, () => S.game.pedHits > 0, 2, 'the hit');
  assert.equal(p.state, 'STUMBLE');
  step(S, 180);
  assert.equal(events(S, 'player.hitPed').length, 1);
  assert.equal(S.game.pedHits, 1);
  assert.equal(S.game.money, money - T.pedMoney);
  assert.notEqual(S.game.phase, 'RUN_END');
});

test('item 7: every kind of person takes the same path, and riders count', () => {
  for (const kind of ['walker', 'phone', 'trolley', 'scooter', 'delivery', 'passenger', 'saver', 'inspector', 'attacker']) {
    const S = sim({ seed: 6, errand: 2, peds: 1 });
    toDrive(S);
    const before = S.game.money;
    hit(S, kind);
    assert.equal(S.game.money, before - 500, kind);
    assert.equal(S.game.pedHits, 1, kind);
  }
});

test('item 7: hitting the attacker gives no benefit by any path', () => {
  const S = sim({ seed: 7, errand: 2, peds: 1, traffic: 1, density: 0 });
  toDrive(S);
  TLV.debug.use(S);
  TLV.debug.forceContest({ rage: 80 });
  const c = S.game.contest;
  const rage = c.rage;
  const p = hit(S, 'attacker');
  assert.equal(p.state, 'SCRIPT', 'no state change on him');
  assert.equal(p.active, true);
  assert.equal(S.game.pedHits, 1);
  assert.equal(c.rage, rage, 'no rage reduction');
  assert.equal(events(S, 'score.bonus').length, 0);
  assert.equal(S.game.money, -500);
});

test('item 12: pay lands exactly once on every path: PAYOUT', () => {
  const S = sim({ seed: 8, errand: 2 });
  toDrive(S);
  TLV.debug.use(S);
  TLV.debug.parkNow({ quality: 'GOOD' });
  const pay = events(S, 'errand.parked')[0].pay;
  const money = S.game.money;
  assert.equal(money, pay);
  until(S, (s) => s.game.phase === 'DRIVE', 8, 'DRIVE');
  assert.equal(S.game.money, money);
  assert.equal(events(S, 'errand.paid').length, 0);
});

/** A contest with the rival at the bay, ended by a steal. */
function steal(S, rage) {
  TLV.debug.use(S);
  TLV.debug.forceContest({ rage });
  const c = S.game.contest;
  const spot = bayOf(S);
  const rival = TLV.traffic.byId(S, c.rivalId);
  until(S, () => c.state !== 'CRUISE' && TLV.math.dist(rival.x, rival.y, spot.x, spot.y) <= T.stealM - 2, 14, 'at the bay');
  TLV.debug.parkNow({ quality: 'GOOD' });
  return c;
}

test('item 12: pay lands exactly once: PAYOUT through BLOCKED', () => {
  const S = sim({ seed: 3, errand: 3, traffic: 1, density: 0 });
  toDrive(S);
  steal(S, 60);
  const parked = events(S, 'errand.parked');
  assert.equal(parked.length, 1);
  assert.ok(parked[0].pay > 0);
  const money = S.game.money;
  until(S, (s) => s.game.phase === 'BLOCKED', 1, 'BLOCKED');
  until(S, (s) => s.game.phase === 'CARD', 9, 'CARD');
  assert.equal(S.game.money, money);
  assert.equal(events(S, 'errand.parked').length, 1);
  assert.equal(S.game.stats.errandsDone, 1);
});

test('item 12: pay lands exactly once: ENCOUNTER to RESOLVE, null at parking and paid at RESOLVE', () => {
  const S = sim({ seed: 3, errand: 3, traffic: 1, density: 0, peds: 1 });
  toDrive(S);
  steal(S, 80);
  const parked = events(S, 'errand.parked')[0];
  assert.equal(parked.pay, null);
  assert.equal(S.game.errand.pay, null);
  assert.equal(S.game.stats.errandsDone, 0, 'not until an exit');
  const money = S.game.money;
  until(S, (s) => s.game.phase === 'ENCOUNTER', 1, 'ENCOUNTER');
  S.game.knife.stage = 'STANDOFF';
  S.controlSource = hold({ interact: true });
  until(S, (s) => s.game.knife.stage === 'CHASE', 4, 'CHASE');
  S.game.knife.gap = 20;
  S.game.knife._a.a = -30;
  until(S, (s) => s.game.phase === 'RESOLVE', 8, 'RESOLVE');
  const paid = events(S, 'errand.paid');
  assert.equal(paid.length, 1);
  assert.equal(paid[0].exit, 'SHAKEN');
  assert.equal(S.game.money, money + paid[0].pay);
  assert.equal(S.game.errand.pay, paid[0].pay);
  until(S, (s) => s.game.phase === 'CARD', 5, 'CARD');
  assert.equal(S.game.money, money + paid[0].pay);
  assert.equal(S.game.stats.errandsDone, 1);
});

test('item 12: CAUGHT pays nothing and counts nothing', () => {
  const S = sim({ seed: 3, errand: 3, traffic: 1, density: 0, peds: 1 });
  toDrive(S);
  steal(S, 80);
  until(S, (s) => s.game.phase === 'ENCOUNTER', 1, 'ENCOUNTER');
  S.controlSource = hold({});
  until(S, (s) => s.game.phase === 'RUN_END', 40, 'caught');
  assert.equal(S.game.errand.pay, null);
  assert.equal(events(S, 'errand.paid').length, 0);
  assert.equal(S.game.stats.errandsDone, 0);
});
