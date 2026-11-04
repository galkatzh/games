// js/world/geom.js — WP-WORLD
// Polyline and curve construction used while building the world. Nothing here touches sim state.
(function (TLV) {
  'use strict';

  var geom = TLV.ns('world.geom');

  /** Vertices closer than this are one vertex. Map data is in decimetres, so this only removes true duplicates. */
  var SAME_POINT = 1e-3;
  /** A mitre never reaches further than this many offsets from its vertex, the limit the importer's gates assume. */
  var MITRE_LIMIT = 2;
  /** Curve samples behind the arc-length table of one Bezier. */
  var BEZIER_TABLE = 16;
  /** Vertices a reusable line holds before it has to grow. */
  var FIRST_CAPACITY = 512;

  /**
   * Makes a reusable polyline. The build shapes tens of thousands of short-lived lines, and a throwaway array for each one
   * was a tenth of the build's cost in garbage collection alone.
   * @returns {{x: Float64Array, y: Float64Array, n: number}}
   */
  geom._newLine = function () {
    // Filled in two steps so its buffers are variables to V8 from the start: they grow, and that must not cost anyone their code.
    var line = { x: null, y: null, n: 0 };
    line.x = new Float64Array(FIRST_CAPACITY);
    line.y = new Float64Array(FIRST_CAPACITY);
    return line;
  };

  /** Makes sure a reusable line holds n vertices. Contents are lost if it grows. */
  function reserve(line, n) {
    if (line.x.length >= n) return;
    line.x = new Float64Array(n * 2);
    line.y = new Float64Array(n * 2);
  }

  /**
   * Copies a polyline without repeated vertices, in either direction.
   * @param {ArrayLike<number>} px Vertex x.
   * @param {ArrayLike<number>} py Vertex y.
   * @param {boolean} reverse Copy it backwards.
   * @param {{x: Float64Array, y: Float64Array, n: number}} out Written.
   */
  geom._loadLine = function (px, py, reverse, out) {
    var n = px.length;
    reserve(out, n);
    var qx = out.x;
    var qy = out.y;
    var m = 0;
    for (var i = 0; i < n; i++) {
      var k = reverse ? n - 1 - i : i;
      var x = px[k];
      var y = py[k];
      if (m > 0 && Math.abs(x - qx[m - 1]) < SAME_POINT && Math.abs(y - qy[m - 1]) < SAME_POINT) continue;
      qx[m] = x;
      qy[m] = y;
      m++;
    }
    out.n = m;
  };

  /**
   * Removes offset vertices that make the line run backwards. On the inside of a tight bend two neighbouring mitres can
   * pass each other, which would leave a small loop that a car would drive round. Comparing every offset span with the
   * span of the source line that it stands for finds those. End vertices always stay, so lanes keep their end positions.
   * @param {object} src Source line.
   * @param {object} out Offset line, same length. Compacted in place.
   */
  function dropInverted(src, out) {
    var sx = src.x;
    var sy = src.y;
    var qx = out.x;
    var qy = out.y;
    var n = out.n;
    var i;
    var clean = true;
    for (i = 0; i + 1 < n && clean; i++) {
      if ((qx[i + 1] - qx[i]) * (sx[i + 1] - sx[i]) + (qy[i + 1] - qy[i]) * (sy[i + 1] - sy[i]) <= 0) clean = false;
    }
    if (clean) return;
    var keep = [];
    for (i = 0; i < n; i++) keep.push(i);
    var changed = true;
    while (changed && keep.length > 2) {
      changed = false;
      for (i = 0; i + 1 < keep.length && keep.length > 2; i++) {
        var a = keep[i];
        var b = keep[i + 1];
        if ((qx[b] - qx[a]) * (sx[b] - sx[a]) + (qy[b] - qy[a]) * (sy[b] - sy[a]) > 0) continue;
        keep.splice(i + 2 < keep.length ? i + 1 : i, 1);
        changed = true;
        if (i > 0) i--;
      }
    }
    for (i = 0; i < keep.length; i++) {
      qx[i] = qx[keep[i]];
      qy[i] = qy[keep[i]];
    }
    out.n = keep.length;
  }

  /**
   * Offsets a line sideways, keeping its direction. Joins are limited mitres, and any span the offset turns backwards on the
   * inside of a tight bend is removed.
   * @param {{x: Float64Array, y: Float64Array, n: number}} src Line with distinct vertices.
   * @param {number} offRight Metres to the right of travel. Negative is left.
   * @param {{x: Float64Array, y: Float64Array, n: number}} out Written.
   */
  geom._offsetLine = function (src, offRight, out) {
    var n = src.n;
    reserve(out, n);
    var sx = src.x;
    var sy = src.y;
    var qx = out.x;
    var qy = out.y;
    out.n = n;
    if (n < 2) {
      if (n === 1) {
        qx[0] = sx[0];
        qy[0] = sy[0];
      }
      return;
    }
    var nxPrev = 0;
    var nyPrev = 0;
    for (var i = 0; i < n; i++) {
      var nx;
      var ny;
      var scale = 1;
      if (i + 1 < n) {
        var dx = sx[i + 1] - sx[i];
        var dy = sy[i + 1] - sy[i];
        var l = Math.sqrt(dx * dx + dy * dy);
        nx = dy / l;
        ny = -dx / l;
      } else {
        nx = nxPrev;
        ny = nyPrev;
      }
      var mx = nx;
      var my = ny;
      if (i > 0 && i + 1 < n) {
        mx = nx + nxPrev;
        my = ny + nyPrev;
        var ml = Math.sqrt(mx * mx + my * my);
        if (ml < 1e-6) {
          // A full reversal has no bisector. The offset of the arriving span is a sound point.
          mx = nxPrev;
          my = nyPrev;
        } else {
          mx /= ml;
          my /= ml;
          var cos = mx * nx + my * ny;
          scale = cos > 1 / MITRE_LIMIT ? 1 / cos : MITRE_LIMIT;
        }
      }
      qx[i] = sx[i] + mx * offRight * scale;
      qy[i] = sy[i] + my * offRight * scale;
      nxPrev = nx;
      nyPrev = ny;
    }
    dropInverted(src, out);
  };

  /** @returns {{px: number[], py: number[]}} A plain copy of a line. */
  function plainCopy(line) {
    return { px: Array.from(line.x.subarray(0, line.n)), py: Array.from(line.y.subarray(0, line.n)) };
  }

  /**
   * Offsets a polyline sideways, keeping its direction. Joins are limited mitres, and any span the offset turns backwards
   * on the inside of a tight bend is removed.
   * @param {ArrayLike<number>} px Vertex x.
   * @param {ArrayLike<number>} py Vertex y.
   * @param {number} offRight Metres to the right of travel. Negative is left.
   * @returns {{px: number[], py: number[]}} At least two vertices when the input has two distinct ones.
   */
  geom.offsetPolyline = function (px, py, offRight) {
    var src = geom._newLine();
    var out = geom._newLine();
    geom._loadLine(px, py, false, src);
    geom._offsetLine(src, offRight, out);
    return plainCopy(out);
  };

  /** @returns {number} x of a cubic at t. */
  function cubic(a, b, c, d, t) {
    var u = 1 - t;
    return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d;
  }

  /**
   * Samples a cubic Bezier at even arc length.
   * @param {number} x0 Start x.
   * @param {number} y0 Start y.
   * @param {number} x1 First control x.
   * @param {number} y1 First control y.
   * @param {number} x2 Second control x.
   * @param {number} y2 Second control y.
   * @param {number} x3 End x.
   * @param {number} y3 End y.
   * @param {number} spacing Most arc length between samples, metres.
   * @param {{x: Float64Array, y: Float64Array, n: number}} out Written. Starts exactly at the start, ends exactly at the end.
   */
  geom._bezierLine = function (x0, y0, x1, y1, x2, y2, x3, y3, spacing, out) {
    var table = out.table || (out.table = new Float64Array(BEZIER_TABLE + 1));
    var lastX = x0;
    var lastY = y0;
    var i;
    for (i = 1; i <= BEZIER_TABLE; i++) {
      var t = i / BEZIER_TABLE;
      var bx = cubic(x0, x1, x2, x3, t);
      var by = cubic(y0, y1, y2, y3, t);
      table[i] = table[i - 1] + Math.sqrt((bx - lastX) * (bx - lastX) + (by - lastY) * (by - lastY));
      lastX = bx;
      lastY = by;
    }
    var total = table[BEZIER_TABLE];
    var n = Math.max(2, Math.ceil(total / spacing));
    reserve(out, n + 1);
    var px = out.x;
    var py = out.y;
    var seg = 0;
    for (i = 0; i <= n; i++) {
      var want = total * i / n;
      while (seg < BEZIER_TABLE - 1 && table[seg + 1] < want) seg++;
      var span = table[seg + 1] - table[seg];
      var f = span > 0 ? (want - table[seg]) / span : 0;
      var at = (seg + f) / BEZIER_TABLE;
      px[i] = cubic(x0, x1, x2, x3, at);
      py[i] = cubic(y0, y1, y2, y3, at);
    }
    px[0] = x0;
    py[0] = y0;
    px[n] = x3;
    py[n] = y3;
    out.n = n + 1;
  };

  /** @returns {number} First coordinate of a point given as {x, y} or [x, y]. */
  function xOf(p) {
    return p.x !== undefined ? p.x : p[0];
  }

  /** @returns {number} Second coordinate of a point given as {x, y} or [x, y]. */
  function yOf(p) {
    return p.y !== undefined ? p.y : p[1];
  }

  /**
   * Samples a cubic Bezier at even arc length.
   * @param {{x:number,y:number}|number[]} p0 Start.
   * @param {{x:number,y:number}|number[]} p1 First control point.
   * @param {{x:number,y:number}|number[]} p2 Second control point.
   * @param {{x:number,y:number}|number[]} p3 End.
   * @param {number} spacing Most arc length between samples, metres.
   * @returns {{px: number[], py: number[]}} Starts exactly at p0 and ends exactly at p3.
   */
  geom.bezierPoly = function (p0, p1, p2, p3, spacing) {
    var out = geom._newLine();
    geom._bezierLine(xOf(p0), yOf(p0), xOf(p1), yOf(p1), xOf(p2), yOf(p2), xOf(p3), yOf(p3), spacing, out);
    return plainCopy(out);
  };

  /**
   * @param {{x: Float64Array, y: Float64Array, n: number}} line Line.
   * @returns {number} Its length.
   */
  geom._lineLength = function (line) {
    var sum = 0;
    var x = line.x;
    var y = line.y;
    for (var i = 1; i < line.n; i++) {
      var dx = x[i] - x[i - 1];
      var dy = y[i] - y[i - 1];
      sum += Math.sqrt(dx * dx + dy * dy);
    }
    return sum;
  };

  /**
   * Copies a line.
   * @param {{x: Float64Array, y: Float64Array, n: number}} src Line.
   * @param {{x: Float64Array, y: Float64Array, n: number}} out Written.
   */
  geom._copyLine = function (src, out) {
    reserve(out, src.n);
    out.x.set(src.x.subarray(0, src.n));
    out.y.set(src.y.subarray(0, src.n));
    out.n = src.n;
  };

  /**
   * Sets an oriented box.
   * @param {object} box Written.
   * @param {number} x Centre x.
   * @param {number} y Centre y.
   * @param {number} h Heading of its long axis.
   * @param {number} hl Half length.
   * @param {number} hw Half width.
   * @returns {{x:number,y:number,c:number,s:number,hl:number,hw:number}} box. c and s are the cosine and sine of h.
   */
  geom._setBox = function (box, x, y, h, hl, hw) {
    box.x = x;
    box.y = y;
    box.c = Math.cos(h);
    box.s = Math.sin(h);
    box.hl = hl;
    box.hw = hw;
    return box;
  };

  /** @returns {boolean} True when the segment from (u0, v0) to (u1, v1) meets the rectangle |u| <= hl, |v| <= hw. */
  function segMeetsRect(u0, v0, u1, v1, hl, hw) {
    var enter = 0;
    var leave = 1;
    var du = u1 - u0;
    var dv = v1 - v0;
    if (du === 0) {
      if (u0 < -hl || u0 > hl) return false;
    } else {
      var a = (-hl - u0) / du;
      var b = (hl - u0) / du;
      enter = Math.max(enter, Math.min(a, b));
      leave = Math.min(leave, Math.max(a, b));
      if (enter > leave) return false;
    }
    if (dv === 0) return v0 >= -hw && v0 <= hw;
    var c = (-hw - v0) / dv;
    var d = (hw - v0) / dv;
    return Math.max(enter, Math.min(c, d)) <= Math.min(leave, Math.max(c, d));
  }

  /** @returns {number} Distance from a point to the rectangle |u| <= hl, |v| <= hw, 0 inside it. */
  function pointRectDist(u, v, hl, hw) {
    var du = Math.max(Math.abs(u) - hl, 0);
    var dv = Math.max(Math.abs(v) - hw, 0);
    return Math.sqrt(du * du + dv * dv);
  }

  /**
   * Exact distance from a segment to an oriented box, 0 when they meet. That covers a segment wholly inside the box.
   * @param {number} ax Segment start x.
   * @param {number} ay Segment start y.
   * @param {number} bx Segment end x.
   * @param {number} by Segment end y.
   * @param {{x:number,y:number,c:number,s:number,hl:number,hw:number}} box From _setBox.
   * @returns {number} Metres.
   */
  geom._segBoxDist = function (ax, ay, bx, by, box) {
    var c = box.c;
    var s = box.s;
    var hl = box.hl;
    var hw = box.hw;
    var dx = ax - box.x;
    var dy = ay - box.y;
    var u0 = dx * c + dy * s;
    var v0 = dy * c - dx * s;
    dx = bx - box.x;
    dy = by - box.y;
    var u1 = dx * c + dy * s;
    var v1 = dy * c - dx * s;
    if (segMeetsRect(u0, v0, u1, v1, hl, hw)) return 0;
    // Two convex shapes that do not meet are closest at a vertex of one, so these six distances hold the answer.
    var dist = TLV.math.pointSegDist;
    var best = Math.min(pointRectDist(u0, v0, hl, hw), pointRectDist(u1, v1, hl, hw));
    best = Math.min(best, dist(hl, hw, u0, v0, u1, v1), dist(hl, -hw, u0, v0, u1, v1));
    return Math.min(best, dist(-hl, hw, u0, v0, u1, v1), dist(-hl, -hw, u0, v0, u1, v1));
  };

  /**
   * True when a polyline passes within reach of a box.
   * @param {ArrayLike<number>} px Vertex x.
   * @param {ArrayLike<number>} py Vertex y.
   * @param {{x:number,y:number,c:number,s:number,hl:number,hw:number}} box From _setBox.
   * @param {number} reach Metres.
   * @returns {boolean}
   */
  geom._lineNearBox = function (px, py, box, reach) {
    var rx = box.hl * Math.abs(box.c) + box.hw * Math.abs(box.s) + reach;
    var ry = box.hl * Math.abs(box.s) + box.hw * Math.abs(box.c) + reach;
    var minX = box.x - rx;
    var maxX = box.x + rx;
    var minY = box.y - ry;
    var maxY = box.y + ry;
    for (var i = 0; i + 1 < px.length; i++) {
      if ((px[i] < minX && px[i + 1] < minX) || (px[i] > maxX && px[i + 1] > maxX)) continue;
      if ((py[i] < minY && py[i + 1] < minY) || (py[i] > maxY && py[i + 1] > maxY)) continue;
      if (geom._segBoxDist(px[i], py[i], px[i + 1], py[i + 1], box) <= reach) return true;
    }
    return false;
  };

  /** @returns {number} Half the extent of a box along the unit axis (ax, ay). */
  function boxExtent(box, ax, ay) {
    return box.hl * Math.abs(box.c * ax + box.s * ay) + box.hw * Math.abs(box.c * ay - box.s * ax);
  }

  /** @returns {boolean} True when the axis (ax, ay) separates two boxes. */
  function separates(p, q, ax, ay) {
    return Math.abs((q.x - p.x) * ax + (q.y - p.y) * ay) > boxExtent(p, ax, ay) + boxExtent(q, ax, ay);
  }

  /**
   * True when two oriented boxes overlap, by the separating axis test.
   * @param {{x:number,y:number,c:number,s:number,hl:number,hw:number}} p From _setBox.
   * @param {{x:number,y:number,c:number,s:number,hl:number,hw:number}} q From _setBox.
   * @returns {boolean}
   */
  geom._boxesOverlap = function (p, q) {
    return !separates(p, q, p.c, p.s) && !separates(p, q, -p.s, p.c) && !separates(p, q, q.c, q.s) && !separates(p, q, -q.s, q.c);
  };

  /**
   * Cuts a line to the arc lengths [s0, s1].
   * @param {{x: Float64Array, y: Float64Array, n: number}} src Line.
   * @param {number} s0 Start, at least 0.
   * @param {number} s1 End, at most the line's length.
   * @param {{x: Float64Array, y: Float64Array, n: number}} out Written, with at least the two cut points.
   */
  geom._cutLine = function (src, s0, s1, out) {
    reserve(out, src.n + 2);
    var px = src.x;
    var py = src.y;
    var qx = out.x;
    var qy = out.y;
    var n = src.n;
    var m = 0;
    var at = 0;
    for (var i = 0; i + 1 < n; i++) {
      var dx = px[i + 1] - px[i];
      var dy = py[i + 1] - py[i];
      var l = Math.sqrt(dx * dx + dy * dy);
      var next = at + l;
      if (m === 0 && next >= s0 && l > 0) {
        var ta = (s0 - at) / l;
        if (ta < 0) ta = 0;
        qx[0] = px[i] + dx * ta;
        qy[0] = py[i] + dy * ta;
        m = 1;
      }
      if (m > 0 && next >= s1 && l > 0) {
        var tb = (s1 - at) / l;
        if (tb > 1) tb = 1;
        qx[m] = px[i] + dx * tb;
        qy[m] = py[i] + dy * tb;
        out.n = m + 1;
        return;
      }
      if (m > 0) {
        qx[m] = px[i + 1];
        qy[m] = py[i + 1];
        m++;
      }
      at = next;
    }
    if (m < 2) {
      qx[0] = px[0];
      qy[0] = py[0];
      qx[1] = px[n - 1];
      qy[1] = py[n - 1];
      m = 2;
    }
    out.n = m;
  };

  /**
   * Starts a block allocator for the many small float arrays a world holds. Each is a view on a shared buffer, which costs
   * far less to create and to collect than an array with a buffer of its own, and the world never writes to them.
   * @param {number} chunk Floats per block.
   * @returns {{buf: Float32Array, used: number, chunk: number}}
   */
  geom._arena = function (chunk) {
    // Set apart from the literal: V8 treats a field written once as a constant, and code built on that is thrown away when the
    // first block fills and the field changes. Here it is plainly a variable from the start.
    var arena = { buf: null, used: 0, chunk: chunk };
    arena.buf = new Float32Array(chunk);
    return arena;
  };

  /**
   * The same for ids. A world holds some 49,000 short id lists. A small typed array of its own costs a buffer object as well as the
   * view, about 224 bytes against 96, and every byte of that is copied by the scavenger on its way to old space.
   * @param {number} chunk Ids per block.
   * @returns {{buf: Int32Array, used: number, chunk: number}}
   */
  geom._idArena = function (chunk) {
    var arena = { buf: null, used: 0, chunk: chunk };
    arena.buf = new Int32Array(chunk);
    return arena;
  };

  /**
   * @param {{buf: Int32Array, used: number, chunk: number}} arena Allocator.
   * @param {number} n Ids.
   * @returns {Int32Array} A view of n ids, all zero.
   */
  geom._idView = function (arena, n) {
    if (arena.used + n > arena.buf.length) {
      arena.buf = new Int32Array(Math.max(arena.chunk, n));
      arena.used = 0;
    }
    var view = arena.buf.subarray(arena.used, arena.used + n);
    arena.used += n;
    return view;
  };

  /**
   * @param {{buf: Float32Array, used: number, chunk: number}} arena Allocator.
   * @param {number} n Floats.
   * @returns {Float32Array} A view of n floats.
   */
  geom._floats = function (arena, n) {
    if (arena.used + n > arena.buf.length) {
      arena.buf = new Float32Array(Math.max(arena.chunk, n));
      arena.used = 0;
    }
    var view = arena.buf.subarray(arena.used, arena.used + n);
    arena.used += n;
    return view;
  };

  /**
   * Stores a line for keeps, with its arc lengths.
   * @param {{buf: Float32Array, used: number, chunk: number}} arena Allocator.
   * @param {{x: Float64Array, y: Float64Array, n: number}} line Line.
   * @returns {{px: Float32Array, py: Float32Array, cum: Float32Array, len: number}}
   */
  geom._store = function (arena, line) {
    var n = line.n;
    var x = line.x;
    var y = line.y;
    var qx = geom._floats(arena, n);
    var qy = geom._floats(arena, n);
    var cum = geom._floats(arena, n);
    var sum = 0;
    for (var i = 0; i < n; i++) {
      qx[i] = x[i];
      qy[i] = y[i];
      if (i > 0) {
        var dx = qx[i] - qx[i - 1];
        var dy = qy[i] - qy[i - 1];
        sum += Math.sqrt(dx * dx + dy * dy);
        cum[i] = sum;
      }
    }
    return { px: qx, py: qy, cum: cum, len: sum };
  };

  /**
   * Copies a list of ids into an Int32Array. new Int32Array(list) takes a slow road for a plain array, and a world makes tens of
   * thousands of these.
   * @param {number[]} list Ids.
   * @returns {Int32Array}
   */
  geom._ids = function (list) {
    var out = new Int32Array(list.length);
    for (var i = 0; i < list.length; i++) out[i] = list[i];
    return out;
  };

  /**
   * geom._ids, for a list that stays in the World.
   * @param {{buf: Int32Array, used: number, chunk: number}} arena Allocator.
   * @param {number[]} list Ids.
   * @returns {Int32Array}
   */
  geom._idsIn = function (arena, list) {
    var out = geom._idView(arena, list.length);
    for (var i = 0; i < list.length; i++) out[i] = list[i];
    return out;
  };

  /**
   * TLV.math.polyAt with the direction of travel as a unit vector, for callers that want a point or a normal. The trig of a
   * heading would only be undone, and at tens of thousands of calls it shows.
   * @param {ArrayLike<number>} px Vertex x, at least two.
   * @param {ArrayLike<number>} py Vertex y.
   * @param {ArrayLike<number>} cum Arc lengths.
   * @param {number} s Arc length, clamped.
   * @param {{x: number, y: number, ux: number, uy: number}} out Written.
   */
  geom._pointAlong = function (px, py, cum, s, out) {
    var n = px.length;
    var total = cum[n - 1];
    var at = s > 0 ? (s > total ? total : s) : 0;
    var lo = 0;
    var hi = n - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (cum[mid] <= at) lo = mid;
      else hi = mid;
    }
    var len = cum[lo + 1] - cum[lo];
    var t = len > 0 ? (at - cum[lo]) / len : 0;
    var dx = px[lo + 1] - px[lo];
    var dy = py[lo + 1] - py[lo];
    out.x = px[lo] + dx * t;
    out.y = py[lo] + dy * t;
    for (var j = lo - 1; dx === 0 && dy === 0 && j >= 0; j--) {
      dx = px[j + 1] - px[j];
      dy = py[j + 1] - py[j];
    }
    for (var k = lo + 1; dx === 0 && dy === 0 && k < n - 1; k++) {
      dx = px[k + 1] - px[k];
      dy = py[k + 1] - py[k];
    }
    var l = Math.sqrt(dx * dx + dy * dy);
    out.ux = l > 0 ? dx / l : 1;
    out.uy = l > 0 ? dy / l : 0;
  };

  /**
   * Pushes onto a binary heap held in two parallel arrays. The routing and road distance searches share this.
   * @param {{heap: Int32Array, keys: Float64Array}} q Heap storage.
   * @param {number} size Entries held before this push.
   * @param {number} node Value.
   * @param {number} key Priority, lowest first.
   */
  geom._heapPush = function (q, size, node, key) {
    var heap = q.heap;
    var keys = q.keys;
    var i = size;
    while (i > 0) {
      var up = (i - 1) >> 1;
      if (keys[up] <= key) break;
      heap[i] = heap[up];
      keys[i] = keys[up];
      i = up;
    }
    heap[i] = node;
    keys[i] = key;
  };

  /**
   * Removes the root of a binary heap.
   * @param {{heap: Int32Array, keys: Float64Array}} q Heap storage.
   * @param {number} size Entries held before this pop.
   */
  geom._heapPop = function (q, size) {
    var heap = q.heap;
    var keys = q.keys;
    var last = size - 1;
    var node = heap[last];
    var key = keys[last];
    var i = 0;
    for (;;) {
      var kid = 2 * i + 1;
      if (kid >= last) break;
      if (kid + 1 < last && keys[kid + 1] < keys[kid]) kid++;
      if (keys[kid] >= key) break;
      heap[i] = heap[kid];
      keys[i] = keys[kid];
      i = kid;
    }
    heap[i] = node;
    keys[i] = key;
  };

  /**
   * Heading of a polyline between two arc lengths, read over the span so one tiny segment cannot decide it.
   * @param {ArrayLike<number>} px Vertex x.
   * @param {ArrayLike<number>} py Vertex y.
   * @param {ArrayLike<number>} cum Arc length at each vertex.
   * @param {number} s0 From this arc length.
   * @param {number} s1 To this arc length.
   * @param {{x:number,y:number,ux:number,uy:number}} a Scratch.
   * @param {{x:number,y:number,ux:number,uy:number}} b Scratch.
   * @returns {number} Radians.
   */
  geom._headingOver = function (px, py, cum, s0, s1, a, b) {
    geom._pointAlong(px, py, cum, s0, a);
    geom._pointAlong(px, py, cum, s1, b);
    var dx = b.x - a.x;
    var dy = b.y - a.y;
    return Math.atan2(dx === 0 && dy === 0 ? a.uy : dy, dx === 0 && dy === 0 ? a.ux : dx);
  };
})(window.TLV);
