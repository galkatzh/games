// tools/lib/osm.mjs — WP-MAP
// Passes 1, 2 and 3: load, dedupe, project. Also the geometry the other importer passes share, because the file list in
// ARCHITECTURE section 2 is closed and has no separate helper module.
//
// Units: importer geometry is integer decimetres, like the map columns. Lengths handed to rules are metres.

import fs from 'node:fs';
import path from 'node:path';

export const M_PER_DEG_LON = 94415;
export const M_PER_DEG_LAT = 110888;
export const OSM_NODE = 0;
export const OSM_WAY = 1;
export const OSM_RELATION = 2;

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';
// Overpass answers 406 to a client that gives no name. This names the project, and nothing about whoever runs it.
const USER_AGENT = 'sidurim-map-import/1.0';

/**
 * The Overpass query behind every extract. `out body` then `out skel` emits each tagged node twice, once untagged, which
 * is why pass 2 exists.
 * @param {number[]} bbox `[south, west, north, east]`.
 * @returns {string}
 */
export function overpassQuery(bbox) {
  const b = bbox.join(',');
  const keys = ['highway', 'building', 'amenity', 'shop', 'tourism', 'office', 'leisure', 'landuse', 'natural',
    'waterway', 'man_made', 'public_transport', 'barrier'];
  const body = keys.map((k) => `  nwr["${k}"](${b});`).join('\n');
  return `[out:json][timeout:300];\n(\n${body}\n);\nout body;\n>;\nout skel qt;\n`;
}

/**
 * Downloads a source extract. This is the only network step in the importer, and only `--fetch` reaches it.
 * @param {string} cacheDir `tools/cache`.
 * @param {string} source Extract name.
 * @param {number[]} bbox `[south, west, north, east]`.
 * @returns {Promise<string>} Path written.
 */
export async function fetchExtract(cacheDir, source, bbox) {
  const res = await fetch(OVERPASS_URL, { method: 'POST', headers: { 'User-Agent': USER_AGENT }, body: `data=${encodeURIComponent(overpassQuery(bbox))}` });
  if (!res.ok) throw new Error(`Overpass answered ${res.status} for ${source}`);
  const text = await res.text();
  JSON.parse(text);
  const file = path.join(cacheDir, `${source}.osm.json`);
  fs.writeFileSync(file, text);
  return file;
}

/** Keeps the copy that carries tags. A later untagged duplicate must never win. */
function keepTagged(map, e, stats) {
  const prev = map.get(e.id);
  if (!prev) {
    map.set(e.id, e);
    return;
  }
  stats.duplicates++;
  if (e.tags && !prev.tags) map.set(e.id, e);
  else if (prev.tags && !e.tags) stats.taggedKept++;
}

/**
 * Passes 1 and 2: merges extracts and removes duplicates by OSM id.
 * @param {string} cacheDir `tools/cache`.
 * @param {string[]} sources Extract names.
 * @returns {{nodes: Map, ways: Map, rels: Map, osmTime: string, stats: object}}
 */
export function loadSources(cacheDir, sources) {
  const nodes = new Map();
  const ways = new Map();
  const rels = new Map();
  const stats = { elements: 0, duplicates: 0, taggedKept: 0 };
  let osmTime = '';
  for (const source of sources) {
    const raw = JSON.parse(fs.readFileSync(path.join(cacheDir, `${source}.osm.json`), 'utf8'));
    const time = raw.osm3s && raw.osm3s.timestamp_osm_base;
    if (time && time > osmTime) osmTime = time;
    for (const e of raw.elements) {
      stats.elements++;
      if (e.type === 'node') keepTagged(nodes, e, stats);
      else if (e.type === 'way') keepTagged(ways, e, stats);
      else if (e.type === 'relation') keepTagged(rels, e, stats);
    }
  }
  stats.nodes = nodes.size;
  stats.ways = ways.size;
  stats.relations = rels.size;
  return { nodes, ways, rels, osmTime, stats };
}

/**
 * Builds the section 1.1 projection for a city origin.
 * @param {number[]} origin `[lat0, lon0]`.
 * @returns {{x: function(number): number, y: function(number): number, lat: function(number): number,
 *   lon: function(number): number}} Decimetre projection and its inverse.
 */
export function makeProjection(origin) {
  const [lat0, lon0] = origin;
  return {
    x: (lon) => Math.round((lon - lon0) * M_PER_DEG_LON * 10),
    y: (lat) => Math.round((lat - lat0) * M_PER_DEG_LAT * 10),
    lon: (x) => x / 10 / M_PER_DEG_LON + lon0,
    lat: (y) => y / 10 / M_PER_DEG_LAT + lat0
  };
}

/**
 * Pass 3: writes integer decimetre `x`, `y` onto each node.
 * @param {Map} nodes Node records.
 * @param {object} proj From `makeProjection`.
 */
export function projectNodes(nodes, proj) {
  for (const n of nodes.values()) {
    n.x = proj.x(n.lon);
    n.y = proj.y(n.lat);
  }
}

/**
 * Bounding box in integer decimetres.
 * @param {number[]} bbox `[south, west, north, east]`.
 * @param {object} proj From `makeProjection`.
 * @returns {{minX: number, minY: number, maxX: number, maxY: number}}
 */
export function boxOf(bbox, proj) {
  return { minX: proj.x(bbox[1]), minY: proj.y(bbox[0]), maxX: proj.x(bbox[3]), maxY: proj.y(bbox[2]) };
}

/** Way ids in ascending order, so every pass iterates deterministically regardless of source order. */
export function sortedById(map) {
  return [...map.values()].sort((a, b) => a.id - b.id);
}

/** True when a name contains a Hebrew letter. */
export function hasHebrew(s) {
  return /\p{Script=Hebrew}/u.test(s);
}

/** True when a name is written in Latin script, with accents allowed. Arabic or Cyrillic names answer false. */
export function isLatin(s) {
  return /\p{Script=Latin}/u.test(s) && !/[\p{Script=Hebrew}\p{Script=Arabic}\p{Script=Cyrillic}]/u.test(s);
}

/** True when a name uses only printable ASCII, so a digit-only name such as `416` counts as well as a word. */
export function isAscii(s) {
  return /^[\x20-\x7e]+$/.test(s);
}

/** Removes the invisible direction marks and controls OSM names sometimes carry, and collapses spaces. */
export function cleanText(s) {
  if (s === null || s === undefined) return '';
  return String(s).replace(/[\p{Cc}\p{Cf}]/gu, ' ').replace(/\s+/g, ' ').trim();
}

/** Names per ARCHITECTURE section 6.5: `name:he` or a Hebrew `name`; `name:en` or an ASCII or Latin `name`. */
export function namesOf(tags) {
  const name = cleanText(tags.name);
  const he = cleanText(tags['name:he']) || (hasHebrew(name) ? name : '');
  const en = cleanText(tags['name:en']) || (name && !hasHebrew(name) && (isAscii(name) || isLatin(name)) ? name : '');
  return { he, en };
}

// ---------------------------------------------------------------------------------------------------------------------
// Geometry. Polylines and rings are flat `[x0, y0, x1, y1, ...]` arrays. Rings do not repeat their first vertex.
// ---------------------------------------------------------------------------------------------------------------------

/** Uniform grid over integer coordinates. Values are stored once per cell they overlap. */
export class Grid {
  /** @param {number} cell Cell size, same units as the coordinates. */
  constructor(cell) {
    this.cell = cell;
    this.map = new Map();
  }

  /** Hash key of a cell. Coordinates stay far inside 2^20 cells. */
  key(cx, cy) {
    return (cx + 524288) * 1048576 + (cy + 524288);
  }

  /** Adds a value to every cell its box overlaps. */
  addBox(x0, y0, x1, y1, v) {
    const c = this.cell;
    const cx1 = Math.floor(x1 / c);
    const cy1 = Math.floor(y1 / c);
    for (let cx = Math.floor(x0 / c); cx <= cx1; cx++) {
      for (let cy = Math.floor(y0 / c); cy <= cy1; cy++) {
        const k = this.key(cx, cy);
        const list = this.map.get(k);
        if (list) list.push(v);
        else this.map.set(k, [v]);
      }
    }
  }

  /** Adds a value along a segment, stepping so a long diagonal does not fill its whole bounding box. */
  addSeg(ax, ay, bx, by, v) {
    const c = this.cell;
    const steps = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / (c * 0.5)));
    let last = NaN;
    const seen = new Set();
    for (let i = 0; i <= steps; i++) {
      const x = ax + ((bx - ax) * i) / steps;
      const y = ay + ((by - ay) * i) / steps;
      const k = this.key(Math.floor(x / c), Math.floor(y / c));
      if (k === last || seen.has(k)) continue;
      seen.add(k);
      last = k;
      const list = this.map.get(k);
      if (list) list.push(v);
      else this.map.set(k, [v]);
    }
  }

  /**
   * Distinct values whose cells overlap a box, in first-seen order.
   * @returns {Array}
   */
  query(x0, y0, x1, y1) {
    const c = this.cell;
    const seen = new Set();
    const out = [];
    const cx1 = Math.floor(x1 / c);
    const cy1 = Math.floor(y1 / c);
    for (let cx = Math.floor(x0 / c); cx <= cx1; cx++) {
      for (let cy = Math.floor(y0 / c); cy <= cy1; cy++) {
        const list = this.map.get(this.key(cx, cy));
        if (!list) continue;
        for (const v of list) {
          if (!seen.has(v)) {
            seen.add(v);
            out.push(v);
          }
        }
      }
    }
    return out;
  }
}

/** True when segments ab and cd cross at a single interior point of both. Touching does not count. */
export function segCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
  const d2 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
  if ((d1 > 0) === (d2 > 0) || d1 === 0 || d2 === 0) return false;
  const d3 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
  const d4 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
  return (d3 > 0) !== (d4 > 0) && d3 !== 0 && d4 !== 0;
}

/**
 * Parameter along ab where it crosses cd, or -1. Touching counts, which suits collider tests on offset polylines whose
 * vertices are floats.
 * @returns {number} Value in [0, 1], or -1.
 */
export function segHitT(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax;
  const ry = by - ay;
  const sx = dx - cx;
  const sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (den === 0) return -1;
  const qx = cx - ax;
  const qy = cy - ay;
  const t = (qx * sy - qy * sx) / den;
  const u = (qx * ry - qy * rx) / den;
  return t >= 0 && t <= 1 && u >= 0 && u <= 1 ? t : -1;
}

/**
 * Nearest point on a segment.
 * @returns {{d: number, t: number, x: number, y: number}}
 */
export function nearestOnSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  if (t < 0) t = 0;
  else if (t > 1) t = 1;
  const x = ax + t * dx;
  const y = ay + t * dy;
  return { d: Math.hypot(x - px, y - py), t, x, y };
}

/** Length of a flat polyline, in the units of its coordinates. */
export function polyLength(p) {
  let len = 0;
  for (let i = 2; i < p.length; i += 2) len += Math.hypot(p[i] - p[i - 2], p[i + 1] - p[i - 1]);
  return len;
}

/** Cumulative length at each vertex of a flat polyline. */
export function cumulative(p) {
  const cum = new Float64Array(p.length >> 1);
  for (let i = 1; i < cum.length; i++) {
    cum[i] = cum[i - 1] + Math.hypot(p[2 * i] - p[2 * i - 2], p[2 * i + 1] - p[2 * i - 1]);
  }
  return cum;
}

/**
 * Point and heading at arc length `s` on a flat polyline. Clamps `s`.
 * @returns {{x: number, y: number, dx: number, dy: number}} `dx, dy` is the unit tangent.
 */
export function pointAt(p, cum, s) {
  const n = cum.length;
  let i = 1;
  while (i < n - 1 && cum[i] < s) i++;
  const span = cum[i] - cum[i - 1] || 1;
  const t = Math.min(1, Math.max(0, (s - cum[i - 1]) / span));
  const ax = p[2 * i - 2];
  const ay = p[2 * i - 1];
  const bx = p[2 * i];
  const by = p[2 * i + 1];
  const l = Math.hypot(bx - ax, by - ay) || 1;
  return { x: ax + (bx - ax) * t, y: ay + (by - ay) * t, dx: (bx - ax) / l, dy: (by - ay) / l };
}

/**
 * Projects a point on a flat polyline.
 * @returns {{d: number, s: number, x: number, y: number, side: number}} `side` is +1 left of travel, -1 right.
 */
export function projectOnPolyline(px, py, p, cum) {
  let best = { d: Infinity, s: 0, x: 0, y: 0, side: 1 };
  for (let i = 1; i < cum.length; i++) {
    const ax = p[2 * i - 2];
    const ay = p[2 * i - 1];
    const bx = p[2 * i];
    const by = p[2 * i + 1];
    const q = nearestOnSeg(px, py, ax, ay, bx, by);
    if (q.d < best.d) {
      const c = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
      best = { d: q.d, s: cum[i - 1] + q.t * (cum[i] - cum[i - 1]), x: q.x, y: q.y, side: c >= 0 ? 1 : -1 };
    }
  }
  return best;
}

/**
 * Offsets a flat polyline sideways. `miter: true` is the usual join, limited to twice the offset. `miter: false` moves
 * each vertex along the plain averaged normal. Nothing in the contract fixes which join WP-WORLD uses, so collider gates
 * test both and a difference in joins cannot put a lane through a wall.
 * @param {number[]} p Flat polyline.
 * @param {number} offRight Offset to the right of travel, in the units of `p`. Negative is left.
 * @param {boolean} [miter=true] Join type.
 * @returns {number[]}
 */
export function offsetPolyline(p, offRight, miter = true) {
  const n = p.length >> 1;
  const out = new Array(p.length);
  let px = 0;
  let py = 0;
  for (let i = 0; i < n; i++) {
    let nx = 0;
    let ny = 0;
    let ax = 0;
    let ay = 0;
    if (i + 1 < n) {
      const dx = p[2 * i + 2] - p[2 * i];
      const dy = p[2 * i + 3] - p[2 * i + 1];
      const l = Math.hypot(dx, dy);
      if (l > 0) {
        ax = dy / l;
        ay = -dx / l;
      }
    }
    if (i > 0) {
      nx = ax + px;
      ny = ay + py;
      if (i + 1 >= n || (ax === 0 && ay === 0)) {
        nx = px;
        ny = py;
      }
    } else {
      nx = ax;
      ny = ay;
    }
    const nl = Math.hypot(nx, ny);
    let scale = 1;
    if (nl > 1e-9) {
      nx /= nl;
      ny /= nl;
      if (miter && i > 0 && i + 1 < n) {
        const cos = nx * ax + ny * ay;
        scale = cos > 0.5 ? 1 / cos : 2;
      }
    }
    out[2 * i] = p[2 * i] + nx * offRight * scale;
    out[2 * i + 1] = p[2 * i + 1] + ny * offRight * scale;
    if (ax !== 0 || ay !== 0) {
      px = ax;
      py = ay;
    }
  }
  return out;
}

/**
 * Lane offsets to the right of a to b, section 8.1. Backward lanes come out negative. Used by every collider check, so
 * importer gates and WP-WORLD agree on where a lane is.
 * @param {number} lanesF Forward lanes.
 * @param {number} lanesB Backward lanes.
 * @param {number} laneW Lane width.
 * @returns {number[]}
 */
export function laneOffsets(lanesF, lanesB, laneW) {
  const out = [];
  if (lanesB === 0) {
    for (let idx = 0; idx < lanesF; idx++) out.push(((lanesF - 1) / 2 - idx) * laneW);
    return out;
  }
  for (let idx = 0; idx < lanesF; idx++) out.push((lanesF - idx - 0.5) * laneW);
  for (let idx = 0; idx < lanesB; idx++) out.push(-(lanesB - idx - 0.5) * laneW);
  return out;
}

/**
 * Part of a flat polyline between two arc lengths measured from each end.
 * @param {number[]} p Flat polyline.
 * @param {number} fromStart Length to drop at the start.
 * @param {number} fromEnd Length to drop at the end.
 * @returns {number[]}
 */
export function trimLine(p, fromStart, fromEnd) {
  if (fromStart <= 0 && fromEnd <= 0) return p;
  const cum = cumulative(p);
  const n = cum.length;
  const s0 = fromStart;
  const s1 = cum[n - 1] - fromEnd;
  const at = (s) => {
    const q = pointAt(p, cum, s);
    return [q.x, q.y];
  };
  const out = at(s0);
  for (let i = 0; i < n; i++) if (cum[i] > s0 && cum[i] < s1) out.push(p[2 * i], p[2 * i + 1]);
  out.push(...at(s1));
  return out;
}

/**
 * The least any lane is trimmed, so testing colliders on what is left cannot miss a real lane. Section 8.1: a junction that
 * is not `PASS` takes at least 3 m, capped at 45% of the edge, and both trims shrink together to leave a 3 m lane.
 * @param {number} lenDm Edge length.
 * @param {boolean} passA Start junction is `PASS`.
 * @param {boolean} passB End junction is `PASS`.
 * @returns {number[]} `[fromStart, fromEnd]`, decimetres.
 */
export function minTrims(lenDm, passA, passB) {
  const each = Math.min(30, lenDm * 0.45);
  const a = passA ? 0 : each;
  const b = passB ? 0 : each;
  const spare = lenDm - 30;
  const scale = a + b > 0 && lenDm - a - b < 30 ? Math.max(0, spare) / (a + b) : 1;
  return [a * scale, b * scale];
}

/**
 * Keeps the part of a ring to the left of the directed line a to b, one Sutherland-Hodgman step. Meant for trimming the tip
 * of a footprint, so a cut that leaves two pieces of a concave ring joins them along the line.
 * @param {number[]} r Flat ring.
 * @param {number[]} line `[ax, ay, bx, by]`.
 * @returns {number[]} Flat ring, empty when nothing is left.
 */
export function clipRingLeft(r, line) {
  const [ax, ay, bx, by] = line;
  const side = (x, y) => (bx - ax) * (y - ay) - (by - ay) * (x - ax);
  const n = r.length >> 1;
  const out = [];
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const si = side(r[2 * i], r[2 * i + 1]);
    const sj = side(r[2 * j], r[2 * j + 1]);
    if (si >= 0) out.push(r[2 * i], r[2 * i + 1]);
    if ((si > 0 && sj < 0) || (si < 0 && sj > 0)) {
      const t = si / (si - sj);
      out.push(Math.round(r[2 * i] + (r[2 * j] - r[2 * i]) * t), Math.round(r[2 * i + 1] + (r[2 * j + 1] - r[2 * i + 1]) * t));
    }
  }
  return out;
}

/** Signed ring area in the units of its coordinates squared. Positive is counter-clockwise. */
export function ringArea(r) {
  let a = 0;
  const n = r.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) a += r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
  return a / 2;
}

/** Vertex order reversed, keeping the flat layout. */
export function reverseRing(r) {
  const out = new Array(r.length);
  const n = r.length >> 1;
  for (let i = 0; i < n; i++) {
    out[2 * i] = r[2 * (n - 1 - i)];
    out[2 * i + 1] = r[2 * (n - 1 - i) + 1];
  }
  return out;
}

/** Forces a ring to a winding: `ccw` true is counter-clockwise. */
export function orientRing(r, ccw) {
  return (ringArea(r) > 0) === ccw ? r : reverseRing(r);
}

/** Even-odd point test on a ring. */
export function pointInRing(x, y, r) {
  let inside = false;
  const n = r.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const yi = r[2 * i + 1];
    const yj = r[2 * j + 1];
    if ((yi > y) !== (yj > y) && x < ((r[2 * j] - r[2 * i]) * (y - yi)) / (yj - yi) + r[2 * i]) inside = !inside;
  }
  return inside;
}

/** Area-weighted centroid of a ring, falling back to the vertex mean for a degenerate ring. */
export function ringCentroid(r) {
  let a = 0;
  let cx = 0;
  let cy = 0;
  const n = r.length >> 1;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const f = r[2 * j] * r[2 * i + 1] - r[2 * i] * r[2 * j + 1];
    a += f;
    cx += (r[2 * j] + r[2 * i]) * f;
    cy += (r[2 * j + 1] + r[2 * i + 1]) * f;
  }
  if (Math.abs(a) < 1e-6) {
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += r[2 * i];
      sy += r[2 * i + 1];
    }
    return { x: sx / n, y: sy / n };
  }
  return { x: cx / (3 * a), y: cy / (3 * a) };
}

/** Bounding box of a flat array. */
export function bboxOf(p) {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < p.length; i += 2) {
    if (p[i] < minX) minX = p[i];
    if (p[i] > maxX) maxX = p[i];
    if (p[i + 1] < minY) minY = p[i + 1];
    if (p[i + 1] > maxY) maxY = p[i + 1];
  }
  return { minX, minY, maxX, maxY };
}

/** Douglas-Peucker over an open flat polyline. Keeps both ends. */
export function simplifyLine(p, tol) {
  const n = p.length >> 1;
  if (n < 3) return p.slice();
  const keep = new Uint8Array(n);
  keep[0] = 1;
  keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [i0, i1] = stack.pop();
    let best = -1;
    let bestD = tol;
    for (let i = i0 + 1; i < i1; i++) {
      const q = nearestOnSeg(p[2 * i], p[2 * i + 1], p[2 * i0], p[2 * i0 + 1], p[2 * i1], p[2 * i1 + 1]);
      if (q.d > bestD) {
        bestD = q.d;
        best = i;
      }
    }
    if (best >= 0) {
      keep[best] = 1;
      stack.push([i0, best], [best, i1]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    if (keep[i]) out.push(p[2 * i], p[2 * i + 1]);
  }
  return out;
}

/**
 * Removes repeated points, then simplifies a ring. The ring is split at its two farthest vertices so Douglas-Peucker
 * has real anchors. Never returns fewer than three vertices.
 * @param {number[]} r Flat ring.
 * @param {number} tol Tolerance, same units.
 * @returns {number[]}
 */
export function simplifyRing(r, tol) {
  const clean = [];
  const n = r.length >> 1;
  for (let i = 0; i < n; i++) {
    const x = r[2 * i];
    const y = r[2 * i + 1];
    const m = clean.length;
    if (m && clean[m - 2] === x && clean[m - 1] === y) continue;
    clean.push(x, y);
  }
  while (clean.length > 2 && clean[0] === clean[clean.length - 2] && clean[1] === clean[clean.length - 1]) {
    clean.length -= 2;
  }
  const m = clean.length >> 1;
  if (m <= 4) return clean;
  let far = 0;
  let farD = -1;
  for (let i = 1; i < m; i++) {
    const d = Math.hypot(clean[2 * i] - clean[0], clean[2 * i + 1] - clean[1]);
    if (d > farD) {
      farD = d;
      far = i;
    }
  }
  const a = simplifyLine(clean.slice(0, 2 * far + 2), tol);
  const b = simplifyLine(clean.slice(2 * far).concat(clean[0], clean[1]), tol);
  const out = a.concat(b.slice(2, b.length - 2));
  return out.length >= 6 ? out : clean;
}

/**
 * Clips a ring to a box, Sutherland-Hodgman. A concave ring can gain edges along the box side, which is fine for a
 * footprint or a land polygon at the map edge.
 * @param {number[]} r Flat ring.
 * @param {{minX: number, minY: number, maxX: number, maxY: number}} box Clip box.
 * @returns {number[]} Empty if nothing is left.
 */
export function clipRing(r, box) {
  const clipEdge = (input, inside, cross) => {
    const out = [];
    const n = input.length >> 1;
    for (let i = 0; i < n; i++) {
      const ax = input[2 * i];
      const ay = input[2 * i + 1];
      const bx = input[2 * ((i + 1) % n)];
      const by = input[2 * ((i + 1) % n) + 1];
      const ia = inside(ax, ay);
      const ib = inside(bx, by);
      if (ia) out.push(ax, ay);
      if (ia !== ib) {
        const c = cross(ax, ay, bx, by);
        out.push(c[0], c[1]);
      }
    }
    return out;
  };
  const atX = (X) => (ax, ay, bx, by) => [X, Math.round(ay + ((by - ay) * (X - ax)) / (bx - ax))];
  const atY = (Y) => (ax, ay, bx, by) => [Math.round(ax + ((bx - ax) * (Y - ay)) / (by - ay)), Y];
  let out = clipEdge(r, (x) => x >= box.minX, atX(box.minX));
  if (out.length) out = clipEdge(out, (x) => x <= box.maxX, atX(box.maxX));
  if (out.length) out = clipEdge(out, (x, y) => y >= box.minY, atY(box.minY));
  if (out.length) out = clipEdge(out, (x, y) => y <= box.maxY, atY(box.maxY));
  return out;
}

/**
 * Liang-Barsky parameters of a segment inside a box.
 * @returns {number[]|null} `[t0, t1]`, or null when the segment misses the box.
 */
export function clipSegment(ax, ay, bx, by, box) {
  let t0 = 0;
  let t1 = 1;
  const dx = bx - ax;
  const dy = by - ay;
  const tests = [[-dx, ax - box.minX], [dx, box.maxX - ax], [-dy, ay - box.minY], [dy, box.maxY - ay]];
  for (const [p, q] of tests) {
    if (p === 0) {
      if (q < 0) return null;
      continue;
    }
    const r = q / p;
    if (p < 0) {
      if (r > t1) return null;
      if (r > t0) t0 = r;
    } else {
      if (r < t0) return null;
      if (r < t1) t1 = r;
    }
  }
  return [t0, t1];
}

/** Clamps a point onto a box, so a clipped end sits exactly on the boundary. */
export function clampToBox(x, y, box) {
  return [
    Math.max(box.minX, Math.min(box.maxX, Math.round(x))),
    Math.max(box.minY, Math.min(box.maxY, Math.round(y)))
  ];
}

/**
 * Clips an open polyline to a box.
 * @param {number[]} p Flat polyline.
 * @param {object} box Clip box.
 * @returns {number[][]} One flat polyline per stretch inside the box.
 */
export function clipLine(p, box) {
  const out = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.length >= 4) out.push(cur);
    cur = null;
  };
  const inside = (x, y) => x >= box.minX && x <= box.maxX && y >= box.minY && y <= box.maxY;
  for (let i = 2; i < p.length; i += 2) {
    const ax = p[i - 2];
    const ay = p[i - 1];
    const bx = p[i];
    const by = p[i + 1];
    const ia = inside(ax, ay);
    const ib = inside(bx, by);
    if (ia && ib) {
      if (!cur) cur = [ax, ay];
      cur.push(bx, by);
      continue;
    }
    const c = clipSegment(ax, ay, bx, by, box);
    if (!c) {
      flush();
      continue;
    }
    const p0 = clampToBox(ax + (bx - ax) * c[0], ay + (by - ay) * c[0], box);
    const p1 = clampToBox(ax + (bx - ax) * c[1], ay + (by - ay) * c[1], box);
    if (ia) {
      if (!cur) cur = [ax, ay];
      cur.push(p1[0], p1[1]);
      flush();
    } else if (ib) {
      flush();
      cur = [p0[0], p0[1], bx, by];
    } else {
      flush();
      if (p0[0] !== p1[0] || p0[1] !== p1[1]) {
        cur = [p0[0], p0[1], p1[0], p1[1]];
        flush();
      }
    }
  }
  flush();
  return out;
}

/**
 * Joins member ways end to end into closed rings. Used for building relations and land multipolygons.
 * @param {number[][]} lists Node id lists, one per member way.
 * @returns {{rings: number[][], open: number}} Closed node id rings, first id not repeated, and the chains left open.
 */
export function joinRings(lists) {
  const rest = lists.filter((l) => l.length >= 2).map((l) => l.slice());
  const rings = [];
  let open = 0;
  while (rest.length) {
    const chain = rest.shift();
    let grew = true;
    while (grew && chain[0] !== chain[chain.length - 1]) {
      grew = false;
      for (let i = 0; i < rest.length; i++) {
        const l = rest[i];
        const tail = chain[chain.length - 1];
        const head = chain[0];
        if (l[0] === tail) chain.push(...l.slice(1));
        else if (l[l.length - 1] === tail) chain.push(...l.slice(0, -1).reverse());
        else if (l[l.length - 1] === head) chain.unshift(...l.slice(0, -1));
        else if (l[0] === head) chain.unshift(...l.slice(1).reverse());
        else continue;
        rest.splice(i, 1);
        grew = true;
        break;
      }
    }
    if (chain[0] === chain[chain.length - 1]) rings.push(chain.slice(0, -1));
    else open++;
  }
  return { rings, open };
}

/**
 * Outer and inner rings of a relation, joined from its member ways.
 * @param {object} r Relation record.
 * @param {Map} ways Way records.
 * @returns {{outer: {rings: number[][], open: number}, inner: {rings: number[][], open: number}}} From `joinRings`.
 */
export function relationRings(r, ways) {
  const joined = (role) => joinRings(r.members
    .filter((m) => m.type === 'way' && m.role === role && ways.has(m.ref))
    .map((m) => ways.get(m.ref).nodes));
  return { outer: joined('outer'), inner: joined('inner') };
}
