// tests/peds/pool.test.mjs — slots, IDs, spawn rules and the attacker's guarantee (ARCHITECTURE 12.6).
import test from 'node:test';
import assert from 'node:assert';
import { loadBare, sim, quiet, record, noCrowd, setPlayer, run } from './helpers.mjs';

quiet();

function setup() {
  const TLV = loadBare();
  noCrowd(TLV);
  const S = sim(TLV);
  setPlayer(S, 0, -100);
  return { TLV, S };
}

test('peds.init creates S.pedsys and every slot is free', () => {
  const { S } = setup();
  assert.strictEqual(S.pedsys.nFree, S.peds.length);
  assert.strictEqual(S.peds.filter((p) => p.active).length, 0);
});

test('spawn snaps to the nearest sidewalk, sets px, py, ph, and emits ped.spawn', () => {
  const { TLV, S } = setup();
  const log = record(S);
  const p = TLV.peds.spawn(S, { kind: 'walker', x: 3, y: -100, h: 1 });
  assert.ok(p.active);
  assert.ok(p._p.sw >= 0);
  assert.ok(Math.abs(Math.abs(p.x) - 5.4 - 1.25 + 1.25) < 1.5, `x ${p.x}`);
  assert.deepStrictEqual([p.px, p.py, p.ph], [p.x, p.y, p.h]);
  assert.deepStrictEqual(log.map((e) => [e.name, e.pedId, e.kind]), [['ped.spawn', p.id, 'walker']]);
});

test('a SCRIPT spawn keeps its pose and is left alone', () => {
  const { TLV, S } = setup();
  const p = TLV.peds.spawn(S, { kind: 'attacker', x: 3, y: -100, h: 1, state: 'SCRIPT' });
  assert.deepStrictEqual([p.x, p.y, p.h, p.state], [3, -100, 1, 'SCRIPT']);
  run(TLV, S, 30);
  assert.deepStrictEqual([p.x, p.y, p.h], [3, -100, 1]);
});

test('radius follows the kind: walkers 0.35, riders 0.6', () => {
  const { TLV, S } = setup();
  for (const [kind, r] of [['walker', 0.35], ['phone', 0.35], ['trolley', 0.35], ['passenger', 0.35], ['scooter', 0.6], ['delivery', 0.6]]) {
    assert.strictEqual(TLV.peds.spawn(S, { kind, x: 0, y: -100 }).r, r, kind);
  }
});

test('IDs are never reused and despawn emits ped.despawn', () => {
  const { TLV, S } = setup();
  const log = record(S, ['ped.despawn']);
  const a = TLV.peds.spawn(S, { x: 0, y: -100 });
  const id = a.id;
  TLV.peds.despawn(S, a);
  const b = TLV.peds.spawn(S, { x: 0, y: -100 });
  assert.notStrictEqual(b.id, id);
  assert.strictEqual(b.slot, a.slot);
  assert.deepStrictEqual(log.map((e) => e.pedId), [id]);
  assert.strictEqual(TLV.peds.byId(S, id), null);
  assert.strictEqual(TLV.peds.byId(S, b.id), b);
  assert.strictEqual(TLV.peds.byId(S, -1), null);
});

test('a full pool refuses everyone but the attacker, who evicts the farthest unseen person', () => {
  const { TLV, S } = setup();
  const log = record(S, ['ped.despawn']);
  const list = [];
  for (let i = 0; i < S.peds.length; i++) list.push(TLV.peds.spawn(S, { x: 0, y: -100 + (i % 2) * 30 }));
  assert.strictEqual(TLV.peds.spawn(S, { x: 0, y: 0 }), null);
  const far = list.map((p) => Math.hypot(p.x, p.y + 100)).reduce((a, b) => Math.max(a, b));
  const ids = new Map(list.map((p) => [p.id, Math.hypot(p.x, p.y + 100)]));
  const attacker = TLV.peds.spawn(S, { kind: 'attacker', x: 1, y: -100, state: 'SCRIPT' });
  assert.ok(attacker);
  assert.strictEqual(attacker.kind, 'attacker');
  assert.strictEqual(log.length, 1);
  assert.strictEqual(ids.get(log[0].pedId), far);
});

test('a second attacker evicts someone else, never the first', () => {
  const { TLV, S } = setup();
  for (let i = 0; i < S.peds.length - 1; i++) TLV.peds.spawn(S, { x: 0, y: -100 });
  const first = TLV.peds.spawn(S, { kind: 'attacker', x: 1, y: -100, state: 'SCRIPT' });
  TLV.peds.spawn(S, { kind: 'attacker', x: 2, y: -100, state: 'SCRIPT' });
  assert.ok(first.active);
});

test('bad input never throws: -1 IDs and missing records', () => {
  const { TLV, S } = setup();
  assert.strictEqual(TLV.peds.byId(S, -1), null);
  assert.strictEqual(TLV.peds.obstaclesOnLane(S, -1, []), 0);
  assert.strictEqual(TLV.peds.zoneOccupied(S, -1), false);
  assert.strictEqual(TLV.peds.command(S, null, { type: 'CANCEL' }), false);
  assert.strictEqual(TLV.peds.spawn(S, null), null);
  assert.strictEqual(TLV.peds.command(S, TLV.peds.spawn(S, { x: 0, y: -100 }), { type: 'NO_SUCH' }), false);
  TLV.peds.despawn(S, null);
  TLV.peds.onHit(S, null, 0, 0, 0);
  TLV.peds.onBrush(S, null);
});

test('debug hooks spawn and command from plain values', () => {
  const { TLV, S } = setup();
  const id = TLV.debug.spawnPed({ kind: 'walker', x: 0, y: -100 });
  assert.strictEqual(typeof id, 'number');
  assert.strictEqual(TLV.debug.commandPed(id, { type: 'CANCEL' }), true);
  assert.strictEqual(TLV.debug.commandPed(-5, { type: 'CANCEL' }), false);
  assert.strictEqual(S.peds.filter((p) => p.active).length, 1);
});

test('peds.pool invariant holds, and fails if a slot leaks', () => {
  const { TLV, S } = setup();
  TLV.peds.spawn(S, { x: 0, y: -100 });
  assert.deepStrictEqual(TLV.invariants.run(S), []);
  S.pedsys.nFree--;
  assert.ok(TLV.invariants.run(S).some((f) => f.startsWith('peds.pool')));
});
