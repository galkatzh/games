// tests/player/stubs/game_stub.js — WP-PLAYER, test only
// A private stand-in for WP-GAME: just the state and flow the `errands` bot reads, built to the contract in ARCHITECTURE
// 10.9 and the capture rules of GAME_DESIGN 12. It proves the bot against those rules, not against the real WP-GAME.
(function (TLV) {
  'use strict';

  var game = TLV.ns('game');
  var flow = TLV.ns('game.flow');
  var parking = TLV.ns('game.parking');
  var knife = TLV.ns('game.knife');
  var errands = TLV.ns('game.errands');

  var DOOR_MIN = 220;
  var DOOR_MAX = 700;
  var APPROACH = 140;

  game.register = function () {};

  /** Picks a door and a free stall near it, on a routable lane, and frees the stall. */
  function bind(S) {
    var W = S.world;
    var g = S.game;
    var veh = S.player.veh;
    var rng = S.rng.game;
    var ai = TLV.const.LF.AI_ROUTABLE;
    var ids = [];
    for (var tries = 0; tries < 400; tries++) {
      var poi = W.pois[rng.int(W.pois.length)];
      if (poi.flags & (TLV.const.POIF.SENSITIVE | TLV.const.POIF.NO_FACADE)) continue;
      var far = Math.hypot(poi.entX - veh.x, poi.entY - veh.y);
      if (far < DOOR_MIN || far > DOOR_MAX) continue;
      TLV.world.parking.spotsNear(W, poi.entX, poi.entY, 110, ids);
      for (var k = 0; k < ids.length; k++) {
        var spot = TLV.world.parking.spot(W, ids[rng.int(ids.length)]);
        if (Math.hypot(spot.x - poi.entX, spot.y - poi.entY) < 50) continue;
        if (!(W.lanes[spot.laneId].flags & ai)) continue;
        var route = TLV.world.routing.route(W, veh.x, veh.y, veh.h, spot.laneId, spot.laneS, { ai: true });
        if (!route) continue;
        TLV.world.parking.setState(S, spot.id, TLV.const.OCC.FREE);
        g.errand = {
          index: g.errandIndex, defId: 'stub', poiId: poi.id, doorX: poi.entX, doorY: poi.entY, routeLen: route.len,
          award: 60, bayId: spot.id, decoys: [], contests: 0
        };
        g.nav.route = route;
        g.nav.s = 0;
        g.nav.remaining = route.len;
        return true;
      }
    }
    return false;
  }

  function setPhase(S, phase) {
    S.game.phase = phase;
    S.game.phaseT = 0;
  }

  function startRun(S) {
    var fresh = TLV.const.newGameState();
    for (var key in fresh) S.game[key] = fresh[key];
    S._stub.parked = false;
    TLV.foot.exit(S);
    TLV.player.setLocked(S, true);
    bind(S);
    setPhase(S, 'CARD');
  }

  flow.init = function (S) {
    S.game = TLV.const.newGameState();
    S._stub = { parked: false, armT: 0, armed: false, q: 0, knifeEvery: S.params.knifeEvery || 0, done: 0, handbrake: false };
    errands.done = 0;
  };

  function updateNav(S) {
    var g = S.game;
    var nav = g.nav;
    if (!nav.route) return;
    var veh = S.player.veh;
    var p = TLV.world.routing.project(nav.route, veh.x, veh.y, nav.s, {});
    nav.s = p.s;
    nav.remaining = nav.route.len - p.s;
    if (p.d > 25) {
      var spot = TLV.world.parking.spot(S.world, g.errand.bayId);
      var again = TLV.world.routing.route(S.world, veh.x, veh.y, veh.h, spot.laneId, spot.laneS, { ai: true });
      if (again) {
        nav.route = again;
        nav.s = 0;
        nav.remaining = again.len;
      }
    }
  }

  flow.preUpdate = function (S, dt) {
    var g = S.game;
    g.phaseT += dt;
    if (g.phase === 'TITLE' && (S.params.notitle || S.controls.start)) {
      startRun(S);
      return;
    }
    if (g.phase === 'RUN_END') return;
    if (g.phase === 'CARD' && g.phaseT >= 2 && S.player.mode !== 'SNAP') {
      setPhase(S, 'DRIVE');
      TLV.player.setLocked(S, false);
    }
    if (g.phase === 'DRIVE' || g.phase === 'SEARCH') {
      g.clock -= 0;
      updateNav(S);
      if (g.phase === 'DRIVE' && g.nav.remaining <= APPROACH) setPhase(S, 'SEARCH');
    }
  };

  /** Bay-axis coordinates of the car. */
  function inFunnel(S, spot) {
    var veh = S.player.veh;
    var c = Math.cos(spot.h);
    var s = Math.sin(spot.h);
    var ex = veh.x - spot.x;
    var ey = veh.y - spot.y;
    var a = ex * c + ey * s;
    var l = -ex * s + ey * c;
    return Math.abs(a) <= (spot.len + 3) / 2 && Math.abs(l) <= spot.wid / 2;
  }

  function aligned(S, spot) {
    var off = Math.abs(TLV.math.wrapPi(S.player.veh.h - spot.h));
    off = off > Math.PI / 2 ? Math.PI - off : off;
    return off <= Math.PI / 6;
  }

  function finishParking(S) {
    var g = S.game;
    var st = S._stub;
    st.parked = true;
    st.done++;
    g.stats.errandsDone++;
    errands.done = st.done;
    setPhase(S, 'PAYOUT');
  }

  parking.update = function (S, dt) {
    var g = S.game;
    var st = S._stub;
    var p = g.park;
    if (!g.errand) return;
    var veh = S.player.veh;
    var spot = TLV.world.parking.spot(S.world, g.errand.bayId);
    if (g.phase === 'DRIVE' || g.phase === 'SEARCH') {
      if (!p.stage && spot && inFunnel(S, spot) && aligned(S, spot) && Math.abs(veh.v) <= (S.controls.handbrake ? 12 : 7)) {
        p.stage = 'ARMED';
        p.kind = 'BAY';
        st.armT = 0;
        st.prev = g.phase;
        setPhase(S, 'HOLD');
      } else if (S.controls.hazard && Math.abs(veh.v) < 0.2) {
        st.q += dt;
        if (st.q >= 1) {
          st.q = 0;
          g.stats.doubleParks = (g.stats.doubleParks || 0) + 1;
          TLV.player.setLocked(S, true);
          finishParking(S);
        }
      } else {
        st.q = 0;
      }
    } else if (g.phase === 'HOLD') {
      if (p.stage === 'ARMED') {
        st.armT += dt;
        if (!inFunnel(S, spot)) {
          p.stage = null;
          setPhase(S, st.prev);
        } else if (Math.abs(veh.v) < 1 || st.armT >= 1.5) {
          p.stage = 'SNAP';
          p.x = spot.x;
          p.y = spot.y;
          p.h = spot.h;
          TLV.player.snapTo(S, spot.x, spot.y, spot.h, 0.6, { hold: true });
          st.armT = 0;
        }
      } else if (p.stage === 'SNAP') {
        if (S.player.mode === 'LOCKED') p.stage = 'FILL';
      } else if (p.stage === 'FILL') {
        st.armT += dt;
        p.bar = st.armT / 1.2;
        if (st.armT >= 1.2) {
          p.stage = null;
          g.stats.bayParks = (g.stats.bayParks || 0) + 1;
          finishParking(S);
        }
      }
    }
  };

  /** A plain chase: door tug, bail, then a run to the door with a lunge now and then. */
  knife.update = function (S, dt) {
    var g = S.game;
    var st = S._stub;
    if (g.phase === 'PAYOUT' && g.phaseT >= 0.3 && st.knifeEvery && st.done % st.knifeEvery === 0 && !g.knife && !st.knifed) {
      st.knifed = true;
      g.knife = { stage: 'STANDOFF', stageT: 0, tugBar: 1, lunge: 'NONE', lungeT: 0, strikes: 0, gap: 12, exit: null };
      setPhase(S, 'ENCOUNTER');
      return;
    }
    if (g.phase !== 'ENCOUNTER' || !g.knife) return;
    var k = g.knife;
    k.stageT += dt;
    if (k.stage === 'STANDOFF' && k.stageT >= 1.4) {
      k.stage = 'DOOR_TUG';
      k.stageT = 0;
    } else if (k.stage === 'DOOR_TUG') {
      k.tugBar = 1 - k.stageT / 2.5;
      if (S.controls.interact) {
        k.pressedAt = k.stageT;
        k.stage = 'BAIL';
        k.stageT = 0;
      } else if (k.stageT >= 2.5) {
        k.stage = 'BAIL';
        k.stageT = 0;
      }
    } else if (k.stage === 'BAIL' && k.stageT >= 0.5) {
      var veh = S.player.veh;
      TLV.foot.enter(S, veh.x + Math.sin(veh.h) * 1.6, veh.y - Math.cos(veh.h) * 1.6, veh.h);
      k.stage = 'CHASE';
      k.stageT = 0;
    } else if (k.stage === 'CHASE') {
      var f = S.player.foot;
      var left = Math.hypot(g.errand.doorX - f.x, g.errand.doorY - f.y);
      k.lunge = Math.floor(k.stageT / 4) % 2 === 1 && k.stageT % 4 < 0.5 ? 'WINDUP' : 'NONE';
      if (left < 1.5) k.exit = 'REACHED_SHOP';
      else if (k.stageT >= 25) k.exit = 'WHISTLE';
      if (k.exit) {
        TLV.foot.exit(S);
        TLV.player.setLocked(S, true);
        setPhase(S, 'RESOLVE');
      }
    }
  };

  flow.postUpdate = function (S) {
    var g = S.game;
    var st = S._stub;
    var ended = (g.phase === 'PAYOUT' && g.phaseT >= 2.5) || (g.phase === 'RESOLVE' && g.phaseT >= 4);
    if (!ended) return;
    g.knife = null;
    st.knifed = false;
    st.parked = false;
    g.errandIndex++;
    // Pull-out: the car leaves the stall by a ghost snap to the lane (ARCHITECTURE 10.9).
    var veh = S.player.veh;
    var lane = TLV.world.lanes.project(S.world, veh.x, veh.y, veh.h, 8, {});
    setPhase(S, 'CARD');
    bind(S);
    if (lane) {
      var at = TLV.world.lanes.pointAt(S.world, lane.laneId, lane.s, {});
      TLV.player.setLocked(S, true);
      TLV.player.snapTo(S, at.x, at.y, at.h, 1, { ghost: true });
      bind(S);
    }
  };

  game.score = { update: function () {} };
  game.director = { update: function () {} };
})(window.TLV);
