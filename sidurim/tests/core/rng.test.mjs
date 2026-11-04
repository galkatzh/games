// tests/core/rng.test.mjs — WP-CORE
import assert from 'node:assert';
import { test } from 'node:test';
import { coreTLV } from './helpers.mjs';

const { rng } = coreTLV();

/** The published Mulberry32, as an independent reference. */
function mulberry32(a) {
  return () => {
    a += 0x6D2B79F5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a over bytes, written independently of the code under test. */
function fnv(bytes) {
  let h = 0x811c9dc5;
  for (const b of bytes) h = Math.imul(h ^ b, 16777619) >>> 0;
  return h;
}

test('next matches Mulberry32', () => {
  for (const seed of [0, 1, 42, 0xDEADBEEF, 0xFFFFFFFF]) {
    const a = rng.create(seed);
    const b = mulberry32(seed);
    for (let i = 0; i < 1000; i++) assert.strictEqual(a.next(), b());
  }
});

test('next stays in [0, 1)', () => {
  const r = rng.create(7);
  for (let i = 0; i < 100000; i++) {
    const v = r.next();
    assert.ok(v >= 0 && v < 1);
  }
});

test('int, range, bool and pick', () => {
  const r = rng.create(3);
  const seen = new Set();
  for (let i = 0; i < 2000; i++) {
    const v = r.int(5);
    assert.ok(Number.isInteger(v) && v >= 0 && v < 5);
    seen.add(v);
    const f = r.range(-2, 3);
    assert.ok(f >= -2 && f < 3);
    assert.ok(['a', 'b'].includes(r.pick(['a', 'b'])));
  }
  assert.strictEqual(seen.size, 5);
  assert.strictEqual(r.bool(1), true);
  assert.strictEqual(r.bool(0), false);
  assert.strictEqual(r.int(0), 0);
  assert.strictEqual(r.pick([]), null);
});

test('pick and int consume one draw each, even on empty input, so streams stay aligned', () => {
  const a = rng.create(9);
  const b = rng.create(9);
  a.pick([]);
  a.int(0);
  b.next();
  b.next();
  assert.strictEqual(a.state(), b.state());
});

test('beta22 has the Beta(2,2) distribution', () => {
  const r = rng.create(11);
  const n = 200000;
  let sum = 0;
  let sq = 0;
  let below = 0;
  for (let i = 0; i < n; i++) {
    const v = r.beta22();
    assert.ok(v >= 0 && v < 1);
    sum += v;
    sq += v * v;
    if (v < 0.25) below++;
  }
  const mean = sum / n;
  const variance = sq / n - mean * mean;
  assert.ok(Math.abs(mean - 0.5) < 0.003, `mean ${mean}`);
  assert.ok(Math.abs(variance - 0.05) < 0.001, `variance ${variance}`);
  // CDF at 0.25: 3x^2 - 2x^3 = 0.15625.
  assert.ok(Math.abs(below / n - 0.15625) < 0.003, `cdf ${below / n}`);
});

test('state and setState round trip, and the state is a uint32', () => {
  const r = rng.create(5);
  for (let i = 0; i < 10; i++) r.next();
  const u = r.state();
  assert.ok(Number.isInteger(u) && u >= 0 && u <= 0xFFFFFFFF);
  const expected = [r.next(), r.next(), r.next()];
  const other = rng.create(1);
  other.setState(u);
  assert.deepStrictEqual([other.next(), other.next(), other.next()], expected);
});

test('hashStr is FNV-1a over UTF-8', () => {
  assert.strictEqual(rng.hashStr(''), 0x811c9dc5);
  assert.strictEqual(rng.hashStr('a'), 0xe40c292c);
  assert.strictEqual(rng.hashStr('foobar'), 0xbf9cf968);
  for (const s of ['תל אביב', '₪', '©', 'x😀y', 'é']) {
    assert.strictEqual(rng.hashStr(s), fnv(Buffer.from(s, 'utf8')), s);
  }
});

test('hash32 is FNV-1a over little-endian 32-bit words', () => {
  assert.strictEqual(rng.hash32(), 0x811c9dc5);
  const words = (...v) => {
    const b = Buffer.alloc(v.length * 4);
    v.forEach((x, i) => b.writeInt32LE(x | 0, i * 4));
    return fnv(b);
  };
  assert.strictEqual(rng.hash32(1), words(1));
  assert.strictEqual(rng.hash32(77, 1234), words(77, 1234));
  assert.strictEqual(rng.hash32(-1, 5), words(-1, 5));
  assert.strictEqual(rng.hash32(0xFFFFFFFF), words(-1));
});

test('hash32 values are pinned forever: curb and facade variation depend on them', () => {
  assert.strictEqual(rng.hash32(0), 1268118805);
  assert.strictEqual(rng.hash32(1, 2, 3), 2034659765);
  assert.strictEqual(rng.hashStr('facade.tile'), 1039279739);
});

test('hash32 takes a stream name, and keeps IDs wider than 32 bits apart', () => {
  assert.strictEqual(rng.hash32(9, 'traffic'), rng.hash32(9, rng.hashStr('traffic')));
  assert.notStrictEqual(rng.hash32(9, 'traffic'), rng.hash32(9, 'spawn'));
  const id = 10693747873;
  assert.notStrictEqual(rng.hash32(id), rng.hash32(id % 4294967296));
  assert.strictEqual(rng.hash32(id), rng.hash32(id));
});
