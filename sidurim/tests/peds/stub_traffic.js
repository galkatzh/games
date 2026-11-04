// tests/peds/stub_traffic.js — WP-PEDS test support, never shipped.
// A small stand-in for WP-TRAFFIC, loaded after the sim files, so people can be tested against real lanes and real signals with cars
// that obey only what ARCHITECTURE 12.5 promises. It sees people through obstaclesOnLane and zoneOccupied and nothing else, so what
// these tests prove is that those two are enough. It stops at the lane end, nose on the line, the worst case for a crossing there.
(function (TLV) {
  'use strict';

  var traffic = TLV.ns('traffic');

  var S0 = 1.5;
  var HW = 1.4;
  var HARD = 8;
  var COMFORT = 2.5;
  var ACCEL = 1.8;
  /** Long bodies last, so a run can leave them out. */
  var CARS = [['sedan', 60], ['hatch', 20], ['taxi', 8], ['van', 8], ['truck', 2], ['bus', 2]];

  /** Picks a body by weight. */
  function pickKind(rng, noLong) {
    var u = rng.next() * (noLong ? 96 : 100);
    for (var i = 0; i < CARS.length; i++) {
      u -= CARS[i][1];
      if (u < 0) return CARS[i][0];
    }
    return 'sedan';
  }

  traffic.init = function (S) {
    S.traffic = {
      target: S.params.density !== null ? S.params.density : 60, redRun: 0, radius: 240,
      stats: { count: 0, cap: 0, meanSpeed: 0, stationaryShare: 0, removals: 0, wrecks: 0 },
      obs: [], nextId: 1, zoneStops: 0, personStops: 0, redRuns: 0, noLong: false
    };
  };

  /** Places a car on a lane. */
  function place(S, v, laneId, s, speed) {
    var W = S.world;
    var size = TLV.const.VEHICLE_SIZES[v.kind];
    var at = TLV.world.lanes.pointAt(W, laneId, s, {});
    v.mode = 'LANE';
    v.laneId = laneId;
    v.connId = -1;
    v.s = s;
    v.lat = 0;
    v.v = speed;
    v.x = at.x;
    v.y = at.y;
    v.h = at.h;
    v.px = at.x;
    v.py = at.y;
    v.ph = at.h;
    v.vx = Math.cos(at.h) * speed;
    v.vy = Math.sin(at.h) * speed;
    v.length = size.length;
    v.width = size.width;
    v.wheelbase = size.wheelbase;
    v._t.next = -1;
    v._t.redRun = false;
  }

  /**
   * Adds one car.
   * @returns {?object} Vehicle.
   */
  traffic.spawn = function (S, spec) {
    for (var i = 1; i < S.vehicles.length; i++) {
      var v = S.vehicles[i];
      if (v.active) continue;
      v.active = true;
      v.id = S.traffic.nextId++;
      v.kind = spec.kind || pickKind(S.rng.spawn, S.traffic.noLong);
      v.isPlayer = false;
      v.beh = 'CRUISE';
      place(S, v, spec.laneId, spec.s, spec.v || 0);
      return v;
    }
    return null;
  };

  traffic.despawn = function (S, v) {
    v.active = false;
  };

  /** The connector this car will take from its lane. */
  function nextConn(S, v) {
    var t = v._t;
    if (t.next < 0) t.next = TLV.world.routing.randomExit(S.world, v.laneId, S.rng.traffic);
    return t.next;
  }

  /** Metres from the nose to the nearest thing to stop for, on the lane and past its end. */
  function stopGap(S, v, out) {
    var W = S.world;
    var T = S.traffic;
    var half = v.length / 2;
    var best = Infinity;
    var bestV = 0;
    var person = false;
    function note(gap, sp, isPerson) {
      if (gap < best) {
        best = gap;
        bestV = sp;
        person = isPerson;
      }
    }
    var lane;
    var from;
    var base;
    var conn = -1;
    if (v.mode === 'LANE') {
      lane = W.lanes[v.laneId];
      from = v.s;
      base = 0;
      conn = nextConn(S, v);
    } else {
      var c = W.conns[v.connId];
      lane = W.lanes[c.to];
      from = -1e9;
      base = c.len - v.s;
    }
    for (var round = 0; round < 2 && lane; round++) {
      var n = TLV.peds.obstaclesOnLane(S, lane.id, T.obs);
      var at = from > -1e8 ? from : 0;
      for (var i = 0; i < n; i++) {
        var o = T.obs[i];
        if (o.s + o.halfLen < (from > -1e8 ? from - half : -1e9)) continue;
        note(base + o.s - o.halfLen - at - half, 0, true);
      }
      for (var z = 0; z < lane.zones.length; z++) {
        var zone = W.zones[lane.zones[z]];
        var gap = base + zone.s0 - at - half;
        if (gap >= 0 && TLV.peds.zoneOccupied(S, zone.id)) {
          note(gap, 0, true);
          T.zoneStops++;
        }
      }
      for (var k = 1; k < S.vehicles.length; k++) {
        var o2 = S.vehicles[k];
        if (!o2.active || o2 === v || o2.mode !== 'LANE' || o2.laneId !== lane.id) continue;
        if (from > -1e8 && o2.s <= v.s) continue;
        note(base + o2.s - o2.length / 2 - at - half, o2.v, false);
      }
      if (round > 0 || conn < 0) break;
      var cn = W.conns[conn];
      if (v.mode === 'LANE') {
        var left = lane.len - v.s;
        if (!v._t.redRun && TLV.world.signals.connState(S, conn) !== TLV.const.SIG.GREEN) {
          if (TLV.world.signals.connState(S, conn) === TLV.const.SIG.RED && S.traffic.redRun > 0 && S.rng.traffic.bool(S.traffic.redRun)) {
            v._t.redRun = true;
            S.traffic.redRuns++;
          } else {
            note(left - half, 0, false);
          }
        }
        base = left + cn.len;
        lane = W.lanes[cn.to];
        from = -1e9;
      } else {
        break;
      }
    }
    out.gap = best;
    out.v = bestV;
    out.person = person;
  }

  var gapOut = { gap: 0, v: 0, person: false };

  /** IDM with a hard floor, plus the hard brake for people (ARCHITECTURE 12.5). */
  function accelOf(v, v0, gap, lead, person) {
    var ratio = v / Math.max(0.1, v0);
    var free = ACCEL * (1 - ratio * ratio * ratio * ratio);
    if (gap === Infinity) return free;
    if (gap <= 0) return -HARD;
    var dv = v - lead;
    var star = S0 + Math.max(0, v * HW + v * dv / (2 * Math.sqrt(ACCEL * COMFORT)));
    var a = free - ACCEL * (star / gap) * (star / gap);
    if (person && v > 0.3 && gap / v < Math.max(0.8, v / 16 + 0.25)) a = -HARD;
    return Math.max(-HARD, a);
  }

  traffic.update = function (S, dt) {
    var W = S.world;
    var sum = 0;
    var still = 0;
    var count = 0;
    for (var i = 1; i < S.vehicles.length; i++) {
      var v = S.vehicles[i];
      if (!v.active) continue;
      count++;
      stopGap(S, v, gapOut);
      var v0 = v.mode === 'LANE' ? W.lanes[v.laneId].vmax : W.conns[v.connId].vmax;
      // Slows for a corner before reaching it, as a driver does, so a short connector is not taken at lane speed.
      if (v.mode === 'LANE' && v._t.next >= 0) {
        var left = W.lanes[v.laneId].len - v.s;
        var corner = W.conns[v._t.next].vmax;
        if (corner < v0 && v.v * v.v - corner * corner > 2 * COMFORT * (left - v.length / 2)) v0 = corner;
      }
      if (gapOut.person && gapOut.gap < 40) S.traffic.personStops++;
      var a = accelOf(v.v, v0, gapOut.gap, gapOut.v, gapOut.person);
      v.accel = a;
      v.v = Math.max(0, v.v + a * dt);
      v.s += v.v * dt;
      if (v.mode === 'LANE') {
        var lane = W.lanes[v.laneId];
        if (v.s > lane.len) {
          var c = nextConn(S, v);
          if (c < 0) {
            v.active = false;
            count--;
            continue;
          }
          v.s -= lane.len;
          v.mode = 'CONN';
          v.connId = c;
          v.laneId = -1;
          v._t.next = -1;
          v._t.redRun = false;
        }
      }
      if (v.mode === 'CONN') {
        var cn = W.conns[v.connId];
        if (v.s > cn.len) {
          v.s -= cn.len;
          v.mode = 'LANE';
          v.laneId = cn.to;
          v.connId = -1;
        }
      }
      var at = v.mode === 'LANE' ? TLV.world.lanes.pointAt(W, v.laneId, v.s, stubAt) : TLV.world.lanes.connPointAt(W, v.connId, v.s, stubAt);
      v.yawRate = TLV.math.wrapPi(at.h - v.h) / dt;
      v.x = at.x;
      v.y = at.y;
      v.h = at.h;
      v.vx = Math.cos(at.h) * v.v;
      v.vy = Math.sin(at.h) * v.v;
      sum += v.v;
      if (v.v < 0.2) still++;
    }
    var st = S.traffic.stats;
    st.count = count;
    st.meanSpeed = count ? sum / count : 0;
    st.stationaryShare = count ? still / count : 0;
  };
  var stubAt = { x: 0, y: 0, h: 0 };

  traffic.maintain = function (S) {
    if (S.tick % 15 !== 0) return;
    var W = S.world;
    var T = S.traffic;
    var fx = S.player.fx;
    var fy = S.player.fy;
    var r2 = T.radius * T.radius * 1.4;
    var n = 0;
    for (var i = 1; i < S.vehicles.length; i++) {
      var v = S.vehicles[i];
      if (!v.active) continue;
      var dx = v.x - fx;
      var dy = v.y - fy;
      if (dx * dx + dy * dy > r2) v.active = false;
      else n++;
    }
    var rng = S.rng.spawn;
    for (var t = 0; t < 40 && n < T.target; t++) {
      var a = rng.range(0, Math.PI * 2);
      var r = S.tick < 30 ? rng.range(20, T.radius) : rng.range(140, T.radius);
      var near = TLV.world.lanes.project(W, fx + Math.cos(a) * r, fy + Math.sin(a) * r, null, 40);
      if (!near) continue;
      var lane = W.lanes[near.laneId];
      if (!(lane.flags & TLV.const.LF.AI_ROUTABLE) || lane.len < 12) continue;
      var clash = false;
      for (var k = 1; k < S.vehicles.length && !clash; k++) {
        var o = S.vehicles[k];
        if (o.active && o.laneId === lane.id && Math.abs(o.s - near.s) < 14) clash = true;
      }
      if (clash) continue;
      if (traffic.spawn(S, { laneId: lane.id, s: TLV.math.clamp(near.s, 6, lane.len - 6), v: 4 })) n++;
    }
  };

  traffic.vehiclesNear = function (S, x, y, r, out) {
    var n = 0;
    var r2 = r * r;
    for (var i = 0; i < S.vehicles.length; i++) {
      var v = S.vehicles[i];
      if (!v.active) continue;
      var dx = v.x - x;
      var dy = v.y - y;
      if (dx * dx + dy * dy <= r2) out[n++] = v;
    }
    return n;
  };
})(window.TLV);
