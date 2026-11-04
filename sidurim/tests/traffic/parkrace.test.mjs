// tests/traffic/parkrace.test.mjs — WP-TRAFFIC
// ARCHITECTURE 19 item 7: PARK_RACE reaches IN_SPOT on 95% of 200 random spots on tlv_center, and ctl.holdCreep holds him at the COMMIT
// line. Stalls are the ones a contest can use, on an AI-routable lane. The rival starts up to 90 m back along the road, as a conscripted
// car does, and every run gets the 60 s the command allows.
import test from 'node:test';
import { assert, realTLV, quietSim, run, runUntil, car, events, parkPlayer, findLane } from './helpers.mjs';

const TLV = realTLV();
const W = TLV.world.get('tlv_center');
const C = TLV.const;
const Q = TLV.tune.traffic;

/** A list of stalls drawn by a fixed stream, spread over the map. */
function randomSpots(n, seed) {
  const rng = TLV.rng.create(seed);
  const b = W.bounds;
  const out = [];
  const ids = [];
  let guard = 0;
  while (out.length < n && guard++ < 20000) {
    const x = rng.range(b.minX + 200, b.maxX - 200);
    const y = rng.range(b.minY + 200, b.maxY - 200);
    TLV.world.parking.spotsNear(W, x, y, 40, ids);
    if (!ids.length) continue;
    const spot = TLV.world.parking.spot(W, ids[rng.int(ids.length)]);
    if (!(W.lanes[spot.laneId].flags & C.LF.AI_ROUTABLE)) continue;
    out.push(spot);
  }
  return out;
}

const feeders = (() => {
  const by = new Map();
  for (const c of W.conns) {
    if (!(W.lanes[c.from].flags & C.LF.AI_ROUTABLE)) continue;
    if (!by.has(c.to)) by.set(c.to, []);
    by.get(c.to).push(c);
  }
  return by;
})();

/** @returns {{laneId:number,s:number}} A start up to 90 m back along the road from a stall. */
function startFor(spot) {
  let laneId = spot.laneId;
  let back = 90 - spot.laneS;
  if (back <= 0) return { laneId, s: spot.laneS - 90 };
  for (let hops = 0; hops < 6 && back > 0; hops++) {
    const list = feeders.get(laneId);
    if (!list) break;
    const conn = list[0];
    laneId = conn.from;
    const lane = W.lanes[laneId];
    if (back <= lane.len - 3) return { laneId, s: lane.len - back };
    back -= lane.len + conn.len;
  }
  return { laneId, s: Math.min(3, W.lanes[laneId].len / 2) };
}

/** Races one stall. @returns {boolean} True on IN_SPOT. */
function race(S, spot) {
  const OCC = C.OCC;
  TLV.world.parking.setState(S, spot.id, OCC.FREE);
  const start = startFor(spot);
  const rival = car(S, { laneId: start.laneId, s: start.s, v: 6, ag: 0.6 });
  const ctl = { speedScale: 1, mayBlink: true, holdCreep: false };
  assert.equal(TLV.traffic.command(S, rival, { type: 'PARK_RACE', spotId: spot.id, ctl }), true);
  let ended = null;
  const off = (e) => {
    if (e.vehId === rival.id && (e.stage === 'IN_SPOT' || e.stage === 'FAILED')) ended = e.stage;
  };
  S.bus.on('traffic.parkRace', off);
  for (let i = 0; i < (Q.parkRaceMaxS + 1) * 60 && !ended; i++) TLV.sim.step(S);
  S.bus.off('traffic.parkRace', off);
  return ended === 'IN_SPOT';
}

test('item 7: PARK_RACE reaches IN_SPOT on at least 95% of 200 random stalls', () => {
  const spots = randomSpots(200, 77);
  assert.equal(spots.length, 200);
  let won = 0;
  const lost = [];
  for (const spot of spots) {
    const S = quietSim({ seed: spot.id % 1000 });
    if (race(S, spot)) won++;
    else lost.push(spot.id);
    assert.equal(TLV.traffic.gate.audit(S), null);
  }
  console.log(`PARK_RACE: ${won} of 200 reached IN_SPOT`);
  assert.ok(won >= 190, `${won} of 200 reached IN_SPOT, lost ${lost.slice(0, 12).join(' ')}`);
});

test('a rival held short by ctl.speedScale 0 signals from where he stands, with leave, and not without it', () => {
  // On errand 1 courtesy stands him on a side road 8 m short of the blink distance, and on 4 seeds of 20 the player parked without ever seeing him.
  const S = quietSim();
  const lane = findLane(W, (l) => l.right < 0 && l.len > 160 && W.edges[l.edge].parkR > 0);
  const ids = [];
  const far = TLV.world.lanes.pointAt(W, lane.id, lane.len - 20, {});
  TLV.world.parking.spotsNear(W, far.x, far.y, 25, ids);
  const spot = ids.map((id) => TLV.world.parking.spot(W, id)).find((sp) => sp.laneId === lane.id);
  TLV.world.parking.setState(S, spot.id, C.OCC.FREE);
  const ctl = { speedScale: 0, mayBlink: true, holdCreep: true, blinkWaiting: false };
  const rival = car(S, { laneId: lane.id, s: Math.max(4, spot.laneS - 90), v: 0 });
  TLV.traffic.command(S, rival, { type: 'PARK_RACE', spotId: spot.id, ctl });
  const stages = () => events(S, 'traffic.parkRace', (e) => e.vehId === rival.id).map((e) => e.stage);
  run(S, 60);
  assert.ok(spot.laneS - rival.s > Q.parkBlinkM, 'too far to blink by distance');
  assert.deepEqual(stages(), [], 'mayBlink alone does not bring him out of range');
  ctl.blinkWaiting = true;
  ctl.mayBlink = false;
  run(S, 60);
  assert.deepEqual(stages(), [], 'and leave to wait is not leave to blink: out of view he stays dark');
  ctl.mayBlink = true;
  let most = 0;
  run(S, 120, () => {
    most = Math.max(most, rival.v);
  });
  assert.equal(stages()[0], 'BLINK');
  assert.ok(rival.lights & (C.VL.BLINK_L | C.VL.BLINK_R), 'his blinker is on');
  // Seed 14 rolled into a junction at the blinker's speed with the player 10 m off. A held car sits at the 0.1 m/s floor.
  assert.ok(most < 0.2, `and he still waits, at up to ${most} m/s`);
});

test('item 7: ctl.holdCreep holds him at the COMMIT line until it is lifted', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.right < 0 && l.len > 120 && W.edges[l.edge].parkR > 0);
  const ids = [];
  const mid = TLV.world.lanes.pointAt(W, lane.id, lane.len / 2, {});
  TLV.world.parking.spotsNear(W, mid.x, mid.y, 60, ids);
  const spot = ids.map((id) => TLV.world.parking.spot(W, id)).find((sp) => sp.laneId === lane.id);
  TLV.world.parking.setState(S, spot.id, C.OCC.FREE);
  const ctl = { speedScale: 1, mayBlink: true, holdCreep: true };
  const rival = car(S, { laneId: lane.id, s: Math.max(4, spot.laneS - 50), v: 7 });
  TLV.traffic.command(S, rival, { type: 'PARK_RACE', spotId: spot.id, ctl });
  runUntil(S, () => rival.v < 0.1 && rival.s > spot.laneS - Q.parkCommitM - 6, 20, 'holding at the COMMIT line');
  run(S, 600);
  const line = spot.laneS - Q.parkCommitM;
  assert.ok(Math.abs(rival.s - line) < 3, `${rival.s} against the line at ${line}`);
  assert.equal(rival.beh, 'PARK_RACE');
  assert.equal(events(S, 'traffic.parkRace', (e) => e.stage === 'COMMIT').length, 0, 'no COMMIT while held');
  ctl.holdCreep = false;
  runUntil(S, () => rival.mode === 'PARKED', 8, 'parking');
  assert.deepEqual(events(S, 'traffic.parkRace', (e) => e.vehId === rival.id).map((e) => e.stage), ['BLINK', 'CREEP', 'COMMIT', 'IN_SPOT']);
});

test('item 7: a rival in the bubble with live traffic round it still gets there', () => {
  const spots = randomSpots(60, 78).filter((sp) => Math.abs(W.lanes[sp.laneId].px[0]) < 1400 && Math.abs(W.lanes[sp.laneId].py[0]) < 1800);
  let won = 0;
  let all = 0;
  for (const spot of spots.slice(0, 24)) {
    const S = quietSim({ seed: 40 + all, spawner: true, density: 80 });
    parkPlayer(S, spot.x, spot.y - 60);
    TLV.traffic.prewarm(S);
    run(S, 2);
    all++;
    if (race(S, spot)) won++;
    assert.equal(TLV.traffic.gate.audit(S), null);
  }
  console.log(`PARK_RACE in traffic: ${won} of ${all}`);
  assert.ok(won >= Math.floor(all * 0.8), `${won} of ${all}`);
});

test('item 7: a rival stopped at a long red out of sight is not cleared away as a blocker', () => {
  const S = quietSim();
  const lane = findLane(W, (l) => l.len >= 80 && W.conns[l.conns[0]].slot >= 0);
  const junc = W.conns[lane.conns[0]].junc;
  TLV.world.signals.force(S, junc, 'R', 120);
  const ids = [];
  const to = W.conns[lane.conns[0]].to;
  const at = TLV.world.lanes.pointAt(W, to, W.lanes[to].len / 2, {});
  TLV.world.parking.spotsNear(W, at.x, at.y, 60, ids);
  const veh = car(S, { laneId: lane.id, s: lane.len - 30, v: 5, ag: 0.5 });
  assert.equal(TLV.traffic.command(S, veh, { type: 'PARK_RACE', spotId: ids[0], ctl: { speedScale: 1, mayBlink: true, holdCreep: false } }), true);
  run(S, 40 * 60);
  assert.equal(veh.active, true, 'only a car with nowhere to be gets tidied');
  assert.equal(veh.beh, 'PARK_RACE');
});
