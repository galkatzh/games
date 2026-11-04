// tests/ui/foot_way.test.mjs — WP-UI
// The chase's one instruction, headless on the real ground: the heading both arrows draw (hud.footHeading, falling back to nav.arrowH as
// js/render/effects.js does) gets a runner to the door where the straight bearing does not, and reading it leaves the sim alone.
import assert from 'node:assert';
import { test } from 'node:test';
import { createTLV, createSim } from '../../tools/lib/classic.mjs';

const TLV = createTLV({ files: ['sim', 'js/ui/tune.js', 'js/ui/strings.js', 'js/ui/hud.js'], map: 'tlv_center', content: true, allowMissing: true, params: {} });
const { hud } = TLV.ui;

/** A chase forced from the errand's bay, with the door out of a straight line on these seeds. */
function chase(seed, errand) {
  const S = createSim(TLV, { seed, params: { notitle: 1, errand, contest: 'force', knife: 'force', difficulty: 'relaxed', immortal: 1 } });
  for (let i = 0; i < 600 && S.game.phase !== 'DRIVE'; i++) TLV.sim.step(S);
  const sp = TLV.world.parking.spot(S.world, S.game.errand.bayId);
  TLV.player.setPose(S, sp.x, sp.y, sp.h, 0);
  TLV.sim.step(S);
  assert.ok(TLV.game.knife._force(S, 'CHASE', 8), 'the chase starts');
  return S;
}

/**
 * Runs a chase to its end.
 * @param {object} S Sim state, in the chase.
 * @param {boolean} arrow True follows what the arrow draws, false the sim's straight bearing.
 * @returns {{exit:string, bent:boolean, strikes:number, off:number}} How it ended, whether the way bent, strikes, and the largest gap between heading and bearing.
 */
function run(S, arrow) {
  const g = S.game;
  const ctl = TLV.const._newControls();
  let bent = false;
  let strikes = 0;
  let off = 0;
  S.bus.on('knife.strike', () => { strikes++; });
  S.controlSource = () => {
    const way = arrow ? hud.footHeading(S) : null;
    const h = way === null ? g.nav.arrowH : way;
    off = Math.max(off, Math.abs(TLV.math.wrapPi(h - g.nav.arrowH)));
    ctl.footX = Math.cos(h);
    ctl.footY = Math.sin(h);
    return ctl;
  };
  for (let t = 0; t < 60 * 40; t++) {
    if (t % 6 === 0 && S.player.mode === 'FOOT') {
      const grid = hud.footWay(S, 0.1);
      if (t === 0 && grid) bent = grid.round;
    }
    TLV.sim.step(S);
    if (g.phase !== 'ENCOUNTER' || !g.knife || g.knife.stage !== 'CHASE') break;
  }
  hud.footWay(S, 0);
  return { exit: g.knife ? g.knife.exit : g.endReason, bent, strikes, off };
}

for (const [seed, errand] of [[1, 1], [3, 3], [5, 3]]) {
  test(`seed ${seed} errand ${errand}: the straight bearing is blocked, and a runner who follows only the arrow arrives under three strikes`, () => {
    const lost = run(chase(seed, errand), false);
    assert.ok(lost.bent, 'the door is not in a clear line here');
    assert.notStrictEqual(lost.exit, 'REACHED_SHOP', 'and the bearing does not get there, or this seed proves nothing');
    const made = run(chase(seed, errand), true);
    assert.strictEqual(made.exit, 'REACHED_SHOP');
    assert.ok(made.strikes < 3, `${made.strikes} strikes`);
    assert.ok(made.off > 0.1, 'the arrow really left the bearing');
  });
}

test('with no chase on there is no heading, so the arrow keeps the sim\'s bearing', () => {
  const S = createSim(TLV, { seed: 1, params: { notitle: 1, contest: 'off' } });
  for (let i = 0; i < 300 && S.game.phase !== 'DRIVE'; i++) TLV.sim.step(S);
  assert.strictEqual(hud.footWay(S, 0.1), null);
  assert.strictEqual(hud.footHeading(S), null);
});

test('reading the way changes nothing in the sim: the same hash with the HUD reading it every step or never', () => {
  const hashes = [true, false].map((read) => {
    const S = chase(3, 3);
    const ctl = TLV.const._newControls();
    ctl.footX = 1;
    S.controlSource = () => ctl;
    for (let t = 0; t < 600 && S.game.phase === 'ENCOUNTER'; t++) {
      if (read) {
        hud.footWay(S, 0.1);
        hud.footHeading(S);
      }
      TLV.sim.step(S);
    }
    if (read) hud.footWay(S, 0);
    return TLV.sim.hash(S);
  });
  assert.strictEqual(hashes[0], hashes[1]);
});
