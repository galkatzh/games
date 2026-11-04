// tests/e2e/smoke.e2e.cjs — WP-CORE
// Run: node tests/e2e/smoke.e2e.cjs [--stub]
//
// ARCHITECTURE 20.4: ?autoplay=errands&seed=1 completes at least one errand, with traffic and pedestrians on. Ticks are
// stepped synchronously, because software GL is far too slow to wait for. It exits 77 while the tree is incomplete.
'use strict';

const assert = require('node:assert');

const pw = require('../../tools/lib/pw.cjs');
const { scenario, skip, withPage, pickTree, shot, finish, consoleErrors } = require('./lib/harness.cjs');

/** Longest the bot may take, in sim seconds. The clock is not the limit: the run may end, and that counts as a failure. */
const MAX_SIM_S = 300;
const STEP_TICKS = 300;

async function main() {
  const { root, stub, absent } = pickTree();
  const name = 'autoplay=errands completes an errand with traffic and pedestrians on';
  if (absent.length) {
    skip(name, `${absent.length} files not built yet, first: ${absent[0]}`);
    return;
  }

  await scenario(name, async () => {
    await withPage({ root, params: '?autoplay=errands&seed=1&notitle=1&mute=1' }, async ({ page, logs }) => {
      await pw.waitForTick(page, 1);
      await page.evaluate(() => TLV.debug.pause());

      let state = null;
      let sawCars = 0;
      let sawPeople = 0;
      for (let t = 0; t < MAX_SIM_S; t += STEP_TICKS / 60) {
        await page.evaluate((n) => TLV.debug.step(n), STEP_TICKS);
        state = await page.evaluate(() => TLV.debug.state());
        sawCars = Math.max(sawCars, state.counts.vehicles);
        sawPeople = Math.max(sawPeople, state.counts.peds);
        if (state.stats.errandsDone >= 1 || state.phase === 'RUN_END') break;
      }
      assert.ok(state.stats.errandsDone >= 1, `no errand done after ${state.t.toFixed(0)} s: phase ${state.phase}, end ${state.endReason}`);
      assert.ok(sawCars > 0, 'traffic is on');
      assert.ok(sawPeople > 0, 'pedestrians are on');
      assert.strictEqual(state.invariantFailures, 0);
      assert.deepStrictEqual(consoleErrors(logs), []);
      assert.deepStrictEqual(logs.blocked, []);
      console.log(`      errand done at ${state.t.toFixed(1)} s, up to ${sawCars} cars and ${sawPeople} people${stub ? ' (stub tree)' : ''}`);
      await shot(page, `smoke${stub ? '_stub' : ''}`);
    });
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(finish);
