// js/ui/menus.js — WP-UI
// Title, pause and the licence-style end screens. The title owns the difficulty choice, because it must land before the run starts.
//
// Input reads any key as `start` on the title, so a key that only moves the difficulty cursor must never reach it. The listener here
// runs in the capture phase on window, ahead of input.js, and stops those keys. Everything else passes through and starts the day.
(function (TLV) {
  'use strict';

  var menus = TLV.ns('ui.menus');

  var dom = null;
  var sim = null;
  var difficulty = 'relaxed';
  var ended = null;
  var syntheticHeld = 0;
  var syntheticPhase = null;
  var keyHandler = null;
  var startedOnce = false;
  var creditsOpen = false;
  /** A real key has gone down on this page, so there is a keyboard, whatever the pointer says. */
  var keySeen = false;

  var DIFFICULTIES = ['relaxed', 'normal'];

  /** Keys that do something on the title without starting the day. */
  var QUIET_KEYS = {
    ShiftLeft: true, ShiftRight: true, ControlLeft: true, ControlRight: true, AltLeft: true, AltRight: true,
    MetaLeft: true, MetaRight: true, Tab: true, CapsLock: true, ContextMenu: true, NumLock: true,
    F1: true, F2: true, F3: true, F4: true, F5: true, F6: true, F7: true, F8: true, F9: true, F10: true, F11: true, F12: true
  };

  function u() {
    return TLV.ui;
  }

  function t(key, vars) {
    return TLV.ui.strings.t(key, vars);
  }

  /**
   * The choice the card opens on: a difficulty named in the address, then the remembered one. 'relaxed' on a first visit, because nobody
   * has beaten the default clock. The address only opens the card there: it is not remembered, and the player can still change it.
   * @param {object} S Sim state.
   * @returns {string} A name from DIFFICULTIES.
   */
  function loadDifficulty(S) {
    if (/[?&]difficulty=/.test(window.location.search) && DIFFICULTIES.indexOf(S.params.difficulty) >= 0) return S.params.difficulty;
    var saved = u().load(TLV.tune.ui.keyDifficulty);
    return DIFFICULTIES.indexOf(saved) >= 0 ? saved : 'relaxed';
  }

  /** @returns {boolean} True when a person is at this screen. notitle and bots keep the sim's own default, so replays hold. */
  function humanRun(S) {
    return !S.params.notitle && !S.params.autoplay;
  }

  /** Tells the sim. It lands before the run starts, and the page works if the sim side is not there yet. */
  function applyDifficulty() {
    if (!sim || !humanRun(sim)) return;
    var game = TLV.game;
    if (!game || typeof game.setDifficulty !== 'function') return;
    try {
      game.setDifficulty(difficulty);
    } catch (e) {
      console.warn('TLV.game.setDifficulty: ' + (e && e.message));
    }
  }

  /** @returns {string} The current choice. */
  menus.difficulty = function () {
    return difficulty;
  };

  /**
   * Chooses a difficulty.
   * @param {string} name 'relaxed' or 'normal'.
   */
  menus.setDifficulty = function (name) {
    if (DIFFICULTIES.indexOf(name) < 0) return;
    difficulty = name;
    u().save(TLV.tune.ui.keyDifficulty, name);
    applyDifficulty();
    paintDifficulty();
  };

  function step(delta) {
    var at = DIFFICULTIES.indexOf(difficulty);
    var next = (at + delta + DIFFICULTIES.length) % DIFFICULTIES.length;
    menus.setDifficulty(DIFFICULTIES[next]);
    TLV.audio.ui('tick');
  }

  function paintDifficulty() {
    if (!dom) return;
    dom.diffOptions.forEach(function (opt) {
      var on = opt.name === difficulty;
      opt.node.classList.toggle('on', on);
      opt.node.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (dom.endDiff) u().setText(dom.endDiff, t('diff.' + difficulty + '.name'));
  }

  /** A click starts the day the same way a key does, through input.js, so input stays the only path into the sim. */
  function pressEnter() {
    TLV.audio.unlock();
    syntheticHeld = 1;
    syntheticPhase = sim && sim.game ? sim.game.phase : null;
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'Enter', key: 'Enter', bubbles: true }));
  }

  function releaseEnter() {
    syntheticHeld = 0;
    window.dispatchEvent(new KeyboardEvent('keyup', { code: 'Enter', key: 'Enter', bubbles: true }));
  }

  /** The cards read in language order, so left and right swap in Hebrew. */
  function sideways(code) {
    var forward = code === 'ArrowRight';
    step(forward === (TLV.ui.strings.lang() !== 'he') ? 1 : -1);
  }

  /** Stops a key here. The title and the pause keys would otherwise read it through input.js. */
  function swallow(e) {
    TLV.audio.unlock();
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  /** The credits view sits over the title or the pause screen, and takes every key while it is up. */
  function creditsKey(e) {
    if (e.code === 'Escape' || e.code === 'KeyI' || e.code === 'Enter') setCredits(false);
    else if (e.code === 'ArrowDown' || e.code === 'ArrowUp') dom.creditsBody.scrollTop += (e.code === 'ArrowDown' ? 1 : -1) * dom.creditsBody.clientHeight / 2;
    swallow(e);
  }

  function setCredits(open) {
    creditsOpen = open;
    if (open) paintCredits();
    TLV.audio.ui('click');
  }

  /**
   * @returns {boolean} True on a device with nothing to drive with: a touch screen, no mouse or trackpad, no key pressed so far and no
   * gamepad. A phone with a keyboard or pad paired loses the line as soon as either speaks.
   */
  function touchOnly() {
    if (keySeen || !window.matchMedia || window.matchMedia('(any-pointer: fine)').matches) return false;
    var touch = window.matchMedia('(any-pointer: coarse)').matches || window.navigator.maxTouchPoints > 0;
    return touch && !u().padConnected();
  }

  function keyDown(e) {
    if (e.isTrusted) keySeen = true;
    if (!sim || !sim.game) return;
    var phase = sim.game.phase;
    if (creditsOpen) {
      creditsKey(e);
      return;
    }
    if (e.code === 'KeyI' && !e.repeat && (phase === 'TITLE' || u().isUserPaused())) {
      setCredits(true);
      swallow(e);
      return;
    }
    if (e.code === 'KeyC' && !e.repeat) u().hud.cameraPressed();
    if (phase === 'RUN_END') {
      if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') sideways(e.code);
      else if (e.code === 'Digit1' || e.code === 'Digit2') menus.setDifficulty(e.code === 'Digit1' ? 'relaxed' : 'normal');
      return;
    }
    if (phase !== 'TITLE') return;
    var consumed = true;
    switch (e.code) {
      case 'ArrowLeft':
      case 'ArrowRight':
        sideways(e.code);
        break;
      case 'ArrowUp':
        step(-1);
        break;
      case 'ArrowDown':
        step(1);
        break;
      case 'Digit1':
        menus.setDifficulty('relaxed');
        TLV.audio.ui('tick');
        break;
      case 'Digit2':
        menus.setDifficulty('normal');
        TLV.audio.ui('tick');
        break;
      case 'KeyL':
        if (!e.repeat) toggleLang();
        break;
      case 'KeyM':
        if (!e.repeat) u().toggleMute();
        break;
      default:
        consumed = !!QUIET_KEYS[e.code];
        break;
    }
    if (consumed) swallow(e);
  }

  function toggleLang() {
    var next = TLV.ui.strings.lang() === 'he' ? 'en' : 'he';
    u().save(TLV.tune.ui.keyLang, next);
    u().setLang(next);
    TLV.audio.ui('tick');
  }

  /** The one-line controls reference. */
  function controlsLine(parent) {
    var line = u().el('div', 'controls-line', parent);
    TLV.ui.strings.controls.forEach(function (row) {
      var cell = u().el('span', 'controls-cell', line);
      row.keys.forEach(function (key) {
        var cap = u().el('kbd', 'key', cell, key);
        cap.dir = 'ltr';
      });
      u().el('span', 'controls-label', cell).dataset.t = row.label;
    });
    return line;
  }

  function button(parent, cls, onClick) {
    var node = u().el('button', cls, parent);
    node.type = 'button';
    node.tabIndex = -1;
    node.addEventListener('mousedown', function (e) { e.preventDefault(); });
    node.addEventListener('click', function (e) {
      e.stopPropagation();
      onClick();
    });
    return node;
  }

  function buildTitle(root) {
    var el = u().el;
    var scr = dom.title = el('div', 'scr scr-title off', root);
    el('div', 'title-sun', scr);
    var head = el('div', 'title-head', scr);
    dom.titleName = el('div', 'title-name', head);
    dom.titleSub = el('div', 'title-sub', head);
    dom.titleTag = el('div', 'title-tag', head);
    dom.titleGan = el('div', 'title-gan', head);

    var pick = el('div', 'title-pick', scr);
    dom.pickHead = el('div', 'title-pick-head', pick);
    var row = el('div', 'diff-row', pick);
    dom.diffOptions = DIFFICULTIES.map(function (name) {
      var node = button(row, 'diff', function () {
        menus.setDifficulty(name);
        TLV.audio.unlock();
        TLV.audio.ui('tick');
      });
      node.dataset.diff = name;
      var title = el('div', 'diff-name', node);
      var line = el('div', 'diff-line', node);
      return { name: name, node: node, title: title, line: line };
    });
    dom.pickKeys = el('div', 'title-pick-keys', pick);

    dom.titleTouch = el('div', 'title-touch off', scr);
    dom.titleStart = button(scr, 'title-start', pressEnter);
    dom.titleControls = controlsLine(scr);

    var foot = el('div', 'title-foot', scr);
    dom.titleOsm = el('span', 'osm', foot);
    dom.titleOsm.dir = 'ltr';
    dom.titleBest = el('span', 'title-best', foot);
    dom.titleCredits = button(foot, 'lang-btn', function () { setCredits(true); });
    dom.langBtn = button(foot, 'lang-btn', toggleLang);
  }

  function buildPause(root) {
    var el = u().el;
    var scr = dom.pause = el('div', 'scr scr-pause off', root);
    var panel = el('div', 'pause-panel', scr);
    dom.pauseTitle = el('div', 'pause-title', panel);
    dom.pauseLine = el('div', 'pause-line', panel);
    dom.pauseResume = button(panel, 'pause-resume', function () { u().togglePause(); });
    dom.pauseMute = button(panel, 'pause-mute', function () { u().toggleMute(); });
    dom.pauseCredits = button(panel, 'pause-credits', function () { setCredits(true); });
    dom.pauseControls = controlsLine(panel);
    dom.pauseOsm = el('div', 'osm', panel);
    dom.pauseOsm.dir = 'ltr';
  }

  /** The credits view, built empty. paintCredits fills it when it opens, in the language of that moment. */
  function buildCredits(root) {
    var el = u().el;
    var scr = dom.credits = el('div', 'scr scr-credits off', root);
    var panel = el('div', 'credits-panel', scr);
    dom.creditsTitle = el('div', 'credits-title', panel);
    dom.creditsBody = el('div', 'credits-body', panel);
    dom.creditsBack = button(panel, 'credits-back', function () { setCredits(false); });
  }

  /** The screen for a lost WebGL context. It sits over everything, because the run underneath has no picture to show. */
  function buildLost(root) {
    var el = u().el;
    var scr = dom.lost = el('div', 'scr scr-lost off', root);
    var panel = el('div', 'lost-panel', scr);
    dom.lostTitle = el('div', 'lost-title', panel);
    dom.lostLine = el('div', 'lost-line', panel);
    dom.lostReload = button(panel, 'lost-reload', function () { window.location.reload(); });
  }

  /** @returns {string} One packed asset's credit, in plain words. */
  function creditLine(id, credit) {
    var names = TLV.ui.strings.CREDITS.licences;
    if (!credit || !credit.author) return id + ': ' + t('credits.unknown');
    var licence = credit.license === 'own' ? t('credits.own') : (names[credit.license] || String(credit.license));
    return id + ': ' + [credit.author, licence, credit.date].filter(function (x) { return !!x; }).join(', ');
  }

  /** A heading and its lines. Text only: an author's name in a sidecar is data. */
  function creditsBlock(title, lines) {
    var el = u().el;
    el('div', 'credits-head', dom.creditsBody, title);
    lines.forEach(function (line) {
      var row = el('div', 'credits-line', dom.creditsBody, line.text);
      if (line.ltr) row.dir = 'ltr';
    });
  }

  /** Fills the view from what is on the page: every packed asset is in TLV.assetIndex, loaded or not. */
  function paintCredits() {
    if (!dom) return;
    var C = TLV.ui.strings.CREDITS;
    var index = TLV.assetIndex || {};
    var ids = Object.keys(index).sort();
    dom.creditsBody.textContent = '';
    creditsBlock(t('credits.map'), [
      { text: TLV.ui.strings.OSM, ltr: true },
      { text: t('credits.mapLine') + ' \u2066' + C.odbl + '\u2069' },
      { text: C.osmUrl, ltr: true }
    ]);
    creditsBlock(t('credits.engine'), [{ text: C.three, ltr: true }, { text: C.threeLine, ltr: true }]);
    creditsBlock(t('credits.art'), ids.length ? ids.map(function (id) {
      return { text: creditLine(id, index[id].credit) };
    }) : [{ text: t('credits.noArt') }]);
    var sounds = TLV.soundIndex && Array.isArray(TLV.soundIndex.credits) ? TLV.soundIndex.credits : [];
    var soundLines = [];
    sounds.forEach(function (c) {
      soundLines.push({ text: creditLine(String(c.title), c), ltr: true });
      if (typeof c.changes === 'string' && c.changes) soundLines.push({ text: c.changes, ltr: true });
      if (typeof c.source === 'string') soundLines.push({ text: c.source.replace(/^https:\/\//, ''), ltr: true });
    });
    if (!soundLines.length) soundLines.push({ text: t('credits.noSound') });
    soundLines.push({ text: t('credits.radio') });
    creditsBlock(t('credits.sound'), soundLines);
  }

  function buildEnd(root) {
    var el = u().el;
    var scr = dom.end = el('div', 'scr scr-end off', root);
    var card = dom.endCard = el('div', 'licence', scr);
    var top = el('div', 'licence-top', card);
    dom.endLicence = el('span', 'licence-word', top);
    dom.endClass = el('span', 'licence-class', top);
    var body = el('div', 'licence-body', card);
    var photo = el('div', 'licence-photo', body);
    photo.innerHTML = '<svg viewBox="0 0 120 80" aria-hidden="true"><path d="M8 58 L8 44 Q10 38 22 36 L36 20 Q40 16 48 16 L82 16 Q90 16 95 22 L104 36 Q112 38 112 46 L112 58 Z" fill="#fff" stroke="#15121c" stroke-width="4"/><path d="M42 22 L60 22 L60 36 L30 36 Z M66 22 L84 22 Q88 22 90 26 L96 36 L66 36 Z" fill="#7fd0e6" stroke="#15121c" stroke-width="3"/><circle cx="32" cy="60" r="11" fill="#15121c"/><circle cx="32" cy="60" r="4" fill="#ddd"/><circle cx="88" cy="60" r="11" fill="#15121c"/><circle cx="88" cy="60" r="4" fill="#ddd"/></svg>';
    var info = el('div', 'licence-info', body);
    dom.endTitle = el('div', 'licence-title', info);
    dom.endLine = el('div', 'licence-line', info);
    var rankRow = dom.endRankRow = el('div', 'licence-rank', info);
    dom.endRankLabel = el('span', 'licence-rank-label', rankRow);
    dom.endRank = el('span', 'licence-rank-value', rankRow);
    var totalRow = dom.endTotalRow = el('div', 'licence-rank', info);
    dom.endTotalLabel = el('span', 'licence-rank-label', totalRow);
    dom.endTotal = el('span', 'licence-total', totalRow);
    dom.endTotal.dir = 'ltr';
    dom.endBest = el('div', 'licence-best', info);
    dom.endTally = el('div', 'licence-tally', card);
    dom.endStamp = el('div', 'licence-stamp', card);
    dom.endRestart = button(scr, 'end-restart', pressEnter);
    var nextRow = el('div', 'end-next', scr);
    dom.endNextLabel = el('span', 'end-next-label', nextRow);
    dom.endDiff = button(nextRow, 'end-next-value', function () { step(1); });
  }

  /** Builds all screens, hidden. */
  menus.build = function (root, S) {
    sim = S;
    dom = {};
    ended = null;
    difficulty = loadDifficulty(S);
    buildTitle(root);
    buildPause(root);
    buildCredits(root);
    buildEnd(root);
    buildLost(root);
    creditsOpen = false;
    menus.relabel();
    paintDifficulty();
    if (keyHandler) window.removeEventListener('keydown', keyHandler, true);
    keyHandler = keyDown;
    window.addEventListener('keydown', keyHandler, true);
    if (S.game && S.game.phase === 'TITLE') applyDifficulty();
  };

  function relabelControls(line) {
    var labels = line.querySelectorAll('[data-t]');
    for (var i = 0; i < labels.length; i++) u().setText(labels[i], t(labels[i].dataset.t));
  }

  function bestMoney() {
    var v = Number(u().load(TLV.tune.ui.keyBest));
    return Number.isFinite(v) ? v : 0;
  }

  /** Rewrites every label, after a language switch. */
  menus.relabel = function () {
    if (!dom) return;
    u().setText(dom.titleName, t('title.name'));
    u().setText(dom.titleSub, t('title.sub'));
    u().setText(dom.titleTag, t('title.tag'));
    u().setText(dom.titleGan, t('title.gan'));
    u().setText(dom.pickHead, t('title.pick'));
    u().setRich(dom.pickKeys, t('title.pickKeys'));
    u().setText(dom.titleStart, t('title.start'));
    u().setText(dom.titleTouch, t('title.touch'));
    u().setText(dom.titleOsm, TLV.ui.strings.OSM);
    u().setRich(dom.langBtn, t('title.langKey') + ' ' + t('title.langName'));
    dom.diffOptions.forEach(function (opt) {
      u().setText(opt.title, t('diff.' + opt.name + '.name'));
      u().setText(opt.line, t('diff.' + opt.name + '.line'));
    });
    var best = bestMoney();
    u().setText(dom.titleBest, best > 0 ? t('title.best', { money: TLV.ui.strings.money(best) }) : '');
    relabelControls(dom.titleControls);
    relabelControls(dom.pauseControls);

    u().setText(dom.pauseTitle, t('pause.title'));
    u().setText(dom.pauseLine, t('pause.line'));
    dom.pauseResume._text = null;
    u().setRich(dom.pauseMute, t(TLV.audio.isMuted() ? 'pause.soundOff' : 'pause.soundOn'));
    u().setText(dom.pauseOsm, TLV.ui.strings.OSM);
    u().setRich(dom.titleCredits, t('title.credits'));
    u().setRich(dom.pauseCredits, t('pause.credits'));
    u().setText(dom.creditsTitle, t('credits.title'));
    u().setRich(dom.creditsBack, t('credits.back'));
    u().setText(dom.lostTitle, t('lost.title'));
    u().setText(dom.lostReload, t('lost.button'));
    dom.lostLine._text = null;
    paintCredits();

    u().setText(dom.endLicence, t('end.licence'));
    u().setText(dom.endClass, t('end.licenceClass'));
    u().setText(dom.endRankLabel, t('end.rank'));
    u().setText(dom.endTotalLabel, t('end.total'));
    paintDifficulty();
    dom.lastEnd = null;
  };

  /**
   * Reacts to one event.
   * @param {object} S Sim state.
   * @param {string} name Event name.
   * @param {object} p Payload.
   */
  menus.onEvent = function (S, name, p) {
    if (name === 'run.start') {
      ended = null;
      startedOnce = true;
      return;
    }
    if (name !== 'run.end') return;
    var marked = markedRun(p.reason, S.game);
    var isBest = !marked && p.money > bestMoney();
    if (isBest) u().save(TLV.tune.ui.keyBest, Math.round(p.money));
    ended = { reason: p.reason, money: p.money, rank: p.rank, stats: p.stats, isBest: isBest && p.money > 0, marked: marked };
    if (dom) dom.lastEnd = null;
  };

  /**
   * BRIEF: no score, achievement or benefit for running anyone over. So a day with a person under the car is no best day and has no
   * rank, whatever it earned first.
   * @param {string} reason The run's ending.
   * @param {object} g S.game.
   * @returns {boolean} True for a licence revoked, or any other ending with a hit on the record.
   */
  function markedRun(reason, g) {
    return reason === 'REVOKED' || g.pedHits > 0;
  }

  /** What the end screen shows: the real ending, or a forced one made from the sim as it stands. */
  function endInfo(S) {
    var forced = u().forcedWith('end.');
    if (forced) {
      var g = S.game;
      var reason = forced.slice('end.'.length);
      var money = g.money || 1240;
      return { reason: reason, money: money, rank: TLV.game.score.rank(money), stats: g.stats, isBest: false, marked: markedRun(reason, g) };
    }
    if (S.game.phase === 'RUN_END' && !ended) {
      var gg = S.game;
      return { reason: gg.endReason, money: gg.money, rank: gg.rank, stats: gg.stats, isBest: false, marked: markedRun(gg.endReason, gg) };
    }
    return S.game.phase === 'RUN_END' ? ended : null;
  }

  function paintEnd(info) {
    var key = JSON.stringify([info.reason, info.money, info.rank, info.marked, TLV.ui.strings.lang()]);
    if (dom.lastEnd === key) return;
    dom.lastEnd = key;
    var straight = info.reason === 'REVOKED';
    dom.endCard.classList.toggle('straight', straight);
    dom.end.classList.toggle('win', info.reason === 'WIN');
    u().setText(dom.endTitle, t('end.' + info.reason + '.title'));
    var line = t('end.' + info.reason + '.line');
    u().setText(dom.endLine, line);
    u().show(dom.endLine, !!line);
    u().setText(dom.endRank, t('rank.' + info.rank));
    u().setText(dom.endTotal, TLV.ui.strings.money(info.money));
    dom.endTotal.classList.toggle('loss', Math.round(info.money) < 0);
    // A marked run gets no rank, and its total, where it shows, is a plain sum. Revoked shows no sum at all: the card is played straight.
    u().show(dom.endRankRow, !info.marked);
    u().show(dom.endTotalRow, !straight);
    dom.endTotal.classList.toggle('plain', !!info.marked);
    var best = info.marked ? bestMoney() : Math.max(bestMoney(), info.money);
    u().show(dom.endBest, !straight && (!info.marked || best > 0));
    u().setText(dom.endBest, info.isBest ? t('end.newBest') : t('end.best', { money: TLV.ui.strings.money(best) }));
    u().setText(dom.endStamp, t('end.' + info.reason + '.stamp'));
    dom.endStamp.classList.toggle('good', info.reason === 'WIN');
    u().setRich(dom.endRestart, t(straight ? 'end.restartRevoked' : 'end.restart'));
    u().show(dom.endClass, !straight);
    u().setText(dom.endNextLabel, t(straight ? 'end.difficultyPlain' : 'end.difficulty'));
    dom.endTally.textContent = '';
    ['honksReceived', 'spotsStolen', 'nearMisses', 'contacts', 'errandsDone'].forEach(function (field) {
      var cell = u().el('div', 'tally', dom.endTally);
      var value = u().el('span', 'tally-value', cell, String(info.stats ? info.stats[field] || 0 : 0));
      value.dir = 'ltr';
      u().el('span', 'tally-label', cell, t('tally.' + field));
    });
  }

  /**
   * Draws one frame.
   * @param {object} S Sim state.
   */
  menus.frame = function (S) {
    sim = S;
    var g = S.game;
    if (!g || !dom) return;
    if (syntheticHeld && g.phase !== syntheticPhase) releaseEnter();
    else if (syntheticHeld && ++syntheticHeld > 240) releaseEnter();

    u().show(dom.title, (g.phase === 'TITLE' && !S.params.notitle) || u().isForced('title'));
    var paused = u().isUserPaused() || u().isForced('pause');
    if (creditsOpen && g.phase !== 'TITLE' && !paused) creditsOpen = false;
    u().show(dom.credits, creditsOpen || u().isForced('credits'));
    u().show(dom.pause, paused);
    if (paused) {
      u().setRich(dom.pauseMute, t(TLV.audio.isMuted() ? 'pause.soundOff' : 'pause.soundOn'));
      u().setRich(dom.pauseResume, t(u().padConnected() ? 'pause.resumePad' : 'pause.resume'));
    }
    var touch = dom.title._shown === true && touchOnly();
    u().show(dom.titleTouch, touch);
    dom.title.classList.toggle('touch-only', touch);
    var lost = u().contextLost();
    u().show(dom.lost, !!lost);
    if (lost) {
      u().setText(dom.lostLine, t(lost.stale ? 'lost.reload' : 'lost.wait'));
      u().show(dom.lostReload, lost.stale);
    }
    var info = endInfo(S);
    u().show(dom.end, !!info);
    if (info) paintEnd(info);
  };

  /** @returns {boolean} True once a run has started on this page. */
  menus.started = function () {
    return startedOnce;
  };
})(window.TLV);
