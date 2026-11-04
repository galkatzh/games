// tests/player/helpers.mjs — WP-PLAYER
// Shared set-up. Traffic, people and game are absent or private stubs here, until those packages land.
import { createTLV, createSim } from '../../tools/lib/classic.mjs';

export const MINI = 'tests/fixtures/mini_map.js';
export const REAL = 'tlv_center';

const quiet = console.warn;

/** Runs fn with console.warn silenced, for the "module is missing" lines of a package tested alone. */
function hush(fn) {
  console.warn = (msg) => {
    if (!String(msg).includes('is missing, skipped')) quiet(msg);
  };
  try {
    return fn();
  } finally {
    console.warn = quiet;
  }
}

/** The sim files this package depends on. Other packages are left out, so a test here never reads their work in progress. */
const OWN = ['js/core/', 'js/world/', 'js/sim/player/'];

/** Loads core, world and this package, plus any stub files, on a map. */
export function loadTLV(map, stubs = []) {
  const all = createTLV({ files: [] }).manifest.sim;
  const files = all.filter((f) => OWN.some((dir) => f.startsWith(dir)));
  return hush(() => createTLV({ files: [...files, ...stubs], map, content: false, allowMissing: true }));
}

/** Creates a sim. flags default to all off: tests turn on what they stub. */
export function makeSim(TLV, opts = {}) {
  return hush(() => {
    const S = createSim(TLV, { allowMissing: true, ...opts });
    TLV.sim.step(S);
    return S;
  });
}

/** Runs ticks, with a control function called before each. */
export function run(TLV, S, ticks, controls) {
  for (let i = 0; i < ticks; i++) {
    if (controls) controls(S.controls, S, i);
    TLV.sim.step(S);
  }
}

/** Records every emission of named events. */
export function listen(S, names) {
  const seen = {};
  for (const name of names) {
    seen[name] = [];
    S.bus.on(name, (payload) => seen[name].push({ ...payload, t: S.t }));
  }
  return seen;
}

/** Zeroes the driving controls. */
export function release(c) {
  c.throttle = 0;
  c.brake = 0;
  c.steer = 0;
  c.handbrake = false;
  c.horn = false;
  c.hazard = false;
  c.footX = 0;
  c.footY = 0;
  c.sidestep = false;
}

/** Makes the world an empty road, so handling numbers can be measured with nothing in the way. Test-local: TLV is per call. */
export function flatten(TLV) {
  TLV.world.surface.at = () => TLV.const.SURF.ROAD;
  TLV.world.spatial.collidersNear = () => 0;
  TLV.world.spatial.propsNear = () => 0;
  TLV.world.parking.parkedNear = (S, x, y, r, out) => { out.length = 0; return 0; };
}

/** The straightest lane of at least minLen on a map, clear of the edge band, on road along its whole length. */
export function straightLane(TLV, W, minLen) {
  const SURF = TLV.const.SURF;
  let best = null;
  let bestBend = Infinity;
  for (const lane of W.lanes) {
    if (lane.len < minLen) continue;
    const n = lane.px.length - 1;
    const bend = lane.len - Math.hypot(lane.px[n] - lane.px[0], lane.py[n] - lane.py[0]);
    if (bend >= bestBend) continue;
    let ok = true;
    for (let s = 0; s < lane.len && ok; s += 2) {
      const at = TLV.world.lanes.pointAt(W, lane.id, s, {});
      ok = TLV.world.surface.at(W, at.x, at.y) === SURF.ROAD
        && Math.min(at.x - W.bounds.minX, W.bounds.maxX - at.x, at.y - W.bounds.minY, W.bounds.maxY - at.y) > 60;
    }
    if (ok) {
      best = lane;
      bestBend = bend;
    }
  }
  return best;
}

/** A point on a lane with nothing solid within r: a wide road or a big junction, for a test that needs room on the real map. */
export function openRoad(TLV, W, r) {
  const ids = new Int32Array(512);
  const props = new Int32Array(64);
  const ROAD = TLV.const.SURF.ROAD;
  for (const lane of W.lanes) {
    if (lane.cls > 2 || lane.len < 40) continue;
    for (let s = 10; s < lane.len - 10; s += 10) {
      const at = TLV.world.lanes.pointAt(W, lane.id, s, {});
      if (TLV.world.spatial.collidersNear(W, at.x, at.y, r, ids) > 0) continue;
      if (TLV.world.spatial.propsNear(W, at.x, at.y, r, props) > 0) continue;
      let onRoad = true;
      for (let a = 0; a < 8 && onRoad; a++) {
        const k = a * Math.PI / 4;
        onRoad = TLV.world.surface.at(W, at.x + Math.cos(k) * r * 0.7, at.y + Math.sin(k) * r * 0.7) === ROAD;
      }
      if (onRoad) return { lane, s, x: at.x, y: at.y, h: at.h };
    }
  }
  return null;
}

/** Holds a lane's centre with a little steering, as a driver would, so a straight run stays on a real road. */
export function holdLane(S, c) {
  c.steer = Math.max(-0.3, Math.min(0.3, -S.player.lat * 0.08 - (S.player._d.lane.headingErr || 0) * 0.5));
}

/** Frees every stall within r of a point, so a scene has no static cars in it. */
export function clearParked(TLV, S, x, y, r) {
  const ids = [];
  TLV.world.parking.spotsNear(S.world, x, y, r, ids);
  for (const id of ids) TLV.world.parking.setState(S, id, TLV.const.OCC.FREE);
}

/**
 * Finds a long straight building wall with clear ground in front of it, on any map.
 * @returns {{mx:number,my:number,ux:number,uy:number,nx:number,ny:number,owner:number,len:number}} Midpoint, unit vector along
 *   the wall, and unit normal toward the open side.
 */
export function openWall(TLV, W, minLen = 24, room = 12) {
  const col = W.colliders;
  const ids = new Int32Array(512);
  const props = new Int32Array(64);
  for (let i = 0; i < col.n; i++) {
    if (col.owner[i] < 0) continue;
    const dx = col.bx[i] - col.ax[i];
    const dy = col.by[i] - col.ay[i];
    const len = Math.hypot(dx, dy);
    if (len < minLen) continue;
    const ux = dx / len;
    const uy = dy / len;
    const mx = (col.ax[i] + col.bx[i]) / 2;
    const my = (col.ay[i] + col.by[i]) / 2;
    for (const sign of [1, -1]) {
      const nx = -uy * sign;
      const ny = ux * sign;
      const cx = mx + nx * room;
      const cy = my + ny * room;
      const b = W.bounds;
      if (Math.min(cx - b.minX, b.maxX - cx, cy - b.minY, b.maxY - cy) < 2 * room + 30) continue;
      if (TLV.world.spatial.pointInBuilding(W, cx, cy) >= 0) continue;
      if (TLV.world.spatial.pointInBuilding(W, mx + nx * 2, my + ny * 2) >= 0) continue;
      let walls = TLV.world.spatial.collidersNear(W, cx, cy, room - 0.5, ids);
      const pr = TLV.world.spatial.propsNear(W, cx, cy, room, props);
      if (walls === 0 && pr === 0) {
        let dry = true;
        for (const k of [2, 6, 10]) dry = dry && TLV.world.surface.at(W, mx + nx * k, my + ny * k) !== TLV.const.SURF.WATER;
        if (dry) return { mx, my, ux, uy, nx, ny, owner: col.owner[i], len };
      }
    }
  }
  throw new Error('no open wall on this map');
}

/** Places a stationary AI car by hand, in a pool slot, for scenes with no WP-TRAFFIC. @returns {object} Vehicle. */
export function placeCar(TLV, S, x, y, h, spec = {}) {
  let slot = -1;
  for (let i = 1; i < S.vehicles.length && slot < 0; i++) {
    if (!S.vehicles[i].active) slot = i;
  }
  const kind = spec.kind || 'sedan';
  const size = TLV.const.VEHICLE_SIZES[kind];
  const v = S.vehicles[slot];
  Object.assign(v, {
    id: spec.id || 100 + slot, active: true, kind, length: size.length, width: size.width, wheelbase: size.wheelbase,
    x, y, h, px: x, py: y, ph: h, v: spec.v || 0, vx: (spec.v || 0) * Math.cos(h), vy: (spec.v || 0) * Math.sin(h),
    mode: spec.mode || 'LANE', door: spec.door || 0
  });
  return v;
}

/** Clears a pool slot. */
export function removeCar(v) {
  v.active = false;
}
