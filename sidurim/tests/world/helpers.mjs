// tests/world/helpers.mjs — WP-WORLD test support.
import { createTLV, createSim } from '../../tools/lib/classic.mjs';

/** The single command that enforces the wall-clock budgets of ARCHITECTURE 18: serially, so nothing competes with them. */
export const PERF_COMMAND = "TLV_PERF=1 node --test --test-concurrency=1 'tests/world/*.test.mjs'";

/**
 * Options for a test that asserts on wall-clock time. Such a test measures the machine as well as the code, and in a parallel
 * run it competes with its siblings, so the default run leaves it out and only TLV_PERF=1 turns it on.
 */
export const perfOnly = { skip: process.env.TLV_PERF === '1' ? false : `wall-clock budget, enforced by: ${PERF_COMMAND}` };

/** The world files of this package plus core, with no other package. */
export const FILES = ['sim'];

/** A TLV with the mini fixture drained. */
export function miniTLV() {
  return createTLV({ files: FILES, map: 'tests/fixtures/mini_map.js' });
}

/** A TLV with the real map drained. */
export function realTLV() {
  return createTLV({ files: FILES, map: 'tlv_center' });
}

/** A sim on a world, with every other package absent. */
export function simOn(TLV, W, seed = 1) {
  return createSim(TLV, { world: W, seed, allowMissing: true });
}

/** Mulberry32, so test sampling never depends on Math.random. */
export function sampler(seed) {
  let s = seed | 0;
  return () => {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), s | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const raw = (a) => ['raw', a];

/** Default columns of a table, zero filled. */
function table(n, cols) {
  const out = {};
  for (const [name, values] of Object.entries(cols)) out[name] = raw(values);
  return { n, cols: out };
}

/**
 * Builds a schema 1.0 payload from plain rows, in metres, for small hand-made maps.
 * @param {object} spec { id, bounds, juncs: [{x,y,kind,flags}], edges: [{a,b,pts:[[x,y]...],lanesF,lanesB,...}], moves: [[from,to,turn]],
 *   land: [{cls, poly}], walls, blds: [{ring:[[x,y]...]}], xings, stops, kerbs, pois }
 * @returns {object} Map payload.
 */
export function craftMap(spec) {
  const dm = (v) => Math.round(v * 10);
  const juncs = spec.juncs || [];
  const edges = spec.edges || [];
  const ptX = [];
  const ptY = [];
  const ptOff = [0];
  for (const e of edges) {
    const pts = e.pts || [[juncs[e.a].x, juncs[e.a].y], [juncs[e.b].x, juncs[e.b].y]];
    for (const [x, y] of pts) {
      ptX.push(dm(x));
      ptY.push(dm(y));
    }
    ptOff.push(ptX.length);
  }
  const col = (rows, f) => rows.map(f);
  const moves = spec.moves || [];
  const blds = spec.blds || [];
  const rOff = [0];
  const pOff = [0];
  const bx = [];
  const by = [];
  for (const b of blds) {
    for (const ring of [b.ring, ...(b.holes || [])]) {
      for (const [x, y] of ring) {
        bx.push(dm(x));
        by.push(dm(y));
      }
      pOff.push(bx.length);
    }
    rOff.push(pOff.length - 1);
  }
  const land = spec.land || [];
  const landOff = [0];
  const landX = [];
  const landY = [];
  for (const l of land) {
    for (const [x, y] of l.poly) {
      landX.push(dm(x));
      landY.push(dm(y));
    }
    landOff.push(landX.length);
  }
  const paths = spec.paths || [];
  const pathOff = [0];
  const pathX = [];
  const pathY = [];
  for (const l of paths) {
    for (const [x, y] of l.pts) {
      pathX.push(dm(x));
      pathY.push(dm(y));
    }
    pathOff.push(pathX.length);
  }
  const walls = spec.walls || [];
  const wallOff = [0];
  const wallX = [];
  const wallY = [];
  for (const w of walls) {
    for (const [x, y] of w.pts) {
      wallX.push(dm(x));
      wallY.push(dm(y));
    }
    wallOff.push(wallX.length);
  }
  const xings = spec.xings || [];
  const stops = spec.stops || [];
  const kerbs = spec.kerbs || [];
  const pois = spec.pois || [];
  const trees = spec.trees || [];
  const b = spec.bounds || [-500, -500, 500, 500];
  return {
    schema: spec.schema || [1, 0],
    id: spec.id || 'crafted',
    meta: { title: { he: '', en: '' }, origin: [32.075, 34.7775], unit: 0.1, bbox: [0, 0, 0, 0], bounds: b },
    strings: ['', 'pharmacy', 'Road'],
    tables: {
      juncs: table(juncs.length, {
        x: col(juncs, (j) => dm(j.x)), y: col(juncs, (j) => dm(j.y)), kind: col(juncs, (j) => j.kind || 0), flags: col(juncs, (j) => j.flags || 0)
      }),
      edges: table(edges.length, {
        a: col(edges, (e) => e.a), b: col(edges, (e) => e.b), ptOff, cls: col(edges, (e) => (e.cls === undefined ? 4 : e.cls)),
        lanesF: col(edges, (e) => (e.lanesF === undefined ? 1 : e.lanesF)), lanesB: col(edges, (e) => (e.lanesB === undefined ? 1 : e.lanesB)),
        kmh: col(edges, (e) => e.kmh || 30), laneW: col(edges, (e) => dm(e.laneW || 3)),
        parkL: col(edges, (e) => dm(e.parkL || 0)), parkR: col(edges, (e) => dm(e.parkR || 0)),
        swL: col(edges, (e) => dm(e.swL === undefined ? 2 : e.swL)), swR: col(edges, (e) => dm(e.swR === undefined ? 2 : e.swR)),
        flags: col(edges, (e) => (e.flags === undefined ? 24 : e.flags)), name: col(edges, () => 2), nameEn: col(edges, () => 2), osm: col(edges, (_, i) => i + 1)
      }),
      pts: table(ptX.length, { x: ptX, y: ptY }),
      moves: table(moves.length, { from: col(moves, (m) => m[0]), to: col(moves, (m) => m[1]), turn: col(moves, (m) => m[2] || 0) }),
      blds: table(blds.length, {
        rOff, h: col(blds, () => 100), levels: col(blds, () => 3), kind: col(blds, () => 0), roof: col(blds, () => 0), colour: col(blds, () => 0), style: col(blds, () => 0),
        flags: col(blds, (x) => x.flags || 0), name: col(blds, () => 0), nameEn: col(blds, () => 0), osm: col(blds, (_, i) => i + 1), osmT: col(blds, () => 1)
      }),
      brings: table(pOff.length - 1, { pOff }),
      bpts: table(bx.length, { x: bx, y: by, front: bx.map(() => 0) }),
      pois: table(pois.length, {
        x: col(pois, (p) => dm(p.x)), y: col(pois, (p) => dm(p.y)), kind: col(pois, () => 1), nameHe: col(pois, () => 0), nameEn: col(pois, () => 0), osm: col(pois, (_, i) => i + 1),
        osmT: col(pois, () => 0), bld: col(pois, () => 0), wall: col(pois, () => 0), t: col(pois, () => 0), w: col(pois, () => 0), entX: col(pois, (p) => dm(p.x)), entY: col(pois, (p) => dm(p.y)),
        edge: col(pois, (p) => (p.edge === undefined ? 0 : p.edge + 1)), flags: col(pois, (p) => p.flags || 0)
      }),
      kerbs: table(kerbs.length, {
        edge: col(kerbs, (k) => k.edge), side: col(kerbs, (k) => k.side), s0: col(kerbs, (k) => dm(k.s0)), s1: col(kerbs, (k) => dm(k.s1)), form: col(kerbs, () => 0),
        paint: col(kerbs, (k) => k.paint || 0), zone: col(kerbs, () => 0), tier: col(kerbs, (k) => (k.tier === undefined ? 2 : k.tier))
      }),
      xings: table(xings.length, { x: col(xings, (x) => dm(x.x)), y: col(xings, (x) => dm(x.y)), edge: col(xings, (x) => x.edge), s: col(xings, (x) => dm(x.s)), flags: col(xings, (x) => x.flags || 0) }),
      stops: table(stops.length, { x: col(stops, (s) => dm(s.x)), y: col(stops, (s) => dm(s.y)), edge: col(stops, (s) => s.edge), dir: col(stops, (s) => s.dir || 0), s: col(stops, (s) => dm(s.s)), name: col(stops, () => 0) }),
      trees: table(trees.length, { x: col(trees, (t) => dm(t.x)), y: col(trees, (t) => dm(t.y)), species: col(trees, (t) => t.species || 0) }),
      lots: table(0, { pOff: [0], kind: [], entX: [], entY: [], name: [] }),
      lotPts: table(0, { x: [], y: [] }),
      land: table(land.length, { pOff: landOff, cls: col(land, (l) => l.cls) }),
      landPts: table(landX.length, { x: landX, y: landY }),
      paths: table(paths.length, { pOff: pathOff, cls: col(paths, (l) => l.cls || 0), name: col(paths, () => 0) }),
      pathPts: table(pathX.length, { x: pathX, y: pathY }),
      walls: table(walls.length, { pOff: wallOff, kind: col(walls, (w) => w.kind || 0) }),
      wallPts: table(wallX.length, { x: wallX, y: wallY })
    }
  };
}

/** A straight east-west two-way road over [x0, x1] at y, between two PRIORITY junctions. */
export function straightRoad(extra = {}) {
  return craftMap({
    juncs: [{ x: -100, y: 0, kind: 1 }, { x: 100, y: 0, kind: 1 }],
    edges: [{ a: 0, b: 1, ...extra }]
  });
}

/**
 * Strongly connected components, iterative, so a long road cannot overflow the stack.
 * @param {number[][]} adj Neighbours by node.
 * @returns {{comp: Int32Array, count: number}}
 */
export function stronglyConnected(adj) {
  const n = adj.length;
  const index = new Int32Array(n).fill(-1);
  const low = new Int32Array(n);
  const onStack = new Uint8Array(n);
  const comp = new Int32Array(n).fill(-1);
  const stack = [];
  let next = 0;
  let count = 0;
  for (let root = 0; root < n; root++) {
    if (index[root] >= 0) continue;
    const calls = [[root, 0]];
    index[root] = low[root] = next++;
    stack.push(root);
    onStack[root] = 1;
    while (calls.length) {
      const top = calls[calls.length - 1];
      const v = top[0];
      if (top[1] < adj[v].length) {
        const w = adj[v][top[1]++];
        if (index[w] < 0) {
          index[w] = low[w] = next++;
          stack.push(w);
          onStack[w] = 1;
          calls.push([w, 0]);
        } else if (onStack[w]) {
          low[v] = Math.min(low[v], index[w]);
        }
        continue;
      }
      if (low[v] === index[v]) {
        for (;;) {
          const w = stack.pop();
          onStack[w] = 0;
          comp[w] = count;
          if (w === v) break;
        }
        count++;
      }
      calls.pop();
      if (calls.length) {
        const u = calls[calls.length - 1][0];
        low[u] = Math.min(low[u], low[v]);
      }
    }
  }
  return { comp, count };
}

/**
 * AI lane cycles a car cannot leave, with lane changes only on lanes of at least minChange metres: a car on a 3 m arc changes lanes
 * in no way a contract can promise. A single lane whose only exits leave the AI network is no cycle, and is not counted.
 * @param {object} W World.
 * @param {number} ai LF.AI_ROUTABLE.
 * @param {number} minChange Shortest lane a car can change lanes on, Infinity for none.
 * @returns {number[][]} Lane ids of each closed cycle, the largest component of the network left out.
 */
export function closedCycles(W, ai, minChange) {
  const isAi = (l) => (W.lanes[l].flags & ai) !== 0;
  const adj = W.lanes.map((l) => {
    if (!isAi(l.id)) return [];
    const out = Array.from(l.conns, (c) => W.conns[c].to).filter(isAi);
    if (l.len >= minChange) for (const q of [l.left, l.right]) if (q >= 0 && isAi(q)) out.push(q);
    return out;
  });
  const { comp, count } = stronglyConnected(adj);
  const members = Array.from({ length: count }, () => []);
  W.lanes.forEach((l) => {
    if (isAi(l.id)) members[comp[l.id]].push(l.id);
  });
  const leaves = new Uint8Array(count);
  adj.forEach((out, v) => {
    for (const w of out) if (comp[w] !== comp[v]) leaves[comp[v]] = 1;
  });
  const largest = members.reduce((best, m, c) => (m.length > members[best].length ? c : best), 0);
  return members.filter((m, c) => m.length && c !== largest && !leaves[c] && (m.length > 1 || adj[m[0]].includes(m[0])));
}

/**
 * Pairs of lanes of different edges with centres under gap metres apart, sampled every metre along the first. Lanes a car drives from
 * one to the other lie head to tail, and are one road.
 * @returns {Array<{a: object, b: object, m: number, min: number}>}
 */
export function laneContactsOf(TLV, W, gap, keep = () => true) {
  const near = new Int32Array(512);
  const out = new Map();
  const linked = (a, b) => Array.from(a.conns).some((c) => W.conns[c].to === b.id);
  const at = { x: 0, y: 0, h: 0 };
  for (const a of W.lanes) {
    for (let s = 0; s <= a.len; s += 1) {
      TLV.math.polyAt(a.px, a.py, a.cum, s, at);
      const n = TLV.world.lanes.lanesNear(W, at.x, at.y, gap, near);
      for (let i = 0; i < n; i++) {
        const b = W.lanes[near[i]];
        if (b.id <= a.id || b.edge === a.edge || !keep(a, b) || linked(a, b) || linked(b, a)) continue;
        const q = TLV.math.polyProject(b.px, b.py, b.cum, at.x, at.y, -1, {});
        const key = a.id * W.lanes.length + b.id;
        const row = out.get(key) || { a, b, m: 0, min: Infinity };
        row.m++;
        row.min = Math.min(row.min, q.d);
        out.set(key, row);
      }
    }
  }
  return [...out.values()];
}

/** Connected groups of ROUNDABOUT edges: the rings of a World. */
export function ringsOf(W, ROUNDABOUT) {
  const arcs = W.edges.filter((e) => e.flags & ROUNDABOUT);
  const parent = new Map(arcs.map((e) => [e.id, e.id]));
  const find = (x) => {
    while (parent.get(x) !== x) x = parent.get(x);
    return x;
  };
  const atJunc = new Map();
  for (const e of arcs) {
    for (const j of [e.a, e.b]) {
      if (atJunc.has(j)) parent.set(find(e.id), find(atJunc.get(j)));
      else atJunc.set(j, e.id);
    }
  }
  const groups = new Map();
  for (const e of arcs) {
    const r = find(e.id);
    if (!groups.has(r)) groups.set(r, []);
    groups.get(r).push(e);
  }
  return [...groups.values()];
}
