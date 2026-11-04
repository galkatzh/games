// js/render/mesh_format.js — WP-RENDER
// The tlvmesh format. tools/pack_assets.mjs writes it, and this reads it. `data` is base64 of a little-endian block:
// vertices interleaved as position (3 f32), normal (3 f32), uv (2 f32), then indices as u32.
// `meta` holds { vertices, indices, texture } and texture is a data URI or null.
(function (TLV) {
  'use strict';

  var fmt = TLV.ns('render.meshFormat');

  /** Floats per vertex. */
  fmt.STRIDE = 8;

  /**
   * Decodes an asset item to typed arrays.
   * @param {{data:string, meta:{vertices:number, indices:number, texture:?string}}} a Asset item.
   * @returns {{vertex:Float32Array, index:Uint32Array, texture:?string}} Arrays.
   */
  fmt.decode = function (a) {
    var m = a.meta;
    if (!m || !(m.vertices > 0) || !(m.indices > 0)) throw new Error('no meta');
    var bin = atob(a.data);
    var need = m.vertices * fmt.STRIDE * 4 + m.indices * 4;
    if (bin.length !== need) throw new Error('size ' + bin.length + ', expected ' + need);
    var bytes = new Uint8Array(need);
    for (var i = 0; i < need; i++) bytes[i] = bin.charCodeAt(i);
    return {
      vertex: new Float32Array(bytes.buffer, 0, m.vertices * fmt.STRIDE),
      index: new Uint32Array(bytes.buffer, m.vertices * fmt.STRIDE * 4, m.indices),
      texture: m.texture || null
    };
  };

  /**
   * Makes a geometry.
   * @param {{vertex:Float32Array, index:Uint32Array}} mesh Decoded mesh.
   * @returns {object} THREE.BufferGeometry.
   */
  fmt.geometry = function (mesh) {
    var g = new THREE.BufferGeometry();
    var ib = new THREE.InterleavedBuffer(mesh.vertex, fmt.STRIDE);
    g.setAttribute('position', new THREE.InterleavedBufferAttribute(ib, 3, 0));
    g.setAttribute('normal', new THREE.InterleavedBufferAttribute(ib, 3, 3));
    g.setAttribute('uv', new THREE.InterleavedBufferAttribute(ib, 2, 6));
    g.setIndex(new THREE.BufferAttribute(mesh.index, 1));
    g.computeBoundingSphere();
    return g;
  };
})(window.TLV);
