// tests/ui/sounds_pack.test.mjs — what tools/pack_sounds.mjs refuses, and that a loop it makes has no seam. Neither needs ffmpeg.
import assert from 'node:assert';
import { test } from 'node:test';
import { checkSidecar, makeLoop } from '../../tools/pack_sounds.mjs';

const good = () => ({
  file: 'horn.flac', title: 'Horn', source: 'https://example.org/horn',
  credit: { author: 'Someone', license: 'cc0', date: '2026' },
  cuts: { horn_a: [0.1, 0.5] }
});

test('a sidecar needs a file, a source, an author, a known licence and well-formed spans', () => {
  assert.doesNotThrow(() => checkSidecar(good()));
  const bad = [
    (s) => { delete s.file; },
    (s) => { s.source = ' '; },
    (s) => { delete s.credit.author; },
    (s) => { s.credit.license = 'all rights reserved'; },
    (s) => { s.cuts = {}; },
    (s) => { s.cuts = { 'Horn A': [0, 1] }; },
    (s) => { s.cuts = { horn_a: [0.5, 0.1] }; },
    (s) => { s.cuts = { horn_a: [-1, 0.1] }; }
  ];
  for (const spoil of bad) {
    const side = good();
    spoil(side);
    assert.throws(() => checkSidecar(side), JSON.stringify(side));
  }
  for (const license of ['own', 'cc0', 'cc-by-4.0', 'cc-by-sa']) {
    const side = good();
    side.credit.license = license;
    assert.doesNotThrow(() => checkSidecar(side), license);
  }
});

test('a loop of a steady tone wraps with no step bigger than the tone takes by itself', () => {
  const rate = 44100;
  const x = new Float32Array(Math.round(rate * 0.13));
  for (let i = 0; i < x.length; i++) x[i] = 0.6 * Math.sin(2 * Math.PI * 351.7 * i / rate) + 0.25 * Math.sin(2 * Math.PI * 703.4 * i / rate);
  const loop = makeLoop(x);
  assert.ok(loop.length >= x.length * 0.6 && loop.length < x.length, `${loop.length}`);
  let step = 0;
  for (let i = 1; i < loop.length; i++) step = Math.max(step, Math.abs(loop[i] - loop[i - 1]));
  const seam = Math.abs(loop[0] - loop[loop.length - 1]);
  assert.ok(seam <= step * 1.05, `seam ${seam} against ${step}`);
  let peak = 0;
  for (const v of loop) peak = Math.max(peak, Math.abs(v));
  assert.ok(peak > 0.85 && peak <= 0.9, `normalized to ${peak}`);
});
