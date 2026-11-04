// js/sim/traffic/traffic.js — WP-TRAFFIC
// The public face of the AI drivers (ARCHITECTURE 12.5), the tick, the soak invariants and the debug hooks.
(function (TLV) {
  'use strict';

  var traffic = TLV.ns('traffic');

  /**
   * Registers invariants and debug hooks. Called once per TLV, before the queue drains.
   */
  traffic.register = function () {
    TLV.invariants.register('traffic.laneBound', laneBoundFailure);
    TLV.invariants.register('traffic.overlap', overlapFailure);
    TLV.invariants.register('traffic.building', buildingFailure);
    TLV.invariants.register('traffic.ordering', orderingFailure);
    TLV.invariants.register('traffic.conservation', function (S) {
      return S.world && S.tick % 300 === 0 ? TLV.traffic.gate.audit(S) : null;
    });
    TLV.invariants.register('traffic.stuck', stuckFailure);
    TLV.debug.register('spawnCar', function (spec) {
      var S = TLV.debug.current();
      var veh = S ? traffic.spawn(S, spec) : null;
      return veh ? veh.id : null;
    });
    TLV.debug.register('commandCar', function (id, cmd) {
      var S = TLV.debug.current();
      var veh = S ? traffic.byId(S, id) : null;
      return veh ? traffic.command(S, veh, cmd) : false;
    });
    TLV.debug.register('setDensity', function (n) {
      var S = TLV.debug.current();
      if (S) traffic.setDensity(S, n);
      return !!S;
    });
    TLV.debug.register('trafficDiagnostics', function () {
      var S = TLV.debug.current();
      return S ? traffic.diagnostics(S) : null;
    });
  };

  /**
   * Creates S.traffic.
   * @param {object} S Sim state.
   */
  traffic.init = function (S) {
    S.traffic = {
      stats: { count: 0, cap: TLV.tune.traffic.densityDefault, meanSpeed: 0, stationaryShare: 0, removals: 0, wrecks: 0 },
      tk: 0,
      iter: new Int32Array(S.vehicles.length),
      projLane: { laneId: -1, s: 0, lat: 0, dist: 0, headingErr: 0 },
      dynBody: { x: 0, y: 0, h: 0, length: 0, width: 0, vx: 0, vy: 0 }
    };
    if (!S.world) return;
    traffic.pool.init(S);
    traffic.idm.init(S);
    traffic.gate.init(S);
    traffic.lanechange.init(S);
    traffic.behaviours.init(S);
    traffic.spawner.init(S);
    traffic.deadlock.init(S);
    traffic.diagnostics.init(S);
    S.bus.on('player.horn', function (e) { onHorn(S, e); });
    // A tailgater that has run into the player falls back. One brake check is one rear-end, not a shove along the road.
    S.bus.on('player.contact', function (e) {
      if (e.kind !== 'vehicle' || !e.rearEnded) return;
      var veh = traffic.byId(S, e.otherId);
      if (veh && veh.beh === 'TAILGATE') traffic.behaviours.backOff(S, veh);
    });
  };

  /** Horn: cars in a 12 m forward cone get +30% accel for 2 s (GAME_DESIGN 4). */
  function onHorn(S, e) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var c = Math.cos(e.h);
    var s = Math.sin(e.h);
    var cone = Math.cos(Q.hornDeg * Math.PI / 180);
    for (var i = 0; i < T.nAct; i++) {
      var veh = S.vehicles[T.act[i]];
      var dx = veh.x - e.x;
      var dy = veh.y - e.y;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d > Q.hornM || d < 1e-6) continue;
      if ((dx * c + dy * s) / d >= cone) veh._t.hornBoostT = Q.hornBoostS;
    }
  }

  /**
   * Keeps a car's brake-light bit true for this tick. Render reads `lights` and nothing else (ARCHITECTURE 10.2, 15.1), and GAME_DESIGN 9
   * and 11.1 make these the telegraph of a sudden stop. Only this bit is touched: the rest belong to the behaviours. On while a driver
   * slows or stands in the lane, off for a car no driver has: scripted, parked, knocked loose, wrecked, or double-parked and left.
   * @param {object} veh Vehicle, after its move.
   */
  function brakeLight(veh) {
    var Q = TLV.tune.traffic;
    var BRAKE = TLV.const.VL.BRAKE;
    var lit = false;
    if (veh.mode === 'LANE' || veh.mode === 'CONN') {
      // A stop ends in a long creep, slowing by too little to count, so standing starts at what the rest of this package calls stationary.
      if (veh.v < Q.stationaryV && veh.v > -Q.stationaryV) {
        lit = veh.beh !== 'DOUBLE_PARK';
      } else {
        // Against the motion, so a car speeding up in reverse is not braking.
        var slowing = veh.v > 0 ? -veh.accel : veh.accel;
        lit = slowing > (veh.lights & BRAKE ? Q.brakeLightOff : Q.brakeLightOn);
      }
    }
    if (lit) veh.lights |= BRAKE;
    else veh.lights &= ~BRAKE;
  }

  /**
   * Tick row 6: moves the AI and rebuilds the broadphase at the end (ARCHITECTURE 9.2).
   * @param {object} S Sim state.
   * @param {number} dt Tick, seconds.
   */
  traffic.update = function (S, dt) {
    var T = S.traffic;
    if (!S.world) return;
    var Q = TLV.tune.traffic;
    var idm = traffic.idm;
    var gate = traffic.gate;
    var beh = traffic.behaviours;
    var deadlock = traffic.deadlock;
    var lanechange = traffic.lanechange;
    var list = S.vehicles;
    var tk = ++T.tk;
    var n = T.nAct;
    var iter = T.iter;
    var i;
    idm.rebuild(S);
    // A car placed since the last tick has to be in the grid before any neighbour list is refreshed from it.
    if (T.gridDirty) {
      idm.broadphase(S);
      T.gridDirty = false;
    }
    for (i = 0; i < n; i++) iter[i] = T.act[i];
    for (i = 0; i < n; i++) {
      var veh = list[iter[i]];
      if (!veh.active) continue;
      var slot = veh.slot;
      if ((tk + slot) % Q.fsmTicks === 0) {
        beh.fsm(S, veh);
        if (!veh.active) continue;
        if (veh.mode === 'PARKED') beh.parkedPull(S, veh);
        deadlock.requeue(S, veh);
      }
      if (veh.mode === 'LANE' || veh.mode === 'CONN') {
        var t = veh._t;
        if ((tk + slot) % Q.gateTicks === 0) {
          gate.update(S, veh);
          idm.scan(S, veh);
          if (t.pg < t.pn && veh.v < 2) t.waitT += Q.gateTicks * TLV.const.DT;
        }
        if (t.reverse > 0) beh.reverseStep(S, veh);
        else idm.step(S, veh);
      }
    }
    for (i = 0; i < n; i++) {
      var car = list[iter[i]];
      if (!car.active) continue;
      beh.tick(S, car, dt);
      if ((tk + car.slot) % Q.nearTicks === 0) idm.refreshNear(S, car);
      if (car.mode === 'LANE' || car.mode === 'CONN') {
        idm.move(S, car, dt);
        lanechange.settle(S, car);
      } else {
        beh.offPath(S, car, dt);
      }
      if (car.active) {
        deadlock.tick(S, car, dt);
        brakeLight(car);
      }
    }
    idm.broadphase(S);
  };

  /**
   * Tick row 15: spawn, despawn, adaptive cap and the ladder, every 15 ticks.
   * @param {object} S Sim state.
   * @param {number} dt Tick, seconds.
   */
  traffic.maintain = function (S, dt) {
    if (!S.world || !S.player) return;
    var Q = TLV.tune.traffic;
    if (S.tick % Q.maintainTicks !== 0) return;
    traffic.diagnostics.sample(S, Q.maintainTicks * dt);
    traffic.deadlock.maintain(S);
    traffic.spawner.maintain(S);
  };

  /**
   * Fills the bubble at run start. Called by flow.startRun.
   * @param {object} S Sim state.
   */
  traffic.prewarm = function (S) {
    if (S.world) traffic.spawner.prewarm(S);
  };

  /**
   * Keeps a route light while it is set, for the tutorial. Private to the sim packages.
   * @param {object} S Sim state.
   * @param {?object} route Route, or null to end it.
   */
  traffic._calm = function (S, route) {
    if (S.world) traffic.spawner.calm(S, route);
  };

  /**
   * Places a car on a lane.
   * @param {object} S Sim state.
   * @param {object} spec { laneId, s, v?, kind?, variant?, ag?, route?: Route, force?: bool }.
   * @returns {?object} Vehicle, or null if the pool is full or the slot overlaps.
   */
  traffic.spawn = function (S, spec) {
    return S.world && spec ? traffic.spawner.place(S, spec) : null;
  };

  /**
   * Places a car on a lane near a point, hidden from the player.
   * @param {object} S Sim state.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} r Radius.
   * @param {object} spec As traffic.spawn, with lane and s left out.
   * @returns {?object} Vehicle or null.
   */
  traffic.spawnOutOfView = function (S, x, y, r, spec) {
    return S.world ? traffic.spawner.outOfView(S, x, y, r, spec || {}) : null;
  };

  /**
   * Removes a car, through releaseAll, restoring any stall it held.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {string} reason 'range', 'watchdog', 'script' or 'wreck'.
   */
  traffic.despawn = function (S, veh, reason) {
    if (!veh || !veh.active || veh.isPlayer) return;
    var T = S.traffic;
    var t = veh._t;
    traffic.gate.releaseAll(S, veh);
    if (t.spotId >= 0) {
      TLV.world.parking.setState(S, t.spotId, t.spotPrior);
      t.spotId = -1;
    }
    T.count[veh.beh]--;
    var id = veh.id;
    traffic.pool.give(S, veh);
    T.stats.count = T.nAct;
    traffic.behaviours.emit(S, 'traffic.despawn', { vehId: id, reason: reason });
  };

  /**
   * Issues a command (ARCHITECTURE 13.1).
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {object} cmd Command.
   * @returns {boolean} False if the vehicle cannot comply. Never throws.
   */
  traffic.command = function (S, veh, cmd) {
    return S.world ? traffic.behaviours.command(S, veh, cmd) : false;
  };

  /**
   * Back to CRUISE.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   */
  traffic.release = function (S, veh) {
    if (S.world) traffic.behaviours.release(S, veh);
  };

  /**
   * Applies a collision impulse.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {number} jx Impulse x, m/s.
   * @param {number} jy Impulse y, m/s.
   */
  traffic.applyImpact = function (S, veh, jx, jy) {
    if (S.world && veh && veh.active && !veh.isPlayer) traffic.behaviours.applyImpact(S, veh, jx, jy);
  };

  /** @returns {boolean} True when a body stands in a stall: a live car must not appear on the player, or on a bus going by. */
  function stallTaken(S, spot) {
    var math = TLV.math;
    var Q = TLV.tune.traffic;
    var T = S.traffic;
    var box = T.stallBox || (T.stallBox = { x: 0, y: 0, h: 0, length: 0, width: 0 });
    box.x = spot.x;
    box.y = spot.y;
    box.h = spot.h;
    box.length = TLV.const.VEHICLE_SIZES.sedan.length + Q.stallClear;
    box.width = TLV.const.VEHICLE_SIZES.sedan.width + Q.stallClear;
    if (S.vehicles[0].active && math.obbOverlap(box, S.vehicles[0])) return true;
    for (var i = 0; i < T.nAct; i++) {
      var o = S.vehicles[T.act[i]];
      if (math.dist2(o.x, o.y, spot.x, spot.y) < Q.stallReach * Q.stallReach && math.obbOverlap(box, o)) return true;
    }
    return false;
  }

  /**
   * Turns a parked stall into a live PARKED vehicle. The stall's state becomes VEHICLE and the prior state stays in _t.
   * @param {object} S Sim state.
   * @param {number} spotId Stall.
   * @returns {?object} Vehicle or null.
   */
  traffic.materializeParked = function (S, spotId) {
    var W = S.world;
    if (!W) return null;
    var parking = TLV.world.parking;
    var spot = parking.spot(W, spotId);
    if (!spot) return null;
    var OCC = TLV.const.OCC;
    var prior = parking.state(S, spotId);
    if (prior === OCC.VEHICLE) return null;
    var T = S.traffic;
    if (stallTaken(S, spot)) return null;
    var kinds = ['sedan', 'hatch', 'taxi'];
    var veh = traffic.pool.take(S, kinds[TLV.rng.hash32(spotId) % kinds.length], TLV.rng.hash32(spotId) & 7, S.rng.traffic.beta22());
    if (!veh) return null;
    T.count.CRUISE++;
    var t = veh._t;
    veh.mode = 'PARKED';
    veh.laneId = -1;
    veh.x = spot.x;
    veh.y = spot.y;
    veh.h = spot.h;
    veh.px = spot.x;
    veh.py = spot.y;
    veh.ph = spot.h;
    traffic.idm.placeAxles(veh);
    traffic.idm.introduce(S, veh);
    T.gridDirty = true;
    t.spotId = spotId;
    t.spotPrior = prior;
    parking.setState(S, spotId, OCC.VEHICLE);
    traffic.behaviours.emit(S, 'traffic.spawn', { vehId: veh.id, kind: veh.kind });
    return veh;
  };

  /**
   * @param {object} S Sim state.
   * @param {number} id Vehicle id.
   * @returns {?object} Active vehicle or null.
   */
  traffic.byId = function (S, id) {
    if (id === 0) return S.vehicles[0];
    var T = S.traffic;
    for (var i = 0; i < T.nAct; i++) {
      var veh = S.vehicles[T.act[i]];
      if (veh.id === id) return veh;
    }
    return null;
  };

  /**
   * @param {object} S Sim state.
   * @param {number} laneId Lane.
   * @param {number} s Position.
   * @param {number} maxDist Metres to look ahead.
   * @returns {?object} Nearest AI car ahead on the lane, or null.
   */
  traffic.leadOn = function (S, laneId, s, maxDist) {
    if (!S.world || laneId < 0) return null;
    var T = S.traffic;
    if (T.mark[laneId] !== T.stamp) return null;
    for (var e = T.head[laneId]; e >= 0; e = T.eNext[e]) {
      if (T.eS[e] <= s || T.eVeh[e] <= 0) continue;
      return T.eS[e] - s <= maxDist ? S.vehicles[T.eVeh[e]] : null;
    }
    return null;
  };

  /**
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {number} maxDist Metres to look behind.
   * @returns {?object} The AI car behind it on its lane, or null.
   */
  traffic.followerOf = function (S, veh, maxDist) {
    if (!S.world || !veh || veh.laneId < 0) return null;
    var T = S.traffic;
    if (T.mark[veh.laneId] !== T.stamp) return null;
    var best = null;
    var at = veh.isPlayer ? T.pS : veh.s;
    for (var e = T.head[veh.laneId]; e >= 0; e = T.eNext[e]) {
      if (T.eS[e] >= at) break;
      if (T.eVeh[e] > 0 && at - T.eS[e] <= maxDist) best = S.vehicles[T.eVeh[e]];
    }
    return best;
  };

  /**
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {Object<number,boolean>} onRoute Directed edges of a route.
   * @returns {boolean} True when a grant it already holds takes the car off the route. A new route cannot turn it back from that.
   */
  traffic._leavesRoute = function (S, veh, onRoute) {
    var W = S.world;
    var t = veh._t;
    for (var i = 0; i < t.pg; i++) {
      if (!onRoute[W.lanes[W.conns[t.plan[i]].to].dirEdge]) return true;
    }
    return false;
  };

  /**
   * @param {object} S Sim state.
   * @param {number} laneId Lane.
   * @param {number} s Position on it.
   * @param {number} maxDist Metres to look behind.
   * @returns {?object} The nearest AI car behind a position on a lane, or null. Private to the sim packages.
   */
  traffic._behindOn = function (S, laneId, s, maxDist) {
    if (!S.world || laneId < 0) return null;
    var T = S.traffic;
    if (T.mark[laneId] !== T.stamp) return null;
    var best = null;
    for (var e = T.head[laneId]; e >= 0; e = T.eNext[e]) {
      if (T.eS[e] >= s) break;
      if (T.eVeh[e] > 0 && s - T.eS[e] <= maxDist) best = S.vehicles[T.eVeh[e]];
    }
    return best;
  };

  /**
   * @param {object} S Sim state.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} r Radius.
   * @param {object[]} out Cleared, then filled with vehicles, the player included.
   * @returns {number} Count.
   */
  traffic.vehiclesNear = function (S, x, y, r, out) {
    var T = S.traffic;
    var buf = T.nearBuf || (T.nearBuf = new Int32Array(S.vehicles.length));
    var n = S.world ? traffic.idm.near(S, x, y, r, buf, -1) : 0;
    out.length = 0;
    for (var i = 0; i < n; i++) out.push(S.vehicles[buf[i]]);
    return n;
  };

  /**
   * @param {object} S Sim state.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @returns {boolean} True within 170 m of the player, within +-75 deg of its heading, and not ray-blocked.
   */
  traffic.visibleToPlayer = function (S, x, y) {
    var Q = TLV.tune.traffic;
    var p = S.player;
    if (!p) return false;
    var dx = x - p.fx;
    var dy = y - p.fy;
    var d2 = dx * dx + dy * dy;
    if (d2 > Q.visibleM * Q.visibleM) return false;
    var h = p.mode === 'FOOT' && p.foot ? p.foot.h : S.vehicles[0].h;
    var d = Math.sqrt(d2);
    if (d > 1e-6 && (dx * Math.cos(h) + dy * Math.sin(h)) / d < Math.cos(Q.visibleDeg * Math.PI / 180)) return false;
    return !TLV.world.spatial.rayBlocked(S.world, p.fx, p.fy, x, y);
  };

  /**
   * Overrides the adaptive cap.
   * @param {object} S Sim state.
   * @param {number} target Cars.
   */
  traffic.setDensity = function (S, target) {
    S.traffic.override = target;
    S.traffic.stats.cap = target;
  };

  // ---- Invariants (ARCHITECTURE 17.3). ----------------------------------------------------------------------------------

  /** Lateral at most width/2 + 1 m, unless in an exempt state. */
  function laneBoundFailure(S) {
    var T = S.traffic;
    if (!T || !S.world) return null;
    var Q = TLV.tune.traffic;
    var off = traffic.behaviours.OFF_LANE;
    for (var i = 0; i < T.nAct; i++) {
      var veh = S.vehicles[T.act[i]];
      if (veh.mode !== 'LANE' || off[veh.beh]) continue;
      var lane = S.world.lanes[veh.laneId];
      var lat = veh.lat < 0 ? -veh.lat : veh.lat;
      if (lat > lane.width / 2 + Q.laneBoundPad) return 'car ' + veh.id + ' ' + veh.beh + ' lat ' + veh.lat.toFixed(2) + ' on lane ' + lane.id;
    }
    return null;
  }

  /** No AI-AI box overlap outside WRECK. */
  function overlapFailure(S) {
    var T = S.traffic;
    if (!T || !S.world) return null;
    var math = TLV.math;
    for (var i = 0; i < T.nAct; i++) {
      var a = S.vehicles[T.act[i]];
      if (a.mode === 'WRECK') continue;
      for (var k = i + 1; k < T.nAct; k++) {
        var b = S.vehicles[T.act[k]];
        if (b.mode === 'WRECK') continue;
        var dx = a.x - b.x;
        var dy = a.y - b.y;
        var r = a._t.diag + b._t.diag;
        if (dx * dx + dy * dy > r * r) continue;
        if (math.obbOverlap(a, b)) {
          return 'cars ' + a.id + ' (' + a.kind + ' ' + a.mode + ' ' + a.beh + ') and ' + b.id + ' (' + b.kind + ' ' + b.mode + ' ' + b.beh +
            ') at (' + a.x.toFixed(1) + ', ' + a.y.toFixed(1) + ')';
        }
      }
    }
    return null;
  }

  /** No AI body centre in a building while in mode LANE. A NO_COLLIDER building has no walls to be inside. */
  function buildingFailure(S) {
    var T = S.traffic;
    var W = S.world;
    if (!T || !W) return null;
    var spatial = TLV.world.spatial;
    for (var i = 0; i < T.nAct; i++) {
      var veh = S.vehicles[T.act[i]];
      if (veh.mode !== 'LANE') continue;
      var b = spatial.pointInBuilding(W, veh.x, veh.y);
      if (b >= 0 && !(W.blds[b].flags & 1)) return 'car ' + veh.id + ' ' + veh.beh + ' in building ' + b;
    }
    return null;
  }

  /** Lane lists sorted, bumper gap at least -0.1 m. */
  function orderingFailure(S) {
    var T = S.traffic;
    if (!T || !S.world) return null;
    var Q = TLV.tune.traffic;
    traffic.idm.rebuild(S);
    for (var p = 0; p < T.nL + T.nC; p++) {
      if (T.mark[p] !== T.stamp) continue;
      var e = T.head[p];
      var next = T.eNext[e];
      while (next >= 0) {
        if (T.eS[next] < T.eS[e]) return 'path ' + p + ' out of order';
        var a = T.eVeh[e];
        var b = T.eVeh[next];
        if (a > 0 && b > 0 && a !== b && oneLine(S, T, e, next)) {
          var gap = T.eS[next] - T.eHalf[next] - T.eS[e] - T.eHalf[e];
          if (gap < -Q.orderSlack) return 'path ' + p + ' cars ' + S.vehicles[a].id + ' and ' + S.vehicles[b].id + ' gap ' + gap.toFixed(2);
        }
        e = next;
        next = T.eNext[e];
      }
    }
    return null;
  }

  /** @returns {boolean} True when two entries share a line of travel. A car changing lanes or passing is beside the line, not in it. */
  function oneLine(S, T, e, f) {
    var p = S.vehicles[T.eVeh[e]];
    var q = S.vehicles[T.eVeh[f]];
    var off = traffic.behaviours.OFF_LANE;
    var aside = TLV.tune.traffic.lineLat;
    // A body knocked off its line by the player is an obstacle on the list, not a car in the queue. The Overlap gate still reads it.
    if ((p.mode !== 'LANE' && p.mode !== 'CONN') || (q.mode !== 'LANE' && q.mode !== 'CONN')) return false;
    if (p._t.lcTo >= 0 || q._t.lcTo >= 0 || off[p.beh] || off[q.beh]) return false;
    if (p.lat > aside || p.lat < -aside || q.lat > aside || q.lat < -aside) return false;
    var d = T.eLat[e] - T.eLat[f];
    if (d < 0) d = -d;
    return d < T.eHW[e] + T.eHW[f];
  }

  /** Max stuckT at most watchdog + 5 s. */
  function stuckFailure(S) {
    var T = S.traffic;
    if (!T || !S.world) return null;
    var Q = TLV.tune.traffic;
    for (var i = 0; i < T.nAct; i++) {
      var veh = S.vehicles[T.act[i]];
      var limit = traffic.deadlock.watchdog(S, veh) + Q.stuckPad;
      if (veh.stuckT > limit) return 'car ' + veh.id + ' ' + veh.beh + ' stuck ' + veh.stuckT.toFixed(1) + ' s, limit ' + limit.toFixed(1);
    }
    return null;
  }
})(window.TLV);
