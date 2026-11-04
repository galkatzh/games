// tests/render/actors_lint.test.mjs — RENDER-ACTORS
// Run: node --test tests/render/actors_lint.test.mjs
// Render never mutates sim state (ARCHITECTURE 15.2), and actors read only what 15.1 lists. A text check over the six actor files.
import { test } from 'node:test';
import assert from 'node:assert';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const FILES = ['vehicles', 'people', 'signal_heads', 'effects', 'camera', 'rearview'];

/** @returns {string} Source with comments removed. */
function source(name) {
  return readFileSync(join(ROOT, 'js/render', name + '.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

/** Vehicle fields ARCHITECTURE 15.1 lets render read, plus id and slot, which identify a record. */
const VEHICLE_READ = new Set(['active', 'kind', 'variant', 'x', 'y', 'h', 'px', 'py', 'ph', 'v', 'vx', 'vy', 'yawRate', 'accel', 'steer', 'lights', 'horn', 'door',
  'isPlayer', 'mode', 'length', 'width', 'id', 'slot']);
const PED_READ = new Set(['active', 'kind', 'variant', 'x', 'y', 'h', 'px', 'py', 'ph', 'v', 'anim', 'intent', 'hasKnife', 'id']);

test('no actor file writes to a sim record', () => {
  const writes = /\b(S|S\.[\w.]+|veh|car|cars\[\w+\]|p|ped|f|k|g|P|me|nav|errand|other|v)\.\w+\s*(=(?!=)|\+=|-=|\*=|\+\+|--)/g;
  // effects.js: P and f are its own pools. people.js: the one hit is GLSL, a shader local inside a string.
  const private_ = { effects: /^(P|f)\./, people: /^p\.y -=/ };
  for (const name of FILES) {
    const hits = [...source(name).matchAll(writes)].map((m) => m[0]).filter((m) => !(private_[name] && private_[name].test(m)));
    assert.deepStrictEqual(hits, [], name);
  }
});

test('vehicles read only the fields the contract lists', () => {
  const src = source('vehicles');
  const used = new Set([...src.matchAll(/\b(?:v|other|me)\.(\w+)/g)].map((m) => m[1]));
  for (const f of used) assert.ok(VEHICLE_READ.has(f), 'vehicles.js reads ' + f);
});

test('people read only the fields the contract lists', () => {
  const src = source('people');
  const used = new Set([...src.matchAll(/\bp\.(\w+)/g)].map((m) => m[1]));
  for (const f of used) assert.ok(PED_READ.has(f), 'people.js reads ' + f);
});

test('signal state goes through TLV.world.signals, parking through its API', () => {
  for (const name of FILES) {
    assert.ok(!/S\.sig\b/.test(source(name)), name + ' reads S.sig');
    assert.ok(!/S\.parking\b/.test(source(name)), name + ' reads S.parking');
  }
});

test('no gore, and nothing that codes a character', () => {
  const banned = /\b(blood|gore|gory|bleed|wound|corpse|kippah|keffiyeh|hijab|turban|burka|yarmulke)\b/i;
  for (const name of ['people', 'effects', 'vehicles']) {
    const lines = readFileSync(join(ROOT, 'js/render', name + '.js'), 'utf8').split('\n');
    for (const line of lines) {
      const clean = line.replace(/No blood, no gore[^.]*\./i, '');
      assert.ok(!banned.test(clean), name + ': ' + line.trim());
    }
  }
});

test('the player\'s teal is his alone', () => {
  const src = source('vehicles');
  const toLab = (hex) => {
    const lin = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    const xyz = [[0.4124, 0.3576, 0.1805], [0.2126, 0.7152, 0.0722], [0.0193, 0.1192, 0.9505]].map((row) => row.reduce((sum, k, i) => sum + k * lin[i], 0));
    const [fx, fy, fz] = xyz.map((v, i) => v / [0.9505, 1, 1.089][i]).map((v) => (v > 0.008856 ? Math.cbrt(v) : 7.787 * v + 16 / 116));
    return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
  };
  const distance = (a, b) => Math.hypot(...toLab(a).map((v, i) => v - toLab(b)[i]));
  const teal = /PLAYER_PAINT = '(#[0-9a-f]{6})'/.exec(src)[1];
  const block = /var PALETTE = \{([\s\S]*?)\n {2}\};/.exec(src)[1];
  const paints = [...block.matchAll(/'(#[0-9a-f]{6})'/g)].map((m) => m[1]);
  assert.ok(paints.length >= 48, 'palette found');
  const tune = readFileSync(join(ROOT, 'js/render/tune.js'), 'utf8');
  const parked = /parkedPalette: \[([^\]]+)\]/.exec(tune)[1].match(/0x[0-9a-f]{6}/g).map((h) => '#' + h.slice(2));
  assert.ok(parked.length >= 8, 'parked palette found');
  for (const hex of paints.concat(parked)) assert.ok(distance(teal, hex) > 24, hex + ' is too close to the player, delta E ' + distance(teal, hex).toFixed(1));
});

test('particle colours hold no red', () => {
  const src = source('effects');
  const palette = [...src.matchAll(/(SPARK|SPARK_HOT|DUST|STEAM|SMOKE|TYRE|STAR) = \[([\d., ]+)\]/g)];
  assert.ok(palette.length >= 6);
  for (const m of palette) {
    const [r, g] = m[2].split(',').map(Number);
    assert.ok(g >= r * 0.5, m[1] + ' leans red');
  }
});
