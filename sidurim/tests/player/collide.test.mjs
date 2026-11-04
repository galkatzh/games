// tests/player/collide.test.mjs — WP-PLAYER
// ARCHITECTURE 19, WP-PLAYER items 2, 3, 4, 5 and 9. Scenes run on the fixture and on real walls, lanes and signals of tlv_center.
import assert from 'node:assert';
import { test } from 'node:test';
import {
  loadTLV, makeSim, run, listen, release, openWall, clearParked, openRoad, straightLane, placeCar, removeCar, MINI, REAL
} from './helpers.mjs';

const PEOPLE_STUB = 'tests/player/stubs/peds_stub.js';
const TRAFFIC_STUB = 'tests/player/stubs/traffic_stub.js';
const CONTACTS = ['player.contact'];

/** Maps tested end to end. */
const MAPS = [['mini', MINI], ['tlv_center', REAL]];

/** Puts the car just off a wall, at a glancing angle, heading in, so it hits near the wall's middle. */
function aimAtWall(TLV, S, wall, angleRad, speed) {
  const veh = S.vehicles[0];
  const reach = veh.width / 2 * Math.cos(angleRad) + veh.length / 2 * Math.sin(angleRad);
  const off = reach + 0.25;
  const back = 0.25 / Math.sin(angleRad);
  const dirX = wall.ux * Math.cos(angleRad) - wall.nx * Math.sin(angleRad);
  const dirY = wall.uy * Math.cos(angleRad) - wall.ny * Math.sin(angleRad);
  const h = Math.atan2(dirY, dirX);
  TLV.player.setPose(S, wall.mx + wall.nx * off - wall.ux * back, wall.my + wall.ny * off - wall.uy * back, h, speed);
  return h;
}

/** Runs until the first contact of a car, then returns what it was doing just before. */
function untilContact(TLV, S, wall, maxTicks = 180) {
  const veh = S.vehicles[0];
  let before = null;
  const seen = listen(S, CONTACTS);
  for (let i = 0; i < maxTicks; i++) {
    const was = { vx: veh.vx, vy: veh.vy };
    TLV.sim.step(S);
    if (seen['player.contact'].length) {
      before = was;
      break;
    }
  }
  return { before, seen };
}

for (const [name, map] of MAPS) {
  test(`${name}: a wall glance under 30 deg keeps at least 80% of tangential speed`, () => {
    const TLV = loadTLV(map);
    const S = makeSim(TLV);
    const wall = openWall(TLV, S.world);
    clearParked(TLV, S, wall.mx, wall.my, 30);
    for (const deg of [5, 15, 25, 29]) {
      run(TLV, S, 40);
      aimAtWall(TLV, S, wall, deg * Math.PI / 180, 12);
      const veh = S.vehicles[0];
      const { before, seen } = untilContact(TLV, S, wall);
      assert.ok(before, `a ${deg} deg approach reached the wall`);
      const tangent = (v) => Math.abs(v.vx * wall.ux + v.vy * wall.uy);
      const t0 = tangent(before);
      assert.ok(tangent(veh) >= 0.8 * t0, `${deg} deg kept ${tangent(veh) / t0} of ${t0}`);
      run(TLV, S, 20);
      assert.ok(tangent(veh) >= 0.75 * t0, `${deg} deg sliding kept ${tangent(veh) / t0}`);
      assert.ok(Math.abs(veh.v) > 4, 'still moving');
      assert.strictEqual(seen['player.contact'][0].kind, 'static');
      assert.strictEqual(seen['player.contact'][0].otherId, wall.owner);
    }
  });

  test(`${name}: a head-on hit bounces and is never a dead stop`, () => {
    const TLV = loadTLV(map);
    const S = makeSim(TLV);
    const wall = openWall(TLV, S.world);
    clearParked(TLV, S, wall.mx, wall.my, 30);
    const veh = S.vehicles[0];
    const into = Math.atan2(-wall.ny, -wall.nx);
    for (const speed of [4, 8, 13]) {
      run(TLV, S, 40);
      TLV.player.setPose(S, wall.mx + wall.nx * 8, wall.my + wall.ny * 8, into, speed);
      const { seen } = untilContact(TLV, S, wall);
      assert.ok(seen['player.contact'].length, 'it reached the wall');
      assert.notStrictEqual(veh.v, 0, 'not a dead stop');
      const after = Math.hypot(veh.vx, veh.vy);
      const hitVn = seen['player.contact'][seen['player.contact'].length - 1].vn;
      assert.ok(after >= 0.29 * hitVn && after >= 0.5, `moving after a hit at ${hitVn}: ${after}`);
      assert.ok((veh.vx * wall.nx + veh.vy * wall.ny) > 0, 'moving away from the wall');
    }

    // Holding the throttle into the wall must still lead somewhere.
    TLV.player.setPose(S, wall.mx + wall.nx * 8, wall.my + wall.ny * 8, into, 13);
    const x0 = wall.mx;
    const y0 = wall.my;
    run(TLV, S, 300, (c) => { c.throttle = 1; });
    assert.ok(Math.hypot(veh.x - x0, veh.y - y0) > 3, 'the car slid along the wall');
    assert.ok(Math.abs(TLV.math.wrapPi(veh.h - into)) > 0.3, 'the car turned off the wall');

    // And reverse always backs out.
    release(S.controls);
    TLV.player.setPose(S, wall.mx + wall.nx * 8, wall.my + wall.ny * 8, into, 13);
    run(TLV, S, 60);
    const px = veh.x;
    const py = veh.y;
    run(TLV, S, 120, (c) => { c.brake = 1; });
    assert.ok(Math.hypot(veh.x - px, veh.y - py) > 3, 'reverse backs away');
  });

  test(`${name}: scrape, bump and crash at the right closing speed, on a 0.5 s guard per body`, () => {
    const TLV = loadTLV(map);
    const S = makeSim(TLV);
    const wall = openWall(TLV, S.world);
    clearParked(TLV, S, wall.mx, wall.my, 30);
    const into = Math.atan2(-wall.ny, -wall.nx);
    const cases = [
      [0.4, null], [0.55, 'scrape'], [2.9, 'scrape'], [3.05, 'bump'], [5, 'bump'], [8.95, 'bump'], [9.1, 'crash'], [13, 'crash']
    ];
    for (const [vn, want] of cases) {
      // Long past any guard from the previous case.
      run(TLV, S, 40);
      release(S.controls);
      const gap = 2 + vn / 60 * 0.7;
      TLV.player.setPose(S, wall.mx + wall.nx * gap, wall.my + wall.ny * gap, into, vn);
      const seen = listen(S, CONTACTS);
      run(TLV, S, 40);
      const events = seen['player.contact'];
      if (want === null) {
        assert.strictEqual(events.length, 0, `no event at ${vn}`);
      } else {
        assert.strictEqual(events.length, 1, `one event at ${vn}, got ${events.length}`);
        assert.strictEqual(events[0].severity, want, `${vn} m/s`);
        assert.ok(Math.abs(events[0].vn - vn) < 0.25, `vn ${events[0].vn} for ${vn}`);
        assert.strictEqual(events[0].rearEnded, false);
      }
    }
  });
}

test('the guard: a second hit on one body inside 0.5 s is silent, and after it counts again', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const wall = openWall(TLV, S.world);
  clearParked(TLV, S, wall.mx, wall.my, 30);
  const into = Math.atan2(-wall.ny, -wall.nx);
  const seen = listen(S, CONTACTS);
  TLV.player.setPose(S, wall.mx + wall.nx * 2.3, wall.my + wall.ny * 2.3, into, 4);
  run(TLV, S, 12);
  assert.strictEqual(seen['player.contact'].length, 1);
  TLV.player.setPose(S, wall.mx + wall.nx * 2.3, wall.my + wall.ny * 2.3, into, 4);
  run(TLV, S, 12);
  assert.strictEqual(seen['player.contact'].length, 1, 'inside the guard');
  run(TLV, S, 30);
  TLV.player.setPose(S, wall.mx + wall.nx * 2.3, wall.my + wall.ny * 2.3, into, 4);
  run(TLV, S, 12);
  assert.strictEqual(seen['player.contact'].length, 2, 'past the guard');
});

/** Hits on one body while a car holds the gas into it, for as long as it stays alongside. */
function pressed(TLV, S, id, seconds, along) {
  const seen = listen(S, CONTACTS);
  const veh = S.vehicles[0];
  const start = { x: veh.x, y: veh.y };
  let i = 0;
  for (; i < seconds * 60 && Math.hypot(veh.x - start.x, veh.y - start.y) < along; i++) {
    S.controls.throttle = 1;
    TLV.sim.step(S);
  }
  return { hits: seen['player.contact'].filter((c) => c.otherId === id), ticks: i };
}

test('one press is one hit: the gas held into a wall pays once, for as long as the car stays against it', () => {
  const TLV = loadTLV(REAL);
  for (const [deg, from] of [[0, 3.5], [25, 6], [-40, 5]]) {
    const S = makeSim(TLV);
    const wall = openWall(TLV, S.world);
    clearParked(TLV, S, wall.mx, wall.my, 40);
    const into = Math.atan2(-wall.ny, -wall.nx) + deg * Math.PI / 180;
    TLV.player.setPose(S, wall.mx + wall.nx * from, wall.my + wall.ny * from, into, 0);
    const { hits, ticks } = pressed(TLV, S, wall.owner, 6, wall.len / 2);
    assert.ok(ticks > 120, `${deg} deg: it held on for ${ticks} ticks`);
    // A car that bounced comes back once, inside a second, at what the gas gave it.
    assert.ok(hits.length >= 1 && hits.length <= 2, `${deg} deg: ${hits.map((h) => h.vn.toFixed(2))}`);
    if (hits[1]) assert.ok(hits[1].severity === 'scrape' && hits[1].t - hits[0].t < 1, `${deg} deg: ${hits[1].vn}`);
    assert.ok(S.player.touchT > S.t - 1, 'the car says when it last touched something');
  }
});

test('one press is one hit on a parked car too, and on a car stopped in front', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const lane = straightLane(TLV, W, 150);
  const at = TLV.world.lanes.pointAt(W, lane.id, 75, {});
  const ids = [];
  TLV.world.parking.spotsNear(W, at.x, at.y, 60, ids);
  const id = ids[0];
  const box = TLV.world.parking.boxOf(W, id, TLV.const.OCC.PARKED, {});
  clearParked(TLV, S, box.x, box.y, 30);
  TLV.world.parking.setState(S, id, TLV.const.OCC.PARKED);
  const h = Math.atan2(box.y - at.y, box.x - at.x);
  TLV.player.setPose(S, box.x - Math.cos(h) * 4.5, box.y - Math.sin(h) * 4.5, h, 0);
  const { hits, ticks } = pressed(TLV, S, id, 4, 6);
  assert.ok(ticks > 60, `held on for ${ticks} ticks`);
  assert.strictEqual(hits.length, 1, hits.map((c) => c.vn.toFixed(2)).join(' '));
});

test('rocking on the spot against a wall is one press, however long it goes on', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const wall = openWall(TLV, S.world);
  clearParked(TLV, S, wall.mx, wall.my, 40);
  const into = Math.atan2(-wall.ny, -wall.nx);
  TLV.player.setPose(S, wall.mx + wall.nx * 3, wall.my + wall.ny * 3, into, 0);
  const seen = listen(S, CONTACTS);
  run(TLV, S, 60 * 8, (c, s, i) => {
    const forward = i % 80 < 44;
    c.throttle = forward ? 1 : 0;
    c.brake = forward ? 0 : 1;
  });
  const hits = seen['player.contact'].filter((c) => c.otherId === wall.owner);
  assert.ok(hits.length >= 1 && hits.length <= 2, hits.map((h) => h.vn.toFixed(2)).join(' '));
});

test('coming away from a body and driving at it again is a new hit', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const wall = openWall(TLV, S.world);
  clearParked(TLV, S, wall.mx, wall.my, 40);
  const into = Math.atan2(-wall.ny, -wall.nx);
  TLV.player.setPose(S, wall.mx + wall.nx * 5, wall.my + wall.ny * 5, into, 5);
  const seen = listen(S, CONTACTS);
  run(TLV, S, 40, (c) => { c.throttle = 1; });
  assert.strictEqual(seen['player.contact'].length, 1, 'the first hit');
  run(TLV, S, 100, (c) => { c.throttle = 0; c.brake = 1; });
  const veh = S.vehicles[0];
  const off = (veh.x - wall.mx) * wall.nx + (veh.y - wall.my) * wall.ny;
  assert.ok(off > 3.5, `it came away, ${off} m`);
  run(TLV, S, 120, (c) => { c.brake = 0; c.throttle = 1; });
  assert.strictEqual(seen['player.contact'].length, 2, `${seen['player.contact'].length} hits`);
});

test('parked cars are solid, are their own body, and report kind parked', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const lane = straightLane(TLV, W, 150);
  const at = TLV.world.lanes.pointAt(W, lane.id, 75, {});
  const ids = [];
  TLV.world.parking.spotsNear(W, at.x, at.y, 60, ids);
  assert.ok(ids.length > 0, 'stalls near the lane');
  const id = ids[0];
  TLV.world.parking.setState(S, id, TLV.const.OCC.PARKED);
  const box = TLV.world.parking.boxOf(W, id, TLV.const.OCC.PARKED, {});
  const seen = listen(S, CONTACTS);
  const start = TLV.world.lanes.pointAt(W, lane.id, 75, {});
  const veh = S.vehicles[0];
  const dx = box.x - start.x;
  const dy = box.y - start.y;
  const d = Math.hypot(dx, dy);
  const h = Math.atan2(dy, dx);
  clearParked(TLV, S, box.x, box.y, 30);
  TLV.world.parking.setState(S, id, TLV.const.OCC.PARKED);
  const from = 6 / d;
  TLV.player.setPose(S, box.x - dx * from, box.y - dy * from, h, 6);
  run(TLV, S, 50);
  assert.strictEqual(seen['player.contact'].length, 1);
  const hit = seen['player.contact'][0];
  assert.strictEqual(hit.kind, 'parked');
  assert.strictEqual(hit.otherId, id);
  assert.ok(!TLV.math.obbOverlap(veh, box), 'stands clear of the box');
  assert.ok(Math.abs(hit.vn) > 0.5);

  // A ghost snap passes through it, silently.
  const count = seen['player.contact'].length;
  TLV.player.setPose(S, box.x - dx * from, box.y - dy * from, h, 0);
  TLV.player.snapTo(S, box.x + dx * from, box.y + dy * from, h, 1, { ghost: true });
  run(TLV, S, 70);
  assert.strictEqual(seen['player.contact'].length, count, 'ghost');
  assert.ok(Math.hypot(veh.x - (box.x + dx * from), veh.y - (box.y + dy * from)) < 1e-6, 'arrived');
  assert.strictEqual(S.player.mode, 'DRIVE');
});

for (const [name, map] of MAPS) {
  test(`${name}: near misses fire at 0.45 and 0.9 m with 6 m/s relative speed, and not outside those`, () => {
    const TLV = loadTLV(map);
    const S = makeSim(TLV);
    const W = S.world;
    const road = openRoad(TLV, W, 10) || openRoad(TLV, W, 8) || { x: -60, y: -300, h: 0 };
    clearParked(TLV, S, road.x, road.y, 40);
    const veh = S.vehicles[0];
    const c = Math.cos(road.h);
    const s = Math.sin(road.h);
    /** Passes a parked-in-lane car at a chosen side gap and speed. */
    const pass = (gap, speed, kind) => {
      const lateral = veh.width / 2 + TLV.const.VEHICLE_SIZES[kind || 'sedan'].width / 2 + gap;
      const other = placeCar(TLV, S, road.x + 12 * c - lateral * s, road.y + 12 * s + lateral * c, road.h, { kind });
      const seen = listen(S, ['player.nearMiss', 'player.contact']);
      TLV.player.setPose(S, road.x, road.y, road.h, speed);
      S.player._c.missed.forEach((g) => { g.until = -1; });
      run(TLV, S, Math.ceil(26 / speed * 60), (ctl, sim) => {
        ctl.throttle = (speed - sim.vehicles[0].v) + 0.3;
        ctl.steer = 0;
      });
      removeCar(other);
      TLV.sim.step(S);
      return seen;
    };

    let seen = pass(0.45, 6.05);
    assert.strictEqual(seen['player.nearMiss'].length, 1, 'hair at 0.45');
    assert.strictEqual(seen['player.nearMiss'][0].tier, 2);
    assert.ok(Math.abs(seen['player.nearMiss'][0].gap - 0.45) < 0.03, `gap ${seen['player.nearMiss'][0].gap}`);
    assert.ok(seen['player.nearMiss'][0].relSpeed >= 6);
    assert.strictEqual(seen['player.contact'].length, 0);

    seen = pass(0.88, 6.05);
    assert.strictEqual(seen['player.nearMiss'].length, 1, 'near miss at 0.9');
    assert.strictEqual(seen['player.nearMiss'][0].tier, 1);

    seen = pass(1.0, 6.05);
    assert.strictEqual(seen['player.nearMiss'].length, 0, 'too wide at 1.0');

    seen = pass(0.5, 5.5);
    assert.strictEqual(seen['player.nearMiss'].length, 0, 'too slow at 5.5');

    seen = pass(0.5, 12);
    assert.strictEqual(seen['player.nearMiss'].length, 1, 'once for one pass');
    assert.strictEqual(seen['player.nearMiss'][0].tier, 1);
  });
}

test('a pass that touches pays nothing, and a pass repeated at once pays once', () => {
  const TLV = loadTLV(MINI);
  const S = makeSim(TLV);
  const veh = S.vehicles[0];
  const other = placeCar(TLV, S, -60, -289.7, 0);
  const seen = listen(S, ['player.nearMiss', 'player.contact']);
  TLV.player.setPose(S, -70, -291.0, 0, 8);
  run(TLV, S, 150);
  assert.ok(seen['player.contact'].length >= 1, 'it touched');
  assert.strictEqual(seen['player.nearMiss'].length, 0, 'no pay for a touch');
  assert.ok(other.active);
  assert.ok(veh.active);
});

test('near misses are never paid for a person', () => {
  const TLV = loadTLV(MINI, [PEOPLE_STUB]);
  const S = makeSim(TLV);
  const seen = listen(S, ['player.nearMiss', 'player.hitPed']);
  TLV.peds.spawn(S, { x: -40, y: -296.2, kind: 'walker' });
  TLV.player.setPose(S, -60, -298, 0, 12);
  run(TLV, S, 120);
  assert.strictEqual(seen['player.nearMiss'].length, 0);
  assert.strictEqual(seen['player.hitPed'].length, 0);
});

test('parked vehicles and static cars pay no near miss', () => {
  const TLV = loadTLV(MINI);
  const S = makeSim(TLV);
  const parked = placeCar(TLV, S, -40, -296.1, 0, { mode: 'PARKED' });
  const seen = listen(S, ['player.nearMiss']);
  TLV.player.setPose(S, -60, -298.3, 0, 12);
  run(TLV, S, 240);
  assert.strictEqual(seen['player.nearMiss'].length, 0, 'a parked vehicle');
  assert.ok(S.vehicles[0].x > -30, 'the pass finished');

  // The same pass past the same car, in traffic, pays. That is what makes the line above mean something.
  parked.mode = 'LANE';
  TLV.player.setPose(S, -60, -298.3, 0, 12);
  S.player._c.missed.forEach((g) => { g.until = -1; });
  run(TLV, S, 240);
  assert.strictEqual(seen['player.nearMiss'].length, 1, 'a car in traffic');
});

for (const [name, map] of MAPS) {
  test(`${name}: player.hitPed fires for every kind of person, once per contact`, () => {
    const TLV = loadTLV(map, [PEOPLE_STUB]);
    const S = makeSim(TLV);
    const W = S.world;
    const road = openRoad(TLV, W, 8) || { x: -60, y: -300, h: 0 };
    clearParked(TLV, S, road.x, road.y, 30);
    const kinds = ['walker', 'phone', 'trolley', 'scooter', 'delivery', 'passenger', 'saver', 'inspector', 'attacker'];
    for (const kind of kinds) {
      const state = kind === 'attacker' ? 'SCRIPT' : 'WALK';
      const ped = TLV.peds.spawn(S, {
        kind, state, x: road.x + 8 * Math.cos(road.h), y: road.y + 8 * Math.sin(road.h)
      });
      const seen = listen(S, ['player.hitPed', 'player.brushPed']);
      TLV.player.setPose(S, road.x, road.y, road.h, 6);
      run(TLV, S, 120, (c) => { c.brake = 0; });
      assert.strictEqual(seen['player.hitPed'].length, 1, `${kind} one hit, got ${seen['player.hitPed'].length}`);
      assert.strictEqual(seen['player.hitPed'][0].pedKind, kind);
      assert.strictEqual(seen['player.hitPed'][0].pedId, ped.id);
      assert.ok(seen['player.hitPed'][0].speed > 0.5);
      assert.strictEqual(seen['player.brushPed'].length, 0);
      TLV.peds.despawn(S, ped);
      TLV.sim.step(S);
    }
    assert.strictEqual(S.pedsys.hits.length, kinds.length, 'TLV.peds.onHit too');
  });
}

test('a car sitting on a person does not hit them again and again', () => {
  const TLV = loadTLV(MINI, [PEOPLE_STUB]);
  const S = makeSim(TLV);
  const ped = TLV.peds.spawn(S, { kind: 'attacker', state: 'SCRIPT', x: -55, y: -298 });
  const seen = listen(S, ['player.hitPed']);
  TLV.player.setPose(S, -60, -298, 0, 3);
  run(TLV, S, 600);
  assert.strictEqual(seen['player.hitPed'].length, 1, 'one contact is one hit');
  assert.ok(ped.active);
});

test('someone already stumbling from a hit is not hit again: one accident is one hit, past the 1 s guard too', () => {
  const TLV = loadTLV(MINI, [PEOPLE_STUB]);
  const S = makeSim(TLV);
  const ped = TLV.peds.spawn(S, { kind: 'walker', state: 'WALK', x: -52, y: -298 });
  const seen = listen(S, ['player.hitPed', 'player.brushPed']);
  TLV.player.setPose(S, -60, -298, 0, 6);
  run(TLV, S, 100, (c) => { c.brake = 0; });
  assert.strictEqual(seen['player.hitPed'].length, 1, 'the accident');
  assert.strictEqual(ped.state, 'STUMBLE');
  // The car comes back at them, well after the guard has run out.
  TLV.player.setPose(S, -70, -298, 0, 0);
  run(TLV, S, 90);
  TLV.player.setPose(S, -60, -298, 0, 6);
  run(TLV, S, 100, (c) => { c.brake = 0; });
  assert.strictEqual(seen['player.hitPed'].length, 1, 'the same accident');
  assert.strictEqual(seen['player.brushPed'].length, 1, 'a brush, which costs nothing');
  assert.strictEqual(S.pedsys.hits.length, 1);
  // Up and walking, a later contact is a new accident, and is paid for.
  ped.state = 'WALK';
  TLV.player.setPose(S, -70, -298, 0, 0);
  run(TLV, S, 90);
  TLV.player.setPose(S, -60, -298, 0, 6);
  run(TLV, S, 100, (c) => { c.brake = 0; });
  assert.strictEqual(seen['player.hitPed'].length, 2);
});

test('a car that creeps up against a standing person and then floors it hits them: a brush is no pass', () => {
  const TLV = loadTLV(MINI, [PEOPLE_STUB]);
  const S = makeSim(TLV);
  const nose = S.player.veh.length / 2 + 0.1;
  const ped = TLV.peds.spawn(S, { kind: 'attacker', state: 'SCRIPT', x: -60 + nose, y: -298 });
  const seen = listen(S, ['player.hitPed', 'player.brushPed']);
  TLV.player.setPose(S, -60, -298, 0, 0.3);
  run(TLV, S, 90);
  assert.strictEqual(seen['player.hitPed'].length, 0, 'at a creep it only brushes');
  assert.strictEqual(seen['player.brushPed'].length, 1, 'once');
  run(TLV, S, 90, (c) => { c.throttle = 1; });
  assert.strictEqual(seen['player.hitPed'].length, 1, 'with the foot down it is a hit');
  assert.strictEqual(seen['player.hitPed'][0].pedId, ped.id);
  assert.strictEqual(seen['player.brushPed'].length, 1, 'and the brush did not count again');
});

test('a stopped car still only brushes someone who leans on it for a long time', () => {
  const TLV = loadTLV(MINI, [PEOPLE_STUB]);
  const S = makeSim(TLV);
  TLV.peds.spawn(S, { kind: 'attacker', state: 'SCRIPT', x: -60 + S.player.veh.length / 2 + 0.1, y: -298 });
  const seen = listen(S, ['player.hitPed', 'player.brushPed']);
  TLV.player.setPose(S, -60, -298, 0, 0);
  run(TLV, S, 300);
  assert.strictEqual(seen['player.hitPed'].length, 0);
  assert.strictEqual(seen['player.brushPed'].length, 1);
});

test('a stopped car only brushes a person walking into it', () => {
  const TLV = loadTLV(MINI, [PEOPLE_STUB]);
  const S = makeSim(TLV);
  const ped = TLV.peds.spawn(S, { x: -50, y: -298, h: Math.PI, v: 1.3 });
  const seen = listen(S, ['player.hitPed', 'player.brushPed']);
  TLV.player.setPose(S, -60, -298, 0, 0);
  run(TLV, S, 420);
  assert.strictEqual(seen['player.hitPed'].length, 0);
  assert.strictEqual(seen['player.brushPed'].length, 1);
  assert.strictEqual(seen['player.brushPed'][0].pedId, ped.id);
  assert.deepStrictEqual(S.pedsys.brushes, [ped.id]);
});

test('car contact pushes the other car through applyImpact, by mass, with a kind and an id', () => {
  const TLV = loadTLV(MINI, [TRAFFIC_STUB]);
  const S = makeSim(TLV, { params: { density: 0 } });
  const a = placeCar(TLV, S, -40, -298.5, 0, { id: 7, kind: 'sedan', mode: 'PARKED' });
  const seen = listen(S, CONTACTS);
  TLV.player.setPose(S, -50, -298.5, 0, 10);
  run(TLV, S, 40);
  const hit = seen['player.contact'][0];
  assert.strictEqual(hit.kind, 'vehicle');
  assert.strictEqual(hit.otherId, 7);
  assert.strictEqual(hit.severity, 'crash');
  assert.ok(S.traffic.impacts.length >= 1, 'the guard limits what a hit costs, not the shove');
  assert.ok(S.traffic.impacts[0].jx > 3 && Math.abs(S.traffic.impacts[0].jy) < 1, 'pushed forward');

  const light = S.traffic.impacts[0].jx;
  S.traffic.impacts.length = 0;
  removeCar(a);
  run(TLV, S, 40);
  placeCar(TLV, S, -40, -298.5, 0, { id: 8, kind: 'bus', mode: 'PARKED' });
  TLV.player.setPose(S, -55, -298.5, 0, 10);
  let lowest = Infinity;
  run(TLV, S, 80, (c, s) => { lowest = Math.min(lowest, s.vehicles[0].v); });
  assert.ok(S.traffic.impacts[0].jx < light * 0.5, 'a bus barely moves');
  assert.ok(lowest < 0, `the car bounces off it, down to ${lowest}`);
});

test('an open door is part of its vehicle', () => {
  const TLV = loadTLV(MINI);
  const S = makeSim(TLV);
  // Door 1 is the left front. On a car heading east that is north of the body, ahead of its centre.
  placeCar(TLV, S, -40, -296, 0, { id: 9, door: 1 });
  const seen = listen(S, CONTACTS);
  TLV.player.setPose(S, -50, -293.6, 0, 6);
  run(TLV, S, 120);
  assert.strictEqual(seen['player.contact'].length, 1);
  assert.strictEqual(seen['player.contact'][0].kind, 'vehicle');
  assert.strictEqual(seen['player.contact'][0].otherId, 9);
});

test('rear-ended: flagged when hit from behind while straight or braking, and not otherwise', () => {
  const TLV = loadTLV(MINI);
  const S = makeSim(TLV);
  const hit = (setup) => {
    const seen = listen(S, CONTACTS);
    const other = placeCar(TLV, S, -46, -298, 0, { id: 40 + S.tick, v: 9 });
    setup();
    run(TLV, S, 8, (c, s) => {
      other.x += other.vx / 60;
      other.y += other.vy / 60;
      void s;
    });
    removeCar(other);
    run(TLV, S, 60);
    return seen['player.contact'][0];
  };
  release(S.controls);
  TLV.player.setPose(S, -41, -298, 0, 2);
  S.controls.brake = 1;
  let c = hit(() => {});
  assert.strictEqual(c.rearEnded, true, 'braking');
  assert.strictEqual(c.kind, 'vehicle');

  release(S.controls);
  TLV.player.setPose(S, -41, -298, 0, 2);
  c = hit(() => {});
  assert.strictEqual(c.rearEnded, true, 'going straight');

  release(S.controls);
  TLV.player.setPose(S, -41, -298, Math.PI, 2);
  c = hit(() => {});
  assert.strictEqual(c.rearEnded, false, 'a head-on is not a rear end');
});

test('tlv_center: BOUNDS costs nothing and emits nothing, and speed caps at 8 m/s in the last 30 m', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const veh = S.vehicles[0];
  // A clear run up to the east edge, somewhere along it.
  const edgeX = W.bounds.maxX;
  const props = new Int32Array(64);
  let y = null;
  for (let at = W.bounds.minY + 40; at < W.bounds.maxY - 40 && y === null; at += 7) {
    let clear = true;
    for (const off of [-1.5, 0, 1.5]) {
      clear = clear && !TLV.world.spatial.rayBlocked(W, edgeX - 50, at + off, edgeX - 2, at + off);
    }
    clear = clear && TLV.world.spatial.propsNear(W, edgeX - 25, at, 26, props) === 0;
    if (clear) y = at;
  }
  assert.ok(y !== null, 'a clear run up to the east edge');
  const seen = listen(S, ['player.contact', 'player.waterEdge']);
  clearParked(TLV, S, edgeX - 20, y, 60);
  // Approach from 45 m out at top speed. The band brings it down before the wall.
  TLV.player.setPose(S, edgeX - 45, y, 0, 26.4);
  let wallV = null;
  run(TLV, S, 300, (c) => {
    c.throttle = 1;
    if (wallV === null && veh.x > edgeX - 5) wallV = veh.v;
  });
  if (seen['player.contact'].length === 0) {
    assert.ok(veh.x <= edgeX, 'held inside the map');
    assert.ok(veh.x >= edgeX - 4, `reached the wall, at ${veh.x}`);
    assert.ok(wallV !== null && wallV <= 8.01, `capped at ${wallV} by the wall`);
    assert.ok(Math.abs(veh.vx) < 2, `held by the wall, ${veh.vx} m/s into it`);
    assert.ok(Math.abs(veh.v) <= 8.01, 'and any slide along it stays under the cap');
  } else {
    assert.fail(`contact on BOUNDS: ${JSON.stringify(seen['player.contact'][0])}`);
  }
});

test('mini: the four BOUNDS walls hold the car, silently', () => {
  const TLV = loadTLV(MINI);
  const S = makeSim(TLV);
  const veh = S.vehicles[0];
  const seen = listen(S, CONTACTS);
  const walls = [[390, 0, 0], [-390, 0, Math.PI], [0, 390, Math.PI / 2], [0, -390, -Math.PI / 2]];
  for (const [x, y, h] of walls) {
    TLV.player.setPose(S, x, y, h, 8);
    run(TLV, S, 120, (c) => { c.throttle = 1; });
    assert.ok(Math.abs(veh.x) <= 400 && Math.abs(veh.y) <= 400, `inside at ${veh.x}, ${veh.y}`);
  }
  assert.strictEqual(seen['player.contact'].length, 0);
});

test('sliding along BOUNDS is under the same guard as any wall: it does not bleed speed tick by tick', () => {
  const TLV = loadTLV(MINI);
  const S = makeSim(TLV);
  const veh = S.vehicles[0];
  // Up the east edge, turned into the wall, with the throttle down.
  TLV.player.setPose(S, 397, -100, 1.3, 8);
  run(TLV, S, 150, (c) => { c.throttle = 1; });
  assert.ok(veh.x <= 400);
  assert.ok(veh.vy > 6.5, `still sliding at ${veh.vy}`);
});

/** Finds real water on the west of the map, by walking in from dry land. */
function seaEdge(TLV, W) {
  const WATER = TLV.const.SURF.WATER;
  for (let y = -1000; y < 2000; y += 37) {
    for (let x = 0; x > -2100; x -= 2) {
      if (TLV.world.surface.at(W, x, y) !== WATER) continue;
      let open = true;
      for (let k = 2; k < 40 && open; k += 2) {
        open = TLV.world.surface.at(W, x + k, y) !== WATER && !TLV.world.spatial.rayBlocked(W, x + 40, y, x, y);
      }
      if (open) return { x, y };
      break;
    }
  }
  return null;
}

test('tlv_center: WATER is solid, emits player.waterEdge at most once per 5 s, and costs nothing', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const edge = seaEdge(TLV, W);
  assert.ok(edge, 'the sea has a clear shore');
  clearParked(TLV, S, edge.x, edge.y, 60);
  const seen = listen(S, ['player.contact', 'player.waterEdge']);
  const veh = S.vehicles[0];
  TLV.player.setPose(S, edge.x + 24, edge.y, Math.PI, 10);
  run(TLV, S, 300, (c) => { c.throttle = 1; });
  assert.strictEqual(seen['player.contact'].length, 0, 'not a contact');
  assert.strictEqual(seen['player.waterEdge'].length, 1, 'one line');
  const SURF = TLV.const.SURF;
  assert.notStrictEqual(TLV.world.surface.at(W, veh.x, veh.y), SURF.WATER, 'the car stayed dry');
  for (const [l, w] of [[2, 0.875], [2, -0.875], [-2, 0.875], [-2, -0.875]]) {
    const cx = veh.x + l * Math.cos(veh.h) - w * Math.sin(veh.h);
    const cy = veh.y + l * Math.sin(veh.h) + w * Math.cos(veh.h);
    assert.notStrictEqual(TLV.world.surface.at(W, cx, cy), SURF.WATER, 'every corner too');
  }
  run(TLV, S, 60, (c) => { c.throttle = 1; });
  assert.strictEqual(seen['player.waterEdge'].length, 1, 'quiet inside 5 s');

  // Off and back on after 5 s says it again.
  TLV.player.setPose(S, edge.x + 24, edge.y, Math.PI, 10);
  S.player._d.waterT = S.t - 6;
  run(TLV, S, 200, (c) => { c.throttle = 1; });
  assert.strictEqual(seen['player.waterEdge'].length, 2, 'again after 5 s');
  assert.strictEqual(seen['player.contact'].length, 0);
  assert.ok(seen['player.waterEdge'][0].x !== undefined && seen['player.waterEdge'][0].y !== undefined);
});

test('tlv_center: a teleport into the sea comes back to dry land', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const edge = seaEdge(TLV, W);
  TLV.player.setPose(S, edge.x - 8, edge.y, 0, 0);
  run(TLV, S, 10);
  const veh = S.vehicles[0];
  assert.notStrictEqual(TLV.world.surface.at(W, veh.x, veh.y), TLV.const.SURF.WATER);
});

test('tlv_center: player.redRun fires at a stop line on red, and not on green', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  // A straight lane that ends at a real light.
  let lane = null;
  for (const l of W.lanes) {
    if (l.len < 60 || l.conns.length === 0) continue;
    if (W.juncs[W.dirEdges[l.dirEdge].to].kind !== 'SIGNAL') continue;
    const n = l.px.length - 1;
    if (l.len - Math.hypot(l.px[n] - l.px[0], l.py[n] - l.py[0]) < 0.3) {
      lane = l;
      break;
    }
  }
  assert.ok(lane, 'a straight lane ends at a light');
  const junc = TLV.world.junctions.ahead(W, lane.id);
  const cross = (state) => {
    TLV.world.signals.force(S, junc, state, 30);
    TLV.sim.step(S);
    const seen = listen(S, ['player.redRun']);
    const at = TLV.world.lanes.pointAt(W, lane.id, lane.len - 30, {});
    clearParked(TLV, S, at.x, at.y, 40);
    TLV.player.setPose(S, at.x, at.y, at.h, 12);
    run(TLV, S, 240, (c) => { c.steer = 0; c.throttle = 0.4; });
    return seen['player.redRun'];
  };
  assert.deepStrictEqual(cross('G'), [], 'green');
  const red = cross('R');
  assert.strictEqual(red.length, 1, 'once');
  assert.strictEqual(red[0].juncId, junc);
});

test('tlv_center: crossing on green and then passing the end of another approach of that junction is not a red run', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const seen = listen(S, ['player.redRun']);
  // Two lanes end at one light, in different slots. The car crosses the first on green, then the second, within the hold.
  let pair = null;
  for (const ctrl of W.ctrls) {
    if (ctrl.slots.length < 2) continue;
    const a = W.dirEdges[ctrl.slots[0][0]].lanes[0];
    const b = W.dirEdges[ctrl.slots[1][0]].lanes[0];
    if (W.lanes[a].len > 20 && W.lanes[b].len > 20) {
      pair = { a: W.lanes[a], b: W.lanes[b], junc: ctrl.junc, conn: W.lanes[a].conns[0] };
      break;
    }
  }
  assert.ok(pair, 'a light with two approaches');
  TLV.world.signals.alignGreen(S, pair.conn, 0);
  TLV.sim.step(S);
  assert.strictEqual(TLV.world.signals.connState(S, pair.conn), TLV.const.SIG.GREEN);
  assert.strictEqual(TLV.world.signals.laneState(S, pair.b.id), TLV.const.SIG.RED);
  const drive = (lane) => {
    const n = lane.px.length - 1;
    const at = TLV.world.lanes.pointAt(W, lane.id, lane.len - 5, {});
    clearParked(TLV, S, at.x, at.y, 20);
    const d = S.player._d;
    S.vehicles[0].v = 0;
    S.vehicles[0].x = at.x;
    S.vehicles[0].y = at.y;
    S.vehicles[0].h = at.h;
    S.vehicles[0].vx = 0;
    S.vehicles[0].vy = 0;
    S.vehicles[0].px = at.x;
    S.vehicles[0].py = at.y;
    d.vh = at.h;
    d.stopLane = -1;
    void n;
    run(TLV, S, 120, (c) => { c.throttle = 0.5; c.steer = 0; });
  };
  drive(pair.a);
  assert.strictEqual(S.player._d.lineJunc, pair.junc, 'it crossed the first line');
  drive(pair.b);
  assert.deepStrictEqual(seen['player.redRun'], [], 'the second line of that junction does not count');
  S.player._d.lineT = -1;
  drive(pair.b);
  assert.strictEqual(seen['player.redRun'].length, 1, 'once the hold is over, a red line counts again');
});

test('tlv_center: driving into a one-way the wrong way raises player.wrongWay, and leaving it lowers it', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const lane = straightLane(TLV, W, 200);
  const at = TLV.world.lanes.pointAt(W, lane.id, 150, {});
  clearParked(TLV, S, at.x, at.y, 80);
  const seen = listen(S, ['player.wrongWay']);
  TLV.player.setPose(S, at.x, at.y, TLV.math.wrapPi(at.h + Math.PI), 9);
  run(TLV, S, 60, (c, s) => { c.throttle = 0.3; c.steer = Math.max(-0.2, Math.min(0.2, s.player.lat * 0.05)); });
  assert.strictEqual(S.player.wrongWay, true);
  assert.deepStrictEqual(seen['player.wrongWay'].map((e) => e.on), [true]);
  TLV.player.setPose(S, at.x, at.y, at.h, 9);
  assert.strictEqual(S.player.wrongWay, false, 'a teleport clears it');
  run(TLV, S, 60, (c) => { c.throttle = 0.3; });
  assert.strictEqual(S.player.wrongWay, false);
});

test('resolveStatic works for any body, with no contact event, and leaves a DYNAMIC car outside the wall', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const wall = openWall(TLV, W);
  const seen = listen(S, CONTACTS);
  const dt = 1 / 60;
  const body = {
    x: wall.mx + wall.nx * 0.6, y: wall.my + wall.ny * 0.6, h: Math.atan2(wall.uy, wall.ux), length: 4.4, width: 1.8,
    vx: -wall.nx * 5 + wall.ux * 5, vy: -wall.ny * 5 + wall.uy * 5
  };
  body.px = body.x + wall.nx * 0.2;
  body.py = body.y + wall.ny * 0.2;
  const out = {};
  assert.strictEqual(TLV.collide.resolveStatic(S, body, out), true);
  const side = (body.x - wall.mx) * wall.nx + (body.y - wall.my) * wall.ny;
  assert.ok(side >= 0.9 - 1e-3, `outside, at ${side}`);
  assert.ok(out.vx * wall.nx + out.vy * wall.ny >= -1e-6, 'no speed into the wall');
  assert.strictEqual(out.x, body.x);
  assert.strictEqual(out.vy, body.vy);
  assert.ok(Math.abs(out.vn - 5) < 1e-3);
  assert.strictEqual(seen['player.contact'].length, 0);

  const clear = { x: wall.mx + wall.nx * 8, y: wall.my + wall.ny * 8, h: 0, length: 4.4, width: 1.8, vx: 1, vy: 0 };
  assert.strictEqual(TLV.collide.resolveStatic(S, clear, {}), false);
  assert.strictEqual(clear.vx, 1);
  void dt;
});

test('touchingKerb reads the body against the kerb line beside a real stall', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const lane = straightLane(TLV, W, 100);
  const at = TLV.world.lanes.pointAt(W, lane.id, 50, {});
  const ids = [];
  TLV.world.parking.spotsNear(W, at.x, at.y, 200, ids);
  const spot = TLV.world.parking.spot(W, ids[0]);
  TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
  assert.strictEqual(TLV.collide.touchingKerb(S), false, 'centred');
  const side = TLV.world.parking.kerbAt(W, spot.x, spot.y, 2, {});
  assert.ok(side, 'a kerb is beside the stall');
  const toward = (d) => {
    // Try both ways: the kerb is the side that reads closer.
    const n = [-Math.sin(spot.h), Math.cos(spot.h)];
    for (const sign of [1, -1]) {
      const x = spot.x + sign * n[0] * 0.2;
      const y = spot.y + sign * n[1] * 0.2;
      const k = TLV.world.parking.kerbAt(W, x, y, 2, {});
      if (k && k.dist < side.dist) return [spot.x + sign * n[0] * d, spot.y + sign * n[1] * d];
    }
    return null;
  };
  const [x, y] = toward(0.5);
  TLV.player.setPose(S, x, y, spot.h, 0);
  assert.strictEqual(TLV.collide.touchingKerb(S), true, 'over the line');
});

test('leaning on a wall costs no speed: only a hit pays the glance share', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const wall = openWall(TLV, S.world);
  clearParked(TLV, S, wall.mx, wall.my, 40);
  const veh = S.vehicles[0];
  // Parallel to the wall, a hair off it, turned in by a fraction, so the closing speed stays under 0.5 m/s.
  const h = Math.atan2(wall.uy, wall.ux);
  TLV.player.setPose(S, wall.mx - wall.nx * 0 + wall.nx * 0.88 - wall.ux * 8, wall.my + wall.ny * 0.88 - wall.uy * 8, h, 10);
  const seen = listen(S, CONTACTS);
  const t0 = veh.vx * wall.ux + veh.vy * wall.uy;
  run(TLV, S, 30, (c) => { c.throttle = 0.3; c.steer = -0.02 * Math.sign(wall.ux * wall.ny - wall.uy * wall.nx); });
  const t1 = veh.vx * wall.ux + veh.vy * wall.uy;
  assert.strictEqual(seen['player.contact'].length, 0, 'no contact event');
  assert.ok(t1 >= t0 * 0.95, `kept ${t1} of ${t0}`);
});
