// js/sim/game/versus.js — WP-GAME
// A day shared with other drivers (GAME_DESIGN 26). Everyone has the same board of errands at the same doors. Each driver picks one,
// seeing what it is worth from where they stand, and an errand one driver has done is gone for the rest. Whoever ends the day with the
// most money has won it.
//
// Every driver runs a whole sim of their own: their own traffic, their own people, their own clock. Only the board is shared, and where
// the others are. Nothing here talks to a network. What is to be sent goes on an outbox, and what arrives is handed to versus.receive,
// which keeps it until the next tick. The browser's TLV.net carries the two, and a test joins two sims with a loop.
(function (TLV) {
  'use strict';

  var versus = TLV.ns('game.versus');

  /** Peers with another number here do not share a board with this build. */
  var PROTO = 1;
  versus.PROTO = PROTO;

  /** The kinds of message, and nothing else is read. */
  var KINDS = { hello: 1, go: 1, start: 1, pick: 1, done: 1, state: 1, again: 1 };

  function newState() {
    return {
      // on: a shared day is being played, or has just ended. linked: this sim is in a room, with or without company.
      on: false, linked: false, self: '',
      peers: {}, inbox: [], outbox: [],
      round: 0, board: null, startTick: 0,
      // pick: the row this driver is on the way to. count: errands of the board this driver has done. open: the board is up for a pick.
      pick: -1, count: 0, open: false, ready: false,
      options: null, optionsT: 0, sendT: 0, unlocked: false
    };
  }

  /** @returns {object} S.versus, made on first use. It outlives a run: S.game does not. */
  function st(S) {
    return S.versus || (S.versus = newState());
  }

  /** @returns {boolean} True while a shared day is on: the board decides what comes next, not the plan. */
  versus.active = function (S) {
    return !!S.versus && S.versus.on;
  };

  /** Queues a message. to is a peer id, or null for everyone in the room. */
  function send(S, msg, to) {
    var v = st(S);
    if (!v.linked) return;
    v.outbox.push({ to: to || null, msg: msg });
  }

  /** @returns {string[]} Every driver in the room, this one included, in an order all of them agree on. */
  function everyone(S) {
    var v = st(S);
    var ids = Object.keys(v.peers).filter(function (id) { return v.peers[id].proto === PROTO; });
    ids.push(v.self);
    ids.sort();
    return ids;
  }

  /**
   * @returns {string} The id of the one driver who deals the next board: the lowest id, so nobody has to be told. With a day on it is
   * the lowest among those who are in it, because someone who came into the room meanwhile is in no position to deal.
   */
  function dealer(S) {
    var v = st(S);
    var ids = Object.keys(v.peers).filter(function (id) {
      return v.peers[id].proto === PROTO && (!v.on || v.peers[id].playing);
    });
    ids.push(v.self);
    ids.sort();
    return ids[0];
  }

  function isHost(S) {
    return dealer(S) === st(S).self;
  }

  /** @returns {boolean} True when another driver in the room is in the middle of a day. */
  function othersOut(S) {
    var v = st(S);
    for (var id in v.peers) {
      if (v.peers[id].busy) return true;
    }
    return false;
  }

  function newPeer() {
    return {
      proto: 0, x: 0, y: 0, h: 0, v: 0, px: 0, py: 0, ph: 0, at: -1, seen: false,
      money: 0, count: 0, pick: -1, ended: false, reason: null, ready: false,
      // playing: in this sim's round, by their own report. busy: out on a day, this one or another.
      playing: false, busy: false
    };
  }

  // ---- The room. Called by whatever carries the messages. -----------------------------------------------------------------

  /**
   * This sim is in a room.
   * @param {object} S Sim state.
   * @param {string} selfId This driver's id in it.
   */
  versus.attach = function (S, selfId) {
    var v = st(S);
    v.linked = true;
    v.self = String(selfId);
    v.peers = {};
    v.outbox.length = 0;
  };

  /** This sim has left its room. A day under way goes on with the board as it stands, alone. */
  versus.detach = function (S) {
    var v = st(S);
    v.linked = false;
    v.peers = {};
    v.outbox.length = 0;
    if (S.game.phase === 'TITLE') v.on = false;
  };

  /**
   * Another driver came into the room.
   * @param {object} S Sim state.
   * @param {string} id Their id.
   */
  versus.peerJoined = function (S, id) {
    var v = st(S);
    if (!v.linked || v.peers[id]) return;
    v.peers[id] = newPeer();
    send(S, { k: 'hello', v: PROTO }, id);
    S.bus.emit('versus.peer', { id: id, joined: true });
  };

  /** A driver left the room. What they did on the board stays done. */
  versus.peerLeft = function (S, id) {
    var v = st(S);
    if (!v.peers[id]) return;
    delete v.peers[id];
    S.bus.emit('versus.peer', { id: id, joined: false });
  };

  /**
   * A message arrived. It is kept for the next tick, so nothing changes in the middle of one.
   * @param {object} S Sim state.
   * @param {string} from The sender's id.
   * @param {object} msg The message.
   */
  versus.receive = function (S, from, msg) {
    var v = st(S);
    if (!v.linked || !msg || typeof msg !== 'object' || !KINDS[msg.k]) return;
    var who = String(from);
    if (msg.k === 'state') {
      // Only the newest report of a driver means anything. A tab in the background steps about once a second, and a hidden one not at
      // all, so reports pile up here: each takes the last one's place, and the inbox is left for what must not be lost.
      for (var i = v.inbox.length - 1; i >= 0; i--) {
        if (v.inbox[i].from === who && v.inbox[i].msg.k === 'state') {
          v.inbox[i].msg = msg;
          return;
        }
      }
    }
    if (v.inbox.length >= TLV.tune.game.versusInboxMax) return;
    v.inbox.push({ from: who, msg: msg });
  };

  /**
   * Takes what is waiting to be sent.
   * @param {object} S Sim state.
   * @returns {Array<{to:?string,msg:object}>} Messages, oldest first. The outbox is empty afterwards.
   */
  versus.drain = function (S) {
    var v = st(S);
    return v.outbox.splice(0, v.outbox.length);
  };

  // ---- The board. ---------------------------------------------------------------------------------------------------------

  /** @returns {number} The place in a day an errand of the board takes: the gan is the last errand, as it is on any day. */
  function indexFor(S, row) {
    var T = TLV.tune.game;
    var last = T.legs.length - 1;
    return row.finale ? last : Math.min(st(S).count, last - 1);
  }

  /** @returns {boolean} True when a row can be picked by anyone: not done, and not the gan while other errands are open. */
  function pickable(board, row) {
    if (row.by !== null) return false;
    if (!row.finale) return true;
    for (var i = 0; i < board.length; i++) {
      if (!board[i].finale && board[i].by === null) return false;
    }
    return true;
  }

  /** @returns {number} Rows nobody has done. */
  function openCount(board) {
    var n = 0;
    for (var i = 0; i < board.length; i++) n += board[i].by === null ? 1 : 0;
    return n;
  }

  /** @returns {number[]} A shuffled copy, drawn from the game stream. */
  function shuffled(rng, list) {
    var a = list.slice();
    for (var i = a.length - 1; i > 0; i--) {
      var j = rng.int(i + 1);
      var t = a[i];
      a[i] = a[j];
      a[j] = t;
    }
    return a;
  }

  /**
   * Deals a board: up to versusTasks errands and the gan, each at a door of its own, at a spread of distances from the spawn.
   * @param {object} S Sim state.
   * @returns {object[]} Rows, as errands._boardRow makes them. Empty on a map nothing can be bound on.
   */
  versus._deal = function (S) {
    var T = TLV.tune.game;
    var errands = TLV.game.errands;
    var from = errands.spawnPoint(S);
    if (!from) return [];
    var defs = errands.defs();
    var plain = shuffled(S.rng.game, defs.filter(function (d) { return d.tier !== 'finale'; }));
    // Milk is the first errand of any day, and it is on every board.
    plain.sort(function (a, b) { return (b.id === 'milk' ? 1 : 0) - (a.id === 'milk' ? 1 : 0); });
    var finale = defs.filter(function (d) { return d.tier === 'finale'; })[0] || null;
    var taken = {};
    var rows = [];
    for (var i = 0; i < plain.length && rows.length < T.versusTasks; i++) {
      var row = errands._boardRow(S, plain[i], from, T.versusLegs[rows.length % T.versusLegs.length], taken);
      if (row) rows.push(row);
    }
    if (finale) {
      var gan = errands._boardRow(S, finale, from, T.versusGanLegM, taken);
      if (gan) rows.push(gan);
    }
    return rows;
  };

  /** @returns {boolean} True for rows a peer could have sent that this build can stand up. */
  function validRows(rows) {
    if (!Array.isArray(rows) || !rows.length || rows.length > 32) return false;
    for (var i = 0; i < rows.length; i++) {
      var r = rows[i];
      if (!r || typeof r.defId !== 'string' || !TLV.game.errands._def(r.defId)) return false;
      if (!Number.isFinite(r.x) || !Number.isFinite(r.y) || !Number.isInteger(r.poi) || !Number.isInteger(r.edge)) return false;
      if (r.name !== null && r.name !== undefined && (typeof r.name.he !== 'string' || typeof r.name.en !== 'string')) return false;
    }
    return true;
  }

  /** Called by flow.startRun for a shared day, with the car at the spawn and the phase at CARD. */
  versus._begin = function (S, deal) {
    var v = st(S);
    var errands = TLV.game.errands;
    v.on = true;
    v.round = deal.round;
    v.startTick = S.tick;
    v.pick = -1;
    v.count = 0;
    v.ready = false;
    v.unlocked = false;
    v.sendT = 0;
    v.board = deal.rows.map(function (r, i) {
      return {
        id: i, defId: r.defId, poi: r.poi, x: r.x, y: r.y, edge: r.edge, name: r.name || null,
        finale: errands._def(r.defId).tier === 'finale', by: null, t: 0, _e: null, _award: 0
      };
    });
    Object.keys(v.peers).forEach(function (id) {
      var p = v.peers[id];
      p.money = 0;
      p.count = 0;
      p.pick = -1;
      p.ended = false;
      p.reason = null;
      p.ready = false;
      p.playing = false;
    });
    S.bus.emit('versus.start', { round: v.round, tasks: v.board.length });
    openBoard(S);
  };

  /** What each open row is worth from a pose: the road there, the pay for a tidy park, and the seconds it puts on the clock. */
  function price(S, from) {
    var v = st(S);
    var T = TLV.tune.game;
    var errands = TLV.game.errands;
    var g = S.game;
    var scale = T.difficulty[g._g.runDifficulty].awardScale;
    return v.board.map(function (row) {
      var o = { id: row.id, state: 'open', dist: 0, pay: 0, award: 0, heading: 0 };
      if (row.by !== null) {
        o.state = row.by === v.self ? 'mine' : 'theirs';
        return o;
      }
      if (!pickable(v.board, row)) {
        o.state = 'locked';
        return o;
      }
      var found = errands._rowRoute(S, row, from);
      if (!found) {
        o.state = 'noRoad';
        return o;
      }
      o.dist = found.route.len;
      o.pay = Math.round((T.payBase + T.payPerM * o.dist) * T.qualityP.GOOD);
      o.award = (o.dist / T.awardDiv + T.awardBase) * (1 - T.kStep * indexFor(S, row)) * scale;
      return o;
    });
  }

  /** @returns {{x:number,y:number,h:number}} Where a pick would start from: the lane the car pulls out to, or where it is. */
  function pickFrom(S) {
    var g = S.game;
    if (g.phase === 'CARD') return g._g.from;
    var veh = S.player.veh;
    return { x: veh.x, y: veh.y, h: veh.h };
  }

  function openBoard(S) {
    var v = st(S);
    v.open = true;
    v.options = price(S, pickFrom(S));
    v.optionsT = TLV.tune.game.versusRefreshS;
  }

  /**
   * The board as a screen shows it.
   * @param {object} S Sim state.
   * @returns {?object[]} One entry per row: { id, defId, name, text, finale, x, y, picked, state, dist, pay, award, heading, by }. state is 'open', 'locked'
   * (the gan, while other errands are open), 'noRoad', 'mine' or 'theirs'. heading counts the other drivers on their way there. Null
   * with no shared day.
   */
  versus.board = function (S) {
    var v = st(S);
    if (!v.on || !v.board) return null;
    var errands = TLV.game.errands;
    var priced = v.options || price(S, pickFrom(S));
    return v.board.map(function (row, i) {
      var o = priced[i];
      var heading = 0;
      Object.keys(v.peers).forEach(function (id) {
        if (v.peers[id].pick === row.id && !v.peers[id].ended) heading++;
      });
      return {
        id: row.id, defId: row.defId, name: errands._rowName(S, row), text: errands._rowText(S, row), finale: row.finale, x: row.x, y: row.y,
        state: o.state, dist: o.dist, pay: o.pay, award: o.award, heading: heading, by: row.by, picked: v.pick === row.id
      };
    });
  };

  /**
   * The shared day in a few numbers, for a HUD.
   * @param {object} S Sim state.
   * @returns {object} { on, linked, self, host, open, pick, count, left, total, round, ready, peers: [{ id, x, y, h, money, count, pick,
   * ended, reason, ready, seen, compatible, mismatch, playing, busy }] }. compatible is true once a peer has said it runs this build's
   * board, and mismatch once it has said it runs another. playing means in this driver's round, and busy out on a day of any round:
   * someone who comes into a room with a day on sees the others busy, and is dealt in when the next one starts.
   */
  versus.view = function (S) {
    var v = st(S);
    var peers = Object.keys(v.peers).sort().map(function (id) {
      var p = v.peers[id];
      return {
        id: id, x: p.x, y: p.y, h: p.h, v: p.v, px: p.px, py: p.py, ph: p.ph, at: p.at, money: p.money, count: p.count, pick: p.pick,
        ended: p.ended, reason: p.reason, ready: p.ready, seen: p.seen, compatible: p.proto === PROTO, mismatch: p.proto === -1,
        playing: p.playing, busy: p.busy
      };
    });
    return {
      on: v.on, linked: v.linked, self: v.self, host: v.linked && isHost(S), open: v.on && v.open, pick: v.pick, count: v.count,
      left: v.board ? openCount(v.board) : 0, total: v.board ? v.board.length : 0, round: v.round, ready: v.ready, peers: peers
    };
  };

  // ---- What a driver does. ------------------------------------------------------------------------------------------------

  /**
   * Picks a row of the board. Only while the board is up.
   * @param {object} S Sim state.
   * @param {number} id Row.
   * @returns {boolean} False for a row that cannot be picked, or cannot be reached from here.
   */
  versus.pick = function (S, id) {
    var v = st(S);
    var g = S.game;
    if (!v.on || !v.open || !v.board || g.phase === 'RUN_END' || g.phase === 'TITLE') return false;
    var row = v.board[id];
    if (!row || !pickable(v.board, row)) return false;
    if (g.errand) {
      // Choosing again on the way somewhere: the same row is no change, and any other lets the first go.
      if (v.pick === id) {
        v.open = false;
        return true;
      }
      TLV.game.flow._dropErrand(S);
    }
    var from = pickFrom(S);
    g._g.from = { x: from.x, y: from.y, h: from.h };
    var index = indexFor(S, row);
    var e = TLV.game.errands._fromRow(S, row, index, g._g.from);
    if (!e) return false;
    v.pick = id;
    v.open = false;
    v.options = null;
    TLV.game.flow._startBoardErrand(S, e, index);
    send(S, { k: 'pick', r: v.round, task: id });
    S.bus.emit('versus.pick', { task: id, defId: row.defId });
    return true;
  };

  /**
   * Puts the board up while driving to an errand, to choose again. Nothing is given up until another row is picked.
   * @param {object} S Sim state.
   * @returns {boolean} False when this is no moment for it.
   */
  versus.reconsider = function (S) {
    var v = st(S);
    var g = S.game;
    if (!v.on || v.open || !g.errand || (g.phase !== 'DRIVE' && g.phase !== 'SEARCH')) return false;
    openBoard(S);
    return true;
  };

  /** Takes the board down again, with the errand in hand kept. Without one it stays up: there is nowhere else to go. */
  versus.keep = function (S) {
    var v = st(S);
    if (!v.on || !v.open || !S.game.errand) return false;
    v.open = false;
    v.options = null;
    return true;
  };

  /**
   * Asks for a shared day to start, from the title or after one has ended. The driver who deals does it, and any other asks them to.
   * @param {object} S Sim state.
   * @returns {boolean} False outside a room, alone in one, or with a day still on.
   */
  versus.requestStart = function (S) {
    var v = st(S);
    var phase = S.game.phase;
    if (!v.linked || everyone(S).length < 2 || (phase !== 'TITLE' && phase !== 'RUN_END')) return false;
    // The others are out on a day. A board dealt now would reach nobody: the next one comes when they have ended theirs.
    if (othersOut(S)) return false;
    if (isHost(S)) return startRound(S);
    send(S, { k: 'go' }, dealer(S));
    return true;
  };

  /** Deals and starts a round, here and for everyone in the room. */
  function startRound(S) {
    var v = st(S);
    var rows = versus._deal(S);
    if (!rows.length) return false;
    var deal = { k: 'start', v: PROTO, round: v.round + 1, rows: rows, difficulty: S.game.difficulty };
    send(S, deal);
    TLV.game.flow.startRun(S, { versus: { round: deal.round, rows: rows } });
    return true;
  }

  /** The restart key at the end of a shared day: ready for another. Alone, another day is simply a day. */
  versus._again = function (S) {
    var v = st(S);
    if (!Object.keys(v.peers).length) {
      v.on = false;
      v.board = null;
      TLV.game.flow.startRun(S);
      return;
    }
    if (v.ready) return;
    v.ready = true;
    send(S, { k: 'again', r: v.round });
    S.bus.emit('versus.ready', { self: true });
    maybeAgain(S);
  };

  /** The dealer starts the next round once every driver in the room has ended their day and asked for another. */
  function maybeAgain(S) {
    var v = st(S);
    if (!v.on || !v.ready || S.game.phase !== 'RUN_END' || !isHost(S)) return;
    var ids = Object.keys(v.peers);
    for (var i = 0; i < ids.length; i++) {
      var p = v.peers[ids[i]];
      // Only those who shared this day are waited for. Anyone else in the room is dealt in with the rest.
      if (p.proto === PROTO && p.playing && (!p.ended || !p.ready)) return;
    }
    startRound(S);
  }

  // ---- The day. -----------------------------------------------------------------------------------------------------------

  /** A row is done. @returns {boolean} True when that changed the board. */
  function mark(S, row, by, t) {
    var v = st(S);
    row.by = by;
    row.t = t;
    v.options = null;
    S.bus.emit('versus.done', { task: row.id, defId: row.defId, by: by, mine: by === v.self });
    if (!v.unlocked) {
      var gan = null;
      for (var i = 0; i < v.board.length; i++) if (v.board[i].finale) gan = v.board[i];
      if (gan && pickable(v.board, gan)) {
        v.unlocked = true;
        S.bus.emit('versus.unlock', { task: gan.id });
      }
    }
    return true;
  }

  /** This driver parked at a row another had parked at first. What it paid is taken back, and it never counted. */
  function undo(S, row) {
    var v = st(S);
    var g = S.game;
    var e = row._e;
    if (e) {
      // Paid already, it is taken back. With the pay still to come, after an encounter, it comes as nothing: see score.computePay.
      if (e.pay !== null) {
        g.money -= e.pay;
        g.stats.errandsDone = Math.max(0, g.stats.errandsDone - 1);
      }
      e._void = true;
    }
    g.clock = Math.max(0, g.clock - row._award);
    v.count = Math.max(0, v.count - 1);
    row._e = null;
    row._award = 0;
    S.bus.emit('versus.void', { task: row.id, defId: row.defId });
  }

  /** @returns {boolean} True when (t, id) comes before (u, other): the park sooner into its driver's day, and the lower id when level. */
  function first(t, id, u, other) {
    return t < u || (t === u && id < other);
  }

  /** Another driver's park. */
  function onDone(S, from, m) {
    var v = st(S);
    var g = S.game;
    if (!v.on || m.r !== v.round || !v.board) return;
    var row = v.board[m.task];
    var t = Number(m.t);
    if (!row || !Number.isFinite(t)) return;
    if (row.by === v.self) {
      // Both parked before either heard of the other. Both sims settle it the same way, so exactly one of them keeps it.
      if (!first(t, from, row.t, v.self)) return;
      undo(S, row);
    } else if (row.by !== null && !first(t, from, row.t, row.by)) {
      return;
    }
    mark(S, row, from, t);
    if (v.peers[from] && v.peers[from].pick === row.id) v.peers[from].pick = -1;
    if (v.pick === row.id) {
      v.pick = -1;
      if (g.errand && (g.phase === 'DRIVE' || g.phase === 'SEARCH' || g.phase === 'HOLD' || g.phase === 'CARD')) {
        TLV.game.flow._dropErrand(S);
        S.bus.emit('versus.taken', { task: row.id, defId: row.defId, by: from });
      }
    }
    settle(S);
  }

  /** After the board changed: the day is over when nothing is left, and a driver with nowhere to go gets the board. */
  function settle(S) {
    var v = st(S);
    var g = S.game;
    if (g.phase === 'RUN_END' || g.phase === 'TITLE') return;
    var waiting = !g.errand && (g.phase === 'CARD' || g.phase === 'DRIVE');
    if (openCount(v.board) === 0) {
      // A driver still at the kerb with their own last park sees it paid first: flow comes back through _errandDone.
      if (waiting) TLV.game.flow.endRun(S, 'DONE');
      return;
    }
    if (waiting || v.open) openBoard(S);
  }

  /** Called by flow when a board errand's PAYOUT or RESOLVE is over, with the errand cleared and the phase at CARD. */
  versus._errandDone = function (S) {
    settle(S);
  };

  function onParked(S, p) {
    var v = st(S);
    var g = S.game;
    if (!v.on || v.pick < 0 || !v.board) return;
    var row = v.board[v.pick];
    v.pick = -1;
    if (row.by !== null) {
      // Their park was heard of in the tick this one filled its bar. It was theirs first.
      row._e = g.errand;
      row._award = p.award || 0;
      v.count++;
      undo(S, row);
      return;
    }
    row._e = g.errand;
    row._award = p.award || 0;
    v.count++;
    // Each driver's own ticks since their day began: whole numbers, so two sims never disagree over which is the smaller. The day
    // begins a message later for whoever was dealt to, which is the only clock two browsers share without a server to ask.
    var t = S.tick - v.startTick;
    mark(S, row, v.self, t);
    send(S, { k: 'done', r: v.round, task: row.id, t: t });
  }

  /** Where this driver is and how the day stands, a few times a second. */
  function report(S, dt) {
    var v = st(S);
    var T = TLV.tune.game;
    v.sendT -= dt;
    if (v.sendT > 0 || !v.linked || !Object.keys(v.peers).length) return;
    v.sendT = T.versusSendS;
    var g = S.game;
    var p = S.player;
    var veh = p.veh;
    var foot = p.mode === 'FOOT' && p.foot;
    send(S, {
      k: 'state', r: v.round,
      x: Math.round((foot ? p.foot.x : veh.x) * 10) / 10, y: Math.round((foot ? p.foot.y : veh.y) * 10) / 10,
      h: Math.round(veh.h * 100) / 100, s: Math.round(veh.v * 10) / 10,
      m: Math.round(g.money), n: v.count, p: v.pick, e: g.phase === 'RUN_END' ? 1 : 0, w: g.endReason, on: v.on ? 1 : 0
    });
  }

  function onState(S, from, m) {
    var v = st(S);
    var p = v.peers[from];
    if (!p || !Number.isFinite(m.x) || !Number.isFinite(m.y) || !Number.isFinite(m.h)) return;
    p.px = p.seen ? p.x : m.x;
    p.py = p.seen ? p.y : m.y;
    p.ph = p.seen ? p.h : m.h;
    p.x = m.x;
    p.y = m.y;
    p.h = m.h;
    p.v = Number.isFinite(m.s) ? m.s : 0;
    p.at = S.t;
    p.seen = true;
    p.busy = !!m.on && !m.e;
    if (m.r !== v.round || !m.on) return;
    p.playing = true;
    var was = p.ended;
    p.money = Number.isFinite(m.m) ? m.m : p.money;
    p.count = Number.isFinite(m.n) ? m.n : p.count;
    p.pick = Number.isInteger(m.p) ? m.p : -1;
    p.ended = !!m.e;
    p.reason = typeof m.w === 'string' ? m.w : null;
    if (p.ended && !was) {
      S.bus.emit('versus.ended', { id: from, reason: p.reason, money: p.money });
      maybeAgain(S);
    }
  }

  function onStart(S, from, m) {
    var v = st(S);
    var phase = S.game.phase;
    if (m.v !== PROTO || !Number.isInteger(m.round) || m.round <= v.round || !validRows(m.rows)) return;
    // Only from a driver who speaks this protocol, and only when no day of its own is on. Who deals is settled among those who
    // shared the last day, and a driver who was not in it cannot check that, so the board is taken from whoever sends one.
    if (!v.peers[from] || v.peers[from].proto !== PROTO || (phase !== 'TITLE' && phase !== 'RUN_END')) return;
    var T = TLV.tune.game;
    if (Object.prototype.hasOwnProperty.call(T.difficulty, m.difficulty)) S.game.difficulty = m.difficulty;
    TLV.game.flow.startRun(S, { versus: { round: m.round, rows: m.rows } });
  }

  function handle(S, from, m) {
    var v = st(S);
    var p = v.peers[from];
    if (!p) return;
    switch (m.k) {
      case 'hello':
        p.proto = m.v === PROTO ? PROTO : -1;
        S.bus.emit('versus.peer', { id: from, joined: true });
        break;
      case 'go':
        if (isHost(S) && (S.game.phase === 'TITLE' || (S.game.phase === 'RUN_END' && !v.on))) startRound(S);
        break;
      case 'start':
        onStart(S, from, m);
        break;
      case 'pick':
        if (m.r === v.round && Number.isInteger(m.task)) p.pick = m.task;
        break;
      case 'done':
        onDone(S, from, m);
        break;
      case 'state':
        onState(S, from, m);
        break;
      case 'again':
        if (m.r === v.round) {
          p.ready = true;
          S.bus.emit('versus.ready', { self: false });
          maybeAgain(S);
        }
        break;
      default:
        break;
    }
  }

  /**
   * Called first in flow.preUpdate: what arrived since the last tick, the board's prices while it is up, and this driver's report.
   * @param {object} S Sim state.
   * @param {number} dt Tick, seconds.
   */
  versus._tick = function (S, dt) {
    var v = S.versus;
    if (!v) return;
    if (!v._heard) {
      v._heard = true;
      S.bus.on('errand.parked', function (p) { onParked(S, p); });
    }
    if (v.inbox.length) {
      var list = v.inbox.splice(0, v.inbox.length);
      for (var i = 0; i < list.length; i++) handle(S, list[i].from, list[i].msg);
    }
    if (v.on && v.open && S.game.phase !== 'RUN_END') {
      // On the move the prices change with every street, and the board must not charge a tick for each of them.
      v.optionsT -= dt;
      if (!v.options || (v.optionsT <= 0 && S.game.phase !== 'CARD')) {
        v.options = price(S, pickFrom(S));
        v.optionsT = TLV.tune.game.versusRefreshS;
      }
    }
    report(S, dt);
  };
})(window.TLV);
