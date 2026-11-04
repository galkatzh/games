// js/ui/bubbles.js — WP-UI
// Speech bubbles, from the `bubble` event only. NPC speech is symbols, always: a bubble with a letter or a digit in it is refused here,
// whoever sent it, so no line of dialogue can ever reach the screen (GAME_DESIGN 21).
(function (TLV) {
  'use strict';

  var bubbles = TLV.ns('ui.bubbles');

  var layer = null;
  var live = [];

  /**
   * @param {string} text Candidate text.
   * @returns {boolean} True when it has no letters or digits of any script, and something to show.
   */
  bubbles.symbolsOnly = function (text) {
    return typeof text === 'string' && text.length > 0 && !/[\p{L}\p{N}]/u.test(text);
  };

  /** Builds the bubble layer. */
  bubbles.build = function (root) {
    layer = TLV.ui.el('div', 'bubbles', root);
    live = [];
  };

  function drop(i) {
    live[i].node.remove();
    live.splice(i, 1);
  }

  /**
   * Reacts to one event.
   * @param {object} S Sim state.
   * @param {string} name Event name.
   * @param {object} p Payload.
   */
  bubbles.onEvent = function (S, name, p) {
    var T = TLV.tune.ui;
    if (name === 'run.start') {
      while (live.length) drop(0);
      return;
    }
    if (name !== 'bubble') return;
    if (!bubbles.symbolsOnly(p.text)) {
      console.warn('Bubble refused, because it is not symbols only: ' + String(p.text));
      return;
    }
    for (var i = 0; i < live.length; i++) {
      if (live[i].who === p.who && live[i].id === p.id) {
        live[i].t = Math.min(p.ttl, T.bubbleTtlMaxS);
        TLV.ui.setText(live[i].node, p.text);
        return;
      }
    }
    if (live.length >= T.bubbleMax) drop(0);
    var node = TLV.ui.el('div', 'bubble off', layer, p.text);
    node.dir = 'ltr';
    live.push({ who: p.who, id: p.id, t: Math.min(p.ttl, T.bubbleTtlMaxS), node: node });
  };

  /** @returns {?object} The active record a bubble belongs to. */
  function owner(S, b) {
    var pool = b.who === 'veh' ? S.vehicles : S.peds;
    for (var i = 0; i < pool.length; i++) {
      if (pool[i].active && pool[i].id === b.id) return pool[i];
    }
    return null;
  }

  /**
   * Draws one frame.
   * @param {object} S Sim state.
   * @param {number} alpha Interpolation factor.
   * @param {number} dt Seconds, 0 while paused.
   */
  bubbles.frame = function (S, alpha, dt) {
    var T = TLV.tune.ui;
    var M = TLV.math;
    // The world stands behind the dimmed end and pause screens, but a white bubble does not dim with it.
    var dimmed = (!!S.game && S.game.phase === 'RUN_END') || !!TLV.ui.forcedWith('end.') || TLV.ui.isUserPaused() || TLV.ui.isForced('pause');
    TLV.ui.show(layer, !dimmed);
    for (var i = live.length - 1; i >= 0; i--) {
      var b = live[i];
      b.t -= dt;
      var who = owner(S, b);
      if (b.t <= 0 || !who) {
        drop(i);
        continue;
      }
      var z = b.who === 'veh' ? T.bubbleVehZ : T.bubblePedZ;
      var at = TLV.ui.project(M.lerp(who.px, who.x, alpha), M.lerp(who.py, who.y, alpha), z);
      var seen = !!at && at.visible;
      TLV.ui.show(b.node, seen);
      if (seen) b.node.style.transform = 'translate(' + at.sx.toFixed(1) + 'px,' + at.sy.toFixed(1) + 'px) translate(-50%,-100%)';
    }
  };

  /** @returns {string[]} Texts now live, for tests. */
  bubbles._texts = function () {
    return live.map(function (b) { return b.node.textContent; });
  };
})(window.TLV);
