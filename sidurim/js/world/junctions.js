// js/world/junctions.js — WP-WORLD
// Connectors through junctions (ARCHITECTURE 8.2), their conflict sets, and junction polygons.
(function (TLV) {
  'use strict';

  var junctions = TLV.ns('world.junctions');

  var TURN_CODES = ['S', 'R', 'L', 'U'];
  var U_TURN = 3;
  var ROUNDABOUT = 1;
  var STRAIGHT = 'S';

  /** Right of way order: a U-turn sits past every left turn, because traffic drives on the right. */
  var FULL_TURN = 2 * Math.PI;
  var NO_IDS = new Int32Array(0);

  /** Sorts a short list of ids in place. */
  function sortIds(list) {
    for (var i = 1; i < list.length; i++) {
      var id = list[i];
      for (var k = i - 1; k >= 0 && list[k] > id; k--) list[k + 1] = list[k];
      list[k + 1] = id;
    }
  }

  /** Sorts a junction's arms counter-clockwise, with the edge id settling a tie. */
  function sortArms(list) {
    for (var i = 1; i < list.length; i++) {
      var arm = list[i];
      for (var k = i - 1; k >= 0 && (list[k].angle - arm.angle || list[k].edge - arm.edge) > 0; k--) list[k + 1] = list[k];
      list[k + 1] = arm;
    }
  }

  /** @returns {Array<Array<object>>} Each directed edge's legal exits, from the moves table, ignoring rows that do not fit. */
  function exitsByDirEdge(W) {
    var t = W.index.moves;
    var lists = new Array(W.dirEdges.length);
    if (!t.n) return lists;
    var c = t.col;
    for (var i = 0; i < t.n; i++) {
      var from = W.dirEdges[c.from[i]];
      var to = W.dirEdges[c.to[i]];
      if (!from || !to || from.to !== to.from) {
        TLV.registry.problem('map', W.id, 'move ' + i + ' joins directed edges that do not meet');
        continue;
      }
      if (!lists[c.from[i]]) lists[c.from[i]] = [];
      lists[c.from[i]].push({ to: to, turn: c.turn[i], key: 0.5 });
    }
    return lists;
  }

  /**
   * Right-to-left sort key of an exit: the bearing of its start seen from the end of the approach. Bearing, not the road's
   * heading, because two curves from one place stay uncrossed only if they keep the order of where they end: the arms of a
   * dual carriageway can leave at one heading from opposite sides. A U-turn sorts past every left, as traffic drives on
   * the right.
   * @returns {number} Radians, positive to the left.
   */
  function exitBearing(W, from, exit, cos, sin) {
    if (exit.turn === U_TURN) return FULL_TURN;
    var fromLane = W.lanes[from.lanes[0]];
    var toLane = W.lanes[exit.to.lanes[exit.to.lanes.length >> 1]];
    var last = fromLane.px.length - 1;
    var dx = toLane.px[0] - fromLane.px[last];
    var dy = toLane.py[0] - fromLane.py[last];
    return Math.atan2(cos * dy - sin * dx, cos * dx + sin * dy);
  }

  /** Sorts exits right to left (ARCHITECTURE 1.3). */
  function sortExits(W, from, exits) {
    var cos = Math.cos(from.hOut);
    var sin = Math.sin(from.hOut);
    var i;
    for (i = 0; i < exits.length; i++) exits[i].key = exitBearing(W, from, exits[i], cos, sin);
    // An insertion sort: there are thousands of these lists, and few hold more than three.
    for (i = 1; i < exits.length; i++) {
      var x = exits[i];
      for (var k = i - 1; k >= 0 && (exits[k].key - x.key || exits[k].to.id - x.to.id) > 0; k--) exits[k + 1] = exits[k];
      exits[k + 1] = x;
    }
    return exits;
  }

  /** @returns {number} The 10 * ring term of a connector's priority. */
  function ringTerm(W, fromLane, junc) {
    var T = TLV.tune.world;
    if (W.edges[fromLane.edge].flags & ROUNDABOUT) return T.connRingScore;
    // A RING junction with no ring edge, as on the mini map, has no circulating lane: all of it counts as the ring.
    if (W.juncs[junc].kind !== 'RING') return 0;
    return W.index.ringEdges[junc] ? 0 : T.connRingScore;
  }

  /**
   * Measures a sampled path, into e. kappa is its largest curvature, as the turn at each vertex over the arc around it. This
   * is the path a car really follows: the analytic curvature of the Bezier itself runs to infinity at a cusp, which would
   * make a connector unusable. turn is the sharpest single turn. A cubic can be smooth on paper and still kink once sampled:
   * long controls cross and form a cusp, and short ones put the whole turn into the first sample.
   *
   * The joints with both lanes count too, or a kink there would keep lane speed. A lane's last span can be 70 m long and would
   * hide the kink, so a lane brings at most one sample spacing to the arc. And no arc counts as shorter than one spacing:
   * samples that close, on a connector under 1.5 m, say nothing about the curve a car can follow, and would read as a dead stop.
   * @param {{x: ArrayLike<number>, y: ArrayLike<number>, n: number}} line Shape.
   * @param {object} e Ends from laneEnds. Receives kappa, in 1 / metres, and turn, in radians.
   * @param {number} spacing Sample spacing, metres.
   */
  function measure(line, e, spacing) {
    var px = line.x;
    var py = line.y;
    var kappa = 0;
    var sharpest = 0;
    var ax = e.ux;
    var ay = e.uy;
    var arc = Math.min(e.l0, spacing);
    for (var i = 0; i + 1 < line.n; i++) {
      var dx = px[i + 1] - px[i];
      var dy = py[i + 1] - py[i];
      var l = Math.sqrt(dx * dx + dy * dy);
      if (l <= 0) continue;
      var turn = Math.atan2(Math.abs(ax * dy - ay * dx), ax * dx + ay * dy);
      var k = 2 * turn / Math.max(arc + l, spacing);
      if (k > kappa) kappa = k;
      if (turn > sharpest) sharpest = turn;
      ax = dx;
      ay = dy;
      arc = l;
    }
    var last = Math.atan2(Math.abs(ax * e.vy - ay * e.vx), ax * e.vx + ay * e.vy);
    var end = 2 * last / Math.max(arc + Math.min(e.l3, spacing), spacing);
    e.kappa = end > kappa ? end : kappa;
    e.turn = last > sharpest ? last : sharpest;
  }

  /** Writes where a connector must start and end, and the lane headings it must meet there, into e. */
  function laneEnds(fromLane, toLane, e) {
    var n = fromLane.px.length - 1;
    e.x0 = fromLane.px[n];
    e.y0 = fromLane.py[n];
    e.x3 = toLane.px[0];
    e.y3 = toLane.py[0];
    var ux = e.x0 - fromLane.px[n - 1];
    var uy = e.y0 - fromLane.py[n - 1];
    var vx = toLane.px[1] - e.x3;
    var vy = toLane.py[1] - e.y3;
    e.l0 = Math.sqrt(ux * ux + uy * uy) || 1;
    e.l3 = Math.sqrt(vx * vx + vy * vy) || 1;
    e.ux = ux / e.l0;
    e.uy = uy / e.l0;
    e.vx = vx / e.l3;
    e.vy = vy / e.l3;
    e.chord = Math.sqrt((e.x3 - e.x0) * (e.x3 - e.x0) + (e.y3 - e.y0) * (e.y3 - e.y0));
  }

  /** @returns {number} What control lengths scale with: the chord, unless a kink's says nothing about the room it needs to turn. */
  function controlReach(e) {
    var T = TLV.tune.world;
    return e.chord < T.connShortChord ? T.connKinkReach : e.chord;
  }

  /** @returns {boolean} True when a sampled line crosses a collider. */
  function lineBlocked(W, line) {
    var blocked = TLV.world.spatial.rayBlocked;
    var x = line.x;
    var y = line.y;
    for (var i = 0; i + 1 < line.n; i++) {
      if (blocked(W, x[i], y[i], x[i + 1], y[i + 1])) return true;
    }
    return false;
  }

  /** Writes a cubic leaving (x0, y0) along u and arriving at (x3, y3) along v. */
  function curve(x0, y0, ux, uy, c0, x3, y3, vx, vy, c3, out) {
    TLV.world.geom._bezierLine(x0, y0, x0 + ux * c0, y0 + uy * c0, x3 - vx * c3, y3 - vy * c3, x3, y3,
      TLV.tune.world.connSpacing, out);
  }

  /** Writes two cubics in a row, passing through (mx, my) along the chord. */
  function bowed(W, x0, y0, ux, uy, x3, y3, vx, vy, mx, my, tx, ty, chord, out) {
    var c = TLV.tune.world.ctrlShare * chord / 2;
    var a = W.index.lineA;
    var b = W.index.lineB;
    curve(x0, y0, ux, uy, c, mx, my, tx, ty, c, a);
    curve(mx, my, tx, ty, c, x3, y3, vx, vy, c, b);
    var n = a.n + b.n - 1;
    if (out.x.length < n) {
      out.x = new Float64Array(n * 2);
      out.y = new Float64Array(n * 2);
    }
    out.x.set(a.x.subarray(0, a.n));
    out.y.set(a.y.subarray(0, a.n));
    out.x.set(b.x.subarray(1, b.n), a.n);
    out.y.set(b.y.subarray(1, b.n), a.n);
    out.n = n;
  }

  /**
   * Shapes a connector into out (ARCHITECTURE 8.2). The contract's cubic is the answer unless it runs through a wall, as it
   * can when a merged junction dropped the street that went round a building, or when a corner building stands at the kerb.
   * Then the least change that clears is used: control lengths first, which keeps the shape, then a bow to either side of the
   * obstacle. If nothing clears, the plain cubic stays. A cubic stays inside its control points' box, so a box with no
   * collider in it needs no closer look.
   * @returns {boolean} True when the shape still runs through a wall.
   */
  function shapeConnector(W, e, out) {
    var T = TLV.tune.world;
    var x0 = e.x0;
    var y0 = e.y0;
    var ux = e.ux;
    var uy = e.uy;
    var x3 = e.x3;
    var y3 = e.y3;
    var vx = e.vx;
    var vy = e.vy;
    var chord = e.chord;
    var reach = controlReach(e);
    var c = T.ctrlShare * reach;
    curve(x0, y0, ux, uy, c, x3, y3, vx, vy, c, out);
    var x1 = x0 + ux * c;
    var y1 = y0 + uy * c;
    var x2 = x3 - vx * c;
    var y2 = y3 - vy * c;
    var minX = Math.min(x0, x1, x2, x3);
    var minY = Math.min(y0, y1, y2, y3);
    var maxX = Math.max(x0, x1, x2, x3);
    var maxY = Math.max(y0, y1, y2, y3);
    if (TLV.world.spatial._boxClear(W, minX, minY, maxX, maxY) || !lineBlocked(W, out)) return false;
    var shares = T.connRetryShares;
    var i;
    for (i = 0; i < shares.length; i++) {
      curve(x0, y0, ux, uy, shares[i][0] * reach, x3, y3, vx, vy, shares[i][1] * reach, out);
      if (!lineBlocked(W, out)) return false;
    }
    if (chord >= T.connBowMinChord) {
      var tx = (x3 - x0) / chord;
      var ty = (y3 - y0) / chord;
      var mx = (x0 + x3) / 2;
      var my = (y0 + y3) / 2;
      for (i = 0; i < T.connBowShares.length; i++) {
        for (var sign = -1; sign <= 1; sign += 2) {
          var b = T.connBowShares[i] * chord * sign;
          bowed(W, x0, y0, ux, uy, x3, y3, vx, vy, mx - ty * b, my + tx * b, tx, ty, chord, out);
          if (!lineBlocked(W, out)) return false;
        }
      }
    }
    curve(x0, y0, ux, uy, c, x3, y3, vx, vy, c, out);
    return true;
  }

  /** Stores a connector's shape, with the length and top speed that follow from it, leaving its measures in e. */
  function setShape(W, conn, e, shape) {
    var T = TLV.tune.world;
    var line = TLV.world.geom._store(W.index.arena, shape);
    var limit = Math.min(W.lanes[conn.from].vmax, W.lanes[conn.to].vmax);
    measure(shape, e, T.connSpacing);
    conn.px = line.px;
    conn.py = line.py;
    conn.cum = line.cum;
    conn.len = line.len;
    conn.vmax = e.kappa > 0 ? Math.min(limit, Math.sqrt(T.connLatAccel / e.kappa)) : limit;
  }

  /**
   * @returns {boolean} True when lanes that end together still turn too far to be a mere joint. Each heading is read over a
   * stretch of its lane, because a lane's last span can be a few centimetres long and say nothing. Where both end spans cover
   * that stretch, as most do, laneEnds has the answer already.
   */
  function isKink(W, e, fromLane, toLane) {
    var span = TLV.tune.world.connKinkSpan;
    if (e.l0 >= span && e.l3 >= span) return e.ux * e.vx + e.uy * e.vy <= W.index.connKinkCos;
    var geom = TLV.world.geom;
    var a = W.index.tmpPoint;
    var b = W.index.tmpPoint2;
    var hIn = geom._headingOver(fromLane.px, fromLane.py, fromLane.cum, Math.max(0, fromLane.len - span), fromLane.len, a, b);
    var hOut = geom._headingOver(toLane.px, toLane.py, toLane.cum, 0, Math.min(toLane.len, span), a, b);
    return Math.abs(TLV.math.wrapPi(hOut - hIn)) >= W.index.connKink;
  }

  /** Builds one connector and appends it. */
  function addConnector(W, fromLane, toLane, junc, turnCode) {
    var T = TLV.tune.world;
    var e = W.index.connEnds;
    var id = W.conns.length;
    laneEnds(fromLane, toLane, e);
    var limit = Math.min(fromLane.vmax, toLane.vmax);
    var short = e.chord < T.connShortChord && !isKink(W, e, fromLane, toLane);
    var turn = TURN_CODES[turnCode] || 'S';
    var conn = {
      id: id,
      from: fromLane.id,
      to: toLane.id,
      junc: junc,
      turn: turn,
      len: 0,
      vmax: limit,
      px: null,
      py: null,
      cum: null,
      conflicts: null,
      priority: ringTerm(W, fromLane, junc) + (T.connClassBase - fromLane.cls) + T.connTurnScore[turn],
      slot: -1
    };
    W.conns.push(conn);
    var shape = W.index.lineC;
    var walled = false;
    if (short) {
      shape.x[0] = e.x0;
      shape.y[0] = e.y0;
      shape.x[1] = e.x3;
      shape.y[1] = e.y3;
      shape.n = 2;
      var line = TLV.world.geom._store(W.index.arena, shape);
      conn.len = Math.max(e.chord, T.connMinLen);
      line.cum[1] = conn.len;
      conn.px = line.px;
      conn.py = line.py;
      conn.cum = line.cum;
    } else {
      walled = shapeConnector(W, e, shape);
      setShape(W, conn, e, shape);
      if (e.turn > W.index.connSharp) W.index.sharpConns.push(id);
    }
    W.index.connShort.push(short ? 1 : 0);
    if (walled) W.index.walledConns.push(id);
    return id;
  }

  /** @returns {boolean} True when a sampled line crosses itself, which a long control can make it do. */
  function lineLoops(line) {
    var hit = TLV.math.segSegHit;
    var x = line.x;
    var y = line.y;
    for (var i = 0; i + 2 < line.n; i++) {
      for (var j = i + 2; j + 1 < line.n; j++) {
        if (hit(x[i], y[i], x[i + 1], y[i + 1], x[j], y[j], x[j + 1], y[j + 1])) return true;
      }
    }
    return false;
  }

  /**
   * True when a shape would cross a connector of its own approach that leaves another lane for another target. Such a pair
   * can break the rule of ARCHITECTURE section 19 item 3, and nothing serializes a crossing the plain cubics did not have.
   */
  function crossesSibling(W, conn, line, siblings) {
    var view = { px: line.x.subarray(0, line.n), py: line.y.subarray(0, line.n) };
    var box = W.index.tmpBox;
    for (var i = 0; i < siblings.length; i++) {
      var q = W.conns[siblings[i]];
      if (q.from === conn.from || q.to === conn.to) continue;
      storeConnBox(q, box, 0);
      if (polylinesTouch(view, q, box, 0)) return true;
    }
    return false;
  }

  /**
   * Looks for gentler control lengths for a connector with a sharp vertex or lane joint, and keeps the gentlest shape that
   * clears every wall, crosses no sibling and has no loop. Walls come first: a sharp connector that cannot clear otherwise
   * stays as it is. Runs once the approach is complete, so every sibling it compares with has its final shape.
   * @param {object} W World.
   * @param {object} conn Connector.
   * @param {number[]} siblings Connectors of the approach.
   */
  function smoothConnector(W, conn, siblings) {
    var T = TLV.tune.world;
    var e = W.index.connEnds;
    var trial = W.index.lineC;
    var best = W.index.lineD;
    var shares = T.connSmoothShares;
    laneEnds(W.lanes[conn.from], W.lanes[conn.to], e);
    var reach = controlReach(e);
    measure({ x: conn.px, y: conn.py, n: conn.px.length }, e, T.connSpacing);
    var gentlest = e.turn;
    var start = gentlest;
    for (var i = 0; i < shares.length; i++) {
      curve(e.x0, e.y0, e.ux, e.uy, shares[i][0] * reach, e.x3, e.y3, e.vx, e.vy, shares[i][1] * reach, trial);
      measure(trial, e, T.connSpacing);
      if (e.turn >= gentlest || lineBlocked(W, trial) || lineLoops(trial) || crossesSibling(W, conn, trial, siblings)) continue;
      gentlest = e.turn;
      TLV.world.geom._copyLine(trial, best);
      if (gentlest <= W.index.connSharp) break;
    }
    if (gentlest < start) {
      setShape(W, conn, e, best);
      var walled = W.index.walledConns.indexOf(conn.id);
      if (walled >= 0) W.index.walledConns.splice(walled, 1);
    }
  }

  /**
   * The exit that carries on round a ring, for an approach where 8.2 would strand a lane. With two lanes and two exits the
   * formula gives the right lane the way out and the left lane the way round, to the left lane of the next arc, so the left
   * lanes of a ring close into a loop with no connector off it. Arcs are often 3 m long, so no car can change lanes there.
   * @returns {number} Index of the leftmost exit when it is the only one that stays on the ring, else -1.
   */
  function ringSpiral(W, d, exits) {
    var top = exits.length - 1;
    if (d.lanes.length < 2 || top < 1 || !(W.edges[d.edge].flags & ROUNDABOUT)) return -1;
    for (var t = 0; t <= top; t++) {
      if (((W.edges[exits[t].to.edge].flags & ROUNDABOUT) !== 0) !== (t === top)) return -1;
    }
    return top;
  }

  /**
   * Assigns lanes to exits and builds the connectors of one approach (ARCHITECTURE 8.2): exit t of k takes lanes a..b, so
   * every lane gets an exit and every exit a lane. A ring arc with a way off it spirals instead: the right lane takes every way
   * off and the way round, and each lane to its left carries on one lane further right, so every lane on a ring reaches every
   * exit by connectors alone, and no crossing of the right lane's exits is added.
   * @returns {number[]} Connector ids, rightmost exit first.
   */
  function buildApproach(W, d, exits, perLane) {
    var n = d.lanes.length;
    var k = exits.length;
    var made = [];
    var spiral = ringSpiral(W, d, exits);
    for (var t = 0; t < k; t++) {
      var exit = exits[t];
      var a = spiral < 0 ? Math.floor(t * n / k) : 0;
      var b = spiral < 0 ? Math.max(a, Math.ceil((t + 1) * n / k) - 1) : (t === spiral ? n - 1 : 0);
      var nOut = exit.to.lanes.length;
      for (var lane = a; lane <= b; lane++) {
        var feeds = spiral < 0 ? lane : Math.max(0, lane - 1);
        var target = Math.round(feeds / Math.max(1, n - 1) * (nOut - 1));
        var id = addConnector(W, W.lanes[d.lanes[lane]], W.lanes[exit.to.lanes[target]], d.to, exit.turn);
        made.push(id);
        perLane[lane].push(id);
      }
    }
    return made;
  }

  /** Flags junctions that hold a ROUNDABOUT edge. */
  function markRingEdges(W) {
    var seen = new Uint8Array(W.juncs.length);
    for (var i = 0; i < W.edges.length; i++) {
      if (!(W.edges[i].flags & ROUNDABOUT)) continue;
      seen[W.edges[i].a] = 1;
      seen[W.edges[i].b] = 1;
    }
    W.index.ringEdges = seen;
  }

  /** Builds every connector, and each lane's and junction's lists. */
  function buildConnectors(W) {
    markRingEdges(W);
    W.index.connShort = [];
    W.index.walledConns = [];
    var sharp = [];
    W.index.sharpConns = sharp;
    W.index.connSharp = TLV.tune.world.connSharpDeg * Math.PI / 180;
    W.index.connKink = TLV.tune.world.connKinkDeg * Math.PI / 180;
    W.index.connKinkCos = Math.cos(W.index.connKink);
    W.index.connEnds = { x0: 0, y0: 0, x3: 0, y3: 0, ux: 0, uy: 0, vx: 0, vy: 0, l0: 0, l3: 0, chord: 0, kappa: 0, turn: 0 };
    W.index.tmpBox = new Float32Array(4);
    var exitLists = exitsByDirEdge(W);
    var perJunc = [];
    var i;
    for (i = 0; i < W.juncs.length; i++) perJunc.push([]);
    for (i = 0; i < W.dirEdges.length; i++) {
      var d = W.dirEdges[i];
      if (!d) continue;
      var exits = exitLists[i];
      if (!exits) continue;
      sortExits(W, d, exits);
      d.moves = TLV.world.geom._idView(W.index.ids, exits.length);
      for (var x = 0; x < exits.length; x++) d.moves[x] = exits[x].to.id;
      var perLane = [];
      for (var l = 0; l < d.lanes.length; l++) perLane.push([]);
      var made = buildApproach(W, d, exits, perLane);
      for (var u = 0; u < sharp.length; u++) smoothConnector(W, W.conns[sharp[u]], made);
      sharp.length = 0;
      for (var m = 0; m < made.length; m++) perJunc[d.to].push(made[m]);
      for (var q = 0; q < d.lanes.length; q++) W.lanes[d.lanes[q]].conns = TLV.world.geom._idsIn(W.index.ids, perLane[q]);
    }
    for (i = 0; i < W.juncs.length; i++) W.juncs[i].conns = TLV.world.geom._idsIn(W.index.ids, perJunc[i]);
    var flags = new Uint8Array(W.conns.length);
    for (i = 0; i < W.index.walledConns.length; i++) flags[W.index.walledConns[i]] = 1;
    W.index.connWalled = flags;
  }

  /** @returns {boolean} True when two connector polylines touch. b's bounds are at box[at], from storeConnBox. */
  function polylinesTouch(a, b, box, at) {
    var hit = TLV.math.segSegHit;
    var ax = a.px;
    var ay = a.py;
    var bx = b.px;
    var by = b.py;
    var na = ax.length - 1;
    var nb = bx.length - 1;
    var bLoX = box[at];
    var bLoY = box[at + 1];
    var bHiX = box[at + 2];
    var bHiY = box[at + 3];
    for (var i = 0; i < na; i++) {
      var aLoX = ax[i] < ax[i + 1] ? ax[i] : ax[i + 1];
      var aHiX = ax[i] < ax[i + 1] ? ax[i + 1] : ax[i];
      var aLoY = ay[i] < ay[i + 1] ? ay[i] : ay[i + 1];
      var aHiY = ay[i] < ay[i + 1] ? ay[i + 1] : ay[i];
      // Most spans of a are nowhere near b at all, and this spares them the walk along it.
      if (aHiX < bLoX || aLoX > bHiX || aHiY < bLoY || aLoY > bHiY) continue;
      for (var j = 0; j < nb; j++) {
        if ((bx[j] < aLoX && bx[j + 1] < aLoX) || (bx[j] > aHiX && bx[j + 1] > aHiX)) continue;
        if ((by[j] < aLoY && by[j + 1] < aLoY) || (by[j] > aHiY && by[j + 1] > aHiY)) continue;
        if (hit(ax[i], ay[i], ax[i + 1], ay[i + 1], bx[j], by[j], bx[j + 1], by[j + 1])) return true;
      }
    }
    return false;
  }

  /**
   * @returns {boolean} True when two connectors pass within a car's width of each other, centre to centre, without crossing: two
   * cars on them would touch, and a crossing test alone leaves such a pair free of each other. Walks a's samples, and a sample d
   * metres clear of b lets the walk skip what it can gain on b in d metres. b's bounds are at box[at].
   */
  function polylinesClose(a, b, box, at, clear) {
    var dist = TLV.math.pointSegDist;
    var ax = a.px;
    var ay = a.py;
    var bx = b.px;
    var by = b.py;
    var nb = bx.length - 1;
    var cum = a.cum;
    var bLoX = box[at] - clear;
    var bLoY = box[at + 1] - clear;
    var bHiX = box[at + 2] + clear;
    var bHiY = box[at + 3] + clear;
    var skipTo = 0;
    for (var i = 0; i < ax.length; i++) {
      if (cum[i] < skipTo) continue;
      var x = ax[i];
      var y = ay[i];
      if (x < bLoX || x > bHiX || y < bLoY || y > bHiY) continue;
      var best = Infinity;
      for (var j = 0; j < nb; j++) {
        var d = dist(x, y, bx[j], by[j], bx[j + 1], by[j + 1]);
        if (d < best) best = d;
      }
      if (best < clear) return true;
      skipTo = cum[i] + best - clear;
    }
    return false;
  }

  /** Writes minX, minY, maxX, maxY of a connector into a flat array. */
  function storeConnBox(c, box, at) {
    var px = c.px;
    var py = c.py;
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var i = 0; i < px.length; i++) {
      if (px[i] < minX) minX = px[i];
      if (px[i] > maxX) maxX = px[i];
      if (py[i] < minY) minY = py[i];
      if (py[i] > maxY) maxY = py[i];
    }
    box[at] = minX;
    box[at + 1] = minY;
    box[at + 2] = maxX;
    box[at + 3] = maxY;
  }

  /**
   * Builds conflict sets (ARCHITECTURE 8.2): another connector of the junction from a different lane that shares this
   * target, crosses this path, or passes within a car's width of it. A connector with a near-zero chord has none. At a signal,
   * pairs of straight connectors that cross are kept aside by junction, as flat id pairs. A pair that only shares a target, or
   * only passes close, is not among them.
   */
  function buildConflicts(W) {
    var n = W.conns.length;
    var crossing = new Array(W.juncs.length);
    var lists = new Array(n);
    var box = new Float32Array(n * 4);
    var i;
    for (i = 0; i < n; i++) storeConnBox(W.conns[i], box, i * 4);
    for (var j = 0; j < W.juncs.length; j++) junctionConflicts(W, j, box, lists, crossing);
    for (i = 0; i < n; i++) storeConflicts(W, i, lists);
    W.index.straightCrossings = crossing;
  }

  /** Finds the conflicting pairs of one junction. Apart from the loop over junctions so it gets compiled early. */
  function junctionConflicts(W, j, box, lists, crossing) {
    var near = TLV.tune.world.connClearM;
    var shortFlag = W.index.connShort;
    var ids = W.juncs[j].conns;
    var signal = W.juncs[j].kind === 'SIGNAL';
    for (var i = 0; i < ids.length; i++) {
      var p = W.conns[ids[i]];
      if (shortFlag[p.id]) continue;
      var bp = p.id * 4;
      for (var k = i + 1; k < ids.length; k++) {
        var q = W.conns[ids[k]];
        if (shortFlag[q.id] || q.from === p.from) continue;
        var bq = q.id * 4;
        var clash = q.to === p.to;
        var boxesMeet = box[bp] <= box[bq + 2] && box[bq] <= box[bp + 2] && box[bp + 1] <= box[bq + 3] && box[bq + 1] <= box[bp + 3];
        if (!clash && boxesMeet) {
          clash = polylinesTouch(p, q, box, bq);
          if (clash && signal && p.turn === STRAIGHT && q.turn === STRAIGHT) (crossing[j] || (crossing[j] = [])).push(p.id, q.id);
        }
        if (!clash && box[bp] - near <= box[bq + 2] && box[bq] - near <= box[bp + 2] && box[bp + 1] - near <= box[bq + 3] && box[bq + 1] - near <= box[bp + 3]) {
          clash = polylinesClose(p, q, box, bq, near);
        }
        if (clash) {
          (lists[p.id] || (lists[p.id] = [])).push(q.id);
          (lists[q.id] || (lists[q.id] = [])).push(p.id);
        }
      }
    }
  }

  /** Stores one connector's conflicts, in id order. */
  function storeConflicts(W, i, lists) {
    if (!lists[i]) {
      W.conns[i].conflicts = NO_IDS;
      return;
    }
    sortIds(lists[i]);
    W.conns[i].conflicts = TLV.world.geom._idsIn(W.index.ids, lists[i]);
  }

  /** Appends the point at arc s on an edge, off metres to the left of digitized direction, to flat x,y pairs. */
  function pushKerbPoint(out, e, s, off, at) {
    TLV.world.geom._pointAlong(e.px, e.py, e.cum, s, at);
    out.push(at.x - at.uy * off, at.y + at.ux * off);
  }

  /**
   * Finds each junction's arms and their mouths, in counter-clockwise order. The mouth is where the arm's lanes stop. An arm's
   * angle is worked out as the arm is made: a field that starts as the integer 0 and later takes a fraction changes the shape
   * of every arm already made, and each one then has to be migrated, one read at a time.
   * @returns {Array<Array<object>>} Arms by junction: { edge, atStart, s, angle }.
   */
  function buildArms(W) {
    var trims = W.index.kerbTrim;
    var share = TLV.tune.world.trimMaxShare;
    var span = TLV.tune.world.headingSpan;
    var along = TLV.world.geom._pointAlong;
    var at = { x: 0.5, y: 0.5, ux: 0.5, uy: 0.5 };
    var arms = [];
    var i;
    for (i = 0; i < W.juncs.length; i++) arms.push([]);
    for (i = 0; i < W.edges.length; i++) {
      var e = W.edges[i];
      for (var end = 0; end < 2; end++) {
        var junc = end === 0 ? e.a : e.b;
        var j = W.juncs[junc];
        var t = Math.min(trims[junc], share * e.len);
        var s = end === 0 ? t : e.len - t;
        along(e.px, e.py, e.cum, s, at);
        // A trimmed mouth stands off the junction, so its own bearing serves. A PASS has none, so the road's way out does.
        if (t < span) along(e.px, e.py, e.cum, end === 0 ? Math.min(e.len, span) : Math.max(0, e.len - span), at);
        arms[junc].push({ edge: i, atStart: end === 0, s: s, angle: Math.atan2(at.y - j.y, at.x - j.x) });
      }
    }
    for (i = 0; i < W.juncs.length; i++) sortArms(arms[i]);
    W.index.arms = arms;
    return arms;
  }

  /** @returns {number} Twice the signed area of flat x,y pairs. Positive is counter-clockwise. */
  function signedArea(p) {
    var n = p.length >> 1;
    var a = 0;
    for (var i = 0, j = n - 1; i < n; j = i++) a += p[2 * j] * p[2 * i + 1] - p[2 * i] * p[2 * j + 1];
    return a;
  }

  /**
   * Polygon of a junction's carriageway: the kerb corners of every arm at its stop line, sorted around their centre, so a
   * concave junction keeps its corners. A cul-de-sac adds the road's end.
   * @returns {Float32Array} x,y pairs, counter-clockwise.
   */
  function junctionPoly(W, list, at) {
    var pts = [];
    for (var q = 0; q < list.length; q++) {
      var e = W.edges[list[q].edge];
      pushKerbPoint(pts, e, list[q].s, e.kerbOffL, at);
      pushKerbPoint(pts, e, list[q].s, -e.kerbOffR, at);
      if (list.length === 1) {
        var end = list[q].atStart ? 0 : e.len;
        pushKerbPoint(pts, e, end, e.kerbOffL, at);
        pushKerbPoint(pts, e, end, -e.kerbOffR, at);
      }
    }
    var n = pts.length >> 1;
    if (n < 3) return new Float32Array(0);
    var mx = 0;
    var my = 0;
    var i;
    for (i = 0; i < n; i++) {
      mx += pts[2 * i];
      my += pts[2 * i + 1];
    }
    mx /= n;
    my /= n;
    // Insertion sort by angle: at most a few dozen corners, and already nearly in order.
    var angle = [];
    var order = [];
    for (i = 0; i < n; i++) {
      // Only the order matters, so this reads a pseudo-angle: the same order as atan2 from -PI to PI, with no trig.
      var dy = pts[2 * i + 1] - my;
      var dx = pts[2 * i] - mx;
      var share = dx / (Math.abs(dx) + Math.abs(dy) || 1);
      var a = dy >= 0 ? 1 - share : share - 1;
      var k = i - 1;
      angle.push(a);
      order.push(i);
      while (k >= 0 && angle[k] > a) {
        angle[k + 1] = angle[k];
        order[k + 1] = order[k];
        k--;
      }
      angle[k + 1] = a;
      order[k + 1] = i;
    }
    var poly = TLV.world.geom._floats(W.index.arena, n * 2);
    for (i = 0; i < n; i++) {
      poly[2 * i] = pts[2 * order[i]];
      poly[2 * i + 1] = pts[2 * order[i] + 1];
    }
    if (signedArea(poly) < 0) {
      for (var u = 0, v = n - 1; u < v; u++, v--) {
        var tx = poly[2 * u];
        var ty = poly[2 * u + 1];
        poly[2 * u] = poly[2 * v];
        poly[2 * u + 1] = poly[2 * v + 1];
        poly[2 * v] = tx;
        poly[2 * v + 1] = ty;
      }
    }
    return poly;
  }

  /**
   * Builds connectors, conflict sets and junction polygons.
   * @param {object} W World with lanes built.
   */
  junctions._build = function (W) {
    buildConnectors(W);
    buildConflicts(W);
    var arms = buildArms(W);
    var at = { x: 0.5, y: 0.5, ux: 0.5, uy: 0.5 };
    for (var i = 0; i < W.juncs.length; i++) W.juncs[i].poly = junctionPoly(W, arms[i], at);
  };

  /** Metres of a connector before it stands clear of every sibling from its lane, to the nearest metre. */
  function siblingClear(W, conn, conns) {
    var T = TLV.tune.world;
    var math = TLV.math;
    var clear = T.siblingClearM;
    var at = { x: 0, y: 0, h: 0 };
    var last = 0;
    for (var s = 0; s <= conn.len; s += 1) {
      math.polyAt(conn.px, conn.py, conn.cum, s, at);
      for (var i = 0; i < conns.length; i++) {
        var o = W.conns[conns[i]];
        if (o.id === conn.id) continue;
        var near = false;
        for (var k = 0; k + 1 < o.px.length && !near; k++) {
          near = math.pointSegDist(at.x, at.y, o.px[k], o.py[k], o.px[k + 1], o.py[k + 1]) < clear;
        }
        if (near) {
          last = s + 1;
          break;
        }
      }
    }
    return Math.min(last, conn.len);
  }

  /** Largest separation of two boxes along their four axes: over 0 means they are apart. Boxes are centre, unit axis, half sizes. */
  function boxApart(ax, ay, ac, as, ahl, ahw, bx, by, bc, bs, bhl, bhw) {
    var dx = bx - ax;
    var dy = by - ay;
    var dot = Math.abs(ac * bc + as * bs);
    var cross = Math.abs(ac * bs - as * bc);
    return Math.max(
      Math.abs(dx * ac + dy * as) - (ahl + bhl * dot + bhw * cross),
      Math.abs(dy * ac - dx * as) - (ahw + bhl * cross + bhw * dot),
      Math.abs(dx * bc + dy * bs) - (bhl + ahl * dot + ahw * cross),
      Math.abs(dy * bc - dx * bs) - (bhw + ahl * cross + ahw * dot)
    );
  }

  /** Walks a connector in steps, reading the box a car on it would fill. @returns {?Float64Array} x, y, cos, sin per sample. */
  function sweepOf(conn, step) {
    var n = Math.max(2, Math.ceil(conn.len / step) + 1);
    var out = new Float64Array(n * 4);
    var at = { x: 0, y: 0, h: 0 };
    for (var i = 0; i < n; i++) {
      TLV.math.polyAt(conn.px, conn.py, conn.cum, Math.min(conn.len, i * step), at);
      out[4 * i] = at.x;
      out[4 * i + 1] = at.y;
      out[4 * i + 2] = Math.cos(at.h);
      out[4 * i + 3] = Math.sin(at.h);
    }
    return out;
  }

  /** @returns {boolean} True when a car standing at this pose touches a car driving a swept connector. */
  function sweepHits(sweep, x, y, c, s, hl, hw) {
    for (var i = 0; i < sweep.length; i += 4) {
      var dx = sweep[i] - x;
      var dy = sweep[i + 1] - y;
      if (dx * dx + dy * dy > 4 * (hl * hl + hw * hw) + 1) continue;
      if (boxApart(x, y, c, s, hl, hw, sweep[i], sweep[i + 1], sweep[i + 2], sweep[i + 3], hl, hw) < 0.01) return true;
    }
    return false;
  }

  /**
   * How far back from its stop line a lane must hold its queue so that a car standing there clears every connector of the other
   * approaches. The contract's stop line clears the kerbs of the road ahead, not the sweep of a car turning across this lane's
   * mouth, and a car waiting in that sweep pins the turner while the turner's occupancy holds it at the line.
   * @returns {Float32Array} Metres by lane id.
   */
  function stopSetbacks(W) {
    var T = TLV.tune.world;
    var ai = TLV.const.LF.AI_ROUTABLE;
    var hl = T.waitBoxLen / 2;
    var hw = T.waitBoxWid / 2;
    var out = new Float32Array(W.lanes.length);
    var at = { x: 0, y: 0, h: 0 };
    for (var j = 0; j < W.juncs.length; j++) {
      var junc = W.juncs[j];
      if (junc.conns.length < 2 || junc.inDir.length < 2) continue;
      var sweeps = new Array(junc.conns.length);
      for (var d = 0; d < junc.inDir.length; d++) {
        var dir = W.dirEdges[junc.inDir[d]];
        if (!dir.aiRoutable) continue;
        for (var l = 0; l < dir.lanes.length; l++) {
          var lane = W.lanes[dir.lanes[l]];
          if (!(lane.flags & ai)) continue;
          var most = Math.min(T.waitBackMax, Math.max(0, lane.len - 2 * hl - T.waitPad));
          var back = 0;
          // Stepping back from one connector can step into another, so it goes round until a pass moves nothing.
          for (var moved = true; moved && back <= most;) {
            moved = false;
            for (var c = 0; c < junc.conns.length; c++) {
              var conn = W.conns[junc.conns[c]];
              if (conn.px.length === 2 || W.lanes[conn.from].dirEdge === dir.id) continue;
              if (!(W.lanes[conn.from].flags & ai) || !(W.lanes[conn.to].flags & ai)) continue;
              if (!sweeps[c]) sweeps[c] = sweepOf(conn, T.waitSweepStep);
              while (back <= most) {
                TLV.math.polyAt(lane.px, lane.py, lane.cum, lane.len - T.waitPad - back - hl, at);
                if (!sweepHits(sweeps[c], at.x, at.y, Math.cos(at.h), Math.sin(at.h), hl, hw)) break;
                back += T.waitBackStep;
                moved = true;
              }
            }
          }
          if (back > most) back = most;
          out[lane.id] = back;
        }
      }
    }
    return out;
  }

  /** Adds a pair to a sparse table of lists. */
  function addPair(table, a, b) {
    (table[a] || (table[a] = [])).push(b);
    (table[b] || (table[b] = [])).push(a);
  }

  /**
   * Pairs of paths, at any junction or across two, whose centres pass closer than a car beside a car and which no conflict set links:
   * neighbouring junctions build their conflicts apart, and two turns can pass within a car's width without meeting.
   * @param {object} W World.
   * @returns {Array} Per connector, the connectors it touches, or undefined.
   */
  function connectorTouches(W) {
    var T = TLV.tune.world;
    var ai = TLV.const.LF.AI_ROUTABLE;
    var cell = T.connTouchM;
    var grid = new Map();
    var pairs = new Map();
    var n = W.conns.length;
    var c;
    var i;
    for (c = 0; c < n; c++) {
      var conn = W.conns[c];
      if (conn.px.length === 2 || !(W.lanes[conn.from].flags & ai) || !(W.lanes[conn.to].flags & ai)) continue;
      for (i = 0; i < conn.px.length; i++) {
        var cx = Math.floor(conn.px[i] / cell);
        var cy = Math.floor(conn.py[i] / cell);
        var key = cy * 100000 + cx;
        var row = grid.get(key);
        if (!row) grid.set(key, row = []);
        row.push(c, i);
      }
    }
    var limit = cell * cell;
    grid.forEach(function (row, key) {
      var cy = Math.round(key / 100000);
      var cx = key - cy * 100000;
      for (var dy = 0; dy <= 1; dy++) {
        for (var dx = dy === 0 ? 0 : -1; dx <= 1; dx++) {
          var other = dx === 0 && dy === 0 ? row : grid.get((cy + dy) * 100000 + cx + dx);
          if (!other) continue;
          for (var a = 0; a < row.length; a += 2) {
            var p = W.conns[row[a]];
            var ax = p.px[row[a + 1]];
            var ay = p.py[row[a + 1]];
            for (var b = other === row ? a + 2 : 0; b < other.length; b += 2) {
              if (other[b] === row[a]) continue;
              var q = W.conns[other[b]];
              var ex = q.px[other[b + 1]] - ax;
              var ey = q.py[other[b + 1]] - ay;
              if (ex * ex + ey * ey >= limit) continue;
              var lo = Math.min(p.id, q.id);
              var hi = Math.max(p.id, q.id);
              var id = lo * n + hi;
              pairs.set(id, (pairs.get(id) || 0) + 1);
            }
          }
        }
      }
    });
    var table = new Array(n);
    var ids = Array.from(pairs.keys()).sort(function (u, v) { return u - v; });
    for (i = 0; i < ids.length; i++) {
      if (pairs.get(ids[i]) < T.connTouchHits) continue;
      var lowId = Math.floor(ids[i] / n);
      var highId = ids[i] - lowId * n;
      var u = W.conns[lowId];
      var v = W.conns[highId];
      if (u.from === v.from || u.to === v.to || u.from === v.to || u.to === v.from) continue;
      if (Array.prototype.indexOf.call(u.conflicts, highId) >= 0) continue;
      addPair(table, lowId, highId);
    }
    return table;
  }

  /**
   * Short lanes of different roads that overlap, which no connector can separate. Only stubs do: WP-MAP's gate holds every other
   * pair apart, and the two it allows are listed in its report.
   * @param {object} W World.
   * @returns {Array} Per lane, the lanes it touches, or undefined.
   */
  function laneTouches(W) {
    var T = TLV.tune.world;
    var LF = TLV.const.LF;
    var math = TLV.math;
    var table = new Array(W.lanes.length);
    var buf = new Int32Array(64);
    var at = { x: 0, y: 0, h: 0 };
    var limit = T.connClearM;
    for (var l = 0; l < W.lanes.length; l++) {
      var lane = W.lanes[l];
      if (!(lane.flags & LF.EXCLUSIVE) || !(lane.flags & LF.AI_ROUTABLE)) continue;
      for (var s = 0; s <= lane.len; s += 1) {
        math.polyAt(lane.px, lane.py, lane.cum, s, at);
        var n = TLV.world.lanes.lanesNear(W, at.x, at.y, limit, buf);
        for (var k = 0; k < n; k++) {
          var o = W.lanes[buf[k]];
          if (o.id <= lane.id || o.edge === lane.edge || !(o.flags & LF.AI_ROUTABLE)) continue;
          if (joined(W, lane, o) || (table[lane.id] && table[lane.id].indexOf(o.id) >= 0)) continue;
          addPair(table, lane.id, o.id);
        }
      }
    }
    return table;
  }

  /** @returns {boolean} True when a connector leads from one lane to the other, so they lie head to tail. */
  function joined(W, a, b) {
    var i;
    for (i = 0; i < a.conns.length; i++) {
      if (W.conns[a.conns[i]].to === b.id) return true;
    }
    for (i = 0; i < b.conns.length; i++) {
      if (W.conns[b.conns[i]].to === a.id) return true;
    }
    return false;
  }

  /**
   * Static tables for AI traffic, built on the first sim of a world and kept, like edgeGrid (D21), so the build budget does
   * not pay for them.
   * @param {object} W World.
   * @returns {{sibClear: Float32Array, setback: Float32Array, connX: Array, laneX: Array}} sibClear: per connector, metres
   *   before it clears the other connectors of its lane. setback: per lane, metres its stop line stands back. connX: per
   *   connector, connectors it touches that no conflict set holds, or undefined. laneX: per lane, lanes it touches, or undefined.
   */
  junctions._contacts = function (W) {
    if (W.index.contacts) return W.index.contacts;
    var sibClear = new Float32Array(W.conns.length);
    for (var l = 0; l < W.lanes.length; l++) {
      var conns = W.lanes[l].conns;
      if (conns.length < 2) continue;
      for (var i = 0; i < conns.length; i++) sibClear[conns[i]] = siblingClear(W, W.conns[conns[i]], conns);
    }
    W.index.contacts = {
      sibClear: sibClear,
      setback: stopSetbacks(W),
      connX: connectorTouches(W),
      laneX: laneTouches(W)
    };
    return W.index.contacts;
  };

  /**
   * @param {object} W World.
   * @param {number} laneId Lane, or -1.
   * @returns {number} The junction at the end of the lane, or -1.
   */
  junctions.ahead = function (W, laneId) {
    var lane = W.lanes[laneId];
    return lane ? W.dirEdges[lane.dirEdge].to : -1;
  };

  /**
   * @param {object} W World.
   * @param {number} laneId Lane, or -1.
   * @param {number} toDirEdge Directed edge to leave on.
   * @returns {number} The connector from this lane onto that directed edge, or -1 when this lane has none.
   */
  junctions.connFor = function (W, laneId, toDirEdge) {
    var lane = W.lanes[laneId];
    if (!lane) return -1;
    for (var i = 0; i < lane.conns.length; i++) {
      var conn = W.conns[lane.conns[i]];
      if (W.lanes[conn.to].dirEdge === toDirEdge) return conn.id;
    }
    return -1;
  };
})(window.TLV);
