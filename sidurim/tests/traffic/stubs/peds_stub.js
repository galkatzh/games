// tests/traffic/stubs/peds_stub.js — WP-TRAFFIC
// A minimal stand-in for WP-PEDS, used only when that package is absent: nobody on the road, and a record of who was asked to get
// out of a car. It keeps tests of traffic independent of the people.
(function (TLV) {
  'use strict';

  var peds = TLV.ns('peds');

  peds.register = function () {};
  peds.init = function (S) { S.pedsys = { spawned: [] }; };
  peds.update = function () {};
  peds.maintain = function () {};
  peds.spawn = function (S, spec) {
    S.pedsys.spawned.push(spec);
    return null;
  };
  peds.pedsNear = function () { return 0; };
  peds.obstaclesOnLane = function () { return 0; };
  peds.zoneOccupied = function () { return false; };
})(window.TLV);
