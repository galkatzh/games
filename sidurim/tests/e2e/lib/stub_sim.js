// tests/e2e/lib/stub_sim.js — WP-CORE
// Stands in for every sim package, in a throwaway tree built by stub_tree.cjs. It implements just enough of the contract
// for the boot, the loop, the debug hooks and the e2e scripts to run. It proves the harness, never the game.
(function (TLV) {
  'use strict';

  var FOOT_SPEED = 6.4;

  function noop() {}

  /** Records one step of the boot, in the order it happened, for the order test in file_protocol. */
  function boot(step) {
    (TLV.bootLog = TLV.bootLog || []).push(step);
  }

  function markRegistered(pkg) {
    (TLV.registerLog = TLV.registerLog || []).push(pkg);
    boot('register ' + pkg);
  }

  // ---- World ----
  var maps = {};
  var world = TLV.ns('world');
  var map = TLV.ns('world.map');

  map.onMap = function (payload) {
    boot('drain');
    maps[payload.id] = payload;
  };
  map.payload = function (id) { return maps[id] || null; };
  world.build = function (payload) {
    boot('world.build');
    return { id: payload.id, meta: payload.meta, lanes: [], bounds: { minX: -400, minY: -400, maxX: 400, maxY: 400 } };
  };
  world.get = function (id) { return maps[id] ? world.build(maps[id]) : null; };
  world.register = function () {
    markRegistered('world');
    TLV.registry.on('map', map.onMap);
  };

  var signals = TLV.ns('world.signals');
  signals.init = function (S) { S.sig = { clock: 0, epoch: 0, slot: new Int8Array(0), state: new Int8Array(0), forced: null }; };
  signals.update = function (S) { S.sig.clock = S.t + S.sig.epoch; };
  TLV.ns('world.parking').init = function (S) { S.parking = { overrides: new Map() }; };

  // ---- Player ----
  var player = TLV.ns('player');
  player.register = function () {
    markRegistered('player');
    TLV.debug.register('teleport', function (x, y, h, v) {
      var S = TLV.debug.current();
      player.setPose(S, x, y, h === undefined ? 0 : h, v === undefined ? 0 : v);
      return true;
    });
  };
  player.init = function (S) {
    var veh = S.vehicles[0];
    veh.id = 0;
    veh.active = true;
    veh.isPlayer = true;
    veh.mode = 'FREE';
    veh.kind = 'hatch';
    S.player = {
      mode: 'DRIVE', veh: veh, fx: 0, fy: 0, surface: 0, laneId: -1, lat: 0, wrongWay: false, launchT: 0,
      foot: { active: false, x: 0, y: 0, h: 0, v: 0, px: 0, py: 0, ph: 0, stumbleT: 0, invulnT: 0, slowT: 0, sidestepT: 0, sidestepCd: 0, anim: 'idle' }
    };
  };
  player.setPose = function (S, x, y, h, v) {
    var body = S.player.mode === 'FOOT' ? S.player.foot : S.player.veh;
    body.x = body.px = x;
    body.y = body.py = y;
    body.h = body.ph = h;
    body.v = v;
    S.player.fx = x;
    S.player.fy = y;
  };
  player.update = function (S, dt) {
    if (S.player.mode === 'FOOT') return;
    var veh = S.player.veh;
    veh.v += (S.controls.throttle * 3 - S.controls.brake * 3 - veh.v * 0.1) * dt;
    veh.h += S.controls.steer * dt;
    veh.x += Math.cos(veh.h) * veh.v * dt;
    veh.y += Math.sin(veh.h) * veh.v * dt;
    S.player.fx = veh.x;
    S.player.fy = veh.y;
  };
  TLV.ns('collide').update = noop;

  var foot = TLV.ns('foot');
  foot.update = function (S, dt) {
    if (S.player.mode !== 'FOOT') return;
    var body = S.player.foot;
    body.x += S.controls.footX * FOOT_SPEED * dt;
    body.y += S.controls.footY * FOOT_SPEED * dt;
    S.player.fx = body.x;
    S.player.fy = body.y;
  };

  TLV.ns('bots').create = function (name) {
    return function (S) {
      var c = S.controls;
      c.throttle = 0.6;
      c.steer = name === 'patrol' ? S.rng.bot.range(-0.2, 0.2) : 0;
      return c;
    };
  };

  // ---- Traffic and people ----
  var traffic = TLV.ns('traffic');
  traffic.register = function () { markRegistered('traffic'); };
  traffic.init = function (S) {
    S.traffic = { stats: { count: 0, cap: 12, meanSpeed: 6, stationaryShare: 0.2, removals: 0, wrecks: 0 } };
    for (var i = 1; i <= 12; i++) {
      var veh = S.vehicles[i];
      veh.id = i;
      veh.active = true;
      veh.x = S.rng.spawn.range(-120, 120);
      veh.y = S.rng.spawn.range(-120, 120);
      veh.v = 5;
    }
  };
  traffic.update = function (S, dt) {
    for (var i = 1; i <= 12; i++) {
      var veh = S.vehicles[i];
      veh.h += S.rng.traffic.range(-0.5, 0.5) * dt;
      veh.x += Math.cos(veh.h) * veh.v * dt;
      veh.y += Math.sin(veh.h) * veh.v * dt;
    }
  };
  traffic.maintain = noop;

  var peds = TLV.ns('peds');
  peds.register = function () { markRegistered('peds'); };
  peds.init = function (S) {
    S.pedsys = {};
    for (var i = 0; i < 6; i++) {
      S.peds[i].id = i + 1;
      S.peds[i].active = true;
      S.peds[i].x = S.rng.ped.range(-40, 40);
      S.peds[i].y = S.rng.ped.range(-40, 40);
    }
  };
  peds.update = function (S, dt) {
    for (var i = 0; i < 6; i++) S.peds[i].x += S.rng.ped.range(-1, 1) * dt;
  };
  peds.maintain = noop;

  // ---- Game: a toy of the real flow, only as deep as the e2e scripts look ----
  var CARD_TICKS = 60;
  var ERRAND_TICKS = 240;
  var DOOR = { x: 40, y: 0 };
  var flow = TLV.ns('game.flow');
  var game = TLV.ns('game');
  var director = TLV.ns('game.director');
  var knife = TLV.ns('game.knife');

  function startRun(S) {
    S.game = TLV.const.newGameState();
    S.game.phase = 'CARD';
    S.game.errand = { defId: 'stub', doorX: DOOR.x, doorY: DOOR.y, bayId: 1 };
    S.bus.emit('run.start', { seed: S.seed });
    S.bus.emit('errand.start', { index: 0, defId: 'stub' });
  }

  game.register = function () {
    markRegistered('game');
    TLV.registry.on('errand', noop);
    TLV.registry.on('incident', noop);
    TLV.registry.on('spawn', noop);
    TLV.q.push(['incident', { id: 'STUB_INCIDENT' }]);

    TLV.debug.register('startRun', function () {
      startRun(TLV.debug.current());
      return true;
    });
    TLV.debug.register('setStrikes', function (n) {
      var S = TLV.debug.current();
      if (S.game.knife) S.game.knife.strikes = n;
      return true;
    });
    TLV.debug.register('forceKnife', function (opts) {
      var S = TLV.debug.current();
      var o = opts || {};
      S.game.phase = 'ENCOUNTER';
      S.game.knife = {
        stage: o.stage || 'STANDOFF', stageT: 0, tugBar: 1, attackerId: 1, rivalVehId: 1, gap: o.gap === undefined ? 12 : o.gap,
        strikes: 0, lunge: 'NONE', lungeT: 0, outOfSightT: 0, shaken: false, shakenT: 0, exit: null
      };
      S.player.mode = 'FOOT';
      S.player.foot.active = true;
      S.player.foot.x = S.player.veh.x;
      S.player.foot.y = S.player.veh.y;
      return true;
    });
  };

  flow.init = function (S) {
    boot('sim.create');
    S.game = TLV.const.newGameState();
  };
  flow.preUpdate = function (S, dt) {
    var g = S.game;
    g.phaseT += dt;
    if (g.phase === 'TITLE' && (S.params.notitle || S.controls.start)) startRun(S);
    if (g.phase === 'CARD' && g.phaseT * 60 >= CARD_TICKS) {
      g.phase = 'DRIVE';
      g.phaseT = 0;
    }
    if (g.phase === 'DRIVE' && S.params.autoplay === 'errands' && g.phaseT * 60 >= ERRAND_TICKS) {
      g.stats.errandsDone++;
      g.phase = 'CARD';
      g.phaseT = 0;
    }
  };
  flow.postUpdate = function (S) {
    var k = S.game.knife;
    if (k && k.strikes >= 3 && S.game.phase !== 'RUN_END') {
      k.exit = 'CAUGHT';
      S.game.phase = 'RUN_END';
      S.game.endReason = 'CAUGHT';
    }
  };
  director.update = noop;
  TLV.ns('game.parking').update = noop;
  TLV.ns('game.score').update = noop;

  knife.update = function (S, dt) {
    var k = S.game.knife;
    if (!k || k.exit) return;
    k.stageT += dt;
    if (k.stage !== 'CHASE') {
      if (k.stageT > 1) {
        k.stage = 'CHASE';
        k.stageT = 0;
      }
      return;
    }
    if (Math.hypot(S.player.foot.x - DOOR.x, S.player.foot.y - DOOR.y) < 2) k.exit = 'REACHED_SHOP';
    else if (k.gap >= 18 && k.stageT >= 6) k.exit = 'SHAKEN';
    else if (k.stageT >= 25) k.exit = 'WHISTLE';
    else if (k.gap <= 3.5) {
      k.lungeT += dt;
      if (k.lungeT >= 1) {
        k.lungeT = 0;
        k.strikes++;
      }
    }
    if (k.exit) {
      S.game.phase = 'RESOLVE';
      S.game.phaseT = 0;
      S.bus.emit('knife.exit', { exit: k.exit });
    }
  };
})(window.TLV);
