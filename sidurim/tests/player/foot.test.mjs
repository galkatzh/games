// tests/player/foot.test.mjs — WP-PLAYER
// ARCHITECTURE 19, WP-PLAYER items 6 and 10, against GAME_DESIGN 15.2 and 16.
import assert from 'node:assert';
import { test } from 'node:test';
import { loadTLV, makeSim, run, listen, release, openWall, clearParked, placeCar, MINI, REAL } from './helpers.mjs';

const PEOPLE_STUB = 'tests/player/stubs/peds_stub.js';
const MAPS = [['mini', MINI], ['tlv_center', REAL]];

/** Puts the player on foot on open ground in front of a real wall. */
function onFoot(map, stubs) {
  const TLV = loadTLV(map, stubs);
  const S = makeSim(TLV);
  const wall = openWall(TLV, S.world);
  clearParked(TLV, S, wall.mx, wall.my, 40);
  const x = wall.mx + wall.nx * 6;
  const y = wall.my + wall.ny * 6;
  TLV.foot.enter(S, x, y, Math.atan2(wall.uy, wall.ux));
  return { TLV, S, wall, x, y, f: S.player.foot };
}

for (const [name, map] of MAPS) {
  test(`${name}: run at 6.4 m/s, and the sim reads a world-frame vector`, () => {
    const { TLV, S, wall, f } = onFoot(map);
    assert.strictEqual(S.player.mode, 'FOOT');
    assert.strictEqual(f.active, true);
    const x0 = f.x;
    const y0 = f.y;
    run(TLV, S, 60, (c) => {
      c.footX = wall.ux;
      c.footY = wall.uy;
    });
    assert.ok(Math.abs(f.v - 6.4) < 1e-6, `v ${f.v}`);
    const moved = Math.hypot(f.x - x0, f.y - y0);
    assert.ok(moved > 5.9 && moved <= 6.4, `moved ${moved} in 1 s`);
    assert.strictEqual(f.anim, 'run');
    const h = Math.atan2(wall.uy, wall.ux);
    assert.ok(Math.abs(TLV.math.wrapPi(f.h - h)) < 0.01, 'faces the way it runs');

    // A vector over length 1 is no faster, and half a stick is half a run.
    run(TLV, S, 30, (c) => {
      c.footX = wall.ux * 3;
      c.footY = wall.uy * 3;
    });
    assert.ok(Math.abs(f.v - 6.4) < 1e-6);
    run(TLV, S, 30, (c) => {
      c.footX = wall.ux * 0.5;
      c.footY = wall.uy * 0.5;
    });
    assert.ok(Math.abs(f.v - 3.2) < 1e-6);
    release(S.controls);
    run(TLV, S, 30);
    assert.strictEqual(f.v, 0);
    assert.strictEqual(f.anim, 'idle');
    assert.strictEqual(S.player.fx, f.x);
    assert.strictEqual(S.player.fy, f.y);
  });

  test(`${name}: sidestep is 2 m in 0.3 s, with a 1 s cooldown`, () => {
    const { TLV, S, f } = onFoot(map);
    release(S.controls);
    const x0 = f.x;
    const y0 = f.y;
    const c = S.controls;
    c.sidestep = true;
    TLV.sim.step(S);
    c.sidestep = false;
    assert.strictEqual(f.anim, 'sidestep');
    run(TLV, S, 17);
    assert.ok(f.sidestepT <= 1e-9 || f.sidestepT < 1 / 60 + 1e-9, 'over in 0.3 s');
    TLV.sim.step(S);
    const d = Math.hypot(f.x - x0, f.y - y0);
    assert.ok(Math.abs(d - 2) < 0.05, `stepped ${d} m`);
    assert.ok(f.sidestepCd > 0, 'cooling down');

    const x1 = f.x;
    const y1 = f.y;
    c.sidestep = true;
    run(TLV, S, 3);
    c.sidestep = false;
    run(TLV, S, 20);
    assert.ok(Math.hypot(f.x - x1, f.y - y1) < 1e-9, 'no step in the cooldown');
    run(TLV, S, 40);
    assert.strictEqual(f.sidestepCd, 0);
    c.sidestep = true;
    TLV.sim.step(S);
    c.sidestep = false;
    assert.ok(f.sidestepT > 0, 'a new press after the cooldown');
    run(TLV, S, 20);
    assert.ok(Math.hypot(f.x - x1, f.y - y1) > 1.9, 'and it moves');
  });

  test(`${name}: a person collides with a wall and stays outside it`, () => {
    const { TLV, S, wall, f } = onFoot(map);
    const T = TLV.tune.player;
    run(TLV, S, 120, (c) => {
      c.footX = -wall.nx;
      c.footY = -wall.ny;
    });
    const off = (f.x - wall.mx) * wall.nx + (f.y - wall.my) * wall.ny;
    assert.ok(off >= T.footRadius - 0.01 && off < T.footRadius + 0.1, `stopped ${off} m off the wall`);
    assert.strictEqual(TLV.collide._inSolid(S.world, f.x, f.y), false);

    // At an angle it slides along.
    const x0 = f.x;
    const y0 = f.y;
    run(TLV, S, 30, (c) => {
      c.footX = -wall.nx * 0.6 + wall.ux * 0.8;
      c.footY = -wall.ny * 0.6 + wall.uy * 0.8;
    });
    assert.ok(Math.abs((f.x - x0) * wall.ux + (f.y - y0) * wall.uy) > 1.5, 'slides along the wall');
  });

  test(`${name}: a person collides with parked boxes, vehicles and the player's own car`, () => {
    const { TLV, S, wall, f, x, y } = onFoot(map);
    const T = TLV.tune.player;
    const ids = [];
    TLV.world.parking.spotsNear(S.world, x, y, 400, ids);
    if (ids.length) {
      const id = ids[0];
      const box = TLV.world.parking.boxOf(S.world, id, TLV.const.OCC.PARKED, {});
      clearParked(TLV, S, box.x, box.y, 12);
      TLV.world.parking.setState(S, id, TLV.const.OCC.PARKED);
      TLV.player.setPose(S, box.x + Math.cos(box.h) * -5, box.y + Math.sin(box.h) * -5, box.h, 0);
      run(TLV, S, 90, (c) => {
        c.footX = Math.cos(box.h);
        c.footY = Math.sin(box.h);
      });
      const along = (f.x - box.x) * Math.cos(box.h) + (f.y - box.y) * Math.sin(box.h);
      assert.ok(along <= -box.length / 2 - T.footRadius + 0.02, `stopped short of a parked car, at ${along}`);
    }

    const h = Math.atan2(wall.uy, wall.ux);
    const other = placeCar(TLV, S, x + wall.ux * 4, y + wall.uy * 4, h);
    TLV.player.setPose(S, x, y, h, 0);
    run(TLV, S, 60, (c) => {
      c.footX = wall.ux;
      c.footY = wall.uy;
    });
    assert.ok(!TLV.math.obbOverlap({ x: f.x, y: f.y, h, length: 0.1, width: 0.1 }, other), 'outside the vehicle');
    assert.ok((f.x - other.x) * wall.ux + (f.y - other.y) * wall.uy < -other.length / 2, 'stopped by it');
  });
}

test('tlv_center: foot.enter beside a wall ends clear of every collider', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const T = TLV.tune.player;
  const col = W.colliders;
  const ids = new Int32Array(512);
  const pr = new Int32Array(64);
  /** Asserts a person stands clear at a pose. */
  const clearAt = (x, y, label) => {
    TLV.foot.enter(S, x, y, 0);
    const f = S.player.foot;
    assert.strictEqual(TLV.collide._inSolid(W, f.x, f.y), false, `${label}: in a building at ${f.x}, ${f.y}`);
    const n = TLV.world.spatial.collidersNear(W, f.x, f.y, 3, ids);
    for (let i = 0; i < n; i++) {
      const d = TLV.math.pointSegDist(f.x, f.y, col.ax[ids[i]], col.ay[ids[i]], col.bx[ids[i]], col.by[ids[i]]);
      assert.ok(d >= T.footRadius - 1e-3, `${label}: ${d} from a wall`);
    }
    const m = TLV.world.spatial.propsNear(W, f.x, f.y, 3, pr);
    for (let i = 0; i < m; i++) {
      const prop = W.props[pr[i]];
      assert.ok(Math.hypot(prop.x - f.x, prop.y - f.y) >= T.footRadius + prop.r - 1e-3, `${label}: in a prop`);
    }
    assert.notStrictEqual(TLV.world.surface.at(W, f.x, f.y), TLV.const.SURF.WATER, `${label}: in the water`);
    assert.ok(Math.hypot(f.x - x, f.y - y) < 25, `${label}: moved ${Math.hypot(f.x - x, f.y - y)} m`);
    TLV.foot.exit(S);
  };
  // Beside walls, on walls, and deep inside buildings, all over the real map.
  const rng = TLV.rng.create(9);
  for (let k = 0; k < 400; k++) {
    const i = rng.int(col.n);
    if (col.owner[i] < 0) continue;
    const t = rng.next();
    const x = col.ax[i] + (col.bx[i] - col.ax[i]) * t;
    const y = col.ay[i] + (col.by[i] - col.ay[i]) * t;
    clearAt(x, y, 'on a wall');
    clearAt(x + rng.range(-0.3, 0.3), y + rng.range(-0.3, 0.3), 'beside a wall');
  }
  for (let k = 0; k < 40; k++) {
    const b = W.blds[rng.int(W.blds.length)];
    if (b.flags & 1) continue;
    clearAt(b.cx, b.cy, 'mid building');
  }
  for (let k = 0; k < 100; k++) {
    const p = W.props[rng.int(W.props.length)];
    clearAt(p.x, p.y, 'on a prop');
  }
});

test('foot.enter beside the car clears the car and puts the car at rest; foot.exit restores the mode', () => {
  const TLV = loadTLV(MINI);
  const S = makeSim(TLV);
  const veh = S.vehicles[0];
  TLV.player.setPose(S, -60, -298, 0, 5);
  const modes = listen(S, ['player.mode']);
  TLV.foot.enter(S, -60, -298, 0);
  assert.strictEqual(S.player.mode, 'FOOT');
  assert.strictEqual(veh.v, 0);
  const f = S.player.foot;
  const inside = Math.abs(f.x + 60) < 2 && Math.abs(f.y + 298) < 0.875;
  assert.strictEqual(inside, false, 'out of the car');
  assert.strictEqual(S.player.fx, f.x);
  const x = veh.x;
  run(TLV, S, 30);
  assert.strictEqual(veh.x, x, 'the car waits');
  TLV.foot.exit(S);
  assert.strictEqual(S.player.mode, 'DRIVE');
  assert.strictEqual(f.active, false);
  assert.strictEqual(S.player.fx, veh.x);
  assert.deepStrictEqual(modes['player.mode'].map((e) => e.mode), ['FOOT', 'DRIVE']);
});

test('foot.update brushes active S.game.obstacles: 0.4 s at half speed, once each', () => {
  const { TLV, S, wall, f, x, y } = onFoot(MINI);
  const g = S.game;
  const ahead = (d) => ({ x: x + wall.ux * d, y: y + wall.uy * d });
  g.obstacles = [
    { id: 1, kind: 'CHAIRS', ...ahead(3), r: 0.8, active: true },
    { id: 2, kind: 'LEASH', x: x + 500, y: y + 500, r: 0.8, active: true },
    { id: 3, kind: 'FALLEN_SCOOTER', ...ahead(14), r: 0.8, active: false }
  ];
  const go = (c) => {
    c.footX = wall.ux;
    c.footY = wall.uy;
  };
  let slowest = Infinity;
  let slowTicks = 0;
  run(TLV, S, 180, (c, s) => {
    go(c);
    const sf = s.player.foot;
    if (sf.slowT > 0) slowTicks++;
    slowest = Math.min(slowest, sf.slowT > 0 ? sf.v : Infinity);
  });
  assert.ok(Math.abs(slowest - 3.2) < 1e-9, `half speed, at ${slowest}`);
  assert.ok(Math.abs(slowTicks / 60 - 0.4) < 0.05, `for ${slowTicks / 60} s`);
  assert.ok(Math.abs(f.v - 6.4) < 1e-9, 'back at full speed');
  assert.ok(Math.hypot(f.x - x, f.y - y) > 15, 'and past the inactive one, no slower');
});

test('people brush the runner, the attacker does not, and nobody is hurt on foot', () => {
  const { TLV, S, wall, f, x, y } = onFoot(MINI, [PEOPLE_STUB]);
  const seen = listen(S, ['player.brushPed', 'player.hitPed']);
  const walker = TLV.peds.spawn(S, { x: x + wall.ux * 2, y: y + wall.uy * 2 });
  TLV.peds.spawn(S, { x: x + wall.ux * 8, y: y + wall.uy * 8, kind: 'attacker', state: 'SCRIPT' });
  let slowest = Infinity;
  let fast = false;
  run(TLV, S, 120, (c, sim) => {
    c.footX = wall.ux;
    c.footY = wall.uy;
    fast = fast || sim.player.foot.v >= 6.4;
    if (fast) slowest = Math.min(slowest, sim.player.foot.v);
  });
  assert.ok(Math.abs(slowest - 3.2) < 1e-9, `half speed past the walker, ${slowest}`);
  assert.strictEqual(seen['player.hitPed'].length, 0);
  assert.deepStrictEqual(seen['player.brushPed'].map((e) => e.pedId), [walker.id]);
  assert.deepStrictEqual(S.pedsys.brushes, [walker.id]);
  assert.ok(Math.hypot(f.x - x, f.y - y) > 8, 'ran on');
});

test('foot.applyHit: stumble 0.5 s, invulnerable 1.5 s, and a hit in that time does not land', () => {
  const { TLV, S, wall, f } = onFoot(MINI);
  assert.strictEqual(TLV.foot.applyHit(S), true);
  assert.strictEqual(f.stumbleT, 0.5);
  assert.strictEqual(f.invulnT, 1.5);
  assert.strictEqual(TLV.foot.applyHit(S), false, 'invulnerable');
  const x0 = f.x;
  const go = (c) => {
    c.footX = wall.ux;
    c.footY = wall.uy;
  };
  run(TLV, S, 25, go);
  assert.strictEqual(f.x, x0, 'stumbling, not moving');
  assert.strictEqual(f.anim, 'stumble');
  run(TLV, S, 15, go);
  assert.ok(f.anim === 'run' && f.v > 0, 'running again after 0.5 s');
  run(TLV, S, 40, go);
  assert.ok(f.invulnT > 0, 'still invulnerable at 1.3 s');
  run(TLV, S, 15, go);
  assert.strictEqual(f.invulnT, 0, 'over by 1.55 s');
  assert.strictEqual(TLV.foot.applyHit(S), true, 'lands again');
});

test('tlv_center: water and map bounds hold a person', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const WATER = TLV.const.SURF.WATER;
  let shore = null;
  for (let y = -1000; y < 2000 && !shore; y += 41) {
    for (let x = 0; x > -2100; x -= 2) {
      if (TLV.world.surface.at(W, x, y) === WATER) {
        if (!TLV.world.spatial.rayBlocked(W, x + 12, y, x, y)) shore = { x, y };
        break;
      }
    }
  }
  assert.ok(shore);
  TLV.foot.enter(S, shore.x + 8, shore.y, Math.PI);
  const f = S.player.foot;
  run(TLV, S, 180, (c) => { c.footX = -1; c.footY = 0; });
  assert.notStrictEqual(TLV.world.surface.at(W, f.x, f.y), WATER, 'dry');
  assert.ok(f.x > shore.x - 4, 'at the shore');
});

test('debug hooks: teleport moves whichever body is live, and setPlayerMode changes mode', () => {
  const TLV = loadTLV(MINI);
  const S = makeSim(TLV);
  TLV.debug.teleport(-60, -298, 0, 3);
  assert.strictEqual(S.vehicles[0].x, -60);
  assert.strictEqual(S.vehicles[0].v, 3);
  assert.strictEqual(TLV.debug.setPlayerMode('FOOT'), 'FOOT');
  TLV.debug.teleport(-70, -298, 1);
  assert.strictEqual(S.player.foot.x, -70);
  assert.strictEqual(S.player.foot.px, -70);
  assert.strictEqual(S.vehicles[0].x, -60, 'the car stays');
  assert.strictEqual(TLV.debug.state().player.x, -70);
  assert.strictEqual(TLV.debug.setPlayerMode('LOCKED'), 'LOCKED');
  assert.strictEqual(TLV.debug.setPlayerMode('DRIVE'), 'DRIVE');
  assert.strictEqual(TLV.debug.setPlayerMode('NONSENSE'), false);
});
