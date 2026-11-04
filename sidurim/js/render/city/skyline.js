// js/render/city/skyline.js — WP-RENDER
// L2: one mesh of every building at least 30 m tall, so Azrieli stays a navigation aid across the map (section 15.3).
(function (TLV) {
  'use strict';

  var skyline = TLV.ns('render.city.skyline');

  var mesh = null;
  var mat = null;
  var sceneRef = null;

  /**
   * Builds the mesh. Phase 2.
   * @param {object} scene THREE.Scene.
   * @param {object} W World.
   * @param {object} tex Facade array.
   */
  skyline.init = function (scene, W, tex) {
    var T = TLV.tune.render;
    var S = TLV.render.city.shells;
    var R = TLV.render.city.recipes;
    var buf = new S.SBuf(16384);
    var count = 0;
    var spans = [];
    for (var i = 0; i < W.blds.length; i++) {
      var b = W.blds[i];
      if (R.heights(W, b).top < T.skylineMinH && !TLV.render.landmarks.onSkyline(i)) continue;
      var first = buf.nv;
      S.add(buf, W, R.building(W, i, TLV.render.styles.choose(W, i)), { simple: true, inset: 0.4 });
      spans.push(first, buf.nv, b.cx, b.cy);
      count++;
    }
    sceneRef = scene;
    skyline.count = count;
    var geo = S.geometry(buf);
    if (!geo) return;
    // Whole buildings collapse together, so a row never tears across the radius.
    var centre = new Float32Array(buf.nv * 2);
    var at = { x: 0, y: 0, z: 0 };
    for (var k = 0; k < spans.length; k += 4) {
      TLV.render.coords.toThree(spans[k + 2], spans[k + 3], 0, at);
      for (var v = spans[k]; v < spans[k + 1]; v++) {
        centre[v * 2] = at.x;
        centre[v * 2 + 1] = at.z;
      }
    }
    geo.setAttribute('aCentre', new THREE.BufferAttribute(centre, 2));
    mat = S.makeMaterial(tex, { skyline: true });
    mesh = new THREE.Mesh(geo, mat);
    mesh.frustumCulled = false;
    mesh.matrixAutoUpdate = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    scene.add(mesh);
  };

  /**
   * Hides the skyline copy of everything the shells are sure to cover.
   * @param {number} radiusM Radius in which every chunk is built and shown, 0 for none.
   */
  skyline.frame = function (radiusM) {
    if (mat) mat.userData.collapse.value = radiusM;
  };

  /** Hides the mesh for one pass. */
  skyline.hide = function (on) {
    if (mesh) mesh.visible = !on;
  };

  /** Frees the mesh. */
  skyline.dispose = function () {
    if (mesh) {
      sceneRef.remove(mesh);
      mesh.geometry.dispose();
      mat.dispose();
    }
    mesh = mat = sceneRef = null;
  };
})(window.TLV);
