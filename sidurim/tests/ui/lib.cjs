// tests/ui/lib.cjs — WP-UI
// Opens the real page for UI tests. While WP-RENDER has not landed its files are served as empty scripts and a small stand-in gives
// TLV.render.project, camera.yaw and a painted canvas, so the HUD can be judged over something. When the real render is there, it is
// used as it stands and this stand-in does nothing.
'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const pw = require('../../tools/lib/pw.cjs');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8'
};

/** The stand-in, used only if no real renderer loaded. It projects as a simple top-down chase view and paints a street. */
const STAND_IN = `
(function () {
  var box = setInterval(function () {
    var TLV = window.TLV;
    if (!TLV || !TLV.app || !TLV.app.boot || window.__wrapped) return;
    window.__wrapped = true;
    clearInterval(box);
    var boot = TLV.app.boot;
    TLV.app.boot = function () {
      if (!TLV.render || !TLV.render.init) {
        window.__standIn = true;
        var R = TLV.render = TLV.render || {};
        R.init = function (canvas) {
          canvas.width = 1280; canvas.height = 720;
          var g = canvas.getContext('2d');
          var sky = g.createLinearGradient(0, 0, 0, 720);
          sky.addColorStop(0, '#9fd6ec'); sky.addColorStop(0.45, '#ffe6bd'); sky.addColorStop(0.46, '#8c8f93'); sky.addColorStop(1, '#55585e');
          g.fillStyle = sky; g.fillRect(0, 0, 1280, 720);
          g.fillStyle = '#e8b88a'; g.fillRect(40, 120, 330, 210); g.fillRect(900, 90, 340, 240);
          g.fillStyle = '#d58e6c'; g.fillRect(380, 200, 180, 130); g.fillRect(720, 180, 170, 150);
          g.fillStyle = '#fff'; for (var i = 0; i < 6; i++) g.fillRect(630, 350 + i * 62, 18, 36);
          g.fillStyle = '#fff'; g.fillRect(560, 560, 160, 90); g.fillStyle = '#7fd0e6'; g.fillRect(585, 572, 110, 34);
        };
        R.frame = function () {};
        R.onEvent = function (n, p) { (window.__renderEvents = window.__renderEvents || []).push(n); };
        R.project = function (x, y, z, out) {
          var S = TLV.app.S; var p = S.player; var yaw = R.camera.yaw();
          var dx = x - p.fx; var dy = y - p.fy;
          var ahead = dx * Math.cos(yaw) + dy * Math.sin(yaw);
          var right = dx * Math.sin(yaw) - dy * Math.cos(yaw);
          var d = ahead + 12;
          if (d < 1) { out.visible = false; return out; }
          out.sx = 640 + right / d * 700; out.sy = 610 - (z + 3) / d * 700 + 180; out.visible = out.sx > 0 && out.sx < 1280 && out.sy > 0 && out.sy < 720;
          return out;
        };
        R.camera = { yaw: function () { var S = TLV.app.S; return S.player.mode === 'FOOT' ? S.player.foot.h : S.vehicles[0].h; }, toggleParking: function () {} };
      }
      return boot.apply(this, arguments);
    };
  }, 0);
})();
`;

/**
 * Serves the project, answering a missing script with an empty one, because the error overlay for files of another package is not
 * what these tests look at.
 * @returns {Promise<{url:string, close:function():Promise<void>}>} Server.
 */
function serve() {
  const root = pw.PROJECT_ROOT;
  const server = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    const file = path.join(root, rel === '/' ? 'index.html' : rel);
    if (file !== root && !file.startsWith(root + path.sep)) {
      res.writeHead(403);
      res.end();
      return;
    }
    fs.readFile(file, (err, data) => {
      if (err) {
        if (rel.endsWith('.js')) {
          res.writeHead(200, { 'content-type': MIME['.js'] });
          res.end(rel === '/data/assets/index.js' ? 'TLV.assetIndex = {};' : '');
          return;
        }
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
 * @param {string} params Query string.
 * @param {object} [opts] { init: function run in the page first, routes: async function(page) to set request routes, viewport, context: more of Playwright's page options, noBoot: return without waiting for a running game }.
 * @returns {Promise<{page:object, browser:object, close:function, errors:string[], consoleErrors:string[]}>} Handles.
 */
async function open(params, opts = {}) {
  const { chromium } = require('/home/g/tagger/node_modules/playwright');
  const server = await serve();
  const browser = await chromium.launch({ headless: true, args: pw.LAUNCH_ARGS });
  const page = await browser.newPage({ viewport: opts.viewport || { width: 1280, height: 720 }, ...(opts.context || {}) });
  page.setDefaultTimeout(240000);
  const errors = [];
  const consoleErrors = [];
  page.on('pageerror', (e) => errors.push(String(e && e.stack ? e.stack : e)));
  page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
  await page.addInitScript(STAND_IN);
  if (opts.init) await page.addInitScript(opts.init);
  if (opts.routes) await opts.routes(page);
  // Low quality only keeps software GL moving. The final screenshots ask for what a player gets, with opts.quality.
  const query = (params || '?') + (/quality=/.test(params || '') || opts.quality === false ? '' : '&quality=low');
  await page.goto(server.url + query);
  if (!opts.noBoot) await page.waitForFunction(() => window.TLV && TLV.app && TLV.app.S && TLV.ui && document.querySelector('.hud'), null, { timeout: 180000 });
  return {
    page, browser, errors, consoleErrors, url: server.url,
    close: async () => {
      await browser.close();
      await server.close();
    }
  };
}

/**
 * Presses a key for as long as it takes the sim to read it. A tap shorter than a software-GL frame falls between ticks.
 * @param {object} page Playwright page.
 * @param {string} key Key name.
 */
async function press(page, key) {
  await page.keyboard.down(key);
  await frames(page, 2);
  await page.keyboard.up(key);
}

/** Waits for n drawn UI frames, however slow software GL is. */
async function frames(page, n) {
  await page.evaluate((count) => new Promise((resolve) => {
    let left = count;
    const tick = () => { if (--left <= 0) resolve(); else requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
  }), n);
}

module.exports = { open, frames, serve, press };
