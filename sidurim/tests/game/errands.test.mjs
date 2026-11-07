// tests/game/errands.test.mjs — WP-GAME
// ARCHITECTURE 19 item 1 on tlv_center, through the real flow: a day of 7 errands for 100 seeds.
import test from 'node:test';
import { assert, realTLV, sim, step, until, toDrive, nextErrand, events, bayOf } from './helpers.mjs';

const TLV = realTLV();
const W = TLV.world.get('tlv_center');
const POIF = TLV.const.POIF;
const defOf = (id) => TLV.game.errands.defs().find((d) => d.id === id);

function checkErrand(S, e, from, seen) {
  const def = defOf(e.defId);
  assert.ok(def, e.defId);
  assert.equal(e.index, S.game.errandIndex);
  assert.ok(!e.text.en.includes('{poi}') && !e.text.he.includes('{poi}'));
  if (e.poiId >= 0) {
    const poi = W.pois[e.poiId];
    assert.equal(poi.flags & POIF.SENSITIVE, 0, 'sensitive POI bound');
    assert.equal(poi.flags & POIF.NO_FACADE, 0, 'NO_FACADE POI bound');
    assert.ok([...def.target.kinds, ...(def.fallbackKinds || [])].includes(poi.kind), `${poi.kind} for ${e.defId}`);
    assert.equal(e.doorX, poi.entX);
  } else {
    assert.equal(e.defId, 'gan_pickup');
    assert.equal(e.name.en, 'the gan');
    assert.equal(TLV.world.spatial.sensitiveNear(W, e.doorX, e.doorY, 60), false, 'the gan is 60 m from anything sensitive');
    assert.equal(W.edges[e._doorEdge].cls, 4, 'on a residential edge');
  }
  assert.ok(Math.hypot(e.doorX - from.x, e.doorY - from.y) >= 220, `door ${Math.hypot(e.doorX - from.x, e.doorY - from.y).toFixed(0)} m from the start`);
  if (e.bayId >= 0) {
    const bay = bayOf(S);
    assert.equal(TLV.world.spatial.sensitiveNear(W, bay.x, bay.y, 60), false, 'bay within 60 m of a sensitive POI');
    assert.ok(bay.paint !== TLV.const.PAINT.RED_WHITE && bay.paint !== TLV.const.PAINT.RED_YELLOW, 'a bay is blue/white or grey');
    assert.ok(W.lanes[bay.laneId].flags & TLV.const.LF.AI_ROUTABLE);
    assert.equal(TLV.world.parking.state(S, bay.id), TLV.const.OCC.FREE);
  }
  assert.ok(e.routeLen > 0 && e.award > 0);
  seen.add(e.defId);
}

test('item 1: 100 seeds give 7 errands ending in gan_pickup, with every guard held', () => {
  const kinds = new Map();
  let noContestBay = 0;
  let total = 0;
  for (let seed = 1; seed <= 100; seed++) {
    const S = sim({ seed });
    const seen = new Set();
    const plan = S.game._g.plan;
    assert.equal(plan.length, 7);
    assert.equal(new Set(plan).size, 7, 'no repeats');
    assert.equal(plan[6], 'gan_pickup');
    for (let i = 0; i < 6; i++) assert.notEqual(defOf(plan[i]).tier, 'finale', `seed ${seed}: the finale only ends the day`);
    for (let i = 0; i < 7; i++) {
      const g = S.game;
      assert.notEqual(g.phase, 'RUN_END', `seed ${seed}: run ended on errand ${i}: ${g.endReason}`);
      assert.equal(g.errandIndex, i, `seed ${seed}: errand ${i} was skipped`);
      assert.ok(g.errand, 'bound');
      checkErrand(S, g.errand, g._g.from, seen);
      if (g.errand._noContest) noContestBay++;
      total++;
      kinds.set(g.errand.defId, (kinds.get(g.errand.defId) || 0) + 1);
      g.clock = 500;
      toDrive(S);
      if (i < 6) nextErrand(S, { quality: 'GOOD' });
    }
    assert.equal(S.game.errand.defId, 'gan_pickup');
    assert.deepEqual([...new Set(S.game._g.plan)].length, 7);
  }
  console.log(`errands: ${total} bound, ${noContestBay} on the plain fallback bay, by def ${JSON.stringify(Object.fromEntries(kinds))}`);
  assert.equal(total, 700);
  assert.equal(TLV.game.errands.defs().length, 12);
});

test('each game is its own day: any errand can come first, in any order, and the gan always ends it', () => {
  const first = new Map();
  const days = new Set();
  const slots = Array.from({ length: 6 }, () => new Set());
  const all = TLV.game.errands.defs().filter((d) => d.tier !== 'finale').map((d) => d.id);
  for (let seed = 1; seed <= 200; seed++) {
    const S = sim({ seed });
    const plan = S.game._g.plan;
    assert.equal(plan[6], 'gan_pickup');
    first.set(plan[0], (first.get(plan[0]) || 0) + 1);
    days.add(plan.join());
    plan.slice(0, 6).forEach((id, i) => slots[i].add(id));
  }
  // Every day starts on King George, and only the errands with a door near the first leg's 450 m can open it: six of the eleven.
  // The errand drawn first trades places with a later one that fits, so these share the first slot and none owns it.
  const opened = JSON.stringify(Object.fromEntries(first));
  assert.ok(first.size >= 5, `${first.size} errands open a day: ${opened}`);
  assert.ok([...first.keys()].every((id) => all.includes(id)), opened);
  assert.ok(Math.max(...first.values()) <= 60, `no errand owns the first slot: ${opened}`);
  assert.ok(days.size >= 195, `${days.size} different days of 200`);
  slots.forEach((seen, i) => assert.ok(i === 0 || seen.size >= 9, `slot ${i + 1} saw ${seen.size} errands`));
  // A restart in the same game is a new day too, drawn on from the same stream.
  const S = sim({ seed: 9 });
  const before = S.game._g.plan.join();
  TLV.game.flow.startRun(S);
  assert.notEqual(S.game._g.plan.join(), before);
});

test('a pin is only taken when its route suits the leg: milk is not always the Carrefour', () => {
  const pin = TLV.anchors.resolve(W, defOf('milk').target.anchor, { type: 'poi' }).id;
  let pinnedFirst = 0;
  let milkFirst = 0;
  let milkLater = 0;
  let pinnedLater = 0;
  const leg = TLV.tune.game.legs;
  for (let seed = 1; seed <= 400 && (milkFirst < 3 || milkLater < 6); seed++) {
    const S = sim({ seed, errandDef: 'milk', errand: ((seed % 6) + 1) });
    const e = S.game.errand;
    if (!e || e.defId !== 'milk') continue;
    if (S.game.errandIndex === 0) {
      milkFirst++;
      if (e.poiId === pin) pinnedFirst++;
    } else {
      milkLater++;
      if (e.poiId === pin) pinnedLater++;
    }
    // From the spawn the Carrefour is about 575 m away: inside 30% of the 450 m first leg, outside it for the 850 and 950 m legs.
    if (S.game.errandIndex >= 4) assert.notEqual(e.poiId, pin, `seed ${seed}: the pin on a ${leg[S.game.errandIndex]} m leg`);
  }
  assert.ok(milkFirst >= 3 && milkLater >= 6);
  assert.equal(pinnedFirst, milkFirst, 'from the spawn the Carrefour suits the first leg, as the design measured');
  assert.ok(pinnedLater < milkLater, 'later in the day milk goes wherever suits the leg');
});

test('a def forced by ?errandDef takes the first errand, and ?errand starts later', () => {
  const S = sim({ errand: 3, errandDef: 'gas_station' });
  assert.equal(S.game.errandIndex, 2);
  assert.equal(S.game.errand.defId, 'gas_station');
  assert.equal(W.pois[S.game.errand.poiId].kind, 'fuel');
});

test('the ladder falls to fallback kinds, and redraws, when a kind has no door in reach', () => {
  const S = sim({ seed: 7 });
  const g = S.game;
  // No hairdresser list at all: the ladder has only rung 5 left, so another unused def of the tier takes the slot.
  const saved = S._gameTargets.byKind.hairdresser;
  S._gameTargets.byKind.hairdresser = [];
  g._g.plan[2] = 'haircut_cancel';
  const e = TLV.game.errands.bind(S, 2);
  S._gameTargets.byKind.hairdresser = saved;
  assert.ok(e);
  assert.notEqual(e.defId, 'haircut_cancel');
  assert.equal(g._g.plan[2], e.defId);
  // Pharmacy kinds gone: rung 3 uses the fallback kind.
  const pharm = S._gameTargets.byKind.pharmacy;
  S._gameTargets.byKind.pharmacy = [];
  g._g.plan[2] = 'grandma_pills';
  const f = TLV.game.errands.bind(S, 2);
  S._gameTargets.byKind.pharmacy = pharm;
  assert.ok(f);
  if (f.defId === 'grandma_pills') assert.equal(W.pois[f.poiId].kind, 'convenience');
});

test('{poi}: Hebrew falls back to the English name then a kind label, English to a kind label: English text never shows a Hebrew name', () => {
  const name = TLV.game.errands._nameFor;
  const kinds = W.pois.filter((p) => TLV.tune.game.kindLabels[p.kind] && !(p.flags & 12));
  const both = kinds.find((p) => p.nameHe && p.nameEn);
  const heOnly = kinds.find((p) => p.nameHe && !p.nameEn);
  const enOnly = kinds.find((p) => !p.nameHe && p.nameEn);
  const bare = kinds.find((p) => !p.nameHe && !p.nameEn);
  assert.deepEqual(name(W, both.id), { he: both.nameHe, en: both.nameEn });
  assert.deepEqual(name(W, heOnly.id), { he: heOnly.nameHe, en: TLV.tune.game.kindLabels[heOnly.kind].en });
  assert.deepEqual(name(W, enOnly.id), { he: enOnly.nameEn, en: enOnly.nameEn });
  assert.deepEqual(name(W, bare.id), TLV.tune.game.kindLabels[bare.kind]);
  assert.deepEqual(name(W, -1), { he: 'הגן', en: 'the gan' });
  assert.deepEqual(kinds.filter((p) => /[\u0590-\u05ff]/.test(name(W, p.id).en)).map((p) => p.nameEn), [], 'no target a reader of English cannot read');
  // And through a real binding.
  const S = sim({ seed: 11, errandDef: 'milk' });
  const e = S.game.errand;
  assert.equal(e.defId, 'milk');
  const again = sim({ seed: 12, errandDef: 'grandma_pills', errand: 2 }).game.errand;
  assert.equal(again.defId, 'grandma_pills');
  assert.ok(again.text.en.includes(again.name.en), again.text.en);
  assert.ok(again.text.he.includes(again.name.he), again.text.he);
});

test('a door with no stall in the band still has a bay, by the wider band or the plain fallback', () => {
  const S = sim({ seed: 2 });
  const parking = TLV.world.parking;
  const ids = [];
  const doors = [];
  for (const p of W.pois) {
    if (p.flags & 12) continue;
    parking.spotsNear(W, p.entX, p.entY, 130, ids);
    const far = ids.filter((id) => {
      const sp = parking.spot(W, id);
      return Math.hypot(sp.x - p.entX, sp.y - p.entY) >= 70;
    });
    if (far.length === 0) doors.push(p);
  }
  assert.ok(doors.length > 0, 'the map has doors like this');
  let fallback = 0;
  let none = 0;
  for (const door of doors.slice(0, 24)) {
    const e = S.game.errand;
    e.doorX = door.entX;
    e.doorY = door.entY;
    e._doorEdge = door.edge;
    const from = { x: door.entX + 400, y: door.entY + 400, h: 0 };
    const found = TLV.world.lanes.project(W, door.entX, door.entY, null, 60, {});
    if (!found) continue;
    const near = TLV.world.lanes.project(W, from.x, from.y, null, 80, {});
    if (!near) continue;
    const at = TLV.world.lanes.pointAt(W, near.laneId, near.s, {});
    const route = TLV.world.routing.route(W, at.x, at.y, at.h, found.laneId, found.s, {});
    if (!route) continue;
    e._doorRoute = route;
    e._noContest = false;
    e.decoys = [];
    S.game._g.park = TLV.game.parking._newState();
    TLV.game.parking.stageBlock(S);
    if (e._noContest) fallback++;
    if (e.bayId < 0) none++;
    else assert.ok(parking.state(S, e.bayId) === TLV.const.OCC.FREE || e._pullId >= 0);
  }
  console.log(`doors with no stall 70-130 m out: ${doors.length}, of 24 tried ${fallback} used the plain bay and ${none} had none`);
});

test('an orphan anchor runs the ladder, and a map too small to bind still ends the run cleanly', async () => {
  const { createTLV, createSim } = await import('../../tools/lib/classic.mjs');
  const T2 = createTLV({ map: 'tests/fixtures/mini_map.js', allowMissing: true, params: {} });
  for (let seed = 1; seed <= 6; seed++) {
    const S = createSim(T2, { seed, params: { notitle: 1, traffic: 0, peds: 0, incidents: 0, contest: 'off' } });
    const seenDefs = [];
    S.bus.on('errand.start', (e) => seenDefs.push(e.defId));
    let last = -1;
    for (let i = 0; i < 60 * 240 && S.game.phase !== 'RUN_END'; i++) {
      T2.sim.step(S);
      const g = S.game;
      if (g.phase === 'DRIVE' && g.errandIndex !== last) {
        last = g.errandIndex;
        T2.debug.parkNow({});
      }
    }
    assert.equal(S.game.phase, 'RUN_END', 'no dead state on a tiny map');
    assert.equal(S.game.endReason, 'WIN');
    assert.ok(seenDefs.length <= 7);
    const milk = T2.anchors.resolve(S.world, defOf('milk').target.anchor, { type: 'poi' });
    assert.equal(milk.id, -1, 'the pin is an orphan on mini');
    if (seenDefs.length) assert.equal(seenDefs[seenDefs.length - 1], S.game._g.plan[S.game._g.plan.length - 1], 'the last one is the plan\'s last');
  }
});

test('spawn: King George, 40 m back from the HaNeviim light, with the follower and the green in 3 s', () => {
  const S = sim({ traffic: 1 });
  const sp = TLV.game.errands.spawnPoint(S);
  const lane = W.lanes[sp.laneId];
  assert.equal(W.edges[lane.edge].nameEn, 'HaMelekh George');
  assert.ok(Math.abs(lane.len - sp.s - 40) < 0.01);
  assert.ok(sp.connId >= 0);
  assert.ok(Math.abs(TLV.world.signals.timeToGreen(S, sp.connId) - 3) < 0.1, `green in ${TLV.world.signals.timeToGreen(S, sp.connId)}`);
  assert.ok(sp.tailCar);
  const cars = [];
  TLV.traffic.vehiclesNear(S, sp.x, sp.y, 12, cars);
  assert.ok(cars.some((c) => !c.isPlayer && c.laneId === sp.laneId && c.s < sp.s), 'a stopped car behind');
});

test('?spawn overrides content, and the player starts there', () => {
  const S = sim({ spawn: { x: 100, y: 200, h: 1 } });
  const sp = TLV.game.errands.spawnPoint(S);
  assert.equal(sp.x, 100);
  assert.equal(S.player.veh.x, 100);
});
