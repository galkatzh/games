// js/core/math.js — WP-CORE
// Pure maths on numbers and plain objects. Nothing here allocates except the optional `out` default.
(function (TLV) {
  'use strict';

  var math = TLV.ns('math');

  var PI = Math.PI;
  var TAU = 2 * Math.PI;

  /** polyProject with a hint scans this far either side of it, metres. */
  var HINT_WINDOW = 50;
  /** If the hinted scan lands farther than this from the polyline, it is stale, so the whole polyline is scanned. */
  var HINT_MAX_D = 10;

  /** @returns {number} x limited to [a, b]. */
  math.clamp = function (x, a, b) {
    return x < a ? a : (x > b ? b : x);
  };

  /** @returns {number} Linear blend from a to b at t, not clamped. */
  math.lerp = function (a, b, t) {
    return a + (b - a) * t;
  };

  /** @returns {number} Position of x between a and b, not clamped; 0 when a equals b. */
  math.invLerp = function (a, b, x) {
    return a === b ? 0 : (x - a) / (b - a);
  };

  /** @returns {number} Hermite 0-1 ramp of x between a and b, clamped at both ends. */
  math.smoothstep = function (a, b, x) {
    var t = math.clamp(math.invLerp(a, b, x), 0, 1);
    return t * t * (3 - 2 * t);
  };

  /** @returns {number} -1, 0 or 1. */
  math.sign = function (x) {
    return x > 0 ? 1 : (x < 0 ? -1 : 0);
  };

  /**
   * Normalizes an angle.
   * @param {number} a Radians.
   * @returns {number} The same direction in (-pi, pi].
   */
  math.wrapPi = function (a) {
    if (a > -PI && a <= PI) return a;
    var r = a - TAU * Math.ceil((a - PI) / TAU);
    return r <= -PI ? r + TAU : (r > PI ? r - TAU : r);
  };

  /** @returns {number} wrapPi(a - b). */
  math.angDiff = function (a, b) {
    return math.wrapPi(a - b);
  };

  /** @returns {number} Distance between two points. */
  math.dist = function (ax, ay, bx, by) {
    var dx = bx - ax;
    var dy = by - ay;
    return Math.sqrt(dx * dx + dy * dy);
  };

  /** @returns {number} Squared distance between two points. */
  math.dist2 = function (ax, ay, bx, by) {
    var dx = bx - ax;
    var dy = by - ay;
    return dx * dx + dy * dy;
  };

  /** @returns {number} Length of a polyline given as parallel coordinate arrays. */
  math.polyLen = function (px, py) {
    var sum = 0;
    for (var i = 1; i < px.length; i++) sum += math.dist(px[i - 1], py[i - 1], px[i], py[i]);
    return sum;
  };

  /** @returns {Float32Array} Cumulative arc length at each vertex, starting at 0. */
  math.cumLen = function (px, py) {
    var n = px.length;
    var cum = new Float32Array(n);
    var sum = 0;
    for (var i = 1; i < n; i++) {
      sum += math.dist(px[i - 1], py[i - 1], px[i], py[i]);
      cum[i] = sum;
    }
    return cum;
  };

  /** @returns {number} Largest segment index whose start is at or before s, for a polyline of n >= 2 vertices. */
  function segmentAt(cum, n, s) {
    var lo = 0;
    var hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /**
   * Evaluates a polyline at arc length s, which is clamped to the polyline.
   * @param {ArrayLike<number>} px Vertex x.
   * @param {ArrayLike<number>} py Vertex y.
   * @param {ArrayLike<number>} cum Result of cumLen.
   * @param {number} s Arc length.
   * @param {{x:number,y:number,h:number}} [out] Written and returned.
   * @returns {{x:number,y:number,h:number}} Point and heading of the segment there. A zero-length segment takes the
   *   heading of the nearest real one.
   */
  math.polyAt = function (px, py, cum, s, out) {
    var r = out || { x: 0, y: 0, h: 0 };
    var n = px.length;
    if (n === 0) {
      r.x = 0; r.y = 0; r.h = 0;
      return r;
    }
    if (n === 1) {
      r.x = px[0]; r.y = py[0]; r.h = 0;
      return r;
    }
    var total = cum[n - 1];
    var at = s > 0 ? (s > total ? total : s) : 0;
    var i = segmentAt(cum, n, at);
    var len = cum[i + 1] - cum[i];
    var t = len > 0 ? (at - cum[i]) / len : 0;
    r.x = px[i] + (px[i + 1] - px[i]) * t;
    r.y = py[i] + (py[i + 1] - py[i]) * t;

    var dx = px[i + 1] - px[i];
    var dy = py[i + 1] - py[i];
    for (var j = i - 1; dx === 0 && dy === 0 && j >= 0; j--) {
      dx = px[j + 1] - px[j];
      dy = py[j + 1] - py[j];
    }
    for (var k = i + 1; dx === 0 && dy === 0 && k < n - 1; k++) {
      dx = px[k + 1] - px[k];
      dy = py[k + 1] - py[k];
    }
    r.h = Math.atan2(dy, dx);
    return r;
  };

  /** Finds the nearest point on segments lo..hi and writes s, d and side into out. */
  function scanSegments(px, py, cum, x, y, lo, hi, out) {
    var best = Infinity;
    var bestI = lo;
    var bestT = 0;
    var bestCross = 0;
    for (var i = lo; i <= hi; i++) {
      var ax = px[i];
      var ay = py[i];
      var dx = px[i + 1] - ax;
      var dy = py[i + 1] - ay;
      var ex = x - ax;
      var ey = y - ay;
      var len2 = dx * dx + dy * dy;
      var t = len2 > 0 ? (ex * dx + ey * dy) / len2 : 0;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      var qx = ex - dx * t;
      var qy = ey - dy * t;
      var d2 = qx * qx + qy * qy;
      if (d2 < best) {
        best = d2;
        bestI = i;
        bestT = t;
        bestCross = dx * ey - dy * ex;
      }
    }
    out.s = cum[bestI] + (cum[bestI + 1] - cum[bestI]) * bestT;
    out.d = Math.sqrt(best);
    out.side = bestCross > 0 ? 1 : (bestCross < 0 ? -1 : 0);
  }

  /**
   * Projects a point onto a polyline.
   * @param {ArrayLike<number>} px Vertex x.
   * @param {ArrayLike<number>} py Vertex y.
   * @param {ArrayLike<number>} cum Result of cumLen.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {?number} hintS Last known s. With a finite hint >= 0, the search stays within 50 m of it, which keeps
   *   tracking on the right pass of a route that doubles back. Beyond 10 m off that window it scans everything.
   * @param {{s:number,d:number,side:number}} [out] Written and returned.
   * @returns {{s:number,d:number,side:number}} s along the polyline, d >= 0 distance to it, side +1 left of travel,
   *   -1 right, 0 exactly on the line.
   */
  math.polyProject = function (px, py, cum, x, y, hintS, out) {
    var r = out || { s: 0, d: 0, side: 0 };
    var n = px.length;
    if (n === 0) {
      r.s = 0; r.d = 0; r.side = 0;
      return r;
    }
    if (n === 1) {
      r.s = 0; r.d = math.dist(px[0], py[0], x, y); r.side = 0;
      return r;
    }
    if (typeof hintS === 'number' && hintS >= 0 && hintS < Infinity) {
      var lo = segmentAt(cum, n, hintS - HINT_WINDOW);
      var hi = segmentAt(cum, n, hintS + HINT_WINDOW);
      scanSegments(px, py, cum, x, y, lo, hi, r);
      if (r.d <= HINT_MAX_D) return r;
    }
    scanSegments(px, py, cum, x, y, 0, n - 2, r);
    return r;
  };

  /** @returns {boolean} True when (px,py), known collinear with a-b, lies within that segment's box. */
  function withinBox(px, py, ax, ay, bx, by) {
    return px >= Math.min(ax, bx) && px <= Math.max(ax, bx) && py >= Math.min(ay, by) && py <= Math.max(ay, by);
  }

  /**
   * Segment intersection test. Touching endpoints and collinear overlap count as a hit.
   * @returns {boolean} True when segments a-b and c-d share a point.
   */
  math.segSegHit = function (ax, ay, bx, by, cx, cy, dx, dy) {
    var d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    var d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
    var d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    var d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return true;
    if (d1 === 0 && withinBox(ax, ay, cx, cy, dx, dy)) return true;
    if (d2 === 0 && withinBox(bx, by, cx, cy, dx, dy)) return true;
    if (d3 === 0 && withinBox(cx, cy, ax, ay, bx, by)) return true;
    if (d4 === 0 && withinBox(dx, dy, ax, ay, bx, by)) return true;
    return false;
  };

  /** @returns {number} Distance from point p to segment a-b. */
  math.pointSegDist = function (px, py, ax, ay, bx, by) {
    var dx = bx - ax;
    var dy = by - ay;
    var ex = px - ax;
    var ey = py - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? (ex * dx + ey * dy) / len2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var qx = ex - dx * t;
    var qy = ey - dy * t;
    return Math.sqrt(qx * qx + qy * qy);
  };

  /**
   * Even-odd point in polygon test.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {ArrayLike<number>|Array<number[]>} poly Flat x,y pairs (the World shapes), or an array of [x, y].
   * @returns {boolean} True when inside. Points exactly on an edge may fall either way.
   */
  math.pointInPoly = function (x, y, poly) {
    if (!poly || poly.length === 0) return false;
    var nested = typeof poly[0] !== 'number';
    var n = nested ? poly.length : poly.length >> 1;
    var inside = false;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = nested ? poly[i][0] : poly[i * 2];
      var yi = nested ? poly[i][1] : poly[i * 2 + 1];
      var xj = nested ? poly[j][0] : poly[j * 2];
      var yj = nested ? poly[j][1] : poly[j * 2 + 1];
      if ((yi > y) !== (yj > y) && x < (xj - xi) * (y - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };

  /**
   * Largest separation along the four box axes. Positive means separated by at least that much. Zero or negative
   * means overlap, and its magnitude is the least penetration.
   */
  function maxSeparation(a, b) {
    var ca = Math.cos(a.h);
    var sa = Math.sin(a.h);
    var cb = Math.cos(b.h);
    var sb = Math.sin(b.h);
    var c = Math.abs(ca * cb + sa * sb);
    var s = Math.abs(sa * cb - ca * sb);
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var al = a.length / 2;
    var aw = a.width / 2;
    var bl = b.length / 2;
    var bw = b.width / 2;
    var s1 = Math.abs(dx * ca + dy * sa) - (al + bl * c + bw * s);
    var s2 = Math.abs(-dx * sa + dy * ca) - (aw + bl * s + bw * c);
    var s3 = Math.abs(dx * cb + dy * sb) - (bl + al * c + aw * s);
    var s4 = Math.abs(-dx * sb + dy * cb) - (bw + al * s + aw * c);
    var best = s1;
    if (s2 > best) best = s2;
    if (s3 > best) best = s3;
    if (s4 > best) best = s4;
    return best;
  }

  /** @returns {number} Distance from world point (x, y) to box b, 0 when inside. */
  function pointBoxDist(x, y, b, cb, sb) {
    var ex = x - b.x;
    var ey = y - b.y;
    var dl = Math.abs(ex * cb + ey * sb) - b.length / 2;
    var dw = Math.abs(-ex * sb + ey * cb) - b.width / 2;
    if (dl < 0) dl = 0;
    if (dw < 0) dw = 0;
    return Math.sqrt(dl * dl + dw * dw);
  }

  /** @returns {number} Smallest distance from a corner of box p to box q. */
  function cornersToBox(p, q, best) {
    var cp = Math.cos(p.h);
    var sp = Math.sin(p.h);
    var cq = Math.cos(q.h);
    var sq = Math.sin(q.h);
    var hl = p.length / 2;
    var hw = p.width / 2;
    for (var i = 0; i < 4; i++) {
      var l = (i & 1) ? hl : -hl;
      var w = (i & 2) ? hw : -hw;
      var d = pointBoxDist(p.x + l * cp - w * sp, p.y + l * sp + w * cp, q, cq, sq);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * Oriented box overlap test. Touching counts as overlap.
   * @param {{x:number,y:number,h:number,length:number,width:number}} a Box, centred on x, y.
   * @param {{x:number,y:number,h:number,length:number,width:number}} b Box.
   * @returns {boolean} True when the boxes share area or touch.
   */
  math.obbOverlap = function (a, b) {
    return maxSeparation(a, b) <= 0;
  };

  /**
   * Separation between two oriented boxes. The minimum distance between two disjoint convex polygons is always at a
   * vertex of one of them, so checking corners against boxes is exact, including corner to corner.
   * @param {{x:number,y:number,h:number,length:number,width:number}} a Box.
   * @param {{x:number,y:number,h:number,length:number,width:number}} b Box.
   * @returns {number} Metres apart. <= 0 when overlapping, and then minus the least penetration.
   */
  math.obbGap = function (a, b) {
    var sep = maxSeparation(a, b);
    if (sep <= 0) return sep;
    return cornersToBox(b, a, cornersToBox(a, b, Infinity));
  };

  /**
   * Oriented box contact, by the separating axis test.
   * @param {{x:number,y:number,h:number,length:number,width:number}} a Box.
   * @param {{x:number,y:number,h:number,length:number,width:number}} b Box.
   * @param {{nx:number,ny:number,depth:number,cx:number,cy:number}} out Written only on overlap. The normal is a unit
   *   vector from a toward b. Moving b by depth along it, or a by depth against it, separates them. (cx, cy) is the
   *   middle of the contact feature, halfway through the penetration.
   * @returns {boolean} True on overlap.
   */
  math.obbSat = function (a, b, out) {
    var ca = Math.cos(a.h);
    var sa = Math.sin(a.h);
    var cb = Math.cos(b.h);
    var sb = Math.sin(b.h);
    var c = Math.abs(ca * cb + sa * sb);
    var s = Math.abs(sa * cb - ca * sb);
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    var al = a.length / 2;
    var aw = a.width / 2;
    var bl = b.length / 2;
    var bw = b.width / 2;

    var pa = dx * ca + dy * sa;
    var pb = -dx * sa + dy * ca;
    var pc = dx * cb + dy * sb;
    var pd = -dx * sb + dy * cb;

    var s1 = Math.abs(pa) - (al + bl * c + bw * s);
    var s2 = Math.abs(pb) - (aw + bl * s + bw * c);
    var s3 = Math.abs(pc) - (bl + al * c + aw * s);
    var s4 = Math.abs(pd) - (bw + al * s + aw * c);
    if (s1 > 0 || s2 > 0 || s3 > 0 || s4 > 0) return false;

    // The axis of least penetration, and the box that owns it: its face is the reference, the other box the incident.
    var sep = s1;
    var axis = 0;
    if (s2 > sep) { sep = s2; axis = 1; }
    if (s3 > sep) { sep = s3; axis = 2; }
    if (s4 > sep) { sep = s4; axis = 3; }

    var ownerA = axis < 2;
    var ref = ownerA ? a : b;
    var inc = ownerA ? b : a;
    var rc = ownerA ? ca : cb;
    var rs = ownerA ? sa : sb;
    var nx;
    var ny;
    var tx;
    var ty;
    var en;
    var et;
    var along;
    if (axis === 0 || axis === 2) {
      nx = rc; ny = rs; tx = -rs; ty = rc;
      en = ref.length / 2; et = ref.width / 2;
      along = axis === 0 ? pa : pc;
    } else {
      nx = -rs; ny = rc; tx = rc; ty = rs;
      en = ref.width / 2; et = ref.length / 2;
      along = axis === 1 ? pb : pd;
    }
    // along is measured from a to b. Turn the axis so it points out of the reference face toward the incident box.
    var flip = (ownerA ? along : -along) < 0;
    if (flip) { nx = -nx; ny = -ny; }

    var ci = Math.cos(inc.h);
    var si = Math.sin(inc.h);
    var il = inc.length / 2;
    var iw = inc.width / 2;
    var deepest = Infinity;
    var tMin = Infinity;
    var tMax = -Infinity;
    for (var i = 0; i < 4; i++) {
      var l = (i & 1) ? il : -il;
      var w = (i & 2) ? iw : -iw;
      var ex = inc.x + l * ci - w * si - ref.x;
      var ey = inc.y + l * si + w * ci - ref.y;
      var pn = ex * nx + ey * ny;
      var pt = ex * tx + ey * ty;
      if (pn < deepest - 1e-6) {
        deepest = pn;
        tMin = pt;
        tMax = pt;
      } else if (pn <= deepest + 1e-6) {
        if (pt < tMin) tMin = pt;
        if (pt > tMax) tMax = pt;
      }
    }
    if (tMin < -et) tMin = -et;
    if (tMax > et) tMax = et;
    var tc = (tMin + tMax) / 2;
    var depth = -sep;
    var nc = en - depth / 2;

    out.depth = depth;
    out.cx = ref.x + nx * nc + tx * tc;
    out.cy = ref.y + ny * nc + ty * tc;
    out.nx = ownerA ? nx : -nx;
    out.ny = ownerA ? ny : -ny;
    return true;
  };
})(window.TLV);
