// js/core/registry.js — WP-CORE
// Dispatches the TLV.q extension queue to handlers, and keeps the list of rejected content (ARCHITECTURE 4.4, 14).
(function (TLV) {
  'use strict';

  var registry = TLV.ns('registry');

  /** Queue types that can change the sim, so they alone feed contentHash (ARCHITECTURE 9.4). */
  var SIM_TYPES = { errand: true, incident: true, spawn: true };

  var handlers = Object.create(null);
  var problems = [];
  var simItems = [];
  var draining = false;

  /** @returns {string} A best-effort item ID for problem reports. */
  function itemId(payload) {
    return payload && payload.id !== undefined ? String(payload.id) : '?';
  }

  /**
   * Canonical JSON: object keys sorted at every depth, so hashes never depend on how a data file was written.
   * Functions and undefined are dropped, as in JSON.
   */
  function canonical(v) {
    if (Array.isArray(v)) {
      return '[' + v.map(function (e) {
        var c = canonical(e);
        return c === undefined ? 'null' : c;
      }).join(',') + ']';
    }
    if (v && typeof v === 'object') {
      var rows = [];
      Object.keys(v).sort().forEach(function (k) {
        var c = canonical(v[k]);
        if (c !== undefined) rows.push(JSON.stringify(k) + ':' + c);
      });
      return '{' + rows.join(',') + '}';
    }
    return JSON.stringify(v);
  }

  /**
   * Registers the handler for a queue type. A type has one handler, and the latest registration wins.
   * @param {string} type Queue type, for example 'errand'.
   * @param {function(object):void} fn Receives the payload.
   */
  registry.on = function (type, fn) {
    handlers[type] = fn;
  };

  /**
   * Dispatches queued items, in order, to their handlers. Items with no handler stay queued without error, and each
   * item is dispatched once, so this is repeatable. A throwing handler counts as a rejection of that item.
   */
  registry.drain = function () {
    if (draining) return;
    draining = true;
    var q = TLV.q;
    var kept = [];
    // Length is re-read because a handler may queue more items.
    for (var i = 0; i < q.length; i++) {
      var item = q[i];
      if (!Array.isArray(item) || typeof item[0] !== 'string') {
        registry.problem('queue', String(i), 'malformed queue item');
        continue;
      }
      var type = item[0];
      var fn = handlers[type];
      if (!fn) {
        kept.push(item);
        continue;
      }
      if (SIM_TYPES[type]) simItems.push(item);
      try {
        fn(item[1]);
      } catch (e) {
        registry.problem(type, itemId(item[1]), 'handler threw: ' + (e && e.message));
      }
    }
    q.length = 0;
    for (var k = 0; k < kept.length; k++) q.push(kept[k]);
    draining = false;
  };

  /**
   * Records invalid content. It is skipped, never fatal.
   * @param {string} type Queue type.
   * @param {string} id Item ID.
   * @param {string} reason Why it was rejected.
   */
  registry.problem = function (type, id, reason) {
    problems.push({ type: type, id: id, reason: reason });
    console.warn('TLV.registry: ' + type + ' ' + id + ': ' + reason);
  };

  /** @returns {Array<{type:string,id:string,reason:string}>} Everything rejected so far, as a copy. */
  registry.problems = function () {
    return problems.map(function (p) {
      return { type: p.type, id: p.id, reason: p.reason };
    });
  };

  /**
   * FNV-1a over the canonical JSON of the errand, incident and spawn items, drained or still queued. Rows are sorted,
   * because data script order must not matter.
   * @returns {number} uint32.
   */
  registry.contentHash = function () {
    var rows = simItems.map(canonical);
    TLV.q.forEach(function (item) {
      if (Array.isArray(item) && SIM_TYPES[item[0]]) rows.push(canonical(item));
    });
    rows.sort();
    return TLV.rng.hashStr('[' + rows.join(',') + ']');
  };
})(window.TLV);
