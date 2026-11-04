// js/core/constants.js — WP-CORE
// Shared constants and factories for the pooled state objects (ARCHITECTURE 10 and 12.1.1).
(function (TLV) {
  'use strict';

  var C = TLV.ns('const');

  /** Fixed tick length, seconds. */
  C.DT = 1 / 60;
  C.TICK_HZ = 60;
  C.MAX_SUBSTEPS = 5;
  C.MAX_VEHICLES = 200;
  C.MAX_PEDS = 96;

  C.UNIT = 0.1;
  C.M_PER_DEG_LAT = 110888;
  C.M_PER_DEG_LON = 94415;

  C.ROAD = Object.freeze({ PRIMARY: 0, SECONDARY: 1, TERTIARY: 2, UNCLASSIFIED: 3, RESIDENTIAL: 4, LIVING: 5, SERVICE: 6 });
  C.LF = Object.freeze({ AI_ROUTABLE: 1, EXCLUSIVE: 2, NARROW: 4 });
  C.EF = Object.freeze({ ROUNDABOUT: 1, BRIDGE: 2, NARROW: 4, AI_F: 8, AI_B: 16, LINK: 32 });
  C.VL = Object.freeze({ BRAKE: 1, HAZARD: 2, BLINK_L: 4, BLINK_R: 8, REVERSE: 16, HIGH_BEAM: 32 });
  C.SURF = Object.freeze({ ROAD: 0, SIDEWALK: 1, PARK: 2, SAND: 3, WATER: 4 });
  C.SIG = Object.freeze({ GREEN: 0, AMBER: 1, RED: 2 });
  C.OCC = Object.freeze({ FREE: 0, PARKED: 1, VEHICLE: 2, MOTO: 3 });
  C.PAINT = Object.freeze({ NONE: 0, RED_WHITE: 1, RED_YELLOW: 2, BLUE_WHITE: 3 });
  C.POIF = Object.freeze({ NAMED: 1, INTERIOR: 2, SENSITIVE: 4, NO_FACADE: 8 });

  /** Every value of Vehicle.beh (ARCHITECTURE 10.3). */
  C.BEHAVIOURS = Object.freeze([
    'CRUISE', 'RED_RUN', 'TAILGATE', 'NOSE_IN', 'OVERTAKE_OUT', 'OVERTAKE_PASS', 'CUT_IN', 'PHANTOM_STOP',
    'DROP_APPROACH', 'DROPPED', 'PULLOUT', 'BUS_APPROACH', 'BUS_STOPPED', 'BUS_PULLOUT', 'DOUBLE_PARK', 'REVERSE_FOR_SPOT',
    'DOOR_OPEN', 'PARK_RACE', 'PARK_HOLD', 'RIVAL_BLOCK', 'RIVAL_STANDOFF', 'TOWED', 'PULL_OVER'
  ]);

  /** Every value of Pedestrian.state (ARCHITECTURE 10.4). */
  C.PED_STATES = Object.freeze([
    'WALK', 'WAIT_CROSS', 'CROSS_LEGAL', 'CROSS_SLOW', 'JAYWALK', 'RED_CROSS', 'STROLL_ROAD', 'DROPPED', 'FLEE', 'STUMBLE', 'SCRIPT'
  ]);

  /** Every value of GameState.phase (ARCHITECTURE 10.9). */
  C.PHASES = Object.freeze([
    'TITLE', 'CARD', 'DRIVE', 'SEARCH', 'HOLD', 'PAYOUT', 'BLOCKED', 'ENCOUNTER', 'RESOLVE', 'RUN_END'
  ]);

  /**
   * Body sizes, metres (ARCHITECTURE 10.2). The contract gives length and width; wheelbase is given only for the
   * player's hatch (GAME_DESIGN 4), so the rest are proportional defaults.
   */
  C.VEHICLE_SIZES = Object.freeze({
    hatch: Object.freeze({ length: 4.0, width: 1.75, wheelbase: 2.5 }),
    sedan: Object.freeze({ length: 4.4, width: 1.8, wheelbase: 2.7 }),
    taxi: Object.freeze({ length: 4.4, width: 1.8, wheelbase: 2.7 }),
    van: Object.freeze({ length: 5.2, width: 2.0, wheelbase: 3.2 }),
    bus: Object.freeze({ length: 12.0, width: 2.55, wheelbase: 6.5 }),
    truck: Object.freeze({ length: 7.5, width: 2.4, wheelbase: 4.2 })
  });

  /**
   * Runtime check that this very file was decoded as UTF-8: seven Hebrew letters, and fourteen characters if the page
   * lost its charset meta. Private to WP-CORE: the loader and tests/e2e/file_protocol.e2e.cjs read it.
   */
  C._charsetProbe = 'סידורים';

  /** ControlState field names, shared by sim.js and replay.js. Private to WP-CORE. */
  C._CONTROL_FLOATS = Object.freeze(['throttle', 'brake', 'steer', 'footX', 'footY']);
  C._CONTROL_BOOLS = Object.freeze(['handbrake', 'horn', 'interact', 'hazard', 'sidestep', 'start', 'restart', 'recover']);

  /**
   * Builds a zeroed ControlState (ARCHITECTURE 10.1). Private to WP-CORE.
   * @returns {object} ControlState with every field at rest.
   */
  C._newControls = function () {
    return {
      throttle: 0, brake: 0, steer: 0,
      handbrake: false, horn: false, interact: false, hazard: false,
      footX: 0, footY: 0,
      sidestep: false, start: false, restart: false, recover: false
    };
  };

  /**
   * Builds one pooled vehicle with every field defaulted and active false.
   * @param {number} slot Index in S.vehicles.
   * @returns {object} Vehicle (ARCHITECTURE 10.2).
   */
  C.newVehicle = function (slot) {
    var size = C.VEHICLE_SIZES.sedan;
    return {
      id: -1, slot: slot, active: false, isPlayer: false,
      kind: 'sedan', variant: 0,
      length: size.length, width: size.width, wheelbase: size.wheelbase,
      x: 0, y: 0, h: 0, px: 0, py: 0, ph: 0,
      v: 0, vx: 0, vy: 0, yawRate: 0, accel: 0, steer: 0,
      mode: 'LANE', laneId: -1, connId: -1, s: 0, lat: 0,
      lights: 0, horn: false, door: 0,
      beh: 'CRUISE', behT: 0, ag: 0, stuckT: 0,
      _t: {}
    };
  };

  /**
   * Builds one pooled pedestrian with every field defaulted and active false.
   * @param {number} slot Index in S.peds.
   * @returns {object} Pedestrian (ARCHITECTURE 10.4).
   */
  C.newPedestrian = function (slot) {
    return {
      id: -1, slot: slot, active: false,
      kind: 'walker', variant: 0,
      x: 0, y: 0, h: 0, px: 0, py: 0, ph: 0,
      v: 0, r: 0.35,
      state: 'WALK', stateT: 0, onRoad: false, intent: false,
      anim: 'idle', hasKnife: false,
      _p: {}
    };
  };

  /**
   * Builds a GameState with every field defaulted, at phase TITLE. flow.startRun resets from this.
   * clock and hp hold the design's start values (GAME_DESIGN 7 and 8.1); flow.startRun still applies S.params.clock.
   *
   * Read contract, added since ARCHITECTURE 10.9 froze: park.offM, park.yawDeg and park.would are live while park.stage is 'ARMED', and
   * null at any other stage. offM is metres off the bay's axis, yawDeg the degrees between the car and that axis either way along it,
   * and would is the grade capture would lock from this pose this tick: 'PERFECT', 'GOOD' or 'UGLY'. So a screen never has to work the
   * limits out for itself. Only parking.js writes them.
   * @returns {object} GameState (ARCHITECTURE 10.9).
   */
  C.newGameState = function () {
    return {
      phase: 'TITLE', phaseT: 0,
      clock: 120, money: 0, hp: 100,
      errandIndex: 0, errand: null, contest: null, knife: null,
      nav: {
        route: null, s: 0, remaining: Infinity, targetX: 0, targetY: 0, arrowH: 0,
        offRoute: false, offRouteT: 0, recalcT: 0
      },
      park: { stage: null, kind: null, bar: 0, x: 0, y: 0, h: 0, offM: null, yawDeg: null, would: null },
      chain: { n: 0, mult: 1, windowT: 0, bank: 0 },
      contacts: 0, pedHits: 0, pedHitThisErrand: false,
      knivesDone: 0, lastKnifeErrand: -1,
      heat: 0,
      director: { state: 'BUILD', stateT: 0, nextT: 0, incidents: [] },
      obstacles: [],
      stats: {
        honksReceived: 0, spotsStolen: 0, nearMisses: 0, contacts: 0, errandsDone: 0, redsRun: 0,
        incidents: { staged: 0, avoided: 0, hit: 0, aborted: 0, byId: {} }
      },
      endReason: null,
      rank: null
    };
  };
})(window.TLV);
