// tests/game/gan_binds.test.mjs — WP-GAME
// The kindergarten pickup is the point of the day, so a day is never won without it, and no errand of the plan is skipped. 400 seeds,
// on the shipped errands and with the README's own example added, which changes what every seed draws.
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { assert, realTLV, sim, toDrive, nextErrand } from './helpers.mjs';
import { createTLV, createSim } from '../../tools/lib/classic.mjs';

const TLV = realTLV();
const W = TLV.world.get('tlv_center');
const QUIET = { notitle: 1, traffic: 0, peds: 0, incidents: 0, contest: 'off' };

/** Walks a seed's day through the real flow, parking at once. @returns {string} What went wrong, or ''. */
function walkDay(T, seed) {
  const S = createSim(T, { seed, params: { ...QUIET } });
  T.sim.step(S);
  const plan = S.game._g.plan;
  if (plan[plan.length - 1] !== 'gan_pickup') return `seed ${seed}: the plan ends in ${plan[plan.length - 1]}`;
  for (let i = 0; i < 7; i++) {
    const g = S.game;
    if (g.phase === 'RUN_END') return `seed ${seed}: run ended ${g.endReason} on errand ${i}`;
    if (g.errandIndex !== i) return `seed ${seed}: errand ${i} was skipped`;
    if (!g.errand) return `seed ${seed}: errand ${i} has no binding`;
    if (g.errand.bayId < 0) return `seed ${seed}: errand ${i} has no bay`;
    if (Math.hypot(g.errand.doorX - g._g.from.x, g.errand.doorY - g._g.from.y) < 220) return `seed ${seed}: door ${i} is under 220 m from the start`;
    if (T.world.spatial.sensitiveNear(W, g.errand.doorX, g.errand.doorY, 60)) return `seed ${seed}: door ${i} is by something sensitive`;
    g.clock = 500;
    for (let n = 0; n < 12 * 60 && g.phase !== 'DRIVE'; n++) T.sim.step(S);
    if (g.phase !== 'DRIVE') return `seed ${seed}: errand ${i} never reached DRIVE`;
    if (i === 6) return g.errand.defId === 'gan_pickup' ? '' : `seed ${seed}: the last errand is ${g.errand.defId}`;
    T.debug.parkNow({ quality: 'GOOD' });
    for (let n = 0; n < 12 * 60 && S.game.errandIndex === i && S.game.phase !== 'RUN_END'; n++) T.sim.step(S);
  }
  return `seed ${seed}: the day ran out`;
}

/** @returns {object} The first js block under the README's "Add an errand", as a definition. */
function readmeErrand() {
  const text = fs.readFileSync(new URL('../../README.md', import.meta.url), 'utf8');
  const part = text.slice(text.indexOf('### Add an errand'));
  const code = part.slice(part.indexOf('```js') + 5, part.indexOf('```', part.indexOf('```js') + 5));
  return vm.runInNewContext(`(${code.trim().replace(/,\s*$/, '')})`);
}

test('400 seeds: every day binds seven errands and reaches the gan, on the shipped errands', () => {
  const bad = [];
  for (let seed = 1; seed <= 400; seed++) {
    const why = walkDay(TLV, seed);
    if (why) bad.push(why);
  }
  assert.deepEqual(bad, []);
});

test('400 seeds: the same with the README\'s example errand added', () => {
  const T = createTLV({ map: 'tlv_center', allowMissing: true, params: {} });
  const def = readmeErrand();
  assert.equal(def.id, 'fresh_bread');
  T.game.errands.onDef(def);
  assert.equal(T.game.errands.defs().length, 13);
  const bad = [];
  let drew = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const why = walkDay(T, seed);
    if (why) bad.push(why);
    const S = createSim(T, { seed, params: { ...QUIET } });
    T.sim.step(S);
    if (S.game._g.plan.includes('fresh_bread')) drew++;
  }
  assert.deepEqual(bad, []);
  assert.ok(drew > 40, `the example is drawn: ${drew} days`);
});

test('seed 304, the day that used to win before the gan: the pickup is bound, and from where the car really stands', () => {
  const S = sim({ seed: 304 });
  for (let i = 0; i < 6; i++) {
    S.game.clock = 500;
    toDrive(S);
    nextErrand(S, { quality: 'GOOD' });
  }
  const g = S.game;
  assert.equal(g.errandIndex, 6);
  assert.equal(g.errand.defId, 'gan_pickup');
  assert.notEqual(g.phase, 'RUN_END');
  assert.ok(g.errand.routeLen > 300, `${g.errand.routeLen} m`);
});

test('no gan street in reach: the gan stands behind a safe stall, keeps its name, and prefers a residential street', () => {
  const S = sim({ seed: 9 });
  const g = S.game;
  S._gameTargets.gan = [];
  g._g.plan[6] = 'gan_pickup';
  const e = TLV.game.errands.bind(S, 6);
  assert.ok(e, 'bound');
  assert.equal(e.defId, 'gan_pickup');
  assert.equal(e.poiId, -1);
  assert.equal(e.name.en, 'the gan');
  assert.equal(W.edges[e._doorEdge].cls, TLV.tune.game.ganClass);
  assert.equal(TLV.world.spatial.sensitiveNear(W, e.doorX, e.doorY, 60), false);
  assert.ok(Math.hypot(e.doorX - g._g.from.x, e.doorY - g._g.from.y) >= 200, 'not at the car\'s feet');
  assert.ok(e._doorRoute.len > 0);
});

test('an errand with no door of any kind, and no other definition, falls back to a stall with a plain name', () => {
  const S = sim({ seed: 9 });
  const g = S.game;
  const kinds = S._gameTargets.byKind;
  S._gameTargets.byKind = Object.create(null);
  // Every other definition is taken, so rung 5 has nothing left.
  g._g.plan = TLV.game.errands.defs().map((d) => d.id);
  const e = TLV.game.errands.bind(S, 2);
  S._gameTargets.byKind = kinds;
  assert.ok(e, 'bound');
  assert.equal(e.defId, g._g.plan[2]);
  assert.equal(e.poiId, -1);
  assert.equal(e.name.en, 'the shop');
  assert.ok(!e.text.en.includes('the gan'), e.text.en);
  assert.ok(e.bayId === -1 && e._doorRoute.len > 0);
});

test('a car stranded where no route starts still gets its gan: the leg is laid out from the spawn', () => {
  const S = sim({ seed: 9 });
  const g = S.game;
  g._g.from = { x: 1e6, y: 1e6, h: 0 };
  const e = TLV.game.errands.bind(S, 6);
  assert.ok(e, 'bound');
  assert.equal(e.defId, g._g.plan[6]);
  assert.ok(e._doorRoute.len > 0);
});

test('a map with nothing to reach ends the day, and never as a win', async (t) => {
  const real = TLV.game.errands.bind;
  t.after(() => { TLV.game.errands.bind = real; });
  const S = sim({ seed: 9 });
  S.game.clock = 500;
  toDrive(S);
  TLV.game.errands.bind = () => null;
  nextErrand(S, { quality: 'GOOD' });
  assert.equal(S.game.phase, 'RUN_END');
  assert.notEqual(S.game.endReason, 'WIN');
  assert.ok(TLV.registry.problems().some((p) => p.type === 'errand' && /no door or stall/.test(p.reason)));
});
