// tests/peds/stack.test.mjs — section 19 items 1, 4, 5 and 6 on the real thing: tlv_center, real WP-TRAFFIC and WP-PLAYER, the patrol bot
// at the wheel. WP-GAME is left out: nothing here needs it, and its absence makes this a test of people and cars alone. With those
// packages missing, this says so and skips. Set TLV_PEDS_SOAK=<minutes> for a longer run.
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import { createTLV, createSim, quiet } from './helpers.mjs';

quiet();

const ready = ['traffic/traffic.js', 'player/bots.js'].every((f) => fs.existsSync(new URL(`../../js/sim/${f}`, import.meta.url)));
const skip = ready ? false : 'WP-TRAFFIC and WP-PLAYER are not in the tree';
const MINUTES = Number(process.env.TLV_PEDS_SOAK) || 10;

/** Every sim file but the game's. */
function stack(params) {
  const bare = createTLV({ files: [], allowMissing: true });
  const files = bare.manifest.sim.filter((f) => !/js\/sim\/game\//.test(f));
  return createTLV({ files, map: 'tlv_center', allowMissing: true, params });
}

test(`on real traffic, ${MINUTES} sim-min: 40-60 people, no AI contact, no zone held past 25 s, traffic flowing`, { skip }, () => {
  const params = { density: 100, invariants: 1, autoplay: 'patrol' };
  const TLV = stack(params);
  const S = createSim(TLV, { seed: 1, allowMissing: true, params });
  TLV.traffic.prewarm(S);
  const steps = [];
  const late = [];
  S.bus.on('ped.stepOut', (e) => {
    steps.push(e.state);
    // Section 19 item 4, read at every real step-out, with its own arithmetic rather than the gate's.
    const p = TLV.peds.byId(S, e.pedId);
    const path = p && p._p.path;
    if (!path || path.nz === 0) return;
    const held = path.xing >= 0 && S.world.xings[path.xing].signal && TLV.world.signals.pedWalk(S, path.xing);
    for (let k = 0; k < path.nz; k++) {
      const x = path.zX[k];
      const y = path.zY[k];
      const me = S.vehicles[0];
      const nx = me.x + Math.cos(me.h) * me.length / 2;
      const ny = me.y + Math.sin(me.h) * me.length / 2;
      const d = Math.hypot(x - nx, y - ny);
      const closing = ((x - nx) * me.vx + (y - ny) * me.vy) / (d || 1);
      if (closing > 0.1 && d / closing < 1.5) late.push(['player', d / closing]);
      const lane = path.zLane[k];
      if (lane < 0) continue;
      for (const v of S.vehicles) {
        if (!v.active || v.isPlayer || v.laneId !== lane) continue;
        const speed = Math.abs(v.v);
        if (held && speed < 0.3) continue;
        const ahead = ((x - v.x) * Math.cos(v.h) + (y - v.y) * Math.sin(v.h)) * (v.v < 0 ? -1 : 1);
        // By body distance too: on a curved lane a car can be 1 m ahead along its heading and 8 m from the point.
        const nose = ahead - v.length / 2;
        const body = TLV.peds.walk.bodyDist(v, x, y);
        if (nose >= 0 && body < speed * speed / 16 + 3) late.push(['ai', nose, speed]);
      }
    }
  });
  const counts = [];
  let flow = 0;
  for (let i = 0; i < 60 * 60 * MINUTES; i++) {
    TLV.sim.step(S);
    if (i % 60 !== 59 || i < 120) continue;
    let n = 0;
    for (const p of S.peds) {
      if (p.active && Math.hypot(p.x - S.player.fx, p.y - S.player.fy) <= 120) n++;
    }
    counts.push(n);
    flow += S.traffic.stats.meanSpeed;
  }
  assert.ok(Math.min(...counts) >= 40 && Math.max(...counts) <= 60, `${Math.min(...counts)} to ${Math.max(...counts)}`);
  assert.strictEqual(S.pedsys.contacts, 0, JSON.stringify(S.pedsys.lastContact));
  assert.ok(S.pedsys.maxDwell <= 25, `${S.pedsys.maxDwell} s`);
  assert.deepStrictEqual(S.invariantFailures.filter((f) => f.startsWith('peds')), []);
  assert.ok(flow / counts.length >= 4.5, `traffic at ${flow / counts.length} m/s`);
  assert.ok(steps.length > 100, `${steps.length} step-outs`);
  assert.deepStrictEqual(late, [], 'stepped out too close');
});
