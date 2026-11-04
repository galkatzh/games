// js/sim/traffic/gate.js — WP-TRAFFIC
// The junction gate (ARCHITECTURE 12.5). A car plans a few connectors ahead and asks for each at the grant distance. A grant
// needs the phase, no conflicting connector occupied, priority at an unsignalled junction, and room on the exit. Grants raise
// occ and reserved, and releaseAll is the one way back for every exit path, so the two counters stay conserved.
(function (TLV) {
  'use strict';

  var gate = TLV.ns('traffic.gate');

  /** Why a car has no grant. */
  var WHY = {
    OK: 0, RED: 1, CONFLICT: 2, PRIORITY: 3, EXIT: 4, EXCLUSIVE: 5, QUEUE: 6, CONTACT: 7, FAR: 8, DEAD_END: 9
  };
  gate.WHY = WHY;

  /** The plan reaches at least this far past the current path. */
  var PLAN_M = 80;
  var NOT_ENTERED = Infinity;

  /**
   * Creates the counters and reads the static tables.
   * @param {object} S Sim state.
   */
  gate.init = function (S) {
    var T = S.traffic;
    var W = S.world;
    var nL = T.nL;
    var nC = T.nC;
    T.occ = new Int32Array(nC);
    T.reserved = new Float64Array(nL);
    T.reqTick = new Int32Array(nC);
    T.reqSince = new Float64Array(nC);
    T.redRunAt = new Float64Array(W ? W.juncs.length : 0);
    T.redRunAt.fill(-1e9);
    T.keyOf = new Int32Array(nC);
    T.bumpBuf = new Int32Array(32);
    var turnScore = TLV.tune.world.connTurnScore;
    for (var i = 0; i < nC; i++) T.keyOf[i] = W.conns[i].priority - turnScore[W.conns[i].turn];
    var table = W ? TLV.world.junctions._contacts(W) : null;
    T.sibClear = table ? table.sibClear : new Float32Array(0);
    T.setback = table ? table.setback : new Float32Array(0);
    T.connX = table ? table.connX : [];
    T.laneX = table ? table.laneX : [];
  };

  /** @returns {number} The lane the plan's end leaves from, or -1. */
  function planTip(S, veh) {
    var t = veh._t;
    var W = S.world;
    if (t.pn > 0) return W.conns[t.plan[t.pn - 1]].to;
    if (t.lcTo >= 0) return t.lcTo;
    if (veh.mode === 'LANE') return veh.laneId;
    if (veh.mode === 'CONN') return W.conns[veh.connId].to;
    return -1;
  }

  /** Next connector on a route. @returns {number} Connector, or -1 to fall back on the random walk. */
  function routeExit(S, veh, laneId) {
    var t = veh._t;
    var W = S.world;
    var dirs = t.route.dirEdges;
    var d = W.lanes[laneId].dirEdge;
    var i;
    var at = -1;
    for (i = t.ri; i < dirs.length && at < 0; i++) {
      if (dirs[i] === d) at = i;
    }
    for (i = 0; i < t.ri && at < 0; i++) {
      if (dirs[i] === d) at = i;
    }
    if (at < 0 || at + 1 >= dirs.length) return -1;
    t.ri = at;
    var c = TLV.world.junctions.connFor(W, laneId, dirs[at + 1]);
    if (c >= 0) return c;
    // Another lane of this road holds the turn: the FSM changes lanes, and no car stops to wait for a gap.
    var lanes = W.dirEdges[d].lanes;
    for (i = 0; i < lanes.length; i++) {
      if (TLV.world.junctions.connFor(W, lanes[i], dirs[at + 1]) >= 0) {
        t.mustLane = lanes[i];
        break;
      }
    }
    return -1;
  }

  /** Picks the exit of a lane. A long body keeps to roads it fits on, when the walk offers one. */
  function pickExit(S, veh, laneId) {
    var t = veh._t;
    var W = S.world;
    if (t.route) {
      var c = routeExit(S, veh, laneId);
      if (c >= 0) return c;
    }
    var routing = TLV.world.routing;
    var pick = routing.randomExit(W, laneId, S.rng.traffic);
    // A car with nowhere to be looks down each road before taking it. Queues then spill back less, and a walk loses nothing.
    for (var tries = 0; tries < TLV.tune.traffic.exitRedraws && pick >= 0 && exitBusy(S, W.conns[pick].to); tries++) {
      pick = routing.randomExit(W, laneId, S.rng.traffic);
    }
    var T = S.traffic;
    if (T.calmOn && !T.calm[W.lanes[laneId].dirEdge]) {
      for (var c = 0; c < TLV.tune.traffic.calmRedraws && pick >= 0 && T.calm[W.lanes[W.conns[pick].to].dirEdge]; c++) {
        pick = routing.randomExit(W, laneId, S.rng.traffic);
      }
      // Nothing long turns onto it at all, if there is another way.
      if (veh.length > TLV.tune.traffic.longBody && pick >= 0 && T.calm[W.lanes[W.conns[pick].to].dirEdge]) {
        var ways = W.lanes[laneId].conns;
        for (var w = 0; w < ways.length; w++) {
          if (!T.calm[W.lanes[W.conns[ways[w]].to].dirEdge]) pick = ways[w];
        }
      }
    }
    var lane = W.lanes[laneId];
    var ai = TLV.const.LF.AI_ROUTABLE;
    if (pick >= 0 && !(W.lanes[W.conns[pick].to].flags & ai)) {
      // Every exit of this lane leaves the network, but one of its neighbours has a way on (WP-WORLD report).
      var way = lane.left >= 0 ? lane.left : lane.right;
      if (way >= 0 && TLV.traffic.lanechange.hasAiExit(S, way)) t.mustLane = way;
    }
    if (pick >= 0 && leadsNowhere(S, W.conns[pick].to)) {
      for (var k = 0; k < lane.conns.length; k++) {
        if (!leadsNowhere(S, W.conns[lane.conns[k]].to)) {
          pick = lane.conns[k];
          break;
        }
      }
    }
    if (veh.length <= 6 || pick < 0 || fits(veh, W.lanes[W.conns[pick].to])) return pick;
    for (var i = 0; i < lane.conns.length; i++) {
      if (fits(veh, W.lanes[W.conns[lane.conns[i]].to])) return lane.conns[i];
    }
    return pick;
  }

  /** @returns {boolean} True for a lane with no way on to the AI network, from itself or the lanes beside it. */
  function leadsNowhere(S, laneId) {
    var lc = TLV.traffic.lanechange;
    var lane = S.world.lanes[laneId];
    if (lc.hasAiExit(S, laneId)) return false;
    if (lane.len < TLV.tune.traffic.laneEscapeM) return true;
    if (lane.left >= 0 && lc.hasAiExit(S, lane.left)) return false;
    return !(lane.right >= 0 && lc.hasAiExit(S, lane.right));
  }

  /** @returns {boolean} True when an exit lane has a standing queue reaching near its start. */
  function exitBusy(S, laneId) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    if (T.mark[laneId] !== T.stamp) return false;
    var e = T.head[laneId];
    if (T.eV[e] > Q.exitBusyV) return false;
    var len = S.world.lanes[laneId].len;
    return T.eS[e] - T.eHalf[e] < len * Q.exitBusyShare;
  }

  /** @returns {boolean} True on a road a long, wide body belongs on. */
  function fits(veh, lane) {
    var Q = TLV.tune.traffic;
    return lane.cls <= TLV.const.ROAD.TERTIARY && lane.width >= Q.heavyLaneW && lane.len >= veh.length + Q.exitPad &&
      (lane.flags & TLV.const.LF.AI_ROUTABLE) !== 0;
  }

  /** Joints between lanes have no gate (ARCHITECTURE 8.2). */
  function skipJoints(S, t) {
    var W = S.world;
    while (t.pg < t.pn && W.conns[t.plan[t.pg]].px.length === 2) t.pg++;
  }

  /**
   * Extends a car's plan to reach PLAN_M along the road.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   */
  gate.extend = function (S, veh) {
    var t = veh._t;
    var W = S.world;
    var d = 0;
    for (var i = 0; i < t.pn; i++) {
      var p = W.conns[t.plan[i]];
      d += p.len + W.lanes[p.to].len;
    }
    while (t.pn < t.plan.length && d < PLAN_M) {
      var tip = planTip(S, veh);
      if (tip < 0) break;
      var c = pickExit(S, veh, tip);
      if (c < 0) break;
      t.plan[t.pn++] = c;
      var conn = W.conns[c];
      d += conn.len + W.lanes[conn.to].len;
    }
    skipJoints(S, t);
  };

  /** @returns {boolean} True when this car holds connector x itself. */
  function holds(t, x) {
    for (var i = 0; i < t.hn; i++) {
      if (t.held[i] === x) return true;
    }
    return false;
  }

  /** Marks a car's request, so that a lower priority can see it. */
  function markRequest(S, veh, c) {
    var T = S.traffic;
    var t = veh._t;
    if (t.arrive < 0) t.arrive = S.t;
    if (T.tk - T.reqTick[c] > TLV.tune.traffic.reqTtl || t.arrive < T.reqSince[c]) T.reqSince[c] = t.arrive;
    T.reqTick[c] = T.tk;
  }

  /** @returns {boolean} True when a request on x goes before this one (ARCHITECTURE 12.5). */
  function outranks(S, x, c, since) {
    var T = S.traffic;
    if (T.keyOf[x] !== T.keyOf[c]) return T.keyOf[x] > T.keyOf[c];
    var other = T.reqSince[x];
    if (other !== since) return other < since;
    var W = S.world;
    if (W.conns[x].priority !== W.conns[c].priority) return W.conns[x].priority > W.conns[c].priority;
    return x < c;
  }

  /**
   * Tests a connector for a car, without changing anything.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {number} c Connector.
   * @param {number} nose Metres from the nose to the stop line.
   * @returns {number} WHY.*. OK is a grant.
   */
  gate.check = function (S, veh, c, nose) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var conn = S.world.conns[c];
    var i;
    if (conn.slot >= 0 && t.runRed !== c) {
      var SIG = TLV.const.SIG;
      var st = TLV.world.signals.connState(S, c);
      if (st === SIG.RED) return WHY.RED;
      if (st === SIG.AMBER) {
        var stopD = veh.v * veh.v / (2 * t.b * Q.stopBrakeShare);
        // A car that reaches the line before red goes through, as everyone does. One that cannot, and can stop, stops.
        var inTime = veh.v > 1 && nose / veh.v < TLV.world.signals.timeToRed(S, c);
        if (nose > stopD && !inTime && !(t.waitT >= Q.sneakS && nose < Q.sneakNose)) return WHY.RED;
      }
    }
    var list = conn.conflicts;
    for (i = 0; i < list.length; i++) {
      if (T.occ[list[i]] > 0 && !holds(t, list[i])) return WHY.CONFLICT;
    }
    var cross = T.connX[c];
    if (cross) {
      for (i = 0; i < cross.length; i++) {
        if (T.occ[cross[i]] > 0 && !holds(t, cross[i])) return WHY.CONTACT;
      }
    }
    if (conn.slot < 0 && t.waitT < Q.impatientS) {
      for (i = 0; i < list.length; i++) {
        var x = list[i];
        if (T.tk - T.reqTick[x] <= Q.reqTtl && outranks(S, x, c, t.arrive)) return WHY.PRIORITY;
      }
    }
    return gate.exitWhy(S, veh, conn);
  };

  /** @returns {boolean} True when nothing holds a connector that touches c across a junction. No car shoves past one of those. */
  gate.crossClear = function (S, veh, c) {
    var T = S.traffic;
    var cross = T.connX[c];
    if (!cross) return true;
    for (var i = 0; i < cross.length; i++) {
      if (T.occ[cross[i]] > 0 && !holds(veh._t, cross[i])) return false;
    }
    return true;
  };

  /** @returns {number} WHY.OK when the exit lane can take this car. */
  gate.exitWhy = function (S, veh, conn) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var W = S.world;
    var to = conn.to;
    var i;
    var cross = T.laneX[to];
    if (cross) {
      for (i = 0; i < cross.length; i++) {
        if (T.reserved[cross[i]] > 0 || TLV.traffic.idm.occupied(S, cross[i])) return WHY.CONTACT;
      }
    }
    if (W.lanes[to].flags & TLV.const.LF.EXCLUSIVE) {
      if (T.reserved[to] > 0 || TLV.traffic.idm.occupied(S, to)) return WHY.EXCLUSIVE;
      return WHY.OK;
    }
    if (TLV.traffic.idm.room(S, to, Q.roomLookS) - T.reserved[to] < veh.length + Q.exitPad) return WHY.EXIT;
    return WHY.OK;
  };

  /**
   * Gives a car the grant for the next connector of its plan.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {number} c Connector, plan[pg].
   */
  gate.grant = function (S, veh, c) {
    var T = S.traffic;
    var t = veh._t;
    var conn = S.world.conns[c];
    var need = veh.length + TLV.tune.traffic.exitPad;
    T.occ[c]++;
    T.reserved[conn.to] += need;
    var n = t.hn++;
    t.held[n] = c;
    t.hEnd[n] = NOT_ENTERED;
    t.hRes[n] = need;
    t.pg++;
    t.why = WHY.OK;
    t.waitT = 0;
    t.arrive = -1;
    t.lastGrantT = S.t;
    skipJoints(S, t);
  };

  /** Drops one held connector. */
  function drop(S, t, i) {
    var T = S.traffic;
    var c = t.held[i];
    T.occ[c]--;
    if (t.hRes[i] > 0) T.reserved[S.world.conns[c].to] -= t.hRes[i];
    var last = t.hn - 1;
    for (var k = i; k < last; k++) {
      t.held[k] = t.held[k + 1];
      t.hEnd[k] = t.hEnd[k + 1];
      t.hRes[k] = t.hRes[k + 1];
    }
    t.hn = last;
  }

  /**
   * Gives back grants from a place in the plan onward, for connectors not yet entered.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {number} index Plan index.
   */
  gate.revokeFrom = function (S, veh, index) {
    var t = veh._t;
    for (var k = t.pg - 1; k >= index; k--) {
      var c = t.plan[k];
      for (var i = t.hn - 1; i >= 0; i--) {
        if (t.held[i] === c && t.hEnd[i] === NOT_ENTERED) {
          drop(S, t, i);
          break;
        }
      }
    }
    if (t.pg > index) t.pg = index;
  };

  /**
   * Clears a car's plan and any grant in it. The connectors it stands on stay held.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   */
  gate.clearPlan = function (S, veh) {
    gate.revokeFrom(S, veh, 0);
    var t = veh._t;
    t.pn = 0;
    t.pg = 0;
  };

  /**
   * Gives back everything a car holds. The one exit path for occ and reserved (ARCHITECTURE 12.5).
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   */
  gate.releaseAll = function (S, veh) {
    var t = veh._t;
    while (t.hn > 0) drop(S, t, t.hn - 1);
    t.pn = 0;
    t.pg = 0;
  };

  /** @returns {number} Where connector x stands in a car's plan, or -1. */
  function planIndex(t, x) {
    for (var i = 0; i < t.pg; i++) {
      if (t.plan[i] === x) return i;
    }
    return -1;
  }

  /** @returns {number} Metres from a car's nose to the start of the connector at a plan index. */
  function noseTo(S, veh, index) {
    var W = S.world;
    var t = veh._t;
    var d = veh.mode === 'LANE' ? W.lanes[veh.laneId].len - veh.s : W.conns[veh.connId].len - veh.s + W.lanes[W.conns[veh.connId].to].len;
    for (var i = 0; i < index; i++) {
      var c = W.conns[t.plan[i]];
      d += c.len + W.lanes[c.to].len;
    }
    return d - t.halfL;
  }

  gate.noseTo = noseTo;

  /**
   * Takes a connector ahead of the cars that hold its conflicts but are still short of the junction. It can never take one from
   * a car already in the junction, or one that could not stop for it: occupancy is never overridden.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle asking.
   * @param {number} c Connector.
   * @param {number} ttaS Least time any holder may be from its line.
   * @param {number} maxBrake Hardest braking that may be forced on a holder.
   * @returns {boolean} True when nothing holds a conflict of c any more.
   */
  gate.bump = function (S, veh, c, ttaS, maxBrake) {
    var T = S.traffic;
    var list = S.world.conns[c].conflicts;
    var i;
    // A dry run first, so that a car refused here has taken nothing from anyone.
    for (i = 0; i < list.length; i++) {
      if (T.occ[list[i]] > 0 && !holds(veh._t, list[i]) && !mayBump(S, list[i], ttaS, maxBrake, veh.slot)) return false;
    }
    for (i = 0; i < list.length; i++) {
      if (T.occ[list[i]] > 0 && !holds(veh._t, list[i])) takeFrom(S, list[i], veh.slot);
    }
    return true;
  };

  /** Takes connector x back from every car that holds it, bar one. */
  function takeFrom(S, x, me) {
    var T = S.traffic;
    for (var a = 0; a < T.nAct; a++) {
      var o = S.vehicles[T.act[a]];
      if (o.slot !== me && holds(o._t, x)) gate.revokeFrom(S, o, planIndex(o._t, x));
    }
  }

  /** @returns {boolean} True when every holder of x could give it up. */
  function mayBump(S, x, ttaS, maxBrake, me) {
    var T = S.traffic;
    for (var a = 0; a < T.nAct; a++) {
      var o = S.vehicles[T.act[a]];
      var t = o._t;
      for (var i = 0; i < t.hn; i++) {
        if (t.held[i] !== x || o.slot === me) continue;
        if (t.hEnd[i] !== NOT_ENTERED || t.hRes[i] === 0) return false;
        var index = planIndex(t, x);
        if (index < 0) return false;
        var nose = noseTo(S, o, index);
        if (nose < TLV.tune.traffic.noseMinM) return false;
        if (nose / Math.max(o.v, 1) < ttaS) return false;
        if (o.v * o.v / (2 * maxBrake) > nose) return false;
      }
    }
    return true;
  }

  /** @returns {number} Metres from the line at which a car at this speed asks for a grant (ARCHITECTURE 12.5). */
  gate.reach = function (v) {
    var Q = TLV.tune.traffic;
    var far = Q.grantPerV2 * v * v + Q.grantPad;
    return far > Q.grantBase ? far : Q.grantBase;
  };

  /**
   * One gate evaluation for a car: asks for the next connector in its plan when within reach of the line.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle in LANE or CONN.
   */
  gate.update = function (S, veh) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    if (t.pn < 2) gate.extend(S, veh);
    skipJoints(S, t);
    if (t.pg >= t.pn) {
      t.why = t.pn === 0 ? WHY.DEAD_END : WHY.OK;
      return;
    }
    if (t.hn >= t.held.length) return;
    // A car still off its lane's line goes no further than the stop line. It gets a grant once it is back.
    if (veh.lat > Q.grantLat || veh.lat < -Q.grantLat) return;
    var nose = t.lineD - t.halfL;
    if (nose > gate.reach(veh.v)) {
      t.why = WHY.FAR;
      t.arrive = -1;
      return;
    }
    // A car does not ask past a leader that has no grant itself.
    if (t.lead > 0 && t.leadSame) {
      var o = S.vehicles[t.lead];
      if (o.active && (o.mode === 'LANE' || o.mode === 'CONN') && o._t.pg === 0 && o.mode === veh.mode && o.laneId === veh.laneId) {
        t.why = WHY.QUEUE;
        return;
      }
    }
    var c = t.plan[t.pg];
    markRequest(S, veh, c);
    var why = gate.check(S, veh, c, nose);
    if (why === WHY.OK) {
      gate.grant(S, veh, c);
      return;
    }
    t.why = why;
    if (S.world.conns[c].slot >= 0) return;
    if (why === WHY.PRIORITY || why === WHY.CONFLICT) {
      if (TLV.traffic.behaviours.tryNose(S, veh, c, nose, why)) return;
      if (t.waitT >= Q.impatientS && why === WHY.CONFLICT && gate.bump(S, veh, c, Q.impatientTta, t.safeB) &&
          gate.check(S, veh, c, nose) === WHY.OK) {
        gate.grant(S, veh, c);
      }
    }
  };

  /** Records a path a tail still trails over. */
  function pushBack(t, path, len) {
    for (var i = Math.min(t.backN, t.back.length - 1); i > 0; i--) {
      t.back[i] = t.back[i - 1];
      t.backLen[i] = t.backLen[i - 1];
    }
    t.back[0] = path;
    t.backLen[0] = len;
    if (t.backN < t.back.length) t.backN++;
  }

  /** Moves a car from a lane onto the first connector of its plan. */
  function enterConn(S, veh, lane) {
    var W = S.world;
    var t = veh._t;
    var c = t.plan[0];
    var conn = W.conns[c];
    for (var i = 1; i < t.pn; i++) t.plan[i - 1] = t.plan[i];
    t.pn--;
    t.pg--;
    pushBack(t, lane.id, lane.len);
    veh.s -= lane.len;
    veh.mode = 'CONN';
    veh.connId = c;
    veh.laneId = -1;
    for (var k = 0; k < t.hn; k++) {
      if (t.held[k] === c && t.hEnd[k] === NOT_ENTERED) {
        t.hEnd[k] = t.odo - veh.s + conn.len;
        break;
      }
    }
    if (t.runRed === c) TLV.traffic.behaviours.crossedOnRed(S, veh, conn);
    t.decided = -1;
    gate.extend(S, veh);
  }

  /** Moves a car from a connector onto its target lane. */
  function enterLane(S, veh, conn) {
    var T = S.traffic;
    var t = veh._t;
    for (var k = 0; k < t.hn; k++) {
      if (t.held[k] === conn.id && t.hRes[k] > 0) {
        T.reserved[conn.to] -= t.hRes[k];
        t.hRes[k] = 0;
        break;
      }
    }
    pushBack(t, T.nL + conn.id, conn.len);
    veh.s -= conn.len;
    veh.mode = 'LANE';
    veh.laneId = conn.to;
    veh.connId = -1;
    gate.extend(S, veh);
  }

  /**
   * Moves a car across a path end, if it reached one, and frees what its tail has cleared.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle in LANE or CONN.
   */
  gate.advance = function (S, veh) {
    var W = S.world;
    var t = veh._t;
    if (veh.mode === 'LANE') {
      var lane = W.lanes[veh.laneId];
      if (veh.s >= lane.len) {
        if (t.lcTo >= 0) TLV.traffic.lanechange.finish(S, veh);
        lane = W.lanes[veh.laneId];
        if (veh.s >= lane.len) {
          if (t.pg > 0) {
            enterConn(S, veh, lane);
          } else {
            veh.s = lane.len - 0.01;
            veh.v = 0;
          }
        }
      }
    } else if (veh.mode === 'CONN') {
      var conn = W.conns[veh.connId];
      if (veh.s >= conn.len) enterLane(S, veh, conn);
    }
    while (t.hn > 0 && t.odo - t.halfL >= t.hEnd[0]) drop(S, t, 0);
  };

  /**
   * Swaps a queue head's connector for one that passes the gate now (deadlock ladder L2). Connectors of a lane share its slot.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle in LANE, with no grant.
   * @returns {boolean} True when a grant was taken.
   */
  gate.repick = function (S, veh) {
    var W = S.world;
    var t = veh._t;
    var laneId = t.lcTo >= 0 ? t.lcTo : veh.laneId;
    var lane = W.lanes[laneId];
    if (!lane) return false;
    var nose = t.lineD - t.halfL;
    var keep = t.pn > 0 ? t.plan[0] : -1;
    var ai = TLV.const.LF.AI_ROUTABLE;
    for (var i = 0; i < lane.conns.length; i++) {
      var c = lane.conns[i];
      if (c === keep || !(W.lanes[W.conns[c].to].flags & ai)) continue;
      if (W.conns[c].px.length !== 2 && gate.check(S, veh, c, nose) !== WHY.OK) continue;
      t.pn = 1;
      t.pg = 0;
      t.plan[0] = c;
      t.route = null;
      if (W.conns[c].px.length !== 2) gate.grant(S, veh, c);
      gate.extend(S, veh);
      return true;
    }
    return false;
  };

  /**
   * Recounts occ and reserved from what cars hold (soak gate Conservation).
   * @param {object} S Sim state.
   * @returns {?string} Failure text, or null.
   */
  gate.audit = function (S) {
    var T = S.traffic;
    var W = S.world;
    var nC = T.nC;
    var occ = new Int32Array(nC);
    var res = new Float64Array(T.nL);
    var i;
    for (i = 0; i < T.nAct; i++) {
      var t = S.vehicles[T.act[i]]._t;
      for (var k = 0; k < t.hn; k++) {
        occ[t.held[k]]++;
        res[W.conns[t.held[k]].to] += t.hRes[k];
      }
    }
    for (i = 0; i < nC; i++) {
      if (occ[i] !== T.occ[i]) return 'connector ' + i + ' occ ' + T.occ[i] + ', recounted ' + occ[i];
    }
    for (i = 0; i < T.nL; i++) {
      if (Math.abs(res[i] - T.reserved[i]) > 1e-6) return 'lane ' + i + ' reserved ' + T.reserved[i] + ', recounted ' + res[i];
    }
    return null;
  };
})(window.TLV);
