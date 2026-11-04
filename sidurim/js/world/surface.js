// js/world/surface.js — WP-WORLD
// Surface raster (ARCHITECTURE 8.6). Each 4 m cell holds a base class, for everything that is not road, and a mask of its
// 4 x 4 one-metre sub-cells that are road. A 4 m cell alone cannot do: a 3 m one-way can fall between cell centres, and
// marking every cell it touches would put walkers "on the road" along the whole kerb.
(function (TLV) {
  'use strict';

  var surface = TLV.ns('world.surface');

  /** Sub-cells per cell side. */
  var SUB = 4;

  /** Land class to surface. A class that is absent stays on the base ground. */
  var LAND_SURFACE = { 0: 'WATER', 1: 'SAND', 2: 'PARK', 3: 'PARK', 4: 'WATER', 6: 'SAND', 7: 'PARK', 8: 'SIDEWALK' };
  /** Land paint order: later wins. Sand lies over the sea polygon's edge, and a pond or a river over any park. */
  var LAND_ORDER = [0, 2, 3, 7, 1, 6, 8, 4];

  /** Half width of a path by class, metres: promenade, footway, cycleway. */
  var PATH_HALF = [3, 1.5, 1.5];
  /** Spacing of the look along a sidewalk for ground that needs painting. */
  var PLAIN_CHECK_M = 4;
  /** Spacing of the stamps that paint a ribbon into the base layer. */
  var STAMP_STEP = 3;

  /** Writes base cell values across one row, by cell centre. */
  function fillRow(g, row, x0, x1, value) {
    var a = Math.ceil(x0 - 0.5);
    var b = Math.floor(x1 - 0.5);
    if (a < 0) a = 0;
    if (b >= g.nx) b = g.nx - 1;
    for (var col = a; col <= b; col++) g.base[row * g.nx + col] = value;
  }

  /** Fills between each pair of a row's hits, sorted here. A row holds a handful, so an insertion sort beats a comparator. */
  function fillHits(g, row, hits, value) {
    var size = g.cell;
    var i;
    for (i = 1; i < hits.length; i++) {
      var hit = hits[i];
      var at = i - 1;
      while (at >= 0 && hits[at] > hit) {
        hits[at + 1] = hits[at];
        at--;
      }
      hits[at + 1] = hit;
    }
    for (i = 0; i + 1 < hits.length; i += 2) {
      fillRow(g, row, (hits[i] - g.minX) / size, (hits[i + 1] - g.minX) / size, value);
    }
  }

  /**
   * Paints a polygon of flat x,y pairs into the base layer, by even-odd scanline at cell centres. Each edge hands its crossing to
   * the rows it spans, rather than each row reading every edge: the sea's outline has thousands of edges and spans the whole map.
   */
  function fillPoly(g, poly, value) {
    var n = poly.length >> 1;
    if (n < 3) return;
    var size = g.cell;
    var minY = Infinity;
    var maxY = -Infinity;
    var i;
    for (i = 0; i < n; i++) {
      if (poly[2 * i + 1] < minY) minY = poly[2 * i + 1];
      if (poly[2 * i + 1] > maxY) maxY = poly[2 * i + 1];
    }
    var r0 = Math.max(0, Math.ceil((minY - g.minY) / size - 0.5));
    var r1 = Math.min(g.ny - 1, Math.floor((maxY - g.minY) / size - 0.5));
    if (r1 < r0) return;
    var rows = new Array(r1 - r0 + 1);
    for (var a = 0, b = n - 1; a < n; b = a++) {
      var xa = poly[2 * a];
      var ya = poly[2 * a + 1];
      var xb = poly[2 * b];
      var yb = poly[2 * b + 1];
      // Rows whose centre lies in [low, high) of the edge's y, as (ya > y) !== (yb > y) reads.
      var low = ya < yb ? ya : yb;
      var high = ya < yb ? yb : ya;
      var first = Math.max(r0, Math.ceil((low - g.minY) / size - 0.5));
      var last = Math.min(r1, Math.floor((high - g.minY) / size - 0.5));
      for (var row = first; row <= last; row++) {
        var y = g.minY + (row + 0.5) * size;
        if ((ya > y) === (yb > y)) continue;
        var list = rows[row - r0];
        if (list) list.push(xa + (y - ya) * (xb - xa) / (yb - ya));
        else rows[row - r0] = [xa + (y - ya) * (xb - xa) / (yb - ya)];
      }
    }
    for (i = 0; i < rows.length; i++) {
      if (rows[i]) fillHits(g, r0 + i, rows[i], value);
    }
  }

  /** Sets the base cell holding a point. */
  function stamp(g, x, y, value) {
    var cx = Math.floor((x - g.minX) / g.cell);
    var cy = Math.floor((y - g.minY) / g.cell);
    if (cx >= 0 && cy >= 0 && cx < g.nx && cy < g.ny) g.base[cy * g.nx + cx] = value;
  }

  /** Paints a polyline ribbon into the base layer. The centre and both edges are stamped, so no cell it crosses is missed. */
  function stampRibbon(g, px, py, half, value) {
    for (var i = 0; i + 1 < px.length; i++) {
      var dx = px[i + 1] - px[i];
      var dy = py[i + 1] - py[i];
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len <= 0) continue;
      var nx = -dy / len * half;
      var ny = dx / len * half;
      var steps = Math.ceil(len / STAMP_STEP);
      for (var k = 0; k <= steps; k++) {
        var x = px[i] + dx * k / steps;
        var y = py[i] + dy * k / steps;
        stamp(g, x, y, value);
        stamp(g, x + nx, y + ny, value);
        stamp(g, x - nx, y - ny, value);
      }
    }
  }

  /** Marks sub-cells across one sub-row of a mask, one cell at a time. */
  function markRow(g, mask, row, x0, x1) {
    var a = Math.ceil(x0 - 0.5);
    var b = Math.floor(x1 - 0.5);
    var limit = g.nx * SUB;
    if (a < 0) a = 0;
    if (b >= limit) b = limit - 1;
    if (a > b) return;
    var cellRow = (row >> 2) * g.nx;
    var shift = (row & 3) << 2;
    var c0 = a >> 2;
    var c1 = b >> 2;
    if (c0 === c1) {
      mask[cellRow + c0] |= (((1 << (b - a + 1)) - 1) << (a & 3)) << shift;
      return;
    }
    mask[cellRow + c0] |= ((0xF << (a & 3)) & 0xF) << shift;
    var full = 0xF << shift;
    for (var c = c0 + 1; c < c1; c++) mask[cellRow + c] |= full;
    mask[cellRow + c1] |= ((1 << ((b & 3) + 1)) - 1) << shift;
  }

  /** Marks mask sub-cells inside a triangle, by sub-cell centre. Coordinates are metres. */
  function fillTri(g, mask, ax, ay, bx, by, cx, cy) {
    var u = g.cell / SUB;
    var x0 = (ax - g.minX) / u;
    var y0 = (ay - g.minY) / u;
    var x1 = (bx - g.minX) / u;
    var y1 = (by - g.minY) / u;
    var x2 = (cx - g.minX) / u;
    var y2 = (cy - g.minY) / u;
    var t;
    if (y0 > y1) { t = x0; x0 = x1; x1 = t; t = y0; y0 = y1; y1 = t; }
    if (y1 > y2) { t = x1; x1 = x2; x2 = t; t = y1; y1 = y2; y2 = t; }
    if (y0 > y1) { t = x0; x0 = x1; x1 = t; t = y0; y0 = y1; y1 = t; }
    if (y2 <= y0) return;
    var limit = g.ny * SUB;
    var r0 = Math.max(0, Math.ceil(y0 - 0.5));
    var r1 = Math.min(limit - 1, Math.floor(y2 - 0.5));
    var slopeLong = (x2 - x0) / (y2 - y0);
    var slopeUp = y1 > y0 ? (x1 - x0) / (y1 - y0) : 0;
    var slopeDown = y2 > y1 ? (x2 - x1) / (y2 - y1) : 0;
    for (var row = r0; row <= r1; row++) {
      var y = row + 0.5;
      var xLong = x0 + slopeLong * (y - y0);
      var xShort = y < y1 ? x0 + slopeUp * (y - y0) : x1 + slopeDown * (y - y1);
      if (xLong < xShort) markRow(g, mask, row, xLong, xShort);
      else markRow(g, mask, row, xShort, xLong);
    }
  }

  /**
   * Marks mask sub-cells inside one span of a ribbon, by sub-cell centre, in metres. Row by row from its least to its greatest x,
   * which is the same cells as its two triangles in half the row visits. A span that folds on a hairpin fills its fold too, a
   * sliver of road at a bend that has road on both sides of it.
   */
  function fillQuad(g, mask, ax, ay, bx, by, cx, cy, dx, dy) {
    var u = g.cell / SUB;
    var x0 = (ax - g.minX) / u;
    var y0 = (ay - g.minY) / u;
    var x1 = (bx - g.minX) / u;
    var y1 = (by - g.minY) / u;
    var x2 = (cx - g.minX) / u;
    var y2 = (cy - g.minY) / u;
    var x3 = (dx - g.minX) / u;
    var y3 = (dy - g.minY) / u;
    var top = Math.min(y0, y1, y2, y3);
    var bottom = Math.max(y0, y1, y2, y3);
    var r0 = Math.max(0, Math.ceil(top - 0.5));
    var r1 = Math.min(g.ny * SUB - 1, Math.floor(bottom - 0.5));
    // A horizontal side divides by zero here, and is never read: no row crosses it.
    var s0 = (x1 - x0) / (y1 - y0);
    var s1 = (x2 - x1) / (y2 - y1);
    var s2 = (x3 - x2) / (y3 - y2);
    var s3 = (x0 - x3) / (y0 - y3);
    for (var row = r0; row <= r1; row++) {
      var y = row + 0.5;
      var lo = Infinity;
      var hi = -Infinity;
      var x;
      if ((y0 > y) !== (y1 > y)) {
        x = x0 + (y - y0) * s0;
        lo = x;
        hi = x;
      }
      if ((y1 > y) !== (y2 > y)) {
        x = x1 + (y - y1) * s1;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      if ((y2 > y) !== (y3 > y)) {
        x = x2 + (y - y2) * s2;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      if ((y3 > y) !== (y0 > y)) {
        x = x3 + (y - y3) * s3;
        if (x < lo) lo = x;
        if (x > hi) hi = x;
      }
      if (lo <= hi) markRow(g, mask, row, lo, hi);
    }
  }

  /** Marks a ribbon: `left` metres to the left and `right` metres to the right of a polyline, with mitred joins. */
  function fillRibbon(g, mask, px, py, left, right) {
    var n = px.length;
    if (n < 2) return;
    var lastLX = 0;
    var lastLY = 0;
    var lastRX = 0;
    var lastRY = 0;
    var have = false;
    for (var i = 0; i < n; i++) {
      var j0 = i > 0 ? i - 1 : 0;
      var j1 = i + 1 < n ? i + 1 : n - 1;
      var dx0 = px[i] - px[j0];
      var dy0 = py[i] - py[j0];
      var dx1 = px[j1] - px[i];
      var dy1 = py[j1] - py[i];
      var l0 = Math.sqrt(dx0 * dx0 + dy0 * dy0);
      var l1 = Math.sqrt(dx1 * dx1 + dy1 * dy1);
      var nx = 0;
      var ny = 0;
      if (l0 > 0) { nx += -dy0 / l0; ny += dx0 / l0; }
      if (l1 > 0) { nx += -dy1 / l1; ny += dx1 / l1; }
      var nl = Math.sqrt(nx * nx + ny * ny);
      if (nl < 1e-6) continue;
      nx /= nl;
      ny /= nl;
      // Mitre: 1 / cos of half the turn, limited as lane offsets are.
      var scale = 1;
      if (l0 > 0 && l1 > 0) {
        var c = nx * (-dy1 / l1) + ny * (dx1 / l1);
        scale = c > 0.5 ? 1 / c : 2;
      }
      var lx = px[i] + nx * left * scale;
      var ly = py[i] + ny * left * scale;
      var rx = px[i] - nx * right * scale;
      var ry = py[i] - ny * right * scale;
      if (have) fillQuad(g, mask, lastLX, lastLY, lastRX, lastRY, rx, ry, lx, ly);
      lastLX = lx;
      lastLY = ly;
      lastRX = rx;
      lastRY = ry;
      have = true;
    }
  }

  /** Marks a junction polygon as a fan from its centre. Its vertices are sorted around that centre, so the fan is exact. */
  function fillFan(g, mask, poly) {
    var n = poly.length >> 1;
    if (n < 3) return;
    var mx = 0;
    var my = 0;
    for (var i = 0; i < n; i++) {
      mx += poly[2 * i];
      my += poly[2 * i + 1];
    }
    mx /= n;
    my /= n;
    for (var a = 0, b = n - 1; a < n; b = a++) {
      fillTri(g, mask, mx, my, poly[2 * b], poly[2 * b + 1], poly[2 * a], poly[2 * a + 1]);
    }
  }

  /** Paints land, in class order, then paths. */
  function paintGround(W, g) {
    var SURF = TLV.const.SURF;
    var i;
    for (var o = 0; o < LAND_ORDER.length; o++) {
      var cls = LAND_ORDER[o];
      var value = SURF[LAND_SURFACE[cls]];
      for (i = 0; i < W.land.length; i++) {
        if (W.land[i].cls === cls) fillPoly(g, W.land[i].poly, value);
      }
    }
    for (i = 0; i < W.paths.length; i++) {
      var p = W.paths[i];
      stampRibbon(g, p.px, p.py, PATH_HALF[p.cls] || PATH_HALF[1], SURF.SIDEWALK);
    }
  }

  /** @returns {boolean} True when a connector, both its edges included, already lies on road. */
  function pathCovered(g, c, half) {
    var px = c.px;
    var py = c.py;
    var n = px.length;
    for (var i = 0; i < n; i++) {
      var k = i + 1 < n ? i : i - 1;
      var dx = px[k + 1] - px[k];
      var dy = py[k + 1] - py[k];
      var l = Math.sqrt(dx * dx + dy * dy);
      var nx = l > 0 ? -dy / l * half : 0;
      var ny = l > 0 ? dx / l * half : 0;
      if (!marked(g, g.road, px[i], py[i]) || !marked(g, g.road, px[i] + nx, py[i] + ny) || !marked(g, g.road, px[i] - nx, py[i] - ny)) {
        return false;
      }
    }
    return true;
  }

  /**
   * Marks everything a car drives on: kerb to kerb along each edge, junction polygons, and any connector that runs outside
   * them. Parking strips count as road, since they are asphalt and a car parks on them.
   */
  function paintRoads(W, g) {
    var i;
    for (i = 0; i < W.edges.length; i++) {
      var e = W.edges[i];
      fillRibbon(g, g.road, e.px, e.py, e.kerbOffL, e.kerbOffR);
    }
    for (i = 0; i < W.juncs.length; i++) fillFan(g, g.road, W.juncs[i].poly);
    for (i = 0; i < W.conns.length; i++) {
      var c = W.conns[i];
      var half = W.lanes[c.from].width / 2;
      if (!pathCovered(g, c, half)) fillRibbon(g, g.road, c.px, c.py, half, half);
    }
  }

  /**
   * Creates the raster and paints land, paths and roads. Sidewalks follow, once they exist.
   * @param {object} W World with connectors built.
   */
  surface._build = function (W) {
    var b = W.bounds;
    var cell = TLV.tune.world.surfaceCell;
    var nx = Math.max(1, Math.ceil((b.maxX - b.minX) / cell));
    var ny = Math.max(1, Math.ceil((b.maxY - b.minY) / cell));
    var g = {
      minX: b.minX,
      minY: b.minY,
      cell: cell,
      nx: nx,
      ny: ny,
      base: new Uint8Array(nx * ny),
      road: new Uint16Array(nx * ny)
    };
    g.base.fill(TLV.const.SURF.SIDEWALK);
    W.index.surface = g;
    paintGround(W, g);
    paintRoads(W, g);
  };

  /**
   * True when a ribbon's whole length is on ground that already reads as sidewalk, as nearly all ribbons are. It looks often
   * enough along the ribbon not to miss a river under a bridge.
   * @returns {boolean}
   */
  function onPlainGround(g, s, value) {
    var step = PLAIN_CHECK_M;
    for (var i = 0; i + 1 < s.px.length; i++) {
      var dx = s.px[i + 1] - s.px[i];
      var dy = s.py[i + 1] - s.py[i];
      var n = Math.ceil(Math.sqrt(dx * dx + dy * dy) / step);
      // Past the first span, its start is the last span's end.
      for (var k = i === 0 ? 0 : 1; k <= n; k++) {
        var cx = Math.floor((s.px[i] + dx * k / n - g.minX) / g.cell);
        var cy = Math.floor((s.py[i] + dy * k / n - g.minY) / g.cell);
        if (cx >= 0 && cy >= 0 && cx < g.nx && cy < g.ny && g.base[cy * g.nx + cx] !== value) return false;
      }
    }
    return true;
  }

  /**
   * Paints sidewalks into the base layer.
   * @param {object} W World with sidewalks built.
   */
  surface._paintSidewalks = function (W) {
    var g = W.index.surface;
    var value = TLV.const.SURF.SIDEWALK;
    for (var i = 0; i < W.sidewalks.length; i++) {
      var s = W.sidewalks[i];
      if (onPlainGround(g, s, value)) continue;
      stampRibbon(g, s.px, s.py, s.width / 2, value);
    }
  };

  /** @returns {boolean} True when the mask marks the sub-cell holding a point. */
  function marked(g, mask, x, y) {
    var u = g.cell / SUB;
    var sx = Math.floor((x - g.minX) / u);
    var sy = Math.floor((y - g.minY) / u);
    if (sx < 0 || sy < 0 || sx >= g.nx * SUB || sy >= g.ny * SUB) return false;
    return (mask[(sy >> 2) * g.nx + (sx >> 2)] & (1 << (((sy & 3) << 2) | (sx & 3)))) !== 0;
  }

  /** @returns {object} The surface raster, for a caller reading many points through surface._markedAt. */
  surface._grid = function (W) {
    return W.index.surface;
  };

  /** surface._isRoad without the walk to the raster. */
  surface._markedAt = function (g, x, y) {
    return marked(g, g.road, x, y);
  };

  /**
   * True when a point is on road.
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @returns {boolean}
   */
  surface._isRoad = function (W, x, y) {
    return marked(W.index.surface, W.index.surface.road, x, y);
  };

  /**
   * Surface at a point. Outside the bounds, the nearest cell answers.
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @returns {number} SURF.*
   */
  surface.at = function (W, x, y) {
    var g = W.index.surface;
    var u = g.cell / SUB;
    var maxX = g.nx * SUB - 1;
    var maxY = g.ny * SUB - 1;
    var sx = Math.floor((x - g.minX) / u);
    var sy = Math.floor((y - g.minY) / u);
    sx = sx < 0 ? 0 : (sx > maxX ? maxX : sx);
    sy = sy < 0 ? 0 : (sy > maxY ? maxY : sy);
    var c = (sy >> 2) * g.nx + (sx >> 2);
    if (g.road[c] & (1 << (((sy & 3) << 2) | (sx & 3)))) return TLV.const.SURF.ROAD;
    return g.base[c];
  };
})(window.TLV);
