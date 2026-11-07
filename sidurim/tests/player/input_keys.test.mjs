// tests/player/input_keys.test.mjs — WP-PLAYER
// js/input/input.js in Node, on a window with only what it touches: what a key press leaves in ControlState. tests/player/input.e2e.cjs
// holds the same rules against real browser key events.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createTLV } from '../../tools/lib/classic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Loads input.js into a bare TLV. @returns {{input: object, key: function, sample: function}} */
function keyboard() {
  const TLV = createTLV({ files: [], map: null });
  const on = { keydown: [], keyup: [], blur: [] };
  const win = {
    TLV,
    navigator: {},
    addEventListener: (name, fn) => on[name].push(fn),
    removeEventListener: (name, fn) => { on[name] = on[name].filter((f) => f !== fn); }
  };
  const file = path.join(ROOT, 'js/input/input.js');
  vm.compileFunction(fs.readFileSync(file, 'utf8'), ['window', 'TLV'], { filename: file })(win, TLV);
  TLV.input.init(win, { params: { autoplay: 'none' } });
  const out = {};
  return {
    key: (name, code, repeat = false) => on[name].forEach((fn) => fn({ code, repeat, preventDefault() {} })),
    blur: () => on.blur.forEach((fn) => fn()),
    drop: () => TLV.input.dropTaps(),
    sample: () => TLV.input.sample(null, out)
  };
}

test('start: any key is start while held, and clears', () => {
  const k = keyboard();
  assert.equal(k.sample().start, false);
  k.key('keydown', 'KeyJ');
  assert.equal(k.sample().start, true);
  assert.equal(k.sample().start, true, 'it stays up while held');
  k.key('keyup', 'KeyJ');
  assert.equal(k.sample().start, false);
});

test('start: a second key with the first held drops start for one sample, so the sim sees a fresh press', () => {
  const k = keyboard();
  k.key('keydown', 'KeyW');
  assert.equal(k.sample().start, true);
  assert.equal(k.sample().start, true);
  k.key('keydown', 'Space');
  assert.equal(k.sample().start, false, 'the notch');
  assert.equal(k.sample().start, true, 'and the rise');
  assert.equal(k.sample().start, true);
});

test('start: a key that repeats is no new press, nor is a keydown for one already down', () => {
  const k = keyboard();
  k.key('keydown', 'KeyW');
  k.sample();
  k.key('keydown', 'KeyW', true);
  assert.equal(k.sample().start, true);
  k.key('keydown', 'KeyW');
  assert.equal(k.sample().start, true);
});

for (const [code, field] of [['KeyE', 'interact'], ['Enter', 'restart'], ['KeyR', 'restart']]) {
  test(`${field}: a tap of ${code} that is over before the next sample still counts, once`, () => {
    const k = keyboard();
    k.key('keydown', code);
    k.key('keyup', code);
    assert.equal(k.sample()[field], true, 'the slow frame sees it');
    assert.equal(k.sample()[field], false, 'once');
  });
}

test('a held R tows and restarts as it always did, and a tap does not hold the tow', () => {
  const k = keyboard();
  k.key('keydown', 'KeyR');
  const held = k.sample();
  assert.equal(held.recover, true);
  assert.equal(held.restart, true);
  k.key('keyup', 'KeyR');
  const after = k.sample();
  assert.equal(after.recover, false);
  assert.equal(after.restart, false);
});

for (const code of ['Escape', 'KeyP', 'KeyC', 'KeyV', 'KeyM', 'KeyN', 'KeyB']) {
  test(`${code} is a page key: not start, tapped or held, so pausing on a card cannot skip it`, () => {
    const k = keyboard();
    k.key('keydown', code);
    assert.equal(k.sample().start, false, 'held');
    k.key('keyup', code);
    k.key('keydown', code);
    k.key('keyup', code);
    assert.equal(k.sample().start, false, 'tapped');
  });
}

test('a page key with a driving key held is no notch: start does not drop', () => {
  const k = keyboard();
  k.key('keydown', 'KeyW');
  assert.equal(k.sample().start, true);
  k.key('keydown', 'KeyP');
  assert.equal(k.sample().start, true);
});

test('a press made while the sim was not sampling is dropped on request: a pause does not carry it into play', () => {
  const k = keyboard();
  for (const code of ['KeyJ', 'KeyE', 'Enter']) {
    k.key('keydown', code);
    k.key('keyup', code);
  }
  k.drop();
  const c = k.sample();
  assert.deepEqual([c.start, c.interact, c.restart], [false, false, false]);
});

test('blur drops the taps too', () => {
  const k = keyboard();
  k.key('keydown', 'KeyE');
  k.blur();
  assert.equal(k.sample().interact, false);
});

test('start: a tap that is over before the next sample still counts, once', () => {
  const k = keyboard();
  k.key('keydown', 'KeyW');
  k.key('keyup', 'KeyW');
  assert.equal(k.sample().start, true);
  assert.equal(k.sample().start, false);
  k.key('keydown', 'KeyW');
  k.key('keydown', 'Space');
  k.key('keyup', 'Space');
  k.key('keyup', 'KeyW');
  assert.equal(k.sample().start, true, 'two at once are one press');
  assert.equal(k.sample().start, false);
});

test('start: a window blur leaves no notch behind', () => {
  const k = keyboard();
  k.key('keydown', 'KeyW');
  k.key('keydown', 'KeyD');
  k.blur();
  assert.equal(k.sample().start, false);
  k.key('keydown', 'KeyW');
  assert.equal(k.sample().start, true);
});
