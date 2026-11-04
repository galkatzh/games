// tests/core/debug.test.mjs — WP-CORE
import assert from 'node:assert';
import { test } from 'node:test';
import { createSim } from '../../tools/lib/classic.mjs';
import { captureWarnings, coreTLV, installStubSystems } from './helpers.mjs';

function setup(opts = {}) {
  const TLV = coreTLV();
  installStubSystems(TLV);
  const S = createSim(TLV, { seed: 4, world: { id: 'w' }, ...opts });
  return { TLV, S };
}

test('register exposes a hook, and cannot replace the registry itself', () => {
  const TLV = coreTLV();
  TLV.debug.register('ping', () => 'pong');
  assert.strictEqual(TLV.debug.ping(), 'pong');
  const warnings = captureWarnings(() => TLV.debug.register('use', () => {}));
  assert.strictEqual(warnings.length, 1);
  assert.notStrictEqual(TLV.debug.use.length, 0);
});

test('createSim makes the sim current, and hooks read it without S', () => {
  const { TLV, S } = setup();
  assert.strictEqual(TLV.debug.current(), S);
  assert.strictEqual(TLV.debug.hash(), TLV.sim.hash(S));
});

test('current falls back to TLV.app.S, as in the browser', () => {
  const TLV = coreTLV();
  assert.strictEqual(TLV.debug.current(), null);
  TLV.app = { S: { marker: true } };
  assert.strictEqual(TLV.debug.current().marker, true);
});

test('hooks with no sim return null or false, and never throw', () => {
  const TLV = coreTLV();
  assert.strictEqual(TLV.debug.state(), null);
  assert.strictEqual(TLV.debug.hash(), null);
  assert.strictEqual(TLV.debug.step(5), null);
  assert.strictEqual(TLV.debug.setInput({}), false);
  assert.strictEqual(TLV.debug.exportReplay(), null);
  assert.strictEqual(TLV.debug.importReplay({ header: {} }), null);
});

test('state has exactly the shape of section 16.2', () => {
  const { TLV } = setup();
  const s = TLV.debug.state();
  assert.deepStrictEqual(Object.keys(s).sort(), [
    'bayId', 'chain', 'clock', 'contest', 'counts', 'doorX', 'doorY', 'endReason', 'errandId', 'errandIndex', 'heat', 'hp',
    'incidents', 'invariantFailures', 'knife', 'map', 'money', 'park', 'phase', 'phaseT', 'player', 'problems', 'rank',
    'seed', 'stats', 't', 'tick', 'traffic'
  ]);
  assert.deepStrictEqual(Object.keys(s.player).sort(), ['h', 'laneId', 'mode', 'surface', 'v', 'wrongWay', 'x', 'y']);
  assert.deepStrictEqual(Object.keys(s.counts).sort(), ['peds', 'target', 'vehicles']);
  assert.deepStrictEqual(Object.keys(s.traffic).sort(), ['meanSpeed', 'stationaryShare']);
  assert.deepStrictEqual(Object.keys(s.chain).sort(), ['bank', 'mult', 'n']);
  assert.deepStrictEqual(Object.keys(s.park).sort(), ['bar', 'kind', 'stage']);
});

test('state reports the live sim', () => {
  const { TLV, S } = setup();
  for (let i = 0; i < 10; i++) TLV.sim.step(S);
  const s = TLV.debug.state();
  assert.strictEqual(s.tick, 10);
  assert.strictEqual(s.t, S.t);
  assert.strictEqual(s.seed, 4);
  assert.strictEqual(s.map, 'w');
  assert.strictEqual(s.phase, 'DRIVE');
  assert.strictEqual(s.counts.vehicles, 20, 'AI cars, not counting the player');
  assert.strictEqual(s.counts.peds, 10);
  assert.strictEqual(s.counts.target, 20);
  assert.strictEqual(s.incidents.length, 0);
});

test('state follows the errand, contest, knife and incidents', () => {
  const { TLV, S } = setup();
  const g = S.game;
  g.errand = { defId: 'milk', doorX: 12, doorY: 34, bayId: 5 };
  g.contest = { state: 'BLINK', rage: 40, tier: null, rivalId: 3, spotId: 1 };
  g.knife = { stage: 'CHASE', strikes: 1, gap: 9, exit: null, tugBar: 1 };
  g.director.incidents.push({ id: 1, defId: 'BUS_PULLOUT', state: 'ACTIVE', aim: {} });
  const s = TLV.debug.state();
  assert.deepStrictEqual([s.errandId, s.doorX, s.doorY, s.bayId], ['milk', 12, 34, 5]);
  assert.deepStrictEqual(s.contest, { state: 'BLINK', rage: 40, tier: null, rivalId: 3 });
  assert.deepStrictEqual(s.knife, { stage: 'CHASE', strikes: 1, gap: 9, exit: null });
  assert.deepStrictEqual(s.incidents, [{ id: 1, defId: 'BUS_PULLOUT', state: 'ACTIVE' }]);
});

test('state uses the foot pose in FOOT mode', () => {
  const { TLV, S } = setup();
  S.player.mode = 'FOOT';
  Object.assign(S.player, { fx: 8, fy: 9 });
  Object.assign(S.player.foot, { active: true, x: 8, y: 9, h: 1.5, v: 6.4 });
  const { player } = TLV.debug.state();
  assert.deepStrictEqual([player.mode, player.x, player.y, player.h, player.v], ['FOOT', 8, 9, 1.5, 6.4]);
});

test('state survives JSON, as page.evaluate needs, and shares nothing with the sim', () => {
  const { TLV, S } = setup();
  const s = TLV.debug.state();
  assert.deepStrictEqual(JSON.parse(JSON.stringify(s)), s);
  s.stats.errandsDone = 99;
  assert.strictEqual(S.game.stats.errandsDone, 0);
});

test('state works on the bare allowMissing sim', () => {
  const TLV = coreTLV();
  let s;
  captureWarnings(() => {
    createSim(TLV, {});
    s = TLV.debug.state();
  });
  assert.strictEqual(s.tick, 0);
  assert.strictEqual(s.map, null);
  assert.strictEqual(s.counts.vehicles, 0);
  assert.strictEqual(s.phase, 'DRIVE');
});

test('step runs ticks synchronously and returns the tick', () => {
  const { TLV, S } = setup();
  assert.strictEqual(TLV.debug.step(25), 25);
  assert.strictEqual(S.tick, 25);
  assert.strictEqual(TLV.debug.step(), 26);
});

test('pause and resume report that Node has no loop', () => {
  const { TLV } = setup();
  assert.strictEqual(TLV.debug.pause(), false);
  assert.strictEqual(TLV.debug.resume(), false);
});

test('in the browser, step goes through the loop', () => {
  const { TLV, S } = setup();
  let stepped = 0;
  let paused = 0;
  let resumed = 0;
  TLV.app = {
    S,
    loop: {
      stepN: (n) => { stepped += n; S.tick += n; },
      pause: () => { paused++; },
      resume: () => { resumed++; }
    }
  };
  assert.strictEqual(TLV.debug.step(3), 3);
  assert.strictEqual(stepped, 3);
  assert.strictEqual(TLV.debug.pause(), true);
  assert.strictEqual(TLV.debug.resume(), true);
  assert.deepStrictEqual([paused, resumed], [1, 1]);
});

test('setInput overrides fields until cleared, and successive calls merge', () => {
  const { TLV, S } = setup();
  TLV.debug.setInput({ throttle: 1 });
  TLV.sim.step(S);
  assert.strictEqual(S.controls.throttle, 1);
  TLV.debug.setInput({ steer: -1 });
  TLV.sim.step(S);
  assert.strictEqual(S.controls.throttle, 1);
  assert.strictEqual(S.controls.steer, -1);
  TLV.debug.setInput(null);
  TLV.sim.step(S);
  assert.strictEqual(S.controls.throttle, 0, 'the default source returns S.controls itself, so nothing may linger');
  assert.strictEqual(S.controls.steer, 0);
});

test('setInput beats the control source', () => {
  const { TLV, S } = setup();
  S.controlSource = (s) => {
    s.controls.throttle = 0.25;
    s.controls.brake = 0.25;
    return s.controls;
  };
  TLV.debug.setInput({ throttle: 1 });
  TLV.sim.step(S);
  assert.strictEqual(S.controls.throttle, 1);
  assert.strictEqual(S.controls.brake, 0.25);
});

test('setInput ignores what is not a ControlState field', () => {
  const { TLV, S } = setup();
  TLV.debug.setInput({ throttle: 1, nonsense: 1 });
  TLV.sim.step(S);
  assert.strictEqual('nonsense' in S.controls, false);
});

test('exportReplay needs record=1', () => {
  const plain = setup();
  assert.strictEqual(plain.TLV.debug.exportReplay(), null);
  const { TLV, S } = setup({ params: { record: 1 } });
  TLV.debug.step(3);
  assert.strictEqual(TLV.debug.exportReplay().inputs[0][0], 3);
  assert.strictEqual(S.tick, 3);
});

test('importReplay replays from a fresh sim on the same world, in Node', () => {
  const { TLV, S } = setup({ params: { record: 1 } });
  TLV.debug.setInput({ throttle: 1, steer: 0.1 });
  TLV.debug.step(120);
  const hash = TLV.debug.hash();
  const log = JSON.parse(JSON.stringify(TLV.debug.exportReplay()));
  assert.deepStrictEqual(TLV.debug.importReplay(log), { seed: 4, ticks: 120 });
  const R = TLV.debug.current();
  assert.notStrictEqual(R, S);
  assert.strictEqual(R.world, S.world);
  assert.strictEqual(R.tick, 0);
  TLV.debug.step(120);
  assert.strictEqual(TLV.debug.hash(), hash);
});

test('importReplay hands the new sim to TLV.app.adopt in the browser', () => {
  const { TLV, S } = setup({ params: { record: 1 } });
  TLV.debug.step(5);
  const log = TLV.debug.exportReplay();
  let adopted = null;
  TLV.app = { S, adopt: (next) => { adopted = next; } };
  TLV.debug.importReplay(log);
  assert.strictEqual(adopted.tick, 0);
  assert.strictEqual(adopted.params.autoplay, null, 'a replay must not bring the bot back');
});

/** Records 120 ticks under these options, then starts a second sim that must have no say in the replay. */
function recordThenLand(recordOpts, landOpts = {}) {
  const { TLV } = setup({ ...recordOpts, params: { record: 1, ...recordOpts.params } });
  TLV.debug.setInput({ throttle: 1, steer: 0.1 });
  TLV.debug.step(120);
  const hash = TLV.debug.hash();
  const log = JSON.parse(JSON.stringify(TLV.debug.exportReplay()));
  createSim(TLV, { seed: 99, world: { id: 'w' }, ...landOpts });
  return { TLV, hash, log };
}

/** Imports the log, steps it to the end and checks the hash. Nothing should warn: the sim matches its log. */
function assertReplays({ TLV, hash, log }) {
  TLV.debug.importReplay(log);
  const R = TLV.debug.current();
  assert.deepStrictEqual(captureWarnings(() => TLV.debug.step(120)), []);
  assert.strictEqual(TLV.debug.hash(), hash);
  return R;
}

for (const flag of ['traffic', 'peds', 'incidents']) {
  test(`a log recorded with ${flag}=0 replays with ${flag} off in a default sim`, () => {
    const run = recordThenLand({ params: { [flag]: 0 } });
    assert.strictEqual(run.log.header.params[flag], 0);
    assert.strictEqual(run.TLV.debug.current().flags[flag], true, 'the sim it lands in has it on');
    const R = assertReplays(run);
    assert.deepStrictEqual(R.flags, { traffic: true, peds: true, incidents: true, [flag]: false });
  });

  test(`a log recorded with ${flag} on replays with it on in a sim that has it off`, () => {
    const R = assertReplays(recordThenLand({}, { params: { [flag]: 0 } }));
    assert.deepStrictEqual(R.flags, { traffic: true, peds: true, incidents: true });
  });

  test(`a log from a sim with opts.flags ${flag} false replays with ${flag} off`, () => {
    const R = assertReplays(recordThenLand({ flags: { [flag]: false } }));
    assert.strictEqual(R.flags[flag], false);
  });
}

test('flags of the current sim do not leak into a replay, even when passed as opts.flags', () => {
  const R = assertReplays(recordThenLand({}, { flags: { traffic: false, peds: false, incidents: false } }));
  assert.deepStrictEqual(R.flags, { traffic: true, peds: true, incidents: true });
});

test('a replay of a replay still matches', () => {
  const { TLV, hash, log } = recordThenLand({ params: { traffic: 0, peds: 0 } });
  assertReplays({ TLV, hash, log });
  const again = JSON.parse(JSON.stringify(TLV.debug.exportReplay()));
  assert.deepStrictEqual(again.header.params.traffic, 0);
  assertReplays({ TLV, hash, log: again });
});
