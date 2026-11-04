// js/core/events.js — WP-CORE
// Per-sim event bus (ARCHITECTURE 11). Sim listeners run synchronously inside emit. Frame consumers read a capped ring
// through drain, which stays off until enableDrain, so headless runs buffer nothing.
(function (TLV) {
  'use strict';

  var events = TLV.ns('events');

  /** Drain ring size. A power of two, so the index wraps with a mask. */
  var CAPACITY = 2048;
  var MASK = CAPACITY - 1;

  /** One bus. */
  function Bus() {
    this._listeners = new Map();
    this._buffering = false;
    this._names = null;
    this._payloads = null;
    this._head = 0;
    this._count = 0;
  }

  /**
   * Subscribes a sim listener. Lists are copied on write, so subscribing during an emit never disturbs that emit.
   * @param {string} name Event name.
   * @param {function(*):void} fn Called synchronously in subscription order.
   */
  Bus.prototype.on = function (name, fn) {
    var list = this._listeners.get(name);
    this._listeners.set(name, list ? list.concat(fn) : [fn]);
  };

  /**
   * Removes one subscription.
   * @param {string} name Event name.
   * @param {function(*):void} fn The function given to on.
   */
  Bus.prototype.off = function (name, fn) {
    var list = this._listeners.get(name);
    if (!list) return;
    var i = list.indexOf(fn);
    if (i < 0) return;
    var next = list.slice();
    next.splice(i, 1);
    this._listeners.set(name, next);
  };

  /**
   * Buffers an event for frame consumers if draining is on, then delivers it to sim listeners at once. Buffering comes first
   * because a listener may emit: a cause must reach the drain before the effects its listeners emit.
   * @param {string} name Event name.
   * @param {object} [payload] Freshly allocated object. It is read again at drain, so never reuse one.
   */
  Bus.prototype.emit = function (name, payload) {
    if (this._buffering) {
      var at = (this._head + this._count) & MASK;
      this._names[at] = name;
      this._payloads[at] = payload;
      if (this._count < CAPACITY) this._count++;
      else this._head = (this._head + 1) & MASK;
    }
    var list = this._listeners.get(name);
    if (list) {
      for (var i = 0; i < list.length; i++) list[i](payload);
    }
  };

  /** Turns on buffering for frame consumers. TLV.ui.init calls this. */
  Bus.prototype.enableDrain = function () {
    if (this._buffering) return;
    this._buffering = true;
    this._names = new Array(CAPACITY);
    this._payloads = new Array(CAPACITY);
  };

  /**
   * Hands every event since the last drain to fn, oldest first. An event is consumed before fn sees it, so a throwing
   * consumer can never replay one. Sim listeners must never use this.
   * @param {function(string, *):void} fn Receives (name, payload).
   */
  Bus.prototype.drain = function (fn) {
    while (this._count > 0) {
      var at = this._head;
      var name = this._names[at];
      var payload = this._payloads[at];
      this._payloads[at] = null;
      this._head = (at + 1) & MASK;
      this._count--;
      fn(name, payload);
    }
  };

  /**
   * Creates a bus.
   * @returns {Bus} New bus.
   */
  events.createBus = function () {
    return new Bus();
  };
})(window.TLV);
