// js/sim/game/parking.js — WP-GAME
// The contested block, bay capture and the Q options (GAME_DESIGN 12). Bays are real curb stalls. Occupancy around the door is
// staged through setState, and the rival runs from rival.js through this file's update, at tick row 11.
(function (TLV) {
  'use strict';

  var parking = TLV.ns('game.parking');

  /** @returns {object} Capture state, private to this file. */
  parking._newState = function () {
    return {
      armT: 0, snapT: 0, fillT: 0, qT: 0, prev: 'DRIVE', handbrake: false, method: 'BAY', noRearm: false, offM: null, yawDeg: null,
      f: { x: 0, y: 0 }, kerb: { kerb: -1, side: 0, paint: 0, dist: 0, h: 0 }, pose: { offM: 0, yawDeg: 0, quality: 'UGLY' }
    };
  };

  /**
   * Subscribes to the events parking reads. Called once by flow.init.
   * @param {object} S Sim state.
   */
  parking.init = function (S) {
    S.bus.on('ped.despawn', function (e) {
      var er = S.game.errand;
      if (!er) return;
      for (var i = 0; i < er.decoys.length; i++) {
        if (er.decoys[i].pedId === e.pedId) er.decoys[i].pedId = -1;
      }
    });
  };

  /** Writes bay coordinates: x along the bay's axis, y to its left. */
  function frame(spot, x, y, out) {
    var c = Math.cos(spot.h);
    var s = Math.sin(spot.h);
    var ex = x - spot.x;
    var ey = y - spot.y;
    out.x = ex * c + ey * s;
    out.y = -ex * s + ey * c;
    return out;
  }

  /** @returns {number} Angle between a heading and the bay's axis, taken either way along it, radians. */
  function yawOff(h, spotH) {
    var off = Math.abs(TLV.math.wrapPi(h - spotH));
    return off > Math.PI / 2 ? Math.PI - off : off;
  }

  /** @returns {boolean} True when the car's centre is inside the capture funnel of a stall. */
  function inFunnel(S, spot, out) {
    var veh = S.player.veh;
    var T = TLV.tune.game;
    frame(spot, veh.x, veh.y, out);
    return Math.abs(out.x) <= (spot.len + T.funnelExtraM) / 2 && Math.abs(out.y) <= spot.wid / 2;
  }

  /** @returns {number} +1 when a stall's kerb is left of its axis, -1 when right. */
  function curbSign(W, spot) {
    var d = W.lanes[spot.laneId].dirEdge % 2;
    return (spot.side === 0) === (d === 0) ? 1 : -1;
  }

  // ---- The contested block. ---------------------------------------------------------------------------------------------

  /** Roads by distance from the door, ignoring one-way rules, up to a limit. @returns {object} { edge, s0, dist: Map, via: Map }. */
  function roadField(W, edgeId, x, y, limit) {
    var field = { edge: edgeId, s0: 0, dist: new Map(), via: new Map() };
    if (edgeId < 0) return field;
    var e0 = W.edges[edgeId];
    var pr = TLV.math.polyProject(e0.px, e0.py, e0.cum, x, y, -1, { s: 0, d: 0, side: 0 });
    field.s0 = pr.s;
    var open = [{ j: e0.a, d: pr.s, via: -1 }, { j: e0.b, d: e0.len - pr.s, via: -1 }];
    while (open.length) {
      var best = 0;
      for (var i = 1; i < open.length; i++) {
        if (open[i].d < open[best].d) best = i;
      }
      var at = open[best];
      open[best] = open[open.length - 1];
      open.pop();
      if (at.d > limit || field.dist.has(at.j)) continue;
      field.dist.set(at.j, at.d);
      field.via.set(at.j, at.via);
      var junc = W.juncs[at.j];
      for (var pass = 0; pass < 2; pass++) {
        var list = pass === 0 ? junc.inDir : junc.outDir;
        for (var k = 0; k < list.length; k++) {
          var edge = W.edges[list[k] >> 1];
          var other = edge.a === at.j ? edge.b : edge.a;
          if (!field.dist.has(other)) open.push({ j: other, d: at.d + edge.len, via: edge.id });
        }
      }
    }
    return field;
  }

  /** @returns {number} Metres by road from a stall to the door's point, Infinity past the field. */
  function stallDist(W, field, spot, proj) {
    var e = W.edges[spot.edge];
    TLV.math.polyProject(e.px, e.py, e.cum, spot.x, spot.y, -1, proj);
    if (spot.edge === field.edge) return Math.abs(proj.s - field.s0);
    var da = field.dist.has(e.a) ? field.dist.get(e.a) + proj.s : Infinity;
    var db = field.dist.has(e.b) ? field.dist.get(e.b) + e.len - proj.s : Infinity;
    return da < db ? da : db;
  }

  /** True if the road path from a stall to the door passes within reach of a sensitive POI, sampled along it. */
  function pathNearSensitive(W, field, spot) {
    var T = TLV.tune.game;
    var spatial = TLV.world.spatial;
    var at = { x: 0, y: 0, h: 0 };
    var proj = { s: 0, d: 0, side: 0 };
    var e = W.edges[spot.edge];
    TLV.math.polyProject(e.px, e.py, e.cum, spot.x, spot.y, -1, proj);

    function sample(edge, from, to) {
      var len = Math.abs(to - from);
      var n = Math.max(1, Math.ceil(len / T.pathSampleM));
      for (var i = 0; i <= n; i++) {
        TLV.math.polyAt(edge.px, edge.py, edge.cum, from + (to - from) * i / n, at);
        if (spatial.sensitiveNear(W, at.x, at.y, T.pathGuardM)) return true;
      }
      return false;
    }

    if (spot.edge === field.edge) return sample(e, proj.s, field.s0);
    var da = field.dist.has(e.a) ? field.dist.get(e.a) + proj.s : Infinity;
    var db = field.dist.has(e.b) ? field.dist.get(e.b) + e.len - proj.s : Infinity;
    var j = da <= db ? e.a : e.b;
    if (sample(e, proj.s, da <= db ? 0 : e.len)) return true;
    for (var hops = 0; hops < 64; hops++) {
      var via = field.via.get(j);
      if (via === undefined || via < 0) break;
      var edge = W.edges[via];
      if (sample(edge, 0, edge.len)) return true;
      j = edge.a === j ? edge.b : edge.a;
    }
    var door = W.edges[field.edge];
    return sample(door, field.s0, j === door.a ? 0 : door.len);
  }

  /** @returns {boolean} True when a stall may be a bay at all. */
  function bayFit(S, spot) {
    var W = S.world;
    var T = TLV.tune.game;
    var PAINT = TLV.const.PAINT;
    var lane = W.lanes[spot.laneId];
    if (!(lane.flags & TLV.const.LF.AI_ROUTABLE)) return false;
    if (spot.paint === PAINT.RED_WHITE || spot.paint === PAINT.RED_YELLOW) return false;
    if (TLV.world.parking.state(S, spot.id) === TLV.const.OCC.VEHICLE) return false;
    if (spot.laneS < T.bayLaneStartM) return false;
    return !TLV.world.spatial.sensitiveNear(W, spot.x, spot.y, T.sensitiveM);
  }

  parking._bayFit = bayFit;
  parking._curbSign = curbSign;

  /** Chooses the bay. @returns {number} Stall id, or -1. Sets errand._noContest for the plain fallback. */
  function pickBay(S, e) {
    var W = S.world;
    var T = TLV.tune.game;
    var route = e._doorRoute;
    var world = TLV.world.parking;
    var rng = S.rng.game;
    var at = { x: 0, y: 0, h: 0 };
    TLV.math.polyAt(route.px, route.py, route.cum, Math.max(0, route.len - T.approachBackM), at);
    var onRoute = {};
    for (var r = 0; r < route.dirEdges.length; r++) onRoute[route.dirEdges[r]] = true;
    var ids = [];
    world.spotsNear(W, e.doorX, e.doorY, T.bayWideFarM + T.bayCrowPadM, ids);
    var field = roadField(W, e._doorEdge, e.doorX, e.doorY, T.bayWideFarM + T.bayCrowPadM);
    var proj = { s: 0, d: 0, side: 0 };
    var good = [];
    for (var i = 0; i < ids.length; i++) {
      var spot = world.spot(W, ids[i]);
      if (!bayFit(S, spot)) continue;
      var d = stallDist(W, field, spot, proj);
      if (d > T.bayWideFarM || d < T.bayWideNearM) continue;
      // Rolling past needs a stall further on, so a bay with one comes first.
      good.push({
        spot: spot, d: d, on: onRoute[W.lanes[spot.laneId].dirEdge] ? 0 : 1,
        past: TLV.game.rival._anchorFor(S, spot) >= 0 ? 0 : 1, u: rng.next()
      });
    }
    function tryBand(lo, hi) {
      var band = good.filter(function (c) { return c.d >= lo && c.d <= hi; });
      band.sort(function (a, b) { return a.on - b.on || a.past - b.past || a.u - b.u; });
      var tries = 0;
      var found = -1;
      var foundLen = Infinity;
      for (var k = 0; k < band.length && tries < T.baySameRoadTries; k++) {
        if (pathNearSensitive(W, field, band[k].spot)) continue;
        tries++;
        var back = TLV.world.routing.route(W, at.x, at.y, at.h, band[k].spot.laneId, band[k].spot.laneS, { ai: true });
        // A stall that keeps its stall past it, then the shortest way there: the clock is set on the bay route.
        if (back && back.len <= T.approachMaxM && band[k].past === 0 && back.len < foundLen) {
          foundLen = back.len;
          found = band[k].spot.id;
        } else if (back && back.len <= T.approachMaxM && found < 0) {
          found = band[k].spot.id;
        }
      }
      return found;
    }
    var bay = tryBand(T.bayNearM, T.bayFarM);
    if (bay < 0) bay = tryBand(T.bayWideNearM, T.bayWideFarM);
    if (bay >= 0) return bay;
    // No contest: the nearest stall by directed route from the approach point. Stalls beside the route ahead come first,
    // because a stall behind the approach can be a kilometre away by one-way streets [M].
    e._noContest = true;
    var list = [];
    var seen = {};
    function gather(x, y, r) {
      var near = [];
      world.spotsNear(W, x, y, r, near);
      for (var n = 0; n < near.length; n++) {
        if (seen[near[n]]) continue;
        seen[near[n]] = true;
        var sp = world.spot(W, near[n]);
        if (bayFit(S, sp)) list.push({ id: sp.id, sp: sp, on: onRoute[W.lanes[sp.laneId].dirEdge] ? 0 : 1, d: TLV.math.dist(sp.x, sp.y, at.x, at.y) });
      }
    }
    var pt = { x: 0, y: 0, h: 0 };
    for (var u = Math.max(0, route.len - T.approachBackM); u <= route.len; u += T.fallbackStepM) {
      TLV.math.polyAt(route.px, route.py, route.cum, u, pt);
      gather(pt.x, pt.y, T.fallbackStepM);
    }
    if (list.length < T.baySameRoadTries) gather(at.x, at.y, T.fallbackBayM);
    function nearest(tries) {
      list.sort(function (a, b) { return a.on - b.on || a.d - b.d || a.id - b.id; });
      var bestLen = Infinity;
      var best = -1;
      for (var q = 0; q < list.length && q < tries; q++) {
        var way = TLV.world.routing.route(W, at.x, at.y, at.h, list[q].sp.laneId, list[q].sp.laneS, { ai: true });
        if (way && way.len < bestLen) {
          bestLen = way.len;
          best = list[q].id;
        }
      }
      return best;
    }
    var plain = nearest(T.fallbackTries);
    if (plain >= 0) return plain;
    // Nothing in reach, on 12 errands of 2,800: a safe stall further off still beats no bay at all.
    gather(at.x, at.y, T.rescueBayM);
    return nearest(T.rescueTries);
  }

  /** Remembers a stall's occupancy the first time staging changes it. */
  function stage(S, spotId, occ) {
    var world = TLV.world.parking;
    var staged = S.game._g.staged;
    if (!staged.has(spotId)) staged.set(spotId, world.state(S, spotId));
    world.setState(S, spotId, occ);
  }

  /** Puts stalls back, except near the player, so nothing vanishes in view. */
  function clearOld(S) {
    var W = S.world;
    var T = TLV.tune.game;
    var world = TLV.world.parking;
    var staged = S.game._g.staged;
    var veh = S.player.veh;
    var OCC = TLV.const.OCC;
    var ids = Array.from(staged.keys());
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      var spot = world.spot(W, id);
      if (!spot || world.state(S, id) === OCC.VEHICLE) continue;
      if (TLV.math.dist(spot.x, spot.y, veh.x, veh.y) <= T.fillKeepM) continue;
      world.setState(S, id, staged.get(id));
      staged.delete(id);
    }
  }

  /** Sets out the decoys, 30 to 60 m from the bay. A person saving a stall only turns up once the player is near. */
  function placeDecoys(S, e, bay) {
    var W = S.world;
    var T = TLV.tune.game;
    var world = TLV.world.parking;
    var rng = S.rng.game;
    var veh = S.player.veh;
    var OCC = TLV.const.OCC;
    var ids = [];
    world.spotsNear(W, bay.x, bay.y, T.decoyFarM, ids);
    var want = T.decoyMin + rng.int(T.decoyMax - T.decoyMin + 1);
    var pool = [];
    for (var i = 0; i < ids.length; i++) {
      var sp = world.spot(W, ids[i]);
      if (TLV.math.dist(sp.x, sp.y, bay.x, bay.y) < T.decoyNearM) continue;
      if (TLV.math.dist(sp.x, sp.y, veh.x, veh.y) <= T.fillKeepM) continue;
      if (world.state(S, sp.id) === OCC.VEHICLE) continue;
      if (TLV.world.spatial.sensitiveNear(W, sp.x, sp.y, T.sensitiveM)) continue;
      pool.push(sp.id);
    }
    for (var k = 0; k < want && pool.length; k++) {
      var at = rng.int(pool.length);
      var id = pool[at];
      pool[at] = pool[pool.length - 1];
      pool.pop();
      var saver = rng.bool(0.5);
      stage(S, id, saver ? OCC.FREE : OCC.MOTO);
      e.decoys.push({ spotId: id, kind: saver ? 'SAVER' : 'MOTORBIKE', pedId: -1 });
    }
  }

  /** Empties a bay. A car the player could see goes by pulling out, so nothing vanishes in view (GAME_DESIGN 12.2). */
  function freeBay(S, e, spotId) {
    var W = S.world;
    var T = TLV.tune.game;
    var world = TLV.world.parking;
    var OCC = TLV.const.OCC;
    var spot = world.spot(W, spotId);
    if (world.state(S, spotId) !== OCC.PARKED && world.state(S, spotId) !== OCC.MOTO) {
      stage(S, spotId, OCC.FREE);
      return;
    }
    var near = TLV.math.dist(spot.x, spot.y, S.player.fx, S.player.fy) <= T.fillKeepM || TLV.traffic.visibleToPlayer(S, spot.x, spot.y);
    if (near && world.state(S, spotId) === OCC.PARKED) {
      var car = TLV.traffic.materializeParked(S, spotId);
      if (car && TLV.traffic.command(S, car, { type: 'PULLOUT' })) {
        e._pullId = car.id;
        e._pullT = 0;
        return;
      }
      if (car) TLV.traffic.despawn(S, car, 'script');
    }
    stage(S, spotId, OCC.FREE);
  }

  /**
   * Stages the block round the current errand's door: clears the last block outside 60 m of the player, picks the bay, fills
   * the rest and places decoys (GAME_DESIGN 12.2).
   * @param {object} S Sim state.
   */
  parking.stageBlock = function (S) {
    var g = S.game;
    var e = g.errand;
    if (!e) return;
    var W = S.world;
    var T = TLV.tune.game;
    var world = TLV.world.parking;
    var OCC = TLV.const.OCC;
    var veh = S.player.veh;
    clearOld(S);
    e.bayId = pickBay(S, e);
    var ids = [];
    world.spotsNear(W, e.doorX, e.doorY, T.fillM, ids);
    for (var i = 0; i < ids.length; i++) {
      var id = ids[i];
      if (id === e.bayId || world.state(S, id) !== OCC.FREE) continue;
      var sp = world.spot(W, id);
      if (TLV.math.dist(sp.x, sp.y, veh.x, veh.y) <= T.fillKeepM) continue;
      stage(S, id, OCC.PARKED);
    }
    if (e.bayId < 0) return;
    freeBay(S, e, e.bayId);
    var bay = world.spot(W, e.bayId);
    placeDecoys(S, e, bay);
    e._doorM = world.roadDistance(W, e.doorX, e.doorY, e.bayId);
  };

  /** Makes a stall the current bay, for forceContest. */
  parking._setBay = function (S, spotId) {
    var e = S.game.errand;
    var world = TLV.world.parking;
    e.bayId = spotId;
    freeBay(S, e, spotId);
    e._doorM = world.roadDistance(S.world, e.doorX, e.doorY, spotId);
    var bay = world.spot(S.world, spotId);
    TLV.game.nav.setTarget(S, bay.laneId, bay.laneS, bay.x, bay.y);
  };

  /** @returns {number} Metres by road from the current bay to the door, Infinity with no bay. */
  parking._doorDistance = function (S) {
    var e = S.game.errand;
    return e ? e._doorM : Infinity;
  };

  /**
   * The next bay after a lost one: the next stall in route order, at most 150 m directed from it.
   * @param {object} S Sim state.
   * @returns {number} Stall id or -1.
   */
  parking.nextBay = function (S) {
    var W = S.world;
    var g = S.game;
    var e = g.errand;
    var T = TLV.tune.game;
    var world = TLV.world.parking;
    var lost = world.spot(W, e.bayId);
    if (!lost) return -1;
    var decoy = {};
    for (var i = 0; i < e.decoys.length; i++) decoy[e.decoys[i].spotId] = true;
    var ids = [];
    world.spotsNear(W, lost.x, lost.y, T.nextBayMaxM, ids);
    var list = [];
    for (var k = 0; k < ids.length; k++) {
      if (ids[k] === lost.id || decoy[ids[k]]) continue;
      var sp = world.spot(W, ids[k]);
      if (!bayFit(S, sp)) continue;
      var d = TLV.math.dist(sp.x, sp.y, lost.x, lost.y);
      var same = sp.laneId === lost.laneId && sp.laneS > lost.laneS ? 0 : 1;
      list.push({ id: sp.id, sp: sp, d: d, same: same });
    }
    list.sort(function (a, b) { return a.same - b.same || a.d - b.d || a.id - b.id; });
    var best = -1;
    var bestLen = Infinity;
    var tries = Math.min(list.length, T.nextBayTries);
    for (var q = 0; q < tries; q++) {
      var route = TLV.world.routing.routeLanes(W, lost.laneId, lost.laneS, list[q].sp.laneId, list[q].sp.laneS, { ai: true });
      if (!route || route.len > T.nextBayMaxM || route.len < T.nextBayMinM) continue;
      if (route.len < bestLen) {
        bestLen = route.len;
        best = list[q].id;
      }
    }
    return best;
  };

  /** A rival took the bay: the next one is offered at once, and the third is free (GAME_DESIGN 12.2). */
  parking._bayLost = function (S) {
    var g = S.game;
    var e = g.errand;
    var T = TLV.tune.game;
    var world = TLV.world.parking;
    var next = parking.nextBay(S);
    e.bayId = next;
    if (next < 0) {
      TLV.game.nav.setTarget(S, e._doorLane, e._doorLaneS, e.doorX, e.doorY);
      S.bus.emit('errand.search', { bayId: -1 });
      return;
    }
    freeBay(S, e, next);
    var bay = world.spot(S.world, next);
    e._doorM = world.roadDistance(S.world, e.doorX, e.doorY, next);
    TLV.game.nav.setTarget(S, bay.laneId, bay.laneS, bay.x, bay.y);
    S.bus.emit('errand.search', { bayId: next });
    if (e.contests < T.maxContests && S.params.contest !== 'off') g._g.contestDue = true;
  };

  // ---- Capture. ---------------------------------------------------------------------------------------------------------

  /** Walks a saver into their decoy stall once the player is near enough. */
  function decoyTick(S, e) {
    var T = TLV.tune.game;
    var world = TLV.world.parking;
    var veh = S.player.veh;
    if (!S.flags.peds) return;
    for (var i = 0; i < e.decoys.length; i++) {
      var d = e.decoys[i];
      if (d.kind !== 'SAVER' || d.pedId !== -1 || d._gone) continue;
      var spot = world.spot(S.world, d.spotId);
      if (TLV.math.dist(spot.x, spot.y, veh.x, veh.y) > T.saverSpawnM) continue;
      var ped = TLV.peds.spawn(S, { kind: 'walker', x: spot.x, y: spot.y, clear: true });
      if (!ped) continue;
      if (TLV.peds.command(S, ped, { type: 'SAVE_BAY', spotId: d.spotId })) {
        d.pedId = ped.id;
      } else {
        TLV.peds.despawn(S, ped);
        d._gone = true;
      }
    }
  }

  /** Watches the car pulling out of the next bay. One that cannot leave goes, because a bay must not stay blocked for good. */
  function pullTick(S, e, dt) {
    if (e._pullId === undefined || e._pullId < 0) return;
    var car = TLV.traffic.byId(S, e._pullId);
    e._pullT += dt;
    if (!car) {
      e._pullId = -1;
      return;
    }
    if (e._pullT > TLV.tune.game.pullOutGiveUpS && car.mode === 'PARKED') {
      TLV.traffic.despawn(S, car, 'script');
      e._pullId = -1;
    }
  }

  /** Finds a rival. Spawned ones wait until their arrival can meet the player's, so this asks again until the player is too near. */
  function contestTick(S, e, dt) {
    var g = S.game;
    var T = TLV.tune.game;
    var gg = g._g;
    gg.contestT -= dt;
    if (gg.contestT > 0) return;
    gg.contestT = T.solveS;
    if (e.bayId < 0 || e._noContest || g.contest && !g.contest._r.done || g.nav.remaining < T.contestLastM) {
      gg.contestDue = false;
      return;
    }
    if (TLV.game.rival.start(S, e.bayId, {})) gg.contestDue = false;
  }

  /** @returns {boolean} True while anything of the player's stands in the funnel of the current bay. */
  parking._funnelBusy = function (S) {
    var e = S.game.errand;
    var spot = e ? TLV.world.parking.spot(S.world, e.bayId) : null;
    if (!spot) return false;
    var f = S.game._g.park.f;
    return inFunnel(S, spot, f);
  };

  /**
   * Arms capture if the car's centre is in the funnel of the current bay, slow enough and within 30 deg of its axis either way.
   * Only errand.bayId can arm, never a decoy stall.
   * @param {object} S Sim state.
   * @returns {boolean} True when capture armed.
   */
  parking.tryArm = function (S) {
    var g = S.game;
    var e = g.errand;
    var gg = g._g.park;
    if (!e || e.bayId < 0 || g.park.stage || S.player.mode !== 'DRIVE') return false;
    var W = S.world;
    var T = TLV.tune.game;
    var spot = TLV.world.parking.spot(W, e.bayId);
    if (!spot) return false;
    if (!inFunnel(S, spot, gg.f)) {
      gg.noRearm = false;
      return false;
    }
    if (gg.noRearm && S.controls.throttle > T.cancelThrottle) return false;
    if (TLV.world.parking.state(S, spot.id) !== TLV.const.OCC.FREE) return false;
    var veh = S.player.veh;
    var speed = Math.abs(veh.v);
    var brake = !!S.controls.handbrake;
    if (speed > (brake ? T.armHandbrakeV : T.armV)) return false;
    if (yawOff(veh.h, spot.h) > T.armDeg * Math.PI / 180) return false;
    if (TLV.game.rival._overlapsBay(S, spot)) return false;
    gg.handbrake = brake && speed > T.armV;
    gg.armT = 0;
    gg.method = 'BAY';
    gg.noRearm = false;
    gg.prev = g.phase;
    g.park.stage = 'ARMED';
    g.park.kind = 'BAY';
    g.park.bar = 0;
    g.park.x = spot.x;
    g.park.y = spot.y;
    g.park.h = spot.h;
    publishPose(S, spot);
    TLV.game.flow._setPhase(S, 'HOLD');
    TLV.game.rival.onArm(S);
    return true;
  };

  /**
   * What capture would lock from the car's pose now (GAME_DESIGN 12.1). Writes offM, yawDeg and quality to out.
   * @param {object} S Sim state.
   * @param {object} spot Stall.
   * @param {{offM:number,yawDeg:number,quality:string}} out Written and returned.
   * @returns {object} out.
   */
  function grade(S, spot, out) {
    var gg = S.game._g.park;
    var T = TLV.tune.game;
    var veh = S.player.veh;
    var deg = Math.PI / 180;
    frame(spot, veh.x, veh.y, gg.f);
    var off = Math.abs(gg.f.y);
    var yaw = yawOff(veh.h, spot.h);
    // The stall's own kerb. A kerb query from the car can answer for another road at a corner.
    var across = Math.abs(Math.sin(yaw)) * veh.length / 2 + Math.cos(yaw) * veh.width / 2;
    var touched = spot.wid / 2 - curbSign(S.world, spot) * gg.f.y <= across;
    var q = 'UGLY';
    if (off <= T.perfectOffM && yaw <= T.perfectDeg * deg && !touched) q = 'PERFECT';
    else if (off <= T.goodOffM && yaw <= T.goodDeg * deg) q = 'GOOD';
    out.offM = off;
    out.yawDeg = yaw / deg;
    out.quality = q;
    return out;
  }

  /** Publishes the live pose while the bay is armed, for the prompt: the read contract is at S.game.park in core/constants.js. */
  function publishPose(S, spot) {
    var p = S.game.park;
    var pose = grade(S, spot, S.game._g.park.pose);
    p.offM = pose.offM;
    p.yawDeg = pose.yawDeg;
    p.would = pose.quality;
  }

  /** Clears the live pose: it is only for ARMED. */
  parking._clearPose = function (S) {
    var p = S.game.park;
    p.offM = null;
    p.yawDeg = null;
    p.would = null;
  };

  /** Locks quality from this pose and starts the snap (GAME_DESIGN 12.1). */
  function capture(S, spot) {
    var g = S.game;
    var gg = g._g.park;
    var T = TLV.tune.game;
    var veh = S.player.veh;
    var pose = grade(S, spot, gg.pose);
    g.errand.quality = pose.quality;
    gg.offM = pose.offM;
    gg.yawDeg = pose.yawDeg;
    parking._clearPose(S);
    var fwd = Math.abs(TLV.math.wrapPi(veh.h - spot.h)) <= Math.PI / 2;
    var h = fwd ? spot.h : TLV.math.wrapPi(spot.h + Math.PI);
    g.park.stage = 'SNAP';
    g.park.h = h;
    gg.snapT = 0;
    gg.fillT = 0;
    TLV.player.setLocked(S, true);
    TLV.player.snapTo(S, spot.x, spot.y, h, T.snapS, { hold: true });
  }

  /** Cancels HOLD, back to where the phase table says (ARCHITECTURE 10.9). */
  function cancel(S) {
    var g = S.game;
    var T = TLV.tune.game;
    var bay = g.park.kind === 'BAY';
    var armed = g.park.stage === 'ARMED';
    g.park.stage = null;
    g.park.kind = null;
    g.park.bar = 0;
    if (bay) g.errand.quality = null;
    if (bay && !armed) g._g.park.noRearm = true;
    g._g.park.offM = null;
    g._g.park.yawDeg = null;
    parking._clearPose(S);
    TLV.player.setLocked(S, false);
    TLV.game.flow._setPhase(S, g.nav.remaining <= T.searchM ? 'SEARCH' : 'DRIVE');
    if (bay) TLV.game.rival.onCancel(S);
  }

  /** What a Q hold here would be: a red curb in reach and in line, else a double-park. @returns {string} Park method. */
  function badMethod(S) {
    var T = TLV.tune.game;
    var veh = S.player.veh;
    var PAINT = TLV.const.PAINT;
    var kerb = TLV.world.parking.kerbAt(S.world, veh.x, veh.y, T.curbM, S.game._g.park.kerb);
    if (!kerb) return 'DOUBLE';
    if (kerb.paint !== PAINT.RED_WHITE && kerb.paint !== PAINT.RED_YELLOW) return 'DOUBLE';
    if (yawOff(veh.h, kerb.h) > T.curbDeg * Math.PI / 180) return 'DOUBLE';
    return kerb.paint === PAINT.RED_WHITE ? 'RED_WHITE' : 'RED_YELLOW';
  }

  /** @returns {boolean} True when the door is near enough for Q to park the car here. Private to this package. */
  parking._qReaches = function (S) {
    var g = S.game;
    var e = g.errand;
    var T = TLV.tune.game;
    var veh = S.player.veh;
    var reach = g.errandIndex === T.legs.length - 1 ? T.finaleQM : T.doorQM;
    return TLV.math.dist(veh.x, veh.y, e.doorX, e.doorY) <= reach;
  };

  /** Starts a Q hold: stationary, with the door in reach. Curb options never fire by themselves. */
  function tryQ(S) {
    var g = S.game;
    var T = TLV.tune.game;
    var veh = S.player.veh;
    if (!S.controls.hazard || g.park.stage || S.player.mode !== 'DRIVE' || Math.abs(veh.v) >= T.qStopV) return false;
    if (!parking._qReaches(S)) return false;
    var gg = g._g.park;
    gg.method = badMethod(S);
    gg.qT = 0;
    gg.handbrake = false;
    gg.prev = g.phase;
    g.park.stage = 'FILL';
    g.park.kind = gg.method === 'DOUBLE' ? 'DOUBLE' : 'CURB';
    g.park.bar = 0;
    g.park.x = veh.x;
    g.park.y = veh.y;
    g.park.h = veh.h;
    TLV.game.flow._setPhase(S, 'HOLD');
    return true;
  }

  /** The inspector, who arrives only when you park badly, always instantly (GAME_DESIGN 12.3). */
  function rollInspector(S, method) {
    var T = TLV.tune.game;
    var p = 0;
    var fine = T.ticketFine;
    var kind = 'TICKET';
    if (method === 'RED_WHITE') p = T.inspectorRedWhite;
    else if (method === 'DOUBLE') p = T.inspectorDouble;
    else if (method === 'RED_YELLOW') {
      p = T.towRedYellow;
      fine = T.towFine;
      kind = 'TOW';
    } else return;
    if (!S.rng.game.bool(p)) return;
    S.game.money -= fine;
    S.bus.emit('inspector.ticket', { amount: fine, kind: kind });
    if (S.flags.peds) TLV.game.knife._sendInspector(S, S.player.veh.x, S.player.veh.y);
  }

  /** The tick the bar fills, in the order of ARCHITECTURE 10.9. */
  parking._complete = function (S) {
    var g = S.game;
    var e = g.errand;
    var gg = g._g.park;
    var T = TLV.tune.game;
    var score = TLV.game.score;
    var method = gg.method;
    e.parkMethod = method;
    if (!e.quality) e.quality = method === 'DOUBLE' ? 'DOUBLE' : 'UGLY';
    if (method === 'DOUBLE') e.quality = 'DOUBLE';
    if (method === 'RED_WHITE' || method === 'RED_YELLOW') e.quality = 'UGLY';
    g.park.stage = null;
    g.park.bar = 0;
    TLV.player.setLocked(S, true);
    TLV.game.rival.finalize(S);
    var award = e.award * T.methodM[method];
    g.clock += award;
    var spotless = method === 'BAY' && g.contacts === 0 && !g.pedHitThisErrand;
    if (spotless) {
      score.bonus(S, 'SPOTLESS', 0, T.spotlessS);
      g.hp = Math.min(T.hpStart, g.hp + T.spotlessHp);
    }
    if (gg.handbrake && method === 'BAY') score.bonus(S, 'HANDBRAKE_PARK', T.handbrakePay, 0);
    rollInspector(S, method);
    var knife = !!g.contest && g.contest.tier === 'KNIFE';
    var pay = null;
    if (!knife) {
      pay = score._payErrand(S);
      g.stats.errandsDone++;
    }
    // offM and yawDeg are the pose quality locked from, null when no bay capture happened: the Q options and parkNow.
    S.bus.emit('errand.parked', { index: e.index, quality: e.quality, method: method, pay: pay, award: award, spotless: spotless, offM: gg.offM, yawDeg: gg.yawDeg });
    TLV.game.flow._setPhase(S, 'PAYOUT');
  };

  /** HOLD, each tick. */
  function hold(S, dt) {
    var g = S.game;
    var p = g.park;
    var gg = g._g.park;
    var T = TLV.tune.game;
    var veh = S.player.veh;
    if (p.kind !== 'BAY') {
      if (!S.controls.hazard || Math.abs(veh.v) >= T.qStopV) {
        cancel(S);
        return;
      }
      gg.qT += dt;
      p.bar = Math.min(1, gg.qT / T.qHoldS);
      if (gg.qT >= T.qHoldS) parking._complete(S);
      return;
    }
    var spot = TLV.world.parking.spot(S.world, g.errand.bayId);
    if (p.stage === 'ARMED') {
      gg.armT += dt;
      // The prompt says to keep rolling until the pose would pass, so the timer never locks one that would not: only stopping does that.
      if (!inFunnel(S, spot, gg.f)) cancel(S);
      else if (Math.abs(veh.v) < T.captureV) capture(S, spot);
      else if (gg.armT >= T.armedMaxS && grade(S, spot, gg.pose).quality !== 'UGLY') capture(S, spot);
      else publishPose(S, spot);
      return;
    }
    if (S.controls.throttle > T.cancelThrottle) {
      cancel(S);
      return;
    }
    var full = T.snapS + T.fillS;
    if (p.stage === 'SNAP') {
      gg.snapT += dt;
      p.bar = Math.min(gg.snapT, T.snapS) / full;
      if (S.player.mode === 'LOCKED') p.stage = 'FILL';
      return;
    }
    gg.fillT += dt;
    p.bar = Math.min(1, (T.snapS + gg.fillT) / full);
    if (gg.fillT >= T.fillS) parking._complete(S);
  }

  /**
   * Tick row 11: the rival, decoys, then capture and the Q options.
   * @param {object} S Sim state.
   * @param {number} dt Tick, seconds.
   */
  parking.update = function (S, dt) {
    var g = S.game;
    var e = g.errand;
    if (!e) return;
    if (g.phase === 'RUN_END' || g.phase === 'TITLE') return;
    TLV.game.rival.update(S, dt);
    pullTick(S, e, dt);
    if (g.phase === 'DRIVE' || g.phase === 'SEARCH') {
      decoyTick(S, e);
      if (g._g.contestDue) contestTick(S, e, dt);
      if (!parking.tryArm(S)) tryQ(S);
    } else if (g.phase === 'HOLD') {
      hold(S, dt);
    }
  };
})(window.TLV);
