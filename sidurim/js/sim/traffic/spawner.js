// js/sim/traffic/spawner.js — WP-TRAFFIC
// Keeps the bubble around the player full (ARCHITECTURE 12.5): cars appear in the 140-300 m ring and leave at 390 m. Lanes come
// from the 60 m grid, because uniform lane sampling reached only 26 of 180 cars [M].
(function (TLV) {
  'use strict';

  var spawner = TLV.ns('traffic.spawner');

  /** Most lanes a 60 m query can return, and most in a whole bubble. */
  var LANE_BUF = 2048;
  var CLEAR_LANES = 16;

  /**
   * Creates the spawner state.
   * @param {object} S Sim state.
   */
  spawner.init = function (S) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    T.laneBuf = new Int32Array(LANE_BUF);
    T.spot = { laneId: -1, s: 0 };
    T.density = Q.densityDefault;
    T.override = S.params && S.params.density !== null && S.params.density !== undefined ? S.params.density : null;
    T.bubbleLanes = new Int32Array(LANE_BUF);
    T.bubbleSum = new Float64Array(LANE_BUF);
    T.bubbleN = 0;
    T.laneKm = Infinity;
    T.laneKmT = 0;
    T.laneKmX = 0;
    T.laneKmY = 0;
    T.shareSum = 0;
    T.shareN = 0;
    T.adaptT = 0;
    T.noSpawn = false;
    T.clearLanes = new Int32Array(CLEAR_LANES);
    T.clearN = 0;
    T.clearS = 0;
    T.quiet = false;
    T.calm = new Uint8Array(S.world.dirEdges.length);
    T.calmOn = false;
  };

  /** @returns {number} The live target (ARCHITECTURE 12.5). */
  function target(T) {
    if (T.override !== null) return T.override;
    var Q = TLV.tune.traffic;
    var byRoad = Q.densityPerKm * T.laneKm;
    return T.density < byRoad ? T.density : byRoad;
  }

  spawner.target = target;

  /** Lane-km of AI lanes in the bubble, for the target, and the lanes it holds. */
  function measureLaneKm(S) {
    var T = S.traffic;
    var W = S.world;
    var Q = TLV.tune.traffic;
    var p = S.player;
    // The list runs out to the shell, where a stranded bubble may put cars. The target reads the bubble proper.
    var n = TLV.world.lanes.lanesNear(W, p.fx, p.fy, Q.strandedMax, T.bubbleLanes);
    var sum = 0;
    var total = 0;
    var mid = T.at;
    for (var i = 0; i < n; i++) {
      var id = T.bubbleLanes[i];
      var lane = W.lanes[id];
      TLV.math.polyAt(lane.px, lane.py, lane.cum, lane.len / 2, mid);
      if ((lane.flags & TLV.const.LF.AI_ROUTABLE) && TLV.math.dist2(mid.x, mid.y, p.fx, p.fy) <= Q.bubbleSpawnMax * Q.bubbleSpawnMax) sum += lane.len;
      total += weightOf(W, id) * lane.len;
      T.bubbleSum[i] = total;
    }
    T.bubbleN = n;
    T.laneKm = sum / 1000;
    T.laneKmX = p.fx;
    T.laneKmY = p.fy;
  }

  /** Picks a lane of the bubble by weight and length. On a thin stretch of map most of the ring is sea, and ring sampling starves. */
  function sampleBubble(S) {
    var T = S.traffic;
    var W = S.world;
    var Q = TLV.tune.traffic;
    var n = T.bubbleN;
    if (n === 0 || T.bubbleSum[n - 1] <= 0) return false;
    var u = S.rng.spawn.next() * T.bubbleSum[n - 1];
    var lo = 0;
    var hi = n - 1;
    while (lo < hi) {
      var mid = (lo + hi) >> 1;
      if (T.bubbleSum[mid] > u) hi = mid;
      else lo = mid + 1;
    }
    var lane = W.lanes[T.bubbleLanes[lo]];
    if (lane.len < Q.spawnStart + Q.spawnEnd + 1) return false;
    T.spot.laneId = lane.id;
    T.spot.s = S.rng.spawn.range(Q.spawnStart, lane.len - Q.spawnEnd);
    return true;
  }

  /** Spawn weight of a lane, or 0 where no car may start. */
  function weightOf(W, laneId) {
    var Q = TLV.tune.traffic;
    var lane = W.lanes[laneId];
    if (!(lane.flags & TLV.const.LF.AI_ROUTABLE) || (lane.flags & TLV.const.LF.EXCLUSIVE)) return 0;
    if (lane.len < Q.spawnStart + Q.spawnEnd + 1 || lane.conns.length === 0) return 0;
    return TLV.tune.world.classWeights[lane.cls];
  }

  /** Picks a lane near a point. @returns {boolean} True when T.spot was set. */
  function sampleRing(S, rmin, rmax) {
    var T = S.traffic;
    var W = S.world;
    var Q = TLV.tune.traffic;
    var p = S.player;
    var rng = S.rng.spawn;
    var ang = rng.range(0, Math.PI * 2);
    // Toward the near edge of the ring, so that a player on the move has cars round it, not only at the rim of the bubble.
    var r = rmin + (rmax - rmin) * Math.pow(rng.next(), Q.spawnRingPow);
    var n = TLV.world.lanes.lanesNear(W, p.fx + Math.cos(ang) * r, p.fy + Math.sin(ang) * r, Q.spawnGridR, T.laneBuf);
    var total = 0;
    var i;
    for (i = 0; i < n; i++) total += weightOf(W, T.laneBuf[i]);
    if (total <= 0) return false;
    var u = rng.next() * total;
    var pick = -1;
    for (i = 0; i < n; i++) {
      u -= weightOf(W, T.laneBuf[i]);
      if (u < 0) {
        pick = T.laneBuf[i];
        break;
      }
    }
    if (pick < 0) return false;
    var lane = W.lanes[pick];
    T.spot.laneId = pick;
    T.spot.s = rng.range(Q.spawnStart, lane.len - Q.spawnEnd);
    return true;
  }

  /** Walks the player's road forward, so perceived density stays high ahead (ARCHITECTURE 12.5). */
  function sampleAhead(S, rmin, rmax) {
    var T = S.traffic;
    var W = S.world;
    var Q = TLV.tune.traffic;
    var rng = S.rng.spawn;
    var laneId = S.vehicles[0].laneId;
    if (laneId < 0) return false;
    var want = rng.range(rmin, rmax);
    var d = 0;
    var at = laneId;
    for (var hop = 0; hop < Q.spawnAheadWalk; hop++) {
      var lane = W.lanes[at];
      if (d + lane.len >= want && weightOf(W, at) > 0) {
        T.spot.laneId = at;
        T.spot.s = TLV.math.clamp(want - d, Q.spawnStart, lane.len - Q.spawnEnd);
        return true;
      }
      d += lane.len;
      var c = TLV.world.routing.randomExit(W, at, rng);
      if (c < 0) return false;
      d += W.conns[c].len;
      at = W.conns[c].to;
    }
    return false;
  }

  /** @returns {string} A kind from the spawn mix. */
  function pickKind(S) {
    var Q = TLV.tune.traffic;
    var u = S.rng.spawn.next() * 100;
    for (var i = 0; i < Q.spawnKinds.length; i++) {
      u -= Q.spawnMix[i];
      if (u < 0) return Q.spawnKinds[i];
    }
    return 'sedan';
  }

  /** @returns {boolean} True when a car's box at a lane position would touch any other car. */
  function bodyClash(S, laneId, s, kind) {
    var W = S.world;
    var T = S.traffic;
    var size = TLV.const.VEHICLE_SIZES[kind];
    TLV.world.lanes.pointAt(W, laneId, s, T.at);
    var c = Math.cos(T.at.h);
    var n = Math.sin(T.at.h);
    var hl = size.length / 2;
    var hw = size.width / 2;
    var apart = TLV.traffic.idm.apart;
    for (var i = -1; i < T.nAct; i++) {
      var o = S.vehicles[i < 0 ? 0 : T.act[i]];
      if (!o.active) continue;
      var dx = o.x - T.at.x;
      var dy = o.y - T.at.y;
      var r = 14;
      if (dx * dx + dy * dy > r * r) continue;
      if (apart(T.at.x, T.at.y, c, n, hl, hw, o.x, o.y, Math.cos(o.h), Math.sin(o.h), o.length / 2, o.width / 2) < 0.2) return true;
    }
    return false;
  }

  /**
   * Places a car on a lane.
   * @param {object} S Sim state.
   * @param {object} spec { laneId, s, v?, kind?, variant?, ag?, route?, force? }.
   * @returns {?object} Vehicle, or null if the pool is full, the lane unknown, or the slot overlaps.
   */
  /**
   * @returns {boolean} True when someone stands in a new car's body, or on the road ahead of it inside the room it needs to stop. A car
   * placed at speed on a person was every fast contact in the game soak, because nothing brakes before it exists.
   */
  function peopleClash(S, laneId, s, kind, v) {
    var peds = TLV.peds;
    if (!peds || !peds.pedsNear || !S.pedsys) return false;
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var size = TLV.const.VEHICLE_SIZES[kind];
    var hl = size.length / 2;
    var run = hl + v * v / (2 * Q.hardBrake) + v * Q.spawnPersonS;
    TLV.world.lanes.pointAt(S.world, laneId, s, T.at);
    var x = T.at.x;
    var y = T.at.y;
    var c = Math.cos(T.at.h);
    var h = Math.sin(T.at.h);
    var count = peds.pedsNear(S, x, y, run + size.width / 2 + Q.spawnPersonM, T.pedNear);
    for (var i = 0; i < count; i++) {
      var p = T.pedNear[i];
      var along = (p.x - x) * c + (p.y - y) * h;
      var side = (p.y - y) * c - (p.x - x) * h;
      var pad = (p.r || 0) + Q.spawnPersonM;
      if (along > -hl - pad && along < run + pad && side > -size.width / 2 - pad && side < size.width / 2 + pad) return true;
    }
    return false;
  }

  /**
   * The lane lists stop at the lane's start, but a car on the lane before is as close, and a bus's nose reaches 6 m past where it is
   * listed. The list will read that nose along this lane the moment the car's centre arrives, however it is turned by then, so a car
   * put down in that reach is an overlap on the list and a hard stop for the bus.
   * @param {object} S Sim state.
   * @param {number} laneId Lane.
   * @param {number} room How far along the lane a nose coming up from behind may reach.
   * @returns {boolean} True when one on its way to this lane reaches further than that.
   */
  function noseBehind(S, laneId, room) {
    var W = S.world;
    var T = S.traffic;
    if (room >= TLV.tune.traffic.nearBody) return false;
    for (var i = 0; i < T.nAct; i++) {
      var o = S.vehicles[T.act[i]];
      var t = o._t;
      // Metres from its centre to the lane's start, and the most that can be with its nose still in reach.
      var d;
      var most = t.halfL - room;
      if (o.mode === 'LANE') {
        if (o.laneId === laneId) continue;
        d = W.lanes[o.laneId].len - o.s;
      } else if (o.mode === 'CONN') {
        var on = W.conns[o.connId];
        d = on.len - o.s;
        if (on.to === laneId) {
          if (d < most) return true;
          continue;
        }
        d += W.lanes[on.to].len;
      } else {
        continue;
      }
      for (var k = 0; k < t.pn && d < most; k++) {
        var c = W.conns[t.plan[k]];
        d += c.len;
        if (c.to === laneId) {
          if (d < most) return true;
          break;
        }
        d += W.lanes[c.to].len;
      }
    }
    return false;
  }

  spawner.place = function (S, spec) {
    var W = S.world;
    var T = S.traffic;
    var lane = W.lanes[spec.laneId];
    if (!lane) return null;
    var kind = spec.kind || pickKind(S);
    if (!TLV.const.VEHICLE_SIZES[kind]) return null;
    // The mix is by car, not by road: a long body drawn for a narrow street comes as a sedan.
    if (!spec.kind && (kind === 'bus' || kind === 'truck') && lane.width < TLV.tune.traffic.heavyLaneW) kind = 'sedan';
    var s = TLV.math.clamp(spec.s === undefined ? lane.len / 2 : spec.s, 0, lane.len);
    if (!spec.force && (bodyClash(S, spec.laneId, s, kind) || peopleClash(S, spec.laneId, s, kind, spec.v === undefined ? 0 : spec.v) ||
      noseBehind(S, spec.laneId, s - TLV.const.VEHICLE_SIZES[kind].length / 2))) return null;
    var variant = spec.variant === undefined ? S.rng.spawn.int(8) : spec.variant;
    var ag = spec.ag === undefined ? S.rng.traffic.beta22() : spec.ag;
    var veh = TLV.traffic.pool.take(S, kind, variant, ag);
    if (!veh) return null;
    var t = veh._t;
    T.count.CRUISE++;
    veh.laneId = spec.laneId;
    veh.s = s;
    veh.v = spec.v === undefined ? 0 : spec.v;
    TLV.world.lanes.pointAt(W, spec.laneId, s, T.at);
    veh.x = T.at.x;
    veh.y = T.at.y;
    veh.h = T.at.h;
    veh.px = veh.x;
    veh.py = veh.y;
    veh.ph = veh.h;
    veh.vx = veh.v * Math.cos(veh.h);
    veh.vy = veh.v * Math.sin(veh.h);
    TLV.traffic.idm.placeAxles(veh);
    t.route = spec.route || null;
    TLV.traffic.gate.extend(S, veh);
    TLV.traffic.idm.add(T, spec.laneId, s, t.halfL, veh.v, 0, t.halfW, veh.slot);
    TLV.traffic.idm.introduce(S, veh);
    T.gridDirty = true;
    TLV.traffic.behaviours.emit(S, 'traffic.spawn', { vehId: veh.id, kind: kind });
    return veh;
  };

  /**
   * Tries the place in T.spot.
   * @param {object} S Sim state.
   * @param {number} rmin Nearest to the player.
   * @param {number} rmax Farthest from the player.
   * @param {boolean} hidden True to keep out of the player's sight.
   * @param {number} gap Least room to the cars either side.
   * @returns {?object} Vehicle or null.
   */
  function trySpot(S, rmin, rmax, hidden, gap) {
    var T = S.traffic;
    var W = S.world;
    var Q = TLV.tune.traffic;
    var p = S.player;
    var laneId = T.spot.laneId;
    var s = T.spot.s;
    TLV.world.lanes.pointAt(W, laneId, s, T.at);
    var x = T.at.x;
    var y = T.at.y;
    var d = TLV.math.dist(x, y, p.fx, p.fy);
    if (d < rmin || d > rmax) return null;
    // A car heading in joins whatever holds the bubble up. One heading out drives, and leaves.
    if (hidden && T.stats.stationaryShare > Q.spawnOutShare && (x - p.fx) * Math.cos(T.at.h) + (y - p.fy) * Math.sin(T.at.h) < 0) return null;
    if (hidden && TLV.traffic.visibleToPlayer(S, x, y)) return null;
    for (var i = 0; i < T.clearN; i++) {
      if (laneId === T.clearLanes[i] && (i > 0 || s > T.clearS)) return null;
    }
    if (T.calmOn && T.calm[W.lanes[laneId].dirEdge]) return null;
    // A car on a connector into this lane is on no list of the lane yet, and would arrive under this one's tail.
    if (T.reserved[laneId] > 0 && s - 2.5 < T.reserved[laneId] + gap) return null;
    var nb = TLV.traffic.idm.neighbours(S, laneId, s, 2.5, -9, T.gapBuf);
    if (nb.leadGap < gap || nb.follGap < gap) return null;
    if (noseBehind(S, laneId, s - 2.5 - gap)) return null;
    // A car that appears behind a standing queue only feeds it, unless the bubble is short of cars.
    if (hidden && T.nAct >= target(T) * Q.spawnShort && nb.leadGap < Q.spawnQueueM && nb.leadV < Q.stationaryV) return null;
    var lane = W.lanes[laneId];
    var v = lane.vmax * 0.7;
    if (nb.leadGap < 40 && nb.leadV < v) v = nb.leadV;
    return spawner.place(S, { laneId: laneId, s: s, v: v });
  }

  /** Spawns or trims toward the target, once per maintain. */
  spawner.fill = function (S) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var want = target(T);
    var rng = S.rng.spawn;
    if (T.nAct > want) {
      trim(S);
      return;
    }
    if (T.noSpawn) return;
    if (T.nAct >= want && Math.abs(S.vehicles[0].v) > Q.spawnRecycleV) recycle(S);
    var made = 0;
    var short = T.nAct < want * Q.spawnShort;
    var stranded = T.nAct < want * Q.strandedShare;
    for (var i = 0; i < Q.spawnTries && T.nAct < want && made < Q.spawnPerCall; i++) {
      var ok;
      if (short) ok = sampleBubble(S);
      else if (rng.next() < Q.spawnAhead) ok = sampleAhead(S, Q.bubbleSpawnMin, Q.bubbleSpawnMax);
      else ok = sampleRing(S, Q.bubbleSpawnMin, Q.bubbleSpawnMax);
      if (!ok) continue;
      if (stranded) {
        // After a teleport into a corner of the map there is little road, and all of it is near.
        if (trySpot(S, Q.strandedMin, Q.strandedMax, true, Q.strandedGap)) made++;
      } else if (trySpot(S, Q.bubbleSpawnMin, Q.bubbleSpawnMax, true, Q.spawnGap)) {
        made++;
      }
    }
  };

  /**
   * Moves a few cars from the shell between the ring and the despawn line into the ring. A moving player leaves cars behind it that
   * count against the target for the whole 90 m of the shell, while the road ahead runs thin.
   */
  function recycle(S) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var p = S.player;
    var limit = Q.bubbleSpawnMax * Q.bubbleSpawnMax;
    var done = 0;
    for (var i = T.nAct - 1; i >= 0 && done < Q.spawnRecycle; i--) {
      var veh = S.vehicles[T.act[i]];
      if (veh.beh !== 'CRUISE' || veh.mode === 'PARKED') continue;
      if (TLV.math.dist2(veh.x, veh.y, p.fx, p.fy) <= limit) continue;
      if (TLV.traffic.visibleToPlayer(S, veh.x, veh.y)) continue;
      TLV.traffic.despawn(S, veh, 'range');
      done++;
    }
  }

  /** Removes one car beyond the target, the farthest not in view. */
  function trim(S) {
    var T = S.traffic;
    var p = S.player;
    var best = null;
    var far = -1;
    for (var i = 0; i < T.nAct; i++) {
      var veh = S.vehicles[T.act[i]];
      if (veh.beh !== 'CRUISE' || veh.mode === 'PARKED') continue;
      var d = TLV.math.dist2(veh.x, veh.y, p.fx, p.fy);
      if (d > far && !TLV.traffic.visibleToPlayer(S, veh.x, veh.y)) {
        far = d;
        best = veh;
      }
    }
    if (best) TLV.traffic.despawn(S, best, 'range');
  }

  /** Marks the lanes from the player to the next stop line and the lanes that line leads to, which prewarm leaves clear. */
  function markClear(S) {
    var T = S.traffic;
    var W = S.world;
    var veh = S.vehicles[0];
    T.clearN = 0;
    var at = veh.laneId;
    if (at < 0) return;
    var lane = W.lanes[at];
    TLV.math.polyProject(lane.px, lane.py, lane.cum, veh.x, veh.y, -1, T.proj);
    T.clearS = T.proj.s;
    while (at >= 0 && T.clearN < T.clearLanes.length) {
      T.clearLanes[T.clearN++] = at;
      lane = W.lanes[at];
      if (lane.conns.length !== 1) break;
      var c = W.conns[lane.conns[0]];
      if (c.px.length !== 2) break;
      at = c.to;
    }
    // The first green is short, and a queue standing just past the line loses the player all of it.
    for (var k = 0; k < lane.conns.length && T.clearN < T.clearLanes.length; k++) {
      T.clearLanes[T.clearN++] = W.conns[lane.conns[k]].to;
    }
  }

  /**
   * Keeps a road light for as long as it is set: the tutorial's, which is one lane each way, with the player at a 120 s clock on it.
   * Nobody appears on it, a walk would sooner go another way, and nothing stops in its lane there by choice. Setting it thins the
   * cars already ahead of the player to calmGapM apart. Called between a run's prewarm and its first tick, so nothing vanishes in view.
   * @param {object} S Sim state.
   * @param {?object} route Route, or null to end it.
   */
  spawner.calm = function (S, route) {
    var T = S.traffic;
    var W = S.world;
    var Q = TLV.tune.traffic;
    T.calm.fill(0);
    T.calmOn = !!route;
    if (!route) return;
    var i;
    for (i = 0; i < route.dirEdges.length; i++) T.calm[route.dirEdges[i]] = 1;
    TLV.traffic.idm.rebuild(S);
    var gone = [];
    for (i = 0; i < route.dirEdges.length; i++) {
      var lanes = W.dirEdges[route.dirEdges[i]].lanes;
      for (var l = 0; l < lanes.length; l++) {
        var id = lanes[l];
        if (T.mark[id] !== T.stamp) continue;
        var last = Infinity;
        var from = id === S.vehicles[0].laneId ? T.pS : -Infinity;
        for (var e = T.head[id]; e >= 0; e = T.eNext[e]) {
          if (T.eS[e] < from || T.eVeh[e] <= 0) continue;
          var car = S.vehicles[T.eVeh[e]];
          if (car.beh !== 'CRUISE' || car.mode !== 'LANE') continue;
          // A long body swinging through a junction here has stood a green out against the head of the queue.
          if (car.length > Q.longBody) gone.push(car);
          else if (last === Infinity || T.eS[e] - last >= Q.calmGapM) last = T.eS[e];
          else gone.push(car);
        }
      }
    }
    for (i = 0; i < gone.length; i++) TLV.traffic.despawn(S, gone[i], 'script');
    TLV.traffic.idm.rebuild(S);
    TLV.traffic.idm.broadphase(S);
  };

  /**
   * Fills the bubble at run start and lets it settle, so the first minute does not play on an empty street (ARCHITECTURE 12.5).
   * Emits nothing, leaves S.tick alone, and is deterministic.
   * @param {object} S Sim state.
   */
  spawner.prewarm = function (S) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var DT = TLV.const.DT;
    var p = S.player;
    var i;
    T.quiet = true;
    T.noSpawn = false;
    for (i = T.nAct - 1; i >= 0; i--) {
      var veh = S.vehicles[T.act[i]];
      if (TLV.math.dist(veh.x, veh.y, p.fx, p.fy) > Q.bubbleDespawn) TLV.traffic.despawn(S, veh, 'range');
    }
    measureLaneKm(S);
    T.laneKmT = S.t;
    TLV.traffic.idm.rebuild(S);
    TLV.traffic.idm.broadphase(S);
    markClear(S);
    var want = target(T);
    for (i = 0; i < Q.prewarmTries && T.nAct < want; i++) {
      if (sampleBubble(S)) trySpot(S, Q.prewarmMin, Q.bubbleSpawnMax, false, Q.spawnGap);
    }
    for (i = 0; i < Q.prewarmTicks; i++) {
      S.sig.epoch += DT;
      TLV.traffic.update(S, DT);
    }
    T.clearN = 0;
    spawner.stats(S);
    T.quiet = false;
  };

  /** Updates the public stats, and the adaptive density at its own interval. */
  spawner.stats = function (S) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var sum = 0;
    var still = 0;
    var n = 0;
    for (var i = 0; i < T.nAct; i++) {
      var veh = S.vehicles[T.act[i]];
      if (veh.mode === 'PARKED') continue;
      var v = veh.v < 0 ? -veh.v : veh.v;
      sum += v;
      if (v < Q.stationaryV) still++;
      n++;
    }
    var st = T.stats;
    st.count = T.nAct;
    st.meanSpeed = n ? sum / n : 0;
    st.stationaryShare = n ? still / n : 0;
    st.cap = target(T);
  };

  /** Applies the 30 s density rule (GAME_DESIGN 9). */
  spawner.adapt = function (S) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    T.shareSum += T.stats.stationaryShare;
    T.shareN++;
    if (S.t < T.adaptT) return;
    T.adaptT = S.t + Q.adaptS;
    if (T.shareN === 0) return;
    var share = T.shareSum / T.shareN;
    T.shareSum = 0;
    T.shareN = 0;
    if (T.override !== null) return;
    if (share > Q.adaptHigh) T.density = Math.max(Q.densityMin, T.density * (1 - Q.adaptStep));
    else if (share < Q.adaptLow) T.density = Math.min(Q.densityMax, T.density * (1 + Q.adaptStep));
  };

  /**
   * Despawns what has left the bubble, then spawns toward the target.
   * @param {object} S Sim state.
   */
  spawner.maintain = function (S) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var p = S.player;
    var far = Q.bubbleDespawn * Q.bubbleDespawn;
    for (var i = T.nAct - 1; i >= 0; i--) {
      var veh = S.vehicles[T.act[i]];
      if (veh.beh === 'PARK_RACE' || veh.beh === 'PARK_HOLD' || veh.beh === 'RIVAL_BLOCK' || veh.beh === 'RIVAL_STANDOFF') continue;
      if (TLV.math.dist2(veh.x, veh.y, p.fx, p.fy) > far) TLV.traffic.despawn(S, veh, 'range');
    }
    // A teleport or a restart cannot wait for the next reading.
    if (S.t >= T.laneKmT || TLV.math.dist2(p.fx, p.fy, T.laneKmX, T.laneKmY) > Q.laneKmMoveM * Q.laneKmMoveM) {
      T.laneKmT = S.t + Q.laneKmEveryS;
      measureLaneKm(S);
    }
    spawner.stats(S);
    spawner.adapt(S);
    spawner.fill(S);
    T.stats.count = T.nAct;
  };

  /**
   * A lane near a point, out of the player's sight.
   * @param {object} S Sim state.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} r Radius.
   * @param {object} spec As spawn, laneId and s ignored.
   * @returns {?object} Vehicle or null.
   */
  spawner.outOfView = function (S, x, y, r, spec) {
    var T = S.traffic;
    var W = S.world;
    var Q = TLV.tune.traffic;
    var n = TLV.world.lanes.lanesNear(W, x, y, r, T.laneBuf);
    var rng = S.rng.spawn;
    for (var tries = 0; tries < 24 && n > 0; tries++) {
      var laneId = T.laneBuf[rng.int(n)];
      var lane = W.lanes[laneId];
      if (weightOf(W, laneId) <= 0) continue;
      var s = rng.range(Q.spawnStart, lane.len - Q.spawnEnd);
      TLV.world.lanes.pointAt(W, laneId, s, T.at);
      if (TLV.traffic.visibleToPlayer(S, T.at.x, T.at.y)) continue;
      var nb = TLV.traffic.idm.neighbours(S, laneId, s, 2.5, -9, T.gapBuf);
      if (nb.leadGap < Q.spawnGap || nb.follGap < Q.spawnGap) continue;
      var veh = spawner.place(S, {
        laneId: laneId, s: s, v: spec.v, kind: spec.kind, variant: spec.variant, ag: spec.ag, route: spec.route, force: spec.force
      });
      if (veh) return veh;
    }
    return null;
  };
})(window.TLV);
