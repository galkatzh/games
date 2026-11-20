// js/net/net.js — WP-NET
// Carries a shared day between browsers (GAME_DESIGN 26). It joins a room by a short code, hands what arrives to TLV.game.versus,
// and sends what versus has queued. Nothing here knows what the messages mean.
//
// The transport is Trystero: peers find each other through public Nostr relays, then talk over a WebRTC data channel, browser to
// browser. Its script is fetched only when a room is opened, so a day alone still runs offline and from file://. ?net=local swaps in a
// BroadcastChannel, which joins the tabs of one browser with no network at all: that is how the browser tests run two drivers.
(function (TLV) {
  'use strict';

  var net = TLV.ns('net');

  /** What the relays see of this game: a name that says nothing about who is playing. */
  var APP_ID = 'sidurim-errands-tel-aviv';
  var VENDOR = 'vendor/trystero.min.js';
  /** Room codes are read aloud and typed, so the letters that pass for one another are left out. */
  var ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  var CODE_LEN = 4;

  var status = 'off';
  var room = '';
  var error = null;
  var link = null;
  /** Each join has its own number. An answer to a join that has since been given up finds another number here, and is dropped. */
  var joinNo = 0;
  var scripts = {};

  net.CODE_LEN = CODE_LEN;

  /** @returns {{status:string,room:string,error:?string}} status is 'off', 'joining', 'open' or 'failed'. */
  net.state = function () {
    return { status: status, room: room, error: error };
  };

  /** @returns {string} A new room code. */
  net.makeCode = function () {
    var out = '';
    for (var i = 0; i < CODE_LEN; i++) out += ALPHABET.charAt(Math.floor(Math.random() * ALPHABET.length));
    return out;
  };

  /**
   * @param {string} text Anything typed or pasted.
   * @returns {string} The letters of it that a room code can hold, at most a code's length.
   */
  net.cleanCode = function (text) {
    var out = '';
    var up = String(text === null || text === undefined ? '' : text).toUpperCase();
    for (var i = 0; i < up.length && out.length < CODE_LEN; i++) {
      if (ALPHABET.indexOf(up.charAt(i)) >= 0) out += up.charAt(i);
    }
    return out;
  };

  /** Loads a classic script once. */
  function loadScript(src) {
    if (scripts[src]) return scripts[src];
    scripts[src] = new Promise(function (resolve, reject) {
      var node = document.createElement('script');
      node.src = src;
      node.onload = function () { resolve(); };
      node.onerror = function () {
        delete scripts[src];
        reject(new Error('script'));
      };
      document.head.appendChild(node);
    });
    return scripts[src];
  }

  /**
   * Trystero over Nostr relays.
   * @param {string} name Room name.
   * @param {object} h Handlers: onOpen(selfId), onPeer(id), onLeave(id), onMessage(id, msg), onError(code).
   * @param {{relays:?string[]}} opts Relay URLs to use in place of the public ones.
   * @returns {Promise<{send:function(object,?string):void,leave:function():void}>} The link, once this peer has an id.
   */
  function trystero(name, h, opts) {
    return loadScript(VENDOR).then(function () {
      var lib = window.Trystero;
      if (!lib || typeof lib.joinRoom !== 'function') throw new Error('script');
      // A throwaway identity: nothing about the player is kept in the browser, and two tabs are two drivers.
      var config = { appId: APP_ID, identity: 'none' };
      if (opts.relays && opts.relays.length) config.relayConfig = { urls: opts.relays };
      var joined = lib.joinRoom(config, name);
      var action = joined.makeAction('m');
      action.onMessage(function (data, ctx) { h.onMessage(ctx.peerId, data); });
      joined.onPeerJoin(function (ctx) { h.onPeer(ctx.peerId); });
      joined.onPeerLeave(function (ctx) { h.onLeave(ctx.peerId); });
      joined.onError(function (err) { h.onError(err && err.code ? String(err.code) : 'error'); });
      return joined.getSelf().then(function (self) {
        h.onOpen(self.peerId);
        return {
          send: function (msg, to) {
            var sent = action.send(msg, to ? { target: to } : undefined);
            // A peer that has just gone cannot be sent to, and its leaving is reported on its own.
            if (sent && typeof sent.catch === 'function') sent.catch(function () {});
          },
          leave: function () {
            var left = joined.leave();
            if (left && typeof left.catch === 'function') left.catch(function () {});
          }
        };
      });
    });
  }

  /** The tabs of one browser, joined by a BroadcastChannel. No network, and no use between two machines. */
  function local(name, h) {
    if (typeof window.BroadcastChannel !== 'function') return Promise.reject(new Error('local'));
    var id = 'tab-' + Math.random().toString(36).slice(2, 10);
    var channel = new window.BroadcastChannel('sidurim-' + name);
    var known = {};
    function meet(from) {
      if (known[from]) return;
      known[from] = true;
      h.onPeer(from);
    }
    channel.onmessage = function (e) {
      var m = e.data;
      if (!m || m.from === id || (m.to && m.to !== id)) return;
      if (m.t === 'join') {
        channel.postMessage({ t: 'here', from: id, to: m.from });
        meet(m.from);
      } else if (m.t === 'here') {
        meet(m.from);
      } else if (m.t === 'leave') {
        if (known[m.from]) {
          delete known[m.from];
          h.onLeave(m.from);
        }
      } else if (m.t === 'msg' && known[m.from]) {
        h.onMessage(m.from, m.body);
      }
    };
    function leave() {
      channel.postMessage({ t: 'leave', from: id });
      channel.close();
      window.removeEventListener('pagehide', leave);
    }
    window.addEventListener('pagehide', leave);
    h.onOpen(id);
    channel.postMessage({ t: 'join', from: id });
    return Promise.resolve({
      send: function (msg, to) { channel.postMessage({ t: 'msg', from: id, to: to || null, body: msg }); },
      leave: leave
    });
  }

  net._transports = { trystero: trystero, local: local };

  /** @returns {?string[]} The relays named in the address, or null for the public ones. */
  function relays(S) {
    var raw = S.params.relay;
    if (!raw) return null;
    var list = String(raw).split(',').map(function (u) { return u.trim(); }).filter(function (u) { return /^wss?:\/\//.test(u); });
    return list.length ? list : null;
  }

  /**
   * Joins a room, leaving any other first.
   * @param {object} S Sim state.
   * @param {string} code Room code.
   * @returns {boolean} False for a code that is not one.
   */
  net.open = function (S, code) {
    var clean = net.cleanCode(code);
    if (clean.length !== CODE_LEN) return false;
    net.close(S);
    var versus = TLV.game.versus;
    var mine = ++joinNo;
    status = 'joining';
    room = clean;
    error = null;
    function live() {
      return mine === joinNo;
    }
    var handlers = {
      onOpen: function (selfId) {
        if (!live()) return;
        status = 'open';
        versus.attach(S, selfId);
      },
      onPeer: function (id) { if (live()) versus.peerJoined(S, id); },
      onLeave: function (id) { if (live()) versus.peerLeft(S, id); },
      onMessage: function (id, msg) { if (live()) versus.receive(S, id, msg); },
      onError: function (code) {
        // Trystero reports each peer that would not connect. Only the relays all failing leaves the room unusable.
        if (!live() || code !== 'relay-failed') return;
        status = 'failed';
        error = code;
      }
    };
    var kind = S.params.net === 'local' ? 'local' : 'trystero';
    // The map is part of the room: a board is doors of one map, and means nothing on another.
    var name = clean + '-' + String(S.world ? S.world.id : 'none') + '-' + versus.PROTO;
    net._transports[kind](name, handlers, { relays: relays(S) }).then(function (made) {
      if (!live()) {
        made.leave();
        return;
      }
      link = made;
    }, function (e) {
      if (!live()) return;
      status = 'failed';
      error = e && e.message === 'script' ? 'script' : (e && e.message === 'local' ? 'local' : 'join');
    });
    return true;
  };

  /**
   * Leaves the room.
   * @param {object} S Sim state.
   */
  net.close = function (S) {
    joinNo++;
    if (link) link.leave();
    link = null;
    status = 'off';
    room = '';
    error = null;
    TLV.game.versus.detach(S);
  };

  /**
   * Sends what the sim has queued. Called once a frame.
   * @param {object} S Sim state.
   */
  net.frame = function (S) {
    // Between this peer getting its id and the link being handed over, what is queued waits.
    if (!link || !S.versus || !S.versus.outbox.length) return;
    var out = TLV.game.versus.drain(S);
    for (var i = 0; i < out.length; i++) link.send(out[i].msg, out[i].to);
  };
})(window.TLV);
