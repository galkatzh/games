// tests/player/touch_feel.test.mjs — WP-PLAYER
// The on-screen stick, through input.sample, driving the real car on an empty road (GAME_DESIGN 5). What it checks is feel: a light
// push creeps slowly enough to park, a full push launches, the stick back stops the car and then reverses, and a recorded touch
// drive replays to the same state as any other drive.
import assert from 'node:assert';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { loadTLV, makeSim, run, flatten, MINI } from './helpers.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** A car at rest on an empty road, with input.js loaded into the same TLV and installed as the control source. */
function rig() {
  const TLV = loadTLV(MINI);
  flatten(TLV);
  const win = { TLV, navigator: {}, addEventListener() {}, removeEventListener() {} };
  const file = path.join(ROOT, 'js/input/input.js');
  vm.compileFunction(fs.readFileSync(file, 'utf8'), ['window', 'TLV'], { filename: file })(win, TLV);
  const S = makeSim(TLV);
  TLV.input.init(win, S);
  TLV.player.setPose(S, 0, 0, 0, 0);
  return { TLV, S, touch: TLV.input.touch, veh: S.vehicles[0] };
}

const T = loadTLV(MINI).tune;

test('a light push creeps: the car moves, and stays well under the speed a bay arms at', () => {
  const { TLV, S, touch, veh } = rig();
  touch.stick(0, -0.3);
  let top = 0;
  run(TLV, S, 180, () => { top = Math.max(top, veh.v); });
  assert.ok(veh.v > 0.2, `it moves, ${veh.v.toFixed(2)} m/s`);
  assert.ok(top < 3, `a creep, ${top.toFixed(2)} m/s at most`);
  assert.ok(S.controls.throttle > 0.096 && S.controls.throttle < 0.2);
});

test('a full push launches: the first tick is over the Green Launch threshold', () => {
  const { TLV, S, touch } = rig();
  touch.stick(0, -1);
  run(TLV, S, 1);
  assert.ok(S.controls.throttle >= T.player.launchThrottle);
  assert.equal(S.controls.throttle, 1);
});

test('the stick back stops the car, then reverses after the pause a key gets too', () => {
  const { TLV, S, touch, veh } = rig();
  touch.stick(0, -1);
  run(TLV, S, 600, () => { if (veh.v > 5) touch.stick(0, 0); });
  run(TLV, S, 60);
  TLV.player.setPose(S, veh.x, veh.y, veh.h, 5);
  touch.stick(0, 0.5);
  let stopped = null;
  for (let i = 0; i < 120 && stopped === null; i++) {
    run(TLV, S, 1);
    if (Math.abs(veh.v) < 0.4) stopped = (i + 1) / 60;
  }
  assert.ok(stopped !== null && stopped < 1, `stopped in ${stopped} s`);
  run(TLV, S, Math.ceil(60 * (T.player.reverseDelayS + 0.6)));
  assert.ok(veh.v < -0.2, `and backs up, ${veh.v.toFixed(2)} m/s`);
});

test('letting go coasts the car down, and at rest every output is exactly zero', () => {
  const { TLV, S, touch, veh } = rig();
  TLV.player.setPose(S, 0, 0, 0, 2);
  touch.stick(0.4, -0.5);
  run(TLV, S, 10);
  touch.stick(0, 0);
  run(TLV, S, 600);
  assert.ok(Math.abs(veh.v) < 0.2, `coasted to ${veh.v.toFixed(3)} m/s`);
  for (const f of ['throttle', 'brake', 'steer', 'footX', 'footY']) assert.equal(S.controls[f], 0, f);
});

test('a recorded touch drive replays to the same state, and a held thumb keeps the log short', () => {
  const { TLV, S, touch } = rig();
  const rec = TLV.replay.createRecorder(S);
  // A log is indexed from tick 1, and makeSim has already run that one idle.
  rec.record(TLV.const._newControls());
  const plan = [[0, -0.9, 90], [0.6, -0.5, 120], [-0.4, -0.2, 90], [0, 0.7, 60], [0, 0, 60], [-0.8, -1, 180]];
  let ticks = 0;
  for (const [x, y, n] of plan) {
    touch.stick(x, y);
    for (let i = 0; i < n; i++) {
      const c = TLV.input.sample(S, S.controls);
      rec.record(c);
      TLV.sim.step(S);
      ticks++;
    }
  }
  const log = rec.finish();
  assert.ok(log.inputs.length < ticks / 4, `${log.inputs.length} runs for ${ticks} ticks`);
  const hash = TLV.sim.hash(S);
  // Set up exactly as the drive was: the idle tick, then the pose, with the log as the control source throughout.
  const again = makeSim(TLV, { controlSource: TLV.replay.createPlayer(JSON.parse(JSON.stringify(log))) });
  TLV.player.setPose(again, 0, 0, 0, 0);
  for (let i = 0; i < ticks; i++) TLV.sim.step(again);
  assert.equal(TLV.sim.hash(again), hash);
});
