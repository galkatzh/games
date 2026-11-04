// tests/core/loop.test.mjs — WP-CORE
import assert from 'node:assert';
import { test } from 'node:test';
import { coreTLV } from './helpers.mjs';

const { loop, const: C } = coreTLV();

/** A loop on a fake clock. frame(ms) advances time and runs the pending callback. */
function rig(opts = {}) {
  const S = { timeScale: 1, tick: 0 };
  const steps = [];
  const renders = [];
  let clock = 1000;
  let pending = [];
  const L = loop.create({
    S,
    step: opts.step || ((s) => { s.tick++; steps.push(s.tick); }),
    render: (s, alpha, dt) => renders.push({ alpha, dt }),
    raf: (fn) => { pending.push(fn); return pending.length; },
    now: () => clock,
    timescale: opts.timescale
  });
  return {
    S, L, steps, renders,
    pendingCount: () => pending.length,
    frame(ms) {
      clock += ms;
      const run = pending;
      pending = [];
      run.forEach((fn) => fn());
    }
  };
}

test('one tick per 60 Hz frame on a steady clock', () => {
  const r = rig();
  r.L.start();
  for (let i = 0; i < 600; i++) r.frame(1000 / 60);
  assert.ok(Math.abs(r.S.tick - 600) <= 1, `ticks ${r.S.tick}`);
});

test('accumulator carries remainders and reports alpha', () => {
  const r = rig();
  r.L.start();
  r.frame(10);
  assert.strictEqual(r.S.tick, 0);
  assert.ok(Math.abs(r.renders[0].alpha - 0.6) < 1e-9);
  r.frame(10);
  assert.strictEqual(r.S.tick, 1);
  assert.ok(Math.abs(r.renders[1].alpha - 0.2) < 1e-9);
});

test('render receives dtReal in seconds, every frame', () => {
  const r = rig();
  r.L.start();
  r.frame(20);
  assert.ok(Math.abs(r.renders[0].dt - 0.02) < 1e-9);
});

test('a long frame is capped at 0.1 s, and hitting MAX_SUBSTEPS drops the rest instead of spiralling', () => {
  const r = rig();
  r.L.start();
  r.frame(5000);
  assert.strictEqual(r.S.tick, C.MAX_SUBSTEPS);
  assert.strictEqual(r.renders[0].alpha, 0);
  r.frame(0);
  assert.strictEqual(r.S.tick, C.MAX_SUBSTEPS, 'no debt carried over');
});

test('the 0.1 s cap comes before timescale: a long frame at timescale 0.1 buys 0.01 s of sim, not 0.5 s', () => {
  const r = rig({ timescale: 0.1 });
  r.L.start();
  r.frame(5000);
  assert.strictEqual(r.S.tick, 0);
  assert.ok(Math.abs(r.renders[0].alpha - 0.6) < 1e-9, `alpha ${r.renders[0].alpha}`);
});

test('S.timeScale changes ticks per real second only', () => {
  const r = rig();
  r.S.timeScale = 0.6;
  r.L.start();
  for (let i = 0; i < 600; i++) r.frame(1000 / 60);
  assert.ok(Math.abs(r.S.tick - 360) <= 1, `ticks ${r.S.tick}`);
});

test('timescale multiplies the loop and never touches S.timeScale', () => {
  const r = rig({ timescale: 2 });
  r.L.start();
  for (let i = 0; i < 300; i++) r.frame(1000 / 60);
  assert.ok(Math.abs(r.S.tick - 600) <= 2, `ticks ${r.S.tick}`);
  assert.strictEqual(r.S.timeScale, 1);
});

test('a sim-set timeScale takes effect on the next frame', () => {
  const r = rig({
    step: (s) => {
      s.tick++;
      if (s.tick === 60) s.timeScale = 0;
    }
  });
  r.L.start();
  for (let i = 0; i < 200; i++) r.frame(1000 / 60);
  assert.strictEqual(r.S.tick, 60);
});

test('pause stops steps, and render keeps going so the pause screen stays live', () => {
  const r = rig();
  r.L.start();
  r.frame(20);
  r.L.pause();
  assert.strictEqual(r.L.isPaused(), true);
  const ticks = r.S.tick;
  const renders = r.renders.length;
  for (let i = 0; i < 10; i++) r.frame(20);
  assert.strictEqual(r.S.tick, ticks);
  assert.strictEqual(r.renders.length, renders + 10);
  r.L.resume();
  assert.strictEqual(r.L.isPaused(), false);
  r.frame(20);
  assert.strictEqual(r.S.tick, ticks + 1);
});

test('stepN runs synchronously while paused and leaves the accumulator alone', () => {
  const r = rig();
  r.L.start();
  r.L.pause();
  r.L.stepN(50);
  assert.strictEqual(r.S.tick, 50);
  assert.strictEqual(r.renders.length, 0);
});

test('time spent paused is not paid back on resume', () => {
  const r = rig();
  r.L.start();
  r.L.pause();
  for (let i = 0; i < 100; i++) r.frame(50);
  r.L.resume();
  r.frame(1000 / 60);
  assert.strictEqual(r.S.tick, 1);
});

test('stop ends the frame chain', () => {
  const r = rig();
  r.L.start();
  r.frame(20);
  r.L.stop();
  r.frame(20);
  r.frame(20);
  assert.strictEqual(r.renders.length, 1);
  assert.strictEqual(r.pendingCount(), 0);
});

test('stop then start in one frame keeps a single chain', () => {
  const r = rig();
  r.L.start();
  r.L.stop();
  r.L.start();
  r.L.start();
  assert.strictEqual(r.pendingCount(), 1);
  r.frame(20);
  assert.strictEqual(r.renders.length, 1);
  assert.strictEqual(r.pendingCount(), 1);
});

test('a throwing step halts the loop once, instead of throwing on every frame', () => {
  const r = rig({ step: () => { throw new Error('sim bug'); } });
  r.L.start();
  assert.throws(() => r.frame(20), /sim bug/);
  assert.strictEqual(r.pendingCount(), 0);
});

test('a clock that steps backwards counts as a zero-length frame', () => {
  const r = rig();
  r.L.start();
  r.frame(-500);
  assert.strictEqual(r.S.tick, 0);
  assert.strictEqual(r.renders[0].dt, 0);
});
