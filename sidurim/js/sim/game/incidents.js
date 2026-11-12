// js/sim/game/incidents.js — WP-GAME
// The 17 staged incidents (GAME_DESIGN 11.1). The behaviours are TRAFFIC's and PEDS's. This file finds a place on the player's path,
// casts an actor, keeps the aim on the player until commit, and judges how it ended. A place is searched first and an actor cast
// only once the fairness gate has passed, so a refused incident leaves nothing behind.
(function (TLV) {
  'use strict';

  var incidents = TLV.ns('game.incidents');

  // Read-only content registry, filled at drain.
  var defs = [];
  var byId = Object.create(null);

  /** The shipped definitions (ARCHITECTURE 13.4). */
  var SHIPPED = [
    { id: 'RED_RUNNER', minHeat: 0, weight: 3, cooldownS: 30, anchor: 'junction', telegraph: { s: 1.2, cue: 'hornRising' }, tta: [2.2, 3.0], escape: 'brake', search: false, actors: [{ kind: 'car', command: 'RED_RUN' }] },
    { id: 'BUS_PULLOUT', minHeat: 0, weight: 3, cooldownS: 30, anchor: 'busStop', telegraph: { s: 1.2, cue: 'noseOut' }, tta: [2.2, 3.2], escape: 'laneOrBrake', search: false, actors: [{ kind: 'bus', command: 'BUS_PULLOUT' }] },
    { id: 'DOOR_ZONE', minHeat: 0, weight: 3, cooldownS: 30, anchor: 'parkedCar', telegraph: { s: 1.0, cue: 'doorCrack' }, tta: [2.0, 2.6], escape: 'laneOrBrake', search: true, actors: [{ kind: 'parked', command: 'DOOR_OPEN' }] },
    { id: 'DROP_OFF', minHeat: 0, weight: 3, cooldownS: 30, anchor: 'leadCar', telegraph: { s: 1.0, cue: 'hazards' }, tta: [2.2, 3.0], escape: 'brake', search: true, actors: [{ kind: 'car', command: 'DROP_OFF' }] },
    { id: 'STOP_NO_REASON', minHeat: 0, weight: 3, cooldownS: 30, anchor: 'leadCar', telegraph: { s: 1.0, cue: 'brakeLights' }, tta: [2.0, 3.0], escape: 'brake', search: true, actors: [{ kind: 'car', command: 'PHANTOM_STOP' }] },
    { id: 'ZEBRA_ROULETTE', minHeat: 0, weight: 3, cooldownS: 30, anchor: 'crossing', telegraph: { s: 1.0, cue: 'phoneDrift' }, tta: [2.4, 3.2], escape: 'brake', search: true, actors: [{ kind: 'phone', command: 'ZEBRA_STEP' }] },
    { id: 'SLOW_CROSS', minHeat: 0, weight: 3, cooldownS: 30, anchor: 'crossing', telegraph: { s: 1.2, cue: 'trolley' }, tta: [3.0, 4.0], escape: 'brake', search: true, actors: [{ kind: 'trolley', command: 'SLOW_CROSS' }] },
    { id: 'RED_WALKER', minHeat: 0.15, weight: 3, cooldownS: 30, anchor: 'crossing', telegraph: { s: 1.0, cue: 'phoneDrift' }, tta: [2.4, 3.2], escape: 'brake', search: false, actors: [{ kind: 'phone', command: 'RED_CROSS' }] },
    { id: 'SCOOTER_SALMON', minHeat: 0.15, weight: 3, cooldownS: 30, anchor: 'oneWayEdge', telegraph: { s: 1.0, cue: 'bell' }, tta: [2.4, 3.2], escape: 'laneOrBrake', search: false, actors: [{ kind: 'scooter', command: 'SCOOTER_SALMON' }, { kind: 'scooter', command: 'SCOOTER_SALMON' }] },
    { id: 'DELIVERY_POP', minHeat: 0.15, weight: 3, cooldownS: 30, anchor: 'crossing', telegraph: { s: 1.0, cue: 'riderLeans' }, tta: [2.2, 2.8], escape: 'brake', search: false, actors: [{ kind: 'delivery', command: 'DELIVERY_POP' }] },
    { id: 'TAILGATE', minHeat: 0, weight: 3, cooldownS: 30, anchor: 'tailSlot', telegraph: { s: 1.0, cue: 'highBeams' }, tta: [6, 10], escape: 'none', search: false, actors: [{ kind: 'car', command: 'TAILGATE' }] },
    { id: 'OVERTAKE_DIVE', minHeat: 0, weight: 3, cooldownS: 15, anchor: 'leadCar', telegraph: { s: 1.0, cue: 'engine' }, tta: [2.0, 2.6], escape: 'brake', search: true, actors: [{ kind: 'car', command: 'OVERTAKE' }] },
    { id: 'MERGE_WEDGE', minHeat: 0, weight: 3, cooldownS: 30, anchor: 'sideStreet', telegraph: { s: 1.0, cue: 'noseCreeps' }, tta: [2.2, 3.0], escape: 'brake', search: false, actors: [{ kind: 'car', command: 'NOSE_IN' }] },
    { id: 'DOUBLE_PARK', minHeat: 0, weight: 3, cooldownS: 30, anchor: 'leadCar', telegraph: { s: 1.0, cue: 'hazards' }, tta: [3.0, 4.0], escape: 'brake', search: true, actors: [{ kind: 'car', command: 'DOUBLE_PARK' }] },
    { id: 'REVERSE_FOR_SPOT', minHeat: 0.3, weight: 3, cooldownS: 30, anchor: 'leadCar', telegraph: { s: 1.0, cue: 'reverseLights' }, tta: [2.2, 3.0], escape: 'laneOrBrake', search: true, actors: [{ kind: 'car', command: 'REVERSE_FOR_SPOT' }] },
    { id: 'WRONG_WAY_DRIVER', minHeat: 0.15, weight: 3, cooldownS: 30, anchor: 'smallOneWay', telegraph: { s: 1.2, cue: 'highBeams' }, tta: [3.0, 4.0], escape: 'brake', search: false, actors: [{ kind: 'car', command: 'WRONG_WAY' }] },
    { id: 'ROAD_STROLL', minHeat: 0, weight: 3, cooldownS: 30, anchor: 'smallStreet', telegraph: { s: 1.2, cue: 'backTurned' }, tta: [3.5, 4.5], escape: 'brake', search: true, actors: [{ kind: 'walker', command: 'ROAD_STROLL' }] }
  ];

  /** Queues the shipped definitions. Called once by game.register, before the queue drains. */
  incidents._ship = function () {
    SHIPPED.forEach(function (def) {
      TLV.q.push(['incident', def]);
    });
  };

  /**
   * Queue handler for 'incident' items.
   * @param {object} def IncidentDef, ARCHITECTURE 13.4.
   */
  incidents.onDef = function (def) {
    if (!def || typeof def.id !== 'string' || !def.id) {
      TLV.registry.problem('incident', '?', 'no id');
      return;
    }
    if (byId[def.id]) {
      TLV.registry.problem('incident', def.id, 'duplicate id');
      return;
    }
    if (!Array.isArray(def.tta) || !def.actors || !def.anchor) {
      TLV.registry.problem('incident', def.id, 'needs tta, actors and anchor');
      return;
    }
    byId[def.id] = def;
    defs.push(def);
  };

  /** @returns {object[]} Every incident definition. */
  incidents.defs = function () {
    return defs.slice();
  };

  /** @returns {object} A definition by id. */
  incidents.get = function (id) {
    return byId[id];
  };

  /** Player speed for planning: a car at a stop line still gets a sensible distance. */
  function planV(S) {
    return Math.max(TLV.tune.game.planMinV, S.player.veh.v);
  }

  /** @returns {number} Metres along the route from the car to a point on it, or NaN off the route. */
  function along(S, x, y, reach) {
    var g = S.game;
    var route = g.nav.route;
    if (!route) return NaN;
    var p = TLV.world.routing.project(route, x, y, null, g._g.proj);
    if (p.d > reach) return NaN;
    return p.s - g.nav.s;
  }

  /** @returns {boolean} True when a place is out of view, or far enough not to pop in (GAME_DESIGN 11). */
  function noPop(S, x, y) {
    return TLV.math.dist(x, y, S.player.fx, S.player.fy) >= TLV.tune.game.noPopM || !TLV.traffic.visibleToPlayer(S, x, y);
  }

  /** The first CRUISE car with a test, nearest a point. */
  function carAt(S, x, y, r, test) {
    var cars = S.game._g.cars;
    var n = TLV.traffic.vehiclesNear(S, x, y, r, cars);
    var best = null;
    var bestD = Infinity;
    for (var i = 0; i < n; i++) {
      var car = cars[i];
      if (!car.active || car.isPlayer || car.beh !== 'CRUISE') continue;
      if (car.mode !== 'LANE' || !test(car)) continue;
      var d = TLV.math.dist(car.x, car.y, x, y);
      if (d < bestD) {
        bestD = d;
        best = car;
      }
    }
    return best;
  }

  /** @returns {boolean} True when a car stands in this incident's way as an actor: not the player's rival. */
  function free(S, car) {
    var c = S.game.contest;
    return !c || c.rivalId !== car.id;
  }

  /** A signal ahead with a green for the player at arrival, and a car on a conflicting approach (RED_RUNNER). */
  function atJunction(S, want, wantD) {
    var W = S.world;
    var g = S.game;
    var route = g.nav.route;
    if (!route) return null;
    var T = TLV.tune.game;
    var signals = TLV.world.signals;
    var path = route.dirEdges;
    var at = g._g.pt;
    for (var i = 0; i + 1 < path.length; i++) {
      var de = W.dirEdges[path[i]];
      if (W.juncs[de.to].kind !== 'SIGNAL') continue;
      var conn = TLV.world.junctions.connFor(W, de.lanes[0], path[i + 1]);
      if (conn < 0) continue;
      var c = W.conns[conn];
      TLV.world.lanes.connPointAt(W, conn, c.len / 2, at);
      var d = along(S, at.x, at.y, T.routeReachM);
      if (!(d > 0) || Math.abs(d - wantD) > T.placeSlackM) continue;
      if (signals.stateAt(S, conn, S.t + want) !== TLV.const.SIG.GREEN) continue;
      for (var k = 0; k < c.conflicts.length; k++) {
        var other = W.conns[c.conflicts[k]];
        if (other.slot === c.slot || other.slot < 0) continue;
        var lane = W.lanes[other.from];
        if (!(lane.flags & TLV.const.LF.AI_ROUTABLE)) continue;
        return { x: at.x, y: at.y, d: d, laneId: lane.id, s: lane.len, cross: lane, blocking: false };
      }
    }
    return null;
  }

  /** A bus stop on the route ahead. */
  function atBusStop(S, want, wantD) {
    var W = S.world;
    var g = S.game;
    var route = g.nav.route;
    if (!route) return null;
    var T = TLV.tune.game;
    var at = g._g.pt;
    for (var i = 0; i < route.dirEdges.length; i++) {
      var de = W.dirEdges[route.dirEdges[i]];
      for (var l = 0; l < de.lanes.length; l++) {
        var lane = W.lanes[de.lanes[l]];
        for (var k = 0; k < lane.stops.length; k++) {
          var stop = W.stops[lane.stops[k]];
          if (stop.s < T.busClearM || stop.s > lane.len - TLV.tune.traffic.spawnEnd) continue;
          TLV.world.lanes.pointAt(W, lane.id, stop.s, at);
          var d = along(S, at.x, at.y, T.routeReachM);
          if (!(d > 0) || Math.abs(d - wantD) > T.placeSlackM) continue;
          return { x: at.x, y: at.y, d: d, laneId: lane.id, s: stop.s, stop: stop, blocking: true };
        }
      }
    }
    return null;
  }

  /** A parked car beside the route ahead. */
  function atParked(S, want, wantD) {
    var W = S.world;
    var g = S.game;
    var route = g.nav.route;
    var T = TLV.tune.game;
    var world = TLV.world.parking;
    var ids = [];
    if (!route) {
      var veh = S.player.veh;
      var look = wantD;
      world.spotsNear(W, veh.x + Math.cos(veh.h) * look, veh.y + Math.sin(veh.h) * look, T.placeSlackM, ids);
    } else {
      var at = g._g.pt;
      TLV.math.polyAt(route.px, route.py, route.cum, g.nav.s + wantD, at);
      world.spotsNear(W, at.x, at.y, T.placeSlackM, ids);
    }
    var onRoad = S.player.laneId >= 0 ? S.world.lanes[S.player.laneId].dirEdge : -1;
    for (var i = 0; i < ids.length; i++) {
      var spot = world.spot(W, ids[i]);
      if (world.state(S, spot.id) !== TLV.const.OCC.PARKED) continue;
      var d = route ? along(S, spot.x, spot.y, T.parkedReachM) : (W.lanes[spot.laneId].dirEdge === onRoad ? spot.laneS - S.player.veh.s : NaN);
      if (!(d > 0) || Math.abs(d - wantD) > T.placeSlackM) continue;
      if (!noPop(S, spot.x, spot.y)) continue;
      return { x: spot.x, y: spot.y, d: d, laneId: spot.laneId, s: spot.laneS, spot: spot, blocking: false };
    }
    return null;
  }

  /** @returns {boolean} True when a car can be told to stop in lane here: the guards ambient stops keep (GAME_DESIGN 9). */
  function mayStop(S, car) {
    var W = S.world;
    var T = TLV.tune.game;
    var lane = W.lanes[car.laneId];
    if (lane.flags & TLV.const.LF.EXCLUSIVE) return false;
    if (car.kind === 'bus' || car.kind === 'truck') return false;
    if (lane.len - car.s < T.stopJunctionM) return false;
    for (var i = 0; i < lane.zones.length; i++) {
      var z = W.zones[lane.zones[i]];
      if (z.s1 >= car.s - T.stopZoneBackM && z.s0 <= car.s + T.stopZoneAheadM) return false;
    }
    return true;
  }

  /** The car ahead of the player. The universal fallback: it needs no route. */
  function atLead(S, want, wantD) {
    var W = S.world;
    var T = TLV.tune.game;
    var veh = S.player.veh;
    var laneId = S.player.laneId;
    var route = S.game.nav.route;
    var reach = wantD + T.placeSlackM;
    var car = null;
    var d = 0;
    if (laneId >= 0) {
      var near = TLV.traffic.leadOn(S, laneId, veh.s, reach);
      if (near && near.beh === 'CRUISE' && near.mode === 'LANE' && free(S, near)) {
        car = near;
        d = near.s - veh.s - near.length / 2 - veh.length / 2;
      }
    }
    if (!car && route) {
      var at = S.game._g.pt;
      TLV.math.polyAt(route.px, route.py, route.cum, S.game.nav.s + wantD, at);
      car = carAt(S, at.x, at.y, T.placeSlackM, function (c) {
        return free(S, c) && !isNaN(along(S, c.x, c.y, T.leadReachM));
      });
      if (car) d = along(S, car.x, car.y, T.leadReachM) - car.length / 2 - veh.length / 2;
    }
    if (!car || !(d > 0)) return null;
    // The car in front does not stop on the spot, so what the player has to brake in is the gap and its stopping room at the hardest stop.
    d += car.v * car.v / (2 * T.phantomMaxA);
    return { x: car.x, y: car.y, d: d, laneId: car.laneId, s: car.s, car: car, blocking: true };
  }

  /** Zones on the route ahead, one per crossing, with a test on the crossing. */
  function atCrossing(S, want, wantD, test) {
    var W = S.world;
    var g = S.game;
    var route = g.nav.route;
    if (!route) return null;
    var T = TLV.tune.game;
    var at = g._g.pt;
    var seen = {};
    for (var i = 0; i < route.dirEdges.length; i++) {
      var de = W.dirEdges[route.dirEdges[i]];
      var lane = W.lanes[de.lanes[0]];
      for (var k = 0; k < lane.zones.length; k++) {
        var zone = W.zones[lane.zones[k]];
        if (seen[zone.xing]) continue;
        seen[zone.xing] = true;
        var xing = W.xings[zone.xing];
        if (!xing || !test(xing, lane)) continue;
        TLV.world.lanes.pointAt(W, lane.id, (zone.s0 + zone.s1) / 2, at);
        var d = along(S, at.x, at.y, T.routeReachM);
        if (!(d > 0) || Math.abs(d - wantD) > T.placeSlackM) continue;
        return { x: at.x, y: at.y, d: d, laneId: lane.id, s: (zone.s0 + zone.s1) / 2, xing: xing, blocking: false };
      }
    }
    return null;
  }

  /** A one-way lane ahead on the route, for a wrong-way rider. */
  function atOneWay(S, want, wantD) {
    var W = S.world;
    var g = S.game;
    var route = g.nav.route;
    if (!route) return null;
    var T = TLV.tune.game;
    var at = g._g.pt;
    for (var i = 0; i < route.dirEdges.length; i++) {
      var de = W.dirEdges[route.dirEdges[i]];
      var e = W.edges[de.edge];
      if (e.lanesF > 0 && e.lanesB > 0) continue;
      var lane = W.lanes[de.lanes[0]];
      if (lane.len < T.salmonMinLaneM) continue;
      for (var s = T.salmonStepM; s < lane.len - T.salmonStepM; s += T.salmonStepM) {
        TLV.world.lanes.pointAt(W, lane.id, s, at);
        var d = along(S, at.x, at.y, T.routeReachM);
        if (d > 0 && Math.abs(d - wantD) <= T.salmonStepM) {
          return { x: at.x, y: at.y, d: d, laneId: lane.id, s: s, blocking: false };
        }
      }
    }
    return null;
  }

  /**
   * A small one-way street ahead on the route: one lane with no neighbour, and room on it past the place for whoever is coming.
   * @param {number} room Metres of lane wanted beyond the place.
   * @param {number} tail The most lane there may be beyond that, or Infinity.
   */
  function atSmall(S, wantD, room, tail) {
    var W = S.world;
    var g = S.game;
    var route = g.nav.route;
    if (!route) return null;
    var T = TLV.tune.game;
    var LF = TLV.const.LF;
    var at = g._g.pt;
    for (var i = 0; i < route.dirEdges.length; i++) {
      var de = W.dirEdges[route.dirEdges[i]];
      var e = W.edges[de.edge];
      if ((e.lanesF > 0 && e.lanesB > 0) || de.lanes.length !== 1) continue;
      var lane = W.lanes[de.lanes[0]];
      if (lane.left >= 0 || lane.right >= 0 || lane.opposite >= 0) continue;
      if (!(lane.flags & LF.AI_ROUTABLE) || (lane.flags & LF.EXCLUSIVE) || lane.len < T.salmonMinLaneM) continue;
      for (var s = T.salmonStepM; s + room < lane.len - T.smallEndM; s += T.salmonStepM) {
        if (lane.len - T.smallEndM - s - room > tail) continue;
        TLV.world.lanes.pointAt(W, lane.id, s, at);
        var d = along(S, at.x, at.y, T.routeReachM);
        if (d > 0 && Math.abs(d - wantD) <= T.salmonStepM) {
          return { x: at.x, y: at.y, d: d, laneId: lane.id, s: s, blocking: false };
        }
      }
    }
    return null;
  }

  /** The slot behind the player: the car already near his bumper, or a place out of his sight, or failing that whoever is on his tail. */
  function atTail(S) {
    var W = S.world;
    var T = TLV.tune.game;
    var veh = S.player.veh;
    if (S.player.laneId < 0) return null;
    var car = TLV.traffic.followerOf(S, veh, T.tailReachM);
    var able = car && car.beh === 'CRUISE' && car.mode === 'LANE' && free(S, car);
    var at = S.traffic.pS;
    if (able && at - car.s - car.length / 2 - veh.length / 2 <= T.tailNearM) {
      return { x: car.x, y: car.y, d: 1e3, laneId: car.laneId, s: car.s, car: car, blocking: false };
    }
    var lane = W.lanes[S.player.laneId];
    var s = at - T.tailBackM;
    var pt = s >= TLV.tune.traffic.spawnStart && (lane.flags & TLV.const.LF.AI_ROUTABLE) ? TLV.world.lanes.pointAt(W, lane.id, s, S.game._g.pt) : null;
    if (pt && noPop(S, pt.x, pt.y) && (!car || car.s < s - T.tailClearM)) {
      return { x: pt.x, y: pt.y, d: 1e3, laneId: lane.id, s: s, spawn: true, blocking: false };
    }
    return able ? { x: car.x, y: car.y, d: 1e3, laneId: car.laneId, s: car.s, car: car, blocking: false } : null;
  }

  /**
   * The cars that can pass the player now, nearest first, and where to place one if there are none. The incident's place is ahead of
   * him, where the car comes back in. Nothing ahead of him is cast: a dive that begins in front of the player has passed nobody.
   */
  function atPass(S, want, wantD) {
    var W = S.world;
    var T = TLV.tune.game;
    var veh = S.player.veh;
    var laneId = S.player.laneId;
    if (laneId < 0 || veh.v < T.diveMinV) return null;
    var lane = W.lanes[laneId];
    if (lane.left < 0 && lane.right < 0 && lane.opposite < 0) return null;
    // A car near the end of a tailgate of him is the likeliest to go past him.
    var ok = function (c) { return c && (c.beh === 'CRUISE' || TLV.traffic.behaviours.tailReady(c)) && c.mode === 'LANE' && free(S, c); };
    var cars = [];
    var behind = TLV.traffic.followerOf(S, veh, T.tailReachM);
    if (ok(behind)) cars.push(behind);
    var at = S.traffic.pS;
    var side = [lane.left, lane.right];
    for (var i = 0; i < side.length; i++) {
      var c = side[i] >= 0 ? TLV.traffic._behindOn(S, side[i], at + T.diveAheadM, T.diveSideM + T.diveAheadM) : null;
      if (ok(c)) cars.push(c);
    }
    // With nobody to hand, a car comes up from out of his sight: on the next lane if there is one, where it needs only go past him.
    var back = null;
    var slots = [lane.left, lane.right, behind ? -1 : laneId];
    var from = at - T.diveBackM;
    for (var k = 0; k < slots.length && !back && from >= TLV.tune.traffic.spawnStart; k++) {
      var slot = slots[k] >= 0 ? W.lanes[slots[k]] : null;
      if (!slot || !(slot.flags & TLV.const.LF.AI_ROUTABLE) || from + T.diveSlotM > slot.len) continue;
      if (TLV.traffic._behindOn(S, slot.id, from + T.diveSlotM, 2 * T.diveSlotM)) continue;
      var pt = TLV.world.lanes.pointAt(W, slot.id, from, S.game._g.pt);
      if (noPop(S, pt.x, pt.y)) back = { laneId: slot.id, s: from };
    }
    if (!cars.length && !back) return null;
    var ahead = TLV.world.lanes.pointAt(W, laneId, Math.min(lane.len, at + wantD), S.game._g.pt);
    return { x: ahead.x, y: ahead.y, d: wantD, laneId: laneId, s: Math.min(lane.len, at + wantD), cars: cars, back: back, blocking: false };
  }

  /** A junction ahead with a car or a place on a side approach. */
  function atSide(S, want, wantD) {
    var W = S.world;
    var g = S.game;
    var route = g.nav.route;
    if (!route) return null;
    var T = TLV.tune.game;
    var path = route.dirEdges;
    for (var i = 0; i + 1 < path.length; i++) {
      var de = W.dirEdges[path[i]];
      var j = W.juncs[de.to];
      var d = along(S, j.x, j.y, T.junctionReachM);
      if (!(d > 0) || Math.abs(d - wantD) > T.placeSlackM) continue;
      for (var k = 0; k < j.inDir.length; k++) {
        var side = W.dirEdges[j.inDir[k]];
        if (!side || side.id === de.id || !side.aiRoutable) continue;
        if (side.moves.indexOf(path[i + 1]) < 0) continue;
        var lane = W.lanes[side.lanes[0]];
        return { x: j.x, y: j.y, d: d, laneId: lane.id, s: lane.len, side: lane, next: path[i + 1], blocking: false };
      }
    }
    return null;
  }

  var FIND = {
    junction: atJunction,
    busStop: atBusStop,
    parkedCar: atParked,
    leadCar: atLead,
    oneWayEdge: atOneWay,
    tailSlot: atTail,
    sideStreet: atSide,
    // The driver coming the other way needs the road he covers before they meet, and not much more: he backs out over all of it.
    // The walker needs a stretch to walk down.
    smallOneWay: function (S, want, wantD) { return atSmall(S, wantD, TLV.tune.game.wrongWayV * want, TLV.tune.game.wrongWayTailM); },
    smallStreet: function (S, want, wantD) { return atSmall(S, wantD, TLV.tune.game.strollRoomM, Infinity); }
  };

  /** The place of a crossing incident: each kind of person has its own kind of crossing. */
  function crossingFor(S, def, want, wantD) {
    var signals = TLV.world.signals;
    if (def.id === 'ZEBRA_ROULETTE') {
      return atCrossing(S, want, wantD, function (x) { return !x.signal; });
    }
    if (def.id === 'RED_WALKER') {
      return atCrossing(S, want, wantD, function (x, lane) {
        return x.signal && signals.laneState(S, lane.id) === TLV.const.SIG.GREEN;
      });
    }
    return atCrossing(S, want, wantD, function () { return true; });
  }

  /** Places a person near a crossing. */
  function personAt(S, kind, xing) {
    // A car can be standing on the crossing, and this is a place to walk from, not to appear on.
    if (TLV.peds._bodyAt(S, xing.x, xing.y)) return null;
    return TLV.peds.spawn(S, { kind: kind === 'phone' ? 'phone' : kind, x: xing.x, y: xing.y, clear: true });
  }

  /** @returns {number} Seconds a car stops in lane. The first errand is one lane with the clock at its shortest, and teaches, not blocks. */
  function stopFor(S, holdS) {
    var most = TLV.tune.game.introHoldS;
    return S.game.errandIndex === 0 && holdS > most ? most : holdS;
  }

  /** Casts the actors and gives the command. @returns {?object[]} Actor refs, or null if they cannot comply. */
  function cast(S, def, inc, place, aim, opts) {
    var T = TLV.tune.game;
    var W = S.world;
    var rng = S.rng.event;
    var traffic = TLV.traffic;
    var type = def.actors[0].command;
    var veh = null;
    var ok = false;
    if ((type === 'DROP_OFF' || type === 'PHANTOM_STOP' || type === 'DOUBLE_PARK') && !mayStop(S, place.car)) return null;
    if (type === 'RED_RUN') {
      var cross = place.cross;
      var run = planV(S) * inc._tta;
      var end = W.lanes[cross.id];
      veh = carAt(S, end.px[end.px.length - 1], end.py[end.py.length - 1], T.crossCarM, function (c) { return c.laneId === cross.id && free(S, c); });
      if (!veh) {
        var from = Math.max(TLV.tune.traffic.spawnStart, cross.len - run);
        var at = TLV.world.lanes.pointAt(W, cross.id, from, {});
        if (!noPop(S, at.x, at.y)) return null;
        veh = traffic.spawn(S, { laneId: cross.id, s: from, v: T.actorV, ag: T.actorAg });
      }
      ok = !!veh && traffic.command(S, veh, { type: 'RED_RUN', aim: aim });
    } else if (type === 'BUS_PULLOUT') {
      veh = carAt(S, place.x, place.y, T.busNearM, function (c) { return c.kind === 'bus'; });
      if (!veh) {
        if (!noPop(S, place.x, place.y)) return null;
        veh = traffic.spawn(S, { laneId: place.laneId, s: place.s, v: 0, kind: 'bus', ag: T.actorAg });
      }
      ok = !!veh && traffic.command(S, veh, { type: 'BUS_PULLOUT', aim: aim });
    } else if (type === 'DOOR_OPEN') {
      veh = traffic.materializeParked(S, place.spot.id);
      ok = !!veh && traffic.command(S, veh, { type: 'DOOR_OPEN', side: 'traffic', holdS: rng.range(T.doorMinS, T.doorMaxS) });
      inc._parked = true;
    } else if (type === 'DROP_OFF') {
      veh = place.car;
      ok = traffic.command(S, veh, { type: 'DROP_OFF', holdS: stopFor(S, rng.range(T.dropMinS, T.dropMaxS)), door: 'traffic', passenger: true });
    } else if (type === 'PHANTOM_STOP') {
      veh = place.car;
      ok = traffic.command(S, veh, { type: 'PHANTOM_STOP', decel: rng.range(T.phantomMinA, T.phantomMaxA), holdS: stopFor(S, rng.range(T.phantomMinS, T.phantomMaxS)) });
    } else if (type === 'DOUBLE_PARK') {
      veh = place.car;
      ok = traffic.command(S, veh, { type: 'DOUBLE_PARK', holdS: stopFor(S, rng.range(T.doubleMinS, T.doubleMaxS)) });
    } else if (type === 'REVERSE_FOR_SPOT') {
      veh = place.car;
      ok = traffic.command(S, veh, { type: 'REVERSE_FOR_SPOT', distM: Math.min(T.reverseM, place.d / 2), aim: aim });
    } else if (type === 'OVERTAKE') {
      var order = { type: 'OVERTAKE', targetId: 0 };
      for (var k = 0; k < place.cars.length && !ok; k++) {
        veh = place.cars[k];
        ok = traffic.command(S, veh, order);
      }
      if (!ok && place.back) {
        veh = traffic.spawn(S, { laneId: place.back.laneId, s: place.back.s, v: S.player.veh.v + T.tailSpawnDv, ag: T.actorAg });
        ok = !!veh && traffic.command(S, veh, order);
        if (veh && !ok) {
          traffic.despawn(S, veh, 'script');
          veh = null;
        }
      }
    } else if (type === 'NOSE_IN') {
      var side = place.side;
      var last = side.px.length - 1;
      veh = carAt(S, side.px[last], side.py[last], T.crossCarM, function (c) { return c.laneId === side.id && free(S, c); });
      if (!veh) {
        var back = Math.max(TLV.tune.traffic.spawnStart, side.len - T.sideActorM);
        var pt = TLV.world.lanes.pointAt(W, side.id, back, {});
        if (!noPop(S, pt.x, pt.y)) return null;
        veh = traffic.spawn(S, { laneId: side.id, s: back, v: T.actorV, ag: T.actorAg });
      }
      ok = !!veh && traffic.command(S, veh, { type: 'NOSE_IN', aim: aim });
    } else if (type === 'WRONG_WAY') {
      var one = W.lanes[place.laneId];
      var start = Math.min(one.len - T.smallEndM, place.s + T.wrongWayV * inc._tta);
      // Head-on in one lane, anybody already between them would be met first.
      if (traffic.leadOn(S, one.id, Math.max(0, place.s - T.salmonClearM), start - place.s + 2 * T.salmonClearM)) return null;
      var far = TLV.world.lanes.pointAt(W, one.id, start, {});
      if (!noPop(S, far.x, far.y)) return null;
      veh = traffic.spawn(S, { laneId: one.id, s: start, v: 0, kind: rng.bool(0.5) ? 'sedan' : 'hatch', ag: T.actorAg });
      ok = !!veh && traffic.command(S, veh, { type: 'WRONG_WAY', aim: aim, holdS: stopFor(S, T.wrongWayHoldS), distM: start - place.s + T.wrongWayPastM });
      if (veh && !ok) {
        traffic.despawn(S, veh, 'script');
        veh = null;
      }
    } else if (type === 'TAILGATE') {
      veh = place.car || traffic.spawn(S, { laneId: place.laneId, s: place.s, v: S.player.veh.v + T.tailSpawnDv, ag: T.tailAg });
      ok = !!veh && traffic.command(S, veh, { type: 'TAILGATE', targetId: 0, durS: inc._tta });
    } else {
      return castPerson(S, def, inc, place, aim, opts);
    }
    if (!ok) {
      if (veh && veh.mode === 'PARKED') traffic.despawn(S, veh, 'script');
      return null;
    }
    return [{ type: 'veh', id: veh.id }];
  }

  /** The people's incidents. */
  function castPerson(S, def, inc, place, aim) {
    var T = TLV.tune.game;
    var type = def.actors[0].command;
    var peds = TLV.peds;
    if (!S.flags.peds) return null;
    var out = [];
    if (type === 'SCOOTER_SALMON') {
      // Head-on on a one-way, a rider has nowhere to go from a car already on that lane.
      if (TLV.traffic.leadOn(S, place.laneId, Math.max(0, place.s - T.salmonClearM), T.salmonClearM * 2)) return null;
      for (var i = 0; i < def.actors.length; i++) {
        var pt = TLV.world.lanes.pointAt(S.world, place.laneId, Math.min(S.world.lanes[place.laneId].len - 1, place.s + i * T.salmonGapM), {});
        var rider = peds.spawn(S, { kind: 'scooter', x: pt.x, y: pt.y });
        if (!rider) continue;
        if (peds.command(S, rider, { type: 'SCOOTER_SALMON', laneId: place.laneId, s: place.s + i * T.salmonGapM, aim: aim })) out.push({ type: 'ped', id: rider.id });
        else peds.despawn(S, rider);
      }
      return out.length ? out : null;
    }
    if (type === 'ROAD_STROLL') {
      var lane = S.world.lanes[place.laneId];
      // A car already on this stretch has its own business with them.
      if (TLV.traffic.leadOn(S, lane.id, Math.max(0, place.s - T.strollClearM), 2 * T.strollClearM)) return null;
      var mid = TLV.world.lanes.pointAt(S.world, lane.id, place.s, {});
      var off = lane.width / 2 - T.strollKerbM;
      var kx = mid.x + Math.sin(mid.h) * off;
      var ky = mid.y - Math.cos(mid.h) * off;
      if (peds._bodyAt(S, kx, ky)) return null;
      var w = peds.spawn(S, { kind: S.rng.event.bool(0.3) ? 'phone' : 'walker', x: kx, y: ky, h: mid.h, clear: true });
      if (!w) return null;
      if (peds.command(S, w, { type: 'ROAD_STROLL', laneId: lane.id, s: place.s, distM: T.strollRunM, dwellS: T.strollDwellS })) return [{ type: 'ped', id: w.id }];
      peds.despawn(S, w);
      return null;
    }
    var p = personAt(S, def.actors[0].kind, place.xing);
    if (!p) return null;
    var cmd = { type: type, xingId: place.xing.id, aim: aim };
    if (type === 'SLOW_CROSS') {
      cmd.speed = T.slowCrossV;
      cmd.dwellS = T.slowCrossDwellS;
      cmd.kind = 'trolley';
      cmd.aim = undefined;
    }
    if (peds.command(S, p, cmd)) return [{ type: 'ped', id: p.id }];
    peds.despawn(S, p);
    return null;
  }

  /** @returns {number} Next incident id. */
  function nextId(S) {
    S.game._g.dir.nextId++;
    return S.game._g.dir.nextId;
  }

  /**
   * Stages an incident now on the player's predicted path.
   * @param {object} S Sim state.
   * @param {string} defId Definition.
   * @param {object} [opts] { force: skips the fairness gate; tta: overrides the arrival time, for the first minute }.
   * @returns {?object} Incident, or null with no place, a closed gate, or an actor who could not comply.
   */
  incidents.stage = function (S, defId, opts) {
    var def = byId[defId];
    var g = S.game;
    if (!def || !S.world) return null;
    var o = opts || {};
    var T = TLV.tune.game;
    var rng = S.rng.event;
    var tta = o.tta !== undefined ? o.tta : rng.range(def.tta[0], def.tta[1]);
    var v = planV(S);
    var wantD = Math.max(v * tta, o.force ? 0 : TLV.game.fairness.need(S, S.player.veh.v));
    var find = def.id === 'OVERTAKE_DIVE' ? atPass : FIND[def.anchor];
    var place = def.anchor === 'crossing' ? crossingFor(S, def, tta, wantD) : (find ? find(S, tta, wantD) : null);
    if (!place && def.anchor !== 'leadCar' && def.anchor !== 'parkedCar' && o.force) {
      // A forced incident is for tests: it widens its look along the road, because a test has no reason to wait for the right spot.
      for (var w = 1; w <= T.forceWidenSteps && !place; w++) {
        var d = wantD + w * T.placeSlackM;
        place = def.anchor === 'crossing' ? crossingFor(S, def, tta, d) : find(S, tta, d);
      }
    }
    if (!place && (o.force || def.universal) && (def.anchor === 'leadCar' || def.anchor === 'parkedCar')) {
      for (var u = 1; u <= T.forceWidenSteps && !place; u++) place = find(S, tta, wantD + u * T.placeSlackM);
    }
    if (!place) return null;
    var cand = {
      d: place.d, v: S.player.veh.v > 0 ? S.player.veh.v : 0, x: place.x, y: place.y, def: def,
      blocking: place.blocking, laneId: place.laneId
    };
    if (!o.force && !TLV.game.fairness.check(S, cand)) return null;
    var aim = { x: place.x, y: place.y, tImpact: S.t + place.d / v, frozen: false };
    var inc = {
      id: nextId(S), defId: def.id, state: 'TELEGRAPH', startT: S.t,
      anchor: { type: def.anchor, x: place.x, y: place.y, laneId: place.laneId, s: place.s },
      aim: aim, actors: [], minGap: Infinity, contacted: false, outcome: null,
      _tta: tta, _stepped: false, _parked: false, _person: false, _teleS: def.telegraph.s
    };
    var actors = cast(S, def, inc, place, aim, o);
    if (!actors) return null;
    inc.actors = actors;
    inc._person = actors[0].type === 'ped';
    g.director.incidents.push(inc);
    g.stats.incidents.staged++;
    g.stats.incidents.byId[def.id] = (g.stats.incidents.byId[def.id] || 0) + 1;
    g._g.dir.cool[def.id] = S.t + (def.cooldownS || 0);
    S.bus.emit('incident.telegraph', { id: inc.id, defId: def.id, x: place.x, y: place.y });
    return inc;
  };

  /** Closes an incident. */
  function finish(S, inc, outcome) {
    var g = S.game;
    var T = TLV.tune.game;
    if (inc.state === 'DONE') return;
    inc.state = 'DONE';
    inc.outcome = outcome;
    var st = g.stats.incidents;
    if (outcome === 'AVOIDED') st.avoided++;
    else if (outcome === 'HIT') st.hit++;
    else st.aborted++;
    S.bus.emit('incident.end', { id: inc.id, defId: inc.defId, outcome: outcome });
    if (outcome === 'AVOIDED' && inc._person && inc._stepped && inc.minGap >= T.gaveWayM) {
      TLV.game.score.bonus(S, 'GAVE_WAY', T.gaveWayPay, 0);
    }
    if (inc._parked) inc._tidy = true;
  }

  /** @returns {boolean} True if an event's id is one of this incident's actors of a type. */
  function isActor(inc, type, id) {
    for (var i = 0; i < inc.actors.length; i++) {
      if (inc.actors[i].type === type && inc.actors[i].id === id) return true;
    }
    return false;
  }

  /** Each live incident that holds an actor. */
  function eachLive(S, fn) {
    var list = S.game.director.incidents;
    for (var i = 0; i < list.length; i++) {
      if (list[i].state !== 'DONE') fn(list[i]);
    }
  }

  /**
   * Subscribes to the events that end an incident. Called once by director.init.
   * @param {object} S Sim state.
   */
  incidents.init = function (S) {
    S.bus.on('player.contact', function (e) {
      // A rear-end contact from a tailgater cannot be avoided by anyone, so it is not a staged hit (GAME_DESIGN 8.1).
      if (e.kind !== 'vehicle' || e.rearEnded) return;
      eachLive(S, function (inc) {
        if (isActor(inc, 'veh', e.otherId)) {
          inc.contacted = true;
          finish(S, inc, 'HIT');
        }
      });
    });
    S.bus.on('player.hitPed', function (e) {
      eachLive(S, function (inc) {
        if (isActor(inc, 'ped', e.pedId)) {
          inc.contacted = true;
          finish(S, inc, 'HIT');
        }
      });
    });
    S.bus.on('traffic.despawn', function (e) {
      eachLive(S, function (inc) {
        if (isActor(inc, 'veh', e.vehId) && S.t < inc.aim.tImpact) finish(S, inc, 'ABORTED');
      });
    });
    S.bus.on('ped.despawn', function (e) {
      eachLive(S, function (inc) {
        if (isActor(inc, 'ped', e.pedId) && S.t < inc.aim.tImpact && inc.actors.length === 1) finish(S, inc, 'ABORTED');
      });
    });
    S.bus.on('ped.stepOut', function (e) {
      eachLive(S, function (inc) {
        if (isActor(inc, 'ped', e.pedId)) inc._stepped = true;
      });
    });
  };

  /** Metres from the player to an actor, bumper or skin, the least of all actors. */
  function actorGap(S, inc) {
    var best = Infinity;
    var veh = S.player.veh;
    for (var i = 0; i < inc.actors.length; i++) {
      var a = inc.actors[i];
      var d = Infinity;
      if (a.type === 'veh') {
        var car = TLV.traffic.byId(S, a.id);
        if (car) d = TLV.math.obbGap(veh, car);
      } else {
        var p = TLV.peds.byId(S, a.id);
        if (p) d = TLV.math.obbGap(veh, { x: p.x, y: p.y, h: 0, length: 2 * p.r, width: 2 * p.r });
      }
      if (d < best) best = d;
    }
    return best;
  }

  /** Incidents that last as long as their car is at it, however long that takes: it closes on the player first. */
  var FOLLOWS = { TAILGATE: { TAILGATE: 1 }, OVERTAKE_DIVE: { OVERTAKE_OUT: 1, OVERTAKE_PASS: 1, CUT_IN: 1 } };

  /** @returns {boolean} True once a following incident's car has left its behaviour. */
  function actorDone(S, inc) {
    var car = TLV.traffic.byId(S, inc.actors[0].id);
    return !car || !FOLLOWS[inc.defId][car.beh];
  }

  /** One live incident, each tick. */
  function tick(S, inc) {
    var g = S.game;
    var T = TLV.tune.game;
    var phase = g.phase;
    var age = S.t - inc.startT;
    if (phase !== 'DRIVE' && phase !== 'SEARCH' && phase !== 'HOLD') {
      finish(S, inc, S.t < inc.aim.tImpact ? 'ABORTED' : 'AVOIDED');
      return;
    }
    var gap = actorGap(S, inc);
    if (gap < inc.minGap) inc.minGap = gap;
    var aim = inc.aim;
    var v = planV(S);
    if (!aim.frozen) {
      var d = along(S, aim.x, aim.y, T.leadReachM);
      if (isNaN(d)) d = TLV.math.dist(aim.x, aim.y, S.player.fx, S.player.fy);
      aim.tImpact = S.t + Math.max(0, d) / v;
      if (aim.tImpact - S.t <= T.commitS) {
        aim.frozen = true;
        inc.state = 'COMMIT';
        inc._endT = S.t + T.commitS + T.passGraceS;
      }
    }
    if (inc.state === 'TELEGRAPH' && age >= inc._teleS) inc.state = 'ACTIVE';
    // A person who has not stepped out by now never will: the gate at the kerb found no gap. Better a new incident than this one's clock.
    if (inc._person && !inc._stepped && age >= T.stepOutMaxS) {
      finish(S, inc, 'ABORTED');
      return;
    }
    var ended = FOLLOWS[inc.defId] ? (actorDone(S, inc) || age >= T.followMaxS) : ((inc._endT !== undefined && S.t >= inc._endT) || age >= T.incidentMaxS);
    if (!ended) return;
    if (inc._person && !inc._stepped) finish(S, inc, 'ABORTED');
    else finish(S, inc, 'AVOIDED');
  }

  /** Tick work for every live incident, and the removal of the finished. */
  incidents._tick = function (S) {
    var list = S.game.director.incidents;
    for (var i = list.length - 1; i >= 0; i--) {
      var inc = list[i];
      if (inc.state !== 'DONE') tick(S, inc);
      if (inc.state === 'DONE') {
        if (inc._tidy) {
          var car = TLV.traffic.byId(S, inc.actors[0].id);
          if (car && car.mode === 'PARKED' && !car.door && !TLV.traffic.visibleToPlayer(S, car.x, car.y)) {
            TLV.traffic.despawn(S, car, 'script');
            inc._tidy = false;
          }
        }
        if (!inc._tidy) list.splice(i, 1);
      }
    }
  };
})(window.TLV);
