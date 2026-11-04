// tests/traffic/contacts.test.mjs — WP-TRAFFIC
// The four foundation issues, each proved on the map and in traffic: junctions._contacts (setbacks, cross-junction connectors, touching
// lanes), and a person on a crossing that sits on a connector.
import test from 'node:test';
import { assert, realTLV, quietSim, run, runUntil, car, playerOn } from './helpers.mjs';

const TLV = realTLV();
const W = TLV.world.get('tlv_center');
const C = TLV.const;
const Q = TLV.tune.traffic;
const table = TLV.world.junctions._contacts(W);
const AI = C.LF.AI_ROUTABLE;

/** Separation of two boxes given as {x, y, c, s}, half sizes as a van. */
function apart(a, b) {
  return TLV.traffic.idm.apart(a.x, a.y, a.c, a.s, 2.6, 1, b.x, b.y, b.c, b.s, 2.6, 1);
}

/** The box of a van standing with its nose this far short of a lane end. */
function waiter(lane, back) {
  const at = TLV.math.polyAt(lane.px, lane.py, lane.cum, lane.len - back - 2.6, {});
  return { x: at.x, y: at.y, c: Math.cos(at.h), s: Math.sin(at.h) };
}

test('issue 1: the two worst sites from the foundation check hold their queues back, by a real margin', () => {
  assert.ok(table.setback[6274] >= 1, `lane 6274 holds back ${table.setback[6274]} m`);
  assert.ok(table.setback[7020] >= 1, `lane 7020 holds back ${table.setback[7020]} m`);
  const lanes = table.setback.reduce((n, x) => n + (x > 0 ? 1 : 0), 0);
  assert.ok(lanes >= 30 && lanes < 400, `${lanes} lanes set back`);
  assert.ok(Math.max(...table.setback) <= TLV.tune.world.waitBackMax);
});

test('issue 1: a van waiting at its held line clears every connector of the other approaches', () => {
  const pad = TLV.tune.world.waitPad;
  let checked = 0;
  for (const junc of W.juncs) {
    if (junc.inDir.length < 2) continue;
    for (const de of junc.inDir) {
      const dir = W.dirEdges[de];
      if (!dir.aiRoutable) continue;
      for (const id of dir.lanes) {
        const lane = W.lanes[id];
        // A lane too short to hold its queue clear stops at the limit, and the contact net covers what is left.
        const most = Math.min(TLV.tune.world.waitBackMax, Math.max(0, lane.len - 5.2 - pad));
        if (!(lane.flags & AI) || !table.setback[id] || table.setback[id] >= most - 1e-3) continue;
        const stand = waiter(lane, pad + table.setback[id]);
        for (const c of junc.conns) {
          const conn = W.conns[c];
          if (conn.px.length === 2 || W.lanes[conn.from].dirEdge === de) continue;
          if (!(W.lanes[conn.from].flags & AI) || !(W.lanes[conn.to].flags & AI)) continue;
          checked++;
          for (let s = 0; s <= conn.len; s += 0.75) {
            const at = TLV.math.polyAt(conn.px, conn.py, conn.cum, s, {});
            const drive = { x: at.x, y: at.y, c: Math.cos(at.h), s: Math.sin(at.h) };
            assert.ok(apart(stand, drive) > 0, `lane ${id} still stands in connector ${c}`);
          }
        }
      }
    }
  }
  assert.ok(checked > 100, `${checked} pairs checked`);
});

test('issue 1: a car on a set-back lane stops at the held line on red, then goes on green', () => {
  const lane = W.lanes[6274];
  const S = quietSim();
  const junc = W.conns[lane.conns[0]].junc;
  TLV.world.signals.force(S, junc, 'R', 600);
  const veh = car(S, { laneId: lane.id, s: Math.max(3, lane.len - 45), v: 8 });
  runUntil(S, () => veh.v < 0.15, 14, 'stopping');
  const nose = lane.len - veh.s - veh.length / 2;
  assert.ok(nose >= table.setback[lane.id], `nose ${nose} m from the lane end, set back ${table.setback[lane.id]} m`);
  assert.ok(nose <= table.setback[lane.id] + Q.stopPad + 2.2, `and not far short of it: ${nose}`);
  TLV.world.signals.force(S, junc, 'G', 600);
  runUntil(S, () => veh.mode === 'CONN', 12, 'going');
});

test('issue 2: connectors of neighbouring junctions that touch hold each other out, starting with Herbert Samuel', () => {
  assert.ok(table.connX[5791].includes(8127));
  assert.ok(table.connX[5791].includes(8921));
  assert.ok(table.connX[8127].includes(5791), 'symmetric');
  assert.notEqual(W.conns[5791].junc, W.conns[8127].junc, 'of different junctions');
  table.connX.forEach((list, c) => {
    if (!list) return;
    for (const o of list) assert.ok(table.connX[o].includes(c), `${c} and ${o} are not symmetric`);
  });
  const S = quietSim();
  const a = W.conns[5791];
  const b = W.conns[8127];
  S.traffic.occ[a.id] = 1;
  const veh = car(S, { laneId: b.from, s: W.lanes[b.from].len - 3, v: 0 });
  assert.equal(TLV.traffic.gate.check(S, veh, b.id, 1), TLV.traffic.gate.WHY.CONTACT);
  S.traffic.occ[a.id] = 0;
  assert.notEqual(TLV.traffic.gate.check(S, veh, b.id, 1), TLV.traffic.gate.WHY.CONTACT);
});

test('issue 3: the two lane pairs that touch, Bnei Dan head-on across Namir among them, never take two cars', () => {
  assert.deepEqual(table.laneX[5188], [7488]);
  assert.deepEqual(table.laneX[7488], [5188]);
  const pairs = [];
  table.laneX.forEach((list, l) => { if (list) for (const o of list) if (o > l) pairs.push([l, o]); });
  assert.equal(pairs.length, 2, JSON.stringify(pairs));
  const S = quietSim();
  const into = W.conns.find((c) => c.to === 7488 && c.px.length > 2 && (W.lanes[c.from].flags & AI));
  const veh = car(S, { laneId: into.from, s: W.lanes[into.from].len - 3, v: 0 });
  const WHY = TLV.traffic.gate.WHY;
  assert.notEqual(TLV.traffic.gate.exitWhy(S, veh, into), WHY.CONTACT);
  S.traffic.reserved[5188] = 7;
  assert.equal(TLV.traffic.gate.exitWhy(S, veh, into), WHY.CONTACT);
  S.traffic.reserved[5188] = 0;
  const on = car(S, { laneId: 5188, s: 1, v: 0 });
  run(S, 1);
  assert.equal(TLV.traffic.gate.exitWhy(S, veh, into), WHY.CONTACT);
  assert.ok(on.active);
});

/** A crossing on an exit arm whose zone was snapped past where people really walk. */
function exitCrossing() {
  for (const z of W.zones) {
    const lane = W.lanes[z.laneId];
    if (!(lane.flags & AI) || lane.cls > 2 || (z.s0 + z.s1) / 2 > 3) continue;
    const x = W.xings[z.xing];
    const at = TLV.math.polyAt(lane.px, lane.py, lane.cum, (z.s0 + z.s1) / 2, {});
    const along = (x.x - at.x) * Math.cos(at.h) + (x.y - at.y) * Math.sin(at.h);
    if (along > -6) continue;
    for (const c of W.conns) {
      if (c.to !== lane.id || c.turn === 'S' || c.px.length === 2 || !(W.lanes[c.from].flags & AI)) continue;
      // The person stands where the connector itself runs.
      let best = Infinity;
      let bestS = 0;
      for (let s = 0; s <= c.len; s += 0.5) {
        const p = TLV.math.polyAt(c.px, c.py, c.cum, s, {});
        const d = TLV.math.dist(p.x, p.y, x.x, x.y);
        if (d < best) { best = d; bestS = s; }
      }
      if (best < 1 && bestS > 3 && W.lanes[c.from].len > 40) return { conn: c, lane, zone: z, xing: x, along };
    }
  }
  return assert.fail('no such crossing');
}

test('issue 4: a car turning onto an exit arm stops for a walker on the real crossing, short of the zone snapped past it', () => {
  const S = quietSim();
  const { conn, xing, along } = exitCrossing();
  assert.ok(along < -6, 'the zone stands past the crossing');
  const person = { active: true, x: xing.x, y: xing.y, onRoad: true, r: 0.35 };
  const peds = TLV.peds;
  const near = peds.pedsNear;
  peds.pedsNear = (Sim, x, y, r, out) => {
    if (TLV.math.dist(x, y, person.x, person.y) > r) return 0;
    out[0] = person;
    return 1;
  };
  try {
    if (conn.slot >= 0) TLV.world.signals.force(S, conn.junc, 'G', 600);
    const veh = car(S, { laneId: conn.from, s: W.lanes[conn.from].len - 25, v: 7 });
    veh._t.pn = 0;
    veh._t.pg = 0;
    veh._t.plan[0] = conn.id;
    veh._t.pn = 1;
    TLV.traffic.gate.extend(S, veh);
    let touched = false;
    runUntil(S, () => {
      const dx = person.x - veh.x;
      const dy = person.y - veh.y;
      const fwd = Math.abs(dx * Math.cos(veh.h) + dy * Math.sin(veh.h));
      const side = Math.abs(dy * Math.cos(veh.h) - dx * Math.sin(veh.h));
      touched = touched || (fwd < veh.length / 2 + person.r && side < veh.width / 2 + person.r);
      return veh.v < 0.05 && veh.mode !== 'LANE';
    }, 14, 'the car stopping on the connector');
    assert.equal(touched, false, 'it never reached the walker');
    person.x += 40;
    runUntil(S, () => veh.v > 1, 4, 'moving off when the walker has gone');
  } finally {
    peds.pedsNear = near;
  }
});

test('a person hard-brakes a car at the TTC the contract gives, and an aggressive driver may squeeze past', () => {
  const S = quietSim();
  const lane = W.lanes.find((l) => (l.flags & AI) && l.len > 150 && l.left < 0 && l.right < 0 && l.width >= 3 && !(l.flags & 2));
  const veh = car(S, { laneId: lane.id, s: 20, v: 10, ag: 0.5 });
  const spot = TLV.world.lanes.pointAt(W, lane.id, 70, {});
  const person = { active: true, x: spot.x, y: spot.y, onRoad: true, r: 0.35 };
  const near = TLV.peds.pedsNear;
  TLV.peds.pedsNear = (Sim, x, y, r, out) => {
    if (TLV.math.dist(x, y, person.x, person.y) > r) return 0;
    out[0] = person;
    return 1;
  };
  try {
    runUntil(S, () => veh.v < 0.05, 8, 'stopping');
    const gap = 70 - veh.s - veh.length / 2;
    assert.ok(gap > 0.3, `stopped ${gap} m short`);
    const rude = quietSim({ seed: 2 });
    const r = car(rude, { laneId: lane.id, s: 20, v: 8, ag: 0.95 });
    const calm = car(rude, { laneId: W.lanes[lane.id].opposite >= 0 ? W.lanes[lane.id].opposite : lane.id, s: 5, v: 0, ag: 0.1 });
    calm._t.capV = 0;
    person.x = spot.x - Math.sin(spot.h) * (r.width / 2 + Q.pedSqueezeCorridor + 0.45);
    person.y = spot.y + Math.cos(spot.h) * (r.width / 2 + Q.pedSqueezeCorridor + 0.45);
    runUntil(rude, () => r.s > 75, 8, 'the squeeze');
  } finally {
    TLV.peds.pedsNear = near;
  }
  assert.equal(C.SIG.GREEN, 0);
});

test('off the AI network: no car takes a lane with no way on, when its lane offers another', () => {
  const S = quietSim();
  const lane = W.lanes.find((l) => (l.flags & AI) && l.conns.length >= 2 && Array.from(l.conns).some((c) => {
    const to = W.lanes[W.conns[c].to];
    return (to.flags & AI) && !Array.from(to.conns).some((x) => W.lanes[W.conns[x].to].flags & AI) && to.left < 0 && to.right < 0;
  }));
  if (!lane) return;
  for (let i = 0; i < 20; i++) {
    const veh = car(S, { laneId: lane.id, s: Math.min(5 + i, lane.len / 2), v: 0 });
    const to = W.lanes[W.conns[veh._t.plan[0]].to];
    assert.ok(Array.from(to.conns).some((x) => W.lanes[W.conns[x].to].flags & AI), 'it has a way on');
    TLV.traffic.despawn(S, veh, 'script');
  }
  playerOn(S, lane.id, 2, 0);
});
