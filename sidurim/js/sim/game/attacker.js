// js/sim/game/attacker.js — WP-GAME
// The enraged driver on foot. He is a generic driver: a palette swap, a chunky cartoon knife, no name and no speech but symbols
// (GAME_DESIGN 15.3). He follows the player's breadcrumbs, so he takes the same corners, and he is in SCRIPT state, so WP-PEDS leaves
// him alone and a car that hits him only takes the penalty path.
(function (TLV) {
  'use strict';

  var attacker = TLV.ns('game.attacker');

  /** Room for a full 25 s chase of crumbs, plus the seed. */
  var CRUMBS = 128;

  /** @returns {object} Pursuit state, private to this file. */
  attacker._newState = function () {
    return {
      n: 0, x: new Float64Array(CRUMBS), y: new Float64Array(CRUMBS), arc: new Float64Array(CRUMBS),
      a: 0, crumbT: 0, ox: 0, oy: 0, slowT: 0, loseT: 0, carT: 0, hitBlock: {}, dirX: 0, dirY: 0, landed: false,
      near: [], cars: [], pt: { x: 0, y: 0 }, box: { x: 0, y: 0, h: 0, length: 0.7, width: 0.7 }, ahead: { x: 0, y: 0, h: 0, length: 0, width: 0 }
    };
  };

  /** @returns {boolean} True if the segment from p to q enters a box grown by pad. A point is a segment of no length. */
  function segEnters(box, pad, px, py, qx, qy) {
    var c = Math.cos(box.h);
    var s = Math.sin(box.h);
    var ax = (px - box.x) * c + (py - box.y) * s;
    var ay = (py - box.y) * c - (px - box.x) * s;
    var dx = (qx - box.x) * c + (qy - box.y) * s - ax;
    var dy = (qy - box.y) * c - (qx - box.x) * s - ay;
    var hl = box.length / 2 + pad;
    var hw = box.width / 2 + pad;
    var t0 = 0;
    var t1 = 1;
    var axis = [[-dx, ax + hl], [dx, hl - ax], [-dy, ay + hw], [dy, hw - ay]];
    for (var i = 0; i < 4; i++) {
      var d = axis[i][0];
      var q = axis[i][1];
      if (d === 0) {
        if (q < 0) return false;
      } else if (d < 0) {
        t0 = Math.max(t0, q / d);
      } else {
        t1 = Math.min(t1, q / d);
      }
      if (t0 > t1) return false;
    }
    return true;
  }

  /** @returns {object[]} Every car body near a point, as a box: the traffic, open doors, the player's car, and the cars parked in stalls. */
  function bodies(S, x, y, r) {
    var W = S.world;
    var out = [];
    var parking = TLV.world.parking;
    var ids = [];
    var n = parking.parkedNear(S, x, y, r, ids);
    for (var i = 0; i < n; i++) out.push(parking.boxOf(W, ids[i], parking.state(S, ids[i]), {}));
    var cars = [];
    var m = TLV.collide._carsNear(S, x, y, r, cars);
    var me = S.player.veh;
    for (var k = 0; k <= m; k++) {
      var car = k < m ? cars[k] : me;
      if (!car.active || (k < m && car.isPlayer)) continue;
      out.push(car);
      if (car.door === 1 || car.door === 2) {
        var door = {};
        TLV.collide._doorBox(car, door);
        out.push(door);
      }
    }
    return out;
  }

  /** @returns {boolean} True when something this wide can stand here: on no car and in no wall. */
  attacker._canStand = function (S, x, y, pad) {
    var T = TLV.tune.game;
    var list = bodies(S, x, y, T.routeReachM);
    for (var i = 0; i < list.length; i++) {
      if (segEnters(list[i], pad, x, y, x, y)) return false;
    }
    return !TLV.world.spatial._inSolid(S.world, x, y);
  };

  /** @returns {boolean} True when a straight line between two points meets no car and no wall. */
  function open(S, list, ax, ay, bx, by, pad) {
    for (var i = 0; i < list.length; i++) {
      if (segEnters(list[i], pad, ax, ay, bx, by)) return false;
    }
    return !TLV.world.spatial.rayBlocked(S.world, ax, ay, bx, by);
  }

  /** @returns {boolean} True when he has a straight line at the player: no lunge goes through a car. */
  attacker._clearShot = function (S, ped) {
    var T = TLV.tune.game;
    var f = S.player.foot;
    return open(S, bodies(S, ped.x, ped.y, T.routeReachM), ped.x, ped.y, f.x, f.y, 0);
  };

  /**
   * The shortest way on foot between two points round the cars: a visibility graph over the corners of their boxes, grown by a body.
   * It runs once a leg, not every tick, so it may allocate.
   * @param {object} S Sim state.
   * @param {number} ax From x.
   * @param {number} ay From y.
   * @param {number} bx To x.
   * @param {number} by To y.
   * @returns {?object[]} Points {x, y} from the start to the end, or null when cars close every way.
   */
  attacker._route = function (S, ax, ay, bx, by) {
    var T = TLV.tune.game;
    var pad = T.routeBodyM;
    var list = bodies(S, (ax + bx) / 2, (ay + by) / 2, TLV.math.dist(ax, ay, bx, by) / 2 + T.routeReachM);
    var nodes = [{ x: ax, y: ay }, { x: bx, y: by }];
    for (var i = 0; i < list.length; i++) {
      var box = list[i];
      var c = Math.cos(box.h);
      var s = Math.sin(box.h);
      for (var sx = -1; sx <= 1; sx += 2) {
        for (var sy = -1; sy <= 1; sy += 2) {
          var l = sx * (box.length / 2 + T.routeCornerM);
          var w = sy * (box.width / 2 + T.routeCornerM);
          nodes.push({ x: box.x + l * c - w * s, y: box.y + l * s + w * c });
        }
      }
    }
    var n = nodes.length;
    var cost = [];
    var from = [];
    var done = [];
    for (var q = 0; q < n; q++) {
      cost.push(Infinity);
      from.push(-1);
      done.push(false);
    }
    cost[0] = 0;
    for (;;) {
      var u = -1;
      for (var j = 0; j < n; j++) {
        if (!done[j] && cost[j] < Infinity && (u < 0 || cost[j] < cost[u])) u = j;
      }
      if (u < 0) return null;
      if (u === 1) break;
      done[u] = true;
      for (var v = 0; v < n; v++) {
        if (done[v]) continue;
        var d = cost[u] + TLV.math.dist(nodes[u].x, nodes[u].y, nodes[v].x, nodes[v].y);
        if (d >= cost[v]) continue;
        if (!open(S, list, nodes[u].x, nodes[u].y, nodes[v].x, nodes[v].y, pad)) continue;
        cost[v] = d;
        from[v] = u;
      }
    }
    var path = [];
    for (var at = 1; at >= 0; at = from[at]) path.unshift(nodes[at]);
    return path;
  };

  /** @returns {number} A polyline's length, metres. */
  attacker._length = function (path) {
    var len = 0;
    for (var i = 1; i < path.length; i++) len += TLV.math.dist(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y);
    return len;
  };

  /** Writes the point on a polyline at a distance along it, and its heading into out.h. */
  attacker._pathAt = function (path, d, out) {
    var left = d;
    for (var i = 1; i < path.length; i++) {
      var a = path[i - 1];
      var b = path[i];
      var seg = TLV.math.dist(a.x, a.y, b.x, b.y);
      out.h = Math.atan2(b.y - a.y, b.x - a.x);
      if (left <= seg || i === path.length - 1) {
        var t = seg > 1e-6 ? Math.min(1, left / seg) : 1;
        out.x = a.x + (b.x - a.x) * t;
        out.y = a.y + (b.y - a.y) * t;
        return out;
      }
      left -= seg;
    }
    out.x = path[0].x;
    out.y = path[0].y;
    return out;
  };

  /** A body is solid to him. What this moves him comes back out of his trail, so he slides round a corner and does not shake on it. */
  attacker._keepOut = function (S, ped) {
    TLV.foot._keepOutOfCars(S, ped, ped.r);
  };

  /**
   * Puts him in the world. Never null: a full pedestrian pool evicts the farthest unseen person.
   * @param {object} S Sim state.
   * @param {number} x East, metres.
   * @param {number} y North, metres.
   * @param {number} h Heading.
   * @returns {object} Pedestrian.
   */
  attacker.spawn = function (S, x, y, h) {
    var p = TLV.peds.spawn(S, { kind: 'attacker', x: x, y: y, h: h, state: 'SCRIPT' });
    p.hasKnife = false;
    p.anim = 'run';
    p.v = 0;
    return p;
  };

  /**
   * Starts the trail, by the way round whatever stands between him and the player. Between them it is `lead` metres long, however
   * long or short that way really is.
   */
  attacker._seed = function (S, k, ped, lead) {
    var a = k._a;
    var f = S.player.foot;
    var path = attacker._route(S, ped.x, ped.y, f.x, f.y) || [{ x: ped.x, y: ped.y }, { x: f.x, y: f.y }];
    var scale = Math.max(lead, 0.01) / Math.max(attacker._length(path), 0.01);
    var arc = 0;
    a.n = 0;
    for (var i = 0; i < path.length; i++) {
      if (i > 0) arc += TLV.math.dist(path[i - 1].x, path[i - 1].y, path[i].x, path[i].y) * scale;
      a.x[i] = path[i].x;
      a.y[i] = path[i].y;
      a.arc[i] = arc;
    }
    a.n = path.length;
    a.a = 0;
    a.crumbT = TLV.tune.game.crumbS;
    a.ox = 0;
    a.oy = 0;
  };

  /** Writes the point on the trail at arc s. */
  function trailAt(a, s, out) {
    var i = a.n - 2;
    while (i > 0 && a.arc[i] > s) i--;
    var span = a.arc[i + 1] - a.arc[i];
    var t = span > 1e-6 ? (s - a.arc[i]) / span : 1;
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    out.x = a.x[i] + (a.x[i + 1] - a.x[i]) * t;
    out.y = a.y[i] + (a.y[i + 1] - a.y[i]) * t;
  }

  /** Lays a crumb every 0.25 s. @returns {number} Arc of the player now. */
  function layCrumbs(S, a, dt) {
    var T = TLV.tune.game;
    var f = S.player.foot;
    var last = a.n - 1;
    var run = TLV.math.dist(f.x, f.y, a.x[last], a.y[last]);
    a.crumbT -= dt;
    if (a.crumbT <= 0 && run > 0.05 && a.n < CRUMBS) {
      a.crumbT = T.crumbS;
      a.x[a.n] = f.x;
      a.y[a.n] = f.y;
      a.arc[a.n] = a.arc[last] + run;
      a.n++;
      return a.arc[a.n - 1];
    }
    return a.arc[last] + run;
  }

  /** People slow him as they slow the player, and each staged blocker costs him 0.8 s (GAME_DESIGN 15.2). */
  function brushes(S, k, ped) {
    var T = TLV.tune.game;
    var a = k._a;
    var obstacles = S.game.obstacles;
    for (var i = 0; i < obstacles.length; i++) {
      var o = obstacles[i];
      if (!o.active || a.hitBlock[o.id]) continue;
      if (TLV.math.dist(o.x, o.y, ped.x, ped.y) <= o.r + T.blockerReachM) {
        a.hitBlock[o.id] = true;
        a.loseT = T.blockerLoseS;
      }
    }
    if (S.tick % T.sightEveryTicks !== 0) return;
    var n = TLV.peds.pedsNear(S, ped.x, ped.y, ped.r + TLV.tune.player.footRadius + T.brushReachM, a.near);
    for (var q = 0; q < n; q++) {
      if (a.near[q].id !== ped.id && a.near[q].active) a.slowT = T.brushS;
    }
  }

  /** A moving car has right of way over him: cars brake for him, and he does not run into their flanks. */
  function carsAhead(S, k, ped) {
    var T = TLV.tune.game;
    var a = k._a;
    if (S.tick % T.sightEveryTicks !== 0) return;
    var n = TLV.traffic.vehiclesNear(S, ped.x, ped.y, T.carReachM, a.cars);
    var box = a.box;
    box.x = ped.x + Math.cos(ped.h) * T.carLookM;
    box.y = ped.y + Math.sin(ped.h) * T.carLookM;
    box.h = ped.h;
    var ahead = a.ahead;
    for (var i = 0; i < n; i++) {
      var car = a.cars[i];
      if (car.isPlayer || Math.abs(car.v) < T.stoppedV) continue;
      // Where it stands and where it will be: at 5 m/s a car is on him before he has seen its flank.
      for (var t = 0; t <= T.carLeadS; t += T.carLeadS / 2) {
        ahead.x = car.x + car.vx * t;
        ahead.y = car.y + car.vy * t;
        ahead.h = car.h;
        ahead.length = car.length;
        ahead.width = car.width;
        if (TLV.math.obbGap(ahead, box) < T.carClearM) {
          a.carT = T.carHoldS;
          return;
        }
      }
    }
  }

  /** @returns {boolean} True while he stands and lets a moving car by. */
  attacker._yield = function (S, k, ped, dt) {
    var a = k._a;
    carsAhead(S, k, ped);
    if (a.carT <= 0) return false;
    a.carT -= dt;
    ped.v = 0;
    ped.anim = 'glare';
    return true;
  };

  /** Lunge phases, in the order of GAME_DESIGN 15.2. */
  function setLunge(S, k, phase) {
    k.lunge = phase;
    k.lungeT = 0;
    if (phase !== 'NONE') S.bus.emit('knife.lunge', { phase: phase });
  }

  /** A hit, if the person can take one. Foot handles the stumble and the invulnerability. */
  function land(S, k) {
    var T = TLV.tune.game;
    if (!TLV.foot.applyHit(S)) return false;
    k.strikes++;
    S.game.money -= T.lungeFine;
    S.bus.emit('knife.strike', { strikes: k.strikes });
    return true;
  }

  /** The lunge. @returns {boolean} True while it holds him off the trail. */
  function lunge(S, k, ped, dt) {
    var T = TLV.tune.game;
    var a = k._a;
    var f = S.player.foot;
    k.lungeT += dt;
    if (k.lunge === 'WINDUP') {
      ped.anim = 'lunge';
      ped.v = 0;
      ped.h = Math.atan2(f.y - ped.y, f.x - ped.x);
      if (k.lungeT >= T.lungeWindupS) {
        var dx = f.x - ped.x;
        var dy = f.y - ped.y;
        var d = Math.sqrt(dx * dx + dy * dy) || 1;
        a.dirX = dx / d;
        a.dirY = dy / d;
        a.landed = false;
        ped.h = Math.atan2(dy, dx);
        setLunge(S, k, 'STRIKE');
      }
      return true;
    }
    if (k.lunge === 'STRIKE') {
      var step = T.lungeDashM / T.lungeDashS;
      ped.x += a.dirX * step * dt;
      ped.y += a.dirY * step * dt;
      attacker._keepOut(S, ped);
      ped.v = step;
      if (!a.landed && TLV.math.dist(ped.x, ped.y, f.x, f.y) <= T.lungeHitM) a.landed = land(S, k);
      if (k.lungeT >= T.lungeDashS) {
        a.a += T.lungeDashM;
        setLunge(S, k, 'RECOVER');
      }
      return true;
    }
    ped.v = 0;
    ped.anim = 'stumble';
    if (k.lungeT >= T.lungeRecoverS) {
      trailAt(a, a.a, a.pt);
      a.ox = ped.x - a.pt.x;
      a.oy = ped.y - a.pt.y;
      setLunge(S, k, 'NONE');
    }
    return true;
  }

  /**
   * Breadcrumb pursuit and the lunge, each tick of CHASE.
   * @param {object} S Sim state.
   * @param {number} dt Tick, seconds.
   */
  attacker.update = function (S, dt) {
    var g = S.game;
    var k = g.knife;
    if (!k || k.stage !== 'CHASE') return;
    var ped = TLV.peds.byId(S, k.attackerId);
    if (!ped) return;
    var T = TLV.tune.game;
    var a = k._a;
    var arc = layCrumbs(S, a, dt);
    k.gap = arc - a.a;
    if (S.tick % T.sightEveryTicks === 0) {
      var f = S.player.foot;
      var blocked = TLV.world.spatial.rayBlocked(S.world, ped.x, ped.y, f.x, f.y);
      k.outOfSightT = blocked ? k.outOfSightT + T.sightEveryTicks * TLV.const.DT : 0;
    }
    if (k.shaken) {
      ped.v = 0;
      ped.anim = 'glare';
      return;
    }
    if (a.slowT > 0) a.slowT -= dt;
    if (a.loseT > 0) {
      a.loseT -= dt;
      ped.v = 0;
      ped.anim = 'stumble';
      return;
    }
    if (k.lunge !== 'NONE' && lunge(S, k, ped, dt)) return;
    if (k.lunge === 'NONE' && k.gap <= T.lungeGapM && attacker._clearShot(S, ped)) setLunge(S, k, 'WINDUP');
    if (attacker._yield(S, k, ped, dt)) return;
    var speed = k.gap > T.attackerFastGapM ? T.attackerFastV : T.attackerV;
    if (a.slowT > 0) speed *= T.brushScale;
    var next = Math.min(a.a + speed * dt, arc - T.attackerStopM);
    if (next < a.a) next = a.a;
    a.a = next;
    trailAt(a, a.a, a.pt);
    a.ox *= T.attackerRejoin;
    a.oy *= T.attackerRejoin;
    var nx = a.pt.x + a.ox;
    var ny = a.pt.y + a.oy;
    var mx = nx - ped.x;
    var my = ny - ped.y;
    if (mx * mx + my * my > 1e-6) ped.h = Math.atan2(my, mx);
    ped.x = nx;
    ped.y = ny;
    attacker._keepOut(S, ped);
    a.ox += ped.x - nx;
    a.oy += ped.y - ny;
    ped.v = speed;
    if (k.lunge === 'NONE') ped.anim = 'run';
    brushes(S, k, ped);
  };
})(window.TLV);
