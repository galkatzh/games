// js/ui/minimap.js — WP-UI
// The minimap: view-up, so left on the map is left on the screen. The street map is drawn once into an offscreen bitmap, and each frame
// only places that bitmap and draws the route and markers on top. North is marked on the rim.
(function (TLV) {
  'use strict';

  var minimap = TLV.ns('ui.minimap');

  var canvas = null;
  var ctx = null;
  var base = null;
  var world = null;
  var sizeCss = 0;
  var dpr = 1;

  var COLORS = {
    ground: '#e8d9b8', sea: '#1aa6c4', beach: '#f4dd9e', park: '#9fd47f', water: '#1aa6c4', plaza: '#efe3c8',
    road: '#ffffff', casing: '#b7a98a', route: '#ffd21f', foot: '#12b5cf', routeCase: '#15121c',
    me: '#ff4630', meRim: '#ffffff', bay: '#3ddc6e', door: '#ff8a1f', rival: '#ff2e63', attacker: '#ff2e63', rim: '#15121c'
  };

  /** Land classes drawn on the base, in paint order. */
  var LAND = [[2, 'park'], [3, 'park'], [7, 'park'], [8, 'plaza'], [6, 'beach'], [1, 'beach'], [0, 'sea'], [4, 'water']];

  /** World metres to bitmap pixels. */
  function toBaseX(W, x) {
    return (x - W.bounds.minX) * TLV.tune.ui.mapBasePxPerM;
  }

  function toBaseY(W, y) {
    return (W.bounds.maxY - y) * TLV.tune.ui.mapBasePxPerM;
  }

  function strokeRoads(pen, W, cls, width, color) {
    pen.strokeStyle = color;
    pen.lineWidth = width;
    pen.beginPath();
    for (var i = 0; i < W.edges.length; i++) {
      var e = W.edges[i];
      if (e.cls !== cls) continue;
      pen.moveTo(toBaseX(W, e.px[0]), toBaseY(W, e.py[0]));
      for (var k = 1; k < e.px.length; k++) pen.lineTo(toBaseX(W, e.px[k]), toBaseY(W, e.py[k]));
    }
    pen.stroke();
  }

  /** Draws the whole map once. Roads are batched by class, so this costs tens of milliseconds, a single time. */
  function buildBase(W) {
    var T = TLV.tune.ui;
    var bmp = document.createElement('canvas');
    bmp.width = Math.ceil((W.bounds.maxX - W.bounds.minX) * T.mapBasePxPerM);
    bmp.height = Math.ceil((W.bounds.maxY - W.bounds.minY) * T.mapBasePxPerM);
    var pen = bmp.getContext('2d');
    pen.fillStyle = COLORS.ground;
    pen.fillRect(0, 0, bmp.width, bmp.height);
    LAND.forEach(function (row) {
      pen.fillStyle = COLORS[row[1]];
      pen.beginPath();
      W.land.forEach(function (poly) {
        if (poly.cls !== row[0]) return;
        var pts = poly.poly;
        pen.moveTo(toBaseX(W, pts[0]), toBaseY(W, pts[1]));
        for (var i = 2; i < pts.length; i += 2) pen.lineTo(toBaseX(W, pts[i]), toBaseY(W, pts[i + 1]));
        pen.closePath();
      });
      pen.fill();
    });
    pen.lineCap = 'round';
    pen.lineJoin = 'round';
    for (var pass = 0; pass < 2; pass++) {
      for (var cls = T.mapRoadPx.length - 1; cls >= 0; cls--) {
        if (pass === 0) strokeRoads(pen, W, cls, T.mapRoadPx[cls] + 1.4, COLORS.casing);
        else strokeRoads(pen, W, cls, T.mapRoadPx[cls], COLORS.road);
      }
    }
    return bmp;
  }

  /**
   * Builds the minimap in its slot.
   * @param {Element} slot Parent element.
   * @param {object} S Sim state.
   */
  minimap.build = function (slot, S) {
    canvas = TLV.ui.el('canvas', 'minimap', slot);
    ctx = canvas.getContext('2d');
    if (world !== S.world) base = null;
    world = S.world;
    sizeCss = 0;
  };

  function fit() {
    var css = canvas.clientWidth;
    var ratio = window.devicePixelRatio || 1;
    if (css === sizeCss && ratio === dpr) return;
    sizeCss = css;
    dpr = ratio;
    canvas.width = Math.round(css * dpr);
    canvas.height = Math.round(css * dpr);
  }

  /**
   * World point to minimap pixels: the view heading points up.
   * @param {number} dx Metres east of the centre.
   * @param {number} dy Metres north of the centre.
   * @param {number} yaw World heading that points up.
   * @param {number} scale Pixels per metre.
   * @param {object} out Written with {x, y}, relative to the centre, y down.
   * @returns {object} out.
   */
  minimap.place = function (dx, dy, yaw, scale, out) {
    var c = Math.cos(yaw);
    var s = Math.sin(yaw);
    var ahead = dx * c + dy * s;
    var left = -dx * s + dy * c;
    out.x = -left * scale;
    out.y = -ahead * scale;
    return out;
  };

  var pt = { x: 0, y: 0 };

  function routeLine(S, cx, cy, yaw, scale, fx, fy) {
    var T = TLV.tune.ui;
    var nav = S.game.nav;
    var route = nav.route;
    if (!route || !route.px || route.px.length < 2) return false;
    var step = Math.max(1, Math.round(T.mapRouteStepM / Math.max(1, route.len / route.px.length)));
    var from = 0;
    while (from < route.px.length - 1 && route.cum[from] < nav.s) from++;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (var i = from; i < route.px.length; i += step) {
      if (route.cum[i] - nav.s > T.mapRouteMaxM) break;
      minimap.place(route.px[i] - fx, route.py[i] - fy, yaw, scale, pt);
      ctx.lineTo(cx + pt.x, cy + pt.y);
    }
    var last = route.px.length - 1;
    if (route.cum[last] - nav.s <= T.mapRouteMaxM) {
      minimap.place(route.px[last] - fx, route.py[last] - fy, yaw, scale, pt);
      ctx.lineTo(cx + pt.x, cy + pt.y);
    }
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = COLORS.routeCase;
    ctx.lineWidth = 7 * dpr;
    ctx.stroke();
    ctx.strokeStyle = COLORS.route;
    ctx.lineWidth = 4 * dpr;
    ctx.stroke();
    return true;
  }

  /** The walk to the door in a chase, in the sea blue of the runner's arrow. The car's route means nothing to someone out of the car. */
  function footLine(path, cx, cy, yaw, scale, fx, fy) {
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    for (var i = 0; i + 1 < path.length; i += 2 * TLV.tune.ui.mapFootStepCells) {
      minimap.place(path[i] - fx, path[i + 1] - fy, yaw, scale, pt);
      ctx.lineTo(cx + pt.x, cy + pt.y);
    }
    minimap.place(path[path.length - 2] - fx, path[path.length - 1] - fy, yaw, scale, pt);
    ctx.lineTo(cx + pt.x, cy + pt.y);
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = COLORS.routeCase;
    ctx.lineWidth = 7 * dpr;
    ctx.stroke();
    ctx.strokeStyle = COLORS.foot;
    ctx.lineWidth = 4 * dpr;
    ctx.stroke();
  }

  /** Holds a marker inside the frame, so a target out of range still says which way. */
  function clampToFrame(half, p) {
    var inset = half * (1 - TLV.tune.ui.mapMarkerInset * 2);
    var m = Math.max(Math.abs(p.x), Math.abs(p.y));
    if (m > inset) {
      p.x *= inset / m;
      p.y *= inset / m;
      return true;
    }
    return false;
  }

  function marker(cx, cy, half, dx, dy, yaw, scale, color, label) {
    minimap.place(dx, dy, yaw, scale, pt);
    clampToFrame(half, pt);
    var r = 8.5 * dpr;
    ctx.beginPath();
    ctx.arc(cx + pt.x, cy + pt.y, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 2.5 * dpr;
    ctx.strokeStyle = COLORS.rim;
    ctx.stroke();
    if (!label) return;
    ctx.fillStyle = '#15121c';
    ctx.font = '900 ' + (11 * dpr) + 'px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, cx + pt.x, cy + pt.y + 0.5 * dpr);
  }

  function playerMark(cx, cy, turn) {
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(turn);
    ctx.beginPath();
    var r = 11 * dpr;
    ctx.moveTo(0, -r);
    ctx.lineTo(r * 0.72, r * 0.82);
    ctx.lineTo(0, r * 0.42);
    ctx.lineTo(-r * 0.72, r * 0.82);
    ctx.closePath();
    ctx.fillStyle = COLORS.me;
    ctx.fill();
    ctx.lineWidth = 2.5 * dpr;
    ctx.strokeStyle = COLORS.meRim;
    ctx.stroke();
    ctx.restore();
  }

  function northMark(cx, cy, half, yaw) {
    var label = TLV.ui.strings.t('hud.north');
    minimap.place(0, half, yaw, 1, pt);
    var inset = half - 11 * dpr;
    var m = Math.max(Math.abs(pt.x), Math.abs(pt.y));
    var x = cx + pt.x * inset / m;
    var y = cy + pt.y * inset / m;
    ctx.beginPath();
    ctx.arc(x, y, 9 * dpr, 0, Math.PI * 2);
    ctx.fillStyle = COLORS.rim;
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.font = '900 ' + (11 * dpr) + 'px Arial, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, x, y + 0.5 * dpr);
  }

  /** @returns {{fx:number,fy:number,h:number}} Where the player is and faces. */
  function focus(S) {
    var p = S.player;
    if (p.mode === 'FOOT' && p.foot) return { fx: p.foot.x, fy: p.foot.y, h: p.foot.h };
    var veh = S.vehicles[0];
    return { fx: veh.x, fy: veh.y, h: veh.h };
  }

  /**
   * Draws one frame.
   * @param {object} S Sim state.
   * @param {boolean} visible False skips the work.
   */
  minimap.frame = function (S, visible) {
    if (!visible || !canvas) return;
    var g = S.game;
    if (!g || g.phase === 'TITLE' || g.phase === 'RUN_END') return;
    fit();
    if (!sizeCss) return;
    if (!base) base = buildBase(S.world);
    var T = TLV.tune.ui;
    var W = S.world;
    var at = focus(S);
    var yaw = TLV.ui.viewYaw(S);
    var size = canvas.width;
    var half = size / 2;
    var speed = Math.abs(S.vehicles[0].v);
    var radius = TLV.math.lerp(T.mapRadiusSlowM, T.mapRadiusFastM, TLV.math.clamp(speed / T.mapZoomSpeed, 0, 1));
    var scale = half / radius;
    var cx = half;
    var cy = half;

    ctx.clearRect(0, 0, size, size);
    ctx.fillStyle = COLORS.ground;
    ctx.fillRect(0, 0, size, size);
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(yaw - Math.PI / 2);
    var k = scale / T.mapBasePxPerM;
    ctx.scale(k, k);
    ctx.translate(-toBaseX(W, at.fx), -toBaseY(W, at.fy));
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(base, 0, 0);
    ctx.restore();

    var walk = TLV.ui.hud.footPath();
    if (walk) footLine(walk, cx, cy, yaw, scale, at.fx, at.fy);
    else routeLine(S, cx, cy, yaw, scale, at.fx, at.fy);
    var e = g.errand;
    if (e) {
      marker(cx, cy, half, e.doorX - at.fx, e.doorY - at.fy, yaw, scale, COLORS.door, '');
      if (e.bayId >= 0) marker(cx, cy, half, g.nav.targetX - at.fx, g.nav.targetY - at.fy, yaw, scale, COLORS.bay, 'P');
    }
    if (g.contest) {
      var rival = TLV.ui.hud.findVehicle(S, g.contest.rivalId);
      if (rival) marker(cx, cy, half, rival.x - at.fx, rival.y - at.fy, yaw, scale, COLORS.rival, '');
    }
    if (g.knife) {
      for (var i = 0; i < S.peds.length; i++) {
        var ped = S.peds[i];
        if (ped.active && ped.id === g.knife.attackerId) marker(cx, cy, half, ped.x - at.fx, ped.y - at.fy, yaw, scale, COLORS.attacker, '');
      }
    }
    playerMark(cx, cy, TLV.math.wrapPi(yaw - at.h));
    northMark(cx, cy, half, yaw);
  };

  /** @returns {?HTMLCanvasElement} The canvas, for tests. */
  minimap._canvas = function () {
    return canvas;
  };
})(window.TLV);
