// tests/core/readme.test.mjs — WP-CORE
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSidecar, packAll } from '../../tools/pack_assets.mjs';
import { coreTLV } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');

test('README covers the OSM attribution', () => {
  assert.ok(readme.includes('© OpenStreetMap contributors'));
  assert.match(readme, /ODbL/);
});

test('README explains how to run, on file:// and from a server', () => {
  assert.match(readme, /index\.html/);
  assert.match(readme, /file:\/\//);
  assert.match(readme, /static server/i);
});

test('README lists every URL parameter', () => {
  const { config } = coreTLV();
  // clockGiven is worked out by normalize from ?clock. Nobody sets it in a URL.
  for (const param of Object.keys(config.normalize({})).filter((name) => name !== 'clockGiven')) {
    assert.ok(readme.includes(`\`${param}\``), `${param} is not in the README`);
  }
});

test('README gives the exact test commands, with the quotes the shell needs', () => {
  assert.ok(readme.includes("node --test 'tests/**/*.test.mjs'"));
  assert.ok(readme.includes("node --test 'tests/core/**/*.test.mjs'"));
  assert.ok(readme.includes('node tests/e2e/file_protocol.e2e.cjs'));
  assert.ok(readme.includes('node tools/soak.mjs'));
});

test('README states the rule against Google Street View', () => {
  assert.match(readme, /Street View/);
  assert.match(readme, /Mapillary/);
});

const GOOD = { source: 'own photo', credit: { author: 'A', license: 'own', date: '2026-10' }, attest: { noLogo: true, noFaces: true } };
const STREET_VIEW = [
  'Google', 'Street View', 'StreetView', 'street-view capture', 'street_view_pano_123', 'street.view', 'street\u00a0view', 'street\u2013view',
  'GSV', 'gsv_123', 'gmaps screenshot', 'https://maps.app.goo.gl/abc123', 'https://lh5.googleusercontent.com/p/abc',
  'https://geo0.ggpht.com/cbk?panoid=abc', 'צילום מסך מגוגל סטריט ויו', 'סטריט-וויו', 'גּוּגְל', 'G\u043e\u043egle', 'G\u200boogle', '\uff27\uff4f\uff4f\uff47\uff4c\uff45'
];

test('the README names each word the pack tool refuses, and calls the check an attestation', () => {
  for (const word of ['google', 'goo.gl', 'ggpht', 'gmaps', 'gsv', 'street view', 'גוגל', 'סטריט ויו']) {
    assert.ok(readme.includes(`\`${word}\``), `${word} is not in the README`);
    assert.throws(() => checkSidecar({ ...GOOD, source: word }, true), /Google/, word);
  }
  assert.match(readme, /The sidecar is an attestation/);
  assert.doesNotMatch(readme, /in any form/);
});

test('the pack tool refuses Street View in source, in any other sidecar field, and in the file name', () => {
  for (const word of STREET_VIEW) {
    assert.throws(() => checkSidecar({ ...GOOD, source: word }, true), /Google/, `source ${word}`);
    assert.throws(() => checkSidecar({ ...GOOD, credit: { ...GOOD.credit, author: word } }, true), /Google/, `author ${word}`);
    assert.throws(() => checkSidecar({ ...GOOD, note: word }, true), /Google/, `note ${word}`);
    assert.throws(() => checkSidecar({ ...GOOD, notes: [{ from: word }] }, true), /Google/, `nested ${word}`);
    assert.throws(() => checkSidecar({ ...GOOD, [word]: 1 }, true), /Google/, `key ${word}`);
    assert.throws(() => checkSidecar(GOOD, true, `${word}.png`), /Google/, `file name ${word}`);
  }
});

test('the pack tool refuses a source that is missing, empty or not text', () => {
  const none = { ...GOOD };
  delete none.source;
  for (const side of [none, ...['', '  ', '\u200b', null, 7, true, ['Google Street View'], ['own photo'], { url: 'google street view' }].map((s) => ({ ...GOOD, source: s }))]) {
    assert.throws(() => checkSidecar(side, true), /source must be text/, JSON.stringify(side.source));
  }
});

test('the pack tool still takes honest text that comes near a refused word', () => {
  for (const text of ['own photo', 'Mapillary (CC BY-SA)', 'mapillary image 1234567', 'צילום עצמי', 'street art on Dizengoff', 'view from the street',
    'Dizengoff street, view north', 'googly eyes', 'big maps', 'bigmaps', 'gsvx', 'xgsv']) {
    assert.doesNotThrow(() => checkSidecar({ ...GOOD, source: text, note: text }, true, `${text}.png`), text);
  }
  assert.doesNotThrow(() => checkSidecar({ ...GOOD, credit: { ...GOOD.credit, author: 'Main street' }, note: 'view north' }, true), 'two fields are not one phrase');
});

test('packAll passes the file name to the check, and packs the item beside the refused one', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlv-readme-pack-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, 'assets_src/storefronts');
  fs.mkdirSync(dir, { recursive: true });
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 0, 64, 0, 0, 0, 32]), Buffer.alloc(9)]);
  for (const id of ['clean', 'streetview_pano']) {
    fs.writeFileSync(path.join(dir, `${id}.png`), png);
    fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(GOOD));
  }
  const r = await packAll(root, () => {});
  assert.deepStrictEqual(r.packed, ['sf_clean']);
  assert.deepStrictEqual(r.refused.map((x) => x.id), ['storefronts/streetview_pano']);
  assert.ok(!fs.existsSync(path.join(root, 'data/assets/sf_streetview_pano.js')));
});
