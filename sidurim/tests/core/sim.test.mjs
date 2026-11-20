// tests/core/sim.test.mjs — WP-CORE
import assert from 'node:assert';
import { test } from 'node:test';
import { INIT_CHAIN, STEP_TABLE, captureWarnings, coreTLV, installSpies, installStubSystems, randomBot } from './helpers.mjs';

const label = ([path, name]) => `${path}.${name}`;

function spiedSim(opts) {
  const TLV = coreTLV();
  const calls = installSpies(TLV);
  // player.init is a spy, so nothing else would fill S.player.
  const S = TLV.sim.create({ allowMissing: true, ...opts });
  calls.length = 0;
  return { TLV, S, calls };
}

test('TLV.sim.step calls the systems in exactly the order of section 9.2', () => {
  const { TLV, S, calls } = spiedSim();
  TLV.sim.step(S);
  assert.deepStrictEqual(calls, STEP_TABLE.map(label));
  calls.length = 0;
  TLV.sim.step(S);
  assert.deepStrictEqual(calls, STEP_TABLE.map(label));
});

test('rows 0 to 2 and row 17 sit around the systems in table order', () => {
  const TLV = coreTLV();
  const order = [];
  for (const [path, name] of STEP_TABLE) TLV.ns(path)[name] = () => order.push(`${path}.${name}`);
  const S = TLV.sim.create({
    allowMissing: true,
    params: { invariants: 1, record: 1 },
    controlSource: (s) => {
      order.push(`controls tick=${s.tick} t=${s.t}`);
      return s.controls;
    }
  });
  const snapshot = TLV.sim.snapshot;
  TLV.sim.snapshot = (s) => {
    order.push(`snapshot tick=${s.tick}`);
    snapshot(s);
  };
  const record = S.recorder.record;
  S.recorder.record = (c) => {
    order.push('record');
    record(c);
  };
  const run = TLV.invariants.run;
  TLV.invariants.run = (s) => {
    order.push(`invariants tick=${s.tick}`);
    return run(s);
  };

  S.tick = 59;
  TLV.sim.step(S);
  assert.deepStrictEqual(order, [
    'snapshot tick=60', `controls tick=60 t=${60 * TLV.const.DT}`, 'record', ...STEP_TABLE.map(label), 'invariants tick=60'
  ]);
});

test('tick and time follow the formula, with no accumulated rounding', () => {
  const { TLV, S } = spiedSim();
  for (let i = 0; i < 1000; i++) TLV.sim.step(S);
  assert.strictEqual(S.tick, 1000);
  assert.strictEqual(S.t, 1000 * TLV.const.DT);
});

test('signals.update gets S alone, and the rest get S and DT', () => {
  const TLV = coreTLV();
  installSpies(TLV);
  const seen = {};
  for (const [path, name] of STEP_TABLE) TLV.ns(path)[name] = (...args) => { seen[`${path}.${name}`] = args; };
  const S = TLV.sim.create({ allowMissing: true });
  TLV.sim.step(S);
  for (const row of STEP_TABLE) {
    const key = label(row);
    assert.deepStrictEqual(seen[key], key === 'world.signals.update' ? [S] : [S, TLV.const.DT], key);
  }
});

const GATED = [
  ['traffic', ['traffic.update', 'traffic.maintain']],
  ['peds', ['peds.update', 'peds.maintain']],
  ['incidents', ['game.director.update']]
];

for (const [flag, rows] of GATED) {
  test(`flags.${flag} = false disables exactly ${rows.join(' and ')}`, () => {
    const { TLV, S, calls } = spiedSim({ flags: { [flag]: false } });
    TLV.sim.step(S);
    assert.deepStrictEqual(calls, STEP_TABLE.map(label).filter((c) => !rows.includes(c)));
  });

  test(`?${flag}=0 sets the same flag`, () => {
    const { TLV, S, calls } = spiedSim({ params: { [flag]: 0 } });
    assert.strictEqual(S.flags[flag], false);
    TLV.sim.step(S);
    assert.deepStrictEqual(calls, STEP_TABLE.map(label).filter((c) => !rows.includes(c)));
  });
}

test('opts.flags beats params, and every flag defaults on', () => {
  const { S } = spiedSim({ params: { traffic: 0 }, flags: { traffic: true } });
  assert.deepStrictEqual(S.flags, { traffic: true, peds: true, incidents: true });
});

test('S.params ends up saying what S.flags says, as 0 or 1', () => {
  const params = (opts) => {
    const { S } = spiedSim(opts);
    return [S.params.traffic, S.params.peds, S.params.incidents];
  };
  assert.deepStrictEqual(params({}), [1, 1, 1]);
  assert.deepStrictEqual(params({ params: { peds: 0 } }), [1, 0, 1]);
  assert.deepStrictEqual(params({ params: { traffic: 0 }, flags: { traffic: true } }), [1, 1, 1]);
  assert.deepStrictEqual(params({ flags: { peds: false, incidents: 0 } }), [1, 0, 0]);
});

test('create leaves the params object it was given alone, so TLV.params keeps what was asked for', () => {
  const given = { traffic: 1 };
  const { S } = spiedSim({ params: given, flags: { traffic: false } });
  assert.strictEqual(S.params.traffic, 0);
  assert.deepStrictEqual(given, { traffic: 1 });
});

test('create runs the init chain in the binding order', () => {
  const TLV = coreTLV();
  const calls = installSpies(TLV);
  TLV.sim.create({ allowMissing: true });
  assert.deepStrictEqual(calls, INIT_CHAIN.map(label));
});

test('create resolves the seed from opts, then params, then 1', () => {
  const TLV = coreTLV();
  installStubSystems(TLV);
  assert.strictEqual(TLV.sim.create({ seed: 5, params: { seed: 6 } }).seed, 5);
  assert.strictEqual(TLV.sim.create({ params: { seed: 6 } }).seed, 6);
  assert.strictEqual(TLV.sim.create({}).seed, 1);
  assert.strictEqual(TLV.sim.create({ seed: 0 }).seed, 0);
  assert.strictEqual(TLV.sim.create({ params: { seed: 0 } }).seed, 0);
  assert.strictEqual(TLV.sim.create({ seed: 5 }).params.seed, 5);
});

test('S has the fields of section 12.1.8 and complete params', () => {
  const TLV = coreTLV();
  installStubSystems(TLV);
  const world = { id: 'w' };
  const S = TLV.sim.create({ seed: 2, world });
  for (const key of ['seed', 'tick', 't', 'timeScale', 'params', 'flags', 'world', 'bus', 'rng', 'vehicles', 'peds', 'player',
    'parking', 'sig', 'traffic', 'pedsys', 'game', 'controls', 'controlSource', 'recorder', 'invariantFailures']) {
    assert.ok(key in S, key);
  }
  assert.strictEqual(S.world, world);
  assert.strictEqual(S.timeScale, 1);
  assert.strictEqual(S.tick, 0);
  assert.strictEqual(S.recorder, null);
  assert.strictEqual(S.params.clock, 120);
  assert.deepStrictEqual(Object.keys(S.rng).sort(), ['bot', 'event', 'foot', 'game', 'ped', 'spawn', 'traffic']);
});

test('RNG streams are independent and seeded from hash32(seed, streamName)', () => {
  const TLV = coreTLV();
  installStubSystems(TLV, { cars: 0, people: 0 });
  const S = TLV.sim.create({ seed: 77 });
  for (const name of ['traffic', 'spawn', 'ped', 'event', 'game', 'foot', 'bot']) {
    assert.strictEqual(S.rng[name].next(), TLV.rng.create(TLV.rng.hash32(77, TLV.rng.hashStr(name))).next(), name);
  }
});

test('pools are full length with defaults and stable slots', () => {
  const TLV = coreTLV();
  const S = captureQuietSim(TLV);
  const { MAX_VEHICLES, MAX_PEDS } = TLV.const;
  assert.strictEqual(S.vehicles.length, MAX_VEHICLES);
  assert.strictEqual(S.peds.length, MAX_PEDS);
  S.vehicles.forEach((v, i) => assert.strictEqual(v.slot, i));
  S.peds.forEach((p, i) => assert.strictEqual(p.slot, i));
  assert.strictEqual(S.vehicles[1].active, false);
  assert.strictEqual(S.peds[0].active, false);
  assert.deepStrictEqual(S.vehicles[1]._t, {});
  assert.deepStrictEqual(S.peds[0]._p, {});
  assert.notStrictEqual(S.vehicles[1]._t, S.vehicles[2]._t, 'each record owns its private object');
});

function captureQuietSim(TLV, opts) {
  let S;
  captureWarnings(() => { S = TLV.sim.create({ allowMissing: true, ...opts }); });
  return S;
}

test('allowMissing fills S.player and S.game as the contract says', () => {
  const TLV = coreTLV();
  const S = captureQuietSim(TLV);
  assert.strictEqual(S.player.mode, 'DRIVE');
  assert.strictEqual(S.player.veh, S.vehicles[0]);
  assert.strictEqual(S.player.fx, 0);
  assert.strictEqual(S.player.fy, 0);
  const veh = S.vehicles[0];
  assert.deepStrictEqual([veh.id, veh.active, veh.isPlayer, veh.mode, veh.kind, veh.length], [0, true, true, 'FREE', 'hatch', 4]);
  assert.strictEqual(S.game.phase, 'DRIVE');
  assert.strictEqual(S.game.hp, 100);
});

test('allowMissing fills S.player in time for traffic.init, which reads it', () => {
  const TLV = coreTLV();
  let seen = null;
  TLV.ns('traffic').init = (s) => { seen = s.player; };
  const S = captureQuietSim(TLV);
  assert.strictEqual(seen, S.player);
});

test('allowMissing leaves alone what a package did create', () => {
  const TLV = coreTLV();
  const mine = { mode: 'FOOT', veh: null, fx: 9, fy: 9 };
  TLV.ns('player').init = (s) => { s.player = mine; };
  TLV.ns('game.flow').init = (s) => { s.game = { phase: 'TITLE', clock: 1, money: 2, hp: 3 }; };
  const S = captureQuietSim(TLV);
  assert.strictEqual(S.player, mine);
  assert.strictEqual(S.game.phase, 'TITLE');
});

test('allowMissing warns once per missing function, however long it runs', () => {
  const TLV = coreTLV();
  let S;
  const atCreate = captureWarnings(() => { S = TLV.sim.create({ allowMissing: true }); });
  const atFirstTick = captureWarnings(() => TLV.sim.step(S));
  const later = captureWarnings(() => { for (let i = 0; i < 100; i++) TLV.sim.step(S); });
  assert.strictEqual(atCreate.length, INIT_CHAIN.length);
  assert.strictEqual(atFirstTick.length, STEP_TABLE.length);
  assert.deepStrictEqual(later, []);
  assert.strictEqual(S.tick, 101);
});

test('a system that appears later is picked up, because lookups are live', () => {
  const TLV = coreTLV();
  const S = captureQuietSim(TLV);
  captureWarnings(() => TLV.sim.step(S));
  let ran = 0;
  TLV.ns('traffic').update = () => { ran++; };
  TLV.sim.step(S);
  assert.strictEqual(ran, 1);
});

test('without allowMissing, create names everything that is missing', () => {
  const TLV = coreTLV();
  assert.throws(() => TLV.sim.create({}), (e) => {
    assert.match(e.message, /TLV\.world\.parking\.init/);
    assert.match(e.message, /TLV\.game\.score\.update/);
    assert.match(e.message, /allowMissing/);
    return true;
  });
  installStubSystems(TLV);
  delete TLV.traffic.maintain;
  assert.throws(() => TLV.sim.create({}), /TLV\.traffic\.maintain/);
});

test('control source: explicit, then bot, then the default', () => {
  const TLV = coreTLV();
  installStubSystems(TLV);
  const mine = () => null;
  TLV.bots = { create: (name) => { const f = (s) => s.controls; f.botName = name; return f; } };
  assert.strictEqual(TLV.sim.create({ controlSource: mine, params: { autoplay: 'patrol' } }).controlSource, mine);
  assert.strictEqual(TLV.sim.create({ params: { autoplay: 'patrol' } }).controlSource.botName, 'patrol');
  const S = TLV.sim.create({});
  assert.strictEqual(S.controlSource(S), S.controls);
});

test('autoplay without TLV.bots fails clearly, or warns under allowMissing', () => {
  const TLV = coreTLV();
  installStubSystems(TLV);
  assert.throws(() => TLV.sim.create({ params: { autoplay: 'patrol' } }), /TLV\.bots/);
  let S;
  const warnings = captureWarnings(() => { S = TLV.sim.create({ allowMissing: true, params: { autoplay: 'patrol' } }); });
  assert.strictEqual(warnings.length, 1);
  assert.strictEqual(S.controlSource(S), S.controls);
});

test('step stores what the control source returned, and survives one that returns nothing', () => {
  const { TLV, S } = spiedSim();
  const own = { ...S.controls, throttle: 0.5 };
  S.controlSource = () => own;
  TLV.sim.step(S);
  assert.strictEqual(S.controls, own);
  S.controlSource = () => undefined;
  TLV.sim.step(S);
  assert.strictEqual(S.controls, own);
});

test('snapshot copies pose for active records and the foot, and leaves inactive slots alone', () => {
  const TLV = coreTLV();
  const S = captureQuietSim(TLV);
  Object.assign(S.vehicles[0], { x: 1, y: 2, h: 3 });
  Object.assign(S.vehicles[5], { active: false, x: 1, y: 2, h: 3 });
  Object.assign(S.peds[0], { active: true, x: 4, y: 5, h: 6 });
  Object.assign(S.player.foot, { x: 7, y: 8, h: 9 });
  TLV.sim.snapshot(S);
  assert.deepStrictEqual([S.vehicles[0].px, S.vehicles[0].py, S.vehicles[0].ph], [1, 2, 3]);
  assert.deepStrictEqual([S.vehicles[5].px, S.vehicles[5].py, S.vehicles[5].ph], [0, 0, 0]);
  assert.deepStrictEqual([S.peds[0].px, S.peds[0].py, S.peds[0].ph], [4, 5, 6]);
  assert.deepStrictEqual([S.player.foot.px, S.player.foot.py, S.player.foot.ph], [7, 8, 9]);
});

test('snapshot runs before anything moves, so px holds the previous tick', () => {
  const TLV = coreTLV();
  installStubSystems(TLV);
  const S = TLV.sim.create({ seed: 1 });
  S.controlSource = randomBot();
  for (let i = 0; i < 30; i++) {
    const car = S.vehicles[1];
    const before = car.x;
    TLV.sim.step(S);
    assert.strictEqual(car.px, before);
    assert.notStrictEqual(car.x, before);
  }
});

test('factories default every field', () => {
  const { const: C } = coreTLV();
  assert.strictEqual(C.newVehicle(4).slot, 4);
  assert.strictEqual(C.newVehicle(4).id, -1);
  assert.strictEqual(C.newVehicle(4).laneId, -1);
  assert.strictEqual(C.newVehicle(4).beh, 'CRUISE');
  assert.strictEqual(C.newPedestrian(4).state, 'WALK');
  const g = C.newGameState();
  assert.strictEqual(g.phase, 'TITLE');
  assert.strictEqual(g.lastKnifeErrand, -1);
  assert.strictEqual(g.nav.remaining, Infinity);
  assert.deepStrictEqual(g.stats.incidents, { staged: 0, avoided: 0, hit: 0, aborted: 0, byId: {} });
  assert.deepStrictEqual(g.chain, { n: 0, mult: 1, windowT: 0, bank: 0 });
  assert.notStrictEqual(C.newGameState().director.incidents, g.director.incidents, 'each state owns its lists');
});

test('every behaviour, state and phase in the shared lists matches the contract', () => {
  const { const: C } = coreTLV();
  assert.strictEqual(C.BEHAVIOURS.length, 24);
  assert.strictEqual(C.PED_STATES.length, 11);
  assert.strictEqual(C.PHASES.length, 10);
  assert.deepStrictEqual(C.VEHICLE_SIZES.bus.length, 12);
  assert.strictEqual(C.DT, 1 / 60);
  assert.deepStrictEqual({ ...C.OCC }, { FREE: 0, PARKED: 1, VEHICLE: 2, MOTO: 3 });
});
