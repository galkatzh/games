// tests/e2e/lib/stub_browser.js — WP-CORE
// Stands in for WP-RENDER, WP-UI and js/input/input.js in a throwaway tree. See stub_sim.js.
(function (TLV) {
  'use strict';

  function boot(step) {
    (TLV.bootLog = TLV.bootLog || []).push(step);
  }

  function registered(pkg) {
    (TLV.registerLog = TLV.registerLog || []).push(pkg);
    boot('register ' + pkg);
  }

  var render = TLV.ns('render');
  render.frames = 0;
  render.inits = 0;
  render.register = function () { registered('render'); };
  render.init = function (canvas, S) {
    boot('render.init');
    render.inits++;
    render.args = { target: canvas && canvas.id, currentSim: S === TLV.app.S };
  };
  render.frame = function () {
    if (render.frames === 0) boot('first frame');
    render.frames++;
  };
  render.dispose = function () {};
  render.resize = function () {};

  var ui = TLV.ns('ui');
  ui.frames = 0;
  ui.events = [];
  ui.register = function () { registered('ui'); };
  ui.init = function (root, S) {
    boot('ui.init');
    ui.args = { target: root && root.id, currentSim: S === TLV.app.S };
    S.bus.enableDrain();
  };
  ui.frame = function (S) {
    ui.frames++;
    S.bus.drain(function (name) { ui.events.push(name); });
  };
  // One box, replaced on each call: the loader's call carries everything shown so far.
  ui.showError = function (text) {
    var box = document.getElementById('ui-error');
    if (!box) {
      box = document.createElement('div');
      box.id = 'ui-error';
      document.getElementById('ui-root').appendChild(box);
    }
    box.textContent = text;
  };

  var input = TLV.ns('input');
  input.init = function (win, S) {
    boot('input.init');
    input.bound = S;
    input.args = { target: win === window, currentSim: S === TLV.app.S };
  };
})(window.TLV);
