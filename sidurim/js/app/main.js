// js/app/main.js — WP-CORE
// Browser boot, in the binding order of ARCHITECTURE 4.6. Only this file may read the wall clock for a default seed.
(function (TLV) {
  'use strict';

  var app = TLV.ns('app');

  /** Map schema major this build reads (ARCHITECTURE 7). */
  var SCHEMA_MAJOR = 1;

  var REGISTER_ORDER = ['world', 'player', 'traffic', 'peds', 'game', 'render', 'ui'];

  /** @returns {?object} The queued map payload. Only the selected map was injected, so the last one is it. */
  function queuedMap() {
    for (var i = TLV.q.length - 1; i >= 0; i--) {
      var item = TLV.q[i];
      if (Array.isArray(item) && item[0] === 'map') return item[1];
    }
    return null;
  }

  /** @returns {string} The re-import command for a map. */
  function reimport(id) {
    return 'Re-import it with: node tools/import.mjs ' + id;
  }

  /** @returns {?object} The built world, or null after showing why not. */
  function buildWorld(payload) {
    var schema = payload.schema || [];
    if (schema[0] !== SCHEMA_MAJOR) {
      app._showError('Map "' + payload.id + '" has schema ' + schema.join('.') + ', and this game reads ' + SCHEMA_MAJOR + '.x. ' +
        reimport(payload.id));
      return null;
    }
    try {
      return TLV.world.build(payload);
    } catch (e) {
      console.error(e);
      app._showError('Map "' + payload.id + '" could not be built: ' + (e && e.message) + '. ' + reimport(payload.id));
      return null;
    }
  }

  /** Boot steps 5 and 6. A package that failed to load is already on the error overlay, so it is skipped here. */
  function initViews(S) {
    if (TLV.render && TLV.render.init) TLV.render.init(document.getElementById('game'), S);
    if (TLV.ui && TLV.ui.init) TLV.ui.init(document.getElementById('ui-root'), S);
  }

  /**
   * Shows a throw from the loop, which halts it (js/core/loop.js). This must catch it here: an error that reaches the window
   * from a file:// script says only "Script error.", and file:// is how the game is meant to run.
   * @param {function():void} fn Frame callback.
   * @returns {function():void} The same callback, with the throw shown.
   */
  function guarded(fn) {
    return function () {
      try {
        fn();
      } catch (e) {
        console.error(e);
        app._showError('The game stopped: ' + (e && e.message));
      }
    };
  }

  /** Boot step 8. */
  function startLoop(S) {
    function render(state, alpha, dtReal) {
      if (TLV.render && TLV.render.frame) TLV.render.frame(state, alpha, dtReal);
      if (TLV.ui && TLV.ui.frame) TLV.ui.frame(state, alpha, dtReal);
    }
    app.loop = TLV.loop.create({
      S: S,
      step: TLV.sim.step,
      render: render,
      raf: function (fn) { return window.requestAnimationFrame(guarded(fn)); },
      now: function () { return window.performance.now(); },
      timescale: TLV.params.timescale
    });
    app.loop.start();
  }

  /** The things that happen to the page, not in it: the window or tab going away, and the WebGL context dropping. */
  function watchPage() {
    function left() {
      if (app.human && TLV.ui && TLV.ui.windowLeft) TLV.ui.windowLeft();
    }
    window.addEventListener('blur', left);
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) left();
      if (TLV.ui && TLV.ui.tabHidden) TLV.ui.tabHidden(document.hidden);
    });
    var canvas = document.getElementById('game');
    canvas.addEventListener('webglcontextlost', function () {
      if (TLV.ui && TLV.ui.onContextLost) TLV.ui.onContextLost();
    });
    canvas.addEventListener('webglcontextrestored', function () {
      if (TLV.ui && TLV.ui.onContextRestored) TLV.ui.onContextRestored();
    });
  }

  /**
   * Boots the game. The loader calls this once every script has loaded.
   */
  app.boot = function () {
    REGISTER_ORDER.forEach(function (pkg) {
      if (TLV[pkg] && typeof TLV[pkg].register === 'function') TLV[pkg].register();
    });

    var payload = queuedMap();
    TLV.registry.drain();
    if (!payload) {
      app._showError('The selected map file pushed no map. ' + reimport(TLV.params.map));
      return;
    }
    TLV.params.map = payload.id;

    var world = buildWorld(payload);
    if (!world) return;

    if (TLV.params.seed === null) TLV.params.seed = Date.now() >>> 0;
    var S = TLV.sim.create({ seed: TLV.params.seed, world: world, params: TLV.params });
    app.S = S;
    // A bot or a replay has no one to wait for when the window goes away.
    app.human = !TLV.params.autoplay;

    initViews(S);
    if (TLV.input && TLV.input.init) TLV.input.init(window, S);
    startLoop(S);

    // Nothing else calls render.resize.
    window.addEventListener('resize', function () {
      if (TLV.render && TLV.render.resize) TLV.render.resize(window.innerWidth, window.innerHeight);
    });

    watchPage();

    // Anything outside the loop, such as an input handler. The player must see that, not a frozen picture.
    window.addEventListener('error', function (e) {
      app._showError('The game stopped: ' + e.message);
    });
  };

  /**
   * Moves the loop, renderer and UI onto another sim, for TLV.debug.importReplay. Input stays off: the replay drives it.
   * @param {object} S The sim to show.
   */
  app.adopt = function (S) {
    app.human = false;
    app.loop.stop();
    if (TLV.render && TLV.render.dispose) TLV.render.dispose();
    app.S = S;
    initViews(S);
    startLoop(S);
  };
})(window.TLV);
