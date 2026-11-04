// js/world/sidewalks.js — WP-WORLD
// Generated sidewalks (ARCHITECTURE 8.5): one ribbon per edge side, linked around corners and across crossings. OSM tags
// cover about 12% of ways, so tags are ignored.
(function (TLV) {
  'use strict';

  var sidewalks = TLV.ns('world.sidewalks');

  var SIDE_LEFT = 0;
  var SIDE_RIGHT = 1;

  var GRID_CELL = 60;
  /** nearest searches this far and doubles its radius from SEARCH_START until it finds something. */
  var SEARCH_START = 30;
  var SEARCH_MAX = 960;
  /** The search for clear ground beside a wall stops when it has the wall's face this closely, metres. */
  var CLEAR_STEP = 0.25;
  /** A crossing belongs to a sidewalk that ends no further than this beyond its road's outer edge, metres. */
  var XING_REACH = 6;
  /** More ways through a stretch than any map holds. */
  var WAY_SPAN = 1 << 24;

  /** @returns {boolean} True when a point is inside a footprint that has a collider. */
  function solidAt(W, x, y) {
    return TLV.world.spatial._inSolid(W, x, y);
  }

  /** @returns {object} Sample buffers for sampleLine, reused for each line. */
  function newSamples() {
    return {
      x: new Float64Array(64), y: new Float64Array(64), lx: new Float64Array(64), ly: new Float64Array(64),
      drift: new Float64Array(64), wide: new Float64Array(64), blocked: new Uint8Array(64), seg: new Int32Array(64),
      change: new Uint8Array(64), hits: new Float64Array(256), n: 0, step: 0.5
    };
  }

  /**
   * Samples a line at even spacing, with the left normal of the span under each sample.
   * @param {{x: Float64Array, y: Float64Array, n: number}} line Line.
   * @param {number} spacing Metres between samples, at most.
   * @param {object} q Buffers from newSamples. n + 1 samples are written.
   */
  function sampleLine(line, spacing, q) {
    var px = line.x;
    var py = line.y;
    var total = TLV.world.geom._lineLength(line);
    var n = Math.max(1, Math.ceil(total / spacing));
    var step = total / n;
    if (q.x.length < n + 1) {
      var size = (n + 1) * 2;
      q.x = new Float64Array(size);
      q.y = new Float64Array(size);
      q.lx = new Float64Array(size);
      q.ly = new Float64Array(size);
      q.drift = new Float64Array(size);
      q.wide = new Float64Array(size);
      q.blocked = new Uint8Array(size);
      q.seg = new Int32Array(size);
      q.change = new Uint8Array(size);
    }
    q.n = n;
    q.step = step;
    var seg = 0;
    var start = 0;
    var dx = px[1] - px[0];
    var dy = py[1] - py[0];
    var len = Math.sqrt(dx * dx + dy * dy);
    for (var i = 0; i <= n; i++) {
      var want = step * i;
      while (want > start + len && seg + 2 < line.n) {
        start += len;
        seg++;
        dx = px[seg + 1] - px[seg];
        dy = py[seg + 1] - py[seg];
        len = Math.sqrt(dx * dx + dy * dy);
      }
      var f = len > 0 ? (want - start) / len : 0;
      q.seg[i] = seg;
      q.x[i] = px[seg] + dx * f;
      q.y[i] = py[seg] + dy * f;
      q.lx[i] = len > 0 ? -dy / len : 0;
      q.ly[i] = len > 0 ? dx / len : 1;
    }
  }

  /**
   * Longest run of samples that keeps off road. Two carriageways drawn side by side leave no median for the sidewalks
   * between them, and at an acute junction a ribbon runs on across its neighbour's lanes. A walker there would stand in
   * traffic, and no car would know. The test point stands far enough out that the road's own kerb never answers.
   * @param {object} W World.
   * @param {object} q Samples.
   * @param {number} outward Metres to the side, with sign: + is left of the line.
   * @returns {?number[]} First and last sample of the run, or null if it is too short to use.
   */
  function clearRun(W, q, outward) {
    var T = TLV.tune.world;
    var onRoad = TLV.world.surface._markedAt;
    var g = TLV.world.surface._grid(W);
    var n = q.n + 1;
    var bestStart = 0;
    var bestLen = -1;
    var runStart = -1;
    for (var i = 0; i <= n; i++) {
      var clear = i < n && !onRoad(g, q.x[i] + q.lx[i] * outward, q.y[i] + q.ly[i] * outward);
      if (clear && runStart < 0) runStart = i;
      if (!clear && runStart >= 0) {
        if (i - 1 - runStart > bestLen) {
          bestLen = i - 1 - runStart;
          bestStart = runStart;
        }
        runStart = -1;
      }
    }
    if (bestLen < 0 || bestLen * q.step < Math.min(T.swMinLen, (n - 1) * q.step)) return null;
    return [bestStart, bestStart + bestLen];
  }

  /**
   * Finds where a sampled line crosses walls. A line goes in or out of a footprint only by crossing its ring, so between two
   * crossings every sample answers alike, and a line with none is all inside or all outside. Most ribbons are done with after one
   * sample, and the rest need one sample per crossing, far fewer than testing each sample.
   * @returns {boolean} True when it crosses nothing. q.change[i] is set when a crossing lies between samples i and i + 1.
   */
  function crossings(W, line, q) {
    var rayHits = TLV.world.spatial._rayHits;
    var hits = q.hits;
    var change = q.change;
    var arc = 0;
    var clear = true;
    change.fill(0, 0, q.n + 1);
    for (var i = 0; i + 1 < line.n; i++) {
      var dx = line.x[i + 1] - line.x[i];
      var dy = line.y[i + 1] - line.y[i];
      var len = Math.sqrt(dx * dx + dy * dy);
      var n = rayHits(W, line.x[i], line.y[i], line.x[i + 1], line.y[i + 1], hits);
      if (n === hits.length) {
        // More walls than the buffer holds: this span's samples all get read.
        change.fill(1, Math.floor(arc / q.step), Math.min(q.n, Math.floor((arc + len) / q.step)) + 1);
      }
      for (var h = 0; h < n; h++) {
        var at = Math.floor((arc + hits[h] * len) / q.step);
        change[at > q.n ? q.n : at] = 1;
      }
      if (n) clear = false;
      arc += len;
    }
    return clear;
  }

  /**
   * How far a point inside a wall must move along (nx, ny) to reach the wall's face, by bisection. Only a wall with a recess in
   * it gives this two answers, and either one is clear. Walls mostly run along the road, so the sample before is nearly always
   * good enough, and keeping it holds a ribbon straight past a recess.
   * @param {number} hint The last sample's answer, or -1.
   * @returns {number} Metres, or -1 when even the furthest it may go is still in a wall.
   */
  function clearDepth(W, x, y, nx, ny, room, hint) {
    if (hint > 0 && !solidAt(W, x + nx * hint, y + ny * hint)) return hint;
    if (room <= 0 || solidAt(W, x + nx * room, y + ny * room)) return -1;
    var lo = 0;
    var hi = room;
    while (hi - lo > CLEAR_STEP) {
      var mid = (lo + hi) / 2;
      if (solidAt(W, x + nx * mid, y + ny * mid)) lo = mid;
      else hi = mid;
    }
    return hi;
  }

  /**
   * Reads every sample of a run against the walls. A building can stand closer to the road than the sidewalk's full width, or
   * further in than the kerb the map models, so a sample in a wall moves toward the road by no more than it needs, and may
   * cross the parking strip, since no car can stand where a wall does. It stops short of the lanes. A sample that finds no
   * clear ground before them is blocked, and stands as close to the lanes as it may.
   * @param {object} W World.
   * @param {object} q Samples. Fills q.wide with each sample's move, and q.blocked.
   * @param {number} first First sample.
   * @param {number} last Last sample.
   * @param {number} toKerb +1 when the kerb lies to the left of the line, else -1.
   * @param {number} room Furthest it may move.
   * @returns {number} Samples blocked.
   */
  function scanWalls(W, q, first, last, toKerb, room) {
    var drift = q.drift;
    var wide = q.wide;
    var blocked = q.blocked;
    var ramp = TLV.tune.world.swMaxDrift * q.step;
    var pad = TLV.tune.world.swWallPad;
    var count = 0;
    var hint = -1;
    var inWall = false;
    var lo = last + 1;
    var hi = first - 1;
    var i;
    drift.fill(0, first, last + 1);
    wide.fill(0, first, last + 1);
    blocked.fill(0, first, last + 1);
    for (i = first; i <= last; i++) {
      if (i === first || q.change[i - 1]) inWall = solidAt(W, q.x[i], q.y[i]);
      if (!inWall) {
        hint = -1;
        continue;
      }
      if (i < lo) lo = i;
      hi = i;
      hint = clearDepth(W, q.x[i], q.y[i], q.lx[i] * toKerb, q.ly[i] * toKerb, room, hint);
      if (hint < 0) {
        blocked[i] = 1;
        count++;
      } else {
        drift[i] = hint + pad < room ? hint + pad : room;
      }
    }
    if (hi < lo) return 0;
    // Only samples this close to a wall can move. The rest of the run, usually most of it, stays at zero.
    var from = Math.max(first, lo - Math.ceil(room / ramp) - 2);
    var to = Math.min(last, hi + Math.ceil(room / ramp) + 2);
    // A wall can fall between two samples, so both must clear it. Then the ramps are limited both ways.
    for (i = from; i <= to; i++) {
      var most = drift[i];
      if (i > first && drift[i - 1] > most) most = drift[i - 1];
      if (i < last && drift[i + 1] > most) most = drift[i + 1];
      wide[i] = most;
    }
    for (i = from + 1; i <= to; i++) {
      if (!blocked[i] && !blocked[i - 1] && wide[i - 1] - ramp > wide[i]) wide[i] = wide[i - 1] - ramp;
    }
    for (i = to - 1; i >= from; i--) {
      if (!blocked[i] && !blocked[i + 1] && wide[i + 1] - ramp > wide[i]) wide[i] = wide[i + 1] - ramp;
    }
    for (i = lo; i <= hi; i++) {
      if (blocked[i]) wide[i] = room;
    }
    return count;
  }

  /** Blocks every clear run too short to stand alone, so it goes with the blocked stretch around it. */
  function absorbShortRuns(q, first, last, minLen) {
    var i = first;
    while (i <= last) {
      if (q.blocked[i]) {
        i++;
        continue;
      }
      var k = i;
      while (k < last && !q.blocked[k + 1]) k++;
      if ((k - i) * q.step < minLen) {
        for (var m = i; m <= k; m++) q.blocked[m] = 1;
      }
      i = k + 1;
    }
  }

  /**
   * Stores a line as a new sidewalk row, and returns its id. A row that runs through a wall is marked in ids.stretch, ids.ends
   * keeps where its ends stood before any move, and ids.moved the stretch of it that moved, as metres along it, empty if none.
   */
  function addRow(W, e, side, width, line, ids, stretch, x0, y0, x1, y1, movedFrom, movedTo) {
    var stored = TLV.world.geom._store(W.index.arena, line);
    var id = W.sidewalks.length;
    W.sidewalks.push({
      id: id,
      edge: e.id,
      side: side,
      px: stored.px,
      py: stored.py,
      cum: stored.cum,
      len: stored.len,
      width: width,
      links: [],
      xings: null
    });
    ids.stretch.push(stretch);
    ids.ends.push(x0, y0, x1, y1);
    ids.moved.push(movedFrom, movedTo);
    return id;
  }

  /** Stores samples a to b as one row, on their moved positions, or on the line itself if none of them moved. */
  function addSamples(W, e, side, width, q, a, b, line, spare, toKerb, ids, stretch) {
    var movedFrom = -1;
    var movedTo = -1;
    for (var k = a; k <= b; k++) {
      if (!(q.wide[k] > 0)) continue;
      if (movedFrom < 0) movedFrom = k;
      movedTo = k;
    }
    if (movedFrom < 0) {
      TLV.world.geom._cutLine(line, a * q.step, b * q.step, spare);
      return addRow(W, e, side, width, spare, ids, stretch, q.x[a], q.y[a], q.x[b], q.y[b], 1, 0);
    }
    var count = b - a + 1;
    if (spare.x.length < count) {
      spare.x = new Float64Array(count * 2);
      spare.y = new Float64Array(count * 2);
    }
    var n = 0;
    for (var s = a; s <= b; s++) {
      // A sample in line with both its neighbours adds nothing but work for everything that reads the row.
      if (s > a && s < b && q.seg[s - 1] === q.seg[s + 1] && q.wide[s - 1] === q.wide[s] && q.wide[s + 1] === q.wide[s]) continue;
      spare.x[n] = q.x[s] + q.lx[s] * toKerb * q.wide[s];
      spare.y[n] = q.y[s] + q.ly[s] * toKerb * q.wide[s];
      n++;
    }
    spare.n = n;
    return addRow(W, e, side, width, spare, ids, stretch, q.x[a], q.y[a], q.x[b], q.y[b], (movedFrom - a - 1) * q.step, (movedTo - a + 1) * q.step);
  }

  /**
   * Builds the ribbon of one edge side, unless it has no sidewalk or none that clears the lanes. Walls can part it into clear
   * rows and the stretches between them, which take consecutive ids and share their ends. Which stretches stay is decided once
   * the whole graph exists, by pruneStretches. ids.first and ids.last hold the two rows that face the edge's junctions.
   */
  function buildSide(W, e, side, q, ids) {
    var T = TLV.tune.world;
    var geom = TLV.world.geom;
    var width = side === SIDE_LEFT ? e.swL : e.swR;
    var src = W.index.lineA;
    if (!(width > 0) || src.n < 2) return;
    var kerb = side === SIDE_LEFT ? e.kerbOffL : e.kerbOffR;
    var strip = side === SIDE_LEFT ? e.parkL : e.parkR;
    var off = W.index.lineB;
    var cut = W.index.lineC;
    geom._offsetLine(src, (side === SIDE_RIGHT ? 1 : -1) * (kerb + width / 2), off);
    var total = geom._lineLength(off);
    var trims = W.index.kerbTrim;
    var t0 = Math.min(trims[e.a], T.trimMaxShare * e.len);
    var t1 = Math.min(trims[e.b], T.trimMaxShare * e.len);
    if (total - t0 - t1 < T.laneMinLen && t0 + t1 > 0) {
      var scale = Math.max(0, total - T.laneMinLen) / (t0 + t1);
      t0 *= scale;
      t1 *= scale;
    }
    var line = off;
    if (t0 > 0 || t1 > 0) {
      geom._cutLine(off, t0, total - t1, cut);
      line = cut;
    }
    sampleLine(line, T.swLaneCheckM, q);
    var toKerb = side === SIDE_RIGHT ? 1 : -1;
    var run = clearRun(W, q, -toKerb * Math.max(T.swOuterCheck, T.swOwnKerbClear - width / 2));
    if (!run) return;
    var first = run[0];
    var last = run[1];
    var spare = line === cut ? off : cut;
    var slot = e.id * 2 + side;
    if (crossings(W, line, q) && !solidAt(W, q.x[first], q.y[first])) {
      var kept = line;
      if (first > 0 || last < q.n) {
        geom._cutLine(line, first * q.step, last * q.step, spare);
        kept = spare;
      }
      var only = addRow(W, e, side, width, kept, ids, 0, q.x[first], q.y[first], q.x[last], q.y[last], 1, 0);
      ids.first[slot] = only;
      ids.last[slot] = only;
      return;
    }
    var blocked = scanWalls(W, q, first, last, toKerb, Math.max(0, width / 2 + strip - T.swLaneClear));
    if (blocked) absorbShortRuns(q, first, last, T.swMinLen);
    var i = first;
    while (i <= last) {
      var inWall = q.blocked[i];
      var k = i;
      while (k < last && q.blocked[k + 1] === inWall) k++;
      // A stretch starts and stops on the clear rows either side of it.
      var id = addSamples(W, e, side, width, q, inWall && i > first ? i - 1 : i, inWall && k < last ? k + 1 : k, line, spare, toKerb, ids, inWall);
      if (ids.first[slot] < 0) ids.first[slot] = id;
      ids.last[slot] = id;
      i = k + 1;
    }
  }

  /** Adds a two-way link between sidewalk ends. */
  function link(W, a, aEnd, b, bEnd) {
    W.sidewalks[a].links.push({ sw: b, atEnd: aEnd, toStart: !bEnd });
    W.sidewalks[b].links.push({ sw: a, atEnd: bEnd, toStart: !aEnd });
  }

  /** @returns {number} Metres between two sidewalk ends. */
  function endGap(W, a, aEnd, b, bEnd) {
    var p = W.sidewalks[a];
    var q = W.sidewalks[b];
    var i = aEnd ? p.px.length - 1 : 0;
    var k = bEnd ? q.px.length - 1 : 0;
    var dx = p.px[i] - q.px[k];
    var dy = p.py[i] - q.py[k];
    return Math.sqrt(dx * dx + dy * dy);
  }

  /**
   * True when a straight walk between two sidewalk ends keeps off road. Only a long link can reach one: a corner link of a few
   * metres stays on the corner, and testing it would only find the mask's own coarseness. It reads where the ends stood before
   * any move off a wall, because a moved end stands on its own parking strip, and that is road to the mask.
   * @returns {boolean}
   */
  function linkClear(W, ids, a, aEnd, b, bEnd) {
    var e = ids.ends;
    var i = a * 4 + (aEnd ? 2 : 0);
    var k = b * 4 + (bEnd ? 2 : 0);
    var x0 = e[i];
    var y0 = e[i + 1];
    var dx = e[k] - x0;
    var dy = e[k + 1] - y0;
    if (Math.sqrt(dx * dx + dy * dy) < TLV.tune.world.swLongLink) return true;
    var hits = 0;
    for (var t = 1; t <= 3; t++) {
      if (TLV.world.surface._isRoad(W, x0 + dx * t / 4, y0 + dy * t / 4)) hits++;
    }
    return hits < 2;
  }

  /** @returns {number} Sidewalk on the left of an arm as seen leaving the junction, or -1. */
  function leftOfOutward(ids, arm) {
    return arm.atStart ? ids.first[arm.edge * 2 + SIDE_LEFT] : ids.last[arm.edge * 2 + SIDE_RIGHT];
  }

  /** @returns {number} Sidewalk on the right of an arm as seen leaving the junction, or -1. */
  function rightOfOutward(ids, arm) {
    return arm.atStart ? ids.first[arm.edge * 2 + SIDE_RIGHT] : ids.last[arm.edge * 2 + SIDE_LEFT];
  }

  /**
   * Links sidewalks around corners. Arms are sorted counter-clockwise, so the corner after an arm runs from that arm's left
   * sidewalk to the next arm's right sidewalk, with no road in between. An arm with no sidewalk at all, such as a service
   * alley, is walked past. A cul-de-sac is its own next arm, so its two sidewalks join around the end.
   */
  function linkCorners(W, ids) {
    var arms = W.index.arms;
    for (var j = 0; j < W.juncs.length; j++) {
      var list = arms[j];
      if (list.length === 0 || (list.length === 1 && (W.juncs[j].flags & 1))) continue;
      linkJunction(W, ids, list);
    }
  }

  /** Links the corners of one junction. Apart from the loop over junctions so it gets compiled early. */
  function linkJunction(W, ids, list) {
    var T = TLV.tune.world;
    var n = list.length;
    for (var i = 0; i < n; i++) {
      var from = leftOfOutward(ids, list[i]);
      if (from < 0) continue;
      var step = 1;
      var next = list[(i + step) % n];
      while (step < n && leftOfOutward(ids, next) < 0 && rightOfOutward(ids, next) < 0) {
        step++;
        next = list[(i + step) % n];
      }
      var to = rightOfOutward(ids, next);
      if (to < 0 || (to === from && n > 1)) continue;
      var fromEnd = !list[i].atStart;
      var toEnd = !next.atStart;
      if (to === from && fromEnd === toEnd) continue;
      // Round the end of a cul-de-sac is always a walk across the road's end, where cars are turning slowly.
      var clear = n === 1 || linkClear(W, ids, from, fromEnd, to, toEnd);
      if (clear && endGap(W, from, fromEnd, to, toEnd) <= T.swLinkM) link(W, from, fromEnd, to, toEnd);
    }
  }

  /** @returns {boolean} True when a walk between two ends crosses neither road nor wall. */
  function walkClear(W, a, aEnd, b, bEnd) {
    var p = W.sidewalks[a];
    var q = W.sidewalks[b];
    var i = aEnd ? p.px.length - 1 : 0;
    var k = bEnd ? q.px.length - 1 : 0;
    if (TLV.world.spatial.rayBlocked(W, p.px[i], p.py[i], q.px[k], q.py[k])) return false;
    var dx = q.px[k] - p.px[i];
    var dy = q.py[k] - p.py[i];
    var n = Math.ceil(Math.sqrt(dx * dx + dy * dy) / TLV.tune.world.swLaneCheckM);
    for (var t = 1; t < n; t++) {
      if (TLV.world.surface._isRoad(W, p.px[i] + dx * t / n, p.py[i] + dy * t / n)) return false;
    }
    return true;
  }

  /** @returns {number} Cell of a value on a grid axis, held to the grid. */
  function axisCell(v, origin, cell, n) {
    var c = Math.floor((v - origin) / cell);
    return c < 0 ? 0 : (c >= n ? n - 1 : c);
  }

  /** @returns {object} Grid of sidewalk ends, as row * 2 + end, in cells as wide as a link reaches: three by three cover a search. */
  function endGrid(W) {
    var cell = TLV.tune.world.swLinkM;
    var b = W.bounds;
    var rows = W.sidewalks;
    var nx = Math.max(1, Math.ceil((b.maxX - b.minX) / cell));
    var ny = Math.max(1, Math.ceil((b.maxY - b.minY) / cell));
    var cellOf = new Int32Array(rows.length * 2);
    var xs = new Float32Array(rows.length * 2);
    var ys = new Float32Array(rows.length * 2);
    var start = new Int32Array(nx * ny + 1);
    var i;
    for (i = 0; i < rows.length * 2; i++) {
      var row = rows[i >> 1];
      var at = i & 1 ? row.px.length - 1 : 0;
      var c = axisCell(row.py[at], b.minY, cell, ny) * nx + axisCell(row.px[at], b.minX, cell, nx);
      xs[i] = row.px[at];
      ys[i] = row.py[at];
      cellOf[i] = c;
      start[c + 1]++;
    }
    for (i = 0; i < nx * ny; i++) start[i + 1] += start[i];
    var next = start.slice();
    var items = new Int32Array(rows.length * 2);
    for (i = 0; i < rows.length * 2; i++) items[next[cellOf[i]]++] = i;
    return { minX: b.minX, minY: b.minY, cell: cell, nx: nx, ny: ny, start: start, items: items, xs: xs, ys: ys };
  }

  /**
   * Gives each end still without a link the nearest other end within reach (ARCHITECTURE 8.5). The corners are done first,
   * because a corner is what "going around" means. This only closes what a missing neighbour left open, such as the ribbon a
   * dual carriageway lost, and only over clear ground.
   */
  function linkNearest(W) {
    var g = endGrid(W);
    var work = { near: [], gaps: [] };
    for (var s = 0; s < W.sidewalks.length; s++) {
      var sw = W.sidewalks[s];
      var e = W.edges[sw.edge];
      for (var end = 0; end < 2; end++) {
        var atEnd = end === 1;
        if (W.juncs[atEnd ? e.b : e.a].flags & 1 || hasLink(sw, atEnd)) continue;
        linkEnd(W, g, work, s, atEnd);
      }
    }
  }

  /** @returns {boolean} True when an end of a sidewalk has a link. */
  function hasLink(sw, atEnd) {
    for (var l = 0; l < sw.links.length; l++) {
      if (sw.links[l].atEnd === atEnd) return true;
    }
    return false;
  }

  /** Links one open end to the nearest end it can walk to, if any. */
  function linkEnd(W, g, work, s, atEnd) {
    var reach = TLV.tune.world.swLinkM;
    var near = work.near;
    var gaps = work.gaps;
    var ex = g.xs[s * 2 + (atEnd ? 1 : 0)];
    var ey = g.ys[s * 2 + (atEnd ? 1 : 0)];
    var cx = axisCell(ex, g.minX, g.cell, g.nx);
    var cy = axisCell(ey, g.minY, g.cell, g.ny);
    var m = 0;
    for (var y = Math.max(0, cy - 1); y <= Math.min(g.ny - 1, cy + 1); y++) {
      for (var x = Math.max(0, cx - 1); x <= Math.min(g.nx - 1, cx + 1); x++) {
        var c = y * g.nx + x;
        for (var k = g.start[c]; k < g.start[c + 1]; k++) {
          var item = g.items[k];
          if (item >> 1 === s) continue;
          var dx = g.xs[item] - ex;
          var dy = g.ys[item] - ey;
          var d2 = dx * dx + dy * dy;
          if (d2 > reach * reach) continue;
          near[m] = item;
          gaps[m] = d2;
          m++;
        }
      }
    }
    // Nearest first, lowest id on a tie: the walk over clear ground is the dear test, and the nearest end usually passes it.
    while (m > 0) {
      var best = 0;
      for (var p = 1; p < m; p++) {
        if (gaps[p] < gaps[best] || (gaps[p] === gaps[best] && near[p] < near[best])) best = p;
      }
      var to = near[best];
      if (walkClear(W, s, atEnd, to >> 1, (to & 1) === 1)) {
        link(W, s, atEnd, to >> 1, (to & 1) === 1);
        return;
      }
      m--;
      near[best] = near[m];
      gaps[best] = gaps[m];
    }
  }

  /**
   * @returns {number} The nearest of a side's rows that still reaches the crossing, else -1. A shortened ribbon may have lost
   * it, and a crossing can fall in a stretch that walls took out. A clear row wins over a nearer stretch, or the crossing alone
   * would keep that stretch alive.
   */
  function reaching(W, ids, slot, xing) {
    var first = ids.first[slot];
    if (first < 0) return -1;
    var best = -1;
    var bestD = Infinity;
    var wall = -1;
    var wallD = Infinity;
    for (var id = first; id <= ids.last[slot]; id++) {
      var sw = W.sidewalks[id];
      var e = W.edges[sw.edge];
      var proj = TLV.math.polyProject(sw.px, sw.py, sw.cum, xing.x, xing.y, -1, W.index.tmpProject);
      var reach = (sw.side === SIDE_LEFT ? e.kerbOffL : e.kerbOffR) + sw.width + XING_REACH;
      if (proj.d > reach) continue;
      if (ids.stretch[id]) {
        if (proj.d < wallD) {
          wall = id;
          wallD = proj.d;
        }
      } else if (proj.d < bestD) {
        best = id;
        bestD = proj.d;
      }
    }
    return best >= 0 ? best : wall;
  }

  /** Records which row each crossing lands on, either side of its road. */
  function assignCrossings(W, ids) {
    for (var i = 0; i < W.xings.length; i++) {
      var xing = W.xings[i];
      xing.swA = reaching(W, ids, xing.edge * 2 + SIDE_LEFT, xing);
      xing.swB = reaching(W, ids, xing.edge * 2 + SIDE_RIGHT, xing);
    }
  }

  /** Lists each crossing on the sidewalks either side of it, sorted along the road. */
  function listCrossings(W) {
    var perSide = new Map();
    function add(sw, xing) {
      if (sw < 0) return;
      if (!perSide.has(sw)) perSide.set(sw, []);
      perSide.get(sw).push(xing);
    }
    for (var i = 0; i < W.xings.length; i++) {
      add(W.xings[i].swA, W.xings[i]);
      add(W.xings[i].swB, W.xings[i]);
    }
    var none = new Int32Array(0);
    for (var s = 0; s < W.sidewalks.length; s++) {
      var list = perSide.get(s);
      if (!list) {
        W.sidewalks[s].xings = none;
        continue;
      }
      var ids = TLV.world.geom._idView(W.index.ids, list.length);
      for (var i2 = 0; i2 < list.length; i2++) {
        var x = list[i2];
        for (var k = i2 - 1; k >= 0 && (list[k].s - x.s || list[k].id - x.id) > 0; k--) {
          list[k + 1] = list[k];
          ids[k + 1] = ids[k];
        }
        list[k + 1] = x;
        ids[k + 1] = x.id;
      }
      W.sidewalks[s].xings = ids;
    }
  }

  /** @returns {number} The root of a union-find forest, halving the path. */
  function rootOf(parent, a) {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  }

  /** Takes the dropped rows out of W.sidewalks and renumbers what is left, in links and crossings. */
  function removeRows(W, ids, gone) {
    var rows = W.sidewalks;
    var remap = new Int32Array(rows.length);
    var kept = 0;
    var i;
    for (i = 0; i < rows.length; i++) remap[i] = gone[i] ? -1 : kept++;
    for (i = 0; i < W.xings.length; i++) {
      // A crossing lands on a stretch only if no clear row reaches it, so one that loses its stretch has no side there.
      var x = W.xings[i];
      if (x.swA >= 0) x.swA = remap[x.swA];
      if (x.swB >= 0) x.swB = remap[x.swB];
    }
    for (i = 0; i < rows.length; i++) {
      if (gone[i]) continue;
      var row = rows[i];
      var links = row.links;
      var n = 0;
      for (var l = 0; l < links.length; l++) {
        if (gone[links[l].sw]) continue;
        links[l].sw = remap[links[l].sw];
        links[n++] = links[l];
      }
      links.length = n;
      row.id = remap[i];
      rows[row.id] = row;
      ids.moved[row.id * 2] = ids.moved[i * 2];
      ids.moved[row.id * 2 + 1] = ids.moved[i * 2 + 1];
    }
    rows.length = kept;
    ids.moved.length = kept * 2;
  }

  /**
   * Decides which stretches through walls stay. A walker must not pass through a wall, and the graph must not fall apart, and
   * only where those two meet does a stretch stay: its two sides have no other way between them, by any link or crossing. The
   * rows that need no wall are joined first, then stretches join what is left in a spanning forest, shortest first, so the least
   * wall does the most. A stretch that joins nothing, or leads only to another dropped stretch, goes.
   * @param {object} W World.
   * @param {object} ids Row ids by edge side.
   */
  function pruneStretches(W, ids) {
    var rows = W.sidewalks;
    var stretch = ids.stretch;
    var parent = new Int32Array(rows.length);
    var ways = [];
    var i;
    function join(a, b) {
      if (stretch[a] || stretch[b]) ways.push(a, b);
      else parent[rootOf(parent, a)] = rootOf(parent, b);
    }
    for (i = 0; i < rows.length; i++) parent[i] = i;
    for (i = 0; i < rows.length; i++) {
      var links = rows[i].links;
      for (var l = 0; l < links.length; l++) {
        if (i < links[l].sw) join(i, links[l].sw);
      }
    }
    for (i = 0; i < W.xings.length; i++) {
      if (W.xings[i].swA >= 0 && W.xings[i].swB >= 0) join(W.xings[i].swA, W.xings[i].swB);
    }
    if (!ways.length) return;
    function cost(at) {
      var a = stretch[ways[at]] ? rows[ways[at]].len : 0;
      var b = stretch[ways[at + 1]] ? rows[ways[at + 1]].len : 0;
      return a > b ? a : b;
    }
    // Cost in centimetres above the way's own index, so a plain numeric sort gives the order, and index settles a tie.
    var order = new Float64Array(ways.length >> 1);
    for (i = 0; i < order.length; i++) order[i] = Math.round(cost(i * 2) * 100) * WAY_SPAN + i;
    order.sort();
    var forest = [];
    for (i = 0; i < order.length; i++) {
      var at = (order[i] % WAY_SPAN) * 2;
      var a = rootOf(parent, ways[at]);
      var b = rootOf(parent, ways[at + 1]);
      if (a === b) continue;
      parent[a] = b;
      forest.push(ways[at], ways[at + 1]);
    }
    var gone = new Uint8Array(rows.length);
    var ties = new Int32Array(rows.length);
    var changed = true;
    while (changed) {
      changed = false;
      ties.fill(0);
      for (i = 0; i < forest.length; i += 2) {
        if (gone[forest[i]] || gone[forest[i + 1]]) continue;
        ties[forest[i]]++;
        ties[forest[i + 1]]++;
      }
      for (i = 0; i < rows.length; i++) {
        if (stretch[i] && !gone[i] && ties[i] < 2) {
          gone[i] = 1;
          changed = true;
        }
      }
    }
    removeRows(W, ids, gone);
  }

  /**
   * Builds sidewalks and their links.
   * @param {object} W World with road geometry and the building grid.
   */
  sidewalks._build = function (W) {
    var slots = W.edges.length * 2;
    var ids = { first: new Int32Array(slots), last: new Int32Array(slots), stretch: [], ends: [], moved: [] };
    ids.first.fill(-1);
    ids.last.fill(-1);
    var q = newSamples();
    var i;
    for (i = 0; i < W.edges.length; i++) {
      TLV.world.geom._loadLine(W.edges[i].px, W.edges[i].py, false, W.index.lineA);
      for (var side = SIDE_LEFT; side <= SIDE_RIGHT; side++) buildSide(W, W.edges[i], side, q, ids);
    }
    for (var slot = 0; slot < slots; slot++) {
      for (i = ids.first[slot]; i >= 0 && i < ids.last[slot]; i++) link(W, i, true, i + 1, false);
    }
    linkCorners(W, ids);
    assignCrossings(W, ids);
    linkNearest(W);
    pruneStretches(W, ids);
    W.index.swMoved = Float32Array.from(ids.moved);
    W.index.sidewalkGrid = TLV.world.spatial._lineGrid(W, GRID_CELL, W.sidewalks);
    listCrossings(W);
  };

  /**
   * Nearest sidewalk to a point.
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {{sw:number,s:number,d:number}} [out] Written and returned.
   * @returns {?{sw:number,s:number,d:number}} Null when no sidewalk is within reach.
   */
  sidewalks.nearest = function (W, x, y, out) {
    var g = W.index.sidewalkGrid;
    if (!W.sidewalks.length) return null;
    var math = TLV.math;
    var tmp = W.index.tmpProject;
    for (var r = SEARCH_START; r <= SEARCH_MAX; r *= 2) {
      var best = -1;
      var bestD = Infinity;
      var bestS = 0;
      var cx0 = Math.max(0, Math.floor((x - r - g.minX) / g.cell));
      var cx1 = Math.min(g.nx - 1, Math.floor((x + r - g.minX) / g.cell));
      var cy0 = Math.max(0, Math.floor((y - r - g.minY) / g.cell));
      var cy1 = Math.min(g.ny - 1, Math.floor((y + r - g.minY) / g.cell));
      for (var cy = cy0; cy <= cy1; cy++) {
        for (var cx = cx0; cx <= cx1; cx++) {
          var c = cy * g.nx + cx;
          for (var k = g.start[c]; k < g.start[c + 1]; k++) {
            var id = g.items[k];
            var sw = W.sidewalks[id];
            math.polyProject(sw.px, sw.py, sw.cum, x, y, -1, tmp);
            if (tmp.d < bestD || (tmp.d === bestD && id < best)) {
              best = id;
              bestD = tmp.d;
              bestS = tmp.s;
            }
          }
        }
      }
      if (best >= 0 && bestD <= r) {
        var res = out || {};
        res.sw = best;
        res.s = bestS;
        res.d = bestD;
        return res;
      }
    }
    return null;
  };

  /**
   * Point and heading on a sidewalk, in digitized direction.
   * @param {object} W World.
   * @param {number} swId Sidewalk, or -1.
   * @param {number} s Metres along it, clamped.
   * @param {{x:number,y:number,h:number}} [out] Written and returned.
   * @returns {?{x:number,y:number,h:number}} Null for an unknown sidewalk.
   */
  sidewalks.pointAt = function (W, swId, s, out) {
    var sw = W.sidewalks[swId];
    if (!sw) return null;
    return TLV.math.polyAt(sw.px, sw.py, sw.cum, s, out);
  };

  /**
   * Picks where a walker goes on reaching a sidewalk end.
   * @param {object} W World.
   * @param {number} swId Sidewalk, or -1.
   * @param {boolean} atEnd True for its far end, false for its start.
   * @param {function(): number|{next: function(): number}} rngNext Function returning [0, 1), or an Rng. It is drawn from
   *   only when there is a real choice.
   * @returns {?{sw:number,toStart:boolean}} Null at a dead end.
   */
  sidewalks.nextAt = function (W, swId, atEnd, rngNext) {
    var sw = W.sidewalks[swId];
    if (!sw) return null;
    var links = sw.links;
    var count = 0;
    var i;
    for (i = 0; i < links.length; i++) {
      if (links[i].atEnd === atEnd) count++;
    }
    if (count === 0) return null;
    var pick = 0;
    if (count > 1) {
      var u = typeof rngNext === 'function' ? rngNext() : rngNext.next();
      pick = Math.floor(u * count);
    }
    for (i = 0; i < links.length; i++) {
      if (links[i].atEnd !== atEnd) continue;
      if (pick-- === 0) return { sw: links[i].sw, toStart: links[i].toStart };
    }
    return null;
  };
})(window.TLV);
