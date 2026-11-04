// tests/core/constants.test.mjs — WP-CORE
// Pins TLV.const to the contract. Every other package trusts these values, and most tests read them from TLV.const, so a wrong
// value there would agree with itself. The expected values are read from docs/, so the two cannot drift apart.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { coreTLV } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const architecture = fs.readFileSync(path.join(ROOT, 'docs/ARCHITECTURE.md'), 'utf8');
const { const: C } = coreTLV();

/** @returns {string} The contract text from one heading up to the next one given. */
function section(from, to) {
  const start = architecture.indexOf(from);
  const end = architecture.indexOf(to, start);
  assert.ok(start >= 0 && end > start, `${from} not found`);
  return architecture.slice(start, end);
}

/** @returns {string[]} The quoted strings in a piece of contract text. */
const quoted = (text) => [...text.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);

/** The value lines of the 12.1.1 code block, which are valid object-literal text. */
function contractValues() {
  const block = section('#### 12.1.1', '#### 12.1.2');
  const body = block.slice(block.indexOf('DT:'), block.indexOf('BEHAVIOURS:'));
  return new Function(`return { ${body} };`)();
}

test('every scalar and enum in 12.1.1 is in TLV.const, with the contract value', () => {
  const contract = contractValues();
  assert.deepStrictEqual(Object.keys(contract), ['DT', 'TICK_HZ', 'MAX_SUBSTEPS', 'MAX_VEHICLES', 'MAX_PEDS', 'UNIT', 'M_PER_DEG_LAT',
    'M_PER_DEG_LON', 'ROAD', 'LF', 'EF', 'VL', 'SURF', 'SIG', 'OCC', 'PAINT', 'POIF']);
  for (const key of Object.keys(contract)) assert.deepStrictEqual(C[key], contract[key], key);
});

test('the pool and step limits are the numbers the performance work assumed', () => {
  assert.strictEqual(C.MAX_SUBSTEPS, 5);
  assert.strictEqual(C.MAX_VEHICLES, 200);
  assert.strictEqual(C.MAX_PEDS, 96);
  assert.strictEqual(C.DT, 1 / C.TICK_HZ);
});

test('BEHAVIOURS is the list in 10.3, in order', () => {
  assert.deepStrictEqual([...C.BEHAVIOURS], quoted(section('### 10.3', 'lists them')));
});

test('PED_STATES is the list in 10.4, in order', () => {
  const line = section('### 10.4', '### 10.5').split('\n').find((l) => l.trim().startsWith("state: 'WALK'"));
  assert.deepStrictEqual([...C.PED_STATES], quoted(line));
});

test('PHASES is the list in 10.9, in order', () => {
  const line = section('### 10.9', 'Phase transitions').split('\n').find((l) => l.trim().startsWith("phase: 'TITLE'"));
  assert.deepStrictEqual([...C.PHASES], quoted(line));
});

test('VEHICLE_SIZES has the lengths and widths in 10.2', () => {
  const line = architecture.split('\n').find((l) => l.startsWith('Vehicle sizes (m):'));
  const sizes = [...line.matchAll(/(\w+) (\d+\.\d+) x (\d+\.\d+)/g)];
  assert.strictEqual(sizes.length, 6);
  assert.deepStrictEqual(Object.keys(C.VEHICLE_SIZES).sort(), sizes.map((m) => m[1]).sort());
  for (const [, kind, length, width] of sizes) {
    assert.strictEqual(C.VEHICLE_SIZES[kind].length, Number(length), kind);
    assert.strictEqual(C.VEHICLE_SIZES[kind].width, Number(width), kind);
    assert.ok(C.VEHICLE_SIZES[kind].wheelbase > 0 && C.VEHICLE_SIZES[kind].wheelbase < C.VEHICLE_SIZES[kind].length, kind);
  }
});
