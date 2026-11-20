// js/input/input.js — WP-PLAYER
// Keyboard, gamepad and the on-screen stick and buttons to ControlState (GAME_DESIGN 5, ARCHITECTURE 12.4). Browser only. The input layer has no phase logic:
// it reports what is held, and the sim reads each field only when that field means something. The foot vector leaves here
// already in the world frame, so the sim never depends on the camera.
(function (TLV) {
  'use strict';

  var input = TLV.ns('input');

  /** Gamepad button indices, standard mapping. */
  var PAD = { A: 0, B: 1, X: 2, Y: 3, LB: 4, RB: 5, LT: 6, RT: 7, BACK: 8, START: 9 };
  var STICK_DEAD = 0.15;
  var TRIGGER_DEAD = 0.05;

  /**
   * The on-screen stick and buttons (js/ui/touch.js). The stick reports a finger's offset over its radius, each axis -1..1, y down.
   * Forward past deadY is throttle from `creep`, which is just over what moves the car (vehicle.js driveForce), rising as the square,
   * so the first half of the travel is for creeping into a bay. Back is a brake from backCreep, which at rest becomes reverse by itself:
   * under 1/6 the coasting drag beats the reverse push (vehicle.js driveForce), so a lighter pull would stand still with its lights on.
   * Sideways is steer with a soft centre. Every value the stick makes is a multiple of 1/outStep, exact in binary, so a still thumb
   * gives the same ControlState tick after tick and a replay log stays short.
   */
  var TOUCH = {
    deadX: 0.12,
    deadY: 0.18,
    creep: 0.10,
    backCreep: 0.2,
    steerExpo: 0.35,
    footDead: 0.15,
    footFull: 0.7,
    rawStep: 64,
    outStep: 256
  };
  input.TOUCH = TOUCH;

  /** Keys the page must not act on: arrows and Space would scroll. */
  var CAPTURED = {
    ArrowUp: true, ArrowDown: true, ArrowLeft: true, ArrowRight: true, Space: true
  };

  /** Keys that act on the page and never enter ControlState. They are no one's "any key": pausing on a card must not skip it. */
  var UI_KEYS = { Escape: true, KeyP: true, KeyC: true, KeyV: true, KeyM: true, KeyN: true, KeyB: true };

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
  input.dropTaps = function () {
    dropTaps();
    dropTouchTaps();
  };

  // ---- The on-screen stick and buttons. ------------------------------------------------------------------------------------

  /** Where the stick's finger is, raw. (0, 0) is no finger. */
  var tStick = { x: 0, y: 0 };
  /** Buttons held now. */
  var tHeld = { space: false, horn: false, hazard: false, recover: false, interact: false };
  /** A press shows for the next sample however short it was, like startTap: a tap can fall between two ticks. Hold-to-act buttons
   * (hazard, recover) have none, because what they do needs them held. */
  var tTap = { space: false, horn: false, interact: false };

  function dropTouchTaps() {
    tTap.space = false;
    tTap.horn = false;
    tTap.interact = false;
  }

  function clamp1(v) {
    var n = +v;
    if (!(n === n)) return 0;
    return n < -1 ? -1 : (n > 1 ? 1 : n);
  }

  /** @returns {number} v on a grid of 1/step. */
  function snap(v, step) {
    var r = Math.round(v * step) / step;
    return r === 0 ? 0 : r;
  }

  /** @returns {number} An axis with its dead zone removed, rescaled to fill -1..1, as axis() does for the pad. Exactly 0 inside. */
  function deadZone(v, dead) {
    if (Math.abs(v) <= dead) return 0;
    return (v - (v > 0 ? dead : -dead)) / (1 - dead);
  }

  /** @returns {number} A touch-made float on the output grid. */
  function touchOut(v) {
    return snap(v, TOUCH.outStep);
  }

  /**
   * What the on-screen controls hold. js/ui/touch.js owns the fingers and calls these. The sim reads none of it directly: sample()
   * merges it into ControlState after the keys and the pad, so a replay of a touch drive is a replay like any other.
   */
  input.touch = {
    /**
     * The stick's finger, as an offset over the stick's radius.
     * @param {number} x Right is positive, -1..1.
     * @param {number} y Down is positive, -1..1.
     */
    stick: function (x, y) {
      tStick.x = snap(clamp1(x), TOUCH.rawStep);
      tStick.y = snap(clamp1(y), TOUCH.rawStep);
    },
    /**
     * A button pressed or let go. A press also shows for the next sample, so a quick tap is never lost.
     * @param {string} name 'space', 'horn', 'hazard', 'recover' or 'interact'.
     * @param {boolean} on True while a finger is on it.
     */
    hold: function (name, on) {
      if (!Object.prototype.hasOwnProperty.call(tHeld, name)) return;
      if (on && !tHeld[name] && Object.prototype.hasOwnProperty.call(tTap, name)) tTap[name] = true;
      tHeld[name] = !!on;
    },
    /** @param {string} name 'space', 'horn' or 'interact': one press, for the next sample only. */
    tap: function (name) {
      if (Object.prototype.hasOwnProperty.call(tTap, name)) tTap[name] = true;
    },
    /** Every finger up, every press forgotten. */
    release: function () {
      tStick.x = 0;
      tStick.y = 0;
      for (var k in tHeld) tHeld[k] = false;
      dropTouchTaps();
    },
    /** @returns {{x:number,y:number}} The stick as last reported, for the overlay's own drawing and for tests. */
    state: function () {
      return { x: tStick.x, y: tStick.y };
    }
  };

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
      case 'KeyN': if (TLV.audio && TLV.audio.radioNext) TLV.audio.radioNext(); break;
      case 'KeyB': if (TLV.audio && TLV.audio.radioToggle) TLV.audio.radioToggle(); break;
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

  /** A key released in another window never reports here, nor does a finger lifted there. */
  function onBlur() {
    held = {};
    dropTaps();
    input.touch.release();
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
    // The on-screen buttons. None of them is start or restart: the title and the end screen have buttons of their own, and the R
    // button is a tow and nothing else.
    var tSpace = tHeld.space || tTap.space;
    out.handbrake = out.handbrake || tSpace;
    out.sidestep = out.sidestep || tSpace;
    out.horn = out.horn || tHeld.horn || tTap.horn;
    out.interact = out.interact || tHeld.interact || tTap.interact;
    out.hazard = out.hazard || tHeld.hazard;
    out.recover = out.recover || tHeld.recover;
    dropTaps();
    dropTouchTaps();

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

    // The on-screen stick, last, as the pad's stick overrides the keys.
    var touched = false;
    if (tStick.x !== 0 || tStick.y !== 0) {
      var sx = deadZone(tStick.x, TOUCH.deadX);
      var go = deadZone(-tStick.y, TOUCH.deadY);
      var stop = deadZone(tStick.y, TOUCH.deadY);
      if (sx !== 0) {
        // Left is positive steer, as for the pad.
        steer = -touchOut(sx * (1 - TOUCH.steerExpo + TOUCH.steerExpo * Math.abs(sx)));
        touched = true;
      }
      if (go > 0) {
        throttle = Math.max(throttle, touchOut(TOUCH.creep + (1 - TOUCH.creep) * go * go));
        touched = true;
      }
      if (stop > 0) {
        brake = Math.max(brake, touchOut(TOUCH.backCreep + (1 - TOUCH.backCreep) * stop));
        touched = true;
      }
      var mag = Math.min(1, Math.sqrt(tStick.x * tStick.x + tStick.y * tStick.y));
      if (mag >= TOUCH.footDead) {
        // On foot, the finger's angle is the way to run, and footFull of the way out is a full run.
        var k = Math.min(1, (mag - TOUCH.footDead) / (TOUCH.footFull - TOUCH.footDead)) / mag;
        forward = -tStick.y * k;
        side = tStick.x * k;
        touched = true;
      }
    }

    out.throttle = throttle;
    out.brake = brake;
    out.steer = steer;
    footVector(out, forward, side);
    if (touched) {
      out.footX = touchOut(out.footX);
      out.footY = touchOut(out.footY);
    }
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
    input.touch.release();
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
