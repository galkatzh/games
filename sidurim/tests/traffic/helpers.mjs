// tests/traffic/helpers.mjs — WP-TRAFFIC
// Scenarios on the real map. The world and traffic are the shipped files. The player and the people are small stand-ins from
// tests/traffic/stubs, so a test that moves the player does so exactly, and the package's tests do not depend on other packages'.
import assert from 'node:assert/strict';
import { createTLV, createSim } from '../../tools/lib/classic.mjs';

/** Every sim file this package needs, and the stand-ins for the rest. */
function fileList() {
  const manifest = createTLV({ files: [] }).manifest.sim;
  const own = manifest.filter((f) => f.startsWith('js/core/') || f.startsWith('js/world/') || f.startsWith('js/sim/traffic/'));
  return [...own, 'tests/traffic/stubs/player_stub.js', 'tests/traffic/stubs/peds_stub.js'];
}

const quiet = (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return fn();
  } finally {
    console.warn = warn;
  }
};

let shared = null;

/** @returns {object} A TLV on the real map, shared within a test file, because a world is immutable and takes a moment to build. */
export function realTLV() {
  if (!shared) {
    shared = quiet(() => createTLV({
      files: fileList(), map: 'tlv_center', content: false, allowMissing: true, params: {}
    }));
    // A scenario holds only the cars it places, wherever the player is. A sim made without it keeps the real spawner.
    const upkeep = shared.traffic.spawner.maintain;
    shared.traffic.spawner.maintain = (S) => (S.scenario ? shared.traffic.spawner.stats(S) : upkeep(S));
  }
  return shared;
}

/**
 * A sim with no ambient traffic, so a scenario holds only the cars it places. Its bus records every event.
 * @param {object} [opts] { seed, params, density }.
 * @returns {object} S, with S.log of [name, payload].
 */
export function quietSim(opts = {}) {
  const TLV = realTLV();
  const S = quiet(() => createSim(TLV, {
    seed: opts.seed || 1, map: 'tlv_center', allowMissing: true, params: { notitle: 1, density: opts.density === undefined ? 0 : opts.density, ...opts.params }
  }));
  S.scenario = !opts.spawner;
  S.log = [];
  const names = ['traffic.spawn', 'traffic.despawn', 'traffic.behaviour', 'traffic.redRun', 'traffic.honk', 'traffic.wreck',
    'traffic.parkRace', 'traffic.door', 'bubble'];
  for (const name of names) S.bus.on(name, (e) => S.log.push([name, e]));
  // The first tick drives nothing: it builds the lists and the broadphase.
  quiet(() => TLV.sim.step(S));
  parkPlayer(S, -2000, -2700);
  return S;
}

/** Puts the player far from the action. */
export function parkPlayer(S, x, y) {
  realTLV().player.setPose(S, x, y, 0, 0);
}

/** Runs ticks, with the conservation check at the end, which every scenario asserts. */
export function run(S, ticks, each) {
  const TLV = realTLV();
  for (let i = 0; i < ticks; i++) {
    TLV.sim.step(S);
    if (each && each(i) === true) return i + 1;
  }
  assert.equal(TLV.traffic.gate.audit(S), null, 'occ and reserved are conserved');
  return ticks;
}

/** Runs until a condition, or fails after limit seconds. @returns {number} Seconds taken. */
export function runUntil(S, cond, limit, what) {
  const start = S.t;
  const ticks = Math.round(limit * 60);
  const TLV = realTLV();
  for (let i = 0; i < ticks; i++) {
    TLV.sim.step(S);
    if (cond()) {
      assert.equal(TLV.traffic.gate.audit(S), null, 'occ and reserved are conserved');
      return S.t - start;
    }
  }
  assert.fail(`${what || 'condition'} not reached in ${limit} s`);
  return Infinity;
}

const AI = 1;
const EXCLUSIVE = 2;

/** @returns {number} Largest turn along a stretch of a lane, radians. */
function bendOf(lane) {
  let most = 0;
  for (let i = 1; i + 1 < lane.px.length; i++) {
    const a = Math.atan2(lane.py[i] - lane.py[i - 1], lane.px[i] - lane.px[i - 1]);
    const b = Math.atan2(lane.py[i + 1] - lane.py[i], lane.px[i + 1] - lane.px[i]);
    let d = b - a;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    most = Math.max(most, Math.abs(d));
  }
  return most;
}

/**
 * Finds a straight AI lane. The n-th match keeps a test on one place, stable across a re-import that does not touch it.
 * @param {object} W World.
 * @param {function(object):boolean} test Lane test.
 * @param {number} [n] Which match.
 * @returns {object} Lane.
 */
export function findLane(W, test, n = 0) {
  let seen = 0;
  for (const lane of W.lanes) {
    if (!(lane.flags & AI) || (lane.flags & EXCLUSIVE) || !lane.conns.length || bendOf(lane) > 0.15) continue;
    if (!test(lane)) continue;
    if (seen++ === n) return lane;
  }
  assert.fail('no such lane on this map');
  return null;
}

/** @returns {?object} A lane ending at a signal, with a straight connector onto an AI lane. */
export function signalApproach(W, minLen = 90, width = 2.9) {
  const lane = findLane(W, (l) => {
    if (l.len < minLen || l.width < width || l.left >= 0 || l.right >= 0) return false;
    const conn = W.conns[l.conns[0]];
    return conn.slot >= 0 && l.conns.length >= 1 && (W.lanes[conn.to].flags & AI) && W.ctrls[W.juncs[conn.junc].ctrl].slots.length === 2;
  });
  return lane;
}

export function holdRed(S, lane) {
  const TLV = realTLV();
  const junc = S.world.conns[lane.conns[0]].junc;
  TLV.world.signals.force(S, junc, 'R', 600);
  return junc;
}

/** Places a car and hands it a known driver. */
export function car(S, spec) {
  const veh = realTLV().traffic.spawn(S, { kind: 'sedan', ag: 0.5, v: 0, force: true, ...spec });
  assert.ok(veh, 'the car was placed');
  return veh;
}

/** Puts the stand-in player on a lane, at speed. */
export function playerOn(S, laneId, s, v = 0) {
  const TLV = realTLV();
  const at = TLV.world.lanes.pointAt(S.world, laneId, s, {});
  TLV.player.setPose(S, at.x, at.y, at.h, v);
  return at;
}

/** Events of a name since the sim began. */
export function events(S, name, test) {
  return S.log.filter(([n, e]) => n === name && (!test || test(e))).map(([, e]) => e);
}

export { assert };
