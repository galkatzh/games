// tests/traffic/stubs/player_stub.js — WP-TRAFFIC
// A stand-in for WP-PLAYER, for soak and tests while that package does not exist. It covers just the contract that traffic reads:
// S.player, slot 0, TLV.player.setPose and the idle, patrol and chaos bots. patrol is a kinematic car that keeps to lanes, stops
// on red and behind the car ahead. chaos drives anywhere and teleports. It proves traffic, never the player.
(function (TLV) {
  'use strict';

  var player = TLV.ns('player');
  var bots = TLV.ns('bots');

  /** A central street, so a run starts where the contract's spawn does, near King George at HaNeviim. */
  var START = { x: -62, y: 139 };

  player.register = function () {};

  function fill(S) {
    var veh = S.vehicles[0];
    var size = TLV.const.VEHICLE_SIZES.hatch;
    veh.id = 0;
    veh.active = true;
    veh.isPlayer = true;
    veh.mode = 'FREE';
    veh.kind = 'hatch';
    veh.length = size.length;
    veh.width = size.width;
    veh.wheelbase = size.wheelbase;
    S.player = {
      mode: 'DRIVE', veh: veh, fx: 0, fy: 0, surface: 0, laneId: -1, lat: 0, wrongWay: false, launchT: 0,
      foot: { active: false, x: 0, y: 0, h: 0, v: 0, px: 0, py: 0, ph: 0, stumbleT: 0, invulnT: 0, slowT: 0, sidestepT: 0, sidestepCd: 0, anim: 'idle' }
    };
  }

  /** Nearest lane to the car, into S.player. */
  function locate(S) {
    var veh = S.vehicles[0];
    var near = TLV.world.lanes.project(S.world, veh.x, veh.y, veh.h, 6, S._stubProj);
    S.player.fx = veh.x;
    S.player.fy = veh.y;
    S.player.laneId = near ? near.laneId : -1;
    S.player.lat = near ? near.lat : 0;
    veh.laneId = S.player.laneId;
    veh.lat = S.player.lat;
    veh.connId = -1;
  }

  player.setPose = function (S, x, y, h, v) {
    var veh = S.vehicles[0];
    veh.x = x;
    veh.y = y;
    veh.h = h;
    veh.px = x;
    veh.py = y;
    veh.ph = h;
    veh.v = v || 0;
    veh.vx = veh.v * Math.cos(h);
    veh.vy = veh.v * Math.sin(h);
    if (S._stubBot) S._stubBot.laneId = -1;
    locate(S);
  };

  player.init = function (S) {
    S._stubProj = {};
    fill(S);
    if (!S.world) return;
    var near = TLV.world.lanes._nearest(S.world, START.x, START.y, null, 200, true, {});
    if (near) {
      var at = TLV.world.lanes.pointAt(S.world, near.laneId, near.s, {});
      player.setPose(S, at.x, at.y, at.h, 0);
    }
  };

  /** Follows lanes as a plain, law-abiding car. */
  function patrolStep(S, dt) {
    var W = S.world;
    var veh = S.vehicles[0];
    var b = S._stubBot;
    if (b.laneId < 0) {
      var near = TLV.world.lanes._nearest(W, veh.x, veh.y, veh.h, 60, true, {});
      if (!near) return;
      b.laneId = near.laneId;
      b.s = near.s;
      b.connId = -1;
      b.next = TLV.world.routing.randomExit(W, b.laneId, S.rng.bot);
    }
    var at = {};
    var len = b.connId >= 0 ? W.conns[b.connId].len : W.lanes[b.laneId].len;
    var limit = b.connId >= 0 ? W.conns[b.connId].vmax : W.lanes[b.laneId].vmax;
    var left = len - b.s;
    var v = veh.v;
    var a = 2.5 * (1 - Math.pow(v / Math.max(0.5, limit), 4));
    var lead = TLV.traffic.leadOn(S, b.laneId, b.s, 60);
    if (b.connId < 0 && lead) {
      var gap = lead.s - lead.length / 2 - b.s - 2;
      var star = 2 + Math.max(0, v * 1.2 + v * (v - lead.v) / 5.5);
      a -= 2.5 * Math.pow(star / Math.max(0.2, gap), 2);
    }
    if (b.connId < 0 && b.next >= 0) {
      var red = TLV.world.signals.connState(S, b.next) !== TLV.const.SIG.GREEN;
      if (red && left > 1 && left < 60) {
        var star2 = 1.5 + Math.max(0, v * 1.0 + v * v / 5.5);
        a = Math.min(a, 2.5 * (1 - Math.pow(star2 / Math.max(0.2, left - 3), 2)));
      }
      if (red && left <= 3.5) { v = 0; a = 0; }
    }
    if (b.next < 0 && b.connId < 0 && left < 8) a = -4;
    v = Math.max(0, v + Math.max(-8, Math.min(2.5, a)) * dt);
    veh.v = v;
    b.s += v * dt;
    if (b.s >= len) {
      if (b.connId >= 0) {
        b.laneId = W.conns[b.connId].to;
        b.s -= len;
        b.connId = -1;
        b.next = TLV.world.routing.randomExit(W, b.laneId, S.rng.bot);
      } else if (b.next >= 0) {
        b.connId = b.next;
        b.s -= len;
      } else {
        b.s = len - 0.01;
        veh.v = 0;
      }
    }
    if (b.connId >= 0) TLV.world.lanes.connPointAt(W, b.connId, b.s, at);
    else TLV.world.lanes.pointAt(W, b.laneId, b.s, at);
    veh.x = at.x;
    veh.y = at.y;
    veh.h = at.h;
    veh.vx = v * Math.cos(at.h);
    veh.vy = v * Math.sin(at.h);
    locate(S);
  }

  /** Random throttle and steering, with an occasional teleport. */
  function chaosStep(S, dt) {
    var W = S.world;
    var veh = S.vehicles[0];
    var b = S._stubBot;
    var rng = S.rng.bot;
    b.t -= dt;
    if (b.t <= 0) {
      b.t = rng.range(0.5, 2.5);
      b.steer = rng.range(-0.6, 0.6);
      b.throttle = rng.range(-0.3, 1);
      b.hops--;
      if (b.hops <= 0) {
        b.hops = 20;
        var lane = W.lanes[rng.int(W.lanes.length)];
        var at = TLV.world.lanes.pointAt(W, lane.id, lane.len / 2, {});
        if (at) player.setPose(S, at.x, at.y, at.h, 0);
      }
    }
    veh.v = Math.max(0, Math.min(16, veh.v + b.throttle * 5 * dt));
    veh.h = TLV.math.wrapPi(veh.h + b.steer * dt * Math.min(1, veh.v / 4));
    var nx = veh.x + Math.cos(veh.h) * veh.v * dt;
    var ny = veh.y + Math.sin(veh.h) * veh.v * dt;
    var B = W.bounds;
    if (nx < B.minX + 40 || nx > B.maxX - 40 || ny < B.minY + 40 || ny > B.maxY - 40) {
      veh.h = TLV.math.wrapPi(veh.h + Math.PI);
      veh.v = 0;
    } else {
      veh.x = nx;
      veh.y = ny;
    }
    veh.vx = veh.v * Math.cos(veh.h);
    veh.vy = veh.v * Math.sin(veh.h);
    locate(S);
  }

  player.update = function (S, dt) {
    if (!S.world) return;
    var kind = S.params.autoplay;
    if (!S._stubBot) S._stubBot = { laneId: -1, s: 0, connId: -1, next: -1, t: 0, steer: 0, throttle: 0, hops: 20 };
    if (kind === 'patrol') patrolStep(S, dt);
    else if (kind === 'chaos') chaosStep(S, dt);
    else locate(S);
  };

  bots.create = function () {
    return function (S) { return S.controls; };
  };
})(window.TLV);
