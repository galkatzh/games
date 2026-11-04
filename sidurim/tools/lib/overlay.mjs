// tools/lib/overlay.mjs — WP-MAP
// Passes 3b and 20: hand edits that survive re-import. Pre ops rewrite raw OSM records, so every later pass treats them as
// OSM data. Post ops act on finished POIs and kerbs. Every op must say why it exists.
//
// Op shapes:
//   road.set         { anchor, set: { tag: value | null } }   `tlv:at_grade: yes` makes the way join what it crosses, see pass 6
//   road.add         { points: [[lat, lon] | { osm: 'n123' }, ...], tags: { highway, ... } }
//   road.delete      { anchor }
//   node.set         { anchor, set: { tag: value | null } }
//   building.set     { anchor, set: { tag: value | null, style: 'styleId' } }
//   building.delete  { anchor }
//   building.clip    { anchor, line: [[lat, lon], [lat, lon]] }   drops the footprint to the right of the line, in its direction
//   poi.add          { at: [lat, lon], kind, name: { he, en } }
//   poi.hide         { anchor }
//   poi.rename       { anchor, name: { he, en } }
//   poi.move         { anchor, at: [lat, lon] }
//   kerb.set         { anchor, side: 'left' | 'right' | 'both', range?: [s0, s1], set: { tier?, paint?, zone?, form? } }
// `range` is metres along the edge polyline. A `kerb.set` row is tier 0 `curated` unless `set.tier` says otherwise.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { OSM_NODE, OSM_WAY, OSM_RELATION, nearestOnSeg, pointInRing } from './osm.mjs';
import { buildingRecords } from './section.mjs';

const PRE_OPS = new Set(['road.set', 'road.add', 'road.delete', 'node.set', 'building.set', 'building.delete', 'building.clip']);
const POST_OPS = new Set(['poi.add', 'poi.hide', 'poi.rename', 'poi.move', 'kerb.set']);
const ADDED_WAY_BASE = 9000000000000;
const ADDED_NODE_BASE = 9100000000000;
const ADDED_POI_BASE = 9200000000000;
const CURATED_TIER = 0;
const LANE_TAGS = ['lanes', 'lanes:forward', 'lanes:backward'];

/**
 * Reads every overlay file of an area, in file name order. A malformed op is an error, never a silent skip, because a
 * forgotten edit would otherwise reappear on the next import.
 * @param {string} dir `tools/overlays/<id>`.
 * @returns {{ops: object[], hash: string}}
 */
export function loadOverlays(dir) {
  const ops = [];
  const hash = crypto.createHash('sha256');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  for (const file of files) {
    const list = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (!Array.isArray(list)) throw new Error(`Overlay ${file} must be an array`);
    hash.update(file);
    hash.update(JSON.stringify(list));
    list.forEach((op, i) => {
      if (!PRE_OPS.has(op.op) && !POST_OPS.has(op.op)) throw new Error(`Overlay ${file}[${i}]: unknown op ${op.op}`);
      if (!op.why) throw new Error(`Overlay ${file}[${i}]: every op needs a why`);
      ops.push({ ...op, source: `${file}[${i}]` });
    });
  }
  return { ops, hash: hash.digest('hex').slice(0, 16) };
}

/** Writes tag changes onto a private copy of a record's tags. `null` removes a tag. */
function setTags(rec, set) {
  const tags = { ...(rec.tags || {}) };
  for (const [k, v] of Object.entries(set)) {
    if (v === null) delete tags[k];
    else tags[k] = String(v);
  }
  rec.tags = tags;
}

/** Minimum distance from a point in metres to a raw way's nodes as a polyline. */
function wayDist(w, nodes, x, y) {
  let best = Infinity;
  const px = x * 10;
  const py = y * 10;
  for (let i = 1; i < w.nodes.length; i++) {
    const a = nodes.get(w.nodes[i - 1]);
    const b = nodes.get(w.nodes[i]);
    if (a && b) best = Math.min(best, nearestOnSeg(px, py, a.x, a.y, b.x, b.y).d);
  }
  return best / 10;
}

/** Distance from a point to a closed ring boundary, in the units of the ring. */
function ringDist(r, px, py) {
  let best = Infinity;
  const n = r.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    best = Math.min(best, nearestOnSeg(px, py, r[2 * j], r[2 * j + 1], r[2 * i], r[2 * i + 1]).d);
  }
  return best;
}

/**
 * Anchor adapter over raw node or road records (section 12.2), the intermediate structure of pass 3b.
 * @param {object[]} rows Node or way records.
 * @param {object} osm Extract.
 * @param {number[]} origin `[lat0, lon0]`.
 * @returns {object}
 */
function rawIndex(rows, osm, origin) {
  return {
    n: rows.length,
    origin,
    osm: (i) => rows[i].id,
    osmT: (i) => (rows[i].type === 'node' ? OSM_NODE : OSM_WAY),
    names: (i) => {
      const t = rows[i].tags || {};
      return [t.name, t['name:he'], t['name:en']];
    },
    dist: (i, x, y) => {
      const r = rows[i];
      return r.type === 'node' ? Math.hypot(r.x / 10 - x, r.y / 10 - y) : wayDist(r, osm.nodes, x, y);
    }
  };
}

/**
 * Anchor adapter over the raw records that become footprints. A relation is measured on its joined outer rings, less its
 * holes, so a renumbered multi-outer building still binds by name or by a point in any of its parts. Like the World
 * adapter, a point inside a footprint is at distance 0.
 * @param {Array<{rec: object, outer: number[][], inner: number[][]}>} rows From `footprintRows`.
 * @param {object} osm Extract.
 * @param {number[]} origin `[lat0, lon0]`.
 * @returns {object}
 */
function footprintIndex(rows, osm, origin) {
  const flat = (ids) => {
    const out = [];
    for (const id of ids) {
      const n = osm.nodes.get(id);
      if (n) out.push(n.x, n.y);
    }
    return out;
  };
  const memo = new Map();
  const ringsOf = (i) => {
    if (!memo.has(i)) memo.set(i, { outer: rows[i].outer.map(flat), inner: rows[i].inner.map(flat) });
    return memo.get(i);
  };
  const inside = (i, x, y) => {
    const { outer, inner } = ringsOf(i);
    const px = x * 10;
    const py = y * 10;
    return outer.some((r) => pointInRing(px, py, r)) && !inner.some((r) => pointInRing(px, py, r));
  };
  return {
    n: rows.length,
    origin,
    osm: (i) => rows[i].rec.id,
    osmT: (i) => (rows[i].rec.type === 'relation' ? OSM_RELATION : OSM_WAY),
    names: (i) => {
      const t = rows[i].rec.tags || {};
      return [t.name, t['name:he'], t['name:en']];
    },
    dist: (i, x, y) => {
      if (inside(i, x, y)) return 0;
      return Math.min(...ringsOf(i).outer.map((r) => ringDist(r, x * 10, y * 10))) / 10;
    },
    inside
  };
}

/** Every record a `building.*` anchor can bind to, with its rings as node id lists. */
function footprintRows(osm) {
  const { rels, ways } = buildingRecords(osm);
  return [
    ...ways.map((w) => ({ rec: w, outer: [w.nodes.slice(0, -1)], inner: [] })),
    ...rels.filter((x) => x.outer.rings.length).map((x) => ({ rec: x.r, outer: x.outer.rings, inner: x.inner.rings }))
  ];
}

/** Records an anchor that did not resolve, or that resolved only loosely. */
function note(orphans, op, how) {
  orphans.push({ op: op.op, source: op.source, how, anchor: op.anchor || null, why: op.why });
}

/**
 * Pass 3b. Applied to raw records, before pass 4, so contraction compares the overlaid tags and pass 6 sees an added road.
 * @param {object[]} ops All overlay ops.
 * @param {object} osm Extract with projected nodes.
 * @param {object} ctx `{ anchors, proj, origin }`.
 * @returns {object[]} Orphan entries.
 */
export function applyPre(ops, osm, ctx) {
  const orphans = [];
  const roads = () => [...osm.ways.values()].filter((w) => w.tags && w.tags.highway);
  const pre = ops.filter((op) => PRE_OPS.has(op.op));
  osm.lanesByOverlay = new Set();
  let addedWays = 0;
  let addedNodes = 0;
  for (const op of pre) {
    if (op.op === 'road.add') {
      const ids = (op.points || []).map((p) => {
        if (Array.isArray(p)) {
          const id = ADDED_NODE_BASE + addedNodes++;
          osm.nodes.set(id, { type: 'node', id, lat: p[0], lon: p[1], x: ctx.proj.x(p[1]), y: ctx.proj.y(p[0]) });
          return id;
        }
        const ref = ctx.anchors.parseOsm(p.osm);
        if (!ref || !osm.nodes.has(ref.id)) throw new Error(`Overlay ${op.source}: unknown node ${p.osm}`);
        return ref.id;
      });
      if (ids.length < 2 || !op.tags || !op.tags.highway) throw new Error(`Overlay ${op.source}: road.add needs points and tags`);
      const id = ADDED_WAY_BASE + addedWays++;
      osm.ways.set(id, { type: 'way', id, nodes: ids, tags: { ...op.tags } });
      if (LANE_TAGS.some((k) => k in op.tags)) osm.lanesByOverlay.add(id);
      continue;
    }
    if (op.op === 'building.clip' && !(Array.isArray(op.line) && op.line.length === 2)) throw new Error(`Overlay ${op.source}: building.clip needs a line`);
    let target;
    let type;
    let hit;
    if (op.op.startsWith('building.')) {
      type = 'building';
      const rows = footprintRows(osm);
      hit = ctx.anchors.resolve(null, op.anchor, { type, index: footprintIndex(rows, osm, ctx.origin) });
      target = hit.how === 'orphan' ? null : rows[hit.id].rec;
    } else {
      const rows = op.op === 'node.set' ? [...osm.nodes.values()] : roads();
      type = op.op === 'node.set' ? 'poi' : 'edge';
      hit = ctx.anchors.resolve(null, op.anchor, { type, index: rawIndex(rows, osm, ctx.origin) });
      target = hit.how === 'orphan' ? null : rows[hit.id];
    }
    if (hit.how !== 'exact') note(orphans, op, hit.how);
    if (hit.how === 'orphan') continue;
    if (op.op === 'road.set') {
      // Pass 7 and 13 need the way as OSM has it, so a neighbour split off by this op keeps the road it was part of.
      target.baseTags = target.baseTags || target.tags;
      setTags(target, op.set || {});
      if (LANE_TAGS.some((k) => k in (op.set || {}))) osm.lanesByOverlay.add(target.id);
    } else if (op.op === 'node.set') {
      setTags(target, op.set || {});
    } else if (op.op === 'road.delete') {
      setTags(target, { highway: null });
    } else if (op.op === 'building.delete') {
      setTags(target, { building: null });
      // A member way that is a building in its own right would come back once the relation stops claiming it.
      for (const m of target.members || []) {
        if (m.role === 'outer' && osm.ways.has(m.ref)) setTags(osm.ways.get(m.ref), { building: null });
      }
    } else if (op.op === 'building.clip') {
      const [a, b] = op.line;
      target.clips = [...(target.clips || []), [ctx.proj.x(a[1]), ctx.proj.y(a[0]), ctx.proj.x(b[1]), ctx.proj.y(b[0])]];
    } else {
      const { style, ...rest } = op.set || {};
      setTags(target, style === undefined ? rest : { ...rest, 'tlv:style': style });
    }
  }
  return orphans;
}

/** Anchor adapter over collected POI records. */
function poiIndex(pois, origin) {
  return {
    n: pois.length,
    origin,
    osm: (i) => pois[i].osm,
    osmT: (i) => pois[i].osmT,
    names: (i) => [pois[i].nameHe, pois[i].nameEn],
    dist: (i, x, y) => Math.hypot(pois[i].x / 10 - x, pois[i].y / 10 - y)
  };
}

/** Anchor adapter over finished edges. */
function edgeIndex(edges, origin) {
  return {
    n: edges.length,
    origin,
    osm: (i) => edges[i].way,
    osmT: () => OSM_WAY,
    names: (i) => [edges[i].name, edges[i].nameEn],
    dist: (i, x, y) => {
      const p = edges[i].pts;
      let best = Infinity;
      for (let k = 2; k < p.length; k += 2) {
        best = Math.min(best, nearestOnSeg(x * 10, y * 10, p[k - 2], p[k - 1], p[k], p[k + 1]).d);
      }
      return best / 10;
    },
    order: (ids) => ids.slice().sort((a, b) => a - b)
  };
}

/**
 * Pass 20, POI half. Runs on collected POIs before facades bind, so an added or moved POI gets a real wall. Hiding a
 * sensitive POI leaves its guard point: a hidden sign must not open the site to errands or contests.
 * @param {object[]} ops All overlay ops.
 * @param {object[]} pois POI records, edited in place.
 * @param {object} ctx `{ anchors, proj, origin }`.
 * @returns {object[]} Orphan entries.
 */
export function applyPois(ops, pois, ctx) {
  const orphans = [];
  let added = 0;
  for (const op of ops) {
    if (!op.op.startsWith('poi.')) continue;
    if (op.op === 'poi.add') {
      const name = op.name || {};
      pois.push({
        osm: ADDED_POI_BASE + added++,
        osmT: OSM_NODE,
        x: ctx.proj.x(op.at[1]),
        y: ctx.proj.y(op.at[0]),
        kind: op.kind,
        nameHe: name.he || '',
        nameEn: name.en || '',
        streets: [],
        sensitive: false,
        guard: false
      });
      continue;
    }
    const hit = ctx.anchors.resolve(null, op.anchor, { type: 'poi', index: poiIndex(pois, ctx.origin) });
    if (hit.how !== 'exact') note(orphans, op, hit.how);
    if (hit.how === 'orphan') continue;
    const p = pois[hit.id];
    if (op.op === 'poi.hide') {
      if (p.sensitive) {
        p.guard = true;
        p.nameHe = '';
        p.nameEn = '';
      } else {
        pois.splice(hit.id, 1);
      }
    } else if (op.op === 'poi.rename') {
      p.nameHe = (op.name && op.name.he) || p.nameHe;
      p.nameEn = (op.name && op.name.en) || p.nameEn;
    } else if (op.op === 'poi.move') {
      p.x = ctx.proj.x(op.at[1]);
      p.y = ctx.proj.y(op.at[0]);
      p.moved = true;
    }
  }
  return orphans;
}

/** Rewrites one stretch of an edge side, splitting the rows it overlaps. */
function paintRange(rows, side, s0, s1, set) {
  const out = [];
  for (const k of rows) {
    if (k.side !== side || k.s1 <= s0 || k.s0 >= s1) {
      out.push(k);
      continue;
    }
    if (k.s0 < s0) out.push({ ...k, s1: s0 });
    out.push({ ...k, s0: Math.max(k.s0, s0), s1: Math.min(k.s1, s1), tier: CURATED_TIER, ...set });
    if (k.s1 > s1) out.push({ ...k, s0: s1 });
  }
  return out;
}

/** Every edge row labelled with a way. */
function rowsOfWay(edges, way) {
  return edges.filter((e) => e.way === way).map((e) => e.id);
}

/**
 * Pass 20, kerb half. A curated row outranks every derived tier.
 * @param {object[]} ops All overlay ops.
 * @param {object[]} kerbs Kerb rows.
 * @param {object[]} edges Edges.
 * @param {object} ctx `{ anchors, origin }`.
 * @returns {{kerbs: object[], orphans: object[]}}
 */
export function applyKerbs(ops, kerbs, edges, ctx) {
  const orphans = [];
  let rows = kerbs;
  for (const op of ops) {
    if (op.op !== 'kerb.set') continue;
    const hit = ctx.anchors.resolve(null, op.anchor, { type: 'edge', index: edgeIndex(edges, ctx.origin) });
    if (hit.how !== 'exact') note(orphans, op, hit.how);
    if (hit.how === 'orphan') continue;
    const sides = op.side === 'left' ? [0] : op.side === 'right' ? [1] : [0, 1];
    // `moved` returns every row of that name near the point, and a street name spans many ways. The op binds one way, whole,
    // so a renumbered way gets the same rows as the original.
    const ids = hit.how === 'moved' ? rowsOfWay(edges, edges[hit.id].way) : hit.ids;
    for (const id of ids) {
      const mine = rows.filter((k) => k.edge === id);
      const rest = rows.filter((k) => k.edge !== id);
      const len = Math.round(edges[id].lenDm);
      const s0 = op.range ? Math.round(op.range[0] * 10) : 0;
      const s1 = op.range ? Math.round(op.range[1] * 10) : len;
      let next = mine;
      for (const side of sides) next = paintRange(next, side, s0, s1, op.set || {});
      rows = rest.concat(next);
    }
  }
  rows.sort((a, b) => a.edge - b.edge || a.side - b.side || a.s0 - b.s0);
  return { kerbs: rows, orphans };
}
