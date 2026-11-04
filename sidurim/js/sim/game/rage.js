// js/sim/game/rage.js — WP-GAME
// Rage and its tier (GAME_DESIGN 14). Rage is pure on the contest, so the gauge can show it live and the player can read it
// before committing. The tier applies the knife rules, so a forbidden knife becomes BLOCK.
(function (TLV) {
  'use strict';

  var rage = TLV.ns('game.rage');

  /** @returns {boolean} True where the first knife is due: errand 2 or 3, none yet (GAME_DESIGN 14). */
  function firstKnifeDue(S) {
    var g = S.game;
    return g.knivesDone === 0 && g.errandIndex >= 1 && g.errandIndex <= TLV.tune.game.forcedKnifeLast;
  }

  /**
   * Rage of the current contest.
   * @param {object} S Sim state.
   * @returns {number} 0 with no contest. Errand caps and the first-knife floor are applied.
   */
  rage.compute = function (S) {
    var g = S.game;
    var c = g.contest;
    if (!c) return 0;
    var T = TLV.tune.game;
    var f = c.factors;
    var r = c._rageForced !== null && c._rageForced !== undefined ? c._rageForced : (
      T.rageBase + (f.blinkerFirst ? T.rageBlinker : 0) + (f.passed ? T.ragePassed : 0) + (f.close ? T.rageClose : 0) +
      (f.honked ? T.rageHonk : 0) + f.steals * T.ragePerSteal);
    if (c._rageForced === null || c._rageForced === undefined) {
      if (firstKnifeDue(S) && r < T.tierKnife) r = T.tierKnife;
    }
    if (g.errandIndex === 0 && r > T.rageCapFirst) r = T.rageCapFirst;
    if (g.errandIndex === T.legs.length - 1 && r > T.rageCapFinale) r = T.rageCapFinale;
    return r;
  };

  /** @returns {boolean} True when GAME_DESIGN 14 allows a knife on this errand, at this bay. */
  function knifeAllowed(S) {
    var g = S.game;
    var T = TLV.tune.game;
    var e = g.errand;
    if (!e || g.errandIndex === 0 || g.errandIndex === T.legs.length - 1) return false;
    if (S.params.knife === 'off') return false;
    if (S.params.knife === 'force') return true;
    if (g.knivesDone >= T.knifeMax) return false;
    if (g.lastKnifeErrand >= 0 && g.errandIndex - g.lastKnifeErrand <= 1) return false;
    return TLV.game.parking._doorDistance(S) <= T.knifeBayM;
  }

  /**
   * The tier for a rage value, under the knife rules.
   * @param {object} S Sim state.
   * @param {number} value Rage.
   * @returns {string} 'CURSE', 'BLOCK' or 'KNIFE'.
   */
  rage.tier = function (S, value) {
    var T = TLV.tune.game;
    if (S.params.knife === 'force' && knifeAllowed(S)) return 'KNIFE';
    if (value < T.tierBlock) return 'CURSE';
    if (value < T.tierKnife) return 'BLOCK';
    return knifeAllowed(S) ? 'KNIFE' : 'BLOCK';
  };
})(window.TLV);
