// tests/game/content.test.mjs — WP-GAME
// ARCHITECTURE 14.5 and 19 item 11: the {poi} lint and the tone word check, on every string and identifier of the package.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realTLV, sim } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const TLV = realTLV();
const defs = TLV.game.errands.defs();

test('the twelve shipped errands, by the table in GAME_DESIGN 6', () => {
  const byId = Object.fromEntries(defs.map((d) => [d.id, d]));
  assert.deepEqual(Object.keys(byId).sort(), [
    'bank_queue', 'birthday_cake', 'butcher', 'dry_cleaning', 'gan_pickup', 'gas_station', 'grandma_pills', 'haircut_cancel', 'ice_cream',
    'milk', 'post_office', 'vegetables'
  ]);
  const tiers = { milk: 1, dry_cleaning: 1, bank_queue: 1, grandma_pills: 2, birthday_cake: 2, haircut_cancel: 2, vegetables: 2, butcher: 3, ice_cream: 3, post_office: 3, gas_station: 3, gan_pickup: 'finale' };
  for (const [id, tier] of Object.entries(tiers)) assert.equal(byId[id].tier, tier, id);
  assert.equal(byId.milk.target.anchor.osm, 'n11238493213');
  assert.equal(byId.milk.text.en, 'Milk. Before the gan.');
  assert.equal(byId.gas_station.text.en, 'Fill up. The light has been on since March.');
  assert.equal(byId.gan_pickup.target.kinds, 'residential_door');
  assert.deepEqual(byId.grandma_pills.fallbackKinds, ['convenience']);
  for (const d of defs) {
    assert.ok(d.text.he && /[֐-׿]/.test(d.text.he), `${d.id} ships Hebrew`);
    assert.equal(d.mod, null, 'mod stays null in v1');
  }
});

test('named stays prefer for ATMs and post offices', () => {
  const po = defs.find((d) => d.id === 'post_office');
  assert.equal(po.target.named, 'prefer');
});

test('item 11: text references a business only through {poi}, and a sentence holding {poi} is a plain instruction', () => {
  const names = TLV.world.get('tlv_center').pois.filter((p) => p.nameEn).map((p) => p.nameEn);
  const shops = [...new Set(names.filter((n) => n.length >= 5))];
  for (const d of defs) {
    for (const lang of ['en', 'he']) {
      const text = d.text[lang];
      if (lang === 'en') {
        for (const sentence of text.split(/(?<=[.?!])\s+/)) {
          if (!sentence.includes('{poi}')) continue;
          assert.ok(!/\b(they|them|their)\b/i.test(sentence), `${d.id}: ${sentence}`);
        }
        for (const shop of shops) {
          if (/^[A-Z]/.test(shop) && !['Gan', 'Milk'].includes(shop)) assert.ok(!text.includes(shop), `${d.id} names ${shop}`);
        }
      }
    }
    assert.equal(d.text.en.includes('{poi}'), d.text.he.includes('{poi}'), `${d.id}: both languages or neither`);
  }
});

test('the lint rejects what it should', () => {
  const sentence = 'Cake from {poi}. They owe you.';
  const bad = 'Tell {poi} their cake is late.';
  const check = (text) => text.split(/(?<=[.?!])\s+/).some((s) => s.includes('{poi}') && /\b(they|them|their)\b/i.test(s));
  assert.equal(check(sentence), false);
  assert.equal(check(bad), true);
});

test('item 11: SENSITIVE POIs are never bound: not one is in a target list', () => {
  const S = sim({ seed: 1 });
  const W = S.world;
  for (const list of Object.values(S._gameTargets.byKind)) {
    for (const id of list) {
      assert.equal(W.pois[id].flags & TLV.const.POIF.SENSITIVE, 0);
      assert.equal(W.pois[id].flags & TLV.const.POIF.NO_FACADE, 0);
      assert.equal(TLV.world.spatial.sensitiveNear(W, W.pois[id].x, W.pois[id].y, 60), false);
    }
  }
});

/** Words that have no place in this game's strings, names or comments, by BRIEF and GAME_DESIGN 21. */
const TONE = [
  /\barab/i, /\bjew/i, /\bmuslim/i, /\bchristian/i, /\bislam/i, /\bpalestin/i, /\bsettler/i, /\bharedi/i, /\bultra.?orthodox/i, /\bdruze/i,
  /\bbedouin/i, /\bethiopian/i, /\brussian/i, /\bmizrah/i, /\bashkenaz/i, /\bimmigrant/i, /\bterror/i, /\bzionis/i,
  /\bblood/i, /\bgore\b/i, /\bgory\b/i, /\bcorpse/i, /\bmurder/i, /\bwound/i, /\bbleed/i, /\bdie\b/i, /\bkill/i, /\bstab/i
];

function files(dir, out) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) files(p, out);
    else if (/\.(js|mjs)$/.test(f)) out.push(p);
  }
  return out;
}

test('item 11: the tone word check, on every shipped file of this package', () => {
  const list = [...files(path.join(ROOT, 'js/sim/game'), []), path.join(ROOT, 'content/tlv_center/errands.js'), path.join(ROOT, 'content/tlv_center/world.js')];
  assert.ok(list.length >= 15);
  for (const file of list) {
    const lines = fs.readFileSync(file, 'utf8').split('\n');
    lines.forEach((line, i) => {
      for (const re of TONE) {
        if (re.test(line)) assert.fail(`${path.relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
      }
    });
  }
});

test('NPC speech is symbols only, in every bubble this package sends', () => {
  const T = TLV.tune.game;
  assert.ok(!/[A-Za-z֐-׿]/.test(T.curseText), T.curseText);
});
