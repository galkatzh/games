// tests/core/invariants.test.mjs — WP-CORE
import assert from 'node:assert';
import { test } from 'node:test';
import { coreTLV, installStubSystems } from './helpers.mjs';

function setup() {
  const TLV = coreTLV();
  installStubSystems(TLV);
  return { TLV, S: TLV.sim.create({ seed: 1 }) };
}

test('run with healthy state returns nothing', () => {
  const { TLV, S } = setup();
  assert.deepStrictEqual(TLV.invariants.run(S), []);
  assert.deepStrictEqual(S.invariantFailures, []);
});

test('run returns failures and also keeps them on S', () => {
  const { TLV, S } = setup();
  TLV.invariants.register('test.always', () => 'broken');
  const failures = TLV.invariants.run(S);
  assert.strictEqual(failures.length, 1);
  assert.match(failures[0], /test\.always/);
  assert.match(failures[0], /broken/);
  assert.deepStrictEqual(S.invariantFailures, failures);
});

test('S.invariantFailures keeps 100, and the totals keep counting', () => {
  const { TLV, S } = setup();
  TLV.invariants.register('test.always', () => 'broken');
  for (let i = 0; i < 130; i++) TLV.invariants.run(S);
  assert.strictEqual(S.invariantFailures.length, 100);
  assert.strictEqual(S._invariantTotal, 130);
  assert.deepStrictEqual(S._invariantCounts, { 'test.always': 130 });
});

test('a check that throws counts as failing, and the rest still run', () => {
  const { TLV, S } = setup();
  let ran = false;
  TLV.invariants.register('test.throws', () => { throw new Error('bad check'); });
  TLV.invariants.register('test.after', () => { ran = true; return null; });
  const failures = TLV.invariants.run(S);
  assert.strictEqual(failures.length, 1);
  assert.match(failures[0], /bad check/);
  assert.strictEqual(ran, true);
});

test('registering a name again replaces the check', () => {
  const { TLV, S } = setup();
  TLV.invariants.register('test.twice', () => 'first');
  TLV.invariants.register('test.twice', () => null);
  assert.deepStrictEqual(TLV.invariants.run(S), []);
});

for (const [name, spoil] of [
  ['a NaN car position', (S) => { S.vehicles[3].x = NaN; }],
  ['an infinite car speed', (S) => { S.vehicles[3].v = Infinity; }],
  ['a NaN pedestrian heading', (S) => { S.peds[2].h = NaN; }],
  ['a NaN previous pose', (S) => { S.vehicles[0].px = NaN; }],
  ['a missing field', (S) => { S.vehicles[3].y = undefined; }]
]) {
  test(`the numeric gate catches ${name}`, () => {
    const { TLV, S } = setup();
    spoil(S);
    assert.strictEqual(TLV.invariants.run(S).length, 1);
    assert.match(S.invariantFailures[0], /core\.numeric/);
  });
}

test('the numeric gate catches the on-foot pose only while active', () => {
  const { TLV, S } = setup();
  S.player.foot.x = NaN;
  assert.deepStrictEqual(TLV.invariants.run(S), []);
  S.player.foot.active = true;
  assert.strictEqual(TLV.invariants.run(S).length, 1);
});

test('the numeric gate ignores inactive pool slots', () => {
  const { TLV, S } = setup();
  S.vehicles[150].x = NaN;
  S.peds[90].x = NaN;
  assert.deepStrictEqual(TLV.invariants.run(S), []);
});

test('the pool gate catches a lost player and a moved record', () => {
  const { TLV, S } = setup();
  S.vehicles[0].isPlayer = false;
  assert.match(TLV.invariants.run(S)[0], /core\.slots/);
  S.vehicles[0].isPlayer = true;
  S.vehicles[7].slot = 8;
  assert.match(TLV.invariants.run(S)[0], /core\.slots/);
});

test('step runs invariants only with the param set, and only every 60 ticks', () => {
  for (const [params, expected] of [[{ invariants: 1 }, 2], [{ debug: 1 }, 2], [{}, 0]]) {
    const TLV = coreTLV();
    installStubSystems(TLV);
    let runs = 0;
    TLV.invariants.register('test.count', () => { runs++; return null; });
    const S = TLV.sim.create({ seed: 1, params });
    for (let i = 0; i < 125; i++) TLV.sim.step(S);
    assert.strictEqual(runs, expected, JSON.stringify(params));
  }
});
