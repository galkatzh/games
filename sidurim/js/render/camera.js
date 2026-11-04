// js/render/camera.js — WP-RENDER (RENDER-ACTORS)
// The chase camera, the parking camera, the on-foot camera and the knife's cuts (GAME_DESIGN 18, 15.1, 16). Every rig produces an
// eye, a look point and a field of view, and a blend runs between rigs. Reads only the fields of ARCHITECTURE 15.1. Writes nothing to S.
(function (TLV) {
  'use strict';

  var camera = TLV.ns('render.camera');

  var DEG = Math.PI / 180;

  // -- Numbers. The rows of GAME_DESIGN 18 keep their values here. ----------------------------------------------------------------------
  var Q = {
    stopDist: 6.5, stopHeight: 2.6, stopLook: 2.5, stopFov: 62,
    topDist: 8.5, topHeight: 3.2, topLook: 14, topFov: 82,
    speedRate: 2.4,          // per second, so pull-back and field of view swell behind the throttle
    launchDist: 0.7,         // extra metres behind a hard launch, Crazy Taxi's stretch
    launchRate: 3,
    lookZ: 1.0,
    yawOmega: 5,             // per second
    lagMaxRad: 14 * DEG,
    driftBias: 0.7,          // share of the slip angle the camera follows, so a slide shows
    driftMinV: 4,
    reverseS: 0.6,           // a reverse view flips only after this long above reverseV
    reverseV: 2,
    searchHeight: 1.4,       // GAME_DESIGN 12: the camera rises in SEARCH
    searchDist: 0.8,
    searchLookZ: -0.2,
    searchRate: 1.6,
    parkHeight: 14,
    parkPitchRad: 62 * DEG,
    parkFov: 60,
    parkBlendS: 0.8,
    parkRangeM: 20,          // owner's decision over GAME_DESIGN 18's 30: farther out the bay is off the top of this frame, and the chase view shows it better
    parkShowM: 11.5,         // where the car must be as the blend lands for the whole box to sit under the clock, so a slow car opens the view later than parkRangeM
    parkLeaveM: 28,
    parkForceM: 76,          // a view forced with C holds to here, and a press beyond it is refused
    parkMaxV: 12,
    parkLeaveV: 15,
    parkAhead: 4,            // the lens leads the car, so the bay comes into frame before it is under the clock. Past about 4 the car meets the toast and prompt
    parkYawOmega: 3,
    footDist: 4.5, footHeight: 2.2, footLook: 4, footFov: 70,
    footYawOmega: 2.6,
    footLookZ: 1.25,
    footBlendS: 0.35,
    tailRangeM: 5,           // anything under this behind raises the camera and ghosts
    tailLateralM: 1.9,
    tailSameWay: 0.7,        // cosine: a car within about 45 degrees of the player's line counts as following
    tailHoldS: 0.5,
    tailRaise: 0.6,
    tailRate: 5,
    occludeRangeM: 16,       // a car between the camera and the player ghosts too, for the same reason
    occludeMaxShare: 0.35,   // unless it would fill more of the frame than this: a bus crossing at the lens reads better solid, for a moment, than as a hatched sheet
    bodyH: { bus: 3.2, truck: 3.3, van: 2.2 },   // metres, for that sum. Anything else is about carH
    carH: 1.5,
    armMinM: 2.8,
    armInRate: 26,
    armOutRate: 2.6,
    armSteps: 5,
    armPad: 0.45,
    armLiftK: 0.28,          // height added per metre the arm has shrunk, so the car stays clear of the wall
    shakeM: 0.25,            // GAME_DESIGN 18: 0.25 m * severity
    shakeDecayS: 0.25,
    shakeHz: 27,
    joltM: 0.05,
    pulseDeg: 7,             // near miss
    pulseDecayS: 0.32,
    standoffBearings: 24,    // the shot is searched for, round the two cars and the man
    standoffRanges: [8, 9.5, 12],
    standoffHeights: [2.4, 3.0, 3.8],   // over a parked roof, and as low as that allows
    standoffScanM: 24,
    standoffLookZ: 0.95,
    standoffFovMin: 44,
    standoffFovMax: 62,
    standoffFit: 1.22,       // margin round what must stay in frame
    standoffRangeBest: 9.5,
    standoffTrunkM: 6,
    standoffFrameTan: 0.7,   // half width of the frame, as a tangent, for what counts as in shot
    standoffSpreadRad: 20 * DEG,   // both cars side by side on screen, not stacked
    standoffFallbackZ: 7,
    tugRanges: [5.9, 7.5, 9.5, 3.2],     // from the door. The last is for a lens hemmed in by a wall
    tugRangeBest: 5.9,
    tugNearCost: 8,
    tugAngles: [30, 15, 45, 0, 60, 75, 90],   // degrees off square to the car, either way along it
    tugHeights: [1.5, 2.4, 3.2, 4.2],
    tugHeight: 1.5,
    tugLookZ: 1.75,          // high, so the man and the knife sit below the prompt
    tugFov: 50,
    tugOverHeight: 4.2,
    tugOverLookZ: 1.5,
    tugFallbackM: 2.6,
    doorHalfM: 0.5,          // half the door leaf, the 1.0 m box of ARCHITECTURE 13.1
    freeFov: 60
  };

  var SHAKE_SEVERITY = { scrape: 0.3, bump: 0.6, crash: 1 };

  /** Phases where the car can be near a bay and the driver cares. */
  var PARK_PHASES = { DRIVE: true, SEARCH: true, HOLD: true, PAYOUT: true, BLOCKED: true };

  var R = null;

  /** @returns {{x:number,y:number,z:number,lx:number,ly:number,lz:number,fov:number}} A rig pose, world frame, z up. */
  function newPose() {
    return { x: 0, y: 0, z: 0, lx: 0, ly: 0, lz: 0, fov: 60 };
  }

  /**
   * Builds the camera. renderer.js reads `object` from here.
   * @param {object} S Sim state.
   */
  camera.init = function (S) {
    var tune = (TLV.tune && TLV.tune.render) || {};
    var obj = new THREE.PerspectiveCamera(Q.stopFov, window.innerWidth / Math.max(1, window.innerHeight), tune.cameraNear || 0.3, tune.cameraFar || 9000);
    obj.layers.enable(2);      // overlays and the 3D arrow: this camera only, never the mirror
    camera.object = obj;
    var veh = S.vehicles[0];
    R = {
      mode: 'auto', rig: 'chase', from: newPose(), to: newPose(), out: newPose(), blendT: 1, blendS: 0.0001,
      chase: newPose(), park: newPose(),
      yaw: veh.h, yawV: 0, speedT: 0, launch: 0, footYaw: veh.h, footYawV: 0, parkYaw: veh.h, parkYawV: 0,
      revT: 0, reverse: false, search: 0, armT: 1, tail: 0, tailHold: 0,
      ghost: new Uint8Array(TLV.const.MAX_VEHICLES), tailing: false,
      parkOverride: 0, parkShown: false, parkView: 0, armSnap: false,
      shake: 0, shakeT: 0, pulse: 0, jolt: 0,
      cineStage: null, cine: newPose(), shot: null,
      free: newPose(), lookYaw: Math.PI / 2, seen: false, t: 0
    };
  };

  /** Moves an angle toward a target with a critically damped spring. Returns the new [angle, rate] through `st`. */
  function spring(st, key, keyV, target, omega, dt) {
    var err = TLV.math.wrapPi(target - st[key]);
    var acc = omega * omega * err - 2 * omega * st[keyV];
    st[keyV] += acc * dt;
    st[key] = TLV.math.wrapPi(st[key] + st[keyV] * dt);
  }

  /**
   * Finds how far back an arm can reach. Binary search on the sim's own ray test, so the camera and the walls agree.
   * @param {object} W World.
   * @param {number} fx Focus.
   * @param {number} fy Focus.
   * @param {number} ex Eye.
   * @param {number} ey Eye.
   * @returns {number} Fraction of the arm that is clear, 0..1.
   */
  function armClear(W, fx, fy, ex, ey) {
    var ray = TLV.world.spatial.rayBlocked;
    var dx = ex - fx, dy = ey - fy;
    var len = Math.sqrt(dx * dx + dy * dy) || 1;
    var pad = 1 + Q.armPad / len;
    if (!ray(W, fx, fy, fx + dx * pad, fy + dy * pad)) return 1;
    var lo = 0, hi = 1;
    for (var i = 0; i < Q.armSteps; i++) {
      var mid = (lo + hi) / 2;
      if (ray(W, fx, fy, fx + dx * mid * pad, fy + dy * mid * pad)) hi = mid;
      else lo = mid;
    }
    return lo;
  }

    /**
   * How much of the frame a car fills, from its box. Both the near face and the side it shows count, so a car crossing the view scores by its length.
   * @param {object} v Car.
   * @param {number} t Distance from the eye to its centre, along the view.
   * @param {number} vx View direction x.
   * @param {number} vy View direction y.
   * @returns {number} Share of the frame, 0..1.
   */
  function frameShare(v, t, vx, vy) {
    var along = Math.abs(Math.cos(v.h) * vx + Math.sin(v.h) * vy);
    var across = Math.sqrt(Math.max(0, 1 - along * along));
    var near = Math.max(0.5, t - (v.length * along + v.width * across) / 2);
    var frameH = 2 * near * Math.tan(camera.object.fov * Math.PI / 360);
    var frameW = frameH * camera.object.aspect;
    var span = Math.min(frameW, v.length * across + v.width * along);
    return span * Math.min(frameH, Q.bodyH[v.kind] || Q.carH) / (frameW * frameH);
  }

/**
   * Finds what sits behind the player, and any car in the camera's line. Plain scan of a small radius.
   * @param {object} S Sim state.
   * @param {number} dt Seconds.
   * @param {number} fx Focus x.
   * @param {number} fy Focus y.
   * @param {number} h Heading of the thing being followed.
   * @param {number} halfLen Half length of it.
   */
  function scanBehind(S, dt, fx, fy, h, halfLen) {
    var c = Math.cos(h), s = Math.sin(h);
    var cars = S.vehicles;
    var close = false;
    var ghost = R.ghost;
    var ex = R.out.x, ey = R.out.y;
    var vx = fx - ex, vy = fy - ey;
    var viewLen = Math.sqrt(vx * vx + vy * vy) || 1;
    vx /= viewLen; vy /= viewLen;
    var range = Q.occludeRangeM * Q.occludeRangeM;
    for (var i = 0; i < cars.length; i++) {
      var v = cars[i];
      ghost[i] = 0;
      if (!v.active || v.isPlayer) continue;
      var rx = v.x - fx, ry = v.y - fy;
      var d2 = rx * rx + ry * ry;
      if (d2 > range) continue;
      var along = rx * c + ry * s;
      var side = -rx * s + ry * c;
      var gap = -along - halfLen - v.length / 2;
      if (along < 0 && gap < Q.tailRangeM && Math.abs(side) < Q.tailLateralM + v.width / 2) {
        if (v.mode !== 'PARKED') close = true;
        // A tailgater always ghosts: nothing else shows the player's own car. A bus crossing the junction behind is not one, and goes to the test below.
        if (Math.abs(Math.cos(v.h - h)) >= Q.tailSameWay) {
          ghost[i] = 1;
          continue;
        }
      }
      // Anything else standing on the line from the eye to the player goes through the same ghost, unless it would fill the frame.
      var ax = v.x - ex, ay = v.y - ey;
      var t = ax * vx + ay * vy;
      if (t > 0.5 && t < viewLen) {
        var off = Math.abs(ax * -vy + ay * vx);
        if (off < v.width / 2 + 0.5 && frameShare(v, t, vx, vy) <= Q.occludeMaxShare) ghost[i] = 1;
      }
    }
    if (close) R.tailHold = Q.tailHoldS;
    else R.tailHold = Math.max(0, R.tailHold - dt);
    R.tailing = R.tailHold > 0;
    // A ghost is for a camera stuck behind the car: from above, or in a held shot, it would only hide what the shot is of.
    if (R.rig !== 'chase' && R.rig !== 'foot') ghost.fill(0);
    if (R.rig.indexOf('cine') === 0) R.tailing = false;
  }

  /** The chase rig. */
  function chaseRig(S, veh, x, y, h, dt, out) {
    var M = TLV.math;
    var speed = Math.abs(veh.v);
    var top = (TLV.tune.player && TLV.tune.player.topSpeed) || 26.4;
    R.speedT += (M.clamp(speed / top, 0, 1) - R.speedT) * Math.min(1, Q.speedRate * dt);
    var launchAim = veh.isPlayer ? M.clamp(veh.accel / 6, 0, 1) : 0;
    R.launch += (launchAim - R.launch) * Math.min(1, Q.launchRate * dt);

    // Slip. v is along the velocity (WP-PLAYER D2), so the slide comes from h against vx, vy.
    var aim = h;
    if (speed > Q.driftMinV) {
      var velH = Math.atan2(veh.vy, veh.vx);
      var slip = M.wrapPi(velH - h);
      if (veh.v < 0) slip = 0;
      aim = h + slip * Q.driftBias;
    }

    if (veh.v < -Q.reverseV) R.revT += dt;
    else if (veh.v > -0.2) R.revT = 0;
    R.reverse = R.revT > Q.reverseS;
    if (R.reverse) aim = M.wrapPi(aim + Math.PI);

    spring(R, 'yaw', 'yawV', aim, Q.yawOmega, dt);
    var lag = M.wrapPi(R.yaw - aim);
    if (lag > Q.lagMaxRad) { R.yaw = M.wrapPi(aim + Q.lagMaxRad); R.yawV = Math.min(R.yawV, 0); }
    else if (lag < -Q.lagMaxRad) { R.yaw = M.wrapPi(aim - Q.lagMaxRad); R.yawV = Math.max(R.yawV, 0); }

    var searching = S.game && (S.game.phase === 'SEARCH') ? 1 : 0;
    R.search += (searching - R.search) * Math.min(1, Q.searchRate * dt);
    R.tail += ((R.tailing ? 1 : 0) - R.tail) * Math.min(1, Q.tailRate * dt);

    var t = R.speedT;
    var dist = M.lerp(Q.stopDist, Q.topDist, t) + R.launch * Q.launchDist + R.search * Q.searchDist;
    var height = M.lerp(Q.stopHeight, Q.topHeight, t) + R.tail * Q.tailRaise + R.search * Q.searchHeight;
    var look = M.lerp(Q.stopLook, Q.topLook, t);
    var fov = M.lerp(Q.stopFov, Q.topFov, t);

    var cy = Math.cos(R.yaw), sy = Math.sin(R.yaw);
    var ex = x - cy * dist, ey = y - sy * dist;
    var clear = armClear(S.world, x, y, ex, ey);
    var minT = Q.armMinM / dist;
    clear = Math.max(clear, minT);
    // A cut has nothing to ease from: the first frame of the shot already stands where the arm belongs.
    if (R.armSnap && R.rig === 'chase') R.armT = clear;
    else if (clear < R.armT) R.armT += (clear - R.armT) * Math.min(1, Q.armInRate * dt);
    else R.armT += (clear - R.armT) * Math.min(1, Q.armOutRate * dt);
    R.armSnap = false;
    var shrink = dist * (1 - R.armT);

    out.x = x - cy * dist * R.armT;
    out.y = y - sy * dist * R.armT;
    out.z = height + shrink * Q.armLiftK;
    out.lx = x + cy * look;
    out.ly = y + sy * look;
    out.lz = Q.lookZ + R.search * Q.searchLookZ;
    out.fov = fov;
  }

  /** The parking rig: high, steep, car-up. */
  function parkRig(x, y, h, dt, out) {
    spring(R, 'parkYaw', 'parkYawV', h, Q.parkYawOmega, dt);
    var back = Q.parkHeight / Math.tan(Q.parkPitchRad);
    var c = Math.cos(R.parkYaw), s = Math.sin(R.parkYaw);
    out.x = x - c * back + c * Q.parkAhead;
    out.y = y - s * back + s * Q.parkAhead;
    out.z = Q.parkHeight;
    out.lx = x + c * Q.parkAhead;
    out.ly = y + s * Q.parkAhead;
    out.lz = 0;
    out.fov = Q.parkFov;
  }

  /** The on-foot rig. */
  function footRig(S, f, x, y, h, dt, out) {
    // Slower than the car: the foot controls are camera-relative, so a stiff camera would turn a sideways step into a spin.
    if (Math.abs(f.v) > 0.3) spring(R, 'footYaw', 'footYawV', h, Q.footYawOmega, dt);
    else R.footYawV = 0;
    var c = Math.cos(R.footYaw), s = Math.sin(R.footYaw);
    var ex = x - c * Q.footDist, ey = y - s * Q.footDist;
    var clear = Math.max(armClear(S.world, x, y, ex, ey), Q.armMinM / Q.footDist * 0.6);
    if (clear < R.armT) R.armT += (clear - R.armT) * Math.min(1, Q.armInRate * dt);
    else R.armT += (clear - R.armT) * Math.min(1, Q.armOutRate * dt);
    var shrink = Q.footDist * (1 - R.armT);
    out.x = x - c * Q.footDist * R.armT;
    out.y = y - s * Q.footDist * R.armT;
    out.z = Q.footHeight + shrink * Q.armLiftK;
    out.lx = x + c * Q.footLook;
    out.ly = y + s * Q.footLook;
    out.lz = Q.footLookZ;
    out.fov = Q.footFov;
  }

  /** @returns {?object} The vehicle with this ID. */
  function carById(S, id) {
    for (var i = 0; i < S.vehicles.length; i++) {
      if (S.vehicles[i].active && S.vehicles[i].id === id) return S.vehicles[i];
    }
    return null;
  }

  /** Adds an upright box to a list of things that can stand in a shot. `own`: 1 the player's car, 2 his, 0 anything else. */
  function addBox(list, x, y, h, length, width, bot, top, own) {
    list.push({ x: x, y: y, c: Math.cos(h), s: Math.sin(h), hl: length / 2, hw: width / 2, bot: bot, top: top, own: own });
  }

  /** @returns {number} Roof height of a car, near enough to tell what a lens clears. */
  function roofOf(v) {
    if (v.length > 6) return 3.2;
    return v.kind === 'van' ? 2.3 : 1.55;
  }

  /**
   * Everything near the aim point that can stand between a lens and the people in the shot.
   * @param {object} S Sim state.
   * @param {object} veh Player's car.
   * @param {?object} rival His car.
   * @param {number} ax Aim x.
   * @param {number} ay Aim y.
   * @returns {object[]} Boxes.
   */
  function shotBoxes(S, veh, rival, ax, ay) {
    var W = S.world, list = [], ids = [], r = Q.standoffScanM, i;
    var occ = TLV.const.OCC, box = {};
    TLV.world.parking.parkedNear(S, ax, ay, r, ids);
    for (i = 0; i < ids.length; i++) {
      var o = TLV.world.parking.state(S, ids[i]);
      if (!TLV.world.parking.boxOf(W, ids[i], o, box)) continue;
      addBox(list, box.x, box.y, box.h, box.length, box.width, 0, o === occ.MOTO ? 1.2 : 1.55, 0);
    }
    for (i = 0; i < S.vehicles.length; i++) {
      var v = S.vehicles[i];
      if (!v.active || TLV.math.dist(v.x, v.y, ax, ay) > r) continue;
      addBox(list, v.x, v.y, v.h, v.length, v.width, 0, roofOf(v), v === veh ? 1 : (v === rival ? 2 : 0));
    }
    var n = TLV.world.spatial.propsNear(W, ax, ay, r, ids);
    for (i = 0; i < n; i++) {
      var p = W.props[ids[i]];
      if (p.kind === 'lamp') addBox(list, p.x, p.y, 0, 0.3, 0.3, 0, 6, 0);
      else if (p.kind === 'palm') addBox(list, p.x, p.y, 0, 0.6, 0.6, 0, 8.4, 0);
      else {
        addBox(list, p.x, p.y, 0, 0.7, 0.7, 0, 3.6, 0);
        addBox(list, p.x, p.y, 0, 6.4, 6.4, 3, 8, 0);      // the canopy
      }
    }
    return list;
  }

  /** @returns {boolean} True when the 3D segment from the eye to a target passes through a box. */
  function sightHits(b, ex, ey, ez, tx, ty, tz) {
    var rx = ex - b.x, ry = ey - b.y, dx = tx - ex, dy = ty - ey;
    var o = [rx * b.c + ry * b.s, -rx * b.s + ry * b.c];
    var d = [dx * b.c + dy * b.s, -dx * b.s + dy * b.c];
    var half = [b.hl, b.hw];
    var t0 = 0, t1 = 1;
    for (var i = 0; i < 2; i++) {
      if (Math.abs(d[i]) < 1e-9) {
        if (Math.abs(o[i]) > half[i]) return false;
        continue;
      }
      var a = (-half[i] - o[i]) / d[i], c = (half[i] - o[i]) / d[i];
      if (a > c) { var t = a; a = c; c = t; }
      if (a > t0) t0 = a;
      if (c < t1) t1 = c;
      if (t0 > t1) return false;
    }
    var z0 = ez + (tz - ez) * t0, z1 = ez + (tz - ez) * t1;
    return Math.min(z0, z1) < b.top && Math.max(z0, z1) > b.bot;
  }

  /**
   * Scores a lens by its clear lines to the people and the cars, less any bystanding car between it and them.
   * @param {object[]} boxes From shotBoxes.
   * @param {object[]} sights Targets, {x, y, z, w: weight, skip: the `own` box the target stands in}.
   * @param {number} ex Lens x.
   * @param {number} ey Lens y.
   * @param {number} ez Lens height.
   * @param {number} ax Aim x.
   * @param {number} ay Aim y.
   * @returns {{score:number, blocked:number}} Score, and the weight of the lines that are blocked.
   */
  function scoreLens(boxes, sights, ex, ey, ez, ax, ay) {
    var blocked = 0, score = 0;
    for (var i = 0; i < sights.length; i++) {
      var t = sights[i];
      for (var j = 0; j < boxes.length; j++) {
        var b = boxes[j];
        if (b.own && b.own === t.skip) continue;
        if (sightHits(b, ex, ey, ez, t.x, t.y, t.z)) { blocked += t.w; break; }
      }
    }
    var range = TLV.math.dist(ex, ey, ax, ay);
    var vx = (ax - ex) / range, vy = (ay - ey) / range;
    for (var c = 0; c < boxes.length; c++) {
      var near = boxes[c];
      if (near.own || near.bot > 0) continue;
      var rx = near.x - ex, ry = near.y - ey;
      var along = rx * vx + ry * vy;
      if (along < -near.hl || along > range - 2) continue;
      if (Math.abs(-rx * vy + ry * vx) > Math.max(along, 0) * Q.standoffFrameTan + near.hl) continue;
      // A bystanding car, or a trunk: a trunk is thin, so it only matters close to the lens.
      if (near.hl >= 1) score -= 5 * Math.max(0, 1 - Math.max(along, 0) / Q.standoffRangeBest);
      else if (along < Q.standoffTrunkM) score -= 4 * (1 - Math.max(along, 0) / Q.standoffTrunkM);
    }
    return { score: score - 2 * blocked, blocked: blocked };
  }

  /** @returns {?object} The attacker, once he is out of his car. */
  function attackerOf(S) {
    for (var p = 0; p < S.peds.length; p++) {
      if (S.peds[p].active && S.peds[p].kind === 'attacker') return S.peds[p];
    }
    return null;
  }

  /**
   * The STANDOFF shot. It is set once he is out of his door, so his car has stopped and his place is known, and it is searched for rather than fixed, because
   * a kerb bay has a parked row on both sides of it and a street may have room on one side only. The lens goes where nothing stands in front of him or the player.
   * @param {object} S Sim state.
   * @param {object} veh Player's car.
   * @param {?object} rival His car.
   * @param {number} fx Player's forward x.
   * @param {number} fy Player's forward y.
   * @param {number} hx Driver's door x, where he is going.
   * @param {number} hy Driver's door y.
   * @param {object} out Pose written.
   */
  function standoffShot(S, veh, rival, fx, fy, hx, hy, out) {
    var W = S.world, M = TLV.math;
    var ray = TLV.world.spatial.rayBlocked, inside = TLV.world.spatial.pointInBuilding;
    var man = attackerOf(S);
    var mx = man ? man.x : hx, my = man ? man.y : hy;
    var rx = rival ? rival.x : veh.x, ry = rival ? rival.y : veh.y;
    var ax = (mx + hx + veh.x + rx) / 4, ay = (my + hy + veh.y + ry) / 4;
    var half = veh.length / 2;
    var noseX = veh.x + fx * half, noseY = veh.y + fy * half, tailX = veh.x - fx * half, tailY = veh.y - fy * half;
    var sights = [
      { x: mx, y: my, z: 1.7, w: 5, skip: 0 }, { x: mx, y: my, z: 0.9, w: 5, skip: 0 },
      { x: hx, y: hy, z: 1, w: 3, skip: 0 },
      { x: veh.x, y: veh.y, z: 1.3, w: 3, skip: 1 }, { x: noseX, y: noseY, z: 0.8, w: 2, skip: 1 }, { x: tailX, y: tailY, z: 0.8, w: 1, skip: 1 }
    ];
    if (rival) {
      sights.push({ x: rx, y: ry, z: 1.3, w: 2, skip: 2 });
      sights.push({ x: rx + Math.cos(rival.h) * rival.length / 2, y: ry + Math.sin(rival.h) * rival.length / 2, z: 0.8, w: 1.5, skip: 2 });
    }
    var boxes = shotBoxes(S, veh, rival, ax, ay);
    var hc = rival ? Math.cos(rival.h) : fx, hs = rival ? Math.sin(rival.h) : fy;
    var walk = (hx - mx) * hc + (hy - my) * hs;
    var walkX = hc * walk, walkY = hs * walk;
    var best = null;
    for (var b = 0; b < Q.standoffBearings; b++) {
      var bear = b / Q.standoffBearings * Math.PI * 2;
      var cb = Math.cos(bear), sb = Math.sin(bear);
      for (var d = 0; d < Q.standoffRanges.length; d++) {
        var range = Q.standoffRanges[d];
        var ex = ax + cb * range, ey = ay + sb * range;
        if (inside(W, ex, ey) >= 0 || ray(W, ax, ay, ex + cb, ey + sb)) continue;
        // His open door stands square to his car, level with him. The lens stays on the side of it he walks off to, or the door hides him.
        var clearOfDoor = (ex - mx) * walkX + (ey - my) * walkY > 0 ? 2 : 0;
        var a0 = Math.atan2(veh.y - ey, veh.x - ex), a1 = Math.atan2(ry - ey, rx - ex);
        var spread = Math.min(1, Math.abs(M.wrapPi(a1 - a0)) / Q.standoffSpreadRad);
        var pick = clearOfDoor + 2.5 * spread - 0.1 * Math.abs(range - Q.standoffRangeBest) - (ray(W, ex, ey, mx, my) ? 10 : 0);
        for (var h = 0; h < Q.standoffHeights.length; h++) {
          var ez = Q.standoffHeights[h];
          var r = scoreLens(boxes, sights, ex, ey, ez, ax, ay);
          var score = r.score + pick - 0.6 * (ez - Q.standoffHeights[0]);
          if (!best || score > best.score) best = { x: ex, y: ey, z: ez, score: score, blocked: r.blocked };
        }
      }
    }
    if (!best) best = { x: ax - fx * 4, y: ay - fy * 4, z: Q.standoffFallbackZ, score: 0, blocked: -1 };

    // The narrowest view that holds him and both cars.
    var aim = Math.atan2(ay - best.y, ax - best.x);
    var flat = Math.sqrt((ax - best.x) * (ax - best.x) + (ay - best.y) * (ay - best.y)) || 1;
    var off = 0;
    var fit = [[mx, my], [noseX, noseY], [tailX, tailY], [hx, hy]];
    if (rival) fit.push([rx + Math.cos(rival.h) * rival.length * 0.5, ry + Math.sin(rival.h) * rival.length * 0.5], [rx - Math.cos(rival.h) * rival.length * 0.5, ry - Math.sin(rival.h) * rival.length * 0.5]);
    for (var i = 0; i < fit.length; i++) {
      off = Math.max(off, Math.abs(M.wrapPi(Math.atan2(fit[i][1] - best.y, fit[i][0] - best.x) - aim)));
    }
    var aspect = window.innerWidth / Math.max(1, window.innerHeight);
    var fov = 2 * Math.atan(Math.tan(off) * Q.standoffFit / aspect) / DEG;
    out.x = best.x;
    out.y = best.y;
    out.z = best.z;
    out.lx = ax;
    out.ly = ay;
    out.lz = Q.standoffLookZ;
    out.fov = M.clamp(fov, Q.standoffFovMin, Q.standoffFovMax);
    R.shot = { blocked: best.blocked, range: flat };
  }

  /**
   * Sets a held shot for a knife stage. Shots are held still: the moment is the two cars and the man between them.
   * @param {object} S Sim state.
   * @param {object} k KnifeEncounter.
   * @param {object} veh Player's car.
   */
  function setCine(S, k, veh) {
    var out = R.cine;
    var fx = Math.cos(veh.h), fy = Math.sin(veh.h);
    var lx = -fy, ly = fx;
    // Which bumper he came to.
    var rival = carById(S, k.rivalVehId);
    var dir = 1;
    if (rival) dir = (rival.x - veh.x) * fx + (rival.y - veh.y) * fy >= 0 ? 1 : -1;

    // The driver's door, always the left.
    var hx = veh.x + fx * 0.6 + lx * 1.1, hy = veh.y + fy * 0.6 + ly * 1.1;
    if (k.stage === 'STANDOFF') {
      standoffShot(S, veh, rival, fx, fy, hx, hy, out);
      return;
    }

    tugShot(S, veh, dir, fx, fy, lx, ly, hx, hy, out);
  }

  /**
   * The DOOR_TUG shot, low on the driver's side so the man fills it, from the quarter away from his car so that car stays behind the action. That quarter is where a
   * queue held up by his car stands, and a kerb bay can have a parked row there, so like STANDOFF the lens is searched for: lowest and nearest first, then round the
   * door and up over the roofs, until nothing stands in front of him.
   * @param {object} S Sim state.
   * @param {object} veh Player's car.
   * @param {number} dir Which bumper he came to, 1 the nose.
   * @param {number} fx Player's forward x.
   * @param {number} fy Player's forward y.
   * @param {number} lx Player's left x.
   * @param {number} ly Player's left y.
   * @param {number} hx Where the shot looks, x.
   * @param {number} hy Where the shot looks, y.
   * @param {object} out Pose written.
   */
  function tugShot(S, veh, dir, fx, fy, lx, ly, hx, hy, out) {
    var W = S.world, M = TLV.math, T = TLV.tune.game;
    var ray = TLV.world.spatial.rayBlocked, inside = TLV.world.spatial.pointInBuilding;
    var side = veh.width / 2 + T.doorStepM;
    var sx = veh.x + fx * T.tugForwardM + lx * side, sy = veh.y + fy * T.tugForwardM + ly * side;
    var man = attackerOf(S);
    var mx = man ? man.x : sx, my = man ? man.y : sy;
    var sights = [
      { x: sx, y: sy, z: 1.7, w: 5, skip: 0 }, { x: sx, y: sy, z: 1.1, w: 5, skip: 0 }, { x: sx, y: sy, z: 0.4, w: 2, skip: 0 },
      { x: mx, y: my, z: 1.7, w: 4, skip: 0 }, { x: mx, y: my, z: 1, w: 3, skip: 0 }
    ];
    // Passing no rival makes his car one more thing to keep out of the foreground. The player's open door is a thin box the man stands just behind.
    var boxes = shotBoxes(S, veh, null, hx, hy);
    var hinge = veh.length / 4;
    addBox(boxes, veh.x + fx * hinge + lx * (veh.width / 2 + Q.doorHalfM), veh.y + fy * hinge + ly * (veh.width / 2 + Q.doorHalfM), veh.h + Math.PI / 2, Q.doorHalfM * 2, 0.1, 0, 1.4, 1);
    var best = null;
    for (var turn = 0; turn < 2; turn++) {
      var q = turn ? dir : -dir;
      for (var a = 0; a < Q.tugAngles.length; a++) {
        var ca = Math.cos(Q.tugAngles[a] * DEG), sa = Math.sin(Q.tugAngles[a] * DEG);
        var ux = lx * ca + fx * q * sa, uy = ly * ca + fy * q * sa;
        for (var d = 0; d < Q.tugRanges.length; d++) {
          var range = Q.tugRanges[d];
          var ex = hx + ux * range, ey = hy + uy * range;
          if (inside(W, ex, ey) >= 0 || ray(W, hx, hy, ex + ux, ey + uy)) continue;
          // scoreLens counts cars up to the aim, so a lens hard up against the door dodges the foreground it should see. That one is for a wall, and only for a wall.
          var pick = (turn ? 0 : 1) - 0.4 * Math.abs(range - Q.tugRangeBest) - 0.02 * Q.tugAngles[a] - (range < Q.tugRangeBest ? Q.tugNearCost : 0);
          for (var h = 0; h < Q.tugHeights.length; h++) {
            var ez = Q.tugHeights[h];
            var r = scoreLens(boxes, sights, ex, ey, ez, hx, hy);
            var score = r.score + pick - 0.6 * (ez - Q.tugHeight);
            if (!best || score > best.score) best = { x: ex, y: ey, z: ez, score: score, blocked: r.blocked, range: range };
          }
        }
      }
    }
    if (!best) best = { x: hx + lx * Q.tugFallbackM - fx * dir, y: hy + ly * Q.tugFallbackM - fy * dir, z: Q.tugHeight, blocked: -1, range: Q.tugFallbackM };
    out.x = best.x;
    out.y = best.y;
    out.z = best.z;
    out.lx = hx;
    out.ly = hy;
    out.lz = M.lerp(Q.tugLookZ, Q.tugOverLookZ, (best.z - Q.tugHeight) / (Q.tugOverHeight - Q.tugHeight));
    out.fov = Q.tugFov;
    R.shot = { blocked: best.blocked, range: best.range };
  }

  /** Copies a pose. */
  function copyPose(to, from) {
    to.x = from.x; to.y = from.y; to.z = from.z;
    to.lx = from.lx; to.ly = from.ly; to.lz = from.lz;
    to.fov = from.fov;
  }

  /**
   * Starts a blend to a rig.
   * @param {string} rig New rig.
   * @param {number} seconds Blend time. 0 cuts.
   */
  function goRig(rig, seconds) {
    if (R.rig === rig) return;
    R.rig = rig;
    copyPose(R.from, R.out);
    R.blendT = seconds > 0 ? 0 : 1;
    R.blendS = Math.max(seconds, 0.0001);
    if (rig === 'chase' || rig === 'foot') R.armT = Math.max(R.armT, 0.6);
    R.armSnap = !(seconds > 0);
    if (R.armSnap) R.ghost.fill(0);     // read from the eye this cut has just left
  }

  /** @returns {boolean} True when GAME_DESIGN 18's rule asks for the parking view. */
  function wantsAutoPark(S, veh, x, y) {
    var g = S.game;
    if (!g || !PARK_PHASES[g.phase]) return false;
    if (g.park && g.park.stage) return true;
    if (g.phase === 'PAYOUT' || g.phase === 'BLOCKED') return R.parkShown;
    var e = g.errand;
    if (!e || e.bayId < 0) return false;
    var spot = TLV.world.parking.spot(S.world, e.bayId);
    if (!spot) return false;
    var d = TLV.math.dist(x, y, spot.x, spot.y);
    var speed = Math.abs(veh.v);
    if (R.parkShown) return d < Q.parkLeaveM && speed < Q.parkLeaveV;
    return d < Q.parkRangeM && d - speed * Q.parkBlendS < Q.parkShowM && speed < Q.parkMaxV;
  }

  /**
   * Places the camera for this frame.
   * @param {object} S Sim state.
   * @param {number} alpha Tick interpolation.
   * @param {number} dtReal Seconds since the last frame.
   */
  camera.frame = function (S, alpha, dtReal) {
    if (!R) return;
    var dt = Math.min(dtReal, 0.1);
    var M = TLV.math;
    var obj = camera.object;
    var P = S.player;
    var veh = P.veh || S.vehicles[0];
    var onFoot = P.mode === 'FOOT' && P.foot && P.foot.active;

    var x = veh.px + (veh.x - veh.px) * alpha;
    var y = veh.py + (veh.y - veh.py) * alpha;
    var h = veh.ph + M.wrapPi(veh.h - veh.ph) * alpha;
    var fh = h, halfLen = veh.length / 2;
    var f = P.foot;
    if (onFoot) {
      x = f.px + (f.x - f.px) * alpha;
      y = f.py + (f.y - f.py) * alpha;
      fh = f.ph + M.wrapPi(f.h - f.ph) * alpha;
      halfLen = 0.3;
    }

    if (!R.seen) {
      // First frame: start behind the car, not swinging in from the map origin.
      R.seen = true;
      R.yaw = R.parkYaw = R.footYaw = fh;
      R.speedT = 0;
    }

    if (R.mode === 'free') R.ghost.fill(0);
    else scanBehind(S, dt, x, y, fh, halfLen);

    var k = S.game && S.game.knife;
    var stage = k ? k.stage : null;
    var rig = 'chase';
    var blend = Q.parkBlendS;

    if (R.mode === 'free') rig = 'free';
    else if (R.mode === 'parking') rig = 'parking';
    else if (R.mode === 'chase') rig = onFoot ? 'foot' : 'chase';
    else if (R.mode === 'foot' || onFoot) rig = 'foot';
    else if (stage === 'STANDOFF' && k.attackerId < 0) rig = R.rig === 'parking' ? 'parking' : 'chase';    // no cut until he is out of his door
    else if (stage === 'STANDOFF' || stage === 'DOOR_TUG' || stage === 'BAIL' || stage === 'DRAGGED') rig = 'cine';
    else {
      var auto = wantsAutoPark(S, veh, x, y);
      if (R.parkOverride && !auto && !(S.game && S.game.park && S.game.park.stage)) {
        // A forced view lasts until the driver has left the bay behind, and a press with no bay near never reaches the rig at all.
        var e = S.game && S.game.errand;
        var spot = e && e.bayId >= 0 ? TLV.world.parking.spot(S.world, e.bayId) : null;
        if (!spot || M.dist(x, y, spot.x, spot.y) > Q.parkForceM) R.parkOverride = 0;
      }
      if (R.parkOverride > 0) rig = 'parking';
      else if (R.parkOverride < 0) rig = 'chase';
      else rig = auto ? 'parking' : 'chase';
      R.parkShown = rig === 'parking';
    }

    if (rig === 'cine') {
      if (R.cineStage !== stage) {
        // Each stage is a cut to its own held shot, BAIL and DRAGGED keep the tug's.
        if (!(R.cineStage === 'DOOR_TUG' && (stage === 'BAIL' || stage === 'DRAGGED'))) setCine(S, k, veh);
        R.cineStage = stage;
        R.rig = 'cine-' + stage;
        copyPose(R.from, R.cine);
        R.blendT = 1;
      }
    } else {
      R.cineStage = null;
      if (rig === 'foot') blend = Q.footBlendS;
      // Out of a held shot by a cut, and back from a run by a cut too: the car is a street away, and a blend would fly through what lies between.
      if (R.rig.indexOf('cine') === 0 || (R.rig === 'foot' && rig !== 'foot')) blend = 0;
      goRig(rig, blend);
    }

    // Keeps step with the blend into the view and out of it, and drops at once for a cut or a free camera.
    if (rig === 'parking') R.parkView = Math.min(1, R.parkView + dt / Q.parkBlendS);
    else if (rig === 'chase' || rig === 'foot') R.parkView = Math.max(0, R.parkView - dt / Q.parkBlendS);
    else R.parkView = 0;

    // The car rigs keep running while unseen, so a blend lands on a live pose and not on a stale yaw.
    var to = R.to;
    chaseRig(S, veh, onFoot ? veh.x : x, onFoot ? veh.y : y, h, dt, R.chase);
    parkRig(onFoot ? veh.x : x, onFoot ? veh.y : y, h, dt, R.park);
    if (rig === 'free') copyPose(to, R.free);
    else if (rig === 'cine') copyPose(to, R.cine);
    else if (rig === 'parking') copyPose(to, R.park);
    else if (rig === 'foot' && onFoot) footRig(S, f, x, y, fh, dt, to);
    else copyPose(to, R.chase);

    R.blendT = Math.min(1, R.blendT + dt / R.blendS);
    var b = M.smoothstep(0, 1, R.blendT);
    var out = R.out;
    out.x = M.lerp(R.from.x, to.x, b);
    out.y = M.lerp(R.from.y, to.y, b);
    out.z = M.lerp(R.from.z, to.z, b);
    out.lx = M.lerp(R.from.lx, to.lx, b);
    out.ly = M.lerp(R.from.ly, to.ly, b);
    out.lz = M.lerp(R.from.lz, to.lz, b);
    out.fov = M.lerp(R.from.fov, to.fov, b);

    // Shake and the near-miss pulse sit on top of whatever rig is live, and are not fed back into it.
    R.t += dt;
    var sx = 0, sy = 0, sz = 0;
    if (R.shakeT > 0) {
      R.shakeT = Math.max(0, R.shakeT - dt);
      var amp = Q.shakeM * R.shake * (R.shakeT / Q.shakeDecayS);
      var w = R.t * Q.shakeHz;
      sx = Math.sin(w * 1.0 + 1.3) * amp;
      sy = Math.sin(w * 1.27 + 2.1) * amp;
      sz = Math.sin(w * 0.83 + 0.4) * amp;
    }
    if (R.jolt > 0) {
      sz += Math.sin(R.t * 41) * R.jolt;
      R.jolt = Math.max(0, R.jolt - dt * 0.5);
    }
    if (R.pulse > 0) R.pulse = Math.max(0, R.pulse - dt / Q.pulseDecayS);

    TLV.render.coords.toThree(out.x + sx, out.y + sy, out.z + sz, obj.position);
    var lookV = R._v || (R._v = new THREE.Vector3());
    TLV.render.coords.toThree(out.lx + sx * 0.4, out.ly + sy * 0.4, out.lz + sz * 0.4, lookV);
    obj.lookAt(lookV);
    var fov = out.fov + R.pulse * R.pulse * Q.pulseDeg;
    var aspect = window.innerWidth / Math.max(1, window.innerHeight);
    if (Math.abs(obj.fov - fov) > 0.01 || Math.abs(obj.aspect - aspect) > 0.001) {
      obj.fov = fov;
      obj.aspect = aspect;
      obj.updateProjectionMatrix();
    }
    obj.updateMatrixWorld();
    R.lookYaw = Math.atan2(out.ly - out.y, out.lx - out.x);
  };

  /**
   * World heading the camera looks along. Foot input is rotated by this, so a press of W always means "away from the camera".
   * @returns {number} Radians.
   */
  camera.yaw = function () {
    return R ? R.lookYaw : Math.PI / 2;
  };

  /**
   * Sets the camera mode.
   * @param {string} mode 'auto', 'chase', 'parking', 'foot' or 'free'.
   */
  camera.setMode = function (mode) {
    if (!R) return;
    if (mode === 'free') copyPose(R.free, R.out);
    R.mode = mode;
    R.parkOverride = 0;
  };

  /** C and LB: swaps between the parking view and the chase view. In 'auto', the choice lasts until the car has left the bay. */
  camera.toggleParking = function () {
    if (!R) return;
    var showing = R.rig === 'parking';
    // On foot or in a held shot there is no choice to make, and a press kept for later would land on the cut back to the car.
    if (R.mode === 'auto' && !showing && R.rig !== 'chase') return;
    if (R.mode === 'auto') R.parkOverride = showing ? -1 : 1;
    else R.mode = showing ? 'chase' : 'parking';
  };

  /** @returns {number} How much of the picture is the parking view, 0..1. effects.js opens the tree crowns by this. */
  camera.parkView = function () {
    return R ? R.parkView : 0;
  };

  /** @returns {boolean} True when the tailgater trap is on. Rear-view reads this. */
  camera.tailgated = function () {
    return !!(R && R.tailing);
  };

  /**
   * @param {number} slot Vehicle slot.
   * @returns {boolean} True for a car the camera is looking through.
   */
  camera.isGhost = function (slot) {
    return !!(R && R.ghost[slot]);
  };

  /**
   * Kicks the camera.
   * @param {string|number} severity 'scrape', 'bump', 'crash', or 0..1.
   */
  camera.shake = function (severity) {
    if (!R) return;
    var s = typeof severity === 'number' ? severity : SHAKE_SEVERITY[severity] || 0;
    if (s > R.shake || R.shakeT <= 0) R.shake = s;
    R.shakeT = Q.shakeDecayS;
  };

  /** Fires the near-miss field-of-view pulse. */
  camera.pulse = function () {
    if (R) R.pulse = 1;
  };

  /** A surface change: kerb, sidewalk, sand. */
  camera.jolt = function () {
    if (R) R.jolt = Q.joltM;
  };

  /**
   * Places the 'free' camera, for tests and photo modes.
   * @param {number} x World x.
   * @param {number} y World y.
   * @param {number} z Height.
   * @param {number} lx Look x.
   * @param {number} ly Look y.
   * @param {number} lz Look height.
   * @param {number} [fov] Degrees.
   */
  camera.setFree = function (x, y, z, lx, ly, lz, fov) {
    if (!R) return;
    R.mode = 'free';
    R.free.x = x; R.free.y = y; R.free.z = z;
    R.free.lx = lx; R.free.ly = ly; R.free.lz = lz;
    R.free.fov = fov || Q.freeFov;
    copyPose(R.from, R.free);
    copyPose(R.out, R.free);
    R.blendT = 1;
  };

  /** @returns {?object} Rig state, for tests. */
  camera._state = function () {
    if (!R) return null;
    return {
      mode: R.mode, rig: R.rig, fov: camera.object.fov, x: R.out.x, y: R.out.y, z: R.out.z, yaw: R.yaw, armT: R.armT,
      tailing: R.tailing, tail: R.tail, speedT: R.speedT, blendT: R.blendT, shakeT: R.shakeT, parkOverride: R.parkOverride, reverse: R.reverse, shot: R.shot
    };
  };

  /** Drops the rig. */
  camera.dispose = function () {
    R = null;
    camera.object = null;
  };
})(window.TLV);
