// tests/world/build.test.mjs — WP-WORLD: the World as a whole (ARCHITECTURE 8, 10.6, 12.3, section 19 item 1).
import assert from 'node:assert';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { createTLV, createSim } from '../../tools/lib/classic.mjs';
import { miniTLV, realTLV, craftMap, straightRoad, simOn, perfOnly } from './helpers.mjs';

const BUDGET_SCRIPT = `
  import { createTLV } from ${JSON.stringify(new URL('../../tools/lib/classic.mjs', import.meta.url).href)};
  const TLV = createTLV({ files: ['sim'], map: 'tlv_center' });
  const payload = TLV.world.map.payload('tlv_center');
  const t0 = performance.now();
  const W = TLV.world.build(payload);
  console.log(JSON.stringify({ ms: performance.now() - t0, lanes: W.lanes.length }));
`;

test('section 19.1: a cold build of tlv_center is within budget, by the median of fresh processes', perfOnly, () => {
  // One fresh process can get lucky, so a batch answers by its median, which needs most of the batch inside the budget.
  // This asks what the code costs, and sibling test files may be loading the machine, so a batch over budget waits for them
  // to finish and tries again, a few times. Every median is in the failure message.
  const BATCH = 5;
  const TRIES = 4;
  const medians = [];
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (let t = 0; t < TRIES; t++) {
    const runs = [];
    for (let i = 0; i < BATCH; i++) {
      const r = spawnSync(process.execPath, ['--input-type=module', '-e', BUDGET_SCRIPT], { encoding: 'utf8' });
      assert.strictEqual(r.status, 0, r.stderr);
      runs.push(JSON.parse(r.stdout.trim()).ms);
    }
    runs.sort((a, b) => a - b);
    medians.push(runs[BATCH >> 1]);
    if (medians[t] <= 400) return;
    if (t + 1 < TRIES) Atomics.wait(nap, 0, 0, 15000);
  }
  assert.fail(`median cold builds ${medians.map((x) => x.toFixed(0))} ms, budget 400`);
});

test('section 19.1: builds on mini and tlv_center give the scale the contract expects', () => {
  const m = miniTLV();
  const M = m.world.get('mini');
  assert.strictEqual(M.id, 'mini');
  assert.deepStrictEqual(M.bounds, { minX: -400, minY: -400, maxX: 400, maxY: 400 });
  assert.strictEqual(M.juncs.length, 9);
  assert.strictEqual(M.ctrls.length, 1);
  const TLV = realTLV();
  const R = TLV.world.get('tlv_center');
  assert.strictEqual(R.id, 'tlv_center');
  assert.ok(R.dirEdges.filter(Boolean).length > 5000);
  assert.ok(R.lanes.length > 7000);
  assert.ok(R.conns.length > 9000);
  assert.ok(R.ctrls.length >= 400);
  assert.ok(R.xings.length > 1500 && R.stops.length > 400 && R.blds.length >= 14000);
});

test('W.index keeps the keys it was loaded with: a key added midway through the build costs every reader its optimized code', () => {
  const TLV = realTLV();
  const payload = TLV.world.map.payload('tlv_center');
  const loaded = Object.keys(TLV.world.map._load(payload).index);
  const W = TLV.world.build(payload);
  assert.deepStrictEqual(Object.keys(W.index), loaded);
  simOn(TLV, W, 1);
  TLV.world.parking.spotsNear(W, 0, 0, 80, []);
  TLV.world.spatial._inJunction(W, 0, 0);
  assert.deepStrictEqual(Object.keys(W.index), loaded, 'and the queries that fill theirs lazily');
});

test('world.get caches per map, and returns null for an unknown map', () => {
  const m = miniTLV();
  assert.strictEqual(m.world.get('mini'), m.world.get('mini'));
  assert.strictEqual(m.world.get('nope'), null);
  assert.strictEqual(m.world.get('constructor'), null);
  assert.strictEqual(m.world.map.payload('toString'), null);
});

test('createTLV registers the handler, and the full sim path reaches a world', () => {
  const TLV = createTLV({ files: ['sim'], map: 'tests/fixtures/mini_map.js' });
  assert.ok(TLV.world.map.payload('mini'));
  assert.strictEqual(TLV.q.filter((i) => i[0] === 'map').length, 0);
});

test('World shape: decoded units, strings and ids (ARCHITECTURE 10.6)', () => {
  const m = miniTLV();
  const W = m.world.get('mini');
  const e = W.edges[0];
  assert.ok(e.px instanceof Float32Array && e.py instanceof Float32Array && e.cum instanceof Float32Array);
  assert.strictEqual(e.len, 200);
  assert.strictEqual(e.laneW, 3);
  assert.strictEqual(e.parkL, 2.4);
  assert.strictEqual(e.swR, 2.5);
  assert.ok(typeof e.name === 'string' && typeof e.nameEn === 'string');
  const p = W.pois.find((x) => x.kind === 'pharmacy');
  assert.ok(p.bld >= 0 && p.wall >= 0 && p.edge >= 0);
  assert.strictEqual(p.w, 6);
  assert.ok(Math.abs(p.t - 0.5) < 0.01);
  const b = W.blds[0];
  assert.strictEqual(b.h, 15);
  assert.ok(b.rings[0] instanceof Float32Array);
  assert.strictEqual(b.rings[0].length, 8);
  assert.ok(b.front instanceof Uint8Array);
  assert.strictEqual(b.front.length, 4);
  assert.strictEqual(b.maxX - b.minX, 40);
  assert.ok(Math.abs(b.cx - (b.minX + 20)) < 1e-4);
  const k = W.kerbs.find((x) => x.tier === 2);
  assert.strictEqual(k.s0, 12);
  assert.ok(typeof k.zone === 'string');
  const x = W.xings[0];
  assert.strictEqual(x.s, 100);
  assert.strictEqual(typeof x.signal, 'boolean');
  assert.strictEqual(W.stops[0].s, 100);
  // Kerb offsets by the rule in 6.3.
  const one = W.edges.find((q) => q.lanesB === 0);
  assert.strictEqual(one.kerbOffR, 2 * 3 / 2 + 2.4);
  const two = W.edges.find((q) => q.lanesB === 1);
  assert.strictEqual(two.kerbOffR, 1 * 3 + 2.4);
  assert.strictEqual(two.kerbOffL, 1 * 3 + 2.4);
  assert.strictEqual(W.juncs.find((j) => j.x === 0 && j.y === 0).kind, 'SIGNAL');
  assert.strictEqual(W.juncs.find((j) => j.x === 200 && j.y === 200).kind, 'RING');
});

test('every table on the real map carries contract ids and finite geometry', () => {
  const TLV = realTLV();
  const W = TLV.world.get('tlv_center');
  for (const name of ['juncs', 'edges', 'lanes', 'conns', 'ctrls', 'zones', 'xings', 'stops', 'blds', 'pois', 'kerbs', 'lots', 'land', 'paths', 'walls', 'sidewalks', 'props']) {
    assert.ok(Array.isArray(W[name]), name);
    W[name].forEach((row, i) => assert.strictEqual(row.id, i, `${name} ${i}`));
  }
  for (const p of W.pois) {
    assert.ok(p.edge < W.edges.length && p.bld < W.blds.length);
    assert.ok(p.t >= 0 && p.t <= 1);
  }
  for (const b of W.blds) assert.ok(b.minX <= b.maxX && Number.isFinite(b.cx + b.cy));
  assert.ok(W.meta.attribution.includes('OpenStreetMap'));
  assert.ok(W.strings[0] === '');
});

test('the build is deterministic: two builds give the same geometry', () => {
  const a = realTLV();
  const b = realTLV();
  const A = a.world.get('tlv_center');
  const B = b.world.get('tlv_center');
  assert.deepStrictEqual(A.lanes.map((l) => l.len), B.lanes.map((l) => l.len));
  assert.deepStrictEqual(A.conns.map((c) => c.vmax), B.conns.map((c) => c.vmax));
  assert.deepStrictEqual(A.conns.map((c) => Array.from(c.conflicts)), B.conns.map((c) => Array.from(c.conflicts)));
  assert.deepStrictEqual(A.ctrls.map((c) => c.offset), B.ctrls.map((c) => c.offset));
  assert.deepStrictEqual(A.sidewalks.map((s) => s.len), B.sidewalks.map((s) => s.len));
  assert.deepStrictEqual(A.sidewalks.map((s) => s.links), B.sidewalks.map((s) => s.links));
  assert.deepStrictEqual(A.xings.map((x) => [x.swA, x.swB]), B.xings.map((x) => [x.swA, x.swB]));
  assert.deepStrictEqual(A.props, B.props);
});

test('a schema major mismatch is a hard error that names the re-import command', () => {
  const m = miniTLV();
  const payload = craftMap({ schema: [2, 0], id: 'future' });
  assert.throws(() => m.world.build(payload), /node tools\/import\.mjs future/);
});

test('a minor bump is read: unknown columns are ignored, and a missing column reads as 0', () => {
  const m = miniTLV();
  const payload = straightRoad();
  payload.schema = [1, 7];
  payload.tables.edges.cols.future = ['raw', [9]];
  payload.tables.newTable = { n: 1, cols: { a: ['raw', [1]] } };
  delete payload.tables.edges.cols.swL;
  delete payload.tables.lots;
  delete payload.tables.lotPts;
  const W = m.world.build(payload);
  assert.strictEqual(W.edges[0].swL, 0);
  assert.strictEqual(W.lots.length, 0);
  assert.ok(W.lanes.length === 2);
});

test('a map with no roads builds, and every query copes', () => {
  const m = miniTLV();
  const W = m.world.build(craftMap({ id: 'empty', land: [{ cls: 0, poly: [[-500, -500], [500, -500], [500, 500], [-500, 500]] }] }));
  assert.strictEqual(W.lanes.length, 0);
  const S = simOn(m, W);
  const w = m.world;
  assert.strictEqual(w.lanes.project(W, 0, 0, null, 50, {}), null);
  assert.strictEqual(w.lanes.lanesNear(W, 0, 0, 50, new Int32Array(8)), 0);
  assert.strictEqual(w.surface.at(W, 0, 0), m.const.SURF.WATER);
  assert.strictEqual(w.sidewalks.nearest(W, 0, 0, {}), null);
  assert.strictEqual(w.parking.spotsNear(W, 0, 0, 50, []), 0);
  assert.strictEqual(w.parking.kerbAt(W, 0, 0, 5, {}), null);
  assert.strictEqual(w.routing.route(W, 0, 0, 0, 0, 0, {}), null);
  assert.strictEqual(w.spatial.pointInBuilding(W, 0, 0), -1);
  assert.strictEqual(w.spatial.rayBlocked(W, 0, 0, 10, 10), false);
  m.sim.step(S);
  assert.strictEqual(S.sig.slot.length, 0);
});

test('a map of lanes with no AI flag builds and answers', () => {
  const m = miniTLV();
  const W = m.world.build(straightRoad({ flags: 0 }));
  assert.strictEqual(W.lanes[0].flags & m.const.LF.AI_ROUTABLE, 0);
  assert.strictEqual(m.world.routing.route(W, 0, 0, 0, 0, 10, { ai: true }), null);
  assert.ok(m.world.routing.route(W, 0, -1.5, 0, 0, 150, {}));
});

test('a move that joins roads that do not meet is skipped and reported', () => {
  const m = miniTLV();
  const before = m.registry.problems().length;
  const W = m.world.build(craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }, { x: 0, y: 100, kind: 1 }],
    edges: [{ a: 0, b: 1, lanesB: 0 }, { a: 2, b: 3, lanesB: 0 }],
    moves: [[0, 2, 0]]
  }));
  assert.strictEqual(W.conns.length, 0);
  assert.strictEqual(m.registry.problems().length, before + 1);
});

test('onMap rejects a bad payload without throwing', () => {
  const m = miniTLV();
  m.world.map.onMap(null);
  m.world.map.onMap({ id: 'x' });
  assert.ok(m.registry.problems().length >= 2);
  assert.strictEqual(m.world.map.payload('x'), null);
});

test('sim step runs on the real world with only WORLD and CORE present', () => {
  const TLV = realTLV();
  const S = simOn(TLV, TLV.world.get('tlv_center'), 3);
  for (let i = 0; i < 120; i++) TLV.sim.step(S);
  assert.strictEqual(S.tick, 120);
  assert.deepStrictEqual(TLV.invariants.run(S).filter((f) => f.startsWith('world.')), []);
});

test('a TLV with no map makes a sim that steps, as a package testing alone needs (ARCHITECTURE 5)', () => {
  const TLV = createTLV({ files: ['sim'] });
  const S = createSim(TLV, { allowMissing: true, seed: 1 });
  assert.strictEqual(S.world, null);
  assert.ok(S.parking.overrides instanceof Map);
  for (let i = 0; i < 5; i++) TLV.sim.step(S);
  assert.strictEqual(S.tick, 5);
  assert.strictEqual(S.sig.state.length, 0);
});

test('the debug hook is registered', () => {
  const TLV = miniTLV();
  assert.strictEqual(typeof TLV.debug.forceSignal, 'function');
});

test('an edge with no length gets no lanes and breaks nothing', () => {
  const m = miniTLV();
  const W = m.world.build(craftMap({
    juncs: [{ x: 0, y: 0, kind: 1 }, { x: 0, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, pts: [[0, 0], [0, 0]] }, { a: 1, b: 2 }]
  }));
  assert.strictEqual(W.dirEdges[0], null);
  assert.strictEqual(W.dirEdges[1], null);
  assert.ok(W.dirEdges[2]);
});

test('anchors resolve against a real World, as content will', () => {
  const TLV = realTLV();
  const W = TLV.world.get('tlv_center');
  const resolve = (a, type) => TLV.anchors.resolve(W, a, { type });
  const spawn = resolve({ osm: 'w154735772', at: [32.0759, 34.7766], name: 'המלך ג׳ורג׳' }, 'edge');
  assert.strictEqual(spawn.how, 'exact');
  const e = W.edges[spawn.id];
  assert.ok(Math.abs(e.len - 182.9) < 1);
  const j = W.juncs[e.b];
  assert.strictEqual(j.kind, 'SIGNAL');
  assert.ok(Math.hypot(j.x - -61.7, j.y - 138.8) < 2);
  const milk = resolve({ osm: 'n11238493213', at: [32.0749, 34.7820], name: 'Carrefour' }, 'poi');
  assert.strictEqual(milk.how, 'exact');
  const tower = resolve({ osm: 'w90723265', at: [32.074, 34.792] }, 'building');
  assert.strictEqual(tower.how, 'exact');
  assert.ok(W.blds[tower.id].h > 100);
  assert.ok(resolve({ osm: 'r15311025' }, 'building').ids.length >= 2);
  assert.strictEqual(resolve({ osm: 'w1' }, 'edge').how, 'orphan');
});

test('the first minute: spawn lane, its light, and the drive to the pinned door', () => {
  const TLV = realTLV();
  const W = TLV.world.get('tlv_center');
  const e = TLV.anchors.resolve(W, { osm: 'w154735772' }, { type: 'edge' }).id;
  const d = W.dirEdges[e * 2];
  assert.ok(d, 'one-way in digitized direction');
  assert.strictEqual(d.lanes.length, 1);
  const lane = W.lanes[d.lanes[0]];
  // 40 m back from the stop line, per ARCHITECTURE 14.6.
  const s = lane.len - 40;
  assert.ok(s > 0);
  const conns = TLV.world.lanes.nextConns(W, lane.id);
  assert.ok(conns.length >= 1);
  assert.ok(W.conns[conns[0]].slot >= 0, 'the light governs the spawn lane');
  const S = simOn(TLV, W, 1);
  TLV.world.signals.alignGreen(S, conns[0], 3);
  assert.notStrictEqual(TLV.world.signals.connState(S, conns[0]), TLV.const.SIG.GREEN);
  assert.strictEqual(TLV.world.signals.stateAt(S, conns[0], S.t + 3), TLV.const.SIG.GREEN);
  // The right turn onto HaNeviim exists, and the door route is about 575 m (GAME_DESIGN 6), measured at node level there.
  const right = Array.from(conns).filter((c) => W.conns[c].turn === 'R');
  assert.ok(right.length >= 1, 'a right turn at the junction');
  const poi = W.pois[TLV.anchors.resolve(W, { osm: 'n11238493213' }, { type: 'poi' }).id];
  const buf = new Int32Array(64);
  const n = TLV.world.lanes.lanesNear(W, poi.entX, poi.entY, 40, buf);
  let best = null;
  for (let i = 0; i < n; i++) {
    const l = W.lanes[buf[i]];
    const q = TLV.math.polyProject(l.px, l.py, l.cum, poi.entX, poi.entY, -1, {});
    const route = TLV.world.routing.routeLanes(W, lane.id, s, l.id, q.s, { ai: true });
    if (route && (!best || route.len < best.len)) best = route;
  }
  assert.ok(best, 'a route to the door');
  assert.ok(best.len > 520 && best.len < 620, `route ${best.len} m`);
  const names = Array.from(best.dirEdges, (d) => W.edges[d >> 1].nameEn);
  assert.ok(names.includes('HaNeviim Avenue') && names.includes('Ibn Gabirol'), names.join(', '));
  const lights = Array.from(best.dirEdges).filter((d) => W.juncs[W.dirEdges[d].to].kind === 'SIGNAL').length;
  assert.strictEqual(lights, 3, 'the first light, then two further signalled junctions');
});
