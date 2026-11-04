// js/render/city/details.js — WP-RENDER
// Global InstancedMesh pools for L0 and L1 content (section 15.3). Chunks hold records; each pool refreshes in turn around
// the focus, and drops its farthest instances when over its cap. Meshes are procedural unless a `mesh` item names an asset.
(function (TLV) {
  'use strict';

  var details = TLV.ns('render.city.details');

  var pools = [];
  var byId = Object.create(null);
  var material = null;
  var sceneRef = null;
  var cursor = 0;
  var world = null;
  var srgb = new Float32Array(256);
  var motoMesh = null;
  var ids = [];
  var boxOut = { x: 0, y: 0, h: 0, length: 0, width: 0 };
  var shellPools = null;       // Parked cars inside parkedBodyM: instanced on the live cars' own geometry
  var SHELL_KINDS = ['sedan', 'hatch', 'taxi'];   // The order of traffic.materializeParked, so a stall's body is its live body
  var batch = null;            // Street clutter: one mesh, rewritten as the focus moves
  var CLUTTER_MESHES = ['cafe_set', 'cafe_shade', 'bin', 'bike_rack', 'scooter', 'e_scooter', 'elec_box', 'street_sign'];

  /** A small geometry writer. Faces carry flat normals and vertex colours. Model axes: +X forward, +Y up. */
  function Mesher() {
    this.p = [];
    this.n = [];
    this.c = [];
  }

  function hexRGB(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [srgb[(n >> 16) & 255], srgb[(n >> 8) & 255], srgb[n & 255]];
  }

  Mesher.prototype.tri = function (a, b, c, col) {
    var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    var vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var L = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
    nx /= L; ny /= L; nz /= L;
    this.p.push(a[0], a[1], a[2], b[0], b[1], b[2], c[0], c[1], c[2]);
    for (var i = 0; i < 3; i++) {
      this.n.push(nx, ny, nz);
      this.c.push(col[0], col[1], col[2]);
    }
  };

  Mesher.prototype.quad = function (a, b, c, d, col) {
    this.tri(a, b, c, col);
    this.tri(a, c, d, col);
  };

  /** Axis box. skip is a string of faces to omit: 'x' +X, 'X' -X, 'y', 'Y', 'z', 'Z'. */
  Mesher.prototype.box = function (x0, y0, z0, x1, y1, z1, hex, skip) {
    var col = hexRGB(hex);
    var s = skip || '';
    var P = function (x, y, z) { return [x, y, z]; };
    if (s.indexOf('x') < 0) this.quad(P(x1, y0, z1), P(x1, y0, z0), P(x1, y1, z0), P(x1, y1, z1), col);
    if (s.indexOf('X') < 0) this.quad(P(x0, y0, z0), P(x0, y0, z1), P(x0, y1, z1), P(x0, y1, z0), col);
    if (s.indexOf('y') < 0) this.quad(P(x0, y1, z1), P(x1, y1, z1), P(x1, y1, z0), P(x0, y1, z0), col);
    if (s.indexOf('Y') < 0) this.quad(P(x0, y0, z0), P(x1, y0, z0), P(x1, y0, z1), P(x0, y0, z1), col);
    if (s.indexOf('z') < 0) this.quad(P(x0, y0, z1), P(x1, y0, z1), P(x1, y1, z1), P(x0, y1, z1), col);
    if (s.indexOf('Z') < 0) this.quad(P(x1, y0, z0), P(x0, y0, z0), P(x0, y1, z0), P(x1, y1, z0), col);
  };

  /** Upright cylinder or cone, no caps below. */
  Mesher.prototype.cyl = function (cx, cz, r0, r1, y0, y1, seg, hex, hex2) {
    var c0 = hexRGB(hex);
    var c1 = hex2 ? hexRGB(hex2) : c0;
    for (var i = 0; i < seg; i++) {
      var a = i / seg * 6.2832, b = (i + 1) / seg * 6.2832;
      var p0 = [cx + Math.cos(a) * r0, y0, cz + Math.sin(a) * r0];
      var p1 = [cx + Math.cos(b) * r0, y0, cz + Math.sin(b) * r0];
      var p2 = [cx + Math.cos(b) * r1, y1, cz + Math.sin(b) * r1];
      var p3 = [cx + Math.cos(a) * r1, y1, cz + Math.sin(a) * r1];
      this.quad(p0, p3, p2, p1, i & 1 ? c0 : c1);
    }
  };

  /**
   * A trunk: one continuous taper with round normals, from a root flare at the ground to a thin top inside the crown.
   * @param {number} r0 Radius at the ground.
   * @param {number} r1 Radius at the top.
   * @param {number} h Height.
   * @param {number} seg Sides.
   * @param {string} hex Colour low on the trunk.
   * @param {string} hex2 Colour at the top.
   */
  Mesher.prototype.trunk = function (r0, r1, h, seg, hex, hex2) {
    var c0 = hexRGB(hex), c1 = hexRGB(hex2);
    var lean = (r0 - r1) / h;
    for (var i = 0; i < seg; i++) {
      var a = i / seg * 6.2832, b = (i + 1) / seg * 6.2832;
      var ca = Math.cos(a), sa = Math.sin(a), cb = Math.cos(b), sb = Math.sin(b);
      var P = [[ca * r0, 0, sa * r0], [ca * r1, h, sa * r1], [cb * r1, h, sb * r1], [cb * r0, 0, sb * r0]];
      var N = [[ca, lean, sa], [ca, lean, sa], [cb, lean, sb], [cb, lean, sb]];
      var C = [c0, c1, c1, c0];
      var order = [0, 1, 2, 0, 2, 3];
      for (var k = 0; k < 6; k++) {
        var q = order[k];
        this.p.push(P[q][0], P[q][1], P[q][2]);
        this.n.push(N[q][0], N[q][1], N[q][2]);
        this.c.push(C[q][0], C[q][1], C[q][2]);
      }
    }
  };

  /** A quad seen from both sides. */
  Mesher.prototype.plate = function (a, b, c, d, col) {
    this.quad(a, b, c, d, col);
    this.quad(d, c, b, a, col);
  };

  /** A flat wheel, seen from both sides: a hexagon on the YZ plane at x. */
  Mesher.prototype.wheel = function (x, y, z, r, hex) {
    var col = hexRGB(hex);
    for (var i = 0; i < 6; i++) {
      var a = i / 6 * 6.2832, b = (i + 1) / 6 * 6.2832;
      var p = [x, y + Math.sin(a) * r, z + Math.cos(a) * r], q = [x, y + Math.sin(b) * r, z + Math.cos(b) * r];
      this.tri([x, y, z], p, q, col);
      this.tri([x, y, z], q, p, col);
    }
  };

  /** A rough ball: an icosahedron with its corners pushed about, darker underneath. */
  Mesher.prototype.blob = function (cx, cy, cz, rx, ry, rz, top, bottom, seed) {
    var t = (1 + Math.sqrt(5)) / 2;
    var V = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]];
    var F = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
      [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
    var r = TLV.rng.create(seed || 1);
    var pts = V.map(function (v) {
      var L = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
      var k = (0.86 + r.next() * 0.3) / L;
      return [cx + v[0] * k * rx, cy + v[1] * k * ry, cz + v[2] * k * rz];
    });
    var ct = hexRGB(top);
    var cb = hexRGB(bottom);
    for (var i = 0; i < F.length; i++) {
      var a = pts[F[i][0]], b = pts[F[i][1]], c = pts[F[i][2]];
      var q = ((a[1] + b[1] + c[1]) / 3 - (cy - ry)) / (2 * ry);
      q = Math.max(0, Math.min(1, q)) + (r.next() - 0.5) * 0.14;
      this.tri(a, b, c, [cb[0] + (ct[0] - cb[0]) * q, cb[1] + (ct[1] - cb[1]) * q, cb[2] + (ct[2] - cb[2]) * q]);
    }
  };

  /**
   * One tuft of leaves: a small rough four-sided bipyramid, turned at random so no two line up. Normals lean out from the crown's centre
   * and colour falls off toward it, so a crown of tufts shades as one mass with dark hollows, not as a heap of gems.
   * @param {number[]} c Tuft centre.
   * @param {number} r Tuft radius.
   * @param {object} q Crown: o centre, ry half height, rm outer radius, top and bottom colours.
   * @param {object} rng Stream.
   */
  Mesher.prototype.tuft = function (c, r, q, rng) {
    var ya = rng.next() * 6.2832, xa = (rng.next() - 0.5) * 2.2;
    var cy = Math.cos(ya), sy = Math.sin(ya), cx = Math.cos(xa), sx = Math.sin(xa);
    var D = [[0, 1, 0], [0, -1, 0]];
    for (var e = 0; e < 4; e++) D.push([Math.cos(e * 1.5708), 0, Math.sin(e * 1.5708)]);
    var P = D.map(function (d) {
      var k = r * (0.74 + rng.next() * 0.52);
      var x = d[0] * k, y = d[1] * k * 0.7, z = d[2] * k;
      var y2 = y * cx - z * sx, z2 = y * sx + z * cx;
      return [c[0] + x * cy + z2 * sy, c[1] + y2, c[2] - x * sy + z2 * cy];
    });
    var F = [];
    for (var g = 0; g < 4; g++) {
      var g2 = (g + 1) % 4;
      F.push([0, 2 + g2, 2 + g], [1, 2 + g, 2 + g2]);
    }
    var self = this;
    var o = q.o;
    var jit = 0.9 + rng.next() * 0.2;
    F.forEach(function (f) {
      var a = P[f[0]], b = P[f[1]], d = P[f[2]];
      var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
      var vx = d[0] - a[0], vy = d[1] - a[1], vz = d[2] - a[2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var L = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
      nx /= L; ny /= L; nz /= L;
      self.p.push(a[0], a[1], a[2], b[0], b[1], b[2], d[0], d[1], d[2]);
      [a, b, d].forEach(function (v) {
        var x = v[0] - o[0], y = (v[1] - o[1]) * 1.3, z = v[2] - o[2];
        var R = Math.sqrt(x * x + y * y + z * z) || 1;
        var mx = x / R * 0.72 + nx * 0.28, my = y / R * 0.72 + ny * 0.28, mz = z / R * 0.72 + nz * 0.28;
        var M = Math.sqrt(mx * mx + my * my + mz * mz) || 1;
        self.n.push(mx / M, my / M, mz / M);
        var h = Math.max(0, Math.min(1, (v[1] - o[1] + q.ry) / (2 * q.ry)));
        var out = Math.max(0, Math.min(1, R / q.rm));
        var t = Math.max(0, Math.min(1, h * 0.55 + out * out * 0.45)) * jit;
        self.c.push(q.bottom[0] + (q.top[0] - q.bottom[0]) * t, q.bottom[1] + (q.top[1] - q.bottom[1]) * t, q.bottom[2] + (q.top[2] - q.bottom[2]) * t);
      });
    });
  };

  /**
   * A crown: tufts spread over an ellipsoid, so the outline is broken and no one polygon is large. A core fills it from inside.
   * @param {number[]} o Centre.
   * @param {number[]} r Radii, x, y, z.
   * @param {number} n Tufts.
   * @param {number} size Tuft radius.
   * @param {string} top Colour high in the crown.
   * @param {string} bottom Colour low in the crown.
   * @param {number} seed Stream seed.
   * @param {string} core Colour of the mass inside. It shows between tufts, so it is a green, not a hole.
   */
  Mesher.prototype.crown = function (o, r, n, size, top, bottom, seed, core) {
    var rng = TLV.rng.create(seed);
    var q = { o: o, ry: r[1] + size * 0.6, rm: Math.max(r[0], r[2]) + size * 0.8, top: hexRGB(top), bottom: hexRGB(bottom) };
    this.blob(o[0], o[1], o[2], r[0] * 0.8, r[1] * 0.8, r[2] * 0.8, core, bottom, seed + 1);
    for (var i = 0; i < n; i++) {
      var y = 1 - (i + 0.5) / n * 1.75;
      var rad = Math.sqrt(Math.max(0, 1 - y * y));
      var a = i * 2.39996 + rng.next() * 0.7;
      var k = 0.8 + rng.next() * 0.34;
      var c = [o[0] + Math.cos(a) * rad * r[0] * k, o[1] + y * r[1] * k, o[2] + Math.sin(a) * rad * r[2] * k];
      this.tuft(c, size * (0.72 + rng.next() * 0.56), q, rng);
    }
  };

  Mesher.prototype.geometry = function () {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.p), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.n), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.c), 3));
    return g;
  };

  /** Tufts in a near crown. */
  var T_NEAR = 44;

  /** Procedural meshes, the fallback of every mesh item. */
  var PROC = {
    ficus: function (m) {
      m.trunk(0.26, 0.09, 5.8, 6, '#83705c', '#6e5f4f');
      m.crown([0, 6.1, 0], [3.1, 1.9, 3.1], T_NEAR, 0.66, '#8ab259', '#3f6a32', 3, '#5c8a3e');
    },
    ficus_far: function (m) {
      m.trunk(0.26, 0.1, 5.2, 4, '#83705c', '#6e5f4f');
      m.crown([0, 6.1, 0], [3.0, 1.8, 3.0], 10, 1.25, '#83aa53', '#3f6a32', 5, '#5c8a3e');
    },
    ficus_cast: function (m) {
      PROC.ficus_far(m);
    },
    ficus_lump: function (m) {
      m.trunk(0.26, 0.1, 4.6, 3, '#83705c', '#6e5f4f');
      m.blob(0, 6.1, 0, 3.4, 2.2, 3.4, '#7fa650', '#3b6130', 7);
    },
    other: function (m) {
      m.trunk(0.2, 0.08, 3.8, 5, '#75644f', '#665744');
      m.crown([0, 4.4, 0], [2.3, 2.1, 2.3], 16, 0.68, '#9db35f', '#4a6a36', 13, '#6f9147');
    },
    palm: function (m) {
      m.cyl(0, 0, 0.26, 0.16, 0, 8.4, 6, '#8d7a60', '#7c6a52');
      var green = hexRGB('#5f8f3f');
      var dark = hexRGB('#3f6a30');
      for (var i = 0; i < 9; i++) {
        var a = i / 9 * 6.2832 + (i & 1) * 0.2;
        var cx = Math.cos(a), cz = Math.sin(a);
        var L = 3.4 + (i % 3) * 0.3;
        var w = 0.62;
        var y0 = 8.4;
        var p0 = [0, y0, 0];
        var p1 = [cx * L * 0.5 - cz * w, y0 + 0.8, cz * L * 0.5 + cx * w];
        var p2 = [cx * L * 0.5 + cz * w, y0 + 0.8, cz * L * 0.5 - cx * w];
        var p3 = [cx * L, y0 - 1.1 - (i % 2) * 0.5, cz * L];
        m.tri(p0, p1, p2, i & 1 ? green : dark);
        m.tri(p1, p3, p2, i & 1 ? dark : green);
        m.tri(p0, p2, p1, dark);
        m.tri(p1, p2, p3, dark);
      }
    },
    lamp: function (m) {
      m.cyl(0, 0, 0.09, 0.05, 0, 7.6, 5, '#5e6468');
      m.box(-0.04, 7.5, -0.04, 1.5, 7.6, 0.04, '#5e6468', 'Xx');
      m.box(1.2, 7.4, -0.14, 1.75, 7.52, 0.14, '#e8e4d6');
    },
    balcony: function (m) {
      var c = '#f3efe6';
      var rail = '#54585c';
      m.box(0, -0.16, -1.25, 1.05, 0, 1.25, '#ece7dc', 'X');
      m.box(1.0, 0, -1.25, 1.05, 0.62, 1.25, c, 'XYzZ');
      m.box(0, 0, 1.2, 1.0, 0.62, 1.25, c, 'XxYZ');
      m.box(0, 0, -1.25, 1.0, 0.62, -1.2, c, 'XxYz');
      m.box(0.98, 0.98, -1.25, 1.05, 1.04, 1.25, rail, 'XYzZ');
      m.box(0, 0.98, 1.2, 1.0, 1.04, 1.25, rail, 'XxYZ');
      m.box(0, 0.98, -1.25, 1.0, 1.04, -1.2, rail, 'XxYz');
      m.box(1.0, 0.62, -0.02, 1.03, 0.98, 0.02, rail, 'XYyzZ');
    },
    balcony_round: function (m) {
      var seg = 6;
      var c = hexRGB('#f6f2e9');
      var u = hexRGB('#d9d3c6');
      for (var i = 0; i < seg; i++) {
        var a = (i / seg - 0.5) * 3.1416, b = ((i + 1) / seg - 0.5) * 3.1416;
        var ax = Math.cos(a) * 1.25, az = Math.sin(a) * 1.5, bx = Math.cos(b) * 1.25, bz = Math.sin(b) * 1.5;
        m.quad([bx, 0, bz], [ax, 0, az], [ax, 1.0, az], [bx, 1.0, bz], c);
        m.quad([bx, -0.2, bz], [ax, -0.2, az], [ax, 0, az], [bx, 0, bz], u);
        m.quad([bx, 1.0, bz], [ax, 1.0, az], [ax * 0.95, 1.0, az * 0.95], [bx * 0.95, 1.0, bz * 0.95], c);
        m.tri([0, -0.2, 0], [ax, -0.2, az], [bx, -0.2, bz], u);
      }
    },
    ac: function (m) {
      m.box(0, -0.3, -0.42, 0.36, 0.3, 0.42, '#dcdcd6', 'X');
      m.box(0.361, -0.24, -0.34, 0.37, 0.24, 0.34, '#3e4246', 'Xyzz');
    },
    boiler: function (m) {
      // Tank above, tilted collector below, the way every roof here has them. Faces +X toward the sun.
      var w = 0.95;
      m.box(-0.62, 0, -0.08, -0.46, 1.22, 0.08, '#8d8f8e', 'Y');
      var gl = hexRGB('#23457a');
      var fr = hexRGB('#c9ccc9');
      m.quad([0.86, 0.22, w], [0.86, 0.22, -w], [-0.5, 1.15, -w], [-0.5, 1.15, w], gl);
      m.quad([-0.5, 1.15, w], [-0.5, 1.15, -w], [0.86, 0.22, -w], [0.86, 0.22, w], fr);
      var seg = 5;
      var tk = hexRGB('#f0efea');
      var tk2 = hexRGB('#d4d3cd');
      var x = -0.72, y = 1.46, r = 0.33;
      for (var i = 0; i < seg; i++) {
        var a = i / seg * 6.2832, b = (i + 1) / seg * 6.2832;
        var ax = x + Math.cos(a) * r, ay = y + Math.sin(a) * r, bx = x + Math.cos(b) * r, by = y + Math.sin(b) * r;
        m.quad([ax, ay, -w], [bx, by, -w], [bx, by, w], [ax, ay, w], i < 3 ? tk : tk2);
      }
    },
    tank: function (m) {
      m.box(-0.6, 0, -0.6, 0.6, 0.5, 0.6, '#9a9a94', 'Y');
      m.cyl(0, 0, 0.72, 0.72, 0.5, 1.9, 8, '#7a7f83', '#6c7175');
      m.cyl(0, 0, 0.72, 0.1, 1.9, 2.15, 8, '#878c90');
    },
    awning: function (m) {
      var w = 1.2;
      var c = ['#ffffff', '#c9c4bc'];
      var n = 6;
      for (var i = 0; i < n; i++) {
        var z0 = -w + 2 * w * i / n, z1 = -w + 2 * w * (i + 1) / n;
        var col = hexRGB(c[i & 1]);
        m.quad([0, 0.55, z0], [0, 0.55, z1], [1.15, 0, z1], [1.15, 0, z0], col);
        m.quad([1.15, 0, z0], [1.15, 0, z1], [1.15, -0.22, z1], [1.15, -0.22, z0], col);
      }
    },
    parked: function (m) {
      var b = '#ffffff';
      var g = '#20262c';
      // Body and cabin are drawn pale, so the instance colour is the paint. Nose and tail are chamfered.
      m.box(-2.1, 0.3, -0.84, 2.1, 0.62, 0.84, b, 'Y');
      m.box(-2.0, 0.62, -0.82, 1.55, 0.8, 0.82, b, 'Yx');
      var bq = hexRGB('#f0f0f0');
      m.quad([1.55, 0.62, 0.82], [2.1, 0.62, 0.84], [2.1, 0.62, -0.84], [1.55, 0.62, -0.82], bq);
      m.quad([1.55, 0.8, 0.82], [2.1, 0.62, 0.84], [2.1, 0.62, -0.84], [1.55, 0.8, -0.82], bq);
      var q = function (x, y, z) { return [x, y, z]; };
      var side = hexRGB('#3f4b57');
      var tp = hexRGB('#ffffff');
      m.quad(q(-1.5, 0.82, 0.8), q(1.05, 0.82, 0.8), q(0.45, 1.34, 0.68), q(-1.25, 1.34, 0.68), side);
      m.quad(q(1.05, 0.82, -0.8), q(-1.5, 0.82, -0.8), q(-1.25, 1.34, -0.68), q(0.45, 1.34, -0.68), side);
      m.quad(q(1.05, 0.82, 0.8), q(1.05, 0.82, -0.8), q(0.45, 1.34, -0.68), q(0.45, 1.34, 0.68), side);
      m.quad(q(-1.5, 0.82, -0.8), q(-1.5, 0.82, 0.8), q(-1.25, 1.34, 0.68), q(-1.25, 1.34, -0.68), side);
      m.quad(q(-1.25, 1.34, 0.68), q(0.45, 1.34, 0.68), q(0.45, 1.34, -0.68), q(-1.25, 1.34, -0.68), tp);
      m.box(-1.55, 0, -0.85, -0.95, 0.4, -0.62, g, 'Yyz');
      m.box(0.95, 0, -0.85, 1.55, 0.4, -0.62, g, 'Yyz');
      m.box(-1.55, 0, 0.62, -0.95, 0.4, 0.85, g, 'YyZ');
      m.box(0.95, 0, 0.62, 1.55, 0.4, 0.85, g, 'YyZ');
    },
    parked_far: function (m) {
      m.box(-2.1, 0.12, -0.86, 2.1, 0.8, 0.86, '#ffffff', 'Y');
      m.box(-1.45, 0.8, -0.72, 0.6, 1.34, 0.72, '#8d95a0', 'Y');
    },
    moto: function (m) {
      m.box(-0.9, 0.28, -0.1, 0.9, 0.7, 0.1, '#d8d8d8', 'Y');
      m.box(-0.5, 0.72, -0.14, 0.2, 0.86, 0.14, '#222428', 'Y');
      m.cyl(-0.72, 0, 0.3, 0.3, 0, 0.1, 6, '#1d1f22');
      m.cyl(0.72, 0, 0.3, 0.3, 0, 0.1, 6, '#1d1f22');
    },
    barrier: function (m) {
      for (var i = 0; i < 4; i++) {
        var z0 = -1.3 + i * 0.65;
        m.box(-0.05, 0.72, z0, 0.05, 1.02, z0 + 0.65, i & 1 ? '#c6281f' : '#f2efe6');
      }
      m.box(-0.28, 0, -1.2, 0.28, 0.08, -1.05, '#59595a');
      m.box(-0.28, 0, 1.05, 0.28, 0.08, 1.2, '#59595a');
      m.box(-0.04, 0, -1.16, 0.04, 1.02, -1.08, '#59595a');
      m.box(-0.04, 0, 1.08, 0.04, 1.02, 1.16, '#59595a');
    },
    kiosk: function (m) {
      // Faces +X. The Rothschild kind: a small round hut with a striped roof and a serving hatch.
      m.cyl(0, 0, 1.2, 1.2, 0, 0.95, 8, '#d9cdb6', '#cfc2a9');
      m.cyl(0, 0, 1.26, 1.26, 0.95, 1.05, 8, '#6b4a30');
      m.cyl(0, 0, 1.15, 1.15, 1.05, 2.05, 8, '#3d4a4e', '#566468');
      m.cyl(0, 0, 1.26, 1.26, 2.05, 2.3, 8, '#efe9dc');
      m.cyl(0, 0, 2.05, 0.18, 2.3, 3.05, 8, '#b5362c', '#f2ecdf');
      m.cyl(0, 0, 0.1, 0.1, 3.05, 3.4, 4, '#6b4a30');
      m.box(1.5, 0, 1.3, 2.1, 0.74, 1.9, '#7a5a3c', 'Y');
      m.box(1.5, 0, -1.9, 2.1, 0.74, -1.3, '#7a5a3c', 'Y');
    },
    bench: function (m) {
      // The sitter faces +X.
      var wood = '#7a5637';
      m.box(-0.22, 0.42, -0.9, 0.22, 0.48, 0.9, wood, 'Y');
      m.box(-0.26, 0.5, -0.9, -0.2, 0.86, 0.9, wood, '');
      m.box(-0.2, 0, -0.84, 0.2, 0.42, -0.76, '#3c4044', 'Yy');
      m.box(-0.2, 0, 0.76, 0.2, 0.42, 0.84, '#3c4044', 'Yy');
    },
    // Street clutter. All of it faces +X, out from the wall it stands at. Drawn as one batch, so triangles are the only cost.
    cafe_set: function (m) {
      m.box(-0.36, 0.72, -0.36, 0.36, 0.75, 0.36, '#ece6d8', 'Y');
      m.cyl(0, 0, 0.05, 0.05, 0, 0.72, 3, '#3a3d40');
      for (var side = -1; side <= 1; side += 2) {
        var z = side * 0.66;
        m.box(-0.2, 0.44, z - 0.2, 0.2, 0.47, z + 0.2, '#6b4429', 'Y');
        m.box(-0.2, 0.47, z + side * 0.17 - 0.02, 0.2, 0.86, z + side * 0.17 + 0.02, '#5a3a24', 'YyXx');
        m.cyl(0, z, 0.04, 0.04, 0, 0.44, 3, '#3a3d40');
      }
    },
    cafe_shade: function (m) {
      m.cyl(0, 0, 0.03, 0.03, 0.75, 2.3, 3, '#6e6a62');
      m.cyl(0, 0, 1.25, 0.06, 2.0, 2.45, 6, '#ffffff', '#efe9dc');
      m.cyl(0, 0, 0.06, 1.25, 2.45, 2.0, 6, '#d6d0c2');
    },
    bin: function (m) {
      m.box(-0.3, 0, -0.34, 0.3, 0.94, 0.34, '#ffffff', 'Y');
      m.box(-0.33, 0.94, -0.37, 0.33, 1.0, 0.37, '#d9d9d6', 'Y');
    },
    bike_rack: function (m) {
      // Two hoops and one bicycle chained to them.
      for (var h = -1; h <= 1; h += 2) {
        var z = h * 0.46;
        m.box(-0.03, 0, z - 0.3, 0.03, 0.8, z - 0.26, '#6d7275', 'Y');
        m.box(-0.03, 0, z + 0.26, 0.03, 0.8, z + 0.3, '#6d7275', 'Y');
        m.box(-0.03, 0.8, z - 0.3, 0.03, 0.84, z + 0.3, '#6d7275', 'Y');
      }
      m.wheel(0.12, 0.34, -0.5, 0.32, '#23262a');
      m.wheel(0.12, 0.34, 0.5, 0.32, '#23262a');
      var red = hexRGB('#a7342b');
      m.plate([0.12, 0.34, -0.5], [0.12, 0.8, -0.24], [0.12, 0.8, 0.36], [0.12, 0.34, 0.5], red);
      m.box(0.09, 0.86, -0.32, 0.15, 0.91, -0.14, '#2a2c2e', 'Y');
      m.box(0.0, 0.9, 0.3, 0.24, 0.93, 0.34, '#2a2c2e', 'Y');
    },
    scooter: function (m) {
      // A delivery moped on its stand, long axis on Z. Pale, so the instance colour is the paint.
      m.box(-0.13, 0.26, -0.5, 0.13, 0.6, 0.5, '#ffffff', 'Y');
      m.box(-0.14, 0.6, -0.5, 0.14, 0.72, 0.06, '#26282b', 'Y');
      m.box(-0.2, 0.42, 0.42, 0.2, 1.02, 0.56, '#ffffff', 'Y');
      m.box(-0.26, 1.0, 0.44, 0.26, 1.05, 0.5, '#26282b', 'Y');
      m.box(-0.06, 0, -0.74, 0.06, 0.4, -0.34, '#1d1f22', 'Y');
      m.box(-0.06, 0, 0.42, 0.06, 0.4, 0.8, '#1d1f22', 'Y');
    },
    e_scooter: function (m) {
      m.box(-0.08, 0.09, -0.46, 0.08, 0.14, 0.46, '#2b2d30', 'Y');
      m.cyl(0, 0.42, 0.025, 0.025, 0.12, 1.0, 3, '#d6d3cb');
      m.box(-0.22, 0.98, 0.4, 0.22, 1.02, 0.44, '#2b2d30', 'Y');
    },
    elec_box: function (m) {
      m.box(-0.22, 0, -0.45, 0.22, 1.35, 0.45, '#b9b8ae', 'Y');
      var seam = hexRGB('#8c8b82');
      m.quad([0.222, 0.1, -0.02], [0.222, 0.1, 0.02], [0.222, 1.28, 0.02], [0.222, 1.28, -0.02], seam);
      var note = hexRGB('#e4dccb');
      m.quad([0.223, 0.55, 0.12], [0.223, 0.55, 0.36], [0.223, 0.95, 0.36], [0.223, 0.95, 0.12], note);
    },
    street_sign: function (m) {
      m.cyl(0, 0, 0.035, 0.035, 0, 2.7, 3, '#7e8488');
      var blue = hexRGB('#2a5ea8');
      var white = hexRGB('#f2f1ea');
      // Blue plate, white name panel on both faces, a dark line of lettering nobody can quite read at 40 km/h.
      m.plate([0, 2.34, 0.04], [0, 2.34, 0.92], [0, 2.66, 0.92], [0, 2.66, 0.04], blue);
      m.plate([0.01, 2.39, 0.09], [0.01, 2.39, 0.87], [0.01, 2.61, 0.87], [0.01, 2.61, 0.09], white);
      m.plate([-0.01, 2.39, 0.09], [-0.01, 2.39, 0.87], [-0.01, 2.61, 0.87], [-0.01, 2.61, 0.09], white);
    },
    umbrella: function (m) {
      m.cyl(0, 0, 0.04, 0.04, 0, 2.4, 3, '#d9d3c4');
      m.cyl(0, 0, 1.7, 0.08, 2.0, 2.6, 8, '#ffffff', '#e3ddcf');
      m.cyl(0, 0, 0.08, 1.7, 2.6, 2.0, 8, '#cfc9ba');
    },
    lounger: function (m) {
      m.box(-0.95, 0.16, -0.32, 0.45, 0.22, 0.32, '#f0ebde', 'Y');
      var back = hexRGB('#e6e0d2');
      m.quad([0.45, 0.22, -0.32], [0.45, 0.22, 0.32], [0.98, 0.56, 0.32], [0.98, 0.56, -0.32], back);
      m.quad([0.98, 0.56, -0.32], [0.98, 0.56, 0.32], [0.45, 0.22, 0.32], [0.45, 0.22, -0.32], back);
    },
    shelter: function (m) {
      m.box(-0.2, 2.5, -2.3, 1.35, 2.62, 2.3, '#c9ccc9');
      m.box(-0.1, 0, -2.2, -0.04, 2.5, -2.12, '#5c6266', 'Y');
      m.box(-0.1, 0, 2.12, -0.04, 2.5, 2.2, '#5c6266', 'Y');
      m.box(-0.1, 0.4, -2.1, -0.06, 2.4, 2.1, '#7ba0b0', 'Y');
      m.box(0.1, 0.42, -1.5, 0.5, 0.48, 1.5, '#73563c');
    }
  };

  /**
   * Pool table: mesh, cap, far range, then options. `source` reads another mesh's records, and `min` is a near range,
   * so far trees and cars draw a cheap form and stay out of the shadow pass. `castOnly` draws in the shadow pass alone, and `stripOnly`
   * in the rear strip alone. `castFirst` keeps the instances that cast at the front, so the shadow pass can stop after them.
   */
  function poolSpec() {
    var T = TLV.tune.render;
    var P = T.pools;
    var lod = T.lodM;
    return [
      ['ficus', P.ficus, T.ficusLodM, {}], ['ficus_cast', P.ficus, T.ficusLodM, { source: 'ficus', castOnly: true }],
      ['ficus_far', P.ficus, T.ficusFarM, { source: 'ficus', min: T.ficusLodM }],
      ['ficus_lump', P.ficus, T.treeM, { source: 'ficus', min: T.ficusFarM }],
      ['other', 256, T.treeM, { cast: true }], ['palm', P.palm, T.treeM, { cast: true }], ['lamp', P.lamp, T.lampM, {}],
      ['balcony', P.balcony, T.l0M, {}], ['balcony_round', P.balcony / 2, T.l0M, {}], ['ac', P.ac, T.l0M, {}],
      ['boiler', P.boiler, T.roofM, {}], ['tank', P.tank, T.roofM, {}], ['awning', P.awning, T.l0M, {}],
      ['barrier', P.barrier, T.barrierM, {}], ['shelter', P.shelter, T.l0M, {}],
      ['kiosk', P.kiosk, T.treeM, { cast: true }], ['bench', P.bench, T.l0M, {}],
      ['umbrella', P.umbrella, T.clutter.beachM, {}], ['lounger', P.lounger, T.clutter.beachM, {}],
      ['parked', P.parked, lod, { cast: true, castFirst: true }], ['parked_far', P.parked, T.parkedM, { min: lod }],
      ['parked_rear', P.parkedRear, T.rearCarM, { stripOnly: true }]
    ];
  }

  /** @returns {object} Geometry for a mesh ID: the procedural form, or an empty box when the ID is unknown. */
  function procGeometry(id) {
    var fn = PROC[id];
    var m = new Mesher();
    if (fn) fn(m);
    else m.box(-0.5, 0, -0.5, 0.5, 1, 0.5, '#d0d0d0');
    return m.geometry();
  }

  /** Instance colour from a packed 0xRRGGBB, or white for -1. */
  function setColour(arr, o, tint) {
    if (tint < 0) {
      arr[o] = arr[o + 1] = arr[o + 2] = 1;
      return;
    }
    arr[o] = srgb[(tint >> 16) & 255];
    arr[o + 1] = srgb[(tint >> 8) & 255];
    arr[o + 2] = srgb[tint & 255];
  }

  function makePool(spec) {
    var id = spec[0];
    var def = TLV.render.styles.meshDef(id);
    var cap = Math.floor(def && def.max ? Math.min(def.max, spec[1]) : spec[1]);
    var inst = new THREE.InstancedMesh(procGeometry(id), material, cap);
    inst.count = 0;
    inst.frustumCulled = false;
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    inst.instanceColor.setUsage(THREE.DynamicDrawUsage);
    var opt = spec[3];
    inst.castShadow = !!(opt.cast || opt.castOnly);
    inst.receiveShadow = true;
    inst.matrixAutoUpdate = false;
    inst.visible = !opt.stripOnly;
    var pool = {
      id: id, source: opt.source || id, cap: cap, range: spec[2], min: opt.min || 0, inst: inst, castOnly: !!opt.castOnly, stripOnly: !!opt.stripOnly,
      drawN: 0, castN: 0
    };
    // Three reads count per draw, so a pool can show the shadow map fewer instances than the main view, or only them.
    if (opt.castOnly || opt.castFirst) {
      inst.onBeforeShadow = function () { inst.count = pool.castN; };
      inst.onAfterShadow = function () { inst.count = pool.drawN; };
    }
    pools.push(pool);
    byId[id] = pool;
    sceneRef.add(inst);
  }

  /**
   * Creates the pools.
   * @param {object} scene THREE.Scene.
   * @param {object} W World.
   */
  details.init = function (scene, W) {
    sceneRef = scene;
    world = W;
    for (var i = 0; i < 256; i++) {
      var v = i / 255;
      srgb[i] = v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    }
    material = new THREE.MeshLambertMaterial({ vertexColors: true });
    material.onBeforeCompile = function (shader) {
      TLV.render.sky.patch(shader);
      // Leaf grain: anything green gets a fine dappled break-up, which reads as foliage on a small polygon count.
      shader.fragmentShader = [
        'float dh(vec2 p) { p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }',
        'float dn(vec2 p) { vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);',
        '  return mix(mix(dh(i), dh(i + vec2(1, 0)), f.x), mix(dh(i + vec2(0, 1)), dh(i + vec2(1, 1)), f.x), f.y); }'
      ].join('\n') + '\n' + shader.fragmentShader.replace('#include <color_fragment>', [
        '#include <color_fragment>',
        'if (diffuseColor.g > diffuseColor.r * 1.1 && diffuseColor.g > diffuseColor.b * 1.2) {',
        // A crown thins out near the lens, by screen door, so no leaf ever slices across the view.
        '  float lens = distance(vWP, cameraPosition);',
        '  if (lens < ' + (TLV.tune.render.canopyFadeFarM).toFixed(1) + ') {',
        '    float keep = smoothstep(' + (TLV.tune.render.canopyFadeNearM).toFixed(1) + ', ' + (TLV.tune.render.canopyFadeFarM).toFixed(1) + ', lens);',
        '    if (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) >= keep) discard;',
        '  }',
        '  vec2 la = vWP.xz + vWP.y * vec2(0.83, -0.61), lb = vWP.xz + vWP.y * vec2(-0.71, 0.97);',
        '  float lf = dn(la * 2.1) * 0.34 + dn(lb * 2.7 + 3.1) * 0.33 + dn(la.yx * 5.3 + lb * 2.9) * 0.33;',
        '  diffuseColor.rgb *= 0.62 + 0.8 * lf;',
        '}'
      ].join('\n'));
    };
    material.customProgramCacheKey = function () { return 'tlv-detail'; };
    pools = [];
    byId = Object.create(null);
    cursor = 0;
    poolSpec().forEach(makePool);
    makeBatch(scene);
    motoMesh = byId.parked ? new THREE.InstancedMesh(procGeometry('moto'), material, 32) : null;
    if (motoMesh) {
      motoMesh.count = 0;
      motoMesh.frustumCulled = false;
      motoMesh.matrixAutoUpdate = false;
      scene.add(motoMesh);
    }
  };

  /**
   * Creates the clutter batch. Six kinds of thing on the street would be six pools and six draw calls; written into one buffer
   * near the focus they are one draw call, whatever the mix, and the only cost that grows is triangles.
   */
  function makeBatch(scene) {
    var C = TLV.tune.render.clutter;
    var cap = C.capVerts;
    var g = new THREE.BufferGeometry();
    var pos = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    var nrm = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    var col = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    nrm.setUsage(THREE.DynamicDrawUsage);
    col.setUsage(THREE.DynamicDrawUsage);
    g.setAttribute('position', pos);
    g.setAttribute('normal', nrm);
    g.setAttribute('color', col);
    g.setDrawRange(0, 0);
    var mesh = new THREE.Mesh(g, material);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = true;
    scene.add(mesh);
    var forms = CLUTTER_MESHES.map(function (id) {
      var m = new Mesher();
      PROC[id](m);
      return { id: id, p: m.p, n: m.n, c: m.c, h: C.height[id], r: C.radius[id] };
    });
    batch = {
      mesh: mesh, pos: pos.array, nrm: nrm.array, col: col.array, geo: g, forms: forms, nv: 0, x: Infinity, y: Infinity, seen: -1,
      shX: 0, shY: 0,
      shadow: [srgb[(C.shadow >> 16) & 255], srgb[(C.shadow >> 8) & 255], srgb[C.shadow & 255]]
    };
  }

  /** Adds a clutter record. @param {string} mesh One of CLUTTER_MESHES. */
  details.addClutter = function (chunk, mesh, x, y, yaw, tint) {
    var list = chunk.det.clutter || (chunk.det.clutter = []);
    list.push(x, y, yaw, CLUTTER_MESHES.indexOf(mesh), tint);
  };

  var at3 = { x: 0, y: 0, z: 0 };

  /** A soft dark shape on the ground, away from the sun: a thing stands on the paving, not above it. */
  function batchShadow(B, x, y, r, h) {
    var C = TLV.render.coords;
    var len = Math.min(2.2, h);
    var tx = B.shX * len, ty = B.shY * len;
    var L = Math.sqrt(tx * tx + ty * ty) || 1;
    var nx = -ty / L * r, ny = tx / L * r;
    // Two triangles from the foot of the thing to the end of its shadow, wound to face up in the view of coords.write.
    var quad = [[x - nx, y - ny], [x + nx, y + ny], [x + nx * 0.7 + tx, y + ny * 0.7 + ty], [x - nx * 0.7 + tx, y - ny * 0.7 + ty]];
    var o = [0, 2, 1, 0, 3, 2];
    for (var i = 0; i < 6; i++) {
      var v = B.nv * 3;
      var q = quad[o[i]];
      C.write(B.pos, v, q[0], q[1], 0.02);
      B.nrm[v] = 0; B.nrm[v + 1] = 1; B.nrm[v + 2] = 0;
      B.col[v] = B.shadow[0]; B.col[v + 1] = B.shadow[1]; B.col[v + 2] = B.shadow[2];
      B.nv++;
    }
  }

  /** Rewrites the batch around the focus. */
  function refreshBatch(chunks, fx, fy, force) {
    var B = batch;
    if (!B) return;
    var C = TLV.tune.render.clutter;
    var mx = fx - B.x, my = fy - B.y;
    if (!force && B.seen === chunks.length && mx * mx + my * my < C.moveM * C.moveM) return;
    B.x = fx;
    B.y = fy;
    B.seen = chunks.length;
    B.nv = 0;
    var sun = TLV.render.sky.toSun;
    var slope = 1 / Math.max(0.05, sun.z);          // Metres of shadow per metre of height, over the horizontal unit
    B.shX = -sun.x * slope;
    B.shY = -sun.y * slope;
    var R2 = C.rangeM * C.rangeM;
    var coords = TLV.render.coords;
    for (var i = 0; i < chunks.length; i++) {
      var ch = chunks[i];
      var rec = ch.det.clutter;
      if (!rec) continue;
      // A record can stand a little past its chunk: it is filed by its building. The chunk test keeps that much in hand.
      var dx = Math.max(0, (fx < ch.x0 ? ch.x0 - fx : fx > ch.x1 ? fx - ch.x1 : 0) - C.overhangM);
      var dy = Math.max(0, (fy < ch.y0 ? ch.y0 - fy : fy > ch.y1 ? fy - ch.y1 : 0) - C.overhangM);
      if (dx * dx + dy * dy > R2) continue;
      for (var k = 0; k + 4 < rec.length; k += 5) {
        var x = rec[k], y = rec[k + 1];
        var ex = x - fx, ey = y - fy;
        if (ex * ex + ey * ey > R2) continue;
        var form = B.forms[rec[k + 3]];
        var count = form.p.length / 3;
        if (B.nv + count + 6 > C.capVerts) continue;
        var yaw = rec[k + 2], tint = rec[k + 4];
        var c = Math.cos(yaw), s = Math.sin(yaw);
        var tr = tint < 0 ? 1 : srgb[(tint >> 16) & 255], tg = tint < 0 ? 1 : srgb[(tint >> 8) & 255], tb = tint < 0 ? 1 : srgb[tint & 255];
        coords.write(B.pos, B.nv * 3, x, y, 0);
        var ox = B.pos[B.nv * 3], oy = B.pos[B.nv * 3 + 1], oz = B.pos[B.nv * 3 + 2];
        if (form.h > 0) {
          batchShadow(B, x, y, form.r * 0.8, form.h);
        }
        var v = B.nv * 3;
        var P = form.p, N = form.n, K = form.c;
        for (var j = 0; j < P.length; j += 3) {
          var px = P[j], pz = P[j + 2], qx = N[j], qz = N[j + 2];
          B.pos[v] = ox + px * c + pz * s;
          B.pos[v + 1] = oy + P[j + 1];
          B.pos[v + 2] = oz - px * s + pz * c;
          B.nrm[v] = qx * c + qz * s;
          B.nrm[v + 1] = N[j + 1];
          B.nrm[v + 2] = -qx * s + qz * c;
          B.col[v] = K[j] * tr;
          B.col[v + 1] = K[j + 1] * tg;
          B.col[v + 2] = K[j + 2] * tb;
          v += 3;
        }
        B.nv = v / 3;
      }
    }
    B.geo.setDrawRange(0, B.nv);
    var a = B.geo.attributes;
    a.position.needsUpdate = a.normal.needsUpdate = a.color.needsUpdate = true;
  }

  /** Adds a record to a chunk. Numbers go to a plain list; chunks freeze it into a Float32Array. */
  details.add = function (chunk, mesh, x, y, z, yaw, scale, tint) {
    if (!byId[mesh]) {
      TLV.registry.problem('kit', mesh, 'no pool for this mesh');
      return;
    }
    var list = chunk.det[mesh] || (chunk.det[mesh] = []);
    list.push(x, y, z, yaw, scale, tint);
  };

  /** Records per instance. */
  var STRIDE = 6;

  /** Writes a yaw-and-scale matrix. Column major; rotation.y = yaw (section 1.4). */
  function writeMatrix(a, o, x, y, z, yaw, s) {
    var c = Math.cos(yaw) * s, n = Math.sin(yaw) * s;
    a[o] = c; a[o + 1] = 0; a[o + 2] = -n; a[o + 3] = 0;
    a[o + 4] = 0; a[o + 5] = s; a[o + 6] = 0; a[o + 7] = 0;
    a[o + 8] = n; a[o + 9] = 0; a[o + 10] = c; a[o + 11] = 0;
    TLV.render.coords.write(a, o + 12, x, y, z);
    a[o + 15] = 1;
  }

  /** Candidate scratch: squared distance, chunk index, record index. */
  var candD = new Float32Array(32768);
  var candC = new Int32Array(32768);
  var candI = new Int32Array(32768);
  var hist = new Int32Array(64);

  /** Refreshes one pool from chunk records, nearest first when over cap. */
  function refreshPool(pool, chunks, fx, fy) {
    var R = pool.range;
    var R2 = R * R;
    var min2 = pool.min * pool.min;
    var n = 0;
    var i, k;
    for (i = 0; i < chunks.length; i++) {
      var ch = chunks[i];
      var dx = fx < ch.x0 ? ch.x0 - fx : fx > ch.x1 ? fx - ch.x1 : 0;
      var dy = fy < ch.y0 ? ch.y0 - fy : fy > ch.y1 ? fy - ch.y1 : 0;
      if (dx * dx + dy * dy > R2) continue;
      var rec = ch.det[pool.source];
      if (!rec) continue;
      var count = rec.length / STRIDE;
      for (k = 0; k < count; k++) {
        var ex = rec[k * STRIDE] - fx;
        var ey = rec[k * STRIDE + 1] - fy;
        var d2 = ex * ex + ey * ey;
        if (d2 > R2 || d2 < min2) continue;
        if (n >= candD.length) break;
        candD[n] = d2;
        candC[n] = i;
        candI[n] = k;
        n++;
      }
    }
    var limit = R2;
    if (n > pool.cap) {
      // The pool drops the farthest first. A histogram finds the cut-off without sorting.
      hist.fill(0);
      var scale = hist.length / R2;
      for (i = 0; i < n; i++) hist[Math.min(hist.length - 1, (candD[i] * scale) | 0)]++;
      var run = 0;
      var b = 0;
      for (; b < hist.length; b++) {
        if (run + hist[b] > pool.cap) break;
        run += hist[b];
      }
      limit = b / scale;
    }
    var mat = pool.inst.instanceMatrix.array;
    var col = pool.inst.instanceColor.array;
    var w = 0;
    for (i = 0; i < n && w < pool.cap; i++) {
      if (candD[i] > limit) continue;
      var r = chunks[candC[i]].det[pool.source];
      var o = candI[i] * STRIDE;
      writeMatrix(mat, w * 16, r[o], r[o + 1], r[o + 2], r[o + 3], r[o + 4]);
      setColour(col, w * 3, r[o + 5]);
      w++;
    }
    pool.castN = w;
    pool.drawN = pool.castOnly ? 0 : w;
    pool.inst.count = pool.drawN;
    pool.inst.instanceMatrix.needsUpdate = true;
    pool.inst.instanceColor.needsUpdate = true;
  }

  /**
   * Borrows the live cars' bodies, once they exist, for parked cars close to the camera. Same geometry, same material, with
   * instance data of their own: an InstancedMesh's lamps and fade are per instance, so they cannot share the live arrays.
   * vehicles.js exposes no accessor, so the bodies are found in the scene and told apart by triangle count.
   */
  function adoptShells() {
    if (shellPools || !sceneRef || !TLV.render.vehicles || !TLV.render.vehicles._counts) return;
    var live = sceneRef.children.filter(function (o) { return o.isInstancedMesh && o.geometry.attributes.iLamp && o.geometry.attributes.aPiv; });
    if (!live.length) return;
    var per = TLV.render.vehicles._counts().perBody;
    var cap = TLV.tune.render.parkedBodyCap;
    var made = {};
    for (var i = 0; i < SHELL_KINDS.length; i++) {
      var kind = SHELL_KINDS[i];
      var src = live.filter(function (o) { return o.geometry.attributes.position.count / 3 === per[kind]; })[0];
      if (!src) return;
      var g = new THREE.BufferGeometry();
      ['position', 'normal', 'color', 'aMat', 'aPiv'].forEach(function (a) {
        if (src.geometry.attributes[a]) g.setAttribute(a, src.geometry.attributes[a]);
      });
      if (src.geometry.index) g.setIndex(src.geometry.index);
      var fx = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      for (var k = 0; k < cap; k++) fx.setXYZW(k, 1, 1, 0, 0);       // Solid, wheels straight
      g.setAttribute('iFx', fx);
      g.setAttribute('iLamp', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
      g.setAttribute('iDent', new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4));
      var inst = new THREE.InstancedMesh(g, src.material, cap);
      inst.count = 0;
      inst.frustumCulled = false;
      inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      inst.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
      inst.instanceColor.setUsage(THREE.DynamicDrawUsage);
      inst.castShadow = true;
      inst.matrixAutoUpdate = false;
      sceneRef.add(inst);
      made[kind] = { inst: inst, n: 0 };
    }
    shellPools = made;
  }

  /** Moves one instance to another slot. */
  function moveRecord(inst, from, to) {
    if (from === to) return;
    inst.instanceMatrix.array.copyWithin(to * 16, from * 16, from * 16 + 16);
    inst.instanceColor.array.copyWithin(to * 3, from * 3, from * 3 + 3);
  }

  /** Parked cars are live: a spot changes state as the game stages it. All the pools fill from one query. */
  function refreshParked(S, fx, fy) {
    var W = S.world;
    var near = byId.parked;
    var far = byId.parked_far;
    var strip = byId.parked_rear;
    ids.length = 0;
    var cnt = TLV.world.parking.parkedNear(S, fx, fy, far.range, ids);
    var T = TLV.tune.render;
    var OCC_MOTO = TLV.const.OCC.MOTO;
    var lod2 = near.range * near.range;
    var shell2 = T.parkedBodyM * T.parkedBodyM;
    var cast2 = T.parkedCastM * T.parkedCastM;
    var strip2 = strip.range * strip.range;
    var yaw = TLV.render.rearview && TLV.render.rearview.heading ? TLV.render.rearview.heading(S) : 0;
    var ax = Math.cos(yaw), ay = Math.sin(yaw);
    var nn = 0;
    var nc = 0;
    var nf = 0;
    var nr = 0;
    var mw = 0;
    var kind;
    if (shellPools) for (kind in shellPools) shellPools[kind].n = 0;
    var moto = motoMesh ? motoMesh.instanceMatrix.array : null;
    for (var i = 0; i < cnt; i++) {
      var id = ids[i];
      var occ = TLV.world.parking.state(S, id);
      var box = TLV.world.parking.boxOf(W, id, occ, boxOut);
      var dx = box.x - fx, dy = box.y - fy;
      var d2 = dx * dx + dy * dy;
      if (occ === OCC_MOTO) {
        if (d2 <= 64 && moto && mw < 32) writeMatrix(moto, 16 * mw++, box.x, box.y, 0, box.h, 1);
        continue;
      }
      // A stall's car is the car that pulls out of it: the same body and the same paint at every range.
      var h = TLV.rng.hash32(id);
      var carKind = SHELL_KINDS[h % SHELL_KINDS.length];
      var tint = T.parkedPaint[carKind][h & 7];
      // The rear strip is 256 pixels wide: it draws the cars behind the lens as boxes, in a pool of its own.
      if (d2 < strip2 && dx * ax + dy * ay < T.rearAheadM && nr < strip.cap) {
        writeMatrix(strip.inst.instanceMatrix.array, nr * 16, box.x, box.y, 0, box.h, 1);
        setColour(strip.inst.instanceColor.array, nr * 3, tint);
        nr++;
      }
      if (shellPools && d2 < shell2) {
        var sp = shellPools[carKind];
        if (sp.n < T.parkedBodyCap) {
          writeMatrix(sp.inst.instanceMatrix.array, sp.n * 16, box.x, box.y, 0, box.h, 1);
          setColour(sp.inst.instanceColor.array, sp.n * 3, tint);
          sp.n++;
          continue;
        }
      }
      var pool = d2 < lod2 ? near : far;
      var w = pool === near ? nn : nf;
      if (w >= pool.cap) continue;
      // Cars that cast stay at the front of the pool, so the shadow pass can stop at them.
      var at = w;
      if (pool === near && d2 < cast2) {
        moveRecord(near.inst, nc, w);
        at = nc++;
      }
      writeMatrix(pool.inst.instanceMatrix.array, at * 16, box.x, box.y, 0, box.h, 1);
      setColour(pool.inst.instanceColor.array, at * 3, tint);
      if (pool === near) nn++;
      else nf++;
    }
    near.castN = nc;
    near.drawN = nn;
    near.inst.count = nn;
    far.inst.count = nf;
    strip.inst.count = nr;
    strip.inst.instanceMatrix.needsUpdate = strip.inst.instanceColor.needsUpdate = true;
    if (shellPools) {
      for (kind in shellPools) {
        var sh = shellPools[kind];
        sh.inst.count = sh.n;
        sh.inst.instanceMatrix.needsUpdate = true;
        sh.inst.instanceColor.needsUpdate = true;
      }
    }
    near.inst.instanceMatrix.needsUpdate = near.inst.instanceColor.needsUpdate = true;
    far.inst.instanceMatrix.needsUpdate = far.inst.instanceColor.needsUpdate = true;
    if (motoMesh) {
      motoMesh.count = mw;
      motoMesh.instanceMatrix.needsUpdate = true;
    }
  }

  /**
   * Refreshes a few pools. All of them turn over within a dozen frames.
   * @param {object} S Sim state.
   * @param {object[]} chunks Built chunks.
   * @param {number} fx Focus x.
   * @param {number} fy Focus y.
   * @param {number} [all] Refresh every pool now, for a jump cut.
   */
  details.frame = function (S, chunks, fx, fy, all) {
    var T = TLV.tune.render;
    var steps = all ? pools.length : T.detailPoolsPerFrame;
    adoptMeshes();
    adoptShells();
    for (var i = 0; i < steps; i++) {
      var pool = pools[cursor];
      cursor = (cursor + 1) % pools.length;
      if (pool.id === 'parked') refreshParked(S, fx, fy);
      else if (pool.id !== 'parked_far' && pool.id !== 'parked_rear') refreshPool(pool, chunks, fx, fy);
    }
    refreshBatch(chunks, fx, fy, all);
  };

  /** Swaps in packed meshes as they arrive. The procedural form stands until then, and for good if there is none. */
  function adoptMeshes() {
    var ST = TLV.render.styles;
    var A = TLV.render.assets;
    for (var i = 0; i < pools.length; i++) {
      var pool = pools[i];
      if (pool.packed) continue;
      var def = ST.meshDef(pool.id);
      if (!def || !def.asset) continue;
      if (A.request(def.asset) !== 'ready') continue;
      var geo = TLV.render.meshFormat.geometry(A.mesh(def.asset));
      pool.inst.geometry.dispose();
      pool.inst.geometry = geo;
      pool.ownGeo = geo;
      pool.packed = true;
    }
  }

  /**
   * Hides what a small far-clipped strip cannot show. The rear view draws the same scene; this keeps it cheap.
   * @param {boolean} on True while the strip renders.
   */
  details.rearMode = function (on) {
    for (var i = 0; i < pools.length; i++) {
      var p = pools[i];
      p.inst.visible = on ? p.id === 'ficus' || p.stripOnly : !p.stripOnly;
    }
    if (batch) batch.mesh.visible = !on;
    if (shellPools) for (var k in shellPools) shellPools[k].inst.visible = !on;
    // The strip is too small to read a crown: near trees borrow the far form while it draws.
    var tree = byId.ficus;
    if (tree && byId.ficus_far) {
      if (!tree.ownGeo) tree.ownGeo = tree.inst.geometry;
      tree.inst.geometry = on ? byId.ficus_far.inst.geometry : tree.ownGeo;
    }
  };

  /** @returns {?object} A pool's mesh and pass counts. Test only. */
  details._pool = function (id) {
    var p = byId[id];
    return p ? { inst: p.inst, castN: p.castN, drawN: p.drawN } : null;
  };

  /** @returns {object} Live instance counts by pool, for tests. */
  details.counts = function () {
    var out = {};
    pools.forEach(function (p) { out[p.id] = p.castOnly ? p.castN : p.inst.count; });
    if (shellPools) for (var k in shellPools) out['shell_' + k] = shellPools[k].inst.count;
    if (batch) out.clutterTris = batch.nv / 3;
    return out;
  };

  /** Frees the pools. */
  details.dispose = function () {
    pools.forEach(function (p) {
      sceneRef.remove(p.inst);
      p.inst.geometry.dispose();
      p.inst.dispose();
    });
    if (motoMesh) {
      sceneRef.remove(motoMesh);
      motoMesh.geometry.dispose();
      motoMesh.dispose();
    }
    if (shellPools) {
      Object.keys(shellPools).forEach(function (k) {
        sceneRef.remove(shellPools[k].inst);
        shellPools[k].inst.geometry.dispose();
        shellPools[k].inst.dispose();
      });
    }
    if (batch) {
      sceneRef.remove(batch.mesh);
      batch.geo.dispose();
    }
    if (material) material.dispose();
    pools = [];
    byId = Object.create(null);
    material = motoMesh = sceneRef = world = shellPools = batch = null;
  };
})(window.TLV);
