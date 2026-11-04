// js/sim/player/foot.js — WP-PLAYER
// The on-foot character (GAME_DESIGN 15 and 16). One capped state machine that exists only during CHASE: run, sidestep,
// stumble. Nobody can be hurt on foot, so everything solid only stops the person, and people only slow them.
(function (TLV) {
  'use strict';

  var foot = TLV.ns('foot');

  var KIND_PERSON = 1;
  var KIND_OBSTACLE = 2;

  /** Keeps a disc out of a box, by the nearest way. @returns {boolean} True if it was moved. */
  function pushOutOfBox(f, r, box) {
    var c = Math.cos(box.h);
    var s = Math.sin(box.h);
    var ex = f.x - box.x;
    var ey = f.y - box.y;
    var l = ex * c + ey * s;
    var w = -ex * s + ey * c;
    var hl = box.length / 2;
    var hw = box.width / 2;
    var cl = l < -hl ? -hl : (l > hl ? hl : l);
    var cw = w < -hw ? -hw : (w > hw ? hw : w);
    var dl = l - cl;
    var dw = w - cw;
    var d2 = dl * dl + dw * dw;
    if (d2 >= r * r) return false;
    if (d2 > 1e-10) {
      var d = Math.sqrt(d2);
      l = cl + dl / d * r;
      w = cw + dw / d * r;
    } else if (hl - Math.abs(l) < hw - Math.abs(w)) {
      l = (l >= 0 ? 1 : -1) * (hl + r);
    } else {
      w = (w >= 0 ? 1 : -1) * (hw + r);
    }
    f.x = box.x + l * c - w * s;
    f.y = box.y + l * s + w * c;
    return true;
  }

  /** Keeps a disc out of walls and props. A wall keeps the disc on the side it came from. */
  function pushOutOfStatics(S, f, r, prevX, prevY) {
    var W = S.world;
    var col = W.colliders;
    var scratch = S.player._c;
    var math = TLV.math;
    var spatial = TLV.world.spatial;
    var reach = r + 0.6;
    var n = spatial.collidersNear(W, f.x, f.y, reach, scratch.segs);
    var i;
    for (i = 0; i < n; i++) {
      var id = scratch.segs[i];
      var ax = col.ax[id];
      var ay = col.ay[id];
      var bx = col.bx[id];
      var by = col.by[id];
      var dx = bx - ax;
      var dy = by - ay;
      var len2 = dx * dx + dy * dy;
      if (len2 < 1e-9) continue;
      var t = ((f.x - ax) * dx + (f.y - ay) * dy) / len2;
      t = t < 0 ? 0 : (t > 1 ? 1 : t);
      var qx = ax + dx * t;
      var qy = ay + dy * t;
      var ex = f.x - qx;
      var ey = f.y - qy;
      var d = Math.sqrt(ex * ex + ey * ey);
      var sidePrev = dx * (prevY - ay) - dy * (prevX - ax);
      var sideNow = dx * (f.y - ay) - dy * (f.x - ax);
      var crossed = sidePrev * sideNow < 0 && math.segSegHit(prevX, prevY, f.x, f.y, ax, ay, bx, by);
      if (d >= r && !crossed) continue;
      if (crossed || d < 1e-9) {
        // The disc went through the line, so it goes back to the side it came from.
        var ll = Math.sqrt(len2);
        var sign = sidePrev >= 0 ? 1 : -1;
        f.x = qx - dy / ll * sign * r;
        f.y = qy + dx / ll * sign * r;
      } else {
        f.x = qx + ex / d * r;
        f.y = qy + ey / d * r;
      }
    }
    var m = spatial.propsNear(W, f.x, f.y, reach + 0.5, scratch.props);
    for (i = 0; i < m; i++) {
      var prop = W.props[scratch.props[i]];
      var px = f.x - prop.x;
      var py = f.y - prop.y;
      var pd = Math.sqrt(px * px + py * py);
      var want = r + prop.r;
      if (pd >= want) continue;
      if (pd < 1e-9) {
        px = 1;
        py = 0;
        pd = 1;
      }
      f.x = prop.x + px / pd * want;
      f.y = prop.y + py / pd * want;
    }
  }

  /** Keeps a disc out of parked cars and vehicles, the player's own included. */
  function pushOutOfCars(S, f, r) {
    var W = S.world;
    var scratch = S.player._c;
    var parking = TLV.world.parking;
    var box = scratch.box;
    var door = scratch.door;
    var reach = TLV.tune.player.nearScanM;
    var count = parking.parkedNear(S, f.x, f.y, reach - 4, scratch.spots);
    var i;
    for (i = 0; i < count; i++) {
      var id = scratch.spots[i];
      parking.boxOf(W, id, parking.state(S, id), box);
      pushOutOfBox(f, r, box);
    }
    var near = TLV.collide._carsNear(S, f.x, f.y, reach, scratch.cars);
    for (i = 0; i < near; i++) {
      var o = scratch.cars[i];
      if (!o.active) continue;
      pushOutOfBox(f, r, o);
      if (o.door === 1 || o.door === 2) {
        TLV.collide._doorBox(o, door);
        pushOutOfBox(f, r, door);
      }
    }
    pushOutOfBox(f, r, S.player.veh);
  }

  /** The same, for the one other person who runs in this mode: the attacker. @param {object} who Has x and y, written. */
  foot._keepOutOfCars = pushOutOfCars;

  /** Water stops a person the way it stops the car, one axis at a time, so a person slides along the edge. */
  function keepDry(S, f, prevX, prevY) {
    var W = S.world;
    var WATER = TLV.const.SURF.WATER;
    var surface = TLV.world.surface;
    if (surface.at(W, f.x, f.y) !== WATER) return;
    if (surface.at(W, prevX, f.y) !== WATER) f.x = prevX;
    else if (surface.at(W, f.x, prevY) !== WATER) f.y = prevY;
    else {
      f.x = prevX;
      f.y = prevY;
    }
  }

  /** @returns {boolean} True if a brush from this body is new. Guards live for brushGuardS. */
  function freshBrush(S, f, kind, id) {
    var T = TLV.tune.player;
    var list = f._brush;
    var free = -1;
    for (var i = 0; i < list.length; i++) {
      var g = list[i];
      if (g.kind === kind && g.id === id) {
        var fresh = g.until <= S.t;
        g.until = S.t + T.brushGuardS;
        return fresh;
      }
      if (g.until <= S.t) free = i;
    }
    if (free >= 0) {
      list[free].kind = kind;
      list[free].id = id;
      list[free].until = S.t + T.brushGuardS;
    } else {
      list.push({ kind: kind, id: id, until: S.t + T.brushGuardS });
    }
    return true;
  }

  /** Staged blockers and other people: half speed for 0.4 s, no penalty (GAME_DESIGN 15.2). */
  function brushes(S, f, r) {
    var T = TLV.tune.player;
    var g = S.game;
    var i;
    var obstacles = g && g.obstacles;
    if (obstacles) {
      for (i = 0; i < obstacles.length; i++) {
        var o = obstacles[i];
        if (!o.active) continue;
        var dx = o.x - f.x;
        var dy = o.y - f.y;
        var reach = o.r + r;
        if (dx * dx + dy * dy < reach * reach && freshBrush(S, f, KIND_OBSTACLE, o.id)) f.slowT = T.brushSlowS;
      }
    }
    var scratch = S.player._c;
    var n = TLV.collide._peopleNear(S, f.x, f.y, r + 1, scratch.people);
    for (i = 0; i < n; i++) {
      var ped = scratch.people[i];
      if (!ped.active || ped.kind === 'attacker') continue;
      var px = ped.x - f.x;
      var py = ped.y - f.y;
      var near = ped.r + r;
      if (px * px + py * py >= near * near) continue;
      if (!freshBrush(S, f, KIND_PERSON, ped.id)) continue;
      f.slowT = T.brushSlowS;
      if (TLV.peds && TLV.peds.onBrush) TLV.peds.onBrush(S, ped);
      S.bus.emit('player.brushPed', { pedId: ped.id });
    }
  }

  /** Picks the side to step to: left of the heading, or right if a wall stands left. */
  function pickSide(S, f) {
    var T = TLV.tune.player;
    var W = S.world;
    if (!W) return 1;
    var c = Math.cos(f.h);
    var s = Math.sin(f.h);
    var reach = T.sidestepM + T.footRadius;
    return TLV.world.spatial.rayBlocked(W, f.x, f.y, f.x - s * reach, f.y + c * reach) ? -1 : 1;
  }

  /**
   * Puts the player on foot.
   * @param {object} S Sim state.
   * @param {number} x East, metres.
   * @param {number} y North, metres.
   * @param {number} h Heading, radians.
   */
  foot.enter = function (S, x, y, h) {
    var T = TLV.tune.player;
    var p = S.player;
    var f = p.foot;
    f.x = x;
    f.y = y;
    if (S.world) {
      var out = f._r;
      if (TLV.collide._clearPoint(S, x, y, T.footRadius + 0.02, out, true)) {
        f.x = out.x;
        f.y = out.y;
      }
    }
    f.h = h;
    f.px = f.x; f.py = f.y; f.ph = h;
    f.v = 0;
    f.active = true;
    f.stumbleT = 0;
    f.slowT = 0;
    f.sidestepT = 0;
    f.sidestepCd = 0;
    f.anim = 'idle';
    f._sidePrev = false;
    var veh = p.veh;
    veh.v = 0;
    veh.vx = 0;
    veh.vy = 0;
    veh.accel = 0;
    veh.yawRate = 0;
    veh.horn = false;
    p._d.snap.active = false;
    p.fx = f.x;
    p.fy = f.y;
    TLV.player._setMode(S, 'FOOT');
  };

  /**
   * Puts the player back in the car, in mode DRIVE. Does nothing unless on foot.
   * @param {object} S Sim state.
   */
  foot.exit = function (S) {
    var p = S.player;
    if (p.mode !== 'FOOT') return;
    p.foot.active = false;
    p.foot.v = 0;
    p.foot.anim = 'idle';
    p.fx = p.veh.x;
    p.fy = p.veh.y;
    p._d.locked = false;
    TLV.player._setMode(S, 'DRIVE');
  };

  /**
   * Tick row 9. Returns at once unless on foot.
   * @param {object} S Sim state.
   * @param {number} dt Tick, seconds.
   */
  foot.update = function (S, dt) {
    var p = S.player;
    if (p.mode !== 'FOOT') return;
    var T = TLV.tune.player;
    var math = TLV.math;
    var f = p.foot;
    var c = S.controls;

    f.stumbleT = f.stumbleT > dt ? f.stumbleT - dt : 0;
    f.invulnT = f.invulnT > dt ? f.invulnT - dt : 0;
    f.slowT = f.slowT > dt ? f.slowT - dt : 0;
    f.sidestepCd = f.sidestepCd > dt ? f.sidestepCd - dt : 0;

    var mx = c.footX;
    var my = c.footY;
    var mag = Math.sqrt(mx * mx + my * my);
    if (mag > 1) {
      mx /= mag;
      my /= mag;
      mag = 1;
    }
    var stumbling = f.stumbleT > 0;
    var want = stumbling ? 0 : T.footSpeed * mag * (f.slowT > 0 ? T.brushSpeedScale : 1);
    var step = T.footAccel * dt;
    f.v = want > f.v ? Math.min(want, f.v + step) : Math.max(want, f.v - step);

    var pressed = !!c.sidestep;
    if (pressed && !f._sidePrev && f.sidestepCd <= 0 && !stumbling) {
      f.sidestepT = T.sidestepS;
      f.sidestepCd = T.sidestepCooldownS;
      f._side = pickSide(S, f);
    }
    f._sidePrev = pressed;

    var prevX = f.x;
    var prevY = f.y;
    var hx = Math.cos(f.h);
    var hy = Math.sin(f.h);
    if (mag > 1e-3 && !stumbling) {
      var dir = Math.atan2(my, mx);
      var heading = math.wrapPi(f.h + math.wrapPi(dir - f.h) * Math.min(1, T.footTurnRate * dt));
      f.x += mx / mag * f.v * dt;
      f.y += my / mag * f.v * dt;
      if (f.sidestepT <= 0) f.h = heading;
    }
    var stepping = f.sidestepT > 0;
    if (stepping) {
      var rate = T.sidestepM / T.sidestepS * dt * f._side;
      f.x += -hy * rate;
      f.y += hx * rate;
      // The margin is for rounding: 0.3 s must be 18 ticks, and a 19th overshoots the step.
      f.sidestepT = f.sidestepT - dt < 1e-9 ? 0 : f.sidestepT - dt;
    }
    if (S.world) {
      var r = T.footRadius;
      var W = S.world;
      pushOutOfCars(S, f, r);
      pushOutOfStatics(S, f, r, prevX, prevY);
      keepDry(S, f, prevX, prevY);
      brushes(S, f, r);
      var b = W.bounds;
      f.x = math.clamp(f.x, b.minX + r, b.maxX - r);
      f.y = math.clamp(f.y, b.minY + r, b.maxY - r);
    }
    f.anim = stumbling ? 'stumble' : (stepping ? 'sidestep' : (f.v > 0.3 ? 'run' : 'idle'));
    p.fx = f.x;
    p.fy = f.y;
  };

  /**
   * A lunge landed: stumble and invulnerability (GAME_DESIGN 15.2). Money and strikes are WP-GAME's.
   * @param {object} S Sim state.
   * @returns {boolean} False if the person is invulnerable, so nothing landed.
   */
  foot.applyHit = function (S) {
    var T = TLV.tune.player;
    var f = S.player.foot;
    if (f.invulnT > 0) return false;
    f.stumbleT = T.stumbleS;
    f.invulnT = T.invulnerableS;
    f.sidestepT = 0;
    f.anim = 'stumble';
    return true;
  };
})(window.TLV);
