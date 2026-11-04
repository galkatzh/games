// tests/traffic/stubs/spawn_stub.js — WP-TRAFFIC
// Stands in for the one thing of WP-GAME that a soak of the other packages needs: where a run starts. It is the contract's King
// George approach to HaNeviim (ARCHITECTURE 14.6), 40 m before the stop line. Everything else of WP-GAME is absent, and
// TLV.sim.create fills S.game at phase DRIVE, which is the phase the bots read.
(function (TLV) {
  'use strict';

  var START = { x: -62, y: 139 };
  var BEFORE_LINE = 40;

  TLV.ns('game.errands').spawnPoint = function (S) {
    var W = S.world;
    var near = TLV.world.lanes._nearest(W, START.x, START.y, null, 80, true, {});
    if (!near) return null;
    var lane = W.lanes[near.laneId];
    var s = Math.max(0, lane.len - BEFORE_LINE);
    var at = TLV.world.lanes.pointAt(W, lane.id, s, {});
    return { x: at.x, y: at.y, h: at.h, laneId: lane.id, s: s, connId: lane.conns.length ? lane.conns[0] : -1 };
  };
})(window.TLV);
