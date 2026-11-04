// tests/e2e/lib/harness.cjs — WP-CORE
// Scenario runner for the *.e2e.cjs scripts, which run directly with node, outside node:test. Every browser closes in a
// finally. A skip is printed as a skip, and a script with only skips exits 77, so nothing can mistake it for a pass.
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pw = require('../../../tools/lib/pw.cjs');
const stubTree = require('./stub_tree.cjs');

const EXIT_ONLY_SKIPPED = 77;

const results = [];
const temps = [];

// On exit, not in finish, so a run cut short still leaves nothing behind.
process.on('exit', () => {
  for (const dir of temps) fs.rmSync(dir, { recursive: true, force: true });
});

/** Runs one named scenario. A failure is recorded and the next one still runs. */
async function scenario(name, fn) {
  const started = Date.now();
  try {
    await fn();
    results.push({ name, status: 'PASS' });
    console.log(`PASS  ${name} (${((Date.now() - started) / 1000).toFixed(1)} s)`);
  } catch (e) {
    results.push({ name, status: 'FAIL', detail: e.stack || String(e) });
    console.log(`FAIL  ${name}\n${e.stack || e}`);
  }
}

/** Records a scenario that could not run, with the reason. */
function skip(name, reason) {
  results.push({ name, status: 'SKIP', detail: reason });
  console.log(`SKIP  ${name}: ${reason}`);
}

/** Opens the game, runs fn, and always closes the browser. */
async function withPage(opts, fn) {
  const session = await pw.open(opts);
  try {
    return await fn(session);
  } finally {
    await session.browser.close();
  }
}

/** @returns {string} A new temp directory, removed by finish. */
function tempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `tlv-e2e-${label}-`));
  temps.push(dir);
  return dir;
}

/** Saves a named screenshot. They go to $TLV_SHOTS or a temp directory, never the project (ARCHITECTURE 17.1). */
async function shot(page, name) {
  const dir = process.env.TLV_SHOTS || path.join(os.tmpdir(), 'tlv-e2e-shots');
  fs.mkdirSync(dir, { recursive: true });
  await pw.screenshot(page, path.join(dir, `${name}.png`));
}

/**
 * Picks the tree to test: the real project, or with --stub a stub tree that proves only the script itself.
 * @returns {{root:string, stub:boolean, absent:string[]}} Tree, and what it lacks for a full boot.
 */
function pickTree() {
  if (process.argv.includes('--stub')) {
    console.log('NOTE  --stub: running on a stub tree. This proves the test script, not the game.');
    return { root: stubTree.stubbed(tempDir('stub')), stub: true, absent: [] };
  }
  return { root: pw.PROJECT_ROOT, stub: false, absent: stubTree.missingFiles(pw.PROJECT_ROOT) };
}

/** Prints the summary and sets the exit code. */
function finish() {
  const count = (status) => results.filter((r) => r.status === status).length;
  console.log(`\n${count('PASS')} passed, ${count('FAIL')} failed, ${count('SKIP')} skipped`);
  for (const r of results.filter((x) => x.status === 'SKIP')) console.log(`  skipped: ${r.name}: ${r.detail}`);
  if (count('FAIL')) process.exitCode = 1;
  else if (count('PASS') === 0) process.exitCode = EXIT_ONLY_SKIPPED;
}

/**
 * Loads the sim with no render, no UI and no index.html into a blank page of an open browser, and creates a sim there.
 * It is the browser twin of createTLV and createSim: same engine as the game, so hashes compare exactly.
 * @param {object} browser Open Playwright browser.
 * @param {string} root Tree.
 * @param {{params:object, log:?object}} opts Params for the sim. With log, the sim replays it with no bot.
 * @returns {Promise<object>} The page. TLV.debug hooks act on the new sim.
 */
async function simOnlyPage(browser, root, { params, log = null }) {
  const page = await browser.newPage();
  await page.goto('about:blank');
  const load = (files) => files.reduce(
    (done, file) => done.then(() => (fs.existsSync(path.join(root, file)) ? page.addScriptTag({ path: path.join(root, file) }) : null)),
    Promise.resolve()
  );
  await load(['js/core/namespace.js', 'js/manifest.js']);
  await load([...(await page.evaluate(() => TLV.manifest.sim)), 'data/maps/index.js', 'content/index.js']);
  const { map, content } = await page.evaluate(() => {
    const id = TLV.mapIndex.default;
    return { map: TLV.mapIndex.maps[id].src, content: TLV.contentFiles[id] || TLV.contentFiles.default };
  });
  await load([map, ...content]);
  await page.evaluate(({ params: p, log: l }) => {
    TLV.params = TLV.config.normalize(p);
    ['world', 'player', 'traffic', 'peds', 'game'].forEach((pkg) => TLV[pkg].register());
    TLV.registry.drain();
    TLV.debug.use(TLV.sim.create({
      seed: TLV.params.seed,
      world: TLV.world.get(TLV.params.map),
      params: TLV.params,
      controlSource: l ? TLV.replay.createPlayer(l) : undefined
    }));
  }, { params, log });
  return page;
}

/** Errors a healthy page must not print. */
function consoleErrors(logs) {
  return [...logs.errors, ...logs.console.filter((m) => m.type === 'error').map((m) => m.text)];
}

module.exports = { scenario, skip, withPage, simOnlyPage, tempDir, shot, pickTree, finish, consoleErrors, EXIT_ONLY_SKIPPED };
