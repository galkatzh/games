// tests/core/stubs/soak_spawner.js — WP-CORE
// Replaces every other package for tests/core/soak.test.mjs: a spawner that tops up S.vehicles to its density target.
// It stands in for WP-TRAFFIC so the soak harness can be proven on its own. window.__soakFill scales how far the spawner
// really gets: soak_broken_fill.js sets it to play a broken spawner. window.__soakThrow makes the sim throw, and
// window.__soakDrift hides a source of nondeterminism in the sim.
//
// window.__soak, from soak_options.js, plays a sim that lies or breaks:
//   cap                  Reports this as stats.cap and spawns to it, whatever the density.
//   capReported          Reports this as stats.cap and spawns to the density as usual. May be a string such as 'NaN'.
//   collapseAt           From this tick on, reports cap 0 and removes every car.
//   dropAt               From this tick on, removes every car and goes on reporting its cap.
//   thinAt, thinCap      From this tick on, lowers its target to thinCap and meets it, as the adaptive rule does on a thin road.
//   meanSpeed, stationary  Reported stats. May be a string such as 'NaN'.
//   nanField, nanAt      Makes one stats field NaN on one tick.
//   game                 Feeds the Invariants, Contest and Fairness gates good data, so strict mode reaches a verdict and only
//                        the gate a test aims at can fail.
//   contestsDropped      With game: then starts this many contests with no result. Each replaces the last, and the last stays open.
//   contestBlink         Those contests reach BLINK in view.
//   strayResult          Prints a broken result line in the middle of the run.
//   unreadable           Leaves a result the gates cannot read.
(function (TLV) {
  'use strict';

  var WORLD = { id: 'soak_stub', lanes: [] };
  var DEFAULT_TARGET = 100;
  var opts = window.__soak || {};

  function target(S) {
    if (opts.thinAt && S.tick >= opts.thinAt) return opts.thinCap;
    if (opts.cap !== undefined) return opts.cap;
    return S.params.density === null ? DEFAULT_TARGET : S.params.density;
  }

  /** @returns {number} An option as a number, so 'NaN' works. */
  function option(value, fallback) {
    return value === undefined ? fallback : Number(value);
  }

  /** Good contests and incidents: 30% lost, all seen, all avoided. */
  function playGame(S) {
    for (var i = 0; i < 10; i++) {
      S.bus.emit('contest.start', { rivalId: 1, spotId: 1 });
      S.bus.emit('contest.state', { state: 'BLINK' });
      S.bus.emit('contest.result', { winner: i < 3 ? 'rival' : 'player', tier: null });
      S.bus.emit('incident.end', { id: i, defId: 'stub', outcome: 'AVOIDED' });
    }
    for (var d = 0; d < (opts.contestsDropped || 0); d++) {
      S.bus.emit('contest.start', { rivalId: 1, spotId: 1 });
      if (opts.contestBlink) S.bus.emit('contest.state', { state: 'BLINK' });
    }
  }

  /** Removes active cars until at most keep are left. */
  function removeCars(S, keep) {
    var count = 0;
    for (var i = 1; i < S.vehicles.length; i++) {
      if (S.vehicles[i].active && ++count > keep) S.vehicles[i].active = false;
    }
  }

  /** Makes one stats field NaN on one tick, then puts it back. */
  function poisonStats(S) {
    var stats = S.traffic.stats;
    if (S.tick === opts.nanAt) {
      S.traffic.held = stats[opts.nanField];
      stats[opts.nanField] = NaN;
    } else if (S.tick === opts.nanAt + 1) {
      stats[opts.nanField] = S.traffic.held;
    }
  }

  function noop() {}

  TLV.ns('world').get = function () { return WORLD; };
  TLV.ns('world').register = function () {
    if (opts.game) TLV.invariants.register('stub.ok', function () { return null; });
  };

  var signals = TLV.ns('world.signals');
  signals.init = noop;
  signals.update = noop;
  TLV.ns('world.parking').init = noop;

  var traffic = TLV.ns('traffic');
  traffic.byId = function () { return { x: 0, y: 0 }; };
  traffic.visibleToPlayer = function () { return true; };
  traffic.init = function (S) {
    S.traffic = {
      nextId: 1,
      stats: {
        count: 0, cap: option(opts.capReported, target(S)), meanSpeed: option(opts.meanSpeed, 6), stationaryShare: option(opts.stationary, 0.2),
        removals: 0, wrecks: 0
      }
    };
  };
  traffic.update = function (S, dt) {
    if (opts.game && S.tick === 100) playGame(S);
    if (opts.nanField) poisonStats(S);
    if (opts.strayResult && S.tick === 50) console.log('SOAK_RESULT {not json');
    if (opts.unreadable) S._invariantCounts = null;
    for (var i = 1; i < S.vehicles.length; i++) {
      var veh = S.vehicles[i];
      if (veh.active) {
        veh.x += S.rng.traffic.range(-1, 1) * dt;
        veh.y += S.rng.traffic.range(-1, 1) * dt;
        if (window.__soakDrift) veh.x += window.__soakDrift();
      }
    }
  };
  traffic.maintain = function (S) {
    if (opts.collapseAt && S.tick >= opts.collapseAt) {
      S.traffic.stats.cap = 0;
      removeCars(S, 0);
      return;
    }
    if (opts.dropAt && S.tick >= opts.dropAt) {
      removeCars(S, 0);
      return;
    }
    if (opts.thinAt && S.tick >= opts.thinAt) {
      S.traffic.stats.cap = opts.thinCap;
      removeCars(S, opts.thinCap);
    }
    if (S.tick % 15) return;
    if (window.__soakThrow && S.tick > 60) throw new Error('stub sim failure');
    var fill = window.__soakFill === undefined ? 1 : window.__soakFill;
    var want = Math.min(target(S) * fill, S.vehicles.length - 1);
    var count = 0;
    var i;
    for (i = 1; i < S.vehicles.length; i++) {
      if (S.vehicles[i].active) count++;
    }
    for (i = 1; i < S.vehicles.length && count < want; i++) {
      var veh = S.vehicles[i];
      if (!veh.active) {
        veh.active = true;
        veh.id = S.traffic.nextId++;
        veh.x = S.rng.spawn.range(-80, 80);
        veh.y = S.rng.spawn.range(-80, 80);
        count++;
      }
    }
    S.traffic.stats.count = count;
  };

  var peds = TLV.ns('peds');
  peds.init = noop;
  peds.update = noop;
  peds.maintain = noop;

  TLV.ns('player').update = noop;
  TLV.ns('foot').update = noop;
  TLV.ns('collide').update = noop;

  TLV.ns('game.flow').preUpdate = noop;
  TLV.ns('game.flow').postUpdate = noop;
  TLV.ns('game.director').update = noop;
  TLV.ns('game.parking').update = noop;
  TLV.ns('game.knife').update = noop;
  TLV.ns('game.score').update = noop;
})(window.TLV);
