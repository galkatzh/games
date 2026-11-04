// tests/core/manifest.test.mjs — WP-CORE
// The files whose exact text the contract fixes. The contract is read from docs/, so they cannot drift apart.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTLV } from '../../tools/lib/classic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const architecture = read('docs/ARCHITECTURE.md');

/** Reads the quoted strings of a named list inside a section of the contract. */
function contractList(section, key) {
  const start = architecture.indexOf(section);
  const from = architecture.indexOf(`${key}: [`, start);
  const to = architecture.indexOf(']', from);
  return [...architecture.slice(from, to).matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('the manifest lists exactly the contract, in order', () => {
  const { manifest } = createTLV({ files: [] });
  assert.deepStrictEqual(manifest.sim, contractList('### 4.3 Manifest', 'sim'));
  assert.deepStrictEqual(manifest.browser, contractList('### 4.3 Manifest', 'browser'));
  assert.strictEqual(new Set([...manifest.sim, ...manifest.browser]).size, manifest.sim.length + manifest.browser.length);
});

test('the manifest and the ownership table agree', () => {
  const { manifest } = createTLV({ files: [] });
  const owned = new Set([...architecture.matchAll(/^(js\/\S+\.js)\s+WP-[A-Z]+$/gm)].map((m) => m[1]));
  for (const file of [...manifest.sim, ...manifest.browser]) assert.ok(owned.has(file), `${file} has no owner`);
});

test('content/index.js is the section 4.5 list', () => {
  const TLV = createTLV({ files: [], content: true, allowMissing: true });
  assert.deepStrictEqual(TLV.contentFiles.default, contractList('### 4.5 Data indexes', 'default'));
});

test('index.html contains exactly what section 4.1 lists', () => {
  const html = read('index.html');
  assert.match(html, /^<!doctype html>/);
  assert.match(html, /<head>\s*<meta charset="utf-8">/, 'the charset must be the first child of head');
  assert.strictEqual((html.match(/<canvas id="game">/g) || []).length, 1);
  assert.strictEqual((html.match(/<div id="ui-root">/g) || []).length, 1);
  assert.strictEqual((html.match(/<link rel="stylesheet" href="css\/ui\.css">/g) || []).length, 1);
  assert.deepStrictEqual(
    [...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1]),
    ['vendor/three.min.js', 'js/core/namespace.js', 'js/manifest.js', 'js/app/loader.js']
  );
  const tags = [...html.matchAll(/<([a-z]+)[\s>]/g)].map((m) => m[1]);
  assert.deepStrictEqual(tags, ['html', 'head', 'meta', 'link', 'body', 'canvas', 'div', 'script', 'script', 'script', 'script']);
});

test('index.html loads nothing from the network', () => {
  assert.doesNotMatch(read('index.html'), /https?:|\/\/[a-z]/i);
});

test('the Hebrew probe in constants.js is seven letters in a UTF-8 file', () => {
  const { const: C } = createTLV({ files: ['js/core/constants.js'] });
  assert.strictEqual(C._charsetProbe.length, 7);
  assert.strictEqual(Buffer.byteLength(C._charsetProbe, 'utf8'), 14);
});
