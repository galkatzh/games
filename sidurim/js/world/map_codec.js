// js/world/map_codec.js — WP-MAP
// Decoder for the columnar map container (ARCHITECTURE sections 7.1 and 7.2). Table-agnostic: it knows column
// encodings, never table or column meanings, so a schema minor bump needs no change here.
(function (TLV) {
  'use strict';

  var mapCodec = TLV.ns('mapCodec');

  /** Base64 alphabet lookup, one entry per char code. -1 marks anything that is not in the alphabet. */
  var B64 = new Int8Array(128);
  (function fillAlphabet() {
    var alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
    var i;
    for (i = 0; i < 128; i++) B64[i] = -1;
    for (i = 0; i < 64; i++) B64[alphabet.charCodeAt(i)] = i;
  })();

  /**
   * Decodes a Base64 string to bytes. Written by hand because `atob` plus `charCodeAt` costs a second pass over a
   * megabyte of text during load.
   * @param {string} str Base64 text.
   * @returns {Uint8Array}
   */
  function b64Bytes(str) {
    var len = str.length;
    if (len === 0) return new Uint8Array(0);
    var pad = 0;
    if (str.charCodeAt(len - 1) === 61) pad++;
    if (len > 1 && str.charCodeAt(len - 2) === 61) pad++;
    var n = Math.floor(len * 3 / 4) - pad;
    var out = new Uint8Array(n);
    var o = 0;
    var i = 0;
    var c0, c1, c2, c3;
    // Every group but the last writes three bytes. Only the last can hold padding.
    var whole = n - 3;
    while (o <= whole && i + 3 < len) {
      c0 = B64[str.charCodeAt(i)];
      c1 = B64[str.charCodeAt(i + 1)];
      c2 = B64[str.charCodeAt(i + 2)];
      c3 = B64[str.charCodeAt(i + 3)];
      i += 4;
      out[o] = (c0 << 2) | (c1 >> 4);
      out[o + 1] = ((c1 & 15) << 4) | (c2 >> 2);
      out[o + 2] = ((c2 & 3) << 6) | c3;
      o += 3;
    }
    if (i + 3 < len) {
      c0 = B64[str.charCodeAt(i)];
      c1 = B64[str.charCodeAt(i + 1)];
      c2 = B64[str.charCodeAt(i + 2)];
      out[o++] = (c0 << 2) | (c1 >> 4);
      if (o < n) out[o] = ((c1 & 15) << 4) | (c2 >> 2);
    }
    return out;
  }

  /** Number of LEB128 values in a byte array: each value ends on the one byte with a clear top bit. */
  function countValues(bytes) {
    var n = 0;
    for (var i = 0; i < bytes.length; i++) if (bytes[i] < 128) n++;
    return n;
  }

  /**
   * Decodes unsigned LEB128 with arithmetic, so a value above 2^31 survives. Bit shifts would wrap it.
   * @param {Uint8Array} bytes Encoded bytes.
   * @param {Int32Array|Float64Array} out Receives one value per LEB128 run.
   * @returns {Int32Array|Float64Array} `out`.
   */
  function readLeb(bytes, out) {
    var v = 0;
    var mul = 1;
    var o = 0;
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b < 128) {
        out[o++] = v + b * mul;
        v = 0;
        mul = 1;
      } else {
        v += (b & 127) * mul;
        mul *= 128;
      }
    }
    return out;
  }

  /** readLeb for the few columns that need doubles. Sharing one body made every column's code start again at the first of these. */
  function readLebDoubles(bytes, out) {
    var v = 0;
    var mul = 1;
    var o = 0;
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b < 128) {
        out[o++] = v + b * mul;
        v = 0;
        mul = 1;
      } else {
        v += (b & 127) * mul;
        mul *= 128;
      }
    }
    return out;
  }

  /**
   * Decodes zigzag LEB128 in one pass, each value worked out in arithmetic because the encoded form can pass 2^31 while the value
   * stays in Int32 range. This is the bulk of a map's bytes and of its decoding time.
   * @param {Uint8Array} bytes Encoded bytes.
   * @param {boolean} running True when each value is a difference from the one before.
   * @returns {Int32Array}
   */
  function readZigzag(bytes, running) {
    var out = new Int32Array(countValues(bytes));
    var v = 0;
    var mul = 1;
    var o = 0;
    var sum = 0;
    for (var i = 0; i < bytes.length; i++) {
      var b = bytes[i];
      if (b < 128) {
        v += b * mul;
        var z = v & 1 ? -(v + 1) / 2 : v / 2;
        sum = running ? sum + z : z;
        out[o++] = sum;
        v = 0;
        mul = 1;
      } else {
        v += (b & 127) * mul;
        mul *= 128;
      }
    }
    return out;
  }

  /** Expands value and run length pairs. */
  function readRuns(bytes) {
    var pairs = readLeb(bytes, new Int32Array(countValues(bytes)));
    var n = 0;
    var i;
    for (i = 1; i < pairs.length; i += 2) n += pairs[i];
    var out = new Int32Array(n);
    var o = 0;
    for (i = 0; i + 1 < pairs.length; i += 2) {
      var value = pairs[i];
      var end = o + pairs[i + 1];
      // Most runs are a value or two long, too short to be worth a call to fill.
      if (end - o < 16) {
        while (o < end) out[o++] = value;
      } else {
        out.fill(value, o, end);
        o = end;
      }
    }
    return out;
  }

  /**
   * Decodes one column.
   * @param {string} enc One of `u8`, `vu`, `vz`, `vd`, `vl`, `raw`, or `rl`, which the importer picks for a near-constant
   *   column: value and run length pairs, unsigned LEB128, decoded to an `Int32Array`.
   * @param {string|number[]} data Base64 text, or a plain number array for `raw`.
   * @returns {Uint8Array|Int32Array|Float64Array} An unknown encoding warns and returns an empty array, so a column
   *   from a later schema minor reads as absent.
   */
  mapCodec.decodeColumn = function (enc, data) {
    switch (enc) {
      case 'u8':
        return b64Bytes(data);
      case 'vu': {
        var ub = b64Bytes(data);
        return readLeb(ub, new Int32Array(countValues(ub)));
      }
      case 'vz':
        return readZigzag(b64Bytes(data), false);
      case 'vd':
        return readZigzag(b64Bytes(data), true);
      case 'vl': {
        var lb = b64Bytes(data);
        return readLebDoubles(lb, new Float64Array(countValues(lb)));
      }
      case 'raw':
        return Float64Array.from(data);
      case 'rl':
        return readRuns(b64Bytes(data));
      default:
        console.warn('mapCodec: unknown column encoding ' + enc);
        return new Float64Array(0);
    }
  };

  /**
   * Decodes every table of a map payload. Columns are returned exactly as stored, so coordinates stay in decimetres
   * and string columns stay indices into `strings`. WP-WORLD does the unit conversion.
   * @param {object} payload The object pushed as a `map` queue item.
   * @returns {{schema: number[], id: string, meta: object, strings: string[],
   *   t: Object<string, {n: number, col: Object<string, ArrayLike<number>>}>}}
   */
  mapCodec.decodeAll = function (payload) {
    var t = {};
    var tables = payload.tables || {};
    var names = Object.keys(tables);
    for (var i = 0; i < names.length; i++) {
      var src = tables[names[i]];
      var col = {};
      var colNames = Object.keys(src.cols);
      for (var c = 0; c < colNames.length; c++) {
        var cell = src.cols[colNames[c]];
        col[colNames[c]] = mapCodec.decodeColumn(cell[0], cell[1]);
      }
      t[names[i]] = { n: src.n, col: col };
    }
    return { schema: payload.schema, id: payload.id, meta: payload.meta, strings: payload.strings, t: t };
  };
})(window.TLV);
