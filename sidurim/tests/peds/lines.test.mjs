// tests/peds/lines.test.mjs — the walking lines on tlv_center: crossings through their zones, links clear of walls, rows read.
// This is how the zone problem of WP-WORLD D6 and the exit-arm zones are held to the contract: for a car, the zone is the crossing.
import test from 'node:test';
import assert from 'node:assert';
import { loadBare, sim, quiet } from './helpers.mjs';

quiet();
const TLV = loadBare('tlv_center');
const S = sim(TLV);
const W = S.world;
const { peds, math } = TLV;
const cross = peds.cross;
const walk = peds.walk;
const T = TLV.tune.peds;

const paths = W.xings.map((x) => cross.pathOf(S, x.id));

test('every crossing has a line, and a line crosses each of its lanes once', () => {
  for (const x of W.xings) {
    const p = paths[x.id];
    assert.ok(p, `crossing ${x.id}`);
    assert.strictEqual(p.nz, x.zones.length);
    assert.strictEqual(new Set(p.zLane.subarray(0, p.nz)).size, p.nz);
    assert.ok(p.total <= T.pathMaxM, `crossing ${x.id} is ${p.total} m`);
  }
});

test('every conflict point is inside its zone, or just past a stop line with the zone behind it. None is off zone', () => {
  const pr = {};
  let inZone = 0;
  let past = 0;
  for (const x of W.xings) {
    const p = paths[x.id];
    for (let k = 0; k < p.nz; k++) {
      const z = W.zones[p.zZone[k]];
      const lane = W.lanes[z.laneId];
      math.polyProject(lane.px, lane.py, lane.cum, p.zX[k], p.zY[k], -1, pr);
      if (pr.s >= z.s0 - 1e-3 && pr.s <= z.s1 + 1e-3 && pr.d < 0.05) {
        inZone++;
        continue;
      }
      assert.ok(lane.len - z.s1 <= T.stopShiftM + 1e-3, `crossing ${x.id}: zone is not by a stop line`);
      assert.ok(pr.s >= lane.len - 1e-3, `crossing ${x.id}: line is not past the stop line`);
      assert.ok(Math.abs(pr.d - T.lineClearM) < 0.2, `crossing ${x.id}: ${pr.d} m past the stop line`);
      past++;
    }
  }
  assert.ok(inZone > 1500, `${inZone} in zones`);
  assert.ok(past > 1000, `${past} past stop lines`);
  assert.strictEqual(inZone + past, W.zones.length);
});

test('exit arms: no walker stands on the road between a junction and the zone meant to protect them', () => {
  // A zone snapped past the real crossing is exactly the case where walkers on the OSM node would be hit first.
  const at = {};
  const pr = {};
  let snapped = 0;
  for (const x of W.xings) {
    const p = paths[x.id];
    const e = W.edges[x.edge];
    for (let k = 0; k < p.nz; k++) {
      const z = W.zones[p.zZone[k]];
      const lane = W.lanes[z.laneId];
      if (z.s0 > 1e-3) continue;
      TLV.world.lanes.pointAt(W, lane.id, (z.s0 + z.s1) / 2, at);
      math.polyProject(e.px, e.py, e.cum, at.x, at.y, -1, pr);
      if (Math.abs(pr.s - x.s) < 6) continue;
      snapped++;
      math.polyProject(lane.px, lane.py, lane.cum, p.zX[k], p.zY[k], -1, pr);
      // On a lane too short to hold both, the walker stands past its far end. The zone is still between them and any car.
      const inside = pr.s >= z.s0 - 1e-3 && pr.s <= z.s1 + 1e-3;
      assert.ok(inside || pr.s >= lane.len - 1e-3, `crossing ${x.id} walks outside its exit zone`);
    }
  }
  assert.ok(snapped >= 75, `${snapped} exit zones far from their crossing`);
});

test('a line open to ambient walkers stands on no lane of any other road, and through no wall', () => {
  const pr = {};
  const buf = new Int32Array(64);
  const at = { x: 0, y: 0 };
  let open = 0;
  for (const x of W.xings) {
    const p = paths[x.id];
    if (!p.clear) continue;
    open++;
    for (let i = 0; i + 1 < p.n; i++) {
      assert.ok(!TLV.world.spatial.rayBlocked(W, p.x[i], p.y[i], p.x[i + 1], p.y[i + 1]), `crossing ${x.id}`);
      const d = math.dist(p.x[i], p.y[i], p.x[i + 1], p.y[i + 1]);
      for (let t = 0; t <= d; t += 1) {
        at.x = p.x[i] + (p.x[i + 1] - p.x[i]) * t / (d || 1);
        at.y = p.y[i] + (p.y[i + 1] - p.y[i]) * t / (d || 1);
        const c = TLV.world.lanes.lanesNear(W, at.x, at.y, 3, buf);
        for (let j = 0; j < c; j++) {
          const l = W.lanes[buf[j]];
          if (l.edge === x.edge) continue;
          math.polyProject(l.px, l.py, l.cum, at.x, at.y, -1, pr);
          assert.ok(!(pr.d < l.width / 2 - 0.01 && pr.s > 0.5 && pr.s < l.len - 0.5), `crossing ${x.id} on lane ${l.id}`);
        }
      }
    }
  }
  assert.ok(open > 1650, `${open} clear`);
});

test('most crossings are walkable, and a boulevard is crossed by way of its median', () => {
  const walkable = W.xings.filter((x) => cross.walkable(S, paths[x.id])).length;
  const median = W.xings.filter((x) => !paths[x.id].ambient && cross.partnerOf(S, paths[x.id]) >= 0).length;
  assert.ok(walkable > 1400, `${walkable} of ${W.xings.length}`);
  assert.ok(median > 100, `${median} through a median`);
  for (const x of W.xings) {
    const p = paths[x.id];
    const q = cross.partnerOf(S, p);
    if (q < 0) continue;
    const other = paths[q];
    assert.ok(other.clear);
    assert.notStrictEqual(W.xings[q].edge, x.edge);
    assert.notStrictEqual(other.swA < 0, other.swB < 0);
  }
});

test('a crossing with a landing on no sidewalk is not offered to ambient walkers', () => {
  for (const x of W.xings) {
    const p = paths[x.id];
    if (p.ambient) {
      assert.ok(p.swA >= 0 && p.swB >= 0);
      assert.ok(p.clear);
    }
  }
});

test('every link is read: walked straight, walked by a corner, walked as a crossing, or shut', () => {
  const counts = { straight: 0, via: 0, road: 0, shut: 0 };
  for (const sw of W.sidewalks) {
    const info = walk.rowInfo(S, sw.id);
    walk.readLinks(S, info);
    for (let l = 0; l < sw.links.length; l++) {
      const link = sw.links[l];
      const other = W.sidewalks[link.sw];
      const ai = link.atEnd ? sw.px.length - 1 : 0;
      const bi = link.toStart ? 0 : other.px.length - 1;
      const ax = sw.px[ai];
      const ay = sw.py[ai];
      const bx = other.px[bi];
      const by = other.py[bi];
      if (!info.linkOk[l]) {
        counts.shut++;
        assert.ok(TLV.world.spatial.rayBlocked(W, ax, ay, bx, by), 'only a wall shuts a link');
        continue;
      }
      if (info.linkRoad[l]) counts.road++;
      if (info.linkVia[l]) {
        counts.via++;
        const vx = info.linkX[l];
        const vy = info.linkY[l];
        assert.ok(!TLV.world.spatial.rayBlocked(W, ax, ay, vx, vy));
        assert.ok(!TLV.world.spatial.rayBlocked(W, vx, vy, bx, by));
      } else {
        counts.straight++;
        assert.ok(!TLV.world.spatial.rayBlocked(W, ax, ay, bx, by));
      }
    }
  }
  // 2,078 link ends, counting both directions of the 1,039 through walls.
  assert.ok(counts.via > 1500, JSON.stringify(counts));
  assert.ok(counts.shut < 700, JSON.stringify(counts));
  assert.ok(counts.road > 500, JSON.stringify(counts));
});

test('rows read walls: a stretch in a solid building is shut, and spans lie inside the row in order', () => {
  let walled = 0;
  for (const sw of W.sidewalks) {
    const info = walk.rowInfo(S, sw.id);
    for (let k = 0; k < info.nSpans; k++) {
      assert.ok(info.spanS0[k] >= -1e-3 && info.spanS1[k] <= sw.len + 1e-3 && info.spanS0[k] <= info.spanS1[k]);
      if (info.spanSpot[k] < 0) walled += info.spanS1[k] - info.spanS0[k];
    }
  }
  assert.ok(walled > 1500 && walled < 6000, `${walled} m`);
});

test('a row turns a walker back from a stall with a car in it, and lets them through an empty one', () => {
  let tested = 0;
  for (const sw of W.sidewalks) {
    const info = walk.rowInfo(S, sw.id);
    for (let k = 0; k < info.nSpans && tested < 20; k++) {
      const spot = info.spanSpot[k];
      if (spot < 0 || info.spanS0[k] < 2) continue;
      const before = TLV.world.parking.state(S, spot);
      TLV.world.parking.setState(S, spot, TLV.const.OCC.PARKED);
      assert.strictEqual(walk.blockAhead(S, info, info.spanS0[k] - 1, 1), info.spanS0[k]);
      assert.strictEqual(walk.pointFree(S, info, (info.spanS0[k] + info.spanS1[k]) / 2, 0), false);
      TLV.world.parking.setState(S, spot, TLV.const.OCC.FREE);
      assert.ok(walk.blockAhead(S, info, info.spanS0[k] - 1, 1) !== info.spanS0[k]);
      TLV.world.parking.setState(S, spot, before);
      tested++;
    }
  }
  assert.strictEqual(tested, 20);
});

test('a walker never stands in a stall span of a row with a car in it when placed by the spawner', () => {
  const place = { sw: -1, s: 0, x: 0, y: 0 };
  S.player.fx = 200;
  S.player.fy = 300;
  for (let i = 0; i < 300; i++) {
    assert.ok(walk.findPlace(S, 20, 150, false, place));
    const info = walk.rowInfo(S, place.sw);
    assert.ok(walk.pointFree(S, info, place.s, 0));
    assert.ok(walk.openRun(S, info, place.s, W.sidewalks[place.sw].len) >= T.spawnRunM);
    assert.ok(math.dist(place.x, place.y, 200, 300) <= 150);
  }
});

test('Nobody waits for a crossing where a turning car goes: a kerb in the sweep sends them back toward the sidewalk', () => {
  let moved = 0;
  for (const x of W.xings) {
    const p = paths[x.id];
    if (p.swA < 0 || p.backA <= 0.5) continue;
    moved++;
    const q = peds.spawn(S, { kind: 'walker', x: 0, y: 0, swId: p.swA, swS: p.sA });
    cross.start(S, q, p, 1, 'LEGAL');
    const fromKerb = math.dist(q._p.gx, q._p.gy, p.x[0], p.y[0]);
    peds.despawn(S, q);
    assert.ok(fromKerb >= p.backA - T.queueSideM - 0.01, `crossing ${x.id} waits ${fromKerb} m from its kerb, needs ${p.backA}`);
  }
  assert.ok(moved > 20, `${moved} kerbs`);
});
