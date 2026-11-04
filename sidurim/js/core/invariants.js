// js/core/invariants.js — WP-CORE
// Named runtime checks. Each package registers its own in register(); section 17.3 lists the required ones. The numeric
// check is CORE's. An invariant that fails is recorded, never thrown, so a run keeps going and soak can report it.
(function (TLV) {
  'use strict';

  var invariants = TLV.ns('invariants');

  var MAX_KEPT = 100;
  var checks = [];

  /** Adds or, for a name seen before, replaces a check, keeping its place in the order. */
  function put(name, fn) {
    for (var i = 0; i < checks.length; i++) {
      if (checks[i].name === name) {
        checks[i].fn = fn;
        return;
      }
    }
    checks.push({ name: name, fn: fn });
  }

  /**
   * Registers a check.
   * @param {string} name Unique name. Registering it again replaces the check.
   * @param {function(object):?string} fn Receives S. Returns null, or failure text.
   */
  invariants.register = put;

  /**
   * Runs every check. A check that throws counts as failing.
   * @param {object} S Sim state.
   * @returns {string[]} New failures. They also go to S.invariantFailures, which keeps the first 100. S._invariantTotal
   *   and S._invariantCounts, by name, keep counting past that.
   */
  invariants.run = function (S) {
    var failures = [];
    for (var i = 0; i < checks.length; i++) {
      var text;
      try {
        text = checks[i].fn(S);
      } catch (e) {
        text = 'threw: ' + (e && e.message);
      }
      if (text) {
        failures.push(checks[i].name + ' @' + S.tick + ': ' + text);
        S._invariantCounts[checks[i].name] = (S._invariantCounts[checks[i].name] || 0) + 1;
      }
    }
    for (var k = 0; k < failures.length; k++) {
      S._invariantTotal++;
      if (S.invariantFailures.length < MAX_KEPT) S.invariantFailures.push(failures[k]);
    }
    return failures;
  };

  /** @returns {string[]} Registered names, in run order. Private to WP-CORE, for the soak report. */
  invariants._names = function () {
    return checks.map(function (c) { return c.name; });
  };

  /** @returns {?string} The first listed field of obj that is not a finite number, as text, else null. */
  function badField(obj, fields, label) {
    for (var i = 0; i < fields.length; i++) {
      var v = obj[fields[i]];
      if (typeof v !== 'number' || !Number.isFinite(v)) return label + '.' + fields[i] + ' = ' + String(v);
    }
    return null;
  }

  var VEHICLE_FIELDS = ['x', 'y', 'h', 'px', 'py', 'ph', 'v', 'vx', 'vy'];
  var PED_FIELDS = ['x', 'y', 'h', 'px', 'py', 'ph', 'v'];
  var FOOT_FIELDS = ['x', 'y', 'h', 'px', 'py', 'ph', 'v'];

  // Soak gate "Numeric": no NaN or Infinity in any pose.
  put('core.numeric', function (S) {
    var i;
    var bad;
    for (i = 0; i < S.vehicles.length; i++) {
      if (S.vehicles[i].active) {
        bad = badField(S.vehicles[i], VEHICLE_FIELDS, 'vehicle slot ' + i);
        if (bad) return bad;
      }
    }
    for (i = 0; i < S.peds.length; i++) {
      if (S.peds[i].active) {
        bad = badField(S.peds[i], PED_FIELDS, 'ped slot ' + i);
        if (bad) return bad;
      }
    }
    var foot = S.player && S.player.foot;
    if (foot && foot.active) return badField(foot, FOOT_FIELDS, 'foot');
    return null;
  });

  // Pools are stable: each record stays in its slot, and slot 0 is always the player.
  put('core.slots', function (S) {
    var i;
    if (!S.vehicles[0].active || !S.vehicles[0].isPlayer || S.vehicles[0].id !== 0) return 'slot 0 is not the player';
    for (i = 0; i < S.vehicles.length; i++) {
      if (S.vehicles[i].slot !== i) return 'vehicle in slot ' + i + ' says slot ' + S.vehicles[i].slot;
      if (i > 0 && S.vehicles[i].isPlayer) return 'player flag on vehicle slot ' + i;
    }
    for (i = 0; i < S.peds.length; i++) {
      if (S.peds[i].slot !== i) return 'ped in slot ' + i + ' says slot ' + S.peds[i].slot;
    }
    return null;
  });
})(window.TLV);
