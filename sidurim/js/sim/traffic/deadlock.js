// js/sim/traffic/deadlock.js — WP-TRAFFIC
// The deadlock ladder (ARCHITECTURE 12.5). L0 is the importer's and L1 is the box rule in the gate. Here are L2, re-pick at the
// head of a blocked queue, L3, the watchdog with no distance guard, and L4, the bubble-wide brake on spawning.
(function (TLV) {
  'use strict';

  var deadlock = TLV.ns('traffic.deadlock');

  /** Largest number of cars L4 considers at once. */
  var STUCK_BUF = 200;

  /**
   * Creates the ladder's state.
   * @param {object} S Sim state.
   */
  deadlock.init = function (S) {
    var T = S.traffic;
    T.stuckBuf = new Int32Array(STUCK_BUF);
    T.levels = { l2: 0, l3Despawn: 0, l3Pull: 0, l4: 0, tidy: 0 };
    T.stuckMax = 0;
  };

  /** @returns {number} Seconds a car on this approach may stand still. */
  function watchdog(S, veh) {
    var Q = TLV.tune.traffic;
    var W = S.world;
    var t = veh._t;
    var limit = Q.watchdogS;
    if (t.pn > 0) {
      var ctrl = W.juncs[W.conns[t.plan[0]].junc].ctrl;
      if (ctrl >= 0) {
        var byCycle = Q.watchdogCycles * W.ctrls[ctrl].cycleS;
        if (byCycle > limit) limit = byCycle;
      }
    }
    return limit;
  }

  deadlock.watchdog = watchdog;

  /**
   * Keeps a car's stuck clock.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {number} dt Tick, seconds.
   */
  deadlock.tick = function (S, veh, dt) {
    var Q = TLV.tune.traffic;
    var moving = veh.mode !== 'LANE' && veh.mode !== 'CONN';
    if (moving || (veh.v > 0 ? veh.v : -veh.v) >= Q.stuckV) veh.stuckT = 0;
    else if (!TLV.traffic.behaviours.WATCHDOG_EXEMPT[veh.beh]) veh.stuckT += dt;
  };

  /**
   * L2: a queue head blocked for 5 s, not on red, takes any connector that passes the gate. Run at FSM rate.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   */
  deadlock.requeue = function (S, veh) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var WHY = TLV.traffic.gate.WHY;
    var t = veh._t;
    if (veh.mode !== 'LANE' || veh.stuckT < Q.l2S || t.pg > 0) return;
    if (t.why === WHY.RED || t.why === WHY.FAR || t.why === WHY.OK || t.why === WHY.QUEUE) return;
    if (TLV.traffic.gate.repick(S, veh)) {
      T.levels.l2++;
      veh.stuckT = 0;
    }
  };

  /**
   * Takes a stuck car out of the lanes, in view: hazards, a move off the road, then gone.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   */
  deadlock.pullOver = function (S, veh) {
    var Q = TLV.tune.traffic;
    var W = S.world;
    var T = S.traffic;
    var t = veh._t;
    var beh = TLV.traffic.behaviours;
    var shift = 0;
    var clearsLane = false;
    var lane = veh.mode === 'LANE' ? W.lanes[veh.laneId] : null;
    if (lane) {
      // It stays on the road. Past the kerb are the people waiting to cross.
      var e = W.edges[lane.edge];
      var dir = W.dirEdges[lane.dirEdge].dir;
      var side = 0;
      var strip = 0;
      if (lane.right < 0) {
        side = -1;
        strip = dir === 0 ? e.parkR : e.parkL;
      } else if (lane.left < 0 && lane.opposite < 0) {
        side = 1;
        strip = dir === 0 ? e.parkL : e.parkR;
      }
      var want = lane.width / 2 + t.halfW + Q.pullOverPad;
      var room = lane.width / 2 + strip - t.halfW;
      clearsLane = room >= want;
      shift = side * Math.min(want, Math.max(0, room)) - veh.lat;
    }
    var x = veh.x - t.sinH * shift;
    var y = veh.y + t.cosH * shift;
    var bare = veh.beh;
    if (bare !== 'CRUISE') beh.toCruise(S, veh);
    beh.script(S, veh, beh.SK.PULL_OVER, x, y, veh.h, Math.max(0.3, Q.pullOverS * Math.abs(shift) / 1.5));
    t.obLane = -1;
    t.timer = clearsLane ? Q.pullOverMaxS : Q.pullOverStuckS;
    veh.stuckT = 0;
    veh.lights |= TLV.const.VL.HAZARD;
    beh.set(S, veh, 'PULL_OVER');
    T.levels.l3Pull++;
  };

  /** Clears the worst blockers out of sight, longest stuck first. */
  function clearUnseen(S, n, stuckS) {
    var T = S.traffic;
    var buf = T.stuckBuf;
    var count = 0;
    var i;
    for (i = 0; i < T.nAct; i++) {
      var veh = S.vehicles[T.act[i]];
      // Only a car with nowhere to be. A rival waiting at a light is on his way to the player's bay, seen or not.
      if (veh.beh === 'CRUISE' && veh.stuckT >= stuckS && !TLV.traffic.visibleToPlayer(S, veh.x, veh.y)) {
        var k = count++;
        while (k > 0 && S.vehicles[buf[k - 1]].stuckT < veh.stuckT) {
          buf[k] = buf[k - 1];
          k--;
        }
        buf[k] = veh.slot;
      }
    }
    var done = count < n ? count : n;
    for (i = 0; i < done; i++) TLV.traffic.despawn(S, S.vehicles[buf[i]], 'watchdog');
    return done;
  }

  /**
   * L3 and L4, once per maintain.
   * @param {object} S Sim state.
   */
  deadlock.maintain = function (S) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var stuck = 0;
    var i;
    for (i = T.nAct - 1; i >= 0; i--) {
      var veh = S.vehicles[T.act[i]];
      if (veh.mode !== 'LANE' && veh.mode !== 'CONN') continue;
      if (veh.stuckT >= Q.l4StuckS) stuck++;
      if (veh.stuckT > T.stuckMax) T.stuckMax = veh.stuckT;
      // The end of a road off the network leads nowhere, so a car there has nothing to wait for.
      var deadEnd = veh._t.pn === 0 && veh.stuckT >= Q.deadEndS && !TLV.traffic.visibleToPlayer(S, veh.x, veh.y);
      // Two bodies each held back by the other through a junction wait for ever, and hold a green with them: a bus swinging round the
      // nose of a truck at the line stood out two whole cycles on the tutorial's road. Nothing but the ladder ends that, so it comes early.
      var locked = veh._t.soft && veh.stuckT >= Q.softLockS && veh._t.why !== TLV.traffic.gate.WHY.RED;
      if (!deadEnd && !locked && (veh.stuckT <= watchdog(S, veh) || TLV.traffic.behaviours.WATCHDOG_EXEMPT[veh.beh])) continue;
      if (TLV.traffic.visibleToPlayer(S, veh.x, veh.y)) {
        deadlock.pullOver(S, veh);
      } else {
        T.levels.l3Despawn++;
        TLV.traffic.despawn(S, veh, 'watchdog');
      }
      T.stats.removals++;
    }
    T.noSpawn = T.nAct > 0 && stuck > Q.l4Share * T.nAct;
    if (T.noSpawn) {
      T.levels.l4++;
      clearUnseen(S, Q.l4Clear, Q.l4StuckS);
    } else if (T.stats.stationaryShare > Q.tidyShare) {
      // The same remedy, short of the alarm. A bubble round a player who is not moving has no other way to lose a queue, because its
      // cars never leave it. One out of sight is worth more driving where the spawner will put it than standing where it is.
      T.levels.tidy += clearUnseen(S, Q.tidyClear, Q.tidyS);
    }
  };
})(window.TLV);
