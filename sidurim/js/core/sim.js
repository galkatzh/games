// js/core/sim.js — WP-CORE
// Sim creation and the fixed step. The order of systems is binding (ARCHITECTURE 9.2).
(function (TLV) {
  'use strict';

  var sim = TLV.ns('sim');

  /** Every stream, and the ones in the hash. bot is left out so a replay without the bot matches (ARCHITECTURE 9.3). */
  var STREAMS = ['traffic', 'spawn', 'ped', 'event', 'game', 'foot', 'bot'];
  var HASHED_STREAMS = ['traffic', 'spawn', 'ped', 'event', 'game', 'foot'];

  /** Each is both a param and a key of S.flags. */
  var FLAGS = ['traffic', 'peds', 'incidents'];

  /** Builds a table row for a function found at TLV.<path>.<fn>, looked up on every call so spies and stubs work. */
  function row(path, fn) {
    return { path: path.split('.'), fn: fn, label: 'TLV.' + path + '.' + fn };
  }

  var R_SIGNALS = row('world.signals', 'update');
  var R_FLOW_PRE = row('game.flow', 'preUpdate');
  var R_DIRECTOR = row('game.director', 'update');
  var R_TRAFFIC = row('traffic', 'update');
  var R_PEDS = row('peds', 'update');
  var R_PLAYER = row('player', 'update');
  var R_FOOT = row('foot', 'update');
  var R_COLLIDE = row('collide', 'update');
  var R_PARKING = row('game.parking', 'update');
  var R_KNIFE = row('game.knife', 'update');
  var R_SCORE = row('game.score', 'update');
  var R_FLOW_POST = row('game.flow', 'postUpdate');
  var R_TRAFFIC_MAINTAIN = row('traffic', 'maintain');
  var R_PEDS_MAINTAIN = row('peds', 'maintain');

  var STEP_ROWS = [
    R_SIGNALS, R_FLOW_PRE, R_DIRECTOR, R_TRAFFIC, R_PEDS, R_PLAYER, R_FOOT, R_COLLIDE,
    R_PARKING, R_KNIFE, R_SCORE, R_FLOW_POST, R_TRAFFIC_MAINTAIN, R_PEDS_MAINTAIN
  ];

  var R_INIT_PARKING = row('world.parking', 'init');
  var R_INIT_SIGNALS = row('world.signals', 'init');
  var R_INIT_PLAYER = row('player', 'init');
  var R_INIT_TRAFFIC = row('traffic', 'init');
  var R_INIT_PEDS = row('peds', 'init');
  var R_INIT_FLOW = row('game.flow', 'init');

  var INIT_ROWS = [R_INIT_PARKING, R_INIT_SIGNALS, R_INIT_PLAYER, R_INIT_TRAFFIC, R_INIT_PEDS, R_INIT_FLOW];

  /** @returns {?object} The module holding this row's function, or null if it does not exist yet. */
  function moduleOf(r) {
    var node = TLV;
    for (var i = 0; i < r.path.length; i++) {
      node = node[r.path[i]];
      if (!node) return null;
    }
    return typeof node[r.fn] === 'function' ? node : null;
  }

  /** Warns the first time this sim skips a row. */
  function skipped(S, r) {
    if (S._warned[r.label]) return;
    S._warned[r.label] = true;
    console.warn('TLV.sim: ' + r.label + ' is missing, skipped');
  }

  /** Calls a row with (S). */
  function call1(S, r) {
    var mod = moduleOf(r);
    if (mod) mod[r.fn](S);
    else skipped(S, r);
  }

  /** Calls a row with (S, dt). */
  function call2(S, r, dt) {
    var mod = moduleOf(r);
    if (mod) mod[r.fn](S, dt);
    else skipped(S, r);
  }

  /** Throws a clear error for anything missing from the step table or init chain, unless allowMissing is on. */
  function requireSystems(S) {
    if (S._allowMissing) return;
    var missing = [];
    INIT_ROWS.concat(STEP_ROWS).forEach(function (r) {
      if (!moduleOf(r)) missing.push(r.label);
    });
    if (missing.length) {
      throw new Error('TLV.sim.create: missing ' + missing.join(', ') + '. Pass allowMissing: true to test a package alone.');
    }
  }

  /** Picks the control source (ARCHITECTURE 12.1.8, step 3). */
  function chooseControlSource(S, opts) {
    if (opts.controlSource) return opts.controlSource;
    if (S.params.autoplay) {
      if (TLV.bots && typeof TLV.bots.create === 'function') return TLV.bots.create(S.params.autoplay);
      if (!S._allowMissing) throw new Error('TLV.sim.create: autoplay needs TLV.bots.create');
      console.warn('TLV.sim: TLV.bots is missing, ignoring autoplay=' + S.params.autoplay);
    }
    return function (s) { return s.controls; };
  }

  /** Activates slot 0 the way player.init does, for a run without WP-PLAYER. */
  function fillPlayer(S) {
    var veh = S.vehicles[0];
    var size = TLV.const.VEHICLE_SIZES.hatch;
    veh.id = 0;
    veh.active = true;
    veh.isPlayer = true;
    veh.mode = 'FREE';
    veh.kind = 'hatch';
    veh.length = size.length;
    veh.width = size.width;
    veh.wheelbase = size.wheelbase;
    S.player = {
      mode: 'DRIVE', veh: veh, fx: 0, fy: 0,
      surface: TLV.const.SURF.ROAD, laneId: -1, lat: 0, wrongWay: false, launchT: 0,
      foot: {
        active: false, x: 0, y: 0, h: 0, v: 0, px: 0, py: 0, ph: 0,
        stumbleT: 0, invulnT: 0, slowT: 0, sidestepT: 0, sidestepCd: 0,
        anim: 'idle'
      }
    };
  }

  /**
   * Creates a sim (ARCHITECTURE 12.1.8).
   * @param {object} opts { seed?, world, params?, controlSource?, allowMissing?, flags?: {traffic, peds, incidents} }.
   *   flags override the traffic, peds and incidents params, and S.params is updated to match, so a replay header says
   *   what ran. Without allowMissing, a hole in the step table or the init chain throws here, listing all of them,
   *   instead of failing on some later tick.
   * @returns {object} SimState.
   */
  sim.create = function (opts) {
    var o = opts || {};
    var C = TLV.const;
    var i;

    var params = TLV.config.normalize(o.params);
    var seed = o.seed !== undefined && o.seed !== null ? o.seed : (params.seed !== null ? params.seed : 1);
    params.seed = seed;

    var flagsIn = o.flags || {};
    var flags = {};
    FLAGS.forEach(function (name) {
      flags[name] = flagsIn[name] !== undefined ? !!flagsIn[name] : !!params[name];
      params[name] = flags[name] ? 1 : 0;
    });
    var S = {
      seed: seed, tick: 0, t: 0, timeScale: 1, params: params,
      flags: flags,
      world: o.world || null,
      bus: TLV.events.createBus(),
      rng: {},
      vehicles: [], peds: [],
      player: null, parking: null, sig: null, traffic: null, pedsys: null, game: null,
      controls: C._newControls(),
      controlSource: null,
      recorder: null,
      invariantFailures: [],
      _allowMissing: !!o.allowMissing,
      _warned: {},
      _input: null,
      _invariantTotal: 0,
      _invariantCounts: {}
    };
    STREAMS.forEach(function (name) {
      S.rng[name] = TLV.rng.create(TLV.rng.hash32(seed, name));
    });
    requireSystems(S);

    S.controlSource = chooseControlSource(S, o);

    for (i = 0; i < C.MAX_VEHICLES; i++) S.vehicles.push(C.newVehicle(i));
    for (i = 0; i < C.MAX_PEDS; i++) S.peds.push(C.newPedestrian(i));

    S.recorder = params.record ? TLV.replay.createRecorder(S) : null;

    call1(S, R_INIT_PARKING);
    call1(S, R_INIT_SIGNALS);
    call1(S, R_INIT_PLAYER);
    if (!S.player && S._allowMissing) fillPlayer(S);
    call1(S, R_INIT_TRAFFIC);
    call1(S, R_INIT_PEDS);
    call1(S, R_INIT_FLOW);
    if (!S.game && S._allowMissing) {
      S.game = C.newGameState();
      S.game.phase = 'DRIVE';
    }
    return S;
  };

  /**
   * Copies pose to previous pose for active vehicles, pedestrians and the on-foot player.
   * @param {object} S Sim state.
   */
  sim.snapshot = function (S) {
    var i;
    var list = S.vehicles;
    for (i = 0; i < list.length; i++) {
      var v = list[i];
      if (v.active) {
        v.px = v.x;
        v.py = v.y;
        v.ph = v.h;
      }
    }
    list = S.peds;
    for (i = 0; i < list.length; i++) {
      var p = list[i];
      if (p.active) {
        p.px = p.x;
        p.py = p.y;
        p.ph = p.h;
      }
    }
    var foot = S.player && S.player.foot;
    if (foot) {
      foot.px = foot.x;
      foot.py = foot.y;
      foot.ph = foot.h;
    }
  };

  /** Row 2: control source, then setInput overrides, then the recorder. */
  function readControls(S) {
    var controls = S.controlSource(S);
    if (controls) S.controls = controls;
    var over = S._input;
    if (over) {
      for (var key in over) S.controls[key] = over[key];
    }
    if (S.recorder) S.recorder.record(S.controls);
  }

  /**
   * Runs one tick. S.flags gates only rows 5, 6, 7, 15 and 16; every other system is called each tick and gates itself.
   * @param {object} S Sim state.
   */
  sim.step = function (S) {
    var DT = TLV.const.DT;
    S.tick++;                                                   // 0
    S.t = S.tick * DT;
    sim.snapshot(S);                                            // 1
    readControls(S);                                            // 2
    call1(S, R_SIGNALS);                                        // 3
    call2(S, R_FLOW_PRE, DT);                                   // 4
    if (S.flags.incidents) call2(S, R_DIRECTOR, DT);            // 5
    if (S.flags.traffic) call2(S, R_TRAFFIC, DT);               // 6
    if (S.flags.peds) call2(S, R_PEDS, DT);                     // 7
    call2(S, R_PLAYER, DT);                                     // 8
    call2(S, R_FOOT, DT);                                       // 9
    call2(S, R_COLLIDE, DT);                                    // 10
    call2(S, R_PARKING, DT);                                    // 11
    call2(S, R_KNIFE, DT);                                      // 12
    call2(S, R_SCORE, DT);                                      // 13
    call2(S, R_FLOW_POST, DT);                                  // 14
    if (S.flags.traffic) call2(S, R_TRAFFIC_MAINTAIN, DT);      // 15
    if (S.flags.peds) call2(S, R_PEDS_MAINTAIN, DT);            // 16
    if (S.params.invariants && S.tick % 60 === 0) TLV.invariants.run(S);  // 17
  };

  /** FNV-1a over the fields of ARCHITECTURE 9.4, as float64, or rounded to float32 first if coarse. */
  function hashState(S, coarse) {
    var word = new Float64Array(1);
    var bytes = new Uint8Array(word.buffer);
    var h = 2166136261 | 0;

    function add(v) {
      var x = coarse ? Math.fround(v) : v;
      word[0] = x !== x ? NaN : x + 0;
      for (var b = 0; b < 8; b++) h = Math.imul(h ^ bytes[b], 16777619);
    }

    var i;
    add(S.tick);
    for (i = 0; i < S.vehicles.length; i++) {
      var car = S.vehicles[i];
      if (car.active) {
        add(car.id);
        add(car.x);
        add(car.y);
        add(car.h);
        add(car.v);
        add(car.laneId);
      }
    }
    for (i = 0; i < S.peds.length; i++) {
      var ped = S.peds[i];
      if (ped.active) {
        add(ped.id);
        add(ped.x);
        add(ped.y);
        add(ped.h);
      }
    }
    var foot = S.player && S.player.foot;
    add(foot ? foot.x : 0);
    add(foot ? foot.y : 0);
    add(foot ? foot.h : 0);
    var g = S.game;
    add(g ? g.clock : 0);
    add(g ? g.money : 0);
    add(g ? g.hp : 0);
    add(g && g.difficulty ? TLV.rng.hashStr(g.difficulty) : 0);
    for (i = 0; i < HASHED_STREAMS.length; i++) {
      // RNG state is an exact integer, and float32 cannot hold one.
      word[0] = S.rng[HASHED_STREAMS[i]].state();
      for (var b = 0; b < 8; b++) h = Math.imul(h ^ bytes[b], 16777619);
    }
    return h >>> 0;
  }

  /**
   * Hash of the sim state (ARCHITECTURE 9.4). Rare by design, so it may allocate.
   * -0 is folded into 0 and every NaN into one pattern: neither difference is a real state difference, and neither
   * survives a JSON round trip.
   * It is exact, so it holds within one JS engine only. Chromium's V8 and Node 21's V8 give different last bits for
   * Math.sin, cos, atan2, exp, log and pow, so never compare this value between a browser and Node.
   * @param {object} S Sim state.
   * @returns {number} uint32.
   */
  sim.hash = function (S) {
    return hashState(S, false);
  };

  /**
   * The same hash with every pose field rounded to float32, about 0.1 mm at city scale. It absorbs those last-bit
   * differences, so it can compare a browser run with Node. Private to WP-CORE, for tests/e2e/replay.e2e.cjs.
   * @param {object} S Sim state.
   * @returns {number} uint32.
   */
  sim._hashFloat32 = function (S) {
    return hashState(S, true);
  };
})(window.TLV);
