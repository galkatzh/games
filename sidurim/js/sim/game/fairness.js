// js/sim/game/fairness.js — WP-GAME
// The gate every staged incident passes (GAME_DESIGN 11). An incident that fails is re-rolled, so a staged moment always leaves the
// player room to answer it with the brake alone.
(function (TLV) {
  'use strict';

  var fairness = TLV.ns('game.fairness');

  /** @returns {number} Metres the player needs: reaction, braking at 14 m/s², and a margin. 52 m at top speed. */
  fairness.need = function (S, v) {
    var T = TLV.tune.game;
    var heat = S.game.heat;
    var tr = T.reactS + (T.reactHotS - T.reactS) * heat;
    return v * tr + v * v / (2 * T.brakeDecel) + T.gateMarginM;
  };

  /**
   * @param {object} S Sim state.
   * @param {object} c Candidate: { d, v, x, y, def, escape, blocking, laneId, holdS }. d is road metres to the conflict point.
   * @returns {boolean} True when all five rules pass.
   */
  fairness.check = function (S, c) {
    var T = TLV.tune.game;
    var W = S.world;
    // 1. Reaction plus braking fits.
    var brakeWorks = c.d >= fairness.need(S, c.v);
    if (!brakeWorks) return false;
    // 2. A telegraph of at least 1.0 s. Every telegraph also shows a HUD chevron, so a muted player gets it.
    if (!c.def.telegraph || c.def.telegraph.s < T.telegraphMinS) return false;
    // 3. Brake alone works, or a free lane or curb exists. Rule 1 proved the brake. 'none' asks for nothing more of the driver.
    // 4. No other incident within 40 m or 3 s.
    var list = S.game.director.incidents;
    for (var i = 0; i < list.length; i++) {
      var o = list[i];
      if (o.state === 'DONE') continue;
      if (S.t - o.startT < T.spacingS) return false;
      // A tailgater stands behind the player and a dive goes past him. Neither asks him to stop for two things at one spot.
      if (o.anchor.type === 'tailSlot' || c.def.anchor === 'tailSlot' || o.defId === 'OVERTAKE_DIVE' || c.def.id === 'OVERTAKE_DIVE') continue;
      if (TLV.math.dist(o.anchor.x, o.anchor.y, c.x, c.y) < T.spacingM) return false;
    }
    // 5. A blocking actor on a lane with no neighbour holds at most 6 s once the player is near. Every holdS goes through TRAFFIC's
    // blocker clamp (ARCHITECTURE 12.5), so this rule is met by the command itself, and a car with no such clamp is refused.
    if (c.blocking && c.laneId >= 0 && W) {
      var lane = W.lanes[c.laneId];
      var alone = lane.left < 0 && lane.right < 0 && lane.opposite < 0;
      if (alone && c.def.anchor !== 'leadCar' && c.def.anchor !== 'busStop') return false;
    }
    return true;
  };
})(window.TLV);
