// js/sim/peds/peds.js — WP-PEDS
// The public face of the package (ARCHITECTURE 12.6): update, maintain, spawn, commands, and the two things traffic reads,
// obstaclesOnLane and zoneOccupied. People think at 20 Hz in three buckets and move every tick, on a velocity set so that each one
// lands exactly where their path puts them at the next think.
(function (TLV) {
  'use strict';

  var peds = TLV.ns('peds');

  /** Lanes one person can be reported on at once. */
  var MAX_CLAIMS = 16;

  /** Sets a person's state and restarts its clock. */
  peds.setState = function (p, state) {
    p.state = state;
    p.stateT = 0;
  };

  /** @returns {boolean} True when the person rides. */
  function isRider(p) {
    return p.kind === 'scooter' || p.kind === 'delivery';
  }

  /** @returns {object} Scratch space for building paths, one list per field. */
  function newItems() {
    var cap = 16;
    return {
      x: new Float64Array(cap), y: new Float64Array(cap), arc: new Float64Array(cap), lat: new Float64Array(cap),
      s: new Float64Array(cap), half: new Float64Array(cap), clear: new Float64Array(cap),
      lane: new Int32Array(cap), zone: new Int32Array(cap), entry: new Uint8Array(cap)
    };
  }

  /**
   * Reads the map ahead of whoever would read it first: stalls, rows and their links, crossing lines. Each is static, is read once and
   * is kept, so a run that covers ground grows its heap by them as it goes, which is the cost of the first drive across the city, not a
   * leak. A few a tick, so that the first minute carries the work in slices and nobody meets a cold row at speed.
   */
  function warm(S) {
    var sys = S.pedsys;
    var W = S.world;
    var per = TLV.tune.world.spotsPerKerb;
    for (var k = TLV.tune.peds.warmKerbsPerTick; k > 0 && sys.warmKerb < W.kerbs.length; k--) TLV.world.parking.spot(W, per * sys.warmKerb++);
    if (sys.warmKerb < W.kerbs.length) return;
    for (var left = TLV.tune.peds.warmPerTick; left > 0; left--) {
      if (sys.warmRow < W.sidewalks.length) TLV.peds.walk.warmRow(S, sys.warmRow++);
      else if (sys.warmXing < W.xings.length) TLV.peds.cross.pathOf(S, sys.warmXing++);
      else {
        sys.warmed = true;
        return;
      }
    }
  }

  /**
   * Creates S.pedsys, and listens for the horn.
   * @param {object} S Sim state.
   */
  peds.init = function (S) {
    var W = S.world;
    var nPeople = S.peds.length + 1;
    var nLanes = W ? W.lanes.length : 0;
    var nZones = W ? W.zones.length : 0;
    var nXings = W ? W.xings.length : 0;
    var entries = nPeople * MAX_CLAIMS;
    var sys = {
      foot: nPeople - 1,
      rows: new Array(W ? W.sidewalks.length : 0),
      xpaths: new Array(nXings),
      warmKerb: 0, warmRow: 0, warmXing: 0, warmed: false,
      // Claims, per person, rebuilt into per-lane lists each tick.
      claimN: new Uint8Array(nPeople),
      claimLane: new Int32Array(entries), claimS: new Float32Array(entries), claimHalf: new Float32Array(entries),
      claimV: new Float32Array(entries), claimZone: new Int32Array(entries), claimDwell: new Uint8Array(entries),
      head: new Int32Array(nLanes),
      used: new Int32Array(entries), nUsed: 0,
      eS: new Float32Array(entries), eHalf: new Float32Array(entries), eV: new Float32Array(entries), eNext: new Int32Array(entries), nE: 0,
      // Zones.
      zoneCount: new Int16Array(nZones), zoneT: new Float32Array(nZones), zoneStamp: new Int32Array(nZones),
      touched: new Int32Array(entries), nTouched: 0,
      held: new Int32Array(entries), nHeld: 0, heldNext: new Int32Array(entries),
      xingHold: new Float64Array(nXings),
      maxDwell: 0,
      // Scratch, so no hot path allocates.
      near: [], nearN: 0, far: [], ttc: Infinity, ttcVeh: null,
      cpX: new Float64Array(16), cpY: new Float64Array(16),
      ints: new Int32Array(64), spots: [], spots2: [], juncSeen: new Int32Array(6),
      it: newItems(), order: new Int32Array(16),
      pt: { x: 0, y: 0, h: 0 }, pt2: { x: 0, y: 0, h: 0 }, pr: { s: 0, d: 0, side: 0 }, prB: { s: 0, d: 0, side: 0 }, swOut: { sw: -1, s: 0, d: 0 },
      box: { x: 0, y: 0, h: 0, length: 0, width: 0 }, lanePt: { laneId: -1, s: 0, lat: 0, dist: 0, headingErr: 0 },
      place: { sw: -1, s: 0, x: 0, y: 0 },
      gateWhy: '', gateSkip: -1, kinks: null, xgrid: null,
      // Population.
      filled: false, lastFx: 0, lastFy: 0, inBubble: 0, inOuter: 0, ambient: 0,
      // Reports.
      contacts: 0, lastContact: null, deepest: 0, reported: 0
    };
    sys.head.fill(-1);
    S.pedsys = sys;
    TLV.peds.pool.init(S, sys);
    S.bus.on('player.horn', function (e) { onHorn(S, e); });
    // FLEE is near a crash (GAME_DESIGN 10), and these are the crashes. Nothing else in the contract calls scare.
    S.bus.on('player.contact', function (e) {
      if (e.severity === 'crash') peds.scare(S, e.x, e.y, TLV.tune.peds.crashScareM);
    });
    S.bus.on('traffic.wreck', function (e) {
      var car = TLV.traffic && TLV.traffic.byId ? TLV.traffic.byId(S, e.vehId) : null;
      if (car) peds.scare(S, car.x, car.y, TLV.tune.peds.crashScareM);
    });
  };

  /** Pedestrians freeze and glare at a horn, so honking at them backfires (GAME_DESIGN 5). Riders ring back. */
  function onHorn(S, e) {
    var T = TLV.tune.peds;
    var cone = T.hornDeg * Math.PI / 180;
    var r2 = T.hornM * T.hornM;
    for (var i = 0; i < S.peds.length; i++) {
      var p = S.peds[i];
      if (!p.active || p.state === 'SCRIPT' || p.state === 'STUMBLE') continue;
      var dx = p.x - e.x;
      var dy = p.y - e.y;
      var d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      if (d2 > 1 && Math.abs(TLV.math.wrapPi(Math.atan2(dy, dx) - e.h)) > cone) continue;
      if (isRider(p)) {
        S.bus.emit('ped.bell', { pedId: p.id });
        continue;
      }
      if (p._p.freezeT <= 0) S.bus.emit('bubble', { who: 'ped', id: p.id, text: '!?', ttl: T.bubbleS });
      p._p.freezeT = T.hornFreezeS;
    }
  }

  /**
   * Adds a person to a lane's obstacle list for the next rebuild. One person reports once on a lane.
   * @param {object} S Sim state.
   * @param {number} slot Person slot, or the foot slot.
   * @param {number} lane Lane.
   * @param {number} s Metres along it.
   * @param {number} half Half length blocked.
   * @param {number} v Speed along the lane.
   * @param {number} zone Zone, or -1.
   * @param {boolean} dwell True if this counts toward the zone's dwell cap.
   */
  peds.addClaim = function (S, slot, lane, s, half, v, zone, dwell) {
    var sys = S.pedsys;
    var n = sys.claimN[slot];
    var base = slot * MAX_CLAIMS;
    for (var i = 0; i < n; i++) {
      if (sys.claimLane[base + i] === lane) return;
    }
    if (n >= MAX_CLAIMS) return;
    sys.claimLane[base + n] = lane;
    sys.claimS[base + n] = s;
    sys.claimHalf[base + n] = half;
    sys.claimV[base + n] = v;
    sys.claimZone[base + n] = zone;
    sys.claimDwell[base + n] = dwell ? 1 : 0;
    sys.claimN[slot] = n + 1;
  };

  /** Reports a body on the lanes it stands on, and on the lanes around a connector it stands on. */
  function claimBody(S, slot, x, y, r, vx, vy, dwell, always) {
    var W = S.world;
    var T = TLV.tune.peds;
    var sys = S.pedsys;
    var math = TLV.math;
    var pr = sys.pr;
    var reach = 3.4;
    var c = TLV.world.lanes.lanesNear(W, x, y, reach, sys.ints);
    var i;
    var onLane = false;
    for (i = 0; i < c; i++) {
      var lane = W.lanes[sys.ints[i]];
      math.polyProject(lane.px, lane.py, lane.cum, x, y, -1, pr);
      if (pr.d > lane.width / 2 + r + T.laneReachM) continue;
      onLane = true;
      var s = pr.s;
      math.polyAt(lane.px, lane.py, lane.cum, s, sys.pt2);
      peds.addClaim(S, slot, lane.id, s, r + T.laneHalfM, vx * Math.cos(sys.pt2.h) + vy * Math.sin(sys.pt2.h), TLV.peds.cross.zoneAt(lane, s, W), dwell);
    }
    if (!onLane || always) claimConnectors(S, slot, x, y, r, dwell);
  }

  /**
   * A person in a junction stands on connectors, which have no list of their own. They report on both lanes a connector joins, past
   * the end of one and before the start of the other, so a car's distance to them comes out right on either side. The junctions
   * to read are the ones at the near ends of the lanes around the person.
   */
  function claimConnectors(S, slot, x, y, r, dwell) {
    var W = S.world;
    var T = TLV.tune.peds;
    var sys = S.pedsys;
    var math = TLV.math;
    var pr = sys.pr;
    var c = TLV.world.lanes.lanesNear(W, x, y, T.connSearchM, sys.ints);
    var seen = sys.juncSeen;
    var nSeen = 0;
    for (var i = 0; i < c && nSeen < seen.length; i++) {
      var d = W.dirEdges[W.lanes[sys.ints[i]].dirEdge];
      for (var end = 0; end < 2 && nSeen < seen.length; end++) {
        var j = end === 0 ? d.from : d.to;
        var known = false;
        for (var q = 0; q < nSeen; q++) {
          if (seen[q] === j) known = true;
        }
        if (known) continue;
        seen[nSeen++] = j;
        var junc = W.juncs[j];
        if (math.dist(junc.x, junc.y, x, y) > T.connJuncM) continue;
        for (var k = 0; k < junc.conns.length; k++) {
          var conn = W.conns[junc.conns[k]];
          math.polyProject(conn.px, conn.py, conn.cum, x, y, -1, pr);
          if (pr.d > T.connReachM + r) continue;
          var half = r + T.laneHalfM;
          peds.addClaim(S, slot, conn.from, W.lanes[conn.from].len + pr.s, half, 0, -1, dwell);
          peds.addClaim(S, slot, conn.to, pr.s - conn.len, half, 0, -1, dwell);
        }
      }
    }
  }

  /**
   * Whether a person is out in the road. surface.at alone cannot say: a parking strip is ROAD to it, and a ribbon moved off a wall
   * stands on one (WP-WORLD D8, D9), so it would have cars braking for someone on the sidewalk, or waiting at the kerb.
   */
  function inRoad(S, p) {
    var P = p._p;
    // Someone a car is moving out of its way, or who is sitting where they fell, needs it to know, wherever they are.
    if (p.state === 'STUMBLE') return true;
    if (P.mode === 'ROW' || P.mode === 'LINK') return P.ox * P.ox + P.oy * P.oy > TLV.tune.peds.pushedM * TLV.tune.peds.pushedM;
    if (P.mode === 'PATH') return P.stage === 'ROAD';
    if (P.mode === 'FREE' && P.after === 'KERB') return false;
    return TLV.world.surface.at(S.world, p.x, p.y) === TLV.const.SURF.ROAD;
  }

  /** Rebuilds one person's claims. */
  function refreshClaims(S, p) {
    var P = p._p;
    var sys = S.pedsys;
    sys.claimN[p.slot] = 0;
    if (P.mode === 'ROW' || P.mode === 'LINK') {
      if (p.onRoad) claimBody(S, p.slot, p.x, p.y, p.r, P.vx, P.vy, false, false);
      return;
    }
    if (P.mode === 'PATH') {
      if (P.stage === 'ROAD') TLV.peds.cross.claimPath(S, p);
      return;
    }
    if (P.mode === 'LANE') {
      var at = TLV.world.lanes.pointAt(S.world, P.laneId, P.laneS, sys.pt2);
      var along = P.vx * Math.cos(at.h) + P.vy * Math.sin(at.h);
      var lane = S.world.lanes[P.laneId];
      peds.addClaim(S, p.slot, P.laneId, P.laneS, p.r + TLV.tune.peds.laneHalfM, along, lane ? TLV.peds.cross.zoneAt(lane, P.laneS, S.world) : -1, true);
    }
    if (p.onRoad) claimBody(S, p.slot, p.x, p.y, p.r, P.vx, P.vy, p.state !== 'SCRIPT', true);
  }

  /** Reports the on-foot player, who is a person to every car on the road. */
  function refreshFoot(S) {
    var sys = S.pedsys;
    var player = S.player;
    sys.claimN[sys.foot] = 0;
    if (!player || player.mode !== 'FOOT' || !player.foot) return;
    var f = player.foot;
    TLV.peds.walk.scanFoot(S, f.x, f.y);
    if (TLV.world.surface.at(S.world, f.x, f.y) === TLV.const.SURF.ROAD) claimBody(S, sys.foot, f.x, f.y, TLV.tune.peds.walkerR, 0, 0, false, true);
  }

  /** Lists every claim by lane, nearest the lane's start first, and updates zones. Run each tick, so a zone's clock is exact. */
  function rebuild(S, dt) {
    var sys = S.pedsys;
    var W = S.world;
    var T = TLV.tune.peds;
    var head = sys.head;
    var count = sys.zoneCount;
    var stamp = S.tick;
    var next = sys.heldNext;
    var nNext = 0;
    var nTouched = 0;
    var i;
    for (i = 0; i < sys.nUsed; i++) head[sys.used[i]] = -1;
    for (i = 0; i < sys.nTouched; i++) count[sys.touched[i]] = 0;
    sys.nUsed = 0;
    sys.nE = 0;
    for (var slot = 0; slot <= sys.foot; slot++) {
      var n = sys.claimN[slot];
      if (n === 0) continue;
      var base = slot * MAX_CLAIMS;
      for (var k = 0; k < n; k++) {
        var lane = sys.claimLane[base + k];
        var s = sys.claimS[base + k];
        var e = sys.nE++;
        sys.eS[e] = s;
        sys.eHalf[e] = sys.claimHalf[base + k];
        sys.eV[e] = sys.claimV[base + k];
        var at = head[lane];
        if (at < 0) sys.used[sys.nUsed++] = lane;
        if (at < 0 || sys.eS[at] >= s) {
          sys.eNext[e] = at;
          head[lane] = e;
        } else {
          while (sys.eNext[at] >= 0 && sys.eS[sys.eNext[at]] < s) at = sys.eNext[at];
          sys.eNext[e] = sys.eNext[at];
          sys.eNext[at] = e;
        }
        var z = sys.claimZone[base + k];
        if (z < 0) continue;
        if (count[z]++ === 0) sys.touched[nTouched++] = z;
        if (sys.claimDwell[base + k] && sys.zoneStamp[z] !== stamp) {
          sys.zoneStamp[z] = stamp;
          next[nNext++] = z;
        }
      }
    }
    sys.nTouched = nTouched;
    // A zone no longer held starts again from nothing. One still held runs its clock.
    var held = sys.held;
    for (i = 0; i < sys.nHeld; i++) {
      if (sys.zoneStamp[held[i]] !== stamp) sys.zoneT[held[i]] = 0;
    }
    for (i = 0; i < nNext; i++) {
      var zone = next[i];
      sys.zoneT[zone] += dt;
      if (sys.zoneT[zone] > sys.maxDwell) sys.maxDwell = sys.zoneT[zone];
      if (sys.zoneT[zone] >= T.dwellGateS) sys.xingHold[W.zones[zone].xing] = S.t + T.dwellHoldS;
    }
    sys.held = next;
    sys.heldNext = held;
    sys.nHeld = nNext;
  }

  /** What a body looks like doing what it is doing. */
  function setAnim(p) {
    var P = p._p;
    if (P.freezeT > 0) {
      p.anim = 'glare';
      return;
    }
    switch (p.state) {
      case 'STUMBLE':
        p.anim = p.stateT < TLV.tune.peds.stumbleFallS ? 'stumble' : (p.stateT < TLV.tune.peds.stumbleSitS ? 'sit' : 'idle');
        return;
      case 'FLEE':
        p.anim = isRider(p) ? 'ride' : 'run';
        return;
      default:
        break;
    }
    if (P.job === 'SAVE' && P.mode === 'STAND') {
      p.anim = 'glare';
      return;
    }
    if (P.writeT > 0) {
      p.anim = 'phone';
      return;
    }
    if (isRider(p)) {
      p.anim = 'ride';
      return;
    }
    if (p.kind === 'phone') {
      p.anim = 'phone';
      return;
    }
    p.anim = p.v > 0.1 ? 'walk' : 'idle';
  }

  /** One think standing still. Savers, inspectors and the stumbling all stand. */
  function stepStand(S, p, dt) {
    var P = p._p;
    var T = TLV.tune.peds;
    var walk = TLV.peds.walk;
    if (p.state === 'STUMBLE') {
      if (p.stateT < T.knockS) {
        var nx = p.x + P.kx * dt / T.knockS;
        var ny = p.y + P.ky * dt / T.knockS;
        var b = TLV.world.spatial.pointInBuilding(S.world, nx, ny);
        if (b >= 0) {
          P.kx = 0;
          P.ky = 0;
          walk.halt(p);
        } else {
          walk.aimAt(p, nx, ny, dt);
        }
        return;
      }
      walk.halt(p);
      if (p.stateT >= T.stumbleS) {
        peds.setState(p, 'WALK');
        P.speed = P.base;
        P.recycle = true;
        walk.toSidewalk(S, p);
      }
      return;
    }
    walk.halt(p);
    if (P.job === 'SAVE') {
      var occ = TLV.world.parking.state(S, P.spot);
      if (occ === TLV.const.OCC.VEHICLE || occ === TLV.const.OCC.PARKED) {
        P.job = 'AMBIENT';
        P.spot = -1;
        P.speed = P.base;
        walk.toSidewalk(S, p);
      }
      return;
    }
    if (P.writeT > 0) {
      P.writeT -= dt;
      if (P.writeT <= 0) {
        P.job = 'AMBIENT';
        P.speed = P.base;
        P.recycle = true;
        walk.toSidewalk(S, p);
      }
      return;
    }
    if (P.after === 'NONE' && !P.recycle && P.job === 'AMBIENT') walk.toSidewalk(S, p);
  }

  /** Ambient choices that come up while walking a row, once a second or so. */
  function rollAmbient(S, p, dt) {
    var P = p._p;
    var T = TLV.tune.peds;
    var rng = S.rng.ped;
    if (P.crossCool > 0) {
      P.crossCool -= dt;
      return false;
    }
    if (P.job !== 'AMBIENT' || isRider(p) || p.kind === 'trolley' || p.state !== 'WALK') return false;
    // The rate is per minute, and this runs on every think.
    if (rng.next() < T.jayPerMin * dt / 60 && TLV.peds.cross.tryJaywalk(S, p)) return true;
    return false;
  }

  /** Runs whichever controller holds this person. */
  function stepMode(S, p, dt) {
    var P = p._p;
    var walk = TLV.peds.walk;
    switch (P.mode) {
      case 'ROW':
        if (rollAmbient(S, p, dt)) {
          walk.stepFree(S, p, dt);
          return;
        }
        walk.stepRow(S, p, dt);
        return;
      case 'LINK':
      case 'FREE':
        walk.stepFree(S, p, dt);
        return;
      case 'PATH':
        TLV.peds.cross.stepPath(S, p, dt);
        return;
      case 'LANE':
        TLV.peds.riders.stepLane(S, p, dt);
        return;
      default:
        stepStand(S, p, dt);
    }
  }

  /** One think for one person. */
  function think(S, p, dt) {
    var P = p._p;
    var walk = TLV.peds.walk;
    p.stateT += dt;
    walk.scan(S, p);
    if (p.state === 'SCRIPT') {
      p.onRoad = TLV.world.surface.at(S.world, p.x, p.y) === TLV.const.SURF.ROAD;
      S.pedsys.claimN[p.slot] = 0;
      if (p.onRoad) claimBody(S, p.slot, p.x, p.y, p.r, 0, 0, false, true);
      return;
    }
    var rowS = P.s;
    var laneS = P.laneS;
    if (P.freezeT > 0) {
      P.freezeT -= dt;
      walk.halt(p);
    } else {
      stepMode(S, p, dt);
    }
    if (S.pedsys.nearN > 0 && walk.keepOff(S, p, dt)) {
      if (P.mode === 'ROW') P.s = rowS;
      else if (P.mode === 'LANE') P.laneS = laneS;
    }
    walk.capSpeed(S, p, dt);
    if (P.fleeT > 0) {
      P.fleeT -= dt;
      if (P.fleeT <= 0) endFlee(p);
    }
    if (isRider(p)) TLV.peds.riders.bell(S, p, dt);
    p.onRoad = inRoad(S, p);
    refreshClaims(S, p);
    setAnim(p);
  }

  /** Ends a flight: walkers walk on, and anyone on a road goes back to how they were crossing. */
  function endFlee(p) {
    var P = p._p;
    P.speed = P.base;
    if (p.state !== 'FLEE') return;
    if (P.mode === 'PATH' && P.stage === 'ROAD') {
      P.speed = TLV.tune.peds.crossLegal;
      peds.setState(p, P.roadState);
    } else {
      peds.setState(p, 'WALK');
    }
  }

  /**
   * Moves people, and updates the lane lists traffic reads. Row 7 of the tick.
   * @param {object} S Sim state.
   * @param {number} dt Seconds.
   */
  peds.update = function (S, dt) {
    var sys = S.pedsys;
    if (!sys || !S.world) return;
    var list = S.peds;
    var bucket = S.tick % 3;
    var maxTurn = 8 * dt;
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (!p.active) continue;
      if (p.state !== 'SCRIPT') {
        var P = p._p;
        p.x += P.vx * dt;
        p.y += P.vy * dt;
        var d = TLV.math.wrapPi(P.hT - p.h);
        p.h = TLV.math.wrapPi(p.h + (d > maxTurn ? maxTurn : (d < -maxTurn ? -maxTurn : d)));
      }
      if (i % 3 === bucket) think(S, p, dt * 3);
    }
    if (bucket === 0) refreshFoot(S);
    rebuild(S, dt);
  };

  /** Picks an ambient kind by weight. */
  function pickKind(S) {
    var mix = TLV.tune.peds.mix;
    var total = 0;
    var i;
    for (i = 0; i < mix.length; i++) total += mix[i][1];
    var u = S.rng.ped.next() * total;
    for (i = 0; i < mix.length; i++) {
      u -= mix[i][1];
      if (u < 0) return mix[i][0];
    }
    return mix[0][0];
  }

  /** Sets what a kind's walking pace and radius are. */
  function fitKind(S, p) {
    var T = TLV.tune.peds;
    var rng = S.rng.ped;
    var P = p._p;
    switch (p.kind) {
      case 'scooter':
        P.base = rng.range(T.scooterMin, T.scooterMax);
        p.r = T.riderR;
        break;
      case 'delivery':
        P.base = rng.range(T.deliveryMin, T.deliveryMax);
        p.r = T.riderR;
        break;
      case 'phone':
        P.base = rng.range(T.walkMin, T.walkMax) * T.phoneScale;
        break;
      case 'trolley':
        P.base = rng.range(T.walkMin, T.walkMax) * T.trolleyScale;
        break;
      case 'inspector':
        P.base = T.inspector;
        break;
      default:
        P.base = rng.range(T.walkMin, T.walkMax);
    }
    P.speed = P.base;
  }

  /** Spreads a person across the width of a ribbon. */
  function fitLateral(S, p, width) {
    var T = TLV.tune.peds;
    var room = Math.max(0, Math.min(T.latMax, width / 2 - p.r - 0.1));
    p._p.lat = S.rng.ped.range(-room, room);
  }

  /** Puts a person on a row, at rest. */
  function setOnRow(S, p, sw, s, dir) {
    var W = S.world;
    var P = p._p;
    var row = W.sidewalks[sw];
    var at = S.pedsys.pt;
    P.sw = sw;
    P.s = TLV.math.clamp(s, 0, row.len);
    P.dir = dir;
    P.mode = 'ROW';
    fitLateral(S, p, row.width);
    TLV.math.polyAt(row.px, row.py, row.cum, P.s, at);
    p.x = at.x - Math.sin(at.h) * P.lat;
    p.y = at.y + Math.cos(at.h) * P.lat;
    p.h = dir > 0 ? at.h : TLV.math.wrapPi(at.h + Math.PI);
    P.hT = p.h;
  }

  /** @returns {object} The farthest person it is fair to lose: unseen first, staged people and attackers last. */
  function evictee(S) {
    var fx = S.player.fx;
    var fy = S.player.fy;
    var best = null;
    var bestScore = -1;
    for (var i = 0; i < S.peds.length; i++) {
      var p = S.peds[i];
      if (!p.active || p.kind === 'attacker') continue;
      var d = TLV.math.dist(p.x, p.y, fx, fy);
      var score = d + (TLV.peds.walk.seen(S, p.x, p.y) ? 0 : 1e4) + (p._p.job === 'AMBIENT' ? 1e5 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = p;
      }
    }
    return best;
  }

  /**
   * Spawns a person (ARCHITECTURE 12.6). A DROPPED passenger keeps their pose beside the car, and walks to the sidewalk found for them.
   * @param {object} S Sim state.
   * @param {object} spec { kind, x, y, h?, state?, variant?, swId?, swS?, clear? }. With clear, a place a body stands on refuses them. It
   * is read where they land, because all but a DROPPED or SCRIPT person go to the nearest row, which can be metres from x, y.
   * @returns {?object} Pedestrian, or null when the pool is full or the place not clear, except an attacker, who evicts someone and is
   * never refused.
   */
  peds.spawn = function (S, spec) {
    var sys = S.pedsys;
    if (!sys || !spec) return null;
    var W = S.world;
    var kind = spec.kind || 'walker';
    var p = TLV.peds.pool.alloc(S);
    if (!p) {
      if (kind !== 'attacker') return null;
      var out = evictee(S);
      if (!out) return null;
      peds.despawn(S, out);
      p = TLV.peds.pool.alloc(S);
    }
    var P = p._p;
    p.kind = kind;
    p.variant = spec.variant !== undefined ? spec.variant : S.rng.ped.int(16);
    fitKind(S, p);
    var state = spec.state || 'WALK';
    var x = Number.isFinite(spec.x) ? spec.x : S.player.fx;
    var y = Number.isFinite(spec.y) ? spec.y : S.player.fy;
    var h = Number.isFinite(spec.h) ? spec.h : 0;
    p.x = x;
    p.y = y;
    p.h = h;
    P.hT = h;
    if (state === 'SCRIPT') {
      p.state = 'SCRIPT';
      p.hasKnife = false;
      P.mode = 'STAND';
    } else if (W && spec.swId >= 0 && W.sidewalks[spec.swId]) {
      setOnRow(S, p, spec.swId, spec.swS || 0, S.rng.ped.bool(0.5) ? 1 : -1);
    } else if (W) {
      var near = TLV.world.sidewalks.nearest(W, x, y, sys.swOut);
      if (state === 'DROPPED') {
        p.state = 'DROPPED';
        P.speed = TLV.tune.peds.approach;
        TLV.peds.cross.startDropped(S, p);
      } else if (near) {
        setOnRow(S, p, near.sw, near.s, S.rng.ped.bool(0.5) ? 1 : -1);
      } else {
        P.mode = 'STAND';
        P.recycle = true;
      }
    }
    if (spec.clear && peds._bodyAt(S, p.x, p.y)) {
      TLV.peds.pool.release(S, p);
      return null;
    }
    p.px = p.x;
    p.py = p.y;
    p.ph = p.h;
    if (W) p.onRoad = inRoad(S, p);
    S.bus.emit('ped.spawn', { pedId: p.id, kind: p.kind });
    return p;
  };

  /**
   * Removes a person.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   */
  peds.despawn = function (S, p) {
    if (!p || !p.active) return;
    var sys = S.pedsys;
    sys.claimN[p.slot] = 0;
    var id = p.id;
    TLV.peds.pool.release(S, p);
    S.bus.emit('ped.despawn', { pedId: id });
  };

  /**
   * Finds a person by ID.
   * @param {object} S Sim state.
   * @param {number} id Pedestrian ID.
   * @returns {?object} Pedestrian.
   */
  peds.byId = function (S, id) {
    for (var i = 0; i < S.peds.length; i++) {
      if (S.peds[i].active && S.peds[i].id === id) return S.peds[i];
    }
    return null;
  };

  /**
   * Finds people near a point.
   * @param {object} S Sim state.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} r Radius.
   * @param {object[]} out Filled with pedestrians.
   * @returns {number} How many.
   */
  peds.pedsNear = function (S, x, y, r, out) {
    var n = 0;
    var r2 = r * r;
    for (var i = 0; i < S.peds.length; i++) {
      var p = S.peds[i];
      if (!p.active) continue;
      var dx = p.x - x;
      var dy = p.y - y;
      if (dx * dx + dy * dy <= r2) out[n++] = p;
    }
    return n;
  };

  /**
   * Lists the people on a lane, nearest its start first. Crossing occupants report on every lane they have yet to clear, at the zone.
   * A person on a connector reports past the end of the lane feeding it (s above lane.len), and before the start of the lane it
   * joins (s below 0), so a car's distance to them comes out right from either side. This includes the on-foot player.
   * @param {object} S Sim state.
   * @param {number} laneId Lane, or -1.
   * @param {object[]} out Caller-owned {s, halfLen, v}. Missing entries are added.
   * @returns {number} How many.
   */
  peds.obstaclesOnLane = function (S, laneId, out) {
    var sys = S.pedsys;
    if (!sys || !(laneId >= 0) || laneId >= sys.head.length) return 0;
    var e = sys.head[laneId];
    var n = 0;
    while (e >= 0) {
      var o = out[n];
      if (!o) {
        o = { s: 0, halfLen: 0, v: 0 };
        out[n] = o;
      }
      o.s = sys.eS[e];
      o.halfLen = sys.eHalf[e];
      o.v = sys.eV[e];
      n++;
      e = sys.eNext[e];
    }
    return n;
  };

  /**
   * Whether anyone is on a zone, or has left the kerb for it and not yet cleared its lane.
   * @param {object} S Sim state.
   * @param {number} zoneId Zone, or -1.
   * @returns {boolean}
   */
  peds.zoneOccupied = function (S, zoneId) {
    var sys = S.pedsys;
    return !!sys && zoneId >= 0 && sys.zoneCount[zoneId] > 0;
  };

  /**
   * A person is hit: they are knocked aside a little, sit, stand, shake their head, and leave. Non-graphic, 4 s (GAME_DESIGN 10). Aside,
   * on the side of the car's line they were on: a knock along the impulse puts them straight back in front of the bumper.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {number} ix Impulse x, along the car's motion.
   * @param {number} iy Impulse y.
   * @param {number} speed Impact speed, m/s.
   */
  peds.onHit = function (S, p, ix, iy, speed) {
    if (!p || !p.active || p.state === 'SCRIPT' || p.state === 'STUMBLE') return;
    var T = TLV.tune.peds;
    var P = p._p;
    var d = Math.sqrt(ix * ix + iy * iy);
    var knock = Math.min(T.knockM, Math.max(0, speed || 0) * 0.15);
    var car = S.vehicles[0];
    var side = d > 0 && (p.x - car.x) * -iy + (p.y - car.y) * ix < 0 ? -1 : 1;
    p.intent = false;
    P.mode = 'STAND';
    P.stage = 'NONE';
    P.path = null;
    P.aim = null;
    P.hold = false;
    P.job = 'AMBIENT';
    P.spot = -1;
    P.writeT = 0;
    P.freezeT = 0;
    P.fleeT = 0;
    P.kx = d > 0 ? -iy / d * knock * side : 0;
    P.ky = d > 0 ? ix / d * knock * side : 0;
    TLV.peds.walk.halt(p);
    peds.setState(p, 'STUMBLE');
    setAnim(p);
  };

  /**
   * A person is brushed in passing by the player on foot: they stop a moment and glare. It costs nobody anything.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   */
  peds.onBrush = function (S, p) {
    if (!p || !p.active || p.state === 'SCRIPT' || p.state === 'STUMBLE') return;
    var P = p._p;
    if (P.freezeT <= 0) S.bus.emit('bubble', { who: 'ped', id: p.id, text: '!', ttl: TLV.tune.peds.bubbleS });
    P.freezeT = Math.max(P.freezeT, TLV.tune.peds.brushS);
  };

  /**
   * People near a crash hurry away for 3 s (GAME_DESIGN 10).
   * @param {object} S Sim state.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} r Radius.
   */
  peds.scare = function (S, x, y, r) {
    var T = TLV.tune.peds;
    var r2 = r * r;
    for (var i = 0; i < S.peds.length; i++) {
      var p = S.peds[i];
      if (!p.active || p.state === 'SCRIPT' || p.state === 'STUMBLE') continue;
      var P = p._p;
      if (P.job === 'SAVE' || P.job === 'INSPECT' || P.hold) continue;
      var dx = p.x - x;
      var dy = p.y - y;
      if (dx * dx + dy * dy > r2) continue;
      if (P.mode === 'PATH' && P.stage !== 'ROAD' && !P.median) TLV.peds.cross.abandon(S, p);
      if (P.mode === 'ROW') {
        var at = TLV.world.sidewalks.pointAt(S.world, P.sw, P.s, S.pedsys.pt);
        P.dir = Math.cos(at.h) * dx + Math.sin(at.h) * dy >= 0 ? 1 : -1;
      }
      if (!isRider(p)) P.speed = T.flee;
      peds.setState(p, 'FLEE');
      P.fleeT = T.fleeS;
    }
  };

  /**
   * Carries out a command (ARCHITECTURE 13.2).
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {object} cmd Command.
   * @returns {boolean} False when the person cannot comply.
   */
  peds.command = function (S, p, cmd) {
    if (!p || !p.active || !cmd || p.state === 'SCRIPT' || p.state === 'STUMBLE') return false;
    var P = p._p;
    var T = TLV.tune.peds;
    var math = TLV.math;
    switch (cmd.type) {
      case 'ZEBRA_STEP':
      case 'SLOW_CROSS':
      case 'RED_CROSS':
      case 'JAYWALK':
        return TLV.peds.cross.command(S, p, cmd);
      case 'SCOOTER_SALMON':
        return TLV.peds.riders.salmon(S, p, cmd);
      case 'DELIVERY_POP':
        return TLV.peds.riders.pop(S, p, cmd);
      case 'ROAD_STROLL':
        return TLV.peds.riders.stroll(S, p, cmd);
      case 'SAVE_BAY': {
        var spot = TLV.world.parking.spot(S.world, cmd.spotId);
        if (!spot) return false;
        var occ = TLV.world.parking.state(S, cmd.spotId);
        if (occ !== TLV.const.OCC.FREE) return false;
        if (math.dist(p.x, p.y, spot.x, spot.y) > T.commandReachM) return false;
        p.kind = 'saver';
        p.intent = false;
        P.stage = 'NONE';
        P.job = 'SAVE';
        P.spot = cmd.spotId;
        P.speed = T.approach;
        P.recycle = false;
        peds.setState(p, 'WALK');
        TLV.peds.walk.goTo(p, spot.x, spot.y, 'BAY');
        return true;
      }
      case 'INSPECT':
        if (!Number.isFinite(cmd.x) || !Number.isFinite(cmd.y)) return false;
        p.kind = 'inspector';
        p.intent = false;
        P.stage = 'NONE';
        P.job = 'INSPECT';
        P.speed = T.inspector;
        P.recycle = false;
        peds.setState(p, 'WALK');
        TLV.peds.walk.goTo(p, cmd.x, cmd.y, 'WRITE');
        return true;
      case 'CANCEL':
        p.intent = false;
        P.spot = -1;
        P.writeT = 0;
        if (P.mode === 'PATH') {
          TLV.peds.cross.cancel(S, p);
        } else {
          P.job = 'AMBIENT';
          P.aim = null;
          P.hold = false;
          P.speed = P.base;
          peds.setState(p, 'WALK');
          TLV.peds.walk.toSidewalk(S, p);
        }
        return true;
      default:
        return false;
    }
  };

  /** @returns {boolean} True when a vehicle's body is at a place: a row can run round the corner of a junction, under a car turning there. */
  peds._bodyAt = function (S, x, y) {
    var T = TLV.tune.peds;
    var near = [];
    var n = TLV.peds.walk.vehicles(S, x, y, T.scanWalkM, near);
    for (var i = 0; i < n; i++) {
      if (TLV.peds.walk.bodyDist(near[i], x, y) < T.spawnClearM) return true;
    }
    return false;
  };

  /** Adds one ambient person at a place. */
  function addAmbient(S, place) {
    if (peds._bodyAt(S, place.x, place.y)) return;
    var p = peds.spawn(S, { kind: pickKind(S), x: place.x, y: place.y, swId: place.sw, swS: place.s });
    if (!p) return;
    p._p.crossCool = S.rng.ped.range(0, TLV.tune.peds.crossCoolS);
    peds.maybeStroll(S, p);
  }

  /**
   * On a living street, a service road or a one-lane one-way street, 2% of walkers take to the road edge (GAME_DESIGN 10).
   * @param {object} S Sim state.
   * @param {object} p Pedestrian on a row.
   * @returns {boolean} True when they have.
   */
  peds.maybeStroll = function (S, p) {
    var P = p._p;
    if (P.job !== 'AMBIENT' || p.state !== 'WALK' || (p.kind !== 'walker' && p.kind !== 'phone')) return false;
    var e = S.world.edges[S.world.sidewalks[P.sw].edge];
    var small = e.cls === TLV.const.ROAD.RESIDENTIAL && e.lanesF + e.lanesB === 1;
    if (e.cls < TLV.const.ROAD.LIVING && !small) return false;
    return S.rng.ped.bool(TLV.tune.peds.strollP) && TLV.peds.cross.tryStroll(S, p);
  };

  /** @returns {boolean} True for someone only here to fill the street. */
  function isAmbient(p) {
    return p._p.job === 'AMBIENT' && p.kind !== 'attacker' && p.state !== 'SCRIPT' && p.state !== 'STUMBLE';
  }

  /** Counts the crowd by ring, and sends home whoever is too far away or has finished. */
  function census(S) {
    var sys = S.pedsys;
    var T = TLV.tune.peds;
    var fx = S.player.fx;
    var fy = S.player.fy;
    var inBubble = 0;
    var inOuter = 0;
    var ambient = 0;
    var far2 = T.despawnM * T.despawnM;
    var bub2 = T.bubbleM * T.bubbleM;
    var road2 = T.roadKeepM * T.roadKeepM;
    for (var i = 0; i < S.peds.length; i++) {
      var p = S.peds[i];
      if (!p.active) continue;
      var dx = p.x - fx;
      var dy = p.y - fy;
      var d2 = dx * dx + dy * dy;
      if (isAmbient(p)) {
        // Someone left out on a road this far off is where traffic may spawn a car.
        var stranded = p.onRoad && d2 > road2;
        if (d2 > far2 || ((p._p.recycle || stranded) && !TLV.peds.walk.seen(S, p.x, p.y))) {
          peds.despawn(S, p);
          continue;
        }
        ambient++;
      }
      if (d2 <= bub2) inBubble++;
      else inOuter++;
    }
    sys.inBubble = inBubble;
    sys.inOuter = inOuter;
    sys.ambient = ambient;
  }

  /** Too many in the disc, as can happen driving into a crowd: the farthest go, in view or not. At 110 m a person is a few pixels. */
  function trim(S) {
    var sys = S.pedsys;
    var T = TLV.tune.peds;
    var fx = S.player.fx;
    var fy = S.player.fy;
    var bub2 = T.bubbleM * T.bubbleM;
    while (sys.inBubble > T.bubbleTrim) {
      var worst = null;
      var worstD = -1;
      for (var i = 0; i < S.peds.length; i++) {
        var p = S.peds[i];
        if (!p.active || !isAmbient(p)) continue;
        var dx = p.x - fx;
        var dy = p.y - fy;
        var d2 = dx * dx + dy * dy;
        if (d2 <= bub2 && d2 > worstD) {
          worst = p;
          worstD = d2;
        }
      }
      if (!worst) return;
      peds.despawn(S, worst);
      sys.inBubble--;
      sys.ambient--;
    }
  }

  /** @returns {boolean} True when somewhere in view but far off was found for someone new. Only once the disc is running short. */
  function fallback(S, place) {
    var T = TLV.tune.peds;
    if (S.pedsys.inBubble > T.bubbleLow) return false;
    for (var i = 0; i < T.spawnFarTries; i++) {
      if (TLV.peds.walk.findPlace(S, T.spawnFarM, T.bubbleM - 2, false, place)) return true;
    }
    return false;
  }

  /** The disc is short with every slot taken: someone out past it goes, the farthest first. */
  function makeRoom(S) {
    var sys = S.pedsys;
    var T = TLV.tune.peds;
    var fx = S.player.fx;
    var fy = S.player.fy;
    var bub2 = T.bubbleM * T.bubbleM;
    var worst = null;
    var worstD = bub2;
    for (var i = 0; i < S.peds.length; i++) {
      var p = S.peds[i];
      if (!p.active || !isAmbient(p)) continue;
      var dx = p.x - fx;
      var dy = p.y - fy;
      var d2 = dx * dx + dy * dy;
      if (d2 > worstD) {
        worst = p;
        worstD = d2;
      }
    }
    if (!worst) return false;
    peds.despawn(S, worst);
    sys.inOuter--;
    sys.ambient--;
    return true;
  }

  /**
   * Keeps the crowd around the player. Row 16 of the tick. Runs every 15 ticks in its own bucket. After a start or a teleport it
   * fills the bubble at once, because a street must not fill up in front of the player.
   * @param {object} S Sim state.
   * @param {number} dt Seconds.
   */
  peds.maintain = function (S, dt) {
    var sys = S.pedsys;
    if (!sys || !S.world || !S.world.sidewalks.length || !S.player) return;
    var T = TLV.tune.peds;
    if (!sys.warmed) warm(S);
    if (sys.filled && S.tick % T.maintainTicks !== T.maintainPhase) return;
    var walk = TLV.peds.walk;
    var math = TLV.math;
    var fx = S.player.fx;
    var fy = S.player.fy;
    var jump = !sys.filled || math.dist(fx, fy, sys.lastFx, sys.lastFy) > T.jumpM;
    sys.lastFx = fx;
    sys.lastFy = fy;
    sys.filled = true;
    census(S);
    var place = sys.place;
    if (jump) {
      var triesIn = (T.bubbleAim - sys.inBubble) * 3;
      for (var i = 0; i < triesIn && sys.inBubble < T.bubbleAim && sys.ambient < T.ambientCap; i++) {
        if (!walk.findPlace(S, T.fillMinM, T.bubbleM - 2, false, place)) continue;
        addAmbient(S, place);
        sys.inBubble++;
        sys.ambient++;
      }
      var triesOut = (T.outerAim - sys.inOuter) * 3;
      for (var k = 0; k < triesOut && sys.inOuter < T.outerAim && sys.ambient < T.ambientCap; k++) {
        if (!walk.findPlace(S, T.bubbleM, T.spawnOuterM, false, place)) continue;
        addAmbient(S, place);
        sys.inOuter++;
        sys.ambient++;
      }
      return;
    }
    trim(S);
    // A clump of people can leave the disc in a second on a street with few sidewalks, so a short disc fills twice as fast.
    var calls = sys.inBubble <= T.bubbleLow ? T.spawnPerCall * 2 : T.spawnPerCall;
    for (var n = 0; n < calls; n++) {
      if (sys.inBubble < T.bubbleAim) {
        if (sys.ambient >= T.ambientCap && !makeRoom(S)) break;
        // Running short on a thin street with nowhere hidden: far enough off, someone new is a few pixels.
        if (!walk.findPlace(S, T.spawnMinM, T.bubbleM - 2, true, place) && !fallback(S, place)) break;
        addAmbient(S, place);
        sys.inBubble++;
      } else if (sys.inOuter < T.outerAim && sys.ambient < T.ambientCap) {
        if (!walk.findPlace(S, T.spawnOuterM - 30, T.spawnOuterM, true, place)) break;
        addAmbient(S, place);
        sys.inOuter++;
      } else {
        break;
      }
      sys.ambient++;
    }
  };

  /**
   * Registers invariants and debug hooks.
   */
  peds.register = function () {
    // Soak gate "People": AI-person contacts = 0. Counted at 20 Hz per person, which a 1 Hz check would miss.
    TLV.invariants.register('peds.contacts', function (S) {
      var sys = S.pedsys;
      if (!sys || sys.contacts === sys.reported) return null;
      var text = (sys.contacts - sys.reported) + ' AI-person contacts, first ' + JSON.stringify(sys.lastContact);
      sys.reported = sys.contacts;
      return text;
    });
    TLV.invariants.register('peds.dwell', function (S) {
      var sys = S.pedsys;
      if (!sys || sys.maxDwell <= TLV.tune.peds.dwellMaxS) return null;
      var text = 'zone held ' + sys.maxDwell.toFixed(1) + ' s';
      sys.maxDwell = 0;
      return text;
    });
    TLV.invariants.register('peds.pool', function (S) {
      var sys = S.pedsys;
      if (!sys) return null;
      var active = 0;
      for (var i = 0; i < S.peds.length; i++) {
        if (S.peds[i].active) active++;
      }
      return active + sys.nFree === S.peds.length ? null : active + ' active and ' + sys.nFree + ' free of ' + S.peds.length;
    });
    TLV.debug.register('spawnPed', function (spec) {
      var S = TLV.debug.current();
      var p = S ? peds.spawn(S, spec) : null;
      return p ? p.id : null;
    });
    TLV.debug.register('commandPed', function (id, cmd) {
      var S = TLV.debug.current();
      return S ? peds.command(S, peds.byId(S, id), cmd) : false;
    });
  };
})(window.TLV);
