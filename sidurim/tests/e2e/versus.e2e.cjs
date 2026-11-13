// tests/e2e/versus.e2e.cjs — WP-NET
// Run: node tests/e2e/versus.e2e.cjs
//
// A shared day (GAME_DESIGN 26) in a real browser: two pages of the game, joined by ?net=local, which is a BroadcastChannel and no
// network. It proves the lobby, the board, a pick, an errand taken from under a driver, the verdict and another day together, on the
// screen and in the sim. tests/game/versus.test.mjs holds the rules themselves, and tests/e2e/online.e2e.cjs the real transport.
'use strict';

const assert = require('node:assert');

const { scenario, shot, finish, consoleErrors } = require('./lib/harness.cjs');
const two = require('./lib/two_drivers.cjs');

const PARAMS = '?seed=1&mute=1&net=local&traffic=0&peds=0&incidents=0&contest=off&knife=off&quality=low';
const text = two.text;

/** Errors a healthy page does not print. The radio and the horn are muted, so nothing is fetched. */
function healthy(T) {
  assert.deepStrictEqual(consoleErrors(T.logs), []);
  assert.deepStrictEqual(T.logs.blocked, [], 'a shared day over the local channel asks nothing of the network');
}

async function main() {
  await scenario('the lobby: O on the title, a room with a code, and no key starts a day from inside it', async () => {
    const T = await two.open(`${PARAMS}&lang=en`);
    try {
      const { a } = T;
      await T.frame(a);
      assert.match(await text(a, '.title-online'), /Two drivers, one list/);
      assert.strictEqual(await text(a, '.lobby-title'), null, 'the lobby is not up yet');
      await a.keyboard.press('KeyO');
      await T.frame(a);
      assert.strictEqual(await text(a, '.lobby-title'), 'TWO DRIVERS, ONE LIST');
      assert.match(await text(a, '.lobby-choices'), /H\s*Open a room/);
      // Any key starts the day on the title. Under the lobby it must not.
      for (const key of ['KeyX', 'Space', 'Enter', 'Digit1', 'ArrowLeft']) await a.keyboard.press(key);
      await T.run(5);
      assert.strictEqual((await T.state(a)).phase, 'TITLE');
      await a.keyboard.press('KeyH');
      await a.waitForFunction(() => TLV.net.state().status === 'open');
      await T.frame(a);
      const code = (await T.state(a)).net.room;
      assert.match(code, /^[A-HJ-NP-Z]{4}$/, 'four letters, none that pass for another');
      assert.strictEqual(await text(a, '.lobby-code'), code);
      assert.strictEqual(await text(a, '.lobby-code-label'), 'ROOM CODE');
      assert.match(await text(a, '.lobby-status'), /Waiting for another driver/);
      assert.strictEqual(await text(a, '.lobby-start'), null, 'nothing to start alone');
      await a.keyboard.press('Enter');
      await T.run(5);
      assert.strictEqual((await T.state(a)).phase, 'TITLE');
      await shot(a, 'versus_lobby_alone');
      // Esc leaves the room, then the lobby, and the title is the title again.
      await a.keyboard.press('Escape');
      assert.strictEqual((await T.state(a)).net.status, 'off');
      await T.frame(a);
      assert.match(await text(a, '.lobby-choices'), /Join a room/);
      await a.keyboard.press('Escape');
      await T.frame(a);
      assert.strictEqual(await text(a, '.lobby-title'), null);
      healthy(T);
    } finally {
      await T.close();
    }
  });

  await scenario('two drivers: join by code, the same board, a pick, an errand taken, the verdict, and another day', async () => {
    const T = await two.open(`${PARAMS}&lang=en`);
    try {
      const { a, b } = T;
      const code = await two.meet(T);
      await T.run(5);
      for (const page of [a, b]) {
        await T.frame(page);
        assert.strictEqual(await text(page, '.lobby-code'), code);
        assert.strictEqual(await text(page, '.lobby-status'), 'Drivers in the room: 2');
        assert.match(await text(page, '.lobby-start'), /START THE DAY/);
      }
      await shot(b, 'versus_lobby_two');

      // The driver who joined starts it. Whoever deals, both get the board.
      await b.keyboard.press('Enter');
      await T.run(10);
      const rows = [];
      for (const page of [a, b]) {
        const s = await T.state(page);
        assert.deepStrictEqual([s.phase, s.on, s.open, s.errand, s.total, s.left], ['CARD', true, true, null, 10, 10]);
        await T.frame(page);
        assert.strictEqual(await text(page, '.lobby-title'), null, 'the lobby is gone');
        assert.strictEqual(await text(page, '.board-title'), 'PICK AN ERRAND');
        rows.push(await page.evaluate(() => [...document.querySelectorAll('.board-row')].map((r) => r.textContent)));
      }
      assert.strictEqual(rows[0].length, 10);
      assert.deepStrictEqual(rows[0], rows[1], 'both start from the same place, so the same figures');
      assert.match(rows[0][0], /^1Milk\..*\d+ m\+₪\d+\+\d+ s$/, rows[0][0]);
      assert.match(rows[0][9], /gan.*once everything else is done/);
      await shot(a, 'versus_board');

      // Both go for the first errand.
      await a.keyboard.press('Digit1');
      await b.keyboard.press('Digit1');
      await T.run(5);
      assert.deepStrictEqual((await T.state(a)).errand, 'milk');
      assert.deepStrictEqual((await T.state(b)).peers[0].pick, 0);
      await T.frame(a);
      assert.strictEqual(await text(a, '.board-title'), null, 'the board is down once picked');
      assert.match(await text(a, '.phone-index'), /ERRAND 1\/10/);
      await T.until(a, () => TLV.app.S.game.phase === 'DRIVE', 8, 'a drives');
      await T.until(b, () => TLV.app.S.game.phase === 'DRIVE', 8, 'b drives');

      // On the way, T shows the board again, with the errand in hand marked and the other driver's interest shown.
      await b.keyboard.press('KeyT');
      await T.run(2);
      await T.frame(b);
      assert.strictEqual(await text(b, '.board-title'), 'PICK AN ERRAND');
      assert.ok(await b.evaluate(() => document.querySelector('.board').classList.contains('driving')));
      assert.ok(await b.evaluate(() => document.querySelector('.board-row').classList.contains('picked')));
      assert.match(await text(b, '.board-row'), /the other driver is on the way/);
      assert.match(await text(b, '.board-keys'), /keep the one you have/);
      await shot(b, 'versus_board_driving');
      await b.keyboard.press('KeyT');
      await T.frame(b);
      assert.strictEqual(await text(b, '.board-title'), null);
      assert.strictEqual((await T.state(b)).errand, 'milk', 'kept');

      // a parks. b's errand is gone, and b is back at the board, still rolling.
      assert.strictEqual(await a.evaluate(() => TLV.debug.parkNow({ quality: 'GOOD' })), true);
      // The park crosses at once. What a has made crosses with its next report, a few ticks on.
      await T.run(15);
      const sa = await T.state(a);
      const sb = await T.state(b);
      assert.ok(sa.money > 0);
      assert.deepStrictEqual([sb.phase, sb.errand, sb.open, sb.left, sb.money], ['DRIVE', null, true, 9, 0]);
      assert.strictEqual(sb.peers[0].money, sa.money, 'b sees what a has made');
      await T.frame(b);
      assert.strictEqual(await text(b, '.board-title'), 'TAKEN. PICK ANOTHER.');
      assert.match(await text(b, '.board-row'), /the other driver did it/);
      assert.ok(await b.evaluate(() => document.querySelector('.board-row').classList.contains('theirs')));
      assert.match(await text(b, '.hud-toasts'), /TAKEN\. THE OTHER DRIVER PARKED FIRST\./);
      assert.match(await text(b, '.hud-versus'), new RegExp(`THEM.*${sa.money}.*9 LEFT`));
      await shot(b, 'versus_taken');
      // Its key does nothing now, and the next one picks.
      await b.keyboard.press('Digit1');
      await T.run(2);
      assert.strictEqual((await T.state(b)).errand, null);
      await b.keyboard.press('Digit2');
      await T.run(2);
      const picked = await T.state(b);
      assert.ok(picked.errand && picked.errand !== 'milk');
      assert.strictEqual(picked.phase, 'DRIVE', 'no card on the move');

      // Both days end on the clock. Each end screen carries both totals and the verdict.
      for (const page of [a, b]) await page.evaluate(() => TLV.debug.endRun('CLOCK'));
      await T.run(20);
      for (const page of [a, b]) await T.frame(page);
      assert.strictEqual(await text(a, '.end-versus-verdict'), 'THE DAY IS YOURS');
      assert.strictEqual(await text(b, '.end-versus-verdict'), 'THE OTHER DRIVER TOOK THE DAY');
      assert.match(await text(a, '.end-versus-rows'), new RegExp(`YOU₪${sa.money}THEM₪0`));
      assert.match(await text(b, '.end-versus-rows'), new RegExp(`YOU₪0THEM₪${sa.money}`));
      assert.match(await text(a, '.end-restart'), /ANOTHER DAY TOGETHER/);
      await shot(a, 'versus_end_won');
      await shot(b, 'versus_end_lost');

      // One asks for another day and waits. When the other asks too, it starts for both, with a new board.
      // The key is read by the next tick, as any key is.
      await a.keyboard.press('Enter');
      await T.run(10);
      assert.strictEqual((await T.state(a)).ready, true);
      for (const page of [a, b]) await T.frame(page);
      assert.strictEqual((await T.state(a)).phase, 'RUN_END');
      assert.match(await text(a, '.end-restart'), /READY\. WAITING FOR THE OTHER DRIVER\./);
      assert.strictEqual(await text(b, '.end-versus-note'), 'The other driver wants another day.');
      await b.keyboard.press('KeyR');
      await T.run(10);
      for (const page of [a, b]) {
        const s = await T.state(page);
        assert.deepStrictEqual([s.phase, s.round, s.open, s.left, s.money], ['CARD', 2, true, 10, 0]);
      }

      // b closes the tab. a is told, and plays on.
      await b.close({ runBeforeUnload: true });
      await two.wait(300);
      await a.evaluate(() => TLV.debug.step(5));
      assert.strictEqual((await T.state(a)).peers.length, 0);
      assert.strictEqual((await T.state(a)).on, true);
      await T.frame(a);
      assert.match(await text(a, '.hud-toasts'), /The other driver left/);
      healthy(T);
    } finally {
      await T.close();
    }
  });

  await scenario('in Hebrew the lobby and the board read right to left, and the code stays as typed', async () => {
    const T = await two.open(`${PARAMS}&lang=he`);
    try {
      const { a, b } = T;
      const code = await two.meet(T);
      await T.run(5);
      await T.frame(a);
      assert.strictEqual(await text(a, '.lobby-title'), 'שני נהגים, רשימה אחת');
      // A number inside Hebrew is held together as a left-to-right island, so the line is matched, not compared.
      assert.match(await text(a, '.lobby-status'), /נהגים בחדר/);
      assert.strictEqual(await text(a, '.lobby-code'), code);
      assert.strictEqual(await a.evaluate(() => document.querySelector('.lobby-code').dir), 'ltr');
      await a.keyboard.press('Enter');
      await T.run(10);
      await T.frame(b);
      assert.strictEqual(await text(b, '.board-title'), 'לבחור סידור');
      assert.strictEqual(await b.evaluate(() => getComputedStyle(document.querySelector('.board')).direction), 'rtl');
      assert.match(await text(b, '.board-row'), /חלב/);
      await shot(b, 'versus_board_he');
      healthy(T);
    } finally {
      await T.close();
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(finish);
