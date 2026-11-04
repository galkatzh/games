// js/render/coords.js — WP-RENDER
// The only conversion between the world frame and the Three frame (ARCHITECTURE 1.4).
(function (TLV) {
  'use strict';

  var coords = TLV.ns('render.coords');

  /**
   * World to Three.
   * @param {number} x Metres east.
   * @param {number} y Metres north.
   * @param {number} z Metres above ground.
   * @param {{x:number,y:number,z:number}} out Receives the Three position; a THREE.Vector3 or a plain object.
   * @returns {object} out.
   */
  coords.toThree = function (x, y, z, out) {
    out.x = x;
    out.y = z;
    out.z = -y;
    return out;
  };

  /**
   * Three to world.
   * @param {{x:number,y:number,z:number}} v Three position.
   * @param {{x:number,y:number,z:number}} out Receives x east, y north, z height.
   * @returns {object} out.
   */
  coords.fromThree = function (v, out) {
    var ty = v.y;
    out.x = v.x;
    out.y = -v.z;
    out.z = ty;
    return out;
  };

  /**
   * Writes a world point as three floats, for geometry buffers.
   * @param {Float32Array} arr Target.
   * @param {number} o Offset of the first float.
   * @param {number} x Metres east.
   * @param {number} y Metres north.
   * @param {number} z Metres above ground.
   */
  coords.write = function (arr, o, x, y, z) {
    arr[o] = x;
    arr[o + 1] = z;
    arr[o + 2] = -y;
  };

  /**
   * Writes a world direction as three signed bytes, for packed normals.
   * @param {Int8Array} arr Target.
   * @param {number} o Offset of the first byte.
   * @param {number} nx East part.
   * @param {number} ny North part.
   * @param {number} nz Up part.
   */
  coords.writeNormal = function (arr, o, nx, ny, nz) {
    arr[o] = nx * 127;
    arr[o + 1] = nz * 127;
    arr[o + 2] = -ny * 127;
  };

  /**
   * Model yaw for a heading. A model with forward +X takes rotation.y = h.
   * @param {number} h Heading, radians.
   * @returns {number} rotation.y.
   */
  coords.yaw = function (h) {
    return h;
  };
})(window.TLV);
