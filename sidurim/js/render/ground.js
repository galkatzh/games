// js/render/ground.js — WP-RENDER
// The ground is painted, not depth-tested. Every ground layer draws first, in buffer order, with depth off, so coplanar
// layers cannot fight at any distance and road paint needs no polygon offset. Land, sea and the baked sun mask live here;
// chunk road meshes (roads.js) share this material and this buffer.
(function (TLV) {
  'use strict';

  var ground = TLV.ns('render.ground');

  /** Surface programs in the ground shader. */
  var MAT = ground.MAT = {
    FLAT: 0, ASPHALT: 1, PAVING: 2, GRASS: 3, SAND: 4, SEA: 5, WATER: 6, SHORE: 7, FOAM: 8,
    LINE: 9, DASH: 10, CURB: 11, CURB_RW: 12, CURB_RY: 13, CURB_BW: 14, ZEBRA: 15, STONE: 16, DIRT: 17, YARD: 18,
    BED: 19, PLAZA: 20, MOTORWAY_DASH: 21
  };

  var material = null;
  var baseMesh = null;
  var wallMesh = null;
  var maskTex = null;
  var sceneRef = null;
  var scratchClip = new Float64Array(5 * 16);
  var scratchClip2 = new Float64Array(5 * 16);
  var motorways = [];       // Queue items. Optional: a map with none draws no motorway

  /** sRGB hex to an RGBA word for the colour attribute. Linear decode happens in the vertex shader. */
  function rgba(hex, a) {
    var n = parseInt(hex.slice(1), 16);
    var al = a === undefined ? 255 : Math.round(a * 255);
    return ((al << 24) | ((n & 255) << 16) | (n & 0xff00) | ((n >> 16) & 255)) >>> 0;
  }
  ground.rgba = rgba;

  /** Multiplies an RGBA word's colour. */
  ground.shade = function (word, k) {
    var r = Math.min(255, (word & 255) * k);
    var g = Math.min(255, ((word >>> 8) & 255) * k);
    var b = Math.min(255, ((word >>> 16) & 255) * k);
    return ((word & 0xff000000) | (b << 16) | (g << 8) | r) >>> 0;
  };

  /**
   * Growable ground buffer. Painter's order is emission order. Geometry is clipped to the clip rect, so layers from
   * neighbouring chunks never overlap and chunk draw order cannot show.
   * @param {number} [capV] Starting vertex capacity.
   */
  function GBuf(capV) {
    this.capV = capV || 8192;
    this.capI = this.capV * 3;
    this.pos = new Float32Array(this.capV * 3);
    this.col = new Uint32Array(this.capV);
    this.uu = new Float32Array(this.capV);
    this.vm = new Uint8Array(this.capV * 2);
    this.idx = new Uint32Array(this.capI);
    this.nv = 0;
    this.ni = 0;
    this.fineFrom = 0;     // Index where detail too fine for a far chunk begins
    this.x0 = -Infinity;
    this.y0 = -Infinity;
    this.x1 = Infinity;
    this.y1 = Infinity;
    this.minZ = 0;
    this.maxZ = 0;
  }
  ground.GBuf = GBuf;

  /** Sets the rectangle geometry is clipped to. */
  GBuf.prototype.setClip = function (x0, y0, x1, y1) {
    this.x0 = x0;
    this.y0 = y0;
    this.x1 = x1;
    this.y1 = y1;
  };

  /** Makes room for more vertices and indices. */
  GBuf.prototype.reserve = function (nv, ni) {
    if (this.nv + nv > this.capV) {
      var cv = Math.max(this.capV * 2, this.nv + nv);
      var p = new Float32Array(cv * 3);
      p.set(this.pos);
      this.pos = p;
      var c = new Uint32Array(cv);
      c.set(this.col);
      this.col = c;
      var u = new Float32Array(cv);
      u.set(this.uu);
      this.uu = u;
      var m = new Uint8Array(cv * 2);
      m.set(this.vm);
      this.vm = m;
      this.capV = cv;
    }
    if (this.ni + ni > this.capI) {
      var ci = Math.max(this.capI * 2, this.ni + ni);
      var ix = new Uint32Array(ci);
      ix.set(this.idx);
      this.idx = ix;
      this.capI = ci;
    }
  };

  /** Adds a vertex. v is -1..1 across a strip. @returns {number} Vertex index. */
  GBuf.prototype.vert = function (x, y, z, c, u, v, mat) {
    var n = this.nv++;
    TLV.render.coords.write(this.pos, n * 3, x, y, z);
    this.col[n] = c;
    this.uu[n] = u;
    this.vm[n * 2] = Math.round((v + 1) * 127.5);
    this.vm[n * 2 + 1] = mat;
    return n;
  };

  /** Adds a triangle by vertex index. */
  GBuf.prototype.tri = function (a, b, c) {
    var i = this.ni;
    this.idx[i] = a;
    this.idx[i + 1] = b;
    this.idx[i + 2] = c;
    this.ni = i + 3;
  };

  /** Sutherland-Hodgman against one axis plane. Rows hold x,y,z,u,v. @returns {number} Output count. */
  function clipPlane(src, n, dst, axis, limit, keepLess) {
    var m = 0;
    for (var i = 0; i < n; i++) {
      var a = i * 5;
      var b = ((i + 1) % n) * 5;
      var da = keepLess ? limit - src[a + axis] : src[a + axis] - limit;
      var db = keepLess ? limit - src[b + axis] : src[b + axis] - limit;
      if (da >= 0) {
        for (var k = 0; k < 5; k++) dst[m * 5 + k] = src[a + k];
        m++;
      }
      if ((da >= 0) !== (db >= 0)) {
        var t = da / (da - db);
        for (var q = 0; q < 5; q++) dst[m * 5 + q] = src[a + q] + (src[b + q] - src[a + q]) * t;
        m++;
      }
    }
    return m;
  }

  /** Emits a convex polygon held in scratchClip, clipped, as a fan. */
  GBuf.prototype.emitClipped = function (n, c, mat) {
    var a = scratchClip;
    var b = scratchClip2;
    n = clipPlane(a, n, b, 0, this.x0, false);
    if (n < 3) return;
    n = clipPlane(b, n, a, 0, this.x1, true);
    if (n < 3) return;
    n = clipPlane(a, n, b, 1, this.y0, false);
    if (n < 3) return;
    n = clipPlane(b, n, a, 1, this.y1, true);
    if (n < 3) return;
    this.reserve(n, (n - 2) * 3);
    var first = this.nv;
    for (var i = 0; i < n; i++) {
      var o = i * 5;
      this.vert(a[o], a[o + 1], a[o + 2], c, a[o + 3], a[o + 4], mat);
    }
    for (var k = 2; k < n; k++) this.tri(first, first + k - 1, first + k);
  };

  /**
   * Adds a quad a, b, c, d, counter-clockwise seen from above, or from its front.
   * Each point is x, y, z, u, v.
   */
  GBuf.prototype.quad = function (ax, ay, az, au, av, bx, by, bz, bu, bv, cx, cy, cz, cu, cv, dx, dy, dz, du, dv, col, mat) {
    var x0 = this.x0;
    var y0 = this.y0;
    var x1 = this.x1;
    var y1 = this.y1;
    if ((ax < x0 && bx < x0 && cx < x0 && dx < x0) || (ax > x1 && bx > x1 && cx > x1 && dx > x1) ||
        (ay < y0 && by < y0 && cy < y0 && dy < y0) || (ay > y1 && by > y1 && cy > y1 && dy > y1)) return;
    if (ax >= x0 && ax <= x1 && bx >= x0 && bx <= x1 && cx >= x0 && cx <= x1 && dx >= x0 && dx <= x1 &&
        ay >= y0 && ay <= y1 && by >= y0 && by <= y1 && cy >= y0 && cy <= y1 && dy >= y0 && dy <= y1) {
      this.reserve(4, 6);
      var n = this.nv;
      this.vert(ax, ay, az, col, au, av, mat);
      this.vert(bx, by, bz, col, bu, bv, mat);
      this.vert(cx, cy, cz, col, cu, cv, mat);
      this.vert(dx, dy, dz, col, du, dv, mat);
      this.tri(n, n + 1, n + 2);
      this.tri(n, n + 2, n + 3);
      return;
    }
    var s = scratchClip;
    s[0] = ax; s[1] = ay; s[2] = az; s[3] = au; s[4] = av;
    s[5] = bx; s[6] = by; s[7] = bz; s[8] = bu; s[9] = bv;
    s[10] = cx; s[11] = cy; s[12] = cz; s[13] = cu; s[14] = cv;
    s[15] = dx; s[16] = dy; s[17] = dz; s[18] = du; s[19] = dv;
    this.emitClipped(4, col, mat);
  };

  /**
   * Adds a strip along a polyline, between signed offsets from it.
   * @param {ArrayLike<number>} px Polyline x.
   * @param {ArrayLike<number>} py Polyline y.
   * @param {number} n Points to use.
   * @param {number} offL Left limit: metres left of the line. Negative lies right of it.
   * @param {number} offR Right limit: metres right of the line. Negative lies left of it.
   * @param {number} z Height.
   * @param {number} col RGBA word.
   * @param {number} mat Surface program.
   * @param {?ArrayLike<number>} [cum] Arc length at each point, for u. Null gives u from 0.
   * @param {number} [vL] v at the left limit, default -1.
   * @param {number} [vR] v at the right limit, default 1.
   */
  GBuf.prototype.ribbon = function (px, py, n, offL, offR, z, col, mat, cum, vL, vR) {
    if (n < 2) return;
    var left = vL === undefined ? -1 : vL;
    var right = vR === undefined ? 1 : vR;
    var nxPrev = 0;
    var nyPrev = 0;
    var lxA = 0, lyA = 0, rxA = 0, ryA = 0, uA = 0;
    var run = 0;
    for (var i = 0; i < n; i++) {
      var ax = px[i > 0 ? i - 1 : 0];
      var ay = py[i > 0 ? i - 1 : 0];
      var bx = px[i < n - 1 ? i + 1 : n - 1];
      var by = py[i < n - 1 ? i + 1 : n - 1];
      var d1x = px[i] - ax;
      var d1y = py[i] - ay;
      var d2x = bx - px[i];
      var d2y = by - py[i];
      var l1 = Math.sqrt(d1x * d1x + d1y * d1y);
      var l2 = Math.sqrt(d2x * d2x + d2y * d2y);
      var nx, ny, k = 1;
      if (l1 < 1e-5 && l2 < 1e-5) {
        nx = nxPrev;
        ny = nyPrev;
      } else if (l1 < 1e-5) {
        nx = -d2y / l2;
        ny = d2x / l2;
      } else if (l2 < 1e-5) {
        nx = -d1y / l1;
        ny = d1x / l1;
      } else {
        var n1x = -d1y / l1, n1y = d1x / l1, n2x = -d2y / l2, n2y = d2x / l2;
        var mx = n1x + n2x, my = n1y + n2y;
        var ml = Math.sqrt(mx * mx + my * my);
        if (ml < 0.2) {
          nx = n2x;
          ny = n2y;
        } else {
          nx = mx / ml;
          ny = my / ml;
          k = 1 / Math.max(0.6, nx * n1x + ny * n1y);
        }
      }
      nxPrev = nx;
      nyPrev = ny;
      run += l1;
      var u = cum ? cum[i] : run;
      var lx = px[i] + nx * offL * k;
      var ly = py[i] + ny * offL * k;
      var rx = px[i] - nx * offR * k;
      var ry = py[i] - ny * offR * k;
      if (i > 0) this.quad(rxA, ryA, z, uA, right, rx, ry, z, u, right, lx, ly, z, u, left, lxA, lyA, z, uA, left, col, mat);
      lxA = lx; lyA = ly; rxA = rx; ryA = ry; uA = u;
    }
  };

  /**
   * Adds a polygon as a fan from its first point. Convex only.
   * @param {ArrayLike<number>} poly x,y pairs.
   */
  GBuf.prototype.fan = function (poly, z, col, mat) {
    var n = poly.length >> 1;
    if (n < 3) return;
    var x0 = poly[0], y0 = poly[1];
    for (var i = 1; i + 1 < n; i++) {
      var ax = poly[i * 2], ay = poly[i * 2 + 1], bx = poly[i * 2 + 2], by = poly[i * 2 + 3];
      this.quad(x0, y0, z, 0, 0, ax, ay, z, 0, 0, bx, by, z, 0, 0, bx, by, z, 0, 0, col, mat);
    }
  };

  /** Adds a filled polygon of any shape, by ear cutting. No clip: land polygons go in the global mesh. */
  GBuf.prototype.polygon = function (poly, z, col, mat) {
    var n = poly.length >> 1;
    if (n < 3) return;
    var c = new Array(n);
    for (var i = 0; i < n; i++) c[i] = new THREE.Vector2(poly[i * 2], poly[i * 2 + 1]);
    var tris = THREE.ShapeUtils.triangulateShape(c, []);
    this.reserve(n, tris.length * 3);
    var first = this.nv;
    for (var k = 0; k < n; k++) this.vert(c[k].x, c[k].y, z, col, 0, 0, mat);
    for (var t = 0; t < tris.length; t++) this.tri(first + tris[t][0], first + tris[t][1], first + tris[t][2]);
  };

  /**
   * computeBoundingSphere, the same numbers from a plain loop. It reads every vertex twice through three's accessors, and a dense
   * chunk has tens of thousands: this was two of the longest steps of a build.
   * @param {object} geo THREE.BufferGeometry with a plain position attribute.
   */
  ground.fitSphere = function (geo) {
    var p = geo.attributes.position.array;
    var x0 = Infinity, y0 = Infinity, z0 = Infinity, x1 = -Infinity, y1 = -Infinity, z1 = -Infinity;
    var i, n = p.length;
    for (i = 0; i < n; i += 3) {
      var x = p[i], y = p[i + 1], z = p[i + 2];
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (z < z0) z0 = z;
      if (z > z1) z1 = z;
    }
    var cx = (x0 + x1) * 0.5, cy = (y0 + y1) * 0.5, cz = (z0 + z1) * 0.5;
    var most = 0;
    for (i = 0; i < n; i += 3) {
      var dx = cx - p[i], dy = cy - p[i + 1], dz = cz - p[i + 2];
      var d2 = dx * dx + dy * dy + dz * dz;
      if (d2 > most) most = d2;
    }
    var s = new THREE.Sphere();
    s.center.set(cx, cy, cz);
    s.radius = Math.sqrt(most);
    geo.boundingSphere = s;
  };

  /**
   * Turns a buffer into a mesh that shares the ground material.
   * @param {GBuf} buf Filled buffer.
   * @param {number} order renderOrder.
   * @returns {?object} THREE.Mesh, or null if the buffer is empty.
   */
  ground.mesh = function (buf, order) {
    if (!buf.ni) return null;
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(buf.pos.slice(0, buf.nv * 3), 3));
    geo.setAttribute('color', new THREE.BufferAttribute(new Uint8Array(buf.col.buffer.slice(0, buf.nv * 4)), 4, true));
    geo.setAttribute('aU', new THREE.BufferAttribute(buf.uu.slice(0, buf.nv), 1));
    geo.setAttribute('aVM', new THREE.BufferAttribute(buf.vm.slice(0, buf.nv * 2), 2));
    var idx = buf.nv < 65535 ? new Uint16Array(buf.ni) : new Uint32Array(buf.ni);
    idx.set(buf.idx.subarray(0, buf.ni));
    geo.setIndex(new THREE.BufferAttribute(idx, 1));
    ground.fitSphere(geo);
    var m = new THREE.Mesh(geo, material);
    m.renderOrder = order;
    m.receiveShadow = true;
    m.matrixAutoUpdate = false;
    return m;
  };

  var GROUND_VERT_HEAD = [
    'attribute float aU;',
    'attribute vec2 aVM;',
    'varying float vU;',
    'varying float vV;',
    'varying float vMat;'
  ].join('\n');

  var GROUND_FRAG_HEAD = [
    'varying float vU;',
    'varying float vV;',
    'varying float vMat;',
    'uniform sampler2D uMask;',
    'uniform vec4 uMaskRect;',
    'uniform vec3 uShallow, uDeep, uSkyRefl, uGlint, uFoam;',
    'uniform vec3 uCurb[6];',
    'uniform float uTime2;',
    'float h21(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
    'float vn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
    '  return mix(mix(h21(i), h21(i + vec2(1, 0)), f.x), mix(h21(i + vec2(0, 1)), h21(i + vec2(1, 1)), f.x), f.y); }',
    'float lineA(float v, float edge) {',
    '  float w = max(fwidth(v), 1e-4);',
    '  return clamp((edge - abs(v)) / w + 0.5, 0.0, 1.0) * min(1.0, 2.0 * edge / (w * 1.4));',
    '}'
  ].join('\n');

  /** Runs after color_fragment. Sets the albedo of each surface program. @returns {string} GLSL. */
  function groundAlbedo() {
    var dash = TLV.tune.render.dashM.toFixed(1);
    var motorDash = TLV.tune.render.motorway.dashM.toFixed(1);
    var stripe = (TLV.tune.render.curbStripeM * 2).toFixed(1);
    return [
    'int gm = int(vMat + 0.5);',
    'vec2 wxy = vec2(vWP.x, -vWP.z);',
    'if (gm == ' + MAT.ASPHALT + ') {',
    '  float n1 = vn(wxy * 0.09), n2 = vn(wxy * 1.3), n3 = vn(wxy * 8.0);',
    '  diffuseColor.rgb *= 0.86 + 0.2 * n1 + 0.1 * n2 + 0.1 * n3;',
    '  diffuseColor.rgb *= 1.0 - 0.07 * smoothstep(0.45, 0.8, vn(wxy * 0.07 + 3.0));',
    '} else if (gm == ' + MAT.PAVING + ' || gm == ' + MAT.STONE + ') {',
    '  float sz = gm == ' + MAT.PAVING + ' ? 0.6 : 0.9;',
    '  vec2 tp = wxy / sz; vec2 g = abs(fract(tp) - 0.5);',
    '  float fw = max(fwidth(tp.x), fwidth(tp.y));',
    '  float joint = smoothstep(0.5 - fw - 0.03, 0.5, max(g.x, g.y)) * (1.0 - smoothstep(0.1, 0.5, fw));',
    '  float cell = h21(floor(tp));',
    '  diffuseColor.rgb *= (0.9 + 0.13 * cell * (1.0 - smoothstep(0.1, 0.5, fw))) * (0.92 + 0.12 * vn(wxy * 0.3)) * (1.0 - 0.22 * joint);',
    '} else if (gm == ' + MAT.GRASS + ') {',
    '  float n1 = vn(wxy * 0.17), n2 = vn(wxy * 1.9), n3 = vn(wxy * 7.0);',
    '  diffuseColor.rgb *= vec3(0.74 + 0.5 * n1, 0.8 + 0.36 * n1, 0.7 + 0.3 * n2) * (0.82 + 0.3 * n3);',
    '} else if (gm == ' + MAT.SAND + ' || gm == ' + MAT.DIRT + ') {',
    '  float n1 = vn(wxy * 0.21), n2 = vn(wxy * 2.3);',
    '  diffuseColor.rgb *= 0.9 + 0.13 * n1 + 0.09 * n2;',
    '} else if (gm == ' + MAT.YARD + ') {',
    // Fine gravel. No large-scale noise: at eye level that is what reads as a smear.
    '  float mpp = max(fwidth(wxy.x), fwidth(wxy.y));',
    '  float fine = 1.0 - smoothstep(0.02, 0.2, mpp);',
    '  float n2 = vn(wxy * 1.9), n3 = vn(wxy * 6.5), n4 = vn(wxy * 18.0);',
    '  diffuseColor.rgb *= 0.95 + 0.06 * n2 + fine * (0.22 * n3 + 0.2 * n4 - 0.21);',
    '} else if (gm == ' + MAT.BED + ') {',
    // Planting: hard-edged clumps of leaf over dark soil.
    '  float mpp = max(fwidth(wxy.x), fwidth(wxy.y));',
    '  float fine = 1.0 - smoothstep(0.02, 0.2, mpp);',
    '  float a = vn(wxy * 1.3 + 4.0), b = vn(wxy * 3.7), c = vn(wxy * 9.0);',
    '  float leaf = smoothstep(0.42, 0.48, a * 0.55 + b * 0.35 + c * 0.1);',
    '  vec3 soil = vec3(0.1, 0.075, 0.05);',
    '  vec3 lo = vec3(0.1, 0.2, 0.06), hi = vec3(0.26, 0.4, 0.13);',
    '  diffuseColor.rgb = mix(soil, mix(lo, hi, c), mix(0.82, leaf, fine)) * (0.84 + 0.32 * fine * vn(wxy * 23.0));',
    '} else if (gm == ' + MAT.PLAZA + ') {',
    // Large pale slabs, with a darker course every eight slabs.
    '  vec2 tp = wxy / 1.5; vec2 g = abs(fract(tp) - 0.5);',
    '  float fw = max(fwidth(tp.x), fwidth(tp.y));',
    '  float joint = smoothstep(0.5 - fw - 0.02, 0.5, max(g.x, g.y)) * (1.0 - smoothstep(0.1, 0.5, fw));',
    '  vec2 cr = abs(fract(wxy / 12.0) - 0.5);',
    '  float course = smoothstep(0.455, 0.46, max(cr.x, cr.y));',
    '  float cell = h21(floor(tp));',
    '  diffuseColor.rgb *= (0.95 + 0.07 * cell * (1.0 - smoothstep(0.1, 0.5, fw))) * (1.0 - 0.15 * joint) * (1.0 - 0.1 * course);',
    '} else if (gm == ' + MAT.LINE + ') {',
    '  diffuseColor.a *= lineA(vV, 0.667);',
    '  diffuseColor.rgb *= 0.86 + 0.2 * vn(wxy * 2.6);',
    '} else if (gm == ' + MAT.DASH + ') {',
    '  float fu = fract(vU / ' + dash + ');',
    '  float au = max(fwidth(vU / ' + dash + '), 1e-4);',
    '  diffuseColor.a *= lineA(vV, 0.667) * clamp((0.25 - abs(fu - 0.5)) / au + 0.5, 0.0, 1.0);',
    '  diffuseColor.rgb *= 0.86 + 0.2 * vn(wxy * 2.6);',
    '} else if (gm == ' + MAT.MOTORWAY_DASH + ') {',
    // A quarter of the period is paint: 3 m on, 9 m off.
    '  float fm = fract(vU / ' + motorDash + ');',
    '  float am = max(fwidth(vU / ' + motorDash + '), 1e-4);',
    '  diffuseColor.a *= lineA(vV, 0.667) * clamp((0.125 - abs(fm - 0.125)) / am + 0.5, 0.0, 1.0);',
    '  diffuseColor.rgb *= 0.86 + 0.2 * vn(wxy * 2.6);',
    '} else if (gm == ' + MAT.ZEBRA + ') {',
    '  diffuseColor.rgb *= 0.84 + 0.22 * vn(wxy * 3.1);',
    '} else if (gm >= ' + MAT.CURB + ' && gm <= ' + MAT.CURB_BW + ') {',
    '  float sf = fract(vU / ' + stripe + ');',
    '  float sw = clamp(fwidth(vU / ' + stripe + ') * 2.0, 0.002, 0.5);',
    '  float k = smoothstep(0.5 - sw, 0.5 + sw, sf) * (1.0 - smoothstep(1.0 - sw, 1.0, sf));',
    '  int ci = gm - ' + MAT.CURB_RW + ';',
    '  vec3 ca = gm == ' + MAT.CURB + ' ? diffuseColor.rgb : uCurb[ci * 2], cb = gm == ' + MAT.CURB + ' ? ca : uCurb[ci * 2 + 1];',
    // Paint keeps to the top of the kerb, in square blocks. A stripe carried down the face folds over the edge into an arrowhead.
    '  vec3 paint = mix(ca, cb, k);',
    '  if (vV > 0.5) paint = mix(paint, vec3(0.30, 0.29, 0.27), 0.72);',
    '  if (gm != ' + MAT.CURB + ') diffuseColor.rgb = paint * clamp(diffuseColor.g * 2.4, 0.5, 1.1) * (0.85 + 0.25 * vn(wxy * 2.0));',
    '}'
    ].join('\n');
  }

  // Replaces the light sum for water, which does not take diffuse light.
  var GROUND_WATER = [
    'if (gm >= ' + MAT.SEA + ' && gm <= ' + MAT.FOAM + ') {',
    '  vec3 V = normalize(cameraPosition - vWP);',
    '  vec2 p = wxy * 0.05; float t = uTime2;',
    '  gFogK = gm == ' + MAT.WATER + ' ? 1.0 : 0.16;',
    '  float dist = length(cameraPosition - vWP);',
    '  float fine = 1.0 - smoothstep(180.0, 900.0, dist);',
    '  vec3 Nw = normalize(vec3((vn(p * 2.3 + t * 0.2) - 0.5) * 0.16 + (vn(p * 9.0 - t * 0.5) - 0.5) * 0.2 * fine, 1.0,',
    '    (vn(p * 2.9 - t * 0.17) - 0.5) * 0.16 + (vn(p * 11.0 + t * 0.4) - 0.5) * 0.2 * fine));',
    '  vec3 Rw = reflect(-V, Nw);',
    '  float fres = pow(1.0 - max(dot(V, Nw), 0.0), 3.0);',
    '  float gl = pow(max(dot(Rw, uSunW), 0.0), 500.0) * 2.5;',
    '  vec3 wc = gm == ' + MAT.SEA + ' ? uDeep : diffuseColor.rgb;',
    '  if (gm == ' + MAT.SHORE + ') { float tv = 0.5 + 0.5 * vV; diffuseColor.a *= tv * tv * 0.85; }',
    '  if (gm == ' + MAT.FOAM + ') {',
    '    float w = 0.5 + 0.5 * sin(wxy.y * 0.07 + t * 0.6 + 4.0 * vn(wxy * 0.05));',
    '    float e = 1.0 - abs(vV) * (0.6 + 0.4 * w);',
    '    diffuseColor.a *= smoothstep(0.1, 0.5, e) * smoothstep(0.3, 0.6, vn(wxy * 0.5 + t * 0.25) * 0.5 + vn(wxy * 2.1 - t * 0.2) * 0.5 + 0.08);',
    '    outgoingLight = uFoam * 0.95;',
    '  } else {',
    '    outgoingLight = mix(wc, uSkyRefl, fres * 0.3) + uGlint * gl;',
    '  }',
    '}'
  ].join('\n');

  /** Curb stripes: red/white, red/yellow, blue/white, from the best curb.paint provider or tune. */
  function curbColours() {
    var list = TLV.render.styles.kit('curb.paint');
    var c = list.length && list[0].colours ? list[0].colours : TLV.tune.render.curbColours;
    return [].concat(c.red_white, c.red_yellow, c.blue_white).map(function (h) { return new THREE.Color(h); });
  }

  /** @returns {object} The ground material, built once per init. */
  function makeMaterial(mask) {
    var T = TLV.tune.render;
    var C = T.colors;
    var m = new THREE.MeshLambertMaterial({ vertexColors: true });
    m.depthTest = false;
    m.depthWrite = false;
    m.blending = THREE.CustomBlending;
    m.blendSrc = THREE.SrcAlphaFactor;
    m.blendDst = THREE.OneMinusSrcAlphaFactor;
    m.blendEquation = THREE.AddEquation;
    m.onBeforeCompile = function (shader) {
      TLV.render.sky.patch(shader);
      shader.uniforms.uMask = { value: mask.tex };
      shader.uniforms.uMaskRect = { value: mask.rect };
      shader.uniforms.uShallow = { value: new THREE.Color(C.seaShallow) };
      shader.uniforms.uDeep = { value: new THREE.Color(C.seaDeep) };
      shader.uniforms.uSkyRefl = { value: new THREE.Color('#e9d6bc') };
      shader.uniforms.uGlint = { value: new THREE.Color('#ffdca8') };
      shader.uniforms.uFoam = { value: new THREE.Color(C.foam) };
      shader.uniforms.uTime2 = TLV.render.sky.U.uTime;
      shader.uniforms.uCurb = { value: curbColours() };
      shader.vertexShader = GROUND_VERT_HEAD + '\n' + shader.vertexShader
        .replace('#include <beginnormal_vertex>', 'vec3 objectNormal = vec3(0.0, 1.0, 0.0);')
        .replace('#include <color_vertex>', [
          '#include <color_vertex>',
          'vColor.rgb = pow(vColor.rgb, vec3(2.2));',
          'vU = aU; vV = aVM.x / 127.5 - 1.0; vMat = aVM.y;'
        ].join('\n'));
      shader.fragmentShader = GROUND_FRAG_HEAD + '\n' + shader.fragmentShader
        .replace('#include <color_fragment>', '#include <color_fragment>\n' + groundAlbedo())
        .replace('#include <lights_fragment_end>', [
          '#include <lights_fragment_end>',
          'reflectedLight.directDiffuse *= texture2D(uMask, vec2((wxy.x - uMaskRect.x) / uMaskRect.z,',
          '  (uMaskRect.y - wxy.y) / uMaskRect.w)).r;'
        ].join('\n'))
        .replace('#include <opaque_fragment>', GROUND_WATER + '\n#include <opaque_fragment>');
    };
    return m;
  }

  /**
   * Bakes building and tree shadows into a grey map over the whole map. The shadow map covers only 100 m, and this keeps
   * the low sun on every street out to the haze, in no draw calls.
   * @returns {{tex:object, rect:object}} Texture, and rect (minX, maxY, widthM, heightM).
   */
  function bakeMask(W) {
    var T = TLV.tune.render;
    var b = W.bounds;
    var mpp = T.maskMPerPx;
    var wPx = Math.ceil((b.maxX - b.minX) / mpp);
    var hPx = Math.ceil((b.maxY - b.minY) / mpp);
    var cv = document.createElement('canvas');
    cv.width = wPx;
    cv.height = hPx;
    var ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, wPx, hPx);
    ctx.fillStyle = '#000';
    var ts = TLV.render.sky.toSun;
    var cot = Math.sqrt(ts.x * ts.x + ts.y * ts.y) / ts.z;
    var hl = Math.sqrt(ts.x * ts.x + ts.y * ts.y);
    var sx = -ts.x / hl * cot;      // Metres of shadow on the ground per metre of height
    var sy = -ts.y / hl * cot;
    var recipes = TLV.render.city.recipes;
    var ox = b.minX;
    var oy = b.maxY;
    var k = 1 / mpp;
    ctx.beginPath();
    var count = 0;
    for (var i = 0; i < W.blds.length; i++) {
      var bd = W.blds[i];
      var hh = recipes.heights(W, bd);
      var r = bd.rings[0];
      var n = r.length >> 1;
      var z0 = hh.base;
      var z1 = hh.top;
      for (var v = 0; v < n; v++) {
        var w2 = (v + 1) % n;
        var ax = (r[v * 2] - ox) * k, ay = (oy - r[v * 2 + 1]) * k;
        var bx = (r[w2 * 2] - ox) * k, by = (oy - r[w2 * 2 + 1]) * k;
        var a0x = ax + sx * z0 * k, a0y = ay - sy * z0 * k;
        var b0x = bx + sx * z0 * k, b0y = by - sy * z0 * k;
        var a1x = ax + sx * z1 * k, a1y = ay - sy * z1 * k;
        var b1x = bx + sx * z1 * k, b1y = by - sy * z1 * k;
        var area = (b0x - a0x) * (a1y - a0y) - (b0y - a0y) * (a1x - a0x);
        if (area === 0) continue;
        ctx.moveTo(a0x, a0y);
        if (area > 0) {
          ctx.lineTo(b0x, b0y);
          ctx.lineTo(b1x, b1y);
          ctx.lineTo(a1x, a1y);
        } else {
          ctx.lineTo(a1x, a1y);
          ctx.lineTo(b1x, b1y);
          ctx.lineTo(b0x, b0y);
        }
        ctx.closePath();
      }
      if (++count >= T.maskBatch) {
        ctx.fill();
        ctx.beginPath();
        count = 0;
      }
    }
    ctx.fill();

    // Tree crowns, as soft discs. The crown stands 5-7 m up.
    ctx.globalAlpha = 0.8;
    ctx.beginPath();
    for (var p = 0; p < W.props.length; p++) {
      var pr = W.props[p];
      if (pr.kind === 'lamp') continue;
      var cz = pr.kind === 'palm' ? 8 : 6;
      var cr = (pr.kind === 'palm' ? 2 : 3.6) * k;
      var cx = (pr.x + sx * cz - ox) * k;
      var cy = (oy - pr.y - sy * cz) * k;
      ctx.moveTo(cx + cr, cy);
      ctx.arc(cx, cy, cr, 0, 6.2832);
    }
    var strips = TLV.render.roads.strips(W);
    for (var st = 0; st < strips.length; st++) {
      var rec = strips[st].records;
      for (var ri = 0; ri < rec.length; ri++) {
        if (rec[ri].mesh !== 'ficus') continue;
        var tx = (rec[ri].x + sx * 6 - ox) * k;
        var ty = (oy - rec[ri].y - sy * 6) * k;
        ctx.moveTo(tx + 4.2 * k, ty);
        ctx.arc(tx, ty, 4.2 * k, 0, 6.2832);
      }
    }
    ctx.fill();

    var img = ctx.getImageData(0, 0, wPx, hPx).data;
    var red = new Uint8Array(wPx * hPx);
    for (var q = 0, o = 0; q < red.length; q++, o += 4) red[q] = img[o];
    var tex = new THREE.DataTexture(red, wPx, hPx, THREE.RedFormat, THREE.UnsignedByteType);
    tex.minFilter = THREE.LinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.ClampToEdgeWrapping;
    tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.unpackAlignment = 1;
    tex.needsUpdate = true;
    return { tex: tex, rect: new THREE.Vector4(b.minX, b.maxY, wPx * mpp, hPx * mpp) };
  }

  /** The coast: the sea outline with its map-edge sides dropped. @returns {number[][]} Polylines, x,y pairs. */
  function coastLines(W, sea) {
    var b = W.bounds;
    var eps = 1.5;
    var n = sea.length >> 1;
    function onEdge(i) {
      var x = sea[i * 2], y = sea[i * 2 + 1];
      return x <= b.minX + eps || x >= b.maxX - eps || y <= b.minY + eps || y >= b.maxY - eps;
    }
    var out = [];
    var cur = [];
    var start = 0;
    for (var s = 0; s < n; s++) {
      if (onEdge(s) && !onEdge((s + 1) % n)) {
        start = s;
        break;
      }
    }
    for (var k = 0; k <= n; k++) {
      var i = (start + k) % n;
      var j = (i + 1) % n;
      if (onEdge(i) && onEdge(j)) {
        if (cur.length >= 4) out.push(cur);
        cur = [];
        continue;
      }
      if (!cur.length) cur.push(sea[i * 2], sea[i * 2 + 1]);
      if (k < n) cur.push(sea[j * 2], sea[j * 2 + 1]);
    }
    if (cur.length >= 4) out.push(cur);
    return out;
  }

  /** Point-in-ring, even-odd. */
  function inRing(x, y, r) {
    var c = false;
    var n = r.length >> 1;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var yi = r[i * 2 + 1], yj = r[j * 2 + 1];
      if ((yi > y) !== (yj > y) && x < (r[j * 2] - r[i * 2]) * (y - yi) / (yj - yi) + r[i * 2]) c = !c;
    }
    return c;
  }

  /**
   * Handles a motorway item: lines of scenery the importer leaves out of the map. Content, not map: the sim never reads them.
   * @param {{id:string, lines:Array<{link:number, lanes:number, mouth:number[], pts:number[]}>}} def lat, lon pairs in the direction of travel.
   */
  ground.onMotorway = function (def) {
    if (!def || !Array.isArray(def.lines)) {
      TLV.registry.problem('motorway', def && def.id, 'motorway needs lines');
      return;
    }
    motorways.push(def);
  };

  /** @returns {Array<object>} The queued lines in map metres, with their arc lengths and drawn widths. Empty for a map with none. */
  function motorwayLines(W) {
    var M = TLV.tune.render.motorway;
    var origin = W.meta && W.meta.origin;
    var out = [];
    if (!origin) return out;
    for (var d = 0; d < motorways.length; d++) {
      var rows = motorways[d].lines;
      for (var i = 0; i < rows.length; i++) {
        var L = rows[i];
        var n = L.pts.length >> 1;
        if (n < 2) continue;
        var px = new Float64Array(n), py = new Float64Array(n), cum = new Float64Array(n);
        for (var k = 0; k < n; k++) {
          var p = TLV.anchors.project(L.pts[k * 2], L.pts[k * 2 + 1], origin);
          px[k] = p.x;
          py[k] = p.y;
          if (k) cum[k] = cum[k - 1] + Math.sqrt((px[k] - px[k - 1]) * (px[k] - px[k - 1]) + (py[k] - py[k - 1]) * (py[k] - py[k - 1]));
        }
        out.push({
          px: px, py: py, cum: cum, n: n, link: !!L.link, lanes: L.lanes, mouth: L.mouth || [0, 0],
          width: L.lanes * M.laneM + (L.link ? M.linkShoulderM : M.shoulderM) * 2
        });
      }
    }
    return out;
  }

  /**
   * The asphalt, the lane paint and the median's kerb, into the global mesh, so they cost no draw call. Roads paint over it, which makes every crossing a bridge.
   * The sim's fence runs on a carriageway's OSM centreline, and a car can reach it across open ground. So the carriageway is laid from that line toward the
   * median: the wall the car meets is the outer edge it can see, and no lane has an invisible wall down the middle of it. That moves a carriageway half its width.
   * @param {GBuf} buf Base buffer.
   * @param {Array<object>} lines From motorwayLines.
   */
  function paintMotorways(buf, lines) {
    var T = TLV.tune.render;
    var M = T.motorway;
    var asphalt = rgba(M.asphalt);
    var concrete = rgba(M.concrete);
    var white = rgba(T.colors.paint);
    var half = M.paintM * 1.5 / 2;
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      // Metres left of the line, for its right and left edges.
      var right = L.link ? -L.width / 2 : 0;
      var left = right + L.width;
      var shoulder = L.link ? M.linkShoulderM : M.shoulderM;
      buf.ribbon(L.px, L.py, L.n, left, -right, 0, asphalt, MAT.ASPHALT, L.cum);
      buf.ribbon(L.px, L.py, L.n, left + half - shoulder, shoulder - left + half, 0, white, MAT.LINE, L.cum);
      buf.ribbon(L.px, L.py, L.n, right + shoulder + half, -right - shoulder + half, 0, white, MAT.LINE, L.cum);
      for (var k = 1; k < L.lanes; k++) {
        var at = right + shoulder + k * M.laneM;
        buf.ribbon(L.px, L.py, L.n, at + half, -at + half, 0, white, MAT.MOTORWAY_DASH, L.cum);
      }
      var edge = M.barrierHalfM * 2;
      buf.ribbon(L.px, L.py, L.n, left + edge, -left, 0, concrete, MAT.FLAT);
      if (L.link) buf.ribbon(L.px, L.py, L.n, right, -right + edge, 0, concrete, MAT.FLAT);
    }
  }

  /** A point on a line by arc length, with its left normal. Writes out.x, y, nx, ny. */
  function pointOn(L, s, out) {
    var i = 1;
    while (i < L.n - 1 && L.cum[i] < s) i++;
    var dx = L.px[i] - L.px[i - 1], dy = L.py[i] - L.py[i - 1];
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var t = (s - L.cum[i - 1]) / len;
    out.x = L.px[i - 1] + dx * t;
    out.y = L.py[i - 1] + dy * t;
    out.nx = -dy / len;
    out.ny = dx / len;
  }

  /** The stretch of a line between two arc lengths, keeping its own points. @returns {{x:number[], y:number[]}} */
  function stretch(L, a, b) {
    var p = {};
    pointOn(L, a, p);
    var x = [p.x], y = [p.y];
    for (var i = 0; i < L.n; i++) {
      if (L.cum[i] > a + 0.01 && L.cum[i] < b - 0.01) {
        x.push(L.px[i]);
        y.push(L.py[i]);
      }
    }
    pointOn(L, b, p);
    x.push(p.x);
    y.push(p.y);
    return { x: x, y: y };
  }

  /** One face of a barrier, a to b, with the face to its right as seen from a. The colour falls off away from the sun, which the ground's upward normal cannot do. */
  function barrierFace(buf, ax, ay, bx, by, h, col) {
    var ts = TLV.render.sky.toSun;
    var dx = bx - ax, dy = by - ay;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var sun = Math.max(0, (dy * ts.x - dx * ts.y) / len);
    var c = ground.shade(col, 0.62 + 0.38 * sun);
    buf.quad(ax, ay, 0, 0, 0, bx, by, 0, 0, 0, bx, by, h, 0, 0, ax, ay, h, 0, 0, c, MAT.FLAT);
  }

  /**
   * A low wall along a polyline: top, both long faces and the two ends. The ground draws without depth, so culling is what leaves the faces the camera can see.
   * @param {GBuf} buf Wall buffer.
   * @param {ArrayLike<number>} px Polyline x.
   * @param {ArrayLike<number>} py Polyline y.
   * @param {number} n Points.
   */
  function barrier(buf, px, py, n) {
    var M = TLV.tune.render.motorway;
    var col = rgba(M.concrete);
    var h = M.barrierM, hw = M.barrierHalfM;
    for (var i = 1; i < n; i++) {
      var ax = px[i - 1], ay = py[i - 1], bx = px[i], by = py[i];
      var dx = bx - ax, dy = by - ay;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len < 0.01) continue;
      var nx = -dy / len * hw, ny = dx / len * hw;
      barrierFace(buf, ax - nx, ay - ny, bx - nx, by - ny, h, col);
      barrierFace(buf, bx + nx, by + ny, ax + nx, ay + ny, h, col);
      buf.quad(ax - nx, ay - ny, h, 0, 0, bx - nx, by - ny, h, 0, 0, bx + nx, by + ny, h, 0, 0, ax + nx, ay + ny, h, 0, 0, col, MAT.FLAT);
      if (i === 1) barrierFace(buf, ax + nx, ay + ny, ax - nx, ay - ny, h, col);
      if (i === n - 1) barrierFace(buf, bx - nx, by - ny, bx + nx, by + ny, h, col);
    }
  }

  /**
   * The carriageway's outer wall, and a parapet along each road that bridges it. The wall stops where a road paints over the line, so it has the sim's gaps, closed
   * up to the road's edge: the 3 m of clearance either side of a road are painted wall with no collider behind them.
   * @param {GBuf} buf Wall buffer.
   * @param {object} W World.
   * @param {object} L Line.
   */
  function carriagewayWalls(buf, W, L) {
    var M = TLV.tune.render.motorway;
    var step = M.sampleM;
    var count = Math.ceil(L.cum[L.n - 1] / step) + 1;
    var across = M.parapetSamples;
    var road = new Uint8Array(count * across);
    var any = new Uint8Array(count);
    var p = {};
    function spot(i, q, out) {
      pointOn(L, Math.min(i * step, L.cum[L.n - 1]), p);
      var off = L.width * q / (across - 1);
      out.x = p.x + p.nx * off;
      out.y = p.y + p.ny * off;
    }
    var q = {};
    var reach = Math.ceil(M.walkM / step);
    for (var i = 0; i < count; i++) {
      for (var a = 0; a < across; a++) {
        spot(i, a, q);
        if (!onRoad(W, q.x, q.y)) continue;
        // Out past the road's sidewalk, which the raster does not tell from bare ground.
        for (var d = Math.max(0, i - reach); d <= Math.min(count - 1, i + reach); d++) {
          road[d * across + a] = 1;
          any[d] = 1;
        }
      }
    }
    // The outer wall: everything on the fence's line that no road covers.
    var from = -1;
    for (var w = 0; w <= count; w++) {
      var clear = w < count && !road[w * across];
      if (clear && from < 0) from = w;
      if (!clear && from >= 0) {
        if (w - from >= 2) {
          var run = stretch(L, from * step, Math.min((w - 1) * step, L.cum[L.n - 1]));
          barrier(buf, run.x, run.y, run.x.length);
        }
        from = -1;
      }
    }
    // A parapet across the carriageway at each end of each crossing, on the line where the road's paint stops.
    for (var r = 0; r < count; r++) {
      if (!any[r] || (r && any[r - 1])) continue;
      var end = r;
      while (end + 1 < count && any[end + 1]) end++;
      if ((end - r) * step < M.bridgeMaxM) {
        parapet(buf, road, r, end, across, count, spot, 1);
        parapet(buf, road, r, end, across, count, spot, -1);
      }
    }
  }

  /** One parapet: for each sample across, the last clear point before the road, from the side dir comes from. */
  function parapet(buf, road, a, b, across, count, spot, dir) {
    var x = [], y = [];
    var p = {};
    for (var k = 0; k < across; k++) {
      var i = dir > 0 ? a : b;
      while (i >= a && i <= b && !road[i * across + k]) i += dir;
      if (i < a || i > b) continue;
      spot(Math.max(0, Math.min(count - 1, i - dir)), k, p);
      x.push(p.x);
      y.push(p.y);
    }
    if (x.length >= 2) barrier(buf, x, y, x.length);
  }

  /** @returns {boolean} True on a road of the map. Bare ground and a sidewalk read the same in the raster, so this is all it can say. */
  function onRoad(W, x, y) {
    var b = W.bounds;
    return x > b.minX && x < b.maxX && y > b.minY && y < b.maxY && TLV.world.surface.at(W, x, y) === TLV.const.SURF.ROAD;
  }

  /** A wall across a ramp where it leaves the streets, just past their paint. A ramp is not in the graph, so it must not look like a turning. */
  function rampCap(buf, W, L, atEnd) {
    var M = TLV.tune.render.motorway;
    var len = L.cum[L.n - 1];
    var p = {};
    for (var s = 0; s < Math.min(len, M.bridgeMaxM); s += M.sampleM) {
      pointOn(L, atEnd ? len - s : s, p);
      if (onRoad(W, p.x, p.y)) continue;
      pointOn(L, atEnd ? Math.max(0, len - s - M.walkM) : Math.min(len, s + M.walkM), p);
      var hw = L.width / 2;
      barrier(buf, [p.x + p.nx * hw, p.x - p.nx * hw], [p.y + p.ny * hw, p.y - p.ny * hw], 2);
      return;
    }
  }

  /**
   * The walls stand up, and a wall in the base mesh would be painted over by any street behind it, so they get a mesh of their own, drawn after the chunks' ground.
   * @returns {GBuf} Buffer, empty for a map with no motorway.
   */
  function buildWalls(W, lines) {
    var buf = new GBuf(4096);
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      if (!L.link) carriagewayWalls(buf, W, L);
      if (L.mouth[0]) rampCap(buf, W, L, false);
      if (L.mouth[1]) rampCap(buf, W, L, true);
    }
    return buf;
  }

  /** One global mesh: land, sea, shore, parks, beach. Beyond the chunks this is the whole ground. */
  function buildBase(W, lines) {
    var T = TLV.tune.render;
    var C = T.colors;
    var far = 16000;
    var b = W.bounds;
    var buf = new GBuf(65536);
    var sea = null;
    for (var i = 0; i < W.land.length; i++) if (W.land[i].cls === 0) sea = W.land[i].poly;

    // Land everywhere first, out to the horizon.
    var outer = rgba(C.outerLand);
    buf.quad(-far, -far, 0, 0, 0, far, -far, 0, 0, 0, far, far, 0, 0, 0, -far, far, 0, 0, 0, outer, MAT.DIRT);
    var land = rgba(C.base);
    buf.quad(b.minX, b.minY, 0, 0, 0, b.maxX, b.minY, 0, 0, 0, b.maxX, b.maxY, 0, 0, 0, b.minX, b.maxY, 0, 0, 0, land, MAT.YARD);

    var coast = sea ? coastLines(W, sea) : [];
    if (sea) {
      var seaCol = rgba(C.seaDeep);
      buf.polygon(sea, 0, seaCol, MAT.SEA);
      // The sea beyond the map: west of a line continuing the coast's ends.
      var main = coast.reduce(function (a, c) { return c.length > a.length ? c : a; }, []);
      if (main.length >= 4) {
        var ny = main[1] > main[main.length - 1] ? 0 : main.length - 2;   // Index of the north end
        var sy = ny === 0 ? main.length - 2 : 0;
        var nx0 = main[ny], ny0 = main[ny + 1], sx0 = main[sy], sy0 = main[sy + 1];
        var slope = (nx0 - sx0) / Math.max(1, ny0 - sy0);
        var nxFar = nx0 + (far - ny0) * slope;
        var sxFar = sx0 + (-far - sy0) * slope;
        buf.quad(-far, -far, 0, 0, 0, sxFar, -far, 0, 0, 0, sx0, sy0, 0, 0, 0, -far, sy0, 0, 0, 0, seaCol, MAT.SEA);
        buf.quad(-far, ny0, 0, 0, 0, nx0, ny0, 0, 0, 0, nxFar, far, 0, 0, 0, -far, far, 0, 0, 0, seaCol, MAT.SEA);
        buf.quad(-far, sy0, 0, 0, 0, b.minX, sy0, 0, 0, 0, b.minX, ny0, 0, 0, 0, -far, ny0, 0, 0, 0, seaCol, MAT.SEA);
      }
    }

    var order = [2, 3, 7, 5, 8, 1, 6, 4];
    var mats = {
      // CONSTRUCTION is drawn as plaza: Rabin Square is one of these rows, and a dirt field there reads as a vacant lot.
      1: [C.beach, MAT.SAND], 2: [C.park, MAT.GRASS], 3: [C.garden, MAT.GRASS], 4: [C.water, MAT.WATER], 5: [C.plaza, MAT.PLAZA],
      6: [C.sand, MAT.SAND], 7: [C.pitch, MAT.GRASS], 8: [C.plaza, MAT.PLAZA]
    };
    for (var o = 0; o < order.length; o++) {
      var cls = order[o];
      var col = rgba(mats[cls][0]);
      for (var l = 0; l < W.land.length; l++) {
        if (W.land[l].cls === cls) buf.polygon(W.land[l].poly, 0, col, mats[cls][1]);
      }
    }
    for (var q = 0; q < W.lots.length; q++) {
      if (W.lots[q].poly && W.lots[q].poly.length >= 6) buf.polygon(W.lots[q].poly, 0, rgba(C.lot), MAT.ASPHALT);
    }
    paintMotorways(buf, lines);

    // Turquoise shallows and foam, on top of everything that meets the sea: seaward only, so sand stays sand.
    for (var c = 0; c < coast.length; c++) {
      var line = coast[c];
      var pn = line.length >> 1;
      var px = new Float32Array(pn);
      var py = new Float32Array(pn);
      for (var k = 0; k < pn; k++) {
        px[k] = line[k * 2];
        py[k] = line[k * 2 + 1];
      }
      // Which side of the line is water.
      var mx = (px[0] + px[1]) / 2;
      var my = (py[0] + py[1]) / 2;
      var dx = px[1] - px[0], dy = py[1] - py[0];
      var dl = Math.max(1e-3, Math.sqrt(dx * dx + dy * dy));
      var leftIsSea = inRing(mx - dy / dl * 5, my + dx / dl * 5, sea);
      var shore = rgba(C.seaShallow);
      var foam = rgba(C.foam);
      var band = simplify(px, py, 18);
      var off = T.shoreBandM;
      // v runs from the far side (-1) to the waterline (1), so the shader fades the band out to sea.
      if (leftIsSea) {
        buf.ribbon(band.x, band.y, band.n, off, 0, 0, shore, MAT.SHORE);
        buf.ribbon(px, py, pn, T.foamM, 0.5, 0, foam, MAT.FOAM);
      } else {
        buf.ribbon(band.x, band.y, band.n, 0, off, 0, shore, MAT.SHORE, null, 1, -1);
        buf.ribbon(px, py, pn, 0.5, T.foamM, 0, foam, MAT.FOAM);
      }
    }
    return buf;
  }

  /** Douglas-Peucker, so the shallows do not fan at every breakwater. */
  function simplify(px, py, tol) {
    var n = px.length;
    var keep = new Uint8Array(n);
    keep[0] = keep[n - 1] = 1;
    var stack = [0, n - 1];
    while (stack.length) {
      var b = stack.pop();
      var a = stack.pop();
      var dx = px[b] - px[a], dy = py[b] - py[a];
      var L = Math.sqrt(dx * dx + dy * dy) || 1;
      var worst = 0;
      var at = -1;
      for (var i = a + 1; i < b; i++) {
        var d = Math.abs((px[i] - px[a]) * dy - (py[i] - py[a]) * dx) / L;
        if (d > worst) {
          worst = d;
          at = i;
        }
      }
      if (worst > tol) {
        keep[at] = 1;
        stack.push(a, at, at, b);
      }
    }
    var x = [];
    var y = [];
    for (var k = 0; k < n; k++) {
      if (keep[k]) {
        x.push(px[k]);
        y.push(py[k]);
      }
    }
    return { x: x, y: y, n: x.length };
  }

  ground.simplify = simplify;

  /**
   * Bakes the sun mask and builds the global ground. Runs in Phase 2.
   * @param {object} scene THREE.Scene.
   * @param {object} W World.
   */
  ground.init = function (scene, W) {
    sceneRef = scene;
    var mask = bakeMask(W);
    maskTex = mask.tex;
    material = makeMaterial(mask);
    var lines = motorwayLines(W);
    var buf = buildBase(W, lines);
    baseMesh = ground.mesh(buf, -20);
    baseMesh.frustumCulled = false;
    scene.add(baseMesh);
    wallMesh = ground.mesh(buildWalls(W, lines), -9);
    if (wallMesh) scene.add(wallMesh);
  };

  /** Frees the mask, the material and the global mesh. */
  ground.dispose = function () {
    if (!sceneRef) return;
    sceneRef.remove(baseMesh);
    baseMesh.geometry.dispose();
    if (wallMesh) {
      sceneRef.remove(wallMesh);
      wallMesh.geometry.dispose();
    }
    material.dispose();
    maskTex.dispose();
    baseMesh = wallMesh = material = maskTex = sceneRef = null;
  };
})(window.TLV);
