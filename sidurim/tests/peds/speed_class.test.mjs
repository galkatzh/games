// tests/peds/speed_class.test.mjs — a step is worked out from places, so nothing else stops it coming to any speed. Nobody exceeds their
// speed class, unless a moving body is on top of them, and then by no more than that body's speed.
import test from 'node:test';
import assert from 'node:assert';
import { createTLV, createSim } from '../../tools/lib/classic.mjs';
import { loadBare, sim, quiet, noCrowd, setPlayer, run, until, person, placeCar, zebraLanes } from './helpers.mjs';

quiet();

function mini() {
  const TLV = loadBare();
  noCrowd(TLV);
  const S = sim(TLV);
  setPlayer(S, 300, 300);
  return { TLV, S };
}

test('seed 1 errands, the scooter that slid round a creeping sedan: no contact, and nobody over their class', () => {
  const params = { seed: 1, notitle: 1, immortal: 1, invariants: 1, autoplay: 'errands' };
  const TLV = createTLV({ map: 'tlv_center', params });
  const S = createSim(TLV, { seed: 1, map: 'tlv_center' });
  const T = TLV.tune.peds;
  const near = [];
  const rider = (p) => p.kind === 'scooter' || p.kind === 'delivery';
  const last = new Map();
  let thinks = 0;
  let worst = { over: 0 };
  TLV.sim.step(S);
  // The contact was at tick 24485, so this runs past it.
  while (S.tick < 24600) {
    TLV.sim.step(S);
    for (const p of S.peds) {
      if (!p.active || p.state === 'SCRIPT' || p.state === 'STUMBLE' || p._p.force) continue;
      // p.v holds from one think to the next, and the body it allowed for is read on the tick it was set.
      if (last.get(p.id) === p.v) continue;
      last.set(p.id, p.v);
      thinks++;
      const n = TLV.traffic.vehiclesNear(S, p.x, p.y, 12, near);
      let body = 0;
      for (let i = 0; i < n; i++) body = Math.max(body, Math.abs(near[i].v) + Math.abs(near[i].yawRate) * near[i].length / 2);
      const cls = Math.max(rider(p) ? p._p.base : Math.max(T.flee, T.aimMaxWalker), p._p.speed);
      const over = p.v - cls - body;
      if (over > worst.over) worst = { over, tick: S.tick, kind: p.kind, state: p.state, mode: p._p.mode, v: p.v };
    }
  }
  assert.ok(thinks > 1e5, `${thinks} thinks`);
  assert.ok(worst.over < 0.01, JSON.stringify(worst));
  assert.strictEqual(S.pedsys.contacts, 0, JSON.stringify(S.pedsys.lastContact));
});

test('A rider braking on a lane brakes from their own speed, whatever a detour made their last step read', () => {
  const { TLV, S } = mini();
  setPlayer(S, 12, -80);
  const lane = zebraLanes(S).north;
  const at = TLV.world.lanes.pointAt(S.world, lane.id, 150, {});
  const p = person(TLV, S, { kind: 'scooter', x: at.x + 8, y: at.y });
  run(TLV, S, 6);
  assert.strictEqual(TLV.peds.command(S, p, { type: 'SCOOTER_SALMON', laneId: lane.id, s: 150 }), true);
  assert.ok(until(TLV, S, 3, () => p._p.mode === 'LANE'));
  p._p.aside = true;
  p.v = 31;
  const s0 = p._p.laneS;
  TLV.peds.riders.stepLane(S, p, 0.05);
  assert.ok(Math.abs(s0 - p._p.laneS) <= p._p.base * 0.05 + 1e-9, `${(s0 - p._p.laneS) / 0.05} m/s along the lane`);
});

test('A rider held round a stopped car on a lane stays at their class, and gets by', () => {
  const { TLV, S } = mini();
  setPlayer(S, 12, -80);
  const lane = zebraLanes(S).north;
  const at = TLV.world.lanes.pointAt(S.world, lane.id, 120, {});
  const here = TLV.world.lanes.pointAt(S.world, lane.id, 150, {});
  const p = person(TLV, S, { kind: 'scooter', x: here.x + 8, y: here.y });
  run(TLV, S, 6);
  assert.strictEqual(TLV.peds.command(S, p, { type: 'SCOOTER_SALMON', laneId: lane.id, s: 150 }), true);
  placeCar(TLV, S, { x: at.x, y: at.y, h: at.h, v: 0, laneId: -1 });
  let most = 0;
  run(TLV, S, 360, () => { if (p.active) most = Math.max(most, p.v); });
  assert.ok(most <= p._p.base + 1e-6, `${most} m/s against ${p._p.base}`);
});

test('Someone who gives up on a link 50 m long walks to a near row, and does not arrive in one think', () => {
  const { TLV, S } = mini();
  const p = person(TLV, S, { kind: 'scooter', x: 0, y: -100, swId: 16, swS: 80 });
  run(TLV, S, 6);
  const P = p._p;
  const row = S.world.sidewalks[P.sw];
  const [gx, gy] = [row.px[row.px.length - 1], row.py[row.py.length - 1]];
  // Wedged: the walk has a place to reach and is getting nowhere.
  P.mode = 'LINK';
  P.after = 'ROW';
  P.gx = gx;
  P.gy = gy;
  P.via = false;
  P.s = row.len;
  P.vx = 0;
  P.vy = 0;
  P.lastD = 0;
  P.stuckT = TLV.tune.peds.freeStuckS + 1;
  const far = Math.hypot(p.x - gx, p.y - gy);
  assert.ok(far > 20, `${far} m`);
  let most = 0;
  run(TLV, S, 120, () => { most = Math.max(most, p.v); });
  assert.ok(most <= Math.max(P.base, P.speed) + 1e-6, `${most} m/s`);
});

test('Stuck twice over, they still get out: the place is taken as reached, and they walk to it at their class', () => {
  const { TLV, S } = mini();
  const p = person(TLV, S, { kind: 'walker', x: 0, y: -100, swId: 16, swS: 80 });
  run(TLV, S, 6);
  const P = p._p;
  const row = S.world.sidewalks[P.sw];
  P.mode = 'FREE';
  P.after = 'ROW';
  P.gaveUp = true;
  P.s = row.len / 2;
  P.gx = p.x + 30;
  P.gy = p.y;
  P.via = false;
  P.vx = 0;
  P.vy = 0;
  P.lastD = 0;
  P.stuckT = TLV.tune.peds.freeStuckS + 1;
  let most = 0;
  run(TLV, S, 6, () => { most = Math.max(most, p.v); });
  assert.strictEqual(P.mode, 'ROW', 'taken as reached');
  assert.strictEqual(P.gaveUp, false, 'and the next stick starts afresh');
  run(TLV, S, 60, () => { most = Math.max(most, p.v); });
  assert.ok(most <= Math.max(P.base, TLV.tune.peds.flee) + 1e-6, `${most} m/s`);
});

test('a forced walk through a stopped body lasts until they are out of it, past the kerb if need be', () => {
  // Seed 91, tick 13266. She reached the kerb inside a stopped bus. The walk through it was over and the contact count was not.
  const { TLV, S } = mini();
  const p = person(TLV, S, { kind: 'walker', x: 300, y: 300 });
  p.x = 300;
  p.y = 300;
  const bus = placeCar(TLV, S, { x: 300, y: 300, h: 0, v: 0, kind: 'bus' });
  const sys = S.pedsys;
  const walk = TLV.peds.walk;
  const scan = () => { walk.vehicles = () => { sys.near[0] = bus; return 1; }; walk.scan(S, p); };
  const before = sys.contacts;
  p._p.force = true;
  scan();
  assert.equal(p._p.through, true, 'inside on the walk');
  p._p.force = false;
  scan();
  assert.equal(sys.contacts, before, 'the kerb does not end it');
  assert.equal(p._p.through, true);
  p.x = 330;
  scan();
  assert.equal(p._p.through, false, 'out of the body, the walk is over');
  p.x = 300;
  scan();
  assert.equal(sys.contacts, before + 1, 'and standing in a car is a contact again');
});
