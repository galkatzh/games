// tests/player/stubs/peds_stub.js — WP-PLAYER, test only
// A private stand-in for WP-PEDS. A test places people by hand, or lets one step out ahead of the car every so often.
(function (TLV) {
  'use strict';

  var peds = TLV.ns('peds');

  peds.register = function () {};

  peds.init = function (S) {
    S.pedsys = { nextId: 1, hits: [], brushes: [], crossEveryS: S.params.crossEveryS || 0, nextT: 8 };
  };

  peds.spawn = function (S, spec) {
    for (var i = 0; i < S.peds.length; i++) {
      var p = S.peds[i];
      if (p.active) continue;
      p.id = S.pedsys.nextId++;
      p.active = true;
      p.kind = spec.kind || 'walker';
      p.x = spec.x;
      p.y = spec.y;
      p.h = spec.h || 0;
      p.px = p.x;
      p.py = p.y;
      p.ph = p.h;
      p.v = spec.v || 0;
      p.r = p.kind === 'scooter' || p.kind === 'delivery' ? 0.6 : 0.35;
      p.state = spec.state || 'WALK';
      p.intent = false;
      p.stateT = 0;
      p._p = { lifeT: spec.lifeT || 0 };
      return p;
    }
    return null;
  };

  peds.despawn = function (S, ped) {
    ped.active = false;
  };

  peds.byId = function (S, id) {
    for (var i = 0; i < S.peds.length; i++) {
      if (S.peds[i].active && S.peds[i].id === id) return S.peds[i];
    }
    return null;
  };

  peds.update = function (S, dt) {
    for (var i = 0; i < S.peds.length; i++) {
      var p = S.peds[i];
      if (!p.active) continue;
      if (p.state === 'STUMBLE') {
        p.stateT += dt;
        if (p.stateT >= 4) p.active = false;
        continue;
      }
      if (p.state === 'SCRIPT') continue;
      p.x += Math.cos(p.h) * p.v * dt;
      p.y += Math.sin(p.h) * p.v * dt;
      if (p._p.lifeT > 0) {
        p._p.lifeT -= dt;
        if (p._p.lifeT <= 0) p.active = false;
      }
    }
  };

  /** Now and then a walker steps out across the car's lane, far enough ahead to stop for. */
  peds.maintain = function (S) {
    var sys = S.pedsys;
    if (!sys.crossEveryS || S.t < sys.nextT) return;
    sys.nextT = S.t + sys.crossEveryS;
    var laneId = S.player.laneId;
    if (laneId < 0 || S.player.mode !== 'DRIVE') return;
    var W = S.world;
    var lane = W.lanes[laneId];
    var veh = S.player.veh;
    var ahead = veh.s + Math.max(30, Math.abs(veh.v) * 3.5);
    if (ahead > lane.len) return;
    var at = TLV.world.lanes.pointAt(W, laneId, ahead, {});
    var side = S.rng.ped.bool(0.5) ? 1 : -1;
    peds.spawn(S, {
      x: at.x + Math.cos(at.h + side * Math.PI / 2) * 3.5,
      y: at.y + Math.sin(at.h + side * Math.PI / 2) * 3.5,
      h: at.h - side * Math.PI / 2,
      v: 1.3,
      state: 'JAYWALK',
      lifeT: 6
    });
  };

  peds.pedsNear = function (S, x, y, r, out) {
    var n = 0;
    for (var i = 0; i < S.peds.length; i++) {
      var p = S.peds[i];
      if (p.active && Math.hypot(p.x - x, p.y - y) <= r) out[n++] = p;
    }
    out.length = n;
    return n;
  };

  peds.onHit = function (S, ped, ix, iy, speed) {
    S.pedsys.hits.push({ id: ped.id, kind: ped.kind, ix: ix, iy: iy, speed: speed });
    if (ped.state === 'SCRIPT') return;
    ped.state = 'STUMBLE';
    ped.stateT = 0;
    ped.v = 0;
  };

  peds.onBrush = function (S, ped) {
    S.pedsys.brushes.push(ped.id);
  };
})(window.TLV);
