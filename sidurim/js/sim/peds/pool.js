// js/sim/peds/pool.js — WP-PEDS
// Slot allocation for S.peds (ARCHITECTURE 12.1.8: pool.js only allocates and frees). Records are created by sim.create, so a
// slot's private block is built once here and reused, which keeps every person the same shape for the life of the sim.
(function (TLV) {
  'use strict';

  var pool = TLV.ns('peds.pool');

  /** @returns {object} One person's private block, every field present. */
  function newPrivate() {
    return {
      // What is moving this person. mode: ROW, LINK, PATH, FREE, LANE, STAND. job: AMBIENT, CMD, SAVE, INSPECT.
      mode: 'STAND', job: 'AMBIENT',
      vx: 0, vy: 0, hT: 0, speed: 1.3, base: 1.3,
      // On a sidewalk row.
      sw: -1, s: 0, dir: 1, lat: 0, flips: 0, flipT: 0, crossCool: 0,
      // Free walk, with an optional waypoint.
      gx: 0, gy: 0, via: false, viaX: 0, viaY: 0, after: 'NONE', stuckT: 0, lastD: 0, gaveUp: false,
      // On a crossing path. stage: NONE, WAIT, INTENT, ROAD. plan: LEGAL, RED, JAY, STEP, SLOW, POP, STROLL, SALMON.
      path: null, own: null, arc: 0, pdir: 1, stage: 'NONE', plan: 'LEGAL', ox: 0, oy: 0,
      waitT: 0, gateT: 0, intentTick: 0, redAt: -1, hopped: false, hurry: false, force: false, through: false, median: false, home: -1, homeX: 0, homeY: 0,
      pauseAt: -1, pauseT: 0, roadState: 'CROSS_LEGAL', slide: 0, dwellLeft: 0, slowV: 0,
      // On a lane.
      laneId: -1, laneS: 0, laneDir: 1, laneLat: 0, laneLatGoal: 0, laneLeft: 0, laneT: 0, aside: false, restT: 0,
      // Commanded.
      aim: null, hold: false, spot: -1, writeT: 0,
      // Timers and flags.
      freezeT: 0, fleeT: 0, bellT: 0, recycle: false, kx: 0, ky: 0
    };
  }

  /**
   * Builds the free list and every private block.
   * @param {object} S Sim state.
   * @param {object} sys S.pedsys, being created.
   */
  pool.init = function (S, sys) {
    var n = S.peds.length;
    sys.free = new Int16Array(n);
    sys.nFree = n;
    sys.nextId = 1;
    for (var i = 0; i < n; i++) {
      sys.free[i] = n - 1 - i;
      S.peds[i]._p = newPrivate();
    }
  };

  /**
   * Takes a slot and readies its record. The caller places it.
   * @param {object} S Sim state.
   * @returns {?object} Pedestrian, or null when the pool is full.
   */
  pool.alloc = function (S) {
    var sys = S.pedsys;
    if (sys.nFree === 0) return null;
    var p = S.peds[sys.free[--sys.nFree]];
    var keepOwn = p._p.own;
    var fresh = newPrivate();
    fresh.own = keepOwn;
    p._p = fresh;
    p.id = sys.nextId++;
    p.active = true;
    p.kind = 'walker';
    p.variant = 0;
    p.v = 0;
    p.r = TLV.tune.peds.walkerR;
    p.state = 'WALK';
    p.stateT = 0;
    p.onRoad = false;
    p.intent = false;
    p.anim = 'idle';
    p.hasKnife = false;
    return p;
  };

  /**
   * Returns a slot to the pool.
   * @param {object} S Sim state.
   * @param {object} p Pedestrian.
   */
  pool.release = function (S, p) {
    var sys = S.pedsys;
    if (!p.active) return;
    p.active = false;
    p.intent = false;
    p.hasKnife = false;
    sys.free[sys.nFree++] = p.slot;
  };
})(window.TLV);
