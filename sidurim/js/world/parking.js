// js/world/parking.js — WP-WORLD
// Parking spots from real kerbs (ARCHITECTURE 8.8), occupancy, and curb queries. A spot is a pure function of the map, derived
// the first time anything asks and kept in W.index, so results never depend on call order.
(function (TLV) {
  'use strict';

  var parking = TLV.ns('world.parking');

  var LEFT = 0;
  var TWO32 = 4294967296;
  var NOT_FOUND = -1;
  /** Half the widest lane the map can hold, for sizing a lane search. */
  var MAX_LANE_HALF = 2.5;
  /** Whether a candidate is clear, once known. */
  var UNKNOWN = 0;
  var YES = 1;
  var NO = 2;

  /** Sorts in place, without the work array Array.sort allocates: parkedNear runs every tick. */
  function sortIds(a) {
    for (var i = 1; i < a.length; i++) {
      var v = a[i];
      var k = i - 1;
      while (k >= 0 && a[k] > v) {
        a[k + 1] = a[k];
        k--;
      }
      a[k + 1] = v;
    }
  }

  /** @returns {number} The kerb offset of an edge side. */
  function kerbOffset(e, side) {
    return side === LEFT ? e.kerbOffL : e.kerbOffR;
  }

  /** @returns {number} The parking strip width of an edge side. */
  function stripWidth(e, side) {
    return side === LEFT ? e.parkL : e.parkR;
  }

  /** @returns {boolean} True when a kerb row can hold stalls. */
  function holdsSpots(W, kerb) {
    return kerb.tier <= TLV.tune.world.spotMaxTier && stripWidth(W.edges[kerb.edge], kerb.side) > 0;
  }

  /**
   * The lane beside an edge side: the kerb lane of the direction that side serves.
   * @returns {?object} Lane, or null.
   */
  function adjacentLane(W, e, side) {
    var d;
    if (side === LEFT) {
      if (e.lanesB > 0) {
        d = W.dirEdges[e.id * 2 + 1];
        return d ? W.lanes[d.lanes[0]] : null;
      }
      d = W.dirEdges[e.id * 2];
      return d ? W.lanes[d.lanes[d.lanes.length - 1]] : null;
    }
    d = W.dirEdges[e.id * 2];
    return d ? W.lanes[d.lanes[0]] : null;
  }

  /**
   * True when a parked car here would be in the way: its box reaches a footprint or the carriageway of a lane or a connector,
   * or it stands in a junction. Section 8.8 asks only that the centre clear a footprint. But a stall a car cannot fit in traps
   * the player, and AI cannot see a parked car across its path. Lanes stop at the stop line, which is why connectors and
   * junctions need their own look: a kerb row can run across the mouth of another road.
   * @returns {boolean}
   */
  function stallBlocked(W, c) {
    var T = TLV.tune.world;
    var geom = TLV.world.geom;
    var spatial = TLV.world.spatial;
    var box = geom._setBox(W.index.spotBoxA, c.x, c.y, c.h, T.parkedCarLen / 2, T.parkedCarWid / 2);
    if (spatial._boxInFootprint(W, box, T.spotWallClear) || spatial._inJunction(W, c.x, c.y)) return true;
    var buf = W.index.spotLanes;
    var reach = box.hl + box.hw + T.spotLaneClear + MAX_LANE_HALF;
    var near = TLV.world.lanes.lanesNear(W, c.x, c.y, reach, buf);
    for (var k = 0; k < near; k++) {
      var lane = W.lanes[buf[k]];
      if (geom._lineNearBox(lane.px, lane.py, box, lane.width / 2 + T.spotLaneClear)) return true;
    }
    return spatial._boxOnConnector(W, box, T.spotLaneClear, MAX_LANE_HALF);
  }

  /** @returns {boolean} True when a stall candidate is clear of everything but other stalls. Remembered, and pure. */
  function isClear(W, c) {
    if (c.clear === UNKNOWN) c.clear = stallBlocked(W, c) ? NO : YES;
    return c.clear === YES;
  }

  /** @returns {boolean} True when the car of stall p stands in stall q. */
  function carInStall(W, p, q) {
    var T = TLV.tune.world;
    var geom = TLV.world.geom;
    return geom._boxesOverlap(geom._setBox(W.index.spotBoxA, p.x, p.y, p.h, T.parkedCarLen / 2, T.parkedCarWid / 2),
      geom._setBox(W.index.spotBoxB, q.x, q.y, q.h, T.spotLen / 2, T.spotWid / 2));
  }

  /**
   * True when a candidate survives. Where two clear candidates clash, because kerbs meet at a bend or at the end of a median,
   * the lower id stands. Only clear candidates can take a stall away, and whether a candidate is clear depends on the map
   * alone, so this cannot depend on what was asked before, and a stall's number never moves.
   * @returns {boolean}
   */
  function stands(W, c) {
    if (!isClear(W, c)) return false;
    var index = W.index;
    var list = index.stallList;
    var near = index.stallNear;
    var n = TLV.world.spatial._pointsNear(index.stallGrid, list, c.x, c.y, index.stallReach, near);
    for (var i = 0; i < n; i++) {
      var other = list[near[i]];
      if (other.order >= c.order || !isClear(W, other)) continue;
      if (carInStall(W, other, c) || carInStall(W, c, other)) return false;
    }
    return true;
  }

  /**
   * Makes the candidate for stall number i of a kerb row. Stalls are packed from the row's start, so a stall's number never
   * changes with the fate of its neighbours.
   * @returns {?object} Candidate, or null when the whole car would not lie along its lane, so that it has a lane to pull
   *   out into and does not hang past a stop line.
   */
  function candidate(W, kerb, lane, lateral, i, order, at, proj) {
    var T = TLV.tune.world;
    var math = TLV.math;
    var e = W.edges[kerb.edge];
    var sign = kerb.side === LEFT ? 1 : -1;
    math.polyAt(e.px, e.py, e.cum, kerb.s0 + T.spotLen * (i + 0.5), at);
    var x = at.x - Math.sin(at.h) * sign * lateral;
    var y = at.y + Math.cos(at.h) * sign * lateral;
    math.polyProject(lane.px, lane.py, lane.cum, x, y, -1, proj);
    var end = T.parkedCarLen / 2;
    if (proj.s < end || proj.s > lane.len - end) return null;
    math.polyAt(lane.px, lane.py, lane.cum, proj.s, at);
    return { order: order, x: x, y: y, h: at.h, laneId: lane.id, laneS: proj.s, clear: UNKNOWN };
  }

  /**
   * Places every stall candidate of the map, once. Positions are cheap and need nothing but the kerb row, which is what lets
   * a stall be compared with its neighbours on other kerbs without deriving those kerbs first.
   * @returns {Array<Array<?object>>} Candidates by kerb row, by stall number.
   */
  function candidateRows(W) {
    var index = W.index;
    if (index.stallRows) return index.stallRows;
    var T = TLV.tune.world;
    var rows = new Array(W.kerbs.length);
    var list = [];
    var at = { x: 0, y: 0, h: 0 };
    var proj = { s: 0, d: 0, side: 0 };
    for (var k = 0; k < W.kerbs.length; k++) {
      var kerb = W.kerbs[k];
      var row = [];
      if (holdsSpots(W, kerb)) {
        var e = W.edges[kerb.edge];
        var lane = adjacentLane(W, e, kerb.side);
        var n = Math.min(T.spotsPerKerb, Math.floor((kerb.s1 - kerb.s0) / T.spotLen));
        var lateral = kerbOffset(e, kerb.side) - T.spotInset;
        for (var i = 0; i < n; i++) {
          var c = lane ? candidate(W, kerb, lane, lateral, i, list.length, at, proj) : null;
          row.push(c);
          if (c) list.push(c);
        }
      }
      rows[k] = row;
    }
    index.stallList = list;
    index.stallGrid = TLV.world.spatial._pointGrid(W, T.spotGridM, list);
    index.stallRows = rows;
    return rows;
  }

  /**
   * Derives every stall of a kerb row once.
   * @returns {Array<?object>} ParkingSpot by stall number, null where a stall was rejected.
   */
  function stallsOf(W, kerbId) {
    var cache = W.index.stalls;
    if (cache[kerbId]) return cache[kerbId];
    var T = TLV.tune.world;
    var kerb = W.kerbs[kerbId];
    var row = candidateRows(W)[kerbId];
    var out = [];
    for (var i = 0; i < row.length; i++) {
      var c = row[i];
      if (!c || !stands(W, c)) {
        out.push(null);
        continue;
      }
      out.push(Object.freeze({
        id: kerbId * T.spotsPerKerb + i,
        kerb: kerbId,
        edge: kerb.edge,
        side: kerb.side,
        x: c.x,
        y: c.y,
        h: c.h,
        len: T.spotLen,
        wid: T.spotWid,
        paint: kerb.paint,
        zone: kerb.zone,
        tier: kerb.tier,
        laneId: c.laneId,
        laneS: c.laneS
      }));
    }
    cache[kerbId] = out;
    return out;
  }

  /**
   * Prepares kerb lookups and search scratch space.
   * @param {object} W World with lanes and the edge grid.
   */
  parking._build = function (W) {
    var nE = W.edges.length;
    var counts = new Int32Array(nE + 1);
    var i;
    for (i = 0; i < W.kerbs.length; i++) counts[W.kerbs[i].edge + 1]++;
    for (i = 0; i < nE; i++) counts[i + 1] += counts[i];
    var rows = new Int32Array(W.kerbs.length);
    var next = counts.slice();
    for (i = 0; i < W.kerbs.length; i++) rows[next[W.kerbs[i].edge]++] = i;
    var byEdge = { start: counts, rows: rows };
    var nJ = W.juncs.length;
    var reach = 0;
    for (i = 0; i < nE; i++) reach = Math.max(reach, W.edges[i].kerbOffL, W.edges[i].kerbOffR);
    W.index.maxKerbOff = reach;
    var T = TLV.tune.world;
    W.index.spotLanes = new Int32Array(64);
    W.index.spotBoxA = {};
    W.index.spotBoxB = {};
    W.index.stallNear = [];
    W.index.stallReach = Math.sqrt(T.spotLen * T.spotLen + T.spotWid * T.spotWid) / 2 +
      Math.sqrt(T.parkedCarLen * T.parkedCarLen + T.parkedCarWid * T.parkedCarWid) / 2;
    W.index.kerbsByEdge = byEdge;
    W.index.stalls = new Array(W.kerbs.length);
    W.index.road = {
      dist: new Float64Array(nJ),
      seen: new Int32Array(nJ),
      stamp: 0,
      heap: new Int32Array(W.edges.length * 2 + 8),
      keys: new Float64Array(W.edges.length * 2 + 8)
    };
  };

  /**
   * Creates S.parking. overrides holds only what differs from the baseline. It also places the stall candidates, which is the
   * one part of deriving spots that is not spread thin, so that a tick never pays for it.
   * @param {object} S Sim state.
   */
  parking.init = function (S) {
    S.parking = { overrides: new Map(), _ids: [] };
    // A TLV with no map is a package testing alone (ARCHITECTURE 5), and has no kerbs to place.
    if (S.world) {
      TLV.world.spatial._edgeGrid(S.world);
      candidateRows(S.world);
    }
  };

  /**
   * Clears all overrides, back to baseline.
   * @param {object} S Sim state.
   */
  parking.reset = function (S) {
    S.parking.overrides.clear();
  };

  /**
   * @param {object} W World.
   * @param {number} spotId kerbId * 1024 + n, or -1.
   * @returns {?object} ParkingSpot (ARCHITECTURE 10.7), or null if no such stall exists. Frozen, and shared between calls.
   */
  parking.spot = function (W, spotId) {
    if (!(spotId >= 0)) return null;
    var per = TLV.tune.world.spotsPerKerb;
    var kerbId = Math.floor(spotId / per);
    if (kerbId >= W.kerbs.length) return null;
    var stall = stallsOf(W, kerbId)[spotId - kerbId * per];
    return stall || null;
  };

  /**
   * Spots whose centre lies within r of a point. Pure: the list is sorted, so it never reflects what was asked before.
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} r Radius, metres.
   * @param {number[]} out Cleared, then receives spot ids in ascending order.
   * @returns {number} Count.
   */
  parking.spotsNear = function (W, x, y, r, out) {
    var index = W.index;
    var g = TLV.world.spatial._edgeGrid(W);
    var byEdge = index.kerbsByEdge;
    var T = TLV.tune.world;
    out.length = 0;
    if (!g) return 0;
    // A stall centre stands well inside the road's reach, so edges are searched that much wider.
    var pad = r + index.maxKerbOff;
    var seen = index.edgeStamps.marks;
    var stamp = TLV.world.spatial._nextStamp(index.edgeStamps);
    var cx0 = Math.max(0, Math.floor((x - pad - g.minX) / g.cell));
    var cx1 = Math.min(g.nx - 1, Math.floor((x + pad - g.minX) / g.cell));
    var cy0 = Math.max(0, Math.floor((y - pad - g.minY) / g.cell));
    var cy1 = Math.min(g.ny - 1, Math.floor((y + pad - g.minY) / g.cell));
    var r2 = r * r;
    for (var cy = cy0; cy <= cy1; cy++) {
      for (var cx = cx0; cx <= cx1; cx++) {
        var c = cy * g.nx + cx;
        for (var k = g.start[c]; k < g.start[c + 1]; k++) {
          var edge = g.items[k];
          if (seen[edge] === stamp) continue;
          seen[edge] = stamp;
          for (var q = byEdge.start[edge]; q < byEdge.start[edge + 1]; q++) {
            var kerbId = byEdge.rows[q];
            if (!holdsSpots(W, W.kerbs[kerbId])) continue;
            var stalls = stallsOf(W, kerbId);
            for (var i = 0; i < stalls.length; i++) {
              var s = stalls[i];
              if (!s) continue;
              var dx = s.x - x;
              var dy = s.y - y;
              if (dx * dx + dy * dy <= r2) out.push(kerbId * T.spotsPerKerb + i);
            }
          }
        }
      }
    }
    sortIds(out);
    return out.length;
  };

  /**
   * Occupancy of a spot: its override, else the seeded baseline.
   * @param {object} S Sim state.
   * @param {number} spotId Spot, or -1.
   * @returns {number} OCC.*, FREE for an unknown spot.
   */
  parking.state = function (S, spotId) {
    var OCC = TLV.const.OCC;
    if (!(spotId >= 0)) return OCC.FREE;
    var over = S.parking.overrides.get(spotId);
    if (over !== undefined) return over;
    return TLV.rng.hash32(S.seed, spotId) / TWO32 < TLV.tune.world.baselineOccupancy ? OCC.PARKED : OCC.FREE;
  };

  /**
   * Sets a spot's occupancy.
   * @param {object} S Sim state.
   * @param {number} spotId Spot, or -1, which does nothing.
   * @param {number} occ OCC.*
   */
  parking.setState = function (S, spotId, occ) {
    if (spotId >= 0) S.parking.overrides.set(spotId, occ);
  };

  /**
   * Spots holding a static car or a motorcycle, within r of a point.
   * @param {object} S Sim state.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} r Radius, metres.
   * @param {number[]} out Cleared, then receives spot ids in ascending order.
   * @returns {number} Count.
   */
  parking.parkedNear = function (S, x, y, r, out) {
    var OCC = TLV.const.OCC;
    var ids = S.parking._ids;
    parking.spotsNear(S.world, x, y, r, ids);
    out.length = 0;
    for (var i = 0; i < ids.length; i++) {
      var occ = parking.state(S, ids[i]);
      if (occ === OCC.PARKED || occ === OCC.MOTO) out.push(ids[i]);
    }
    return out.length;
  };

  /**
   * The solid box of a spot under an occupancy. A motorcycle is smaller than a car. Any other state gives the stall itself.
   * @param {object} W World.
   * @param {number} spotId Spot, or -1.
   * @param {number} occ OCC.*
   * @param {{x:number,y:number,h:number,length:number,width:number}} [out] Written and returned.
   * @returns {?{x:number,y:number,h:number,length:number,width:number}} Null for an unknown spot.
   */
  parking.boxOf = function (W, spotId, occ, out) {
    var s = parking.spot(W, spotId);
    if (!s) return null;
    var OCC = TLV.const.OCC;
    var T = TLV.tune.world;
    var r = out || {};
    r.x = s.x;
    r.y = s.y;
    r.h = s.h;
    if (occ === OCC.PARKED) {
      r.length = T.parkedCarLen;
      r.width = T.parkedCarWid;
    } else if (occ === OCC.MOTO) {
      r.length = T.motoLen;
      r.width = T.motoWid;
    } else {
      r.length = T.spotLen;
      r.width = T.spotWid;
    }
    return r;
  };

  /** @returns {number} Kerb row of a side at s, or -1. Rows partition a side, so the first that holds s is the one. */
  function rowAt(W, edge, side, s) {
    var byEdge = W.index.kerbsByEdge;
    var last = -1;
    for (var q = byEdge.start[edge]; q < byEdge.start[edge + 1]; q++) {
      var kerb = W.kerbs[byEdge.rows[q]];
      if (kerb.side !== side) continue;
      last = kerb.id;
      if (s >= kerb.s0 && s <= kerb.s1) return kerb.id;
    }
    return last;
  }

  /**
   * Nearest kerb line to a point.
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} r Largest distance from the kerb line, metres.
   * @param {{kerb:number,side:number,paint:number,dist:number,h:number}} [out] Written and returned.
   * @returns {?{kerb:number,side:number,paint:number,dist:number,h:number}} h runs along the kerb in the direction of the
   *   adjacent lane. Null when no kerb is in range.
   */
  parking.kerbAt = function (W, x, y, r, out) {
    var index = W.index;
    var g = TLV.world.spatial._edgeGrid(W);
    if (!g) return null;
    var math = TLV.math;
    var tmp = index.tmpProject;
    var at = index.tmpPoint;
    var pad = r + index.maxKerbOff;
    var seen = index.edgeStamps.marks;
    var stamp = TLV.world.spatial._nextStamp(index.edgeStamps);
    var cx0 = Math.max(0, Math.floor((x - pad - g.minX) / g.cell));
    var cx1 = Math.min(g.nx - 1, Math.floor((x + pad - g.minX) / g.cell));
    var cy0 = Math.max(0, Math.floor((y - pad - g.minY) / g.cell));
    var cy1 = Math.min(g.ny - 1, Math.floor((y + pad - g.minY) / g.cell));
    var best = -1;
    var bestD = Infinity;
    var bestSide = 0;
    var bestH = 0;
    for (var cy = cy0; cy <= cy1; cy++) {
      for (var cx = cx0; cx <= cx1; cx++) {
        var c = cy * g.nx + cx;
        for (var k = g.start[c]; k < g.start[c + 1]; k++) {
          var edge = g.items[k];
          if (seen[edge] === stamp) continue;
          seen[edge] = stamp;
          var e = W.edges[edge];
          math.polyProject(e.px, e.py, e.cum, x, y, -1, tmp);
          var side = tmp.side > 0 ? LEFT : 1;
          var d = Math.abs(tmp.d - kerbOffset(e, side));
          if (d > r || d >= bestD) continue;
          var row = rowAt(W, edge, side, tmp.s);
          if (row < 0) continue;
          math.polyAt(e.px, e.py, e.cum, tmp.s, at);
          best = row;
          bestD = d;
          bestSide = side;
          bestH = side === LEFT && e.lanesB > 0 ? math.wrapPi(at.h + Math.PI) : at.h;
        }
      }
    }
    if (best < 0) return null;
    var res = out || {};
    res.kerb = best;
    res.side = bestSide;
    res.paint = W.kerbs[best].paint;
    res.dist = bestD;
    res.h = bestH;
    return res;
  };

  /** Finds the edge nearest a point, leaving s in tmpProject. @returns {number} Edge id or -1. */
  function nearestEdge(W, x, y) {
    var index = W.index;
    var g = TLV.world.spatial._edgeGrid(W);
    var math = TLV.math;
    var tmp = index.tmpProject;
    var reach = TLV.tune.world.roadDistanceSnapM;
    var seen = index.edgeStamps.marks;
    var stamp = TLV.world.spatial._nextStamp(index.edgeStamps);
    var cx0 = Math.max(0, Math.floor((x - reach - g.minX) / g.cell));
    var cx1 = Math.min(g.nx - 1, Math.floor((x + reach - g.minX) / g.cell));
    var cy0 = Math.max(0, Math.floor((y - reach - g.minY) / g.cell));
    var cy1 = Math.min(g.ny - 1, Math.floor((y + reach - g.minY) / g.cell));
    var best = NOT_FOUND;
    var bestD = reach;
    var bestS = 0;
    for (var cy = cy0; cy <= cy1; cy++) {
      for (var cx = cx0; cx <= cx1; cx++) {
        var c = cy * g.nx + cx;
        for (var k = g.start[c]; k < g.start[c + 1]; k++) {
          var edge = g.items[k];
          if (seen[edge] === stamp) continue;
          seen[edge] = stamp;
          var e = W.edges[edge];
          math.polyProject(e.px, e.py, e.cum, x, y, -1, tmp);
          if (tmp.d < bestD || (tmp.d === bestD && edge < best)) {
            best = edge;
            bestD = tmp.d;
            bestS = tmp.s;
          }
        }
      }
    }
    tmp.s = bestS;
    return best;
  }

  /**
   * Distance along the road graph from a point to a spot, ignoring one-way rules, because the question is how far a
   * person is from it (GAME_DESIGN 12.2).
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} spotId Spot.
   * @returns {number} Metres, or Infinity past 400 m, for an unknown spot, or with no road near the point.
   */
  parking.roadDistance = function (W, x, y, spotId) {
    var spot = parking.spot(W, spotId);
    if (!spot) return Infinity;
    var math = TLV.math;
    var limit = TLV.tune.world.roadDistanceMax;
    var startEdge = nearestEdge(W, x, y);
    if (startEdge < 0) return Infinity;
    var s0 = W.index.tmpProject.s;
    var target = W.edges[spot.edge];
    math.polyProject(target.px, target.py, target.cum, spot.x, spot.y, -1, W.index.tmpProject);
    var s1 = W.index.tmpProject.s;
    var best = startEdge === spot.edge ? Math.abs(s1 - s0) : Infinity;

    var road = W.index.road;
    var seen = road.seen;
    var dist = road.dist;
    road.stamp++;
    var stamp = road.stamp;
    var e0 = W.edges[startEdge];
    var size = 0;
    function reach(j, d) {
      if (d >= limit) return;
      if (seen[j] === stamp && dist[j] <= d) return;
      seen[j] = stamp;
      dist[j] = d;
      TLV.world.geom._heapPush(road, size, j, d);
      size++;
    }
    reach(e0.a, s0);
    reach(e0.b, e0.len - s0);
    var arms = W.index.arms;
    while (size > 0) {
      var j = road.heap[0];
      var d = road.keys[0];
      TLV.world.geom._heapPop(road, size);
      size--;
      if (d > dist[j]) continue;
      if (d >= best) break;
      var list = arms[j];
      for (var i = 0; i < list.length; i++) {
        var e = W.edges[list[i].edge];
        if (e.id === spot.edge) {
          var total = d + (list[i].atStart ? s1 : e.len - s1);
          if (total < best) best = total;
        }
        reach(list[i].atStart ? e.b : e.a, d + e.len);
      }
    }
    return best <= limit ? best : Infinity;
  };
})(window.TLV);
