// js/sim/peds/riders.js — WP-PEDS
// Two-wheelers, and anyone else moving along a lane. Riders are Pedestrian records, so every person rule applies to them: the
// fairness gate, lane obstacles, and every hit a player.hitPed. On sidewalks they use walk.js at their own speed. What is theirs is
// the bell, the wrong-way ride and the pop off the kerb.
(function (TLV) {
  'use strict';

  var riders = TLV.ns('peds.riders');

  /** @returns {boolean} True when a person rides. */
  function isRider(p) {
    return p.kind === 'scooter' || p.kind === 'delivery';
  }
  riders.isRider = isRider;

  /**
   * Rings the bell near the player, now and then. The cue for a rider coming along a sidewalk, or the wrong way down a lane.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {number} dt Seconds since the last think.
   */
  riders.bell = function (S, p, dt) {
    var P = p._p;
    var T = TLV.tune.peds;
    P.bellT -= dt;
    if (P.bellT > 0) return;
    var dx = p.x - S.player.fx;
    var dy = p.y - S.player.fy;
    if (dx * dx + dy * dy > T.bellNearM * T.bellNearM) return;
    P.bellT = T.bellEveryS;
    S.bus.emit('ped.bell', { pedId: p.id });
  };

  /**
   * Steps from the kerb onto the lane chosen for a stroll or a wrong-way ride.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   */
  riders.enterLane = function (S, p) {
    var P = p._p;
    var T = TLV.tune.peds;
    var at = S.pedsys.pt;
    var x = TLV.world.lanes.pointAt(S.world, P.laneId, P.laneS, at);
    P.stage = 'NONE';
    P.speed = isRider(p) ? P.base : T.approach;
    TLV.peds.walk.goTo(p, x.x - Math.sin(x.h) * P.laneLat, x.y + Math.cos(x.h) * P.laneLat, 'LANE');
  };

  /** Ends a ride or stroll: off the road, and an ordinary walker again. */
  function leaveLane(S, p) {
    var P = p._p;
    P.job = 'AMBIENT';
    P.aim = null;
    P.hold = false;
    P.path = null;
    P.speed = P.base;
    P.crossCool = TLV.tune.peds.crossCoolS;
    TLV.peds.setState(p, 'WALK');
    TLV.peds.walk.toSidewalk(S, p);
  }

  /**
   * Seconds until a wrong-way rider meets an AI vehicle ahead of it, both still moving. walk.scan's TTC reads the vehicle alone, and
   * here the closing speed has the rider's in it.
   */
  function headOn(S, p) {
    var sys = S.pedsys;
    var T = TLV.tune.peds;
    var fx = Math.cos(p.h);
    var fy = Math.sin(p.h);
    var best = Infinity;
    for (var i = 0; i < sys.nearN; i++) {
      var v = sys.near[i];
      if (v.isPlayer) continue;
      var dx = v.x - p.x;
      var dy = v.y - p.y;
      var a = dx * fx + dy * fy;
      var l = dy * fx - dx * fy;
      if (a < 0 || Math.abs(l) > v.width / 2 + p.r + 0.4) continue;
      var closing = p.v + Math.max(0, -(Math.cos(v.h) * fx + Math.sin(v.h) * fy) * v.v);
      if (closing < 0.5) continue;
      var ttc = Math.max(0, a - v.length / 2 - p.r) / closing;
      if (ttc < best) best = ttc;
    }
    return best < T.salmonTtcS ? best : Infinity;
  }

  /**
   * One think moving along a lane, strolling or riding the wrong way.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {number} dt Seconds to the next think.
   */
  riders.stepLane = function (S, p, dt) {
    var W = S.world;
    var P = p._p;
    var T = TLV.tune.peds;
    var sys = S.pedsys;
    var walk = TLV.peds.walk;
    var lane = W.lanes[P.laneId];
    if (!lane) {
      leaveLane(S, p);
      return;
    }
    P.laneT += dt;
    var speed = P.speed;
    if (P.plan === 'SALMON') {
      if (P.aim) {
        var left = P.aim.tImpact - S.t;
        var d = TLV.math.dist(p.x, p.y, P.aim.x, P.aim.y);
        speed = left > 0.05 ? TLV.math.clamp(d / left, T.aimMinRider, P.base) : P.base;
      } else {
        speed = P.base;
      }
      // The rider gives way to AI cars, or at these closing speeds neither can stop. The player gets no such courtesy.
      if (P.aside || headOn(S, p) < T.salmonTtcS) {
        P.aside = true;
        // p.v is the last step over dt, way round a car included, so braking from that alone climbed: 6 m/s to 31 in six thinks.
        speed = Math.max(0, Math.min(p.v, P.base) - T.riderBrake * dt);
        if (speed < 0.5) {
          P.restT += dt;
          if (P.restT > 1) {
            leaveLane(S, p);
            return;
          }
        }
      }
      if (P.laneT > T.salmonMaxS) {
        leaveLane(S, p);
        return;
      }
    } else if (!P.aside) {
      // Strolling. A car on the lane makes them move aside, slowly, and get off it.
      for (var i = 0; i < sys.nearN; i++) {
        var v = sys.near[i];
        if (v.laneId !== P.laneId && !(v.connId >= 0 && W.conns[v.connId].to === P.laneId)) continue;
        if (TLV.math.dist(v.x, v.y, p.x, p.y) > T.strollWarnM) continue;
        P.aside = true;
        P.laneLatGoal = (P.laneLat >= 0 ? 1 : -1) * lane.width / 2;
        P.laneLeft = Math.min(P.laneLeft, T.strollSpeed * 3);
        break;
      }
    } else {
      speed = T.asideSpeed;
    }
    var step = speed * dt;
    P.laneS += P.laneDir * step;
    P.laneLeft -= step;
    var latStep = T.asideSpeed * dt;
    var want = P.laneLatGoal - P.laneLat;
    P.laneLat += want > latStep ? latStep : (want < -latStep ? -latStep : want);
    if (P.plan === 'STROLL' && P.laneLeft <= 0) {
      leaveLane(S, p);
      return;
    }
    if (P.laneS < 0 || P.laneS > lane.len) {
      leaveLane(S, p);
      return;
    }
    var at = TLV.world.lanes.pointAt(W, P.laneId, P.laneS, sys.pt);
    var nx = at.x - Math.sin(at.h) * P.laneLat;
    var ny = at.y + Math.cos(at.h) * P.laneLat;
    var out = sys.pt2;
    if (sys.nearN > 0 && walk.steer(S, p, p.x, p.y, nx, ny, step, out)) {
      nx = out.x;
      ny = out.y;
    }
    walk.aimAt(p, nx, ny, dt);
  };

  /** Readies a rider for a command. */
  function take(p, cmd) {
    var P = p._p;
    p.intent = false;
    P.job = 'CMD';
    P.aim = cmd.aim || null;
    P.hold = !!cmd.aim;
    P.recycle = false;
    P.force = false;
  }

  /**
   * SCOOTER_SALMON: rides against a one-way lane, on its own right, with the bell going.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {object} cmd Command.
   * @returns {boolean} False when this person cannot comply.
   */
  riders.salmon = function (S, p, cmd) {
    var W = S.world;
    var P = p._p;
    var T = TLV.tune.peds;
    var lane = W.lanes[cmd.laneId];
    if (!lane || !isRider(p)) return false;
    var at = S.pedsys.pt;
    var s = TLV.math.clamp(cmd.s, 0, lane.len);
    TLV.world.lanes.pointAt(W, lane.id, s, at);
    if (TLV.math.dist(p.x, p.y, at.x, at.y) > T.commandReachM) return false;
    take(p, cmd);
    P.path = null;
    P.plan = 'SALMON';
    P.laneId = lane.id;
    P.laneS = s;
    P.laneDir = -1;
    P.laneLat = lane.width / 2 - T.salmonEdgeM;
    P.laneLatGoal = P.laneLat;
    P.laneT = 0;
    P.laneLeft = Infinity;
    P.restT = 0;
    P.stage = 'WAIT';
    P.mode = 'PATH';
    P.waitT = 0;
    P.gateT = 0;
    TLV.peds.setState(p, 'WAIT_CROSS');
    return true;
  };

  /**
   * DELIVERY_POP: leaves the sidewalk into the road at a crossing, at speed.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   * @param {object} cmd Command.
   * @returns {boolean} False when this person cannot comply.
   */
  riders.pop = function (S, p, cmd) {
    if (!isRider(p)) return false;
    var path = TLV.peds.cross.pathOf(S, cmd.xingId);
    if (!path) return false;
    var T = TLV.tune.peds;
    var math = TLV.math;
    var dA = math.dist(p.x, p.y, path.x[0], path.y[0]);
    var dB = math.dist(p.x, p.y, path.x[path.n - 1], path.y[path.n - 1]);
    if (Math.min(dA, dB) > T.commandReachM) return false;
    take(p, cmd);
    TLV.peds.cross.start(S, p, path, dA <= dB ? 1 : -1, 'POP');
    return true;
  };
})(window.TLV);
