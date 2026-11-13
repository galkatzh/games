// js/ui/hud.js — WP-UI
// The arcade HUD (GAME_DESIGN 20): clock, money and chain, No-Claims bar, speed, street name, route arrow, errand chip, prompts,
// popups, the rage gauge, the bay and door tags, incident chevrons, vignette and flashes. Everything here reads S and writes the DOM.
(function (TLV) {
  'use strict';

  var hud = TLV.ns('ui.hud');
  var dom = null;
  var view = null;

  /** The route arrow, drawn lying flat and tilted in CSS, so it reads as an object over the road. */
  var ARROW_SVG = '<svg viewBox="0 0 100 150" aria-hidden="true"><path class="arrow-shape" d="M50 4 L96 66 L68 66 L68 146 L32 146 L32 66 L4 66 Z"/></svg>';
  var ARROW_LAYERS = 7;

  /** Per-run memory of what has been said and shown. */
  function newView() {
    return {
      money: null, moneySaid: 0, hp: null, lastClockText: '',
      popT: [], toasts: [], chevrons: [],
      prompt: { key: null, t: 0, vars: null },
      seen: {}, wasGreen: null, startLane: -2,
      stuckT: 0, stuckIdleT: 0, stuckX: 0, stuckY: 0, vignette: 0, flash: 0, barFlash: 0, recalc: 0, recalcGap: 0, redSeen: false,
      street: null, hpPop: 0, slot: -1, cameraFrom: null, cameraFrames: 0, parkSide: 'left'
    };
  }

  function u() {
    return TLV.ui;
  }

  function t(key, vars) {
    return TLV.ui.strings.t(key, vars);
  }

  /** @param {number} seconds Clock. @returns {string} m:ss, with tenths in the last seconds. */
  hud.clockText = function (seconds) {
    var c = Math.max(0, seconds);
    if (c < TLV.tune.ui.clockTenthsBelowS) return c.toFixed(1);
    var whole = Math.ceil(c);
    var m = Math.floor(whole / 60);
    var s = whole % 60;
    return m + ':' + (s < 10 ? '0' : '') + s;
  };

  /**
   * The street under the car, in the current language, then the other one.
   * @param {object} S Sim state.
   * @param {string} lang 'en' or 'he'.
   * @returns {?string} Street name; '' for a road with no name; null with no lane, so the last name can stay up.
   */
  hud.streetName = function (S, lang) {
    var id = S.player.laneId;
    if (id === undefined || id < 0) return null;
    var lane = S.world.lanes[id];
    var edge = lane ? S.world.edges[lane.edge] : null;
    if (!edge) return null;
    return lang === 'he' ? (edge.name || edge.nameEn || '') : (edge.nameEn || edge.name || '');
  };

  /** Builds the HUD under root. */
  hud.build = function (root) {
    var el = u().el;
    view = newView();
    foot = null;
    dom = {};
    var box = dom.box = el('div', 'hud', root);

    var clock = el('div', 'hud-clock', box);
    dom.clockBox = clock;
    dom.clock = el('div', 'hud-clock-digits', clock);
    dom.clock.dir = 'ltr';

    var chip = dom.chip = el('div', 'hud-chip', box);
    dom.chipIndex = el('div', 'hud-chip-index', chip);
    dom.chipText = el('div', 'hud-chip-text', chip);

    var arrow = dom.arrow = el('div', 'hud-arrow', box);
    var plane = dom.arrowPlane = el('div', 'hud-arrow-plane', arrow);
    for (var i = 0; i < ARROW_LAYERS; i++) {
      var layer = el('div', 'hud-arrow-layer', plane);
      layer.innerHTML = ARROW_SVG;
      layer.style.transform = 'translateZ(' + (i * 0.17) + 'em)';
      if (i === ARROW_LAYERS - 1) layer.classList.add('top');
    }
    dom.arrowDist = el('div', 'hud-arrow-dist', arrow);

    var money = el('div', 'hud-money', box);
    dom.money = el('div', 'hud-money-digits', money);
    dom.money.dir = 'ltr';
    var chain = dom.chain = el('div', 'hud-chain', money);
    dom.chainLabel = el('span', 'hud-chain-label', chain);
    dom.chainMult = el('span', 'hud-chain-mult', chain);
    dom.chainMult.dir = 'ltr';
    dom.chainBank = el('span', 'hud-chain-bank', chain);
    dom.chainBank.dir = 'ltr';
    var chainBar = el('div', 'hud-chain-bar', money);
    dom.chainBarBox = chainBar;
    dom.chainFill = el('div', 'hud-chain-fill', chainBar);

    var hp = dom.hpBox = el('div', 'hud-hp', box);
    dom.hpLabel = el('div', 'hud-hp-label', hp);
    var hpBar = el('div', 'hud-hp-bar', hp);
    dom.hpFill = el('div', 'hud-hp-fill', hpBar);
    dom.hpValue = el('div', 'hud-hp-value', hpBar);
    dom.hpValue.dir = 'ltr';
    dom.hpDelta = el('div', 'hud-hp-delta', hp);
    dom.hpDelta.dir = 'ltr';

    var speed = dom.speed = el('div', 'hud-speed', box);
    dom.speedValue = el('div', 'hud-speed-digits', speed);
    dom.speedValue.dir = 'ltr';
    dom.speedUnit = el('div', 'hud-speed-unit', speed);

    var bottom = el('div', 'hud-map-stack', box);
    dom.street = el('div', 'hud-street', bottom);
    dom.street.dir = 'auto';
    dom.mapSlot = el('div', 'hud-map', bottom);

    dom.toasts = el('div', 'hud-toasts', box);
    dom.prompt = el('div', 'hud-prompt', box);
    var bar = dom.parkBar = el('div', 'hud-parkbar', box);
    dom.parkFill = el('div', 'hud-parkbar-fill', bar);
    dom.pops = el('div', 'hud-pops', box);
    dom.chevrons = el('div', 'hud-chevrons', box);

    var rage = dom.rage = el('div', 'tag tag-rage', box);
    dom.rageLabel = el('div', 'tag-rage-label', rage);
    var rageBar = el('div', 'tag-rage-bar', rage);
    dom.rageFill = el('div', 'tag-rage-fill', rageBar);
    el('i', 'tag-rage-tick t45', rageBar);
    el('i', 'tag-rage-tick t75', rageBar);

    var bay = dom.bay = el('div', 'tag tag-bay', box);
    dom.bayDir = el('div', 'tag-bay-dir', bay);
    dom.bayPin = el('div', 'tag-bay-pin', bay);
    var bayBar = dom.bayBar = el('div', 'tag-bay-bar', bay);
    dom.bayFill = el('div', 'tag-bay-fill', bayBar);

    var door = dom.door = el('div', 'tag tag-door', box);
    dom.doorIcon = el('div', 'tag-door-icon', door);
    dom.doorText = el('div', 'tag-door-text', door);

    var way = dom.way = el('div', 'tag tag-way off', box);
    dom.wayDir = el('div', 'tag-way-dir', way);
    dom.wayText = el('div', 'tag-way-text', way);

    dom.vignette = el('div', 'fx-vignette', root);
    dom.flash = el('div', 'fx-flash', root);
    hud.relabel();
  };

  /** @returns {Element} Where the minimap goes. */
  hud.mapSlot = function () {
    return dom.mapSlot;
  };

  /** Rewrites what does not change on its own, after a language switch. */
  hud.relabel = function () {
    if (!dom) return;
    u().setText(dom.chainLabel, t('hud.chain'));
    u().setText(dom.hpLabel, t('hud.noClaims'));
    u().setText(dom.speedUnit, t('hud.kmh'));
    u().setText(dom.rageLabel, t('hud.rage'));
    u().setText(dom.bayPin, t('hud.bayTag'));
    u().setText(dom.wayText, t('chase.thisWay'));
    dom.prompt._text = null;
    view.street = null;
  };

  /** Puts up a floating line for a moment. */
  function pop(text, cls) {
    var T = TLV.tune.ui;
    var node = u().el('div', 'pop ' + (cls || ''), dom.pops, text);
    view.popT.push({ node: node, t: T.popS });
    while (view.popT.length > T.popMax) view.popT.shift().node.remove();
  }

  /**
   * Shows a line in the toast stack. Repeats of one still on screen are dropped.
   * @param {string} text Display text.
   * @param {string} [cls] Extra class.
   * @param {number} [life] Seconds.
   */
  function toast(text, cls, life) {
    var T = TLV.tune.ui;
    for (var i = 0; i < view.toasts.length; i++) {
      if (view.toasts[i].text === text) {
        view.toasts[i].t = life || T.toastS;
        return;
      }
    }
    var node = u().el('div', 'toast ' + (cls || ''), dom.toasts);
    u().setRich(node, text);
    view.toasts.push({ node: node, t: life || T.toastS, text: text });
    while (view.toasts.length > 3) view.toasts.shift().node.remove();
  }
  hud.toast = toast;

  /** Starts a one-shot prompt, once per run. */
  function once(key, seconds) {
    if (view.seen[key]) return;
    view.seen[key] = true;
    view.prompt.key = key;
    view.prompt.t = seconds;
  }

  function addChevron(S, p) {
    var T = TLV.tune.ui;
    var node = u().el('div', 'chevron', dom.chevrons);
    u().el('div', 'chevron-mark', node);
    u().el('div', 'chevron-label', node, t('incident.' + p.defId));
    view.chevrons.push({ node: node, x: p.x, y: p.y, t: T.chevronS, id: p.id });
    while (view.chevrons.length > T.chevronMax) view.chevrons.shift().node.remove();
  }

  /** The contact feedback: red vignette and bar flash. */
  function hurt(amount) {
    view.vignette = TLV.tune.ui.vignetteS * amount;
    view.barFlash = TLV.tune.ui.barFlashS;
  }

  var SEVERITY = { scrape: 0.5, bump: 0.8, crash: 1 };

  /**
   * Reacts to one event.
   * @param {object} S Sim state.
   * @param {string} name Event name.
   * @param {object} p Payload.
   */
  hud.onEvent = function (S, name, p) {
    var T = TLV.tune.ui;
    switch (name) {
      case 'run.start':
        view = newView();
        foot = null;
        clearKids(dom.pops);
        clearKids(dom.toasts);
        clearKids(dom.chevrons);
        break;
      case 'player.contact':
        hurt(SEVERITY[p.severity] || 0.5);
        break;
      case 'player.hitPed': {
        hurt(1);
        var g = S.game;
        toast(t('toast.hitPed'), 'grave', T.toastLongS);
        if (g && g.pedHits === 1) toast(t('toast.hitPedLast'), 'grave', T.toastLongS);
        break;
      }
      case 'player.nearMiss':
        pop(t(p.tier === 2 ? 'near.2' : 'near.1'), p.tier === 2 ? 'hair' : 'near');
        break;
      case 'player.wrongWay':
        view.wrongWay = p.on;
        if (p.on) toast(t('toast.wrongWay'), 'warn');
        break;
      case 'player.mode':
        view.street = null;
        break;
      case 'player.redRun':
        if (!view.redSeen) toast(t('toast.redRun'));
        view.redSeen = true;
        break;
      case 'player.waterEdge':
        toast(t('toast.water'));
        break;
      case 'player.recover':
        toast(t('toast.recover'), 'warn');
        break;
      case 'nav.recalc':
        if (view.recalcGap > 0) break;
        view.recalcGap = T.recalcToastGapS;
        toast(t('toast.recalc.' + (view.recalc % 2)));
        view.recalc++;
        break;
      case 'errand.start':
        view.stuckT = 0;
        break;
      case 'errand.search':
        if (p.bayId >= 0) toast(t('toast.search'));
        break;
      case 'inspector.ticket':
        toast(t(p.kind === 'TOW' ? 'toast.tow' : 'toast.ticket', { money: TLV.ui.strings.money(-Math.abs(p.amount)) }), 'warn', T.toastLongS);
        break;
      case 'contest.start':
        toast(t('toast.contestStart'), 'warn');
        break;
      case 'contest.state':
        if (p.state === 'BLINK' && S.game && S.game.errandIndex >= 1) once('prompt.wait', T.oneShotS);
        break;
      case 'contest.result':
        if (p.winner === 'rival') {
          toast(t('toast.contestWon'), 'warn');
          if (S.game && S.game.errandIndex >= 1) once('prompt.parkBadly', T.oneShotS);
        } else if (p.tier === 'CURSE') {
          toast(t('toast.curse'));
        } else if (p.tier === 'BLOCK') {
          toast(t('toast.block'), 'warn');
        } else if (p.tier === 'KNIFE') {
          toast(t('toast.knife'), 'grave');
        }
        break;
      case 'knife.strike':
        view.flash = T.whiteFlashS;
        pop(t('chase.strike'), 'near');
        break;
      case 'incident.telegraph':
        addChevron(S, p);
        break;
      case 'score.bonus': {
        var extra = [];
        if (p.amount) {
          extra.push(TLV.ui.strings.isolate(TLV.ui.strings.signedMoney(p.amount)));
          view.moneySaid += p.amount;
        }
        if (p.seconds) extra.push(t('hud.seconds', { n: '+' + Math.round(p.seconds) }));
        pop(t('bonus.' + p.id) + (extra.length ? '  ' + extra.join('  ') : ''), 'bonus');
        break;
      }
      case 'score.chain':
        dom.chainMult.classList.remove('bump');
        if (p.n > 0) {
          void dom.chainMult.offsetWidth;
          dom.chainMult.classList.add('bump');
        }
        break;
      case 'clock.warn':
        toast(t('toast.clock.' + p.level), 'warn');
        break;
      default:
        break;
    }
  };

  function clearKids(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function frameClock(g, parking) {
    var T = TLV.tune.game;
    u().setText(dom.clock, hud.clockText(g.clock));
    dom.clockBox.classList.toggle('warn1', g.clock <= T.clockWarn1 && g.clock > T.clockWarn2);
    dom.clockBox.classList.toggle('warn2', g.clock <= T.clockWarn2);
    var running = g.phase === 'DRIVE' || g.phase === 'SEARCH' || g.phase === 'HOLD';
    dom.clockBox.classList.toggle('frozen', !running);
    dom.clockBox.classList.toggle('parking-view', parking);
  }

  function frameMoney(g, dt) {
    var T = TLV.tune.ui;
    u().setText(dom.money, TLV.ui.strings.money(g.money));
    dom.money.classList.toggle('loss', g.money < 0);
    if (view.money !== null) {
      // A bonus has said its own money on its own line, so only the rest of the change pops.
      var delta = g.money - view.money - view.moneySaid;
      if (Math.abs(delta) >= T.moneyPopMin) pop(TLV.ui.strings.isolate(TLV.ui.strings.signedMoney(delta)), delta > 0 ? 'cash' : 'loss');
    }
    view.money = g.money;
    view.moneySaid = 0;
    var c = g.chain;
    var on = c.n > 0;
    u().show(dom.chain, on || c.bank > 0);
    u().show(dom.chainMult, on);
    u().show(dom.chainBarBox, on);
    if (on) {
      u().setText(dom.chainMult, 'x' + c.mult.toFixed(1));
      dom.chainFill.style.width = (100 * TLV.math.clamp(c.windowT / TLV.tune.game.chainWindowS, 0, 1)).toFixed(1) + '%';
    }
    u().setText(dom.chainBank, c.bank > 0 ? TLV.ui.strings.money(c.bank) : '');
    return dt;
  }

  function frameHp(g, dt) {
    var hp = Math.max(0, g.hp);
    dom.hpFill.style.width = hp.toFixed(1) + '%';
    u().setText(dom.hpValue, String(Math.ceil(hp)));
    dom.hpBox.classList.toggle('low', hp <= 30);
    if (view.hp !== null && hp < view.hp - 0.01) {
      u().setText(dom.hpDelta, '-' + Math.round(view.hp - hp));
      view.hpPop = 1.2;
      view.barFlash = Math.max(view.barFlash, TLV.tune.ui.barFlashS);
    }
    view.hp = hp;
    view.hpPop = Math.max(0, view.hpPop - dt);
    u().show(dom.hpDelta, view.hpPop > 0);
    view.barFlash = Math.max(0, view.barFlash - dt);
    dom.hpBox.classList.toggle('flash', view.barFlash > 0);
  }

  function frameSpeed(S) {
    var p = S.player;
    var foot = p.mode === 'FOOT';
    u().show(dom.speed, !foot);
    if (foot) return;
    u().setText(dom.speedValue, String(Math.round(Math.abs(S.vehicles[0].v) * 3.6)));
  }

  function frameStreet(S) {
    var name = hud.streetName(S, TLV.ui.strings.lang());
    if (name === null) {
      u().show(dom.street, view.street !== null);
      return;
    }
    view.street = name;
    u().setText(dom.street, name || t('street.unnamed'));
    u().show(dom.street, true);
  }

  function frameArrow(S) {
    var g = S.game;
    var phase = g.phase;
    var nav = g.nav;
    var inChase = !!(g.knife && g.knife.stage === 'CHASE');
    var on = !!g.errand && (phase === 'DRIVE' || phase === 'SEARCH' || inChase);
    u().show(dom.arrow, on);
    if (!on) return;
    var way = inChase ? hud.footHeading(S) : null;
    var rel = TLV.math.wrapPi((way === null ? nav.arrowH : way) - TLV.ui.viewYaw(S));
    dom.arrowPlane.style.transform = 'rotateX(58deg) rotateZ(' + (-rel).toFixed(3) + 'rad)';
    // A running renderer draws the 3D arrow in the scene, in this same spot, so this one steps aside and its distance stays.
    dom.arrow.classList.toggle('scene', !!(TLV.render && TLV.render.frame));
    dom.arrow.classList.toggle('wrong', !!S.player.wrongWay && !inChase);
    dom.arrow.classList.toggle('foot', inChase);
    // One number for each thing: the road left to the bay, or the run left to the door. The label says which.
    var left = inChase ? doorLeft(S) : nav.remaining;
    u().setText(dom.arrowDist, Number.isFinite(left) ? t(inChase ? 'hud.door' : 'hud.bay') + ' ' + t('hud.metres', { n: Math.round(left) }) : '');
  }

  function frameChip(S, parking) {
    var g = S.game;
    var e = g.errand;
    var on = !!e && (g.phase === 'DRIVE' || g.phase === 'SEARCH' || g.phase === 'HOLD');
    u().show(dom.chip, on);
    if (!on) return;
    // The parking view shows the bay in the top of the frame, right where this card sits. The minimap keeps the door marked.
    dom.chip.classList.toggle('parking-view', parking);
    var lang = TLV.ui.strings.lang();
    // On a shared day the count is of the board, not of a day's seven.
    var shared = u().versus.errandCount(S);
    u().setText(dom.chipIndex, t('hud.errand', shared || { n: e.index + 1, total: 7 }));
    u().setText(dom.chipText, e.text[lang] || e.text.en);
  }

  /** The tutorial beats of GAME_DESIGN 19, on errand 1. They fire by route distance. */
  function beats(S, dt) {
    var g = S.game;
    var T = TLV.tune.ui;
    var veh = S.vehicles[0];
    var e = g.errand;
    if (!e || g.errandIndex !== 0) return;
    if (g.phase === 'CARD' || g.phase === 'DRIVE') {
      var signals = TLV.world.signals;
      var lane = S.player.laneId;
      var state = lane >= 0 && signals.laneState ? signals.laneState(S, lane) : null;
      var green = state === TLV.const.SIG.GREEN;
      var travelled = e.routeLen - g.nav.remaining;
      if (view.wasGreen === false && green && travelled < T.launchPromptMaxTravelM) once('prompt.launch', T.launchPromptS);
      if (state !== null) view.wasGreen = green;
      if (g.phase === 'DRIVE' && travelled >= T.handbrakePromptAtM) once('prompt.handbrake', T.handbrakePromptS);
    }
    if (!view.seen['prompt.drive'] && (g.phase === 'CARD' || (g.phase === 'DRIVE' && g.phaseT < T.drivePromptMaxS))) {
      if (Math.abs(veh.v) < T.drivePromptMoveV) view.driveDue = true;
      else view.driveDue = false;
    } else {
      view.driveDue = false;
    }
    return dt;
  }

  /**
   * This reads what the player is doing: throttle or reverse held, on a car getting nowhere. That is a car standing still, or one that has
   * touched something lately and stays within stuckRoomM of where the attempt began, so rocking against a wall at 2 m/s keeps the count.
   * A car that has simply not moved yet offers no tow. A red light does not count, since waiting there is the rule, unless the car is
   * against something, which no green will cure.
   * @returns {boolean} True when the tow is worth offering.
   */
  function stuckNow(S, dt) {
    var g = S.game;
    var T = TLV.tune.ui;
    var c = S.controls;
    var veh = S.vehicles[0];
    var driving = g.phase === 'DRIVE' || g.phase === 'SEARCH';
    var touching = S.t - S.player.touchT < T.stuckTouchS;
    var still = Math.abs(veh.v) < T.stuckV || touching;
    var lane = S.player.laneId;
    var signals = TLV.world.signals;
    var red = lane >= 0 && signals.laneState && signals.laneState(S, lane) !== TLV.const.SIG.GREEN;
    var dx = veh.x - view.stuckX;
    var dy = veh.y - view.stuckY;
    if (!driving || !still || (red && !touching) || dx * dx + dy * dy > T.stuckRoomM * T.stuckRoomM) {
      view.stuckT = 0;
      view.stuckIdleT = 0;
    }
    if (view.stuckT === 0) {
      view.stuckX = veh.x;
      view.stuckY = veh.y;
    }
    if (!driving || !still || (red && !touching)) return false;
    var pressing = !c.handbrake && (c.throttle > T.stuckInput || c.brake > T.stuckInput);
    if (pressing) {
      view.stuckT += dt;
      view.stuckIdleT = 0;
    } else {
      view.stuckIdleT += dt;
      if (view.stuckIdleT >= T.stuckForgetS) view.stuckT = 0;
    }
    return view.stuckT >= T.stuckPromptS;
  }

  /** @returns {number} Metres along a ray to a box, 0 from inside it, Infinity if it misses. The ray's direction is a unit vector. */
  function rayToBox(ox, oy, dx, dy, box) {
    var c = Math.cos(box.h);
    var s = Math.sin(box.h);
    var ex = ox - box.x;
    var ey = oy - box.y;
    var px = ex * c + ey * s;
    var py = -ex * s + ey * c;
    var vx = dx * c + dy * s;
    var vy = -dx * s + dy * c;
    var hl = box.length / 2;
    var hw = box.width / 2;
    var near = 0;
    var far = Infinity;
    if (Math.abs(vx) < 1e-9) {
      if (Math.abs(px) > hl) return Infinity;
    } else {
      var a0 = (-hl - px) / vx;
      var a1 = (hl - px) / vx;
      near = Math.max(near, Math.min(a0, a1));
      far = Math.min(far, Math.max(a0, a1));
    }
    if (Math.abs(vy) < 1e-9) {
      if (Math.abs(py) > hw) return Infinity;
    } else {
      var b0 = (-hw - py) / vy;
      var b1 = (hw - py) / vy;
      near = Math.max(near, Math.min(b0, b1));
      far = Math.min(far, Math.max(b0, b1));
    }
    return near <= far ? near : Infinity;
  }

  var spotIds = [];
  var spotBox = { x: 0, y: 0, h: 0, length: 0, width: 0 };
  var doorBox = { x: 0, y: 0, h: 0, length: 0, width: 0 };

  /**
   * How far the car can roll before it meets something solid, measured from whichever end leads. It looks along the car and along the
   * bay, because the line says to straighten up, and a car that does swings onto the bay's axis.
   * @param {object} S Sim state, with a bay armed.
   * @returns {number} Metres, Infinity with nothing in reach.
   */
  function roomAhead(S) {
    var T = TLV.tune.ui;
    var veh = S.vehicles[0];
    var way = veh.v < 0 ? -1 : 1;
    var world = TLV.world.parking;
    var side = veh.width / 2 + T.armRoomSideM;
    var spot = world.spot(S.world, S.game.errand.bayId);
    var c = Math.cos(veh.h) * way;
    var s = Math.sin(veh.h) * way;
    var along = spot ? (Math.cos(spot.h) * c + Math.sin(spot.h) * s >= 0 ? 1 : -1) : 1;
    var aims = [[c, s]];
    if (spot) aims.push([Math.cos(spot.h) * along, Math.sin(spot.h) * along]);
    var best = Infinity;

    function look(box) {
      for (var a = 0; a < aims.length; a++) {
        var dx = aims[a][0];
        var dy = aims[a][1];
        for (var k = -1; k <= 1; k++) {
          var ox = veh.x + c * veh.length / 2 - s * side * k;
          var oy = veh.y + s * veh.length / 2 + c * side * k;
          best = Math.min(best, rayToBox(ox, oy, dx, dy, box));
        }
      }
    }

    world.spotsNear(S.world, veh.x, veh.y, T.armRoomScanM, spotIds);
    for (var i = 0; i < spotIds.length; i++) {
      var occ = world.state(S, spotIds[i]);
      if (occ !== TLV.const.OCC.PARKED && occ !== TLV.const.OCC.MOTO) continue;
      world.boxOf(S.world, spotIds[i], occ, spotBox);
      look(spotBox);
    }
    for (var j = 1; j < S.vehicles.length; j++) {
      var o = S.vehicles[j];
      if (o.active && TLV.math.dist(o.x, o.y, veh.x, veh.y) < T.armRoomScanM) look(o);
    }
    return best;
  }

  /**
   * The bay line. The sim wants the car rolling until the pose would pass, because stopping is what locks it, but a box is short: on a
   * car about to run out of room the line says to brake instead, soon enough for a person to do it, and no sooner, because a driver who
   * obeys it keeps the pose of that moment. It scales with speed, so a walking car hears it inside the last metre and a fast one well
   * before. A contact costs more than an ugly park, and can bounce the car out of the box.
   * @param {object} S Sim state.
   * @returns {string} String key.
   */
  hud.parkKey = function (S) {
    var key = TLV.ui.strings.parkKey(S.game.park);
    if (key !== 'park.ARMED') return key;
    var T = TLV.tune.ui;
    var v = Math.abs(S.vehicles[0].v);
    var stop = v * T.armReactS + v * v / (2 * TLV.tune.player.brake) + T.armRoomSpareM;
    return roomAhead(S) <= stop ? 'park.BRAKE' : key;
  };

  /** Picks the line for the prompt strip, most urgent first. */
  function promptFor(S, dt) {
    var g = S.game;
    var T = TLV.tune.ui;
    var v = Math.abs(S.vehicles[0].v);
    var stuck = stuckNow(S, dt);
    if (g.phase === 'HOLD') {
      var park = g.park;
      if (park.kind === 'CURB') return { text: t('park.CURB') };
      if (park.kind === 'DOUBLE') return { text: t('park.DOUBLE') };
      var parkKey = hud.parkKey(S);
      return { text: t(parkKey), flash: parkKey === 'park.BRAKE' };
    }
    if (g.phase === 'BLOCKED') return { text: t('prompt.blocked') };
    if (view.prompt.t > 0) {
      view.prompt.t -= dt;
      return { text: t(view.prompt.key), cls: 'tip' };
    }
    if (view.driveDue) return { text: t('prompt.drive'), cls: 'tip' };
    if (stuck) return { text: t('prompt.stuck'), cls: 'tip' };
    if (g.nav.missed) return { text: t('prompt.missed.' + g.nav.missed), cls: 'tip' };
    if (g.phase === 'SEARCH') {
      var e = g.errand;
      if (e && e.bayId < 0) return { text: t('prompt.noBay'), cls: 'tip' };
      if (v >= T.searchPromptMoveV && g.nav.remaining <= T.searchPromptLeftM) {
        return { text: t('prompt.search'), flash: v > T.searchFlashV };
      }
    }
    return null;
  }

  function framePrompt(S, dt) {
    var g = S.game;
    beats(S, dt);
    var live = g.phase === 'DRIVE' || g.phase === 'SEARCH' || g.phase === 'HOLD' || g.phase === 'BLOCKED' || (g.phase === 'CARD' && g.errandIndex === 0);
    var line = live ? promptFor(S, dt) : null;
    u().show(dom.prompt, !!line);
    if (line) {
      u().setRich(dom.prompt, line.text);
      dom.prompt.classList.toggle('flash', !!line.flash);
      dom.prompt.classList.toggle('tip', line.cls === 'tip');
    }
    var holding = g.phase === 'HOLD';
    u().show(dom.parkBar, holding);
    if (holding) dom.parkFill.style.width = (100 * TLV.math.clamp(g.park.bar, 0, 1)).toFixed(1) + '%';
  }

  function framePops(dt) {
    view.recalcGap = Math.max(0, view.recalcGap - dt);
    for (var i = view.popT.length - 1; i >= 0; i--) {
      var item = view.popT[i];
      item.t -= dt;
      if (item.t <= 0) {
        item.node.remove();
        view.popT.splice(i, 1);
      }
    }
    for (var k = view.toasts.length - 1; k >= 0; k--) {
      var line = view.toasts[k];
      line.t -= dt;
      if (line.t <= 0) {
        line.node.remove();
        view.toasts.splice(k, 1);
      }
    }
  }

  /**
   * Places a tag at a world point.
   * @param {Element} node Tag.
   * @param {number} x World metres.
   * @param {number} y World metres.
   * @param {number} z Height.
   * @param {Array<?object>} [keepOff] Boxes the tag may not touch. It hides instead, because it can only mean one spot.
   * @param {{hw:number,hh:number}} [size] Half size in pixels, for that test.
   * @returns {boolean} False when it has no place on screen.
   */
  function placeTag(node, x, y, z, keepOff, size) {
    var at = TLV.ui.project(x, y, z);
    if (!at || !at.visible) return false;
    if (keepOff) {
      var box = { x: at.sx, y: at.sy - size.hh, hw: size.hw, hh: size.hh };
      for (var i = 0; i < keepOff.length; i++) {
        if (keepOff[i] && touching(box, keepOff[i], 0)) return false;
      }
    }
    node.style.transform = 'translate(' + at.sx.toFixed(1) + 'px,' + at.sy.toFixed(1) + 'px) translate(-50%,-100%)';
    return true;
  }

  /** @param {object} a Box, centre and half sizes. @param {object} b Box. @param {number} gap Pixels. @returns {boolean} True if they meet. */
  function touching(a, b, gap) {
    return Math.abs(a.x - b.x) < a.hw + b.hw + gap && Math.abs(a.y - b.y) < a.hh + b.hh + gap;
  }

  /**
   * Moves a box out of another, up or down if that stays in its band, else sideways.
   * @param {object} a Box to move.
   * @param {object} b Box to leave alone.
   * @param {number} minY Lowest centre y allowed.
   * @param {number} maxY Highest centre y allowed.
   */
  function stepClear(a, b, minY, maxY) {
    var gap = emPx() * TLV.tune.ui.tagGapEm;
    if (!touching(a, b, gap)) return;
    var reach = a.hh + b.hh + gap;
    var first = a.y <= b.y ? b.y - reach : b.y + reach;
    var second = a.y <= b.y ? b.y + reach : b.y - reach;
    if (first >= minY && first <= maxY) a.y = first;
    else if (second >= minY && second <= maxY) a.y = second;
    else a.x = b.x + (a.x >= b.x ? 1 : -1) * (a.hw + b.hw + gap);
  }

  /** @returns {number} Pixels in one em of the HUD, the same sum as the font size of #ui-root in css/ui.css. */
  function emPx() {
    return Math.min(window.innerHeight / 45, window.innerWidth / 80);
  }

  /**
   * Keeps a pinned tag off the bay's box on screen, by stepping it sideways toward the middle of the frame.
   * @param {object} tag The tag's box, moved in place.
   * @param {{l:number,r:number,t:number,b:number}} box The bay on screen.
   */
  function pinClearOfBox(tag, box) {
    var gap = emPx() * TLV.tune.ui.tagGapEm;
    var apart = tag.x + tag.hw + gap <= box.l || tag.x - tag.hw - gap >= box.r || tag.y + tag.hh + gap <= box.t || tag.y - tag.hh - gap >= box.b;
    if (apart) return;
    var mid = window.innerWidth / 2;
    var left = box.l - tag.hw - gap;
    var right = box.r + tag.hw + gap;
    tag.x = Math.abs(left - mid) <= Math.abs(right - mid) ? left : right;
  }

  /**
   * Places the bay tag. With the bay on screen and clear of the top HUD it stands past the box's far edge, so it never covers what the
   * player is steering into. Otherwise it pins just under the top HUD with a caret toward the bay, because the parking view loses the
   * bay off the top of the frame. How far it is stays with the arrow, so the screen never shows it twice.
   * @param {object} S Sim state.
   * @param {number} x Bay, world metres.
   * @param {number} y Bay, world metres.
   * @param {boolean} parking True in the parking view.
   * @param {?object} arrow The arrow's box, in the view that has one.
   * @returns {{sx:number,sy:number,pinned:boolean,box:object}} Where the tag went.
   */
  function placeBay(S, x, y, parking, arrow) {
    var T = TLV.tune.ui;
    var M = TLV.math;
    var em = emPx();
    var top = em * (parking ? T.tagPinTopParkEm : T.tagPinTopChipEm);
    var at = TLV.ui.project(x, y, T.bayTagZ);
    var edges = at ? boxOnScreen(S) : null;
    var overX = at ? (edges ? (edges.l + edges.r) / 2 : at.sx) : 0;
    var overY = at ? (edges ? Math.min(at.sy, edges.t - em * T.tagGapEm) : at.sy) : 0;
    if (at && at.visible && overY - em * T.tagBayHeightEm >= top) {
      dom.bay.style.transform = 'translate(' + overX.toFixed(1) + 'px,' + overY.toFixed(1) + 'px) translate(-50%,-100%)';
      var tall = em * T.tagBayHeightEm / 2;
      return { sx: overX, sy: overY, pinned: false, box: { x: overX, y: overY - tall, hw: em * T.bayHalfWEm, hh: tall } };
    }
    var rel = M.wrapPi(Math.atan2(y - S.player.fy, x - S.player.fx) - TLV.ui.viewYaw(S));
    var mid = window.innerWidth / 2;
    var reach = mid - em * T.tagPinSideEm;
    // Ahead of the car the projection still holds above the frame. Behind it the projection flips, so the bearing decides.
    var sx = at && Math.cos(rel) > 0 ? at.sx : mid - Math.sin(rel) * mid;
    sx = M.clamp(sx, mid - reach, mid + reach);
    var box = { x: sx, y: top + em * T.bayPinHalfHEm, hw: em * T.bayPinHalfWEm, hh: em * T.bayPinHalfHEm };
    // Behind the car the projection flips, so there the box's numbers say nothing about the screen.
    if (edges && Math.cos(rel) > 0) pinClearOfBox(box, edges);
    if (arrow) stepClear(box, arrow, box.y, box.y);
    sx = box.x;
    dom.bay.style.transform = 'translate(' + sx.toFixed(1) + 'px,' + top.toFixed(1) + 'px) translateX(-50%)';
    dom.bayDir.style.transform = 'rotate(' + (-rel).toFixed(3) + 'rad)';
    return { sx: sx, sy: top, pinned: true, box: box };
  }

  /**
   * Places the rage gauge in the chase view: over the rival, stepped clear of the bay tag and held under the errand chip.
   * @param {object} veh Rival.
   * @param {?object} bay The bay tag's box.
   * @returns {?object} The gauge's box, or null when he has no place on screen.
   */
  function placeRageOver(veh, bay) {
    var T = TLV.tune.ui;
    var em = emPx();
    var at = TLV.ui.project(veh.x, veh.y, T.rivalTagZ);
    if (!at || !at.visible) return null;
    var h = em * T.rageHalfHEm;
    var box = { x: at.sx, y: at.sy - h, hw: em * T.rageHalfWEm, hh: h };
    var minY = em * T.tagPinTopChipEm + h;
    var maxY = window.innerHeight - em * T.rageFloorEm - h;
    box.y = TLV.math.clamp(box.y, minY, maxY);
    if (bay) stepClear(box, bay, minY, maxY);
    dom.rage.style.transform = 'translate(' + box.x.toFixed(1) + 'px,' + box.y.toFixed(1) + 'px) translate(-50%,-50%)';
    return box;
  }

  /**
   * Places the rage gauge in the parking view. Over the rival it would sit on the bay he is racing for and on his own car, so it stands
   * off him on the side away from the bay, and leans out from the middle of the screen, where the player's car and the arrow are.
   * @param {object} veh Rival.
   * @param {{sx:number,sy:number,box:object}} bay Where the bay tag is.
   * @returns {?object} The gauge's box, or null when he has no place on screen.
   */
  function placeRageBeside(veh, bay) {
    var T = TLV.tune.ui;
    var M = TLV.math;
    var em = emPx();
    var at = TLV.ui.project(veh.x, veh.y, 0);
    if (!at || !at.visible) return null;
    var cx = at.sx;
    var cy = at.sy;
    var half = veh.length / 2;
    var nose = TLV.ui.project(veh.x + Math.cos(veh.h) * half, veh.y + Math.sin(veh.h) * half, 0);
    var longX = Math.abs(nose.sx - cx);
    var longY = Math.abs(nose.sy - cy);
    var long = Math.max(1, Math.sqrt(longX * longX + longY * longY));
    var wide = long * veh.width / veh.length;
    var carX = longX + wide * longY / long;
    var carY = longY + wide * longX / long;
    var w = em * T.rageHalfWEm;
    var h = em * T.rageHalfHEm;
    var gap = em * T.rageGapEm;
    var dx = cx - bay.sx;
    var dy = cy - bay.sy;
    var mid = window.innerWidth / 2;
    var gx = cx;
    var gy = cy;
    if (Math.abs(dy) * 2 >= Math.abs(dx)) {
      gy += (dy >= 0 ? 1 : -1) * (carY + h + gap);
      gx += (cx >= mid ? 1 : -1) * Math.max(0, w - carX);
    } else {
      gx += (dx >= 0 ? 1 : -1) * (carX + w + gap);
    }
    gx = M.clamp(gx, w + gap, window.innerWidth - w - gap);
    var minY = em * T.tagPinTopParkEm + h;
    var maxY = window.innerHeight - em * T.rageFloorEm - h;
    var box = { x: gx, y: M.clamp(gy, minY, maxY), hw: w, hh: h };
    stepClear(box, bay.box, minY, maxY);
    box.x = M.clamp(box.x, w + gap, window.innerWidth - w - gap);
    dom.rage.style.transform = 'translate(' + box.x.toFixed(1) + 'px,' + box.y.toFixed(1) + 'px) translate(-50%,-50%)';
    return box;
  }

  /** @returns {?object} The active vehicle with this id. */
  hud.findVehicle = function (S, id) {
    for (var i = 0; i < S.vehicles.length; i++) {
      var veh = S.vehicles[i];
      if (veh.active && veh.id === id) return veh;
    }
    return null;
  };

  /** @returns {?object} The space the arrow and its distance take in the chase view. Its 3D twin is drawn by WP-RENDER, in the same spot. */
  function arrowBox(on) {
    if (!on) return null;
    var T = TLV.tune.ui;
    var em = emPx();
    return { x: window.innerWidth / 2, y: em * (T.arrowTopEm + T.arrowBottomEm) / 2, hw: em * T.arrowHalfWEm, hh: em * (T.arrowBottomEm - T.arrowTopEm) / 2 };
  }

  /** @returns {object} The errand chip's box. */
  function chipBox() {
    var T = TLV.tune.ui;
    var em = emPx();
    return { x: window.innerWidth / 2, y: em * T.tagPinTopChipEm / 2, hw: em * T.chipHalfWEm, hh: em * T.tagPinTopChipEm / 2 };
  }

  /** @returns {?{l:number,r:number,t:number,b:number}} The rectangle round the bay's painted box on screen. */
  function boxOnScreen(S) {
    var spot = TLV.world.parking.spot(S.world, S.game.errand.bayId);
    if (!spot) return null;
    var c = Math.cos(spot.h);
    var s = Math.sin(spot.h);
    var out = { l: Infinity, r: -Infinity, t: Infinity, b: -Infinity };
    [[1, 1], [1, -1], [-1, -1], [-1, 1]].forEach(function (k) {
      var a = k[0] * spot.len / 2;
      var w = k[1] * spot.wid / 2;
      var at = TLV.ui.project(spot.x + a * c - w * s, spot.y + a * s + w * c, 0);
      if (!at) return;
      out.l = Math.min(out.l, at.sx);
      out.r = Math.max(out.r, at.sx);
      out.t = Math.min(out.t, at.sy);
      out.b = Math.max(out.b, at.sy);
    });
    return out;
  }

  /**
   * The parking view has the car low in the middle of the frame and the box coming down beside it, so the words leave the middle: the
   * toasts take the side column and the prompt and bar the ground beside the car, all on the side away from the box. If the box lies on
   * that ground too, which takes a car turned right round next to it, the prompt and bar rise into the column.
   * @param {object} S Sim state.
   * @param {boolean} parking True in the parking view.
   * @param {?object} bayAt Where the bay tag went.
   */
  function frameParkingSide(S, parking, bayAt) {
    var T = TLV.tune.ui;
    var raised = false;
    if (parking && bayAt) {
      var mid = window.innerWidth / 2;
      if (bayAt.sx > mid + T.parkSideSlackPx) view.parkSide = 'left';
      else if (bayAt.sx < mid - T.parkSideSlackPx) view.parkSide = 'right';
      var em = emPx();
      var at = mid + (view.parkSide === 'right' ? 1 : -1) * em * T.parkWordsOffEm;
      var box = boxOnScreen(S);
      var h = window.innerHeight;
      raised = !!box && box.b > h - em * T.parkWordsHighEm && box.t < h && box.l < at + em * T.parkWordsHalfWEm && box.r > at - em * T.parkWordsHalfWEm;
    }
    var right = parking && view.parkSide === 'right';
    [dom.toasts, dom.prompt, dom.parkBar].forEach(function (node) {
      node.classList.toggle('parking-view', parking);
      node.classList.toggle('side-right', right);
      node.classList.toggle('raised', raised);
    });
  }

  function frameTags(S, parking) {
    var T = TLV.tune.ui;
    var g = S.game;
    var nav = g.nav;
    var e = g.errand;
    var c = g.contest;
    var live = g.phase === 'DRIVE' || g.phase === 'SEARCH' || g.phase === 'HOLD' || g.phase === 'PAYOUT';
    var arrow = arrowBox(!parking && !dom.arrow.classList.contains('off'));

    // The bay goes first, because the gauge steps around wherever it landed. The door is last, and hides rather than cover anything.
    var showBay = !!e && e.bayId >= 0 && (g.phase === 'HOLD' || (g.phase === 'SEARCH' && (parking || nav.remaining <= T.bayTagMaxM)));
    var bayAt = showBay ? placeBay(S, nav.targetX, nav.targetY, parking, arrow) : null;
    var bayPinned = !!bayAt && bayAt.pinned;
    dom.bay.classList.toggle('pinned', bayPinned);
    u().show(dom.bayDir, bayPinned);
    if (showBay) {
      dom.bayFill.style.width = (100 * TLV.math.clamp(g.park.bar, 0, 1)).toFixed(1) + '%';
      u().show(dom.bayBar, g.phase === 'HOLD' && !bayPinned);
    }
    u().show(dom.bay, showBay);
    frameParkingSide(S, parking, bayAt);

    var showRage = false;
    var rageBox = null;
    if (c && live && !c.winner && c.state !== 'WON' && c.state !== 'FAILED') {
      var rival = hud.findVehicle(S, c.rivalId);
      if (rival) {
        showRage = true;
        rageBox = parking && bayAt ? placeRageBeside(rival, bayAt) : placeRageOver(rival, bayAt ? bayAt.box : null);
        dom.rageFill.style.width = TLV.math.clamp(c.rage, 0, 100).toFixed(0) + '%';
        dom.rage.classList.toggle('hot', c.rage >= 75);
        dom.rage.classList.toggle('warm', c.rage >= 45 && c.rage < 75);
      }
    }
    u().show(dom.rage, showRage);
    var pinned = showRage && !rageBox;
    dom.rage.classList.toggle('pinned', pinned);
    if (pinned) dom.rage.style.transform = '';

    var showDoor = false;
    var chase = !!(g.knife && g.knife.stage === 'CHASE');
    if (e && (g.phase === 'DRIVE' || g.phase === 'SEARCH' || chase)) {
      var d = chase ? doorLeft(S) : TLV.math.dist(S.player.fx, S.player.fy, e.doorX, e.doorY);
      var em = emPx();
      // On the run the door is the goal, dead ahead under the arrow, so there it holds its place. Otherwise it gives way to everything.
      var keepOff = chase ? null : [arrow, parking ? null : chipBox(), bayAt ? bayAt.box : null, rageBox];
      if (d <= T.doorTagMaxM && placeTag(dom.door, e.doorX, e.doorY, T.doorTagZ, keepOff, { hw: em * T.doorHalfWEm, hh: em * T.doorHalfHEm })) {
        showDoor = true;
        // On the run the arrow carries the distance, right beside this, so here the tag only says what it marks.
        u().setText(dom.doorText, chase ? t('hud.door') : t('hud.door') + ' ' + t('hud.metres', { n: Math.round(d) }));
      }
    }
    u().show(dom.door, showDoor);
  }

  // ---- The way to the door on foot. ------------------------------------------------------------------------------------------------
  //
  // In a chase the sim's arrow is a straight bearing, which can lead into a shop front or a queue of stopped cars, and a runner who follows
  // it never arrives. So the HUD works out the way on foot and shows the bend: a grid of the ground round the chase, a field of walking
  // metres spreading out from the door, and the runner's next corner read off it. It is the same ground the sim's runner is held to: walls,
  // props, water, parked cars and whatever vehicle stands still. A field and not one path, so it holds wherever the player goes next. The
  // corner is what both arrows point at (hud.footHeading): one screen, one instruction.

  /** The chase's grid, or null. See buildFoot. */
  var foot = null;
  var heapIds = [];
  var heapKeys = [];

  function heapPush(id, key) {
    var i = heapIds.length;
    heapIds.push(id);
    heapKeys.push(key);
    while (i > 0) {
      var up = (i - 1) >> 1;
      if (heapKeys[up] <= key) break;
      heapIds[i] = heapIds[up];
      heapKeys[i] = heapKeys[up];
      i = up;
    }
    heapIds[i] = id;
    heapKeys[i] = key;
  }

  /** @returns {number} The cell with the lowest key, removed. */
  function heapPop() {
    var top = heapIds[0];
    var id = heapIds.pop();
    var key = heapKeys.pop();
    var n = heapIds.length;
    if (!n) return top;
    var i = 0;
    for (;;) {
      var a = 2 * i + 1;
      if (a >= n) break;
      if (a + 1 < n && heapKeys[a + 1] < heapKeys[a]) a++;
      if (heapKeys[a] >= key) break;
      heapIds[i] = heapIds[a];
      heapKeys[i] = heapKeys[a];
      i = a;
    }
    heapIds[i] = id;
    heapKeys[i] = key;
    return top;
  }

  /** Marks the cell under a world point. Off the grid is no ground of ours. */
  function markAt(grid, field, x, y) {
    var cx = Math.floor((x - grid.x0) / grid.cell);
    var cy = Math.floor((y - grid.y0) / grid.cell);
    if (cx >= 0 && cy >= 0 && cx < grid.nx && cy < grid.ny) field[cy * grid.nx + cx] = 1;
  }

  /** Marks a line of cells, stepping finely enough to leave no hole for a diagonal. */
  function markLine(grid, field, ax, ay, bx, by) {
    var n = Math.ceil(TLV.math.dist(ax, ay, bx, by) / (grid.cell * 0.4)) + 1;
    for (var i = 0; i <= n; i++) markAt(grid, field, ax + (bx - ax) * i / n, ay + (by - ay) * i / n);
  }

  /**
   * Marks a solid box, length along box.h, by the cells whose centre a runner's body cannot stand on. Any cell it touches would be too
   * many: the 2 m between two parked cars is a gap a person really uses, and that would close it.
   */
  function markBox(grid, field, box) {
    var c = Math.cos(box.h);
    var s = Math.sin(box.h);
    var body = TLV.tune.player.footRadius;
    var hl = box.length / 2 + body;
    var hw = box.width / 2 + body;
    var rx = Math.abs(hl * c) + Math.abs(hw * s);
    var ry = Math.abs(hl * s) + Math.abs(hw * c);
    var cx0 = Math.max(0, Math.floor((box.x - rx - grid.x0) / grid.cell));
    var cx1 = Math.min(grid.nx - 1, Math.floor((box.x + rx - grid.x0) / grid.cell));
    var cy0 = Math.max(0, Math.floor((box.y - ry - grid.y0) / grid.cell));
    var cy1 = Math.min(grid.ny - 1, Math.floor((box.y + ry - grid.y0) / grid.cell));
    for (var cy = cy0; cy <= cy1; cy++) {
      for (var cx = cx0; cx <= cx1; cx++) {
        var ex = grid.x0 + (cx + 0.5) * grid.cell - box.x;
        var ey = grid.y0 + (cy + 0.5) * grid.cell - box.y;
        if (Math.abs(ex * c + ey * s) <= hl && Math.abs(-ex * s + ey * c) <= hw) field[cy * grid.nx + cx] = 1;
      }
    }
  }

  /**
   * Lays the grid over the ground between the runner and the door, and marks what never moves.
   * @param {object} S Sim state.
   * @returns {object} The grid.
   */
  function buildFoot(S) {
    var T = TLV.tune.ui;
    var W = S.world;
    var e = S.game.errand;
    var f = S.player.foot;
    var cell = T.footCellM;
    var pad = T.footPadM;
    var x0 = Math.min(f.x, e.doorX) - pad;
    var y0 = Math.min(f.y, e.doorY) - pad;
    var nx = Math.ceil((Math.max(f.x, e.doorX) + pad - x0) / cell);
    var ny = Math.ceil((Math.max(f.y, e.doorY) + pad - y0) / cell);
    var grid = {
      x0: x0, y0: y0, nx: nx, ny: ny, cell: cell, doorX: e.doorX, doorY: e.doorY,
      fixed: new Uint8Array(nx * ny), cars: new Uint8Array(nx * ny), dist: new Float64Array(nx * ny),
      refreshT: 0, aimX: 0, aimY: 0, left: Infinity, round: false, path: [], boxes: []
    };
    var col = W.colliders;
    var x1 = x0 + nx * cell;
    var y1 = y0 + ny * cell;
    for (var i = 0; i < col.n; i++) {
      var ax = col.ax[i];
      var ay = col.ay[i];
      var bx = col.bx[i];
      var by = col.by[i];
      if ((ax < x0 && bx < x0) || (ax > x1 && bx > x1) || (ay < y0 && by < y0) || (ay > y1 && by > y1)) continue;
      markLine(grid, grid.fixed, ax, ay, bx, by);
    }
    for (var p = 0; p < W.props.length; p++) {
      if (W.props[p].r > 0) markAt(grid, grid.fixed, W.props[p].x, W.props[p].y);
    }
    var surface = TLV.world.surface;
    var WATER = TLV.const.SURF.WATER;
    var coarse = T.footWaterCells;
    for (var cy = 0; cy < ny; cy += coarse) {
      for (var cx = 0; cx < nx; cx += coarse) {
        if (surface.at(W, x0 + (cx + 0.5) * cell, y0 + (cy + 0.5) * cell) !== WATER) continue;
        for (var ky = 0; ky < coarse && cy + ky < ny; ky++) {
          for (var kx = 0; kx < coarse && cx + kx < nx; kx++) grid.fixed[(cy + ky) * nx + cx + kx] = 1;
        }
      }
    }
    return grid;
  }

  /** Marks what stands in the way now: parked cars, and vehicles that have stopped. A moving car is gone before the runner gets there. */
  function markCars(S, grid) {
    var T = TLV.tune.ui;
    var world = TLV.world.parking;
    var f = S.player.foot;
    var keepNear = function (box) {
      if (TLV.math.dist(box.x, box.y, f.x, f.y) > T.footBoxesM) return;
      grid.boxes.push({ x: box.x, y: box.y, h: box.h, length: box.length, width: box.width });
    };
    grid.cars.fill(0);
    grid.boxes.length = 0;
    world.spotsNear(S.world, grid.x0 + grid.nx * grid.cell / 2, grid.y0 + grid.ny * grid.cell / 2, Math.max(grid.nx, grid.ny) * grid.cell * 0.75, spotIds);
    for (var i = 0; i < spotIds.length; i++) {
      var occ = world.state(S, spotIds[i]);
      if (occ !== TLV.const.OCC.PARKED && occ !== TLV.const.OCC.MOTO) continue;
      world.boxOf(S.world, spotIds[i], occ, spotBox);
      markBox(grid, grid.cars, spotBox);
      keepNear(spotBox);
    }
    for (var j = 0; j < S.vehicles.length; j++) {
      var o = S.vehicles[j];
      if (!o.active || Math.abs(o.v) >= T.footStillV) continue;
      markBox(grid, grid.cars, o);
      keepNear(o);
      if (o.door !== 1 && o.door !== 2) continue;
      markBox(grid, grid.cars, TLV.collide._doorBox(o, doorBox));
      keepNear(doorBox);
    }
  }

  /** @returns {boolean} True when a cell takes a runner. */
  function open(grid, i) {
    return !grid.fixed[i] && !grid.cars[i];
  }

  /**
   * Spreads walking metres out from the door, as far as the runner plus a margin: nothing further can be the way.
   * @param {object} S Sim state.
   * @param {object} grid The grid, its dist rewritten.
   */
  function spread(S, grid) {
    var T = TLV.tune.ui;
    var nx = grid.nx;
    var ny = grid.ny;
    var dist = grid.dist;
    var reach = TLV.tune.game.doorReachM;
    dist.fill(Infinity);
    heapIds.length = 0;
    heapKeys.length = 0;
    var span = Math.ceil(reach / grid.cell);
    var dcx = Math.floor((grid.doorX - grid.x0) / grid.cell);
    var dcy = Math.floor((grid.doorY - grid.y0) / grid.cell);
    for (var y = dcy - span; y <= dcy + span; y++) {
      for (var x = dcx - span; x <= dcx + span; x++) {
        if (x < 0 || y < 0 || x >= nx || y >= ny) continue;
        var d = TLV.math.dist(grid.x0 + (x + 0.5) * grid.cell, grid.y0 + (y + 0.5) * grid.cell, grid.doorX, grid.doorY);
        var id = y * nx + x;
        if (d > reach || !open(grid, id)) continue;
        dist[id] = d;
        heapPush(id, d);
      }
    }
    var f = S.player.foot;
    var home = cellOf(grid, f.x, f.y);
    var stopAt = Infinity;
    while (heapIds.length) {
      var key = heapKeys[0];
      var at = heapPop();
      if (key > dist[at]) continue;
      if (key > stopAt) break;
      if (at === home || (stopAt === Infinity && Math.abs(at - home) <= 1)) stopAt = key + T.footBeyondM;
      var cy = Math.floor(at / nx);
      var cx = at - cy * nx;
      for (var ky = -1; ky <= 1; ky++) {
        for (var kx = -1; kx <= 1; kx++) {
          if (!kx && !ky) continue;
          var ax = cx + kx;
          var ay = cy + ky;
          if (ax < 0 || ay < 0 || ax >= nx || ay >= ny) continue;
          var next = ay * nx + ax;
          if (!open(grid, next)) continue;
          // No corner cutting: a diagonal between two solid cells is a gap only on paper.
          if (kx && ky && (!open(grid, cy * nx + ax) || !open(grid, ay * nx + cx))) continue;
          var nd = key + (kx && ky ? Math.SQRT2 : 1) * grid.cell;
          if (nd < dist[next]) {
            dist[next] = nd;
            heapPush(next, nd);
          }
        }
      }
    }
  }

  /** @returns {number} The cell under a point, -1 off the grid. */
  function cellOf(grid, x, y) {
    var cx = Math.floor((x - grid.x0) / grid.cell);
    var cy = Math.floor((y - grid.y0) / grid.cell);
    return cx >= 0 && cy >= 0 && cx < grid.nx && cy < grid.ny ? cy * grid.nx + cx : -1;
  }

  /** @returns {number} The cell to start reading from: the runner's, or if a wall runs through that one, the best one touching it. */
  function startCell(grid, x, y) {
    var home = cellOf(grid, x, y);
    if (home < 0) return -1;
    if (grid.dist[home] < Infinity) return home;
    var cy = Math.floor(home / grid.nx);
    var cx = home - cy * grid.nx;
    var best = -1;
    for (var r = 1; r <= 3 && best < 0; r++) {
      for (var ky = -r; ky <= r; ky++) {
        for (var kx = -r; kx <= r; kx++) {
          var ax = cx + kx;
          var ay = cy + ky;
          if (ax < 0 || ay < 0 || ax >= grid.nx || ay >= grid.ny) continue;
          var id = ay * grid.nx + ax;
          if (grid.dist[id] < Infinity && (best < 0 || grid.dist[id] < grid.dist[best])) best = id;
        }
      }
    }
    return best;
  }

  /** @returns {boolean} True when a standing car lies across the first `upto` metres of a line as wide as the runner. */
  function carBetween(grid, ax, ay, bx, by, upto) {
    var len = TLV.math.dist(ax, ay, bx, by);
    if (len < 1e-6) return false;
    var dx = (bx - ax) / len;
    var dy = (by - ay) / len;
    // Just inside the body: the two rays of a runner brushing along a car must not start in that car.
    var body = TLV.tune.player.footRadius * 0.9;
    var end = Math.min(len, upto);
    for (var i = 0; i < grid.boxes.length; i++) {
      var box = grid.boxes[i];
      if (rayToBox(ax, ay, dx, dy, box) < end || rayToBox(ax - dy * body, ay + dx * body, dx, dy, box) < end || rayToBox(ax + dy * body, ay - dx * body, dx, dy, box) < end) return true;
    }
    return false;
  }

  /** @returns {boolean} True when a wall stands across a line as wide as the runner. A line down the middle grazes corners that stop a body. */
  function wallBetween(W, ax, ay, bx, by) {
    var ray = TLV.world.spatial.rayBlocked;
    var len = TLV.math.dist(ax, ay, bx, by) || 1;
    var body = TLV.tune.player.footRadius;
    var ox = (ay - by) / len * body;
    var oy = (bx - ax) / len * body;
    return ray(W, ax, ay, bx, by) || ray(W, ax + ox, ay + oy, bx + ox, by + oy) || ray(W, ax - ox, ay - oy, bx - ox, by - oy);
  }

  /**
   * Reads the field from where the runner stands: the walk to the door, how far that is, and the furthest point of it in a clear line.
   * @param {object} S Sim state.
   * @param {object} grid The grid.
   */
  function readWay(S, grid) {
    var T = TLV.tune.ui;
    var W = S.world;
    var f = S.player.foot;
    var nx = grid.nx;
    var straight = TLV.math.dist(f.x, f.y, grid.doorX, grid.doorY);
    var dist = grid.dist;
    grid.path.length = 0;
    var at = startCell(grid, f.x, f.y);
    if (at < 0 || dist[at] === Infinity) {
      grid.left = straight;
      grid.round = false;
      return;
    }
    grid.round = wallBetween(W, f.x, f.y, grid.doorX, grid.doorY) || carBetween(grid, f.x, f.y, grid.doorX, grid.doorY, T.footCarsNearM);
    // The field walks in eight directions, so on a clear line it reads a little long.
    grid.left = grid.round ? Math.max(straight, dist[at]) : straight;
    var aimed = false;
    var misses = 0;
    var seen = false;
    for (var steps = 0; steps < T.footPathMaxCells; steps++) {
      var cy = Math.floor(at / nx);
      var cx = at - cy * nx;
      var x = grid.x0 + (cx + 0.5) * grid.cell;
      var y = grid.y0 + (cy + 0.5) * grid.cell;
      grid.path.push(x, y);
      // Reading on past the first miss, because one cell can hide behind a lamp post with the corner in plain view beyond it. With nothing
      // in clear sight, as for a runner pressed into a corner, the aim is simply the next stretch of the way.
      if (!aimed) {
        if (steps >= T.footAimMinCells && !wallBetween(W, f.x, f.y, x, y) && !carBetween(grid, f.x, f.y, x, y, Infinity)) {
          misses = 0;
          seen = true;
          grid.aimX = x;
          grid.aimY = y;
        } else if (steps >= T.footAimMinCells) {
          misses++;
          aimed = misses >= T.footAimMisses;
        }
        if (!seen && steps === T.footAimMinCells) {
          grid.aimX = x;
          grid.aimY = y;
        }
      }
      var best = at;
      for (var ky = -1; ky <= 1; ky++) {
        for (var kx = -1; kx <= 1; kx++) {
          var ax = cx + kx;
          var ay = cy + ky;
          if ((!kx && !ky) || ax < 0 || ay < 0 || ax >= nx || ay >= grid.ny) continue;
          var id = ay * nx + ax;
          if (kx && ky && (!open(grid, cy * nx + ax) || !open(grid, ay * nx + cx))) continue;
          if (dist[id] < dist[best]) best = id;
        }
      }
      if (best === at) break;
      at = best;
    }
    grid.path.push(grid.doorX, grid.doorY);
    if (!aimed && misses === 0 && seen) {
      grid.aimX = grid.doorX;
      grid.aimY = grid.doorY;
    }
  }

  /**
   * Keeps the way up to date in a chase, every frame on the ground the runner has reached, and with the cars on a slower beat.
   * @param {object} S Sim state.
   * @param {number} dt Seconds, 0 while paused.
   * @returns {?object} The grid, or null out of a chase.
   */
  hud.footWay = function (S, dt) {
    var g = S.game;
    var e = g.errand;
    var chase = !!(g.knife && g.knife.stage === 'CHASE' && e && S.player.mode === 'FOOT' && S.player.foot);
    if (!chase) {
      foot = null;
      return null;
    }
    if (!foot || foot.doorX !== e.doorX || foot.doorY !== e.doorY) foot = buildFoot(S);
    foot.refreshT -= dt;
    if (foot.refreshT <= 0) {
      foot.refreshT = TLV.tune.ui.footRefreshS;
      markCars(S, foot);
      spread(S, foot);
    }
    readWay(S, foot);
    return foot;
  };

  /** @returns {number} Metres left to the door, by the way a person can go when that is known. */
  function doorLeft(S) {
    if (foot && Number.isFinite(foot.left)) return foot.left;
    return TLV.math.dist(S.player.fx, S.player.fy, S.game.errand.doorX, S.game.errand.doorY);
  }

  /** @returns {boolean} True when the door cannot be reached in a straight line, for the chase line. */
  hud.footRound = function () {
    return !!foot && foot.round;
  };

  /**
   * The way to go, for both arrows, so a screen in a chase gives one instruction. Null with the door in a clear line or no walk known,
   * and the arrow then keeps the sim's bearing, which is the same thing in the first case and all there is in the second. A read of what
   * this frame's HUD already worked out: it writes nothing, and the sim never sees it.
   * @param {object} S Sim state.
   * @returns {?number} World heading from the runner to the next corner, radians.
   */
  hud.footHeading = function (S) {
    var f = S.player.foot;
    return foot && foot.round && f ? Math.atan2(foot.aimY - f.y, foot.aimX - f.x) : null;
  };

  /** @returns {?number[]} The walk to the door, x then y, for the minimap. */
  hud.footPath = function () {
    return foot && foot.path.length >= 4 ? foot.path : null;
  };

  /**
   * Shows the runner's next corner. On screen it stands on that spot, and off screen on the rim of the frame, on the side to turn to. The
   * arrow in it always points the way to go, as the view sees it.
   */
  function frameFootWay(S, dt) {
    var T = TLV.tune.ui;
    var grid = hud.footWay(S, dt);
    var on = !!grid && grid.round;
    u().show(dom.way, on);
    if (!on) return;
    var f = S.player.foot;
    var w = window.innerWidth;
    var h = window.innerHeight;
    var rel = TLV.math.wrapPi(Math.atan2(grid.aimY - f.y, grid.aimX - f.x) - TLV.ui.viewYaw(S));
    var x = w * (0.5 - Math.sin(rel) * T.footRimX);
    var y = h * (T.footRimCy - Math.cos(rel) * T.footRimY);
    var at = TLV.ui.project(grid.aimX, grid.aimY, T.footTagZ);
    if (at && at.visible && Math.cos(rel) > 0) {
      x = TLV.math.clamp(at.sx, w * (0.5 - T.footRimX), w * (0.5 + T.footRimX));
      y = TLV.math.clamp(at.sy, h * T.footTagTop, h * T.footTagBottom);
    }
    dom.way.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px) translate(-50%,-50%)';
    dom.wayDir.style.transform = 'rotate(' + (-rel).toFixed(3) + 'rad)';
    dom.way.dataset.rel = rel.toFixed(3);
  }

  /**
   * The sim ignores Q out of reach of the door, with no sign of it, so a press there gets an answer here, as C does. A stopped car with Q
   * down is in HOLD by the end of the tick if the door is in reach, so one still driving was refused for that, and for nothing else.
   */
  function frameQNote(S) {
    var g = S.game;
    var driving = (g.phase === 'DRIVE' || g.phase === 'SEARCH') && S.player.mode === 'DRIVE';
    var refused = driving && !!S.controls.hazard && Math.abs(S.vehicles[0].v) < TLV.tune.game.qStopV;
    if (refused && !view.qRefused) toast(t('toast.qFar'));
    view.qRefused = refused;
  }

  function frameChevrons(S, dt) {
    var T = TLV.tune.ui;
    var w = window.innerWidth;
    var h = window.innerHeight;
    var yaw = TLV.ui.viewYaw(S);
    var clearX = emPx() * T.chevronArrowClearEm;
    for (var i = view.chevrons.length - 1; i >= 0; i--) {
      var mark = view.chevrons[i];
      mark.t -= dt;
      if (mark.t <= 0) {
        mark.node.remove();
        view.chevrons.splice(i, 1);
        continue;
      }
      var a = Math.atan2(mark.y - S.player.fy, mark.x - S.player.fx);
      var rel = TLV.math.wrapPi(a - yaw);
      var x = w * (0.5 - Math.sin(rel) * T.chevronRx);
      var y = h * (T.chevronCy - Math.cos(rel) * T.chevronRy);
      // Dead ahead is where the arrow stands, so the chevron steps to the side the danger leans to.
      if (Math.cos(rel) > 0 && Math.abs(x - w / 2) < clearX) x = w / 2 + (x <= w / 2 ? -clearX : clearX);
      mark.node.style.transform = 'translate(' + x.toFixed(1) + 'px,' + y.toFixed(1) + 'px)';
      mark.node.firstChild.style.transform = 'translate(-50%,-50%) rotate(' + (-rel).toFixed(3) + 'rad)';
      mark.node.dataset.rel = rel.toFixed(3);
    }
  }

  function frameFx(dt) {
    var T = TLV.tune.ui;
    view.vignette = Math.max(0, view.vignette - dt);
    view.flash = Math.max(0, view.flash - dt);
    dom.vignette.style.opacity = (view.vignette / T.vignetteS).toFixed(3);
    dom.flash.style.opacity = (view.flash / T.whiteFlashS).toFixed(3);
  }

  /**
   * C was pressed. Input does the rest, and a frame later the view shows whether it took.
   */
  hud.cameraPressed = function () {
    if (!dom) return;
    view.cameraFrom = TLV.ui.parkingView();
    view.cameraFrames = TLV.tune.ui.cameraCheckFrames;
  };

  /**
   * The camera refuses C away from the bay with no sign of it, so a press that changed nothing gets an answer here. It drops a refused
   * press before the rig moves, so the view never changes at all. This looks a few drawn frames later only because an accepted press
   * reaches the rig on the camera's own next frame.
   */
  function frameCameraNote(g, parking) {
    if (view.cameraFrom === null || --view.cameraFrames > 0) return;
    if (view.cameraFrom === parking && (g.phase === 'DRIVE' || g.phase === 'SEARCH')) toast(t('toast.cameraFar'));
    view.cameraFrom = null;
  }

  /**
   * Draws one frame.
   * @param {object} S Sim state.
   * @param {number} alpha Interpolation factor.
   * @param {number} dt Seconds, 0 while paused.
   * @param {boolean} visible False hides the HUD, for ?hud=0.
   */
  hud.frame = function (S, alpha, dt, visible) {
    var g = S.game;
    var shown = visible && !!g && g.phase !== 'TITLE' && g.phase !== 'RUN_END';
    u().show(dom.box, shown);
    frameFx(dt);
    if (!shown) return;
    var parking = TLV.ui.parkingView();
    frameClock(g, parking);
    frameMoney(g, dt);
    frameHp(g, dt);
    frameSpeed(S);
    frameStreet(S);
    frameFootWay(S, dt);
    frameArrow(S);
    frameChip(S, parking);
    framePrompt(S, dt);
    framePops(dt);
    dom.pops.classList.toggle('under-card', g.phase === 'RESOLVE');
    frameTags(S, parking);
    frameChevrons(S, dt);
    frameCameraNote(g, parking);
    frameQNote(S);
  };

  /** @returns {boolean} True while the HUD is on screen. */
  hud.isLive = function () {
    return !!dom && !dom.box.classList.contains('off');
  };

  /** Test hook: what the HUD thinks it has said. */
  hud._view = function () {
    return view;
  };
})(window.TLV);
