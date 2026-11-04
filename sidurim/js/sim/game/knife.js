// js/sim/game/knife.js — WP-GAME
// The encounter (GAME_DESIGN 15): he gets out, tries to pull the player from the car, and the player runs for the shop door. The clock
// is frozen throughout. Every exit but CAUGHT counts the errand, and RESOLVE puts the player back at the car with the way out clear.
// Nothing here is graphic: a hit is a flash and a stumble, and his speech is symbols.
(function (TLV) {
  'use strict';

  var knife = TLV.ns('game.knife');

  /** Changes stage and tells the frame consumers. */
  function setStage(S, k, stage) {
    k.stage = stage;
    k.stageT = 0;
    S.bus.emit('knife.stage', { stage: stage });
  }

  /** @returns {object} A point left of a pose: forward along h, then to its left. */
  function offset(x, y, h, fwd, left) {
    var c = Math.cos(h);
    var s = Math.sin(h);
    return { x: x + c * fwd - s * left, y: y + s * fwd + c * left };
  }

  /**
   * The nose-in pose across the player's bumper, on the side he is on. Past that bumper he stays put, stopped in front of it. On the
   * player's road the pose is square to the player's car, not to him: a car swinging by reads up to 20 deg off, and that would turn his
   * door away.
   */
  function standoffPose(S, veh) {
    var T = TLV.tune.game;
    var me = S.player.veh;
    var square = Math.cos(veh.h - me.h);
    var base = Math.abs(square) < T.standoffSquare ? veh.h : (square > 0 ? me.h : me.h + Math.PI);
    var c = Math.cos(base);
    var s = Math.sin(base);
    var ex = veh.x - me.x;
    var ey = veh.y - me.y;
    var along = ex * c + ey * s;
    var across = -ex * s + ey * c;
    var side = across >= 0 ? 1 : -1;
    var noseU = T.standoffNoseM;
    var yaw = -side * T.standoffYawDeg * Math.PI / 180;
    var half = veh.length / 2;
    var u = noseU - Math.cos(yaw) * half;
    var n = side * T.standoffSideM - Math.sin(yaw) * half;
    if (along + T.standoffRunM > u) return { x: veh.x, y: veh.y, h: veh.h, d: 0 };
    return {
      x: me.x + c * u - s * n,
      y: me.y + s * u + c * n,
      h: TLV.math.wrapPi(base + yaw),
      d: TLV.math.dist(veh.x, veh.y, me.x + c * u - s * n, me.y + s * u + c * n)
    };
  }

  /** @returns {object} Where a man stands as he gets out of a door, 1 left or 2 right: in its opening, aft of the hinge. */
  function doorPoint(pose, veh, door) {
    var T = TLV.tune.game;
    return offset(pose.x, pose.y, pose.h, veh.length / 4 - T.doorAftM, (door === 1 ? 1 : -1) * (veh.width / 2 + T.doorStepM));
  }

  /** @returns {boolean} True when a door can swing open in a pose and a man can stand in its opening. */
  function doorClear(S, pose, veh, door) {
    var attacker = TLV.game.attacker;
    var at = doorPoint(pose, veh, door);
    var leaf = offset(pose.x, pose.y, pose.h, veh.length / 4, (door === 1 ? 1 : -1) * (veh.width / 2 + TLV.tune.game.doorLeafM));
    return attacker._canStand(S, at.x, at.y, TLV.tune.game.routeBodyM) && attacker._canStand(S, leaf.x, leaf.y, 0);
  }

  /** @returns {number} The door he uses in a pose: the one on the player's side, unless a wall or a car shuts it. */
  function doorFor(S, pose, veh) {
    var me = S.player.veh;
    var near = (me.y - pose.y) * Math.cos(pose.h) - (me.x - pose.x) * Math.sin(pose.h) >= 0 ? 1 : 2;
    var far = near === 1 ? 2 : 1;
    return doorClear(S, pose, veh, near) || !doorClear(S, pose, veh, far) ? near : far;
  }

  /** Stops him where the encounter wants him. */
  function placeRival(S, k) {
    var T = TLV.tune.game;
    var veh = k.rivalVehId >= 0 ? TLV.traffic.byId(S, k.rivalVehId) : null;
    k._t.doorAt = T.standoffBlendS;
    if (!veh) return;
    var pose = standoffPose(S, veh);
    var dur = TLV.math.clamp(pose.d / T.standoffRunV, T.standoffMinS, T.standoffBlendS);
    if (TLV.traffic.command(S, veh, { type: 'RIVAL_STANDOFF', x: pose.x, y: pose.y, h: pose.h, durS: dur, door: doorFor(S, pose, veh) })) k._t.doorAt = dur;
    veh.horn = true;
  }

  /** @returns {object} The encounter, with its private state. */
  function fresh(S) {
    return {
      stage: 'STANDOFF', stageT: 0, tugBar: 1, attackerId: -1, rivalVehId: -1, gap: TLV.tune.game.attackerFastGapM, strikes: 0,
      lunge: 'NONE', lungeT: 0, outOfSightT: 0, shaken: false, shakenT: 0, exit: null,
      _a: TLV.game.attacker._newState(),
      _t: { doorAt: 0, lead: 0, towAt: -1, path: null, along: 0, noWay: false, snap: false, pt: { x: 0, y: 0, h: 0 } }
    };
  }

  /**
   * Starts the encounter. Called at PAYOUT +0.3 s on tier KNIFE, or by forceKnife.
   * @param {object} S Sim state.
   */
  knife.begin = function (S) {
    var g = S.game;
    var T = TLV.tune.game;
    var c = g.contest;
    var k = fresh(S);
    k.rivalVehId = c ? c.rivalId : -1;
    g.knife = k;
    g.knivesDone++;
    g.lastKnifeErrand = g.errandIndex;
    TLV.player.setLocked(S, true);
    TLV.game.flow._setPhase(S, 'ENCOUNTER');
    S.timeScale = T.standoffScale;
    S.bus.emit('knife.stage', { stage: 'STANDOFF' });
    placeRival(S, k);
  };

  /** @returns {boolean} True once his door is open. A blend held up by someone in its way ends where the car stands, so he never gets out of a car still moving. */
  function doorOpen(S, k) {
    var T = TLV.tune.game;
    var veh = k.rivalVehId >= 0 ? TLV.traffic.byId(S, k.rivalVehId) : null;
    if (!veh || veh.door) return true;
    if (k.stageT < T.standoffBlendS + T.standoffDoorWaitS) return false;
    return !TLV.traffic.command(S, veh, { type: 'RIVAL_STANDOFF', x: veh.x, y: veh.y, h: veh.h, durS: TLV.const.DT, door: doorFor(S, veh, veh) });
  }

  /** He gets out of his car, at the door that opened, and the knife is out from the first moment he is seen. */
  function getOut(S, k) {
    var veh = k.rivalVehId >= 0 ? TLV.traffic.byId(S, k.rivalVehId) : null;
    var me = S.player.veh;
    var door = veh ? veh.door || doorFor(S, veh, veh) : 0;
    var from = veh ? doorPoint(veh, veh, door) : offset(me.x, me.y, me.h, TLV.tune.game.standoffNoseM, TLV.tune.game.standoffNoseM);
    var p = TLV.game.attacker.spawn(S, from.x, from.y, veh ? veh.h : me.h);
    p.hasKnife = true;
    k.attackerId = p.id;
    k._t.path = null;
    if (veh) S.bus.emit('bubble', { who: 'veh', id: veh.id, text: TLV.tune.game.curseText, ttl: TLV.tune.game.bubbleS });
  }

  /** Lays his way to a point round the cars. With every way shut he stays where he is, on his own side of them. */
  function setWay(S, k, ped, x, y) {
    var way = TLV.game.attacker._route(S, ped.x, ped.y, x, y);
    k._t.noWay = !way;
    k._t.path = way || [{ x: ped.x, y: ped.y }];
    k._t.along = 0;
  }

  /** Runs him along his way. @returns {boolean} True on arrival. */
  function runWay(S, k, ped, dt) {
    var T = TLV.tune.game;
    var t = k._t;
    var attacker = TLV.game.attacker;
    var len = attacker._length(t.path);
    if (t.along >= len) return true;
    if (attacker._yield(S, k, ped, dt)) return false;
    t.along = Math.min(len, t.along + T.attackerV * dt);
    attacker._pathAt(t.path, t.along, t.pt);
    ped.x = t.pt.x;
    ped.y = t.pt.y;
    attacker._keepOut(S, ped);
    ped.h = t.pt.h;
    ped.v = T.attackerV;
    ped.anim = 'run';
    return false;
  }

  /** He goes round to the driver's door, which he always tugs (GAME_DESIGN 15.1). */
  function walkToDoor(S, k, dt) {
    var T = TLV.tune.game;
    var ped = TLV.peds.byId(S, k.attackerId);
    if (!ped) return;
    var me = S.player.veh;
    var door = offset(me.x, me.y, me.h, T.tugForwardM, me.width / 2 + T.doorStepM);
    if (k._t.snap) {
      k._t.snap = false;
      k._t.path = [door];
      k._t.along = 0;
      ped.x = door.x;
      ped.y = door.y;
    } else if (!k._t.path) {
      setWay(S, k, ped, door.x, door.y);
    }
    if (!runWay(S, k, ped, dt)) return;
    ped.h = Math.atan2(me.y - ped.y, me.x - ped.x);
    ped.v = 0;
    ped.anim = k._t.noWay ? 'glare' : 'tug';
    if (!k._t.noWay) me.door = 1;
  }

  /** @returns {number} Metres on foot between two points by a straight line or one bend, or Infinity when neither gets through. */
  function footWay(S, ax, ay, bx, by) {
    var T = TLV.tune.game;
    var W = S.world;
    var ray = TLV.world.spatial.rayBlocked;
    var d = TLV.math.dist(ax, ay, bx, by);
    if (!ray(W, ax, ay, bx, by)) return d;
    var nx = (ay - by) / (d || 1);
    var ny = (bx - ax) / (d || 1);
    for (var i = 1; i <= T.chaseBendSteps; i++) {
      for (var side = -1; side <= 1; side += 2) {
        var mx = (ax + bx) / 2 + nx * side * i * T.chaseBendM;
        var my = (ay + by) / 2 + ny * side * i * T.chaseBendM;
        if (!ray(W, ax, ay, mx, my) && !ray(W, mx, my, bx, by)) return TLV.math.dist(ax, ay, mx, my) + TLV.math.dist(mx, my, bx, by);
      }
    }
    return Infinity;
  }

  /**
   * The door he runs for. The errand's own, unless a building stands in the way: on foot the arrow is a straight bearing, a player out of
   * his car has 25 s and no map, and a shop round the corner of the block is no refuge. Then it is the door in a clear line whose run is
   * nearest the design's, or failing any such door, the one a single bend away.
   */
  function chaseDoor(S, e) {
    var T = TLV.tune.game;
    var W = S.world;
    var f = S.player.foot;
    var POIF = TLV.const.POIF;
    var spatial = TLV.world.spatial;
    var own = TLV.math.dist(f.x, f.y, e.doorX, e.doorY);
    if (!spatial.rayBlocked(W, f.x, f.y, e.doorX, e.doorY)) return;
    var want = Math.max(own, T.chaseDoorWantM);
    var ids = [];
    var n = spatial.poisNear(W, f.x, f.y, T.knifeBayM, ids);
    var best = null;
    var bestOff = Infinity;
    for (var i = 0; i < n; i++) {
      var p = W.pois[ids[i]];
      if (p.flags & (POIF.SENSITIVE | POIF.NO_FACADE)) continue;
      var d = TLV.math.dist(f.x, f.y, p.entX, p.entY);
      // A clear line always beats a bend, whatever the length of the run.
      var clear = !spatial.rayBlocked(W, f.x, f.y, p.entX, p.entY);
      var off = Math.abs(d - want) + (clear ? 0 : T.knifeBayM);
      if (d < T.chaseDoorMinM || off >= bestOff) continue;
      if (!clear && footWay(S, f.x, f.y, p.entX, p.entY) > d * T.chaseStraightRatio) continue;
      if (spatial.sensitiveNear(W, p.entX, p.entY, T.sensitiveM)) continue;
      best = p;
      bestOff = off;
    }
    if (!best || (bestOff >= T.knifeBayM && footWay(S, f.x, f.y, e.doorX, e.doorY) <= own * T.chaseStraightRatio)) return;
    e.doorX = best.entX;
    e.doorY = best.entY;
  }

  /** The two staged blockers between the player and the door. */
  function placeBlockers(S, g) {
    var T = TLV.tune.game;
    var W = S.world;
    var e = g.errand;
    var f = S.player.foot;
    var rng = S.rng.foot;
    var near = { sw: -1, s: 0, d: 0 };
    var at = { x: 0, y: 0, h: 0 };
    g.obstacles.length = 0;
    if (!e) return;
    for (var i = 0; i < T.blockers; i++) {
      var t = (i + 1) / (T.blockers + 1);
      var x = f.x + (e.doorX - f.x) * t;
      var y = f.y + (e.doorY - f.y) * t;
      if (TLV.world.sidewalks.nearest(W, x, y, near)) {
        TLV.world.sidewalks.pointAt(W, near.sw, near.s, at);
        x = at.x;
        y = at.y;
      }
      g.obstacles.push({ id: i + 1, kind: T.blockerKinds[rng.int(T.blockerKinds.length)], x: x, y: y, r: T.blockerR, active: true });
    }
  }

  /** The chase starts, with the player on foot and him `lead` metres behind. */
  function startChase(S, k, lead) {
    var g = S.game;
    k.gap = lead;
    setStage(S, k, 'CHASE');
    S.player.veh.door = 0;
    if (g.errand) chaseDoor(S, g.errand);
    var ped = TLV.peds.byId(S, k.attackerId);
    if (ped) {
      ped.hasKnife = true;
      ped.anim = 'run';
      TLV.game.attacker._seed(S, k, ped, lead);
    }
    placeBlockers(S, g);
  }

  /** Out of the car: the side opposite the driver's door, or the driver's own if he pulled the player out. */
  function leaveCar(S, passenger) {
    var T = TLV.tune.game;
    var me = S.player.veh;
    var at = offset(me.x, me.y, me.h, 0, (passenger ? -1 : 1) * (me.width / 2 + T.bailStepM));
    TLV.foot.enter(S, at.x, at.y, me.h);
  }

  /** The player is going out the other side, so he sets off round the car to meet him. */
  function headOff(S, k) {
    var ped = TLV.peds.byId(S, k.attackerId);
    if (!ped) return;
    var me = S.player.veh;
    var at = offset(me.x, me.y, me.h, 0, -(me.width / 2 + TLV.tune.game.bailStepM));
    setWay(S, k, ped, at.x, at.y);
  }

  /** BAIL, each tick: on round the car. */
  function chaseRound(S, k, dt) {
    var ped = TLV.peds.byId(S, k.attackerId);
    if (ped && k._t.path && runWay(S, k, ped, dt)) {
      ped.v = 0;
      ped.anim = 'glare';
    }
  }

  /** Sends an inspector to a point. They arrive only when somebody has parked badly, always instantly. */
  knife._sendInspector = function (S, x, y) {
    var g = S.game;
    var T = TLV.tune.game;
    var h = Math.atan2(y - S.player.fy, x - S.player.fx);
    var p = TLV.peds.spawn(S, { kind: 'inspector', x: x + Math.cos(h) * T.inspectorFromM, y: y + Math.sin(h) * T.inspectorFromM });
    if (!p) return -1;
    if (!TLV.peds.command(S, p, { type: 'INSPECT', x: x, y: y })) {
      TLV.peds.despawn(S, p);
      return -1;
    }
    g._g.inspectors.push(p.id);
    return p.id;
  };

  /** RESOLVE: back at the car. He argues with the inspector while his car is towed, which also leaves the way out clear. */
  function toResolve(S, k) {
    var g = S.game;
    var T = TLV.tune.game;
    TLV.foot.exit(S);
    TLV.player.setLocked(S, true);
    S.player.veh.door = 0;
    g.obstacles.length = 0;
    setStage(S, k, 'RESOLVE');
    var veh = k.rivalVehId >= 0 ? TLV.traffic.byId(S, k.rivalVehId) : null;
    var ped = TLV.peds.byId(S, k.attackerId);
    if (veh) {
      // On the sidewalk by his car, out of the traffic that is about to resume.
      var side = offset(veh.x, veh.y, veh.h, 0, veh.width / 2 + T.doorStepM + 1);
      // RESOLVE is a cut, so his car can be square in the lane by now. A tow runs straight on along its heading, and from the nose-in
      // pose that is across the kerb.
      var lane = TLV.world.lanes.project(S.world, veh.x, veh.y, veh.h, T.towLaneM, {});
      var pose = lane ? TLV.world.lanes.pointAt(S.world, lane.laneId, lane.s, {}) : null;
      var near = TLV.world.sidewalks.nearest(S.world, veh.x, veh.y, { sw: -1, s: 0, d: 0 });
      if (near) {
        var at = standClear(S, veh, pose, near);
        side.x = at.x;
        side.y = at.y;
      }
      if (ped) {
        ped.x = side.x;
        ped.y = side.y;
        ped.px = side.x;
        ped.py = side.y;
        ped.v = 0;
      }
      if (S.flags.peds) knife._sendInspector(S, side.x, side.y);
      if (lane) TLV.traffic.command(S, veh, { type: 'RIVAL_STANDOFF', x: pose.x, y: pose.y, h: pose.h, durS: T.towSquareS });
      k._t.towAt = lane ? T.towSquareS + T.towWaitS : 0;
    }
    if (ped) {
      ped.hasKnife = false;
      ped.anim = 'glare';
      ped.v = 0;
    }
    if (!g.pedHitThisErrand && k.exit === 'REACHED_SHOP') TLV.game.score.bonus(S, 'EXIT_REACHED_SHOP', T.shopBonus, T.shopSeconds);
    var pay = TLV.game.score._payErrand(S);
    g.stats.errandsDone++;
    S.bus.emit('errand.paid', { index: g.errand ? g.errand.index : g.errandIndex, pay: pay, exit: k.exit });
    TLV.game.flow._setPhase(S, 'RESOLVE');
  }

  /** @returns {object} A place on the sidewalk by his car clear of its body, where it stands and where it is about to stand. */
  function standClear(S, veh, pose, near) {
    var T = TLV.tune.game;
    var walk = TLV.peds.walk;
    var sw = S.world.sidewalks[near.sw];
    var box = pose ? { x: pose.x, y: pose.y, h: pose.h, length: veh.length, width: veh.width } : veh;
    // Where the tow takes it: the same line, on past the nose.
    var run = T.towRunM / 2;
    var tow = { x: box.x + Math.cos(box.h) * run, y: box.y + Math.sin(box.h) * run, h: box.h, length: box.length + T.towRunM, width: box.width };
    var first = null;
    for (var i = 0; i <= T.standSteps; i++) {
      var along = (i % 2 ? 1 : -1) * Math.ceil(i / 2) * T.standStepM;
      var at = TLV.world.sidewalks.pointAt(S.world, near.sw, TLV.math.clamp(near.s + along, 0, sw.len), {});
      if (!first) first = at;
      if (walk.bodyDist(veh, at.x, at.y) >= T.standClearM && walk.bodyDist(tow, at.x, at.y) >= T.standClearM) return at;
    }
    return first;
  }

  /** RESOLVE, each tick: his car goes once it stands in line. */
  knife._resolveTick = function (S) {
    var k = S.game.knife;
    if (!k || k._t.towAt < 0 || S.game.phaseT < k._t.towAt) return;
    k._t.towAt = -1;
    var veh = k.rivalVehId >= 0 ? TLV.traffic.byId(S, k.rivalVehId) : null;
    if (veh) TLV.traffic.command(S, veh, { type: 'TOWED' });
  };

  /** The chase is over. */
  function finish(S, k, kind) {
    k.exit = kind;
    S.bus.emit('knife.exit', { exit: kind });
    if (kind === 'CAUGHT') {
      TLV.game.flow.endRun(S, 'CAUGHT');
      return;
    }
    toResolve(S, k);
  }

  /** CHASE, each tick. */
  function chase(S, k, dt) {
    var g = S.game;
    var T = TLV.tune.game;
    var f = S.player.foot;
    var e = g.errand;
    TLV.game.attacker.update(S, dt);
    if (k.strikes >= T.strikesToEnd) {
      if (S.params.immortal) {
        k.strikes = T.strikesToEnd - 1;
      } else {
        finish(S, k, 'CAUGHT');
        return;
      }
    }
    if (e && TLV.math.dist(f.x, f.y, e.doorX, e.doorY) <= T.doorReachM) {
      finish(S, k, 'REACHED_SHOP');
      return;
    }
    if (!k.shaken && (k.gap >= T.shakenGapM || k.outOfSightT >= T.shakenSightS)) {
      k.shaken = true;
      k.shakenT = 0;
      k.lunge = 'NONE';
      k.lungeT = 0;
    }
    if (k.shaken) {
      k.shakenT += dt;
      if (k.shakenT >= T.shakenRunS) {
        finish(S, k, 'SHAKEN');
        return;
      }
    }
    if (k.stageT >= T.chaseMaxS) finish(S, k, k.shaken ? 'SHAKEN' : 'WHISTLE');
  }

  /**
   * Tick row 12: the encounter's stages.
   * @param {object} S Sim state.
   * @param {number} dt Tick, seconds.
   */
  knife.update = function (S, dt) {
    var g = S.game;
    var k = g.knife;
    if (!k || g.phase !== 'ENCOUNTER') return;
    var T = TLV.tune.game;
    k.stageT += dt;
    switch (k.stage) {
      case 'STANDOFF':
        if (k.attackerId < 0 && k.stageT >= k._t.doorAt && doorOpen(S, k)) getOut(S, k);
        if (k.attackerId >= 0) walkToDoor(S, k, dt);
        if (k.stageT >= T.standoffS) {
          S.timeScale = 1;
          setStage(S, k, 'DOOR_TUG');
        }
        break;
      case 'DOOR_TUG':
        walkToDoor(S, k, dt);
        k.tugBar = Math.max(0, 1 - k.stageT / T.tugS);
        if (S.controls.interact) {
          k._t.lead = T.leadBase - T.leadPerS * k.stageT;
          S.player.veh.door = 2;
          setStage(S, k, 'BAIL');
          headOff(S, k);
        } else if (k.tugBar <= 0) {
          k.strikes = 1;
          S.bus.emit('knife.strike', { strikes: k.strikes });
          k._t.lead = 0;
          setStage(S, k, 'DRAGGED');
        }
        break;
      case 'BAIL':
        chaseRound(S, k, dt);
        if (k.stageT >= T.bailS) {
          leaveCar(S, true);
          startChase(S, k, k._t.lead);
        }
        break;
      case 'DRAGGED':
        if (k.stageT >= T.draggedS) {
          leaveCar(S, false);
          S.player.foot.invulnT = T.draggedInvulnS;
          startChase(S, k, 0);
        }
        break;
      case 'CHASE':
        chase(S, k, dt);
        break;
      default:
        break;
    }
  };

  /** Enters the encounter at a stage, for the debug hook. */
  knife._force = function (S, stage, gap) {
    var g = S.game;
    var T = TLV.tune.game;
    var veh = S.player.veh;
    if (!g.errand || g.errandIndex === T.legs.length - 1) return false;
    if (g.knife && g.phase === 'ENCOUNTER') return false;
    if (S.player._d.snap.active || S.player.mode === 'SNAP') TLV.player.setPose(S, veh.x, veh.y, veh.h, 0);
    veh.v = 0;
    veh.vx = 0;
    veh.vy = 0;
    if (!g.contest) TLV.game.rival.start(S, g.errand.bayId, { force: true, back: T.forceBackM, spawnOnly: true });
    knife.begin(S);
    var k = g.knife;
    var want = stage || 'STANDOFF';
    if (want === 'STANDOFF') return true;
    S.timeScale = 1;
    if (k.attackerId < 0) getOut(S, k);
    k._t.snap = true;
    walkToDoor(S, k, 0);
    if (want === 'DOOR_TUG') {
      setStage(S, k, 'DOOR_TUG');
    } else if (want === 'BAIL') {
      k._t.lead = gap === undefined ? T.leadBase : gap;
      setStage(S, k, 'BAIL');
      headOff(S, k);
    } else if (want === 'DRAGGED') {
      k.strikes = 1;
      setStage(S, k, 'DRAGGED');
    } else {
      var lead = gap === undefined ? T.leadBase : gap;
      leaveCar(S, true);
      var ped = TLV.peds.byId(S, k.attackerId);
      var f = S.player.foot;
      var back = offset(f.x, f.y, f.h, -lead, 0);
      if (ped && !TLV.world.spatial.rayBlocked(S.world, f.x, f.y, back.x, back.y)) {
        ped.x = back.x;
        ped.y = back.y;
        ped.px = back.x;
        ped.py = back.y;
      }
      startChase(S, k, lead);
    }
    return true;
  };
})(window.TLV);
