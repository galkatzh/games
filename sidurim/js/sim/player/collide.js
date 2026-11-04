// js/sim/player/collide.js — WP-PLAYER
// Contacts for the player's car, near misses and pedestrian hits (ARCHITECTURE 9.2 row 10), and the static solver that
// DYNAMIC traffic shares. Everything here runs after traffic, people and the car have moved. Scratch space lives in
// S.player._c, so several sims can share this code.
(function (TLV) {
  'use strict';

  var collide = TLV.ns('collide');

  var BOUNDS_OWNER = -1;
  var PROP_OWNER = -3;
  var GUARD_SLOTS = 12;
  var MISS_SLOTS = 8;

  /** Key spaces of the guard on a person: a hit and a brush are guarded apart. */
  var PED_HIT = 1;
  var PED_BRUSH = 2;
  /** Key spaces for the same-body guard, so a building, a prop and a car with equal ids stay apart. */
  var KEY_VEHICLE = 1;
  var KEY_PARKED = 2;
  var KEY_STATIC = 3;
  var KEY_PROP = 4;

  function newGuards() {
    var list = [];
    for (var i = 0; i < GUARD_SLOTS; i++) list.push({ kind: 0, id: 0, until: -1, held: -1, x: 0, y: 0 });
    return list;
  }

  function newMisses() {
    var list = [];
    for (var i = 0; i < MISS_SLOTS; i++) list.push({ id: -1, gap: 0, rel: 0, x: 0, y: 0, seenT: 0, touched: false });
    return list;
  }

  /**
   * Scratch for one sim. Called by TLV.player.init.
   * @returns {object} Private to this package.
   */
  collide._newScratch = function () {
    return {
      pinT: 0,
      segs: new Int32Array(512),
      props: new Int32Array(64),
      laneIds: new Int32Array(16),
      spots: [],
      cars: [],
      people: [],
      sat: { nx: 0, ny: 0, depth: 0, cx: 0, cy: 0 },
      hit: { nx: 0, ny: 0, depth: 0, cx: 0, cy: 0, owner: 0, id: 0 },
      res: { touched: false, vn: 0, nx: 0, ny: 0, cx: 0, cy: 0, owner: 0, id: 0, fx: 0, fy: 0, x: 0, y: 0, vx: 0, vy: 0 },
      box: { x: 0, y: 0, h: 0, length: 0, width: 0 },
      door: { x: 0, y: 0, h: 0, length: 0, width: 0 },
      kerb: { kerb: 0, side: 0, paint: 0, dist: 0, h: 0 },
      out: { x: 0, y: 0 },
      guards: newGuards(),
      misses: newMisses(),
      missed: newGuards(),
      pedGuards: newGuards()
    };
  };

  /**
   * Oriented box against a segment. Separation is tested on the box's axes and the segment's normal.
   * @param {object} col W.colliders.
   * @param {number} i Collider.
   * @param {object} b Box, with x, y.
   * @param {number} c cos h.
   * @param {number} s sin h.
   * @param {number} hl Half length.
   * @param {number} hw Half width.
   * @param {number} prevX Box centre a tick ago, which says what side of a thin wall the box belongs on.
   * @param {number} prevY Same.
   * @param {object} hit Written on contact: normal pointing out of the wall toward the box, depth and contact point.
   * @returns {boolean} True on overlap.
   */
  function segContact(col, i, b, c, s, hl, hw, prevX, prevY, hit) {
    var ax = col.ax[i] - b.x;
    var ay = col.ay[i] - b.y;
    var bx = col.bx[i] - b.x;
    var by = col.by[i] - b.y;
    var la = ax * c + ay * s;
    var wa = -ax * s + ay * c;
    var lb = bx * c + by * s;
    var wb = -bx * s + by * c;
    var minL = la < lb ? la : lb;
    var maxL = la > lb ? la : lb;
    if (minL > hl || maxL < -hl) return false;
    var minW = wa < wb ? wa : wb;
    var maxW = wa > wb ? wa : wb;
    if (minW > hw || maxW < -hw) return false;
    var ex = lb - la;
    var ey = wb - wa;
    var len = Math.sqrt(ex * ex + ey * ey);
    if (len < 1e-6) return false;
    var nl = -ey / len;
    var nw = ex / len;
    var d = la * nl + wa * nw;
    var rn = hl * Math.abs(nl) + hw * Math.abs(nw);
    if (d > rn || d < -rn) return false;

    // World normal of the line, and which side the box came from. It leaves toward that side, even if it has crossed.
    var wx = nl * c - nw * s;
    var wy = nl * s + nw * c;
    var dPrev = (col.ax[i] - prevX) * wx + (col.ay[i] - prevY) * wy;
    var sign = dPrev > 0 ? 1 : (dPrev < 0 ? -1 : (d >= 0 ? 1 : -1));
    var depth = rn - sign * d;
    var nx = -sign * wx;
    var ny = -sign * wy;

    // A wall's end can poke into the box's side, and then the box's own axis is the short way out.
    var along = depth;
    var bias = 0.9;
    var d1 = hl - minL;
    var d2 = maxL + hl;
    var d3 = hw - minW;
    var d4 = maxW + hw;
    if (d1 < along * bias) { along = d1 / bias; depth = d1; nx = -c; ny = -s; }
    if (d2 < along * bias) { along = d2 / bias; depth = d2; nx = c; ny = s; }
    if (d3 < along * bias) { along = d3 / bias; depth = d3; nx = s; ny = -c; }
    if (d4 < along * bias) { along = d4 / bias; depth = d4; nx = -s; ny = c; }

    var dx = bx - ax;
    var dy = by - ay;
    var t = -(ax * dx + ay * dy) / (dx * dx + dy * dy);
    t = t < 0 ? 0 : (t > 1 ? 1 : t);
    hit.nx = nx;
    hit.ny = ny;
    hit.depth = depth;
    hit.cx = b.x + ax + dx * t;
    hit.cy = b.y + ay + dy * t;
    return true;
  }

  /**
   * Oriented box against a circle.
   * @returns {boolean} True on overlap. hit holds the normal toward the box.
   */
  function circleContact(px, py, r, b, c, s, hl, hw, hit) {
    var ex = px - b.x;
    var ey = py - b.y;
    var l = ex * c + ey * s;
    var w = -ex * s + ey * c;
    var cl = l < -hl ? -hl : (l > hl ? hl : l);
    var cw = w < -hw ? -hw : (w > hw ? hw : w);
    var dl = l - cl;
    var dw = w - cw;
    var d2 = dl * dl + dw * dw;
    if (d2 >= r * r) return false;
    var nl;
    var nw;
    var depth;
    if (d2 > 1e-10) {
      var d = Math.sqrt(d2);
      nl = -dl / d;
      nw = -dw / d;
      depth = r - d;
    } else if (hl - Math.abs(l) < hw - Math.abs(w)) {
      // The centre is inside the box, so the nearest face is the way out.
      nl = l >= 0 ? -1 : 1;
      nw = 0;
      depth = hl - Math.abs(l) + r;
    } else {
      nl = 0;
      nw = w >= 0 ? -1 : 1;
      depth = hw - Math.abs(w) + r;
    }
    hit.nx = nl * c - nw * s;
    hit.ny = nl * s + nw * c;
    hit.depth = depth;
    hit.cx = px;
    hit.cy = py;
    return true;
  }

  /**
   * The solver both paths share. Pushes a body out of walls and props, deepest first, taking the normal part out of its
   * velocity. It reports the hardest contact, and leaves the rest of the wall's response to the caller.
   * @param {object} S Sim state.
   * @param {object} b Body {x, y, h, length, width, vx, vy}, moved in place.
   * @param {number} prevX Body centre a tick ago.
   * @param {number} prevY Same.
   * @param {object} res Written: touched, vn, nx, ny, cx, cy, owner, id.
   */
  function solve(S, b, prevX, prevY, res) {
    var W = S.world;
    var T = TLV.tune.player;
    var scratch = S.player._c;
    var col = W.colliders;
    var hit = scratch.hit;
    var hl = b.length / 2;
    var hw = b.width / 2;
    var c = Math.cos(b.h);
    var s = Math.sin(b.h);
    var reach = Math.sqrt(hl * hl + hw * hw) + T.searchPad;
    var nSegs = TLV.world.spatial.collidersNear(W, b.x, b.y, reach, scratch.segs);
    var nProps = TLV.world.spatial.propsNear(W, b.x, b.y, reach + 0.5, scratch.props);
    res.touched = false;
    res.vn = 0;
    res.pressed = false;
    if (nSegs === 0 && nProps === 0) return;
    var i;
    for (var pass = 0; pass < T.solverIterations; pass++) {
      var bestDepth = T.solverSkin;
      var bestNx = 0;
      var bestNy = 0;
      var bestCx = 0;
      var bestCy = 0;
      var bestOwner = 0;
      var bestId = 0;
      for (i = 0; i < nSegs; i++) {
        if (segContact(col, scratch.segs[i], b, c, s, hl, hw, prevX, prevY, hit) && hit.depth > bestDepth) {
          bestDepth = hit.depth;
          bestNx = hit.nx;
          bestNy = hit.ny;
          bestCx = hit.cx;
          bestCy = hit.cy;
          bestOwner = col.owner[scratch.segs[i]];
          bestId = bestOwner;
        }
      }
      for (i = 0; i < nProps; i++) {
        var prop = W.props[scratch.props[i]];
        if (circleContact(prop.x, prop.y, prop.r, b, c, s, hl, hw, hit) && hit.depth > bestDepth) {
          bestDepth = hit.depth;
          bestNx = hit.nx;
          bestNy = hit.ny;
          bestCx = hit.cx;
          bestCy = hit.cy;
          bestOwner = PROP_OWNER;
          bestId = prop.id;
        }
      }
      if (bestDepth <= T.solverSkin) break;
      b.x += bestNx * bestDepth;
      b.y += bestNy * bestDepth;
      var vn = -(b.vx * bestNx + b.vy * bestNy);
      if (!res.touched || vn > res.vn) {
        res.touched = true;
        res.vn = vn > 0 ? vn : 0;
        res.nx = bestNx;
        res.ny = bestNy;
        res.cx = bestCx;
        res.cy = bestCy;
        res.owner = bestOwner;
        res.id = bestId;
      }
      if (vn > 0) {
        b.vx += bestNx * vn;
        b.vy += bestNy * vn;
        res.pressed = true;
      }
    }
  }

  /**
   * What a wall does to speed. Below the glance angle a hit keeps 85% of its tangential speed, and it falls toward the
   * square-on share past that. A hard hit bounces, so it never ends in a dead stop.
   * @param {object} b Body whose velocity has lost its normal part.
   * @param {object} res From solve.
   * @param {boolean} first True if this is a new hit, not a car already sliding along the wall.
   */
  function wallResponse(b, res, first) {
    var T = TLV.tune.player;
    // Under the contact speed this is a car leaning on a wall, not a hit, and it would otherwise pay every tick.
    if (!first || res.vn < T.contactMinVn) return;
    var vt = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    var angle = Math.atan2(res.vn, vt);
    var glance = T.glanceDeg * Math.PI / 180;
    var keep = T.glanceKeep;
    if (angle > glance) keep += (T.squareKeep - T.glanceKeep) * (angle - glance) / (Math.PI / 2 - glance);
    b.vx *= keep;
    b.vy *= keep;
    b.vx += res.nx * res.vn * T.restitution;
    b.vy += res.ny * res.vn * T.restitution;
  }

  /** @returns {number} Guard slot holding a body, or -1. */
  function guardSlot(list, kind, id) {
    for (var i = 0; i < GUARD_SLOTS; i++) {
      if (list[i].kind === kind && list[i].id === id) return i;
    }
    return -1;
  }

  /** @returns {boolean} True if the guard still holds this body at time t. */
  function guarded(list, kind, id, t) {
    var i = guardSlot(list, kind, id);
    return i >= 0 && (list[i].until > t || list[i].held > t);
  }

  /** Starts or extends a guard, replacing the entry that ends first. */
  function setGuard(list, kind, id, until) {
    var i = guardSlot(list, kind, id);
    if (i < 0) {
      i = 0;
      for (var k = 1; k < GUARD_SLOTS; k++) {
        if (list[k].until < list[i].until) i = k;
      }
    }
    list[i].kind = kind;
    list[i].id = id;
    list[i].until = until;
    list[i].held = -1;
  }

  /**
   * Keeps the guard of a body the car has paid for and has not left. One press is one hit, however long it leans or grinds, so the guard
   * also counts from the last touch. A car with the gas down bounces off and comes back, and that can take longer than the guard: if
   * it comes back at a scrape's speed, soon, and has stayed in the same place, it is the same press. A car that drove off, or that comes
   * back hard, is hitting the body anew.
   * @param {object} S Sim state.
   * @param {object} veh The player's car.
   * @param {number} kind Key space.
   * @param {number} id Body.
   * @param {number} vn Closing speed.
   */
  function holdGuard(S, veh, kind, id, vn) {
    var T = TLV.tune.player;
    var list = S.player._c.guards;
    var i = guardSlot(list, kind, id);
    S.player.touchT = S.t;
    if (i < 0) return;
    var g = list[i];
    var dx = veh.x - g.x;
    var dy = veh.y - g.y;
    var rocking = vn < T.bumpVn && S.t < g.held + T.pressRockS && dx * dx + dy * dy < T.pressRoomM * T.pressRoomM;
    if (!rocking && g.until <= S.t && g.held <= S.t) return;
    g.held = S.t + T.bodyGuardS;
    g.x = veh.x;
    g.y = veh.y;
  }

  /** A car put somewhere else has left whatever it was touching. A hit stays guarded for its own 0.5 s. */
  collide._leftBodies = function (S) {
    var list = S.player._c.guards;
    for (var i = 0; i < GUARD_SLOTS; i++) list[i].held = -1;
    S.player.touchT = -1e9;
  };

  /** @returns {string} Severity of a normal closing speed (GAME_DESIGN 8.1). */
  function severity(vn) {
    var T = TLV.tune.player;
    if (vn < T.bumpVn) return 'scrape';
    return vn <= T.crashVn ? 'bump' : 'crash';
  }

  /**
   * Emits player.contact unless the speed is too low or the same body hit within the guard.
   * @returns {boolean} True when this counts as a new hit.
   */
  function report(S, key, kind, otherId, vn, rearEnded, x, y) {
    var T = TLV.tune.player;
    var scratch = S.player._c;
    if (vn < T.contactMinVn) return false;
    if (guarded(scratch.guards, key, otherId, S.t)) return false;
    setGuard(scratch.guards, key, otherId, S.t + T.bodyGuardS);
    var g = scratch.guards[guardSlot(scratch.guards, key, otherId)];
    g.held = g.until;
    g.x = S.player.veh.x;
    g.y = S.player.veh.y;
    S.bus.emit('player.contact', {
      kind: kind, otherId: otherId, vn: vn, severity: severity(vn), rearEnded: rearEnded, x: x, y: y
    });
    return true;
  }

  /** Turns the car toward the wall it is against, so it slides along it and cannot sit pressed into it. */
  function alignToWall(S, veh, nx, ny, throttled, vn, first, dt) {
    var T = TLV.tune.player;
    var math = TLV.math;
    var d = S.player._d;
    var tangent = Math.atan2(nx, -ny);
    var off = math.wrapPi(tangent - veh.h);
    if (off > Math.PI / 2) off -= Math.PI;
    else if (off < -Math.PI / 2) off += Math.PI;
    if (off === 0 && throttled) off = d.steerN >= 0 ? 0.01 : -0.01;
    var speed = Math.abs(veh.v);
    var rate;
    if (speed > 2 && Math.abs(off) < T.wallAlignMaxDeg * Math.PI / 180) rate = T.wallAlignRate;
    else if (throttled) rate = T.wallPivotRate;
    else return;
    var step = math.clamp(off, -rate * dt, rate * dt);
    if (first && vn >= T.bumpVn) {
      var kick = Math.min(T.yawKickMax, vn * T.yawKickPerVn);
      step += off >= 0 ? kick : -kick;
    }
    veh.h = math.wrapPi(veh.h + step);
  }

  /** Walls and props, for the player's car. */
  function staticContacts(S, veh, dt) {
    var scratch = S.player._c;
    var res = scratch.res;
    solve(S, veh, veh.px, veh.py, res);
    if (!res.touched) return;
    var owner = res.owner;
    var key = owner === PROP_OWNER ? KEY_PROP : KEY_STATIC;
    var isBounds = owner === BOUNDS_OWNER;
    holdGuard(S, veh, key, res.id, res.vn);
    var fresh = !guarded(scratch.guards, key, res.id, S.t);
    wallResponse(veh, res, fresh);
    if (!isBounds) report(S, key, 'static', res.id, res.vn, false, res.cx, res.cy);
    TLV.player._syncVelocity(S);
    if (S.player.mode === 'DRIVE' && res.pressed) alignToWall(S, veh, res.nx, res.ny, S.controls.throttle > 0, res.vn, fresh, dt);
    if (collide._inSolid(S.world, veh.x, veh.y)) evict(S, veh);
  }

  /** Moves a car that ended inside a building, as after a teleport, to the nearest clear ground. */
  function evict(S, veh) {
    var out = S.player._c.out;
    if (!clearPoint(S, veh.x, veh.y, veh.width, out)) return;
    veh.x = out.x;
    veh.y = out.y;
  }

  /** Static parked cars and motorcycles. They respond like walls, and they are a body of their own. */
  function parkedContacts(S, veh, dt) {
    var T = TLV.tune.player;
    var W = S.world;
    var math = TLV.math;
    var scratch = S.player._c;
    var spots = scratch.spots;
    var box = scratch.box;
    var sat = scratch.sat;
    var res = scratch.res;
    var count = TLV.world.parking.parkedNear(S, veh.x, veh.y, T.nearScanM - 2, spots);
    for (var i = 0; i < count; i++) {
      var id = spots[i];
      TLV.world.parking.boxOf(W, id, TLV.world.parking.state(S, id), box);
      if (!math.obbSat(veh, box, sat)) continue;
      veh.x -= sat.nx * sat.depth;
      veh.y -= sat.ny * sat.depth;
      var vn = veh.vx * sat.nx + veh.vy * sat.ny;
      holdGuard(S, veh, KEY_PARKED, id, vn);
      if (vn <= 0) continue;
      veh.vx -= sat.nx * vn;
      veh.vy -= sat.ny * vn;
      res.vn = vn;
      res.nx = -sat.nx;
      res.ny = -sat.ny;
      var fresh = !guarded(scratch.guards, KEY_PARKED, id, S.t);
      wallResponse(veh, res, fresh);
      report(S, KEY_PARKED, 'parked', id, vn, false, sat.cx, sat.cy);
      TLV.player._syncVelocity(S);
      if (S.player.mode === 'DRIVE') alignToWall(S, veh, res.nx, res.ny, S.controls.throttle > 0, vn, fresh, dt);
    }
  }

  /** @returns {number} Vehicles near a point, from the broadphase, or by scanning the pool when there is no WP-TRAFFIC. */
  function carsNear(S, x, y, r, out) {
    var traffic = TLV.traffic;
    if (traffic && traffic.vehiclesNear) return traffic.vehiclesNear(S, x, y, r, out);
    var n = 0;
    for (var i = 1; i < S.vehicles.length; i++) {
      var v = S.vehicles[i];
      if (!v.active) continue;
      var dx = v.x - x;
      var dy = v.y - y;
      if (dx * dx + dy * dy <= r * r) out[n++] = v;
    }
    out.length = n;
    return n;
  }
  collide._carsNear = carsNear;

  /** @returns {number} People near a point, likewise. */
  function peopleNear(S, x, y, r, out) {
    var peds = TLV.peds;
    if (peds && peds.pedsNear) return peds.pedsNear(S, x, y, r, out);
    var n = 0;
    for (var i = 0; i < S.peds.length; i++) {
      var p = S.peds[i];
      if (!p.active) continue;
      var dx = p.x - x;
      var dy = p.y - y;
      if (dx * dx + dy * dy <= r * r) out[n++] = p;
    }
    out.length = n;
    return n;
  }
  collide._peopleNear = peopleNear;

  /** @returns {number} A vehicle's weight relative to the player's hatch. */
  function massOf(o) {
    var m = TLV.tune.player.mass[o.kind];
    return m === undefined ? 1 : m;
  }

  /** Rear-ended: hit from behind while going straight or braking, by a car that was doing the closing (GAME_DESIGN 8.1). */
  function isRearEnd(S, veh, o, nx, ny) {
    var T = TLV.tune.player;
    if (veh.v < -T.restSpeed) return false;
    var c = Math.cos(veh.h);
    var s = Math.sin(veh.h);
    if (nx * c + ny * s > -T.rearDot) return false;
    if ((o.vx - veh.vx) * c + (o.vy - veh.vy) * s <= 0) return false;
    return S.controls.brake > 0 || Math.abs(S.player._d.steerN) <= T.rearSteerShare || Math.abs(veh.yawRate) <= T.rearYawRate;
  }

  /** One car against one solid box of a vehicle. The box is the vehicle, or its open door. */
  function carContact(S, veh, o, box, sat) {
    var T = TLV.tune.player;
    if (!TLV.math.obbSat(veh, box, sat)) return false;
    veh.x -= sat.nx * sat.depth;
    veh.y -= sat.ny * sat.depth;
    var vn = (veh.vx - o.vx) * sat.nx + (veh.vy - o.vy) * sat.ny;
    holdGuard(S, veh, KEY_VEHICLE, o.id, vn);
    if (vn <= 0) return true;
    var rear = isRearEnd(S, veh, o, sat.nx, sat.ny);
    var mo = massOf(o);
    var mp = massOf(veh);
    var j = (1 + T.carRestitution) * vn / (1 / mp + 1 / mo);
    veh.vx -= sat.nx * j / mp;
    veh.vy -= sat.ny * j / mp;
    TLV.player._syncVelocity(S);
    report(S, KEY_VEHICLE, 'vehicle', o.id, vn, rear, sat.cx, sat.cy);
    // The guard is about what a contact costs. The other car is shoved either way.
    if (vn >= T.contactMinVn && TLV.traffic && TLV.traffic.applyImpact) {
      TLV.traffic.applyImpact(S, o, sat.nx * j / mo, sat.ny * j / mo);
    }
    return true;
  }

  /** Writes a vehicle's open door as a box (ARCHITECTURE 13.1, DOOR_OPEN). @returns {boolean} False with the door shut. */
  function doorBox(o, out) {
    if (o.door !== 1 && o.door !== 2) return false;
    var side = o.door === 1 ? 1 : -1;
    var c = Math.cos(o.h);
    var s = Math.sin(o.h);
    var fwd = 0.25 * o.length;
    var lat = side * (o.width / 2 + 0.5);
    out.x = o.x + fwd * c - lat * s;
    out.y = o.y + fwd * s + lat * c;
    out.h = o.h + Math.PI / 2;
    out.length = 1;
    out.width = 0.2;
    return true;
  }

  collide._doorBox = doorBox;

  /** @returns {number} Slot tracking a pass by this vehicle, or -1. */
  function missSlot(list, id) {
    for (var i = 0; i < MISS_SLOTS; i++) {
      if (list[i].id === id) return i;
    }
    return -1;
  }

  /** Keeps the closest moment of a pass by a vehicle. The event fires when the pass ends, so one pass pays one tier. */
  function trackMiss(S, veh, o, gap) {
    var T = TLV.tune.player;
    var list = S.player._c.misses;
    var i = missSlot(list, o.id);
    if (gap > T.nearMissGap + 1e-6) return;
    var dvx = veh.vx - o.vx;
    var dvy = veh.vy - o.vy;
    var rel = Math.sqrt(dvx * dvx + dvy * dvy);
    if (rel < T.nearMissSpeed - 1e-6) return;
    if (i < 0) {
      if (guarded(S.player._c.missed, KEY_VEHICLE, o.id, S.t)) return;
      for (var k = 0; k < MISS_SLOTS && i < 0; k++) {
        if (list[k].id < 0) i = k;
      }
      if (i < 0) return;
      list[i].id = o.id;
      list[i].gap = Infinity;
      list[i].touched = false;
    }
    var m = list[i];
    m.seenT = S.t;
    if (gap < m.gap) {
      m.gap = gap;
      m.rel = rel;
      m.x = veh.x;
      m.y = veh.y;
    }
  }

  /** Ends every pass that was not renewed this tick. */
  function flushMisses(S) {
    var T = TLV.tune.player;
    var scratch = S.player._c;
    var list = scratch.misses;
    for (var i = 0; i < MISS_SLOTS; i++) {
      var m = list[i];
      if (m.id < 0 || m.seenT === S.t) continue;
      if (!m.touched) {
        setGuard(scratch.missed, KEY_VEHICLE, m.id, S.t + T.nearMissCooldownS);
        S.bus.emit('player.nearMiss', {
          vehId: m.id, gap: m.gap, relSpeed: m.rel, tier: m.gap <= T.hairGap + 1e-6 ? 2 : 1, x: m.x, y: m.y
        });
      }
      m.id = -1;
    }
  }

  /** Marks a car touched, so its pass pays nothing. */
  function spoilMiss(S, id) {
    var list = S.player._c.misses;
    var i = missSlot(list, id);
    if (i >= 0) {
      list[i].touched = true;
      list[i].seenT = S.t;
    }
  }

  /** Other vehicles: contacts, the near-miss watch, and the parts of each. */
  function vehicleContacts(S, veh) {
    var T = TLV.tune.player;
    var math = TLV.math;
    var scratch = S.player._c;
    var cars = scratch.cars;
    var sat = scratch.sat;
    var door = scratch.door;
    var drive = S.player.mode === 'DRIVE';
    var count = carsNear(S, veh.x, veh.y, T.nearScanM, cars);
    for (var i = 0; i < count; i++) {
      var o = cars[i];
      if (!o.active || o === veh || o.isPlayer) continue;
      var touched = carContact(S, veh, o, o, sat);
      if (doorBox(o, door) && carContact(S, veh, o, door, sat)) touched = true;
      if (touched) spoilMiss(S, o.id);
      else if (drive && o.mode !== 'PARKED') trackMiss(S, veh, o, math.obbGap(veh, o));
    }
    flushMisses(S);
  }

  /**
   * People. A moving car hits, and a stopped one is only brushed. Contact never moves the car. Someone already stumbling from a hit has
   * been hit: one accident is one hit, however long the car takes to get clear of them, and the 1 s guard alone would not hold for that.
   * A brush is no accident, so it has a guard of its own: a car that creeps up against someone and then drives on hits them.
   */
  function pedContacts(S, veh, scripted) {
    var T = TLV.tune.player;
    var scratch = S.player._c;
    var people = scratch.people;
    var hit = scratch.hit;
    var hl = veh.length / 2;
    var hw = veh.width / 2;
    var c = Math.cos(veh.h);
    var s = Math.sin(veh.h);
    var reach = Math.sqrt(hl * hl + hw * hw) + 1;
    var count = peopleNear(S, veh.x, veh.y, reach, people);
    var speed = Math.abs(veh.v);
    for (var i = 0; i < count; i++) {
      var ped = people[i];
      if (!ped.active) continue;
      if (!circleContact(ped.x, ped.y, ped.r, veh, c, s, hl, hw, hit)) continue;
      var moving = speed >= T.hitMinSpeed && !scripted && ped.state !== 'STUMBLE';
      var inAccident = guarded(scratch.pedGuards, PED_HIT, ped.id, S.t);
      var brushing = guarded(scratch.pedGuards, PED_BRUSH, ped.id, S.t);
      if (moving || inAccident) setGuard(scratch.pedGuards, PED_HIT, ped.id, S.t + T.pedClearS);
      else setGuard(scratch.pedGuards, PED_BRUSH, ped.id, S.t + T.pedClearS);
      if (inAccident || (!moving && brushing)) continue;
      if (moving) {
        var ix = speed > 0 ? veh.vx / speed : 0;
        var iy = speed > 0 ? veh.vy / speed : 0;
        var kind = ped.kind;
        if (TLV.peds && TLV.peds.onHit) TLV.peds.onHit(S, ped, ix, iy, speed);
        S.bus.emit('player.hitPed', { pedId: ped.id, pedKind: kind, speed: speed, x: ped.x, y: ped.y });
      } else {
        if (TLV.peds && TLV.peds.onBrush) TLV.peds.onBrush(S, ped);
        S.bus.emit('player.brushPed', { pedId: ped.id });
      }
    }
  }

  /** @returns {boolean} True when a corner of the car stands on water. Writes the mean wet offset. */
  function wetCorners(W, veh, sum) {
    var WATER = TLV.const.SURF.WATER;
    var surface = TLV.world.surface;
    var hl = veh.length / 2;
    var hw = veh.width / 2;
    var c = Math.cos(veh.h);
    var s = Math.sin(veh.h);
    var wet = 0;
    sum.x = 0;
    sum.y = 0;
    for (var i = 0; i < 4; i++) {
      var l = i & 1 ? hl : -hl;
      var w = i & 2 ? hw : -hw;
      var ox = l * c - w * s;
      var oy = l * s + w * c;
      if (surface.at(W, veh.x + ox, veh.y + oy) === WATER) {
        wet++;
        sum.x += ox;
        sum.y += oy;
      }
    }
    return wet > 0;
  }

  /**
   * WATER is a solid edge with no cost: it stops the car, says one line, and is never a contact (ARCHITECTURE 12.4).
   * The raster has no outline to collide with, so the car steps back from its wet corners until they are dry.
   */
  function waterEdge(S, veh, dt) {
    var T = TLV.tune.player;
    var W = S.world;
    var d = S.player._d;
    var sum = S.player._c.out;
    if (!wetCorners(W, veh, sum)) {
      d.dryX = veh.x;
      d.dryY = veh.y;
      d.dryH = veh.h;
      return;
    }
    if (S.t - d.waterT >= T.waterEventS) {
      d.waterT = S.t;
      S.bus.emit('player.waterEdge', { x: veh.x, y: veh.y });
    }
    var len = Math.sqrt(sum.x * sum.x + sum.y * sum.y);
    var nx;
    var ny;
    if (len > 1e-6) {
      nx = -sum.x / len;
      ny = -sum.y / len;
    } else {
      // Four wet corners cancel. Back along the way in.
      var vl = Math.sqrt(veh.vx * veh.vx + veh.vy * veh.vy) || 1;
      nx = -veh.vx / vl;
      ny = -veh.vy / vl;
    }
    var moved = false;
    for (var step = T.waterStepM; step <= T.waterBackM; step += T.waterStepM) {
      veh.x += nx * T.waterStepM;
      veh.y += ny * T.waterStepM;
      if (!wetCorners(W, veh, sum)) {
        moved = true;
        break;
      }
    }
    if (!moved) {
      veh.x = d.dryX;
      veh.y = d.dryY;
      veh.h = d.dryH;
      if (wetCorners(W, veh, sum)) {
        // Teleported onto water: the last dry pose is wet too.
        var out = S.player._c.out;
        if (clearPoint(S, veh.x, veh.y, veh.width, out)) {
          veh.x = out.x;
          veh.y = out.y;
        }
      }
    }
    var vn = -(veh.vx * nx + veh.vy * ny);
    if (vn > 0) {
      veh.vx += nx * vn;
      veh.vy += ny * vn;
    }
    TLV.player._syncVelocity(S);
    if (S.player.mode === 'DRIVE') alignToWall(S, veh, nx, ny, S.controls.throttle > 0, 0, false, dt);
  }

  /**
   * Tick row 10.
   * @param {object} S Sim state.
   * @param {number} dt Tick, seconds.
   */
  collide.update = function (S, dt) {
    var p = S.player;
    if (p.mode === 'FOOT' || !S.world) return;
    var veh = p.veh;
    if (p.mode === 'SNAP') {
      if (!p._d.snap.ghost) pedContacts(S, veh, true);
      return;
    }
    var moving = veh.vx !== 0 || veh.vy !== 0;
    if (p.mode === 'DRIVE') vehicleContacts(S, veh);
    if (moving || p.mode === 'DRIVE') {
      parkedContacts(S, veh, dt);
      staticContacts(S, veh, dt);
      waterEdge(S, veh, dt);
    }
    pedContacts(S, veh, false);
    if (p.mode === 'DRIVE') pinned(S, veh, dt);
    p.fx = veh.x;
    p.fy = veh.y;
  };

  /**
   * A car pressed against something that does not give stays where it is while its speed says otherwise, and Recover, which asks for
   * a car going under 1 m/s, stays out of reach. After a moment of that, speed is what the body really did.
   */
  function pinned(S, veh, dt) {
    var T = TLV.tune.player;
    var scratch = S.player._c;
    var moved = Math.sqrt((veh.x - veh.px) * (veh.x - veh.px) + (veh.y - veh.py) * (veh.y - veh.py)) / dt;
    var told = Math.abs(veh.v);
    if (moved >= told * T.pinnedShare) {
      scratch.pinT = 0;
      return;
    }
    // Once held it stays held for as long as it does not move: the throttle puts back a little speed each tick.
    if (told >= T.pinnedV || scratch.pinT >= T.pinnedS) scratch.pinT += dt;
    if (scratch.pinT < T.pinnedS) return;
    var keep = moved / told;
    veh.vx *= keep;
    veh.vy *= keep;
    TLV.player._syncVelocity(S);
  }

  /**
   * Pushes a body out of colliders and props, and corrects its velocity. DYNAMIC traffic uses this. It costs no contact.
   * @param {object} S Sim state.
   * @param {object} body {x, y, h, length, width, vx, vy}. Pose and velocity are corrected in place.
   * @param {object} [out] Also written: x, y, vx, vy, vn, nx, ny, owner, with the wall's normal and the closing speed.
   * @returns {boolean} True if the body was touching anything.
   */
  collide.resolveStatic = function (S, body, out) {
    var res = S.player._c.res;
    var dt = TLV.const.DT;
    var prevX = body.px !== undefined ? body.px : body.x - body.vx * dt;
    var prevY = body.py !== undefined ? body.py : body.y - body.vy * dt;
    solve(S, body, prevX, prevY, res);
    if (res.touched) wallResponse(body, res, res.vn >= TLV.tune.player.contactMinVn);
    if (out) {
      out.x = body.x;
      out.y = body.y;
      out.vx = body.vx;
      out.vy = body.vy;
      out.vn = res.touched ? res.vn : 0;
      out.nx = res.touched ? res.nx : 0;
      out.ny = res.touched ? res.ny : 0;
      out.owner = res.touched ? res.owner : 0;
    }
    return res.touched;
  };

  /**
   * @param {object} S Sim state.
   * @returns {boolean} True when the car's body reaches the kerb line beside it. WP-GAME reads this for PERFECT.
   */
  collide.touchingKerb = function (S) {
    if (!S.world) return false;
    var T = TLV.tune.player;
    var veh = S.player.veh;
    var kerb = S.player._c.kerb;
    var hl = veh.length / 2;
    var hw = veh.width / 2;
    var reach = Math.sqrt(hl * hl + hw * hw) + T.kerbTouchM;
    if (!TLV.world.parking.kerbAt(S.world, veh.x, veh.y, reach, kerb)) return false;
    var off = veh.h - kerb.h;
    var across = Math.abs(Math.sin(off)) * hl + Math.abs(Math.cos(off)) * hw;
    return kerb.dist <= across + T.kerbTouchM;
  };

  /**
   * True when a point is inside a footprint with a collider.
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @returns {boolean}
   */
  collide._inSolid = function (W, x, y) {
    var id = TLV.world.spatial.pointInBuilding(W, x, y);
    return id >= 0 && !(W.blds[id].flags & 1);
  };

  /** @returns {number} Distance from a point to the nearest wall in reach, or Infinity. */
  function wallDistance(S, x, y, reach) {
    var W = S.world;
    var col = W.colliders;
    var scratch = S.player._c;
    var n = TLV.world.spatial.collidersNear(W, x, y, reach, scratch.segs);
    var best = Infinity;
    for (var i = 0; i < n; i++) {
      var id = scratch.segs[i];
      var d = TLV.math.pointSegDist(x, y, col.ax[id], col.ay[id], col.bx[id], col.by[id]);
      if (d < best) best = d;
    }
    return best;
  }

  /** @returns {boolean} True when a disc stands clear of one box. */
  function clearOfBox(x, y, r, box) {
    var c = Math.cos(box.h);
    var s = Math.sin(box.h);
    var ex = x - box.x;
    var ey = y - box.y;
    var l = Math.abs(ex * c + ey * s) - box.length / 2;
    var w = Math.abs(-ex * s + ey * c) - box.width / 2;
    if (l < 0) l = 0;
    if (w < 0) w = 0;
    return l * l + w * w >= r * r;
  }

  /** @returns {boolean} True when a disc stands clear of parked cars, vehicles and the player's car. */
  function clearOfCars(S, x, y, r) {
    var T = TLV.tune.player;
    var W = S.world;
    var scratch = S.player._c;
    var parking = TLV.world.parking;
    var box = scratch.box;
    var i;
    var count = parking.parkedNear(S, x, y, T.nearScanM - 4, scratch.spots);
    for (i = 0; i < count; i++) {
      var id = scratch.spots[i];
      parking.boxOf(W, id, parking.state(S, id), box);
      if (!clearOfBox(x, y, r, box)) return false;
    }
    var near = carsNear(S, x, y, T.nearScanM, scratch.cars);
    for (i = 0; i < near; i++) {
      if (scratch.cars[i].active && !clearOfBox(x, y, r, scratch.cars[i])) return false;
    }
    return clearOfBox(x, y, r, S.player.veh);
  }

  /** @returns {boolean} True when a disc stands clear of walls, water, footprints and props, and of cars if asked. */
  function isClear(S, x, y, r, withCars) {
    var W = S.world;
    if (collide._inSolid(W, x, y)) return false;
    if (TLV.world.surface.at(W, x, y) === TLV.const.SURF.WATER) return false;
    if (wallDistance(S, x, y, r + 0.05) <= r) return false;
    var props = S.player._c.props;
    var n = TLV.world.spatial.propsNear(W, x, y, r + 0.6, props);
    for (var i = 0; i < n; i++) {
      var p = W.props[props[i]];
      var dx = p.x - x;
      var dy = p.y - y;
      var want = r + p.r;
      if (dx * dx + dy * dy < want * want) return false;
    }
    return !withCars || clearOfCars(S, x, y, r);
  }

  /**
   * Nearest clear ground, by rings around a point. Rare, so a plain search will do.
   * @param {object} S Sim state.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} r Clearance, metres.
   * @param {{x:number,y:number}} out Written.
   * @param {boolean} [withCars] Stand clear of parked cars and vehicles too, as a person must.
   * @returns {boolean} False if nothing is clear within reach.
   */
  function clearPoint(S, x, y, r, out, withCars) {
    var T = TLV.tune.player;
    if (isClear(S, x, y, r, withCars)) {
      out.x = x;
      out.y = y;
      return true;
    }
    for (var d = T.escapeStepM; d <= T.escapeMaxM; d += T.escapeStepM) {
      for (var i = 0; i < T.escapeAngles; i++) {
        var a = i * 2 * Math.PI / T.escapeAngles;
        var px = x + d * Math.cos(a);
        var py = y + d * Math.sin(a);
        if (isClear(S, px, py, r, withCars)) {
          out.x = px;
          out.y = py;
          return true;
        }
      }
    }
    return false;
  }
  collide._clearPoint = clearPoint;
})(window.TLV);
