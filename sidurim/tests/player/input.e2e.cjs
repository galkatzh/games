// tests/player/input.e2e.cjs — WP-PLAYER
// Run: node tests/player/input.e2e.cjs
//
// ARCHITECTURE 19, WP-PLAYER item 8: in a browser, keyboard reaches ControlState, and footX/Y rotates with camera yaw. Real key
// events go through Playwright to the real input.js, on the real map, with the real car. Render does not exist yet, so the
// camera is a stand-in that reports a yaw. The last scenario goes through index.html and main.js on a stub tree.
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pw = require('../../tools/lib/pw.cjs');
const stubTree = require('../e2e/lib/stub_tree.cjs');
const { scenario, withPage, tempDir, finish, consoleErrors } = require('../e2e/lib/harness.cjs');

const ROOT = pw.PROJECT_ROOT;
const OWN = ['js/core/', 'js/world/', 'js/sim/player/'];

/** A blank page with core, world, this package and the real map, and one sim, driven by the real input layer. */
async function realPage(page, params = {}) {
  await page.goto('about:blank');
  const load = async (file) => page.addScriptTag({ path: path.join(ROOT, file) });
  await load('js/core/namespace.js');
  await load('js/manifest.js');
  const sim = await page.evaluate(() => TLV.manifest.sim);
  for (const file of sim.filter((f) => OWN.some((d) => f.startsWith(d)))) await load(file);
  await load('js/input/input.js');
  await load('data/maps/tlv_center/map.js');
  await page.evaluate((p) => {
    window.__warn = console.warn;
    console.warn = () => {};
    TLV.params = TLV.config.normalize(p);
    TLV.world.register();
    TLV.player.register();
    TLV.registry.drain();
    window.S = TLV.sim.create({ world: TLV.world.get('tlv_center'), params: TLV.params, allowMissing: true });
    TLV.debug.use(window.S);
    TLV.sim.step(window.S);
    console.warn = window.__warn;
    window.__yaw = 0;
    window.__calls = [];
    TLV.ns('render.camera').yaw = () => window.__yaw;
    TLV.render.camera.toggleParking = () => window.__calls.push('camera');
    TLV.ns('render.rearview').toggle = () => window.__calls.push('rearview');
    TLV.ns('ui').togglePause = () => window.__calls.push('pause');
    TLV.ui.toggleMute = () => window.__calls.push('mute');
    TLV.input.init(window, window.S);
  }, params);
}

/** Steps one tick and returns what the sim saw. */
const controls = (page) => page.evaluate(() => {
  TLV.sim.step(window.S);
  return Object.assign({}, window.S.controls);
});

const RESTED = { throttle: 0, brake: 0, steer: 0, handbrake: false, horn: false, interact: false, hazard: false, sidestep: false, recover: false, restart: false };

/** Holds a key and checks what reaches ControlState, then releases it and checks it clears. */
async function holds(page, key, want) {
  await page.keyboard.down(key);
  const seen = await controls(page);
  for (const [field, value] of Object.entries(want)) assert.strictEqual(seen[field], value, `${key}: ${field} = ${seen[field]}`);
  assert.strictEqual(seen.start, true, `${key}: any key counts as start`);
  await page.keyboard.up(key);
  const after = await controls(page);
  for (const [field, value] of Object.entries(RESTED)) assert.strictEqual(after[field], value, `${key}: ${field} cleared`);
  assert.strictEqual(after.start, false);
}

async function main() {
  await scenario('every driving key reaches ControlState, and clears', async () => {
    await withPage({ goto: false }, async ({ page, logs }) => {
      await realPage(page);
      await holds(page, 'KeyW', { throttle: 1 });
      await holds(page, 'ArrowUp', { throttle: 1 });
      await holds(page, 'KeyS', { brake: 1 });
      await holds(page, 'ArrowDown', { brake: 1 });
      await holds(page, 'KeyA', { steer: 1 });
      await holds(page, 'ArrowLeft', { steer: 1 });
      await holds(page, 'KeyD', { steer: -1 });
      await holds(page, 'ArrowRight', { steer: -1 });
      await holds(page, 'Space', { handbrake: true, sidestep: true });
      await holds(page, 'KeyH', { horn: true });
      await holds(page, 'KeyE', { interact: true });
      await holds(page, 'KeyQ', { hazard: true });
      await holds(page, 'KeyR', { recover: true, restart: true });
      await holds(page, 'Enter', { restart: true });
      assert.deepStrictEqual(consoleErrors(logs), []);
    });
  });

  await scenario('the keyboard drives the car on the real map', async () => {
    await withPage({ goto: false }, async ({ page }) => {
      await realPage(page);
      const before = await page.evaluate(() => ({ x: S.vehicles[0].x, y: S.vehicles[0].y }));
      await page.keyboard.down('KeyW');
      const run = await page.evaluate(() => {
        for (let i = 0; i < 120; i++) TLV.sim.step(window.S);
        return { x: S.vehicles[0].x, y: S.vehicles[0].y, v: S.vehicles[0].v };
      });
      await page.keyboard.up('KeyW');
      assert.ok(Math.hypot(run.x - before.x, run.y - before.y) > 10, 'it moved');
      assert.ok(run.v > 10, `at ${run.v} m/s after 2 s`);
    });
  });

  await scenario('footX/Y rotates with camera yaw', async () => {
    await withPage({ goto: false }, async ({ page }) => {
      await realPage(page);
      const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1e-9, `${label}: ${a} vs ${b}`);
      const at = async (yaw, keys) => {
        await page.evaluate((y) => { window.__yaw = y; }, yaw);
        for (const key of keys) await page.keyboard.down(key);
        const seen = await controls(page);
        for (const key of keys) await page.keyboard.up(key);
        return seen;
      };
      const PI = Math.PI;

      // Looking east, W runs east and D runs south, to the right.
      let c = await at(0, ['KeyW']);
      near(c.footX, 1, 'yaw 0, W x'); near(c.footY, 0, 'yaw 0, W y');
      c = await at(0, ['KeyD']);
      near(c.footX, 0, 'yaw 0, D x'); near(c.footY, -1, 'yaw 0, D y');
      c = await at(0, ['KeyS']);
      near(c.footX, -1, 'yaw 0, S x'); near(c.footY, 0, 'yaw 0, S y');
      c = await at(0, ['KeyA']);
      near(c.footX, 0, 'yaw 0, A x'); near(c.footY, 1, 'yaw 0, A y');

      // Looking north, W runs north and D runs east.
      c = await at(PI / 2, ['KeyW']);
      near(c.footX, 0, 'yaw 90, W x'); near(c.footY, 1, 'yaw 90, W y');
      c = await at(PI / 2, ['ArrowRight']);
      near(c.footX, 1, 'yaw 90, D x'); near(c.footY, 0, 'yaw 90, D y');

      // Any yaw: W follows the camera, the vector stays unit length, and a diagonal is not faster.
      for (const yaw of [0.3, 1.1, 2.4, -1.9, -3]) {
        c = await at(yaw, ['KeyW']);
        near(c.footX, Math.cos(yaw), `yaw ${yaw} x`);
        near(c.footY, Math.sin(yaw), `yaw ${yaw} y`);
        c = await at(yaw, ['KeyW', 'KeyD']);
        near(Math.hypot(c.footX, c.footY), 1, `yaw ${yaw} diagonal`);
      }
    });
  });

  await scenario('the world-frame vector really moves the person, and the sim never reads the camera', async () => {
    await withPage({ goto: false }, async ({ page }) => {
      await realPage(page);
      const moved = await page.evaluate(async () => {
        const v = S.vehicles[0];
        TLV.foot.enter(window.S, v.x + 3, v.y, 0);
        window.__yaw = Math.PI / 2;
        return { x: S.player.foot.x, y: S.player.foot.y };
      });
      await page.keyboard.down('KeyW');
      const end = await page.evaluate(() => {
        for (let i = 0; i < 60; i++) TLV.sim.step(window.S);
        return { x: S.player.foot.x, y: S.player.foot.y };
      });
      await page.keyboard.up('KeyW');
      const run = Math.hypot(end.x - moved.x, end.y - moved.y);
      assert.ok(run > 1, `ran ${run} m`);
      assert.ok(Math.abs(end.y - moved.y) >= Math.abs(end.x - moved.x) - 0.5, 'north, as the camera looks');
    });
  });

  await scenario('UI keys call their module, stay out of ControlState, and held keys do not repeat', async () => {
    await withPage({ goto: false }, async ({ page }) => {
      await realPage(page);
      for (const key of ['Escape', 'KeyP', 'KeyC', 'KeyV', 'KeyM']) await page.keyboard.press(key);
      await page.keyboard.down('KeyC');
      await page.keyboard.down('KeyC');
      await page.keyboard.up('KeyC');
      const calls = await page.evaluate(() => window.__calls);
      assert.deepStrictEqual(calls, ['pause', 'pause', 'camera', 'rearview', 'mute', 'camera']);
    });
  });

  await scenario('arrows and Space never scroll the page, and a lost focus releases everything', async () => {
    await withPage({ goto: false }, async ({ page }) => {
      await realPage(page);
      const defaults = await page.evaluate(() => {
        const out = [];
        for (const code of ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space', 'KeyW']) {
          const e = new KeyboardEvent('keydown', { code, cancelable: true });
          window.dispatchEvent(e);
          out.push(e.defaultPrevented);
          window.dispatchEvent(new KeyboardEvent('keyup', { code }));
        }
        return out;
      });
      assert.deepStrictEqual(defaults, [true, true, true, true, true, false]);
      await page.keyboard.down('KeyW');
      assert.strictEqual((await controls(page)).throttle, 1);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      assert.strictEqual((await controls(page)).throttle, 0);
      await page.keyboard.up('KeyW');
    });
  });

  await scenario('a bot keeps the controls: input.init leaves its source alone, and UI keys still work', async () => {
    await withPage({ goto: false }, async ({ page }) => {
      await realPage(page, { autoplay: 'idle' });
      await page.keyboard.down('KeyW');
      assert.strictEqual((await controls(page)).throttle, 0);
      await page.keyboard.up('KeyW');
      await page.keyboard.press('KeyM');
      assert.deepStrictEqual(await page.evaluate(() => window.__calls), ['mute']);
    });
  });

  await scenario('a gamepad reaches ControlState, with Start reading by phase', async () => {
    await withPage({ goto: false }, async ({ page }) => {
      await realPage(page);
      await page.evaluate(() => {
        window.__pad = {
          connected: true,
          axes: [0, 0, 0, 0],
          buttons: Array.from({ length: 12 }, () => ({ pressed: false, value: 0 }))
        };
        Object.defineProperty(navigator, 'getGamepads', { value: () => [window.__pad], configurable: true });
      });
      const pad = (fn) => page.evaluate(`(${fn})(window.__pad)`);
      await pad('(p) => { p.buttons[7].value = 0.6; p.buttons[6].value = 0.25; p.axes[0] = -1; }');
      let c = await controls(page);
      assert.ok(Math.abs(c.throttle - 0.6) < 1e-9, 'RT');
      assert.ok(Math.abs(c.brake - 0.25) < 1e-9, 'LT');
      assert.strictEqual(c.steer, 1, 'stick left is steer left');
      await pad('(p) => { p.buttons[7].value = 0; p.buttons[6].value = 0; p.axes[0] = 0.1; }');
      c = await controls(page);
      assert.strictEqual(c.steer, 0, 'dead zone');
      await pad('(p) => { p.axes[0] = 0; p.axes[1] = -1; window.__yaw = Math.PI / 2; }');
      c = await controls(page);
      assert.ok(Math.abs(c.footY - 1) < 1e-9 && Math.abs(c.footX) < 1e-9, 'stick up runs where the camera looks');
      await pad('(p) => { p.axes[1] = 0; p.buttons[0].pressed = true; p.buttons[1].pressed = true; p.buttons[2].pressed = true; p.buttons[3].pressed = true; p.buttons[8].pressed = true; }');
      c = await controls(page);
      assert.deepStrictEqual(
        [c.handbrake, c.sidestep, c.horn, c.interact, c.hazard, c.recover],
        [true, true, true, true, true, true]
      );
      await pad('(p) => { p.buttons.forEach((b) => { b.pressed = false; }); p.buttons[9].pressed = true; p.buttons[4].pressed = true; p.buttons[5].pressed = true; }');
      await controls(page);
      await controls(page);
      assert.deepStrictEqual(await page.evaluate(() => window.__calls), ['pause', 'camera', 'rearview'], 'one press, one call');
      await page.evaluate(() => { S.game.phase = 'TITLE'; window.__calls.length = 0; window.__pad.buttons[9].pressed = false; });
      await controls(page);
      await pad('(p) => { p.buttons[9].pressed = true; }');
      c = await controls(page);
      assert.strictEqual(c.start, true, 'Start on the title');
      await page.evaluate(() => { S.game.phase = 'RUN_END'; });
      c = await controls(page);
      assert.strictEqual(c.restart, true, 'Start at run end');
      assert.deepStrictEqual(await page.evaluate(() => window.__calls.filter((x) => x === 'pause')), [], 'neither one pauses');
    });
  });

  await scenario('index.html boots the real input.js through main.js, and it reaches the running sim', async () => {
    const root = stubTree.stubbed(tempDir('input'));
    // The stub tree's js/ui/ui.js also defines a stub input and loads later, so the real file goes after it.
    fs.appendFileSync(path.join(root, 'js/ui/ui.js'), fs.readFileSync(path.join(ROOT, 'js/input/input.js')));
    await withPage({ root, params: '?seed=1&notitle=1' }, async ({ page, logs }) => {
      await pw.waitForTick(page, 2);
      await page.keyboard.down('KeyW');
      await page.keyboard.down('KeyA');
      await page.evaluate(() => { TLV.ns('render.camera').yaw = () => Math.PI; });
      await page.waitForFunction(() => TLV.app.S.controls.throttle === 1 && TLV.app.S.controls.steer === 1);
      const seen = await page.evaluate(() => Object.assign({}, TLV.app.S.controls));
      assert.ok(Math.abs(seen.footX + Math.SQRT1_2) < 1e-9, 'yaw pi, W and A');
      await page.keyboard.up('KeyW');
      await page.keyboard.up('KeyA');
      assert.deepStrictEqual(consoleErrors(logs), []);
    });
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(finish);
