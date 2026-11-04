// js/core/debug.js — WP-CORE
// Test and tool hooks (ARCHITECTURE 16.2). They are always present. Hooks never take S: they act on current(). All return
// JSON-serializable values, safe for page.evaluate.
(function (TLV) {
  'use strict';

  var debug = TLV.ns('debug');

  var currentSim = null;

  /** Names of the registry functions themselves, which a hook must not replace. */
  var RESERVED = { register: true, use: true, current: true };

  /**
   * Exposes a hook as TLV.debug[name]. Owners call this in their register().
   * @param {string} name Hook name.
   * @param {function} fn Hook. Takes no S.
   */
  debug.register = function (name, fn) {
    if (RESERVED[name]) {
      console.warn('TLV.debug: refusing to replace ' + name);
      return;
    }
    debug[name] = fn;
  };

  /**
   * Sets the sim that hooks act on. createSim calls this in Node.
   * @param {object} S Sim state.
   */
  debug.use = function (S) {
    currentSim = S;
  };

  /** @returns {?object} The sim set by use, else TLV.app.S in the browser, else null. */
  debug.current = function () {
    return currentSim || (TLV.app && TLV.app.S) || null;
  };

  /** @returns {number} Active non-player records in a pool. */
  function countActive(pool) {
    var n = 0;
    for (var i = 0; i < pool.length; i++) {
      if (pool[i].active && !pool[i].isPlayer) n++;
    }
    return n;
  }

  /** @returns {*} A JSON-safe deep copy. */
  function plain(v) {
    return v === undefined ? null : JSON.parse(JSON.stringify(v));
  }

  /**
   * Snapshot of the sim for tests (ARCHITECTURE 16.2).
   * @returns {?object} State, or null with no sim. player.x and y are the focus point, so they follow the person on foot.
   */
  debug.state = function () {
    var S = debug.current();
    if (!S) return null;
    var g = S.game || {};
    var p = S.player || {};
    var veh = S.vehicles[0];
    var onFoot = p.mode === 'FOOT' && p.foot;
    var errand = g.errand || null;
    var stats = S.traffic && S.traffic.stats;
    var director = g.director || null;
    return {
      tick: S.tick,
      t: S.t,
      seed: S.seed,
      map: S.world ? S.world.id : null,
      phase: g.phase || null,
      phaseT: g.phaseT || 0,
      clock: g.clock || 0,
      money: g.money || 0,
      hp: g.hp || 0,
      heat: g.heat || 0,
      errandIndex: g.errandIndex || 0,
      errandId: errand ? errand.defId : null,
      doorX: errand ? errand.doorX : 0,
      doorY: errand ? errand.doorY : 0,
      bayId: errand ? errand.bayId : -1,
      player: {
        mode: p.mode || null,
        x: p.fx || 0,
        y: p.fy || 0,
        h: onFoot ? p.foot.h : veh.h,
        v: onFoot ? p.foot.v : veh.v,
        laneId: p.laneId === undefined ? -1 : p.laneId,
        surface: p.surface || 0,
        wrongWay: !!p.wrongWay
      },
      counts: {
        vehicles: countActive(S.vehicles),
        peds: countActive(S.peds),
        target: stats ? stats.cap : 0
      },
      traffic: {
        meanSpeed: stats ? stats.meanSpeed : 0,
        stationaryShare: stats ? stats.stationaryShare : 0
      },
      contest: g.contest ? {
        state: g.contest.state, rage: g.contest.rage, tier: g.contest.tier, rivalId: g.contest.rivalId
      } : null,
      knife: g.knife ? {
        stage: g.knife.stage, strikes: g.knife.strikes, gap: g.knife.gap, exit: g.knife.exit
      } : null,
      incidents: director ? director.incidents.map(function (i) {
        return { id: i.id, defId: i.defId, state: i.state };
      }) : [],
      chain: g.chain ? { n: g.chain.n, mult: g.chain.mult, bank: g.chain.bank } : { n: 0, mult: 1, bank: 0 },
      park: g.park ? { stage: g.park.stage, kind: g.park.kind, bar: g.park.bar } : { stage: null, kind: null, bar: 0 },
      stats: plain(g.stats),
      endReason: g.endReason === undefined ? null : g.endReason,
      rank: g.rank === undefined ? null : g.rank,
      problems: TLV.registry.problems().length,
      invariantFailures: S._invariantTotal || S.invariantFailures.length
    };
  };

  /** @returns {?number} TLV.sim.hash of the current sim. */
  debug.hash = function () {
    var S = debug.current();
    return S ? TLV.sim.hash(S) : null;
  };

  /** @returns {?object} The browser loop, or null in Node. */
  function browserLoop() {
    return (TLV.app && TLV.app.loop) || null;
  }

  /** Pauses the browser loop. @returns {boolean} False when there is no loop. */
  debug.pause = function () {
    var loop = browserLoop();
    if (loop) loop.pause();
    return !!loop;
  };

  /** Resumes the browser loop. @returns {boolean} False when there is no loop. */
  debug.resume = function () {
    var loop = browserLoop();
    if (loop) loop.resume();
    return !!loop;
  };

  /**
   * Runs ticks synchronously, paused or not.
   * @param {number} [n=1] Tick count.
   * @returns {?number} The tick reached.
   */
  debug.step = function (n) {
    var S = debug.current();
    if (!S) return null;
    var count = n === undefined ? 1 : n;
    var loop = browserLoop();
    if (loop && S === TLV.app.S) {
      loop.stepN(count);
    } else {
      for (var i = 0; i < count; i++) TLV.sim.step(S);
    }
    return S.tick;
  };

  /**
   * Overrides ControlState fields until cleared. Successive calls merge. Fields not in ControlState are ignored.
   * The sim applies this after the control source and before the recorder, so a log holds what the sim saw.
   * @param {?object} partial Fields to force, or null to clear them all.
   * @returns {boolean} False when there is no sim.
   */
  debug.setInput = function (partial) {
    var S = debug.current();
    if (!S) return false;
    if (partial === null || partial === undefined) {
      // The default control source returns S.controls itself, so forced values would otherwise stay after clearing.
      if (S._input) {
        var rest = TLV.const._newControls();
        for (var key in S._input) S.controls[key] = rest[key];
      }
      S._input = null;
      return true;
    }
    var known = TLV.const._newControls();
    var next = S._input || {};
    for (var field in partial) {
      if (Object.prototype.hasOwnProperty.call(known, field)) next[field] = partial[field];
    }
    S._input = next;
    return true;
  };

  /** @returns {?object} ReplayLog of the current sim, or null unless it runs with record=1. */
  debug.exportReplay = function () {
    var S = debug.current();
    return S && S.recorder ? S.recorder.finish() : null;
  };

  /**
   * Starts a fresh sim from a log, on the current world, and makes it the current sim. In the browser TLV.app.adopt
   * also moves the loop, renderer and UI onto it. Seed, params and flags all come from the log, because a log replays
   * only under what it ran with; only the world and allowMissing come from the current sim.
   * @param {object} log ReplayLog from exportReplay.
   * @returns {?{seed:number,ticks:number}} What will replay, or null with no sim or no log.
   */
  debug.importReplay = function (log) {
    var S = debug.current();
    if (!S || !log || !log.header) return null;
    var params = Object.assign({}, log.header.params, { autoplay: null });
    var next = TLV.sim.create({
      seed: log.header.seed,
      world: S.world,
      params: params,
      controlSource: TLV.replay.createPlayer(log),
      allowMissing: S._allowMissing
    });
    if (TLV.app && typeof TLV.app.adopt === 'function') TLV.app.adopt(next);
    else debug.use(next);
    var ticks = 0;
    (log.inputs || []).forEach(function (run) { ticks += run[0]; });
    return { seed: next.seed, ticks: ticks };
  };
})(window.TLV);
