// js/world/props.js — WP-WORLD
// Solid street furniture (ARCHITECTURE 8.6). Sim-visible, so it is generated here, and render draws it at these positions.
// Jitter comes from hash32(edgeId, i), never from the run seed, so a street looks the same in every run.
(function (TLV) {
  'use strict';

  var props = TLV.ns('world.props');

  var SEA = 0;
  var SPECIES = ['other', 'ficus', 'palm', 'other'];

  /** Salt that keeps lamp jitter apart from tree jitter on the same sidewalk. */
  var LAMP_SALT = 7919;
  /** How far around a prop the road mask is read, metres. */
  var MASK_REACH = 0.4;

  /**
   * Marks edges whose middle is within the seafront range of the sea's outline. The outline goes in a coarse grid first,
   * because it is long and nearly all of it is far from any given road.
   * @returns {Uint8Array} 1 for a seafront edge.
   */
  function seafrontEdges(W) {
    var T = TLV.tune.world;
    var math = TLV.math;
    var out = new Uint8Array(W.edges.length);
    var segs = [];
    for (var l = 0; l < W.land.length; l++) {
      if (W.land[l].cls !== SEA) continue;
      var poly = W.land[l].poly;
      var n = poly.length >> 1;
      for (var a = 0, b = n - 1; a < n; b = a++) {
        // Typed, as every other line is: a plain array here costs lineCells its compiled code, for the grids still to come.
        var px = new Float32Array(2);
        var py = new Float32Array(2);
        px[0] = poly[2 * b];
        px[1] = poly[2 * a];
        py[0] = poly[2 * b + 1];
        py[1] = poly[2 * a + 1];
        segs.push({ px: px, py: py });
      }
    }
    if (!segs.length) return out;
    var reach = T.seafrontM;
    var grid = TLV.world.spatial._lineGrid(W, reach, segs);
    var at = { x: 0, y: 0, h: 0 };
    for (var i = 0; i < W.edges.length; i++) {
      var e = W.edges[i];
      math.polyAt(e.px, e.py, e.cum, e.len / 2, at);
      var cx = Math.floor((at.x - grid.minX) / reach);
      var cy = Math.floor((at.y - grid.minY) / reach);
      for (var row = Math.max(0, cy - 1); row <= Math.min(grid.ny - 1, cy + 1) && !out[i]; row++) {
        for (var col = Math.max(0, cx - 1); col <= Math.min(grid.nx - 1, cx + 1) && !out[i]; col++) {
          var c = row * grid.nx + col;
          for (var k = grid.start[c]; k < grid.start[c + 1]; k++) {
            var seg = segs[grid.items[k]];
            if (math.pointSegDist(at.x, at.y, seg.px[0], seg.py[0], seg.px[1], seg.py[1]) <= reach) {
              out[i] = 1;
              break;
            }
          }
        }
      }
    }
    return out;
  }

  /**
   * Picks the tree rule for an edge (ARCHITECTURE 8.6). Seafront wins, then road class. Service roads and bridges get
   * no trees.
   * @returns {?{spacing: number, kind: string}} Null for no trees.
   */
  function treeRule(e, seafront) {
    var T = TLV.tune.world;
    if (e.flags & TLV.const.EF.BRIDGE) return null;
    if (e.cls >= TLV.const.ROAD.SERVICE) return null;
    if (seafront) return { spacing: T.treeSeafrontM, kind: 'palm' };
    if (e.cls <= TLV.const.ROAD.TERTIARY) return { spacing: T.treeMajorM, kind: 'ficus' };
    return { spacing: T.treeResidentialM, kind: 'ficus' };
  }

  /** Lists the crossings, doors and stops near which nothing solid may stand, by edge. */
  function clearancesByEdge(W) {
    var T = TLV.tune.world;
    var lists = new Array(W.edges.length);
    function add(edge, x, y, r) {
      if (edge < 0 || edge >= lists.length) return;
      if (!lists[edge]) lists[edge] = [];
      lists[edge].push(x, y, r);
    }
    var i;
    for (i = 0; i < W.xings.length; i++) add(W.xings[i].edge, W.xings[i].x, W.xings[i].y, T.propClearXingM);
    for (i = 0; i < W.stops.length; i++) add(W.stops[i].edge, W.stops[i].x, W.stops[i].y, T.propClearStopM);
    for (i = 0; i < W.pois.length; i++) add(W.pois[i].edge, W.pois[i].entX, W.pois[i].entY, T.propClearDoorM);
    return lists;
  }

  /** @returns {boolean} True when (x, y) keeps clear of everything on the edge's list. */
  function clearOf(list, x, y) {
    if (!list) return true;
    for (var i = 0; i < list.length; i += 3) {
      var dx = list[i] - x;
      var dy = list[i + 1] - y;
      if (dx * dx + dy * dy < list[i + 2] * list[i + 2]) return false;
    }
    return true;
  }

  /**
   * True when ground at (x, y) can hold a prop: not on road, by more than the mask's one-metre cells could hide, and in no
   * footprint.
   * @returns {boolean}
   */
  function standable(W, x, y) {
    var onRoad = TLV.world.surface._markedAt;
    var g = TLV.world.surface._grid(W);
    if (onRoad(g, x, y)) return false;
    for (var i = 0; i < 4; i++) {
      if (onRoad(g, x + ((i & 1) ? MASK_REACH : -MASK_REACH), y + ((i & 2) ? MASK_REACH : -MASK_REACH))) return false;
    }
    return TLV.world.spatial.pointInBuilding(W, x, y) < 0;
  }

  /** Real tree nodes. One standing in a lane or a wall is an error in the data, and the road wins. */
  function placeRealTrees(W, out) {
    var T = TLV.tune.world;
    var t = W.index.trees;
    var per = W.index.per;
    for (var i = 0; i < t.n; i++) {
      var x = t.col.x[i] / per;
      var y = t.col.y[i] / per;
      if (!standable(W, x, y)) continue;
      out.push({ id: out.length, kind: SPECIES[t.col.species[i]] || 'other', x: x, y: y, r: T.treeRadius });
    }
  }

  /** @returns {boolean} True when a real tree already stands within the clearance of (x, y). */
  function nearRealTree(W, grid, x, y, real) {
    var clear = TLV.tune.world.realTreeClearM;
    var cell = grid.cell;
    var cx0 = Math.max(0, Math.floor((x - clear - grid.minX) / cell));
    var cx1 = Math.min(grid.nx - 1, Math.floor((x + clear - grid.minX) / cell));
    var cy0 = Math.max(0, Math.floor((y - clear - grid.minY) / cell));
    var cy1 = Math.min(grid.ny - 1, Math.floor((y + clear - grid.minY) / cell));
    for (var cy = cy0; cy <= cy1; cy++) {
      for (var cx = cx0; cx <= cx1; cx++) {
        var c = cy * grid.nx + cx;
        for (var k = grid.start[c]; k < grid.start[c + 1]; k++) {
          var p = real[grid.items[k]];
          if ((p.x - x) * (p.x - x) + (p.y - y) * (p.y - y) < clear * clear) return true;
        }
      }
    }
    return false;
  }

  /** Keeps one candidate if it can stand. c holds what a whole row shares: { W, out, real, realGrid, kind, r, trees, list }. */
  function place(c, x, y) {
    if (!clearOf(c.list, x, y) || !standable(c.W, x, y)) return;
    if (c.trees && nearRealTree(c.W, c.realGrid, x, y, c.real)) return;
    c.out.push({ id: c.out.length, kind: c.kind, x: x, y: y, r: c.r });
  }

  /**
   * Places one row of props along a sidewalk, hard by the kerb. Each slot is jittered along the walk by hash32(edge, i). A
   * stretch that moved off a wall is squeezed between it and the road, with no room for a tree, so its slots stay empty.
   */
  function placeRow(c, sw, side, spacing, kerbGap, salt) {
    var T = TLV.tune.world;
    var from = c.moved[sw.id * 2];
    var to = c.moved[sw.id * 2 + 1];
    var n = Math.floor(sw.len / spacing);
    if (n < 1) return;
    var pitch = sw.len / n;
    var at = c.at;
    // Walking in digitized direction, the kerb is to the left of a right-hand sidewalk.
    var toKerb = side === 1 ? 1 : -1;
    var inset = sw.width / 2 - kerbGap;
    if (inset < 0) inset = 0;
    for (var i = 0; i < n; i++) {
      var h = TLV.rng.hash32(sw.edge, i * 2 + side + salt);
      var jitter = (h / 4294967296 - 0.5) * T.propJitter * pitch;
      var s = (i + 0.5) * pitch + jitter;
      if (s >= from && s <= to) continue;
      TLV.world.geom._pointAlong(sw.px, sw.py, sw.cum, s, at);
      place(c, at.x - at.uy * toKerb * inset, at.y + at.ux * toKerb * inset);
    }
  }

  /**
   * Builds W.props. Real trees come first, then each sidewalk's trees and lamps, in sidewalk order.
   * @param {object} W World with sidewalks and the surface road mask.
   */
  props._build = function (W) {
    var T = TLV.tune.world;
    var out = [];
    placeRealTrees(W, out);
    var real = out.slice();
    var seafront = seafrontEdges(W);
    var clear = clearancesByEdge(W);
    var c = {
      W: W, out: out, real: real, realGrid: TLV.world.spatial._pointGrid(W, 20, real), kind: '', r: 0.5, trees: false, list: null,
      at: { x: 0.5, y: 0.5, ux: 0.5, uy: 0.5 }, moved: W.index.swMoved
    };
    for (var i = 0; i < W.sidewalks.length; i++) {
      var sw = W.sidewalks[i];
      var rule = treeRule(W.edges[sw.edge], seafront[sw.edge]);
      c.list = clear[sw.edge];
      if (rule) {
        c.kind = rule.kind;
        c.r = T.treeRadius;
        c.trees = true;
        placeRow(c, sw, sw.side, rule.spacing, T.treeKerbM, 0);
      }
      c.kind = 'lamp';
      c.r = T.lampRadius;
      c.trees = false;
      placeRow(c, sw, sw.side, T.lampM, T.lampKerbM, LAMP_SALT);
    }
    W.props = out;
  };
})(window.TLV);
