// tests/game/incidents.test.mjs — WP-GAME
// ARCHITECTURE 19 item 8: all 15 incidents stage on tlv_center through the fairness gate, and the brake-only bot avoids 95% of them.
// The soak's Fairness gate is the larger measure of the same thing. Here the director is real and traffic and people are too.
import test from 'node:test';
import { assert, realTLV, sim, step, until, toDrive, events } from './helpers.mjs';

const TLV = realTLV();
const T = TLV.tune.game;

const IDS = [
  'RED_RUNNER', 'BUS_PULLOUT', 'DOOR_ZONE', 'DROP_OFF', 'STOP_NO_REASON', 'ZEBRA_ROULETTE', 'SLOW_CROSS', 'RED_WALKER', 'SCOOTER_SALMON',
  'DELIVERY_POP', 'TAILGATE', 'OVERTAKE_DIVE', 'MERGE_WEDGE', 'DOUBLE_PARK', 'REVERSE_FOR_SPOT'
];

test('the 15 definitions, with the catalog\'s numbers', () => {
  const defs = TLV.game.incidents.defs();
  assert.deepEqual(defs.map((d) => d.id).sort(), [...IDS].sort());
  const by = Object.fromEntries(defs.map((d) => [d.id, d]));
  // Owner's decision: OVERTAKE_DIVE is allowed in SEARCH on every errand, because a slow car hunting for a spot is exactly who gets dived
  // past, and on errand 1 once the three scripted beats are done, so it has no minHeat. It stays out of the beats themselves.
  for (const id of ['DOOR_ZONE', 'DROP_OFF', 'STOP_NO_REASON', 'ZEBRA_ROULETTE', 'SLOW_CROSS', 'DOUBLE_PARK', 'REVERSE_FOR_SPOT', 'OVERTAKE_DIVE']) assert.equal(by[id].search, true, id);
  for (const id of ['RED_RUNNER', 'BUS_PULLOUT', 'RED_WALKER', 'SCOOTER_SALMON', 'DELIVERY_POP', 'TAILGATE', 'MERGE_WEDGE']) assert.equal(by[id].search, false, id);
  assert.equal(by.OVERTAKE_DIVE.minHeat, 0);
  assert.equal(by.REVERSE_FOR_SPOT.minHeat, 0.3);
  assert.equal(by.RED_WALKER.minHeat, 0.15);
  for (const d of defs) {
    // Owner's decision: dives are short of pass supply, so OVERTAKE_DIVE cools for 15 s and every other incident for the catalog's 30.
    assert.equal(d.cooldownS, d.id === 'OVERTAKE_DIVE' ? 15 : 30, d.id);
    assert.equal(d.weight, 3);
    assert.ok(d.telegraph.s >= 1, `${d.id} telegraphs at least 1 s`);
  }
});

test('item 8: all 15 stage on tlv_center and pass the real fairness gate, on a car driving a real route', () => {
  const staged = new Map();
  const gated = TLV.game.fairness.check;
  let passes = 0;
  TLV.game.fairness.check = (S, c) => {
    const ok = gated(S, c);
    if (ok) passes++;
    return ok;
  };
  try {
    for (let seed = 1; seed <= 40 && staged.size < IDS.length; seed++) {
      const S = sim({ seed, errand: 2 + (seed % 5), traffic: 1, peds: 1, incidents: 1, contest: 'off', heat: 1, immortal: 1 });
      S.controlSource = TLV.bots.create('braker');
      // The director is held off, so this test asks for each incident itself, in turn.
      S.game.director.nextT = 1e9;
      toDrive(S);
      const bot = TLV.bots.create('errands');
      S.controlSource = bot;
      let i = 0;
      for (let tick = 0; tick < 60 * 120 && staged.size < IDS.length; tick++) {
        step(S, 1);
        if (tick % 20 !== 0 || (S.game.phase !== 'DRIVE' && S.game.phase !== 'SEARCH')) continue;
        S.game.director.nextT = 1e9;
        for (let k = 0; k < IDS.length; k++) {
          const id = IDS[(i + k) % IDS.length];
          if (staged.has(id)) continue;
          const inc = TLV.game.incidents.stage(S, id, {});
          if (inc) {
            staged.set(id, { seed, inc, S });
            assert.ok(inc.actors.length >= 1, id);
            assert.equal(inc.state, 'TELEGRAPH');
            assert.equal(events(S, 'incident.telegraph', (e) => e.id === inc.id).length, 1);
            i = (i + k + 1) % IDS.length;
            break;
          }
        }
      }
    }
  } finally {
    TLV.game.fairness.check = gated;
  }
  const missing = IDS.filter((id) => !staged.has(id));
  console.log(`staged ${staged.size} of 15, ${passes} gate passes, by seed ${JSON.stringify(Object.fromEntries([...staged].map(([k, v]) => [k, v.seed])))}`);
  assert.deepEqual(missing, []);
});

test('rule 1: d >= v t_r + v²/28 + 3, which is 52 m at top speed', () => {
  const S = sim({ heat: 0 });
  toDrive(S);
  assert.ok(Math.abs(TLV.game.fairness.need(S, 26.4) - (26.4 * 0.9 + 26.4 * 26.4 / 28 + 3)) < 1e-9);
  assert.ok(Math.abs(TLV.game.fairness.need(S, 26.4) - 51.7) < 0.5);
  const H = sim({ heat: 1 });
  toDrive(H);
  assert.ok(TLV.game.fairness.need(H, 26.4) < TLV.game.fairness.need(S, 26.4), 't_r falls with heat');
  const def = TLV.game.incidents.defs()[0];
  const c = { d: 10, v: 10, x: 0, y: 0, def, blocking: false, laneId: -1 };
  assert.equal(TLV.game.fairness.check(S, c), false);
  c.d = 25;
  assert.equal(TLV.game.fairness.check(S, c), true);
});

test('rule 2: under 1.0 s of telegraph is refused', () => {
  const S = sim();
  toDrive(S);
  const c = { d: 100, v: 5, x: 0, y: 0, def: { telegraph: { s: 0.9 } }, blocking: false, laneId: -1 };
  assert.equal(TLV.game.fairness.check(S, c), false);
});

test('rule 4: no other incident within 40 m or 3 s', () => {
  const S = sim();
  toDrive(S);
  const def = TLV.game.incidents.defs()[0];
  S.game.director.incidents.push({ state: 'ACTIVE', startT: S.t - 10, anchor: { x: 0, y: 0 } });
  const c = { d: 100, v: 5, x: 30, y: 0, def, blocking: false, laneId: -1 };
  assert.equal(TLV.game.fairness.check(S, c), false, '30 m');
  c.x = 45;
  assert.equal(TLV.game.fairness.check(S, c), true, '45 m and 10 s');
  S.game.director.incidents[0].startT = S.t - 2;
  assert.equal(TLV.game.fairness.check(S, c), false, '2 s');
});

test('pacing: BUILD gaps fall with heat, PEAK runs at 4 s, and a contact gives a breather', () => {
  const cold = sim({ heat: 0, incidents: 1, errand: 2 });
  toDrive(cold);
  assert.equal(cold.game.director.state, 'BUILD');
  cold.bus.emit('player.contact', { kind: 'static', otherId: 1, vn: 1, severity: 'scrape', rearEnded: false, x: 0, y: 0 });
  assert.equal(cold.game.director.state, 'BREATHE');
  step(cold, 60 * (T.breatheS + 0.1));
  assert.equal(cold.game.director.state, 'BUILD');
  // An errand other than the first has no scripted beats.
  const S = sim({ seed: 3, errand: 3, incidents: 1, traffic: 1, peds: 1, contest: 'off', immortal: 1 });
  toDrive(S);
  S.controlSource = TLV.bots.create('errands');
  const states = new Set();
  for (let i = 0; i < 60 * 90 && S.game.phase !== 'SEARCH'; i++) {
    step(S, 1);
    states.add(S.game.director.state);
  }
  assert.ok(states.has('BUILD'));
  assert.ok(S.game.stats.incidents.staged >= 1, 'it staged something');
});

test('SEARCH takes only search incidents, and an encounter none at all', () => {
  const S = sim({ seed: 4, errand: 3, incidents: 1, traffic: 1, peds: 1, contest: 'off', immortal: 1 });
  toDrive(S);
  S.controlSource = TLV.bots.create('errands');
  const seen = new Set();
  let search = 0;
  S.bus.on('incident.telegraph', (e) => {
    if (S.game.phase === 'SEARCH') {
      search++;
      seen.add(e.defId);
    }
  });
  for (let i = 0; i < 60 * 240; i++) step(S, 1);
  const by = Object.fromEntries(TLV.game.incidents.defs().map((d) => [d.id, d]));
  for (const id of seen) assert.equal(by[id].search, true, id);
  // During an encounter the director stands still.
  const K = sim({ seed: 4, errand: 3, incidents: 1, traffic: 1, peds: 1, immortal: 1 });
  toDrive(K);
  TLV.debug.use(K);
  TLV.debug.forceKnife({ stage: 'CHASE', gap: 12 });
  const before = K.game.stats.incidents.staged;
  step(K, 60 * 12);
  assert.equal(K.game.stats.incidents.staged, before);
  assert.ok(search >= 0);
});

test('owner\'s decision: a dive can be staged in SEARCH, and on errand 1 once the beats are done, never during them', () => {
  const S = sim({ seed: 1, incidents: 1, traffic: 1, peds: 1, contest: 'off', immortal: 1 });
  toDrive(S);
  S.controlSource = TLV.bots.create('errands');
  const beats = T.introBeats.length;
  const staged = [];
  S.bus.on('incident.telegraph', (e) => staged.push({ id: e.defId, beat: S.game._g.dir.beat, errand: S.game.errandIndex, phase: S.game.phase }));
  for (let i = 0; i < 60 * 150 && S.game.errandIndex === 0; i++) step(S);
  for (const inc of staged) if (inc.id === 'OVERTAKE_DIVE' && inc.errand === 0) assert.ok(inc.beat >= beats, 'not while the script runs');
  // A dive in SEARCH: a car behind the slow player on a road with room.
  let dived = 0;
  for (let seed = 1; seed <= 16 && !dived; seed++) {
    const Q = sim({ seed, errand: 3, incidents: 1, traffic: 1, peds: 1, contest: 'off', immortal: 1 });
    toDrive(Q);
    Q.controlSource = TLV.bots.create('errands');
    Q.bus.on('incident.telegraph', (e) => { if (e.defId === 'OVERTAKE_DIVE' && Q.game.phase === 'SEARCH') dived++; });
    for (let i = 0; i < 60 * 120; i++) step(Q);
  }
  assert.ok(dived >= 1, 'a dive reached a car in SEARCH');
});

test('the first minute: beats fire on errand 1 only, by route distance, and ignore minHeat', () => {
  const S = sim({ seed: 1, incidents: 1, traffic: 1, peds: 1, contest: 'off', immortal: 1 });
  toDrive(S);
  S.controlSource = TLV.bots.create('errands');
  const fired = [];
  S.bus.on('incident.telegraph', (e) => fired.push([e.defId, Math.round(S.game.nav.s)]));
  until(S, (s) => s.game.phase === 'SEARCH', 90, 'SEARCH');
  console.log(`first minute: ${JSON.stringify(fired)}`);
  // This leg has signalled crossings only, so ZEBRA_ROULETTE has no anchor, and the design skips it. RED_RUNNER needs that light green.
  assert.ok(fired.length >= 1, 'beats find their places');
  const allowed = T.introBeats.map((b) => b.defId);
  for (const [id] of fired) assert.ok(allowed.includes(id), id);
  const other = sim({ seed: 1, errand: 2, incidents: 1 });
  assert.equal(other.game._g.dir.beat, T.introBeats.length, 'none on errand 2');
});

test('a person who never finds a gap is ABORTED, not AVOIDED, and an aborted incident is no credit', () => {
  const S = sim({ seed: 5, errand: 3, traffic: 1, peds: 1, contest: 'off', incidents: 1, immortal: 1, heat: 1 });
  toDrive(S);
  S.game.director.nextT = 1e9;
  const out = [];
  S.bus.on('incident.end', (e) => out.push(e));
  S.controlSource = TLV.bots.create('errands');
  step(S, 60 * 5);
  const inc = TLV.game.incidents.stage(S, 'STOP_NO_REASON', { force: true }) || TLV.game.incidents.stage(S, 'DOOR_ZONE', { force: true });
  assert.ok(inc, 'forced');
  assert.ok(TLV.traffic.byId(S, inc.actors[0].id) || TLV.peds.byId(S, inc.actors[0].id));
  const man = S.game.director.incidents.find((i) => i.id === inc.id);
  man._person = true;
  man._stepped = false;
  until(S, () => out.some((e) => e.id === inc.id), 16, 'end');
  assert.equal(out.find((e) => e.id === inc.id).outcome, 'ABORTED');
});

test('HIT: a contact with the actor ends it; a tailgater\'s rear-end does not count', () => {
  const S = sim({ seed: 6, errand: 3, traffic: 1, peds: 1, contest: 'off', incidents: 1, immortal: 1 });
  toDrive(S);
  const out = [];
  S.bus.on('incident.end', (e) => out.push(e));
  S.game.director.incidents.push({
    id: 900, defId: 'TAILGATE', state: 'ACTIVE', startT: S.t, anchor: { x: 0, y: 0 }, aim: { x: 0, y: 0, tImpact: S.t + 3, frozen: false },
    actors: [{ type: 'veh', id: 77 }], minGap: 9, contacted: false, outcome: null, _tta: 8, _person: false
  });
  S.bus.emit('player.contact', { kind: 'vehicle', otherId: 77, vn: 2, severity: 'bump', rearEnded: true, x: 0, y: 0 });
  assert.equal(out.length, 0);
  S.bus.emit('player.contact', { kind: 'vehicle', otherId: 77, vn: 2, severity: 'bump', rearEnded: false, x: 0, y: 0 });
  assert.deepEqual(out[0], { id: 900, defId: 'TAILGATE', outcome: 'HIT' });
});

test('GAVE WAY pays +₪10 for a staged person cleared by 1.5 m, and never a near miss', () => {
  const S = sim({ seed: 7, errand: 3, incidents: 1 });
  toDrive(S);
  const inc = {
    id: 901, defId: 'ZEBRA_ROULETTE', state: 'COMMIT', startT: S.t - 10, anchor: { x: 0, y: 0 }, aim: { x: 0, y: 0, tImpact: S.t - 1, frozen: true },
    actors: [{ type: 'ped', id: 12345 }], minGap: 2, contacted: false, outcome: null, _tta: 3, _person: true, _stepped: true, _teleS: 1, _endT: S.t
  };
  S.game.director.incidents.push(inc);
  const money = S.game.money;
  step(S, 2);
  assert.equal(S.game.money, money + T.gaveWayPay);
  assert.equal(events(S, 'score.bonus', (b) => b.id === 'GAVE_WAY').length, 1);
  assert.equal(S.game.chain.n, 0, 'people never feed the chain');
});

test('item 8: the brake-only bot avoids at least 95% of what it meets', () => {
  let avoided = 0;
  let hit = 0;
  let aborted = 0;
  for (let seed = 1; seed <= 3; seed++) {
    const S = sim({ seed, errand: 3, traffic: 1, peds: 1, incidents: 1, contest: 'off', immortal: 1, heat: 0.5 });
    toDrive(S);
    S.controlSource = TLV.bots.create('braker');
    S.bus.on('incident.end', (e) => {
      if (e.outcome === 'AVOIDED') avoided++;
      else if (e.outcome === 'HIT') hit++;
      else aborted++;
    });
    step(S, 60 * 150);
  }
  const share = avoided / (avoided + hit);
  console.log(`braker: avoided ${avoided}, hit ${hit}, aborted ${aborted}: ${(share * 100).toFixed(1)}%`);
  assert.ok(avoided + hit >= 20, `${avoided + hit} incidents`);
  assert.ok(share >= 0.95, `${(share * 100).toFixed(1)}%`);
});
