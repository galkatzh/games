// js/render/atlas.js — WP-RENDER
// AtlasSlots: a fixed grid on one texture, LRU eviction, one copyTextureToTexture per bake (section 15.3).
// Orientation, proved by tests/render/atlas.e2e.cjs with an asymmetric pattern: three's copy honours the destination's flipY,
// so with flipY false a canvas's top row lands on the slot's lowest texture row. A slot's top edge is therefore at
// v = y / size and its bottom edge at v = (y + slotH) / size. Everything that samples the atlas goes through rect().
(function (TLV) {
  'use strict';

  var atlas = TLV.ns('render.atlas');

  /**
   * @param {object} renderer THREE.WebGLRenderer.
   * @param {{size:number, slotW:number, slotH:number, mips:boolean}} opts Atlas shape.
   */
  function AtlasSlots(renderer, opts) {
    this.renderer = renderer;
    this.size = opts.size;
    this.slotW = opts.slotW;
    this.slotH = opts.slotH;
    this.cols = Math.floor(opts.size / opts.slotW);
    this.rows = Math.floor(opts.size / opts.slotH);
    this.count = this.cols * this.rows;
    this.keys = new Array(this.count).fill(null);
    this.used = new Float64Array(this.count);
    this.map = new Map();
    this.clock = 0;
    this.mips = !!opts.mips;
    var data = new Uint8Array(opts.size * opts.size * 4);
    var tex = new THREE.DataTexture(data, opts.size, opts.size, THREE.RGBAFormat, THREE.UnsignedByteType);
    tex.flipY = false;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = this.mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter;
    tex.generateMipmaps = this.mips;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    this.tex = tex;
    this.stored = false;     // True once the texture has its GPU storage, which only the first upload sizes
    this.cv = document.createElement('canvas');
    this.cv.width = opts.slotW;
    this.cv.height = opts.slotH;
    this.ctx = this.cv.getContext('2d', { willReadFrequently: false });
    this.src = new THREE.CanvasTexture(this.cv);
    this.src.flipY = false;
  }

  /**
   * Looks up a key and marks it recent.
   * @param {string} key Content key.
   * @returns {number} Slot, or -1 when not baked.
   */
  AtlasSlots.prototype.find = function (key) {
    var slot = this.map.get(key);
    if (slot === undefined) return -1;
    this.used[slot] = ++this.clock;
    return slot;
  };

  /**
   * Picks a slot for a new key, evicting the least recently used.
   * @param {string} key Content key.
   * @returns {number} Slot.
   */
  AtlasSlots.prototype.claim = function (key) {
    var best = 0;
    var bestT = Infinity;
    for (var i = 0; i < this.count; i++) {
      if (this.used[i] < bestT) {
        bestT = this.used[i];
        best = i;
      }
    }
    if (this.keys[best] !== null) this.map.delete(this.keys[best]);
    this.keys[best] = key;
    this.map.set(key, best);
    this.used[best] = ++this.clock;
    return best;
  };

  /**
   * Copies the atlas's canvas into a slot. Paint on .ctx first.
   * @param {number} slot Slot.
   * @param {boolean} last True for the last bake this frame, which refreshes the mip chain.
   */
  AtlasSlots.prototype.commit = function (slot, last) {
    var px = (slot % this.cols) * this.slotW;
    var py = Math.floor(slot / this.cols) * this.slotH;
    // The first upload sizes the storage for good, so it must happen with mips asked for, even when this bake is not the frame's last.
    if (!this.stored) {
      this.renderer.initTexture(this.tex);
      this.stored = true;
    }
    this.tex.generateMipmaps = this.mips && last;
    this.renderer.copyTextureToTexture(new THREE.Vector2(px, py), this.src, this.tex);
    this.tex.generateMipmaps = this.mips;
  };

  /**
   * Forgets every bake. Bakes live only on the GPU, and the texture's own data stays empty, so a restored context gets a blank atlas back.
   */
  AtlasSlots.prototype.reset = function () {
    this.keys.fill(null);
    this.used.fill(0);
    this.map.clear();
    this.clock = 0;
    this.stored = false;
  };

  /**
   * Texture rectangle of a slot, pulled in half a texel so neighbours never bleed.
   * @param {number} slot Slot.
   * @param {Float32Array} out Receives u0, vTop, u1, vBottom at offset.
   * @param {number} o Offset.
   */
  AtlasSlots.prototype.rect = function (slot, out, o) {
    var s = this.size;
    var px = (slot % this.cols) * this.slotW;
    var py = Math.floor(slot / this.cols) * this.slotH;
    out[o] = (px + 0.5) / s;
    out[o + 1] = (py + 0.5) / s;
    out[o + 2] = (px + this.slotW - 0.5) / s;
    out[o + 3] = (py + this.slotH - 0.5) / s;
  };

  /** Frees the textures. */
  AtlasSlots.prototype.dispose = function () {
    this.tex.dispose();
    this.src.dispose();
  };

  atlas.AtlasSlots = AtlasSlots;
})(window.TLV);
