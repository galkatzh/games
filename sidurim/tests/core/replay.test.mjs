// tests/core/replay.test.mjs — WP-CORE
import assert from 'node:assert';
import { test } from 'node:test';
import { captureWarnings, coreTLV, installStubSystems, randomBot } from './helpers.mjs';

function stubTLV() {
  const TLV = coreTLV();
  installStubSystems(TLV);
  return TLV;
}

/** Runs a recorded sim with a bot. @returns {{log:object, hashes:number[]}} */
function recordRun(ticks, seed = 3) {
  const TLV = stubTLV();
  const S = TLV.sim.create({ seed, world: { id: 'w' }, params: { record: 1 }, controlSource: randomBot() });
  const hashes = [];
  for (let i = 0; i < ticks; i++) {
    TLV.sim.step(S);
    hashes.push(TLV.sim.hash(S));
  }
  return { log: S.recorder.finish(), hashes };
}

test('the header carries version, seed, map, content hash and params', () => {
  const TLV = stubTLV();
  TLV.q.push(['errand', { id: 'milk' }]);
  const S = TLV.sim.create({ seed: 9, world: { id: 'mini' }, params: { record: 1, density: 80 } });
  const { header, inputs } = S.recorder.finish();
  assert.strictEqual(header.version, 1);
  assert.strictEqual(header.seed, 9);
  assert.strictEqual(header.mapId, 'mini');
  assert.strictEqual(header.contentHash, TLV.registry.contentHash());
  assert.strictEqual(header.params.density, 80);
  assert.deepStrictEqual(inputs, []);
});

test('the header records the flags that ran, including those from opts.flags', () => {
  const TLV = stubTLV();
  const S = TLV.sim.create({ seed: 1, params: { record: 1, peds: 0 }, flags: { traffic: false, peds: true } });
  const { params } = S.recorder.finish().header;
  assert.deepStrictEqual([params.traffic, params.peds, params.incidents], [0, 1, 1]);
});

test('recording is off unless asked for', () => {
  const TLV = stubTLV();
  assert.strictEqual(TLV.sim.create({ seed: 1 }).recorder, null);
});

test('inputs are run-length encoded', () => {
  const TLV = stubTLV();
  const S = TLV.sim.create({ seed: 1, params: { record: 1 } });
  for (let i = 0; i < 100; i++) TLV.sim.step(S);
  S.controls.throttle = 1;
  S.controls.horn = true;
  for (let i = 0; i < 50; i++) TLV.sim.step(S);
  const { inputs } = S.recorder.finish();
  assert.strictEqual(inputs.length, 2);
  assert.strictEqual(inputs[0][0], 100);
  assert.strictEqual(inputs[1][0], 50);
  assert.strictEqual(inputs[1][1], 1);
  assert.notStrictEqual(inputs[1][6], 0, 'horn set a bit');
});

test('the log survives JSON, and every float comes back exact', () => {
  const { log } = recordRun(300);
  const copy = JSON.parse(JSON.stringify(log));
  assert.deepStrictEqual(copy, log);
});

test('finish returns a copy, and recording can continue afterwards', () => {
  const TLV = stubTLV();
  const S = TLV.sim.create({ seed: 1, params: { record: 1 } });
  TLV.sim.step(S);
  const first = S.recorder.finish();
  first.inputs[0][0] = 999;
  TLV.sim.step(S);
  assert.strictEqual(S.recorder.finish().inputs[0][0], 2);
});

test('the player reproduces every control field of every tick', () => {
  const TLV = stubTLV();
  const seen = [];
  const bot = (S) => {
    const c = S.controls;
    const t = S.tick;
    c.throttle = (t % 7) / 7;
    c.brake = t % 11 === 0 ? 1 : 0;
    c.steer = Math.sin(t / 5);
    c.footX = -0.25;
    c.footY = 0.5;
    c.handbrake = t % 2 === 0;
    c.horn = t % 3 === 0;
    c.interact = t % 5 === 0;
    c.hazard = t % 7 === 0;
    c.sidestep = t % 11 === 0;
    c.start = t % 13 === 0;
    c.restart = t % 17 === 0;
    c.recover = t % 19 === 0;
    return c;
  };
  const S = TLV.sim.create({ seed: 1, params: { record: 1 }, controlSource: bot });
  for (let i = 0; i < 400; i++) {
    TLV.sim.step(S);
    seen.push({ ...S.controls });
  }
  const log = JSON.parse(JSON.stringify(S.recorder.finish()));
  const R = TLV.sim.create({ seed: 1, controlSource: TLV.replay.createPlayer(log) });
  for (let i = 0; i < 400; i++) {
    TLV.sim.step(R);
    assert.deepStrictEqual({ ...R.controls }, seen[i], `tick ${i + 1}`);
  }
});

test('a replay with no bot matches the hash on every tick, because the bot stream is not hashed', () => {
  const { log, hashes } = recordRun(1000);
  const TLV = stubTLV();
  const R = TLV.sim.create({ seed: log.header.seed, world: { id: 'w' }, controlSource: TLV.replay.createPlayer(log) });
  for (let i = 0; i < 1000; i++) {
    TLV.sim.step(R);
    assert.strictEqual(TLV.sim.hash(R), hashes[i], `tick ${i + 1}`);
  }
});

test('setInput overrides reach the log, so a replay needs no hook', () => {
  const TLV = stubTLV();
  const S = TLV.sim.create({ seed: 1, world: { id: 'w' }, params: { record: 1 } });
  TLV.debug.use(S);
  TLV.debug.setInput({ throttle: 0.7, steer: 0.2 });
  for (let i = 0; i < 100; i++) TLV.sim.step(S);
  TLV.debug.setInput(null);
  for (let i = 0; i < 100; i++) TLV.sim.step(S);
  const R = TLV.sim.create({ seed: 1, world: { id: 'w' }, controlSource: TLV.replay.createPlayer(S.recorder.finish()) });
  for (let i = 0; i < 200; i++) TLV.sim.step(R);
  assert.strictEqual(TLV.sim.hash(R), TLV.sim.hash(S));
});

test('values JSON cannot carry are cleaned before the sim sees them, so log and sim agree', () => {
  const TLV = stubTLV();
  const S = TLV.sim.create({
    seed: 1,
    params: { record: 1 },
    controlSource: (s) => {
      s.controls.steer = -0;
      s.controls.throttle = NaN;
      s.controls.brake = undefined;
      return s.controls;
    }
  });
  TLV.sim.step(S);
  assert.ok(Object.is(S.controls.steer, 0));
  assert.strictEqual(S.controls.throttle, 0);
  assert.strictEqual(S.controls.brake, 0);
  const copy = JSON.parse(JSON.stringify(S.recorder.finish()));
  assert.deepStrictEqual(copy.inputs[0].slice(1, 4), [0, 0, 0]);
});

test('past the end of the log the player gives rest', () => {
  const TLV = stubTLV();
  const S = TLV.sim.create({ seed: 1, params: { record: 1 } });
  S.controls.throttle = 1;
  S.controls.horn = true;
  for (let i = 0; i < 5; i++) TLV.sim.step(S);
  const R = TLV.sim.create({ seed: 1, controlSource: TLV.replay.createPlayer(S.recorder.finish()) });
  for (let i = 0; i < 5; i++) TLV.sim.step(R);
  assert.strictEqual(R.controls.throttle, 1);
  TLV.sim.step(R);
  assert.deepStrictEqual({ ...R.controls }, TLV.const._newControls());
});

test('the player follows S.tick, so a source reused from the start lines up again', () => {
  const TLV = stubTLV();
  const log = { header: {}, inputs: [[2, 0.1, 0, 0, 0, 0, 0], [3, 0.2, 0, 0, 0, 0, 0]] };
  const source = TLV.replay.createPlayer(log);
  const run = (tick) => source({ tick, world: null, seed: undefined }).throttle;
  captureWarnings(() => {
    assert.strictEqual(run(1), 0.1);
    assert.strictEqual(run(3), 0.2);
    assert.strictEqual(run(5), 0.2);
    assert.strictEqual(run(2), 0.1);
    assert.strictEqual(run(6), 0);
  });
});

test('a log from another map, seed or content warns once', () => {
  const TLV = stubTLV();
  const { log } = recordRun(10);
  const R = TLV.sim.create({ seed: 99, world: { id: 'other' }, controlSource: TLV.replay.createPlayer(log) });
  const warnings = captureWarnings(() => { for (let i = 0; i < 5; i++) TLV.sim.step(R); });
  assert.strictEqual(warnings.length, 1);
  assert.match(warnings[0], /map w/);
  assert.match(warnings[0], /seed 3/);
});

test('a matching log does not warn', () => {
  const TLV = stubTLV();
  const { log } = recordRun(10);
  const R = TLV.sim.create({ seed: 3, world: { id: 'w' }, controlSource: TLV.replay.createPlayer(log) });
  assert.deepStrictEqual(captureWarnings(() => TLV.sim.step(R)), []);
});

test('a log whose header has no params is not reported as a flag mismatch', () => {
  const TLV = stubTLV();
  const log = { header: { version: 1, seed: 3, mapId: 'w', contentHash: TLV.registry.contentHash() }, inputs: [] };
  const R = TLV.sim.create({ seed: 3, world: { id: 'w' }, controlSource: TLV.replay.createPlayer(log) });
  assert.deepStrictEqual(captureWarnings(() => TLV.sim.step(R)), []);
});

for (const flag of ['traffic', 'peds', 'incidents']) {
  test(`a log run under another ${flag} flag warns, in either direction`, () => {
    const TLV = stubTLV();
    const logWith = (params) => TLV.sim.create({ seed: 3, world: { id: 'w' }, params: { record: 1, ...params } }).recorder.finish();
    const warningsFor = (log, params) => {
      const R = TLV.sim.create({ seed: 3, world: { id: 'w' }, params, controlSource: TLV.replay.createPlayer(log) });
      return captureWarnings(() => { for (let i = 0; i < 3; i++) TLV.sim.step(R); });
    };
    const off = warningsFor(logWith({ [flag]: 0 }), {});
    assert.strictEqual(off.length, 1);
    assert.match(off[0], new RegExp(`: ${flag} 0$`), 'names only the flag that differs');
    const on = warningsFor(logWith({}), { [flag]: 0 });
    assert.strictEqual(on.length, 1);
    assert.match(on[0], new RegExp(`: ${flag} 1$`));
    assert.deepStrictEqual(warningsFor(logWith({ [flag]: 0 }), { [flag]: 0 }), [], 'matching flags are quiet');
  });
}
