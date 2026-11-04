// js/render/city/shells.js — WP-RENDER
// Turns Parts into merged shell geometry with typed arrays, because three.min.js has no mergeGeometries (section 15.3).
(function (TLV) {
  'use strict';

  var shells = TLV.ns('render.city.shells');

  var material = null;
  var shadowFade = null;

  /** Tile index meaning a plain, untextured surface. */
  var PLAIN = 255;

  /** Growable shell buffer. */
  function SBuf(cap) {
    this.cap = cap || 8192;
    this.capI = this.cap * 2;
    this.pos = new Float32Array(this.cap * 3);
    this.nrm = new Int8Array(this.cap * 4);
    this.uvs = new Float32Array(this.cap * 2);
    this.col = new Uint32Array(this.cap);
    this.inf = new Uint8Array(this.cap * 2);
    this.idx = new Uint32Array(this.capI);
    this.nv = 0;
    this.ni = 0;
  }
  shells.SBuf = SBuf;

  /** Empties the buffer, keeping its capacity. */
  SBuf.prototype.reset = function () {
    this.nv = 0;
    this.ni = 0;
  };

  /** Makes room for more vertices and indices. */
  SBuf.prototype.reserve = function (nv, ni) {
    if (this.nv + nv > this.cap) {
      var c = Math.max(this.cap * 2, this.nv + nv);
      var a = new Float32Array(c * 3);
      a.set(this.pos);
      this.pos = a;
      var b = new Int8Array(c * 4);
      b.set(this.nrm);
      this.nrm = b;
      var d = new Float32Array(c * 2);
      d.set(this.uvs);
      this.uvs = d;
      var e = new Uint32Array(c);
      e.set(this.col);
      this.col = e;
      var f = new Uint8Array(c * 2);
      f.set(this.inf);
      this.inf = f;
      this.cap = c;
    }
    if (this.ni + ni > this.capI) {
      var ci = Math.max(this.capI * 2, this.ni + ni);
      var x = new Uint32Array(ci);
      x.set(this.idx);
      this.idx = x;
      this.capI = ci;
    }
  };

  /** Adds a vertex. @returns {number} Index. */
  SBuf.prototype.vert = function (x, y, z, nx, ny, nz, u, v, col, tile, vars) {
    var n = this.nv++;
    var C = TLV.render.coords;
    C.write(this.pos, n * 3, x, y, z);
    C.writeNormal(this.nrm, n * 4, nx, ny, nz);
    this.uvs[n * 2] = u;
    this.uvs[n * 2 + 1] = v;
    this.col[n] = col;
    this.inf[n * 2] = tile;
    this.inf[n * 2 + 1] = vars;
    return n;
  };

  /** Adds a wall quad from a to b, z0 to z1, facing right of a to b. u runs from u0, or 0, to u1. */
  SBuf.prototype.wall = function (ax, ay, bx, by, z0, z1, nx, ny, u1, v1, col, tile, vars, u0) {
    this.reserve(4, 6);
    var n = this.nv;
    var us = u0 || 0;
    this.vert(ax, ay, z0, nx, ny, 0, us, 0, col, tile, vars);
    this.vert(bx, by, z0, nx, ny, 0, u1, 0, col, tile, vars);
    this.vert(bx, by, z1, nx, ny, 0, u1, v1, col, tile, vars);
    this.vert(ax, ay, z1, nx, ny, 0, us, v1, col, tile, vars);
    var i = this.ni;
    var ix = this.idx;
    ix[i] = n; ix[i + 1] = n + 1; ix[i + 2] = n + 2;
    ix[i + 3] = n; ix[i + 4] = n + 2; ix[i + 5] = n + 3;
    this.ni = i + 6;
  };

  /** A flat polygon with holes, facing up or down. */
  SBuf.prototype.cap2 = function (rings, z, up, col) {
    var contour = [];
    var holes = [];
    for (var r = 0; r < rings.length; r++) {
      var ring = rings[r];
      var pts = [];
      for (var i = 0; i < ring.length; i += 2) pts.push(new THREE.Vector2(ring[i], ring[i + 1]));
      if (r === 0) contour = pts;
      else holes.push(pts);
    }
    if (contour.length < 3) return;
    var tris;
    try {
      tris = THREE.ShapeUtils.triangulateShape(contour, holes);
    } catch (e) {
      return;
    }
    var all = contour.slice();
    for (var h = 0; h < holes.length; h++) all = all.concat(holes[h]);
    this.reserve(all.length, tris.length * 3);
    var first = this.nv;
    var nz = up ? 1 : -1;
    for (var k = 0; k < all.length; k++) this.vert(all[k].x, all[k].y, z, 0, 0, nz, all[k].x * 0.2, all[k].y * 0.2, col, PLAIN, 1);
    for (var t = 0; t < tris.length; t++) {
      var a = tris[t][0], b = tris[t][1], c = tris[t][2];
      var A = all[a], B = all[b], C = all[c];
      var area = (B.x - A.x) * (C.y - A.y) - (B.y - A.y) * (C.x - A.x);
      var flip = up ? area < 0 : area > 0;
      this.idx[this.ni++] = first + a;
      this.idx[this.ni++] = first + (flip ? c : b);
      this.idx[this.ni++] = first + (flip ? b : c);
    }
  };

  /** A square column. */
  SBuf.prototype.post = function (x, y, hw, z0, z1, col) {
    this.wall(x - hw, y - hw, x + hw, y - hw, z0, z1, 0, -1, 1, 1, col, PLAIN, 1);
    this.wall(x + hw, y - hw, x + hw, y + hw, z0, z1, 1, 0, 1, 1, col, PLAIN, 1);
    this.wall(x + hw, y + hw, x - hw, y + hw, z0, z1, 0, 1, 1, 1, col, PLAIN, 1);
    this.wall(x - hw, y + hw, x - hw, y - hw, z0, z1, -1, 0, 1, 1, col, PLAIN, 1);
  };

  /** A garden wall: its street face, its two ends and its cap. It stands in a bed, so nothing sees the back. */
  SBuf.prototype.lowWall = function (rows, o, F, col, capCol) {
    var ax = rows[o], ay = rows[o + 1], bx = rows[o + 2], by = rows[o + 3], nx = rows[o + 4], ny = rows[o + 5];
    var h = F.lowWallM;
    var t = F.lowWallTopM;
    var ux = bx - ax, uy = by - ay;
    var L = Math.sqrt(ux * ux + uy * uy) || 1;
    ux /= L;
    uy /= L;
    this.wall(ax, ay, bx, by, 0, h, nx, ny, 1, 1, col, PLAIN, 1);
    this.wall(ax - nx * t, ay - ny * t, ax, ay, 0, h, -ux, -uy, 1, 1, col, PLAIN, 1);
    this.wall(bx, by, bx - nx * t, by - ny * t, 0, h, ux, uy, 1, 1, col, PLAIN, 1);
    this.reserve(4, 6);
    var n = this.nv;
    this.vert(ax, ay, h, 0, 0, 1, 0, 0, capCol, PLAIN, 1);
    this.vert(bx, by, h, 0, 0, 1, 0, 0, capCol, PLAIN, 1);
    this.vert(bx - nx * t, by - ny * t, h, 0, 0, 1, 0, 0, capCol, PLAIN, 1);
    this.vert(ax - nx * t, ay - ny * t, h, 0, 0, 1, 0, 0, capCol, PLAIN, 1);
    var i = this.ni;
    var ix = this.idx;
    ix[i] = n; ix[i + 1] = n + 1; ix[i + 2] = n + 2;
    ix[i + 3] = n; ix[i + 4] = n + 2; ix[i + 5] = n + 3;
    this.ni = i + 6;
  };

  /** Pitched or domed roof: rings shrinking to the centroid. */
  function liftedRoof(buf, b, top, kind, col) {
    var r = b.rings[0];
    var n = r.length >> 1;
    var cx = 0, cy = 0;
    for (var i = 0; i < n; i++) {
      cx += r[i * 2];
      cy += r[i * 2 + 1];
    }
    cx /= n;
    cy /= n;
    var span = Math.max(b.maxX - b.minX, b.maxY - b.minY);
    var rise = kind === 2 ? span * 0.5 : Math.min(3.5, span * 0.28);
    var steps = kind === 2 ? 4 : 1;
    for (var s = 0; s < steps; s++) {
      var a0 = s / steps, a1 = (s + 1) / steps;
      var k0 = kind === 2 ? Math.cos(a0 * 1.5708) : 1;
      var k1 = kind === 2 ? Math.cos(a1 * 1.5708) : 0;
      var z0 = top + rise * (kind === 2 ? Math.sin(a0 * 1.5708) : 0);
      var z1 = top + rise * (kind === 2 ? Math.sin(a1 * 1.5708) : 1);
      for (var w = 0; w < n; w++) {
        var q = (w + 1) % n;
        var ax = r[w * 2], ay = r[w * 2 + 1], bx = r[q * 2], by = r[q * 2 + 1];
        var dx = bx - ax, dy = by - ay;
        var L = Math.sqrt(dx * dx + dy * dy) || 1;
        var ux = dy / L, uy = -dx / L;
        var nz = 0.7;
        var nh = 0.7;
        buf.reserve(4, 6);
        var f = buf.nv;
        buf.vert(cx + (ax - cx) * k0, cy + (ay - cy) * k0, z0, ux * nh, uy * nh, nz, 0, 0, col, PLAIN, 1);
        buf.vert(cx + (bx - cx) * k0, cy + (by - cy) * k0, z0, ux * nh, uy * nh, nz, 0, 0, col, PLAIN, 1);
        buf.vert(cx + (bx - cx) * k1, cy + (by - cy) * k1, z1, ux * nh, uy * nh, nz, 0, 0, col, PLAIN, 1);
        buf.vert(cx + (ax - cx) * k1, cy + (ay - cy) * k1, z1, ux * nh, uy * nh, nz, 0, 0, col, PLAIN, 1);
        var ix = buf.ni;
        buf.idx[ix] = f; buf.idx[ix + 1] = f + 1; buf.idx[ix + 2] = f + 2;
        buf.idx[ix + 3] = f; buf.idx[ix + 4] = f + 2; buf.idx[ix + 5] = f + 3;
        buf.ni = ix + 6;
      }
    }
  }

  /**
   * Draws a stretch of a wall, less the stretches another building draws. Bays keep their place: u follows the wall, not the piece.
   * @param {SBuf} buf Target.
   * @param {object} wl Wall.
   * @param {?number[]} cuts t0, t1 pairs to leave out, in order.
   * @param {number} t0 Start, as a fraction of the wall.
   * @param {number} t1 End.
   * @param {number} z0 Bottom.
   * @param {number} z1 Top.
   * @param {number} uPerT Texture repeats per whole wall.
   * @param {number} v1 Texture repeats up the wall.
   */
  function wallSpan(buf, wl, cuts, t0, t1, z0, z1, uPerT, v1, col, tile, vars) {
    var from = t0;
    for (var c = 0; cuts && c + 1 < cuts.length; c += 2) {
      if (cuts[c + 1] <= from) continue;
      if (cuts[c] >= t1) break;
      if (cuts[c] > from) wallPiece(buf, wl, t0, from, cuts[c], z0, z1, uPerT, v1, col, tile, vars);
      from = Math.max(from, cuts[c + 1]);
    }
    if (from < t1) wallPiece(buf, wl, t0, from, t1, z0, z1, uPerT, v1, col, tile, vars);
  }

  function wallPiece(buf, wl, t0, a, b, z0, z1, uPerT, v1, col, tile, vars) {
    var dx = wl.bx - wl.ax, dy = wl.by - wl.ay;
    buf.wall(wl.ax + dx * a, wl.ay + dy * a, wl.ax + dx * b, wl.ay + dy * b, z0, z1, wl.nx, wl.ny, (b - t0) * uPerT, v1, col, tile, vars, (a - t0) * uPerT);
  }

  /** @returns {?number[]} Two cut lists as one, in order. */
  function joinCuts(a, b) {
    if (!a || !b) return a || b;
    var pairs = [];
    var i;
    for (i = 0; i + 1 < a.length; i += 2) pairs.push([a[i], a[i + 1]]);
    for (i = 0; i + 1 < b.length; i += 2) pairs.push([b[i], b[i + 1]]);
    pairs.sort(function (p, q) { return p[0] - q[0]; });
    var out = [];
    for (i = 0; i < pairs.length; i++) {
      var last = out.length - 1;
      if (last > 0 && pairs[i][0] <= out[last]) out[last] = Math.max(out[last], pairs[i][1]);
      else out.push(pairs[i][0], pairs[i][1]);
    }
    return out;
  }

  /**
   * Appends one building.
   * @param {SBuf} buf Target.
   * @param {object} W World.
   * @param {object} parts From recipes.building.
   * @param {{inset?:number, simple?:boolean}} [opts] Skyline form: no ground quads or cornice.
   */
  shells.add = function (buf, W, parts, opts) {
    var T = TLV.tune.render;
    var G = TLV.render.ground;
    var F = TLV.render.city.facades;
    var C = T.colors;
    var b = W.blds[parts.id];
    // No two blocks share a cream: a building's age shows as a shift in lightness and warmth, off the same palette.
    var hue = TLV.rng.hash32(b.osm, 77);
    var tint = G.shade(G.rgba(parts.tint), T.tintMin + ((hue & 255) / 255) * (T.tintMax - T.tintMin));
    var warm = ((hue >>> 8) & 255) / 255 - 0.5;
    var blue = Math.max(0, Math.min(255, ((tint >>> 16) & 255) * (1 - warm * T.tintWarm)));
    tint = (tint & 0xff00ffff) | (blue << 16);
    tint = (tint & 0xffffff | ((b.osm & 255) << 24)) >>> 0;
    var postCol = G.rgba(C.post);
    var simple = opts && opts.simple;
    var top = parts.top - (opts && opts.inset ? opts.inset : 0);

    if (parts.form === 'canopy') {
      var cc = G.rgba(C.canopy);
      for (var i = 0; i < parts.walls.length; i++) {
        var cw = parts.walls[i];
        wallSpan(buf, cw, cw.cutUpper, 0, 1, parts.base, parts.top, 1, 1, cc, PLAIN, 1);
      }
      buf.cap2(b.rings, parts.top, true, cc);
      buf.cap2(b.rings, parts.base, false, G.rgba(C.soffit));
      for (var p = 0; p + 1 < parts.posts.length; p += 2) buf.post(parts.posts[p], parts.posts[p + 1], 0.14, 0, parts.base, postCol);
      return;
    }

    var corniceCol = G.shade(tint, 1.03);
    var plainCol = G.shade(tint, 0.97);
    var solid = parts.form === 'solid';
    for (var w = 0; w < parts.walls.length; w++) {
      var wl = parts.walls[w];
      var zTop = top - (simple ? 0 : parts.cornice);
      // The storeys and the ground floor can have different owners. The skyline form is one quad, and goes with the storeys.
      var cutUp = wl.cutUpper;
      var cutLow = simple ? cutUp : wl.cutGround;
      if (wl.plain || wl.bays < 1) {
        if (cutUp === cutLow) {
          wallSpan(buf, wl, cutUp, 0, 1, parts.base, top, 1, 1, plainCol, PLAIN, 1);
        } else {
          wallSpan(buf, wl, joinCuts(cutUp, cutLow), 0, 1, parts.base, parts.groundTop, 1, 1, plainCol, PLAIN, 1);
          wallSpan(buf, wl, cutUp, 0, 1, parts.groundTop, top, 1, 1, plainCol, PLAIN, 1);
        }
        continue;
      }
      var L = F.layer(wl.tile);
      var z0 = parts.wallBottom;
      if (solid && !simple) {
        if (wl.groundRuns) {
          for (var r = 0; r < wl.groundRuns.length; r++) {
            var run = wl.groundRuns[r];
            var Gr = F.layer(run.tile);
            wallSpan(buf, wl, cutLow, run.from / wl.bays, run.to / wl.bays, 0, parts.groundTop, wl.bays, 1, tint, Gr.layer, Gr.vars);
          }
        } else {
          var G2 = F.layer(wl.groundTile);
          wallSpan(buf, wl, cutLow, 0, 1, 0, parts.groundTop, wl.bays, 1, tint, G2.layer, G2.vars);
        }
      } else if (solid) {
        z0 = 0;
      }
      wallSpan(buf, wl, cutUp, 0, 1, z0, zTop, wl.bays, Math.max(1, parts.upperFloors), tint, L.layer, L.vars);
      if (!simple && parts.cornice > 0 && (wl.front || wl.len > 7)) {
        wallSpan(buf, wl, cutUp, 0, 1, zTop, top, 1, 1, corniceCol, PLAIN, 1);
      }
    }

    var roofCol = G.rgba(parts.roof.colour || C.roof);
    if (parts.roof.kind === 1 || parts.roof.kind === 2) {
      if (!parts.roof.colour) roofCol = G.rgba(parts.roof.kind === 1 ? '#b5694a' : '#d9d3c4');
      liftedRoof(buf, b, top, parts.roof.kind, roofCol);
    } else {
      buf.cap2(b.rings, top, true, roofCol);
    }

    if (parts.form === 'lifted') {
      buf.cap2(b.rings, parts.base, false, G.rgba(C.soffit));
      var hw = T.liftPostM;
      for (var q = 0; q + 1 < parts.posts.length; q += 2) buf.post(parts.posts[q], parts.posts[q + 1], hw, 0, parts.base, postCol);
    }
  };

  /**
   * Appends a building's garden walls. Chunks call this after every shell, so a far chunk can stop short of them.
   * @param {SBuf} buf Target.
   * @param {object} parts From recipes.building.
   */
  shells.addLowWalls = function (buf, parts) {
    var G = TLV.render.ground;
    var T = TLV.tune.render;
    var tint = (G.rgba(parts.tint) & 0xffffff) >>> 0;
    var wallCol = G.shade(tint, 0.96);
    var capCol = G.shade(tint, 1.08);
    for (var o = 0; o + 5 < parts.lowWalls.length; o += 6) buf.lowWall(parts.lowWalls, o, T.frontage, wallCol, capCol);
  };

  /**
   * Makes a geometry from a buffer.
   * @param {SBuf} buf Filled buffer.
   * @returns {?object} THREE.BufferGeometry.
   */
  shells.geometry = function (buf) {
    if (!buf.ni) return null;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(buf.pos.slice(0, buf.nv * 3), 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(buf.nrm.slice(0, buf.nv * 4), 4, true));
    geo.setAttribute('aUv', new THREE.BufferAttribute(buf.uvs.slice(0, buf.nv * 2), 2));
    geo.setAttribute('aTint', new THREE.BufferAttribute(new Uint8Array(buf.col.buffer.slice(0, buf.nv * 4)), 4, true));
    geo.setAttribute('aInfo', new THREE.BufferAttribute(buf.inf.slice(0, buf.nv * 2), 2));
    var idx = buf.nv < 65535 ? new Uint16Array(buf.ni) : new Uint32Array(buf.ni);
    idx.set(buf.idx.subarray(0, buf.ni));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    TLV.render.ground.fitSphere(geo);
    return geo;
  };

  var VERT_HEAD = [
    'attribute vec2 aUv;',
    'attribute vec4 aTint;',
    'attribute vec2 aInfo;',
    'varying vec2 vTuv;',
    'varying vec3 vTint;',
    'flat varying float vTile;',
    'flat varying float vVars;',
    'flat varying float vSeed;',
    'varying vec3 vWN;',
    '#ifdef SKYLINE',
    'uniform float uCollapse;',
    'attribute vec2 aCentre;',
    '#endif'
  ].join('\n');

  var FRAG_HEAD = [
    'precision highp sampler2DArray;',
    'uniform sampler2DArray uFacades;',
    'uniform vec3 uFade;',
    'varying vec2 vTuv;',
    'varying vec3 vTint;',
    'flat varying float vTile;',
    'flat varying float vVars;',
    'flat varying float vSeed;',
    'varying vec3 vWN;',
    'float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }'
  ].join('\n');

  var FRAG_ALBEDO = [
    'float glassK = 0.0;',
    'if (vTile < 254.5) {',
    '  vec2 cell = floor(vTuv);',
    '  float r = h21(cell * 0.371 + vec2(vSeed, vTile * 0.13));',
    '  float layer = vTile + min(floor(r * vVars), vVars - 1.0);',
    '  vec4 t = texture(uFacades, vec3(vTuv.x, -vTuv.y, layer));',
    // Wear: each bay and floor was repainted some other year, and the street's dirt rises up the first storey.
    '  float wear = (0.955 + 0.09 * h21(cell * vec2(0.13, 0.57) + vSeed)) * mix(0.9, 1.0, smoothstep(0.0, 1.2, vTuv.y));',
    '  diffuseColor.rgb = mix(t.rgb, t.rgb * vTint * wear, t.a);',
    '  glassK = (1.0 - t.a) * (1.0 - smoothstep(0.1, 0.34, dot(t.rgb, vec3(0.33)))) * step(t.r + 0.004, t.b);',
    '} else {',
    '  diffuseColor.rgb = vTint;',
    '}'
  ].join('\n');

  var FRAG_GLASS = [
    'if (glassK > 0.01) {',
    '  vec3 Vw = normalize(cameraPosition - vWP);',
    '  vec3 Rw = reflect(-Vw, normalize(vWN));',
    '  float fr = 0.25 + 0.75 * pow(1.0 - max(dot(Vw, normalize(vWN)), 0.0), 3.0);',
    '  vec3 refl = mix(uHazeAway * uHazeAway, vec3(0.2, 0.42, 0.72), clamp(Rw.y * 1.6, 0.0, 1.0));',
    '  refl += vec3(1.0, 0.8, 0.55) * pow(max(dot(Rw, uSunW), 0.0), 60.0) * 2.0;',
    '  outgoingLight = mix(outgoingLight, refl, glassK * fr);',
    '}'
  ].join('\n');

  /**
   * Builds a facade material.
   * @param {object} tex Facade array.
   * @param {{skyline?:boolean}} [opts] Skyline variant: far fog, collapsed near the camera.
   * @returns {object} THREE.MeshLambertMaterial with patched shaders.
   */
  shells.makeMaterial = function (tex, opts) {
    var T = TLV.tune.render;
    var skyline = opts && opts.skyline;
    var m = new THREE.MeshLambertMaterial({ color: 0xffffff });
    if (skyline) {
      m.defines = { SKYLINE: 1 };
      m.userData.collapse = { value: 0 };
    }
    m.customProgramCacheKey = function () {
      return skyline ? 'tlv-skyline' : 'tlv-shell';
    };
    m.onBeforeCompile = function (shader) {
      TLV.render.sky.patch(shader, skyline ? { near: T.skylineFogNearM, far: T.skylineFogFarM, max: T.skylineFogMax } : null);
      shader.uniforms.uFacades = { value: tex };
      shader.uniforms.uFade = { value: shadowFade };
      if (skyline) shader.uniforms.uCollapse = m.userData.collapse;
      shader.vertexShader = VERT_HEAD + '\n' + shader.vertexShader
        .replace('#include <begin_vertex>', [
          '#include <begin_vertex>',
          'vTuv = aUv; vTint = pow(aTint.rgb, vec3(2.2)); vSeed = aTint.a * 17.0; vTile = aInfo.x; vVars = aInfo.y;',
          'vWN = normal;'
        ].join('\n'))
        .replace('#include <project_vertex>', [
          '#include <project_vertex>',
          '#ifdef SKYLINE',
          'if (uCollapse > 0.0) {',
          '  vec2 cp = aCentre - cameraPosition.xz;',
          '  if (dot(cp, cp) < uCollapse * uCollapse) gl_Position = vec4(2.0, 2.0, 2.0, 1.0);',
          '}',
          '#endif'
        ].join('\n'));
      var lights = THREE.ShaderChunk.lights_fragment_begin.replace(
        /\? getShadow\( directionalShadowMap\[ i \], directionalLightShadow\.shadowMapSize, directionalLightShadow\.shadowBias, directionalLightShadow\.shadowRadius, vDirectionalShadowCoord\[ i \] \) : 1\.0;/,
        '? mix(getShadow( directionalShadowMap[ i ], directionalLightShadow.shadowMapSize, directionalLightShadow.shadowBias, directionalLightShadow.shadowRadius, vDirectionalShadowCoord[ i ] ), 1.0, smoothstep(uFade.x, uFade.y, length(vWP.xz - uFocus))) : 1.0;'
      );
      shader.uniforms.uFocus = shells.focusU;
      shader.fragmentShader = FRAG_HEAD + '\nuniform vec2 uFocus;\n' + shader.fragmentShader
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + FRAG_ALBEDO)
        .replace('#include <lights_fragment_begin>', lights)
        .replace('#include <opaque_fragment>', FRAG_GLASS + '\n#include <opaque_fragment>');
    };
    return m;
  };

  /** Focus of the shadow frustum, in Three xz. */
  shells.focusU = { value: null };

  /**
   * Creates the chunk shell material.
   * @param {object} tex Facade array.
   */
  shells.init = function (tex) {
    var T = TLV.tune.render;
    shadowFade = new THREE.Vector3(T.shadowFadeM, T.shadowHalfM + 18, 0);
    shells.focusU.value = new THREE.Vector2(0, 0);
    material = shells.makeMaterial(tex);
  };

  /** @returns {object} The shared shell material. */
  shells.material = function () {
    return material;
  };

  /** Frees the material. */
  shells.dispose = function () {
    if (material) material.dispose();
    material = null;
  };
})(window.TLV);
