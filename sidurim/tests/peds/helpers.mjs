// tests/peds/helpers.mjs — WP-PEDS test support.
import { createTLV, createSim } from '../../tools/lib/classic.mjs';

/** Sim files of the packages under test: core, world and peds, so a test holds whatever state the other packages are in. */
function ownFiles() {
  const bare = createTLV({ files: [], allowMissing: true });
  return bare.manifest.sim.filter((f) => !/js\/sim\/(traffic|player|game)\//.test(f));
}

/** Warnings about absent packages are expected here, and would bury a real failure. */
export function quiet() {
  const warn = console.warn;
  console.warn = (msg, ...rest) => {
    if (typeof msg === 'string' && msg.startsWith('TLV.sim:')) return;
    warn(msg, ...rest);
  };
}

const MINI = 'tests/fixtures/mini_map.js';

/** @returns {object} TLV with the stub traffic, on a map. */
export function loadTLV(map = MINI, extra = ['tests/peds/stub_traffic.js']) {
  return createTLV({ files: [...ownFiles(), ...extra], map, allowMissing: true });
}

/** @returns {object} TLV with no traffic at all. */
export function loadBare(map = MINI) {
  return loadTLV(map, []);
}

/** A sim with people, and cars only if asked. */
export function sim(TLV, opts = {}) {
  return createSim(TLV, {
    seed: opts.seed ?? 1, allowMissing: true,
    flags: { traffic: !!opts.traffic, peds: true, incidents: false },
    params: { density: opts.density ?? 0, invariants: 1, ...(opts.params || {}) }
  });
}

/** Sets the focus and the player's car. */
export function setPlayer(S, x, y, h = 0, v = 0) {
  const car = S.vehicles[0];
  car.x = x;
  car.y = y;
  car.h = h;
  car.px = x;
  car.py = y;
  car.ph = h;
  car.v = v;
  car.vx = Math.cos(h) * v;
  car.vy = Math.sin(h) * v;
  S.player.fx = x;
  S.player.fy = y;
}

/** Runs ticks. */
export function run(TLV, S, ticks, each) {
  for (let i = 0; i < ticks; i++) {
    TLV.sim.step(S);
    if (each && each(i) === false) return i;
  }
  return ticks;
}

/** Runs until something is true, in sim seconds. */
export function until(TLV, S, seconds, test) {
  const end = Math.ceil(seconds * 60);
  for (let i = 0; i < end; i++) {
    if (test()) return true;
    TLV.sim.step(S);
  }
  return test();
}

/** Listens to pedestrian events, in order. */
export function record(S, names = ['ped.spawn', 'ped.despawn', 'ped.intent', 'ped.stepOut', 'ped.bell', 'bubble']) {
  const log = [];
  for (const name of names) S.bus.on(name, (e) => log.push({ name, t: S.t, tick: S.tick, ...e }));
  return log;
}

/** Spawns a person on the first row with an end this far from anything, or at a place. */
export function person(TLV, S, spec) {
  const p = TLV.peds.spawn(S, spec);
  if (!p) throw new Error('no slot');
  return p;
}

/** Turns off the ambient crowd, for a scenario with its own cast. */
export function noCrowd(TLV) {
  TLV.tune.peds.bubbleAim = 0;
  TLV.tune.peds.outerAim = 0;
  TLV.tune.peds.ambientCap = 0;
  TLV.tune.peds.jayPerMin = 0;
  TLV.tune.peds.strollP = 0;
  TLV.tune.peds.despawnM = 1e6;
  TLV.tune.peds.roadOutM = 1e6;
  TLV.tune.peds.roadKeepM = 1e6;
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

export { createTLV, createSim };

/**
 * A driver for the player's car: follows lanes and connectors at a set speed, with no thought for anyone, so tests can read what
 * people do around a moving car. PLAYER is out of these tests by design.
 * @returns {function(): void} Call once per tick, before TLV.sim.step.
 */
export function driver(TLV, S, speed, start = 0) {
  const W = S.world;
  const math = TLV.math;
  const dt = TLV.const.DT;
  let conn = -1;
  let lane = W.lanes.findIndex((l, i) => i >= start && (l.flags & TLV.const.LF.AI_ROUTABLE) && l.len > 40);
  let s = 0;
  const at = { x: 0, y: 0, h: 0 };
  return () => {
    s += speed * dt;
    if (conn < 0 && s >= W.lanes[lane].len) {
      const next = TLV.world.routing.randomExit(W, lane, S.rng.bot);
      if (next >= 0) {
        s -= W.lanes[lane].len;
        conn = next;
        lane = -1;
      } else {
        // A dead end with no way on: the car stays there, rather than jumping back along the lane.
        s = W.lanes[lane].len;
      }
    }
    if (conn >= 0 && s >= W.conns[conn].len) {
      s -= W.conns[conn].len;
      lane = W.conns[conn].to;
      conn = -1;
    }
    if (conn >= 0) TLV.world.lanes.connPointAt(W, conn, s, at);
    else TLV.world.lanes.pointAt(W, lane, s, at);
    setPlayer(S, at.x, at.y, at.h, speed);
    S.vehicles[0].laneId = lane;
    S.vehicles[0].connId = conn;
    return math;
  };
}

/** Puts a vehicle down by hand, for a test with no traffic system. */
export function placeCar(TLV, S, { x, y, h = 0, v = 0, kind = 'sedan', laneId = -1, connId = -1, slot = 1 }) {
  const car = S.vehicles[slot];
  const size = TLV.const.VEHICLE_SIZES[kind];
  Object.assign(car, {
    id: 1000 + slot, active: true, isPlayer: false, kind, length: size.length, width: size.width, x, y, h, px: x, py: y, ph: h,
    v, vx: Math.cos(h) * v, vy: Math.sin(h) * v, mode: connId >= 0 ? 'CONN' : 'LANE', laneId, connId, s: 0, yawRate: 0
  });
  return car;
}

/** Crossing 8 of the fixture: x = 0, y = -100, one lane each way, a zebra, walkers on rows 16 and 17. */
export const ZEBRA = 8;

/** Spawns a person on the row of a crossing's side, a few metres short of it. Returns the person. */
export function atCrossing(TLV, S, xingId, kind = 'walker', side = 'A') {
  const path = TLV.peds.cross.pathOf(S, xingId);
  const sw = side === 'A' ? path.swA : path.swB;
  const s = side === 'A' ? path.sA : path.sB;
  const p = TLV.peds.spawn(S, { kind, x: 0, y: 0, swId: sw, swS: s });
  return p;
}

/** Fixture lanes crossing the zebra: north-bound on x = +1.5, south-bound on x = -1.5. */
export function zebraLanes(S) {
  const zones = S.world.xings[ZEBRA].zones;
  const lanes = [...zones].map((z) => S.world.lanes[S.world.zones[z].laneId]);
  return { north: lanes.find((l) => l.px[0] > 0), south: lanes.find((l) => l.px[0] < 0) };
}

/** A signalled crossing on the real map that lands on a sidewalk on both sides, far enough from everything to reason about. */
export function signalCrossing(TLV, S) {
  const W = S.world;
  for (const x of W.xings) {
    if (!x.signal || x.ctrl < 0) continue;
    const path = TLV.peds.cross.pathOf(S, x.id);
    if (path && path.ambient && path.spots.length === 0) return x;
  }
  throw new Error('no signalled crossing');
}

/** Holds a crossing at walk, or at no walk, by forcing its junction. */
export function forceWalk(TLV, S, xing, walk) {
  const ctrl = S.world.ctrls[xing.ctrl];
  TLV.world.signals.force(S, ctrl.junc, walk ? 'R' : 'G', 600);
}
