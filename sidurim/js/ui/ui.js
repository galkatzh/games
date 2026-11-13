// js/ui/ui.js — WP-UI
// The package's front door: boot hooks, the frame, the event table, language, pause, mute and the error overlay. The UI reads the sim
// and never writes it (ARCHITECTURE 15.2). The only calls that reach the sim are S.bus.drain, and TLV.game.setDifficulty on the title.
(function (TLV) {
  'use strict';

  var ui = TLV.ns('ui');

  /**
   * What happens to every event of ARCHITECTURE 11. Each value names who reacts; 'none' is a decision, not an omission. ui.dispatch
   * forwards every event to all of them anyway, so this table is the statement a test holds the code to.
   */
  ui.EVENTS = {
    'player.contact': ['hud', 'audio'],
    'player.hitPed': ['hud', 'audio'],
    'player.nearMiss': ['hud', 'audio'],
    'player.wrongWay': ['hud'],
    'player.surface': ['audio'],
    'player.mode': ['hud'],
    'player.brushPed': ['audio'],
    'player.horn': ['audio'],
    'player.launch': ['audio'],
    'player.redRun': ['hud'],
    'player.waterEdge': ['hud'],
    'player.recover': ['hud'],
    'traffic.spawn': ['debug'],
    'traffic.despawn': ['debug'],
    'traffic.behaviour': ['debug'],
    'traffic.redRun': ['audio'],
    'traffic.honk': ['audio'],
    'traffic.wreck': ['audio'],
    'traffic.parkRace': ['none'],
    'traffic.door': ['audio'],
    'ped.spawn': ['debug'],
    'ped.despawn': ['debug'],
    'ped.intent': ['none'],
    'ped.stepOut': ['none'],
    'ped.bell': ['audio'],
    'nav.recalc': ['hud'],
    'errand.start': ['hud', 'cards', 'audio'],
    'errand.search': ['hud'],
    'errand.parked': ['cards', 'audio'],
    'errand.paid': ['cards'],
    'inspector.ticket': ['hud', 'audio'],
    'contest.start': ['hud', 'audio'],
    'contest.state': ['hud'],
    'contest.result': ['hud', 'audio'],
    'knife.stage': ['cards', 'audio'],
    'knife.lunge': ['audio'],
    'knife.strike': ['hud', 'audio'],
    'knife.exit': ['cards', 'audio'],
    'incident.telegraph': ['hud', 'audio'],
    'incident.end': ['debug'],
    'score.bonus': ['hud', 'audio'],
    'score.chain': ['hud'],
    'clock.warn': ['hud', 'audio'],
    'run.start': ['hud', 'cards', 'menus', 'bubbles', 'audio', 'versus'],
    'run.end': ['menus', 'audio'],
    'bubble': ['bubbles'],
    'versus.start': ['none'],
    'versus.peer': ['versus'],
    'versus.pick': ['none'],
    'versus.done': ['versus'],
    'versus.taken': ['versus'],
    'versus.unlock': ['versus'],
    'versus.void': ['versus'],
    'versus.ended': ['versus'],
    'versus.ready': ['none']
  };

  var root = null;
  var sim = null;
  var errorBox = null;
  var hudParam = 1;
  var forced = {};
  var pausedHere = false;
  /** The lost WebGL context, while it is gone: { t: seconds shown, holdsLoop: this pause is ours }. */
  var lost = null;
  /** Where a paused frame's reading of the pad lands. Nothing reads it: only the button edges inside input.sample matter. */
  var padScratch = {};

  /**
   * Creates an element.
   * @param {string} tag Tag name.
   * @param {?string} cls Class list.
   * @param {?Element} parent Appended here when given.
   * @param {string} [text] Text content.
   * @returns {Element} The element.
   */
  ui.el = function (tag, cls, parent, text) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text !== undefined) node.textContent = text;
    if (parent) parent.appendChild(node);
    return node;
  };

  /** Sets text only when it changed, because most of the HUD does not change on most frames. */
  ui.setText = function (node, text) {
    if (node._text === text) return;
    node._text = text;
    node.textContent = text;
  };

  /**
   * Sets a display string, turning each [X] into a keycap.
   * @param {Element} node Target.
   * @param {string} text Display text.
   */
  ui.setRich = function (node, text) {
    if (node._text === text) return;
    node._text = text;
    node.textContent = '';
    TLV.ui.strings.parts(text).forEach(function (part) {
      if (part.key) {
        var cap = ui.el('kbd', 'key', node, part.text);
        cap.dir = 'ltr';
      } else {
        node.appendChild(document.createTextNode(part.text));
      }
    });
  };

  /** Shows or hides a node, with the same guard. */
  ui.show = function (node, on) {
    var value = !!on;
    if (node._shown === value) return;
    node._shown = value;
    node.classList.toggle('off', !value);
  };

  /** Reads from browser storage. A private window, or a blocked one, can throw. */
  ui.load = function (key) {
    try {
      return window.localStorage.getItem(key);
    } catch (e) {
      return null;
    }
  };

  /** Writes to browser storage, as a convenience that may fail. */
  ui.save = function (key, value) {
    try {
      window.localStorage.setItem(key, String(value));
    } catch (e) {
      // Nothing to do: the choice lasts until the page closes.
    }
  };

  /** @returns {number} World heading the view looks along. With no camera yet, the way the player faces. */
  ui.viewYaw = function (S) {
    var cam = TLV.render && TLV.render.camera;
    if (cam && cam.yaw) return cam.yaw();
    var p = S.player;
    if (p && p.mode === 'FOOT' && p.foot) return p.foot.h;
    return S.vehicles[0].h;
  };

  /**
   * The contract names no way to ask which rig is live, and the rule behind it has C toggles and a leave distance the UI cannot see, so
   * this reads WP-RENDER's read-only state hook. Without it the HUD keeps its chase layout, which is only a worse view of the bay.
   * @returns {boolean} True while the parking rig holds the view, its blend included.
   */
  ui.parkingView = function () {
    var cam = TLV.render && TLV.render.camera;
    var state = cam && cam._state ? cam._state() : null;
    return !!state && state.rig === 'parking';
  };

  var projected = { sx: 0, sy: 0, visible: false };

  /**
   * World point to screen. The result is shared, so read it at once.
   * @returns {?{sx:number,sy:number,visible:boolean}} CSS pixels, or null with no renderer.
   */
  ui.project = function (x, y, z) {
    if (!TLV.render || !TLV.render.project) return null;
    return TLV.render.project(x, y, z, projected);
  };

  /** @returns {boolean} True when a screen is forced by TLV.debug.ui. */
  ui.isForced = function (name) {
    return !!forced[name];
  };

  /** @returns {?string} The forced screen that starts with a prefix, such as 'end.'. */
  ui.forcedWith = function (prefix) {
    for (var name in forced) {
      if (forced[name] && name.indexOf(prefix) === 0) return name;
    }
    return null;
  };

  /** Names TLV.debug.ui accepts. */
  function screens() {
    var out = ['title', 'pause', 'credits', 'hud', 'debug', 'dev', 'card', 'payout', 'block'];
    ['REACHED_SHOP', 'SHAKEN', 'WHISTLE'].forEach(function (x) { out.push('resolve.' + x); });
    ['STANDOFF', 'DOOR_TUG', 'BAIL', 'DRAGGED', 'CHASE'].forEach(function (x) { out.push('knife.' + x); });
    ['CLOCK', 'TOWED', 'CAUGHT', 'REVOKED', 'WIN', 'DONE'].forEach(function (x) { out.push('end.' + x); });
    return out;
  }

  /**
   * Forces a card or screen, for tests. Only one of a family shows, so naming a new one clears the last.
   * @param {string} name A name from TLV.debug.ui('list').
   * @param {boolean} [visible=true] False clears it.
   * @returns {boolean|string[]} True if known; the list of names for 'list'.
   */
  ui.force = function (name, visible) {
    var names = screens();
    if (name === 'list') return names;
    if (names.indexOf(name) < 0) return false;
    var family = name.indexOf('.') > 0 ? name.slice(0, name.indexOf('.') + 1) : null;
    if (family) {
      names.forEach(function (n) {
        if (n.indexOf(family) === 0) forced[n] = false;
      });
    }
    forced[name] = visible !== false;
    return true;
  };

  /** Registers the debug hook. Called in boot step 1. */
  ui.register = function () {
    if (TLV.debug && TLV.debug.register) {
      TLV.debug.register('ui', function (name, visible) {
        return ui.force(name, visible);
      });
    }
  };

  /** Sets #ui-root to a language's direction, which the whole layout hangs on. */
  function applyLang() {
    var lang = ui.strings.lang();
    if (!root) return;
    root.lang = lang;
    root.dir = lang === 'he' ? 'rtl' : 'ltr';
    root.classList.toggle('rtl', lang === 'he');
  }

  /**
   * Switches language for UI and cards.
   * @param {string} lang 'en' or 'he'.
   */
  ui.setLang = function (lang) {
    ui.strings.setLang(lang);
    applyLang();
    if (!sim) return;
    ui.hud.relabel(sim);
    ui.cards.relabel(sim);
    ui.menus.relabel(sim);
    ui.versus.relabel(sim);
  };

  /** The language at boot: the URL if it says, then the last choice, then English. */
  function startLang(S) {
    if (/[?&]lang=/.test(window.location.search)) return S.params.lang;
    return ui.load(TLV.tune.ui.keyLang) || S.params.lang;
  }

  /** Removes the error box, once someone has read it. */
  function closeError() {
    if (errorBox && errorBox.parentNode) errorBox.parentNode.removeChild(errorBox);
    errorBox = null;
  }

  /** @returns {boolean} True when the boot failed on a machine that cannot draw the game: asking the browser beats reading the wording. */
  function noGraphics(text) {
    if (!/^Boot failed/m.test(text)) return false;
    try {
      return !document.createElement('canvas').getContext('webgl2');
    } catch (e) {
      return true;
    }
  }

  /**
   * Shows an error over everything. It works before init, it replaces the text on each call because each call carries everything
   * so far, and it can be closed, since a missing optional file leaves a game that still runs. With no graphics the player gets plain
   * words in both languages, whichever they have chosen, and the technical line stays in the page for anyone debugging it.
   * @param {string} text Plain text.
   */
  ui.showError = function (text) {
    var host = document.getElementById('ui-root') || document.body;
    if (!errorBox) {
      errorBox = document.createElement('div');
      errorBox.className = 'ui-error';
      errorBox.id = 'ui-error';
      var head = document.createElement('div');
      head.className = 'ui-error-head';
      var close = document.createElement('button');
      close.className = 'ui-error-close';
      close.textContent = '×';
      close.title = 'Close';
      close.addEventListener('click', closeError);
      head.appendChild(close);
      errorBox.appendChild(head);
      var plain = document.createElement('div');
      plain.className = 'ui-error-plain';
      errorBox.appendChild(plain);
      errorBox._plain = plain;
      var body = document.createElement('pre');
      body.className = 'ui-error-body';
      errorBox.appendChild(body);
      errorBox._body = body;
    }
    errorBox._body.textContent = text;
    var table = TLV.ui.strings && TLV.ui.strings.table;
    var words = !!table && noGraphics(text);
    errorBox.classList.toggle('no-graphics', words);
    while (errorBox._plain.firstChild) errorBox._plain.removeChild(errorBox._plain.firstChild);
    if (words) {
      ['he', 'en'].forEach(function (lang) {
        var line = document.createElement('p');
        line.dir = 'auto';
        line.textContent = table[lang]['error.noGraphics'];
        errorBox._plain.appendChild(line);
      });
    }
    if (errorBox.parentNode !== host) host.appendChild(errorBox);
  };

  /** @returns {?object} The browser loop. */
  function theLoop() {
    return (TLV.app && TLV.app.loop) || null;
  }

  /** @returns {boolean} True while the sim loop is paused. */
  ui.isPaused = function () {
    var loop = theLoop();
    return !!(loop && loop.isPaused && loop.isPaused());
  };

  /** @returns {boolean} True when the player paused, not a test through TLV.debug.pause. */
  ui.isUserPaused = function () {
    return pausedHere && ui.isPaused();
  };

  /**
   * Pauses or resumes, with the pause screen. Between runs there is nothing to pause, and with the picture gone the lost screen holds
   * the loop.
   * @param {boolean} [quiet] True when the player did not ask, so there is no click.
   */
  ui.togglePause = function (quiet) {
    var loop = theLoop();
    if (!loop || !sim || !sim.game || lost) return;
    var phase = sim.game.phase;
    if (phase === 'TITLE' || phase === 'RUN_END') return;
    if (loop.isPaused()) loop.resume();
    else loop.pause();
    pausedHere = loop.isPaused();
    if (TLV.input && TLV.input.dropTaps) TLV.input.dropTaps();
    if (quiet !== true) TLV.audio.ui('click');
    TLV.audio.setPaused(pausedHere);
  };

  /** @returns {boolean} True with a gamepad connected. */
  ui.padConnected = function () {
    var nav = window.navigator;
    var pads = nav && nav.getGamepads ? nav.getGamepads() : [];
    for (var i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].connected) return true;
    }
    return false;
  };

  /**
   * The window lost focus or the tab went away, so nobody is at the wheel. A run waits on the pause screen and the player brings it back:
   * the clock must not fall unattended, and a chase must not resume under someone who has only just looked back.
   */
  ui.windowLeft = function () {
    var loop = theLoop();
    if (!loop || loop.isPaused()) return;
    // A shared day does not wait: the other driver is still out there, and a paused sim would only fall behind the board.
    if (sim && ui.versus.shared(sim)) return;
    ui.togglePause(true);
  };

  /**
   * The tab was hidden or came back. rAF stops in a hidden tab, so the frame cannot quieten anything that is playing, on any screen.
   * @param {boolean} hidden True when it went away.
   */
  ui.tabHidden = function (hidden) {
    if (hidden) TLV.audio.setPaused(true);
    else if (!ui.isPaused()) TLV.audio.setPaused(false);
  };

  /**
   * The WebGL context went. Three.js asks for it back by itself, so the world only has to wait: with no picture the clock must not run.
   */
  ui.onContextLost = function () {
    var loop = theLoop();
    if (lost || !loop) return;
    lost = { t: 0, holdsLoop: !loop.isPaused() };
    if (lost.holdsLoop) loop.pause();
    TLV.audio.setPaused(true);
  };

  /** The context is back. If the player has gone meanwhile the run waits on the pause screen, as it would have if they left while it played. */
  ui.onContextRestored = function () {
    var loop = theLoop();
    if (!lost || !loop) return;
    var held = lost.holdsLoop;
    lost = null;
    if (!held) return;
    if (document.hidden || !document.hasFocus()) {
      var phase = sim && sim.game ? sim.game.phase : 'TITLE';
      if (phase !== 'TITLE' && phase !== 'RUN_END') {
        pausedHere = true;
        return;
      }
    }
    loop.resume();
    TLV.audio.setPaused(false);
  };

  /** @returns {?{stale:boolean}} The lost context, with stale set once it has been gone long enough to suggest a reload. */
  ui.contextLost = function () {
    return lost ? { stale: lost.t >= TLV.tune.ui.lostReloadS } : null;
  };

  /** Flips mute and remembers it. */
  ui.toggleMute = function () {
    var next = !TLV.audio.isMuted();
    TLV.audio.setMuted(next);
    ui.save(TLV.tune.ui.keyMute, next ? '1' : '0');
    if (sim) ui.menus.relabel(sim);
    if (ui.hud.isLive()) ui.hud.toast(ui.strings.t(next ? 'pause.soundOff' : 'pause.soundOn'));
  };

  /**
   * Hands one drained event to every consumer.
   * @param {string} name Event name.
   * @param {object} payload Payload.
   */
  ui.dispatch = function (name, payload) {
    var S = sim;
    TLV.audio.onEvent(S, name, payload);
    ui.hud.onEvent(S, name, payload);
    ui.cards.onEvent(S, name, payload);
    ui.menus.onEvent(S, name, payload);
    ui.versus.onEvent(S, name, payload);
    ui.bubbles.onEvent(S, name, payload);
    ui.debugOverlay.onEvent(S, name, payload);
    if (TLV.render && TLV.render.onEvent) TLV.render.onEvent(name, payload);
  };

  /**
   * Builds the UI. Runs again on a new sim for TLV.debug.importReplay, so it clears what it built and keeps the error box.
   * @param {Element} rootEl #ui-root.
   * @param {object} S Sim state.
   */
  ui.init = function (rootEl, S) {
    root = rootEl;
    sim = S;
    forced = {};
    var keep = errorBox && errorBox.parentNode === root ? errorBox : null;
    root.textContent = '';
    if (keep) root.appendChild(keep);
    root.classList.add('ui');
    hudParam = S.params.hud === 0 ? 0 : 1;
    ui.strings.setLang(startLang(S));
    applyLang();
    ui.bubbles.build(root);
    ui.hud.build(root, S);
    ui.minimap.build(ui.hud.mapSlot(), S);
    ui.cards.build(root, S);
    // Before the menus, so its key listener is ahead of theirs.
    ui.versus.build(root, S);
    ui.menus.build(root, S);
    ui.debugOverlay.build(root, S);
    TLV.audio.init(S);
    S.bus.enableDrain();
  };

  /**
   * One UI frame. Called by the main loop after render, paused or not.
   * @param {object} S Sim state.
   * @param {number} alpha Interpolation factor.
   * @param {number} dtReal Real seconds since the last frame.
   */
  ui.frame = function (S, alpha, dtReal) {
    if (!root) return;
    sim = S;
    S.bus.drain(ui.dispatch);
    var dt = ui.isPaused() ? 0 : Math.min(0.25, dtReal);
    if (lost) lost.t += dtReal;
    // The pad is only read by input.sample, which runs from the sim step, and a paused loop does not step. Reading it here keeps Start's
    // edge in the one place that tracks it, so the press that paused cannot also resume.
    if (ui.isUserPaused() && ui.padConnected() && TLV.input && TLV.input.sample) TLV.input.sample(S, padScratch);
    var showHud = (hudParam === 1 || forced.hud) && !forced.title;
    root.classList.toggle('no-hud', !showHud);
    ui.hud.frame(S, alpha, dt, showHud);
    ui.minimap.frame(S, showHud);
    ui.bubbles.frame(S, alpha, dt);
    ui.cards.frame(S, dt);
    ui.menus.frame(S);
    ui.versus.frame(S, showHud);
    ui.debugOverlay.frame(S, dtReal);
    TLV.audio.frame(S, dt);
  };
})(window.TLV);
