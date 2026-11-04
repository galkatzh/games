// js/sim/game/rival.js — WP-GAME
// The Spot War (GAME_DESIGN 13). TRAFFIC drives him through PARK_RACE. This file picks him, keeps his arrival level with the
// player's, mirrors his stages into the Contest and settles what happens when the player takes the bay.
//
// A rival ahead on a one-lane road cannot be got past: 58% of stalls are on one-way one-lane roads parked on both sides, and a car
// stopped at the COMMIT line leaves 1.4 m. So with the player on his bumper he rolls past the bay, as anyone does before backing into
// a space, and holds beyond it with his blinker on. That is also where the tutorial's rival holds. See the WP-GAME report, D1.
(function (TLV) {
  'use strict';

  var rival = TLV.ns('game.rival');

  /** Order of the mirrored stages: a contest never goes back to an earlier one. */
  var RANK = { CRUISE: 0, BLINK: 1, CREEP: 2, COMMIT: 3 };

  /** @returns {?object} The rival's car, or null. */
  function carOf(S, c) {
    return TLV.traffic.byId(S, c.rivalId);
  }

  /** Sets the contest state and tells the UI. */
  function setState(S, c, state) {
    if (c.state === state) return;
    c.state = state;
    c.stateT = 0;
    S.bus.emit('contest.state', { state: state });
  }

  /**
   * Metres from him to the bay. Along the road while he is on the way there, negative once he has passed it. Once he has left the
   * route this is straight-line and r.off is set: a projection clamps to the polyline, so its remainder would read a car long past the
   * end of the route as being at the bay, and TRAFFIC's own route round the block is private to it.
   * @returns {number} Metres.
   */
  function leftOf(S, c, veh) {
    var W = S.world;
    var spot = TLV.world.parking.spot(W, c.spotId);
    var r = c._r;
    r.off = false;
    if (veh.mode === 'LANE' && W.lanes[veh.laneId].dirEdge === W.lanes[spot.laneId].dirEdge) return spot.laneS - veh.s;
    if (r.route) {
      var p = TLV.world.routing.project(r.route, veh.x, veh.y, r.hintS, r.proj);
      r.hintS = p.s;
      if (p.d <= TLV.tune.game.offRouteM) return r.route.len - p.s;
    }
    r.off = true;
    return TLV.math.dist(veh.x, veh.y, spot.x, spot.y);
  }

  /**
   * @param {number} left From leftOf, just now.
   * @returns {boolean} True when he is at the bay for a steal: within 25 m by road (GAME_DESIGN 14), and with his car really there. A
   * rival off his route may be near in a straight line with a block of buildings between them, so only the road can say.
   */
  function atBay(S, c, veh, left) {
    var T = TLV.tune.game;
    var spot = TLV.world.parking.spot(S.world, c.spotId);
    if (Math.abs(left) > T.stealM || TLV.math.dist(veh.x, veh.y, spot.x, spot.y) > T.stealLineM) return false;
    return !c._r.off || TLV.world.parking.roadDistance(S.world, veh.x, veh.y, c.spotId) <= T.stealM;
  }

  /** @returns {number} Seconds until the player can arm, by the speed he has been holding. */
  function playerEta(S) {
    var T = TLV.tune.game;
    var g = S.game;
    var left = g.nav.remaining;
    if (left === Infinity) return Infinity;
    var v = g._g.playerV;
    var speed = Math.max(T.playerEtaFloorV, T.playerEtaShare * v + (1 - T.playerEtaShare) * T.playerRefV);
    return Math.max(0, left - (TLV.tune.world.spotLen + T.funnelExtraM) / 2) / speed;
  }

  /** @returns {number} Seconds his route still waits at the next red. */
  function redWait(S, c, veh) {
    var W = S.world;
    var route = c._r.route;
    if (!route || veh.mode !== 'LANE') return 0;
    var path = route.dirEdges;
    var here = W.lanes[veh.laneId].dirEdge;
    for (var i = 0; i + 1 < path.length; i++) {
      if (path[i] !== here) continue;
      var de = W.dirEdges[path[i]];
      if (W.juncs[de.to].kind !== 'SIGNAL') return 0;
      var conn = TLV.world.junctions.connFor(W, de.lanes[0], path[i + 1]);
      return conn >= 0 ? TLV.world.signals.timeToGreen(S, conn) : 0;
    }
    return 0;
  }

  /** @returns {number} Seconds to his body 50% inside, through the whole profile, at speed scale 1. */
  function etaAt(S, c, veh, left, vScale) {
    var T = TLV.tune.game;
    var Q = TLV.tune.traffic;
    var run = Math.max(0, left - Q.parkBlinkM);
    var lane = veh.mode === 'LANE' ? S.world.lanes[veh.laneId] : null;
    var v = (lane ? lane.vmax : 8) * (T.desiredBase + T.desiredPerAg * veh.ag) * vScale;
    return run / Math.max(1, v) + T.profileS + redWait(S, c, veh);
  }

  /** Re-solves his speed scale so his ETA stays with the player's, within the band (GAME_DESIGN 13.2). */
  function solve(S, c, veh, left) {
    var T = TLV.tune.game;
    var Q = TLV.tune.traffic;
    var run = left - Q.parkBlinkM;
    if (run <= 0) return;
    var lane = veh.mode === 'LANE' ? S.world.lanes[veh.laneId] : null;
    var v = (lane ? lane.vmax : 8) * (T.desiredBase + T.desiredPerAg * veh.ag);
    var want = playerEta(S) + c._r.delta;
    var room = want - T.profileS - redWait(S, c, veh);
    var scale = room > 0 ? run / (room * Math.max(1, v)) : T.scaleMax;
    // A car in front of the player on his own road sets the player's pace, so slowing him only slows them both.
    if (scale < 1 && blocksPlayer(S, veh) && S.game.nav.remaining > left) scale = 1;
    // Near the bay and out of sight, he dawdles: the blinker is what the player has to see. Not with the player nearly there, or he never shows.
    if (left <= T.slowUnseenM && playerEta(S) > T.dawdleEtaS && !TLV.traffic.visibleToPlayer(S, veh.x, veh.y)) scale = T.scaleMin;
    c.ctl.speedScale = TLV.math.clamp(scale, T.scaleMin, T.scaleMax);
  }

  /** A stall on the bay's lane far enough on that a car stopped at its COMMIT line stands clear past the bay. */
  function anchorFor(S, bay) {
    var W = S.world;
    var T = TLV.tune.game;
    var Q = TLV.tune.traffic;
    var ids = [];
    var need = bay.laneS + (bay.len + T.funnelExtraM) / 2 + T.rivalHalfM + T.pastClearM + Q.parkCommitM;
    TLV.world.parking.spotsNear(W, bay.x, bay.y, need - bay.laneS + T.pastRollM + 30, ids);
    var best = -1;
    var bestS = Infinity;
    for (var i = 0; i < ids.length; i++) {
      var sp = TLV.world.parking.spot(W, ids[i]);
      if (sp.laneId !== bay.laneId || sp.laneS < need) continue;
      if (sp.laneS < bestS) {
        bestS = sp.laneS;
        best = sp.id;
      }
    }
    return best;
  }
  rival._anchorFor = anchorFor;

  /** @returns {boolean} True when this car can be asked to race. */
  function usable(car) {
    return car.active && !car.isPlayer && car.beh === 'CRUISE' && car.mode === 'LANE' && car.kind !== 'bus' && car.kind !== 'truck';
  }

  /** Conscripts a live car ahead on the player's route, the one whose arrival is nearest the player's. */
  function conscript(S, spot) {
    var g = S.game;
    var W = S.world;
    var T = TLV.tune.game;
    var route = g.nav.route;
    if (!route) return null;
    var onRoute = {};
    for (var i = 0; i < route.dirEdges.length; i++) onRoute[route.dirEdges[i]] = true;
    var cars = g._g.cars;
    var n = TLV.traffic.vehiclesNear(S, S.player.fx, S.player.fy, Math.min(T.conscriptReachM, g.nav.remaining + 20), cars);
    var proj = g._g.proj;
    var eta = playerEta(S);
    var best = null;
    var bestOff = Infinity;
    for (var k = 0; k < n; k++) {
      var car = cars[k];
      if (!usable(car) || !onRoute[W.lanes[car.laneId].dirEdge]) continue;
      // Through a junction it is already cleared for, he would be off the route, and round the block while the player parks.
      if (TLV.traffic._leavesRoute(S, car, onRoute)) continue;
      // So he would from a lane with no turn onto the route's next road, and no room left to change to one.
      var carLane = W.lanes[car.laneId];
      var here = route.dirEdges.indexOf(carLane.dirEdge);
      if (here + 1 < route.dirEdges.length && carLane.len - car.s < T.laneChangeM &&
          TLV.world.junctions.connFor(W, car.laneId, route.dirEdges[here + 1]) < 0) continue;
      // On the bay's road in another lane with no room left to change, he would only drive past it.
      var wrong = W.lanes[car.laneId].dirEdge === W.lanes[spot.laneId].dirEdge && car.laneId !== spot.laneId;
      if (wrong && spot.laneS - car.s < T.laneChangeM) continue;
      var p = TLV.world.routing.project(route, car.x, car.y, null, proj);
      if (p.d > T.conscriptRouteM) continue;
      var ahead = p.s - g.nav.s;
      var left = route.len - p.s;
      if (ahead < T.conscriptAheadM || left < T.conscriptMinLeftM) continue;
      var arrives = etaAt(S, { _r: { route: route } }, car, left, 1);
      if (arrives > eta + T.etaBandS) continue;
      var off = Math.abs(arrives - eta);
      if (off < bestOff) {
        bestOff = off;
        best = car;
      }
    }
    return best;
  }

  /** Connectors into each lane, built once per sim. */
  function feeders(S) {
    if (S._gameFeeds) return S._gameFeeds;
    var W = S.world;
    var ai = TLV.const.LF.AI_ROUTABLE;
    var list = new Array(W.lanes.length);
    for (var i = 0; i < W.conns.length; i++) {
      var c = W.conns[i];
      if (!(W.lanes[c.from].flags & ai)) continue;
      if (!list[c.to]) list[c.to] = [];
      list[c.to].push(c.id);
    }
    S._gameFeeds = list;
    return list;
  }

  /** Lanes upstream of the bay, with the metres from each to it: the way a car can reach the bay, which is what fits an arrival. */
  function upstream(S, spot) {
    var W = S.world;
    var T = TLV.tune.game;
    var feeds = feeders(S);
    var out = [];
    var seen = {};
    var open = [{ lane: spot.laneId, run: spot.laneS, t: 0 }];
    while (open.length && out.length < T.upstreamMax) {
      var at = open.shift();
      var froms = feeds[at.lane] || [];
      for (var i = 0; i < froms.length; i++) {
        var conn = W.conns[froms[i]];
        if (seen[conn.from] || conn.turn === 'U') continue;
        seen[conn.from] = true;
        var lane = W.lanes[conn.from];
        var run = at.run + conn.len;
        out.push({ lane: lane, run: run, conn: conn.id, red: conn.slot >= 0 });
        if (run + lane.len < T.upstreamFarM) open.push({ lane: lane.id, run: run + lane.len });
      }
    }
    return out;
  }

  /**
   * Spawns him out of sight on a lane upstream of the bay, placed so his arrival meets the player's. Side roads come first. Until
   * the player is near enough for an arrival to fit, nothing is spawned: parking asks again. 35% of approach legs have no side road
   * 15 to 100 m upstream [M], so this walks back further than that, and errands 1 and 2 always have a contest.
   */
  function hiddenSpawn(S, spot, delta) {
    var W = S.world;
    var T = TLV.tune.game;
    var g = S.game;
    var route = g.nav.route;
    var onRoute = {};
    if (route) {
      for (var r = 0; r < route.dirEdges.length; r++) onRoute[route.dirEdges[r]] = true;
    }
    var list = upstream(S, spot);
    // Early rather than late: he can be slowed all the way, but junctions only ever cost him time.
    var eta = playerEta(S) + delta - T.spawnEarlyS;
    var best = null;
    var bestSide = 2;
    for (var i = 0; i < list.length; i++) {
      var row = list[i];
      var lane = row.lane;
      var v = lane.vmax * (T.desiredBase + T.desiredPerAg * T.rivalAgMid);
      var run = Math.max(0, eta - T.profileS) * v + TLV.tune.traffic.parkBlinkM;
      if (run > T.hiddenRunMaxM) continue;
      var inLane = run - row.run;
      if (inLane < TLV.tune.traffic.spawnEnd || inLane > lane.len - TLV.tune.traffic.spawnStart) continue;
      // A light that will be red when he gets there would make him late for good.
      if (row.red && TLV.world.signals.stateAt(S, row.conn, S.t + inLane / v) !== TLV.const.SIG.GREEN) continue;
      var s = lane.len - inLane;
      var at = TLV.world.lanes.pointAt(W, lane.id, s, g._g.pt);
      if (TLV.traffic.visibleToPlayer(S, at.x, at.y)) continue;
      if (TLV.math.dist(at.x, at.y, S.player.fx, S.player.fy) < T.noPopM) continue;
      var side = onRoute[lane.dirEdge] ? 1 : 0;
      if (side < bestSide) {
        bestSide = side;
        best = { laneId: lane.id, s: s };
      }
    }
    if (!best) return null;
    return TLV.traffic.spawn(S, { laneId: best.laneId, s: best.s, v: T.sideV, ag: S.rng.game.range(T.rivalAgMin, T.rivalAgMax) });
  }

  /** Debug only: a car on the bay's own lane, behind it, wherever the player can see. */
  function forcedSpawn(S, spot, back) {
    var s = Math.max(TLV.tune.traffic.spawnStart, spot.laneS - back);
    return TLV.traffic.spawn(S, { laneId: spot.laneId, s: s, v: TLV.tune.game.sideV, ag: 0.6, force: true });
  }

  /**
   * Starts a contest for a bay.
   * @param {object} S Sim state.
   * @param {number} spotId The bay.
   * @param {object} [opts] { rage, etaDelta, force, back }. force falls back to a car placed on the bay's lane, back metres upstream.
   * @returns {?object} Contest, or null when no rival can be found. Null means no contest.
   */
  rival.start = function (S, spotId, opts) {
    var g = S.game;
    var W = S.world;
    var T = TLV.tune.game;
    var o = opts || {};
    var spot = TLV.world.parking.spot(W, spotId);
    if (!spot || !g.errand) return null;
    var car = null;
    var source = 'CONSCRIPT';
    var forcedDelta = o.etaDelta !== undefined && o.etaDelta !== null;
    var ahead = !forcedDelta && S.rng.game.bool(T.aheadShare);
    var delta = forcedDelta ? o.etaDelta : (ahead ? -T.aheadLeadS : S.rng.game.range(-T.etaBandS / 3, T.etaBandS));
    if (!o.spawnOnly) {
      car = conscript(S, spot);
      if (!car) {
        source = 'HIDDEN';
        car = hiddenSpawn(S, spot, delta);
      }
    }
    if (!car && o.force) {
      source = 'FORCED';
      car = forcedSpawn(S, spot, o.back === undefined ? T.forceBackM : o.back);
    }
    if (!car) return null;
    var hold = g.errandIndex === 0;
    var anchor = hold ? anchorFor(S, spot) : -1;
    var c = {
      rivalId: car.id,
      spotId: spotId,
      state: 'CRUISE',
      stateT: 0,
      ctl: { speedScale: 1, mayBlink: false, holdCreep: hold, blinkWaiting: false },
      steal: false,
      rage: 0,
      factors: { blinkerFirst: false, passed: false, close: false, honked: false, steals: g.stats.spotsStolen },
      tier: null,
      winner: null,
      _rageForced: o.rage === undefined || o.rage === null ? null : o.rage,
      _r: {
        plan: hold && anchor >= 0 ? 'PAST' : (hold ? 'HOLD' : 'RACE'),
        source: source,
        target: anchor >= 0 ? anchor : spotId,
        route: null, hintS: null, proj: { s: 0, d: 0, side: 0 },
        delta: 0, solveT: 0, renewT: 0, behindT: false, holdT: 0, awayT: 0, waitT: 0, armed: false, done: false, abortRes: false, off: false
      }
    };
    c._r.delta = delta;
    var from = car.laneId;
    c._r.route = TLV.world.routing.routeLanes(W, from, car.s, spot.laneId, spot.laneS, { ai: true }) ||
      TLV.world.routing.routeLanes(W, from, car.s, spot.laneId, spot.laneS, {});
    // Aiming past the bay, he signals for the bay, not for the stall he aims at.
    if (anchor >= 0) c.ctl.blinkExtraM = TLV.world.parking.spot(W, anchor).laneS - spot.laneS;
    var ok = TLV.traffic.command(S, car, { type: 'PARK_RACE', spotId: c._r.target, ctl: c.ctl, route: anchor >= 0 ? null : c._r.route });
    if (!ok) return null;
    g.contest = c;
    g.errand.contests++;
    c.rage = TLV.game.rage.compute(S);
    S.bus.emit('contest.start', { rivalId: car.id, spotId: spotId });
    return c;
  };

  /** Ends a contest that nobody won. It leaves the gate's denominator as not lost. */
  function fizzle(S, c, why) {
    if (c._r.done) return;
    c._r.done = true;
    c._r.why = why || 'FAILED';
    setState(S, c, 'FAILED');
    S.bus.emit('contest.result', { winner: null, tier: null });
  }

  /** He gives up and drives on, with a word out of the window. */
  function giveUp(S, c, veh, say) {
    if (veh && say) S.bus.emit('bubble', { who: 'veh', id: veh.id, text: TLV.tune.game.curseText, ttl: TLV.tune.game.bubbleS });
    if (veh) TLV.traffic.command(S, veh, { type: 'PARK_ABORT' });
    fizzle(S, c, c._r.why || 'GAVE_UP');
  }

  /** He rolls past the bay to hold beyond it. */
  function pullPast(S, c, veh) {
    var spot = TLV.world.parking.spot(S.world, c.spotId);
    var anchor = anchorFor(S, spot);
    // With no stall to aim at beyond the bay he goes in. The road ahead of a car that parks clears by itself.
    if (anchor < 0) return;
    c._r.plan = 'PAST';
    c._r.target = anchor;
    c._r.holdT = 0;
    c.ctl.blinkExtraM = TLV.world.parking.spot(S.world, anchor).laneS - spot.laneS;
    c.ctl.holdCreep = true;
    c.ctl.mayBlink = true;
    c.ctl.speedScale = 1;
    TLV.traffic.command(S, veh, { type: 'PARK_RACE', spotId: anchor, ctl: c.ctl });
  }

  /** @returns {boolean} True when the car stands on the player's route ahead: the fight is on this road. */
  function blocksPlayer(S, veh) {
    var W = S.world;
    var route = S.game.nav.route;
    if (veh.mode !== 'LANE' || !route) return false;
    var here = W.lanes[veh.laneId].dirEdge;
    for (var i = 0; i < route.dirEdges.length; i++) {
      if (route.dirEdges[i] === here) return true;
    }
    return false;
  }

  /** At the last moment before the COMMIT line: takes the bay if it is his, and rolls past it if the player is on his bumper. */
  function decide(S, c, veh, left) {
    var T = TLV.tune.game;
    var Q = TLV.tune.traffic;
    var g = S.game;
    if (left > T.decideM || left < Q.parkCommitM - 1 || veh.mode !== 'LANE') return;
    if (g.nav.remaining <= left || !blocksPlayer(S, veh)) return;
    var mine = Math.max(0, left - Q.parkCommitM) / Q.creepV + Q.commitS / 2;
    if (playerEta(S) >= mine + T.commitMarginS) return;
    pullPast(S, c, veh);
  }

  /** Past the bay with nobody coming: backs up to it and goes in, which is what gives AFTER YOU a car to wait behind. */
  function holdPast(S, c, veh, left, dt) {
    var T = TLV.tune.game;
    var r = c._r;
    if (veh.v > T.stoppedV) {
      r.holdT = 0;
      return;
    }
    r.holdT += dt;
    // The tutorial's rival waits for the player. A hold is the one way to stand in lane that long: the traffic watchdog clears a
    // race that has stopped.
    if (S.game.errandIndex === 0) {
      // He waits for a player on his way to the bay, not for ever: one who overshot is coming round the block, into the back of him.
      r.awayT = S.game.nav.remaining > T.searchM ? r.awayT + dt : 0;
      if (r.awayT >= T.tutorialAwayS) {
        giveUp(S, c, veh, true);
        return;
      }
      if (left < 0 && veh.beh === 'PARK_RACE' && r.holdT >= T.pastSettleS) TLV.traffic.command(S, veh, { type: 'PARK_HOLD', maxS: T.tutorialHoldS });
      return;
    }
    if (r.holdT < T.pastHoldS) return;
    if (S.game.nav.remaining < T.pastComingM && S.game._g.playerV > T.stoppedV) return;
    r.plan = 'BACK';
    c.ctl.holdCreep = false;
    TLV.traffic.command(S, veh, { type: 'REVERSE_FOR_SPOT', distM: -left + T.pastBackBehindM });
  }

  /** Reversing to the bay: from just behind it, he noses in. */
  function backing(S, c, veh, left) {
    var T = TLV.tune.game;
    if (veh.beh === 'CRUISE' && left < T.pastBackBehindM / 2) {
      giveUp(S, c, veh, true);
      return;
    }
    if (left >= T.pastBackBehindM - T.pastBackSlackM || veh.beh === 'CRUISE') {
      c._r.plan = 'RACE';
      c._r.target = c.spotId;
      TLV.traffic.command(S, veh, { type: 'PARK_RACE', spotId: c.spotId, ctl: c.ctl });
    }
  }

  /** The factors the player can still change, read live for the gauge. */
  function readFactors(S, c, veh, left) {
    var T = TLV.tune.game;
    var g = S.game;
    var f = c.factors;
    var pLeft = g.nav.remaining;
    if (pLeft <= T.passedM && pLeft > left) c._r.behindT = true;
    f.passed = c._r.behindT && pLeft < left - T.passedMarginM;
    f.close = TLV.math.obbGap(S.player.veh, veh) <= T.closeM;
  }

  /** Counts time stopped behind him, for AFTER YOU. */
  function trackYield(S, c, veh, left, dt) {
    var T = TLV.tune.game;
    var g = S.game;
    var committed = c.state === 'COMMIT' || c.state === 'CREEP';
    var behind = g.nav.remaining > left;
    var still = Math.abs(S.player.veh.v) < T.afterYouStopV;
    var near = TLV.math.obbGap(S.player.veh, veh) <= T.afterYouM;
    // Once he has waited behind a committed car, he stays credited for as long as he stays put.
    if (!still || !behind) c._r.waitT = 0;
    else if (committed && (near || c._r.waitT > 0)) c._r.waitT += dt;
  }

  /**
   * Errand 1 teaches the fight for a spot, and no line on screen explains a car in the player's door. So the tutorial's rival gives way:
   * on a side road he waits while the player is near enough to meet him at the junction, and on the player's road, with the player closing
   * on his tail, he keeps ahead of the player's pace instead of creeping in front of him.
   */
  function courtesy(S, c, veh) {
    var T = TLV.tune.game;
    var g = S.game;
    if (g.errandIndex !== 0) return;
    var me = S.player.veh;
    var near = TLV.math.dist(veh.x, veh.y, me.x, me.y) < T.tutorialClearM;
    var wait = near && veh.mode === 'LANE' && !blocksPlayer(S, veh);
    if (wait) c.ctl.speedScale = 0;
    else if (c.ctl.speedScale === 0) c.ctl.speedScale = 1;
    var ahead = (veh.x - me.x) * Math.cos(me.h) + (veh.y - me.y) * Math.sin(me.h);
    c.ctl.paceV = near && !wait && ahead > 0 && me.v > 0 ? me.v + T.tutorialPaceDv : 0;
  }

  /**
   * Tick work for the contest: speed solve, blink permission, the last-moment choice and the live gauge.
   * @param {object} S Sim state.
   * @param {number} dt Tick, seconds.
   */
  rival.update = function (S, dt) {
    var g = S.game;
    var c = g.contest;
    if (!c || c._r.done || c.state === 'WON') return;
    c.stateT += dt;
    var veh = carOf(S, c);
    if (!veh) return;
    var T = TLV.tune.game;
    var left = leftOf(S, c, veh);
    readFactors(S, c, veh, left);
    c.rage = TLV.game.rage.compute(S);
    if (c.winner) return;
    if (c.state === 'DENIED') {
      if (veh.beh !== 'PARK_HOLD' && veh.beh !== 'REVERSE_FOR_SPOT' && (veh.mode === 'LANE' || veh.mode === 'CONN')) {
        TLV.traffic.command(S, veh, { type: 'PARK_HOLD', maxS: T.parkHoldMaxS });
      }
      return;
    }
    if (c.state === 'FAILED') return;
    trackYield(S, c, veh, left, dt);
    // He signals where the player can see it, unless he would run out of road first.
    c.ctl.mayBlink = left <= T.blinkLastM || (g.nav.remaining <= T.blinkPlayerM && TLV.traffic.visibleToPlayer(S, veh.x, veh.y));
    // The race command times out at 60 s, and a queue or a tutorial hold can outlast that.
    c._r.renewT += dt;
    if (c._r.renewT >= T.renewS && (veh.mode === 'LANE' || veh.mode === 'CONN') && veh.beh === 'PARK_RACE') {
      c._r.renewT = 0;
      // The same behaviour twice does not restart its timer, so it goes through PARK_HOLD, which resumes on the same ctl.
      TLV.traffic.command(S, veh, { type: 'PARK_HOLD', maxS: T.parkHoldMaxS });
      TLV.traffic.command(S, veh, { type: 'PARK_RACE', spotId: c._r.target, ctl: c.ctl });
    }
    if (c.state === 'CRUISE' && c._r.plan === 'RACE') {
      c._r.solveT -= dt;
      if (c._r.solveT <= 0) {
        c._r.solveT = T.solveS;
        solve(S, c, veh, left);
      }
    }
    var plan = c._r.plan;
    courtesy(S, c, veh);
    // Stood in a queue or held, he would never close the last metres before the player parks, and a contest the player never saw
    // teaches nothing. ctl.mayBlink is what keeps this to where the player can see it.
    c.ctl.blinkWaiting = (veh.v < T.stoppedV || c.ctl.speedScale === 0) && left <= T.blinkStoppedM;
    if (plan === 'RACE') {
      // In the wrong lane he can go past it. He has missed his chance, and carries on.
      if (left < -T.missedM && veh.mode === 'LANE') {
        c._r.why = 'MISSED';
        giveUp(S, c, veh, false);
        return;
      }
      if (c.state === 'BLINK' || c.state === 'CREEP') decide(S, c, veh, left);
      // A car in the bay's funnel would stop his blend half way, so he waits at the line for it to clear.
      // So does a rival with the player still out of reach of the fight.
      if (c._r.plan === 'RACE') c.ctl.holdCreep = TLV.game.parking._funnelBusy(S) || g.nav.remaining > T.blinkPlayerM;
    } else if (plan === 'PAST') {
      holdPast(S, c, veh, left, dt);
    } else if (plan === 'BACK') {
      backing(S, c, veh, left);
    } else if (plan === 'HOLD' && g.nav.remaining < left + T.holdBlockM && veh.v < T.stoppedV && blocksPlayer(S, veh)) {
      giveUp(S, c, veh, true);
    }
  };

  /** The stages of PARK_RACE, mirrored into the Contest. */
  function onRace(S, e) {
    var g = S.game;
    var c = g.contest;
    if (!c || e.vehId !== c.rivalId || c._r.done || c.state === 'DENIED' || c.state === 'WON') return;
    if (e.stage === 'BLINK' || e.stage === 'CREEP' || e.stage === 'COMMIT') {
      if (RANK[e.stage] <= RANK[c.state]) return;
      if (e.stage === 'BLINK') {
        var veh = carOf(S, c);
        c.factors.blinkerFirst = !!veh && g.nav.remaining > leftOf(S, c, veh);
      }
      setState(S, c, e.stage);
    } else if (e.stage === 'IN_SPOT') {
      if (e.spotId !== c.spotId) return;
      c.winner = 'rival';
      c._r.done = true;
      setState(S, c, 'WON');
      S.bus.emit('contest.result', { winner: 'rival', tier: null });
      if (c._r.waitT >= TLV.tune.game.afterYouHoldS) {
        TLV.game.score.bonus(S, 'AFTER_YOU', TLV.tune.game.afterYouPay, TLV.tune.game.afterYouS);
      }
      TLV.game.parking._bayLost(S);
    } else if (e.stage === 'FAILED') {
      fizzle(S, c);
    }
  }

  /** The horn, if it was aimed at him. */
  function onHorn(S, e) {
    var c = S.game.contest;
    if (!c || c._r.done) return;
    var veh = carOf(S, c);
    if (!veh) return;
    var T = TLV.tune.game;
    var dx = veh.x - e.x;
    var dy = veh.y - e.y;
    var d = Math.sqrt(dx * dx + dy * dy);
    if (d > T.honkM || d < 1e-6) return;
    if ((dx * Math.cos(e.h) + dy * Math.sin(e.h)) / d >= Math.cos(T.honkDeg * Math.PI / 180)) c.factors.honked = true;
  }

  /**
   * Subscribes to the events a contest reads. Called once by flow.init.
   * @param {object} S Sim state.
   */
  rival.init = function (S) {
    S.bus.on('traffic.parkRace', function (e) { onRace(S, e); });
    S.bus.on('player.horn', function (e) { onHorn(S, e); });
    S.bus.on('traffic.despawn', function (e) {
      var c = S.game.contest;
      if (c && e.vehId === c.rivalId && !c.winner && !c._r.abortRes) fizzle(S, c, 'DESPAWN');
    });
  };

  /** @returns {boolean} True when the rival's body overlaps the stall, so the player cannot arm. */
  rival._overlapsBay = function (S, spot) {
    var c = S.game.contest;
    if (!c || c.winner) return false;
    var veh = carOf(S, c);
    if (!veh) return false;
    var box = S.game._g.box;
    box.x = spot.x;
    box.y = spot.y;
    box.h = spot.h;
    box.length = spot.len;
    box.width = spot.wid;
    return TLV.math.obbOverlap(box, veh);
  };

  /** The player armed. A steal needs him at BLINK or later and within 25 m of the bay. Otherwise he drives on (GAME_DESIGN 14). */
  rival.onArm = function (S) {
    var c = S.game.contest;
    if (!c || c._r.done || c.winner || c.state === 'DENIED' || c.state === 'FAILED') return;
    var veh = carOf(S, c);
    if (!veh) return;
    var T = TLV.tune.game;
    var left = leftOf(S, c, veh);
    if (c.state !== 'CRUISE' && atBay(S, c, veh, left)) {
      c.steal = true;
      setState(S, c, 'DENIED');
      // He stops in lane within 6 m of the bay until the tier resolves. Past it, he comes back that far.
      if (left < -T.deniedPastM && veh.mode === 'LANE') {
        TLV.traffic.command(S, veh, { type: 'REVERSE_FOR_SPOT', distM: -left - T.deniedPastM });
      } else if (veh.mode === 'LANE' || veh.mode === 'CONN') {
        TLV.traffic.command(S, veh, { type: 'PARK_HOLD', maxS: T.parkHoldMaxS });
      } else if (veh.mode === 'SCRIPT') {
        TLV.traffic.command(S, veh, { type: 'CANCEL' });
      }
      return;
    }
    c._r.abortRes = true;
    c._r.why = 'LATE ' + c.state + ' ' + left.toFixed(0);
    TLV.traffic.command(S, veh, { type: 'PARK_ABORT' });
    c.state = 'FAILED';
    S.bus.emit('contest.state', { state: 'FAILED' });
  };

  /** HOLD was cancelled: he goes back to COMMIT, so arm-and-cancel never clears a rival (ARCHITECTURE decision 24). */
  rival.onCancel = function (S) {
    var c = S.game.contest;
    if (!c || c._r.done || !c.steal) return;
    var veh = carOf(S, c);
    c.steal = false;
    setState(S, c, 'COMMIT');
    if (!veh) return;
    c.ctl.mayBlink = true;
    c.ctl.holdCreep = c._r.plan !== 'RACE' || TLV.game.parking._funnelBusy(S);
    TLV.traffic.command(S, veh, { type: 'PARK_RACE', spotId: c._r.target, ctl: c.ctl });
  };

  /** Bar full: rage is final on this tick (GAME_DESIGN 14). */
  rival.finalize = function (S) {
    var g = S.game;
    var c = g.contest;
    if (!c || c._r.done) return;
    var bay = g.errand.parkMethod === 'BAY';
    c.winner = bay ? 'player' : (c.state === 'CRUISE' ? null : 'rival');
    if (!bay && c.steal) c.steal = false;
    if (c.steal) {
      var veh = carOf(S, c);
      if (veh) c.factors.close = TLV.math.obbGap(S.player.veh, veh) <= TLV.tune.game.closeM;
      c.rage = TLV.game.rage.compute(S);
      c.tier = TLV.game.rage.tier(S, c.rage);
      g.stats.spotsStolen++;
    }
  };

  /** The result, 0.3 s after the bar filled. @returns {?string} The tier, for flow to act on. */
  rival.reveal = function (S) {
    var c = S.game.contest;
    if (!c || c._r.done) return null;
    c._r.done = true;
    S.bus.emit('contest.result', { winner: c.winner, tier: c.tier });
    var veh = carOf(S, c);
    var T = TLV.tune.game;
    if (c.tier === 'CURSE' && veh) {
      S.bus.emit('bubble', { who: 'veh', id: veh.id, text: T.curseText, ttl: T.bubbleS });
      TLV.traffic.command(S, veh, { type: 'PARK_ABORT' });
    } else if (c.tier === 'BLOCK' && veh) {
      if (!TLV.traffic.command(S, veh, { type: 'RIVAL_BLOCK', holdS: T.blockedS })) {
        TLV.traffic.command(S, veh, { type: 'PARK_ABORT' });
      }
    }
    return c.tier;
  };

  /** Removes whoever is left of a contest. Used by startRun, and whenever an errand ends with him still at it. */
  rival._release = function (S, c, despawn) {
    if (!c) return;
    var veh = carOf(S, c);
    if (!veh) return;
    if (despawn) {
      TLV.traffic.despawn(S, veh, 'script');
      return;
    }
    if (veh.beh === 'PARK_RACE' || veh.beh === 'PARK_HOLD') TLV.traffic.command(S, veh, { type: 'PARK_ABORT' });
  };
})(window.TLV);
