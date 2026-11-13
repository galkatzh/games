// tests/game/versus.test.mjs — WP-GAME
// A shared day (GAME_DESIGN 26), with no network: two real sims on tlv_center, joined by a loop that carries each one's outbox to the
// other's versus.receive as JSON, the way a data channel would. Whatever the browser's TLV.net does, the board is settled here.
import test from 'node:test';
import { assert, realTLV, sim, step, events } from './helpers.mjs';

const TLV = realTLV();
const V = TLV.game.versus;
const T = TLV.tune.game;
const QUIET = { traffic: 0, peds: 0, incidents: 0, contest: 'off', knife: 'off', notitle: 0 };

/** Two drivers in a room, at the title. `cut` holds messages back while it is true, as a slow line does. */
function room(a = {}, b = {}) {
  const sims = { a: sim({ seed: 1, ...QUIET, ...a }), b: sim({ seed: 2, ...QUIET, ...b }) };
  const R = { ...sims, sims, cut: false, held: [] };
  R.pump = () => {
    for (const [id, S] of Object.entries(sims)) for (const m of V.drain(S)) R.held.push({ from: id, ...m });
    if (R.cut) return;
    for (const m of R.held.splice(0)) {
      for (const [id, S] of Object.entries(sims)) {
        if (id !== m.from && (!m.to || m.to === id)) V.receive(S, m.from, JSON.parse(JSON.stringify(m.msg)));
      }
    }
  };
  R.run = (ticks) => {
    for (let i = 0; i < ticks; i++) {
      for (const S of Object.values(sims)) step(S);
      R.pump();
    }
  };
  R.until = (fn, seconds, what) => {
    for (let i = 0; i < seconds * 60; i++) {
      if (fn()) return;
      R.run(1);
    }
    assert.fail(`${what}: not in ${seconds} s. a ${sims.a.game.phase}, b ${sims.b.game.phase}`);
  };
  V.attach(sims.a, 'a');
  V.attach(sims.b, 'b');
  V.peerJoined(sims.a, 'b');
  V.peerJoined(sims.b, 'a');
  R.run(3);
  return R;
}

/** A room with the day started and both boards up. */
function day(a, b) {
  const R = room(a, b);
  assert.equal(V.requestStart(R.a), true);
  R.run(3);
  return R;
}

const openRows = (S) => V.board(S).filter((r) => r.state === 'open');
const driving = (S) => S.game.phase === 'DRIVE' || S.game.phase === 'SEARCH';

/** Parks at the errand in hand, by the debug hook the single-player tests use. */
function park(S, quality = 'GOOD') {
  TLV.debug.use(S);
  assert.equal(TLV.debug.parkNow({ quality }), true, 'parked');
}

test('nothing here changes a day alone: no room, no board, and the plan runs', () => {
  const S = sim({ seed: 3, traffic: 0, peds: 0, incidents: 0, contest: 'off' });
  assert.equal(V.active(S), false);
  assert.equal(V.board(S), null);
  assert.equal(S.game.phase, 'CARD');
  assert.equal(S.game.errand.defId, 'milk');
  assert.equal(V.requestStart(S), false);
  assert.equal(V.pick(S, 0), false);
  assert.deepEqual(V.drain(S), []);
  // A message with no room to arrive in is dropped.
  V.receive(S, 'x', { k: 'start', v: V.PROTO, round: 1, rows: [] });
  step(S, 3);
  assert.equal(V.active(S), false);
});

test('the dealer is the lowest id, and either driver can ask for the day to start', () => {
  const R = room();
  assert.equal(V.view(R.a).host, true);
  assert.equal(V.view(R.b).host, false);
  assert.deepEqual(V.view(R.a).peers.map((p) => [p.id, p.compatible]), [['b', true]]);
  assert.equal(R.a.game.phase, 'TITLE');
  // The guest asks, the dealer deals, and both start on the same tick's messages.
  assert.equal(V.requestStart(R.b), true);
  R.run(3);
  for (const S of [R.a, R.b]) {
    assert.equal(S.game.phase, 'CARD');
    assert.equal(S.game.errand, null, 'no errand until one is picked');
    assert.equal(V.active(S), true);
    assert.equal(V.view(S).open, true);
    assert.equal(V.view(S).round, 1);
    assert.equal(events(S, 'run.start').length, 1);
  }
});

test('alone in a room there is nobody to start a day with', () => {
  const S = sim({ seed: 1, ...QUIET });
  V.attach(S, 'solo');
  assert.equal(V.requestStart(S), false);
  assert.equal(S.game.phase, 'TITLE');
});

test('the board: nine errands and the gan, each at a door of its own, the same for both drivers', () => {
  const R = day();
  const a = V.board(R.a);
  const b = V.board(R.b);
  assert.equal(a.length, T.versusTasks + 1);
  assert.deepEqual(a.map((r) => [r.defId, r.x, r.y, r.name]), b.map((r) => [r.defId, r.x, r.y, r.name]));
  assert.equal(a[0].defId, 'milk');
  assert.equal(a[a.length - 1].finale, true);
  assert.equal(a.filter((r) => r.finale).length, 1);
  assert.equal(new Set(a.map((r) => r.defId)).size, a.length, 'no errand twice');
  const doors = R.a.versus.board.filter((r) => r.poi >= 0).map((r) => r.poi);
  assert.equal(new Set(doors).size, doors.length, 'no door twice');
  for (const r of a) {
    assert.ok(r.name.en && r.name.he, r.defId);
    assert.ok(r.text.en && !r.text.en.includes('{poi}'), r.defId);
  }
});

test('expected benefit: every open errand is priced from where the driver stands, by the numbers a day alone pays', () => {
  const R = day();
  const scale = T.difficulty[R.a.game._g.runDifficulty].awardScale;
  for (const r of openRows(R.a)) {
    assert.ok(r.dist > 100, `${r.defId} is ${r.dist} m away`);
    assert.equal(r.pay, Math.round((T.payBase + T.payPerM * r.dist) * T.qualityP.GOOD));
    assert.ok(Math.abs(r.award - (r.dist / T.awardDiv + T.awardBase) * scale) < 1e-9, 'the first errand has no step off its award');
  }
  // Further is worth more, in pay and in clock.
  const rows = openRows(R.a).sort((x, y) => x.dist - y.dist);
  assert.ok(rows[rows.length - 1].pay > rows[0].pay);
  assert.ok(rows[rows.length - 1].award > rows[0].award);
  // What it says is what it pays: the award of the errand picked is the one the board showed.
  const pick = rows[0];
  assert.equal(V.pick(R.a, pick.id), true);
  const e = R.a.game.errand;
  assert.ok(Math.abs(e.award - (e.routeLen / T.awardDiv + T.awardBase) * scale) < 1e-9);
  assert.ok(Math.abs(e.routeLen - pick.dist) < 150, `the bay's road ${e.routeLen} against the door's ${pick.dist}`);
});

test('the gan is the last errand: locked while anything else is open', () => {
  const R = day();
  const gan = V.board(R.a).find((r) => r.finale);
  assert.equal(gan.state, 'locked');
  assert.equal(V.pick(R.a, gan.id), false);
  assert.equal(R.a.game.errand, null);
});

test('a pick binds the errand at the board\'s door, shows the phone card, and tells the other driver', () => {
  const R = day();
  const row = openRows(R.a)[2];
  assert.equal(V.pick(R.a, row.id), true);
  const e = R.a.game.errand;
  assert.equal(e.defId, row.defId);
  assert.equal(e.doorX, row.x);
  assert.equal(e.doorY, row.y);
  assert.deepEqual(e.name, row.name);
  assert.equal(R.a.game.phase, 'CARD');
  assert.ok(R.a.game.phaseT < 0.1, 'the card starts over at the pick, however long the choosing took');
  assert.equal(V.view(R.a).open, false);
  assert.equal(events(R.a, 'errand.start').length, 1);
  assert.ok(R.a.game.nav.route, 'the arrow has a road to follow');
  R.run(3);
  assert.equal(V.board(R.b).find((r) => r.id === row.id).heading, 1, 'the other board says someone is on the way');
  assert.equal(V.view(R.b).peers[0].pick, row.id);
  R.until(() => driving(R.a), 8, 'a drives');
  const clock = R.a.game.clock;
  R.run(30);
  assert.ok(R.a.game.clock < clock, 'and the clock runs');
});

test('an errand one driver parks at is gone for the other, who is sent back to the board', () => {
  const R = day();
  const row = openRows(R.a)[0];
  assert.equal(V.pick(R.a, row.id), true);
  assert.equal(V.pick(R.b, row.id), true, 'both may go for the same errand');
  R.until(() => driving(R.a) && driving(R.b), 8, 'both drive');
  const money = R.a.game.money;
  park(R.a);
  assert.ok(R.a.game.money > money, 'paid');
  R.run(2);
  // The driver who was on the way keeps driving, with nowhere to go and the board up.
  assert.equal(R.b.game.errand, null);
  assert.equal(R.b.game.phase, 'DRIVE');
  assert.equal(V.view(R.b).open, true);
  assert.equal(V.view(R.b).pick, -1);
  assert.equal(events(R.b, 'versus.taken', (e) => e.task === row.id && e.by === 'a').length, 1);
  assert.equal(V.board(R.b).find((r) => r.id === row.id).state, 'theirs');
  assert.equal(V.board(R.a).find((r) => r.id === row.id).state, 'mine');
  assert.equal(V.pick(R.b, row.id), false, 'it cannot be chosen');
  assert.equal(R.b.game.money, 0);
  assert.equal(V.view(R.b).left, T.versusTasks);
  // And from the road it picks another, with no card to wait for.
  const next = openRows(R.b)[0];
  assert.equal(V.pick(R.b, next.id), true);
  assert.equal(R.b.game.phase, 'DRIVE');
  assert.equal(R.b.game.errand.defId, next.defId);
  // The one who parked gets the board back after the payout, with the car pulling out.
  R.until(() => V.view(R.a).open, 8, 'a chooses again');
  assert.equal(R.a.game.phase, 'CARD');
  assert.equal(V.view(R.a).count, 1);
  assert.equal(V.view(R.b).peers[0].count, 1);
  assert.equal(V.view(R.b).peers[0].money, Math.round(R.a.game.money));
});

test('on the way to an errand a driver can look at the board again, keep the errand, or let it go for another', () => {
  const R = day();
  const [first, second] = openRows(R.a);
  V.pick(R.a, first.id);
  assert.equal(V.reconsider(R.a), false, 'not from the card');
  R.until(() => driving(R.a), 8, 'a drives');
  assert.equal(V.reconsider(R.a), true);
  assert.equal(V.view(R.a).open, true);
  assert.equal(R.a.game.errand.defId, first.defId, 'nothing is given up by looking');
  assert.equal(V.board(R.a).find((r) => r.id === first.id).picked, true);
  assert.equal(V.keep(R.a), true);
  assert.equal(V.view(R.a).open, false);
  assert.equal(R.a.game.errand.defId, first.defId);
  V.reconsider(R.a);
  assert.equal(V.pick(R.a, second.id), true);
  assert.equal(R.a.game.errand.defId, second.defId);
  assert.equal(R.a.game.phase, 'DRIVE', 'no stop for a card');
  assert.equal(V.view(R.a).pick, second.id);
  R.run(3);
  assert.equal(V.view(R.b).peers[0].pick, second.id);
  // With nothing in hand the board cannot be put away.
  assert.equal(V.keep(R.b), false);
  assert.equal(V.view(R.b).open, true);
});

test('a photo finish: two parks before either hears of the other, and exactly one of them counts', () => {
  const R = day();
  const row = openRows(R.a)[0];
  V.pick(R.a, row.id);
  V.pick(R.b, row.id);
  R.until(() => driving(R.a) && driving(R.b), 8, 'both drive');
  R.cut = true;
  const before = { money: R.b.game.money, clock: R.b.game.clock, done: R.b.game.stats.errandsDone };
  park(R.a);
  R.run(3);
  park(R.b);
  R.run(1);
  assert.ok(R.a.game.money > 0 && R.b.game.money > 0, 'each thinks it was theirs');
  const gained = R.b.game.clock - before.clock;
  assert.ok(gained > 10, 'and b took the clock for it');
  R.cut = false;
  R.run(2);
  // a parked sooner into its day. Both sims agree, and b gives back what it took.
  for (const S of [R.a, R.b]) assert.equal(S.versus.board[row.id].by, 'a');
  assert.ok(R.a.game.money > 0);
  assert.equal(R.b.game.money, before.money);
  assert.equal(R.b.game.stats.errandsDone, before.done);
  assert.ok(R.b.game.clock < before.clock + gained - 10, 'the award went back');
  assert.equal(V.view(R.a).count, 1);
  assert.equal(V.view(R.b).count, 0);
  assert.equal(events(R.b, 'versus.void').length, 1);
  assert.equal(events(R.a, 'versus.void').length, 0);
  assert.equal(V.view(R.a).left, V.view(R.b).left);
});

test('a dead level tie goes to the lower id, on both sides', () => {
  const R = day();
  const row = openRows(R.a)[0];
  V.pick(R.a, row.id);
  V.pick(R.b, row.id);
  R.until(() => driving(R.a) && driving(R.b), 8, 'both drive');
  R.cut = true;
  // b's day began a moment after a's, when the board reached it. So that far apart on the street is level on the two clocks.
  const late = R.b.versus.startTick - R.a.versus.startTick;
  assert.ok(late >= 1 && late <= 3, `${late} ticks`);
  park(R.a);
  R.run(late);
  park(R.b);
  assert.equal(R.a.versus.board[row.id].t, R.b.versus.board[row.id].t, 'level');
  R.cut = false;
  R.run(2);
  for (const S of [R.a, R.b]) assert.equal(S.versus.board[row.id].by, 'a');
  assert.equal(R.b.game.money, 0);
});

/** Has one driver do every errand that is open to them, one after another. */
function clear(R, S, keep = 0) {
  for (let i = 0; i < 20; i++) {
    R.until(() => S.game.phase === 'RUN_END' || V.view(S).open, 12, 'the board');
    if (S.game.phase === 'RUN_END') return;
    const rows = openRows(S);
    if (rows.length <= keep && !rows.some((r) => r.finale)) return;
    assert.equal(V.pick(S, rows[0].id), true);
    park(S);
  }
  assert.fail('the board never emptied');
}

test('the gan opens when the rest is done, and whoever picks the kid up ends the day for both', () => {
  const R = day();
  clear(R, R.a, 0);
  R.until(() => V.board(R.a).find((r) => r.finale).state !== 'locked' || R.a.game.phase === 'RUN_END', 12, 'the gan');
  // clear() goes on to the gan itself, so by now the day is over.
  R.until(() => R.a.game.phase === 'RUN_END' && R.b.game.phase === 'RUN_END', 12, 'both ended');
  for (const S of [R.a, R.b]) {
    assert.equal(S.game.endReason, 'DONE');
    assert.equal(V.view(S).left, 0);
    assert.equal(events(S, 'versus.unlock').length, 1);
    assert.equal(events(S, 'run.end').length, 1);
  }
  assert.ok(R.a.game.money > 1000);
  assert.equal(R.b.game.money, 0);
  // The gan is the last errand of a day, with the last errand's rules, wherever it came in this driver's own count.
  const last = events(R.a, 'errand.start').pop();
  assert.equal(last.defId, 'gan_pickup');
  assert.equal(last.index, T.legs.length - 1);
  R.run(20);
  assert.equal(V.view(R.a).peers[0].ended, true);
  assert.equal(V.view(R.b).peers[0].ended, true);
  assert.equal(V.view(R.b).peers[0].money, Math.round(R.a.game.money));
});

test('a driver whose clock runs out is out, and the other plays on', () => {
  const R = day();
  V.pick(R.a, openRows(R.a)[0].id);
  V.pick(R.b, openRows(R.b)[1].id);
  R.until(() => driving(R.a) && driving(R.b), 8, 'both drive');
  R.b.game.clock = 0.05;
  R.until(() => R.b.game.phase === 'RUN_END', 3, 'b out');
  assert.equal(R.b.game.endReason, 'CLOCK');
  R.run(20);
  assert.equal(R.a.game.phase !== 'RUN_END', true);
  assert.deepEqual([V.view(R.a).peers[0].ended, V.view(R.a).peers[0].reason], [true, 'CLOCK']);
  assert.equal(events(R.a, 'versus.ended').length, 1);
  // What b did not do is still on the board for a.
  assert.equal(V.view(R.a).left, T.versusTasks + 1);
});

test('another day together starts when both have ended and both have asked, with a new board', () => {
  const R = day();
  const first = V.board(R.a).map((r) => [r.defId, r.x]);
  for (const S of [R.a, R.b]) {
    TLV.debug.use(S);
    TLV.debug.endRun('CLOCK');
  }
  R.run(20);
  V._again(R.b);
  R.run(3);
  assert.equal(R.b.game.phase, 'RUN_END', 'one driver ready is not a day');
  assert.equal(V.view(R.b).ready, true);
  assert.equal(V.view(R.a).peers[0].ready, true);
  V._again(R.a);
  R.run(3);
  for (const S of [R.a, R.b]) {
    assert.equal(S.game.phase, 'CARD');
    assert.equal(V.view(S).round, 2);
    assert.equal(V.view(S).open, true);
    assert.equal(V.view(S).left, T.versusTasks + 1);
    assert.equal(S.game.money, 0);
    assert.equal(V.view(S).peers[0].ended, false);
  }
  assert.deepEqual(V.board(R.a).map((r) => [r.defId, r.x]), V.board(R.b).map((r) => [r.defId, r.x]));
  assert.notDeepEqual(V.board(R.a).map((r) => [r.defId, r.x]), first, 'dealt again');
});

test('the restart key asks for another day while the other driver is still out, and waits', () => {
  const R = day();
  TLV.debug.use(R.a);
  TLV.debug.endRun('TOWED');
  R.run(20);
  V._again(R.a);
  R.run(20);
  assert.equal(R.a.game.phase, 'RUN_END');
  assert.notEqual(R.b.game.phase, 'RUN_END');
  assert.equal(V.view(R.a).round, 1);
});

test('a driver who leaves: the day goes on with the board as it stands, and the next day is a day alone', () => {
  const R = day();
  const row = openRows(R.b)[0];
  V.pick(R.b, row.id);
  park(R.b);
  R.run(3);
  V.peerLeft(R.a, 'b');
  R.run(3);
  assert.equal(events(R.a, 'versus.peer', (e) => e.id === 'b' && !e.joined).length, 1);
  assert.equal(V.active(R.a), true);
  assert.equal(V.board(R.a).find((r) => r.id === row.id).state, 'theirs', 'what they did stays done');
  assert.equal(V.view(R.a).peers.length, 0);
  assert.equal(V.pick(R.a, openRows(R.a)[0].id), true);
  TLV.debug.use(R.a);
  TLV.debug.endRun('CLOCK');
  step(R.a, 2);
  V._again(R.a);
  assert.equal(V.active(R.a), false);
  assert.equal(R.a.game.phase, 'CARD');
  assert.equal(R.a.game.errand.defId, 'milk', 'the plan is back');
});

test('a driver who comes into the room with a day on waits for the next one, and holds nobody up', () => {
  const R = day();
  R.run(20);
  // c arrives. The loop only knows a and b, so c is wired to a by hand, both ways.
  const C = sim({ seed: 9, ...QUIET });
  V.attach(C, 'A0');
  const link = () => {
    for (const m of V.drain(C)) if (!m.to || m.to === 'a') V.receive(R.a, 'A0', JSON.parse(JSON.stringify(m.msg)));
  };
  const toC = (msgs) => { for (const m of msgs) if (!m.to || m.to === 'A0') V.receive(C, 'a', JSON.parse(JSON.stringify(m.msg))); };
  V.peerJoined(C, 'a');
  V.peerJoined(R.a, 'A0');
  const run = (n) => {
    for (let i = 0; i < n; i++) {
      step(C);
      step(R.a);
      step(R.b);
      link();
      const out = V.drain(R.a);
      toC(out);
      for (const m of out) if (!m.to || m.to === 'b') V.receive(R.b, 'a', JSON.parse(JSON.stringify(m.msg)));
      for (const m of V.drain(R.b)) if (!m.to || m.to === 'a') V.receive(R.a, 'b', JSON.parse(JSON.stringify(m.msg)));
    }
  };
  run(30);
  // c has the lowest id of all, and still deals nothing: the others are out.
  assert.deepEqual(V.view(C).peers.map((p) => [p.compatible, p.busy, p.playing]), [[true, true, false]]);
  assert.equal(V.requestStart(C), false);
  assert.equal(C.game.phase, 'TITLE');
  assert.equal(V.view(R.a).peers.find((p) => p.id === 'A0').playing, false);
  assert.equal(V.view(R.a).host, true, 'the dealer is still one of those who are in the day');
  // a and b end their day and ask for another. c is not waited for, and is dealt in.
  for (const S of [R.a, R.b]) {
    TLV.debug.use(S);
    TLV.debug.endRun('CLOCK');
  }
  run(20);
  V._again(R.a);
  V._again(R.b);
  run(10);
  for (const S of [R.a, R.b, C]) {
    assert.equal(S.game.phase, 'CARD');
    assert.equal(V.view(S).round, 2);
    assert.equal(V.view(S).open, true);
  }
  assert.deepEqual(V.board(C).map((r) => [r.defId, r.x]), V.board(R.a).map((r) => [r.defId, r.x]));
});

test('what arrives is checked: junk, a board from a stranger, and a build that speaks another protocol', () => {
  const R = room();
  const rows = V._deal(R.a);
  assert.ok(rows.length > 2);
  // Nor does a board with a door that is no number, an errand nobody shipped, or no rows.
  V.receive(R.b, 'a', { k: 'start', v: V.PROTO, round: 1, rows: [{ ...rows[0], x: 'east' }] });
  V.receive(R.b, 'a', { k: 'start', v: V.PROTO, round: 1, rows: [{ ...rows[0], defId: 'toString' }] });
  V.receive(R.b, 'a', { k: 'start', v: V.PROTO, round: 1, rows: [] });
  V.receive(R.b, 'a', { k: 'start', v: V.PROTO + 1, round: 1, rows });
  for (const junk of [null, 7, 'start', [], { k: 'constructor' }, { k: 'done', task: 'x' }, { k: 'state', x: NaN }, { k: 'pick', task: 1e9 }]) V.receive(R.b, 'a', junk);
  V.receive(R.b, 'stranger', { k: 'start', v: V.PROTO, round: 1, rows });
  R.run(3);
  assert.equal(R.a.game.phase, 'TITLE');
  assert.equal(R.b.game.phase, 'TITLE');
  // The real thing, from the dealer, does.
  V.receive(R.b, 'a', JSON.parse(JSON.stringify({ k: 'start', v: V.PROTO, round: 1, rows, difficulty: 'normal' })));
  R.run(1);
  assert.equal(R.b.game.phase, 'CARD');
  assert.equal(R.b.game.difficulty, 'normal', 'the dealer\'s difficulty is the day\'s');

  // A peer on another protocol is in the room, and not in the game.
  const S = sim({ seed: 4, ...QUIET });
  V.attach(S, 'm');
  V.peerJoined(S, 'z');
  V.receive(S, 'z', { k: 'hello', v: V.PROTO + 1 });
  step(S, 2);
  assert.deepEqual(V.view(S).peers.map((p) => [p.compatible, p.mismatch]), [[false, true]]);
  assert.equal(V.requestStart(S), false);
  // And a flood stops at the door.
  for (let i = 0; i < T.versusInboxMax * 2; i++) V.receive(S, 'z', { k: 'pick', r: 0, task: 1 });
  assert.equal(S.versus.inbox.length, T.versusInboxMax);
});

test('a driver reports where they are a few times a second, and never a private thing', () => {
  const R = day();
  V.pick(R.a, openRows(R.a)[0].id);
  R.until(() => driving(R.a), 8, 'a drives');
  const sent = [];
  for (let i = 0; i < 60; i++) {
    step(R.a);
    for (const m of V.drain(R.a)) if (m.msg.k === 'state') sent.push(m.msg);
  }
  assert.ok(sent.length >= 5 && sent.length <= 8, `${sent.length} reports in a second`);
  assert.deepEqual(Object.keys(sent[0]).sort(), ['e', 'h', 'k', 'm', 'n', 'on', 'p', 'r', 's', 'w', 'x', 'y']);
  const veh = R.a.player.veh;
  assert.ok(Math.abs(sent[sent.length - 1].x - veh.x) < 3);
  assert.ok(JSON.stringify(sent[0]).length < 160, 'a small message');
});

test('leaving the room at the title puts the game back as it was', () => {
  const R = room();
  V.detach(R.a);
  assert.equal(V.view(R.a).linked, false);
  assert.equal(V.view(R.a).peers.length, 0);
  V.receive(R.a, 'b', { k: 'hello', v: V.PROTO });
  assert.equal(R.a.versus.inbox.length, 0);
  assert.equal(V.requestStart(R.a), false);
});
