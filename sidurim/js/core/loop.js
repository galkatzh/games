// js/core/loop.js — WP-CORE
// Fixed-step accumulator (ARCHITECTURE 9.1). DOM-free: main.js injects raf and now.
(function (TLV) {
  'use strict';

  var loop = TLV.ns('loop');

  /** Longest frame the accumulator accepts, seconds. */
  var MAX_FRAME = 0.1;

  /**
   * Creates a loop.
   * @param {object} opts
   * @param {object} opts.S Sim state.
   * @param {function(object):void} opts.step Runs one tick.
   * @param {?function(object, number, number):void} [opts.render] render(S, alpha, dtReal), dtReal in seconds.
   * @param {function(function():void):*} opts.raf Requests one frame callback.
   * @param {function():number} opts.now Clock in milliseconds.
   * @param {number} [opts.timescale=1] The ?timescale factor. It never touches S.timeScale.
   * @returns {{start:function, stop:function, pause:function, resume:function, stepN:function, isPaused:function}} Loop.
   */
  loop.create = function (opts) {
    var S = opts.S;
    var step = opts.step;
    var render = opts.render;
    var raf = opts.raf;
    var now = opts.now;
    var timescale = opts.timescale === undefined || opts.timescale === null ? 1 : opts.timescale;
    var DT = TLV.const.DT;
    var MAX_SUBSTEPS = TLV.const.MAX_SUBSTEPS;

    var running = false;
    var paused = false;
    var requested = false;
    var acc = 0;
    var alpha = 0;
    var last = 0;

    // One callback chain, however start and stop interleave.
    function schedule() {
      if (requested) return;
      requested = true;
      raf(onFrame);
    }

    // Rescheduling comes last, so an exception halts the loop once instead of on every frame.
    function onFrame() {
      requested = false;
      if (!running) return;
      var t = now();
      var dtReal = Math.max(0, (t - last) / 1000);
      last = t;
      if (!paused) {
        acc += Math.min(MAX_FRAME, dtReal) * S.timeScale * timescale;
        var n = 0;
        while (acc >= DT && n < MAX_SUBSTEPS) {
          step(S);
          acc -= DT;
          n++;
        }
        if (n === MAX_SUBSTEPS) acc = 0;
        alpha = acc / DT;
      }
      if (render) render(S, alpha, dtReal);
      schedule();
    }

    return {
      /** Starts or restarts the frame chain. */
      start: function () {
        running = true;
        last = now();
        schedule();
      },

      /** Stops frames, steps and render. */
      stop: function () {
        running = false;
      },

      /** Stops steps. Render continues, so the pause screen stays live. */
      pause: function () {
        paused = true;
      },

      /** Resumes steps. */
      resume: function () {
        paused = false;
      },

      /**
       * Runs n ticks synchronously, whether paused or not. The accumulator is untouched.
       * @param {number} n Tick count.
       */
      stepN: function (n) {
        for (var i = 0; i < n; i++) step(S);
      },

      /** @returns {boolean} True while paused. */
      isPaused: function () {
        return paused;
      }
    };
  };
})(window.TLV);
