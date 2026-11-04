// tests/core/lint.test.mjs — WP-CORE
// The engineering rules of ARCHITECTURE 3 that text can check. Comments and string literals are stripped first, so a
// comment explaining a rule never trips it.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTLV } from '../../tools/lib/classic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Banned in sim code: anything that reaches the clock, the browser, the network or Node. */
const SIM_BANNED = [
  ['Math.random', /\bMath\s*\.\s*random\b/],
  ['Date.now', /\bDate\s*\.\s*now\b/],
  ['new Date', /\bnew\s+Date\b/],
  ['performance.now', /\bperformance\s*\.\s*now\b/],
  ['document', /\bdocument\b/],
  ['navigator', /\bnavigator\b/],
  ['localStorage', /\blocalStorage\b/],
  ['requestAnimationFrame', /\brequestAnimationFrame\b/],
  ['setTimeout', /\bsetTimeout\b/],
  ['setInterval', /\bsetInterval\b/],
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['new Worker', /\bnew\s+Worker\b/],
  ['THREE', /\bTHREE\b/],
  ['import ', /(^|[^.\w$])import[\s({'"*]/],
  ['require(', /\brequire\s*\(/],
  ['process.', /\bprocess\s*\./],
  ['Buffer', /\bBuffer\b/]
];

/** Banned in all of js/. */
const ALL_BANNED = [
  ['new Worker', /\bnew\s+Worker\b/],
  ['fetch(', /\bfetch\s*\(/],
  ['XMLHttpRequest', /\bXMLHttpRequest\b/],
  ['import statement', /(^|[;\n])\s*import\s*[\w{*'"]/],
  ['export statement', /(^|[;\n])\s*export\s+(default\b|const\b|let\b|var\b|function\b|class\b|\{|\*)/]
];

/** CDN hosts are searched in raw text, since a URL only ever appears inside a string. */
const CDN = /\b(cdnjs|cdn\.jsdelivr|unpkg\.com|jsdelivr|cdn\.skypack|esm\.sh|ajax\.googleapis)\b/i;

/** Token ends after which a slash divides. Anywhere else it opens a regular expression. */
function slashDivides(prev) {
  if (prev === null) return false;
  if (/[\w$)\]}]/.test(prev.char)) {
    const keyword = /(?:^|[^\w$.])(return|typeof|instanceof|in|of|new|delete|void|throw|case|do|else)$/;
    return !keyword.test(prev.word);
  }
  return false;
}

/**
 * Blanks comments and the contents of strings, template text and regular expressions, keeping line structure.
 * @param {string} src JavaScript source.
 * @returns {string} Code tokens only.
 */
function stripSource(src) {
  const out = [];
  let tail = '';
  let i = 0;
  const n = src.length;
  let prev = null;
  // Open template literals: each entry is the brace depth where a ${ began.
  const templates = [];
  let depth = 0;

  const emit = (text) => {
    out.push(text);
    tail = (tail + text).slice(-24);
    const trimmed = text.trimEnd();
    if (trimmed) prev = { char: trimmed[trimmed.length - 1], word: tail.trimEnd() };
  };

  /** Copies template text from i, up to the closing backtick or the next ${. */
  const templateChars = () => {
    while (i < n) {
      if (src[i] === '\\') {
        i += 2;
      } else if (src[i] === '`') {
        i++;
        emit("''");
        return;
      } else if (src[i] === '$' && src[i + 1] === '{') {
        i += 2;
        templates.push(depth);
        depth++;
        emit('(');
        return;
      } else {
        if (src[i] === '\n') out.push('\n');
        i++;
      }
    }
  };

  while (i < n) {
    const c = src[i];
    const d = src[i + 1];
    if (c === '/' && d === '/') {
      while (i < n && src[i] !== '\n') i++;
    } else if (c === '/' && d === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out.push('\n');
        i++;
      }
      i += 2;
    } else if (c === "'" || c === '"') {
      i++;
      while (i < n && src[i] !== c && src[i] !== '\n') i += src[i] === '\\' ? 2 : 1;
      i++;
      emit("''");
    } else if (c === '`') {
      i++;
      templateChars();
    } else if (c === '/' && !slashDivides(prev)) {
      i++;
      let inClass = false;
      while (i < n && (src[i] !== '/' || inClass) && src[i] !== '\n') {
        if (src[i] === '\\') i++;
        else if (src[i] === '[') inClass = true;
        else if (src[i] === ']') inClass = false;
        i++;
      }
      i++;
      while (i < n && /[a-z]/.test(src[i])) i++;
      emit('0');
    } else if (c === '{') {
      depth++;
      emit(c);
      i++;
    } else if (c === '}') {
      depth--;
      i++;
      if (templates.length && templates[templates.length - 1] === depth) {
        templates.pop();
        emit(')');
        templateChars();
      } else {
        emit(c);
      }
    } else {
      emit(c);
      i++;
    }
  }
  return out.join('');
}

/** @returns {string[]} Every .js file under a project directory, as relative paths. */
function listJs(dir) {
  const abs = path.join(ROOT, dir);
  if (!fs.existsSync(abs)) return [];
  const out = [];
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJs(rel));
    else if (entry.name.endsWith('.js')) out.push(rel);
  }
  return out.sort();
}

function findBanned(file, banned, code) {
  const hits = [];
  code.split('\n').forEach((line, index) => {
    for (const [name, re] of banned) {
      if (re.test(line)) hits.push(`${file}:${index + 1} uses ${name}`);
    }
  });
  return hits;
}

const simFiles = [...listJs('js/core'), ...listJs('js/world'), ...listJs('js/sim')];
const allFiles = listJs('js');

test('the lint really covers the tree', () => {
  assert.ok(simFiles.length >= 12, `only ${simFiles.length} files`);
  assert.ok(simFiles.includes('js/core/sim.js'));
  assert.ok(allFiles.includes('js/app/main.js'));
});

test('js/core, js/world and js/sim use nothing forbidden', () => {
  const hits = simFiles.flatMap((f) => findBanned(f, SIM_BANNED, stripSource(fs.readFileSync(path.join(ROOT, f), 'utf8'))));
  assert.deepStrictEqual(hits, []);
});

test('all of js/ avoids Workers, local fetches, module syntax and CDNs', () => {
  const hits = allFiles.flatMap((f) => {
    const raw = fs.readFileSync(path.join(ROOT, f), 'utf8');
    const found = findBanned(f, ALL_BANNED, stripSource(raw));
    if (CDN.test(raw)) found.push(`${f} names a CDN`);
    return found;
  });
  assert.deepStrictEqual(hits, []);
});

test('every runtime file is in the manifest, because the loader cannot find anything else', () => {
  const { manifest } = createTLV({ files: [] });
  const known = new Set([...manifest.sim, ...manifest.browser, 'js/core/namespace.js', 'js/manifest.js', 'js/app/loader.js']);
  assert.deepStrictEqual(allFiles.filter((f) => !known.has(f.split(path.sep).join('/'))), []);
});

test('the lint catches each forbidden item in code', () => {
  const samples = {
    'Math.random': 'var x = Math.random();',
    'Date.now': 'var t = Date.now();',
    'new Date': 'var d = new Date();',
    'performance.now': 'performance.now();',
    document: 'document.body;',
    navigator: 'navigator.userAgent;',
    localStorage: 'localStorage.x;',
    requestAnimationFrame: 'requestAnimationFrame(f);',
    setTimeout: 'setTimeout(f, 1);',
    setInterval: 'setInterval(f, 1);',
    'fetch(': 'fetch("x");',
    XMLHttpRequest: 'new XMLHttpRequest();',
    'new Worker': 'new Worker("x");',
    THREE: 'new THREE.Vector3();',
    'import ': 'import x from "y";',
    'require(': 'var a = require("a");',
    'process.': 'process.exit(0);',
    Buffer: 'Buffer.from("x");'
  };
  for (const [name, code] of Object.entries(samples)) {
    const hits = findBanned('sample', SIM_BANNED, stripSource(code));
    assert.ok(hits.some((h) => h.endsWith(`uses ${name}`)), `${name}: ${hits}`);
  }
  assert.strictEqual(findBanned('sample', ALL_BANNED, stripSource('export default 1;')).length, 1);
  assert.strictEqual(findBanned('sample', ALL_BANNED, stripSource('import "x";')).length, 1);
});

test('the lint does not trip on comments, strings or lookalike names', () => {
  const clean = [
    "// Date.now would be wrong here, and so would document",
    '/* Math.random() and THREE and process.exit */',
    "var a = 'document'; var b = \"Math.random\";",
    'var c = `fetch(x) and new Worker`;',
    'var d = /document/.test(s);',
    'var documentation = 1; var myprocess = {}; myprocess.go = 1; var ArrayBuffer2 = new ArrayBuffer(8);',
    'var THREE_WAY = 3; S.dateNow = 0; obj.import = 1;',
    'var reimport = 1;'
  ];
  for (const code of clean) assert.deepStrictEqual(findBanned('sample', SIM_BANNED, stripSource(code)), [], code);
});

test('the stripper keeps code that follows strings, regexes and templates', () => {
  const hit = (code) => findBanned('sample', SIM_BANNED, stripSource(code)).length > 0;
  assert.ok(hit("var u = 'http://x.com'; Math.random();"), 'a // in a string is no comment');
  assert.ok(hit('var r = /[/]/.test(a); Math.random();'), 'a slash in a class does not end the regex');
  assert.ok(hit('var s = a / b; Math.random(); var t = c / d;'), 'division is no regex');
  assert.ok(hit('var q = `text ${Math.random()} text`;'), 'code inside a template is still code');
  assert.ok(hit('var q = `a${ {x: `b${1}`}.x }c`; Math.random();'), 'nested templates and braces');
  assert.ok(hit("var e = 'it\\'s'; Math.random();"), 'an escaped quote does not end the string');
  assert.ok(hit('var d = 1\n/* multi\nline */ Math.random();'), 'block comments keep line structure');
  assert.ok(hit('function f() { return /x/g; } Math.random();'), 'a regex after return');
});
