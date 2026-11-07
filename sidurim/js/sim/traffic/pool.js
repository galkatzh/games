// js/sim/traffic/pool.js — WP-TRAFFIC
// Slots of S.vehicles and each car's private record. Records are reused, so a spawn allocates nothing after the first use of
// a slot. Slot 0 is the player's and is never in the free list.
(function (TLV) {
  'use strict';

  var pool = TLV.ns('traffic.pool');

  /** Connectors a car can plan ahead, hold at once, and paths its tail can trail over. */
  pool.PLAN = 6;
  pool.HELD = 8;
  pool.BACK = 4;
  pool.NEAR = 48;

  /** @returns {object} A private record with every field it will ever hold. */
  function newRecord() {
    return {
      // Driver.
      vf: 1, curve: 1, T: 1.5, s0: 2, a: 1.5, b: 2.5, polite: 0.5, thresh: 0.2, safeB: 3,
      halfL: 2.2, halfW: 0.9, diag: 2.4,
      cosH: 1, sinH: 0, rearX: 0, rearY: 0, share: 0,
      // Plan, grants and held connectors.
      plan: new Int32Array(pool.PLAN), pn: 0, pg: 0,
      held: new Int32Array(pool.HELD), hEnd: new Float64Array(pool.HELD), hRes: new Float64Array(pool.HELD), hn: 0,
      back: new Int32Array(pool.BACK), backLen: new Float64Array(pool.BACK), backN: 0,
      odo: 0, acc: 0, route: null, ri: 0, routeT: 0, mustLane: -1,
      // Gate.
      lineD: Infinity, why: 0, waitT: 0, arrive: -1, requesting: false, runRed: -1, decided: -1, jumpCycle: -1, lastGrantT: 0,
      // Leader, from the last step.
      lead: -1, leadGap: Infinity, leadV: 0, leadSame: false, slowT: 0, blockedT: 0,
      // People and sensors, refreshed at 10 Hz and carried down by travel between refreshes.
      pedGap: Infinity, pedV: 0, zoneGap: Infinity, sensorGap: Infinity, sensorV: 0, soft: false,
      // Lateral and lane change.
      latT: 0, latR: 1, lcFrom: -1, lcTo: -1, lcT: 0, lcDur: 0, lcW: 0, lcDs: 0, lcDir: 1, lcHeld: 0, lcCool: 0,
      // Opposite lane, while overtaking on a two-way road.
      oppLane: -1, oppRef: 0, oppS: 0, oppW: 0,
      // Neighbours for the contact net.
      near: new Int32Array(pool.NEAR), nearN: 0,
      // Behaviour.
      duePhantom: 0.5, dueDouble: 0.5, dueDrop: 0.5, sight: 0,
      timer: 0, stage: 0, stopS: -1, capV: Infinity, forceA: NaN, aim: null, target: -1, capped: false, exempt: false,
      honkT: 0, honkAt: -1, hornT: 0, hornBoostT: 0, tailCool: 0, tailHornT: 0, busCool: 0, doorT: 0, spawnedPed: false,
      tailClosed: false, tailLost: 0, tailRoute: false,
      passenger: false, doorKind: 0, gapS: 0, noseConn: -1, reverse: 0, reverseLeft: 0, ovLead: -1, ovMode: 0, ovLane: -1, ovAbort: false,
      ovSide: 0, ovFast: false, easeDown: false,
      // Off-path obstacles and scripts.
      obLane: -1, obS: 0, obLat: 0,
      px0: 0, py0: 0, ph0: 0, px1: 0, py1: 0, ph1: 0, sT: 0, sDur: 0, sDone: false, vxD: 0, vyD: 0, spin: 0, dynT: 0,
      // Parking.
      spotId: -1, spotPrior: 0, ctl: null, raceSpot: -1, raceStage: 0, raceFromCommit: false,
      sKind: 0, rejoinLane: -1, rejoinS: 0, towReason: 'script', standoffDoor: 0, netN: 0, netP: new Array(8),
      // Diagnostics.
      contactT: 0
    };
  }

  /**
   * Creates the slot lists.
   * @param {object} S Sim state.
   */
  pool.init = function (S) {
    var n = S.vehicles.length;
    var T = S.traffic;
    T.free = new Int32Array(n);
    T.nFree = 0;
    for (var slot = n - 1; slot >= 1; slot--) T.free[T.nFree++] = slot;
    T.act = new Int32Array(n);
    T.nAct = 0;
    T.nextId = 1;
  };

  /** Puts a slot into the active list, which stays sorted so a tick visits cars in slot order. */
  function activate(T, slot) {
    var i = T.nAct++;
    while (i > 0 && T.act[i - 1] > slot) {
      T.act[i] = T.act[i - 1];
      i--;
    }
    T.act[i] = slot;
  }

  /** Takes a slot out of the active list. */
  function deactivate(T, slot) {
    var n = T.nAct;
    var i = 0;
    while (i < n && T.act[i] !== slot) i++;
    if (i === n) return;
    for (; i + 1 < n; i++) T.act[i] = T.act[i + 1];
    T.nAct = n - 1;
  }

  /**
   * Draws the time to a car's next event of a kind.
   * @param {object} rng Stream.
   * @param {number} rate Events per car per minute.
   * @returns {number} Seconds.
   */
  pool.nextDue = function (rng, rate) {
    return -Math.log(1 - rng.next()) * 60 / rate;
  };

  /**
   * Allocates a vehicle with its driver sampled.
   * @param {object} S Sim state.
   * @param {string} kind Vehicle kind.
   * @param {number} variant Palette, 0..7.
   * @param {number} ag Aggression, 0..1.
   * @returns {?object} Vehicle, active, placed nowhere yet. Null when the pool is full.
   */
  pool.take = function (S, kind, variant, ag) {
    var T = S.traffic;
    if (T.nFree === 0) return null;
    var slot = T.free[--T.nFree];
    var veh = S.vehicles[slot];
    var C = TLV.const;
    var Q = TLV.tune.traffic;
    var size = C.VEHICLE_SIZES[kind];
    var t = veh._t;
    if (t.plan === undefined) {
      t = newRecord();
      veh._t = t;
    }
    veh.id = T.nextId++;
    veh.active = true;
    veh.isPlayer = false;
    veh.kind = kind;
    veh.variant = variant;
    veh.length = size.length;
    veh.width = size.width;
    veh.wheelbase = size.wheelbase;
    veh.x = 0; veh.y = 0; veh.h = 0; veh.px = 0; veh.py = 0; veh.ph = 0;
    veh.v = 0; veh.vx = 0; veh.vy = 0; veh.yawRate = 0; veh.accel = 0; veh.steer = 0;
    veh.mode = 'LANE'; veh.laneId = -1; veh.connId = -1; veh.s = 0; veh.lat = 0;
    veh.lights = 0; veh.horn = false; veh.door = 0;
    veh.beh = 'CRUISE'; veh.behT = 0; veh.ag = ag; veh.stuckT = 0;

    t.vf = Q.speedBase + Q.speedAg * ag;
    t.curve = Q.curveBase + Q.curveAg * ag;
    t.T = Q.headwayBase + Q.headwayAg * ag;
    t.s0 = Q.gapBase + Q.gapAg * ag;
    t.a = Q.accelBase + Q.accelAg * ag;
    t.b = Q.brakeBase + Q.brakeAg * ag;
    t.polite = Q.politeBase * (1 - ag);
    t.thresh = Q.threshBase + Q.threshAg * ag;
    t.safeB = Q.safeBrakeBase + Q.safeBrakeAg * ag;
    t.halfL = size.length / 2;
    t.halfW = size.width / 2;
    t.diag = Math.sqrt(t.halfL * t.halfL + t.halfW * t.halfW);
    t.cosH = 1; t.sinH = 0; t.rearX = 0; t.rearY = 0; t.share = 0;

    t.pn = 0; t.pg = 0; t.hn = 0; t.backN = 0;
    t.odo = 0; t.acc = 0; t.route = null; t.ri = 0; t.routeT = 0; t.mustLane = -1;
    t.lineD = Infinity; t.why = 0; t.waitT = 0; t.arrive = -1; t.requesting = false; t.runRed = -1; t.decided = -1;
    t.jumpCycle = -1; t.lastGrantT = 0;
    t.lead = -1; t.leadGap = Infinity; t.leadV = 0; t.leadSame = false; t.slowT = 0; t.blockedT = 0;
    t.pedGap = Infinity; t.pedV = 0; t.zoneGap = Infinity; t.sensorGap = Infinity; t.sensorV = 0; t.soft = false;
    t.latT = 0; t.latR = 1; t.lcFrom = -1; t.lcTo = -1; t.lcT = 0; t.lcDur = 0; t.lcW = 0; t.lcDs = 0; t.lcCool = 0;
    t.lcDir = 1; t.lcHeld = 0;
    t.oppLane = -1; t.oppRef = 0; t.oppS = 0; t.oppW = 0;
    t.nearN = 0;
    t.timer = 0; t.stage = 0; t.stopS = -1; t.capV = Infinity; t.forceA = NaN; t.aim = null; t.target = -1; t.capped = false;
    t.exempt = false;
    t.honkT = 0; t.honkAt = -1; t.hornT = 0; t.hornBoostT = 0; t.tailCool = 0; t.tailHornT = 0; t.busCool = 0; t.doorT = 0;
    t.spawnedPed = false; t.passenger = false; t.doorKind = 0; t.gapS = 0; t.noseConn = -1; t.reverse = 0; t.reverseLeft = 0; t.ovLead = -1;
    t.ovMode = 0; t.ovLane = -1; t.ovAbort = false; t.ovSide = 0; t.ovFast = false; t.easeDown = false;
    t.tailClosed = false; t.tailLost = 0; t.tailRoute = false;
    t.obLane = -1; t.obS = 0; t.obLat = 0;
    t.sT = 0; t.sDur = 0; t.sDone = false; t.vxD = 0; t.vyD = 0; t.spin = 0; t.dynT = 0;
    t.duePhantom = pool.nextDue(S.rng.traffic, Q.phantomRate);
    t.dueDouble = pool.nextDue(S.rng.traffic, Q.doubleRate);
    t.dueDrop = pool.nextDue(S.rng.traffic, Q.dropRate);
    t.sight = 0;
    t.spotId = -1; t.spotPrior = 0; t.ctl = null; t.raceSpot = -1; t.raceStage = 0; t.raceFromCommit = false;
    t.sKind = 0; t.rejoinLane = -1; t.rejoinS = 0; t.towReason = 'script'; t.standoffDoor = 0; t.netN = 0;
    t.contactT = 0;
    activate(T, slot);
    return veh;
  };

  /**
   * Frees a vehicle's slot. Everything that has to be undone first goes through TLV.traffic.despawn.
   * @param {object} S Sim state.
   * @param {object} veh Vehicle.
   */
  pool.give = function (S, veh) {
    var T = S.traffic;
    deactivate(T, veh.slot);
    veh.active = false;
    T.free[T.nFree++] = veh.slot;
  };
})(window.TLV);
