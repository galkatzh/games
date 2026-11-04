// js/render/signs.js — WP-RENDER
// Shop signs: real names on the right facades, text baked into the atlas, at most 4 bakes a frame (section 15.3).
// Hebrew is drawn with canvas direction rtl, so the browser's bidi does the order; nothing here reverses a string.
(function (TLV) {
  'use strict';

  var signs = TLV.ns('render.signs');

  var FONT = "'Arial Hebrew','Noto Sans Hebrew',Arial,sans-serif";
  var HEBREW = /[֐-׿]/;
  var UP = 6;              // Refresh the list every this many frames

  var sceneRef = null;
  var signAtlas = null;
  var photoAtlas = null;
  var signPool = null;
  var photoPool = null;
  var material = null;
  var photoMaterial = null;
  var pending = [];
  var bakedThisFrame = 0;
  var bakesTotal = 0;
  var frameNo = 0;
  var world = null;
  var places = new Map();
  var near = new Int32Array(1024);
  var order = [];
  var canvasRef = null;
  var restored = false;

  /** Three has already taken the new context when this runs. The frame does the work, because a bake needs the frame's own limit. */
  function onRestored() {
    restored = true;
  }

  /** @returns {?object} Where a POI's sign hangs, or null. */
  function placeOf(p) {
    var got = places.get(p.id);
    if (got !== undefined) return got;
    var out = null;
    var W = world;
    var F = TLV.const.POIF;
    if (p.bld >= 0 && p.wall >= 0 && !(p.flags & F.NO_FACADE) && !((p.flags & F.SENSITIVE) && !(p.flags & F.NAMED))) {
      var b = W.blds[p.bld];
      var r = b.rings[0];
      var n = r.length >> 1;
      var i = p.wall % n;
      var k = (i + 1) % n;
      var ax = r[i * 2], ay = r[i * 2 + 1], bx = r[k * 2], by = r[k * 2 + 1];
      var dx = bx - ax, dy = by - ay;
      var len = Math.sqrt(dx * dx + dy * dy);
      if (len > 0.5) {
        var nx = dy / len, ny = -dx / len;
        var hh = TLV.render.city.recipes.heights(W, b);
        var w = Math.min(Math.max(1.6, p.w * 0.86), Math.max(1.6, len * 0.92));
        var h = Math.max(0.62, Math.min(0.95, w / 5));
        var wx = ax + dx * p.t, wy = ay + dy * p.t;
        if (hh.form !== 'canopy') {
          var z = hh.form === 'lifted' ? hh.base + 0.8 : TLV.tune.render.groundM - 0.44;
          out = {
            x: wx + nx * 0.14, y: wy + ny * 0.14, z: z, yaw: Math.atan2(ny, nx), w: w, h: h,
            door: p.flags & F.INTERIOR ? 'd:' + p.bld + ':' + p.wall : null
          };
        }
      }
    }
    places.set(p.id, out);
    return out;
  }

  /** Writes a word that shrinks to fit, in the virtual width. */
  function fit(ctx, text, y, size, weight, vw, rtl, colour) {
    ctx.direction = rtl ? 'rtl' : 'ltr';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = colour;
    var px = size;
    ctx.font = weight + ' ' + px + 'px ' + FONT;
    var w = ctx.measureText(text).width;
    if (w > vw) {
      px = Math.max(10, Math.floor(px * vw / w));
      ctx.font = weight + ' ' + px + 'px ' + FONT;
    }
    ctx.fillText(text, 0, y);
  }

  /**
   * Paints a board. The slot is 4:1 and the board is wider, so the text is drawn squeezed and comes back square.
   * @param {CanvasRenderingContext2D} ctx Slot canvas.
   * @param {number} W2 Slot width.
   * @param {number} H2 Slot height.
   * @param {{he:string,en:string,seed:number,aspect:number,board?:string[]}} s Sign.
   */
  signs.paintBoard = function (ctx, W2, H2, s) {
    var T = TLV.tune.render;
    var pal = s.board || T.signBoards[s.seed % T.signBoards.length];
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = pal[0];
    ctx.fillRect(0, 0, W2, H2);
    ctx.fillStyle = 'rgba(255,255,255,0.14)';
    ctx.fillRect(0, 0, W2, 4);
    ctx.fillStyle = 'rgba(0,0,0,0.2)';
    ctx.fillRect(0, H2 - 4, W2, 4);
    var k = (W2 / H2) / Math.max(1, s.aspect);
    var vw = (W2 - 18) / k;
    ctx.setTransform(k, 0, 0, 1, W2 / 2, 0);
    var he = s.he;
    var en = s.en;
    var ink = pal[1];
    if (he && en && he !== en) {
      fit(ctx, he, 22, 34, 'bold', vw, HEBREW.test(he), ink);
      fit(ctx, en, 50, 19, '600', vw, HEBREW.test(en), ink);
    } else {
      var one = he || en || '';
      fit(ctx, one, 32, 38, 'bold', vw, HEBREW.test(one), ink);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  };

  /** A sign.board provider may set a POI's colours. @returns {?string[]} Background and ink, or null for the default. */
  function boardOf(p) {
    var list = TLV.render.styles.kit('sign.board');
    for (var i = 0; i < list.length; i++) {
      if (typeof list[i].board !== 'function') continue;
      try {
        var b = list[i].board(p);
        if (b) return b;
      } catch (e) {
        TLV.registry.problem('kit', list[i].id, 'provider threw: ' + (e && e.message));
      }
    }
    return null;
  }

  /** Bakes a sign into the atlas. */
  function bake(item, last) {
    var slot = signAtlas.claim(item.key);
    signs.paintBoard(signAtlas.ctx, signAtlas.slotW, signAtlas.slotH, item);
    signAtlas.commit(slot, last);
    bakesTotal++;
  }

  /** Bakes a photo into its atlas. */
  function bakePhoto(item, last) {
    var slot = photoAtlas.claim(item.key);
    var a = photoAtlas;
    a.ctx.setTransform(1, 0, 0, 1, 0, 0);
    a.ctx.drawImage(item.photo, 0, 0, a.slotW, a.slotH);
    a.commit(slot, last);
    bakesTotal++;
  }

  /** A plane in the YZ plane facing +X, u running to the viewer's right. Width along Z, height along Y. */
  function planeGeometry() {
    var g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, -0.5, 0.5, 0, -0.5, -0.5, 0, 0.5, -0.5, 0, 0.5, 0.5]), 3));
    g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array([1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0, 0]), 3));
    g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
    g.setIndex([0, 1, 2, 0, 2, 3]);
    return g;
  }

  function makeMaterial(map, key) {
    var m = new THREE.MeshLambertMaterial({ map: map });
    m.onBeforeCompile = function (shader) {
      TLV.render.sky.patch(shader);
      shader.vertexShader = 'attribute vec4 aRect;\n' + shader.vertexShader.replace('#include <uv_vertex>', [
        '#include <uv_vertex>',
        'vMapUv = vec2(mix(aRect.x, aRect.z, uv.x), mix(aRect.w, aRect.y, uv.y));'
      ].join('\n'));
      shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', [
        '#include <emissivemap_fragment>',
        'totalEmissiveRadiance += diffuseColor.rgb * 0.22;'
      ].join('\n'));
    };
    m.customProgramCacheKey = function () { return key; };
    return m;
  }

  function makePool(cap, mat) {
    var inst = new THREE.InstancedMesh(planeGeometry(), mat, cap);
    inst.count = 0;
    inst.frustumCulled = false;
    inst.matrixAutoUpdate = false;
    inst.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    var rect = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4);
    rect.setUsage(THREE.DynamicDrawUsage);
    inst.geometry.setAttribute('aRect', rect);
    sceneRef.add(inst);
    return inst;
  }

  /**
   * Creates the atlases and pools.
   * @param {object} scene THREE.Scene.
   * @param {object} renderer THREE.WebGLRenderer.
   * @param {object} W World.
   */
  signs.init = function (scene, renderer, W) {
    var T = TLV.tune.render;
    sceneRef = scene;
    world = W;
    places = new Map();
    pending = [];
    bakesTotal = 0;
    frameNo = 0;
    signAtlas = new TLV.render.atlas.AtlasSlots(renderer, { size: T.atlasSize, slotW: T.signSlotW, slotH: T.signSlotH, mips: true });
    photoAtlas = new TLV.render.atlas.AtlasSlots(renderer, { size: T.atlasSize, slotW: T.photoSlotW, slotH: T.photoSlotH, mips: false });
    material = makeMaterial(signAtlas.tex, 'tlv-sign');
    photoMaterial = makeMaterial(photoAtlas.tex, 'tlv-photo');
    signPool = makePool(T.pools.sign, material);
    photoPool = makePool(T.pools.photo, photoMaterial);
    canvasRef = renderer.domElement;
    canvasRef.addEventListener('webglcontextrestored', onRestored);
  };

  /** Writes a board's matrix: rotation.y = yaw, width on local Z, height on local Y. */
  function writeBoard(a, o, x, y, z, yaw, w, h) {
    var c = Math.cos(yaw), n = Math.sin(yaw);
    a[o] = c; a[o + 1] = 0; a[o + 2] = -n; a[o + 3] = 0;
    a[o + 4] = 0; a[o + 5] = h; a[o + 6] = 0; a[o + 7] = 0;
    a[o + 8] = n * w; a[o + 9] = 0; a[o + 10] = c * w; a[o + 11] = 0;
    TLV.render.coords.write(a, o + 12, x, y, z);
    a[o + 15] = 1;
  }

  /** Rebuilds the visible list around the focus. */
  function refresh(fx, fy) {
    var T = TLV.tune.render;
    var W = world;
    var ST = TLV.render.storefronts;
    var count = TLV.world.spatial.poisNear(W, fx, fy, T.signM, near);
    order.length = 0;
    var seen = new Set();
    for (var i = 0; i < count; i++) {
      var p = W.pois[near[i]];
      var pl = placeOf(p);
      if (!pl) continue;
      if (pl.door) {
        if (seen.has(pl.door)) continue;
        seen.add(pl.door);
      }
      var dx = pl.x - fx, dy = pl.y - fy;
      order.push({ p: p, pl: pl, d: dx * dx + dy * dy });
    }
    order.sort(function (a, b) { return a.d - b.d; });

    var sm = signPool.instanceMatrix.array;
    var sr = signPool.geometry.attributes.aRect.array;
    var pm = photoPool.instanceMatrix.array;
    var pr = photoPool.geometry.attributes.aRect.array;
    var ns = 0;
    var np = 0;
    var capS = T.pools.sign;
    var capP = T.pools.photo;
    var portal = TLV.render.city.chunks.portals || [];
    var nearPortals = [];
    for (var q = 0; q < portal.length; q++) {
      var P = portal[q];
      var ex = P.x - fx, ey = P.y - fy;
      if (ex * ex + ey * ey < T.barrierM * T.barrierM) nearPortals.push(P);
    }
    for (var b = 0; b < nearPortals.length && ns < capS; b++) {
      var P2 = nearPortals[b];
      var ks = signAtlas.find('portal');
      if (ks < 0) {
        pending.push({ key: 'portal', he: T.closedText.he, en: T.closedText.en, seed: 7, aspect: 3.4, board: ['#c6281f', '#ffffff'] });
        ks = 0;
      }
      writeBoard(sm, ns * 16, P2.x, P2.y, 1.75, Math.atan2(P2.ny, P2.nx), 3.1, 0.92);
      signAtlas.rect(ks, sr, ns * 4);
      ns++;
    }
    for (var k = 0; k < order.length; k++) {
      var it = order[k];
      var res = ST.resolve(it.p);
      if (res.rung >= ST.RUNG.BLANK) continue;
      if (res.photo) {
        if (np >= capP) continue;
        var slotP = photoAtlas.find(res.key);
        if (slotP < 0) {
          pending.push({ key: res.key, photo: res.photo });
          continue;
        }
        var ph = 2.9;
        writeBoard(pm, np * 16, it.pl.x, it.pl.y, ph / 2 + 0.1, it.pl.yaw, Math.max(it.pl.w, 2.2), ph);
        photoAtlas.rect(slotP, pr, np * 4);
        np++;
        continue;
      }
      if (ns >= capS) continue;
      var key = 's:' + it.p.id + ':' + res.rung;
      var slot = signAtlas.find(key);
      if (slot < 0) {
        pending.push({
          key: key, he: res.he, en: res.en, seed: (it.p.osm % 8 + 8) % 8, aspect: it.pl.w / it.pl.h, d: it.d, board: boardOf(it.p)
        });
        continue;
      }
      writeBoard(sm, ns * 16, it.pl.x, it.pl.y, it.pl.z, it.pl.yaw, it.pl.w, it.pl.h);
      signAtlas.rect(slot, sr, ns * 4);
      ns++;
    }
    signPool.count = ns;
    signPool.instanceMatrix.needsUpdate = true;
    signPool.geometry.attributes.aRect.needsUpdate = true;
    photoPool.count = np;
    photoPool.instanceMatrix.needsUpdate = true;
    photoPool.geometry.attributes.aRect.needsUpdate = true;
  }

  /**
   * Per frame: refreshes the list and bakes up to the limit.
   * @param {number} fx Focus x.
   * @param {number} fy Focus y.
   * @param {boolean} [force] Refresh now.
   */
  signs.frame = function (fx, fy, force) {
    var T = TLV.tune.render;
    frameNo++;
    bakedThisFrame = 0;
    if (restored) {
      // Nothing is left on the GPU. A board with no bake is not drawn, so none shows black while they come back, 4 a frame.
      restored = false;
      signAtlas.reset();
      photoAtlas.reset();
      signPool.count = 0;
      photoPool.count = 0;
      force = true;
    }
    if (force || frameNo % UP === 0) {
      pending.length = 0;
      refresh(fx, fy);
    }
    var seen = new Set();
    var todo = pending.filter(function (it) {
      if (seen.has(it.key)) return false;
      seen.add(it.key);
      return true;
    }).slice(0, T.bakesPerFrame);
    for (var i = 0; i < todo.length; i++) {
      var last = i === todo.length - 1;
      if (todo[i].photo) bakePhoto(todo[i], true);
      else bake(todo[i], last);
      bakedThisFrame++;
    }
    pending.length = 0;
    if (todo.length) {
      refresh(fx, fy);
      pending.length = 0;
    }
  };

  /** Bakes everything in range at once, for screenshots. */
  signs.settle = function (fx, fy) {
    for (var i = 0; i < 64; i++) {
      signs.frame(fx, fy, true);
      if (!bakedThisFrame) break;
    }
    pending.length = 0;
  };

  /** @returns {{bakes:number, total:number, signs:number, photos:number}} Counters. */
  signs.info = function () {
    return { bakes: bakedThisFrame, total: bakesTotal, signs: signPool ? signPool.count : 0, photos: photoPool ? photoPool.count : 0 };
  };

  /** @returns {object} The sign atlas, for the orientation test. */
  signs.atlas = function () {
    return signAtlas;
  };

  /** Frees everything. */
  signs.dispose = function () {
    if (!sceneRef) return;
    canvasRef.removeEventListener('webglcontextrestored', onRestored);
    canvasRef = null;
    restored = false;
    [signPool, photoPool].forEach(function (p) {
      sceneRef.remove(p);
      p.geometry.dispose();
      p.dispose();
    });
    material.dispose();
    photoMaterial.dispose();
    signAtlas.dispose();
    photoAtlas.dispose();
    sceneRef = signAtlas = photoAtlas = signPool = photoPool = material = photoMaterial = world = null;
    places = new Map();
  };
})(window.TLV);
