// js/render/city/chunks.js — WP-RENDER
// The 400 m grid: one ground mesh and one shell mesh per chunk (section 15.3). Nine chunks build at init, the rest in a
// spiral around the focus, 4 ms a frame. A build is a generator, so it stops wherever the slice runs out, and a slice is only as
// exact as its longest step: anything that reads a whole edge or a whole building yields inside, it does not run in one go.
(function (TLV) {
  'use strict';

  var chunks = TLV.ns('render.city.chunks');

  var S0 = null;
  var W0 = null;
  var sceneRef = null;
  var all = [];
  var built = [];
  var cols = 0;
  var rows = 0;
  var job = null;
  var jobChunk = null;
  var gbuf = null;
  var sbuf = null;
  var lastBuildMs = 0;
  var l1 = 700;
  var rearHidden = [];
  var rearNear = [];
  var rearA = { x: 0, y: 0, z: 0 };
  var rearB = { x: 0, y: 0, z: 0 };
  var rearDir = null;

  /** Performance clock, browser only. */
  function now() {
    return window.performance.now();
  }

  /** Cell of a point, clamped into the grid. */
  function cellOf(x, y) {
    var b = W0.bounds;
    var C = TLV.tune.render.chunkM;
    var cx = Math.max(0, Math.min(cols - 1, Math.floor((x - b.minX) / C)));
    var cy = Math.max(0, Math.min(rows - 1, Math.floor((y - b.minY) / C)));
    return cy * cols + cx;
  }

  /** Lists a row in every chunk its box touches. */
  function bin(listName, id, x0, y0, x1, y1) {
    var b = W0.bounds;
    var C = TLV.tune.render.chunkM;
    var cx0 = Math.max(0, Math.floor((x0 - b.minX) / C)), cx1 = Math.min(cols - 1, Math.floor((x1 - b.minX) / C));
    var cy0 = Math.max(0, Math.floor((y0 - b.minY) / C)), cy1 = Math.min(rows - 1, Math.floor((y1 - b.minY) / C));
    for (var cy = cy0; cy <= cy1; cy++) {
      for (var cx = cx0; cx <= cx1; cx++) all[cy * cols + cx].bin[listName].push(id);
    }
  }

  /** Bounding box of a polyline, expanded. */
  function polyBin(listName, id, px, py, pad) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var i = 0; i < px.length; i++) {
      if (px[i] < x0) x0 = px[i];
      if (px[i] > x1) x1 = px[i];
      if (py[i] < y0) y0 = py[i];
      if (py[i] > y1) y1 = py[i];
    }
    bin(listName, id, x0 - pad, y0 - pad, x1 + pad, y1 + pad);
  }

  /** Files every row under its chunks. */
  function binWorld(W) {
    var i;
    var fr = TLV.tune.render.frontage.reachM + 4;
    for (i = 0; i < W.blds.length; i++) {
      var bd = W.blds[i];
      all[cellOf(bd.cx, bd.cy)].bin.blds.push(i);
      if (bd.front && bd.front.some(function (v) { return v > 0; })) bin('fronts', i, bd.minX - fr, bd.minY - fr, bd.maxX + fr, bd.maxY + fr);
    }
    for (i = 0; i < W.edges.length; i++) {
      var e = W.edges[i];
      polyBin('edges', i, e.px, e.py, Math.max(e.kerbOffL, e.kerbOffR) + 2);
    }
    for (i = 0; i < W.juncs.length; i++) {
      var J = W.juncs[i];
      if (!J.poly) continue;
      var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (var k = 0; k + 1 < J.poly.length; k += 2) {
        x0 = Math.min(x0, J.poly[k]);
        x1 = Math.max(x1, J.poly[k]);
        y0 = Math.min(y0, J.poly[k + 1]);
        y1 = Math.max(y1, J.poly[k + 1]);
      }
      bin('juncs', i, x0 - 24, y0 - 24, x1 + 24, y1 + 24);   // Sidewalk corners reach past the polygon
    }
    for (i = 0; i < W.conns.length; i++) polyBin('conns', i, W.conns[i].px, W.conns[i].py, 4);
    for (i = 0; i < W.lanes.length; i++) polyBin('lanes', i, W.lanes[i].px, W.lanes[i].py, 3);
    for (i = 0; i < W.sidewalks.length; i++) polyBin('walks', i, W.sidewalks[i].px, W.sidewalks[i].py, W.sidewalks[i].width);
    for (i = 0; i < W.paths.length; i++) polyBin('paths', i, W.paths[i].px, W.paths[i].py, 7);
    for (i = 0; i < W.xings.length; i++) bin('xings', i, W.xings[i].x - 24, W.xings[i].y - 24, W.xings[i].x + 24, W.xings[i].y + 24);
    for (i = 0; i < W.kerbs.length; i++) {
      var ed = W.edges[W.kerbs[i].edge];
      polyBin('kerbs', i, ed.px, ed.py, Math.max(ed.kerbOffL, ed.kerbOffR) + 2);
    }
    for (i = 0; i < W.props.length; i++) all[cellOf(W.props[i].x, W.props[i].y)].bin.props.push(i);
    for (i = 0; i < W.stops.length; i++) all[cellOf(W.stops[i].x, W.stops[i].y)].bin.stops.push(i);
    var strips = TLV.render.roads.strips(W);
    for (i = 0; i < strips.length; i++) {
      polyBin('strips', i, strips[i].x, strips[i].y, 6);
      for (var r = 0; r < strips[i].records.length; r++) {
        var rec = strips[i].records[r];
        all[cellOf(rec.x, rec.y)].stripRec.push(rec);
      }
    }
  }

  /** Boulevard trees, benches and kiosks. Decoration only: they are not W.props, so nothing collides with them. */
  function* stripDetails(c) {
    var D = TLV.render.city.details;
    for (var i = 0; i < c.stripRec.length; i++) {
      var r = c.stripRec[i];
      D.add(c, r.mesh, r.x, r.y, 0, r.yaw, r.scale, r.tint);
      if ((i & 63) === 63) yield;
    }
  }

  /** Portal barriers: a line of planks across the road, 6 m inside the map. */
  function portalRecords() {
    var T = TLV.tune.render;
    var W = W0;
    var D = TLV.render.city.details;
    var plank = 2.6;
    var signsOut = [];
    for (var j = 0; j < W.juncs.length; j++) {
      var J = W.juncs[j];
      if (!(J.flags & 1)) continue;
      var e = null;
      var atA = true;
      var dir = J.outDir.length ? J.outDir[0] : J.inDir.length ? J.inDir[0] : -1;
      if (dir < 0 || !W.dirEdges[dir]) continue;
      e = W.edges[W.dirEdges[dir].edge];
      atA = e.a === j;
      var n = e.px.length;
      var ax = atA ? e.px[0] : e.px[n - 1], ay = atA ? e.py[0] : e.py[n - 1];
      var bx = atA ? e.px[1] : e.px[n - 2], by = atA ? e.py[1] : e.py[n - 2];
      var dx = bx - ax, dy = by - ay;
      var L = Math.sqrt(dx * dx + dy * dy) || 1;
      dx /= L;
      dy /= L;
      var s = Math.min(T.portalInsetM, L * 0.5);
      var cx = ax + dx * s, cy = ay + dy * s;
      var offL = atA ? e.kerbOffL : e.kerbOffR;     // Looking in from the portal
      var offR = atA ? e.kerbOffR : e.kerbOffL;
      var lx = -dy, ly = dx;
      var width = offL + offR;
      var units = Math.max(1, Math.ceil(width / plank));
      var yaw = Math.atan2(ay - by, ax - bx) + Math.PI;
      for (var u = 0; u < units; u++) {
        var t = -offR + width * (u + 0.5) / units;
        var x = cx + lx * t, y = cy + ly * t;
        D.add(all[cellOf(x, y)], 'barrier', x, y, 0, yaw, 1, -1);
      }
      signsOut.push({ x: cx + lx * (offL - offR) / 2, y: cy + ly * (offL - offR) / 2, nx: dx, ny: dy });
    }
    return signsOut;
  }

  /** Built-in street.tree: the mesh named by the prop, at the prop (decision 7). */
  function treeBuiltin(ctx, out) {
    var p = ctx.prop;
    var h = ctx.hash;
    var yaw = ((h & 255) / 255) * 6.2832;
    var scale = 0.85 + ((h >>> 8) & 255) / 255 * 0.45;
    if (p.kind === 'lamp') out.instance('lamp', p.x, p.y, 0, yaw, 1, -1);
    else if (p.kind === 'palm') out.instance('palm', p.x, p.y, 0, yaw, scale, -1);
    else out.instance(p.kind === 'other' ? 'other' : 'ficus', p.x, p.y, 0, yaw, scale, TLV.tune.render.treeTints[(h >>> 16) & 7]);
  }

  /** Trees and lamps stand exactly at W.props, because those are solid in the sim. */
  function* propRecords(c) {
    var W = W0;
    var D = TLV.render.city.details;
    var R = TLV.render.city.recipes;
    var out = { instance: function (mesh, x, y, z, yaw, scale, tint) { D.add(c, mesh, x, y, z, yaw || 0, scale || 1, tint === undefined ? -1 : tint); } };
    var ctx = { W: W, prop: null, hash: 0 };
    for (var i = 0; i < c.bin.props.length; i++) {
      var id = c.bin.props[i];
      ctx.prop = W.props[id];
      ctx.hash = TLV.rng.hash32(id, 41);
      R.runKit('street.tree', ctx, out, treeBuiltin);
      if ((i & 31) === 31) yield;
    }
  }

  /** Built-in street.furniture: a bus shelter behind the kerb at a stop, facing the road. */
  function furnitureBuiltin(ctx, out) {
    var W = ctx.W;
    var st = ctx.stop;
    var e = W.edges[st.edge];
    var k = 0;
    while (k < e.px.length - 2 && e.cum[k + 1] < st.s) k++;
    var dx = e.px[k + 1] - e.px[k], dy = e.py[k + 1] - e.py[k];
    var L = Math.sqrt(dx * dx + dy * dy) || 1;
    var t = Math.min(1, Math.max(0, (st.s - e.cum[k]) / L));
    var fwd = st.dir === 0;
    var sign = fwd ? 1 : -1;
    var rx = dy / L * sign, ry = -dx / L * sign;  // Right of travel
    var off = (fwd ? e.kerbOffR : e.kerbOffL) + 1.3;
    var x = e.px[k] + dx * t + rx * off, y = e.py[k] + dy * t + ry * off;
    if (TLV.world.surface.at(W, x, y) === TLV.const.SURF.ROAD) return;
    if (TLV.world.spatial.pointInBuilding(W, x, y) >= 0) return;
    out.instance('shelter', x, y, 0, Math.atan2(-ry, -rx), 1, -1);
  }

  function stopRecords(c) {
    var W = W0;
    var D = TLV.render.city.details;
    var R = TLV.render.city.recipes;
    var out = { instance: function (mesh, x, y, z, yaw, scale, tint) { D.add(c, mesh, x, y, z, yaw || 0, scale || 1, tint === undefined ? -1 : tint); } };
    var ctx = { W: W, stop: null };
    for (var i = 0; i < c.bin.stops.length; i++) {
      ctx.stop = W.stops[c.bin.stops[i]];
      R.runKit('street.furniture', ctx, out, furnitureBuiltin);
    }
  }

  /**
   * Sidewalk clutter, sunshades and loungers. A building or junction belongs to one chunk, the chunk of its centre, and its records
   * stay with it wherever they stand: they are read by distance, so nothing needs them filed any finer, and each is worked out once.
   * @param {object} c Chunk.
   * @param {Array} styleIds The style of each of the chunk's buildings, in bin order.
   */
  function* clutterRecords(c, styleIds) {
    var W = W0;
    var D = TLV.render.city.details;
    var RD = TLV.render.roads;
    var i;
    function emit(mesh, x, y, yaw, tint) {
      D.addClutter(c, mesh, x, y, yaw, tint);
    }
    for (i = 0; i < c.bin.blds.length; i++) {
      RD.clutterOfBuilding(W, c.bin.blds[i], styleIds[i], emit);
      if (TLV.render.city.recipes.frontageShops(W, c.bin.blds[i])) yield;     // Only a shop wall has anything to place
    }
    for (i = 0; i < c.bin.juncs.length; i++) {
      var J = W.juncs[c.bin.juncs[i]];
      if (all[cellOf(J.x, J.y)] !== c) continue;
      RD.clutterOfJunction(W, c.bin.juncs[i], emit);
      yield;
    }
    yield* RD.beachSteps(W, c.x0, c.y0, c.x1, c.y1, function (mesh, x, y, yaw, tint) { D.add(c, mesh, x, y, 0, yaw, 1, tint); });
  }

  /** The whole build of one chunk. */
  function* buildChunk(c) {
    var R = TLV.render.city.recipes;
    var ST = TLV.render.styles;
    var SH = TLV.render.city.shells;
    var D = TLV.render.city.details;
    var T = TLV.tune.render;
    var W = W0;
    gbuf.nv = gbuf.ni = 0;
    gbuf.setClip(c.x0, c.y0, c.x1, c.y1);
    var q = T.chunkM / 4;
    var centres = [c.x0 + q, c.y0 + q, c.x1 - q, c.y0 + q, c.x0 + q, c.y1 - q, c.x1 - q, c.y1 - q];
    yield* TLV.render.roads.fill(gbuf, W, c.bin, centres, q * 1.45 + 1);
    yield T.sliceHeavyMs;
    var g = TLV.render.ground.mesh(gbuf, -10);
    var groundCut = gbuf.fineFrom;
    yield;

    sbuf.reset();
    var gardens = [];
    var styleIds = [];
    for (var i = 0; i < c.bin.blds.length; i++) {
      var id = c.bin.blds[i];
      var styleId = styleIds[i] = ST.choose(W, id);
      if (!(TLV.render.landmarks && TLV.render.landmarks.hidesShell(id))) {
        yield* R.buildingSteps(W, id, styleId);
        var parts = R.building(W, id, styleId);
        yield;
        SH.add(sbuf, W, parts);
        if (parts.lowWalls.length) gardens.push(parts);
        for (var k = 0; k < parts.instances.length; k++) {
          var I = parts.instances[k];
          D.add(c, I.mesh, I.x, I.y, I.z, I.yaw, I.scale, I.tint);
        }
        if (parts.walls.length > 12) yield;       // A plain block is quick, and a slice pays for every step it starts
      }
    }
    yield;
    yield* propRecords(c);
    yield* stripDetails(c);
    yield;
    stopRecords(c);
    yield;
    yield* clutterRecords(c, styleIds);
    yield T.sliceHeavyMs;
    var shellCut = sbuf.ni;
    for (var w = 0; w < gardens.length; w++) SH.addLowWalls(sbuf, gardens[w]);
    var geo = SH.geometry(sbuf);
    yield;
    if (c.ground) dropMeshes(c);
    c.ground = g;
    c.groundCut = groundCut;
    c.shellCut = shellCut;
    c.far = false;
    if (g) sceneRef.add(g);
    if (geo) {
      var m = new THREE.Mesh(geo, SH.material());
      m.castShadow = true;
      m.receiveShadow = true;
      m.matrixAutoUpdate = false;
      c.shell = m;
      sceneRef.add(m);
    }
    Object.keys(c.det).forEach(function (key) {
      if (Array.isArray(c.det[key])) c.det[key] = new Float32Array(c.det[key]);
    });
    c.bytes = geoBytes(c.ground) + geoBytes(c.shell);
    c.resident = true;
    c.state = 2;
    if (built.indexOf(c) < 0) built.push(c);
  }

  /** A far chunk stops short of what it cannot show: curbs, stall ticks, garden walls. Costs no draw call. */
  function setFar(c, far) {
    c.far = far;
    if (c.ground) c.ground.geometry.setDrawRange(0, far ? c.groundCut : Infinity);
    if (c.shell) c.shell.geometry.setDrawRange(0, far ? c.shellCut : Infinity);
  }

  /** @returns {number} Bytes a mesh holds on the GPU. */
  function geoBytes(m) {
    if (!m) return 0;
    var g = m.geometry;
    var n = g.index ? g.index.array.byteLength : 0;
    Object.keys(g.attributes).forEach(function (k) { n += g.attributes[k].array.byteLength; });
    return n;
  }

  function dropMeshes(c) {
    if (c.ground) {
      sceneRef.remove(c.ground);
      c.ground.geometry.dispose();
    }
    if (c.shell) {
      sceneRef.remove(c.shell);
      c.shell.geometry.dispose();
    }
    c.ground = c.shell = null;
  }

  /** Runs a build to the end. */
  function finish(c) {
    var it = buildChunk(c);
    while (!it.next().done);
  }

  /**
   * Sets up the grid and bins. Phase 2.
   * @param {object} scene THREE.Scene.
   * @param {object} S Sim state.
   * @param {number} radiusL1 Metres at which shells stop.
   */
  chunks.init = function (scene, S, radiusL1) {
    var T = TLV.tune.render;
    S0 = S;
    W0 = S.world;
    sceneRef = scene;
    l1 = radiusL1;
    rearDir = new THREE.Vector3();
    var b = W0.bounds;
    cols = Math.ceil((b.maxX - b.minX) / T.chunkM);
    rows = Math.ceil((b.maxY - b.minY) / T.chunkM);
    all = [];
    built = [];
    job = null;
    jobChunk = null;
    for (var y = 0; y < rows; y++) {
      for (var x = 0; x < cols; x++) {
        all.push({
          cx: x, cy: y, x0: b.minX + x * T.chunkM, y0: b.minY + y * T.chunkM,
          x1: b.minX + (x + 1) * T.chunkM, y1: b.minY + (y + 1) * T.chunkM,
          state: 0, ground: null, shell: null, det: {}, resident: false, bytes: 0, stripRec: [], far: false, groundCut: 0, shellCut: 0,
          bin: { blds: [], fronts: [], edges: [], juncs: [], conns: [], lanes: [], walks: [], paths: [], xings: [], kerbs: [], props: [], stops: [], strips: [] }
        });
      }
    }
    TLV.render.roads.reset(W0);
    TLV.render.city.recipes.prepare(W0);
    binWorld(W0);
    gbuf = new TLV.render.ground.GBuf(1 << 16);
    sbuf = new TLV.render.city.shells.SBuf(1 << 15);
    chunks.portals = portalRecords();
    all.forEach(function (c) {
      var B = c.bin;
      c.empty = !(B.blds.length || B.edges.length || B.walks.length || B.paths.length);
      if (c.empty) c.state = 2;
    });
  };

  /** @param {number} m Metres at which shells stop, from the next frame. */
  chunks.setL1 = function (m) {
    l1 = m;
  };

  /** @returns {number} Metres at which shells stop. */
  chunks.l1 = function () {
    return l1;
  };

  /**
   * Builds every chunk within a radius, now. Boot uses it for the 9 around spawn, tests for a jump cut.
   * @param {number} x World x.
   * @param {number} y World y.
   * @param {number} r Metres.
   */
  chunks.buildAround = function (x, y, r) {
    if (job && jobChunk) {
      while (!job.next().done);
      job = null;
      jobChunk = null;
    }
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      if (c.state !== 0) continue;
      var dx = x < c.x0 ? c.x0 - x : x > c.x1 ? x - c.x1 : 0;
      var dy = y < c.y0 ? c.y0 - y : y > c.y1 ? y - c.y1 : 0;
      if (dx * dx + dy * dy <= r * r) {
        c.state = 1;
        finish(c);
      }
    }
  };

  /**
   * Builds the 3 x 3 cells around a point, now. Phase 2.
   * @param {number} x World x.
   * @param {number} y World y.
   */
  chunks.build9 = function (x, y) {
    var at = cellOf(x, y);
    var cx0 = at % cols;
    var cy0 = Math.floor(at / cols);
    for (var cy = Math.max(0, cy0 - 1); cy <= Math.min(rows - 1, cy0 + 1); cy++) {
      for (var cx = Math.max(0, cx0 - 1); cx <= Math.min(cols - 1, cx0 + 1); cx++) {
        var c = all[cy * cols + cx];
        if (c.state === 0) {
          c.state = 1;
          finish(c);
        }
      }
    }
  };

  /** Nearest chunk with no mesh yet. */
  function nextChunk(fx, fy) {
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      if (c.state !== 0) continue;
      var dx = (c.x0 + c.x1) / 2 - fx, dy = (c.y0 + c.y1) / 2 - fy;
      var d = dx * dx + dy * dy;
      if (d < bestD) {
        bestD = d;
        best = c;
      }
    }
    return best;
  }

  /**
   * Per frame: shows chunks within L1 of the camera, and spends the slice on building.
   * @param {number} fx Focus x, for the spiral.
   * @param {number} fy Focus y.
   * @param {number} camX Camera x.
   * @param {number} camY Camera y.
   */
  chunks.frame = function (fx, fy, camX, camY) {
    var T = TLV.tune.render;
    var R2 = l1 * l1;
    var keep2 = (l1 + T.residentExtraM) * (l1 + T.residentExtraM);
    var fine2 = T.fineDetailM * T.fineDetailM;
    var cover = l1;
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      var dx = camX < c.x0 ? c.x0 - camX : camX > c.x1 ? camX - c.x1 : 0;
      var dy = camY < c.y0 ? c.y0 - camY : camY > c.y1 ? camY - c.y1 : 0;
      var d2 = dx * dx + dy * dy;
      var show = d2 <= R2;
      if (c.ground) c.ground.visible = show;
      if (c.shell) c.shell.visible = show;
      if (show && c.state !== 2) cover = Math.min(cover, Math.sqrt(d2));
      // Far chunks give their vertex buffers back. Three uploads them again the first time they draw.
      var far = d2 > fine2;
      if (show && far !== c.far) setFar(c, far);
      if (show) c.resident = true;
      else if (c.resident && d2 > keep2) {
        if (c.ground) c.ground.geometry.dispose();
        if (c.shell) c.shell.geometry.dispose();
        c.resident = false;
      }
    }
    TLV.render.city.skyline.frame(cover >= l1 ? l1 : 0);
    var start = now();
    var deadline = start + T.sliceMs;
    var t = start;
    var step = 0;
    var want = 0;
    // Always one step, so a slow machine still gets there. After that a step starts only if it has room to finish: as much as the
    // slowest lately, never less than the guard because steps are not all alike, and what the build asked for the next one.
    do {
      if (!job) {
        var c2 = nextChunk(fx, fy);
        if (!c2) break;
        c2.state = 1;
        jobChunk = c2;
        job = buildChunk(c2);
      }
      var r = job.next();
      want = r.value || 0;
      if (r.done) {
        job = null;
        jobChunk = null;
      }
      var t2 = now();
      step = Math.max(step * 0.8, t2 - t);
      t = t2;
    } while (t + Math.max(step, T.sliceGuardMs, want) < deadline);
    lastBuildMs = t - start;
  };

  /**
   * Cuts the chunks a small far-clipped camera cannot reach. The rear strip sees 110 m at 27 degrees, and a chunk's bounding
   * sphere is too coarse to cull for it: a whole neighbourhood of 400 m chunks would redraw for a strip 256 pixels wide.
   * @param {boolean} on True while the strip renders.
   * @param {object} [cam] THREE.PerspectiveCamera, when on.
   */
  chunks.rearMode = function (on, cam) {
    var i, c;
    if (!on) {
      for (i = 0; i < rearHidden.length; i++) rearHidden[i].visible = true;
      rearHidden.length = 0;
      for (i = 0; i < rearNear.length; i++) setFar(rearNear[i], false);
      rearNear.length = 0;
      return;
    }
    var C = TLV.render.coords;
    var p = C.fromThree(cam.position, rearA);
    cam.getWorldDirection(rearDir);
    var d = C.fromThree(rearDir, rearB);
    var far = cam.far;
    var half = far * Math.tan(cam.fov * Math.PI / 360) * Math.max(1, cam.aspect);
    var ex = p.x + d.x * far, ey = p.y + d.y * far;
    var x0 = Math.min(p.x, ex - Math.abs(d.y) * half, ex + Math.abs(d.y) * half);
    var x1 = Math.max(p.x, ex - Math.abs(d.y) * half, ex + Math.abs(d.y) * half);
    var y0 = Math.min(p.y, ey - Math.abs(d.x) * half, ey + Math.abs(d.x) * half);
    var y1 = Math.max(p.y, ey - Math.abs(d.x) * half, ey + Math.abs(d.x) * half);
    for (i = 0; i < all.length; i++) {
      c = all[i];
      if (c.x1 >= x0 && c.x0 <= x1 && c.y1 >= y0 && c.y0 <= y1) {
        if (!c.far) {
          setFar(c, true);
          rearNear.push(c);
        }
        continue;
      }
      if (c.ground && c.ground.visible) {
        c.ground.visible = false;
        rearHidden.push(c.ground);
      }
      if (c.shell && c.shell.visible) {
        c.shell.visible = false;
        rearHidden.push(c.shell);
      }
    }
  };

  /**
   * Rebuilds a chunk, for a landmark whose model has arrived.
   * @param {number} x World x inside the chunk.
   * @param {number} y World y inside the chunk.
   */
  chunks.invalidate = function (x, y) {
    var c = all[cellOf(x, y)];
    if (!c || c === jobChunk) return;
    c.det = {};
    c.state = 0;
    var at = built.indexOf(c);
    if (at >= 0) built.splice(at, 1);
  };

  /** @returns {object[]} Chunks with records, for the detail pools. */
  chunks.built = function () {
    return built;
  };

  /** @returns {{built:number,total:number,lastMs:number,residentBytes:number}} Progress. Empty sea cells count as done. */
  chunks.stats = function () {
    var done = 0;
    var total = 0;
    var bytes = 0;
    for (var i = 0; i < all.length; i++) {
      if (all[i].resident) bytes += all[i].bytes;
      if (all[i].empty) continue;
      total++;
      if (all[i].state === 2) done++;
    }
    return { built: done, total: total, lastMs: lastBuildMs, residentBytes: bytes };
  };

  /**
   * How close the unbuilt city comes to a point: empty sea cells do not count, and a chunk being built still does.
   * @param {number} x World x.
   * @param {number} y World y.
   * @returns {number} Metres from the point to the nearest such chunk's edge, 0 inside one, Infinity when all are done.
   */
  chunks.unbuiltNear = function (x, y) {
    var best = Infinity;
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      if (c.empty || c.state === 2) continue;
      var dx = x < c.x0 ? c.x0 - x : x > c.x1 ? x - c.x1 : 0;
      var dy = y < c.y0 ? c.y0 - y : y > c.y1 ? y - c.y1 : 0;
      best = Math.min(best, Math.sqrt(dx * dx + dy * dy));
    }
    return best;
  };

  /** Frees every chunk mesh. */
  chunks.dispose = function () {
    all.forEach(dropMeshes);
    all = [];
    built = [];
    job = jobChunk = gbuf = sbuf = S0 = W0 = sceneRef = null;
  };
})(window.TLV);
