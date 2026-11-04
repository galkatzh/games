// js/world/lanes.js — WP-WORLD
// Lane construction (ARCHITECTURE 8.1) and the point and projection queries on lanes and connectors.
(function (TLV) {
  'use strict';

  var lanes = TLV.ns('world.lanes');

  var NO_IDS = new Int32Array(0);

  /** A quarter turn, the limit of "heading within 90 deg". */
  var QUARTER = Math.PI / 2;
  /** Kept above the minimum lane length, so float32 storage cannot round a lane below it. */
  var LEN_ROUNDING = 0.01;
  var STRAIGHT = 0;
  var U_TURN = 3;

  /**
   * Stop line distance for each junction: 0 at a PASS, else clamp(0.5 * widest carriageway + 1.5, 3, 14). A carriageway is
   * measured kerb to kerb, because a stop line must clear the road being crossed, parking strip included.
   * @param {object} W World.
   * @returns {Float64Array} Metres by junction id.
   */
  function junctionTrims(W) {
    var T = TLV.tune.world;
    var widest = new Float64Array(W.juncs.length);
    var i;
    for (i = 0; i < W.edges.length; i++) {
      var e = W.edges[i];
      var w = e.kerbOffL + e.kerbOffR;
      if (w > widest[e.a]) widest[e.a] = w;
      if (w > widest[e.b]) widest[e.b] = w;
    }
    var trims = new Float64Array(W.juncs.length);
    for (i = 0; i < W.juncs.length; i++) {
      if (W.juncs[i].kind === 'PASS') continue;
      trims[i] = TLV.math.clamp(0.5 * widest[i] + T.trimPad, T.trimMin, T.trimMax);
    }
    return trims;
  }

  /** Writes the lane-end point of an offset at a polyline end, and the heading of travel there, into out. */
  function offsetEnd(e, atStart, offRight, travelsForward, out) {
    var n = e.px.length - 1;
    var a = atStart ? 0 : n - 1;
    var dx = e.px[a + 1] - e.px[a];
    var dy = e.py[a + 1] - e.py[a];
    var l = Math.sqrt(dx * dx + dy * dy) || 1;
    // Right of travel, and travel may run against the digitized direction.
    var sign = travelsForward ? 1 : -1;
    out.x = (atStart ? e.px[0] : e.px[n]) + dy / l * offRight * sign;
    out.y = (atStart ? e.py[0] : e.py[n]) - dx / l * offRight * sign;
    out.h = Math.atan2(dy * sign, dx * sign);
  }

  /**
   * How far the lanes through a PASS junction miss each other, over the legal moves and the lane mapping of ARCHITECTURE 8.2.
   * A bend counts too: lanes can meet exactly and still turn sharply on the spot.
   * @returns {Float64Array} Largest gap in metres, by junction id, the bend included as passBendPerRad metres per radian.
   */
  function passMisfit(W) {
    var T = TLV.tune.world;
    var t = W.index.moves;
    var out = new Float64Array(W.juncs.length);
    var a = { x: 0, y: 0, h: 0 };
    var b = { x: 0, y: 0, h: 0 };
    var minBend = T.passBendDeg * Math.PI / 180;
    for (var i = 0; i < t.n; i++) {
      var from = t.col.from[i];
      var ef = W.edges[from >> 1];
      if (!ef) continue;
      // Most moves are not at a PASS, so this comes first: this loop sees every move of a cold build.
      var j = from & 1 ? ef.a : ef.b;
      if (W.juncs[j].kind !== 'PASS') continue;
      var to = t.col.to[i];
      // A U-turn back down its own road cannot use a pull-back. One onto another road is the sharpest bend there is.
      if (t.col.turn[i] === U_TURN && from >> 1 === to >> 1) continue;
      var et = W.edges[to >> 1];
      if (!et) continue;
      var nIn = from & 1 ? ef.lanesB : ef.lanesF;
      var nOut = to & 1 ? et.lanesB : et.lanesF;
      if (!nIn || !nOut) continue;
      for (var lane = 0; lane < nIn; lane++) {
        var target = Math.round(lane / Math.max(1, nIn - 1) * (nOut - 1));
        offsetEnd(ef, (from & 1) === 1, laneOffset(ef, nIn, lane), (from & 1) === 0, a);
        offsetEnd(et, (to & 1) === 0, laneOffset(et, nOut, target), (to & 1) === 0, b);
        var gap = Math.sqrt((a.x - b.x) * (a.x - b.x) + (a.y - b.y) * (a.y - b.y));
        var bend = Math.abs(TLV.math.wrapPi(b.h - a.h));
        if (bend >= minBend) gap = Math.max(gap, T.connShortChord) + bend * T.passBendPerRad;
        if (gap > out[j]) out[j] = gap;
      }
    }
    return out;
  }

  /**
   * Lane trims: the stop line distances, plus a smoothing pull-back at any PASS junction whose lanes do not line up. Without
   * it a one-way meeting a two-way street, or a sharp bend in a road, leaves a sideways step in a metre or so of connector
   * that no car can drive. The contract trims no PASS, so this is limited to where lanes really miss.
   * @param {object} W World.
   * @param {Float64Array} stops Stop line distances.
   * @returns {Float64Array} Metres by junction id.
   */
  function laneTrims(W, stops) {
    var T = TLV.tune.world;
    var misfit = passMisfit(W);
    var out = stops.slice();
    for (var i = 0; i < W.juncs.length; i++) {
      if (misfit[i] < T.connShortChord) continue;
      out[i] = TLV.math.clamp(T.passTrimPerChord * misfit[i] + T.passTrimPad, T.passTrimMin, T.passTrimMax);
    }
    return out;
  }

  /** @returns {number} Offset to the right of travel of lane idx in a direction with n lanes (ARCHITECTURE 8.1). */
  function laneOffset(e, n, idx) {
    return e.lanesB > 0 ? (n - idx - 0.5) * e.laneW : ((n - 1) / 2 - idx) * e.laneW;
  }

  /**
   * Cuts a lane's trims from its polyline, keeping at least laneMinLen. Each stop line is capped at 45% of the edge. A pull-back
   * from a neighbouring lane comes on top, and shares what is left above the minimum. If what remains would still be too short,
   * both trims shrink in proportion.
   * @returns {{px: Float32Array, py: Float32Array, cum: Float32Array, len: number}}
   */
  function trimmedLane(W, off, trimStart, trimEnd, backStart, backEnd, edgeLen) {
    var T = TLV.tune.world;
    var geom = TLV.world.geom;
    var total = geom._lineLength(off);
    var t0 = Math.min(trimStart, T.trimMaxShare * edgeLen);
    var t1 = Math.min(trimEnd, T.trimMaxShare * edgeLen);
    var pulled = backStart + backEnd;
    if (pulled > 0) {
      var share = Math.min(1, Math.max(0, total - t0 - t1 - T.laneMinLen - LEN_ROUNDING) / pulled);
      t0 += backStart * share;
      t1 += backEnd * share;
    }
    if (total - t0 - t1 < T.laneMinLen + LEN_ROUNDING && t0 + t1 > 0) {
      var scale = Math.max(0, total - T.laneMinLen - LEN_ROUNDING) / (t0 + t1);
      t0 *= scale;
      t1 *= scale;
    }
    if (t0 <= 0 && t1 <= 0) return geom._store(W.index.arena, off);
    var cut = W.index.lineC;
    geom._cutLine(off, t0, total - t1, cut);
    return geom._store(W.index.arena, cut);
  }

  /** Writes a lane's bounding box into the flat array. */
  function storeBox(box, id, lane) {
    var minX = Infinity;
    var minY = Infinity;
    var maxX = -Infinity;
    var maxY = -Infinity;
    for (var i = 0; i < lane.px.length; i++) {
      var x = lane.px[i];
      var y = lane.py[i];
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    box[4 * id] = minX;
    box[4 * id + 1] = minY;
    box[4 * id + 2] = maxX;
    box[4 * id + 3] = maxY;
  }

  /** Builds the lanes of one direction of an edge, and its DirEdge. */
  function buildDirection(W, e, dir, trims, nextId) {
    var T = TLV.tune.world;
    var LF = TLV.const.LF;
    var EF = TLV.const.EF;
    var n = dir === 0 ? e.lanesF : e.lanesB;
    var de = e.id * 2 + dir;
    var back = W.index.laneBack;
    var line = W.index.lineA;
    var off = W.index.lineB;
    TLV.world.geom._loadLine(e.px, e.py, dir === 1, line);
    if (n <= 0 || line.n < 2) {
      W.dirEdges[de] = null;
      return nextId;
    }
    var from = dir === 0 ? e.a : e.b;
    var to = dir === 0 ? e.b : e.a;
    var span = Math.min(T.headingSpan, e.len * 0.5);
    var ai = (e.flags & (dir === 0 ? EF.AI_F : EF.AI_B)) !== 0;
    var ids = TLV.world.geom._idView(W.index.ids, n);
    var vmax = e.kmh / 3.6;
    for (var idx = 0; idx < n; idx++) {
      TLV.world.geom._offsetLine(line, laneOffset(e, n, idx), off);
      var cut = trimmedLane(W, off, trims[from], trims[to], back[2 * de], back[2 * de + 1], e.len);
      var flags = 0;
      if (ai) flags |= LF.AI_ROUTABLE;
      if (e.flags & EF.NARROW) flags |= LF.NARROW;
      if (cut.len < T.exclusiveCarLen + T.exclusivePad) flags |= LF.EXCLUSIVE;
      var id = nextId++;
      ids[idx] = id;
      W.lanes[id] = {
        id: id,
        edge: e.id,
        dirEdge: de,
        idx: idx,
        len: cut.len,
        vmax: vmax,
        width: e.laneW,
        cls: e.cls,
        flags: flags,
        px: cut.px,
        py: cut.py,
        cum: cut.cum,
        left: -1,
        right: -1,
        opposite: -1,
        conns: NO_IDS,
        zones: NO_IDS,
        stops: NO_IDS
      };
    }
    for (var k = 0; k < n; k++) {
      W.lanes[ids[k]].right = k > 0 ? ids[k - 1] : -1;
      W.lanes[ids[k]].left = k + 1 < n ? ids[k + 1] : -1;
    }
    var a = W.index.tmpPoint;
    var b = W.index.tmpPoint2;
    var startH = dir === 0 ? TLV.world.geom._headingOver(e.px, e.py, e.cum, 0, span, a, b) :
      TLV.world.geom._headingOver(e.px, e.py, e.cum, e.len, e.len - span, a, b);
    var endH = dir === 0 ? TLV.world.geom._headingOver(e.px, e.py, e.cum, e.len - span, e.len, a, b) :
      TLV.world.geom._headingOver(e.px, e.py, e.cum, span, 0, a, b);
    W.dirEdges[de] = {
      id: de,
      edge: e.id,
      dir: dir,
      from: from,
      to: to,
      lanes: ids,
      len: e.len,
      cls: e.cls,
      vmax: vmax,
      aiRoutable: ai,
      moves: NO_IDS,
      hIn: startH,
      hOut: endH
    };
    return nextId;
  }

  /** Builds both directions of an edge from a first lane id, and links their innermost lanes. @returns {number} Next free id. */
  function buildEdge(W, e, trims, nextId) {
    var after = buildDirection(W, e, 0, trims, nextId);
    after = buildDirection(W, e, 1, trims, after);
    var f = W.dirEdges[e.id * 2];
    var b = W.dirEdges[e.id * 2 + 1];
    if (f && b) {
      W.lanes[f.lanes[e.lanesF - 1]].opposite = b.lanes[e.lanesB - 1];
      W.lanes[b.lanes[e.lanesB - 1]].opposite = f.lanes[e.lanesF - 1];
    }
    return after;
  }

  /** @returns {boolean} True when a lane of one directed edge ends within reach of a lane of the next, with room to give. */
  function lanesTouch(W, from, to, near2, room) {
    var ids = from.lanes;
    var out = to.lanes;
    for (var p = 0; p < ids.length; p++) {
      var a = W.lanes[ids[p]];
      var last = a.px.length - 1;
      var ax = a.px[last];
      var ay = a.py[last];
      for (var q = 0; q < out.length; q++) {
        var b = W.lanes[out[q]];
        var dx = b.px[0] - ax;
        var dy = b.py[0] - ay;
        if (dx * dx + dy * dy < near2 && a.len + b.len >= room) return true;
      }
    }
    return false;
  }

  /**
   * Finds junctions where lanes meet at the point of a V, each only touching because of where the stop line fell. No curve fits
   * in the gap between them, so all that junction's lanes stand further back. Only those edges are rebuilt, keeping their ids.
   * @param {object} W World with lanes built.
   * @param {Float64Array} trims Lane trims by junction. Updated.
   */
  function pullBackKinks(W, trims) {
    var T = TLV.tune.world;
    var t = W.index.moves;
    if (!t.n) return;
    var near2 = T.connShortChord * T.connShortChord;
    var room = 2 * T.laneMinLen + T.connKinkRoom;
    var vee = T.connKinkVeeDeg * Math.PI / 180;
    var froms = t.col.from;
    var tos = t.col.to;
    var turns = t.col.turn;
    var dirs = W.dirEdges;
    var marked = null;
    var i;
    for (i = 0; i < t.n; i++) {
      // These tests turn away 97 moves in 100 before any lane is read: a straight move, a U-turn on its own road, whose lanes are
      // a road's width apart, and any turn that does not double back.
      if (turns[i] === STRAIGHT || froms[i] >> 1 === tos[i] >> 1) continue;
      var from = dirs[froms[i]];
      var to = dirs[tos[i]];
      if (!from || !to) continue;
      var bend = Math.abs(to.hIn - from.hOut);
      if (bend > Math.PI) bend = 2 * Math.PI - bend;
      if (bend < vee || from.to !== to.from || !lanesTouch(W, from, to, near2, room)) continue;
      if (!marked) marked = new Uint8Array(W.juncs.length);
      marked[from.to] = 1;
    }
    if (!marked) return;
    for (i = 0; i < marked.length; i++) {
      if (marked[i]) trims[i] += T.connKinkTrim;
    }
    for (i = 0; i < W.edges.length; i++) {
      var e = W.edges[i];
      var d = dirs[i * 2] || dirs[i * 2 + 1];
      if (d && (marked[e.a] || marked[e.b])) buildEdge(W, e, trims, d.lanes[0]);
    }
  }

  /** Binary search of the sorted moves table. @returns {boolean} True when the move from one directed edge to another exists. */
  function hasMove(t, from, to) {
    var lo = 0;
    var hi = t.n - 1;
    while (lo <= hi) {
      var mid = (lo + hi) >> 1;
      var d = t.col.from[mid] - from || t.col.to[mid] - to;
      if (d === 0) return true;
      if (d < 0) lo = mid + 1;
      else hi = mid - 1;
    }
    return false;
  }

  /**
   * How far one lane must pull back from one junction to clear another lane. Where the two run within reach of each other is a
   * stretch of this lane, and a stretch belongs to whichever end of the lane it is nearer, or both ends would pull back from it and
   * leave a stub standing in it. The far end of a V stays put this way, because the stretch at its point is not its own. The walk
   * stops at the end of the first stretch, or once two lanes that have not met stop closing: most pairs at a junction are parallel.
   * @param {object} a Lane being walked.
   * @param {boolean} aStart Walk from its start, else from its end.
   * @param {object} b The other lane.
   * @param {boolean} bStart Which of b's ends is at this junction.
   * @param {boolean} chain True when a car can drive from one lane to the other, so they may lie head to tail.
   * @returns {number} Metres to pull back, 0 for none, or -1 when the two never come within reach.
   */
  function clearFrom(a, aStart, b, bStart, chain) {
    var T = TLV.tune.world;
    var dist = TLV.math.pointSegDist;
    var need = T.laneClearM;
    var step = T.laneClearStep;
    var gap = T.laneClearGap;
    var reach = T.laneClearReach;
    var limit = Math.min(reach, a.len);
    var bx = b.px;
    var by = b.py;
    var bc = b.cum;
    // Only the stretch of b within reach of this junction: lanes can run to hundreds of spans.
    var k0 = 0;
    var k1 = bx.length - 1;
    if (bStart) {
      while (k1 > 1 && bc[k1 - 1] > reach) k1--;
    } else {
      while (k0 + 2 < bx.length && b.len - bc[k0 + 1] > reach) k0++;
    }
    var ax = a.px;
    var ay = a.py;
    var ac = a.cum;
    var i = aStart ? 0 : ax.length - 2;
    var from = -1;
    var to = -1;
    var last = Infinity;
    var s = 0;
    while (s <= limit) {
      var along = aStart ? s : a.len - s;
      while (aStart ? (i + 2 < ax.length && ac[i + 1] < along) : (i > 0 && ac[i] > along)) i += aStart ? 1 : -1;
      var l = ac[i + 1] - ac[i];
      var u = l > 0 ? (along - ac[i]) / l : 0;
      var x = ax[i] + (ax[i + 1] - ax[i]) * u;
      var y = ay[i] + (ay[i + 1] - ay[i]) * u;
      var best = Infinity;
      var near = false;
      for (var k = k0; k < k1; k++) {
        var d = dist(x, y, bx[k], by[k], bx[k + 1], by[k + 1]);
        if (d < best) best = d;
        // Head to tail is one road, not two lanes side by side. A hairpin's two arms do stand side by side.
        if (d < need && (!chain || (ax[i + 1] - ax[i]) * (bx[k + 1] - bx[k]) + (ay[i + 1] - ay[i]) * (by[k + 1] - by[k]) <= 0)) near = true;
      }
      if (near) {
        if (from < 0) from = s;
        to = s;
      } else if (from >= 0 ? s - to > gap : best >= last) {
        break;
      }
      last = best;
      // Walking a metre moves a point at most a metre closer to anything, so a point well clear of b needs no sample between.
      s += best - need > step ? best - need : step;
    }
    if (from < 0) return -1;
    // A stretch ends somewhere before the next sample. Most of the way there errs by a tenth of a metre at the angles this is about.
    return from <= a.len - to ? to + step * 0.75 : 0;
  }

  /** Pulls back two directed ends as far as each of their lanes needs. @returns {boolean} True when any lane moved. */
  function clearEnds(W, endP, endQ) {
    var t = W.index.moves;
    var back = W.index.laneBack;
    var dp = W.dirEdges[endP >> 1];
    var dq = W.dirEdges[endQ >> 1];
    var startP = (endP & 1) === 0;
    var startQ = (endQ & 1) === 0;
    var chain = startP !== startQ && (startP ? hasMove(t, dq.id, dp.id) : hasMove(t, dp.id, dq.id));
    var moved = false;
    for (var la = 0; la < dp.lanes.length; la++) {
      for (var lb = 0; lb < dq.lanes.length; lb++) {
        var a = W.lanes[dp.lanes[la]];
        var b = W.lanes[dq.lanes[lb]];
        var pullP = clearFrom(a, startP, b, startQ, chain);
        // Reach is mutual, so lanes that a walk along one finds apart need no walk along the other.
        if (pullP < 0) continue;
        var pullQ = clearFrom(b, startQ, a, startP, chain);
        if (pullP > back[endP]) {
          back[endP] = pullP;
          moved = true;
        }
        if (pullQ > back[endQ]) {
          back[endQ] = pullQ;
          moved = true;
        }
      }
    }
    return moved;
  }

  /** Clears every pair of a junction's directed ends that leave it close together. Its own function, so it tiers up early in a cold build. */
  function clearJunction(W, junc, bearing, wide, touched) {
    var ins = junc.inDir;
    var outs = junc.outDir;
    var n = outs.length + ins.length;
    // A PASS has two arms, and where a one-way meets a two-way road their lanes can start back to back.
    var limit = junc.kind === 'PASS' ? Math.PI : wide;
    for (var p = 0; p < n; p++) {
      var endP = p < outs.length ? 2 * outs[p] : 2 * ins[p - outs.length] + 1;
      var hp = bearing[endP];
      for (var q = p + 1; q < n; q++) {
        var endQ = q < outs.length ? 2 * outs[q] : 2 * ins[q - outs.length] + 1;
        // An end is edge * 4 + direction * 2 + atEnd.
        if (endQ >> 2 === endP >> 2) continue;
        var apart = hp - bearing[endQ];
        if (apart < 0) apart = -apart;
        if (apart > Math.PI) apart = 2 * Math.PI - apart;
        if (apart > limit || !clearEnds(W, endP, endQ)) continue;
        touched[endP >> 2] = 1;
        touched[endQ >> 2] = 1;
      }
    }
  }

  /**
   * Lanes of two roads that meet at a shallow angle run side by side past the stop line, at a Y, a fork or a merge, and no
   * conflict set covers a lane. So a pair of lanes within a car's width of each other both stop where they come clear, and the
   * connectors carry the split, where conflict sets serialize it. Each direction keeps one stop line, across all its lanes. Only
   * lane ends move, so a pull-back cannot make a new contact. Arms that leave a junction far apart are not read at all: this
   * pass sees every junction of a cold build, and most arms stand a quarter turn apart.
   * @param {object} W World with lanes built.
   * @param {Float64Array} trims Lane trims by junction.
   */
  function pullBackNeighbours(W, trims) {
    var dirs = W.dirEdges;
    var wide = TLV.tune.world.laneClearArmDeg * Math.PI / 180;
    // By directed end, de * 2 at its start and de * 2 + 1 at its end: its bearing seen from the junction.
    var bearing = new Float64Array(dirs.length * 2);
    var touched = new Uint8Array(W.edges.length);
    var i;
    for (i = 0; i < dirs.length; i++) {
      var d = dirs[i];
      if (!d) continue;
      bearing[2 * i] = d.hIn;
      bearing[2 * i + 1] = d.hOut > 0 ? d.hOut - Math.PI : d.hOut + Math.PI;
    }
    for (i = 0; i < W.juncs.length; i++) clearJunction(W, W.juncs[i], bearing, wide, touched);
    for (i = 0; i < touched.length; i++) {
      if (!touched[i]) continue;
      var f = dirs[i * 2] || dirs[i * 2 + 1];
      if (f) buildEdge(W, W.edges[i], trims, f.lanes[0]);
    }
  }

  /** Lists each junction's arriving and leaving directed edges. */
  function junctionLists(W) {
    var inLists = [];
    var outLists = [];
    var i;
    for (i = 0; i < W.juncs.length; i++) {
      inLists.push([]);
      outLists.push([]);
    }
    for (i = 0; i < W.dirEdges.length; i++) {
      var d = W.dirEdges[i];
      if (!d) continue;
      outLists[d.from].push(i);
      inLists[d.to].push(i);
    }
    for (i = 0; i < W.juncs.length; i++) {
      W.juncs[i].inDir = TLV.world.geom._idsIn(W.index.ids, inLists[i]);
      W.juncs[i].outDir = TLV.world.geom._idsIn(W.index.ids, outLists[i]);
    }
  }

  /** Binds bus stops to the lanes that serve them: the kerb lane of the stop's direction. */
  function bindStops(W) {
    var perLane = new Map();
    var i;
    for (i = 0; i < W.stops.length; i++) {
      var stop = W.stops[i];
      var d = W.dirEdges[stop.edge * 2 + stop.dir] || W.dirEdges[stop.edge * 2 + (1 - stop.dir)];
      if (!d) continue;
      stop.laneId = d.lanes[0];
      if (!perLane.has(stop.laneId)) perLane.set(stop.laneId, []);
      perLane.get(stop.laneId).push(stop);
    }
    perLane.forEach(function (list, laneId) {
      // Stops are sorted along travel, which runs against s on a backward lane.
      var back = W.lanes[laneId].dirEdge % 2 === 1;
      list.sort(function (p, q) { return (back ? q.s - p.s : p.s - q.s) || p.id - q.id; });
      W.lanes[laneId].stops = Int32Array.from(list.map(function (s) { return s.id; }));
    });
  }

  /**
   * Builds lanes and directed edges.
   * @param {object} W World with its map tables loaded.
   */
  lanes._build = function (W) {
    W.index.tmpPoint = { x: 0.5, y: 0.5, h: 0.5, ux: 0.5, uy: 0.5 };
    W.index.tmpPoint2 = { x: 0.5, y: 0.5, h: 0.5, ux: 0.5, uy: 0.5 };
    W.index.tmpProject = { s: 0, d: 0, side: 0 };
    W.index.lineA = TLV.world.geom._newLine();
    W.index.lineB = TLV.world.geom._newLine();
    W.index.lineC = TLV.world.geom._newLine();
    W.index.lineD = TLV.world.geom._newLine();
    W.index.kerbTrim = junctionTrims(W);
    var trims = laneTrims(W, W.index.kerbTrim);
    W.dirEdges = new Array(W.edges.length * 2);
    W.index.laneBack = new Float32Array(W.edges.length * 4);
    var nextId = 0;
    for (var i = 0; i < W.edges.length; i++) nextId = buildEdge(W, W.edges[i], trims, nextId);
    pullBackKinks(W, trims);
    junctionLists(W);
    pullBackNeighbours(W, trims);
    var box = new Float32Array(W.lanes.length * 4);
    for (var l = 0; l < W.lanes.length; l++) storeBox(box, l, W.lanes[l]);
    W.index.laneBox = box;
    bindStops(W);
  };

  /**
   * Point and heading on a lane.
   * @param {object} W World.
   * @param {number} laneId Lane, or -1.
   * @param {number} s Metres along it, clamped.
   * @param {{x:number,y:number,h:number}} [out] Written and returned.
   * @returns {?{x:number,y:number,h:number}} Null for an unknown lane.
   */
  lanes.pointAt = function (W, laneId, s, out) {
    var lane = W.lanes[laneId];
    if (!lane) return null;
    return TLV.math.polyAt(lane.px, lane.py, lane.cum, s, out);
  };

  /**
   * The heading of a car crossing a 2-point connector. Such a connector is a joint, not a path: on the inside of a bend its lanes
   * overlap, so its chord runs backward, and a chord of a few millimetres points anywhere. So the heading comes from the lanes,
   * read over a stretch of each, and turns from the one to the other along the joint.
   * @returns {number} Radians.
   */
  function jointHeading(W, conn, s) {
    var span = TLV.tune.world.connKinkSpan;
    var geom = TLV.world.geom;
    var a = W.index.tmpPoint;
    var b = W.index.tmpPoint2;
    var f = W.lanes[conn.from];
    var t = W.lanes[conn.to];
    var hIn = geom._headingOver(f.px, f.py, f.cum, Math.max(0, f.len - span), f.len, a, b);
    var hOut = geom._headingOver(t.px, t.py, t.cum, 0, Math.min(t.len, span), a, b);
    var share = TLV.math.clamp(s / conn.len, 0, 1);
    return TLV.math.wrapPi(hIn + TLV.math.wrapPi(hOut - hIn) * share);
  }

  /**
   * Point and heading on a connector.
   * @param {object} W World.
   * @param {number} connId Connector, or -1.
   * @param {number} s Metres along it, clamped.
   * @param {{x:number,y:number,h:number}} [out] Written and returned.
   * @returns {?{x:number,y:number,h:number}} Null for an unknown connector.
   */
  lanes.connPointAt = function (W, connId, s, out) {
    var conn = W.conns[connId];
    if (!conn) return null;
    var at = TLV.math.polyAt(conn.px, conn.py, conn.cum, s, out);
    if (conn.px.length === 2) at.h = jointHeading(W, conn, s);
    return at;
  };

  /** @returns {number} Squared distance from a point to a lane's bounding box. */
  function boxDist2(box, id, x, y) {
    var dx = x < box[4 * id] ? box[4 * id] - x : (x > box[4 * id + 2] ? x - box[4 * id + 2] : 0);
    var dy = y < box[4 * id + 1] ? box[4 * id + 1] - y : (y > box[4 * id + 3] ? y - box[4 * id + 3] : 0);
    return dx * dx + dy * dy;
  }

  /**
   * Finds the lane nearest a point. Shared by project and routing, which can ask for AI-routable lanes only.
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {?number} h Heading, or null to ignore it.
   * @param {number} maxDist Search radius, metres.
   * @param {boolean} aiOnly Only AI_ROUTABLE lanes.
   * @param {object} [out] Written and returned.
   * @returns {?{laneId:number,s:number,lat:number,dist:number,headingErr:number}} Null when nothing is in range.
   */
  lanes._nearest = function (W, x, y, h, maxDist, aiOnly, out) {
    var math = TLV.math;
    var index = W.index;
    var grid = index.laneGrid;
    if (!grid) return null;
    var useHeading = h !== null && h !== undefined;
    var box = index.laneBox;
    var aiFlag = TLV.const.LF.AI_ROUTABLE;
    var tmp = index.tmpProject;
    var at = index.tmpPoint;
    var stamp = TLV.world.spatial._nextStamp(index.laneStamps);
    var seen = index.laneStamps.marks;
    var max2 = maxDist * maxDist;
    var cell = grid.cell;
    var cx0 = Math.max(0, Math.floor((x - maxDist - grid.minX) / cell));
    var cx1 = Math.min(grid.nx - 1, Math.floor((x + maxDist - grid.minX) / cell));
    var cy0 = Math.max(0, Math.floor((y - maxDist - grid.minY) / cell));
    var cy1 = Math.min(grid.ny - 1, Math.floor((y + maxDist - grid.minY) / cell));
    var best = -1;
    var bestD = Infinity;
    var bestS = 0;
    var bestSide = 0;
    var bestErr = 0;
    var anyBest = -1;
    var anyD = Infinity;
    var anyS = 0;
    var anySide = 0;
    var anyErr = 0;
    for (var cy = cy0; cy <= cy1; cy++) {
      for (var cx = cx0; cx <= cx1; cx++) {
        var c = cy * grid.nx + cx;
        for (var k = grid.start[c]; k < grid.start[c + 1]; k++) {
          var id = grid.items[k];
          if (seen[id] === stamp) continue;
          seen[id] = stamp;
          var lane = W.lanes[id];
          if (aiOnly && !(lane.flags & aiFlag)) continue;
          if (boxDist2(box, id, x, y) > max2) continue;
          math.polyProject(lane.px, lane.py, lane.cum, x, y, -1, tmp);
          if (tmp.d > maxDist) continue;
          var err = 0;
          if (useHeading) {
            math.polyAt(lane.px, lane.py, lane.cum, tmp.s, at);
            err = math.wrapPi(h - at.h);
          }
          if (tmp.d < anyD || (tmp.d === anyD && id < anyBest)) {
            anyBest = id;
            anyD = tmp.d;
            anyS = tmp.s;
            anySide = tmp.side;
            anyErr = err;
          }
          if (useHeading && err >= -QUARTER && err <= QUARTER && (tmp.d < bestD || (tmp.d === bestD && id < best))) {
            best = id;
            bestD = tmp.d;
            bestS = tmp.s;
            bestSide = tmp.side;
            bestErr = err;
          }
        }
      }
    }
    if (best < 0) {
      best = anyBest;
      bestD = anyD;
      bestS = anyS;
      bestSide = anySide;
      bestErr = anyErr;
    }
    if (best < 0) return null;
    var r = out || {};
    r.laneId = best;
    r.s = bestS;
    r.lat = bestSide * bestD;
    r.dist = bestD;
    r.headingErr = bestErr;
    return r;
  };

  /**
   * Nearest lane to a point. With a heading, a lane within 90 deg of it wins over a closer one that is not.
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {?number} h Heading, or null to ignore it.
   * @param {number} maxDist Search radius, metres.
   * @param {object} [out] Written and returned.
   * @returns {?{laneId:number,s:number,lat:number,dist:number,headingErr:number}} lat is + left of travel. headingErr is
   *   h minus the lane's heading, 0 with no heading. Null when nothing is in range.
   */
  lanes.project = function (W, x, y, h, maxDist, out) {
    return lanes._nearest(W, x, y, h, maxDist, false, out);
  };

  /**
   * Lanes whose centreline comes within r of a point, without duplicates, in a fixed order that depends only on the query.
   * @param {object} W World.
   * @param {number} x Point x.
   * @param {number} y Point y.
   * @param {number} r Radius, metres.
   * @param {Int32Array} out Receives lane ids. It stops filling when full.
   * @returns {number} Count written.
   */
  lanes.lanesNear = function (W, x, y, r, out) {
    var index = W.index;
    var grid = index.laneGrid;
    if (!grid) return 0;
    var box = index.laneBox;
    var math = TLV.math;
    var stamp = TLV.world.spatial._nextStamp(index.laneStamps);
    var seen = index.laneStamps.marks;
    var r2 = r * r;
    var cell = grid.cell;
    var cx0 = Math.max(0, Math.floor((x - r - grid.minX) / cell));
    var cx1 = Math.min(grid.nx - 1, Math.floor((x + r - grid.minX) / cell));
    var cy0 = Math.max(0, Math.floor((y - r - grid.minY) / cell));
    var cy1 = Math.min(grid.ny - 1, Math.floor((y + r - grid.minY) / cell));
    var count = 0;
    for (var cy = cy0; cy <= cy1; cy++) {
      for (var cx = cx0; cx <= cx1; cx++) {
        var c = cy * grid.nx + cx;
        for (var k = grid.start[c]; k < grid.start[c + 1]; k++) {
          var id = grid.items[k];
          if (seen[id] === stamp) continue;
          seen[id] = stamp;
          if (boxDist2(box, id, x, y) > r2) continue;
          var lane = W.lanes[id];
          var near = false;
          for (var i = 0; i + 1 < lane.px.length && !near; i++) {
            near = math.pointSegDist(x, y, lane.px[i], lane.py[i], lane.px[i + 1], lane.py[i + 1]) <= r;
          }
          if (!near) continue;
          if (count >= out.length) return count;
          out[count++] = id;
        }
      }
    }
    return count;
  };

  /**
   * @param {object} W World.
   * @param {number} laneId Lane, or -1.
   * @returns {Int32Array} Connectors leaving the lane, rightmost exit first. Empty for an unknown lane.
   */
  lanes.nextConns = function (W, laneId) {
    var lane = W.lanes[laneId];
    return lane ? lane.conns : NO_IDS;
  };
})(window.TLV);
