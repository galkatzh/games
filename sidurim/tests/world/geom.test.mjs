// tests/world/geom.test.mjs — WP-WORLD: offset and Bezier construction (ARCHITECTURE 12.3).
import assert from 'node:assert';
import { test } from 'node:test';
import { miniTLV, sampler } from './helpers.mjs';

const TLV = miniTLV();
const geom = TLV.world.geom;

test('offsetPolyline: right of direction is +, a straight line keeps its shape', () => {
  const r = geom.offsetPolyline([0, 10, 20], [0, 0, 0], 2);
  assert.deepStrictEqual(r.px, [0, 10, 20]);
  assert.deepStrictEqual(r.py, [-2, -2, -2]);
  const l = geom.offsetPolyline([0, 0], [0, 10], -3);
  assert.ok(Math.abs(l.px[0] - -3) < 1e-9, 'heading north, negative is west');
});

test('offsetPolyline: a mitred corner keeps the offset from both legs', () => {
  const r = geom.offsetPolyline([0, 10, 10], [0, 0, -10], -2);
  // Left of a right turn is the outside: the corner goes to (12, 2).
  assert.ok(Math.abs(r.px[1] - 12) < 1e-9 && Math.abs(r.py[1] - 2) < 1e-9, `${r.px[1]}, ${r.py[1]}`);
  const inside = geom.offsetPolyline([0, 10, 10], [0, 0, -10], 2);
  assert.ok(Math.abs(inside.px[1] - 8) < 1e-9 && Math.abs(inside.py[1] - -2) < 1e-9);
});

test('offsetPolyline: a repeated vertex is one vertex, and a sharp spike stays near its offset', () => {
  const r = geom.offsetPolyline([0, 10, 10, 20], [0, 0, 0, 0], 1);
  assert.strictEqual(r.px.length, 3);
  const spike = geom.offsetPolyline([0, 20, 0.5], [0, 0, 1], -3);
  for (let i = 0; i < spike.px.length; i++) assert.ok(Number.isFinite(spike.px[i]) && spike.px[i] < 27, 'a mitre is limited');
});

test('offsetPolyline: a short span on the inside of a bend leaves no backward step', () => {
  // A 90 degree bend cut by a 1 m chamfer: offset 3 m to the inside, the chamfer turns around.
  const px = [0, 20, 20.7, 20.7];
  const py = [0, 0, -0.7, -20];
  const r = geom.offsetPolyline(px, py, 3);
  for (let i = 0; i + 1 < r.px.length; i++) {
    const dx = r.px[i + 1] - r.px[i];
    const dy = r.py[i + 1] - r.py[i];
    // The road runs east, then south. Nothing here may run north-west, back along it.
    assert.ok(!(dx < 0 && dy > 0), `span ${i}: ${dx}, ${dy}`);
  }
  assert.ok(Math.abs(r.px[0]) < 1e-9 && Math.abs(r.py[0] - -3) < 1e-9, 'the first end stays');
  const last = r.px.length - 1;
  assert.ok(Math.abs(r.px[last] - 17.7) < 1e-9 && Math.abs(r.py[last] - -20) < 1e-9, 'the last end stays');
});

test('bezierPoly: exact ends, even spacing, and either point form', () => {
  const a = geom.bezierPoly({ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 5 }, { x: 10, y: 10 }, 1.5);
  const b = geom.bezierPoly([0, 0], [5, 0], [10, 5], [10, 10], 1.5);
  assert.deepStrictEqual(a, b);
  const n = a.px.length - 1;
  assert.strictEqual(a.px[0], 0);
  assert.strictEqual(a.py[n], 10);
  let most = 0;
  let least = Infinity;
  for (let i = 0; i < n; i++) {
    const d = Math.hypot(a.px[i + 1] - a.px[i], a.py[i + 1] - a.py[i]);
    most = Math.max(most, d);
    least = Math.min(least, d);
  }
  assert.ok(most <= 1.5 && most - least < 0.1, `${least} to ${most}`);
  assert.strictEqual(geom.bezierPoly([0, 0], [0, 0], [0, 0], [0, 0], 1.5).px.length, 3, 'degenerate is finite');
});

const box = (x, y, h, hl, hw) => geom._setBox({}, x, y, h, hl, hw);

test('_segBoxDist by hand: apart, across, inside, past a corner, and turned', () => {
  const b = box(0, 0, 0, 2, 1);
  assert.strictEqual(geom._segBoxDist(5, 0, 5, 3, b), 3);
  assert.strictEqual(geom._segBoxDist(5, 0, 6, 0, b), 3, 'in line with the box, past its end');
  assert.strictEqual(geom._segBoxDist(0, 3, 0, 4, b), 2, 'in line the other way');
  assert.strictEqual(geom._segBoxDist(-9, 0, 9, 0.5, b), 0, 'through it');
  assert.strictEqual(geom._segBoxDist(-1, 0, 1, 0, b), 0, 'wholly inside');
  assert.strictEqual(geom._segBoxDist(0, 0, 9, 9, b), 0, 'one end inside');
  assert.ok(Math.abs(geom._segBoxDist(5, 5, 6, 5, b) - 5) < 1e-12, 'nearest at the corner (2, 1)');
  // The line x + y = 3.5 misses the corner (2, 1) by 0.5 / sqrt 2, and neither end of it is near the box.
  assert.ok(Math.abs(geom._segBoxDist(4.5, -1, -1, 4.5, b) - 0.5 / Math.SQRT2) < 1e-12);
  // The same box heading north spans y to 2 and x to 1.
  const north = box(0, 0, Math.PI / 2, 2, 1);
  assert.ok(Math.abs(geom._segBoxDist(-1, 3, 1, 3, north) - 1) < 1e-12);
  assert.ok(Math.abs(geom._segBoxDist(2, -1, 2, 1, north) - 1) < 1e-12);
  assert.strictEqual(geom._segBoxDist(3, 0, 3, 0, box(3, 0, 1, 2, 1)), 0, 'a segment of no length at its centre');
});

test('_segBoxDist agrees with dense sampling on random cases', () => {
  const rnd = sampler(61);
  const r = (a) => (rnd() - 0.5) * 2 * a;
  for (let i = 0; i < 300; i++) {
    const b = box(r(3), r(3), r(3.14), 0.5 + rnd() * 3, 0.5 + rnd() * 2);
    const ax = r(9);
    const ay = r(9);
    const bx = r(9);
    const by = r(9);
    let want = Infinity;
    for (let u = 0; u <= 400; u++) {
      const x = ax + (bx - ax) * u / 400 - b.x;
      const y = ay + (by - ay) * u / 400 - b.y;
      const du = Math.max(Math.abs(x * b.c + y * b.s) - b.hl, 0);
      const dv = Math.max(Math.abs(y * b.c - x * b.s) - b.hw, 0);
      want = Math.min(want, Math.hypot(du, dv));
    }
    const got = geom._segBoxDist(ax, ay, bx, by, b);
    assert.ok(got <= want + 1e-9 && got >= want - 0.05, `case ${i}: ${got} against ${want}`);
  }
});

test('_lineNearBox looks at every span, and reach counts from the box', () => {
  const b = box(0, 0, 0, 2, 1);
  assert.ok(geom._lineNearBox([9, 9, 3], [9, 0, 0], b, 1.5), 'the last span comes within 1 of it');
  assert.ok(!geom._lineNearBox([9, 9, 3], [9, 0, 0], b, 0.5));
  assert.ok(!geom._lineNearBox([-9, 9], [5, 5], b, 3.9));
  assert.ok(geom._lineNearBox([-9, 9], [5, 5], b, 4.1), 'a long span whose ends are both far away');
});

test('_boxesOverlap by hand, and where bounding boxes would say yes', () => {
  const p = box(0, 0, 0, 2, 1);
  assert.ok(geom._boxesOverlap(p, box(3.9, 0, 0, 2, 1)));
  assert.ok(!geom._boxesOverlap(p, box(4.1, 0, 0, 2, 1)));
  assert.ok(!geom._boxesOverlap(p, box(0, 2.1, 0, 2, 1)));
  assert.ok(geom._boxesOverlap(p, box(0, 1.9, Math.PI, 2, 1)), 'heading does not matter end for end');
  // Turned 45 deg off the corner (2, 1): the boxes' bounds overlap, but the axis (1, 1) separates them.
  const q = box(3.2, 2.2, Math.PI / 4, 1, 1);
  assert.ok(!geom._boxesOverlap(p, q));
  assert.ok(!geom._boxesOverlap(q, p));
  assert.ok(geom._boxesOverlap(p, box(2.6, 1.6, Math.PI / 4, 1, 1)));
  assert.ok(geom._boxesOverlap(box(0, 0, 0, 5, 5), box(1, 1, 0.5, 0.5, 0.5)), 'one inside the other');
});

test('_boxesOverlap agrees with sampling on random cases', () => {
  const rnd = sampler(62);
  const r = (a) => (rnd() - 0.5) * 2 * a;
  let met = 0;
  for (let i = 0; i < 400; i++) {
    const p = box(r(2), r(2), r(3.14), 0.5 + rnd() * 2, 0.3 + rnd());
    const q = box(r(2), r(2), r(3.14), 0.5 + rnd() * 2, 0.3 + rnd());
    let hit = false;
    for (let u = -1; u <= 1 && !hit; u += 0.04) {
      for (let v = -1; v <= 1 && !hit; v += 0.04) {
        const x = p.x + p.c * u * p.hl - p.s * v * p.hw - q.x;
        const y = p.y + p.s * u * p.hl + p.c * v * p.hw - q.y;
        hit = Math.abs(x * q.c + y * q.s) <= q.hl && Math.abs(y * q.c - x * q.s) <= q.hw;
      }
    }
    if (hit) {
      met++;
      assert.ok(geom._boxesOverlap(p, q), `case ${i}: sampling found a shared point`);
    }
  }
  assert.ok(met > 100, `met ${met}`);
});

test('_copyLine copies and grows', () => {
  const a = geom._newLine();
  const b = geom._newLine();
  a.x = new Float64Array(9000);
  a.y = new Float64Array(9000);
  a.x[8999] = 5;
  a.n = 9000;
  geom._copyLine(a, b);
  assert.strictEqual(b.n, 9000);
  assert.strictEqual(b.x[8999], 5);
  assert.notStrictEqual(b.x, a.x);
});

test('_pointAlong is polyAt with a unit vector for its heading, zero-length spans and all', () => {
  const px = new Float32Array([0, 10, 10, 10, 0]);
  const py = new Float32Array([0, 0, 0, 5, 5]);
  const cum = new Float32Array([0, 10, 10, 15, 25]);
  const a = {};
  for (let s = -1; s <= 26; s += 0.5) {
    geom._pointAlong(px, py, cum, s, a);
    const b = TLV.math.polyAt(px, py, cum, s, {});
    assert.ok(Math.hypot(a.x - b.x, a.y - b.y) < 1e-6, `at ${s}`);
    assert.ok(Math.abs(a.ux - Math.cos(b.h)) < 1e-6 && Math.abs(a.uy - Math.sin(b.h)) < 1e-6, `heading at ${s}`);
  }
});

test('_pointAlong takes the direction of the nearest real span from a zero-length one, either way', () => {
  const a = {};
  const tail = [new Float32Array([0, 0, 0]), new Float32Array([0, 10, 10]), new Float32Array([0, 10, 10])];
  geom._pointAlong(tail[0], tail[1], tail[2], 10, a);
  assert.deepStrictEqual([a.x, a.y, a.ux, a.uy], [0, 10, 0, 1]);
  const head = [new Float32Array([0, 0, 0]), new Float32Array([0, 0, 10]), new Float32Array([0, 0, 10])];
  geom._pointAlong(head[0], head[1], head[2], 0, a);
  assert.deepStrictEqual([a.x, a.y, a.ux, a.uy], [0, 0, 0, 1]);
});

test('_ids copies a list', () => {
  assert.deepStrictEqual(Array.from(geom._ids([3, 1, 2])), [3, 1, 2]);
  assert.strictEqual(geom._ids([]).length, 0);
});

test('_headingOver reads the line, and its span when the two points coincide', () => {
  const px = new Float32Array([0, 0, 10]);
  const py = new Float32Array([0, 10, 10]);
  const cum = new Float32Array([0, 10, 20]);
  const a = {};
  const b = {};
  assert.ok(Math.abs(geom._headingOver(px, py, cum, 0, 5, a, b) - Math.PI / 2) < 1e-9);
  assert.ok(Math.abs(geom._headingOver(px, py, cum, 12, 18, a, b)) < 1e-9);
  assert.ok(Math.abs(geom._headingOver(px, py, cum, 15, 15, a, b)) < 1e-9, 'one point, on the eastbound span');
  assert.ok(Math.abs(geom._headingOver(px, py, cum, 5, 5, a, b) - Math.PI / 2) < 1e-9, 'one point, on the northbound span');
});
