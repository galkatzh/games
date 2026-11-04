#!/usr/bin/env node
// tools/make_fixture.mjs — WP-MAP
// Writes tests/fixtures/mini_map.js, the hand-checkable map in ARCHITECTURE section 7.5. Every column uses the `raw`
// encoding, so a failing test can read the fixture directly.
//
// Row order, for tests that need ids:
//   juncs   row-major from the south-west: id = ix + 3 * iy, with ix, iy in 0..2 for x, y in -200, 0, 200.
//   edges   east-west first, south to north then west to east (0-5), then north-south, west to east then south to north (6-11).
//   blds    south-west, south-east, north-west, north-east.
//   pois    same order as blds.
//   walls   south, east, north, west.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { enc, mapScript } from './lib/encode.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'tests/fixtures/mini_map.js');

const DM = 10;
const COORDS = [-200, 0, 200];
const ORIGIN = [32.075, 34.7775];
const BOUNDS_M = [-400, -400, 400, 400];
const M_PER_DEG_LON = 94415;
const M_PER_DEG_LAT = 110888;

const KIND_PRIORITY = 1;
const KIND_SIGNAL = 2;
const KIND_RING = 3;
const EF_AI_F = 8;
const EF_AI_B = 16;
const POIF_SENSITIVE = 4;
const CLS_TERTIARY = 2;
const CLS_RESIDENTIAL = 4;
const TURN_STRAIGHT = 0;
const TURN_RIGHT = 1;
const TURN_LEFT = 2;
const TIER_NONE = 255;
const TIER_ZONE = 2;
const OSM_NODE = 0;
const OSM_WAY = 1;
const EDGE_OSM_BASE = 1000;
const BUILDING_OSM_BASE = 2000;
const POI_OSM_BASE = 3000;
const SIGN_T_MIDDLE = 128;

/** Junction id at a coordinate pair. */
const juncId = (x, y) => COORDS.indexOf(x) + 3 * COORDS.indexOf(y);

/** The nine junctions. */
function makeJuncs() {
  const rows = [];
  for (const y of COORDS) {
    for (const x of COORDS) {
      let kind = KIND_PRIORITY;
      if (x === 0 && y === 0) kind = KIND_SIGNAL;
      if (x === 200 && y === 200) kind = KIND_RING;
      rows.push({ x: x * DM, y: y * DM, kind, flags: 0 });
    }
  }
  return rows;
}

/** The 12 straight edges. `a` is always the west or south end. */
function makeEdges() {
  const rows = [];
  const add = (ax, ay, bx, by) => {
    const middle = ay === 0 && by === 0;
    rows.push({
      a: juncId(ax, ay),
      b: juncId(bx, by),
      pts: [ax * DM, ay * DM, bx * DM, by * DM],
      cls: middle ? CLS_TERTIARY : CLS_RESIDENTIAL,
      lanesF: middle ? 2 : 1,
      lanesB: middle ? 0 : 1,
      kmh: middle ? 50 : 30,
      flags: middle ? EF_AI_F : EF_AI_F | EF_AI_B
    });
  };
  for (const y of COORDS) for (let i = 0; i < 2; i++) add(COORDS[i], y, COORDS[i + 1], y);
  for (const x of COORDS) for (let i = 0; i < 2; i++) add(x, COORDS[i], x, COORDS[i + 1]);
  return rows;
}

/** Every incoming arm to every other outgoing arm, sorted by `from`, then `to`. */
function makeMoves(edges) {
  const head = (e) => Math.atan2(e.pts[3] - e.pts[1], e.pts[2] - e.pts[0]);
  const directed = [];
  edges.forEach((e, i) => {
    directed.push({ de: i * 2, from: e.a, to: e.b, h: head(e) });
    if (e.lanesB > 0) directed.push({ de: i * 2 + 1, from: e.b, to: e.a, h: head(e) + Math.PI });
  });
  const rows = [];
  for (const inc of directed) {
    for (const out of directed) {
      if (out.from !== inc.to || (out.de >> 1) === (inc.de >> 1)) continue;
      const d = Math.atan2(Math.sin(out.h - inc.h), Math.cos(out.h - inc.h));
      let turn = TURN_STRAIGHT;
      if (d > 0.5) turn = TURN_LEFT;
      else if (d < -0.5) turn = TURN_RIGHT;
      rows.push({ from: inc.de, to: out.de, turn });
    }
  }
  return rows.sort((p, q) => p.from - q.from || p.to - q.to);
}

/** Five rows per edge side, section 7.5. */
function makeKerbs(edgeCount) {
  const spans = [[0, 12, TIER_NONE], [12, 95, TIER_ZONE], [95, 105, TIER_NONE], [105, 188, TIER_ZONE], [188, 200, TIER_NONE]];
  const rows = [];
  for (let edge = 0; edge < edgeCount; edge++) {
    for (const side of [0, 1]) {
      for (const [s0, s1, tier] of spans) rows.push({ edge, side, s0: s0 * DM, s1: s1 * DM, tier });
    }
  }
  return rows;
}

/** Blocks in building order, with what stands on the south wall of each. */
const BLOCKS = [
  { cx: -100, cy: -100, kind: 'pharmacy', flags: 0 },
  { cx: 100, cy: -100, kind: 'bakery', flags: 0 },
  { cx: -100, cy: 100, kind: 'supermarket', flags: 0 },
  { cx: 100, cy: 100, kind: 'school', flags: POIF_SENSITIVE }
];

/** Id of the east-west edge running along a block's south side. */
function southEdge(block) {
  const row = COORDS.indexOf(block.cy - 100);
  const col = block.cx < 0 ? 0 : 1;
  return row * 2 + col;
}

/** Builds the payload. */
function buildPayload() {
  const strings = ['', 'pharmacy', 'bakery', 'supermarket', 'school'];
  const str = (s) => strings.indexOf(s);
  const juncs = makeJuncs();
  const edges = makeEdges();
  const moves = makeMoves(edges);
  const kerbs = makeKerbs(edges.length);
  const raw = enc.raw;
  const col = (rows, f) => raw(rows.map(f));
  const zeros = (n) => raw(new Array(n).fill(0));

  const bpts = [];
  for (const { cx, cy } of BLOCKS) {
    for (const [dx, dy] of [[-20, -20], [20, -20], [20, 20], [-20, 20]]) bpts.push({ x: (cx + dx) * DM, y: (cy + dy) * DM });
  }
  const xings = edges.map((e, edge) => ({ x: (e.pts[0] + e.pts[2]) / 2, y: (e.pts[1] + e.pts[3]) / 2, edge }));
  const [minX, minY, maxX, maxY] = BOUNDS_M;
  const wallLines = [[minX, minY, maxX, minY], [maxX, minY, maxX, maxY], [maxX, maxY, minX, maxY], [minX, maxY, minX, minY]];
  const nP = edges.length * 2;
  const nW = wallLines.length;

  const tables = {
    juncs: { n: juncs.length, cols: { x: col(juncs, (r) => r.x), y: col(juncs, (r) => r.y), kind: col(juncs, (r) => r.kind), flags: col(juncs, (r) => r.flags) } },
    edges: {
      n: edges.length,
      cols: {
        a: col(edges, (r) => r.a),
        b: col(edges, (r) => r.b),
        ptOff: raw(Array.from({ length: edges.length + 1 }, (_, i) => i * 2)),
        cls: col(edges, (r) => r.cls),
        lanesF: col(edges, (r) => r.lanesF),
        lanesB: col(edges, (r) => r.lanesB),
        kmh: col(edges, (r) => r.kmh),
        laneW: col(edges, () => 30),
        parkL: col(edges, () => 24),
        parkR: col(edges, () => 24),
        swL: col(edges, () => 25),
        swR: col(edges, () => 25),
        flags: col(edges, (r) => r.flags),
        name: zeros(edges.length),
        nameEn: zeros(edges.length),
        osm: col(edges, (r, i) => EDGE_OSM_BASE + i)
      }
    },
    pts: {
      n: nP,
      cols: {
        x: raw(edges.flatMap((e) => [e.pts[0], e.pts[2]])),
        y: raw(edges.flatMap((e) => [e.pts[1], e.pts[3]]))
      }
    },
    moves: { n: moves.length, cols: { from: col(moves, (r) => r.from), to: col(moves, (r) => r.to), turn: col(moves, (r) => r.turn) } },
    blds: {
      n: BLOCKS.length,
      cols: {
        rOff: raw([0, 1, 2, 3, 4]),
        h: col(BLOCKS, () => 150),
        levels: zeros(BLOCKS.length),
        kind: col(BLOCKS, () => 1),
        roof: zeros(BLOCKS.length),
        colour: zeros(BLOCKS.length),
        style: zeros(BLOCKS.length),
        flags: zeros(BLOCKS.length),
        name: zeros(BLOCKS.length),
        nameEn: zeros(BLOCKS.length),
        osm: col(BLOCKS, (r, i) => BUILDING_OSM_BASE + i),
        osmT: col(BLOCKS, () => OSM_WAY)
      }
    },
    brings: { n: BLOCKS.length, cols: { pOff: raw([0, 4, 8, 12, 16]) } },
    bpts: { n: bpts.length, cols: { x: col(bpts, (r) => r.x), y: col(bpts, (r) => r.y), front: zeros(bpts.length) } },
    pois: {
      n: BLOCKS.length,
      cols: {
        x: col(BLOCKS, (r) => r.cx * DM),
        y: col(BLOCKS, (r) => (r.cy - 20) * DM),
        kind: col(BLOCKS, (r) => str(r.kind)),
        nameHe: zeros(BLOCKS.length),
        nameEn: zeros(BLOCKS.length),
        osm: col(BLOCKS, (r, i) => POI_OSM_BASE + i),
        osmT: col(BLOCKS, () => OSM_NODE),
        bld: col(BLOCKS, (r, i) => i + 1),
        wall: col(BLOCKS, () => 1),
        t: col(BLOCKS, () => SIGN_T_MIDDLE),
        w: col(BLOCKS, () => 60),
        entX: col(BLOCKS, (r) => r.cx * DM),
        entY: col(BLOCKS, (r) => (r.cy - 20.5) * DM),
        edge: col(BLOCKS, (r) => southEdge(r) + 1),
        flags: col(BLOCKS, (r) => r.flags)
      }
    },
    kerbs: {
      n: kerbs.length,
      cols: {
        edge: col(kerbs, (r) => r.edge),
        side: col(kerbs, (r) => r.side),
        s0: col(kerbs, (r) => r.s0),
        s1: col(kerbs, (r) => r.s1),
        form: zeros(kerbs.length),
        paint: zeros(kerbs.length),
        zone: zeros(kerbs.length),
        tier: col(kerbs, (r) => r.tier)
      }
    },
    xings: {
      n: xings.length,
      cols: {
        x: col(xings, (r) => r.x),
        y: col(xings, (r) => r.y),
        edge: col(xings, (r) => r.edge),
        s: col(xings, () => 1000),
        flags: zeros(xings.length)
      }
    },
    stops: { n: 1, cols: { x: raw([-1000]), y: raw([-2000]), edge: raw([0]), dir: raw([0]), s: raw([1000]), name: raw([0]) } },
    trees: { n: 0, cols: { x: raw([]), y: raw([]), species: raw([]) } },
    lots: { n: 0, cols: { pOff: raw([0]), kind: raw([]), entX: raw([]), entY: raw([]), name: raw([]) } },
    lotPts: { n: 0, cols: { x: raw([]), y: raw([]) } },
    land: { n: 0, cols: { pOff: raw([0]), cls: raw([]) } },
    landPts: { n: 0, cols: { x: raw([]), y: raw([]) } },
    paths: { n: 0, cols: { pOff: raw([0]), cls: raw([]), name: raw([]) } },
    pathPts: { n: 0, cols: { x: raw([]), y: raw([]) } },
    walls: { n: nW, cols: { pOff: raw([0, 2, 4, 6, 8]), kind: zeros(nW) } },
    wallPts: {
      n: nW * 2,
      cols: {
        x: raw(wallLines.flatMap((w) => [w[0] * DM, w[2] * DM])),
        y: raw(wallLines.flatMap((w) => [w[1] * DM, w[3] * DM]))
      }
    }
  };

  const lat = (y) => Number((y / M_PER_DEG_LAT + ORIGIN[0]).toFixed(7));
  const lon = (x) => Number((x / M_PER_DEG_LON + ORIGIN[1]).toFixed(7));
  return {
    schema: [1, 0],
    id: 'mini',
    meta: {
      title: { he: 'מיני', en: 'Mini' },
      origin: ORIGIN,
      unit: 0.1,
      bbox: [lat(minY), lon(minX), lat(maxY), lon(maxX)],
      bounds: BOUNDS_M,
      osmTime: '2026-11-01T00:00:00Z',
      importer: '1.0.0',
      overlayHash: '',
      license: 'ODbL-1.0',
      attribution: '© OpenStreetMap contributors'
    },
    strings,
    tables
  };
}

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, mapScript(buildPayload()));
console.log(`Wrote ${path.relative(ROOT, OUT)}`);
