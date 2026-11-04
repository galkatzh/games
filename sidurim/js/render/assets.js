// js/render/assets.js — WP-RENDER
// Optional packed assets, loaded by script injection, at most 2 in flight (section 14.8). The sim never reads them. A missing
// script fires onerror, and the caller's procedural fallback carries on.
(function (TLV) {
  'use strict';

  var assets = TLV.ns('render.assets');

  var items = Object.create(null);    // id -> { state, img, mesh, type, w, h }
  var waiting = [];
  var flying = 0;

  function record(id) {
    return items[id] || (items[id] = { state: 'absent', img: null, mesh: null, type: null, w: 0, h: 0 });
  }

  function pump() {
    var cap = TLV.tune.render.assetInFlight;
    while (flying < cap && waiting.length) {
      var id = waiting.shift();
      inject(id);
    }
  }

  function inject(id) {
    var entry = TLV.assetIndex && Object.prototype.hasOwnProperty.call(TLV.assetIndex, id) ? TLV.assetIndex[id] : null;
    var rec = record(id);
    if (!entry || !entry.src) {
      rec.state = 'absent';
      return;
    }
    flying++;
    var script = document.createElement('script');
    script.src = entry.src;
    script.async = true;
    script.onload = function () {
      flying--;
      TLV.registry.drain();
      if (rec.state === 'queued') rec.state = 'failed';
      pump();
    };
    script.onerror = function () {
      flying--;
      rec.state = 'failed';
      pump();
    };
    document.head.appendChild(script);
  }

  /**
   * Handles an asset item. The base64 string is released once decoded.
   * @param {object} a { id, type, mime, w, h, data }.
   */
  assets.onAsset = function (a) {
    if (!a || typeof a.id !== 'string' || typeof a.data !== 'string') {
      TLV.registry.problem('asset', a && a.id, 'asset needs an id and data');
      return;
    }
    var rec = record(a.id);
    rec.type = a.type;
    rec.w = a.w || 0;
    rec.h = a.h || 0;
    if (a.type === 'image') {
      var img = new Image();
      img.onload = function () {
        rec.img = img;
        rec.state = 'ready';
      };
      img.onerror = function () {
        rec.state = 'failed';
      };
      img.src = a.data;
    } else if (a.type === 'tlvmesh') {
      try {
        rec.mesh = TLV.render.meshFormat.decode(a);
        rec.state = 'ready';
      } catch (e) {
        TLV.registry.problem('asset', a.id, 'mesh would not decode: ' + (e && e.message));
        rec.state = 'failed';
      }
    } else {
      TLV.registry.problem('asset', a.id, 'unknown asset type ' + a.type);
      rec.state = 'failed';
    }
    a.data = null;
  };

  /**
   * Asks for an asset. Harmless to call every frame.
   * @param {string} id Asset ID.
   * @returns {string} 'absent', 'queued', 'ready' or 'failed'.
   */
  assets.request = function (id) {
    var rec = record(id);
    if (rec.state === 'absent' && TLV.assetIndex && Object.prototype.hasOwnProperty.call(TLV.assetIndex, id)) {
      rec.state = 'queued';
      waiting.push(id);
      pump();
    }
    return rec.state;
  };

  /** @returns {string} State of an asset. */
  assets.state = function (id) {
    return record(id).state;
  };

  /** @returns {?HTMLImageElement} The decoded image, when ready. */
  assets.image = function (id) {
    return record(id).img;
  };

  /** @returns {?object} Decoded mesh arrays, when ready. */
  assets.mesh = function (id) {
    return record(id).mesh;
  };
})(window.TLV);
