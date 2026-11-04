// tests/core/registry.test.mjs — WP-CORE
import assert from 'node:assert';
import { test } from 'node:test';
import { captureWarnings, coreTLV } from './helpers.mjs';

test('drain dispatches in order and only to the matching handler', () => {
  const TLV = coreTLV();
  const seen = [];
  TLV.registry.on('errand', (p) => seen.push(['errand', p.id]));
  TLV.registry.on('map', (p) => seen.push(['map', p.id]));
  TLV.q.push(['errand', { id: 'a' }], ['map', { id: 'b' }], ['errand', { id: 'c' }]);
  TLV.registry.drain();
  assert.deepStrictEqual(seen, [['errand', 'a'], ['map', 'b'], ['errand', 'c']]);
  assert.strictEqual(TLV.q.length, 0);
});

test('items with no handler stay queued without error, which is why render content is harmless in Node', () => {
  const TLV = coreTLV();
  TLV.q.push(['storefront', { id: 's' }]);
  TLV.registry.drain();
  TLV.registry.drain();
  assert.deepStrictEqual(TLV.q, [['storefront', { id: 's' }]]);
  assert.deepStrictEqual(TLV.registry.problems(), []);
  const seen = [];
  TLV.registry.on('storefront', (p) => seen.push(p.id));
  TLV.registry.drain();
  assert.deepStrictEqual(seen, ['s']);
});

test('drain is repeatable and dispatches each item once, which is how late asset items arrive', () => {
  const TLV = coreTLV();
  const seen = [];
  TLV.registry.on('asset', (p) => seen.push(p.id));
  TLV.q.push(['asset', { id: 1 }]);
  TLV.registry.drain();
  TLV.registry.drain();
  TLV.q.push(['asset', { id: 2 }]);
  TLV.registry.drain();
  assert.deepStrictEqual(seen, [1, 2]);
});

test('TLV.q stays the same array, because data files hold no reference but scripts keep pushing to it', () => {
  const TLV = coreTLV();
  const q = TLV.q;
  TLV.registry.on('asset', () => {});
  q.push(['asset', {}]);
  TLV.registry.drain();
  assert.strictEqual(TLV.q, q);
});

test('a handler may queue more items, and may call drain', () => {
  const TLV = coreTLV();
  const seen = [];
  TLV.registry.on('kit', (p) => {
    seen.push(p.id);
    if (p.id === 1) {
      TLV.q.push(['kit', { id: 2 }]);
      TLV.registry.drain();
    }
  });
  TLV.q.push(['kit', { id: 1 }]);
  TLV.registry.drain();
  assert.deepStrictEqual(seen, [1, 2]);
  assert.strictEqual(TLV.q.length, 0);
});

test('problem warns and is listed, and problems returns a copy', () => {
  const TLV = coreTLV();
  const warnings = captureWarnings(() => TLV.registry.problem('errand', 'x', 'no text'));
  assert.strictEqual(warnings.length, 1);
  assert.deepStrictEqual(TLV.registry.problems(), [{ type: 'errand', id: 'x', reason: 'no text' }]);
  TLV.registry.problems().length = 0;
  assert.strictEqual(TLV.registry.problems().length, 1);
});

test('invalid content never stops a drain', () => {
  const TLV = coreTLV();
  const seen = [];
  TLV.registry.on('errand', (p) => {
    if (p.bad) throw new Error('boom');
    seen.push(p.id);
  });
  TLV.q.push('nonsense', ['errand', { id: 'bad', bad: true }], [7, {}], ['errand', { id: 'good' }]);
  const warnings = captureWarnings(() => TLV.registry.drain());
  assert.deepStrictEqual(seen, ['good']);
  assert.strictEqual(warnings.length, 3);
  const problems = TLV.registry.problems();
  assert.deepStrictEqual(problems.map((p) => p.type), ['queue', 'errand', 'queue']);
  assert.strictEqual(problems[1].id, 'bad');
  assert.match(problems[1].reason, /boom/);
});

test('contentHash covers errand, incident and spawn items, and nothing else', () => {
  const hash = (items) => {
    const TLV = coreTLV();
    TLV.q.push(...items);
    return TLV.registry.contentHash();
  };
  const base = [['errand', { id: 'milk', tier: 1 }], ['incident', { id: 'BUS' }], ['spawn', { map: 'm', sFromEnd: 40 }]];
  const h = hash(base);
  assert.strictEqual(hash([...base, ['storefront', { id: 's' }], ['asset', { id: 'a' }], ['style', { id: 'b' }]]), h);
  assert.notStrictEqual(hash([['errand', { id: 'milk', tier: 2 }], base[1], base[2]]), h);
  assert.notStrictEqual(hash([base[0], ['incident', { id: 'OTHER' }], base[2]]), h);
  assert.notStrictEqual(hash([base[0], base[1], ['spawn', { map: 'm', sFromEnd: 41 }]]), h);
  assert.notStrictEqual(hash(base.slice(0, 2)), h);
});

test('contentHash does not depend on key order, item order, or whether items were drained', () => {
  const a = coreTLV();
  a.q.push(['errand', { id: 'x', text: { en: 'E', he: 'ה' } }], ['spawn', { map: 'm' }]);
  const b = coreTLV();
  b.q.push(['spawn', { map: 'm' }], ['errand', { text: { he: 'ה', en: 'E' }, id: 'x' }]);
  assert.strictEqual(a.registry.contentHash(), b.registry.contentHash());
  const before = a.registry.contentHash();
  a.registry.on('errand', () => {});
  a.registry.drain();
  assert.strictEqual(a.registry.contentHash(), before);
});
