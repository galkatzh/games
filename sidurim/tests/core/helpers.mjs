// tests/core/helpers.mjs — WP-CORE
// Shared test setup. Core tests load js/core only and stub everything else, so they keep proving the core contract
// unchanged after the other packages land.
import { createTLV } from '../../tools/lib/classic.mjs';

/** @returns {string[]} The js/core entries of the manifest. */
export function coreFiles() {
  return createTLV({ files: [] }).manifest.sim.filter((f) => f.startsWith('js/core/'));
}

/**
 * @param {object} [params] Partial params.
 * @returns {object} A TLV holding only js/core.
 */
export function coreTLV(params) {
  return createTLV({ files: coreFiles(), params });
}

/** Runs fn with console.warn captured. @returns {string[]} The warnings. */
export function captureWarnings(fn) {
  const original = console.warn;
  const seen = [];
  console.warn = (...args) => seen.push(args.join(' '));
  try {
    fn();
  } finally {
    console.warn = original;
  }
  return seen;
}

/** Every system the sim calls, as [path, name] pairs, in table order, for the step table of ARCHITECTURE 9.2. */
export const STEP_TABLE = [
  ['world.signals', 'update'], ['game.flow', 'preUpdate'], ['game.director', 'update'], ['traffic', 'update'],
  ['peds', 'update'], ['player', 'update'], ['foot', 'update'], ['collide', 'update'], ['game.parking', 'update'],
  ['game.knife', 'update'], ['game.score', 'update'], ['game.flow', 'postUpdate'], ['traffic', 'maintain'], ['peds', 'maintain']
];

/** The init chain of ARCHITECTURE 12.1.8. */
export const INIT_CHAIN = [
  ['world.parking', 'init'], ['world.signals', 'init'], ['player', 'init'], ['traffic', 'init'], ['peds', 'init'], ['game.flow', 'init']
];

/**
 * Installs one recording spy per system.
 * @param {object} TLV Core-only TLV.
 * @returns {string[]} Grows with 'path.name' on each call.
 */
export function installSpies(TLV) {
  const calls = [];
  for (const [path, name] of [...INIT_CHAIN, ...STEP_TABLE]) {
    TLV.ns(path)[name] = () => { calls.push(`${path}.${name}`); };
  }
  return calls;
}

/**
 * Installs a small stand-in for the other packages that really uses the seeded streams, so hashes mean something:
 * cars and people wander with their own streams, the bot draws from its own, and the player follows S.controls.
 * @param {object} TLV Core-only TLV.
 * @param {object} [opts]
 * @param {number} [opts.cars] Active cars. Default 20.
 * @param {number} [opts.people] Active people. Default 10.
 */
export function installStubSystems(TLV, { cars = 20, people = 10 } = {}) {
  const { SURF } = TLV.const;
  const noop = () => {};

  TLV.ns('world.parking').init = (S) => { S.parking = { overrides: new Map() }; };
  TLV.ns('world.signals').init = (S) => { S.sig = { clock: 0, epoch: 0, slot: new Int8Array(0), state: new Int8Array(0), forced: null }; };
  TLV.ns('world.signals').update = (S) => { S.sig.clock = S.t + S.sig.epoch; };

  TLV.ns('player').init = (S) => {
    const veh = S.vehicles[0];
    Object.assign(veh, { id: 0, active: true, isPlayer: true, mode: 'FREE', kind: 'hatch' });
    S.player = {
      mode: 'DRIVE', veh, fx: 0, fy: 0, surface: SURF.ROAD, laneId: -1, lat: 0, wrongWay: false, launchT: 0,
      foot: { active: false, x: 0, y: 0, h: 0, v: 0, px: 0, py: 0, ph: 0, stumbleT: 0, invulnT: 0, slowT: 0, sidestepT: 0, sidestepCd: 0, anim: 'idle' }
    };
  };
  TLV.ns('player').update = (S, dt) => {
    const veh = S.vehicles[0];
    veh.v += (S.controls.throttle - S.controls.brake) * dt;
    veh.h += S.controls.steer * dt;
    veh.x += Math.cos(veh.h) * veh.v * dt;
    veh.y += Math.sin(veh.h) * veh.v * dt;
    S.player.fx = veh.x;
    S.player.fy = veh.y;
  };
  TLV.ns('foot').update = noop;
  TLV.ns('collide').update = noop;

  TLV.ns('traffic').init = (S) => {
    S.traffic = { stats: { count: 0, cap: cars, meanSpeed: 0, stationaryShare: 0, removals: 0, wrecks: 0 } };
    for (let i = 1; i <= cars; i++) {
      const veh = S.vehicles[i];
      Object.assign(veh, { id: i, active: true, x: S.rng.spawn.range(-100, 100), y: S.rng.spawn.range(-100, 100), v: 5 });
    }
  };
  TLV.ns('traffic').update = (S, dt) => {
    for (let i = 1; i <= cars; i++) {
      const veh = S.vehicles[i];
      veh.h += S.rng.traffic.range(-1, 1) * dt;
      veh.x += Math.cos(veh.h) * veh.v * dt;
      veh.y += Math.sin(veh.h) * veh.v * dt;
    }
  };
  TLV.ns('traffic').maintain = noop;

  TLV.ns('peds').init = (S) => {
    S.pedsys = {};
    for (let i = 0; i < people; i++) {
      Object.assign(S.peds[i], { id: i + 1, active: true, x: S.rng.ped.range(-50, 50), y: S.rng.ped.range(-50, 50) });
    }
  };
  TLV.ns('peds').update = (S, dt) => {
    for (let i = 0; i < people; i++) S.peds[i].x += S.rng.ped.range(-1, 1) * dt;
  };
  TLV.ns('peds').maintain = noop;

  const flow = TLV.ns('game.flow');
  flow.init = (S) => { S.game = TLV.const.newGameState(); S.game.phase = 'DRIVE'; };
  flow.preUpdate = (S, dt) => { S.game.clock -= dt; };
  flow.postUpdate = noop;
  TLV.ns('game.director').update = (S) => { if (S.rng.event.bool(0.01)) S.game.money += 1; };
  TLV.ns('game.parking').update = noop;
  TLV.ns('game.knife').update = noop;
  TLV.ns('game.score').update = noop;
}

/**
 * A bot that spends S.rng.bot on every tick, so its stream advances in a recorded run and not in a replay.
 * @returns {function(object):object} controlSource.
 */
export function randomBot() {
  return (S) => {
    S.controls.throttle = S.rng.bot.next();
    S.controls.brake = S.rng.bot.bool(0.2) ? 1 : 0;
    S.controls.steer = S.rng.bot.range(-1, 1);
    S.controls.handbrake = S.rng.bot.bool(0.05);
    return S.controls;
  };
}
