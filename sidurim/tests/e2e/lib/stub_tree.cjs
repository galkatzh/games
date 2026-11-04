// tests/e2e/lib/stub_tree.cjs — WP-CORE
// Builds throwaway copies of the game that hold only what WP-CORE owns, with or without stubs for everything else. Tests use
// these so that proving the loader and boot does not depend on which other packages have landed.
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');

const CORE_DIRS = ['js/core', 'js/app'];
const CORE_FILES = ['index.html', 'js/manifest.js', 'content/index.js', 'vendor/three.min.js'];

/** Stub files that carry real stub code. Every other listed file is an empty marker. */
const STUB_BODIES = { 'js/world/world.js': 'stub_sim.js', 'js/ui/ui.js': 'stub_browser.js' };

/** The map title holds Hebrew, so an injected script's decoding can be measured in a stub tree. */
const STUB_TITLE_HE = 'תל אביב מרכז';

/** @returns {{sim:string[], browser:string[]}} The manifest of a tree. */
function manifest(root) {
  const win = {};
  for (const file of ['js/core/namespace.js', 'js/manifest.js']) {
    const src = fs.readFileSync(path.join(root, file), 'utf8');
    vm.compileFunction(src, ['window', 'TLV'])(win, win.TLV);
  }
  return win.TLV.manifest;
}

/** @returns {string} A line that records a stub file as it runs, in TLV.stubLoaded, for the order test in file_protocol. */
function loadMark(file) {
  return `(window.TLV.stubLoaded = window.TLV.stubLoaded || []).push(${JSON.stringify(file)});\n`;
}

/** Writes a file, creating its directory. */
function write(root, rel, text) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

/**
 * Builds a tree holding only WP-CORE's files.
 * @param {string} dest New directory.
 * @returns {string} dest.
 */
function bare(dest) {
  for (const dir of CORE_DIRS) fs.cpSync(path.join(PROJECT_ROOT, dir), path.join(dest, dir), { recursive: true });
  for (const file of CORE_FILES) write(dest, file, fs.readFileSync(path.join(PROJECT_ROOT, file)));
  return dest;
}

/** @returns {string} A map payload script with the given schema. */
function mapScript(schema) {
  const payload = {
    schema, id: 'stub',
    meta: { title: { he: STUB_TITLE_HE, en: 'Stub' }, attribution: '© OpenStreetMap contributors' },
    strings: [''], tables: {}
  };
  return `TLV.q.push(['map', ${JSON.stringify(payload)}]);\n`;
}

/**
 * Builds a tree where every other package is a stub, so index.html boots all the way.
 * @param {string} dest New directory.
 * @param {object} [opts]
 * @param {string[]} [opts.omit] Project-relative files to leave out.
 * @param {number[]} [opts.schema] Map schema. Default [1, 0].
 * @returns {string} dest.
 */
function stubbed(dest, opts = {}) {
  bare(dest);
  const omit = new Set(opts.omit || []);
  const list = manifest(dest);
  for (const file of [...list.sim, ...list.browser]) {
    if (fs.existsSync(path.join(dest, file)) || omit.has(file)) continue;
    const body = STUB_BODIES[file] ? fs.readFileSync(path.join(__dirname, STUB_BODIES[file]), 'utf8') : '';
    write(dest, file, `${loadMark(file)}${body}`);
  }

  const files = {
    'css/ui.css': 'body { margin: 0; }\n',
    'data/maps/index.js': `TLV.mapIndex = { default: 'stub', maps: { stub: { src: 'data/maps/stub/map.js', title: ${JSON.stringify({ he: STUB_TITLE_HE, en: 'Stub' })}, schema: [1, 0] } } };\n`,
    'data/maps/stub/map.js': mapScript(opts.schema || [1, 0]),
    'data/assets/index.js': 'TLV.assetIndex = {};\n',
    'content/tlv_center/world.js': "TLV.q.push(['spawn', { map: 'stub', anchor: null }]);\n",
    'content/tlv_center/errands.js': "TLV.q.push(['errand', { id: 'stub', tier: 1 }]);\n",
    'content/tlv_center/styles.js': "TLV.q.push(['style', { id: 'stub' }]);\n",
    'content/tlv_center/kit.js': "TLV.q.push(['kit', { id: 'stub' }]);\n",
    'content/tlv_center/districts.js': "TLV.q.push(['district', { id: 'stub' }]);\n",
    'content/tlv_center/storefronts.js': "TLV.q.push(['storefront', { id: 'stub' }]);\n",
    'content/tlv_center/landmarks.js': "TLV.q.push(['landmark', { id: 'stub' }]);\n"
  };
  for (const [file, text] of Object.entries(files)) {
    if (!omit.has(file)) write(dest, file, file.endsWith('.js') ? `${loadMark(file)}${text}` : text);
  }
  return dest;
}

/**
 * Lists what a tree still lacks for a full boot. An empty list means the real thing can be tested.
 * @param {string} root Tree.
 * @returns {string[]} Relative paths.
 */
function missingFiles(root) {
  const list = manifest(root);
  const wanted = [...list.sim, ...list.browser, 'css/ui.css', 'data/maps/index.js', 'data/assets/index.js', 'data/maps/tlv_center/map.js',
    'content/tlv_center/world.js', 'content/tlv_center/errands.js'];
  return wanted.filter((f) => !fs.existsSync(path.join(root, f)));
}

module.exports = { bare, stubbed, manifest, missingFiles, PROJECT_ROOT, STUB_TITLE_HE };
