// js/world/spatial.js — WP-WORLD
// Uniform grids and the queries on them (ARCHITECTURE 1.5). Each grid is a compressed list of items per cell, built once.
// Queries never allocate: duplicates are removed with stamp arrays held in W.index, which carry no meaning between calls.
(function (TLV) {
  'use strict';

  var spatial = TLV.ns('world.spatial');

  var LANE_CELL = 60;
  var COLLIDER_CELL = 20;
  /** Cell of the wall and footprint grids. Finer than 20 m reads fewer walls per query, and at 10 m the grids cost more than that saves. */
  var WALL_CELL = 14;
  var POI_CELL = 60;
  var STAMP_MAX = 2147483000;

  /** @returns {{marks: Int32Array, n: number}} A stamp set for n ids. */
  function makeStamps(n) {
    return { marks: new Int32Array(n), n: 0 };
  }

  /**
   * Starts a new duplicate-removal pass.
   * @param {{marks: Int32Array, n: number}} s Stamp set.
   * @returns {number} The stamp of this pass.
   */
  spatial._nextStamp = function (s) {
    if (s.n >= STAMP_MAX) {
      s.marks.fill(0);
      s.n = 0;
    }
    s.n++;
    return s.n;
  };

  /**
   * Makes an empty grid over the world bounds, at least one cell either way.
   * @returns {object} { minX, minY, cell, nx, ny, start, items }, with the two lists still empty.
   */
  function makeGrid(W, cell) {
    var b = W.bounds;
    var nx = Math.max(1, Math.ceil((b.maxX - b.minX) / cell));
    var ny = Math.max(1, Math.ceil((b.maxY - b.minY) / cell));
    return { minX: b.minX, minY: b.minY, cell: cell, nx: nx, ny: ny, start: null, items: null };
  }

  /** @returns {number} The column or row holding v, clamped to the grid. */
  function clampCell(v, n) {
    return v < 0 ? 0 : (v >= n ? n - 1 : v);
  }

  /**
   * Starts filling a grid. Geometry is walked once, into a list of (cell, item) pairs, which finishGrid sorts into cells.
   * @param {object} g Grid.
   * @param {number} n Number of items.
   * @returns {object} Pair list, with `item` the item being walked.
   */
  function startPairs(g, n) {
    var seen = new Int32Array(g.nx * g.ny);
    seen.fill(-1);
    var cap = n * 2 + 64;
    // In two steps, so these buffers are variables to V8 from the start: growing one must not cost record and segCells their code.
    var pairs = { seen: seen, cell: null, of: null, m: 0, cap: cap, item: 0 };
    pairs.cell = new Int32Array(cap);
    pairs.of = new Int32Array(cap);
    return pairs;
  }

  /** Adds the current item to a cell. An item that visits one cell twice is kept once. */
  function record(p, c) {
    if (p.seen[c] === p.item) return;
    p.seen[c] = p.item;
    if (p.m === p.cap) {
      p.cap *= 2;
      var cell = new Int32Array(p.cap);
      var of = new Int32Array(p.cap);
      cell.set(p.cell);
      of.set(p.of);
      p.cell = cell;
      p.of = of;
    }
    p.cell[p.m] = c;
    p.of[p.m] = p.item;
    p.m++;
  }

  /** One loop of finishGrid. */
  function countPairs(counts, cell, m) {
    for (var i = 0; i < m; i++) counts[cell[i] + 1]++;
  }

  /** One loop of finishGrid. */
  function sumCounts(counts, cells) {
    for (var i = 0; i < cells; i++) counts[i + 1] += counts[i];
  }

  /** One loop of finishGrid. */
  function spreadPairs(items, next, cell, of, m) {
    for (var i = 0; i < m; i++) items[next[cell[i]]++] = of[i];
  }

  /**
   * Sorts the pairs into the grid's compressed lists. Each loop has a function of its own. Long loops in one function get replaced on
   * the stack by code that has never seen what follows them, so every grid threw that code away twice and ran the rest interpreted.
   */
  function finishGrid(g, p) {
    var cells = g.nx * g.ny;
    var m = p.m;
    var counts = new Int32Array(cells + 1);
    countPairs(counts, p.cell, m);
    sumCounts(counts, cells);
    var items = new Int32Array(m);
    spreadPairs(items, counts.slice(), p.cell, p.of, m);
    g.start = counts;
    g.items = items;
  }

  /** Records the exact cells a segment passes through: one x range per row of the grid. */
  function segCells(g, p, ax, ay, bx, by) {
    var cell = g.cell;
    var x0 = (ax - g.minX) / cell;
    var y0 = (ay - g.minY) / cell;
    var x1 = (bx - g.minX) / cell;
    var y1 = (by - g.minY) / cell;
    if (y0 > y1) {
      var t = x0; x0 = x1; x1 = t;
      t = y0; y0 = y1; y1 = t;
    }
    var row0 = clampCell(Math.floor(y0), g.ny);
    var row1 = clampCell(Math.floor(y1), g.ny);
    var slope = y1 > y0 ? (x1 - x0) / (y1 - y0) : 0;
    for (var row = row0; row <= row1; row++) {
      var enter = y0 > row ? y0 : row;
      var leave = y1 < row + 1 ? y1 : row + 1;
      var xa = x0 + (enter - y0) * slope;
      var xb = x0 + (leave - y0) * slope;
      if (y1 === y0) {
        xa = x0;
        xb = x1;
      }
      var c0 = clampCell(Math.floor(xa < xb ? xa : xb), g.nx);
      var c1 = clampCell(Math.floor(xa < xb ? xb : xa), g.nx);
      for (var col = c0; col <= c1; col++) record(p, row * g.nx + col);
    }
  }

  /** Records every cell of a box. */
  function boxCells(g, p, minX, minY, maxX, maxY) {
    var cell = g.cell;
    var c0 = clampCell(Math.floor((minX - g.minX) / cell), g.nx);
    var c1 = clampCell(Math.floor((maxX - g.minX) / cell), g.nx);
    var r0 = clampCell(Math.floor((minY - g.minY) / cell), g.ny);
    var r1 = clampCell(Math.floor((maxY - g.minY) / cell), g.ny);
    for (var r = r0; r <= r1; r++) {
      for (var c = c0; c <= c1; c++) record(p, r * g.nx + c);
    }
  }

  /** Records the cells of one polyline. Kept apart from _lineGrid so this loop sees typed arrays, whatever the rows are. */
  function lineCells(g, p, px, py) {
    for (var k = 0; k + 1 < px.length; k++) segCells(g, p, px[k], py[k], px[k + 1], py[k + 1]);
  }

  /**
   * Makes a grid of polylines.
   * @param {object} W World.
   * @param {number} cell Cell size, metres.
   * @param {Array<{px: ArrayLike<number>, py: ArrayLike<number>}>} lines Polylines.
   * @returns {object} Grid.
   */
  spatial._lineGrid = function (W, cell, lines) {
    var g = makeGrid(W, cell);
    var p = startPairs(g, lines.length);
    for (var i = 0; i < lines.length; i++) {
      p.item = i;
      lineCells(g, p, lines[i].px, lines[i].py);
    }
    finishGrid(g, p);
    return g;
  };

  /**
   * Makes a grid of points.
   * @param {object} W World.
   * @param {number} cell Cell size, metres.
   * @param {Array<{x: number, y: number}>} list Points.
   * @returns {object} Grid.
   */
  spatial._pointGrid = function (W, cell, list) {
    var g = makeGrid(W, cell);
    var p = startPairs(g, list.length);
    for (var i = 0; i < list.length; i++) {
      p.item = i;
      boxCells(g, p, list[i].x, list[i].y, list[i].x, list[i].y);
    }
    finishGrid(g, p);
    return g;
  };

  /**
   * Builds the collider grid. Connectors are shaped against it, so it comes before them.
   * @param {object} W World with colliders.
   */
  spatial._buildColliders = function (W) {
    var col = W.colliders;
    var cg = makeGrid(W, WALL_CELL);
    var p = startPairs(cg, col.n);
    for (var i = 0; i < col.n; i++) {
      p.item = i;
      segCells(cg, p, col.ax[i], col.ay[i], col.bx[i], col.by[i]);
    }
    finishGrid(cg, p);
    W.index.colliderGrid = cg;
    W.index.colliderStamps = makeStamps(col.n);
  };

  /**
   * Builds the lane, edge, building and POI grids.
   * @param {object} W World with lanes built.
   */
  spatial._build = function (W) {
    var index = W.index;
    index.laneGrid = spatial._lineGrid(W, LANE_CELL, W.lanes);
    index.laneStamps = makeStamps(W.lanes.length);

    var bg = makeGrid(W, WALL_CELL);
    var bp = startPairs(bg, W.blds.length);
    for (var i = 0; i < W.blds.length; i++) {
      var b = W.blds[i];
      bp.item = i;
      if (b.minX <= b.maxX) boxCells(bg, bp, b.minX, b.minY, b.maxX, b.maxY);
    }
    finishGrid(bg, bp);
    index.buildingGrid = bg;

    index.poiGrid = spatial._pointGrid(W, POI_CELL, W.pois);

    var POIF = TLV.const.POIF;
    var sensitive = [];
    for (var p = 0; p < W.pois.length; p++) {
      if (W.pois[p].flags & POIF.SENSITIVE) sensitive.push(p);
    }
    index.sensitive = Int32Array.from(sensitive);
  };

  /**
   * The grid of road edges, built on first use. Only parking queries read it, and parking.init asks for it, so no tick pays.
   * @param {object} W World.
   * @returns {object} Grid.
   */
  spatial._edgeGrid = function (W) {
    var index = W.index;
    if (!index.edgeGrid) {
      index.edgeGrid = spatial._lineGrid(W, LANE_CELL, W.edges);
      index.edgeStamps = makeStamps(W.edges.length);
    }
    return index.edgeGrid;
  };

  /**
   * Builds the prop grid, once props exist.
   * @param {object} W World.
   */
  spatial._buildProps = function (W) {
    W.index.propGrid = spatial._pointGrid(W, COLLIDER_CELL, W.props);
  };

  /**
   * Collects points of a point grid within r, in cell order.
   * @returns {number} Count written.
   */
  function pointsNear(g, list, x, y, r, out) {
    if (!g) return 0;
    var cap = Array.isArray(out) ? Infinity : out.length;
    var cell = g.cell;
    var cx0 = Math.max(0, Math.floor((x - r - g.minX) / cell));
    var cx1 = Math.min(g.nx - 1, Math.floor((x + r - g.minX) / cell));
    var cy0 = Math.max(0, Math.floor((y - r - g.minY) / cell));
    var cy1 = Math.min(g.ny - 1, Math.floor((y + r - g.minY) / cell));
    var r2 = r * r;
    var count = 0;
    for (var cy = cy0; cy <= cy1; cy++) {
      for (var cx = cx0; cx <= cx1; cx++) {
        var c = cy * g.nx + cx;
        for (var k = g.start[c]; k < g.start[c + 1]; k++) {
          var id = g.items[k];
          var dx = list[id].x - x;
          var dy = list[id].y - y;
          if (dx * dx + dy * dy > r2) continue;
          if (count >= cap) return count;
          out[count++] = id;
        }
      }
    }
    if (cap === Infinity) out.length = count;
    return count;
  }

  /**
   * Points of a point grid within r, in cell order. Exists for grids a module keeps for itself.
   * @param {object} g Grid.
   * @param {Array<{x: number, y: number}>} list The points it was made from.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} r Radius, metres.
   * @param {Int32Array|number[]} out Receives indices into list.
   * @returns {number} Count written.
   */
  spatial._pointsNear = pointsNear;

  /**
   * Colliders within r of a point, without duplicates.
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} r Radius, metres.
   * @param {Int32Array} out Receives indices into W.colliders. It stops filling when full.
   * @returns {number} Count written.
   */
  spatial.collidersNear = function (W, x, y, r, out) {
    var index = W.index;
    var g = index.colliderGrid;
    var col = W.colliders;
    var seen = index.colliderStamps.marks;
    var stamp = spatial._nextStamp(index.colliderStamps);
    var dist = TLV.math.pointSegDist;
    var cell = g.cell;
    var cx0 = Math.max(0, Math.floor((x - r - g.minX) / cell));
    var cx1 = Math.min(g.nx - 1, Math.floor((x + r - g.minX) / cell));
    var cy0 = Math.max(0, Math.floor((y - r - g.minY) / cell));
    var cy1 = Math.min(g.ny - 1, Math.floor((y + r - g.minY) / cell));
    var count = 0;
    for (var cy = cy0; cy <= cy1; cy++) {
      for (var cx = cx0; cx <= cx1; cx++) {
        var c = cy * g.nx + cx;
        for (var k = g.start[c]; k < g.start[c + 1]; k++) {
          var id = g.items[k];
          if (seen[id] === stamp) continue;
          seen[id] = stamp;
          if (dist(x, y, col.ax[id], col.ay[id], col.bx[id], col.by[id]) > r) continue;
          if (count >= out.length) return count;
          out[count++] = id;
        }
      }
    }
    return count;
  };

  /**
   * Props within r of a point.
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} r Radius, metres, from the prop's centre.
   * @param {Int32Array|number[]} out Receives prop ids. A typed array stops filling when full, and a plain one is resized.
   * @returns {number} Count written.
   */
  spatial.propsNear = function (W, x, y, r, out) {
    return pointsNear(W.index.propGrid, W.props, x, y, r, out);
  };

  /**
   * POIs within r of a point, by raw position.
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} r Radius, metres.
   * @param {Int32Array|number[]} out Receives POI ids. A typed array stops filling when full, and a plain one is resized.
   * @returns {number} Count written.
   */
  spatial.poisNear = function (W, x, y, r, out) {
    return pointsNear(W.index.poiGrid, W.pois, x, y, r, out);
  };

  /** @returns {boolean} True when the point is in ring 0 and in no hole. */
  function inBuilding(b, x, y) {
    if (x < b.minX || x > b.maxX || y < b.minY || y > b.maxY) return false;
    var inPoly = TLV.math.pointInPoly;
    if (!inPoly(x, y, b.rings[0])) return false;
    for (var i = 1; i < b.rings.length; i++) {
      if (inPoly(x, y, b.rings[i])) return false;
    }
    return true;
  }

  /**
   * The building footprint holding a point. Footprints can overlap. A solid one wins, then the lowest id, so a caller that
   * skips NO_COLLIDER buildings can never miss a solid one under a hollow one.
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @returns {number} Building id, or -1.
   */
  spatial.pointInBuilding = function (W, x, y) {
    var g = W.index.buildingGrid;
    var cx = Math.floor((x - g.minX) / g.cell);
    var cy = Math.floor((y - g.minY) / g.cell);
    if (cx < 0 || cy < 0 || cx >= g.nx || cy >= g.ny) return -1;
    var c = cy * g.nx + cx;
    var hollow = -1;
    for (var k = g.start[c]; k < g.start[c + 1]; k++) {
      var id = g.items[k];
      var b = W.blds[id];
      if (!inBuilding(b, x, y)) continue;
      if (!(b.flags & 1)) return id;
      if (hollow < 0) hollow = id;
    }
    return hollow;
  };

  /**
   * True when a point is inside a footprint that has a collider. What pointInBuilding says with its result read for that, for a
   * caller that asks often enough to feel the difference.
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @returns {boolean}
   */
  spatial._inSolid = function (W, x, y) {
    var g = W.index.buildingGrid;
    var cx = Math.floor((x - g.minX) / g.cell);
    var cy = Math.floor((y - g.minY) / g.cell);
    if (cx < 0 || cy < 0 || cx >= g.nx || cy >= g.ny) return false;
    var c = cy * g.nx + cx;
    for (var k = g.start[c]; k < g.start[c + 1]; k++) {
      var b = W.blds[g.items[k]];
      if (!(b.flags & 1) && inBuilding(b, x, y)) return true;
    }
    return false;
  };

  /**
   * True when an oriented box reaches a building footprint, hollow ones included. Exact: it compares the box with every wall
   * near it, so a corner of a building that pokes into a side of the box counts, and so does a building smaller than the box.
   * @param {object} W World.
   * @param {{x:number,y:number,c:number,s:number,hl:number,hw:number}} box From geom._setBox.
   * @param {number} clear Metres to keep from a wall.
   * @returns {boolean}
   */
  spatial._boxInFootprint = function (W, box, clear) {
    var g = W.index.buildingGrid;
    var dist = TLV.world.geom._segBoxDist;
    var rx = box.hl * Math.abs(box.c) + box.hw * Math.abs(box.s) + clear;
    var ry = box.hl * Math.abs(box.s) + box.hw * Math.abs(box.c) + clear;
    var c0 = clampCell(Math.floor((box.x - rx - g.minX) / g.cell), g.nx);
    var c1 = clampCell(Math.floor((box.x + rx - g.minX) / g.cell), g.nx);
    var r0 = clampCell(Math.floor((box.y - ry - g.minY) / g.cell), g.ny);
    var r1 = clampCell(Math.floor((box.y + ry - g.minY) / g.cell), g.ny);
    for (var r = r0; r <= r1; r++) {
      for (var c = c0; c <= c1; c++) {
        var cell = r * g.nx + c;
        for (var k = g.start[cell]; k < g.start[cell + 1]; k++) {
          var b = W.blds[g.items[k]];
          if (box.x + rx < b.minX || box.x - rx > b.maxX || box.y + ry < b.minY || box.y - ry > b.maxY) continue;
          for (var i = 0; i < b.rings.length; i++) {
            var ring = b.rings[i];
            var n = ring.length >> 1;
            for (var p = 0, q = n - 1; p < n; q = p++) {
              if (dist(ring[2 * q], ring[2 * q + 1], ring[2 * p], ring[2 * p + 1], box) <= clear) return true;
            }
          }
          // No wall is in reach, so the box lies wholly in the footprint or wholly out of it, and its centre says which.
          if (inBuilding(b, box.x, box.y)) return true;
        }
      }
    }
    return false;
  };

  /**
   * True when an oriented box reaches a connector's carriageway. The connector grid is built on first use, because only
   * parking asks this, and parking is outside the build budget (ARCHITECTURE 8).
   * @param {object} W World.
   * @param {{x:number,y:number,c:number,s:number,hl:number,hw:number}} box From geom._setBox.
   * @param {number} clear Metres to keep from a carriageway's edge.
   * @param {number} widest Largest half width of any carriageway, metres.
   * @returns {boolean}
   */
  spatial._boxOnConnector = function (W, box, clear, widest) {
    var index = W.index;
    if (!index.connGrid) {
      index.connGrid = spatial._lineGrid(W, COLLIDER_CELL, W.conns);
      index.connStamps = makeStamps(W.conns.length);
    }
    var g = index.connGrid;
    var near = TLV.world.geom._lineNearBox;
    var seen = index.connStamps.marks;
    var stamp = spatial._nextStamp(index.connStamps);
    var reach = box.hl + box.hw + clear + widest;
    var c0 = clampCell(Math.floor((box.x - reach - g.minX) / g.cell), g.nx);
    var c1 = clampCell(Math.floor((box.x + reach - g.minX) / g.cell), g.nx);
    var r0 = clampCell(Math.floor((box.y - reach - g.minY) / g.cell), g.ny);
    var r1 = clampCell(Math.floor((box.y + reach - g.minY) / g.cell), g.ny);
    for (var r = r0; r <= r1; r++) {
      for (var c = c0; c <= c1; c++) {
        var cell = r * g.nx + c;
        for (var k = g.start[cell]; k < g.start[cell + 1]; k++) {
          var id = g.items[k];
          if (seen[id] === stamp) continue;
          seen[id] = stamp;
          var conn = W.conns[id];
          var half = Math.max(W.lanes[conn.from].width, W.lanes[conn.to].width) / 2;
          if (near(conn.px, conn.py, box, half + clear)) return true;
        }
      }
    }
    return false;
  };

  /** Makes a grid of junction outlines, by bounding box. */
  function junctionGrid(W) {
    var g = makeGrid(W, COLLIDER_CELL);
    var p = startPairs(g, W.juncs.length);
    for (var i = 0; i < W.juncs.length; i++) {
      var poly = W.juncs[i].poly;
      var minX = Infinity;
      var minY = Infinity;
      var maxX = -Infinity;
      var maxY = -Infinity;
      for (var k = 0; k + 1 < poly.length; k += 2) {
        minX = Math.min(minX, poly[k]);
        maxX = Math.max(maxX, poly[k]);
        minY = Math.min(minY, poly[k + 1]);
        maxY = Math.max(maxY, poly[k + 1]);
      }
      p.item = i;
      if (minX <= maxX) boxCells(g, p, minX, minY, maxX, maxY);
    }
    finishGrid(g, p);
    return g;
  }

  /**
   * True when a point is inside a junction's outline. The grid is built on first use, for the same reason as the connector
   * grid.
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @returns {boolean}
   */
  spatial._inJunction = function (W, x, y) {
    var g = W.index.juncGrid || (W.index.juncGrid = junctionGrid(W));
    var cx = Math.floor((x - g.minX) / g.cell);
    var cy = Math.floor((y - g.minY) / g.cell);
    if (cx < 0 || cy < 0 || cx >= g.nx || cy >= g.ny) return false;
    var c = cy * g.nx + cx;
    for (var k = g.start[c]; k < g.start[c + 1]; k++) {
      if (TLV.math.pointInPoly(x, y, W.juncs[g.items[k]].poly)) return true;
    }
    return false;
  };

  /**
   * True when no collider reaches into a box.
   * @param {object} W World.
   * @param {number} minX Box.
   * @param {number} minY Box.
   * @param {number} maxX Box.
   * @param {number} maxY Box.
   * @returns {boolean}
   */
  spatial._boxClear = function (W, minX, minY, maxX, maxY) {
    var g = W.index.colliderGrid;
    var col = W.colliders;
    var ax = col.ax;
    var ay = col.ay;
    var bx = col.bx;
    var by = col.by;
    var c0 = clampCell(Math.floor((minX - g.minX) / g.cell), g.nx);
    var c1 = clampCell(Math.floor((maxX - g.minX) / g.cell), g.nx);
    var r0 = clampCell(Math.floor((minY - g.minY) / g.cell), g.ny);
    var r1 = clampCell(Math.floor((maxY - g.minY) / g.cell), g.ny);
    for (var r = r0; r <= r1; r++) {
      for (var c = c0; c <= c1; c++) {
        var cell = r * g.nx + c;
        for (var k = g.start[cell]; k < g.start[cell + 1]; k++) {
          var id = g.items[k];
          if ((ax[id] < minX && bx[id] < minX) || (ax[id] > maxX && bx[id] > maxX)) continue;
          if ((ay[id] < minY && by[id] < minY) || (ay[id] > maxY && by[id] > maxY)) continue;
          return false;
        }
      }
    }
    return true;
  };

  /**
   * True when a sight line crosses a collider. Touching one counts. NO_COLLIDER buildings do not block.
   * @param {object} W World.
   * @param {number} x0 Start x.
   * @param {number} y0 Start y.
   * @param {number} x1 End x.
   * @param {number} y1 End y.
   * @returns {boolean}
   */
  spatial.rayBlocked = function (W, x0, y0, x1, y1) {
    var g = W.index.colliderGrid;
    var col = W.colliders;
    var hit = TLV.math.segSegHit;
    var cell = g.cell;
    var ax = (x0 - g.minX) / cell;
    var ay = (y0 - g.minY) / cell;
    var bx = (x1 - g.minX) / cell;
    var by = (y1 - g.minY) / cell;
    if (ay > by) {
      var t = ax; ax = bx; bx = t;
      t = ay; ay = by; by = t;
    }
    var row0 = clampCell(Math.floor(ay), g.ny);
    var row1 = clampCell(Math.floor(by), g.ny);
    var slope = by > ay ? (bx - ax) / (by - ay) : 0;
    for (var row = row0; row <= row1; row++) {
      var enter = ay > row ? ay : row;
      var leave = by < row + 1 ? by : row + 1;
      var xa = by > ay ? ax + (enter - ay) * slope : ax;
      var xb = by > ay ? ax + (leave - ay) * slope : bx;
      var c0 = clampCell(Math.floor(xa < xb ? xa : xb), g.nx);
      var c1 = clampCell(Math.floor(xa < xb ? xb : xa), g.nx);
      for (var cx = c0; cx <= c1; cx++) {
        var c = row * g.nx + cx;
        for (var k = g.start[c]; k < g.start[c + 1]; k++) {
          var id = g.items[k];
          if (hit(x0, y0, x1, y1, col.ax[id], col.ay[id], col.bx[id], col.by[id])) return true;
        }
      }
    }
    return false;
  };

  /**
   * Every collider a segment crosses, as shares of its length, in no order. A wall across two cells can answer twice.
   * @param {object} W World.
   * @param {number} x0 Start x.
   * @param {number} y0 Start y.
   * @param {number} x1 End x.
   * @param {number} y1 End y.
   * @param {Float64Array} out Receives the shares, and stops when full.
   * @returns {number} Count written.
   */
  spatial._rayHits = function (W, x0, y0, x1, y1, out) {
    var g = W.index.colliderGrid;
    var col = W.colliders;
    var cell = g.cell;
    var dx = x1 - x0;
    var dy = y1 - y0;
    var ax = (x0 - g.minX) / cell;
    var ay = (y0 - g.minY) / cell;
    var bx = (x1 - g.minX) / cell;
    var by = (y1 - g.minY) / cell;
    if (ay > by) {
      var t = ax; ax = bx; bx = t;
      t = ay; ay = by; by = t;
    }
    var row0 = clampCell(Math.floor(ay), g.ny);
    var row1 = clampCell(Math.floor(by), g.ny);
    var slope = by > ay ? (bx - ax) / (by - ay) : 0;
    var n = 0;
    for (var row = row0; row <= row1; row++) {
      var enter = ay > row ? ay : row;
      var leave = by < row + 1 ? by : row + 1;
      var xa = by > ay ? ax + (enter - ay) * slope : ax;
      var xb = by > ay ? ax + (leave - ay) * slope : bx;
      var c0 = clampCell(Math.floor(xa < xb ? xa : xb), g.nx);
      var c1 = clampCell(Math.floor(xa < xb ? xb : xa), g.nx);
      for (var cx = c0; cx <= c1; cx++) {
        var c = row * g.nx + cx;
        for (var k = g.start[c]; k < g.start[c + 1]; k++) {
          var id = g.items[k];
          var ex = col.bx[id] - col.ax[id];
          var ey = col.by[id] - col.ay[id];
          var d = dx * ey - dy * ex;
          if (d === 0) continue;
          var wx = col.ax[id] - x0;
          var wy = col.ay[id] - y0;
          var along = wx * ey - wy * ex;
          var across = wx * dy - wy * dx;
          // Both shares must lie in 0..1, which needs no division. Nearly every wall here fails it.
          if (d > 0 ? (along < 0 || along > d || across < 0 || across > d) : (along > 0 || along < d || across > 0 || across < d)) continue;
          if (n < out.length) out[n++] = along / d;
        }
      }
    }
    return n;
  };

  /**
   * True when a SENSITIVE POI's raw position is within r of a point. The guard is on the raw position, because the door of
   * a guard-only row is just a snap point.
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} r Radius, metres.
   * @returns {boolean}
   */
  spatial.sensitiveNear = function (W, x, y, r) {
    var list = W.index.sensitive;
    var r2 = r * r;
    for (var i = 0; i < list.length; i++) {
      var p = W.pois[list[i]];
      var dx = p.x - x;
      var dy = p.y - y;
      if (dx * dx + dy * dy <= r2) return true;
    }
    return false;
  };
})(window.TLV);
