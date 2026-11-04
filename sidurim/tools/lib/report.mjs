// tools/lib/report.mjs — WP-MAP
// Passes 22 and 23. Verification works on the decoded map, through the shipped codec, so a gate passing here means the
// bytes a player loads are right, not that an importer structure looked right on the way out.

import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { pathToFileURL } from 'node:url';
import {
  Grid, cumulative, laneOffsets, minTrims, nearestOnSeg, offsetPolyline, pointAt, pointInRing, projectOnPolyline, ringArea, segHitT,
  trimLine
} from './osm.mjs';
import { findCrossings } from './graph.mjs';

const RUNTIME_FILES = ['js/world/map_codec.js', 'js/world/anchors.js'];
const SPOT_LEN_DM = 65;
const SPOT_INSET_DM = 12;
const PORTAL_FORGIVE_DM = 30;
const MIN_EDGE_DM = 30;
const MAX_MAP_BYTES = 1600000;
const KIND_PASS = 0;
const KIND_SIGNAL = 2;
const JF_PORTAL = 1;
const WALL_BOUNDS = 0;
const EF_AI_F = 8;
const EF_AI_B = 16;
const BF_NO_COLLIDER = 1;
const POIF_NAMED = 1;
const POIF_SENSITIVE = 4;
const POIF_NO_FACADE = 8;
const DIFF_FLAG_PCT = 5;
const ROAD_CELL_DM = 200;
const NEAREST_SLACK_DM = 1e-6;
const KERB_SLACK_DM = 6;
const GAP_CELL_DM = 200;
const GAP_STEP_DM = 1;
const GAP_SLACK_DM = 3;
const GAP_TOUCH_DM = 2;
const GAP_CLEARANCE_DM = 30;
const GAP_MIN_SIN = 0.3;
const DIFF_ROUND_DM = 3;
const ROUNDABOUT = 1;
const MIN_KEPT_RINGS = 20;
const HOLLOW_LIMIT_M2 = 1000;
const MAJOR_CLASS = 2;
const NARROW_CLASS = 3;
const NARROW_SPREAD_DM = 300;
const OVERLAP_STEP_DM = 20;
const OVERLAP_SLACK_DM = 1;
const OVERLAP_RANGE_DM = 80;
const OVERLAP_MIN_RUN_DM = 40;
const OVERLAP_MIN_COS = 0.7;
const OVERLAP_FORK_DM = 60;
const OVERLAP_STOP_FORK_DM = 80;
const CAR_WIDTH_M = 1.8;
const CONTACT_STEP_M = 1;
const TRIM_PAD_DM = 15;
const TRIM_MIN_DM = 30;
const TRIM_MAX_DM = 140;
const TRIM_MAX_SHARE = 0.45;
const DIFF_OTHER_TABLES = ['trees', 'lots', 'lotPts', 'land', 'landPts', 'paths', 'pathPts'];

/** Same compile form as section 5, for when WP-CORE's loader is absent. */
function privateLoad(root) {
  const win = {
    TLV: {
      q: [],
      tune: {},
      ns(name) {
        let o = win.TLV;
        for (const part of name.split('.')) o = o[part] || (o[part] = {});
        return o;
      }
    }
  };
  for (const file of RUNTIME_FILES) {
    const full = path.join(root, file);
    vm.compileFunction(fs.readFileSync(full, 'utf8'), ['window', 'TLV'], { filename: full })(win, win.TLV);
  }
  return win.TLV;
}

/**
 * Loads the shipped codec and anchors through the classic loader when it is there.
 * @param {string} root Project root.
 * @returns {Promise<object>} A `TLV` holding `mapCodec` and `anchors`.
 */
export async function loadRuntime(root) {
  const classic = path.join(root, 'tools/lib/classic.mjs');
  if (fs.existsSync(classic) && fs.existsSync(path.join(root, 'js/core/namespace.js'))) {
    try {
      const mod = await import(pathToFileURL(classic).href);
      const TLV = mod.createTLV({ root, files: RUNTIME_FILES });
      if (TLV.mapCodec && TLV.anchors) return TLV;
    } catch {
      return privateLoad(root);
    }
  }
  return privateLoad(root);
}

/**
 * Builds the World of a written map through the classic loader, so a gate can read what a car drives on.
 * @param {string} root Project root.
 * @param {string} file Path of the written `map.js`.
 * @returns {Promise<?{TLV: object, world: object}>} Null when the project has no runtime to build with.
 */
export async function buildWorld(root, file) {
  const classic = path.join(root, 'tools/lib/classic.mjs');
  if (!fs.existsSync(classic) || !fs.existsSync(path.join(root, 'js/world/world.js'))) return null;
  const mod = await import(pathToFileURL(classic).href);
  const TLV = mod.createTLV({ root, files: ['sim'] });
  return { TLV, world: TLV.world.build(readMapPayload(file)) };
}

/** Runs a `TLV.q.push` data file and returns the pushed payload. */
export function readMapPayload(file) {
  const q = [];
  vm.compileFunction(fs.readFileSync(file, 'utf8'), ['TLV'], { filename: file })({ q });
  return q[0][1];
}

/** Polyline of one edge from decoded columns. */
function edgePts(d, i) {
  const { ptOff } = d.t.edges.col;
  const { x, y } = d.t.pts.col;
  const out = [];
  for (let k = ptOff[i]; k < ptOff[i + 1]; k++) out.push(x[k], y[k]);
  return out;
}

/** Rings of a building from decoded columns, flat. */
function bldRings(d, i) {
  const { rOff } = d.t.blds.col;
  const { pOff } = d.t.brings.col;
  const { x, y } = d.t.bpts.col;
  const rings = [];
  for (let r = rOff[i]; r < rOff[i + 1]; r++) {
    const ring = [];
    for (let k = pOff[r]; k < pOff[r + 1]; k++) ring.push(x[k], y[k]);
    rings.push(ring);
  }
  return rings;
}

/** Structural checks every table must pass: lengths, offsets, references, sort orders. */
function checkStructure(d) {
  const bad = [];
  const { t } = d;
  for (const [name, table] of Object.entries(t)) {
    for (const [col, a] of Object.entries(table.col)) {
      const want = col.endsWith('Off') ? table.n + 1 : table.n;
      if (a.length !== want) bad.push(`${name}.${col} has ${a.length} entries, expected ${want}`);
      if (col.endsWith('Off')) for (let i = 1; i < a.length; i++) if (a[i] < a[i - 1]) bad.push(`${name}.${col} not monotonic`);
    }
  }
  const nJ = t.juncs.n;
  const nE = t.edges.n;
  const e = t.edges.col;
  for (let i = 0; i < nE; i++) {
    if (e.ptOff[i + 1] - e.ptOff[i] < 2) bad.push(`edge ${i} has under two points`);
    if (cumulative(edgePts(d, i)).at(-1) < MIN_EDGE_DM) bad.push(`edge ${i} is too short for a lane`);
    if (e.a[i] >= nJ || e.b[i] >= nJ) bad.push(`edge ${i} has a bad junction`);
    if (e.a[i] === e.b[i]) bad.push(`edge ${i} is a loop`);
    if (e.lanesF[i] === 0) bad.push(`edge ${i} has no forward lane`);
  }
  const m = t.moves.col;
  for (let i = 0; i < t.moves.n; i++) {
    if (i && (m.from[i] < m.from[i - 1] || (m.from[i] === m.from[i - 1] && m.to[i] <= m.to[i - 1]))) bad.push('moves not sorted');
    const f = m.from[i];
    const g = m.to[i];
    if (f >> 1 >= nE || g >> 1 >= nE) {
      bad.push('moves row points outside edges');
      continue;
    }
    const juncIn = f & 1 ? e.a[f >> 1] : e.b[f >> 1];
    const juncOut = g & 1 ? e.b[g >> 1] : e.a[g >> 1];
    if (juncIn !== juncOut) bad.push(`move ${i} does not pass through a junction`);
  }
  const exits = new Set();
  for (let i = 0; i < t.moves.n; i++) exits.add(m.from[i]);
  for (let i = 0; i < nE; i++) {
    if (e.flags[i] & EF_AI_F && !exits.has(i * 2)) bad.push(`AI edge ${i} forward has no exit`);
    if (e.flags[i] & EF_AI_B && !exits.has(i * 2 + 1)) bad.push(`AI edge ${i} backward has no exit`);
  }
  const k = t.kerbs.col;
  const sides = new Map();
  for (let i = 0; i < t.kerbs.n; i++) {
    if (k.edge[i] >= nE) bad.push('kerb row points outside edges');
    if (k.s1[i] <= k.s0[i]) bad.push(`kerb ${i} is empty`);
    const key = k.edge[i] * 2 + k.side[i];
    if (!sides.has(key)) {
      sides.set(key, i);
      if (k.s0[i] !== 0) bad.push(`kerb ${i} does not start at 0`);
    } else if (k.s0[i] !== k.s1[sides.get(key)]) {
      bad.push(`kerb ${i} leaves a gap`);
    }
    sides.set(key, i);
  }
  for (let i = 0; i < nE; i++) {
    const len = Math.round(cumulative(edgePts(d, i)).at(-1));
    for (const side of [0, 1]) {
      const last = sides.get(i * 2 + side);
      if (last === undefined) bad.push(`edge ${i} side ${side} has no kerb row`);
      else if (Math.abs(k.s1[last] - len) > 1) bad.push(`edge ${i} side ${side} kerb ends at ${k.s1[last]}, not ${len}`);
    }
  }
  const p = t.pois.col;
  for (let i = 0; i < t.pois.n; i++) {
    if (p.bld[i] > t.blds.n || p.edge[i] > nE) bad.push(`poi ${i} has a bad reference`);
    if (p.wall[i] > 0) {
      const b = p.bld[i] - 1;
      const r = t.blds.col.rOff[b];
      const n = t.brings.col.pOff[r + 1] - t.brings.col.pOff[r];
      if (p.wall[i] > n) bad.push(`poi ${i} names a wall its building does not have`);
    }
  }
  for (const s of ['stops', 'xings']) {
    for (let i = 0; i < t[s].n; i++) if (t[s].col.edge[i] >= nE) bad.push(`${s} ${i} has a bad edge`);
  }
  return bad;
}

/** Lane polylines of a decoded edge, in both join styles. */
function laneLines(pts, lanesF, lanesB, laneW) {
  const out = [];
  for (const off of laneOffsets(lanesF, lanesB, laneW)) {
    out.push(offsetPolyline(pts, off, true));
    out.push(offsetPolyline(pts, off, false));
  }
  return out;
}

/** Counts crossings of road polylines that share no junction. */
function sameplaneCrossings(d) {
  const e = d.t.edges.col;
  const segs = [];
  for (let i = 0; i < d.t.edges.n; i++) {
    const p = edgePts(d, i);
    for (let k = 2; k < p.length; k += 2) {
      segs.push({ i, ax: p[k - 2], ay: p[k - 1], bx: p[k], by: p[k + 1], na: `${i}:${k}`, nb: `${i}:${k + 2}` });
    }
  }
  let count = 0;
  for (const [a, b] of findCrossings(segs)) {
    const p = segs[a].i;
    const q = segs[b].i;
    if (p === q) {
      count++;
      continue;
    }
    if (e.a[p] === e.a[q] || e.a[p] === e.b[q] || e.b[p] === e.a[q] || e.b[p] === e.b[q]) continue;
    count++;
  }
  return count;
}

/** Lanes against `walls` rows, forgiving the last 3 m at a portal. */
function laneWallCrossings(d) {
  const e = d.t.edges.col;
  const jf = d.t.juncs.col.flags;
  const grid = new Grid(400);
  const w = d.t.walls.col;
  const { x, y } = d.t.wallPts.col;
  const segs = [];
  for (let i = 0; i < d.t.walls.n; i++) {
    for (let k = w.pOff[i] + 1; k < w.pOff[i + 1]; k++) {
      const s = { kind: w.kind[i], ax: x[k - 1], ay: y[k - 1], bx: x[k], by: y[k] };
      segs.push(s);
      grid.addSeg(s.ax, s.ay, s.bx, s.by, s);
    }
  }
  const hits = [];
  for (let i = 0; i < d.t.edges.n; i++) {
    const pts = edgePts(d, i);
    const portalA = jf[e.a[i]] & JF_PORTAL;
    const portalB = jf[e.b[i]] & JF_PORTAL;
    for (const lane of laneLines(pts, e.lanesF[i], e.lanesB[i], e.laneW[i])) {
      const cum = cumulative(lane);
      const total = cum[cum.length - 1];
      for (let k = 2; k < lane.length; k += 2) {
        const ax = lane[k - 2];
        const ay = lane[k - 1];
        const bx = lane[k];
        const by = lane[k + 1];
        for (const s of grid.query(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by))) {
          const t = segHitT(ax, ay, bx, by, s.ax, s.ay, s.bx, s.by);
          if (t < 0) continue;
          const at = cum[(k >> 1) - 1] + t * (cum[k >> 1] - cum[(k >> 1) - 1]);
          if (s.kind === WALL_BOUNDS && ((portalA && at <= PORTAL_FORGIVE_DM) || (portalB && total - at <= PORTAL_FORGIVE_DM))) continue;
          hits.push({ edge: i, osm: e.osm[i], kind: s.kind, x: Math.round(ax / 10), y: Math.round(ay / 10) });
        }
      }
    }
  }
  return hits;
}

/** Spatial lookup over decoded footprints. */
function footprintIndex(d) {
  const n = d.t.blds.n;
  const rings = new Array(n);
  const grid = new Grid(400);
  const walls = new Grid(200);
  const flags = d.t.blds.col.flags;
  for (let i = 0; i < n; i++) {
    const r = bldRings(d, i);
    rings[i] = r;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    const outer = r[0];
    for (let k = 0; k < outer.length; k += 2) {
      x0 = Math.min(x0, outer[k]);
      x1 = Math.max(x1, outer[k]);
      y0 = Math.min(y0, outer[k + 1]);
      y1 = Math.max(y1, outer[k + 1]);
    }
    grid.addBox(x0, y0, x1, y1, i);
    if (flags[i] & BF_NO_COLLIDER) continue;
    for (const ring of r) {
      const m = ring.length >> 1;
      for (let a = 0, b = m - 1; a < m; b = a++) {
        const seg = { i, ax: ring[2 * b], ay: ring[2 * b + 1], bx: ring[2 * a], by: ring[2 * a + 1] };
        walls.addSeg(seg.ax, seg.ay, seg.bx, seg.by, seg);
      }
    }
  }
  const at = (x, y, colliderOnly) => {
    for (const i of grid.query(x, y, x, y)) {
      if (colliderOnly && flags[i] & BF_NO_COLLIDER) continue;
      const r = rings[i];
      if (!pointInRing(x, y, r[0])) continue;
      if (r.slice(1).some((h) => pointInRing(x, y, h))) continue;
      return i;
    }
    return -1;
  };
  return { at, walls };
}

/** Lanes, as trimmed at junctions, that cross or run inside a building that keeps its collider. */
function laneBuildingHits(d, idx) {
  const e = d.t.edges.col;
  const kind = d.t.juncs.col.kind;
  const hits = [];
  for (let i = 0; i < d.t.edges.n; i++) {
    const pts = edgePts(d, i);
    const len = cumulative(pts).at(-1);
    const [t0, t1] = minTrims(len, kind[e.a[i]] === KIND_PASS, kind[e.b[i]] === KIND_PASS);
    for (const whole of laneLines(pts, e.lanesF[i], e.lanesB[i], e.laneW[i])) {
      const lane = trimLine(whole, t0, t1);
      for (let k = 0; k < lane.length; k += 2) {
        if (idx.at(lane[k], lane[k + 1], true) >= 0) hits.push({ edge: i, osm: e.osm[i] });
        if (k + 3 >= lane.length) break;
        const ax = lane[k];
        const ay = lane[k + 1];
        const bx = lane[k + 2];
        const by = lane[k + 3];
        for (const s of idx.walls.query(Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by))) {
          if (segHitT(ax, ay, bx, by, s.ax, s.ay, s.bx, s.by) >= 0) hits.push({ edge: i, osm: e.osm[i], bld: s.i });
        }
      }
    }
  }
  return hits;
}

/**
 * Stalls derived the way WP-WORLD does (section 8.8): 6.5 m, on rows with a strip and tier at most 3, rejecting a centre
 * inside a footprint.
 */
function countStalls(d, idx) {
  const e = d.t.edges.col;
  const k = d.t.kerbs.col;
  const cache = new Map();
  const geom = (i) => {
    if (!cache.has(i)) {
      const pts = edgePts(d, i);
      cache.set(i, { pts, cum: cumulative(pts) });
    }
    return cache.get(i);
  };
  let stalls = 0;
  let rejected = 0;
  for (let r = 0; r < d.t.kerbs.n; r++) {
    if (k.tier[r] > 3) continue;
    const i = k.edge[r];
    const left = k.side[r] === 0;
    const park = left ? e.parkL[i] : e.parkR[i];
    if (!park) continue;
    const n = Math.floor((k.s1[r] - k.s0[r]) / SPOT_LEN_DM);
    const two = e.lanesB[i] > 0;
    const half = two ? (left ? e.lanesB[i] : e.lanesF[i]) * e.laneW[i] : (e.lanesF[i] * e.laneW[i]) / 2;
    const off = half + park - SPOT_INSET_DM;
    const { pts, cum } = geom(i);
    for (let c = 0; c < n; c++) {
      const p = pointAt(pts, cum, k.s0[r] + SPOT_LEN_DM * (c + 0.5));
      const sx = left ? -p.dy : p.dy;
      const sy = left ? p.dx : -p.dx;
      if (idx.at(p.x + sx * off, p.y + sy * off, false) >= 0) rejected++;
      else stalls++;
    }
  }
  return { stalls, rejected };
}

/** Road network figures from decoded columns. */
function networkFacts(d) {
  const e = d.t.edges.col;
  const j = d.t.juncs.col;
  const degree = new Int32Array(d.t.juncs.n);
  let laneKm = 0;
  let sccKm = 0;
  for (let i = 0; i < d.t.edges.n; i++) {
    degree[e.a[i]]++;
    degree[e.b[i]]++;
    const len = cumulative(edgePts(d, i)).at(-1) / 10000;
    laneKm += len * (e.lanesF[i] + e.lanesB[i]);
    if (e.flags[i] & EF_AI_F) sccKm += len * e.lanesF[i];
    if (e.flags[i] & EF_AI_B) sccKm += len * e.lanesB[i];
  }
  let signals = 0;
  let clusters = 0;
  for (let i = 0; i < d.t.juncs.n; i++) {
    if (j.kind[i] === KIND_SIGNAL) signals++;
    if (degree[i] >= 3) clusters++;
  }
  // Directed edges no move leaves, other than at a portal: one-way roads that simply end. Only the player can reach them.
  const exits = new Set(d.t.moves.col.from);
  let noExit = 0;
  for (let i = 0; i < d.t.edges.n; i++) {
    if (!exits.has(i * 2) && !(j.flags[e.b[i]] & JF_PORTAL)) noExit++;
    if (e.lanesB[i] && !exits.has(i * 2 + 1) && !(j.flags[e.a[i]] & JF_PORTAL)) noExit++;
  }
  return { laneKm, sccKm, share: laneKm ? sccKm / laneKm : 0, signals, clusters, noExit };
}

/**
 * POI figures from decoded columns. The game kind cannot tell `amenity=kindergarten` from `building=kindergarten`, and
 * only the first counts for the gate, so the importer names those rows and they are looked up here by OSM identity.
 * @param {object} d Decoded map.
 * @param {Set<string>} [kindergartens] `osmT:osm` of each POI tagged `amenity=kindergarten`.
 */
function poiFacts(d, kindergartens = new Set()) {
  const p = d.t.pois.col;
  let named = 0;
  let withFacade = 0;
  let sensitive = 0;
  let kindergarten = 0;
  for (let i = 0; i < d.t.pois.n; i++) {
    if (p.flags[i] & POIF_NAMED) {
      named++;
      if (!(p.flags[i] & POIF_NO_FACADE)) withFacade++;
    }
    if (p.flags[i] & POIF_SENSITIVE) {
      sensitive++;
      if (kindergartens.has(`${p.osmT[i]}:${p.osm[i]}`)) kindergarten++;
    }
  }
  return { named, withFacade, yield: named ? withFacade / named : 0, sensitive, kindergarten };
}

/**
 * POIs whose `edge` is not the edge nearest their door (section 7.3). A door has a closest road on any map that has roads,
 * so 0 is a miss too. The query box carries a cell of margin, because `Grid.addSeg` samples a segment.
 * @returns {number[]} POI rows.
 */
function poiEdgeMisses(d) {
  const p = d.t.pois.col;
  const { ptOff } = d.t.edges.col;
  const { x, y } = d.t.pts.col;
  const grid = new Grid(ROAD_CELL_DM);
  for (let i = 0; i < d.t.edges.n; i++) {
    for (let k = ptOff[i] + 1; k < ptOff[i + 1]; k++) {
      grid.addSeg(x[k - 1], y[k - 1], x[k], y[k], { ax: x[k - 1], ay: y[k - 1], bx: x[k], by: y[k] });
    }
  }
  const own = (i, px, py) => {
    let best = Infinity;
    for (let k = ptOff[i] + 1; k < ptOff[i + 1]; k++) {
      best = Math.min(best, nearestOnSeg(px, py, x[k - 1], y[k - 1], x[k], y[k]).d);
    }
    return best;
  };
  const misses = [];
  for (let i = 0; i < d.t.pois.n; i++) {
    if (!p.edge[i]) {
      if (d.t.edges.n) misses.push(i);
      continue;
    }
    const px = p.entX[i];
    const py = p.entY[i];
    const r = own(p.edge[i] - 1, px, py) + ROAD_CELL_DM;
    const limit = r - ROAD_CELL_DM - NEAREST_SLACK_DM;
    if (grid.query(px - r, py - r, px + r, py + r).some((s) => nearestOnSeg(px, py, s.ax, s.ay, s.bx, s.by).d < limit)) misses.push(i);
  }
  return misses;
}

/** POIs with a facade whose door stands inside a solid building, where nobody can reach it (section 6.5 step 5). */
function doorsInColliders(d, idx) {
  const p = d.t.pois.col;
  const out = [];
  for (let i = 0; i < d.t.pois.n; i++) {
    if (!(p.flags[i] & POIF_NO_FACADE) && idx.at(p.entX[i], p.entY[i], true) >= 0) out.push(i);
  }
  return out;
}

/**
 * Crossings whose section 6.6 gap still holds fence. Takes only the uncut motorway centrelines from the importer: crossings,
 * gap widths and the walk along the fence, past way ends and through forks, are worked out here from the decoded map, so a
 * mistake in the cutting cannot hide here too. The last `GAP_SLACK_DM` of a gap is not tested, because fence ends are rounded
 * and simplified.
 * @param {object} d Decoded map.
 * @param {number[][]} centrelines Uncut flat polylines.
 * @returns {Array<{edge: number, osm: number, x: number, y: number, half: number}>}
 */
function fenceInGaps(d, centrelines) {
  const e = d.t.edges.col;
  const lines = centrelines.map((pts) => {
    const cum = cumulative(pts);
    return { pts, cum, len: cum[cum.length - 1] };
  });
  const ends = new Map();
  const endKey = (l, atEnd) => (atEnd ? `${l.pts[l.pts.length - 2]},${l.pts[l.pts.length - 1]}` : `${l.pts[0]},${l.pts[1]}`);
  for (const l of lines) {
    for (const atEnd of [false, true]) {
      if (!ends.has(endKey(l, atEnd))) ends.set(endKey(l, atEnd), []);
      ends.get(endKey(l, atEnd)).push({ l, atEnd });
    }
  }
  const fence = new Grid(GAP_CELL_DM);
  const w = d.t.walls.col;
  const { x, y } = d.t.wallPts.col;
  for (let i = 0; i < d.t.walls.n; i++) {
    if (w.kind[i] === WALL_BOUNDS) continue;
    for (let k = w.pOff[i] + 1; k < w.pOff[i + 1]; k++) {
      fence.addSeg(x[k - 1], y[k - 1], x[k], y[k], { ax: x[k - 1], ay: y[k - 1], bx: x[k], by: y[k] });
    }
  }
  const standing = (px, py) => {
    const r = GAP_CELL_DM;
    return fence.query(px - r, py - r, px + r, py + r).some((s) => nearestOnSeg(px, py, s.ax, s.ay, s.bx, s.by).d <= GAP_TOUCH_DM);
  };
  // Walks the gap away from a crossing, sampling, and carries on through each way touching the far end.
  const fenced = (l, s, dir, left, seen) => {
    const room = dir > 0 ? l.len - s : s;
    for (let t = 0; t <= Math.min(room, left - GAP_SLACK_DM); t += GAP_STEP_DM) {
      const p = pointAt(l.pts, l.cum, s + dir * t);
      if (standing(p.x, p.y)) return true;
    }
    if (left <= room) return false;
    for (const { l: next, atEnd } of ends.get(endKey(l, dir > 0))) {
      if (seen.has(next)) continue;
      seen.add(next);
      if (fenced(next, atEnd ? next.len : 0, atEnd ? -1 : 1, left - room, seen)) return true;
    }
    return false;
  };
  const roads = new Grid(GAP_CELL_DM);
  for (let i = 0; i < d.t.edges.n; i++) {
    const p = edgePts(d, i);
    for (let k = 2; k < p.length; k += 2) roads.addSeg(p[k - 2], p[k - 1], p[k], p[k + 1], { i, ax: p[k - 2], ay: p[k - 1], bx: p[k], by: p[k + 1] });
  }
  const halfGap = (i, sin) => {
    const two = e.lanesB[i] > 0;
    const left = (two ? e.lanesB[i] * e.laneW[i] : (e.lanesF[i] * e.laneW[i]) / 2) + e.parkL[i] + e.swL[i];
    const right = (two ? e.lanesF[i] * e.laneW[i] : (e.lanesF[i] * e.laneW[i]) / 2) + e.parkR[i] + e.swR[i];
    return (Math.max(left, right) + GAP_CLEARANCE_DM) / Math.max(GAP_MIN_SIN, sin);
  };
  const bad = [];
  for (const l of lines) {
    for (let k = 1; k < l.cum.length; k++) {
      const ax = l.pts[2 * k - 2];
      const ay = l.pts[2 * k - 1];
      const bx = l.pts[2 * k];
      const by = l.pts[2 * k + 1];
      const r = GAP_CELL_DM;
      for (const s of roads.query(Math.min(ax, bx) - r, Math.min(ay, by) - r, Math.max(ax, bx) + r, Math.max(ay, by) + r)) {
        const t = segHitT(ax, ay, bx, by, s.ax, s.ay, s.bx, s.by);
        if (t < 0) continue;
        const la = l.cum[k] - l.cum[k - 1];
        const sin = Math.abs((bx - ax) * (s.by - s.ay) - (by - ay) * (s.bx - s.ax)) / (la * Math.hypot(s.bx - s.ax, s.by - s.ay));
        const half = halfGap(s.i, sin);
        const at = l.cum[k - 1] + t * la;
        if (fenced(l, at, 1, half, new Set([l])) || fenced(l, at, -1, half, new Set([l]))) {
          bad.push({ edge: s.i, osm: e.osm[s.i], x: Math.round(ax + (bx - ax) * t), y: Math.round(ay + (by - ay) * t), half: Math.round(half) });
        }
      }
    }
  }
  return bad;
}

/** Stop line distance by junction, section 8.1, from decoded columns. */
function stopLinesOf(d) {
  const e = d.t.edges.col;
  const widest = new Float64Array(d.t.juncs.n);
  for (let i = 0; i < d.t.edges.n; i++) {
    const two = e.lanesB[i] > 0;
    const left = (two ? e.lanesB[i] * e.laneW[i] : (e.lanesF[i] * e.laneW[i]) / 2) + e.parkL[i];
    const right = (two ? e.lanesF[i] * e.laneW[i] : (e.lanesF[i] * e.laneW[i]) / 2) + e.parkR[i];
    widest[e.a[i]] = Math.max(widest[e.a[i]], left + right);
    widest[e.b[i]] = Math.max(widest[e.b[i]], left + right);
  }
  return Array.from(widest, (w, j) => (d.t.juncs.col.kind[j] === KIND_PASS ? 0 : Math.max(TRIM_MIN_DM, Math.min(TRIM_MAX_DM, 0.5 * w + TRIM_PAD_DM))));
}

/**
 * Lanes of different edges whose painted widths overlap outside their junctions. On the built World when one is given, so it reads
 * lanes where they really end. Otherwise worked out from the decoded rows, offset per section 8.1 and cut at the stop line. Either
 * way it reads the map, not the numbers the importer settled on, so a mistake there shows here. Two lanes leaving one junction at
 * a fork get `OVERLAP_FORK_DM` past their ends to come apart: WP-WORLD ends them where cars clear each other, and paint clears a
 * little later. Measured from a stop line instead, which knows nothing of that, they get `OVERLAP_STOP_FORK_DM`. A run under
 * `OVERLAP_MIN_RUN_DM` is a brush, not a shared carriageway. `laneContacts` is the measure with no allowance at all.
 * @param {object} d Decoded map.
 * @param {Array<{ways: number[]}>} [allow] Way pairs known to be unsolvable.
 * @param {?object} [world] The built World, for `world.lanes`.
 * @returns {Array<{ways: number[], name: string, opposite: boolean, m: number, x: number, y: number, allowed: boolean}>} Pairs, longest first.
 */
export function carriagewayOverlaps(d, allow = [], world = null) {
  const e = d.t.edges.col;
  const lanes = [];
  const grid = new Grid(GAP_CELL_DM);
  const add = (edge, line, back) => {
    const lane = { edge, line, cum: cumulative(line), back, id: lanes.length };
    lanes.push(lane);
    for (let k = 2; k < line.length; k += 2) grid.addSeg(line[k - 2], line[k - 1], line[k], line[k + 1], lane);
  };
  if (world) {
    for (const lane of world.lanes) {
      const back = lane.dirEdge % 2 === 1;
      const line = [];
      for (let i = 0; i < lane.px.length; i++) {
        const at = back ? lane.px.length - 1 - i : i;
        line.push(lane.px[at] * 10, lane.py[at] * 10);
      }
      add(lane.edge, line, back);
    }
  } else {
    const stops = stopLinesOf(d);
    for (let i = 0; i < d.t.edges.n; i++) {
      const pts = edgePts(d, i);
      const len = cumulative(pts).at(-1);
      const t0 = Math.min(stops[e.a[i]], TRIM_MAX_SHARE * len);
      const t1 = Math.min(stops[e.b[i]], TRIM_MAX_SHARE * len);
      const two = e.lanesB[i] > 0;
      for (const off of laneOffsets(e.lanesF[i], e.lanesB[i], e.laneW[i])) add(i, trimLine(offsetPolyline(pts, off, true), t0, t1), two && off < 0);
    }
  }
  const fork = world ? OVERLAP_FORK_DM : OVERLAP_STOP_FORK_DM;
  const leaving = (a, sa, b, sb) => {
    const ends = [[e.a[a.edge], sa], [e.b[a.edge], a.cum.at(-1) - sa]];
    const others = [[e.a[b.edge], sb], [e.b[b.edge], b.cum.at(-1) - sb]];
    return ends.some(([j, x]) => others.some(([k, y]) => j === k && Math.min(x, y) < fork));
  };
  const pairs = new Map();
  for (const a of lanes) {
    const len = a.cum.at(-1);
    const hits = new Map();
    for (let s = 0; s <= len; s += OVERLAP_STEP_DM) {
      const p = pointAt(a.line, a.cum, s);
      const r = OVERLAP_RANGE_DM;
      for (const b of new Set(grid.query(p.x - r, p.y - r, p.x + r, p.y + r))) {
        if (b.id <= a.id || b.edge === a.edge) continue;
        const q = projectOnPolyline(p.x, p.y, b.line, b.cum);
        const room = (e.laneW[a.edge] + e.laneW[b.edge]) / 2 - OVERLAP_SLACK_DM;
        if (q.d >= room || q.s < 1 || q.s > b.cum.at(-1) - 1 || leaving(a, s, b, q.s)) continue;
        const t = pointAt(b.line, b.cum, q.s);
        const cos = p.dx * t.dx + p.dy * t.dy;
        if (Math.abs(cos) < OVERLAP_MIN_COS) continue;
        const list = hits.get(b) || [];
        list.push({ s, x: p.x, y: p.y, opposite: cos < 0 === a.back === b.back });
        hits.set(b, list);
      }
    }
    for (const [b, list] of hits) {
      if (list.length * OVERLAP_STEP_DM < OVERLAP_MIN_RUN_DM) continue;
      const [lo, hi] = a.edge < b.edge ? [a.edge, b.edge] : [b.edge, a.edge];
      const key = lo * d.t.edges.n + hi;
      const m = (list.length * OVERLAP_STEP_DM) / 10;
      const cur = pairs.get(key);
      if (!cur || m > cur.m) {
        const ways = [e.osm[lo], e.osm[hi]];
        pairs.set(key, {
          ways,
          name: d.strings[e.nameEn[lo]] || d.strings[e.name[lo]] || '',
          opposite: list[0].opposite,
          m,
          x: Math.round(list[0].x / 10),
          y: Math.round(list[0].y / 10),
          allowed: allow.some((w) => w.ways.includes(ways[0]) && w.ways.includes(ways[1]))
        });
      }
    }
  }
  return [...pairs.keys()].sort((p, q) => p - q).map((k) => pairs.get(k)).sort((p, q) => q.m - p.m);
}

/**
 * Lanes that put two car bodies in one place, on the World as built: centres under a car's width apart, at any point of any lane
 * of another edge, with no allowance at lane ends. Lanes a car drives from one to the other lie head to tail, and are one road.
 * Two lanes no AI car uses can hold no AI car, so at least one of the pair must be AI_ROUTABLE.
 * @param {object} TLV Runtime holding `world.lanes` and `math`.
 * @param {object} world Built World.
 * @param {Array<{ways: number[]}>} [allow] Way pairs known to be unsolvable.
 * @returns {Array<{ways: number[], name: string, m: number, min: number, x: number, y: number, allowed: boolean}>} Pairs, longest first.
 */
export function laneContacts(TLV, world, allow = []) {
  const near = new Int32Array(512);
  const pairs = new Map();
  const linked = (a, b) => Array.from(a.conns).some((c) => world.conns[c].to === b.id);
  const AI = TLV.const.LF.AI_ROUTABLE;
  for (const a of world.lanes) {
    for (let k = 0; k + 1 < a.px.length; k++) {
      const span = a.cum[k + 1] - a.cum[k];
      const count = Math.max(1, Math.ceil(span / CONTACT_STEP_M));
      for (let t = 0; t < count; t++) {
        const x = a.px[k] + ((a.px[k + 1] - a.px[k]) * t) / count;
        const y = a.py[k] + ((a.py[k + 1] - a.py[k]) * t) / count;
        const n = TLV.world.lanes.lanesNear(world, x, y, CAR_WIDTH_M, near);
        for (let i = 0; i < n; i++) {
          const b = world.lanes[near[i]];
          if (b.id <= a.id || b.edge === a.edge || !((a.flags | b.flags) & AI) || linked(a, b) || linked(b, a)) continue;
          let min = Infinity;
          for (let q = 0; q + 1 < b.px.length; q++) min = Math.min(min, TLV.math.pointSegDist(x, y, b.px[q], b.py[q], b.px[q + 1], b.py[q + 1]));
          const key = a.id * world.lanes.length + b.id;
          const cur = pairs.get(key) || { a, b, m: 0, min, x, y };
          cur.m++;
          if (min <= cur.min) Object.assign(cur, { min, x, y });
          pairs.set(key, cur);
        }
      }
    }
  }
  const edgeOf = (lane) => world.edges[lane.edge];
  const rows = [...pairs.values()].map(({ a, b, m, min, x, y }) => {
    const ways = [edgeOf(a).osm, edgeOf(b).osm];
    return {
      ways,
      name: edgeOf(a).nameEn || edgeOf(a).name || edgeOf(b).nameEn || edgeOf(b).name || '',
      m,
      min: Number(min.toFixed(2)),
      x: Math.round(x),
      y: Math.round(y),
      allowed: allow.some((w) => w.ways.includes(ways[0]) && w.ways.includes(ways[1]))
    };
  });
  return rows.sort((p, q) => q.m - p.m || p.ways[0] - q.ways[0] || p.ways[1] - q.ways[1]);
}

/** Dead ends on class 2 or better. A portal is where the map stops, not the road. */
function majorDeadEnds(d) {
  const e = d.t.edges.col;
  const j = d.t.juncs.col;
  const count = new Int32Array(d.t.juncs.n);
  const best = new Int32Array(d.t.juncs.n).fill(99);
  for (let i = 0; i < d.t.edges.n; i++) {
    for (const k of [e.a[i], e.b[i]]) {
      count[k]++;
      best[k] = Math.min(best[k], e.cls[i]);
    }
  }
  const out = [];
  for (let k = 0; k < d.t.juncs.n; k++) {
    if (count[k] === 1 && best[k] <= MAJOR_CLASS && !(j.flags[k] & JF_PORTAL)) out.push({ x: Math.round(j.x[k] / 10), y: Math.round(j.y[k] / 10) });
  }
  return out;
}

/** Buildings of over `HOLLOW_LIMIT_M2` a player could drive through, other than canopies and the listed exceptions. */
function hollowBuildingsOf(d, roofs, allow) {
  const b = d.t.blds.col;
  const out = [];
  for (let i = 0; i < d.t.blds.n; i++) {
    if (!(b.flags[i] & BF_NO_COLLIDER)) continue;
    const id = `${'nwr'[b.osmT[i]]}${b.osm[i]}`;
    if (roofs.has(id) || allow.some((a) => a.osm === id)) continue;
    const m2 = Math.abs(ringArea(bldRings(d, i)[0])) / 100;
    if (m2 > HOLLOW_LIMIT_M2) out.push({ osm: id, m2: Math.round(m2) });
  }
  return out;
}

/** Long clusters on narrow streets: a junction whose edges are all class 3 or below, with their ends spread past the limit. */
function longNarrowClusters(d) {
  const e = d.t.edges.col;
  const ends = Array.from({ length: d.t.juncs.n }, () => []);
  const narrow = new Uint8Array(d.t.juncs.n).fill(1);
  for (let i = 0; i < d.t.edges.n; i++) {
    const pts = edgePts(d, i);
    ends[e.a[i]].push(pts[0], pts[1]);
    ends[e.b[i]].push(pts[pts.length - 2], pts[pts.length - 1]);
    if (e.cls[i] < NARROW_CLASS) {
      narrow[e.a[i]] = 0;
      narrow[e.b[i]] = 0;
    }
  }
  const out = [];
  ends.forEach((p, k) => {
    if (!narrow[k]) return;
    let spread = 0;
    for (let i = 0; i < p.length; i += 2) for (let q = i + 2; q < p.length; q += 2) spread = Math.max(spread, Math.hypot(p[i] - p[q], p[i + 1] - p[q + 1]));
    if (spread > NARROW_SPREAD_DM) out.push({ j: k, m: Math.round(spread / 10) });
  });
  return out;
}

/** Kept roundabouts whose arcs reached the map as `ROUNDABOUT` edges, out of those the importer says it kept. */
function ringsKept(d, keptWays) {
  const e = d.t.edges.col;
  const arcs = new Map();
  for (let i = 0; i < d.t.edges.n; i++) if (e.flags[i] & ROUNDABOUT) arcs.set(e.osm[i], (arcs.get(e.osm[i]) || 0) + 1);
  return keptWays.filter((ways) => ways.some((w) => arcs.has(w))).length;
}

/** Street names that are only digits. */
function numericNames(d) {
  const e = d.t.edges.col;
  let n = 0;
  for (let i = 0; i < d.t.edges.n; i++) if (/^\d+$/.test(d.strings[e.nameEn[i]]) || /^\d+$/.test(d.strings[e.name[i]])) n++;
  return n;
}

/** Largest OSM id seen in the three `osm` columns. */
function maxOsm(d) {
  let m = 0;
  for (const t of ['edges', 'blds', 'pois']) for (const v of d.t[t].col.osm) if (v > m) m = v;
  return m;
}

/**
 * Pass 22: decodes the written map and runs every section 19 gate. Gates that state a figure about `tlv_center`, including
 * the SCC share and facade yield, apply only with `absolute`: a smaller box severs more one-way streets and may hold more
 * of the dense market blocks, so a sub-bbox measures lower and still imports with no code change. The structure, crossing
 * and collision gates apply to every area.
 * @param {object} TLV Runtime with `mapCodec`.
 * @param {string} file Path of the written `map.js`.
 * @param {object} pipeline Facts only the importer knows: `uniqueNodes`, `signalNodes`, `maxOsmId`, `kindergartens`,
 * `fenceLines`, `keptRings` (way ids per kept ring), `roofs`, `overlapAllow`, `hollowAllow`, `built` from `buildWorld`, and `curated`,
 * true when this run used the area's own overlays. The contact, dead end and collider gates judge hand work, so they bind only then.
 * @param {boolean} absolute Enforce the absolute counts.
 * @returns {{gates: object[], ok: boolean, failures: string[], detail: object, decoded: object}}
 */
export function verifyMap(TLV, file, pipeline, absolute) {
  const payload = readMapPayload(file);
  const bytes = fs.statSync(file).size;
  const d = TLV.mapCodec.decodeAll(payload);
  const structure = checkStructure(d);
  const net = networkFacts(d);
  const poi = poiFacts(d, pipeline.kindergartens);
  const idx = footprintIndex(d);
  const crossings = sameplaneCrossings(d);
  const wallHits = laneWallCrossings(d);
  const bldHits = laneBuildingHits(d, idx);
  const spots = countStalls(d, idx);
  const decodedMax = maxOsm(d);
  const edgeMisses = poiEdgeMisses(d);
  const buriedDoors = doorsInColliders(d, idx);
  const gapFences = fenceInGaps(d, pipeline.fenceLines || []);
  const built = pipeline.built || null;
  const overlaps = carriagewayOverlaps(d, pipeline.overlapAllow, built && built.world);
  const overlapsOpen = overlaps.filter((o) => !o.allowed);
  const contacts = built ? laneContacts(built.TLV, built.world, pipeline.overlapAllow) : [];
  const contactsOpen = contacts.filter((o) => !o.allowed);
  const deadEnds = majorDeadEnds(d);
  const hollow = hollowBuildingsOf(d, pipeline.roofs || new Set(), pipeline.hollowAllow || []);
  const longClusters = longNarrowClusters(d);
  const keptRings = pipeline.keptRings || [];
  const ringsOnMap = ringsKept(d, keptRings);
  const numeric = numericNames(d);

  const gates = [];
  const gate = (name, value, ok, want, always) => {
    gates.push({ name, value, want, enforced: !!(always || absolute), pass: !!ok });
  };
  const curatedGate = (name, value, ok, want) => {
    gates.push({ name, value, want, enforced: !!(absolute && pipeline.curated), pass: !!ok });
  };
  gate('Map structure problems', structure.length, structure.length === 0, '0', true);
  gate('Unique nodes after dedupe', pipeline.uniqueNodes, pipeline.uniqueNodes === 114284, '114,284');
  gate('Signal nodes retained', pipeline.signalNodes, pipeline.signalNodes >= 700, '>= 700');
  gate('SIGNAL junctions', net.signals, net.signals >= 300 && net.signals <= 520, '300 to 520');
  gate('Junction clusters with degree 3 or more', net.clusters, net.clusters >= 2000 && net.clusters <= 2700, '2,000 to 2,700');
  gate('Movements', d.t.moves.n, d.t.moves.n >= 9000, '>= 9,000');
  gate('Turn-level SCC share of lane-km', Number(net.share.toFixed(4)), net.share >= 0.9, '>= 0.90');
  gate('Same-plane crossings with no junction', crossings, crossings === 0, '0', true);
  gate('Lane centrelines crossing a walls row', wallHits.length, wallHits.length === 0, '0', true);
  gate('Lane centrelines crossing a collider building', bldHits.length, bldHits.length === 0, '0', true);
  gate('Buildings', d.t.blds.n, d.t.blds.n >= 14000, '>= 14,000');
  gate('Named POI facade yield', Number(poi.yield.toFixed(4)), poi.yield >= 0.9, '>= 0.90');
  gate('POIs whose edge is not nearest their door', edgeMisses.length, edgeMisses.length === 0, '0', true);
  gate('Facade doors inside a collider building', buriedDoors.length, buriedDoors.length === 0, '0', true);
  gate('Road crossings with fence inside their gap', gapFences.length, gapFences.length === 0, '0', true);
  gate('Sensitive POIs', poi.sensitive, poi.sensitive >= 150, '>= 150');
  gate('Sensitive POIs with amenity=kindergarten', poi.kindergarten, poi.kindergarten >= 14, '>= 14');
  gate('Kerb stalls at 6.5 m', spots.stalls, spots.stalls >= 50000, '>= 50,000');
  gate('osm column round-trip, max id', decodedMax, decodedMax === pipeline.maxOsmId, String(pipeline.maxOsmId), true);
  gate('map.js bytes', bytes, bytes <= MAX_MAP_BYTES, `<= ${MAX_MAP_BYTES}`, true);
  gate('Lane overlaps between carriageways, outside the allowlist', overlapsOpen.length, overlapsOpen.length === 0, '0', true);
  gate('Long clusters on narrow streets', longClusters.length, longClusters.length === 0, '0', true);
  const ringsWanted = absolute ? Math.max(keptRings.length, MIN_KEPT_RINGS) : keptRings.length;
  gate('Kept roundabouts with their arcs on the map', ringsOnMap, ringsOnMap === ringsWanted, String(ringsWanted), true);
  gate('Street names that are only digits', numeric, numeric === 0, '0', true);
  curatedGate('Lanes closer than a car on the built World, outside the allowlist', contactsOpen.length, contactsOpen.length === 0, '0');
  curatedGate('Dead ends on class 2 or better', deadEnds.length, deadEnds.length === 0, '0');
  curatedGate(`Buildings over ${HOLLOW_LIMIT_M2} m2 with no collider, outside the exceptions`, hollow.length, hollow.length === 0, '0');

  if (pipeline.failGate) gate('Forced failure', 1, false, '0', true);
  const failures = gates.filter((g) => g.enforced && !g.pass).map((g) => `${g.name}: ${g.value} (want ${g.want})`);
  return {
    gates,
    ok: failures.length === 0,
    failures,
    decoded: d,
    detail: {
      structure: structure.slice(0, 40),
      wallHits: wallHits.slice(0, 40),
      buildingHits: bldHits.slice(0, 40),
      poiEdgeMisses: edgeMisses.slice(0, 40),
      buriedDoors: buriedDoors.slice(0, 40),
      gapFences: gapFences.slice(0, 40),
      overlaps: overlaps.slice(0, 40),
      contacts: contacts.slice(0, 40),
      deadEnds: deadEnds.slice(0, 40),
      hollow: hollow.slice(0, 40),
      longClusters: longClusters.slice(0, 40),
      network: net,
      pois: poi,
      spots
    }
  };
}

/** Canonical key of a polyline step, and whether `a to b` runs along that canonical direction. */
function stepKey(ax, ay, bx, by) {
  const along = ax < bx || (ax === bx && ay <= by);
  return { key: along ? `${ax},${ay}>${bx},${by}` : `${bx},${by}>${ax},${ay}`, along };
}

/** Polyline and arc lengths of an edge, cached per decoded map. */
function geometry(d) {
  const cache = new Map();
  return (i) => {
    if (!cache.has(i)) {
      const pts = edgePts(d, i);
      cache.set(i, { pts, cum: cumulative(pts) });
    }
    return cache.get(i);
  };
}

/**
 * Rows keyed by OSM identity, as edges carry them. Contraction makes a label move when a way boundary opens, so these lists
 * say which labels moved, and `physicalRows` says what changed on the ground.
 */
function keyedRows(d) {
  const { strings: s, t } = d;
  const ways = new Map();
  const e = t.edges.col;
  for (let i = 0; i < t.edges.n; i++) {
    const row = [e.cls[i], e.lanesF[i], e.lanesB[i], e.kmh[i], e.laneW[i], e.parkL[i], e.parkR[i], e.swL[i], e.swR[i],
      e.flags[i], s[e.name[i]], s[e.nameEn[i]], edgePts(d, i).join(',')].join('|');
    const k = `w${e.osm[i]}`;
    if (!ways.has(k)) ways.set(k, []);
    ways.get(k).push(row);
  }
  for (const list of ways.values()) list.sort();
  const blds = new Map();
  const b = t.blds.col;
  const { pOff } = t.brings.col;
  const { x, y, front } = t.bpts.col;
  for (let i = 0; i < t.blds.n; i++) {
    const k = `${'nwr'[b.osmT[i]]}${b.osm[i]}`;
    const walls = [];
    for (let v = pOff[b.rOff[i]]; v < pOff[b.rOff[i + 1]]; v++) walls.push(x[v], y[v], front[v]);
    const row = [b.h[i], b.levels[i], b.kind[i], b.roof[i], s[b.colour[i]], s[b.style[i]], b.flags[i], s[b.name[i]], s[b.nameEn[i]],
      b.rOff[i + 1] - b.rOff[i], walls.join(',')].join('|');
    blds.set(k, blds.has(k) ? `${blds.get(k)}+${row}` : row);
  }
  const pois = new Map();
  const p = t.pois.col;
  for (let i = 0; i < t.pois.n; i++) {
    const k = `${'nwr'[p.osmT[i]]}${p.osm[i]}`;
    const host = p.bld[i] ? `${'nwr'[b.osmT[p.bld[i] - 1]]}${b.osm[p.bld[i] - 1]}` : '';
    pois.set(k, [p.x[i], p.y[i], s[p.kind[i]], s[p.nameHe[i]], s[p.nameEn[i]], host, p.wall[i], p.t[i], p.w[i], p.entX[i], p.entY[i], p.flags[i]].join('|'));
  }
  return { ways, blds, pois };
}

/** Cross-section of every polyline step, in the step's own direction, whichever edge holds it and however it is digitized. */
function stepRows(d) {
  const { strings: s } = d;
  const e = d.t.edges.col;
  const out = new Map();
  for (let i = 0; i < d.t.edges.n; i++) {
    const pts = edgePts(d, i);
    const f = e.flags[i];
    const fixed = f & ~(EF_AI_F | EF_AI_B);
    for (let k = 2; k < pts.length; k += 2) {
      const { key, along } = stepKey(pts[k - 2], pts[k - 1], pts[k], pts[k + 1]);
      const pick = (fwd, back) => (along ? `${fwd}|${back}` : `${back}|${fwd}`);
      const row = [e.cls[i], pick(e.lanesF[i], e.lanesB[i]), e.kmh[i], e.laneW[i], pick(e.parkL[i], e.parkR[i]), pick(e.swL[i], e.swR[i]),
        fixed, pick(f & EF_AI_F ? 1 : 0, f & EF_AI_B ? 1 : 0), s[e.name[i]], s[e.nameEn[i]]].join('|');
      out.set(key, { row: out.has(key) ? `${out.get(key).row}+${row}` : row, way: `w${e.osm[i]}` });
    }
  }
  return out;
}

/** Kerb rows laid onto polyline steps, per step and side, so an edge that splits or flips compares equal. */
function kerbRows(d) {
  const k = d.t.kerbs.col;
  const geom = geometry(d);
  const lists = new Map();
  for (let r = 0; r < d.t.kerbs.n; r++) {
    const i = k.edge[r];
    const { pts, cum } = geom(i);
    const attrs = `${k.tier[r]}|${k.paint[r]}|${d.strings[k.zone[r]]}|${k.form[r]}`;
    for (let j = 1; j < cum.length; j++) {
      const a = Math.max(k.s0[r], cum[j - 1]) - cum[j - 1];
      const b = Math.min(k.s1[r], cum[j]) - cum[j - 1];
      if (b <= a) continue;
      const { key, along } = stepKey(pts[2 * j - 2], pts[2 * j - 1], pts[2 * j], pts[2 * j + 1]);
      const len = cum[j] - cum[j - 1];
      const side = along ? k.side[r] : 1 - k.side[r];
      const id = `${key}:${side}`;
      if (!lists.has(id)) lists.set(id, { spans: [], way: `w${d.t.edges.col.osm[i]}` });
      lists.get(id).spans.push(along ? { a, b, attrs } : { a: len - b, b: len - a, attrs });
    }
  }
  for (const v of lists.values()) {
    v.spans.sort((p, q) => p.a - q.a);
    v.spans = v.spans.reduce((out, q) => {
      const last = out[out.length - 1];
      if (last && last.attrs === q.attrs) last.b = q.b;
      else out.push({ ...q });
      return out;
    }, []);
  }
  return lists;
}

/** First and last step of a directed edge, in travel order. */
function endSteps(pts, de) {
  const n = pts.length;
  const seq = de & 1 ? [pts[n - 2], pts[n - 1], pts[n - 4], pts[n - 3], pts[2], pts[3], pts[0], pts[1]] : [pts[0], pts[1], pts[2], pts[3], pts[n - 4], pts[n - 3], pts[n - 2], pts[n - 1]];
  return { first: seq.slice(0, 4).join(','), last: seq.slice(4).join(',') };
}

/** Junctions by position, and turns by the steps either side of the junction, so a renumbered row compares equal. */
function networkRows(d) {
  const { x, y, kind, flags } = d.t.juncs.col;
  const geom = geometry(d);
  const juncs = new Map();
  for (let i = 0; i < d.t.juncs.n; i++) juncs.set(`${x[i]},${y[i]}`, `${kind[i]}|${flags[i]}`);
  const moves = new Map();
  const m = d.t.moves.col;
  for (let i = 0; i < d.t.moves.n; i++) {
    const from = endSteps(geom(m.from[i] >> 1).pts, m.from[i]);
    const to = endSteps(geom(m.to[i] >> 1).pts, m.to[i]);
    moves.set(`${from.last}>${to.first}`, m.turn[i]);
  }
  return { juncs, moves };
}

/** Bus stops and crossings by their own node, with the road point they bind to and the way traffic runs past a stop. */
function placedRows(d) {
  const geom = geometry(d);
  const at = (edge, s) => {
    const { pts, cum } = geom(edge);
    return pointAt(pts, cum, s);
  };
  const stops = new Map();
  const st = d.t.stops.col;
  for (let i = 0; i < d.t.stops.n; i++) {
    const p = at(st.edge[i], st.s[i]);
    const sign = st.dir[i] ? -1 : 1;
    stops.set(`${st.x[i]},${st.y[i]}`, { x: p.x, y: p.y, ux: p.dx * sign, uy: p.dy * sign, name: d.strings[st.name[i]] });
  }
  const xings = new Map();
  const c = d.t.xings.col;
  for (let i = 0; i < d.t.xings.n; i++) {
    const p = at(c.edge[i], c.s[i]);
    xings.set(`${c.x[i]},${c.y[i]}`, { x: p.x, y: p.y, signal: c.flags[i] });
  }
  return { stops, xings };
}

/** Rows of `walls`, keyed by their whole outline. */
function wallRows(d) {
  const w = d.t.walls.col;
  const { x, y } = d.t.wallPts.col;
  const out = new Map();
  for (let i = 0; i < d.t.walls.n; i++) {
    const pts = [];
    for (let k = w.pOff[i]; k < w.pOff[i + 1]; k++) pts.push(x[k], y[k]);
    out.set(`${w.kind[i]}:${pts.join(',')}`, true);
  }
  return out;
}

/** Tables no road overlay should reach, compared whole. A `name` column is compared as text: string ids shift between runs. */
function otherTables(prev, next) {
  const cell = (d, c, v) => (c === 'name' ? d.strings[v] : v);
  return DIFF_OTHER_TABLES.filter((name) => {
    const a = prev.t[name];
    const b = next.t[name];
    if (!a || !b || a.n !== b.n) return true;
    return Object.keys(a.col).some((c) => !b.col[c] || a.col[c].length !== b.col[c].length ||
      a.col[c].some((v, i) => cell(prev, c, v) !== cell(next, c, b.col[c][i])));
  });
}

const near = (a, b) => Math.abs(a - b) <= DIFF_ROUND_DM;

/**
 * True when two kerb lists agree along a step. Row boundaries are rounded along their own edge, so a boundary can shift by a
 * decimetre, or leave a sliver either side of a vertex, when an edge splits. Only a real stretch of disagreement counts.
 */
function sameSpans(p, q) {
  const cuts = [...new Set([...p.spans, ...q.spans].flatMap((s) => [s.a, s.b]))].sort((a, b) => a - b);
  const attrsAt = (list, m) => (list.find((s) => m >= s.a && m <= s.b) || {}).attrs;
  let differ = 0;
  for (let i = 1; i < cuts.length; i++) {
    const m = (cuts[i - 1] + cuts[i]) / 2;
    if (attrsAt(p.spans, m) !== attrsAt(q.spans, m)) differ += cuts[i] - cuts[i - 1];
  }
  return differ <= KERB_SLACK_DM;
}

const sameStop = (p, q) => near(p.x, q.x) && near(p.y, q.y) && p.name === q.name && p.ux * q.ux + p.uy * q.uy > 0;
const sameXing = (p, q) => near(p.x, q.x) && near(p.y, q.y) && p.signal === q.signal;
const sameStep = (p, q) => p.row === q.row;

/** Rows added, removed and changed between two keyed maps. `same` overrides exact comparison. */
function diffKeyed(prev, next, same) {
  const added = [];
  const removed = [];
  const changed = [];
  for (const k of next.keys()) if (!prev.has(k)) added.push(k);
  for (const k of prev.keys()) if (!next.has(k)) removed.push(k);
  for (const [k, v] of next) {
    if (!prev.has(k)) continue;
    if (same ? !same(prev.get(k), v) : JSON.stringify(prev.get(k)) !== JSON.stringify(v)) changed.push(k);
  }
  return { added: added.sort(), removed: removed.sort(), changed: changed.sort() };
}

/** Way labels of the steps in a diff: the new label where the step still exists, else the old one. */
function touchedWays(diff, prev, next, out) {
  for (const k of [...diff.added, ...diff.changed]) out.add(next.get(k).way);
  for (const k of diff.removed) out.add(prev.get(k).way);
}

/** Counts per value of a column, labelled. */
function histogram(a, label) {
  const out = {};
  for (const v of a) {
    const k = label(v);
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

/** Class sizes that `diff.json` watches. */
function classCounts(d) {
  const roadClass = ['primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service'];
  const out = {};
  for (const [name, table] of Object.entries(d.t)) out[`table.${name}`] = table.n;
  const add = (prefix, h) => {
    for (const [k, v] of Object.entries(h)) out[`${prefix}.${k}`] = v;
  };
  add('edges.cls', histogram(d.t.edges.col.cls, (v) => roadClass[v]));
  add('juncs.kind', histogram(d.t.juncs.col.kind, (v) => ['PASS', 'PRIORITY', 'SIGNAL', 'RING'][v]));
  add('blds.kind', histogram(d.t.blds.col.kind, (v) => String(v)));
  add('pois.kind', histogram(d.t.pois.col.kind, (v) => d.strings[v]));
  add('kerbs.tier', histogram(d.t.kerbs.col.tier, (v) => String(v)));
  add('land.cls', histogram(d.t.land.col.cls, (v) => String(v)));
  return out;
}

/**
 * Pass 23, `diff.json`: compares this run to the previous one and flags a class that moved by more than 5%. `rows.ways`
 * lists edge labels that moved. Everything else is keyed by what is on the ground, so `rows.touched`, the ways holding a step
 * or a kerb that really changed, does not name a contraction partner that only got its own row back.
 * @param {object|null} prev Decoded previous map, or null on a first run.
 * @param {object} next Decoded new map.
 * @returns {object}
 */
export function diffMaps(prev, next) {
  if (!prev) return { firstRun: true, flagged: [], classes: {}, rows: null };
  const a = classCounts(prev);
  const b = classCounts(next);
  const classes = {};
  const flagged = [];
  for (const k of [...new Set([...Object.keys(a), ...Object.keys(b)])].sort()) {
    const before = a[k] || 0;
    const after = b[k] || 0;
    if (before === after) continue;
    const pct = before ? ((after - before) / before) * 100 : 100;
    classes[k] = { prev: before, next: after, pct: Number(pct.toFixed(2)) };
    if (Math.abs(pct) > DIFF_FLAG_PCT) flagged.push(k);
  }
  const ra = keyedRows(prev);
  const rb = keyedRows(next);
  const sa = stepRows(prev);
  const sb = stepRows(next);
  const ka = kerbRows(prev);
  const kb = kerbRows(next);
  const na = networkRows(prev);
  const nb = networkRows(next);
  const pa = placedRows(prev);
  const pb = placedRows(next);
  const pts = diffKeyed(sa, sb, sameStep);
  const kerbs = diffKeyed(ka, kb, sameSpans);
  const touched = new Set();
  touchedWays(pts, sa, sb, touched);
  touchedWays(kerbs, ka, kb, touched);
  return {
    firstRun: false,
    flagged,
    classes,
    rows: {
      ways: diffKeyed(ra.ways, rb.ways),
      touched: [...touched].sort(),
      pts,
      kerbs,
      buildings: diffKeyed(ra.blds, rb.blds),
      pois: diffKeyed(ra.pois, rb.pois),
      juncs: diffKeyed(na.juncs, nb.juncs),
      moves: diffKeyed(na.moves, nb.moves),
      stops: diffKeyed(pa.stops, pb.stops, sameStop),
      xings: diffKeyed(pa.xings, pb.xings, sameXing),
      walls: diffKeyed(wallRows(prev), wallRows(next)),
      other: otherTables(prev, next)
    }
  };
}

/**
 * Writes `stats.json`, `orphans.json` and `diff.json`. Nothing here holds a wall-clock time, so reports also repeat exactly
 * for identical input.
 * @param {string} dir `tools/reports/<id>`.
 * @param {object} stats Statistics.
 * @param {object[]} orphans Overlay anchors that did not resolve exactly.
 * @param {object} diff From `diffMaps`.
 */
export function writeReports(dir, stats, orphans, diff) {
  fs.mkdirSync(dir, { recursive: true });
  const put = (name, v) => fs.writeFileSync(path.join(dir, name), `${JSON.stringify(v, null, 2)}\n`);
  put('stats.json', stats);
  put('orphans.json', orphans);
  put('diff.json', diff);
}
