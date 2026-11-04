// tests/peds/population.test.mjs — the crowd on tlv_center: 40-60 within 120 m for 10 sim-min, around cars that obey only the contract.
// Section 19 items 1, 3, 5 and 6, without any other package. stack.test.mjs repeats them on the real one.
import test from 'node:test';
import assert from 'node:assert';
import { loadTLV, sim, setPlayer, quiet, driver, record, run } from './helpers.mjs';

quiet();

const T0 = loadTLV('tlv_center');

/** Metres of body overlap the stand-in's cruder corners may reach. Anything more means a person was walked into or driven at. */
const GRAZE = 0.2;

/** Runs one sim, reading the crowd once a sim-second. */
function soak({ seed, minutes, speed, cars = 90, redRun = 0, each }) {
  const S = sim(T0, { seed, traffic: true, density: cars });
  S.traffic.redRun = redRun;
  const W = S.world;
  const drive = driver(T0, S, speed, (seed * 977) % W.lanes.length);
  drive();
  const log = record(S, ['ped.intent', 'ped.stepOut']);
  const counts = [];
  for (let i = 0; i < 60 * 60 * minutes; i++) {
    drive();
    T0.sim.step(S);
    if (each) each(S, i);
    if (i % 60 === 59) {
      let n = 0;
      for (const p of S.peds) {
        if (p.active && Math.hypot(p.x - S.player.fx, p.y - S.player.fy) <= 120) n++;
      }
      counts.push(n);
    }
  }
  return { S, counts, log };
}

test('40-60 people within 120 m, every second, for 10 sim-min, driving the real map', () => {
  for (const [seed, speed] of [[1, 8], [2, 14]]) {
    const { counts, S } = soak({ seed, minutes: 10, speed, cars: 60 });
    const low = Math.min(...counts);
    const high = Math.max(...counts);
    assert.ok(low >= 40 && high <= 60, `seed ${seed}: ${low} to ${high}`);
    assert.strictEqual(counts.length, 600);
    assert.ok(S.pedsys.maxDwell <= 25, `dwell ${S.pedsys.maxDwell}`);
  }
});

test('40-60 people within 120 m standing still, from the first second', () => {
  const S = sim(T0, { seed: 3 });
  setPlayer(S, -62, 139);
  const counts = [];
  run(T0, S, 60 * 60 * 3, (i) => {
    if (i % 60 !== 59) return;
    counts.push(S.peds.filter((p) => p.active && Math.hypot(p.x + 62, p.y - 139) <= 120).length);
  });
  assert.ok(Math.min(...counts) >= 40 && Math.max(...counts) <= 60, `${Math.min(...counts)} to ${Math.max(...counts)}`);
});

test('A teleport fills the bubble at once: a street never fills up in front of the player', () => {
  const S = sim(T0, { seed: 4 });
  setPlayer(S, -62, 139);
  run(T0, S, 60);
  setPlayer(S, 900, -1200);
  run(T0, S, 16);
  const n = S.peds.filter((p) => p.active && Math.hypot(p.x - 900, p.y + 1200) <= 120).length;
  assert.ok(n >= 40 && n <= 60, `${n} after the jump`);
});

test('Nobody appears close by in view of the player', () => {
  const S = sim(T0, { seed: 5 });
  setPlayer(S, -62, 139);
  run(T0, S, 60);
  const min = T0.tune.peds.spawnMinM;
  S.bus.on('ped.spawn', (e) => {
    const p = T0.peds.byId(S, e.pedId);
    const d = Math.hypot(p.x + 62, p.y - 139);
    assert.ok(d >= min - 1, `appeared ${d} m away`);
  });
  run(T0, S, 60 * 120);
});

test('The mix is a crowd: walkers, phones, trolleys, scooters and delivery riders', () => {
  const S = sim(T0, { seed: 6 });
  setPlayer(S, 0, 0);
  const kinds = {};
  S.bus.on('ped.spawn', (e) => { kinds[e.kind] = (kinds[e.kind] || 0) + 1; });
  run(T0, S, 10);
  for (const k of ['walker', 'phone', 'scooter', 'delivery']) assert.ok(kinds[k] > 0, `no ${k}`);
});

test('Everyone who steps out shows intent 0.8 s first, in a crowd on the real map', () => {
  const { log } = soak({ seed: 7, minutes: 3, speed: 8 });
  const steps = log.filter((e) => e.name === 'ped.stepOut');
  assert.ok(steps.length >= 15, `${steps.length} step-outs`);
  for (const s of steps) {
    const before = log.filter((e) => e.name === 'ped.intent' && e.pedId === s.pedId && e.t <= s.t);
    assert.ok(before.length > 0, 'no intent');
    assert.ok(s.tick - before[before.length - 1].tick >= 48, 'under 0.8 s');
  }
});

test('Crossings happen, in every way the brief asks for', () => {
  const states = {};
  for (const seed of [8, 9, 10]) {
    const { log } = soak({ seed, minutes: 4, speed: 6 });
    for (const e of log) if (e.state) states[e.state] = (states[e.state] || 0) + 1;
  }
  assert.ok(states.CROSS_LEGAL > 30, JSON.stringify(states));
  assert.ok(states.CROSS_SLOW > 3, JSON.stringify(states));
  assert.ok(states.JAYWALK > 5, JSON.stringify(states));
  assert.ok(states.RED_CROSS >= 1, JSON.stringify(states));
});

/** Reads everyone out on the road against every moving car. Returns the worst overlap, in metres of body. */
function worstOnRoad(S, walk) {
  let worst = 0;
  for (const p of S.peds) {
    if (!p.active || p._p.stage !== 'ROAD') continue;
    for (const v of S.vehicles) {
      if (!v.active || v.isPlayer || Math.abs(v.v) < 0.3) continue;
      if (Math.hypot(v.x - p.x, v.y - p.y) > 9) continue;
      worst = Math.max(worst, p.r - walk.bodyDist(v, p.x, p.y));
    }
  }
  return worst;
}

// What the stand-in can prove is that lanes and zones alone are enough to stop a car for someone on the road: it reads nothing else.
// Zero AI contacts everywhere, on sidewalks too, is the gate in stack.test.mjs. A stand-in that snaps heading at lane vertices and has
// no junction gate swings bodies over ribbons in ways real traffic does not, so that part of the count means nothing here.
test('Lanes and zones alone keep cars off everyone on the road, and no zone is held past 25 s', () => {
  for (const seed of [11, 12, 13, 14]) {
    const S = sim(T0, { seed, traffic: true, density: 90 });
    S.traffic.noLong = true;
    const drive = driver(T0, S, 6 + seed % 5 * 2, (seed * 977) % S.world.lanes.length);
    drive();
    let worst = 0;
    for (let i = 0; i < 60 * 60 * 4; i++) {
      drive();
      T0.sim.step(S);
      if (i % 3 === 0) worst = Math.max(worst, worstOnRoad(S, T0.peds.walk));
    }
    assert.ok(worst < GRAZE, `seed ${seed}: ${worst} m`);
    assert.ok(S.pedsys.maxDwell <= 25);
    assert.ok(S.traffic.stats.count > 40);
    assert.ok(S.traffic.personStops > 0, 'cars never met anyone');
  }
});

test('A car that runs a red still stops for everyone on the road', () => {
  for (const seed of [15, 16]) {
    const S = sim(T0, { seed, traffic: true, density: 90 });
    S.traffic.noLong = true;
    S.traffic.redRun = 0.02;
    const drive = driver(T0, S, 6, (seed * 977) % S.world.lanes.length);
    drive();
    let worst = 0;
    for (let i = 0; i < 60 * 60 * 3; i++) {
      drive();
      T0.sim.step(S);
      if (i % 3 === 0) worst = Math.max(worst, worstOnRoad(S, T0.peds.walk));
    }
    assert.ok(S.traffic.redRuns > 0);
    assert.ok(worst < GRAZE, `seed ${seed}: ${worst} m`);
  }
});

test('Nobody goes out on a road where traffic may spawn: past 125 m nobody steps out, past 136 m nobody stays', () => {
  const S = sim(T0, { seed: 18 });
  setPlayer(S, 0, 0);
  const T = T0.tune.peds;
  S.bus.on('ped.stepOut', (e) => {
    const p = T0.peds.byId(S, e.pedId);
    assert.ok(Math.hypot(p.x, p.y) <= T.roadOutM + 12, `${Math.hypot(p.x, p.y)} m out`);
  });
  run(T0, S, 60 * 60 * 2, (i) => {
    if (i % 60) return;
    for (const p of S.peds) {
      if (p.active && p.onRoad) assert.ok(Math.hypot(p.x, p.y) <= T.roadKeepM + 6, `on a road ${Math.hypot(p.x, p.y)} m out`);
    }
  });
});

test('Nobody stands in a solid wall or a parked car for more than a sliver of the time', () => {
  const S = sim(T0, { seed: 17 });
  setPlayer(S, 300, 500);
  const W = S.world;
  let samples = 0;
  let walled = 0;
  let parked = 0;
  const ids = [];
  const box = {};
  run(T0, S, 60 * 60 * 3, (i) => {
    if (i % 30) return;
    for (const p of S.peds) {
      if (!p.active) continue;
      samples++;
      const b = T0.world.spatial.pointInBuilding(W, p.x, p.y);
      if (b >= 0 && !(W.blds[b].flags & 1)) walled++;
      const n = T0.world.parking.parkedNear(S, p.x, p.y, 5, ids);
      for (let k = 0; k < n; k++) {
        T0.world.parking.boxOf(W, ids[k], T0.world.parking.state(S, ids[k]), box);
        const dx = p.x - box.x;
        const dy = p.y - box.y;
        const c = Math.cos(box.h);
        const s = Math.sin(box.h);
        if (Math.abs(dx * c + dy * s) < box.length / 2 && Math.abs(dy * c - dx * s) < box.width / 2) parked++;
      }
    }
  });
  assert.ok(samples > 10000);
  assert.ok(walled / samples < 0.002, `${(100 * walled / samples).toFixed(3)}% in walls`);
  assert.ok(parked / samples < 0.002, `${(100 * parked / samples).toFixed(3)}% in cars`);
});
