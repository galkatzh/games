// tests/player/handling.test.mjs — WP-PLAYER
// ARCHITECTURE 19, WP-PLAYER item 1, against GAME_DESIGN 4. Each number is measured twice: on an empty road, where the model
// shows nothing but itself, and on a real straight of tlv_center, on real surfaces and with real signals running.
import assert from 'node:assert';
import { test } from 'node:test';
import { loadTLV, makeSim, run, release, flatten, straightLane, holdLane, clearParked, openRoad, MINI, REAL } from './helpers.mjs';

const KMH60 = 60 / 3.6;

/** Fits a circle to points, by least squares. */
function circleFit(points) {
  let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0; let sxz = 0; let syz = 0; let sz = 0;
  for (const [x, y] of points) {
    const z = x * x + y * y;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; sxz += x * z; syz += y * z; sz += z;
  }
  const m = [[sxx, sxy, sx, sxz], [sxy, syy, sy, syz], [sx, sy, points.length, sz]];
  for (let i = 0; i < 3; i++) {
    let p = i;
    for (let j = i + 1; j < 3; j++) if (Math.abs(m[j][i]) > Math.abs(m[p][i])) p = j;
    [m[i], m[p]] = [m[p], m[i]];
    for (let j = 0; j < 3; j++) {
      if (j === i) continue;
      const f = m[j][i] / m[i][i];
      for (let k = i; k < 4; k++) m[j][k] -= f * m[i][k];
    }
  }
  const a = m[0][3] / m[0][0];
  const b = m[1][3] / m[1][1];
  const c = m[2][3] / m[2][2];
  return Math.sqrt(c + a * a / 4 + b * b / 4);
}

/** A sim on an empty road, with a car at rest at the origin of the plane. */
function emptyRoad() {
  const TLV = loadTLV(MINI);
  flatten(TLV);
  const S = makeSim(TLV);
  TLV.player.setPose(S, 0, 0, 0, 0);
  return { TLV, S };
}

/** Accelerates, then brakes at the top, reporting what the car did. keep steers. */
function sprint(TLV, S, keep) {
  const veh = S.vehicles[0];
  const out = { t60: null, tTop: null, dTop: null, top: 0 };
  const x0 = veh.x;
  const y0 = veh.y;
  let t = 0;
  for (let i = 0; i < 660 && out.tTop === null; i++) {
    S.controls.throttle = 1;
    if (keep) keep(S, S.controls);
    TLV.sim.step(S);
    t += 1 / 60;
    if (out.t60 === null && veh.v >= KMH60) out.t60 = t;
    if (veh.v > out.top) out.top = veh.v;
    if (out.tTop === null && veh.v >= 26.4 - 1e-9) {
      out.tTop = t;
      out.dTop = Math.hypot(veh.x - x0, veh.y - y0);
    }
  }
  return out;
}

/** Brakes to rest. */
function stop(TLV, S, keep) {
  const veh = S.vehicles[0];
  const x0 = veh.x;
  const y0 = veh.y;
  let t = 0;
  while (veh.v > 0.01 && t < 6) {
    release(S.controls);
    S.controls.brake = 1;
    if (keep) keep(S, S.controls);
    TLV.sim.step(S);
    t += 1 / 60;
  }
  return { d: Math.hypot(veh.x - x0, veh.y - y0), t };
}

test('0-60 km/h, top speed and the brake on an empty road', () => {
  const { TLV, S } = emptyRoad();
  const r = sprint(TLV, S);
  assert.ok(Math.abs(r.t60 - 3.3) <= 0.2, `0-60 in ${r.t60}`);
  assert.ok(Math.abs(r.top - 26.4) <= 0.2, `top ${r.top}`);
  assert.ok(Math.abs(r.tTop - 9.3) <= 0.3, `top in ${r.tTop}`);
  assert.ok(Math.abs(r.dTop - 168) <= 5, `top after ${r.dTop} m`);
  run(TLV, S, 120, (c) => { c.throttle = 1; });
  assert.ok(Math.abs(S.vehicles[0].v - 26.4) <= 0.2, 'top speed holds');
  const b = stop(TLV, S);
  assert.ok(Math.abs(b.d - 25) <= 2, `brake from top in ${b.d} m`);
  assert.ok(Math.abs(b.t - 1.9) <= 0.15, `brake from top in ${b.t} s`);
});

test('min radius at top speed, by a circle fit over two laps of the empty road', () => {
  const { TLV, S } = emptyRoad();
  TLV.player.setPose(S, 0, 0, 0, 26.4);
  const pts = [];
  run(TLV, S, 840, (c, s, i) => {
    c.throttle = 1;
    c.steer = 1;
    if (i > 120) pts.push([s.vehicles[0].x, s.vehicles[0].y]);
  });
  const r = circleFit(pts);
  assert.ok(Math.abs(r - 63) <= 5, `radius ${r}`);
  assert.ok(Math.abs(S.vehicles[0].v - 26.4) <= 0.2, 'speed holds through the corner');
  assert.ok(Math.abs(Math.abs(S.vehicles[0].yawRate) - 11 / 26.4) < 0.01, 'grip is the limit');
});

test('grip caps lateral acceleration at 11 m/s² at 12 m/s, 53 deg/s', () => {
  const { TLV, S } = emptyRoad();
  TLV.player.setPose(S, 0, 0, 0, 12);
  run(TLV, S, 90, (c, s) => {
    c.steer = 1;
    c.throttle = (12 - s.vehicles[0].v) * 2 + 0.17;
  });
  const veh = S.vehicles[0];
  assert.ok(Math.abs(veh.v - 12) < 0.05, `held at ${veh.v}`);
  const yaw = Math.abs(veh.yawRate) * 180 / Math.PI;
  assert.ok(Math.abs(yaw - 52.5) <= 1, `yaw ${yaw} deg/s`);
  assert.ok(Math.abs(Math.abs(veh.yawRate) * veh.v - 11) < 0.1, 'lateral 11 m/s²');
});

test('steering range and timing', () => {
  const { TLV, S } = emptyRoad();
  const T = TLV.tune.player;
  const max = (v) => TLV.player._steerMax(v) * 180 / Math.PI;
  assert.ok(Math.abs(max(0) - 34) < 1e-9);
  assert.ok(Math.abs(max(26) - 6) < 1e-9);
  assert.ok(Math.abs(max(40) - 6) < 1e-9, 'held past the reference speed');
  assert.ok(max(13) < 34 && max(13) > 6);

  TLV.player.setPose(S, 0, 0, 0, 0);
  S.controls.steer = 1;
  TLV.sim.step(S);
  const after = (ticks) => { run(TLV, S, ticks); return S.player._d.steerN; };
  assert.ok(after(Math.round(T.steerAttackS * 60) - 2) < 1, 'not there before the attack time');
  assert.strictEqual(after(3), 1, 'there by the attack time');
  S.controls.steer = 0;
  TLV.sim.step(S);
  assert.ok(after(Math.round(T.steerReturnS * 60) - 2) > 0, 'not back before the return time');
  assert.strictEqual(after(3), 0, 'back by the return time');
});

test('90 deg handbrake turn at 16 m/s', () => {
  const { TLV, S } = emptyRoad();
  TLV.player.setPose(S, 0, 0, 0, 16);
  const veh = S.vehicles[0];
  let t = 0;
  while (veh.h < Math.PI / 2 && t < 2) {
    S.controls.steer = 1;
    S.controls.handbrake = true;
    TLV.sim.step(S);
    t += 1 / 60;
  }
  assert.ok(Math.abs(t - 0.7) <= 0.2, `90 deg in ${t}`);
  assert.ok(Math.abs(veh.v - (16 - 2 * t)) < 0.1, `loses 2 m/s², at ${veh.v}`);
  assert.ok(Math.abs(veh.yawRate) <= 2.2 + 1e-9, 'yaw cap');
  const slip = Math.abs(TLV.math.wrapPi(veh.h - Math.atan2(veh.vy, veh.vx)));
  assert.ok(slip > 0.5, `the car is sliding, ${slip} rad`);

  // The 0.25 s recovery hands the velocity back to the nose, and the car comes out of the slide.
  run(TLV, S, 30, (c) => {
    release(c);
    c.throttle = 0.4;
  });
  assert.ok(Math.abs(TLV.math.wrapPi(veh.h - Math.atan2(veh.vy, veh.vx))) < 0.08, 'recovered');
});

test('reverse: the brake stops the car first, then backs it up, to 6 m/s at most', () => {
  const { TLV, S } = emptyRoad();
  const veh = S.vehicles[0];
  TLV.player.setPose(S, 0, 0, 0, 5);
  run(TLV, S, 30, (c) => { c.brake = 1; });
  assert.strictEqual(veh.v, 0, 'held at rest through the delay');
  run(TLV, S, 12, (c) => { c.brake = 1; });
  assert.ok(veh.v < 0, 'reversing');
  run(TLV, S, 300, (c) => { c.brake = 1; });
  assert.ok(Math.abs(veh.v + 6) < 1e-9, `reverse ${veh.v}`);
  assert.ok(veh.lights & TLV.const.VL.REVERSE, 'reverse lights');
  release(S.controls);
  run(TLV, S, 30, (c) => { c.throttle = 1; });
  assert.ok(veh.v > 0, 'throttle takes it forward again');
});

test('coast drag is 0.8 m/s², and a car at rest stays at rest', () => {
  const { TLV, S } = emptyRoad();
  const veh = S.vehicles[0];
  TLV.player.setPose(S, 0, 0, 0, 10);
  run(TLV, S, 60);
  assert.ok(Math.abs(veh.v - 9.2) < 0.02, `coasted to ${veh.v}`);
  run(TLV, S, 900);
  assert.strictEqual(veh.v, 0);
});

test('the handling numbers hold on the real map, on a real straight', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const lane = straightLane(TLV, W, 230);
  assert.ok(lane, 'tlv_center has a straight of 230 m');
  const at = TLV.world.lanes.pointAt(W, lane.id, 4, {});
  TLV.player.setPose(S, at.x, at.y, at.h, 0);
  const keep = (s, c) => holdLane(s, c);
  const r = sprint(TLV, S, keep);
  const b = stop(TLV, S, keep);
  console.log(`      real straight lane ${lane.id}, ${W.edges[lane.edge].nameEn}, ${lane.len.toFixed(0)} m: ` +
    `0-60 ${r.t60.toFixed(2)} s, top ${r.top.toFixed(2)} m/s, brake ${b.d.toFixed(1)} m`);
  assert.ok(Math.abs(r.t60 - 3.3) <= 0.2, `0-60 in ${r.t60}`);
  assert.ok(Math.abs(r.top - 26.4) <= 0.2, `top ${r.top}`);
  assert.ok(Math.abs(b.d - 25) <= 2, `brake from top in ${b.d} m`);
  assert.strictEqual(S.player.surface, TLV.const.SURF.ROAD);
  assert.ok(Math.abs(S.player.lat) < 1, 'still in the lane');
});

test('min radius and the handbrake on the real map, on the same straight', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const lane = straightLane(TLV, W, 230);
  const at = TLV.world.lanes.pointAt(W, lane.id, 60, {});
  clearParked(TLV, S, at.x, at.y, 60);
  TLV.player.setPose(S, at.x, at.y, at.h, 26.4);
  const veh = S.vehicles[0];
  const pts = [];
  run(TLV, S, 42, (c, s, i) => {
    c.throttle = 1;
    c.steer = 1;
    if (i >= 18) pts.push([s.vehicles[0].x, s.vehicles[0].y]);
  });
  const r = circleFit(pts);
  assert.ok(Math.abs(r - 63) <= 5, `radius on a real road ${r}`);

  // A slide wider than a side street needs a real wide road.
  const wide = openRoad(TLV, W, 14);
  assert.ok(wide, 'tlv_center has a road 28 m wide somewhere');
  clearParked(TLV, S, wide.x, wide.y, 40);
  TLV.player.setPose(S, wide.x, wide.y, wide.h, 16);
  const h0 = veh.h;
  let t = 0;
  while (Math.abs(TLV.math.wrapPi(veh.h - h0)) < Math.PI / 2 && t < 2) {
    S.controls.throttle = 0;
    S.controls.steer = 1;
    S.controls.handbrake = true;
    TLV.sim.step(S);
    t += 1 / 60;
  }
  console.log(`      real road ${wide.lane.id}, ${W.edges[wide.lane.edge].nameEn}: radius ${r.toFixed(1)} m, 90 deg in ${t.toFixed(2)} s`);
  assert.ok(Math.abs(t - 0.7) <= 0.2, `90 deg in ${t} on a real road`);
});
