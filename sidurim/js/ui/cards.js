// js/ui/cards.js — WP-UI
// The cards the run stops for: the phone errand card, the parking payout, the block, the knife stage prompts with the tug bar and the
// chase panel, and the comic resolve card. Each is driven by the phase, so it can never outlive the moment it belongs to.
(function (TLV) {
  'use strict';

  var cards = TLV.ns('ui.cards');
  var dom = null;
  var memo = null;

  function u() {
    return TLV.ui;
  }

  function t(key, vars) {
    return TLV.ui.strings.t(key, vars);
  }

  function money(n) {
    return TLV.ui.strings.money(n);
  }

  function newMemo() {
    return { parked: null, paid: null, exit: null, phoneFor: -1, parkedKey: null, pose: null };
  }

  /** Builds every card, hidden. */
  cards.build = function (root) {
    var el = u().el;
    memo = newMemo();
    dom = {};
    var box = dom.box = el('div', 'cards', root);

    var phone = dom.phone = el('div', 'phone off', box);
    var bar = el('div', 'phone-bar', phone);
    dom.phoneSender = el('span', 'phone-sender', bar);
    dom.phoneIndex = el('span', 'phone-index', bar);
    dom.phoneNew = el('div', 'phone-new', phone);
    dom.phoneText = el('div', 'phone-bubble', phone);
    dom.phoneText.dir = 'auto';
    dom.phoneAt = el('div', 'phone-at', phone);
    dom.phoneAt.dir = 'auto';
    dom.phoneRoute = el('div', 'phone-route', phone);

    var payout = dom.payout = el('div', 'payout off', box);
    dom.payoutTitle = el('div', 'payout-title', payout);
    dom.payoutStamp = el('div', 'payout-stamp', payout);
    dom.payoutLine = el('div', 'payout-line', payout);
    dom.payoutWhy = el('div', 'payout-why', payout);
    var rows = el('div', 'payout-rows', payout);
    var pay = dom.payRow = el('div', 'payout-row', rows);
    dom.payLabel = el('span', 'payout-label', pay);
    dom.payValue = el('span', 'payout-value', pay);
    dom.payValue.dir = 'ltr';
    var time = dom.timeRow = el('div', 'payout-row', rows);
    dom.timeLabel = el('span', 'payout-label', time);
    dom.timeValue = el('span', 'payout-value', time);
    dom.payoutNote = el('div', 'payout-note', payout);

    var block = dom.block = el('div', 'block off', box);
    dom.blockTitle = el('div', 'block-title', block);
    dom.blockLine = el('div', 'block-line', block);
    dom.blockTime = el('div', 'block-time', block);

    var knife = dom.knife = el('div', 'knife off', box);
    dom.knifeLine = el('div', 'knife-line', knife);
    var tug = dom.tug = el('div', 'knife-tug', knife);
    dom.tugFill = el('div', 'knife-tug-fill', tug);

    var chase = dom.chase = el('div', 'chase off', box);
    var strikes = el('div', 'chase-cell', chase);
    dom.strikesLabel = el('div', 'chase-label', strikes);
    var pips = dom.pips = el('div', 'chase-pips', strikes);
    el('i', 'pip', pips);
    el('i', 'pip', pips);
    el('i', 'pip', pips);
    var gap = el('div', 'chase-cell', chase);
    dom.gapLabel = el('div', 'chase-label', gap);
    dom.gapValue = el('div', 'chase-value', gap);
    var left = el('div', 'chase-cell', chase);
    dom.leftLabel = el('div', 'chase-label', left);
    dom.leftValue = el('div', 'chase-value', left);

    var resolve = dom.resolve = el('div', 'resolve off', box);
    dom.resolveTitle = el('div', 'resolve-title', resolve);
    dom.resolveLine = el('div', 'resolve-line', resolve);
    dom.resolvePay = el('div', 'resolve-pay', resolve);
    dom.resolvePay.dir = 'ltr';
    dom.resolveSkip = el('div', 'resolve-skip', resolve);
    cards.relabel();
  };

  /** Rewrites fixed labels after a language switch. */
  cards.relabel = function () {
    if (!dom) return;
    u().setText(dom.phoneSender, t('card.sender'));
    u().setText(dom.phoneNew, t('card.message'));
    u().setText(dom.payoutTitle, t('payout.title'));
    u().setText(dom.payLabel, t('payout.pay'));
    u().setText(dom.timeLabel, t('payout.time'));
    u().setText(dom.blockTitle, t('block.title'));
    u().setText(dom.blockLine, t('block.line'));
    u().setText(dom.strikesLabel, t('hud.strikes'));
    u().setText(dom.gapLabel, t('hud.gap'));
    u().setText(dom.leftLabel, t('hud.chaseTime'));
    u().setText(dom.resolveSkip, t('resolve.skip'));
    dom.knifeLine._text = null;
  };

  /**
   * Reacts to one event.
   * @param {object} S Sim state.
   * @param {string} name Event name.
   * @param {object} p Payload.
   */
  cards.onEvent = function (S, name, p) {
    if (name === 'run.start') {
      memo = newMemo();
    } else if (name === 'errand.start') {
      memo.parked = null;
      memo.paid = null;
      memo.exit = null;
      memo.pose = null;
    } else if (name === 'errand.parked') {
      memo.parked = p;
    } else if (name === 'errand.paid') {
      memo.paid = p;
    } else if (name === 'knife.exit') {
      memo.exit = p.exit;
    } else if (name === 'knife.stage') {
      dom.knife.classList.remove('pulse');
    }
  };

  function framePhone(S, forced) {
    var g = S.game;
    var e = g.errand;
    var on = !!e && (g.phase === 'CARD' || forced);
    u().show(dom.phone, on);
    if (!on) return;
    var lang = TLV.ui.strings.lang();
    // On a shared day the count is of the board, not of a day's seven.
    var shared = u().versus.errandCount(S);
    u().setText(dom.phoneIndex, t('hud.errand', shared || { n: e.index + 1, total: 7 }));
    u().setText(dom.phoneText, e.text[lang] || e.text.en);
    var nameOf = e.name ? (e.name[lang] || e.name.en || e.name.he) : '';
    u().setText(dom.phoneAt, nameOf ? t('card.at', { name: nameOf }) : '');
    // The arrow's own figure, so the card and the arrow can never disagree.
    var left = Number.isFinite(g.nav.remaining) ? g.nav.remaining : e.routeLen || 0;
    u().setText(dom.phoneRoute, t('card.route', { n: Math.round(left) }));
  }

  /** The parked result, from the event when there is one, else the errand itself for a forced card. */
  function parkedInfo(S) {
    var e = S.game.errand;
    if (memo.parked) return memo.parked;
    return { quality: (e && e.quality) || 'GOOD', pay: e && e.pay !== null && e.pay !== undefined ? e.pay : 420, award: 77, spotless: true };
  }

  /**
   * Keeps the car's pose against the bay as the bay is taken, for an errand.parked with no offM and yawDeg. The snap moves the car
   * straight after the sim locks the grade, so the pose has to be caught here, while it is still the player's.
   */
  function watchPose(S) {
    var g = S.game;
    var p = g.park;
    if (g.phase !== 'HOLD' || p.kind !== 'BAY') {
      if (g.phase !== 'PAYOUT') memo.pose = null;
      return;
    }
    if (p.stage !== 'ARMED' && memo.pose) return;
    var veh = S.vehicles[0];
    var dx = veh.x - p.x;
    var dy = veh.y - p.y;
    var yaw = Math.abs(TLV.math.wrapPi(veh.h - p.h));
    memo.pose = {
      off: Math.abs(-dx * Math.sin(p.h) + dy * Math.cos(p.h)),
      deg: (yaw > Math.PI / 2 ? Math.PI - yaw : yaw) * 180 / Math.PI
    };
  }

  /**
   * @param {object} info The parked result.
   * @returns {string} Why an UGLY stamp was given, by the limits of GAME_DESIGN 12.1. Anything else needs no reason.
   */
  function uglyWhy(info) {
    if (info.quality !== 'UGLY') return '';
    if (info.method === 'RED_WHITE' || info.method === 'RED_YELLOW') return t('qualityWhy.CURB');
    // The sim's own figures are the pose it graded, and null with no bay capture. What this card caught only stands in for them.
    var told = Number.isFinite(info.offM) && Number.isFinite(info.yawDeg);
    var pose = told ? { off: info.offM, deg: info.yawDeg } : memo.pose;
    var T = TLV.tune.game;
    var off = pose ? pose.off / T.goodOffM : 0;
    var deg = pose ? pose.deg / T.goodDeg : 0;
    if (off <= 1 && deg <= 1) return t('qualityWhy.ANY');
    return t(off >= deg ? 'qualityWhy.OFFSET' : 'qualityWhy.CROOKED');
  }

  function framePayout(S, forced) {
    var g = S.game;
    var on = g.phase === 'PAYOUT' || forced;
    u().show(dom.payout, on);
    if (!on) return;
    var info = parkedInfo(S);
    var q = info.quality || 'UGLY';
    u().setText(dom.payoutStamp, t('quality.' + q));
    dom.payoutStamp.dataset.q = q;
    u().setText(dom.payoutLine, t('qualityLine.' + q));
    var why = uglyWhy(info);
    u().setText(dom.payoutWhy, why);
    u().show(dom.payoutWhy, !!why);
    var known = info.pay !== null && info.pay !== undefined;
    u().show(dom.payRow, known && info.pay > 0);
    if (known) u().setText(dom.payValue, '+' + money(info.pay));
    u().setText(dom.timeValue, t('hud.seconds', { n: '+' + Math.round(info.award || 0) }));
    var note = '';
    if (!known) note = t('payout.pending');
    else if (info.pay <= 0) note = t('payout.none');
    else if (info.spotless) note = t('payout.spotless');
    u().setText(dom.payoutNote, note);
  }

  function frameBlock(S, forced) {
    var g = S.game;
    var on = g.phase === 'BLOCKED' || forced;
    u().show(dom.block, on);
    if (!on) return;
    var left = Math.max(0, TLV.tune.game.blockedS - g.phaseT);
    u().setText(dom.blockTime, t('hud.seconds', { n: left.toFixed(1) }));
  }

  /** The stage being shown: a forced one, or the live encounter. */
  function knifeStage(S) {
    var name = u().forcedWith('knife.');
    if (name) return name.slice('knife.'.length);
    var k = S.game.knife;
    if (!k || S.game.phase !== 'ENCOUNTER') return null;
    return k.stage === 'RESOLVE' ? null : k.stage;
  }

  function frameKnife(S) {
    var k = S.game.knife;
    var stage = knifeStage(S);
    // The pause screen has the middle of the frame to itself, and nothing can be done about a shouted line until play comes back.
    u().show(dom.knife, !!stage && !u().isUserPaused());
    u().show(dom.chase, stage === 'CHASE');
    dom.box.classList.toggle('in-knife', !!stage);
    if (!stage) return;
    var line = t('knife.' + stage);
    var lunge = false;
    if (stage === 'CHASE' && k) {
      lunge = k.lunge === 'WINDUP';
      if (lunge) line = t('chase.lunge');
      else if (k.shaken) line = t('chase.shaken');
      else if (u().hud.footRound()) line = t('knife.CHASE_ROUND');
    }
    u().setRich(dom.knifeLine, line);
    dom.knife.classList.toggle('lunge', lunge);
    dom.knife.classList.toggle('chase-line', stage === 'CHASE');
    dom.knife.classList.toggle('big', stage === 'DOOR_TUG');
    var tug = stage === 'DOOR_TUG';
    u().show(dom.tug, tug);
    if (tug) dom.tugFill.style.width = (100 * TLV.math.clamp(k ? k.tugBar : 0.7, 0, 1)).toFixed(1) + '%';
    if (stage === 'CHASE') {
      var strikes = k ? k.strikes : 1;
      var pips = dom.pips.children;
      for (var i = 0; i < pips.length; i++) pips[i].classList.toggle('on', i < strikes);
      // The sim's gap is his place on the runner's trail, and it reads below zero with him on top of the runner, as after a drag.
      u().setText(dom.gapValue, t('hud.metres', { n: k ? Math.round(Math.max(0, k.gap)) : 9 }));
      var left = TLV.tune.game.chaseMaxS - (k ? k.stageT : 8);
      u().setText(dom.leftValue, t('hud.seconds', { n: Math.max(0, Math.ceil(left)) }));
    }
  }

  function frameResolve(S) {
    var g = S.game;
    var name = u().forcedWith('resolve.');
    var exit = name ? name.slice('resolve.'.length) : (g.phase === 'RESOLVE' && g.knife ? g.knife.exit : null);
    u().show(dom.resolve, !!exit);
    if (!exit) return;
    u().setText(dom.resolveTitle, t('resolve.' + exit + '.title'));
    u().setText(dom.resolveLine, t('resolve.' + exit + '.line'));
    var pay = memo.paid ? memo.paid.pay : (name ? 840 : null);
    u().setText(dom.resolvePay, pay ? '+' + money(pay) : '');
  }

  /**
   * Draws one frame.
   * @param {object} S Sim state.
   */
  cards.frame = function (S) {
    if (!S.game) return;
    watchPose(S);
    framePhone(S, u().isForced('card'));
    framePayout(S, u().isForced('payout'));
    frameBlock(S, u().isForced('block'));
    frameKnife(S);
    frameResolve(S);
  };
})(window.TLV);
