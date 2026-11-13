// tests/e2e/lib/two_drivers.cjs — WP-NET
// Two drivers in one browser, for the shared-day scripts. Both pages are held paused and stepped by hand, as every browser test here
// does, because software GL runs far below real time and a page that is not in front draws about once a second. Messages are sent by
// calling TLV.net.frame after each step, so nothing waits for a frame either.
'use strict';

const pw = require('../../../tools/lib/pw.cjs');

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Follows a page's console and errors, and stops every request that leaves the game's own origin. */
async function watch(page, origin, logs) {
  page.on('console', (msg) => logs.console.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', (err) => logs.errors.push(String(err && err.stack ? err.stack : err)));
  await page.route('**/*', (route) => {
    const target = route.request().url();
    if (target.startsWith(origin) || target.startsWith('data:')) return route.continue();
    logs.blocked.push(target);
    return route.abort();
  });
}

/**
 * Opens the game twice, from a local server, in one browser context.
 * @param {string} params Query string for both pages.
 * @param {{settleMs?:number}} [opts] How long a message is given to cross between the pages. A BroadcastChannel needs little, a data
 * channel more.
 * @returns {Promise<object>} { browser, a, b, logs, run, frame, state, close }.
 */
async function open(params, opts = {}) {
  const settleMs = opts.settleMs || 40;
  // One context, so the two pages share an origin's BroadcastChannel. pw.open gives each page a context of its own.
  const server = await pw.serve(pw.PROJECT_ROOT);
  const browser = await pw.chromium.launch({ headless: true, args: pw.LAUNCH_ARGS });
  browser.on('disconnected', () => { server.close(); });
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const url = server.url + params;
  const logs = { console: [], errors: [], blocked: [] };
  const pages = [];
  for (let i = 0; i < 2; i++) {
    const page = await context.newPage();
    await watch(page, server.url, logs);
    await page.goto(url);
    pages.push(page);
  }
  const [a, b] = pages;
  for (const page of pages) {
    await page.waitForFunction(() => window.TLV && TLV.app && TLV.app.S && TLV.app.S.game && TLV.app.loop, null, { timeout: 120000 });
    await page.evaluate(() => TLV.debug.pause());
  }

  /** Sends what each sim has queued, and gives it time to arrive. */
  async function flush() {
    for (const page of pages) await page.evaluate(() => TLV.net.frame(TLV.app.S));
    await wait(settleMs);
  }

  /** Steps both sims, a few ticks at a time, carrying messages between them. */
  async function run(ticks, chunk = 5) {
    await flush();
    for (let done = 0; done < ticks; done += chunk) {
      const n = Math.min(chunk, ticks - done);
      for (const page of pages) await page.evaluate((k) => TLV.debug.step(k), n);
      await flush();
    }
  }

  /** Steps until a test holds on a page. */
  async function until(page, test, seconds, what) {
    for (let t = 0; t < seconds * 60; t += 10) {
      if (await page.evaluate(test)) return;
      await run(10);
    }
    throw new Error(`${what}: not in ${seconds} sim seconds. ${JSON.stringify(await state(page))}`);
  }

  /** Draws a UI frame on a page, so the DOM is what the sim now says. */
  const frame = (page) => page.evaluate(() => TLV.ui.frame(TLV.app.S, 1, 0.016));

  const state = (page) => page.evaluate(() => {
    const S = TLV.app.S;
    const v = TLV.game.versus.view(S);
    return {
      phase: S.game.phase, end: S.game.endReason, money: Math.round(S.game.money), errand: S.game.errand ? S.game.errand.defId : null,
      on: v.on, open: v.open, pick: v.pick, left: v.left, total: v.total, round: v.round, ready: v.ready,
      peers: v.peers.map((p) => ({ compatible: p.compatible, money: p.money, pick: p.pick, ended: p.ended, ready: p.ready })),
      net: TLV.net.state()
    };
  });

  return { browser, a, b, pages, logs, run, until, flush, frame, state, close: () => browser.close() };
}

/** Reads a node's text, or null when it is hidden or not there. */
const text = (page, selector) => page.evaluate((sel) => {
  const node = document.querySelector(sel);
  if (!node || node.closest('.off')) return null;
  return node.textContent;
}, selector);

/** A's room, opened from the title, and B typing its code. @returns {Promise<string>} The code. */
async function meet(two) {
  const { a, b } = two;
  await a.keyboard.press('KeyO');
  await a.keyboard.press('KeyH');
  await a.waitForFunction(() => TLV.net.state().status === 'open', null, { timeout: 60000 });
  const code = await a.evaluate(() => TLV.net.state().room);
  await b.keyboard.press('KeyO');
  await b.keyboard.press('KeyJ');
  for (const letter of code) await b.keyboard.press(`Key${letter}`);
  await b.waitForFunction(() => TLV.net.state().status === 'open', null, { timeout: 60000 });
  return code;
}

module.exports = { open, meet, text, wait };
