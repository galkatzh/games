// js/render/roads.js — WP-RENDER
// Fills a chunk's ground buffer from the map: paved streets, carriageways, sidewalks, lane paint, zebra crossings, painted
// curbs. Emission order is painter's order. Everything comes from W; nothing here reads the sim.
(function (TLV) {
  'use strict';

  var roads = TLV.ns('render.roads');

  var sx = new Float32Array(4096);
  var sy = new Float32Array(4096);
  var ss = new Float32Array(4096);
  var trims = null;
  var ptScratch = { x: 0, y: 0, h: 0 };
  var walkOf = null;
  var medians = null;
  var otherAt = { W: null, I: null };     // The indexes below, one W each. A WeakMap read per kerb sample shows up in the profile
  var walkAt = { W: null, I: null };
  var clears = null;
  var aprons = null;
  var pavedGrids = new WeakMap();
  var walkGrids = new WeakMap();
  var scratchIds = [];
  var stripCache = new WeakMap();
  var GRID_M = 32;
  var CURB_STEP = 128;  // Kerb samples read in one build step
  var OTHER_CELL = 8;   // Cell of the carriageway index, which is read at every kerb sample
  var WALK_CELL = 12;   // Cell of the sidewalk index, which is read at every step of a garden wall
  var GRID_PAD = 128;   // Flat grids run this far past the map, as far as anything is filed
  var walkHit = { sw: -1, d: 0 };
  var walkReads = 0;
  var hitOut = { t: 0, edge: -1, ux: 0, uy: 0 };
  var nearOut = { s: 0, d: 0 };

  /** Point-in-polygon on a flat x,y array. */
  function inPoly(x, y, r) {
    var c = false;
    var n = r.length >> 1;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var yi = r[i * 2 + 1], yj = r[j * 2 + 1];
      if ((yi > y) !== (yj > y) && x < (r[j * 2] - r[i * 2]) * (y - yi) / (yj - yi) + r[i * 2]) c = !c;
    }
    return c;
  }

  /**
   * Copies the stretch s0..s1 of a polyline into the scratch arrays.
   * @returns {number} Points written.
   */
  function slice(px, py, cum, s0, s1) {
    var n = px.length;
    var m = 0;
    var i = 0;
    while (i < n - 2 && cum[i + 1] <= s0) i++;
    var seg = cum[i + 1] - cum[i];
    var t = seg > 0 ? (s0 - cum[i]) / seg : 0;
    sx[m] = px[i] + (px[i + 1] - px[i]) * t;
    sy[m] = py[i] + (py[i + 1] - py[i]) * t;
    ss[m] = s0;
    m++;
    for (var k = i + 1; k < n && cum[k] < s1 && m < sx.length - 1; k++) {
      if (cum[k] <= s0) continue;
      sx[m] = px[k];
      sy[m] = py[k];
      ss[m] = cum[k];
      m++;
    }
    var j = Math.min(i, n - 2);
    while (j < n - 2 && cum[j + 1] < s1) j++;
    var seg2 = cum[j + 1] - cum[j];
    var t2 = seg2 > 0 ? Math.min(1, (s1 - cum[j]) / seg2) : 0;
    sx[m] = px[j] + (px[j + 1] - px[j]) * t2;
    sy[m] = py[j] + (py[j + 1] - py[j]) * t2;
    ss[m] = s1;
    m++;
    return m;
  }

  /** Arc distance from an edge's end at which its kerb on this side leaves the junction polygon. */
  function kerbTrim(W, e, side, atEnd) {
    var key = e.id * 4 + side * 2 + (atEnd ? 1 : 0);
    var got = trims[key];
    if (got === got) return got;       // Not NaN: worked out already
    var J = W.juncs[atEnd ? e.b : e.a];
    var off = side === 0 ? e.kerbOffL : e.kerbOffR;
    var sign = side === 0 ? 1 : -1;
    var res = 0;
    if (J && J.poly && J.poly.length >= 6) {
      var n = e.px.length;
      var limit = Math.min(e.len * 0.5, 40);
      var i = atEnd ? n - 2 : 0;
      var run = 0;
      var done = false;
      while (!done && i >= 0 && i < n - 1) {
        var ax = e.px[i], ay = e.py[i], bx = e.px[i + 1], by = e.py[i + 1];
        var dx = bx - ax, dy = by - ay;
        var L = Math.sqrt(dx * dx + dy * dy);
        if (L > 1e-5) {
          var nx = -dy / L * sign, ny = dx / L * sign;
          for (var d = 0; d < L; d += 1) {
            var t = atEnd ? 1 - d / L : d / L;
            var qx = ax + dx * t + nx * off, qy = ay + dy * t + ny * off;
            if (run + d > limit || !inPoly(qx, qy, J.poly)) {
              res = run + d;
              done = true;
              break;
            }
          }
          if (!done) run += L;
        }
        i += atEnd ? -1 : 1;
      }
      if (!done) res = limit;
    }
    trims[key] = res;
    return res;
  }

  /** Curb: a low face toward the road and a sloped top, from a kerb row. */
  function curbRow(buf, W, k, cols, mats) {
    var e = W.edges[k.edge];
    var side = k.side;
    if ((side === 0 ? e.swL : e.swR) <= 0) return;
    curbLine(buf, W, e, side, k.s0, k.s1, cols, mats[k.paint] === undefined ? mats[0] : mats[k.paint]);
  }

  /**
   * A grid of integer lists in two typed arrays, made in two passes. The kerb and garden loops read these once a sample, and this
   * is the difference between one array read and a dozen hash lookups.
   * @param {object} W World.
   * @param {number} cell Metres.
   * @param {number} count Items.
   * @param {function(number, number[]):void} box Writes an item's box as x0, y0, x1, y1.
   * @param {function(number, number, number):boolean} [keep] Asked with a cell's centre: false leaves the item out of a cell of its box.
   * @returns {{cell:number,ox:number,oy:number,nx:number,ny:number,start:Int32Array,items:Int32Array}} The grid.
   */
  function flatGrid(W, cell, count, box, keep) {
    var b = W.bounds;
    var ox = Math.floor((b.minX - GRID_PAD) / cell), oy = Math.floor((b.minY - GRID_PAD) / cell);
    var nx = Math.ceil((b.maxX + GRID_PAD) / cell) - ox, ny = Math.ceil((b.maxY + GRID_PAD) / cell) - oy;
    var start = new Int32Array(nx * ny + 1);
    var pairs = new Int32Array(Math.max(1024, count * 8));     // cell, item
    var n = 0;
    var r = [0, 0, 0, 0];
    for (var i = 0; i < count; i++) {
      box(i, r);
      var cx0 = Math.max(0, Math.floor(r[0] / cell) - ox), cx1 = Math.min(nx - 1, Math.floor(r[2] / cell) - ox);
      var cy0 = Math.max(0, Math.floor(r[1] / cell) - oy), cy1 = Math.min(ny - 1, Math.floor(r[3] / cell) - oy);
      for (var cy = cy0; cy <= cy1; cy++) {
        for (var cx = cx0; cx <= cx1; cx++) {
          if (keep && !keep(i, (cx + ox + 0.5) * cell, (cy + oy + 0.5) * cell)) continue;
          if (n === pairs.length) {
            var more = new Int32Array(n * 2);
            more.set(pairs);
            pairs = more;
          }
          pairs[n] = cy * nx + cx;
          pairs[n + 1] = i;
          n += 2;
          start[cy * nx + cx + 1]++;
        }
      }
    }
    for (var c = 0; c < nx * ny; c++) start[c + 1] += start[c];
    var items = new Int32Array(n >> 1);
    var fill = start.slice();
    for (var k = 0; k < n; k += 2) items[fill[pairs[k]]++] = pairs[k + 1];
    return { cell: cell, ox: ox, oy: oy, nx: nx, ny: ny, start: start, items: items };
  }

  /** @returns {number} Cell of a point on a flat grid, or -1 off it. */
  function flatCell(g, x, y) {
    var cx = Math.floor(x / g.cell) - g.ox, cy = Math.floor(y / g.cell) - g.oy;
    return cx < 0 || cy < 0 || cx >= g.nx || cy >= g.ny ? -1 : cy * g.nx + cx;
  }

  /** Metres from a point to a segment, squared, by the arithmetic of TLV.math.polyProject, so distances come out the same to the bit. */
  function segDist2(ax, ay, dx, dy, x, y) {
    var ex = x - ax, ey = y - ay;
    var len2 = dx * dx + dy * dy;
    var t = len2 > 0 ? (ex * dx + ey * dy) / len2 : 0;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    var qx = ex - dx * t, qy = ey - dy * t;
    return qx * qx + qy * qy;
  }

  /**
   * What onOtherRoad reads, made once at load. Junction polygons and connector ribbons are filed by their boxes on the 32 m cells.
   * Carriageway segments are filed only under cells they can reach, kerb plus the most a caller can ask past it, and a box in the
   * tables lets a sample pass over a polygon or a connector without reading its outline.
   * @param {object} W World.
   * @returns {object} { juncs, conns, segs, rays, jbox, cbox, tab, edgeOf, solo }. tab: px, py, dx, dy, LL, sqrt LL, kerbOffL, kerbOffR by
   *   segment. solo: per cell of segs, see below.
   */
  function otherIndex(W) {
    return otherAt.W === W ? otherAt.I : makeOtherIndex(W);
  }

  /** The build of otherIndex, apart from it: functions declared in here would be made again on every read. */
  function makeOtherIndex(W) {
    var C = TLV.tune.render.clutter;
    var past = C.kerbPadM + 0.01;     // clearSpot asks past the kerb by the item's radius and this
    Object.keys(C.radius).forEach(function (m) { past = Math.max(past, C.radius[m] + C.kerbPadM + 0.01); });
    var i, k;
    function boxOf(xs, ys, stride, out, at) {
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (var n = 0; n < xs.length; n += stride) {
        x0 = Math.min(x0, xs[n]);
        x1 = Math.max(x1, xs[n]);
        y0 = Math.min(y0, ys[stride === 2 ? n + 1 : n]);
        y1 = Math.max(y1, ys[stride === 2 ? n + 1 : n]);
      }
      out[at] = x0;
      out[at + 1] = y0;
      out[at + 2] = x1;
      out[at + 3] = y1;
    }
    var jids = [], cids = [];
    var jbox = new Float64Array(W.juncs.length * 4);
    var cbox = new Float64Array(W.conns.length * 5);
    for (i = 0; i < W.juncs.length; i++) {
      var P = W.juncs[i].poly;
      if (!P || P.length < 6) continue;
      jids.push(i);
      boxOf(P, P, 2, jbox, i * 4);
    }
    for (i = 0; i < W.conns.length; i++) {
      var cn = W.conns[i];
      if (cn.px.length < 3) continue;      // fill paints no shorter one
      cids.push(i);
      boxOf(cn.px, cn.py, 1, cbox, i * 5);
      cbox[i * 5 + 4] = connHalf(W, cn);
    }
    var juncs = flatGrid(W, GRID_M, jids.length, function (n, r) {
      for (k = 0; k < 4; k++) r[k] = jbox[jids[n] * 4 + k];
    });
    var conns = flatGrid(W, GRID_M, cids.length, function (n, r) {
      for (k = 0; k < 4; k++) r[k] = cbox[cids[n] * 5 + k] + (k < 2 ? -3 : 3);
    });
    juncs.items = juncs.items.map(function (n) { return jids[n]; });
    conns.items = conns.items.map(function (n) { return cids[n]; });
    var total = 0;
    for (i = 0; i < W.edges.length; i++) total += W.edges[i].px.length - 1;
    var tab = new Float64Array(total * 8);
    var edgeOf = new Int32Array(total);
    var n = 0;
    for (i = 0; i < W.edges.length; i++) {
      var e = W.edges[i];
      for (k = 0; k + 1 < e.px.length; k++) {
        var dx = e.px[k + 1] - e.px[k], dy = e.py[k + 1] - e.py[k];
        var LL = dx * dx + dy * dy;
        var at = n * 8;
        tab[at] = e.px[k];
        tab[at + 1] = e.py[k];
        tab[at + 2] = dx;
        tab[at + 3] = dy;
        tab[at + 4] = LL;
        tab[at + 5] = Math.sqrt(LL);
        tab[at + 6] = e.kerbOffL;
        tab[at + 7] = e.kerbOffR;
        edgeOf[n++] = i;
      }
    }
    var half = OTHER_CELL * Math.SQRT1_2;
    function reachOf(o) {
      return Math.max(tab[o * 8 + 6], tab[o * 8 + 7]) + past;
    }
    var segs = flatGrid(W, OTHER_CELL, n, function (o, r) {
      var at2 = o * 8;
      var R = reachOf(o);
      r[0] = Math.min(tab[at2], tab[at2] + tab[at2 + 2]) - R;
      r[1] = Math.min(tab[at2 + 1], tab[at2 + 1] + tab[at2 + 3]) - R;
      r[2] = Math.max(tab[at2], tab[at2] + tab[at2 + 2]) + R;
      r[3] = Math.max(tab[at2 + 1], tab[at2 + 1] + tab[at2 + 3]) + R;
    }, function (o, x, y) {
      var R = reachOf(o) + half + 0.01;
      return tab[o * 8 + 4] >= 1e-6 && segDist2(tab[o * 8], tab[o * 8 + 1], tab[o * 8 + 2], tab[o * 8 + 3], x, y) <= R * R;
    });
    // Rays walk across cells, so segments are filed where they lie, in map order: a tie goes to the first found.
    var rays = flatGrid(W, GRID_M, n, function (o, r) {
      var at2 = o * 8;
      r[0] = Math.min(tab[at2], tab[at2] + tab[at2 + 2]);
      r[1] = Math.min(tab[at2 + 1], tab[at2 + 1] + tab[at2 + 3]);
      r[2] = Math.max(tab[at2], tab[at2] + tab[at2 + 2]);
      r[3] = Math.max(tab[at2 + 1], tab[at2 + 1] + tab[at2 + 3]);
    });
    // A cell of one edge's carriageway with no polygon or connector near it: that edge's kerb has nothing to read there.
    var solo = new Int32Array(segs.nx * segs.ny);        // 0 nothing near, e + 1 only edge e, -1 anything else
    var margin = TLV.tune.render.kerbCut.marginM;
    for (i = 0; i < solo.length; i++) {
      var mx = (i % segs.nx + segs.ox + 0.5) * segs.cell, my = (Math.floor(i / segs.nx) + segs.oy + 0.5) * segs.cell;
      for (k = segs.start[i]; k < segs.start[i + 1]; k++) {
        var o = segs.items[k];
        var far = Math.max(tab[o * 8 + 6], tab[o * 8 + 7]) - margin + half + 0.01;      // As far as a kerb's own test reaches
        if (far > 0 && segDist2(tab[o * 8], tab[o * 8 + 1], tab[o * 8 + 2], tab[o * 8 + 3], mx, my) > far * far) continue;
        var one = edgeOf[o] + 1;
        solo[i] = solo[i] === 0 || solo[i] === one ? one : -1;
      }
    }
    function busy(x0, y0, x1, y1) {
      var cx0 = Math.max(0, Math.floor(x0 / segs.cell) - segs.ox), cx1 = Math.min(segs.nx - 1, Math.floor(x1 / segs.cell) - segs.ox);
      var cy0 = Math.max(0, Math.floor(y0 / segs.cell) - segs.oy), cy1 = Math.min(segs.ny - 1, Math.floor(y1 / segs.cell) - segs.oy);
      for (var cy = cy0; cy <= cy1; cy++) solo.fill(-1, cy * segs.nx + cx0, cy * segs.nx + cx1 + 1);
    }
    for (i = 0; i < jids.length; i++) busy(jbox[jids[i] * 4], jbox[jids[i] * 4 + 1], jbox[jids[i] * 4 + 2], jbox[jids[i] * 4 + 3]);
    for (i = 0; i < cids.length; i++) {
      var ln = W.conns[cids[i]];
      var hw = cbox[cids[i] * 5 + 4];
      for (k = 0; k + 1 < ln.px.length; k++) {
        busy(Math.min(ln.px[k], ln.px[k + 1]) - hw, Math.min(ln.py[k], ln.py[k + 1]) - hw, Math.max(ln.px[k], ln.px[k + 1]) + hw, Math.max(ln.py[k], ln.py[k + 1]) + hw);
      }
    }
    otherAt.W = W;
    otherAt.I = { juncs: juncs, conns: conns, segs: segs, rays: rays, jbox: jbox, cbox: cbox, tab: tab, edgeOf: edgeOf, solo: solo };
    return otherAt.I;
  }

  /**
   * @returns {boolean} True when a point is inside a flat polygon by more than a margin, so its own rim does not count. A negative
   *   margin asks the opposite: true inside, and within that distance outside too.
   */
  function deepInPoly(x, y, r, margin) {
    var inside = inPoly(x, y, r);
    if (!inside && margin >= 0) return false;
    var n = r.length >> 1;
    var least = Infinity;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var ax = r[j * 2], ay = r[j * 2 + 1];
      var dx = r[i * 2] - ax, dy = r[i * 2 + 1] - ay;
      var LL = dx * dx + dy * dy;
      var t = LL > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / LL)) : 0;
      var ex = ax + dx * t - x, ey = ay + dy * t - y;
      least = Math.min(least, ex * ex + ey * ey);
    }
    return margin >= 0 ? least >= margin * margin : inside || least < margin * margin;
  }

  /** @returns {number} Half width of a connector's asphalt, as roads.fill draws it. */
  function connHalf(W, cn) {
    var lane = W.lanes[cn.from];
    return (lane ? lane.width : 3) / 2 + 0.25;
  }

  /**
   * True when a point lies on road surface other than its own, more than a margin in from that surface's edge. A kerb at such
   * a point is a painted ribbon across somebody's lane: two carriageways leaving a fork lie over each other until they part.
   * @param {object} W World.
   * @param {number} x World x.
   * @param {number} y World y.
   * @param {number} selfEdge Edge whose carriageway does not count, or -1.
   * @param {number} selfJunc Junction whose polygon does not count, or -1.
   * @param {?number[]} arms Further edges that do not count, or null.
   * @param {number} [pad] Margin in metres, in place of the kerb's. Negative reaches past the edge of the road.
   * @returns {boolean} True on another road.
   */
  function onOtherRoad(W, x, y, selfEdge, selfJunc, arms, pad) {
    var margin = pad === undefined ? TLV.tune.render.kerbCut.marginM : pad;
    var I = otherIndex(W);
    var k, id;
    // Past a polygon's box by the margin it asks for, a point cannot be in it, and the same goes for a connector's reach.
    var out = margin < 0 ? -margin : 0;
    var g = I.juncs;
    var c = flatCell(g, x, y);
    if (c >= 0) {
      var box = I.jbox;
      for (k = g.start[c]; k < g.start[c + 1]; k++) {
        id = g.items[k];
        var b4 = id * 4;
        if (id === selfJunc || x < box[b4] - out || y < box[b4 + 1] - out || x > box[b4 + 2] + out || y > box[b4 + 3] + out) continue;
        if (deepInPoly(x, y, W.juncs[id].poly, margin)) return true;
      }
    }
    g = I.segs;
    c = flatCell(g, x, y);
    if (c >= 0) {
      var tab = I.tab;
      var edgeOf = I.edgeOf;
      for (k = g.start[c]; k < g.start[c + 1]; k++) {
        var o = g.items[k];
        id = edgeOf[o];
        if (id === selfEdge || (arms && arms.indexOf(id) >= 0)) continue;
        var at = o * 8;
        var px = tab[at], py = tab[at + 1], dx = tab[at + 2], dy = tab[at + 3];
        var t = ((x - px) * dx + (y - py) * dy) / tab[at + 4];
        if (t < 0 || t > 1) continue;
        var left = (-dy * (x - px - dx * t) + dx * (y - py - dy * t)) / tab[at + 5];
        if (Math.abs(left) < (left >= 0 ? tab[at + 6] : tab[at + 7]) - margin) return true;
      }
    }
    g = I.conns;
    c = flatCell(g, x, y);
    if (c < 0) return false;
    var cbox = I.cbox;
    for (k = g.start[c]; k < g.start[c + 1]; k++) {
      id = g.items[k];
      var b5 = id * 5;
      var far = cbox[b5 + 4] - margin;
      if (x < cbox[b5] - far || y < cbox[b5 + 1] - far || x > cbox[b5 + 2] + far || y > cbox[b5 + 3] + far) continue;
      var cn = W.conns[id];
      var q = TLV.math.polyProject(cn.px, cn.py, cn.cum, x, y, -1, nearOut);
      if (q && nearOut.d < far) return true;
    }
    return false;
  }

  /**
   * Works out the stretches of one kerb that are clear of every other road, and caches them. This reads the whole edge every half
   * metre, so it is the largest single piece of a chunk's build: a generator, so a long edge does not cost one frame the lot.
   * @param {object} W World.
   * @param {object} e Edge.
   * @param {number} side 0 left, 1 right.
   */
  function* curbClearSteps(W, e, side) {
    var K = TLV.tune.render.kerbCut;
    var count = Math.max(1, Math.ceil(e.len / K.stepM));
    var run = { seg: 0, from: -1, last: 0, got: [] };
    for (var q = 0; q <= count; q += CURB_STEP) {
      if (q) yield;
      curbClearRun(W, e, side, run, q, Math.min(count, q + CURB_STEP - 1), count, K.minRunM);
    }
    if (run.from >= 0 && run.last - run.from >= K.minRunM) run.got.push(run.from, run.last);
    clears[e.id * 2 + side] = run.got;
  }

  /** Reads kerb samples q0 to q1, carrying the open stretch in run. A plain function, so the samples box no numbers in a generator. */
  function curbClearRun(W, e, side, run, q0, q1, count, minRun) {
    var I = otherIndex(W);
    var off = side === 0 ? e.kerbOffL : e.kerbOffR;
    var sign = side === 0 ? 1 : -1;
    var n = e.px.length;
    var mine = e.id + 1;
    var grid = I.segs, solo = I.solo;
    var seg = run.seg, from = run.from, last = run.last;
    for (var q = q0; q <= q1; q++) {
      var s = e.len * q / count;
      while (seg < n - 2 && e.cum[seg + 1] < s) seg++;
      var dx = e.px[seg + 1] - e.px[seg], dy = e.py[seg + 1] - e.py[seg];
      var L = Math.sqrt(dx * dx + dy * dy);
      if (L < 1e-5) continue;
      var f = (s - e.cum[seg]) / L;
      var x = e.px[seg] + dx * f - dy / L * sign * off, y = e.py[seg] + dy * f + dx / L * sign * off;
      var c = flatCell(grid, x, y);
      var only = c < 0 ? 0 : solo[c];
      if (only !== 0 && only !== mine && onOtherRoad(W, x, y, e.id, -1, null)) {
        if (from >= 0 && last - from >= minRun) run.got.push(from, last);
        from = -1;
      } else {
        if (from < 0) from = s;
        last = s;
      }
    }
    run.seg = seg;
    run.from = from;
    run.last = last;
  }

  /** @returns {number[]} s0, s1 pairs, in order: the clear stretches of a kerb, worked out now if nothing has yet. */
  function curbClear(W, e, side) {
    var key = e.id * 2 + side;
    if (!clears[key]) {
      var it = curbClearSteps(W, e, side);
      while (!it.next().done);
    }
    return clears[key];
  }

  /** Curb along one side of an edge, between two arc lengths, stopping at the junctions and wherever another road takes over. */
  function curbLine(buf, W, e, side, from, to, cols, mat) {
    var s0 = Math.max(from, kerbTrim(W, e, side, false));
    var s1 = Math.min(to, e.len - kerbTrim(W, e, side, true));
    var clear = curbClear(W, e, side);
    for (var i = 0; i + 1 < clear.length; i += 2) {
      var a = Math.max(s0, clear[i]), b = Math.min(s1, clear[i + 1]);
      if (b - a >= 0.3) curbRun(buf, e, side, a, b, cols, mat);
    }
  }

  /** One unbroken stretch of curb. */
  function curbRun(buf, e, side, s0, s1, cols, mat) {
    var T = TLV.tune.render;
    var n = slice(e.px, e.py, e.cum, s0, s1);
    var off = side === 0 ? e.kerbOffL : e.kerbOffR;
    var H = T.curbHeightM;
    var W2 = T.curbTopM;
    var Tz = T.curbTopFall;
    // Offset polyline, by segment normals.
    var sign = side === 0 ? 1 : -1;
    var prevX = 0, prevY = 0, prevTX = 0, prevTY = 0, prevU = 0;
    var started = false;     // A slice can open on two equal points. Nothing draws until one point has really been placed
    for (var i = 0; i < n; i++) {
      var ix0 = i > 0 ? i - 1 : 0, ix1 = i < n - 1 ? i + 1 : n - 1;
      var dx = sx[ix1] - sx[ix0], dy = sy[ix1] - sy[ix0];
      var L = Math.sqrt(dx * dx + dy * dy);
      if (L < 1e-5) continue;
      var nx = -dy / L * sign, ny = dx / L * sign;
      var kx = sx[i] + nx * off, ky = sy[i] + ny * off;
      var tx = kx + nx * W2, ty = ky + ny * W2;
      var u = ss[i];
      if (started) {
        // Winding matters, the material is one-sided: the face looks at the road and the top looks up.
        if (sign > 0) {
          buf.quad(prevX, prevY, 0, prevU, 1, kx, ky, 0, u, 1, kx, ky, H, u, 1, prevX, prevY, H, prevU, 1, cols.face, mat);
          buf.quad(prevX, prevY, H, prevU, 0, kx, ky, H, u, 0, tx, ty, H * Tz, u, 0, prevTX, prevTY, H * Tz, prevU, 0, cols.top, mat);
        } else {
          buf.quad(kx, ky, 0, u, 1, prevX, prevY, 0, prevU, 1, prevX, prevY, H, prevU, 1, kx, ky, H, u, 1, cols.face, mat);
          buf.quad(kx, ky, H, u, 0, prevX, prevY, H, prevU, 0, prevTX, prevTY, H * Tz, prevU, 0, tx, ty, H * Tz, u, 0, cols.top, mat);
        }
      }
      prevX = kx; prevY = ky; prevTX = tx; prevTY = ty; prevU = u;
      started = true;
    }
  }

  /** Bars parallel to traffic, across one lane of a crossing. */
  function zebra(buf, W, z, col, MAT) {
    var L = W.lanes[z.laneId];
    if (!L) return;
    var s = (z.s0 + z.s1) / 2;
    var half = Math.max(1.2, (z.s1 - z.s0) / 2);
    var p = TLV.world.lanes.pointAt(W, z.laneId, Math.min(L.len, Math.max(0, s)), ptScratch);
    var c = Math.cos(p.h), sn = Math.sin(p.h);
    var lx = -sn, ly = c;           // Left of travel
    var de = W.dirEdges[L.dirEdge];
    var e = W.edges[L.edge];
    var w = L.width;
    var fwd = de ? de.dir === 0 : true;
    var extR = L.idx === 0 ? (fwd ? e.parkR : e.parkL) : 0;
    var oneWay = e.lanesB === 0;
    var extL = oneWay && L.left < 0 ? (fwd ? e.parkL : e.parkR) : 0;
    var from = -w / 2 - extR;
    var to = w / 2 + extL;
    var pitch = 1.1;
    var bar = 0.55;
    var count = Math.max(1, Math.floor((to - from) / pitch));
    var start = (from + to) / 2 - (count * pitch - (pitch - bar)) / 2;
    for (var i = 0; i < count; i++) {
      var a = start + i * pitch;
      var b = a + bar;
      var ax = p.x + lx * a - c * half, ay = p.y + ly * a - sn * half;
      var bx = p.x + lx * a + c * half, by = p.y + ly * a + sn * half;
      var cx = p.x + lx * b + c * half, cy = p.y + ly * b + sn * half;
      var dx = p.x + lx * b - c * half, dy = p.y + ly * b - sn * half;
      buf.quad(ax, ay, 0, 0, 0, bx, by, 0, 0, 0, cx, cy, 0, 0, 0, dx, dy, 0, 0, 0, col, MAT.ZEBRA);
    }
  }

  /** Stop line across a lane, behind any crossing at its end. */
  function stopLine(buf, W, L, col, MAT) {
    var de = W.dirEdges[L.dirEdge];
    if (!de) return;
    var J = W.juncs[de.to];
    if (!J || J.kind === 'PASS' || J.kind === 'RING' || (J.flags & 1)) return;
    var at = L.len - 0.3;
    for (var i = 0; i < L.zones.length; i++) {
      var z = W.zones[L.zones[i]];
      if (z.s1 > L.len - 8 && z.s0 - 1.2 < at) at = z.s0 - 1.2;
    }
    if (at < 1) return;
    var T = TLV.tune.render;
    var p = TLV.world.lanes.pointAt(W, L.id, at, ptScratch);
    var c = Math.cos(p.h), sn = Math.sin(p.h);
    var lx = -sn * L.width / 2, ly = c * L.width / 2;
    var hw = T.stopLineM / 2;
    buf.quad(p.x - lx - c * hw, p.y - ly - sn * hw, 0, 0, 0, p.x - lx + c * hw, p.y - ly + sn * hw, 0, 0, 0,
      p.x + lx + c * hw, p.y + ly + sn * hw, 0, 0, 0, p.x + lx - c * hw, p.y + ly - sn * hw, 0, 0, 0, col, MAT.ZEBRA);
  }

  /** Convex hull, monotone chain. @param {number[]} p x,y pairs. @returns {number[]} x,y pairs, counter-clockwise. */
  function hull(p) {
    var n = p.length >> 1;
    var ids = [];
    for (var i = 0; i < n; i++) ids.push(i);
    ids.sort(function (a, b) { return p[a * 2] - p[b * 2] || p[a * 2 + 1] - p[b * 2 + 1]; });
    function cross(o, a, b) {
      return (p[a * 2] - p[o * 2]) * (p[b * 2 + 1] - p[o * 2 + 1]) - (p[a * 2 + 1] - p[o * 2 + 1]) * (p[b * 2] - p[o * 2]);
    }
    var h = [];
    for (var k = 0; k < n; k++) {
      while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], ids[k]) <= 0) h.pop();
      h.push(ids[k]);
    }
    var lower = h.length + 1;
    for (var q = n - 2; q >= 0; q--) {
      while (h.length >= lower && cross(h[h.length - 2], h[h.length - 1], ids[q]) <= 0) h.pop();
      h.push(ids[q]);
    }
    h.pop();
    var out = [];
    for (var o = 0; o < h.length; o++) out.push(p[h[o] * 2], p[h[o] * 2 + 1]);
    return out;
  }

  /** The edges meeting at a junction, each once. */
  function armsOf(W, J) {
    var out = [];
    [J.inDir, J.outDir].forEach(function (list) {
      for (var i = 0; i < list.length; i++) {
        var de = W.dirEdges[list[i]];
        if (de && out.indexOf(de.edge) < 0) out.push(de.edge);
      }
    });
    return out;
  }

  /**
   * The paved apron of a junction: everything out to the back of the sidewalks that meet there. It is painted under the
   * carriageways, so what stays in view is the corner, carried round to the curb return.
   * @returns {number[]} Hull, x,y pairs. Empty when no sidewalk reaches this junction.
   */
  function apronOf(W, J) {
    var pts = Array.prototype.slice.call(J.poly);
    var arms = armsOf(W, J);
    var reach = 40;
    var some = false;
    for (var a = 0; a < arms.length; a++) {
      for (var side = 0; side < 2; side++) {
        var id = walkOf.get(arms[a] * 2 + side);
        if (id === undefined) continue;
        var sw = W.sidewalks[id];
        var n = sw.px.length;
        if (n < 2) continue;
        var d0 = Math.hypot(sw.px[0] - J.x, sw.py[0] - J.y);
        var d1 = Math.hypot(sw.px[n - 1] - J.x, sw.py[n - 1] - J.y);
        var i0 = d0 <= d1 ? 0 : n - 1;
        var i1 = d0 <= d1 ? 1 : n - 2;
        if (Math.min(d0, d1) > reach) continue;
        var dx = sw.px[i1] - sw.px[i0], dy = sw.py[i1] - sw.py[i0];
        var L = Math.sqrt(dx * dx + dy * dy) || 1;
        var hw = sw.width / 2;
        pts.push(sw.px[i0] - dy / L * hw, sw.py[i0] + dx / L * hw, sw.px[i0] + dy / L * hw, sw.py[i0] - dx / L * hw);
        some = true;
      }
    }
    return some ? hull(pts) : [];
  }

  /** @returns {number[]} A junction's apron, from the cache. */
  function apronCached(W, j) {
    var got = aprons.get(j);
    if (!got) aprons.set(j, got = apronOf(W, W.juncs[j]));
    return got;
  }

  /** @returns {boolean} True when a point on a junction's outline lies across one of its arms, not on a corner. */
  function acrossArm(W, J, arms, x, y) {
    for (var a = 0; a < arms.length; a++) {
      var e = W.edges[arms[a]];
      var q = TLV.math.polyProject(e.px, e.py, e.cum, x, y, -1, nearOut);
      if (!q) continue;
      var i = 0;
      var s = nearOut.s;
      while (i < e.px.length - 2 && e.cum[i + 1] < s) i++;
      var dx = e.px[i + 1] - e.px[i], dy = e.py[i + 1] - e.py[i];
      var L = Math.sqrt(dx * dx + dy * dy) || 1;
      var left = (-dy * (x - e.px[i]) + dx * (y - e.py[i])) / L;
      var off = (left >= 0 ? e.kerbOffL : e.kerbOffR) - 0.3;
      if (Math.abs(left) < off && nearOut.d < off + 0.5) return true;
    }
    return false;
  }

  /** Curb round a junction's corners, joining the kerb rows of its arms. */
  function curbReturn(buf, W, J, cols, mat) {
    var T = TLV.tune.render;
    var p = J.poly;
    var n = p.length >> 1;
    if (n < 3) return;
    var arms = armsOf(W, J);
    var H = T.curbHeightM;
    var Tz = T.curbTopFall;
    var run = 0;
    for (var i = 0; i < n; i++) {
      var k = (i + 1) % n;
      var ax = p[i * 2], ay = p[i * 2 + 1], bx = p[k * 2], by = p[k * 2 + 1];
      var dx = bx - ax, dy = by - ay;
      var L = Math.sqrt(dx * dx + dy * dy);
      if (L < 0.3 || L > 40 || acrossArm(W, J, arms, (ax + bx) / 2, (ay + by) / 2)) continue;
      var nx = dy / L, ny = -dx / L;        // CCW polygon: outward is right of travel
      var tx = T.curbTopM * nx, ty = T.curbTopM * ny;
      // A side can reach a neighbouring road, so it is read in short pieces and only the clear ones draw.
      var parts = Math.max(1, Math.ceil(L / 2));
      for (var q = 0; q < parts; q++) {
        var f0 = q / parts, f1 = (q + 1) / parts;
        var u0 = run + L * f0, u1 = run + L * f1;
        var qx = ax + dx * (f0 + f1) / 2, qy = ay + dy * (f0 + f1) / 2;
        if (onOtherRoad(W, qx, qy, -1, J.id, arms)) continue;
        var px = ax + dx * f0, py = ay + dy * f0, ex = ax + dx * f1, ey = ay + dy * f1;
        buf.quad(ex, ey, 0, u0, 1, px, py, 0, u1, 1, px, py, H, u1, 1, ex, ey, H, u0, 1, cols.face, mat);
        buf.quad(px + tx, py + ty, H * Tz, u1, 0, ex + tx, ey + ty, H * Tz, u0, 0, ex, ey, H, u0, 0, px, py, H, u1, 0, cols.top, mat);
      }
      run += L;
    }
  }

  /**
   * First parallel centreline along a ray. A cross street in between is passed over.
   * @param {object} W World.
   * @returns {?object} hitOut: { t, edge, ux, uy }, or null.
   */
  function rayEdge(W, x, y, dx, dy, tx, ty, maxT, self, parallel) {
    var I = otherIndex(W);
    var g = I.rays, tab = I.tab, edgeOf = I.edgeOf;
    var best = Infinity;
    var last = -2;
    for (var t0 = 0; t0 <= maxT + GRID_M / 2; t0 += GRID_M / 2) {
      var c = flatCell(g, x + dx * Math.min(t0, maxT), y + dy * Math.min(t0, maxT));
      if (c === last) continue;
      last = c;
      if (c < 0) continue;
      for (var k = g.start[c]; k < g.start[c + 1]; k++) {
        var o = g.items[k];
        var id = edgeOf[o];
        if (id === self) continue;
        var at = o * 8;
        var L = tab[at + 5];
        if (L < 1e-4) continue;
        var ux = tab[at + 2] / L, uy = tab[at + 3] / L;
        if (Math.abs(ux * tx + uy * ty) < parallel) continue;
        var den = dx * uy - dy * ux;
        if (Math.abs(den) < 1e-6) continue;
        var wx = tab[at] - x, wy = tab[at + 1] - y;
        var t = (wx * uy - wy * ux) / den;
        var u = (wx * dy - wy * dx) / den;
        if (t > 0.01 && t < maxT && t < best && u >= -0.5 && u <= L + 0.5) {
          best = t;
          hitOut.t = t;
          hitOut.edge = id;
          hitOut.ux = ux;
          hitOut.uy = uy;
        }
      }
    }
    return best < Infinity ? hitOut : null;
  }

  /**
   * What lies off one side of an edge, sampled along it: the kerb of a parallel carriageway, across a gap.
   * @param {object} W World.
   * @param {object} e Edge.
   * @param {number} side 0 left, 1 right.
   * @param {number} reach Largest gap, metres.
   * @param {number} step Metres between samples.
   * @returns {object[]} { s, x, y, nx, ny, hx, hy, gap, other, park } in order of s, kerb to kerb.
   */
  function gapRows(W, e, side, reach, step) {
    var T = TLV.tune.render;
    var off = side === 0 ? e.kerbOffL : e.kerbOffR;
    var sign = side === 0 ? 1 : -1;
    var rows = [];
    var count = Math.max(1, Math.ceil(e.len / step));
    var seg = 0;
    var surf = TLV.world.surface;
    var PARK = TLV.const.SURF.PARK;
    var parallel = T.median.parallel;
    for (var q = 0; q <= count; q++) {
      var s = e.len * q / count;
      while (seg < e.px.length - 2 && e.cum[seg + 1] < s) seg++;
      var dx = e.px[seg + 1] - e.px[seg], dy = e.py[seg + 1] - e.py[seg];
      var L = Math.sqrt(dx * dx + dy * dy);
      if (L < 1e-4) continue;
      var tx = dx / L, ty = dy / L;
      var f = (s - e.cum[seg]) / L;
      var x = e.px[seg] + dx * f, y = e.py[seg] + dy * f;
      var nx = -ty * sign, ny = tx * sign;
      var h = rayEdge(W, x, y, nx, ny, tx, ty, off + reach + 12, e.id, parallel);
      if (!h) continue;
      var o = W.edges[h.edge];
      var facingLeft = (-h.uy * -nx + h.ux * -ny) > 0;
      var gap = h.t - off - (facingLeft ? o.kerbOffL : o.kerbOffR);
      if (gap <= 0.05 || gap > reach) continue;
      var d = off + gap / 2;
      if (TLV.world.spatial.pointInBuilding(W, x + nx * d, y + ny * d) >= 0) continue;
      var park = surf.at(W, x + nx * d, y + ny * d) === PARK;
      rows.push({
        s: s, x: x, y: y, nx: nx, ny: ny, gap: gap, other: h.edge, off: off, park: park,
        swA: side === 0 ? e.swL : e.swR, swB: facingLeft ? o.swL : o.swR
      });
    }
    return rows;
  }

  /** @returns {object[]} Median rows of one side of an edge, cached. */
  function medianOf(W, e, side) {
    var key = e.id * 2 + side;
    var got = medians.get(key);
    if (got) return got;
    var M = TLV.tune.render.median;
    got = gapRows(W, e, side, M.maxGapM, M.stepM);
    // Decide by the stretch, not the sample: a gap wandering either side of the limit must not flip every five metres.
    for (var i = 0; i < got.length; i++) {
      var sum = 0;
      var n = 0;
      for (var k = 0; k < got.length; k++) {
        if (Math.abs(got[k].s - got[i].s) > M.settleM) continue;
        sum += got[k].gap;
        n++;
      }
      got[i].raised = sum / n > M.asphaltM;
    }
    medians.set(key, got);
    return got;
  }

  /** Quad between two rows, kerb side to kerb side, between fractions of the gap measured from this kerb. Up to the caller to pick. */
  function gapQuad(buf, a, b, f0, f1, col, mat) {
    var a0 = a.off + a.gap * f0, a1 = a.off + a.gap * f1;
    var b0 = b.off + b.gap * f0, b1 = b.off + b.gap * f1;
    var ax = a.x + a.nx * a0, ay = a.y + a.ny * a0, dx = a.x + a.nx * a1, dy = a.y + a.ny * a1;
    var bx = b.x + b.nx * b0, by = b.y + b.ny * b0, cx = b.x + b.nx * b1, cy = b.y + b.ny * b1;
    var area = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    if (area >= 0) buf.quad(ax, ay, 0, 0, 0, bx, by, 0, 0, 0, cx, cy, 0, 0, 0, dx, dy, 0, 0, 0, col, mat);
    else buf.quad(dx, dy, 0, 0, 0, cx, cy, 0, 0, 0, bx, by, 0, 0, 0, ax, ay, 0, 0, 0, col, mat);
  }

  /** Fills the ground between two carriageways. One edge of each pair paints, so nothing paints twice. */
  function medianFill(buf, W, e, cols, MAT) {
    var M = TLV.tune.render.median;
    for (var side = 0; side < 2; side++) {
      var rows = medianOf(W, e, side);
      for (var i = 0; i + 1 < rows.length; i++) {
        var a = rows[i], b = rows[i + 1];
        if (b.s - a.s > M.stepM * 2.1 || a.park || b.park || e.id > a.other) continue;
        var wide = Math.max(a.gap, b.gap);
        // Overshoot into both carriageways, which paint over it, so the fill has no seam against the asphalt.
        if (!a.raised || !b.raised) {
          gapQuad(buf, a, b, -0.4, 1.4, cols.asphalt, MAT.ASPHALT);
          continue;
        }
        gapQuad(buf, a, b, -0.4, 1.4, cols.pave, MAT.PAVING);
        // Sidewalks on the median paint over this later: plant only what they leave clear.
        var clear = wide - a.swA - a.swB - 2 * M.kerbM;
        if (clear >= M.bedM) gapQuad(buf, a, b, (a.swA + M.kerbM) / wide, 1 - (a.swB + M.kerbM) / wide, cols.pave, MAT.BED);
      }
    }
  }

  /** Painted line down a gap closed with asphalt. */
  function medianPaint(buf, W, e, col, MAT) {
    var M = TLV.tune.render.median;
    for (var side = 0; side < 2; side++) {
      var rows = medianOf(W, e, side);
      var m = 0;
      for (var i = 0; i <= rows.length; i++) {
        var r = rows[i];
        var keep = r && !r.park && e.id < r.other && !r.raised && (m === 0 || r.s - rows[i - 1].s <= M.stepM * 2.1);
        if (keep) {
          var d = r.off + r.gap / 2;
          sx[m] = r.x + r.nx * d;
          sy[m] = r.y + r.ny * d;
          m++;
        }
        if (!keep || i === rows.length) {
          if (m >= 2) buf.ribbon(sx, sy, m, M.dividerM * 0.75, M.dividerM * 0.75, 0, col, MAT.LINE);
          m = 0;
          if (r && !r.park && e.id < r.other && !r.raised) {
            var d2 = r.off + r.gap / 2;
            sx[0] = r.x + r.nx * d2;
            sy[0] = r.y + r.ny * d2;
            m = 1;
          }
        }
      }
    }
  }

  /** @returns {boolean} True when medianCurbs will draw on this side, so it will want the kerb's clear stretches. */
  function medianCurbed(W, e, side) {
    if ((side === 0 ? e.swL : e.swR) > 0) return false;
    var rows = medianOf(W, e, side);
    for (var i = 0; i < rows.length; i++) if (rows[i].raised) return true;
    return false;
  }

  /** Curbs along a raised median, on sides with no sidewalk to bring their own. */
  function medianCurbs(buf, W, e, cols, mat) {
    var M = TLV.tune.render.median;
    for (var side = 0; side < 2; side++) {
      if ((side === 0 ? e.swL : e.swR) > 0) continue;
      var rows = medianOf(W, e, side);
      var from = -1, to = -1;
      for (var i = 0; i <= rows.length; i++) {
        var r = rows[i];
        var raised = r && r.raised;
        if (raised && from >= 0 && r.s - to > M.stepM * 2.1) raised = false;
        if (raised) {
          if (from < 0) from = r.s;
          to = r.s;
        } else if (from >= 0) {
          curbLine(buf, W, e, side, from, to, cols, mat);
          from = -1;
          if (r && r.raised) {
            from = to = r.s;
          }
        }
      }
    }
  }

  /**
   * Every curb face the emitters draw, whole map, read back through a recording buffer. For tests and the kerb scan.
   * @param {object} W World.
   * @returns {{x0:number,y0:number,x1:number,y1:number,edge:number,junc:number}[]} One per face quad.
   */
  roads._curbFaces = function (W) {
    var faces = [];
    var edge = -1, junc = -1;
    var cols = { face: 1, top: 2 };
    var rec = {
      quad: function (ax, ay, az, au, av, bx, by, bz, bu, bv, cx, cy, cz, cu, cv, dx, dy, dz, du, dv, col) {
        if (col === 1) faces.push({ x0: ax, y0: ay, x1: bx, y1: by, edge: edge, junc: junc });
      }
    };
    var mats = [0, 0, 0, 0];
    for (var k = 0; k < W.kerbs.length; k++) {
      edge = W.kerbs[k].edge;
      curbRow(rec, W, W.kerbs[k], cols, mats);
    }
    for (var e = 0; e < W.edges.length; e++) {
      edge = e;
      medianCurbs(rec, W, W.edges[e], cols, 0);
    }
    edge = -1;
    for (var j = 0; j < W.juncs.length; j++) {
      junc = j;
      if (W.juncs[j].poly && !(W.juncs[j].flags & 1)) curbReturn(rec, W, W.juncs[j], cols, 0);
    }
    return faces;
  };

  roads._curbClearSteps = curbClearSteps;
  roads._curbClear = curbClear;

  /** @returns {boolean} The kerb test itself, for tests. */
  roads._onOtherRoad = onOtherRoad;

  /** @returns {object[]} Median rows, for tests. */
  roads._medianRows = function (W, e, side) {
    return medianOf(W, e, side);
  };

  /**
   * Long lawns between two carriageways: the spine of a walkway down each, and the trees, benches and kiosks along it.
   * Found from the roads, not the land polygon, because a boulevard bends and its polygon does not say where.
   * @param {object} W World.
   * @returns {object[]} { x, y, half, records }. x, y is the spine; records are detail instances.
   */
  roads.strips = function (W) {
    var got = stripCache.get(W);
    if (got) return got;
    got = [];
    var T = TLV.tune.render;
    var P = T.strip;
    var surf = TLV.world.surface;
    var ROAD = TLV.const.SURF.ROAD;
    for (var id = 0; id < W.edges.length; id++) {
      var e = W.edges[id];
      if (e.lanesB !== 0 || e.len < 12) continue;        // A boulevard is a pair of one-way carriageways
      for (var side = 0; side < 2; side++) {
        var rows = gapRows(W, e, side, P.maxGapM, 4);
        var run = [];
        for (var i = 0; i <= rows.length; i++) {
          var r = rows[i];
          var ok = r && r.park && r.gap >= P.minGapM && e.id < r.other && (!run.length || r.s - run[run.length - 1].s <= 8.5);
          if (ok) run.push(r);
          if (!ok) {
            if (run.length) got.push(run);
            run = [];
            if (r && r.park && r.gap >= P.minGapM && e.id < r.other) run.push(r);
          }
        }
      }
    }
    // Stretches split at every map node: join those that run end to end.
    var chains = [];
    var used = new Uint8Array(got.length);
    for (var a = 0; a < got.length; a++) {
      if (used[a]) continue;
      used[a] = 1;
      var chain = got[a].map(mid);
      var grew = true;
      while (grew) {
        grew = false;
        for (var b = 0; b < got.length; b++) {
          if (used[b]) continue;
          var m = got[b].map(mid);
          if (dist(chain[chain.length - 1], m[0]) < 9) {
            chain = chain.concat(m);
            used[b] = 1;
            grew = true;
          } else if (dist(m[m.length - 1], chain[0]) < 9) {
            chain = m.concat(chain);
            used[b] = 1;
            grew = true;
          }
        }
      }
      chains.push(chain);
    }
    function mid(r) {
      var d = r.off + r.gap / 2;
      return { x: r.x + r.nx * d, y: r.y + r.ny * d, gap: r.gap };
    }
    function dist(p, q) {
      return Math.hypot(p.x - q.x, p.y - q.y);
    }
    got = [];
    for (var c = 0; c < chains.length; c++) {
      var pts = chains[c];
      var cum = [0];
      for (var k = 1; k < pts.length; k++) cum.push(cum[k - 1] + dist(pts[k - 1], pts[k]));
      var len = cum[cum.length - 1];
      if (len < P.minRunM) continue;
      var x = new Float32Array(pts.length), y = new Float32Array(pts.length);
      var wide = 0;
      for (var q = 0; q < pts.length; q++) {
        var p0 = pts[Math.max(0, q - 1)], p1 = pts[q], p2 = pts[Math.min(pts.length - 1, q + 1)];
        x[q] = (p0.x + p1.x * 2 + p2.x) / 4;
        y[q] = (p0.y + p1.y * 2 + p2.y) / 4;
        wide += p1.gap / pts.length;
      }
      var half = Math.min(P.walkMaxM, Math.max(P.walkMinM, wide * P.walkShare)) / 2;
      var strip = { x: x, y: y, half: half, records: [], len: len };
      stripRecords(W, strip, cum, P, surf, ROAD);
      got.push(strip);
    }
    stripCache.set(W, got);
    return got;
  };

  /** Fills a strip's trees, benches and kiosks. A cross street breaks the rows, and a kiosk stands at each break. */
  function stripRecords(W, strip, cum, P, surf, ROAD) {
    var n = strip.x.length;
    var T = TLV.tune.render;
    var half = strip.half;
    var hash = TLV.rng.hash32;
    function at(s, side, off) {
      var i = 0;
      while (i < n - 2 && cum[i + 1] < s) i++;
      var L = Math.max(1e-3, cum[i + 1] - cum[i]);
      var f = Math.min(1, (s - cum[i]) / L);
      var tx = (strip.x[i + 1] - strip.x[i]) / L, ty = (strip.y[i + 1] - strip.y[i]) / L;
      return {
        x: strip.x[i] + (strip.x[i + 1] - strip.x[i]) * f - ty * side * off,
        y: strip.y[i] + (strip.y[i + 1] - strip.y[i]) * f + tx * side * off,
        yaw: Math.atan2(ty, tx)
      };
    }
    /** True when a point stands off the walkway. At a kink, a row's normal can swing back across it. */
    function clear(p) {
      for (var i = 0; i + 1 < n; i++) {
        var ax = strip.x[i], ay = strip.y[i];
        var dx = strip.x[i + 1] - ax, dy = strip.y[i + 1] - ay;
        var f = Math.max(0, Math.min(1, ((p.x - ax) * dx + (p.y - ay) * dy) / Math.max(1e-6, dx * dx + dy * dy)));
        if (Math.hypot(ax + dx * f - p.x, ay + dy * f - p.y) < half) return false;
      }
      return true;
    }
    var len = cum[n - 1];
    var seedOf = Math.round(strip.x[0] * 10) ^ Math.round(strip.y[0] * 10);
    // Open stretches between cross streets.
    var open = [];
    var from = -1;
    for (var s = 0; s <= len + 2; s += 2) {
      var q = at(Math.min(s, len), 0, 0);
      var road = s > len || surf.at(W, q.x, q.y) === ROAD;
      if (!road && from < 0) from = s;
      if (road && from >= 0) {
        if (s - from >= 20) open.push([from, s]);
        from = -1;
      }
    }
    var kiosks = [];
    for (var o = 0; o < open.length; o++) {
      var a = open[o][0], b = open[o][1];
      var ends = b - a >= 2.4 * P.kioskEndM ? [a + P.kioskEndM, b - P.kioskEndM] : [(a + b) / 2];
      for (var k = 0; k < ends.length; k++) {
        var side = hash(seedOf, o * 2 + k) & 1 ? 1 : -1;
        var p = at(ends[k], side, half + P.kioskOffM);
        if (!clear(p)) continue;
        kiosks.push(p);
        strip.records.push({ mesh: 'kiosk', x: p.x, y: p.y, yaw: p.yaw + (side > 0 ? -Math.PI / 2 : Math.PI / 2), scale: 1, tint: -1 });
      }
      for (var row = -1; row <= 1; row += 2) {
        for (var t = a + 4; t < b - 4; t += P.treeM) {
          var h = hash(seedOf + row, Math.round(t));
          var j = ((h & 255) / 255 - 0.5) * 1.2;
          var w = at(t + j, row, half + P.treeOffM + ((h >>> 8) & 255) / 255 * 0.5);
          if (kiosks.some(function (q2) { return Math.hypot(q2.x - w.x, q2.y - w.y) < P.kioskClearM; })) continue;
          if (surf.at(W, w.x, w.y) === ROAD || !clear(w)) continue;
          var scale = P.treeScale * (0.92 + ((h >>> 16) & 255) / 255 * 0.2);
          strip.records.push({ mesh: 'ficus', x: w.x, y: w.y, yaw: ((h >>> 24) & 255) / 255 * 6.28, scale: scale, tint: T.treeTints[h & 7] });
        }
        for (var u = a + 8 + (row > 0 ? 0 : P.benchM / 2); u < b - 8; u += P.benchM) {
          var v = at(u, row, half + P.benchOffM);
          if (kiosks.some(function (q3) { return Math.hypot(q3.x - v.x, q3.y - v.y) < P.kioskClearM; }) || !clear(v)) continue;
          strip.records.push({ mesh: 'bench', x: v.x, y: v.y, yaw: v.yaw + (row > 0 ? -Math.PI / 2 : Math.PI / 2), scale: 1, tint: -1 });
        }
      }
    }
  }

  /** @returns {number} Metres from a point to a polyline with no arc lengths of its own. */
  function lineDist(px, py, x, y) {
    var best = Infinity;
    for (var i = 0; i + 1 < px.length; i++) {
      var dx = px[i + 1] - px[i], dy = py[i + 1] - py[i];
      var LL = dx * dx + dy * dy;
      var t = LL > 1e-9 ? Math.max(0, Math.min(1, ((x - px[i]) * dx + (y - py[i]) * dy) / LL)) : 0;
      var ex = px[i] + dx * t - x, ey = py[i] + dy * t - y;
      best = Math.min(best, ex * ex + ey * ey);
    }
    return Math.sqrt(best);
  }

  /** Cell key on the road grids. */
  function cellKey(x, y) {
    return (Math.floor(x / GRID_M) + 512) * 4096 + (Math.floor(y / GRID_M) + 512);
  }

  /** Files an id under every cell of a box. */
  function fileBox(map, id, x0, y0, x1, y1) {
    for (var cx = Math.floor(x0 / GRID_M); cx <= Math.floor(x1 / GRID_M); cx++) {
      for (var cy = Math.floor(y0 / GRID_M); cy <= Math.floor(y1 / GRID_M); cy++) {
        var key = (cx + 512) * 4096 + (cy + 512);
        var list = map.get(key);
        if (!list) map.set(key, list = []);
        list.push(id);
      }
    }
  }

  /** Grid of what is paved over a front garden after it has been painted: junction aprons and path ribbons. */
  function pavedGrid(W) {
    var g = pavedGrids.get(W);
    if (g) return g;
    g = { aprons: new Map(), paths: new Map() };
    var T = TLV.tune.render;
    var i, k;
    for (i = 0; i < W.juncs.length; i++) {
      if (!W.juncs[i].poly) continue;
      var ap = apronCached(W, i);
      if (ap.length < 6) continue;
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (k = 0; k + 1 < ap.length; k += 2) {
        x0 = Math.min(x0, ap[k]);
        x1 = Math.max(x1, ap[k]);
        y0 = Math.min(y0, ap[k + 1]);
        y1 = Math.max(y1, ap[k + 1]);
      }
      fileBox(g.aprons, i, x0, y0, x1, y1);
    }
    for (i = 0; i < W.paths.length; i++) {
      var pl = W.paths[i];
      var hw = T.pathWidthM[pl.cls] / 2;
      for (k = 0; k + 1 < pl.px.length; k++) {
        fileBox(g.paths, i, Math.min(pl.px[k], pl.px[k + 1]) - hw, Math.min(pl.py[k], pl.py[k + 1]) - hw,
          Math.max(pl.px[k], pl.px[k + 1]) + hw, Math.max(pl.py[k], pl.py[k + 1]) + hw);
      }
    }
    pavedGrids.set(W, g);
    return g;
  }

  /**
   * Sidewalk segments by the cells they can reach, made once at load. sidewalks.nearest is the sim's question, any distance on any
   * map, and it projects onto each whole row in a wide search. A garden wall or a street bin only asks about the next two metres,
   * so a sample reads a few segments in one cell.
   * @param {object} W World.
   * @returns {{grid:object,segs:Float64Array,owner:Int32Array,reach:number,half:number}} segs: ax, ay, dx, dy. reach: what one cell
   *   holds, all the way round: a sidewalk's half width, and the most a street item can ask of one. half: the widest half width.
   */
  function walkIndex(W) {
    return walkAt.W === W ? walkAt.I : makeWalkIndex(W);
  }

  /** The build of walkIndex. */
  function makeWalkIndex(W) {
    var C = TLV.tune.render.clutter;
    var P = TLV.tune.peds;
    var rows = W.sidewalks;
    var half = 0;
    var total = 0;
    var i, k;
    for (i = 0; i < rows.length; i++) {
      half = Math.max(half, rows[i].width / 2);
      total += Math.max(1, rows[i].px.length - 1);
    }
    var reach = half;
    Object.keys(C.radius).forEach(function (m) { reach = Math.max(reach, P.latMax + P.walkerR + C.walkPadM + C.radius[m]); });
    reach += 0.01;
    var segs = new Float64Array(total * 4);
    var owner = new Int32Array(total);
    var n = 0;
    for (i = 0; i < rows.length; i++) {
      var sw = rows[i];
      var last = sw.px.length - 1;
      for (k = 0; k < Math.max(1, last); k++) {
        var at = n * 4;
        segs[at] = sw.px[k];
        segs[at + 1] = sw.py[k];
        segs[at + 2] = last ? sw.px[k + 1] - sw.px[k] : 0;
        segs[at + 3] = last ? sw.py[k + 1] - sw.py[k] : 0;
        owner[n++] = i;
      }
    }
    var keepR = reach + WALK_CELL * Math.SQRT1_2 + 0.01;
    var grid = flatGrid(W, WALK_CELL, n, function (o, r) {
      var ax = segs[o * 4], ay = segs[o * 4 + 1], bx = ax + segs[o * 4 + 2], by = ay + segs[o * 4 + 3];
      r[0] = Math.min(ax, bx) - reach;
      r[1] = Math.min(ay, by) - reach;
      r[2] = Math.max(ax, bx) + reach;
      r[3] = Math.max(ay, by) + reach;
    }, function (o, x, y) {
      return segDist2(segs[o * 4], segs[o * 4 + 1], segs[o * 4 + 2], segs[o * 4 + 3], x, y) <= keepR * keepR;
    });
    walkAt.W = W;
    walkAt.I = { grid: grid, segs: segs, owner: owner, reach: reach, half: half };
    return walkAt.I;
  }

  /**
   * What sidewalks.nearest answers, as far as a radius. Whatever is found in reach is the true nearest, because anything nearer
   * would be in reach too, and ties go to the lower row the same way.
   * @param {object} W World.
   * @param {number} x World x.
   * @param {number} y World y.
   * @param {number} R Metres.
   * @returns {?{sw:number,d:number}} A shared object, or null when no sidewalk is within R.
   */
  function walkNear(W, x, y, R) {
    var I = walkIndex(W);
    var g = I.grid, segs = I.segs, owner = I.owner;
    var more = R > I.reach ? R - I.reach : 0;
    var cx0 = Math.max(0, Math.floor((x - more) / g.cell) - g.ox), cx1 = Math.min(g.nx - 1, Math.floor((x + more) / g.cell) - g.ox);
    var cy0 = Math.max(0, Math.floor((y - more) / g.cell) - g.oy), cy1 = Math.min(g.ny - 1, Math.floor((y + more) / g.cell) - g.oy);
    var best = -1;
    var bestD = Infinity;
    walkReads++;
    for (var cy = cy0; cy <= cy1; cy++) {
      for (var cx = cx0; cx <= cx1; cx++) {
        var c = cy * g.nx + cx;
        for (var k = g.start[c]; k < g.start[c + 1]; k++) {
          var o = g.items[k];
          var at = o * 4;
          var d2 = segDist2(segs[at], segs[at + 1], segs[at + 2], segs[at + 3], x, y);
          if (d2 < bestD || (d2 === bestD && owner[o] < best)) {
            best = owner[o];
            bestD = d2;
          }
        }
      }
    }
    if (best < 0 || bestD > R * R) return null;
    walkHit.sw = best;
    walkHit.d = Math.sqrt(bestD);
    return walkHit;
  }

  /**
   * Metres from a point to the near edge of its nearest sidewalk, for a question about frontage.
   * @param {object} W World.
   * @param {number} x World x.
   * @param {number} y World y.
   * @param {number} reach Metres from that edge past which the answer does not matter.
   * @returns {number} Metres, negative on the sidewalk. Infinity when nothing is in reach.
   */
  roads.walkGap = function (W, x, y, reach) {
    var limit = reach + walkIndex(W).half;
    var near = null;
    // Most walls have one close by, and what is found inside a small radius is the answer for any larger one.
    for (var R = 6; !near && R < limit * 2; R *= 2) near = walkNear(W, x, y, Math.min(R, limit));
    return near ? near.d - W.sidewalks[near.sw].width / 2 : Infinity;
  };

  /** @returns {number} Sidewalk index reads so far, for tests: a count, so a gate can hold the work with no clock. */
  roads._walkReads = function () {
    return walkReads;
  };

  roads._walkNear = walkNear;

  /**
   * True when paving is painted over this point after any garden is: a sidewalk, a junction's apron, a footpath. A garden wall
   * standing here would stand alone on tile.
   * @param {object} W World.
   * @param {number} x World x.
   * @param {number} y World y.
   * @returns {boolean} True on paving.
   */
  roads.paved = function (W, x, y) {
    var near = walkNear(W, x, y, walkIndex(W).reach);
    if (near && near.d <= W.sidewalks[near.sw].width / 2) return true;
    return roads.pavedOver(W, x, y);
  };

  /** The part of roads.paved that is not a sidewalk, which is the costly part to ask a sidewalk about. */
  roads.pavedOver = function (W, x, y) {
    if (!aprons) return false;           // The skyline builds before the roads are indexed, and draws no gardens
    var T = TLV.tune.render;
    var g = pavedGrid(W);
    var key = cellKey(x, y);
    var list = g.aprons.get(key);
    var i;
    for (i = 0; list && i < list.length; i++) {
      if (inPoly(x, y, apronCached(W, list[i]))) return true;
    }
    list = g.paths.get(key);
    for (i = 0; list && i < list.length; i++) {
      var pl = W.paths[list[i]];
      if (lineDist(pl.px, pl.py, x, y) <= T.pathWidthM[pl.cls] / 2) return true;
    }
    return false;
  };

  /**
   * Where people walk besides the rows: the short links between rows at a corner, and the approach to each crossing.
   * @param {object} W World.
   * @returns {{segs:number[], links:Map, xings:Map, frames:object[]}} Segments as ax, ay, bx, by, and crossing frames.
   */
  function walkGrid(W) {
    var g = walkGrids.get(W);
    if (g) return g;
    g = { segs: [], links: new Map(), xings: new Map(), frames: [] };
    var i, k;
    for (i = 0; i < W.sidewalks.length; i++) {
      var sw = W.sidewalks[i];
      for (k = 0; k < sw.links.length; k++) {
        var L = sw.links[k];
        if (L.sw < i) continue;              // Every link is listed on both rows
        var o = W.sidewalks[L.sw];
        var n = sw.px.length - 1, m = o.px.length - 1;
        var ax = sw.px[L.atEnd ? n : 0], ay = sw.py[L.atEnd ? n : 0];
        var bx = o.px[L.toStart ? 0 : m], by = o.py[L.toStart ? 0 : m];
        var at = g.segs.length;
        g.segs.push(ax, ay, bx, by);
        fileBox(g.links, at, Math.min(ax, bx) - 3, Math.min(ay, by) - 3, Math.max(ax, bx) + 3, Math.max(ay, by) + 3);
      }
    }
    var pt = { x: 0, y: 0, h: 0 };
    for (i = 0; i < W.xings.length; i++) {
      var X = W.xings[i];
      var e = W.edges[X.edge];
      TLV.math.polyAt(e.px, e.py, e.cum, X.s, pt);
      var reach = Math.max(e.kerbOffL, e.kerbOffR) + Math.max(e.swL, e.swR) + TLV.tune.render.clutter.xingReachM;
      g.frames.push({ x: pt.x, y: pt.y, ux: Math.cos(pt.h), uy: Math.sin(pt.h), reach: reach });
      fileBox(g.xings, i, pt.x - reach, pt.y - reach, pt.x + reach, pt.y + reach);
    }
    walkGrids.set(W, g);
    return g;
  }

  /**
   * True when something of radius r can stand here without anyone having to walk through it, and off the road. Reads the same
   * numbers the sim's walkers keep to, so a row's walking width stays clear whatever the sidewalk looks like.
   * @param {object} W World.
   * @param {number} x World x.
   * @param {number} y World y.
   * @param {number} r Radius of the item, metres.
   * @param {boolean} [hug] It stands against a wall on purpose, so only its centre has to be out of the building.
   * @returns {boolean} True when clear.
   */
  roads.clearSpot = function (W, x, y, r, hug) {
    var C = TLV.tune.render.clutter;
    var P = TLV.tune.peds;
    var walk = P.latMax + P.walkerR + C.walkPadM + r;
    var near = walkNear(W, x, y, walk);
    if (near && near.d < walk) return false;
    var g = walkGrid(W);
    var key = cellKey(x, y);
    var list = g.links.get(key);
    var i;
    for (i = 0; list && i < list.length; i++) {
      var o = list[i];
      var ax = g.segs[o], ay = g.segs[o + 1], dx = g.segs[o + 2] - ax, dy = g.segs[o + 3] - ay;
      var LL = dx * dx + dy * dy;
      var t = LL > 1e-9 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / LL)) : 0;
      if (Math.hypot(ax + dx * t - x, ay + dy * t - y) < walk) return false;
    }
    list = g.xings.get(key);
    for (i = 0; list && i < list.length; i++) {
      var f = g.frames[list[i]];
      var along = (x - f.x) * f.ux + (y - f.y) * f.uy;
      var across = -(x - f.x) * f.uy + (y - f.y) * f.ux;
      if (Math.abs(along) < C.xingWideM + r && Math.abs(across) < f.reach) return false;
    }
    if (onOtherRoad(W, x, y, -1, -1, null, -(r + C.kerbPadM))) return false;
    if (TLV.world.surface.at(W, x, y) === TLV.const.SURF.ROAD) return false;
    var pib = TLV.world.spatial.pointInBuilding;
    if (pib(W, x, y) >= 0) return false;
    if (!hug && (pib(W, x + r, y) >= 0 || pib(W, x - r, y) >= 0 || pib(W, x, y + r) >= 0 || pib(W, x, y - r) >= 0)) return false;
    scratchIds.length = 0;
    return TLV.world.spatial.propsNear(W, x, y, r + C.propPadM, scratchIds) === 0;
  };

  /** Picks an entry of a [name, weight] table from a byte. */
  function pick(mix, byte) {
    var sum = 0;
    var i;
    for (i = 0; i < mix.length; i++) sum += mix[i][1];
    var at = byte / 256 * sum;
    for (i = 0; i < mix.length; i++) {
      at -= mix[i][1];
      if (at < 0) return mix[i][0];
    }
    return mix[mix.length - 1][0];
  }

  /**
   * Street clutter on a building's paved frontage: cafe tables outside food shops, and a loose mix of scooters, bikes, bins and
   * boxes along the rest of a shop wall. Render only: nothing here is solid and nothing goes to the sim.
   * @param {object} W World.
   * @param {number} id Building.
   * @param {?string} styleId Style.
   * @param {function(string, number, number, number, number):void} emit mesh, x, y, yaw, tint.
   */
  roads.clutterOfBuilding = function (W, id, styleId, emit) {
    var T = TLV.tune.render;
    var C = T.clutter;
    var R = TLV.render.city.recipes;
    var rows = R.frontage(W, id, styleId);
    if (!rows.length) return;
    var b = W.blds[id];
    var pois = R.poisOf(W).get(id);
    var hash = TLV.rng.hash32;
    var INTERIOR = TLV.const.POIF.INTERIOR;
    function place(mesh, f, along, depth, yaw, tint) {
      var x = f.ax + (f.bx - f.ax) * along / f.len + f.nx * depth;
      var y = f.ay + (f.by - f.ay) * along / f.len + f.ny * depth;
      if (!roads.clearSpot(W, x, y, C.radius[mesh], depth < C.radius[mesh])) return false;
      emit(mesh, x, y, yaw, tint);
      return true;
    }
    for (var r = 0; r < rows.length; r++) {
      var f = rows[r];
      if (!f.shop || f.len < C.minWallM) continue;
      var out = Math.atan2(f.ny, f.nx);
      var taken = [];
      // Tables go in front of the shop that owns them, and the depth is the forecourt's: a kerbside table is a walker's way.
      for (var p = 0; pois && p < pois.length; p++) {
        var q = pois[p];
        if (q.wall !== f.wall || (q.flags & INTERIOR) || C.foodKinds.indexOf(q.kind) < 0) continue;
        var centre = q.t * f.len;
        var sets = (q.w || 4) >= C.cafeTwoM ? 2 : 1;
        for (var k = 0; k < sets; k++) {
          var at = centre + (k - (sets - 1) / 2) * C.cafePitchM;
          var hc = hash(q.id, k);
          if (at < 0.8 || at > f.len - 0.8) continue;
          if (place('cafe_set', f, at, C.cafeDepthM, out + ((hc & 3) - 1.5) * 0.2, -1)) {
            taken.push(at);
            if (hc & 16) emit('cafe_shade', f.ax + (f.bx - f.ax) * at / f.len + f.nx * C.cafeDepthM,
              f.ay + (f.by - f.ay) * at / f.len + f.ny * C.cafeDepthM, out, C.shadeTints[(hc >>> 8) & 3]);
          }
        }
      }
      var slots = Math.floor(f.len / C.slotM);
      for (var i = 0; i < slots; i++) {
        var h = hash(b.osm, f.wall * 64 + i);
        var name = pick(C.mix, h & 255);
        if (name === 'none') continue;
        var pos = (i + 0.5 + ((h >>> 8) & 255) / 255 * 0.4 - 0.2) * C.slotM;
        var clash = false;
        for (var t = 0; t < taken.length; t++) clash = clash || Math.abs(taken[t] - pos) < C.spaceM;
        if (clash) continue;
        var depth = C.depth[name];
        var spin = ((h >>> 16) & 255) / 255;
        if (name === 'scooter' || name === 'e_scooter') {
          // Riders leave them in a loose row at the wall.
          var run = 1 + ((h >>> 24) & 1) + (name === 'scooter' ? (h >>> 25) & 1 : 0);
          for (var c = 0; c < run; c++) {
            var tint = C.scooterTints[(h >>> (20 + c)) & 3];
            place(name, f, pos + c * C.rowM, depth, out + Math.PI / 2 + (spin - 0.5) * 0.5, name === 'scooter' ? tint : -1);
          }
        } else if (name === 'bin') {
          place(name, f, pos, depth, out + spin * 0.4, C.binTints[(h >>> 20) & 3]);
        } else {
          place(name, f, pos, depth, out, -1);
        }
      }
    }
  };

  /**
   * Street-name signs and bins at a junction's corners, stood back from the corner so the links between rows stay clear.
   * @param {object} W World.
   * @param {number} j Junction.
   * @param {function(string, number, number, number, number):void} emit mesh, x, y, yaw, tint.
   */
  roads.clutterOfJunction = function (W, j, emit) {
    var C = TLV.tune.render.clutter;
    var J = W.juncs[j];
    if (!J.poly || (J.flags & 1) || J.kind === 'PASS') return;
    var arms = armsOf(W, J);
    var hash = TLV.rng.hash32;
    var signs = 0;
    var pt = { x: 0, y: 0, h: 0 };
    for (var a = 0; a < arms.length; a++) {
      for (var side = 0; side < 2; side++) {
        var id = walkOf.get(arms[a] * 2 + side);
        if (id === undefined) continue;
        var sw = W.sidewalks[id];
        var d0 = Math.hypot(sw.px[0] - J.x, sw.py[0] - J.y);
        var d1 = Math.hypot(sw.px[sw.px.length - 1] - J.x, sw.py[sw.py.length - 1] - J.y);
        var atStart = d0 <= d1;
        if (Math.min(d0, d1) > C.cornerReachM || sw.len < C.cornerBackM * 2) continue;
        TLV.math.polyAt(sw.px, sw.py, sw.cum, atStart ? C.cornerBackM : sw.len - C.cornerBackM, pt);
        var nx = -Math.sin(pt.h), ny = Math.cos(pt.h);
        var h = hash(j, arms[a] * 2 + side);
        // Either edge of the row will do. The sign goes at the kerb if the row has the width, or else just behind it.
        var sides = (h & 1) ? [1, -1] : [-1, 1];
        var done = false;
        for (var q = 0; q < 2 && !done && signs < C.signsPerJunction; q++) {
          var off = sides[q] * (sw.width / 2 - 0.2);
          var edge = Math.max(Math.abs(off), C.signOffM) * sides[q];
          var x = pt.x + nx * edge, y = pt.y + ny * edge;
          if (roads.clearSpot(W, x, y, C.radius.street_sign)) {
            emit('street_sign', x, y, pt.h + ((h >>> 3) & 1) * Math.PI, -1);
            signs++;
            done = true;
          }
        }
        if ((h >>> 8) % C.cornerBinEvery === 0) {
          TLV.math.polyAt(sw.px, sw.py, atStart ? C.cornerBackM + 2.4 : sw.len - C.cornerBackM - 2.4, pt);
          nx = -Math.sin(pt.h);
          ny = Math.cos(pt.h);
          for (var w = 0; w < 2; w++) {
            var g = (sides[w] * (sw.width / 2 + 0.05));
            var bx = pt.x + nx * g, by = pt.y + ny * g;
            if (roads.paved(W, bx, by) && roads.clearSpot(W, bx, by, C.radius.bin)) {
              emit('bin', bx, by, pt.h, C.binTints[(h >>> 12) & 3]);
              break;
            }
          }
        }
      }
    }
  };

  /**
   * Sunshades and loungers on the sand, in rows parallel to nothing in particular: the lattice is the beach's own raster.
   * @param {object} W World.
   * @param {number} x0 Chunk box.
   * @param {number} y0 Chunk box.
   * @param {number} x1 Chunk box.
   * @param {number} y1 Chunk box.
   * @param {function(string, number, number, number, number):void} emit mesh, x, y, yaw, tint.
   */
  roads.beachOf = function (W, x0, y0, x1, y1, emit) {
    var it = roads.beachSteps(W, x0, y0, x1, y1, emit);
    while (!it.next().done);
  };

  /** roads.beachOf a column of the lattice at a time, for the chunk builder. A generator. */
  roads.beachSteps = function* (W, x0, y0, x1, y1, emit) {
    var C = TLV.tune.render.clutter;
    var surf = TLV.world.surface;
    var SAND = TLV.const.SURF.SAND;
    var hash = TLV.rng.hash32;
    var s = C.beachStepM;
    var ix0 = Math.ceil(x0 / s), ix1 = Math.floor(x1 / s), iy0 = Math.ceil(y0 / s), iy1 = Math.floor(y1 / s);
    for (var ix = ix0; ix <= ix1; ix++) {
      for (var iy = iy0; iy <= iy1; iy++) {
        var h = hash(ix + 4096, iy + 4096);
        if ((h & 255) > C.beachKeep) continue;
        var x = ix * s + ((h >>> 8) & 255) / 255 * 3 - 1.5, y = iy * s + ((h >>> 16) & 255) / 255 * 3 - 1.5;
        // The whole set must be on sand, well up from the water and clear of the road and the promenade.
        var r = C.beachClearM;
        if (surf.at(W, x, y) !== SAND || surf.at(W, x + r, y) !== SAND || surf.at(W, x - r, y) !== SAND ||
            surf.at(W, x, y + r) !== SAND || surf.at(W, x, y - r) !== SAND) continue;
        if (roads.paved(W, x, y) || TLV.world.spatial.pointInBuilding(W, x, y) >= 0) continue;
        emit('umbrella', x, y, 0, C.shadeTints[(h >>> 24) & 3]);
        var yaw = ((h >>> 26) & 7) / 8 * 6.2832;
        for (var k = 0; k < 2; k++) {
          var off = k ? 1.05 : -1.05;
          emit('lounger', x - Math.sin(yaw) * off, y - Math.cos(yaw) * off, yaw, -1);
        }
      }
      yield;
    }
  };

  /**
   * Drops the caches and indexes the sidewalks. Called from chunks.init.
   * @param {object} W World.
   */
  roads.reset = function (W) {
    trims = new Float64Array(W.edges.length * 4).fill(NaN);
    medians = new Map();
    clears = new Array(W.edges.length * 2);
    aprons = new Map();
    walkOf = new Map();
    for (var i = 0; i < W.sidewalks.length; i++) walkOf.set(W.sidewalks[i].edge * 2 + W.sidewalks[i].side, i);
    // Whole-map indexes, built here once at load: built on first use they would land in one frame's slice.
    otherIndex(W);
    walkIndex(W);
    pavedGrid(W);
    walkGrid(W);
  };

  /** Forecourts and front gardens. Roads and sidewalks paint over any overshoot. A generator: a first build has walls to measure. */
  function* frontage(buf, W, ids, MAT) {
    var T = TLV.tune.render;
    var F = T.frontage;
    var R = TLV.render.city.recipes;
    var ST = TLV.render.styles;
    var pave = TLV.render.ground.rgba(T.colors.paving);
    function quadOut(ax, ay, bx, by, nx, ny, d, mat) {
      buf.quad(ax, ay, 0, 0, 0, ax + nx * d, ay + ny * d, 0, 0, 0, bx + nx * d, by + ny * d, 0, 0, 0, bx, by, 0, 0, 0, pave, mat);
    }
    var out = [];
    for (var i = 0; i < ids.length; i++) {
      var rows = R.frontageRead(W, ids[i]);
      if (!rows) {
        rows = R.frontage(W, ids[i], ST.choose(W, ids[i]));
        yield;
      }
      for (var k = 0; k < rows.length; k++) out.push(rows[k]);
    }
    for (var g = 0; g < out.length; g++) {
      var f = out[g];
      var d = R.gardenDepth(f);
      if (d) quadOut(f.ax, f.ay, f.bx, f.by, f.nx, f.ny, d, MAT.BED);
    }
    for (var p = 0; p < out.length; p++) {
      var r = out[p];
      var ux = (r.bx - r.ax) / r.len, uy = (r.by - r.ay) / r.len;
      if (r.shop) {
        var o = F.overlapM;
        quadOut(r.ax - ux * o, r.ay - uy * o, r.bx + ux * o, r.by + uy * o, r.nx, r.ny, r.far + 0.6, MAT.PAVING);
      } else if (R.gardenDepth(r) && r.len >= F.pathMinLenM) {
        var mx = (r.ax + r.bx) / 2, my = (r.ay + r.by) / 2;
        var hp = F.pathM / 2;
        quadOut(mx - ux * hp, my - uy * hp, mx + ux * hp, my + uy * hp, r.nx, r.ny, R.gardenDepth(r) + 0.3, MAT.PAVING);
      }
    }
  }

  /**
   * Fills a buffer with one chunk's ground. A generator, so the builder can stop between items at the frame budget. A value it
   * yields is the room in milliseconds the next step wants: see chunks.frame.
   * @param {object} buf ground.GBuf, with its clip rect set.
   * @param {object} W World.
   * @param {object} bin Items touching this chunk: paths, edges, juncs, conns, walks, lanes, xings, kerbs.
   * @param {number[]} spotCentres x,y pairs of stall query centres.
   * @param {number} spotR Stall query radius.
   */
  roads.fill = function* (buf, W, bin, spotCentres, spotR) {
    var T = TLV.tune.render;
    var C = T.colors;
    var G = TLV.render.ground;
    var MAT = G.MAT;
    var rgba = G.rgba;
    var i;

    // Forecourts and gardens are at the bottom of the stack: everything below paints over their overshoot.
    yield* frontage(buf, W, bin.fronts, MAT);
    yield;

    // Paved streets and paths come first: a road crossing one stays a road.
    var pathCols = [[rgba(C.pedestrian), MAT.STONE], [rgba(C.footway), MAT.PAVING], [rgba(C.cycleway), MAT.FLAT]];
    for (i = 0; i < bin.paths.length; i++) {
      var pl = W.paths[bin.paths[i]];
      var hw = T.pathWidthM[pl.cls] / 2;
      buf.ribbon(pl.px, pl.py, pl.px.length, hw, hw, 0, pathCols[pl.cls][0], pathCols[pl.cls][1]);
      if ((i & 15) === 15) yield;
    }

    // Boulevard walkways, and the corners and medians, all under the carriageways, which cut them to shape.
    var promenade = rgba(C.promenade);
    var strips = roads.strips(W);
    for (i = 0; i < bin.strips.length; i++) {
      var st = strips[bin.strips[i]];
      buf.ribbon(st.x, st.y, st.x.length, st.half, st.half, 0, promenade, MAT.STONE);
    }
    var pave = rgba(C.paving);
    var asphalt = C.asphalt.map(function (h) { return rgba(h); });
    for (i = 0; i < bin.juncs.length; i++) {
      var ap = apronCached(W, bin.juncs[i]);
      if (ap.length >= 6) buf.fan(ap, 0, pave, MAT.PAVING);
      if ((i & 7) === 7) yield;
    }
    var fillCols = { pave: pave, asphalt: asphalt[2] };
    for (i = 0; i < bin.edges.length; i++) {
      medianFill(buf, W, W.edges[bin.edges[i]], fillCols, MAT);
      if ((i & 3) === 3) yield;
    }

    // Carriageways, kerb to kerb.
    for (i = 0; i < bin.edges.length; i++) {
      var e = W.edges[bin.edges[i]];
      buf.ribbon(e.px, e.py, e.px.length, e.kerbOffL, e.kerbOffR, 0, asphalt[e.cls], MAT.ASPHALT, e.cum);
      if ((i & 3) === 3) yield;
    }
    for (i = 0; i < bin.juncs.length; i++) {
      var J = W.juncs[bin.juncs[i]];
      if (J.poly && J.poly.length >= 6) buf.fan(J.poly, 0, asphalt[2], MAT.ASPHALT);
    }
    yield;
    // Connectors reach past the polygons where stop lines were pulled back.
    for (i = 0; i < bin.conns.length; i++) {
      var cn = W.conns[bin.conns[i]];
      if (cn.px.length < 3) continue;
      // Only the shape matters here: a straight connector is sampled every 1.5 m, and two points draw it as well.
      var sim = G.simplify(cn.px, cn.py, T.connectorTolM);
      var lane = W.lanes[cn.from];
      var hl = (lane ? lane.width : 3) / 2 + 0.25;
      buf.ribbon(sim.x, sim.y, sim.n, hl, hl, 0, asphalt[lane ? lane.cls : 2], MAT.ASPHALT);
      if ((i & 7) === 7) yield;
    }

    // Sidewalks, from their own ribbons: a moved stretch stands on the parking strip.
    for (i = 0; i < bin.walks.length; i++) {
      var sw = W.sidewalks[bin.walks[i]];
      buf.ribbon(sw.px, sw.py, sw.px.length, sw.width / 2, sw.width / 2, 0, pave, MAT.PAVING);
      if ((i & 7) === 7) yield;
    }

    // Lane paint.
    var white = rgba(C.paint);
    var lw = T.laneLineM * 1.5 / 2;
    var cw = T.centreLineM * 1.5 / 2;
    for (i = 0; i < bin.lanes.length; i++) {
      var L = W.lanes[bin.lanes[i]];
      var count = L.px.length;
      var half = L.width / 2;
      if (L.left >= 0 && L.left !== L.id) {
        buf.ribbon(L.px, L.py, count, half + lw, -half + lw, 0, white, MAT.DASH, L.cum);
      }
      if (L.opposite >= 0 && L.id < L.opposite) {
        var solid = L.cls <= 2;
        buf.ribbon(L.px, L.py, count, half + cw, -half + cw, 0, white, solid ? MAT.LINE : MAT.DASH, L.cum);
      }
      stopLine(buf, W, L, white, MAT);
      if ((i & 7) === 7) yield;
    }
    for (i = 0; i < bin.edges.length; i++) {
      medianPaint(buf, W, W.edges[bin.edges[i]], white, MAT);
      if ((i & 7) === 7) yield;
    }

    // Zebra crossings, from their zones.
    for (i = 0; i < bin.xings.length; i++) {
      var x = W.xings[bin.xings[i]];
      for (var zi = 0; zi < x.zones.length; zi++) zebra(buf, W, W.zones[x.zones[zi]], white, MAT);
      if ((i & 3) === 3) yield;
    }

    // Everything past here is too fine to see from far off, or in the rear strip: chunks stop drawing at this index.
    buf.fineFrom = buf.ni;

    // Stall ticks. Neighbouring stalls share one.
    var ink = rgba(C.paint, 0.8);
    var seen = new Set();
    var ticks = new Set();
    var ids = [];
    for (i = 0; i + 1 < spotCentres.length; i += 2) {
      yield T.sliceHeavyMs;       // A quarter of a chunk at once, the longest read left in a build
      ids.length = 0;
      var cnt = TLV.world.parking.spotsNear(W, spotCentres[i], spotCentres[i + 1], spotR, ids);
      yield;
      for (var q = 0; q < cnt; q++) {
        if ((q & 31) === 31) yield;
        if (seen.has(ids[q])) continue;
        seen.add(ids[q]);
        var sp = TLV.world.parking.spot(W, ids[q]);
        if (!sp) continue;
        var c = Math.cos(sp.h), sn = Math.sin(sp.h);
        var lx = -sn * sp.wid / 2, ly = c * sp.wid / 2;
        var tw = T.stallMarkM;
        for (var end = -1; end <= 1; end += 2) {
          var ex = sp.x + c * sp.len / 2 * end, ey = sp.y + sn * sp.len / 2 * end;
          var tick = Math.round(ex * 2) * 65536 + Math.round(ey * 2);
          if (ticks.has(tick)) continue;
          ticks.add(tick);
          buf.quad(ex - lx - c * tw, ey - ly - sn * tw, 0, 0, 0, ex - lx + c * tw, ey - ly + sn * tw, 0, 0, 0,
            ex + lx + c * tw, ey + ly + sn * tw, 0, 0, 0, ex + lx - c * tw, ey + ly - sn * tw, 0, 0, 0, ink, MAT.ZEBRA);
        }
      }
      yield;
    }

    // Painted curbs.
    // The face is in its own shade, so paint folding over the arris reads as a square block and not as an arrowhead.
    var cols = { face: G.shade(rgba(C.kerbGrey), T.curbFaceShade), top: G.shade(rgba(C.kerbGrey), 1.12) };
    var mats = { 0: MAT.CURB, 1: MAT.CURB_RW, 2: MAT.CURB_RY, 3: MAT.CURB_BW };
    for (i = 0; i < bin.kerbs.length; i++) {
      var kr = W.kerbs[bin.kerbs[i]];
      var ke = W.edges[kr.edge];
      if ((kr.side === 0 ? ke.swL : ke.swR) > 0 && !clears[ke.id * 2 + kr.side]) yield* curbClearSteps(W, ke, kr.side);
      curbRow(buf, W, kr, cols, mats);
      yield;
    }
    for (i = 0; i < bin.edges.length; i++) {
      var me = W.edges[bin.edges[i]];
      for (var ms = 0; ms < 2; ms++) {
        if (medianCurbed(W, me, ms) && !clears[me.id * 2 + ms]) yield* curbClearSteps(W, me, ms);
      }
      medianCurbs(buf, W, me, cols, MAT.CURB);
      yield;
    }
    for (i = 0; i < bin.juncs.length; i++) {
      var Jr = W.juncs[bin.juncs[i]];
      if (Jr.poly && !(Jr.flags & 1)) curbReturn(buf, W, Jr, cols, Jr.kind === 'PASS' ? MAT.CURB : MAT.CURB_RW);
      yield;
    }
  };
})(window.TLV);
