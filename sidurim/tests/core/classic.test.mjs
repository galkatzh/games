// tests/core/classic.test.mjs — WP-CORE
import assert from 'node:assert';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createSim, createTLV } from '../../tools/lib/classic.mjs';
import { captureWarnings, coreFiles } from './helpers.mjs';

const require = createRequire(import.meta.url);
const stubTree = require('../e2e/lib/stub_tree.cjs');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'tlv-classic-'));
after(() => fs.rmSync(temp, { recursive: true, force: true }));

test('each createTLV call gets an independent TLV', () => {
  const a = createTLV({ files: coreFiles() });
  const b = createTLV({ files: coreFiles() });
  assert.notStrictEqual(a, b);
  assert.notStrictEqual(a.math, b.math);
  assert.notStrictEqual(a.q, b.q);
  a.q.push(['errand', {}]);
  a.tune.x = 1;
  a.registry.problem = () => {};
  assert.strictEqual(b.q.length, 0);
  assert.strictEqual(b.tune.x, undefined);
  assert.strictEqual(typeof b.registry.problem, 'function');
  assert.strictEqual(b.registry.problems().length, 0);
});

test('assert.deepStrictEqual passes on a typed array built in game code', () => {
  const TLV = createTLV({ files: coreFiles() });
  const cum = TLV.math.cumLen([0, 3, 3], [0, 4, 4]);
  assert.deepStrictEqual(cum, new Float32Array([0, 5, 5]));
  assert.ok(cum instanceof Float32Array, 'one realm, so instanceof holds');
  assert.deepStrictEqual(TLV.const.newVehicle(1).lat, 0);
  assert.deepStrictEqual(TLV.config.normalize({ spawn: '1,2,3' }).spawn, { x: 1, y: 2, h: 3 });
});

test('objects from game code compare equal to test literals', () => {
  const TLV = createTLV({ files: coreFiles() });
  const v = TLV.const.newVehicle(2);
  assert.deepStrictEqual(Object.getPrototypeOf(v), Object.prototype);
  assert.deepStrictEqual([...TLV.const.BEHAVIOURS].slice(0, 2), ['CRUISE', 'RED_RUN']);
});

test('namespace.js and manifest.js load first even with an explicit list', () => {
  const TLV = createTLV({ files: [] });
  assert.strictEqual(typeof TLV.ns, 'function');
  assert.ok(Array.isArray(TLV.q));
  assert.deepStrictEqual(TLV.tune, {});
  assert.ok(TLV.manifest.sim.length > 50);
});

test('an explicit files array implies allowMissing, no map and no content', () => {
  const TLV = createTLV({ files: [...coreFiles(), 'js/does/not/exist.js'] });
  assert.deepStrictEqual(TLV._missing, ['js/does/not/exist.js']);
  assert.strictEqual(TLV.mapIndex, undefined);
  assert.strictEqual(TLV.contentFiles, undefined);
});

test('explicit options beat what a files array implies', () => {
  assert.throws(() => createTLV({ files: ['js/does/not/exist.js'], allowMissing: false }), /js\/does\/not\/exist\.js/);
  const TLV = createTLV({ files: coreFiles(), content: true });
  assert.ok(TLV.contentFiles.default.includes('content/tlv_center/errands.js'));
});

test('the sim token expands inside an explicit list', () => {
  const TLV = createTLV({ files: ['sim', 'js/does/not/exist.js'] });
  assert.ok(TLV.sim && TLV.math && TLV.registry);
  assert.ok(TLV._missing.includes('js/does/not/exist.js'));
});

test('a package can load everything that exists with allowMissing', () => {
  const TLV = createTLV({ allowMissing: true, map: null, content: false });
  assert.ok(TLV.sim);
  assert.ok(TLV.params);
});

test('without allowMissing, a missing file throws and names every one', () => {
  const dir = path.join(temp, 'partial');
  stubTree.bare(dir);
  assert.throws(() => createTLV({ root: dir, map: null, content: false }), (e) => {
    assert.match(e.message, /js\/world\/world\.js/);
    assert.match(e.message, /js\/sim\/game\/flow\.js/);
    return true;
  });
});

test('params are normalized and Node fills seed 1', () => {
  const TLV = createTLV({ files: coreFiles(), params: { notitle: true, density: '90' } });
  assert.strictEqual(TLV.params.seed, 1);
  assert.strictEqual(TLV.params.notitle, 1);
  assert.strictEqual(TLV.params.density, 90);
  assert.strictEqual(TLV.params.clock, 120);
  assert.strictEqual(createTLV({ files: coreFiles(), params: { seed: 8 } }).params.seed, 8);
});

test('loading any sim file finds no document in scope', () => {
  const dir = path.join(temp, 'probe');
  stubTree.bare(dir);
  fs.mkdirSync(path.join(dir, 'js/world'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'js/world/map.js'), 'window.TLV.docType = typeof document;');
  const TLV = createTLV({ root: dir, files: ['sim'] });
  assert.strictEqual(TLV.docType, 'undefined');
});

test('createTLV loads all of TLV.manifest.sim in Node, with no allowMissing, and registers five packages in order', () => {
  const dir = path.join(temp, 'stubbed');
  stubTree.stubbed(dir);
  const seen = [];
  const TLV = createTLV({ root: dir, map: 'stub', content: true, params: { seed: 2 } });
  assert.deepStrictEqual(TLV._missing, []);
  assert.deepStrictEqual(TLV.stubLoaded.filter((f) => f.startsWith('js/')), TLV.manifest.sim.filter((f) => !f.startsWith('js/core/')));
  assert.deepStrictEqual(TLV.registerLog, ['world', 'player', 'traffic', 'peds', 'game']);
  seen.push(TLV.params.map);
  assert.deepStrictEqual(seen, ['stub']);
  const S = createSim(TLV, {});
  assert.strictEqual(S.world.id, 'stub');
  assert.strictEqual(S.seed, 2);
  assert.strictEqual(TLV.debug.current(), S);
  for (let i = 0; i < 60; i++) TLV.sim.step(S);
  assert.strictEqual(S.tick, 60);
});

test('a map path takes its ID from the pushed payload, and the map reaches its handler', () => {
  const dir = path.join(temp, 'bypath');
  stubTree.stubbed(dir);
  const TLV = createTLV({ root: dir, files: ['sim'], map: 'data/maps/stub/map.js' });
  assert.strictEqual(TLV.params.map, 'stub');
  assert.strictEqual(TLV.world.get('stub').id, 'stub');
  assert.strictEqual(TLV.q.filter((i) => i[0] === 'map').length, 0, 'the world handler drained it');
});

test('content is loaded, and a map with no key of its own uses default', () => {
  const dir = path.join(temp, 'content');
  stubTree.stubbed(dir);
  const TLV = createTLV({ root: dir, map: 'stub', content: true });
  assert.ok(TLV.q.some((i) => i[0] === 'storefront'), 'render content stays queued, harmlessly');
});

test('a map with its own content key uses that list, not default', () => {
  const dir = path.join(temp, 'ownkey');
  stubTree.stubbed(dir);
  fs.writeFileSync(path.join(dir, 'content/stub_only.js'), "TLV.q.push(['storefront', { id: 'only_here' }]);\n");
  fs.writeFileSync(path.join(dir, 'content/index.js'), "TLV.contentFiles = { default: ['content/absent.js'], stub: ['content/stub_only.js'] };\n");
  const TLV = createTLV({ root: dir, map: 'stub', content: true });
  assert.deepStrictEqual(TLV._missing, []);
  assert.deepStrictEqual(TLV.q.filter((i) => i[0] === 'storefront').map((i) => i[1].id), ['only_here']);
});

test('a map ID is resolved through its index entry, which may point anywhere', () => {
  const dir = path.join(temp, 'indexsrc');
  stubTree.stubbed(dir);
  fs.mkdirSync(path.join(dir, 'data/elsewhere'));
  fs.renameSync(path.join(dir, 'data/maps/stub/map.js'), path.join(dir, 'data/elsewhere/map.js'));
  const index = fs.readFileSync(path.join(dir, 'data/maps/index.js'), 'utf8');
  assert.ok(index.includes('data/maps/stub/map.js'));
  fs.writeFileSync(path.join(dir, 'data/maps/index.js'), index.replace('data/maps/stub/map.js', 'data/elsewhere/map.js'));
  const TLV = createTLV({ root: dir, map: 'stub', content: false });
  assert.deepStrictEqual(TLV._missing, []);
  assert.strictEqual(TLV.world.get('stub').id, 'stub');
});

test('params.map selects the map, as ?map= does', () => {
  const dir = path.join(temp, 'parammap');
  stubTree.stubbed(dir);
  const TLV = createTLV({ root: dir, content: false, params: { map: 'stub' } });
  assert.deepStrictEqual(TLV._missing, []);
  assert.strictEqual(TLV.params.map, 'stub');
  assert.strictEqual(TLV.world.get('stub').id, 'stub');
  assert.strictEqual(createSim(TLV, {}).world.id, 'stub');
});

test('params.map may be a path, and the ID still comes from the payload', () => {
  const dir = path.join(temp, 'parampath');
  stubTree.stubbed(dir);
  const TLV = createTLV({ root: dir, content: false, params: { map: 'data/maps/stub/map.js' } });
  assert.strictEqual(TLV.params.map, 'stub');
  assert.strictEqual(TLV.world.get('stub').id, 'stub');
});

test('an unknown params.map fails and names the file, rather than running on the default map', () => {
  const dir = path.join(temp, 'paramunknown');
  stubTree.stubbed(dir);
  assert.throws(() => createTLV({ root: dir, content: false, params: { map: 'nowhere' } }), /data\/maps\/nowhere\/map\.js/);
});

test('params.map is coerced to a string, as config.normalize does', () => {
  const dir = path.join(temp, 'paramnumber');
  stubTree.stubbed(dir);
  assert.throws(() => createTLV({ root: dir, content: false, params: { map: 5 } }), /data\/maps\/5\/map\.js/);
});

test('params.map loads the fixture on the real tree, with or without a files array', () => {
  const pick = (TLV) => [TLV.params.map, TLV.q.filter((i) => i[0] === 'map').map((i) => i[1].id)];
  const mini = 'tests/fixtures/mini_map.js';
  assert.deepStrictEqual(pick(createTLV({ files: coreFiles(), params: { map: mini } })), ['mini', ['mini']]);
  // Without files, whichever of queued or drained: the point is that this map is the one taken, not tlv_center.
  const whole = createTLV({ allowMissing: true, content: false, params: { map: mini } });
  assert.strictEqual(whole.params.map, 'mini');
  assert.ok(!whole.q.some((i) => i[0] === 'map' && i[1].id !== 'mini'));
});

test('the map option beats params.map, and an explicit null means no map', () => {
  const dir = path.join(temp, 'optmap');
  stubTree.stubbed(dir);
  assert.strictEqual(createTLV({ root: dir, map: 'stub', content: false, params: { map: 'nowhere' } }).params.map, 'stub');
  const none = createTLV({ root: dir, map: null, content: false, params: { map: 'nowhere' } });
  assert.deepStrictEqual(none._missing, []);
  assert.strictEqual(none.q.some((i) => i[0] === 'map'), false);
});

test('with no map requested, the defaults stay: null for a files array, tlv_center otherwise', () => {
  const dir = path.join(temp, 'mapdefaults');
  stubTree.stubbed(dir);
  for (const params of [undefined, {}, { map: null }, { map: '' }]) {
    const listed = createTLV({ files: coreFiles(), params });
    assert.strictEqual(listed.params.map, null);
    assert.strictEqual(listed.q.some((i) => i[0] === 'map'), false);
    const whole = createTLV({ root: dir, allowMissing: true, content: false, params });
    assert.deepStrictEqual(whole._missing, ['data/maps/tlv_center/map.js']);
  }
});

const INHERITED_NAMES = ['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'];

for (const name of INHERITED_NAMES) {
  test(`map ID ${name} is an unknown map, not a property of Object`, () => {
    const dir = path.join(temp, `inherited-${name}`);
    stubTree.stubbed(dir);
    const expected = new RegExp(`data/maps/${name}/map\\.js`);
    assert.throws(() => createTLV({ root: dir, map: name, content: false }), expected);
    assert.throws(() => createTLV({ root: dir, content: false, params: { map: name } }), expected);
  });

  test(`content for map ID ${name} is the default list, not a property of Object`, () => {
    const dir = path.join(temp, `inherited-content-${name}`);
    stubTree.stubbed(dir);
    const TLV = createTLV({ root: dir, map: name, content: true, allowMissing: true });
    assert.deepStrictEqual(TLV._missing, [`data/maps/${name}/map.js`]);
    assert.ok(TLV.q.some((i) => i[0] === 'storefront'), 'the default content loaded');
  });
}

const realMap = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../data/maps/tlv_center/map.js');

test('the real map loads by ID and its Hebrew survives the loader', { skip: fs.existsSync(realMap) ? false : 'map not built yet' }, () => {
  const TLV = createTLV({ files: coreFiles(), map: 'tlv_center' });
  const [type, payload] = TLV.q.find((item) => item[0] === 'map');
  assert.strictEqual(type, 'map');
  assert.strictEqual(payload.id, 'tlv_center');
  assert.strictEqual(TLV.params.map, 'tlv_center');
  assert.strictEqual(payload.meta.title.he, 'תל אביב מרכז');
  assert.strictEqual(payload.meta.attribution, '© OpenStreetMap contributors');
});

test('createSim passes options through and merges params over TLV.params', () => {
  const dir = path.join(temp, 'merge');
  stubTree.stubbed(dir);
  const TLV = createTLV({ root: dir, map: 'stub', content: false, params: { density: 80, seed: 3 } });
  const S = createSim(TLV, { seed: 9, params: { notitle: 1 }, flags: { peds: false } });
  assert.strictEqual(S.seed, 9);
  assert.strictEqual(S.params.density, 80);
  assert.strictEqual(S.params.notitle, 1);
  assert.strictEqual(S.flags.peds, false);
});

test('createSim on a partial tree stays tolerant', () => {
  const TLV = createTLV({ files: coreFiles() });
  let S;
  captureWarnings(() => {
    S = createSim(TLV, { seed: 5 });
    for (let i = 0; i < 60; i++) TLV.sim.step(S);
  });
  assert.strictEqual(S.world, null);
  assert.strictEqual(S.vehicles[0].isPlayer, true);
  assert.strictEqual(S.tick, 60);
});

test('createSim without a world fails clearly unless missing is allowed', () => {
  const TLV = createTLV({ files: coreFiles() });
  assert.throws(() => createSim(TLV, { allowMissing: false }), /no world/);
});
