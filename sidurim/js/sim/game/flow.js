// js/sim/game/flow.js — WP-GAME
// Phases, the clock, and the run (ARCHITECTURE 10.9). flow.startRun and the next-errand path are the only places that set an errand
// up. Registration of this package also lives here, as the last file of the package to load.
(function (TLV) {
  'use strict';

  var game = TLV.ns('game');
  var flow = TLV.ns('game.flow');

  /** @returns {object} S.game._g: everything this package keeps between ticks that is nobody else's to read. */
  function newPrivate(S) {
    return {
      plan: [], from: { x: 0, y: 0, h: 0 },
      nav: TLV.game.nav._newState(),
      park: TLV.game.parking._newState(),
      dir: TLV.game.director._newState(),
      staged: new Map(), inspectors: [],
      cars: [], proj: { s: 0, d: 0, side: 0 }, pt: { x: 0, y: 0, h: 0 }, box: { x: 0, y: 0, h: 0, length: 0, width: 0 },
      contestDue: false, contestT: 0, playerV: 0, warned: 0, recoverT: 0, recoverSpent: false, phaseSave: 0, revealed: false, heatForced: false,
      pull: { state: 'NONE', t: 0, x: 0, y: 0, h: 0 }, searched: false, lanes: new Int32Array(48),
      runDifficulty: TLV.tune.game.difficultyDefault, keysHeld: 0, keysStale: 0
    };
  }

  /** @returns {boolean} True for an id in the difficulty table, and for nothing that Object.prototype holds. */
  function knownDifficulty(id) {
    return Object.prototype.hasOwnProperty.call(TLV.tune.game.difficulty, id);
  }

  /** Bits of the ControlState fields that can skip a card or restart a run. */
  var KEY_INTERACT = 1;
  var KEY_START = 2;
  var KEY_RESTART = 4;

  /** Changes phase and restarts its timer. A key already down here is stale until it is let go. Private to this package. */
  flow._setPhase = function (S, phase) {
    var gg = S.game._g;
    S.game.phase = phase;
    S.game.phaseT = 0;
    gg.keysStale = gg.keysHeld;
  };

  /** Reads this tick's keys. A key that comes up stops being stale. */
  function trackKeys(S) {
    var c = S.controls;
    var gg = S.game._g;
    gg.keysHeld = (c.interact ? KEY_INTERACT : 0) | (c.start ? KEY_START : 0) | (c.restart ? KEY_RESTART : 0);
    gg.keysStale &= gg.keysHeld;
  }

  /** @returns {boolean} True when one of these keys was pressed since the phase began. One held from before it never counts. */
  function freshPress(S, keys) {
    var gg = S.game._g;
    return (gg.keysHeld & ~gg.keysStale & keys) !== 0;
  }

  /**
   * Creates S.game at TITLE and starts the rest of the package. Never calls startRun: with notitle that waits for the first
   * preUpdate, so run.start reaches a UI that enabled its drain after this.
   * @param {object} S Sim state.
   */
  flow.init = function (S) {
    S.game = TLV.const.newGameState();
    S.game._g = newPrivate(S);
    var asked = S.params.difficulty;
    if (asked !== undefined && asked !== null && !knownDifficulty(asked)) console.warn('TLV.game: ignoring difficulty=' + String(asked));
    S.game.difficulty = knownDifficulty(asked) ? asked : TLV.tune.game.difficultyDefault;
    TLV.game.score.init(S);
    TLV.game.rival.init(S);
    TLV.game.parking.init(S);
    TLV.game.director.init(S);
    TLV.player.setLocked(S, true);
  };

  /** Removes what a run left in the street. */
  function sweep(S, old) {
    if (old.contest) TLV.game.rival._release(S, old.contest, true);
    if (old.knife) {
      var man = TLV.peds.byId(S, old.knife.attackerId);
      if (man) TLV.peds.despawn(S, man);
      var car = old.knife.rivalVehId >= 0 ? TLV.traffic.byId(S, old.knife.rivalVehId) : null;
      if (car) TLV.traffic.despawn(S, car, 'script');
    }
    if (old.errand) {
      old.errand.decoys.forEach(function (d) {
        var p = d.pedId >= 0 ? TLV.peds.byId(S, d.pedId) : null;
        if (p) TLV.peds.despawn(S, p);
      });
    }
    old._g.inspectors.forEach(function (id) {
      var p = TLV.peds.byId(S, id);
      if (p) TLV.peds.despawn(S, p);
    });
    TLV.game.director._reset(S, old);
  }

  /** Awards and route length, once the first bay is set (GAME_DESIGN 7). */
  function lockAward(S, e, index) {
    var T = TLV.tune.game;
    var nav = S.game.nav;
    e.routeLen = nav.route ? nav.route.len : e._doorRoute.len;
    e.award = (e.routeLen / T.awardDiv + T.awardBase) * (1 - T.kStep * index) * T.difficulty[S.game._g.runDifficulty].awardScale;
  }

  /**
   * Binds an errand from the plan, skipping any the map cannot bind, then stages its block.
   * @param {object} S Sim state.
   * @param {number} index Errand to start from.
   * @param {boolean} [first] True for a run's first errand, which sends run.start ahead of errand.start (ARCHITECTURE 12.7).
   * @param {object} [bound] An errand already bound, from a shared board. The plan is not read, and index is its place in the day.
   * @returns {boolean} False at the end of the plan.
   */
  function setupErrand(S, index, first, bound) {
    var g = S.game;
    var gg = g._g;
    var T = TLV.tune.game;
    var at = index;
    var e = bound || null;
    while (at < gg.plan.length && !e) {
      e = TLV.game.errands.bind(S, at);
      if (!e) at++;
    }
    if (!e) return false;
    g.errand = e;
    g.errandIndex = at;
    if (S.params.heat !== null && S.params.heat !== undefined) g.heat = S.params.heat;
    else if (!gg.heatForced) g.heat = Math.min(1, at / (T.legs.length - 1));
    TLV.game.parking.stageBlock(S);
    var bay = e.bayId >= 0 ? TLV.world.parking.spot(S.world, e.bayId) : null;
    var from = gg.from;
    if (bay) TLV.game.nav._setTargetFrom(S, bay.laneId, bay.laneS, bay.x, bay.y, from.x, from.y, from.h);
    else TLV.game.nav._setTargetFrom(S, e._doorLane, e._doorLaneS, e.doorX, e.doorY, from.x, from.y, from.h);
    lockAward(S, e, at);
    gg.searched = false;
    if (S.flags.traffic) TLV.traffic._calm(S, at === 0 ? g.nav.route : null);
    TLV.game.director._newErrand(S);
    if (first) S.bus.emit('run.start', { seed: S.seed });
    S.bus.emit('errand.start', { index: at, defId: e.defId });
    return true;
  }

  /** A day with no way to reach the next door. It is not won: the run ends as the clock would have ended it, with the map named. */
  function noDay(S) {
    TLV.registry.problem('errand', String(S.world ? S.world.id : '?'), 'no door or stall can be reached for errand ' + (S.game.errandIndex + 1));
    flow.endRun(S, 'CLOCK');
  }

  /**
   * Starts a run, in the binding order of ARCHITECTURE 12.7.
   * @param {object} S Sim state.
   * @param {object} [opts] { errandIndex?, defId?, clock? }.
   */
  flow.startRun = function (S, opts) {
    var o = opts || {};
    var old = S.game;
    var T = TLV.tune.game;
    // 1.
    S.game = TLV.const.newGameState();
    var g = S.game;
    g._g = newPrivate(S);
    // The choice outlives the run it was made in. What this run plays is fixed here, so a change takes effect at the next one.
    g.difficulty = old.difficulty;
    g._g.runDifficulty = old.difficulty;
    g.director.nextT = 0;
    // 2, 3.
    if (S.world) TLV.world.parking.reset(S);
    S.timeScale = 1;
    sweep(S, old);
    // 4.
    var sp = TLV.game.errands.spawnPoint(S);
    if (S.player.mode === 'FOOT') TLV.foot.exit(S);
    if (sp) TLV.player.setPose(S, sp.x, sp.y, sp.h, 0);
    TLV.player.setLocked(S, true);
    S.player.veh.door = 0;
    if (sp) {
      // 5.
      var near = g._g.cars;
      var n = TLV.traffic.vehiclesNear(S, sp.x, sp.y, T.spawnClearM, near);
      for (var i = 0; i < n; i++) {
        if (!near[i].isPlayer) TLV.traffic.despawn(S, near[i], 'script');
      }
      // 6.
      if (sp.tailCar && S.flags.traffic) {
        TLV.traffic.spawn(S, { laneId: sp.laneId, s: sp.s - T.tailCarBackM, v: 0, ag: T.tailCarAg, force: true });
      }
    }
    // 7.
    if (S.flags.traffic) TLV.traffic.prewarm(S);
    // 8.
    if (sp && sp.connId >= 0) TLV.world.signals.alignGreen(S, sp.connId, sp.greenInS);
    // 9.
    var asked = S.params.clockGiven ? S.params.clock : T.difficulty[g.difficulty].startS;
    g.clock = o.clock !== undefined ? o.clock : asked;
    g.hp = T.hpStart;
    var veh = S.player.veh;
    g._g.from = { x: veh.x, y: veh.y, h: veh.h };
    g._g.plan = TLV.game.errands.plan(S);
    var index = o.errandIndex !== undefined ? o.errandIndex : S.params.errand - 1;
    index = Math.min(index, Math.max(0, g._g.plan.length - 1));
    var forced = o.defId !== undefined ? o.defId : S.params.errandDef;
    if (forced && g._g.plan.length) g._g.plan[index] = forced;
    flow._setPhase(S, 'CARD');
    // A shared day has a board, not a plan: the car waits at the spawn, on the card, until its driver has picked from it.
    if (o.versus && S.world) {
      g._g.plan = [];
      S.bus.emit('run.start', { seed: S.seed });
      TLV.game.versus._begin(S, o.versus);
      return;
    }
    // 9 and 10: setupErrand binds, stages and routes, then sends run.start and errand.start.
    if (S.world && setupErrand(S, index, true)) return;
    S.bus.emit('run.start', { seed: S.seed });
    // Nothing binds. With content that is a map with no stall to reach. With none, a package test that only wants a car to drive.
    if (g._g.plan.length) {
      noDay(S);
    } else {
      TLV.player.setLocked(S, false);
      flow._setPhase(S, 'DRIVE');
    }
  };

  /**
   * Ends the run. Rank and tally are final here.
   * @param {object} S Sim state.
   * @param {string} reason 'CLOCK', 'TOWED', 'CAUGHT', 'REVOKED' or 'WIN'.
   */
  flow.endRun = function (S, reason) {
    var g = S.game;
    if (g.phase === 'RUN_END') return;
    g.endReason = reason;
    g.rank = TLV.game.score.rank(g.money);
    S.timeScale = 1;
    g.park.stage = null;
    g.park.bar = 0;
    TLV.game.parking._clearPose(S);
    if (S.player.mode !== 'FOOT') TLV.player.setLocked(S, true);
    flow._setPhase(S, 'RUN_END');
    S.bus.emit('run.end', { reason: reason, money: g.money, rank: g.rank, stats: JSON.parse(JSON.stringify(g.stats)) });
  };

  /** The clock runs in DRIVE, SEARCH and HOLD (GAME_DESIGN 7). */
  function tickClock(S, dt) {
    var g = S.game;
    var gg = g._g;
    var T = TLV.tune.game;
    g.clock = Math.max(0, g.clock - dt);
    var level = g.clock <= T.clockWarn2 ? 2 : (g.clock <= T.clockWarn1 ? 1 : 0);
    if (level > gg.warned) S.bus.emit('clock.warn', { level: level });
    gg.warned = level;
  }

  /** @returns {?object} The clear AI lane pose nearest a point, in travel direction. */
  function recoverPose(S) {
    var W = S.world;
    var T = TLV.tune.game;
    var veh = S.player.veh;
    var gg = S.game._g;
    var ai = TLV.const.LF.AI_ROUTABLE;
    var reaches = [T.recoverReachM, T.recoverFarM];
    var pr = gg.proj;
    for (var r = 0; r < reaches.length; r++) {
      var n = TLV.world.lanes.lanesNear(W, veh.x, veh.y, reaches[r], gg.lanes);
      var list = [];
      for (var i = 0; i < n; i++) {
        var lane = W.lanes[gg.lanes[i]];
        if (!(lane.flags & ai) || lane.len < T.recoverMinLaneM) continue;
        TLV.math.polyProject(lane.px, lane.py, lane.cum, veh.x, veh.y, -1, pr);
        list.push({ lane: lane, s: TLV.math.clamp(pr.s, T.recoverEndM, lane.len - T.recoverEndM), d: pr.d });
      }
      list.sort(function (a, b) { return a.d - b.d || a.lane.id - b.lane.id; });
      for (var k = 0; k < list.length; k++) {
        var at = TLV.world.lanes.pointAt(W, list[k].lane.id, list[k].s, {});
        var count = TLV.traffic.vehiclesNear(S, at.x, at.y, T.recoverClearM, gg.cars);
        var blocked = false;
        for (var q = 0; q < count; q++) blocked = blocked || !gg.cars[q].isPlayer;
        if (!blocked) return at;
      }
    }
    return null;
  }

  /** Tows the car to the nearest routable lane: -15 s and -₪100, and no contact (GAME_DESIGN 5). One press is one tow, held or not. */
  function recover(S, dt) {
    var g = S.game;
    var gg = g._g;
    var T = TLV.tune.game;
    if (!S.controls.recover) gg.recoverSpent = false;
    var held = S.controls.recover && !gg.recoverSpent && Math.abs(S.player.veh.v) < T.recoverMaxV;
    gg.recoverT = held ? gg.recoverT + dt : 0;
    if (gg.recoverT < T.recoverHoldS) return;
    gg.recoverT = 0;
    var at = recoverPose(S);
    if (!at) return;
    gg.recoverSpent = true;
    TLV.player.setPose(S, at.x, at.y, at.h, 0);
    g.clock = Math.max(0, g.clock - T.recoverClockS);
    g.money -= T.recoverMoney;
    g.nav.recalcT = 0;
    var nst = gg.nav;
    TLV.game.nav.setTarget(S, nst.laneId, nst.s, g.nav.targetX, g.nav.targetY);
    S.bus.emit('nav.recalc', {});
    S.bus.emit('player.recover', { x: at.x, y: at.y });
  }

  /** @returns {boolean} True on the errands that always have a contest, or when this one rolls one (GAME_DESIGN 13.1). */
  function contestDue(S) {
    var g = S.game;
    var T = TLV.tune.game;
    var e = g.errand;
    if (S.params.contest === 'off' || e.bayId < 0 || e._noContest) return false;
    if (S.params.contest === 'force') return true;
    var n = g.errandIndex + 1;
    if (n <= 2) return true;
    return S.rng.game.bool(Math.min(T.contestMax, T.contestBase + T.contestPerErrand * (n - 2)));
  }

  /** SEARCH begins on the remaining route to the bay. The contest starts here. */
  function checkSearch(S) {
    var g = S.game;
    var T = TLV.tune.game;
    var e = g.errand;
    var left = g.nav.remaining;
    if (left === Infinity) left = TLV.math.dist(S.player.fx, S.player.fy, g.nav.targetX, g.nav.targetY);
    if (left > T.searchM) return;
    flow._setPhase(S, 'SEARCH');
    S.bus.emit('errand.search', { bayId: e.bayId });
    if (g._g.searched) return;
    g._g.searched = true;
    if (contestDue(S)) g._g.contestDue = true;
  }

  /** The car waits for a clear slot in the lane, then pulls out over 1.0 s with parked-car collision off. */
  function pullOut(S, dt) {
    var pull = S.game._g.pull;
    var T = TLV.tune.game;
    if (pull.state === 'WAIT') {
      pull.t += dt;
      var cars = S.game._g.cars;
      var n = TLV.traffic.vehiclesNear(S, pull.x, pull.y, T.pullOutClearM, cars);
      var busy = false;
      for (var i = 0; i < n; i++) busy = busy || !cars[i].isPlayer;
      if (!busy || pull.t >= T.pullOutWaitS) {
        TLV.player.snapTo(S, pull.x, pull.y, pull.h, T.pullOutS, { ghost: true, hold: true });
        pull.state = 'SNAP';
      }
    } else if (pull.state === 'SNAP' && S.player.mode === 'LOCKED') {
      pull.state = 'NONE';
    }
    return pull.state === 'NONE';
  }

  /**
   * Tick row 4: phase timer, clock, nav, and the transitions the car's position starts.
   * @param {object} S Sim state.
   * @param {number} dt Tick, seconds.
   */
  flow.preUpdate = function (S, dt) {
    var g = S.game;
    var T = TLV.tune.game;
    g.phaseT += dt;
    trackKeys(S);
    var veh = S.player.veh;
    g._g.playerV += (Math.abs(veh.v) - g._g.playerV) * Math.min(1, dt / T.playerSmoothS);
    // What the other drivers sent since the last tick lands here, at a tick's edge. It can start a run, so the phase is read after it.
    TLV.game.versus._tick(S, dt);
    g = S.game;
    switch (g.phase) {
      case 'TITLE':
        if (S.params.notitle || S.controls.start) flow.startRun(S);
        return;
      case 'RUN_END':
        if (!freshPress(S, KEY_RESTART)) return;
        // Among other drivers a day starts when they are all ready for one, and they all start it together.
        if (TLV.game.versus.active(S)) TLV.game.versus._again(S);
        else flow.startRun(S);
        return;
      case 'CARD':
        if (pullOut(S, dt) && g.phaseT >= (g.errandIndex === 0 ? T.cardFirstS : T.cardS) && g.errand) {
          TLV.player.setLocked(S, false);
          flow._setPhase(S, 'DRIVE');
        }
        break;
      case 'DRIVE':
      case 'SEARCH':
        tickClock(S, dt);
        break;
      case 'HOLD':
        tickClock(S, dt);
        break;
      default:
        break;
    }
    if (!g.errand) return;
    TLV.game.nav.update(S, dt);
    if (g.phase === 'DRIVE' || g.phase === 'SEARCH') {
      recover(S, dt);
      if (g.phase === 'DRIVE') checkSearch(S);
    }
  };

  /** @returns {?{laneId:number,s:number}} The nearest lane the car can reach without going through a wall. */
  function nearLane(S) {
    var W = S.world;
    var T = TLV.tune.game;
    var veh = S.player.veh;
    var gg = S.game._g;
    var n = TLV.world.lanes.lanesNear(W, veh.x, veh.y, T.pullOutReachM, gg.lanes);
    var best = null;
    var bestD = Infinity;
    var pr = gg.proj;
    for (var i = 0; i < n; i++) {
      var lane = W.lanes[gg.lanes[i]];
      TLV.math.polyProject(lane.px, lane.py, lane.cum, veh.x, veh.y, -1, pr);
      var d = pr.d;
      var s = pr.s;
      // Facing the way the car faces counts for more than a metre or two.
      var at = TLV.world.lanes.pointAt(W, lane.id, s, gg.pt);
      if (Math.abs(TLV.math.wrapPi(at.h - veh.h)) > Math.PI / 2) d += T.pullOutAgainstM;
      if (d >= bestD || TLV.world.spatial.rayBlocked(W, veh.x, veh.y, at.x, at.y)) continue;
      bestD = d;
      best = { laneId: lane.id, s: s };
    }
    return best;
  }

  /** Clears one errand's traces, with the car set to pull out to the lane from where it parked. */
  function clearErrand(S) {
    var g = S.game;
    var gg = g._g;
    var W = S.world;
    var T = TLV.tune.game;
    var veh = S.player.veh;
    var e = g.errand;
    if (g.knife) {
      var man = TLV.peds.byId(S, g.knife.attackerId);
      if (man) TLV.peds.despawn(S, man);
    }
    gg.inspectors.forEach(function (id) {
      var p = TLV.peds.byId(S, id);
      if (p) TLV.peds.despawn(S, p);
    });
    gg.inspectors.length = 0;
    if (g.contest) TLV.game.rival._release(S, g.contest, false);
    e.decoys.forEach(function (d) {
      var p = d.pedId >= 0 ? TLV.peds.byId(S, d.pedId) : null;
      if (p) TLV.peds.command(S, p, { type: 'CANCEL' });
    });
    g.contest = null;
    g.knife = null;
    g.contacts = 0;
    g.pedHitThisErrand = false;
    g.obstacles.length = 0;
    g.park.kind = null;
    g.park.stage = null;
    g.park.bar = 0;
    gg.revealed = false;
    gg.contestDue = false;
    gg.park = TLV.game.parking._newState();
    var bay = e.parkMethod === 'BAY' && e.bayId >= 0 ? TLV.world.parking.spot(W, e.bayId) : null;
    var lane = bay ? { laneId: bay.laneId, s: bay.laneS } : nearLane(S);
    var pull = gg.pull;
    pull.state = 'NONE';
    if (lane) {
      var at = TLV.world.lanes.pointAt(W, lane.laneId, lane.s, {});
      pull.state = 'WAIT';
      pull.t = 0;
      pull.x = at.x;
      pull.y = at.y;
      pull.h = at.h;
      gg.from = { x: at.x, y: at.y, h: at.h };
    } else {
      gg.from = { x: veh.x, y: veh.y, h: veh.h };
    }
    flow._setPhase(S, 'CARD');
  }

  /** Clears one errand's traces and sets up the next. */
  function nextErrand(S) {
    clearErrand(S);
    // A false here is never a win: only the last errand of the plan, done, wins the day. See errandDone.
    if (!setupErrand(S, S.game.errandIndex + 1)) noDay(S);
  }

  /** PAYOUT or RESOLVE is done. */
  function errandDone(S) {
    var g = S.game;
    if (TLV.game.versus.active(S)) {
      // The board says what comes next: the driver picks again, or the day is over for everyone.
      clearErrand(S);
      g.errand = null;
      TLV.game.versus._errandDone(S);
      return;
    }
    if (g.errandIndex >= g._g.plan.length - 1) flow.endRun(S, 'WIN');
    else nextErrand(S);
  }

  /**
   * Starts an errand a driver picked from a shared board. Private to this package.
   * @param {object} S Sim state.
   * @param {object} e Errand, bound by errands._fromRow from the pose in S.game._g.from.
   * @param {number} index Its place in this driver's day, which sets its heat and its award.
   */
  flow._startBoardErrand = function (S, e, index) {
    var g = S.game;
    // Parked or at the spawn, the phone card shows and the car pulls out as on any day. On the move there is nothing to wait for.
    if (g.phase === 'CARD') flow._setPhase(S, 'CARD');
    setupErrand(S, index, false, e);
  };

  /**
   * Lets go of an errand its driver is still on the way to: another driver did it first, or this one chose again. The car stays where it
   * is and keeps going, with nowhere to go until the next pick. Private to this package.
   * @param {object} S Sim state.
   */
  flow._dropErrand = function (S) {
    var g = S.game;
    var gg = g._g;
    var e = g.errand;
    if (!e) return;
    if (g.contest) TLV.game.rival._release(S, g.contest, true);
    g.contest = null;
    e.decoys.forEach(function (d) {
      var p = d.pedId >= 0 ? TLV.peds.byId(S, d.pedId) : null;
      if (p) TLV.peds.command(S, p, { type: 'CANCEL' });
    });
    gg.contestDue = false;
    gg.searched = false;
    g.park.kind = null;
    g.park.stage = null;
    g.park.bar = 0;
    gg.park = TLV.game.parking._newState();
    TLV.game.parking._clearPose(S);
    g.obstacles.length = 0;
    g.errand = null;
    g.nav.route = null;
    g.nav.remaining = Infinity;
    gg.nav.laneId = -1;
    if (g.phase === 'CARD') return;
    if (S.player.mode !== 'FOOT') TLV.player.setLocked(S, false);
    flow._setPhase(S, 'DRIVE');
  };

  /**
   * Tick row 14: the timers of PAYOUT, BLOCKED and RESOLVE, then the checks that end a run.
   * @param {object} S Sim state.
   */
  flow.postUpdate = function (S) {
    var g = S.game;
    var gg = g._g;
    var T = TLV.tune.game;
    if (g.phase === 'TITLE' || g.phase === 'RUN_END') return;
    if (g.phase === 'PAYOUT') {
      if (!gg.revealed && g.phaseT >= T.revealS) {
        gg.revealed = true;
        var tier = TLV.game.rival.reveal(S);
        if (tier === 'BLOCK') {
          gg.phaseSave = g.phaseT;
          flow._setPhase(S, 'BLOCKED');
        } else if (tier === 'KNIFE') {
          TLV.game.knife.begin(S);
        }
      } else if (g.phaseT >= T.payoutS) {
        errandDone(S);
      }
    } else if (g.phase === 'BLOCKED') {
      if (g.phaseT >= T.blockedS) {
        g.phase = 'PAYOUT';
        g.phaseT = gg.phaseSave;
      }
    } else if (g.phase === 'RESOLVE') {
      TLV.game.knife._resolveTick(S);
      if (g.phaseT >= T.resolveS || (g.phaseT > T.resolveMinS && freshPress(S, KEY_INTERACT | KEY_START | KEY_RESTART))) errandDone(S);
    }
    if (S.params.immortal || g.phase === 'RUN_END') return;
    if (g.pedHits >= T.pedHitsToEnd) flow.endRun(S, 'REVOKED');
    else if (g.hp <= 0) flow.endRun(S, 'TOWED');
    else if (g.clock <= 0) flow.endRun(S, 'CLOCK');
  };

  /** Rebinds the current errand, for setErrand. */
  flow._rebind = function (S, index, defId) {
    var g = S.game;
    var gg = g._g;
    var veh = S.player.veh;
    if (g.contest) TLV.game.rival._release(S, g.contest, true);
    g.contest = null;
    var at = index === undefined || index === null ? g.errandIndex : index;
    if (defId) gg.plan[at] = defId;
    gg.from = { x: veh.x, y: veh.y, h: veh.h };
    return setupErrand(S, at);
  };

  /** Moves the player within reach of the bay and opens a contest, for forceContest. */
  function forceContest(S, o) {
    var g = S.game;
    var T = TLV.tune.game;
    var e = g.errand;
    if (!e) return null;
    if (g.contest) TLV.game.rival._release(S, g.contest, true);
    g.contest = null;
    if (o.spotId !== undefined && o.spotId !== null) TLV.game.parking._setBay(S, o.spotId);
    var spot = TLV.world.parking.spot(S.world, e.bayId);
    if (!spot) return null;
    if (S.player.mode === 'FOOT') TLV.foot.exit(S);
    if (!o.keepPose) {
      var route = g.nav.route;
      var at = g._g.pt;
      if (route) {
        TLV.math.polyAt(route.px, route.py, route.cum, Math.max(0, route.len - T.forcePlaceM), at);
        TLV.player.setPose(S, at.x, at.y, at.h, 0);
      }
    }
    TLV.game.nav.setTarget(S, spot.laneId, spot.laneS, spot.x, spot.y);
    TLV.player.setLocked(S, false);
    g._g.pull.state = 'NONE';
    g._g.searched = true;
    flow._setPhase(S, 'SEARCH');
    var c = TLV.game.rival.start(S, e.bayId, { rage: o.rage, etaDelta: o.etaDelta, force: true, spawnOnly: true }) ||
      TLV.game.rival.start(S, e.bayId, { rage: o.rage, etaDelta: o.etaDelta });
    return c ? { rivalId: c.rivalId, spotId: c.spotId } : { rivalId: -1, spotId: e.bayId };
  }

  /** Completes parking at the current bay, for parkNow. */
  function parkNow(S, o) {
    var g = S.game;
    var e = g.errand;
    if (!e || g.phase === 'RUN_END' || g.phase === 'PAYOUT' || g.phase === 'ENCOUNTER' || g.phase === 'RESOLVE' || g.phase === 'BLOCKED') return false;
    var spot = TLV.world.parking.spot(S.world, e.bayId);
    var method = o.method || (spot ? 'BAY' : 'DOUBLE');
    var gg = g._g.park;
    if (method === 'BAY' && !spot) return false;
    if (method === 'BAY') {
      if (S.player.mode === 'FOOT') TLV.foot.exit(S);
      TLV.player.setPose(S, spot.x, spot.y, spot.h, 0);
      TLV.world.parking.setState(S, spot.id, TLV.const.OCC.FREE);
      TLV.game.rival.onArm(S);
    }
    e.quality = o.quality || (method === 'DOUBLE' ? 'DOUBLE' : (method === 'BAY' ? 'GOOD' : 'UGLY'));
    g.park.kind = method === 'BAY' ? 'BAY' : (method === 'DOUBLE' ? 'DOUBLE' : 'CURB');
    gg.method = method;
    gg.handbrake = false;
    TLV.game.parking._complete(S);
    return true;
  }

  /** The debug hooks of ARCHITECTURE 16.2 that this package owns. */
  function hooks() {
    var debug = TLV.debug;
    function withSim(fn) {
      return function () {
        var S = debug.current();
        if (!S) return null;
        var args = [S];
        for (var i = 0; i < arguments.length; i++) args.push(arguments[i]);
        return fn.apply(null, args);
      };
    }
    debug.register('startRun', withSim(function (S, opts) {
      flow.startRun(S, opts || {});
      return true;
    }));
    debug.register('setClock', withSim(function (S, s) {
      S.game.clock = s;
      return true;
    }));
    debug.register('setMoney', withSim(function (S, n) {
      S.game.money = n;
      return true;
    }));
    debug.register('setHP', withSim(function (S, n) {
      S.game.hp = n;
      return true;
    }));
    debug.register('setHeat', withSim(function (S, h) {
      S.game.heat = h;
      S.game._g.heatForced = true;
      return true;
    }));
    debug.register('setStrikes', withSim(function (S, n) {
      if (S.game.knife) S.game.knife.strikes = n;
      return !!S.game.knife;
    }));
    debug.register('setErrand', withSim(function (S, index, defId) {
      return flow._rebind(S, index, defId);
    }));
    debug.register('forceContest', withSim(function (S, o) {
      return forceContest(S, o || {});
    }));
    debug.register('forceKnife', withSim(function (S, o) {
      var opts = o || {};
      return TLV.game.knife._force(S, opts.stage, opts.gap);
    }));
    debug.register('forceIncident', withSim(function (S, id, opts) {
      var inc = TLV.game.incidents.stage(S, id, opts || {});
      return inc ? inc.id : null;
    }));
    debug.register('parkNow', withSim(function (S, o) {
      return parkNow(S, o || {});
    }));
    debug.register('endRun', withSim(function (S, reason) {
      flow.endRun(S, reason);
      return true;
    }));
  }

  /** Soak checks of this package: the numbers stay numbers, and the state a phase needs is there. */
  function gameState(S) {
    var g = S.game;
    if (!g || g.phase === 'TITLE') return null;
    if (!Number.isFinite(g.clock) || !Number.isFinite(g.money) || !Number.isFinite(g.hp)) return 'clock, money or hp is not finite';
    if (TLV.const.PHASES.indexOf(g.phase) < 0) return 'unknown phase ' + g.phase;
    if (g.phase === 'ENCOUNTER' && !g.knife) return 'ENCOUNTER with no encounter';
    if (g.knife && g.phase === 'ENCOUNTER' && g.knife.stage !== 'CHASE' && S.player.mode === 'DRIVE') return 'controls live before the chase';
    return null;
  }

  /**
   * Chooses the difficulty of the next run, for the title card. It is read at flow.startRun, and a run under way plays on as it began.
   * @param {string} id A key of TLV.tune.game.difficulty.
   * @returns {boolean} False for an id that is not in the table, which changes nothing.
   */
  game.setDifficulty = function (id) {
    var S = TLV.debug.current();
    if (!S || !S.game || !knownDifficulty(id)) return false;
    S.game.difficulty = id;
    return true;
  };

  /** @returns {?string} The difficulty chosen: the one the next run will start on. */
  game.getDifficulty = function () {
    var S = TLV.debug.current();
    return S && S.game ? S.game.difficulty : null;
  };

  /** Registers queue handlers, debug hooks and invariants, and queues the shipped incidents. */
  game.register = function () {
    TLV.registry.on('errand', TLV.game.errands.onDef);
    TLV.registry.on('spawn', TLV.game.errands.onSpawn);
    TLV.registry.on('incident', TLV.game.incidents.onDef);
    TLV.game.incidents._ship();
    hooks();
    TLV.invariants.register('game.state', gameState);
  };
})(window.TLV);
