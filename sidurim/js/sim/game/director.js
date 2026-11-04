// js/sim/game/director.js — WP-GAME
// The Balagan director (GAME_DESIGN 11): pacing, the first minute's beats, and choosing what to stage. The Spot War is the peak, so
// SEARCH takes only incidents marked for it, and the director is silent through an encounter.
(function (TLV) {
  'use strict';

  var director = TLV.ns('game.director');

  /** @returns {object} Director state private to this package. */
  director._newState = function () {
    return { cool: {}, nextId: 0, beat: 0, peakAt: 0, retryT: 0, cueT: 0, rollT: 0 };
  };

  /** Draws the next PEAK. */
  function schedulePeak(S) {
    var T = TLV.tune.game;
    S.game._g.dir.peakAt = S.rng.event.range(T.peakMinS, T.peakMaxS);
  }

  /** Changes the pacing state. */
  function setState(S, state) {
    var d = S.game.director;
    d.state = state;
    d.stateT = 0;
    if (state === 'BUILD') schedulePeak(S);
  }

  /**
   * Subscribes to contacts: any contact gives the player a breather. Called once by flow.init.
   * @param {object} S Sim state.
   */
  director.init = function (S) {
    S.bus.on('player.contact', function () {
      var g = S.game;
      if (g.phase === 'DRIVE' || g.phase === 'SEARCH') setState(S, 'BREATHE');
    });
    // An incident that never happened took no part in the pacing, so the next one comes in its place.
    S.bus.on('incident.end', function (e) {
      if (e.outcome === 'ABORTED') S.game.director.nextT -= gap(S);
    });
    TLV.game.incidents.init(S);
    schedulePeak(S);
  };

  /** Ends what an old run left: every incident in old state. */
  director._reset = function (S, old) {
    old.director.incidents.forEach(function (inc) {
      if (inc._parked) {
        var car = TLV.traffic.byId(S, inc.actors[0].id);
        if (car && car.mode === 'PARKED') TLV.traffic.despawn(S, car, 'script');
      }
    });
    old.director.incidents.length = 0;
  };

  /** A new errand: the first minute's beats run on errand 1 only. */
  director._newErrand = function (S) {
    var g = S.game;
    g._g.dir.beat = g.errandIndex === 0 ? 0 : TLV.tune.game.introBeats.length;
    setState(S, 'BUILD');
    g.director.nextT = TLV.tune.game.buildGapS;
  };

  /**
   * The player's predicted place in some seconds: along the route, or straight on with no route.
   * @param {object} S Sim state.
   * @param {number} ttaS Seconds ahead.
   * @param {object} [out] Written and returned.
   * @returns {{x:number,y:number,laneId:number,s:number}} Prediction.
   */
  director.predict = function (S, ttaS, out) {
    var r = out || {};
    var g = S.game;
    var veh = S.player.veh;
    var v = Math.max(TLV.tune.game.planMinV, veh.v);
    var route = g.nav.route;
    if (route) {
      var at = g._g.pt;
      TLV.math.polyAt(route.px, route.py, route.cum, g.nav.s + v * ttaS, at);
      r.x = at.x;
      r.y = at.y;
    } else {
      r.x = veh.x + veh.vx * ttaS;
      r.y = veh.y + veh.vy * ttaS;
    }
    var near = TLV.world.lanes.project(S.world, r.x, r.y, null, TLV.tune.game.predictLaneM, g._g.nav.near);
    r.laneId = near ? near.laneId : -1;
    r.s = near ? near.s : 0;
    return r;
  };

  /** @returns {number} Seconds between incidents now. */
  function gap(S) {
    var g = S.game;
    var T = TLV.tune.game;
    if (g.director.state === 'PEAK') return T.peakGapS;
    return T.buildGapS + (T.buildGapHotS - T.buildGapS) * g.heat;
  }

  /** The first minute: beats fire by route distance, ignore minHeat, and are skipped if the route has no place for them. */
  function intro(S) {
    var g = S.game;
    var dd = g._g.dir;
    var beats = TLV.tune.game.introBeats;
    if (dd.beat >= beats.length) return false;
    if (g.phase !== 'DRIVE') {
      dd.beat = beats.length;
      return false;
    }
    var b = beats[dd.beat];
    var T = TLV.tune.game;
    if (g.nav.s + S.player.veh.v * b.tta < b.atM) return true;
    dd.retryT -= TLV.const.DT;
    if (dd.retryT > 0) return true;
    dd.retryT = T.rollRetryS;
    // A beat gets a stretch of road to find its place, because a single try at one spot would rarely land.
    if (TLV.game.incidents.stage(S, b.defId, { tta: b.tta }) || g.nav.s >= b.atM + T.beatWindowM) dd.beat++;
    return true;
  }

  /** Rolls and stages one incident, re-rolling a refused one. */
  function roll(S) {
    var g = S.game;
    var T = TLV.tune.game;
    var dd = g._g.dir;
    var rng = S.rng.event;
    var searching = g.phase === 'SEARCH';
    var list = TLV.game.incidents.defs().filter(function (def) {
      if (def.minHeat > g.heat) return false;
      if (searching && !def.search) return false;
      for (var c = 0; c < T.cues.length; c++) {
        if (T.cues[c].id === def.id) return false;
      }
      return !(dd.cool[def.id] > S.t);
    });
    for (var tries = 0; tries < T.incidentRetry && list.length; tries++) {
      var total = 0;
      var i;
      for (i = 0; i < list.length; i++) total += list[i].weight > 0 ? list[i].weight : 1;
      var u = rng.next() * total;
      var pick = list.length - 1;
      for (i = 0; i < list.length; i++) {
        u -= list[i].weight > 0 ? list[i].weight : 1;
        if (u < 0) {
          pick = i;
          break;
        }
      }
      if (TLV.game.incidents.stage(S, list[pick].id, {})) return true;
      list.splice(pick, 1);
    }
    return false;
  }

  /**
   * Two incidents need the road to be right, and the gap between incidents would land them anywhere. A tailgate plays on a stretch the
   * player is getting going on: at a stop line a car on his bumper is a car in a queue. A dive needs a lane to pass in and room to come
   * back. So they are staged when the road offers itself, each on its own cooldown, and tried again at the retry rate. A slow car hunting
   * for a spot is exactly who gets dived past, so a dive keeps its cue in SEARCH.
   */
  function onCue(S) {
    var g = S.game;
    var T = TLV.tune.game;
    var dd = g._g.dir;
    var veh = S.player.veh;
    var searching = g.phase === 'SEARCH';
    if ((g.phase !== 'DRIVE' && !searching) || S.player.laneId < 0) return;
    dd.cueT -= TLV.const.DT;
    if (dd.cueT > 0) return;
    dd.cueT = T.rollRetryS;
    var lane = S.world.lanes[S.player.laneId];
    var left = lane.len - S.traffic.pS;
    var ids = T.cues;
    for (var i = 0; i < ids.length; i++) {
      var c = ids[i];
      if (veh.v < c.v || left < c.roadM || dd.cool[c.id] > S.t) continue;
      var def = TLV.game.incidents.get(c.id);
      if (def.minHeat > g.heat || (searching && !def.search)) continue;
      if (TLV.game.incidents.stage(S, c.id, {})) return;
    }
  }

  /**
   * Tick row 5: live incidents, pacing, and the next incident when it is due.
   * @param {object} S Sim state.
   * @param {number} dt Tick, seconds.
   */
  director.update = function (S, dt) {
    var g = S.game;
    var d = g.director;
    var T = TLV.tune.game;
    TLV.game.incidents._tick(S);
    if (g.phase !== 'DRIVE' && g.phase !== 'SEARCH') return;
    if (S.player.mode !== 'DRIVE') return;
    if (intro(S)) return;
    if (d.state !== 'BREATHE') onCue(S);
    d.stateT += dt;
    if (d.state === 'BUILD' && d.stateT >= g._g.dir.peakAt) setState(S, 'PEAK');
    else if (d.state === 'PEAK' && d.stateT >= T.peakLenS) setState(S, 'BREATHE');
    else if (d.state === 'BREATHE' && d.stateT >= T.breatheS) setState(S, 'BUILD');
    if (d.state === 'BREATHE') return;
    // The gap is a rate, not a wait: time spent waiting for a place at a red light is owed to the road after it.
    d.nextT = Math.max(d.nextT - dt, -T.gapCreditS);
    if (d.nextT > 0) return;
    var dd = g._g.dir;
    dd.rollT -= dt;
    if (dd.rollT > 0) return;
    if (roll(S)) {
      d.nextT += gap(S);
      dd.rollT = T.spacingS;
    } else {
      dd.rollT = T.rollRetryS;
    }
  };
})(window.TLV);
