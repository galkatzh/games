// tests/game/rage.test.mjs — WP-GAME
// ARCHITECTURE 19 item 5: every factor, the tier edges, and every knife rule, through the real flow where the flow decides.
import test from 'node:test';
import { assert, realTLV, sim, step, until, toDrive, events, bayOf, nextErrand } from './helpers.mjs';

const TLV = realTLV();
const T = TLV.tune.game;

/** A run on an errand, with a contest open at the bay. */
function contest(seed, errand, rage, params = {}) {
  const S = sim({ seed, errand, traffic: 1, density: 0, ...params });
  toDrive(S);
  TLV.debug.use(S);
  const r = TLV.debug.forceContest({ rage });
  assert.ok(r.rivalId >= 0, 'a rival');
  return S;
}

/** Waits for him to be at the bay, then parks: a steal. @returns {object} The contest. */
function steal(S) {
  const c = S.game.contest;
  const spot = bayOf(S);
  const rival = TLV.traffic.byId(S, c.rivalId);
  until(S, () => c.state !== 'CRUISE' && TLV.math.dist(rival.x, rival.y, spot.x, spot.y) <= T.stealM - 2, 14, 'at the bay');
  assert.equal(TLV.debug.parkNow({ quality: 'GOOD' }), true);
  assert.equal(c.steal, true);
  return c;
}

test('item 5: every factor, on an errand with no floor', () => {
  const S = contest(1, 5);
  const c = S.game.contest;
  S.game.knivesDone = 1;
  const f = c.factors;
  Object.assign(f, { blinkerFirst: false, passed: false, close: false, honked: false, steals: 0 });
  assert.equal(TLV.game.rage.compute(S), 30);
  f.blinkerFirst = true;
  assert.equal(TLV.game.rage.compute(S), 55);
  f.passed = true;
  assert.equal(TLV.game.rage.compute(S), 75);
  f.close = true;
  assert.equal(TLV.game.rage.compute(S), 90);
  f.honked = true;
  assert.equal(TLV.game.rage.compute(S), 100);
  f.steals = 2;
  assert.equal(TLV.game.rage.compute(S), 120);
});

test('item 5: the live factors: blinker first, close, honked, passed and earlier steals', () => {
  const S = contest(2, 5);
  const c = S.game.contest;
  S.game.knivesDone = 1;
  const rival = TLV.traffic.byId(S, c.rivalId);
  until(S, () => c.state !== 'CRUISE', 10, 'BLINK');
  assert.equal(c.factors.blinkerFirst, S.game.nav.remaining > 0, 'he was nearer the bay when he signalled');
  // The horn, with him dead ahead and near.
  const dx = rival.x - S.player.veh.x;
  const dy = rival.y - S.player.veh.y;
  const h = Math.atan2(dy, dx);
  TLV.player.setPose(S, rival.x - Math.cos(h) * 12, rival.y - Math.sin(h) * 12, h, 0);
  S.bus.emit('player.horn', { x: S.player.veh.x, y: S.player.veh.y, h });
  assert.equal(c.factors.honked, true);
  // A horn behind him and far off does not count.
  const other = contest(2, 5);
  const c2 = other.game.contest;
  const r2 = TLV.traffic.byId(other, c2.rivalId);
  other.bus.emit('player.horn', { x: r2.x + 100, y: r2.y, h: 0 });
  assert.equal(c2.factors.honked, false);
  // Close, by bumper.
  TLV.player.setPose(other, r2.x - Math.cos(r2.h) * 8, r2.y - Math.sin(r2.h) * 8, r2.h, 0);
  step(other, 1);
  assert.equal(c2.factors.close, true);
  TLV.player.setPose(other, r2.x - Math.cos(r2.h) * 30, r2.y - Math.sin(r2.h) * 30, r2.h, 0);
  step(other, 1);
  assert.equal(c2.factors.close, false);
  // Passed: nearer the bay than him, having been behind him inside the last 30 m.
  c2._r.behindT = true;
  other.game.nav.remaining = 2;
  step(other, 1);
  // Earlier steals are counted when a contest starts.
  const third = sim({ seed: 3, errand: 5, traffic: 1, density: 0 });
  toDrive(third);
  third.game.stats.spotsStolen = 2;
  TLV.debug.use(third);
  TLV.debug.forceContest({});
  assert.equal(third.game.contest.factors.steals, 2);
});

test('item 5: tiers at 44, 45, 74 and 75, through a real steal', () => {
  for (const [rage, tier] of [[44, 'CURSE'], [45, 'BLOCK'], [74, 'BLOCK'], [75, 'KNIFE']]) {
    const S = contest(3, 3, rage);
    const c = steal(S);
    assert.equal(c.rage, rage);
    assert.equal(c.tier, tier, `rage ${rage}`);
    assert.equal(events(S, 'errand.parked')[0].pay === null, tier === 'KNIFE');
    step(S, 25);
    if (tier === 'KNIFE') assert.equal(S.game.phase, 'ENCOUNTER');
    if (tier === 'BLOCK') assert.equal(S.game.phase, 'BLOCKED');
    if (tier === 'CURSE') {
      assert.equal(S.game.phase, 'PAYOUT');
      assert.equal(events(S, 'bubble', (b) => b.text === '#@!').length, 1);
    }
    assert.equal(events(S, 'contest.result')[0].tier, tier);
  }
});

test('BLOCK pins the player 5 s, and then PAYOUT picks up where it left off', () => {
  const S = contest(3, 3, 60);
  const c = steal(S);
  assert.equal(c.tier, 'BLOCK');
  until(S, (s) => s.game.phase === 'BLOCKED', 1, 'BLOCKED');
  const saved = S.game._g.phaseSave;
  assert.ok(Math.abs(saved - T.revealS) < 0.05);
  const clock = S.game.clock;
  const money = S.game.money;
  until(S, (s) => s.game.phase === 'PAYOUT', 5.2, 'back');
  assert.ok(Math.abs(S.game.phaseT - saved) < 0.05, 'the timer was restored');
  assert.equal(S.game.clock, clock, 'clock frozen');
  assert.equal(S.game.money, money, 'nothing paid twice');
  until(S, (s) => s.game.phase === 'CARD', 3, 'CARD');
});

test('item 5: the first knife is forced on errand 2 or 3 by a steal, whatever the factors say', () => {
  for (const errand of [2, 3]) {
    const S = contest(4, errand);
    const c = steal(S);
    assert.ok(c.rage >= 75);
    assert.equal(c.tier, 'KNIFE', `errand ${errand}`);
  }
  const later = contest(4, 4);
  later.game.knivesDone = 1;
  later.game.lastKnifeErrand = 0;
  later.game.contest.factors.blinkerFirst = false;
  assert.ok(TLV.game.rage.compute(later) < 75, 'no floor after the first');
});

test('item 5: never on errand 1 or the gan: capped at 44 and 74', () => {
  const first = contest(5, 1);
  first.game.contest.factors = { blinkerFirst: true, passed: true, close: true, honked: true, steals: 3 };
  assert.equal(TLV.game.rage.compute(first), 44);
  assert.equal(TLV.game.rage.tier(first, 99), 'BLOCK');
  const gan = contest(5, 7);
  assert.equal(gan.game.errandIndex, 6);
  gan.game.contest.factors = { blinkerFirst: true, passed: true, close: true, honked: true, steals: 3 };
  assert.equal(TLV.game.rage.compute(gan), 74);
  assert.equal(TLV.game.rage.tier(gan, 99), 'BLOCK');
});

test('item 5: not on consecutive errands, at most 3, and BLOCK past 150 m from the door', () => {
  const S = contest(6, 4);
  const g = S.game;
  assert.equal(TLV.game.rage.tier(S, 80), 'KNIFE');
  g.lastKnifeErrand = 2;
  assert.equal(TLV.game.rage.tier(S, 80), 'BLOCK', 'errand 3 had one');
  g.lastKnifeErrand = 1;
  assert.equal(TLV.game.rage.tier(S, 80), 'KNIFE');
  g.knivesDone = 3;
  assert.equal(TLV.game.rage.tier(S, 80), 'BLOCK', 'three is the most');
  g.knivesDone = 1;
  g.errand._doorM = 151;
  assert.equal(TLV.game.rage.tier(S, 80), 'BLOCK', 'too far for a chase');
  g.errand._doorM = 149;
  assert.equal(TLV.game.rage.tier(S, 80), 'KNIFE');
});

test('?knife=off forbids it, and ?knife=force forces it on any steal it may touch', () => {
  const off = contest(7, 3, 90, { knife: 'off' });
  assert.equal(steal(off).tier, 'BLOCK');
  const on = contest(7, 3, 10, { knife: 'force' });
  assert.equal(steal(on).tier, 'KNIFE');
  const tut = contest(7, 1, 10, { knife: 'force' });
  assert.notEqual(TLV.game.rage.tier(tut, 100), 'KNIFE', 'never on errand 1');
});

test('a run of steals: knives apart, three at most', () => {
  const S = sim({ seed: 8, traffic: 1, density: 0, immortal: 1 });
  const seen = [];
  for (let i = 0; i < 7; i++) {
    TLV.debug.use(S);
    toDrive(S);
    const index = S.game.errandIndex;
    TLV.debug.forceContest({ rage: 90 });
    S.game.errand._doorM = 100;
    steal(S);
    seen.push(S.game.contest.tier);
    until(S, (s) => s.game.phase !== 'PAYOUT' && s.game.phase !== 'HOLD', 4, 'revealed');
    if (S.game.phase === 'ENCOUNTER') {
      TLV.debug.setStrikes(0);
      S.game.knife.exit = 'WHISTLE';
      S.game.knife.stage = 'CHASE';
      S.player.mode === 'LOCKED' && TLV.foot.enter(S, S.player.veh.x, S.player.veh.y, 0);
      S.game.knife.stageT = 26;
      S.game.knife.exit = null;
      step(S, 2);
    }
    until(S, (s) => s.game.errandIndex !== index || s.game.phase === 'RUN_END', 14, 'next');
    if (S.game.phase === 'RUN_END') break;
  }
  console.log(`tiers across a day: ${seen.join(' ')}`);
  assert.equal(seen[0], 'CURSE', 'errand 1 is capped at 44, even a forced 90');
  const knives = seen.map((t, i) => (t === 'KNIFE' ? i : -1)).filter((i) => i >= 0);
  assert.ok(knives.length >= 1 && knives.length <= 3);
  assert.equal(seen[6], 'BLOCK', 'never on the gan');
  for (let i = 1; i < knives.length; i++) assert.ok(knives[i] - knives[i - 1] >= 2, 'never consecutive');
});
