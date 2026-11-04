// tests/game/difficulty.test.mjs — WP-GAME
// The title card's choice: TLV.game.setDifficulty and getDifficulty, the table in tune.js, and a day a slower driver can finish.
import test from 'node:test';
import { assert, realTLV, sim, step, until, toDrive, hold } from './helpers.mjs';
import { createSim } from '../../tools/lib/classic.mjs';

const TLV = realTLV();
const T = TLV.tune.game;

test('the table holds the two difficulties, and normal is the design', () => {
  assert.deepEqual(T.difficulty, { relaxed: { startS: 200, awardScale: 2.7 }, normal: { startS: 120, awardScale: 1.0 } });
});

test('the default is normal, and a run starts on its clock', () => {
  const S = sim({ seed: 2 });
  TLV.debug.use(S);
  assert.equal(TLV.game.getDifficulty(), 'normal');
  assert.equal(S.game.difficulty, 'normal');
  assert.equal(S.game.clock, 120);
});

test('?difficulty=relaxed reads through the config path, and starts the first run on it', () => {
  const params = TLV.config.parse('?difficulty=relaxed');
  assert.equal(params.difficulty, 'relaxed');
  const S = sim({ seed: 2, difficulty: params.difficulty });
  assert.equal(S.game.difficulty, 'relaxed');
  assert.equal(S.game.clock, 200);
  const flat = (S.game.errand.routeLen / T.awardDiv + T.awardBase);
  assert.ok(Math.abs(S.game.errand.award - flat * 2.7) < 1e-9, 'award scaled');
});

test('an unknown difficulty changes nothing, including one Object.prototype would answer to', () => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    const S = sim({ seed: 2, difficulty: 'nightmare' });
    TLV.debug.use(S);
    assert.equal(S.game.difficulty, 'normal');
    for (const id of ['nightmare', 'constructor', '__proto__', '', null, undefined]) assert.equal(TLV.game.setDifficulty(id), false, String(id));
    assert.equal(TLV.game.getDifficulty(), 'normal');
  } finally {
    console.warn = warn;
  }
});

test('a choice takes effect at the next startRun, not in the run under way', () => {
  const S = sim({ seed: 3 });
  TLV.debug.use(S);
  const before = S.game.errand.award;
  const clock = S.game.clock;
  assert.equal(TLV.game.setDifficulty('relaxed'), true);
  assert.equal(TLV.game.getDifficulty(), 'relaxed');
  assert.equal(S.game.clock, clock, 'the clock of the run under way stands');
  assert.equal(S.game.errand.award, before, 'and so does its award');
  TLV.debug.parkNow({});
  until(S, (s) => s.game.errandIndex === 1, 12, 'the next errand');
  const e = S.game.errand;
  const plain = (e.routeLen / T.awardDiv + T.awardBase) * (1 - T.kStep);
  assert.ok(Math.abs(e.award - plain) < 1e-9, 'the run under way keeps its scale for all its errands');
  TLV.game.flow.startRun(S);
  assert.equal(S.game.difficulty, 'relaxed', 'the choice outlives the run');
  assert.equal(S.game.clock, 200);
  assert.ok(Math.abs(S.game.errand.award - (S.game.errand.routeLen / T.awardDiv + T.awardBase) * 2.7) < 1e-9);
  TLV.game.setDifficulty('normal');
  TLV.game.flow.startRun(S);
  assert.equal(S.game.clock, 120);
});

test('an explicit clock wins over the table, from the URL and from startRun alike', () => {
  const S = sim({ seed: 3, difficulty: 'relaxed', clock: 90 });
  assert.equal(S.game.clock, 90);
  TLV.game.flow.startRun(S, { clock: 77 });
  assert.equal(S.game.clock, 77);
});

test('?clock=120&difficulty=relaxed means 120: an explicit clock is told from an unset one', () => {
  const start = (query) => {
    const { clock, clockGiven, difficulty } = TLV.config.parse(query);
    return sim({ seed: 3, clock, clockGiven, difficulty }).game.clock;
  };
  assert.equal(start('?clock=120&difficulty=relaxed'), 120);
  assert.equal(start('?difficulty=relaxed'), 200);
  assert.equal(start('?clock=90&difficulty=relaxed'), 90);
  assert.equal(start('?clock=120'), 120);
  assert.equal(start(''), 120);
});

/** Sits at the title, takes a difficulty from the card, presses a key, and drives a little. @returns {object} Log and final hash. */
function titleRun(pick) {
  const S = createSim(TLV, { seed: 5, params: { record: 1, traffic: 0, peds: 0, incidents: 0, contest: 'off' } });
  TLV.debug.use(S);
  for (let i = 0; i < 6; i++) TLV.sim.step(S);
  if (pick) assert.equal(TLV.game.setDifficulty(pick), true);
  S.controlSource = hold({ start: true });
  for (let i = 0; i < 4; i++) TLV.sim.step(S);
  S.controlSource = hold({ throttle: 0.4 });
  for (let i = 0; i < 400; i++) TLV.sim.step(S);
  return { log: JSON.parse(JSON.stringify(S.recorder.finish())), hash: TLV.sim.hash(S), S };
}

test('a choice made on the title card reaches the replay header, and the replay holds hash for hash', () => {
  const { log, hash, S } = titleRun('relaxed');
  assert.equal(S.game._g.runDifficulty, 'relaxed');
  assert.equal(log.header.params.difficulty, 'relaxed');
  assert.deepEqual(log.header.difficulty.map((c) => c[1]), ['normal', 'relaxed']);
  const R = createSim(TLV, { seed: log.header.seed, params: log.header.params, controlSource: TLV.replay.createPlayer(log) });
  for (let i = 0; i < 410; i++) TLV.sim.step(R);
  assert.equal(R.game._g.runDifficulty, 'relaxed');
  assert.equal(R.game.clock, S.game.clock);
  assert.equal(TLV.sim.hash(R), hash);
});

test('a log with no choice stays as it was, and a second run on another choice replays too', () => {
  const { log, hash } = titleRun(null);
  assert.deepEqual(log.header.difficulty.map((c) => c[1]), ['normal']);
  const R = createSim(TLV, { seed: log.header.seed, params: log.header.params, controlSource: TLV.replay.createPlayer(log) });
  for (let i = 0; i < 410; i++) TLV.sim.step(R);
  assert.equal(TLV.sim.hash(R), hash);
  // Two runs in one log, on two choices: the first relaxed, the restart normal.
  const S = createSim(TLV, { seed: 6, params: { record: 1, traffic: 0, peds: 0, incidents: 0, contest: 'off' } });
  TLV.debug.use(S);
  TLV.game.setDifficulty('relaxed');
  S.controlSource = hold({ start: true });
  for (let i = 0; i < 4; i++) TLV.sim.step(S);
  S.controlSource = hold({});
  for (let i = 0; i < 30; i++) TLV.sim.step(S);
  TLV.game.setDifficulty('normal');
  TLV.game.flow.endRun(S, 'CLOCK');
  S.controlSource = hold({ restart: true });
  for (let i = 0; i < 30; i++) TLV.sim.step(S);
  const two = JSON.parse(JSON.stringify(S.recorder.finish()));
  assert.equal(S.game.clock > 110 && S.game.clock <= 120, true, `the restart runs on normal: ${S.game.clock}`);
  assert.deepEqual(two.header.difficulty.map((c) => c[1]), ['relaxed', 'normal']);
});

test('the difficulty is part of the hash, and two runs of one choice agree', () => {
  const a = sim({ seed: 4 });
  const b = sim({ seed: 4 });
  assert.equal(TLV.sim.hash(a), TLV.sim.hash(b));
  b.game.difficulty = 'relaxed';
  assert.notEqual(TLV.sim.hash(a), TLV.sim.hash(b), 'with every other field equal');
  const c = sim({ seed: 4, difficulty: 'relaxed' });
  const d = sim({ seed: 4, difficulty: 'relaxed' });
  step(c, 120);
  step(d, 120);
  assert.equal(TLV.sim.hash(c), TLV.sim.hash(d));
});

/** The kinematic ghost of clock.test.mjs: real flow and errands, along nav.route at a speed, parking after a delay. */
function day(seed, difficulty, speed, overhead) {
  const S = sim({ seed, difficulty });
  const dt = TLV.const.DT;
  let s = 0;
  let route = null;
  let wait = 0;
  for (let i = 0; i < 60 * 1500; i++) {
    const G = S.game;
    if (G.phase === 'RUN_END') break;
    if ((G.phase === 'DRIVE' || G.phase === 'SEARCH') && G.errand) {
      if (G.nav.route !== route) {
        route = G.nav.route;
        s = 0;
        wait = 0;
      }
      s += speed * dt;
      if (s >= route.len) {
        wait += dt;
        if (wait >= overhead) {
          G.contacts = 1;
          TLV.debug.use(S);
          TLV.debug.parkNow({ quality: 'GOOD' });
          if (G.errandIndex === 6) return { won: true, errand: 7, left: G.clock };
          route = null;
        }
      } else {
        const at = G._g.pt;
        TLV.math.polyAt(route.px, route.py, route.cum, s, at);
        TLV.player.setPose(S, at.x, at.y, at.h, 0);
      }
    }
    TLV.sim.step(S);
  }
  return { won: S.game.endReason === 'WIN', errand: S.game.errandIndex + 1, left: 0 };
}

test('a weaving driver at 6-7 m/s can win on relaxed, and cannot on normal', () => {
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8];
  for (const speed of [6, 7]) {
    const relaxed = seeds.map((seed) => day(seed, 'relaxed', speed, 15));
    const normal = seeds.map((seed) => day(seed, 'normal', speed, 15));
    console.log(`${speed} m/s: relaxed wins ${relaxed.filter((r) => r.won).length} of ${seeds.length}, left ${relaxed.map((r) => r.left.toFixed(0)).join(' ')}; normal ends on ${normal.map((r) => r.errand).join(' ')}`);
    assert.equal(relaxed.filter((r) => r.won).length, seeds.length, `${speed} m/s on relaxed`);
    assert.equal(normal.filter((r) => r.won).length, 0, `${speed} m/s on normal`);
  }
});

test('the first drive of a relaxed day plays with the same traffic and clock rules', () => {
  const S = sim({ seed: 5, difficulty: 'relaxed', traffic: 1, peds: 1 });
  toDrive(S);
  const clock = S.game.clock;
  step(S, 60);
  assert.ok(Math.abs(S.game.clock - (clock - 1)) < 0.05, 'the clock runs at one second a second');
});
