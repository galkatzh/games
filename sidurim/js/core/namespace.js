// js/core/namespace.js — WP-CORE
// First game script in the browser and in Node. It creates window.TLV, so unlike every other file it cannot take TLV as
// an argument: in Node the loader calls it with TLV undefined (ARCHITECTURE section 5).
(function (window) {
  'use strict';

  var TLV = window.TLV = window.TLV || {};

  /** Extension queue: ['map'|'errand'|..., payload] rows. Data files only ever push here (ARCHITECTURE 4.4). */
  TLV.q = TLV.q || [];

  /** Tuning tables, one per package: TLV.tune.<pkg>. */
  TLV.tune = TLV.tune || {};

  /**
   * Creates nested namespace objects under TLV and returns the leaf.
   * @param {string} path Dotted path, for example 'world.lanes'.
   * @returns {object} The existing or new leaf object.
   */
  TLV.ns = function (path) {
    var parts = path.split('.');
    var node = TLV;
    for (var i = 0; i < parts.length; i++) {
      var key = parts[i];
      if (!node[key]) node[key] = {};
      node = node[key];
    }
    return node;
  };
})(window);
