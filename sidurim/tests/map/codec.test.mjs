// tests/map/codec.test.mjs — column encodings, section 7.2.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { enc, mapScript, StringTable } from '../../tools/lib/encode.mjs';
import { readMapPayload } from '../../tools/lib/report.mjs';
import { ROOT, runtime } from './helpers.mjs';

const TLV = await runtime();
const decode = (cell) => TLV.mapCodec.decodeColumn(cell[0], cell[1]);

test('u8 round-trips and decodes to Uint8Array', () => {
  const out = decode(enc.u8([0, 1, 127, 128, 255]));
  assert.ok(out instanceof Uint8Array);
  assert.deepEqual(Array.from(out), [0, 1, 127, 128, 255]);
});

test('Base64 padding is handled at every length modulo 3', () => {
  for (const n of [0, 1, 2, 3, 4, 5, 6, 7]) {
    const a = Array.from({ length: n }, (_, i) => (i * 37) % 256);
    assert.deepEqual(Array.from(decode(enc.u8(a))), a);
  }
});

test('vu round-trips and decodes to Int32Array', () => {
  const a = [0, 1, 127, 128, 16383, 16384, 2147483647];
  const out = decode(enc.vu(a));
  assert.ok(out instanceof Int32Array);
  assert.deepEqual(Array.from(out), a);
});

test('vz round-trips negatives at the Int32 limits', () => {
  const a = [0, -1, 1, -2, 2, 2147483647, -2147483648];
  const out = decode(enc.vz(a));
  assert.ok(out instanceof Int32Array);
  assert.deepEqual(Array.from(out), a);
});

test('vd decodes cumulatively', () => {
  const a = [1000, 1003, 990, 990, -21243, 27722];
  const out = decode(enc.vd(a));
  assert.ok(out instanceof Int32Array);
  assert.deepEqual(Array.from(out), a);
});

test('vl keeps ids above 2^31 exactly', () => {
  const a = [10693747873, 14333244588, 2147483648, 4294967296, 1, Number.MAX_SAFE_INTEGER];
  const out = decode(enc.vl(a));
  assert.ok(out instanceof Float64Array);
  assert.deepEqual(Array.from(out), a);
});

test('raw decodes to Float64Array', () => {
  const out = decode(enc.raw([1.5, -2, 0]));
  assert.ok(out instanceof Float64Array);
  assert.deepEqual(Array.from(out), [1.5, -2, 0]);
});

test('rl expands runs, including a run over a thousand rows', () => {
  const a = [...new Array(1000).fill(0), 3, 3, 7, ...new Array(300).fill(255), 0];
  const out = decode(enc.rl(a));
  assert.deepEqual(Array.from(out), a);
});

test('an empty column decodes to an empty array in every encoding', () => {
  for (const name of ['u8', 'vu', 'vz', 'vd', 'vl', 'raw', 'rl']) assert.equal(decode(enc[name]([])).length, 0);
});

test('an unknown encoding warns and reads as absent, it does not throw', (t) => {
  const warn = t.mock.method(console, 'warn', () => {});
  assert.equal(TLV.mapCodec.decodeColumn('zz', 'AAAA').length, 0);
  assert.equal(warn.mock.calls.length, 1);
});

test('encoders refuse a value that would silently corrupt', () => {
  assert.throws(() => enc.u8([256]), /out of range/);
  assert.throws(() => enc.u8([-1]), /out of range/);
  assert.throws(() => enc.vu([2 ** 31]), /out of range/);
  assert.throws(() => enc.vl([2 ** 53]), /out of range/);
});

test('decodeAll is table-agnostic and keeps *Off columns at n + 1', () => {
  const d = TLV.mapCodec.decodeAll({
    schema: [1, 0],
    id: 'x',
    meta: { unit: 0.1 },
    strings: ['', 'a'],
    tables: { anything: { n: 2, cols: { pOff: enc.vu([0, 2, 5]), v: enc.u8([1, 2]) } } }
  });
  assert.equal(d.id, 'x');
  assert.equal(d.t.anything.n, 2);
  assert.equal(d.t.anything.col.pOff.length, 3);
  assert.deepEqual(Array.from(d.t.anything.col.v), [1, 2]);
  assert.deepEqual(d.strings, ['', 'a']);
});

test('string table is deterministic, frequency-ordered and index 0 is empty', () => {
  const s = new StringTable();
  for (const v of ['b', 'a', 'b', '', null, 'c', 'b', 'a']) s.use(v);
  s.finish();
  assert.deepEqual(s.list, ['', 'b', 'a', 'c']);
  assert.equal(s.get('c'), 3);
  assert.equal(s.get(''), 0);
  assert.equal(s.get('unknown'), 0);
});

test('a data script needs only TLV.q', () => {
  assert.equal(mapScript({ id: 'x' }), "TLV.q.push(['map', {\"id\":\"x\"}]);\n");
});

test('tlv_center decodes inside the 50 ms budget', () => {
  const payload = readMapPayload(path.join(ROOT, 'data/maps/tlv_center/map.js'));
  let best = Infinity;
  for (let i = 0; i < 5; i++) {
    const t0 = performance.now();
    TLV.mapCodec.decodeAll(payload);
    best = Math.min(best, performance.now() - t0);
  }
  assert.ok(best <= 50, `decode took ${best.toFixed(1)} ms`);
});

test('u8 decodes every length of base64, padded or not by what is left over', () => {
  for (let n = 0; n <= 9; n++) {
    const bytes = Uint8Array.from({ length: n }, (_, i) => 250 - i * 3);
    assert.deepEqual(Array.from(TLV.mapCodec.decodeColumn('u8', Buffer.from(bytes).toString('base64'))), Array.from(bytes));
  }
});
