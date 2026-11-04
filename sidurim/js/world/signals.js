// js/world/signals.js — WP-WORLD
// Signal controllers (ARCHITECTURE 8.3), crossing zones (8.4) and the signal runtime. A light is a pure function of time,
// so red-runners and telegraphs can ask about the future.
(function (TLV) {
  'use strict';

  var signals = TLV.ns('world.signals');

  /** Half a turn: bearings are compared modulo this. */
  var PI = Math.PI;
  /** A hair past the slot's first instant, so "green in n seconds" is green at exactly n seconds despite rounding. */
  var ALIGN_EPSILON = 1e-9;

  /** @returns {number} A bearing folded into [0, pi). */
  function foldBearing(h) {
    var a = h % PI;
    return a < 0 ? a + PI : a;
  }

  /** @returns {number} Smallest gap between two folded bearings. */
  function bearingGap(a, b) {
    var d = Math.abs(a - b);
    return d > PI / 2 ? PI - d : d;
  }

  /** Merges the two groups with the closest mean bearings, repeatedly, until at most max groups remain. */
  function capGroups(groups, max) {
    while (groups.length > max) {
      var bestI = 0;
      var bestJ = 1;
      var best = Infinity;
      for (var i = 0; i < groups.length; i++) {
        for (var j = i + 1; j < groups.length; j++) {
          var d = bearingGap(groups[i].mean, groups[j].mean);
          if (d < best) {
            best = d;
            bestI = i;
            bestJ = j;
          }
        }
      }
      var into = groups[bestI];
      var from = groups[bestJ];
      into.ids = into.ids.concat(from.ids);
      into.mean = foldBearing(into.mean + bearingDelta(into.mean, from.mean) * from.ids.length / into.ids.length);
      groups.splice(bestJ, 1);
    }
    return groups;
  }

  /** @returns {number} Signed shortest step from one folded bearing to another. */
  function bearingDelta(from, to) {
    var d = to - from;
    if (d > PI / 2) d -= PI;
    if (d < -PI / 2) d += PI;
    return d;
  }

  /**
   * Clusters a junction's approaches into vehicle slots by bearing modulo 180 deg (ARCHITECTURE 8.3): opposing approaches
   * share a slot. Bearings are walked from just after their widest gap, so a group never straddles the fold.
   * @param {object} W World.
   * @param {Int32Array} approaches Directed edge ids.
   * @returns {Int32Array[]} Directed edges per slot, at most maxSlots, every approach exactly once.
   */
  function slotApproaches(W, approaches) {
    var T = TLV.tune.world;
    var tolerance = T.slotToleranceDeg * PI / 180;
    var rows = [];
    var i;
    for (i = 0; i < approaches.length; i++) {
      rows.push({ id: approaches[i], b: foldBearing(W.dirEdges[approaches[i]].hOut) });
    }
    rows.sort(function (p, q) { return p.b - q.b || p.id - q.id; });
    var n = rows.length;
    var startAt = 0;
    var gap = -1;
    for (i = 0; i < n; i++) {
      var next = i + 1 < n ? rows[i + 1].b : rows[0].b + PI;
      if (next - rows[i].b > gap) {
        gap = next - rows[i].b;
        startAt = (i + 1) % n;
      }
    }
    var groups = [];
    var current = null;
    for (i = 0; i < n; i++) {
      var row = rows[(startAt + i) % n];
      if (current && bearingGap(current.first, row.b) <= tolerance) {
        current.ids.push(row.id);
        current.mean = foldBearing(current.mean + bearingDelta(current.mean, row.b) / current.ids.length);
      } else {
        current = { first: row.b, mean: row.b, ids: [row.id] };
        groups.push(current);
      }
    }
    capGroups(groups, T.maxSlots);
    return groups.map(function (g) {
      g.ids.sort(function (p, q) { return p - q; });
      return TLV.world.geom._ids(g.ids);
    });
  }

  /** Stamps each connector of these slots with its slot. */
  function stampSlots(W, slots) {
    for (var s = 0; s < slots.length; s++) {
      for (var i = 0; i < slots[s].length; i++) {
        var lanes = W.dirEdges[slots[s][i]].lanes;
        for (var l = 0; l < lanes.length; l++) {
          var conns = W.lanes[lanes[l]].conns;
          for (var c = 0; c < conns.length; c++) W.conns[conns[c]].slot = s;
        }
      }
    }
  }

  /**
   * Finds approaches that hold one slot and cross on their straight-on paths, from the pairs the conflict search kept aside.
   * Crossing roads at an ordinary light are in different slots, so nearly every pair stops at the first test.
   * @returns {Array<number[]>} Directed edge pairs, one for each pair of lanes that cross.
   */
  function crossingsInSlot(W, juncId) {
    var flat = W.index.straightCrossings[juncId];
    var pairs = [];
    if (!flat) return pairs;
    for (var i = 0; i < flat.length; i += 2) {
      var p = W.conns[flat[i]];
      var q = W.conns[flat[i + 1]];
      if (p.slot !== q.slot) continue;
      var a = W.lanes[p.from].dirEdge;
      var b = W.lanes[q.from].dirEdge;
      if (a !== b) pairs.push([a, b]);
    }
    return pairs;
  }

  /** @returns {number} How many approaches of list cross id. */
  function crossingsWith(pairs, id, list) {
    var count = 0;
    for (var i = 0; i < pairs.length; i++) {
      var other = pairs[i][0] === id ? pairs[i][1] : (pairs[i][1] === id ? pairs[i][0] : -1);
      if (other >= 0 && list.indexOf(other) >= 0) count++;
    }
    return count;
  }

  /**
   * Separates approaches that share a slot by bearing but cross on their straight-on paths, as they can where a merged junction
   * joins roads that do not line up. The approach with most crossings moves out first, to the first split-off slot it does not
   * cross, or to a new one. At maxSlots it stays, and the gate serializes the pair.
   * @param {Int32Array[]} slots Directed edges per slot, from slotApproaches.
   * @param {Array<number[]>} pairs From crossingsInSlot.
   * @returns {Int32Array[]} Directed edges per slot, at most maxSlots, every approach exactly once.
   */
  function splitCrossings(slots, pairs) {
    var max = TLV.tune.world.maxSlots;
    var byBearing = slots.length;
    var out = slots.map(function (ids) { return Array.from(ids); });
    for (var s = 0; s < out.length; s++) {
      for (;;) {
        var worst = -1;
        var most = 0;
        for (var i = 0; i < out[s].length; i++) {
          var count = crossingsWith(pairs, out[s][i], out[s]);
          if (count > most) {
            most = count;
            worst = out[s][i];
          }
        }
        if (worst < 0) break;
        var to = byBearing;
        while (to < out.length && crossingsWith(pairs, worst, out[to]) > 0) to++;
        if (to === out.length) {
          if (to >= max) break;
          out.push([]);
        }
        out[s].splice(out[s].indexOf(worst), 1);
        out[to].push(worst);
      }
    }
    return out.map(TLV.world.geom._ids);
  }

  /** Creates the controller of one junction and stamps each connector's slot. */
  function buildController(W, junc) {
    var T = TLV.tune.world;
    var slots = slotApproaches(W, junc.inDir);
    stampSlots(W, slots);
    var crossing = crossingsInSlot(W, junc.id);
    if (crossing.length) {
      slots = splitCrossings(slots, crossing);
      stampSlots(W, slots);
    }
    var n = slots.length;
    var times = T.signalTimes[n];
    var slotS = times.greenS + times.amberS + times.allRedS;
    var cycleS = n * slotS + times.pedS;
    var ctrl = {
      id: W.ctrls.length,
      junc: junc.id,
      offset: TLV.rng.hash32(junc.id, T.offsetSalt) % cycleS,
      cycleS: cycleS,
      greenS: times.greenS,
      amberS: times.amberS,
      allRedS: times.allRedS,
      slotS: slotS,
      pedS: times.pedS,
      slots: slots
    };
    W.ctrls.push(ctrl);
    junc.ctrl = ctrl.id;
  }

  /**
   * Finds the controller a crossing shares by walking from each end of its edge through PASS junctions.
   * @returns {?{ctrl: number, dist: number}} The nearest one by road, or null.
   */
  function nearestController(W, xing) {
    var T = TLV.tune.world;
    var e = W.edges[xing.edge];
    var best = null;
    for (var end = 0; end < 2; end++) {
      var j = end === 0 ? e.a : e.b;
      var dist = end === 0 ? xing.s : e.len - xing.s;
      var arrived = e.id;
      for (var hops = 0; hops < 8 && dist <= T.xingCtrlRangeM; hops++) {
        var junc = W.juncs[j];
        if (junc.ctrl >= 0) {
          if (!best || dist < best.dist) best = { ctrl: junc.ctrl, dist: dist };
          break;
        }
        if (junc.kind !== 'PASS') break;
        var onward = passOnward(W, junc, arrived);
        if (onward < 0) break;
        dist += W.edges[onward].len;
        j = W.edges[onward].a === j ? W.edges[onward].b : W.edges[onward].a;
        arrived = onward;
      }
    }
    return best;
  }

  /** @returns {number} The other road through a PASS junction, or -1. */
  function passOnward(W, junc, edgeId) {
    var arms = W.index.arms[junc.id];
    for (var i = 0; i < arms.length; i++) {
      if (arms[i].edge !== edgeId) return arms[i].edge;
    }
    return -1;
  }

  /** @returns {?object} The directed edge of a lane's road that arrives at the junction, following PASS junctions forward. */
  function arrivalAt(W, d, juncId) {
    var cur = d;
    for (var hops = 0; hops < 8 && cur; hops++) {
      if (cur.to === juncId) return cur;
      if (W.juncs[cur.to].kind !== 'PASS' || !cur.moves.length) return null;
      cur = W.dirEdges[cur.moves[0]];
    }
    return null;
  }

  /** @returns {?object} The directed edge of a lane's road that leaves the junction, following PASS junctions backward. */
  function departureFrom(W, d, juncId, feeders) {
    var cur = d;
    for (var hops = 0; hops < 8 && cur; hops++) {
      if (cur.from === juncId) return cur;
      if (W.juncs[cur.from].kind !== 'PASS') return null;
      var list = feeders[cur.id];
      if (!list || !list.length) return null;
      cur = W.dirEdges[list[0].from];
    }
    return null;
  }

  /** @returns {Array<Array<object>>} For each directed edge, the connectors that enter it, as { from, slot, turn }. */
  function feedersByDirEdge(W) {
    var feeders = new Array(W.dirEdges.length);
    for (var i = 0; i < W.conns.length; i++) {
      var conn = W.conns[i];
      var d = W.lanes[conn.to].dirEdge;
      if (!feeders[d]) feeders[d] = [];
      feeders[d].push({ from: W.lanes[conn.from].dirEdge, slot: conn.slot, turn: conn.turn, junc: conn.junc });
    }
    return feeders;
  }

  /**
   * Slots whose green sends traffic over a crossing, as a bit mask (ARCHITECTURE 8.4 says "all lanes it crosses are RED",
   * but a lane's own state is the light at its far end, which for a lane leaving this junction is some other junction or
   * none). Lanes arriving at this junction decide it. On a road that only leaves the junction, the straight movement that
   * feeds it decides, or every feeder if there is none. Traffic that turns in meets walkers through the zone, as it does at
   * a real light. A mask that leaves too little walk time keeps only its first slot.
   * @returns {number} Bit s set for each slot s, 0 when this controller governs nothing here.
   */
  function crossingSlots(W, xing, ctrl, feeders) {
    var T = TLV.tune.world;
    var e = W.edges[xing.edge];
    var mask = 0;
    var fed = 0;
    for (var dir = 0; dir < 2; dir++) {
      var d = W.dirEdges[e.id * 2 + dir];
      if (!d) continue;
      var arrive = arrivalAt(W, d, ctrl.junc);
      if (arrive) {
        for (var s = 0; s < ctrl.slots.length; s++) {
          if (ctrl.slots[s].indexOf(arrive.id) >= 0) mask |= 1 << s;
        }
        continue;
      }
      var leave = departureFrom(W, d, ctrl.junc, feeders);
      var list = leave ? feeders[leave.id] : null;
      if (!list) continue;
      var straight = 0;
      var any = 0;
      for (var i = 0; i < list.length; i++) {
        if (list[i].junc !== ctrl.junc || list[i].slot < 0) continue;
        any |= 1 << list[i].slot;
        if (list[i].turn === 'S') straight |= 1 << list[i].slot;
      }
      fed |= straight || any;
    }
    if (!mask) mask = fed;
    var bits = 0;
    for (var b = 0; b < ctrl.slots.length; b++) {
      if (mask & (1 << b)) bits++;
    }
    if (ctrl.cycleS - bits * (ctrl.greenS + ctrl.amberS) < T.xingWalkMinS) mask &= -mask;
    return mask;
  }

  /** Binds crossings to controllers. A signal crossing with no light in reach is a plain zebra. */
  function bindCrossings(W) {
    var feeders = feedersByDirEdge(W);
    var masks = new Int32Array(W.xings.length);
    for (var i = 0; i < W.xings.length; i++) {
      var xing = W.xings[i];
      if (!xing.signal) continue;
      var near = nearestController(W, xing);
      var mask = near ? crossingSlots(W, xing, W.ctrls[near.ctrl], feeders) : 0;
      if (mask) {
        xing.ctrl = near.ctrl;
        masks[i] = mask;
      } else {
        xing.signal = false;
      }
    }
    W.index.xingSlots = masks;
  }

  /** Creates one zone per lane of each crossing's edge (ARCHITECTURE 8.4). */
  function buildZones(W) {
    var T = TLV.tune.world;
    var math = TLV.math;
    var half = T.zoneHalf;
    var perLane = new Map();
    var at = { x: 0, y: 0, h: 0 };
    var proj = { s: 0, d: 0, side: 0 };
    for (var i = 0; i < W.xings.length; i++) {
      var xing = W.xings[i];
      var e = W.edges[xing.edge];
      var ids = [];
      math.polyAt(e.px, e.py, e.cum, xing.s, at);
      for (var dir = 0; dir < 2; dir++) {
        var d = W.dirEdges[e.id * 2 + dir];
        if (!d) continue;
        for (var l = 0; l < d.lanes.length; l++) {
          var lane = W.lanes[d.lanes[l]];
          math.polyProject(lane.px, lane.py, lane.cum, at.x, at.y, -1, proj);
          // A crossing in a trimmed region lands on a lane end. It snaps inside by the zone's half width.
          var c = lane.len <= 2 * half ? lane.len / 2 : math.clamp(proj.s, half, lane.len - half);
          var zone = {
            id: W.zones.length,
            laneId: lane.id,
            s0: Math.max(0, c - half),
            s1: Math.min(lane.len, c + half),
            xing: i
          };
          W.zones.push(zone);
          ids.push(zone.id);
          if (!perLane.has(lane.id)) perLane.set(lane.id, []);
          perLane.get(lane.id).push(zone);
        }
      }
      xing.zones = TLV.world.geom._idsIn(W.index.ids, ids);
    }
    perLane.forEach(function (list, laneId) {
      list.sort(function (p, q) { return p.s0 - q.s0 || p.id - q.id; });
      var zones = TLV.world.geom._idView(W.index.ids, list.length);
      for (var i = 0; i < list.length; i++) zones[i] = list[i].id;
      W.lanes[laneId].zones = zones;
    });
  }

  /**
   * Builds controllers, connector slots, crossing bindings and zones.
   * @param {object} W World with connectors built.
   */
  signals._build = function (W) {
    for (var i = 0; i < W.juncs.length; i++) {
      var junc = W.juncs[i];
      if (junc.kind === 'SIGNAL' && junc.inDir.length > 0) buildController(W, junc);
    }
    buildZones(W);
    bindCrossings(W);
  };

  /** @returns {number} Non-negative remainder. */
  function mod(a, b) {
    var r = a % b;
    return r < 0 ? r + b : r;
  }

  /**
   * The ARCHITECTURE 8.3 formula.
   * @param {object} ctrl Controller.
   * @param {number} slot Vehicle slot of the connector.
   * @param {number} clock Signal clock.
   * @returns {number} SIG.*
   */
  function stateOf(ctrl, slot, clock) {
    var SIG = TLV.const.SIG;
    var phase = mod(clock + ctrl.offset, ctrl.cycleS);
    if (phase >= ctrl.slots.length * ctrl.slotS) return SIG.RED;
    if (Math.floor(phase / ctrl.slotS) !== slot) return SIG.RED;
    var r = phase - slot * ctrl.slotS;
    if (r < ctrl.greenS) return SIG.GREEN;
    return r < ctrl.greenS + ctrl.amberS ? SIG.AMBER : SIG.RED;
  }

  /** @returns {?object} The controller of a signalled connector, or null. */
  function ctrlOfConn(W, conn) {
    if (!conn || conn.slot < 0) return null;
    var ctrl = W.juncs[conn.junc].ctrl;
    return ctrl < 0 ? null : W.ctrls[ctrl];
  }

  /** @returns {?object} The live debug override of a controller, or null. */
  function forcedOf(S, ctrlId, t) {
    var forced = S.sig.forced;
    if (!forced) return null;
    var f = forced[ctrlId];
    return f && t < f.until ? f : null;
  }

  /** Recomputes every controller's cached slot and state. */
  function refresh(S) {
    var sig = S.sig;
    var ctrls = S.world.ctrls;
    var SIG = TLV.const.SIG;
    sig.clock = S.t + sig.epoch;
    for (var i = 0; i < ctrls.length; i++) {
      var ctrl = ctrls[i];
      var f = forcedOf(S, i, S.t);
      var phase = mod(sig.clock + ctrl.offset, ctrl.cycleS);
      var n = ctrl.slots.length;
      var slot = phase >= n * ctrl.slotS ? -1 : Math.floor(phase / ctrl.slotS);
      sig.slot[i] = slot;
      sig.state[i] = f ? f.state : (slot < 0 ? SIG.RED : stateOf(ctrl, slot, sig.clock));
    }
  }

  /**
   * Creates S.sig.
   * @param {object} S Sim state.
   */
  signals.init = function (S) {
    var n = S.world ? S.world.ctrls.length : 0;
    S.sig = { clock: 0, epoch: 0, slot: new Int8Array(n), state: new Int8Array(n), forced: null };
    if (S.world) refresh(S);
  };

  /**
   * Tick row 3: advances the clock and caches each controller's slot and state. Expired overrides are dropped here.
   * @param {object} S Sim state.
   */
  signals.update = function (S) {
    var forced = S.sig.forced;
    if (forced) {
      var live = false;
      for (var key in forced) {
        if (S.t >= forced[key].until) delete forced[key];
        else live = true;
      }
      if (!live) S.sig.forced = null;
    }
    if (S.world) refresh(S);
  };

  /**
   * State of a connector at any absolute sim time, now or in the future. Pure.
   * @param {object} S Sim state.
   * @param {number} connId Connector, or -1.
   * @param {number} t Sim time, on the same scale as S.t.
   * @returns {number} SIG.*, GREEN when unsignalled.
   */
  signals.stateAt = function (S, connId, t) {
    var SIG = TLV.const.SIG;
    var W = S.world;
    var conn = W.conns[connId];
    var ctrl = ctrlOfConn(W, conn);
    if (!ctrl) return SIG.GREEN;
    var f = forcedOf(S, ctrl.id, t);
    if (f) return f.state;
    return stateOf(ctrl, conn.slot, t + S.sig.epoch);
  };

  /**
   * State of a connector now. It is worked out from S.t and S.sig.epoch, not from the tick cache, so traffic.prewarm sees the
   * lights move while it advances the epoch with the tick held still.
   * @param {object} S Sim state.
   * @param {number} connId Connector, or -1.
   * @returns {number} SIG.*, GREEN on a PASS or PRIORITY junction.
   */
  signals.connState = function (S, connId) {
    return signals.stateAt(S, connId, S.t);
  };

  /**
   * State at a lane's stop line.
   * @param {object} S Sim state.
   * @param {number} laneId Lane, or -1.
   * @returns {number} SIG.* of its rightmost connector, GREEN if it has none or is unsignalled.
   */
  signals.laneState = function (S, laneId) {
    var lane = S.world.lanes[laneId];
    if (!lane || !lane.conns.length) return TLV.const.SIG.GREEN;
    return signals.connState(S, lane.conns[0]);
  };

  /**
   * @param {object} S Sim state.
   * @param {number} connId Connector, or -1.
   * @returns {number} Seconds until it is green, 0 if it is green now or unsignalled.
   */
  signals.timeToGreen = function (S, connId) {
    var SIG = TLV.const.SIG;
    var W = S.world;
    var conn = W.conns[connId];
    var ctrl = ctrlOfConn(W, conn);
    if (!ctrl) return 0;
    if (signals.connState(S, connId) === SIG.GREEN) return 0;
    var f = forcedOf(S, ctrl.id, S.t);
    var from = f ? f.until : S.t;
    // An override can end with this slot already green, partway through its green.
    if (f && stateOf(ctrl, conn.slot, from + S.sig.epoch) === SIG.GREEN) return from - S.t;
    var phase = mod(from + S.sig.epoch + ctrl.offset, ctrl.cycleS);
    return (from - S.t) + mod(conn.slot * ctrl.slotS - phase, ctrl.cycleS);
  };

  /**
   * @param {object} S Sim state.
   * @param {number} connId Connector, or -1.
   * @returns {number} Seconds until it is red, 0 if it is red now, Infinity if unsignalled.
   */
  signals.timeToRed = function (S, connId) {
    var SIG = TLV.const.SIG;
    var W = S.world;
    var conn = W.conns[connId];
    var ctrl = ctrlOfConn(W, conn);
    if (!ctrl) return Infinity;
    if (signals.connState(S, connId) === SIG.RED) return 0;
    var f = forcedOf(S, ctrl.id, S.t);
    var from = f ? f.until : S.t;
    // An override can end with this slot already red.
    if (f && stateOf(ctrl, conn.slot, from + S.sig.epoch) === SIG.RED) return from - S.t;
    var phase = mod(from + S.sig.epoch + ctrl.offset, ctrl.cycleS);
    var redAt = conn.slot * ctrl.slotS + ctrl.greenS + ctrl.amberS;
    return (from - S.t) + mod(redAt - phase, ctrl.cycleS);
  };

  /**
   * Walk state of a signalled crossing: true when nothing the light governs is running over it (ARCHITECTURE 8.4).
   * @param {object} S Sim state.
   * @param {number} xingId Crossing, or -1.
   * @returns {boolean} False for a zebra, which has no signal state.
   */
  signals.pedWalk = function (S, xingId) {
    var W = S.world;
    var xing = W.xings[xingId];
    if (!xing || !xing.signal || xing.ctrl < 0) return false;
    var ctrl = W.ctrls[xing.ctrl];
    var SIG = TLV.const.SIG;
    var f = forcedOf(S, ctrl.id, S.t);
    if (f) return f.state === SIG.RED;
    var clock = S.t + S.sig.epoch;
    var mask = W.index.xingSlots[xingId];
    for (var s = 0; s < ctrl.slots.length; s++) {
      if ((mask & (1 << s)) && stateOf(ctrl, s, clock) !== SIG.RED) return false;
    }
    return true;
  };

  /**
   * Shifts the signal clock so a connector turns green after a delay. All lights share the clock, so all of them shift.
   * @param {object} S Sim state.
   * @param {number} connId Connector.
   * @param {number} seconds Delay from now.
   * @returns {boolean} False if the connector is unsignalled.
   */
  signals.alignGreen = function (S, connId, seconds) {
    var W = S.world;
    var conn = W.conns[connId];
    var ctrl = ctrlOfConn(W, conn);
    if (!ctrl) return false;
    S.sig.epoch = mod(conn.slot * ctrl.slotS - ctrl.offset - S.t - seconds, ctrl.cycleS) + ALIGN_EPSILON;
    refresh(S);
    return true;
  };

  /**
   * Debug override: holds a whole junction at one state.
   * @param {object} S Sim state.
   * @param {number} juncId Junction.
   * @param {number|string} state SIG.*, or 'G' or 'R'.
   * @param {number} holdS Seconds to hold.
   * @returns {boolean} False if the junction has no controller.
   */
  signals.force = function (S, juncId, state, holdS) {
    var SIG = TLV.const.SIG;
    var junc = S.world.juncs[juncId];
    if (!junc || junc.ctrl < 0) return false;
    var value = state === 'G' ? SIG.GREEN : (state === 'R' ? SIG.RED : state);
    if (!S.sig.forced) S.sig.forced = {};
    S.sig.forced[junc.ctrl] = { state: value, until: S.t + holdS };
    refresh(S);
    return true;
  };
})(window.TLV);
