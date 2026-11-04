// tools/lib/land.mjs — WP-MAP
// Pass 19: land polygons, the closed sea, pedestrian paths, parking lots, real trees, and solid walls.

import {
  bboxOf, clipLine, clipRing, cumulative, joinRings, laneOffsets, nearestOnSeg, namesOf, offsetPolyline, orientRing, polyLength,
  ringArea, segHitT, simplifyLine, simplifyRing, sortedById
} from './osm.mjs';
import { kerbOffsets } from './section.mjs';

export const LAND = { SEA: 0, BEACH: 1, PARK: 2, GARDEN: 3, WATER: 4, CONSTRUCTION: 5, SAND: 6, PITCH: 7, PLAZA: 8 };
export const WALL = { BOUNDS: 0, MOTORWAY_FENCE: 1 };

const LAND_SIMPLIFY_DM = 8;
const SEA_SIMPLIFY_DM = 10;
const LOT_SIMPLIFY_DM = 8;
const PATH_SIMPLIFY_DM = 8;
const MIN_LAND_DM2 = 2000;
const MIN_LOT_DM2 = 2000;
const MIN_PATH_DM = 150;
const LOT_ENTRANCE_DM = 400;
const LOT_ROAD_DM = 1500;
const FENCE_CLEARANCE_M = 3;
const FENCE_MIN_SIN = 0.3;
const FENCE_MIN_PIECE_DM = 30;
const FENCE_LANE_MARGIN_DM = 15;
const PROMENADE = /טיילת|promenade/i;

/** Land class of a tagged element, or -1. */
function landClass(t) {
  if (t.natural === 'beach') return LAND.BEACH;
  if (t.natural === 'sand') return LAND.SAND;
  if (t.natural === 'water' || t.waterway === 'riverbank') return LAND.WATER;
  if (t.landuse === 'construction') return LAND.CONSTRUCTION;
  if (t.leisure === 'pitch' || t.leisure === 'track') return LAND.PITCH;
  if (t.leisure === 'park' || t.leisure === 'dog_park' || t.landuse === 'recreation_ground' ||
    t.natural === 'wood' || t.natural === 'scrub' || t.natural === 'shrubbery') return LAND.PARK;
  if (t.leisure === 'garden' || t.landuse === 'grass' || t.landuse === 'meadow' || t.landuse === 'flowerbed' ||
    t.landuse === 'village_green') return LAND.GARDEN;
  if ((t.highway === 'pedestrian' && t.area === 'yes') || t.place === 'square') return LAND.PLAZA;
  return -1;
}

/** Position of a boundary point on a clockwise walk of the box starting at its north-west corner. */
function perimeterT(x, y, box) {
  const w = box.maxX - box.minX;
  const h = box.maxY - box.minY;
  if (y === box.maxY) return x - box.minX;
  if (x === box.maxX) return w + (box.maxY - y);
  if (y === box.minY) return w + h + (box.maxX - x);
  if (x === box.minX) return 2 * w + h + (y - box.minY);
  return -1;
}

/** True when a point lies to the right of a directed segment. */
function rightOf(ax, ay, bx, by, px, py) {
  return (bx - ax) * (py - ay) - (by - ay) * (px - ax) < 0;
}

/**
 * True when a point is on the water side of the coast, the right of travel along it. The test uses the nearest coast
 * segment. Where that nearest point is a vertex, both segments count: the right of a left turn is the wide side, so either
 * segment may claim the point, and the right of a right turn is the narrow side, so both must.
 * @param {number[][]} lines Coast chains, flat.
 * @param {number} px Decimetres.
 * @param {number} py Decimetres.
 * @returns {boolean}
 */
function onWaterSide(lines, px, py) {
  let best = null;
  for (const p of lines) {
    for (let i = 2; i < p.length; i += 2) {
      const q = nearestOnSeg(px, py, p[i - 2], p[i - 1], p[i], p[i + 1]);
      if (!best || q.d < best.d) best = { d: q.d, t: q.t, p, i };
    }
  }
  if (!best) return false;
  const { p, i, t } = best;
  const at = t === 0 ? i - 2 : t === 1 ? i : -1;
  if (at < 2 || at + 3 >= p.length) return rightOf(p[i - 2], p[i - 1], p[i], p[i + 1], px, py);
  const [ax, ay, vx, vy, bx, by] = p.slice(at - 2, at + 4);
  const inFirst = rightOf(ax, ay, vx, vy, px, py);
  const inSecond = rightOf(vx, vy, bx, by, px, py);
  const leftTurn = (vx - ax) * (by - vy) - (vy - ay) * (bx - vx) > 0;
  return leftTurn ? inFirst || inSecond : inFirst && inSecond;
}

/**
 * Closes the coastline against the bbox. OSM coastlines keep water on the right, so a clockwise walk of the box from
 * where the coast leaves it, to where the coast next enters, encloses the sea. A box no coast enters is all sea or all land,
 * whichever side of the coast its centre is on.
 * @param {object} osm Extract.
 * @param {object} box Decimetre box.
 * @returns {number[][]} Sea rings.
 */
export function seaRings(osm, box) {
  const ways = sortedById(osm.ways).filter((w) => w.tags && w.tags.natural === 'coastline');
  if (!ways.length) return [];
  const starts = new Map();
  const ends = new Set();
  for (const w of ways) {
    starts.set(w.nodes[0], w);
    ends.add(w.nodes[w.nodes.length - 1]);
  }
  const chains = [];
  const used = new Set();
  const follow = (w0) => {
    const ids = [];
    let w = w0;
    while (w && !used.has(w.id)) {
      used.add(w.id);
      ids.push(...(ids.length ? w.nodes.slice(1) : w.nodes));
      w = starts.get(w.nodes[w.nodes.length - 1]);
    }
    chains.push(ids);
  };
  for (const w of ways) if (!ends.has(w.nodes[0])) follow(w);
  for (const w of ways) if (!used.has(w.id)) follow(w);

  const lines = chains.map((ids) => {
    const flat = [];
    for (const id of ids) {
      const n = osm.nodes.get(id);
      if (n) flat.push(n.x, n.y);
    }
    return flat;
  });
  const pieces = lines.flatMap((flat) => clipLine(flat, box));
  if (!pieces.length) {
    const sea = onWaterSide(lines, (box.minX + box.maxX) / 2, (box.minY + box.maxY) / 2);
    return sea ? [[box.minX, box.maxY, box.maxX, box.maxY, box.maxX, box.minY, box.minX, box.minY]] : [];
  }
  const open = pieces.filter((p) => perimeterT(p[0], p[1], box) >= 0 &&
    perimeterT(p[p.length - 2], p[p.length - 1], box) >= 0);
  const corners = [
    [box.maxX, box.maxY, box.maxX - box.minX],
    [box.maxX, box.minY, box.maxX - box.minX + (box.maxY - box.minY)],
    [box.minX, box.minY, 2 * (box.maxX - box.minX) + (box.maxY - box.minY)],
    [box.minX, box.maxY, 2 * (box.maxX - box.minX + box.maxY - box.minY)]
  ];
  const perimeter = corners[3][2];
  const rings = [];
  const done = new Set();
  for (let first = 0; first < open.length; first++) {
    if (done.has(first)) continue;
    let ring = [];
    let cur = first;
    while (!done.has(cur)) {
      done.add(cur);
      const p = open[cur];
      ring = ring.concat(p);
      const from = perimeterT(p[p.length - 2], p[p.length - 1], box);
      let next = first;
      let bestGap = Infinity;
      open.forEach((q, i) => {
        if (done.has(i) && i !== first) return;
        const t = perimeterT(q[0], q[1], box);
        const gap = (t - from + perimeter) % perimeter;
        if (gap < bestGap) {
          bestGap = gap;
          next = i;
        }
      });
      const walked = corners
        .map(([x, y, t]) => ({ x, y, gap: (t - from + perimeter) % perimeter }))
        .filter((c) => c.gap > 0 && c.gap < bestGap)
        .sort((a, b) => a.gap - b.gap);
      for (const c of walked) ring.push(c.x, c.y);
      cur = next;
    }
    rings.push(ring);
  }
  return rings;
}

/**
 * Land polygons, largest first so a renderer can paint them in row order.
 * @param {object} osm Extract.
 * @param {object} box Decimetre box.
 * @param {object} roads `RoadIndex`, used only to report construction sites that touch a road.
 * @returns {{land: Array<{cls: number, ring: number[]}>, stats: object}}
 */
export function buildLand(osm, box, roads) {
  const land = [];
  const stats = { sea: 0, construction: 0, constructionTouchingRoad: 0 };
  const coords = (ids) => {
    const out = [];
    for (const id of ids) {
      const n = osm.nodes.get(id);
      if (n) out.push(n.x, n.y);
    }
    return out;
  };
  const add = (cls, flat, tol) => {
    const r = clipRing(simplifyRing(flat, tol), box);
    if (r.length < 6) return null;
    const ring = orientRing(simplifyRing(r, tol), true);
    if (ring.length < 6 || Math.abs(ringArea(ring)) < MIN_LAND_DM2) return null;
    land.push({ cls, ring });
    return ring;
  };
  for (const r of seaRings(osm, box)) {
    add(LAND.SEA, r, SEA_SIMPLIFY_DM);
    stats.sea++;
  }
  const addConstruction = (ring) => {
    if (!ring) return;
    stats.construction++;
    const bb = bboxOf(ring);
    const hit = roads.grid.query(bb.minX, bb.minY, bb.maxX, bb.maxY);
    if (hit.length) stats.constructionTouchingRoad++;
  };
  for (const w of sortedById(osm.ways)) {
    if (!w.tags || w.nodes[0] !== w.nodes[w.nodes.length - 1]) continue;
    const cls = landClass(w.tags);
    if (cls < 0) continue;
    const ring = add(cls, coords(w.nodes.slice(0, -1)), LAND_SIMPLIFY_DM);
    if (cls === LAND.CONSTRUCTION) addConstruction(ring);
  }
  for (const r of sortedById(osm.rels)) {
    if (!r.tags) continue;
    const cls = landClass(r.tags);
    if (cls < 0) continue;
    const outer = joinRings(r.members.filter((m) => m.type === 'way' && m.role === 'outer' && osm.ways.has(m.ref))
      .map((m) => osm.ways.get(m.ref).nodes));
    for (const ids of outer.rings) add(cls, coords(ids), LAND_SIMPLIFY_DM);
  }
  land.sort((a, b) => Math.abs(ringArea(b.ring)) - Math.abs(ringArea(a.ring)) || a.cls - b.cls ||
    a.ring[0] - b.ring[0] || a.ring[1] - b.ring[1]);
  return { land, stats };
}

/**
 * Pedestrian ways. Unnamed sidewalk and crossing footways are left out: sidewalks are generated from roads (section 8.5),
 * and the file budget is better spent on places a person can name.
 * @param {object} osm Extract.
 * @param {object} box Decimetre box.
 * @returns {Array<{cls: number, pts: number[], name: string}>}
 */
export function buildPaths(osm, box) {
  const out = [];
  for (const w of sortedById(osm.ways)) {
    const t = w.tags;
    if (!t || t.area === 'yes') continue;
    const label = `${t.name || ''} ${t['name:en'] || ''}`;
    let cls = -1;
    if (t.highway === 'pedestrian' || (['footway', 'path', 'cycleway'].includes(t.highway) && PROMENADE.test(label))) cls = 0;
    else if ((t.highway === 'footway' || t.highway === 'path') && t.name) cls = 1;
    else if (t.highway === 'cycleway' && t.name) cls = 2;
    if (cls < 0) continue;
    const flat = [];
    for (const id of w.nodes) {
      const n = osm.nodes.get(id);
      if (n) flat.push(n.x, n.y);
    }
    const names = namesOf(t);
    for (const piece of clipLine(flat, box)) {
      const pts = simplifyLine(piece, PATH_SIMPLIFY_DM);
      if (polyLength(pts) < MIN_PATH_DM) continue;
      out.push({ cls, pts, name: names.he || names.en });
    }
  }
  return out;
}

/** Real tree nodes. Species comes from free text, so it is matched by genus. */
export function buildTrees(osm, box) {
  const out = [];
  for (const n of sortedById(osm.nodes)) {
    const t = n.tags;
    if (!t || t.natural !== 'tree') continue;
    if (n.x < box.minX || n.x > box.maxX || n.y < box.minY || n.y > box.maxY) continue;
    const label = [t.species, t['species:en'], t.genus, t.taxon].filter(Boolean).join(' ');
    let species = 0;
    if (/ficus|sycomor/i.test(label)) species = 1;
    else if (/palm|washingtonia|phoenix|cocos/i.test(label)) species = 2;
    else if (label) species = 3;
    out.push({ x: n.x, y: n.y, species });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

/**
 * Parking areas. The entrance is a mapped `parking_entrance` when one is close, else the point of the lot nearest a road.
 * @param {object} osm Extract.
 * @param {object} box Decimetre box.
 * @param {object} roads `RoadIndex`.
 * @returns {Array<{kind: number, ring: number[], entX: number, entY: number, name: string}>}
 */
export function buildLots(osm, box, roads) {
  const kinds = { surface: 0, 'multi-storey': 1, underground: 2, street_side: 3, rooftop: 4 };
  const entrances = sortedById(osm.nodes).filter((n) => n.tags && n.tags.amenity === 'parking_entrance');
  const out = [];
  for (const w of sortedById(osm.ways)) {
    const t = w.tags;
    if (!t || t.amenity !== 'parking' || w.nodes[0] !== w.nodes[w.nodes.length - 1]) continue;
    const flat = [];
    for (const id of w.nodes.slice(0, -1)) {
      const n = osm.nodes.get(id);
      if (n) flat.push(n.x, n.y);
    }
    const clipped = clipRing(simplifyRing(flat, LOT_SIMPLIFY_DM), box);
    if (clipped.length < 6) continue;
    const ring = orientRing(simplifyRing(clipped, LOT_SIMPLIFY_DM), true);
    if (ring.length < 6 || Math.abs(ringArea(ring)) < MIN_LOT_DM2) continue;
    const n = ring.length >> 1;
    const nearestOnRing = (x, y) => {
      let best = { d: Infinity, x: ring[0], y: ring[1] };
      for (let i = 0, j = n - 1; i < n; j = i++) {
        const q = nearestOnSeg(x, y, ring[2 * j], ring[2 * j + 1], ring[2 * i], ring[2 * i + 1]);
        if (q.d < best.d) best = q;
      }
      return best;
    };
    let ent = null;
    let entD = LOT_ENTRANCE_DM;
    for (const e of entrances) {
      const q = nearestOnRing(e.x, e.y);
      if (q.d < entD) {
        entD = q.d;
        ent = { x: e.x, y: e.y };
      }
    }
    if (!ent) {
      let best = Infinity;
      for (let i = 0; i < n; i++) {
        const r = roads.near(ring[2 * i], ring[2 * i + 1], LOT_ROAD_DM)[0];
        if (r && r.d < best) {
          best = r.d;
          ent = { x: ring[2 * i], y: ring[2 * i + 1] };
        }
      }
    }
    if (!ent) ent = { x: ring[0], y: ring[1] };
    const names = namesOf(t);
    out.push({ kind: kinds[t.parking] || 0, ring, entX: ent.x, entY: ent.y, name: names.he || names.en });
  }
  return out;
}

/** Removes `[a, b]` intervals from `[0, len]`. */
function remainder(len, cuts) {
  const sorted = cuts.slice().sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const out = [];
  let pos = 0;
  for (const [a, b] of sorted) {
    if (a > pos) out.push([pos, Math.min(a, len)]);
    pos = Math.max(pos, b);
    if (pos >= len) break;
  }
  if (pos < len) out.push([pos, len]);
  return out;
}

/** Sub-polyline between two arc lengths. */
function slice(p, cum, s0, s1) {
  const out = [];
  const at = (s) => {
    let i = 1;
    while (i < cum.length - 1 && cum[i] < s) i++;
    const t = (s - cum[i - 1]) / (cum[i] - cum[i - 1] || 1);
    return [Math.round(p[2 * i - 2] + (p[2 * i] - p[2 * i - 2]) * t), Math.round(p[2 * i - 1] + (p[2 * i + 1] - p[2 * i - 1]) * t)];
  };
  out.push(...at(s0));
  for (let i = 0; i < cum.length; i++) {
    if (cum[i] > s0 && cum[i] < s1) out.push(p[2 * i], p[2 * i + 1]);
  }
  out.push(...at(s1));
  return out;
}

/** Every crossing of polyline `a` by polyline `b`: arc length on `a`, and the sine of the crossing angle. */
function crossingsOf(a, cumA, b) {
  const out = [];
  for (let i = 2; i < a.length; i += 2) {
    const ax = a[i - 2];
    const ay = a[i - 1];
    const bx = a[i];
    const by = a[i + 1];
    const la = Math.hypot(bx - ax, by - ay) || 1;
    for (let k = 2; k < b.length; k += 2) {
      const cx = b[k - 2];
      const cy = b[k - 1];
      const dx = b[k];
      const dy = b[k + 1];
      if (Math.max(cx, dx) < Math.min(ax, bx) || Math.min(cx, dx) > Math.max(ax, bx)) continue;
      if (Math.max(cy, dy) < Math.min(ay, by) || Math.min(cy, dy) > Math.max(ay, by)) continue;
      const t = segHitT(ax, ay, bx, by, cx, cy, dx, dy);
      if (t < 0) continue;
      const lb = Math.hypot(dx - cx, dy - cy) || 1;
      const sin = Math.abs((bx - ax) * (dy - cy) - (by - ay) * (dx - cx)) / (la * lb);
      out.push({ s: cumA[(i >> 1) - 1] + t * la, sin });
    }
  }
  return out;
}

/** Half-gap in a fence for a road, section 6.6, decimetres. */
function fenceGap(e, sin) {
  const k = kerbOffsets(e);
  const outer = Math.max(k.L + e.swL, k.R + e.swR);
  return (outer + FENCE_CLEARANCE_M * 10) / Math.max(FENCE_MIN_SIN, sin);
}

/**
 * Motorway centrelines clipped to the box, with their arc lengths.
 * @param {object} osm Extract.
 * @param {object} box Decimetre box.
 * @returns {Array<{pts: number[], cum: Float64Array, len: number, cuts: number[][]}>}
 */
export function fenceLines(osm, box) {
  const lines = [];
  for (const w of sortedById(osm.ways)) {
    if (!w.tags || w.tags.highway !== 'motorway') continue;
    const flat = [];
    for (const id of w.nodes) {
      const n = osm.nodes.get(id);
      if (n) flat.push(n.x, n.y);
    }
    for (const pts of clipLine(flat, box)) {
      const cum = cumulative(pts);
      lines.push({ pts, cum, len: cum[cum.length - 1], cuts: [] });
    }
  }
  return lines;
}

/** Every line end by position, so a cut can follow the fence past the end of its own way. */
function endsByPosition(lines) {
  const ends = new Map();
  const add = (x, y, line, isEnd) => {
    const k = `${x},${y}`;
    if (!ends.has(k)) ends.set(k, []);
    ends.get(k).push({ line, isEnd });
  };
  for (const line of lines) {
    const n = line.pts.length;
    add(line.pts[0], line.pts[1], line, false);
    add(line.pts[n - 2], line.pts[n - 1], line, true);
  }
  return ends;
}

/**
 * Motorway fences and the bbox perimeter. Motorways are gone by pass 4, so kept roads that bridge them would hit an
 * unbroken wall. Each fence is cut around every crossing, by the road's centreline at full corridor width, then again
 * around anything a lane still touches. OSM splits a motorway into many ways with no regard for what crosses it, so a cut
 * that runs off the end of its way carries on along every way touching that end, including both sides of a fork.
 * @param {object} osm Extract.
 * @param {object} box Decimetre box.
 * @param {object[]} edges Edges with final cross-sections.
 * @param {object} roads `RoadIndex`.
 * @returns {{walls: Array<{kind: number, pts: number[]}>, stats: object, lines: number[][]}} `lines` holds the uncut
 * centrelines, for `verify` to rebuild each gap on its own.
 */
export function buildWalls(osm, box, edges, roads) {
  const { minX, minY, maxX, maxY } = box;
  const walls = [
    { kind: WALL.BOUNDS, pts: [minX, minY, maxX, minY] },
    { kind: WALL.BOUNDS, pts: [maxX, minY, maxX, maxY] },
    { kind: WALL.BOUNDS, pts: [maxX, maxY, minX, maxY] },
    { kind: WALL.BOUNDS, pts: [minX, maxY, minX, minY] }
  ];
  const stats = { fenceKm: 0, fenceCuts: 0, fenceKeptKm: 0, crossedEdges: 0 };
  const crossed = new Set();
  const lines = fenceLines(osm, box);
  const ends = endsByPosition(lines);

  const spill = (line, atEnd, reach, seen) => {
    const n = line.pts.length;
    const at = atEnd ? `${line.pts[n - 2]},${line.pts[n - 1]}` : `${line.pts[0]},${line.pts[1]}`;
    for (const { line: next, isEnd } of ends.get(at)) {
      if (seen.has(next)) continue;
      seen.add(next);
      next.cuts.push(isEnd ? [next.len - reach, next.len] : [0, reach]);
      if (reach > next.len) spill(next, !isEnd, reach - next.len, seen);
    }
  };
  const cut = (line, a, b) => {
    line.cuts.push([a, b]);
    if (a < 0) spill(line, false, -a, new Set([line]));
    if (b > line.len) spill(line, true, b - line.len, new Set([line]));
  };

  for (const line of lines) {
    stats.fenceKm += line.len / 10000;
    const bb = bboxOf(line.pts);
    const pad = 200;
    const candidates = new Set();
    for (const { e } of roads.grid.query(bb.minX - pad, bb.minY - pad, bb.maxX + pad, bb.maxY + pad)) candidates.add(e);
    line.roads = [...candidates].sort((a, b) => a.id - b.id);
    for (const e of line.roads) {
      for (const hit of crossingsOf(line.pts, line.cum, e.pts)) {
        const g = fenceGap(e, hit.sin);
        cut(line, hit.s - g, hit.s + g);
        crossed.add(e.id);
        stats.fenceCuts++;
      }
    }
  }
  for (let round = 0; round < 6; round++) {
    let added = 0;
    for (const line of lines) {
      for (const e of line.roads) {
        for (const off of laneOffsets(e.lanesF, e.lanesB, e.laneW)) {
          for (const miter of [true, false]) {
            const lane = offsetPolyline(e.pts, off, miter);
            for (const hit of crossingsOf(line.pts, line.cum, lane)) {
              if (!remainder(line.len, line.cuts).some(([a, b]) => hit.s >= a && hit.s <= b)) continue;
              const g = (e.laneW / 2 + FENCE_LANE_MARGIN_DM) / Math.max(FENCE_MIN_SIN, hit.sin);
              cut(line, hit.s - g, hit.s + g);
              added++;
            }
          }
        }
      }
    }
    if (!added) break;
  }
  for (const line of lines) {
    for (const [a, b] of remainder(line.len, line.cuts)) {
      if (b - a < FENCE_MIN_PIECE_DM) continue;
      const pts = simplifyLine(slice(line.pts, line.cum, a, b), 3);
      walls.push({ kind: WALL.MOTORWAY_FENCE, pts });
      stats.fenceKeptKm += polyLength(pts) / 10000;
    }
  }
  stats.crossedEdges = crossed.size;
  return { walls, stats, lines: lines.map((l) => l.pts) };
}
