// tests/e2e/knife.e2e.cjs — WP-CORE
// Run: node tests/e2e/knife.e2e.cjs [--stub]
//
// ARCHITECTURE 20.5: forceKnife, then all four exits, with screenshots. Each exit starts a fresh run in one page. Input comes
// from setInput and the debug hooks only, as a player's would. It exits 77 while the tree is incomplete.
'use strict';

const assert = require('node:assert');

const pw = require('../../tools/lib/pw.cjs');
const { scenario, skip, withPage, pickTree, shot, finish, consoleErrors } = require('./lib/harness.cjs');

const STEP_TICKS = 15;
/** The chase lasts 25 s at most. This also covers STANDOFF and DOOR_TUG. */
const MAX_TICKS = 60 * 40;

/** @returns {Promise<object>} Fresh state, in DRIVE, with the sim paused. */
async function freshRun(page) {
  await page.evaluate(() => {
    TLV.debug.pause();
    TLV.debug.setInput(null);
    TLV.debug.startRun({});
    TLV.debug.step(1);
  });
  for (let i = 0; i < 40; i++) {
    const phase = await page.evaluate(() => TLV.debug.state().phase);
    if (phase === 'DRIVE') break;
    await page.evaluate(() => TLV.debug.step(30));
  }
  return page.evaluate(() => TLV.debug.state());
}

/**
 * Steps until the encounter exits.
 * @param {object} page Playwright page.
 * @param {function():Promise<void>} [each] Runs before every step, to play the scripted input.
 * @returns {Promise<object>} State at the exit.
 */
async function untilExit(page, each) {
  for (let t = 0; t < MAX_TICKS; t += STEP_TICKS) {
    if (each) await each();
    await page.evaluate((n) => TLV.debug.step(n), STEP_TICKS);
    const state = await page.evaluate(() => TLV.debug.state());
    if ((state.knife && state.knife.exit) || state.phase === 'RUN_END') return state;
  }
  throw new Error(`no exit in ${MAX_TICKS} ticks`);
}

/** Points the on-foot move vector straight at the door. */
const runToDoor = (page) => page.evaluate(() => {
  const s = TLV.debug.state();
  const dx = s.doorX - s.player.x;
  const dy = s.doorY - s.player.y;
  const d = Math.hypot(dx, dy) || 1;
  TLV.debug.setInput({ footX: dx / d, footY: dy / d });
});

/** The four exits, each with the input that reaches it (GAME_DESIGN 15.4). */
const EXITS = [
  {
    exit: 'REACHED_SHOP',
    force: { stage: 'CHASE', gap: 12 },
    // Starts beside the door, since this script tests the exit and not route finding, and covers the last metres on foot.
    start: (page) => page.evaluate(() => {
      const s = TLV.debug.state();
      TLV.debug.teleport(s.doorX - 3, s.doorY, 0, 0);
    }),
    each: runToDoor
  },
  {
    exit: 'SHAKEN',
    force: { stage: 'CHASE', gap: 25 }
  },
  {
    exit: 'WHISTLE',
    force: { stage: 'CHASE', gap: 12 },
    // Holds the chase open past 25 s: no strike count ever reaches 3.
    each: (page) => page.evaluate(() => TLV.debug.setStrikes(0))
  },
  {
    exit: 'CAUGHT',
    force: { stage: 'CHASE', gap: 1 },
    // GAME_DESIGN 24 row 26: each hit must flash white, with no blood. These frames are for a person to review.
    onStrike: (page, strikes, stub) => shot(page, `knife_strike_${strikes}${stub ? '_stub' : ''}`)
  }
];

async function main() {
  const { root, stub, absent } = pickTree();
  if (absent.length) {
    const reason = `${absent.length} files not built yet, first: ${absent[0]}`;
    for (const { exit } of EXITS) skip(`forceKnife reaches ${exit}`, reason);
    return;
  }

  await withPage({ root, params: '?seed=1&notitle=1&mute=1&knife=force' }, async ({ page, logs }) => {
    await pw.waitForTick(page, 1);
    for (const { exit, force, start, each, onStrike } of EXITS) {
      await scenario(`forceKnife reaches ${exit}`, async () => {
        await freshRun(page);
        await page.evaluate((opts) => TLV.debug.forceKnife(opts), force);
        await page.evaluate(() => TLV.debug.step(1));
        let state = await page.evaluate(() => TLV.debug.state());
        assert.ok(state.knife, 'the encounter started');
        assert.strictEqual(state.phase, 'ENCOUNTER');
        const tag = `knife_${exit.toLowerCase()}`;
        await shot(page, `${tag}_start${stub ? '_stub' : ''}`);

        if (start) await start(page);
        let strikes = 0;
        state = await untilExit(page, async () => {
          if (each) await each(page);
          const now = await page.evaluate(() => {
            const s = TLV.debug.state();
            return s.knife ? s.knife.strikes : 0;
          });
          if (onStrike && now > strikes) await onStrike(page, now, stub);
          strikes = now;
        });
        await shot(page, `${tag}_end${stub ? '_stub' : ''}`);

        if (exit === 'CAUGHT') {
          assert.strictEqual(state.phase, 'RUN_END');
          assert.strictEqual(state.endReason, 'CAUGHT');
        } else {
          assert.strictEqual(state.knife.exit, exit);
          assert.notStrictEqual(state.phase, 'RUN_END', 'the errand counts on every non-fail exit');
        }
        assert.deepStrictEqual(consoleErrors(logs), []);
      });
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(finish);
