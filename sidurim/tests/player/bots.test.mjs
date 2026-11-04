// tests/player/bots.test.mjs — WP-PLAYER
// ARCHITECTURE 19, WP-PLAYER item 7: all five bots for 5 sim-min with no invariant failure, on the real map, with what they
// achieved checked too, because a bot that stands still also keeps every invariant. Real WP-TRAFFIC, WP-PEDS and WP-GAME did not
// exist when this was written, so traffic, people and errand flow come from private stubs in tests/player/stubs.
import assert from 'node:assert';
import { test } from 'node:test';
import { loadTLV, makeSim, run, listen, clearParked, straightLane, placeCar, removeCar, MINI, REAL } from './helpers.mjs';

const TRAFFIC = 'tests/player/stubs/traffic_stub.js';
const PEOPLE = 'tests/player/stubs/peds_stub.js';
const GAME = 'tests/player/stubs/game_stub.js';
const MINUTES = 5;
const TICKS = MINUTES * 3600;

/** Runs a bot and sums up what it did. */
function drive(TLV, S, ticks = TICKS) {
  const veh = S.vehicles[0];
  const seen = listen(S, ['player.contact', 'player.redRun', 'player.hitPed', 'player.nearMiss']);
  let dist = 0;
  let px = veh.x;
  let py = veh.y;
  let moved = 0;
  for (let i = 0; i < ticks; i++) {
    TLV.sim.step(S);
    const d = Math.hypot(veh.x - px, veh.y - py);
    dist += d;
    if (d > 0.002) moved++;
    px = veh.x;
    py = veh.y;
  }
  return { dist, moved: moved / ticks, seen };
}

function assertClean(S, name) {
  assert.deepStrictEqual(S.invariantFailures, [], `${name}: invariants`);
  assert.ok(S._invariantCounts !== undefined);
}

for (const [mapName, map] of [['mini', MINI], ['tlv_center', REAL]]) {
  for (const bot of ['idle', 'patrol', 'chaos', 'braker']) {
    test(`${mapName}: ${bot} runs ${MINUTES} sim-min with no invariant failure`, () => {
      const TLV = loadTLV(map);
      const S = makeSim(TLV, { params: { autoplay: bot, invariants: 1 } });
      const r = drive(TLV, S);
      assertClean(S, bot);
      if (bot === 'idle') assert.strictEqual(r.dist, 0, 'idle stays put');
      if (bot === 'patrol' || bot === 'braker') {
        const least = mapName === 'mini' ? 400 : 1500;
        assert.ok(r.dist > least, `${bot} drove ${r.dist} m`);
      }
      if (bot === 'chaos') assert.ok(r.dist > 300, `chaos moved ${r.dist} m`);
    });
  }

  test(`${mapName}: errands, with a stub game, traffic and people, runs ${MINUTES} sim-min with no invariant failure`, () => {
    const TLV = loadTLV(map, [TRAFFIC, PEOPLE, GAME]);
    const S = makeSim(TLV, { params: { autoplay: 'errands', invariants: 1, notitle: 1, density: 30, knifeEvery: 2 } });
    drive(TLV, S);
    assertClean(S, 'errands');
  });
}

test('tlv_center: patrol and braker really drive routes: legal, on the road, and clear of everything', () => {
  const TLV = loadTLV(REAL);
  let total = 0;
  for (const seed of [1, 2, 3, 4, 5, 6]) {
    const S = makeSim(TLV, { seed, params: { seed, autoplay: seed % 2 ? 'patrol' : 'braker', invariants: 1 } });
    const r = drive(TLV, S);
    assertClean(S, 'patrol');
    total += r.dist;
    assert.ok(r.dist > 1500, `seed ${seed} drove ${r.dist}`);
    assert.strictEqual(r.seen['player.contact'].length, 0, `seed ${seed}: ${JSON.stringify(r.seen['player.contact'][0])}`);
    assert.strictEqual(r.seen['player.redRun'].length, 0, `seed ${seed} ran a red`);
    assert.strictEqual(S.player.wrongWay, false);
  }
  console.log(`      6 x ${MINUTES} sim-min, no traffic: ${(total / 1000).toFixed(1)} km, no contact, no red run`);
});

test('tlv_center: patrol keeps going among traffic, and follows instead of ramming', () => {
  const TLV = loadTLV(REAL, [TRAFFIC]);
  const S = makeSim(TLV, { seed: 3, params: { seed: 3, autoplay: 'patrol', invariants: 1, density: 60 } });
  const r = drive(TLV, S);
  assertClean(S, 'patrol');
  assert.ok(r.dist > 1000, `drove ${r.dist} m among ${S.traffic.stats.count} cars`);
  const forward = r.seen['player.contact'].filter((c) => !c.rearEnded && c.severity === 'crash');
  assert.ok(forward.length <= 2, `${forward.length} crashes of its own`);
  console.log(`      among stub traffic: ${r.dist.toFixed(0)} m, ${r.seen['player.contact'].length} contacts, ` +
    `${r.seen['player.nearMiss'].length} near misses`);
});

test('patrol waits at a red, starts on green, and a long wait is not "stuck"', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV, { seed: 1, params: { seed: 1, autoplay: 'patrol' } });
  const W = S.world;
  let longest = 0;
  let held = 0;
  let recovers = 0;
  const veh = S.vehicles[0];
  run(TLV, S, TICKS, (c, s) => {
    if (s.controls.recover) recovers++;
    if (Math.abs(veh.v) < 0.1 && s.player.laneId >= 0) {
      const lane = W.lanes[s.player.laneId];
      if (lane.conns.length && TLV.world.signals.laneState(s, lane.id) !== TLV.const.SIG.GREEN) held++;
      longest = Math.max(longest, held);
    } else {
      held = 0;
    }
  });
  assert.ok(longest > 300, `it sat through a red, ${longest / 60} s`);
  assert.strictEqual(recovers, 0, 'it never asked for a tow');
});

/** A straight single lane that ends at a signal, the car on it, and a patrol that has taken a route down it. */
function atLight(TLV, S, back) {
  const W = S.world;
  let lane = null;
  for (const l of W.lanes) {
    if (l.len < 110 || l.conns.length === 0 || l.left !== -1 || l.right !== -1) continue;
    if (!(l.flags & TLV.const.LF.AI_ROUTABLE)) continue;
    if (W.juncs[W.dirEdges[l.dirEdge].to].kind !== 'SIGNAL') continue;
    const n = l.px.length - 1;
    if (l.len - Math.hypot(l.px[n] - l.px[0], l.py[n] - l.py[0]) < 0.3) {
      lane = l;
      break;
    }
  }
  assert.ok(lane, 'a straight single lane ends at a light');
  const at = TLV.world.lanes.pointAt(W, lane.id, lane.len - back, {});
  clearParked(TLV, S, at.x, at.y, back + 30);
  return { lane, at, junc: W.dirEdges[lane.dirEdge].to, conn: lane.conns[0] };
}

test('at amber the bot decides once, from the clock: too far to clear means stop, and it stops', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV, { seed: 2, params: { seed: 2 } });
  const { at, lane, conn } = atLight(TLV, S, 44);
  S.controlSource = TLV.bots.create('patrol');
  TLV.player.setPose(S, at.x, at.y, at.h, 13);
  TLV.sim.step(S);
  // Green has just ended: 3 s of amber at 13 m/s falls just short of 44 m, so a car that carries on crosses on red.
  const ctrl = S.world.ctrls[S.world.juncs[S.world.dirEdges[lane.dirEdge].to].ctrl];
  TLV.world.signals.alignGreen(S, conn, -(ctrl.greenS - 0.05));
  const seen = listen(S, ['player.redRun']);
  run(TLV, S, 360);
  assert.deepStrictEqual(seen['player.redRun'], [], 'it never ran the red');
  const veh = S.vehicles[0];
  assert.ok(Math.abs(veh.v) < 0.5, `stopped, at ${veh.v} m/s`);
  assert.strictEqual(S.player.laneId, lane.id);
});

test('a signal stop the speed profile is late for still stops in time', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV, { seed: 2, params: { seed: 2 } });
  const { at, lane, junc } = atLight(TLV, S, 12);
  TLV.world.signals.force(S, junc, 'G', 2);
  S.controlSource = TLV.bots.create('patrol');
  const back = TLV.world.lanes.pointAt(S.world, lane.id, lane.len - 60, {});
  TLV.player.setPose(S, back.x, back.y, back.h, 13);
  // Rolling toward the line with a route in hand, then the light drops to red with only just room to stop.
  const veh = S.vehicles[0];
  for (let i = 0; i < 300 && veh.s < lane.len - 13; i++) TLV.sim.step(S);
  TLV.world.signals.force(S, junc, 'R', 30);
  const seen = listen(S, ['player.redRun']);
  run(TLV, S, 240);
  assert.deepStrictEqual(seen['player.redRun'], [], 'held short of the line');
  assert.ok(Math.abs(veh.v) < 0.5, `stopped, at ${veh.v} m/s`);
  void at;
});

test('a dead-end U-turn tighter than the turning circle is avoided, so patrol does not wedge there', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV, { seed: 18, params: { seed: 18, autoplay: 'patrol', invariants: 1 } });
  const W = S.world;
  const u = W.conns.find((c) => c.turn === 'U' && (W.lanes[c.to].flags & 1) && W.lanes[c.to].len > 20);
  assert.ok(u, 'the map has U-turn connectors');
  const a = W.lanes[u.from];
  const b = W.lanes[u.to];
  const through = TLV.world.routing.routeLanes(W, a.id, a.len / 2, b.id, b.len / 2, {});
  assert.strictEqual(TLV.bots._hasUTurn(W, through), true);
  const plain = TLV.world.routing.routeLanes(W, a.id, 1, a.id, a.len - 1, {});
  assert.strictEqual(TLV.bots._hasUTurn(W, plain), false);

  // Seed 18 ground 293 contacts into one parked car at a dead end, before this.
  const r = drive(TLV, S, 15 * 3600);
  assert.ok(r.seen['player.contact'].length <= 5, `${r.seen['player.contact'].length} contacts`);
  assert.ok(r.dist > 5000, `drove ${r.dist} m`);
});

test('boxed in with no way out, a bot gives up and asks for recover, and only then', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV, { seed: 2, params: { seed: 2, autoplay: 'patrol' } });
  const W = S.world;
  const lane = straightLane(TLV, W, 200);
  const at = TLV.world.lanes.pointAt(W, lane.id, 100, {});
  clearParked(TLV, S, at.x, at.y, 60);
  const c = Math.cos(at.h);
  const s = Math.sin(at.h);
  TLV.player.setPose(S, at.x, at.y, at.h, 0);
  // A car at each end and a wall of them at each side, so the car has nowhere to go.
  for (const off of [4.4, -4.4]) placeCar(TLV, S, at.x + off * c, at.y + off * s, at.h);
  for (const lat of [2.2, -2.2]) {
    for (const off of [-3, 0, 3]) {
      placeCar(TLV, S, at.x + off * c - lat * s, at.y + off * s + lat * c, at.h + Math.PI / 2);
    }
  }
  let first = null;
  run(TLV, S, 130 * 60, (ctl, sim) => {
    if (first === null && sim.controls.recover) first = sim.t;
  });
  assert.ok(first !== null, 'it asked for a tow');
  assert.ok(first > 40, `after trying for a while, at ${first} s`);
});

test('a bot never reads the traffic broadphase before anything has built it', () => {
  const TLV = loadTLV(REAL, [TRAFFIC]);
  const near = TLV.traffic.vehiclesNear;
  const update = TLV.traffic.update;
  let built = false;
  let early = 0;
  TLV.traffic.update = (S, dt) => {
    built = true;
    update(S, dt);
  };
  TLV.traffic.vehiclesNear = (S, x, y, r, out) => {
    if (!built) early++;
    return near(S, x, y, r, out);
  };
  for (const bot of ['patrol', 'braker']) {
    built = false;
    const S = makeSim(TLV, { params: { autoplay: bot, density: 10 } });
    run(TLV, S, 10);
  }
  assert.strictEqual(early, 0, 'row 2 of tick 1 runs before row 6');
});

test('errands leaves the last metres to the route until the car is on the bay\'s own stretch of road', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const veh = S.vehicles[0];
  // Beside a bay, square across its road, as on the street before a corner. A straight route carries on ahead, clear of walls.
  const ids = [];
  TLV.world.parking.spotsNear(W, 0, 0, 900, ids);
  const walls = new Int32Array(64);
  let spot = null;
  let h = 0;
  let x = 0;
  let y = 0;
  const px = [];
  const py = [];
  for (const id of ids) {
    const candidate = TLV.world.parking.spot(W, id);
    for (const turn of [Math.PI / 2, -Math.PI / 2]) {
      const heading = candidate.h + turn;
      const sx = candidate.x - Math.cos(heading) * 15;
      const sy = candidate.y - Math.sin(heading) * 15;
      px.length = 0;
      py.length = 0;
      let clear = true;
      for (let i = 0; i <= 12 && clear; i++) {
        px.push(sx + Math.cos(heading) * i * 3);
        py.push(sy + Math.sin(heading) * i * 3);
        clear = TLV.world.spatial.collidersNear(W, px[i], py[i], 2, walls) === 0;
      }
      if (clear) {
        spot = candidate;
        h = heading;
        x = sx;
        y = sy;
        break;
      }
    }
    if (spot) break;
  }
  assert.ok(spot, 'a bay with an open street across it');
  TLV.player.setPose(S, x, y, h, 5);
  const route = { dirEdges: Int32Array.of(0), px: Float32Array.from(px), py: Float32Array.from(py), fromS: 0, toS: 0 };
  route.cum = TLV.math.cumLen(route.px, route.py);
  route.len = route.cum[12];
  const g = S.game;
  g.phase = 'SEARCH';
  g.errand = { doorX: spot.x, doorY: spot.y, bayId: spot.id };
  g.nav.route = route;
  g.nav.remaining = 15;
  const source = TLV.bots.create('errands');
  const c = source(S);
  assert.ok(Math.abs(c.steer) < 0.1, `holds the route, steer ${c.steer}`);
  assert.ok(veh.v > 0);
});

test('patrol follows: it stops behind a car in a one-lane road, and leaves when it moves', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV, { seed: 2, params: { seed: 2, autoplay: 'patrol' } });
  const W = S.world;
  const lane = straightLane(TLV, W, 200);
  assert.strictEqual(lane.left, -1, 'no other lane to take');
  assert.strictEqual(lane.right, -1);
  const at = TLV.world.lanes.pointAt(W, lane.id, 20, {});
  const ahead = TLV.world.lanes.pointAt(W, lane.id, 90, {});
  clearParked(TLV, S, at.x, at.y, 150);
  TLV.player.setPose(S, at.x, at.y, at.h, 5);
  const seen = listen(S, ['player.contact']);
  const other = placeCar(TLV, S, ahead.x, ahead.y, ahead.h, { id: 3 });
  const veh = S.vehicles[0];
  run(TLV, S, 900);
  assert.strictEqual(seen['player.contact'].length, 0, 'no contact');
  assert.ok(Math.abs(veh.v) < 0.5, `stopped, at ${veh.v}`);
  const gap = TLV.math.obbGap(veh, other);
  assert.ok(gap > 1 && gap < 6, `behind it, ${gap} m back`);
  removeCar(other);
  run(TLV, S, 300);
  assert.ok(veh.v > 3, 'and it drives on');
});

test('braker holds speed, reacts after t_r, and then brakes in full only', () => {
  const TLV = loadTLV(REAL);
  const S = makeSim(TLV);
  const W = S.world;
  const lane = straightLane(TLV, W, 200);
  const at = TLV.world.lanes.pointAt(W, lane.id, 10, {});
  const veh = S.vehicles[0];
  clearParked(TLV, S, at.x, at.y, 200);
  const reaction = 0.9;
  S.controlSource = TLV.bots.create('braker', { reactionS: reaction });
  TLV.player.setPose(S, at.x, at.y, at.h, 0);
  run(TLV, S, 360);
  const speed = veh.v;
  assert.ok(speed > lane.vmax * 0.85, `up to lane speed, ${speed} of ${lane.vmax}`);

  // Something appears in the lane, just outside the distance the fairness gate asks for.
  const need = speed * reaction + speed * speed / (2 * 14) + 3;
  const s = veh.s + need + 2 + 2.2 + 1;
  const spot = TLV.world.lanes.pointAt(W, lane.id, s, {});
  const blocker = placeCar(TLV, S, spot.x, spot.y, spot.h, { id: 4 });
  const seen = listen(S, ['player.contact']);
  const t0 = S.t;
  let braked = null;
  let partial = false;
  run(TLV, S, 300, (c, sim) => {
    if (sim.controls.brake > 0) {
      if (braked === null) braked = sim.t - t0;
      if (veh.v > 0.5 && sim.controls.brake < 1) partial = true;
    }
  });
  assert.ok(braked !== null, 'it braked');
  assert.ok(braked >= reaction - 0.15 && braked < reaction + 0.5, `reacted after ${braked} s`);
  assert.strictEqual(partial, false, 'full brake only');
  assert.strictEqual(seen['player.contact'].length, 0, 'and stopped in time');
  assert.ok(Math.abs(veh.v) < 0.1);
  assert.ok(TLV.math.obbGap(veh, blocker) > 0.1, 'clear of it');
});

test('braker t_r falls with heat, from 0.9 to 0.7 s', () => {
  const TLV = loadTLV(REAL);
  const reactedAt = (heat) => {
    const S = makeSim(TLV);
    const W = S.world;
    const lane = straightLane(TLV, W, 200);
    const at = TLV.world.lanes.pointAt(W, lane.id, 10, {});
    S.game.heat = heat;
    clearParked(TLV, S, at.x, at.y, 200);
    S.controlSource = TLV.bots.create('braker');
    TLV.player.setPose(S, at.x, at.y, at.h, 0);
    run(TLV, S, 300);
    const veh = S.vehicles[0];
    // Close enough to be inside the reach at either t_r, so the difference is the reaction alone.
    const spot = TLV.world.lanes.pointAt(W, lane.id, veh.s + 11, {});
    placeCar(TLV, S, spot.x, spot.y, spot.h, { id: 5 });
    let t = null;
    const t0 = S.t;
    run(TLV, S, 120, (c, sim) => {
      if (t === null && sim.controls.brake >= 1) t = sim.t - t0;
    });
    return t;
  };
  const cold = reactedAt(0);
  const hot = reactedAt(1);
  assert.ok(Math.abs(cold - hot - 0.2) < 0.07, `cold ${cold}, hot ${hot}`);
});

test('braker stops for a person stepping out ahead, on a real lane', () => {
  const TLV = loadTLV(REAL, [PEOPLE]);
  const S = makeSim(TLV, { seed: 5, params: { seed: 5, autoplay: 'braker', invariants: 1, crossEveryS: 7 } });
  const r = drive(TLV, S);
  assertClean(S, 'braker');
  assert.strictEqual(r.seen['player.hitPed'].length, 0, `hit ${r.seen['player.hitPed'].length} people`);
  assert.ok(r.dist > 800, `drove ${r.dist} m, stopping for people`);
});

test('errands parks real bays by the capture rule, and presses E at 1.0 s, on tlv_center', () => {
  const TLV = loadTLV(REAL, [GAME]);
  const S = makeSim(TLV, { seed: 3, params: { seed: 3, autoplay: 'errands', invariants: 1, notitle: 1, knifeEvery: 1 } });
  const stages = [];
  let pressed = null;
  S.bus.on('player.mode', (e) => stages.push(e.mode));
  const r = { exit: null };
  for (let i = 0; i < 10 * 3600 && !(S._stub.done >= 2 && r.exit); i++) {
    TLV.sim.step(S);
    const k = S.game.knife;
    if (k && k.pressedAt !== undefined && pressed === null) pressed = k.pressedAt;
    if (k && k.exit) r.exit = k.exit;
  }
  assertClean(S, 'errands');
  assert.ok(S._stub.done >= 2, `${S._stub.done} errands done`);
  assert.ok(S.game.stats.bayParks >= 2, `parked ${S.game.stats.bayParks} bays`);
  assert.ok(stages.includes('SNAP') && stages.includes('LOCKED') && stages.includes('FOOT'));
  assert.ok(Math.abs(pressed - 1) < 0.05, `E at ${pressed} s`);
  assert.strictEqual(r.exit, 'REACHED_SHOP', 'ran to the door');
});

test('errands double-parks when no bay remains, within 150 m of the door', () => {
  const TLV = loadTLV(REAL, [GAME]);
  const S = makeSim(TLV, { seed: 3, params: { seed: 3, autoplay: 'errands', notitle: 1 } });
  run(TLV, S, 60);
  S.game.errand.bayId = -1;
  run(TLV, S, 2 * 3600, (c, sim) => {
    if (sim.game.errand) sim.game.errand.bayId = -1;
  });
  assert.ok(S.game.stats.doubleParks >= 1, 'it held Q at the door');
});

test('every bot takes the title, and the restart at run end, except idle', () => {
  for (const bot of ['patrol', 'braker', 'chaos', 'errands']) {
    const TLV = loadTLV(MINI);
    const S = makeSim(TLV, { params: { autoplay: bot } });
    S.game.phase = 'RUN_END';
    TLV.sim.step(S);
    assert.strictEqual(S.controls.restart, true, `${bot} restarts`);
    S.game.phase = 'TITLE';
    TLV.sim.step(S);
    assert.strictEqual(S.controls.start, true, `${bot} starts`);
  }
  const TLV = loadTLV(MINI);
  const S = makeSim(TLV, { params: { autoplay: 'idle' } });
  S.game.phase = 'RUN_END';
  TLV.sim.step(S);
  assert.strictEqual(S.controls.restart, false);
});

test('a patrol log replays to the same hash with no bot, because bots touch only their own stream', () => {
  const TLV = loadTLV(REAL);
  const A = makeSim(TLV, { seed: 8, params: { seed: 8, autoplay: 'patrol', record: 1 } });
  run(TLV, A, 2400);
  const log = A.recorder.finish();
  const hash = TLV.sim.hash(A);
  const B = TLV.sim.create({
    seed: 8, world: A.world, allowMissing: true, params: { ...log.header.params, autoplay: null },
    controlSource: TLV.replay.createPlayer(log)
  });
  run(TLV, B, A.tick);
  assert.strictEqual(B.tick, A.tick);
  assert.strictEqual(TLV.sim.hash(B), hash);
  assert.strictEqual(B.vehicles[0].x, A.vehicles[0].x);
});

test('an unknown bot warns and sits still; all draw only from S.rng.bot', () => {
  const TLV = loadTLV(MINI);
  const warn = console.warn;
  const warned = [];
  console.warn = (m) => warned.push(m);
  const source = TLV.bots.create('nonsense');
  console.warn = warn;
  assert.ok(warned.length === 1 && warned[0].includes('nonsense'));
  assert.strictEqual(typeof source, 'function');

  for (const bot of ['patrol', 'braker', 'chaos', 'errands']) {
    const S = makeSim(TLV, { params: { autoplay: bot } });
    const before = {};
    for (const name of Object.keys(S.rng)) before[name] = S.rng[name].state();
    run(TLV, S, 3600);
    for (const name of Object.keys(S.rng)) {
      if (name !== 'bot') assert.strictEqual(S.rng[name].state(), before[name], `${bot} drew from ${name}`);
    }
  }
});

test('errands holds Q through HOLD, and keeps the gan rule of 40 m from the door', () => {
  const TLV = loadTLV(MINI);
  const S = makeSim(TLV);
  const source = TLV.bots.create('errands');
  const g = S.game;
  g.phase = 'HOLD';
  g.park.kind = 'DOUBLE';
  g.nav.route = TLV.world.routing.route(S.world, S.vehicles[0].x, S.vehicles[0].y, S.vehicles[0].h, 0, 20, {});
  let c = source(S);
  assert.strictEqual(c.hazard, true, 'a Q hold is not cancelled');
  assert.strictEqual(c.throttle, 0);

  const veh = S.vehicles[0];
  g.phase = 'SEARCH';
  g.park.kind = null;
  g.nav.route = null;
  g.errand = { doorX: veh.x + 60, doorY: veh.y, bayId: -1 };
  TLV.player.setPose(S, veh.x, veh.y, veh.h, 0);
  g.errandIndex = 3;
  c = source(S);
  assert.strictEqual(c.hazard, true, 'within 150 m on an ordinary errand');
  g.errandIndex = 6;
  c = source(S);
  assert.strictEqual(c.hazard, false, 'not at 60 m on the gan');
  g.errand.doorX = veh.x + 20;
  c = source(S);
  assert.strictEqual(c.hazard, true, 'within 40 m on the gan');
});
