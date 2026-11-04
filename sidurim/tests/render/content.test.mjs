// tests/render/content.test.mjs — WP-RENDER
import test from 'node:test';
import assert from 'node:assert';
import { pureTLV } from './helpers.mjs';
import { createTLV } from '../../tools/lib/classic.mjs';

/** Items of a queue type, read before any handler claims them. */
function queued(type) {
  const TLV = createTLV({ files: ['sim'], map: 'tlv_center', content: true, allowMissing: true });
  return TLV.q.filter((i) => i[0] === type).map((i) => i[1]);
}

test('every shipped style names tiles and providers that exist', () => {
  const TLV = pureTLV();
  const kit = queued('kit');
  const tiles = new Set(kit.filter((k) => k.slot === 'facade.tile').map((k) => k.id));
  for (const id of ['wall_default', 'ground_default', 'shop_default']) tiles.add(id);
  for (const st of queued('style')) {
    for (const [role, name] of Object.entries(st.tiles)) assert.ok(tiles.has(name), `${st.id}.${role} = ${name}`);
    for (const [slot, want] of Object.entries(st.slots || {})) {
      for (const id of [].concat(want)) assert.ok(kit.some((k) => k.slot === slot && k.id === id), `${st.id}: ${slot}/${id}`);
    }
  }
  assert.deepStrictEqual(TLV.registry.problems(), []);
});

test('tiles fit the facade array', () => {
  const layers = queued('kit').filter((k) => k.slot === 'facade.tile').reduce((n, k) => n + (k.variants || 1), 0);
  assert.ok(layers + 3 <= 32, `${layers} + 3 built-in layers`);
});

test('every landmark in the contract table resolves', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const needed = ['w90723265', 'w90723261', 'w90723278', 'w509799257', 'w860931326', 'w149522836', 'w284108856', 'w31786632', 'r15311025', 'w640627236'];
  const items = queued('landmark');
  for (const ref of needed) assert.ok(items.some((l) => l.anchor.osm === ref), ref);
  for (const l of items) {
    assert.notStrictEqual(TLV.anchors.resolve(W, l.anchor, { type: 'building' }).how, 'orphan', l.id);
    if (l.style) assert.ok(TLV.render.styles.get(l.style), l.style);
  }
});

test('curated storefronts resolve, and carry no art unless it is credited', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  for (const s of queued('storefront')) {
    assert.notStrictEqual(TLV.anchors.resolve(W, s.anchor, { type: 'poi' }).how, 'orphan', s.id);
    if (s.art) assert.ok(s.credit && s.attest, s.id);
  }
});

test('district style weights name real styles, and a default exists', () => {
  const TLV = pureTLV();
  const list = queued('district');
  assert.ok(list.some((d) => d.default));
  for (const d of list) for (const k of Object.keys(d.weights)) assert.ok(TLV.render.styles.get(k), `${d.id}: ${k}`);
});

test('style choice is stable, and districts reach the buildings they claim', () => {
  const TLV = pureTLV();
  const W = TLV.world.get('tlv_center');
  const S = TLV.render.styles;
  const a = W.blds.map((b) => S.choose(W, b.id));
  const b = W.blds.map((x) => S.choose(W, x.id));
  assert.deepStrictEqual(a, b);
  const counts = {};
  a.forEach((s) => { counts[s] = (counts[s] || 0) + 1; });
  for (const s of ['bauhaus_ribbon', 'bauhaus_shutter', 'concrete_block', 'eclectic_wood', 'jaffa_stone']) assert.ok(counts[s] > 100, `${s}: ${counts[s]}`);
});
