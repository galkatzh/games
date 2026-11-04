// js/render/city/facades.js — WP-RENDER
// The facade array: 256 x 256 x 32 layers, painted at boot. One layer is one bay by one floor, so windows never cut.
// Alpha marks masonry that takes the building's tint. Painters take parameters, so a style can reuse them from data.
(function (TLV) {
  'use strict';

  var facades = TLV.ns('render.city.facades');

  var tex = null;
  var data = null;
  var layers = Object.create(null);
  var used = 0;
  var tilesWaiting = [];
  var fallbackLayer = { layer: 0, vars: 1 };

  /** Paint surface that writes colour and the tint mask together. */
  function Surface(size) {
    this.S = size;
    this.cv = document.createElement('canvas');
    this.cv.width = this.cv.height = size;
    this.c = this.cv.getContext('2d', { willReadFrequently: true });
    this.mv = document.createElement('canvas');
    this.mv.width = this.mv.height = size;
    this.m = this.mv.getContext('2d', { willReadFrequently: true });
  }

  /** Fills a rectangle; tinted marks it as masonry. */
  Surface.prototype.rect = function (x, y, w, h, colour, tinted) {
    this.c.fillStyle = colour;
    this.c.fillRect(x, y, w, h);
    this.m.fillStyle = tinted ? '#fff' : '#000';
    this.m.fillRect(x, y, w, h);
  };

  /** Vertical gradient fill, untinted. */
  Surface.prototype.grad = function (x, y, w, h, a, b, tinted) {
    var g = this.c.createLinearGradient(0, y, 0, y + h);
    g.addColorStop(0, a);
    g.addColorStop(1, b);
    this.c.fillStyle = g;
    this.c.fillRect(x, y, w, h);
    this.m.fillStyle = tinted ? '#fff' : '#000';
    this.m.fillRect(x, y, w, h);
  };

  /** Darkening overlay that leaves the mask alone. */
  Surface.prototype.shade = function (x, y, w, h, colour) {
    this.c.fillStyle = colour;
    this.c.fillRect(x, y, w, h);
  };

  /** Light speckle and drips, so plaster is not a flat colour. */
  function weather(s, seed, amount) {
    var r = TLV.rng.create(seed);
    var S = s.S;
    for (var i = 0; i < 90; i++) {
      var x = r.next() * S;
      var y = r.next() * S;
      var a = r.next() * 0.022 * amount;
      s.shade(x, y, 2 + r.next() * 14, 2 + r.next() * 8, 'rgba(70,58,44,' + a.toFixed(3) + ')');
    }
    for (var d = 0; d < 7; d++) {
      var dx = r.next() * S;
      var dy = r.next() * S * 0.7;
      var g = s.c.createLinearGradient(0, dy, 0, dy + 70);
      g.addColorStop(0, 'rgba(60,52,44,' + (0.05 * amount).toFixed(3) + ')');
      g.addColorStop(1, 'rgba(60,52,44,0)');
      s.c.fillStyle = g;
      s.c.fillRect(dx, dy, 3 + r.next() * 5, 70);
    }
  }

  /** A glass pane: dark with a sky gradient. */
  function pane(s, x, y, w, h, top, bottom) {
    s.grad(x, y, w, h, top || '#6f8497', bottom || '#2b3540', false);
    s.shade(x, y, w * 0.35, h, 'rgba(255,255,255,0.05)');
  }

  /** Plastic roller shutter over part of a window. */
  function roller(s, x, y, w, h, colour) {
    s.rect(x, y, w, h, colour || '#d9d4c8', false);
    for (var i = 0; i < h; i += 7) s.shade(x, y + i, w, 2, 'rgba(0,0,0,0.13)');
  }

  /** Louvred wooden leaf. */
  function louver(s, x, y, w, h, colour) {
    s.rect(x, y, w, h, colour, false);
    for (var i = 4; i < h - 4; i += 6) s.shade(x + 3, y + i, w - 6, 3, 'rgba(0,0,0,0.2)');
    s.shade(x, y, 3, h, 'rgba(255,255,255,0.14)');
  }

  /** Every shop tile starts here: a tinted header band for the sign, and a dark frame round the window. */
  function shopFrame(s, frame) {
    var S = s.S;
    s.rect(0, 0, S, 62, '#ffffff', true);
    s.shade(0, 56, S, 6, 'rgba(0,0,0,0.3)');
    s.rect(0, 62, S, S - 62, frame, false);
  }

  /** A glass door in the right of the bay. */
  function shopDoor(s, frame) {
    s.rect(192, 70, 58, 186, frame || '#556069', false);
    pane(s, 198, 78, 46, 150, '#c9d6db', '#6b7a82');
    s.rect(238, 150, 4, 26, '#d9d6cc', false);
  }

  /** Painters: fn(surface, params, variant). */
  var P = facades.painters = {
    /** Bauhaus ribbon window under a deep lintel. */
    ribbon: function (s, p, v) {
      var S = s.S;
      s.rect(0, 0, S, S, '#ffffff', true);
      var top = 62, bot = 186;
      s.shade(0, top - 16, S, 16, 'rgba(0,0,0,0.26)');
      pane(s, 0, top, S, bot - top);
      if (v > 0) roller(s, 0, top, S, (bot - top) * [0, 0.42, 0.9, 0.62][v], p.shutter);
      for (var x = 0; x < S; x += 64) s.rect(x, top, 5, bot - top, p.frame || '#e9e6de', false);
      s.rect(0, bot, S, 9, '#f6f3ea', false);
      s.shade(0, bot + 9, S, 7, 'rgba(0,0,0,0.2)');
      weather(s, 11 + v, 0.8);
    },
    /** One tall window with a roller shutter and its box. */
    shutter: function (s, p, v) {
      var S = s.S;
      s.rect(0, 0, S, S, '#ffffff', true);
      var x = 62, w = 132, y = 44, h = 150;
      s.rect(x - 7, y - 7, w + 14, h + 15, '#f4f0e6', false);
      s.shade(x - 7, y + h + 8, w + 14, 6, 'rgba(0,0,0,0.2)');
      pane(s, x, y, w, h);
      roller(s, x, y, w, h * [0.25, 0.55, 0.96, 0.75][v], p.shutter);
      s.rect(x + w / 2 - 2, y, 4, h, '#dcd8ce', false);
      weather(s, 21 + v, 1);
    },
    /** Green wooden shutters, the old-city window. */
    wood: function (s, p, v) {
      var S = s.S;
      s.rect(0, 0, S, S, '#ffffff', true);
      var x = 80, w = 96, y = 40, h = 158;
      var c = p.leaf || '#55776a';
      s.rect(x - 8, y - 12, w + 16, 10, '#f3eee2', false);
      s.rect(x - 8, y + h, w + 16, 9, '#f3eee2', false);
      s.shade(x - 8, y + h + 9, w + 16, 6, 'rgba(0,0,0,0.22)');
      if (v === 0) {
        pane(s, x, y, w, h, '#556a7a', '#222a33');
        s.rect(x + w / 2 - 2, y, 4, h, '#e0dbcf', false);
        louver(s, x - 44, y, 42, h, c);
        louver(s, x + w + 2, y, 42, h, c);
      } else if (v === 1) {
        louver(s, x, y, w / 2 - 1, h, c);
        louver(s, x + w / 2 + 1, y, w / 2 - 1, h, c);
      } else {
        pane(s, x, y, w, h, '#556a7a', '#222a33');
        louver(s, x, y, w / 2 - 1, h, c);
        louver(s, x + w + 2, y, 42, h, c);
      }
      weather(s, 31 + v, 1.3);
    },
    /** Sixties block: exposed concrete frame, recessed window, sill stains. */
    block: function (s, p, v) {
      var S = s.S;
      s.rect(0, 0, S, S, '#ffffff', true);
      s.rect(0, 0, 16, S, '#efece4', true);
      s.rect(S - 16, 0, 16, S, '#e4e0d6', true);
      s.rect(0, 218, S, 38, '#e9e5da', true);
      var x = 30, y = 30, w = 196, h = 180;
      s.rect(x, y, w, h, '#b8b3a8', false);
      s.shade(x, y, w, 14, 'rgba(0,0,0,0.32)');
      s.shade(x, y, 10, h, 'rgba(0,0,0,0.2)');
      pane(s, x + 10, y + 14, w - 20, h - 22);
      roller(s, x + 10, y + 14, w - 20, (h - 22) * [0.12, 0.5, 0.92, 0.3][v], p.shutter);
      s.rect(x + w / 2 - 2, y + 14, 4, h - 22, '#a9a59a', false);
      weather(s, 41 + v, 1.7);
    },
    /** Pale stone with an arched window. */
    arch: function (s, p, v) {
      var S = s.S;
      s.rect(0, 0, S, S, '#ffffff', true);
      for (var y = 0, row = 0; y < S; y += 34, row++) {
        s.shade(0, y, S, 2, 'rgba(90,70,45,0.28)');
        for (var x = (row & 1) * 40; x < S; x += 80) s.shade(x, y, 2, 34, 'rgba(90,70,45,0.24)');
      }
      var c = s.c, m = s.m, ax = 72, aw = 112, ay = 76, ah = 124;
      function archPath(g) {
        g.beginPath();
        g.moveTo(ax, ay + ah);
        g.lineTo(ax, ay);
        g.arc(ax + aw / 2, ay, aw / 2, Math.PI, 0);
        g.lineTo(ax + aw, ay + ah);
        g.closePath();
      }
      var g = c.createLinearGradient(0, ay - 56, 0, ay + ah);
      g.addColorStop(0, '#5f7385');
      g.addColorStop(1, '#262f39');
      c.fillStyle = g;
      archPath(c);
      c.fill();
      m.fillStyle = '#000';
      archPath(m);
      m.fill();
      if (v === 1) {
        c.fillStyle = p.leaf || '#55776a';
        archPath(c);
        c.fill();
      }
      s.rect(ax - 6, ay + ah, aw + 12, 9, '#efe6d3', false);
      weather(s, 51 + v, 1.4);
    },
    /** Curtain wall. */
    curtain: function (s, p, v) {
      var S = s.S;
      s.grad(0, 0, S, S, p.top || '#7fa6c4', p.bottom || '#3f6480', false);
      s.rect(0, 214, S, 42, p.spandrel || '#2f4a60', false);
      s.rect(0, 0, S, 6, p.mullion || '#b9c6cf', false);
      s.rect(0, 0, 6, S, p.mullion || '#b9c6cf', false);
      s.rect(128, 0, 3, S, p.mullion || '#b9c6cf', false);
      if (v > 0) s.shade(v === 1 ? 6 : 131, 6, 122, 208, 'rgba(255,255,255,' + (0.03 + v * 0.03) + ')');
    },
    /** Masonry tower grid: pale frame, deep glass. */
    grid: function (s, p, v) {
      var S = s.S;
      s.rect(0, 0, S, S, '#ffffff', true);
      pane(s, 22, 26, S - 44, 176, p.top || '#6d8aa1', p.bottom || '#2a3844');
      s.rect(S / 2 - 3, 26, 6, 176, '#cfcbc0', false);
      s.shade(22, 26, S - 44, 12, 'rgba(0,0,0,0.3)');
      if (v === 1) roller(s, 22, 26, S - 44, 70, p.shutter);
      weather(s, 61 + v, 0.8);
    },
    /**
     * Ground floor on columns, the signature of the residential street. The recess is a lit room, not a hole: a warm back wall with a
     * lobby door, mailboxes and bikes, or an open bay with the garden behind. Variant 0 is the lobby, 1 the garden, 2 the bikes.
     * Columns stand on the bay's edges, so they keep their rhythm whichever variants fall side by side.
     */
    pilotis: function (s, p, v) {
      var S = s.S;
      var c = s.c;
      var Q = 22;              // Half a column
      var floorY = 224;
      s.grad(0, 0, S, floorY, '#b9a688', '#dac9a9', false);
      s.grad(0, floorY, S, S - floorY, '#d8ccb6', '#c6b9a2', false);
      s.shade(0, floorY - 2, S, 3, 'rgba(70,52,36,0.4)');
      if (v === 1) {
        // Open bay: the back garden, brighter than anything else in the frame.
        s.grad(Q, 40, S - 2 * Q, floorY - 40, '#f1f4e4', '#d3e6ae', false);
        s.rect(Q, 92, S - 2 * Q, 92, '#e8dfca', false);
        for (var r = 0; r < 12; r++) s.shade(Q + r * 18, 92, 2, 92, 'rgba(120,100,70,0.2)');
        var blobs = [[52, 150, 44, '#6d9a3f'], [108, 176, 36, '#86b24c'], [170, 158, 46, '#5e8d3a'], [214, 182, 30, '#93bb55'], [78, 190, 30, '#a4c766'], [146, 196, 26, '#7ba746']];
        for (var b = 0; b < blobs.length; b++) {
          c.fillStyle = blobs[b][3];
          c.beginPath();
          c.arc(blobs[b][0], blobs[b][1], blobs[b][2], 0, 6.2832);
          c.fill();
        }
        s.rect(Q, floorY - 8, S - 2 * Q, 8, '#b7a98f', false);
      } else if (v === 2) {
        // Mailboxes, and two bikes on the back wall.
        s.rect(58, 84, 140, 60, '#8c8f8e', false);
        for (var mx = 0; mx < 6; mx++) {
          for (var my = 0; my < 3; my++) {
            s.rect(61 + mx * 23, 87 + my * 19, 21, 17, ['#c7c9c6', '#b4b8b6', '#cfcdc5'][(mx + my) % 3], false);
            s.rect(65 + mx * 23, 93 + my * 19, 13, 2, '#4d5052', false);
          }
        }
        c.lineWidth = 5;
        for (var k = 0; k < 2; k++) {
          var bx = 72 + k * 76, by = 190;
          c.strokeStyle = '#2f3336';
          c.beginPath();
          c.arc(bx, by + 8, 21, 0, 6.2832);
          c.arc(bx + 58, by + 8, 21, 0, 6.2832);
          c.stroke();
          c.strokeStyle = ['#a7342b', '#2f5f8a'][k];
          c.beginPath();
          c.moveTo(bx, by + 8);
          c.lineTo(bx + 22, by - 26);
          c.lineTo(bx + 50, by - 26);
          c.lineTo(bx + 58, by + 8);
          c.moveTo(bx + 22, by - 26);
          c.lineTo(bx + 30, by + 8);
          c.lineTo(bx + 50, by - 26);
          c.stroke();
        }
      } else {
        // The lobby: a lit glass door, the number over it, the entryphone, a few mailboxes.
        s.rect(82, 60, 92, floorY - 60, '#5a4432', false);
        s.grad(90, 68, 76, floorY - 72, '#fbeecb', '#d9b67c', false);
        s.rect(126, 68, 4, floorY - 72, '#5a4432', false);
        s.rect(90, 120, 76, 3, '#5a4432', false);
        s.rect(156, 142, 5, 28, '#e2dccb', false);
        s.rect(100, 42, 56, 16, '#1f4f8a', false);
        s.rect(106, 47, 44, 6, '#f2f2ee', false);
        s.rect(184, 120, 20, 34, '#7b7f80', false);
        s.rect(188, 124, 12, 8, '#cfd5d3', false);
        for (var d = 0; d < 3; d++) s.rect(188, 136 + d * 5, 12, 3, '#3f4345', false);
        for (var q = 0; q < 2; q++) s.rect(36 + q * 22, 112, 19, 30, '#c2c4c0', false);
      }
      // The slab overhead throws a soft shadow down the back wall: this is what says recess.
      s.rect(0, 0, S, 22, '#ffffff', true);
      var g = c.createLinearGradient(0, 22, 0, 84);
      g.addColorStop(0, 'rgba(46,32,22,0.5)');
      g.addColorStop(1, 'rgba(46,32,22,0)');
      c.fillStyle = g;
      c.fillRect(0, 22, S, 62);
      // Columns, lit on one cheek.
      s.rect(0, 22, Q, S - 22, '#ffffff', true);
      s.rect(S - Q, 22, Q, S - 22, '#ffffff', true);
      s.shade(0, 22, 12, S - 22, 'rgba(0,0,0,0.22)');
      s.shade(Q, 22, 8, floorY - 22, 'rgba(46,32,22,0.24)');
      s.shade(S - Q - 8, 22, 8, floorY - 22, 'rgba(46,32,22,0.16)');
      weather(s, 71 + v, 0.5);
    },
    /** A shop nobody mapped: a pale window with a display and a door. */
    shop: function (s, p, v) {
      shopFrame(s, '#2c2c2e');
      s.grad(8, 70, 176, 170, ['#e6dcc8', '#dde3dc'][v % 2], '#a89a86', false);
      s.shade(8, 70, 176, 16, 'rgba(0,0,0,0.16)');
      var tones = [['#b5563c', '#3f6f87', '#d9b45a'], ['#6b7f5c', '#c9856a', '#47506b']][v % 2];
      for (var i = 0; i < 3; i++) {
        s.rect(20 + i * 56, 196 - i * 14, 44, 44 + i * 14, tones[i], false);
        s.shade(20 + i * 56, 196 - i * 14, 44, 5, 'rgba(255,255,255,0.3)');
      }
      s.shade(8, 70, 60, 170, 'rgba(255,255,255,0.1)');
      shopDoor(s);
    },
    /** Roller shutter down: closed for the afternoon. */
    shop_shut: function (s) {
      shopFrame(s, '#2c2c2e');
      s.rect(6, 66, s.S - 12, 190, '#a8a9a7', false);
      for (var i = 66; i < s.S; i += 9) s.shade(6, i, s.S - 12, 2, 'rgba(0,0,0,0.25)');
      s.shade(6, 66, s.S - 12, 12, 'rgba(0,0,0,0.25)');
    },
    /** Cafe: warm room, lamps over a bar, a table and two chairs against the glass. */
    cafe: function (s, p, v) {
      var S = s.S;
      shopFrame(s, '#4a3120');
      s.grad(8, 70, S - 16, 170, '#f3cf94', '#8c5c34', false);
      s.rect(8, 134, S - 16, 8, '#5a3a22', false);
      s.rect(8, 142, S - 16, 44, '#a87446', false);
      for (var b = 0; b < 7; b++) s.rect(24 + b * 30, 112, 9, 22, ['#3d6b4e', '#7c2f28', '#c9a24a'][b % 3], false);
      var c = s.c;
      for (var l = 0; l < 3; l++) {
        var x = 50 + l * 78;
        s.rect(x - 1, 70, 2, 22, '#2a1c12', false);
        var g = c.createRadialGradient(x, 98, 1, x, 98, 26);
        g.addColorStop(0, 'rgba(255,240,200,0.95)');
        g.addColorStop(1, 'rgba(255,220,150,0)');
        c.fillStyle = g;
        c.fillRect(x - 26, 72, 52, 52);
        s.rect(x - 8, 92, 16, 5, '#2a1c12', false);
      }
      // Table and chairs, dark against the room
      var tx = v === 0 ? 84 : 150;
      s.rect(tx - 34, 196, 68, 6, '#2b1d13', false);
      s.rect(tx - 3, 202, 6, 38, '#2b1d13', false);
      s.rect(tx - 16, 238, 32, 4, '#2b1d13', false);
      for (var d = -1; d <= 1; d += 2) {
        var cx = tx + d * 50;
        s.rect(cx - 12, 208, 24, 5, '#3a2718', false);
        s.rect(cx + d * 10 - 2, 176, 4, 34, '#3a2718', false);
        s.rect(cx - 11, 212, 3, 30, '#3a2718', false);
        s.rect(cx + 8, 212, 3, 30, '#3a2718', false);
      }
      s.shade(8, 70, 54, 170, 'rgba(255,255,255,0.08)');
      s.rect(0, 240, S, 16, '#3a2718', false);
    },
    /** Grocer: crates of fruit tipped toward the street, shelves in the dim behind. */
    grocery: function (s) {
      var S = s.S;
      shopFrame(s, '#34463a');
      s.grad(6, 66, S - 12, 190, '#6a6152', '#3b352c', false);
      var bright = ['#d9583a', '#e8a33a', '#7fa646', '#e6cf56', '#b5563c'];
      for (var y = 84; y < 150; y += 24) {
        s.rect(6, y + 16, S - 12, 4, '#2a241c', false);
        for (var x = 12; x < S - 12; x += 13) s.rect(x, y + 2 + (x * 3 % 5), 9, 14 - (x * 3 % 5), bright[(x + y) % 5], false);
      }
      var c = s.c;
      var row = [[166, 0], [196, 1], [226, 2]];
      for (var r = 0; r < 3; r++) {
        var ry = row[r][0];
        for (var b = 0; b < 4 - (r === 0 ? 1 : 0); b++) {
          var bx = 8 + b * 61 + (r === 0 ? 30 : 0);
          s.rect(bx, ry + 10, 57, 20, '#a97d4c', false);
          s.shade(bx, ry + 17, 57, 2, 'rgba(0,0,0,0.3)');
          s.shade(bx, ry + 24, 57, 2, 'rgba(0,0,0,0.3)');
          var col = ['#d9583a', '#e8a33a', '#7fa646', '#e6cf56'][(b + r * 2) % 4];
          for (var q = 0; q < 6; q++) {
            c.fillStyle = col;
            c.beginPath();
            c.arc(bx + 7 + q * 9, ry + 8 + (q % 2) * 3, 6, 0, 6.2832);
            c.fill();
            c.fillStyle = 'rgba(255,255,255,0.3)';
            c.beginPath();
            c.arc(bx + 5 + q * 9, ry + 6 + (q % 2) * 3, 2, 0, 6.2832);
            c.fill();
          }
        }
      }
    },
    /** Bank: stone frame, one sheet of cold glass, a cash machine in the pier. */
    bank: function (s) {
      var S = s.S;
      shopFrame(s, '#c7c4bb');
      pane(s, 10, 70, 166, 176, '#a9c2d2', '#35495a');
      s.rect(92, 70, 3, 176, '#8f9aa1', false);
      s.shade(10, 70, 166, 150, 'rgba(255,255,255,0.05)');
      s.c.fillStyle = 'rgba(255,255,255,0.1)';
      s.c.beginPath();
      s.c.moveTo(20, 246);
      s.c.lineTo(84, 70);
      s.c.lineTo(126, 70);
      s.c.lineTo(62, 246);
      s.c.fill();
      s.rect(186, 96, 58, 96, '#9ea5a9', false);
      s.rect(194, 104, 42, 30, '#1e3f55', false);
      s.rect(198, 110, 34, 3, '#7fd0d8', false);
      s.rect(198, 118, 22, 3, '#7fd0d8', false);
      for (var i = 0; i < 9; i++) s.rect(198 + (i % 3) * 12, 142 + Math.floor(i / 3) * 10, 8, 6, '#54595c', false);
      s.rect(0, 246, S, 10, '#b7b3a9', false);
    },
    /** Pharmacy: bright white room, sparse boxes on glass shelves, the green cross. */
    pharmacy: function (s) {
      var S = s.S;
      shopFrame(s, '#eef0ec');
      s.grad(8, 70, 176, 170, '#fbfdfb', '#d3dfda', false);
      var boxes = ['#ffffff', '#cfe3ee', '#f2d3cf', '#d4ecd6', '#f3e7c0'];
      for (var y = 150; y < 236; y += 38) {
        s.rect(8, y, 176, 3, '#9fb5ae', false);
        for (var x = 16; x < 170; x += 22) {
          if ((x + y) % 5 === 0) continue;
          s.rect(x, y - 24 + (x % 3) * 3, 16, 24 - (x % 3) * 3, boxes[(x + y) % 5], false);
          s.shade(x, y - 4, 16, 4, 'rgba(0,0,0,0.1)');
        }
      }
      s.rect(62, 78, 60, 56, '#ffffff', false);
      s.rect(83, 84, 18, 44, '#1f9a5a', false);
      s.rect(70, 97, 44, 18, '#1f9a5a', false);
      shopDoor(s, '#cfd6d2');
    },
    /** Clothes: a pale room and two figures in the window. */
    clothes: function (s) {
      var S = s.S;
      shopFrame(s, '#1f2024');
      s.grad(8, 70, S - 16, 170, '#f6f1e8', '#cdc2b2', false);
      s.rect(8, 226, S - 16, 14, '#b4a896', false);
      s.rect(14, 92, S - 28, 4, '#6c645a', false);
      for (var h = 0; h < 11; h++) s.rect(120 + h * 11, 96, 7, 54, ['#2f4a6b', '#c9856a', '#e8dcc4', '#6b7f5c'][h % 4], false);
      var c = s.c;
      var figs = [[58, '#b5362c', '#2c3648'], [122, '#2f6f8f', '#e8dfd0']];
      for (var f = 0; f < 2; f++) {
        var x = figs[f][0];
        c.fillStyle = '#e4d6c6';
        c.beginPath();
        c.arc(x, 108, 11, 0, 6.2832);
        c.fill();
        s.rect(x - 3, 118, 6, 8, '#e4d6c6', false);
        c.fillStyle = figs[f][1];
        c.beginPath();
        c.moveTo(x - 22, 126);
        c.lineTo(x + 22, 126);
        c.lineTo(x + 16, 176);
        c.lineTo(x - 16, 176);
        c.fill();
        c.fillStyle = figs[f][2];
        c.beginPath();
        c.moveTo(x - 16, 176);
        c.lineTo(x + 16, 176);
        c.lineTo(x + 12, 226);
        c.lineTo(x + 2, 226);
        c.lineTo(x, 190);
        c.lineTo(x - 2, 226);
        c.lineTo(x - 12, 226);
        c.fill();
      }
      s.shade(8, 70, 40, 170, 'rgba(255,255,255,0.12)');
    },
    /** Rings of painted metal, cut into blocks. For a sculpture, not a wall: one tile spans several rings. Tinted, so never glass. */
    bands: function (s, p) {
      var S = s.S;
      var cols = p.colours || ['#e23a2a', '#f4bf22', '#1f6fd0', '#2fa35f'];
      var h = S / cols.length;
      s.rect(0, 0, S, S, '#3a3836', true);
      for (var i = 0; i < cols.length; i++) {
        var y = i * h;
        s.rect(0, y + 6, S, h - 12, cols[i], true);
        s.rect((i & 1) * S / 2, y + 6, S / 2, h - 12, cols[(i + 2) % cols.length], true);
        s.shade(0, y + 6, S, 7, 'rgba(255,255,255,0.3)');
        s.shade(0, y + h - 16, S, 10, 'rgba(0,0,0,0.28)');
      }
    },
    /** Lobby door and letter boxes, for walls with no shop. */
    lobby: function (s, p, v) {
      var S = s.S;
      s.rect(0, 0, S, S, '#ffffff', true);
      s.rect(60, 48, 136, 208, '#3f4a50', false);
      pane(s, 70, 58, 116, 190, '#8ea2ad', '#4e5b63');
      s.rect(126, 58, 4, 190, '#2f363a', false);
      s.rect(0, 232, S, 24, '#dcd6c8', true);
      weather(s, 81 + v, 1);
    },
    /** Plain plaster with a low dado. Used on side walls at ground level. */
    plain: function (s, p, v) {
      var S = s.S;
      s.rect(0, 0, S, S, '#ffffff', true);
      s.rect(0, 216, S, 40, '#dfd8ca', true);
      s.shade(0, 214, S, 3, 'rgba(0,0,0,0.2)');
      weather(s, 91 + v, 1.2);
    }
  };

  /** Tiles every map has, so a world with no content still draws. Content adds the city's own. */
  var BUILTIN = [
    { id: 'wall_default', paint: 'shutter', params: {}, variants: 1 },
    { id: 'ground_default', paint: 'pilotis', params: {}, variants: 1 },
    { id: 'shop_default', paint: 'shop', params: {}, variants: 1 }
  ];

  /** Paints one variant into the layer stack. */
  function paintLayer(surface, kit, variant, layerIndex) {
    var S = surface.S;
    var c = surface.c;
    var m = surface.m;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.clearRect(0, 0, S, S);
    m.fillStyle = '#000';
    m.fillRect(0, 0, S, S);
    var fn = typeof kit.paint === 'function' ? kit.paint : P[kit.paint];
    if (!fn && kit.asset) fn = P.plain;     // Stands until the packed tile arrives, and for good if it never does
    if (!fn) {
      TLV.registry.problem('kit', kit.id, 'no painter named ' + kit.paint);
      fn = P.plain;
    }
    try {
      fn(surface, kit.params || {}, variant);
    } catch (e) {
      TLV.registry.problem('kit', kit.id, 'painter threw: ' + (e && e.message));
      P.plain(surface, {}, 0);
    }
    var rgb = c.getImageData(0, 0, S, S).data;
    var msk = m.getImageData(0, 0, S, S).data;
    var o = layerIndex * S * S * 4;
    for (var i = 0, n = S * S * 4; i < n; i += 4) {
      data[o + i] = rgb[i];
      data[o + i + 1] = rgb[i + 1];
      data[o + i + 2] = rgb[i + 2];
      data[o + i + 3] = msk[i];
    }
  }

  /**
   * Bakes the array. Phase 2.
   * @returns {object} THREE.DataArrayTexture.
   */
  facades.init = function () {
    var T = TLV.tune.render;
    var S = T.facadeSize;
    var count = T.facadeLayers;
    data = new Uint8Array(S * S * 4 * count);
    layers = Object.create(null);
    used = 0;
    tilesWaiting = [];
    var surface = new Surface(S);
    var kit = BUILTIN.concat(TLV.render.styles.kit('facade.tile').slice().reverse());
    for (var i = 0; i < kit.length; i++) {
      var k = kit[i];
      var vars = k.variants || 1;
      if (used + vars > count) {
        TLV.registry.problem('kit', k.id, 'facade array is full');
        continue;
      }
      var first = used;
      for (var v = 0; v < vars; v++) paintLayer(surface, k, v, used++);
      layers[k.id] = { layer: first, vars: vars };
      if (k.asset) tilesWaiting.push({ id: k.id, asset: k.asset });
    }
    tex = new THREE.DataArrayTexture(data, S, S, count);
    tex.format = THREE.RGBAFormat;
    tex.type = THREE.UnsignedByteType;
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.magFilter = THREE.LinearFilter;
    tex.wrapS = THREE.RepeatWrapping;
    tex.wrapT = THREE.RepeatWrapping;
    tex.generateMipmaps = true;
    tex.anisotropy = 4;
    tex.needsUpdate = true;
    return tex;
  };

  /** @returns {object} The array texture. */
  facades.texture = function () {
    return tex;
  };

  /**
   * Layer of a tile.
   * @param {string} id Tile ID.
   * @returns {{layer:number, vars:number}} First layer and variant count. An unknown tile gets the default wall.
   */
  facades.layer = function (id) {
    return layers[id] || fallbackLayer;
  };

  /** @returns {number} Layers in use. */
  facades.used = function () {
    return used;
  };

  /**
   * Replaces a tile's first layer with a packed image, the `{asset}` form of a tile.
   * @param {string} id Tile ID.
   * @param {HTMLImageElement} img Decoded image.
   */
  facades.replace = function (id, img) {
    var L = layers[id];
    if (!L || !tex) return;
    var T = TLV.tune.render;
    var S = T.facadeSize;
    var cv = document.createElement('canvas');
    cv.width = cv.height = S;
    var c = cv.getContext('2d', { willReadFrequently: true });
    c.drawImage(img, 0, 0, S, S);
    var rgb = c.getImageData(0, 0, S, S).data;
    data.set(rgb, L.layer * S * S * 4);
    tex.needsUpdate = true;
  };

  /** Swaps in packed tiles as they arrive. */
  facades.frame = function () {
    for (var i = tilesWaiting.length - 1; i >= 0; i--) {
      var t = tilesWaiting[i];
      var state = TLV.render.assets.request(t.asset);
      if (state === 'ready') {
        facades.replace(t.id, TLV.render.assets.image(t.asset));
        tilesWaiting.splice(i, 1);
      } else if (state === 'failed' || state === 'absent') {
        tilesWaiting.splice(i, 1);
      }
    }
  };

  /** Frees the texture. */
  facades.dispose = function () {
    if (tex) tex.dispose();
    tex = null;
    data = null;
  };
})(window.TLV);
