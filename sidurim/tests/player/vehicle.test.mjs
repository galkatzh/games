// tests/player/vehicle.test.mjs — WP-PLAYER
// The TLV.player API of ARCHITECTURE 12.4, the surfaces of GAME_DESIGN 4, and the slot 0 mirrors of ARCHITECTURE 10.2.
import assert from 'node:assert';
import { test } from 'node:test';
import { loadTLV, makeSim, run, listen, release, flatten, straightLane, clearParked, MINI, REAL } from './helpers.mjs';

/** A real open patch of a surface: a cell whose neighbours all read the same. */
function patchOf(TLV, W, surface) {
  const at = TLV.world.surface.at;
  for (let y = W.bounds.minY + 80; y < W.bounds.maxY - 80; y += 13) {
    for (let x = W.bounds.minX + 80; x < W.bounds.maxX - 80; x += 13) {
      let same = true;
      for (let k = -30; k <= 30 && same; k += 3) same = at(W, x + k, y) === surface;
      if (same && !TLV.world.spatial.rayBlocked(W, x - 30, y, x + 30, y)
        && !TLV.world.spatial.rayBlocked(W, x - 30, y + 2, x + 30, y + 2)
        && !TLV.world.spatial.rayBlocked(W, x - 30, y - 2, x + 30, y - 2)) {
        const props = new Int32Array(64);
        if (TLV.world.spatial.propsNear(W, x, y, 34, props) === 0) return { x, y };
      }
    }
  }
  return null;
}

test('init: slot 0 is the player, in FREE mode, on the first AI lane with no WP-GAME', () => {
  const TLV = loadTLV(MINI);
  const S = makeSim(TLV);
  const veh = S.vehicles[0];
  assert.strictEqual(S.player.veh, veh);
  assert.strictEqual(veh.id, 0);
  assert.strictEqual(veh.active, true);
  assert.strictEqual(veh.isPlayer, true);
  assert.strictEqual(veh.mode, 'FREE');
  assert.strictEqual(veh.kind, 'hatch');
  assert.strictEqual(veh.length, 4);
  assert.strictEqual(veh.width, 1.75);
  assert.strictEqual(veh.wheelbase, 2.5);
  assert.strictEqual(veh.connId, -1);
  const lane = S.world.lanes.find((l) => l.flags & TLV.const.LF.AI_ROUTABLE);
  const at = TLV.world.lanes.pointAt(S.world, lane.id, lane.len / 2, {});
  assert.ok(Math.hypot(veh.x - at.x, veh.y - at.y) < 1e-6);
  assert.strictEqual(S.player.mode, 'DRIVE');
  assert.strictEqual(S.player.foot.active, false);
  assert.strictEqual(veh.px, veh.x);
});

test('init: uses TLV.game.errands.spawnPoint when it exists', () => {
  const TLV = loadTLV(MINI);
  TLV.ns('game.errands').spawnPoint = () => ({ x: 12, y: 34, h: 1, laneId: -1, s: 0, connId: -1 });
  const S = makeSim(TLV);
  assert.strictEqual(S.vehicles[0].x, 12);
  assert.strictEqual(S.vehicles[0].y, 34);
  assert.strictEqual(S.vehicles[0].h, 1);
});

test('setPose teleports and sets the previous pose, so nothing streaks', () => {
  const TLV = loadTLV(MINI);
  const S = makeSim(TLV);
  const veh = S.vehicles[0];
  TLV.player.setPose(S, -60, -298, 0.5, 7);
  assert.strictEqual(veh.x, -60);
  assert.strictEqual(veh.px, -60);
  assert.strictEqual(veh.ph, 0.5);
  assert.strictEqual(veh.v, 7);
  assert.ok(Math.abs(veh.vx - 7 * Math.cos(0.5)) < 1e-9);
  assert.strictEqual(S.player.fx, -60);
});

test('the lane mirrors: laneId and lat follow S.player, and stop 6 m from any lane', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const veh = S.vehicles[0];
  const lane = straightLane(TLV, W, 100);
  const at = TLV.world.lanes.pointAt(W, lane.id, 50, {});
  const left = { x: at.x - Math.sin(at.h) * 0.8, y: at.y + Math.cos(at.h) * 0.8 };
  TLV.player.setPose(S, left.x, left.y, at.h, 0);
  TLV.sim.step(S);
  assert.strictEqual(S.player.laneId, lane.id);
  assert.ok(Math.abs(S.player.lat - 0.8) < 1e-3, `lat ${S.player.lat}`);
  assert.strictEqual(veh.laneId, S.player.laneId);
  assert.strictEqual(veh.lat, S.player.lat);
  assert.strictEqual(veh.connId, -1);
  assert.ok(Math.abs(veh.s - 50) < 0.1);

  TLV.player.setPose(S, W.bounds.minX + 40, W.bounds.maxY - 40, 0, 0);
  TLV.sim.step(S);
  if (TLV.world.lanes.project(W, veh.x, veh.y, null, 6, {}) === null) {
    assert.strictEqual(S.player.laneId, -1);
    assert.strictEqual(veh.laneId, -1);
  }
});

test('snapTo: a Hermite blend, ending exactly on the pose, at rest, then DRIVE or LOCKED', () => {
  const TLV = loadTLV(MINI);
  TLV.world.surface.at = () => TLV.const.SURF.ROAD;
  const S = makeSim(TLV);
  const veh = S.vehicles[0];
  const modes = listen(S, ['player.mode']);
  TLV.player.setPose(S, -60, -298, 0, 6);
  TLV.player.snapTo(S, -52, -295, 0.4, 0.6, {});
  assert.strictEqual(S.player.mode, 'SNAP');
  let far = 0;
  let last = { x: veh.x, y: veh.y };
  run(TLV, S, 34, (c, s) => {
    c.throttle = 1;
    c.steer = 1;
    const v = s.vehicles[0];
    far = Math.max(far, Math.hypot(v.x - last.x, v.y - last.y));
    last = { x: v.x, y: v.y };
  });
  assert.ok(far < 0.5, `no jump: ${far}`);
  assert.strictEqual(S.player.mode, 'SNAP', 'controls do nothing here');
  release(S.controls);
  run(TLV, S, 4);
  assert.strictEqual(S.player.mode, 'DRIVE');
  assert.strictEqual(veh.x, -52);
  assert.strictEqual(veh.y, -295);
  assert.strictEqual(veh.h, 0.4);
  assert.strictEqual(veh.v, 0);
  assert.strictEqual(veh.vx, 0);

  TLV.player.snapTo(S, -40, -295, 0, 0.5, { hold: true });
  run(TLV, S, 35);
  assert.strictEqual(S.player.mode, 'LOCKED');
  TLV.player.setLocked(S, false);
  assert.strictEqual(S.player.mode, 'DRIVE');
  assert.deepStrictEqual(modes['player.mode'].map((e) => e.mode), ['SNAP', 'DRIVE', 'SNAP', 'LOCKED', 'DRIVE']);

  TLV.player.snapTo(S, -30, -295, 0, 0, { hold: true });
  assert.strictEqual(veh.x, -30, 'a zero duration jumps');
  assert.strictEqual(veh.px, -30);
  assert.strictEqual(S.player.mode, 'LOCKED');
});

test('snapTo carries the car in at speed without overshooting a close target', () => {
  const TLV = loadTLV(MINI);
  TLV.world.surface.at = () => TLV.const.SURF.ROAD;
  const S = makeSim(TLV);
  const veh = S.vehicles[0];
  TLV.player.setPose(S, -60, -298, 0, 20);
  TLV.player.snapTo(S, -58.5, -298, 0, 1, {});
  let far = -Infinity;
  run(TLV, S, 70, (c, s) => { far = Math.max(far, s.vehicles[0].x); });
  assert.ok(far <= -58.5 + 0.25, `ran ${far + 58.5} m past the target`);
  assert.strictEqual(veh.x, -58.5);
});

test('setLocked during a snap decides how it ends', () => {
  const TLV = loadTLV(MINI);
  const S = makeSim(TLV);
  TLV.player.setPose(S, -60, -298, 0, 0);
  TLV.player.snapTo(S, -55, -298, 0, 0.5, {});
  TLV.player.setLocked(S, true);
  assert.strictEqual(S.player.mode, 'SNAP');
  run(TLV, S, 40);
  assert.strictEqual(S.player.mode, 'LOCKED');
  TLV.player.setLocked(S, false);
  TLV.player.snapTo(S, -60, -298, 0, 0.5, { hold: true });
  TLV.player.setLocked(S, false);
  run(TLV, S, 40);
  assert.strictEqual(S.player.mode, 'DRIVE');
});

test('a locked car ignores driving controls, brakes to rest and never rolls backward', () => {
  const TLV = loadTLV(MINI);
  TLV.world.surface.at = () => TLV.const.SURF.ROAD;
  const S = makeSim(TLV);
  const veh = S.vehicles[0];
  TLV.player.setPose(S, -60, -298, 0, 8);
  TLV.player.setLocked(S, true);
  assert.strictEqual(S.player.mode, 'LOCKED');
  const seen = listen(S, ['player.horn']);
  run(TLV, S, 40, (c) => {
    c.throttle = 1;
    c.steer = 1;
    c.horn = true;
    c.handbrake = true;
  });
  assert.strictEqual(veh.v, 0, 'brought to rest');
  assert.strictEqual(veh.h, 0, 'no steering');
  const x = veh.x;
  run(TLV, S, 120, (c) => {
    c.brake = 1;
  });
  assert.strictEqual(veh.x, x, 'parked');
  assert.strictEqual(seen['player.horn'].length, 0, 'no horn');
  assert.ok(veh.lights & TLV.const.VL.BRAKE);
  assert.strictEqual(TLV.player.isStopped(S), true);
});

test('isStopped and projected', () => {
  const TLV = loadTLV(MINI);
  const S = makeSim(TLV);
  TLV.player.setPose(S, -60, -298, Math.PI / 2, 0.19);
  assert.strictEqual(TLV.player.isStopped(S), true);
  TLV.player.setPose(S, -60, -298, Math.PI / 2, 5);
  assert.strictEqual(TLV.player.isStopped(S), false);
  const out = {};
  assert.strictEqual(TLV.player.projected(S, 2, out), out);
  assert.ok(Math.abs(out.x + 60) < 1e-9);
  assert.ok(Math.abs(out.y + 288) < 1e-9);
  TLV.foot.enter(S, -60, -290, 0);
  const on = TLV.player.projected(S, 1);
  assert.strictEqual(on.x, S.player.foot.x);
});

test('horn: an event on the rising edge and each second held', () => {
  const TLV = loadTLV(MINI);
  const S = makeSim(TLV);
  TLV.player.setPose(S, -60, -298, 0.2, 0);
  const seen = listen(S, ['player.horn']);
  run(TLV, S, 150, (c) => { c.horn = true; });
  assert.strictEqual(seen['player.horn'].length, 3, 'at 0, 1 and 2 s');
  assert.strictEqual(S.vehicles[0].horn, true);
  assert.strictEqual(seen['player.horn'][0].x, S.vehicles[0].x);
  assert.strictEqual(seen['player.horn'][0].h, 0.2);
  release(S.controls);
  run(TLV, S, 10);
  assert.strictEqual(S.vehicles[0].horn, false);
  run(TLV, S, 5, (c) => { c.horn = true; });
  assert.strictEqual(seen['player.horn'].length, 4, 'a new press');
});

test('Green Launch on a real light: throttle within 0.25 s of green earns +30% accel for 1.5 s, late earns nothing', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  let lane = null;
  for (const l of W.lanes) {
    if (l.len < 70 || l.conns.length === 0 || W.conns[l.conns[0]].slot < 0) continue;
    if (W.juncs[W.dirEdges[l.dirEdge].to].kind !== 'SIGNAL') continue;
    const n = l.px.length - 1;
    if (l.len - Math.hypot(l.px[n] - l.px[0], l.py[n] - l.py[0]) < 0.3) {
      lane = l;
      break;
    }
  }
  assert.ok(lane);
  const veh = S.vehicles[0];
  const conn = lane.conns[0];
  const at = TLV.world.lanes.pointAt(W, lane.id, lane.len - 40, {});
  clearParked(TLV, S, at.x, at.y, 60);
  const launch = (delayTicks) => {
    release(S.controls);
    TLV.player.setPose(S, at.x, at.y, at.h, 0);
    TLV.world.signals.alignGreen(S, conn, 1);
    const seen = listen(S, ['player.launch']);
    run(TLV, S, 30);
    let green = 0;
    for (let i = 0; i < 90 && !green; i++) {
      TLV.sim.step(S);
      if (TLV.world.signals.connState(S, conn) === TLV.const.SIG.GREEN) green = 1;
    }
    assert.strictEqual(green, 1, 'it went green');
    run(TLV, S, delayTicks);
    run(TLV, S, 3, (c) => { c.throttle = 1; });
    return seen['player.launch'].length;
  };
  assert.strictEqual(launch(6), 1, 'inside the window');
  assert.ok(S.player.launchT > 1.3, `boost running, ${S.player.launchT}`);
  const v0 = veh.v;
  TLV.sim.step(S);
  const a = (veh.v - v0) * 60;
  assert.ok(Math.abs(a - 7.5 * 1.3 * (1 - v0 / 29)) < 0.1, `boosted accel ${a}`);
  run(TLV, S, 100, (c) => { c.throttle = 1; });
  assert.strictEqual(S.player.launchT, 0, 'gone after 1.5 s');
  assert.strictEqual(launch(30), 0, 'after 0.25 s it is too late');
});

test('tlv_center: sidewalk or park caps at 14 m/s and sand at 8, by the real surface raster', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const SURF = TLV.const.SURF;
  const veh = S.vehicles[0];
  const seen = listen(S, ['player.surface']);
  const check = (surface, cap) => {
    const patch = patchOf(TLV, W, surface);
    assert.ok(patch, `a real patch of surface ${surface}`);
    clearParked(TLV, S, patch.x, patch.y, 50);
    TLV.player.setPose(S, patch.x - 26, patch.y, 0, 0);
    let peak = 0;
    run(TLV, S, 220, (c, s) => {
      c.throttle = 1;
      peak = Math.max(peak, s.vehicles[0].v);
    });
    assert.ok(peak <= cap + 0.05, `peak ${peak} on surface ${surface}`);
    assert.ok(peak >= cap - 0.5, `reached the cap, ${peak}`);
    assert.strictEqual(S.player.surface, surface);
    // Coming on fast, the cap takes speed off, it does not stop the car dead.
    TLV.player.setPose(S, patch.x - 26, patch.y, 0, 26);
    S.player._d.surfT = 0;
    run(TLV, S, 3);
    assert.ok(veh.v > 24, `no wall at the edge of the cap, ${veh.v}`);
    run(TLV, S, 100, (c) => { c.throttle = 1; });
    assert.ok(veh.v <= cap + 0.3, `shed to ${veh.v}`);
    release(S.controls);
  };
  check(SURF.SIDEWALK, 14);
  check(SURF.SAND, 8);
  assert.ok(seen['player.surface'].length >= 0);
});

test('a surface must hold 0.12 s to count, so a gap in the road mask does not cap the car', () => {
  const TLV = loadTLV(MINI);
  const SURF = TLV.const.SURF;
  let under = SURF.ROAD;
  TLV.world.surface.at = () => under;
  TLV.world.spatial.collidersNear = () => 0;
  const S = makeSim(TLV);
  const veh = S.vehicles[0];
  const seen = listen(S, ['player.surface']);
  TLV.player.setPose(S, 0, 0, 0, 20);
  under = SURF.SIDEWALK;
  run(TLV, S, 4, (c) => { c.throttle = 1; });
  under = SURF.ROAD;
  run(TLV, S, 4, (c) => { c.throttle = 1; });
  assert.strictEqual(seen['player.surface'].length, 0);
  assert.ok(veh.v > 20, 'no speed lost');
  under = SURF.SIDEWALK;
  run(TLV, S, 12, (c) => { c.throttle = 1; });
  assert.deepStrictEqual(seen['player.surface'].map((e) => e.surface), [SURF.SIDEWALK]);
  assert.strictEqual(S.player.surface, SURF.SIDEWALK);
});

test('lights: brake, reverse and hazard', () => {
  const TLV = loadTLV(MINI);
  flatten(TLV);
  const S = makeSim(TLV);
  const veh = S.vehicles[0];
  const VL = TLV.const.VL;
  TLV.player.setPose(S, 0, 0, 0, 10);
  run(TLV, S, 2, (c) => { c.brake = 1; });
  assert.ok(veh.lights & VL.BRAKE);
  release(S.controls);
  run(TLV, S, 2, (c) => { c.hazard = true; });
  assert.ok(veh.lights & VL.HAZARD);
  assert.ok(!(veh.lights & VL.BRAKE));
  assert.ok(veh.accel < 0, 'accel is read back');
});

test('player.init is deterministic, and two sims keep separate state', () => {
  const TLV = loadTLV(MINI);
  flatten(TLV);
  const A = makeSim(TLV);
  const B = makeSim(TLV);
  TLV.player.setPose(A, 0, 0, 0, 5);
  TLV.player.setPose(B, 0, 0, 0, 5);
  run(TLV, A, 60, (c) => { c.throttle = 1; c.steer = 0.4; });
  run(TLV, B, 60, (c) => { c.throttle = 1; c.steer = 0.4; });
  assert.strictEqual(A.vehicles[0].x, B.vehicles[0].x);
  assert.strictEqual(A.vehicles[0].h, B.vehicles[0].h);
  assert.notStrictEqual(A.player._c, B.player._c);
  assert.notStrictEqual(A.player._d, B.player._d);
});

test('no sim-tick allocation grows without bound in a long drive', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV, { params: { autoplay: 'patrol' } });
  run(TLV, S, 1200);
  const before = S.player._c.spots.length;
  run(TLV, S, 6000);
  assert.ok(S.player._c.spots.length <= before + 64, 'scratch stays small');
});
