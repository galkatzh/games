// js/ui/debug_overlay.js — WP-UI
// ?debug=1 shows the sim as numbers. ?dev=1 lists content and assets that did not resolve. TLV.debug.ui('debug') forces either on.
(function (TLV) {
  'use strict';

  var overlay = TLV.ns('ui.debugOverlay');

  var box = null;
  var devBox = null;
  var log = [];
  var counts = null;
  var since = 0;
  var devSince = 0;
  var frames = 0;
  var fps = 0;

  var COUNTED = {
    'traffic.spawn': 'carsIn', 'traffic.despawn': 'carsOut', 'traffic.behaviour': 'behaviours',
    'ped.spawn': 'pedsIn', 'ped.despawn': 'pedsOut', 'incident.end': 'incidents'
  };

  /** Builds the panels, hidden until asked for. */
  overlay.build = function (root) {
    box = TLV.ui.el('pre', 'debug-panel off', root);
    box.dir = 'ltr';
    devBox = TLV.ui.el('pre', 'dev-panel off', root);
    devBox.dir = 'ltr';
    log = [];
    counts = { carsIn: 0, carsOut: 0, behaviours: 0, pedsIn: 0, pedsOut: 0, incidents: 0 };
  };

  /**
   * Reacts to one event.
   * @param {object} S Sim state.
   * @param {string} name Event name.
   * @param {object} p Payload.
   */
  overlay.onEvent = function (S, name, p) {
    var field = COUNTED[name];
    if (field) counts[field]++;
    if (name === 'traffic.spawn' || name === 'traffic.despawn' || name === 'ped.spawn' || name === 'ped.despawn' || name === 'traffic.behaviour') return;
    log.push(name + (name === 'incident.end' ? ' ' + p.defId + ' ' + p.outcome : ''));
    if (log.length > TLV.tune.ui.debugLogMax) log.shift();
  };

  function fmt(v, d) {
    return typeof v === 'number' && Number.isFinite(v) ? v.toFixed(d) : String(v);
  }

  function renderLine() {
    if (!TLV.render || !TLV.render.info) return 'render  none';
    var r = TLV.render.info();
    return 'render  calls ' + r.calls + '  tris ' + r.triangles + '  chunks ' + r.chunksBuilt + '/' + r.chunksTotal + '  ' + r.quality;
  }

  function text(S) {
    var s = TLV.debug.state();
    var p = s.player;
    return [
      'fps     ' + fps.toFixed(1) + '   tick ' + s.tick + '   t ' + fmt(s.t, 1) + '   seed ' + s.seed,
      'phase   ' + s.phase + ' ' + fmt(s.phaseT, 1) + '   errand ' + (s.errandIndex + 1) + ' ' + s.errandId,
      'clock   ' + fmt(s.clock, 1) + '   money ' + fmt(s.money, 0) + '   hp ' + fmt(s.hp, 0) + '   heat ' + fmt(s.heat, 2),
      'player  ' + p.mode + ' ' + fmt(p.x, 1) + ',' + fmt(p.y, 1) + ' h ' + fmt(p.h, 2) + ' v ' + fmt(p.v, 1) + ' lane ' + p.laneId + ' surf ' + p.surface + (p.wrongWay ? ' WRONG' : ''),
      'cars    ' + s.counts.vehicles + '/' + s.counts.target + '   peds ' + s.counts.peds + '   mean ' + fmt(s.traffic.meanSpeed, 1) + ' m/s   stopped ' + fmt(s.traffic.stationaryShare, 2),
      'spawns  cars +' + counts.carsIn + ' -' + counts.carsOut + '  peds +' + counts.pedsIn + ' -' + counts.pedsOut + '  beh ' + counts.behaviours,
      'contest ' + (s.contest ? s.contest.state + ' rage ' + fmt(s.contest.rage, 0) + ' ' + s.contest.tier : '-'),
      'knife   ' + (s.knife ? s.knife.stage + ' strikes ' + s.knife.strikes + ' gap ' + fmt(s.knife.gap, 1) + ' ' + s.knife.exit : '-'),
      'chain   ' + s.chain.n + ' x' + fmt(s.chain.mult, 1) + ' bank ' + fmt(s.chain.bank, 0) + '   park ' + s.park.stage + ' ' + s.park.kind + ' ' + fmt(s.park.bar, 2),
      'staged  ' + s.incidents.map(function (i) { return i.defId + ':' + i.state; }).join(' '),
      renderLine(),
      'checks  problems ' + s.problems + '   invariants ' + s.invariantFailures + '   lang ' + TLV.ui.strings.lang() + '   mode ' + TLV.ui.menus.difficulty(),
      'events  ' + log.slice(-TLV.tune.ui.debugLogMax).join(' | '),
      S ? '' : ''
    ].join('\n');
  }

  function devText() {
    var problems = TLV.registry.problems();
    var lines = ['Unresolved content and assets: ' + problems.length];
    problems.slice(0, 40).forEach(function (row) {
      lines.push(row.type + ' ' + row.id + ': ' + row.reason);
    });
    return lines.join('\n');
  }

  /**
   * Draws one frame. The text only refreshes a few times a second, so reading it costs nothing.
   * @param {object} S Sim state.
   * @param {number} dtReal Real seconds.
   */
  overlay.frame = function (S, dtReal) {
    var T = TLV.tune.ui;
    var showDebug = !!S.params.debug || TLV.ui.isForced('debug');
    var showDev = !!S.params.dev || TLV.ui.isForced('dev');
    TLV.ui.show(box, showDebug);
    TLV.ui.show(devBox, showDev);
    since += dtReal;
    devSince += dtReal;
    frames++;
    if (since >= T.debugRefreshS) {
      fps = frames / since;
      frames = 0;
      since = 0;
      if (showDebug) box.textContent = text(S);
    }
    if (showDev && (devSince >= T.devRefreshS || !devBox.textContent)) {
      devSince = 0;
      devBox.textContent = devText();
    }
  };
})(window.TLV);
