// js/render/effects.js — WP-RENDER (RENDER-ACTORS)
// Everything brief and loud: sparks, smoke, steam, skid marks, flares, horn rings, near-miss streaks and the white hit flash. Also the
// 3D route arrow, the door beacon and the bay marker (GAME_DESIGN 16, 20), which live in the scene and so cannot be DOM, and the opening
// of tree crowns over the bay in the parking view.
// No blood, no gore: a hit is a white flash and stars (GAME_DESIGN 15.3). Particle colours here are never red.
// Reads only the fields of ARCHITECTURE 15.1. Writes nothing to S.
(function (TLV) {
  'use strict';

  var effects = TLV.ns('render.effects');

  var Q = {
    flareCap: 240,
    particleCap: 420,
    skidCap: 1400,        // quads
    skidWidth: 0.2,
    skidStepM: 0.35,
    skidLift: 0.05,
    skidSlipRad: 0.14,    // slide angle that marks the road
    skidMinV: 4,
    skidBrake: 9.5,       // m/s2 of braking that marks the road
    skidRangeM: 80,
    hornRangeM: 95,
    hornEveryS: 0.34,
    hornRingS: 0.5,
    hornRingM: 3.6,
    streakS: 0.42,
    flashHoldS: 0.07,
    flashFadeS: 0.26,
    arrowAhead: 5.2,
    arrowZ: 1.6,          // just over the roof (1.55 m) and under the lens (2.6 m at rest). At a stop line it stays in y 265-347 of 720 at any heading: below the far head, above the car
    arrowZFoot: 2.7,
    arrowTiltAlong: 0.5,  // nose up when it points along the view: seen from so low, a flat arrow is a green brick
    arrowTiltAcross: 0.06, // flat when it points across the view, where its full width already stands tall on screen
    arrowScale: 0.68,     // at rest, where the room under the horizon is tightest
    arrowScaleTop: 0.95,  // at top speed the lens is further back and wider, and no signal is being read, so it grows to hold its size on screen
    arrowScalePark: 0.7,
    arrowScaleFoot: 0.62,
    beaconR: 1.3,
    beaconH: 70,
    beaconHiddenK: 0.6,   // the share of the column's strength that shows through a wall
    bayRangeM: 200,
    crownInM: 5.5,        // parking view: no leaf stands over the road this close to the bay or the car's way
    crownOutM: 9,         // and a crown is whole from here
    crownAheadM: 16,      // the way stays open to about the top of the frame
    crownFloorM: 1.7,     // over any parked roof (1.55 m) and under the lowest crown (about 2 m), so a green hatch is not a leaf
    steamHp: 40,
    smokeHp: 15,
    steamEveryS: 0.13
  };

  var LAYER_OVERLAY = 2;      // main camera only: the mirror must not see the arrow or a full-screen flash
  var DETAIL_KEY = 'tlv-detail';   // the shared material of city/details.js, which every tree is drawn with

  var R = null;

  var _v, _a, _f, _u, _r;   // scratch, made at init

  function scratch() {
    _v = new THREE.Vector3();
    _a = new THREE.Vector3();
    _f = new THREE.Vector3();
    _u = new THREE.Vector3();
    _r = new THREE.Vector3();
  }

  // -- Flares: additive sprites at lit lamps, and rings for horns. ---------------------------------------------------------------------

  var FLARE_VERT = [
    'attribute vec3 iPos;', 'attribute vec3 iDir;', 'attribute vec4 iCol;',  // rgb, ring width (0 is a soft glow)
    'attribute float iSize;',
    'uniform float uMirror;',
    'varying vec2 vUv;', 'varying vec4 vCol;',
    'void main() {',
    '  vec4 mv = viewMatrix * vec4(iPos, 1.0);',
    '  float k = 1.0;',
    '  if (dot(iDir, iDir) > 0.01) k = smoothstep(-0.08, 0.5, dot(normalize(cameraPosition - iPos), iDir));',
    // Up close a lamp needs no help, and a full glow would hide the car it belongs to. A horn ring keeps its size.
    // The mirror is the exception: a tailgater's high beams filling it is the point.
    '  float near = iCol.a > 0.0 ? 1.0 : mix(clamp(-mv.z / 14.0, 0.3, 1.0), 1.0, uMirror);',
    '  vUv = position.xy * 2.0;',
    '  vCol = vec4(iCol.rgb * k * near, iCol.a);',
    '  mv.xy += position.xy * iSize * (0.45 + 0.55 * k) * near;',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var FLARE_FRAG = [
    'varying vec2 vUv;', 'varying vec4 vCol;',
    'void main() {',
    '  float d = length(vUv);',
    '  if (d > 1.0) discard;',
    '  float a;',
    '  if (vCol.a > 0.0) {',
    '    float w = vCol.a;',
    '    a = smoothstep(1.0 - w * 2.0, 1.0 - w, d) * (1.0 - smoothstep(1.0 - w * 0.5, 1.0, d));',
    '  } else {',
    '    a = 1.0 - d;',
    '    a = a * a * (0.55 + 1.3 * a * a);',
    '  }',
    '  gl_FragColor = vec4(vCol.rgb * a, a);',
    '}'
  ].join('\n');

  function makeFlares(scene) {
    var cap = Q.flareCap;
    var geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5, 0, -0.5, 0.5, 0]), 3));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    function attr(name, size) {
      var a = new THREE.InstancedBufferAttribute(new Float32Array(cap * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute(name, a);
      return a;
    }
    var f = { pos: attr('iPos', 3), dir: attr('iDir', 3), col: attr('iCol', 4), size: attr('iSize', 1), n: 0 };
    geo.instanceCount = 0;
    var mat = new THREE.ShaderMaterial({
      vertexShader: FLARE_VERT, fragmentShader: FLARE_FRAG, transparent: true, depthWrite: false, uniforms: { uMirror: { value: 0 } },
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 20;
    scene.add(mesh);
    f.mesh = mesh;
    return f;
  }

  /**
   * Queues a glow for this frame. Vehicles, people and signal heads call this during their frames.
   * @param {number} x Three x.
   * @param {number} y Three y.
   * @param {number} z Three z.
   * @param {number} dx Direction the lamp faces, Three frame. All zero for no direction.
   * @param {number} dy Direction.
   * @param {number} dz Direction.
   * @param {number} r Colour.
   * @param {number} g Colour.
   * @param {number} b Colour.
   * @param {number} size Metres across.
   * @param {number} [ring] Ring width as a share of radius. Omitted for a soft glow.
   */
  effects.flare = function (x, y, z, dx, dy, dz, r, g, b, size, ring) {
    if (!R) return;
    var f = R.flares;
    var i = f.n;
    if (i >= Q.flareCap) return;
    f.pos.setXYZ(i, x, y, z);
    f.dir.setXYZ(i, dx, dy, dz);
    f.col.setXYZW(i, r, g, b, ring || 0);
    f.size.setX(i, size);
    f.n = i + 1;
  };

  function flushFlares() {
    var f = R.flares;
    f.mesh.geometry.instanceCount = f.n;
    f.mesh.visible = f.n > 0;
    f.pos.needsUpdate = true;
    f.dir.needsUpdate = true;
    f.col.needsUpdate = true;
    f.size.needsUpdate = true;
    f.n = 0;
  }

  // -- Particles: one Points cloud. Each carries its own blend, soft puff or additive spark. --------------------------------------------

  var PARTICLE_VERT = [
    'attribute vec4 aCol;',      // rgb, shape: 0 puff, 1 spark, 2 star
    'attribute vec2 aData;',     // size metres, alpha
    'uniform float uScale;',
    'varying vec4 vCol;', 'varying float vAlpha;',
    'void main() {',
    '  vec4 mv = modelViewMatrix * vec4(position, 1.0);',
    '  gl_PointSize = aData.x * uScale / max(0.1, -mv.z);',
    '  vCol = aCol;',
    '  vAlpha = aData.y;',
    '  gl_Position = projectionMatrix * mv;',
    '}'
  ].join('\n');

  var PARTICLE_FRAG = [
    'varying vec4 vCol;', 'varying float vAlpha;',
    'void main() {',
    '  vec2 p = gl_PointCoord - 0.5;',
    '  float d = length(p) * 2.0;',
    '  if (d > 1.0) discard;',
    '  if (vCol.a > 1.5) {',
    // A four-point star. It is a plain distance shape, so no texture ships for it.
    '    float s = abs(p.x) * abs(p.y) * 40.0 + d * 0.8;',
    '    if (s > 0.95) discard;',
    '    gl_FragColor = vec4(vCol.rgb * vAlpha, vAlpha);',
    '  } else if (vCol.a > 0.5) {',
    '    float a = (1.0 - d) * (1.0 - d) * 2.5 * vAlpha;',
    '    gl_FragColor = vec4(vCol.rgb * a, 0.0);',       // alpha 0 with One, OneMinusSrcAlpha is additive
    '  } else {',
    '    float a = (1.0 - d * d) * vAlpha;',
    '    gl_FragColor = vec4(vCol.rgb * a, a);',
    '  }',
    '}'
  ].join('\n');

  function makeParticles(scene) {
    var cap = Q.particleCap;
    var geo = new THREE.BufferGeometry();
    var pos = new THREE.BufferAttribute(new Float32Array(cap * 3), 3);
    var col = new THREE.BufferAttribute(new Float32Array(cap * 4), 4);
    var data = new THREE.BufferAttribute(new Float32Array(cap * 2), 2);
    pos.setUsage(THREE.DynamicDrawUsage);
    col.setUsage(THREE.DynamicDrawUsage);
    data.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pos);
    geo.setAttribute('aCol', col);
    geo.setAttribute('aData', data);
    var mat = new THREE.ShaderMaterial({
      vertexShader: PARTICLE_VERT, fragmentShader: PARTICLE_FRAG, transparent: true, depthWrite: false,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      uniforms: { uScale: { value: 620 } }
    });
    var pts = new THREE.Points(geo, mat);
    pts.frustumCulled = false;
    pts.renderOrder = 21;
    scene.add(pts);
    var v = new Float32Array(cap * 3);     // velocity
    var life = new Float32Array(cap);      // seconds left
    var span = new Float32Array(cap);      // seconds at birth
    var meta = new Float32Array(cap * 4);  // gravity, drag, start size, end size
    return { pts: pts, pos: pos, col: col, data: data, v: v, life: life, span: span, meta: meta, next: 0, alpha: new Float32Array(cap) };
  }

  /**
   * Starts one particle, Three frame.
   * @param {number} x Position.
   * @param {number} y Position.
   * @param {number} z Position.
   * @param {number} vx Velocity.
   * @param {number} vy Velocity.
   * @param {number} vz Velocity.
   * @param {number[]} c Colour, linear-free display RGB.
   * @param {number} shape 0 puff, 1 spark, 2 star.
   * @param {number} life Seconds.
   * @param {number} s0 Start size, metres.
   * @param {number} s1 End size, metres.
   * @param {number} gravity m/s2, positive falls.
   * @param {number} drag Per second.
   * @param {number} alpha Peak alpha.
   */
  function spawn(x, y, z, vx, vy, vz, c, shape, life, s0, s1, gravity, drag, alpha) {
    var P = R.parts;
    var i = P.next;
    P.next = (i + 1) % Q.particleCap;
    P.pos.setXYZ(i, x, y, z);
    P.v[i * 3] = vx;
    P.v[i * 3 + 1] = vy;
    P.v[i * 3 + 2] = vz;
    P.col.setXYZW(i, c[0], c[1], c[2], shape);
    P.life[i] = P.span[i] = life;
    P.meta[i * 4] = gravity;
    P.meta[i * 4 + 1] = drag;
    P.meta[i * 4 + 2] = s0;
    P.meta[i * 4 + 3] = s1;
    P.alpha[i] = alpha;
  }

  function updateParticles(dt) {
    var P = R.parts;
    var pos = P.pos.array, data = P.data.array;
    for (var i = 0; i < Q.particleCap; i++) {
      if (P.life[i] <= 0) {
        data[i * 2 + 1] = 0;
        data[i * 2] = 0;
        continue;
      }
      P.life[i] -= dt;
      var t = 1 - Math.max(0, P.life[i]) / P.span[i];
      var drag = Math.exp(-P.meta[i * 4 + 1] * dt);
      P.v[i * 3] *= drag;
      P.v[i * 3 + 1] = P.v[i * 3 + 1] * drag - P.meta[i * 4] * dt;
      P.v[i * 3 + 2] *= drag;
      pos[i * 3] += P.v[i * 3] * dt;
      pos[i * 3 + 1] += P.v[i * 3 + 1] * dt;
      pos[i * 3 + 2] += P.v[i * 3 + 2] * dt;
      if (pos[i * 3 + 1] < 0.04) {
        pos[i * 3 + 1] = 0.04;
        P.v[i * 3 + 1] *= -0.35;
      }
      data[i * 2] = P.meta[i * 4 + 2] + (P.meta[i * 4 + 3] - P.meta[i * 4 + 2]) * t;
      data[i * 2 + 1] = P.alpha[i] * (1 - t * t);
    }
    P.pos.needsUpdate = true;
    P.col.needsUpdate = true;
    P.data.needsUpdate = true;
  }

  var SPARK = [1, 0.82, 0.42], SPARK_HOT = [1, 0.95, 0.75], DUST = [0.62, 0.58, 0.52], STEAM = [0.92, 0.93, 0.95], SMOKE = [0.2, 0.2, 0.22];
  var TYRE = [0.5, 0.5, 0.52], STAR = [1, 0.9, 0.35];

  function burstSparks(x, y, count, vn) {
    TLV.render.coords.toThree(x, y, 0.7, _v);
    var speed = 3 + Math.min(vn || 4, 12);
    for (var i = 0; i < count; i++) {
      var a = Math.random() * Math.PI * 2;
      var up = 1.5 + Math.random() * 3.5;
      var s = speed * (0.3 + Math.random() * 0.7);
      spawn(_v.x, _v.y + Math.random() * 0.3, _v.z, Math.cos(a) * s, up, Math.sin(a) * s, i % 3 ? SPARK : SPARK_HOT, 1,
        0.25 + Math.random() * 0.35, 0.3, 0.05, 9, 0.8, 1);
    }
    for (var j = 0; j < 4; j++) {
      spawn(_v.x, 0.5, _v.z, (Math.random() - 0.5) * 2, 0.8, (Math.random() - 0.5) * 2, DUST, 0, 0.7, 0.5, 1.8, -0.2, 2, 0.5);
    }
  }

  function burstStars(x, y, z) {
    TLV.render.coords.toThree(x, y, z, _v);
    for (var i = 0; i < 12; i++) {
      var a = i / 12 * Math.PI * 2;
      spawn(_v.x, _v.y, _v.z, Math.cos(a) * 3.2, 1.6 + (i % 3), Math.sin(a) * 3.2, STAR, 2, 0.75, 0.42, 0.2, 2.5, 1.5, 1);
    }
  }

  // -- Skid marks: a ring buffer of dark quads on the road. ----------------------------------------------------------------------------

  function makeSkids(scene) {
    var cap = Q.skidCap;
    var geo = new THREE.BufferGeometry();
    var pos = new THREE.BufferAttribute(new Float32Array(cap * 4 * 3), 3);
    pos.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('position', pos);
    var index = new Uint32Array(cap * 6);
    for (var i = 0; i < cap; i++) {
      var v = i * 4;
      index.set([v, v + 1, v + 2, v, v + 2, v + 3], i * 6);
    }
    geo.setIndex(new THREE.BufferAttribute(index, 1));
    var mat = new THREE.MeshBasicMaterial({
      color: 0x0c0c0e, transparent: true, opacity: 0.62, depthWrite: false, side: THREE.DoubleSide,
      polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 2;
    scene.add(mesh);
    return { mesh: mesh, pos: pos, next: 0, used: 0, wheels: {} };
  }

  /** Adds one quad between two rib lines. */
  function skidQuad(ax, ay, bx, by, cx, cy, dx, dy) {
    var K = R.skids;
    var i = K.next;
    K.next = (i + 1) % Q.skidCap;
    K.used = Math.min(Q.skidCap, K.used + 1);
    var arr = K.pos.array;
    var o = i * 12;
    var coords = TLV.render.coords;
    coords.write(arr, o, ax, ay, Q.skidLift);
    coords.write(arr, o + 3, bx, by, Q.skidLift);
    coords.write(arr, o + 6, cx, cy, Q.skidLift);
    coords.write(arr, o + 9, dx, dy, Q.skidLift);
    K.dirty = true;
  }

  /** Lays marks for one car while it slides. Both rear wheels keep their last rib. */
  function skidCar(v, sliding, dt) {
    var K = R.skids;
    var st = K.wheels[v.slot];
    if (!sliding) {
      if (st) st.on = false;
      return;
    }
    if (!st) st = K.wheels[v.slot] = { on: false, id: -1, l: [0, 0, 0, 0], r: [0, 0, 0, 0], x: 0, y: 0 };
    var c = Math.cos(v.h), s = Math.sin(v.h);
    var back = v.length * 0.31, half = v.width * 0.42, w = Q.skidWidth / 2;
    var rx = v.x - c * back, ry = v.y - s * back;
    var lx = -s, ly = c;
    var wlx = rx + lx * half, wly = ry + ly * half, wrx = rx - lx * half, wry = ry - ly * half;
    if (!st.on || st.id !== v.id) {
      st.on = true;
      st.id = v.id;
      st.x = v.x;
      st.y = v.y;
      st.l = [wlx + lx * w, wly + ly * w, wlx - lx * w, wly - ly * w];
      st.r = [wrx + lx * w, wry + ly * w, wrx - lx * w, wry - ly * w];
      return;
    }
    if (TLV.math.dist(v.x, v.y, st.x, st.y) < Q.skidStepM) return;
    st.x = v.x;
    st.y = v.y;
    var nl = [wlx + lx * w, wly + ly * w, wlx - lx * w, wly - ly * w];
    var nr = [wrx + lx * w, wry + ly * w, wrx - lx * w, wry - ly * w];
    skidQuad(st.l[0], st.l[1], st.l[2], st.l[3], nl[2], nl[3], nl[0], nl[1]);
    skidQuad(st.r[0], st.r[1], st.r[2], st.r[3], nr[2], nr[3], nr[0], nr[1]);
    st.l = nl;
    st.r = nr;
    TLV.render.coords.toThree(wlx, wly, 0.15, _v);
    spawn(_v.x, 0.15, _v.z, 0, 0.5, 0, TYRE, 0, 0.8, 0.5, 1.9, -0.1, 1.5, 0.28);
  }

  // -- Overlays, drawn by the main camera only. ---------------------------------------------------------------------------------------

  var OVERLAY_VERT = 'attribute float aEdge;\nvarying float vEdge;\nvoid main() { vEdge = aEdge; gl_Position = vec4(position.xy, 0.0, 1.0); }';

  function makeFlash(scene) {
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1, -1, 0, 1, -1, 0, 1, 1, 0, -1, 1, 0]), 3));
    geo.setAttribute('aEdge', new THREE.BufferAttribute(new Float32Array(4), 1));
    geo.setIndex([0, 1, 2, 0, 2, 3]);
    var mat = new THREE.ShaderMaterial({
      vertexShader: OVERLAY_VERT,
      fragmentShader: 'uniform float uA;\nvoid main() { gl_FragColor = vec4(1.0, 1.0, 1.0, uA); }',
      uniforms: { uA: { value: 0 } }, transparent: true, depthTest: false, depthWrite: false
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 1000;
    mesh.layers.set(LAYER_OVERLAY);
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  }

  /** Speed lines. Wedges in screen space, thrown outward from the middle on the side the car went by. */
  function makeStreaks(scene) {
    var N = 30;
    var pos = [], edge = [];
    for (var i = 0; i < N; i++) {
      var a = (i + Math.random() * 0.6) / N * Math.PI * 2;
      var w = 0.006 + Math.random() * 0.012;
      var r0 = 0.5 + Math.random() * 0.25, r1 = r0 + 0.35 + Math.random() * 0.5;
      pos.push(Math.cos(a - w) * r0, Math.sin(a - w) * r0, a);
      pos.push(Math.cos(a + w) * r0, Math.sin(a + w) * r0, a);
      pos.push(Math.cos(a) * r1, Math.sin(a) * r1, a);
      edge.push(0, 0, 1);
    }
    var geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geo.setAttribute('aEdge', new THREE.BufferAttribute(new Float32Array(edge), 1));
    var mat = new THREE.ShaderMaterial({
      vertexShader: [
        'attribute float aEdge;', 'uniform float uT;', 'uniform float uSide;',
        'varying float vEdge;', 'varying float vKeep;',
        'void main() {',
        '  vEdge = aEdge;',
        '  float push = 1.0 + uT * 0.75;',
        '  vec2 p = position.xy * push;',
        '  vKeep = uSide == 0.0 ? 1.0 : smoothstep(-0.15, 0.25, sign(uSide) * cos(position.z));',
        '  gl_Position = vec4(p, 0.0, 1.0);',
        '}'
      ].join('\n'),
      fragmentShader: 'uniform float uA;\nvarying float vEdge;\nvarying float vKeep;\nvoid main() { gl_FragColor = vec4(1.0, 1.0, 1.0, uA * vKeep * (1.0 - vEdge * 0.2)); }',
      uniforms: { uT: { value: 0 }, uA: { value: 0 }, uSide: { value: 0 } },
      transparent: true, depthTest: false, depthWrite: false, side: THREE.DoubleSide
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 999;
    mesh.layers.set(LAYER_OVERLAY);
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  }

  /** The huge route arrow, as in Crazy Taxi. Built along +x, the way a heading points. */
  function makeArrow(scene) {
    var G = TLV.render.vehicles._Geo, rgb = TLV.render.vehicles._rgb;
    var g = new G({});
    var top = rgb('#8cff3f'), side = rgb('#2e9a25'), under = rgb('#17661a');
    var T = 0.32;
    function layer(y, col, out) {
      var o = [0, out, 0];
      g.quad([-1.5, y, -0.42], [0.1, y, -0.42], [0.1, y, 0.42], [-1.5, y, 0.42], col, o);
      g.tri([0.1, y, -1.05], [1.7, y, 0], [0.1, y, 1.05], col, o);
    }
    // Drawn with no depth test, so this order is what hides what: the walls first, then the top. updateMarkers keeps the top toward the lens.
    layer(-T / 2, under, -1);
    var outline = [[-1.5, -0.42], [0.1, -0.42], [0.1, -1.05], [1.7, 0], [0.1, 1.05], [0.1, 0.42], [-1.5, 0.42]];
    for (var i = 0; i < outline.length; i++) {
      var a = outline[i], b = outline[(i + 1) % outline.length];
      var mx = (a[0] + b[0]) / 2 - 0.1, mz = (a[1] + b[1]) / 2;
      g.quad([a[0], -T / 2, a[1]], [b[0], -T / 2, b[1]], [b[0], T / 2, b[1]], [a[0], T / 2, a[1]], side, [mx, 0, mz]);
    }
    layer(T / 2, top, 1);
    var geo = g.build();
    // A sign for the driver, not an object in the street: no tree or signal head may hide it. `transparent` only puts it in the later pass, so the flares and
    // particles draw under it and the hit flash, at a higher renderOrder, still draws over it.
    var mat = new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, toneMapped: false, transparent: true, depthTest: false, depthWrite: false });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.renderOrder = 30;
    mesh.layers.set(LAYER_OVERLAY);
    mesh.matrixAutoUpdate = false;
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  }

  /**
   * The column of light over the shop door in a chase. The player has at most 25 s to find that door, and it is often round a corner, so the column shows
   * through whatever stands in front of it. Two passes with the same geometry: full strength where it is in the clear, and fainter where it is behind something.
   * They share no pixel, so nothing is drawn twice. The hidden pass runs in the opaque list, after the city and before the actors (ACTOR_ORDER in vehicles.js), so it
   * shows through a wall but a runner or a car in front of it paints over it. Left among the transparents it tinted the head of anyone running at the door.
   */
  function makeBeacon(scene) {
    var geo = new THREE.CylinderGeometry(Q.beaconR, Q.beaconR * 1.25, Q.beaconH, 14, 1, true);
    geo.translate(0, Q.beaconH / 2, 0);
    var mat = new THREE.ShaderMaterial({
      vertexShader: 'varying float vY;\nvarying vec3 vN;\nvarying vec3 vV;\nvoid main() { vY = position.y; vN = normalMatrix * normal; vec4 mv = modelViewMatrix * vec4(position, 1.0); vV = mv.xyz; gl_Position = projectionMatrix * mv; }',
      fragmentShader: [
        'uniform float uT;', 'uniform float uK;', 'varying float vY;', 'varying vec3 vN;', 'varying vec3 vV;',
        'void main() {',
        '  float rim = pow(abs(dot(normalize(vN), normalize(vV))), 1.4);',
        '  float band = 0.75 + 0.25 * sin(vY * 0.8 - uT * 5.0);',
        '  float a = rim * band * (1.0 - smoothstep(10.0, ' + Q.beaconH.toFixed(1) + ', vY)) * 0.8 * uK;',
        '  gl_FragColor = vec4(0.55, 1.0, 0.4, a);',
        '}'
      ].join('\n'),
      uniforms: { uT: { value: 0 }, uK: { value: 1 } }, transparent: true, depthWrite: false, side: THREE.DoubleSide
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 22;
    mesh.frustumCulled = false;
    mesh.layers.set(LAYER_OVERLAY);
    mesh.visible = false;
    scene.add(mesh);
    var behindMat = mat.clone();
    behindMat.transparent = false;
    behindMat.blending = THREE.CustomBlending;
    behindMat.blendSrc = THREE.SrcAlphaFactor;
    behindMat.blendDst = THREE.OneMinusSrcAlphaFactor;
    behindMat.depthFunc = THREE.GreaterDepth;
    behindMat.uniforms.uT = mat.uniforms.uT;
    behindMat.uniforms.uK.value = Q.beaconHiddenK;
    var behind = new THREE.Mesh(geo, behindMat);
    behind.renderOrder = TLV.render.vehicles._ACTOR_ORDER - 0.5;
    behind.frustumCulled = false;
    behind.layers.set(LAYER_OVERLAY);
    mesh.add(behind);
    mesh.userData.behind = behind;
    return mesh;
  }

  /** A bright box on the road at the bay: the corners of the target and two chevrons pointing in. */
  function makeBay(scene) {
    var G = TLV.render.vehicles._Geo, rgb = TLV.render.vehicles._rgb;
    var g = new G({});
    var c = rgb('#ffe04a');
    var L = 3.25, W = 1.2, t = 0.14, leg = 1.1;
    var up = [0, 1, 0];
    function strip(x0, z0, x1, z1) {
      g.quad([x0, 0, z0], [x1, 0, z0], [x1, 0, z1], [x0, 0, z1], c, up);
    }
    [-1, 1].forEach(function (sx) {
      [-1, 1].forEach(function (sz) {
        strip(sx * L, sz * W, sx * (L - leg), sz * (W - t));
        strip(sx * L, sz * W, sx * (L - t), sz * (W - leg * 0.75));
      });
    });
    g.tri([-0.5, 0, -0.55], [0.5, 0, 0], [-0.5, 0, 0.55], c, up);
    var geo = g.build();
    var mat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, opacity: 0.85, depthWrite: false, fog: false, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4
    });
    var mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 3;
    mesh.frustumCulled = false;
    mesh.layers.set(LAYER_OVERLAY);
    mesh.visible = false;
    scene.add(mesh);
    return mesh;
  }

  // -- Crowns over the bay -------------------------------------------------------------------------------------------------------------

  /**
   * Adds the parking view's clearing to the street-detail shader. The trees live in that one material, so this joins its compile step and costs no draw call.
   * A leaf is judged by where its sight line lands on the road, not by where its tree stands: from 14 m up, a crown on the sidewalk hides the lane beside it.
   * Only a lens above the leaf counts, so the low mirror never opens a crown, and the shadow pass does not run this, so a cleared tree still shades the road.
   * @param {THREE.Scene} scene Scene.
   * @returns {?{uParkWay:object, uParkBay:object}} Uniforms, or null with no street detail.
   */
  function hookCrowns(scene) {
    var mat = null;
    scene.traverse(function (o) {
      var m = o.isInstancedMesh && o.material;
      if (!mat && m && m.customProgramCacheKey && m.customProgramCacheKey() === DETAIL_KEY) mat = m;
    });
    if (!mat) return null;
    var U = { uParkWay: { value: new THREE.Vector4() }, uParkBay: { value: new THREE.Vector4() } };
    var glsl = [
      '#include <color_fragment>',
      'if (uParkBay.z > 0.0 && vWP.y > ' + Q.crownFloorM.toFixed(2) + ' && vWP.y < cameraPosition.y - 0.5 && diffuseColor.g > diffuseColor.r * 1.1 && diffuseColor.g > diffuseColor.b * 1.2) {',
      '  vec2 landed = mix(cameraPosition.xz, vWP.xz, cameraPosition.y / (cameraPosition.y - vWP.y));',
      '  vec2 way = uParkWay.zw - uParkWay.xy, rel = landed - uParkWay.xy;',
      '  float off = min(distance(landed, uParkBay.xy), length(rel - way * clamp(dot(rel, way) / dot(way, way), 0.0, 1.0)));',
      '  float keep = 1.0 - uParkBay.z * (1.0 - smoothstep(' + Q.crownInM.toFixed(2) + ', ' + Q.crownOutM.toFixed(2) + ', off));',
      '  if (fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) >= keep) discard;',
      '}'
    ].join('\n');
    var compile = mat.onBeforeCompile;
    mat.onBeforeCompile = function (shader, gl) {
      compile.call(mat, shader, gl);
      shader.uniforms.uParkWay = U.uParkWay;
      shader.uniforms.uParkBay = U.uParkBay;
      shader.fragmentShader = 'uniform vec4 uParkWay, uParkBay;\n' + shader.fragmentShader.replace('#include <color_fragment>', glsl);
    };
    mat.customProgramCacheKey = function () { return DETAIL_KEY + '-park'; };
    mat.needsUpdate = true;
    return U;
  }

  /** Points the clearing at the car, the road ahead of the lens and the errand's bay. */
  function updateCrowns(S) {
    var U = R.crowns;
    if (!U) return;
    var cam = TLV.render.camera;
    var view = cam && cam.parkView ? cam.parkView() : 0;
    U.uParkBay.value.z = view;
    if (view <= 0) return;
    var veh = S.player.veh || S.vehicles[0];
    var yaw = cam.yaw();
    var way = U.uParkWay.value, bay = U.uParkBay.value;
    TLV.render.coords.toThree(veh.x, veh.y, 0, _v);
    way.x = bay.x = _v.x;
    way.y = bay.y = _v.z;
    TLV.render.coords.toThree(veh.x + Math.cos(yaw) * Q.crownAheadM, veh.y + Math.sin(yaw) * Q.crownAheadM, 0, _v);
    way.z = _v.x;
    way.w = _v.z;
    var e = S.game && S.game.errand;
    var spot = e && e.bayId >= 0 ? TLV.world.parking.spot(S.world, e.bayId) : null;
    if (spot) {
      TLV.render.coords.toThree(spot.x, spot.y, 0, _v);
      bay.x = _v.x;
      bay.y = _v.z;
    }
  }

  // -- Life cycle ----------------------------------------------------------------------------------------------------------------------

  /**
   * Builds everything.
   * @param {THREE.Scene} scene Scene.
   * @param {object} S Sim state.
   */
  effects.init = function (scene, S) {
    scratch();
    R = {
      scene: scene,
      rings: [],
      hornLast: new Float32Array(TLV.const.MAX_VEHICLES).fill(-1),
      flashA: 0, flashHold: 0, streakT: 1, steamT: 0, attackerT: 0, t: 0, lastSurface: -1
    };
    R.flares = makeFlares(scene);
    R.parts = makeParticles(scene);
    R.skids = makeSkids(scene);
    R.flash = makeFlash(scene);
    R.streaks = makeStreaks(scene);
    R.arrow = makeArrow(scene);
    R.beacon = makeBeacon(scene);
    R.bay = makeBay(scene);
    R.crowns = hookCrowns(scene);
  };

  /** Adds a horn ring at a car's nose. */
  function hornRing(v) {
    R.rings.push({ slot: v.slot, id: v.id, age: 0 });
  }

  function updateHorns(S, dt, camX, camY) {
    var cars = S.vehicles;
    var range = Q.hornRangeM * Q.hornRangeM;
    for (var i = 0; i < cars.length; i++) {
      var v = cars[i];
      if (!v.active || !v.horn) continue;
      var dx = v.x - camX, dy = v.y - camY;
      if (dx * dx + dy * dy > range) continue;
      if (R.t - R.hornLast[i] >= Q.hornEveryS || R.hornLast[i] < 0) {
        R.hornLast[i] = R.t;
        hornRing(v);
      }
    }
    for (var r = R.rings.length - 1; r >= 0; r--) {
      var ring = R.rings[r];
      ring.age += dt;
      var car = cars[ring.slot];
      if (ring.age > Q.hornRingS || !car.active || car.id !== ring.id) {
        R.rings.splice(r, 1);
        continue;
      }
      var k = ring.age / Q.hornRingS;
      var c = Math.cos(car.h), s = Math.sin(car.h);
      var off = car.length * 0.5 + 0.6 + k * 2;
      TLV.render.coords.toThree(car.x + c * off, car.y + s * off, 1.25, _v);
      var a = (1 - k) * 0.5;
      effects.flare(_v.x, _v.y, _v.z, 0, 0, 0, a, a * 0.9, a * 0.42, 1 + k * Q.hornRingM, 0.08);
    }
  }

  /** Steam from a dying radiator, smoke past that, and a wreck's steam. */
  function updateSteam(S, dt) {
    R.steamT -= dt;
    if (R.steamT > 0) return;
    R.steamT = Q.steamEveryS;
    var me = S.vehicles[0];
    var hp = S.game ? S.game.hp : 100;
    if (S.player.mode !== 'FOOT' && hp < Q.steamHp) {
      var c = Math.cos(me.h), s = Math.sin(me.h);
      TLV.render.coords.toThree(me.x + c * 1.5, me.y + s * 1.5, 1.0, _v);
      spawn(_v.x, _v.y, _v.z, (Math.random() - 0.5) * 0.5, 1.5, (Math.random() - 0.5) * 0.5, hp < Q.smokeHp ? SMOKE : STEAM, 0, 1.1, 0.4, 1.6, -0.5, 1.2, 0.5);
    }
    for (var i = 1; i < S.vehicles.length; i++) {
      var v = S.vehicles[i];
      if (!v.active || v.mode !== 'WRECK') continue;
      if (TLV.math.dist(v.x, v.y, me.x, me.y) > 90) continue;
      var vc = Math.cos(v.h), vs = Math.sin(v.h);
      TLV.render.coords.toThree(v.x + vc * v.length * 0.36, v.y + vs * v.length * 0.36, 1.0, _v);
      spawn(_v.x, _v.y, _v.z, 0, 1.4, 0, STEAM, 0, 1, 0.4, 1.5, -0.4, 1.2, 0.45);
    }
  }

  /** Comic steam out of the attacker's ears (GAME_DESIGN 15.3). */
  function updateAttacker(S, dt) {
    var k = S.game && S.game.knife;
    if (!k || !k.stage) return;
    R.attackerT -= dt;
    if (R.attackerT > 0) return;
    R.attackerT = 0.09;
    for (var i = 0; i < S.peds.length; i++) {
      var p = S.peds[i];
      if (!p.active || p.kind !== 'attacker') continue;
      var lx = -Math.sin(p.h), ly = Math.cos(p.h);
      var side = Math.random() < 0.5 ? 1 : -1;
      TLV.render.coords.toThree(p.x + lx * side * 0.17, p.y + ly * side * 0.17, 1.78, _v);
      spawn(_v.x, _v.y, _v.z, lx * side * 1.6, 1.1, -ly * side * 1.6, STEAM, 0, 0.55, 0.16, 0.6, -1.0, 2.2, 0.85);
      break;
    }
  }

  /** The arrow, the beacon and the bay. */
  function updateMarkers(S, alpha, dt, camera) {
    var g = S.game;
    var P = S.player;
    if (!g) return;
    var nav = g.nav;
    var phase = g.phase;
    var onFoot = P.mode === 'FOOT' && P.foot && P.foot.active;
    var knife = g.knife;
    var inChase = !!(knife && knife.stage === 'CHASE');
    var drive = phase === 'DRIVE' || phase === 'SEARCH';
    var arrow = R.arrow;
    arrow.visible = !!((drive || inChase) && nav);
    if (arrow.visible) {
      var veh = P.veh || S.vehicles[0];
      var x, y;
      if (onFoot) {
        var f = P.foot;
        x = f.px + (f.x - f.px) * alpha;
        y = f.py + (f.y - f.py) * alpha;
      } else {
        x = veh.px + (veh.x - veh.px) * alpha;
        y = veh.py + (veh.y - veh.py) * alpha;
      }
      // Ahead of the lens, never of the car's nose: in the reverse view, or while the foot camera catches up with a turn, the nose points back at the lens.
      var yaw = TLV.render.camera.yaw();
      var ahead = onFoot ? 2.4 : Q.arrowAhead;
      TLV.render.coords.toThree(x + Math.cos(yaw) * ahead, y + Math.sin(yaw) * ahead, (onFoot ? Q.arrowZFoot : Q.arrowZ) + Math.sin(R.t * 3.1) * 0.08, _a);
      // On foot the walking route is the HUD's, and the arrow points down it. nav.arrowH is a straight bearing, which can run into a wall.
      var way = onFoot && TLV.ui && TLV.ui.hud && TLV.ui.hud.footHeading ? TLV.ui.hud.footHeading(S) : null;
      var aim = way === null ? nav.arrowH : way;
      // The arrow rolls about its own axis so its top faces the camera. Pointing across the view, a flat arrow would show only its edge.
      var along = Math.cos(aim - yaw);
      TLV.render.coords.toThree(Math.cos(aim), Math.sin(aim), TLV.math.lerp(Q.arrowTiltAcross, Q.arrowTiltAlong, along * along), _f).normalize();
      if (camera) _u.copy(camera.position).sub(_a).normalize();
      else _u.set(0, 1, 0);
      _u.addScaledVector(_f, -_u.dot(_f)).normalize();
      _r.crossVectors(_f, _u);
      var view = TLV.render.camera && TLV.render.camera._state ? TLV.render.camera._state() : null;
      var scale = onFoot ? Q.arrowScaleFoot : Q.arrowScale;
      if (!onFoot && view) scale = view.rig === 'parking' ? Q.arrowScalePark : TLV.math.lerp(Q.arrowScale, Q.arrowScaleTop, view.speedT);
      arrow.matrix.makeBasis(_f.multiplyScalar(scale), _u.multiplyScalar(scale), _r.multiplyScalar(scale));
      arrow.matrix.setPosition(_a);
      arrow.matrixWorldNeedsUpdate = true;
    }

    var beacon = R.beacon;
    var errand = g.errand;
    beacon.visible = !!(errand && inChase);
    if (beacon.visible) {
      TLV.render.coords.toThree(errand.doorX, errand.doorY, 0, beacon.position);
      beacon.material.uniforms.uT.value = R.t;
    }

    var bay = R.bay;
    var showBay = false;
    if (errand && errand.bayId >= 0 && (phase === 'DRIVE' || phase === 'SEARCH' || phase === 'HOLD') && !onFoot) {
      var spot = TLV.world.parking.spot(S.world, errand.bayId);
      if (spot && TLV.math.dist(spot.x, spot.y, P.fx, P.fy) < Q.bayRangeM) {
        showBay = true;
        TLV.render.coords.toThree(spot.x, spot.y, 0.07, bay.position);
        bay.rotation.y = spot.h;
        bay.material.opacity = phase === 'HOLD' ? 1 : 0.62 + 0.3 * Math.sin(R.t * 5);
      }
    }
    bay.visible = showBay;
  }

  /**
   * Advances everything.
   * @param {object} S Sim state.
   * @param {number} alpha Tick interpolation.
   * @param {number} dtReal Seconds since the last frame.
   * @param {THREE.Camera} camera Main camera.
   */
  effects.frame = function (S, alpha, dtReal, camera) {
    if (!R) return;
    var dt = Math.min(dtReal, 0.1);
    R.t += dt;
    var camX = camera ? camera.position.x : S.player.fx;
    var camY = camera ? -camera.position.z : S.player.fy;

    updateHorns(S, dt, camX, camY);

    // Marks and smoke come from the sim's own motion: a car sliding on its velocity, or braking past its tyres.
    var cars = S.vehicles;
    var near = Q.skidRangeM * Q.skidRangeM;
    for (var i = 0; i < cars.length; i++) {
      var v = cars[i];
      if (!v.active) continue;
      if (!v.isPlayer && v.mode !== 'DYNAMIC') continue;
      var dx = v.x - camX, dy = v.y - camY;
      if (dx * dx + dy * dy > near) continue;
      var speed = Math.sqrt(v.vx * v.vx + v.vy * v.vy);
      var sliding = false;
      if (speed > Q.skidMinV && S.player.mode !== 'FOOT') {
        var slip = Math.abs(TLV.math.wrapPi(Math.atan2(v.vy, v.vx) - v.h));
        if (slip > Math.PI / 2) slip = Math.PI - slip;
        sliding = slip > Q.skidSlipRad || (v.isPlayer && v.accel < -Q.skidBrake);
      }
      skidCar(v, sliding, dt);
    }
    if (R.skids.dirty) {
      R.skids.pos.needsUpdate = true;
      R.skids.mesh.geometry.setDrawRange(0, R.skids.used * 6);
      R.skids.dirty = false;
    }

    updateSteam(S, dt);
    updateAttacker(S, dt);
    updateParticles(dt);
    updateMarkers(S, alpha, dt, camera);
    updateCrowns(S);
    var h = window.innerHeight;
    if (camera) R.parts.pts.material.uniforms.uScale.value = h * 0.5 / Math.tan(camera.fov * Math.PI / 360);

    // The hit flash cuts to white and holds a moment, as the design says: "Hits cut to white on contact."
    if (R.flashHold > 0) R.flashHold -= dt;
    else if (R.flashA > 0) R.flashA = Math.max(0, R.flashA - dt / Q.flashFadeS);
    R.flash.visible = R.flashA > 0;
    R.flash.material.uniforms.uA.value = R.flashA;

    if (R.streakT < 1) {
      R.streakT = Math.min(1, R.streakT + dt / Q.streakS);
      var u = R.streaks.material.uniforms;
      u.uT.value = R.streakT;
      u.uA.value = (1 - R.streakT) * 0.62;
    }
    R.streaks.visible = R.streakT < 1;

    flushFlares();
  };

  /** Starts the white flash. @param {number} level Peak alpha. @param {number} hold Seconds at the peak. */
  function flash(level, hold) {
    if (level >= R.flashA) {
      R.flashA = level;
      R.flashHold = hold;
    }
  }

  /**
   * Handles a drained event.
   * @param {string} name Event.
   * @param {object} p Payload.
   */
  effects.onEvent = function (name, p) {
    if (!R) return;
    var cam = TLV.render.camera;
    var S = TLV.app && TLV.app.S || TLV.debug.current();
    switch (name) {
      case 'player.contact':
        burstSparks(p.x, p.y, p.severity === 'crash' ? 42 : (p.severity === 'bump' ? 22 : 9), p.vn);
        if (cam && cam.shake) cam.shake(p.severity);
        if (p.severity === 'crash') flash(0.45, 0.02);
        break;
      case 'player.nearMiss':
        R.streakT = 0;
        if (S) {
          var me = S.vehicles[0];
          var rx = p.x - me.x, ry = p.y - me.y;
          var side = -Math.sin(me.h) * rx + Math.cos(me.h) * ry;
          // Left of the car is left of the screen, when the camera is behind it.
          R.streaks.material.uniforms.uSide.value = side > 0.2 ? -1 : (side < -0.2 ? 1 : 0);
        }
        if (cam && cam.pulse) cam.pulse();
        break;
      case 'player.surface':
        if (cam && cam.jolt && R.lastSurface >= 0 && p.surface !== R.lastSurface) cam.jolt();
        R.lastSurface = p.surface;
        break;
      case 'player.horn':
        if (S) hornRing(S.vehicles[0]);
        break;
      case 'player.hitPed':
        flash(0.5, 0.03);
        if (cam && cam.shake) cam.shake('bump');
        break;
      case 'knife.strike':
        flash(1, Q.flashHoldS);
        if (S) burstStars(S.player.fx, S.player.fy, 1.9);
        if (cam && cam.shake) cam.shake('bump');
        break;
      case 'run.start':
        R.skids.used = 0;
        R.skids.next = 0;
        R.skids.wheels = {};
        R.skids.mesh.geometry.setDrawRange(0, 0);
        for (var i = 0; i < Q.particleCap; i++) R.parts.life[i] = 0;
        R.flashA = 0;
        break;
      default:
        break;
    }
  };

  /**
   * Brackets the rear-view pass.
   * @param {boolean} on True while that pass draws.
   */
  effects.mirrorPass = function (on) {
    if (R) R.flares.mesh.material.uniforms.uMirror.value = on ? 1 : 0;
  };

  /** @returns {?object} Pools in use, for tests. */
  effects._state = function () {
    if (!R) return null;
    var live = 0;
    for (var i = 0; i < Q.particleCap; i++) if (R.parts.life[i] > 0) live++;
    return { particles: live, skids: R.skids.used, rings: R.rings.length, flash: R.flashA, streak: R.streakT, arrow: R.arrow.visible, beacon: R.beacon.visible, bay: R.bay.visible };
  };

  /** @returns {?object} This module's meshes, by name, for tests. */
  effects._meshes = function () {
    return R ? { flares: R.flares.mesh, parts: R.parts.pts, skids: R.skids.mesh, flash: R.flash, streaks: R.streaks, arrow: R.arrow, beacon: R.beacon, bay: R.bay } : null;
  };

  /** Frees what this module made. */
  effects.dispose = function () {
    if (!R) return;
    R.beacon.userData.behind.material.dispose();
    [R.flares.mesh, R.parts.pts, R.skids.mesh, R.flash, R.streaks, R.arrow, R.beacon, R.bay].forEach(function (m) {
      R.scene.remove(m);
      m.geometry.dispose();
      m.material.dispose();
    });
    R = null;
  };
})(window.TLV);
