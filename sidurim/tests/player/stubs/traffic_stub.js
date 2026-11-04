// tests/player/stubs/traffic_stub.js — WP-PLAYER, test only
// A private stand-in for WP-TRAFFIC while it does not exist: real lanes, real signals, a plain car-following law, no behaviours.
// It keeps only the API that WP-PLAYER calls, with the contract's signatures, plus what a test needs to set scenes up.
(function (TLV) {
  'use strict';

  var traffic = TLV.ns('traffic');

  var A = 1.8;
  var B = 2.5;
  var S0 = 2;
  var HEADWAY = 1.2;
  var HARD = 8;

  traffic.register = function () {};

  traffic.init = function (S) {
    var target = S.params.density === null ? 60 : S.params.density;
    S.traffic = {
      stats: { count: 0, cap: target, meanSpeed: 0, stationaryShare: 0, removals: 0, wrecks: 0 },
      nextId: 1,
      impacts: [],
      target: target,
      auto: S.params.density !== 0
    };
  };

  function pose(S, v) {
    var W = S.world;
    var at = v.connId >= 0 ? TLV.world.lanes.connPointAt(W, v.connId, v.s, {}) : TLV.world.lanes.pointAt(W, v.laneId, v.s, {});
    v.x = at.x;
    v.y = at.y;
    v.h = at.h;
    v.vx = v.v * Math.cos(at.h);
    v.vy = v.v * Math.sin(at.h);
  }

  /** @returns {number} Gap to the nearest thing ahead on the same path. */
  function gapAhead(S, me) {
    var best = Infinity;
    var bestV = 0;
    for (var i = 0; i < S.vehicles.length; i++) {
      var o = S.vehicles[i];
      if (!o.active || o === me) continue;
      var on = o.isPlayer ? (me.connId < 0 && o.laneId === me.laneId) : (o.laneId === me.laneId && o.connId === me.connId);
      if (!on) continue;
      var gap = o.s - o.length / 2 - me.s - me.length / 2;
      if (gap > -me.length && gap < best) {
        best = gap;
        bestV = o.v;
      }
    }
    me._t.leadV = bestV;
    return best;
  }

  /** IDM with a free road, a leader and a stop line. */
  function accel(S, v, gap, leadV) {
    var want = (v.connId >= 0 ? S.world.conns[v.connId].vmax : S.world.lanes[v.laneId].vmax);
    var a = A * (1 - Math.pow(v.v / Math.max(want, 1), 4));
    if (gap < Infinity) {
      var star = S0 + Math.max(0, v.v * HEADWAY + v.v * (v.v - leadV) / (2 * Math.sqrt(A * B)));
      a -= A * (star / Math.max(gap, 0.3)) * (star / Math.max(gap, 0.3));
    }
    return a < -HARD ? -HARD : a;
  }

  function step(S, v, dt) {
    var W = S.world;
    if (v.mode === 'DYNAMIC') {
      v._t.dynT -= dt;
      v.x += v.vx * dt;
      v.y += v.vy * dt;
      v.vx *= 0.97;
      v.vy *= 0.97;
      v.v = Math.hypot(v.vx, v.vy);
      if (v._t.dynT <= 0) traffic.despawn(S, v, 'wreck');
      return;
    }
    if (v.mode === 'PARKED') return;
    var gap = gapAhead(S, v);
    var leadV = v._t.leadV;
    if (v.connId < 0) {
      var lane = W.lanes[v.laneId];
      var toLine = lane.len - v.s - v.length / 2 - 0.5;
      if (lane.conns.length === 0) {
        traffic.despawn(S, v, 'range');
        return;
      }
      if (v._t.next < 0) v._t.next = TLV.world.routing.randomExit(W, v.laneId, S.rng.traffic);
      if (TLV.world.signals.connState(S, v._t.next) !== TLV.const.SIG.GREEN && toLine >= -0.5 && toLine < gap) {
        gap = Math.max(toLine, 0.05);
        leadV = 0;
      }
    }
    v.accel = accel(S, v, gap, leadV);
    v.v = Math.max(0, v.v + v.accel * dt);
    v.s += v.v * dt;
    if (v.connId < 0 && v.s >= W.lanes[v.laneId].len) {
      v.s -= W.lanes[v.laneId].len;
      v.connId = v._t.next;
      v._t.next = -1;
      v.mode = 'CONN';
    } else if (v.connId >= 0 && v.s >= W.conns[v.connId].len) {
      v.s -= W.conns[v.connId].len;
      v.laneId = W.conns[v.connId].to;
      v.connId = -1;
      v.mode = 'LANE';
    }
    if (v.connId >= 0) v.laneId = W.conns[v.connId].from;
    pose(S, v);
  }

  traffic.update = function (S, dt) {
    var sum = 0;
    var still = 0;
    var n = 0;
    for (var i = 1; i < S.vehicles.length; i++) {
      var v = S.vehicles[i];
      if (!v.active) continue;
      step(S, v, dt);
      if (!v.active) continue;
      n++;
      sum += v.v;
      if (v.v < 0.5) still++;
    }
    var stats = S.traffic.stats;
    stats.count = n;
    stats.meanSpeed = n ? sum / n : 0;
    stats.stationaryShare = n ? still / n : 0;
  };

  traffic.maintain = function (S) {
    if (S.tick % 15 !== 0 || !S.traffic.auto) return;
    var W = S.world;
    var fx = S.player.fx;
    var fy = S.player.fy;
    var count = 0;
    for (var i = 1; i < S.vehicles.length; i++) {
      var v = S.vehicles[i];
      if (!v.active) continue;
      if (Math.hypot(v.x - fx, v.y - fy) > 260) traffic.despawn(S, v, 'range');
      else count++;
    }
    var lanes = new Int32Array(64);
    for (var tries = 0; tries < 8 && count < S.traffic.target; tries++) {
      var r = 60 + S.rng.spawn.next() * 170;
      var a = S.rng.spawn.next() * 2 * Math.PI;
      var n = TLV.world.lanes.lanesNear(W, fx + r * Math.cos(a), fy + r * Math.sin(a), 30, lanes);
      if (!n) continue;
      var lane = W.lanes[lanes[S.rng.spawn.int(n)]];
      if (!(lane.flags & TLV.const.LF.AI_ROUTABLE) || lane.len < 30) continue;
      if (traffic.spawn(S, { laneId: lane.id, s: lane.len * S.rng.spawn.next(), v: 3 })) count++;
    }
  };

  traffic.spawn = function (S, spec) {
    var slot = -1;
    for (var i = 1; i < S.vehicles.length && slot < 0; i++) {
      if (!S.vehicles[i].active) slot = i;
    }
    if (slot < 0) return null;
    var v = S.vehicles[slot];
    var kind = spec.kind || 'sedan';
    var size = TLV.const.VEHICLE_SIZES[kind];
    v.id = S.traffic.nextId++;
    v.active = true;
    v.kind = kind;
    v.length = size.length;
    v.width = size.width;
    v.wheelbase = size.wheelbase;
    v.mode = 'LANE';
    v.laneId = spec.laneId;
    v.connId = -1;
    v.s = spec.s;
    v.v = spec.v || 0;
    v.lat = 0;
    v.door = 0;
    v.horn = false;
    v.beh = 'CRUISE';
    v._t = { next: -1, leadV: 0, dynT: 0 };
    pose(S, v);
    v.px = v.x;
    v.py = v.y;
    v.ph = v.h;
    return v;
  };

  traffic.despawn = function (S, v) {
    v.active = false;
  };

  traffic.byId = function (S, id) {
    for (var i = 0; i < S.vehicles.length; i++) {
      if (S.vehicles[i].active && S.vehicles[i].id === id) return S.vehicles[i];
    }
    return null;
  };

  traffic.vehiclesNear = function (S, x, y, r, out) {
    var n = 0;
    for (var i = 0; i < S.vehicles.length; i++) {
      var v = S.vehicles[i];
      if (v.active && Math.hypot(v.x - x, v.y - y) <= r) out[n++] = v;
    }
    out.length = n;
    return n;
  };

  traffic.applyImpact = function (S, v, jx, jy) {
    S.traffic.impacts.push({ id: v.id, jx: jx, jy: jy });
    if (v.mode === 'PARKED') return;
    v.mode = 'DYNAMIC';
    v._t.dynT = 3;
    v.vx += jx;
    v.vy += jy;
  };
})(window.TLV);
