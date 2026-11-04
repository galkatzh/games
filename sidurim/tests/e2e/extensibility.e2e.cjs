// tests/e2e/extensibility.e2e.cjs — WP-CORE
// Run: node tests/e2e/extensibility.e2e.cjs [--stub]
//
// ARCHITECTURE 20.10: add one storefront, one landmark, one errand and one overlay op, with data changes only. It works on a
// copy of the tree, so the project is never touched, and no engine file changes. It exits 77 while the tree is incomplete.
'use strict';

const assert = require('node:assert');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const pw = require('../../tools/lib/pw.cjs');
const { scenario, skip, withPage, pickTree, tempDir, finish, consoleErrors } = require('./lib/harness.cjs');

/** Anchors from the shipped data: the pinned Carrefour and the Municipality. */
const NEW_CONTENT = `
TLV.q.push(['storefront', {
  id: 'ext_test_shop',
  anchor: { osm: 'n11238493213', at: [32.0749, 34.7820], name: 'Carrefour' },
  sign: { text: { he: 'חנות', en: 'Shop' } }
}]);
TLV.q.push(['landmark', {
  id: 'ext_test_landmark',
  anchor: { osm: 'w31786632', at: [32.0810, 34.7806] },
  mode: 'restyle',
  style: 'glass_blue',
  skyline: true
}]);
TLV.q.push(['errand', {
  id: 'ext_test_errand',
  tier: 2,
  weight: 1,
  target: { kinds: ['pharmacy'], named: 'prefer', anchor: null },
  fallbackKinds: [],
  text: { he: 'תרופות מ-{poi}', en: 'Collect the order from {poi}' },
  mod: null
}]);
`;

/** King George, the spawn street (ARCHITECTURE 14.6). */
const OVERLAY_OP = { op: 'road.set', anchor: { osm: 'w154735772' }, set: { lanes: 2 }, why: 'Extensibility test' };

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Copies a tree, leaving out what the game does not read, and linking the 17 MB OSM extract. */
function copyTree(root) {
  const dest = tempDir('ext');
  const skipped = new Set(['docs', 'tests', path.join('tools', 'cache'), path.join('tools', 'reports')]);
  fs.cpSync(root, dest, { recursive: true, filter: (src) => !skipped.has(path.relative(root, src)) });
  if (fs.existsSync(path.join(root, 'tools/cache'))) fs.symlinkSync(path.join(root, 'tools/cache'), path.join(dest, 'tools/cache'));
  return dest;
}

async function main() {
  const { root, stub, absent } = pickTree();
  const contentName = 'a new storefront, landmark and errand load from data alone, with no problems';
  const overlayName = 'a new overlay op re-imports the map from data alone';
  if (absent.length) {
    const reason = `${absent.length} files not built yet, first: ${absent[0]}`;
    skip(contentName, reason);
    skip(overlayName, reason);
    return;
  }

  const tree = copyTree(root);
  fs.appendFileSync(path.join(tree, 'content/tlv_center/errands.js'), NEW_CONTENT);

  await scenario(contentName, async () => {
    await withPage({ root: tree, params: '?seed=1&notitle=1&mute=1&dev=1' }, async ({ page, logs }) => {
      await pw.waitForTick(page, 5);
      assert.deepStrictEqual(await page.evaluate(() => TLV.registry.problems()), []);
      assert.deepStrictEqual(consoleErrors(logs), []);
      if (!stub) {
        const ids = await page.evaluate(() => TLV.game.errands.defs().map((d) => d.id));
        assert.ok(ids.includes('ext_test_errand'), 'the errand reached its handler');
      }
    });
  });

  if (stub || !fs.existsSync(path.join(tree, 'tools/import.mjs'))) {
    skip(overlayName, 'needs the real importer');
    return;
  }
  await scenario(overlayName, async () => {
    const map = path.join(tree, 'data/maps/tlv_center/map.js');
    const before = sha256(map);
    const overlay = path.join(tree, 'tools/overlays/tlv_center/roads.json');
    fs.writeFileSync(overlay, JSON.stringify([...JSON.parse(fs.readFileSync(overlay, 'utf8')), OVERLAY_OP]));
    const run = spawnSync(process.execPath, ['tools/import.mjs', 'tlv_center'], { cwd: tree, encoding: 'utf8', shell: false });
    assert.strictEqual(run.status, 0, run.stdout + run.stderr);
    assert.notStrictEqual(sha256(map), before, 'the map changed');
    await withPage({ root: tree, params: '?seed=1&notitle=1&mute=1' }, async ({ page, logs }) => {
      await pw.waitForTick(page, 5);
      assert.deepStrictEqual(consoleErrors(logs), []);
    });
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(finish);
