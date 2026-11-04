// tools/lib/graph.mjs — WP-MAP
// Passes 4 to 7, 10 to 12b and 14: from raw OSM ways to junction clusters, edges, movements and connectivity.

import { Grid, clampToBox, clipSegment, cumulative, polyLength, segCross, segHitT, sortedById } from './osm.mjs';

const KEPT_HIGHWAYS = new Set(['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street',
  'service', 'primary_link', 'secondary_link', 'tertiary_link']);
const BLOCKED_ACCESS = new Set(['no', 'private']);
const OPEN_ACCESS = new Set(['yes', 'permissive', 'designated', 'destination']);
const DROPPED_SERVICE = new Set(['parking_aisle', 'driveway']);
const GARAGE_RAMP = /floor|קומה/i;

const MERGE_EDGE_M = 25;
const MERGE_DIAMETER_M = 50;

/**
 * Pass 10 on streets of `NARROW_CLASSES` alone. An internal edge has no lanes, and a 50 m cluster on a 6 m wide street is a
 * connector running past houses, sometimes through them. There is no dual carriageway to resolve here, so the cap is low.
 */
const NARROW_MERGE_EDGE_M = 16;
const NARROW_DIAMETER_M = 24;
const NARROW_CLASSES = new Set(['unclassified', 'residential', 'living_street', 'service']);
const SIGNAL_CLUSTER_M = 35;

/** On narrow streets junctions stand closer together, so 35 m would reach the next corner along and light that too. */
const SIGNAL_NARROW_M = 15;
const SIGNAL_NODE_M = 6;
const RING_MIN_RADIUS_M = 6;

/**
 * A ring at least this big keeps its island: its arcs stay edges and cars circulate. Below it a ring still counts as `RING`,
 * as pass 12 says, but it is a blob: on a smaller circle a lane's trims would meet and connectors would span the island anyway.
 */
const RING_KEEP_RADIUS_M = 8;

/** Two ring hubs closer than this along the ring are one entry, not two: an arc this short cannot hold a lane and its trims. */
const RING_ARC_MIN_M = 6;
const MIN_EDGE_M = 3;
const MIN_PORTAL_EDGE_M = 8;
const UTURN_BAN_RAD = (155 * Math.PI) / 180;
const STRAIGHT_RAD = (35 * Math.PI) / 180;
const HEADING_SPAN_DM = 100;
const HEADING_SPAN_LONG_DM = 300;

/**
 * Roads are cut this far inside the bbox. Lanes sit up to 6 m from the centreline, so a road meeting the `BOUNDS` wall at a
 * shallow angle, or hugging it, would otherwise cross the wall well before its own polyline reaches it.
 */
const ROAD_INSET_DM = 60;

/** Overlay tag on a way: where it crosses a road with no shared node, join them at grade instead of cutting the lower one. */
export const AT_GRADE_TAG = 'tlv:at_grade';

export const KIND = { PASS: 0, PRIORITY: 1, SIGNAL: 2, RING: 3 };
export const JF = { PORTAL: 1, DEAD_END: 2 };
export const EF = { ROUNDABOUT: 1, BRIDGE: 2, NARROW: 4, AI_F: 8, AI_B: 16, LINK: 32 };
export const TURN = { STRAIGHT: 0, RIGHT: 1, LEFT: 2, UTURN: 3 };

/** Road class of a highway value, with the `_link` suffix removed. */
export function baseClass(highway) {
  return highway.replace(/_link$/, '');
}

/** True for a `junction` value that implies one-way circulation. */
function isRingJunction(t) {
  return t.junction === 'roundabout' || t.junction === 'circular';
}

/** True when a way carries traffic in one direction only. */
export function isOneway(t) {
  return isRingJunction(t) || t.oneway === 'yes' || t.oneway === 'true' || t.oneway === '1' || t.oneway === '-1';
}

/** Why pass 4 drops a way, or null to keep it. */
function dropReason(t) {
  if (!KEPT_HIGHWAYS.has(t.highway)) return t.highway.startsWith('motorway') ? 'motorway' : 'class';
  if (t.tunnel === 'yes' || t.tunnel === 'building_passage') return 'tunnel';
  // `motor_vehicle` is the narrower tag, so `access=no` with `motor_vehicle=yes` is a street closed to everything but cars.
  if (BLOCKED_ACCESS.has(t.motor_vehicle) || (BLOCKED_ACCESS.has(t.access) && !OPEN_ACCESS.has(t.motor_vehicle))) return 'access';
  if (DROPPED_SERVICE.has(t.service)) return 'service';
  if (GARAGE_RAMP.test(t.name || '') || GARAGE_RAMP.test(t['name:en'] || '')) return 'garageRamp';
  return null;
}

/**
 * Pass 4: keeps drivable ways. Bridges stay: dropping them shrinks the giant component from 473 to 366 km.
 * @param {object} osm Loaded extract.
 * @returns {{ways: object[], dropped: Object<string, number>}}
 */
export function filterRoads(osm) {
  const ways = [];
  const dropped = {};
  for (const w of sortedById(osm.ways)) {
    if (!w.tags || !w.tags.highway) continue;
    const why = dropReason(w.tags);
    if (why) dropped[why] = (dropped[why] || 0) + 1;
    else ways.push(w);
  }
  return { ways, dropped };
}

/**
 * Pass 5: cuts ways at the bbox, inset by `ROAD_INSET_DM`. A way needs one node in the bbox to survive, and each stretch
 * inside becomes a piece. New end nodes are synthetic, have negative ids and carry `portal`. The pieces of a way come out in
 * travel order.
 * @param {object[]} ways Kept ways, sorted by id.
 * @param {Map} nodes Node records, which receive the portal nodes.
 * @param {object} bbox Decimetre box.
 * @returns {{pieces: object[], outside: number, portals: number}}
 */
export function clipRoads(ways, nodes, bbox) {
  const pieces = [];
  let outside = 0;
  let nextId = -1;
  const box = {
    minX: bbox.minX + ROAD_INSET_DM,
    minY: bbox.minY + ROAD_INSET_DM,
    maxX: bbox.maxX - ROAD_INSET_DM,
    maxY: bbox.maxY - ROAD_INSET_DM
  };
  const within = (n, b) => n.x >= b.minX && n.x <= b.maxX && n.y >= b.minY && n.y <= b.maxY;
  const inside = (n) => within(n, box);
  const portal = (a, b, t) => {
    const [x, y] = clampToBox(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, box);
    const id = nextId--;
    nodes.set(id, { id, x, y, portal: true });
    return id;
  };
  for (const w of ways) {
    const ids = w.nodes.filter((id) => nodes.has(id));
    if (ids.length < 2 || !ids.some((id) => within(nodes.get(id), bbox))) {
      outside++;
      continue;
    }
    const reversed = w.tags.oneway === '-1';
    const mine = [];
    let cur = null;
    const flush = () => {
      if (cur && cur.length >= 2) {
        const list = reversed ? cur.slice().reverse() : cur;
        mine.push({ way: w.id, tags: w.tags, base: w.baseTags || w.tags, nodes: list, rev: reversed, oneway: isOneway(w.tags) });
      }
      cur = null;
    };
    for (let i = 1; i < ids.length; i++) {
      const a = nodes.get(ids[i - 1]);
      const b = nodes.get(ids[i]);
      const ia = inside(a);
      const ib = inside(b);
      if (ia && ib) {
        if (!cur) cur = [a.id];
        cur.push(b.id);
        continue;
      }
      const c = clipSegment(a.x, a.y, b.x, b.y, box);
      if (!c) {
        flush();
      } else if (ia) {
        if (!cur) cur = [a.id];
        cur.push(portal(a, b, c[1]));
        flush();
      } else if (ib) {
        flush();
        cur = [portal(a, b, c[0]), b.id];
      } else {
        flush();
        cur = [portal(a, b, c[0]), portal(a, b, c[1])];
        flush();
      }
    }
    flush();
    pieces.push(...(reversed ? mine.reverse() : mine));
  }
  return { pieces, outside, portals: -1 - nextId };
}

/** Rank for pass 6. A higher number loses its crossing segment. A link sits just below its class. */
function classRank(t, classOrder) {
  const base = classOrder.indexOf(baseClass(t.highway));
  return (base < 0 ? classOrder.length : base) * 2 + (t.highway.endsWith('_link') ? 1 : 0);
}

/**
 * Finds every pair of segments that cross with no shared node.
 * @param {Array<{ax: number, ay: number, bx: number, by: number, na: *, nb: *}>} segs Segments.
 * @returns {Array<number[]>} Index pairs in deterministic order.
 */
export function findCrossings(segs) {
  const grid = new Grid(500);
  segs.forEach((s, i) => grid.addSeg(s.ax, s.ay, s.bx, s.by, i));
  const seen = new Set();
  const out = [];
  for (const list of grid.map.values()) {
    for (let p = 0; p < list.length; p++) {
      for (let q = p + 1; q < list.length; q++) {
        const i = Math.min(list[p], list[q]);
        const j = Math.max(list[p], list[q]);
        const key = i * segs.length + j;
        if (seen.has(key)) continue;
        seen.add(key);
        const a = segs[i];
        const b = segs[j];
        if (a.na === b.na || a.na === b.nb || a.nb === b.na || a.nb === b.nb) continue;
        if (segCross(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by)) out.push([i, j]);
      }
    }
  }
  return out.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
}

/**
 * Pass 6: resolves crossings with no shared node by deleting the lower-class way's crossing segment. Over or under, the
 * world is flat, so two roads that cross without a junction would otherwise merge traffic at a point that has no
 * junction. A tie keeps the bridge, then the longer way, then the lower id. A way an overlay tagged `AT_GRADE_TAG` keeps its
 * segment: both roads get a new shared node at the crossing, which is a street corner like any other.
 * @param {object[]} pieces Pieces from pass 5.
 * @param {Map} nodes Node records, which receive the shared nodes.
 * @param {string[]} classOrder Classes, major first.
 * @returns {{pieces: object[], crossings: number, joined: number, removedKm: number, sites: object[]}}
 */
export function gradeSeparate(pieces, nodes, classOrder) {
  const segs = [];
  const wayLen = new Map();
  pieces.forEach((p, pi) => {
    let len = 0;
    for (let i = 1; i < p.nodes.length; i++) {
      const a = nodes.get(p.nodes[i - 1]);
      const b = nodes.get(p.nodes[i]);
      len += Math.hypot(a.x - b.x, a.y - b.y);
      segs.push({ pi, i, ax: a.x, ay: a.y, bx: b.x, by: b.y, na: a.id, nb: b.id, p });
    }
    wayLen.set(p.way, (wayLen.get(p.way) || 0) + len);
  });
  const crossings = findCrossings(segs);
  const cut = new Set();
  const sites = [];
  const shared = new Map();
  let removedDm = 0;
  let nextId = -1;
  for (const id of nodes.keys()) if (id <= nextId) nextId = id - 1;
  const share = (idx, t, id) => {
    if (!shared.has(idx)) shared.set(idx, []);
    shared.get(idx).push({ t, id });
  };
  const joinAt = (i, j) => {
    const a = segs[i];
    const b = segs[j];
    const t = segHitT(a.ax, a.ay, a.bx, a.by, b.ax, b.ay, b.bx, b.by);
    const u = segHitT(b.ax, b.ay, b.bx, b.by, a.ax, a.ay, a.bx, a.by);
    const id = nextId--;
    nodes.set(id, { id, x: Math.round(a.ax + (a.bx - a.ax) * t), y: Math.round(a.ay + (a.by - a.ay) * t) });
    share(i, t, id);
    share(j, u, id);
  };
  const atGrade = (p) => p.tags[AT_GRADE_TAG] === 'yes';
  for (const [i, j] of crossings) {
    if (atGrade(segs[i].p) || atGrade(segs[j].p)) joinAt(i, j);
  }
  for (const [i, j] of crossings) {
    const a = segs[i];
    const b = segs[j];
    if (atGrade(a.p) || atGrade(b.p) || cut.has(i) || cut.has(j)) continue;
    const ra = classRank(a.p.tags, classOrder);
    const rb = classRank(b.p.tags, classOrder);
    let loser;
    if (ra !== rb) loser = ra > rb ? i : j;
    else if ((a.p.tags.bridge === 'yes') !== (b.p.tags.bridge === 'yes')) loser = a.p.tags.bridge === 'yes' ? j : i;
    else if (wayLen.get(a.p.way) !== wayLen.get(b.p.way)) loser = wayLen.get(a.p.way) < wayLen.get(b.p.way) ? i : j;
    else loser = a.p.way > b.p.way ? i : j;
    cut.add(loser);
    const s = segs[loser];
    const other = loser === i ? b : a;
    removedDm += Math.hypot(s.ax - s.bx, s.ay - s.by);
    sites.push({
      cut: s.p.way,
      name: s.p.tags['name:en'] || s.p.tags.name || '',
      kept: other.p.way,
      keptName: other.p.tags['name:en'] || other.p.tags.name || '',
      x: Math.round(s.ax / 10),
      y: Math.round(s.ay / 10)
    });
  }
  const byPiece = new Map();
  const onSeg = (idx) => {
    const s = segs[idx];
    if (!byPiece.has(s.pi)) byPiece.set(s.pi, { cuts: new Set(), adds: new Map() });
    return byPiece.get(s.pi);
  };
  for (const idx of cut) onSeg(idx).cuts.add(segs[idx].i);
  for (const [idx, list] of shared) onSeg(idx).adds.set(segs[idx].i, list.sort((p, q) => p.t - q.t));
  const out = [];
  pieces.forEach((p, pi) => {
    const edits = byPiece.get(pi);
    if (!edits) {
      out.push(p);
      return;
    }
    let cur = [p.nodes[0]];
    for (let i = 1; i < p.nodes.length; i++) {
      if (edits.cuts.has(i)) {
        if (cur.length >= 2) out.push({ ...p, nodes: cur });
        cur = [p.nodes[i]];
      } else {
        for (const add of edits.adds.get(i) || []) cur.push(add.id);
        cur.push(p.nodes[i]);
      }
    }
    if (cur.length >= 2) out.push({ ...p, nodes: cur });
  });
  return { pieces: out, crossings: crossings.length, joined: shared.size >> 1, removedKm: removedDm / 10000, sites };
}

/** True when a node is a mapped traffic light. */
function isSignalNode(n) {
  return !!(n.tags && n.tags.highway === 'traffic_signals');
}

/**
 * Signature two ways must share to contract across their boundary, seen in the direction of travel along the seg.
 * @param {object} part Way part of a seg.
 * @param {object} [t] Tags to read, the part's own by default.
 * @returns {string}
 */
function partSignature(part, t = part.tags) {
  const swap = (k) => {
    if (!part.rev) return k;
    if (k.startsWith('parking:left')) return k.replace('parking:left', 'parking:right');
    if (k.startsWith('parking:right')) return k.replace('parking:right', 'parking:left');
    return k;
  };
  const parking = Object.keys(t).filter((k) => k.startsWith('parking:')).map((k) => `${swap(k)}=${t[k]}`).sort();
  return JSON.stringify([
    t.highway,
    t.name || '',
    isOneway(t),
    t.lanes || '',
    (part.rev ? t['lanes:backward'] : t['lanes:forward']) || '',
    (part.rev ? t['lanes:forward'] : t['lanes:backward']) || '',
    t.maxspeed || '',
    t.bridge === 'yes',
    isRingJunction(t),
    parking
  ]);
}

/** Reverses a seg's digitized direction. Only ever done to a two-way seg. */
function flip(seg) {
  [seg.a, seg.b] = [seg.b, seg.a];
  seg.ids.reverse();
  seg.parts.reverse();
  for (const p of seg.parts) p.rev = !p.rev;
}

/** Removes one occurrence of a seg from a node's incidence list. */
function unlink(G, id, seg) {
  const list = G.inc.get(id);
  if (!list) return;
  const i = list.indexOf(seg);
  if (i >= 0) list.splice(i, 1);
  if (list.length === 0) G.inc.delete(id);
}

/**
 * Orients two segs meeting at a node so the first ends there and the second starts there.
 * @returns {boolean} False when one-way directions meet head to head or tail to tail.
 */
function alignAt(h, s1, s2) {
  if (s1.oneway !== s2.oneway) return false;
  if (s1.oneway) return s1.b === h && s2.a === h;
  if (s1.b !== h) flip(s1);
  if (s2.a !== h) flip(s2);
  return true;
}

/** Appends `s2` to `s1` across node `h`. `alignAt` has run. */
function join(G, h, s1, s2) {
  unlink(G, h, s1);
  unlink(G, h, s2);
  unlink(G, s2.b, s2);
  s1.ids.push(...s2.ids.slice(1));
  s1.parts.push(...s2.parts);
  s1.b = s2.b;
  s1.len += s2.len;
  s2.dead = true;
  const list = G.inc.get(s1.b);
  if (list) list.push(s1);
  else G.inc.set(s1.b, [s1]);
}

/**
 * Contracts removable degree-2 nodes.
 * @param {object} G Graph.
 * @param {number[]} [forced] Nodes to contract whatever their tags say, for a stub too short to keep.
 * @returns {number} Nodes contracted.
 */
function contractDegree2(G, forced) {
  let merged = 0;
  const ids = forced || [...G.inc.keys()].sort((a, b) => a - b);
  for (const h of ids) {
    const list = G.inc.get(h);
    if (!list || list.length !== 2 || list[0] === list[1]) continue;
    const n = G.nodes.get(h);
    if (n.portal || (isSignalNode(n) && !forced)) continue;
    let [s1, s2] = list;
    if (s1.oneway && s2.oneway && s1.a === h) [s1, s2] = [s2, s1];
    if (!alignAt(h, s1, s2)) continue;
    const tail = s1.parts[s1.parts.length - 1];
    const head = s2.parts[0];
    const sameBase = partSignature(tail, tail.base) === partSignature(head, head.base);
    // Both must agree. An overlay that gives a way its neighbour's tags must not join them, or the neighbour is measured anew.
    if (!forced && (!sameBase || partSignature(tail) !== partSignature(head))) {
      if (sameBase) G.overlaySplits.add(h);
      continue;
    }
    join(G, h, s1, s2);
    merged++;
  }
  return merged;
}

/**
 * Drops what WP-WORLD cannot build a lane on. A lane is at least 3 m, so an edge under that must not exist, and an edge
 * ending at a portal must leave room for the 3 m clear of the wall. A dropped portal stub hands its portal on when that
 * leaves a dead end. Where the road carries on as a through street there is no dead end to bar, so no portal remains.
 */
function removeStubs(G) {
  let removed = 0;
  for (let round = 0; round < 8; round++) {
    let changed = 0;
    const live = G.segs.filter((s) => !s.dead).sort((a, b) => a.len - b.len || a.ids[0] - b.ids[0]);
    for (const s of live) {
      if (s.dead) continue;
      const portal = G.nodes.get(s.a).portal || G.nodes.get(s.b).portal;
      if (s.len >= MIN_EDGE_M * 10 && !(portal && s.len < MIN_PORTAL_EDGE_M * 10)) continue;
      const degA = (G.inc.get(s.a) || []).length;
      const degB = (G.inc.get(s.b) || []).length;
      if (degA === 1 || degB === 1) {
        const inner = G.nodes.get(s.a).portal ? s.b : s.a;
        unlink(G, s.a, s);
        unlink(G, s.b, s);
        s.dead = true;
        removed++;
        changed++;
        // The road still leaves the box here, so the end it now stops at is the portal, or nothing bars it.
        if (portal && (G.inc.get(inner) || []).length === 1) G.nodes.get(inner).portal = true;
      } else if (degA === 2 && !G.nodes.get(s.a).portal) {
        changed += contractDegree2(G, [s.a]);
      } else if (degB === 2 && !G.nodes.get(s.b).portal) {
        changed += contractDegree2(G, [s.b]);
      }
    }
    changed += contractDegree2(G);
    if (!changed) break;
  }
  return removed;
}

/**
 * Pass 7: splits pieces at shared nodes and contracts degree-2 nodes. A signal node stays as a pass-through junction, and
 * a way boundary contracts only when both ways agree on the tags that shape the road.
 * @param {object[]} pieces Pieces after pass 6.
 * @param {Map} nodes Node records.
 * @returns {object} Graph with `nodes`, `inc`, `segs`, `signalNodes`.
 */
export function buildGraph(pieces, nodes) {
  const use = new Map();
  for (const p of pieces) for (const id of p.nodes) use.set(id, (use.get(id) || 0) + 1);
  const signalNodes = [];
  for (const id of use.keys()) if (isSignalNode(nodes.get(id))) signalNodes.push(id);
  signalNodes.sort((a, b) => a - b);

  // A loop, because a spread of every node id overflows the stack on an area larger than the shipped one.
  let lowestId = -1;
  for (const id of nodes.keys()) {
    if (id < lowestId) lowestId = id;
  }

  const G = {
    nodes,
    inc: new Map(),
    segs: [],
    signalNodes,
    nextNodeId: lowestId - 1,
    overlaySplits: new Set()
  };
  // Pieces arrive in travel order, so `seq` rises along each way and survives contraction inside `parts`.
  let seq = 0;
  const addSeg = (p, ids) => {
    let len = 0;
    for (let i = 1; i < ids.length; i++) {
      const a = nodes.get(ids[i - 1]);
      const b = nodes.get(ids[i]);
      len += Math.hypot(a.x - b.x, a.y - b.y);
    }
    const seg = {
      a: ids[0],
      b: ids[ids.length - 1],
      ids,
      oneway: p.oneway,
      len,
      parts: [{ way: p.way, tags: p.tags, base: p.base || p.tags, rev: p.rev, len, seq: seq++ }],
      sub: 0,
      subW: 1,
      dead: false
    };
    G.segs.push(seg);
    for (const end of [seg.a, seg.b]) {
      const list = G.inc.get(end);
      if (list) list.push(seg);
      else G.inc.set(end, [seg]);
    }
  };
  for (const p of pieces) {
    const list = p.nodes.filter((id, i) => i === 0 || id !== p.nodes[i - 1]);
    if (list.length < 2) continue;
    let start = 0;
    for (let i = 1; i < list.length; i++) {
      if (i === list.length - 1 || use.get(list[i]) > 1 || isSignalNode(nodes.get(list[i]))) {
        addSeg(p, list.slice(start, i + 1));
        start = i;
      }
    }
  }
  G.contracted = contractDegree2(G);
  G.stubsRemoved = removeStubs(G);
  return G;
}

/**
 * Removes unnamed service stubs that dead-end inside a footprint. These are garage entrances, the same thing pass 4 drops
 * when a ramp happens to be named. Left in, section 6.3 would give the road the win and take the collider off a whole
 * building: 8 m and 28 m stubs hollowed out the main wing of Dizengoff Center.
 * @param {object} G Graph from `buildGraph`.
 * @param {function(number, number): boolean} insideBuilding Point test, decimetres.
 * @returns {number} Stubs removed.
 */
export function dropGarageStubs(G, insideBuilding) {
  let removed = 0;
  for (let round = 0; round < 8; round++) {
    let changed = 0;
    for (const s of G.segs) {
      if (s.dead) continue;
      const t = s.parts[0].tags;
      if (t.highway !== 'service' || t.name || s.parts.length !== 1) continue;
      const atA = (G.inc.get(s.a) || []).length === 1;
      const atB = (G.inc.get(s.b) || []).length === 1;
      if (atA === atB) continue;
      const end = G.nodes.get(atA ? s.a : s.b);
      if (end.portal || !insideBuilding(end.x, end.y)) continue;
      // Without its overlay this seg joins the road beside it, so it is no stub.
      if (G.overlaySplits.has(atA ? s.b : s.a)) continue;
      unlink(G, s.a, s);
      unlink(G, s.b, s);
      s.dead = true;
      changed++;
    }
    removed += changed;
    if (!changed) break;
    contractDegree2(G);
  }
  return removed;
}

/** Longest contributing way of a seg, by summed length, ties to the lower id. */
function longestWay(seg) {
  const byWay = new Map();
  for (const p of seg.parts) byWay.set(p.way, (byWay.get(p.way) || 0) + p.len);
  let best = null;
  let bestLen = -1;
  for (const [way, len] of [...byWay].sort((a, b) => a[0] - b[0])) {
    if (len > bestLen) {
      best = way;
      bestLen = len;
    }
  }
  return best;
}

/**
 * Fills a seg's polyline, its vertex ids and its part extents.
 * @param {object} seg Seg with final `ids`.
 * @param {Map} nodes Node records.
 * @param {Map<number, {x: number, y: number}>} [shift] How far pass 13 moved a node. The records stay as OSM has them, because
 * crossings, POIs and buildings read the same nodes.
 */
export function shapeSeg(seg, nodes, shift) {
  const pts = [];
  const ptIds = [];
  for (const id of seg.ids) {
    const n = nodes.get(id);
    const d = shift && shift.get(id);
    const x = d ? Math.round(n.x + d.x) : n.x;
    const y = d ? Math.round(n.y + d.y) : n.y;
    const m = pts.length;
    if (m && pts[m - 2] === x && pts[m - 1] === y) continue;
    pts.push(x, y);
    ptIds.push(id);
  }
  seg.pts = pts;
  seg.ptIds = ptIds;
  seg.cum = cumulative(pts);
  seg.lenDm = seg.cum[seg.cum.length - 1];
  let s = 0;
  const total = seg.parts.reduce((sum, p) => sum + p.len, 0) || 1;
  for (const p of seg.parts) {
    p.s0 = (s / total) * seg.lenDm;
    s += p.len;
    p.s1 = (s / total) * seg.lenDm;
  }
}

/** Sets a seg's way and direction, then its shape. */
function finishSeg(seg, nodes) {
  seg.way = longestWay(seg);
  const main = seg.parts.filter((p) => p.way === seg.way);
  seg.tags = main[0].tags;
  seg.pos = Math.min(...main.map((p) => p.seq));
  if (!seg.oneway && main[0].rev) {
    flip(seg);
    seg.sub = 1 - seg.sub - seg.subW;
  }
  shapeSeg(seg, nodes);
  seg.ring = isRingJunction(seg.tags);
}

/**
 * Puts junctions back on their nodes after pass 13 moved some.
 * @param {object[]} juncs Junctions.
 * @param {Map} nodes Node records.
 * @param {Map<number, {x: number, y: number}>} shift From `separateCarriageways`.
 */
export function replaceJunctions(juncs, nodes, shift) {
  for (const j of juncs) {
    if (!j.placing.some((id) => shift.has(id))) continue;
    let x = 0;
    let y = 0;
    for (const id of j.placing) {
      const n = nodes.get(id);
      const d = shift.get(id) || { x: 0, y: 0 };
      x += n.x + d.x;
      y += n.y + d.y;
    }
    j.x = Math.round(x / j.placing.length);
    j.y = Math.round(y / j.placing.length);
  }
}

/**
 * Divides a seg's parts at an arc length, so each half names only the ways it really holds. A halfway cut through one part
 * leaves that part on both sides.
 * @param {object[]} parts Parts in travel order.
 * @param {number} at Arc length, decimetres.
 * @returns {object[][]} `[head, tail]`, neither empty.
 */
function splitParts(parts, at) {
  const head = [];
  const tail = [];
  let s = 0;
  for (const p of parts) {
    const cut = Math.max(0, Math.min(p.len, at - s));
    if (cut >= 1) head.push({ ...p, len: cut });
    if (p.len - cut >= 1) tail.push({ ...p, len: p.len - cut });
    s += p.len;
  }
  return [head.length ? head : [{ ...parts[0] }], tail.length ? tail : [{ ...parts[parts.length - 1] }]];
}

/**
 * Splits a seg at its middle so no edge has `a === b`, which would make its two ends indistinguishable to movements. The
 * split point is a vertex when there is one to spare, else a new node. `sub` and `subW` record which stretch of the original
 * each half is, because two halves of one way part tie on position along the way.
 * @returns {number} Id of the node at the split.
 */
function splitSeg(G, seg) {
  let mid;
  if (seg.ids.length > 2) {
    mid = seg.ids[seg.ids.length >> 1];
  } else {
    const a = G.nodes.get(seg.ids[0]);
    const b = G.nodes.get(seg.ids[1]);
    mid = G.nextNodeId--;
    G.nodes.set(mid, { id: mid, x: Math.round((a.x + b.x) / 2), y: Math.round((a.y + b.y) / 2) });
    seg.ids.splice(1, 0, mid);
  }
  const i = seg.ids.indexOf(mid);
  seg.subW /= 2;
  const tail = {
    ...seg,
    a: mid,
    ids: seg.ids.slice(i),
    sub: seg.sub + seg.subW,
    dead: false
  };
  seg.ids = seg.ids.slice(0, i + 1);
  seg.b = mid;
  const lenOf = (s) => polyLength(s.ids.flatMap((id) => [G.nodes.get(id).x, G.nodes.get(id).y]));
  seg.len = lenOf(seg);
  tail.len = lenOf(tail);
  [seg.parts, tail.parts] = splitParts(seg.parts, seg.len);
  G.segs.push(tail);
  G.inc.set(mid, [seg, tail]);
  const list = G.inc.get(tail.b);
  list[list.lastIndexOf(seg)] = tail;
  return mid;
}

/** Roundabouts: connected groups of ring segs. */
function findRings(G) {
  const groups = [];
  const owner = new Map();
  const live = G.segs.filter((s) => !s.dead && s.parts.some((p) => isRingJunction(p.tags)));
  for (const s of live) {
    const hits = new Set();
    for (const id of [s.a, s.b]) if (owner.has(id)) hits.add(owner.get(id));
    let g;
    if (hits.size) {
      const list = [...hits];
      g = list[0];
      for (const other of list.slice(1)) {
        g.segs.push(...other.segs);
        for (const n of other.nodes) {
          g.nodes.add(n);
          owner.set(n, g);
        }
        other.gone = true;
      }
    } else {
      g = { segs: [], nodes: new Set() };
      groups.push(g);
    }
    g.segs.push(s);
    for (const id of s.ids) {
      g.nodes.add(id);
      owner.set(id, g);
    }
  }
  const rings = groups.filter((g) => !g.gone);
  for (const g of rings) {
    let cx = 0;
    let cy = 0;
    const list = [...g.nodes];
    for (const id of list) {
      cx += G.nodes.get(id).x;
      cy += G.nodes.get(id).y;
    }
    cx /= list.length;
    cy /= list.length;
    let r = 0;
    for (const id of list) r += Math.hypot(G.nodes.get(id).x - cx, G.nodes.get(id).y - cy);
    g.radiusM = r / list.length / 10;
    g.hubs = list.filter((id) => G.inc.has(id)).sort((a, b) => a - b);
  }
  return rings;
}

/**
 * Pass 10, with the small-roundabout half of pass 12: unions junction nodes across short edges, smallest first, rejecting
 * a union that would stretch the cluster past 50 m. A degree-2 node between two junctions is transparent, so a signal
 * node on a short link does not stop a dual carriageway resolving into one cluster.
 * @param {object} G Graph from `buildGraph`.
 * @returns {object} `G`, with `clusterOf`, `clusters` and `rings` added.
 */
export function mergeJunctions(G) {
  for (const seg of G.segs.filter((s) => !s.dead)) if (seg.a === seg.b) splitSeg(G, seg);
  const degree = (id) => (G.inc.get(id) || []).length;
  const parent = new Map();
  const members = new Map();
  const find = (x) => {
    if (!parent.has(x)) {
      parent.set(x, x);
      members.set(x, [x]);
    }
    let r = x;
    while (parent.get(r) !== r) r = parent.get(r);
    while (parent.get(x) !== r) {
      const next = parent.get(x);
      parent.set(x, r);
      x = next;
    }
    return r;
  };
  const diameterOf = (list) => {
    let d = 0;
    for (let i = 0; i < list.length; i++) {
      const a = G.nodes.get(list[i]);
      for (let j = i + 1; j < list.length; j++) {
        const b = G.nodes.get(list[j]);
        d = Math.max(d, Math.hypot(a.x - b.x, a.y - b.y));
      }
    }
    return d;
  };
  const union = (a, b) => {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return true;
    const list = members.get(ra).concat(members.get(rb));
    parent.set(rb, ra);
    members.set(ra, list);
    members.delete(rb);
    return true;
  };

  const rings = findRings(G);
  const ringOf = new Map();
  rings.forEach((ring, r) => {
    if (ring.radiusM >= RING_KEEP_RADIUS_M) for (const id of ring.hubs) ringOf.set(id, r);
    if (ring.radiusM >= RING_MIN_RADIUS_M) return;
    for (let i = 1; i < ring.hubs.length; i++) union(ring.hubs[0], ring.hubs[i]);
  });
  // A hub is narrow when every road at it is a narrow street, and a cluster when all its hubs are.
  const narrowSeg = (s) => s.parts.every((p) => NARROW_CLASSES.has(baseClass(p.tags.highway)));
  const narrowHub = (id) => (G.inc.get(id) || []).every(narrowSeg);
  const narrow = (list) => list.every(narrowHub);
  // Two hubs of a kept ring stay apart however they could be reached, or the arc between them is lost and the island with it.
  const sameRing = (p, q) => {
    const seen = new Set();
    for (const id of p) if (ringOf.has(id)) seen.add(ringOf.get(id));
    return q.some((id) => ringOf.has(id) && seen.has(ringOf.get(id)));
  };

  const links = [];
  const hubs = [...G.inc.keys()].sort((a, b) => a - b);
  for (const j of hubs) {
    if (degree(j) < 3) continue;
    for (const first of G.inc.get(j)) {
      let cur = j;
      let seg = first;
      let len = 0;
      const via = [];
      for (;;) {
        len += seg.len;
        const next = seg.a === cur ? seg.b : seg.a;
        if (len >= MERGE_EDGE_M * 10) break;
        if (degree(next) >= 3) {
          if (next !== j && (j < next)) links.push({ a: j, b: next, len, via });
          break;
        }
        if (degree(next) < 2 || G.nodes.get(next).portal) break;
        via.push(next);
        const list = G.inc.get(next);
        const other = list[0] === seg ? list[1] : list[0];
        if (other === first) break;
        cur = next;
        seg = other;
      }
    }
  }
  links.sort((p, q) => p.len - q.len || p.a - q.a || p.b - q.b);
  const accepted = [];
  for (const link of links) {
    const ra = find(link.a);
    const rb = find(link.b);
    if (ra === rb) {
      accepted.push(link);
      continue;
    }
    const list = members.get(ra).concat(members.get(rb));
    if (link.len >= MIN_EDGE_M * 10) {
      const tight = narrow(list);
      if (tight && link.len > NARROW_MERGE_EDGE_M * 10) continue;
      if (diameterOf(list) > (tight ? NARROW_DIAMETER_M : MERGE_DIAMETER_M) * 10) continue;
      if (link.len >= RING_ARC_MIN_M * 10 && sameRing(members.get(ra), members.get(rb))) continue;
    }
    union(ra, rb);
    accepted.push(link);
  }
  for (const link of accepted) for (const id of link.via) union(link.a, id);

  const clusterOf = new Map();
  for (const id of hubs) clusterOf.set(id, find(id));
  // An edge that leaves a cluster and comes back is a street, not an internal link. Yehudit Boulevard is 252 m of one. The
  // same goes for the long way round a kept ring whose two hubs sit one short arc apart.
  const ringSegs = new Set();
  for (const ring of rings) if (ring.radiusM >= RING_KEEP_RADIUS_M) for (const s of ring.segs) ringSegs.add(s);
  const longArc = (s) => ringSegs.has(s) && s.len >= RING_ARC_MIN_M * 10;
  for (const seg of G.segs.filter((s) => !s.dead)) {
    if ((seg.len >= MERGE_DIAMETER_M * 10 || longArc(seg)) && clusterOf.get(seg.a) === clusterOf.get(seg.b)) {
      const mid = splitSeg(G, seg);
      clusterOf.set(mid, mid);
    }
  }
  G.clusterOf = clusterOf;
  G.rings = rings;
  G.linksConsidered = links.length;
  G.linksAccepted = accepted.length;
  return G;
}

/**
 * Passes 11 and 12: separates internal edges from arms, numbers junctions and edges, and sets ring kinds.
 * Edges of one way stay adjacent and in travel order, which is what lets `TLV.anchors` return them in travel order.
 * @param {object} G Graph after `mergeJunctions`.
 * @returns {object} `G`, with `edges`, `juncs` and `internal` added.
 */
export function finishGraph(G) {
  const live = G.segs.filter((s) => !s.dead);
  for (const seg of live) finishSeg(seg, G.nodes);
  const isInternal = (s) => G.clusterOf.get(s.a) === G.clusterOf.get(s.b);
  const internal = live.filter(isInternal);
  const arms = live.filter((s) => !isInternal(s));

  const inCluster = new Map();
  for (const [id, c] of G.clusterOf) {
    if (!inCluster.has(c)) inCluster.set(c, []);
    inCluster.get(c).push(id);
  }
  const used = new Set();
  for (const s of arms) {
    used.add(G.clusterOf.get(s.a));
    used.add(G.clusterOf.get(s.b));
  }
  const ringHubs = new Set();
  for (const ring of G.rings) {
    if (ring.radiusM < RING_MIN_RADIUS_M) continue;
    for (const id of ring.hubs) ringHubs.add(id);
  }
  G.keptRings = G.rings.filter((r) => r.radiusM >= RING_KEEP_RADIUS_M).map((r) => [...new Set(r.segs.flatMap((s) => s.parts.map((p) => p.way)))].sort((a, b) => a - b));

  const juncs = [];
  for (const c of [...used].sort((a, b) => a - b)) {
    const list = inCluster.get(c).sort((a, b) => a - b);
    // A node that is a hub only because an overlay kept two ways apart must not move the junction.
    const placing = list.filter((id) => !G.overlaySplits.has(id));
    const weighted = placing.length ? placing : list;
    let x = 0;
    let y = 0;
    let portal = false;
    let ring = false;
    for (const id of weighted) {
      const n = G.nodes.get(id);
      x += n.x;
      y += n.y;
    }
    for (const id of list) {
      portal = portal || !!G.nodes.get(id).portal;
      ring = ring || ringHubs.has(id);
    }
    juncs.push({
      key: c,
      members: list,
      placing: weighted,
      x: Math.round(x / weighted.length),
      y: Math.round(y / weighted.length),
      portal,
      ring,
      arms: 0,
      kind: KIND.PRIORITY,
      flags: 0
    });
  }
  // Morton order on 64 m cells keeps the delta columns small.
  const morton = (x, y) => {
    let cx = Math.floor((x + 200000) / 640);
    let cy = Math.floor((y + 200000) / 640);
    let m = 0;
    for (let b = 0, f = 1; b < 12; b++, f *= 4) {
      m += ((cx & 1) + (cy & 1) * 2) * f;
      cx >>= 1;
      cy >>= 1;
    }
    return m;
  };
  juncs.sort((p, q) => morton(p.x, p.y) - morton(q.x, q.y) || p.key - q.key);
  const juncOf = new Map();
  juncs.forEach((j, i) => {
    j.id = i;
    juncOf.set(j.key, i);
  });

  arms.sort((p, q) => p.way - q.way || p.pos - q.pos || p.sub - q.sub);
  G.edges = sortAlongWay(arms, G);
  G.edges.forEach((e, i) => {
    e.id = i;
    e.ja = juncOf.get(G.clusterOf.get(e.a));
    e.jb = juncOf.get(G.clusterOf.get(e.b));
    juncs[e.ja].arms++;
    juncs[e.jb].arms++;
  });
  G.juncs = juncs;
  G.juncOf = juncOf;
  G.internal = internal;
  for (const j of juncs) {
    if (j.portal) j.flags |= JF.PORTAL;
    if (j.arms === 1) j.flags |= JF.DEAD_END;
    if (j.arms === 2 && j.members.length === 1 && !j.portal) j.kind = KIND.PASS;
    // A seam between two ring ways is a bend in the ring, with nothing to give way to.
    if (j.ring && j.arms >= 2 && j.kind !== KIND.PASS) j.kind = KIND.RING;
  }
  return G;
}

/**
 * The edges an overlay split apart at way boundaries, each chain rebuilt as the one edge it is without the overlay. Pass 7
 * must not contract across changed tags, so the neighbours of an overlaid way get edges of their own, but they are the same
 * road they were: `crossSection` takes their widths from this chain, and an overlay on one way leaves them alone.
 * @param {object} G Graph after `finishGraph`.
 * @returns {object[]} Finished segs with base tags, plus `ja`, `jb` and `members`, a list of `{ e, along, s }`: the real edge,
 * whether it runs the chain's way, and where it starts on the chain.
 */
export function overlayChains(G) {
  const live = new Set(G.edges);
  const joints = new Map();
  for (const h of [...G.overlaySplits].sort((a, b) => a - b)) {
    const list = G.inc.get(h);
    if (!list || list.length !== 2 || !list.every((s) => live.has(s)) || list[0] === list[1]) continue;
    if (G.juncs[G.juncOf.get(G.clusterOf.get(h))].members.length !== 1) continue;
    joints.set(h, list);
  }
  // Walks away from a node, through joints, until the chain stops. `closed` means it came round to a seg already walked.
  const walkAway = (seg, from, seen) => {
    const steps = [];
    let at = from;
    let s = seg;
    for (;;) {
      seen.add(s);
      steps.push({ seg: s, along: s.a === at });
      at = s.a === at ? s.b : s.a;
      if (!joints.has(at)) return { steps, closed: false };
      s = joints.get(at).find((x) => x !== s);
      if (seen.has(s)) return { steps, closed: true };
    }
  };
  const chains = [];
  const placed = new Set();
  const reversed = (list) => list.slice().reverse().map((m) => ({ ...m, along: !m.along }));
  for (const [h, [left, right]] of joints) {
    if (placed.has(left)) continue;
    const seen = new Set();
    const back = walkAway(left, h, seen);
    const ahead = back.closed ? back : walkAway(right, h, seen);
    for (const s of seen) placed.add(s);
    if (back.closed || ahead.closed) continue;
    const walk = [...reversed(back.steps), ...ahead.steps];
    chains.push(walk[0].seg.oneway && !walk[0].along ? reversed(walk) : walk);
  }
  return chains.map((walk) => {
    const v = baseSeg(walk, G);
    keepEndHeadings(v);
    return v;
  });
}

/**
 * An overlay must not change what turns a junction allows, and the heading of an edge is read over `HEADING_SPAN_DM` of it. So
 * the outer ends of a chain keep the heading of the whole chain, however short the piece left at that end. The headings are
 * in the member's own `a` to `b` direction, as `arcHeading` gives them.
 */
function keepEndHeadings(v) {
  const first = v.members[0];
  const last = v.members[v.members.length - 1];
  for (const span of [HEADING_SPAN_DM, HEADING_SPAN_LONG_DM]) {
    const key = span === HEADING_SPAN_DM ? '' : 'Long';
    const leaving = arcHeading(v.pts, v.cum, false, span);
    const arriving = arcHeading(v.pts, v.cum, true, span);
    if (first.along) first.e[`headA${key}`] = leaving;
    else first.e[`headB${key}`] = wrapPi(leaving + Math.PI);
    if (last.along) last.e[`headB${key}`] = arriving;
    else last.e[`headA${key}`] = wrapPi(arriving + Math.PI);
  }
}

/** One finished seg over a walked chain of edges, on base tags, in the direction contraction would have left it. */
function baseSeg(walk, G) {
  const ids = [];
  const parts = [];
  for (const { seg, along } of walk) {
    ids.push(...(along ? seg.ids : seg.ids.slice().reverse()).slice(ids.length ? 1 : 0));
    const list = seg.parts.map((p) => ({ ...p, tags: p.base, rev: along ? p.rev : !p.rev }));
    parts.push(...(along ? list : list.reverse()));
  }
  const firstPart = parts[0];
  const v = {
    a: ids[0],
    b: ids[ids.length - 1],
    ids,
    oneway: walk[0].seg.oneway,
    len: walk.reduce((sum, m) => sum + m.seg.len, 0),
    parts,
    sub: 0,
    subW: 1
  };
  finishSeg(v, G.nodes);
  const flipped = v.parts[0] !== firstPart;
  v.ja = G.juncOf.get(G.clusterOf.get(v.a));
  v.jb = G.juncOf.get(G.clusterOf.get(v.b));
  let s = 0;
  v.members = (flipped ? walk.slice().reverse() : walk).map(({ seg, along }) => {
    const m = { e: seg, along: flipped ? !along : along, s };
    s += seg.lenDm;
    return m;
  });
  return v;
}

/**
 * Orders the edges of each way in travel order, chaining `b` to `a`. Pieces cut by a junction cluster still chain through
 * the cluster, so the walk compares clusters, not raw nodes. `arms` arrives sorted by position along the way, which decides
 * two things a chain cannot: the order of pieces that do not touch, such as both sides of a pass 6 cut, and where a closed
 * way begins. `TLV.anchors` walks the same chains over rows, so the two agree.
 */
function sortAlongWay(arms, G) {
  const out = [];
  let i = 0;
  while (i < arms.length) {
    let j = i;
    while (j < arms.length && arms[j].way === arms[i].way) j++;
    const group = arms.slice(i, j);
    i = j;
    if (group.length === 1) {
      out.push(group[0]);
      continue;
    }
    const starts = new Map();
    const ends = new Set();
    for (const s of group) {
      const a = G.clusterOf.get(s.a);
      if (!starts.has(a)) starts.set(a, []);
      starts.get(a).push(s);
      ends.add(G.clusterOf.get(s.b));
    }
    const placed = new Set();
    const walk = (s0) => {
      let s = s0;
      while (s && !placed.has(s)) {
        placed.add(s);
        out.push(s);
        const nexts = starts.get(G.clusterOf.get(s.b)) || [];
        s = nexts.find((n) => !placed.has(n));
      }
    };
    for (const s of group) if (!ends.has(G.clusterOf.get(s.a))) walk(s);
    for (const s of group) walk(s);
  }
  return out;
}

/** Wraps an angle to (-pi, pi]. */
function wrapPi(a) {
  let r = a;
  while (r > Math.PI) r -= 2 * Math.PI;
  while (r <= -Math.PI) r += 2 * Math.PI;
  return r;
}

/** Heading over the last stretch into, or first stretch out of, a directed edge. One short segment at the end is noise. */
function arcHeading(pts, cum, fromEnd, wanted = HEADING_SPAN_DM) {
  const n = cum.length;
  const total = cum[n - 1];
  const span = Math.min(wanted, total);
  if (fromEnd) {
    let i = n - 2;
    while (i > 0 && total - cum[i] < span) i--;
    return Math.atan2(pts[2 * n - 1] - pts[2 * i + 1], pts[2 * n - 2] - pts[2 * i]);
  }
  let i = 1;
  while (i < n - 1 && cum[i] < span) i++;
  return Math.atan2(pts[2 * i + 1] - pts[1], pts[2 * i] - pts[0]);
}

/**
 * Heading of a directed edge where it leaves its start junction and where it arrives at its end junction.
 * @param {object} e Edge.
 * @param {number} dir 0 forward, 1 backward.
 * @param {number} [span] `HEADING_SPAN_DM` or `HEADING_SPAN_LONG_DM`.
 * @returns {{out: number, in: number}}
 */
function dirHeadings(e, dir, span = HEADING_SPAN_DM) {
  const flipAngle = (h) => wrapPi(h + Math.PI);
  const long = span === HEADING_SPAN_LONG_DM;
  const headA = long ? e.headALong : e.headA;
  const headB = long ? e.headBLong : e.headB;
  const atA = headA === undefined ? arcHeading(e.pts, e.cum, false, span) : headA;
  const atB = headB === undefined ? arcHeading(e.pts, e.cum, true, span) : headB;
  return dir === 0 ? { out: atA, in: atB } : { out: flipAngle(atB), in: flipAngle(atA) };
}

/** True when a directed edge exists. One-way edges only run forward. */
function hasDir(e, dir) {
  return dir === 0 ? e.lanesF > 0 : e.lanesB > 0;
}

/**
 * Pass 11: legal turns. An arm connects to an exit only if a route exists through the cluster's internal edges, and
 * nothing turns back on itself past 155 degrees, except at a dead end, where the U-turn is mandatory. An arm whose only
 * exit is banned keeps the gentlest one, because a lane with no exit is a trap for the player and for AI.
 * @param {object} G Graph after `finishGraph` and lane normalization.
 * @returns {{moves: Array<{from: number, to: number, turn: number}>, unreachable: number, banned: number, uturns: number}}
 */
export function buildMovements(G) {
  const adj = new Map();
  const push = (a, b) => {
    if (!adj.has(a)) adj.set(a, []);
    adj.get(a).push(b);
  };
  for (const s of G.internal) {
    push(s.a, s.b);
    if (!s.oneway) push(s.b, s.a);
  }
  const inDir = G.juncs.map(() => []);
  const outDir = G.juncs.map(() => []);
  for (const e of G.edges) {
    if (hasDir(e, 0)) {
      outDir[e.ja].push({ de: e.id * 2, e, dir: 0, node: e.a });
      inDir[e.jb].push({ de: e.id * 2, e, dir: 0, node: e.b });
    }
    if (hasDir(e, 1)) {
      outDir[e.jb].push({ de: e.id * 2 + 1, e, dir: 1, node: e.b });
      inDir[e.ja].push({ de: e.id * 2 + 1, e, dir: 1, node: e.a });
    }
  }
  const reachFrom = (start) => {
    const seen = new Set([start]);
    const stack = [start];
    while (stack.length) {
      for (const v of adj.get(stack.pop()) || []) {
        if (!seen.has(v)) {
          seen.add(v);
          stack.push(v);
        }
      }
    }
    return seen;
  };
  const moves = [];
  let unreachable = 0;
  let banned = 0;
  let uturns = 0;
  G.juncs.forEach((j, ji) => {
    for (const a of inDir[ji]) {
      const reach = reachFrom(a.node);
      const legal = [];
      const fallback = [];
      const hIn = dirHeadings(a.e, a.dir).in;
      for (const b of outDir[ji]) {
        if (!reach.has(b.node)) {
          unreachable++;
          continue;
        }
        const d = wrapPi(dirHeadings(b.e, b.dir).out - hIn);
        const entry = { from: a.de, to: b.de, d };
        // A bend just before the junction hides a U-turn from the short span, as on Ibn Gabirol at junction 2583.
        const far = wrapPi(dirHeadings(b.e, b.dir, HEADING_SPAN_LONG_DM).out - dirHeadings(a.e, a.dir, HEADING_SPAN_LONG_DM).in);
        if (b.e === a.e || Math.max(Math.abs(d), Math.abs(far)) > UTURN_BAN_RAD) fallback.push(entry);
        else legal.push(entry);
      }
      banned += fallback.length;
      if (!legal.length && fallback.length) {
        fallback.sort((p, q) => Math.abs(p.d) - Math.abs(q.d) || p.to - q.to);
        const pick = fallback[0];
        pick.u = (pick.from ^ 1) === pick.to || Math.abs(pick.d) > UTURN_BAN_RAD;
        legal.push(pick);
        if (pick.u) uturns++;
      }
      for (const m of legal) {
        let turn = TURN.STRAIGHT;
        if (m.u) turn = TURN.UTURN;
        else if (m.d > STRAIGHT_RAD) turn = TURN.LEFT;
        else if (m.d < -STRAIGHT_RAD) turn = TURN.RIGHT;
        moves.push({ from: m.from, to: m.to, turn });
      }
    }
  });
  moves.sort((p, q) => p.from - q.from || p.to - q.to);
  G.moves = moves;
  return { moves, unreachable, banned, uturns };
}

/**
 * Pass 12b: which junctions own a traffic light. A cluster with three or more arms takes any light within 35 m. A
 * pass-through light within 35 m by road of such a cluster is that same light and stays `PASS`, because a second
 * controller a few metres away would run an unrelated offset. Any other pass-through light is a real mid-block light.
 * @param {object} G Graph after `finishGraph`.
 * @returns {{clusters: number, midBlock: number, absorbed: number, total: number}}
 */
export function attachSignals(G) {
  const sig = G.signalNodes.map((id) => G.nodes.get(id));
  const grid = new Grid(SIGNAL_CLUSTER_M * 10);
  for (const n of sig) grid.addBox(n.x, n.y, n.x, n.y, n);
  const near = (x, y, r) => {
    const d = r * 10;
    return grid.query(x - d, y - d, x + d, y + d).filter((n) => Math.hypot(n.x - x, n.y - y) <= d);
  };
  let clusters = 0;
  const signalHubs = new Set();
  const wide = new Uint8Array(G.juncs.length);
  for (const e of G.edges) {
    if (NARROW_CLASSES.has(baseClass(e.tags.highway))) continue;
    wide[e.ja] = 1;
    wide[e.jb] = 1;
  }
  G.juncs.forEach((j, ji) => {
    if (j.arms < 3 || j.portal) return;
    const reach = wide[ji] ? SIGNAL_CLUSTER_M : SIGNAL_NARROW_M;
    if (j.members.some((id) => near(G.nodes.get(id).x, G.nodes.get(id).y, reach).length > 0)) {
      j.kind = KIND.SIGNAL;
      clusters++;
      for (const id of j.members) signalHubs.add(id);
    }
  });

  // Dijkstra over hubs, bounded at 35 m, from each pass-through light.
  const neighbours = (id) => {
    const out = [];
    for (const s of G.inc.get(id) || []) {
      if (s.dead) continue;
      out.push([s.a === id ? s.b : s.a, s.lenDm === undefined ? s.len : s.lenDm]);
    }
    return out;
  };
  const byRoad = (start) => {
    const dist = new Map([[start, 0]]);
    const queue = [start];
    while (queue.length) {
      queue.sort((a, b) => dist.get(a) - dist.get(b) || a - b);
      const u = queue.shift();
      if (signalHubs.has(u)) return true;
      for (const [v, len] of neighbours(u)) {
        const d = dist.get(u) + len;
        if (d <= SIGNAL_CLUSTER_M * 10 && (!dist.has(v) || d < dist.get(v))) {
          dist.set(v, d);
          queue.push(v);
        }
      }
    }
    return false;
  };

  const passOf = new Map();
  for (const j of G.juncs) if (j.kind === KIND.PASS) passOf.set(j.members[0], j);
  let midBlock = 0;
  let absorbed = 0;
  const claimed = [];
  const free = (x, y) => !claimed.some((c) => Math.hypot(c.x - x, c.y - y) <= SIGNAL_NODE_M * 10);
  for (const id of G.signalNodes) {
    const j = passOf.get(id);
    if (!j) continue;
    if (byRoad(id)) {
      absorbed++;
      continue;
    }
    j.kind = KIND.SIGNAL;
    claimed.push(G.nodes.get(id));
    midBlock++;
  }
  // A light whose own node was contracted away still has a neighbouring pass-through node inside 6 m.
  for (const [id, j] of [...passOf].sort((a, b) => a[0] - b[0])) {
    if (j.kind !== KIND.PASS) continue;
    const n = G.nodes.get(id);
    if (near(n.x, n.y, SIGNAL_NODE_M).length && free(n.x, n.y) && !byRoad(id)) {
      j.kind = KIND.SIGNAL;
      claimed.push(n);
      midBlock++;
    }
  }
  return { clusters, midBlock, absorbed, total: clusters + midBlock };
}

/**
 * Pass 14: strongly connected components of the directed-edge turn graph, iterative Tarjan. Node-level connectivity
 * would overstate reachability, because a car moves through turns, not through intersections.
 * @param {object} G Graph with `moves`.
 * @returns {{laneKm: number, sccLaneKm: number, share: number, components: number}}
 */
export function connectivity(G) {
  const n = G.edges.length * 2;
  const head = new Int32Array(n).fill(-1);
  const next = new Int32Array(G.moves.length);
  const to = new Int32Array(G.moves.length);
  G.moves.forEach((m, i) => {
    to[i] = m.to;
    next[i] = head[m.from];
    head[m.from] = i;
  });
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const comp = new Int32Array(n).fill(-1);
  const onStack = new Uint8Array(n);
  const stack = [];
  const call = [];
  const ptr = new Int32Array(n);
  let counter = 0;
  let comps = 0;
  const exists = (de) => {
    const e = G.edges[de >> 1];
    return hasDir(e, de & 1);
  };
  for (let root = 0; root < n; root++) {
    if (index[root] >= 0 || !exists(root)) continue;
    call.push(root);
    while (call.length) {
      const v = call[call.length - 1];
      if (index[v] < 0) {
        index[v] = counter;
        low[v] = counter;
        counter++;
        stack.push(v);
        onStack[v] = 1;
        ptr[v] = head[v];
      }
      if (ptr[v] >= 0) {
        const w = to[ptr[v]];
        ptr[v] = next[ptr[v]];
        if (index[w] < 0) call.push(w);
        else if (onStack[w]) low[v] = Math.min(low[v], index[w]);
      } else {
        call.pop();
        if (call.length) {
          const u = call[call.length - 1];
          low[u] = Math.min(low[u], low[v]);
        }
        if (low[v] === index[v]) {
          let w;
          do {
            w = stack.pop();
            onStack[w] = 0;
            comp[w] = comps;
          } while (w !== v);
          comps++;
        }
      }
    }
  }
  const km = new Float64Array(comps);
  let total = 0;
  for (let de = 0; de < n; de++) {
    if (comp[de] < 0) continue;
    const e = G.edges[de >> 1];
    const k = ((de & 1 ? e.lanesB : e.lanesF) * e.lenDm) / 10000;
    km[comp[de]] += k;
    total += k;
  }
  let best = 0;
  for (let c = 1; c < comps; c++) if (km[c] > km[best]) best = c;
  // A lone directed edge is a component of one with no way out, which is a trap, not a network.
  if (!G.moves.some((m) => comp[m.from] === best && comp[m.to] === best)) return { laneKm: total, sccLaneKm: 0, share: 0, components: comps };
  for (const e of G.edges) {
    if (hasDir(e, 0) && comp[e.id * 2] === best) e.flags |= EF.AI_F;
    if (hasDir(e, 1) && comp[e.id * 2 + 1] === best) e.flags |= EF.AI_B;
  }
  return { laneKm: total, sccLaneKm: km[best], share: total > 0 ? km[best] / total : 0, components: comps };
}
