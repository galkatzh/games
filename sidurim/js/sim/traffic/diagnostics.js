// js/sim/traffic/diagnostics.js — WP-TRAFFIC
// The two tools ARCHITECTURE 12.5 ships with the traffic, because one snapshot at the end of a run never found a root cause: a
// wait-for chain walker that follows only stationary blockers, and a delay budget by junction.
(function (TLV) {
  'use strict';

  /**
   * Wait-for chains and the delay budget by junction (ARCHITECTURE 12.5).
   * @param {object} S Sim state.
   * @returns {object} JSON-safe report.
   */
  var diagnostics = function (S) {
    return S.world ? report(S) : {};
  };

  TLV.ns('traffic').diagnostics = diagnostics;

  var WHY_NAMES = ['MOVING', 'RED', 'CONFLICT', 'PRIORITY', 'EXIT', 'EXCLUSIVE', 'QUEUE', 'CONTACT', 'FAR', 'DEAD_END'];
  var CHAIN_CAP = 64;

  /**
   * Creates the delay budget.
   * @param {object} S Sim state.
   */
  diagnostics.init = function (S) {
    var T = S.traffic;
    var nJ = S.world ? S.world.juncs.length : 0;
    T.delay = new Float32Array(nJ);
    T.delayWhy = new Float64Array(WHY_NAMES.length);
    T.delayStill = 0;
    T.delayAll = 0;
  };

  /**
   * Books a sample of who is standing still, and why. Once per maintain.
   * @param {object} S Sim state.
   * @param {number} dt Seconds this sample stands for.
   */
  diagnostics.sample = function (S, dt) {
    var T = S.traffic;
    var W = S.world;
    var Q = TLV.tune.traffic;
    for (var i = 0; i < T.nAct; i++) {
      var veh = S.vehicles[T.act[i]];
      if (veh.mode !== 'LANE' && veh.mode !== 'CONN') continue;
      T.delayAll += dt;
      if (veh.v >= Q.stuckV) continue;
      T.delayStill += dt;
      var t = veh._t;
      T.delayWhy[t.why] += dt;
      if (t.pn > 0) T.delay[W.conns[t.plan[0]].junc] += dt;
    }
  };

  /** @returns {?object} The car that holds this car still, if any. */
  function blockerOf(S, veh) {
    var T = S.traffic;
    var W = S.world;
    var WHY = TLV.traffic.gate.WHY;
    var t = veh._t;
    if (t.lead > 0 && t.leadGap < 8) return S.vehicles[t.lead];
    if (t.pn === 0) return null;
    var conn = W.conns[t.plan[t.pg < t.pn ? t.pg : 0]];
    if (t.why === WHY.CONFLICT) {
      for (var i = 0; i < conn.conflicts.length; i++) {
        var x = conn.conflicts[i];
        if (T.occ[x] <= 0) continue;
        for (var a = 0; a < T.nAct; a++) {
          var o = S.vehicles[T.act[a]];
          var u = o._t;
          for (var k = 0; k < u.hn; k++) {
            if (u.held[k] === x) return o;
          }
        }
      }
    }
    if ((t.why === WHY.EXIT || t.why === WHY.EXCLUSIVE) && T.mark[conn.to] === T.stamp) {
      var slot = T.eVeh[T.head[conn.to]];
      return slot > 0 ? S.vehicles[slot] : null;
    }
    return null;
  }

  /** @returns {object} JSON-safe row for one car. */
  function rowOf(veh) {
    return {
      id: veh.id, kind: veh.kind, beh: veh.beh, why: WHY_NAMES[veh._t.why], x: Math.round(veh.x), y: Math.round(veh.y),
      stuckT: Math.round(veh.stuckT)
    };
  }

  /** Walks one chain. @returns {object} Its length, whether it closes on itself, and its root. */
  function walk(S, start) {
    var seen = [];
    var at = start;
    while (at && seen.length < CHAIN_CAP) {
      if (seen.indexOf(at.slot) >= 0) return { len: seen.length, cycle: true, root: rowOf(at) };
      seen.push(at.slot);
      var next = blockerOf(S, at);
      if (!next || !next.active) break;
      if ((next.v > 0 ? next.v : -next.v) >= TLV.tune.traffic.stuckV) return { len: seen.length, cycle: false, root: rowOf(at), movingBlocker: true };
      at = next;
    }
    return { len: seen.length, cycle: false, root: rowOf(at || start) };
  }

  /** Builds the report. */
  function report(S) {
    var T = S.traffic;
    var W = S.world;
    var Q = TLV.tune.traffic;
    var chains = [];
    var cycles = 0;
    var i;
    for (i = 0; i < T.nAct; i++) {
      var veh = S.vehicles[T.act[i]];
      if (veh.stuckT < Q.l2S) continue;
      var c = walk(S, veh);
      if (c.cycle) cycles++;
      chains.push(c);
    }
    chains.sort(function (a, b) { return b.len - a.len || a.root.id - b.root.id; });
    var worst = [];
    for (i = 0; i < T.delay.length; i++) {
      if (T.delay[i] > 0) worst.push({ junc: i, s: Math.round(T.delay[i]) });
    }
    worst.sort(function (a, b) { return b.s - a.s || a.junc - b.junc; });
    var top = worst.slice(0, 10).map(function (r) {
      var j = W.juncs[r.junc];
      return { junc: r.junc, kind: j.kind, x: Math.round(j.x), y: Math.round(j.y), seconds: r.s };
    });
    var byWhy = {};
    for (i = 0; i < WHY_NAMES.length; i++) {
      if (T.delayWhy[i] > 0) byWhy[WHY_NAMES[i]] = Math.round(T.delayWhy[i]);
    }
    return {
      cars: T.nAct,
      stats: {
        count: T.stats.count, cap: T.stats.cap, meanSpeed: T.stats.meanSpeed, stationaryShare: T.stats.stationaryShare,
        removals: T.stats.removals, wrecks: T.stats.wrecks
      },
      levels: { l2: T.levels.l2, l3Despawn: T.levels.l3Despawn, l3Pull: T.levels.l3Pull, l4: T.levels.l4, tidy: T.levels.tidy },
      stuckMax: T.stuckMax,
      contacts: T.contacts,
      stillShare: T.delayAll > 0 ? T.delayStill / T.delayAll : 0,
      stillByWhy: byWhy,
      worstJunctions: top,
      cycles: cycles,
      chains: chains.slice(0, 8)
    };
  }
})(window.TLV);
