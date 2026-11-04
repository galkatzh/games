// tests/game/clock.test.mjs — WP-GAME
// ARCHITECTURE 17.4: real flow and errands, driven by a kinematic ghost that moves along nav.route at a tier speed and parks after a
// tier delay, ignoring collisions. It must reproduce the table in GAME_DESIGN 7 within one errand, on 20 seeds.
import test from 'node:test';
import { assert, realTLV, sim, step } from './helpers.mjs';

const TLV = realTLV();
const SEEDS = 20;

/** Runs a day. @returns {{errand:number, won:boolean, t:number, left:number, routes:number[]}} Where it ended. */
function day(seed, speed, overhead, spotless) {
  const S = sim({ seed, difficulty: 'normal' });
  const dt = TLV.const.DT;
  const g = () => S.game;
  let s = 0;
  let route = null;
  let wait = 0;
  let driving = 0;
  const routes = [];
  for (let i = 0; i < 60 * 1500; i++) {
    const G = g();
    if (G.phase === 'RUN_END') break;
    if ((G.phase === 'DRIVE' || G.phase === 'SEARCH') && G.errand) {
      driving += dt;
      if (G.nav.route !== route) {
        route = G.nav.route;
        s = 0;
        wait = 0;
        routes.push(route.len);
      }
      s += speed * dt;
      if (s >= route.len) {
        wait += dt;
        if (wait >= overhead) {
          if (!spotless) G.contacts = 1;
          const left = G.clock;
          TLV.debug.use(S);
          TLV.debug.parkNow({ quality: 'GOOD' });
          if (G.errandIndex === 6) return { errand: 7, won: true, t: driving, left, routes };
          route = null;
        }
      } else {
        const at = G._g.pt;
        TLV.math.polyAt(route.px, route.py, route.cum, s, at);
        TLV.player.setPose(S, at.x, at.y, at.h, 0);
      }
    }
    TLV.sim.step(S);
  }
  const G = g();
  return { errand: G.errandIndex + 1, won: G.endReason === 'WIN', t: driving, left: 0, routes, reason: G.endReason };
}

function tier(speed, overhead, spotless) {
  const out = [];
  for (let seed = 1; seed <= SEEDS; seed++) out.push(day(seed, speed, overhead, spotless));
  return out;
}

const median = (list) => [...list].sort((a, b) => a - b)[Math.floor(list.length / 2)];

function report(name, rows) {
  const ends = rows.map((r) => r.errand);
  const wins = rows.filter((r) => r.won).length;
  console.log(`${name}: ends on errands ${ends.join(' ')}, median ${median(ends)}; wins ${wins} of ${rows.length}; median ${(median(rows.map((r) => r.t)) / 60).toFixed(1)} min of clock`);
  return { median: median(ends), wins };
}

/** Within one errand of the table, on the median of the seeds, and on all but a few of them. */
function within(rows, errand, slack = 2) {
  const off = rows.filter((r) => Math.abs(r.errand - errand) > 1).length;
  assert.ok(off <= slack, `${off} of ${rows.length} seeds off by more than one errand from errand ${errand}: ${rows.map((r) => r.errand).join(' ')}`);
}

test('table: queue-bound, 6.0 m/s and 20 s: dies on errand 2, or 3 with SPOTLESS', () => {
  const plain = tier(6, 20, false);
  const clean = tier(6, 20, true);
  report('queue-bound', plain);
  report('queue-bound SPOTLESS', clean);
  within(plain, 2);
  within(clean, 3);
  assert.equal(plain.filter((r) => r.won).length, 0);
  assert.equal(clean.filter((r) => r.won).length, 0);
});

test('table: typical, 7.5 m/s and 15 s: dies on errand 4, or 5 with SPOTLESS', () => {
  const plain = tier(7.5, 15, false);
  const clean = tier(7.5, 15, true);
  report('typical', plain);
  report('typical SPOTLESS', clean);
  within(plain, 4);
  within(clean, 5);
  assert.equal(plain.filter((r) => r.won).length, 0);
});

test('table: good, 9.0 m/s and 12 s: dies on the gan, and wins with SPOTLESS', () => {
  const plain = tier(9, 12, false);
  const clean = tier(9, 12, true);
  report('good', plain);
  report('good SPOTLESS', clean);
  within(plain, 7);
  within(clean, 7);
  assert.ok(clean.filter((r) => r.won).length >= plain.filter((r) => r.won).length);
  assert.ok(clean.filter((r) => r.won).length >= SEEDS / 2, 'clean driving is what converts a good run into a win');
});

test('table: expert, 11.0 m/s and 10 s: wins, with time left', () => {
  const plain = tier(11, 10, false);
  const clean = tier(11, 10, true);
  const a = report('expert', plain);
  report('expert SPOTLESS', clean);
  assert.ok(a.wins >= SEEDS - 2, `${a.wins} of ${SEEDS} win`);
  console.log(`expert time left: ${median(plain.map((r) => r.left)).toFixed(1)} s, SPOTLESS ${median(clean.map((r) => r.left)).toFixed(1)} s (table 96.4 and 144.4)`);
  assert.ok(clean.every((r) => r.won));
  assert.ok(median(clean.map((r) => r.left)) > median(plain.map((r) => r.left)));
});

test('the first leg gives the table\'s bay route: 460 m nominal', () => {
  const S = sim({ seed: 1 });
  const r = S.game.nav.route.len;
  assert.ok(Math.abs(r - 460) < 40, `${r.toFixed(0)} m`);
  step(S, 1);
});
