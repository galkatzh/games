// js/sim/player/bots.js — WP-PLAYER
// Control sources for soak, tests and autoplay (ARCHITECTURE 12.4). A bot fills a ControlState and nothing else, so a run
// replays from its input log. Its only randomness is S.rng.bot, and its state lives in the closure made by create, so each
// sim has its own. chaos alone reaches past the controls, to teleport, which is why chaos runs do not replay.
(function (TLV) {
  'use strict';

  var bots = TLV.ns('bots');

  /** @returns {object} ControlState (ARCHITECTURE 10.1), at rest. */
  function newControls() {
    return {
      throttle: 0, brake: 0, steer: 0,
      handbrake: false, horn: false, interact: false, hazard: false,
      footX: 0, footY: 0,
      sidestep: false, start: false, restart: false, recover: false
    };
  }

  /** Sets a ControlState back to rest. */
  function rest(c) {
    c.throttle = 0;
    c.brake = 0;
    c.steer = 0;
    c.handbrake = false;
    c.horn = false;
    c.interact = false;
    c.hazard = false;
    c.footX = 0;
    c.footY = 0;
    c.sidestep = false;
    c.start = false;
    c.restart = false;
    c.recover = false;
  }

  /** @returns {object} What the road-following code keeps between ticks. */
  function newDriver() {
    return {
      route: null,          // the Route being followed
      s: 0,                 // progress along it
      px: null, py: null,   // the path driven: the route, moved off walls
      speed: null,          // Float32Array: corner speed at each route point
      stopS: [],            // stop lines along the route, s
      stopConn: [],         // connector each one governs
      nextStop: 0,
      gap: Infinity,        // nearest obstacle ahead, bumper to bumper
      leadV: 0,             // its speed along the path
      person: false,        // the nearest obstacle is a person
      scanT: 0,             // ticks to the next scan
      armed: 0,             // seconds an obstacle has been inside braker's reach
      stuckT: 0,
      queueT: 0,
      reverseT: 0,
      recoverT: 0,
      hardStuckT: 0,
      markX: 0, markY: 0,   // where the stuck timers last started
      freeX: 0, freeY: 0,   // where the car last counted as clear of any trouble
      tries: 0,             // escapes since then
      waiting: false,       // held by a signal or a queue this tick, so standing still is correct
      pt: { x: 0, y: 0, h: 0 },
      proj: { s: 0, d: 0, side: 0 },
      cars: [],
      people: [],
      near: {}
    };
  }

  /** @returns {number} Fastest speed at which the steering can hold a curvature (GAME_DESIGN 4: the wheel's range shrinks with speed). */
  function steerSpeed(kappa, wheelbase) {
    var T = TLV.tune.player;
    var B = T.bot;
    var need = Math.atan(kappa * wheelbase) * 180 / Math.PI;
    var share = (T.steerMaxDeg - need) / (T.steerMaxDeg - T.steerMinDeg);
    if (share <= 0) return B.cornerFloor;
    var v = T.steerRefSpeed * Math.pow(share, 1 / T.steerExp) * B.steerMargin;
    return v < B.cornerFloor ? B.cornerFloor : v;
  }

  /**
   * Corner speeds from the path's shape, then a backward pass so the car is down to each in time. Curvature is read over a
   * fixed arc on each side, since route points are 1.5 to 3 m apart. Over an arc of 2w, two chords differ by w / R.
   */
  function cornerSpeeds(px, py, cum, slow, wheelbase) {
    var B = TLV.tune.player.bot;
    var n = px.length;
    var out = new Float32Array(n);
    var a = 0;
    var b = 0;
    var i;
    for (i = 0; i < n; i++) {
      while (cum[i] - cum[a] > B.cornerSpanM) a++;
      while (b < n - 1 && cum[b] - cum[i] < B.cornerSpanM) b++;
      out[i] = slow && slow[i] ? B.tightSpeed : 1e3;
      if (i <= a || i >= b) continue;
      var h0 = Math.atan2(py[i] - py[a], px[i] - px[a]);
      var h1 = Math.atan2(py[b] - py[i], px[b] - px[i]);
      var turn = Math.abs(TLV.math.wrapPi(h1 - h0));
      var ds = cum[b] - cum[a];
      if (turn < 1e-3 || ds < 0.1) continue;
      var kappa = 2 * turn / ds;
      var limit = Math.min(Math.sqrt(B.cornerLat / kappa), steerSpeed(kappa, wheelbase));
      if (limit < out[i]) out[i] = limit;
    }
    for (i = n - 2; i >= 0; i--) {
      var run = cum[i + 1] - cum[i];
      var back = Math.sqrt(out[i + 1] * out[i + 1] + 2 * B.cornerBrake * run);
      if (back < out[i]) out[i] = back;
    }
    return out;
  }

  /**
   * The bot's own copy of a route, moved off walls. 0.35% of AI lane samples stand within half a car of a wall, mostly on old
   * narrow streets, so a car held to the centreline clips them. Points that cannot clear are marked for a slow pass.
   */
  function clearPath(S, d, route) {
    var B = TLV.tune.player.bot;
    var W = S.world;
    var col = W.colliders;
    var veh = S.player.veh;
    var ids = S.player._c.segs;
    var n = route.px.length;
    var px = new Float32Array(route.px);
    var py = new Float32Array(route.py);
    var ox = new Float32Array(n);
    var oy = new Float32Array(n);
    var tight = new Uint8Array(n);
    var want = veh.width / 2 + B.wallClearM;
    var i;
    for (i = 0; i < n; i++) {
      var m = TLV.world.spatial.collidersNear(W, px[i], py[i], want, ids);
      for (var k = 0; k < m; k++) {
        var id = ids[k];
        var ax = col.ax[id];
        var ay = col.ay[id];
        var dx = col.bx[id] - ax;
        var dy = col.by[id] - ay;
        var len2 = dx * dx + dy * dy;
        var t = len2 > 0 ? ((px[i] - ax) * dx + (py[i] - ay) * dy) / len2 : 0;
        t = t < 0 ? 0 : (t > 1 ? 1 : t);
        var ex = px[i] - (ax + dx * t);
        var ey = py[i] - (ay + dy * t);
        var dist = Math.sqrt(ex * ex + ey * ey);
        if (dist < 1e-3 || dist >= want) continue;
        ox[i] += ex / dist * (want - dist);
        oy[i] += ey / dist * (want - dist);
      }
    }
    // A wall affects a car over its length, so each point takes the strongest push near it.
    for (i = 0; i < n; i++) {
      var best = 0;
      var mx = 0;
      var my = 0;
      for (var j = i - B.wallSpread; j <= i + B.wallSpread; j++) {
        if (j < 0 || j >= n) continue;
        var share = 1 - Math.abs(j - i) / (B.wallSpread + 1);
        var pushX = ox[j] * share;
        var pushY = oy[j] * share;
        var size = pushX * pushX + pushY * pushY;
        if (size > best) {
          best = size;
          mx = pushX;
          my = pushY;
        }
      }
      px[i] = route.px[i] + mx;
      py[i] = route.py[i] + my;
    }
    for (i = 0; i < n; i++) {
      var close = TLV.world.spatial.collidersNear(W, px[i], py[i], veh.width / 2 + B.tightClearM, ids);
      if (close > 0) tight[i] = 1;
    }
    d.px = px;
    d.py = py;
    d.speed = cornerSpeeds(px, py, route.cum, tight, veh.wheelbase);
  }

  /** Finds the stop lines of the signals on a route, by projecting each exit lane's end onto the polyline. */
  function findStops(W, d, route) {
    var junctions = TLV.world.junctions;
    var path = route.dirEdges;
    var last0 = route.px.length - 1;
    var from = 0;
    d.stopS.length = 0;
    d.stopConn.length = 0;
    d.nextStop = 0;
    for (var i = 0; i + 1 < path.length; i++) {
      var de = W.dirEdges[path[i]];
      if (W.juncs[de.to].kind !== 'SIGNAL') continue;
      var bestD = Infinity;
      var bestS = 0;
      var bestConn = -1;
      for (var k = 0; k < de.lanes.length; k++) {
        var conn = junctions.connFor(W, de.lanes[k], path[i + 1]);
        if (conn < 0) continue;
        var lane = W.lanes[de.lanes[k]];
        var last = lane.px.length - 1;
        // All the route still ahead is read, and no hint is used. A hint's 50 m window can stop on a point 10 m short of a line
        // further on, and a stop line in the wrong place is a car that drives through the real one.
        nearestAhead(d, lane.px[last], lane.py[last], from, last0);
        if (d.proj.d < bestD) {
          bestD = d.proj.d;
          bestS = d.proj.s;
          bestConn = conn;
        }
      }
      if (bestConn < 0 || bestD > 12) continue;
      from = indexAt(route.cum, bestS);
      d.stopS.push(bestS);
      d.stopConn.push(bestConn);
    }
  }

  /** Takes on a route. */
  function attach(S, d, route) {
    d.route = route;
    d.s = 0;
    clearPath(S, d, route);
    findStops(S.world, d, route);
    var veh = S.player.veh;
    TLV.math.polyProject(route.px, route.py, route.cum, veh.x, veh.y, 0, d.proj);
    d.s = d.proj.s;
    while (d.nextStop < d.stopS.length && d.stopS[d.nextStop] < d.s) d.nextStop++;
    d.gap = Infinity;
    d.scanT = 0;
  }

  /** @returns {boolean} True if a route holds a U-turn. A dead-end U-turn connector is tighter than the car's turning circle. */
  function hasUTurn(W, route) {
    var path = route.dirEdges;
    for (var i = 0; i + 1 < path.length; i++) {
      var lanes = W.dirEdges[path[i]].lanes;
      for (var k = 0; k < lanes.length; k++) {
        var c = TLV.world.junctions.connFor(W, lanes[k], path[i + 1]);
        if (c >= 0 && W.conns[c].turn === 'U') return true;
      }
    }
    return false;
  }

  /**
   * Finds a route to a random far lane, from where the car is now. A route with a U-turn is used only if none without one turns
   * up, which is the case in a dead end.
   * @returns {boolean} True if a route was found.
   */
  function pickRoute(S, d) {
    var B = TLV.tune.player.bot;
    var W = S.world;
    var rng = S.rng.bot;
    var veh = S.player.veh;
    var ai = TLV.const.LF.AI_ROUTABLE;
    var spare = null;
    for (var i = 0; i < B.targetTries; i++) {
      var lane = W.lanes[rng.int(W.lanes.length)];
      if (!(lane.flags & ai) || lane.len < B.targetMinLen) continue;
      var dx = lane.px[0] - veh.x;
      var dy = lane.py[0] - veh.y;
      if (dx * dx + dy * dy < B.targetMinM * B.targetMinM) continue;
      var route = TLV.world.routing.route(W, veh.x, veh.y, veh.h, lane.id, lane.len / 2, { ai: true });
      if (!route || route.len <= B.targetMinM) continue;
      if (!hasUTurn(W, route)) {
        attach(S, d, route);
        return true;
      }
      if (!spare) spare = route;
    }
    if (spare) attach(S, d, spare);
    return !!spare;
  }

  /** Lane speed under the car, or the route's own limit off the lanes. */
  function laneSpeed(S) {
    var lane = S.player.laneId >= 0 ? S.world.lanes[S.player.laneId] : null;
    return (lane ? lane.vmax : 8) * TLV.tune.player.bot.laneSpeedShare;
  }

  /** @returns {number} The speed the signals allow, m/s. Sets d.waiting when held. */
  function signalLimit(S, d, v) {
    var B = TLV.tune.player.bot;
    var SIG = TLV.const.SIG;
    var signals = TLV.world.signals;
    while (d.nextStop < d.stopS.length && d.s > d.stopS[d.nextStop] - 0.5) d.nextStop++;
    if (d.nextStop >= d.stopS.length) return Infinity;
    var dist = d.stopS[d.nextStop] - B.stopMargin - d.s;
    if (dist > 120) return Infinity;
    var conn = d.stopConn[d.nextStop];
    var state = signals.connState(S, conn);
    if (state === SIG.GREEN) return Infinity;
    if (state === SIG.AMBER) {
      // Clears the line before red, or stops. One decision, from the clock: a car that keeps choosing crosses on red.
      var reach = v * signals.timeToRed(S, conn);
      if (reach > dist + B.stopMargin + B.amberClearM) return Infinity;
      if (dist > 0 && v * v / (2 * dist) > TLV.tune.player.brake) return Infinity;
    }
    if (dist < B.signalHoldM) d.waiting = true;
    return dist > 0 ? Math.sqrt(2 * B.stopBrake * dist) : 0;
  }

  /** Nearest point of the route ahead of the car, for a position. Writes d.proj. @returns {boolean} False if off the stretch. */
  function nearestAhead(d, x, y, from, to) {
    var r = d.route;
    var best = Infinity;
    var bestS = 0;
    var bestI = from;
    for (var i = from; i < to; i++) {
      var ax = r.px[i];
      var ay = r.py[i];
      var dx = r.px[i + 1] - ax;
      var dy = r.py[i + 1] - ay;
      var ex = x - ax;
      var ey = y - ay;
      var len2 = dx * dx + dy * dy;
      var t = len2 > 0 ? (ex * dx + ey * dy) / len2 : 0;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      var qx = ex - dx * t;
      var qy = ey - dy * t;
      var dist = qx * qx + qy * qy;
      if (dist < best) {
        best = dist;
        bestS = r.cum[i] + (r.cum[i + 1] - r.cum[i]) * t;
        bestI = i;
      }
    }
    d.proj.s = bestS;
    d.proj.d = Math.sqrt(best);
    d.proj.side = bestI;
    return best < Infinity;
  }

  /** @returns {number} Index of the last route point at or before s. */
  function indexAt(cum, s) {
    var lo = 0;
    var hi = cum.length - 1;
    while (hi - lo > 1) {
      var mid = (lo + hi) >> 1;
      if (cum[mid] <= s) lo = mid;
      else hi = mid;
    }
    return lo;
  }

  /** Looks along the route for anything in the car's way, now or at the moment the car gets there. */
  function scanAhead(S, d) {
    var T = TLV.tune.player;
    var B = T.bot;
    var veh = S.player.veh;
    var r = d.route;
    var v = veh.v > 0 ? veh.v : 0;
    var horizon = Math.min(B.scanMax, Math.max(B.scanMin, v * B.scanPerV));
    var from = indexAt(r.cum, d.s);
    var to = indexAt(r.cum, d.s + horizon) + 1;
    if (to > r.px.length - 1) to = r.px.length - 1;
    var bestGap = Infinity;
    var bestV = 0;
    var bestPerson = false;
    if (to <= from) {
      d.gap = bestGap;
      return;
    }
    var hl = veh.length / 2;
    var hw = veh.width / 2 + B.corridorPad;
    var i;
    var step;
    var nCars = TLV.collide._carsNear(S, veh.x, veh.y, horizon + 12, d.cars);
    for (i = 0; i < nCars; i++) {
      var o = d.cars[i];
      if (!o.active || o.isPlayer) continue;
      var c = Math.cos(o.h);
      var s = Math.sin(o.h);
      var ohl = o.length / 2;
      var ohw = o.width / 2;
      // A car behind going the same way is no obstacle, however fast it comes: read ahead, it would be, and the bot would stop for it.
      if ((o.x - veh.x) * Math.cos(veh.h) + (o.y - veh.y) * Math.sin(veh.h) < -hl && c * Math.cos(veh.h) + s * Math.sin(veh.h) > B.behindSame) continue;
      for (step = 0; step <= B.predictSteps; step++) {
        var tau = step * B.predictStepS;
        var x = o.x + o.vx * tau;
        var y = o.y + o.vy * tau;
        nearestAhead(d, x, y, from, to);
        var along = d.proj.s - d.s;
        if (along < -1) continue;
        var seg = d.proj.side;
        var tx = r.px[seg + 1] - r.px[seg];
        var ty = r.py[seg + 1] - r.py[seg];
        var tl = Math.sqrt(tx * tx + ty * ty) || 1;
        tx /= tl;
        ty /= tl;
        var cosA = Math.abs(c * tx + s * ty);
        var sinA = Math.abs(c * ty - s * tx);
        if (d.proj.d - (ohl * sinA + ohw * cosA) > hw) continue;
        var gap = along - (ohl * cosA + ohw * sinA) - hl;
        if (step > 0 && Math.abs(along - v * tau) > B.arrivalWindowM) continue;
        var leadV = step === 0 ? o.vx * tx + o.vy * ty : 0;
        if (gap < bestGap) {
          bestGap = gap;
          bestV = leadV > 0 ? leadV : 0;
          bestPerson = false;
        }
        break;
      }
    }
    var nPeople = TLV.collide._peopleNear(S, veh.x, veh.y, horizon, d.people);
    for (i = 0; i < nPeople; i++) {
      var ped = d.people[i];
      if (!ped.active) continue;
      var vx = ped.v * Math.cos(ped.h);
      var vy = ped.v * Math.sin(ped.h);
      if (ped.intent && ped.v < B.personIntentV) {
        vx = B.personIntentV * Math.cos(ped.h);
        vy = B.personIntentV * Math.sin(ped.h);
      }
      var reach = veh.width / 2 + B.personPad + ped.r;
      for (step = 0; step <= B.predictSteps; step++) {
        var pt = step * B.predictStepS;
        nearestAhead(d, ped.x + vx * pt, ped.y + vy * pt, from, to);
        var pAlong = d.proj.s - d.s;
        if (pAlong < -1 || d.proj.d > reach) continue;
        if (step > 0 && Math.abs(pAlong - v * pt) > B.arrivalWindowM) continue;
        var pGap = pAlong - hl - ped.r;
        if (pGap < bestGap) {
          bestGap = pGap;
          bestV = 0;
          bestPerson = true;
        }
        break;
      }
    }
    d.gap = bestGap;
    d.leadV = bestV;
    d.person = bestPerson;
  }

  /** Pure pursuit: steers for a point ahead on the route. */
  function steerAlong(S, d, c) {
    var T = TLV.tune.player;
    var B = T.bot;
    var veh = S.player.veh;
    var speed = Math.abs(veh.v);
    var look = TLV.math.clamp(B.lookBase + B.lookPerV * speed, B.lookMin, B.lookMax);
    TLV.math.polyAt(d.px, d.py, d.route.cum, d.s + look, d.pt);
    steerAt(veh, d.pt.x, d.pt.y, c);
  }

  /** Steers the car for a point. */
  function steerAt(veh, x, y, c) {
    var dx = x - veh.x;
    var dy = y - veh.y;
    var dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < 0.3) {
      c.steer = 0;
      return;
    }
    var alpha = TLV.math.wrapPi(Math.atan2(dy, dx) - veh.h);
    var delta = Math.atan2(2 * veh.wheelbase * Math.sin(alpha), dist);
    var limit = TLV.player._steerMax(Math.abs(veh.v));
    c.steer = TLV.math.clamp(delta / limit, -1, 1);
  }

  /** Turns a target speed into pedals. The dead band means a car at rest never holds the brake, which would turn into reverse. */
  function pedals(veh, want, c) {
    var T = TLV.tune.player;
    var B = T.bot;
    var v = veh.v;
    var a = (want - v) * B.speedGain;
    if (a > 0) {
      var avail = T.accelBase * (1 - Math.max(v, 0) / T.accelFadeV);
      c.throttle = TLV.math.clamp(a / avail, 0, 1);
      c.brake = 0;
    } else if (-a > T.coastDrag) {
      c.throttle = 0;
      c.brake = TLV.math.clamp(-a / T.brake, 0, 1);
    } else {
      c.throttle = 0;
      c.brake = 0;
    }
  }

  /** @returns {number} Corner speed at the car. */
  function cornerLimit(d) {
    return d.speed[indexAt(d.route.cum, d.s)];
  }

  /**
   * Gets a car that has stopped for no reason moving: back off and find a new way, or, as a last resort, hold recover,
   * which WP-GAME acts on, because a bot can never teleport.
   * @returns {boolean} True while this has the controls.
   */
  function unstick(S, d, c, dt, replan) {
    var B = TLV.tune.player.bot;
    var veh = S.player.veh;
    if (d.recoverT > 0) {
      d.recoverT -= dt;
      c.recover = true;
      return true;
    }
    if (d.reverseT > 0) {
      d.reverseT -= dt;
      c.throttle = 0;
      c.brake = 1;
      // Rolling backward turns the car the other way, so this swings the nose toward the path.
      c.steer = -c.steer;
      if (d.reverseT <= 0 && replan) replan(S, d);
      d.markX = veh.x;
      d.markY = veh.y;
      return true;
    }
    // Backing off and trying again can cover metres and still get nowhere, so tries only reset once the car has really left.
    var fx = veh.x - d.freeX;
    var fy = veh.y - d.freeY;
    if (fx * fx + fy * fy > B.escapedM * B.escapedM) {
      d.freeX = veh.x;
      d.freeY = veh.y;
      d.tries = 0;
    }
    // Progress is measured in metres. A car nosing a parked car bounces above any speed test.
    var dx = veh.x - d.markX;
    var dy = veh.y - d.markY;
    if (d.waiting || dx * dx + dy * dy > B.stuckMoveM * B.stuckMoveM) {
      d.markX = veh.x;
      d.markY = veh.y;
      d.hardStuckT = 0;
      d.queueT = 0;
      d.stuckT = 0;
      return false;
    }
    d.hardStuckT += dt;
    if (d.gap < B.queueGapM) d.queueT += dt;
    else d.stuckT += dt;
    var giveUp = d.hardStuckT >= B.recoverStuckS || d.tries >= B.escapeTries;
    if (giveUp && (d.stuckT >= B.stuckS || d.hardStuckT >= B.recoverStuckS)) {
      d.hardStuckT = 0;
      d.stuckT = 0;
      d.queueT = 0;
      d.tries = 0;
      d.recoverT = B.recoverHoldS;
      return true;
    }
    if (d.stuckT >= B.stuckS || d.queueT >= B.queueStuckS) {
      d.stuckT = 0;
      d.queueT = 0;
      d.tries++;
      d.reverseT = Math.min(B.reverseMaxS, B.reverseS + B.reversePerTry * d.tries);
      return true;
    }
    return false;
  }

  /** Moves the progress along the route. @returns {number} Distance off it. */
  function track(S, d) {
    var veh = S.player.veh;
    var r = d.route;
    TLV.world.routing.project(r, veh.x, veh.y, d.s, d.proj);
    d.s = d.proj.s;
    return d.proj.d;
  }

  /** @returns {boolean} True when the player's car takes controls now. */
  function canDrive(S) {
    return S.player.mode === 'DRIVE';
  }

  /** Scans on its tick. */
  function rescan(S, d) {
    // A bot runs at row 2, so on the first tick the traffic broadphase (row 6) has never been built, and must not be read.
    if (S.tick <= 1 || --d.scanT > 0) return;
    d.scanT = TLV.tune.player.bot.scanTicks;
    scanAhead(S, d);
  }

  /** The speed a car following the road may hold: lane, corners and signals. */
  function roadSpeed(S, d, v) {
    var want = Math.min(laneSpeed(S), cornerLimit(d));
    var lights = signalLimit(S, d, v);
    return lights < want ? lights : want;
  }

  /** @returns {number} Speed that keeps a following distance to the obstacle ahead. */
  function followLimit(d) {
    var B = TLV.tune.player.bot;
    if (d.gap === Infinity) return Infinity;
    var room = d.gap - B.followGap;
    if (room <= 0) return d.leadV < 0.5 ? 0 : d.leadV * 0.8;
    return Math.sqrt(d.leadV * d.leadV + 2 * B.followBrake * room);
  }

  /** Keeps a route alive, replacing it near its end or when the car has left it. @returns {boolean} False with no route. */
  function keepRoute(S, d) {
    var B = TLV.tune.player.bot;
    var veh = S.player.veh;
    if (!d.route) return pickRoute(S, d);
    var off = track(S, d);
    var left = d.route.len - d.s;
    if (off > B.routeOffM || left < Math.max(B.replanM, Math.abs(veh.v) * B.replanPerV)) pickRoute(S, d);
    return !!d.route;
  }

  /** At the end of a run, asks for another, unless the bot is idle. */
  function restart(S, c) {
    if (S.game && S.game.phase === 'RUN_END') c.restart = true;
    if (S.game && S.game.phase === 'TITLE') c.start = true;
  }

  /** `patrol`: routes to random targets, obeys signals, follows, overtakes nothing. */
  function patrol() {
    var c = newControls();
    var d = newDriver();
    return function (S) {
      rest(c);
      restart(S, c);
      if (!S.world || !canDrive(S)) return c;
      var veh = S.player.veh;
      if (!keepRoute(S, d)) return c;
      d.waiting = false;
      rescan(S, d);
      steerAlong(S, d, c);
      var want = roadSpeed(S, d, veh.v);
      var follow = followLimit(d);
      if (follow < want) want = follow;
      if (!unstick(S, d, c, TLV.const.DT, pickRoute)) pedals(veh, want, c);
      return c;
    };
  }

  /** `braker`: follows the road at lane speed, and answers any obstacle ahead late, with the full brake and nothing else. */
  function braker(opts) {
    var B = TLV.tune.player.bot;
    var T = TLV.tune.player;
    var c = newControls();
    var d = newDriver();
    var fixed = opts && opts.reactionS;
    return function (S) {
      rest(c);
      restart(S, c);
      if (!S.world || !canDrive(S)) return c;
      var veh = S.player.veh;
      if (!keepRoute(S, d)) return c;
      d.waiting = false;
      rescan(S, d);
      steerAlong(S, d, c);
      var heat = S.game ? S.game.heat : 0;
      var react = fixed !== undefined && fixed !== null ? fixed : B.reactionS + (B.reactionHotS - B.reactionS) * heat;
      var v = veh.v > 0 ? veh.v : 0;
      var closing = v > d.leadV ? v * v - d.leadV * d.leadV : 0;
      var reach = v * react + closing / (2 * T.brake) + B.brakerPad + B.brakerRange;
      var threat = d.gap <= reach;
      d.armed = threat ? d.armed + TLV.const.DT : 0;
      var want = roadSpeed(S, d, veh.v);
      if (unstick(S, d, c, TLV.const.DT, pickRoute)) return c;
      if (threat) d.waiting = true;
      if (threat && d.armed >= react && v > T.restSpeed) {
        c.throttle = 0;
        c.brake = 1;
      } else if (threat && v <= T.restSpeed) {
        c.throttle = 0;
        c.brake = 0;
      } else {
        pedals(veh, want, c);
      }
      return c;
    };
  }

  /** `chaos`: random controls for random spells, and now and then a teleport to a random lane. */
  function chaos() {
    var B = TLV.tune.player.bot;
    var c = newControls();
    var holdT = 0;
    var jumpT = -1;
    return function (S) {
      var rng = S.rng.bot;
      var dt = TLV.const.DT;
      if (jumpT < 0) jumpT = rng.range(B.chaosTeleportMinS, B.chaosTeleportMaxS);
      c.start = false;
      c.restart = false;
      restart(S, c);
      holdT -= dt;
      if (holdT <= 0) {
        holdT = rng.range(B.chaosHoldMinS, B.chaosHoldMaxS);
        c.throttle = rng.bool(0.7) ? rng.next() : 0;
        c.brake = rng.bool(0.25) ? rng.next() : 0;
        c.steer = rng.range(-1, 1);
        c.handbrake = rng.bool(0.15);
        c.horn = rng.bool(0.1);
        c.hazard = rng.bool(0.05);
        c.interact = rng.bool(0.1);
        c.sidestep = rng.bool(0.2);
        var a = rng.range(-Math.PI, Math.PI);
        c.footX = Math.cos(a);
        c.footY = Math.sin(a);
      }
      jumpT -= dt;
      if (jumpT <= 0 && S.world) {
        jumpT = rng.range(B.chaosTeleportMinS, B.chaosTeleportMaxS);
        if (canDrive(S)) {
          var W = S.world;
          var lane = W.lanes[rng.int(W.lanes.length)];
          var at = TLV.world.lanes.pointAt(W, lane.id, rng.next() * lane.len, {});
          TLV.player.setPose(S, at.x, at.y, at.h, rng.range(0, 12));
        }
      }
      return c;
    };
  }

  /** Bay coordinates of a point: a along the bay's axis, l to its left. */
  function bayFrame(spot, x, y, out) {
    var c = Math.cos(spot.h);
    var s = Math.sin(spot.h);
    var ex = x - spot.x;
    var ey = y - spot.y;
    out.x = ex * c + ey * s;
    out.y = -ex * s + ey * c;
  }

  /** The last metres into a bay: along the lane past the car behind, then into the funnel, then stop. */
  function parkRun(S, d, spot, c) {
    var T = TLV.tune.player;
    var B = T.bot;
    var veh = S.player.veh;
    var at = d.pt;
    bayFrame(spot, veh.x, veh.y, at);
    var a = at.x;
    var l = at.y;
    var side = l >= 0 ? 1 : -1;
    // The aim point runs at the car's lateral offset until the dive, then to the funnel's near edge.
    var aim = a + B.parkLookM;
    var share = TLV.math.clamp((aim - B.parkDiveA) / B.parkLookM, 0, 1);
    var wantL = l + (side * B.parkDiveL - l) * share;
    var bc = Math.cos(spot.h);
    var bs = Math.sin(spot.h);
    steerAt(veh, spot.x + aim * bc - wantL * bs, spot.y + aim * bs + wantL * bc, c);
    var want = B.parkApproachV;
    if (a > B.parkDiveA) want = Math.sqrt(2 * T.brake * Math.max(0, B.parkStopA - a) * 0.6);
    pedals(veh, want, c);
  }

  /** Picks a heading for a person: straight at the door if clear, else the nearest clear bearing. */
  function footBearing(S, f, tx, ty, memo) {
    var B = TLV.tune.player.bot;
    var W = S.world;
    var ray = TLV.world.spatial.rayBlocked;
    var dx = tx - f.x;
    var dy = ty - f.y;
    var dist = Math.sqrt(dx * dx + dy * dy) || 1;
    var direct = Math.atan2(dy, dx);
    var reach = Math.min(B.footProbeM, dist);
    if (memo.t <= 0 && !ray(W, f.x, f.y, f.x + Math.cos(direct) * reach, f.y + Math.sin(direct) * reach)) return direct;
    if (memo.t > 0) return memo.h;
    for (var k = 1; k <= 8; k++) {
      for (var sign = -1; sign <= 1; sign += 2) {
        var h = direct + sign * k * Math.PI / 8;
        if (!ray(W, f.x, f.y, f.x + Math.cos(h) * B.footProbeM, f.y + Math.sin(h) * B.footProbeM)) {
          memo.h = h;
          memo.t = B.footStuckS;
          return h;
        }
      }
    }
    return direct;
  }

  /** `errands`: plays full errands, parks, steals bays, presses E at 1.0 s, and runs to the door. */
  function errands() {
    var B = TLV.tune.player.bot;
    var T = TLV.tune.player;
    var c = newControls();
    var d = newDriver();
    var wander = patrol();
    var memo = { h: 0, t: 0 };
    var lastBay = -1;
    var bayT = 0;
    var knifeSide = false;

    function fallBack(S) {
      var out = wander(S);
      c.throttle = out.throttle;
      c.brake = out.brake;
      c.steer = out.steer;
      c.recover = out.recover;
      return c;
    }

    function parkBadly(S, g) {
      var e = g.errand;
      var veh = S.player.veh;
      if (!e) return false;
      var dx = e.doorX - veh.x;
      var dy = e.doorY - veh.y;
      var reach = g.errandIndex === B.finaleIndex ? B.doubleParkFinaleM : B.doubleParkDoorM;
      if (dx * dx + dy * dy > reach * reach) return false;
      pedals(veh, 0, c);
      if (Math.abs(veh.v) < 0.2) c.hazard = true;
      return true;
    }

    function chase(S, g) {
      var k = g.knife;
      var f = S.player.foot;
      var e = g.errand;
      if (!k) return;
      if (k.stage === 'DOOR_TUG' && k.stageT >= B.tugPressS) c.interact = true;
      if (k.stage !== 'CHASE' || S.player.mode !== 'FOOT' || !e) return;
      memo.t -= TLV.const.DT;
      var h = footBearing(S, f, e.doorX, e.doorY, memo);
      c.footX = Math.cos(h);
      c.footY = Math.sin(h);
      var windup = k.lunge === 'WINDUP';
      c.sidestep = windup && !knifeSide;
      knifeSide = windup;
    }

    function park(S, g) {
      var W = S.world;
      var veh = S.player.veh;
      var stage = g.park.stage;
      var e = g.errand;
      if (stage === 'SNAP' || stage === 'FILL') return true;
      if (stage === 'ARMED') {
        c.steer = 0;
        c.brake = Math.abs(veh.v) > T.restSpeed ? B.parkArmedBrake : 0;
        return true;
      }
      if (!e || e.bayId !== lastBay) {
        lastBay = e ? e.bayId : -1;
        bayT = 0;
      }
      var spot = e && e.bayId >= 0 ? TLV.world.parking.spot(W, e.bayId) : null;
      if (!spot) return parkBadly(S, g);
      if (!(g.nav.remaining <= B.parkApproachM)) return false;
      bayT += TLV.const.DT;
      if (bayT > B.parkRetryS) return parkBadly(S, g);
      // The last metres leave the route, so they wait until the car is on the bay's own stretch of road. A bay just round a
      // corner would otherwise be aimed at through the building on the corner.
      bayFrame(spot, veh.x, veh.y, d.pt);
      var off = Math.abs(TLV.math.wrapPi(veh.h - spot.h));
      if (off > B.parkAlignRad || Math.abs(d.pt.y) > B.parkAlignL || d.pt.x > B.parkStopA + 2) return false;
      parkRun(S, d, spot, c);
      return true;
    }

    return function (S) {
      rest(c);
      restart(S, c);
      var g = S.game;
      if (!S.world) return c;
      if (!g) return fallBack(S);
      if (g.phase === 'ENCOUNTER') {
        chase(S, g);
        return c;
      }
      var driving = g.phase === 'DRIVE' || g.phase === 'SEARCH' || g.phase === 'HOLD';
      if (!driving || !canDrive(S)) return c;
      // A Q hold is under way: anything but holding still and holding Q would cancel it.
      if (g.phase === 'HOLD' && g.park.kind && g.park.kind !== 'BAY') {
        c.hazard = true;
        return c;
      }
      var route = g.nav && g.nav.route;
      if (!route) {
        if (parkBadly(S, g)) return c;
        return fallBack(S);
      }
      if (route !== d.route) attach(S, d, route);
      track(S, d);
      d.waiting = false;
      if (park(S, g)) return c;
      rescan(S, d);
      steerAlong(S, d, c);
      var veh = S.player.veh;
      var want = roadSpeed(S, d, veh.v);
      var follow = followLimit(d);
      if (follow < want) want = follow;
      if (g.nav.remaining <= B.parkApproachM && want > B.parkApproachV) want = B.parkApproachV;
      if (!unstick(S, d, c, TLV.const.DT, null)) pedals(veh, want, c);
      return c;
    };
  }

  /** `idle`: no input at all. */
  function idle() {
    var c = newControls();
    return function () {
      return c;
    };
  }

  bots._hasUTurn = hasUTurn;

  /**
   * Creates a control source.
   * @param {string} name 'idle', 'patrol', 'chaos', 'braker' or 'errands'.
   * @param {object} [opts] braker takes reactionS, which fixes t_r.
   * @returns {function(object):object} controlSource(S) -> ControlState. An unknown name warns and gives idle.
   */
  bots.create = function (name, opts) {
    switch (name) {
      case 'patrol': return patrol();
      case 'chaos': return chaos();
      case 'braker': return braker(opts);
      case 'errands': return errands();
      case 'idle': return idle();
      default:
        console.warn('TLV.bots: unknown bot ' + name + ', using idle');
        return idle();
    }
  };
})(window.TLV);
