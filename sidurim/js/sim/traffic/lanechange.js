// js/sim/traffic/lanechange.js — WP-TRAFFIC
// MOBIL lane changes (ARCHITECTURE 12.5). A changing car is listed in both lanes for the 1.5-2.5 s the change lasts, and its lane
// frame swaps at the midpoint, so lat stays inside the lane bound from start to finish.
(function (TLV) {
  'use strict';

  var lc = TLV.ns('traffic.lanechange');

  /** @returns {boolean} True when this lane has an exit that stays on the AI network. */
  function hasAiExit(S, laneId) {
    var W = S.world;
    var lane = W.lanes[laneId];
    var ai = TLV.const.LF.AI_ROUTABLE;
    for (var i = 0; i < lane.conns.length; i++) {
      if (W.lanes[W.conns[lane.conns[i]].to].flags & ai) return true;
    }
    return false;
  }

  lc.hasAiExit = hasAiExit;

  /**
   * Lanes of one road differ in length round a bend, by 5 m on lanes 6022 and 6023 of tlv_center, so a car's s means nothing on the
   * lane beside it. Every gap to a lane it may move to is read from here.
   * @returns {number} Where a car stands on a lane beside it.
   */
  function sOn(S, veh, to) {
    var T = S.traffic;
    var lane = S.world.lanes[to];
    return TLV.math.polyProject(lane.px, lane.py, lane.cum, veh.x, veh.y, veh.s, T.proj).s;
  }

  /**
   * A car on a connector into a lane is in no list of that lane until its centre gets there, though its nose already is.
   * @returns {boolean} True when a car with a grant onto this lane could arrive under this one's tail.
   */
  function entering(S, veh, to, s) {
    var left = S.traffic.reserved[to];
    return left > 0 && s - veh._t.halfL < left + TLV.tune.traffic.laneGapMin;
  }

  /**
   * MOBIL's incentive for moving to a lane, or -Infinity when the move is unsafe.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {number} to Target lane.
   * @param {number} minGap Bumper gap required on both sides.
   * @param {number} floor Hardest braking the move may cause.
   * @returns {number} Incentive in m/s2.
   */
  function incentive(S, veh, to, minGap, floor) {
    var T = S.traffic;
    var t = veh._t;
    // Prewarm keeps the stretch ahead of the player clear, and that goes for cars from the lanes beside it.
    for (var c = 0; c < T.clearN; c++) {
      if (T.clearLanes[c] === to) return -Infinity;
    }
    var s = sOn(S, veh, to);
    if (entering(S, veh, to, s)) return -Infinity;
    var idm = TLV.traffic.idm;
    var W = S.world;
    var lane = W.lanes[to];
    var v = veh.v;
    var v0 = lane.vmax * t.vf;
    var nb = idm.neighbours(S, to, s, t.halfL, veh.slot, T.gapBuf);
    if (nb.leadGap < minGap || nb.follGap < minGap) return -Infinity;
    if (nb.lead === -1) return -Infinity;
    var mine = idm.accel(v, v0, t.leadGap, t.leadV, t.s0, t.T, t.a, t.b);
    var theirs = idm.accel(v, v0, nb.leadGap, nb.leadV, t.s0, t.T, t.a, t.b);
    if (theirs < -floor) return -Infinity;
    var gain = 0;
    if (nb.foll >= 0) {
      var f = S.vehicles[nb.foll];
      var u = f._t;
      var fv = nb.follV;
      if (nb.foll === 0) {
        var a0 = idm.accel(fv, lane.vmax, nb.follGap, v, 1.5, 1.0, 2.5, 3);
        if (a0 < -floor) return -Infinity;
      } else {
        var after = idm.accel(fv, lane.vmax * u.vf, nb.follGap, v, u.s0, u.T, u.a, u.b);
        if (after < -floor) return -Infinity;
        gain = after - u.acc;
      }
    }
    return theirs - mine + t.polite * gain;
  }

  /**
   * Starts a change to a neighbouring lane.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle in LANE.
   * @param {number} to Target lane, a left or right neighbour.
   * @param {number} dur Seconds.
   */
  lc.start = function (S, veh, to, dur) {
    var T = S.traffic;
    var W = S.world;
    var t = veh._t;
    var lane = W.lanes[veh.laneId];
    var target = W.lanes[to];
    var side = lane.left === to ? 1 : -1;
    var VL = TLV.const.VL;
    t.lcW = side * (lane.width + target.width) / 2;
    TLV.math.polyProject(target.px, target.py, target.cum, veh.x, veh.y, veh.s, T.proj);
    t.lcDs = T.proj.s - veh.s;
    TLV.traffic.gate.clearPlan(S, veh);
    t.lcFrom = veh.laneId;
    t.lcTo = to;
    t.lcT = 0;
    t.lcDur = dur;
    t.lcDir = 1;
    t.lcHeld = 0;
    t.lcCool = TLV.tune.traffic.laneCoolS;
    t.mustLane = -1;
    veh.lights = (veh.lights & ~(VL.BLINK_L | VL.BLINK_R)) | (side > 0 ? VL.BLINK_L : VL.BLINK_R);
    TLV.traffic.gate.extend(S, veh);
  };

  /**
   * Moves a car's lane frame to the other lane of its change, keeping its pose: where it stands is read off the new lane. Lanes that
   * bend are not parallel, so the offsets taken when the change began can be a metre out by the time it gets here, and a slow change
   * would jump by that much.
   */
  function swapFrame(S, veh, to) {
    var T = S.traffic;
    var t = veh._t;
    var lane = S.world.lanes[to];
    TLV.math.polyProject(lane.px, lane.py, lane.cum, veh.x, veh.y, veh.s + (to === t.lcTo ? t.lcDs : -t.lcDs), T.proj);
    t.lcDs = to === t.lcTo ? T.proj.s - veh.s : veh.s - T.proj.s;
    veh.laneId = to;
    veh.s = T.proj.s;
    veh.lat = T.proj.side * T.proj.d;
  }

  /** The change's sideways move for this tick, swapping the lane frame at the midpoint. @returns {number} Metres, + left. */
  lc.step = function (S, veh, dt) {
    var t = veh._t;
    t.lcT += dt * t.lcDir;
    var u = t.lcT / t.lcDur;
    if (u > 1) u = 1;
    if (u < 0) u = 0;
    var f = u * u * (3 - 2 * u);
    var inFrom = veh.laneId === t.lcFrom;
    if (u >= 0.5 && inFrom) {
      swapFrame(S, veh, t.lcTo);
      inFrom = false;
      // The rest of the way is measured from where it really stands, so that it arrives on the line with no step.
      if (f < 1) t.lcW = veh.lat / (f - 1);
    } else if (u < 0.5 && !inFrom) {
      swapFrame(S, veh, t.lcFrom);
      inFrom = true;
      if (f > 0) t.lcW = veh.lat / f;
    }
    return (inFrom ? t.lcW * f : t.lcW * (f - 1)) - veh.lat;
  };

  /**
   * The contact net refused this tick's move. The time goes back, and a change refused for long enough turns round, because a car
   * pressed against another's flank would otherwise wait on it for ever while it waits on them.
   */
  lc.refused = function (S, veh, dt) {
    var t = veh._t;
    t.lcT -= dt * t.lcDir;
    t.lcHeld += dt;
    if (t.lcDir > 0 && t.lcHeld >= TLV.tune.traffic.laneRefuseS) t.lcDir = -1;
  };

  /**
   * Ends a change, wherever it stands.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   */
  lc.finish = function (S, veh) {
    var t = veh._t;
    var VL = TLV.const.VL;
    var back = t.lcDir < 0;
    if (!back && veh.laneId === t.lcFrom) swapFrame(S, veh, t.lcTo);
    t.lcFrom = -1;
    t.lcTo = -1;
    t.latT = 0;
    t.latR = 1.5;
    veh.lights &= ~(VL.BLINK_L | VL.BLINK_R);
    // The plan went with the change. A car that turned round plans again from the lane it is on, which only now reads as its lane.
    if (back) {
      TLV.traffic.gate.clearPlan(S, veh);
      TLV.traffic.gate.extend(S, veh);
    }
  };

  /** Ends a change once its time is up. */
  lc.settle = function (S, veh) {
    var t = veh._t;
    if (t.lcTo >= 0 && (t.lcT >= t.lcDur || (t.lcDir < 0 && t.lcT <= 0))) lc.finish(S, veh);
  };

  /**
   * Lists the sharp vertices of every lane, once per sim. Two lanes stop being parallel at such a corner, by more than a lane's width
   * on the outside of a right angle, so a change across one has no line to follow.
   * @param {object} S Sim state.
   */
  lc.init = function (S) {
    var T = S.traffic;
    var W = S.world;
    var limit = Math.cos(TLV.tune.traffic.laneBendDeg * Math.PI / 180);
    var off = new Int32Array(W.lanes.length + 1);
    var at = [];
    for (var l = 0; l < W.lanes.length; l++) {
      var lane = W.lanes[l];
      off[l] = at.length;
      for (var i = 1; i + 1 < lane.px.length; i++) {
        var ax = lane.px[i] - lane.px[i - 1];
        var ay = lane.py[i] - lane.py[i - 1];
        var bx = lane.px[i + 1] - lane.px[i];
        var by = lane.py[i + 1] - lane.py[i];
        var size = Math.sqrt((ax * ax + ay * ay) * (bx * bx + by * by));
        if (size > 0 && (ax * bx + ay * by) / size < limit) at.push(lane.cum[i]);
      }
    }
    off[W.lanes.length] = at.length;
    T.sharpOff = off;
    T.sharpS = Float32Array.from(at);
  };

  /**
   * @param {object} S Sim state.
   * @param {number} laneId Lane.
   * @param {number} from Position.
   * @param {number} to Position.
   * @returns {boolean} True when a sharp vertex stands between two positions on a lane.
   */
  lc.sharpBetween = function (S, laneId, from, to) {
    var T = S.traffic;
    for (var i = T.sharpOff[laneId]; i < T.sharpOff[laneId + 1]; i++) {
      if (T.sharpS[i] >= from && T.sharpS[i] <= to) return true;
    }
    return false;
  };

  /** @returns {boolean} True when a car may start a change on this lane at this position. */
  function roomToChange(S, veh, t, lane, dur) {
    var Q = TLV.tune.traffic;
    if (veh.s < t.halfL + 1) return false;
    var reach = veh.v * dur;
    if (lane.len - veh.s <= reach + Q.laneEndClear) return false;
    return !lc.sharpBetween(S, lane.id, veh.s - t.halfL, veh.s + reach + t.halfL + Q.laneBendClear);
  }

  lc.roomToChange = roomToChange;

  /**
   * Tries a change to a lane with a given gap and braking limit.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle in LANE.
   * @param {number} to Target lane.
   * @param {number} minGap Gap required.
   * @param {number} floor Hardest braking allowed.
   * @returns {boolean} True when it started.
   */
  lc.tryChange = function (S, veh, to, minGap, floor) {
    var t = veh._t;
    var W = S.world;
    var lane = W.lanes[veh.laneId];
    if (to < 0 || (to !== lane.left && to !== lane.right)) return false;
    var dur = S.rng.traffic.range(TLV.tune.traffic.laneChangeMin, TLV.tune.traffic.laneChangeMax);
    if (!roomToChange(S, veh, t, lane, dur)) return false;
    if (incentive(S, veh, to, minGap, floor) === -Infinity) return false;
    lc.start(S, veh, to, dur);
    return true;
  };

  /**
   * A forced merge: the gap behind only has to meet the short NOSE_IN acceptance, 4 m and 0.8-1.5 s, and the follower does the
   * braking, capped at -5 (GAME_DESIGN 9).
   * @param {object} S Sim state.
   * @param {object} veh Vehicle in LANE.
   * @param {number} to Target lane.
   * @param {number} gapS Accepted gap, seconds.
   * @returns {boolean} True when it started.
   */
  lc.force = function (S, veh, to, gapS) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var dur = Q.laneChangeMin;
    var lane = S.world.lanes[veh.laneId];
    if (to < 0 || (to !== lane.left && to !== lane.right)) return false;
    if (!roomToChange(S, veh, t, lane, dur)) return false;
    var s = sOn(S, veh, to);
    if (entering(S, veh, to, s)) return false;
    var nb = TLV.traffic.idm.neighbours(S, to, s, t.halfL, veh.slot, T.gapBuf);
    if (nb.lead === -1 || nb.leadGap < Q.laneGapMin) return false;
    var need = Math.max(Q.noseMinM, gapS * Math.max(nb.follV, 0));
    if (nb.follGap < need) return false;
    lc.start(S, veh, to, dur);
    return true;
  };

  /**
   * The end of a pass of the player: back into his lane, in the shortest change there is, and up to the last of the road.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle in LANE.
   * @param {number} to Target lane.
   * @param {number} minGap Gap required.
   * @param {number} floor Hardest braking allowed.
   * @returns {boolean} True when it started.
   */
  lc.cutIn = function (S, veh, to, minGap, floor) {
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var lane = S.world.lanes[veh.laneId];
    var dur = Q.laneChangeMin;
    if (to < 0 || (to !== lane.left && to !== lane.right)) return false;
    var reach = veh.v * dur;
    if (lane.len - veh.s <= reach + Q.overCutClear) return false;
    if (lc.sharpBetween(S, lane.id, veh.s - t.halfL, veh.s + reach + t.halfL)) return false;
    var s = sOn(S, veh, to);
    if (entering(S, veh, to, s)) return false;
    // Not incentive(): a car this far over its limit reads as braking hard whatever lies ahead. What matters is the room either side.
    var T = S.traffic;
    var nb = TLV.traffic.idm.neighbours(S, to, s, t.halfL, veh.slot, T.gapBuf);
    if (nb.lead === -1 || nb.leadGap < minGap || nb.follGap < minGap) return false;
    var closing = veh.v - nb.leadV;
    if (closing > 0 && nb.leadGap < closing * closing / (2 * floor) + minGap) return false;
    lc.start(S, veh, to, dur);
    return true;
  };

  /**
   * A mandatory change toward a lane of this road. It starts 60 m out, and never waits: a car that gets no gap takes any
   * connector from where it is (ARCHITECTURE 12.5).
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @returns {boolean} True when a change started.
   */
  lc.mandatory = function (S, veh) {
    var W = S.world;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var lane = W.lanes[veh.laneId];
    var want = W.lanes[t.mustLane];
    if (!want || want.dirEdge !== lane.dirEdge) {
      // The lane it asked for is on a road already behind it.
      t.mustLane = -1;
      return false;
    }
    if (t.mustLane === veh.laneId) {
      t.mustLane = -1;
      return false;
    }
    if (lane.len - veh.s > Q.mandatoryM) return false;
    var to = want.idx > lane.idx ? lane.left : lane.right;
    if (to < 0) return false;
    return lc.tryChange(S, veh, to, Q.laneGapMin, t.safeB);
  };

  /**
   * One lane-change decision, at FSM rate.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle in LANE, in CRUISE.
   */
  lc.consider = function (S, veh) {
    var W = S.world;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    if (t.lcTo >= 0 || t.lcCool > 0 || Math.abs(veh.lat) > 0.05) return;
    if (t.mustLane >= 0 && lc.mandatory(S, veh)) return;
    var lane = W.lanes[veh.laneId];
    if (lane.left < 0 && lane.right < 0) return;
    if (t.route) return;
    var dur = (Q.laneChangeMin + Q.laneChangeMax) / 2;
    if (!roomToChange(S, veh, t, lane, dur)) return;
    var best = -1;
    var score = t.thresh;
    var i;
    for (i = 0; i < 2; i++) {
      var to = i === 0 ? lane.left : lane.right;
      if (to < 0 || !hasAiExit(S, to)) continue;
      var gain = incentive(S, veh, to, Q.laneGapMin, t.safeB);
      if (gain > score) {
        score = gain;
        best = to;
      }
    }
    if (best >= 0) lc.start(S, veh, best, S.rng.traffic.range(Q.laneChangeMin, Q.laneChangeMax));
  };
})(window.TLV);
