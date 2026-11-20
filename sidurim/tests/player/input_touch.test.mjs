// tests/player/input_touch.test.mjs — WP-PLAYER
// js/input/input.js in Node: what the on-screen stick and buttons (TLV.input.touch, driven by js/ui/touch.js) leave in ControlState.
// The window is the same bare one input_keys.test.mjs uses, so the keyboard path is checked to be untouched by an idle stick.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createTLV } from '../../tools/lib/classic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Loads input.js into a bare TLV, with an optional camera yaw for the foot vector. */
function pad(yaw) {
  const TLV = createTLV({ files: [], map: null });
  const on = { keydown: [], keyup: [], blur: [] };
  const win = {
    TLV,
    navigator: {},
    addEventListener: (name, fn) => on[name].push(fn),
    removeEventListener: (name, fn) => { on[name] = on[name].filter((f) => f !== fn); }
  };
  if (yaw !== undefined) TLV.render = { camera: { yaw: () => yaw } };
  const file = path.join(ROOT, 'js/input/input.js');
  vm.compileFunction(fs.readFileSync(file, 'utf8'), ['window', 'TLV'], { filename: file })(win, TLV);
  TLV.input.init(win, { params: { autoplay: 'none' } });
  const out = {};
  return {
    TLV,
    touch: TLV.input.touch,
    key: (name, code) => on[name].forEach((fn) => fn({ code, repeat: false, preventDefault() {} })),
    blur: () => on.blur.forEach((fn) => fn()),
    sample: () => ({ ...TLV.input.sample(null, out) })
  };
}

const BOOLS = ['handbrake', 'horn', 'interact', 'hazard', 'sidestep', 'start', 'restart', 'recover'];

function idle(o) {
  for (const f of ['throttle', 'brake', 'steer', 'footX', 'footY']) assert.equal(Object.is(o[f], -0) ? 0 : o[f], 0, f);
  for (const b of BOOLS) assert.equal(o[b], false, b);
}

test('at rest every field is exactly zero or false, and so after a finger lifts', () => {
  const k = pad(0);
  idle(k.sample());
  k.touch.stick(0.7, -0.6);
  k.sample();
  k.touch.stick(0, 0);
  idle(k.sample());
});

test('dead zones: a thumb resting near the centre moves nothing, and pure sideways never throttles', () => {
  const k = pad(0);
  k.touch.stick(0, -0.15);
  assert.equal(k.sample().throttle, 0, 'inside deadY');
  k.touch.stick(0, 0.15);
  assert.equal(k.sample().brake, 0);
  k.touch.stick(0.1, 0);
  assert.equal(k.sample().steer, 0, 'inside deadX');
  k.touch.stick(1, 0);
  const s = k.sample();
  assert.equal(s.throttle, 0);
  assert.equal(s.brake, 0);
});

test('forward is throttle: creep at the first push, full at the top, rising as the square', () => {
  const k = pad(0);
  const T = k.TLV.input.TOUCH;
  k.touch.stick(0, -1);
  assert.equal(k.sample().throttle, 1);
  // The smallest push past the dead zone already moves the car (it moves above 0.096: vehicle.js driveForce).
  k.touch.stick(0, -(T.deadY + 1 / 64));
  const first = k.sample().throttle;
  assert.ok(first >= T.creep && first < 0.12, `first push ${first}`);
  k.touch.stick(0, -0.3);
  const low = k.sample().throttle;
  assert.ok(low > 0.096 && low < 0.2, `a light push is a creep, ${low}`);
  k.touch.stick(0, -0.6);
  const mid = k.sample().throttle;
  assert.ok(mid > low && mid < 0.5, `half way is still under the launch threshold, ${mid}`);
});

test('back is brake, and throttle and brake are never both on', () => {
  const k = pad(0);
  k.touch.stick(0, 1);
  const s = k.sample();
  assert.equal(s.brake, 1);
  assert.equal(s.throttle, 0);
  for (let x = -1; x <= 1; x += 0.125) {
    for (let y = -1; y <= 1; y += 0.125) {
      k.touch.stick(x, y);
      const o = k.sample();
      assert.ok(!(o.throttle > 0 && o.brake > 0), `${x},${y}`);
    }
  }
});

test('sideways is steer: right is negative, as for the pad, with a soft centre', () => {
  const k = pad(0);
  k.touch.stick(1, 0);
  assert.equal(k.sample().steer, -1);
  k.touch.stick(-1, 0);
  assert.equal(k.sample().steer, 1);
  k.touch.stick(-0.5, 0);
  const half = k.sample().steer;
  assert.ok(half > 0 && half < 0.5, `expo under linear, ${half}`);
  // The square gate: the corner is full lock and full throttle at once.
  k.touch.stick(1, -1);
  const c = k.sample();
  assert.equal(Math.abs(c.steer), 1);
  assert.equal(c.throttle, 1);
});

test('every touch float is on a grid of 1/256, and a still thumb gives the same state tick after tick', () => {
  const k = pad(0.7);
  for (const [x, y] of [[0.33, -0.41], [-0.77, 0.21], [0.05, -0.93], [0.6, 0.6]]) {
    k.touch.stick(x, y);
    const a = k.sample();
    const b = k.sample();
    assert.deepEqual(a, b);
    for (const f of ['throttle', 'brake', 'steer', 'footX', 'footY']) assert.ok(Number.isInteger(a[f] * 256), `${f} ${a[f]}`);
  }
});

test('on foot the stick is a direction relative to the camera, full from 70% out', () => {
  for (const yaw of [0, Math.PI / 2, 2.1]) {
    const k = pad(yaw);
    k.touch.stick(0, -0.8);
    const s = k.sample();
    assert.ok(Math.abs(Math.hypot(s.footX, s.footY) - 1) < 0.01, 'full run');
    assert.ok(Math.abs(s.footX - Math.cos(yaw)) < 0.01 && Math.abs(s.footY - Math.sin(yaw)) < 0.01, `forward is the camera's way at ${yaw}`);
    k.touch.stick(0, -0.4);
    const w = k.sample();
    const m = Math.hypot(w.footX, w.footY);
    assert.ok(m > 0 && m < 1, `part way is a walk, ${m}`);
    k.touch.stick(0.1, -0.05);
    const still = k.sample();
    assert.equal(still.footX, 0);
    assert.equal(still.footY, 0);
  }
});

test('a button tap shows for one sample even when it was let go before the tick', () => {
  for (const [name, fields] of [['space', ['handbrake', 'sidestep']], ['horn', ['horn']], ['interact', ['interact']]]) {
    const k = pad(0);
    k.touch.hold(name, true);
    k.touch.hold(name, false);
    const s = k.sample();
    for (const f of fields) assert.equal(s[f], true, `${name} ${f}`);
    for (const f of fields) assert.equal(k.sample()[f], false, `${name} ${f} once`);
    k.touch.tap(name);
    assert.equal(k.sample()[fields[0]], true, 'tap');
    assert.equal(k.sample()[fields[0]], false);
  }
});

test('hold buttons are level: true while held, and park badly and tow have no tap', () => {
  const k = pad(0);
  k.touch.hold('hazard', true);
  for (let i = 0; i < 3; i++) assert.equal(k.sample().hazard, true);
  k.touch.hold('hazard', false);
  assert.equal(k.sample().hazard, false);
  k.touch.hold('recover', true);
  k.touch.hold('recover', false);
  assert.equal(k.sample().recover, false, 'a tow needs holding');
  k.touch.tap('hazard');
  assert.equal(k.sample().hazard, false);
  k.touch.hold('nonsense', true);
  k.touch.hold('constructor', true);
  idle(k.sample());
});

test('nothing on the overlay is start or restart: the R button tows and does nothing else', () => {
  const k = pad(0);
  k.touch.stick(0.5, -0.9);
  for (const n of ['space', 'horn', 'hazard', 'recover', 'interact']) k.touch.hold(n, true);
  const s = k.sample();
  assert.equal(s.start, false);
  assert.equal(s.restart, false);
  assert.equal(s.recover, true);
});

test('dropTaps forgets a tap, and a blur lets go of everything', () => {
  const k = pad(0);
  k.touch.hold('interact', true);
  k.touch.hold('interact', false);
  k.TLV.input.dropTaps();
  assert.equal(k.sample().interact, false, 'a tap made on the pause screen does not land after it');
  k.touch.stick(0, -1);
  k.touch.hold('space', true);
  k.touch.hold('hazard', true);
  k.blur();
  idle(k.sample());
  k.touch.stick(0.4, 0.4);
  k.touch.release();
  idle(k.sample());
});

test('keys and the stick together: the stick wins steer, and the larger throttle or brake counts', () => {
  const k = pad(0);
  k.key('keydown', 'KeyA');
  assert.equal(k.sample().steer, 1);
  k.touch.stick(1, 0);
  assert.equal(k.sample().steer, -1, 'the stick, as the pad stick, overrides');
  k.touch.stick(0, 0);
  k.key('keydown', 'KeyW');
  k.touch.stick(0, -0.3);
  assert.equal(k.sample().throttle, 1, 'W is full throttle whatever the thumb says');
  k.key('keyup', 'KeyW');
  k.key('keyup', 'KeyA');
  k.touch.stick(0, 0);
  const s = k.sample();
  assert.equal(s.steer, 0);
  assert.equal(s.throttle, 0);
});

test('an idle stick leaves the keyboard path exactly as it was', () => {
  const k = pad(0.3);
  k.key('keydown', 'KeyW');
  k.key('keydown', 'KeyD');
  const s = k.sample();
  assert.equal(s.throttle, 1);
  assert.equal(s.steer, -1);
  // The keyboard's foot vector is not snapped to the grid: only touch-made values are.
  const c = Math.cos(0.3);
  const sn = Math.sin(0.3);
  const fx = c + sn;
  const fy = sn - c;
  const m = Math.hypot(fx, fy);
  assert.equal(s.footX, fx / m);
  assert.equal(s.footY, fy / m);
});
