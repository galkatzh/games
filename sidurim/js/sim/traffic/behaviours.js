// js/sim/traffic/behaviours.js — WP-TRAFFIC
// The driver FSM (GAME_DESIGN 9, ARCHITECTURE 10.3 and 13.1). It runs at 5 Hz in staggered buckets. Every state but CRUISE has a
// timeout. Moves off the lanes (stall entry, stand-off, tow, knock-on after an impact) are pose scripts, run every tick.
(function (TLV) {
  'use strict';

  var beh = TLV.ns('traffic.behaviours');

  /** Pose scripts. */
  var SK = { NONE: 0, COMMIT: 1, PULLOUT: 2, REJOIN: 3, STANDOFF: 4, TOW: 5, PULL_OVER: 6 };
  beh.SK = SK;

  /** PARK_RACE stages. */
  var RACE = { ROUTE: 0, BLINK: 1, CREEP: 2, HOLD: 3, COMMIT: 4 };

  /** A car that shows its driver's business is outside the Lane bound gate while it lasts. */
  var OFF_LANE = {
    OVERTAKE_OUT: 1, OVERTAKE_PASS: 1, CUT_IN: 1, DROP_APPROACH: 1, DROPPED: 1, PULLOUT: 1, BUS_APPROACH: 1, BUS_STOPPED: 1,
    BUS_PULLOUT: 1, PARK_RACE: 1, PARK_HOLD: 1, NOSE_IN: 1, PULL_OVER: 1, RIVAL_BLOCK: 1, RIVAL_STANDOFF: 1, TOWED: 1
  };
  beh.OFF_LANE = OFF_LANE;

  /** Bounded timers, exempt from the watchdog (ARCHITECTURE 12.5). */
  var WATCHDOG_EXEMPT = {
    PHANTOM_STOP: 1, DROPPED: 1, RIVAL_BLOCK: 1, DOUBLE_PARK: 1, BUS_STOPPED: 1, PARK_HOLD: 1, RIVAL_STANDOFF: 1
  };
  beh.WATCHDOG_EXEMPT = WATCHDOG_EXEMPT;

  /** @returns {number} FSM period, seconds. */
  function period() {
    return TLV.tune.traffic.fsmTicks * TLV.const.DT;
  }

  /** Sends an event, unless prewarm has them off (ARCHITECTURE 12.5). */
  function emit(S, name, payload) {
    if (!S.traffic.quiet) S.bus.emit(name, payload);
  }

  beh.emit = emit;

  /** Where a tow is about to stand. Scratch for playerAt. */
  var towBox = { x: 0, y: 0, h: 0, length: 0, width: 0 };

  /**
   * Creates the concurrency counters.
   * @param {object} S Sim state.
   */
  beh.init = function (S) {
    var T = S.traffic;
    T.count = {};
    TLV.const.BEHAVIOURS.forEach(function (name) { T.count[name] = 0; });
    T.contacts = 0;
    T.fired = {};
    T.passT = 0;
  };

  /**
   * Moves a car to a behaviour and tells the listeners.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {string} name Behaviour id.
   */
  beh.set = function (S, veh, name) {
    var T = S.traffic;
    var prev = veh.beh;
    if (prev === name) return;
    T.count[prev]--;
    T.count[name]++;
    veh.beh = name;
    veh.behT = 0;
    emit(S, 'traffic.behaviour', { vehId: veh.id, beh: name, prev: prev });
  };

  /** Clears everything a behaviour may have set on a car. */
  function clearState(veh) {
    var t = veh._t;
    var VL = TLV.const.VL;
    t.stopS = -1;
    t.capV = Infinity;
    t.forceA = NaN;
    t.aim = null;
    t.target = -1;
    t.capped = false;
    t.stage = 0;
    t.timer = 0;
    t.latT = 0;
    t.latR = 1;
    t.reverse = 0;
    t.noseConn = -1;
    t.ovLead = -1;
    t.ovMode = 0;
    t.ovLane = -1;
    t.ovAbort = false;
    t.ovFast = false;
    t.oppLane = -1;
    t.runRed = -1;
    if (t.tailRoute) {
      t.tailRoute = false;
      t.route = null;
    }
    veh.lights &= ~(VL.HAZARD | VL.HIGH_BEAM | VL.REVERSE | VL.BLINK_L | VL.BLINK_R);
    veh.horn = false;
  }

  /**
   * Returns a car to CRUISE.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   */
  beh.toCruise = function (S, veh) {
    var had = veh.door;
    clearState(veh);
    if (had) {
      veh.door = 0;
      emit(S, 'traffic.door', { vehId: veh.id, open: false });
    }
    beh.set(S, veh, 'CRUISE');
  };

  /** Holds a blocker to the player-arrived limit, on a lane with no way round (ARCHITECTURE 12.5). */
  function capBlocker(S, veh) {
    var Q = TLV.tune.traffic;
    var t = veh._t;
    if (t.capped) return;
    var lane = S.world.lanes[veh.laneId];
    if (!lane || lane.left >= 0 || lane.right >= 0 || lane.opposite >= 0) return;
    var p = S.player;
    if (!p) return;
    var dx = p.fx - veh.x;
    var dy = p.fy - veh.y;
    if (dx * dx + dy * dy > Q.blockerNearM * Q.blockerNearM) return;
    if (dx * t.cosH + dy * t.sinH > 0) return;
    t.capped = true;
    if (t.timer > Q.blockerS) t.timer = Q.blockerS;
  }

  /** @returns {boolean} True on a lane with no neighbour of any kind. */
  function noWayRound(lane) {
    return lane.left < 0 && lane.right < 0 && lane.opposite < 0;
  }

  /** A held time, limited as ARCHITECTURE 13.1 limits every holdS. */
  function clampHold(S, veh, holdS) {
    var lane = S.world.lanes[veh.laneId];
    var Q = TLV.tune.traffic;
    if (!lane || !noWayRound(lane)) return holdS;
    var p = S.player;
    if (!p) return holdS;
    var dx = p.fx - veh.x;
    var dy = p.fy - veh.y;
    var near = dx * dx + dy * dy <= Q.blockerNearM * Q.blockerNearM && dx * veh._t.cosH + dy * veh._t.sinH <= 0;
    return near && holdS > Q.blockerS ? Q.blockerS : holdS;
  }

  /** Metres a car can move toward its right kerb and still clear the line of parked cars. */
  function kerbShift(S, veh) {
    var W = S.world;
    var t = veh._t;
    var lane = W.lanes[veh.laneId];
    var e = W.edges[lane.edge];
    var dir = W.dirEdges[lane.dirEdge].dir;
    var strip = dir === 0 ? e.parkR : e.parkL;
    var room = lane.width / 2 - t.halfW;
    return strip > 0 ? room + Math.min(strip, 0.3) : Math.max(0, room - 0.1);
  }

  /**
   * How far toward the kerb a car may stand at a place on its lane. Some lanes hug a wall the map's kerb does not know about.
   * @returns {number} Metres, 0 when the kerb side is a wall.
   */
  function shiftAt(S, veh, s) {
    var W = S.world;
    var T = S.traffic;
    var shift = kerbShift(S, veh);
    TLV.world.lanes.pointAt(W, veh.laneId, s, T.at);
    var x = T.at.x + Math.sin(T.at.h) * shift;
    var y = T.at.y - Math.cos(T.at.h) * shift;
    return TLV.world.spatial.pointInBuilding(W, x, y) >= 0 ? 0 : shift;
  }

  /** @returns {number} How far toward the kerb a car may go the whole way from where it is to a stop. */
  function shiftTo(S, veh, stopAt) {
    var least = Infinity;
    // Every metre: a corner of a building is narrower than a car's stride along the kerb.
    for (var s = veh.s; s < stopAt + 3; s += 1) {
      var shift = shiftAt(S, veh, s);
      if (shift < least) least = shift;
    }
    return least === Infinity ? 0 : least;
  }

  /** Blow the horn. @returns {boolean} True when it sounded. */
  function honk(S, veh, atPlayer) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    if (t.honkT > 0) return false;
    t.honkT = Q.honkCoolS;
    t.hornT = Q.honkS;
    veh.horn = true;
    emit(S, 'traffic.honk', { vehId: veh.id, atPlayer: atPlayer, x: veh.x, y: veh.y });
    emit(S, 'bubble', { who: 'veh', id: veh.id, text: '!', ttl: 1 });
    return true;
  }

  /** @returns {boolean} True when the next stop line is red for this car. */
  function redAhead(S, t) {
    if (t.pn === 0) return false;
    var c = t.plan[t.pg < t.pn ? t.pg : 0];
    return TLV.world.signals.connState(S, c) === TLV.const.SIG.RED;
  }

  /** The two honk triggers (GAME_DESIGN 9). */
  function honkLogic(S, veh, dt) {
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var stopped = veh.v < Q.stuckV;
    var behindCar = t.lead >= 0 && t.leadGap < 8;
    if (stopped && behindCar && t.pn > 0) {
      var ttg = TLV.world.signals.timeToGreen(S, t.plan[t.pg < t.pn ? t.pg : 0]);
      if (ttg > 0 && t.honkAt < 0) t.honkAt = S.t + ttg + Q.honkGreenDelay;
    }
    if (stopped && behindCar && !redAhead(S, t)) t.blockedT += dt;
    else t.blockedT = 0;
    if (t.blockedT >= Q.honkBlockedS && veh.ag > Q.honkBlockedAg) honk(S, veh, t.lead === 0);
  }

  /**
   * Per-tick timers, for what 5 Hz is too coarse for.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {number} dt Tick, seconds.
   */
  beh.tick = function (S, veh, dt) {
    var t = veh._t;
    if (t.hornT > 0) {
      t.hornT -= dt;
      if (t.hornT <= 0 && veh.beh !== 'RIVAL_BLOCK') veh.horn = false;
    }
    if (t.honkT > 0) t.honkT -= dt;
    if (t.hornBoostT > 0) t.hornBoostT -= dt;
    if (t.honkAt >= 0 && S.t >= t.honkAt) {
      t.honkAt = -1;
      if (veh.v < TLV.tune.traffic.stuckV && t.lead >= 0 && t.leadGap < 8) honk(S, veh, t.lead === 0);
    }
  };

  // ---- Red runs. --------------------------------------------------------------------------------------------------------

  /** @returns {boolean} True when another run at this junction is still inside the cycle's one (GAME_DESIGN 9). */
  function runTaken(S, conn) {
    var T = S.traffic;
    var W = S.world;
    var ctrl = W.juncs[conn.junc].ctrl;
    return ctrl >= 0 && S.t - T.redRunAt[conn.junc] < W.ctrls[ctrl].cycleS;
  }

  /** Commits a car to running this connector's light. */
  function commitRun(S, veh, c) {
    var conn = S.world.conns[c];
    veh._t.runRed = c;
    S.traffic.redRunAt[conn.junc] = S.t;
    beh.set(S, veh, 'RED_RUN');
  }

  /** The two ambient triggers: a late run at the stop decision, and a jump start from the queue head. */
  function redLogic(S, veh) {
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var W = S.world;
    var SIG = TLV.const.SIG;
    var signals = TLV.world.signals;
    // A long body caught half way across is a junction shut for a whole cycle, and it was never going to make it.
    if (t.pn === 0 || veh.length > Q.longBody) return;
    var index = 0;
    while (index < t.pn && W.conns[t.plan[index]].slot < 0) index++;
    if (index >= t.pn) return;
    var c = t.plan[index];
    if (index > t.pg) return;
    var conn = W.conns[c];
    var st = signals.connState(S, c);
    if (st === SIG.GREEN) return;
    var nose = TLV.traffic.gate.noseTo(S, veh, index);
    var hasGrant = index < t.pg;

    if (t.decided !== c && veh.v > 1) {
      var tta = nose / veh.v;
      var stopD = veh.v * veh.v / (2 * t.b * Q.stopBrakeShare);
      if (st === SIG.AMBER || signals.stateAt(S, c, S.t - Q.redLateS) !== SIG.RED) {
        var left = st === SIG.AMBER ? signals.timeToRed(S, c) + Q.redLateS : Q.redLateS;
        if (tta < 4) {
          t.decided = c;
          var lateP = Math.min(Q.redBoostMax, Q.redLateP * nearBoost(S, veh));
          if (veh.ag > Q.redLateAg && tta <= left && !runTaken(S, conn) && S.rng.traffic.bool(lateP)) {
            commitRun(S, veh, c);
            return;
          }
          if (hasGrant && nose > stopD) TLV.traffic.gate.revokeFrom(S, veh, index);
          return;
        }
      } else if (hasGrant && nose > stopD) {
        TLV.traffic.gate.revokeFrom(S, veh, index);
        return;
      }
    }

    if (!hasGrant && st === SIG.RED && nose < 3 && veh.v < 1 && veh.ag > Q.redJumpAg) {
      var ttg = signals.timeToGreen(S, c);
      var ctrl = W.ctrls[W.juncs[conn.junc].ctrl];
      var cycle = Math.floor((S.t + ttg) / ctrl.cycleS);
      if (ttg < Q.redJumpS && ttg > 0 && t.jumpCycle !== cycle) {
        t.jumpCycle = cycle;
        var jumpP = Math.min(Q.redBoostMax, Q.redJumpP * nearBoost(S, veh));
        if (!runTaken(S, conn) && S.rng.traffic.bool(jumpP)) commitRun(S, veh, c);
      }
    }
  }

  /**
   * A car went over the line of the connector it chose to run.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {object} conn Connector.
   */
  beh.crossedOnRed = function (S, veh, conn) {
    if (TLV.world.signals.connState(S, conn.id) === TLV.const.SIG.RED) {
      emit(S, 'traffic.redRun', { vehId: veh.id, juncId: conn.junc });
    }
  };

  function fsmRedRun(S, veh) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    var live = false;
    var c = t.runRed;
    for (var i = 0; i < t.hn; i++) {
      if (t.held[i] === c) live = true;
    }
    for (var k = 0; k < t.pn; k++) {
      if (t.plan[k] === c) live = true;
    }
    if (!live || veh.behT > Q.overTimeoutS) beh.toCruise(S, veh);
  }

  // ---- Nose in. ---------------------------------------------------------------------------------------------------------

  /**
   * A side-road car shoves onto a busier lane, on a gap far shorter than a normal driver takes (GAME_DESIGN 9). Cars that hold a
   * grant and are still short of the junction lose it and brake for the line. Those already in the junction are never overridden.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {number} c Connector it wants.
   * @param {number} nose Metres from the nose to the line.
   * @param {number} why Why the gate refused.
   * @returns {boolean} True when it got the grant.
   */
  beh.tryNose = function (S, veh, c, nose, why) {
    var T = S.traffic;
    var W = S.world;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var conn = W.conns[c];
    var forced = veh.beh === 'NOSE_IN';
    if (!forced) {
      var least = Q.noseAg - (nearBoost(S, veh) > 1 ? Q.nearBolder : 0);
      if (veh.beh !== 'CRUISE' || veh.ag < least || T.count.NOSE_IN >= Q.noseMax || t.waitT < Q.noseWaitS) return false;
      if (W.lanes[conn.to].cls >= W.lanes[conn.from].cls) return false;
    }
    if (nose > Q.grantBase) return false;
    if (t.gapS <= 0) t.gapS = S.rng.traffic.range(Q.noseGapMin, Q.noseGapMax);
    if (TLV.traffic.gate.exitWhy(S, veh, conn) !== TLV.traffic.gate.WHY.OK || !TLV.traffic.gate.crossClear(S, veh, c)) return false;
    if (!TLV.traffic.gate.bump(S, veh, c, t.gapS, Q.noseFollowBrake)) return false;
    TLV.traffic.gate.grant(S, veh, c);
    t.gapS = 0;
    t.noseConn = c;
    beh.set(S, veh, 'NOSE_IN');
    return true;
  };

  function fsmNoseIn(S, veh) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    if (veh.behT > Q.noseTimeoutS) {
      beh.toCruise(S, veh);
      return;
    }
    if (t.noseConn >= 0) {
      var i;
      for (i = 0; i < t.hn; i++) {
        if (t.held[i] === t.noseConn) return;
      }
      for (i = 0; i < t.pn; i++) {
        if (t.plan[i] === t.noseConn) return;
      }
      beh.toCruise(S, veh);
      return;
    }
    if (t.lcTo < 0 && Math.abs(veh.lat) < 0.1) beh.toCruise(S, veh);
  }

  // ---- Tailgate. --------------------------------------------------------------------------------------------------------

  function tryTailgate(S, veh) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    if (veh.ag <= Q.tailAg || t.lead !== 0 || !t.leadSame || t.leadGap > Q.tailM || t.tailCool > 0) return false;
    if (T.count.TAILGATE >= Q.tailMax) return false;
    if (S.vehicles[0].laneId !== veh.laneId) return false;
    startTailgate(S, veh, 0, S.rng.traffic.range(Q.tailMinS, Q.tailMaxS));
    return true;
  }

  function startTailgate(S, veh, targetSlot, durS) {
    var t = veh._t;
    clearState(veh);
    t.target = targetSlot;
    t.timer = durS;
    t.tailHornT = 0;
    t.tailClosed = false;
    t.tailLost = 0;
    veh.lights |= TLV.const.VL.HIGH_BEAM;
    beh.set(S, veh, 'TAILGATE');
    followRoute(S, veh);
  }

  /** A car on someone's bumper turns where they turn. A random walk would peel off at the first junction, whatever the clock says. */
  function followRoute(S, veh) {
    var t = veh._t;
    var route = t.target === 0 && S.game && S.game.nav ? S.game.nav.route : null;
    if (!route || t.route === route) return;
    if (t.route && !t.tailRoute) return;
    t.route = route;
    t.ri = 0;
    t.tailRoute = true;
    TLV.traffic.gate.clearPlan(S, veh);
    TLV.traffic.gate.extend(S, veh);
  }

  /**
   * @param {object} veh Vehicle.
   * @returns {boolean} True for a car near the end of a tailgate of the player, which goes past him if the road lets it.
   */
  beh.tailReady = function (veh) {
    var t = veh._t;
    return veh.beh === 'TAILGATE' && veh.mode === 'LANE' && t.target === 0 && t.tailClosed && t.timer <= TLV.tune.traffic.tailDiveLastS;
  };

  /** Ends a tailgate, for this car a while. */
  function endTailgate(S, veh) {
    veh._t.tailCool = TLV.tune.traffic.tailCoolS;
    beh.toCruise(S, veh);
  }

  /**
   * Ends a tailgate that has hit its target.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   */
  beh.backOff = function (S, veh) {
    endTailgate(S, veh);
  };

  /**
   * The clock is the time spent on the target's bumper with it moving, because a car still catching up, or stopped behind it at a
   * red, is not yet tailgating anybody. At speed a car takes some seconds to close, and a clock running from the start of the
   * behaviour ended the episode before it got there.
   */
  function fsmTailgate(S, veh, dt) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    t.tailHornT -= dt;
    var target = S.vehicles[t.target];
    var dx = target.x - veh.x;
    var dy = target.y - veh.y;
    var far = dx * dx + dy * dy > Q.tailLostM * Q.tailLostM;
    followRoute(S, veh);
    t.tailLost = t.lead === t.target ? 0 : t.tailLost + dt;
    if (!target.active || far || t.tailLost > Q.tailLostS || veh.behT > Q.tailEpisodeS) {
      endTailgate(S, veh);
      return;
    }
    if (t.lead === t.target && t.leadGap <= Q.tailCloseM) t.tailClosed = true;
    if (!t.tailClosed) {
      if (veh.behT > Q.tailCloseMaxS) endTailgate(S, veh);
      return;
    }
    if (target.v > Q.tailRunV) t.timer -= dt;
    if (t.timer <= 0) {
      endTailgate(S, veh);
      return;
    }
    // The bumper is where a pass of the player starts. At the end of its patience it goes, as soon as the road lets it.
    var T = S.traffic;
    if (beh.tailReady(veh) && overCount(T) < Q.overMax && !(T.calmOn && T.calm[S.world.lanes[veh.laneId].dirEdge])) {
      t.tailCool = Q.tailCoolS;
      if (tryOvertake(S, veh, true, target) || tryOvertake(S, veh, false, target)) return;
    }
    if (t.tailHornT <= 0) {
      t.tailHornT = Q.tailHornS;
      t.honkT = 0;
      honk(S, veh, t.target === 0);
    }
  }

  // ---- Overtake. --------------------------------------------------------------------------------------------------------

  /** Distance to the nearest car coming the other way on the opposite lane, and its speed. Into T.rGap and T.rV. */
  function oncoming(S, laneId, atS) {
    var T = S.traffic;
    T.rGap = Infinity;
    T.rV = 0;
    if (T.mark[laneId] !== T.stamp) return;
    for (var e = T.head[laneId]; e >= 0; e = T.eNext[e]) {
      if (T.eS[e] >= atS) break;
      var d = atS - T.eS[e] - T.eHalf[e];
      T.rGap = d;
      T.rV = T.eV[e];
    }
  }

  /** @returns {boolean} True when the player's route takes him onto this lane soon: nobody passes on the side he is about to move to. */
  function playerHeadsFor(S, laneId) {
    var Q = TLV.tune.traffic;
    var nav = S.game && S.game.nav;
    var route = nav ? nav.route : null;
    if (!route) return false;
    var T = S.traffic;
    TLV.math.polyAt(route.px, route.py, route.cum, nav.s + Q.overHeadsM, T.at);
    var near = TLV.world.lanes.project(S.world, T.at.x, T.at.y, T.at.h, 3, T.projLane);
    return !!near && near.laneId === laneId;
  }

  /** @returns {boolean} True when someone is on a crossing in the road a pass of the player runs down, at more than a car can stop from. */
  function crossingBusy(S, laneId, from, need) {
    var W = S.world;
    var peds = TLV.peds;
    if (!peds || !peds.zoneOccupied) return false;
    var zones = W.lanes[laneId].zones;
    for (var i = 0; i < zones.length; i++) {
      var z = W.zones[zones[i]];
      if (z.s1 >= from && z.s0 <= from + need && peds.zoneOccupied(S, z.id)) return true;
    }
    return false;
  }

  /** @returns {boolean} True when nothing slower on a lane stands in the road a pass of the player needs. */
  function laneOpen(S, veh, laneId, at, need) {
    var Q = TLV.tune.traffic;
    var nb = TLV.traffic.idm.neighbours(S, laneId, at, veh._t.halfL, veh.slot, S.traffic.gapBuf);
    return nb.lead < 0 && nb.lead !== -1 ? true : nb.leadGap >= need * Q.overLaneShare || nb.leadV >= S.vehicles[0].v + Q.overRel;
  }

  /** The speed a pass runs at: past the player it is his speed and a margin, within what the car can be asked for. */
  function passSpeed(veh, o, limit) {
    var Q = TLV.tune.traffic;
    var vp = limit * Q.overSpeed;
    if (o.isPlayer) {
      var over = o.v + Q.overRel;
      var top = limit * Q.overPlayerMax;
      if (over > top) over = top;
      if (over > vp) vp = over;
    }
    return vp;
  }

  /** Metres of road a pass takes, and its time, from the gap and speeds. Into t.timer's sibling fields it does not touch. */
  function passDistance(veh, t, o, limit, gap, leadV) {
    var Q = TLV.tune.traffic;
    var vp = passSpeed(veh, o, limit);
    var rel = vp - leadV;
    if (rel < 2) rel = 2;
    var cut = o.isPlayer ? leadV * Q.overCutMin + 1.5 : leadV * Q.overCutMax + 3;
    var span = gap + o.length + veh.length + cut;
    return span / rel * vp;
  }

  /**
   * Starts an overtake. mode 1 uses the opposite lane, 2 a neighbouring lane.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {boolean} force True to go straight for the opposite lane.
   * @param {?object} [only] The car to pass, when the command names one: its body on this car's lane stands in for the leader.
   * @returns {boolean} True when it started.
   */
  function tryOvertake(S, veh, force, only) {
    var T = S.traffic;
    var W = S.world;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    if (t.lead < 0 || !t.leadSame || t.leadGap > 30) return false;
    var o = S.vehicles[t.lead];
    if (only && o !== only) return false;
    var fast = o.isPlayer;
    var lane = W.lanes[veh.laneId];
    var limit = lane.vmax * t.vf;
    var need = passDistance(veh, t, o, limit, t.leadGap, t.leadV);
    var left = lane.len - veh.s;
    if (left < need + (fast ? Q.overPlayerPad : Q.overRoomPad)) return false;
    if (TLV.traffic.lanechange.sharpBetween(S, lane.id, veh.s - t.halfL, veh.s + need + Q.laneBendClear)) return false;
    if (t.lcTo >= 0 || Math.abs(veh.lat) > 0.1) return false;
    if (veh.s < t.halfL + 1) return false;
    var oS = veh.s + t.leadGap + t.halfL + o.length / 2;
    var nb = TLV.traffic.idm.neighbours(S, veh.laneId, oS, o.length / 2, o.slot, T.gapBuf);
    var room = veh.length + (fast ? Q.overPlayerFront : Q.overFrontGap);
    if (nb.leadGap < room) return false;
    if (t.lineD - (t.leadGap + o.length + t.halfL) < room + (fast ? Q.overPlayerPad : Q.overRoomPad)) return false;
    var pass = need / passSpeed(veh, o, limit);
    var out = lane.left >= 0 ? lane.left : lane.right;
    if (out >= 0 && !force) {
      if (fast && (!laneOpen(S, veh, out, oS, need) || playerHeadsFor(S, out) || crossingBusy(S, out, veh.s, need))) return false;
      if (!TLV.traffic.lanechange.tryChange(S, veh, out, Q.laneGapMin, t.safeB)) return false;
      var blink = veh.lights & (TLV.const.VL.BLINK_L | TLV.const.VL.BLINK_R);
      clearState(veh);
      veh.lights |= blink;
      t.ovMode = 2;
      t.ovLane = lane.id;
      t.ovLead = o.slot;
      t.ovFast = fast;
      t.easeDown = fast;
      t.gapS = S.rng.traffic.range(Q.overCutMin, Q.overCutMax);
      beh.set(S, veh, 'OVERTAKE_OUT');
      return true;
    }
    if (lane.opposite < 0 || (fast && crossingBusy(S, lane.id, veh.s, need))) return false;
    var opp = W.lanes[lane.opposite];
    TLV.math.polyProject(opp.px, opp.py, opp.cum, veh.x, veh.y, -1, T.proj);
    var oppS = T.proj.s;
    var oppW = T.proj.d;
    oncoming(S, lane.opposite, oppS);
    // Both cars close on each other for the whole of the pass, so it is the pass and their share of it, not the pass and a guess at the limit.
    var clearRoad = need + Math.max(T.rV, 0) * pass + (fast ? Q.overOncomingPad : opp.vmax * pass * 0.5 + 10);
    if (T.rGap < clearRoad) return false;
    clearState(veh);
    TLV.traffic.gate.clearPlan(S, veh);
    TLV.traffic.gate.extend(S, veh);
    var oLat = t.lead === 0 ? (S.player.lat || 0) : o.lat;
    t.ovMode = 1;
    t.ovFast = fast;
    t.easeDown = fast;
    t.ovLead = o.slot;
    t.oppLane = lane.opposite;
    t.oppRef = veh.s;
    t.oppS = oppS;
    t.oppW = oppW;
    t.latT = oLat + o.width / 2 + Q.overLatGap + t.halfW;
    t.latR = Q.overLatRate;
    t.gapS = S.rng.traffic.range(Q.overCutMin, Q.overCutMax);
    veh.lights |= TLV.const.VL.BLINK_L;
    beh.set(S, veh, 'OVERTAKE_OUT');
    return true;
  }

  /**
   * A car on the lane beside the player, behind him, is already where a pass begins: it needs only the speed, and a place to come
   * back to. mode 2, from the OVERTAKE_PASS stage.
   * @returns {boolean} True when it started.
   */
  function passFromBeside(S, veh, o) {
    var W = S.world;
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var lane = W.lanes[veh.laneId];
    var back = S.player.laneId;
    if (back < 0 || t.lcTo >= 0 || Math.abs(veh.lat) > 0.1) return false;
    if (lane.left !== back && lane.right !== back) return false;
    var behind = (o.x - veh.x) * t.cosH + (o.y - veh.y) * t.sinH - t.halfL - o.length / 2;
    if (behind < -veh.length - o.length || behind > Q.tailM) return false;
    var limit = lane.vmax * t.vf;
    var need = passDistance(veh, t, o, limit, behind > 0 ? behind : 0, o.v);
    if (lane.len - veh.s < need + Q.overPlayerPad || !laneOpen(S, veh, lane.id, veh.s, need) || playerHeadsFor(S, lane.id) || crossingBusy(S, lane.id, veh.s, need)) return false;
    if (TLV.traffic.lanechange.sharpBetween(S, lane.id, veh.s - t.halfL, veh.s + need + Q.laneBendClear)) return false;
    var ahead = W.lanes[back];
    var nb = TLV.traffic.idm.neighbours(S, back, T.pS, o.length / 2, 0, T.gapBuf);
    if (nb.leadGap < veh.length + Q.overPlayerFront || ahead.len - T.pS < veh.length + Q.overPlayerPad) return false;
    clearState(veh);
    t.ovMode = 2;
    t.ovLane = back;
    t.ovLead = o.slot;
    t.ovFast = true;
    t.easeDown = true;
    t.gapS = S.rng.traffic.range(Q.overCutMin, Q.overCutMax);
    beh.set(S, veh, 'OVERTAKE_OUT');
    beh.set(S, veh, 'OVERTAKE_PASS');
    return true;
  }

  /** @returns {number} Metres from my rear to the front of the car being passed. */
  function clearOf(S, veh, o) {
    var t = veh._t;
    var dx = veh.x - o.x;
    var dy = veh.y - o.y;
    return dx * t.cosH + dy * t.sinH - t.halfL - o.length / 2;
  }

  /** Checks the head-on rule. @returns {boolean} True when the pass must stop. */
  function headOn(S, veh) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    if (t.ovMode !== 1 || t.oppLane < 0) return false;
    oncoming(S, t.oppLane, t.oppS - (veh.s - t.oppRef));
    if (T.rGap === Infinity) return false;
    var closing = veh.v + Math.max(T.rV, 0);
    if (closing < 0.5) return false;
    return T.rGap / closing < Q.overAbortTtc;
  }

  function fsmOvertake(S, veh) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    var o = t.ovLead >= 0 ? S.vehicles[t.ovLead] : null;
    var gone = !o || !o.active;
    if (veh.mode !== 'LANE') {
      endOvertake(S, veh);
      return;
    }
    if (veh.behT > Q.overTimeoutS) {
      if (t.ovMode === 1) cutIn(S, veh);
      else endOvertake(S, veh);
      return;
    }
    if (t.ovMode === 1) {
      var roadLeft = S.world.lanes[veh.laneId].len - veh.s;
      var ending = t.ovFast ? veh.v * veh.v / Q.overPlayerStop + Q.overPlayerEndClear : veh.v * veh.v / 6 + Q.overEndClear;
      if (headOn(S, veh) || roadLeft < ending) {
        if (gone || clearOf(S, veh, o) > -veh.length) {
          cutIn(S, veh);
        } else {
          t.ovAbort = true;
          t.capV = Math.max(0, (gone ? 0 : o.v) - 1.5);
          t.latT = veh.lat;
          beh.set(S, veh, 'CUT_IN');
        }
        return;
      }
      if (veh.beh === 'OVERTAKE_OUT') {
        if (Math.abs(t.latT - veh.lat) < 0.2) beh.set(S, veh, 'OVERTAKE_PASS');
        return;
      }
      if (gone || clearOf(S, veh, o) >= Math.max(1.5, o.v * t.gapS)) cutIn(S, veh);
      return;
    }
    // On a neighbouring lane.
    if (veh.beh === 'OVERTAKE_OUT') {
      if (t.lcTo < 0) beh.set(S, veh, 'OVERTAKE_PASS');
      return;
    }
    if (gone) {
      beh.toCruise(S, veh);
      return;
    }
    // A change that turned round on the way out left the car where it began, with nothing to come back from.
    if (veh.laneId === t.ovLane) {
      endOvertake(S, veh);
      return;
    }
    if (clearOf(S, veh, o) >= Math.max(1.5, o.v * t.gapS)) {
      var back = t.ovLane;
      var lc = TLV.traffic.lanechange;
      if (back >= 0 && (t.ovFast ? lc.cutIn(S, veh, back, 0.3, Q.noseFollowBrake) : lc.tryChange(S, veh, back, 0.3, Q.noseFollowBrake))) beh.set(S, veh, 'CUT_IN');
    }
  }

  function cutIn(S, veh) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    t.latT = 0;
    t.latR = Q.overCutRate;
    t.capV = Infinity;
    beh.set(S, veh, 'CUT_IN');
    veh.lights &= ~TLV.const.VL.BLINK_L;
    veh.lights |= TLV.const.VL.BLINK_R;
  }

  /** @returns {boolean} True when the stretch of lane the car wants to return to is free. */
  function laneFree(S, veh) {
    var T = S.traffic;
    var t = veh._t;
    var nb = TLV.traffic.idm.neighbours(S, veh.laneId, veh.s, t.halfL, veh.slot, T.gapBuf);
    return nb.leadGap > 0.8 && nb.follGap > 0.8;
  }

  function fsmCutIn(S, veh) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    if (t.ovMode === 2) {
      if (t.lcTo < 0) endOvertake(S, veh);
      return;
    }
    if (!t.ovAbort && t.ovMode === 1 && Math.abs(veh.lat) > t.halfW) t.latT = laneFree(S, veh) ? 0 : veh.lat;
    if (t.ovAbort) {
      var o = t.ovLead >= 0 ? S.vehicles[t.ovLead] : null;
      if (!o || !o.active || clearOf(S, veh, o) < -(veh.length + o.length) / 2 - 0.5) {
        t.ovAbort = false;
        t.latT = 0;
        t.latR = Q.overCutRate;
        t.capV = Infinity;
      }
      if (veh.behT > Q.overTimeoutS) t.ovAbort = false;
      return;
    }
    if (Math.abs(veh.lat) < 0.06) {
      endOvertake(S, veh);
      return;
    }
    // Still out in the other lane with no way back in: it does not get to call that cruising, and the ladder takes it off the road.
    if (veh.behT > Q.overTimeoutS) {
      t.latT = 0;
      t.latR = Q.overCutRate;
      if (veh.behT > 2 * Q.overTimeoutS) {
        if (TLV.traffic.visibleToPlayer(S, veh.x, veh.y)) TLV.traffic.deadlock.pullOver(S, veh);
        else TLV.traffic.despawn(S, veh, 'watchdog');
      }
    }
  }

  function endOvertake(S, veh) {
    beh.toCruise(S, veh);
  }

  // ---- Stops in the lane. -----------------------------------------------------------------------------------------------

  /** @returns {boolean} True where a stop in the lane is allowed. */
  function stopAllowed(lane, veh) {
    var Q = TLV.tune.traffic;
    if (lane.flags & TLV.const.LF.EXCLUSIVE) return false;
    var stopD = veh.v * veh.v / 4;
    return veh.s > Q.junctionClear && lane.len - veh.s - stopD > Q.junctionClear;
  }

  function startPhantom(S, veh, decel, holdS) {
    var t = veh._t;
    clearState(veh);
    t.forceA = -decel;
    t.timer = clampHold(S, veh, holdS);
    beh.set(S, veh, 'PHANTOM_STOP');
  }

  function startDouble(S, veh, holdS) {
    var t = veh._t;
    clearState(veh);
    t.forceA = -TLV.tune.traffic.doubleBrake;
    t.timer = clampHold(S, veh, holdS);
    veh.lights |= TLV.const.VL.HAZARD;
    beh.set(S, veh, 'DOUBLE_PARK');
  }

  /** Phantom stops and double parking: brake, stand, then go. */
  function fsmStand(S, veh, dt) {
    var t = veh._t;
    if (veh.v > 0.2) return;
    if (t.stage === 0) {
      t.stage = 1;
      t.forceA = -2;
    }
    capBlocker(S, veh);
    t.timer -= dt;
    if (t.timer <= 0) beh.toCruise(S, veh);
  }

  /** Begins a drop-off stop. */
  function startDrop(S, veh, holdS, door, passenger) {
    var W = S.world;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var lane = W.lanes[veh.laneId];
    var ahead = Math.max(Q.dropAheadM, veh.v * veh.v / (2 * 2.5) + 4);
    var stopAt = Math.min(veh.s + ahead, lane.len - Q.junctionClear);
    clearState(veh);
    t.stopS = stopAt;
    t.latT = -shiftTo(S, veh, stopAt);
    t.latR = 0.8;
    t.timer = holdS;
    t.doorKind = door === 'curb' ? 2 : 1;
    t.passenger = passenger;
    t.spawnedPed = false;
    t.doorT = 0;
    beh.set(S, veh, 'DROP_APPROACH');
  }

  function fsmDropApproach(S, veh) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    var VL = TLV.const.VL;
    var left = t.stopS - veh.s;
    if (left < Math.max(veh.v * Q.dropHazardS * 1.5, 3)) veh.lights |= VL.HAZARD;
    if (veh.behT > 15) {
      beh.toCruise(S, veh);
      return;
    }
    if (veh.v < 0.2 && left < 1.5) {
      t.timer = clampHold(S, veh, t.timer);
      veh.lights |= VL.HAZARD;
      beh.set(S, veh, 'DROPPED');
    }
  }

  /** @returns {boolean} True when nothing is passing on the door's side: a passenger steps out into a gap, not in front of a car. */
  function doorClear(S, veh) {
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var side = t.doorKind === 1 ? 1 : -1;
    var n = t.nearN;
    for (var k = 0; k < n; k++) {
      var o = S.vehicles[t.near[k]];
      if (!o.active || o.isPlayer || o.v < Q.doorMovingV) continue;
      var dx = o.x - veh.x;
      var dy = o.y - veh.y;
      var d2 = dx * dx + dy * dy;
      var r = Q.doorClearM + o.v * o.v / 16;
      if (d2 > r * r) continue;
      if ((dy * t.cosH - dx * t.sinH) * side > 0) return false;
    }
    return true;
  }

  function spawnPassenger(S, veh) {
    var t = veh._t;
    var peds = TLV.peds;
    var side = t.doorKind === 1 ? 1 : -1;
    var off = t.halfW + 0.6;
    t.spawnedPed = true;
    if (!t.passenger || !peds || !peds.spawn) return;
    peds.spawn(S, {
      kind: 'passenger',
      x: veh.x - t.sinH * off * side,
      y: veh.y + t.cosH * off * side,
      h: veh.h,
      state: 'DROPPED'
    });
  }

  function fsmDropped(S, veh, dt) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    t.doorT += dt;
    // The stop line is up to 1.5 m on, and a door stays shut until the car stands on it: a passenger does not step out of a rolling car.
    if (veh.door === 0 && !t.spawnedPed && t.doorT >= Q.dropDoorS && veh.v < Q.dropStillV && doorClear(S, veh)) {
      veh.door = t.doorKind;
      emit(S, 'traffic.door', { vehId: veh.id, open: true });
      spawnPassenger(S, veh);
    }
    capBlocker(S, veh);
    t.timer -= dt;
    if (t.timer > 0) return;
    if (veh.door) {
      veh.door = 0;
      emit(S, 'traffic.door', { vehId: veh.id, open: false });
    }
    veh.lights &= ~TLV.const.VL.HAZARD;
    veh.lights |= TLV.const.VL.BLINK_L;
    t.stage = 0;
    t.gapS = S.rng.traffic.range(Q.noseGapMin, Q.noseGapMax);
    beh.set(S, veh, 'PULLOUT');
  }

  /** @returns {boolean} True when the car behind leaves the gap a pull-out accepts. */
  function gapBehind(S, veh) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var nb = TLV.traffic.idm.neighbours(S, veh.laneId, veh.s, t.halfL, veh.slot, T.gapBuf);
    if (nb.foll < 0) return true;
    if (nb.follV < 0.5) return true;
    return nb.follGap >= Q.noseMinM && nb.follGap / nb.follV >= t.gapS;
  }

  function fsmPullout(S, veh) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    if (veh.mode !== 'LANE') {
      if (veh.behT > Q.pullWaitS + 4) beh.toCruise(S, veh);
      return;
    }
    if (gapBehind(S, veh) || veh.behT >= Q.pullWaitS) {
      t.stopS = -1;
      t.latT = 0;
      t.latR = 1;
      t.noseConn = -1;
      veh.lights &= ~TLV.const.VL.BLINK_L;
      beh.set(S, veh, 'NOSE_IN');
    }
  }

  // ---- Bus. -------------------------------------------------------------------------------------------------------------

  function tryBus(S, veh) {
    var W = S.world;
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    if (veh.kind !== 'bus' || t.busCool > 0) return false;
    var lane = W.lanes[veh.laneId];
    if (!lane.stops.length) return false;
    for (var i = 0; i < lane.stops.length; i++) {
      var stop = W.stops[lane.stops[i]];
      TLV.math.polyProject(lane.px, lane.py, lane.cum, stop.x, stop.y, -1, T.proj);
      var d = T.proj.s - veh.s;
      var brake = veh.v * veh.v / (2 * 2.2) + 2;
      if (d < brake || d > Q.busLookM) continue;
      if (lane.len - T.proj.s < t.halfL + 3) continue;
      clearState(veh);
      var stopAt = T.proj.s;
      t.stopS = stopAt;
      t.latT = -shiftTo(S, veh, stopAt);
      t.latR = 0.6;
      t.timer = S.rng.traffic.range(Q.busStopMinS, Q.busStopMaxS);
      beh.set(S, veh, 'BUS_APPROACH');
      return true;
    }
    return false;
  }

  function fsmBusApproach(S, veh) {
    var t = veh._t;
    if (veh.behT > 20) {
      t.busCool = TLV.tune.traffic.busCoolS;
      beh.toCruise(S, veh);
      return;
    }
    if (veh.v < 0.2 && t.stopS - veh.s < 2.5) {
      t.timer = clampHold(S, veh, t.timer);
      veh.lights |= TLV.const.VL.HAZARD;
      beh.set(S, veh, 'BUS_STOPPED');
    }
  }

  function fsmBusStopped(S, veh, dt) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    capBlocker(S, veh);
    t.timer -= dt;
    if (t.timer > 0) return;
    veh.lights &= ~TLV.const.VL.HAZARD;
    t.gapS = S.rng.traffic.range(Q.noseGapMin, Q.noseGapMax);
    t.busCool = Q.busCoolS;
    beh.set(S, veh, 'BUS_PULLOUT');
  }

  function fsmBusPullout(S, veh) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    if (t.stage === 0) {
      if (gapBehind(S, veh) || veh.behT >= Q.pullWaitS) {
        t.stopS = -1;
        t.latT = 0;
        t.latR = 0.8;
        t.stage = 1;
      }
      return;
    }
    if (Math.abs(veh.lat) < 0.1 || veh.behT > 15) beh.toCruise(S, veh);
  }

  // ---- Ambient triggers. ------------------------------------------------------------------------------------------------

  /**
   * How much sooner a car misbehaves for being where the player can see it. Most of the bubble is behind buildings or behind the
   * player, and a stop or a run nobody sees is no use to anyone. The design's rates stand for the rest.
   * @returns {number} Q.nearBoost ahead of the player and in reach, else 1.
   */
  function nearBoost(S, veh) {
    var Q = TLV.tune.traffic;
    var p = S.player;
    if (!p) return 1;
    var dx = veh.x - p.fx;
    var dy = veh.y - p.fy;
    if (dx * dx + dy * dy > Q.nearM * Q.nearM) return 1;
    var me = S.vehicles[0];
    return dx * Math.cos(me.h) + dy * Math.sin(me.h) > 0 ? Q.nearBoost : 1;
  }

  /** Slow-leader clock for the overtake trigger. */
  function trackSlow(S, veh, dt) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    var lane = S.world.lanes[veh.laneId];
    if (!lane || t.lead < 0 || !t.leadSame || t.leadGap > 30) {
      t.slowT = 0;
      return;
    }
    if (t.leadV < Q.overSlowShare * lane.vmax * t.vf) t.slowT += dt;
    else t.slowT = 0;
  }

  function cruise(S, veh, dt) {
    var T = S.traffic;
    var W = S.world;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var rng = S.rng.traffic;
    if (t.tailCool > 0) t.tailCool -= dt;
    if (t.busCool > 0) t.busCool -= dt;
    redLogic(S, veh);
    if (veh.beh !== 'CRUISE' || veh.mode !== 'LANE') return;
    trackSlow(S, veh, dt);
    if (t.lcTo >= 0) return;
    if (tryTailgate(S, veh)) return;
    var lane = W.lanes[veh.laneId];
    var boost = nearBoost(S, veh);
    var bolder = boost > 1 ? Q.nearBolder : 0;
    if (t.slowT >= Q.overSlowS && veh.ag > Q.overAg - bolder && overCount(T) < Q.overMax && tryOvertake(S, veh, false)) return;
    // Nobody here sits behind a car that is in their way, and to these drivers the player is always in their way.
    if (t.lead === 0 && t.leadGap <= Q.overPlayerM && veh.ag > Q.overAg - bolder && S.t >= T.passT && overCount(T) < Q.overMax &&
        !(T.calmOn && T.calm[lane.dirEdge]) && (tryOvertake(S, veh, true, S.vehicles[0]) || tryOvertake(S, veh, false, S.vehicles[0]))) {
      T.passT = S.t + Q.overPlayerCoolS;
      return;
    }
    if (tryBus(S, veh)) return;
    // Each rate is a clock on the car, per minute of its life, that goes off at the first place it may act. A chance per evaluation
    // would be spent on cars standing at lights, and the rates would fall to a fifth of what the design asks for. Out of the player's
    // sight the clock runs slow: a blocker nobody can see costs a queue and buys nothing.
    var clock = boost > 1 ? dt : dt * Q.blockerAway;
    t.duePhantom -= clock;
    t.dueDouble -= clock;
    t.dueDrop -= clock;
    if (veh.v > 3 && stopAllowed(lane, veh) && !(T.calmOn && T.calm[lane.dirEdge])) {
      if (t.duePhantom <= 0 && T.count.PHANTOM_STOP < Q.phantomMax) {
        t.duePhantom = TLV.traffic.pool.nextDue(rng, Q.phantomRate);
        startPhantom(S, veh, rng.range(Q.phantomBrakeMin, Q.phantomBrakeMax), rng.range(Q.phantomMinS, Q.phantomMaxS));
        return;
      }
      if (t.dueDouble <= 0 && T.count.DOUBLE_PARK < Q.doubleMax) {
        t.dueDouble = TLV.traffic.pool.nextDue(rng, Q.doubleRate);
        startDouble(S, veh, rng.range(Q.doubleMinS, Q.doubleMaxS));
        return;
      }
      var drops = T.count.DROP_APPROACH + T.count.DROPPED + T.count.PULLOUT;
      if (t.dueDrop <= 0 && lane.right < 0 && drops < Q.dropMax && veh.kind !== 'bus' && veh.kind !== 'truck') {
        t.dueDrop = TLV.traffic.pool.nextDue(rng, Q.dropRate);
        startDrop(S, veh, rng.range(Q.dropMinS, Q.dropMaxS), 'traffic', true);
        return;
      }
    }
    // An aggressive driver stuck behind a slow car waits for the overtake, so as to cut back in front of it, not merely go round.
    if (veh.ag > Q.overAg && t.slowT > 0 && t.slowT < Q.overSlowS) return;
    TLV.traffic.lanechange.consider(S, veh);
  }

  /** @returns {number} Overtakes under way. */
  function overCount(T) {
    return T.count.OVERTAKE_OUT + T.count.OVERTAKE_PASS + T.count.CUT_IN;
  }

  // ---- Park race. -------------------------------------------------------------------------------------------------------

  function raceEvent(S, veh, stage) {
    emit(S, 'traffic.parkRace', { vehId: veh.id, stage: stage, spotId: veh._t.raceSpot });
  }

  function raceFail(S, veh) {
    raceEvent(S, veh, 'FAILED');
    beh.toCruise(S, veh);
  }

  /** Routes a racing car to its stall, at most once per routeEveryS (ARCHITECTURE 12.5). */
  function raceRoute(S, veh, spot) {
    var t = veh._t;
    var W = S.world;
    var Q = TLV.tune.traffic;
    if (S.t < t.routeT) return;
    t.routeT = S.t + Q.routeEveryS;
    var from = veh.mode === 'LANE' ? veh.laneId : W.conns[veh.connId].to;
    var fromS = veh.mode === 'LANE' ? veh.s : 0;
    var route = TLV.world.routing.routeLanes(W, from, fromS, spot.laneId, spot.laneS, { ai: true }) ||
      TLV.world.routing.routeLanes(W, from, fromS, spot.laneId, spot.laneS, {});
    if (route) {
      t.route = route;
      t.ri = 0;
      TLV.traffic.gate.clearPlan(S, veh);
      TLV.traffic.gate.extend(S, veh);
    }
  }

  /** @returns {number} Metres along the road to the stall, or Infinity once past it or off the route. */
  function raceLeft(S, veh, spot) {
    var W = S.world;
    var T = S.traffic;
    var t = veh._t;
    if (veh.mode === 'LANE' && W.lanes[veh.laneId].dirEdge === W.lanes[spot.laneId].dirEdge) {
      var d = spot.laneS - veh.s;
      return d >= 0 ? d : Infinity;
    }
    if (!t.route) return Infinity;
    var p = TLV.world.routing.project(t.route, veh.x, veh.y, null, T.proj);
    return p.d > 12 ? Infinity : t.route.len - p.s;
  }

  /** @returns {number} +1 when a stall's kerb is left of travel on its lane, -1 when right. */
  function curbSign(S, veh, spot) {
    var d = S.world.lanes[spot.laneId].dirEdge % 2;
    return (spot.side === 0) === (d === 0) ? 1 : -1;
  }

  function fsmRace(S, veh, dt) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    var W = S.world;
    var VL = TLV.const.VL;
    var ctl = t.ctl;
    if (veh.behT >= Q.parkRaceMaxS) {
      raceFail(S, veh);
      return;
    }
    if (veh.mode !== 'LANE' && veh.mode !== 'CONN') return;
    var spot = TLV.world.parking.spot(W, t.raceSpot);
    if (!spot) {
      raceFail(S, veh);
      return;
    }
    var left = raceLeft(S, veh, spot);
    if (left === Infinity) {
      raceRoute(S, veh, spot);
      if (t.raceStage !== RACE.ROUTE) {
        t.raceStage = RACE.ROUTE;
        t.latT = 0;
        t.stopS = -1;
      }
      left = 1e6;
    }
    var onRoad = veh.mode === 'LANE' && W.lanes[veh.laneId].dirEdge === W.lanes[spot.laneId].dirEdge;
    if (onRoad && veh.laneId !== spot.laneId && t.lcTo < 0) {
      t.mustLane = spot.laneId;
      TLV.traffic.lanechange.mandatory(S, veh);
    }
    if (t.raceFromCommit && onRoad && left <= Q.parkCommitM + 4) {
      t.raceFromCommit = false;
      t.raceStage = RACE.CREEP;
    }
    var lane = veh.mode === 'LANE' ? W.lanes[veh.laneId] : null;
    if (t.raceStage === RACE.BLINK || t.raceStage === RACE.CREEP) {
      t.capV = ctl.speedScale === 0 ? 0 : Math.max(t.raceStage === RACE.BLINK ? Q.blinkV : Q.creepV, ctl.paceV || 0);
    }
    if (t.raceStage === RACE.ROUTE) {
      t.capV = (lane ? lane.vmax * t.vf : Infinity) * ctl.speedScale;
      if ((left <= Q.parkBlinkM + (ctl.blinkExtraM || 0) || ctl.blinkWaiting) && ctl.mayBlink) {
        t.raceStage = RACE.BLINK;
        veh.lights |= curbSign(S, veh, spot) > 0 ? VL.BLINK_L : VL.BLINK_R;
        t.capV = ctl.speedScale === 0 ? 0 : Q.blinkV;
        raceEvent(S, veh, 'BLINK');
      }
      return;
    }
    if (t.raceStage === RACE.BLINK) {
      if (left <= Q.parkBlinkM + (ctl.blinkExtraM || 0) - 6 || veh.v <= Q.blinkV) {
        t.raceStage = RACE.CREEP;
        t.capV = ctl.speedScale === 0 ? 0 : Q.creepV;
        if (onRoad) {
          t.latT = curbSign(S, veh, spot) * Q.creepLat;
          t.latR = 0.5;
        }
        raceEvent(S, veh, 'CREEP');
      }
      return;
    }
    if (t.raceStage === RACE.CREEP) {
      if (!onRoad || left > Q.parkCommitM) return;
      if (veh.laneId !== spot.laneId) return;
      if (ctl.holdCreep) {
        t.stopS = Math.max(0, spot.laneS - Q.parkCommitM);
        return;
      }
      t.stopS = -1;
      t.raceStage = RACE.COMMIT;
      raceEvent(S, veh, 'COMMIT');
      beh.script(S, veh, SK.COMMIT, spot.x, spot.y, spot.h, Q.commitS);
    }
  }

  /** PARK_HOLD: stop in lane, blinker on, then CRUISE after maxS. */
  function fsmParkHold(S, veh, dt) {
    var t = veh._t;
    t.timer -= dt;
    if (t.timer <= 0) beh.toCruise(S, veh);
  }

  function fsmBlock(S, veh, dt) {
    var t = veh._t;
    if (veh.v < 0.2) {
      if (t.stage === 0) {
        t.stage = 1;
        t.forceA = -2;
        veh.horn = true;
        emit(S, 'bubble', { who: 'veh', id: veh.id, text: '#@!', ttl: 2 });
      }
      capBlocker(S, veh);
      t.timer -= dt;
      if (t.timer <= 0) beh.toCruise(S, veh);
    }
  }

  function fsmReverse(S, veh) {
    if (veh.behT > TLV.tune.traffic.reverseMaxS || veh._t.reverse <= 0) beh.toCruise(S, veh);
  }

  function fsmStandoff(S, veh) {
    if (veh.behT >= TLV.tune.traffic.standoffMaxS) beh.release(S, veh);
  }

  function fsmPullOver(S, veh, dt) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    t.timer -= dt;
    if (t.sDone && (t.timer <= 0 || !TLV.traffic.visibleToPlayer(S, veh.x, veh.y))) {
      TLV.traffic.despawn(S, veh, 'watchdog');
    } else if (veh.behT > Q.pullOverMaxS * 2) {
      TLV.traffic.despawn(S, veh, 'watchdog');
    }
  }

  /** Behaviours with a state step. Constant. */
  var HANDLERS = {
    RED_RUN: fsmRedRun,
    TAILGATE: fsmTailgate,
    NOSE_IN: fsmNoseIn,
    OVERTAKE_OUT: fsmOvertake,
    OVERTAKE_PASS: fsmOvertake,
    CUT_IN: fsmCutIn,
    PHANTOM_STOP: fsmStand,
    DOUBLE_PARK: fsmStand,
    DROP_APPROACH: fsmDropApproach,
    DROPPED: fsmDropped,
    PULLOUT: fsmPullout,
    BUS_APPROACH: fsmBusApproach,
    BUS_STOPPED: fsmBusStopped,
    BUS_PULLOUT: fsmBusPullout,
    PARK_RACE: fsmRace,
    PARK_HOLD: fsmParkHold,
    RIVAL_BLOCK: fsmBlock,
    REVERSE_FOR_SPOT: fsmReverse,
    RIVAL_STANDOFF: fsmStandoff,
    PULL_OVER: fsmPullOver
  };

  /**
   * One FSM evaluation.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   */
  beh.fsm = function (S, veh) {
    var dt = period();
    var t = veh._t;
    veh.behT += dt;
    if (t.lcCool > 0) t.lcCool -= dt;
    var onPath = veh.mode === 'LANE' || veh.mode === 'CONN';
    if (onPath) {
      honkLogic(S, veh, dt);
      if (t.pg > 0 && veh.v < 0.3 && t.hn > 0 && t.hEnd[t.hn - 1] === Infinity && S.t - t.lastGrantT > TLV.tune.traffic.grantStaleS) {
        TLV.traffic.gate.revokeFrom(S, veh, 0);
        t.lastGrantT = S.t;
      }
    }
    var fn = HANDLERS[veh.beh];
    if (fn) fn(S, veh, dt);
    else if (onPath) cruise(S, veh, dt);
  };

  // ---- Pose scripts and the states off the lanes. -----------------------------------------------------------------------

  /**
   * Starts a pose script: a Hermite move from the car's pose to another.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {number} kind SK.*
   * @param {number} x Target x.
   * @param {number} y Target y.
   * @param {number} h Target heading.
   * @param {number} durS Seconds.
   */
  beh.script = function (S, veh, kind, x, y, h, durS) {
    var t = veh._t;
    if (t.lcTo >= 0) TLV.traffic.lanechange.finish(S, veh);
    TLV.traffic.gate.releaseAll(S, veh);
    if (veh.mode === 'LANE') {
      t.obLane = veh.laneId;
      t.obS = veh.s;
      t.obLat = veh.lat;
    } else {
      t.obLane = -1;
    }
    t.px0 = veh.x;
    t.py0 = veh.y;
    t.ph0 = veh.h;
    t.px1 = x;
    t.py1 = y;
    t.ph1 = h;
    t.sT = 0;
    t.sDur = durS;
    t.sKind = kind;
    t.sDone = false;
    veh.mode = 'SCRIPT';
    veh.connId = -1;
    veh.v = 0;
  };

  /** Keeps a car off its path listed on the nearest lane, as long as its body reaches the lane's travelled width. */
  function refreshObstacle(S, veh) {
    var W = S.world;
    var T = S.traffic;
    var t = veh._t;
    var near = TLV.world.lanes.project(W, veh.x, veh.y, veh.h, 6, T.projLane);
    if (!near) {
      t.obLane = -1;
      return;
    }
    var lane = W.lanes[near.laneId];
    if (Math.abs(near.lat) - t.halfW > lane.width / 2) {
      t.obLane = -1;
      return;
    }
    t.obLane = near.laneId;
    t.obS = near.s;
    t.obLat = near.lat;
  }

  /** The stall a racing car went into is taken now. */
  function fireInSpot(S, veh) {
    var t = veh._t;
    var OCC = TLV.const.OCC;
    TLV.world.parking.setState(S, t.raceSpot, OCC.VEHICLE);
    t.spotId = t.raceSpot;
    t.spotPrior = OCC.PARKED;
    t.raceStage = -1;
    raceEvent(S, veh, 'IN_SPOT');
  }

  /** Ends a pose script. */
  function scriptDone(S, veh) {
    var t = veh._t;
    var kind = t.sKind;
    t.sKind = SK.NONE;
    t.sDone = true;
    if (kind === SK.COMMIT) {
      veh.mode = 'PARKED';
      t.obLane = -1;
      t.raceSpot = -1;
      beh.toCruise(S, veh);
    } else if (kind === SK.PULLOUT || kind === SK.REJOIN) {
      veh.mode = 'LANE';
      veh.laneId = t.rejoinLane;
      veh.connId = -1;
      veh.s = t.rejoinS;
      veh.lat = 0;
      veh.x = t.px1;
      veh.y = t.py1;
      TLV.traffic.idm.placeAxles(veh);
      t.obLane = -1;
      t.pn = 0;
      t.pg = 0;
      t.backN = 0;
      TLV.traffic.gate.extend(S, veh);
      if (kind === SK.PULLOUT) {
        if (t.spotId >= 0) {
          TLV.world.parking.setState(S, t.spotId, TLV.const.OCC.FREE);
          t.spotId = -1;
        }
        veh.lights &= ~(TLV.const.VL.BLINK_L | TLV.const.VL.BLINK_R);
        veh.v = 2;
        beh.set(S, veh, 'NOSE_IN');
      }
    } else if (kind === SK.STANDOFF) {
      veh.door = t.standoffDoor === 2 ? 2 : 1;
      emit(S, 'traffic.door', { vehId: veh.id, open: true });
    } else if (kind === SK.TOW) {
      TLV.traffic.despawn(S, veh, t.towReason);
    } else if (kind === SK.PULL_OVER) {
      t.obLane = -1;
    }
  }

  /** Advances a pose script by a tick. */
  function scriptStep(S, veh, dt) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    if (t.sKind === SK.NONE) return;
    t.sT += dt;
    var u = t.sT / t.sDur;
    if (u > 1) u = 1;
    var ax = t.px1 - t.px0;
    var ay = t.py1 - t.py0;
    var len = Math.sqrt(ax * ax + ay * ay);
    var mx0 = Math.cos(t.ph0) * len;
    var my0 = Math.sin(t.ph0) * len;
    var mx1 = Math.cos(t.ph1) * len;
    var my1 = Math.sin(t.ph1) * len;
    var u2 = u * u;
    var u3 = u2 * u;
    var h00 = 2 * u3 - 3 * u2 + 1;
    var h10 = u3 - 2 * u2 + u;
    var h01 = 3 * u2 - 2 * u3;
    var h11 = u3 - u2;
    var nx = h00 * t.px0 + h10 * mx0 + h01 * t.px1 + h11 * mx1;
    var ny = h00 * t.py0 + h10 * my0 + h01 * t.py1 + h11 * my1;
    var slide = t.sKind === SK.PULL_OVER;
    if (slide) {
      // A car clearing the lane moves sideways, with no swing of a long body into the next lane, and never onto someone at the kerb.
      nx = t.px0 + ax * u;
      ny = t.py0 + ay * u;
    }
    // A scripted car has no driver looking, a stand-off crosses the kerb at a run, and a tow's driver is looking at his paperwork.
    if ((slide || t.sKind === SK.STANDOFF || t.sKind === SK.TOW) && personAt(S, veh, nx, ny)) {
      t.sT -= dt;
      veh.v = 0;
      return;
    }
    var dx = nx - veh.x;
    var dy = ny - veh.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    var h = veh.h;
    if (u >= 1) {
      h = t.ph1;
    } else if (d > 1e-4 && !slide) {
      var dp0 = 6 * u2 - 6 * u;
      var dp1 = 3 * u2 - 4 * u + 1;
      var dp2 = 3 * u2 - 2 * u;
      h = Math.atan2(dp0 * t.py0 + dp1 * my0 - dp0 * t.py1 + dp2 * my1, dp0 * t.px0 + dp1 * mx0 - dp0 * t.px1 + dp2 * mx1);
    }
    if (t.sKind === SK.TOW && playerAt(S, veh, nx, ny, h)) {
      t.sT -= dt;
      veh.v = 0;
      t.timer -= dt;
      if (t.timer <= 0) TLV.traffic.despawn(S, veh, t.towReason);
      return;
    }
    if (TLV.traffic.idm.wouldTouch(S, veh, dx, dy, TLV.math.wrapPi(h - veh.h))) {
      t.sT -= dt;
      veh.v = 0;
      return;
    }
    veh.h = h;
    veh.x = nx;
    veh.y = ny;
    t.cosH = Math.cos(veh.h);
    t.sinH = Math.sin(veh.h);
    veh.v = d / dt;
    veh.vx = dx / dt;
    veh.vy = dy / dt;
    if (t.sKind !== SK.PULL_OVER && S.traffic.tk % Q.nearTicks === veh.slot % Q.nearTicks) refreshObstacle(S, veh);
    if (t.sKind === SK.COMMIT && u >= 0.5 && t.raceStage === RACE.COMMIT) fireInSpot(S, veh);
    if (t.sKind === SK.TOW && veh.lat !== 0) veh.lat = 0;
    if (u >= 1) {
      veh.v = 0;
      veh.vx = 0;
      veh.vy = 0;
      scriptDone(S, veh);
    }
  }

  /**
   * A tow runs straight on from where the wreck stopped, and a car that rear-ended the player stopped right behind them. The contact net
   * reads AI bodies only, so the tow reads the player's car here, and waits for it to go, up to towWaitS. A wreck is no reason to charge
   * anyone twice.
   * @returns {boolean} True when this pose comes nearer to the player's car, inside the clearance every AI body keeps.
   */
  function playerAt(S, veh, x, y, h) {
    var me = S.player.veh;
    if (!me) return false;
    towBox.x = x;
    towBox.y = y;
    towBox.h = h;
    towBox.length = veh.length;
    towBox.width = veh.width;
    var after = TLV.math.obbGap(towBox, me);
    return after < TLV.tune.traffic.contactClear && after < TLV.math.obbGap(veh, me);
  }

  /** @returns {boolean} True when anyone stands inside a car's body at a place, or a stride from it. */
  function personAt(S, veh, x, y) {
    var peds = TLV.peds;
    if (!peds || !peds.pedsNear) return false;
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var count = peds.pedsNear(S, x, y, t.diag + Q.pedCorridor, T.pedNear);
    for (var i = 0; i < count; i++) {
      var p = T.pedNear[i];
      var dx = p.x - x;
      var dy = p.y - y;
      var along = Math.abs(dx * t.cosH + dy * t.sinH);
      var side = Math.abs(dy * t.cosH - dx * t.sinH);
      // A script runs up to 10 m/s and people read a body at 20 Hz, so the margin is two ticks of its travel wider than a body.
      var pad = (p.r || 0) + Q.pedBodyClear + 2 * TLV.math.dist(veh.x, veh.y, x, y);
      if (along < t.halfL + pad && side < t.halfW + pad) return true;
    }
    return false;
  }

  /** Friction body after an impact (ARCHITECTURE 10.2). */
  function dynamicStep(S, veh, dt) {
    var T = S.traffic;
    var W = S.world;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    t.dynT -= dt;
    var speed = Math.sqrt(t.vxD * t.vxD + t.vyD * t.vyD);
    var drop = Q.dynamicFriction * dt;
    var keep = speed > drop ? (speed - drop) / speed : 0;
    t.vxD *= keep;
    t.vyD *= keep;
    var dx = t.vxD * dt;
    var dy = t.vyD * dt;
    var dh = t.spin * dt * keep;
    if (TLV.traffic.idm.wouldTouch(S, veh, dx, dy, dh)) {
      t.vxD = 0;
      t.vyD = 0;
      t.spin = 0;
      dx = 0;
      dy = 0;
      dh = 0;
    }
    veh.x += dx;
    veh.y += dy;
    veh.h = TLV.math.wrapPi(veh.h + dh);
    if (TLV.collide && TLV.collide.resolveStatic) {
      var body = T.dynBody;
      body.x = veh.x;
      body.y = veh.y;
      body.h = veh.h;
      body.length = veh.length;
      body.width = veh.width;
      body.vx = t.vxD;
      body.vy = t.vyD;
      if (TLV.collide.resolveStatic(S, body, body)) {
        veh.x = body.x;
        veh.y = body.y;
        t.vxD = body.vx;
        t.vyD = body.vy;
      }
    }
    t.cosH = Math.cos(veh.h);
    t.sinH = Math.sin(veh.h);
    veh.vx = t.vxD;
    veh.vy = t.vyD;
    veh.v = Math.sqrt(t.vxD * t.vxD + t.vyD * t.vyD);
    if (T.tk % Q.nearTicks === veh.slot % Q.nearTicks) refreshObstacle(S, veh);
    if (t.dynT > 0 && veh.v > 0.05) return;
    if (t.dynT > 0 && t.dynT > Q.dynamicMaxS) return;
    var near = TLV.world.lanes.project(W, veh.x, veh.y, veh.h, Q.rejoinLat + 1, T.projLane);
    var good = near && Math.abs(near.lat) < Q.rejoinLat && Math.abs(near.headingErr) < Q.rejoinDeg * Math.PI / 180 &&
      veh.v < Q.rejoinV && (W.lanes[near.laneId].flags & TLV.const.LF.AI_ROUTABLE);
    if (good) startRejoin(S, veh, near.laneId, near.s);
    else beh.wreck(S, veh);
  }

  /** Blends a car back onto a lane. */
  function startRejoin(S, veh, laneId, s) {
    var W = S.world;
    var T = S.traffic;
    var t = veh._t;
    var lane = W.lanes[laneId];
    var to = Math.min(lane.len - 0.5, s + 3);
    TLV.world.lanes.pointAt(W, laneId, to, T.at);
    t.rejoinLane = laneId;
    t.rejoinS = to;
    beh.script(S, veh, SK.REJOIN, T.at.x, T.at.y, T.at.h, TLV.tune.traffic.rejoinS);
    veh.mode = 'REJOIN';
  }

  /**
   * Turns a car into a wreck: hazards on, an obstacle for at most 6 s, then towed in view or not (ARCHITECTURE 10.2).
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   */
  beh.wreck = function (S, veh) {
    var T = S.traffic;
    var t = veh._t;
    TLV.traffic.gate.releaseAll(S, veh);
    clearState(veh);
    veh.mode = 'WRECK';
    veh.v = 0;
    veh.vx = 0;
    veh.vy = 0;
    veh.lights |= TLV.const.VL.HAZARD;
    t.timer = TLV.tune.traffic.wreckS;
    T.stats.wrecks++;
    beh.set(S, veh, 'CRUISE');
    emit(S, 'traffic.wreck', { vehId: veh.id });
  };

  /** Starts the tow away, for a wreck or a rival. */
  function startTow(S, veh, reason) {
    var W = S.world;
    var t = veh._t;
    var Q = TLV.tune.traffic;
    var dist = Q.towSpeed * Q.towS;
    var x = veh.x + Math.cos(veh.h) * dist;
    var y = veh.y + Math.sin(veh.h) * dist;
    t.towReason = reason;
    t.timer = Q.towWaitS;
    beh.script(S, veh, SK.TOW, x, y, veh.h, Q.towS);
    veh.lights |= TLV.const.VL.HAZARD;
    beh.set(S, veh, 'TOWED');
    if (W) refreshObstacle(S, veh);
  }

  /**
   * Runs a car that is not on a path, every tick.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {number} dt Tick, seconds.
   */
  beh.offPath = function (S, veh, dt) {
    var t = veh._t;
    var mode = veh.mode;
    if (mode === 'SCRIPT' || mode === 'REJOIN') {
      scriptStep(S, veh, dt);
    } else if (mode === 'DYNAMIC') {
      dynamicStep(S, veh, dt);
    } else if (mode === 'WRECK') {
      t.timer -= dt;
      if (t.timer <= 0) startTow(S, veh, 'wreck');
    } else if (mode === 'PARKED' && veh.door && veh.beh === 'DOOR_OPEN') {
      t.timer -= dt;
      if (t.timer <= 0) {
        veh.door = 0;
        emit(S, 'traffic.door', { vehId: veh.id, open: false });
        beh.set(S, veh, 'CRUISE');
      }
    }
  };

  /**
   * Applies an impulse from the collision system.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {number} jx Impulse x, m/s.
   * @param {number} jy Impulse y, m/s.
   */
  beh.applyImpact = function (S, veh, jx, jy) {
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var size = Math.sqrt(jx * jx + jy * jy);
    if (veh.mode === 'WRECK' || veh.mode === 'SCRIPT' || veh.mode === 'REJOIN') return;
    if (veh.mode === 'DYNAMIC') {
      t.vxD += jx;
      t.vyD += jy;
      return;
    }
    if (size < Q.impactDynamic && (veh.mode === 'LANE' || veh.mode === 'CONN')) {
      var along = jx * t.cosH + jy * t.sinH;
      veh.v = Math.max(0, veh.v + along);
      return;
    }
    if (t.lcTo >= 0) TLV.traffic.lanechange.finish(S, veh);
    TLV.traffic.gate.releaseAll(S, veh);
    var wasParked = veh.mode === 'PARKED';
    clearState(veh);
    beh.set(S, veh, 'CRUISE');
    t.vxD = veh.vx + jx;
    t.vyD = veh.vy + jy;
    t.dynT = S.rng.traffic.range(Q.dynamicMinS, Q.dynamicMaxS);
    t.spin = (jx * t.sinH - jy * t.cosH) * Q.dynamicSpin / Math.max(1, veh.length);
    if (!wasParked && veh.laneId >= 0) {
      t.obLane = veh.laneId;
      t.obS = veh.s;
      t.obLat = veh.lat;
    } else {
      t.obLane = -1;
    }
    veh.mode = 'DYNAMIC';
    veh.connId = -1;
  };

  /** Backing up: holds a speed, and stops short of whatever is behind. */
  beh.reverseStep = function (S, veh) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var nb = TLV.traffic.idm.neighbours(S, veh.laneId, veh.s, t.halfL, veh.slot, T.gapBuf);
    var rearRoom = Math.min(nb.follGap, veh.s - t.halfL) - Q.reverseClear;
    var stopNeeded = veh.v * veh.v / (2 * Q.reverseAccel);
    t.reverseLeft += veh.v * TLV.const.DT;
    var want = -Q.reverseSpeed;
    if (t.aim) {
      // Backs at the speed that meets the shared aim, within what a car does in reverse.
      var left = t.aim.tImpact - S.t;
      var far = TLV.math.dist(veh.x, veh.y, t.aim.x, t.aim.y);
      var speed = left > 0.05 ? far / left : Q.reverseSpeed;
      want = -(speed < Q.reverseSpeed ? speed : Q.reverseSpeed);
    }
    if (t.reverseLeft <= stopNeeded || rearRoom <= stopNeeded) want = 0;
    var d = want - veh.v;
    var most = Q.reverseAccel;
    t.acc = d > 0 ? Math.min(d * 60, most) : Math.max(d * 60, -most);
    if (want === 0 && veh.v > -0.05) {
      veh.v = 0;
      t.acc = 0;
      t.reverse = 0;
      veh.lights &= ~TLV.const.VL.REVERSE;
    }
  };

  // ---- Commands. --------------------------------------------------------------------------------------------------------

  function onPathNow(veh) {
    return veh.mode === 'LANE' || veh.mode === 'CONN';
  }

  /** Commands that assume a free car cancel what it was doing, unless the state is one only the game can end. */
  function freeToObey(veh) {
    return veh.beh !== 'TOWED' && veh.beh !== 'PULL_OVER' && veh.beh !== 'RIVAL_STANDOFF' && veh.mode !== 'WRECK' && veh.mode !== 'DYNAMIC';
  }

  /** The red run command: the first signal ahead on the plan. */
  function cmdRedRun(S, veh, cmd) {
    var W = S.world;
    var t = veh._t;
    if (!onPathNow(veh) || !freeToObey(veh)) return false;
    if (t.pn < 3) TLV.traffic.gate.extend(S, veh);
    for (var i = 0; i < t.pn; i++) {
      var c = t.plan[i];
      if (W.conns[c].slot < 0) continue;
      clearState(veh);
      t.runRed = c;
      t.aim = cmd.aim || null;
      S.traffic.redRunAt[W.conns[c].junc] = S.t;
      beh.set(S, veh, 'RED_RUN');
      return true;
    }
    return false;
  }

  /** The tailgate command. */
  function cmdTailgate(S, veh, cmd) {
    if (!onPathNow(veh) || !freeToObey(veh)) return false;
    var target = cmd.targetId === undefined ? S.vehicles[0] : TLV.traffic.byId(S, cmd.targetId);
    if (!target) return false;
    startTailgate(S, veh, target.slot, cmd.durS > 0 ? cmd.durS : TLV.tune.traffic.tailMinS);
    return true;
  }

  /** The merge command: a forced change to a named neighbour lane, or a forced grant at the junction ahead. */
  function cmdNoseIn(S, veh, cmd) {
    var W = S.world;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    if (!onPathNow(veh) || !freeToObey(veh)) return false;
    var to = cmd.targetLaneId;
    if (to !== undefined && to !== null && to >= 0 && veh.mode === 'LANE') {
      var lane = W.lanes[veh.laneId];
      if (lane.left === to || lane.right === to) {
        if (t.lcTo >= 0) return false;
        clearState(veh);
        t.aim = cmd.aim || null;
        if (!TLV.traffic.lanechange.force(S, veh, to, Q.noseGapMin)) return false;
        beh.set(S, veh, 'NOSE_IN');
        t.noseConn = -1;
        return true;
      }
    }
    clearState(veh);
    t.aim = cmd.aim || null;
    t.gapS = Q.noseGapMin;
    beh.set(S, veh, 'NOSE_IN');
    if (t.pg < t.pn) t.noseConn = t.plan[t.pg];
    return true;
  }

  /**
   * A list refreshed since the car's last step can already hold what that step could not see, and a car placed this tick has had no
   * step at all. A command that names the player reads him from the list.
   */
  function readLead(S, veh, o) {
    var T = S.traffic;
    var t = veh._t;
    var nb = TLV.traffic.idm.neighbours(S, veh.laneId, veh.s, t.halfL, veh.slot, T.gapBuf);
    if (nb.lead !== o.slot) return;
    t.lead = o.slot;
    t.leadGap = nb.leadGap;
    t.leadV = nb.leadV;
    t.leadSame = true;
  }

  /**
   * The overtake command. A named target is passed if this car can pass it: from behind on its lane, or for the player from the lane
   * beside him.
   * @returns {boolean} True when the pass has started.
   */
  function cmdOvertake(S, veh, cmd) {
    var t = veh._t;
    if (veh.mode !== 'LANE' || !freeToObey(veh)) return false;
    var o = cmd.targetId === undefined ? null : TLV.traffic.byId(S, cmd.targetId);
    if (cmd.targetId !== undefined && !o) return false;
    if (o && o.isPlayer) readLead(S, veh, o);
    // Each way of starting clears the car's state as it commits, so a refused command leaves the car as it was.
    var ok = tryOvertake(S, veh, true, o) || tryOvertake(S, veh, false, o) || (!!o && o.isPlayer && passFromBeside(S, veh, o));
    if (ok) t.aim = cmd.aim || null;
    return ok;
  }

  /** PARK_RACE: takes the route and starts, or resumes from COMMIT. */
  function cmdParkRace(S, veh, cmd) {
    var W = S.world;
    var t = veh._t;
    if (!onPathNow(veh) || !freeToObey(veh) || !cmd.ctl) return false;
    var spot = TLV.world.parking.spot(W, cmd.spotId);
    if (!spot) return false;
    var resume = veh.beh === 'PARK_HOLD' && t.ctl === cmd.ctl;
    clearState(veh);
    t.raceSpot = cmd.spotId;
    t.ctl = cmd.ctl;
    t.raceStage = RACE.ROUTE;
    t.raceFromCommit = resume;
    t.routeT = 0;
    if (cmd.route) {
      t.route = cmd.route;
      t.ri = 0;
      TLV.traffic.gate.clearPlan(S, veh);
      TLV.traffic.gate.extend(S, veh);
    } else {
      raceRoute(S, veh, spot);
    }
    beh.set(S, veh, 'PARK_RACE');
    return true;
  }

  /**
   * Executes a command (ARCHITECTURE 13.1).
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {object} cmd Command.
   * @returns {boolean} False when the vehicle cannot comply. Never throws.
   */
  beh.command = function (S, veh, cmd) {
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var VL = TLV.const.VL;
    if (!cmd || !veh || !veh.active || veh.isPlayer) return false;
    switch (cmd.type) {
      case 'RED_RUN':
        return cmdRedRun(S, veh, cmd);
      case 'TAILGATE':
        return cmdTailgate(S, veh, cmd);
      case 'NOSE_IN':
        return cmdNoseIn(S, veh, cmd);
      case 'OVERTAKE':
        return cmdOvertake(S, veh, cmd);
      case 'PHANTOM_STOP':
        if (veh.mode !== 'LANE' || !freeToObey(veh)) return false;
        startPhantom(S, veh, cmd.decel > 0 ? cmd.decel : Q.phantomBrakeMin, cmd.holdS > 0 ? cmd.holdS : Q.phantomMinS);
        return true;
      case 'DROP_OFF':
        if (veh.mode !== 'LANE' || !freeToObey(veh)) return false;
        startDrop(S, veh, cmd.holdS > 0 ? cmd.holdS : Q.dropMinS, cmd.door || 'traffic', cmd.passenger !== false);
        return true;
      case 'DOUBLE_PARK':
        if (veh.mode !== 'LANE' || !freeToObey(veh)) return false;
        startDouble(S, veh, cmd.holdS > 0 ? cmd.holdS : Q.doubleMinS);
        return true;
      case 'REVERSE_FOR_SPOT':
        if (veh.mode !== 'LANE' || !freeToObey(veh) || t.lcTo >= 0) return false;
        clearState(veh);
        t.reverse = 1;
        t.reverseLeft = cmd.distM > 0 ? cmd.distM : 30;
        t.aim = cmd.aim || null;
        veh.lights |= VL.REVERSE;
        TLV.traffic.gate.clearPlan(S, veh);
        beh.set(S, veh, 'REVERSE_FOR_SPOT');
        return true;
      case 'BUS_PULLOUT':
        if (veh.kind !== 'bus' || veh.mode !== 'LANE') return false;
        clearState(veh);
        t.aim = cmd.aim || null;
        t.gapS = Q.noseGapMin;
        t.busCool = Q.busCoolS;
        veh.lights &= ~VL.HAZARD;
        beh.set(S, veh, 'BUS_PULLOUT');
        return true;
      case 'DOOR_OPEN':
        if (veh.mode !== 'PARKED') return false;
        veh.door = cmd.side === 'curb' ? 2 : 1;
        t.timer = cmd.holdS > 0 ? cmd.holdS : Q.doorMaxS;
        beh.set(S, veh, 'DOOR_OPEN');
        emit(S, 'traffic.door', { vehId: veh.id, open: true });
        return true;
      case 'PULLOUT':
        return beh.pullOut(S, veh);
      case 'PARK_RACE':
        return cmdParkRace(S, veh, cmd);
      case 'PARK_HOLD': {
        if (!onPathNow(veh) || !freeToObey(veh)) return false;
        var ctl = t.ctl;
        var spotId = t.raceSpot;
        var blink = veh.lights & (VL.BLINK_L | VL.BLINK_R);
        clearState(veh);
        t.ctl = ctl;
        t.raceSpot = spotId;
        t.timer = cmd.maxS > 0 ? cmd.maxS : Q.parkHoldStop;
        t.forceA = -Q.parkHoldStop;
        veh.lights |= blink || VL.BLINK_R;
        beh.set(S, veh, 'PARK_HOLD');
        return true;
      }
      case 'PARK_ABORT':
        if (veh.beh !== 'PARK_RACE' && veh.beh !== 'PARK_HOLD') return false;
        if (!onPathNow(veh)) return false;
        t.route = null;
        beh.toCruise(S, veh);
        return true;
      case 'RIVAL_BLOCK':
        if (!onPathNow(veh) || !freeToObey(veh)) return false;
        clearState(veh);
        t.timer = clampHold(S, veh, cmd.holdS > 0 ? cmd.holdS : 5);
        t.forceA = -Q.noseFollowBrake;
        beh.set(S, veh, 'RIVAL_BLOCK');
        return true;
      case 'RIVAL_STANDOFF':
        if (veh.mode === 'WRECK' || veh.mode === 'DYNAMIC') return false;
        clearState(veh);
        t.standoffDoor = cmd.door;
        beh.script(S, veh, SK.STANDOFF, cmd.x, cmd.y, cmd.h, cmd.durS > 0 ? cmd.durS : 1);
        beh.set(S, veh, 'RIVAL_STANDOFF');
        return true;
      case 'TOWED':
        clearState(veh);
        startTow(S, veh, 'script');
        return true;
      case 'CANCEL':
        beh.release(S, veh);
        return true;
      default:
        return false;
    }
  };

  /**
   * Back to CRUISE from anything a command started.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   */
  beh.release = function (S, veh) {
    if (!veh || !veh.active || veh.isPlayer) return;
    var W = S.world;
    var T = S.traffic;
    var t = veh._t;
    var needsLane = veh.mode === 'SCRIPT' && t.sKind !== SK.TOW && t.sKind !== SK.PULL_OVER;
    if (t.lcTo >= 0) TLV.traffic.lanechange.finish(S, veh);
    t.route = null;
    t.ctl = null;
    beh.toCruise(S, veh);
    if (!needsLane) return;
    var near = TLV.world.lanes.project(W, veh.x, veh.y, veh.h, 30, T.projLane);
    if (near) startRejoin(S, veh, near.laneId, near.s);
  };

  /**
   * Starts a parked car's pull-out: signal, a gap, then a blend into the lane, leaving through NOSE_IN.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle in PARKED.
   * @returns {boolean} False when it is not a parked car on a known stall.
   */
  beh.pullOut = function (S, veh) {
    var t = veh._t;
    if (veh.mode !== 'PARKED' || t.spotId < 0) return false;
    t.stage = 0;
    t.gapS = S.rng.traffic.range(TLV.tune.traffic.noseGapMin, TLV.tune.traffic.noseGapMax);
    var spot = TLV.world.parking.spot(S.world, t.spotId);
    t.spotPrior = TLV.const.OCC.FREE;
    veh.lights |= curbSign(S, veh, spot) > 0 ? TLV.const.VL.BLINK_R : TLV.const.VL.BLINK_L;
    t.timer = 0;
    beh.set(S, veh, 'PULLOUT');
    return true;
  };

  /** A parked car on PULLOUT waits for a gap. Runs at FSM rate for off-path cars too. */
  beh.parkedPull = function (S, veh) {
    var W = S.world;
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    if (veh.mode !== 'PARKED' || veh.beh !== 'PULLOUT') return;
    var spot = TLV.world.parking.spot(W, t.spotId);
    if (!spot) return;
    var nb = TLV.traffic.idm.neighbours(S, spot.laneId, spot.laneS, t.halfL, veh.slot, T.gapBuf);
    var clearBack = nb.foll < 0 || nb.follV < 0.5 ? nb.follGap > 1 : nb.follGap >= Q.noseMinM && nb.follGap / nb.follV >= t.gapS;
    var clearFront = nb.leadGap > t.halfL + Q.noseMinM;
    if (!clearBack || !clearFront) return;
    var to = Math.min(W.lanes[spot.laneId].len - 1, spot.laneS + Q.creepV);
    TLV.world.lanes.pointAt(W, spot.laneId, to, T.at);
    t.rejoinLane = spot.laneId;
    t.rejoinS = to;
    beh.script(S, veh, SK.PULLOUT, T.at.x, T.at.y, T.at.h, Q.pullOutS);
  };
})(window.TLV);
