// js/world/anchors.js — WP-MAP
// Binds extension data to map rows (ARCHITECTURE section 14.2). `at` anchors stay lat/lon at runtime, so this is one of
// the three places allowed to project (section 1.1).
(function (TLV) {
  'use strict';

  var anchors = TLV.ns('anchors');

  var M_PER_DEG_LAT = 110888;
  var M_PER_DEG_LON = 94415;
  var MOVED_M = 60;
  var RELOCATED_M = 15;
  var OSM_TYPES = { n: 0, w: 1, r: 2 };

  /**
   * Canonical form used to compare names: no niqqud, no geresh or quote marks, no punctuation, lower case, single
   * spaces. It is why `המלך ג׳ורג׳` and `המלך ג'ורג'` compare equal.
   * @param {string} s Any name.
   * @returns {string}
   */
  anchors.normalizeName = function (s) {
    return String(s === null || s === undefined ? '' : s)
      .normalize('NFKD')
      .replace(/[\u0300-\u036f\u0591-\u05c7]/g, '')
      .replace(/[\u0022\u0027\u0060\u00b4\u2018\u2019\u201c\u201d\u05f3\u05f4]/g, '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, ' ')
      .trim();
  };

  /**
   * Splits an anchor reference such as `w90723265`.
   * @param {string} ref OSM reference.
   * @returns {{t: number, id: number}|null} `t` is 0 node, 1 way, 2 relation. Null if malformed.
   */
  anchors.parseOsm = function (ref) {
    var m = /^([nwr])(\d+)$/.exec(String(ref === null || ref === undefined ? '' : ref));
    return m ? { t: OSM_TYPES[m[1]], id: Number(m[2]) } : null;
  };

  /**
   * Projects lat/lon to metres, section 1.1.
   * @param {number} lat Latitude.
   * @param {number} lon Longitude.
   * @param {number[]} origin `[lat0, lon0]`.
   * @returns {{x: number, y: number}}
   */
  anchors.project = function (lat, lon, origin) {
    return { x: (lon - origin[1]) * M_PER_DEG_LON, y: (lat - origin[0]) * M_PER_DEG_LAT };
  };

  /** Distance in metres from a point to a segment. */
  function segDist(px, py, ax, ay, bx, by) {
    var dx = bx - ax;
    var dy = by - ay;
    var l2 = dx * dx + dy * dy;
    var t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    var ex = ax + t * dx - px;
    var ey = ay + t * dy - py;
    return Math.sqrt(ex * ex + ey * ey);
  }

  /** Distance in metres from a point to an open polyline given as separate coordinate arrays. */
  function polylineDist(px, py, xs, ys) {
    var best = Infinity;
    for (var i = 1; i < xs.length; i++) {
      var d = segDist(px, py, xs[i - 1], ys[i - 1], xs[i], ys[i]);
      if (d < best) best = d;
    }
    return best;
  }

  /** Even-odd point test over a closed ring of flat x,y pairs. */
  function inRing(x, y, ring) {
    var inside = false;
    var n = ring.length >> 1;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var yi = ring[2 * i + 1];
      var yj = ring[2 * j + 1];
      if ((yi > y) !== (yj > y)) {
        var xi = ring[2 * i];
        var xj = ring[2 * j];
        if (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
      }
    }
    return inside;
  }

  /** True when a point lies in ring 0 and in no hole. */
  function inRings(x, y, rings) {
    if (!rings.length || !inRing(x, y, rings[0])) return false;
    for (var i = 1; i < rings.length; i++) if (inRing(x, y, rings[i])) return false;
    return true;
  }

  /** Distance in metres from a point to a closed ring boundary. */
  function ringDist(px, py, ring) {
    var best = Infinity;
    var n = ring.length >> 1;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var d = segDist(px, py, ring[2 * j], ring[2 * j + 1], ring[2 * i], ring[2 * i + 1]);
      if (d < best) best = d;
    }
    return best;
  }

  /**
   * Orders edge ids along their shared way. Row order is the fallback: the importer writes the edges of one way
   * consecutively, in travel order.
   * @param {number[]} ids Edge rows.
   * @param {function(number): number} aOf Start junction of a row.
   * @param {function(number): number} bOf End junction of a row.
   * @returns {number[]}
   */
  function travelOrder(ids, aOf, bOf) {
    if (ids.length < 2) return ids.slice();
    var rest = ids.slice().sort(function (p, q) { return p - q; });
    var byStart = new Map();
    var ends = new Set();
    var i;
    for (i = 0; i < rest.length; i++) {
      var a = aOf(rest[i]);
      if (!byStart.has(a)) byStart.set(a, []);
      byStart.get(a).push(rest[i]);
      ends.add(bOf(rest[i]));
    }
    var out = [];
    var used = new Set();
    var walk = function (start) {
      var cur = start;
      while (cur !== undefined && !used.has(cur)) {
        used.add(cur);
        out.push(cur);
        var nexts = byStart.get(bOf(cur)) || [];
        cur = undefined;
        for (var k = 0; k < nexts.length; k++) {
          if (!used.has(nexts[k])) {
            cur = nexts[k];
            break;
          }
        }
      }
    };
    for (i = 0; i < rest.length; i++) if (!ends.has(aOf(rest[i]))) walk(rest[i]);
    for (i = 0; i < rest.length; i++) walk(rest[i]);
    return out;
  }

  /**
   * Adapter over a built World (section 10.6). Scans linearly: anchors resolve at load and at binding, a few dozen at
   * most, so an index would be state with no payoff.
   * @param {object} W World.
   * @param {string} type `building`, `poi` or `edge`.
   * @returns {object|null} An adapter of the shape described on `resolve`.
   */
  function worldIndex(W, type) {
    if (type === 'edge') {
      return {
        n: W.edges.length,
        osmT: function () { return 1; },
        osm: function (i) { return W.edges[i].osm; },
        names: function (i) { return [W.edges[i].name, W.edges[i].nameEn]; },
        dist: function (i, x, y) { return polylineDist(x, y, W.edges[i].px, W.edges[i].py); },
        order: function (ids) {
          return travelOrder(ids, function (e) { return W.edges[e].a; }, function (e) { return W.edges[e].b; });
        }
      };
    }
    if (type === 'poi') {
      return {
        n: W.pois.length,
        osmT: function (i) { return W.pois[i].osmT; },
        osm: function (i) { return W.pois[i].osm; },
        names: function (i) { return [W.pois[i].nameHe, W.pois[i].nameEn]; },
        dist: function (i, x, y) { return Math.hypot(W.pois[i].x - x, W.pois[i].y - y); }
      };
    }
    if (type === 'building') {
      return {
        n: W.blds.length,
        osmT: function (i) { return W.blds[i].osmT; },
        osm: function (i) { return W.blds[i].osm; },
        names: function (i) { return [W.blds[i].name, W.blds[i].nameEn]; },
        dist: function (i, x, y) { return inRings(x, y, W.blds[i].rings) ? 0 : ringDist(x, y, W.blds[i].rings[0]); },
        inside: function (i, x, y) { return inRings(x, y, W.blds[i].rings); }
      };
    }
    return null;
  }

  /**
   * Adapter over `TLV.mapCodec.decodeAll` output, for tools and tests that need no built World. Coordinates in the
   * adapter are metres, like every other adapter.
   * @param {object} d Decoded map.
   * @param {string} type `building`, `poi` or `edge`.
   * @returns {object|null}
   */
  anchors.decodedIndex = function (d, type) {
    var unit = d.meta.unit;
    var s = d.strings;
    var t = d.t;
    if (type === 'edge') {
      var e = t.edges.col;
      var px = t.pts.col.x;
      var py = t.pts.col.y;
      return {
        n: t.edges.n,
        origin: d.meta.origin,
        osmT: function () { return 1; },
        osm: function (i) { return e.osm[i]; },
        names: function (i) { return [s[e.name[i]], s[e.nameEn[i]]]; },
        dist: function (i, x, y) {
          var best = Infinity;
          for (var k = e.ptOff[i] + 1; k < e.ptOff[i + 1]; k++) {
            var dd = segDist(x, y, px[k - 1] * unit, py[k - 1] * unit, px[k] * unit, py[k] * unit);
            if (dd < best) best = dd;
          }
          return best;
        },
        order: function (ids) {
          return travelOrder(ids, function (r) { return e.a[r]; }, function (r) { return e.b[r]; });
        }
      };
    }
    if (type === 'poi') {
      var p = t.pois.col;
      return {
        n: t.pois.n,
        origin: d.meta.origin,
        osmT: function (i) { return p.osmT[i]; },
        osm: function (i) { return p.osm[i]; },
        names: function (i) { return [s[p.nameHe[i]], s[p.nameEn[i]]]; },
        dist: function (i, x, y) { return Math.hypot(p.x[i] * unit - x, p.y[i] * unit - y); }
      };
    }
    if (type === 'building') {
      var b = t.blds.col;
      var ringsOf = function (i) {
        var rings = [];
        for (var r = b.rOff[i]; r < b.rOff[i + 1]; r++) {
          var ring = [];
          for (var k = t.brings.col.pOff[r]; k < t.brings.col.pOff[r + 1]; k++) {
            ring.push(t.bpts.col.x[k] * unit, t.bpts.col.y[k] * unit);
          }
          rings.push(ring);
        }
        return rings;
      };
      return {
        n: t.blds.n,
        origin: d.meta.origin,
        osmT: function (i) { return b.osmT[i]; },
        osm: function (i) { return b.osm[i]; },
        names: function (i) { return [s[b.name[i]], s[b.nameEn[i]]]; },
        dist: function (i, x, y) {
          var rings = ringsOf(i);
          return inRings(x, y, rings) ? 0 : ringDist(x, y, rings[0]);
        },
        inside: function (i, x, y) { return inRings(x, y, ringsOf(i)); }
      };
    }
    return null;
  };

  /** Rows with the same OSM type and id, or an empty list. */
  function exactIds(index, ref) {
    var ids = [];
    for (var i = 0; i < index.n; i++) if (index.osm(i) === ref.id && index.osmT(i) === ref.t) ids.push(i);
    return ids;
  }

  /** Rows carrying the normalized name within `MOVED_M` of the point, nearest first. */
  function movedIds(index, name, x, y) {
    var wanted = anchors.normalizeName(name);
    if (!wanted) return [];
    var hits = [];
    for (var i = 0; i < index.n; i++) {
      var names = index.names(i);
      var same = false;
      for (var k = 0; k < names.length; k++) if (names[k] && anchors.normalizeName(names[k]) === wanted) same = true;
      if (!same) continue;
      var d = index.dist(i, x, y);
      if (d <= MOVED_M) hits.push({ i: i, d: d });
    }
    hits.sort(function (a, b) { return a.d - b.d || a.i - b.i; });
    return hits.map(function (h) { return h.i; });
  }

  /** Footprints containing the point, or the single nearest row within `RELOCATED_M`. */
  function relocatedIds(index, x, y, type) {
    var i;
    if (type === 'building') {
      var inside = [];
      for (i = 0; i < index.n; i++) if (index.inside(i, x, y)) inside.push(i);
      return inside;
    }
    var best = -1;
    var bestD = RELOCATED_M;
    for (i = 0; i < index.n; i++) {
      var d = index.dist(i, x, y);
      if (d <= bestD && (best < 0 || d < bestD)) {
        best = i;
        bestD = d;
      }
    }
    return best < 0 ? [] : [best];
  }

  /**
   * Resolves an anchor against one table, trying `exact`, `moved`, `relocated`, then `orphan` (section 14.2). The type
   * is never guessed, because a way id can be both a building and a POI.
   *
   * `opts.index` replaces the World: the importer passes one over its intermediate records. An adapter has `n` rows and
   * these functions, with distances in metres: `osm(i)`, `osmT(i)`, `names(i) -> string[]`, `dist(i, x, y)`, plus
   * `inside(i, x, y)` for buildings and optionally `order(ids) -> ids` for edges. `origin` is `[lat0, lon0]` and may be
   * left out when `W.meta.origin` exists.
   *
   * `ids` holds every match and `id` is `ids[0]`. An exact edge match is in travel order. A `moved` match is nearest
   * first, since a road name repeats along the street and `id` must be the row at `at`.
   *
   * @param {object|null} W World, or null when `opts.index` is complete.
   * @param {{osm?: string, at?: number[], name?: string}} anchor Anchor from content or an overlay.
   * @param {{type: string, index?: object}} opts `type` is `building`, `poi` or `edge`.
   * @returns {{how: string, type: string, id: number, ids: number[]}}
   */
  anchors.resolve = function (W, anchor, opts) {
    var type = opts && opts.type;
    var orphan = { how: 'orphan', type: type, id: -1, ids: [] };
    var index = (opts && opts.index) || (W ? worldIndex(W, type) : null);
    if (!index || !anchor) return orphan;

    var ref = anchors.parseOsm(anchor.osm);
    if (ref) {
      var exact = exactIds(index, ref);
      if (exact.length) {
        if (index.order) exact = index.order(exact);
        return { how: 'exact', type: type, id: exact[0], ids: exact };
      }
    }

    var origin = index.origin || (W && W.meta && W.meta.origin);
    if (!anchor.at || !origin) return orphan;
    var p = anchors.project(anchor.at[0], anchor.at[1], origin);

    var moved = movedIds(index, anchor.name, p.x, p.y);
    if (moved.length) return { how: 'moved', type: type, id: moved[0], ids: moved };

    var relocated = relocatedIds(index, p.x, p.y, type);
    if (relocated.length) return { how: 'relocated', type: type, id: relocated[0], ids: relocated };

    return orphan;
  };
})(window.TLV);
