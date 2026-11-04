// tests/core/determinism.test.mjs — WP-CORE
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSim, createTLV } from '../../tools/lib/classic.mjs';
import { coreTLV, installStubSystems, randomBot } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function stubSim(seed, opts = {}) {
  const TLV = coreTLV();
  installStubSystems(TLV);
  return { TLV, S: TLV.sim.create({ seed, controlSource: randomBot(), ...opts }) };
}

/** @returns {number[]} The hash after each tick. */
function hashes(seed, ticks) {
  const { TLV, S } = stubSim(seed);
  const out = [];
  for (let i = 0; i < ticks; i++) {
    TLV.sim.step(S);
    out.push(TLV.sim.hash(S));
  }
  return out;
}

/**
 * Drives TLV.loop with a fake clock until the sim reaches a tick, and records the hash at each tick.
 * @param {function(number):number} pattern Gives the next frame time in seconds.
 * @returns {number[]} Hash after each tick, as many as the loop produced up to ticks.
 */
function runLoop(pattern, ticks, { timeScale = 1, timescale = 1 } = {}) {
  const { TLV, S } = stubSim(11);
  S.timeScale = timeScale;
  const out = [];
  let clock = 0;
  let pending = null;
  const L = TLV.loop.create({
    S,
    timescale,
    step: (s) => {
      TLV.sim.step(s);
      if (out.length < ticks) out.push(TLV.sim.hash(s));
    },
    raf: (fn) => { pending = fn; },
    now: () => clock
  });
  L.start();
  for (let frame = 0; out.length < ticks; frame++) {
    assert.ok(frame < 2e6, 'the loop stopped producing ticks');
    clock += pattern(frame) * 1000;
    const fn = pending;
    pending = null;
    fn();
  }
  return out;
}

test('same seed gives the same hash on every tick', () => {
  assert.deepStrictEqual(hashes(1, 1000), hashes(1, 1000));
});

test('a different seed gives a different hash', () => {
  const a = hashes(1, 100);
  const b = hashes(2, 100);
  assert.notDeepStrictEqual(a, b);
  assert.notStrictEqual(a[99], b[99]);
});

test('two sims in one process do not disturb each other', () => {
  const expected = hashes(5, 300);
  const a = stubSim(5);
  const b = stubSim(5);
  const noise = stubSim(6);
  for (let i = 0; i < 300; i++) {
    a.TLV.sim.step(a.S);
    noise.TLV.sim.step(noise.S);
    noise.TLV.sim.step(noise.S);
    b.TLV.sim.step(b.S);
    assert.strictEqual(a.TLV.sim.hash(a.S), expected[i]);
    assert.strictEqual(b.TLV.sim.hash(b.S), expected[i]);
  }
});

test('hash covers each field the contract lists', () => {
  const { TLV, S } = stubSim(3);
  for (let i = 0; i < 30; i++) TLV.sim.step(S);
  const base = TLV.sim.hash(S);
  const car = S.vehicles[2];
  const ped = S.peds[1];
  const fields = [
    ['tick', S, 'tick'], ['vehicle id', car, 'id'], ['vehicle x', car, 'x'], ['vehicle y', car, 'y'], ['vehicle h', car, 'h'],
    ['vehicle v', car, 'v'], ['vehicle laneId', car, 'laneId'], ['ped id', ped, 'id'], ['ped x', ped, 'x'], ['ped y', ped, 'y'],
    ['ped h', ped, 'h'], ['foot x', S.player.foot, 'x'], ['foot y', S.player.foot, 'y'], ['foot h', S.player.foot, 'h'],
    ['clock', S.game, 'clock'], ['money', S.game, 'money'], ['hp', S.game, 'hp']
  ];
  for (const [name, object, key] of fields) {
    const saved = object[key];
    object[key] = saved + 1;
    assert.notStrictEqual(TLV.sim.hash(S), base, name);
    object[key] = saved;
    assert.strictEqual(TLV.sim.hash(S), base, `${name} restored`);
  }
  for (const stream of ['traffic', 'spawn', 'ped', 'event', 'game', 'foot']) {
    const r = S.rng[stream];
    const u = r.state();
    r.next();
    assert.notStrictEqual(TLV.sim.hash(S), base, stream);
    r.setState(u);
  }
  assert.strictEqual(TLV.sim.hash(S), base);
});

test('the bot stream, inactive slots and velocity-only render state are out of the hash', () => {
  const { TLV, S } = stubSim(3);
  for (let i = 0; i < 30; i++) TLV.sim.step(S);
  const base = TLV.sim.hash(S);
  S.rng.bot.next();
  S.vehicles[150].x = 5;
  S.peds[90].x = 5;
  S.vehicles[2].lights = 3;
  S.timeScale = 0.6;
  assert.strictEqual(TLV.sim.hash(S), base);
});

test('-0 and +0, and every NaN, hash alike, so state that only differs that way never fails a replay', () => {
  const { TLV, S } = stubSim(3);
  S.vehicles[2].h = 0;
  const zero = TLV.sim.hash(S);
  S.vehicles[2].h = -0;
  assert.strictEqual(TLV.sim.hash(S), zero);
  S.vehicles[2].h = NaN;
  const nan = TLV.sim.hash(S);
  S.vehicles[2].h = Infinity - Infinity;
  assert.strictEqual(TLV.sim.hash(S), nan);
});

test('hash reads without changing state, and is a uint32', () => {
  const { TLV, S } = stubSim(3);
  const a = TLV.sim.hash(S);
  assert.strictEqual(TLV.sim.hash(S), a);
  assert.ok(Number.isInteger(a) && a >= 0 && a <= 0xFFFFFFFF);
});

test('the float32 hash ignores differences in the last bits, and still sees real ones', () => {
  const { TLV, S } = stubSim(3);
  for (let i = 0; i < 30; i++) TLV.sim.step(S);
  const car = S.vehicles[2];
  const exact = TLV.sim.hash(S);
  const coarse = TLV.sim._hashFloat32(S);
  const saved = car.x;
  car.x = saved * (1 + 4e-16);
  assert.notStrictEqual(car.x, saved);
  assert.notStrictEqual(TLV.sim.hash(S), exact, 'the exact hash sees one ulp');
  assert.strictEqual(TLV.sim._hashFloat32(S), coarse, 'the float32 hash does not');
  car.x = saved + 0.01;
  assert.notStrictEqual(TLV.sim._hashFloat32(S), coarse);
  car.x = saved;
  const r = S.rng.traffic;
  const u = r.state();
  r.setState(u ^ 1);
  assert.notStrictEqual(TLV.sim._hashFloat32(S), coarse, 'RNG state stays exact: float32 would round its low bits away');
  r.setState(u);
  assert.strictEqual(TLV.sim._hashFloat32(S), coarse);
});

test('hash handles a bare allowMissing sim', () => {
  const TLV = coreTLV();
  const warn = console.warn;
  console.warn = () => {};
  try {
    const S = TLV.sim.create({ allowMissing: true, seed: 1 });
    assert.ok(Number.isInteger(TLV.sim.hash(S)));
  } finally {
    console.warn = warn;
  }
});

const PATTERNS = {
  'steady 60 Hz': () => 1 / 60,
  'steady 144 Hz': () => 1 / 144,
  'steady 30 Hz': () => 1 / 30,
  '7 Hz software GL': () => 1 / 7,
  'alternating': (f) => (f % 2 ? 0.004 : 0.03),
  'random jitter': (f) => 0.002 + 0.05 * Math.abs(Math.sin(f * 12.9898) * 43758.5453 % 1),
  'hitches': (f) => (f % 97 === 0 ? 2 : 1 / 60),
  'zero-length frames': (f) => (f % 3 ? 0 : 0.05)
};

test('fixed step: 1000 ticks at varied dtReal patterns give one hash', () => {
  const reference = hashes(11, 1000);
  for (const [name, pattern] of Object.entries(PATTERNS)) {
    assert.deepStrictEqual(runLoop(pattern, 1000), reference, name);
  }
});

test('timeScale 0.6 does not change the hash per tick', () => {
  const reference = hashes(11, 1000);
  assert.deepStrictEqual(runLoop(() => 1 / 60, 1000, { timeScale: 0.6 }), reference);
  assert.deepStrictEqual(runLoop((f) => (f % 2 ? 0.004 : 0.03), 1000, { timeScale: 0.6 }), reference);
});

test('?timescale does not change the hash per tick', () => {
  const reference = hashes(11, 1000);
  assert.deepStrictEqual(runLoop(() => 1 / 60, 1000, { timescale: 3 }), reference);
  assert.deepStrictEqual(runLoop(() => 1 / 60, 1000, { timescale: 0.25 }), reference);
});

test('timeScale changing mid-run, as the knife does, leaves the hash per tick alone', () => {
  const reference = hashes(11, 1000);
  const { TLV, S } = stubSim(11);
  const out = [];
  let clock = 0;
  let pending = null;
  const L = TLV.loop.create({
    S,
    step: (s) => {
      TLV.sim.step(s);
      if (out.length < 1000) out.push(TLV.sim.hash(s));
      if (s.tick === 200) s.timeScale = 0.6;
      if (s.tick === 500) s.timeScale = 1;
    },
    raf: (fn) => { pending = fn; },
    now: () => clock
  });
  L.start();
  while (out.length < 1000) {
    clock += 1000 / 60;
    const fn = pending;
    pending = null;
    fn();
  }
  assert.deepStrictEqual(out, reference);
});

// Real packages. These run as soon as the tree has them, and they say plainly when it does not.
const manifest = createTLV({ files: [] }).manifest;
const absent = manifest.sim.filter((f) => !fs.existsSync(path.join(ROOT, f)));
const noMap = !fs.existsSync(path.join(ROOT, 'tests/fixtures/mini_map.js'));
const skip = absent.length ? `${absent.length} sim files not built yet` : (noMap ? 'tests/fixtures/mini_map.js not built yet' : false);

test('the real sim on mini is deterministic for 3600 ticks', { skip }, () => {
  const run = () => {
    const TLV = createTLV({ map: 'tests/fixtures/mini_map.js', params: { notitle: 1 } });
    const S = createSim(TLV, { seed: 21 });
    const out = [];
    for (let i = 0; i < 3600; i++) {
      TLV.sim.step(S);
      if (S.tick % 300 === 0) out.push(TLV.sim.hash(S));
    }
    return out;
  };
  assert.deepStrictEqual(run(), run());
});
