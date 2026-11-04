// js/sim/peds/cross.js — WP-PEDS
// Getting across a road. ARCHITECTURE 8.4 snaps a crossing inside a trimmed region to its lane, so for a car the zone IS the crossing,
// wherever the OSM node stands. This file holds walkers to that: everyone crosses on a line through the crossing's zones, never on
// a connector ahead of the zone meant to protect them. All zones of a crossing lie on one line across the road (spread 0.84 m at
// p99), so that line exists.
//
// One exception. A zone within a car length of a stop line lies under the first waiting car, so on those lanes the line runs just
// past the stop line, in front of that car's nose. The zone then stands behind the walker, between them and anything still coming.
(function (TLV) {
  'use strict';

  var cross = TLV.ns('peds.cross');

  /** Most lanes across one road, each way, then the points around them. */
  var ZONE_CAP = 12;
  var POINT_CAP = ZONE_CAP + 4;
  /** Connectors under one line. A junction holds 31 at most, and a line meets a fraction of them. */
  var CONN_CAP = 32;

  /** @returns {object} A crossing path, empty. */
  function newPath() {
    return {
      xing: -1, n: 0, total: 0,
      x: new Float64Array(POINT_CAP), y: new Float64Array(POINT_CAP), arc: new Float64Array(POINT_CAP),
      kerbA: 0, kerbB: 0,
      ax: 0, ay: 0, bx: 0, by: 0,
      nz: 0, width: 0,
      zArc: new Float64Array(ZONE_CAP), zX: new Float64Array(ZONE_CAP), zY: new Float64Array(ZONE_CAP),
      zS: new Float64Array(ZONE_CAP), zHalf: new Float64Array(ZONE_CAP), zClear: new Float64Array(ZONE_CAP),
      zLane: new Int32Array(ZONE_CAP), zZone: new Int32Array(ZONE_CAP),
      /** Connectors under the line, so people on them can be reported on the lanes either side. */
      nc: 0, cId: new Int32Array(CONN_CAP), cU: new Float32Array(CONN_CAP), cA0: new Float32Array(CONN_CAP), cA1: new Float32Array(CONN_CAP),
      swA: -1, sA: 0, swB: -1, sB: 0,
      /** clear: nothing stands in the way of the line. ambient: and it lands on a sidewalk at both ends. */
      clear: false, ambient: false,
      /** Metres back from each kerb to the nearest place out of turning cars' way. */
      backA: 0, backB: 0,
      /** A carriageway's crossing with no sidewalk on its median side, and the other carriageway's crossing: -2 until looked for. */
      partner: -2,
      /** Direction along the far row on landing, 0 to choose. */
      endDir: 0,
      spots: []
    };
  }

  /** Point on a path. Paths hold a handful of points, so a walk along them is the fastest search. */
  function pathPoint(path, arc, out) {
    var a = path.arc;
    var i = 0;
    while (i + 2 < path.n && arc > a[i + 1]) i++;
    var len = a[i + 1] - a[i];
    var t = len > 0 ? (arc - a[i]) / len : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    out.x = path.x[i] + (path.x[i + 1] - path.x[i]) * t;
    out.y = path.y[i] + (path.y[i + 1] - path.y[i]) * t;
  }

  /** @returns {boolean} True when cars wait at the far end of this lane: a stop line, not a mere join in the road. */
  function stopsAtEnd(W, lane) {
    var j = W.juncs[TLV.world.junctions.ahead(W, lane.id)];
    return !!j && j.kind !== 'PASS';
  }

  /** The kerb of an edge side, at a place along the edge. */
  function kerbPoint(e, arc, side, out) {
    var at = TLV.math.polyAt(e.px, e.py, e.cum, arc, out);
    var off = side === 0 ? e.kerbOffL : -e.kerbOffR;
    out.x = at.x - Math.sin(at.h) * off;
    out.y = at.y + Math.cos(at.h) * off;
  }

  /**
   * Finds where one end of a path lands on a sidewalk. A crossing recorded with no row on a side may still reach one close by, as
   * long as nothing stands between: a median with no ribbon must not send a walker on across the other carriageway.
   * @returns {boolean} True when it lands. Writes swA, sA or swB, sB.
   */
  function land(S, path, e, side, swId, kx, ky) {
    var W = S.world;
    var T = TLV.tune.peds;
    var sys = S.pedsys;
    var math = TLV.math;
    var pr = sys.pr;
    var at = sys.pt;
    var id = swId;
    var s;
    if (id >= 0) {
      var row = W.sidewalks[id];
      math.polyProject(row.px, row.py, row.cum, kx, ky, -1, pr);
      if (pr.d > T.landMaxM) return false;
      s = pr.s;
    } else {
      var near = TLV.world.sidewalks.nearest(W, kx, ky, sys.swOut);
      if (!near || near.d > T.landMaxM / 2) return false;
      id = near.sw;
      s = near.s;
    }
    TLV.world.sidewalks.pointAt(W, id, s, at);
    if (swId < 0) {
      math.polyProject(e.px, e.py, e.cum, at.x, at.y, -1, pr);
      if (pr.side !== (side === 0 ? 1 : -1)) return false;
      if (TLV.peds.walk.onLanes(S, kx, ky, at.x, at.y)) return false;
    }
    if (TLV.world.spatial.rayBlocked(W, at.x, at.y, kx, ky)) return false;
    if (side === 0) {
      path.swA = id;
      path.sA = s;
      path.ax = at.x;
      path.ay = at.y;
    } else {
      path.swB = id;
      path.sB = s;
      path.bx = at.x;
      path.by = at.y;
    }
    return true;
  }

  /** Lays out a path from the conflicts held in sys.it, left to right across the road: kerb, conflicts, kerb. */
  function layout(S, path, e, n) {
    var math = TLV.math;
    var it = S.pedsys.it;
    var at = S.pedsys.pt;
    var order = S.pedsys.order;
    var i;
    for (i = 0; i < n; i++) {
      var k = i;
      for (; k > 0 && it.lat[order[k - 1]] < it.lat[i]; k--) order[k] = order[k - 1];
      order[k] = i;
    }
    var first = order[0];
    var last = order[n - 1];
    var m = 0;
    kerbPoint(e, it.arc[first], 0, at);
    path.x[m] = at.x;
    path.y[m++] = at.y;
    for (i = 0; i < n; i++) {
      var q = order[i];
      path.x[m] = it.x[q];
      path.y[m++] = it.y[q];
    }
    kerbPoint(e, it.arc[last], 1, at);
    path.x[m] = at.x;
    path.y[m++] = at.y;
    path.n = m;
    path.arc[0] = 0;
    for (i = 1; i < m; i++) path.arc[i] = path.arc[i - 1] + math.dist(path.x[i - 1], path.y[i - 1], path.x[i], path.y[i]);
    path.total = path.arc[m - 1];
    path.kerbA = 0;
    path.kerbB = path.total;
    path.nz = n;
    for (i = 0; i < n; i++) {
      var z = order[i];
      path.zArc[i] = path.arc[i + 1];
      path.zX[i] = it.x[z];
      path.zY[i] = it.y[z];
      path.zS[i] = it.s[z];
      path.zHalf[i] = it.half[z];
      path.zClear[i] = it.clear[z];
      path.zLane[i] = it.lane[z];
      path.zZone[i] = it.zone[z];
    }
  }

  /** Lists stalls whose cars would stand on the walk between a landing and the road. */
  function stallsOnLeg(S, path, ax, ay, bx, by) {
    var W = S.world;
    var T = TLV.tune.peds;
    var sys = S.pedsys;
    var math = TLV.math;
    var d = math.dist(ax, ay, bx, by);
    var count = TLV.world.parking.spotsNear(W, (ax + bx) / 2, (ay + by) / 2, d / 2 + TLV.tune.world.spotLen, sys.spots);
    var n = Math.max(1, Math.ceil(d * 2));
    var pad = T.walkerR;
    var box = sys.box;
    for (var k = 0; k < count; k++) {
      TLV.world.parking.boxOf(W, sys.spots[k], TLV.const.OCC.PARKED, box);
      var c = Math.cos(box.h);
      var s = Math.sin(box.h);
      var ha = box.length / 2 + pad;
      var hw = box.width / 2 + pad;
      for (var i = 0; i <= n; i++) {
        var dx = ax + (bx - ax) * i / n - box.x;
        var dy = ay + (by - ay) * i / n - box.y;
        var a = dx * c + dy * s;
        var l = dy * c - dx * s;
        if (a > -ha && a < ha && l > -hw && l < hw) {
          if (path.spots.indexOf(sys.spots[k]) < 0) path.spots.push(sys.spots[k]);
          break;
        }
      }
    }
  }

  /** @returns {boolean} True when a line stands on a lane of some other road, whose cars have no zone here to stop at. */
  function overOtherRoad(S, path, edge) {
    var W = S.world;
    var sys = S.pedsys;
    var math = TLV.math;
    var pr = sys.pr;
    var at = sys.pt2;
    for (var a = 0; a <= path.total; a += 0.5) {
      pathPoint(path, a, at);
      var c = TLV.world.lanes.lanesNear(W, at.x, at.y, 3, sys.ints);
      for (var k = 0; k < c; k++) {
        var lane = W.lanes[sys.ints[k]];
        if (lane.edge === edge) continue;
        math.polyProject(lane.px, lane.py, lane.cum, at.x, at.y, -1, pr);
        if (pr.d < lane.width / 2 && pr.s > 0.01 && pr.s < lane.len - 0.01) return true;
      }
    }
    return false;
  }

  /** @returns {number} Metres back from a kerb, toward its landing, to the first place clear of turning cars. */
  function safeBack(S, e, kx, ky, lx, ly) {
    var W = S.world;
    var T = TLV.tune.peds;
    var walk = TLV.peds.walk;
    var d = TLV.math.dist(kx, ky, lx, ly);
    var A = W.juncs[e.a];
    var B = W.juncs[e.b];
    for (var t = 0; t <= d; t += 0.5) {
      var x = kx + (lx - kx) * t / (d || 1);
      var y = ky + (ly - ky) * t / (d || 1);
      if (!walk.inSweep(S, A, x, y, T.waitClearM) && !walk.inSweep(S, B, x, y, T.waitClearM)) return t;
    }
    return d;
  }

  /** Lists the connectors of a junction that run under a line, and where. */
  function connectorsUnder(S, path, J) {
    var W = S.world;
    var T = TLV.tune.peds;
    var sys = S.pedsys;
    var math = TLV.math;
    var pr = sys.pr;
    var at = sys.pt2;
    if (math.dist(J.x, J.y, path.x[0], path.y[0]) > T.connJuncM) return;
    var reach = T.connReachM + T.walkerR;
    for (var k = 0; k < J.conns.length && path.nc < CONN_CAP; k++) {
      var c = W.conns[J.conns[k]];
      var first = -1;
      var last = -1;
      var bestD = Infinity;
      var bestU = 0;
      for (var a = 0; a <= path.total; a += 1) {
        pathPoint(path, a, at);
        math.polyProject(c.px, c.py, c.cum, at.x, at.y, -1, pr);
        if (pr.d > reach) continue;
        if (first < 0) first = a;
        last = a;
        if (pr.d < bestD) {
          bestD = pr.d;
          bestU = pr.s;
        }
      }
      if (first < 0) continue;
      path.cId[path.nc] = c.id;
      path.cU[path.nc] = bestU;
      path.cA0[path.nc] = first - 1;
      path.cA1[path.nc] = last + 1;
      path.nc++;
    }
  }

  /** Builds the walking line of a crossing. Returns null only for a crossing with no lanes. */
  function buildPath(S, xingId) {
    var W = S.world;
    var T = TLV.tune.peds;
    var sys = S.pedsys;
    var math = TLV.math;
    var xing = W.xings[xingId];
    if (!xing || !xing.zones.length || xing.zones.length > ZONE_CAP) return null;
    var e = W.edges[xing.edge];
    var it = sys.it;
    var at = sys.pt;
    var pr = sys.pr;
    var n = xing.zones.length;
    var entry = 0;
    var entryArc = 0;
    var i;
    for (i = 0; i < n; i++) {
      var z = W.zones[xing.zones[i]];
      var lane = W.lanes[z.laneId];
      var centre = (z.s0 + z.s1) / 2;
      var isEntry = stopsAtEnd(W, lane) && lane.len - z.s1 <= T.stopShiftM;
      if (isEntry) {
        TLV.world.lanes.pointAt(W, lane.id, lane.len, at);
        at.x += Math.cos(at.h) * T.lineClearM;
        at.y += Math.sin(at.h) * T.lineClearM;
      } else {
        TLV.world.lanes.pointAt(W, lane.id, centre, at);
      }
      it.x[i] = at.x;
      it.y[i] = at.y;
      math.polyProject(e.px, e.py, e.cum, at.x, at.y, xing.s, pr);
      it.arc[i] = pr.s;
      it.lat[i] = pr.side * pr.d;
      it.entry[i] = isEntry ? 1 : 0;
      it.s[i] = centre;
      it.half[i] = (z.s1 - z.s0) / 2 + T.walkerR;
      it.clear[i] = lane.width / 2 + T.walkerR + T.laneReachM;
      it.lane[i] = lane.id;
      it.zone[i] = z.id;
      if (isEntry) {
        entry++;
        entryArc += pr.s;
      }
    }
    // Lanes leaving the junction stay inside their zones, on the side nearest that line, so the walk does not zigzag.
    if (entry > 0) {
      entryArc /= entry;
      math.polyAt(e.px, e.py, e.cum, entryArc, at);
      var ex = at.x;
      var ey = at.y;
      for (i = 0; i < n; i++) {
        if (it.entry[i]) continue;
        var zz = W.zones[it.zone[i]];
        var ll = W.lanes[zz.laneId];
        math.polyProject(ll.px, ll.py, ll.cum, ex, ey, -1, pr);
        var lo = Math.min(zz.s0 + T.zoneInsetM, (zz.s0 + zz.s1) / 2);
        var hi = Math.max(zz.s1 - T.zoneInsetM, (zz.s0 + zz.s1) / 2);
        TLV.world.lanes.pointAt(W, ll.id, math.clamp(pr.s, lo, hi), at);
        it.x[i] = at.x;
        it.y[i] = at.y;
        math.polyProject(e.px, e.py, e.cum, at.x, at.y, xing.s, pr);
        it.arc[i] = pr.s;
        it.lat[i] = pr.side * pr.d;
      }
    }
    var path = newPath();
    path.xing = xingId;
    layout(S, path, e, n);
    path.width = path.total;
    var okA = land(S, path, e, 0, xing.swA, path.x[0], path.y[0]);
    var okB = land(S, path, e, 1, xing.swB, path.x[path.n - 1], path.y[path.n - 1]);
    var clear = path.total <= T.pathMaxM;
    for (i = 0; i + 1 < path.n && clear; i++) {
      if (TLV.world.spatial.rayBlocked(W, path.x[i], path.y[i], path.x[i + 1], path.y[i + 1])) clear = false;
    }
    path.clear = clear && !overOtherRoad(S, path, e.id);
    path.ambient = okA && okB && path.clear;
    if (okA) path.backA = safeBack(S, e, path.x[0], path.y[0], path.ax, path.ay);
    if (okB) path.backB = safeBack(S, e, path.x[path.n - 1], path.y[path.n - 1], path.bx, path.by);
    connectorsUnder(S, path, W.juncs[e.a]);
    connectorsUnder(S, path, W.juncs[e.b]);
    if (okA) stallsOnLeg(S, path, path.ax, path.ay, path.x[1], path.y[1]);
    if (okB) stallsOnLeg(S, path, path.bx, path.by, path.x[path.n - 2], path.y[path.n - 2]);
    return path;
  }

  /**
   * The walking line of a crossing. Derived from the World and cached for this sim.
   * @param {object} S Sim state.
   * @param {number} xingId Crossing.
   * @returns {?object} Path, or null for a crossing no one can walk. path.ambient is false when a walker has nowhere to land.
   */
  cross.pathOf = function (S, xingId) {
    var paths = S.pedsys.xpaths;
    if (!(xingId >= 0) || xingId >= paths.length) return null;
    var path = paths[xingId];
    if (path === undefined) {
      path = buildPath(S, xingId);
      paths[xingId] = path;
    }
    return path;
  };

  /** @returns {object} Crossings by cell, for finding the one across a median. */
  function xingGrid(S) {
    var sys = S.pedsys;
    if (sys.xgrid) return sys.xgrid;
    var cell = TLV.tune.peds.medianM * 2;
    var grid = new Map();
    var W = S.world;
    for (var i = 0; i < W.xings.length; i++) {
      var key = Math.floor((W.xings[i].x - W.bounds.minX) / cell) * 65536 + Math.floor((W.xings[i].y - W.bounds.minY) / cell);
      var list = grid.get(key);
      if (list) list.push(i);
      else grid.set(key, [i]);
    }
    sys.xgrid = grid;
    return grid;
  }

  /** Looks for the crossing on the far side of a median, whose own open side faces this one's. */
  function findPartner(S, path) {
    var W = S.world;
    var T = TLV.tune.peds;
    var math = TLV.math;
    var mine = path.swA < 0 ? 0 : path.n - 1;
    var mx = path.x[mine];
    var my = path.y[mine];
    var cell = T.medianM * 2;
    var grid = xingGrid(S);
    var cx = Math.floor((mx - W.bounds.minX) / cell);
    var cy = Math.floor((my - W.bounds.minY) / cell);
    var best = -1;
    var bestD = T.medianM;
    for (var a = cx - 1; a <= cx + 1; a++) {
      for (var b = cy - 1; b <= cy + 1; b++) {
        var list = grid.get(a * 65536 + b);
        for (var i = 0; list && i < list.length; i++) {
          var id = list[i];
          if (id === path.xing || W.xings[id].edge === W.xings[path.xing].edge) continue;
          var q = cross.pathOf(S, id);
          if (!q || !q.clear || (q.swA < 0) === (q.swB < 0)) continue;
          var open = q.swA < 0 ? 0 : q.n - 1;
          var d = math.dist(mx, my, q.x[open], q.y[open]);
          if (d > bestD || (d === bestD && id > best)) continue;
          if (TLV.world.spatial.rayBlocked(W, mx, my, q.x[open], q.y[open])) continue;
          if (TLV.peds.walk.onLanes(S, mx, my, q.x[open], q.y[open])) continue;
          best = id;
          bestD = d;
        }
      }
    }
    return best;
  }

  /**
   * The crossing that takes a walker on from a median.
   * @param {object} S Sim state.
   * @param {object} path Path.
   * @returns {number} Crossing, or -1.
   */
  cross.partnerOf = function (S, path) {
    if (path.partner === -2) {
      path.partner = path.clear && path.xing >= 0 && (path.swA < 0) !== (path.swB < 0) ? findPartner(S, path) : -1;
    }
    return path.partner;
  };

  /**
   * @param {object} S Sim state.
   * @param {object} path Path.
   * @returns {boolean} True when an ordinary walker can use this crossing: it lands at both ends, or lands at one and a median at the other.
   */
  cross.walkable = function (S, path) {
    return path.ambient || cross.partnerOf(S, path) >= 0;
  };

  /** @returns {object} This person's own path, for a line that is not a crossing. */
  function ownPath(P) {
    if (!P.own) P.own = newPath();
    P.own.spots.length = 0;
    P.own.swA = -1;
    P.own.swB = -1;
    P.own.xing = -1;
    P.own.endDir = 0;
    P.own.partner = -1;
    P.own.nc = 0;
    return P.own;
  }

  /** @returns {boolean} True when a person rides. */
  function isRider(p) {
    return p.kind === 'scooter' || p.kind === 'delivery';
  }

  /**
   * Sends a person to the kerb of a path, to wait their moment there.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {object} path Path.
   * @param {number} pdir +1 to cross from side A, -1 from side B.
   * @param {string} plan LEGAL, RED, JAY, STEP, SLOW or POP.
   */
  cross.start = function (S, p, path, pdir, plan) {
    var P = p._p;
    var T = TLV.tune.peds;
    var rng = S.rng.ped;
    var i = pdir > 0 ? 0 : path.n - 1;
    var hasLand = pdir > 0 ? path.swA >= 0 : path.swB >= 0;
    var lx = pdir > 0 ? path.ax : path.bx;
    var ly = pdir > 0 ? path.ay : path.by;
    var kx = path.x[i];
    var ky = path.y[i];
    var ux = 0;
    var uy = 0;
    if (hasLand) {
      var d = TLV.math.dist(kx, ky, lx, ly);
      if (d > 0.01) {
        ux = (lx - kx) / d;
        uy = (ly - ky) / d;
      }
      var clear = pdir > 0 ? path.backA : path.backB;
      var back = Math.min(d, clear + rng.range(0, Math.min(T.queueBackM, d * 0.8)));
      var side = rng.range(-T.queueSideM, T.queueSideM);
      kx += ux * back - uy * side;
      ky += uy * back + ux * side;
    }
    P.path = path;
    P.pdir = pdir;
    P.plan = plan;
    P.stage = 'NONE';
    P.hopped = false;
    P.hurry = false;
    P.force = false;
    P.pauseT = 0;
    P.pauseAt = -1;
    P.speed = isRider(p) ? T.riderApproach : Math.max(P.base, plan === 'LEGAL' ? P.base : T.approach);
    TLV.peds.walk.goTo(p, kx, ky, 'KERB');
  };

  /**
   * A person has reached the kerb: they stand there until their plan says to go.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   */
  cross.atKerb = function (S, p) {
    var P = p._p;
    var T = TLV.tune.peds;
    var path = P.path;
    var rng = S.rng.ped;
    TLV.peds.walk.halt(p);
    P.mode = 'PATH';
    P.stage = 'WAIT';
    P.arc = P.pdir > 0 ? path.kerbA : path.kerbB;
    pathPoint(path, P.arc, S.pedsys.pt);
    P.ox = P.gx - S.pedsys.pt.x;
    P.oy = P.gy - S.pedsys.pt.y;
    TLV.peds.setState(p, 'WAIT_CROSS');
    P.waitT = 0;
    P.gateT = 0;
    P.redAt = -1;
    // GAME_DESIGN 10: 15% of waiters cross on red, the rest may after 25 s.
    if (P.plan === 'LEGAL' && rng.bool(T.redP)) P.redAt = rng.range(T.redDelayMin, T.redDelayMax);
  };

  /** Everything a person's crossing state holds, gone. They are a plain walker again. */
  function clearCrossing(S, p) {
    var P = p._p;
    p.intent = false;
    P.stage = 'NONE';
    P.path = null;
    P.aim = null;
    P.hold = false;
    P.force = false;
    P.hurry = false;
    P.median = false;
    P.job = 'AMBIENT';
    P.speed = P.base;
    P.crossCool = TLV.tune.peds.crossCoolS;
    TLV.peds.setState(p, 'WALK');
  }

  /**
   * Gives up on crossing and goes back to walking.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   */
  cross.abandon = function (S, p) {
    var P = p._p;
    var turn = P.plan === 'LINK';
    clearCrossing(S, p);
    if (turn) P.dir = -P.dir;
    if (P.sw >= 0) {
      var at = S.pedsys.pt;
      var row = S.world.sidewalks[P.sw];
      TLV.math.polyAt(row.px, row.py, row.cum, P.s, at);
      if (TLV.math.dist(p.x, p.y, at.x, at.y) < TLV.tune.peds.landMaxM * 2) {
        TLV.peds.walk.goTo(p, at.x, at.y, 'ROW');
        return;
      }
    }
    TLV.peds.walk.toSidewalk(S, p);
  };

  /** Far side reached: on to the sidewalk there. */
  function finishRoad(S, p) {
    var P = p._p;
    var path = P.path;
    var pdir = P.pdir;
    if (P.hopped) {
      if (!P.median) {
        cross.abandon(S, p);
        return;
      }
      // A refuge is the only way back: the road behind has its own wait.
      P.hopped = false;
      TLV.peds.setState(p, 'WALK');
      P.gx = p.x;
      P.gy = p.y;
      cross.atKerb(S, p);
      return;
    }
    var row = pdir > 0 ? path.swB : path.swA;
    if (row < 0 && P.job === 'AMBIENT' && cross.partnerOf(S, path) >= 0) {
      var next = cross.pathOf(S, path.partner);
      TLV.peds.setState(p, 'WALK');
      P.median = true;
      cross.start(S, p, next, next.swA < 0 ? 1 : -1, 'LEGAL');
      return;
    }
    clearCrossing(S, p);
    if (row < 0) {
      TLV.peds.walk.toSidewalk(S, p);
      return;
    }
    P.sw = row;
    P.s = pdir > 0 ? path.sB : path.sA;
    P.dir = path.endDir !== 0 ? path.endDir : (S.rng.ped.bool(0.5) ? 1 : -1);
    TLV.peds.walk.goTo(p, pdir > 0 ? path.bx : path.ax, pdir > 0 ? path.by : path.ay, 'ROW');
  }

  /**
   * A corner link that is a crossing in all but name: walked by the same rules, from intent to the far kerb.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {boolean} via True when it goes by a waypoint.
   * @param {number} vx Waypoint x.
   * @param {number} vy Waypoint y.
   * @param {object} row The sidewalk it lands on.
   * @param {number} at Point of that sidewalk it lands on.
   * @param {boolean} toStart True when that is the row's start.
   */
  cross.startLink = function (S, p, via, vx, vy, row, at, toStart) {
    var P = p._p;
    var T = TLV.tune.peds;
    var math = TLV.math;
    var path = ownPath(P);
    var ex = row.px[at];
    var ey = row.py[at];
    var m = 0;
    path.x[m] = p.x;
    path.y[m++] = p.y;
    if (via) {
      path.x[m] = vx;
      path.y[m++] = vy;
    }
    path.x[m] = ex;
    path.y[m++] = ey;
    path.n = m;
    path.arc[0] = 0;
    for (var i = 1; i < m; i++) path.arc[i] = path.arc[i - 1] + math.dist(path.x[i - 1], path.y[i - 1], path.x[i], path.y[i]);
    path.total = path.arc[m - 1];
    path.kerbA = 0;
    path.kerbB = path.total;
    // Nobody has a lane here to be told about, so these are points for the gate only. The body reports itself on the way over.
    var n = Math.min(ZONE_CAP, Math.max(1, Math.ceil(path.total / T.linkStepM)));
    for (var k = 0; k < n; k++) {
      var a = path.total * (k + 0.5) / n;
      pathPoint(path, a, S.pedsys.pt);
      path.zArc[k] = a;
      path.zX[k] = S.pedsys.pt.x;
      path.zY[k] = S.pedsys.pt.y;
      path.zLane[k] = -1;
      path.zZone[k] = -1;
      path.zClear[k] = 0;
    }
    path.nz = n;
    path.swB = row.id;
    path.sB = toStart ? 0 : row.len;
    path.bx = ex;
    path.by = ey;
    path.endDir = toStart ? 1 : -1;
    path.ambient = false;
    path.clear = true;
    var e = S.world.edges[row.edge];
    connectorsUnder(S, path, S.world.juncs[toStart ? e.a : e.b]);
    cross.start(S, p, path, 1, 'LINK');
  };

  /** @returns {boolean} True when a lane is one of the n held in list. */
  function holds(list, n, lane) {
    for (var i = 0; i < n; i++) {
      if (list[i] === lane) return true;
    }
    return false;
  }

  /** @returns {boolean} True when a vehicle's lane or connector leads onto one of the listed lanes. */
  function leadsOnto(W, v, list, n) {
    if (v.connId >= 0) return holds(list, n, W.conns[v.connId].to);
    var lane = W.lanes[v.laneId];
    if (!lane) return false;
    if (holds(list, n, lane.id)) return true;
    for (var i = 0; i < lane.conns.length; i++) {
      if (holds(list, n, W.conns[lane.conns[i]].to)) return true;
    }
    return false;
  }

  /** Seconds until a vehicle's nose can reach a point, by closing speed. */
  function noseTtc(v, x, y) {
    var c = Math.cos(v.h);
    var s = Math.sin(v.h);
    var sign = v.v < 0 ? -1 : 1;
    var nx = v.x + c * sign * v.length / 2;
    var ny = v.y + s * sign * v.length / 2;
    var dx = x - nx;
    var dy = y - ny;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d < 0.05) return 0;
    var vx = v.vx;
    var vy = v.vy;
    if (vx === 0 && vy === 0) {
      vx = c * v.v;
      vy = s * v.v;
    }
    var closing = (vx * dx + vy * dy) / d;
    return closing > 0.01 ? d / closing : Infinity;
  }

  /**
   * @returns {boolean} True when a moving vehicle is coming to a point. One going away from it, or down another road, is not. On a
   * line with no lanes of its own, at a junction's corner, anything not going away can be turning toward it.
   */
  function coming(W, v, x, y, lanes, n) {
    var T = TLV.tune.peds;
    var c = Math.cos(v.h);
    var s = Math.sin(v.h);
    var dx = x - v.x;
    var dy = y - v.y;
    var a = (dx * c + dy * s) * (v.v < 0 ? -1 : 1);
    var l = dy * c - dx * s;
    if (a < -v.length / 2 - 1) return false;
    if (l <= T.gateLateralM && l >= -T.gateLateralM) return true;
    if (n > 0 && lanes[0] < 0) return true;
    return n > 0 && leadsOnto(W, v, lanes, n);
  }

  /**
   * The fairness gate (GAME_DESIGN 10, ARCHITECTURE 12.6): nobody steps out with the player under 1.5 s from any conflict point, or
   * an AI vehicle within v * v / 16 + 3 m of one. "Within" of a conflict point means a vehicle that can come to it, moving or
   * stopped: on a road a crossing touches, a car going by on the cross street is 8 m away from every walker for its whole green.
   * On a signal's walk phase, a car stopped at its red with its body clear of the line does not count, or nobody could ever use a
   * crossing with a car waiting at it.
   * @param {object} S Sim state.
   * @param {number} n Conflict points, in sys.cpX, sys.cpY.
   * @param {Int32Array|number[]} lanes Lanes crossed.
   * @param {number} nLanes How many.
   * @param {boolean} walkPhase True when this person has the walk signal.
   * @param {number} r Body radius.
   * @returns {boolean} True when they may step out.
   */
  cross.gate = function (S, n, lanes, nLanes, walkPhase, r) {
    var W = S.world;
    var T = TLV.tune.peds;
    var sys = S.pedsys;
    var walk = TLV.peds.walk;
    var cx = 0;
    var cy = 0;
    var i;
    if (n === 0) return true;
    for (i = 0; i < n; i++) {
      cx += sys.cpX[i];
      cy += sys.cpY[i];
    }
    cx /= n;
    cy /= n;
    var spread = 0;
    for (i = 0; i < n; i++) spread = Math.max(spread, TLV.math.dist(cx, cy, sys.cpX[i], sys.cpY[i]));
    var count = walk.vehicles(S, cx, cy, T.gateRangeM + spread, sys.far);
    for (var k = 0; k < count; k++) {
      var v = sys.far[k];
      if (v.id === sys.gateSkip) continue;
      var speed = v.v < 0 ? -v.v : v.v;
      var still = speed < T.stoppedV;
      var player = v.isPlayer && S.player.mode !== 'FOOT';
      var reach = speed * speed / T.gateDecel + T.gateBaseM;
      for (i = 0; i < n; i++) {
        var x = sys.cpX[i];
        var y = sys.cpY[i];
        var d = walk.bodyDist(v, x, y);
        if (d < r + T.bodyClearM) {
          sys.gateWhy = 'body';
          return false;
        }
        if (player) {
          // By true velocity: a car skidding sideways has little forward speed and all of its momentum.
          if (noseTtc(v, x, y) < T.ttcStartS) {
            sys.gateWhy = 'ttc';
            return false;
          }
          continue;
        }
        if (v.isPlayer || d >= reach) continue;
        if (still ? !walkPhase : coming(W, v, x, y, lanes, nLanes)) {
          sys.gateWhy = 'ai';
          return false;
        }
      }
    }
    return true;
  };

  /** Copies a path's conflicts into the gate's list. */
  function pathPoints(sys, path) {
    for (var i = 0; i < path.nz; i++) {
      sys.cpX[i] = path.zX[i];
      sys.cpY[i] = path.zY[i];
    }
    return path.nz;
  }

  /** @returns {boolean} True when this crossing takes someone new: not shut after a long dwell, and with its kerbs free of cars. */
  function pathOpen(S, path, pdir) {
    var sys = S.pedsys;
    if (path.xing >= 0 && S.t < sys.xingHold[path.xing]) return false;
    for (var i = 0; i < path.spots.length; i++) {
      if (TLV.world.parking.state(S, path.spots[i]) !== TLV.const.OCC.FREE) return false;
    }
    var row = pdir > 0 ? path.swB : path.swA;
    if (row >= 0 && path.xing >= 0) {
      return TLV.peds.walk.pointFree(S, TLV.peds.walk.rowInfo(S, row), pdir > 0 ? path.sB : path.sA, 0.5);
    }
    return true;
  }

  /** @returns {boolean} True when this person may step out now. */
  function mayStep(S, p) {
    var P = p._p;
    var sys = S.pedsys;
    var path = P.path;
    if (path) {
      if (!pathOpen(S, path, P.pdir)) return false;
      var walkPhase = path.xing >= 0 && P.plan === 'LEGAL' && TLV.world.signals.pedWalk(S, path.xing);
      return cross.gate(S, pathPoints(sys, path), path.zLane, path.nz, walkPhase, p.r);
    }
    if (P.plan === 'DROP') {
      sys.cpX[0] = p.x;
      sys.cpY[0] = p.y;
      sys.gateSkip = P.home;
      var open = cross.gate(S, 1, sys.ints, 0, false, p.r);
      sys.gateSkip = -1;
      return open;
    }
    // Riding or strolling down a lane: its start, and a point ahead.
    var lane = S.world.lanes[P.laneId];
    if (!lane) return false;
    var at = sys.pt;
    TLV.world.lanes.pointAt(S.world, P.laneId, P.laneS, at);
    sys.cpX[0] = at.x;
    sys.cpY[0] = at.y;
    TLV.world.lanes.pointAt(S.world, P.laneId, P.laneS + P.laneDir * TLV.tune.peds.salmonLeadM, at);
    sys.cpX[1] = at.x;
    sys.cpY[1] = at.y;
    sys.ints[0] = P.laneId;
    return cross.gate(S, 2, sys.ints, 1, false, p.r);
  }

  /** What a person at the kerb wants: 1 to go, 0 to wait, -1 to give up. */
  function plan(S, p) {
    var P = p._p;
    var T = TLV.tune.peds;
    var path = P.path;
    switch (P.plan) {
      case 'LEGAL': {
        var signal = path.xing >= 0 && S.world.xings[path.xing].signal;
        if (!signal) return P.waitT >= T.waitMaxS ? -1 : 1;
        if (TLV.world.signals.pedWalk(S, path.xing)) return 1;
        if (P.redAt >= 0 && P.waitT >= P.redAt) {
          P.plan = 'RED';
          return 1;
        }
        if (P.waitT >= T.waitMaxS) {
          if (S.rng.ped.bool(T.redAfterWaitP)) {
            P.plan = 'RED';
            P.waitT = 0;
            return 1;
          }
          return -1;
        }
        return 0;
      }
      case 'JAY':
        return P.waitT >= T.jayWaitS ? -1 : 1;
      case 'LINK':
        return P.waitT >= T.linkWaitS ? -1 : 1;
      case 'DROP':
        return 1;
      case 'RED':
        return P.waitT >= T.waitMaxS ? -1 : 1;
      default:
        return P.waitT >= T.cmdWaitS ? -1 : 1;
    }
  }

  /** Metres from here to the aim, along the walk. */
  function aimMetres(p) {
    var a = p._p.aim;
    return TLV.math.dist(p.x, p.y, a.x, a.y);
  }

  /** The state a person goes on the road in. */
  function roadState(S, p) {
    var P = p._p;
    var T = TLV.tune.peds;
    switch (P.plan) {
      case 'RED': return 'RED_CROSS';
      case 'JAY': case 'STEP': case 'POP': case 'SALMON': return 'JAYWALK';
      case 'SLOW': return isRider(p) ? 'CROSS_LEGAL' : 'CROSS_SLOW';
      case 'STROLL': return 'STROLL_ROAD';
      case 'DROP': return 'DROPPED';
      default:
        // A rider crosses at rider speed, which is no slow crossing.
        if (isRider(p)) return 'CROSS_LEGAL';
        return p.kind === 'trolley' || S.rng.ped.bool(T.slowP) ? 'CROSS_SLOW' : 'CROSS_LEGAL';
    }
  }

  /** Metres per second across a road. */
  function roadSpeed(p, path) {
    var T = TLV.tune.peds;
    var P = p._p;
    if (isRider(p)) return P.base;
    switch (P.roadState) {
      case 'CROSS_SLOW': {
        var v = P.slowV > 0 ? P.slowV : T.crossSlow;
        return path ? Math.max(v, path.total / T.slowCrossMaxS) : v;
      }
      case 'RED_CROSS': case 'JAYWALK': return T.redCross;
      default: return T.crossLegal;
    }
  }

  /** Leaves the kerb. */
  function stepOut(S, p) {
    var P = p._p;
    var T = TLV.tune.peds;
    var rng = S.rng.ped;
    p.intent = false;
    P.roadState = roadState(S, p);
    TLV.peds.setState(p, P.roadState);
    S.bus.emit('ped.stepOut', { pedId: p.id, state: p.state });
    P.force = false;
    if (P.plan === 'STROLL' || P.plan === 'SALMON') {
      TLV.peds.riders.enterLane(S, p);
      return;
    }
    if (P.plan === 'DROP') {
      P.stage = 'NONE';
      TLV.peds.walk.toSidewalk(S, p);
      return;
    }
    var path = P.path;
    P.stage = 'ROAD';
    P.speed = roadSpeed(p, path);
    // A car may have moved them while they waited. The road starts from where they stand, or the first step would close the gap in one.
    pathPoint(path, P.arc, S.pedsys.pt);
    P.ox = p.x - S.pedsys.pt.x;
    P.oy = p.y - S.pedsys.pt.y;
    if (p.state === 'CROSS_SLOW' && path.nz > 0 && (P.dwellLeft > 0 || rng.bool(0.5))) {
      // Pauses at the lane in the middle of the road.
      var mid = path.zArc[path.nz >> 1];
      P.pauseAt = mid;
      P.pauseT = P.dwellLeft > 0 ? Math.max(0, P.dwellLeft - path.zClear[path.nz >> 1] * 2 / P.speed) : rng.range(1, 3);
    }
  }

  /** Solves the speed that meets an aim, and drops the aim once past it (ARCHITECTURE 13.1). */
  function aimedSpeed(S, p, lo, hi) {
    var P = p._p;
    var a = P.aim;
    if ((a.x - p.x) * P.vx + (a.y - p.y) * P.vy < 0 && p.stateT > 0.5) {
      P.aim = null;
      return P.speed;
    }
    var t = a.tImpact - S.t;
    return TLV.math.clamp(t > 0.05 ? aimMetres(p) / t : hi, lo, hi);
  }

  /** @returns {boolean} True when the zone under a person, or ahead of them, has been held longer than the seconds given. */
  function zoneHeld(S, p, seconds) {
    var P = p._p;
    var path = P.path;
    var sys = S.pedsys;
    for (var k = 0; k < path.nz; k++) {
      if (path.zZone[k] >= 0 && sys.zoneT[path.zZone[k]] >= seconds) return true;
    }
    return false;
  }

  /**
   * The cap on a zone holds only if the last person off it starts in time. That depends on how far they have to go, so it is read
   * from where they stand: claimPath lets a zone go zClear past where the line meets it.
   * @returns {boolean} True when clearing a held zone, at hurry speed, would take it to the cap.
   */
  function zoneDue(S, p) {
    var P = p._p;
    var T = TLV.tune.peds;
    var path = P.path;
    var sys = S.pedsys;
    for (var k = 0; k < path.nz; k++) {
      var zone = path.zZone[k];
      if (zone < 0 || sys.zoneT[zone] <= 0) continue;
      var left = (path.zArc[k] - P.arc) * P.pdir + path.zClear[k];
      if (left > 0 && sys.zoneT[zone] + left / T.hurry + T.dwellSpareS >= T.dwellMaxS) return true;
    }
    return false;
  }

  /** One think on the road. */
  function stepRoad(S, p, dt) {
    var P = p._p;
    var T = TLV.tune.peds;
    var sys = S.pedsys;
    var walk = TLV.peds.walk;
    var path = P.path;
    if (!P.hopped && !P.hold && P.job === 'AMBIENT' && sys.ttc < T.hopTtcS) {
      P.hopped = true;
      P.pdir = -P.pdir;
      P.pauseT = 0;
      P.pauseAt = -1;
      P.speed = isRider(p) ? P.base : T.hop;
    }
    var due = zoneDue(S, p);
    if (!P.hurry && (due || zoneHeld(S, p, T.dwellHurryS))) {
      P.hurry = true;
      P.pauseT = 0;
      P.pauseAt = -1;
    }
    if (!P.force && (due || zoneHeld(S, p, T.dwellForceS))) P.force = true;
    if (P.pauseT > 0 && P.pauseAt >= 0 && (P.arc - P.pauseAt) * P.pdir >= 0) {
      P.pauseT -= dt;
      if (P.pauseT <= 0) P.pauseAt = -1;
      walk.halt(p);
      return;
    }
    var speed = P.speed;
    if (P.aim) {
      var rider = isRider(p);
      speed = aimedSpeed(S, p, rider ? T.aimMinRider : T.aimMinWalker, rider ? P.base : T.aimMaxWalker);
    }
    if (P.hurry && speed < T.hurry) speed = T.hurry;
    var step = speed * dt;
    var a = P.arc + P.pdir * step;
    var end = P.pdir > 0 ? path.kerbB : path.kerbA;
    if ((a - end) * P.pdir >= 0) {
      finishRoad(S, p);
      walk.stepFree(S, p, dt);
      return;
    }
    var pt = sys.pt;
    pathPoint(path, a, pt);
    var nx = pt.x + P.ox;
    var ny = pt.y + P.oy;
    var out = sys.pt2;
    if (sys.nearN > 0 && walk.steer(S, p, p.x, p.y, nx, ny, step, out)) {
      // Kept off a car: their place on the line waits, and the way round goes in the offset, so they carry on from there.
      pathPoint(path, P.arc, pt);
      P.ox = out.x - pt.x;
      P.oy = out.y - pt.y;
      walk.aimAt(p, out.x, out.y, dt);
      return;
    }
    P.arc = a;
    var off = Math.sqrt(P.ox * P.ox + P.oy * P.oy);
    if (off > 0) {
      var keep = off > step * 0.5 ? (off - step * 0.5) / off : 0;
      P.ox *= keep;
      P.oy *= keep;
    }
    walk.aimAt(p, nx, ny, dt);
  }

  /** @returns {boolean} True when the car a passenger got out of is no longer beside them. */
  function homeGone(S, p) {
    var P = p._p;
    var car = TLV.traffic && TLV.traffic.byId ? TLV.traffic.byId(S, P.home) : null;
    return !car || !car.active || TLV.math.dist(car.x, car.y, P.homeX, P.homeY) > TLV.tune.peds.homeLeftM;
  }

  /** One think at the kerb. */
  function stepWait(S, p, dt) {
    var P = p._p;
    var T = TLV.tune.peds;
    var walk = TLV.peds.walk;
    walk.halt(p);
    P.waitT += dt;
    if (P.plan === 'DROP' && homeGone(S, p)) {
      // The car has driven off and left them standing in the road. There is nothing to wait in, so they go.
      stepOut(S, p);
      return;
    }
    if (P.stage === 'WAIT') {
      var want = plan(S, p);
      if (want < 0) {
        if (!P.median) {
          cross.abandon(S, p);
          return;
        }
        // On a median there is nowhere to give up to.
        P.waitT = 0;
        want = 0;
      }
      P.gateT -= dt;
      if (want > 0 && P.gateT <= 0) {
        P.gateT = T.gatePeriodS;
        if (mayStep(S, p)) {
          P.stage = 'INTENT';
          P.intentTick = S.tick;
          p.intent = true;
          S.bus.emit('ped.intent', { pedId: p.id });
        }
      }
      return;
    }
    // INTENT: at least intentS by the tick count, so no rounding can shorten it.
    var ticks = Math.ceil(T.intentS * TLV.const.TICK_HZ - 1e-9);
    if (S.tick - P.intentTick < ticks) return;
    var path = P.path;
    if (P.aim && path && (S.tick - P.intentTick) * TLV.const.DT < T.aimHoldMaxS) {
      // A staged walker leaves the kerb when their usual pace meets the aim.
      if (P.aim.tImpact - S.t > aimMetres(p) / T.crossLegal) return;
    }
    if (plan(S, p) > 0 && mayStep(S, p)) {
      stepOut(S, p);
      return;
    }
    p.intent = false;
    P.stage = 'WAIT';
    P.gateT = T.gatePeriodS;
  }

  /**
   * One think of a person with a crossing in hand, at the kerb or on the road.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {number} dt Seconds to the next think.
   */
  cross.stepPath = function (S, p, dt) {
    if (p._p.stage === 'ROAD') stepRoad(S, p, dt);
    else stepWait(S, p, dt);
  };

  /**
   * Reports a person on every lane of their line they have yet to clear, from the moment they leave the kerb. A car must stop for
   * someone coming to its lane, not only for someone standing in it, and a lane they have cleared is free again: that is what lets
   * a car go behind them.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   */
  cross.claimPath = function (S, p) {
    var P = p._p;
    var path = P.path;
    var peds = TLV.peds;
    for (var k = 0; k < path.nz; k++) {
      var past = (P.arc - path.zArc[k]) * P.pdir;
      if (path.zLane[k] < 0 || past > path.zClear[k]) continue;
      peds.addClaim(S, p.slot, path.zLane[k], path.zS[k], path.zHalf[k], 0, path.zZone[k], true);
    }
    var half = p.r + TLV.tune.peds.laneHalfM;
    for (var n = 0; n < path.nc; n++) {
      if (P.arc < path.cA0[n] || P.arc > path.cA1[n]) continue;
      var c = S.world.conns[path.cId[n]];
      peds.addClaim(S, p.slot, c.from, S.world.lanes[c.from].len + path.cU[n], half, 0, -1, true);
      peds.addClaim(S, p.slot, c.to, path.cU[n] - c.len, half, 0, -1, true);
    }
  };

  /**
   * @returns {boolean} True when someone is close enough to the player to go out on a road. Traffic spawns from 140 m out, on any lane
   * nobody can see, and nothing tells it who is there.
   */
  function nearEnough(S, p) {
    var dx = p.x - S.player.fx;
    var dy = p.y - S.player.fy;
    var T = TLV.tune.peds;
    return dx * dx + dy * dy < T.roadOutM * T.roadOutM;
  }

  /**
   * Whether a walker on a row takes a crossing it passes, or strikes out across the road.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {object} info Row info.
   * @param {number} from Metres along the row, before this step.
   * @param {number} to Metres along the row, after it.
   * @returns {boolean} True when they have left the row for it.
   */
  cross.consider = function (S, p, info, from, to) {
    var P = p._p;
    var T = TLV.tune.peds;
    if (P.crossCool > 0 || !nearEnough(S, p)) return false;
    var lo = from < to ? from : to;
    var hi = from < to ? to : from;
    for (var k = 0; k < info.xs.length; k++) {
      var s = info.xs[k];
      if (s < lo || s >= hi) continue;
      var rider = isRider(p);
      if (S.rng.ped.next() >= (rider ? T.popP : T.crossP)) {
        P.crossCool = T.gatePeriodS * 4;
        return false;
      }
      var path = cross.pathOf(S, info.xi[k]);
      if (!path || !cross.walkable(S, path)) return false;
      if (path.swA !== P.sw && path.swB !== P.sw) return false;
      cross.start(S, p, path, path.swA === P.sw ? 1 : -1, rider ? 'POP' : 'LEGAL');
      return true;
    }
    return false;
  };

  /** Fills sys.it with one conflict for each lane of an edge, at a place along it. */
  function edgeConflicts(S, e, arc) {
    var W = S.world;
    var T = TLV.tune.peds;
    var sys = S.pedsys;
    var math = TLV.math;
    var it = sys.it;
    var pr = sys.pr;
    var at = sys.pt;
    var cx = 0;
    var cy = 0;
    math.polyAt(e.px, e.py, e.cum, arc, at);
    cx = at.x;
    cy = at.y;
    var n = 0;
    for (var dir = 0; dir < 2; dir++) {
      var d = W.dirEdges[e.id * 2 + dir];
      if (!d) continue;
      for (var l = 0; l < d.lanes.length; l++) {
        if (n >= ZONE_CAP) return 0;
        var lane = W.lanes[d.lanes[l]];
        math.polyProject(lane.px, lane.py, lane.cum, cx, cy, -1, pr);
        if (pr.s < T.jayXingM || pr.s > lane.len - T.jayXingM) return 0;
        var s = pr.s;
        TLV.world.lanes.pointAt(W, lane.id, s, at);
        it.x[n] = at.x;
        it.y[n] = at.y;
        math.polyProject(e.px, e.py, e.cum, at.x, at.y, arc, pr);
        it.arc[n] = pr.s;
        it.lat[n] = pr.side * pr.d;
        it.s[n] = s;
        it.half[n] = T.walkerR + T.laneHalfM;
        it.clear[n] = lane.width / 2 + T.walkerR + T.laneReachM;
        it.lane[n] = lane.id;
        it.zone[n] = zoneAt(lane, s, W);
        n++;
      }
    }
    return n;
  }

  /** @returns {number} The zone holding a place on a lane, or -1. */
  function zoneAt(lane, s, W) {
    for (var i = 0; i < lane.zones.length; i++) {
      var z = W.zones[lane.zones[i]];
      if (s >= z.s0 && s <= z.s1) return z.id;
    }
    return -1;
  }
  cross.zoneAt = zoneAt;

  /**
   * A walker near a road decides to leave the sidewalk mid-block, at a gap between the parked cars on both kerbs.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @returns {boolean} True when they have set off.
   */
  cross.tryJaywalk = function (S, p) {
    var W = S.world;
    var T = TLV.tune.peds;
    var P = p._p;
    var walk = TLV.peds.walk;
    var sys = S.pedsys;
    var math = TLV.math;
    var sw = W.sidewalks[P.sw];
    var e = W.edges[sw.edge];
    var info = walk.rowInfo(S, P.sw);
    if (!nearEnough(S, p) || !info.road || P.s < T.jayEndM || P.s > sw.len - T.jayEndM) return false;
    for (var k = 0; k < info.xs.length; k++) {
      if (Math.abs(info.xs[k] - P.s) < T.jayXingM) return false;
    }
    var pr = sys.pr;
    math.polyProject(e.px, e.py, e.cum, p.x, p.y, -1, pr);
    var base = pr.s;
    var path = ownPath(P);
    for (var i = 0; i < T.jayShifts.length; i++) {
      var arc = base + T.jayShifts[i];
      if (arc < T.jayXingM || arc > e.len - T.jayXingM) continue;
      var n = edgeConflicts(S, e, arc);
      if (n === 0) continue;
      layout(S, path, e, n);
      // Side A is the row's own side when the row is on the left of the edge.
      var far = sw.side === 0 ? 1 : 0;
      var kx = path.x[far === 1 ? path.n - 1 : 0];
      var ky = path.y[far === 1 ? path.n - 1 : 0];
      if (!land(S, path, e, far, -1, kx, ky)) continue;
      if (!land(S, path, e, sw.side, P.sw, path.x[sw.side === 0 ? 0 : path.n - 1], path.y[sw.side === 0 ? 0 : path.n - 1])) continue;
      if (!walk.legClear(S, path.ax, path.ay, path.x[1], path.y[1], p.r)) continue;
      if (!walk.legClear(S, path.bx, path.by, path.x[path.n - 2], path.y[path.n - 2], p.r)) continue;
      if (TLV.world.spatial.rayBlocked(W, path.ax, path.ay, path.bx, path.by)) continue;
      var pdir = sw.side === 0 ? 1 : -1;
      cross.start(S, p, path, pdir, 'JAY');
      return true;
    }
    return false;
  };

  /**
   * A walker on a quiet road steps off and strolls down it.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @returns {boolean} True when they have set off.
   */
  cross.tryStroll = function (S, p) {
    var W = S.world;
    var T = TLV.tune.peds;
    var P = p._p;
    var sys = S.pedsys;
    var at = sys.lanePt;
    var near = TLV.world.lanes.project(W, p.x, p.y, null, 9, at);
    if (!near) return false;
    var lane = W.lanes[near.laneId];
    var e = W.edges[W.sidewalks[P.sw].edge];
    if (lane.edge !== e.id) return false;
    var pt = sys.pt;
    TLV.world.lanes.pointAt(W, lane.id, near.s, pt);
    var same = Math.cos(pt.h - p.h) >= 0 ? 1 : -1;
    var room = same > 0 ? lane.len - near.s : near.s;
    var run = S.rng.ped.range(T.strollMinM, T.strollMaxM);
    if (room < run + 3) return false;
    var edge = (near.lat >= 0 ? 1 : -1) * (lane.width / 2 - T.strollEdgeM);
    P.path = null;
    P.plan = 'STROLL';
    P.laneId = lane.id;
    P.laneS = near.s;
    P.laneDir = same;
    P.laneLat = edge;
    P.laneLatGoal = edge;
    P.laneLeft = run;
    P.laneT = 0;
    P.aside = false;
    P.stage = 'WAIT';
    P.mode = 'PATH';
    P.waitT = 0;
    P.gateT = 0;
    TLV.peds.setState(p, 'WAIT_CROSS');
    return true;
  };

  /**
   * A passenger getting out on the traffic side. Overtakers pass 0.6 m from a stopped car, so they stay in the door, hard by the body,
   * and step out like anyone else: with intent, and into a gap. With no car found, they just go.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian, at the door.
   */
  cross.startDropped = function (S, p) {
    var P = p._p;
    var T = TLV.tune.peds;
    var walk = TLV.peds.walk;
    var sys = S.pedsys;
    var car = null;
    var best = T.scanWalkM;
    var n = walk.vehicles(S, p.x, p.y, T.scanWalkM, sys.far);
    for (var i = 0; i < n; i++) {
      var v = sys.far[i];
      if (v.isPlayer || (v.v < 0 ? -v.v : v.v) >= T.doorV) continue;
      var d = walk.bodyDist(v, p.x, p.y);
      if (d < best) {
        best = d;
        car = v;
      }
    }
    if (!car) {
      walk.toSidewalk(S, p);
      return;
    }
    var c = Math.cos(car.h);
    var s = Math.sin(car.h);
    var dx = p.x - car.x;
    var dy = p.y - car.y;
    var a = dx * c + dy * s;
    var l = dy * c - dx * s;
    l = (l >= 0 ? 1 : -1) * (car.width / 2 + T.doorHugM);
    p.x = car.x + a * c - l * s;
    p.y = car.y + a * s + l * c;
    P.home = car.id;
    P.homeX = car.x;
    P.homeY = car.y;
    P.path = null;
    P.plan = 'DROP';
    P.mode = 'PATH';
    P.stage = 'WAIT';
    P.waitT = 0;
    P.gateT = 0;
  };

  /**
   * Called when a free walk reaches a lane.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   */
  cross.atLane = function (S, p) {
    var P = p._p;
    P.mode = 'LANE';
    if (P.plan === 'STROLL') P.speed = TLV.tune.peds.strollSpeed;
  };

  /** Readies a person for a command. They may be anything but an attacker. */
  function takeCommand(S, p, cmd) {
    var P = p._p;
    p.intent = false;
    P.stage = 'NONE';
    P.job = 'CMD';
    P.aim = cmd.aim || null;
    P.hold = !!cmd.aim;
    P.dwellLeft = 0;
    P.slowV = 0;
    P.recycle = false;
    P.force = false;
  }

  /** Starts a commanded crossing from the nearer kerb. */
  function commandCrossing(S, p, cmd, plan) {
    var path = cross.pathOf(S, cmd.xingId);
    if (!path) return false;
    var T = TLV.tune.peds;
    var math = TLV.math;
    var dA = math.dist(p.x, p.y, path.x[0], path.y[0]);
    var dB = math.dist(p.x, p.y, path.x[path.n - 1], path.y[path.n - 1]);
    var pdir = dA <= dB ? 1 : -1;
    if (Math.min(dA, dB) > T.commandReachM) return false;
    takeCommand(S, p, cmd);
    if (plan === 'SLOW') {
      p._p.dwellLeft = cmd.dwellS > 0 ? Math.min(cmd.dwellS, T.dwellGateS) : 0;
      p._p.slowV = cmd.speed > 0 ? cmd.speed : 0;
      if (cmd.kind === 'trolley') p.kind = 'trolley';
    }
    cross.start(S, p, path, pdir, plan);
    return true;
  }

  /** Builds a person's own path along a straight line, finding the lanes it crosses. */
  function commandLine(S, path, x, y, toX, toY) {
    var W = S.world;
    var T = TLV.tune.peds;
    var sys = S.pedsys;
    var math = TLV.math;
    var d = math.dist(x, y, toX, toY);
    if (!(d >= 1) || d > T.pathMaxM) return false;
    var it = sys.it;
    var pr = sys.pr;
    var n = 0;
    var steps = Math.ceil(d);
    for (var i = 0; i <= steps; i++) {
      var px = x + (toX - x) * i / steps;
      var py = y + (toY - y) * i / steps;
      var c = TLV.world.lanes.lanesNear(W, px, py, 3, sys.ints);
      for (var k = 0; k < c; k++) {
        var lane = W.lanes[sys.ints[k]];
        math.polyProject(lane.px, lane.py, lane.cum, px, py, -1, pr);
        if (pr.d > lane.width / 2) continue;
        var seen = -1;
        for (var q = 0; q < n; q++) {
          if (it.lane[q] === lane.id) seen = q;
        }
        if (seen < 0) {
          if (n >= ZONE_CAP) break;
          seen = n++;
          it.lat[seen] = Infinity;
          it.lane[seen] = lane.id;
        }
        if (pr.d < it.lat[seen]) {
          it.lat[seen] = pr.d;
          it.arc[seen] = d * i / steps;
          it.x[seen] = px;
          it.y[seen] = py;
          it.s[seen] = pr.s;
          it.half[seen] = T.walkerR + T.laneHalfM;
          it.clear[seen] = lane.width / 2 + T.walkerR + T.laneReachM;
          it.zone[seen] = zoneAt(lane, pr.s, W);
        }
      }
    }
    // In order along the walk.
    var order = sys.order;
    for (var a = 0; a < n; a++) {
      var b = a;
      for (; b > 0 && it.arc[order[b - 1]] > it.arc[a]; b--) order[b] = order[b - 1];
      order[b] = a;
    }
    path.x[0] = x;
    path.y[0] = y;
    var m = 1;
    for (var w = 0; w < n; w++) {
      var z = order[w];
      path.x[m] = it.x[z];
      path.y[m++] = it.y[z];
      path.zArc[w] = it.arc[z];
      path.zX[w] = it.x[z];
      path.zY[w] = it.y[z];
      path.zS[w] = it.s[z];
      path.zHalf[w] = it.half[z];
      path.zClear[w] = it.clear[z];
      path.zLane[w] = it.lane[z];
      path.zZone[w] = it.zone[z];
    }
    path.x[m] = toX;
    path.y[m++] = toY;
    path.n = m;
    path.nz = n;
    path.arc[0] = 0;
    for (var v = 1; v < m; v++) path.arc[v] = path.arc[v - 1] + math.dist(path.x[v - 1], path.y[v - 1], path.x[v], path.y[v]);
    path.total = path.arc[m - 1];
    path.kerbA = 0;
    path.kerbB = path.total;
    path.ambient = false;
    return true;
  }

  /**
   * Carries out the crossing commands of ARCHITECTURE 13.2.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {object} cmd Command.
   * @returns {boolean} False when the person cannot comply.
   */
  cross.command = function (S, p, cmd) {
    switch (cmd.type) {
      case 'ZEBRA_STEP': return commandCrossing(S, p, cmd, 'STEP');
      case 'SLOW_CROSS': return commandCrossing(S, p, cmd, 'SLOW');
      case 'RED_CROSS': return commandCrossing(S, p, cmd, 'RED');
      case 'JAYWALK': {
        var T = TLV.tune.peds;
        if (TLV.math.dist(p.x, p.y, cmd.x, cmd.y) > T.commandReachM) return false;
        var path = ownPath(p._p);
        if (!commandLine(S, path, cmd.x, cmd.y, cmd.toX, cmd.toY)) return false;
        takeCommand(S, p, cmd);
        p._p.path = path;
        p._p.pdir = 1;
        p._p.plan = 'STEP';
        p._p.hopped = false;
        p._p.hurry = false;
        p._p.pauseT = 0;
        p._p.pauseAt = -1;
        p._p.speed = TLV.tune.peds.approach;
        TLV.peds.walk.goTo(p, cmd.x, cmd.y, 'KERB');
        return true;
      }
      default:
        return false;
    }
  };

  /**
   * CANCEL for someone crossing: off the road by the nearer kerb, or back to walking from the kerb.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   */
  cross.cancel = function (S, p) {
    var P = p._p;
    if (P.stage === 'ROAD' && P.path) {
      P.hold = false;
      P.aim = null;
      P.job = 'AMBIENT';
      P.pauseT = 0;
      P.pauseAt = -1;
      if (P.arc < P.path.total / 2) {
        P.pdir = -1;
        P.hopped = true;
      } else {
        P.pdir = 1;
      }
      return;
    }
    cross.abandon(S, p);
  };
})(window.TLV);
