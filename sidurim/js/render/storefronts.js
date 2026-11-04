// js/render/storefronts.js — WP-RENDER
// The storefront registry and its fallback ladder (section 14.3): loaded photo, curated sign, OSM sign, kind label, blank
// shopfront, plain wall. Every rung always renders.
(function (TLV) {
  'use strict';

  var storefronts = TLV.ns('render.storefronts');

  var defs = [];
  var byPoi = new Map();
  var forced = null;

  /** Ladder rungs. */
  var RUNG = storefronts.RUNG = { PHOTO: 0, CURATED: 1, OSM: 2, KIND: 3, BLANK: 4, PLAIN: 5 };

  /**
   * Handles a storefront item.
   * @param {object} def Section 14.3.
   */
  storefronts.onDef = function (def) {
    var id = def && def.id;
    if (typeof id !== 'string' || !id) return TLV.registry.problem('storefront', id, 'storefront needs an id');
    if (!def.anchor) return TLV.registry.problem('storefront', id, 'storefront needs an anchor');
    for (var i = 0; i < defs.length; i++) {
      if (defs[i].id === id) return TLV.registry.problem('storefront', id, 'duplicate id');
    }
    if (def.art && (!def.credit || !def.attest)) return TLV.registry.problem('storefront', id, 'art needs credit and attest');
    defs.push(def);
  };

  /**
   * Binds anchors to POIs. An orphan is skipped, never an error.
   * @param {object} W World.
   */
  storefronts.init = function (W) {
    byPoi = new Map();
    for (var i = 0; i < defs.length; i++) {
      var r = TLV.anchors.resolve(W, defs[i].anchor, { type: 'poi' });
      if (r.how !== 'orphan') byPoi.set(r.id, defs[i]);
    }
  };

  /** @returns {?object} The storefront bound to a POI. */
  storefronts.forPoi = function (poiId) {
    return byPoi.get(poiId) || null;
  };

  /**
   * Starts every rung from this one down, for tests. Null restores the ladder.
   * @param {?number} rung A RUNG value.
   */
  storefronts.force = function (rung) {
    forced = rung;
  };

  /** @returns {?number} The forced rung. */
  storefronts.forced = function () {
    return forced;
  };

  /**
   * Which rung a POI stands on, and its text.
   * @param {object} p POI.
   * @returns {{rung:number, he:string, en:string, photo:?object}} Text is empty on the last two rungs.
   */
  storefronts.resolve = function (p) {
    var def = storefronts.forPoi(p.id);
    var from = forced === null ? 0 : forced;
    var A = TLV.render.assets;
    if (from <= RUNG.PHOTO && def && def.art && def.art.asset) {
      var img = A.state(def.art.asset) === 'ready' ? A.image(def.art.asset) : null;
      if (img) return { rung: RUNG.PHOTO, he: '', en: '', photo: img, key: 'p:' + def.art.asset };
    }
    if (from <= RUNG.CURATED && def && def.sign && def.sign.text && (def.sign.text.he || def.sign.text.en)) {
      return { rung: RUNG.CURATED, he: def.sign.text.he || '', en: def.sign.text.en || '', photo: null };
    }
    if (from <= RUNG.OSM && (p.nameHe || p.nameEn)) return { rung: RUNG.OSM, he: p.nameHe, en: p.nameEn, photo: null };
    var label = TLV.tune.render.kindLabels[p.kind];
    if (from <= RUNG.KIND && label) return { rung: RUNG.KIND, he: label[0], en: label[1], photo: null };
    return { rung: from >= RUNG.PLAIN ? RUNG.PLAIN : RUNG.BLANK, he: '', en: '', photo: null };
  };

  /**
   * Requests art near the focus. Phase 4.
   * @param {object} W World.
   * @param {number} fx Focus x.
   * @param {number} fy Focus y.
   */
  storefronts.frame = function (W, fx, fy) {
    var R = TLV.tune.render.storefrontLoadM;
    byPoi.forEach(function (def, poiId) {
      if (!def.art || !def.art.asset) return;
      var p = W.pois[poiId];
      var dx = p.x - fx, dy = p.y - fy;
      if (dx * dx + dy * dy <= R * R) TLV.render.assets.request(def.art.asset);
    });
  };
})(window.TLV);
