// tests/game/lawful_day.test.mjs — WP-GAME
// clock.test.mjs moves a ghost along the route at a tier speed, on normal, with nothing in the way, so it cannot say whether anyone reaches
// those speeds. This is the whole day: the stock errands bot in real traffic, with signals, people and contests. It stops at reds, gives way
// and cannot overtake, so it is the slowest honest driver there is. RELAXED is set against it: the clock must not be what beats that driver.
// Normal stays the design's table, where a queue-bound driver ends on errand 2 (GAME_DESIGN 7), and that is clock.test.mjs's to hold.
import test from 'node:test';
import { assert, realTLV } from './helpers.mjs';
import { createSim } from '../../tools/lib/classic.mjs';

const TLV = realTLV();
const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];

/** A real day. @returns {{end:string, parks:number, speed:number}} How it ended, and mean speed in DRIVE and SEARCH. */
function realDay(seed) {
  const S = createSim(TLV, { seed, params: { notitle: 1, autoplay: 'errands', difficulty: 'relaxed' } });
  let parks = 0;
  S.bus.on('errand.parked', () => { parks++; });
  let time = 0;
  let metres = 0;
  for (let i = 0; i < 60 * 2400; i++) {
    TLV.sim.step(S);
    const g = S.game;
    if (!g) continue;
    if (g.phase === 'RUN_END') break;
    if (g.phase === 'DRIVE' || g.phase === 'SEARCH') {
      time += TLV.const.DT;
      metres += Math.abs(S.player.veh.v) * TLV.const.DT;
    }
  }
  return { end: S.game.endReason, parks, speed: metres / time };
}

/** The ghost of clock.test.mjs on relaxed. @returns {boolean} True on a win. */
function ghostDay(seed, speed, overhead) {
  const S = createSim(TLV, { seed, params: { notitle: 1, traffic: 0, peds: 0, incidents: 0, contest: 'off', difficulty: 'relaxed' } });
  TLV.sim.step(S);
  const dt = TLV.const.DT;
  let s = 0;
  let route = null;
  let wait = 0;
  for (let i = 0; i < 60 * 2400; i++) {
    const G = S.game;
    if (G.phase === 'RUN_END') break;
    if ((G.phase === 'DRIVE' || G.phase === 'SEARCH') && G.errand) {
      if (G.nav.route !== route) {
        route = G.nav.route;
        s = 0;
        wait = 0;
      }
      s += speed * dt;
      if (s >= route.len) {
        wait += dt;
        if (wait >= overhead) {
          G.contacts = 1;
          TLV.debug.use(S);
          TLV.debug.parkNow({ quality: 'GOOD' });
          if (G.errandIndex === 6) return true;
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
  return S.game.endReason === 'WIN';
}

test('RELAXED: a lawful drive in real traffic finishes the day, and the clock is not what stops it', () => {
  const days = SEEDS.map(realDay);
  const speed = days.reduce((sum, d) => sum + d.speed, 0) / days.length;
  console.log(`real days: ${days.map((d) => `${d.end} ${d.parks} ${d.speed.toFixed(2)}`).join(', ')}; mean ${speed.toFixed(2)} m/s`);
  assert.ok(speed > 3 && speed < 6.5, `${speed} m/s is no longer the queue-bound driver of GAME_DESIGN 7`);
  // Seeds 1-40 read 27 wins and 4 clocks. The rest ended on a knife or a tow, which this bot cannot dodge and a person may. These eight are a low draw.
  assert.ok(days.filter((d) => d.end === 'WIN').length >= 3, 'days are won');
  assert.ok(days.filter((d) => d.end === 'CLOCK').length <= 2, 'the clock takes few lawful days');

  // What ties the ghost to the street: at the speed the real driver reached, with a parking overhead of the size its legs show, it wins.
  const seeds = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12];
  const ghost = seeds.filter((seed) => ghostDay(seed, speed, 30)).length;
  console.log(`ghost at ${speed.toFixed(2)} m/s and 30 s: wins ${ghost} of ${seeds.length}`);
  assert.ok(ghost >= 10, `${ghost} of ${seeds.length}`);
});

test('RELAXED still has a clock: a driver who dawdles at 3 m/s runs out of it', () => {
  const seeds = [1, 2, 3, 4, 5, 6];
  assert.equal(seeds.filter((seed) => ghostDay(seed, 3, 15)).length, 0);
});
