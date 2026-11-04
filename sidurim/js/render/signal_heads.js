// js/render/signal_heads.js — WP-RENDER (RENDER-ACTORS)
// Traffic signals that show the real state. Each approach of each controller has a head on a mast over its lanes, and a second on the
// far corner, because a car waiting at the line can no longer see the mast above it. Positions are static and derived from the lanes.
// State comes only through TLV.world.signals (ARCHITECTURE 15.1). Writes nothing to S.
(function (TLV) {
  'use strict';

  var heads = TLV.ns('render.signalHeads');

  var Q = {
    capacity: 160,
    drawRangeM: 240,
    refreshM: 18,         // moved this far since the near list was built
    refreshS: 0.6,
    flareRangeM: 170,
    flareSize: 2.0,
    mastHeight: 5.6,
    farHeight: 4.2,
    poleKerbM: 0.5,       // on the sidewalk, past the kerb
    lampR: 0.23,
    faceDrop: 0.32,       // a mast head hangs this far below the arm
    minFarM: 7
  };

  var R = null;

  var _m, _q, _p, _s, _up;   // scratch, made at init

  function scratch() {
    _m = new THREE.Matrix4();
    _q = new THREE.Quaternion();
    _p = new THREE.Vector3();
    _s = new THREE.Vector3(1, 1, 1);
    _up = new THREE.Vector3(0, 1, 0);
  }

  /** Lamp row, by SIG state: GREEN 0 lights the bottom lamp, AMBER 1 the middle, RED 2 the top. */
  var LAMP_Y = [-0.48, 0, 0.48];
  var FLARE_COLOUR = [[0.15, 1, 0.42], [1, 0.62, 0.06], [1, 0.05, 0.03]];

  /** Builds one head on a pole. Arm parts stretch per instance, in the shader. */
  function buildGeometry() {
    var G = TLV.render.vehicles._Geo, rgb = TLV.render.vehicles._rgb;
    var g = new G({ aSig: 2 });
    var pole = rgb('#3a3d41'), head = rgb('#17181b'), board = rgb('#e6c94a');
    var lit = [rgb('#0d3f22'), rgb('#4b3808'), rgb('#4a0d0a')];

    g.with({ aSig: [-1, 0] });
    g.box(0, Q.mastHeight / 2, 0, 0.16, Q.mastHeight, 0.16, pole);
    g.with({ aSig: [-1, 1] });
    g.box(0, Q.mastHeight - 0.05, 0.5, 0.11, 0.11, 1, pole);

    // The head stands on the far end of the arm, faces +x toward oncoming traffic, and carries a yellow board so it reads against sky.
    g.with({ aSig: [-1, 2] });
    var y = Q.mastHeight - Q.faceDrop - 0.72;
    g.box(0, y, 0, 0.06, 1.68, 0.72, board);
    g.box(0.06, y, 0, 0.14, 1.56, 0.6, head);
    for (var i = 0; i < 3; i++) {
      var ly = y + LAMP_Y[i];
      g.with({ aSig: [i, 2] });
      var n = 10, r = Q.lampR;
      for (var a = 0; a < n; a++) {
        var a0 = a / n * Math.PI * 2, a1 = (a + 1) / n * Math.PI * 2;
        g.tri([0.14, ly, 0], [0.14, ly + Math.cos(a0) * r, Math.sin(a0) * r], [0.14, ly + Math.cos(a1) * r, Math.sin(a1) * r], lit[i], [1, 0, 0]);
      }
      g.with({ aSig: [-1, 2] });
      g.box(0.2, ly + r + 0.015, 0, 0.13, 0.03, r * 2.1, head);
    }
    return g.build();
  }

  /** Reads one approach into head records. */
  function addApproach(W, list, de) {
    var dir = W.dirEdges[de];
    if (!dir || !dir.lanes || !dir.lanes.length) return;
    var e = W.edges[dir.edge];
    var lane = W.lanes[dir.lanes[0]];
    var n = lane.px.length;
    if (n < 2) return;
    var ex = lane.px[n - 1], ey = lane.py[n - 1];
    var dx = ex - lane.px[n - 2], dy = ey - lane.py[n - 2];
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    dx /= len; dy /= len;
    var h = Math.atan2(dy, dx);
    var count = dir.lanes.length;
    var oneWay = !(e.lanesF && e.lanesB);
    var offR = oneWay ? (count - 1) / 2 * e.laneW : (count - 0.5) * e.laneW;
    var kerb = dir.dir === 0 ? e.kerbOffR : e.kerbOffL;
    var toKerb = Math.max(kerb - offR, lane.width / 2) + Q.poleKerbM;
    var rx = dy, ry = -dx;
    // The mast: at the stop line, on the right kerb, with its arm out over the middle of the approach.
    list.push({ x: ex + rx * toKerb, y: ey + ry * toKerb, h: h + Math.PI, arm: toKerb + (count - 1) / 2 * e.laneW, lane: lane.id, low: 0 });
    // The far head: where the straight-on connector lands, on the same side.
    var conns = lane.conns;
    var best = -1;
    for (var i = 0; i < conns.length; i++) {
      if (W.conns[conns[i]].turn === 'S') { best = conns[i]; break; }
    }
    if (best < 0) return;
    var c = W.conns[best];
    var m = c.px.length;
    var fx = c.px[m - 1], fy = c.py[m - 1];
    if (TLV.math.dist(ex, ey, fx, fy) < Q.minFarM) return;
    list.push({ x: fx + rx * toKerb, y: fy + ry * toKerb, h: h + Math.PI, arm: 0, lane: lane.id, low: Q.mastHeight - Q.farHeight });
  }

  /** Builds the whole list of heads once. */
  function buildList(W) {
    var list = [];
    for (var c = 0; c < W.ctrls.length; c++) {
      var slots = W.ctrls[c].slots;
      for (var s = 0; s < slots.length; s++) {
        for (var i = 0; i < slots[s].length; i++) addApproach(W, list, slots[s][i]);
      }
    }
    return list;
  }

  /**
   * Builds the mesh.
   * @param {THREE.Scene} scene Scene.
   * @param {object} S Sim state.
   */
  heads.init = function (scene, S) {
    scratch();
    var geo = buildGeometry();
    var state = new THREE.InstancedBufferAttribute(new Float32Array(Q.capacity * 2), 2);
    state.setUsage(THREE.DynamicDrawUsage);
    geo.setAttribute('iSig', state);
    var mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    mat.onBeforeCompile = function (shader) {
      shader.vertexShader = [
        'attribute vec2 aSig;', 'attribute vec2 iSig;', 'varying vec3 vGlow;'
      ].join('\n') + '\n' + shader.vertexShader
        .replace('#include <color_vertex>', [
          '#include <color_vertex>',
          'vGlow = vec3(0.0);',
          'if (aSig.x > -0.5 && abs(aSig.x - iSig.x) < 0.5) vGlow = aSig.x < 0.5 ? vec3(0.05, 1.5, 0.45) : (aSig.x < 1.5 ? vec3(1.7, 0.9, 0.05) : vec3(1.7, 0.06, 0.04));'
        ].join('\n'))
        .replace('#include <begin_vertex>', [
          'vec3 transformed = vec3(position);',
          'if (aSig.y > 1.5) transformed.z += iSig.y;',
          'else if (aSig.y > 0.5) transformed.z *= iSig.y;'
        ].join('\n'));
      shader.fragmentShader = 'varying vec3 vGlow;\n' + shader.fragmentShader
        .replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\ntotalEmissiveRadiance += vGlow;');
    };
    mat.customProgramCacheKey = function () { return 'tlv-signal'; };
    var mesh = new THREE.InstancedMesh(geo, mat, Q.capacity);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    mesh.frustumCulled = false;
    mesh.castShadow = true;
    mesh.count = 0;
    scene.add(mesh);
    R = {
      scene: scene, mesh: mesh, geo: geo, mat: mat, state: state, list: buildList(S.world), near: [],
      lastX: Infinity, lastY: Infinity, age: 0
    };
  };

  /** Rebuilds the near list and the static part of each instance. */
  function refresh(x, y) {
    R.lastX = x;
    R.lastY = y;
    R.age = 0;
    var range = Q.drawRangeM * Q.drawRangeM;
    var near = R.near;
    near.length = 0;
    for (var i = 0; i < R.list.length; i++) {
      var b = R.list[i];
      var dx = b.x - x, dy = b.y - y;
      var d2 = dx * dx + dy * dy;
      if (d2 > range) continue;
      b.d2 = d2;
      near.push(b);
    }
    near.sort(function (p, q) { return p.d2 - q.d2; });
    if (near.length > Q.capacity) near.length = Q.capacity;
    for (var n = 0; n < near.length; n++) {
      var h = near[n];
      TLV.render.coords.toThree(h.x, h.y, -h.low, _p);
      _q.setFromAxisAngle(_up, h.h);
      _m.compose(_p, _q, _s);
      _m.toArray(R.mesh.instanceMatrix.array, n * 16);
      R.state.setY(n, h.arm);
    }
    R.mesh.count = near.length;
    R.mesh.instanceMatrix.needsUpdate = true;
  }

  /**
   * Shows the signal state of every head near the camera.
   * @param {object} S Sim state.
   * @param {number} alpha Unused.
   * @param {number} dtReal Seconds since the last frame.
   * @param {THREE.Camera} camera Main camera.
   */
  heads.frame = function (S, alpha, dtReal, camera) {
    if (!R) return;
    var x = camera ? camera.position.x : S.player.fx;
    var y = camera ? -camera.position.z : S.player.fy;
    R.age += dtReal;
    if (R.age > Q.refreshS || TLV.math.dist(x, y, R.lastX, R.lastY) > Q.refreshM) refresh(x, y);
    var fx = TLV.render.effects && TLV.render.effects.flare;
    var near = R.near;
    var range = Q.flareRangeM * Q.flareRangeM;
    var v = R.v || (R.v = { x: 0, y: 0, z: 0 });
    for (var i = 0; i < near.length; i++) {
      var b = near[i];
      var state = TLV.world.signals.laneState(S, b.lane);
      R.state.setX(i, state);
      if (fx && b.d2 < range) {
        var c = Math.cos(b.h), s = Math.sin(b.h);
        // The lit lamp's flare: forward of the pole by the head's depth, then out along the arm (model +z, left of travel).
        var wx = b.x + c * 0.2 + s * b.arm, wy = b.y + s * 0.2 - c * b.arm;
        TLV.render.coords.toThree(wx, wy, Q.mastHeight - b.low - Q.faceDrop - 0.72 + LAMP_Y[state], v);
        var col = FLARE_COLOUR[state];
        fx(v.x, v.y, v.z, c, 0, -s, col[0], col[1], col[2], Q.flareSize);
      }
    }
    R.state.needsUpdate = true;
  };

  /** Events carry nothing heads need. Present for the seam. */
  heads.onEvent = function () {};

  /** @returns {object} Head counts, for tests. */
  heads._counts = function () {
    return { total: R ? R.list.length : 0, near: R ? R.near.length : 0, cap: Q.capacity };
  };

  /** @returns {object[]} Heads in the near list with the state each shows, for tests. */
  heads._near = function () {
    return R ? R.near.map(function (b, i) { return { x: b.x, y: b.y, h: b.h, arm: b.arm, lane: b.lane, shown: R.state.getX(i) }; }) : [];
  };

  /** Frees what this module made. */
  heads.dispose = function () {
    if (!R) return;
    R.scene.remove(R.mesh);
    R.mesh.dispose();
    R.geo.dispose();
    R.mat.dispose();
    R = null;
  };
})(window.TLV);
