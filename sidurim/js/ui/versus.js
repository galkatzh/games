// js/ui/versus.js — WP-UI
// The screens of a shared day (GAME_DESIGN 26): the lobby over the title, where a room is opened or joined by its code, the board a
// driver picks an errand from, the line that says how the other driver is doing, and the verdict on the end screen.
//
// Like the title's difficulty choice, picking is a decision the player makes on a screen, so this file calls into the sim:
// TLV.game.versus for the board, and TLV.net for the room. It reads everything else.
//
// Keys: the listener here runs in the capture phase on window, and is added before the menus' own, so the lobby holds every key while
// it is up and a digit picks from the board without reaching anything else.
(function (TLV) {
  'use strict';

  var versus = TLV.ns('ui.versus');

  var dom = null;
  var sim = null;
  var keyHandler = null;
  /** The lobby: closed, on its two choices, or taking a code. In a room it shows the room, whatever this says. */
  var lobby = 'closed';
  var typed = '';
  /** The row a driver was on when another took it, so the board can say so once. */
  var takenNote = false;
  var lastBoard = '';
  var lastEnd = '';

  function u() {
    return TLV.ui;
  }

  function t(key, vars) {
    return TLV.ui.strings.t(key, vars);
  }

  function game() {
    return TLV.game.versus;
  }

  function net() {
    return TLV.net;
  }

  function button(parent, cls, onClick) {
    var node = u().el('button', cls, parent);
    node.type = 'button';
    node.tabIndex = -1;
    node.addEventListener('mousedown', function (e) { e.preventDefault(); });
    node.addEventListener('click', function (e) {
      e.stopPropagation();
      TLV.audio.unlock();
      onClick();
    });
    return node;
  }

  /**
   * @param {object} S Sim state.
   * @returns {boolean} True while a shared day is on, for the screens that behave otherwise on one.
   */
  versus.shared = function (S) {
    return game().active(S);
  };

  /** @returns {boolean} True while the lobby is on screen. */
  versus.lobbyOpen = function () {
    return lobby !== 'closed';
  };

  function openLobby() {
    lobby = 'menu';
    typed = '';
    TLV.audio.ui('click');
  }

  function closeLobby() {
    if (sim) net().close(sim);
    lobby = 'closed';
    typed = '';
  }

  function host() {
    if (!sim) return;
    net().open(sim, net().makeCode());
    TLV.audio.ui('click');
  }

  function start() {
    if (sim && game().requestStart(sim)) TLV.audio.ui('click');
  }

  /** Leaves a room for the lobby's two choices, or the lobby for the title. */
  function back() {
    var inRoom = net().state().status !== 'off';
    if (inRoom) {
      net().close(sim);
      lobby = 'menu';
    } else if (lobby === 'code') {
      lobby = 'menu';
    } else {
      closeLobby();
    }
    typed = '';
    TLV.audio.ui('click');
  }

  /** Builds the lobby, the board, the line under the money and the verdict, all hidden. */
  versus.build = function (root, S) {
    var el = u().el;
    sim = S;
    dom = {};
    lobby = 'closed';
    typed = '';
    takenNote = false;
    lastBoard = '';
    lastEnd = '';

    var scr = dom.lobby = el('div', 'scr scr-lobby off', root);
    var panel = el('div', 'lobby-panel', scr);
    dom.lobbyTitle = el('div', 'lobby-title', panel);
    dom.lobbyLine = el('div', 'lobby-line', panel);
    var choices = dom.lobbyChoices = el('div', 'lobby-choices', panel);
    dom.lobbyHost = button(choices, 'lobby-choice', host);
    dom.lobbyJoin = button(choices, 'lobby-choice', function () {
      lobby = 'code';
      typed = '';
    });
    var roomBox = dom.lobbyRoom = el('div', 'lobby-room', panel);
    dom.lobbyCodeLabel = el('div', 'lobby-code-label', roomBox);
    dom.lobbyCode = el('div', 'lobby-code', roomBox);
    dom.lobbyCode.dir = 'ltr';
    dom.lobbyStatus = el('div', 'lobby-status', panel);
    dom.lobbyStart = button(panel, 'lobby-start', start);
    dom.lobbyNote = el('div', 'lobby-note', panel);
    dom.lobbyBack = button(panel, 'lobby-back', back);

    var board = dom.board = el('div', 'board off', root);
    dom.boardTitle = el('div', 'board-title', board);
    dom.boardRows = el('div', 'board-rows', board);
    dom.boardKeys = el('div', 'board-keys', board);

    var bar = dom.bar = el('div', 'hud-versus off', root);
    dom.barThem = el('span', 'hud-versus-them', bar);
    dom.barMoney = el('span', 'hud-versus-money', bar);
    dom.barMoney.dir = 'ltr';
    dom.barLeft = el('span', 'hud-versus-left', bar);
    dom.barHint = el('span', 'hud-versus-hint', bar);

    var end = dom.end = el('div', 'end-versus off', root);
    dom.endVerdict = el('div', 'end-versus-verdict', end);
    var rows = el('div', 'end-versus-rows', end);
    var you = el('div', 'end-versus-row', rows);
    dom.endYouLabel = el('span', 'end-versus-label', you);
    dom.endYou = el('span', 'end-versus-value', you);
    dom.endYou.dir = 'ltr';
    var them = el('div', 'end-versus-row', rows);
    dom.endThemLabel = el('span', 'end-versus-label', them);
    dom.endThem = el('span', 'end-versus-value', them);
    dom.endThem.dir = 'ltr';
    dom.endNote = el('div', 'end-versus-note', end);

    if (keyHandler) window.removeEventListener('keydown', keyHandler, true);
    keyHandler = keyDown;
    window.addEventListener('keydown', keyHandler, true);
    versus.relabel();

    // A room named in the address is joined at once, so a link is all the second driver needs.
    var asked = S.params.room ? net().cleanCode(S.params.room) : '';
    if (asked.length === net().CODE_LEN && S.game && S.game.phase === 'TITLE' && !S.params.notitle) {
      lobby = 'menu';
      net().open(S, asked);
    }
  };

  /** Rewrites fixed labels after a language switch. */
  versus.relabel = function () {
    if (!dom) return;
    u().setText(dom.lobbyTitle, t('lobby.title'));
    u().setText(dom.lobbyLine, t('lobby.line'));
    u().setRich(dom.lobbyHost, t('lobby.host'));
    u().setRich(dom.lobbyJoin, t('lobby.join'));
    u().setRich(dom.lobbyStart, t('lobby.start'));
    u().setText(dom.lobbyNote, t('lobby.note'));
    u().setText(dom.barThem, t('versus.them'));
    u().setRich(dom.barHint, t('versus.hint'));
    u().setText(dom.endYouLabel, t('end.versus.you'));
    u().setText(dom.endThemLabel, t('end.versus.them'));
    dom.lobbyBack._text = null;
    lastBoard = '';
    lastEnd = '';
  };

  function swallow(e) {
    TLV.audio.unlock();
    e.preventDefault();
    e.stopImmediatePropagation();
  }

  /** @returns {number} 0 to 9 for a digit key, on the row or the pad, else -1. */
  function digit(code) {
    var m = /^(?:Digit|Numpad)(\d)$/.exec(code);
    return m ? Number(m[1]) : -1;
  }

  /** The key that picks a row: 1 to 9 down the board, and 0 for the gan at the foot of it. */
  function keyOf(row, i, count) {
    if (row.finale && i === count - 1) return '0';
    return i < 9 ? String(i + 1) : '';
  }

  function pickKey(n) {
    var board = game().board(sim);
    if (!board) return;
    for (var i = 0; i < board.length; i++) {
      if (keyOf(board[i], i, board.length) === String(n)) {
        if (game().pick(sim, board[i].id)) {
          takenNote = false;
          TLV.audio.ui('click');
        } else {
          TLV.audio.ui('tick');
        }
        return;
      }
    }
  }

  function lobbyKey(e) {
    var state = net().state();
    if (e.repeat) return;
    if (e.code === 'Escape') {
      back();
      return;
    }
    if (state.status !== 'off') {
      if (e.code === 'Enter' || e.code === 'NumpadEnter') start();
      return;
    }
    if (lobby === 'code') {
      if (e.code === 'Backspace') {
        typed = typed.slice(0, -1);
      } else if (e.key && e.key.length === 1) {
        typed = net().cleanCode(typed + e.key);
        TLV.audio.ui('tick');
        if (typed.length === net().CODE_LEN) net().open(sim, typed);
      }
      return;
    }
    if (e.code === 'KeyH') host();
    else if (e.code === 'KeyJ') {
      lobby = 'code';
      typed = '';
      TLV.audio.ui('click');
    }
  }

  function keyDown(e) {
    if (!sim || !sim.game) return;
    var phase = sim.game.phase;
    // The lobby belongs to the title. Once a day is on it is gone, whether or not a frame has been drawn to say so, and the key is
    // read as a key of that day.
    if (lobby !== 'closed' && phase !== 'TITLE') lobby = 'closed';
    if (lobby !== 'closed') {
      lobbyKey(e);
      swallow(e);
      return;
    }
    if (phase === 'TITLE') {
      if (e.code === 'KeyO' && !e.repeat && !sim.params.notitle && !(u().menus.busy && u().menus.busy())) {
        openLobby();
        swallow(e);
      }
      return;
    }
    if (phase === 'RUN_END' || u().isUserPaused() || !game().active(sim)) return;
    var view = game().view(sim);
    if (view.open) {
      var n = digit(e.code);
      if (n >= 0) {
        if (!e.repeat) pickKey(n);
        swallow(e);
        return;
      }
    }
    if (e.code === 'KeyT') {
      if (!e.repeat) {
        if (view.open) game().keep(sim);
        else game().reconsider(sim);
        takenNote = false;
        TLV.audio.ui('click');
      }
      swallow(e);
    }
  }

  /** @returns {?object} The other driver to show: among those who can share a board, whoever has the most money. */
  function rival(view) {
    var best = null;
    for (var i = 0; i < view.peers.length; i++) {
      var p = view.peers[i];
      // Someone who came into the room after the day began has no day to compare.
      if (!p.compatible || !p.playing) continue;
      if (!best || p.money > best.money) best = p;
    }
    return best;
  }

  /**
   * Reacts to one event.
   * @param {object} S Sim state.
   * @param {string} name Event name.
   * @param {object} p Payload.
   */
  versus.onEvent = function (S, name, p) {
    if (!dom) return;
    var hud = u().hud;
    var lang = TLV.ui.strings.lang();
    var T = TLV.tune.ui;
    switch (name) {
      case 'run.start':
        lobby = 'closed';
        takenNote = false;
        lastEnd = '';
        break;
      case 'versus.taken':
        takenNote = true;
        hud.toast(t('toast.versus.taken'), 'warn', T.toastLongS);
        break;
      case 'versus.done': {
        if (p.mine || S.game.phase === 'RUN_END') break;
        var board = game().board(S);
        var row = board ? board[p.task] : null;
        if (row) hud.toast(t('toast.versus.done', { name: row.name[lang] || row.name.en }));
        break;
      }
      case 'versus.unlock':
        if (S.game.phase !== 'RUN_END') hud.toast(t('toast.versus.unlock'), 'warn', T.toastLongS);
        break;
      case 'versus.void':
        hud.toast(t('toast.versus.void'), 'warn', T.toastLongS);
        break;
      case 'versus.peer':
        if (S.game.phase !== 'TITLE' && S.game.phase !== 'RUN_END' && game().active(S)) {
          hud.toast(t(p.joined ? 'toast.versus.joined' : 'toast.versus.gone'), p.joined ? '' : 'warn', T.toastLongS);
        }
        break;
      case 'versus.ended':
        if (S.game.phase !== 'RUN_END') hud.toast(t('toast.versus.ended'));
        break;
      default:
        break;
    }
  };

  function frameLobby(S) {
    var on = lobby !== 'closed' && S.game.phase === 'TITLE';
    if (lobby !== 'closed' && S.game.phase !== 'TITLE') lobby = 'closed';
    u().show(dom.lobby, on);
    if (!on) return;
    var state = net().state();
    var view = game().view(S);
    var inRoom = state.status !== 'off';
    u().show(dom.lobbyChoices, !inRoom && lobby === 'menu');
    u().show(dom.lobbyRoom, inRoom || lobby === 'code');
    var code = inRoom ? state.room : typed;
    var slots = '';
    for (var i = 0; i < net().CODE_LEN; i++) slots += i < code.length ? code.charAt(i) : '·';
    u().setText(dom.lobbyCode, slots);
    u().setText(dom.lobbyCodeLabel, t(inRoom ? 'lobby.code' : 'lobby.typeCode'));
    var others = 0;
    var odd = 0;
    var out = 0;
    view.peers.forEach(function (p) {
      if (p.compatible) others++;
      else if (p.mismatch) odd++;
      if (p.busy) out++;
    });
    var line = '';
    if (state.status === 'failed') line = t('lobby.error.' + (state.error || 'join'));
    else if (state.status === 'joining') line = t('lobby.joining');
    else if (state.status === 'open') {
      if (out > 0) line = t('lobby.busy');
      else if (others > 0) line = t('lobby.together', { n: others + 1 });
      else line = odd ? t('lobby.other') : t('lobby.alone') + ' ' + t('lobby.share');
    }
    u().setText(dom.lobbyStatus, line);
    dom.lobbyStatus.classList.toggle('bad', state.status === 'failed');
    u().show(dom.lobbyStart, state.status === 'open' && others > 0 && out === 0);
    u().setRich(dom.lobbyBack, t(inRoom ? 'lobby.leave' : 'lobby.back'));
  }

  /** One row of the board, as text and classes. Rebuilt only when something on it changed. */
  function paintBoard(S, board, driving) {
    var lang = TLV.ui.strings.lang();
    var el = u().el;
    var money = TLV.ui.strings.money;
    var key = JSON.stringify([lang, driving, takenNote, board.map(function (r) {
      return [r.state, Math.round(r.dist / 10), r.pay, Math.round(r.award), r.heading, r.picked];
    })]);
    if (key === lastBoard) return;
    lastBoard = key;
    u().setText(dom.boardTitle, t(takenNote ? 'board.titleTaken' : 'board.title'));
    dom.boardRows.textContent = '';
    board.forEach(function (r, i) {
      var open = r.state === 'open';
      var row = button(dom.boardRows, 'board-row ' + r.state + (r.picked ? ' picked' : ''), function () {
        if (open && game().pick(sim, r.id)) takenNote = false;
      });
      var cap = el('kbd', 'key board-key', row, open ? keyOf(r, i, board.length) : '');
      cap.dir = 'ltr';
      // The errand's first sentence says what it is. Where that does not name the door, the door's name follows.
      var words = r.text[lang] || r.text.en;
      var place = r.name[lang] || r.name.en;
      var lead = /^[^.?!]*[.?!]/.exec(words);
      var label = lead ? lead[0] : words;
      var cell = el('span', 'board-what', row);
      var name = el('span', 'board-name', cell, label);
      name.dir = 'auto';
      if (label.indexOf(place) < 0) el('span', 'board-place', name, ' ' + place);
      if (open) {
        var dist = el('span', 'board-dist', row, t('hud.metres', { n: Math.round(r.dist / 10) * 10 }));
        dist.dir = 'auto';
        el('span', 'board-pay', row, '+' + money(r.pay)).dir = 'ltr';
        el('span', 'board-award', row, t('hud.seconds', { n: '+' + Math.round(r.award) })).dir = 'auto';
        // Under the errand, so the figures keep their columns.
        if (r.heading > 0) el('span', 'board-note', cell, t('board.heading'));
      } else {
        el('span', 'board-note', row, t('board.' + r.state));
      }
    });
    u().setRich(dom.boardKeys, S.game.errand ? t('board.keys') + '   ' + t('board.keep') : t('board.keys'));
  }

  function frameBoard(S, view) {
    var phase = S.game.phase;
    var on = view.open && phase !== 'RUN_END' && phase !== 'TITLE' && !u().isUserPaused();
    u().show(dom.board, on);
    if (!on) return;
    var board = game().board(S);
    if (!board) return;
    var driving = phase !== 'CARD';
    dom.board.classList.toggle('driving', driving);
    paintBoard(S, board, driving);
  }

  function frameBar(S, view, visible) {
    var phase = S.game.phase;
    var on = visible && view.on && phase !== 'RUN_END' && phase !== 'TITLE';
    u().show(dom.bar, on);
    if (!on) return;
    var other = rival(view);
    u().show(dom.barThem, !!other);
    u().show(dom.barMoney, !!other);
    if (other) u().setText(dom.barMoney, TLV.ui.strings.money(other.money));
    u().setText(dom.barLeft, t('versus.left', { n: view.left }));
    u().show(dom.barHint, !view.open && !!S.game.errand && (phase === 'DRIVE' || phase === 'SEARCH'));
  }

  /**
   * How a shared day ended, for the end screen.
   * @param {object} S Sim state.
   * @returns {?{verdict:?string,you:number,them:?number,restart:string}} Null on a day alone. verdict is 'WON', 'LOST', 'TIED', 'PENDING'
   * while another driver is still out, or null with nobody left to compare with.
   */
  versus.endInfo = function (S) {
    if (!S.game || S.game.phase !== 'RUN_END' || !game().active(S)) return null;
    var view = game().view(S);
    var other = rival(view);
    var you = Math.round(S.game.money);
    var verdict = null;
    if (other) {
      var pending = view.peers.some(function (p) { return p.compatible && p.playing && !p.ended; });
      if (pending) verdict = 'PENDING';
      else verdict = you > other.money ? 'WON' : (you < other.money ? 'LOST' : 'TIED');
    }
    var restart = 'end.restart';
    if (other) restart = view.ready ? 'end.versus.ready' : 'end.versus.restart';
    return { verdict: verdict, you: you, them: other ? other.money : null, restart: restart, theyReady: !!other && other.ready && !view.ready };
  };

  function frameEnd(S) {
    var info = versus.endInfo(S);
    u().show(dom.end, !!info && info.them !== null);
    if (!info || info.them === null) return;
    var key = JSON.stringify([info, TLV.ui.strings.lang()]);
    if (key === lastEnd) return;
    lastEnd = key;
    var money = TLV.ui.strings.money;
    u().setText(dom.endVerdict, t('end.versus.' + info.verdict));
    dom.end.dataset.verdict = info.verdict;
    u().setText(dom.endYou, money(info.you));
    u().setText(dom.endThem, money(info.them));
    u().setText(dom.endNote, info.theyReady ? t('end.versus.theyReady') : '');
  }

  /**
   * @param {object} S Sim state.
   * @returns {?{n:number,total:number}} On a shared day, which errand of the board this driver is on, for the lines that say 'errand n/7'.
   */
  versus.errandCount = function (S) {
    if (!game().active(S)) return null;
    var view = game().view(S);
    return { n: Math.min(view.total, view.count + 1), total: view.total };
  };

  /**
   * What the minimap adds on a shared day: the other drivers, and the doors still open while the board is up.
   * @param {object} S Sim state.
   * @returns {Array<{x:number,y:number,kind:string,label:string}>} kind is 'peer' or 'task'.
   */
  versus.marks = function (S) {
    var out = [];
    if (!game().active(S)) return out;
    var view = game().view(S);
    view.peers.forEach(function (p) {
      if (p.seen && !p.ended) out.push({ x: p.x, y: p.y, kind: 'peer', label: '' });
    });
    if (view.open) {
      var board = game().board(S) || [];
      board.forEach(function (r, i) {
        if (r.state === 'open') out.push({ x: r.x, y: r.y, kind: 'task', label: keyOf(r, i, board.length) });
      });
    }
    return out;
  };

  /**
   * Draws one frame, and sends what the sim has queued for the room.
   * @param {object} S Sim state.
   * @param {boolean} visible False with the HUD off.
   */
  versus.frame = function (S, visible) {
    sim = S;
    if (!dom || !S.game) return;
    net().frame(S);
    frameLobby(S);
    var view = game().view(S);
    frameBoard(S, view);
    frameBar(S, view, visible);
    frameEnd(S);
  };
})(window.TLV);
