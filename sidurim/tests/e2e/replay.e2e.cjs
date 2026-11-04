// tests/e2e/replay.e2e.cjs — WP-CORE
// Run: node tests/e2e/replay.e2e.cjs [--stub]
//
// ARCHITECTURE 20.7 and 20.8: a 60 s log from a ?record=1&autoplay=patrol run replays with no bot to the same hash, and the
// same seed gives the same hash with and without render. It exits 77 while the tree is incomplete.
//
// Two engines are involved, and they are compared differently. Chromium's V8 and Node 21's V8 give different last bits for
// Math.sin, cos, atan2, exp, log and pow [M, 200,000 inputs each], and section 3 promises identity only within one engine:
//  - Same engine: a blank Chromium page with no render holds the exact TLV.sim.hash to the game page's value.
//  - Node: the float32 hash, which absorbs those last bits and still catches any real divergence.
'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const pw = require('../../tools/lib/pw.cjs');
const { scenario, skip, withPage, simOnlyPage, pickTree, tempDir, finish, consoleErrors } = require('./lib/harness.cjs');

const TICKS = 3600;
const SEED = 1;
const NODE_SIDE = path.join(__dirname, 'lib', 'replay_node.mjs');

/** Runs the Node half. @returns {{hash:number, hashFloat32:number, tick:number}} */
function inNode(args) {
  const r = spawnSync(process.execPath, [NODE_SIDE, ...args], { encoding: 'utf8', shell: false });
  assert.strictEqual(r.status, 0, r.stderr);
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

/** Steps a page with paused or no loop to a tick and reads both hashes. */
async function hashesAt(page, tick) {
  await page.evaluate((n) => TLV.debug.step(n - TLV.debug.state().tick), tick);
  return page.evaluate(() => {
    const S = TLV.debug.current();
    return { tick: S.tick, hash: TLV.sim.hash(S), hashFloat32: TLV.sim._hashFloat32(S) };
  });
}

async function main() {
  const { root, absent } = pickTree();
  const names = {
    replay: 'a 60 s log replays with no bot and no render, to the same exact hash, in the same engine',
    render: 'the same seed gives the same exact hash with and without render, in the same engine',
    replayNode: 'that log replays in Node with no bot, to the same float32 hash',
    renderNode: 'the same seed in Node, with no render, gives the same float32 hash'
  };
  if (absent.length) {
    const reason = `${absent.length} files not built yet, first: ${absent[0]}`;
    for (const name of Object.values(names)) skip(name, reason);
    return;
  }

  const query = `?record=1&autoplay=patrol&seed=${SEED}&notitle=1&mute=1`;
  await withPage({ root, params: query }, async ({ browser, page, logs }) => {
    await pw.waitForTick(page, 1);
    await page.evaluate(() => TLV.debug.pause());
    const game = await hashesAt(page, TICKS);
    assert.strictEqual(game.tick, TICKS);
    assert.deepStrictEqual(consoleErrors(logs), []);
    const log = await page.evaluate(() => TLV.debug.exportReplay());
    const params = await page.evaluate(() => TLV.params);
    const file = path.join(tempDir('replay'), 'log.json');
    fs.writeFileSync(file, JSON.stringify(log));

    await scenario(names.replay, async () => {
      const blank = await simOnlyPage(browser, root, { params: { ...log.header.params, autoplay: null }, log });
      assert.strictEqual((await hashesAt(blank, TICKS)).hash, game.hash);
      await blank.close();
    });

    await scenario(names.render, async () => {
      const blank = await simOnlyPage(browser, root, { params });
      assert.strictEqual((await hashesAt(blank, TICKS)).hash, game.hash);
      await blank.close();
    });

    await scenario(names.replayNode, async () => {
      const replayed = inNode(['--root', root, '--replay', file]);
      assert.strictEqual(replayed.tick, TICKS);
      assert.strictEqual(replayed.hashFloat32, game.hashFloat32);
    });

    await scenario(names.renderNode, async () => {
      const headless = inNode(['--root', root, '--seed', String(SEED), '--ticks', String(TICKS), '--bot', 'patrol']);
      assert.strictEqual(headless.hashFloat32, game.hashFloat32);
    });
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(finish);
