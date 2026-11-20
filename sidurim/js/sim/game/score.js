// js/sim/game/score.js — WP-GAME
// Health, money, the chain and pay (GAME_DESIGN 8). No display strings here: the UI keys its text on the ids.
(function (TLV) {
  'use strict';

  var score = TLV.ns('game.score');

  /** Breaks the chain. The bank stays: only the unbanked multiplier is lost (GAME_DESIGN 8.2). */
  function breakChain(S) {
    var c = S.game.chain;
    if (c.n === 0 && c.mult === 1) return;
    c.n = 0;
    c.mult = 1;
    c.windowT = 0;
    S.bus.emit('score.chain', { n: c.n, mult: c.mult, bank: c.bank });
  }

  /** @returns {boolean} True while a run is on. */
  function live(g) {
    return g.phase !== 'TITLE' && g.phase !== 'RUN_END';
  }

  function onContact(S, e) {
    var g = S.game;
    if (!live(g)) return;
    var T = TLV.tune.game;
    var hp = e.severity === 'crash' ? T.hpCrash : (e.severity === 'bump' ? T.hpBump : T.hpScrape);
    if (e.rearEnded) hp *= T.rearShare;
    g.hp = Math.max(0, g.hp - hp);
    // A tailgater's contact is unavoidable on any full stop, so it costs health and nothing else.
    if (e.rearEnded) return;
    g.contacts++;
    g.stats.contacts++;
    breakChain(S);
  }

  function onNearMiss(S, e) {
    var g = S.game;
    if (!live(g)) return;
    var T = TLV.tune.game;
    var c = g.chain;
    c.n++;
    c.mult = Math.min(T.chainMax, 1 + c.n / T.chainDiv);
    c.windowT = T.chainWindowS;
    c.bank += (e.tier === 2 ? T.hairPay : T.nearPay) * c.mult;
    g.stats.nearMisses++;
    S.bus.emit('score.chain', { n: c.n, mult: c.mult, bank: c.bank });
  }

  /** The same for every person, the attacker included. Nothing here can ever pay. */
  function onHitPed(S) {
    var g = S.game;
    if (!live(g)) return;
    var T = TLV.tune.game;
    g.money -= T.pedMoney;
    g.clock = Math.max(0, g.clock - T.pedClockS);
    g.pedHits++;
    g.pedHitThisErrand = true;
    breakChain(S);
  }

  /**
   * Subscribes to the events that score. Called once by flow.init.
   * @param {object} S Sim state.
   */
  score.init = function (S) {
    S.bus.on('player.contact', function (e) { onContact(S, e); });
    S.bus.on('player.nearMiss', function (e) { onNearMiss(S, e); });
    S.bus.on('player.hitPed', function () { onHitPed(S); });
    S.bus.on('player.launch', function () {
      if (live(S.game)) score.bonus(S, 'BEAT_THE_HONK', TLV.tune.game.launchPay, 0);
    });
    S.bus.on('player.redRun', function () {
      if (live(S.game)) S.game.stats.redsRun++;
    });
    S.bus.on('traffic.honk', function (e) {
      if (e.atPlayer && live(S.game)) S.game.stats.honksReceived++;
    });
  };

  /**
   * Tick row 13: the chain window.
   * @param {object} S Sim state.
   * @param {number} dt Tick, seconds.
   */
  score.update = function (S, dt) {
    var c = S.game.chain;
    if (c.windowT <= 0) return;
    c.windowT -= dt;
    if (c.windowT <= 0) breakChain(S);
  };

  /**
   * Pays a bonus.
   * @param {object} S Sim state.
   * @param {string} id One of the ids of ARCHITECTURE 11.
   * @param {number} amount Shekels.
   * @param {number} seconds Clock seconds.
   */
  score.bonus = function (S, id, amount, seconds) {
    var g = S.game;
    g.money += amount;
    g.clock += seconds;
    S.bus.emit('score.bonus', { id: id, amount: amount, seconds: seconds });
  };

  /**
   * Pay for the current errand, with its knife exit if it has one (GAME_DESIGN 8.4, 15.4). It pays nothing here: the caller does.
   * @param {object} S Sim state.
   * @returns {number} Whole shekels. Zero after a pedestrian hit on this errand.
   */
  score.computePay = function (S) {
    var g = S.game;
    var e = g.errand;
    var T = TLV.tune.game;
    // A shared day's errand that another driver parked at first pays nothing (versus.js).
    if (!e || g.pedHitThisErrand || e._void) return 0;
    var quality = e.quality || 'UGLY';
    var p = T.qualityP[quality];
    var bay = (e.parkMethod || 'BAY') === 'BAY';
    var c = Math.max(T.contactFloor, 1 - T.contactCut * g.contacts);
    if (g.contacts === 0) c = bay ? T.spotlessC : 1;
    var pay = (T.payBase + T.payPerM * e.routeLen) * p * c + g.chain.bank;
    var k = g.knife;
    if (k && k.exit && T.exitPay[k.exit]) pay *= T.exitPay[k.exit];
    return Math.round(pay);
  };

  /** Pays the errand and spends the bank. @returns {number} The pay. */
  score._payErrand = function (S) {
    var g = S.game;
    var pay = score.computePay(S);
    g.errand.pay = pay;
    g.money += pay;
    g.chain.bank = 0;
    return pay;
  };

  /**
   * @param {number} money Final total.
   * @returns {string} Rank key, GAME_DESIGN 8.5.
   */
  score.rank = function (money) {
    var T = TLV.tune.game;
    for (var i = 0; i < T.ranks.length; i++) {
      if (money < T.ranks[i][0]) return T.ranks[i][1];
    }
    return T.rankTop;
  };
})(window.TLV);
