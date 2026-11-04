// js/render/rearview.js — WP-RENDER (RENDER-ACTORS)
// The rear-view strip: the same scene from over the player's roof, looking back. Tailgating is a core threat, and a car 1.4 m behind
// is invisible to a chase camera that sits in front of it, so this strip is how the player sees it (GAME_DESIGN 18). Cars draw solid
// here even while the main view ghosts them. Writes nothing to S.
(function (TLV) {
  'use strict';

  var rear = TLV.ns('render.rearview');

  var Q = {
    w: 256, h: 64,           // GAME_DESIGN 18
    marginRight: 16,
    marginTop: 74,           // below the No-Claims bar at the top right, at 720p
    marginTopK: 0.103,       // the bar scales with the window, about 102 px at 1080p (WP-UI report), so the strip must too
    fovDeg: 27,
    near: 0.6,
    far: 110,
    carZ: 1.62,              // just over the rear of the player's roof, so the car itself stays out of the shot
    carBack: 0.42,           // metres forward of the rear bumper
    footZ: 1.75,
    lookBack: 24,
    lookZ: 0.7,
    holdS: 1.6,              // stays up this long after the car behind has gone
    border: 2
  };

  /** Phases with someone at the wheel. */
  var LIVE = { DRIVE: true, SEARCH: true, HOLD: true, PAYOUT: true, BLOCKED: true };

  var R = null;

  /** @param {THREE.Scene} scene Scene. @param {object} S Sim state. */
  rear.init = function (scene, S) {
    var cam = new THREE.PerspectiveCamera(Q.fovDeg, Q.w / Q.h, Q.near, Q.far);
    R = { cam: cam, pref: 'auto', hold: 0, shown: false, box: null, look: new THREE.Vector3(), top: -1 };
    rear._makeFrame();
  };

  /** A thin frame and a label, on top of the canvas. The strip itself is drawn in GL through the renderer. */
  rear._makeFrame = function () {
    if (typeof document === 'undefined') return;
    var box = document.createElement('div');
    box.id = 'rearview-frame';
    box.style.cssText = 'position:fixed;pointer-events:none;display:none;box-sizing:content-box;z-index:5;' +
      'border:' + Q.border + 'px solid #151618;border-radius:6px;box-shadow:0 2px 8px rgba(0,0,0,.45);' +
      'width:' + Q.w + 'px;height:' + Q.h + 'px;right:' + (Q.marginRight - Q.border) + 'px';
    document.body.appendChild(box);
    R.box = box;
  };

  /** @returns {boolean} True when the strip should be up this frame. */
  function wanted(S, dt) {
    var g = S.game;
    var chase = g && g.knife && g.knife.stage === 'CHASE';
    var cam = TLV.render.camera;
    if (cam && cam.tailgated && cam.tailgated()) R.hold = Q.holdS;
    else R.hold = Math.max(0, R.hold - dt);
    if (chase) return true;
    // Never over a title, a phone card or an end screen.
    if (!g || !LIVE[g.phase]) return false;
    if (R.pref === 'on') return true;
    if (R.pref === 'off') return false;
    return R.hold > 0;
  }

  /**
   * The strip looks back along this, so what stands well ahead of it can be left out of the pass.
   * @param {object} S Sim state.
   * @returns {number} Heading of the car, or of the camera behind the runner.
   */
  rear.heading = function (S) {
    var P = S.player;
    if (P.mode === 'FOOT' && P.foot && P.foot.active) return TLV.render.camera ? TLV.render.camera.yaw() : P.foot.h;
    return (P.veh || S.vehicles[0]).h;
  };

  /** Places the mirror camera over the car, or over the runner, looking back along them. */
  function place(S, alpha) {
    var M = TLV.math;
    var P = S.player;
    var veh = P.veh || S.vehicles[0];
    var onFoot = P.mode === 'FOOT' && P.foot && P.foot.active;
    var x, y, h, z;
    if (onFoot) {
      var f = P.foot;
      x = f.px + (f.x - f.px) * alpha;
      y = f.py + (f.y - f.py) * alpha;
      // The runner's own heading twitches, so the strip follows the main camera.
      var yaw = TLV.render.camera ? TLV.render.camera.yaw() : f.h;
      h = yaw;
      z = Q.footZ;
    } else {
      h = veh.ph + M.wrapPi(veh.h - veh.ph) * alpha;
      var back = veh.length / 2 - Q.carBack;
      x = veh.px + (veh.x - veh.px) * alpha - Math.cos(h) * back;
      y = veh.py + (veh.y - veh.py) * alpha - Math.sin(h) * back;
      z = Q.carZ;
    }
    TLV.render.coords.toThree(x, y, z, R.cam.position);
    TLV.render.coords.toThree(x - Math.cos(h) * Q.lookBack, y - Math.sin(h) * Q.lookBack, Q.lookZ, R.look);
    R.cam.lookAt(R.look);
    R.cam.updateMatrixWorld();
  }

  /**
   * Draws the strip. Runs after the main pass, so it is on top.
   * @param {object} S Sim state.
   * @param {number} alpha Tick interpolation.
   * @param {number} dtReal Seconds since the last frame.
   */
  rear.frame = function (S, alpha, dtReal) {
    if (!R) return;
    var on = wanted(S, Math.min(dtReal, 0.1));
    var top = Math.round(Math.max(Q.marginTop, window.innerHeight * Q.marginTopK));
    if (R.box) {
      if (on !== R.shown) R.box.style.display = on ? 'block' : 'none';
      if (top !== R.top) R.box.style.top = (top - Q.border) + 'px';
    }
    R.top = top;
    R.shown = on;
    if (!on || !TLV.render.renderScene) return;
    place(S, alpha);
    var vehicles = TLV.render.vehicles, people = TLV.render.people;
    if (vehicles && vehicles.solidPass) vehicles.solidPass(true);
    if (people && people.solidPass) people.solidPass(true);
    if (TLV.render.effects && TLV.render.effects.mirrorPass) TLV.render.effects.mirrorPass(true);
    TLV.render.renderScene(R.cam, { x: window.innerWidth - Q.marginRight - Q.w, y: top, w: Q.w, h: Q.h });
    if (vehicles && vehicles.solidPass) vehicles.solidPass(false);
    if (people && people.solidPass) people.solidPass(false);
    if (TLV.render.effects && TLV.render.effects.mirrorPass) TLV.render.effects.mirrorPass(false);
  };

  /** Events carry nothing the strip needs. Present for the seam. */
  rear.onEvent = function (name) {
    if (R && name === 'run.start') R.hold = 0;
  };

  /** V and RB. Hides the strip if it is up, and pins it if it is not. */
  rear.toggle = function () {
    if (!R) return;
    R.pref = R.shown ? 'off' : 'on';
  };

  /** @returns {?object} State, for tests. */
  rear._state = function () {
    return R ? { pref: R.pref, shown: R.shown, hold: R.hold, rect: { right: Q.marginRight, top: R.top, w: Q.w, h: Q.h } } : null;
  };

  /** Removes the frame. */
  rear.dispose = function () {
    if (!R) return;
    if (R.box && R.box.parentNode) R.box.parentNode.removeChild(R.box);
    R = null;
  };
})(window.TLV);
