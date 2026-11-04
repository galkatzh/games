// js/render/renderer.js — WP-RENDER
// Scene, WebGLRenderer, load phases and frame order. Actor modules are optional, so each side runs without the other.
(function (TLV) {
  'use strict';

  var render = TLV.ns('render');

  var R = null;
  var ACTORS = ['vehicles', 'people', 'signalHeads', 'effects'];
  var scratch = null;

  /** Calls an optional hook. */
  function call(mod, fn, a, b, c, d) {
    if (mod && typeof mod[fn] === 'function') mod[fn](a, b, c, d);
  }

  /**
   * Registers queue handlers and debug hooks. Browser only.
   */
  render.register = function () {
    var reg = TLV.registry;
    reg.on('storefront', TLV.render.storefronts.onDef);
    reg.on('landmark', TLV.render.landmarks.onDef);
    reg.on('style', TLV.render.styles.onStyle);
    reg.on('kit', TLV.render.styles.onKit);
    reg.on('mesh', TLV.render.styles.onMesh);
    reg.on('district', TLV.render.styles.onDistrict);
    reg.on('asset', TLV.render.assets.onAsset);
    reg.on('motorway', TLV.render.ground.onMotorway);
    var dbg = TLV.debug;
    dbg.register('camera', function (mode) {
      if (TLV.render.camera && TLV.render.camera.setMode) TLV.render.camera.setMode(mode);
      return true;
    });
    dbg.register('renderInfo', function () {
      return render.info();
    });
    dbg.register('showLanes', function (on) {
      overlay('lanes', on);
      return !!on;
    });
    dbg.register('showSpots', function (on) {
      overlay('spots', on);
      return !!on;
    });
  };

  /** Debug lines around the focus. */
  function overlay(kind, on) {
    if (!R) return;
    var key = kind === 'lanes' ? 'laneLines' : 'spotLines';
    if (R[key]) {
      R.scene.remove(R[key]);
      R[key].geometry.dispose();
      R[key].material.dispose();
      R[key] = null;
    }
    if (!on) return;
    var S = R.S;
    var W = S.world;
    var fx = S.player ? S.player.fx : 0;
    var fy = S.player ? S.player.fy : 0;
    var pts = [];
    var v = new THREE.Vector3();
    function add(x, y) {
      TLV.render.coords.toThree(x, y, 0.1, v);
      pts.push(v.x, v.y, v.z);
    }
    if (kind === 'lanes') {
      var near = new Int32Array(512);
      var n = TLV.world.lanes.lanesNear(W, fx, fy, 200, near);
      for (var i = 0; i < n; i++) {
        var L = W.lanes[near[i]];
        for (var k = 1; k < L.px.length; k++) {
          add(L.px[k - 1], L.py[k - 1]);
          add(L.px[k], L.py[k]);
        }
      }
    } else {
      var ids = [];
      var c = TLV.world.parking.spotsNear(W, fx, fy, 150, ids);
      for (var q = 0; q < c; q++) {
        var s = TLV.world.parking.spot(W, ids[q]);
        var cs = Math.cos(s.h), sn = Math.sin(s.h);
        var a = s.len / 2, b = s.wid / 2;
        var cx = [a, a, -a, -a], cy = [b, -b, -b, b];
        for (var e = 0; e < 4; e++) {
          var f = (e + 1) % 4;
          add(s.x + cs * cx[e] - sn * cy[e], s.y + sn * cx[e] + cs * cy[e]);
          add(s.x + cs * cx[f] - sn * cy[f], s.y + sn * cx[f] + cs * cy[f]);
        }
      }
    }
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pts), 3));
    var m = new THREE.LineBasicMaterial({ color: kind === 'lanes' ? 0x28d7ff : 0xffe14a, depthTest: false });
    R[key] = new THREE.LineSegments(g, m);
    R[key].renderOrder = 50;
    R[key].frustumCulled = false;
    R.scene.add(R[key]);
  }

  /**
   * Chooses the preset.
   * @param {string} [asked] The quality param: low, med or high, or auto when the player has asked for nothing.
   * @param {string} [gpu] The GPU's name. Only auto reads it.
   * @returns {{name:string, auto:boolean}} The preset, and whether the ladder runs.
   */
  render.pickQuality = function (asked, gpu) {
    if (asked === 'low' || asked === 'med' || asked === 'high') return { name: asked, auto: false };
    return { name: TLV.tune.render.softwareGpu.test(gpu || '') ? 'low' : 'high', auto: true };
  };

  /** @returns {string} The GPU's name, or '' if it will not say. Antialias is fixed once a context exists, so a throwaway one asks first. */
  function gpuName() {
    try {
      var g = document.createElement('canvas').getContext('webgl2');
      if (!g) return '';
      var ext = g.getExtension('WEBGL_debug_renderer_info');
      var name = String(g.getParameter(ext ? ext.UNMASKED_RENDERER_WEBGL : g.RENDERER) || '');
      var lose = g.getExtension('WEBGL_lose_context');
      if (lose) lose.loseContext();
      return name;
    } catch (e) {
      return '';
    }
  }

  /**
   * The resolution ladder. Pure: it reads frame times and answers with a move, so a test can feed it with no GPU. Going down is quick
   * and going up is slow. A display's refresh hides spare time, so a rung up is a trial, and each one that fails doubles the wait.
   */
  render.dynRes = {
    /**
     * @param {number} base Top rung, the pixel ratio the preset asks for.
     * @param {boolean} shadows True if there are shadows left to give up.
     * @returns {object} Ladder on its top rung.
     */
    create: function (base, shadows) {
      var T = TLV.tune.render;
      var fall = Math.min(1, T.dynResMin / base);
      var n = fall < 1 ? Math.ceil(Math.log(fall) / Math.log(T.dynResStep)) : 0;
      var rungs = [base];
      for (var i = 1; i <= n; i++) rungs.push(base * Math.pow(fall, i / n));
      return {
        rungs: rungs, rung: 0, shadows: shadows, t: 0, sum: 0, n: 0, ms: 0, calm: 0, wait: T.dynResUpWaitS, upAt: -1, floorSlow: 0, moves: 0,
        lastMs: 0, flat: 0, heldUntil: 0, hold: T.dynResUpWaitMaxS
      };
    },

    /**
     * One frame.
     * @param {object} L Ladder.
     * @param {number} dtReal Seconds. Zero is not a frame.
     * @returns {?string} 'down', 'up' or 'drop', or null for no move.
     */
    feed: function (L, dtReal) {
      var T = TLV.tune.render;
      if (!(dtReal > 0)) return null;
      var dt = Math.min(dtReal, T.dynResClampS);
      L.t += dt;
      if (L.t < T.dynResGraceS) return null;
      L.sum += dt;
      L.n++;
      L.calm += dt;
      if (L.sum < T.dynResHoldS) return null;
      L.ms = L.sum / L.n * 1000;
      L.sum = 0;
      L.n = 0;
      if (L.upAt >= 0 && L.t - L.upAt >= T.dynResFailS) {
        L.wait = T.dynResUpWaitS;
        L.upAt = -1;
      }
      return L.ms > T.dynResMs ? ladderDown(L, T) : ladderUp(L, T);
    }
  };

  /**
   * Frames that did not move across dynResFlatRungs rungs are not waiting on pixels: a browser saving battery holds them at 30, or the
   * CPU sets the pace. Fewer pixels would buy nothing and the player would pay for them, so the ladder gives them back and stands down.
   * @returns {boolean} True if this window is the one that showed it.
   */
  function framesIgnorePixels(L, T) {
    var clamped = L.ms >= T.dynResClampS * 1000 * (1 - T.dynResFlat);
    L.flat = L.lastMs > 0 && !clamped && Math.abs(L.ms - L.lastMs) < L.lastMs * T.dynResFlat ? L.flat + 1 : 0;
    L.lastMs = 0;
    if (L.flat < T.dynResFlatRungs) return false;
    L.flat = 0;
    L.heldUntil = L.t + L.hold;
    L.hold *= 2;
    return true;
  }

  /** A slow window. */
  function ladderDown(L, T) {
    L.calm = 0;
    if (L.t < L.heldUntil) return null;
    if (framesIgnorePixels(L, T)) {
      L.upAt = -1;
      L.floorSlow = 0;
      L.rung = 0;
      L.moves++;
      return 'up';
    }
    if (L.upAt >= 0) L.wait = Math.min(T.dynResUpWaitMaxS, L.wait * 2);
    L.upAt = -1;
    if (L.rung < L.rungs.length - 1) {
      L.rung++;
      L.lastMs = L.ms;
      L.floorSlow = 0;
      L.moves++;
      return 'down';
    }
    if (!L.shadows || ++L.floorSlow < T.dynResDropWindows) return null;
    L.shadows = false;
    L.moves++;
    return 'drop';
  }

  /** A good window. Cost goes with pixels, so the rung above must be predicted to fit, as well as the wait being over. */
  function ladderUp(L, T) {
    L.floorSlow = 0;
    L.flat = 0;
    L.lastMs = 0;
    if (L.rung === 0 || L.calm < L.wait) return null;
    var grow = L.rungs[L.rung - 1] / L.rungs[L.rung];
    if (L.ms * grow * grow > T.dynResMs * T.dynResRoom) return null;
    L.rung--;
    L.calm = 0;
    L.upAt = L.t;
    L.moves++;
    return 'up';
  }

  /** Spawn point, before the player exists there. */
  function spawnOf(S) {
    var sp = null;
    if (TLV.game && TLV.game.errands && TLV.game.errands.spawnPoint) {
      try {
        sp = TLV.game.errands.spawnPoint(S);
      } catch (e) {
        sp = null;
      }
    }
    if (sp) return { x: sp.x, y: sp.y };
    return { x: S.player ? S.player.fx : 0, y: S.player ? S.player.fy : 0 };
  }

  /**
   * Boot step 5: everything through Phase 2.
   * @param {HTMLCanvasElement} canvas The game canvas.
   * @param {object} S Sim state.
   */
  render.init = function (canvas, S) {
    var T = TLV.tune.render;
    var t0 = window.performance.now();
    scratch = new THREE.Vector3();
    var asked = TLV.params && TLV.params.quality;
    var pick = render.pickQuality(asked, T.quality[asked] ? '' : gpuName());
    var qName = pick.name;
    var Q = T.quality[qName];
    var pixel = Math.min(window.devicePixelRatio || 1, 2) * Q.pixelRatio;
    var gl = new THREE.WebGLRenderer({
      canvas: canvas, antialias: Q.antialias, alpha: false, stencil: false, powerPreference: 'high-performance'
    });
    // three drops to WebGL1 by itself, where this game's shaders do not compile. That draws a city with no buildings or road, and no error.
    if (!gl.capabilities.isWebGL2) {
      gl.dispose();
      throw new Error('Sidurim needs WebGL2, and this browser or graphics driver offers only WebGL1. ' +
        'Update the browser and the graphics driver, or turn hardware acceleration on in the browser settings.');
    }
    gl.setPixelRatio(pixel);
    gl.setSize(window.innerWidth, window.innerHeight);
    gl.toneMapping = THREE.ACESFilmicToneMapping;
    gl.toneMappingExposure = T.exposure;
    gl.shadowMap.enabled = Q.shadow > 0;
    gl.shadowMap.type = THREE.PCFSoftShadowMap;
    gl.info.autoReset = false;

    var scene = new THREE.Scene();
    R = {
      gl: gl, scene: scene, S: S, W: S.world, qName: qName, quality: Q, shadowCalls: 0, mainCalls: 0,
      ladder: pick.auto ? render.dynRes.create(pixel, Q.shadow > 0) : null,
      fallbackCam: null, overrideCam: null, laneLines: null, spotLines: null, w: window.innerWidth, h: window.innerHeight, t: 0,
      initMs: 0, camW: { x: 0, y: 0, z: 0 }, inMain: false, focusX: 0, focusY: 0, viewCam: null, overrideFocus: null
    };

    var tex = TLV.render.city.facades.init();
    TLV.render.sky.init(scene, Q);
    TLV.render.sky.mesh().onBeforeRender = function (r) {
      if (!R.inMain) return;
      R.shadowCalls = r.info.render.calls;
    };
    TLV.render.city.shells.init(tex);
    TLV.render.storefronts.init(S.world);
    TLV.render.landmarks.init(scene, S.world);
    TLV.render.ground.init(scene, S.world);
    TLV.render.city.details.init(scene, S.world);
    TLV.render.city.skyline.init(scene, S.world, tex);
    TLV.render.city.chunks.init(scene, S, Q.l1M);
    var at = spawnOf(S);
    R.focusX = at.x;
    R.focusY = at.y;
    TLV.render.city.chunks.build9(at.x, at.y);
    TLV.render.signs.init(scene, gl, S.world);
    TLV.render.city.details.frame(S, TLV.render.city.chunks.built(), at.x, at.y, true);

    if (TLV.render.camera && TLV.render.camera.init) TLV.render.camera.init(S);
    if (!(TLV.render.camera && TLV.render.camera.object)) {
      R.fallbackCam = new THREE.PerspectiveCamera(62, R.w / Math.max(1, R.h), T.cameraNear, T.cameraFar);
    }
    ACTORS.forEach(function (m) { call(TLV.render[m], 'init', scene, S); });
    call(TLV.render.rearview, 'init', scene, S);
    R.initMs = window.performance.now() - t0;
  };

  /** The camera this frame renders with. */
  function activeCamera() {
    if (R.overrideCam) return R.overrideCam;
    if (TLV.render.camera && TLV.render.camera.object) return TLV.render.camera.object;
    return R.fallbackCam;
  }

  /** Chase view for the fallback camera, for when camera.js is absent. */
  function followFallback(S) {
    var v = S.vehicles && S.vehicles[0];
    if (!v) return;
    var c = R.fallbackCam;
    var d = 6.5;
    TLV.render.coords.toThree(v.x - Math.cos(v.h) * d, v.y - Math.sin(v.h) * d, 2.6, c.position);
    TLV.render.coords.toThree(v.x + Math.cos(v.h) * 3, v.y + Math.sin(v.h) * 3, 1, scratch);
    c.lookAt(scratch);
  }

  /** What is left of the low preset once the pixels run out. Antialias is fixed with the context. One way: it recompiles every material. */
  function dropToLow() {
    var low = TLV.tune.render.quality.low;
    var sun = TLV.render.sky.light();
    sun.castShadow = false;
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
      sun.shadow.map = null;
    }
    R.gl.shadowMap.enabled = false;
    TLV.render.city.chunks.setL1(low.l1M);
    R.qName = 'low';
    R.quality = low;
  }

  /** Follows the ladder. Auto quality only. Runs before the draw: a resize clears the canvas, so after it the player would see a blank frame. */
  function dynamicResolution(dtReal) {
    if (!R.ladder) return;
    var move = render.dynRes.feed(R.ladder, dtReal);
    if (move === 'drop') dropToLow();
    else if (move) R.gl.setPixelRatio(R.ladder.rungs[R.ladder.rung]);
  }

  /**
   * One frame, in the binding order.
   * @param {object} S Sim state.
   * @param {number} alpha Interpolation 0..1.
   * @param {number} dtReal Seconds.
   */
  render.frame = function (S, alpha, dtReal) {
    if (!R) return;
    dynamicResolution(dtReal);
    var gl = R.gl;
    gl.info.reset();
    R.t += dtReal;
    if (TLV.render.camera && TLV.render.camera.frame) TLV.render.camera.frame(S, alpha, dtReal);
    else if (R.fallbackCam) followFallback(S);
    var cam = activeCamera();

    for (var i = 0; i < ACTORS.length; i++) call(TLV.render[ACTORS[i]], 'frame', S, alpha, dtReal, cam);

    var fx = S.player ? S.player.fx : R.focusX;
    var fy = S.player ? S.player.fy : R.focusY;
    if (R.overrideCam) {
      fx = R.overrideFocus.x;
      fy = R.overrideFocus.y;
    }
    R.focusX = fx;
    R.focusY = fy;
    var cw = TLV.render.coords.fromThree(cam.position, R.camW);
    TLV.render.city.chunks.frame(fx, fy, cw.x, cw.y);
    TLV.render.city.details.frame(S, TLV.render.city.chunks.built(), fx, fy);
    TLV.render.signs.frame(fx, fy);
    TLV.render.storefronts.frame(S.world, fx, fy);
    TLV.render.landmarks.frame(fx, fy);
    TLV.render.city.facades.frame();

    drawMain(cam);
    call(TLV.render.rearview, 'frame', S, alpha, dtReal, cam);
  };

  /** Renders the scene with the main camera, recording the shadow pass's share of the draw calls. */
  function drawMain(cam) {
    var gl = R.gl;
    var fx = R.focusX;
    var fy = R.focusY;
    TLV.render.sky.frame(cam, fx, fy, R.t);
    var f = TLV.render.city.shells.focusU.value;
    if (f) f.set(fx, -fy);
    gl.shadowMap.autoUpdate = true;
    R.inMain = true;
    gl.setRenderTarget(null);
    gl.setViewport(0, 0, R.w, R.h);
    gl.setScissorTest(false);
    gl.render(R.scene, cam);
    R.inMain = false;
    R.mainCalls = gl.info.render.calls - R.shadowCalls;
  }

  /**
   * Renders the same scene with another camera, into part of the canvas. The rear-view strip calls this.
   * @param {object} camera THREE.Camera.
   * @param {{x:number,y:number,w:number,h:number}} viewport CSS pixels, y from the top.
   */
  render.renderScene = function (camera, viewport) {
    if (!R) return;
    var gl = R.gl;
    var y = R.h - viewport.y - viewport.h;
    gl.shadowMap.autoUpdate = false;
    TLV.render.sky.fit(camera);
    TLV.render.city.details.rearMode(true);
    TLV.render.city.chunks.rearMode(true, camera);
    TLV.render.city.skyline.hide(true);
    gl.setViewport(viewport.x, y, viewport.w, viewport.h);
    gl.setScissor(viewport.x, y, viewport.w, viewport.h);
    gl.setScissorTest(true);
    gl.autoClear = false;
    gl.clearDepth();
    gl.render(R.scene, camera);
    gl.autoClear = true;
    gl.setScissorTest(false);
    gl.setViewport(0, 0, R.w, R.h);
    gl.shadowMap.autoUpdate = true;
    TLV.render.city.details.rearMode(false);
    TLV.render.city.chunks.rearMode(false);
    TLV.render.city.skyline.hide(false);
  };

  /**
   * Forwards a drained event to the actor modules. TLV.ui.frame calls this.
   * @param {string} name Event name.
   * @param {object} payload Event payload.
   */
  render.onEvent = function (name, payload) {
    ACTORS.forEach(function (m) { call(TLV.render[m], 'onEvent', name, payload); });
    call(TLV.render.rearview, 'onEvent', name, payload);
    call(TLV.render.camera, 'onEvent', name, payload);
  };

  /**
   * Resizes the canvas.
   * @param {number} w CSS pixels.
   * @param {number} h CSS pixels.
   */
  render.resize = function (w, h) {
    if (!R) return;
    R.w = w;
    R.h = h;
    R.gl.setSize(w, h);
    var cam = activeCamera();
    if (cam && cam.isPerspectiveCamera) {
      cam.aspect = w / Math.max(1, h);
      cam.updateProjectionMatrix();
    }
  };

  /** Tears everything down. render.init can run again afterwards. */
  render.dispose = function () {
    if (!R) return;
    ACTORS.forEach(function (m) { call(TLV.render[m], 'dispose'); });
    call(TLV.render.rearview, 'dispose');
    call(TLV.render.camera, 'dispose');
    overlay('lanes', false);
    overlay('spots', false);
    TLV.render.signs.dispose();
    TLV.render.city.chunks.dispose();
    TLV.render.city.skyline.dispose();
    TLV.render.city.details.dispose();
    TLV.render.landmarks.dispose();
    TLV.render.ground.dispose();
    TLV.render.city.shells.dispose();
    TLV.render.sky.dispose();
    TLV.render.city.facades.dispose();
    R.gl.dispose();
    R = null;
  };

  /**
   * World point to CSS pixels, for UI bubbles.
   * @param {number} x World x.
   * @param {number} y World y.
   * @param {number} z Height.
   * @param {{sx:number,sy:number,visible:boolean}} out Receives the answer.
   * @returns {object} out.
   */
  render.project = function (x, y, z, out) {
    if (!R) {
      out.visible = false;
      return out;
    }
    var v = TLV.render.coords.toThree(x, y, z, scratch);
    var cam = activeCamera();
    v.project(cam);
    out.sx = (v.x + 1) / 2 * R.w;
    out.sy = (1 - v.y) / 2 * R.h;
    out.visible = v.z > -1 && v.z < 1 && Math.abs(v.x) <= 1 && Math.abs(v.y) <= 1;
    return out;
  };

  /**
   * Draw counts of the last frame, in budget terms.
   * @returns {object} { calls, triangles, textures, geometries, chunksBuilt, chunksTotal, quality, plus detail }.
   */
  render.info = function () {
    if (!R) return { calls: 0, triangles: 0, textures: 0, geometries: 0, chunksBuilt: 0, chunksTotal: 0, quality: 'none' };
    var I = R.gl.info;
    var st = TLV.render.city.chunks.stats();
    var sg = TLV.render.signs.info();
    return {
      calls: I.render.calls,
      triangles: I.render.triangles,
      textures: I.memory.textures,
      geometries: I.memory.geometries,
      chunksBuilt: st.built,
      chunksTotal: st.total,
      quality: R.qName,
      mainCalls: R.mainCalls,
      shadowCalls: R.shadowCalls,
      bakes: sg.bakes,
      signs: sg.signs,
      photos: sg.photos,
      buildMs: st.lastMs,
      chunkVertexMB: st.residentBytes / 1048576,
      pixelRatio: R.gl.getPixelRatio(),
      auto: !!R.ladder,
      rung: R.ladder ? R.ladder.rung : 0,
      rungs: R.ladder ? R.ladder.rungs.length : 1,
      initMs: R.initMs,
      facadeLayers: TLV.render.city.facades.used(),
      skyline: TLV.render.city.skyline.count || 0,
      details: TLV.render.city.details.counts()
    };
  };

  /**
   * Test hook: renders from a fixed view, ignoring the game camera. Null hands the view back.
   * @param {?{x:number,y:number,z:number,lookX:number,lookY:number,lookZ:number,fov?:number,focusX?:number,focusY?:number}} view World view.
   */
  render.setView = function (view) {
    if (!R) return;
    if (!view) {
      R.overrideCam = null;
      return;
    }
    var T = TLV.tune.render;
    if (!R.viewCam) R.viewCam = new THREE.PerspectiveCamera(60, R.w / Math.max(1, R.h), T.cameraNear, T.cameraFar);
    var c = R.viewCam;
    c.fov = view.fov || 60;
    c.updateProjectionMatrix();
    TLV.render.coords.toThree(view.x, view.y, view.z, c.position);
    TLV.render.coords.toThree(view.lookX, view.lookY, view.lookZ, scratch);
    c.up.set(0, 1, 0);
    c.lookAt(scratch);
    c.updateMatrixWorld();
    R.overrideCam = c;
    R.overrideFocus = { x: view.focusX === undefined ? view.x : view.focusX, y: view.focusY === undefined ? view.y : view.focusY };
    R.focusX = R.overrideFocus.x;
    R.focusY = R.overrideFocus.y;
    TLV.render.city.chunks.buildAround(R.overrideFocus.x, R.overrideFocus.y, view.buildR || T.l1M + 100);
    TLV.render.city.details.frame(R.S, TLV.render.city.chunks.built(), R.focusX, R.focusY, true);
    TLV.render.signs.settle(R.focusX, R.focusY);
  };

  /**
   * Test hook: draws one frame now, with no sim step.
   * @returns {object} info() after it.
   */
  render.drawNow = function () {
    if (!R) return null;
    render.frame(R.S, 1, 0);
    return render.info();
  };

  /**
   * Test hook: hands the ladder frame times, with no draw, so it can be walked on any GPU. The next real frame shows the result.
   * @param {number} dtReal Seconds.
   * @param {number} [n] How many frames.
   */
  render.feedFrames = function (dtReal, n) {
    if (!R) return;
    for (var i = 0; i < (n || 1); i++) dynamicResolution(dtReal);
  };

  /** Test hook. @returns {?object} The ladder, null when the player asked for a quality. */
  render.ladder = function () {
    return R ? R.ladder : null;
  };

  /** Test hook. @returns {?object} The WebGLRenderer. */
  render.gl = function () {
    return R ? R.gl : null;
  };

  /** Test hook. @returns {?object} The scene. */
  render.scene = function () {
    return R ? R.scene : null;
  };
})(window.TLV);
