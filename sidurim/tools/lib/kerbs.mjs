// tools/lib/kerbs.mjs — WP-MAP
// Pass 16 (kerb rows, tier and paint) and pass 17 (crossings and bus stops projected to road edges). Pass 17's results feed
// the kerb buffers, so the importer runs the projection first.

import { cleanText } from './osm.mjs';
import { EF, JF, KIND } from './graph.mjs';

const CROSSING_SNAP_DM = 150;
const CROSSING_DEDUPE_DM = 20;
const STOP_RANGE_DM = 300;
const STOP_SERVICE_PENALTY_DM = 150;
const STOP_WRONG_SIDE_PENALTY_DM = 60;
const STOP_NO_AI_PENALTY_DM = 100;
const SIDE_LEFT = 0;
const SIDE_RIGHT = 1;

/** Zone value with the parser guard: `6sidewalk=both` exists in the data and must read as zone 6. */
export function parseZone(v) {
  if (v === undefined || v === null) return '';
  const m = /^\s*(\d+)/.exec(String(v));
  return m ? m[1] : cleanText(v).replace(/[^\p{L}\p{N}]+.*$/u, '');
}

/**
 * Kerb facts of one way part on one edge side (section 6.4). Side is relative to the edge, tags to the way, so a reversed
 * part swaps them.
 * @param {object} part Way part of an edge.
 * @param {number} side 0 left, 1 right.
 * @param {object} rules `parking.json`.
 * @returns {{tier: number, zone: string, form: number, no: boolean}}
 */
export function partKerb(part, side, rules) {
  const t = part.tags;
  const osmSide = (side === SIDE_LEFT) === !part.rev ? 'left' : 'right';
  const value = t[`parking:${osmSide}`] !== undefined ? t[`parking:${osmSide}`] : t['parking:both'];
  const orientation = t[`parking:${osmSide}:orientation`] || t['parking:both:orientation'];
  const form = rules.forms[orientation] || 0;
  let rawZone = t[`parking:${osmSide}:zone`];
  if (rawZone === undefined) rawZone = t['parking:both:zone'];
  if (rawZone === undefined) {
    for (const k of rules.zoneFallbackKeys) if (rawZone === undefined) rawZone = t[k];
  }
  const zone = parseZone(rawZone);
  const hasZone = rawZone !== undefined;
  const no = rules.explicitNo.includes(value);
  const none = rules.tiers.none;
  const blocked = t.highway.endsWith('_link') || t.bridge === 'yes' || t.tunnel === 'yes' ||
    t.junction === 'roundabout' || t.junction === 'circular';
  let tier = none;
  if (!blocked && !no) {
    if (rules.explicitYes.includes(value)) tier = rules.tiers.explicit;
    else if (hasZone) tier = rules.tiers.zone;
    else if (rules.inferred.both.includes(t.highway)) tier = rules.tiers.inferred;
    else if (side === SIDE_RIGHT && rules.inferred.right.includes(t.highway)) tier = rules.tiers.inferred;
  }
  return { tier, zone: hasZone ? zone : '', form, no, hasZone };
}

/**
 * True when any stretch of an edge side has a tier that allows parking, which is what earns the default strip.
 * @param {object} e Edge.
 * @param {number} side 0 left, 1 right.
 * @param {object} rules `parking.json`.
 * @returns {boolean}
 */
export function allowsParking(e, side, rules) {
  return e.parts.some((p) => partKerb(p, side, rules).tier !== rules.tiers.none);
}

/**
 * Pass 17, crossings. A crossing is a node on a kept road, so its position along an edge is known exactly. Nodes on a
 * dropped internal edge snap to the nearest arm.
 * @param {object} osm Extract.
 * @param {object} G Graph.
 * @param {object} roads `RoadIndex`.
 * @param {object} box Decimetre box.
 * @returns {{xings: object[], stats: object}}
 */
export function projectCrossings(osm, G, roads, box) {
  const onEdge = new Map();
  for (const e of G.edges) {
    let s = 0;
    for (let i = 0; i < e.ids.length; i++) {
      const id = e.ids[i];
      if (i > 0) {
        const a = osm.nodes.get(e.ids[i - 1]);
        const b = osm.nodes.get(id);
        s += Math.hypot(a.x - b.x, a.y - b.y);
      }
      const n = osm.nodes.get(id);
      if (!n.tags || n.tags.highway !== 'crossing' || n.tags.crossing === 'no') continue;
      if (!onEdge.has(id)) onEdge.set(id, []);
      onEdge.get(id).push({ e, s, interior: i > 0 && i < e.ids.length - 1 });
    }
  }
  const rows = [];
  const stats = { onEdge: 0, snapped: 0, dropped: 0 };
  const candidates = [...osm.nodes.values()].filter((n) => n.tags && n.tags.highway === 'crossing' &&
    n.tags.crossing !== 'no' && n.x >= box.minX && n.x <= box.maxX && n.y >= box.minY && n.y <= box.maxY);
  candidates.sort((a, b) => a.id - b.id);
  const kept = new Set();
  for (const s of G.segs) if (!s.dead) for (const id of s.ids) kept.add(id);
  for (const n of candidates) {
    if (!kept.has(n.id)) continue;
    const list = onEdge.get(n.id);
    let at = null;
    if (list) {
      at = list.find((c) => c.interior) || list.slice().sort((p, q) => q.e.lenDm - p.e.lenDm || p.e.id - q.e.id)[0];
      stats.onEdge++;
    } else {
      const near = roads.near(n.x, n.y, CROSSING_SNAP_DM)[0];
      if (!near) {
        stats.dropped++;
        continue;
      }
      at = { e: near.e, s: near.s };
      stats.snapped++;
    }
    const signal = n.tags.crossing === 'traffic_signals' || n.tags['crossing:signals'] === 'yes';
    rows.push({ x: n.x, y: n.y, edge: at.e.id, s: Math.round(Math.min(at.s, at.e.lenDm)), signal });
  }
  rows.sort((a, b) => a.edge - b.edge || a.s - b.s);
  const xings = [];
  for (const r of rows) {
    const last = xings[xings.length - 1];
    if (last && last.edge === r.edge && r.s - last.s < CROSSING_DEDUPE_DM) {
      last.signal = last.signal || r.signal;
      stats.dropped++;
      continue;
    }
    xings.push(r);
  }
  return { xings, stats };
}

/**
 * Pass 17, stops. No stop sits on a road node, so all are projected. The side of the road decides the travel direction,
 * and on a dual carriageway a stop belongs to the carriageway it stands to the right of.
 * @param {object} osm Extract.
 * @param {object} roads `RoadIndex`.
 * @param {object} box Decimetre box.
 * @returns {{stops: object[], unplaced: number}}
 */
export function projectStops(osm, roads, box) {
  const stops = [];
  let unplaced = 0;
  const list = [...osm.nodes.values()].filter((n) => n.tags && n.tags.highway === 'bus_stop' &&
    n.x >= box.minX && n.x <= box.maxX && n.y >= box.minY && n.y <= box.maxY);
  list.sort((a, b) => a.id - b.id);
  for (const n of list) {
    let best = null;
    let bestScore = Infinity;
    for (const q of roads.near(n.x, n.y, STOP_RANGE_DM)) {
      const e = q.e;
      const oneway = e.lanesB === 0;
      let score = q.d;
      if (e.cls === 6) score += STOP_SERVICE_PENALTY_DM;
      if (oneway && q.side > 0) score += STOP_WRONG_SIDE_PENALTY_DM;
      const dir = oneway || q.side < 0 ? 0 : 1;
      if (!(e.flags & (dir === 0 ? EF.AI_F : EF.AI_B))) score += STOP_NO_AI_PENALTY_DM;
      if (score < bestScore) {
        bestScore = score;
        best = { e, s: q.s, dir };
      }
    }
    if (!best) {
      unplaced++;
      continue;
    }
    stops.push({
      x: n.x,
      y: n.y,
      edge: best.e.id,
      dir: best.dir,
      s: Math.round(best.s),
      name: cleanText(n.tags.name || n.tags['name:he'] || n.tags['name:en'] || '')
    });
  }
  return { stops, unplaced };
}

/** Side of the road a bus stop stands on, relative to its edge. */
function stopSide(st) {
  return st.dir === 0 ? SIDE_RIGHT : SIDE_LEFT;
}

/** The `size` decimetres of a junction end that a kerb buffer covers, as `[a, b, kind]`. */
function junctionSpan(j, atStart, len, buf) {
  if (j.kind === KIND.PASS) return null;
  const isDeadEnd = (j.flags & JF.DEAD_END) && !(j.flags & JF.PORTAL);
  const size = (isDeadEnd ? buf.deadEnd : buf.junction) * 10;
  const kind = isDeadEnd ? 'd' : 'j';
  return atStart ? [0, size, kind] : [len - size, len, kind];
}

/**
 * Kerb buffers that run off the end of their own edge. A `PASS` junction is no junction to a driver, only a place where tags
 * change or a light stands, so the curb beside it does not start afresh. A stop's or crossing's buffer carries on to the next
 * edge, and how a road is cut into edges does not change what is painted beside it.
 * @param {object[]} edges Edges.
 * @param {object[]} juncs Junctions.
 * @param {object[]} xings Crossings.
 * @param {object[]} stops Bus stops.
 * @param {object} buf `buffersM` of `parking.json`.
 * @returns {Map<number, Array<{a: number, b: number, kind: string, side: number|null}>>} By edge id. `side` null means both.
 */
function carriedBuffers(edges, juncs, xings, stops, buf) {
  const at = new Map();
  for (const e of edges) {
    for (const j of [e.ja, e.jb]) {
      if (!at.has(j)) at.set(j, []);
      at.get(j).push(e);
    }
  }
  const out = new Map();
  const carry = (e, leavesAtEnd, reach, kind, side) => {
    const j = leavesAtEnd ? e.jb : e.ja;
    if (reach <= 0 || juncs[j].kind !== KIND.PASS) return;
    const next = at.get(j).find((n) => n !== e);
    if (!next) return;
    const entersAtStart = next.ja === j;
    const len = Math.round(next.lenDm);
    const sideThere = side === null || leavesAtEnd === entersAtStart ? side : 1 - side;
    if (!out.has(next.id)) out.set(next.id, []);
    out.get(next.id).push({ a: entersAtStart ? 0 : len - reach, b: entersAtStart ? reach : len, kind, side: sideThere });
    carry(next, !entersAtStart, reach - len, kind, sideThere);
  };
  const spill = (e, a, b, kind, side) => {
    carry(e, false, -a, kind, side);
    carry(e, true, b - Math.round(e.lenDm), kind, side);
  };
  const byId = new Map(edges.map((e) => [e.id, e]));
  for (const x of xings) spill(byId.get(x.edge), x.s - buf.crossing * 10, x.s + buf.crossing * 10, 'x', null);
  for (const st of stops) spill(byId.get(st.edge), st.s - buf.stop * 10, st.s + buf.stop * 10, 's', stopSide(st));
  for (const e of edges) {
    const len = Math.round(e.lenDm);
    for (const atStart of [true, false]) {
      const span = junctionSpan(juncs[atStart ? e.ja : e.jb], atStart, len, buf);
      if (span) spill(e, span[0], span[1], span[2], null);
    }
  }
  return out;
}

/** Partition of one edge side, attribute runs merged. */
function sideRows(e, side, juncs, xings, stops, carried, rules) {
  const len = Math.round(e.lenDm);
  const buf = rules.buffersM;
  const spans = [];
  for (const atStart of [true, false]) {
    const span = junctionSpan(juncs[atStart ? e.ja : e.jb], atStart, len, buf);
    if (span) spans.push(span);
  }
  for (const x of xings) spans.push([x.s - buf.crossing * 10, x.s + buf.crossing * 10, 'x']);
  for (const st of stops) if (stopSide(st) === side) spans.push([st.s - buf.stop * 10, st.s + buf.stop * 10, 's']);
  for (const c of carried) if (c.side === null || c.side === side) spans.push([c.a, c.b, c.kind]);
  for (const [a, b] of (side === SIDE_LEFT ? e.pinchL : e.pinchR) || []) spans.push([Math.round(a), Math.round(b), 'p']);

  const cuts = new Set([0, len]);
  for (const p of e.parts) {
    cuts.add(Math.max(0, Math.min(len, Math.round(p.s0))));
    cuts.add(Math.max(0, Math.min(len, Math.round(p.s1))));
  }
  for (const [a, b] of spans) {
    cuts.add(Math.max(0, Math.min(len, a)));
    cuts.add(Math.max(0, Math.min(len, b)));
  }
  const pts = [...cuts].sort((a, b) => a - b);
  const rows = [];
  for (let i = 1; i < pts.length; i++) {
    const u = pts[i - 1];
    const v = pts[i];
    const m = (u + v) / 2;
    const part = e.parts.find((p) => m >= p.s0 && m <= p.s1) || e.parts[e.parts.length - 1];
    const f = partKerb(part, side, rules);
    const inSpan = (kind) => spans.some(([a, b, k]) => k === kind && m >= a && m <= b);
    const j = inSpan('j');
    const st = inSpan('s');
    const tier = j || st || inSpan('d') || inSpan('x') || inSpan('p') ? rules.tiers.none : f.tier;
    let paint = rules.paint.none;
    if (st) paint = rules.paint.red_yellow;
    else if (f.no || j) paint = rules.paint.red_white;
    else if (f.hasZone) paint = rules.paint.blue_white;
    const last = rows[rows.length - 1];
    if (last && last.tier === tier && last.paint === paint && last.zone === f.zone && last.form === f.form) {
      last.s1 = v;
    } else {
      rows.push({ edge: e.id, side, s0: u, s1: v, form: f.form, paint, zone: f.zone, tier });
    }
  }
  return rows;
}

/**
 * Pass 16: every edge side partitioned into kerb rows. Spots later pack only rows with a usable tier, so a row is a
 * statement about the curb, and paint is derived here because OSM has none.
 * @param {object[]} edges Edges.
 * @param {object[]} juncs Junctions.
 * @param {object[]} xings Crossings.
 * @param {object[]} stops Bus stops.
 * @param {object} rules `parking.json`.
 * @returns {object[]} Rows sorted by edge, then side, then `s0`.
 */
export function buildKerbs(edges, juncs, xings, stops, rules) {
  const xBy = new Map();
  const sBy = new Map();
  for (const x of xings) {
    if (!xBy.has(x.edge)) xBy.set(x.edge, []);
    xBy.get(x.edge).push(x);
  }
  for (const st of stops) {
    if (!sBy.has(st.edge)) sBy.set(st.edge, []);
    sBy.get(st.edge).push(st);
  }
  const carried = carriedBuffers(edges, juncs, xings, stops, rules.buffersM);
  const rows = [];
  for (const e of edges) {
    for (const side of [SIDE_LEFT, SIDE_RIGHT]) {
      rows.push(...sideRows(e, side, juncs, xBy.get(e.id) || [], sBy.get(e.id) || [], carried.get(e.id) || [], rules));
    }
  }
  return rows;
}
