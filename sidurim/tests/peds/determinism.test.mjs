// tests/peds/determinism.test.mjs — same seed, same crowd. No wall clock, no hash order, no module state.
import test from 'node:test';
import assert from 'node:assert';
import { loadTLV, sim, setPlayer, quiet, driver } from './helpers.mjs';

quiet();

test('Two runs of one seed hash the same every 1000 ticks, in one process', () => {
  const TLV = loadTLV('tlv_center');
  const hashes = [];
  for (let run = 0; run < 2; run++) {
    const S = sim(TLV, { seed: 21, traffic: true, density: 60 });
    const drive = driver(TLV, S, 8, 2000);
    drive();
    const list = [];
    for (let i = 1; i <= 6000; i++) {
      drive();
      TLV.sim.step(S);
      if (i % 1000 === 0) list.push(TLV.sim.hash(S));
    }
    hashes.push(list);
  }
  assert.deepStrictEqual(hashes[0], hashes[1]);
});

test('Different seeds make different crowds', () => {
  const TLV = loadTLV('tlv_center');
  const ends = [1, 2].map((seed) => {
    const S = sim(TLV, { seed });
    setPlayer(S, 0, 0);
    for (let i = 0; i < 120; i++) TLV.sim.step(S);
    return TLV.sim.hash(S);
  });
  assert.notStrictEqual(ends[0], ends[1]);
});

test('Only the ped stream draws: people leave traffic, spawn and game streams untouched', () => {
  const TLV = loadTLV('tlv_center');
  const S = sim(TLV, { seed: 22 });
  setPlayer(S, 0, 0);
  const before = ['traffic', 'spawn', 'event', 'game', 'foot'].map((k) => S.rng[k].state());
  const ped = S.rng.ped.state();
  for (let i = 0; i < 1200; i++) TLV.sim.step(S);
  assert.deepStrictEqual(['traffic', 'spawn', 'event', 'game', 'foot'].map((k) => S.rng[k].state()), before);
  assert.notStrictEqual(S.rng.ped.state(), ped);
});

test('A hot tick allocates next to nothing once the streets around are read', () => {
  const TLV = loadTLV('tlv_center');
  const S = sim(TLV, { seed: 23 });
  setPlayer(S, 0, 0);
  for (let i = 0; i < 1800; i++) TLV.sim.step(S);
  global.gc?.();
  const start = process.memoryUsage().heapUsed;
  for (let i = 0; i < 6000; i++) TLV.sim.step(S);
  const grew = process.memoryUsage().heapUsed - start;
  assert.ok(grew < 12 * 1024 * 1024, `${(grew / 1048576).toFixed(1)} MB over 6000 ticks`);
});

test('With peds off nothing runs, and no record is touched', () => {
  const TLV = loadTLV('tlv_center');
  const S = TLV.sim.create({ seed: 1, world: TLV.world.get('tlv_center'), allowMissing: true, flags: { traffic: false, peds: false, incidents: false } });
  for (let i = 0; i < 120; i++) TLV.sim.step(S);
  assert.strictEqual(S.peds.filter((p) => p.active).length, 0);
});
