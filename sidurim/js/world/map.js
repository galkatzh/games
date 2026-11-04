// js/world/map.js — WP-WORLD
// Receives map payloads from the queue and turns their decoded columns into the static World tables of ARCHITECTURE 10.6:
// metres, strings, plain ids. Everything derived from those tables lives in the other files of this package.
(function (TLV) {
  'use strict';

  var map = TLV.ns('world.map');

  /** Schema major this build reads (ARCHITECTURE 7). */
  var SCHEMA_MAJOR = 1;
  var JUNCTION_KINDS = ['PASS', 'PRIORITY', 'SIGNAL', 'RING'];
  /** Column bit that marks a building with no collider (ARCHITECTURE 7.3). */
  var NO_COLLIDER = 1;
  var EMPTY_TABLE = { n: 0, col: {} };
  /** Floats per block of the world's allocator. */
  var ARENA_CHUNK = 1 << 18;
  var ID_CHUNK = 1 << 17;

  /** Columns read here, by table (ARCHITECTURE 7.3). */
  var COLUMNS = {
    juncs: ['x', 'y', 'kind', 'flags'],
    edges: ['a', 'b', 'ptOff', 'cls', 'lanesF', 'lanesB', 'kmh', 'laneW', 'parkL', 'parkR', 'swL', 'swR', 'flags', 'name',
      'nameEn', 'osm'],
    pts: ['x', 'y'],
    moves: ['from', 'to', 'turn'],
    blds: ['rOff', 'h', 'levels', 'kind', 'roof', 'colour', 'style', 'flags', 'name', 'nameEn', 'osm', 'osmT'],
    brings: ['pOff'],
    bpts: ['x', 'y', 'front'],
    pois: ['x', 'y', 'kind', 'nameHe', 'nameEn', 'osm', 'osmT', 'bld', 'wall', 't', 'w', 'entX', 'entY', 'edge', 'flags'],
    kerbs: ['edge', 'side', 's0', 's1', 'form', 'paint', 'zone', 'tier'],
    xings: ['x', 'y', 'edge', 's', 'flags'],
    stops: ['x', 'y', 'edge', 'dir', 's', 'name'],
    trees: ['x', 'y', 'species'],
    lots: ['pOff', 'kind', 'entX', 'entY', 'name'],
    lotPts: ['x', 'y'],
    land: ['pOff', 'cls'],
    landPts: ['x', 'y'],
    paths: ['pOff', 'cls', 'name'],
    pathPts: ['x', 'y'],
    walls: ['pOff', 'kind'],
    wallPts: ['x', 'y']
  };

  /** Payloads by map id. A read-only registry filled at drain, which ARCHITECTURE 3 exempts. */
  var payloads = Object.create(null);

  /**
   * Queue handler for 'map' items. An unusable item is skipped and reported.
   * @param {object} payload Map container (ARCHITECTURE 7.1).
   */
  map.onMap = function (payload) {
    if (!payload || typeof payload.id !== 'string' || !payload.id) {
      TLV.registry.problem('map', payload && payload.id !== undefined ? String(payload.id) : '?', 'no map id');
      return;
    }
    if (!payload.tables || !payload.meta) {
      TLV.registry.problem('map', payload.id, 'no tables or meta');
      return;
    }
    payloads[payload.id] = payload;
  };

  /**
   * @param {string} mapId Map id.
   * @returns {?object} The drained payload, or null.
   */
  map.payload = function (mapId) {
    return Object.prototype.hasOwnProperty.call(payloads, mapId) ? payloads[mapId] : null;
  };

  /**
   * @returns {object} The named table, or an empty one. A column this map lacks reads as zeros: a minor schema bump only
   *   adds columns, and readers default the missing ones to 0 (ARCHITECTURE 7).
   */
  function tableOf(d, name) {
    var t = d.t[name];
    if (!t) return EMPTY_TABLE;
    var columns = COLUMNS[name] || [];
    for (var i = 0; i < columns.length; i++) {
      var size = /Off$/.test(columns[i]) ? t.n + 1 : t.n;
      if (!t.col[columns[i]]) t.col[columns[i]] = new Int32Array(size);
    }
    return t;
  }

  /** @returns {{px: Float32Array, py: Float32Array}} Point rows lo..hi-1 in metres. */
  function linePts(t, lo, hi, per, arena) {
    var n = Math.max(0, hi - lo);
    var floats = TLV.world.geom._floats;
    var px = floats(arena, n);
    var py = floats(arena, n);
    var x = t.col.x;
    var y = t.col.y;
    for (var i = 0; i < n; i++) {
      px[i] = x[lo + i] / per;
      py[i] = y[lo + i] / per;
    }
    return { px: px, py: py };
  }

  /** @returns {Float32Array} Point rows lo..hi-1 as flat x,y pairs in metres. */
  function flatPts(t, lo, hi, per, arena) {
    var n = Math.max(0, hi - lo);
    var out = TLV.world.geom._floats(arena, n * 2);
    var x = t.col.x;
    var y = t.col.y;
    for (var i = 0; i < n; i++) {
      out[2 * i] = x[lo + i] / per;
      out[2 * i + 1] = y[lo + i] / per;
    }
    return out;
  }

  /** Junction rows. Lists and geometry are filled by lanes.js, junctions.js and signals.js. */
  function loadJuncs(d, per) {
    var t = tableOf(d, 'juncs');
    var c = t.col;
    var out = new Array(t.n);
    for (var i = 0; i < t.n; i++) {
      out[i] = {
        id: i,
        x: c.x[i] / per,
        y: c.y[i] / per,
        kind: JUNCTION_KINDS[c.kind[i]] || 'PRIORITY',
        flags: c.flags[i],
        inDir: null,
        outDir: null,
        conns: null,
        ctrl: -1,
        poly: null
      };
    }
    return out;
  }

  /** Edge rows, with the kerb offsets of ARCHITECTURE 6.3. */
  function loadEdges(d, per, arena) {
    var t = tableOf(d, 'edges');
    var c = t.col;
    var pts = tableOf(d, 'pts');
    var s = d.strings;
    var geom = TLV.world.geom;
    var out = new Array(t.n);
    for (var i = 0; i < t.n; i++) {
      var line = linePts(pts, c.ptOff[i], c.ptOff[i + 1], per, arena);
      var cum = geom._floats(arena, line.px.length);
      for (var k = 1; k < cum.length; k++) {
        var dx = line.px[k] - line.px[k - 1];
        var dy = line.py[k] - line.py[k - 1];
        cum[k] = cum[k - 1] + Math.sqrt(dx * dx + dy * dy);
      }
      var lanesF = c.lanesF[i];
      var lanesB = c.lanesB[i];
      var laneW = c.laneW[i] / per;
      var parkL = c.parkL[i] / per;
      var parkR = c.parkR[i] / per;
      var halfL = lanesB > 0 ? lanesB * laneW : lanesF * laneW / 2;
      var halfR = lanesB > 0 ? lanesF * laneW : lanesF * laneW / 2;
      out[i] = {
        id: i,
        a: c.a[i],
        b: c.b[i],
        px: line.px,
        py: line.py,
        cum: cum,
        len: cum.length ? cum[cum.length - 1] : 0,
        cls: c.cls[i],
        lanesF: lanesF,
        lanesB: lanesB,
        kmh: c.kmh[i],
        laneW: laneW,
        parkL: parkL,
        parkR: parkR,
        swL: c.swL[i] / per,
        swR: c.swR[i] / per,
        kerbOffL: halfL + parkL,
        kerbOffR: halfR + parkR,
        flags: c.flags[i],
        name: s[c.name[i]] || '',
        nameEn: s[c.nameEn[i]] || '',
        osm: c.osm[i]
      };
    }
    return out;
  }

  /** @returns {number[]} Area centroid of flat x,y pairs, or their mean for a degenerate ring. */
  function ringCentre(ring) {
    var n = ring.length >> 1;
    var area = 0;
    var ax = 0;
    var ay = 0;
    var mx = 0;
    var my = 0;
    var x0 = n ? ring[0] : 0;
    var y0 = n ? ring[1] : 0;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = ring[2 * i] - x0;
      var yi = ring[2 * i + 1] - y0;
      var xj = ring[2 * j] - x0;
      var yj = ring[2 * j + 1] - y0;
      var cross = xj * yi - xi * yj;
      area += cross;
      ax += (xj + xi) * cross;
      ay += (yj + yi) * cross;
      mx += xi;
      my += yi;
    }
    if (Math.abs(area) < 1e-9) return n ? [x0 + mx / n, y0 + my / n] : [0, 0];
    return [x0 + ax / (3 * area), y0 + ay / (3 * area)];
  }

  /** Building rows. Each ring is closed implicitly. */
  function loadBuildings(d, per, arena) {
    var t = tableOf(d, 'blds');
    var c = t.col;
    var brings = tableOf(d, 'brings');
    var bpts = tableOf(d, 'bpts');
    var s = d.strings;
    var out = new Array(t.n);
    var fronts = bpts.n ? new Uint8Array(bpts.col.front) : new Uint8Array(0);
    for (var i = 0; i < t.n; i++) {
      // Nearly all have one ring, and an array that grows by push starts with room for 17, on 14,500 buildings.
      var rings;
      if (c.rOff[i + 1] - c.rOff[i] === 1) {
        rings = [flatPts(bpts, brings.col.pOff[c.rOff[i]], brings.col.pOff[c.rOff[i] + 1], per, arena)];
      } else {
        rings = [];
        for (var r = c.rOff[i]; r < c.rOff[i + 1]; r++) {
          rings.push(flatPts(bpts, brings.col.pOff[r], brings.col.pOff[r + 1], per, arena));
        }
      }
      var lo = rings.length ? brings.col.pOff[c.rOff[i]] : 0;
      var hi = rings.length ? brings.col.pOff[c.rOff[i] + 1] : 0;
      var front = fronts.subarray(lo, hi);
      var outer = rings.length ? rings[0] : new Float32Array(0);
      var minX = Infinity;
      var minY = Infinity;
      var maxX = -Infinity;
      var maxY = -Infinity;
      for (var p = 0; p + 1 < outer.length; p += 2) {
        if (outer[p] < minX) minX = outer[p];
        if (outer[p] > maxX) maxX = outer[p];
        if (outer[p + 1] < minY) minY = outer[p + 1];
        if (outer[p + 1] > maxY) maxY = outer[p + 1];
      }
      var centre = ringCentre(outer);
      out[i] = {
        id: i,
        osm: c.osm[i],
        osmT: c.osmT[i],
        h: c.h[i] / per,
        levels: c.levels[i],
        kind: c.kind[i],
        roof: c.roof[i],
        colour: s[c.colour[i]] || '',
        style: s[c.style[i]] || '',
        flags: c.flags[i],
        name: s[c.name[i]] || '',
        nameEn: s[c.nameEn[i]] || '',
        rings: rings,
        front: front,
        cx: centre[0],
        cy: centre[1],
        minX: minX,
        minY: minY,
        maxX: maxX,
        maxY: maxY
      };
    }
    return out;
  }

  /** POI rows. Stored ids are plus one, with 0 for none, and become plain ids here. */
  function loadPois(d, per) {
    var t = tableOf(d, 'pois');
    var c = t.col;
    var s = d.strings;
    var out = new Array(t.n);
    for (var i = 0; i < t.n; i++) {
      out[i] = {
        id: i,
        x: c.x[i] / per,
        y: c.y[i] / per,
        kind: s[c.kind[i]] || '',
        nameHe: s[c.nameHe[i]] || '',
        nameEn: s[c.nameEn[i]] || '',
        osm: c.osm[i],
        osmT: c.osmT[i],
        bld: c.bld[i] - 1,
        wall: c.wall[i] - 1,
        t: c.t[i] / 255,
        w: c.w[i] / per,
        entX: c.entX[i] / per,
        entY: c.entY[i] / per,
        edge: c.edge[i] - 1,
        flags: c.flags[i]
      };
    }
    return out;
  }

  /** Kerb rows. */
  function loadKerbs(d, per) {
    var t = tableOf(d, 'kerbs');
    var c = t.col;
    var s = d.strings;
    var out = new Array(t.n);
    for (var i = 0; i < t.n; i++) {
      out[i] = {
        id: i,
        edge: c.edge[i],
        side: c.side[i],
        s0: c.s0[i] / per,
        s1: c.s1[i] / per,
        form: c.form[i],
        paint: c.paint[i],
        zone: s[c.zone[i]] || '',
        tier: c.tier[i]
      };
    }
    return out;
  }

  /** Crossing rows. zones, ctrl and the two sidewalks are filled by later passes. */
  function loadCrossings(d, per) {
    var t = tableOf(d, 'xings');
    var c = t.col;
    var out = new Array(t.n);
    for (var i = 0; i < t.n; i++) {
      out[i] = {
        id: i,
        x: c.x[i] / per,
        y: c.y[i] / per,
        edge: c.edge[i],
        s: c.s[i] / per,
        signal: (c.flags[i] & 1) !== 0,
        zones: null,
        ctrl: -1,
        swA: -1,
        swB: -1
      };
    }
    return out;
  }

  /** Bus stop rows. laneId is filled by lanes.js. */
  function loadStops(d, per) {
    var t = tableOf(d, 'stops');
    var c = t.col;
    var s = d.strings;
    var out = new Array(t.n);
    for (var i = 0; i < t.n; i++) {
      out[i] = {
        id: i,
        x: c.x[i] / per,
        y: c.y[i] / per,
        edge: c.edge[i],
        dir: c.dir[i],
        s: c.s[i] / per,
        laneId: -1,
        name: s[c.name[i]] || ''
      };
    }
    return out;
  }

  /** Parking area rows. */
  function loadLots(d, per, arena) {
    var t = tableOf(d, 'lots');
    var c = t.col;
    var pts = tableOf(d, 'lotPts');
    var s = d.strings;
    var out = new Array(t.n);
    for (var i = 0; i < t.n; i++) {
      out[i] = {
        id: i,
        kind: c.kind[i],
        poly: flatPts(pts, c.pOff[i], c.pOff[i + 1], per, arena),
        entX: c.entX[i] / per,
        entY: c.entY[i] / per,
        name: s[c.name[i]] || ''
      };
    }
    return out;
  }

  /** Land polygon rows. */
  function loadLand(d, per, arena) {
    var t = tableOf(d, 'land');
    var pts = tableOf(d, 'landPts');
    var out = new Array(t.n);
    for (var i = 0; i < t.n; i++) {
      out[i] = { id: i, cls: t.col.cls[i], poly: flatPts(pts, t.col.pOff[i], t.col.pOff[i + 1], per, arena) };
    }
    return out;
  }

  /** Pedestrian path rows. */
  function loadPaths(d, per, arena) {
    var t = tableOf(d, 'paths');
    var pts = tableOf(d, 'pathPts');
    var s = d.strings;
    var out = new Array(t.n);
    for (var i = 0; i < t.n; i++) {
      var line = linePts(pts, t.col.pOff[i], t.col.pOff[i + 1], per, arena);
      out[i] = { id: i, cls: t.col.cls[i], px: line.px, py: line.py, name: s[t.col.name[i]] || '' };
    }
    return out;
  }

  /** Solid line rows. */
  function loadWalls(d, per, arena) {
    var t = tableOf(d, 'walls');
    var pts = tableOf(d, 'wallPts');
    var out = new Array(t.n);
    for (var i = 0; i < t.n; i++) {
      var line = linePts(pts, t.col.pOff[i], t.col.pOff[i + 1], per, arena);
      out[i] = { id: i, kind: t.col.kind[i], px: line.px, py: line.py };
    }
    return out;
  }

  /** Collider segments (ARCHITECTURE 8.7): every ring of a solid building, then every wall. */
  function buildColliders(W) {
    var n = colliderCount(W);
    var col = { n: n, ax: new Float32Array(n), ay: new Float32Array(n), bx: new Float32Array(n), by: new Float32Array(n), owner: new Int32Array(n) };
    var o = 0;
    var i;
    for (i = 0; i < W.blds.length; i++) {
      if (W.blds[i].flags & NO_COLLIDER) continue;
      for (var r = 0; r < W.blds[i].rings.length; r++) o = addRing(col, W.blds[i].rings[r], i, o);
    }
    for (i = 0; i < W.walls.length; i++) o = addWall(col, W.walls[i], o);
    return col;
  }

  /** @returns {number} Segments in every solid ring and wall. */
  function colliderCount(W) {
    var n = 0;
    var i;
    for (i = 0; i < W.blds.length; i++) {
      if (W.blds[i].flags & NO_COLLIDER) continue;
      for (var r = 0; r < W.blds[i].rings.length; r++) n += W.blds[i].rings[r].length >> 1;
    }
    for (i = 0; i < W.walls.length; i++) n += Math.max(0, W.walls[i].px.length - 1);
    return n;
  }

  /** Writes one closed ring from slot o, apart from the loop over buildings so it gets compiled early. @returns {number} The next slot. */
  function addRing(col, ring, owner, o) {
    var m = ring.length >> 1;
    for (var k = 0; k < m; k++) {
      var q = k + 1 === m ? 0 : k + 1;
      col.ax[o] = ring[2 * k];
      col.ay[o] = ring[2 * k + 1];
      col.bx[o] = ring[2 * q];
      col.by[o] = ring[2 * q + 1];
      col.owner[o] = owner;
      o++;
    }
    return o;
  }

  /** Writes one wall from slot o. @returns {number} The next slot. */
  function addWall(col, w, o) {
    for (var k = 0; k + 1 < w.px.length; k++) {
      col.ax[o] = w.px[k];
      col.ay[o] = w.py[k];
      col.bx[o] = w.px[k + 1];
      col.by[o] = w.py[k + 1];
      col.owner[o] = w.kind === 0 ? -1 : -2;
      o++;
    }
    return o;
  }

  /**
   * W.index with every key it will ever hold. V8 ties optimized code to an object's shape, so a key added midway through the
   * build throws away the compiled form of every function that has read W.index. Named here, the shape never changes.
   * @returns {object} The index, with only what loading knows filled in.
   */
  function emptyIndex(d, per, arena) {
    return {
      moves: tableOf(d, 'moves'), trees: tableOf(d, 'trees'), per: per, arena: arena, ids: TLV.world.geom._idArena(ID_CHUNK),
      tmpPoint: null, tmpPoint2: null, tmpProject: null, lineA: null, lineB: null, lineC: null, lineD: null,
      kerbTrim: null, laneBack: null, laneBox: null, tmpBox: null, arms: null, ringEdges: null, connShort: null, walledConns: null, sharpConns: null,
      connSharp: 0.5, connKink: 0.5, connKinkCos: 0.5, connEnds: null, connWalled: null, straightCrossings: null,
      xingSlots: null, colliderGrid: null, colliderStamps: null, laneGrid: null, laneStamps: null, edgeGrid: null,
      edgeStamps: null, buildingGrid: null, poiGrid: null, sensitive: null, propGrid: null, connGrid: null, connStamps: null,
      juncGrid: null, surface: null, sidewalkGrid: null, swMoved: null, route: null, road: null, stallList: null, stallGrid: null,
      stallRows: null, maxKerbOff: 0.5, spotLanes: null, spotBoxA: null, spotBoxB: null, stallNear: null, stallReach: 0.5,
      kerbsByEdge: null, stalls: null, laneColliderResult: undefined, contacts: null
    };
  }

  /**
   * Decodes a payload into a World holding the map's static tables. A schema major mismatch is a hard error, because the
   * codec does not check it.
   * @param {object} payload Map container.
   * @returns {object} A World whose derived tables are still empty.
   */
  map._load = function (payload) {
    var schema = payload.schema || [];
    if (schema[0] !== SCHEMA_MAJOR) {
      throw new Error('Map "' + payload.id + '" has schema ' + schema.join('.') + ', and this build reads ' + SCHEMA_MAJOR +
        '.x. Re-import it with: node tools/import.mjs ' + payload.id);
    }
    var d = TLV.mapCodec.decodeAll(payload);
    var unit = d.meta.unit;
    // Divided, not multiplied: 24 / 10 is exactly 2.4, and 24 * 0.1 is not, and tests and tuning compare these.
    var per = 1 / unit;
    var b = d.meta.bounds;
    var arena = TLV.world.geom._arena(ARENA_CHUNK);
    var W = {
      id: d.id,
      meta: d.meta,
      bounds: { minX: b[0], minY: b[1], maxX: b[2], maxY: b[3] },
      strings: d.strings,
      juncs: loadJuncs(d, per),
      edges: loadEdges(d, per, arena),
      dirEdges: [],
      lanes: [],
      conns: [],
      ctrls: [],
      zones: [],
      xings: loadCrossings(d, per),
      stops: loadStops(d, per),
      blds: loadBuildings(d, per, arena),
      pois: loadPois(d, per),
      kerbs: loadKerbs(d, per),
      lots: loadLots(d, per, arena),
      land: loadLand(d, per, arena),
      paths: loadPaths(d, per, arena),
      walls: loadWalls(d, per, arena),
      sidewalks: [],
      props: [],
      colliders: null,
      index: emptyIndex(d, per, arena)
    };
    W.colliders = buildColliders(W);
    return W;
  };
})(window.TLV);
