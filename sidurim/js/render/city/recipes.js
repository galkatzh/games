// js/render/city/recipes.js — WP-RENDER
// Turns a building row into Parts: plain numbers and strings, no THREE, so it runs and is tested in Node (section 12.8).
// Stability: every slot has its own stream from the OSM ID, never the row index (section 14.7).
(function (TLV) {
  'use strict';

  var recipes = TLV.ns('render.city.recipes');

  var NO_COLLIDER = 1;
  var GLASS = 2;
  var BOX_M = 24;       // Cell of the building grid

  /** Used when no content is loaded, and as the bottom rung of the landmark ladder. */
  var DEFAULT_STYLE = recipes.DEFAULT_STYLE = {
    id: 'default',
    tiles: { wall: 'wall_default', ground: 'ground_default', shop: 'shop_default', side: 'wall_default' },
    palette: ['#ece4d4', '#e6dcc8', '#f1ebdf'],
    bayM: 3.4,
    floorM: 3.1,
    balconyEvery: 3,
    slots: {}
  };

  /** Numbers recipes need. Node never loads js/render/tune.js. */
  function N() {
    var T = TLV.tune.render;
    return T || {
      groundM: 3.6, corniceM: 0.5, bayMinFraction: 0.6, defaultFloorsMin: 3, defaultFloorsSpan: 3, liftBaseM: 5.5,
      liftDeckM: 3.1, liftPostSpacingM: 11, canopyZM: 5, canopyMaxZM: 12.4, canopySlabM: 0.32, canopyPostSpacingM: 9,
      awningTints: [0xb5362c], awningChance: 0.45,
      frontage: { reachM: 20, wallMinM: 3, gardenMinM: 0.8, gardenMaxM: 5, pathM: 1.6, pathMinLenM: 10, overlapM: 1.2, lowWallStepM: 1.5, lowWallMinM: 3, bedProbeM: 0.6 },
      sharedWall: { dot: 0.9994, offM: 0.12, minM: 0.3, sliverM: 0.25 }
    };
  }

  /** Per-world row caches. World rows are frozen in spirit, so this sits beside them. */
  var cache = new WeakMap();
  var primed = { W: null, id: -1, walls: null };    // Low walls recipes.buildingSteps has just read, for the recipes.building that follows it
  function rowsOf(W) {
    var c = cache.get(W);
    if (!c) {
      c = { areas: new Float32Array(W.blds.length), poisByBld: null, frontage: new Map(), boxes: null, shared: new Map(), marks: new Int32Array(W.blds.length), mark: 0, heights: new Array(W.blds.length), planned: new Map() };
      cache.set(W, c);
    }
    return c;
  }

  /** The stream for a slot. */
  function slotRng(b, slot) {
    return TLV.rng.create(TLV.rng.hash32(b.osm, TLV.rng.hashStr(slot)));
  }
  recipes.slotRng = slotRng;

  /** @returns {number} Footprint area of the outer ring, m². */
  recipes.area = function (W, b) {
    var c = rowsOf(W);
    if (c.areas[b.id] > 0) return c.areas[b.id];
    var r = b.rings[0];
    var n = r.length >> 1;
    var a = 0;
    for (var i = 0, j = n - 1; i < n; j = i++) a += r[j * 2] * r[i * 2 + 1] - r[i * 2] * r[j * 2 + 1];
    a = Math.abs(a) / 2;
    c.areas[b.id] = a;
    return a;
  };

  /**
   * How a row stands. A NO_COLLIDER row is never a solid block from the ground: a car can pass through it.
   * @param {object} W World.
   * @param {object} b Building.
   * @returns {string} 'solid', 'lifted' or 'canopy'.
   */
  recipes.form = function (W, b) {
    if (!(b.flags & NO_COLLIDER)) return 'solid';
    var S = TLV.render.styles;
    return S && S.isCanopy && S.isCanopy(b) ? 'canopy' : 'lifted';
  };

  /**
   * Base, top and floor count of a row, the same for shells, skyline and the baked sun mask.
   * @param {object} W World.
   * @param {object} b Building.
   * @returns {{form:string, base:number, top:number, floors:number}} Metres above ground.
   */
  recipes.heights = function (W, b) {
    var c = rowsOf(W);
    return c.heights[b.id] || (c.heights[b.id] = heightsOf(W, b));
  };

  function heightsOf(W, b) {
    var T = N();
    var form = recipes.form(W, b);
    if (form === 'canopy') {
      var z = Math.max(T.canopyZM, Math.min(T.canopyMaxZM, b.h || T.canopyZM));
      return { form: form, base: z - T.canopySlabM, top: z, floors: 0 };
    }
    if (form === 'lifted') {
      var base = T.liftBaseM;
      var top = b.h > 0 ? Math.max(b.h, base + T.liftDeckM) : base + T.liftDeckM;
      return { form: form, base: base, top: top, floors: Math.max(1, Math.round((top - base) / 3.1)) };
    }
    if (b.h > 0) return { form: form, base: 0, top: b.h, floors: b.levels || Math.max(1, Math.round(b.h / 3.1)) };
    var area = recipes.area(W, b);
    var rng = slotRng(b, 'bld.height');
    var floors;
    if (area < 28) floors = 1;
    else if (area < 70) floors = 1 + rng.int(2);
    else if (b.kind === 9) floors = 2;
    else if (b.kind === 4 || b.kind === 2) floors = 2 + rng.int(3);
    else floors = T.defaultFloorsMin + rng.int(T.defaultFloorsSpan);
    return { form: form, base: 0, top: T.groundM + (floors - 1) * 3.1 + T.corniceM, floors: floors };
  }

  /** Even-odd test on a flat ring. */
  function inRing(x, y, r) {
    var c = false;
    var n = r.length >> 1;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var yi = r[i * 2 + 1], yj = r[j * 2 + 1];
      if ((yi > y) !== (yj > y) && x < (r[j * 2] - r[i * 2]) * (y - yi) / (yj - yi) + r[i * 2]) c = !c;
    }
    return c;
  }
  recipes.inRing = inRing;

  /** @returns {Map<number,object[]>} POIs by building, walled ones only. A school or a synagogue is no shop. */
  function poisOf(W) {
    var c = rowsOf(W);
    if (!c.poisByBld) {
      c.poisByBld = new Map();
      var skip = TLV.const.POIF.SENSITIVE;
      for (var i = 0; i < W.pois.length; i++) {
        var p = W.pois[i];
        if (p.bld < 0 || p.wall < 0 || (p.flags & skip)) continue;
        var list = c.poisByBld.get(p.bld);
        if (!list) c.poisByBld.set(p.bld, list = []);
        list.push(p);
      }
    }
    return c.poisByBld;
  }
  recipes.poisOf = poisOf;

  /** Building rows by grid cell, by bounding box, so a row can find what touches it without reading the map. */
  function boxGrid(W) {
    var c = rowsOf(W);
    if (c.boxes) return c.boxes;
    var g = new Map();
    for (var id = 0; id < W.blds.length; id++) {
      var b = W.blds[id];
      if (!b.rings || !b.rings[0]) continue;
      for (var cx = Math.floor(b.minX / BOX_M); cx <= Math.floor(b.maxX / BOX_M); cx++) {
        for (var cy = Math.floor(b.minY / BOX_M); cy <= Math.floor(b.maxY / BOX_M); cy++) {
          var key = (cx + 2048) * 8192 + cy + 2048;
          var list = g.get(key);
          if (!list) g.set(key, list = []);
          list.push(id);
        }
      }
    }
    c.boxes = g;
    return g;
  }

  /** Builds the row indexes now, at load, so a chunk's first slice does not pay for them. */
  recipes.prepare = function (W) {
    boxGrid(W);
  };

  /** @returns {number[]} Rows whose boxes touch this one's, itself left out. */
  function touching(W, b, pad) {
    var g = boxGrid(W);
    var c = rowsOf(W);
    var mark = ++c.mark;
    var marks = c.marks;
    var out = [];
    for (var cx = Math.floor((b.minX - pad) / BOX_M); cx <= Math.floor((b.maxX + pad) / BOX_M); cx++) {
      for (var cy = Math.floor((b.minY - pad) / BOX_M); cy <= Math.floor((b.maxY + pad) / BOX_M); cy++) {
        var list = g.get((cx + 2048) * 8192 + cy + 2048);
        for (var i = 0; list && i < list.length; i++) {
          var id = list[i];
          if (marks[id] === mark) continue;
          marks[id] = mark;
          var o = W.blds[id];
          if (id !== b.id && o.minX <= b.maxX + pad && o.maxX >= b.minX - pad && o.minY <= b.maxY + pad && o.maxY >= b.minY - pad) out.push(id);
        }
      }
    }
    return out;
  }

  /** @returns {boolean} True when a mapped shop stands on this stretch of a wall. Its sign is on this wall, so its front should be. */
  function shopOn(W, id, ring, wall, t0, t1) {
    if (ring !== 0) return false;
    var list = poisOf(W).get(id);
    var INTERIOR = TLV.const.POIF.INTERIOR;
    for (var i = 0; list && i < list.length; i++) {
      var p = list[i];
      if (p.wall === wall && !(p.flags & INTERIOR) && p.t >= t0 && p.t <= t1) return true;
    }
    return false;
  }

  /** @returns {number} Top of a row's ground floor. */
  function groundTopOf(h, T) {
    return Math.min(T.groundM, h.top - 0.5);
  }

  /**
   * Where another building walls the same plane as this one. A podium and its tower often share OSM nodes, and two facades on one
   * plane stipple each other across a whole shop row. Each stretch is given to one owner: the taller building keeps the storeys
   * above the ground floor, and the ground floor goes with the mapped shop, or to the taller building when that says nothing.
   * Both sides reach the same answer, so a stretch is never drawn twice and never dropped twice.
   * @param {object} W World.
   * @param {number} id Row.
   * @returns {?object[]} { ring, wall, t0, t1, other, upper, ground }: upper and ground are true where this row gives way. Null for none.
   */
  function sharedWalls(W, id) {
    var cache = rowsOf(W).shared;
    var got = cache.get(id);
    if (got !== undefined) return got;
    got = null;
    var T = N();
    var C = T.sharedWall;
    var b = W.blds[id];
    var formB = recipes.form(W, b);
    var hb = recipes.heights(W, b);
    var near = touching(W, b, C.offM);
    for (var q = 0; q < near.length; q++) {
      var o = W.blds[near[q]];
      var formO = recipes.form(W, o);
      // A deck or a canopy hung on a solid building gives way to it, and two of them never share a wall worth keeping.
      if (formB !== 'solid' && formO !== 'solid') continue;
      var ho = recipes.heights(W, o);
      var taller = formB !== formO ? formB === 'solid' : hb.top > ho.top || (hb.top === ho.top && id < o.id);
      for (var ri = 0; ri < b.rings.length; ri++) {
        var r = b.rings[ri];
        var n = r.length >> 1;
        for (var i = 0; i < n; i++) {
          var k = (i + 1) % n;
          var ax = r[i * 2], ay = r[i * 2 + 1];
          var dx = r[k * 2] - ax, dy = r[k * 2 + 1] - ay;
          var L = Math.sqrt(dx * dx + dy * dy);
          if (L < 0.05) continue;
          // A wall that stays clear of the other row's box cannot lie on any of its walls.
          var reach = C.offM + 0.01;
          if (Math.max(ax, ax + dx) < o.minX - reach || Math.min(ax, ax + dx) > o.maxX + reach ||
              Math.max(ay, ay + dy) < o.minY - reach || Math.min(ay, ay + dy) > o.maxY + reach) continue;
          var ux = dx / L, uy = dy / L;
          for (var rj = 0; rj < o.rings.length; rj++) {
            var r2 = o.rings[rj];
            var m = r2.length >> 1;
            for (var p = 0; p < m; p++) {
              var e = (p + 1) % m;
              var cx = r2[p * 2], cy = r2[p * 2 + 1], ex = r2[e * 2], ey = r2[e * 2 + 1];
              var M = Math.sqrt((ex - cx) * (ex - cx) + (ey - cy) * (ey - cy));
              if (M < 0.05 || (ex - cx) / M * ux + (ey - cy) / M * uy < C.dot) continue;
              var s0 = (cx - ax) * ux + (cy - ay) * uy, s1 = (ex - ax) * ux + (ey - ay) * uy;
              var d0 = -uy * (cx - ax) + ux * (cy - ay), d1 = -uy * (ex - ax) + ux * (ey - ay);
              var lo = Math.max(0, s0), hi = Math.min(L, s1);
              if (hi - lo < C.minM) continue;
              // Read the gap over the overlap, not at the far ends: a long wall 1 degree off a short one still lies on it. This way
              // both buildings measure the same stretch and reach the same answer.
              var slope = (d1 - d0) / (s1 - s0);
              if (Math.abs(slope) > 1e-6) {
                var sa = s0 + (-C.offM - d0) / slope, sb = s0 + (C.offM - d0) / slope;
                lo = Math.max(lo, Math.min(sa, sb));
                hi = Math.min(hi, Math.max(sa, sb));
              } else if (Math.abs(d0) > C.offM) {
                continue;
              }
              if (hi - lo < C.minM) continue;
              var t0 = lo / L, t1 = hi / L;
              var mine = shopOn(W, id, ri, i, t0, t1);
              var theirs = shopOn(W, o.id, rj, p, (lo - s0) / M, (hi - s0) / M);
              // A short building's ground floor cannot stand in for a taller one's: there would be a gap above it.
              var keepGround = taller;
              if (formB === formO && mine !== theirs && groundTopOf(hb, T) === groundTopOf(ho, T)) keepGround = mine;
              if (taller && keepGround) continue;
              (got || (got = [])).push({ ring: ri, wall: i, t0: t0, t1: t1, other: o.id, upper: !taller, ground: !keepGround });
            }
          }
        }
      }
    }
    cache.set(id, got);
    return got;
  }

  /** @returns {?number[]} Sorted, merged t0, t1 pairs. Slivers at the wall's ends and between two cuts join the cut. */
  function mergeCuts(list, len, sliverM) {
    if (!list.length) return null;
    list.sort(function (a, b) { return a[0] - b[0]; });
    var gap = sliverM / len;
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var a = list[i][0], b = list[i][1];
      if (a < gap) a = 0;
      if (b > 1 - gap) b = 1;
      var last = out.length - 1;
      if (last > 0 && a <= out[last] + gap) out[last] = Math.max(out[last], b);
      else out.push(a, b);
    }
    return out;
  }

  /** Writes the stretches another building draws onto this row's walls. */
  function applyShared(W, id, walls, T) {
    var list = sharedWalls(W, id);
    if (!list) return;
    var hides = TLV.render.landmarks && TLV.render.landmarks.hidesShell;
    for (var w = 0; w < walls.length; w++) {
      var wl = walls[w];
      var up = [], gr = [];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (c.ring !== wl.ring || c.wall !== wl.i) continue;
        if (hides && TLV.render.landmarks.hidesShell(c.other)) continue;      // That shell is not drawn, so it covers nothing
        if (c.upper) up.push([c.t0, c.t1]);
        if (c.ground) gr.push([c.t0, c.t1]);
      }
      wl.cutUpper = mergeCuts(up, wl.len, T.sharedWall.sliverM);
      wl.cutGround = mergeCuts(gr, wl.len, T.sharedWall.sliverM);
    }
  }

  /** @returns {boolean} True when a point on a wall falls in a stretch cut from it. */
  function inCuts(cuts, t) {
    for (var i = 0; cuts && i + 1 < cuts.length; i += 2) {
      if (t >= cuts[i] && t <= cuts[i + 1]) return true;
    }
    return false;
  }

  /** Walls of every ring. Outer rings run CCW and holes CW, so outward is always right of direction. */
  function wallsOf(b, style, floorsZ, T) {
    var out = [];
    for (var ri = 0; ri < b.rings.length; ri++) {
      var r = b.rings[ri];
      var n = r.length >> 1;
      for (var i = 0; i < n; i++) {
        var k = (i + 1) % n;
        var ax = r[i * 2], ay = r[i * 2 + 1], bx = r[k * 2], by = r[k * 2 + 1];
        var dx = bx - ax, dy = by - ay;
        var len = Math.sqrt(dx * dx + dy * dy);
        if (len < 0.05) continue;
        var bays = Math.round(len / style.bayM);
        out.push({
          ring: ri, i: i, ax: ax, ay: ay, bx: bx, by: by, len: len, nx: dy / len + 0, ny: -dx / len + 0,
          bays: bays,
          plain: len < style.bayM * T.bayMinFraction,
          front: ri === 0 && b.front ? b.front[i] : 0,
          tile: null,
          groundTile: null,
          groundRuns: null,
          cutUpper: null,      // Stretches another building draws: t0, t1 pairs along the wall, in order
          cutGround: null
        });
      }
    }
    return out;
  }

  /** The tile for a POI. Node has no kit, so the style's shop tile stands. */
  function shopTile(kind, tiles) {
    var S = TLV.render.styles;
    return (S && S.shopTile && S.shopTile(kind)) || tiles.shop;
  }

  /** A tile for a shop nobody mapped. */
  function fillerTile(rng, tiles) {
    var S = TLV.render.styles;
    return (S && S.shopFiller && S.shopFiller(rng.next())) || tiles.shop;
  }

  /**
   * A shop wall's ground floor as runs of bays. Each POI gets the bays under its sign, in the tile of its kind, and what is
   * left goes to unmapped shops in short runs, so no street repeats one window.
   * @param {object} wl Wall.
   * @param {?object[]} list POIs on this wall.
   * @param {object} tiles The style's tiles.
   * @param {object} rng The bld.ground stream.
   * @returns {{from:number,to:number,tile:string}[]} Runs in bay order, covering the wall.
   */
  function shopRuns(wl, list, tiles, rng) {
    var n = Math.max(1, wl.bays);
    var at = new Array(n).fill(null);
    var INTERIOR = TLV.const.POIF.INTERIOR;
    for (var i = 0; list && i < list.length; i++) {
      var p = list[i];
      if (p.flags & INTERIOR) continue;
      var c = p.t * n;
      var half = Math.max(0.5, (p.w || 3) / wl.len * n / 2);
      var a = Math.max(0, Math.min(n - 1, Math.floor(c - half + 0.3)));
      var b = Math.max(a + 1, Math.min(n, Math.ceil(c + half - 0.3)));
      var tile = shopTile(p.kind, tiles);
      for (var k = a; k < b; k++) if (!at[k]) at[k] = tile;
    }
    for (var q = 0; q < n;) {
      if (at[q]) {
        q++;
        continue;
      }
      var len = 1 + rng.int(3);
      var fill = fillerTile(rng, tiles);
      for (var m = 0; m < len && q < n && !at[q]; m++) at[q++] = fill;
    }
    var runs = [];
    for (var r = 0; r < n; r++) {
      var last = runs[runs.length - 1];
      if (last && last.tile === at[r]) last.to = r + 1;
      else runs.push({ from: r, to: r + 1, tile: at[r] });
    }
    return runs;
  }

  /** Decides each wall's ground floor. One stream, so a building's shops are the same wherever they are asked for. */
  function planGround(W, b, style, tiles, walls) {
    var pois = poisOf(W).get(b.id);
    var groundRng = slotRng(b, 'bld.ground');
    var SF = TLV.render.storefronts;
    var plainWalls = !!(SF && SF.forced && SF.forced() === SF.RUNG.PLAIN);   // The last rung of the storefront ladder
    for (var w = 0; w < walls.length; w++) {
      var wl = walls[w];
      wl.tile = tiles.wall;
      if (wl.plain) continue;
      if (plainWalls) {
        wl.groundTile = tiles.side || tiles.wall;
        continue;
      }
      var here = null;
      if (pois && wl.ring === 0) {
        for (var p = 0; p < pois.length; p++) {
          if (pois[p].wall === wl.i) (here || (here = [])).push(pois[p]);
        }
      }
      var chance = style.shopChance === undefined ? 0.45 : style.shopChance;
      var shop = !!here;
      if (!shop && wl.front > 0 && wl.front <= 3 && tiles.shop && groundRng.next() < chance) shop = true;
      if (shop && chance > 0 && wl.bays >= 1) {
        wl.groundTile = tiles.shop;
        wl.groundRuns = shopRuns(wl, here, tiles, groundRng);
      } else if (shop) {
        wl.groundTile = tiles.shop;     // A style with no shops keeps its own wall, POI or not
      } else if (wl.front > 0) {
        wl.groundTile = tiles.ground;
      } else {
        wl.groundTile = tiles.side || tiles.wall;
      }
    }
  }

  /**
   * What stands between a building and the street, wall by wall: paving to the door on a shop wall, a front garden on the rest.
   * Roads and sidewalks paint over any overshoot, so each wall only has to reach as far as its furthest sample.
   * @param {object} W World.
   * @param {number} id Row.
   * @param {?string} styleId Style.
   * @returns {{ax:number,ay:number,bx:number,by:number,nx:number,ny:number,len:number,shop:boolean,near:number,far:number}[]}
   *   One row per street wall. near and far are the least and most metres from the wall to the sidewalk's back edge.
   */
  recipes.frontage = function (W, id, styleId) {
    var cache = rowsOf(W).frontage;
    var got = cache.get(id);
    if (got) return got;
    var out = [];
    cache.set(id, out);
    var b = W.blds[id];
    if (recipes.form(W, b) !== 'solid' || !b.front) return out;
    var S = TLV.render.styles;
    var style = (styleId && S && S.get && S.get(styleId)) || DEFAULT_STYLE;
    var tiles = style.tiles || DEFAULT_STYLE.tiles;
    var F = N().frontage;
    var walls = wallsOf(b, style, 0, N());
    planGround(W, b, style, tiles, walls);
    rowsOf(W).planned.set(id, { styleId: styleId, walls: walls });       // recipes.building would work out the same walls again
    var q = { sw: 0, s: 0, d: 0 };
    var nearest = TLV.world.sidewalks.nearest;
    var RD = TLV.render.roads;
    var walkGap = RD && RD.walkGap;       // The same answer, from an index, as far as the answer matters. Node without roads has only this
    for (var i = 0; i < walls.length; i++) {
      var wl = walls[i];
      if (wl.ring !== 0 || !wl.front || wl.len < F.wallMinM) continue;
      var near = Infinity;
      var far = -Infinity;
      for (var t = 0; t < 3; t++) {
        var k = 0.12 + t * 0.38;
        var x = wl.ax + (wl.bx - wl.ax) * k + wl.nx * 0.4;
        var y = wl.ay + (wl.by - wl.ay) * k + wl.ny * 0.4;
        var g;
        if (walkGap) {
          g = walkGap(W, x, y, F.reachM) + 0.4;
        } else {
          var r = nearest(W, x, y, q);
          if (!r) continue;
          g = r.d - W.sidewalks[r.sw].width / 2 + 0.4;
        }
        near = Math.min(near, g);
        far = Math.max(far, g);
      }
      if (near > F.reachM || far < 0) continue;
      out.push({
        ax: wl.ax, ay: wl.ay, bx: wl.bx, by: wl.by, nx: wl.nx, ny: wl.ny, len: wl.len, wall: wl.i,
        // A style can use a shop tile for its whole ground floor, the towers' banks, and that wall gets the paving of a shop.
        shop: !!wl.groundRuns || !!(wl.groundTile && /^shop/.test(wl.groundTile)),
        near: Math.max(0, near), far: Math.min(F.reachM, far)
      });
    }
    return out;
  };

  /** @returns {?object[]} The rows of recipes.frontage if a row has been measured, or null. */
  recipes.frontageRead = function (W, id) {
    return rowsOf(W).frontage.get(id) || null;
  };

  /** @returns {boolean} True when a measured row has a shop wall. */
  recipes.frontageShops = function (W, id) {
    var rows = rowsOf(W).frontage.get(id);
    for (var i = 0; rows && i < rows.length; i++) if (rows[i].shop) return true;
    return false;
  };

  /**
   * Depth of the front garden of a frontage row.
   * @param {object} f Row of recipes.frontage.
   * @returns {number} Metres from the wall, 0 for none.
   */
  recipes.gardenDepth = function (f) {
    var F = N().frontage;
    if (f.shop || f.near < F.gardenMinM) return 0;
    return Math.min(F.gardenMaxM, f.near - 0.1);
  };

  /**
   * The shop forecourts that could lie over this building's gardens. They are painted after every bed, so a garden under one is
   * gone, and a wall along it would stand alone on the paving. A generator: a neighbour's walls may not have been read yet.
   * @param {object} W World.
   * @param {number} id Row.
   * @param {object[]} out Gets the frontage rows, shop rows only, of this building and its neighbours.
   */
  function* forecourtsNear(W, id, out) {
    var F = N().frontage;
    var S = TLV.render.styles;
    var ids = touching(W, W.blds[id], F.reachM + 2);
    ids.push(id);
    var cache = rowsOf(W).frontage;
    for (var i = 0; i < ids.length; i++) {
      var rows = cache.get(ids[i]);
      if (!rows) {
        rows = recipes.frontage(W, ids[i], S && S.choose ? S.choose(W, ids[i]) : null);
        yield;
      }
      for (var k = 0; k < rows.length; k++) if (rows[k].shop) out.push(rows[k]);
    }
  }

  /** @returns {boolean} True when a shop row's forecourt covers a point. */
  function onForecourt(r, x, y, F) {
    var px = x - r.ax, py = y - r.ay;
    var along = (px * (r.bx - r.ax) + py * (r.by - r.ay)) / r.len;
    var out = px * r.nx + py * r.ny;
    return along >= -F.overlapM && along <= r.len + F.overlapM && out >= 0 && out <= r.far + 0.6;
  }

  /**
   * Low walls, only along a bed that shows: a wall is the rim of a garden. Each row is read in steps, and a step counts only if
   * the wall's own line is clear and a planted bed lies behind it. Anything shorter than a stretch of wall is dropped. A generator,
   * because a step asks several indexes and a corner block has hundreds of steps.
   * @param {object} W World.
   * @param {number} id Row.
   * @param {?string} styleId Style.
   * @param {number[]} out Gets ax, ay, bx, by, nx, ny per wall.
   */
  function* lowWallSteps(W, id, styleId, out) {
    var rows = recipes.frontage(W, id, styleId);
    var F = N().frontage;
    if (!rows.length) return;
    var surf = TLV.world.surface;
    var ROAD = TLV.const.SURF.ROAD;
    var RD = TLV.render.roads;
    var paved = RD && RD.paved;
    var spatial = TLV.world.spatial;
    var pavedOver = RD && RD.pavedOver;
    var courts = null;
    function onCourt(x, y) {
      for (var c = 0; c < courts.length; c++) if (onForecourt(courts[c], x, y, F)) return true;
      return false;
    }
    function walled(f, d, t) {
      var x = f.ax + (f.bx - f.ax) * t + f.nx * d, y = f.ay + (f.by - f.ay) * t + f.ny * d;
      if (surf.at(W, x, y) === ROAD || onCourt(x, y) || (paved && paved(W, x, y))) return false;
      // The bed has to show right behind the wall and go on showing: a sliver of green is not a garden. A sidewalk can run behind
      // the wall's line as well as in front of it, so the far probe asks about sidewalks too.
      var near = Math.min(F.bedProbeM * 0.4, d * 0.25), far = Math.min(F.bedProbeM, d * 0.5);
      var ax = x - f.nx * near, ay = y - f.ny * near, bx = x - f.nx * far, by = y - f.ny * far;
      if (onCourt(ax, ay) || onCourt(bx, by)) return false;
      if ((pavedOver && pavedOver(W, ax, ay)) || (paved && paved(W, bx, by))) return false;
      return spatial.pointInBuilding(W, bx, by) < 0;
    }
    for (var i = 0; i < rows.length; i++) {
      var f = rows[i];
      var d = recipes.gardenDepth(f);
      if (!d) continue;
      if (!courts) {
        courts = [];
        yield* forecourtsNear(W, id, courts);
      }
      var path = f.len >= F.pathMinLenM;
      var p0 = 0.5 - F.pathM / 2 / f.len, p1 = 0.5 + F.pathM / 2 / f.len;
      var n = Math.max(2, Math.ceil(f.len / F.lowWallStepM));
      var from = -1, last = -1;
      for (var q = 0; q <= n + 1; q++) {
        if ((q & 15) === 15) yield;
        var t = q / n;
        var ok = q <= n && !(path && t > p0 && t < p1) && walled(f, d, t);
        if (ok) {
          if (from < 0) from = t;
          last = t;
        } else if (from >= 0) {
          if ((last - from) * f.len >= F.lowWallMinM) {
            out.push(f.ax + (f.bx - f.ax) * from + f.nx * d, f.ay + (f.by - f.ay) * from + f.ny * d,
              f.ax + (f.bx - f.ax) * last + f.nx * d, f.ay + (f.by - f.ay) * last + f.ny * d, f.nx, f.ny);
          }
          from = -1;
        }
      }
    }
  }

  /** @returns {number[]} The low walls of a row: those buildingSteps has just read, or else read now. */
  function lowWallsOf(W, id, styleId) {
    var out = primed.walls;
    if (primed.W === W && primed.id === id) {
      primed.W = primed.walls = null;
      primed.id = -1;
      return out;
    }
    out = [];
    var it = lowWallSteps(W, id, styleId, out);
    while (!it.next().done);
    return out;
  }

  /**
   * What recipes.building has to read about a row's neighbours, a piece at a time, so the frame budget can stop between them. Run
   * it to the end and the building call that follows finds it done. The answer is the same with or without it.
   * @param {object} W World.
   * @param {number} id Row.
   * @param {?string} styleId Style.
   */
  recipes.buildingSteps = function* (W, id, styleId) {
    var c = rowsOf(W);
    if (!c.shared.has(id)) {
      sharedWalls(W, id);
      yield;
    }
    if (recipes.heights(W, W.blds[id]).form !== 'solid') return;
    if (!c.frontage.has(id)) {
      recipes.frontage(W, id, styleId);
      yield;
    }
    var out = [];
    yield* lowWallSteps(W, id, styleId, out);
    primed.W = W;
    primed.id = id;
    primed.walls = out;
  };

  /** Tints a palette entry; a building:colour tag wins when it parses. */
  function pickTint(b, style) {
    if (b.colour && /^#[0-9a-f]{6}$/i.test(b.colour)) return b.colour;
    var names = TLV.render.styles && TLV.render.styles.colourNames;
    if (b.colour && names && names[b.colour]) return names[b.colour];
    var pal = style.palette && style.palette.length ? style.palette : DEFAULT_STYLE.palette;
    return pal[slotRng(b, 'facade.tile').int(pal.length)];
  }

  /** The providers for a slot in this style, best first. Node has none: the built-ins below run. */
  function providers(slot, style) {
    var S = TLV.render.styles;
    return S && S.providers ? S.providers(slot, style) : [];
  }

  /** Runs a slot's providers. A throwing provider is caught and the next one runs (section 14.7). */
  function runSlot(slot, style, ctx, out, builtin) {
    var list = providers(slot, style);
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.when && p.when.roof !== undefined && p.when.roof !== ctx.roofName) continue;
      if (!p.emit) continue;
      try {
        p.emit(ctx, out);
        return true;
      } catch (e) {
        if (TLV.registry) TLV.registry.problem('kit', p.id, 'provider threw: ' + (e && e.message));
      }
    }
    if (builtin) builtin(ctx, out);
    return false;
  }

  /**
   * Runs the best provider of a street-level slot, which belongs to no style. A throw falls to the next, then the built-in.
   * @param {string} slot Slot ID.
   * @param {object} ctx Passed to emit.
   * @param {object} out Has instance().
   * @param {function(object, object):void} builtin Used when no provider answers.
   */
  recipes.runKit = function (slot, ctx, out, builtin) {
    var S = TLV.render.styles;
    var list = S && S.kit ? S.kit(slot) : [];
    for (var i = 0; i < list.length; i++) {
      if (!list[i].emit) continue;
      try {
        list[i].emit(ctx, out);
        return;
      } catch (e) {
        TLV.registry.problem('kit', list[i].id, 'provider threw: ' + (e && e.message));
      }
    }
    builtin(ctx, out);
  };

  /** A point on the roof, or null after a few tries. */
  function roofPoint(b, rng, inset) {
    var r = b.rings[0];
    for (var t = 0; t < 6; t++) {
      var x = b.minX + inset + rng.next() * (b.maxX - b.minX - 2 * inset);
      var y = b.minY + inset + rng.next() * (b.maxY - b.minY - 2 * inset);
      if (inRing(x, y, r) && inRing(x + inset, y, r) && inRing(x - inset, y, r) && inRing(x, y + inset, r) && inRing(x, y - inset, r)) {
        return { x: x, y: y };
      }
    }
    return null;
  }
  recipes.roofPoint = roofPoint;

  /** Roof plant by area, built-in. Content adds its own through bld.rooftop. */
  function defaultRooftop(ctx, out) {
    var count = Math.min(4, Math.floor(ctx.area / 180));
    for (var i = 0; i < count; i++) {
      var p = roofPoint(ctx.b, ctx.rng, 1.2);
      if (p) out.instance('boiler', p.x, p.y, ctx.roofZ, ctx.rng.next() < 0.5 ? ctx.sunYaw : ctx.sunYaw + 0.1, 1);
    }
  }

  /** Balconies on street walls and AC on the side walls, built-in. */
  function defaultBalcony(ctx, out) {
    var w = ctx.wall;
    var mesh = ctx.style.balconyMesh || 'balcony';
    var every = ctx.style.balconyEvery || 0;
    var yaw = Math.atan2(w.ny, w.nx);
    if (w.front && every > 0 && w.bays >= 2) {
      for (var f = 0; f < ctx.upperFloors; f++) {
        var z = ctx.groundTop + f * ctx.floorM;
        for (var bay = 0; bay < w.bays; bay++) {
          if ((bay + (f & 1)) % every !== 0) continue;
          var t = (bay + 0.5) / w.bays;
          out.instance(mesh, w.ax + (w.bx - w.ax) * t, w.ay + (w.by - w.ay) * t, z, yaw, 1);
        }
      }
    } else if (!w.front && w.ring === 0 && w.bays >= 1 && ctx.rng.next() < 0.5) {
      var cnt = 1 + ctx.rng.int(Math.min(3, w.bays));
      for (var i = 0; i < cnt; i++) {
        var q = ctx.rng.next();
        var fl = ctx.rng.int(Math.max(1, ctx.upperFloors));
        out.instance('ac', w.ax + (w.bx - w.ax) * q, w.ay + (w.by - w.ay) * q, ctx.groundTop + fl * ctx.floorM + 0.3, yaw, 1);
      }
    }
  }

  /** An awning over some shop doors, built-in. */
  function defaultGround(ctx, out) {
    var T = N();
    var b = ctx.b;
    var r = b.rings[0];
    var n = r.length >> 1;
    for (var i = 0; i < ctx.pois.length; i++) {
      var p = ctx.pois[i];
      if ((p.flags & TLV.const.POIF.INTERIOR) || ctx.rng.next() >= T.awningChance) continue;
      var a = p.wall % n, c = (a + 1) % n;
      var ax = r[a * 2], ay = r[a * 2 + 1], bx = r[c * 2], by = r[c * 2 + 1];
      var dx = bx - ax, dy = by - ay;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len < 3) continue;
      var tint = T.awningTints[ctx.rng.int(T.awningTints.length)];
      out.instance('awning', ax + dx * p.t, ay + dy * p.t, 2.62, Math.atan2(-dx, dy), 1, tint);
    }
  }

  /** Posts along the outer ring, off the road. Spacing is along the ring. */
  function postsOf(W, b, spacing, inset) {
    var out = [];
    var r = b.rings[0];
    var n = r.length >> 1;
    var surf = TLV.world.surface;
    var ROAD = TLV.const.SURF.ROAD;
    var carry = 0;
    for (var i = 0; i < n; i++) {
      var k = (i + 1) % n;
      var ax = r[i * 2], ay = r[i * 2 + 1], bx = r[k * 2], by = r[k * 2 + 1];
      var dx = bx - ax, dy = by - ay;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.2) continue;
      var nx = dy / len, ny = -dx / len;
      for (var s = carry; s < len; s += spacing) {
        var x = ax + dx * s / len - nx * inset;
        var y = ay + dy * s / len - ny * inset;
        carry = s + spacing - len;
        if (surf.at(W, x, y) !== ROAD) out.push(x, y);
      }
    }
    return out;
  }

  /**
   * Parts of one building.
   * @param {object} W World.
   * @param {number} bldId Row.
   * @param {string|null} styleId Style ID. Null uses the default style.
   * @returns {object} Parts: form, base, top, groundTop, cornice, tint, walls, roof, posts, instances.
   */
  recipes.building = function (W, bldId, styleId) {
    var T = N();
    var b = W.blds[bldId];
    var S = TLV.render.styles;
    var style = (styleId && S && S.get && S.get(styleId)) || DEFAULT_STYLE;
    var hh = recipes.heights(W, b);
    var tiles = style.tiles || DEFAULT_STYLE.tiles;
    var floorM = style.floorM || 3.1;
    var solid = hh.form === 'solid';
    var groundTop = hh.form === 'lifted' ? hh.base : Math.min(T.groundM, hh.top - 0.5);
    var cornice = Math.min(T.corniceM, (hh.top - hh.base) * 0.1);
    var wallBottom = solid ? groundTop : hh.base;
    var planned = solid ? rowsOf(W).planned.get(bldId) : null;
    var fresh = !planned || planned.styleId !== styleId;
    var walls = fresh ? wallsOf(b, style, 0, T) : planned.walls;
    if (planned) rowsOf(W).planned.delete(bldId);     // The walls go out with the Parts, and take cuts: nobody else may have them
    var upperH = hh.top - cornice - wallBottom;
    var upperFloors = Math.max(1, Math.round(upperH / floorM));
    if (hh.form === 'canopy') upperFloors = 0;
    var parts = {
      id: bldId,
      osm: b.osm,
      style: style.id,
      form: hh.form,
      base: hh.base,
      top: hh.top,
      groundTop: groundTop,
      wallBottom: wallBottom,
      cornice: cornice,
      upperFloors: upperFloors,
      tint: pickTint(b, style),
      walls: walls,
      roof: { kind: style.roof !== undefined ? style.roof : b.roof, colour: style.roofColour || null },
      posts: [],
      instances: [],
      lowWalls: [],
      glass: !!(b.flags & GLASS)
    };
    var pois = poisOf(W).get(bldId);
    if (solid) {
      if (fresh) planGround(W, b, style, tiles, walls);
      applyShared(W, bldId, walls, T);
      parts.lowWalls = lowWallsOf(W, bldId, styleId);
    } else {
      for (var w = 0; w < walls.length; w++) walls[w].tile = tiles.wall;
      applyShared(W, bldId, walls, T);
    }

    if (hh.form === 'lifted') {
      parts.posts = postsOf(W, b, T.liftPostSpacingM, 0.5);
    } else if (hh.form === 'canopy') {
      parts.posts = postsOf(W, b, T.canopyPostSpacingM, 0.6);
    }

    // Instanced details. Canopies carry none.
    if (hh.form !== 'canopy') {
      var out = {
        instance: function (mesh, x, y, z, yaw, scale, tint) {
          parts.instances.push({ mesh: mesh, x: x, y: y, z: z, yaw: yaw || 0, scale: scale || 1, tint: tint === undefined ? -1 : tint });
        }
      };
      var ctx = {
        W: W, b: b, style: style, area: recipes.area(W, b), roofZ: hh.top, groundTop: groundTop, floorM: floorM,
        upperFloors: upperFloors, roofName: parts.roof.kind === 1 ? 'pitched' : parts.roof.kind === 2 ? 'dome' : 'flat',
        rng: null, wall: null, pois: null, sunYaw: 0, parts: parts
      };
      var ts = TLV.render.sky && TLV.render.sky.toSun;
      ctx.sunYaw = ts ? Math.atan2(ts.y, ts.x) : Math.PI;
      ctx.rng = slotRng(b, 'bld.roof');
      runSlot('bld.roof', style, ctx, out, null);
      ctx.roofName = parts.roof.kind === 1 ? 'pitched' : parts.roof.kind === 2 ? 'dome' : 'flat';
      if (ctx.roofName === 'flat' && !parts.glass) {
        ctx.rng = slotRng(b, 'bld.rooftop');
        runSlot('bld.rooftop', style, ctx, out, defaultRooftop);
      }
      if (solid && pois) {
        ctx.rng = slotRng(b, 'bld.ground');
        ctx.pois = pois;
        runSlot('bld.ground', style, ctx, out, defaultGround);
      }
      if (solid && hh.top < 80 && !parts.glass) {
        ctx.rng = slotRng(b, 'bld.balcony');
        for (var i = 0; i < walls.length; i++) {
          var wb = walls[i];
          if (wb.plain) continue;
          var mark = parts.instances.length;
          ctx.wall = wb;
          runSlot('bld.balcony', style, ctx, out, defaultBalcony);
          // Whichever provider ran, nothing hangs off a stretch of wall that another building draws.
          if (wb.cutUpper) {
            var kept = mark;
            for (var q = mark; q < parts.instances.length; q++) {
              var I = parts.instances[q];
              var along = ((I.x - wb.ax) * (wb.bx - wb.ax) + (I.y - wb.ay) * (wb.by - wb.ay)) / (wb.len * wb.len);
              if (!inCuts(wb.cutUpper, along)) parts.instances[kept++] = I;
            }
            parts.instances.length = kept;
          }
        }
        ctx.wall = null;
      }
    }
    return parts;
  };
})(window.TLV);
