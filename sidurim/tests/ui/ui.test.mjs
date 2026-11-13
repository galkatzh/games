// tests/ui/ui.test.mjs — WP-UI
// What can be proved without a browser: every string in both languages, the tone rules, the event table against ARCHITECTURE 11,
// that no UI code assigns into the sim, and that recordings ship only as packed data URIs.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { createTLV } from '../../tools/lib/classic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const TLV = createTLV({
  files: ['sim', 'js/ui/tune.js', 'js/ui/strings.js', 'js/ui/hud.js', 'js/ui/bubbles.js', 'js/ui/minimap.js', 'js/ui/ui.js'],
  map: null, content: false, allowMissing: true
});
const { table } = TLV.ui.strings;
const UI_FILES = fs.readdirSync(path.join(ROOT, 'js/ui')).map((f) => `js/ui/${f}`);

/** Event names of ARCHITECTURE 11, read from the contract so the two cannot drift. */
function contractEvents() {
  const doc = read('docs/ARCHITECTURE.md');
  const from = doc.indexOf('## 11. Event bus');
  const to = doc.indexOf('## 12. Module APIs');
  return [...doc.slice(from, to).matchAll(/^\| `([a-z.A-Z]+)` \|/gm)].map((m) => m[1]);
}

test('both languages have the same keys', () => {
  assert.deepStrictEqual(Object.keys(table.he).sort(), Object.keys(table.en).sort());
});

test('variables and keycaps match across languages', () => {
  const vars = (s) => (s.match(/\{\w+\}/g) || []).sort();
  const caps = (s) => (s.match(/\[[^\]]+\]/g) || []).sort();
  for (const key of Object.keys(table.en)) {
    assert.deepStrictEqual(vars(table.he[key]), vars(table.en[key]), key);
    assert.deepStrictEqual(caps(table.he[key]), caps(table.en[key]), key);
  }
});

test('the bay\'s line says stop only once stopping would pass, in both languages', () => {
  const { parkKey } = TLV.ui.strings;
  assert.strictEqual(parkKey({ stage: 'ARMED', would: 'UGLY' }), 'park.ARMED');
  assert.strictEqual(parkKey({ stage: 'ARMED', would: 'GOOD' }), 'park.STOP');
  assert.strictEqual(parkKey({ stage: 'ARMED', would: 'PERFECT' }), 'park.STOP');
  assert.strictEqual(parkKey({ stage: 'ARMED', would: null }), 'park.ARMED', 'with nothing published it does not say stop');
  assert.strictEqual(parkKey({ stage: 'SNAP', would: null }), 'park.SNAP');
  assert.strictEqual(parkKey({ stage: 'FILL', would: null }), 'park.FILL');
  for (const lang of ['en', 'he']) {
    assert.ok(table[lang]['park.ARMED'].length > 0 && table[lang]['park.STOP'].length > 0);
    assert.notStrictEqual(table[lang]['park.ARMED'], table[lang]['park.STOP']);
  }
  assert.doesNotMatch(table.en['park.ARMED'], /STOP/, 'the line that says keep going must not say stop');
  assert.doesNotMatch(table.he['park.ARMED'], /לעצור/);
  assert.match(table.en['park.STOP'], /STOP/);
  assert.match(table.he['park.STOP'], /לעצור/);
});

test('the credits name what the licences ask for, in plain text and in both languages', () => {
  const { CREDITS, OSM } = TLV.ui.strings;
  assert.strictEqual(OSM, '© OpenStreetMap contributors');
  assert.match(CREDITS.odbl, /ODbL/);
  assert.match(CREDITS.osmUrl, /openstreetmap\.org\/copyright/);
  assert.match(CREDITS.three, /Three\.js/);
  assert.match(CREDITS.threeLine, /MIT/);
  assert.deepStrictEqual(Object.keys(CREDITS.licences).sort(), ['cc-by-4.0', 'cc-by-sa', 'cc0'], 'own work has words of its own, in each language');
  assert.ok(table.en['credits.own'] && table.he['credits.own']);
});

test('Hebrew strings are written in Hebrew', () => {
  const latin = new Set(['title.langName', 'title.langKey', 'hud.bayTag']);
  for (const [key, text] of Object.entries(table.he)) {
    if (latin.has(key) || text === '') continue;
    assert.ok(/[֐-׿]/.test(text), `${key}: ${text}`);
    const words = text.replace(/\[[^\]]+\]/g, '').replace(/\{\w+\}/g, '');
    assert.ok(!/[A-Za-z]/.test(words), `${key} carries Latin letters: ${text}`);
  }
});

test('the bay line tells a car to slow, and neither language says to keep rolling', () => {
  assert.strictEqual(table.en['park.ARMED'], 'CREEP. STRAIGHTEN UP.');
  assert.doesNotMatch(table.en['park.ARMED'], /ROLLING/);
  assert.doesNotMatch(table.he['park.ARMED'], /להמשיך/);
  assert.match(table.en['park.BRAKE'], /BRAKE/);
  assert.match(table.he['park.BRAKE'], /לבלום/);
});

test('every screen a person without a keyboard or a picture sees is in both languages', () => {
  for (const key of ['title.touch', 'lost.title', 'lost.wait', 'lost.reload', 'lost.button', 'pause.resumePad', 'chase.thisWay', 'knife.CHASE_ROUND']) {
    assert.ok(table.en[key] && table.he[key], key);
  }
  assert.match(table.en['title.touch'], /KEYBOARD/);
  assert.match(table.en['title.touch'], /GAMEPAD/);
  assert.match(table.he['title.touch'], /מקלדת/);
});

test('every errand-level id the sim can send has its text', () => {
  const keys = new Set(Object.keys(table.en));
  for (const id of ['BEAT_THE_HONK', 'HANDBRAKE_PARK', 'AFTER_YOU', 'GAVE_WAY', 'SPOTLESS', 'EXIT_REACHED_SHOP']) assert.ok(keys.has(`bonus.${id}`), id);
  for (const r of ['NEW_DRIVER', 'BUS_DRIVER', 'TAXI_DRIVER', 'DELIVERY_RIDER', 'LEGEND']) assert.ok(keys.has(`rank.${r}`), r);
  for (const r of ['CLOCK', 'TOWED', 'CAUGHT', 'REVOKED', 'WIN']) {
    assert.ok(keys.has(`end.${r}.title`), r);
    assert.ok(keys.has(`end.${r}.line`), r);
  }
  for (const q of ['PERFECT', 'GOOD', 'UGLY', 'DOUBLE']) assert.ok(keys.has(`quality.${q}`) && keys.has(`qualityLine.${q}`), q);
  for (const x of ['REACHED_SHOP', 'SHAKEN', 'WHISTLE']) assert.ok(keys.has(`resolve.${x}.title`) && keys.has(`resolve.${x}.line`), x);
  for (const s of ['STANDOFF', 'DOOR_TUG', 'BAIL', 'DRAGGED', 'CHASE']) assert.ok(keys.has(`knife.${s}`), s);
});

test('the seventeen incidents of GAME_DESIGN 11.1 all have a chevron label', () => {
  const doc = read('docs/GAME_DESIGN.md');
  const from = doc.indexOf('### 11.1 Incident catalog');
  const ids = [...doc.slice(from, doc.indexOf('## 12. Parking rules')).matchAll(/^\| `([A-Z_]+)` \|/gm)].map((m) => m[1]);
  assert.strictEqual(ids.length, 17);
  for (const id of ids) assert.ok(table.en[`incident.${id}`] && table.he[`incident.${id}`], id);
});

test('the lines the design fixes are word for word', () => {
  const en = table.en;
  assert.strictEqual(en['end.CLOCK.line'], 'The gan called. Again.');
  assert.strictEqual(en['end.TOWED.line'], 'Your car has been reassigned.');
  assert.strictEqual(en['end.CAUGHT.line'], 'You wake on a bench. There is a parking ticket under your shoe.');
  assert.strictEqual(en['end.WIN.line'], 'You survived Tuesday.');
  assert.strictEqual(en['end.REVOKED.title'], 'LICENCE REVOKED');
  assert.strictEqual(en['toast.redRun'], 'The camera has been broken since 2019.');
  assert.strictEqual(en['toast.water'], 'The sea is not a shortcut.');
  assert.strictEqual(en['toast.recalc.0'], 'Recalculating. Disappointed.');
  assert.strictEqual(en['toast.recalc.1'], 'In 200 metres, regret.');
  assert.strictEqual(en['prompt.search'], 'SLOW BELOW 25 KM/H, NOSE INTO THE BOX');
  assert.strictEqual(en['prompt.wait'], 'WAIT BEHIND HIM: +5 s');
  assert.strictEqual(en['prompt.parkBadly'], '[Q]: PARK BADLY');
  assert.strictEqual(en['knife.DOOR_TUG'], '[E] OUT THE PASSENGER SIDE');
});

test('a missed bay has a line for each answer the sim can give, in both languages', () => {
  for (const lang of ['en', 'he']) {
    for (const answer of ['BACK', 'BACK_OR_Q']) assert.match(table[lang][`prompt.missed.${answer}`], /\[S\]/, `${lang} ${answer}`);
    assert.match(table[lang]['prompt.missed.BACK_OR_Q'], /\[Q\]/, lang);
    assert.ok(!table[lang]['prompt.missed.BACK'].includes('[Q]'), `${lang}: Q is out of reach in this case`);
  }
});

test('every reason an UGLY stamp can give has its text, in both languages', () => {
  for (const lang of ['en', 'he']) {
    for (const why of ['OFFSET', 'CROOKED', 'ANY', 'CURB']) assert.ok(table[lang][`qualityWhy.${why}`], `${lang} ${why}`);
  }
});

test('the SEARCH line follows one rule on every errand, and the rule is the agreed 60 m', () => {
  assert.strictEqual(TLV.tune.ui.searchPromptLeftM, 60);
  assert.strictEqual(TLV.tune.ui.searchPromptAllErrands, undefined);
  assert.ok(!read('js/ui/hud.js').includes('errandIndex < T.search'));
});

test('a pop stops rising short of the mast band, at any window shape', () => {
  const css = read('css/ui.css');
  const stackTop = Number(/\.hud-pops \{[^}]*?top: ([\d.]+)%/.exec(css)[1]);
  const largest = Math.max(...[...css.matchAll(/\.pop(?:\.\w+)? \{[^}]*?font-size: ([\d.]+)em/g)].map((m) => Number(m[1])));
  const rise = Number(/@keyframes pop-in \{[^@]*?100% \{ transform: translateY\(-([\d.]+)em\)/.exec(css)[1]);
  // The HUD's em is at most a 45th of the height, so this is the furthest it can go. 37.5% is the 270 of 720 that ui.e2e.cjs holds it to.
  assert.ok(stackTop - largest * rise * 100 / 45 >= 37.5, `${stackTop}% less ${rise} of ${largest}em`);
});

test('English says what the gan is, in plain words', () => {
  assert.match(table.en['title.gan'], /picking the kid up from the kindergarten/);
});

test('a revoked licence and a hit person carry no joke', () => {
  for (const lang of ['en', 'he']) {
    assert.strictEqual(table[lang]['end.REVOKED.line'], '');
  }
  assert.match(table.en['toast.hitPed'], /^YOU HIT A PERSON\./);
  assert.ok(!/[!?]/.test(table.en['toast.hitPed']));
});

test('tone: no word the brief rules out, in any language', () => {
  const banned = [
    /blood/i, /gore/i, /\bkill/i, /\bmurder/i, /\bdead\b/i, /\bstab/i, /corpse/i, /arab/i, /\bjew/i, /muslim/i, /christian/i, /orthodox/i,
    /haredi/i, /russian/i, /ethiopian/i, /settler/i, /\bleft-?wing/i, /\bright-?wing/i, /accent/i, /terror/i,
    /(^|\s)דם/, /רצח/, /להרוג/, /ערבי/, /יהודי/, /מוסלמי/, /נוצרי/, /דתי/, /חרדי/, /רוסי/, /אתיופי/, /מתנחל/, /מבטא/, /טרור/
  ];
  for (const lang of ['en', 'he']) {
    for (const [key, text] of Object.entries(table[lang])) {
      for (const re of banned) assert.ok(!re.test(text), `${lang} ${key}: ${text}`);
    }
  }
  // Scoring text never rewards anything to do with a person being hit.
  for (const lang of ['en', 'he']) {
    for (const key of Object.keys(table[lang])) assert.ok(!/^bonus\..*(HIT|PED)/.test(key), key);
  }
});

test('the attribution is exact, and identical in both languages', () => {
  assert.strictEqual(TLV.ui.strings.OSM, '© OpenStreetMap contributors');
});

test('difficulty text: one comic line each, in both languages', () => {
  for (const lang of ['en', 'he']) {
    for (const d of ['relaxed', 'normal']) {
      assert.ok(table[lang][`diff.${d}.name`], d);
      const line = table[lang][`diff.${d}.line`];
      assert.ok(line && !line.includes('\n'), d);
    }
  }
});

test('isolate keeps a signed sum in one piece in Hebrew', () => {
  const s = TLV.ui.strings;
  s.setLang('he');
  const text = s.t('toast.ticket', { money: s.money(-200) });
  assert.ok(text.includes('⁦-₪200⁩'), text);
  assert.ok(s.t('hud.errand', { n: 1, total: 7 }).includes('⁦1/7⁩'));
  s.setLang('en');
  assert.strictEqual(s.t('toast.ticket', { money: s.money(-200) }).includes('⁦'), false);
  assert.strictEqual(s.money(1240), '₪1,240');
  assert.strictEqual(s.signedMoney(25), '+₪25');
  assert.strictEqual(s.signedMoney(-500), '-₪500');
});

test('keycaps split out of a string', () => {
  assert.deepStrictEqual(TLV.ui.strings.parts('[E] OUT'), [{ key: true, text: 'E' }, { key: false, text: ' OUT' }]);
  assert.deepStrictEqual(TLV.ui.strings.parts('plain'), [{ key: false, text: 'plain' }]);
});

test('bubble filter takes symbols and refuses words in any script', () => {
  const ok = TLV.ui.bubbles.symbolsOnly;
  for (const s of ['#@!', '!', '!?', '?!', '***', '$%&']) assert.strictEqual(ok(s), true, s);
  for (const s of ['hey', 'יא', '!a', 'a!', '5', '٣', '', null, undefined, 7]) assert.strictEqual(ok(s), false, String(s));
});

test('every bubble the sim sends passes the filter', () => {
  const texts = new Set();
  const walk = (dir) => {
    for (const f of fs.readdirSync(path.join(ROOT, dir))) {
      const rel = `${dir}/${f}`;
      if (fs.statSync(path.join(ROOT, rel)).isDirectory()) walk(rel);
      else if (f.endsWith('.js')) {
        for (const m of read(rel).matchAll(/'bubble',\s*\{[^}]*text:\s*'([^']+)'/g)) texts.add(m[1]);
      }
    }
  };
  walk('js/sim');
  assert.ok(texts.size >= 1);
  for (const t of texts) assert.strictEqual(TLV.ui.bubbles.symbolsOnly(t), true, t);
  assert.strictEqual(TLV.ui.bubbles.symbolsOnly(read('js/sim/game/tune.js').match(/curseText: '([^']+)'/)[1]), true);
});

test('the clock reads as the design shows it', () => {
  const f = TLV.ui.hud.clockText;
  assert.strictEqual(f(120), '2:00');
  assert.strictEqual(f(61.2), '1:02');
  assert.strictEqual(f(20), '0:20');
  assert.strictEqual(f(9.44), '9.4');
  assert.strictEqual(f(0), '0.0');
  assert.strictEqual(f(-3), '0.0');
});

test('minimap place: the view heading points up, and its left is on the left', () => {
  const out = { x: 0, y: 0 };
  const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} vs ${b}`);
  const place = TLV.ui.minimap.place;
  // Facing north, east is right and north is up.
  place(10, 0, Math.PI / 2, 1, out);
  near(out.x, 10);
  near(out.y, 0);
  place(0, 10, Math.PI / 2, 1, out);
  near(out.x, 0);
  near(out.y, -10);
  // Facing east, north is on the left and east is up.
  place(0, 10, 0, 2, out);
  near(out.x, -20);
  near(out.y, 0);
  place(10, 0, 0, 1, out);
  near(out.x, 0);
  near(out.y, -10);
  // Facing west, north is on the right.
  place(0, 10, Math.PI, 1, out);
  near(out.x, 10);
  near(out.y, 0);
});

test('every event of ARCHITECTURE 11 has a handling, or an explicit none', () => {
  const events = contractEvents();
  assert.ok(events.length >= 45, `read ${events.length}`);
  assert.deepStrictEqual(Object.keys(TLV.ui.EVENTS).sort(), [...events].sort());
  for (const [name, who] of Object.entries(TLV.ui.EVENTS)) assert.ok(Array.isArray(who) && who.length > 0, name);
});

test('the event table tells the truth about each consumer', () => {
  const sources = {
    hud: read('js/ui/hud.js'), audio: read('js/ui/audio.js'), cards: read('js/ui/cards.js'),
    menus: read('js/ui/menus.js'), bubbles: read('js/ui/bubbles.js'), debug: read('js/ui/debug_overlay.js'),
    versus: read('js/ui/versus.js')
  };
  for (const [name, who] of Object.entries(TLV.ui.EVENTS)) {
    const claimed = who.filter((w) => w !== 'none');
    if (who.includes('none')) assert.strictEqual(who.length, 1, name);
    for (const w of claimed) {
      assert.ok(sources[w].includes(`'${name}'`), `${name} claims ${w}, which never names it`);
    }
    for (const [module, src] of Object.entries(sources)) {
      if (src.includes(`'${name}'`)) assert.ok(claimed.includes(module), `${module} handles ${name}, which the table omits`);
    }
  }
});

test('no UI code assigns into the sim', () => {
  const roots = ['S', 'sim', 'g', 'veh', 'nav', 'e', 'c', 'k', 'p', 'player', 'game'];
  const pattern = new RegExp(`(^|[^\\w.'])(${roots.join('|')})\\.[A-Za-z_][\\w.\\[\\]]*\\s*(=[^=>]|\\+=|-=|\\+\\+|--)`);
  const allowed = [/\bnode\./, /\bdom\./];
  for (const file of UI_FILES) {
    read(file).split('\n').forEach((line, i) => {
      if (line.trim().startsWith('//') || line.trim().startsWith('*')) return;
      if (!pattern.test(line) || allowed.some((re) => re.test(line))) return;
      assert.fail(`${file}:${i + 1}: ${line.trim()}`);
    });
  }
});

test('the only sim calls in the UI are the bus, setDifficulty, and a shared day\'s board from its own file', () => {
  for (const file of UI_FILES) {
    const src = read(file);
    assert.ok(!/TLV\.(sim|traffic|peds|player|foot|collide)\.[a-zA-Z]+\s*\(/.test(src), file);
    const game = [...src.matchAll(/TLV\.game\.(\w+)/g)].map((m) => m[1]);
    // Picking from the board is a choice made on a screen, like the difficulty. One file makes it, and the rest ask that file.
    const board = file === 'js/ui/versus.js';
    for (const name of game) assert.ok(name === 'score' || name === 'setDifficulty' || (board && name === 'versus'), `${file}: TLV.game.${name}`);
    assert.strictEqual(/TLV\.net\b/.test(src), board, `${file}: only the board's file reaches the room`);
    const signals = [...src.matchAll(/signals\.(\w+)\b/g)].map((m) => m[1]);
    for (const name of signals) assert.strictEqual(name, 'laneState', file);
  }
});

test('the score hook the UI reads is pure', () => {
  assert.ok(/score\.rank = function \(money\)/.test(read('js/sim/game/score.js')));
});

test('recordings ship only as packed data URIs, and the only other sound the game loads is a live radio stream', () => {
  const found = [];
  const skip = new Set(['node_modules', 'cache', '.git']);
  const walk = (dir) => {
    for (const f of fs.readdirSync(dir)) {
      if (skip.has(f)) continue;
      const full = path.join(dir, f);
      if (fs.statSync(full).isDirectory()) walk(full);
      else if (/\.(mp3|ogg|wav|flac|m4a|aac|opus|webm)$/i.test(f)) found.push(path.relative(ROOT, full));
    }
  };
  walk(ROOT);
  assert.deepStrictEqual(found.filter((f) => !f.startsWith(`assets_src${path.sep}sounds${path.sep}`)), [], 'originals stay in assets_src/sounds');

  const scope = { TLV: {} };
  vm.runInNewContext(read('data/sounds/index.js'), scope);
  vm.runInNewContext(read('data/sounds/sounds.js'), scope);
  const index = scope.TLV.soundIndex;
  assert.strictEqual(index.src, 'data/sounds/sounds.js');
  assert.deepStrictEqual(Object.keys(scope.TLV.sounds), Array.from(index.ids));
  for (const [id, uri] of Object.entries(scope.TLV.sounds)) assert.match(uri, /^data:audio\/(mpeg|wav);base64,/, id);
  for (const c of index.credits) {
    assert.ok(c.author && c.title && c.license && /^https:\/\//.test(c.source), JSON.stringify(c));
    assert.ok(['cc0', 'cc-by-4.0', 'cc-by-sa', 'own'].includes(c.license), c.license);
  }
  for (const id of ['car_a', 'car_b', 'car_hold', 'bus_toot', 'bus_double', 'bus_triple', 'bus_long']) assert.ok(index.ids.includes(id), id);

  const src = read('js/ui/audio.js');
  const assigned = [...src.matchAll(/(\w+)\.src\s*=\s*([^;]+);/g)].map((m) => `${m[1]}.src = ${m[2]}`);
  assert.deepStrictEqual(assigned, ['script.src = index.src', 'el.src = st.url'], 'only the packed script and a radio station');
  assert.ok(!/XMLHttpRequest|\bfetch\(\s*['"]/.test(src), 'no file is fetched by path');
  const fetched = [...src.matchAll(/window\.fetch\(([^)]*)\)/g)].map((m) => m[1]);
  assert.deepStrictEqual(fetched, ['RADIO_API[i++] + RADIO_QUERY']);
  const stations = [...src.matchAll(/url: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(stations.length >= 10);
  for (const url of stations) assert.match(url, /^https:\/\//, url);
});

test('storage is only touched inside try', () => {
  for (const file of UI_FILES) {
    const src = read(file);
    const uses = (src.match(/localStorage/g) || []).length;
    if (file === 'js/ui/ui.js') assert.strictEqual(uses, 2);
    else if (file !== 'js/ui/ui.js') assert.strictEqual(uses, 0, file);
  }
  const src = read('js/ui/ui.js');
  assert.ok(/try \{\s*return window\.localStorage\.getItem/.test(src));
  assert.ok(/try \{\s*window\.localStorage\.setItem/.test(src));
});
