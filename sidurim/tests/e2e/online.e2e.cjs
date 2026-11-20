// tests/e2e/online.e2e.cjs — WP-NET
// Run: node tests/e2e/online.e2e.cjs
//
// The real transport of a shared day: vendor/trystero.min.js, signaling over Nostr, and a WebRTC data channel between two pages of the
// game. The relay is tests/e2e/lib/nostr_relay.cjs on localhost, named with ?relay=, so nothing leaves the machine. What this proves
// is that the bundle loads as a classic script, that TLV.net drives it by its real API, and that a board, a pick and a park cross a
// real data channel. What it cannot prove is the public relays, or a connection between two networks: no test reaches those.
'use strict';

const assert = require('node:assert');

const { scenario, finish, consoleErrors } = require('./lib/harness.cjs');
const relay = require('./lib/nostr_relay.cjs');
const two = require('./lib/two_drivers.cjs');

const PARAMS = '?seed=1&mute=1&traffic=0&peds=0&incidents=0&contest=off&knife=off&quality=low&lang=en';

/** Waits in real time for something that happens off the sim's clock, stepping the sims so their messages keep moving. */
async function eventually(T, page, test, seconds, what) {
  const end = Date.now() + seconds * 1000;
  for (;;) {
    await T.run(2, 2);
    if (await page.evaluate(test)) return;
    if (Date.now() > end) throw new Error(`${what}: not in ${seconds} s`);
    await two.wait(250);
  }
}

async function main() {
  await scenario('two pages meet through Trystero and a local relay, and a shared day crosses the data channel', async () => {
    const R = await relay.start();
    const T = await two.open(`${PARAMS}&relay=${encodeURIComponent(R.url)}`, { settleMs: 150 });
    try {
      const { a, b } = T;
      // A day alone never loads the library: it is added to the page when a room is opened, and not before.
      for (const page of [a, b]) {
        assert.strictEqual(await page.evaluate(() => typeof window.Trystero), 'undefined');
        assert.strictEqual(await page.evaluate(() => document.querySelectorAll('script[src*="trystero"]').length), 0);
      }
      const code = await two.meet(T);
      assert.strictEqual(await a.evaluate(() => typeof window.Trystero.joinRoom), 'function');
      assert.strictEqual(await a.evaluate(() => document.querySelectorAll('script[src="vendor/trystero.min.js"]').length), 1);
      const compatible = () => TLV.game.versus.view(TLV.app.S).peers.some((p) => p.compatible);
      const started = Date.now();
      await eventually(T, a, compatible, 90, 'a meets b over WebRTC');
      await eventually(T, b, compatible, 30, 'b meets a');
      const ids = await Promise.all([a, b].map((page) => page.evaluate(() => TLV.game.versus.view(TLV.app.S).self)));
      assert.notStrictEqual(ids[0], ids[1], 'two tabs are two drivers: no identity is kept in the browser');
      assert.ok(ids.every((id) => typeof id === 'string' && id.length >= 8), ids.join(' '));
      assert.ok(R.stats.clients >= 2 && R.stats.events >= 2 && R.stats.subs >= 2, JSON.stringify(R.stats));
      console.log(`      room ${code}: met in ${((Date.now() - started) / 1000).toFixed(1)} s, relay ${JSON.stringify(R.stats)}`);

      // The driver who is not the dealer asks for the day. The request, and the board back, both cross the channel.
      const guest = await a.evaluate(() => TLV.game.versus.view(TLV.app.S).host) ? b : a;
      await guest.keyboard.press('Enter');
      const dealt = () => TLV.app.S.game.phase === 'CARD' && TLV.game.versus.view(TLV.app.S).total === 10;
      await eventually(T, a, dealt, 30, 'a is dealt in');
      await eventually(T, b, dealt, 30, 'b is dealt in');
      const boards = await Promise.all([a, b].map((page) => page.evaluate(() => TLV.game.versus.board(TLV.app.S).map((r) => [r.defId, r.x, r.y]))));
      assert.deepStrictEqual(boards[0], boards[1], 'the same errands at the same doors');

      // Both pick the first errand, a parks, and b's is taken from under it.
      await a.keyboard.press('Digit1');
      await b.keyboard.press('Digit1');
      await T.until(a, () => TLV.app.S.game.phase === 'DRIVE', 8, 'a drives');
      await T.until(b, () => TLV.app.S.game.phase === 'DRIVE', 8, 'b drives');
      await eventually(T, a, () => TLV.game.versus.view(TLV.app.S).peers[0].pick === 0, 20, 'a hears of b\'s pick');
      assert.strictEqual(await a.evaluate(() => TLV.debug.parkNow({ quality: 'GOOD' })), true);
      await eventually(T, b, () => TLV.game.versus.view(TLV.app.S).open && !TLV.app.S.game.errand, 20, 'b loses the errand');
      const money = (await T.state(a)).money;
      await eventually(T, b, () => TLV.game.versus.view(TLV.app.S).peers[0].money > 0, 20, 'b hears what a made');
      const sb = await T.state(b);
      assert.deepStrictEqual([sb.left, sb.peers[0].money, sb.money], [9, money, 0]);
      await T.frame(b);
      assert.strictEqual(await two.text(b, '.board-title'), 'TAKEN. PICK ANOTHER.');
      // Where the other car is crosses too: b has a place for a's, at a's bay.
      const far = await b.evaluate(() => {
        const p = TLV.game.versus.view(TLV.app.S).peers[0];
        const S = TLV.app.S;
        return [p.seen, Math.hypot(p.x - S.player.fx, p.y - S.player.fy)];
      });
      assert.strictEqual(far[0], true);
      assert.ok(far[1] > 50, `a's car is ${far[1].toFixed(0)} m from b's`);

      // b leaves. The channel closing is all a hears of it.
      await b.close();
      await eventually({ ...T, run: async () => { await a.evaluate(() => { TLV.debug.step(2); TLV.net.frame(TLV.app.S); }); } }, a,
        () => TLV.game.versus.view(TLV.app.S).peers.length === 0, 60, 'a sees b go');
      assert.strictEqual((await T.state(a)).on, true, 'and plays on');
      assert.deepStrictEqual(consoleErrors(T.logs), []);
      assert.deepStrictEqual(T.logs.blocked, [], 'with a relay named, nothing else is asked for');
    } finally {
      await T.close();
      await R.close();
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(finish);
