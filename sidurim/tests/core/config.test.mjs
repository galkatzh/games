// tests/core/config.test.mjs — WP-CORE
import assert from 'node:assert';
import { test } from 'node:test';
import { captureWarnings, coreTLV } from './helpers.mjs';

const { config } = coreTLV();

/** The table of ARCHITECTURE 16.1 as normalized values. */
const DEFAULTS = {
  seed: null, map: null, lang: 'en', debug: 0, dev: 0, invariants: 0, record: 0, autoplay: null, notitle: 0, errand: 1,
  errandDef: null, spawn: null, clock: 120, clockGiven: 0, heat: null, immortal: 0, density: null, traffic: 1, peds: 1, incidents: 1,
  contest: 'auto', knife: 'auto', quality: 'auto', mute: 0, hud: 1, timescale: 1
};

test('normalize applies the section 16.1 defaults', () => {
  assert.deepStrictEqual(config.normalize({}), DEFAULTS);
  assert.deepStrictEqual(config.normalize(undefined), DEFAULTS);
  assert.deepStrictEqual(config.normalize(null), DEFAULTS);
  assert.deepStrictEqual(config.parse(''), DEFAULTS);
});

test('density stays null when unset, so TRAFFIC can tell it from an explicit 100', () => {
  assert.strictEqual(config.parse('').density, null);
  assert.strictEqual(config.parse('?density=100').density, 100);
  assert.strictEqual(config.normalize({ density: 120 }).density, 120);
});

test('clockGiven tells a clock of 120 asked for from the default, through a second normalize', () => {
  assert.strictEqual(config.parse('').clockGiven, 0);
  assert.strictEqual(config.parse('?clock=120').clockGiven, 1);
  assert.strictEqual(config.parse('?clock=0').clockGiven, 1);
  assert.strictEqual(config.normalize({ clock: 90 }).clockGiven, 1);
  assert.strictEqual(config.normalize(config.parse('')).clockGiven, 0);
  assert.strictEqual(config.normalize(config.parse('?clock=120')).clockGiven, 1);
  assert.strictEqual(config.normalize({ ...config.parse(''), clock: 90 }).clockGiven, 1, 'a merge over normalized params');
  const warned = captureWarnings(() => assert.strictEqual(config.parse('?clock=soon').clockGiven, 0));
  assert.strictEqual(warned.length, 1);
});

test('parse coerces numbers and flags from a query string', () => {
  const p = config.parse('?seed=42&clock=90.5&errand=3&heat=0.4&density=80&timescale=2&notitle=1&traffic=0&mute');
  assert.strictEqual(p.seed, 42);
  assert.strictEqual(p.clock, 90.5);
  assert.strictEqual(p.errand, 3);
  assert.strictEqual(p.heat, 0.4);
  assert.strictEqual(p.density, 80);
  assert.strictEqual(p.timescale, 2);
  assert.strictEqual(p.notitle, 1);
  assert.strictEqual(p.traffic, 0);
  assert.strictEqual(p.mute, 1, 'a bare flag is on');
});

test('strings and enums pass through when valid', () => {
  const p = config.parse('?map=mini&lang=he&autoplay=patrol&errandDef=milk&contest=force&knife=off&quality=low');
  assert.strictEqual(p.map, 'mini');
  assert.strictEqual(p.lang, 'he');
  assert.strictEqual(p.autoplay, 'patrol');
  assert.strictEqual(p.errandDef, 'milk');
  assert.strictEqual(p.contest, 'force');
  assert.strictEqual(p.knife, 'off');
  assert.strictEqual(p.quality, 'low');
});

test('bad values warn and fall back, never throw', () => {
  let p;
  const warnings = captureWarnings(() => {
    p = config.parse('?seed=abc&lang=fr&contest=maybe&quality=ultra&clock=soon&spawn=1,2&notitle=perhaps');
  });
  assert.strictEqual(p.seed, null);
  assert.strictEqual(p.lang, 'en');
  assert.strictEqual(p.contest, 'auto');
  assert.strictEqual(p.quality, 'auto');
  assert.strictEqual(p.clock, 120);
  assert.strictEqual(p.spawn, null);
  assert.strictEqual(p.notitle, 0);
  assert.strictEqual(warnings.length, 7);
});

test('ranges clamp', () => {
  assert.strictEqual(config.parse('?errand=9').errand, 7);
  assert.strictEqual(config.parse('?errand=0').errand, 1);
  assert.strictEqual(config.parse('?heat=2').heat, 1);
  assert.strictEqual(config.parse('?clock=-5').clock, 0);
  assert.ok(config.parse('?timescale=0').timescale > 0, 'timescale 0 would freeze the loop for good');
});

test('seed 0 is a seed, not an absent one', () => {
  assert.strictEqual(config.parse('?seed=0').seed, 0);
  assert.strictEqual(config.normalize({ seed: 0 }).seed, 0);
});

test('spawn accepts x,y,h in every form and yields {x, y, h}', () => {
  const pose = { x: 10.5, y: -3, h: 1.57 };
  assert.deepStrictEqual(config.parse('?spawn=10.5,-3,1.57').spawn, pose);
  assert.deepStrictEqual(config.normalize({ spawn: [10.5, -3, 1.57] }).spawn, pose);
  assert.deepStrictEqual(config.normalize({ spawn: pose }).spawn, pose);
});

test('debug=1 enables invariants', () => {
  assert.strictEqual(config.parse('?debug=1').invariants, 1);
  assert.strictEqual(config.parse('?debug=0').invariants, 0);
  assert.strictEqual(config.parse('?invariants=1').debug, 0);
});

test('normalize is idempotent: createTLV and sim.create both run it', () => {
  const once = config.parse('?seed=3&spawn=1,2,3&notitle=1&density=90&debug=1&lang=he');
  assert.deepStrictEqual(config.normalize(once), once);
});

test('browser and Node paths agree', () => {
  assert.deepStrictEqual(
    config.parse('?seed=7&notitle=1&density=120&spawn=1,2,0'),
    config.normalize({ seed: 7, notitle: true, density: '120', spawn: '1,2,0' })
  );
});

test('map falls back to the map index default', () => {
  const TLV = coreTLV();
  TLV.mapIndex = { default: 'tlv_center', maps: {} };
  assert.strictEqual(TLV.config.normalize({}).map, 'tlv_center');
  assert.strictEqual(TLV.config.parse('?map=other').map, 'other');
});

test('unknown keys pass through and a repeated key keeps the last value', () => {
  assert.strictEqual(config.normalize({ testOnly: 5 }).testOnly, 5);
  assert.strictEqual(config.parse('?seed=1&seed=2').seed, 2);
});
