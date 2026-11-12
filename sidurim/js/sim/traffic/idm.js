// js/sim/traffic/idm.js — WP-TRAFFIC
// Car following. Everything a driver can run into becomes one kind of entry, (path, s, halfLen, v), in a list per lane and per
// connector, rebuilt each tick (ARCHITECTURE 12.5). A path is a lane id, or nL + connector id. Lists are linked through
// preallocated arrays, sorted by s, so a tick allocates nothing.
(function (TLV) {
  'use strict';

  var idm = TLV.ns('traffic.idm');

  /** Most entries in one tick: 200 cars, a tail or a second lane each, and the people on the road. */
  var ENTRIES = 1600;
  /** A car on the far side of the map from the player has no entry near it, so this only bounds the walk along a plan. */
  var PEOPLE = 256;
  var GRID_CELL = 8;
  var ROOM_NONE = -1;

  /**
   * Creates the lists and the broadphase.
   * @param {object} S Sim state.
   */
  idm.init = function (S) {
    var T = S.traffic;
    var W = S.world;
    var nL = W ? W.lanes.length : 0;
    var nC = W ? W.conns.length : 0;
    T.nL = nL;
    T.nC = nC;
    T.head = new Int32Array(nL + nC);
    T.mark = new Int32Array(nL + nC);
    T.stamp = 1;
    T.en = 0;
    T.eS = new Float64Array(ENTRIES);
    T.eHalf = new Float32Array(ENTRIES);
    T.eV = new Float32Array(ENTRIES);
    T.eLat = new Float32Array(ENTRIES);
    T.eHW = new Float32Array(ENTRIES);
    T.eVeh = new Int32Array(ENTRIES);
    T.eNext = new Int32Array(ENTRIES);
    // Result of a leader search.
    T.rGap = Infinity;
    T.rV = 0;
    T.rSlot = -1;
    // People on lanes, refreshed at 10 Hz and added to the lists every tick.
    T.pedN = 0;
    T.pedLane = new Int32Array(PEOPLE);
    T.pedS = new Float64Array(PEOPLE);
    T.pedHalf = new Float32Array(PEOPLE);
    T.pedVel = new Float32Array(PEOPLE);
    T.pedSeen = new Int32Array(nL);
    T.pedStamp = 0;
    T.pedOut = [];
    T.pedNear = [];
    // Player.
    T.pHint = -1;
    T.pS = 0;
    T.pOn = false;
    T.at = { x: 0, y: 0, h: 0 };
    T.at2 = { x: 0, y: 0, h: 0 };
    T.pX = 0;
    T.pY = 0;
    T.pC = 1;
    T.pS1 = 0;
    T.pRx = 0;
    T.pRy = 0;
    T.proj = { s: 0, d: 0, side: 0 };
    T.gapBuf = { lead: ROOM_NONE, leadGap: 0, leadV: 0, foll: ROOM_NONE, follGap: 0, follV: 0 };
    // Broadphase (ARCHITECTURE 1.5).
    var b = W ? W.bounds : { minX: 0, minY: 0, maxX: 8, maxY: 8 };
    T.gMinX = b.minX;
    T.gMinY = b.minY;
    T.gNx = Math.ceil((b.maxX - b.minX) / GRID_CELL) + 1;
    T.gNy = Math.ceil((b.maxY - b.minY) / GRID_CELL) + 1;
    T.gHead = new Int32Array(T.gNx * T.gNy);
    T.gMark = new Int32Array(T.gNx * T.gNy);
    // Not 0, which every unused cell's mark reads: a query before the first rebuild finds nothing, as it should.
    T.gStamp = 1;
    T.gridDirty = false;
    T.gNext = new Int32Array(S.vehicles.length);
  };

  /** Adds an entry, keeping its list sorted by s. */
  function add(T, path, s, half, v, lat, hw, slot) {
    var k = T.en;
    if (k >= ENTRIES) return;
    T.en = k + 1;
    T.eS[k] = s;
    T.eHalf[k] = half;
    T.eV[k] = v;
    T.eLat[k] = lat;
    T.eHW[k] = hw;
    T.eVeh[k] = slot;
    if (T.mark[path] !== T.stamp) {
      T.mark[path] = T.stamp;
      T.head[path] = k;
      T.eNext[k] = -1;
      return;
    }
    var at = T.head[path];
    if (s < T.eS[at]) {
      T.eNext[k] = at;
      T.head[path] = k;
      return;
    }
    var next = T.eNext[at];
    while (next >= 0 && T.eS[next] <= s) {
      at = next;
      next = T.eNext[at];
    }
    T.eNext[k] = next;
    T.eNext[at] = k;
  }

  idm.add = add;

  /** Adds a car's tail to the paths it still trails over, so a car on one of them sees its rear. */
  function addTrail(T, veh, t) {
    var rear = veh.s - t.halfL;
    var at = veh.s;
    for (var b = 0; b < t.backN && rear < 0; b++) {
      var len = t.backLen[b];
      at += len;
      rear += len;
      add(T, t.back[b], at, t.halfL, veh.v, veh.lat, t.halfW, veh.slot);
    }
  }

  /** Adds the player on up to 3 lanes the car overlaps (ARCHITECTURE 12.5). */
  function addPlayer(S) {
    var T = S.traffic;
    var W = S.world;
    var veh = S.vehicles[0];
    T.pOn = false;
    var p = S.player;
    if (!veh || !veh.active || !p || p.mode === 'FOOT' || !W) return;
    var lane = W.lanes[veh.laneId];
    if (!lane) return;
    var math = TLV.math;
    math.polyProject(lane.px, lane.py, lane.cum, veh.x, veh.y, T.pHint, T.proj);
    var s = T.proj.s;
    T.pHint = s;
    T.pS = s;
    T.pOn = true;
    math.polyAt(lane.px, lane.py, lane.cum, s, T.at);
    var along = Math.cos(veh.h - T.at.h);
    var v = veh.v * along;
    var half = veh.length / 2;
    var hw = veh.width / 2;
    var lat = p.lat || 0;
    add(T, veh.laneId, s, half, v, lat, hw, 0);
    var edge = lane.width / 2;
    if (lat + hw > edge) {
      if (lane.left >= 0) add(T, lane.left, s, half, v, lat - lane.width, hw, 0);
      else if (lane.opposite >= 0) {
        var opp = W.lanes[lane.opposite];
        math.polyProject(opp.px, opp.py, opp.cum, veh.x, veh.y, -1, T.proj);
        add(T, lane.opposite, T.proj.s, half, -v, lane.width - lat, hw, 0);
      }
    }
    if (lat - hw < -edge && lane.right >= 0) add(T, lane.right, s, half, v, lat + lane.width, hw, 0);
  }

  /** Asks WP-PEDS for people on the lanes in use. Runs at 10 Hz. */
  function refreshPeople(S) {
    var T = S.traffic;
    T.pedN = 0;
    var peds = TLV.peds;
    if (!peds || !peds.obstaclesOnLane) return;
    T.pedStamp++;
    for (var i = 0; i < T.nAct; i++) {
      var veh = S.vehicles[T.act[i]];
      var t = veh._t;
      if (veh.mode === 'LANE') peopleOn(S, veh.laneId);
      if (t.pn > 0) peopleOn(S, S.world.conns[t.plan[0]].to);
    }
  }

  /** Copies the people on one lane, once per refresh. */
  function peopleOn(S, laneId) {
    var T = S.traffic;
    if (T.pedSeen[laneId] === T.pedStamp) return;
    T.pedSeen[laneId] = T.pedStamp;
    var out = T.pedOut;
    var count = TLV.peds.obstaclesOnLane(S, laneId, out);
    for (var k = 0; k < count && T.pedN < PEOPLE; k++) {
      var row = out[k];
      T.pedLane[T.pedN] = laneId;
      T.pedS[T.pedN] = row.s;
      T.pedHalf[T.pedN] = row.halfLen;
      T.pedVel[T.pedN] = row.v;
      T.pedN++;
    }
  }

  /**
   * Rebuilds every list from the poses at the start of the tick.
   * @param {object} S Sim state.
   */
  idm.rebuild = function (S) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    T.stamp++;
    T.en = 0;
    if (T.tk % Q.nearTicks === 0) refreshPeople(S);
    var list = S.vehicles;
    for (var i = 0; i < T.nAct; i++) {
      var veh = list[T.act[i]];
      var t = veh._t;
      var slot = veh.slot;
      if (veh.mode === 'LANE') {
        // A changing car counts as fully in both lanes from its first move to its last: that is what the double listing is for.
        var changing = t.lcTo >= 0;
        add(T, veh.laneId, veh.s, t.halfL, veh.v, changing ? 0 : veh.lat, t.halfW, slot);
        if (changing) {
          var fromFrame = veh.laneId === t.lcFrom;
          add(T, fromFrame ? t.lcTo : t.lcFrom, fromFrame ? veh.s + t.lcDs : veh.s - t.lcDs, t.halfL, veh.v, 0, t.halfW, slot);
        }
        if (t.oppLane >= 0) add(T, t.oppLane, t.oppS - (veh.s - t.oppRef), t.halfL, -veh.v, t.oppW - veh.lat, t.halfW, slot);
        addTrail(T, veh, t);
      } else if (veh.mode === 'CONN') {
        add(T, T.nL + veh.connId, veh.s, t.halfL, veh.v, veh.lat, t.halfW, slot);
        addTrail(T, veh, t);
      } else if (t.obLane >= 0) {
        add(T, t.obLane, t.obS, t.halfL, t.obV, t.obLat, t.halfW, slot);
      }
    }
    addPlayer(S);
    for (var p = 0; p < T.pedN; p++) add(T, T.pedLane[p], T.pedS[p], T.pedHalf[p], T.pedVel[p], 0, 0.5, -1);
  };

  /** Looks along one path for the first entry past fromS that blocks this car. @returns {boolean} True when one was found. */
  function scanPath(T, path, fromS, base, me, half, lat, hw) {
    if (T.mark[path] !== T.stamp) return false;
    var clear = TLV.tune.traffic.latClear;
    for (var e = T.head[path]; e >= 0; e = T.eNext[e]) {
      var s = T.eS[e];
      if (s <= fromS) continue;
      var slot = T.eVeh[e];
      if (slot === me) continue;
      var d = T.eLat[e] - lat;
      if (d < 0) d = -d;
      if (d >= T.eHW[e] + hw + clear) continue;
      var gap = base + s - T.eHalf[e] - half;
      // On a path its centre has not reached, someone waiting at a crossing can be behind a long nose already. A bus held for that has
      // its nose over their crossing, and they wait for it. The body scan still has anyone really in its way.
      if (slot === -1 && fromS === -Infinity && gap < -TLV.tune.traffic.pedBehindNose) continue;
      if (gap < T.rGap) {
        T.rGap = gap;
        T.rV = T.eV[e];
        T.rSlot = slot;
      }
      return true;
    }
    return false;
  }

  /**
   * Two connectors from one lane are in no conflict set, but they run together until they part (WP-WORLD report). So a car
   * on a sibling counts as a leader until its rear is past the point where the two clear.
   */
  function scanSiblings(S, conn, fromS, base, me, half) {
    var T = S.traffic;
    var conns = S.world.lanes[conn.from].conns;
    if (conns.length < 2) return;
    var clearAt = T.sibClear[conn.id];
    for (var i = 0; i < conns.length; i++) {
      var other = conns[i];
      if (other === conn.id) continue;
      var path = T.nL + other;
      if (T.mark[path] !== T.stamp) continue;
      for (var e = T.head[path]; e >= 0; e = T.eNext[e]) {
        var s = T.eS[e];
        if (s <= fromS || T.eVeh[e] === me) continue;
        var rear = s - T.eHalf[e];
        if (rear >= clearAt) continue;
        var gap = base + rear - half;
        if (gap < T.rGap) {
          T.rGap = gap;
          T.rV = T.eV[e];
          T.rSlot = T.eVeh[e];
        }
      }
    }
  }

  /** IDM with delta 4 (ARCHITECTURE 12.5). @returns {number} Acceleration, not yet clamped. */
  function accel(v, v0, gap, lv, s0, headway, a, b) {
    var r = v / (v0 > 0.1 ? v0 : 0.1);
    var r2 = r * r;
    var free = a * (1 - r2 * r2);
    if (free < -2 * b) free = -2 * b;
    if (gap === Infinity) return free;
    var star = s0 + Math.max(0, v * headway + v * (v - lv) / (2 * Math.sqrt(a * b)));
    var g = gap > 0.1 ? gap : 0.1;
    var q = star / g;
    return free - a * q * q;
  }

  idm.accel = accel;

  /** Effective headway, with what a tailgating car uses (GAME_DESIGN 9). */
  function headwayOf(veh, t) {
    if (veh.beh !== 'TAILGATE' && !(t.ovFast && veh.beh === 'OVERTAKE_OUT')) return t.T;
    var Q = TLV.tune.traffic;
    return veh.v * Q.tailT > Q.tailHeadM ? Q.tailHeadM / veh.v : Q.tailT;
  }

  /** A car pulling out to pass the player comes from his bumper, and does not drop back to a polite distance first. */
  function gapOf(veh, t) {
    return veh.beh === 'TAILGATE' || (t.ovFast && veh.beh === 'OVERTAKE_OUT') ? TLV.tune.traffic.tailS0 : t.s0;
  }

  /**
   * A tailgater watches its target, wherever the lists put it. The player can be between lanes, on a connector, or diving for a bay,
   * and a car a metre and a half behind him cannot lose him for that.
   */
  function bumper(S, veh, t) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var me = S.vehicles[t.target];
    var dx = me.x - veh.x;
    var dy = me.y - veh.y;
    var along = dx * t.cosH + dy * t.sinH;
    if (along <= 0 || along > Q.sensorM) return;
    var side = dy * t.cosH - dx * t.sinH;
    if (side < 0) side = -side;
    if (side > t.halfW + me.width / 2 + Q.tailSide) return;
    var gap = along - t.halfL - me.length / 2;
    if (gap >= T.rGap) return;
    T.rGap = gap;
    T.rV = me.vx * t.cosH + me.vy * t.sinH;
    T.rSlot = t.target;
    t.leadSame = true;
  }

  /**
   * Finds the car's leader along its path and its granted plan, into T.rGap, T.rV and T.rSlot, and works out the distance to
   * the first line it has no grant for. A car on a lane with a change under way looks along both lanes.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle in LANE or CONN.
   */
  idm.findLeader = function (S, veh) {
    var T = S.traffic;
    var W = S.world;
    var t = veh._t;
    var half = t.halfL;
    var hw = t.halfW;
    var me = veh.slot;
    var onLane = veh.mode === 'LANE';
    var i;
    var lane = onLane ? W.lanes[veh.laneId] : null;
    var conn = onLane ? null : W.conns[veh.connId];
    var d = (onLane ? lane.len : conn.len) - veh.s;

    var total = d;
    var last = onLane ? (t.lcTo >= 0 ? t.lcTo : veh.laneId) : conn.to;
    if (!onLane) total += W.lanes[conn.to].len;
    for (i = 0; i < t.pg; i++) {
      var g = W.conns[t.plan[i]];
      total += g.len + W.lanes[g.to].len;
      last = g.to;
    }
    t.lineD = total - (t.pg < t.pn ? T.setback[last] : 0);

    T.rGap = Infinity;
    T.rV = 0;
    T.rSlot = -1;
    var look = TLV.tune.traffic.lookBase + veh.v * veh.v / (2 * t.b) + veh.v * t.T;
    if (look > TLV.tune.traffic.lookMax) look = TLV.tune.traffic.lookMax;
    if (onLane) {
      scanPath(T, veh.laneId, veh.s, -veh.s, me, half, veh.lat, hw);
      if (t.lcTo >= 0) {
        var fromFrame = veh.laneId === t.lcFrom;
        var otherS = fromFrame ? veh.s + t.lcDs : veh.s - t.lcDs;
        scanPath(T, fromFrame ? t.lcTo : t.lcFrom, otherS, -otherS, me, half, fromFrame ? veh.lat - t.lcW : veh.lat + t.lcW, hw);
      }
    } else {
      scanPath(T, T.nL + veh.connId, veh.s, -veh.s, me, half, veh.lat, hw);
      scanSiblings(S, conn, veh.s, -veh.s, me, half);
    }
    t.leadSame = T.rSlot !== -1 || T.rGap !== Infinity;
    if (veh.beh === 'TAILGATE') bumper(S, veh, t);
    if (T.rGap === Infinity && !onLane && d < look) {
      scanPath(T, conn.to, -Infinity, d, me, half, 0, hw);
      d += W.lanes[conn.to].len;
    }
    for (i = 0; i < t.pg && T.rGap === Infinity && d < look; i++) {
      var c = W.conns[t.plan[i]];
      scanPath(T, T.nL + c.id, -Infinity, d, me, half, 0, hw);
      scanSiblings(S, c, -Infinity, d, me, half);
      if (T.rGap !== Infinity) break;
      d += c.len;
      scanPath(T, c.to, -Infinity, d, me, half, 0, hw);
      d += W.lanes[c.to].len;
    }
  };

  /** @returns {number} A driver's speed on a connector: fast through a bend, never over his speed on the lanes it joins. */
  function connLimit(W, conn, t) {
    var turn = conn.vmax * (t.vf > t.curve ? t.vf : t.curve);
    var a = W.lanes[conn.from].vmax;
    var b = W.lanes[conn.to].vmax;
    var road = (a < b ? a : b) * t.vf;
    return turn < road ? turn : road;
  }

  /** The tightest of a limit ahead on the plan, as a constant deceleration to reach it. */
  function limitAhead(S, veh, t, d0, a) {
    var W = S.world;
    var Q = TLV.tune.traffic;
    var v = veh.v;
    var reach = v * v / (2 * (t.ovFast ? Q.overBrake : Q.curveBrake)) + 8;
    var d = d0;
    for (var i = 0; i < t.pn && d < reach; i++) {
      var c = W.conns[t.plan[i]];
      var vc = connLimit(W, c, t);
      if (v > vc) {
        var need = (vc * vc - v * v) / (2 * (d > 2 ? d : 2));
        if (need < a) a = need;
      }
      d += c.len;
      var next = W.lanes[c.to];
      var vl = next.vmax * t.vf;
      if (v > vl) {
        var need2 = (vl * vl - v * v) / (2 * (d > 2 ? d : 2));
        if (need2 < a) a = need2;
      }
      d += next.len;
    }
    return a;
  }

  /** Desired speed toward a shared Aim, within [0, 1.3 * limit] (ARCHITECTURE 13.1). */
  function aimSpeed(S, veh, t, limit) {
    var aim = t.aim;
    var left = aim.tImpact - S.t;
    var far = TLV.math.dist(veh.x, veh.y, aim.x, aim.y);
    if (left <= 0.05) return limit * TLV.tune.traffic.aimOverspeed;
    var want = far / left;
    var top = limit * TLV.tune.traffic.aimOverspeed;
    return want > top ? top : want;
  }

  /**
   * Works out this tick's acceleration for a car on a path.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle in LANE or CONN.
   */
  idm.step = function (S, veh) {
    var T = S.traffic;
    var W = S.world;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var v = veh.v;
    var half = t.halfL;
    var onLane = veh.mode === 'LANE';
    idm.findLeader(S, veh);

    var limit;
    var left;
    if (onLane) {
      var lane = W.lanes[veh.laneId];
      limit = lane.vmax * t.vf;
      left = lane.len - veh.s;
    } else {
      var conn = W.conns[veh.connId];
      limit = connLimit(W, conn, t);
      left = conn.len - veh.s;
    }
    var v0 = limit;
    if (t.aim) v0 = aimSpeed(S, veh, t, limit);
    if (veh.beh === 'OVERTAKE_PASS') v0 = limit * Q.overSpeed;
    // A car passing the player has to go faster than he does, whatever the limit, or it sits beside him until the road runs out.
    var pull = t.a;
    var give = t.b;
    if (t.ovFast && (veh.beh === 'OVERTAKE_OUT' || veh.beh === 'OVERTAKE_PASS')) {
      var pass = S.vehicles[0].v + Q.overRel;
      var top = limit * Q.overPlayerMax;
      if (pass > top) pass = top;
      if (pass > v0) v0 = pass;
      if (Q.overA > pull) pull = Q.overA;
    }
    if (t.ovFast && veh.beh === 'CUT_IN') {
      var hook = S.vehicles[0].v + Q.overCutRel;
      if (hook < v) v0 = hook;
    }
    // A tailgater is pulled along by what it sits behind, not by the limit: a target at 10 m/s on a 30 road still has one on its bumper.
    // Through a junction the player can drop off its lists for a moment, so the target's own speed stands in.
    if (veh.beh === 'TAILGATE') {
      var tv = S.vehicles[t.target].v;
      if (tv < T.rV) tv = T.rV;
      if (tv + Q.tailPush > v0) v0 = tv + Q.tailPush;
      if (Q.tailA > pull) pull = Q.tailA;
      if (Q.tailB > give) give = Q.tailB;
    }
    if (t.capV < v0) v0 = t.capV;
    var maxA = pull * (t.hornBoostT > 0 ? Q.hornBoost : 1);
    var headway = headwayOf(veh, t);
    var s0 = gapOf(veh, t);

    var gap = T.rGap;
    var lv = T.rV;
    var a = accel(v, v0, gap, lv, s0, headway, pull, give);
    if (t.easeDown) {
      if (v <= v0) {
        t.easeDown = false;
      } else {
        var free = accel(v, v0, Infinity, 0, s0, headway, pull, t.b);
        if (free < -Q.overEase) a += -Q.overEase - free;
      }
    }
    if (T.rSlot > 0 && S.vehicles[T.rSlot].beh === 'NOSE_IN' && a < -Q.noseFollowBrake) a = -Q.noseFollowBrake;

    // The first line with no grant, or the end of the road. A line stands in as a stopped leader, s0 past where the nose stops.
    // It counts only from where the car would ask for a grant, or every car would brake for junctions it is about to be given,
    // and only as hard as stopping takes, because IDM alone overbrakes for a far standing obstacle.
    var lineGap = t.lineD - half - Q.stopPad;
    if (lineGap < TLV.traffic.gate.reach(v) + v * Q.lineMargin) {
      var at = accel(v, v0, lineGap + t.s0, 0, t.s0, t.T, pull, t.b);
      var need = v * v / (2 * (lineGap > 0.3 ? lineGap : 0.3)) * Q.lineBrakeShare;
      if (at < -need) at = -need;
      if (at < a) a = at;
    }
    if (t.stopS >= 0 && onLane) {
      var stop = accel(v, v0, t.stopS - veh.s + t.s0, 0, t.s0, t.T, pull, t.b);
      if (stop < a) a = stop;
    }
    if (t.zoneGap < Q.lookMax) {
      var zone = accel(v, v0, t.zoneGap + t.s0, 0, t.s0, t.T, pull, t.b);
      if (zone < a) a = zone;
    }
    // A tailgater reads its target every tick, and the sensor's gap is ten ticks old, which is half a metre at this distance.
    if (t.sensorGap < Q.sensorM && veh.beh !== 'TAILGATE') {
      var sense = accel(v, v0, t.sensorGap, t.sensorV, s0, headway, pull, give);
      if (sense < a) a = sense;
    }
    if (t.pedGap < Q.lookMax) {
      var person = accel(v, v0, t.pedGap, t.pedV, s0, headway, pull, t.b);
      if (person < a) a = person;
      // A person ahead overrides everything: stop in time, at the hard floor (ARCHITECTURE 12.5).
      var closing = v - t.pedV;
      if (closing > 0.1) {
        var limitT = Math.max(Q.pedTtcMin, v / Q.pedTtcDiv + Q.pedTtcAdd);
        if (t.pedGap / closing < limitT) a = -Q.hardBrake;
      }
    }
    if (v > 1) a = limitAhead(S, veh, t, left - half, a);
    if (t.soft && a > -Q.softBrake) a = -Q.softBrake;
    if (t.forceA === t.forceA && t.forceA < a) a = t.forceA;
    if (a > 0 && t.hornBoostT > 0) a *= Q.hornBoost;
    if (a > maxA) a = maxA;
    if (a < -Q.hardBrake) a = -Q.hardBrake;
    t.acc = a;
    t.lead = T.rSlot;
    t.leadGap = T.rGap;
    t.leadV = T.rV;
  };

  /** Largest separation of two boxes along their four axes: over 0 means apart by at least that. */
  function apart(ax, ay, ac, as, ahl, ahw, bx, by, bc, bs, bhl, bhw) {
    var dx = bx - ax;
    var dy = by - ay;
    var dot = ac * bc + as * bs;
    var cross = ac * bs - as * bc;
    if (dot < 0) dot = -dot;
    if (cross < 0) cross = -cross;
    var a1 = dx * ac + dy * as;
    if (a1 < 0) a1 = -a1;
    var a2 = dy * ac - dx * as;
    if (a2 < 0) a2 = -a2;
    var a3 = dx * bc + dy * bs;
    if (a3 < 0) a3 = -a3;
    var a4 = dy * bc - dx * bs;
    if (a4 < 0) a4 = -a4;
    var best = a1 - (ahl + bhl * dot + bhw * cross);
    var s = a2 - (ahw + bhl * cross + bhw * dot);
    if (s > best) best = s;
    s = a3 - (bhl + ahl * dot + ahw * cross);
    if (s > best) best = s;
    s = a4 - (bhw + ahl * cross + ahw * dot);
    if (s > best) best = s;
    return best;
  }

  idm.apart = apart;

  /**
   * Tests a whole new pose against the neighbours. A body within contactClear and closing is refused. Two bodies close to
   * parallel may pass down to contactMin, because two wide ones on narrow lanes close by millimetres on any bend.
   * @returns {boolean} True when the pose is refused.
   */
  function poseTouches(S, veh, nx, ny, nc, ns) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    var clear = Q.contactClear;
    var list = S.vehicles;
    for (var k = 0; k < t.nearN; k++) {
      var o = list[t.near[k]];
      if (!o.active || o.isPlayer) continue;
      var u = o._t;
      var after = apart(nx, ny, nc, ns, t.halfL, t.halfW, o.x, o.y, u.cosH, u.sinH, u.halfL, u.halfW);
      if (after >= clear) continue;
      var askew = nc * u.sinH - ns * u.cosH;
      if (askew < Q.contactParallel && askew > -Q.contactParallel && after >= Q.contactMin) continue;
      var before = apart(veh.x, veh.y, t.cosH, t.sinH, t.halfL, t.halfW, o.x, o.y, u.cosH, u.sinH, u.halfL, u.halfW);
      if (after < before) return true;
    }
    return false;
  }

  /** @returns {boolean} True when another AI body stands within reach of this car's centre plus a move of this size. */
  function bodyClose(S, veh, move) {
    var t = veh._t;
    var pad = TLV.tune.traffic.contactClear + move + 0.2;
    var list = S.vehicles;
    for (var k = 0; k < t.nearN; k++) {
      var o = list[t.near[k]];
      if (!o.active || o.isPlayer) continue;
      var ox = o.x - veh.x;
      var oy = o.y - veh.y;
      var r = t.diag + o._t.diag + pad;
      if (ox * ox + oy * oy <= r * r) return true;
    }
    return false;
  }

  /**
   * The contact net, for a pose script or a body sliding free.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   * @param {number} dx Move x.
   * @param {number} dy Move y.
   * @param {number} dh Turn.
   * @returns {boolean} True when the move is refused.
   */
  idm.wouldTouch = function (S, veh, dx, dy, dh) {
    var move = Math.abs(dx) + Math.abs(dy);
    if (!bodyClose(S, veh, move)) return false;
    var h = veh.h + dh;
    return poseTouches(S, veh, veh.x + dx, veh.y + dy, Math.cos(h), Math.sin(h));
  };

  /**
   * The contact net, under everything else: a move that would bring this car within clearance of another AI body does not
   * happen. It keeps the Overlap gate true on any geometry the lanes do not describe, such as a bus's long body swinging over a
   * bend. When a body is near it works out the true next pose along the path, through any lane end, so a refusal can never be
   * wrong by a bend. T.contacts counts every time it acted on a moving car.
   * @returns {boolean} True when the move is refused.
   */
  function pathTouches(S, veh, ds, dlat) {
    var T = S.traffic;
    if (!bodyClose(S, veh, Math.abs(ds) + Math.abs(dlat))) return false;
    // The pose tried has to be the pose it will take, to the millimetre: a long body's share moves as it drives.
    var t = veh._t;
    var share = t.share;
    truePose(S, veh, t, ds, ds, veh.lat + dlat);
    t.share = share;
    return poseTouches(S, veh, T.pX, T.pY, T.pC, T.pS1);
  }

  /** @returns {number} Metres from a point to a box, 0 inside. */
  function boxDist(x, y, c, s, hl, hw, px, py) {
    var dx = px - x;
    var dy = py - y;
    var a = dx * c + dy * s;
    var l = dy * c - dx * s;
    a = (a < 0 ? -a : a) - hl;
    l = (l < 0 ? -l : l) - hw;
    if (a < 0) a = 0;
    if (l < 0) l = 0;
    return Math.sqrt(a * a + l * l);
  }

  /**
   * A move is refused if it brings the body inside someone's radius, or nearer than it is. A body someone already stands in stays put
   * whichever way the move goes, until they are out: a person clearing a held zone walks through a stopped bus (peds.dwell), and it does
   * not pull away with her inside. Standing at the edge of the radius, as a waiting passenger does, stops nothing.
   * @returns {boolean} True when the move is refused.
   */
  function netTouches(veh, t, nx, ny, nc, ns, px, py, r) {
    var after = boxDist(nx, ny, nc, ns, t.halfL, t.halfW, px, py);
    if (after >= r) return false;
    var now = boxDist(veh.x, veh.y, t.cosH, t.sinH, t.halfL, t.halfW, px, py);
    return after < now || now < r - TLV.tune.traffic.personNetInside;
  }

  /**
   * The contact net for people, under everything else: AI cars never touch anyone (GAME_DESIGN 9). The 10 Hz scan brakes in time for all
   * but those who arrive from the side inside a car's stopping room, and those a car moves off beside. For those a move is refused,
   * however hard that stops the car.
   * @returns {boolean} True when the move is refused.
   */
  function personTouches(S, veh, ds, dlat) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var onFoot = S.player && S.player.mode === 'FOOT';
    if (t.netN === 0 && !onFoot) return false;
    var share = t.share;
    truePose(S, veh, t, ds, ds, veh.lat + dlat);
    t.share = share;
    var nx = T.pX;
    var ny = T.pY;
    var nc = T.pC;
    var ns = T.pS1;
    for (var k = 0; k < t.netN; k++) {
      var p = t.netP[k];
      if (p.active && netTouches(veh, t, nx, ny, nc, ns, p.x, p.y, (p.r || 0) + Q.personNetClear)) return true;
    }
    if (!onFoot) return false;
    var f = S.player.foot;
    return netTouches(veh, t, nx, ny, nc, ns, f.x, f.y, Q.personNetFootR + Q.personNetClear);
  }

  /**
   * Works out a car's pose for a path position. The front axle stays on the path, offset by lat, and the rear axle trails it at a
   * fixed wheelbase, so a long body cuts inside a turn as a real one does, and never swings its tail out across the next lane.
   * Heading is the line between the axles, so it has no reason to jump at a polyline vertex or a lane joint. A car's own centre
   * stays on its lane, because lanes can hug a wall on the inside of a bend. A long body rides part of the way to the line between
   * its axles, so it neither swings wide nor clips the corner. Results go to T.pX, T.pY, T.pC, T.pS1, T.pRx and T.pRy.
   */
  function axlePose(S, veh, t, ds, lat) {
    var T = S.traffic;
    var at = pathPoint(S, veh, ds + veh.wheelbase / 2, T.at2);
    var fx = at.x - Math.sin(at.h) * lat;
    var fy = at.y + Math.cos(at.h) * lat;
    var dx = fx - t.rearX;
    var dy = fy - t.rearY;
    var d = Math.sqrt(dx * dx + dy * dy);
    var ux = t.cosH;
    var uy = t.sinH;
    if (d > 1e-6) {
      ux = dx / d;
      uy = dy / d;
    }
    var wb = veh.wheelbase;
    T.pRx = fx - ux * wb;
    T.pRy = fy - uy * wb;
    T.pC = ux;
    T.pS1 = uy;
    var mx = fx - ux * wb / 2;
    var my = fy - uy * wb / 2;
    at = pathPoint(S, veh, ds, T.at2);
    var px = at.x - Math.sin(at.h) * lat;
    var py = at.y + Math.cos(at.h) * lat;
    T.pX = px + (mx - px) * t.share;
    T.pY = py + (my - py) * t.share;
  }

  /** Eases a long body's share toward what its road asks for, by the metre, so that a change of road never moves it in one tick. */
  function easeShare(S, veh, t, ds) {
    var Q = TLV.tune.traffic;
    if (veh.length <= Q.longBody) return;
    // Forced down a narrow lane, a long body keeps to its middle: such a lane can hug a wall.
    var want = veh.mode === 'LANE' && S.world.lanes[veh.laneId].width < Q.heavyLaneW ? 0 : Q.longChord;
    // The chord of a bend can cross the corner of a wall the lane goes round, so the body comes back to the lane before it gets there.
    if (want > 0) {
      var keep = t.share;
      t.share = want;
      axlePose(S, veh, t, ds + Q.longLook, veh.lat);
      t.share = keep;
      if (TLV.world.spatial.pointInBuilding(S.world, S.traffic.pX, S.traffic.pY) >= 0) want = 0;
    }
    var most = Q.longEase * (ds < 0 ? -ds : ds);
    var d = want - t.share;
    t.share += d > most ? most : (d < -most ? -most : d);
  }

  /**
   * The pose a car really takes at a path position. easeShare's look reads one point ahead, on a chord the rear axle has not got to,
   * so it cannot promise where the body ends up, and a lane can run a hand's width from a wall. The last word is the pose itself: a
   * centre that would stand in a footprint comes back toward the lane, which never does (ARCHITECTURE 17.3), and only as far as that
   * takes. The share it ends on stays in t.share, so the body leaves the wall as gently as it rides anywhere.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle in LANE or CONN.
   * @param {object} t Its traffic state.
   * @param {number} ds Metres driven, for the share.
   * @param {number} at Metres ahead of its centre, for the pose.
   * @param {number} lat Offset from the path.
   */
  function truePose(S, veh, t, ds, at, lat) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var spatial = TLV.world.spatial;
    easeShare(S, veh, t, ds);
    axlePose(S, veh, t, at, lat);
    while (t.share > 0 && spatial.pointInBuilding(S.world, T.pX, T.pY) >= 0) {
      t.share = t.share > Q.longWallStep ? t.share - Q.longWallStep : 0;
      axlePose(S, veh, t, at, lat);
    }
  }

  /**
   * Sets a car's pose after a move.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle in LANE or CONN.
   * @param {number} ds Metres moved this tick.
   * @param {number} dt Tick, seconds.
   */
  idm.pose = function (S, veh, ds, dt) {
    var T = S.traffic;
    var t = veh._t;
    truePose(S, veh, t, ds, 0, veh.lat);
    veh.x = T.pX;
    veh.y = T.pY;
    t.rearX = T.pRx;
    t.rearY = T.pRy;
    t.cosH = T.pC;
    t.sinH = T.pS1;
    var h = Math.atan2(T.pS1, T.pC);
    var dh = TLV.math.wrapPi(h - veh.h);
    veh.h = h;
    veh.yawRate = dh / dt;
    veh.steer = ds > 1e-3 ? Math.atan(veh.wheelbase * dh / ds) : veh.steer * 0.9;
    veh.vx = veh.v * t.cosH;
    veh.vy = veh.v * t.sinH;
  };

  /**
   * Puts a car's rear axle behind it along its heading, for any place a car appears on a path without driving there.
   * @param {object} veh Vehicle.
   */
  idm.placeAxles = function (veh) {
    var t = veh._t;
    t.cosH = Math.cos(veh.h);
    t.sinH = Math.sin(veh.h);
    t.rearX = veh.x - t.cosH * veh.wheelbase / 2;
    t.rearY = veh.y - t.sinH * veh.wheelbase / 2;
  };

  /** Zeroes the motion a parked pose would otherwise have left behind. */
  function stand(veh) {
    veh.yawRate = 0;
    veh.vx = 0;
    veh.vy = 0;
  }

  /**
   * Moves a car on a path by this tick's acceleration.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle in LANE or CONN.
   * @param {number} dt Tick, seconds.
   */
  idm.move = function (S, veh, dt) {
    var T = S.traffic;
    var t = veh._t;
    var v = veh.v;
    if (t.reverse > 0) {
      // Backing up holds its own speed and never turns into a forward roll.
      v += t.acc * dt;
      if (v > 0) v = 0;
    } else {
      v += t.acc * dt;
      if (v < 0) v = 0;
    }
    var ds = v * dt;
    var dlat = 0;
    var dLat = t.latT - veh.lat;
    if (dLat !== 0) {
      var most = t.latR * dt;
      dlat = dLat > most ? most : (dLat < -most ? -most : dLat);
    }
    if (t.lcTo >= 0) dlat = TLV.traffic.lanechange.step(S, veh, dt);
    if (ds !== 0 || dlat !== 0) {
      if (personTouches(S, veh, ds, dlat)) {
        if (v > 0.3) T.contacts++;
        v = 0;
        ds = 0;
        dlat = 0;
        if (t.lcTo >= 0) TLV.traffic.lanechange.refused(S, veh, dt);
      } else if (pathTouches(S, veh, ds, dlat)) {
        // Refused sideways is no reason to stop. A car coming back from the next lane drives on and comes back later.
        if (dlat !== 0 && t.lcTo < 0 && ds !== 0 && !pathTouches(S, veh, ds, 0)) {
          dlat = 0;
        } else {
          if (v > 0.3) T.contacts++;
          t.contactT += dt;
          v = 0;
          ds = 0;
          dlat = 0;
          if (t.lcTo >= 0) TLV.traffic.lanechange.refused(S, veh, dt);
        }
      }
    }
    veh.v = v;
    veh.accel = t.acc;
    veh.s += ds;
    veh.lat += dlat;
    t.odo += ds;
    t.pedGap -= ds;
    t.zoneGap -= ds;
    t.sensorGap -= ds;
    TLV.traffic.gate.advance(S, veh);
    // A standing car stays exactly where it is. Its pose reads the road ahead of it, and a stopped car can change its mind about
    // which way that is, which must not swing a body parked beside something.
    if (ds !== 0 || dlat !== 0) idm.pose(S, veh, ds, dt);
    else stand(veh);
  };

  /**
   * A point on the path ahead of the car, along its plan, granted or not.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle in LANE or CONN.
   * @param {number} d Metres ahead of its centre.
   * @param {object} out Written and returned.
   * @returns {object} out.
   */
  function pathPoint(S, veh, d, out) {
    var W = S.world;
    var t = veh._t;
    var lanes = TLV.world.lanes;
    var s = veh.s + d;
    var last;
    if (veh.mode === 'LANE') {
      last = veh.laneId;
      if (s <= W.lanes[last].len) return lanes.pointAt(W, last, s, out);
      s -= W.lanes[last].len;
    } else {
      var conn = W.conns[veh.connId];
      if (s <= conn.len) return lanes.connPointAt(W, conn.id, s, out);
      s -= conn.len;
      last = conn.to;
      if (s <= W.lanes[last].len) return lanes.pointAt(W, last, s, out);
      s -= W.lanes[last].len;
    }
    for (var i = 0; i < t.pn; i++) {
      var c = W.conns[t.plan[i]];
      if (s <= c.len) return lanes.connPointAt(W, c.id, s, out);
      s -= c.len;
      last = c.to;
      if (s <= W.lanes[last].len) return lanes.pointAt(W, last, s, out);
      s -= W.lanes[last].len;
    }
    return lanes.pointAt(W, last, W.lanes[last].len, out);
  }

  idm.pathPoint = pathPoint;

  /** Zone-based stop: the nearest occupied zone ahead on this lane and the next. */
  function scanZones(S, veh, reach) {
    var W = S.world;
    var t = veh._t;
    var peds = TLV.peds;
    t.zoneGap = Infinity;
    if (!peds.zoneOccupied) return;
    var lane = null;
    var from = 0;
    var base = 0;
    if (veh.mode === 'LANE') {
      lane = W.lanes[veh.laneId];
      from = veh.s;
    } else {
      var conn = W.conns[veh.connId];
      lane = W.lanes[conn.to];
      base = conn.len - veh.s;
      from = -Infinity;
    }
    for (var round = 0; round < 2 && lane; round++) {
      for (var i = 0; i < lane.zones.length; i++) {
        var z = W.zones[lane.zones[i]];
        var nose = base + z.s0 - (from === -Infinity ? 0 : from) - t.halfL;
        if (nose < 0) continue;
        if (nose > reach) return;
        if (peds.zoneOccupied(S, z.id)) {
          t.zoneGap = nose;
          return;
        }
      }
      base += lane.len - (from === -Infinity ? 0 : from);
      from = -Infinity;
      if (t.pn === 0) return;
      var next = W.conns[t.plan[round === 0 ? 0 : 1]];
      if (!next) return;
      base += next.len;
      lane = W.lanes[next.to];
    }
  }

  /** Walks the path ahead for one person's position. @returns {number} Metres from the nose to the person, or Infinity. */
  function personOnPath(S, veh, x, y, corridor, reach) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var step = Q.pedSampleM;
    var end = reach + t.halfL;
    var lat = veh.lat;
    pathPoint(S, veh, 0, T.at2);
    var ax = T.at2.x - Math.sin(T.at2.h) * lat;
    var ay = T.at2.y + Math.cos(T.at2.h) * lat;
    for (var d = step; d <= end; d += step) {
      pathPoint(S, veh, d, T.at2);
      // The corridor runs where the car is, which for one out passing is not the middle of its lane.
      var bx = T.at2.x - Math.sin(T.at2.h) * lat;
      var by = T.at2.y + Math.cos(T.at2.h) * lat;
      var hit = TLV.math.pointSegDist(x, y, ax, ay, bx, by) < corridor;
      ax = bx;
      ay = by;
      if (hit) return d - step - t.halfL;
    }
    return Infinity;
  }

  /**
   * The contact net's early eye, at 10 Hz: this car's body where it would have stopped, against the others where they will be by
   * then. The leader lists see everything on a shared path, but not a van's tail across the mouth of a junction, or a bus swinging
   * through a bend beside a queue. A car that sees one brakes for it, so that the net itself, which stops a car dead, rarely has to.
   * @returns {boolean} True when the car should brake.
   */
  function softStop(S, veh, t) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var v = veh.v;
    var look = v * v / (2 * Q.softBrake) + v * Q.softLagS + Q.softPad;
    if (!bodyClose(S, veh, look)) return false;
    axlePose(S, veh, t, look, veh.lat);
    var nx = T.pX;
    var ny = T.pY;
    var nc = T.pC;
    var ns = T.pS1;
    var tau = v > Q.softMinV ? look / v : Q.softHoldS;
    var list = S.vehicles;
    for (var k = 0; k < t.nearN; k++) {
      var o = list[t.near[k]];
      if (!o.active || o.isPlayer || o.slot === t.lead) continue;
      var u = o._t;
      var ox = o.x + o.vx * tau;
      var oy = o.y + o.vy * tau;
      var after = apart(nx, ny, nc, ns, t.halfL, t.halfW, ox, oy, u.cosH, u.sinH, u.halfL, u.halfW);
      if (after >= Q.contactClear) continue;
      var askew = nc * u.sinH - ns * u.cosH;
      if (askew < Q.contactParallel && askew > -Q.contactParallel && after >= Q.contactMin) continue;
      if (after < apart(veh.x, veh.y, t.cosH, t.sinH, t.halfL, t.halfW, ox, oy, u.cosH, u.sinH, u.halfL, u.halfW)) return true;
    }
    return false;
  }

  /** @returns {boolean} True when a person stands within pad of a box. */
  function inBox(x, y, c, s, hl, hw, px, py, pad) {
    var dx = px - x;
    var dy = py - y;
    var a = dx * c + dy * s;
    var l = dy * c - dx * s;
    hl += pad;
    hw += pad;
    return a < hl && a > -hl && l < hw && l > -hw;
  }

  /** Records the nearest person found so far. */
  function notePerson(t, gap, v) {
    if (gap < t.pedGap) {
      t.pedGap = gap;
      t.pedV = v;
    }
  }

  /** The player as an obstacle when the lane lists cannot place the car (ARCHITECTURE 12.5). */
  function scanPlayer(S, veh) {
    var Q = TLV.tune.traffic;
    var t = veh._t;
    var me = S.vehicles[0];
    t.sensorGap = Infinity;
    if (!me.active || (S.player && S.player.mode === 'FOOT')) return;
    var dx = me.x - veh.x;
    var dy = me.y - veh.y;
    var r = Q.sensorM + t.halfL;
    if (dx * dx + dy * dy > r * r) return;
    var along = dx * t.cosH + dy * t.sinH;
    if (along <= 0) return;
    var side = dy * t.cosH - dx * t.sinH;
    if (side < 0) side = -side;
    if (side > t.halfW + me.width / 2 + Q.sensorLat) return;
    if (side > along * Math.tan(Q.sensorDeg * Math.PI / 180) + t.halfW + me.width / 2) return;
    var cross = me.vy * t.cosH - me.vx * t.sinH;
    if (cross > Q.sensorCrossV || cross < -Q.sensorCrossV) return;
    t.sensorGap = along - t.halfL - me.length / 2;
    t.sensorV = me.vx * t.cosH + me.vy * t.sinH;
  }

  /**
   * People and the player on the path ahead, at 10 Hz. A person is found by walking the path itself, through connectors, not
   * by zones on lanes: a crossing can sit on a connector, well before the lane its zone was snapped to.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle in LANE or CONN.
   */
  idm.scan = function (S, veh) {
    var T = S.traffic;
    var Q = TLV.tune.traffic;
    var t = veh._t;
    scanPlayer(S, veh);
    t.soft = t.nearN > 0 && softStop(S, veh, t);
    t.pedGap = Infinity;
    t.pedV = 0;
    t.netN = 0;
    var reach = veh.v * veh.v / (2 * Q.hardBrake) + veh.v + Q.pedLook;
    var corridor = t.halfW + (veh.ag > Q.pedSqueezeAg ? Q.pedSqueezeCorridor : Q.pedCorridor);
    var foot = S.player && S.player.foot;
    if (foot && S.player.mode === 'FOOT') {
      var fx = foot.x - veh.x;
      var fy = foot.y - veh.y;
      var fr = reach + t.halfL + corridor;
      if (fx * fx + fy * fy < fr * fr) notePerson(t, personOnPath(S, veh, foot.x, foot.y, corridor, reach), 0);
    }
    var peds = TLV.peds;
    if (!peds) return;
    scanZones(S, veh, reach + Q.pedLook);
    if (!peds.pedsNear) return;
    var out = T.pedNear;
    var count = peds.pedsNear(S, veh.x, veh.y, reach + t.halfL + corridor, out);
    if (count === 0) return;
    // Where the body will be in a moment: a long one swings its ends out over a kerb, wide of any corridor round its path.
    var ahead = veh.v * Q.pedSweepS + Q.pedSweepPad;
    axlePose(S, veh, t, ahead, veh.lat);
    var ax = T.pX;
    var ay = T.pY;
    var ac = T.pC;
    var as = T.pS1;
    for (var i = 0; i < count; i++) {
      var p = out[i];
      var r = p.r || 0;
      // Off the road only the body itself counts: a kerb can stand within a stride of a lane, and walkers line it.
      // Someone beside the body, behind the nose, is not ahead of it. Stopping for a passenger who is waiting for this car to leave holds both.
      if (t.netN < t.netP.length && inBox(veh.x, veh.y, t.cosH, t.sinH, t.halfL, t.halfW, p.x, p.y, r + Q.personNetM)) t.netP[t.netN++] = p;
      var ahead2 = personOnPath(S, veh, p.x, p.y, p.onRoad ? corridor + r : t.halfW + r + Q.pedBodyClear, reach);
      if (ahead2 >= -Q.pedBehindNose) notePerson(t, ahead2, 0);
      if (veh.v > Q.pedSweepV && inBox(ax, ay, ac, as, t.halfL, t.halfW, p.x, p.y, r + Q.pedBodyClear) &&
          !inBox(veh.x, veh.y, t.cosH, t.sinH, t.halfL, t.halfW, p.x, p.y, r)) notePerson(t, 0, 0);
    }
  };

  /** Rebuilds the 8 m broadphase, at the end of the tick. */
  idm.broadphase = function (S) {
    var T = S.traffic;
    T.gStamp++;
    var list = S.vehicles;
    var stamp = T.gStamp;
    for (var i = -1; i < T.nAct; i++) {
      var slot = i < 0 ? 0 : T.act[i];
      var veh = list[slot];
      if (!veh.active) continue;
      var cx = Math.floor((veh.x - T.gMinX) / GRID_CELL);
      var cy = Math.floor((veh.y - T.gMinY) / GRID_CELL);
      if (cx < 0) cx = 0;
      if (cy < 0) cy = 0;
      if (cx >= T.gNx) cx = T.gNx - 1;
      if (cy >= T.gNy) cy = T.gNy - 1;
      var c = cy * T.gNx + cx;
      T.gNext[slot] = T.gMark[c] === stamp ? T.gHead[c] : -1;
      T.gMark[c] = stamp;
      T.gHead[c] = slot;
    }
  };

  /** Calls nothing back: fills a caller's list with the slots in cells around a point. @returns {number} Count. */
  idm.near = function (S, x, y, r, out, skip) {
    var T = S.traffic;
    var cx0 = Math.floor((x - r - T.gMinX) / GRID_CELL);
    var cx1 = Math.floor((x + r - T.gMinX) / GRID_CELL);
    var cy0 = Math.floor((y - r - T.gMinY) / GRID_CELL);
    var cy1 = Math.floor((y + r - T.gMinY) / GRID_CELL);
    if (cx0 < 0) cx0 = 0;
    if (cy0 < 0) cy0 = 0;
    if (cx1 >= T.gNx) cx1 = T.gNx - 1;
    if (cy1 >= T.gNy) cy1 = T.gNy - 1;
    var n = 0;
    var cap = out.length;
    var r2 = r * r;
    var list = S.vehicles;
    for (var cy = cy0; cy <= cy1; cy++) {
      for (var cx = cx0; cx <= cx1; cx++) {
        var c = cy * T.gNx + cx;
        if (T.gMark[c] !== T.gStamp) continue;
        for (var s = T.gHead[c]; s >= 0; s = T.gNext[s]) {
          if (s === skip) continue;
          var o = list[s];
          var dx = o.x - x;
          var dy = o.y - y;
          if (dx * dx + dy * dy > r2) continue;
          if (n < cap) out[n++] = s;
        }
      }
    }
    return n;
  };

  /**
   * Tells the cars near a new one that it is there, at once. Lists otherwise refresh every nearTicks, and a car appearing beside
   * another on the far side of a hairpin would be invisible to the contact net until then.
   * @param {object} S Sim state.
   * @param {object} veh The new vehicle.
   */
  idm.introduce = function (S, veh) {
    var T = S.traffic;
    var t = veh._t;
    t.nearN = 0;
    for (var i = 0; i < T.nAct; i++) {
      var o = S.vehicles[T.act[i]];
      if (o === veh) continue;
      var u = o._t;
      var dx = o.x - veh.x;
      var dy = o.y - veh.y;
      var reach = t.diag + u.diag + TLV.tune.traffic.nearReach;
      if (dx * dx + dy * dy > reach * reach) continue;
      if (t.nearN < t.near.length) t.near[t.nearN++] = o.slot;
      if (u.nearN < u.near.length) u.near[u.nearN++] = veh.slot;
    }
  };

  /**
   * Refreshes a car's neighbour list for the contact net.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   */
  idm.refreshNear = function (S, veh) {
    var t = veh._t;
    var Q = TLV.tune.traffic;
    // A faster car has to know of a body sooner, to brake for it. Capped, because the list keeps the first it finds, not the nearest.
    var v = veh.v < 0 ? -veh.v : veh.v;
    var look = v * v / (2 * Q.softBrake) + v * Q.softLagS;
    if (look > Q.nearLookMax) look = Q.nearLookMax;
    t.nearN = idm.near(S, veh.x, veh.y, t.diag + Q.nearBody + Q.nearReach + look, t.near, veh.slot);
  };

  /**
   * Nearest car ahead and behind on a lane, around a position.
   * @param {object} S Sim state.
   * @param {number} laneId Lane.
   * @param {number} s Position, the car's centre.
   * @param {number} half Half length of the car being placed.
   * @param {number} me Slot to skip.
   * @param {object} out {lead, leadGap, leadV, foll, follGap, follV}. A missing neighbour has slot -2 and gap Infinity.
   * @returns {object} out.
   */
  idm.neighbours = function (S, laneId, s, half, me, out) {
    var T = S.traffic;
    out.lead = -2;
    out.leadGap = Infinity;
    out.leadV = 0;
    out.foll = -2;
    out.follGap = Infinity;
    out.follV = 0;
    if (T.mark[laneId] !== T.stamp) return out;
    for (var e = T.head[laneId]; e >= 0; e = T.eNext[e]) {
      if (T.eVeh[e] === me) continue;
      var at = T.eS[e];
      if (at < s) {
        out.foll = T.eVeh[e];
        out.follGap = s - half - (at + T.eHalf[e]);
        out.follV = T.eV[e];
      } else {
        out.lead = T.eVeh[e];
        out.leadGap = at - T.eHalf[e] - (s + half);
        out.leadV = T.eV[e];
        break;
      }
    }
    return out;
  };

  /** @returns {number} Metres of free lane from its start, with a moving tail read ahead, or the whole lane. */
  idm.room = function (S, laneId, look) {
    var T = S.traffic;
    var len = S.world.lanes[laneId].len;
    if (T.mark[laneId] !== T.stamp) return len;
    var e = T.head[laneId];
    var rear = T.eS[e] - T.eHalf[e];
    var v = T.eV[e];
    if (v > 0) rear += v * look;
    return rear < len ? rear : len;
  };

  /** @returns {boolean} True when a lane holds any body. */
  idm.occupied = function (S, laneId) {
    return S.traffic.mark[laneId] === S.traffic.stamp;
  };
})(window.TLV);
