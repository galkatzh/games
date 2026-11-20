// tests/ui/touch.e2e.cjs — WP-UI
// Run: node tests/ui/touch.e2e.cjs [filter]
//
// The on-screen stick and buttons (js/ui/touch.js) on an emulated phone held sideways, driven by real touch events through the
// DevTools protocol, two fingers at once where it matters. The page is held and stepped by hand, so a finger held for N ticks is
// exactly N ticks of ControlState. tests/player/input_touch.test.mjs holds the mapping itself; this holds the page around it.
'use strict';

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const lib = require('./lib.cjs');

const SHOTS = process.env.TLV_SHOTS || path.join(os.tmpdir(), 'tlv-ui-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const FILTER = process.argv[2] || '';
const PHONE = { viewport: { width: 844, height: 390 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
const QUIET = '&mute=1&traffic=0&peds=0&incidents=0&contest=off';

const results = [];

async function scenario(name, fn) {
  if (FILTER && !name.includes(FILTER)) return;
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`PASS  ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
  } catch (e) {
    results.push({ name, ok: false });
    console.log(`FAIL  ${name}\n${e.stack || e}`);
  }
}

/** Opens the game on the phone, runs fn, and always closes. Any page error fails the scenario. */
async function withPhone(params, fn, context = PHONE) {
  const t = await lib.open(params, { context });
  try {
    const pad = await lib.touchPad(t.page);
    await fn(t.page, pad, t);
    assert.deepStrictEqual(t.errors, [], 'page errors');
    const real = t.consoleErrors.filter((m) => !/ERR_FILE_NOT_FOUND|Failed to load resource/.test(m));
    assert.deepStrictEqual(real, [], 'console errors');
  } finally {
    await t.close();
  }
}

const step = (page, n) => page.evaluate((k) => TLV.debug.step(k), n);
const phase = (page) => page.evaluate(() => TLV.app.S.game.phase);
const controls = (page) => page.evaluate(() => ({ ...TLV.app.S.controls }));
const shot = async (page, name) => {
  await lib.frames(page, 3);
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 240000 });
};
const shown = (page, sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  return !!n && getComputedStyle(n).display !== 'none' && n.getClientRects().length > 0 && !n.closest('.off');
}, sel);
const rect = (page, sel) => page.evaluate((s) => {
  const r = document.querySelector(s).getBoundingClientRect();
  return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height, x: r.left + r.width / 2, y: r.top + r.height / 2 };
}, sel);
const text = (page, sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  return n ? n.textContent.replace(/[⁦⁩]/g, '') : null;
}, sel);

/** Held, in DRIVE, with the overlay drawn for it. */
async function driving(page) {
  await page.evaluate(() => TLV.debug.pause());
  for (let i = 0; i < 120 && (await phase(page)) !== 'DRIVE'; i++) await step(page, 30);
  assert.strictEqual(await phase(page), 'DRIVE');
  await lib.frames(page, 3);
}

/** Two boxes overlap. */
function overlap(a, b) {
  return a.l < b.r && b.l < a.r && a.t < b.b && b.t < a.b;
}

async function main() {
  await scenario('the start line is a tap, and the stick and buttons come up for the drive, clear of the HUD and the edges', async () => {
    await withPhone(`?seed=1${QUIET}&lang=en`, async (page) => {
      await lib.frames(page, 3);
      assert.ok(!(await shown(page, '.touch-layer')), 'nothing over the title');
      const start = await rect(page, '.title-start');
      assert.ok(start.h >= 44, `the start line is a thumb high, ${start.h} px`);
      await page.touchscreen.tap(start.x, start.y);
      await page.waitForFunction(() => TLV.app.S.game.phase !== 'TITLE', null, { timeout: 60000 });
      await driving(page);
      for (const sel of ['.tz-stick', '.tb-space', '.tb-horn', '.tu-pause', '.tu-camera', '.tu-mirror']) assert.ok(await shown(page, sel), sel);
      for (const sel of ['.tb-out', '.touch-catch', '.touch-rotate']) assert.ok(!(await shown(page, sel)), sel);
      const vw = 844;
      const vh = 390;
      const controls = {};
      for (const sel of ['.tb-space', '.tb-horn', '.tu-pause', '.tu-camera', '.tu-mirror', '.stick-ghost']) controls[sel] = await rect(page, sel);
      for (const [sel, r] of Object.entries(controls)) {
        assert.ok(r.l >= 24 && r.r <= vw - 16 && r.t >= 0 && r.b <= vh, `${sel} inside, clear of the edge bands ${JSON.stringify(r)}`);
        assert.ok(Math.min(r.w, r.h) >= 44, `${sel} a thumb wide, ${r.w} by ${r.h}`);
      }
      assert.ok(controls['.stick-ghost'].w >= 96, 'the stick ring');
      for (const hud of ['.hud-map-stack', '.hud-speed', '.hud-money', '.hud-hp', '.hud-clock']) {
        const h = await rect(page, hud);
        for (const [sel, r] of Object.entries(controls)) assert.ok(!overlap(h, r), `${sel} over ${hud}`);
      }
      const fonts = await page.evaluate(() => ['.hud-prompt', '.hud-clock-digits', '.hud-chip-text'].map((s) => parseFloat(getComputedStyle(document.querySelector(s)).fontSize)));
      assert.ok(fonts.every((f) => f >= 10), `readable: ${fonts.join(', ')} px`);
      assert.match(await text(page, '.hud-prompt'), /STICK UP|GREEN/);
      assert.strictEqual(await page.evaluate(() => document.documentElement.scrollWidth), vw, 'no sideways scroll');
      await shot(page, 'touch_drive');
    });
  });

  await scenario('two fingers: the stick drives while SPACE holds the handbrake, and a second finger in the zone changes nothing', async () => {
    await withPhone(`?seed=1&notitle=1${QUIET}`, async (page, pad) => {
      await driving(page);
      const zone = await rect(page, '.tz-stick');
      const sx = zone.l + 90;
      const sy = zone.b - 90;
      await pad.down(1, sx, sy);
      await pad.move(1, sx + 30, sy - 45);
      await step(page, 2);
      let c = await controls(page);
      assert.ok(c.throttle > 0 && c.brake === 0, `throttle ${c.throttle}`);
      assert.ok(c.steer < 0, `right is negative steer, ${c.steer}`);
      assert.strictEqual(c.handbrake, false);
      const space = await rect(page, '.tb-space');
      await pad.down(2, space.x, space.y);
      await step(page, 2);
      c = await controls(page);
      assert.strictEqual(c.handbrake, true, 'both at once');
      assert.ok(c.throttle > 0, 'and the stick still drives');
      await lib.frames(page, 2);
      assert.ok(await page.evaluate(() => document.querySelector('.tb-space').classList.contains('down')));
      await shot(page, 'touch_two_fingers');
      const before = c.steer;
      await pad.down(3, zone.l + 200, zone.b - 60);
      await pad.move(3, zone.l + 260, zone.b - 120);
      await step(page, 2);
      assert.strictEqual((await controls(page)).steer, before, 'one thumb drives');
      await pad.up(3);
      await pad.up(1);
      await step(page, 2);
      c = await controls(page);
      assert.deepStrictEqual([c.throttle, c.brake, c.steer, c.handbrake], [0, 0, 0, true], 'the stick at rest, SPACE still down');
      await pad.cancel();
      await step(page, 2);
      c = await controls(page);
      assert.deepStrictEqual([c.throttle, c.brake, c.steer, c.handbrake], [0, 0, 0, false], 'a cancel lets go of all of it');
      // Pulled back from rest: the brake, and the car backs up after its pause.
      await pad.down(4, sx, sy);
      await pad.move(4, sx, sy + 60);
      await step(page, 60);
      c = await controls(page);
      assert.ok(c.brake > 0.9, `brake ${c.brake}`);
      assert.ok(await page.evaluate(() => TLV.app.S.vehicles[0].v < -0.1), 'reversing');
      await pad.up(4);
    });
  });

  await scenario('the pause button pauses, the overlay goes, and the pause screen has the radio a phone has no key for', async () => {
    await withPhone(`?seed=1&notitle=1${QUIET}`, async (page, pad) => {
      await driving(page);
      await page.evaluate(() => TLV.debug.resume());
      const pause = await rect(page, '.tu-pause');
      await pad.down(1, pause.x, pause.y);
      await pad.up(1);
      await page.waitForFunction(() => TLV.ui.isUserPaused(), null, { timeout: 30000 });
      await lib.frames(page, 3);
      assert.ok(!(await shown(page, '.touch-layer')), 'nothing to drive while paused');
      assert.ok(await shown(page, '.pause-radio'));
      assert.strictEqual(await text(page, '.pause-radio'), 'Next station');
      assert.ok(!/\[/.test(await text(page, '.pause-mute')), 'the mute button names no key');
      assert.strictEqual(await text(page, '.pause-resume'), 'Back to the balagan');
      await shot(page, 'touch_pause');
      const resume = await rect(page, '.pause-resume');
      await page.touchscreen.tap(resume.x, resume.y);
      await page.waitForFunction(() => !TLV.ui.isUserPaused(), null, { timeout: 30000 });
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.touch-layer'));
    });
  });

  await scenario('the camera button toggles the parking view, as C does, and the mode stays touch', async () => {
    await withPhone(`?seed=1&notitle=1${QUIET}`, async (page, pad) => {
      await driving(page);
      const toast = await page.evaluate(() => document.querySelector('.hud-toasts').textContent);
      const cam = await rect(page, '.tu-camera');
      await pad.down(1, cam.x, cam.y);
      await pad.up(1);
      await lib.frames(page, 3);
      // Far from the bay the camera says it only works near one, which is what C says too: the same path.
      const after = await page.evaluate(() => document.querySelector('.hud-toasts').textContent);
      assert.notStrictEqual(after, toast);
      assert.match(after, /bay camera/);
      assert.strictEqual(await page.evaluate(() => TLV.ui.touchMode()), true);
    });
  });

  await scenario('keys take the screen back, and a finger gives it to touch again', async () => {
    await withPhone(`?seed=1&notitle=1${QUIET}`, async (page, pad) => {
      await driving(page);
      await page.waitForTimeout(700);
      await page.keyboard.press('Shift');
      await lib.frames(page, 3);
      assert.strictEqual(await page.evaluate(() => TLV.ui.touchMode()), false);
      assert.ok(!(await shown(page, '.touch-layer')));
      assert.match(await text(page, '.hud-prompt'), /\bGO\b|GREEN/);
      assert.strictEqual(await page.evaluate(() => document.getElementById('ui-root').classList.contains('touch')), false);
      await pad.down(1, 400, 200);
      await pad.up(1);
      await lib.frames(page, 3);
      assert.strictEqual(await page.evaluate(() => TLV.ui.touchMode()), true);
      assert.ok(await shown(page, '.touch-layer'));
      // A key typed while a finger is down, or just after, does not pull the controls out from under it.
      await pad.down(2, 400, 200);
      await page.keyboard.press('Shift');
      await lib.frames(page, 2);
      assert.strictEqual(await page.evaluate(() => TLV.ui.touchMode()), true);
      await pad.up(2);
    });
  });

  await scenario('the knife: E in SPACE\'s place gets out of the car, then the stick runs and SPACE dodges', async () => {
    await withPhone(`?seed=1&notitle=1${QUIET}`, async (page, pad) => {
      await driving(page);
      await page.evaluate(() => { TLV.debug.setErrand(1); TLV.debug.forceKnife({ stage: 'DOOR_TUG' }); });
      await step(page, 2);
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.tb-out'), 'E is up');
      assert.ok(!(await shown(page, '.tb-space')), 'in SPACE\'s place');
      assert.ok(await page.evaluate(() => document.querySelector('.tb-out').classList.contains('pulse')));
      assert.match(await text(page, '.knife-line'), /OUT THE PASSENGER SIDE/);
      await shot(page, 'touch_knife');
      const out = await rect(page, '.tb-out');
      await pad.down(1, out.x, out.y);
      await pad.up(1);
      await step(page, 1);
      for (let i = 0; i < 40 && (await page.evaluate(() => TLV.app.S.player.mode)) !== 'FOOT'; i++) await step(page, 10);
      assert.strictEqual(await page.evaluate(() => TLV.app.S.player.mode), 'FOOT', 'a tap was enough');
      await page.evaluate(() => TLV.debug.forceKnife({ stage: 'CHASE', gap: 14 }));
      await step(page, 2);
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.tz-stick'));
      assert.ok(await page.evaluate(() => document.querySelector('.touch-layer').classList.contains('foot')));
      assert.strictEqual(await text(page, '.tb-space .tb-word'), 'dodge');
      const zone = await rect(page, '.tz-stick');
      const x0 = await page.evaluate(() => [TLV.app.S.player.foot.x, TLV.app.S.player.foot.y]);
      await pad.down(2, zone.l + 90, zone.b - 90);
      await pad.move(2, zone.l + 90, zone.b - 160);
      await step(page, 30);
      const x1 = await page.evaluate(() => [TLV.app.S.player.foot.x, TLV.app.S.player.foot.y]);
      assert.ok(Math.hypot(x1[0] - x0[0], x1[1] - x0[1]) > 1, 'the runner runs');
      const space = await rect(page, '.tb-space');
      await pad.down(3, space.x, space.y);
      await step(page, 1);
      assert.strictEqual((await controls(page)).sidestep, true);
      await pad.cancel();
    });
  });

  await scenario('near the door Q comes up, and holding it parks badly, its ring filling', async () => {
    await withPhone(`?seed=1&notitle=1${QUIET}`, async (page, pad) => {
      await driving(page);
      assert.ok(!(await shown(page, '.tb-hazard')), 'far from the door, no Q');
      await page.evaluate(() => {
        const S = TLV.app.S;
        const r = S.game.nav.route;
        const n = r.px.length - 1;
        TLV.debug.teleport(r.px[n], r.py[n], Math.atan2(r.py[n] - r.py[n - 1], r.px[n] - r.px[n - 1]), 0);
      });
      await step(page, 10);
      await lib.frames(page, 3);
      assert.ok(await page.evaluate(() => TLV.game.parking._qReaches(TLV.app.S)), 'the scene is right: the door is in reach');
      assert.ok(await shown(page, '.tb-hazard'), 'Q is up');
      assert.ok(!(await page.evaluate(() => document.querySelector('.tb-hazard').classList.contains('dim'))), 'and live, stopped');
      const q = await rect(page, '.tb-hazard');
      assert.ok(Math.min(q.w, q.h) >= 44);
      await pad.down(1, q.x, q.y);
      await step(page, 30);
      assert.strictEqual(await phase(page), 'HOLD');
      await lib.frames(page, 2);
      const fill = await page.evaluate(() => Number(getComputedStyle(document.querySelector('.tb-hazard .tb-ring')).getPropertyValue('--fill')));
      assert.ok(fill > 0.3 && fill < 0.8, `the ring is filling, ${fill}`);
      await shot(page, 'touch_park_badly');
      await step(page, 40);
      assert.strictEqual(await phase(page), 'PAYOUT', 'parked');
      await pad.up(1);
    });
  });

  await scenario('a slide off Q lets go of it, as lifting does', async () => {
    await withPhone(`?seed=1&notitle=1${QUIET}`, async (page, pad) => {
      await driving(page);
      await page.evaluate(() => {
        const r = TLV.app.S.game.nav.route;
        const n = r.px.length - 1;
        TLV.debug.teleport(r.px[n], r.py[n], Math.atan2(r.py[n] - r.py[n - 1], r.px[n] - r.px[n - 1]), 0);
      });
      await step(page, 10);
      await lib.frames(page, 3);
      const q = await rect(page, '.tb-hazard');
      await pad.down(1, q.x, q.y);
      await step(page, 20);
      assert.strictEqual(await phase(page), 'HOLD');
      await pad.move(1, q.x - 140, q.y + 60);
      await step(page, 2);
      assert.strictEqual((await controls(page)).hazard, false);
      assert.notStrictEqual(await phase(page), 'HOLD', 'the hold is off');
      await pad.up(1);
    });
  });

  await scenario('the comic card after the knife goes on with a tap anywhere', async () => {
    // Immortal, so a runner who stands still is not caught: the chase runs out, and the whistle ends it in RESOLVE.
    await withPhone(`?seed=1&notitle=1&immortal=1${QUIET}`, async (page, pad) => {
      await driving(page);
      await page.evaluate(() => { TLV.debug.setErrand(1); TLV.debug.forceKnife({ stage: 'CHASE', gap: 14 }); });
      for (let i = 0; i < 200 && (await phase(page)) !== 'RESOLVE'; i++) await step(page, 30);
      assert.strictEqual(await phase(page), 'RESOLVE');
      await step(page, 40);
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.touch-catch'));
      assert.match(await text(page, '.resolve-skip'), /Tap to continue/);
      await pad.down(1, 420, 200);
      await pad.up(1);
      await step(page, 2);
      assert.notStrictEqual(await phase(page), 'RESOLVE', 'the tap went on');
    });
  });

  await scenario('in Hebrew the stick stays on the left and the buttons on the right, and the lines name the stick', async () => {
    await withPhone(`?seed=1&notitle=1${QUIET}&lang=he`, async (page) => {
      await driving(page);
      const stick = await rect(page, '.tz-stick');
      const space = await rect(page, '.tb-space');
      assert.ok(stick.l < 422 && stick.r < 422, 'stick on the left');
      assert.ok(space.l > 422, 'buttons on the right');
      assert.match(await text(page, '.hud-prompt'), /הסטיק/);
      await shot(page, 'touch_drive_he');
    });
  });

  await scenario('turned upright in the middle of a run, the run waits on the pause screen under the turn-the-phone card', async () => {
    await withPhone(`?seed=1&notitle=1${QUIET}`, async (page, pad) => {
      await driving(page);
      await page.evaluate(() => TLV.debug.resume());
      const zone = await rect(page, '.tz-stick');
      await pad.down(1, zone.l + 90, zone.b - 90);
      await pad.move(1, zone.l + 90, zone.b - 150);
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForFunction(() => TLV.ui.touch.rotating() && TLV.ui.isUserPaused(), null, { timeout: 30000 });
      assert.strictEqual((await controls(page)).throttle, 0, 'turning the phone let go of the stick');
      assert.ok(await shown(page, '.touch-rotate'));
      assert.ok(!(await shown(page, '.touch-layer')));
      await page.setViewportSize({ width: 844, height: 390 });
      await page.waitForFunction(() => !TLV.ui.touch.rotating(), null, { timeout: 30000 });
      await lib.frames(page, 3);
      assert.ok(await page.evaluate(() => TLV.ui.isUserPaused()), 'still paused: the player resumes');
      assert.ok(await shown(page, '.pause-resume'));
      await pad.cancel();
    });
  });

  await scenario('the lobby on a phone: a real field for the code, so the phone\'s keyboard opens', async () => {
    await withPhone(`?seed=1${QUIET}&net=local`, async (page) => {
      await lib.frames(page, 3);
      const online = await rect(page, '.title-online');
      await page.touchscreen.tap(online.x, online.y);
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.lobby-title'));
      assert.match(await text(page, '.lobby-choices'), /^Open a roomJoin a room$/);
      const join = await page.evaluate(() => {
        const b = [...document.querySelectorAll('.lobby-choice')][1].getBoundingClientRect();
        return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      await page.touchscreen.tap(join.x, join.y);
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.lobby-code-input'));
      assert.strictEqual(await page.evaluate(() => document.activeElement && document.activeElement.className), 'lobby-code-input');
      assert.strictEqual(await page.evaluate(() => getComputedStyle(document.querySelector('.lobby-code-input')).fontSize), '16px', 'no zoom on focus');
      await page.keyboard.type('ab');
      await lib.frames(page, 2);
      assert.strictEqual(await page.evaluate(() => document.querySelector('.lobby-code-input').value), 'AB');
      assert.strictEqual(await text(page, '.lobby-code'), 'AB··');
      assert.strictEqual(await page.evaluate(() => TLV.app.S.game.phase), 'TITLE', 'typing a code starts no day');
      await page.keyboard.type('cd');
      await page.waitForFunction(() => TLV.net.state().status !== 'off', null, { timeout: 30000 });
      assert.strictEqual(await page.evaluate(() => TLV.net.state().room), 'ABCD');
      await shot(page, 'touch_lobby');
    });
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} pass. Screenshots: ${SHOTS}`);
  process.exitCode = failed.length ? 1 : 0;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
