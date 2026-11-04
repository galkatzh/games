// tools/lib/pois.mjs — WP-MAP
// Pass 18: which POIs exist, and which real wall each name goes on. 84% of POI nodes are inside a footprint, so a node
// position cannot place a sign. The wall is chosen from the street the shop says it is on, then from geometry.

import {
  OSM_NODE, OSM_RELATION, OSM_WAY, joinRings, namesOf, nearestOnSeg, ringArea, ringCentroid, sortedById
} from './osm.mjs';
import { kerbOffsets } from './section.mjs';

const HOST_NEAR_DM = 250;
const MIN_SIGN_M = 3;
const MAX_SIGN_M = 9;
const DOOR_OUT_DM = 5;
const DOOR_STEP_DM = 5;
const STREET_BONUS = 100;
const WALL_LEN_CAP_M = 8;
const WALL_LEN_WEIGHT = 0.5;
const POI_DIST_WEIGHT = 1;
const ROAD_DIST_WEIGHT = 0.25;
const SERVICE_CLASS = 6;

export const POIF = { NAMED: 1, INTERIOR: 2, SENSITIVE: 4, NO_FACADE: 8 };

const STREET_PREFIX = /^(רחוב|רח|שדרות|שד|דרך|כיכר|סמטת|סמטה|street|st|avenue|ave|boulevard|blvd|road|rd)\s+/;
const STREET_SUFFIX = /\s+(street|st|avenue|ave|boulevard|blvd|road|rd)$/;

/**
 * Comparable street name. Without the prefix strip, `רחוב דיזנגוף` would not match the road `דיזנגוף`.
 * @param {string} s Name.
 * @param {function(string): string} normalize `TLV.anchors.normalizeName`.
 * @returns {string}
 */
export function streetKey(s, normalize) {
  return normalize(s).replace(STREET_PREFIX, '').replace(STREET_SUFFIX, '').trim();
}

/** True when an `addr:street` value names this road. */
function streetMatches(keys, e, normalize) {
  if (!keys.length) return false;
  const he = streetKey(e.name, normalize);
  const en = streetKey(e.nameEn, normalize);
  for (const k of keys) {
    if (k === he || k === en) return true;
    if (k.length >= 4 && ((he && (he.includes(k) || k.includes(he))) || (en && (en.includes(k) || k.includes(en))))) {
      return true;
    }
  }
  return false;
}

/** Game kind of an element, or undefined when it is not a POI. A `null` rule means the value is street furniture. */
export function kindOf(tags, rules) {
  for (const key of rules._keys) {
    const raw = tags[key];
    if (raw === undefined) continue;
    const value = String(raw).split(';')[0].trim();
    const exact = rules[`${key}=${value}`];
    if (exact !== undefined) return exact === null ? undefined : exact;
    const wild = rules[`${key}=*`];
    if (wild) return wild;
  }
  return undefined;
}

/** True per the sensitive rule in section 6.5. */
export function isSensitive(tags, rules) {
  const s = rules._sensitive;
  return s.amenity.includes(tags.amenity) || s.building.includes(tags.building);
}

/** Centre of an element: a node position, a way centroid, or the area-weighted centroid of a relation's outer rings. */
function centreOf(e, osm) {
  const coords = (ids) => {
    const out = [];
    for (const id of ids) {
      const n = osm.nodes.get(id);
      if (n) out.push(n.x, n.y);
    }
    return out;
  };
  if (e.type === 'node') return { x: e.x, y: e.y };
  if (e.type === 'way') {
    const closed = e.nodes[0] === e.nodes[e.nodes.length - 1];
    const r = coords(closed ? e.nodes.slice(0, -1) : e.nodes);
    return r.length >= 2 ? ringCentroid(r) : null;
  }
  const outer = joinRings(e.members
    .filter((m) => m.type === 'way' && m.role !== 'inner' && osm.ways.has(m.ref))
    .map((m) => osm.ways.get(m.ref).nodes));
  let a = 0;
  let x = 0;
  let y = 0;
  for (const ring of outer.rings) {
    const r = coords(ring);
    const w = Math.abs(ringArea(r));
    const c = ringCentroid(r);
    a += w;
    x += c.x * w;
    y += c.y * w;
  }
  return a > 0 ? { x: x / a, y: y / a } : null;
}

/**
 * First half of pass 18: every POI as node, way or relation centroid. Kindergartens are mostly ways, so nodes alone would
 * miss most of them. A building-tagged sensitive site has no sign and exists only for the guard.
 * @param {object} osm Extract.
 * @param {object} box Decimetre box.
 * @param {object} rules `kinds.json`.
 * @returns {object[]} POI records.
 */
export function collectPois(osm, box, rules) {
  const out = [];
  const inBox = (p) => p.x >= box.minX && p.x <= box.maxX && p.y >= box.minY && p.y <= box.maxY;
  const consider = (e, osmT) => {
    const t = e.tags;
    if (!t) return;
    const kind = kindOf(t, rules);
    const sensitive = isSensitive(t, rules);
    if (kind === undefined && !sensitive) return;
    const c = centreOf(e, osm);
    if (!c || !inBox(c)) return;
    const guard = kind === undefined;
    const names = guard ? { he: '', en: '' } : namesOf(t);
    const streets = guard ? [] : ['addr:street', 'addr:street:he', 'addr:street:en'].map((k) => t[k]).filter(Boolean);
    out.push({
      osm: e.id,
      osmT,
      x: Math.round(c.x),
      y: Math.round(c.y),
      kind: guard ? rules[`building=${t.building}`] : kind,
      nameHe: names.he,
      nameEn: names.en,
      streets,
      sensitive,
      guard,
      amenityKindergarten: t.amenity === 'kindergarten'
    });
  };
  for (const n of sortedById(osm.nodes)) if (n.tags) consider(n, OSM_NODE);
  for (const w of sortedById(osm.ways)) if (w.tags) consider(w, OSM_WAY);
  for (const r of sortedById(osm.rels)) if (r.tags) consider(r, OSM_RELATION);
  return out;
}

/**
 * Host building of a POI, or -1. A way or relation uses its own footprint when it has one. A `poi.move` overlay that takes
 * the point off that footprint means the POI left it, so the new position picks the host, as it does for a node.
 */
function hostOf(p, blds, byOsm, index) {
  if (p.osmT !== OSM_NODE) {
    const own = byOsm.get(`${p.osmT}:${p.osm}`);
    if (own) {
      const inside = own.filter((id) => index.at(p.x, p.y).includes(id));
      if (inside.length) return inside[0];
      if (!p.moved) return own.slice().sort((a, b) => ringArea(blds[b].rings[0]) - ringArea(blds[a].rings[0]) || a - b)[0];
    }
  }
  const inside = index.at(p.x, p.y);
  if (inside.length) {
    return inside.slice().sort((a, b) => ringArea(blds[a].rings[0]) - ringArea(blds[b].rings[0]) || a - b)[0];
  }
  let best = -1;
  let bestD = HOST_NEAR_DM;
  for (const w of index.wallsIn(p.x - HOST_NEAR_DM, p.y - HOST_NEAR_DM, p.x + HOST_NEAR_DM, p.y + HOST_NEAR_DM)) {
    const d = nearestOnSeg(p.x, p.y, w.ax, w.ay, w.bx, w.by).d;
    if (d < bestD || (d === bestD && w.b < best)) {
      bestD = d;
      best = w.b;
    }
  }
  return best;
}

/** Wall endpoints and metrics. */
function wallOf(b, i) {
  const r = b.rings[0];
  const n = r.length >> 1;
  const ax = r[2 * i];
  const ay = r[2 * i + 1];
  const bx = r[2 * ((i + 1) % n)];
  const by = r[2 * ((i + 1) % n) + 1];
  const len = Math.hypot(bx - ax, by - ay);
  return { ax, ay, bx, by, len, nx: (by - ay) / len, ny: -(bx - ax) / len };
}

/** Best wall of a host for a POI, section 6.5 steps 2 and 3. */
function chooseWall(p, b, normalize) {
  const keys = p.streets.map((s) => streetKey(s, normalize)).filter(Boolean);
  let best = null;
  const n = b.rings[0].length >> 1;
  for (let i = 0; i < n; i++) {
    const roads = b.facing[i];
    if (!roads || !roads.length) continue;
    const w = wallOf(b, i);
    const q = nearestOnSeg(p.x, p.y, w.ax, w.ay, w.bx, w.by);
    for (const road of roads) {
      if (road.e.cls === SERVICE_CLASS && !road.e.name) continue;
      const match = streetMatches(keys, road.e, normalize);
      const score = (match ? STREET_BONUS : 0) + Math.min(w.len / 10, WALL_LEN_CAP_M) * WALL_LEN_WEIGHT -
        (q.d / 10) * POI_DIST_WEIGHT - (road.d / 10) * ROAD_DIST_WEIGHT;
      if (!best || score > best.score || (score === best.score && i === best.wall && road.e.id < best.road.e.id)) {
        best = { wall: i, road, score, match, along: q.t * w.len, hadStreet: keys.length > 0 };
      }
    }
  }
  return best;
}

/**
 * Lays signs along one wall without overlap, keeping each close to where its POI really is.
 * @param {Array<{along: number}>} list Signs, sorted by `along`, decimetres.
 * @param {number} len Wall length, decimetres.
 * @param {number} width Sign width, decimetres.
 */
function packAlong(list, len, width) {
  const half = width / 2;
  for (let i = 0; i < list.length; i++) {
    const min = i === 0 ? half : list[i - 1].c + width;
    list[i].c = Math.max(min, Math.min(len - half, list[i].along));
  }
  let limit = len - half;
  for (let i = list.length - 1; i >= 0; i--) {
    if (list[i].c > limit) list[i].c = limit;
    limit = list[i].c - width;
  }
}

/**
 * Door point 0.5 m outside the wall, at the free spot nearest the sign when a neighbouring building stands there.
 * @returns {number[]|null} `[x, y]`, or null for a wall with no free spot at all.
 */
function doorAt(w, c, index) {
  const tryAt = (s) => [w.ax + ((w.bx - w.ax) * s) / w.len + w.nx * DOOR_OUT_DM,
    w.ay + ((w.by - w.ay) * s) / w.len + w.ny * DOOR_OUT_DM];
  for (let off = 0; off <= w.len; off += DOOR_STEP_DM) {
    for (const s of off ? [c + off, c - off] : [c]) {
      if (s < 0 || s > w.len) continue;
      const [x, y] = tryAt(s);
      if (!index.at(x, y).length) return [x, y];
    }
  }
  return null;
}

/**
 * Second half of pass 18: binds POIs to facades. The road a wall was picked for stays private, as `p.pick`. The stored
 * `edge` is the nearest edge to the door (section 7.3), which may be another road: a long wall can look at its street from
 * one end while the door stands by a side alley.
 * @param {object[]} pois From `collectPois`.
 * @param {object[]} blds Buildings with `facing` from `setFronts`.
 * @param {object} index `BuildingIndex`.
 * @param {object} roads `RoadIndex`.
 * @param {function(string): string} normalize `TLV.anchors.normalizeName`.
 * @returns {{pois: object[], stats: object}}
 */
export function bindFacades(pois, blds, index, roads, normalize) {
  const byOsm = new Map();
  for (const b of blds) {
    const k = `${b.osmT}:${b.osm}`;
    if (!byOsm.has(k)) byOsm.set(k, []);
    byOsm.get(k).push(b.id);
  }
  const walls = new Map();
  const stats = {
    host: 0,
    facade: 0,
    noHost: 0,
    noWall: 0,
    interior: 0,
    overflowWalls: 0,
    addrKnown: 0,
    addrMatched: 0,
    nearestNotFaced: 0
  };
  for (const p of pois) {
    p.flags = (p.nameHe || p.nameEn ? POIF.NAMED : 0) | (p.sensitive ? POIF.SENSITIVE : 0);
    p.bld = 0;
    p.wall = 0;
    p.t = 0;
    p.w = 0;
    p.entX = p.x;
    p.entY = p.y;
    p.edge = 0;
    if (p.guard) {
      p.flags |= POIF.NO_FACADE;
      continue;
    }
    const host = hostOf(p, blds, byOsm, index);
    if (host < 0) {
      stats.noHost++;
      continue;
    }
    stats.host++;
    p.bld = host + 1;
    const pick = chooseWall(p, blds[host], normalize);
    if (!pick) {
      stats.noWall++;
      continue;
    }
    if (pick.hadStreet) {
      stats.addrKnown++;
      if (pick.match) stats.addrMatched++;
    }
    p.pick = pick;
    const key = `${host}:${pick.wall}`;
    if (!walls.has(key)) walls.set(key, { b: blds[host], i: pick.wall, list: [] });
    walls.get(key).list.push(p);
  }

  for (const key of [...walls.keys()].sort()) {
    const { b, i, list } = walls.get(key);
    const w = wallOf(b, i);
    const lenM = w.len / 10;
    const room = Math.max(1, Math.floor(lenM / MIN_SIGN_M));
    const ranked = list.slice().sort((p, q) => Number(!!q.nameHe || !!q.nameEn) - Number(!!p.nameHe || !!p.nameEn) ||
      p.pick.along - q.pick.along || p.osm - q.osm);
    const shown = ranked.slice(0, room).sort((p, q) => p.pick.along - q.pick.along || p.osm - q.osm);
    const inside = ranked.slice(room);
    if (inside.length) stats.overflowWalls++;
    const widthM = Math.max(MIN_SIGN_M, Math.min(MAX_SIGN_M, lenM / shown.length));
    const signs = shown.map((p) => ({ p, along: p.pick.along, c: 0 }));
    packAlong(signs, w.len, widthM * 10);
    for (const { p, c } of signs) {
      const door = doorAt(w, c, index);
      // A tower standing on a podium has walls with solid building on their far side, and nobody can reach a door there.
      if (!door) continue;
      const [x, y] = door;
      p.wall = i + 1;
      p.t = Math.max(0, Math.min(255, Math.round((c / w.len) * 255)));
      p.w = Math.round(widthM * 10);
      p.entX = Math.round(x);
      p.entY = Math.round(y);
      stats.facade++;
    }
    const hall = doorAt(w, w.len / 2, index);
    if (!hall) continue;
    const [dx, dy] = hall;
    for (const p of inside) {
      p.flags |= POIF.INTERIOR;
      p.wall = i + 1;
      p.t = 128;
      p.w = Math.round(MIN_SIGN_M * 10);
      p.entX = Math.round(dx);
      p.entY = Math.round(dy);
      stats.interior++;
      stats.facade++;
    }
  }

  for (const p of pois) {
    if (!p.wall) {
      p.flags |= POIF.NO_FACADE;
      const road = roads.nearest(p.x, p.y);
      if (road) snapToSidewalk(p, road);
    }
    const nearest = roads.nearest(p.entX, p.entY);
    p.edge = nearest ? nearest.e.id + 1 : 0;
    if (p.pick && p.wall && nearest.e !== p.pick.road.e) stats.nearestNotFaced++;
  }
  const order = pois.slice().sort((a, b) => a.y - b.y || a.x - b.x || a.osmT - b.osmT || a.osm - b.osm);
  return { pois: order, stats };
}

/** Door of a POI with no facade: its raw position snapped to the edge side at `kerbOff + sw/2`, section 6.5 step 5. */
function snapToSidewalk(p, road) {
  const { e } = road;
  const k = kerbOffsets(e);
  const off = road.side > 0 ? k.L + e.swL / 2 : k.R + e.swR / 2;
  const i = segmentAt(e, road.s);
  const ax = e.pts[2 * i - 2];
  const ay = e.pts[2 * i - 1];
  const bx = e.pts[2 * i];
  const by = e.pts[2 * i + 1];
  const l = Math.hypot(bx - ax, by - ay) || 1;
  const sign = road.side > 0 ? 1 : -1;
  p.entX = Math.round(road.x + (-(by - ay) / l) * off * sign);
  p.entY = Math.round(road.y + ((bx - ax) / l) * off * sign);
}

/** Index of the polyline segment holding arc length `s`. */
function segmentAt(e, s) {
  const n = e.cum.length;
  let i = 1;
  while (i < n - 1 && e.cum[i] < s) i++;
  return i;
}
