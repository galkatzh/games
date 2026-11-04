// tests/ui/bay_line.test.mjs — WP-UI
// The owner's rule for the BRAKE line, measured on the keys and the line the player really has: a driver who does what the screen says
// and nothing else, with a reaction delay, on tapped keys, on 40 real bays. BRAKE must not coach a careful driver into an ugly park, and
// must still save a fast one. A careful driver who obeys reaches GOOD or better on at least 70% of bays at 1.4 and 2.2 m/s.
import assert from 'node:assert';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createTLV, createSim } from '../../tools/lib/classic.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const BAYS = [[1, 2], [1, 3], [1, 4], [1, 5], [1, 6], [1, 7], [2, 2], [2, 4], [2, 5], [2, 6], [2, 7], [3, 2], [3, 3], [3, 4], [3, 5], [3, 6], [3, 7], [4, 2], [4, 6], [4, 7],
  [5, 7], [6, 6], [6, 7], [7, 3], [8, 2], [8, 4], [8, 5], [9, 7], [10, 7], [11, 6], [11, 7], [12, 6], [12, 7], [13, 7], [14, 5], [14, 7], [15, 4], [15, 7], [16, 2], [16, 6]];
const LAG_TICKS = 18; // 0.3 s
const TAP = 4;
const START_A = -6;
const END_A = 2;
const LOOK = 2.2;

const TLV = createTLV({ files: ['sim', 'js/ui/tune.js', 'js/ui/strings.js', 'js/ui/hud.js'], map: 'tlv_center', content: true, allowMissing: true, params: {} });
const on = { keydown: [], keyup: [], blur: [] };
const win = {
  TLV, navigator: {},
  addEventListener: (n, f) => on[n].push(f),
  removeEventListener: (n, f) => { on[n] = on[n].filter((x) => x !== f); },
  key(type, code) { const e = { code, repeat: false, preventDefault() {} }; for (const f of on[type]) f(e); }
};
vm.compileFunction(fs.readFileSync(path.join(ROOT, 'js/input/input.js'), 'utf8'), ['window', 'TLV'], { filename: 'input.js' })(win, TLV);

/** Steers a pure pursuit of the S-curve into the bay, on key taps, and works the pedals by the line the screen shows, seen late. */
function driver(spot, obey, pace) {
  const seen = [];
  const cs = Math.cos(spot.h);
  const sn = Math.sin(spot.h);
  let from = null;
  let steerErr = 0;
  let key = 0;
  let hold = 0;
  let w = false;
  let s = false;
  let wHold = 0;
  let done = false;
  const set = (code, want, was) => { if (want !== was) win.key(want ? 'keydown' : 'keyup', code); return want; };
  const curve = (a) => {
    if (a <= START_A) return from;
    if (a >= END_A) return 0;
    return from * (1 + Math.cos(Math.PI * (a - START_A) / (END_A - START_A))) / 2;
  };
  return (S) => {
    const veh = S.player.veh;
    seen.push({ x: veh.x, y: veh.y, h: veh.h, v: veh.v, line: S.game.park.stage ? TLV.ui.hud.parkKey(S) : null });
    const p = seen.length > LAG_TICKS ? seen[seen.length - 1 - LAG_TICKS] : seen[0];
    const ex = p.x - spot.x;
    const ey = p.y - spot.y;
    const a = ex * cs + ey * sn;
    const l = -ex * sn + ey * cs;
    if (from === null) from = l;
    if (S.player.mode !== 'DRIVE') {
      w = set('KeyW', false, w);
      s = set('KeyS', false, s);
      return;
    }
    const ta = a + LOOK;
    const tl = curve(ta);
    const dx = spot.x + ta * cs - tl * sn - p.x;
    const dy = spot.y + ta * sn + tl * cs - p.y;
    const alpha = TLV.math.wrapPi(Math.atan2(dy, dx) - p.h);
    const delta = Math.atan2(2 * veh.wheelbase * Math.sin(alpha), Math.hypot(dx, dy));
    const u = TLV.math.clamp(delta / TLV.player._steerMax(Math.abs(p.v)), -1, 1);
    hold--;
    if (hold <= 0) {
      steerErr += u;
      const want = steerErr > 0.5 ? 1 : (steerErr < -0.5 ? -1 : 0);
      if (want !== key) {
        if (key === 1) win.key('keyup', 'KeyA');
        if (key === -1) win.key('keyup', 'KeyD');
        if (want === 1) win.key('keydown', 'KeyA');
        if (want === -1) win.key('keydown', 'KeyD');
        key = want;
      }
      steerErr = TLV.math.clamp(steerErr - want, -1.5, 1.5);
      hold = TAP;
    }
    if (p.line === 'park.STOP' || (obey && p.line === 'park.BRAKE')) done = true;
    if (done) {
      w = set('KeyW', false, w);
      s = set('KeyS', true, s);
      return;
    }
    wHold--;
    if (wHold <= 0) {
      w = set('KeyW', Math.abs(p.v) < pace - 0.25 && !w, w);
      s = set('KeyS', Math.abs(p.v) > pace + 0.7 && !s, s);
      wHold = TAP;
    }
  };
}

/** @returns {{good:number, ugly:number, armedContacts:number, contacts:number}} Over all the bays. */
function drive(pace, obey) {
  const out = { good: 0, ugly: 0, armedContacts: 0, contacts: 0 };
  for (const [seed, errand] of BAYS) {
    const S = createSim(TLV, { seed, params: { notitle: 1, traffic: 0, peds: 0, incidents: 0, contest: 'off', seed, errand } });
    TLV.sim.step(S);
    TLV.input.init(win, S);
    for (let n = 0; S.game.phase !== 'DRIVE' && n < 800; n++) TLV.sim.step(S);
    const e = S.game.errand;
    const spot = TLV.world.parking.spot(S.world, e.bayId);
    const at = TLV.world.lanes.pointAt(S.world, spot.laneId, Math.max(1, spot.laneS - 25), {});
    TLV.player.setPose(S, at.x, at.y, at.h, 0);
    TLV.game.nav.setTarget(S, spot.laneId, spot.laneS, spot.x, spot.y);
    const go = driver(spot, obey, pace);
    S.controlSource = (s) => { go(s); return TLV.input.sample(s, s.controls); };
    let quality = null;
    let hit = false;
    let hitArmed = false;
    S.bus.on('player.contact', () => { hit = true; if (S.game.park.stage) hitArmed = true; });
    S.bus.on('errand.parked', (p) => { quality = p.quality; });
    for (let i = 0; i < 40 * 60 && quality === null && S.game.phase !== 'RUN_END'; i++) TLV.sim.step(S);
    for (const c of ['KeyW', 'KeyS', 'KeyA', 'KeyD']) win.key('keyup', c);
    if (quality === 'PERFECT' || quality === 'GOOD') out.good++;
    else if (quality === 'UGLY') out.ugly++;
    if (hit) out.contacts++;
    if (hitArmed) out.armedContacts++;
  }
  return out;
}

for (const pace of [1.4, 2.2]) {
  test(`a careful driver at ${pace} m/s who obeys BRAKE reaches GOOD or better on at least 70% of the bays, and BRAKE costs them nothing`, () => {
    const obey = drive(pace, true);
    assert.ok(obey.good >= BAYS.length * 0.7, `${obey.good} of ${BAYS.length}`);
    const ignore = drive(pace, false);
    assert.ok(obey.good >= ignore.good, `obeying ${obey.good}, rolling through ${ignore.good}`);
    assert.strictEqual(obey.armedContacts, 0, 'and no contact once the bay has armed');
  });
}

test('at 3 m/s BRAKE still saves the car: a driver who obeys has far fewer contacts than one who rolls through it', () => {
  const obey = drive(3, true);
  const ignore = drive(3, false);
  assert.ok(obey.contacts * 3 <= ignore.contacts, `obeying ${obey.contacts} bays, rolling through ${ignore.contacts}`);
  assert.ok(obey.good >= ignore.good, `obeying ${obey.good}, rolling through ${ignore.good}`);
});
