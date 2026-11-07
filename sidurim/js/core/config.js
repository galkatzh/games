// js/core/config.js — WP-CORE
// URL parameters (ARCHITECTURE 16.1). Browser and Node go through the same normalize, so they behave alike.
//
// Three defaults are null on purpose: seed (js/core may not read the clock), heat ("computed"), and density. The table
// gives density a default of 100, but it also says that setting it disables the adaptive rule and the lane-km cap, so
// TRAFFIC must be able to see whether it was set. null means "not set: use the default target of 100, adaptively".
(function (TLV) {
  'use strict';

  var config = TLV.ns('config');

  var SPEC = {
    seed: { type: 'uint', def: null },
    map: { type: 'string', def: null },
    lang: { type: 'enum', values: ['en', 'he'], def: 'en' },
    debug: { type: 'flag', def: 0 },
    dev: { type: 'flag', def: 0 },
    invariants: { type: 'flag', def: 0 },
    record: { type: 'flag', def: 0 },
    autoplay: { type: 'string', def: null },
    notitle: { type: 'flag', def: 0 },
    errand: { type: 'int', min: 1, max: 7, def: 1 },
    errandDef: { type: 'string', def: null },
    spawn: { type: 'pose', def: null },
    clock: { type: 'number', min: 0, max: Infinity, def: 120 },
    heat: { type: 'number', min: 0, max: 1, def: null },
    immortal: { type: 'flag', def: 0 },
    density: { type: 'int', min: 0, max: Infinity, def: null },
    traffic: { type: 'flag', def: 1 },
    peds: { type: 'flag', def: 1 },
    incidents: { type: 'flag', def: 1 },
    contest: { type: 'enum', values: ['auto', 'off', 'force'], def: 'auto' },
    knife: { type: 'enum', values: ['auto', 'off', 'force'], def: 'auto' },
    quality: { type: 'enum', values: ['auto', 'low', 'med', 'high'], def: 'auto' },
    mute: { type: 'flag', def: 0 },
    radio: { type: 'enum', values: ['auto', 'on', 'off'], def: 'auto' },
    hud: { type: 'flag', def: 1 },
    timescale: { type: 'number', min: 1e-3, max: Infinity, def: 1 }
  };

  /** Warns about a value that cannot be used and yields the default. */
  function reject(key, value, spec) {
    console.warn('TLV.config: ignoring ' + key + '=' + String(value));
    return spec.def;
  }

  /** @returns {?object} {x, y, h} from 'x,y,h', [x, y, h] or {x, y, h}; null if it is not three finite numbers. */
  function toPose(v) {
    var parts = null;
    if (typeof v === 'string') parts = v.split(',');
    else if (Array.isArray(v)) parts = v;
    else if (typeof v === 'object') parts = [v.x, v.y, v.h];
    if (!parts || parts.length !== 3) return null;
    for (var i = 0; i < 3; i++) {
      if (parts[i] === '' || parts[i] === null || !Number.isFinite(Number(parts[i]))) return null;
    }
    return { x: Number(parts[0]), y: Number(parts[1]), h: Number(parts[2]) };
  }

  /** Coerces one raw value, from a query string or a test's object, to the type in SPEC. */
  function coerce(key, value, spec) {
    if (value === undefined || value === null) return spec.def;
    var n;
    switch (spec.type) {
      case 'flag':
        // A bare ?notitle arrives as ''.
        if (value === '' || value === true || value === 'true') return 1;
        if (value === false || value === 'false') return 0;
        n = Number(value);
        return Number.isFinite(n) ? (n ? 1 : 0) : reject(key, value, spec);
      case 'uint':
        n = value === '' ? NaN : Number(value);
        return Number.isFinite(n) ? n >>> 0 : reject(key, value, spec);
      case 'int':
      case 'number':
        n = value === '' ? NaN : Number(value);
        if (!Number.isFinite(n)) return reject(key, value, spec);
        if (spec.type === 'int') n = Math.trunc(n);
        return n < spec.min ? spec.min : (n > spec.max ? spec.max : n);
      case 'enum':
        return spec.values.indexOf(value) >= 0 ? value : reject(key, value, spec);
      case 'pose':
        n = toPose(value);
        return n || reject(key, value, spec);
      default:
        return value === '' ? spec.def : String(value);
    }
  }

  /**
   * Applies the section 16.1 defaults to a partial object. It is idempotent, and it passes unknown keys through.
   * After this: flags are 0 or 1; spawn is null or {x, y, h}; seed, heat and density are null when unset; clockGiven is 1
   * when a usable clock was asked for; map is the given ID, else TLV.mapIndex.default, else null; debug=1 forces invariants=1.
   * @param {?object} [obj] Partial parameters.
   * @returns {object} Complete Params, a new object.
   */
  config.normalize = function (obj) {
    var src = obj || {};
    var out = {};
    var key;
    for (key in src) {
      if (Object.prototype.hasOwnProperty.call(src, key) && !SPEC[key]) out[key] = src[key];
    }
    for (key in SPEC) out[key] = coerce(key, src[key], SPEC[key]);
    if (out.map === null && TLV.mapIndex && TLV.mapIndex.default) out.map = TLV.mapIndex.default;
    if (out.debug) out.invariants = 1;
    // A clock of 120 is both the default and a value someone can ask for, and the difficulty table fills in only the first. A merge
    // over normalized params can bring a new clock with the old clockGiven, so a clock that is not the default counts as asked for.
    var raw = src.clock;
    var usable = raw !== undefined && raw !== null && raw !== '' && Number.isFinite(Number(raw));
    out.clockGiven = src.clockGiven || (usable && (src.clockGiven === undefined || out.clock !== SPEC.clock.def)) ? 1 : 0;
    return out;
  };

  /**
   * Parses a query string. A repeated key keeps its last value.
   * @param {string} queryString For example location.search.
   * @returns {object} Complete Params.
   */
  config.parse = function (queryString) {
    var raw = {};
    new URLSearchParams(queryString || '').forEach(function (value, key) {
      raw[key] = value;
    });
    return config.normalize(raw);
  };
})(window.TLV);
