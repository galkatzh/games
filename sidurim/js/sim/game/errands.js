// js/sim/game/errands.js — WP-GAME
// Errand definitions, the plan for a day, and binding a definition to a real door by the ladder of GAME_DESIGN 6. Binding routes a
// few doors per rung and allocates freely: it runs once an errand, on the CARD tick.
(function (TLV) {
  'use strict';

  var errands = TLV.ns('game.errands');

  // Read-only content registries, filled at drain (ARCHITECTURE 3).
  var defs = [];
  var byId = Object.create(null);
  var spawns = [];

  /** @returns {boolean} True when a value is a {he, en} pair of strings. */
  function isText(t) {
    return !!t && typeof t.en === 'string' && typeof t.he === 'string';
  }

  /** @returns {?string} Why an errand definition cannot be used, or null. */
  function badDef(def) {
    if (!def || typeof def.id !== 'string' || !def.id) return 'no id';
    if (byId[def.id]) return 'duplicate id';
    if (def.tier !== 1 && def.tier !== 2 && def.tier !== 3 && def.tier !== 'finale') return 'bad tier';
    if (!def.target) return 'no target';
    var kinds = def.target.kinds;
    if (kinds !== 'residential_door' && !(Array.isArray(kinds) && kinds.length)) return 'no target kinds';
    if (!isText(def.text)) return 'text needs he and en';
    return null;
  }

  /**
   * Queue handler for 'errand' items.
   * @param {object} def ErrandDef, ARCHITECTURE 14.5.
   */
  errands.onDef = function (def) {
    var why = badDef(def);
    if (why) {
      TLV.registry.problem('errand', def && def.id !== undefined ? String(def.id) : '?', why);
      return;
    }
    byId[def.id] = def;
    defs.push(def);
  };

  /**
   * Queue handler for 'spawn' items.
   * @param {object} def SpawnDef, ARCHITECTURE 14.6.
   */
  errands.onSpawn = function (def) {
    if (!def || typeof def.map !== 'string' || !def.anchor) {
      TLV.registry.problem('spawn', def && def.map ? String(def.map) : '?', 'needs a map and an anchor');
      return;
    }
    spawns.push(def);
  };

  /** @returns {object[]} Every errand definition, in queue order. */
  errands.defs = function () {
    return defs.slice();
  };

  /** Picks one definition by weight from a list. */
  function draw(rng, list) {
    var total = 0;
    var i;
    for (i = 0; i < list.length; i++) total += list[i].weight > 0 ? list[i].weight : 1;
    var u = rng.next() * total;
    for (i = 0; i < list.length; i++) {
      u -= list[i].weight > 0 ? list[i].weight : 1;
      if (u < 0) return list[i];
    }
    return list[list.length - 1];
  }

  /** @returns {object[]} Unused definitions of a tier. */
  function unused(tier, used) {
    return defs.filter(function (d) {
      return d.tier === tier && !used[d.id];
    });
  }

  /**
   * The seven definitions of a day: milk, then tiers 1, 2, 2, 3, 3, then the finale, with no repeats (GAME_DESIGN 6).
   * @param {object} S Sim state.
   * @returns {string[]} Def ids, one per errand. Shorter only if the content has too few.
   */
  errands.plan = function (S) {
    var T = TLV.tune.game;
    var rng = S.rng.game;
    var used = {};
    var out = [];
    var finale = unused('finale', used)[0] || null;
    if (finale) used[finale.id] = true;
    for (var i = 0; i < T.tiers.length - 1; i++) {
      var pick = i === 0 && byId.milk ? byId.milk : null;
      if (!pick) {
        var list = unused(T.tiers[i], used);
        if (!list.length) {
          list = defs.filter(function (d) { return d.tier !== 'finale' && !used[d.id]; });
        }
        if (!list.length) continue;
        pick = draw(rng, list);
      }
      used[pick.id] = true;
      out.push(pick.id);
    }
    if (finale) out.push(finale.id);
    return out;
  };

  /** Eligible POIs by kind, and residential doors for the gan, built once per sim. */
  function targets(S) {
    if (S._gameTargets) return S._gameTargets;
    var W = S.world;
    var T = TLV.tune.game;
    var POIF = TLV.const.POIF;
    var spatial = TLV.world.spatial;
    var byKind = Object.create(null);
    for (var i = 0; i < W.pois.length; i++) {
      var p = W.pois[i];
      if (p.flags & (POIF.SENSITIVE | POIF.NO_FACADE)) continue;
      if (spatial.sensitiveNear(W, p.x, p.y, T.sensitiveM) || spatial.sensitiveNear(W, p.entX, p.entY, T.sensitiveM)) continue;
      if (!byKind[p.kind]) byKind[p.kind] = [];
      byKind[p.kind].push(i);
    }
    S._gameTargets = { byKind: byKind, gan: null };
    return S._gameTargets;
  }

  /** @returns {number[]} Edge ids where a synthetic gan door can stand. */
  function ganEdges(S) {
    var t = targets(S);
    if (t.gan) return t.gan;
    var W = S.world;
    var T = TLV.tune.game;
    var out = [];
    var at = { x: 0, y: 0, h: 0 };
    for (var i = 0; i < W.edges.length; i++) {
      var e = W.edges[i];
      if (e.cls !== T.ganClass || e.len < T.ganEdgeMinM) continue;
      TLV.math.polyAt(e.px, e.py, e.cum, e.len / 2, at);
      if (TLV.world.spatial.sensitiveNear(W, at.x, at.y, T.sensitiveM)) continue;
      out.push(i);
    }
    t.gan = out;
    return out;
  }

  /**
   * The route from a pose to the lanes beside a door. The nearest lane is not always the nearest by road (559 against 856 m on
   * the pinned door), so several are tried.
   * @returns {?{route:object,laneId:number,s:number}} Shortest route found.
   */
  function doorRoute(S, from, x, y) {
    var W = S.world;
    var T = TLV.tune.game;
    var ids = S._gameLanes || (S._gameLanes = new Int32Array(64));
    var n = TLV.world.lanes.lanesNear(W, x, y, T.doorLaneReachM, ids);
    var ai = TLV.const.LF.AI_ROUTABLE;
    var pr = { s: 0, d: 0, side: 0 };
    var list = [];
    var anyAi = false;
    var i;
    for (i = 0; i < n; i++) {
      var lane = W.lanes[ids[i]];
      TLV.math.polyProject(lane.px, lane.py, lane.cum, x, y, -1, pr);
      var isAi = (lane.flags & ai) !== 0;
      if (isAi) anyAi = true;
      list.push({ id: lane.id, s: pr.s, d: pr.d, ai: isAi, de: lane.dirEdge });
    }
    list = list.filter(function (l) { return l.ai || !anyAi; });
    list.sort(function (a, b) { return a.d - b.d || a.id - b.id; });
    var best = null;
    var seen = {};
    var tried = 0;
    for (i = 0; i < list.length && tried < T.doorLanes; i++) {
      var c = list[i];
      if (seen[c.de]) continue;
      seen[c.de] = true;
      tried++;
      var route = TLV.world.routing.route(W, from.x, from.y, from.h, c.id, c.s, {});
      if (route && (!best || route.len < best.route.len)) best = { route: route, laneId: c.id, s: c.s };
    }
    return best;
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

  /** @returns {{x:number,y:number,poi:number,edge:number}} A POI as a door candidate. */
  function poiDoor(W, id) {
    var p = W.pois[id];
    return { x: p.entX, y: p.entY, poi: id, edge: p.edge };
  }

  /** Shuffled door candidates of some kinds, named first when the definition prefers names. */
  function poiCandidates(S, kinds, named) {
    var W = S.world;
    var t = targets(S);
    var ids = [];
    for (var i = 0; i < kinds.length; i++) ids = ids.concat(t.byKind[kinds[i]] || []);
    // A shared board gives each door to one errand, so the doors it has already handed out are left alone.
    var taken = S._boardTaken;
    if (taken) ids = ids.filter(function (id) { return !taken[id]; });
    var list = shuffled(S.rng.game, ids);
    var NAMED = TLV.const.POIF.NAMED;
    if (named === 'require') list = list.filter(function (id) { return W.pois[id].flags & NAMED; });
    if (named === 'prefer') {
      list = list.filter(function (id) { return W.pois[id].flags & NAMED; }).concat(list.filter(function (id) { return !(W.pois[id].flags & NAMED); }));
    }
    return list.map(function (id) { return poiDoor(W, id); });
  }

  /** Shuffled synthetic gan doors: mid-edge, on a side with a sidewalk, clear of walls. */
  function ganCandidates(S) {
    var W = S.world;
    var T = TLV.tune.game;
    var at = { x: 0, y: 0, h: 0 };
    var out = [];
    var list = shuffled(S.rng.game, ganEdges(S));
    for (var i = 0; i < list.length; i++) {
      var e = W.edges[list[i]];
      TLV.math.polyAt(e.px, e.py, e.cum, e.len / 2, at);
      var left = e.swL >= e.swR;
      var off = left ? e.kerbOffL + e.swL / 2 : -(e.kerbOffR + e.swR / 2);
      var x = at.x - Math.sin(at.h) * off;
      var y = at.y + Math.cos(at.h) * off;
      if (TLV.world.spatial.pointInBuilding(W, x, y) >= 0) continue;
      // ganEdges read the road's middle, and the door stands a sidewalk off it.
      if (TLV.world.spatial.sensitiveNear(W, x, y, T.sensitiveM)) continue;
      out.push({ x: x, y: y, poi: -1, edge: list[i] });
    }
    return out;
  }

  /** @returns {?object} First door whose route falls in [lo, hi], and its route. */
  function firstIn(S, list, from, lo, hi) {
    var T = TLV.tune.game;
    var crowMin = Math.max(T.doorMinM, lo / T.routeOverCrow);
    var tries = 0;
    for (var i = 0; i < list.length && tries < T.rungTries; i++) {
      var d = list[i];
      var crow = TLV.math.dist(d.x, d.y, from.x, from.y);
      if (crow < crowMin || crow > hi) continue;
      tries++;
      var found = doorRoute(S, from, d.x, d.y);
      if (found && found.route.len >= lo && found.route.len <= hi) return { door: d, found: found };
    }
    return null;
  }

  /** Rung 4: the door nearest the leg, from 300 m to 1.6 legs. */
  function nearestTo(S, list, from, leg) {
    var T = TLV.tune.game;
    var best = null;
    var bestOff = Infinity;
    var hi = leg * T.rung4MaxShare;
    var tries = 0;
    for (var i = 0; i < list.length && tries < T.rungTries; i++) {
      var d = list[i];
      var crow = TLV.math.dist(d.x, d.y, from.x, from.y);
      if (crow < T.doorMinM || crow > hi) continue;
      tries++;
      var found = doorRoute(S, from, d.x, d.y);
      if (!found || found.route.len < T.rung4MinM || found.route.len > hi) continue;
      var off = Math.abs(found.route.len - leg);
      if (off < bestOff) {
        bestOff = off;
        best = { door: d, found: found };
      }
    }
    return best;
  }

  /** Rungs 1 to 4 for one definition. */
  function ladder(S, def, from, leg) {
    var T = TLV.tune.game;
    var named = def.target.named || 'prefer';
    if (def.target.kinds === 'residential_door') {
      var gan = ganCandidates(S);
      return firstIn(S, gan, from, leg * (1 - T.legTight), leg * (1 + T.legTight)) ||
        firstIn(S, gan, from, leg * (1 - T.legWide), leg * (1 + T.legWide)) || nearestTo(S, gan, from, leg);
    }
    var kinds = poiCandidates(S, def.target.kinds, named);
    var fall = poiCandidates(S, def.fallbackKinds || [], named);
    return firstIn(S, kinds, from, leg * (1 - T.legTight), leg * (1 + T.legTight)) ||
      firstIn(S, kinds, from, leg * (1 - T.legWide), leg * (1 + T.legWide)) ||
      firstIn(S, fall, from, leg * (1 - T.legWide), leg * (1 + T.legWide)) ||
      nearestTo(S, kinds, from, leg) || nearestTo(S, fall, from, leg);
  }

  /** A pinned definition, if its anchor resolves here to a door the content guards allow. */
  function pinned(S, def, from) {
    var anchor = def.target.anchor;
    if (!anchor) return null;
    var W = S.world;
    var T = TLV.tune.game;
    var res = TLV.anchors.resolve(W, anchor, { type: 'poi' });
    if (!res || res.id < 0) return null;
    var list = targets(S).byKind[W.pois[res.id].kind] || [];
    if (list.indexOf(res.id) < 0) return null;
    var door = poiDoor(W, res.id);
    if (TLV.math.dist(door.x, door.y, from.x, from.y) < T.doorMinM) return null;
    var found = doorRoute(S, from, door.x, door.y);
    return found ? { door: door, found: found } : null;
  }

  /**
   * Rung 6, past every limit the ladder keeps: any door of the definition, tried in order of how near it stands to the distance a leg
   * covers, and the route nearest the leg wins, however long. On seed 304 the car stands where most routes run 2.3 km, and the 12 tries
   * of each rung above can all miss the few that fit.
   * @returns {?object} A door and its route.
   */
  function widest(S, list, from, leg) {
    var T = TLV.tune.game;
    var near = list.filter(function (d) {
      return TLV.math.dist(d.x, d.y, from.x, from.y) >= T.doorMinM;
    });
    function off(d) {
      return Math.abs(TLV.math.dist(d.x, d.y, from.x, from.y) - leg / T.rescueRouteOverCrow);
    }
    near.sort(function (a, b) { return off(a) - off(b); });
    var best = null;
    var bestOff = Infinity;
    for (var i = 0; i < near.length && i < T.rescueTries; i++) {
      var found = doorRoute(S, from, near[i].x, near[i].y);
      if (!found) continue;
      var miss = Math.abs(found.route.len - leg);
      if (miss < bestOff) {
        bestOff = miss;
        best = { door: near[i], found: found };
      }
      if (miss <= leg * T.legWide) break;
    }
    return best;
  }

  /**
   * Rung 7: a door made for the occasion, on the sidewalk behind a safe stall. It takes no POI, so it needs a name of its own, and the
   * gan keeps its usual one. Stalls on the gan's class of street come first for the gan.
   * @returns {?object} A door and its route.
   */
  function stallDoor(S, def, from) {
    var W = S.world;
    var T = TLV.tune.game;
    var world = TLV.world.parking;
    var gan = def.target.kinds === 'residential_door';
    var ids = [];
    world.spotsNear(W, from.x, from.y, T.rescueStallM, ids);
    var list = [];
    for (var i = 0; i < ids.length; i++) {
      var spot = world.spot(W, ids[i]);
      if (!TLV.game.parking._bayFit(S, spot)) continue;
      var far = TLV.math.dist(spot.x, spot.y, from.x, from.y);
      list.push({ spot: spot, far: far < T.doorMinM ? 1 : 0, cls: gan && W.edges[spot.edge].cls !== T.ganClass ? 1 : 0, d: far });
    }
    list.sort(function (a, b) { return a.cls - b.cls || a.far - b.far || a.d - b.d || a.spot.id - b.spot.id; });
    for (var k = 0; k < list.length && k < T.rescueTries; k++) {
      var sp = list[k].spot;
      var route = TLV.world.routing.route(W, from.x, from.y, from.h, sp.laneId, sp.laneS, {});
      if (!route) continue;
      var side = TLV.game.parking._curbSign(W, sp) * (sp.wid / 2 + T.rescueDoorBackM);
      var x = sp.x - Math.sin(sp.h) * side;
      var y = sp.y + Math.cos(sp.h) * side;
      var open = TLV.world.spatial.pointInBuilding(W, x, y) < 0;
      var door = { x: open ? x : sp.x, y: open ? y : sp.y, poi: -1, edge: sp.edge };
      if (!gan) door.name = T.rescueName;
      return { door: door, found: { route: route, laneId: sp.laneId, s: sp.laneS } };
    }
    return null;
  }

  /**
   * The last rungs. The day has seven errands and the gan is the point of it, so a definition only comes back empty on a map with no
   * way to reach a stall. A car stranded off the road can route to nothing, and the player can still drive there, so such a leg is laid
   * out from the run's spawn. Nav copes with no route from the car until it reaches a road.
   * @returns {?object} A door and its route.
   */
  function rescue(S, def, from, leg) {
    var kinds = def.target.kinds;
    var list = kinds === 'residential_door' ? ganCandidates(S) : poiCandidates(S, kinds.concat(def.fallbackKinds || []), 'any');
    var hit = widest(S, list, from, leg) || stallDoor(S, def, from);
    if (hit) return hit;
    var start = errands.spawnPoint(S);
    return start ? widest(S, list, start, leg) || stallDoor(S, def, start) : null;
  }

  /**
   * Fills {poi} per language (GAME_DESIGN 6, and an owner decision since). Hebrew: that name, the English name, then the kind label.
   * English: that name, then the kind label, and never a Hebrew name, which a reader of English cannot match to any sign.
   */
  function nameFor(W, poiId) {
    var T = TLV.tune.game;
    if (poiId < 0) return { he: T.ganName.he, en: T.ganName.en };
    var p = W.pois[poiId];
    var label = T.kindLabels[p.kind] || { he: p.kind, en: p.kind };
    return {
      he: p.nameHe || p.nameEn || label.he,
      en: p.nameEn || label.en
    };
  }

  errands._nameFor = nameFor;

  /** Turns a chosen door into an Errand (ARCHITECTURE 10.9). */
  function make(S, def, index, hit) {
    var W = S.world;
    var name = hit.door.name || nameFor(W, hit.door.poi);
    return {
      index: index,
      defId: def.id,
      text: { he: def.text.he.split('{poi}').join(name.he), en: def.text.en.split('{poi}').join(name.en) },
      poiId: hit.door.poi,
      name: name,
      doorX: hit.door.x,
      doorY: hit.door.y,
      routeLen: hit.found.route.len,
      award: 0,
      bayId: -1,
      decoys: [],
      contests: 0,
      quality: null,
      parkMethod: null,
      pay: null,
      mod: null,
      _doorRoute: hit.found.route,
      _doorLane: hit.found.laneId,
      _doorLaneS: hit.found.s,
      _doorEdge: hit.door.edge,
      _doorM: Infinity,
      _noContest: false
    };
  }

  /**
   * Binds an errand of the plan to a door. The gan keeps its slot whatever it takes, because a day is never won without the pickup.
   * @param {object} S Sim state. S.game._g.from holds the pose the leg starts from.
   * @param {number} index 0-based errand.
   * @returns {?object} Errand, or null only on a map with no stall a route can reach.
   */
  errands.bind = function (S, index) {
    var g = S.game;
    var gg = g._g;
    var T = TLV.tune.game;
    if (!S.world) return null;
    var leg = T.legs[Math.min(index, T.legs.length - 1)];
    var def = byId[gg.plan[index]] || null;
    var from = gg.from;
    if (def) {
      var hit = pinned(S, def, from) || ladder(S, def, from, leg);
      if (hit) return make(S, def, index, hit);
    }
    // Rung 5: another unused definition of the tier, then of any tier. Never the finale's slot.
    var used = {};
    gg.plan.forEach(function (id) { used[id] = true; });
    var tier = def ? def.tier : T.tiers[index];
    var finale = !!def && def.tier === 'finale';
    var pool = finale ? [] : defs.filter(function (d) { return !used[d.id] && d.tier === tier; })
      .concat(defs.filter(function (d) { return !used[d.id] && d.tier !== tier && d.tier !== 'finale'; }));
    for (var i = 0; i < pool.length; i++) {
      var other = ladder(S, pool[i], from, leg);
      if (other) {
        gg.plan[index] = pool[i].id;
        return make(S, pool[i], index, other);
      }
    }
    var last = def || pool[0] || null;
    var saved = last ? rescue(S, last, from, leg) : null;
    if (!saved) return null;
    gg.plan[index] = last.id;
    return make(S, last, index, saved);
  };

  /** @returns {?object} A definition by id. Private to this package. */
  errands._def = function (id) {
    return byId[id] || null;
  };

  /**
   * One row of a shared board (GAME_DESIGN 26): a definition bound to a door a leg away from a pose, by the same ladder a day uses.
   * A row is plain data, so the peer who makes the board can send it, and every peer stands the same errand at the same door.
   * @param {object} S Sim state.
   * @param {object} def Errand definition.
   * @param {{x:number,y:number,h:number}} from The pose the leg is measured from.
   * @param {number} leg Metres of route wanted.
   * @param {Object<number,boolean>} taken POIs other rows hold. The row's own is added.
   * @returns {?{defId:string,poi:number,x:number,y:number,edge:number,name:?object}} Null when no door can be reached.
   */
  errands._boardRow = function (S, def, from, leg, taken) {
    S._boardTaken = taken;
    var hit = null;
    try {
      hit = pinned(S, def, from);
      if (hit && taken[hit.door.poi]) hit = null;
      hit = hit || ladder(S, def, from, leg) || rescue(S, def, from, leg);
    } finally {
      S._boardTaken = null;
    }
    if (!hit) return null;
    if (hit.door.poi >= 0) taken[hit.door.poi] = true;
    return { defId: def.id, poi: hit.door.poi, x: hit.door.x, y: hit.door.y, edge: hit.door.edge, name: hit.door.name || null };
  };

  /**
   * The road from a pose to a board row's door.
   * @returns {?{route:object,laneId:number,s:number}} Null when it cannot be reached from there.
   */
  errands._rowRoute = function (S, row, from) {
    return doorRoute(S, from, row.x, row.y);
  };

  /**
   * Stands a board row up as an Errand, routed from a pose.
   * @param {object} S Sim state.
   * @param {object} row A row of errands._boardRow, as sent.
   * @param {number} index The errand's place in this driver's day.
   * @param {{x:number,y:number,h:number}} from Where the leg starts.
   * @returns {?object} Errand, or null for an unknown definition or a door with no road to it.
   */
  errands._fromRow = function (S, row, index, from) {
    var def = byId[row.defId];
    if (!def || !S.world) return null;
    var found = doorRoute(S, from, row.x, row.y);
    if (!found) return null;
    var door = { x: row.x, y: row.y, poi: row.poi, edge: row.edge };
    if (row.name) door.name = row.name;
    return make(S, def, index, { door: door, found: found });
  };

  /** @returns {{he:string,en:string}} A board row's errand in words, with its door's name in place. */
  errands._rowText = function (S, row) {
    var def = byId[row.defId];
    var name = errands._rowName(S, row);
    return { he: def.text.he.split('{poi}').join(name.he), en: def.text.en.split('{poi}').join(name.en) };
  };

  /** @returns {{he:string,en:string}} What a board row's door is called. */
  errands._rowName = function (S, row) {
    return row.name || nameFor(S.world, row.poi);
  };

  /** Walks forward from a directed edge through PASS junctions to the first SIGNAL. @returns {?object} DirEdge that ends there. */
  function toSignal(W, deId) {
    var de = W.dirEdges[deId];
    for (var hops = 0; de && hops < 16; hops++) {
      var j = W.juncs[de.to];
      if (j.kind === 'SIGNAL') return de;
      if (j.kind !== 'PASS' || !de.moves.length) return null;
      de = W.dirEdges[de.moves[0]];
    }
    return null;
  }

  /** The pose of a spawn definition on this map, or null. */
  function fromDef(W, def) {
    var res = TLV.anchors.resolve(W, def.anchor, { type: 'edge' });
    if (!res || res.id < 0) return null;
    var edge = W.edges[res.id];
    var start = edge.lanesF > 0 ? res.id * 2 : res.id * 2 + 1;
    var de = toSignal(W, start);
    if (!de) return null;
    var lane = W.lanes[de.lanes[0]];
    var s = Math.max(TLV.tune.game.spawnMinS, lane.len - (def.sFromEnd || 0));
    var at = TLV.world.lanes.pointAt(W, lane.id, s, {});
    return {
      x: at.x, y: at.y, h: at.h, laneId: lane.id, s: s,
      connId: lane.conns.length ? lane.conns[0] : -1,
      greenInS: def.greenInS || 0,
      tailCar: !!def.tailCar
    };
  }

  /**
   * Where a run starts. Reads only S.world, S.params and spawn definitions, because player.init runs before S.game exists.
   * @param {object} S Sim state.
   * @returns {?{x:number,y:number,h:number,laneId:number,s:number,connId:number}} Pose; also greenInS and tailCar from the definition.
   */
  errands.spawnPoint = function (S) {
    var W = S.world;
    if (!W) return null;
    var forced = S.params && S.params.spawn;
    if (forced) {
      var near = TLV.world.lanes.project(W, forced.x, forced.y, forced.h, TLV.tune.game.recoverReachM, {});
      return {
        x: forced.x, y: forced.y, h: forced.h, laneId: near ? near.laneId : -1, s: near ? near.s : 0,
        connId: -1, greenInS: 0, tailCar: false
      };
    }
    for (var i = 0; i < spawns.length; i++) {
      if (spawns[i].map !== W.id) continue;
      var sp = fromDef(W, spawns[i]);
      if (sp) return sp;
    }
    var ai = TLV.const.LF.AI_ROUTABLE;
    for (var k = 0; k < W.lanes.length; k++) {
      var lane = W.lanes[k];
      if (!(lane.flags & ai)) continue;
      var at = TLV.world.lanes.pointAt(W, k, lane.len / 2, {});
      return { x: at.x, y: at.y, h: at.h, laneId: k, s: lane.len / 2, connId: -1, greenInS: 0, tailCar: false };
    }
    return null;
  };
})(window.TLV);
