// tests/ui/ui.e2e.cjs — WP-UI
// Run: node tests/ui/ui.e2e.cjs [filter]
// Screenshots go to $TLV_SHOTS. Software GL is slow, so this waits on frames and state, never on frame rate.
//
// Runs on the page as it stands. Where WP-RENDER has not landed, tests/ui/lib.cjs supplies a stand-in projection (see there).
'use strict';

const assert = require('node:assert');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const lib = require('./lib.cjs');

const SHOTS = process.env.TLV_SHOTS || path.join(os.tmpdir(), 'tlv-ui-shots');
fs.mkdirSync(SHOTS, { recursive: true });
const FILTER = process.argv[2] || '';
const CAMERA = path.join(__dirname, '../../js/render/camera.js');
/** Where the parking rig comes in. The figure is WP-RENDER's, so these tests read it and follow it. */
const RIG_M = Number(/parkRangeM:\s*([\d.]+)/.exec(fs.readFileSync(CAMERA, 'utf8'))[1]);

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

/** Opens a page, runs fn, and always closes. Any page error fails the scenario. */
async function withGame(params, opts, fn) {
  const t = await lib.open(params, opts);
  try {
    await fn(t.page, t);
    assert.deepStrictEqual(t.errors, [], 'page errors');
    const real = t.consoleErrors.filter((m) => !/ERR_FILE_NOT_FOUND|Failed to load resource/.test(m));
    assert.deepStrictEqual(real, [], 'console errors');
  } finally {
    await t.close();
  }
}

const state = (page) => page.evaluate(() => TLV.debug.state());
const step = (page, n) => page.evaluate((k) => TLV.debug.step(k), n);
const shot = async (page, name) => {
  await lib.frames(page, 3);
  await page.waitForTimeout(600);
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`), timeout: 240000 });
};
const shown = (page, sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  return !!n && getComputedStyle(n).display !== 'none' && n.getClientRects().length > 0;
}, sel);
const text = (page, sel) => page.evaluate((s) => {
  const n = document.querySelector(s);
  return n ? n.textContent.replace(/[\u2066\u2069]/g, '') : null;
}, sel);

async function toPhase(page, phase, maxBatches = 120) {
  for (let i = 0; i < maxBatches; i++) {
    if ((await state(page)).phase === phase) return;
    await step(page, 30);
  }
  throw new Error(`never reached ${phase}, at ${(await state(page)).phase}`);
}

/** A paused page stepped by hand: the tests own time. */
async function held(page) {
  await page.evaluate(() => TLV.debug.pause());
  await step(page, 2);
  await lib.frames(page, 1);
}

/**
 * Puts the car on the route, this many metres short of its end. A negative figure runs on past the end, along the last stretch.
 * @param {object} page Playwright page.
 * @param {number} left Metres.
 * @param {number} [v] Speed, m/s.
 * @param {number} [turn] Radians added to the heading.
 */
const toBay = (page, left, v = 2, turn = 0) => page.evaluate(([d, speed, yaw]) => {
  const r = TLV.app.S.game.nav.route;
  const want = r.len - d;
  let i = 0;
  while (i < r.px.length - 2 && r.cum[i + 1] < want) i++;
  const f = (want - r.cum[i]) / Math.max(1e-6, r.cum[i + 1] - r.cum[i]);
  const x = r.px[i] + (r.px[i + 1] - r.px[i]) * f;
  const y = r.py[i] + (r.py[i + 1] - r.py[i]) * f;
  TLV.debug.teleport(x, y, Math.atan2(r.py[i + 1] - r.py[i], r.px[i + 1] - r.px[i]) + yaw, speed);
}, [left, v, turn]);

/** Screen rectangles of every visible element a selector finds. */
const boxes = (page, sel) => page.evaluate((q) => [...document.querySelectorAll(q)].filter((n) => n.getClientRects().length > 0).map((n) => {
  const b = n.getBoundingClientRect();
  return { l: b.left, r: b.right, t: b.top, b: b.bottom };
}), sel);

/** Screen rectangle of the player's car and of the bay's box, from the real projection. */
const worldBoxes = (page) => page.evaluate(() => {
  const S = TLV.app.S;
  const veh = S.vehicles[0];
  const spot = TLV.world.parking.spot(S.world, S.game.errand.bayId);
  const outline = (cx, cy, h, hl, hw, zs) => {
    const out = [];
    const c = Math.cos(h);
    const s = Math.sin(h);
    for (const [a, w] of [[hl, hw], [hl, -hw], [-hl, -hw], [-hl, hw]]) {
      for (const z of zs) {
        const p = TLV.render.project(cx + a * c - w * s, cy + a * s + w * c, z, {});
        out.push({ x: p.sx, y: p.sy });
      }
    }
    return out;
  };
  return { car: outline(veh.x, veh.y, veh.h, veh.length / 2, veh.width / 2, [0, 1.5]), box: outline(spot.x, spot.y, spot.h, spot.len / 2, spot.wid / 2, [0]) };
});

/** True when two rectangles overlap. */
const meets = (a, b) => a.l < b.r && a.r > b.l && a.t < b.b && a.b > b.t;

/** Convex hull of screen points, so a turned car or box is tested as its real shape and not as the rectangle round it. */
function hull(points) {
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
  const half = (list) => {
    const out = [];
    for (const p of list) {
      while (out.length >= 2 && cross(out[out.length - 2], out[out.length - 1], p) <= 0) out.pop();
      out.push(p);
    }
    out.pop();
    return out;
  };
  return [...half(pts), ...half([...pts].reverse())];
}

/** True when a rectangle and a convex shape overlap, by separating axes. */
function touchesShape(rect, shape) {
  const corners = [{ x: rect.l, y: rect.t }, { x: rect.r, y: rect.t }, { x: rect.r, y: rect.b }, { x: rect.l, y: rect.b }];
  const axes = [{ x: 1, y: 0 }, { x: 0, y: 1 }];
  shape.forEach((p, i) => {
    const q = shape[(i + 1) % shape.length];
    axes.push({ x: q.y - p.y, y: p.x - q.x });
  });
  return axes.every((a) => {
    const span = (list) => list.map((p) => p.x * a.x + p.y * a.y);
    const r = span(corners);
    const s = span(shape);
    return Math.max(...r) > Math.min(...s) && Math.min(...r) < Math.max(...s);
  });
}

/**
 * Records the car's outline and the words on every drawn frame until the parking rig has landed. It runs inside the page, because a
 * round trip for each frame would miss most of a blend on software GL.
 * @param {object} page Playwright page.
 * @returns {Promise<Array<{blendT:number,car:Array<object>,words:Array<object>}>>} One entry per frame of the parking rig.
 */
const rigTrace = (page) => page.evaluate(() => new Promise((resolve) => {
  const out = [];
  let frames = 2400;
  const tick = () => {
    const cam = TLV.render.camera._state();
    if (cam.rig === 'parking') {
      const veh = TLV.app.S.vehicles[0];
      const c = Math.cos(veh.h);
      const s = Math.sin(veh.h);
      const car = [];
      for (const [a, w] of [[1, 1], [1, -1], [-1, -1], [-1, 1]]) {
        const along = a * veh.length / 2;
        const across = w * veh.width / 2;
        for (const z of [0, 1.5]) {
          const p = TLV.render.project(veh.x + along * c - across * s, veh.y + along * s + across * c, z, {});
          car.push({ x: p.sx, y: p.sy });
        }
      }
      const words = [...document.querySelectorAll('.hud-prompt, .toast, .hud-parkbar')].filter((n) => n.getClientRects().length > 0).map((n) => {
        const b = n.getBoundingClientRect();
        return { l: b.left, r: b.right, t: b.top, b: b.bottom };
      });
      out.push({ blendT: cam.blendT, car, words });
      if (cam.blendT >= 1) {
        resolve(out);
        return;
      }
    }
    if (--frames <= 0) resolve(out);
    else requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}));

/** Waits until the camera has settled on the car: blends and springs run on drawn frames, so they cannot be stepped. */
async function settled(page) {
  let last = null;
  for (let i = 0; i < 90; i++) {
    await lib.frames(page, 2);
    const now = await page.evaluate(() => {
      const S = TLV.app.S;
      const p = TLV.render.project(S.vehicles[0].x, S.vehicles[0].y, 0, {});
      return { x: p.sx, y: p.sy, rig: TLV.ui.parkingView() };
    });
    if (last && last.rig === now.rig && Math.abs(last.x - now.x) < 0.5 && Math.abs(last.y - now.y) < 0.5 && i > 4) return now;
    last = now;
  }
  return last;
}

/** Serves the parking camera with some of its figures changed, in memory only. The values in the file are WP-RENDER's. */
const cameraWith = (changes) => async (page) => {
  let body = fs.readFileSync(CAMERA, 'utf8');
  for (const [name, value] of Object.entries(changes)) {
    const figure = new RegExp(`${name}:\\s*[\\d.]+`);
    assert.match(body, figure, `${name} is still in camera.js`);
    body = body.replace(figure, `${name}: ${value}`);
  }
  await page.route('**/js/render/camera.js', (route) => route.fulfill({ contentType: 'text/javascript; charset=utf-8', body }));
};

/** Puts up the longest lines the HUD has: a two-line prompt and three toasts. */
const plantWords = (page) => page.evaluate(() => {
  const v = TLV.ui.hud._view();
  v.prompt.key = 'prompt.missed.BACK_OR_Q';
  v.prompt.t = 99;
  TLV.ui.hud.toast('Recalculating. Disappointed.');
  TLV.ui.hud.toast('SOMEONE ELSE WANTS YOUR SPOT', 'warn');
  TLV.ui.hud.toast('TICKET ₪200. The inspector was already here. He is always already here.', 'warn');
});

/**
 * The words as they stand now, tested on the real projected outline of the car.
 * @param {object} page Playwright page.
 * @param {string} label For the failure message.
 * @param {{width:number,height:number}} size Viewport.
 * @returns {Promise<{words:Array<object>,car:Array<object>,world:object}>} What was tested.
 */
async function wordsOffCar(page, label, { width, height }) {
  const world = await worldBoxes(page);
  const car = hull(world.car);
  const words = [...(await boxes(page, '.hud-prompt')), ...(await boxes(page, '.toast')), ...(await boxes(page, '.hud-parkbar'))];
  assert.ok(words.length >= 4, `${label}: ${JSON.stringify(words)}`);
  for (const w of words) {
    assert.ok(w.l >= 0 && w.t >= 0 && w.r <= width && w.b <= height, `${label} on screen ${JSON.stringify(w)}`);
    assert.ok(!touchesShape(w, car), `${label} on the car ${JSON.stringify({ w, car })}`);
  }
  return { words, car, world };
}

/**
 * Seeks each pop through its whole animation, so the answer does not hang on when the page was read.
 * @param {object} page Playwright page.
 * @returns {Promise<Array<{text:string,top:number,at:number}>>} The highest each pop's box reaches, and when.
 */
const popPeaks = (page) => page.evaluate(() => document.getAnimations().filter((a) => a.effect.target.classList.contains('pop')).map((a) => {
  const n = a.effect.target;
  const end = a.effect.getComputedTiming().endTime;
  const peak = { text: n.textContent, top: Infinity, at: 0 };
  a.pause();
  for (let ms = 0; ms <= end; ms += 20) {
    a.currentTime = ms;
    const top = n.getBoundingClientRect().top;
    if (top < peak.top) Object.assign(peak, { top, at: ms });
  }
  return peak;
}));

async function main() {
  await scenario('title: first visit defaults to Relaxed, with text, attribution, controls', async () => {
    await withGame('?seed=1', {}, async (page) => {
      await lib.frames(page, 3);
      assert.strictEqual((await state(page)).phase, 'TITLE');
      assert.ok(await shown(page, '.scr-title'));
      assert.ok(!(await shown(page, '.hud')));
      assert.strictEqual(await text(page, '.diff.on .diff-name'), 'RELAXED');
      assert.ok((await text(page, '.scr-title')).includes('© OpenStreetMap contributors'));
      assert.match(await text(page, '.diff[data-diff=relaxed] .diff-line'), /\w+/);
      assert.match(await text(page, '.diff[data-diff=normal] .diff-line'), /\w+/);
      assert.match(await text(page, '.title-gan'), /picking the kid up from the kindergarten/);
      const line = await page.evaluate(() => {
        const n = document.querySelector('.scr-title .controls-line');
        const tops = new Set([...n.children].map((c) => Math.round(c.getBoundingClientRect().top)));
        return { rows: tops.size, right: n.scrollWidth <= n.clientWidth + 1, cells: n.children.length };
      });
      assert.strictEqual(line.rows, 1, 'controls fit one line');
      assert.ok(line.right, 'controls do not overflow');
      assert.strictEqual(line.cells, 11);
      await shot(page, 'title');
    });
  });

  await scenario('title: the choice reaches setDifficulty before the run, survives a reload, and never starts the day', async () => {
    const init = () => {
      window.__calls = [];
      const wait = setInterval(() => {
        if (window.TLV && TLV.game && TLV.game.flow) {
          clearInterval(wait);
          if (!TLV.game.setDifficulty) TLV.game.setDifficulty = (d) => window.__calls.push({ d, phase: TLV.app && TLV.app.S ? TLV.app.S.game.phase : null });
          else {
            const real = TLV.game.setDifficulty;
            TLV.game.setDifficulty = function (d) {
              window.__calls.push({ d, phase: TLV.app && TLV.app.S ? TLV.app.S.game.phase : null });
              return real.apply(this, arguments);
            };
          }
        }
      }, 0);
    };
    const t = await lib.open('?seed=1', { init });
    try {
      const { page } = t;
      await lib.frames(page, 3);
      await page.keyboard.press('ArrowRight');
      await lib.frames(page, 6);
      assert.strictEqual((await state(page)).phase, 'TITLE', 'an arrow key must not start the day');
      assert.strictEqual(await text(page, '.diff.on .diff-name'), 'NORMAL');
      assert.strictEqual(await page.evaluate(() => localStorage.getItem('sidurim.difficulty')), 'normal');
      await page.keyboard.press('Digit1');
      await lib.frames(page, 4);
      assert.strictEqual(await text(page, '.diff.on .diff-name'), 'RELAXED');
      assert.strictEqual((await state(page)).phase, 'TITLE');
      await page.click('.diff[data-diff=normal]');
      await lib.frames(page, 4);
      assert.strictEqual(await text(page, '.diff.on .diff-name'), 'NORMAL');
      assert.strictEqual((await state(page)).phase, 'TITLE');
      await page.keyboard.press('KeyM');
      await page.keyboard.press('Shift');
      await lib.frames(page, 4);
      assert.strictEqual((await state(page)).phase, 'TITLE', 'mute and modifiers must not start the day');
      await page.keyboard.press('KeyM');

      const calls = await page.evaluate(() => window.__calls);
      assert.ok(calls.length >= 4, JSON.stringify(calls));
      assert.ok(calls.every((c) => c.phase === 'TITLE' || c.phase === null), JSON.stringify(calls));
      assert.strictEqual(calls[calls.length - 1].d, 'normal');

      await page.keyboard.down('Enter');
      await page.waitForFunction(() => TLV.debug.state().phase !== 'TITLE');
      await page.keyboard.up('Enter');
      await lib.frames(page, 2);
      assert.ok(!(await shown(page, '.scr-title')));

      await page.reload();
      await page.waitForFunction(() => window.TLV && TLV.app && TLV.app.S && document.querySelector('.diff.on'), null, { timeout: 180000 });
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.diff.on .diff-name'), 'NORMAL', 'the last choice is remembered');
      assert.deepStrictEqual(t.errors, []);
    } finally {
      await t.close();
    }
  });

  await scenario('title: the real sim gives Relaxed 200 s and Normal 120 s at the first card', async () => {
    for (const [key, name, seconds, digits] of [['Digit1', 'relaxed', 200, '3:20'], ['Digit2', 'normal', 120, '2:00']]) {
      await withGame('?seed=1&mute=1', {}, async (page) => {
        await lib.frames(page, 3);
        assert.strictEqual(await page.evaluate(() => typeof TLV.game.setDifficulty), 'function', 'the sim has it');
        await page.keyboard.press(key);
        await lib.frames(page, 4);
        assert.strictEqual(await page.evaluate(() => TLV.game.getDifficulty()), name);
        await page.keyboard.down('Enter');
        await page.waitForFunction(() => TLV.debug.state().phase === 'CARD');
        await page.keyboard.up('Enter');
        await lib.frames(page, 3);
        const at = await page.evaluate(() => ({ phase: TLV.app.S.game.phase, clock: TLV.app.S.game.clock, difficulty: TLV.app.S.game.difficulty }));
        assert.strictEqual(at.phase, 'CARD', JSON.stringify(at));
        assert.strictEqual(at.clock, seconds, JSON.stringify(at));
        assert.strictEqual(at.difficulty, name);
        assert.strictEqual(await text(page, '.hud-clock-digits'), digits);
        assert.ok(await shown(page, '.phone'));
        await shot(page, `first_card_${name}`);
      });
    }
  });

  await scenario('title: works with setDifficulty absent, with storage refused, and a click starts the day', async () => {
    const init = () => {
      const refuse = () => { throw new Error('storage refused'); };
      Object.defineProperty(window, 'localStorage', { get: refuse });
      const wait = setInterval(() => {
        if (window.TLV && TLV.game) {
          clearInterval(wait);
          Object.defineProperty(TLV.game, 'setDifficulty', { value: undefined, writable: true, configurable: true });
        }
      }, 0);
    };
    await withGame('?seed=1', { init }, async (page) => {
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.diff.on .diff-name'), 'RELAXED');
      await page.keyboard.press('ArrowRight');
      await lib.frames(page, 4);
      assert.strictEqual(await text(page, '.diff.on .diff-name'), 'NORMAL');
      await page.dispatchEvent('.title-start', 'click');
      await page.waitForFunction(() => TLV.debug.state().phase === 'CARD');
    });
  });

  await scenario('title: notitle and bots leave the sim default alone', async () => {
    const init = () => {
      window.__calls = 0;
      const wait = setInterval(() => {
        if (window.TLV && TLV.game) {
          clearInterval(wait);
          TLV.game.setDifficulty = () => { window.__calls++; };
        }
      }, 0);
    };
    await withGame('?seed=1&notitle=1&mute=1', { init }, async (page) => {
      await lib.frames(page, 5);
      assert.strictEqual(await page.evaluate(() => window.__calls), 0);
    });
    await withGame('?seed=1&autoplay=patrol&mute=1', { init }, async (page) => {
      await lib.frames(page, 5);
      assert.strictEqual(await page.evaluate(() => window.__calls), 0);
    });
  });

  await scenario('lang=he renders right to left, with the Hebrew street name', async () => {
    await withGame('?seed=1&notitle=1&mute=1&lang=he', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await lib.frames(page, 3);
      const dir = await page.evaluate(() => {
        const root = document.getElementById('ui-root');
        const money = document.querySelector('.hud-chain-bank').parentNode.parentNode.getBoundingClientRect();
        const hp = document.querySelector('.hud-hp').getBoundingClientRect();
        const map = document.querySelector('.hud-map').getBoundingClientRect();
        const street = document.querySelector('.hud-street').getBoundingClientRect();
        const chip = getComputedStyle(document.querySelector('.hud-chip-text'));
        return {
          attr: root.dir, lang: root.lang, css: getComputedStyle(root).direction, chipDir: chip.direction,
          moneyRight: money.right, hpLeft: hp.left, mapLeft: map.left, streetLeft: street.left
        };
      });
      assert.strictEqual(dir.attr, 'rtl');
      assert.strictEqual(dir.lang, 'he');
      assert.strictEqual(dir.css, 'rtl');
      assert.strictEqual(dir.chipDir, 'rtl');
      // The corners hold still, because the rear-view strip stands at the top right in both languages.
      assert.ok(dir.moneyRight < 1000, `money clear of the strip ${dir.moneyRight}`);
      assert.ok(dir.hpLeft > 900, 'No-Claims stays top right');
      assert.ok(dir.mapLeft < 100, 'minimap stays bottom left');
      assert.ok(dir.streetLeft >= 0, 'street name stays on screen');
      assert.match(await text(page, '.hud-street'), /[\u0590-\u05FF]/);
      assert.match(await text(page, '.hud-chip-text'), /[\u0590-\u05FF]/);
      assert.strictEqual(await text(page, '.hud-hp-label'), 'היעדר תביעות');
      await shot(page, 'he_drive');
    });
  });

  await scenario('L switches language on the title, and an explicit lang= still wins', async () => {
    await withGame('?seed=1', {}, async (page) => {
      await lib.frames(page, 3);
      await page.keyboard.press('KeyL');
      await lib.frames(page, 3);
      assert.strictEqual((await state(page)).phase, 'TITLE');
      assert.strictEqual(await page.evaluate(() => document.getElementById('ui-root').dir), 'rtl');
      assert.strictEqual(await text(page, '.title-name'), 'סידורים');
      await page.reload();
      await page.waitForFunction(() => window.TLV && TLV.app && TLV.app.S && document.querySelector('.title-name'), null, { timeout: 180000 });
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.title-name'), 'סידורים', 'remembered');
      await page.goto(page.url() + '?seed=1&lang=en');
      await page.waitForFunction(() => window.TLV && TLV.app && TLV.app.S && document.querySelector('.title-name'), null, { timeout: 180000 });
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.title-name'), 'SIDURIM');
    });
  });

  await scenario('all HUD elements are present and inside the screen in DRIVE', async () => {
    await withGame('?seed=1&notitle=1&mute=1', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await step(page, 30);
      await page.evaluate(() => {
        TLV.debug.setMoney(1240);
        const g = TLV.app.S.game;
        g.chain.n = 3;
        g.chain.mult = 2;
        g.chain.windowT = 3;
        g.chain.bank = 60;
      });
      await lib.frames(page, 3);
      for (const sel of ['.hud-clock', '.hud-chip', '.hud-arrow', '.hud-money', '.hud-chain', '.hud-hp', '.hud-speed', '.hud-street', '.minimap']) {
        assert.ok(await shown(page, sel), sel);
        const box = await page.evaluate((s) => {
          const r = document.querySelector(s).getBoundingClientRect();
          return { l: r.left, t: r.top, r: r.right, b: r.bottom };
        }, sel);
        assert.ok(box.l >= 0 && box.t >= 0 && box.r <= 1280 && box.b <= 720, `${sel} ${JSON.stringify(box)}`);
      }
      assert.strictEqual(await text(page, '.hud-money-digits'), '₪1,240');
      assert.match(await text(page, '.hud-clock-digits'), /^\d:\d\d$/);
      assert.strictEqual(await text(page, '.hud-street'), 'HaMelekh George');
      assert.strictEqual(await text(page, '.hud-chain-mult'), 'x2.0');
      assert.match(await text(page, '.hud-chip-text'), /Milk/);
      assert.match(await text(page, '.hud-arrow-dist'), /^bay \d+ m$/);
      assert.ok(!/\d+ m\b/.test(await text(page, '.hud-chip')), 'one number for the road left: the arrow has it');
      await shot(page, 'drive');
    });
  });

  await scenario('arrow follows arrowH relative to the view', async () => {
    await withGame('?seed=1&notitle=1&mute=1', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await lib.frames(page, 2);
      const read = () => page.evaluate(() => {
        const m = document.querySelector('.hud-arrow-plane').style.transform.match(/rotateZ\((-?[\d.]+)rad\)/);
        const S = TLV.app.S;
        return { css: Number(m[1]), arrowH: S.game.nav.arrowH, yaw: TLV.ui.viewYaw(S) };
      });
      const a = await read();
      const want = -TLV_wrap(a.arrowH - a.yaw);
      assert.ok(Math.abs(a.css - want) < 0.01, JSON.stringify(a));
    });
  });

  await scenario('minimap draws the route and the player, in the right orientation', async () => {
    await withGame('?seed=1&notitle=1&mute=1', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await lib.frames(page, 3);
      const check = () => page.evaluate(() => {
        const S = TLV.app.S;
        const c = TLV.ui.minimap._canvas();
        const g = c.getContext('2d');
        const yaw = TLV.ui.viewYaw(S);
        const half = c.width / 2;
        const speed = Math.abs(S.vehicles[0].v);
        const T = TLV.tune.ui;
        const radius = T.mapRadiusSlowM + (T.mapRadiusFastM - T.mapRadiusSlowM) * Math.min(1, speed / T.mapZoomSpeed);
        const scale = half / radius;
        const route = S.game.nav.route;
        const veh = S.vehicles[0];
        const out = { x: 0, y: 0 };
        let hits = 0;
        let tried = 0;
        const isRoute = (d) => d[0] > 230 && d[1] > 190 && d[1] < 235 && d[2] < 90;
        for (let i = 0; i < route.px.length; i += 8) {
          if (route.cum[i] - S.game.nav.s < 40 || route.cum[i] - S.game.nav.s > 140) continue;
          TLV.ui.minimap.place(route.px[i] - veh.x, route.py[i] - veh.y, yaw, scale, out);
          const x = Math.round(half + out.x);
          const y = Math.round(half + out.y);
          if (Math.abs(out.x) > half - 24 || Math.abs(out.y) > half - 24) continue;
          tried++;
          if (isRoute(g.getImageData(x, y, 1, 1).data)) hits++;
        }
        // The mirror image of the route must not be route colour, or the check proves nothing about left and right.
        let mirror = 0;
        let mirrorTried = 0;
        for (let i = 0; i < route.px.length; i += 8) {
          if (route.cum[i] - S.game.nav.s < 40 || route.cum[i] - S.game.nav.s > 140) continue;
          TLV.ui.minimap.place(route.px[i] - veh.x, route.py[i] - veh.y, yaw, scale, out);
          if (Math.abs(out.x) < 20 || Math.abs(out.x) > half - 24 || Math.abs(out.y) > half - 24) continue;
          mirrorTried++;
          if (isRoute(g.getImageData(Math.round(half - out.x), Math.round(half + out.y), 1, 1).data)) mirror++;
        }
        const me = g.getImageData(half, half, 1, 1).data;
        return { hits, tried, mirror, mirrorTried, me: [me[0], me[1], me[2]], yaw };
      });
      const a = await check();
      assert.ok(a.tried > 3 && a.hits / a.tried > 0.9, `route on canvas ${JSON.stringify(a)}`);
      assert.ok(a.mirrorTried === 0 || a.mirror / a.mirrorTried < 0.3, `mirror ${JSON.stringify(a)}`);
      assert.ok(a.me[0] > 200 && a.me[1] < 120, `player mark ${JSON.stringify(a)}`);

      // Turn the car a quarter turn on the spot: the same route must still land where place() says.
      const before = await state(page);
      await page.evaluate((s) => TLV.debug.teleport(s.player.x, s.player.y, s.player.h + Math.PI / 2, 0), before);
      await step(page, 1);
      // The real camera swings round on a spring, and the minimap follows the camera, so wait for it to arrive.
      for (let i = 0; i < 60; i++) {
        await lib.frames(page, 2);
        const yaw = await page.evaluate(() => TLV.ui.viewYaw(TLV.app.S));
        if (Math.abs(TLV_wrap(yaw - a.yaw - Math.PI / 2)) < 0.05) break;
      }
      await lib.frames(page, 2);
      const b = await check();
      assert.ok(Math.abs(TLV_wrap(b.yaw - a.yaw - Math.PI / 2)) < 0.05, `view turned ${JSON.stringify([a.yaw, b.yaw])}`);
      assert.ok(b.tried > 3 && b.hits / b.tried > 0.9, `after turn ${JSON.stringify(b)}`);
      await shot(page, 'minimap_turned');
    });
  });

  await scenario('pause: Esc stops the sim and shows the screen with attribution, and M mutes', async () => {
    await withGame('?seed=1&notitle=1', {}, async (page) => {
      await lib.frames(page, 2);
      await page.waitForFunction(() => TLV.debug.state().phase === 'CARD' || TLV.debug.state().phase === 'DRIVE');
      await lib.press(page, 'Escape');
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.scr-pause'));
      const t0 = (await state(page)).tick;
      await lib.frames(page, 6);
      assert.strictEqual((await state(page)).tick, t0, 'ticks stop');
      assert.ok((await text(page, '.scr-pause')).includes('© OpenStreetMap contributors'));
      assert.ok((await text(page, '.pause-mute')).includes('Sound on'));
      await lib.press(page, 'KeyM');
      await lib.frames(page, 3);
      assert.ok((await text(page, '.pause-mute')).includes('Sound off'));
      assert.strictEqual(await page.evaluate(() => TLV.audio.isMuted()), true);
      await shot(page, 'pause');
      await lib.press(page, 'KeyM');
      await lib.press(page, 'KeyP');
      await lib.frames(page, 3);
      assert.ok(!(await shown(page, '.scr-pause')));
      await page.waitForFunction((tick) => TLV.debug.state().tick > tick, t0);
    });
  });

  await scenario('audio: silent until a gesture, one context after, nothing played under mute', async () => {
    const init = () => {
      window.__ctx = 0;
      const Real = window.AudioContext;
      window.AudioContext = function () {
        window.__ctx++;
        return new Real();
      };
    };
    await withGame('?seed=1', { init }, async (page) => {
      await lib.frames(page, 6);
      assert.strictEqual(await page.evaluate(() => window.__ctx), 0, 'no context before a gesture');
      assert.strictEqual((await page.evaluate(() => TLV.audio.info())).unlocked, false);
      await page.keyboard.down('Enter');
      await page.waitForFunction(() => TLV.debug.state().phase !== 'TITLE');
      await page.keyboard.up('Enter');
      await lib.frames(page, 4);
      assert.strictEqual(await page.evaluate(() => window.__ctx), 1);
      const info = await page.evaluate(() => TLV.audio.info());
      assert.strictEqual(info.unlocked, true);
      assert.ok(info.started > 0, 'one-shots started');
      assert.ok(info.masterGain > 0.5);
    });
    await withGame('?seed=1&mute=1', { init }, async (page) => {
      await lib.frames(page, 3);
      await page.keyboard.down('Enter');
      await page.waitForFunction(() => TLV.debug.state().phase !== 'TITLE');
      await page.keyboard.up('Enter');
      await lib.frames(page, 4);
      const info = await page.evaluate(() => TLV.audio.info());
      assert.strictEqual(info.muted, true);
      assert.strictEqual(info.masterGain, 0);
    });
  });

  await scenario('audio: the horn recordings decode, and a honk plays them instead of the synthesizer', async () => {
    await withGame('?seed=1&notitle=1', {}, async (page) => {
      await page.keyboard.press('Shift');
      await page.waitForFunction(() => TLV.audio.info().samples.length === TLV.soundIndex.ids.length, null, { timeout: 30000 });
      const ids = await page.evaluate(() => TLV.audio.info().samples);
      for (const id of ['car_a', 'car_b', 'car_hold', 'bus_toot', 'bus_double', 'bus_triple', 'bus_long']) assert.ok(ids.includes(id), id);
      assert.strictEqual(await page.evaluate(() => TLV.sounds), null, 'the base64 is let go once decoded');
      const started = await page.evaluate(() => {
        const S = TLV.app.S;
        const before = TLV.audio.info().started;
        TLV.ui.dispatch('traffic.honk', { vehId: 7, atPlayer: false, x: S.player.fx + 20, y: S.player.fy });
        const near = TLV.audio.info().started - before;
        TLV.ui.dispatch('traffic.redRun', { vehId: 7, juncId: 1, x: S.player.fx + 5000, y: S.player.fy });
        TLV.ui.dispatch('traffic.door', { vehId: 7, open: true, x: S.player.fx + 5000, y: S.player.fy });
        return { near, far: TLV.audio.info().started - before - near };
      });
      assert.ok(started.near >= 1, 'a honk plays');
      assert.strictEqual(started.far, 0, 'a red run and a door far away are not heard');
    });
  });

  await scenario('radio: off in a driven browser, and with ?radio=on it tunes, skips the dead, changes, stops and comes back live', async () => {
    // A stand-in for the <audio> element: it plays any address but one, which errors, as a dead station does.
    const init = () => {
      window.__radio = [];
      window.Audio = function () {
        const el = document.createElement('div');
        el.volume = 1;
        el.paused = true;
        el.play = function () {
          const src = el.getAttribute('src') || el.src;
          window.__radio.push(src);
          el.paused = false;
          setTimeout(() => el.dispatchEvent(new Event(/dead\.example/.test(src) ? 'error' : 'playing')), 30);
          return Promise.resolve();
        };
        el.pause = function () { el.paused = true; };
        el.load = function () {};
        return el;
      };
    };
    const directory = [
      { name: 'Dead FM', url_resolved: 'https://dead.example/stream', codec: 'MP3', hls: 0, lastcheckok: 1 },
      { name: 'Live FM', url_resolved: 'https://live.example/stream', codec: 'AAC', hls: 0, lastcheckok: 1 },
      { name: 'Plain HTTP', url_resolved: 'http://insecure.example/stream', codec: 'MP3', hls: 0, lastcheckok: 1 },
      { name: 'HLS', url_resolved: 'https://hls.example/live.m3u8', codec: 'AAC', hls: 1, lastcheckok: 1 }
    ];
    const routes = (page) => page.route(/radio-browser\.info/, (r) => r.fulfill({ contentType: 'application/json', body: JSON.stringify(directory) }));
    await withGame('?seed=1', { init, routes }, async (page) => {
      await page.keyboard.press('Shift');
      await lib.frames(page, 4);
      const off = await page.evaluate(() => TLV.audio.radioInfo());
      assert.strictEqual(off.allowed, false, 'navigator.webdriver keeps it off on auto');
      assert.deepStrictEqual(await page.evaluate(() => window.__radio), []);
    });
    await withGame('?seed=1&radio=on', { init, routes }, async (page) => {
      // The last station of the list each time: the built-in list's last before the directory answers.
      await page.evaluate(() => {
        Math.random = () => 0.999;
      });
      await page.keyboard.press('Shift');
      await page.waitForFunction(() => TLV.audio.radioInfo().state === 'playing');
      await page.waitForFunction(() => TLV.audio.radioInfo().stations === 18);
      let info = await page.evaluate(() => TLV.audio.radioInfo());
      assert.strictEqual(info.station, 'Kol Chai');
      assert.ok(info.volume >= 0 && info.volume <= 1);
      await page.keyboard.press('Enter');
      await page.waitForFunction(() => TLV.debug.state().phase !== 'TITLE');
      // Only the two HTTPS, non-HLS stations joined the built-in sixteen. Of the seventeen left to try, Dead FM is the sixteenth:
      // N lands on it, it fails, and the radio moves on by itself.
      await page.evaluate(() => {
        Math.random = () => 0.9;
      });
      await page.keyboard.press('KeyN');
      await page.waitForFunction(() => window.__radio.some((u) => /dead\.example/.test(u)));
      await page.waitForFunction(() => TLV.audio.radioInfo().state === 'playing' && TLV.audio.radioInfo().station !== 'Dead FM');
      info = await page.evaluate(() => TLV.audio.radioInfo());
      assert.notStrictEqual(info.station, 'Kol Chai');
      await page.waitForFunction(() => TLV.ui.hud._view().toasts.some((t) => /On the radio/.test(t.text)));
      await page.keyboard.press('KeyB');
      await lib.frames(page, 2);
      assert.strictEqual(await page.evaluate(() => TLV.audio.radioInfo().state), 'off');
      assert.strictEqual(await page.evaluate(() => localStorage.getItem('sidurim.radio')), '0');
      await page.keyboard.press('KeyB');
      await page.waitForFunction(() => TLV.audio.radioInfo().state === 'playing');
      await page.keyboard.press('KeyM');
      await lib.frames(page, 2);
      assert.strictEqual(await page.evaluate(() => TLV.audio.radioInfo().state), 'off', 'mute stops it');
      await page.keyboard.press('KeyM');
      await page.waitForFunction(() => TLV.audio.radioInfo().state === 'playing');
      const before = await page.evaluate(() => window.__radio.length);
      await page.keyboard.press('Escape');
      await lib.frames(page, 2);
      assert.strictEqual(await page.evaluate(() => TLV.audio.radioInfo().state), 'off', 'pause stops it');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => TLV.audio.radioInfo().state === 'playing');
      assert.ok(await page.evaluate((n) => window.__radio.length > n, before), 'it comes back by playing again, from the live edge');
      const urls = await page.evaluate(() => window.__radio);
      assert.ok(urls.every((u) => /^https:\/\//.test(u)), urls.join());
      assert.ok(!urls.some((u) => /insecure|m3u8/.test(u)));
    });
  });

  await scenario('all five end screens through TLV.debug.ui', async () => {
    await withGame('?seed=1&notitle=1&mute=1', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      const names = await page.evaluate(() => TLV.debug.ui('list'));
      assert.ok(names.length >= 20);
      for (const r of ['CLOCK', 'TOWED', 'CAUGHT', 'REVOKED', 'WIN']) {
        assert.strictEqual(await page.evaluate((n) => TLV.debug.ui(n, true), `end.${r}`), true);
        await lib.frames(page, 3);
        assert.ok(await shown(page, '.scr-end'), r);
        const title = await text(page, '.licence-title');
        assert.strictEqual(title, { CLOCK: 'OUT OF TIME', TOWED: 'TOWED', CAUGHT: 'CAUGHT', REVOKED: 'LICENCE REVOKED', WIN: 'SEVEN FOR SEVEN' }[r]);
        await shot(page, `end_forced_${r}`);
        await page.evaluate((n) => TLV.debug.ui(n, false), `end.${r}`);
        await lib.frames(page, 2);
        assert.ok(!(await shown(page, '.scr-end')), `${r} clears`);
      }
      assert.strictEqual(await page.evaluate(() => TLV.debug.ui('nonsense', true)), false);
    });
  });

  await scenario('all five end screens by real end conditions, with rank and tally, and restart', async () => {
    const real = {
      CLOCK: async (page) => { await page.evaluate(() => TLV.debug.setClock(0.02)); await step(page, 3); },
      TOWED: async (page) => { await page.evaluate(() => TLV.debug.setHP(0)); await step(page, 2); },
      REVOKED: async (page) => { await page.evaluate(() => { TLV.app.S.game.pedHits = 2; }); await step(page, 2); },
      CAUGHT: async (page) => {
        await page.evaluate(() => { TLV.debug.setErrand(1); TLV.debug.forceKnife({ stage: 'CHASE', gap: 12 }); });
        await step(page, 1);
        await page.evaluate(() => TLV.debug.setStrikes(3));
        await step(page, 3);
      },
      WIN: async (page) => {
        await page.evaluate(() => TLV.debug.startRun({ errandIndex: 6 }));
        await step(page, 1);
        await toPhase(page, 'DRIVE');
        await page.evaluate(() => TLV.debug.parkNow({ quality: 'GOOD' }));
        for (let i = 0; i < 40 && (await state(page)).phase !== 'RUN_END'; i++) await step(page, 30);
      }
    };
    await withGame('?seed=3&notitle=1&mute=1&contest=off&knife=force', {}, async (page) => {
      await held(page);
      for (const reason of ['CLOCK', 'TOWED', 'REVOKED', 'CAUGHT', 'WIN']) {
        await page.evaluate(() => TLV.debug.startRun({}));
        await step(page, 1);
        await toPhase(page, 'DRIVE');
        await page.evaluate(() => TLV.debug.setMoney(900));
        await real[reason](page);
        const s = await state(page);
        assert.strictEqual(s.phase, 'RUN_END', reason);
        assert.strictEqual(s.endReason, reason);
        await lib.frames(page, 3);
        assert.ok(await shown(page, '.scr-end'), reason);
        assert.ok(!(await shown(page, '.hud')), `${reason} hides the HUD`);
        // Owner's rule, BRIEF: no rank or score for running anyone over. The revoked scenario below checks that card in full.
        if (reason === 'REVOKED') assert.ok(!(await shown(page, '.licence-rank-value')), 'no rank on a revoked licence');
        else assert.ok((await text(page, '.licence-rank-value')).length > 2, 'rank');
        assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.tally').length), 5);
        await shot(page, `end_real_${reason}`);
      }
      await page.evaluate(() => TLV.debug.resume());
      await page.keyboard.down('Enter');
      await page.waitForFunction(() => TLV.debug.state().phase === 'CARD');
      await page.keyboard.up('Enter');
      await lib.frames(page, 2);
      assert.ok(!(await shown(page, '.scr-end')), 'restart clears the card');
      assert.ok(await shown(page, '.phone'));
    });
  });

  await scenario('high score is kept, and storage is only a convenience', async () => {
    await withGame('?seed=1&notitle=1&mute=1', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await page.evaluate(() => { TLV.debug.setMoney(1500); TLV.debug.setClock(0.01); });
      await step(page, 2);
      await lib.frames(page, 3);
      assert.strictEqual(await page.evaluate(() => localStorage.getItem('sidurim.best')), '1500');
      assert.strictEqual(await text(page, '.licence-best'), 'NEW BEST DAY');
    });
  });

  await scenario('first-minute prompts fire in order on errand 1', async () => {
    await withGame('?seed=1&notitle=1&mute=1&traffic=0&peds=0&incidents=0&contest=off', {}, async (page) => {
      await held(page);
      const prompt = () => text(page, '.hud-prompt');
      assert.ok(['CARD'].includes((await state(page)).phase));
      await lib.frames(page, 2);
      assert.match(await prompt(), /W.*GO/);
      await toPhase(page, 'DRIVE');
      await lib.frames(page, 2);
      assert.match(await prompt(), /GREEN/, 'launch prompt at green');
      assert.strictEqual(await page.evaluate(() => TLV.ui.hud._view().seen['prompt.launch']), true);
      await page.evaluate(() => TLV.debug.resume());
      await page.evaluate(() => TLV.debug.pause());
      // Drives the route by hand: places the car along it. Beats fire on route distance.
      const along = (m) => page.evaluate((d) => {
        const S = TLV.app.S;
        const r = S.game.nav.route;
        let i = 0;
        while (i < r.px.length - 2 && r.cum[i] < d) i++;
        TLV.debug.teleport(r.px[i], r.py[i], Math.atan2(r.py[i + 1] - r.py[i], r.px[i + 1] - r.px[i]), 3);
      }, m);
      await along(26);
      await step(page, 3);
      await page.evaluate(() => { TLV.ui.hud._view().prompt.t = 0; });
      await lib.frames(page, 2);
      await step(page, 3);
      await lib.frames(page, 2);
      assert.strictEqual(await page.evaluate(() => TLV.ui.hud._view().seen['prompt.handbrake']), true, 'handbrake beat');
      assert.match(await prompt(), /HANDBRAKE/);
      await page.evaluate(() => { TLV.ui.hud._view().prompt.t = 0; });
      const len = await page.evaluate(() => TLV.app.S.game.nav.route.len);
      await along(len - 100);
      await step(page, 4);
      await lib.frames(page, 2);
      assert.strictEqual((await state(page)).phase, 'SEARCH');
      assert.ok(!(await shown(page, '.hud-prompt')), 'no SEARCH line 100 m out');
      await along(len - 50);
      await step(page, 1);
      await lib.frames(page, 2);
      assert.strictEqual(await prompt(), 'SLOW BELOW 25 KM/H, NOSE INTO THE BOX');
      await page.evaluate(() => { TLV.app.S.vehicles[0].v = 12; });
      await lib.frames(page, 3);
      assert.strictEqual(await page.evaluate(() => document.querySelector('.hud-prompt').classList.contains('flash')), true, 'flashes over speed');
      await shot(page, 'prompt_search_flash');
      await page.evaluate(() => { TLV.app.S.vehicles[0].v = 4; });
      await lib.frames(page, 3);
      assert.strictEqual(await page.evaluate(() => document.querySelector('.hud-prompt').classList.contains('flash')), false);
    });
  });

  await scenario('the SEARCH line shows on a moving car in the last 60 m, on errands 1, 2 and 3', async () => {
    await withGame('?seed=1&notitle=1&mute=1&traffic=0&peds=0&incidents=0&contest=off', {}, async (page) => {
      await held(page);
      for (const index of [0, 1, 2]) {
        await page.evaluate((n) => TLV.debug.startRun({ errandIndex: n }), index);
        await step(page, 1);
        for (let i = 0; i < 40 && !['DRIVE', 'SEARCH'].includes((await state(page)).phase); i++) await step(page, 30);
        await lib.frames(page, 2);
        await page.evaluate(() => { TLV.ui.hud._view().prompt.t = 0; });
        const len = await page.evaluate(() => TLV.app.S.game.nav.route.len);
        const cases = [[Math.min(130, len * 0.9), 11, false], [62, 11, false], [58, 11, true], [58, 0, false], [30, 3, true], [30, 0, false]];
        for (const [left, v, want] of cases) {
          await toBay(page, left, v);
          await step(page, 1);
          await lib.frames(page, 2);
          const s = await page.evaluate(() => ({ phase: TLV.app.S.game.phase, left: TLV.app.S.game.nav.remaining, v: TLV.app.S.vehicles[0].v }));
          const on = await shown(page, '.hud-prompt') && (await text(page, '.hud-prompt')).startsWith('SLOW BELOW');
          assert.strictEqual(on, want, `errand ${index + 1}, ${JSON.stringify(s)}`);
        }
      }
    });
  });

  await scenario('a missed bay says what to do, in both languages', async () => {
    for (const [lang, q, back] of [['en', /^MISSED IT\. S BACK UP, OR HOLD Q: PARK BADLY$/, /^MISSED IT\. S BACK UP$/], ['he', /^פספסת\. S רוורס, או להחזיק Q ולחנות על הפנים$/, /^פספסת\. S רוורס$/]]) {
      await withGame(`?seed=1&notitle=1&mute=1&traffic=0&peds=0&incidents=0&contest=off&lang=${lang}`, {}, async (page) => {
        await held(page);
        await toPhase(page, 'DRIVE');
        await toBay(page, 30, 3);
        await step(page, 1);
        await page.evaluate(() => { TLV.ui.hud._view().prompt.t = 0; });
        await toBay(page, -14, 0);
        await step(page, 2);
        await lib.frames(page, 3);
        const nav = await page.evaluate(() => ({ missed: TLV.app.S.game.nav.missed, v: TLV.app.S.vehicles[0].v, phase: TLV.app.S.game.phase }));
        assert.strictEqual(nav.missed, 'BACK_OR_Q', JSON.stringify(nav));
        assert.match(await text(page, '.hud-prompt'), q);
        await settled(page);
        await shot(page, `missed_${lang}`);
        await page.evaluate(() => { TLV.app.S.game.nav.missed = 'BACK'; });
        await lib.frames(page, 2);
        assert.match(await text(page, '.hud-prompt'), back);
        await page.evaluate(() => { TLV.app.S.game.nav.missed = null; });
        await lib.frames(page, 2);
        assert.ok(!(await shown(page, '.hud-prompt')), 'a stopped car past the bay, not missed: nothing to say');
      });
    }
  });

  await scenario('the tow is offered only to a car pressing against something', async () => {
    await withGame('?seed=1&notitle=1&mute=1&traffic=0&peds=0&incidents=0&contest=off', {}, async (page) => {
      await page.waitForFunction(() => TLV.debug.state().phase === 'DRIVE');
      await page.evaluate(() => {
        TLV.world.signals.laneState = () => TLV.const.SIG.GREEN;
        TLV.tune.ui.drivePromptMaxS = 0;
        const v = TLV.ui.hud._view();
        v.prompt.t = 0;
        v.seen['prompt.drive'] = true;
        v.driveDue = false;
      });
      await toBay(page, 200, 0);
      // Twice the wait of the real offer, with hands off the keys, on an open road.
      const wait = await page.evaluate(() => TLV.tune.ui.stuckPromptS);
      await page.evaluate((seconds) => new Promise((done) => {
        let t0 = null;
        let last = null;
        let sum = 0;
        const check = (now) => {
          if (t0 === null) t0 = now;
          if (last !== null) sum += Math.min(0.25, (now - last) / 1000);
          last = now;
          window.__sawTow = window.__sawTow || /TOW/.test(document.querySelector('.hud-prompt').textContent) && !document.querySelector('.hud-prompt').classList.contains('off');
          if (sum >= seconds) done();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }), wait * 2);
      assert.ok(!(await page.evaluate(() => window.__sawTow)), 'no offer for a car that has simply not moved');

      // The same car, now held still against something with the throttle down.
      await page.evaluate(() => {
        TLV.player.setLocked(TLV.app.S, true);
        TLV.debug.setInput({ throttle: 1 });
      });
      await page.waitForFunction(() => {
        const n = document.querySelector('.hud-prompt');
        return !n.classList.contains('off') && /TOW/.test(n.textContent);
      });
      await page.evaluate(() => TLV.debug.setInput({ throttle: 0, brake: 0 }));
      await page.waitForFunction(() => {
        const n = document.querySelector('.hud-prompt');
        return n.classList.contains('off') || !/TOW/.test(n.textContent);
      });
      assert.strictEqual(await page.evaluate(() => TLV.ui.hud._view().stuckT), 0, 'letting go ends the attempt');
      await page.evaluate(() => {
        TLV.player.setLocked(TLV.app.S, false);
        TLV.debug.setInput(null);
      });
    });
  });

  await scenario('parking view: at a 4.5 m look-ahead the words stay off the car and the box, at 1280x720 and 1920x1080', async () => {
    for (const [width, height] of [[1280, 720], [1920, 1080]]) {
      const opts = { routes: cameraWith({ parkAhead: 4.5 }), viewport: { width, height } };
      await withGame('?seed=1&notitle=1&mute=1&traffic=0&peds=0&incidents=0&contest=off', opts, async (page) => {
        await held(page);
        await toPhase(page, 'DRIVE');
        const check = async (label) => {
          await plantWords(page);
          await lib.frames(page, 3);
          const { words, car, world } = await wordsOffCar(page, label, { width, height });
          const box = hull(world.box);
          const fixed = [...(await boxes(page, '.hud-map')), ...(await boxes(page, '.hud-speed'))];
          for (const w of words) {
            assert.ok(!touchesShape(w, box), `${label} on the box ${JSON.stringify({ w, box })}`);
            for (const f of fixed) assert.ok(!meets(w, f), `${label} on the map or speed ${JSON.stringify({ w, f })}`);
          }
          return { car, box };
        };
        // Only a fast car brings the rig in this far out. The others are taken slowly.
        for (const [left, v] of [[RIG_M - 1, 11], [8, 2], [0, 2], [-9, 2]]) {
          await toBay(page, left, v);
          await step(page, 1);
          const cam = await settled(page);
          assert.strictEqual(cam.rig, true, `parking rig at ${left} m`);
          await check(`${width}x${height} at ${left} m`);
          await shot(page, `park45_${width}_${String(left).replace('-', 'past')}`);
        }
        // Turned round so the box comes down the other side of the car: the words must change sides with it.
        const sides = new Set();
        for (const turn of [2.2, -2.2]) {
          await toBay(page, 2, 0, turn);
          await step(page, 1);
          await settled(page);
          await check(`${width}x${height} turned ${turn}`);
          await shot(page, `park45_${width}_turned${turn > 0 ? 'L' : 'R'}`);
          sides.add(await page.evaluate(() => document.querySelector('.hud-prompt').classList.contains('side-right')));
        }
        assert.strictEqual(sides.size, 2, 'both sides were used');
        // The capture bar joins the prompt, with the car in the box.
        await page.evaluate(() => {
          const g = TLV.app.S.game;
          const sp = TLV.world.parking.spot(TLV.app.S.world, g.errand.bayId);
          TLV.debug.teleport(sp.x, sp.y, sp.h, 0);
          g.phase = 'HOLD';
          g.park.stage = 'FILL';
          g.park.kind = 'BAY';
          g.park.bar = 0.6;
          g.park.x = sp.x;
          g.park.y = sp.y;
          g.park.h = sp.h;
        });
        await settled(page);
        await page.evaluate(() => { TLV.ui.hud._view().prompt.t = 0; });
        await lib.frames(page, 2);
        const inBay = await worldBoxes(page);
        const held2 = [...(await boxes(page, '.hud-prompt')), ...(await boxes(page, '.hud-parkbar'))];
        assert.strictEqual(held2.length, 2);
        for (const w of held2) {
          assert.ok(!touchesShape(w, hull(inBay.car)) && !touchesShape(w, hull(inBay.box)), JSON.stringify({ w, inBay }));
        }
        await shot(page, `park45_${width}_hold`);
        await page.evaluate(() => { const g = TLV.app.S.game; g.phase = 'SEARCH'; g.park.stage = null; g.park.kind = null; g.park.bar = 0; });
      });
    }
  });

  await scenario('parking view: at the shipped camera the words stay off the real car, before, while and after the rig comes in', async () => {
    const size = { width: 1280, height: 720 };
    const sides = new Set();
    // Three streets. Seed 2's second errand arrives round a bend with the bay left of the car's line, so the words start on the right.
    for (const [seed, errand] of [[1, 0], [2, 1], [2, 2]]) {
      await withGame(`?seed=${seed}&notitle=1&mute=1&traffic=0&peds=0&incidents=0&contest=off`, {}, async (page) => {
        assert.strictEqual(await page.evaluate(() => !!window.__standIn), false, 'the real renderer and the real car');
        await held(page);
        await page.evaluate((k) => TLV.debug.startRun({ errandIndex: k }), errand);
        await step(page, 1);
        await toPhase(page, 'DRIVE');
        // The rig comes in at RIG_M for a fast car and nearer for a slow one, so each one creeps in until it does. The chase view holds
        // this ground now, in SEARCH with the camera raised, and the blend swings the car across the frame between the two layouts.
        for (const v of [11, 2]) {
          await toBay(page, 34, v);
          await step(page, 1);
          assert.strictEqual((await settled(page)).rig, false, `seed ${seed}: chase rig out at 34 m`);
          await plantWords(page);
          const trace = rigTrace(page);
          let entry = null;
          for (let left = RIG_M + 3; left > 0 && entry === null; left -= 1) {
            await toBay(page, left, v);
            await step(page, 1);
            await plantWords(page);
            await lib.frames(page, 3);
            if (await page.evaluate(() => TLV.ui.parkingView())) entry = left;
            else await wordsOffCar(page, `seed ${seed} chase at ${v} m/s, ${left} m`, size);
          }
          assert.ok(entry !== null, `seed ${seed}: the rig came in at ${v} m/s`);
          assert.ok(entry < RIG_M, `seed ${seed}: not before ${RIG_M} m, came in at ${entry} m`);
          const frames = await trace;
          assert.ok(frames.length >= 3 && frames[frames.length - 1].blendT >= 1, `seed ${seed}: the blend was seen, ${frames.length} frames`);
          for (const f of frames) {
            const car = hull(f.car);
            assert.ok(f.words.length >= 4, `seed ${seed} blend ${f.blendT.toFixed(2)} ${JSON.stringify(f.words)}`);
            for (const w of f.words) assert.ok(!touchesShape(w, car), `seed ${seed} blend ${f.blendT.toFixed(2)} on the car ${JSON.stringify({ w, car })}`);
          }
          await shot(page, `rig_${seed}_${errand}_v${v}_entry`);
          sides.add(await page.evaluate(() => document.querySelector('.hud-prompt').classList.contains('side-right')));
          console.log(`      seed ${seed} at ${v} m/s: rig at ${entry} m, ${frames.length} blend frames seen`);
        }
        for (const left of [8, 3, 0, -6]) {
          await toBay(page, left, 2);
          await step(page, 1);
          assert.strictEqual((await settled(page)).rig, true, `seed ${seed}: parking rig at ${left} m`);
          await plantWords(page);
          await lib.frames(page, 3);
          await wordsOffCar(page, `seed ${seed} at ${left} m`, size);
          await shot(page, `rig_${seed}_${errand}_at_${String(left).replace('-', 'past')}`);
        }
      });
    }
    assert.strictEqual(sides.size, 2, 'the words stood on both sides, each away from its bay');
  });

  await scenario('chase view: toasts stand under the car, pops left of it, and the prompt stays clear', async () => {
    await withGame('?seed=1&notitle=1&mute=1&traffic=0&peds=0&incidents=0&contest=off', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await toBay(page, 200, 0);
      await step(page, 1);
      await settled(page);
      await page.evaluate(() => {
        const v = TLV.ui.hud._view();
        v.prompt.key = 'prompt.launch';
        v.prompt.t = 99;
        ['Recalculating. Disappointed.', 'SOMEONE ELSE WANTS YOUR SPOT', 'TOW -₪500. The tow truck was suspiciously close.'].forEach((x) => TLV.ui.hud.toast(x, 'warn'));
        TLV.game.score.bonus(TLV.app.S, 'BEAT_THE_HONK', 25, 0);
        TLV.ui.dispatch('player.nearMiss', { vehId: 1, gap: 0.8, relSpeed: 7, tier: 2, x: 0, y: 0 });
      });
      await lib.frames(page, 4);
      await page.waitForTimeout(400);
      const car = hull((await worldBoxes(page)).car);
      const toasts = await boxes(page, '.toast');
      const pops = await boxes(page, '.pop');
      const prompt = await boxes(page, '.hud-prompt');
      assert.strictEqual(toasts.length, 3);
      assert.ok(pops.length >= 2);
      await page.screenshot({ path: path.join(SHOTS, 'chase_pops.png'), timeout: 240000 });
      for (const w of [...toasts, ...prompt, ...pops]) assert.ok(!touchesShape(w, car), JSON.stringify({ w, car }));
      for (const w of toasts) {
        assert.ok(!meets(w, prompt[0]), `toast on the prompt ${JSON.stringify({ w, prompt })}`);
        assert.ok(w.t >= 400, `toast clear of every signal head ${JSON.stringify(w)}`);
        for (const f of [...(await boxes(page, '.hud-map')), ...(await boxes(page, '.hud-speed'))]) assert.ok(!meets(w, f), JSON.stringify({ w, f }));
      }
      const arrow = (await boxes(page, '.hud-arrow'))[0];
      for (const w of pops) {
        assert.ok(!meets(w, arrow), `pop on the arrow ${JSON.stringify({ w, arrow })}`);
        assert.ok(w.t >= 270, `pop under the mast heads ${JSON.stringify(w)}`);
      }
      await shot(page, 'chase_words');
      // Those were one moment. The whole of each pop's life keeps under the band, swell and rise, the largest first in the stack.
      const peaks = await popPeaks(page);
      assert.ok(peaks.length >= 2, 'pops are still animating');
      for (const p of peaks) assert.ok(p.top >= 270, `pop under the mast heads at any moment ${JSON.stringify(p)}`);
    });
  });

  await scenario('labels do not pile up: one figure for each thing, and nothing on the chip or the arrow', async () => {
    await withGame('?seed=1&notitle=1&mute=1&traffic=0&peds=0&incidents=0&contest=off', {}, async (page) => {
      await held(page);
      await toPhase(page, 'CARD').catch(() => {});
      const card = await text(page, '.phone-route');
      await toPhase(page, 'DRIVE');
      await lib.frames(page, 2);
      const arrowFirst = await text(page, '.hud-arrow-dist');
      if (card) assert.ok(card.includes(arrowFirst.match(/\d+/)[0]), `card ${card} and arrow ${arrowFirst} agree`);
      await page.evaluate(() => { TLV.ui.hud._view().prompt.t = 0; });
      for (const left of [127, 100, 74, 40]) {
        await toBay(page, left, 0);
        await step(page, 1);
        await settled(page);
        const figures = await page.evaluate(() => {
          const seen = [];
          document.querySelectorAll('.hud-chip, .hud-arrow-dist, .tag-bay, .tag-door').forEach((n) => {
            if (n.getClientRects().length && /\d/.test(n.textContent)) seen.push(n.textContent);
          });
          return seen;
        });
        const counted = figures.filter((f) => /bay/.test(f));
        assert.ok(counted.length <= 1, `the road left shows once ${JSON.stringify(figures)}`);
        assert.ok(!figures.some((f) => /^\d/.test(f)), `every figure is labelled ${JSON.stringify(figures)}`);
        const chip = (await boxes(page, '.hud-chip'))[0];
        for (const tag of [...(await boxes(page, '.tag-door')), ...(await boxes(page, '.tag-bay'))]) assert.ok(!meets(tag, chip), `${left} m: tag on the chip ${JSON.stringify({ tag, chip })}`);
        if (left === 127) {
          assert.ok(!(await shown(page, '.tag-bay')), 'no bay tag that far out in the chase view');
          await page.evaluate(() => {
            const S = TLV.app.S;
            const yaw = TLV.ui.viewYaw(S);
            TLV.ui.dispatch('incident.telegraph', { id: 7, defId: 'SLOW_CROSS', x: S.player.fx + 40 * Math.cos(yaw), y: S.player.fy + 40 * Math.sin(yaw) });
          });
          await lib.frames(page, 2);
          const arrow = (await boxes(page, '.hud-arrow'))[0];
          const chevron = await page.evaluate(() => {
            const b = document.querySelector('.chevron-mark').getBoundingClientRect();
            return { l: b.left, r: b.right, t: b.top, b: b.bottom };
          });
          assert.ok(!meets(chevron, arrow), `chevron on the arrow ${JSON.stringify({ chevron, arrow })}`);
          await shot(page, 'junction_short_of_bay');
          await page.evaluate(() => { document.querySelectorAll('.chevron').forEach((n) => n.remove()); TLV.ui.hud._view().chevrons.length = 0; });
        }
      }
    });
  });

  await scenario('a bonus says its money once, and any other money still pops', async () => {
    await withGame('?seed=1&notitle=1&mute=1&traffic=0&peds=0&incidents=0', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await lib.frames(page, 2);
      await page.evaluate(() => TLV.game.score.bonus(TLV.app.S, 'BEAT_THE_HONK', 25, 0));
      await lib.frames(page, 3);
      const pops = () => page.evaluate(() => [...document.querySelectorAll('.pop')].map((n) => n.textContent));
      assert.deepStrictEqual(await pops(), ['BEAT THE HONK  +₪25']);
      await page.evaluate(() => { TLV.app.S.game.money += 40; });
      await lib.frames(page, 3);
      assert.deepStrictEqual(await pops(), ['BEAT THE HONK  +₪25', '+₪40']);
      await page.evaluate(() => { TLV.game.score.bonus(TLV.app.S, 'GAVE_WAY', 30, 0); TLV.app.S.game.money += 100; });
      await lib.frames(page, 3);
      assert.deepStrictEqual((await pops()).slice(2), ['GAVE WAY  +₪30', '+₪100']);
    });
  });

  await scenario('C away from the bay says why nothing happened, and works at the bay', async () => {
    await withGame('?seed=1&notitle=1&mute=1&traffic=0&peds=0&incidents=0&contest=off', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await lib.frames(page, 2);
      const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map((n) => n.textContent));
      await lib.press(page, 'KeyC');
      await lib.frames(page, 3);
      assert.strictEqual(await page.evaluate(() => TLV.ui.parkingView()), false);
      assert.ok((await toasts()).includes('The bay camera only works near the bay.'));
      await page.evaluate(() => {
        document.querySelectorAll('.toast').forEach((n) => n.remove());
        TLV.ui.hud._view().toasts.length = 0;
      });
      await toBay(page, 10, 2);
      await step(page, 1);
      const before = await settled(page);
      assert.strictEqual(before.rig, true);
      await lib.press(page, 'KeyC');
      await lib.frames(page, 3);
      assert.strictEqual(await page.evaluate(() => TLV.ui.parkingView()), false, 'C leaves the parking view at the bay');
      assert.ok(!(await toasts()).includes('The bay camera only works near the bay.'));
      await page.evaluate(() => TLV.ui.force('pause', true));
      await lib.frames(page, 2);
      assert.ok((await text(page, '.scr-pause .controls-line')).includes('bay camera'));
      await page.evaluate(() => TLV.ui.force('pause', false));
    });
  });

  await scenario('reroutes say so once, then not again for a good while', async () => {
    await withGame('?seed=1&notitle=1&mute=1&traffic=0&peds=0&incidents=0&contest=off', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await page.evaluate(() => { for (let i = 0; i < 6; i++) TLV.ui.dispatch('nav.recalc', {}); });
      await lib.frames(page, 2);
      const lines = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map((n) => n.textContent));
      assert.deepStrictEqual(await lines(), ['Recalculating. Disappointed.']);
      assert.ok((await page.evaluate(() => TLV.ui.hud._view().recalcGap)) > 25);
      await page.evaluate(() => { TLV.ui.hud._view().recalcGap = 0; TLV.ui.dispatch('nav.recalc', {}); });
      await lib.frames(page, 2);
      assert.ok((await lines()).includes('In 200 metres, regret.'));
    });
  });

  await scenario('the UGLY stamp gives its reason, from a real park', async () => {
    /** frames: 'ticks' draws through the arming, 'batch' only after a first batch, as a slow frame would, and 'none' not until the payout. */
    const parkAt = async (page, lateral, yaw, frames) => {
      await page.evaluate(() => TLV.debug.startRun({}));
      await step(page, 1);
      await toPhase(page, 'DRIVE');
      await page.evaluate(([side, turn]) => {
        const S = TLV.app.S;
        const sp = TLV.world.parking.spot(S.world, S.game.errand.bayId);
        const r = S.game.nav.route;
        const ex = r.px[r.px.length - 1] - sp.x;
        const ey = r.py[r.py.length - 1] - sp.y;
        // Off the axis on the road's side, because the other side is the kerb.
        const n = -ex * Math.sin(sp.h) + ey * Math.cos(sp.h) >= 0 ? 1 : -1;
        TLV.debug.teleport(sp.x - Math.sin(sp.h) * side * n, sp.y + Math.cos(sp.h) * side * n, sp.h + turn, 0.4);
      }, [lateral, yaw]);
      if (frames === 'none') {
        await page.evaluate(() => { for (let i = 0; i < 400 && TLV.debug.state().phase !== 'PAYOUT'; i++) TLV.debug.step(1); });
      }
      // Drawn tick by tick through the arming, or only after a batch, as a slow frame would. The first batch is what that tests.
      for (let i = 0; i < 120 && (await state(page)).phase !== 'PAYOUT'; i++) {
        await step(page, frames === 'ticks' && i < 8 ? 1 : 12);
        if ((frames === 'ticks' && i < 8) || (frames === 'batch' && i === 0)) await lib.frames(page, 1);
      }
      await lib.frames(page, 3);
      assert.strictEqual((await state(page)).phase, 'PAYOUT');
      return { stamp: await text(page, '.payout-stamp'), why: await shown(page, '.payout-why') ? await text(page, '.payout-why') : null };
    };
    /** Tells the card about a park, as the sim would, over whatever pose it caught itself. */
    const told = async (page, payload) => {
      await page.evaluate((p) => TLV.ui.dispatch('errand.parked', { index: 0, quality: 'UGLY', method: 'BAY', pay: 100, award: 10, spotless: false, ...p }), payload);
      await lib.frames(page, 2);
      return text(page, '.payout-why');
    };
    await withGame('?seed=1&notitle=1&mute=1&traffic=0&peds=0&incidents=0&contest=off', {}, async (page) => {
      await held(page);
      const off = 'Too far off centre. Stop in the middle of the box.';
      const crooked = 'Too crooked. Straighten up before you stop.';
      await page.evaluate(() => TLV.app.S.bus.on('errand.parked', (p) => { window.__parked = p; }));
      assert.deepStrictEqual(await parkAt(page, 1, 0, 'ticks'), { stamp: 'UGLY', why: off });
      await shot(page, 'ugly_offset');
      const sent = await page.evaluate(() => window.__parked);
      assert.ok(Math.abs(sent.offM - 1) < 0.1 && sent.yawDeg < 2, `the sim gave the pose it graded ${JSON.stringify(sent)}`);
      assert.deepStrictEqual(await parkAt(page, 0, 0.42, 'ticks'), { stamp: 'UGLY', why: crooked });
      assert.deepStrictEqual(await parkAt(page, 1, 0, 'batch'), { stamp: 'UGLY', why: off });
      assert.deepStrictEqual(await parkAt(page, 0, 0, 'ticks'), { stamp: 'PERFECT', why: null });
      // No frame saw the pose, so nothing but the sim's figures can name the fault.
      assert.deepStrictEqual(await parkAt(page, 1, 0, 'none'), { stamp: 'UGLY', why: off });
      assert.deepStrictEqual(await parkAt(page, 0, 0.42, 'none'), { stamp: 'UGLY', why: crooked });
      // The sim's figures beat the pose the card caught, here 1 m off centre and square.
      await parkAt(page, 1, 0, 'ticks');
      assert.strictEqual(await told(page, { offM: 0.2, yawDeg: 20 }), crooked);
      // Both faults: the one furthest past its limit, which is what the card has always named.
      assert.strictEqual(await told(page, { offM: 1.1, yawDeg: 13 }), off);
      assert.strictEqual(await told(page, { offM: 0.8, yawDeg: 25 }), crooked);
      // Absent or null, as for a park with no bay capture, the card falls back on what it caught.
      assert.strictEqual(await told(page, {}), off);
      assert.strictEqual(await told(page, { offM: null, yawDeg: null }), off);
      await page.evaluate(() => TLV.debug.startRun({}));
      await step(page, 1);
      await toPhase(page, 'DRIVE');
      await page.evaluate(() => TLV.debug.parkNow({ quality: 'UGLY' }));
      await step(page, 2);
      await lib.frames(page, 3);
      assert.match(await text(page, '.payout-why'), /Crooked or off centre/);
      await page.evaluate(() => TLV.ui.dispatch('errand.parked', { index: 0, quality: 'UGLY', method: 'RED_WHITE', pay: 100, award: 10, spotless: false }));
      await lib.frames(page, 2);
      assert.match(await text(page, '.payout-why'), /red kerb/);
    });
    await withGame('?seed=1&notitle=1&mute=1&traffic=0&peds=0&incidents=0&contest=off&lang=he', {}, async (page) => {
      await held(page);
      assert.deepStrictEqual(await parkAt(page, 1, 0, 'none'), { stamp: await page.evaluate(() => TLV.ui.strings.t('quality.UGLY')), why: 'רחוק מדי מהאמצע. לעצור באמצע המשבצת.' });
      await shot(page, 'ugly_offset_he');
      assert.strictEqual((await parkAt(page, 0, 0.42, 'none')).why, 'עקום מדי. ליישר לפני שעוצרים.');
      await shot(page, 'ugly_crooked_he');
      assert.strictEqual(await told(page, { offM: 1.1, yawDeg: 3 }), 'רחוק מדי מהאמצע. לעצור באמצע המשבצת.');
      // Neither the sim's figures nor a frame that saw the pose: the line that covers both.
      assert.strictEqual(await told(page, { offM: null, yawDeg: null }), 'עקום או רחוק מהאמצע. לעצור ישר, באמצע המשבצת.');
    });
  });

  await scenario('one-shot prompts: BLINK and the lost bay wait for errand 2', async () => {
    await withGame('?seed=1&notitle=1&mute=1', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await page.evaluate(() => {
        TLV.ui.dispatch('contest.state', { state: 'BLINK' });
        TLV.ui.dispatch('contest.result', { winner: 'rival', tier: null });
      });
      await lib.frames(page, 2);
      assert.strictEqual(await page.evaluate(() => !!TLV.ui.hud._view().seen['prompt.wait']), false, 'errand 1 would be a lie');
      await page.evaluate(() => { TLV.app.S.game.errandIndex = 1; TLV.ui.dispatch('contest.state', { state: 'BLINK' }); });
      await lib.frames(page, 2);
      assert.strictEqual(await text(page, '.hud-prompt'), 'WAIT BEHIND HIM: +5 s');
      await page.evaluate(() => { TLV.ui.hud._view().prompt.t = 0; TLV.ui.dispatch('contest.result', { winner: 'rival', tier: null }); });
      await lib.frames(page, 2);
      assert.match(await text(page, '.hud-prompt'), /Q: PARK BADLY/);
      await page.evaluate(() => TLV.ui.dispatch('contest.result', { winner: null, tier: null }));
      await lib.frames(page, 1);
    });
  });

  await scenario('a real contest: rage gauge over the rival, then parking bars and payout', async () => {
    await withGame('?seed=2&notitle=1&mute=1&incidents=0', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      const got = await page.evaluate(() => TLV.debug.forceContest({}));
      assert.ok(got && got.rivalId >= 0, JSON.stringify(got));
      await step(page, 30);
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.tag-rage'), 'rage gauge');
      assert.strictEqual(await text(page, '.tag-rage-label'), "RIVAL'S RAGE");
      await shot(page, 'contest_rage');
      await page.evaluate(() => TLV.debug.parkNow({ quality: 'PERFECT' }));
      await step(page, 2);
      await lib.frames(page, 3);
      const s = await state(page);
      assert.strictEqual(s.phase, 'PAYOUT');
      assert.ok(await shown(page, '.payout'));
      assert.strictEqual(await text(page, '.payout-stamp'), 'PERFECT');
      await shot(page, 'payout_real');
    });
  });

  await scenario('the rage gauge keeps off the bay tag and the door tag, in both views', async () => {
    await withGame('?seed=2&notitle=1&mute=1&incidents=0&traffic=0&peds=0', { routes: cameraWith({ parkAhead: 4 }) }, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      const got = await page.evaluate(() => TLV.debug.forceContest({}));
      assert.ok(got && got.rivalId >= 0, JSON.stringify(got));
      for (const left of [80, 40, 22, 13, 6]) {
        await toBay(page, left, 2);
        await page.evaluate(() => { TLV.debug.setHeat && TLV.debug.setHeat(0); });
        await step(page, 1);
        await settled(page);
        for (const where of ['bay', 'door']) {
          // The two places the review caught it: on the bay, and on the door.
          await page.evaluate((spot) => {
            const S = TLV.app.S;
            const veh = S.vehicles.find((v) => v.active && v.id === S.game.contest.rivalId);
            const e = S.game.errand;
            if (spot === 'bay') {
              veh.x = S.game.nav.targetX;
              veh.y = S.game.nav.targetY;
            } else {
              veh.x = e.doorX;
              veh.y = e.doorY;
            }
          }, where);
          await lib.frames(page, 3);
          const rage = await boxes(page, '.tag-rage');
          assert.ok(rage.length === 1, `gauge at ${left} m, ${where}`);
          const others = [...(await boxes(page, '.tag-bay')), ...(await boxes(page, '.tag-door'))];
          for (const o of others) assert.ok(!meets(rage[0], o), `${left} m, rival at the ${where}: ${JSON.stringify({ rage: rage[0], o })}`);
          if (left === 6 && where === 'bay') await shot(page, 'rage_clear_parking');
        }
      }
    });
  });

  await scenario('HOLD shows the capture bar and the bay marker', async () => {
    await withGame('?seed=2&notitle=1&mute=1&incidents=0&contest=off', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await page.evaluate(() => {
        const S = TLV.app.S;
        const g = S.game;
        g.phase = 'HOLD';
        g.park.stage = 'FILL';
        g.park.kind = 'BAY';
        g.park.bar = 0.6;
      });
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.hud-parkbar'));
      assert.strictEqual(await page.evaluate(() => parseFloat(document.querySelector('.hud-parkbar-fill').style.width)), 60);
      assert.strictEqual(await text(page, '.hud-prompt'), 'STAY. HANDS OFF THE GAS.');
      await shot(page, 'hold_bar');
      await page.evaluate(() => { const g = TLV.app.S.game; g.park.kind = 'DOUBLE'; });
      await lib.frames(page, 2);
      assert.match(await text(page, '.hud-prompt'), /Q.*JUST ONE SECOND/);
      await page.evaluate(() => { const g = TLV.app.S.game; g.phase = 'DRIVE'; g.park.stage = null; g.park.kind = null; g.park.bar = 0; });
    });
  });

  await scenario('the real knife: stage prompts, tug bar, E, chase panel, resolve card', async () => {
    await withGame('?seed=2&notitle=1&mute=1&incidents=0&knife=force', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      assert.ok(await page.evaluate(() => TLV.debug.setErrand(1) !== undefined));
      await page.evaluate(() => TLV.debug.forceKnife({ stage: 'STANDOFF' }));
      await step(page, 2);
      await lib.frames(page, 3);
      assert.strictEqual((await state(page)).knife.stage, 'STANDOFF');
      assert.strictEqual(await text(page, '.knife-line'), 'HE IS GETTING OUT OF THE CAR');
      assert.ok(!(await shown(page, '.hud-chip')));
      await shot(page, 'knife_real_standoff');
      for (let i = 0; i < 20 && (await state(page)).knife.stage !== 'DOOR_TUG'; i++) await step(page, 10);
      await step(page, 30);
      await lib.frames(page, 3);
      assert.strictEqual((await state(page)).knife.stage, 'DOOR_TUG');
      assert.match(await text(page, '.knife-line'), /E.*OUT THE PASSENGER SIDE/);
      assert.ok(await shown(page, '.knife-tug'));
      const w0 = parseFloat(await page.evaluate(() => document.querySelector('.knife-tug-fill').style.width));
      await step(page, 30);
      await lib.frames(page, 2);
      const w1 = parseFloat(await page.evaluate(() => document.querySelector('.knife-tug-fill').style.width));
      assert.ok(w1 < w0, `bar drains ${w0} to ${w1}`);
      await shot(page, 'knife_real_tug');
      await page.evaluate(() => TLV.debug.setInput({ interact: true }));
      await step(page, 2);
      await page.evaluate(() => TLV.debug.setInput({ interact: false }));
      for (let i = 0; i < 30 && (await state(page)).knife.stage !== 'CHASE'; i++) await step(page, 10);
      await lib.frames(page, 3);
      assert.strictEqual((await state(page)).knife.stage, 'CHASE');
      assert.ok(await shown(page, '.chase'));
      assert.match(await text(page, '.knife-line'), /RUN TO THE DOOR/);
      assert.ok(await shown(page, '.hud-arrow'));
      assert.strictEqual(await page.evaluate(() => document.querySelector('.hud-arrow').classList.contains('foot')), true);
      assert.ok(!(await shown(page, '.hud-speed')), 'no speedometer on foot');
      await shot(page, 'knife_real_chase');
      // The door is the goal now: straight ahead, under the arrow, its tag must hold.
      await page.evaluate(() => {
        const s = TLV.debug.state();
        const g = TLV.app.S.game;
        const h = Math.atan2(s.player.y - g.errand.doorY, s.player.x - g.errand.doorX);
        TLV.debug.teleport(g.errand.doorX + 24 * Math.cos(h), g.errand.doorY + 24 * Math.sin(h), h + Math.PI, 0);
      });
      await step(page, 1);
      let door = null;
      for (let i = 0; i < 60; i++) {
        await lib.frames(page, 2);
        door = await page.evaluate(() => {
          const e = TLV.app.S.game.errand;
          const at = TLV.render.project(e.doorX, e.doorY, TLV.tune.ui.doorTagZ, {});
          return { visible: at.visible, sx: at.sx, sy: at.sy };
        });
        if (door.visible && Math.abs(door.sx - 640) < 160) break;
      }
      assert.ok(door.visible, `the door came into view ${JSON.stringify(door)}`);
      assert.ok(await shown(page, '.tag-door'), `door tag on the run ${JSON.stringify(door)}`);
      await page.evaluate(() => { const s = TLV.debug.state(); TLV.debug.teleport(s.doorX, s.doorY, 0, 0); });
      for (let i = 0; i < 20 && (await state(page)).phase !== 'RESOLVE'; i++) await step(page, 10);
      await lib.frames(page, 3);
      assert.strictEqual((await state(page)).phase, 'RESOLVE');
      assert.ok(await shown(page, '.resolve'));
      assert.strictEqual(await text(page, '.resolve-title'), 'YOU REACHED THE SHOP');
      await shot(page, 'knife_real_resolve');
    });
  });

  await scenario('after a real drag the chase panel never reads a gap below zero, in both languages', async () => {
    for (const [lang, zero, eight] of [['en', '0 m', '8 m'], ['he', '0 מ׳', '8 מ׳']]) {
      await withGame(`?seed=2&notitle=1&mute=1&incidents=0&knife=force&lang=${lang}`, {}, async (page) => {
        await held(page);
        await toPhase(page, 'DRIVE');
        await page.evaluate(() => { TLV.debug.setErrand(1); TLV.debug.forceKnife({ stage: 'DOOR_TUG' }); });
        const stages = [];
        for (let i = 0; i < 60 && stages[stages.length - 1] !== 'CHASE'; i++) {
          await step(page, 10);
          const stage = (await state(page)).knife.stage;
          if (stages[stages.length - 1] !== stage) stages.push(stage);
        }
        assert.deepStrictEqual(stages.slice(-2), ['DRAGGED', 'CHASE'], `a real drag ${JSON.stringify(stages)}`);
        const gapText = () => text(page, '.chase-value');
        const seen = [];
        for (let i = 0; i < 12; i++) {
          await lib.frames(page, 1);
          seen.push({ gap: await page.evaluate(() => TLV.app.S.game.knife.gap), text: await gapText() });
          assert.doesNotMatch(seen[seen.length - 1].text, /-/, JSON.stringify(seen));
          await step(page, 2);
        }
        for (const [gap, want] of [[-3.4, zero], [-0.2, zero], [0, zero], [7.6, eight]]) {
          await page.evaluate((n) => { TLV.app.S.game.knife.gap = n; }, gap);
          await lib.frames(page, 2);
          assert.deepStrictEqual({ gap, text: await gapText() }, { gap, text: want });
        }
        await page.evaluate(() => { TLV.app.S.game.knife.gap = -3.4; });
        await shot(page, `chase_gap_floor_${lang}`);
      });
    }
  });

  await scenario('a total below zero reads as a loss on the end card, in both languages', async () => {
    for (const lang of ['en', 'he']) {
      await withGame(`?seed=1&notitle=1&mute=1&lang=${lang}`, {}, async (page) => {
        await held(page);
        // Darker than the HUD's own loss red by the owner's decision, for 4:1 on the card. The contrast is pinned in its own scenario below.
        const lossColour = 'rgb(192, 32, 15)';
        const end = async (money) => {
          await page.evaluate(() => TLV.debug.startRun({}));
          await step(page, 1);
          await toPhase(page, 'DRIVE');
          await page.evaluate((n) => { TLV.debug.setMoney(n); TLV.debug.setHP(0); }, money);
          await step(page, 2);
          await lib.frames(page, 3);
          assert.strictEqual((await state(page)).phase, 'RUN_END');
          return page.evaluate(() => {
            const n = document.querySelector('.licence-total');
            return { text: n.textContent, colour: getComputedStyle(n).color };
          });
        };
        assert.deepStrictEqual(await end(-533), { text: '-₪533', colour: lossColour });
        await shot(page, `end_loss_${lang}`);
        const green = 'rgb(21, 128, 61)';
        assert.deepStrictEqual(await end(900), { text: '₪900', colour: green });
        assert.deepStrictEqual(await end(-1240), { text: '-₪1,240', colour: lossColour });
        assert.deepStrictEqual(await end(0), { text: '₪0', colour: green });
      });
    }
  });

  await scenario('knife.strike cuts to white, with no red', async () => {
    await withGame('?seed=2&notitle=1&mute=1', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await page.evaluate(() => TLV.ui.dispatch('knife.strike', { strikes: 1 }));
      await lib.frames(page, 1);
      const o = await page.evaluate(() => ({ flash: Number(document.querySelector('.fx-flash').style.opacity), vig: Number(document.querySelector('.fx-vignette').style.opacity) }));
      assert.ok(o.flash > 0.5, JSON.stringify(o));
      assert.strictEqual(o.vig, 0);
    });
  });

  await scenario('incident.telegraph shows a chevron on the side the danger is on', async () => {
    await withGame('?seed=2&notitle=1&mute=1', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      const place = (turn) => page.evaluate((a) => {
        const S = TLV.app.S;
        const yaw = TLV.ui.viewYaw(S);
        TLV.ui.dispatch('incident.telegraph', { id: 9, defId: 'RED_RUNNER', x: S.player.fx + 50 * Math.cos(yaw + a), y: S.player.fy + 50 * Math.sin(yaw + a) });
      }, turn);
      await place(Math.PI / 2);
      await lib.frames(page, 2);
      const left = await page.evaluate(() => {
        const c = document.querySelector('.chevron');
        return { x: c.getBoundingClientRect().left, rel: Number(c.dataset.rel), label: c.textContent };
      });
      assert.ok(left.x < 400, JSON.stringify(left));
      assert.ok(Math.abs(left.rel - Math.PI / 2) < 0.05, JSON.stringify(left));
      assert.strictEqual(left.label, 'HE IS NOT STOPPING');
      await page.evaluate(() => { document.querySelectorAll('.chevron').forEach((n) => n.remove()); TLV.ui.hud._view().chevrons.length = 0; });
      await place(-Math.PI / 2);
      await lib.frames(page, 2);
      const right = await page.evaluate(() => document.querySelector('.chevron').getBoundingClientRect().left);
      assert.ok(right > 880, String(right));
      const staged = await page.evaluate(() => TLV.debug.forceIncident('STOP_NO_REASON', { force: true }));
      await step(page, 2);
      await lib.frames(page, 2);
      if (staged !== null) assert.ok((await page.evaluate(() => document.querySelectorAll('.chevron').length)) >= 1);
    });
  });

  await scenario('bubbles: symbols show over their owner, and words are refused', async () => {
    await withGame('?seed=2&notitle=1&mute=1&traffic=1', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      const out = await page.evaluate(() => {
        const S = TLV.app.S;
        const veh = S.vehicles.find((v) => v.active && !v.isPlayer);
        const warn = console.warn;
        console.warn = () => {};
        const before = TLV.ui.bubbles._texts().length;
        TLV.ui.dispatch('bubble', { who: 'veh', id: veh.id, text: 'hello', ttl: 2 });
        TLV.ui.dispatch('bubble', { who: 'veh', id: veh.id, text: 'שלום', ttl: 2 });
        console.warn = warn;
        const refused = TLV.ui.bubbles._texts().length - before;
        TLV.ui.dispatch('bubble', { who: 'veh', id: veh.id, text: '#@!', ttl: 2 });
        return { refused, after: TLV.ui.bubbles._texts() };
      });
      assert.strictEqual(out.refused, 0);
      assert.ok(out.after.includes('#@!'));
      for (const t of out.after) assert.ok(!/[\p{L}\p{N}]/u.test(t), t);
    });
  });

  await scenario('a bubble never shows through the dimmed end or pause screen', async () => {
    await withGame('?seed=2&notitle=1&mute=1&traffic=1', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      const say = () => page.evaluate(() => {
        const veh = TLV.app.S.vehicles.find((v) => v.active && !v.isPlayer);
        TLV.ui.dispatch('bubble', { who: 'veh', id: veh.id, text: '!', ttl: 6 });
      });
      await say();
      await lib.frames(page, 2);
      assert.ok(await shown(page, '.bubbles'));
      await page.evaluate(() => TLV.ui.force('pause', true));
      await lib.frames(page, 2);
      assert.ok(!(await shown(page, '.bubbles')), 'pause');
      await page.evaluate(() => TLV.ui.force('pause', false));
      await lib.frames(page, 2);
      assert.ok(await shown(page, '.bubbles'), 'back after the pause');
      await page.evaluate(() => TLV.debug.setClock(0.02));
      await step(page, 3);
      assert.strictEqual((await state(page)).phase, 'RUN_END');
      await say();
      await lib.frames(page, 3);
      assert.ok(!(await shown(page, '.bubbles')), 'end screen');
      assert.ok(await shown(page, '.scr-end'));
    });
  });

  await scenario('every event of the table can be handled, with a payload of its shape', async () => {
    await withGame('?seed=2&notitle=1&mute=1&debug=1', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      const failures = await page.evaluate(() => {
        const sample = {
          'player.contact': { kind: 'vehicle', otherId: 1, vn: 4, severity: 'bump', rearEnded: false, x: 0, y: 0 },
          'player.hitPed': { pedId: 1, pedKind: 'walker', speed: 5, x: 0, y: 0 },
          'player.nearMiss': { vehId: 1, gap: 0.8, relSpeed: 7, tier: 1, x: 0, y: 0 },
          'player.wrongWay': { on: true }, 'player.surface': { surface: 1 }, 'player.mode': { mode: 'DRIVE' },
          'player.brushPed': { pedId: 1 }, 'player.horn': { x: 0, y: 0, h: 0 }, 'player.launch': {}, 'player.redRun': { juncId: 1 },
          'player.waterEdge': { x: 0, y: 0 }, 'player.recover': { x: 0, y: 0 },
          'traffic.spawn': { vehId: 1, kind: 'sedan' }, 'traffic.despawn': { vehId: 1, reason: 'range' },
          'traffic.behaviour': { vehId: 1, beh: 'CRUISE', prev: 'CRUISE' }, 'traffic.redRun': { vehId: 1, juncId: 1 },
          'traffic.honk': { vehId: 1, atPlayer: true, x: 5, y: 5 }, 'traffic.wreck': { vehId: 1 },
          'traffic.parkRace': { vehId: 1, stage: 'BLINK', spotId: 1 }, 'traffic.door': { vehId: 1, open: true },
          'ped.spawn': { pedId: 1, kind: 'walker' }, 'ped.despawn': { pedId: 1 }, 'ped.intent': { pedId: 1 },
          'ped.stepOut': { pedId: 1, state: 'JAYWALK' }, 'ped.bell': { pedId: 1 }, 'nav.recalc': {},
          'errand.start': { index: 0, defId: 'milk' }, 'errand.search': { bayId: -1 },
          'errand.parked': { index: 0, quality: 'GOOD', method: 'BAY', pay: null, award: 40, spotless: false },
          'errand.paid': { index: 0, pay: 300, exit: 'SHAKEN' }, 'inspector.ticket': { amount: 300, kind: 'TOW' },
          'contest.start': { rivalId: 1, spotId: 1 }, 'contest.state': { state: 'COMMIT' }, 'contest.result': { winner: null, tier: null },
          'knife.stage': { stage: 'CHASE' }, 'knife.lunge': { phase: 'WINDUP' }, 'knife.strike': { strikes: 1 }, 'knife.exit': { exit: 'WHISTLE' },
          'incident.telegraph': { id: 1, defId: 'TAILGATE', x: 1, y: 1 }, 'incident.end': { id: 1, defId: 'TAILGATE', outcome: 'AVOIDED' },
          'score.bonus': { id: 'AFTER_YOU', amount: 50, seconds: 5 }, 'score.chain': { n: 2, mult: 1.7, bank: 30 },
          'clock.warn': { level: 2 }, 'run.start': { seed: 1 }, 'run.end': { reason: 'WIN', money: 10, rank: 'NEW_DRIVER', stats: TLV.app.S.game.stats },
          'bubble': { who: 'veh', id: 0, text: '!', ttl: 1 }
        };
        const bad = [];
        Object.keys(TLV.ui.EVENTS).forEach((name) => {
          if (!sample[name]) bad.push(`no sample for ${name}`);
          try {
            TLV.ui.dispatch(name, sample[name]);
          } catch (e) {
            bad.push(`${name}: ${e.message}`);
          }
        });
        return bad;
      });
      assert.deepStrictEqual(failures, []);
      await lib.frames(page, 3);
    });
  });

  await scenario('a UI frame changes nothing in the sim: same hash with the UI drawing or not', async () => {
    const run = async (draw) => {
      let hash = null;
      await withGame('?seed=5&notitle=1&mute=1&autoplay=patrol', {}, async (page) => {
        await page.evaluate((d) => {
          TLV.debug.pause();
          if (!d) TLV.ui.frame = function () {};
        }, draw);
        // The loop starts before this page can pause it, so each run reaches the pause at a different tick. Compare at one fixed tick.
        const start = (await state(page)).tick;
        assert.ok(start < 240, `paused late, at tick ${start}`);
        await step(page, 240 - start);
        for (let i = 0; i < 8; i++) {
          await step(page, 120);
          await lib.frames(page, 2);
        }
        assert.strictEqual((await state(page)).tick, 1200);
        hash = await page.evaluate(() => TLV.debug.hash());
      });
      return hash;
    };
    const a = await run(true);
    const b = await run(false);
    assert.ok(a !== null);
    assert.strictEqual(a, b);
  });

  await scenario('toasts, pops and chevrons leave by themselves in a running game', async () => {
    await withGame('?seed=1&notitle=1&mute=1&incidents=0', {}, async (page) => {
      await page.waitForFunction(() => TLV.debug.state().phase === 'DRIVE');
      await page.evaluate(() => {
        const S = TLV.app.S;
        TLV.ui.dispatch('player.redRun', { juncId: 1 });
        TLV.ui.dispatch('player.nearMiss', { vehId: 1, gap: 0.8, relSpeed: 7, tier: 1, x: 0, y: 0 });
        TLV.ui.dispatch('incident.telegraph', { id: 1, defId: 'TAILGATE', x: S.player.fx + 20, y: S.player.fy });
      });
      await lib.frames(page, 2);
      const count = () => page.evaluate(() => document.querySelectorAll('.toast, .pop.near, .chevron').length);
      assert.ok((await count()) >= 3);
      await page.waitForFunction(() => document.querySelectorAll('.toast, .pop.near, .chevron').length === 0);
    });
  });

  await scenario('hud=0 hides the HUD and cards, for clean screenshots', async () => {
    await withGame('?seed=1&notitle=1&mute=1&hud=0', {}, async (page) => {
      await held(page);
      await lib.frames(page, 3);
      assert.ok(!(await shown(page, '.hud')));
      assert.ok(!(await shown(page, '.phone')));
    });
  });

  await scenario('debug and dev overlays', async () => {
    await withGame('?seed=1&notitle=1&mute=1&debug=1&dev=1', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await page.waitForTimeout(500);
      await lib.frames(page, 4);
      assert.ok(await shown(page, '.debug-panel'));
      assert.ok(await shown(page, '.dev-panel'));
      assert.match(await text(page, '.debug-panel'), /phase\s+DRIVE/);
      assert.match(await text(page, '.dev-panel'), /Unresolved content/);
      await shot(page, 'debug_overlay');
    });
  });

  await scenario('showError works before init, replaces its text, and can be closed', async () => {
    await withGame('?seed=1&notitle=1&mute=1', {}, async (page) => {
      const out = await page.evaluate(() => {
        TLV.ui.showError('first');
        TLV.ui.showError('first\n\nsecond');
        const n = document.querySelectorAll('#ui-error');
        return { count: n.length, text: n[0].textContent };
      });
      assert.strictEqual(out.count, 1);
      assert.ok(out.text.includes('second'));
      assert.strictEqual(out.text.match(/first/g).length, 1);
      await page.click('.ui-error-close');
      assert.strictEqual(await page.evaluate(() => document.querySelectorAll('#ui-error').length), 0);
    });
    const pw = require('../../tools/lib/pw.cjs');
    const { browser, page } = await pw.open({ params: '?seed=1', goto: false });
    try {
      const mod = require('node:fs').readFileSync(require('node:path').join(pw.PROJECT_ROOT, 'js/ui/ui.js'), 'utf8');
      await page.setContent('<!doctype html><meta charset="utf-8"><div id="ui-root"></div>');
      await page.evaluate(() => { window.TLV = { ns(p) { const parts = p.split('.'); let n = window.TLV; parts.forEach((k) => { n[k] = n[k] || {}; n = n[k]; }); return n; } }; });
      await page.addScriptTag({ content: mod });
      const before = await page.evaluate(() => {
        TLV.ui.showError('early');
        return document.querySelector('#ui-root #ui-error').textContent;
      });
      assert.ok(before.includes('early'), 'before init, with nothing else loaded');
    } finally {
      await browser.close();
    }
  });

  await scenario('fixes: the credits open from the title, name the licences, start nothing, and fetch nothing', async () => {
    await withGame('?seed=1&mute=1&quality=low', {}, async (page) => {
      const asked = [];
      page.on('request', (r) => { if (!/^(file:|data:|blob:|http:\/\/(127\.0\.0\.1|localhost))/.test(r.url())) asked.push(r.url()); });
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.title-foot .osm'), 'the attribution line stays');
      await page.keyboard.press('KeyI');
      await lib.frames(page, 4);
      assert.ok(await shown(page, '.scr-credits'));
      assert.strictEqual((await state(page)).phase, 'TITLE', 'opening them must not start the day');
      const body = await text(page, '.credits-panel');
      for (const want of ['© OpenStreetMap contributors', 'ODbL', 'www.openstreetmap.org/copyright', 'Three.js', 'MIT']) assert.ok(body.includes(want), `${want} in ${body}`);
      await shot(page, 'fix_credits_title_en');
      await page.keyboard.press('KeyW');
      await page.keyboard.press('Enter');
      await lib.frames(page, 4);
      assert.strictEqual((await state(page)).phase, 'TITLE', 'keys stop at the view');
      assert.ok(!(await shown(page, '.scr-credits')), 'Enter closes it');
      await page.click('.title-foot .lang-btn:nth-of-type(1)');
      await lib.frames(page, 4);
      assert.ok(await shown(page, '.scr-credits'), 'a click opens it too');
      await page.click('.credits-back');
      await lib.frames(page, 4);
      assert.ok(!(await shown(page, '.scr-credits')));
      await page.keyboard.press('KeyL');
      await lib.frames(page, 3);
      await page.keyboard.press('KeyI');
      await lib.frames(page, 4);
      const hebrew = await text(page, '.credits-panel');
      for (const want of ['קרדיטים', '© OpenStreetMap contributors', 'ODbL', 'MIT']) assert.ok(hebrew.includes(want), `${want} in ${hebrew}`);
      await shot(page, 'fix_credits_title_he');
      await page.keyboard.press('Escape');
      await lib.frames(page, 3);
      assert.strictEqual((await state(page)).phase, 'TITLE');
      assert.deepStrictEqual(asked, []);
      await page.evaluate(() => localStorage.removeItem('sidurim.lang'));
    });
  });

  await scenario('fixes: the credits open from pause, and Esc goes back to pause, not to the road', async () => {
    await withGame('?seed=1&notitle=1&mute=1&quality=low', {}, async (page) => {
      await toPhase(page, 'CARD');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => TLV.ui.isUserPaused());
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.pause-credits'));
      assert.ok(await shown(page, '.scr-pause .osm'));
      await shot(page, 'fix_pause');
      await page.keyboard.press('KeyI');
      await lib.frames(page, 4);
      assert.ok(await shown(page, '.scr-credits'));
      await shot(page, 'fix_credits_pause');
      await page.keyboard.press('Escape');
      await lib.frames(page, 4);
      assert.ok(!(await shown(page, '.scr-credits')));
      assert.ok(await page.evaluate(() => TLV.ui.isUserPaused()), 'still paused');
      await page.click('.pause-credits');
      await lib.frames(page, 4);
      assert.ok(await shown(page, '.scr-credits'));
      await page.keyboard.press('KeyI');
      await lib.frames(page, 4);
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !TLV.ui.isUserPaused());
    });
  });

  await scenario('fixes: every packed asset is credited, and an author is shown as plain text', async () => {
    const index = {
      sf_bakery: { src: 'data/assets/sf_bakery.js', bytes: 10, credit: { author: 'A Mapillary Contributor', license: 'cc-by-sa', date: '2026-10' } },
      tile_wall: { src: 'data/assets/tile_wall.js', bytes: 10, credit: { author: '<b>Your Name</b>', license: 'own', date: '2026-09' } },
      lm_tower: { src: 'data/assets/lm_tower.js', bytes: 10, credit: { author: 'Someone', license: 'cc0' } },
      mesh_old: { src: 'data/assets/mesh_old.js', bytes: 10, credit: null }
    };
    const routes = (page) => page.route('**/data/assets/index.js', (r) => r.fulfill({ contentType: 'text/javascript; charset=utf-8', body: `TLV.assetIndex = ${JSON.stringify(index)};` }));
    await withGame('?seed=1&mute=1&quality=low', { routes }, async (page) => {
      await lib.frames(page, 3);
      await page.keyboard.press('KeyI');
      await lib.frames(page, 4);
      const lines = await page.evaluate(() => [...document.querySelectorAll('.credits-line')].map((n) => n.textContent));
      assert.ok(lines.includes('sf_bakery: A Mapillary Contributor, CC BY-SA, 2026-10'), JSON.stringify(lines));
      assert.ok(lines.includes('tile_wall: <b>Your Name</b>, own work, 2026-09'), JSON.stringify(lines));
      assert.ok(lines.includes('lm_tower: Someone, CC0'), JSON.stringify(lines));
      assert.ok(lines.includes('mesh_old: no credit on record'), JSON.stringify(lines));
      assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.credits-line b').length), 0);
      await shot(page, 'fix_credits_assets');
    });
  });

  await scenario('fixes: a difficulty in the address beats the remembered one on the card, and the player can still change it', async () => {
    const init = () => localStorage.setItem('sidurim.difficulty', 'relaxed');
    await withGame('?seed=1&mute=1&quality=low&difficulty=normal', { init }, async (page) => {
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.diff.on .diff-name'), 'NORMAL', 'over the remembered RELAXED');
      assert.strictEqual(await page.evaluate(() => TLV.game.getDifficulty()), 'normal');
      assert.strictEqual(await page.evaluate(() => localStorage.getItem('sidurim.difficulty')), 'relaxed', 'the address is not remembered');
      await page.keyboard.press('Digit1');
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.diff.on .diff-name'), 'RELAXED', 'the player still chooses');
      assert.strictEqual(await page.evaluate(() => TLV.game.getDifficulty()), 'relaxed');
      assert.strictEqual(await page.evaluate(() => localStorage.getItem('sidurim.difficulty')), 'relaxed');
      await page.keyboard.down('Enter');
      await page.waitForFunction(() => TLV.debug.state().phase !== 'TITLE');
      await page.keyboard.up('Enter');
      assert.strictEqual(await page.evaluate(() => TLV.app.S.game._g.runDifficulty), 'relaxed', 'and the run plays what they chose');
    });
    await withGame('?seed=1&mute=1&quality=low', { init }, async (page) => {
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.diff.on .diff-name'), 'RELAXED', 'with no address the memory holds');
    });
    await withGame('?seed=1&mute=1&quality=low&difficulty=nightmare', { init }, async (page) => {
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.diff.on .diff-name'), 'RELAXED', 'a word the table does not know changes nothing');
    });
  });

  await scenario('fixes: the bay line says creep, then stop, on the sim\'s own grade, in both languages', async () => {
    await withGame('?seed=2&notitle=1&mute=1&incidents=0&contest=off&traffic=0&peds=0&errand=2', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      const pose = (would) => page.evaluate((w) => {
        const g = TLV.app.S.game;
        g.phase = 'HOLD';
        g.park.stage = 'ARMED';
        g.park.kind = 'BAY';
        g.park.would = w;
      }, would);
      await pose('UGLY');
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.hud-prompt'), 'CREEP. STRAIGHTEN UP.');
      await shot(page, 'fix_prompt_roll_en');
      await pose('GOOD');
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.hud-prompt'), 'THE BAY IS YOURS. NOW STOP.');
      await shot(page, 'fix_prompt_stop_en');
      await pose('PERFECT');
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.hud-prompt'), 'THE BAY IS YOURS. NOW STOP.');
      await page.evaluate(() => TLV.ui.setLang('he'));
      await pose('UGLY');
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.hud-prompt'), 'לאט־לאט. ליישר את ההגה.');
      await shot(page, 'fix_prompt_roll_he');
      await pose('GOOD');
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.hud-prompt'), 'החניה שלך. עכשיו לעצור.');
      const box = (await boxes(page, '.hud-prompt'))[0];
      assert.ok(box.l >= 0 && box.r <= 1280, JSON.stringify(box));
      await page.evaluate(() => {
        TLV.ui.setLang('en');
        const g = TLV.app.S.game;
        g.phase = 'DRIVE';
        g.park.stage = null;
        g.park.kind = null;
        g.park.would = null;
      });
    });
  });

  await scenario('fixes: the bay tag stands past the box and never covers it, at every approach', async () => {
    await withGame('?seed=2&notitle=1&mute=1&incidents=0&contest=off&traffic=0&peds=0&errand=2', { routes: cameraWith({ parkAhead: 4 }) }, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      let seen = 0;
      for (const mode of ['parking', 'chase']) {
        await page.evaluate((m) => TLV.render.camera.setMode(m), mode);
        for (const [left, turn] of [[26, 0], [18, 0], [12, 0], [8, 0], [8, 0.5], [8, -0.5], [5, 0], [5, 2.6]]) {
          await toBay(page, left, 2, turn);
          await page.evaluate(() => { TLV.app.S.game.phase = 'SEARCH'; });
          await step(page, 1);
          await settled(page);
          assert.strictEqual(await page.evaluate(() => TLV.ui.parkingView()), mode === 'parking');
          const all = (await boxes(page, '.tag-bay'))[0];
          if (all) {
            seen++;
            const box = hull((await worldBoxes(page)).box);
            assert.ok(!touchesShape(all, box), `${mode}, ${left} m, turned ${turn}: ${JSON.stringify({ all, box })}`);
          }
          if (left === 12 || (left === 5 && turn === 0)) await shot(page, `fix_bay_tag_${mode}_${left}`);
        }
      }
      assert.ok(seen >= 8, `the tag showed ${seen} times`);
    });
  });

  await scenario('fixes: the end card\'s loss reads at 4:1 or better on every colour of its card', async () => {
    await withGame('?seed=1&notitle=1&mute=1&quality=low', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await page.evaluate(() => {
        TLV.app.S.game.money = -340;
        TLV.debug.ui('end.CLOCK');
      });
      await lib.frames(page, 4);
      assert.ok(await shown(page, '.licence-total.loss'));
      const fg = await page.evaluate(() => getComputedStyle(document.querySelector('.licence-total.loss')).color);
      const rgb = fg.match(/\d+/g).slice(0, 3).map(Number);
      const lum = (c) => {
        const f = c.map((v) => v / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * f[0] + 0.7152 * f[1] + 0.0722 * f[2];
      };
      for (const stop of [[0xff, 0xf0, 0xd6], [0xff, 0xe0, 0xea], [0xdd, 0xee, 0xff]]) {
        const [a, b] = [lum(rgb), lum(stop)].sort((x, y) => y - x);
        const ratio = (a + 0.05) / (b + 0.05);
        assert.ok(ratio >= 4, `${fg} on ${stop}: ${ratio.toFixed(2)}`);
      }
      await shot(page, 'fix_end_loss');
    });
  });

  await scenario('round 5: a revoked licence is no achievement, and neither is any day with a person hit', async () => {
    await withGame('?seed=3&notitle=1&mute=1&contest=off', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await page.evaluate(() => { TLV.debug.setMoney(6400); TLV.app.S.game.pedHits = 2; });
      await step(page, 2);
      await lib.frames(page, 3);
      assert.strictEqual((await state(page)).endReason, 'REVOKED');
      assert.strictEqual(await text(page, '.licence-title'), 'LICENCE REVOKED');
      assert.ok(!(await shown(page, '.licence-rank-value')), 'no rank');
      assert.ok(!(await shown(page, '.licence-total')), 'no total');
      assert.ok(!(await shown(page, '.licence-best')), 'no best day line');
      assert.strictEqual(await page.evaluate(() => localStorage.getItem('sidurim.best')), null, 'nothing stored');
      await shot(page, 'revoked_card');
      // One hit, then a day that ends on its own, with more money than the best on record.
      await page.evaluate(() => { localStorage.setItem('sidurim.best', '700'); TLV.debug.startRun({}); });
      await step(page, 1);
      await toPhase(page, 'DRIVE');
      await page.evaluate(() => { TLV.debug.setMoney(5500); TLV.app.S.game.pedHits = 1; TLV.debug.setClock(0.01); });
      await step(page, 2);
      await lib.frames(page, 3);
      assert.strictEqual((await state(page)).endReason, 'CLOCK');
      assert.ok(!(await shown(page, '.licence-rank-value')), 'no rank on a day with a hit');
      assert.ok(await shown(page, '.licence-total.plain'), 'the total is a plain sum');
      assert.strictEqual(await text(page, '.licence-best'), 'Best day: ₪700', 'the old best stands');
      assert.strictEqual(await page.evaluate(() => localStorage.getItem('sidurim.best')), '700');
      await shot(page, 'marked_card');
      // A clean day after it still counts, in the green.
      await page.evaluate(() => TLV.debug.startRun({}));
      await step(page, 1);
      await toPhase(page, 'DRIVE');
      await page.evaluate(() => { TLV.debug.setMoney(5500); TLV.debug.setClock(0.01); });
      await step(page, 2);
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.licence-rank-value'), 'a clean day has its rank');
      assert.ok(!(await shown(page, '.licence-total.plain')));
      assert.strictEqual(await text(page, '.licence-best'), 'NEW BEST DAY');
      assert.strictEqual(await page.evaluate(() => localStorage.getItem('sidurim.best')), '5500');
    });
  });

  await scenario('round 5: with little room ahead the bay line says brake, on the real car and a parked neighbour', async () => {
    await withGame('?seed=2&notitle=1&mute=1&incidents=0&contest=off&traffic=0&peds=0&errand=2', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      const put = (metres, v) => page.evaluate(([gap, speed]) => {
        const S = TLV.app.S;
        const g = S.game;
        const world = TLV.world.parking;
        const bay = world.spot(S.world, g.errand.bayId);
        const ahead = { x: bay.x + Math.cos(bay.h) * bay.len, y: bay.y + Math.sin(bay.h) * bay.len, h: bay.h, length: 4.4, width: 1.8 };
        // A stall's worth of parked car, one box along, whichever stalls this street really has.
        TLV.app.S.vehicles[1] = Object.assign(TLV.app.S.vehicles[1] || {}, ahead, { active: true, v: 0, door: 0 });
        const veh = S.vehicles[0];
        const nose = (ahead.length / 2 + gap) + veh.length / 2;
        const yaw = 0.3;
        veh.x = ahead.x - Math.cos(bay.h) * nose;
        veh.y = ahead.y - Math.sin(bay.h) * nose;
        veh.h = bay.h + yaw;
        veh.v = speed;
        g.phase = 'HOLD';
        g.park.stage = 'ARMED';
        g.park.kind = 'BAY';
        g.park.would = 'UGLY';
      }, [metres, v]);
      await put(1.5, 3.3);
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.hud-prompt'), 'BRAKE. NO ROOM LEFT.', '1.5 m at 12 km/h');
      assert.ok(await page.evaluate(() => document.querySelector('.hud-prompt').classList.contains('flash')));
      await shot(page, 'armed_brake');
      await put(5, 1.2);
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.hud-prompt'), 'CREEP. STRAIGHTEN UP.', '5 m at 4 km/h');
      assert.ok(!(await page.evaluate(() => document.querySelector('.hud-prompt').classList.contains('flash'))));
      await page.evaluate(() => TLV.ui.setLang('he'));
      await put(1.5, 3.3);
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.hud-prompt'), 'לבלום. נגמר המקום.');
      await shot(page, 'armed_brake_he');
    });
  });

  await scenario('round 5: where the door is not in a clear line the HUD shows the way, and a runner who follows it arrives', async () => {
    await withGame('?seed=130&notitle=1&mute=1&incidents=0&contest=force&knife=force&immortal=1&errand=3', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await page.evaluate(() => {
        const S = TLV.app.S;
        const spot = TLV.world.parking.spot(S.world, S.game.errand.bayId);
        TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
      });
      await step(page, 1);
      await page.evaluate(() => TLV.debug.forceKnife({ stage: 'CHASE', gap: 8 }));
      await step(page, 1);
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.tag-way'), 'the corner is marked');
      assert.strictEqual(await text(page, '.tag-way-text'), 'THIS WAY');
      assert.strictEqual(await text(page, '.knife-line'), 'RUN TO THE DOOR: GO ROUND. SPACE SIDESTEP');
      const first = await page.evaluate(() => {
        const S = TLV.app.S;
        const w = TLV.ui.hud.footWay(S, 0);
        const f = S.player.foot;
        return { left: w.left, straight: Math.hypot(S.game.errand.doorX - f.x, S.game.errand.doorY - f.y), label: document.querySelector('.hud-arrow-dist').textContent, path: w.path.length };
      });
      assert.ok(first.left > first.straight, 'the walk is longer than the bearing');
      assert.strictEqual(first.label, `door ${Math.round(first.left)} m`, 'and the figure on screen is the walk');
      assert.ok(first.path > 20, 'with a path for the minimap');
      await shot(page, 'way_start');
      await page.evaluate(() => TLV.ui.setLang('he'));
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.tag-way-text'), 'לכאן');
      await shot(page, 'way_start_he');
      await page.evaluate(() => TLV.ui.setLang('en'));
      let leftWas = Infinity;
      let fell = 0;
      let phase = null;
      let shotMid = false;
      for (let i = 0; i < 300; i++) {
        const now = await page.evaluate(() => {
          const S = TLV.app.S;
          if (S.game.phase !== 'ENCOUNTER' || S.game.knife.stage !== 'CHASE') return { phase: S.game.phase, exit: S.game.knife && S.game.knife.exit };
          const w = TLV.ui.hud.footWay(S, 0.1);
          const f = S.player.foot;
          const ax = w.round ? w.aimX : S.game.errand.doorX;
          const ay = w.round ? w.aimY : S.game.errand.doorY;
          const d = Math.hypot(ax - f.x, ay - f.y) || 1;
          TLV.debug.setInput({ footX: (ax - f.x) / d, footY: (ay - f.y) / d });
          TLV.debug.step(6);
          return { left: w.left, round: w.round };
        });
        if (now.exit !== undefined || now.phase) { phase = now.exit; break; }
        if (now.left < leftWas - 0.01) fell++;
        leftWas = now.left;
        if (!shotMid && now.left < 60) {
          shotMid = true;
          await shot(page, 'way_mid');
        }
      }
      assert.strictEqual(phase, 'REACHED_SHOP', 'the runner arrives');
      assert.ok(fell > 30, `the figure falls as they go, ${fell} times`);
    });
  });

  const FAKE_PAD = () => {
    const pad = { id: 'Fake Pad', index: 0, connected: false, mapping: 'standard', timestamp: 0, axes: [0, 0, 0, 0], buttons: [] };
    for (let i = 0; i < 17; i++) pad.buttons.push({ pressed: false, touched: false, value: 0 });
    window.__pad = pad;
    window.__press = (i, on) => { pad.buttons[i].pressed = on; pad.buttons[i].value = on ? 1 : 0; };
    navigator.getGamepads = () => [pad.connected ? pad : null, null, null, null];
  };

  await scenario('round 5: gamepad Start resumes what it paused, or what Esc paused, and one press never does both', async () => {
    await withGame('?seed=5&notitle=1&mute=1&contest=off', { init: FAKE_PAD }, async (page) => {
      await page.evaluate(() => { __pad.connected = true; });
      await toPhase(page, 'DRIVE');
      const pressStart = async (on) => {
        await page.evaluate((v) => __press(9, v), on);
        await lib.frames(page, 4);
      };
      const paused = () => page.evaluate(() => TLV.ui.isPaused());
      await pressStart(true);
      assert.strictEqual(await paused(), true, 'Start pauses');
      assert.ok(await shown(page, '.scr-pause'));
      assert.strictEqual(await text(page, '.pause-resume'), 'START back to the balagan', 'and the screen names the pad\'s button');
      await lib.frames(page, 6);
      assert.strictEqual(await paused(), true, 'held, it stays paused');
      await pressStart(false);
      assert.strictEqual(await paused(), true, 'released, it stays paused');
      await pressStart(true);
      assert.strictEqual(await paused(), false, 'Start resumes');
      await lib.frames(page, 6);
      assert.strictEqual(await paused(), false, 'and the sim\'s own read of the same press does not pause again');
      await pressStart(false);
      await page.keyboard.press('Escape');
      await lib.frames(page, 3);
      assert.strictEqual(await paused(), true, 'Esc pauses');
      await pressStart(true);
      await lib.frames(page, 6);
      assert.strictEqual(await paused(), false, 'Start resumes that too');
      await pressStart(false);
      const t0 = (await state(page)).tick;
      await lib.frames(page, 6);
      assert.ok((await state(page)).tick > t0, 'and the run goes on');
    });
  });

  await scenario('round 5: losing the window pauses a run, sound and all, and the player brings it back', async () => {
    const HIDE = () => {
      let hidden = false;
      Object.defineProperty(document, 'hidden', { get: () => hidden });
      Object.defineProperty(document, 'visibilityState', { get: () => (hidden ? 'hidden' : 'visible') });
      window.__tab = (on) => { hidden = on; document.dispatchEvent(new Event('visibilitychange')); };
    };
    await withGame('?seed=5&notitle=1&contest=off', { init: HIDE }, async (page) => {
      await toPhase(page, 'DRIVE');
      await page.keyboard.press('KeyW');
      await lib.frames(page, 2);
      assert.strictEqual(await page.evaluate(() => TLV.audio.info().state), 'running');
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.scr-pause'), 'blur: the pause screen');
      await page.waitForFunction(() => TLV.audio.info().state === 'suspended');
      const t0 = (await state(page)).tick;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await lib.frames(page, 6);
      assert.strictEqual((await state(page)).tick, t0, 'focus does not resume by itself');
      assert.ok(await shown(page, '.scr-pause'));
      await page.keyboard.press('Escape');
      await lib.frames(page, 3);
      assert.ok(!(await shown(page, '.scr-pause')), 'the player does');
      await page.waitForFunction(() => TLV.audio.info().state === 'running');
      await page.evaluate(() => __tab(true));
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.scr-pause'), 'hidden: the pause screen');
      await page.evaluate(() => __tab(false));
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.scr-pause'), 'still waiting after coming back');
      assert.strictEqual(await page.evaluate(() => TLV.audio.info().state), 'suspended');
      await page.keyboard.press('Escape');
      await lib.frames(page, 3);
      // Between runs there is nothing to pause, but a hidden tab still goes quiet, and comes back.
      await page.evaluate(() => TLV.debug.endRun('CLOCK'));
      await lib.frames(page, 3);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await lib.frames(page, 3);
      assert.ok(!(await shown(page, '.scr-pause')), 'no pause screen on the end card');
      await page.evaluate(() => __tab(true));
      await page.waitForFunction(() => TLV.audio.info().state === 'suspended');
      await page.evaluate(() => __tab(false));
      await page.waitForFunction(() => TLV.audio.info().state === 'running');
    });
    await withGame('?seed=5&notitle=1&mute=1&autoplay=idle', {}, async (page) => {
      await toPhase(page, 'DRIVE');
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await lib.frames(page, 3);
      assert.strictEqual(await page.evaluate(() => TLV.ui.isPaused()), false, 'a bot has no one to wait for');
    });
  });

  await scenario('round 5: a lost WebGL context stops the clock and says so, and a restored one carries on', async () => {
    await withGame('?seed=3&notitle=1&mute=1&contest=off', {}, async (page) => {
      await toPhase(page, 'DRIVE');
      await lib.frames(page, 3);
      await page.evaluate(() => {
        window.__ext = TLV.render.gl().getContext().getExtension('WEBGL_lose_context');
        __ext.loseContext();
      });
      await page.waitForFunction(() => TLV.ui.contextLost() !== null);
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.scr-lost'));
      assert.strictEqual(await text(page, '.lost-title'), 'THE PICTURE DROPPED OUT');
      assert.strictEqual(await text(page, '.lost-line'), 'The clock is stopped. It usually comes back by itself.');
      assert.ok(!(await shown(page, '.lost-reload')), 'no reload yet');
      const t0 = await state(page);
      await page.keyboard.press('Escape');
      await lib.frames(page, 5);
      const t1 = await state(page);
      assert.strictEqual(t1.tick, t0.tick, 'Esc does not start the clock behind a blank screen');
      assert.strictEqual(await page.evaluate(() => TLV.ui.isPaused()), true);
      await shot(page, 'lost_wait');
      await page.evaluate(() => __ext.restoreContext());
      await page.waitForFunction(() => TLV.ui.contextLost() === null);
      await lib.frames(page, 4);
      assert.ok(!(await shown(page, '.scr-lost')), 'it clears');
      const t2 = (await state(page)).tick;
      await lib.frames(page, 5);
      assert.ok((await state(page)).tick > t2, 'and the run goes on');
      await shot(page, 'lost_restored');
      // This time it never comes back.
      await page.evaluate(() => __ext.loseContext());
      await page.waitForFunction(() => TLV.ui.contextLost() !== null);
      await page.waitForFunction(() => TLV.ui.contextLost().stale, null, { timeout: 120000 });
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.lost-line'), 'Still nothing. Reloading starts the day again.');
      assert.ok(await shown(page, '.lost-reload'), 'the reload button');
      await shot(page, 'lost_reload');
      await page.evaluate(() => TLV.ui.setLang('he'));
      await lib.frames(page, 3);
      assert.strictEqual(await text(page, '.lost-line'), 'עדיין כלום. טעינה מחדש תתחיל את היום מהתחלה.');
      await shot(page, 'lost_reload_he');
      await page.evaluate(() => __ext.restoreContext());
      await page.waitForFunction(() => TLV.ui.contextLost() === null);
    });
  });

  await scenario('round 5: a phone is told it needs a keyboard or gamepad, in its own width, and a desktop is not', async () => {
    const PHONE = { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
    await withGame('?seed=5&mute=1', { context: PHONE, init: FAKE_PAD }, async (page) => {
      await lib.frames(page, 3);
      assert.strictEqual(await page.evaluate(() => innerWidth), 390, 'the page lays out at the phone\'s width');
      assert.ok(await shown(page, '.title-touch'));
      assert.match(await text(page, '.title-touch'), /KEYBOARD OR A GAMEPAD/);
      const box = await page.evaluate(() => { const r = document.querySelector('.title-touch').getBoundingClientRect(); return { l: r.left, r: r.right, fs: parseFloat(getComputedStyle(document.querySelector('.title-touch')).fontSize) }; });
      assert.ok(box.l >= 0 && box.r <= 390, 'it fits');
      assert.ok(box.fs >= 16, `and can be read, ${box.fs} px`);
      await shot(page, 'touch_title');
      await page.tap('.lang-btn:last-child');
      await lib.frames(page, 3);
      assert.match(await text(page, '.title-touch'), /מקלדת או שלט/);
      await shot(page, 'touch_title_he');
      await page.evaluate(() => { __pad.connected = true; });
      await lib.frames(page, 3);
      assert.ok(!(await shown(page, '.title-touch')), 'a pad paired: the line goes');
      await page.evaluate(() => { __pad.connected = false; });
      await lib.frames(page, 3);
      assert.ok(await shown(page, '.title-touch'), 'and back when it leaves');
      await page.keyboard.press('Shift');
      await lib.frames(page, 3);
      assert.ok(!(await shown(page, '.title-touch')), 'a real key says there is a keyboard');
    });
    await withGame('?seed=5&mute=1', {}, async (page) => {
      await lib.frames(page, 3);
      assert.ok(!(await shown(page, '.title-touch')), 'a desktop never sees it');
    });
  });

  await scenario('closeout: on the run both arrows point down the walk, and the door distance shows once', async () => {
    await withGame('?seed=130&notitle=1&mute=1&incidents=0&contest=force&knife=force&immortal=1&errand=3', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await page.evaluate(() => {
        const S = TLV.app.S;
        const spot = TLV.world.parking.spot(S.world, S.game.errand.bayId);
        TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
      });
      await step(page, 1);
      await page.evaluate(() => TLV.debug.forceKnife({ stage: 'CHASE', gap: 8 }));
      await step(page, 1);
      await lib.frames(page, 4);
      const read = () => page.evaluate(() => {
        const S = TLV.app.S;
        const e = TLV.render.effects._meshes().arrow.matrix.elements;
        return {
          mesh: Math.atan2(-e[2], e[0]), corner: TLV.ui.hud.footHeading(S), nav: S.game.nav.arrowH, yaw: TLV.ui.viewYaw(S),
          plane: document.querySelector('.hud-arrow-plane').style.transform, tag: document.querySelector('.tag-way').dataset.rel,
          label: document.querySelector('.hud-arrow-dist').textContent, door: document.querySelector('.tag-door-text').textContent
        };
      });
      const bent = await read();
      assert.ok(bent.corner !== null, 'the HUD has a corner');
      assert.ok(Math.abs(TLV_wrap(bent.corner - bent.nav)) > 0.1, `the walk leaves the bearing here ${JSON.stringify(bent)}`);
      assert.ok(Math.abs(TLV_wrap(bent.mesh - bent.corner)) < 0.01, `the scene's arrow takes the corner, not the bearing ${JSON.stringify(bent)}`);
      assert.ok(Math.abs(TLV_wrap(+bent.tag - (bent.corner - bent.yaw))) < 0.01, 'and the marker says the same');
      const rel = TLV_wrap(bent.corner - bent.yaw);
      assert.strictEqual(bent.plane, `rotateX(58deg) rotateZ(${(-rel).toFixed(3)}rad)`, 'as does the arrow of a page with no scene');
      assert.match(bent.label, /^door \d+ m$/);
      // In a clear line the arrow keeps the sim's bearing.
      const clear = await page.evaluate(() => {
        const S = TLV.app.S;
        const e = S.game.errand;
        TLV.player.setFoot ? TLV.player.setFoot(S, e.doorX + 12, e.doorY) : null;
        const f = S.player.foot;
        const grid = TLV.ui.hud.footWay(S, 0);
        return { round: grid.round, x: f.x, y: f.y };
      });
      if (!clear.round) {
        await lib.frames(page, 3);
        const c = await read();
        assert.strictEqual(c.corner, null);
        assert.ok(Math.abs(TLV_wrap(c.mesh - c.nav)) < 0.01, 'the fallback is the sim\'s heading');
      }
      // The door in view: its tag says what it marks, and the distance stays with the arrow.
      for (let i = 0; i < 300; i++) {
        const now = await page.evaluate(() => {
          const S = TLV.app.S;
          if (S.game.phase !== 'ENCOUNTER' || S.game.knife.stage !== 'CHASE') return null;
          const h = TLV.ui.hud.footHeading(S);
          const a = h === null ? S.game.nav.arrowH : h;
          TLV.debug.setInput({ footX: Math.cos(a), footY: Math.sin(a) });
          TLV.debug.step(6);
          TLV.ui.hud.footWay(S, 0.1);
          const tag = document.querySelector('.tag-door');
          return { on: tag.getClientRects().length > 0 && getComputedStyle(tag).display !== 'none', text: document.querySelector('.tag-door-text').textContent };
        });
        if (!now) break;
        await lib.frames(page, 1);
        if (now.on && now.text) {
          const twice = await page.evaluate(() => [...document.querySelectorAll('.hud-arrow-dist, .tag-door-text')].filter((n) => /\d/.test(n.textContent)).length);
          assert.strictEqual(twice, 1, 'one number');
          assert.strictEqual(await text(page, '.tag-door-text'), 'door');
          await shot(page, 'close_arrow_door_once');
          break;
        }
      }
    });
  });

  await scenario('closeout: a wallet under zero is in the loss colour, and pays back to green', async () => {
    await withGame('?seed=1&notitle=1&mute=1&contest=off', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      const colours = (m) => page.evaluate(async (money) => {
        TLV.app.S.game.money = money;
        return null;
      }, m).then(() => lib.frames(page, 2)).then(() => page.evaluate(() => ({
        got: getComputedStyle(document.querySelector('.hud-money-digits')).color,
        text: document.querySelector('.hud-money-digits').textContent,
        red: (() => { const n = document.createElement('i'); n.style.color = 'var(--tomato)'; document.body.appendChild(n); const c = getComputedStyle(n).color; n.remove(); return c; })()
      })));
      const under = await colours(-500);
      assert.match(under.text, /-/);
      assert.strictEqual(under.got, under.red);
      await shot(page, 'close_money_loss');
      const over = await colours(500);
      assert.notStrictEqual(over.got, over.red);
    });
  });

  await scenario('closeout: no pop sits under the RESOLVE card, and pausing on the card does not dismiss it, though a real key still does', async () => {
    await withGame('?seed=114&notitle=1&mute=1&incidents=0&contest=force&knife=force&immortal=1&errand=1', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await page.evaluate(() => {
        const S = TLV.app.S;
        const spot = TLV.world.parking.spot(S.world, S.game.errand.bayId);
        TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
      });
      await step(page, 1);
      await page.evaluate(() => TLV.debug.forceKnife({ stage: 'CHASE', gap: 8 }));
      await step(page, 1);
      await page.evaluate(() => { const s = TLV.debug.state(); TLV.debug.teleport(s.doorX, s.doorY, 0, 0); });
      for (let i = 0; i < 30 && (await state(page)).phase !== 'RESOLVE'; i++) await step(page, 2);
      await lib.frames(page, 3);
      assert.strictEqual((await state(page)).phase, 'RESOLVE');
      const card = (await boxes(page, '.resolve'))[0];
      const pops = await boxes(page, '.pop');
      assert.ok(pops.length >= 1, 'the bonus has its pop');
      for (const pop of pops) assert.ok(pop.t >= card.b || pop.r <= card.l, `pop under the card ${JSON.stringify({ pop, card })}`);
      await shot(page, 'close_resolve_pop');
      await page.evaluate(() => { TLV.app.S.game.phaseT = 1; });
      await page.evaluate(() => TLV.debug.resume());
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => TLV.ui.isUserPaused());
      const tick = (await state(page)).tick;
      await page.keyboard.press('KeyJ');
      await page.waitForTimeout(150);
      await page.keyboard.press('Escape');
      await page.waitForFunction((was) => !TLV.ui.isUserPaused() && TLV.debug.state().tick > was + 3, tick);
      assert.strictEqual((await state(page)).phase, 'RESOLVE', 'neither the pause key nor a key on the pause screen skips the card');
      await page.keyboard.press('KeyJ');
      await page.waitForFunction(() => TLV.debug.state().phase !== 'RESOLVE', null, { timeout: 30000 });
    });
  });

  await scenario('closeout: the paused title has the middle of the frame: the encounter line waits and comes back', async () => {
    await withGame('?seed=130&notitle=1&mute=1&incidents=0&contest=force&knife=force&immortal=1&errand=3', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      await page.evaluate(() => {
        const S = TLV.app.S;
        const spot = TLV.world.parking.spot(S.world, S.game.errand.bayId);
        TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
      });
      await step(page, 1);
      await page.evaluate(() => TLV.debug.forceKnife({ stage: 'CHASE', gap: 8 }));
      await step(page, 1);
      await lib.frames(page, 2);
      assert.ok(await shown(page, '.knife-line'));
      await page.evaluate(() => TLV.debug.resume());
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => TLV.ui.isUserPaused());
      await lib.frames(page, 2);
      assert.ok(await shown(page, '.pause-title'));
      assert.ok(!(await shown(page, '.knife-line')), 'the line is off');
      await shot(page, 'close_paused_chase');
      await page.keyboard.press('Escape');
      await page.waitForFunction(() => !TLV.ui.isUserPaused());
      await lib.frames(page, 2);
      assert.ok(await shown(page, '.knife-line'), 'and back');
    });
  });

  await scenario('closeout: Q out of reach of the door gets an answer once per press, and in reach the bar is the answer', async () => {
    await withGame('?seed=1&notitle=1&mute=1&contest=off&traffic=0&peds=0', {}, async (page) => {
      await held(page);
      await toPhase(page, 'DRIVE');
      const toasts = () => page.evaluate(() => [...document.querySelectorAll('.toast')].map((n) => n.textContent));
      await page.evaluate(() => { const s = TLV.debug.state(); assert_far: { const d = Math.hypot(s.player.x - s.doorX, s.player.y - s.doorY); if (d < 200) throw new Error('start too near the door ' + d); } });
      await page.keyboard.down('KeyQ');
      await step(page, 3);
      await lib.frames(page, 2);
      assert.deepStrictEqual((await toasts()).filter((x) => /near the door/.test(x)).length, 1, 'answered');
      assert.strictEqual((await state(page)).phase, 'DRIVE');
      await shot(page, 'close_q_far');
      await page.evaluate(() => { const v = TLV.ui.hud._view(); v.toasts.forEach((x) => { x.t = 0; }); });
      await lib.frames(page, 2);
      await step(page, 60);
      await lib.frames(page, 3);
      assert.deepStrictEqual((await toasts()).filter((x) => /near the door/.test(x)).length, 0, 'held on, it does not nag');
      await page.keyboard.up('KeyQ');
      await step(page, 1);
      await lib.frames(page, 2);
      await page.evaluate(() => { const s = TLV.debug.state(); TLV.debug.teleport(s.doorX + 30, s.doorY, 0, 0); });
      await step(page, 2);
      await lib.frames(page, 2);
      await page.keyboard.down('KeyQ');
      await step(page, 3);
      await lib.frames(page, 2);
      assert.strictEqual((await state(page)).phase, 'HOLD', 'in reach it parks');
      assert.deepStrictEqual((await toasts()).filter((x) => /near the door/.test(x)).length, 0);
      await page.keyboard.up('KeyQ');
    });
  });

  await scenario('closeout: the credits hide what is behind them', async () => {
    await withGame('?seed=1&mute=1', {}, async (page) => {
      await page.waitForSelector('.scr-title');
      await page.keyboard.press('KeyI');
      await page.waitForFunction(() => document.querySelector('.scr-credits') && document.querySelector('.scr-credits').getClientRects().length > 0);
      const alpha = await page.evaluate(() => {
        const m = getComputedStyle(document.querySelector('.scr-credits')).backgroundColor.match(/rgba?\((.+)\)/)[1].split(',').map(Number);
        return m.length > 3 ? m[3] : 1;
      });
      assert.ok(alpha >= 0.95, `alpha ${alpha}`);
      await shot(page, 'close_credits');
    });
  });

  await scenario('closeout: with no graphics the page says so in plain words in both languages, and the error on a working machine stays technical', async () => {
    const noGl = () => {
      const real = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return /webgl/.test(type) ? null : real.call(this, type, ...rest);
      };
    };
    const webgl1 = () => {
      const real = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return type === 'webgl2' ? null : real.call(this, type, ...rest);
      };
    };
    const refused = () => {
      HTMLCanvasElement.prototype.getContext = function (type) {
        if (/webgl/.test(type)) throw new Error('blocked by policy');
        return null;
      };
    };
    for (const [name, init] of [['none', noGl], ['webgl1', webgl1], ['throwing', refused]]) {
      const t = await lib.open('?seed=3&mute=1', { init, noBoot: true });
      try {
        await t.page.waitForSelector('.ui-error.no-graphics', { timeout: 120000 });
        const seen = await t.page.evaluate(() => {
          const p = document.querySelector('.ui-error-plain');
          return { text: p.innerText, lines: [...p.children].map((n) => n.textContent), body: getComputedStyle(document.querySelector('.ui-error-body')).display };
        });
        assert.strictEqual(seen.lines.length, 2, name);
        assert.match(seen.lines[0], /[֐-׿]/, 'Hebrew');
        assert.match(seen.lines[1], /3D graphics/, 'English');
        assert.doesNotMatch(seen.text, /WebGL|Boot failed|context/, 'no jargon');
        assert.strictEqual(seen.body, 'none', 'the technical line is out of sight');
        await shot(t.page, `close_nographics_${name}`);
      } finally {
        await t.close();
      }
    }
    await withGame('?seed=3&mute=1&notitle=1', {}, async (page) => {
      await held(page);
      await page.evaluate(() => TLV.ui.showError('Boot failed: render bug'));
      assert.ok(await shown(page, '.ui-error-body'), 'a working machine keeps the technical line');
      assert.strictEqual(await text(page, '.ui-error-plain'), '');
      await page.evaluate(() => document.querySelector('.ui-error-close').click());
    });
  });

  await scenario('closeout: a tap shorter than a frame still restarts from the end screen', async () => {
    for (const code of ['Enter', 'KeyR']) {
      await withGame('?seed=1&notitle=1&mute=1&contest=off', {}, async (page) => {
        await held(page);
        await toPhase(page, 'DRIVE');
        await page.evaluate(() => { TLV.app.S.game.clock = 0.02; });
        await toPhase(page, 'RUN_END');
        await step(page, 5);
        const tap = (c) => page.evaluate((k) => {
          window.dispatchEvent(new KeyboardEvent('keydown', { code: k, bubbles: true }));
          window.dispatchEvent(new KeyboardEvent('keyup', { code: k, bubbles: true }));
        }, c);
        await tap(code);
        await step(page, 2);
        assert.notStrictEqual((await state(page)).phase, 'RUN_END', `${code} between two frames`);
        const c = await page.evaluate(() => Object.assign({}, TLV.app.S.controls));
        assert.strictEqual(c.restart, false, 'for one tick only');
      });
    }
  });

  await scenario('importReplay path: a second init on a new sim rebuilds cleanly', async () => {
    await withGame('?seed=1&notitle=1&mute=1', {}, async (page) => {
      await held(page);
      await page.evaluate(() => {
        TLV.ui.init(document.getElementById('ui-root'), TLV.app.S);
      });
      await lib.frames(page, 3);
      assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.hud').length), 1);
      assert.strictEqual(await page.evaluate(() => document.querySelectorAll('.scr-title').length), 1);
    });
  });

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length} of ${results.length} pass. Screenshots: ${SHOTS}`);
  process.exitCode = failed.length ? 1 : 0;
}

function TLV_wrap(a) {
  let x = a;
  while (x > Math.PI) x -= 2 * Math.PI;
  while (x <= -Math.PI) x += 2 * Math.PI;
  return x;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
