// js/sim/player/vehicle.js — WP-PLAYER
// The player's car: a kinematic bicycle with a separate velocity heading (GAME_DESIGN 4). TLV.player.update drives the car
// and reads the world. Contacts move it afterwards, in TLV.collide.update.
(function (TLV) {
  'use strict';

  var player = TLV.ns('player');

  var DEG = Math.PI / 180;
  var QUARTER = Math.PI / 2;

  /** @returns {object} The private half of PlayerState: every per-sim value this package keeps between ticks. */
  function newDynamics() {
    return {
      vh: 0,               // heading of the velocity vector
      steerN: 0,           // steering, -1..1, after attack and return
      hb: 0,               // handbrake blend, 1 held, falling to 0 over the recovery
      revT: 0,             // seconds the brake has been held at rest
      locked: false,       // the mode to fall back to after a snap
      surfWant: 0,         // surface under the car, not yet held long enough
      surfT: 0,
      hornOn: false,
      hornT: 0,
      waterT: -1e9,        // S.t of the last player.waterEdge
      dryX: 0, dryY: 0, dryH: 0,
      launchWin: 0,
      sigLane: -1,
      sigState: 0,
      wrongT: 0,
      stopLane: -1,
      lineJunc: -1,        // junction of the last stop line crossed
      lineT: -1,           // S.t until which its other lines do not count
      snap: { active: false, t: 0, dur: 0, x0: 0, y0: 0, h0: 0, mx: 0, my: 0, x1: 0, y1: 0, h1: 0, ghost: false, hold: false },
      lane: { laneId: -1, s: 0, lat: 0, dist: 0, headingErr: 0 },
      laneAny: { laneId: -1, s: 0, lat: 0, dist: 0, headingErr: 0 },
      at: { x: 0, y: 0, h: 0 }
    };
  }

  /** @returns {object} FootState (ARCHITECTURE 10.5). */
  function newFoot() {
    return {
      active: false, x: 0, y: 0, h: 0, v: 0, px: 0, py: 0, ph: 0,
      stumbleT: 0, invulnT: 0, slowT: 0, sidestepT: 0, sidestepCd: 0,
      anim: 'idle',
      _side: 1, _sidePrev: false, _brush: [], _r: { x: 0, y: 0 }
    };
  }

  /** @returns {{x:number,y:number,h:number}} The start pose: the spawn point, or a stand-in with no WP-GAME. */
  function startPose(S) {
    var errands = TLV.game && TLV.game.errands;
    if (errands && typeof errands.spawnPoint === 'function') {
      var sp = errands.spawnPoint(S);
      if (sp) return sp;
    }
    if (S.params && S.params.spawn) return S.params.spawn;
    var W = S.world;
    if (W) {
      var ai = TLV.const.LF.AI_ROUTABLE;
      for (var i = 0; i < W.lanes.length; i++) {
        if (W.lanes[i].flags & ai) return TLV.world.lanes.pointAt(W, i, W.lanes[i].len / 2, {});
      }
    }
    return { x: 0, y: 0, h: 0 };
  }

  /** Changes mode and tells whoever listens. */
  function setMode(S, mode) {
    if (S.player.mode === mode) return;
    S.player.mode = mode;
    S.bus.emit('player.mode', { mode: mode });
  }
  player._setMode = setMode;

  /**
   * Largest steering angle at a speed (GAME_DESIGN 4).
   * @param {number} speed m/s, not negative.
   * @returns {number} Radians.
   */
  player._steerMax = function (speed) {
    var T = TLV.tune.player;
    var share = Math.min(1, speed / T.steerRefSpeed);
    var blend = Math.pow(share, T.steerExp);
    return (T.steerMaxDeg + (T.steerMinDeg - T.steerMaxDeg) * blend) * DEG;
  };

  /** Sets every velocity field from a signed speed along the velocity heading. */
  function setSpeed(veh, d, v) {
    veh.v = v;
    veh.vx = v * Math.cos(d.vh);
    veh.vy = v * Math.sin(d.vh);
  }

  /**
   * Re-reads speed and velocity heading after something changed vx and vy. The signed speed is forward when the velocity
   * lies ahead of the car's nose, so a rebound off a wall reads as rolling backward.
   * @param {object} S Sim state.
   */
  player._syncVelocity = function (S) {
    var veh = S.player.veh;
    var d = S.player._d;
    var speed = Math.sqrt(veh.vx * veh.vx + veh.vy * veh.vy);
    if (speed < 1e-6) {
      veh.v = 0;
      veh.vx = 0;
      veh.vy = 0;
      d.vh = veh.h;
      return;
    }
    if (veh.vx * Math.cos(veh.h) + veh.vy * Math.sin(veh.h) >= 0) {
      veh.v = speed;
      d.vh = Math.atan2(veh.vy, veh.vx);
    } else {
      veh.v = -speed;
      d.vh = Math.atan2(-veh.vy, -veh.vx);
    }
  };

  /** @returns {number} Speed the surface and the map edge allow, m/s. */
  function speedCap(S, veh) {
    var T = TLV.tune.player;
    var SURF = TLV.const.SURF;
    var cap = T.topSpeed;
    var surface = S.player.surface;
    if (surface === SURF.SIDEWALK || surface === SURF.PARK) cap = T.capSidewalk;
    else if (surface === SURF.SAND) cap = T.capSand;
    var W = S.world;
    if (W) {
      var b = W.bounds;
      var edge = Math.min(veh.x - b.minX, b.maxX - veh.x, veh.y - b.minY, b.maxY - veh.y);
      if (edge < T.edgeBandM && T.capEdge < cap) cap = T.capEdge;
    }
    return cap;
  }

  /** Moves the steering toward its target at the attack or return rate. */
  function updateSteer(veh, d, steerIn, speed, dt) {
    var T = TLV.tune.player;
    var target = TLV.math.clamp(steerIn, -1, 1);
    var n = d.steerN;
    var growing = target !== 0 && (n === 0 || (target > 0) === (n > 0)) && Math.abs(target) > Math.abs(n);
    var step = dt / (growing ? T.steerAttackS : T.steerReturnS);
    n = target > n ? Math.min(target, n + step) : Math.max(target, n - step);
    d.steerN = n;
    veh.steer = n * player._steerMax(speed);
  }

  /** @returns {number} Yaw rate, rad/s, + counter-clockwise. */
  function yawRate(veh, d, speed) {
    var T = TLV.tune.player;
    var math = TLV.math;
    var kin = veh.v / veh.wheelbase * Math.tan(veh.steer);
    var grip = T.gripLat / (speed > 0.5 ? speed : 0.5);
    var w = math.clamp(kin, -grip, grip);
    if (d.hb > 0) {
      var swing = math.smoothstep(T.handbrakeYawLowV, T.handbrakeYawFullV, speed);
      var slide = d.steerN * T.handbrakeYaw * swing * (veh.v >= 0 ? 1 : -1);
      w += (slide - w) * d.hb;
    }
    return w;
  }

  /** @returns {number} Acceleration asked of the car this tick, m/s², before any cap. */
  function driveForce(S, veh, d, throttle, brake, handbrake, cap, dt) {
    var T = TLV.tune.player;
    var v = veh.v;
    if (handbrake) {
      d.revT = 0;
      if (Math.abs(v) <= T.restSpeed) return -v / dt;
      return v > 0 ? -T.handbrakeDrag : T.handbrakeDrag;
    }
    var a = 0;
    if (v < -T.restSpeed && throttle > 0) {
      // Throttle while rolling backward is a brake, as is the brake while rolling forward.
      d.revT = 0;
      a = T.brake * throttle;
    } else if (brake > 0 && v > T.restSpeed) {
      d.revT = 0;
      a = -T.brake * brake;
    } else if (brake > 0 && throttle <= 0) {
      if (v > -T.restSpeed && d.revT < T.reverseDelayS) {
        d.revT += dt;
        return -v / dt;
      }
      if (v > -T.reverseSpeed) a = -T.reverseAccel * brake;
    } else if (throttle > 0) {
      d.revT = 0;
      if (v < cap) {
        var push = T.accelBase * (1 - Math.max(v, 0) / T.accelFadeV);
        if (S.player.launchT > 0) push *= 1 + T.launchBoost;
        a = push * throttle;
      }
    } else {
      d.revT = 0;
    }
    var coast = 1 - Math.max(throttle, brake);
    if (coast > 0) {
      var drag = T.coastDrag * coast;
      if (v > 0) a -= drag;
      else if (v < 0) a += drag;
    }
    return a;
  }

  /** @returns {number} Acceleration of a locked car: full brake to rest, then nothing. */
  function lockedForce(veh, dt) {
    var T = TLV.tune.player;
    if (Math.abs(veh.v) <= T.brake * dt) return -veh.v / dt;
    return veh.v > 0 ? -T.brake : T.brake;
  }

  /** Applies the acceleration, without letting drag cross zero, and holds speed under the caps. */
  function integrateSpeed(veh, a, cap, dt) {
    var T = TLV.tune.player;
    var v = veh.v;
    var next = v + a * dt;
    if (a !== 0 && v !== 0 && (v > 0) !== (next > 0) && (a > 0) !== (v > 0)) {
      // A force against the motion stops the car. Only a held control carries it past rest, and that returns next tick.
      next = 0;
    }
    if (next > cap) next = Math.max(cap, Math.min(next, v) - T.capDecel * dt);
    if (next < -T.reverseSpeed) next = -T.reverseSpeed;
    return next;
  }

  /** The Green Launch window and the boost it pays for (GAME_DESIGN 4). */
  function updateLaunch(S, veh, d, throttle, dt) {
    var T = TLV.tune.player;
    var p = S.player;
    var W = S.world;
    var GREEN = TLV.const.SIG.GREEN;
    var lane = W && p.laneId >= 0 ? W.lanes[p.laneId] : null;
    var near = !!lane && lane.conns.length > 0 && lane.len - veh.s <= T.launchRangeM && Math.abs(d.lane.headingErr) < QUARTER;
    var state = near ? TLV.world.signals.laneState(S, lane.id) : GREEN;
    if (near && d.sigLane === lane.id && d.sigState !== GREEN && state === GREEN && Math.abs(veh.v) <= T.launchStopV) {
      d.launchWin = T.launchWindowS;
    }
    d.sigLane = near ? lane.id : -1;
    d.sigState = state;
    if (p.launchT > 0) {
      p.launchT -= dt;
      if (p.launchT < 0) p.launchT = 0;
    }
    if (d.launchWin > 0) {
      if (throttle >= T.launchThrottle && p.mode === 'DRIVE') {
        d.launchWin = 0;
        p.launchT = T.launchS;
        S.bus.emit('player.launch', {});
      } else {
        d.launchWin -= dt;
      }
    }
  }

  /** player.horn on the rising edge and each second held (ARCHITECTURE 11). */
  function updateHorn(S, veh, d, on, dt) {
    veh.horn = on;
    if (on) {
      if (!d.hornOn || d.hornT <= 0) {
        d.hornT = TLV.tune.player.hornRepeatS;
        S.bus.emit('player.horn', { x: veh.x, y: veh.y, h: veh.h });
      }
      d.hornT -= dt;
    }
    d.hornOn = on;
  }

  /** The driven tick: controls to steering, speed and heading. */
  function drive(S, veh, d, controls, dt) {
    var T = TLV.tune.player;
    var VL = TLV.const.VL;
    var driving = S.player.mode === 'DRIVE';
    var throttle = driving ? TLV.math.clamp(controls.throttle, 0, 1) : 0;
    var brake = driving ? TLV.math.clamp(controls.brake, 0, 1) : 0;
    var steerIn = driving ? controls.steer : 0;
    var handbrake = driving && !!controls.handbrake;
    var speed = Math.abs(veh.v);

    updateLaunch(S, veh, d, throttle, dt);
    updateHorn(S, veh, d, driving && !!controls.horn, dt);
    updateSteer(veh, d, steerIn, speed, dt);

    if (handbrake) d.hb = 1;
    else if (d.hb > 0) d.hb = Math.max(0, d.hb - dt / T.handbrakeRecoveryS);

    var w = yawRate(veh, d, speed);
    veh.yawRate = w;
    veh.h = TLV.math.wrapPi(veh.h + w * dt);

    var before = veh.v;
    var cap = speedCap(S, veh);
    // A locked car only comes to rest. It must not read as a held brake, which turns into reverse.
    var a = driving ? driveForce(S, veh, d, throttle, brake, handbrake, cap, dt) : lockedForce(veh, dt);
    var v = integrateSpeed(veh, a, cap, dt);
    veh.accel = (v - before) / dt;

    var k = T.velLerp + (T.velLerpHandbrake - T.velLerp) * d.hb;
    d.vh = TLV.math.wrapPi(d.vh + TLV.math.wrapPi(veh.h - d.vh) * (1 - Math.exp(-k * dt)));
    setSpeed(veh, d, v);
    veh.x += veh.vx * dt;
    veh.y += veh.vy * dt;

    var lights = 0;
    if ((brake > 0 && v > T.restSpeed) || (throttle > 0 && v < -T.restSpeed) || handbrake || !driving) lights |= VL.BRAKE;
    if (v < -T.restSpeed || (brake > 0 && v < 0)) lights |= VL.REVERSE;
    if (driving && controls.hazard) lights |= VL.HAZARD;
    veh.lights = lights;
  }

  /** Ends a snap, leaving the car at rest on the mode it asked for. */
  function endSnap(S, veh, d) {
    var sn = d.snap;
    sn.active = false;
    veh.x = sn.x1;
    veh.y = sn.y1;
    veh.h = sn.h1;
    d.vh = sn.h1;
    d.steerN = 0;
    d.hb = 0;
    veh.steer = 0;
    veh.yawRate = 0;
    veh.accel = 0;
    setSpeed(veh, d, 0);
    if (sn.hold) d.locked = true;
    setMode(S, d.locked ? 'LOCKED' : 'DRIVE');
  }

  /** The scripted tick: a Hermite blend of the pose, with the velocity fields read back from it for render. */
  function snapStep(S, veh, d, dt) {
    var sn = d.snap;
    var math = TLV.math;
    sn.t += dt;
    if (sn.t >= sn.dur) {
      endSnap(S, veh, d);
      return;
    }
    var u = sn.t / sn.dur;
    var u2 = u * u;
    var u3 = u2 * u;
    var h01 = 3 * u2 - 2 * u3;
    var h10 = u3 - 2 * u2 + u;
    var x = sn.x0 + (sn.x1 - sn.x0) * h01 + sn.mx * h10;
    var y = sn.y0 + (sn.y1 - sn.y0) * h01 + sn.my * h10;
    var dx = x - veh.x;
    var dy = y - veh.y;
    veh.vx = dx / dt;
    veh.vy = dy / dt;
    var speed = Math.sqrt(veh.vx * veh.vx + veh.vy * veh.vy);
    veh.x = x;
    veh.y = y;
    var h = math.wrapPi(sn.h0 + math.wrapPi(sn.h1 - sn.h0) * h01);
    veh.yawRate = math.wrapPi(h - veh.h) / dt;
    veh.h = h;
    d.vh = h;
    veh.v = dx * Math.cos(h) + dy * Math.sin(h) >= 0 ? speed : -speed;
    veh.lights = 0;
    veh.horn = false;
  }

  /**
   * Finds the lane under the car, its surface and whether it is against traffic. ARCHITECTURE 10.5.
   * Two queries: the lane in the direction of travel holds laneId, and the plain nearest one says if this is the wrong way,
   * since on a two-way road a lane in travel direction is always in reach.
   */
  function readWorld(S, veh, d, dt) {
    var W = S.world;
    var p = S.player;
    if (!W) return;
    var T = TLV.tune.player;
    var lanes = TLV.world.lanes;
    var math = TLV.math;

    var near = lanes.project(W, veh.x, veh.y, veh.h, T.laneReachM, d.lane);
    if (near) {
      p.laneId = near.laneId;
      p.lat = near.lat;
      veh.laneId = near.laneId;
      veh.lat = near.lat;
      veh.s = near.s;
    } else {
      p.laneId = -1;
      p.lat = 0;
      veh.laneId = -1;
      veh.lat = 0;
      veh.s = 0;
      d.lane.laneId = -1;
      d.lane.headingErr = 0;
    }
    veh.connId = -1;

    var surface = TLV.world.surface.at(W, veh.x, veh.y);
    if (surface === p.surface) {
      d.surfWant = surface;
      d.surfT = 0;
    } else {
      if (d.surfWant !== surface) {
        d.surfWant = surface;
        d.surfT = 0;
      }
      d.surfT += dt;
      if (d.surfT >= T.surfaceHoldS) {
        p.surface = surface;
        d.surfT = 0;
        S.bus.emit('player.surface', { surface: surface });
      }
    }

    var against = false;
    var anyLane = lanes.project(W, veh.x, veh.y, null, T.laneReachM, d.laneAny);
    var moving = veh.v >= T.wrongWayMinV || (p.wrongWay && veh.v > 0.2);
    if (anyLane && moving && anyLane.dist <= W.lanes[anyLane.laneId].width / 2 + 0.3) {
      var at = lanes.pointAt(W, anyLane.laneId, anyLane.s, d.at);
      var off = Math.abs(math.wrapPi(d.vh - at.h));
      against = off >= (p.wrongWay ? T.wrongWayOffDeg : T.wrongWayOnDeg) * DEG;
    }
    if (against === p.wrongWay) {
      d.wrongT = 0;
    } else {
      d.wrongT += dt;
      if (d.wrongT >= T.wrongWayHoldS) {
        d.wrongT = 0;
        p.wrongWay = against;
        S.bus.emit('player.wrongWay', { on: against });
      }
    }
  }

  /**
   * player.redRun: watches the stop line ahead of the car until its centre crosses it (ARCHITECTURE 12.4).
   * The line is the lane's last point. The watch holds the lane itself, since past that point no query returns it.
   */
  function watchStopLine(S, veh, d) {
    var W = S.world;
    if (!W) return;
    var T = TLV.tune.player;
    var lane = d.stopLane >= 0 ? W.lanes[d.stopLane] : null;
    if (lane) {
      var n = lane.px.length;
      var ex = lane.px[n - 1];
      var ey = lane.py[n - 1];
      var ux = ex - lane.px[n - 2];
      var uy = ey - lane.py[n - 2];
      var len = Math.sqrt(ux * ux + uy * uy) || 1;
      ux /= len;
      uy /= len;
      var along = (veh.x - ex) * ux + (veh.y - ey) * uy;
      if (along >= 0) {
        var side = Math.abs(-(veh.x - ex) * uy + (veh.y - ey) * ux);
        var junc = TLV.world.junctions.ahead(W, lane.id);
        // A car crossing a junction also passes the ends of its other approaches, and only the first line it met counts.
        var inside = junc === d.lineJunc && S.t < d.lineT;
        var red = TLV.world.signals.laneState(S, lane.id) === TLV.const.SIG.RED;
        if (!inside && red && veh.v > 0 && side <= lane.width / 2 + T.stopLineLatPad) {
          S.bus.emit('player.redRun', { juncId: junc });
        }
        d.lineJunc = junc;
        d.lineT = S.t + T.stopLineHoldS;
        d.stopLane = -1;
      } else if (along < -T.stopLineWatchM - 2) {
        d.stopLane = -1;
      }
    }
    // Armed only from on the lane and before its end. In a junction the nearest lane is whatever road ends close by, and
    // past the line a projection clamps to the end, which reads as still being there.
    var cur = S.player.laneId;
    if (cur < 0 || cur === d.stopLane) return;
    var near = W.lanes[cur];
    var left = near.len - veh.s;
    if (near.conns.length === 0 || left > T.stopLineWatchM || left <= 0.05) return;
    if (Math.abs(d.lane.lat) > near.width / 2 + T.stopLineLatPad) return;
    if (Math.abs(d.lane.headingErr) > T.stopLineArmDeg * DEG) return;
    d.stopLane = cur;
  }

  /**
   * Creates S.player, activates slot 0 and places the car.
   * @param {object} S Sim state.
   */
  player.init = function (S) {
    var veh = S.vehicles[0];
    var size = TLV.const.VEHICLE_SIZES.hatch;
    veh.id = 0;
    veh.active = true;
    veh.isPlayer = true;
    veh.mode = 'FREE';
    veh.kind = 'hatch';
    veh.variant = 0;
    veh.length = size.length;
    veh.width = size.width;
    veh.wheelbase = size.wheelbase;
    veh.ag = 0;
    veh.beh = 'CRUISE';
    veh.laneId = -1;
    veh.connId = -1;
    S.player = {
      mode: 'DRIVE', veh: veh, fx: 0, fy: 0,
      surface: TLV.const.SURF.ROAD, laneId: -1, lat: 0, wrongWay: false, launchT: 0,
      /** S.t of the last touch of anything solid, however soft. The tow offer reads it. */
      touchT: -1e9,
      foot: newFoot(),
      _d: newDynamics(),
      _c: TLV.collide._newScratch()
    };
    var at = startPose(S);
    player.setPose(S, at.x, at.y, at.h, 0);
  };

  /**
   * Tick row 8. Returns at once on foot.
   * @param {object} S Sim state.
   * @param {number} dt Tick, seconds.
   */
  player.update = function (S, dt) {
    var p = S.player;
    if (p.mode === 'FOOT') return;
    var veh = p.veh;
    var d = p._d;
    if (p.mode === 'SNAP') snapStep(S, veh, d, dt);
    else drive(S, veh, d, S.controls, dt);
    p.fx = veh.x;
    p.fy = veh.y;
    readWorld(S, veh, d, dt);
    if (p.mode !== 'SNAP') watchStopLine(S, veh, d);
  };

  /**
   * Teleports. On foot this moves the person; in the car it moves the car and cancels any snap.
   * @param {object} S Sim state.
   * @param {number} x East, metres.
   * @param {number} y North, metres.
   * @param {number} h Heading, radians.
   * @param {number} [v=0] Signed speed along h.
   */
  player.setPose = function (S, x, y, h, v) {
    var p = S.player;
    if (p.mode === 'FOOT') {
      var f = p.foot;
      f.x = x; f.y = y; f.h = h;
      f.px = x; f.py = y; f.ph = h;
      f.v = 0;
      p.fx = x;
      p.fy = y;
      return;
    }
    var veh = p.veh;
    var d = p._d;
    var speed = v === undefined ? 0 : v;
    TLV.collide._leftBodies(S);
    veh.x = x; veh.y = y; veh.h = h;
    veh.px = x; veh.py = y; veh.ph = h;
    d.vh = h;
    d.steerN = 0;
    d.hb = 0;
    d.revT = 0;
    d.launchWin = 0;
    d.stopLane = -1;
    d.lineJunc = -1;
    d.sigLane = -1;
    d.wrongT = 0;
    d.dryX = x; d.dryY = y; d.dryH = h;
    veh.steer = 0;
    veh.yawRate = 0;
    veh.accel = 0;
    veh.lights = 0;
    veh.horn = false;
    setSpeed(veh, d, speed);
    p.fx = x;
    p.fy = y;
    if (d.snap.active) {
      d.snap.active = false;
      if (d.snap.hold) d.locked = true;
      setMode(S, d.locked ? 'LOCKED' : 'DRIVE');
    }
    if (S.world) {
      p.surface = TLV.world.surface.at(S.world, x, y);
      d.surfWant = p.surface;
      d.surfT = 0;
      p.wrongWay = false;
      readWorld(S, veh, d, 0);
    }
  };

  /**
   * Blends the car to a pose over time. Mode is SNAP, then LOCKED with opts.hold, else DRIVE. It ends at rest.
   * @param {object} S Sim state.
   * @param {number} x East, metres.
   * @param {number} y North, metres.
   * @param {number} h Heading, radians.
   * @param {number} durS Seconds. Zero or less jumps there at once.
   * @param {{ghost?: boolean, hold?: boolean}} [opts] ghost switches contacts off for the snap, because a car parked between
   *   two others cannot steer out. See ARCHITECTURE 10.9, pull-out rule.
   */
  player.snapTo = function (S, x, y, h, durS, opts) {
    var p = S.player;
    if (p.mode === 'FOOT') return;
    var veh = p.veh;
    var d = p._d;
    var sn = d.snap;
    var o = opts || {};
    var dur = durS > 0 ? durS : 0;
    sn.active = true;
    sn.t = 0;
    sn.dur = dur;
    sn.x0 = veh.x; sn.y0 = veh.y; sn.h0 = veh.h;
    sn.x1 = x; sn.y1 = y; sn.h1 = h;
    sn.ghost = !!o.ghost;
    sn.hold = !!o.hold;
    // The car arrives carrying its speed, limited to the distance left, so a blend never overshoots its target.
    var chord = Math.sqrt((x - veh.x) * (x - veh.x) + (y - veh.y) * (y - veh.y));
    var speed = Math.sqrt(veh.vx * veh.vx + veh.vy * veh.vy);
    var scale = speed > 0 ? Math.min(dur, chord / speed) : 0;
    sn.mx = veh.vx * scale;
    sn.my = veh.vy * scale;
    if (dur <= 0) {
      endSnap(S, veh, d);
      veh.px = veh.x; veh.py = veh.y; veh.ph = veh.h;
      d.dryX = x; d.dryY = y; d.dryH = h;
      return;
    }
    setMode(S, 'SNAP');
  };

  /**
   * Locks or unlocks driving controls. A locked car brakes to rest. During a snap this sets the mode the snap ends on.
   * @param {object} S Sim state.
   * @param {boolean} locked True to lock.
   */
  player.setLocked = function (S, locked) {
    var p = S.player;
    var d = p._d;
    d.locked = !!locked;
    if (d.snap.active && !locked) d.snap.hold = false;
    if (p.mode === 'DRIVE' || p.mode === 'LOCKED') setMode(S, locked ? 'LOCKED' : 'DRIVE');
  };

  /**
   * @param {object} S Sim state.
   * @returns {boolean} True when |v| < 0.2.
   */
  player.isStopped = function (S) {
    return Math.abs(S.player.veh.v) < 0.2;
  };

  /**
   * Straight-line prediction of the focus point.
   * @param {object} S Sim state.
   * @param {number} seconds Seconds ahead.
   * @param {{x:number,y:number}} [out] Written and returned.
   * @returns {{x:number,y:number}} Point.
   */
  player.projected = function (S, seconds, out) {
    var r = out || { x: 0, y: 0 };
    var p = S.player;
    if (p.mode === 'FOOT') {
      r.x = p.foot.x + Math.cos(p.foot.h) * p.foot.v * seconds;
      r.y = p.foot.y + Math.sin(p.foot.h) * p.foot.v * seconds;
    } else {
      r.x = p.veh.x + p.veh.vx * seconds;
      r.y = p.veh.y + p.veh.vy * seconds;
    }
    return r;
  };

  /** Soak gate for this package: no pose inside a solid building. */
  function solidCheck(S) {
    var W = S.world;
    if (!W) return null;
    var p = S.player;
    var onFoot = p.mode === 'FOOT';
    var x = onFoot ? p.foot.x : p.veh.x;
    var y = onFoot ? p.foot.y : p.veh.y;
    if (TLV.collide._inSolid(W, x, y)) {
      return (onFoot ? 'foot' : 'car') + ' centre inside a building at ' + x.toFixed(1) + ', ' + y.toFixed(1);
    }
    return null;
  }

  /** Registers the debug hooks of ARCHITECTURE 16.2 and this package's invariant. */
  player.register = function () {
    TLV.debug.register('teleport', function (x, y, h, v) {
      var S = TLV.debug.current();
      if (!S) return false;
      player.setPose(S, x, y, h === undefined ? 0 : h, v === undefined ? 0 : v);
      return true;
    });
    TLV.debug.register('setPlayerMode', function (mode) {
      var S = TLV.debug.current();
      if (!S) return false;
      var p = S.player;
      if (mode === 'FOOT') {
        if (p.mode !== 'FOOT') TLV.foot.enter(S, p.veh.x, p.veh.y, p.veh.h);
      } else {
        if (p.mode === 'FOOT') TLV.foot.exit(S);
        if (mode === 'LOCKED') player.setLocked(S, true);
        else if (mode === 'DRIVE') player.setLocked(S, false);
        else return false;
      }
      return p.mode;
    });
    TLV.invariants.register('player.solid', solidCheck);
  };
})(window.TLV);
