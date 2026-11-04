// js/render/city/styles.js — WP-RENDER
// Registries for style, kit, mesh and district items (section 14.7), and the choice of style per building.
(function (TLV) {
  'use strict';

  var styles = TLV.ns('render.styles');

  var defs = Object.create(null);
  var kits = Object.create(null);
  var meshes = Object.create(null);
  var districts = [];
  var canopyOsm = new Set();
  var projected = new WeakMap();

  /** Common building:colour words. */
  styles.colourNames = {
    white: '#f1eee6', beige: '#e6d8bd', cream: '#efe5cf', grey: '#b9b6ae', gray: '#b9b6ae', yellow: '#ecd38f', tan: '#d8c19a',
    orange: '#e0a768', brown: '#a9855f', red: '#b5614a', pink: '#e4b9a8', lightgrey: '#d6d3cc', lightgray: '#d6d3cc',
    steelblue: '#7f9fb8', blue: '#7f9fb8', lightblue: '#a9c6da', black: '#3b3b3e', silver: '#c6c9cc', green: '#8aa58a'
  };

  /** @returns {string} Canopy key of a row. */
  function refOf(osmT, osm) {
    return 'nwr'[osmT] + osm;
  }

  /**
   * Handles a style item.
   * @param {object} def Section 14.7.
   */
  styles.onStyle = function (def) {
    if (!def || typeof def.id !== 'string' || !def.id) {
      TLV.registry.problem('style', def && def.id, 'style needs an id');
      return;
    }
    if (def.form === 'canopy' && Array.isArray(def.osm)) def.osm.forEach(function (r) { canopyOsm.add(r); });
    defs[def.id] = def;
  };

  /**
   * Handles a kit item. `facade.tile` items paint tiles; the rest emit instances.
   * @param {object} def Section 14.7.
   */
  styles.onKit = function (def) {
    if (!def || typeof def.slot !== 'string' || typeof def.id !== 'string') {
      TLV.registry.problem('kit', def && def.id, 'kit needs slot and id');
      return;
    }
    var list = kits[def.slot] || (kits[def.slot] = []);
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === def.id) {
        if ((def.priority || 0) >= (list[i].priority || 0)) list.splice(i, 1);
        else return;
        break;
      }
    }
    list.push(def);
    list.sort(function (a, b) { return (b.priority || 0) - (a.priority || 0); });
  };

  /**
   * Handles a mesh item.
   * @param {object} def { id, asset, fallback, max }.
   */
  styles.onMesh = function (def) {
    if (!def || typeof def.id !== 'string') {
      TLV.registry.problem('mesh', def && def.id, 'mesh needs an id');
      return;
    }
    meshes[def.id] = def;
  };

  /**
   * Handles a district item. `poly` is lat/lon; a district with `default: true` needs none and matches anywhere.
   * @param {object} def { id, poly, weights }.
   */
  styles.onDistrict = function (def) {
    if (!def || typeof def.id !== 'string' || !def.weights || (!def.default && !Array.isArray(def.poly))) {
      TLV.registry.problem('district', def && def.id, 'district needs an id, weights and poly');
      return;
    }
    districts.push(def);
  };

  /** @returns {?object} A style by ID. */
  styles.get = function (id) {
    return defs[id] || null;
  };

  /** @returns {?object} A mesh item by ID. */
  styles.meshDef = function (id) {
    return meshes[id] || null;
  };

  /** @returns {object[]} All kit items of a slot, best first. */
  styles.kit = function (slot) {
    return kits[slot] || [];
  };

  /**
   * The tile for a kind of POI: the first `facade.tile` item that lists it in `kinds`.
   * @param {string} kind Game kind.
   * @returns {?string} Tile ID, or null when no tile claims the kind.
   */
  styles.shopTile = function (kind) {
    var list = kits['facade.tile'] || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].kinds && list[i].kinds.indexOf(kind) >= 0) return list[i].id;
    }
    return null;
  };

  /**
   * A tile for a shop nobody mapped: a weighted pick over `facade.tile` items with a `filler` weight, in ID order.
   * @param {number} u Uniform 0..1.
   * @returns {?string} Tile ID, or null when no tile offers.
   */
  styles.shopFiller = function (u) {
    var list = (kits['facade.tile'] || []).filter(function (k) { return k.filler > 0; });
    list.sort(function (a, b) { return a.id < b.id ? -1 : 1; });
    var total = list.reduce(function (n, k) { return n + k.filler; }, 0);
    var t = u * total;
    for (var i = 0; i < list.length; i++) {
      t -= list[i].filler;
      if (t <= 0) return list[i].id;
    }
    return list.length ? list[list.length - 1].id : null;
  };

  /**
   * Providers a style names for a slot, best first. A style that names none uses the built-in.
   * @param {string} slot Slot ID.
   * @param {object} style Style.
   * @returns {object[]} Kit items.
   */
  styles.providers = function (slot, style) {
    var want = style.slots && style.slots[slot];
    if (!want) return [];
    var ids = Array.isArray(want) ? want : [want];
    var list = kits[slot] || [];
    var out = [];
    for (var i = 0; i < list.length; i++) if (ids.indexOf(list[i].id) >= 0) out.push(list[i]);
    return out;
  };

  /** @returns {boolean} True for a `building=roof` row. The map schema has no such column. */
  styles.isCanopy = function (b) {
    return canopyOsm.has(refOf(b.osmT, b.osm));
  };

  /** District polygons in metres, per world. */
  function polysOf(W) {
    var got = projected.get(W);
    if (got && got.length === districts.length) return got;
    var origin = (W.meta && W.meta.origin) || [32.075, 34.7775];
    got = districts.map(function (d) {
      if (!d.poly) return { d: d, ring: null };
      var ring = new Float64Array(d.poly.length * 2);
      for (var i = 0; i < d.poly.length; i++) {
        var p = TLV.anchors.project(d.poly[i][0], d.poly[i][1], origin);
        ring[i * 2] = p.x;
        ring[i * 2 + 1] = p.y;
      }
      return { d: d, ring: ring };
    });
    projected.set(W, got);
    return got;
  }

  /** @returns {?object} First district holding a point, in content order, then the default one. */
  styles.districtAt = function (W, x, y) {
    var list = polysOf(W);
    var inRing = TLV.render.city.recipes.inRing;
    var fallback = null;
    for (var i = 0; i < list.length; i++) {
      if (!list[i].ring) fallback = list[i].d;
      else if (inRing(x, y, list[i].ring)) return list[i].d;
    }
    return fallback;
  };

  var sorted = new WeakMap();       // Key order of each weight table: a shop filler or a district is picked from thousands of times

  /** Weighted pick from { id: weight }, in sorted key order so object order cannot matter. */
  function pick(weights, u) {
    var keys = sorted.get(weights);
    if (!keys) sorted.set(weights, keys = Object.keys(weights).sort());
    var total = 0;
    for (var i = 0; i < keys.length; i++) if (defs[keys[i]]) total += weights[keys[i]];
    if (total <= 0) return null;
    var t = u * total;
    for (var k = 0; k < keys.length; k++) {
      if (!defs[keys[k]]) continue;
      t -= weights[keys[k]];
      if (t <= 0) return keys[k];
    }
    return keys[keys.length - 1];
  }

  /** Styles carrying a tag, as weights. */
  function tagged(tag) {
    var out = {};
    Object.keys(defs).forEach(function (id) {
      if (defs[id].tags && defs[id].tags.indexOf(tag) >= 0) out[id] = defs[id].weight || 1;
    });
    return out;
  }

  /**
   * Style for a building: landmark, then `building.set`, then district weights adjusted by OSM hints.
   * @param {object} W World.
   * @param {number} id Row.
   * @returns {?string} Style ID, null for the default style.
   */
  styles.choose = function (W, id) {
    var b = W.blds[id];
    var lm = TLV.render.landmarks && TLV.render.landmarks.styleFor(id);
    if (lm && defs[lm]) return lm;
    if (b.style && defs[b.style]) return b.style;
    var u = TLV.rng.hash32(b.osm, TLV.rng.hashStr('style')) / 4294967296;
    var hint = null;
    if (b.flags & 2) hint = 'glass';
    else if (b.h >= 60) hint = 'tower';
    else if (b.kind === 3) hint = 'office';
    else if (b.kind === 5 || b.kind === 7 || b.kind === 8 || b.kind === 6) hint = 'civic';
    else if (b.kind === 9) hint = 'industrial';
    if (hint) {
      var w = tagged(hint);
      var got = pick(w, u);
      if (got) return got;
    }
    var d = styles.districtAt(W, b.cx, b.cy);
    return d ? pick(d.weights, u) : null;
  };
})(window.TLV);
