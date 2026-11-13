// js/render/vehicles.js — WP-RENDER (RENDER-ACTORS)
// Every car on screen: the player's battered hatchback and six instanced traffic bodies. Lamps, doors, dents, spawn fade and the
// tailgater ghost all live in instance data, so a full street stays at one draw call per body (ARCHITECTURE 15.3). Reads only the
// fields of ARCHITECTURE 15.1. Writes nothing to S.
(function (TLV) {
  'use strict';

  var vehicles = TLV.ns('render.vehicles');

  // -- Numbers. Constants for actors stay in the actor file, by the seam with RENDER-CITY. ------------------------------------------
  var Q = {
    capacity: { hatch: 120, sedan: 200, taxi: 60, van: 60, bus: 24, truck: 24 },
    fadeS: 0.4,           // ARCHITECTURE 15.3: a car first drawn inside fadeRangeM fades in over this
    fadeRangeM: 300,
    ghostAlpha: 0.4,      // GAME_DESIGN 18, tailgater trap
    ghostRate: 9,         // per second, toward the ghost level
    ghostClearNearM: 1.2, // a ghost is gone this close to the lens, and whole from ghostClearFarM. A bus roof passes just under the lens, and that
    ghostClearFarM: 5,    // near part is what spread a hatched sheet over half the frame
    blinkHz: 1.7,
    blinkDuty: 0.56,
    beamHz: 1.15,         // the double flash of a tailgater's high beams
    beamRest: 0.4,
    flareRangeM: 160,     // lamps past this have no flare, only the lit quad
    doorRate: 3.6,        // of the swing, per second
    doorOpenRad: 1.45,
    doorLen: 1.0,         // matches the 1.0 m box of ARCHITECTURE 13.1
    wheelR: 0.31,
    remoteAlpha: 0.62,    // GAME_DESIGN 26: another driver's car is see-through, because nothing in this street can touch it
    remoteRate: 10,       // per second, toward where that driver last said they were
    remoteLeadS: 0.5,     // their last speed carries the car on this long between reports
    remoteSnapM: 30,      // further than this from its place, it is put there
    remoteHideM: 3,       // gone inside this of the player, and whole from twice it
    remotePaint: 0xb06cff,
    rollK: 0.0125,        // rad per m/s2 of lateral acceleration
    rollMax: 0.085,
    pitchK: 0.0065,       // rad per m/s2 of braking or launch
    pitchMax: 0.06,
    leanRate: 7,          // per second, body settling toward its lean
    steerRate: 9,
    wreckTilt: 0.05,
    dentRadiusM: 0.8,     // player's car, at full severity
    dentMax: 0.34,        // deepest any point of the player's car may sink
    dentDepth: { scrape: 0.05, bump: 0.13, crash: 0.26 },
    dentSeverity: { scrape: 0.25, bump: 0.55, crash: 1 },
    blobLift: 0.05,
    shadowNearM: 72,      // cars past this cast no shadow. Facades stop taking shadows here too, and every car keeps its blob
    rearNearM: 60,        // the rear view draws cars nearer than this: further back one is 4 pixels wide in the strip
    rearAheadM: 8,        // and no further than this ahead of the lens, which is half a bus
    fullM: 150,           // past this a car is the 40-triangle stand-in
    liteHeight: { hatch: 1.05, sedan: 1, taxi: 1, van: 1.55, bus: 2.08, truck: 2.1 }
  };

  /** Which passes draw a car: the rear view and on, the shadow map and on, or only the main view. */
  var TIER_REAR = 0, TIER_SHADOW = 1, TIER_FAR = 2;

  /** Lamp IDs baked per vertex, read by the shader. */
  var LAMP = { NONE: 0, BRAKE: 1, BLINK_L: 2, BLINK_R: 3, REVERSE: 4, HEAD: 5, SIGN: 6 };

  /** Cars and people draw after the city, so that the door beacon's hidden pass can run between the two. See makeBeacon in effects.js. */
  var ACTOR_ORDER = 1;

  /** A body's mark on the alt channel: drawn always, only on alt instances (sherut), or only on plain ones. */
  var ALT = { ALL: 0, ONLY: 1, NOT: 2 };

  /** The player's paint and his one door from a scrapyard. No other car on the road may come near this teal, so he can be told from a rival at a glance. */
  var PLAYER_PAINT = '#4f9c94';
  var PLAYER_ROOF = '#7fb5ab';    // the same paint after twenty summers
  var PLAYER_DOOR = '#d9cda8';

  /** Paint per kind, by variant 0..7. Teal is the player's alone: tests/render/actors_lint.test.mjs holds these and the parked palette away from it. */
  var PALETTE = {
    hatch: ['#b23a2e', '#2b5a9e', '#d8b13a', '#4b7d4e', '#8a8f96', '#3a3f4a', '#c7632b', '#6a4a8c'],
    sedan: ['#cfd2d4', '#efece4', '#34383f', '#7c2228', '#274a70', '#9fb0ba', '#c9b78e', '#2f5e50'],
    taxi: ['#f4f0e4', '#f4f0e4', '#f4f0e4', '#f2cf3a', '#f2cf3a', '#eae6da', '#f4f0e4', '#f2cf3a'],
    van: ['#efece6', '#d9dcdc', '#2d5f86', '#b5482f', '#566b2f', '#f0a81e', '#f0a81e', '#e8b224'],
    bus: ['#2c7a3c', '#c23b2e', '#2a62a8', '#2c7a3c', '#2a62a8', '#d48a1e', '#2c7a3c', '#c23b2e'],
    truck: ['#c9502f', '#2a5f93', '#e3e0d8', '#566b2f', '#d9a42a', '#5a5f68', '#c9502f', '#2a5f93']
  };

  /** Van variants from this one up are sheruts: a van shell with a window row and a roof sign, by the 6-body limit. */
  var SHERUT_FROM = 5;

  /**
   * Where the lamps sit, by kind, for the meshes and the flares alike, in metres from the body centre. rx is the plane of the rear panel: a lamp stands
   * LAMP_PROUD behind it, and rz, ry and w keep the whole cluster inside that panel, so nothing hangs off a corner. The cluster's outer edge is at rz + w / 2 + 0.1.
   */
  var LAMPS = {
    hatch: { rx: -2.0, ry: 0.815, rz: 0.45, w: 0.3, h: 0.17, fx: 1.97, fy: 0.72, fz: 0.5 },
    sedan: { rx: -2.2, ry: 0.795, rz: 0.46, w: 0.3, h: 0.17, fx: 2.17, fy: 0.72, fz: 0.52 },
    taxi: { rx: -2.2, ry: 0.795, rz: 0.46, w: 0.3, h: 0.17, fx: 2.17, fy: 0.72, fz: 0.52 },
    van: { rx: -2.6, ry: 1.0, rz: 0.68, w: 0.26, h: 0.3, fx: 2.56, fy: 0.84, fz: 0.62 },
    bus: { rx: -6.0, ry: 1.2, rz: 0.95, w: 0.28, h: 0.3, fx: 5.96, fy: 0.82, fz: 0.9 },
    truck: { rx: -3.75, ry: 0.92, rz: 0.9, w: 0.3, h: 0.2, fx: 3.74, fy: 0.84, fz: 0.82 }
  };

  /** How far a lamp stands off the panel behind it. Enough that the two never share a plane, too little to see as a gap. */
  var LAMP_PROUD = 0.03;

  /** How far a flare's glow stands off the rear panel, so that the sprite does not cut into the body. */
  var FLARE_PROUD = 0.08;

  // -- Low-poly geometry. Flat shaded and unindexed, so a face owns its colour and its normal. --------------------------------------

  /**
   * Parses '#rrggbb' to linear RGB. The renderer outputs sRGB, so colours baked into vertices must be linear.
   * @param {string} hex Colour.
   * @returns {number[]} [r, g, b], linear.
   */
  function rgb(hex) {
    var c = new THREE.Color(hex);
    return [c.r, c.g, c.b];
  }

  /**
   * Builds a flat-shaded mesh out of quads, boxes and lofts. Later stages add their own channels through `channels`.
   * @constructor
   * @param {object} channels Name to size, for the per-vertex channels besides position, normal and colour.
   */
  function Geo(channels) {
    this.pos = [];
    this.nor = [];
    this.col = [];
    this.names = Object.keys(channels);
    this.sizes = channels;
    this.data = {};
    this.cur = {};
    for (var i = 0; i < this.names.length; i++) {
      var name = this.names[i];
      this.data[name] = [];
      this.cur[name] = new Array(channels[name]).fill(0);
    }
  }

  /**
   * Sets the current value of channels, which every vertex added from now on takes.
   * @param {object} values Name to array.
   * @returns {Geo} this.
   */
  Geo.prototype.with = function (values) {
    for (var k in values) this.cur[k] = values[k];
    return this;
  };

  /**
   * Adds a triangle. `out` picks the winding: the face points to its side of it.
   * @param {number[]} a Vertex.
   * @param {number[]} b Vertex.
   * @param {number[]} c Vertex.
   * @param {number[]} col Colour, linear.
   * @param {number[]} out Direction the face should look.
   */
  Geo.prototype.tri = function (a, b, c, col, out) {
    var ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    var vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    var len = Math.sqrt(nx * nx + ny * ny + nz * nz);
    if (len < 1e-9) return;
    nx /= len; ny /= len; nz /= len;
    var verts = [a, b, c];
    if (nx * out[0] + ny * out[1] + nz * out[2] < 0) {
      verts = [a, c, b];
      nx = -nx; ny = -ny; nz = -nz;
    }
    for (var i = 0; i < 3; i++) {
      var p = verts[i];
      this.pos.push(p[0], p[1], p[2]);
      this.nor.push(nx, ny, nz);
      this.col.push(col[0], col[1], col[2]);
      for (var j = 0; j < this.names.length; j++) {
        var arr = this.data[this.names[j]];
        var val = this.cur[this.names[j]];
        for (var k = 0; k < val.length; k++) arr.push(val[k]);
      }
    }
  };

  /** Adds a quad a b c d. See tri for `out`. */
  Geo.prototype.quad = function (a, b, c, d, col, out) {
    this.tri(a, b, c, col, out);
    this.tri(a, c, d, col, out);
  };

  /**
   * Adds a box.
   * @param {number} cx Centre.
   * @param {number} cy Centre.
   * @param {number} cz Centre.
   * @param {number} sx Size.
   * @param {number} sy Size.
   * @param {number} sz Size.
   * @param {number[]} col Colour, linear.
   */
  Geo.prototype.box = function (cx, cy, cz, sx, sy, sz, col) {
    var x0 = cx - sx / 2, x1 = cx + sx / 2, y0 = cy - sy / 2, y1 = cy + sy / 2, z0 = cz - sz / 2, z1 = cz + sz / 2;
    this.quad([x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1], col, [1, 0, 0]);
    this.quad([x0, y0, z0], [x0, y1, z0], [x0, y1, z1], [x0, y0, z1], col, [-1, 0, 0]);
    this.quad([x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1], col, [0, 1, 0]);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], col, [0, -1, 0]);
    this.quad([x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1], col, [0, 0, 1]);
    this.quad([x0, y0, z0], [x1, y0, z0], [x1, y1, z0], [x0, y1, z0], col, [0, 0, -1]);
  };

  /**
   * Lofts a body along x through side-view stations, front to rear. A station is [x, yBottom, yTop, halfWidthBottom, halfWidthTop].
   * @param {number[][]} st Stations.
   * @param {number[]} col Colour, linear.
   * @param {?function(number):number[]} [colAt] Optional colour per quad, by index, for two-tone bodies.
   * @returns {object[]} Corner quads per segment, for placing glass: { top, left, right }.
   */
  Geo.prototype.loft = function (st, col, colAt) {
    var quads = [];
    for (var i = 0; i + 1 < st.length; i++) {
      var f = st[i], r = st[i + 1];
      var c = colAt ? colAt(i) : col;
      var top = [[f[0], f[2], -f[4]], [r[0], r[2], -r[4]], [r[0], r[2], r[4]], [f[0], f[2], f[4]]];
      var left = [[f[0], f[1], -f[3]], [r[0], r[1], -r[3]], [r[0], r[2], -r[4]], [f[0], f[2], -f[4]]];
      var right = [[f[0], f[1], f[3]], [r[0], r[1], r[3]], [r[0], r[2], r[4]], [f[0], f[2], f[4]]];
      this.quad(top[0], top[1], top[2], top[3], c, [0.15, 1, 0]);
      this.quad(left[0], left[1], left[2], left[3], c, [0, 0.2, -1]);
      this.quad(right[0], right[1], right[2], right[3], c, [0, 0.2, 1]);
      quads.push({ top: top, left: left, right: right });
    }
    var a = st[0], z = st[st.length - 1];
    this.quad([a[0], a[1], -a[3]], [a[0], a[2], -a[4]], [a[0], a[2], a[4]], [a[0], a[1], a[3]], col, [1, 0, 0]);
    this.quad([z[0], z[1], -z[3]], [z[0], z[2], -z[4]], [z[0], z[2], z[4]], [z[0], z[1], z[3]], col, [-1, 0, 0]);
    return quads;
  };

  /**
   * Lays a smaller panel on a quad, for glass and trim.
   * @param {number[][]} q Quad corners a b c d, where a to b runs along it and b to c across it.
   * @param {number} u0 Start along, 0..1.
   * @param {number} u1 End along.
   * @param {number} v0 Start across.
   * @param {number} v1 End across.
   * @param {number[]} col Colour, linear.
   * @param {number[]} out Direction the panel looks. It stands 12 mm proud that way, so it never fights its parent.
   */
  Geo.prototype.panel = function (q, u0, u1, v0, v1, col, out) {
    function at(u, v) {
      var p = [];
      for (var i = 0; i < 3; i++) {
        var low = q[0][i] + (q[1][i] - q[0][i]) * u;
        var high = q[3][i] + (q[2][i] - q[3][i]) * u;
        p.push(low + (high - low) * v + out[i] * 0.012);
      }
      return p;
    }
    this.quad(at(u0, v0), at(u1, v0), at(u1, v1), at(u0, v1), col, out);
  };

  /**
   * Adds a cylinder along z.
   * @param {number} cx Centre.
   * @param {number} cy Centre.
   * @param {number} cz Centre.
   * @param {number} r Radius.
   * @param {number} w Width along z.
   * @param {number} n Sides.
   * @param {number[]} col Side and cap colour, linear.
   * @param {number[]} [capCol] Cap colour, alternating with `col` per sector so that spin can be seen.
   * @param {number} [capSide] 1 or -1 for only that cap, and no sides: a wheel's hidden faces are not worth the triangles.
   */
  Geo.prototype.cyl = function (cx, cy, cz, r, w, n, col, capCol, capSide) {
    var z0 = cz - w / 2, z1 = cz + w / 2;
    for (var i = 0; i < n; i++) {
      var a0 = i / n * Math.PI * 2, a1 = (i + 1) / n * Math.PI * 2;
      var x0 = cx + Math.cos(a0) * r, y0 = cy + Math.sin(a0) * r, x1 = cx + Math.cos(a1) * r, y1 = cy + Math.sin(a1) * r;
      var mid = (a0 + a1) / 2;
      var cap = capCol && i % 2 ? capCol : col;
      if (capSide) {
        var z = capSide > 0 ? z1 : z0;
        this.tri([cx, cy, z], [x0, y0, z], [x1, y1, z], cap, [0, 0, capSide]);
        continue;
      }
      this.quad([x0, y0, z0], [x1, y1, z0], [x1, y1, z1], [x0, y0, z1], col, [Math.cos(mid), Math.sin(mid), 0]);
      this.tri([cx, cy, z1], [x0, y0, z1], [x1, y1, z1], cap, [0, 0, 1]);
      this.tri([cx, cy, z0], [x0, y0, z0], [x1, y1, z0], cap, [0, 0, -1]);
    }
  };

  /**
   * Finishes the mesh.
   * @returns {THREE.BufferGeometry} Geometry with position, normal, color and the extra channels.
   */
  Geo.prototype.build = function () {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(this.pos), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(this.nor), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(this.col), 3));
    for (var i = 0; i < this.names.length; i++) {
      var name = this.names[i];
      g.setAttribute(name, new THREE.BufferAttribute(new Float32Array(this.data[name]), this.sizes[name]));
    }
    return g;
  };

  // People and signal heads build with the same tool.
  vehicles._Geo = Geo;
  vehicles._rgb = rgb;
  vehicles._ACTOR_ORDER = ACTOR_ORDER;

  // -- Bodies -----------------------------------------------------------------------------------------------------------------------

  var COL = null;

  /** Fixed colours. Filled at init, because THREE is only sure to exist then. */
  function colours() {
    if (COL) return COL;
    COL = {
      paint: [1, 1, 1],
      glass: rgb('#1d2a33'),
      glassPale: rgb('#33464f'),
      tyre: rgb('#17181a'),
      hub: rgb('#8e9499'),
      hubDark: rgb('#4a4f55'),
      arch: rgb('#0e0f11'),
      plastic: rgb('#26282c'),
      grille: rgb('#121316'),
      chrome: rgb('#b4babf'),
      brakeOff: rgb('#7a1414'),
      blinkOff: rgb('#a8681a'),
      revOff: rgb('#d9d9d0'),
      headOff: rgb('#e8e6c8'),
      signAmber: rgb('#f4b52a'),
      taxiStripe: rgb('#d9a418'),
      plate: rgb('#e9d64a'),
      white: rgb('#f2f0e8'),
      rust: rgb('#7c4a2a'),
      primer: rgb('#7f858a'),
      tape: rgb('#c8ccce'),
      sticker: rgb('#e3cf4a'),
      playerPaint: rgb(PLAYER_PAINT),
      playerRoof: rgb(PLAYER_ROOF),
      playerDoor: rgb(PLAYER_DOOR),
      door: rgb('#2a3a54'),
      stripe: rgb('#e0502e')
    };
    return COL;
  }

  /** Sets the paint flag of what is added next. 1 means tinted by the instance's colour. */
  function paint(g, on) {
    var m = g.cur.aMat;
    g.cur.aMat = [m[0], on ? 1 : 0, m[2], m[3]];
  }

  /** Sets the lamp ID of what is added next. */
  function lamp(g, id) {
    var m = g.cur.aMat;
    g.cur.aMat = [id, m[1], m[2], m[3]];
  }

  /** Sets the alt rule of what is added next. */
  function alt(g, rule) {
    var m = g.cur.aMat;
    g.cur.aMat = [m[0], m[1], m[2], rule];
  }

  /**
   * Adds one wheel with its arch.
   * @param {Geo} g Target.
   * @param {number} x Wheel centre.
   * @param {number} z Wheel centre, at the outer face.
   * @param {number} r Radius.
   * @param {number} kind 1 rear, 2 front (steers).
   */
  function wheel(g, x, z, r, kind) {
    var c = colours();
    var side = z > 0 ? 1 : -1;
    paint(g, false);
    var n = 5, ring = [];
    for (var i = 0; i <= n; i++) {
      var a = Math.PI * i / n;
      ring.push([x + Math.cos(a) * (r + 0.07), 0.3 + Math.sin(a) * (r + 0.05), z + side * 0.004]);
    }
    for (var j = 0; j < n; j++) {
      g.tri([x, 0.3, z + side * 0.004], ring[j], ring[j + 1], c.arch, [0, 0, side]);
    }
    g.with({ aPiv: [x, r, z - side * 0.09] });
    var m = g.cur.aMat;
    g.cur.aMat = [m[0], m[1], kind, m[3]];
    g.cyl(x, r, z - side * 0.09, r, 0.22, 8, c.tyre, null, 0);
    g.cyl(x, r, z + side * 0.025, r * 0.6, 0.015, 6, c.hub, c.hubDark, side);
    g.cur.aMat = [m[0], m[1], 0, m[3]];
  }

  /**
   * Adds the corner lamps. Rear pair: tail/brake, blinker, reverse. Front pair: head, blinker.
   * @param {Geo} g Target.
   * @param {object} o { rx, ry, rz, fx, fy, fz, w, h } A row of LAMPS, or the same fields for a body with no row of its own.
   */
  function lamps(g, o) {
    var c = colours();
    var w = o.w || 0.3, h = o.h || 0.17;
    /** One flat lamp on an end of the body. It stands proud, so the eye gets the colour and the mesh saves the sides of a box. */
    function pane(x, y, z, width, height, col, out) {
      var d = out * LAMP_PROUD, a = [x + d, y - height / 2, z - width / 2], b = [x + d, y + height / 2, z - width / 2];
      var e = [x + d, y + height / 2, z + width / 2], f = [x + d, y - height / 2, z + width / 2];
      g.quad(a, b, e, f, col, [out, 0, 0]);
    }
    paint(g, false);
    [-1, 1].forEach(function (s) {
      lamp(g, LAMP.BRAKE);
      pane(o.rx, o.ry, s * o.rz, w, h, c.brakeOff, -1);
      lamp(g, s < 0 ? LAMP.BLINK_L : LAMP.BLINK_R);
      pane(o.rx, o.ry, s * (o.rz + w / 2 + 0.05), 0.1, h, c.blinkOff, -1);
      lamp(g, LAMP.REVERSE);
      pane(o.rx, o.ry, s * (o.rz - w / 2 - 0.05), 0.1, h, c.revOff, -1);
      lamp(g, LAMP.HEAD);
      pane(o.fx, o.fy, s * o.fz, w, h * 0.9, c.headOff, 1);
      lamp(g, s < 0 ? LAMP.BLINK_L : LAMP.BLINK_R);
      pane(o.fx - 0.02, o.fy, s * (o.fz + w / 2 + 0.05), 0.1, h * 0.9, c.blinkOff, 1);
    });
    lamp(g, LAMP.NONE);
  }

  /**
   * The shared passenger-car shell: lower body, greenhouse, roof, glass, wheels, lamps, bumpers.
   * @param {Geo} g Target.
   * @param {object} o Dimensions.
   * @returns {object} Faces and lamp positions a kind may add to.
   */
  function carShell(g, o) {
    var c = colours();
    var bodyCol = o.bodyCol || c.paint;
    paint(g, !o.bodyCol);
    g.loft(o.lower, bodyCol);
    var cabin = g.loft(o.cabin, bodyCol);
    var roofTop = o.roofTop || o.cabin[1][2];
    paint(g, false);
    // Windscreen, side glass and rear glass sit on the cabin, and what stays uncovered reads as pillars.
    g.panel(cabin[0].top, 0.1, 0.92, 0.09, 0.91, c.glass, [0.65, 0.76, 0]);
    g.panel(cabin[2].top, 0.1, 0.92, 0.09, 0.91, c.glass, [-0.7, 0.72, 0]);
    [cabin[1].left, cabin[1].right].forEach(function (q) {
      var s = q === cabin[1].left ? -1 : 1;
      var out = [0, 0.3, s];
      g.panel(q, 0.02, o.bPillar - 0.03, 0.07, 0.9, c.glass, out);
      g.panel(q, o.bPillar + 0.03, 0.97, 0.07, 0.9, c.glass, out);
    });
    [cabin[0].left, cabin[0].right, cabin[2].left, cabin[2].right].forEach(function (q, i) {
      var s = q[0][2] < 0 ? -1 : 1;
      if (i < 2) g.tri(q[0], q[1], q[2], c.glassPale, [0, 0.3, s]);
      else g.tri(q[0], q[2], q[3], c.glassPale, [0, 0.3, s]);
    });
    // Black lower sill and bumpers, so a car reads from the street as dark below and painted above.
    var sill = o.lower[3];
    g.box(0, 0.32, -sill[3] - 0.004, o.sillLen, 0.1, 0.02, c.plastic);
    g.box(0, 0.32, sill[3] + 0.004, o.sillLen, 0.1, 0.02, c.plastic);
    var front = o.lower[0][0], rear = o.lower[o.lower.length - 1][0];
    g.box(front + 0.015, 0.46, 0, 0.1, 0.2, o.lower[1][4] * 1.9, c.plastic);
    g.box(rear - 0.015, 0.5, 0, 0.1, 0.22, o.lower[1][4] * 1.95, c.plastic);
    g.box(front + 0.05, 0.6, 0, 0.04, 0.09, 0.9, c.grille);
    g.box(rear - 0.075, 0.6, 0, 0.02, 0.1, 0.34, c.plate);
    wheel(g, o.wheelF, o.wz, Q.wheelR, 2);
    wheel(g, o.wheelF, -o.wz, Q.wheelR, 2);
    wheel(g, o.wheelR, o.wz, Q.wheelR, 1);
    wheel(g, o.wheelR, -o.wz, Q.wheelR, 1);
    return { cabin: cabin, roofTop: roofTop };
  }

  /** Dimensions of the hatch, used by traffic and by the player. */
  function hatchDims() {
    return {
      lower: [
        [2.0, 0.42, 0.64, 0.68, 0.62], [1.92, 0.3, 0.76, 0.8, 0.74], [1.32, 0.27, 0.9, 0.86, 0.8], [0.72, 0.27, 1.0, 0.875, 0.83],
        [-1.55, 0.27, 1.04, 0.875, 0.83], [-1.92, 0.3, 1.0, 0.82, 0.76], [-2.0, 0.4, 0.92, 0.76, 0.72]
      ],
      cabin: [[0.92, 0.98, 1.0, 0.8, 0.8], [0.06, 0.98, 1.52, 0.8, 0.66], [-1.22, 1.0, 1.54, 0.81, 0.67], [-1.86, 1.0, 1.04, 0.78, 0.74]],
      bPillar: 0.5, sillLen: 2.3, wheelF: 1.28, wheelR: -1.28, wz: 0.885
    };
  }

  /** Dimensions of the saloon, shared with the taxi. */
  function sedanDims() {
    return {
      lower: [
        [2.2, 0.42, 0.62, 0.7, 0.62], [2.12, 0.3, 0.74, 0.82, 0.76], [1.5, 0.27, 0.88, 0.88, 0.82], [0.95, 0.27, 0.98, 0.9, 0.84],
        [-1.32, 0.27, 1.02, 0.9, 0.84], [-1.75, 0.27, 1.06, 0.88, 0.82], [-2.1, 0.3, 1.0, 0.83, 0.77], [-2.2, 0.42, 0.9, 0.78, 0.73]
      ],
      cabin: [[1.06, 0.96, 0.98, 0.82, 0.82], [0.26, 0.96, 1.44, 0.82, 0.67], [-0.92, 0.98, 1.46, 0.82, 0.67], [-1.62, 0.98, 1.04, 0.8, 0.76]],
      bPillar: 0.48, sillLen: 2.4, wheelF: 1.42, wheelR: -1.38, wz: 0.91
    };
  }

  function buildHatch(g) {
    carShell(g, hatchDims());
    lamps(g, LAMPS.hatch);
    var c = colours();
    paint(g, false);
    g.box(-1.3, 1.57, 0, 0.3, 0.05, 1.1, c.plastic);    // rear spoiler lip: a hatch's back reads at once
  }

  function buildSedan(g) {
    carShell(g, sedanDims());
    lamps(g, LAMPS.sedan);
  }

  function buildTaxi(g) {
    var c = colours();
    carShell(g, sedanDims());
    lamps(g, LAMPS.taxi);
    paint(g, false);
    // Roof sign, lit in daylight, and a yellow waist stripe. Both show from behind and from the side.
    lamp(g, LAMP.SIGN);
    g.box(-0.3, 1.58, 0, 0.3, 0.2, 0.74, c.signAmber);
    lamp(g, LAMP.NONE);
    g.box(-0.3, 1.47, 0, 0.42, 0.05, 0.86, c.plastic);
    g.box(0, 0.76, -0.912, 3.6, 0.1, 0.02, c.taxiStripe);
    g.box(0, 0.76, 0.912, 3.6, 0.1, 0.02, c.taxiStripe);
    g.box(-2.17, 0.76, 0, 0.03, 0.1, 1.3, c.taxiStripe);
  }

  /**
   * A van shell. Plain instances are delivery vans, panel-sided with a stripe and a roof rack. Alt instances are sheruts, with a
   * window row, a sliding-door line and a lit roof sign.
   */
  function buildVan(g) {
    var c = colours();
    paint(g, true);
    g.loft([[2.6, 0.42, 0.74, 0.78, 0.7], [2.5, 0.3, 0.98, 0.94, 0.88], [1.9, 0.3, 1.3, 0.98, 0.94], [1.45, 0.3, 1.34, 1.0, 0.95],
      [-2.55, 0.3, 1.34, 1.0, 0.95], [-2.6, 0.4, 1.3, 0.96, 0.92]], c.paint);
    var cab = g.loft([[1.62, 1.3, 1.34, 0.94, 0.94], [0.92, 1.3, 2.26, 0.94, 0.82], [-2.5, 1.32, 2.3, 0.95, 0.84],
      [-2.6, 1.32, 2.24, 0.93, 0.82]], c.paint);
    paint(g, false);
    g.panel(cab[0].top, 0.08, 0.93, 0.08, 0.92, c.glass, [0.8, 0.6, 0]);
    [cab[1].left, cab[1].right].forEach(function (q) {
      var s = q[0][2] < 0 ? -1 : 1;
      var out = [0, 0.1, s];
      g.panel(q, 0.02, 0.2, 0.12, 0.86, c.glass, out);        // cab door
      alt(g, ALT.ONLY);
      for (var i = 0; i < 4; i++) g.panel(q, 0.24 + i * 0.185, 0.24 + i * 0.185 + 0.165, 0.2, 0.84, c.glass, out);
      alt(g, ALT.NOT);
      g.panel(q, 0.22, 0.99, 0.04, 0.26, c.stripe, out);
      alt(g, ALT.ALL);
    });
    var side = cab[1].right;
    alt(g, ALT.ONLY);
    g.panel(side, 0.24, 0.26, 0.0, 0.9, c.plastic, [0, 0.1, 1.01]);
    lamp(g, LAMP.SIGN);
    g.box(1.0, 2.36, 0, 0.26, 0.22, 1.1, c.signAmber);       // sherut roof sign
    lamp(g, LAMP.NONE);
    alt(g, ALT.NOT);
    g.box(-0.9, 2.34, 0.7, 2.8, 0.04, 0.05, c.plastic);      // roof rails
    g.box(-0.9, 2.34, -0.7, 2.8, 0.04, 0.05, c.plastic);
    alt(g, ALT.ALL);
    g.box(-2.6, 1.9, 0, 0.02, 0.02, 1.7, c.plastic);
    g.box(-2.61, 1.3, 0, 0.02, 1.8, 0.04, c.plastic);        // rear door seam
    g.box(-2.625, 1.82, 0, 0.02, 0.5, 1.36, c.glass);
    g.box(2.58, 0.46, 0, 0.1, 0.2, 1.5, c.plastic);
    g.box(-2.58, 0.48, 0, 0.1, 0.2, 1.75, c.plastic);
    g.box(2.57, 0.68, 0, 0.04, 0.14, 1.0, c.grille);
    g.box(-2.61, 0.66, 0, 0.02, 0.1, 0.36, c.plate);
    wheel(g, 1.72, 1.0, Q.wheelR + 0.02, 2);
    wheel(g, 1.72, -1.0, Q.wheelR + 0.02, 2);
    wheel(g, -1.72, 1.0, Q.wheelR + 0.02, 1);
    wheel(g, -1.72, -1.0, Q.wheelR + 0.02, 1);
    lamps(g, LAMPS.van);
  }

  /** A 12 m city bus: long window band, two doors on the kerb side, lit destination board. */
  function buildBus(g) {
    var c = colours();
    paint(g, true);
    var body = g.loft([[6.0, 0.36, 0.9, 1.2, 1.15], [5.92, 0.3, 1.06, 1.27, 1.25], [-5.95, 0.3, 1.06, 1.27, 1.25], [-6.0, 0.36, 1.0, 1.2, 1.16]], c.paint);
    paint(g, false);
    var upper = g.loft([[5.95, 1.04, 1.06, 1.25, 1.25], [5.72, 1.04, 2.98, 1.25, 1.2], [-5.9, 1.04, 3.04, 1.25, 1.2],
      [-6.0, 1.04, 2.94, 1.22, 1.18]], c.white);
    g.panel(upper[0].top, 0.04, 0.8, 0.06, 0.94, c.glass, [0.95, 0.3, 0]);
    lamp(g, LAMP.SIGN);
    g.panel(upper[0].top, 0.84, 0.97, 0.16, 0.84, c.signAmber, [0.95, 0.3, 0]);
    lamp(g, LAMP.NONE);
    [upper[1].left, upper[1].right].forEach(function (q) {
      var s = q[0][2] < 0 ? -1 : 1;
      var out = [0, 0, s];
      for (var i = 0; i < 7; i++) g.panel(q, 0.02 + i * 0.14, 0.15 + i * 0.14, 0.2, 0.82, c.glass, out);
    });
    [[0.86, 0.95], [0.46, 0.57]].forEach(function (d) {
      g.panel(body[1].right, d[0], d[1], 0.02, 0.98, c.door, [0, 0, 1]);
      g.panel(upper[1].right, d[0], d[1], 0, 0.84, c.door, [0, 0, 1]);
    });
    g.panel(upper[2].top, 0.2, 0.8, 0.12, 0.88, c.glass, [-1, 0.2, 0]);
    g.box(-1, 3.1, 0, 3.4, 0.16, 1.5, c.white);          // roof air conditioner
    g.box(5.98, 0.5, 0, 0.1, 0.2, 2.3, c.plastic);
    g.box(-5.98, 0.5, 0, 0.1, 0.2, 2.3, c.plastic);
    g.box(-6.0, 0.78, 0, 0.02, 0.2, 1.3, c.grille);
    wheel(g, 3.6, 1.27, Q.wheelR + 0.17, 2);
    wheel(g, 3.6, -1.27, Q.wheelR + 0.17, 2);
    wheel(g, -3.0, 1.27, Q.wheelR + 0.17, 1);
    wheel(g, -3.0, -1.27, Q.wheelR + 0.17, 1);
    lamps(g, LAMPS.bus);
  }

  /** A box truck: painted cab, plain cargo box. */
  function buildTruck(g) {
    var c = colours();
    paint(g, true);
    var cab = g.loft([[3.75, 0.4, 0.95, 1.1, 1.05], [3.65, 0.34, 1.5, 1.18, 1.12], [2.9, 0.34, 2.72, 1.18, 1.02],
      [1.95, 0.34, 2.76, 1.18, 1.05]], c.paint);
    paint(g, false);
    g.panel(cab[1].top, 0.06, 0.8, 0.08, 0.92, c.glass, [0.9, 0.45, 0]);
    [cab[2].left, cab[2].right].forEach(function (q) {
      g.panel(q, 0.08, 0.72, 0.5, 0.92, c.glass, [0, 0.1, q[0][2] < 0 ? -1 : 1]);
    });
    var cargo = rgb('#d7d8d2');
    g.box(0.0, 0.62, 0, 7.4, 0.14, 1.9, c.plastic);
    g.box(-0.92, 2.0, 0, 5.66, 2.56, 2.36, cargo);
    g.box(-3.76, 1.72, 0, 0.02, 2.0, 0.04, c.plastic);
    g.box(-3.76, 0.5, 0, 0.1, 0.18, 2.1, c.plastic);
    g.box(3.72, 0.5, 0, 0.1, 0.2, 2.2, c.plastic);
    g.box(3.67, 1.08, 0, 0.04, 0.3, 1.2, c.grille);
    wheel(g, 2.75, 1.2, Q.wheelR + 0.12, 2);
    wheel(g, 2.75, -1.2, Q.wheelR + 0.12, 2);
    wheel(g, -2.3, 1.2, Q.wheelR + 0.12, 1);
    wheel(g, -2.3, -1.2, Q.wheelR + 0.12, 1);
    wheel(g, -1.5, 1.2, Q.wheelR + 0.12, 1);
    wheel(g, -1.5, -1.2, Q.wheelR + 0.12, 1);
    lamps(g, LAMPS.truck);
  }

  /**
   * One strip of tape laid flat on a lamp, on the rear of the car.
   * @param {Geo} g Target.
   * @param {number} x Plane.
   * @param {number} y0 One end.
   * @param {number} z0 One end.
   * @param {number} y1 Other end.
   * @param {number} z1 Other end.
   * @param {number} width Strip width.
   * @param {number[]} col Colour, linear.
   */
  function tape(g, x, y0, z0, y1, z1, width, col) {
    var dy = y1 - y0, dz = z1 - z0, len = Math.sqrt(dy * dy + dz * dz);
    var ny = -dz / len * width / 2, nz = dy / len * width / 2;
    g.quad([x, y0 + ny, z0 + nz], [x, y1 + ny, z1 + nz], [x, y1 - ny, z1 - nz], [x, y0 - ny, z0 - nz], col, [-1, 0, 0]);
  }

  /**
   * The player's car: the same plain hatch, in teal gone chalky with sun. One door came from a scrapyard, one tail lamp is held together with a cross of tape,
   * and there is one sticker on the back glass (a blank colour, no logo). A family car that has seen things, not a joke car.
   */
  function buildPlayer(g) {
    var c = colours();
    var d = hatchDims();
    d.bodyCol = c.playerPaint;
    var parts = carShell(g, d);
    var L = LAMPS.hatch;
    lamps(g, L);
    paint(g, false);
    var lower = d.lower;
    var lq = [[lower[3][0], lower[3][1], -lower[3][3]], [lower[4][0], lower[4][1], -lower[4][3]],
      [lower[4][0], lower[4][2], -lower[4][4]], [lower[3][0], lower[3][2], -lower[3][4]]];
    var rq = [[lower[3][0], lower[3][1], lower[3][3]], [lower[4][0], lower[4][1], lower[4][3]],
      [lower[4][0], lower[4][2], lower[4][4]], [lower[3][0], lower[3][2], lower[3][4]]];
    // The driver's door, from a scrapyard. It stops where the leaf does, at x 0, or a stub of it stays behind when the door swings open. The front of it sits on the
    // next segment forward, and stops short of the wheel arch.
    var lf = [[lower[2][0], lower[2][1], -lower[2][3]], [lower[3][0], lower[3][1], -lower[3][3]],
      [lower[3][0], lower[3][2], -lower[3][4]], [lower[2][0], lower[2][2], -lower[2][4]]];
    g.panel(lf, 0.73, 1, 0.12, 0.97, c.playerDoor, [0, 0.1, -1]);
    g.panel(lq, 0, 0.317, 0.12, 0.97, c.playerDoor, [0, 0.1, -1]);
    g.panel(lq, 0.24, 0.3, 0.68, 0.74, c.plastic, [0, 0.12, -1]);       // its handle, so that it reads as a door and not a patch
    g.panel(lq, 0.74, 0.95, 0.06, 0.2, c.rust, [0, 0.1, -1]);
    g.panel(rq, 0.58, 0.9, 0.06, 0.16, c.rust, [0, 0.1, 1]);
    g.panel(rq, 0.45, 0.46, 0.2, 0.9, c.plastic, [0, 0.1, 1]);          // door gap, no longer quite straight
    g.panel(parts.cabin[1].top, 0.08, 0.92, 0.12, 0.88, c.playerRoof, [0, 1, 0]);
    // A cross of tape over the cracked left tail lamp, running a little past the lamp so that it reads as stuck on. Stands off the lamp as the lamp does off the panel.
    var tx = L.rx - LAMP_PROUD * 1.6, ty = L.h / 2 + 0.03, tz = L.w / 2 + 0.03;
    tape(g, tx, L.ry - ty, -L.rz - tz, L.ry + ty, -L.rz + tz, 0.04, c.tape);
    tape(g, tx - 0.004, L.ry + ty, -L.rz - tz, L.ry - ty, -L.rz + tz, 0.04, c.tape);
    g.box(-2.05, 0.52, 0.42, 0.04, 0.22, 0.62, c.primer);               // a bumper corner from another car
    g.panel(parts.cabin[2].top, 0.68, 0.86, 0.68, 0.84, c.sticker, [-1.4, 1.44, 0]);    // twice the glass's standoff, which sits on this same quad
    g.box(-1.45, 1.75, 0.5, 0.02, 0.42, 0.02, c.plastic);               // antenna, bent by a car wash in 2017
    g.box(-1.5, 1.98, 0.5, 0.11, 0.02, 0.02, c.plastic);
  }

  /** The far stand-in for every kind, scaled per instance: a body, a cabin, the two ends' lamps. Roughly 40 triangles. */
  function buildLite(g) {
    var c = colours();
    paint(g, true);
    g.loft([[0.5, 0.27, 0.92, 0.5, 0.47], [-0.5, 0.27, 1.0, 0.5, 0.47]], c.paint);
    paint(g, false);
    g.loft([[0.22, 0.98, 1.0, 0.46, 0.46], [0.02, 0.98, 1.46, 0.46, 0.37], [-0.28, 0.98, 1.46, 0.46, 0.37], [-0.42, 0.98, 1.0, 0.44, 0.42]], c.glass);
    g.box(0, 0.16, 0, 1, 0.32, 1, c.tyre);
    lamps(g, { rx: -0.5, ry: 0.84, rz: 0.32, fx: 0.5, fy: 0.74, fz: 0.32, w: 0.16, h: 0.18 });
  }

  var BUILDERS = { hatch: buildHatch, sedan: buildSedan, taxi: buildTaxi, van: buildVan, bus: buildBus, truck: buildTruck };

  /** @returns {Geo} An empty body builder. */
  function newBody() {
    return new Geo({ aMat: 4, aPiv: 3 });
  }

  /** The door leaf: hinge at the origin, the leaf running to -x, glass above the waist. */
  function doorGeometry() {
    var g = newBody();
    var c = colours();
    paint(g, true);
    g.box(-Q.doorLen / 2, 0.68, 0, Q.doorLen, 0.68, 0.07, c.paint);
    paint(g, false);
    g.box(-Q.doorLen / 2, 1.22, 0, Q.doorLen * 0.9, 0.4, 0.04, c.glass);
    g.box(-Q.doorLen + 0.08, 0.78, 0.0, 0.14, 0.04, 0.09, c.plastic);
    return g.build();
  }

  // -- Shared material ----------------------------------------------------------------------------------------------------------------

  var noGhost = { value: 0 };

  var VERT_HEAD = [
    'attribute vec4 aMat;',       // lamp, paint, wheel (1 rear, 2 front), alt rule
    'attribute vec3 aPiv;',
    'attribute vec4 iLamp;',      // brake, left, right, reverse
    'attribute vec4 iFx;',        // alpha, ghost, spin, steer
    'attribute vec4 iDent;',      // x, z in the body frame, depth 0..1, high beam + 2 * alt
    'uniform float uNoGhost;',
    'varying vec3 vGlow;',
    'varying float vBrake;',
    'varying float vAlpha;'
  ].join('\n');

  var VERT_COLOR = [
    'vColor = color;',
    'if (aMat.y > 0.5) vColor *= instanceColor.xyz;',
    'float vehAlt = step(1.5, iDent.w);',
    'float vehHigh = iDent.w - 2.0 * vehAlt;',
    'float lampId = aMat.x;',
    'vGlow = vec3(0.0);',
    'vBrake = 0.0;',
    'if (lampId > 0.5) {',
    '  if (lampId < 1.5) vBrake = iLamp.x;',
    '  else if (lampId < 2.5) vGlow = vec3(1.7, 0.72, 0.06) * iLamp.y;',
    '  else if (lampId < 3.5) vGlow = vec3(1.7, 0.72, 0.06) * iLamp.z;',
    '  else if (lampId < 4.5) vGlow = vec3(2.0) * iLamp.w;',
    '  else if (lampId < 5.5) vGlow = vec3(2.4, 2.4, 1.9) * vehHigh;',
    '  else vGlow = vec3(0.9, 0.6, 0.12);',
    '}',
    'vAlpha = iFx.x * mix(iFx.y, 1.0, uNoGhost);'
  ].join('\n');

  var WHEEL_ROT = [
    'float vehCs = cos(iFx.z), vehSn = sin(iFx.z);',
    'float vehSteer = aMat.z > 1.5 ? iFx.w : 0.0;',
    'float vehCy = cos(vehSteer), vehSy = sin(vehSteer);'
  ].join('\n');

  var VERT_NORMAL = [
    'vec3 objectNormal = vec3(normal);',
    'if (aMat.z > 0.5) {',
    WHEEL_ROT,
    '  objectNormal = vec3(vehCs * objectNormal.x - vehSn * objectNormal.y, vehSn * objectNormal.x + vehCs * objectNormal.y, objectNormal.z);',
    '  objectNormal = vec3(vehCy * objectNormal.x + vehSy * objectNormal.z, objectNormal.y, -vehSy * objectNormal.x + vehCy * objectNormal.z);',
    '}'
  ].join('\n');

  var VERT_POS = [
    'vec3 transformed = vec3(position);',
    'if (aMat.z > 0.5) {',
    WHEEL_ROT,
    '  vec3 vehRel = position - aPiv;',
    '  vehRel = vec3(vehCs * vehRel.x + vehSn * vehRel.y, -vehSn * vehRel.x + vehCs * vehRel.y, vehRel.z);',
    '  vehRel = vec3(vehCy * vehRel.x + vehSy * vehRel.z, vehRel.y, -vehSy * vehRel.x + vehCy * vehRel.z);',
    '  transformed = aPiv + vehRel;',
    '}',
    'if (iDent.z > 0.001) {',
    '  float vehD = distance(transformed.xz, iDent.xy);',
    '  float vehK = iDent.z * (1.0 - smoothstep(0.1, 1.3, vehD));',
    '  transformed.xz -= normalize(iDent.xy + vec2(0.0001)) * vehK * 0.3;',
    '  transformed.y -= vehK * 0.07 * (0.5 + 0.5 * sin(transformed.x * 7.0 + transformed.z * 5.0));',
    '}',
    'if ((aMat.w > 0.5 && aMat.w < 1.5 && vehAlt < 0.5) || (aMat.w > 1.5 && vehAlt > 0.5)) transformed = vec3(0.0, -50.0, 0.0);'
  ].join('\n');

  var FRAG_HEAD = 'varying vec3 vGlow;\nvarying float vBrake;\nvarying float vAlpha;';

  // A brake light must stay red to mean brake, and ACES turns any bright red to salmon: a lit one measured (253, 132, 87), against (197, 14, 30) unlit. So a lit
  // lamp skips the tone curve. It is a signal, not a lit surface, and it stays this colour in sun and in shade.
  var FRAG_BRAKE = '#include <tonemapping_fragment>\ngl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(1.0, 0.015, 0.01), vBrake);';

  // Interleaved gradient noise: a screen-door that needs no sorting, so a ghost stays in the opaque pass and in its one draw call.
  var FRAG_DITHER = [
    '#include <clipping_planes_fragment>',
    'if (vAlpha < 0.995) {',
    '  float vehN = fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715))));',
    '  if (vehN >= vAlpha * smoothstep(' + Q.ghostClearNearM.toFixed(2) + ', ' + Q.ghostClearFarM.toFixed(2) + ', 1.0 / gl_FragCoord.w)) discard;',
    '}'
  ].join('\n');

  /** @returns {THREE.Material} The one material every body shares, so all bodies compile one program. */
  function bodyMaterial() {
    var m = new THREE.MeshLambertMaterial({ vertexColors: true });
    m.onBeforeCompile = function (shader) {
      shader.uniforms.uNoGhost = noGhost;
      shader.vertexShader = VERT_HEAD + '\n' + shader.vertexShader
        .replace('#include <color_vertex>', VERT_COLOR)
        .replace('#include <beginnormal_vertex>', VERT_NORMAL)
        .replace('#include <begin_vertex>', VERT_POS);
      shader.fragmentShader = FRAG_HEAD + '\n' + shader.fragmentShader
        .replace('#include <clipping_planes_fragment>', FRAG_DITHER)
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow;')
        .replace('#include <tonemapping_fragment>', FRAG_BRAKE);
    };
    m.customProgramCacheKey = function () { return 'tlv-vehicle'; };
    return m;
  }

  // -- Runtime state ------------------------------------------------------------------------------------------------------------------

  var R = null;

  var _m, _m2, _q, _e, _p, _s, _v, _c, _lite;   // scratch, made at init: a file only defines things at load (ARCHITECTURE 4.2)

  function scratch() {
    _m = new THREE.Matrix4();
    _m2 = new THREE.Matrix4();
    _q = new THREE.Quaternion();
    _e = new THREE.Euler(0, 0, 0, 'YZX');
    _p = new THREE.Vector3();
    _s = new THREE.Vector3(1, 1, 1);
    _v = new THREE.Vector3();
    _c = new THREE.Color();
    _lite = new THREE.Vector3();
  }

  /**
   * Adds the per-instance arrays to a geometry.
   * @param {THREE.BufferGeometry} geo Shared by all instances of the mesh.
   * @param {number} cap Instances.
   * @returns {object} { lamp, fx, dent }, each a THREE.InstancedBufferAttribute.
   */
  function addInstanceData(geo, cap) {
    function attr(name) {
      var a = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    }
    return { lamp: attr('iLamp'), fx: attr('iFx'), dent: attr('iDent') };
  }

  /**
   * Builds one instanced body.
   * @param {THREE.BufferGeometry} geo Body geometry.
   * @param {number} cap Instances.
   * @param {THREE.Material} mat Material.
   * @param {THREE.Scene} scene Target.
   * @returns {object} { mesh, data, n }.
   */
  function makeBody(geo, cap, mat, scene) {
    var data = addInstanceData(geo, cap);
    var mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(cap * 3), 3);
    mesh.instanceColor.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.receiveShadow = false;
    mesh.renderOrder = ACTOR_ORDER;
    mesh.count = 0;
    scene.add(mesh);
    var body = { mesh: mesh, data: data, n: 0, rearN: 0, nearN: 0, fullN: 0 };
    // Cars are written in tiers, nearest passes first, so each pass can draw only its own: three reads count per draw.
    mesh.onBeforeShadow = function () { mesh.count = body.nearN; };
    mesh.onAfterShadow = function () { mesh.count = body.fullN; };
    return body;
  }

  /** The soft shadow under every car, past the reach of the shadow map. */
  function makeBlobs(scene) {
    var size = 64;
    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    var ctx = canvas.getContext('2d');
    var grad = ctx.createRadialGradient(size / 2, size / 2, size * 0.18, size / 2, size / 2, size / 2);
    // Opaque white to opaque black: an alphaMap reads the green channel, and a transparent stop keeps green at full to the rim.
    grad.addColorStop(0, '#ffffff');
    grad.addColorStop(1, '#000000');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, size, size);
    var tex = new THREE.CanvasTexture(canvas);
    var geo = new THREE.PlaneGeometry(1, 1);
    geo.rotateX(-Math.PI / 2);
    var mat = new THREE.MeshBasicMaterial({
      color: 0x000000, alphaMap: tex, transparent: true, opacity: 0.6, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -6, polygonOffsetUnits: -6
    });
    var cap = TLV.const.MAX_VEHICLES;
    var mesh = new THREE.InstancedMesh(geo, mat, cap);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1;
    mesh.count = 0;
    scene.add(mesh);
    return { mesh: mesh, tex: tex };
  }

  /**
   * Builds meshes and pools.
   * @param {THREE.Scene} scene Scene from renderer.js.
   * @param {object} S Sim state.
   */
  vehicles.init = function (scene, S) {
    scratch();
    colours();
    var mat = bodyMaterial();
    var n = TLV.const.MAX_VEHICLES;
    R = {
      scene: scene, mat: mat, bodies: {}, geos: [],
      ids: new Int32Array(n).fill(-1),
      fade: new Float32Array(n), ghost: new Float32Array(n).fill(1),
      roll: new Float32Array(n), pitch: new Float32Array(n), spin: new Float32Array(n), steer: new Float32Array(n),
      doorT: new Float32Array(n), doorSide: new Uint8Array(n),
      dent: new Float32Array(n), dentX: new Float32Array(n), dentZ: new Float32Array(n),
      tier: new Uint8Array(n), ctx: {}, paint: {}, playerDoor: new THREE.Color(PLAYER_DOOR),
      remote: {}, remotePaint: new THREE.Color(Q.remotePaint)
    };
    Object.keys(BUILDERS).forEach(function (kind) {
      var g = newBody();
      BUILDERS[kind](g);
      var geo = g.build();
      R.geos.push(geo);
      R.bodies[kind] = makeBody(geo, Q.capacity[kind], mat, scene);
      // Sedans share the parked pool's colours, so a parked car that comes alive keeps its paint.
      var parked = kind === 'sedan' && TLV.tune.render && TLV.tune.render.parkedPalette;
      R.paint[kind] = (parked || PALETTE[kind]).map(function (hex) { return new THREE.Color(hex); });
    });

    var pg = newBody();
    buildPlayer(pg);
    var pgeo = pg.build();
    R.geos.push(pgeo);
    R.player = makeBody(pgeo, 1, mat, scene);
    R.playerRest = pgeo.attributes.position.array.slice();
    R.playerCol = pgeo.attributes.color.array.slice();

    var lg = newBody();
    buildLite(lg);
    var lgeo = lg.build();
    R.geos.push(lgeo);
    R.lite = makeBody(lgeo, TLV.const.MAX_VEHICLES, mat, scene);
    R.lite.mesh.castShadow = false;

    var dgeo = doorGeometry();
    R.geos.push(dgeo);
    R.doors = makeBody(dgeo, 32, mat, scene);
    R.blobs = makeBlobs(scene);
    R.blobGeo = R.blobs.mesh.geometry;
  };

  /**
   * Writes one instance.
   * @param {object} body Pool.
   * @param {THREE.Matrix4} m Pose.
   * @param {THREE.Color} col Paint.
   * @param {number[]} lampState brake, left, right, reverse.
   * @param {number} alpha Spawn fade.
   * @param {number} ghost Ghost level.
   * @param {number} spin Wheel angle.
   * @param {number} steer Steering angle.
   * @param {number} dx Dent x.
   * @param {number} dz Dent z.
   * @param {number} depth Dent depth.
   * @param {number} extra High beam + 2 * alt.
   */
  function put(body, m, col, lampState, alpha, ghost, spin, steer, dx, dz, depth, extra) {
    var i = body.n;
    if (i >= body.mesh.instanceMatrix.count) return;
    m.toArray(body.mesh.instanceMatrix.array, i * 16);
    body.mesh.instanceColor.setXYZ(i, col.r, col.g, col.b);
    body.data.lamp.setXYZW(i, lampState[0], lampState[1], lampState[2], lampState[3]);
    body.data.fx.setXYZW(i, alpha, ghost, spin, steer);
    body.data.dent.setXYZW(i, dx, dz, depth, extra);
    body.n = i + 1;
  }

  /** Publishes what put wrote. */
  function flush(body) {
    body.mesh.count = body.fullN = body.n;
    body.mesh.instanceMatrix.needsUpdate = true;
    body.mesh.instanceColor.needsUpdate = true;
    body.data.lamp.needsUpdate = true;
    body.data.fx.needsUpdate = true;
    body.data.dent.needsUpdate = true;
    body.n = 0;
  }

  var lampState = [0, 0, 0, 0];

  /**
   * Queues the flares of one car. A lit lamp must read from a distance and in daylight, because the game's fairness depends on it.
   * @param {object} v Vehicle.
   * @param {number} x World x, interpolated.
   * @param {number} y World y.
   * @param {number} h Heading.
   * @param {number} high High beam level.
   */
  function queueFlares(v, x, y, h, high) {
    var fx = TLV.render.effects && TLV.render.effects.flare;
    if (!fx) return;
    var L = LAMPS[v.kind] || LAMPS.sedan;
    var c = Math.cos(h), s = Math.sin(h);
    function emit(fwd, lat, z, dirSign, r, g, b, size) {
      var wx = x + c * fwd - s * lat, wy = y + s * fwd + c * lat;
      TLV.render.coords.toThree(wx, wy, z, _v);
      fx(_v.x, _v.y, _v.z, c * dirSign, 0, -s * dirSign, r, g, b, size);
    }
    var k = v.kind === 'bus' || v.kind === 'truck' ? 1.25 : 1;
    var rearX = L.rx - FLARE_PROUD, frontX = L.fx + LAMP_PROUD;
    var blinkZ = L.w / 2 + 0.05, reverseZ = L.rz - blinkZ;      // the panes' own offsets from lamps()
    if (lampState[0] > 0.5) {
      emit(rearX, L.rz, L.ry, -1, 1, 0.06, 0.03, 1.5 * k);
      emit(rearX, -L.rz, L.ry, -1, 1, 0.06, 0.03, 1.5 * k);
    }
    if (lampState[1] > 0.5) {
      emit(rearX, L.rz + blinkZ, L.ry, -1, 1, 0.62, 0.08, 1.35 * k);
      emit(frontX, L.fz + blinkZ, L.fy, 1, 1, 0.62, 0.08, 1.35 * k);
    }
    if (lampState[2] > 0.5) {
      emit(rearX, -L.rz - blinkZ, L.ry, -1, 1, 0.62, 0.08, 1.35 * k);
      emit(frontX, -L.fz - blinkZ, L.fy, 1, 1, 0.62, 0.08, 1.35 * k);
    }
    if (lampState[3] > 0.5) {
      emit(rearX, reverseZ, L.ry, -1, 1, 1, 0.92, 0.9);
      emit(rearX, -reverseZ, L.ry, -1, 1, 1, 0.92, 0.9);
    }
    if (high > 0.05) {
      emit(frontX, L.fz, L.fy, 1, high, high * 0.97, high * 0.82, 2.6 * high);
      emit(frontX, -L.fz, L.fy, 1, high, high * 0.97, high * 0.82, 2.6 * high);
    }
  }

  /**
   * Draws one open door and the dark hole behind it.
   * @param {THREE.Matrix4} carM Body pose.
   * @param {object} v Vehicle.
   * @param {number} side 1 left, 2 right.
   * @param {number} t Open fraction.
   * @param {THREE.Color} col Paint.
   * @param {number} alpha Fade.
   * @param {number} ghost Ghost level.
   */
  function drawDoor(carM, v, side, t, col, alpha, ghost) {
    var sign = side === 1 ? -1 : 1;
    var hingeX = 0.25 * v.length, hingeZ = sign * v.width / 2;
    var ang = t * Q.doorOpenRad * sign;
    _m2.makeRotationY(ang);
    _m2.setPosition(hingeX, 0, hingeZ);
    _m.multiplyMatrices(carM, _m2);
    lampState[0] = lampState[1] = lampState[2] = lampState[3] = 0;
    put(R.doors, _m, col, lampState, alpha, ghost, 0, 0, 0, 0, 0, 0);
    // The opening it left, as a dark door-sized leaf held shut.
    _m2.makeRotationY(0);
    _m2.setPosition(hingeX - 0.02, 0, hingeZ + sign * 0.0);
    _m.multiplyMatrices(carM, _m2);
    _c.setRGB(0.02, 0.02, 0.025);
    put(R.doors, _m, _c, lampState, alpha, ghost, 0, 0, 0, 0, 0, 0);
  }

  /** Spawn fade and dents belong to a car, not a slot, so they restart when a slot takes a new car. */
  function adopt(i, v, camX, camY) {
    R.ids[i] = v.id;
    var d = TLV.math.dist(v.x, v.y, camX, camY);
    R.fade[i] = d < Q.fadeRangeM && !v.isPlayer ? 0 : 1;
    R.ghost[i] = 1;
    R.roll[i] = R.pitch[i] = R.spin[i] = R.steer[i] = 0;
    R.doorT[i] = 0;
    R.doorSide[i] = 0;
    R.dent[i] = 0;
  }

  /**
   * Writes one car: pose, lean, lamps, ghost, door and ground shadow.
   * @param {object} v Vehicle.
   * @param {number} i Slot.
   * @param {object} ctx This frame's shared values.
   */
  function drawCar(v, i, ctx) {
    var S = ctx.S, alpha = ctx.alpha, dt = ctx.dt, VL = TLV.const.VL, W = TLV.math.wrapPi;
    var cam = TLV.render.camera, camX = ctx.camX, camY = ctx.camY, near = ctx.flareD2, blobs = R.blobs.mesh;
    var leanK = ctx.leanK, steerK = ctx.steerK;
    if (R.ids[i] !== v.id) adopt(i, v, ctx.camX, ctx.camY);

    var x = v.px + (v.x - v.px) * alpha;
    var y = v.py + (v.y - v.py) * alpha;
    var h = v.ph + W(v.h - v.ph) * alpha;

    // Lean. Roll follows lateral acceleration, pitch follows the pedals, so a car's weight shows what its driver just did.
    var lat = v.yawRate * Math.abs(v.v);
    var rollAim = TLV.math.clamp(lat * Q.rollK, -Q.rollMax, Q.rollMax);
    var live = v.isPlayer || v.mode === 'LANE' || v.mode === 'CONN';
    var pitchAim = 0;
    if (live) pitchAim = TLV.math.clamp(v.accel * Q.pitchK, -Q.pitchMax, Q.pitchMax);
    if (v.mode === 'WRECK') { rollAim = Q.wreckTilt; pitchAim = -Q.wreckTilt; }
    R.roll[i] += (rollAim - R.roll[i]) * leanK;
    R.pitch[i] += (pitchAim - R.pitch[i]) * leanK;
    R.spin[i] = (R.spin[i] + v.v * dt / Q.wheelR) % (Math.PI * 2);
    R.steer[i] += (v.steer - R.steer[i]) * steerK;

    TLV.render.coords.toThree(x, y, 0, _p);
    _e.set(R.roll[i], h, R.pitch[i], 'YZX');
    _q.setFromEuler(_e);
    _m.compose(_p, _q, _s);

    // Lamps. The sim's bits are the only source: accel is stale outside LANE and CONN (WP-TRAFFIC report).
    var bits = v.lights;
    var blink = ((S.t * Q.blinkHz + v.id * 0.37) % 1) < Q.blinkDuty ? 1 : 0;
    var hazard = bits & VL.HAZARD;
    lampState[0] = bits & VL.BRAKE ? 1 : 0;
    lampState[1] = (hazard || bits & VL.BLINK_L) && blink ? 1 : 0;
    lampState[2] = (hazard || bits & VL.BLINK_R) && blink ? 1 : 0;
    lampState[3] = bits & VL.REVERSE ? 1 : 0;
    var high = 0;
    if (bits & VL.HIGH_BEAM) {
      var b = (S.t * Q.beamHz + v.id * 0.13) % 1;
      high = b < 0.14 || (b > 0.26 && b < 0.4) ? 1 : Q.beamRest;
    }

    // Fade in, and the ghost when a car sits between the camera and the player.
    R.fade[i] = Math.min(1, R.fade[i] + dt / Q.fadeS);
    var ghostAim = cam && cam.isGhost && cam.isGhost(i) ? Q.ghostAlpha : 1;
    R.ghost[i] += (ghostAim - R.ghost[i]) * Math.min(1, Q.ghostRate * dt);

    var kind = v.kind in R.bodies ? v.kind : 'sedan';
    var variant = v.variant & 7;
    var col = R.paint[kind][variant];
    var isAlt = kind === 'van' && variant >= SHERUT_FROM ? 1 : 0;
    var extra = Math.min(high, 1) + 2 * isAlt;

    if (v.isPlayer) {
      // His colours are baked into his own mesh, so the paint flag has nothing to tint.
      _c.setRGB(1, 1, 1);
      put(R.player, _m, _c, lampState, 1, 1, R.spin[i], R.steer[i], 0, 0, 0, extra);
    } else {
      var fdx = x - S.player.fx, fdy = y - S.player.fy;
      if (fdx * fdx + fdy * fdy < Q.fullM * Q.fullM) {
        put(R.bodies[kind], _m, col, lampState, R.fade[i], R.ghost[i], R.spin[i], R.steer[i], R.dentX[i], R.dentZ[i], R.dent[i], extra);
      } else {
        _lite.set(v.length, Q.liteHeight[kind] || 1, v.width);
        _m.scale(_lite);
        put(R.lite, _m, col, lampState, R.fade[i], 1, 0, 0, 0, 0, 0, Math.min(high, 1));
      }
    }

    if (R.fade[i] > 0.5) {
      var dx = x - camX, dy = y - camY;
      if (dx * dx + dy * dy < near) queueFlares(v, x, y, h, high);
    }

    // Doors swing from the sim's bit, and keep their side while they shut.
    if (v.door) R.doorSide[i] = v.door;
    var doorAim = v.door ? 1 : 0;
    if (R.doorT[i] !== doorAim) {
      var step = Q.doorRate * dt;
      R.doorT[i] = doorAim > R.doorT[i] ? Math.min(1, R.doorT[i] + step) : Math.max(0, R.doorT[i] - step);
    }
    if (R.doorT[i] > 0.001 && R.doorSide[i]) {
      var carM = _m.clone();
      drawDoor(carM, v, R.doorSide[i], R.doorT[i], v.isPlayer ? R.playerDoor : col, R.fade[i], R.ghost[i]);
    }

    _p.y = Q.blobLift;
    _e.set(0, h, 0, 'YZX');
    _q.setFromEuler(_e);
    _v.set(v.length * 1.22, 1, v.width * 1.5);
    _m2.compose(_p, _q, _v);
    _m2.toArray(blobs.instanceMatrix.array, ctx.blobN * 16);
    ctx.blobN++;
  }

  /**
   * The other drivers of a shared day (GAME_DESIGN 26). Each runs a sim of their own and reports a pose a few times a second, so their
   * car is drawn where the last report and its speed put it, eased, and takes no part in this street: it is no Vehicle.
   */
  function drawRemote(S, ctx) {
    var vs = S.versus;
    if (!vs || !vs.on) return;
    var seen = R.remote;
    var k = 1 - Math.exp(-Q.remoteRate * ctx.dt);
    var blobs = R.blobs.mesh;
    for (var id in vs.peers) {
      var p = vs.peers[id];
      if (!p.seen || p.ended) {
        delete seen[id];
        continue;
      }
      var lead = Math.min(Q.remoteLeadS, Math.max(0, S.t - p.at));
      var tx = p.x + Math.cos(p.h) * p.v * lead;
      var ty = p.y + Math.sin(p.h) * p.v * lead;
      var s = seen[id];
      if (!s || TLV.math.dist(s.x, s.y, tx, ty) > Q.remoteSnapM) s = seen[id] = { x: tx, y: ty, h: p.h, spin: 0 };
      s.x += (tx - s.x) * k;
      s.y += (ty - s.y) * k;
      s.h += TLV.math.wrapPi(p.h - s.h) * k;
      s.spin = (s.spin + p.v * ctx.dt / Q.wheelR) % (Math.PI * 2);
      TLV.render.coords.toThree(s.x, s.y, 0, _p);
      _e.set(0, s.h, 0, 'YZX');
      _q.setFromEuler(_e);
      _m.compose(_p, _q, _s);
      lampState[0] = lampState[1] = lampState[2] = lampState[3] = 0;
      // Both drivers start a day at the same spawn, and a car drawn inside the player's own is only in the way.
      var gap = TLV.math.dist(s.x, s.y, S.player.fx, S.player.fy);
      var show = TLV.math.clamp((gap - Q.remoteHideM) / Q.remoteHideM, 0, 1);
      if (show <= 0) continue;
      put(R.bodies.hatch, _m, R.remotePaint, lampState, 1, Q.remoteAlpha * show, s.spin, 0, 0, 0, 0, 0);
      if (ctx.blobN >= blobs.instanceMatrix.count) continue;
      var size = TLV.const.VEHICLE_SIZES.hatch;
      _p.y = Q.blobLift;
      _v.set(size.length * 1.22, 1, size.width * 1.5);
      _m2.compose(_p, _q, _v);
      _m2.toArray(blobs.instanceMatrix.array, ctx.blobN * 16);
      ctx.blobN++;
    }
  }

  /** Draws the active cars of one tier. */
  function drawTier(cars, tier, ctx) {
    for (var i = 0; i < cars.length; i++) {
      if (cars[i].active && R.tier[i] === tier) drawCar(cars[i], i, ctx);
    }
  }

  /** Notes how many instances each body has so far, under a pass's own count. */
  function markTier(key) {
    for (var kind in R.bodies) R.bodies[kind][key] = R.bodies[kind].n;
    R.player[key] = R.player.n;
    R.doors[key] = R.doors.n;
  }

  /**
   * Updates every car.
   * @param {object} S Sim state.
   * @param {number} alpha Tick interpolation.
   * @param {number} dtReal Seconds since the last frame.
   * @param {THREE.Camera} camera Main camera.
   */
  vehicles.frame = function (S, alpha, dtReal, camera) {
    if (!R) return;
    var dt = Math.min(dtReal, 0.1);
    var camX = camera ? camera.position.x : 0;
    var camY = camera ? -camera.position.z : 0;
    var near = Q.flareRangeM * Q.flareRangeM;
    var blobs = R.blobs.mesh;
    var leanK = 1 - Math.exp(-Q.leanRate * dt);
    var steerK = 1 - Math.exp(-Q.steerRate * dt);
    var cars = S.vehicles;

    var ctx = R.ctx;
    ctx.S = S; ctx.alpha = alpha; ctx.dt = dt; ctx.camX = camX; ctx.camY = camY; ctx.flareD2 = near;
    ctx.leanK = leanK; ctx.steerK = steerK; ctx.blobN = 0;
    var nearD2 = Q.shadowNearM * Q.shadowNearM;
    var rearD2 = Q.rearNearM * Q.rearNearM;
    var yaw = TLV.render.rearview && TLV.render.rearview.heading ? TLV.render.rearview.heading(S) : 0;
    var ax = Math.cos(yaw), ay = Math.sin(yaw);
    var i;
    for (i = 0; i < cars.length; i++) {
      var v = cars[i];
      if (!v.active) {
        R.ids[i] = -1;
        R.tier[i] = TIER_FAR;
        continue;
      }
      var fx = v.x - S.player.fx, fy = v.y - S.player.fy;
      var d2 = fx * fx + fy * fy;
      R.tier[i] = d2 >= nearD2 ? TIER_FAR : d2 < rearD2 && fx * ax + fy * ay < Q.rearAheadM ? TIER_REAR : TIER_SHADOW;
    }
    drawTier(cars, TIER_REAR, ctx);
    markTier('rearN');
    drawTier(cars, TIER_SHADOW, ctx);
    markTier('nearN');
    drawTier(cars, TIER_FAR, ctx);
    drawRemote(S, ctx);

    for (var kindName in R.bodies) flush(R.bodies[kindName]);
    flush(R.player);
    flush(R.doors);
    flush(R.lite);
    blobs.count = ctx.blobN;
    blobs.instanceMatrix.needsUpdate = true;
  };

  /**
   * Presses a dent into the player's car, around a point in its own frame.
   * @param {number} lx Metres forward of the body centre.
   * @param {number} ly Metres left of it.
   * @param {number} depth Metres, at the centre.
   * @param {number} radius Metres.
   */
  function dentPlayer(lx, ly, depth, radius) {
    var geo = R.player.mesh.geometry;
    var pos = geo.attributes.position.array;
    var col = geo.attributes.color.array;
    var mat = geo.attributes.aMat.array;
    var rest = R.playerRest;
    var cx = lx, cz = -ly;
    var len = Math.sqrt(cx * cx + cz * cz) || 1;
    var ix = -cx / len, iz = -cz / len;
    var n = pos.length / 3;
    for (var i = 0; i < n; i++) {
      if (mat[i * 4 + 2] > 0.5) continue;       // wheels stay round
      var px = pos[i * 3], py = pos[i * 3 + 1], pz = pos[i * 3 + 2];
      var d = Math.sqrt((px - cx) * (px - cx) + (pz - cz) * (pz - cz) + (py - 0.75) * (py - 0.75) * 0.5);
      if (d >= radius) continue;
      var k = 1 - d / radius;
      k = k * k * (3 - 2 * k);
      var ripple = 0.75 + 0.25 * Math.sin(px * 11 + pz * 7);
      pos[i * 3] += ix * depth * k * ripple;
      pos[i * 3 + 2] += iz * depth * k * ripple;
      pos[i * 3 + 1] -= 0.25 * depth * k;
      // Never further than dentMax from the factory shape, so a car cannot fold into itself.
      var ox = pos[i * 3] - rest[i * 3], oy = pos[i * 3 + 1] - rest[i * 3 + 1], oz = pos[i * 3 + 2] - rest[i * 3 + 2];
      var off = Math.sqrt(ox * ox + oy * oy + oz * oz);
      if (off > Q.dentMax) {
        var scale = Q.dentMax / off;
        pos[i * 3] = rest[i * 3] + ox * scale;
        pos[i * 3 + 1] = rest[i * 3 + 1] + oy * scale;
        pos[i * 3 + 2] = rest[i * 3 + 2] + oz * scale;
      }
      // Scrapes go grey toward bare metal.
      var grey = 0.55;
      var mix = Math.min(0.75, depth * 6) * k;
      for (var c = 0; c < 3; c++) col[i * 3 + c] += (grey - col[i * 3 + c]) * mix;
    }
    // Faces keep flat normals, so the crease shows.
    var nor = geo.attributes.normal.array;
    for (var t = 0; t < n; t += 3) {
      var a = t * 3, b = a + 3, e = a + 6;
      var ux = pos[b] - pos[a], uy = pos[b + 1] - pos[a + 1], uz = pos[b + 2] - pos[a + 2];
      var vx = pos[e] - pos[a], vy = pos[e + 1] - pos[a + 1], vz = pos[e + 2] - pos[a + 2];
      var nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      var l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      if (l < 1e-9) continue;
      nx /= l; ny /= l; nz /= l;
      for (var j = 0; j < 3; j++) {
        nor[a + j * 3] = nx;
        nor[a + j * 3 + 1] = ny;
        nor[a + j * 3 + 2] = nz;
      }
    }
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  /** Returns the player's car to how it looked at the start of the day. */
  function repairPlayer() {
    var geo = R.player.mesh.geometry;
    geo.attributes.position.array.set(R.playerRest);
    geo.attributes.color.array.set(R.playerCol);
    var pg = newBody();
    buildPlayer(pg);
    geo.attributes.normal.array.set(pg.nor);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.normal.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
  }

  /** @returns {?object} The vehicle with this ID. A plain scan: render has no need of the sim's index. */
  function carById(S, id) {
    for (var i = 0; i < S.vehicles.length; i++) {
      if (S.vehicles[i].active && S.vehicles[i].id === id) return S.vehicles[i];
    }
    return null;
  }

  /**
   * Handles a drained event.
   * @param {string} name Event.
   * @param {object} p Payload.
   */
  vehicles.onEvent = function (name, p) {
    if (!R) return;
    var S = TLV.app && TLV.app.S || TLV.debug.current();
    if (!S) return;
    if (name === 'run.start') {
      repairPlayer();
      return;
    }
    if (name !== 'player.contact') return;
    var me = S.vehicles[0];
    if (p.x === undefined) return;
    var c = Math.cos(me.h), s = Math.sin(me.h);
    var rx = p.x - me.x, ry = p.y - me.y;
    var depth = Q.dentDepth[p.severity] || Q.dentDepth.scrape;
    dentPlayer(rx * c + ry * s, -rx * s + ry * c, depth, Q.dentRadiusM * (0.7 + 0.3 * (Q.dentSeverity[p.severity] || 0.3)));
    if (p.kind !== 'vehicle') return;
    var other = carById(S, p.otherId);
    if (!other) return;
    var oc = Math.cos(other.h), os = Math.sin(other.h);
    var ox = p.x - other.x, oy = p.y - other.y;
    var i = other.slot;
    R.dent[i] = Math.min(1, R.dent[i] + (Q.dentSeverity[p.severity] || 0.25));
    R.dentX[i] = ox * oc + oy * os;
    R.dentZ[i] = -(-ox * os + oy * oc);
  };

  /**
   * Sets the ghost off for a pass. The rear-view must show a tailgater solid: that is its whole job.
   * @param {boolean} on True to draw every car solid.
   */
  vehicles.solidPass = function (on) {
    noGhost.value = on ? 1 : 0;
    if (!R) return;
    function limit(body) { body.mesh.count = on ? body.rearN : body.fullN; }
    for (var k in R.bodies) limit(R.bodies[k]);
    limit(R.doors);
    R.lite.mesh.visible = !on;
  };

  /** Dents the player's car by hand, for tests. @param {number} lx Forward. @param {number} ly Left. @param {string} severity Band. */
  vehicles._dent = function (lx, ly, severity) {
    dentPlayer(lx, ly, Q.dentDepth[severity] || Q.dentDepth.bump, Q.dentRadiusM);
  };

  /** @returns {object} Where a kind's lamps sit, and how far they stand off the panel. Test only. */
  vehicles._lamps = function (kind) {
    return Object.assign({ proud: LAMP_PROUD }, LAMPS[kind]);
  };

  /** @returns {?object} Render state of one slot. Test only. */
  vehicles._car = function (slot) {
    return R ? { id: R.ids[slot], fade: R.fade[slot], ghost: R.ghost[slot], door: R.doorT[slot], far: R.tier[slot] === TIER_FAR } : null;
  };

  /** @returns {object} Each body's mesh and pass counts. Test only. */
  vehicles._bodies = function () {
    var out = {};
    for (var k in R.bodies) out[k] = R.bodies[k];
    return out;
  };

  /** @returns {object} Instances and triangles by body. Test only. */
  vehicles._counts = function () {
    var out = { triangles: 0 };
    function add(name, body) {
      out[name] = body.mesh.count;
      out.triangles += body.mesh.count * body.mesh.geometry.attributes.position.count / 3;
    }
    for (var k in R.bodies) add(k, R.bodies[k]);
    add('player', R.player);
    add('doors', R.doors);
    add('lite', R.lite);
    out.nearCars = 0;
    out.rearCars = 0;
    for (var n in R.bodies) {
      out.nearCars += R.bodies[n].nearN;
      out.rearCars += R.bodies[n].rearN;
    }
    out.perBody = {};
    for (var b in R.bodies) out.perBody[b] = R.bodies[b].mesh.geometry.attributes.position.count / 3;
    return out;
  };

  /** Frees everything this module made. */
  vehicles.dispose = function () {
    if (!R) return;
    var all = [];
    for (var k in R.bodies) all.push(R.bodies[k].mesh);
    all.push(R.player.mesh, R.doors.mesh, R.lite.mesh, R.blobs.mesh);
    all.forEach(function (m) {
      R.scene.remove(m);
      m.dispose();
    });
    R.geos.forEach(function (g) { g.dispose(); });
    R.blobGeo.dispose();
    R.blobs.tex.dispose();
    R.blobs.mesh.material.dispose();
    R.mat.dispose();
    R = null;
  };
})(window.TLV);
