// js/render/landmarks.js — WP-RENDER
// The landmark registry (section 14.4). Ladder: packed model, style on the OSM footprint, default building.
// Visual replacement never changes collision.
(function (TLV) {
  'use strict';

  var landmarks = TLV.ns('render.landmarks');

  var defs = [];
  var styleBy = new Map();
  var replaceBy = new Map();
  var liveModels = [];
  var hidden = new Set();
  var onSky = new Set();
  var sceneRef = null;
  var worldRef = null;

  /**
   * Handles a landmark item.
   * @param {object} def Section 14.4.
   */
  landmarks.onDef = function (def) {
    var id = def && def.id;
    if (typeof id !== 'string' || !id) return TLV.registry.problem('landmark', id, 'landmark needs an id');
    if (!def.anchor) return TLV.registry.problem('landmark', id, 'landmark needs an anchor');
    if (['restyle', 'replace', 'add'].indexOf(def.mode) < 0) return TLV.registry.problem('landmark', id, 'unknown mode ' + def.mode);
    if (def.model && !def.credit) return TLV.registry.problem('landmark', id, 'a model needs credit');
    defs.push(def);
  };

  /**
   * Binds anchors to rows. `ids` carries every row: one relation can hold several (r15311025 has 4).
   * @param {object} scene THREE.Scene.
   * @param {object} W World.
   */
  landmarks.init = function (scene, W) {
    sceneRef = scene;
    worldRef = W;
    styleBy = new Map();
    replaceBy = new Map();
    hidden = new Set();
    onSky = new Set();
    liveModels = [];
    for (var i = 0; i < defs.length; i++) {
      var d = defs[i];
      var r = TLV.anchors.resolve(W, d.anchor, { type: 'building' });
      var ids = r.ids;
      var rec = { def: d, ids: ids, x: 0, y: 0, mesh: null };
      if (ids.length) {
        rec.x = W.blds[ids[0]].cx;
        rec.y = W.blds[ids[0]].cy;
      } else if (d.mode === 'add' && d.anchor.at) {
        var p = TLV.anchors.project(d.anchor.at[0], d.anchor.at[1], W.meta.origin);
        rec.x = p.x;
        rec.y = p.y;
      } else {
        continue;
      }
      for (var k = 0; k < ids.length; k++) {
        if (d.style) styleBy.set(ids[k], d.style);
        if (d.mode === 'replace') replaceBy.set(ids[k], rec);
        if (d.skyline) onSky.add(ids[k]);
      }
      if (d.model) liveModels.push(rec);
    }
  };

  /** @returns {?string} The style a landmark sets on a row. */
  landmarks.styleFor = function (id) {
    return styleBy.get(id) || null;
  };

  /** @returns {boolean} True once a loaded model stands in for this row. */
  landmarks.hidesShell = function (id) {
    return hidden.has(id);
  };

  /** @returns {boolean} True for a row a landmark puts on the skyline whatever its height. */
  landmarks.onSkyline = function (id) {
    return onSky.has(id);
  };

  /** Places a loaded model. */
  function place(rec) {
    var A = TLV.render.assets;
    var F = TLV.render.meshFormat;
    var mesh = A.mesh(rec.def.model.asset);
    var mat = new THREE.MeshLambertMaterial({ color: 0xffffff });
    if (mesh.texture) {
      var t = new THREE.TextureLoader().load(mesh.texture);
      t.colorSpace = THREE.SRGBColorSpace;
      mat.map = t;
    }
    mat.onBeforeCompile = function (shader) {
      TLV.render.sky.patch(shader);
    };
    var m = new THREE.Mesh(F.geometry(mesh), mat);
    TLV.render.coords.toThree(rec.x, rec.y, 0, m.position);
    m.rotation.y = TLV.render.coords.yaw((rec.def.model.yawDeg || 0) * Math.PI / 180);
    m.scale.setScalar(rec.def.model.scale || 1);
    m.castShadow = true;
    sceneRef.add(m);
    rec.mesh = m;
    for (var i = 0; i < rec.ids.length; i++) {
      if (rec.def.mode === 'replace') {
        hidden.add(rec.ids[i]);
        var b = worldRef.blds[rec.ids[i]];
        TLV.render.city.chunks.invalidate(b.cx, b.cy);
      }
    }
  }

  /**
   * Loads models near the focus and places them when ready. Phase 4.
   * @param {number} fx Focus x.
   * @param {number} fy Focus y.
   */
  landmarks.frame = function (fx, fy) {
    var R = TLV.tune.render.landmarkLoadM;
    var A = TLV.render.assets;
    for (var i = 0; i < liveModels.length; i++) {
      var rec = liveModels[i];
      if (rec.mesh) continue;
      var dx = rec.x - fx, dy = rec.y - fy;
      if (dx * dx + dy * dy > R * R) continue;
      if (A.request(rec.def.model.asset) === 'ready') place(rec);
    }
  };

  /** @returns {object[]} Model records, for tests. */
  landmarks.models = function () {
    return liveModels.map(function (r) {
      return { id: r.def.id, ready: !!r.mesh, asset: r.def.model.asset };
    });
  };

  /** Frees placed models. Definitions stay, so a later init binds them again. */
  landmarks.dispose = function () {
    liveModels.forEach(function (r) {
      if (!r.mesh) return;
      sceneRef.remove(r.mesh);
      r.mesh.geometry.dispose();
      if (r.mesh.material.map) r.mesh.material.map.dispose();
      r.mesh.material.dispose();
      r.mesh = null;
    });
    hidden = new Set();
    liveModels = [];
    sceneRef = worldRef = null;
  };
})(window.TLV);
