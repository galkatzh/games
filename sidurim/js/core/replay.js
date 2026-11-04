// js/core/replay.js — WP-CORE
// Input logs (ARCHITECTURE 9.4). A log stores one packed ControlState per tick, run-length encoded:
// inputs is a list of [count, throttle, brake, steer, footX, footY, boolBits]. Floats survive JSON exactly.
// The title card's difficulty reaches the sim outside the input and after sim.create, so the header also keeps header.difficulty, a list
// of [tick, id] for each change, and params.difficulty holds the last of them.
(function (TLV) {
  'use strict';

  var replay = TLV.ns('replay');

  var VERSION = 1;

  /**
   * Creates the recorder used for S.recorder. It allocates only when the input changes.
   * @param {object} S Sim state, at tick 0.
   * @returns {{record:function(object):void, finish:function():object}} Recorder.
   */
  replay.createRecorder = function (S) {
    var floats = TLV.const._CONTROL_FLOATS;
    var bools = TLV.const._CONTROL_BOOLS;
    var header = {
      version: VERSION,
      seed: S.seed,
      mapId: S.world ? S.world.id : null,
      contentHash: TLV.registry.contentHash(),
      params: JSON.parse(JSON.stringify(S.params))
    };
    var runs = [];
    var last = null;
    var choices = [];
    var chosen;

    return {
      /**
       * Appends one tick. Floats are canonicalized in place first, so NaN, undefined and -0, which JSON cannot carry,
       * reach the sim and the log as the same 0.
       * @param {object} controls The ControlState the sim is about to see.
       */
      record: function (controls) {
        var i;
        var now = S.game ? S.game.difficulty : undefined;
        if (now !== chosen) {
          chosen = now;
          choices.push([S.tick, now]);
        }
        var same = last !== null;
        for (i = 0; i < floats.length; i++) {
          var value = +controls[floats[i]] || 0;
          controls[floats[i]] = value;
          if (same && last[i + 1] !== value) same = false;
        }
        var bits = 0;
        for (i = 0; i < bools.length; i++) {
          if (controls[bools[i]]) bits |= 1 << i;
        }
        if (same && last[6] === bits) {
          last[0]++;
          return;
        }
        last = [1, controls.throttle, controls.brake, controls.steer, controls.footX, controls.footY, bits];
        runs.push(last);
      },

      /**
       * @returns {object} ReplayLog {header, inputs}, a copy. Recording can continue afterwards.
       */
      finish: function () {
        var out = JSON.parse(JSON.stringify(header));
        if (choices.length) {
          out.difficulty = choices.map(function (c) { return c.slice(); });
          out.params.difficulty = chosen;
        }
        return { header: out, inputs: runs.map(function (run) { return run.slice(); }) };
      }
    };
  };

  /**
   * Creates a control source from a log. Input for a tick comes from S.tick alone, so the source holds no game state of
   * its own, and after the last logged tick it returns rest. It warns once if the log does not match the running sim.
   * @param {object} log ReplayLog.
   * @returns {function(object):object} controlSource.
   */
  replay.createPlayer = function (log) {
    var floats = TLV.const._CONTROL_FLOATS;
    var bools = TLV.const._CONTROL_BOOLS;
    var out = TLV.const._newControls();
    var inputs = (log && log.inputs) || [];
    var choices = (log && log.header && log.header.difficulty) || [];
    var runIndex = 0;
    var runStart = 0;
    var checked = false;

    function check(S) {
      checked = true;
      var header = (log && log.header) || {};
      var wrong = [];
      if (header.version !== VERSION) wrong.push('version ' + header.version);
      if (S.world && header.mapId !== S.world.id) wrong.push('map ' + header.mapId);
      if (header.contentHash !== TLV.registry.contentHash()) wrong.push('content hash');
      if (header.seed !== S.seed) wrong.push('seed ' + header.seed);
      var recorded = header.params || {};
      for (var flag in S.flags) {
        if (flag in recorded && !!recorded[flag] !== S.flags[flag]) wrong.push(flag + ' ' + recorded[flag]);
      }
      if (wrong.length) console.warn('TLV.replay: log does not match this sim: ' + wrong.join(', '));
    }

    return function (S) {
      if (!checked) check(S);
      for (var c = 0; c < choices.length && S.game; c++) {
        if (choices[c][0] === S.tick) S.game.difficulty = choices[c][1];
      }
      var index = S.tick - 1;
      if (index < runStart) {
        runIndex = 0;
        runStart = 0;
      }
      while (runIndex < inputs.length && index >= runStart + inputs[runIndex][0]) {
        runStart += inputs[runIndex][0];
        runIndex++;
      }
      var i;
      var run = runIndex < inputs.length ? inputs[runIndex] : null;
      for (i = 0; i < floats.length; i++) out[floats[i]] = run ? run[i + 1] : 0;
      var bits = run ? run[6] : 0;
      for (i = 0; i < bools.length; i++) out[bools[i]] = (bits & (1 << i)) !== 0;
      return out;
    };
  };
})(window.TLV);
