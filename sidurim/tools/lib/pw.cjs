// tools/lib/pw.cjs — WP-CORE
// Playwright wrapper for browser tests (ARCHITECTURE 5). Playwright is found by absolute path, it is not a dependency.
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const { chromium } = require('/home/g/tagger/node_modules/playwright');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

/** Software GL: slow, so tests assert ticks and state, never frame rate. */
const LAUNCH_ARGS = ['--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blocklist', '--enable-unsafe-swiftshader'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8'
};

/**
 * Starts a static file server on a free local port.
 * @param {string} root Directory to serve.
 * @returns {Promise<{url:string, close:function():Promise<void>}>} Server handle.
 */
function serve(root) {
  const base = path.resolve(root);
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.join(base, rel === '/' ? 'index.html' : rel);
    if (file !== base && !file.startsWith(base + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404);
        res.end();
        return;
      }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}/`,
        close: () => new Promise((done) => {
          server.closeAllConnections();
          server.close(() => done());
        })
      });
    });
  });
}

/**
 * Opens the game.
 * @param {object} [opts]
 * @param {string} [opts.params] Query string, for example '?seed=1&notitle=1'.
 * @param {boolean} [opts.server] Use a local static server instead of file://. It stops when the browser closes.
 * @param {string} [opts.root] Directory holding index.html. Default: this project.
 * @param {boolean} [opts.blockNetwork] Abort every request that leaves the game's own origin. Default true.
 * @param {{width:number,height:number}} [opts.viewport] Default 1280 x 720.
 * @param {boolean} [opts.goto] Navigate to the game. Default true.
 * @param {function():void} [opts.init] Runs in the page before any of its scripts.
 * @param {function(object):Promise<void>} [opts.before] Runs in Node before navigating, with the page, to set up routes.
 * @returns {Promise<{browser:object, page:object, url:string, logs:{console:object[], errors:string[], blocked:string[]}}>}
 *   logs fill as the page runs: console messages, uncaught page errors, and requests the block aborted.
 */
async function open(opts = {}) {
  const root = opts.root || PROJECT_ROOT;
  const server = opts.server ? await serve(root) : null;
  const base = server ? server.url : pathToFileURL(path.join(path.resolve(root), 'index.html')).href;
  const url = base + (opts.params || '');

  const browser = await chromium.launch({ headless: true, args: LAUNCH_ARGS });
  if (server) browser.on('disconnected', () => { server.close(); });

  const page = await browser.newPage({ viewport: opts.viewport || { width: 1280, height: 720 } });
  const logs = { console: [], errors: [], blocked: [] };
  page.on('console', (msg) => logs.console.push({ type: msg.type(), text: msg.text() }));
  page.on('pageerror', (err) => logs.errors.push(String(err && err.stack ? err.stack : err)));

  if (opts.blockNetwork !== false) {
    const origin = server ? server.url : 'file://';
    await page.route('**/*', (route) => {
      const target = route.request().url();
      if (target.startsWith(origin) || target.startsWith('data:')) return route.continue();
      logs.blocked.push(target);
      return route.abort();
    });
  }
  if (opts.init) await page.addInitScript(opts.init);
  if (opts.before) await opts.before(page);
  if (opts.goto !== false) await page.goto(url);
  return { browser, page, url, logs };
}

/**
 * Waits until TLV.debug.state().tick reaches a value.
 * @param {object} page Playwright page.
 * @param {number} tick Tick to reach.
 * @param {object} [opts]
 * @param {number} [opts.timeoutMs] Default 120000, because software GL runs well below real time.
 * @returns {Promise<number>} The tick reached.
 */
async function waitForTick(page, tick, opts = {}) {
  const timeoutMs = opts.timeoutMs || 120000;
  const end = Date.now() + timeoutMs;
  let last = null;
  for (;;) {
    last = await page.evaluate(() => {
      const hooks = window.TLV && window.TLV.debug;
      const state = hooks && hooks.state ? hooks.state() : null;
      return state ? state.tick : null;
    });
    if (last !== null && last >= tick) return last;
    if (Date.now() > end) {
      const screen = await page.evaluate(() => {
        const root = document.getElementById('ui-root');
        return root ? root.textContent.slice(0, 400) : '';
      });
      throw new Error(`waitForTick: tick ${last} never reached ${tick} in ${timeoutMs} ms. Screen: ${screen}`);
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * page.screenshot that survives a page with nothing animating. Chromium can answer "Unable to capture screenshot" until it
 * has produced a frame, which is common on a static overlay. Measured: the first call failed and the next succeeded.
 * @param {object} page Playwright page.
 * @param {string} file Output path.
 * @returns {Promise<void>} Resolves once the file is written.
 */
async function screenshot(page, file) {
  for (let attempt = 1; ; attempt++) {
    try {
      await page.screenshot({ path: file });
      return;
    } catch (e) {
      if (attempt === 5) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
}

// chromium itself is exported for the scripts that need two pages in one context, which open() does not make.
module.exports = { open, waitForTick, screenshot, serve, chromium, LAUNCH_ARGS, PROJECT_ROOT };
