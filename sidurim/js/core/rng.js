// js/core/rng.js — WP-CORE
// Mulberry32 streams and FNV-1a hashes. hash32 and hashStr are stable forever: map, parking and facade variation are
// keyed on them, so changing them repaints the city and reshuffles every recorded game.
(function (TLV) {
  'use strict';

  var rng = TLV.ns('rng');

  var FNV_OFFSET = 2166136261;
  var FNV_PRIME = 16777619;
  var TWO32 = 4294967296;

  /**
   * One seeded stream.
   * @param {number} seed Any number; only its low 32 bits count.
   */
  function Rng(seed) {
    this._s = seed | 0;
  }

  /** @returns {number} Uniform float in [0, 1). */
  Rng.prototype.next = function () {
    this._s = (this._s + 0x6D2B79F5) | 0;
    var t = this._s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / TWO32;
  };

  /** @returns {number} Uniform integer in 0..n-1, 0 when n <= 0. Always consumes one draw. */
  Rng.prototype.int = function (n) {
    var r = Math.floor(this.next() * n);
    return n > 0 ? r : 0;
  };

  /** @returns {number} Uniform float in [a, b). */
  Rng.prototype.range = function (a, b) {
    return a + (b - a) * this.next();
  };

  /** @returns {boolean} True with probability p. */
  Rng.prototype.bool = function (p) {
    return this.next() < p;
  };

  /** @returns {*} A uniformly chosen element, or null for an empty array. */
  Rng.prototype.pick = function (arr) {
    var i = this.int(arr.length);
    return arr.length ? arr[i] : null;
  };

  /**
   * Beta(2,2) sample, used for driver aggression. The median of three uniforms has exactly this distribution, and it
   * always consumes three draws, so streams stay aligned.
   * @returns {number} Float in [0, 1).
   */
  Rng.prototype.beta22 = function () {
    var a = this.next();
    var b = this.next();
    var c = this.next();
    return Math.max(Math.min(a, b), Math.min(Math.max(a, b), c));
  };

  /** @returns {number} Internal state as a uint32, for hashing and replay. */
  Rng.prototype.state = function () {
    return this._s >>> 0;
  };

  /** Restores a state from state(). */
  Rng.prototype.setState = function (u) {
    this._s = u | 0;
  };

  /**
   * Creates a stream.
   * @param {number} seed Seed.
   * @returns {Rng} New stream.
   */
  rng.create = function (seed) {
    return new Rng(seed);
  };

  /** @returns {number} FNV-1a state after mixing the four little-endian bytes of a 32-bit value. */
  function mixWord(h, word) {
    h = Math.imul(h ^ (word & 255), FNV_PRIME);
    h = Math.imul(h ^ ((word >>> 8) & 255), FNV_PRIME);
    h = Math.imul(h ^ ((word >>> 16) & 255), FNV_PRIME);
    return Math.imul(h ^ (word >>> 24), FNV_PRIME);
  }

  /**
   * FNV-1a over 32-bit integers.
   * Values wider than 32 bits, such as OSM IDs, mix their high word too rather than wrapping onto a smaller ID. A string
   * argument counts as its hashStr, because the contract seeds streams with hash32(seed, streamName).
   * @param {...(number|string)} values Integers.
   * @returns {number} uint32.
   */
  rng.hash32 = function () {
    var h = FNV_OFFSET | 0;
    for (var i = 0; i < arguments.length; i++) {
      var v = arguments[i];
      if (typeof v === 'string') v = rng.hashStr(v);
      h = mixWord(h, v | 0);
      if (v >= TWO32 || v < -2147483648) h = mixWord(h, Math.floor(v / TWO32) | 0);
    }
    return h >>> 0;
  };

  /**
   * FNV-1a over the UTF-8 bytes of a string.
   * @param {string} str Text.
   * @returns {number} uint32.
   */
  rng.hashStr = function (str) {
    var h = FNV_OFFSET | 0;
    var n = str.length;
    for (var i = 0; i < n; i++) {
      var c = str.charCodeAt(i);
      if (c >= 0xD800 && c < 0xDC00 && i + 1 < n) {
        var low = str.charCodeAt(i + 1);
        if (low >= 0xDC00 && low < 0xE000) {
          c = 0x10000 + ((c - 0xD800) << 10) + (low - 0xDC00);
          i++;
        }
      }
      if (c < 0x80) {
        h = Math.imul(h ^ c, FNV_PRIME);
      } else if (c < 0x800) {
        h = Math.imul(h ^ (0xC0 | (c >> 6)), FNV_PRIME);
        h = Math.imul(h ^ (0x80 | (c & 63)), FNV_PRIME);
      } else if (c < 0x10000) {
        h = Math.imul(h ^ (0xE0 | (c >> 12)), FNV_PRIME);
        h = Math.imul(h ^ (0x80 | ((c >> 6) & 63)), FNV_PRIME);
        h = Math.imul(h ^ (0x80 | (c & 63)), FNV_PRIME);
      } else {
        h = Math.imul(h ^ (0xF0 | (c >> 18)), FNV_PRIME);
        h = Math.imul(h ^ (0x80 | ((c >> 12) & 63)), FNV_PRIME);
        h = Math.imul(h ^ (0x80 | ((c >> 6) & 63)), FNV_PRIME);
        h = Math.imul(h ^ (0x80 | (c & 63)), FNV_PRIME);
      }
    }
    return h >>> 0;
  };
})(window.TLV);
