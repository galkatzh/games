// tests/peds/hits.test.mjs — section 19 item 7: riders count as people, so every hit is a player.hitPed. This runs the real WP-PLAYER
// collision code, so it needs that package; without it the test says so instead of passing.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createTLV, createSim, quiet, noCrowd, setPlayer, run } from './helpers.mjs';

quiet();
const HAVE = fs.existsSync(new URL('../../js/sim/player/collide.js', import.meta.url));

function withPlayer() {
  const bare = createTLV({ files: [], allowMissing: true });
  const files = bare.manifest.sim.filter((f) => !/js\/sim\/(traffic|game)\//.test(f));
  const TLV = createTLV({ files, map: 'tests/fixtures/mini_map.js', allowMissing: true });
  noCrowd(TLV);
  return TLV;
}

test('every kind of person hit by the moving car gives player.hitPed, and stumbles', { skip: HAVE ? false : 'WP-PLAYER is not in the tree' }, () => {
  for (const kind of ['walker', 'phone', 'trolley', 'scooter', 'delivery', 'passenger', 'saver', 'inspector']) {
    const TLV = withPlayer();
    const S = createSim(TLV, { seed: 1, allowMissing: true, flags: { traffic: false, peds: true, incidents: false } });
    const W = S.world;
    const lane = W.lanes[0];
    const at = TLV.world.lanes.pointAt(W, lane.id, 60, {});
    const hits = [];
    S.bus.on('player.hitPed', (e) => hits.push(e));
    const p = TLV.peds.spawn(S, { kind, x: at.x, y: at.y, state: 'SCRIPT' });
    p.state = 'WALK';
    p._p.mode = 'STAND';
    p._p.after = 'BAY';
    p._p.job = 'SAVE';
    p._p.spot = -1;
    TLV.player.setPose(S, at.x - 4, at.y, at.h, 8);
    S.controls.throttle = 1;
    run(TLV, S, 30);
    assert.strictEqual(hits.length, 1, `${kind}: ${hits.length} hits`);
    assert.strictEqual(hits[0].pedId, p.id);
    assert.strictEqual(hits[0].pedKind, kind);
    assert.strictEqual(p.state, 'STUMBLE', kind);
  }
});

test('an attacker hit changes no state, and still gives player.hitPed for the penalty', { skip: HAVE ? false : 'WP-PLAYER is not in the tree' }, () => {
  const TLV = withPlayer();
  const S = createSim(TLV, { seed: 1, allowMissing: true, flags: { traffic: false, peds: true, incidents: false } });
  const W = S.world;
  const at = TLV.world.lanes.pointAt(W, 0, 60, {});
  const hits = [];
  S.bus.on('player.hitPed', (e) => hits.push(e));
  const p = TLV.peds.spawn(S, { kind: 'attacker', x: at.x, y: at.y, state: 'SCRIPT' });
  TLV.player.setPose(S, at.x - 4, at.y, at.h, 8);
  S.controls.throttle = 1;
  run(TLV, S, 30);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(p.state, 'SCRIPT');
});

/** A person standing on lane 0, and the car 4 m short of them at this speed, held there by the throttle. */
function accident(v, kind = 'walker') {
  const TLV = withPlayer();
  const S = createSim(TLV, { seed: 1, allowMissing: true, flags: { traffic: false, peds: true, incidents: false } });
  const at = TLV.world.lanes.pointAt(S.world, 0, 40, {});
  const hits = [];
  const brushes = [];
  S.bus.on('player.hitPed', (e) => hits.push(e));
  S.bus.on('player.brushPed', (e) => brushes.push(e));
  const p = TLV.peds.spawn(S, { kind, x: at.x, y: at.y, state: 'SCRIPT' });
  p.state = 'WALK';
  p._p.mode = 'STAND';
  p._p.after = 'BAY';
  p._p.job = 'SAVE';
  p._p.spot = -1;
  TLV.player.setPose(S, at.x - Math.cos(at.h) * 4.5, at.y - Math.sin(at.h) * 4.5, at.h, v);
  S.controls.throttle = v > 0 ? 0.6 : 0;
  return { TLV, S, at, p, hits, brushes };
}

for (const v of [4.7, 12, 22]) {
  test(`one accident is one hit at ${v} m/s: with the car driving on, the person is put aside and stays there`, { skip: HAVE ? false : 'WP-PLAYER is not in the tree' }, () => {
    const { TLV, S, at, p, hits } = accident(v);
    const car = S.vehicles[0];
    run(TLV, S, 40, () => hits.length === 0);
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(p.state, 'STUMBLE');
    let furthest = 0;
    let near = 0;
    run(TLV, S, 230, () => {
      furthest = Math.max(furthest, Math.hypot(p.x - at.x, p.y - at.y));
      if (Math.hypot(p.x - car.x, p.y - car.y) < 3) near++;
    });
    assert.strictEqual(hits.length, 1, 'one hit, however long the car takes to go by');
    assert.ok(furthest < 3, `carried ${furthest.toFixed(1)} m`);
    assert.ok(near < 40, `in step with the car for ${near} ticks`);
    const along = (p.x - at.x) * Math.cos(at.h) + (p.y - at.y) * Math.sin(at.h);
    assert.ok(Math.abs(along) < 1, `moved ${along.toFixed(2)} m along the road: aside, not ahead`);
  });
}

test('driving back into someone still stumbling costs nothing more, and they stay where they fell', { skip: HAVE ? false : 'WP-PLAYER is not in the tree' }, () => {
  const { TLV, S, at, p, hits, brushes } = accident(6);
  run(TLV, S, 40, () => hits.length === 0);
  run(TLV, S, 80);
  const x = p.x;
  const y = p.y;
  // Right on top of them, moving: the one way to reach someone a body has already put aside.
  TLV.player.setPose(S, x, y, at.h, 6);
  run(TLV, S, 80);
  assert.strictEqual(hits.length, 1);
  assert.strictEqual(p.state, 'STUMBLE');
  assert.strictEqual(brushes.length, 1, 'the contact is a brush');
  assert.ok(Math.hypot(p.x - x, p.y - y) < 3);
});

test('the knock goes aside, to the side of the car\'s line they stood on, and takes them nowhere along it', () => {
  for (const side of [1, -1]) {
    const TLV = createTLV({ files: createTLV({ files: [], allowMissing: true }).manifest.sim.filter((f) => !/js\/sim\/(traffic|player|game)\//.test(f)), map: 'tests/fixtures/mini_map.js', allowMissing: true });
    noCrowd(TLV);
    const S = createSim(TLV, { seed: 1, allowMissing: true, flags: { traffic: false, peds: true, incidents: false } });
    const at = TLV.world.lanes.pointAt(S.world, 0, 60, {});
    const c = Math.cos(at.h);
    const s = Math.sin(at.h);
    setPlayer(S, at.x - c * 30 + s * 0.4 * side, at.y - s * 30 - c * 0.4 * side, at.h);
    const p = TLV.peds.spawn(S, { kind: 'walker', x: at.x, y: at.y, state: 'SCRIPT' });
    p.state = 'WALK';
    p._p.mode = 'STAND';
    TLV.peds.onHit(S, p, c, s, 10);
    run(TLV, S, 40);
    const along = (p.x - at.x) * c + (p.y - at.y) * s;
    const left = -(p.x - at.x) * s + (p.y - at.y) * c;
    assert.ok(Math.abs(along) < 0.01, `along ${along}`);
    assert.ok(left * side > 0.7 && left * side <= TLV.tune.peds.knockM + 0.01, `aside ${left}, side ${side}`);
  }
});

test('a body reaching someone stumbling moves them sideways, and never through a wall', () => {
  const TLV = createTLV({ files: createTLV({ files: [], allowMissing: true }).manifest.sim.filter((f) => !/js\/sim\/(traffic|player|game)\//.test(f)), map: 'tests/fixtures/mini_map.js', allowMissing: true });
  noCrowd(TLV);
  const S = createSim(TLV, { seed: 1, allowMissing: true, flags: { traffic: false, peds: true, incidents: false } });
  const bld = S.world.blds[0];
  const wallY = bld.minY;
  const x = (bld.minX + bld.maxX) / 2;
  const down = (y) => {
    const p = TLV.peds.spawn(S, { kind: 'walker', x, y, state: 'SCRIPT' });
    p.state = 'WALK';
    p._p.mode = 'STAND';
    TLV.peds.onHit(S, p, 0, 0, 0);
    return p;
  };
  // Beside a car along the wall, with the wall behind them: their way out of its side is indoors, so they stay.
  const hemmed = down(wallY - 0.2);
  setPlayer(S, x, wallY - 1.2, 0, 0);
  run(TLV, S, 12);
  assert.strictEqual(hemmed.state, 'STUMBLE');
  assert.strictEqual(TLV.world.spatial.pointInBuilding(S.world, hemmed.x, hemmed.y), -1, 'outdoors');
  assert.ok(Math.hypot(hemmed.x - x, hemmed.y - (wallY - 0.2)) < 0.01, 'and where they fell');
  TLV.peds.despawn(S, hemmed);
  // The same car with open ground at their back: out of its side, and no way along it.
  const open = down(wallY - 8);
  setPlayer(S, x, wallY - 9, 0, 0);
  run(TLV, S, 12);
  assert.ok(open.y > wallY - 8 + 0.1, `moved aside, y ${open.y - wallY}`);
  assert.ok(Math.abs(open.x - x) < 0.01, `not along the car: ${open.x - x}`);
});

test('peds.onHit moves nobody into a wall, and works with no impulse', () => {
  const TLV = createTLV({ files: createTLV({ files: [], allowMissing: true }).manifest.sim.filter((f) => !/js\/sim\/(traffic|player|game)\//.test(f)), map: 'tests/fixtures/mini_map.js', allowMissing: true });
  noCrowd(TLV);
  const S = createSim(TLV, { seed: 1, allowMissing: true, flags: { traffic: false, peds: true, incidents: false } });
  setPlayer(S, 0, 0);
  const p = TLV.peds.spawn(S, { kind: 'walker', x: 80, y: -80 });
  run(TLV, S, 6);
  TLV.peds.onHit(S, p, 0, 0, 0);
  run(TLV, S, 30);
  assert.strictEqual(p.state, 'STUMBLE');
  assert.strictEqual(TLV.world.spatial.pointInBuilding(S.world, p.x, p.y), -1);
});
