// tests/render/actors_lib.cjs — RENDER-ACTORS
// Opens the real game through the real loader, and the small helpers the actor tests share.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const pw = require('../../tools/lib/pw.cjs');

const SHOTS = process.env.ACTOR_SHOTS || '/tmp/claude-1000/-home-g-driving/7d0e940b-740b-4c31-bf9f-0ac5b0e38ad7/scratchpad/shots';

/** @returns {Promise<object>} pw.open result, booted. */
async function openGame(params, opts = {}) {
  // These scenes were written against the shadows and range of high. With no quality named, software GL now starts on low, and the
  // budgets here would read a smaller scene than they mean to.
  const url = /[?&]quality=/.test(params) ? params : params + '&quality=high';
  const g = await pw.open(Object.assign({ params: url, server: true }, opts));
  await g.page.waitForFunction(() => window.TLV && TLV.app && TLV.app.S && TLV.debug && TLV.debug.state && TLV.render && TLV.render.camera && TLV.render.camera.object, null, { timeout: 180000 });
  return g;
}

/** Waits for n real rendered frames, so that a screenshot shows what the sim says now. */
async function frames(page, n = 2) {
  await page.evaluate((count) => new Promise((resolve) => {
    let left = count;
    function tick() {
      left--;
      if (left <= 0) resolve();
      else requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }), n);
}

/** Gets to DRIVE from a fresh run and pauses there. */
async function toDrive(page) {
  await page.evaluate(() => { TLV.debug.pause(); TLV.debug.setInput(null); });
  for (let i = 0; i < 60; i++) {
    const phase = await page.evaluate(() => { TLV.debug.step(30); return TLV.debug.state().phase; });
    if (phase === 'DRIVE') return;
  }
  throw new Error('never reached DRIVE');
}

/** Saves a screenshot under the scratchpad. */
async function shot(page, name) {
  fs.mkdirSync(SHOTS, { recursive: true });
  const file = path.join(SHOTS, name + '.png');
  await pw.screenshot(page, file);
  return file;
}

/** Fails on any page error or console error. */
function assertClean(logs, allow = /ERR_FILE_NOT_FOUND|Failed to load resource/) {
  const bad = logs.logs.errors.slice();
  for (const m of logs.logs.console) if (m.type === 'error' && !allow.test(m.text)) bad.push(m.text);
  if (bad.length) throw new Error('console errors:\n' + bad.slice(0, 10).join('\n'));
}

module.exports = { openGame, frames, toDrive, shot, assertClean, SHOTS };
