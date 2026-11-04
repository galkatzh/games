// tools/lib/section.mjs — WP-MAP
// Pass 9 (normalize lanes and speed), pass 13 (cross-section), pass 15 (building join, `front` per wall).

import {
  Grid, OSM_RELATION, OSM_WAY, bboxOf, clipRing, clipRingLeft, laneOffsets, minTrims, namesOf, nearestOnSeg, offsetPolyline, orientRing,
  pointAt, pointInRing, relationRings, ringArea, ringCentroid, segHitT, simplifyRing, sortedById, trimLine
} from './osm.mjs';
import { EF, KIND, baseClass, replaceJunctions, shapeSeg } from './graph.mjs';
import { allowsParking } from './kerbs.mjs';

const RING_SIMPLIFY_DM = 1.5;
const MIN_FOOTPRINT_DM2 = 100;
const WALL_CELL_DM = 200;
const CORRIDOR_SAMPLE_DM = 30;
const CORRIDOR_END_DM = 60;
const FRONT_RANGE_DM = 350;
const FRONT_MIN_WALL_DM = 30;
const FRONT_MIN_COS = 0.5;
const FRONT_LONG_WALL_DM = 80;
const LANE_MARGIN_DM = 1;

/**
 * How the corridor rule in section 6.3 meets the 50,000 stall gate. Applied literally, to the absolute minimum clearance of
 * an edge, one porch strips a whole block of parking and only 34,800 stalls survive, although 90% of stall positions
 * physically hold a strip. So: the sidewalk answers to what `SIDEWALK_SHARE` of the side offers. The strip goes only when a
 * parked car fits along less than half the side, and a pinch inside a kept strip cuts kerb rows at that spot instead.
 */
const SIDEWALK_SHARE = 0.2;
const STRIP_SHARE = 0.5;

/** A 1.8 m car in a 2.4 m strip leaves 0.6 m to spare, which also covers the error in a mapped building outline. */
const STRIP_SLACK_DM = 6;
const PINCH_MERGE_DM = 65;

/**
 * Carriageways beside each other. OSM draws dual carriageways 4.4 to 7 m apart whatever their width, so the widths of section
 * 6.3 overlap unless something gives. Only neighbours running within `BESIDE_MIN_COS` of parallel count, and only where both
 * have lanes: inside a stop line the junction owns the road, and `TRIM_*` are section 8.1.
 */
const BESIDE_RANGE_DM = 160;
const BESIDE_STEP_DM = 20;
const BESIDE_MIN_COS = 0.7;
const BESIDE_MAX_ALONG = 0.5;
const FORK_DM = 80;
const CLEAR_GAP_DM = 2;
const TRIM_PAD_DM = 15;
const TRIM_MIN_DM = 30;
const TRIM_MAX_DM = 140;
const TRIM_MAX_SHARE = 0.45;

/** How far pass 13 may move a carriageway off its OSM line, and how much of what it finds it must leave clear. */
const SHIFT_MAX_DM = 30;
const SHIFT_MARGIN_DM = 5;
const SHIFT_LOOK_DM = 80;
const SHIFT_ROUNDS = 8;
const SHIFT_VERTEX_GAP_DM = 150;
const SHIFT_VERTEX_END_DM = 80;
const SETTLE_ROUNDS = 12;

/** First integer in a tag value such as `2;3`, or 0. */
function intTag(v) {
  const m = /\d+/.exec(v === undefined ? '' : String(v));
  return m ? Number(m[0]) : 0;
}

/** Number in a value such as `25 m` or `12.5`, or 0. */
function numTag(v) {
  const m = /\d+(\.\d+)?/.exec(v === undefined ? '' : String(v));
  return m ? Number(m[0]) : 0;
}

/**
 * Section 6.2. A two-way `lanes` tag is a total. An explicit forward or backward count wins over it.
 * @param {object} t Tags.
 * @param {boolean} oneway One-way.
 * @param {object} def Class defaults.
 * @param {object} rules `tags.json`.
 * @returns {number[]} `[forward, backward]`.
 */
export function lanesOf(t, oneway, def, rules) {
  const clamp = (n) => Math.max(rules.lanesMin, Math.min(rules.lanesMax, n));
  const total = intTag(t.lanes);
  if (oneway) return [clamp(total || def.oneway), 0];
  const lf = intTag(t['lanes:forward']);
  const lb = intTag(t['lanes:backward']);
  if (lf || lb) {
    const f = lf || (total ? Math.max(1, total - lb) : def.twoway);
    const b = lb || (total ? Math.max(1, total - lf) : def.twoway);
    return [clamp(f), clamp(b)];
  }
  const each = total ? Math.max(1, Math.floor(total / 2)) : def.twoway;
  return [clamp(each), clamp(each)];
}

/**
 * Pass 9: lanes, speed, class and names on every edge. `maxspeed` counts only when it is a plain number.
 * @param {object[]} edges Edges from `finishGraph`.
 * @param {object} rules `tags.json`.
 */
export function normalizeEdges(edges, rules) {
  for (const e of edges) {
    const t = e.tags;
    const base = baseClass(t.highway);
    const def = rules.classes[base];
    e.cls = rules.classOrder.indexOf(base);
    [e.lanesF, e.lanesB] = lanesOf(t, e.oneway, def, rules);
    // What the road has without its overlay. Neighbours measure against this, so a lanes overlay stays on its own way.
    const raw = e.parts.find((p) => p.way === e.way).base;
    const rawDef = rules.classes[baseClass(raw.highway || '')];
    e.plainLanes = raw !== t && rawDef ? lanesOf(raw, e.oneway, rawDef, rules) : [e.lanesF, e.lanesB];
    e.lanesOverlaid = e.plainLanes[0] !== e.lanesF || e.plainLanes[1] !== e.lanesB;
    e.kmh = /^\d+$/.test(t.maxspeed || '') ? Math.min(255, Number(t.maxspeed)) : def.kmh;
    e.laneW = Math.round(def.laneW * 10);
    e.plainW = e.laneW;
    e.parkL = 0;
    e.parkR = 0;
    e.swL = 0;
    e.swR = 0;
    e.flags = (e.ring ? EF.ROUNDABOUT : 0) | (t.bridge === 'yes' ? EF.BRIDGE : 0) |
      (t.highway.endsWith('_link') ? EF.LINK : 0);
    const names = namesOf(t);
    e.nameHe = streetName(names.he);
    e.name = e.nameHe || streetName(cleanName(t.name));
    e.nameEn = streetName(names.en);
  }
}

/** A planning number such as `1285` stands where a street has no name yet. It is not a name, so the HUD must not show it. */
function streetName(s) {
  return /^\d+$/.test(s) ? '' : s;
}

/** A road name that is neither Hebrew nor Latin still belongs in `name`. */
function cleanName(s) {
  return s ? String(s).trim() : '';
}

/** Building kind, section 7.3. An `amenity` tag refines a plain `building=yes`. */
function buildingKind(t, rules) {
  const b = rules.buildings;
  const named = Object.keys(b.kinds).find((k) => b.kinds[k].includes(t.building));
  let kind = named || 'generic';
  if (kind === 'generic') {
    if (t.amenity === 'place_of_worship') kind = 'religious';
    else if (t.amenity === 'school' || t.amenity === 'kindergarten') kind = 'school';
    else if (t.amenity === 'hospital') kind = 'hospital';
  }
  return b.kindOrder.indexOf(kind);
}

/** Roof form, section 7.3. */
function roofForm(t, rules) {
  const shape = t['roof:shape'];
  if (rules.buildings.roofDome.includes(shape)) return 2;
  if (rules.buildings.roofPitched.includes(shape)) return 1;
  return 0;
}

/**
 * The raw records that become footprints, which is also what a `building.*` overlay anchor may bind to. Only
 * `location=underground` removes a building: `layer` is stacking order, not elevation, and a negative value on its own
 * sits on real surface buildings here, among them the 11,194 m2 TLV fashion mall. A relation claims its outer member
 * ways, and a member way tagged as a building is not a second footprint.
 * @param {object} osm Extract.
 * @returns {{rels: object[], ways: object[], underground: number, open: number}} `rels` holds `{ r, outer, inner }`, with
 * `outer.rings` possibly empty. `open` counts ways that never close.
 */
export function buildingRecords(osm) {
  const rels = [];
  const ways = [];
  const claimed = new Set();
  let underground = 0;
  let open = 0;
  const wanted = (t) => {
    if (!t || !t.building || t.building === 'no') return false;
    if (t.location !== 'underground') return true;
    underground++;
    return false;
  };
  for (const r of sortedById(osm.rels)) {
    if (!wanted(r.tags)) continue;
    const { outer, inner } = relationRings(r, osm.ways);
    rels.push({ r, outer, inner });
    if (!outer.rings.length) continue;
    for (const m of r.members) if (m.type === 'way' && m.role === 'outer') claimed.add(m.ref);
  }
  for (const w of sortedById(osm.ways)) {
    if (!wanted(w.tags) || claimed.has(w.id)) continue;
    if (w.nodes[0] === w.nodes[w.nodes.length - 1]) ways.push(w);
    else open++;
  }
  return { rels, ways, underground, open };
}

/**
 * Pass 15, first half, run early because pass 13 needs footprints. Joins relation members into rings, normalizes winding
 * (outer CCW, holes CW), simplifies, and clips to the bbox so no wall lies outside `meta.bounds`.
 * @param {object} osm Extract.
 * @param {object} box Decimetre box.
 * @param {object} rules `tags.json`.
 * @returns {{blds: object[], stats: object}}
 */
export function prepareBuildings(osm, box, rules) {
  const { nodes } = osm;
  const blds = [];
  const records = buildingRecords(osm);
  const stats = {
    relationBuildings: 0,
    relationOpen: 0,
    multiOuter: 0,
    undergroundDropped: records.underground,
    dropped: records.open,
    verticesRaw: 0
  };
  const coords = (ids) => {
    const out = [];
    for (const id of ids) {
      const n = nodes.get(id);
      if (n) out.push(n.x, n.y);
    }
    return out;
  };
  const tidy = (ring, ccw) => {
    let r = simplifyRing(ring, RING_SIMPLIFY_DM);
    const bb = bboxOf(r);
    if (bb.minX < box.minX || bb.maxX > box.maxX || bb.minY < box.minY || bb.maxY > box.maxY) {
      r = simplifyRing(clipRing(r, box), RING_SIMPLIFY_DM);
    }
    if (r.length < 6 || Math.abs(ringArea(r)) < MIN_FOOTPRINT_DM2) return null;
    return orientRing(r, ccw);
  };
  const add = (id, osmT, tags, outer, holes, clips = []) => {
    stats.verticesRaw += outer.length >> 1;
    const r0 = tidy(clips.reduce(clipRingLeft, outer), true);
    if (!r0) {
      stats.dropped++;
      return;
    }
    const rings = [r0];
    for (const h of holes) {
      const r = tidy(h, false);
      if (r && pointInRing(r[0], r[1], r0)) rings.push(r);
    }
    const c = ringCentroid(r0);
    const names = namesOf(tags);
    const levels = Math.min(255, Math.round(numTag(tags['building:levels'])));
    const height = numTag(tags.height);
    const levelM = numTag(tags['building:levels']) * rules.buildings.levelHeightM;
    blds.push({
      osm: id,
      osmT,
      tags,
      rings,
      cx: c.x,
      cy: c.y,
      h: Math.round((height || levelM) * 10),
      levels,
      kind: buildingKind(tags, rules),
      roof: roofForm(tags, rules),
      colour: tags['building:colour'] || '',
      style: tags['tlv:style'] || '',
      glass: tags['building:material'] === 'glass',
      noCollider: false,
      roofOnly: tags.building === 'roof',
      name: names.he || names.en,
      nameEn: names.en,
      front: null
    });
  };
  for (const { r, outer, inner } of records.rels) {
    stats.relationOpen += outer.open;
    if (!outer.rings.length) continue;
    stats.relationBuildings++;
    if (outer.rings.length > 1) stats.multiOuter++;
    const outers = outer.rings.map(coords).sort((a, b) => Math.abs(ringArea(b)) - Math.abs(ringArea(a)));
    const holes = inner.rings.map(coords);
    for (const ring of outers) {
      const own = holes.filter((h) => pointInRing(h[0], h[1], ring));
      add(r.id, OSM_RELATION, r.tags, ring, own, r.clips);
    }
  }
  for (const w of records.ways) add(w.id, OSM_WAY, w.tags, coords(w.nodes.slice(0, -1)), [], w.clips);
  // Spatial order: consecutive rows are neighbours, so the coordinate deltas stay short.
  const cell = (b) => [Math.floor((b.cx + 200000) / 640), Math.floor((b.cy + 200000) / 640)];
  const morton = (b) => {
    let [x, y] = cell(b);
    let m = 0;
    for (let i = 0, f = 1; i < 12; i++, f *= 4) {
      m += ((x & 1) + (y & 1) * 2) * f;
      x >>= 1;
      y >>= 1;
    }
    return m;
  };
  blds.sort((a, b) => morton(a) - morton(b) || a.osmT - b.osmT || a.osm - b.osm || b.rings[0].length - a.rings[0].length);
  blds.forEach((b, i) => {
    b.id = i;
  });
  return { blds, stats };
}

/** Spatial index over building walls and footprints. */
export class BuildingIndex {
  /** @param {object[]} blds Buildings from `prepareBuildings`. */
  constructor(blds) {
    this.blds = blds;
    this.walls = [];
    this.wallGrid = new Grid(WALL_CELL_DM);
    this.boxGrid = new Grid(WALL_CELL_DM * 2);
    for (const b of blds) {
      for (const r of b.rings) {
        const n = r.length >> 1;
        for (let i = 0, j = n - 1; i < n; j = i++) {
          const w = { b: b.id, ax: r[2 * j], ay: r[2 * j + 1], bx: r[2 * i], by: r[2 * i + 1] };
          const idx = this.walls.length;
          this.walls.push(w);
          this.wallGrid.addSeg(w.ax, w.ay, w.bx, w.by, idx);
        }
      }
      const bb = bboxOf(b.rings[0]);
      this.boxGrid.addBox(bb.minX, bb.minY, bb.maxX, bb.maxY, b.id);
    }
  }

  /** Buildings whose footprint holds the point. */
  at(x, y) {
    const out = [];
    for (const id of this.boxGrid.query(x, y, x, y)) {
      const b = this.blds[id];
      if (!pointInRing(x, y, b.rings[0])) continue;
      if (b.rings.slice(1).some((h) => pointInRing(x, y, h))) continue;
      out.push(id);
    }
    return out;
  }

  /** Walls near a box. */
  wallsIn(x0, y0, x1, y1) {
    return this.wallGrid.query(x0, y0, x1, y1).map((i) => this.walls[i]);
  }

  /**
   * Distance from a point along a unit direction to the first wall.
   * @param {Set<number>} [ignore] Buildings to look through.
   * @returns {number} Distance, or `max` when the ray is clear.
   */
  ray(x, y, dx, dy, max, ignore) {
    const ex = x + dx * max;
    const ey = y + dy * max;
    let best = max;
    const x0 = Math.min(x, ex);
    const y0 = Math.min(y, ey);
    for (const w of this.wallsIn(x0, y0, Math.max(x, ex), Math.max(y, ey))) {
      if (ignore && ignore.has(w.b)) continue;
      const t = segHitT(x, y, ex, ey, w.ax, w.ay, w.bx, w.by);
      if (t >= 0 && t * max < best) best = t * max;
    }
    return best;
  }

  /** True when a straight sight line meets any wall of any building. */
  blocked(ax, ay, bx, by) {
    for (const w of this.wallsIn(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by))) {
      if (segHitT(ax, ay, bx, by, w.ax, w.ay, w.bx, w.by) >= 0) return true;
    }
    return false;
  }

  /** Every building a flat polyline crosses or runs inside, added to `out`. */
  hitsOf(p, out) {
    const n = p.length >> 1;
    for (let i = 0; i < n; i++) {
      for (const id of this.at(p[2 * i], p[2 * i + 1])) out.add(id);
      if (i + 1 === n) break;
      const ax = p[2 * i];
      const ay = p[2 * i + 1];
      const bx = p[2 * i + 2];
      const by = p[2 * i + 3];
      for (const id of this.at((ax + bx) / 2, (ay + by) / 2)) out.add(id);
      for (const w of this.wallsIn(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by))) {
        if (!out.has(w.b) && segHitT(ax, ay, bx, by, w.ax, w.ay, w.bx, w.by) >= 0) out.add(w.b);
      }
    }
  }
}

/** Spatial index over edge polylines. */
export class RoadIndex {
  /** @param {object[]} edges Edges with `pts`. */
  constructor(edges) {
    this.edges = edges;
    this.grid = new Grid(WALL_CELL_DM);
    for (const e of edges) {
      const n = e.pts.length >> 1;
      for (let i = 1; i < n; i++) {
        this.grid.addSeg(e.pts[2 * i - 2], e.pts[2 * i - 1], e.pts[2 * i], e.pts[2 * i + 1], { e, i });
      }
    }
  }

  /**
   * Polyline segments within range of a point, nearest first, each with its closest point. Unlike `near` this does not
   * depend on where a road is cut into edges.
   * @param {number} x Decimetres.
   * @param {number} y Decimetres.
   * @param {number} r Range, decimetres.
   * @returns {Array<{e: object, d: number, x: number, y: number}>}
   */
  segmentsNear(x, y, r) {
    const out = [];
    for (const { e, i } of this.grid.query(x - r, y - r, x + r, y + r)) {
      const q = nearestOnSeg(x, y, e.pts[2 * i - 2], e.pts[2 * i - 1], e.pts[2 * i], e.pts[2 * i + 1]);
      if (q.d <= r) out.push({ e, d: q.d, x: q.x, y: q.y });
    }
    return out.sort((p, q) => p.d - q.d || p.e.id - q.e.id);
  }

  /**
   * Edges within range of a point, nearest first, with the closest point on each.
   * @param {number} x Decimetres.
   * @param {number} y Decimetres.
   * @param {number} r Range, decimetres.
   * @returns {Array<{e: object, d: number, x: number, y: number, s: number, side: number}>}
   */
  near(x, y, r) {
    const best = new Map();
    for (const { e, i } of this.grid.query(x - r, y - r, x + r, y + r)) {
      const ax = e.pts[2 * i - 2];
      const ay = e.pts[2 * i - 1];
      const bx = e.pts[2 * i];
      const by = e.pts[2 * i + 1];
      const q = nearestOnSeg(x, y, ax, ay, bx, by);
      if (q.d > r) continue;
      const cur = best.get(e.id);
      if (cur && cur.d <= q.d) continue;
      const c = (bx - ax) * (y - ay) - (by - ay) * (x - ax);
      best.set(e.id, {
        e,
        d: q.d,
        x: q.x,
        y: q.y,
        s: e.cum[i - 1] + q.t * (e.cum[i] - e.cum[i - 1]),
        side: c >= 0 ? 1 : -1
      });
    }
    return [...best.values()].sort((p, q) => p.d - q.d || p.e.id - q.e.id);
  }

  /**
   * The nearest edge at any distance, ties to the lower id. The widening search stops at a first hit, and that hit is
   * checked once more with a cell of margin, because `Grid.addSeg` samples a segment and a query box can just miss it.
   * @param {number} x Decimetres.
   * @param {number} y Decimetres.
   * @returns {object|null} An entry as from `near`, or null on a map with no roads.
   */
  nearest(x, y) {
    if (!this.edges.length) return null;
    for (let r = WALL_CELL_DM * 2; ; r *= 2) {
      const hit = this.near(x, y, r)[0];
      if (hit) return this.near(x, y, hit.d + WALL_CELL_DM)[0];
    }
  }
}

/** Distance from polyline to curb on each side, decimetres, section 6.3. */
export function kerbOffsets(e) {
  if (e.lanesB > 0) return { L: e.lanesB * e.laneW + e.parkL, R: e.lanesF * e.laneW + e.parkR };
  return { L: (e.lanesF * e.laneW) / 2 + e.parkL, R: (e.lanesF * e.laneW) / 2 + e.parkR };
}

/**
 * Open distance on each side of an edge, sampled along it. Corridors stop short of junction ends: a corner building sits
 * in the cross street's corridor, not in this one.
 * @returns {{at: number[], L: number[], R: number[]}} Sample positions and distances, decimetres.
 */
function clearances(e, juncs, index, max, ignore, beside) {
  const endA = juncs[e.ja].kind === KIND.PASS ? 0 : CORRIDOR_END_DM;
  const endB = juncs[e.jb].kind === KIND.PASS ? 0 : CORRIDOR_END_DM;
  let s0 = endA;
  let s1 = e.lenDm - endB;
  if (s1 <= s0) {
    s0 = e.lenDm / 2;
    s1 = s0;
  }
  const out = { at: [], L: [], R: [], nearL: [], nearR: [] };
  const steps = Math.max(1, Math.round((s1 - s0) / CORRIDOR_SAMPLE_DM));
  const span = beside ? laneSpan(e, beside.stops) : [0, 0];
  for (let i = 0; i <= steps; i++) {
    const s = s0 + ((s1 - s0) * i) / steps;
    const p = pointAt(e.pts, e.cum, s);
    let nearL = Infinity;
    let nearR = Infinity;
    if (beside && s >= span[0] && s <= span[1]) {
      p.s = s;
      for (const b of besideAt(e, p, beside)) {
        const room = shareOf(e, b, beside.sane);
        if (b.side > 0) nearL = Math.min(nearL, room);
        else nearR = Math.min(nearR, room);
      }
    }
    out.at.push(s);
    out.nearL.push(nearL);
    out.nearR.push(nearR);
    out.L.push(Math.min(nearL, index.ray(p.x, p.y, -p.dy, p.dx, max, ignore)));
    out.R.push(Math.min(nearR, index.ray(p.x, p.y, p.dy, -p.dx, max, ignore)));
  }
  return out;
}

/** Lane half width of an edge on one side, 1 left, -1 right, at a given lane width. */
function halfOf(e, side, laneW = e.laneW) {
  if (e.lanesB === 0) return (e.lanesF * laneW) / 2;
  return (side > 0 ? e.lanesB : e.lanesF) * laneW;
}

/**
 * The same as a neighbour sees it: as the road comes, before any overlay and before this pass narrowed it. That keeps a
 * neighbour's section out of the order edges are visited in, and a lanes overlay on its own way.
 */
function plainHalf(e, side, laneW = e.plainW) {
  const [f, b] = e.plainLanes || [e.lanesF, e.lanesB];
  if (b === 0) return (f * laneW) / 2;
  return (side > 0 ? b : f) * laneW;
}

/** Where section 8.1 will put the stop line, by junction. The lanes of an edge run between two of these. */
function stopLines(edges, juncs) {
  const widest = new Float64Array(juncs.length);
  for (const e of edges) {
    const w = plainHalf(e, 1) + plainHalf(e, -1) + e.parkL + e.parkR;
    widest[e.ja] = Math.max(widest[e.ja], w);
    widest[e.jb] = Math.max(widest[e.jb], w);
  }
  return juncs.map((j, i) => (j.kind === KIND.PASS ? 0 : Math.max(TRIM_MIN_DM, Math.min(TRIM_MAX_DM, 0.5 * widest[i] + TRIM_PAD_DM))));
}

/** Arc lengths between which an edge has lanes. */
function laneSpan(e, stops) {
  const most = TRIM_MAX_SHARE * e.lenDm;
  return [Math.min(stops[e.ja], most), e.lenDm - Math.min(stops[e.jb], most)];
}

/**
 * Carriageways beside a point of an edge: within `BESIDE_RANGE_DM`, near parallel, abreast of it rather than ahead of it, and
 * with lanes there. Two roads forking from one junction are not beside each other until `FORK_DM` past its stop line, because
 * however they are drawn they must leave from the same spot.
 * @param {object} e Edge.
 * @param {{x: number, y: number, dx: number, dy: number, s: number}} p Point on `e`, from `pointAt`, with its arc length.
 * @param {{roads: RoadIndex, stops: number[]}} ctx Geometry.
 * @returns {Array<{f: object, d: number, side: number, sideF: number, q: object}>} `side` is the side of `e` that `f` is on and
 * `sideF` the side of `f` that faces `e`, 1 left, -1 right.
 */
function besideAt(e, p, ctx) {
  const out = [];
  for (const q of ctx.roads.near(p.x, p.y, BESIDE_RANGE_DM)) {
    const f = q.e;
    if (f === e || (e.members && e.members.some((m) => m.e === f))) continue;
    const [f0, f1] = laneSpan(f, ctx.stops);
    // An end of `f` is nearest: the road carries on past it, or stops, but it does not run alongside.
    if (q.s < f0 || q.s > f1 || q.s < 1 || q.s > f.lenDm - 1) continue;
    if (forking(e, p.s, f, q.s, ctx.stops)) continue;
    const t = pointAt(f.pts, f.cum, q.s);
    if (Math.abs(p.dx * t.dx + p.dy * t.dy) < BESIDE_MIN_COS) continue;
    const vx = p.x - q.x;
    const vy = p.y - q.y;
    if (q.d > 1 && Math.abs(vx * t.dx + vy * t.dy) / q.d > BESIDE_MAX_ALONG) continue;
    const c = p.dx * (q.y - p.y) - p.dy * (q.x - p.x);
    const side = c > 0 || (c === 0 && e.id < f.id) ? 1 : -1;
    out.push({ f, d: q.d, side, sideF: q.side, q });
  }
  return out;
}

/** True when two edges share a junction and either point is still leaving it. */
function forking(e, s, f, t, stops) {
  for (const [j, atE, atF] of [[e.ja, s, t], [e.ja, s, f.lenDm - t], [e.jb, e.lenDm - s, t], [e.jb, e.lenDm - s, f.lenDm - t]]) {
    const onF = atF === t ? f.ja : f.jb;
    if (j === onF && Math.min(atE, atF) < stops[j] + FORK_DM) return true;
  }
  return false;
}

/**
 * The part of the gap to a neighbour that an edge may use. A gap that holds both at their widths is split down the median.
 * One that does not is shared in proportion to what each needs at the narrowest width that is still comfortable.
 */
function shareOf(e, b, sane) {
  const hE = plainHalf(e, b.side);
  const hF = plainHalf(b.f, b.sideF);
  const free = b.d - CLEAR_GAP_DM;
  // A wider overlay may take what its neighbour does not use, and never what it does.
  const own = Math.min(halfOf(e, b.side), free - hF);
  if (free >= hE + hF) return Math.max(own, hE + (free - hE - hF) / 2);
  const sE = plainHalf(e, b.side, Math.min(e.plainW, sane));
  const sF = plainHalf(b.f, b.sideF, Math.min(b.f.plainW, sane));
  return (Math.max(0, free) * sE) / (sE + sF);
}

/** Clearance met by all but the tightest `share` of samples. */
function sustained(list, share) {
  const sorted = list.slice().sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * share))];
}

/** Stretches of a side where a parked car does not fit, merged when no stall fits between them. */
function pinches(samples, at, need) {
  const out = [];
  for (let i = 0; i < samples.length; i++) {
    if (samples[i] >= need) continue;
    const a = at[i] - CORRIDOR_SAMPLE_DM / 2;
    const b = at[i] + CORRIDOR_SAMPLE_DM / 2;
    const last = out[out.length - 1];
    if (last && a - last[1] < PINCH_MERGE_DM) last[1] = b;
    else out.push([a, b]);
  }
  return out;
}

/**
 * Applies the section 6.3 resolution order to one edge, using the clearances described at `SIDEWALK_SHARE`. Lane width and
 * count (steps 3 and 4) answer to the absolute minimum, because a car cannot pass through a pinch the way a sidewalk ribbon
 * can.
 * @param {object} e Edge. Its section fields are rewritten.
 * @param {{at: number[], L: number[], R: number[]}} clear Samples from `clearances`.
 * @param {number} swDefault Default sidewalk, decimetres.
 * @param {object} rules Section limits, in decimetres.
 * @returns {number} Deepest step reached, 0 when the corridor cleared at once.
 */
function resolveCorridor(e, clear, swDefault, rules) {
  const two = e.lanesB > 0;
  const halfL = () => (two ? e.lanesB * e.laneW : (e.lanesF * e.laneW) / 2);
  const halfR = () => (two ? e.lanesF * e.laneW : (e.lanesF * e.laneW) / 2);
  const roomL = sustained(clear.L, SIDEWALK_SHARE);
  const roomR = sustained(clear.R, SIDEWALK_SHARE);
  // A neighbour's lane is exact, with none of the slack a mapped wall gets.
  const stallL = clear.L.map((v, i) => Math.min(v, clear.nearL[i] + STRIP_SLACK_DM));
  const stallR = clear.R.map((v, i) => Math.min(v, clear.nearR[i] + STRIP_SLACK_DM));
  const carL = sustained(stallL, STRIP_SHARE);
  const carR = sustained(stallR, STRIP_SHARE);
  const minL = Math.min(...clear.L);
  const minR = Math.min(...clear.R);
  const laneL = () => halfL() > minL;
  const laneR = () => halfR() > minR;
  let step = 0;
  if (halfL() + e.parkL + e.swL > roomL || halfR() + e.parkR + e.swR > roomR) step = 1;
  if (e.parkL && halfL() + e.parkL - STRIP_SLACK_DM > carL) {
    e.parkL = 0;
    step = 2;
  }
  if (e.parkR && halfR() + e.parkR - STRIP_SLACK_DM > carR) {
    e.parkR = 0;
    step = 2;
  }
  const fitWidth = (limit) => {
    if (!laneL() && !laneR()) return limit;
    const fitL = minL / (two ? e.lanesB : e.lanesF / 2);
    const fitR = minR / (two ? e.lanesF : e.lanesF / 2);
    return Math.max(rules.laneWMin, Math.min(limit, Math.floor(Math.min(fitL, fitR))));
  };
  const defaultW = e.laneW;
  if (laneL() || laneR()) step = 3;
  e.laneW = fitWidth(defaultW);
  if (laneL() || laneR()) step = 4;
  while (laneL() || laneR()) {
    if (two) {
      if (laneR() && e.lanesF > 1) e.lanesF--;
      else if (laneL() && e.lanesB > 1) e.lanesB--;
      else break;
    } else if (e.lanesF > 1) {
      e.lanesF--;
    } else {
      break;
    }
    e.laneW = fitWidth(defaultW);
  }
  if (laneL() || laneR()) {
    step = 5;
    e.flags |= EF.NARROW;
  }
  e.swL = Math.min(swDefault, Math.max(rules.swMin, Math.floor(roomL - halfL() - e.parkL)));
  e.swR = Math.min(swDefault, Math.max(rules.swMin, Math.floor(roomR - halfR() - e.parkR)));
  // A ribbon has no place on a median too thin to hold it: nobody walks down the middle of a dual carriageway.
  if (sustained(clear.nearL, SIDEWALK_SHARE) - halfL() - e.parkL < rules.swMin) e.swL = 0;
  if (sustained(clear.nearR, SIDEWALK_SHARE) - halfR() - e.parkR < rules.swMin) e.swR = 0;
  e.pinchL = e.parkL ? pinches(stallL, clear.at, halfL() + e.parkL - STRIP_SLACK_DM) : [];
  e.pinchR = e.parkR ? pinches(stallR, clear.at, halfR() + e.parkR - STRIP_SLACK_DM) : [];
  return step;
}

/**
 * Lane polylines of an edge in every geometry a collider check must cover: the nominal offset in both join styles, plus a
 * small lateral margin, so float rounding at load cannot turn a near miss into a crossing. The lines stop where the shortest
 * possible lane stops, because the junction ends are connector, not lane.
 */
function laneVariants(e, juncs) {
  const [t0, t1] = minTrims(e.lenDm, juncs[e.ja].kind === KIND.PASS, juncs[e.jb].kind === KIND.PASS);
  const out = [];
  for (const off of laneOffsets(e.lanesF, e.lanesB, e.laneW)) {
    for (const miter of [true, false]) {
      for (const m of [0, LANE_MARGIN_DM, -LANE_MARGIN_DM]) out.push(trimLine(offsetPolyline(e.pts, off + m, miter), t0, t1));
    }
  }
  return out;
}

/** Defaults, then the section 6.3 corridor, for an edge or an overlay chain. */
function sectionOf(e, juncs, index, pierced, cfg, wide, parkingRules, beside) {
  const swDefault = wide.has(e.cls) ? cfg.swWide : cfg.sw;
  e.parkL = allowsParking(e, 0, parkingRules) ? cfg.park : 0;
  e.parkR = allowsParking(e, 1, parkingRules) ? cfg.park : 0;
  e.swL = swDefault;
  e.swR = swDefault;
  const k = kerbOffsets(e);
  const max = Math.max(k.L, k.R) + swDefault + 1;
  return resolveCorridor(e, clearances(e, juncs, index, max, pierced, beside), swDefault, cfg);
}

/** Pinches of a chain that fall on one member, in that member's own arc length. */
function memberPinches(list, m) {
  const len = m.e.lenDm;
  const out = [];
  for (const [a, b] of list) {
    const u = Math.max(a - m.s, 0);
    const v = Math.min(b - m.s, len);
    if (v > u) out.push(m.along ? [u, v] : [len - v, len - u]);
  }
  return m.along ? out : out.reverse();
}

/** Gives a member of an overlay chain the chain's section and names, the ones it had before the overlay split it off. */
function adoptChain(v, m) {
  const { e, along } = m;
  e.laneW = v.laneW;
  e.lanesF = along ? v.lanesF : v.lanesB;
  e.lanesB = along ? v.lanesB : v.lanesF;
  e.parkL = along ? v.parkL : v.parkR;
  e.parkR = along ? v.parkR : v.parkL;
  e.swL = along ? v.swL : v.swR;
  e.swR = along ? v.swR : v.swL;
  e.pinchL = memberPinches(along ? v.pinchL : v.pinchR, m);
  e.pinchR = memberPinches(along ? v.pinchR : v.pinchL, m);
  e.flags = (e.flags & ~EF.NARROW) | (v.flags & EF.NARROW);
  e.name = v.name;
  e.nameHe = v.nameHe;
  e.nameEn = v.nameEn;
}

/**
 * Pass 13. Defaults, then the fixed order in section 6.3. A building the centreline itself enters is settled first: the
 * road wins it at step 6 whatever happens to the widths, and an obstacle with no collider must not strip a whole edge of
 * parking or lanes.
 * @param {object[]} edges Normalized edges.
 * @param {object[]} juncs Junctions.
 * @param {BuildingIndex} index Buildings.
 * @param {object} rules `tags.json`.
 * @param {object} parkingRules `parking.json`.
 * @param {object[]} [chains] From `overlayChains`. A member with no overlay of its own takes the chain's section.
 * @param {Set<number>} [lanesByOverlay] Ways whose lane count an overlay chose, reported if this pass overrides it.
 * @returns {object} Statistics.
 */
export function crossSection(edges, juncs, index, rules, parkingRules, chains = [], lanesByOverlay = new Set()) {
  const sec = rules.section;
  const cfg = {
    park: Math.round(sec.parkingStripM * 10),
    sw: Math.round(sec.sidewalkM * 10),
    swWide: Math.round(sec.sidewalkWideM * 10),
    swMin: Math.round(sec.sidewalkMinM * 10),
    laneWMin: Math.round(sec.laneWMinM * 10)
  };
  const sane = Math.round(sec.laneWSaneM * 10);
  const wide = new Set(sec.sidewalkWideClasses.map((c) => rules.classOrder.indexOf(c)));
  const planned = new Map(edges.map((e) => [e, [e.lanesF, e.lanesB]]));

  // A canopy is not a wall, so nothing measures against it and nothing collides with it.
  const roofs = index.blds.filter((b) => b.roofOnly).map((b) => b.id);
  const pierced = new Set(roofs);
  const piercedWays = new Set();
  const blame = new Map();
  const blameOn = (id, way) => {
    if (!blame.has(id)) blame.set(id, new Set());
    blame.get(id).add(way);
  };
  for (const e of edges) {
    const seen = new Set();
    const [t0, t1] = minTrims(e.lenDm, juncs[e.ja].kind === KIND.PASS, juncs[e.jb].kind === KIND.PASS);
    index.hitsOf(trimLine(e.pts, t0, t1), seen);
    let added = false;
    for (const id of seen) {
      if (index.blds[id].roofOnly) continue;
      blameOn(id, e.way);
      pierced.add(id);
      added = true;
    }
    if (added) piercedWays.add(e.way);
  }

  const beside = { roads: new RoadIndex(edges), stops: stopLines(edges, juncs), sane };
  const steps = [0, 0, 0, 0, 0, 0];
  for (const e of edges) steps[sectionOf(e, juncs, index, pierced, cfg, wide, parkingRules, beside)]++;
  for (const v of chains) {
    normalizeEdges([v], rules);
    sectionOf(v, juncs, index, pierced, cfg, wide, parkingRules, beside);
    for (const m of v.members) if (m.e.parts.every((p) => p.base === p.tags)) adoptChain(v, m);
  }
  const settled = settleNeighbours(edges, juncs, sane, cfg.laneWMin);

  const hit = new Set(pierced);
  const laneOnly = new Set();
  const laneWays = new Set();
  for (const e of edges) {
    const seen = new Set();
    for (const line of laneVariants(e, juncs)) index.hitsOf(line, seen);
    for (const id of seen) {
      if (index.blds[id].roofOnly) continue;
      blameOn(id, e.way);
      if (!hit.has(id)) laneOnly.add(id);
      hit.add(id);
      if (!pierced.has(id)) laneWays.add(e.way);
    }
  }
  for (const id of hit) index.blds[id].noCollider = true;
  for (const [id, ways] of blame) index.blds[id].wonBy = [...ways].sort((a, b) => a - b);
  return {
    resolvedAtStep: steps,
    centrelineWays: piercedWays.size,
    centrelineBuildings: pierced.size - roofs.length,
    laneWays: laneWays.size,
    laneBuildings: laneOnly.size,
    noCollider: hit.size,
    roofs: roofs.length,
    neighbours: settled,
    overlayLanesReduced: overridden(planned, lanesByOverlay)
  };
}

/** Edges whose lanes pass 13 cut although an overlay chose them, which is a sign the overlay did not do what it says. */
function overridden(planned, lanesByOverlay) {
  const out = [];
  for (const [e, [f, b]] of planned) {
    if (!e.parts.some((p) => lanesByOverlay.has(p.way))) continue;
    if (e.lanesF < f || e.lanesB < b) out.push({ way: e.way, edge: e.id, from: [f, b], to: [e.lanesF, e.lanesB] });
  }
  return out;
}

/**
 * Lane overlaps left between neighbours, once per pair of edges.
 * @returns {Array<{e: object, f: object, side: number, sideF: number, over: number}>} Worst sample of each pair, in id order.
 */
function neighbourOverlaps(edges, juncs) {
  const ctx = { roads: new RoadIndex(edges), stops: stopLines(edges, juncs) };
  const worst = new Map();
  for (const e of edges) {
    const [s0, s1] = laneSpan(e, ctx.stops);
    const steps = Math.ceil((s1 - s0) / BESIDE_STEP_DM);
    for (let i = 0; i <= steps; i++) {
      const s = s0 + ((s1 - s0) * i) / Math.max(1, steps);
      const p = { ...pointAt(e.pts, e.cum, s), s };
      for (const b of besideAt(e, p, ctx)) {
        const over = halfOf(e, b.side) + halfOf(b.f, b.sideF) - b.d;
        if (over <= 1) continue;
        const key = Math.min(e.id, b.f.id) * edges.length + Math.max(e.id, b.f.id);
        const cur = worst.get(key);
        if (!cur || over > cur.over) worst.set(key, { e, f: b.f, side: b.side, sideF: b.sideF, over, x: p.x, y: p.y });
      }
    }
  }
  return [...worst.keys()].sort((a, b) => a - b).map((k) => worst.get(k));
}

/**
 * Takes a lane off one side of an edge, or narrows it if that is enough.
 * @returns {boolean} True when something gave.
 */
function giveWay(e, side, over, sane, min) {
  const n = e.lanesB > 0 ? (side > 0 ? e.lanesB : e.lanesF) : e.lanesF / 2;
  for (const floor of [sane, min]) {
    const w = Math.max(floor, Math.floor(e.laneW - over / n));
    if (w >= e.laneW) continue;
    e.laneW = w;
    return true;
  }
  if (e.lanesB > 0 && side > 0 && e.lanesB > 1) e.lanesB--;
  else if (e.lanesB > 0 && side < 0 && e.lanesF > 1) e.lanesF--;
  else if (e.lanesB === 0 && e.lanesF > 1) e.lanesF--;
  else return false;
  return true;
}

/**
 * The last word on neighbours, after buildings have had theirs. The lesser road gives way, then the wider one, first in width and
 * then in lanes. Whatever is left cannot be solved by the cross-section and has to be on the allowlist the gate reads.
 * @returns {{given: number, left: number}}
 */
function settleNeighbours(edges, juncs, sane, min) {
  let given = 0;

  let list = [];
  for (let round = 0; round < SETTLE_ROUNDS; round++) {
    list = neighbourOverlaps(edges, juncs);
    let changed = false;
    for (const { e, f, side, sideF, over } of list) {
      let eFirst = e.cls !== f.cls ? e.cls > f.cls : halfOf(e, side) >= halfOf(f, sideF);
      if (e.lanesOverlaid !== f.lanesOverlaid) eFirst = e.lanesOverlaid;
      const [a, sa, b, sb] = eFirst ? [e, side, f, sideF] : [f, sideF, e, side];
      if (giveWay(a, sa, over + CLEAR_GAP_DM, sane, min) || giveWay(b, sb, over + CLEAR_GAP_DM, sane, min)) {
        changed = true;
        given++;
      }
    }
    if (!changed) break;
  }
  return { given, left: list.length };
}

/**
 * First half of pass 13: spreads carriageways that do not fit side by side, where the ground beside them is free. The lanes of a
 * dual carriageway keep their number this way, and their width stays at the comfortable minimum. Buildings and any third road
 * limit the move, the lesser road moves first, and a vertex moves at most `SHIFT_MAX_DM`, so the map stays where OSM has it.
 * What this cannot solve goes on to `settleNeighbours`, which takes width and then lanes.
 * @param {object} G Graph after `finishGraph` and normalization.
 * @param {object[]} chains Overlay chains, reshaped along with their members.
 * @param {BuildingIndex} index Buildings.
 * @param {object} rules `tags.json`.
 * @returns {{nodes: number, maxM: number}}
 */
export function separateCarriageways(G, chains, index, rules) {
  // An overlay's chain counts as the one road it is without the overlay, so a split does not move anything beside it.
  normalizeEdges(chains, rules);
  chains.forEach((v, i) => {
    v.id = -1 - i;
  });
  const split = new Set(chains.flatMap((v) => v.members.map((m) => m.e)));
  const edges = G.edges.filter((e) => !split.has(e)).concat(chains);
  const sane = Math.round(rules.section.laneWSaneM * 10);
  const roofs = new Set(index.blds.filter((b) => b.roofOnly).map((b) => b.id));
  const shift = new Map();
  const halfSane = (e, side) => plainHalf(e, side, Math.min(e.plainW, sane));
  const fits = (e, p, side, ctx) => {
    const out = side > 0 ? { x: -p.dy, y: p.dx } : { x: p.dy, y: -p.dx };
    const look = halfSane(e, side) + SHIFT_LOOK_DM;
    let room = index.ray(p.x, p.y, out.x, out.y, look, roofs) - halfSane(e, side) - SHIFT_MARGIN_DM;
    for (const b of besideAt(e, p, ctx)) {
      if (b.side === side) room = Math.min(room, b.d - halfSane(e, side) - halfSane(b.f, b.sideF) - CLEAR_GAP_DM);
    }
    return Math.max(0, room);
  };
  const raise = (pushes, id, x, y) => {
    const cur = pushes.get(id);
    if (!cur || Math.hypot(x, y) > Math.hypot(cur.x, cur.y)) pushes.set(id, { x, y });
  };
  const needAt = (e, b) => halfSane(e, b.side) + halfSane(b.f, b.sideF) + CLEAR_GAP_DM - b.d;
  const samples = (e, ctx, visit) => {
    const [s0, s1] = laneSpan(e, ctx.stops);
    const steps = Math.ceil((s1 - s0) / BESIDE_STEP_DM);
    for (let i = 0; i <= steps; i++) {
      const s = s0 + ((s1 - s0) * i) / Math.max(1, steps);
      visit({ ...pointAt(e.pts, e.cum, s), s });
    }
  };
  // A long straight piece has nothing to bend at, and two roads forking along one cannot open up. Give them vertices where they clash.
  const before = { roads: new RoadIndex(edges), stops: stopLines(edges, G.juncs) };
  const allCuts = edges.map((e) => {
    const cuts = [];
    samples(e, before, (p) => {
      if (cuts.length && p.s - cuts[cuts.length - 1].s < SHIFT_VERTEX_GAP_DM) return;
      if (!besideAt(e, p, before).some((b) => needAt(e, b) > 0)) return;
      let k = 1;
      while (k < e.cum.length - 1 && e.cum[k] < p.s) k++;
      if (p.s - e.cum[k - 1] >= SHIFT_VERTEX_END_DM && e.cum[k] - p.s >= SHIFT_VERTEX_END_DM) cuts.push({ s: p.s, x: p.x, y: p.y, k });
    });
    return cuts;
  });
  edges.forEach((e, n) => {
    const cuts = allCuts[n];
    const reached = new Map();
    for (const c of cuts) {
      const id = G.nextNodeId--;
      G.nodes.set(id, { id, x: Math.round(c.x), y: Math.round(c.y) });
      const from = reached.get(c.k) || e.ptIds[c.k - 1];
      const to = e.ptIds[c.k];
      reached.set(c.k, id);
      e.ids.splice(e.ids.lastIndexOf(to), 0, id);
      for (const m of e.members || []) {
        const at = m.e.ids.indexOf(m.along ? to : from);
        if (at > 0 && m.e.ids[at - 1] === (m.along ? from : to)) m.e.ids.splice(at, 0, id);
      }
    }
    if (cuts.length) shapeSeg(e, G.nodes, shift);
  });
  for (let round = 0; round < SHIFT_ROUNDS; round++) {
    const ctx = { roads: new RoadIndex(edges), stops: stopLines(edges, G.juncs) };
    const pushes = new Map();
    for (const e of edges) {
      samples(e, ctx, (p) => {
        const { s } = p;
        for (const b of besideAt(e, p, ctx)) {
          const need = needAt(e, b);
          if (need <= 0) continue;
          const mine = fits(e, p, -b.side, ctx);
          const theirs = fits(b.f, { ...pointAt(b.f.pts, b.f.cum, b.q.s), s: b.q.s }, -b.sideF, ctx);
          let take;
          if (e.cls > b.f.cls) take = Math.min(need, mine);
          else if (e.cls < b.f.cls) take = Math.min(mine, Math.max(0, need - theirs));
          else take = Math.min(mine, Math.max(need / 2, need - theirs));
          if (take <= 0) continue;
          const away = b.side > 0 ? { x: p.dy, y: -p.dx } : { x: -p.dy, y: p.dx };
          let k = 1;
          while (k < e.cum.length - 1 && e.cum[k] < s) k++;
          const along = (s - e.cum[k - 1]) / (e.cum[k] - e.cum[k - 1] || 1);
          if (along < 0.75) raise(pushes, e.ptIds[k - 1], away.x * take, away.y * take);
          if (along > 0.25) raise(pushes, e.ptIds[k], away.x * take, away.y * take);
        }
      });
    }
    let moved = false;
    for (const [id, d] of [...pushes].sort((a, b) => a[0] - b[0])) {
      if (G.nodes.get(id).portal) continue;
      const cur = shift.get(id) || { x: 0, y: 0 };
      const x = cur.x + d.x;
      const y = cur.y + d.y;
      const scale = Math.min(1, SHIFT_MAX_DM / (Math.hypot(x, y) || 1));
      if (Math.hypot(x * scale - cur.x, y * scale - cur.y) < 1) continue;
      shift.set(id, { x: x * scale, y: y * scale });
      moved = true;
    }
    if (!moved) break;
    for (const e of edges) if (e.ptIds.some((id) => pushes.has(id))) shapeSeg(e, G.nodes, shift);
  }
  for (const e of [...split, ...chains]) shapeSeg(e, G.nodes, shift);
  replaceJunctions(G.juncs, G.nodes, shift);
  let max = 0;
  for (const d of shift.values()) max = Math.max(max, Math.hypot(d.x, d.y));
  return { nodes: shift.size, maxM: Number((max / 10).toFixed(1)) };
}

/**
 * Roads a wall looks at: the outward normal faces the road, within 35 m, in clear sight. A long wall is tried at three points,
 * because its middle may be behind a neighbour while the shopfront at one end is on the street. Every segment is tried, not
 * only the closest point of each edge, so what a wall faces does not depend on how the road beside it is cut into edges.
 * @param {object} b Building.
 * @param {number} i Wall index in the outer ring.
 * @param {RoadIndex} roads Roads.
 * @param {BuildingIndex} index Buildings.
 * @returns {Array<object>} Entries from `RoadIndex.near`, nearest first, one per road.
 */
export function facingRoads(b, i, roads, index) {
  const r = b.rings[0];
  const n = r.length >> 1;
  const ax = r[2 * i];
  const ay = r[2 * i + 1];
  const bx = r[2 * ((i + 1) % n)];
  const by = r[2 * ((i + 1) % n) + 1];
  const len = Math.hypot(bx - ax, by - ay);
  if (len < FRONT_MIN_WALL_DM) return [];
  const nx = (by - ay) / len;
  const ny = -(bx - ax) / len;
  const best = new Map();
  for (const t of len >= FRONT_LONG_WALL_DM ? [0.5, 0.2, 0.8] : [0.5]) {
    const mx = ax + (bx - ax) * t;
    const my = ay + (by - ay) * t;
    for (const q of roads.segmentsNear(mx, my, FRONT_RANGE_DM)) {
      const vx = q.x - mx;
      const vy = q.y - my;
      const d = Math.hypot(vx, vy) || 1;
      if ((vx * nx + vy * ny) / d < FRONT_MIN_COS) continue;
      if (best.has(q.e.id) && best.get(q.e.id).d <= q.d) continue;
      if (index.blocked(mx + nx * 3, my + ny * 3, q.x, q.y)) continue;
      best.set(q.e.id, q);
    }
  }
  return [...best.values()].sort((p, q) => p.d - q.d || p.e.cls - q.e.cls || p.e.id - q.e.id);
}

/**
 * Pass 15, second half: `front` on every outer wall, 0 for none, else `cls + 1` of the road faced. Holes stay 0.
 * @param {object[]} blds Buildings.
 * @param {RoadIndex} roads Roads.
 * @param {BuildingIndex} index Buildings.
 * @returns {number} Walls with a front.
 */
export function setFronts(blds, roads, index) {
  let fronts = 0;
  for (const b of blds) {
    const n = b.rings[0].length >> 1;
    b.front = new Uint8Array(n);
    b.facing = new Array(n);
    for (let i = 0; i < n; i++) {
      const list = facingRoads(b, i, roads, index);
      b.facing[i] = list;
      if (list.length) {
        b.front[i] = list[0].e.cls + 1;
        fronts++;
      }
    }
  }
  return fronts;
}
