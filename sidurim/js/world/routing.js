// js/world/routing.js — WP-WORLD
// A* over directed edges, so a turn the moves table leaves out cannot be taken (ARCHITECTURE 12.3). Search state lives in
// preallocated typed arrays in W.index, stamped per call, so nothing carries between calls.
(function (TLV) {
  'use strict';

  var routing = TLV.ns('world.routing');

  var LEFT_TURN = 'L';
  var U_TURN = 'U';
  /** How randomExit ranks an exit: the best rank present is used. */
  var RANK_OK = 0;
  var RANK_U_TURN = 1;
  var RANK_OFF_NETWORK = 2;
  var RANK_WALLED = 3;

  /**
   * Builds the arc list once. An arc from directed edge u to v costs the hop across the junction, the penalties, and the
   * whole of v. The hop is priced at top speed: a multi-node junction can be 50 m across, and leaving it free would let the
   * straight-line heuristic overestimate.
   * @param {object} W World with connectors built.
   */
  routing._build = function (W) {
    var T = TLV.tune.world;
    var n = W.dirEdges.length;
    var top = 0;
    var i;
    for (i = 0; i < n; i++) {
      if (W.dirEdges[i] && W.dirEdges[i].vmax > top) top = W.dirEdges[i].vmax;
    }
    if (top <= 0) top = 1;
    var startX = new Float32Array(n);
    var startY = new Float32Array(n);
    var endX = new Float32Array(n);
    var endY = new Float32Array(n);
    var whole = new Float64Array(n);
    var count = 0;
    for (i = 0; i < n; i++) {
      var d = W.dirEdges[i];
      if (!d) continue;
      var e = W.edges[d.edge];
      var last = e.px.length - 1;
      startX[i] = d.dir === 0 ? e.px[0] : e.px[last];
      startY[i] = d.dir === 0 ? e.py[0] : e.py[last];
      endX[i] = d.dir === 0 ? e.px[last] : e.px[0];
      endY[i] = d.dir === 0 ? e.py[last] : e.py[0];
      whole[i] = d.len / d.vmax;
      count += d.moves.length;
    }
    var off = new Int32Array(n + 1);
    var to = new Int32Array(count);
    var hop = new Float64Array(count);
    var o = 0;
    for (i = 0; i < n; i++) {
      off[i] = o;
      var u = W.dirEdges[i];
      if (!u) continue;
      var turns = turnCosts(W, u);
      for (var m = 0; m < u.moves.length; m++) {
        var v = u.moves[m];
        var dx = startX[v] - endX[i];
        var dy = startY[v] - endY[i];
        to[o] = v;
        hop[o] = Math.sqrt(dx * dx + dy * dy) / top + turns[m];
        if (W.juncs[u.to].kind === 'SIGNAL') hop[o] += T.routeSignalS;
        o++;
      }
    }
    off[n] = o;
    priceWalls(W, off, to, hop);
    W.index.route = {
      top: top,
      off: off,
      to: to,
      hop: hop,
      whole: whole,
      endX: endX,
      endY: endY,
      g: new Float64Array(n),
      parent: new Int32Array(n),
      seen: new Int32Array(n),
      done: new Int32Array(n),
      stamp: 0,
      heap: new Int32Array(count + 2),
      keys: new Float64Array(count + 2)
    };
  };

  /** @returns {number[]} Turn cost of each move of a directed edge, in moves order. */
  function turnCosts(W, u) {
    var T = TLV.tune.world;
    var out = new Array(u.moves.length);
    for (var m = 0; m < u.moves.length; m++) out[m] = 0;
    var lanes = u.lanes;
    for (var l = 0; l < lanes.length; l++) {
      var conns = W.lanes[lanes[l]].conns;
      for (var c = 0; c < conns.length; c++) {
        var conn = W.conns[conns[c]];
        if (conn.turn !== LEFT_TURN) continue;
        var target = W.lanes[conn.to].dirEdge;
        for (var k = 0; k < u.moves.length; k++) {
          if (u.moves[k] === target) out[k] = T.routeLeftS;
        }
      }
    }
    return out;
  }

  /**
   * Prices a move whose every connector runs through a wall. A move that also has a clear connector costs nothing extra, because
   * exitLane takes the clear one.
   */
  function priceWalls(W, off, to, hop) {
    var walled = W.index.walledConns;
    for (var i = 0; i < walled.length; i++) {
      var from = W.lanes[W.conns[walled[i]].from].dirEdge;
      var target = W.lanes[W.conns[walled[i]].to].dirEdge;
      if (hasClearConn(W, W.dirEdges[from], target)) continue;
      for (var k = off[from]; k < off[from + 1]; k++) {
        if (to[k] === target) hop[k] += TLV.tune.world.routeWalledS;
      }
    }
  }

  /** @returns {boolean} True when a lane of d reaches target without going through a wall. */
  function hasClearConn(W, d, target) {
    for (var l = 0; l < d.lanes.length; l++) {
      var c = TLV.world.junctions.connFor(W, d.lanes[l], target);
      if (c >= 0 && !W.index.connWalled[c]) return true;
    }
    return false;
  }

  /**
   * Least-cost path of directed edges, from partway along one to partway along another. The start edge is left unvisited so
   * a route can loop back onto it, which is the only way to reach a point behind the car on the same road.
   * @returns {?Int32Array} Directed edges in order, or null. A path of one is impossible here: callers handle that case.
   */
  function search(W, start, startCost, target, targetCost, tx, ty, aiOnly) {
    var T = TLV.tune.world;
    var r = W.index.route;
    var g = r.g;
    var parent = r.parent;
    var seen = r.seen;
    var done = r.done;
    var dirs = W.dirEdges;
    r.stamp++;
    var stamp = r.stamp;
    var slack = T.routeTargetSlackM;
    var top = r.top;

    function heuristic(d) {
      var dx = r.endX[d] - tx;
      var dy = r.endY[d] - ty;
      var far = Math.sqrt(dx * dx + dy * dy) - slack;
      return far > 0 ? far / top : 0;
    }

    var size = 0;
    function relax(from, m, base) {
      var v = r.to[m];
      if (aiOnly && !dirs[v].aiRoutable) return;
      if (done[v] === stamp) return;
      var cost = base + r.hop[m] + (v === target ? targetCost : r.whole[v]);
      if (seen[v] === stamp && g[v] <= cost) return;
      seen[v] = stamp;
      g[v] = cost;
      parent[v] = from;
      TLV.world.geom._heapPush(r, size, v, cost + (v === target ? 0 : heuristic(v)));
      size++;
    }

    var k;
    for (k = r.off[start]; k < r.off[start + 1]; k++) relax(-1, k, startCost);
    while (size > 0) {
      var u = r.heap[0];
      TLV.world.geom._heapPop(r, size);
      size--;
      if (done[u] === stamp) continue;
      done[u] = stamp;
      if (u === target) break;
      for (k = r.off[u]; k < r.off[u + 1]; k++) relax(u, k, g[u]);
    }
    if (done[target] !== stamp) return null;
    var hops = 0;
    var at = target;
    while (at !== -1) {
      hops++;
      at = parent[at];
    }
    var path = new Int32Array(hops + 1);
    at = target;
    for (var i = hops; i >= 1; i--) {
      path[i] = at;
      at = parent[at];
    }
    path[0] = start;
    return path;
  }

  /** Appends a point unless it repeats the last one, filling any gap to the route's spacing. */
  function emit(out, x, y) {
    var n = out.x.length;
    if (n > 0) {
      var lastX = out.x[n - 1];
      var lastY = out.y[n - 1];
      var d = Math.sqrt((x - lastX) * (x - lastX) + (y - lastY) * (y - lastY));
      if (d < 1e-3) return;
      var spacing = TLV.tune.world.routeSpacing;
      if (d > spacing) {
        var steps = Math.ceil(d / spacing);
        for (var i = 1; i < steps; i++) {
          out.x.push(lastX + (x - lastX) * i / steps);
          out.y.push(lastY + (y - lastY) * i / steps);
        }
      }
    }
    out.x.push(x);
    out.y.push(y);
  }

  /** Appends a stretch of a lane. */
  function emitLane(out, lane, s0, s1) {
    var math = TLV.math;
    var at = { x: 0, y: 0, h: 0 };
    math.polyAt(lane.px, lane.py, lane.cum, s0, at);
    emit(out, at.x, at.y);
    for (var i = 0; i < lane.px.length; i++) {
      if (lane.cum[i] > s0 && lane.cum[i] < s1) emit(out, lane.px[i], lane.py[i]);
    }
    math.polyAt(lane.px, lane.py, lane.cum, s1, at);
    emit(out, at.x, at.y);
  }

  /** @returns {number} The lane of d to reach next from, nearest in index to nearIdx, any lane going through a wall last. */
  function exitLane(W, d, next, nearIdx) {
    var walled = W.index.connWalled;
    var best = -1;
    var bestGap = Infinity;
    for (var l = 0; l < d.lanes.length; l++) {
      var lane = W.lanes[d.lanes[l]];
      for (var c = 0; c < lane.conns.length; c++) {
        if (W.lanes[W.conns[lane.conns[c]].to].dirEdge !== next) continue;
        var gap = Math.abs(l - nearIdx) + (walled[lane.conns[c]] ? d.lanes.length : 0);
        if (gap < bestGap) {
          bestGap = gap;
          best = lane.id;
        }
        break;
      }
    }
    return best;
  }

  /**
   * Picks a lane on each directed edge of a path and draws the lane-centre polyline. Where the lane entered is not the lane
   * that holds the next connector, the line changes lane in the middle of the road, as a car would.
   * @returns {{x: number[], y: number[]}} Points at 3 m spacing or better.
   */
  function drawPath(W, path, fromLane, fromS, toLane, toS) {
    var out = { x: [], y: [] };
    var count = path.length;
    var enter = fromLane;
    var enterS = fromS;
    for (var i = 0; i < count; i++) {
      var d = W.dirEdges[path[i]];
      var lastHop = i + 1 === count;
      var exit = lastHop ? toLane : exitLane(W, d, path[i + 1], W.lanes[enter].idx);
      if (exit < 0) exit = enter;
      var a = W.lanes[enter];
      var b = W.lanes[exit];
      var endS = lastHop ? toS : b.len;
      if (a.id === b.id) {
        emitLane(out, a, enterS, endS);
      } else {
        // The change sits in the middle of what is left, proportionally on each lane.
        var mid = Math.max(enterS, Math.min(a.len, enterS + (Math.min(endS, a.len) - enterS) * 0.4));
        var after = Math.min(b.len, enterS + (endS - enterS) * 0.6);
        emitLane(out, a, enterS, mid);
        emitLane(out, b, Math.min(after, endS), endS);
      }
      if (lastHop) break;
      var conn = W.conns[TLV.world.junctions.connFor(W, exit, path[i + 1])];
      if (conn) {
        for (var p = 1; p < conn.px.length; p++) emit(out, conn.px[p], conn.py[p]);
        enter = conn.to;
      } else {
        enter = W.dirEdges[path[i + 1]].lanes[0];
      }
      enterS = 0;
    }
    return out;
  }

  /** Packs a drawn path into a Route. */
  function makeRoute(path, drawn, fromS, toS) {
    var px = Float32Array.from(drawn.x);
    var py = Float32Array.from(drawn.y);
    var cum = TLV.math.cumLen(px, py);
    return {
      dirEdges: path,
      len: cum.length ? cum[cum.length - 1] : 0,
      px: px,
      py: py,
      cum: cum,
      fromS: fromS,
      toS: toS
    };
  }

  /**
   * Routes between two lane positions, at lane level for the ends and directed-edge level between them.
   * @param {object} W World.
   * @param {number} fromLaneId Start lane.
   * @param {number} fromS Metres along it.
   * @param {number} toLaneId Target lane.
   * @param {number} toS Metres along it.
   * @param {{ai?: boolean}} [opts] ai restricts the route to aiRoutable directed edges. The start edge is always allowed.
   * @returns {?object} Route (ARCHITECTURE 10.8), or null when none exists. fromS and toS are lane positions.
   */
  routing.routeLanes = function (W, fromLaneId, fromS, toLaneId, toS, opts) {
    var math = TLV.math;
    var a = W.lanes[fromLaneId];
    var b = W.lanes[toLaneId];
    if (!a || !b) return null;
    var aiOnly = !!(opts && opts.ai);
    var startS = math.clamp(fromS, 0, a.len);
    var endS = math.clamp(toS, 0, b.len);
    if (aiOnly && !W.dirEdges[b.dirEdge].aiRoutable) return null;
    if (a.dirEdge === b.dirEdge && endS >= startS) {
      var path1 = Int32Array.of(a.dirEdge);
      return makeRoute(path1, drawPath(W, path1, fromLaneId, startS, toLaneId, endS), startS, endS);
    }
    var at = { x: 0, y: 0, h: 0 };
    math.polyAt(b.px, b.py, b.cum, endS, at);
    var startDir = W.dirEdges[a.dirEdge];
    var startCost = (a.len - startS) / startDir.vmax;
    var targetCost = endS / W.dirEdges[b.dirEdge].vmax;
    var path = search(W, a.dirEdge, startCost, b.dirEdge, targetCost, at.x, at.y, aiOnly);
    if (!path) return null;
    return makeRoute(path, drawPath(W, path, fromLaneId, startS, toLaneId, endS), startS, endS);
  };

  /**
   * Routes from a free position, by snapping it to the nearest lane in its direction of travel.
   * @param {object} W World.
   * @param {number} fromX Start x.
   * @param {number} fromY Start y.
   * @param {?number} fromH Heading, or null to ignore it.
   * @param {number} toLaneId Target lane.
   * @param {number} toS Metres along it.
   * @param {{ai?: boolean, maxDist?: number}} [opts] ai as in routeLanes, and it limits the snap too. maxDist bounds it.
   * @returns {?object} Route, or null with no lane in reach or no route.
   */
  routing.route = function (W, fromX, fromY, fromH, toLaneId, toS, opts) {
    var aiOnly = !!(opts && opts.ai);
    var reach = opts && opts.maxDist ? opts.maxDist : TLV.tune.world.routeSnapM;
    var near = TLV.world.lanes._nearest(W, fromX, fromY, fromH, reach, aiOnly, {});
    if (!near) return null;
    return routing.routeLanes(W, near.laneId, near.s, toLaneId, toS, opts);
  };

  /**
   * Projects a point on a route's polyline.
   * @param {object} route Route.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {?number} hintS Last known s, or null.
   * @param {{s:number,d:number}} [out] Written and returned.
   * @returns {?{s:number,d:number}} Null with no route.
   */
  routing.project = function (route, x, y, hintS, out) {
    if (!route) return null;
    var r = out || { s: 0, d: 0, side: 0 };
    TLV.math.polyProject(route.px, route.py, route.cum, x, y, hintS, r);
    return r;
  };

  /**
   * Picks an exit from a lane for a random walk, weighted by the class of the road it leads to (ARCHITECTURE 13.3). An exit
   * that leaves the AI network, or a U-turn, is used only when nothing else remains, and one through a wall after all of those.
   * @param {object} W World.
   * @param {number} laneId Lane, or -1.
   * @param {{next: function(): number}} rng Stream. It is drawn from only when there is a real choice.
   * @returns {number} Connector id, or -1 with no exit.
   */
  routing.randomExit = function (W, laneId, rng) {
    var lane = W.lanes[laneId];
    if (!lane || lane.conns.length === 0) return -1;
    var conns = lane.conns;
    if (conns.length === 1) return conns[0];
    var weights = TLV.tune.world.classWeights;
    var ai = TLV.const.LF.AI_ROUTABLE;
    var total = 0;
    var i;
    var rank;
    var bestRank = RANK_WALLED;
    for (i = 0; i < conns.length; i++) {
      rank = exitRank(W, conns[i], ai);
      if (rank < bestRank) bestRank = rank;
    }
    for (i = 0; i < conns.length; i++) {
      if (exitRank(W, conns[i], ai) === bestRank) total += weights[W.lanes[W.conns[conns[i]].to].cls];
    }
    var u = rng.next() * total;
    var last = -1;
    for (i = 0; i < conns.length; i++) {
      if (exitRank(W, conns[i], ai) !== bestRank) continue;
      last = conns[i];
      u -= weights[W.lanes[W.conns[conns[i]].to].cls];
      if (u < 0) return last;
    }
    return last;
  };

  /** @returns {number} An exit's RANK_*. */
  function exitRank(W, connId, ai) {
    var conn = W.conns[connId];
    if (W.index.connWalled[connId]) return RANK_WALLED;
    if (!(W.lanes[conn.to].flags & ai)) return RANK_OFF_NETWORK;
    return conn.turn === U_TURN ? RANK_U_TURN : RANK_OK;
  }
})(window.TLV);
