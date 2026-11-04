// tests/game/helpers.mjs — WP-GAME
// Scenarios on the real tlv_center map, with the real player, traffic and people. WP-RENDER's content files may not exist yet, so
// the loader is told not to mind. They hold no sim content.
import assert from 'node:assert/strict';
import { createTLV, createSim } from '../../tools/lib/classic.mjs';

let shared = null;

/** @returns {object} TLV on the real map, shared within a test file: a world is immutable and takes a moment to build. */
export function realTLV() {
  if (!shared) shared = createTLV({ map: 'tlv_center', allowMissing: true, params: {} });
  return shared;
}

const QUIET = { traffic: 0, peds: 0, incidents: 0, contest: 'off' };

/**
 * A sim that has run its first preUpdate, so S.game holds a run.
 * @param {object} [params] Sim params. Traffic, people, incidents and contests default to off, because most scenarios test one thing.
 * @returns {object} S, with S.log of [name, payload].
 */
export function sim(params = {}) {
  const TLV = realTLV();
  const S = createSim(TLV, { seed: params.seed || 1, params: { notitle: 1, ...QUIET, ...params } });
  S.log = [];
  const emit = S.bus.emit;
  S.bus.emit = (name, payload) => {
    S.log.push([name, payload]);
    emit.call(S.bus, name, payload);
  };
  TLV.sim.step(S);
  return S;
}

export const events = (S, name, test) => S.log.filter((e) => e[0] === name && (!test || test(e[1]))).map((e) => e[1]);

export function step(S, ticks = 1) {
  const TLV = realTLV();
  for (let i = 0; i < ticks; i++) TLV.sim.step(S);
}

/** Runs until a test holds. Throws past the limit, with the phase in the message. */
export function until(S, test, seconds = 30, what = 'condition') {
  const TLV = realTLV();
  const limit = Math.round(seconds * 60);
  for (let i = 0; i < limit; i++) {
    if (test(S)) return i;
    TLV.sim.step(S);
  }
  assert.fail(`${what}: not reached in ${seconds} s, phase ${S.game.phase}, t ${S.t.toFixed(1)}`);
}

export const toDrive = (S) => until(S, (s) => s.game.phase === 'DRIVE', 12, 'DRIVE');

/** @returns {object} The current bay. */
export const bayOf = (S) => realTLV().world.parking.spot(S.world, S.game.errand.bayId);

/** @returns {{a:number,l:number}} A car's place in a stall's frame: a along its axis, l to its left. */
export function inBay(spot, veh) {
  const ex = veh.x - spot.x;
  const ey = veh.y - spot.y;
  return { a: ex * Math.cos(spot.h) + ey * Math.sin(spot.h), l: -ex * Math.sin(spot.h) + ey * Math.cos(spot.h) };
}

/** Puts the car at rest on the centre of the bay's lane, some metres short of the bay, and points nav at the bay. */
export function atLaneCentre(S, spot, back, v = 0) {
  const TLV = realTLV();
  const s = Math.max(1, spot.laneS - back);
  const at = TLV.world.lanes.pointAt(S.world, spot.laneId, s, {});
  TLV.player.setPose(S, at.x, at.y, at.h, v);
  TLV.game.nav.setTarget(S, spot.laneId, spot.laneS, spot.x, spot.y);
}

/** Puts the car on the route, some metres of road short of its end. */
export function onRoute(S, left) {
  const TLV = realTLV();
  const r = S.game.nav.route;
  const at = TLV.math.polyAt(r.px, r.py, r.cum, Math.max(0, r.len - left), {});
  TLV.player.setPose(S, at.x, at.y, at.h, 0);
}

/**
 * The scripted parker: a cosine S-curve from wherever the car is laterally to the bay's axis, by pure pursuit, at a walking pace.
 * This is what a careful player's hands do, so it reads only the car's pose and writes only ControlState.
 * @param {object} spot Stall.
 * @param {object} [o] { endL: lateral offset to aim for, stopA: where to brake, startA, endA: the curve's ends, v: speed }.
 * @returns {function} Control source.
 */
export function parker(spot, o = {}) {
  const TLV = realTLV();
  const c = TLV.const._newControls();
  const startA = o.startA === undefined ? -7.2 : o.startA;
  const endA = o.endA === undefined ? 0.2 : o.endA;
  const stopA = o.stopA === undefined ? 1.5 : o.stopA;
  const endL = o.endL || 0;
  const cruise = o.v || 3.2;
  const cs = Math.cos(spot.h);
  const sn = Math.sin(spot.h);
  let from = null;
  const curve = (a) => {
    if (a <= startA) return from;
    if (a >= endA) return endL;
    return endL + (from - endL) * (1 + Math.cos(Math.PI * (a - startA) / (endA - startA))) / 2;
  };
  return (S) => {
    Object.assign(c, TLV.const._newControls());
    const veh = S.player.veh;
    if (S.player.mode !== 'DRIVE') return c;
    const { a, l } = inBay(spot, veh);
    if (from === null) from = l;
    const ta = a + 2.5;
    const tl = curve(ta);
    const dx = spot.x + ta * cs - tl * sn - veh.x;
    const dy = spot.y + ta * sn + tl * cs - veh.y;
    const alpha = TLV.math.wrapPi(Math.atan2(dy, dx) - veh.h);
    const delta = Math.atan2(2 * veh.wheelbase * Math.sin(alpha), Math.hypot(dx, dy));
    c.steer = TLV.math.clamp(delta / TLV.player._steerMax(Math.abs(veh.v)), -1, 1);
    const want = a >= stopA ? 0 : cruise;
    if (want === 0) c.brake = veh.v > 0.1 ? 1 : 0;
    else if (veh.v < want) c.throttle = 0.45;
    else if (veh.v > want + 0.3) c.brake = 0.4;
    return c;
  };
}

/** Holds fields of ControlState each tick, whatever else the source does. */
export function hold(fields) {
  const TLV = realTLV();
  const c = TLV.const._newControls();
  return () => Object.assign(c, TLV.const._newControls(), fields);
}

/** Takes the car to a door's reach and parks it now, then waits for the next errand. */
export function nextErrand(S, opts = {}) {
  const TLV = realTLV();
  const index = S.game.errandIndex;
  TLV.debug.parkNow(opts);
  until(S, (s) => s.game.errandIndex !== index || s.game.phase === 'RUN_END', 12, 'next errand');
}

export { assert };
