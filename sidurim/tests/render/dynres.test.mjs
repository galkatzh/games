// tests/render/dynres.test.mjs — WP-RENDER (RENDER-CITY)
// The dynamic resolution ladder, fed frame times with no GPU. The wiring into the real renderer is in city.e2e.cjs.
import test from 'node:test';
import assert from 'node:assert';
import { createTLV } from '../../tools/lib/classic.mjs';

const TLV = createTLV({ files: ['js/core/config.js', 'js/render/tune.js', 'js/render/renderer.js'] });
const dyn = TLV.render.dynRes;
const T = TLV.tune.render;

/** Feeds frames for a stretch of time. @param {function(number):number} ms Frame time, from the pixel ratio. @returns {object[]} Moves. */
function run(L, seconds, ms, moves = []) {
  for (let t = 0; t < seconds;) {
    const dt = ms(L.rungs[L.rung]) / 1000;
    t += dt;
    const move = dyn.feed(L, dt);
    if (move) moves.push({ at: L.t, move, pixel: L.rungs[L.rung] });
  }
  return moves;
}

const flat = (ms) => () => ms;
/** A GPU limited by its pixels: this many ms at a pixel ratio of 1. */
const fill = (ms) => (pixel) => ms * pixel * pixel;
const refresh = 1000 / 60;
/** A 60 Hz display: a frame takes a whole number of refreshes. */
const vsync = (gpuMs) => (pixel) => Math.ceil(gpuMs * pixel * pixel / refresh) * refresh;

test('quality auto is the default, so the ladder runs when the player asked for nothing', () => {
  assert.strictEqual(TLV.config.parse('').quality, 'auto');
  assert.strictEqual(TLV.render.pickQuality(TLV.config.parse('').quality, 'Some GPU').auto, true);
  assert.strictEqual(TLV.render.pickQuality(TLV.config.parse('?quality=ultra').quality, 'Some GPU').auto, true);
  assert.strictEqual(TLV.render.pickQuality(undefined, 'Some GPU').auto, true);
});

test('a quality the player asked for is theirs, on any GPU, and the ladder stays off', () => {
  for (const name of ['low', 'med', 'high']) {
    for (const gpu of ['', 'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero)), SwiftShader driver)', 'NVIDIA GeForce RTX 4090']) {
      assert.deepStrictEqual({ ...TLV.render.pickQuality(name, gpu) }, { name, auto: false });
    }
  }
});

test('auto starts a software GPU on low and anything else on high', () => {
  const software = [
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)',
    'Google SwiftShader', 'llvmpipe (LLVM 15.0.7, 256 bits)', 'Mesa softpipe', 'Microsoft Basic Render Driver', 'Apple Software Renderer'
  ];
  for (const gpu of software) assert.strictEqual(TLV.render.pickQuality('auto', gpu).name, 'low', gpu);
  const real = ['ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)', 'Apple M1', 'Adreno (TM) 640', 'Mali-G78', 'WebKit WebGL', ''];
  for (const gpu of real) assert.strictEqual(TLV.render.pickQuality('auto', gpu).name, 'high', gpu);
});

test('rungs run from the preset to the floor, in even steps, whatever the display', () => {
  for (const base of [2, 1.5, 1, 0.75, 0.64]) {
    const { rungs } = dyn.create(base, true);
    assert.strictEqual(rungs[0], base);
    assert.ok(Math.abs(rungs[rungs.length - 1] - T.dynResMin) < 1e-9, `${base} ends at ${rungs[rungs.length - 1]}`);
    for (let i = 1; i < rungs.length; i++) {
      assert.ok(rungs[i] < rungs[i - 1]);
      assert.ok(rungs[i] / rungs[i - 1] >= T.dynResStep - 1e-9, `${base}: rung ${i} falls too far`);
    }
  }
  assert.ok(dyn.create(2, true).rungs.length <= 9, 'a 2x display reaches the floor in under 20 seconds');
  assert.deepStrictEqual(dyn.create(0.5, true).rungs, [0.5], 'nothing to fall from under the floor');
  assert.deepStrictEqual(dyn.create(T.dynResMin, true).rungs, [T.dynResMin]);
});

test('sustained slow frames go down a rung a window, to the floor and no further', () => {
  const L = dyn.create(1, false);
  const moves = run(L, 120, fill(100));
  assert.strictEqual(moves.length, L.rungs.length - 1);
  assert.ok(moves.every((m) => m.move === 'down'));
  assert.ok(Math.abs(L.rungs[L.rung] - T.dynResMin) < 1e-9);
  assert.ok(moves[0].at >= T.dynResGraceS, 'nothing moves in the grace period');
  for (let i = 1; i < moves.length; i++) assert.ok(moves[i].at - moves[i - 1].at >= T.dynResHoldS - 0.1);
});

test('frames just inside the limit move nothing, and nor do frames just over it for less than a window', () => {
  const L = dyn.create(1, true);
  assert.deepStrictEqual(run(L, 300, flat(T.dynResMs - 0.5)), []);
  const M = dyn.create(1, true);
  run(M, 10, flat(16));
  assert.deepStrictEqual(run(M, T.dynResHoldS * 0.2, flat(T.dynResMs + 1)), []);
});

test('one long frame is not a slow spell: a hitch, a stall, a tab coming back', () => {
  const L = dyn.create(1, true);
  run(L, 10, flat(14));
  const moves = [];
  for (const hitch of [0.3, 0.6, 2, 60, 900]) {
    const move = dyn.feed(L, hitch);
    if (move) moves.push(move);
    run(L, 20, flat(14), moves);
  }
  assert.deepStrictEqual(moves, []);
  assert.strictEqual(L.rung, 0);
});

test('a GPU that needs a second a frame still gets down: clamped frames all read the same, which is no proof of anything', () => {
  const L = dyn.create(1, false);
  const moves = run(L, 300, flat(1000));
  assert.strictEqual(L.rung, L.rungs.length - 1);
  assert.ok(moves.every((m) => m.move === 'down'));
});

test('a floor that holds still is not a cap: the count is of rungs, not of windows', () => {
  const L = dyn.create(1, false);
  const moves = run(L, 600, fill(100));
  assert.strictEqual(L.rung, L.rungs.length - 1);
  assert.ok(moves.every((m) => m.move === 'down'));
  assert.strictEqual(L.heldUntil, 0);
});

test('startup compiles count for nothing', () => {
  const L = dyn.create(1, true);
  for (let i = 0; i < Math.floor(T.dynResGraceS / T.dynResClampS) - 1; i++) assert.strictEqual(dyn.feed(L, 1.5), null);
  assert.strictEqual(L.n, 0);
  assert.deepStrictEqual(run(L, 60, flat(16)), []);
});

test('frames that recover climb back to the preset, a rung per wait, and never past it', () => {
  const L = dyn.create(1, false);
  run(L, 60, fill(100));
  const floor = L.rung;
  assert.ok(floor > 0);
  const moves = run(L, 120, flat(8));
  assert.strictEqual(moves.length, floor);
  assert.ok(moves.every((m) => m.move === 'up'));
  assert.strictEqual(L.rung, 0);
  assert.strictEqual(L.rungs[L.rung], 1);
  for (let i = 1; i < moves.length; i++) assert.ok(moves[i].at - moves[i - 1].at >= T.dynResUpWaitS - 0.1, `${moves[i].at - moves[i - 1].at}`);
  assert.deepStrictEqual(run(L, 120, flat(8)), []);
});

test('no rung up that the numbers say would fail', () => {
  const L = dyn.create(1, false);
  run(L, 60, fill(100));
  const floor = L.rung;
  const grow = L.rungs[floor - 1] / L.rungs[floor];
  const tight = T.dynResMs * T.dynResRoom / (grow * grow);
  assert.deepStrictEqual(run(L, 300, flat(tight + 0.5)), []);
  assert.strictEqual(run(L, 60, flat(tight - 0.5))[0].move, 'up');
});

test('no flicker on a load that sits on a rung edge, with real headroom in the frame times', () => {
  const L = dyn.create(1, false);
  const cost = (pixel) => 27 * pixel * pixel;
  const moves = run(L, 1800, cost);
  assert.strictEqual(moves.length, 1, 'one step down, and it stays');
});

test('no flicker behind a display refresh, which hides how much room a frame has', () => {
  // 22 ms at full size: the refresh shows 33 ms there and at the rung below, and 16.7 ms at the rung below that. So 16.7 ms looks like
  // plenty of room, and each rung up has to be tried. Without the back-off this changes the picture every 10 seconds for ever.
  const L = dyn.create(1, false);
  const moves = run(L, 3600, vsync(22));
  const tries = moves.filter((m) => m.move === 'up').length;
  assert.ok(tries >= 2, 'it does keep trying');
  assert.ok(tries <= 3600 / T.dynResUpWaitMaxS + 6, `${tries} tries in an hour`);
  for (let i = 1; i < moves.length; i++) {
    if (moves[i].move === 'up') assert.ok(moves[i].at - moves[i - 1].at >= T.dynResUpWaitS - 0.1);
  }
  const ups = moves.filter((m) => m.move === 'up').map((m) => m.at);
  for (let i = 2; i < ups.length; i++) assert.ok(ups[i] - ups[i - 1] >= ups[i - 1] - ups[i - 2] - 2 || ups[i] - ups[i - 1] >= T.dynResUpWaitMaxS - 2, 'the gaps grow');
  assert.ok(L.wait >= T.dynResUpWaitMaxS);
  assert.ok(L.rungs[L.rung] > 0.7, 'it settles on the best rung that holds, not the floor');
});

test('a browser holding frames at 30 to save battery is not a slow GPU: full size, shadows kept, a rare look', () => {
  const L = dyn.create(1, true);
  const moves = [];
  let atTop = 0, total = 0;
  for (let t = 0; t < 3600; t += 1 / 30) {
    const move = dyn.feed(L, 1 / 30);
    if (move) moves.push({ at: L.t, move, pixel: L.rungs[L.rung] });
    total++;
    if (L.rung === 0) atTop++;
  }
  assert.deepStrictEqual(moves.filter((m) => m.move === 'drop'), [], 'shadows stay');
  assert.strictEqual(L.rung, 0);
  assert.strictEqual(L.shadows, true);
  assert.ok(atTop / total > 0.98, `${(atTop / total * 100).toFixed(1)}% of the hour at full size`);
  assert.ok(moves.length <= 4 * (T.dynResFlatRungs + 1), `${moves.length} moves in an hour`);
  assert.deepStrictEqual(moves.slice(0, T.dynResFlatRungs + 1).map((m) => m.move), [...Array(T.dynResFlatRungs).fill('down'), 'up']);
  assert.strictEqual(moves[T.dynResFlatRungs].pixel, 1, 'it gives back every rung at once');
});

test('the same for a frame rate the CPU sets, on any display', () => {
  for (const base of [1, 1.5, 2]) {
    const L = dyn.create(base, true);
    run(L, 600, flat(45));
    assert.strictEqual(L.rung, 0, `at ${base}`);
    assert.strictEqual(L.shadows, true);
  }
});

test('a display refresh is not a cap: a GPU stuck at 33 ms over two rungs still gets through to 16', () => {
  // 30 ms at full size: 33.3 ms on screen until the third rung, the first with a whole refresh to spare.
  const L = dyn.create(1, false);
  const moves = run(L, 600, vsync(30));
  assert.strictEqual(moves[0].move, 'down');
  assert.ok(L.rung >= 3, `rung ${L.rung}`);
  assert.strictEqual(vsync(30)(L.rungs[L.rung]), refresh);
  assert.deepStrictEqual(moves.filter((m) => m.pixel === 1), [], 'never thrown back to the top');
});

test('a load that grows while the ladder falls is not a cap', () => {
  const L = dyn.create(1, false);
  let ms = 30;
  const moves = [];
  for (let w = 0; w < 30; w++) {
    run(L, T.dynResHoldS + 0.05, flat(ms), moves);
    ms *= 1.07;
  }
  assert.strictEqual(L.rung, L.rungs.length - 1);
  assert.ok(moves.every((m) => m.move === 'down'));
});

test('when a cap lifts and the GPU turns out slow after all, the ladder works again', () => {
  const L = dyn.create(1, true);
  run(L, 120, flat(33.3));
  assert.ok(L.heldUntil > L.t, 'standing down');
  assert.strictEqual(L.rung, 0);
  run(L, L.hold, flat(14));
  assert.strictEqual(L.rung, 0);
  assert.strictEqual(run(L, 60, (p) => 50 * p * p)[0].move, 'down');
  assert.ok(L.rung > 0);
});

test('a rung up that holds forgives the ones that failed', () => {
  const L = dyn.create(1, false);
  run(L, 600, vsync(22));
  assert.ok(L.wait > T.dynResUpWaitS);
  const moves = run(L, T.dynResUpWaitMaxS * 2, flat(6));
  assert.ok(moves.length >= 1);
  assert.strictEqual(L.rung, 0);
  run(L, T.dynResFailS + T.dynResHoldS * 2, flat(6));
  assert.strictEqual(L.wait, T.dynResUpWaitS);
});

test('still slow on the floor: shadows go once, late, and the pixels can come back', () => {
  const L = dyn.create(1, true);
  const moves = run(L, 120, fill(200));
  const drops = moves.filter((m) => m.move === 'drop');
  assert.strictEqual(drops.length, 1);
  assert.strictEqual(moves[moves.length - 1].move, 'drop', 'after every rung');
  const last = moves[moves.length - 2];
  assert.ok(drops[0].at - last.at >= T.dynResHoldS * T.dynResDropWindows - 0.1, 'three windows on the floor first');
  assert.strictEqual(L.shadows, false);
  const up = run(L, 120, flat(8));
  assert.strictEqual(up.length, L.rungs.length - 1);
  assert.strictEqual(L.rung, 0);
  assert.deepStrictEqual(run(L, 120, flat(60)).filter((m) => m.move === 'drop'), [], 'only once');
});

test('a good window on the floor starts the count for shadows again', () => {
  const L = dyn.create(0.6, true);
  const moves = [];
  for (let i = 0; i < 40; i++) {
    run(L, T.dynResHoldS * 2 + 0.2, flat(60), moves);
    run(L, T.dynResHoldS + 0.1, flat(14), moves);
  }
  assert.deepStrictEqual(moves, []);
});

test('no shadows, nothing to drop', () => {
  const L = dyn.create(0.75, false);
  assert.ok(run(L, 300, flat(60)).every((m) => m.move === 'down'));
});

test('a frame of no time is no frame: drawNow and a paused test render cost the ladder nothing', () => {
  const L = dyn.create(1, true);
  const before = JSON.stringify(L);
  for (const dt of [0, -1, NaN, undefined]) assert.strictEqual(dyn.feed(L, dt), null);
  assert.strictEqual(JSON.stringify(L), before);
});

test('the same frames give the same moves, so it owns no clock', () => {
  const stream = [];
  for (let i = 0; i < 20000; i++) stream.push((14 + 40 * Math.abs(Math.sin(i * 0.002)) + (i % 97 === 0 ? 300 : 0)) / 1000);
  const go = () => {
    const L = dyn.create(1.5, true);
    return { moves: stream.map((dt) => dyn.feed(L, dt)).filter(Boolean), L };
  };
  assert.deepStrictEqual(go(), go());
});
