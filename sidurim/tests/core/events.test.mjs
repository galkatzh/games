// tests/core/events.test.mjs — WP-CORE
import assert from 'node:assert';
import { test } from 'node:test';
import { coreTLV } from './helpers.mjs';

const { events } = coreTLV();

test('sim listeners run synchronously, in subscription order', () => {
  const bus = events.createBus();
  const log = [];
  bus.on('x', (p) => log.push(['a', p]));
  bus.on('x', (p) => log.push(['b', p]));
  bus.on('y', () => log.push(['never']));
  bus.emit('x', 1);
  assert.deepStrictEqual(log, [['a', 1], ['b', 1]]);
});

test('off removes one subscription, and an unknown off is harmless', () => {
  const bus = events.createBus();
  const log = [];
  const fn = (p) => log.push(p);
  bus.on('x', fn);
  bus.off('x', fn);
  bus.off('x', fn);
  bus.off('nothing', fn);
  bus.emit('x', 1);
  assert.deepStrictEqual(log, []);
});

test('changing subscriptions during an emit does not disturb that emit', () => {
  const bus = events.createBus();
  const log = [];
  const b = () => log.push('b');
  bus.on('x', () => {
    log.push('a');
    bus.off('x', b);
    bus.on('x', () => log.push('late'));
  });
  bus.on('x', b);
  bus.emit('x');
  assert.deepStrictEqual(log, ['a', 'b']);
  log.length = 0;
  bus.emit('x');
  assert.deepStrictEqual(log, ['a', 'late']);
});

test('nothing buffers until enableDrain, so headless runs hold no events', () => {
  const bus = events.createBus();
  for (let i = 0; i < 10; i++) bus.emit('x', i);
  const seen = [];
  bus.drain((n, p) => seen.push([n, p]));
  assert.deepStrictEqual(seen, []);
  bus.enableDrain();
  bus.emit('x', 'after');
  bus.drain((n, p) => seen.push([n, p]));
  assert.deepStrictEqual(seen, [['x', 'after']]);
});

test('drain gives every event once, in order', () => {
  const bus = events.createBus();
  bus.enableDrain();
  bus.emit('a', 1);
  bus.emit('b', 2);
  const seen = [];
  bus.drain((n, p) => seen.push([n, p]));
  assert.deepStrictEqual(seen, [['a', 1], ['b', 2]]);
  bus.drain(() => assert.fail('already drained'));
});

test('an event a listener emits reaches the drain after its cause', () => {
  const bus = events.createBus();
  bus.enableDrain();
  bus.on('player.contact', () => bus.emit('score.bonus', 2));
  bus.on('score.bonus', () => bus.emit('score.chain', 3));
  bus.emit('run.start', 0);
  bus.emit('player.contact', 1);
  bus.emit('run.end', 4);
  const seen = [];
  bus.drain((n, p) => seen.push([n, p]));
  assert.deepStrictEqual(seen, [['run.start', 0], ['player.contact', 1], ['score.bonus', 2], ['score.chain', 3], ['run.end', 4]]);
});

test('a listener that throws does not lose its event from the drain', () => {
  const bus = events.createBus();
  bus.enableDrain();
  bus.on('x', () => { throw new Error('listener bug'); });
  assert.throws(() => bus.emit('x', 1));
  const seen = [];
  bus.drain((n) => seen.push(n));
  assert.deepStrictEqual(seen, ['x']);
});

test('the buffer holds 2048 events and drops the oldest', () => {
  const bus = events.createBus();
  bus.enableDrain();
  for (let i = 0; i < 2048 + 100; i++) bus.emit('x', i);
  const seen = [];
  bus.drain((n, p) => seen.push(p));
  assert.strictEqual(seen.length, 2048);
  assert.strictEqual(seen[0], 100);
  assert.strictEqual(seen[2047], 2147);
  bus.emit('x', 'next');
  bus.drain((n, p) => assert.strictEqual(p, 'next'));
});

test('a throwing frame consumer never sees the same event twice', () => {
  const bus = events.createBus();
  bus.enableDrain();
  bus.emit('a', 1);
  bus.emit('b', 2);
  assert.throws(() => bus.drain(() => { throw new Error('consumer bug'); }));
  const seen = [];
  bus.drain((n) => seen.push(n));
  assert.deepStrictEqual(seen, ['b']);
});

test('sim listeners still run while buffering, and a payload reaches both paths', () => {
  const bus = events.createBus();
  bus.enableDrain();
  const payload = { x: 1 };
  let direct = null;
  bus.on('x', (p) => { direct = p; });
  bus.emit('x', payload);
  assert.strictEqual(direct, payload);
  bus.drain((n, p) => assert.strictEqual(p, payload));
});
