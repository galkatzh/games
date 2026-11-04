// tests/core/math.test.mjs — WP-CORE
import assert from 'node:assert';
import { test } from 'node:test';
import { coreTLV } from './helpers.mjs';

const { math } = coreTLV();
const PI = Math.PI;

function near(actual, expected, eps = 1e-9) {
  assert.ok(Math.abs(actual - expected) <= eps, `${actual} is not within ${eps} of ${expected}`);
}

test('scalars', () => {
  assert.strictEqual(math.clamp(5, 0, 3), 3);
  assert.strictEqual(math.clamp(-1, 0, 3), 0);
  assert.strictEqual(math.lerp(2, 4, 0.5), 3);
  assert.strictEqual(math.invLerp(2, 4, 3), 0.5);
  assert.strictEqual(math.invLerp(2, 2, 3), 0);
  assert.strictEqual(math.smoothstep(0, 1, -1), 0);
  assert.strictEqual(math.smoothstep(0, 1, 2), 1);
  assert.strictEqual(math.smoothstep(0, 1, 0.5), 0.5);
  assert.strictEqual(math.sign(-3), -1);
  assert.strictEqual(math.sign(3), 1);
  assert.strictEqual(math.sign(0), 0);
  assert.strictEqual(math.dist(0, 0, 3, 4), 5);
  assert.strictEqual(math.dist2(0, 0, 3, 4), 25);
});

test('wrapPi stays in (-pi, pi], with pi included and -pi excluded', () => {
  assert.strictEqual(math.wrapPi(PI), PI);
  assert.strictEqual(math.wrapPi(-PI), PI);
  assert.strictEqual(math.wrapPi(0), 0);
  near(math.wrapPi(3 * PI), PI);
  near(math.wrapPi(-3 * PI), PI);
  near(math.wrapPi(PI + 0.5), -PI + 0.5);
  near(math.wrapPi(-PI - 0.5), PI - 0.5);
  for (let i = 0; i < 2000; i++) {
    const a = (i - 1000) * 0.137;
    const w = math.wrapPi(a);
    assert.ok(w > -PI && w <= PI, `wrapPi(${a}) = ${w}`);
    near(Math.cos(w), Math.cos(a), 1e-6);
    near(Math.sin(w), Math.sin(a), 1e-6);
  }
  near(math.angDiff(0.1, -0.1), 0.2);
  near(math.angDiff(PI - 0.1, -PI + 0.1), -0.2);
});

test('polyline length and cum', () => {
  const px = [0, 3, 3];
  const py = [0, 4, 10];
  assert.strictEqual(math.polyLen(px, py), 11);
  const cum = math.cumLen(px, py);
  assert.ok(cum instanceof Float32Array);
  assert.deepStrictEqual(cum, new Float32Array([0, 5, 11]));
});

test('polyAt evaluates, clamps and gives segment heading', () => {
  const px = [0, 10, 10];
  const py = [0, 0, 10];
  const cum = math.cumLen(px, py);
  const out = { x: 0, y: 0, h: 0 };
  assert.strictEqual(math.polyAt(px, py, cum, 5, out), out);
  assert.deepStrictEqual(out, { x: 5, y: 0, h: 0 });
  math.polyAt(px, py, cum, 15, out);
  assert.deepStrictEqual(out, { x: 10, y: 5, h: PI / 2 });
  assert.deepStrictEqual(math.polyAt(px, py, cum, -3), { x: 0, y: 0, h: 0 });
  assert.deepStrictEqual(math.polyAt(px, py, cum, 99), { x: 10, y: 10, h: PI / 2 });
});

test('polyAt survives zero-length segments and tiny polylines', () => {
  const px = [0, 10, 10, 20];
  const py = [0, 0, 0, 0];
  const cum = math.cumLen(px, py);
  assert.deepStrictEqual(math.polyAt(px, py, cum, 10), { x: 10, y: 0, h: 0 });
  const degenerate = [5, 5];
  assert.deepStrictEqual(math.polyAt(degenerate, degenerate, new Float32Array(2), 1), { x: 5, y: 5, h: 0 });
  assert.deepStrictEqual(math.polyAt([7], [8], new Float32Array(1), 1), { x: 7, y: 8, h: 0 });
  assert.deepStrictEqual(math.polyAt([], [], new Float32Array(0), 1), { x: 0, y: 0, h: 0 });
});

test('polyProject gives s, distance and side, positive on the left of travel', () => {
  const px = [0, 100];
  const py = [0, 0];
  const cum = math.cumLen(px, py);
  assert.deepStrictEqual(math.polyProject(px, py, cum, 40, 3, null), { s: 40, d: 3, side: 1 });
  assert.deepStrictEqual(math.polyProject(px, py, cum, 40, -3, null), { s: 40, d: 3, side: -1 });
  assert.deepStrictEqual(math.polyProject(px, py, cum, 40, 0, null), { s: 40, d: 0, side: 0 });
  assert.deepStrictEqual(math.polyProject(px, py, cum, -5, 0, null), { s: 0, d: 5, side: 0 });
  const out = { s: 0, d: 0, side: 0 };
  assert.strictEqual(math.polyProject(px, py, cum, 200, 0, null, out), out);
  assert.strictEqual(out.s, 100);
  assert.strictEqual(out.d, 100);
});

test('polyProject with a hint tracks the right pass of a route that doubles back', () => {
  // Out along y = 0 for 500 m, a 4 m hairpin, and back along y = 4.
  const px = [0, 500, 500, 0];
  const py = [0, 0, 4, 4];
  const cum = math.cumLen(px, py);
  // Nearer the return pass, but the car is on the way out.
  const point = [100, 2.5];
  assert.ok(math.polyProject(px, py, cum, point[0], point[1], null).s > 500, 'without a hint the return pass wins');
  assert.strictEqual(math.polyProject(px, py, cum, point[0], point[1], 90).s, 100);
  assert.ok(math.polyProject(px, py, cum, point[0], point[1], 908).s > 900);
});

test('polyProject falls back to a full scan when the hint is stale', () => {
  const px = [0, 1000];
  const py = [0, 0];
  const cum = math.cumLen(px, py);
  assert.strictEqual(math.polyProject(px, py, cum, 800, 1, 10).s, 800);
  // -1 means no hint, like every other ID-style argument.
  assert.strictEqual(math.polyProject(px, py, cum, 800, 1, -1).s, 800);
});

test('polyProject does not allocate its result when given out', () => {
  const px = [0, 10, 20];
  const py = [0, 0, 0];
  const cum = math.cumLen(px, py);
  const out = { s: 0, d: 0, side: 0 };
  for (let i = 0; i < 3; i++) assert.strictEqual(math.polyProject(px, py, cum, i, 1, 0, out), out);
});

test('segSegHit', () => {
  assert.strictEqual(math.segSegHit(0, 0, 10, 10, 0, 10, 10, 0), true, 'crossing');
  assert.strictEqual(math.segSegHit(0, 0, 10, 0, 0, 1, 10, 1), false, 'parallel');
  assert.strictEqual(math.segSegHit(0, 0, 10, 0, 11, -1, 11, 1), false, 'short of it');
  assert.strictEqual(math.segSegHit(0, 0, 10, 0, 10, 0, 20, 5), true, 'shared endpoint');
  assert.strictEqual(math.segSegHit(0, 0, 10, 0, 5, 0, 5, 5), true, 'T junction');
  assert.strictEqual(math.segSegHit(0, 0, 10, 0, 5, 0, 15, 0), true, 'collinear overlap');
  assert.strictEqual(math.segSegHit(0, 0, 10, 0, 11, 0, 15, 0), false, 'collinear apart');
});

test('pointSegDist', () => {
  assert.strictEqual(math.pointSegDist(5, 3, 0, 0, 10, 0), 3);
  assert.strictEqual(math.pointSegDist(-3, 4, 0, 0, 10, 0), 5);
  assert.strictEqual(math.pointSegDist(13, 4, 0, 0, 10, 0), 5);
  assert.strictEqual(math.pointSegDist(3, 4, 0, 0, 0, 0), 5);
});

test('pointInPoly takes flat pairs, as the world shapes store them, and nested pairs', () => {
  const square = new Float32Array([0, 0, 10, 0, 10, 10, 0, 10]);
  assert.strictEqual(math.pointInPoly(5, 5, square), true);
  assert.strictEqual(math.pointInPoly(15, 5, square), false);
  assert.strictEqual(math.pointInPoly(-1, 5, square), false);
  const nested = [[0, 0], [10, 0], [10, 10], [0, 10]];
  assert.strictEqual(math.pointInPoly(5, 5, nested), true);
  assert.strictEqual(math.pointInPoly(15, 5, nested), false);
  const concave = [0, 0, 10, 0, 10, 10, 5, 2, 0, 10];
  assert.strictEqual(math.pointInPoly(5, 8, concave), false);
  assert.strictEqual(math.pointInPoly(1, 2, concave), true);
  assert.strictEqual(math.pointInPoly(0, 0, []), false);
  assert.strictEqual(math.pointInPoly(0, 0, null), false);
});

const box = (x, y, h = 0, length = 4, width = 2) => ({ x, y, h, length, width });

test('obbOverlap on axis-aligned, rotated and diagonal boxes', () => {
  assert.strictEqual(math.obbOverlap(box(0, 0), box(3.9, 0)), true);
  assert.strictEqual(math.obbOverlap(box(0, 0), box(4.1, 0)), false);
  assert.strictEqual(math.obbOverlap(box(0, 0), box(0, 1.9)), true);
  assert.strictEqual(math.obbOverlap(box(0, 0), box(0, 2.1)), false);
  // A box turned 90 deg is 2 long and 4 wide.
  assert.strictEqual(math.obbOverlap(box(0, 0), box(2.9, 0, PI / 2)), true);
  assert.strictEqual(math.obbOverlap(box(0, 0), box(3.1, 0, PI / 2)), false);
  // Corner sits in the gap that a box-aligned-to-world test would call a hit.
  assert.strictEqual(math.obbOverlap(box(0, 0, PI / 4), box(3.2, 3.2, PI / 4)), false);
  assert.strictEqual(math.obbOverlap(box(0, 0, PI / 4), box(2, 2, PI / 4)), true);
});

test('obbGap is exact, face to face and corner to corner', () => {
  near(math.obbGap(box(0, 0), box(6, 0)), 2);
  near(math.obbGap(box(0, 0), box(0, 3)), 1);
  // Corners (2, 1) and (5, 5): the 3-4-5 triangle. An axis-only estimate would say 4.
  near(math.obbGap(box(0, 0), box(7, 6)), 5);
  near(math.obbGap(box(0, 0), box(3, 0)), -1);
  near(math.obbGap(box(0, 0), box(0, 0.5)), -1.5);
  assert.ok(math.obbGap(box(0, 0), box(0, 0)) <= 0);
  near(math.obbGap(box(0, 0), box(4, 0)), 0);
  const a = box(1, 2, 0.7);
  const b = box(5, 7, 1.9);
  near(math.obbGap(a, b), math.obbGap(b, a));
});

test('obbGap on a rotated corner against a face', () => {
  // Diamond of half-diagonal 2 * sqrt(2), centred 5 from the face at x = 2: tip at x = 5 - 2.828.
  near(math.obbGap(box(0, 0), box(5, 0, PI / 4, 4, 4)), 3 - 2 * Math.SQRT2, 1e-9);
});

test('obbSat gives a normal from a to b, the least penetration and a contact on the overlap', () => {
  const out = { nx: 0, ny: 0, depth: 0, cx: 0, cy: 0 };
  assert.strictEqual(math.obbSat(box(0, 0), box(3, 0), out), true);
  near(out.nx, 1);
  near(out.ny, 0);
  near(out.depth, 1);
  near(out.cx, 1.5);
  near(out.cy, 0);

  assert.strictEqual(math.obbSat(box(0, 0), box(-3, 0), out), true);
  near(out.nx, -1);
  near(out.cx, -1.5);

  assert.strictEqual(math.obbSat(box(0, 0), box(0, 1.5), out), true);
  near(out.ny, 1);
  near(out.depth, 0.5);

  assert.strictEqual(math.obbSat(box(3, 0), box(0, 0), out), true);
  near(out.nx, -1);
  near(out.cx, 1.5);
});

test('obbSat separates the boxes when applied, and stays silent when apart', () => {
  const out = { nx: 0, ny: 0, depth: 0, cx: 0, cy: 0 };
  const a = box(0, 0, 0.3);
  const b = box(2, 1.2, 1.1);
  assert.strictEqual(math.obbSat(a, b, out), true);
  near(Math.hypot(out.nx, out.ny), 1);
  const moved = { ...b, x: b.x + out.nx * (out.depth + 1e-6), y: b.y + out.ny * (out.depth + 1e-6) };
  assert.strictEqual(math.obbOverlap(a, moved), false);
  assert.ok(math.pointInPoly(out.cx, out.cy, cornerPoly(a)) || math.pointInPoly(out.cx, out.cy, cornerPoly(b)));

  const before = { ...out };
  assert.strictEqual(math.obbSat(box(0, 0), box(50, 0), out), false);
  assert.deepStrictEqual(out, before);
});

test('obbSat agrees with obbOverlap and obbGap on random boxes', () => {
  const out = { nx: 0, ny: 0, depth: 0, cx: 0, cy: 0 };
  let hits = 0;
  for (let i = 0; i < 4000; i++) {
    const a = box(rand(i, 1) * 8 - 4, rand(i, 2) * 8 - 4, rand(i, 3) * 6.3, 2 + rand(i, 4) * 6, 1 + rand(i, 5) * 2);
    const b = box(rand(i, 6) * 8 - 4, rand(i, 7) * 8 - 4, rand(i, 8) * 6.3, 2 + rand(i, 9) * 6, 1 + rand(i, 10) * 2);
    const hit = math.obbSat(a, b, out);
    assert.strictEqual(hit, math.obbOverlap(a, b));
    assert.strictEqual(hit, math.obbGap(a, b) <= 0);
    if (hit) {
      hits++;
      near(out.depth, -math.obbGap(a, b));
      assert.ok((b.x - a.x) * out.nx + (b.y - a.y) * out.ny >= 0, 'normal points from a to b');
    }
  }
  assert.ok(hits > 500, `only ${hits} overlaps in the sample`);
});

/** Corners of a box as a flat polygon. */
function cornerPoly(b) {
  const c = Math.cos(b.h);
  const s = Math.sin(b.h);
  const l = b.length / 2 + 1e-9;
  const w = b.width / 2 + 1e-9;
  return [[-l, -w], [l, -w], [l, w], [-l, w]].flatMap(([u, v]) => [b.x + u * c - v * s, b.y + u * s + v * c]);
}

/** Repeatable pseudo-random numbers for the property tests. */
function rand(i, k) {
  const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453;
  return x - Math.floor(x);
}
