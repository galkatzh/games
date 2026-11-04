// js/world/world.js — WP-WORLD
// Builds a World from a map payload (ARCHITECTURE 8), and registers the package.
(function (TLV) {
  'use strict';

  var world = TLV.ns('world');

  /** Builds by map id. A read-only cache filled from drained maps, which ARCHITECTURE 3 exempts. */
  var built = Object.create(null);

  /**
   * First lane centreline that crosses a collider. Checked once per world, because neither ever changes.
   * @param {object} W World.
   * @returns {?string} Failure text, or null.
   */
  function laneColliderFailure(W) {
    if (W.index.laneColliderResult !== undefined) return W.index.laneColliderResult;
    var result = null;
    for (var l = 0; l < W.lanes.length && !result; l++) {
      var lane = W.lanes[l];
      for (var i = 0; i + 1 < lane.px.length && !result; i++) {
        if (world.spatial.rayBlocked(W, lane.px[i], lane.py[i], lane.px[i + 1], lane.py[i + 1])) {
          result = 'lane ' + l + ' crosses a collider near (' + lane.px[i] + ', ' + lane.py[i] + ')';
        }
      }
    }
    W.index.laneColliderResult = result;
    return result;
  }

  /**
   * Registers the map handler, invariants and debug hooks. Called once per TLV, before the queue drains.
   */
  world.register = function () {
    TLV.registry.on('map', world.map.onMap);
    TLV.invariants.register('world.laneColliders', function (S) {
      return S.world ? laneColliderFailure(S.world) : null;
    });
    TLV.debug.register('forceSignal', function (juncId, state, holdS) {
      var S = TLV.debug.current();
      return S ? world.signals.force(S, juncId, state, holdS) : false;
    });
  };

  /**
   * Builds a World. Deterministic: the same payload gives the same World, and no RNG runs except TLV.rng.hash32.
   * @param {object} payload Map container (ARCHITECTURE 7.1).
   * @returns {object} World (ARCHITECTURE 10.6). Throws on a schema major mismatch.
   */
  world.build = function (payload) {
    var W = world.map._load(payload);
    world.spatial._buildColliders(W);
    world.lanes._build(W);
    world.junctions._build(W);
    world.signals._build(W);
    world.spatial._build(W);
    world.surface._build(W);
    world.sidewalks._build(W);
    world.surface._paintSidewalks(W);
    world.props._build(W);
    world.spatial._buildProps(W);
    world.parking._build(W);
    world.routing._build(W);
    return W;
  };

  /**
   * The cached World of a drained map.
   * @param {string} mapId Map id.
   * @returns {?object} World, or null if no such map was drained.
   */
  world.get = function (mapId) {
    if (Object.prototype.hasOwnProperty.call(built, mapId)) return built[mapId];
    var payload = world.map.payload(mapId);
    if (!payload) return null;
    built[mapId] = world.build(payload);
    return built[mapId];
  };
})(window.TLV);
