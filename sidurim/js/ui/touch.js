// js/ui/touch.js — WP-UI
// The on-screen stick and buttons for a touch screen (GAME_DESIGN 5), and what a phone needs around them: the choice between touch
// and keys, a card that asks for the phone sideways, and the guards that stop a browser scrolling, zooming or selecting under a thumb.
//
// The fingers are this file's. What they mean reaches the sim through TLV.input.touch only, which input.sample merges into
// ControlState, so a touch drive records and replays like any other. Reading S is allowed; nothing here writes it.
//
// Layout: the stick zone is the lower left of the screen, the buttons the lower right, in both languages. A thumb does not change
// sides in Hebrew, so the layer is always left to right. The stick's origin drops wherever the thumb lands in its zone.
(function (TLV) {
  'use strict';

  var touch = TLV.ns('ui.touch');

  /** Geometry of the overlay, in CSS pixels, read from the CSS custom properties css/ui.css sets. Only what JS must know is here. */
  var G = {
    /** A stick finger further out than this many radii drags the origin after it: on foot at once, in the car only well past full lock. */
    leashFoot: 1.0,
    leashCar: 1.6,
    /** A press this near a screen edge is the system's back gesture, not ours. Added to the safe area. */
    edgeBand: 12,
    edgeMin: 16,
    /** Q and R let go when the finger slides this far off them (share of the button, at least slopMinPx). */
    slop: 0.25,
    slopMinPx: 12,
    /** After the last touch, keys and the mouse wait this long before they take the screen back. */
    keysAfterMs: 600,
    /** A pad stick past this is a player on the pad, and these first buttons (A to Start) are the ones input.sample reads. */
    padAxis: 0.3,
    padButtons: 10,
    /** Narrower than this and taller than wide is a phone held upright. A tablet plays upright. */
    portraitMaxW: 700,
    /** R stays up this long after the tow stops being offered, so it does not vanish under a thumb on its way. */
    towLingerS: 3,
    /** The stick flashes 'let go' in HOLD over this throttle: parking cancels at 0.5. */
    letGoThrottle: 0.3
  };
  touch.G = G;

  /** Buttons that hold a ControlState field, by the name TLV.input.touch knows them by. */
  var HOLDS = { space: 'space', horn: 'horn', hazard: 'hazard', recover: 'recover', out: 'interact' };

  /** The keycap each button carries, so 'HOLD [Q]' in a prompt points at the button with a Q on it. */
  var CAPS = { space: 'SPACE', horn: 'H', hazard: 'Q', recover: 'R', out: 'E' };

  /** Small inline icons. currentColor, so the CSS colours them. */
  var ICONS = {
    space: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11" stroke="currentColor" stroke-width="3" stroke-linecap="round" fill="none"/><circle cx="12" cy="18" r="3" fill="currentColor"/></svg>',
    dodge: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12h12M12 6l6 6-6 6" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    horn: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4h4l6 4V6L7 10H3z" fill="currentColor"/><path d="M16 9c1.5 1.5 1.5 4.5 0 6M19 6c3 3 3 9 0 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>',
    hazard: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l10 18H2z" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linejoin="round"/><path d="M12 10v5" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"/><circle cx="12" cy="18" r="1.4" fill="currentColor"/></svg>',
    recover: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 15h9l3-5h5v5" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/><circle cx="7" cy="17" r="2.2" fill="currentColor"/><circle cx="17" cy="17" r="2.2" fill="currentColor"/><path d="M15 10l-4-6" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg>',
    out: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3h9v18H5z" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linejoin="round"/><path d="M14 12h7M18 8l3 4-3 4" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>',
    pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 5h3.5v14H7zM13.5 5H17v14h-3.5z" fill="currentColor"/></svg>',
    camera: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 4h16v16H4z" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M8 4v16M4 12h4" stroke="currentColor" stroke-width="2.4"/><text x="15" y="15.5" font-size="8" font-weight="900" text-anchor="middle" fill="currentColor" font-family="Arial">P</text></svg>',
    mirror: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="8" width="18" height="8" rx="3" fill="none" stroke="currentColor" stroke-width="2.4"/><path d="M12 16v4" stroke="currentColor" stroke-width="2.4"/></svg>',
    phone: '<svg viewBox="0 0 64 64" aria-hidden="true"><rect x="22" y="6" width="20" height="36" rx="4" fill="none" stroke="currentColor" stroke-width="4"/><path d="M14 50c6 6 30 6 38-6" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M48 38l4 6 6-4" fill="none" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg>'
  };

  var root = null;
  var sim = null;
  var dom = null;
  /** 'touch' or 'keys'. pinned: ?touch=on or off decides, and nothing switches it. */
  var mode = 'keys';
  var pinned = false;
  /** pointerId -> { ctl, rect } for every finger on the overlay. */
  var fingers = {};
  /** The stick: its owning pointer, its origin and radius in client pixels, and where the finger is. */
  var stick = { owner: null, cx: 0, cy: 0, r: 60, fx: 0, fy: 0, leash: G.leashCar, zone: null };
  /** Fingers on each hold button. */
  var pressed = {};
  var lastTouchMs = -1e9;
  var layerOn = false;
  var rotateOn = false;
  var rotatePaused = false;
  var towSeen = -1e9;
  var towHeldT = 0;
  var pinchRun = null;
  var layoutDirty = true;
  var winListeners = [];
  /** A mode asked for by a press still under way. It applies once the press has ended, so the screen never moves under it. */
  var pendingMode = null;

  function u() {
    return TLV.ui;
  }

  function t(key, vars) {
    return TLV.ui.strings.t(key, vars);
  }

  function now() {
    return window.performance && window.performance.now ? window.performance.now() : 0;
  }

  /** The input source, guarded: a page whose input.js failed still draws its UI. */
  function src() {
    return TLV.input && TLV.input.touch ? TLV.input.touch : null;
  }

  /** @returns {boolean} True while the overlay is the way this page is being played. */
  touch.active = function () {
    return mode === 'touch';
  };

  /** @returns {boolean} True while the stick and buttons are on screen. */
  touch.shown = function () {
    return layerOn;
  };

  /** @returns {boolean} True while the 'turn the phone' card covers the screen. */
  touch.rotating = function () {
    return rotateOn;
  };

  /** @returns {boolean} A device whose main pointer is a finger. Emulators report one touch point, so one is enough. */
  function coarseDevice() {
    var mm = window.matchMedia;
    var coarse = !!mm && mm('(pointer: coarse)').matches;
    var nav = window.navigator || {};
    return coarse && ((nav.maxTouchPoints || 0) > 0 || 'ontouchstart' in window);
  }

  /** @returns {boolean} True for a touch inside a pane that scrolls by itself, which no guard may hold still. */
  function inScroller(target) {
    return !!(target && target.closest && target.closest('.board, .credits-body, .ui-error, .lobby-panel'));
  }

  /** Adds a listener this file can take away again, so a second build (importReplay) leaves no stale handler behind. */
  function listen(target, name, fn, opts) {
    if (!target || !target.addEventListener) return;
    target.addEventListener(name, fn, opts);
    winListeners.push([target, name, fn, opts]);
  }

  function unlistenAll() {
    winListeners.forEach(function (row) { row[0].removeEventListener(row[1], row[2], row[3]); });
    winListeners = [];
  }

  // ---- Touch or keys. --------------------------------------------------------------------------------------------------------

  /** Applies a mode everywhere it shows: the strings, the classes, the labels and the rear-view strip. */
  function apply(next, relabel) {
    mode = next;
    var on = next === 'touch';
    releaseAll();
    if (TLV.ui.strings.setTouch) TLV.ui.strings.setTouch(on);
    if (root) root.classList.toggle('touch', on);
    document.documentElement.classList.toggle('touch', on);
    layoutDirty = true;
    if (relabel && TLV.ui.setLang) TLV.ui.setLang(TLV.ui.strings.lang());
  }

  function flip(next) {
    if (pinned || next === mode) return;
    apply(next, true);
  }

  /**
   * Chooses the first mode, before anything is built, so the first labels are already the right ones. ?touch=on or off pins it.
   * @param {Element} rootEl #ui-root.
   * @param {object} S Sim state.
   */
  touch.prepare = function (rootEl, S) {
    root = rootEl;
    sim = S;
    var asked = S.params.touch;
    pinned = asked === 'on' || asked === 'off';
    var first = asked === 'on' || (asked !== 'off' && coarseDevice()) ? 'touch' : 'keys';
    apply(first, false);
  };

  /** @returns {boolean} True when a key press is somebody typing into a field, or a soft keyboard's noise. */
  function notAKey(ev) {
    var target = ev.target;
    if (target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName || ''))) return true;
    if (ev.key === 'Unidentified' || ev.key === 'Process' || ev.keyCode === 229) return true;
    // The keys that only act on the page never mean a keyboard player: a phone's hardware buttons can send some of them.
    return /^(Escape|KeyP|KeyC|KeyV|KeyM|KeyN|KeyB)$/.test(ev.code || '');
  }

  /** @returns {boolean} True when keys may take the screen back: no finger down, and none lately. */
  function keysMayTake() {
    for (var id in fingers) {
      if (Object.prototype.hasOwnProperty.call(fingers, id)) return false;
    }
    return now() - lastTouchMs > G.keysAfterMs;
  }

  /**
   * A press that changes the mode changes the layout, and the screen must not move under the very press that changed it: the click
   * it ends in would land on whatever slid there. So the mode is noted on the way down and applied once the press is over.
   */
  function onAnyPointer(ev) {
    if (ev.pointerType === 'touch' || ev.pointerType === 'pen') {
      lastTouchMs = now();
      if (mode !== 'touch') pendingMode = 'touch';
    } else if (ev.pointerType === 'mouse' && keysMayTake() && mode !== 'keys') {
      pendingMode = 'keys';
    }
  }

  /** The press is over: its click has been dispatched by the time this timer runs. */
  function onAnyPointerEnd() {
    if (!pendingMode) return;
    window.setTimeout(applyPending, 0);
  }

  function applyPending() {
    if (!pendingMode) return;
    var next = pendingMode;
    pendingMode = null;
    flip(next);
  }

  /** Where a browser has no pointer events, a touch still says what the device is. */
  function onAnyTouch() {
    lastTouchMs = now();
    if (!window.PointerEvent && mode !== 'touch') pendingMode = 'touch';
  }

  function onAnyTouchEnd() {
    if (!window.PointerEvent) onAnyPointerEnd();
  }

  /** @returns {boolean} False for a bot or a replay: nobody is holding this phone, and nothing waits for them (main.js app.human). */
  function human() {
    return !(TLV.app && TLV.app.human === false);
  }

  function onAnyKey(ev) {
    if (!ev.isTrusted || notAKey(ev) || !keysMayTake()) return;
    flip('keys');
  }

  /**
   * A pad being played, not merely paired, takes the screen. Only what input.sample reads counts: the first connected pad, its left
   * stick and its standard buttons. A pad whose other axes rest off centre (a hat, or triggers at -1) is not someone playing.
   */
  function padActive() {
    var nav = window.navigator;
    var pads = nav && nav.getGamepads ? nav.getGamepads() : [];
    var pad = null;
    for (var i = 0; i < pads.length && !pad; i++) {
      if (pads[i] && pads[i].connected) pad = pads[i];
    }
    if (!pad) return false;
    for (var b = 0; b < G.padButtons && b < pad.buttons.length; b++) {
      if (pad.buttons[b] && pad.buttons[b].pressed) return true;
    }
    return Math.abs(pad.axes[0] || 0) > G.padAxis || Math.abs(pad.axes[1] || 0) > G.padAxis;
  }

  // ---- Building. ------------------------------------------------------------------------------------------------------------

  function el(tag, cls, parent, text) {
    return u().el(tag, cls, parent, text);
  }

  /** A button of the overlay: an icon, the keycap the prompts name, and a word. */
  function holdButton(name, icon) {
    var node = el('div', 'tb tb-' + name, dom.layer);
    node.dataset.ctl = name;
    var ring = el('div', 'tb-ring', node);
    ring.setAttribute('aria-hidden', 'true');
    var face = el('div', 'tb-face', node);
    var glyph = el('span', 'tb-icon', face);
    glyph.innerHTML = ICONS[icon];
    var cap = el('kbd', 'key tb-cap', face, CAPS[name]);
    cap.dir = 'ltr';
    var word = el('span', 'tb-word', node);
    pressed[name] = {};
    return { node: node, ring: ring, word: word, glyph: glyph, icon: icon, shown: null, dim: null };
  }

  function utilButton(name) {
    var node = el('div', 'tu tu-' + name, dom.row);
    node.dataset.ctl = name;
    node.innerHTML = ICONS[name];
    return { node: node, shown: null };
  }

  /**
   * Builds the overlay and the turn-the-phone card, hidden. Called by ui.init after the cards, so that the board, the lobby and every
   * screen are above it.
   * @param {Element} rootEl #ui-root.
   * @param {object} S Sim state.
   */
  touch.build = function (rootEl, S) {
    root = rootEl;
    sim = S;
    unlistenAll();
    fingers = {};
    pressed = {};
    stick.owner = null;
    layerOn = false;
    rotateOn = false;
    rotatePaused = false;
    pinchRun = null;
    pendingMode = null;
    // A new sim starts its clock again, so a time kept from the last one would mean nothing.
    towSeen = -1e9;
    towHeldT = 0;
    dom = {};
    var layer = dom.layer = el('div', 'touch-layer off', root);
    layer.dir = 'ltr';
    var zone = dom.zone = el('div', 'tz-stick', layer);
    zone.dataset.ctl = 'stick';
    dom.ghost = el('div', 'stick-ghost', zone);
    dom.base = el('div', 'stick-base', zone);
    dom.knob = el('div', 'stick-knob', dom.base);
    dom.btn = {
      space: holdButton('space', 'space'),
      horn: holdButton('horn', 'horn'),
      hazard: holdButton('hazard', 'hazard'),
      recover: holdButton('recover', 'recover'),
      out: holdButton('out', 'out')
    };
    // The catcher is built before the row, so pause stays on top of it and is still pause on the comic card.
    var catcher = dom.catcher = el('div', 'touch-catch off', layer);
    catcher.dataset.ctl = 'catch';
    dom.row = el('div', 'tu-row', layer);
    dom.util = { pause: utilButton('pause'), camera: utilButton('camera'), mirror: utilButton('mirror') };

    // Measures the safe-area insets: see insets().
    dom.probe = el('div', 'touch-probe', layer);
    dom.probe.setAttribute('aria-hidden', 'true');

    var rotate = dom.rotate = el('div', 'touch-rotate off', root);
    var icon = el('div', 'touch-rotate-icon', rotate);
    icon.innerHTML = ICONS.phone;
    dom.rotateText = el('div', 'touch-rotate-text', rotate);

    listen(layer, 'pointerdown', onDown);
    listen(layer, 'pointermove', onMove);
    listen(layer, 'pointerup', onUp);
    listen(layer, 'pointercancel', onCancel);
    listen(layer, 'lostpointercapture', onCancel);
    // Stops the magnifier, double-tap zoom and the long-press menu on the controls. Pointer events carry everything we need.
    listen(layer, 'touchstart', function (ev) { if (ev.cancelable) ev.preventDefault(); }, { passive: false });
    listen(layer, 'contextmenu', function (ev) { ev.preventDefault(); });
    listen(rotate, 'pointerup', function () { touch.fullscreen(); });
    // A long press on the street is a thumb resting, not a request for a menu. With a mouse, a right click stays the browser's.
    var canvas = document.getElementById('game');
    listen(canvas, 'contextmenu', function (ev) { if (mode === 'touch') ev.preventDefault(); });

    // Which is being used: fingers, keys, or a mouse. Capture phase, so nothing that stops a key upstream hides it from here.
    listen(window, 'pointerdown', onAnyPointer, { capture: true, passive: true });
    listen(window, 'pointerup', onAnyPointerEnd, { capture: true, passive: true });
    listen(window, 'pointercancel', onAnyPointerEnd, { capture: true, passive: true });
    listen(window, 'touchstart', onAnyTouch, { capture: true, passive: true });
    listen(window, 'touchend', onAnyTouchEnd, { capture: true, passive: true });
    listen(window, 'keydown', onAnyKey, true);

    // A finger lifted where this page cannot see it never reports, so anything that can take the page away lets go of everything.
    listen(window, 'blur', releaseAll);
    listen(window, 'pagehide', releaseAll);
    listen(window, 'resize', relayout);
    listen(window, 'orientationchange', relayout);
    listen(document, 'visibilitychange', function () { if (document.hidden) releaseAll(); });
    listen(document, 'fullscreenchange', onFullscreen);
    if (window.visualViewport) listen(window.visualViewport, 'resize', relayout);
    // iOS pinch, and the page dragged about under a thumb that slid off a control. Only in touch mode: a Mac's trackpad pinch stays
    // the browser's. A list that scrolls (the board, the credits, an error) keeps its own scrolling.
    var pinch = function (ev) { if (mode === 'touch') ev.preventDefault(); };
    listen(document, 'gesturestart', pinch, { passive: false });
    listen(document, 'gesturechange', pinch, { passive: false });
    listen(document, 'touchmove', function (ev) {
      if (!layerOn || !ev.cancelable || inScroller(ev.target)) return;
      ev.preventDefault();
    }, { passive: false });
    layoutDirty = true;
    touch.relabel();
  };

  /** Rewrites the words on the buttons and the card, after a language or mode switch. */
  touch.relabel = function () {
    if (!dom) return;
    u().setText(dom.btn.horn.word, t('controls.horn'));
    u().setText(dom.btn.hazard.word, t('controls.parkBadly'));
    u().setText(dom.btn.recover.word, t('controls.tow'));
    u().setText(dom.btn.out.word, t('touch.out'));
    dom.btn.space.word._text = null;
    u().setText(dom.rotateText, t('touch.rotate'));
    dom.util.pause.node.title = t('controls.pause');
    dom.util.camera.node.title = t('controls.camera');
    dom.util.mirror.node.title = t('controls.mirror');
  };

  // ---- Fingers. -------------------------------------------------------------------------------------------------------------

  /**
   * @returns {{l:number,r:number}} The safe-area insets in pixels. A custom property holding env() reads back as its text, so a hidden
   * probe padded by the insets is measured instead.
   */
  function insets() {
    if (!dom || !dom.probe) return { l: 0, r: 0 };
    var cs = window.getComputedStyle(dom.probe);
    return { l: parseFloat(cs.paddingLeft) || 0, r: parseFloat(cs.paddingRight) || 0 };
  }

  /** @returns {boolean} True for a press in the strip a phone keeps for its own edge gestures. */
  function inEdgeBand(x) {
    var sa = insets();
    var left = Math.max(G.edgeMin, sa.l) + G.edgeBand;
    var right = Math.max(G.edgeMin, sa.r) + G.edgeBand;
    return x < left || x > window.innerWidth - right;
  }

  /** Lets the input source know a hold button's fingers changed. */
  function setHold(name, on) {
    var input = src();
    if (input) input.hold(HOLDS[name], on);
  }

  function holding(name) {
    var set = pressed[name];
    for (var id in set) {
      if (Object.prototype.hasOwnProperty.call(set, id)) return true;
    }
    return false;
  }

  /** @returns {number} The stick's radius in pixels: half the drawn ring, which CSS sizes from the screen. */
  function stickRadius() {
    var w = dom.ghost.getBoundingClientRect().width;
    return w > 0 ? w / 2 : 60;
  }

  function startStick(ev) {
    var zone = dom.zone.getBoundingClientRect();
    var r = stickRadius();
    stick.owner = ev.pointerId;
    stick.r = r;
    stick.zone = zone;
    // The whole ring stays inside the zone, so a thumb at its edge starts a little off centre.
    stick.cx = Math.min(Math.max(ev.clientX, zone.left + r), zone.right - r);
    stick.cy = Math.min(Math.max(ev.clientY, zone.top + r), zone.bottom - r);
    stick.leash = sim && sim.player && sim.player.mode === 'FOOT' ? G.leashFoot : G.leashCar;
    moveStick(ev.clientX, ev.clientY);
    dom.zone.classList.add('held');
  }

  function moveStick(x, y) {
    var dx = x - stick.cx;
    var dy = y - stick.cy;
    var d = Math.sqrt(dx * dx + dy * dy);
    var far = stick.leash * stick.r;
    if (d > far) {
      stick.cx += dx * (1 - far / d);
      stick.cy += dy * (1 - far / d);
      dx = x - stick.cx;
      dy = y - stick.cy;
    }
    stick.fx = x;
    stick.fy = y;
    var input = src();
    if (input) input.stick(Math.max(-1, Math.min(1, dx / stick.r)), Math.max(-1, Math.min(1, dy / stick.r)));
  }

  function endStick() {
    stick.owner = null;
    var input = src();
    if (input) input.stick(0, 0);
    if (dom) dom.zone.classList.remove('held');
  }

  /** @returns {boolean} True when a point is inside a rect grown by the slop. */
  function inSlop(rect, x, y) {
    var pad = Math.max(G.slopMinPx, Math.max(rect.width, rect.height) * G.slop);
    return x >= rect.left - pad && x <= rect.right + pad && y >= rect.top - pad && y <= rect.bottom + pad;
  }

  /** Short buzz for the buttons that act at once, where the phone offers it. */
  function buzz() {
    var nav = window.navigator;
    if (nav && typeof nav.vibrate === 'function') {
      try {
        nav.vibrate(12);
      } catch (err) {
        // A browser may refuse vibration without a gesture it counts. Nothing is lost.
      }
    }
  }

  function onDown(ev) {
    lastTouchMs = ev.pointerType === 'mouse' ? lastTouchMs : now();
    var target = ev.target && ev.target.closest ? ev.target.closest('[data-ctl]') : null;
    if (!target || !layerOn) return;
    var ctl = target.dataset.ctl;
    // Only the stick's open zone gives way to the phone's edge swipe. A drawn button is aimed at, wherever it sits.
    if (ctl === 'stick' && inEdgeBand(ev.clientX)) return;
    if (ctl === 'stick') {
      // One thumb drives. A second finger landing in the zone is ignored, so the steering never jumps.
      if (stick.owner !== null) return;
      startStick(ev);
    } else if (HOLDS[ctl]) {
      var first = !holding(ctl);
      pressed[ctl][ev.pointerId] = true;
      if (first) setHold(ctl, true);
      if (ctl === 'space' || ctl === 'out') buzz();
      target.classList.add('down');
    } else if (ctl === 'catch') {
      var input = src();
      if (input) input.tap('interact');
    }
    fingers[ev.pointerId] = { ctl: ctl, rect: target.getBoundingClientRect(), node: target };
    if (target.setPointerCapture) {
      try {
        target.setPointerCapture(ev.pointerId);
      } catch (err) {
        // A pointer the browser already let go of. Its up event still comes, or a blur lets go of everything.
      }
    }
  }

  function onMove(ev) {
    var finger = fingers[ev.pointerId];
    if (!finger) return;
    if (finger.ctl === 'stick' && stick.owner === ev.pointerId) {
      moveStick(ev.clientX, ev.clientY);
    } else if ((finger.ctl === 'hazard' || finger.ctl === 'recover') && !inSlop(finger.rect, ev.clientX, ev.clientY)) {
      // Sliding off a hold-to-act button is letting go of it. The other buttons stay held until the finger lifts.
      release(ev.pointerId);
    }
  }

  /** Ends one finger, whatever it was on. */
  function release(id) {
    var finger = fingers[id];
    if (!finger) return null;
    delete fingers[id];
    if (finger.ctl === 'stick' && stick.owner === id) endStick();
    if (HOLDS[finger.ctl] && pressed[finger.ctl][id]) {
      delete pressed[finger.ctl][id];
      if (!holding(finger.ctl)) {
        setHold(finger.ctl, false);
        finger.node.classList.remove('down');
      }
    }
    return finger;
  }

  function onUp(ev) {
    var finger = release(ev.pointerId);
    if (TLV.audio && TLV.audio.unlock) TLV.audio.unlock();
    if (!finger || !finger.rect) return;
    var r = finger.rect;
    var inside = ev.clientX >= r.left && ev.clientX <= r.right && ev.clientY >= r.top && ev.clientY <= r.bottom;
    if (!inside) return;
    if (finger.ctl === 'pause') {
      if (u().togglePause) u().togglePause();
    } else if (finger.ctl === 'camera') {
      key('KeyC', 'c');
    } else if (finger.ctl === 'mirror') {
      key('KeyV', 'v');
    }
  }

  function onCancel(ev) {
    release(ev.pointerId);
  }

  /** The page's own toggles, through the same key path a keyboard uses, as the title's start line does. Untrusted, so the mode stays. */
  function key(code, name) {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: code, key: name, bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keyup', { code: code, key: name, bubbles: true }));
  }

  /** Every finger off: the stick to rest, every button up. */
  function releaseAll() {
    for (var id in fingers) {
      if (Object.prototype.hasOwnProperty.call(fingers, id) && fingers[id].node) fingers[id].node.classList.remove('down');
    }
    fingers = {};
    for (var name in pressed) pressed[name] = {};
    stick.owner = null;
    if (dom) dom.zone.classList.remove('held');
    var input = src();
    if (input) input.release();
  }

  touch._releaseAll = releaseAll;

  function relayout() {
    layoutDirty = true;
    releaseAll();
  }

  // ---- Fullscreen. ----------------------------------------------------------------------------------------------------------

  /**
   * Asks for the whole screen and a sideways lock, where the browser allows either. iPhone Safari allows neither, and plays in a page.
   * Called from a tap: the start line, the turn-the-phone card.
   */
  touch.fullscreen = function () {
    if (mode !== 'touch' || document.fullscreenElement) return;
    var docEl = document.documentElement;
    if (!docEl.requestFullscreen) return;
    var asked;
    try {
      asked = docEl.requestFullscreen({ navigationUI: 'hide' });
    } catch (err) {
      return;
    }
    var lock = function () {
      var so = window.screen && window.screen.orientation;
      if (!so || typeof so.lock !== 'function') return;
      try {
        var locked = so.lock('landscape');
        if (locked && typeof locked.catch === 'function') locked.catch(function () {});
      } catch (err) {
        // Not every browser that grants fullscreen grants a lock.
      }
    };
    if (asked && typeof asked.then === 'function') asked.then(lock, function () {});
    else lock();
  };

  /** Leaving fullscreen in the middle of a run is leaving the window, and a run waits for its player. */
  function onFullscreen() {
    releaseAll();
    layoutDirty = true;
    if (!document.fullscreenElement && human() && sim && sim.game && live(sim.game.phase) && u().windowLeft) u().windowLeft();
  }

  // ---- Each frame. ----------------------------------------------------------------------------------------------------------

  function live(phase) {
    return phase !== 'TITLE' && phase !== 'RUN_END';
  }

  /** The knife stage the cards show, as cards.js reads it. */
  function knifeStage(S) {
    var forced = u().forcedWith ? u().forcedWith('knife.') : null;
    if (forced) return forced.slice('knife.'.length);
    var knife = S.game.knife;
    if (!knife || S.game.phase !== 'ENCOUNTER') return null;
    return knife.stage === 'RESOLVE' ? null : knife.stage;
  }

  /**
   * Whether 'park badly' can be asked for here: the rule of parking._qReaches, read rather than called, because the UI does not call
   * into the game. tests/ui/touch_reach.test.mjs holds the two together.
   * @param {object} S Sim state.
   * @returns {boolean} True with the car within reach of the door.
   */
  touch._qReach = function (S) {
    var g = S.game;
    var errand = g && g.errand;
    if (!errand) return false;
    var T = TLV.tune.game;
    var car = S.player.veh;
    var reach = g.errandIndex === T.legs.length - 1 ? T.finaleQM : T.doorQM;
    return TLV.math.dist(car.x, car.y, errand.doorX, errand.doorY) <= reach;
  };

  /** @returns {boolean} The turn-the-phone card is wanted: a phone in touch mode, held upright. */
  function wantRotate() {
    if (mode !== 'touch') return false;
    var w = window.innerWidth;
    var h = window.innerHeight;
    if (!(h > w && w < G.portraitMaxW)) return false;
    // A room code being typed: the soft keyboard has made the page short, and that is not a phone turned upright.
    var focus = document.activeElement;
    return !(focus && /^(INPUT|TEXTAREA)$/.test(focus.tagName || ''));
  }

  function frameRotate(S) {
    var want = wantRotate() && !u().contextLost();
    if (want !== rotateOn) {
      rotateOn = want;
      u().show(dom.rotate, want);
      releaseAll();
      if (!want) rotatePaused = false;
    }
    // Turning the phone upright in the middle of a run is a reason to stop it, once. Back sideways, the pause screen takes over.
    if (want && !rotatePaused && human() && S.game && live(S.game.phase)) {
      rotatePaused = true;
      if (u().windowLeft) u().windowLeft();
    }
  }

  /** @returns {boolean} True when the stick and buttons belong on screen. */
  function wantLayer(S) {
    var g = S.game;
    if (mode !== 'touch' || !g || !live(g.phase) || rotateOn) return false;
    if (S.params.autoplay || root.classList.contains('no-hud')) return false;
    if (u().isUserPaused() || u().contextLost() || u().isForced('title')) return false;
    if (u().menus && u().menus.busy && u().menus.busy()) return false;
    if (u().versus && u().versus.lobbyOpen && u().versus.lobbyOpen()) return false;
    return true;
  }

  function showBtn(btn, on, dim) {
    if (btn.shown !== on) {
      btn.shown = on;
      btn.node.classList.toggle('off', !on);
    }
    if (btn.dim !== dim) {
      btn.dim = dim;
      btn.node.classList.toggle('dim', !!dim);
    }
  }

  function ringFill(btn, fill) {
    var v = Math.max(0, Math.min(1, fill)).toFixed(3);
    if (btn.ring._fill === v) return;
    btn.ring._fill = v;
    btn.ring.style.setProperty('--fill', v);
  }

  function utilShow(name, on) {
    var btn = dom.util[name];
    if (btn.shown === on) return;
    btn.shown = on;
    btn.node.classList.toggle('off', !on);
  }

  /** Places the rear-view strip under the No-Claims bar in touch mode, and gives it back its own place in keys mode. */
  function layoutMirror() {
    var rear = TLV.render && TLV.render.rearview;
    if (!rear || !rear.layout) return;
    if (mode !== 'touch') {
      rear.layout(null);
      return;
    }
    var hp = document.querySelector('.hud-hp');
    var box = hp ? hp.getBoundingClientRect() : null;
    if (!box || !box.height) {
      // The HUD has not been laid out yet. Ask again next frame.
      layoutDirty = true;
      return;
    }
    var at = rear.layout({
      w: Math.min(220, Math.round(window.innerWidth * 0.26)),
      right: Math.max(8, Math.round(window.innerWidth - box.right)),
      top: Math.round(box.bottom + 6)
    });
    // The pause, camera and mirror row goes under where the strip shows, so the strip never covers it.
    if (at && dom) dom.layer.style.setProperty('--tu-top', Math.round(at.top + at.h + 8) + 'px');
  }

  /** The stick's ring and knob: at the thumb while it is down, at its resting place otherwise. */
  function drawStick(S) {
    var held = stick.owner !== null;
    if (held) {
      var zone = stick.zone;
      var r = stick.r;
      var dx = stick.fx - stick.cx;
      var dy = stick.fy - stick.cy;
      var d = Math.sqrt(dx * dx + dy * dy);
      if (d > r) {
        dx *= r / d;
        dy *= r / d;
      }
      dom.base.style.transform = 'translate(' + (stick.cx - zone.left - r).toFixed(1) + 'px,' + (stick.cy - zone.top - r).toFixed(1) + 'px)';
      dom.knob.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
    }
    var letGo = S.game.phase === 'HOLD' && S.controls.throttle > G.letGoThrottle;
    dom.zone.classList.toggle('let-go', letGo);
  }

  /**
   * One frame: the mode a pad can take, the turn-the-phone card, and what of the overlay shows for this phase.
   * @param {object} S Sim state.
   * @param {number} dtReal Real seconds since the last frame.
   */
  touch.frame = function (S, dtReal) {
    sim = S;
    if (!dom || !S.game) return;
    if (mode === 'touch' && !pinned && keysMayTake() && padActive()) flip('keys');
    frameRotate(S);
    if (layoutDirty) {
      layoutDirty = false;
      layoutMirror();
    }
    var on = wantLayer(S);
    if (on !== layerOn) {
      layerOn = on;
      u().show(dom.layer, on);
      if (!on) releaseAll();
    }
    if (!on) return;
    var g = S.game;
    var phase = g.phase;
    var foot = S.player.mode === 'FOOT';
    var stage = knifeStage(S);
    var driving = !foot && (phase === 'DRIVE' || phase === 'SEARCH' || phase === 'HOLD');
    var resolve = phase === 'RESOLVE';
    var waiting = phase === 'CARD' || phase === 'PAYOUT' || phase === 'BLOCKED';
    var tug = stage === 'DOOR_TUG';
    var chase = stage === 'CHASE' && foot;
    dom.layer.classList.toggle('foot', foot);

    // The stick: live when driving, on the card (the car pulls out on it) and in the chase. Dim where nothing it does matters.
    var stickOn = !resolve;
    dom.zone.classList.toggle('off', !stickOn);
    dom.zone.classList.toggle('dim', stickOn && !(driving || chase || phase === 'CARD'));
    if (stickOn) drawStick(S);
    u().show(dom.catcher, resolve);

    var T = TLV.tune.game;
    var btn = dom.btn;
    // E takes SPACE's place while the door is being tugged at. A finger already down keeps what it pressed.
    showBtn(btn.out, (tug || holding('out')) && !resolve, false);
    btn.out.node.classList.toggle('pulse', tug);
    var spaceWanted = (driving || waiting || chase) && !tug;
    showBtn(btn.space, spaceWanted || holding('space'), waiting);
    btn.space.node.classList.toggle('pulse', chase && !!g.knife && g.knife.lunge === 'WINDUP');
    if (btn.space.icon !== (foot ? 'dodge' : 'space')) {
      btn.space.icon = foot ? 'dodge' : 'space';
      btn.space.glyph.innerHTML = ICONS[btn.space.icon];
    }
    u().setText(btn.space.word, t(foot ? 'touch.dodge' : 'controls.handbrake'));
    showBtn(btn.horn, (driving || waiting) || holding('horn'), waiting);

    // Park badly: near the door, or while its hold is filling.
    var qHold = phase === 'HOLD' && g.park.kind && g.park.kind !== 'BAY';
    var qNear = (phase === 'DRIVE' || phase === 'SEARCH') && driving && touch._qReach(S);
    showBtn(btn.hazard, qHold || qNear || holding('hazard'), !qHold && Math.abs(S.player.veh.v) >= T.qStopV);
    ringFill(btn.hazard, qHold ? g.park.bar : 0);

    // Tow: while the HUD offers it, and a while after, so it stays under a thumb on its way there.
    var offered = driving && u().hud && u().hud.towOffered && u().hud.towOffered();
    if (offered || holding('recover')) towSeen = S.t;
    towHeldT = holding('recover') ? towHeldT + Math.min(dtReal, 0.1) : 0;
    showBtn(btn.recover, driving && (S.t - towSeen < G.towLingerS || holding('recover')), false);
    ringFill(btn.recover, towHeldT / T.recoverHoldS);

    utilShow('pause', true);
    utilShow('camera', driving);
    utilShow('mirror', driving || chase);

    // A page zoomed by a pinch that got past the guards hides the street. Say so once a run.
    var vv = window.visualViewport;
    if (vv && vv.scale > 1.01 && pinchRun !== g && u().hud && u().hud.toast) {
      pinchRun = g;
      u().hud.toast(t('touch.pinch'), 'warn');
    }
  };
})(window.TLV);
