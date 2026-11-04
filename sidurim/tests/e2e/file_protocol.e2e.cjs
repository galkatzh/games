// tests/e2e/file_protocol.e2e.cjs — WP-CORE
// Run: node tests/e2e/file_protocol.e2e.cjs
//
// The game must run from a double-clicked index.html, with no network. WP-CORE's scenarios use throwaway trees, so they
// hold whichever packages have landed. The real tree is tested as soon as it is complete (ARCHITECTURE 20.2 and 20.3).
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const pw = require('../../tools/lib/pw.cjs');
const stubTree = require('./lib/stub_tree.cjs');
const { scenario, skip, withPage, tempDir, shot, finish, consoleErrors } = require('./lib/harness.cjs');

/** The Hebrew title the real importer writes, from tools/areas/tlv_center.json. */
const REAL_TITLE_HE = 'תל אביב מרכז';

/** Waits for the loop to reach a tick, without depending on frame rate. */
const ticking = (page, tick) => pw.waitForTick(page, tick, { timeoutMs: 30000 });

/** Reads the Hebrew strings as the page decoded them. */
function hebrew(page) {
  return page.evaluate(() => ({
    probe: TLV.const._charsetProbe,
    probeLength: TLV.const._charsetProbe.length,
    title: TLV.mapIndex ? TLV.mapIndex.maps[TLV.mapIndex.default].title.he : null
  }));
}

/** Runs in the page before its scripts: logs each injected script, with what was true at the moment it was injected. */
function recordInjections() {
  window.__injected = [];
  const append = Node.prototype.appendChild;
  Node.prototype.appendChild = function (node) {
    if (node.tagName === 'SCRIPT') {
      window.__injected.push({ src: node.getAttribute('src'), async: node.async, params: !!(window.TLV && window.TLV.params) });
    }
    return append.call(this, node);
  };
}

/** Everything a stub tree must prove once it has booted. */
async function assertBootedClean(page, logs) {
  await ticking(page, 30);
  assert.strictEqual(await page.$('#load-error'), null, 'no error overlay');
  assert.strictEqual(await page.$('#ui-error'), null, 'no error overlay through the UI');
  assert.deepStrictEqual(consoleErrors(logs), []);
  assert.deepStrictEqual(logs.blocked, []);
}

async function main() {
  await scenario('core alone: the overlay lists every missing file, and boot stops', async () => {
    const root = stubTree.bare(tempDir('bare'));
    const list = stubTree.manifest(root);
    const missing = [...list.sim, ...list.browser].filter((f) => !fs.existsSync(path.join(root, f)));
    assert.ok(missing.length > 80, 'the tree really is bare');

    await withPage({ root, params: '?seed=1' }, async ({ page, logs }) => {
      await page.waitForSelector('#load-error', { timeout: 30000 });
      const text = await page.textContent('#load-error');
      assert.match(text, /cannot start/);
      const expected = [...missing, 'data/maps/index.js', 'data/assets/index.js', 'css/ui.css',
        'content/tlv_center/errands.js', 'content/tlv_center/landmarks.js'];
      for (const file of expected) assert.ok(text.includes(file), `${file} is not listed`);
      assert.match(text, /node tools\/import\.mjs/);
      assert.ok(await page.isVisible('#load-error'));
      assert.strictEqual(await page.evaluate(() => !!(TLV.app && TLV.app.S)), false, 'boot stopped');
      assert.strictEqual(await page.evaluate(() => document.querySelector('#ui-root').contains(document.querySelector('#load-error'))), true);

      const he = await hebrew(page);
      assert.strictEqual(he.probeLength, 7, 'a Hebrew string has its expected length');
      assert.strictEqual(he.probe, 'סידורים');
      assert.deepStrictEqual(logs.blocked, []);
      assert.deepStrictEqual(logs.errors, [], 'missing files are reported, they do not throw');
      await shot(page, 'file_protocol_overlay');

      const end = await page.evaluate(() => {
        const box = document.querySelector('#load-error');
        box.scrollTop = box.scrollHeight;
        const lines = document.createRange();
        lines.selectNodeContents(box);
        const rects = lines.getClientRects();
        return { scrolls: box.scrollHeight > box.clientHeight, boxBottom: box.getBoundingClientRect().bottom, lastLine: rects[rects.length - 1].bottom, view: window.innerHeight };
      });
      assert.ok(end.scrolls, 'the list is long enough to need scrolling');
      assert.ok(end.boxBottom <= end.view, `the box stops at the window: ${JSON.stringify(end)}`);
      assert.ok(end.lastLine <= end.view, `the last missing file can be read at full scroll: ${JSON.stringify(end)}`);
      await shot(page, 'file_protocol_overlay_end');
    });
  });

  await scenario('all packages stubbed: boots on file:// with the network blocked, and the loop runs', async () => {
    const root = stubTree.stubbed(tempDir('stubbed'));
    await withPage({ root, params: '?seed=7&notitle=1' }, async ({ page, logs }) => {
      await assertBootedClean(page, logs);
      const he = await hebrew(page);
      assert.strictEqual(he.probeLength, 7);
      assert.strictEqual(he.title, stubTree.STUB_TITLE_HE);
      assert.strictEqual(he.title.length, 12, 'Hebrew in an injected map index keeps its length');
      const title = await page.evaluate(() => TLV.debug.current().world.meta);
      assert.strictEqual(title.title.he.length, 12, 'Hebrew in an injected map file keeps its length');
      assert.strictEqual(title.attribution, '© OpenStreetMap contributors');

      const state = await page.evaluate(() => TLV.debug.state());
      assert.strictEqual(state.seed, 7);
      assert.strictEqual(state.map, 'stub');
      assert.deepStrictEqual(await page.evaluate(() => TLV.registerLog), ['world', 'player', 'traffic', 'peds', 'game', 'render', 'ui']);
      assert.deepStrictEqual(await page.evaluate(() => TLV.registry.problems()), []);

      const views = await page.evaluate(() => ({ r: TLV.render.frames, u: TLV.ui.frames, i: TLV.render.inits, input: TLV.input.bound === TLV.app.S }));
      assert.ok(views.r > 0 && views.u > 0, 'render(S, alpha, dtReal) reaches render.frame and ui.frame');
      assert.strictEqual(views.i, 1);
      assert.strictEqual(views.input, true);
      const events = await page.evaluate(() => TLV.ui.events);
      assert.ok(events.includes('run.start'), 'notitle delivers run.start to a frame consumer');
    });
  });

  await scenario('scripts inject in contract order with async off, run in that order even if one is slow, and the map waits for params', async () => {
    const root = stubTree.stubbed(tempDir('order'));
    const list = stubTree.manifest(root);
    const slow = async (page) => {
      await page.route('**/js/world/geom.js', async (route) => {
        await new Promise((r) => setTimeout(r, 500));
        await route.fallback();
      });
    };
    await withPage({ root, params: '?seed=7&notitle=1', init: recordInjections, before: slow }, async ({ page, logs }) => {
      await ticking(page, 1);
      const content = await page.evaluate(() => TLV.contentFiles.default);
      const indexes = ['data/maps/index.js', 'content/index.js', 'data/assets/index.js'];
      const first = [...list.sim, ...list.browser, ...indexes];
      const second = ['data/maps/stub/map.js', ...content];

      const injected = await page.evaluate(() => window.__injected);
      assert.deepStrictEqual(injected.map((s) => s.src), [...first, ...second]);
      assert.deepStrictEqual(injected.filter((s) => s.async !== false), [], 'every script has async off');
      assert.deepStrictEqual(injected.filter((s) => s.params).map((s) => s.src), second, 'TLV.params is set after the indexes and before the map');

      const isStub = (f) => !f.startsWith('js/core/') && !f.startsWith('js/app/') && f !== 'content/index.js';
      assert.deepStrictEqual(await page.evaluate(() => TLV.stubLoaded), [...first, ...second].filter(isStub), 'scripts ran in that order');
      assert.deepStrictEqual(consoleErrors(logs), []);
    });
  });

  await scenario('boot runs in contract order, and render, UI and input get the current sim', async () => {
    const root = stubTree.stubbed(tempDir('bootorder'));
    await withPage({ root, params: '?seed=7&notitle=1' }, async ({ page }) => {
      await ticking(page, 1);
      await page.waitForFunction(() => TLV.render.frames > 0);
      const seen = await page.evaluate(() => ({ log: TLV.bootLog, render: TLV.render.args, ui: TLV.ui.args, input: TLV.input.args }));
      assert.deepStrictEqual(seen.log, ['register world', 'register player', 'register traffic', 'register peds', 'register game',
        'register render', 'register ui', 'drain', 'world.build', 'sim.create', 'render.init', 'ui.init', 'input.init', 'first frame']);
      assert.deepStrictEqual(seen.render, { target: 'game', currentSim: true });
      assert.deepStrictEqual(seen.ui, { target: 'ui-root', currentSim: true });
      assert.deepStrictEqual(seen.input, { target: true, currentSim: true });
    });
  });

  await scenario('?timescale reaches the loop, and S.timeScale stays 1', async () => {
    const root = stubTree.stubbed(tempDir('timescale'));
    await withPage({ root, params: '?seed=7&notitle=1&timescale=0.01' }, async ({ page }) => {
      await page.waitForFunction(() => TLV.render.frames >= 40);
      const seen = await page.evaluate(() => ({ frames: TLV.render.frames, tick: TLV.debug.state().tick, scale: TLV.app.S.timeScale }));
      // A frame buys at most 0.1 s x 0.01 of sim, which is 0.06 ticks, however slow the machine is.
      assert.ok(seen.tick <= seen.frames * 0.06, `${seen.tick} ticks in ${seen.frames} frames`);
      assert.strictEqual(seen.scale, 1);
    });
  });

  await scenario('the seed comes from the clock when none is given', async () => {
    const root = stubTree.stubbed(tempDir('seed'));
    await withPage({ root }, async ({ page }) => {
      await ticking(page, 1);
      const seed = await page.evaluate(() => TLV.debug.state().seed);
      assert.ok(Number.isInteger(seed) && seed > 1000, `seed ${seed}`);
    });
  });

  await scenario('debug hooks work from page.evaluate: pause, step, resume, setInput', async () => {
    const root = stubTree.stubbed(tempDir('hooks'));
    await withPage({ root, params: '?seed=3&notitle=1' }, async ({ page }) => {
      await ticking(page, 5);
      await page.evaluate(() => TLV.debug.pause());
      const held = await page.evaluate(() => TLV.debug.state().tick);
      await new Promise((r) => setTimeout(r, 300));
      assert.strictEqual(await page.evaluate(() => TLV.debug.state().tick), held, 'paused');
      const frames = await page.evaluate(() => TLV.render.frames);
      await new Promise((r) => setTimeout(r, 300));
      assert.ok((await page.evaluate(() => TLV.render.frames)) > frames, 'render continues while paused');

      assert.strictEqual(await page.evaluate(() => TLV.debug.step(100)), held + 100);
      await page.evaluate(() => TLV.debug.setInput({ throttle: 1 }));
      await page.evaluate(() => TLV.debug.step(60));
      assert.ok((await page.evaluate(() => TLV.debug.state().player.v)) > 0, 'setInput reaches the sim');
      assert.strictEqual(typeof await page.evaluate(() => TLV.debug.hash()), 'number');

      await page.evaluate(() => TLV.debug.resume());
      await ticking(page, held + 170);
    });
  });

  await scenario('record, export, import in the browser: the replay reaches the same hash', async () => {
    const root = stubTree.stubbed(tempDir('replay'));
    await withPage({ root, params: '?seed=5&notitle=1&record=1&autoplay=patrol' }, async ({ page, logs }) => {
      await ticking(page, 1);
      await page.evaluate(() => TLV.debug.pause());
      const tick = await page.evaluate(() => TLV.debug.step(600 - TLV.debug.state().tick));
      assert.strictEqual(tick, 600);
      const hash = await page.evaluate(() => TLV.debug.hash());
      const log = await page.evaluate(() => JSON.parse(JSON.stringify(TLV.debug.exportReplay())));
      const replay = await page.evaluate((l) => TLV.debug.importReplay(l), log);
      assert.deepStrictEqual(replay, { seed: 5, ticks: 600 });
      await page.evaluate(() => { TLV.app.loop.pause(); });
      assert.strictEqual(await page.evaluate(() => TLV.debug.state().tick) < 600, true, 'a fresh sim');
      await page.evaluate(() => TLV.debug.step(600 - TLV.debug.state().tick));
      assert.strictEqual(await page.evaluate(() => TLV.debug.hash()), hash);
      assert.deepStrictEqual(consoleErrors(logs), []);
    });
  });

  await scenario('a log recorded with traffic and peds off replays that way in a default page', async () => {
    const root = stubTree.stubbed(tempDir('replayflags'));
    const recorded = await withPage({ root, params: '?seed=5&notitle=1&record=1&traffic=0&peds=0&autoplay=patrol' }, async ({ page }) => {
      await ticking(page, 1);
      await page.evaluate(() => TLV.debug.pause());
      await page.evaluate(() => TLV.debug.step(600 - TLV.debug.state().tick));
      return page.evaluate(() => ({ hash: TLV.debug.hash(), log: JSON.parse(JSON.stringify(TLV.debug.exportReplay())) }));
    });
    assert.strictEqual(recorded.log.header.params.traffic, 0);
    await withPage({ root, params: '?seed=5&notitle=1' }, async ({ page, logs }) => {
      await ticking(page, 1);
      await page.evaluate(() => TLV.debug.pause());
      assert.deepStrictEqual(await page.evaluate(() => TLV.app.S.flags), { traffic: true, peds: true, incidents: true });
      await page.evaluate((l) => { TLV.debug.importReplay(l); TLV.app.loop.pause(); }, recorded.log);
      assert.deepStrictEqual(await page.evaluate(() => TLV.app.S.flags), { traffic: false, peds: false, incidents: true });
      await page.evaluate(() => TLV.debug.step(600 - TLV.debug.state().tick));
      assert.strictEqual(await page.evaluate(() => TLV.debug.hash()), recorded.hash);
      assert.deepStrictEqual(logs.console.filter((m) => /does not match/.test(m.text)), [], 'the replay matched its log');
      assert.deepStrictEqual(consoleErrors(logs), []);
    });
  });

  await scenario('a missing browser file is listed through TLV.ui.showError, and boot continues', async () => {
    const root = stubTree.stubbed(tempDir('nobrowser'), { omit: ['js/render/signs.js', 'content/tlv_center/landmarks.js'] });
    await withPage({ root, params: '?seed=1&notitle=1' }, async ({ page }) => {
      await page.waitForSelector('#ui-error', { timeout: 30000 });
      const text = await page.textContent('#ui-error');
      assert.ok(text.includes('js/render/signs.js'));
      assert.ok(text.includes('content/tlv_center/landmarks.js'));
      assert.match(text, /will run without them/);
      await ticking(page, 10);
    });
  });

  await scenario('a missing sim file stops boot', async () => {
    const root = stubTree.stubbed(tempDir('nosim'), { omit: ['js/world/lanes.js'] });
    await withPage({ root, params: '?seed=1&notitle=1' }, async ({ page }) => {
      await page.waitForSelector('#ui-error', { timeout: 30000 });
      assert.ok((await page.textContent('#ui-error')).includes('js/world/lanes.js'));
      assert.strictEqual(await page.evaluate(() => TLV.debug.state()), null, 'boot stopped');
    });
  });

  await scenario('a missing UI still gets a plain overlay', async () => {
    const root = stubTree.stubbed(tempDir('noui'), { omit: ['js/ui/ui.js', 'js/world/map.js'] });
    await withPage({ root, params: '?seed=1' }, async ({ page }) => {
      await page.waitForSelector('#load-error', { timeout: 30000 });
      const text = await page.textContent('#load-error');
      assert.ok(text.includes('js/ui/ui.js'));
      assert.ok(text.includes('js/world/map.js'));
    });
  });

  await scenario('a missing map file stops boot and names the import command', async () => {
    const root = stubTree.stubbed(tempDir('nomap'), { omit: ['data/maps/stub/map.js'] });
    await withPage({ root, params: '?seed=1' }, async ({ page }) => {
      await page.waitForSelector('#ui-error', { timeout: 30000 });
      assert.ok((await page.textContent('#ui-error')).includes('data/maps/stub/map.js'));
      assert.strictEqual(await page.evaluate(() => TLV.debug.state()), null, 'boot stopped');
    });
  });

  await scenario('an unknown map is refused, and ?map cannot load a remote script', async () => {
    const root = stubTree.stubbed(tempDir('badmap'));
    for (const value of ['nowhere', 'https://example.com/x.js', '//example.com/x.js', '../../x.js']) {
      await withPage({ root, params: `?seed=1&map=${encodeURIComponent(value)}` }, async ({ page, logs }) => {
        await page.waitForSelector('#ui-error', { timeout: 30000 });
        assert.match(await page.textContent('#ui-error'), /Unknown map/);
        assert.deepStrictEqual(logs.blocked, [], 'nothing was fetched');
      });
    }
  });

  await scenario('a map named after an Object property is an unknown map, and the overlay shows no junk', async () => {
    const root = stubTree.stubbed(tempDir('protomap'));
    for (const value of ['constructor', '__proto__', 'toString', 'hasOwnProperty']) {
      await withPage({ root, params: `?seed=1&map=${value}` }, async ({ page, logs }) => {
        await page.waitForSelector('#ui-error', { timeout: 30000 });
        const text = await page.textContent('#ui-error');
        assert.ok(text.includes(`Unknown map "${value}"`), text);
        assert.doesNotMatch(text, /undefined|function Object|native code|Missing files/, 'content fell back to the default list');
        assert.strictEqual(await page.evaluate(() => TLV.debug.state()), null, 'boot stopped');
        assert.deepStrictEqual(logs.blocked, [], 'nothing was fetched');
      });
    }
  });

  await scenario('?map may be a local script path, as in createTLV', async () => {
    const root = stubTree.stubbed(tempDir('mappath'));
    await withPage({ root, params: '?seed=1&notitle=1&map=data/maps/stub/map.js' }, async ({ page }) => {
      await ticking(page, 5);
      assert.strictEqual(await page.evaluate(() => TLV.debug.state().map), 'stub');
    });
  });

  await scenario('a schema major mismatch is shown with the re-import command', async () => {
    const root = stubTree.stubbed(tempDir('schema'), { schema: [2, 0] });
    await withPage({ root, params: '?seed=1&notitle=1' }, async ({ page }) => {
      await page.waitForSelector('#ui-error', { timeout: 30000 });
      assert.match(await page.textContent('#ui-error'), /node tools\/import\.mjs stub/);
      assert.strictEqual(await page.evaluate(() => TLV.debug.state()), null);
    });
  });

  await scenario('on file://, where the browser hides the file, a script that throws while loading is named, and boot continues', async () => {
    const root = stubTree.stubbed(tempDir('throw'));
    fs.writeFileSync(path.join(root, 'js/ui/hud.js'), "throw new Error('hud is broken');\n");
    fs.writeFileSync(path.join(root, 'js/ui/cards.js'), 'function (\n');
    await withPage({ root, params: '?seed=1&notitle=1' }, async ({ page }) => {
      await page.waitForSelector('#ui-error', { timeout: 30000 });
      const text = await page.textContent('#ui-error');
      assert.match(text, /failed while loading/);
      assert.match(text, /js\/ui\/hud\.js: it threw/, 'an exception is named');
      assert.match(text, /js\/ui\/cards\.js: it threw/, 'a syntax error is named');
      assert.ok(!text.includes('js/ui/minimap.js'), 'the clean file between them is not blamed');
      assert.ok(!text.includes('js/ui/strings.js'), 'nor is the one before');
      await ticking(page, 10);
    });
  });

  await scenario('from a server, where nothing is hidden, the script is named with its own message', async () => {
    const root = stubTree.stubbed(tempDir('throwhttp'));
    fs.writeFileSync(path.join(root, 'js/ui/hud.js'), "throw new Error('hud is broken');\n");
    await withPage({ root, server: true, params: '?seed=1&notitle=1' }, async ({ page }) => {
      await page.waitForSelector('#ui-error', { timeout: 30000 });
      assert.match(await page.textContent('#ui-error'), /js\/ui\/hud\.js: .*hud is broken/);
    });
  });

  await scenario('a sim file that throws stops boot, and the overlay names it, not a stranger error', async () => {
    const root = stubTree.stubbed(tempDir('throwsim'), { omit: ['js/ui/ui.js'] });
    fs.writeFileSync(path.join(root, 'js/core/sim.js'), 'function (\n');
    await withPage({ root, params: '?seed=1&notitle=1' }, async ({ page }) => {
      await page.waitForSelector('#load-error', { timeout: 30000 });
      const text = await page.textContent('#load-error');
      assert.match(text, /cannot start/);
      assert.match(text, /js\/core\/sim\.js: it threw/);
      assert.doesNotMatch(text, /Boot failed/);
      assert.strictEqual(await page.evaluate(() => !!(TLV.app && TLV.app.S)), false, 'boot stopped');
    });
  });

  for (const [label, omit, selector] of [
    ['TLV.ui.showError', ['js/render/signs.js'], '#ui-error'],
    ['the plain overlay', ['js/render/signs.js', 'js/ui/ui.js'], '#load-error']
  ]) {
    await scenario(`through ${label}, a later failure adds to the overlay and never replaces it`, async () => {
      const root = stubTree.stubbed(tempDir('append'), { omit });
      fs.writeFileSync(path.join(root, 'content/tlv_center/kit.js'), "TLV.ns('render').init = function () { throw new Error('render bug'); };\n");
      await withPage({ root, params: '?seed=1&notitle=1' }, async ({ page }) => {
        await page.waitForFunction((s) => {
          const box = document.querySelector(s);
          return box && box.textContent.includes('Boot failed');
        }, selector, { timeout: 30000 });
        const text = await page.textContent(selector);
        assert.ok(text.includes('js/render/signs.js'), 'the first message is still there');
        assert.match(text, /Boot failed: render bug/);
      });
    });
  }

  await scenario('a sim failure on a later tick halts the loop visibly, with its real message on file://', async () => {
    const root = stubTree.stubbed(tempDir('crash'));
    fs.writeFileSync(path.join(root, 'content/tlv_center/kit.js'), [
      'TLV.crashAt = Infinity;',
      "var original = TLV.ns('traffic').update;",
      'TLV.traffic.update = function (S, dt) {',
      "  if (S.tick >= TLV.crashAt) throw new Error('traffic bug');",
      '  original(S, dt);',
      '};\n'
    ].join('\n'));
    await withPage({ root, params: '?seed=1&notitle=1' }, async ({ page }) => {
      await ticking(page, 5);
      await page.evaluate(() => { TLV.crashAt = 0; });
      await page.waitForSelector('#ui-error', { timeout: 30000 });
      assert.match(await page.textContent('#ui-error'), /The game stopped: traffic bug/);
      const held = await page.evaluate(() => TLV.debug.state().tick);
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual(await page.evaluate(() => TLV.debug.state().tick), held, 'the loop stays halted');
    });
  });

  await scenario('without the charset meta the Hebrew check fails, so it is a real check', async () => {
    const root = stubTree.stubbed(tempDir('charset'));
    const file = path.join(root, 'index.html');
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('<meta charset="utf-8">\n', ''));
    await withPage({ root, params: '?seed=1&notitle=1' }, async ({ page }) => {
      await page.waitForSelector('#ui-error', { timeout: 30000 });
      assert.match(await page.textContent('#ui-error'), /not being read as UTF-8/);
      const he = await hebrew(page);
      assert.strictEqual(he.probeLength, 14);
      assert.strictEqual(he.title.length, 22, 'each Hebrew letter became two characters; spaces stayed one');
    });
  });

  await scenario('the same stub tree works from a static server', async () => {
    const root = stubTree.stubbed(tempDir('server'));
    await withPage({ root, server: true, params: '?seed=7&notitle=1' }, async ({ page, logs, url }) => {
      assert.match(url, /^http:\/\/127\.0\.0\.1/);
      await assertBootedClean(page, logs);
      assert.strictEqual((await hebrew(page)).title.length, 12);
    });
  });

  const absent = stubTree.missingFiles(pw.PROJECT_ROOT);
  const realSkip = absent.length ? `${absent.length} files not built yet, first: ${absent[0]}` : null;

  async function realTree(server) {
    await withPage({ server, params: '?seed=1&notitle=1&mute=1' }, async ({ page, logs }) => {
      await pw.waitForTick(page, 1);
      await page.evaluate(() => TLV.debug.pause());
      for (let i = 0; i < 40; i++) {
        if ((await page.evaluate(() => TLV.debug.state().phase)) === 'DRIVE') break;
        await page.evaluate(() => TLV.debug.step(30));
      }
      assert.strictEqual(await page.evaluate(() => TLV.debug.state().phase), 'DRIVE');
      assert.deepStrictEqual(consoleErrors(logs), []);
      assert.deepStrictEqual(logs.blocked, []);
      const he = await hebrew(page);
      assert.strictEqual(he.probeLength, 7);
      assert.strictEqual(he.title, REAL_TITLE_HE);
      assert.strictEqual(he.title.length, 12);
    });
  }

  if (realSkip) {
    skip('real tree on file://: reaches DRIVE, no console errors, network blocked, Hebrew intact', realSkip);
    skip('real tree from a static server', realSkip);
  } else {
    await scenario('real tree on file://: reaches DRIVE, no console errors, network blocked, Hebrew intact', () => realTree(false));
    await scenario('real tree from a static server', () => realTree(true));
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(finish);
