// tools/lib/encode.mjs — WP-MAP
// Pass 21: columnar encoding, section 7. Everything here is deterministic: output order follows input row order, and the
// string table is sorted by use count, then by code unit.

/** Interns strings. Index 0 is always the empty string. */
export class StringTable {
  constructor() {
    this.counts = new Map();
  }

  /** Records one use of a string. */
  use(s) {
    if (s) this.counts.set(s, (this.counts.get(s) || 0) + 1);
  }

  /** Freezes the order. Frequent strings get short indices. */
  finish() {
    const list = [...this.counts.entries()].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
    this.list = [''].concat(list.map((x) => x[0]));
    this.index = new Map(this.list.map((s, i) => [s, i]));
  }

  /** Index of a string. Unknown or empty strings are 0. */
  get(s) {
    return (s && this.index.get(s)) || 0;
  }
}

/** Appends one unsigned LEB128 value, by arithmetic so values above 2^31 stay exact. */
function writeLeb(out, value) {
  let v = value;
  while (v >= 128) {
    out.push((v % 128) + 128);
    v = Math.floor(v / 128);
  }
  out.push(v);
}

const zigzag = (v) => (v >= 0 ? v * 2 : -v * 2 - 1);
const b64 = (bytes) => Buffer.from(bytes).toString('base64');

/** Column builders, one per encoding in section 7.2. Each returns the `[enc, data]` cell of a table. */
export const enc = {
  u8: (a) => {
    for (const v of a) if (!Number.isInteger(v) || v < 0 || v > 255) throw new Error(`u8 column value out of range: ${v}`);
    return ['u8', b64(Uint8Array.from(a))];
  },
  vu: (a) => {
    const out = [];
    for (const v of a) {
      if (!Number.isInteger(v) || v < 0 || v >= 2 ** 31) throw new Error(`vu column value out of range: ${v}`);
      writeLeb(out, v);
    }
    return ['vu', b64(out)];
  },
  vz: (a) => {
    const out = [];
    for (const v of a) writeLeb(out, zigzag(v));
    return ['vz', b64(out)];
  },
  vd: (a) => {
    const out = [];
    let prev = 0;
    for (const v of a) {
      writeLeb(out, zigzag(v - prev));
      prev = v;
    }
    return ['vd', b64(out)];
  },
  vl: (a) => {
    const out = [];
    for (const v of a) {
      if (!Number.isSafeInteger(v) || v < 0) throw new Error(`vl column value out of range: ${v}`);
      writeLeb(out, v);
    }
    return ['vl', b64(out)];
  },
  raw: (a) => ['raw', Array.from(a)],
  rl: (a) => {
    const out = [];
    for (let i = 0; i < a.length;) {
      let j = i + 1;
      while (j < a.length && a[j] === a[i]) j++;
      writeLeb(out, a[i]);
      writeLeb(out, j - i);
      i = j;
    }
    return ['rl', b64(out)];
  }
};

/**
 * Picks the shorter of a column's contract encoding and `rl`. The map holds 170 KB of near-constant columns (`osmT`, `style`,
 * `roof`, kerb `form`) that no Section 7.2 encoding can take under one byte per row. `rl` is lossless and private to this file
 * and the codec, since every reader goes through `decodeAll`.
 */
function shortest(cell, values) {
  const run = enc.rl(values);
  return run[1].length < cell[1].length ? run : cell;
}

/** Byte column, or run-length when shorter. */
const u8 = (a) => shortest(enc.u8(a), a);

/** Unsigned varint column, or run-length when shorter. */
const vu = (a) => shortest(enc.vu(a), a);

/** Flattens rows with an offset column: `[pOff, xs, ys]` for tables that own a child point table. */
function flatten(rows, ptsOf) {
  const off = [0];
  const xs = [];
  const ys = [];
  for (const r of rows) {
    const p = ptsOf(r);
    for (let i = 0; i < p.length; i += 2) {
      xs.push(Math.round(p[i]));
      ys.push(Math.round(p[i + 1]));
    }
    off.push(xs.length);
  }
  return { off, xs, ys };
}

/** One table in the container format. */
function table(n, cols) {
  return { n, cols };
}

/** Rows mapped through a getter. */
const pluck = (rows, f) => rows.map(f);

/** Edge flags are a small bit set of booleans. */
const boolBits = (b, ...flags) => flags.reduce((v, [on, bit]) => v | (on ? bit : 0), b);

/**
 * Builds the map payload.
 * @param {object} model Final importer model.
 * @param {object} meta `meta` block.
 * @returns {object} The object pushed as a `map` queue item.
 */
export function encodeMap(model, meta) {
  const { juncs, edges, moves, blds, pois, kerbs, xings, stops, trees, lots, land, paths, walls } = model;
  const str = new StringTable();
  for (const e of edges) {
    str.use(e.name);
    str.use(e.nameEn);
  }
  for (const b of blds) {
    str.use(b.colour);
    str.use(b.style);
    str.use(b.name);
    str.use(b.nameEn);
  }
  for (const p of pois) {
    str.use(p.kind);
    str.use(p.nameHe);
    str.use(p.nameEn);
  }
  for (const k of kerbs) str.use(k.zone);
  for (const s of stops) str.use(s.name);
  for (const l of lots) str.use(l.name);
  for (const p of paths) str.use(p.name);
  str.finish();

  const pts = flatten(edges, (e) => e.pts);
  const rOff = [0];
  const pOff = [0];
  const bx = [];
  const by = [];
  const front = [];
  for (const b of blds) {
    b.rings.forEach((r, ri) => {
      for (let i = 0; i < r.length; i += 2) {
        bx.push(r[i]);
        by.push(r[i + 1]);
        front.push(ri === 0 && b.front ? b.front[i >> 1] : 0);
      }
      pOff.push(bx.length);
    });
    rOff.push(pOff.length - 1);
  }
  const lotPts = flatten(lots, (l) => l.ring);
  const landPts = flatten(land, (l) => l.ring);
  const pathPts = flatten(paths, (p) => p.pts);
  const wallPts = flatten(walls, (w) => w.pts);

  // Monotonic columns (`*Off`, `moves.from`, `kerbs.edge`, `xings.edge`) use `vd`, not the `vu` in section 7.3: the decoded
  // type is the same `Int32Array`, every reader goes through `decodeAll`, and it saves about 120 KB.
  const tables = {
    juncs: table(juncs.length, {
      x: enc.vd(pluck(juncs, (j) => j.x)),
      y: enc.vd(pluck(juncs, (j) => j.y)),
      kind: u8(pluck(juncs, (j) => j.kind)),
      flags: u8(pluck(juncs, (j) => j.flags))
    }),
    edges: table(edges.length, {
      a: vu(pluck(edges, (e) => e.ja)),
      b: vu(pluck(edges, (e) => e.jb)),
      ptOff: enc.vd(pts.off),
      cls: u8(pluck(edges, (e) => e.cls)),
      lanesF: u8(pluck(edges, (e) => e.lanesF)),
      lanesB: u8(pluck(edges, (e) => e.lanesB)),
      kmh: u8(pluck(edges, (e) => e.kmh)),
      laneW: u8(pluck(edges, (e) => e.laneW)),
      parkL: u8(pluck(edges, (e) => e.parkL)),
      parkR: u8(pluck(edges, (e) => e.parkR)),
      swL: u8(pluck(edges, (e) => e.swL)),
      swR: u8(pluck(edges, (e) => e.swR)),
      flags: u8(pluck(edges, (e) => e.flags)),
      name: vu(pluck(edges, (e) => str.get(e.name))),
      nameEn: vu(pluck(edges, (e) => str.get(e.nameEn))),
      osm: enc.vl(pluck(edges, (e) => e.way))
    }),
    pts: table(pts.xs.length, { x: enc.vd(pts.xs), y: enc.vd(pts.ys) }),
    moves: table(moves.length, {
      from: enc.vd(pluck(moves, (m) => m.from)),
      to: vu(pluck(moves, (m) => m.to)),
      turn: u8(pluck(moves, (m) => m.turn))
    }),
    blds: table(blds.length, {
      rOff: enc.vd(rOff),
      h: vu(pluck(blds, (b) => b.h)),
      levels: u8(pluck(blds, (b) => b.levels)),
      kind: u8(pluck(blds, (b) => b.kind)),
      roof: u8(pluck(blds, (b) => b.roof)),
      colour: vu(pluck(blds, (b) => str.get(b.colour))),
      style: vu(pluck(blds, (b) => str.get(b.style))),
      flags: u8(pluck(blds, (b) => boolBits(0, [b.noCollider, 1], [b.glass, 2]))),
      name: vu(pluck(blds, (b) => str.get(b.name))),
      nameEn: vu(pluck(blds, (b) => str.get(b.nameEn))),
      osm: enc.vl(pluck(blds, (b) => b.osm)),
      osmT: u8(pluck(blds, (b) => b.osmT))
    }),
    brings: table(pOff.length - 1, { pOff: enc.vd(pOff) }),
    bpts: table(bx.length, { x: enc.vd(bx), y: enc.vd(by), front: u8(front) }),
    pois: table(pois.length, {
      x: enc.vd(pluck(pois, (p) => p.x)),
      y: enc.vd(pluck(pois, (p) => p.y)),
      kind: vu(pluck(pois, (p) => str.get(p.kind))),
      nameHe: vu(pluck(pois, (p) => str.get(p.nameHe))),
      nameEn: vu(pluck(pois, (p) => str.get(p.nameEn))),
      osm: enc.vl(pluck(pois, (p) => p.osm)),
      osmT: u8(pluck(pois, (p) => p.osmT)),
      bld: vu(pluck(pois, (p) => p.bld)),
      wall: vu(pluck(pois, (p) => p.wall)),
      t: u8(pluck(pois, (p) => p.t)),
      w: u8(pluck(pois, (p) => p.w)),
      entX: enc.vd(pluck(pois, (p) => p.entX)),
      entY: enc.vd(pluck(pois, (p) => p.entY)),
      edge: vu(pluck(pois, (p) => p.edge)),
      flags: u8(pluck(pois, (p) => p.flags))
    }),
    kerbs: table(kerbs.length, {
      edge: enc.vd(pluck(kerbs, (k) => k.edge)),
      side: u8(pluck(kerbs, (k) => k.side)),
      s0: vu(pluck(kerbs, (k) => k.s0)),
      s1: vu(pluck(kerbs, (k) => k.s1)),
      form: u8(pluck(kerbs, (k) => k.form)),
      paint: u8(pluck(kerbs, (k) => k.paint)),
      zone: vu(pluck(kerbs, (k) => str.get(k.zone))),
      tier: u8(pluck(kerbs, (k) => k.tier))
    }),
    xings: table(xings.length, {
      x: enc.vd(pluck(xings, (r) => r.x)),
      y: enc.vd(pluck(xings, (r) => r.y)),
      edge: enc.vd(pluck(xings, (r) => r.edge)),
      s: vu(pluck(xings, (r) => r.s)),
      flags: u8(pluck(xings, (r) => (r.signal ? 1 : 0)))
    }),
    stops: table(stops.length, {
      x: enc.vd(pluck(stops, (r) => r.x)),
      y: enc.vd(pluck(stops, (r) => r.y)),
      edge: vu(pluck(stops, (r) => r.edge)),
      dir: u8(pluck(stops, (r) => r.dir)),
      s: vu(pluck(stops, (r) => r.s)),
      name: vu(pluck(stops, (r) => str.get(r.name)))
    }),
    trees: table(trees.length, {
      x: enc.vd(pluck(trees, (r) => r.x)),
      y: enc.vd(pluck(trees, (r) => r.y)),
      species: u8(pluck(trees, (r) => r.species))
    }),
    lots: table(lots.length, {
      pOff: enc.vd(lotPts.off),
      kind: u8(pluck(lots, (r) => r.kind)),
      entX: enc.vd(pluck(lots, (r) => r.entX)),
      entY: enc.vd(pluck(lots, (r) => r.entY)),
      name: vu(pluck(lots, (r) => str.get(r.name)))
    }),
    lotPts: table(lotPts.xs.length, { x: enc.vd(lotPts.xs), y: enc.vd(lotPts.ys) }),
    land: table(land.length, { pOff: enc.vd(landPts.off), cls: u8(pluck(land, (r) => r.cls)) }),
    landPts: table(landPts.xs.length, { x: enc.vd(landPts.xs), y: enc.vd(landPts.ys) }),
    paths: table(paths.length, {
      pOff: enc.vd(pathPts.off),
      cls: u8(pluck(paths, (r) => r.cls)),
      name: vu(pluck(paths, (r) => str.get(r.name)))
    }),
    pathPts: table(pathPts.xs.length, { x: enc.vd(pathPts.xs), y: enc.vd(pathPts.ys) }),
    walls: table(walls.length, { pOff: enc.vd(wallPts.off), kind: u8(pluck(walls, (r) => r.kind)) }),
    wallPts: table(wallPts.xs.length, { x: enc.vd(wallPts.xs), y: enc.vd(wallPts.ys) })
  };

  return { schema: [1, 0], id: meta.id, meta: meta.meta, strings: str.list, tables };
}

/**
 * Text of a generated data file: a queue item, a plain script that works in both the browser and the Node loader.
 * @param {object} payload Map payload.
 * @returns {string}
 */
export function mapScript(payload) {
  return `TLV.q.push(['map', ${JSON.stringify(payload)}]);\n`;
}

/**
 * Size of each table in the file, for the report.
 * @param {object} payload Map payload.
 * @returns {Object<string, number>} Bytes per table, plus `strings`.
 */
export function tableSizes(payload) {
  const out = { strings: Buffer.byteLength(JSON.stringify(payload.strings)) };
  for (const [name, t] of Object.entries(payload.tables)) out[name] = Buffer.byteLength(JSON.stringify(t));
  return out;
}
