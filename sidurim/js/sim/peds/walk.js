// js/sim/peds/walk.js — WP-PEDS
// Sidewalk walking. A row is read once, lazily, into what a walker needs: where its crossings land, which stretches a person
// cannot pass, and which of its links can really be walked. World keeps ribbons out of walls and off lanes as far as the graph
// allows, and tells us what is left: some ribbons stand in a wall, some in the line of parked cars, and some corner links cut
// through a building. Those are walked around here, or turned back from.
(function (TLV) {
  'use strict';

  var walk = TLV.ns('peds.walk');

  var NO_SPANS = new Float32Array(0);
  var NO_SPOTS = new Int32Array(0);
  var NO_XINGS = new Int32Array(0);

  /** A person this close to a lane's end is on that lane's end, not past it. */
  var LANE_END_EPS = 0.01;

  /** @returns {boolean} True when the point is inside a footprint that has a collider. */
  function inSolid(W, x, y) {
    var b = TLV.world.spatial.pointInBuilding(W, x, y);
    return b >= 0 && !(W.blds[b].flags & 1);
  }

  /** @returns {boolean} True when a point falls inside a vehicle-shaped box grown by pad. */
  function inBox(x, y, box, pad) {
    var dx = x - box.x;
    var dy = y - box.y;
    var c = Math.cos(box.h);
    var s = Math.sin(box.h);
    var a = dx * c + dy * s;
    var l = dy * c - dx * s;
    var ha = box.length / 2 + pad;
    var hw = box.width / 2 + pad;
    return a > -ha && a < ha && l > -hw && l < hw;
  }

  /** Appends a run of blocked samples as a span, merging it with the last one if they touch and share a cause. */
  function addSpan(spans, s0, s1, spot) {
    var n = spans.length;
    if (n >= 3 && spans[n - 1] === spot && s0 <= spans[n - 2] + 0.01) {
      if (s1 > spans[n - 2]) spans[n - 2] = s1;
      return;
    }
    spans.push(s0, s1, spot);
  }

  /** @returns {boolean} True when a point stands on a lane. The surface raster rules out nearly every point at no cost. */
  function onAnyLane(S, x, y) {
    var W = S.world;
    if (TLV.world.surface.at(W, x, y) !== TLV.const.SURF.ROAD) return false;
    var sys = S.pedsys;
    var math = TLV.math;
    var pr = sys.prB;
    var c = TLV.world.lanes.lanesNear(W, x, y, 3, sys.ints);
    for (var k = 0; k < c; k++) {
      var l = W.lanes[sys.ints[k]];
      math.polyProject(l.px, l.py, l.cum, x, y, -1, pr);
      if (pr.d < l.width / 2 && pr.s > LANE_END_EPS && pr.s < l.len - LANE_END_EPS) return true;
    }
    return false;
  }

  /**
   * @returns {Float32Array} x, y of every place a lane doubles back at a single vertex. OSM has a few, such as the hairpin at (230, 768),
   * and a car there turns end for end in one tick, too fast for anyone to step aside.
   */
  function kinks(S) {
    var sys = S.pedsys;
    if (sys.kinks) return sys.kinks;
    var W = S.world;
    var T = TLV.tune.peds;
    var math = TLV.math;
    var list = [];
    for (var l = 0; l < W.lanes.length; l++) {
      var lane = W.lanes[l];
      for (var i = 1; i + 1 < lane.px.length; i++) {
        var a = Math.atan2(lane.py[i] - lane.py[i - 1], lane.px[i] - lane.px[i - 1]);
        var b = Math.atan2(lane.py[i + 1] - lane.py[i], lane.px[i + 1] - lane.px[i]);
        if (Math.abs(math.wrapPi(b - a)) > T.kinkRad) list.push(lane.px[i], lane.py[i]);
      }
    }
    sys.kinks = Float32Array.from(list);
    return sys.kinks;
  }

  /** @returns {boolean} True when a point stands where a car doubling back swings its body. */
  function nearKink(list, x, y, reach) {
    for (var i = 0; i < list.length; i += 2) {
      var dx = list[i] - x;
      var dy = list[i + 1] - y;
      if (dx * dx + dy * dy < reach * reach) return true;
    }
    return false;
  }

  /**
   * Reads a row against walls and its own road, at one metre, and finds the stretch of it that stands on the parking strip. Only a
   * ribbon moved off a wall gets there, so most rows stop here.
   * @returns {?number[]} First and last metre on the strip, or null.
   */
  function readWalls(S, sw, e, spans) {
    var W = S.world;
    var T = TLV.tune.peds;
    var math = TLV.math;
    var at = S.pedsys.pt;
    var pr = S.pedsys.pr;
    var kerb = sw.side === 0 ? e.kerbOffL : e.kerbOffR;
    var strip = sw.side === 0 ? e.parkL : e.parkR;
    var n = Math.max(1, Math.ceil(sw.len / T.rowStepM));
    var step = sw.len / n;
    var lo = -1;
    var hi = -1;
    var hint = -1;
    var runStart = -1;
    var bends = kinks(S);
    for (var i = 0; i <= n + 1; i++) {
      var blocked = false;
      if (i <= n) {
        math.polyAt(sw.px, sw.py, sw.cum, step * i, at);
        math.polyProject(e.px, e.py, e.cum, at.x, at.y, hint, pr);
        hint = pr.s;
        if (strip > 0 && pr.d < kerb + T.walkerR) {
          if (lo < 0) lo = step * i;
          hi = step * i;
        }
        // A ribbon on a lane, its own or another road's, has a person in traffic with no car told of it.
        blocked = inSolid(W, at.x, at.y) || pr.d < kerb - strip || onAnyLane(S, at.x, at.y) || nearKink(bends, at.x, at.y, T.uTurnSweepM);
      }
      if (blocked && runStart < 0) runStart = i;
      if (!blocked && runStart >= 0) {
        addSpan(spans, Math.max(0, (runStart - 0.5) * step), Math.min(sw.len, (i - 0.5) * step), -1);
        runStart = -1;
      }
    }
    return lo >= 0 ? [lo, hi] : null;
  }

  /**
   * Marks the stretches a stall's car would stand on, between two metres of a row. Whether they block depends on the stall, and is
   * read as walkers arrive.
   */
  function readStalls(S, sw, from, to, spans) {
    var W = S.world;
    var T = TLV.tune.peds;
    var sys = S.pedsys;
    var math = TLV.math;
    var parking = TLV.world.parking;
    var at = sys.pt;
    var pr = sys.pr;
    var ids = sys.spots;
    var box = sys.box;
    var pad = T.walkerR - T.stallClearM;
    var reach = T.stallQueryM;
    var seen = [];
    var found = [];
    var stop = Math.max(from + 1, to);
    for (var q = from; q < stop + reach; q += reach) {
      math.polyAt(sw.px, sw.py, sw.cum, q, at);
      var count = parking.spotsNear(W, at.x, at.y, reach, ids);
      for (var k = 0; k < count; k++) {
        var id = ids[k];
        if (seen.indexOf(id) >= 0) continue;
        seen.push(id);
        parking.boxOf(W, id, TLV.const.OCC.PARKED, box);
        math.polyProject(sw.px, sw.py, sw.cum, box.x, box.y, -1, pr);
        if (pr.d > box.length) continue;
        var mid = pr.s;
        var first = -1;
        var last = -1;
        for (var s = Math.max(0, mid - box.length); s <= Math.min(sw.len, mid + box.length); s += 0.5) {
          math.polyAt(sw.px, sw.py, sw.cum, s, at);
          if (!inBox(at.x, at.y, box, pad)) continue;
          if (first < 0) first = s;
          last = s;
        }
        if (first >= 0) found.push(Math.max(0, first - 0.5), Math.min(sw.len, last + 0.5), id);
      }
    }
    for (var j = 0; j < found.length; j += 3) spans.push(found[j], found[j + 1], found[j + 2]);
  }

  /**
   * @param {object} S Sim state.
   * @param {number} ax Start x.
   * @param {number} ay Start y.
   * @param {number} bx End x.
   * @param {number} by End y.
   * @param {number} [pad] Metres past the lane's edge that count as on it. A car's body and its mirrors reach past the line it follows.
   * @returns {boolean} True when a straight walk between two points stands on a lane of any road.
   */
  walk.onLanes = function (S, ax, ay, bx, by, pad) {
    var W = S.world;
    var math = TLV.math;
    var sys = S.pedsys;
    var pr = sys.pr;
    var d = math.dist(ax, ay, bx, by);
    var n = Math.max(1, Math.ceil(d));
    for (var i = 0; i <= n; i++) {
      var x = ax + (bx - ax) * i / n;
      var y = ay + (by - ay) * i / n;
      var c = TLV.world.lanes.lanesNear(W, x, y, 3, sys.ints);
      for (var k = 0; k < c; k++) {
        var l = W.lanes[sys.ints[k]];
        math.polyProject(l.px, l.py, l.cum, x, y, -1, pr);
        if (pr.d < l.width / 2 + (pad || 0) && pr.s > LANE_END_EPS && pr.s < l.len - LANE_END_EPS) return true;
      }
    }
    return false;
  };

  /**
   * @returns {boolean} True when a point stands where a vehicle going through a junction reaches: beside a connector, or anywhere
   * around a U-turn, where a short connector turns a car end for end and its body swings round like a bar.
   */
  function inSweep(S, J, x, y, reach) {
    var W = S.world;
    var T = TLV.tune.peds;
    var math = TLV.math;
    var pr = S.pedsys.prB;
    for (var k = 0; k < J.conns.length; k++) {
      var c = W.conns[J.conns[k]];
      math.polyProject(c.px, c.py, c.cum, x, y, -1, pr);
      if (pr.d < (c.turn === 'U' ? T.uTurnSweepM : reach)) return true;
    }
    return false;
  }
  walk.inSweep = inSweep;

  /** @returns {boolean} True when a straight walk comes within a vehicle's body of a junction's connectors. */
  function onConnectors(S, J, ax, ay, bx, by) {
    var T = TLV.tune.peds;
    var math = TLV.math;
    var d = math.dist(ax, ay, bx, by);
    var n = Math.max(1, Math.ceil(d));
    for (var i = 0; i <= n; i++) {
      if (inSweep(S, J, ax + (bx - ax) * i / n, ay + (by - ay) * i / n, T.linkConnM)) return true;
    }
    return false;
  }

  /** @returns {number} Metres back from a row's end to where someone can stand without being in the way of a turning car. */
  function standOff(S, sw, atEnd, J) {
    var T = TLV.tune.peds;
    var at = S.pedsys.pt;
    var most = Math.min(T.linkBackM, sw.len * 0.45);
    for (var d = 0; d < most; d += 1) {
      TLV.math.polyAt(sw.px, sw.py, sw.cum, atEnd ? sw.len - d : d, at);
      if (!inSweep(S, J, at.x, at.y, T.waitClearM)) return d;
    }
    return most;
  }

  /** @returns {boolean} True when a walk between two points is out in a road: on a lane, or where a turning car goes. */
  function inTraffic(S, J, ax, ay, bx, by) {
    return walk.onLanes(S, ax, ay, bx, by, TLV.tune.peds.linkLanePadM) || onConnectors(S, J, ax, ay, bx, by);
  }

  /**
   * Reads one link. A link has no shape of its own, so a walker goes straight between two ends, and at a corner where a building
   * stands at the kerb that line runs through the building. Then the walk goes by a kerb corner of the junction. With no such way,
   * it stays shut.
   * A link can also be a crossing in all but name: one in twenty-five stands in a right turn's path, most of them over the mouth of a
   * side road with no sidewalk of its own. Those are marked, and walked as a crossing, or nobody driving would know of the walker.
   */
  function readLink(S, info, sw, l) {
    var W = S.world;
    var T = TLV.tune.peds;
    var math = TLV.math;
    var spatial = TLV.world.spatial;
    var link = sw.links[l];
    var other = W.sidewalks[link.sw];
    var ai = link.atEnd ? sw.px.length - 1 : 0;
    var bi = link.toStart ? 0 : other.px.length - 1;
    var ax = sw.px[ai];
    var ay = sw.py[ai];
    var bx = other.px[bi];
    var by = other.py[bi];
    var e = W.edges[sw.edge];
    var J = W.juncs[link.atEnd ? e.b : e.a];
    if (!spatial.rayBlocked(W, ax, ay, bx, by)) {
      info.linkOk[l] = 1;
      info.linkRoad[l] = inTraffic(S, J, ax, ay, bx, by) ? 1 : 0;
      return;
    }
    var poly = J.poly;
    var limit = math.dist(ax, ay, bx, by) + T.linkDetourM;
    var best = -1;
    var bestD = limit;
    for (var i = 0; poly && i + 1 < poly.length; i += 2) {
      var d = math.dist(ax, ay, poly[i], poly[i + 1]) + math.dist(poly[i], poly[i + 1], bx, by);
      if (d >= bestD) continue;
      if (spatial.rayBlocked(W, ax, ay, poly[i], poly[i + 1]) || spatial.rayBlocked(W, poly[i], poly[i + 1], bx, by)) continue;
      best = i;
      bestD = d;
    }
    if (best < 0) return;
    info.linkOk[l] = 1;
    info.linkVia[l] = 1;
    info.linkX[l] = poly[best];
    info.linkY[l] = poly[best + 1];
    info.linkRoad[l] = inTraffic(S, J, ax, ay, poly[best], poly[best + 1]) || inTraffic(S, J, poly[best], poly[best + 1], bx, by) ? 1 : 0;
  }

  /**
   * Reads roughly where crossings meet a row, in order along it. A crossing's line is laid out only when someone gets there.
   */
  function readCrossings(S, sw, info) {
    var list = sw.xings;
    if (!list || !list.length) return;
    var W = S.world;
    var pr = S.pedsys.pr;
    var sAt = [];
    var ids = [];
    for (var i = 0; i < list.length; i++) {
      var x = W.xings[list[i]];
      TLV.math.polyProject(sw.px, sw.py, sw.cum, x.x, x.y, -1, pr);
      var k = sAt.length;
      sAt.push(pr.s);
      ids.push(list[i]);
      for (; k > 0 && sAt[k - 1] > pr.s; k--) {
        sAt[k] = sAt[k - 1];
        ids[k] = ids[k - 1];
        sAt[k - 1] = pr.s;
        ids[k - 1] = list[i];
      }
    }
    info.xs = Float32Array.from(sAt);
    info.xi = Int32Array.from(ids);
  }

  /** Reads a row into its info block. */
  function buildRow(S, id) {
    var W = S.world;
    var sw = W.sidewalks[id];
    var e = W.edges[sw.edge];
    var nLinks = sw.links.length;
    var info = {
      id: id,
      nSpans: 0, spanS0: NO_SPANS, spanS1: NO_SPANS, spanSpot: NO_SPOTS,
      xs: NO_SPANS, xi: NO_XINGS,
      linkOk: new Uint8Array(nLinks), linkVia: new Uint8Array(nLinks), linkRoad: new Uint8Array(nLinks),
      linkX: new Float32Array(nLinks), linkY: new Float32Array(nLinks),
      /** A row's walk ends here. It stops short of an end where the way on is a road. */
      endLo: 0, endHi: sw.len,
      /** True for a row standing on its parking strip somewhere: walkers there keep to its line. */
      tight: false,
      /** Set once road geometry has been read: a row's links are read only when someone reaches an end. */
      linksRead: false,
      road: e.lanesF + e.lanesB > 0
    };
    var spans = [];
    var strip = readWalls(S, sw, e, spans);
    if (strip) {
      info.tight = true;
      readStalls(S, sw, strip[0], strip[1], spans);
    }
    if (spans.length) {
      var n = spans.length / 3;
      // Walls and stalls are found apart, and walkers read spans nearest first.
      var order = [];
      for (var o = 0; o < n; o++) order.push(o);
      order.sort(function (a, b) { return spans[a * 3] - spans[b * 3] || a - b; });
      info.nSpans = n;
      info.spanS0 = new Float32Array(n);
      info.spanS1 = new Float32Array(n);
      info.spanSpot = new Int32Array(n);
      for (var i = 0; i < n; i++) {
        info.spanS0[i] = spans[order[i] * 3];
        info.spanS1[i] = spans[order[i] * 3 + 1];
        info.spanSpot[i] = spans[order[i] * 3 + 2];
      }
    }
    readCrossings(S, sw, info);
    return info;
  }

  /**
   * What a walker needs to know about a row. Derived from the World and cached for this sim.
   * @param {object} S Sim state.
   * @param {number} swId Sidewalk.
   * @returns {object} Row info.
   */
  walk.rowInfo = function (S, swId) {
    var rows = S.pedsys.rows;
    var info = rows[swId];
    if (!info) {
      info = buildRow(S, swId);
      rows[swId] = info;
    }
    return info;
  };

  /**
   * Reads everything a row can hold, ahead of the walker who would read it.
   * @param {object} S Sim state.
   * @param {number} swId Sidewalk.
   */
  walk.warmRow = function (S, swId) {
    readLinks(S, walk.rowInfo(S, swId));
  };

  /** @returns {boolean} True when span k stops a walker now: always for a wall, and while something stands in a stall. */
  function spanShut(S, info, k) {
    var spot = info.spanSpot[k];
    return spot < 0 || TLV.world.parking.state(S, spot) !== TLV.const.OCC.FREE;
  }

  /**
   * Nearest place ahead that a walker must turn back from. A span the walker is already inside lets them walk out.
   * @param {object} S Sim state.
   * @param {object} info Row info.
   * @param {number} s Metres along the row.
   * @param {number} dir +1 or -1.
   * @returns {number} Metres along the row, or +/-Infinity.
   */
  walk.blockAhead = function (S, info, s, dir) {
    var k;
    if (dir > 0) {
      for (k = 0; k < info.nSpans; k++) {
        if (info.spanS0[k] > s && spanShut(S, info, k)) return info.spanS0[k];
      }
      return Infinity;
    }
    for (k = info.nSpans - 1; k >= 0; k--) {
      if (info.spanS1[k] < s && spanShut(S, info, k)) return info.spanS1[k];
    }
    return -Infinity;
  };

  /**
   * @param {object} S Sim state.
   * @param {object} info Row info.
   * @param {number} s Metres along the row.
   * @param {number} margin Metres either side that must be clear too.
   * @returns {boolean} True when a person can stand at s now.
   */
  walk.pointFree = function (S, info, s, margin) {
    for (var k = 0; k < info.nSpans; k++) {
      if (info.spanS0[k] - margin <= s && info.spanS1[k] + margin >= s && spanShut(S, info, k)) return false;
    }
    return true;
  };

  /**
   * @returns {number} Metres of open row around s, or 0 when s itself is shut.
   */
  walk.openRun = function (S, info, s, len) {
    if (!walk.pointFree(S, info, s, 0)) return 0;
    var hi = walk.blockAhead(S, info, s, 1);
    var lo = walk.blockAhead(S, info, s, -1);
    return Math.min(hi, len) - Math.max(lo, 0);
  };

  /** Reads the links of a row the first time someone needs one. */
  function readLinks(S, info) {
    if (info.linksRead) return;
    info.linksRead = true;
    var sw = S.world.sidewalks[info.id];
    var e = S.world.edges[sw.edge];
    for (var l = 0; l < sw.links.length; l++) readLink(S, info, sw, l);
    // Walks stop short of a turning car's way, even where no link goes on from there.
    info.endLo = standOff(S, sw, false, S.world.juncs[e.a]);
    info.endHi = sw.len - standOff(S, sw, true, S.world.juncs[e.b]);
  }

  /**
   * Reads a row's links now. They are otherwise read when someone comes near an end.
   * @param {object} S Sim state.
   * @param {object} info Row info.
   */
  walk.readLinks = readLinks;

  /**
   * Sends a walker through one of the open links at the end of a row, or turns them round.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {boolean} atEnd Which end of the row.
   * @returns {boolean} True when a link was taken.
   */
  walk.takeLink = function (S, p, atEnd) {
    var W = S.world;
    var P = p._p;
    var sw = W.sidewalks[P.sw];
    var info = walk.rowInfo(S, P.sw);
    readLinks(S, info);
    var links = sw.links;
    var count = 0;
    var l;
    for (l = 0; l < links.length; l++) {
      if (links[l].atEnd === atEnd && info.linkOk[l] && targetFree(S, links[l])) count++;
    }
    if (count === 0) return false;
    var pick = count > 1 ? S.rng.ped.int(count) : 0;
    for (l = 0; l < links.length; l++) {
      if (links[l].atEnd !== atEnd || !info.linkOk[l] || !targetFree(S, links[l])) continue;
      if (pick-- > 0) continue;
      var other = W.sidewalks[links[l].sw];
      var at = links[l].toStart ? 0 : other.px.length - 1;
      if (info.linkRoad[l]) {
        var via = info.linkVia[l] === 1;
        TLV.peds.cross.startLink(S, p, via, info.linkX[l], info.linkY[l], other, at, links[l].toStart);
        return true;
      }
      P.sw = links[l].sw;
      P.s = links[l].toStart ? 0 : other.len;
      P.dir = links[l].toStart ? 1 : -1;
      P.mode = 'LINK';
      P.gx = other.px[at];
      P.gy = other.py[at];
      P.via = info.linkVia[l] === 1;
      P.viaX = info.linkX[l];
      P.viaY = info.linkY[l];
      P.after = 'ROW';
      return true;
    }
    return false;
  };

  /** @returns {boolean} True when the row a link lands on can be stood on at that end. */
  function targetFree(S, link) {
    var other = S.world.sidewalks[link.sw];
    return walk.pointFree(S, walk.rowInfo(S, link.sw), link.toStart ? 0 : other.len, 0);
  }

  /** Records a turn. Someone who keeps turning has found a pocket, and goes when nobody is looking. */
  function noteFlip(S, p) {
    var P = p._p;
    var T = TLV.tune.peds;
    if (S.t - P.flipT > T.flipWindowS) {
      P.flipT = S.t;
      P.flips = 0;
    }
    if (++P.flips >= T.flipMax) P.recycle = true;
  }

  /**
   * Points a person at the place their private velocity reaches by the next think.
   * @param {object} p Pedestrian.
   * @param {number} tx Target x.
   * @param {number} ty Target y.
   * @param {number} dt Seconds to the next think.
   */
  walk.aimAt = function (p, tx, ty, dt) {
    var P = p._p;
    var dx = tx - p.x;
    var dy = ty - p.y;
    P.vx = dx / dt;
    P.vy = dy / dt;
    var d = Math.sqrt(dx * dx + dy * dy);
    p.v = d / dt;
    if (d > 1e-4) P.hT = Math.atan2(dy, dx);
  };

  /**
   * Stops a person where they are.
   * @param {object} p Pedestrian.
   */
  walk.halt = function (p) {
    var P = p._p;
    P.vx = 0;
    P.vy = 0;
    p.v = 0;
  };

  /** Moves a person to their place on the row, easing back to it if a vehicle moved them off. */
  function placeOnRow(S, p, dt) {
    var P = p._p;
    var sw = S.world.sidewalks[P.sw];
    var at = S.pedsys.pt;
    TLV.math.polyAt(sw.px, sw.py, sw.cum, P.s, at);
    if (P.ox !== 0 || P.oy !== 0) {
      var off = Math.sqrt(P.ox * P.ox + P.oy * P.oy);
      var ease = TLV.tune.peds.easeBack * dt;
      var keep = off > ease ? (off - ease) / off : 0;
      P.ox *= keep;
      P.oy *= keep;
    }
    var nx = -Math.sin(at.h);
    var ny = Math.cos(at.h);
    // A ribbon can stand a hand off a wall, or beside a parked car, with no width to spread across. Such a walker keeps to the line.
    if (P.lat !== 0 && (walk.rowInfo(S, P.sw).tight || inSolid(S.world, at.x + nx * P.lat, at.y + ny * P.lat))) {
      P.lat = Math.abs(P.lat) < 0.05 ? 0 : P.lat * 0.75;
    }
    walk.aimAt(p, at.x + nx * P.lat + P.ox, at.y + ny * P.lat + P.oy, dt);
  }

  /**
   * One think of walking a row: turn back at anything blocking it, consider a crossing, take a link at the end.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {number} dt Seconds to the next think.
   */
  walk.stepRow = function (S, p, dt) {
    var P = p._p;
    var T = TLV.tune.peds;
    var sw = S.world.sidewalks[P.sw];
    var info = walk.rowInfo(S, P.sw);
    var from = P.s;
    var to = from + P.speed * dt * P.dir;
    if (info.nSpans) {
      var lim = walk.blockAhead(S, info, from, P.dir);
      if ((to - lim) * P.dir > -T.spanBackM) {
        P.dir = -P.dir;
        noteFlip(S, p);
        to = from;
      }
    }
    if (P.job === 'AMBIENT' && !p.intent && TLV.peds.cross.consider(S, p, info, from, to)) {
      walk.stepFree(S, p, dt);
      return;
    }
    if (!info.linksRead && (to < T.linkBackM * 2 || to > sw.len - T.linkBackM * 2)) readLinks(S, info);
    if (to <= info.endLo || to >= info.endHi) {
      var atEnd = P.dir > 0;
      if (walk.takeLink(S, p, atEnd)) {
        walk.stepFree(S, p, dt);
        return;
      }
      P.dir = atEnd ? -1 : 1;
      noteFlip(S, p);
      to = from;
    }
    P.s = to;
    placeOnRow(S, p, dt);
  };

  /**
   * Starts a straight walk to a point.
   * @param {object} p Pedestrian.
   * @param {number} x Target x.
   * @param {number} y Target y.
   * @param {string} after What happens on arrival: ROW, KERB, BAY, WRITE, LANE, NONE.
   */
  walk.goTo = function (p, x, y, after) {
    var P = p._p;
    P.mode = 'FREE';
    P.gx = x;
    P.gy = y;
    P.via = false;
    P.after = after;
    P.stuckT = 0;
    P.lastD = Infinity;
  };

  /**
   * Whether a straight walk keeps out of parked cars.
   * @param {object} S Sim state.
   * @param {number} ax Start x.
   * @param {number} ay Start y.
   * @param {number} bx End x.
   * @param {number} by End y.
   * @param {number} pad Metres to keep off a car.
   * @returns {boolean} True when it does.
   */
  walk.legClear = function (S, ax, ay, bx, by, pad) {
    var W = S.world;
    var sys = S.pedsys;
    var math = TLV.math;
    var d = math.dist(ax, ay, bx, by);
    var count = TLV.world.parking.parkedNear(S, (ax + bx) / 2, (ay + by) / 2, d / 2 + TLV.tune.world.spotLen, sys.spots2);
    var n = Math.max(1, Math.ceil(d * 2));
    for (var k = 0; k < count; k++) {
      TLV.world.parking.boxOf(W, sys.spots2[k], TLV.world.parking.state(S, sys.spots2[k]), sys.box);
      for (var i = 0; i <= n; i++) {
        if (inBox(ax + (bx - ax) * i / n, ay + (by - ay) * i / n, sys.box, pad)) return false;
      }
    }
    return true;
  };

  /**
   * Sends a person to the nearest sidewalk they can reach past the parked cars, to carry on from there. With none in reach they
   * stand, and go when nobody is looking.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @returns {boolean} False when there is no sidewalk to go to.
   */
  walk.toSidewalk = function (S, p) {
    var P = p._p;
    var T = TLV.tune.peds;
    var W = S.world;
    var sys = S.pedsys;
    var at = sys.pt;
    var near = TLV.world.sidewalks.nearest(W, p.x, p.y, sys.swOut);
    if (!near) {
      P.mode = 'STAND';
      P.recycle = true;
      walk.halt(p);
      return false;
    }
    var row = W.sidewalks[near.sw];
    var s = near.s;
    var found = false;
    for (var i = 0; i < T.jayShifts.length && !found; i++) {
      var tryS = TLV.math.clamp(near.s + T.jayShifts[i] * 2, 0, row.len);
      TLV.math.polyAt(row.px, row.py, row.cum, tryS, at);
      if (!walk.legClear(S, p.x, p.y, at.x, at.y, p.r)) continue;
      s = tryS;
      found = true;
    }
    TLV.math.polyAt(row.px, row.py, row.cum, s, at);
    P.sw = near.sw;
    P.s = s;
    walk.goTo(p, at.x, at.y, 'ROW');
    return true;
  };

  /** Handles arrival at the end of a free walk. */
  function arrive(S, p, dt) {
    var P = p._p;
    switch (P.after) {
      case 'ROW':
        P.mode = 'ROW';
        P.ox = 0;
        P.oy = 0;
        P.gaveUp = false;
        if (p.state === 'DROPPED') {
          TLV.peds.setState(p, 'WALK');
          P.speed = P.base;
        }
        placeOnRow(S, p, dt);
        TLV.peds.maybeStroll(S, p);
        return;
      case 'KERB':
        TLV.peds.cross.atKerb(S, p);
        return;
      case 'BAY':
        P.mode = 'STAND';
        walk.halt(p);
        return;
      case 'WRITE':
        P.mode = 'STAND';
        P.writeT = TLV.tune.peds.inspectWriteS;
        walk.halt(p);
        return;
      case 'LANE':
        TLV.peds.cross.atLane(S, p);
        return;
      default:
        P.mode = 'STAND';
        walk.halt(p);
    }
  }

  /**
   * One think of a straight walk, by way of a waypoint if there is one. Keeps off vehicles, and slides along walls. A corner link
   * was read in advance, so it needs neither.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {number} dt Seconds to the next think.
   */
  walk.stepFree = function (S, p, dt) {
    var P = p._p;
    var T = TLV.tune.peds;
    var tx = P.via ? P.viaX : P.gx;
    var ty = P.via ? P.viaY : P.gy;
    var dx = tx - p.x;
    var dy = ty - p.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    var step = P.speed * dt;
    if (d <= step) {
      if (P.via) {
        P.via = false;
        walk.aimAt(p, tx, ty, dt);
        return;
      }
      walk.aimAt(p, tx, ty, dt);
      arrive(S, p, dt);
      return;
    }
    var nx = p.x + dx / d * step;
    var ny = p.y + dy / d * step;
    // A link is a free walk too. Straight at a van stopped across it, a walker would lean on the van's flank until it moved.
    if (P.mode === 'FREE' || P.mode === 'LINK') {
      var out = S.pedsys.pt2;
      if (S.pedsys.nearN > 0 && walk.steer(S, p, p.x, p.y, nx, ny, step, out)) {
        nx = out.x;
        ny = out.y;
      }
      if (inSolid(S.world, nx, ny) && !inSolid(S.world, p.x, p.y)) {
        if (!inSolid(S.world, nx, p.y)) ny = p.y;
        else if (!inSolid(S.world, p.x, ny)) nx = p.x;
        else {
          nx = p.x;
          ny = p.y;
        }
      }
      // Giving up beats walking on the spot for ever: the place is taken as reached. Bound for a row, they first make for the nearest one
      // from here, because the row they gave up on can be 50 m away. Stuck on that too, they walk out to it from where they stand.
      if (d >= P.lastD - 0.02) {
        P.stuckT += dt;
        if (P.stuckT > T.freeStuckS) {
          P.stuckT = 0;
          P.via = false;
          if (P.after === 'ROW' && !P.gaveUp && walk.toSidewalk(S, p)) {
            P.gaveUp = true;
          } else {
            P.gx = p.x;
            P.gy = p.y;
          }
        }
      } else {
        P.stuckT = 0;
      }
      P.lastD = d;
    }
    walk.aimAt(p, nx, ny, dt);
  };

  /**
   * Fills sys.near with the vehicles around a point.
   * @param {object} S Sim state.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} r Radius.
   * @param {object[]} out Filled with vehicles.
   * @returns {number} How many.
   */
  walk.vehicles = function (S, x, y, r, out) {
    var tr = TLV.traffic;
    if (tr && tr.vehiclesNear && S.flags.traffic) return tr.vehiclesNear(S, x, y, r, out);
    var n = 0;
    var r2 = r * r;
    for (var i = 0; i < S.vehicles.length; i++) {
      var v = S.vehicles[i];
      if (!v.active) continue;
      var dx = v.x - x;
      var dy = v.y - y;
      if (dx * dx + dy * dy <= r2) out[n++] = v;
    }
    return n;
  };

  /**
   * Seconds until a vehicle's body reaches a circle at (x, y), on its present line.
   * @param {object} v Vehicle.
   * @param {number} x Circle x.
   * @param {number} y Circle y.
   * @param {number} r Circle radius.
   * @returns {number} Seconds, or Infinity when it is not coming.
   */
  walk.ttcBody = function (v, x, y, r) {
    var speed = v.v < 0 ? -v.v : v.v;
    if (speed < TLV.tune.peds.stoppedV) return Infinity;
    var c = Math.cos(v.h);
    var s = Math.sin(v.h);
    var dx = x - v.x;
    var dy = y - v.y;
    var a = (dx * c + dy * s) * (v.v < 0 ? -1 : 1);
    var l = dy * c - dx * s;
    var side = v.width / 2 + r + TLV.tune.peds.hopLateralM;
    if (l > side || l < -side || a < -v.length / 2 - r) return Infinity;
    var gap = a - v.length / 2 - r;
    return gap > 0 ? gap / speed : 0;
  };

  /**
   * Distance from a point to a vehicle's body.
   * @param {object} v Vehicle.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @returns {number} Metres, 0 inside.
   */
  walk.bodyDist = function (v, x, y) {
    var c = Math.cos(v.h);
    var s = Math.sin(v.h);
    var dx = x - v.x;
    var dy = y - v.y;
    var a = Math.abs(dx * c + dy * s) - v.length / 2;
    var l = Math.abs(dy * c - dx * s) - v.width / 2;
    if (a < 0) a = 0;
    if (l < 0) l = 0;
    return Math.sqrt(a * a + l * l);
  };

  /** Records an AI vehicle touching a person, the one number the People gate reads. */
  function noteContact(S, p, v, depth) {
    var sys = S.pedsys;
    sys.contacts++;
    if (depth > sys.deepest) sys.deepest = depth;
    if (!sys.lastContact) {
      sys.lastContact = {
        tick: S.tick, ped: p ? p.id : -1, kind: p ? p.kind : 'foot', state: p ? p.state : 'FOOT', mode: p ? p._p.mode : 'FOOT',
        px: p ? p.x : 0, py: p ? p.y : 0, veh: v.id, vehKind: v.kind, beh: v.beh, vehMode: v.mode, lane: v.laneId, conn: v.connId,
        v: v.v, x: v.x, y: v.y, h: v.h, depth: depth
      };
    }
  }

  /**
   * Looks at the vehicles around a person: fills sys.near, records any AI contact, and leaves the shortest TTC in sys.ttc.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   */
  walk.scan = function (S, p) {
    var sys = S.pedsys;
    var P = p._p;
    var T = TLV.tune.peds;
    var road = P.mode !== 'ROW' && P.mode !== 'LINK';
    var n = walk.vehicles(S, p.x, p.y, road ? T.scanRoadM : T.scanWalkM, sys.near);
    sys.nearN = n;
    sys.ttc = Infinity;
    sys.ttcVeh = null;
    var look = T.hopLookS;
    var fx = p.x + P.vx * look;
    var fy = p.y + P.vy * look;
    // On a walk the margin goes: a ribbon can stand close to a lane, and a car going by it is not coming for anyone.
    var body = road ? p.r : p.r - T.hopLateralM;
    var inside = false;
    for (var i = 0; i < n; i++) {
      var v = sys.near[i];
      var ttc = walk.ttcBody(v, p.x, p.y, body);
      var later = walk.ttcBody(v, fx, fy, body);
      if (later < ttc) ttc = later;
      if (ttc < sys.ttc) {
        sys.ttc = ttc;
        sys.ttcVeh = v;
      }
      // A car knocked sliding by the player is no longer being driven by anyone.
      if (v.isPlayer || v.mode === 'PARKED' || v.mode === 'DYNAMIC') continue;
      var d = walk.bodyDist(v, p.x, p.y);
      if (d >= p.r - 0.02) continue;
      // A stopped car a person was set down beside or knocked against has done nothing.
      var still = (v.v < 0 ? -v.v : v.v) < T.stoppedV;
      if (still && (P.force || P.through)) {
        inside = true;
        continue;
      }
      if (still && (p.state === 'DROPPED' || p.state === 'STUMBLE' || p.state === 'SCRIPT')) continue;
      noteContact(S, p, v, p.r - d);
    }
    // A walk through a stopped body can reach the kerb before it reaches the far side of the body. It is the same walk until they are out.
    P.through = inside;
  };

  /**
   * Scans for the on-foot player. Nothing moves him here, but a moving AI car touching him is still a contact.
   * @param {object} S Sim state.
   * @param {number} x Foot x.
   * @param {number} y Foot y.
   */
  walk.scanFoot = function (S, x, y) {
    var sys = S.pedsys;
    var T = TLV.tune.peds;
    var n = walk.vehicles(S, x, y, T.scanWalkM, sys.near);
    for (var i = 0; i < n; i++) {
      var v = sys.near[i];
      if (v.isPlayer || v.mode === 'PARKED' || v.mode === 'DYNAMIC' || (v.v < 0 ? -v.v : v.v) < T.stoppedV) continue;
      var d = walk.bodyDist(v, x, y);
      if (d < T.walkerR - 0.02) noteContact(S, null, v, T.walkerR - d);
    }
  };

  /**
   * Keeps a step off vehicles' bodies. A step into a long side stands on that side and walks along it toward the nearer end. A step
   * into a nose or tail walks across it, the way the person wants to go. So a person gets past a stopped car, or down the gap
   * between two in a queue, and a stopped crowd of cars can never hold anyone for good.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {number} fromX Where the step starts.
   * @param {number} fromY Where the step starts.
   * @param {number} nx Where it wants to end.
   * @param {number} ny Where it wants to end.
   * @param {number} step Metres.
   * @param {{x:number,y:number}} out Written with where it ends.
   * @returns {boolean} True when a vehicle changed the step.
   */
  walk.steer = function (S, p, fromX, fromY, nx, ny, step, out) {
    var sys = S.pedsys;
    var P = p._p;
    if (P.force) return false;
    var clear = p.r + TLV.tune.peds.bodyClearM;
    var x = nx;
    var y = ny;
    var hit = false;
    for (var pass = 0; pass < 2; pass++) {
      var moved = false;
      for (var i = 0; i < sys.nearN; i++) {
        var v = sys.near[i];
        var c = Math.cos(v.h);
        var s = Math.sin(v.h);
        var dx = x - v.x;
        var dy = y - v.y;
        var a = dx * c + dy * s;
        var l = dy * c - dx * s;
        var ha = v.length / 2 + clear;
        var hw = v.width / 2 + clear;
        if (a >= ha || a <= -ha || l >= hw || l <= -hw) continue;
        var pa = ha - Math.abs(a);
        var pl = hw - Math.abs(l);
        if (pl <= pa) {
          if (P.slide === 0) P.slide = a >= 0 ? 1 : -1;
          l = l >= 0 ? hw : -hw;
          a += P.slide * step;
        } else {
          var along = (ny - fromY) * c - (nx - fromX) * s;
          var way = Math.abs(along) > 0.2 * step ? (along > 0 ? 1 : -1) : (l >= 0 ? 1 : -1);
          a = a >= 0 ? ha : -ha;
          l += way * step;
        }
        x = v.x + a * c - l * s;
        y = v.y + a * s + l * c;
        hit = true;
        moved = true;
      }
      if (!moved) break;
    }
    if (!hit) P.slide = 0;
    out.x = x;
    out.y = y;
    return hit;
  };

  /**
   * Moves a point out of a box at (bx, by, bh) grown by clear, by the shorter way out, or only sideways if asked. Writes sys.pt2.
   * @param {number} [clearSide] Growth across the box, if it differs from clear along it.
   * @returns {boolean} True if it was in.
   */
  function outOfBox(sys, v, bx, by, bh, clear, x, y, sideways, clearSide) {
    var c = Math.cos(bh);
    var s = Math.sin(bh);
    var dx = x - bx;
    var dy = y - by;
    var a = dx * c + dy * s;
    var l = dy * c - dx * s;
    var ha = v.length / 2 + clear;
    var hw = v.width / 2 + (clearSide === undefined ? clear : clearSide);
    if (a >= ha || a <= -ha || l >= hw || l <= -hw) return false;
    if (!sideways && ha - Math.abs(a) < hw - Math.abs(l)) {
      a = a >= 0 ? ha : -ha;
      sys.pushHead = true;
    } else {
      l = l >= 0 ? hw : -hw;
      sys.pushHead = false;
    }
    sys.pt2.x = bx + a * c - l * s;
    sys.pt2.y = by + a * s + l * c;
    return true;
  }

  /**
   * The last word on a think's speed, whatever set it. A step is worked out from places, so it can come to anything: walking round a
   * car, stepping aside and being shoved add up to 8 m/s for a few ticks, and a rider pushed round a car's corner read 31 m/s. Nobody
   * goes faster than their speed class, unless that leaves a moving body on top of them by the next think. Then they may add that
   * body's speed, and no more. A step the cap cut short can stop inside the room a body needs, where the whole step would have cleared
   * it, so one that would take them deeper is not taken: they wait a think, which anyone can do at any speed. Near a body, what the cap
   * takes off goes in the offset, so they ease back to their place on a row or a crossing. With none near, the offset is not the cap's
   * business, and they walk it off.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {number} dt Seconds to the next think.
   */
  walk.capSpeed = function (S, p, dt) {
    var P = p._p;
    if (P.force || p.state === 'SCRIPT' || p.state === 'STUMBLE') return;
    var sys = S.pedsys;
    var T = TLV.tune.peds;
    var most = TLV.peds.riders.isRider(p) ? P.base : (T.flee > T.aimMaxWalker ? T.flee : T.aimMaxWalker);
    if (P.speed > most) most = P.speed;
    var dx = P.vx * dt;
    var dy = P.vy * dt;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d <= most * dt) return;
    var cx = p.x + dx * most * dt / d;
    var cy = p.y + dy * most * dt / d;
    var extra = 0;
    var i;
    for (i = 0; i < sys.nearN; i++) {
      var c = sys.near[i];
      var yaw = c.yawRate < 0 ? -c.yawRate : c.yawRate;
      var body = (c.v < 0 ? -c.v : c.v) + yaw * c.length / 2;
      if (body <= extra || walk.bodyDist(c, cx - c.vx * dt, cy - c.vy * dt) >= p.r + T.bodyEaseM + yaw * c.length / 2 * dt) continue;
      extra = body;
    }
    if (d <= (most + extra) * dt) return;
    most += extra;
    cx = p.x + dx * most * dt / d;
    cy = p.y + dy * most * dt / d;
    for (i = 0; i < sys.nearN; i++) {
      var b = sys.near[i];
      var room = p.r + T.bodyEaseM + (b.yawRate < 0 ? -b.yawRate : b.yawRate) * b.length / 2 * dt;
      var after = walk.bodyDist(b, cx - b.vx * dt, cy - b.vy * dt);
      if (after < room && after < walk.bodyDist(b, p.x - b.vx * dt, p.y - b.vy * dt)) {
        cx = p.x;
        cy = p.y;
        break;
      }
    }
    if (sys.nearN > 0 && (P.mode === 'ROW' || (P.mode === 'PATH' && P.stage === 'ROAD'))) {
      P.ox += cx - (p.x + dx);
      P.oy += cy - (p.y + dy);
    }
    walk.aimAt(p, cx, cy, dt);
  };

  /**
   * The last word on a step, whatever made it: a body stays off a vehicle's body. A ribbon can stand within a rider's radius of a
   * lane, and a bus turning a corner swings its ends out over the kerb, faster than its centre moves. So each vehicle is read where
   * it will be in a moment too: someone in that place steps aside at a walk, and only someone it has already reached is pushed. Off
   * their row or line, they ease back to it through their offset. Someone stumbling from a hit goes sideways only, and never into a
   * wall: pushed out of the nose, they would ride in front of the bumper for as long as the car kept coming.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {number} dt Seconds to the next think.
   * @returns {boolean} True when the body stopped them head on, so their place along a row or lane must wait.
   */
  walk.keepOff = function (S, p, dt) {
    var sys = S.pedsys;
    var P = p._p;
    if (P.force) return false;
    var T = TLV.tune.peds;
    var look = T.bodyLookS;
    var wantX = p.x + P.vx * dt;
    var wantY = p.y + P.vy * dt;
    var x = wantX;
    var y = wantY;
    var hit = false;
    var stopped = false;
    var aside = T.flee * dt;
    var fallen = p.state === 'STUMBLE';
    var rider = TLV.peds.riders.isRider(p);
    for (var i = 0; i < sys.nearN; i++) {
      var v = sys.near[i];
      var yaw = v.yawRate < 0 ? -v.yawRate : v.yawRate;
      var speed = v.v < 0 ? -v.v : v.v;
      var c = Math.cos(v.h);
      var s = Math.sin(v.h);
      var drift = v.vy * c - v.vx * s;
      var swing = yaw * v.length / 2;
      var ahead = (speed + swing) * dt;
      // A body moves along itself: beside it, only what it swings or drifts by the next think. All round, this was a shove at 8 m/s.
      // Not for a rider, who closes on a car's corner at 6 m/s or more, and needs the room.
      var across = rider ? ahead : ((drift < 0 ? -drift : drift) + swing) * dt;
      var clear = p.r + T.bodyEaseM + (ahead < T.bodyLeadM ? ahead : T.bodyLeadM);
      var clearSide = p.r + T.bodyEaseM + (across < T.bodyLeadM ? across : T.bodyLeadM);
      if (outOfBox(sys, v, v.x, v.y, v.h, clear, x, y, fallen, clearSide)) {
        var ma = P.vx * c + P.vy * s;
        var ml = P.vy * c - P.vx * s;
        var la = (x - v.x) * c + (y - v.y) * s;
        var ll = (y - v.y) * c - (x - v.x) * s;
        if (sys.pushHead ? ma * la < 0 && ma * ma > ml * ml : ml * ll < 0 && ml * ml > ma * ma) stopped = true;
        x = sys.pt2.x;
        y = sys.pt2.y;
        hit = true;
        continue;
      }
      if (speed < T.stoppedV) continue;
      var fx = v.x + (v.vx !== 0 || v.vy !== 0 ? v.vx : Math.cos(v.h) * v.v) * look;
      var fy = v.y + (v.vx !== 0 || v.vy !== 0 ? v.vy : Math.sin(v.h) * v.v) * look;
      // Sideways only: out of the end of where it will be can be straight back into where it is.
      if (!outOfBox(sys, v, fx, fy, v.h + v.yawRate * look, p.r + T.bodyEaseM, x, y, true)) continue;
      var dx = sys.pt2.x - x;
      var dy = sys.pt2.y - y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d > aside) {
        dx *= aside / d;
        dy *= aside / d;
      }
      var ox = P.ox + x + dx - wantX;
      var oy = P.oy + y + dy - wantY;
      if (ox * ox + oy * oy > T.strayMaxM * T.strayMaxM) continue;
      x += dx;
      y += dy;
      hit = true;
    }
    if (!hit) return false;
    if (fallen && TLV.world.spatial.pointInBuilding(S.world, x, y) >= 0) {
      walk.halt(p);
      return false;
    }
    // Pushed off one body onto the next: the gap is too narrow for them, so they wait for it to open.
    for (var n = 0; n < sys.nearN; n++) {
      var body = sys.near[n];
      var after = walk.bodyDist(body, x, y);
      if (after < p.r && after < walk.bodyDist(body, p.x, p.y)) {
        walk.halt(p);
        return true;
      }
    }
    if (P.mode === 'ROW' || (P.mode === 'PATH' && P.stage === 'ROAD')) {
      P.ox += x - wantX;
      P.oy += y - wantY;
    }
    walk.aimAt(p, x, y, dt);
    return stopped;
  };

  /**
   * Whether the player can see a point.
   * @param {object} S Sim state.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @returns {boolean}
   */
  walk.seen = function (S, x, y) {
    var tr = TLV.traffic;
    if (tr && tr.visibleToPlayer) return tr.visibleToPlayer(S, x, y);
    var veh = S.player && S.player.veh;
    if (!veh) return false;
    var dx = x - S.player.fx;
    var dy = y - S.player.fy;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d > 170) return false;
    if (d > 1 && Math.abs(TLV.math.wrapPi(Math.atan2(dy, dx) - veh.h)) > 75 * Math.PI / 180) return false;
    return !TLV.world.spatial.rayBlocked(S.world, S.player.fx, S.player.fy, x, y);
  };

  /** @returns {boolean} True when a vehicle's body is within a rider's reach of a point, so nobody can appear there. */
  function carOn(S, x, y) {
    var sys = S.pedsys;
    var T = TLV.tune.peds;
    var n = walk.vehicles(S, x, y, T.scanWalkM, sys.far);
    for (var i = 0; i < n; i++) {
      if (walk.bodyDist(sys.far[i], x, y) < T.riderR + T.bodyClearM) return true;
    }
    return false;
  }

  /**
   * Finds a place for someone new, on an open stretch of sidewalk between two distances from the player. Points are uniform over
   * the ring, so the crowd follows the area and not how many sidewalks a block happens to have.
   * @param {object} S Sim state.
   * @param {number} rMin Least distance.
   * @param {number} rMax Most distance.
   * @param {boolean} hide True to avoid being seen appearing.
   * @param {{sw:number,s:number,x:number,y:number}} out Written with the place.
   * @returns {boolean} False when no try found one.
   */
  walk.findPlace = function (S, rMin, rMax, hide, out) {
    var W = S.world;
    var T = TLV.tune.peds;
    var sys = S.pedsys;
    var rng = S.rng.ped;
    var math = TLV.math;
    var fx = S.player.fx;
    var fy = S.player.fy;
    var at = sys.pt;
    for (var t = 0; t < T.spawnTries; t++) {
      var ang = rng.range(0, Math.PI * 2);
      var rad = Math.sqrt(rng.range(rMin * rMin, rMax * rMax));
      var near = TLV.world.sidewalks.nearest(W, fx + Math.cos(ang) * rad, fy + Math.sin(ang) * rad, sys.swOut);
      if (!near || near.d > T.spawnSnapM) continue;
      TLV.world.sidewalks.pointAt(W, near.sw, near.s, at);
      var d = math.dist(fx, fy, at.x, at.y);
      if (d < rMin || d > rMax) continue;
      var info = walk.rowInfo(S, near.sw);
      if (walk.openRun(S, info, near.s, W.sidewalks[near.sw].len) < T.spawnRunM) continue;
      if (hide && d < T.spawnSeenM && walk.seen(S, at.x, at.y)) continue;
      if (carOn(S, at.x, at.y)) continue;
      out.sw = near.sw;
      out.s = near.s;
      out.x = at.x;
      out.y = at.y;
      return true;
    }
    return false;
  };
})(window.TLV);
