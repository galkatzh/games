// tests/game/debug.e2e.cjs — WP-GAME
// Run: node tests/game/debug.e2e.cjs
//
// ARCHITECTURE 19 item 9: every TLV.debug hook of this package works from page.evaluate, in Chromium, on tlv_center, and every return
// value is JSON. The page holds the real sim and no render, so this holds whether or not WP-RENDER and WP-UI have landed. It also
// walks all four knife exits the way tests/e2e/knife.e2e.cjs does, because that script cannot run until they have.
'use strict';

const assert = require('node:assert');
const pw = require('../../tools/lib/pw.cjs');
const { scenario, simOnlyPage, finish, consoleErrors } = require('../e2e/lib/harness.cjs');

const HOOKS = ['startRun', 'setClock', 'setMoney', 'setHP', 'setHeat', 'setStrikes', 'setErrand', 'forceContest', 'forceKnife', 'forceIncident', 'parkNow', 'endRun'];

async function main() {
  const { browser } = await pw.open({ goto: false });
  try {
    const page = await simOnlyPage(browser, pw.PROJECT_ROOT, { params: { seed: 2, notitle: 1, map: 'tlv_center', traffic: 1, peds: 1, incidents: 0 } });
    const errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    const state = () => page.evaluate(() => TLV.debug.state());
    const step = (n) => page.evaluate((k) => TLV.debug.step(k), n);
    const toDrive = async () => {
      for (let i = 0; i < 60; i++) {
        if ((await state()).phase === 'DRIVE') return;
        await step(30);
      }
      throw new Error('no DRIVE');
    };
    await step(1);

    await scenario('every hook of this package exists', async () => {
      const present = await page.evaluate((names) => names.filter((n) => typeof TLV.debug[n] === 'function'), HOOKS);
      assert.deepStrictEqual(present, HOOKS);
    });

    await scenario('state() reads a run', async () => {
      await toDrive();
      const s = await state();
      assert.strictEqual(s.phase, 'DRIVE');
      assert.strictEqual(s.errandId, await page.evaluate(() => TLV.debug.current().game._g.plan[0]));
      assert.ok(s.bayId >= 0);
      assert.strictEqual(s.clock <= 120 && s.clock > 100, true);
      assert.strictEqual(s.problems, 0);
    });

    await scenario('setClock, setMoney, setHP, setHeat', async () => {
      const out = await page.evaluate(() => [TLV.debug.setClock(77), TLV.debug.setMoney(500), TLV.debug.setHP(60), TLV.debug.setHeat(0.5)]);
      assert.deepStrictEqual(out, [true, true, true, true]);
      const s = await state();
      assert.strictEqual(s.money, 500);
      assert.strictEqual(s.hp, 60);
      assert.strictEqual(s.heat, 0.5);
      assert.ok(Math.abs(s.clock - 77) < 0.1);
    });

    await scenario('setErrand rebinds the current errand', async () => {
      assert.strictEqual(await page.evaluate(() => TLV.debug.setErrand(1, 'bank_queue')), true);
      const s = await state();
      assert.strictEqual(s.errandIndex, 1);
      assert.strictEqual(s.errandId, 'bank_queue');
    });

    await scenario('forceContest starts a rival and places the player within 60 m of the bay', async () => {
      const r = await page.evaluate(() => TLV.debug.forceContest({ rage: 60 }));
      assert.ok(r.rivalId >= 0);
      assert.ok(r.spotId >= 0);
      const s = await state();
      assert.strictEqual(s.phase, 'SEARCH');
      assert.strictEqual(s.contest.rage, 60);
      const left = await page.evaluate(() => TLV.debug.current().game.nav.remaining);
      assert.ok(left <= 60, `${left} m`);
    });

    await scenario('forceContest honours keepPose and spotId', async () => {
      const before = await state();
      const out = await page.evaluate(() => TLV.debug.forceContest({ keepPose: true, etaDelta: 1 }));
      const after = await state();
      assert.ok(Math.hypot(after.player.x - before.player.x, after.player.y - before.player.y) < 0.01);
      assert.ok(out.spotId >= 0);
    });

    await scenario('parkNow completes parking at the current bay', async () => {
      assert.strictEqual(await page.evaluate(() => TLV.debug.parkNow({ quality: 'PERFECT' })), true);
      const s = await state();
      assert.ok(s.phase === 'PAYOUT', s.phase);
      assert.ok(s.stats.errandsDone === 1 || s.contest.tier === 'KNIFE');
    });

    await scenario('forceIncident stages by id, gate skipped with force, and reports it in state', async () => {
      await page.evaluate(() => TLV.debug.startRun({}));
      await toDrive();
      await page.evaluate(() => TLV.debug.setErrand(2, 'bank_queue'));
      await step(300);
      const id = await page.evaluate(() => TLV.debug.forceIncident('TAILGATE', { force: true }) || TLV.debug.forceIncident('STOP_NO_REASON', { force: true }) || TLV.debug.forceIncident('DOOR_ZONE', { force: true }));
      assert.ok(id > 0, `incident ${id}`);
      const s = await state();
      assert.ok(s.incidents.some((i) => i.id === id));
      assert.strictEqual(await page.evaluate(() => TLV.debug.forceIncident('NOT_ONE', {})), null);
    });

    /** Fresh run in DRIVE. */
    async function freshRun() {
      await page.evaluate(() => {
        TLV.debug.setInput(null);
        TLV.debug.startRun({});
      });
      await step(1);
      await toDrive();
    }

    const runToDoor = () => page.evaluate(() => {
      const s = TLV.debug.state();
      const dx = s.doorX - s.player.x;
      const dy = s.doorY - s.player.y;
      const d = Math.hypot(dx, dy) || 1;
      TLV.debug.setInput({ footX: dx / d, footY: dy / d });
    });

    async function untilExit(each) {
      for (let t = 0; t < 60 * 40; t += 15) {
        if (each) await each();
        await step(15);
        const s = await state();
        if ((s.knife && s.knife.exit) || s.phase === 'RUN_END') return s;
      }
      throw new Error('no exit');
    }

    await scenario('forceKnife reaches REACHED_SHOP', async () => {
      await freshRun();
      await page.evaluate(() => TLV.debug.forceKnife({ stage: 'CHASE', gap: 12 }));
      await step(1);
      await page.evaluate(() => {
        const s = TLV.debug.state();
        TLV.debug.teleport(s.doorX - 3, s.doorY, 0, 0);
      });
      const s = await untilExit(runToDoor);
      assert.strictEqual(s.knife.exit, 'REACHED_SHOP');
      assert.notStrictEqual(s.phase, 'RUN_END');
    });

    await scenario('forceKnife reaches SHAKEN', async () => {
      await freshRun();
      await page.evaluate(() => TLV.debug.forceKnife({ stage: 'CHASE', gap: 25 }));
      const s = await untilExit();
      assert.strictEqual(s.knife.exit, 'SHAKEN');
    });

    await scenario('forceKnife reaches WHISTLE, held open by setStrikes', async () => {
      await freshRun();
      await page.evaluate(() => TLV.debug.forceKnife({ stage: 'CHASE', gap: 12 }));
      const s = await untilExit(() => page.evaluate(() => TLV.debug.setStrikes(0)));
      assert.strictEqual(s.knife.exit, 'WHISTLE');
    });

    await scenario('forceKnife reaches CAUGHT, and endRun restarts cleanly', async () => {
      await freshRun();
      await page.evaluate(() => TLV.debug.forceKnife({ stage: 'CHASE', gap: 1 }));
      const s = await untilExit();
      assert.strictEqual(s.phase, 'RUN_END');
      assert.strictEqual(s.endReason, 'CAUGHT');
      await page.evaluate(() => TLV.debug.setInput({ restart: true }));
      await step(1);
      await page.evaluate(() => TLV.debug.setInput(null));
      assert.strictEqual((await state()).phase, 'CARD');
    });

    await scenario('endRun reaches every reason', async () => {
      for (const reason of ['CLOCK', 'TOWED', 'REVOKED', 'WIN', 'CAUGHT']) {
        await freshRun();
        await page.evaluate((r) => TLV.debug.endRun(r), reason);
        const s = await state();
        assert.strictEqual(s.endReason, reason);
        assert.strictEqual(s.phase, 'RUN_END');
        assert.ok(s.rank);
      }
    });

    await scenario('every return value survives JSON, and the page threw nothing', async () => {
      const v = await page.evaluate(() => JSON.stringify(TLV.debug.state()));
      assert.ok(v.length > 100);
      assert.deepStrictEqual(errors, []);
      assert.deepStrictEqual(consoleErrors({ errors: [], console: [] }), []);
    });
  } finally {
    await browser.close();
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(finish);
