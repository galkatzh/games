// js/input/input.js — WP-PLAYER
// Keyboard and gamepad to ControlState (GAME_DESIGN 5, ARCHITECTURE 12.4). Browser only. The input layer has no phase logic:
// it reports what is held, and the sim reads each field only when that field means something. The foot vector leaves here
// already in the world frame, so the sim never depends on the camera.
(function (TLV) {
  'use strict';

  var input = TLV.ns('input');

  /** Gamepad button indices, standard mapping. */
  var PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9 };
  var STICK_DEAD = 0.15;
  var TRIGGER_DEAD = 0.05;

  /** Keys the page must not act on: arrows and Space would scroll. */
  var CAPTURED = {
    ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true, Space: true
  };

  /** Keys that act on the page and never enter ControlState. They are no one's "any key": pausing on a card must not skip it. */
  var UI_KEYS = { Escape: true, KeyP: true, KeyC: true, KeyV: true, KeyM: true };

  /** Held keys, by KeyboardEvent.code. Input state is the browser's, not the sim's, and there is one keyboard. */
  var held = {};
  var padHeld = {};
  /** A new key went down with another already held, so `start` drops for one sample and the sim sees it rise. */
  var startNotch = false;
  /** A key went down with none held, so `start` shows for the next sample even if the key is up again by then: frames can be slow. */
  var startTap = false;
  /** The same for E and for Enter or R: a press shows for the next sample, however short it was and however long that sample takes. */
  var interactTap = false;
  var restartTap = false;
  var bound = null;
  var listeners = null;

  function down() {
    for (var i = 0; i < arguments.length; i++) {
      if (held[arguments[i]]) return true;
    }
    return false;
  }

  /** @returns {boolean} True if any key that plays the game is held. */
  function anyKey() {
    for (var code in held) {
      if (held[code] && !UI_KEYS[code]) return true;
    }
    return false;
  }

  /** Forgets every tap not yet sampled. */
  function dropTaps() {
    startNotch = false;
    startTap = false;
    interactTap = false;
    restartTap = false;
  }

  /** A paused sim samples nothing, so a press made on the pause screen would otherwise wait there and land on the first tick of play. */
  input.dropTaps = dropTaps;

  /** @returns {?object} The first connected gamepad. */
  function gamepad(win) {
    var nav = win.navigator;
    if (!nav || !nav.getGamepads) return null;
    var pads = nav.getGamepads();
    for (var i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].connected) return pads[i];
    }
    return null;
  }

  /** @returns {number} A stick axis with its dead zone removed, -1..1. */
  function axis(pad, i) {
    var v = pad.axes[i] || 0;
    if (Math.abs(v) < STICK_DEAD) return 0;
    return (v - (v > 0 ? STICK_DEAD : -STICK_DEAD)) / (1 - STICK_DEAD);
  }

  function pressed(pad, i) {
    var b = pad.buttons[i];
    return !!b && b.pressed;
  }

  function trigger(pad, i) {
    var b = pad.buttons[i];
    if (!b) return 0;
    return b.value > TRIGGER_DEAD ? b.value : 0;
  }

  /** Runs fn on the rising edge of a pad button. */
  function padEdge(pad, i, fn) {
    var on = pressed(pad, i);
    if (on && !padHeld[i]) fn();
    padHeld[i] = on;
  }

  function togglePause() {
    if (TLV.ui && TLV.ui.togglePause) TLV.ui.togglePause();
  }

  function toggleCamera() {
    if (TLV.render && TLV.render.camera && TLV.render.camera.toggleParking) TLV.render.camera.toggleParking();
  }

  function toggleRearview() {
    if (TLV.render && TLV.render.rearview && TLV.render.rearview.toggle) TLV.render.rearview.toggle();
  }

  function toggleMute() {
    if (TLV.ui && TLV.ui.toggleMute) TLV.ui.toggleMute();
  }

  /** @returns {number} World heading the camera looks along. With no camera yet, north is ahead. */
  function cameraYaw() {
    var cam = TLV.render && TLV.render.camera;
    return cam && cam.yaw ? cam.yaw() : Math.PI / 2;
  }

  /** Rotates a camera-relative move vector into the world frame. forward and right are -1..1. */
  function footVector(out, forward, right) {
    var yaw = cameraYaw();
    var c = Math.cos(yaw);
    var s = Math.sin(yaw);
    var x = forward * c + right * s;
    var y = forward * s - right * c;
    var mag = Math.sqrt(x * x + y * y);
    if (mag > 1) {
      x /= mag;
      y /= mag;
    }
    out.footX = x;
    out.footY = y;
  }

  /** The UI keys, which never enter ControlState. */
  function uiKey(code) {
    switch (code) {
      case 'Escape':
      case 'KeyP': togglePause(); break;
      case 'KeyC': toggleCamera(); break;
      case 'KeyV': toggleRearview(); break;
      case 'KeyM': toggleMute(); break;
      default: break;
    }
  }

  function onDown(e) {
    if (CAPTURED[e.code]) e.preventDefault();
    if (!e.repeat) uiKey(e.code);
    if (!e.repeat && !held[e.code] && !UI_KEYS[e.code]) {
      if (!anyKey()) startTap = true;
      else if (!startTap) startNotch = true;
      if (e.code === 'KeyE') interactTap = true;
      if (e.code === 'Enter' || e.code === 'KeyR') restartTap = true;
    }
    held[e.code] = true;
    // A key press is the user gesture that web audio waits for.
    if (TLV.audio && TLV.audio.unlock) TLV.audio.unlock();
  }

  function onUp(e) {
    if (CAPTURED[e.code]) e.preventDefault();
    held[e.code] = false;
  }

  /** A key released in another window never reports here. */
  function onBlur() {
    held = {};
    dropTaps();
  }

  /**
   * Reads what is held now into a ControlState.
   * @param {object} S Sim state.
   * @param {object} out ControlState, written and returned.
   * @returns {object} out.
   */
  input.sample = function (S, out) {
    var left = down('KeyA', 'ArrowLeft');
    var right = down('KeyD', 'ArrowRight');
    var up = down('KeyW', 'ArrowUp');
    var back = down('KeyS', 'ArrowDown');
    var space = down('Space');
    var steer = (left ? 1 : 0) - (right ? 1 : 0);
    var throttle = up ? 1 : 0;
    var brake = back ? 1 : 0;
    var forward = (up ? 1 : 0) - (back ? 1 : 0);
    var side = (right ? 1 : 0) - (left ? 1 : 0);

    out.handbrake = space;
    out.sidestep = space;
    out.horn = down('KeyH');
    out.interact = down('KeyE') || interactTap;
    out.hazard = down('KeyQ');
    out.recover = down('KeyR');
    out.start = (anyKey() || startTap) && !startNotch;
    out.restart = down('Enter', 'KeyR') || restartTap;
    dropTaps();

    var pad = bound ? gamepad(bound) : null;
    if (pad) {
      var stickX = axis(pad, 0);
      var stickY = axis(pad, 1);
      if (stickX !== 0) steer = -stickX;
      throttle = Math.max(throttle, trigger(pad, PAD.RT));
      brake = Math.max(brake, trigger(pad, PAD.LT));
      if (stickX !== 0 || stickY !== 0) {
        forward = -stickY;
        side = stickX;
      }
      var a = pressed(pad, PAD.A);
      out.handbrake = out.handbrake || a;
      out.sidestep = out.sidestep || a;
      out.horn = out.horn || pressed(pad, PAD.B);
      out.interact = out.interact || pressed(pad, PAD.X);
      out.hazard = out.hazard || pressed(pad, PAD.Y);
      out.recover = out.recover || pressed(pad, PAD.BACK);
      var phase = S && S.game ? S.game.phase : null;
      var startButton = pressed(pad, PAD.START);
      out.start = out.start || (phase === 'TITLE' && startButton);
      out.restart = out.restart || (phase === 'RUN_END' && startButton);
      if (phase !== 'TITLE' && phase !== 'RUN_END') padEdge(pad, PAD.START, togglePause);
      else padHeld[PAD.START] = startButton;
      padEdge(pad, PAD.LB, toggleCamera);
      padEdge(pad, PAD.RB, toggleRearview);
    }

    out.throttle = throttle;
    out.brake = brake;
    out.steer = steer;
    footVector(out, forward, side);
    return out;
  };

  /**
   * Installs the browser control source, unless a bot is driving (ARCHITECTURE 12.4). UI keys always work.
   * @param {object} win Window.
   * @param {object} S Sim state.
   */
  input.init = function (win, S) {
    if (listeners) {
      bound.removeEventListener('keydown', listeners.down);
      bound.removeEventListener('keyup', listeners.up);
      bound.removeEventListener('blur', listeners.blur);
    }
    bound = win;
    held = {};
    padHeld = {};
    dropTaps();
    listeners = { down: onDown, up: onUp, blur: onBlur };
    win.addEventListener('keydown', onDown);
    win.addEventListener('keyup', onUp);
    win.addEventListener('blur', onBlur);
    if (S && !S.params.autoplay) {
      S.controlSource = function (sim) {
        return input.sample(sim, sim.controls);
      };
    }
  };
})(window.TLV);
