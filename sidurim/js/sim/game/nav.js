// js/sim/game/nav.js — WP-GAME
// The arrow and the route (ARCHITECTURE 12.7). A route object is replaced, never edited, because the bots notice a new route by
// identity. In a chase the arrow is a straight bearing at the door: one-ways do not apply on foot. A route ends on the lane beside
// the bay, so its last stretch is flown by bearing, and the distance is to the box, not to the end of a polyline that a projection
// clamps to. The arrow stays on the lane until the car is level with the near end of the funnel, and only then turns into the box: a
// straight line at the box from further back runs through the car parked in front of it. From there it leads along the box's own axis,
// because a line at the centre brings a car in at more than the 30 deg that can arm, with its nose on the kerb.
(function (TLV) {
  'use strict';

  var nav = TLV.ns('game.nav');

  /** @returns {object} What nav keeps between calls, private to this file. */
  nav._newState = function () {
    return { laneId: -1, s: 0, offT: 0, wrongT: 0, atBay: false, pt: { x: 0, y: 0, h: 0 }, proj: { s: 0, d: 0, side: 0 }, near: { laneId: -1, s: 0, lat: 0, dist: 0, headingErr: 0 } };
  };

  /** Rebuilds the route from a pose, by the rules of ARCHITECTURE 12.7. @returns {?object} Route or null. */
  function solve(S, x, y, h, laneId, s) {
    var W = S.world;
    var routing = TLV.world.routing;
    var route = routing.route(W, x, y, h, laneId, s, {});
    if (route) return route;
    // No route from where the car points: the nearest lane of the AI network within reach, whichever way it runs.
    var T = TLV.tune.game;
    var ids = new Int32Array(48);
    var n = TLV.world.lanes.lanesNear(W, x, y, T.recoverReachM, ids);
    var ai = TLV.const.LF.AI_ROUTABLE;
    var order = [];
    var pr = { s: 0, d: 0, side: 0 };
    for (var i = 0; i < n; i++) {
      var lane = W.lanes[ids[i]];
      if (!(lane.flags & ai)) continue;
      TLV.math.polyProject(lane.px, lane.py, lane.cum, x, y, -1, pr);
      order.push({ id: lane.id, s: pr.s, d: pr.d });
    }
    order.sort(function (a, b) { return a.d - b.d || a.id - b.id; });
    for (var k = 0; k < order.length && k < 6; k++) {
      route = routing.routeLanes(W, order[k].id, order[k].s, laneId, s, {});
      if (route) return route;
    }
    return null;
  }

  /** Writes a new route into Nav, starting from a pose. */
  function assign(S, x, y, h) {
    var g = S.game;
    var n = g.nav;
    var st = g._g.nav;
    var route = st.laneId >= 0 ? solve(S, x, y, h, st.laneId, st.s) : null;
    n.route = route;
    n.s = 0;
    n.remaining = route ? route.len : Infinity;
    n.offRoute = false;
    n.offRouteT = 0;
    st.wrongT = 0;
    if (route) {
      var p = TLV.world.routing.project(route, x, y, 0, st.proj);
      n.s = p.s;
      n.remaining = route.len - p.s;
    }
  }

  /**
   * Sets the target: the current bay from errand start. The door stays a marker until the chase.
   * @param {object} S Sim state.
   * @param {number} laneId Lane to end on, or -1 for no route.
   * @param {number} s Position on it.
   * @param {number} x Target x, for the bearing when there is no route.
   * @param {number} y Target y.
   */
  nav.setTarget = function (S, laneId, s, x, y) {
    var veh = S.player.veh;
    nav._setTargetFrom(S, laneId, s, x, y, veh.x, veh.y, veh.h);
  };

  /** As setTarget, routing from a pose the car has not reached yet: the lane it pulls out to. Private to this package. */
  nav._setTargetFrom = function (S, laneId, s, x, y, fromX, fromY, fromH) {
    var g = S.game;
    var st = g._g.nav;
    st.laneId = laneId;
    st.s = s;
    g.nav.targetX = x;
    g.nav.targetY = y;
    assign(S, fromX, fromY, fromH);
  };

  /** Recalculates from where the car is, at most once per recalcS. */
  function recalc(S) {
    var g = S.game;
    var n = g.nav;
    if (n.recalcT > 0) return;
    n.recalcT = TLV.tune.game.navRecalcS;
    var veh = S.player.veh;
    assign(S, veh.x, veh.y, veh.h);
    S.bus.emit('nav.recalc', {});
  }

  /**
   * @param {number} left Metres of route left.
   * @param {number} gap Metres to the target in a straight line.
   * @returns {boolean} True on the last stretch: the route's tail, or the target's own road once the route has gone round the block.
   * Straight-line distance alone would point through a block of buildings at a bay on the next street.
   */
  function atBay(S, left, gap) {
    var T = TLV.tune.game;
    if (left <= T.navBayAimM) return true;
    var here = S.player.laneId;
    if (gap > T.navBayAimM || here < 0) return false;
    var lanes = S.world.lanes;
    return lanes[here].dirEdge >> 1 === lanes[S.game._g.nav.laneId].dirEdge >> 1;
  }

  /**
   * @param {number} left Metres of route left.
   * @param {number} off Metres from the route.
   * @returns {boolean} True when the car is past the far end of the box, where it can no longer arm. A car further off than that is
   * lost, not late, and a projection clamped to the end of the route says nothing about it: the off-route rule has that one.
   */
  function pastBay(S, left, off) {
    var g = S.game;
    var n = g.nav;
    var T = TLV.tune.game;
    var e = g.errand;
    if (!e || e.bayId < 0 || left > T.navBayAimM || off > T.navOffM || S.player.mode !== 'DRIVE') return false;
    if (g.phase !== 'DRIVE' && g.phase !== 'SEARCH') return false;
    var end = TLV.math.polyAt(n.route.px, n.route.py, n.route.cum, n.route.len, g._g.nav.pt);
    var veh = S.player.veh;
    return (veh.x - n.targetX) * Math.cos(end.h) + (veh.y - n.targetY) * Math.sin(end.h) > T.navMissedM;
  }

  /**
   * Keeps nav.missed: what the car can still do about a bay it has passed, for the HUD to say. The way in is backward, or Q where the
   * door is in reach. The first miss answers with nav.recalc, since the arrow has just turned round on the player.
   */
  function markMissed(S, past) {
    var g = S.game;
    var n = g.nav;
    var was = n.missed;
    n.missed = !past ? null : (TLV.game.parking._qReaches(S) ? 'BACK_OR_Q' : 'BACK');
    if (!past || was || n.recalcT > 0) return;
    n.recalcT = TLV.tune.game.navRecalcS;
    S.bus.emit('nav.recalc', {});
  }

  /**
   * @returns {boolean} True when the car is short of the funnel of the bay it is heading for, measured along the way the road runs
   * there. Every bay with a parked neighbour has that neighbour's car right there.
   */
  function shortOfBay(S) {
    var g = S.game;
    var n = g.nav;
    var e = g.errand;
    var T = TLV.tune.game;
    if (!e || e.bayId < 0) return false;
    var spot = TLV.world.parking.spot(S.world, e.bayId);
    var at = TLV.world.lanes.pointAt(S.world, g._g.nav.laneId, g._g.nav.s, g._g.nav.pt);
    var along = (S.player.fx - n.targetX) * Math.cos(at.h) + (S.player.fy - n.targetY) * Math.sin(at.h);
    return along < -(spot.len + T.funnelExtraM) / 2;
  }

  /** Writes the point the arrow leads to in the box: on its axis, ahead of the car, and no further than its far end. @returns {boolean} False past that end. */
  function intoBay(S, out) {
    var g = S.game;
    var e = g.errand;
    var T = TLV.tune.game;
    if (!e || e.bayId < 0) return false;
    var spot = TLV.world.parking.spot(S.world, e.bayId);
    var at = TLV.world.lanes.pointAt(S.world, g._g.nav.laneId, g._g.nav.s, g._g.nav.pt);
    var c = Math.cos(at.h);
    var s = Math.sin(at.h);
    var along = (S.player.fx - spot.x) * c + (S.player.fy - spot.y) * s;
    var end = spot.len / 2;
    if (along >= end) return false;
    var aim = Math.min(along + T.navAxisLeadM, end);
    out.x = spot.x + c * aim;
    out.y = spot.y + s * aim;
    return true;
  }

  /** Points the arrow: along the route, along the lane to the bay, or straight at the target. */
  function point(S) {
    var g = S.game;
    var n = g.nav;
    var p = S.player;
    var T = TLV.tune.game;
    if (p.mode === 'FOOT') {
      var e = g.errand;
      if (e) n.arrowH = Math.atan2(e.doorY - p.fy, e.doorX - p.fx);
      return;
    }
    var at = g._g.nav.pt;
    if (n.route && !g._g.nav.atBay) {
      TLV.math.polyAt(n.route.px, n.route.py, n.route.cum, n.s + T.navAheadM, at);
      n.arrowH = Math.atan2(at.y - p.fy, at.x - p.fx);
    } else if (n.route && shortOfBay(S)) {
      // The target's lane point stands beside the bay, so the line to it runs down the lane past the neighbour.
      n.arrowH = Math.atan2(at.y - p.fy, at.x - p.fx);
    } else if (n.route && intoBay(S, at)) {
      n.arrowH = Math.atan2(at.y - p.fy, at.x - p.fx);
    } else {
      n.arrowH = Math.atan2(n.targetY - p.fy, n.targetX - p.fx);
    }
  }

  /**
   * Tracks the car along the route, watches for leaving it, and points the arrow.
   * @param {object} S Sim state.
   * @param {number} dt Tick, seconds.
   */
  nav.update = function (S, dt) {
    var g = S.game;
    var n = g.nav;
    var st = g._g.nav;
    var T = TLV.tune.game;
    var past = false;
    st.atBay = false;
    if (n.recalcT > 0) n.recalcT -= dt;
    if (S.player.mode !== 'FOOT' && st.laneId >= 0) {
      var veh = S.player.veh;
      if (n.route) {
        var p = TLV.world.routing.project(n.route, veh.x, veh.y, n.s, st.proj);
        n.s = p.s;
        var left = n.route.len - p.s;
        var gap = TLV.math.dist(veh.x, veh.y, n.targetX, n.targetY);
        st.atBay = atBay(S, left, gap);
        n.remaining = !st.atBay ? left : (left <= T.navBayAimM ? Math.max(left, gap) : gap);
        past = pastBay(S, left, p.d);
        var off = p.d > T.navOffM;
        n.offRoute = off;
        n.offRouteT = off ? n.offRouteT + dt : 0;
        st.wrongT = S.player.wrongWay ? st.wrongT + dt : 0;
        if (n.offRouteT >= T.navOffS || st.wrongT >= T.navWrongS) recalc(S);
      } else {
        n.remaining = Infinity;
        recalc(S);
      }
    }
    markMissed(S, past);
    point(S);
  };
})(window.TLV);
