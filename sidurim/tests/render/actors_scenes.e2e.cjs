// tests/render/actors_scenes.e2e.cjs — RENDER-ACTORS
// Run: node tests/render/actors_scenes.e2e.cjs [scene ...]
// Plays real scenes through TLV.debug, asserts what the sim and the camera say, and saves 1280 x 720 screenshots for a person to look at
// (ARCHITECTURE 19, WP-RENDER items 2, 3, 9, 10). Screenshots go to the scratchpad, never the project.
'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const L = require('./actors_lib.cjs');

const BUDGET = { calls: 110, hardCalls: 150, main: 72, shadow: 30, triangles: 400000 };

/** Top face of a whole arrow in the tree shot. The floor scales with the arrow: 2,500 at the old scale of 1, and the arrow is now 0.68 at rest, so 2,500 x 0.68 x 0.68. */
const ARROW_MIN_PIXELS = 1150;

/** @returns {Promise<object>} Budget counters, read after a frame. */
async function info(page) {
  await L.frames(page, 2);
  return page.evaluate(() => {
    const i = TLV.render.info();
    return {
      calls: i.calls, main: i.mainCalls, shadow: i.shadowCalls, triangles: i.triangles, strip: TLV.render.rearview._state().shown,
      cars: TLV.render.vehicles._counts().triangles, people: TLV.render.people._counts().triangles
    };
  });
}

/** Records counters for a shot, and fails over budget. */
const table = [];
async function budget(page, name) {
  const b = await info(page);
  table.push(Object.assign({ shot: name }, b));
  assert.ok(b.calls <= BUDGET.calls, `${name}: ${b.calls} draw calls`);
  assert.ok(b.triangles <= BUDGET.triangles, `${name}: ${b.triangles} triangles`);
  return b;
}

/** @returns {Promise<object>} Where the 3D arrow stands, against the main camera. */
async function arrowPlace(page) {
  return page.evaluate(() => {
    const m = TLV.render.effects._meshes().arrow;
    const lens = TLV.render.camera.object;
    const at = new THREE.Vector3().setFromMatrixPosition(m.matrix);
    const look = lens.getWorldDirection(new THREE.Vector3());
    return { visible: m.visible, ahead: at.clone().sub(lens.position).dot(look) };
  });
}

/**
 * Reads two frames of one paused pose, the parking view's clearing as shipped and then switched off. A pixel is leaf by the same green test the shader uses.
 * @returns {Promise<object>} Leaf share of the bay's box and of the whole frame, each way, and how many pixels of the rear-view strip differ between the two.
 */
async function leafCover(page, bayId) {
  return page.evaluate((id) => {
    const S = TLV.app.S;
    const spot = TLV.world.parking.spot(S.world, id);
    const gl = TLV.render.gl().getContext();
    const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
    const lens = TLV.render.camera.object;
    const c = Math.cos(spot.h), s = Math.sin(spot.h);
    const a = spot.len / 2, b = spot.wid / 2;
    const box = [[a, b], [a, -b], [-a, -b], [-a, b]].map(([u, v]) => {
      const n = new THREE.Vector3(spot.x + c * u - s * v, 0.1, -(spot.y + s * u + c * v)).project(lens);
      return [(n.x + 1) / 2 * W, (n.y + 1) / 2 * H];
    });
    const inBox = (x, y) => {
      let sign = 0;
      for (let i = 0; i < 4; i++) {
        const p = box[i], q = box[(i + 1) % 4];
        const t = Math.sign((q[0] - p[0]) * (y - p[1]) - (q[1] - p[1]) * (x - p[0]));
        if (t && sign && t !== sign) return false;
        if (t) sign = t;
      }
      return true;
    };
    const K = W / window.innerWidth;
    const r = TLV.render.rearview._state().rect;
    const strip = [W - (r.right + r.w) * K, H - (r.top + r.h) * K, W - r.right * K, H - r.top * K];
    const draw = () => {
      TLV.render.drawNow();
      const px = new Uint8Array(W * H * 4);
      gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
      let bay = 0, leafBay = 0, leaf = 0;
      for (let y = 0; y < H; y++) {
        for (let x = 0; x < W; x++) {
          const o = (y * W + x) * 4;
          const green = px[o + 1] > px[o] * 1.08 && px[o + 1] > px[o + 2] * 1.2;
          if (green) leaf++;
          if (inBox(x + 0.5, y + 0.5)) { bay++; if (green) leafBay++; }
        }
      }
      return { px, bay: leafBay / Math.max(1, bay), frame: leaf / (W * H), pixels: bay };
    };
    const shipped = draw();
    const parkView = TLV.render.camera.parkView;
    TLV.render.camera.parkView = () => 0;
    const bare = draw();
    TLV.render.camera.parkView = parkView;
    let stripDiff = 0, stripN = 0;
    for (let y = Math.ceil(strip[1]); y < Math.floor(strip[3]); y++) {
      for (let x = Math.ceil(strip[0]); x < Math.floor(strip[2]); x++) {
        const o = (y * W + x) * 4;
        stripN++;
        if (shipped.px[o] !== bare.px[o] || shipped.px[o + 1] !== bare.px[o + 1] || shipped.px[o + 2] !== bare.px[o + 2]) stripDiff++;
      }
    }
    return { pixels: shipped.pixels, bayOn: shipped.bay, bayOff: bare.bay, frameOn: shipped.frame, frameOff: bare.frame, stripDiff, stripN };
  }, bayId);
}

/**
 * Plays the errands bot to its first bay, a rig frame per tick, on the real route with the real car. `cap` holds a steady speed on the bot's own steering until the rig lands.
 * The rig's frames are called by hand so the timing is the sim's and not the software GL's. The sim stays paused there, and the HUD gets a second to settle.
 * @returns {Promise<object>} How the rig opened and landed, and where the box, the clock and the P pill stand on screen.
 */
async function driveToBay(page, cap) {
  const landed = await page.evaluate((steady) => {
    const S = TLV.app.S, cam = TLV.render.camera;
    TLV.debug.pause();
    const bot = S.controlSource;
    let done = false;
    const near = (s) => {
      const e = s.game && s.game.errand;
      const spot = e && e.bayId >= 0 ? TLV.world.parking.spot(s.world, e.bayId) : null;
      const v = s.vehicles[0];
      return spot ? { spot, d: Math.hypot(v.x - spot.x, v.y - spot.y), v } : null;
    };
    S.controlSource = (s) => {
      const c = bot(s);
      const at = near(s);
      if (steady && !done && at && at.d < 36 && s.game.phase === 'SEARCH' && !s.game.park.stage) {
        const v = Math.abs(at.v.v);
        if (v > steady) { c.throttle = 0; c.brake = Math.min(1, 0.25 + (v - steady) * 0.3); } else if (v < steady - 0.3) { c.throttle = 0.7; c.brake = 0; }
      }
      return c;
    };
    let last = cam._state();
    let open = null;
    for (let i = 0; i < 12000; i++) {
      TLV.debug.step(1);
      cam.frame(S, 1, 1 / 60);
      const st = cam._state();
      const at = near(S);
      if (at && st.rig === 'parking' && last.rig !== 'parking') open = { d: at.d, v: Math.abs(at.v.v), phase: S.game.phase };
      if (at && open && st.rig === 'parking' && st.blendT >= 1) {
        done = true;
        return { open, d: at.d, v: Math.abs(at.v.v), phase: S.game.phase, bay: S.game.errand.bayId };
      }
      last = st;
    }
    return null;
  }, cap);
  assert.ok(landed, 'the parking rig landed on a driven bay');
  await page.waitForTimeout(1000);
  await L.frames(page, 3);
  const seen = await page.evaluate(() => {
    const S = TLV.app.S;
    const spot = TLV.world.parking.spot(S.world, S.game.errand.bayId);
    const lens = TLV.render.camera.object;
    const c = Math.cos(spot.h), s = Math.sin(spot.h);
    const a = spot.len / 2, b = spot.wid / 2;
    const box = [[a, b], [a, -b], [-a, -b], [-a, b]].map(([u, w]) => {
      const n = new THREE.Vector3(spot.x + c * u - s * w, 0.02, -(spot.y + s * u + c * w)).project(lens);
      return { x: (n.x + 1) / 2 * window.innerWidth, y: (1 - n.y) / 2 * window.innerHeight };
    });
    const rect = (q) => { const r = document.querySelector(q).getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
    return { box, clock: rect('.hud-clock'), pin: rect('.tag-bay-pin'), rig: TLV.render.camera._state().rig };
  });
  return Object.assign(landed, seen);
}

/** @returns {number} Share of a convex shape under a screen rectangle. */
function shareUnder(poly, r) {
  const inside = (x, y) => {
    let sign = 0;
    for (let i = 0; i < poly.length; i++) {
      const p = poly[i], q = poly[(i + 1) % poly.length];
      const t = Math.sign((q.x - p.x) * (y - p.y) - (q.y - p.y) * (x - p.x));
      if (t && sign && t !== sign) return false;
      if (t) sign = t;
    }
    return true;
  };
  let all = 0, hit = 0;
  for (let x = Math.min(...poly.map((p) => p.x)); x <= Math.max(...poly.map((p) => p.x)); x += 2) {
    for (let y = Math.min(...poly.map((p) => p.y)); y <= Math.max(...poly.map((p) => p.y)); y += 2) {
      if (!inside(x, y)) continue;
      all++;
      if (x >= r.l && x <= r.r && y >= r.t && y <= r.b) hit++;
    }
  }
  return all ? hit / all : 0;
}

/** Closes the loop on a scene with a clean console. */
async function scene(name, params, fn) {
  const g = await L.openGame(params);
  try {
    await fn(g.page, g);
    L.assertClean(g);
    console.log('ok  ', name);
  } finally {
    await g.browser.close();
  }
}

const SCENES = {
  /** Speed widens the view and pulls the camera back. */
  async speed() {
    await scene('speed', '?seed=1&notitle=1&incidents=0&hud=0', async (page) => {
      await L.toDrive(page);
      const stop = await page.evaluate(() => TLV.render.camera._state());
      assert.ok(Math.abs(stop.fov - 62) < 1.5, 'stopped fov ' + stop.fov);
      await page.evaluate(() => { TLV.debug.resume(); TLV.debug.setInput({ throttle: 1 }); });
      await page.waitForFunction(() => TLV.debug.state().player.v > 15, null, { timeout: 120000 });
      await L.frames(page, 6);
      const fast = await page.evaluate(() => TLV.render.camera._state());
      assert.ok(fast.fov > 68, 'fast fov ' + fast.fov);
      await L.shot(page, 'actors_speed');
      await budget(page, 'speed');
    });
  },

  /** A car glued to the bumper: raised camera, ghost, strip, high beams in the strip. */
  async tailgate() {
    await scene('tailgate', '?seed=1&notitle=1&incidents=0&hud=1', async (page) => {
      await L.toDrive(page);
      // The stopped car behind at the start of a run is a real tail car: tell it to tailgate, and drive off slowly.
      await page.evaluate(() => {
        const S = TLV.app.S;
        const me = S.vehicles[0];
        let best = null, bestD = 40;
        S.vehicles.forEach((v) => {
          if (!v.active || v.isPlayer) return;
          const d = Math.hypot(v.x - me.x, v.y - me.y);
          const along = (v.x - me.x) * Math.cos(me.h) + (v.y - me.y) * Math.sin(me.h);
          if (along < 0 && d < bestD) { best = v; bestD = d; }
        });
        window.__tail = best.id;
        TLV.debug.commandCar(best.id, { type: 'TAILGATE', durS: 30, targetId: 0 });
        TLV.debug.setInput({ throttle: 0.3 });
      });
      let ready = false;
      for (let i = 0; i < 120 && !ready; i++) {
        ready = await page.evaluate(() => {
          TLV.debug.step(10);
          const S = TLV.app.S;
          const car = S.vehicles.find((v) => v.active && v.id === window.__tail);
          if (!car) return false;
          const me = S.vehicles[0];
          const gap = Math.hypot(car.x - me.x, car.y - me.y) - me.length / 2 - car.length / 2;
          return gap < 4 && !!(car.lights & TLV.const.VL.HIGH_BEAM) && me.v > 3;
        });
      }
      assert.ok(ready, 'tail car closed up');
      await L.frames(page, 10);
      const st = await page.evaluate(() => {
        const S = TLV.app.S;
        const car = S.vehicles.find((v) => v.active && v.id === window.__tail);
        return { cam: TLV.render.camera._state(), rear: TLV.render.rearview._state(), ghost: TLV.render.camera.isGhost(car.slot) };
      });
      assert.ok(st.cam.tailing, 'tailgater seen');
      assert.ok(st.cam.tail > 0.5, 'camera raised');
      assert.ok(st.ghost, 'car ghosted');
      assert.ok(st.rear.shown, 'strip up');
      await L.shot(page, 'actors_tailgate');
      await budget(page, 'tailgate');
      // V hides it, and V brings it back.
      await page.keyboard.press('v');
      await L.frames(page, 3);
      assert.equal(await page.evaluate(() => TLV.render.rearview._state().shown), false, 'V hides the strip');
      await page.keyboard.press('v');
      await L.frames(page, 3);
      assert.equal(await page.evaluate(() => TLV.render.rearview._state().shown), true, 'V shows the strip');
    });
  },

  /** Near the bay and under 12 m/s: the high car-up view, once a car rolling in would land it with the box in frame. C swaps it. */
  async parking() {
    await scene('parking', '?seed=2&notitle=1&incidents=0&hud=1', async (page) => {
      await L.toDrive(page);
      const placed = await page.evaluate(() => {
        const S = TLV.app.S;
        const spot = TLV.world.parking.spot(S.world, S.game.errand.bayId);
        const c = Math.cos(spot.h), s = Math.sin(spot.h);
        const L0 = S.world.lanes[spot.laneId];
        const out = { x: 0, y: 0, h: 0 };
        TLV.world.lanes.pointAt(S.world, spot.laneId, Math.max(2, spot.laneS - 14), out);
        TLV.debug.teleport(out.x, out.y, out.h, 0);
        TLV.debug.step(2);
        return { spot: { x: spot.x, y: spot.y, h: spot.h }, me: { x: S.player.fx, y: S.player.fy }, laneLen: L0.len };
      });
      // Standing 14 m short the rig would land with the far end of the box under the clock, so the chase view holds until the car rolls in.
      await L.frames(page, 4);
      assert.equal(await page.evaluate(() => TLV.render.camera._state().rig), 'chase', 'no view at rest, 14 m short');
      await page.evaluate(() => { TLV.debug.resume(); TLV.debug.setInput({ throttle: 0.25 }); });
      await page.waitForFunction(() => TLV.render.camera._state().rig === 'parking', null, { timeout: 60000 });
      await page.evaluate(() => { TLV.debug.setInput({ brake: 1 }); });
      await page.waitForFunction(() => TLV.render.camera._state().blendT >= 1, null, { timeout: 60000 });
      await page.evaluate(() => { TLV.debug.pause(); TLV.debug.setInput(null); });
      await L.frames(page, 16);
      const st = await page.evaluate(() => {
        const cam = TLV.render.camera;
        const o = cam.object;
        const d = new THREE.Vector3();
        o.getWorldDirection(d);
        const v = TLV.app.S.vehicles[0];
        return { z: o.position.y, pitch: Math.asin(-d.y) * 180 / Math.PI, fov: o.fov, yaw: cam.yaw(), h: v.h };
      });
      assert.ok(Math.abs(st.z - 14) < 0.5, 'height ' + st.z);
      assert.ok(Math.abs(st.pitch - 62) < 3, 'pitch ' + st.pitch);
      assert.ok(Math.abs(st.fov - 60) < 1, 'fov ' + st.fov);
      assert.ok(Math.abs(Math.atan2(Math.sin(st.yaw - st.h), Math.cos(st.yaw - st.h))) < 0.15, 'car-up');
      // The lens leads the car: the bay is well down the frame by this range, clear of the clock, and the whole car is still in shot. Under 1.2 m of lead it was at y 73 at 12.6 m.
      const frame = await page.evaluate(() => {
        const S = TLV.app.S;
        const spot = TLV.world.parking.spot(S.world, S.game.errand.bayId);
        const lens = TLV.render.camera.object;
        const me = S.vehicles[0];
        const y = (wx, wy) => (1 - new THREE.Vector3(wx, 0, -wy).project(lens).y) * 360;
        const c = Math.cos(me.h), s = Math.sin(me.h);
        return { d: Math.hypot(me.x - spot.x, me.y - spot.y), bay: y(spot.x, spot.y), nose: y(me.x + c * 2, me.y + s * 2), tail: y(me.x - c * 2, me.y - s * 2) };
      });
      console.log('     bay at', frame.d.toFixed(1), 'm is at y', frame.bay.toFixed(0), 'car y', frame.nose.toFixed(0), 'to', frame.tail.toFixed(0));
      assert.ok(frame.d < 15, 'close to the bay: ' + frame.d);
      assert.ok(frame.bay > 115, 'bay below the clock: ' + frame.bay);
      assert.ok(frame.tail < 680, 'the car is in shot: ' + frame.tail);
      await L.shot(page, 'actors_parking');
      await budget(page, 'parking');
      await page.keyboard.press('c');
      await L.frames(page, 16);
      assert.equal(await page.evaluate(() => TLV.render.camera._state().rig), 'chase', 'C leaves the view');
      await page.keyboard.press('c');
      await L.frames(page, 12);
      assert.equal(await page.evaluate(() => TLV.render.camera._state().rig), 'parking', 'C returns to it');
    });
  },

  /**
   * Bays reached by driving, at three speeds. The rig opens by 20 m and under 12 m/s, and from the moment it lands the whole box is on screen and below the clock. The P pill stands on
   * the bay itself (hud.js), so it only has to leave the box's near half clear.
   */
  async parkopen() {
    const rows = [];
    for (const cap of [0, 3, 10]) {
      await scene('parkopen, ' + (cap ? cap + ' m/s' : 'the bot\'s own speed'), '?seed=1&notitle=1&incidents=0&autoplay=errands&immortal=1&quality=low&mute=1', async (page) => {
        const r = await driveToBay(page, cap);
        const top = Math.min(...r.box.map((p) => p.y)), bottom = Math.max(...r.box.map((p) => p.y));
        const left = Math.min(...r.box.map((p) => p.x)), right = Math.max(...r.box.map((p) => p.x));
        const clock = shareUnder(r.box, r.clock), pin = shareUnder(r.box, r.pin);
        rows.push({ cap, open: +r.open.d.toFixed(1), openV: +r.open.v.toFixed(1), landed: +r.d.toFixed(1), v: +r.v.toFixed(1), top: Math.round(top), bottom: Math.round(bottom), clock: +clock.toFixed(3), pin: +pin.toFixed(3) });
        assert.equal(r.rig, 'parking');
        assert.ok(r.open.d <= 20.01, 'opens by 20 m: ' + r.open.d);
        assert.ok(r.open.d > 12.5, 'opens well before the bay: ' + r.open.d);
        assert.ok(r.open.v < 12, 'under 12 m/s: ' + r.open.v);
        assert.ok(top >= 0 && bottom <= 720 && left >= 0 && right <= 1280, 'whole box on screen: ' + JSON.stringify(r.box));
        assert.ok(top > r.clock.b, 'box below the clock: ' + top + ' against ' + r.clock.b);
        assert.equal(clock, 0, 'nothing of the box under the clock');
        assert.ok(r.pin.b < (top + bottom) / 2, 'near half of the box clear of the P pill: ' + r.pin.b + ' against ' + top + '-' + bottom);
        assert.ok(pin < 0.15, 'the pill takes little of the box: ' + pin);
        await L.shot(page, 'actors_parkopen_' + (cap || 'bot'));
      });
    }
    console.log('     ' + rows.map((r) => JSON.stringify(r)).join('\n     '));
  },

  /** A C with no bay near is refused before any frame of the parking rig, and hud.js still answers it. */
  async refused() {
    await scene('refused', '?seed=1&notitle=1&incidents=0&hud=1&quality=low', async (page) => {
      await L.toDrive(page);
      await L.frames(page, 3);
      const far = await page.evaluate(() => {
        const S = TLV.app.S;
        const spot = TLV.world.parking.spot(S.world, S.game.errand.bayId);
        window.__rigs = [];
        const frame = TLV.render.camera.frame;
        TLV.render.camera.frame = function (a, b, c) {
          frame(a, b, c);
          const st = TLV.render.camera._state();
          window.__rigs.push({ rig: st.rig, blendT: st.blendT, z: st.z, override: st.parkOverride });
        };
        return Math.hypot(S.vehicles[0].x - spot.x, S.vehicles[0].y - spot.y);
      });
      assert.ok(far > 76, 'far from the bay: ' + far);
      await page.keyboard.press('c');
      await page.waitForFunction(() => window.__rigs.length >= 12, null, { timeout: 120000 });
      const rigs = await page.evaluate(() => window.__rigs);
      assert.deepStrictEqual([...new Set(rigs.map((r) => r.rig))], ['chase'], 'never the parking rig');
      assert.ok(rigs.every((r) => r.blendT === 1 && r.override === 0), 'no blend began: ' + JSON.stringify(rigs.find((r) => r.blendT !== 1 || r.override !== 0)));
      assert.ok(Math.max(...rigs.map((r) => r.z)) < 3.5, 'the lens never rose');
      const toast = await page.evaluate(() => [...document.querySelectorAll('.hud-toasts .toast')].map((n) => n.textContent).join('|'));
      assert.ok(toast.includes(await page.evaluate(() => TLV.ui.strings.t('toast.cameraFar'))), 'the press still gets its answer: ' + toast);
    });
  },

  /** RESOLVE is a cut. The run ends at a shop door a street away from the car, and the first frame the card can appear on already shows the car. */
  async resolve() {
    await scene('resolve', '?seed=3&notitle=1&incidents=0&knife=force&errand=2&hud=1&quality=low&mute=1&autoplay=errands&immortal=1', async (page) => {
      await L.toDrive(page);
      await page.evaluate(() => { TLV.debug.forceContest({}); TLV.debug.step(120); TLV.debug.parkNow({}); TLV.debug.step(30); if (!TLV.debug.state().knife) TLV.debug.forceKnife({}); });
      // The bot gets out and runs for the door. The rig needs its frames to see each stage, so it gets them by hand, one a tick. C on the run is a press with nothing to choose.
      const reached = await page.evaluate(() => {
        const S = TLV.app.S, cam = TLV.render.camera;
        let foot = null;
        for (let i = 0; i < 6000; i++) {
          TLV.debug.step(1);
          if (S.game.phase === 'RESOLVE') {
            // In this same task, so the very next frame of the game's own loop is the first one the log holds.
            const log = window.__log = [];
            const frame = cam.frame;
            cam.frame = function (a, b, c) {
              frame(a, b, c);
              const st = cam._state(), me = S.vehicles[0];
              const n = new THREE.Vector3(me.x, 0.8, -me.y).project(cam.object);
              log.push({ phase: S.game.phase, rig: st.rig, blendT: st.blendT, off: Math.hypot(st.x - me.x, st.y - me.y), x: n.x, y: n.y, z: n.z });
            };
            return { foot, me: { x: S.vehicles[0].x, y: S.vehicles[0].y } };
          }
          cam.frame(S, 1, 1 / 60);
          if (cam._state().rig === 'foot') foot = { x: cam._state().x, y: cam._state().y };
        }
        return null;
      });
      assert.ok(reached && reached.foot, 'the run ended at the door');
      const first = reached;
      await L.frames(page, 3);
      const log = await page.evaluate(() => window.__log);
      assert.ok(log.length >= 2, 'frames seen: ' + log.length);
      const cut = log[0];
      console.log('     first RESOLVE frame', JSON.stringify(cut), 'door run ended', Math.round(Math.hypot(reached.foot.x - first.me.x, reached.foot.y - first.me.y)), 'm from the car');
      assert.equal(cut.phase, 'RESOLVE');
      assert.equal(cut.rig, 'chase', 'back on the car');
      assert.equal(cut.blendT, 1, 'a cut, not a blend');
      assert.ok(cut.off < 10, 'the lens is at the car: ' + cut.off);
      assert.ok(Math.abs(cut.x) < 0.9 && Math.abs(cut.y) < 0.9 && cut.z < 1, 'the car is in the first frame: ' + JSON.stringify(cut));
      assert.ok(Math.hypot(reached.foot.x - first.me.x, reached.foot.y - first.me.y) > 20, 'the run really left the car');
      await L.frames(page, 2);
      assert.equal(await page.evaluate(() => document.querySelector('.resolve').classList.contains('off')), false, 'the card is up');
      await L.shot(page, 'actors_resolve');
    });
  },

  /** The bay and car pose of ACCEPTANCE-1 failure 7, where a crown hid the box as the prompt said NOW STOP. The parking view opens the leaves over the bay and nowhere else. */
  async crowns() {
    const BAY = 16645121;
    await scene('crowns', '?seed=1&errand=2&notitle=1&incidents=0&hud=0&quality=low', async (page) => {
      await L.toDrive(page);
      await L.frames(page, 2);
      assert.equal(await page.evaluate(() => TLV.render.camera.parkView()), 0, 'chase view: nothing is open');
      await page.evaluate((id) => {
        const S = TLV.app.S;
        TLV.game.parking._setBay(S, id);
        TLV.debug.teleport(533, 77, TLV.world.parking.spot(S.world, id).h, 0);
        TLV.debug.step(2);
      }, BAY);
      // toggle() flips what is on screen, and a car behind may already have the strip up.
      for (let i = 0; i < 4 && await page.evaluate(() => TLV.render.rearview._state().pref) !== 'on'; i++) {
        await page.evaluate(() => TLV.render.rearview.toggle());
        await L.frames(page, 2);
      }
      await page.evaluate(() => TLV.debug.resume());
      await page.waitForFunction(() => TLV.render.camera._state().rig === 'parking' && TLV.render.camera.parkView() >= 1, null, { timeout: 120000 });
      await page.evaluate(() => TLV.debug.pause());
      // Paused frames still run the rig: car-up before a pixel is read, so the two frames are one pose.
      await page.waitForFunction(() => Math.abs(TLV.math.wrapPi(TLV.render.camera.yaw() - TLV.app.S.vehicles[0].h)) < 0.01, null, { timeout: 120000 });
      await L.frames(page, 3);
      assert.ok(await page.evaluate(() => TLV.render.rearview._state().shown), 'strip pinned up');
      const r = await leafCover(page, BAY);
      console.log('     leaf over the bay', (r.bayOff * 100).toFixed(1) + '% to', (r.bayOn * 100).toFixed(1) + '%, whole frame', (r.frameOff * 100).toFixed(1) + '% to', (r.frameOn * 100).toFixed(1) + '%,', r.stripDiff, 'of', r.stripN, 'strip pixels change');
      assert.ok(r.pixels > 8000, 'the bay is in frame: ' + r.pixels);
      assert.ok(r.bayOff > 0.25, 'this pose has a crown over the bay to open: ' + r.bayOff);
      assert.ok(r.bayOn < 0.02, 'the bay is clear: ' + r.bayOn);
      assert.ok(r.frameOn > 0.05, 'the street keeps its trees: ' + r.frameOn);
      assert.ok(r.stripN > 8000, 'the strip was read: ' + r.stripN);
      assert.equal(r.stripDiff, 0, 'the mirror keeps its crowns');
      await L.shot(page, 'actors_parking_crown');
      await page.keyboard.press('c');
      await page.waitForFunction(() => TLV.render.camera._state().rig === 'chase' && TLV.render.camera.parkView() === 0, null, { timeout: 60000 });
    });
  },

  /** Knife, from STANDOFF to the chase. */
  async knife() {
    await scene('knife', '?seed=3&notitle=1&incidents=0&knife=force&errand=2&hud=1', async (page) => {
      await L.toDrive(page);
      // Parking while he races for the stall is the real way in: PAYOUT +0.3 s, then STANDOFF.
      await page.evaluate(() => { TLV.debug.forceContest({}); TLV.debug.step(120); TLV.debug.parkNow({}); TLV.debug.step(30); });
      const entered = await page.evaluate(() => { const had = !!TLV.debug.state().knife; if (!had) TLV.debug.forceKnife({}); return had; });
      console.log('     knife by the real path:', entered);
      // No cut until he is out of his door: until then the view stays as it was, and his car can finish arriving in it.
      await L.frames(page, 2);
      const held = await page.evaluate(() => ({ man: TLV.app.S.game.knife.attackerId, rig: TLV.render.camera._state().rig }));
      assert.ok(held.man < 0, 'still in his car');
      assert.ok(held.rig === 'chase' || held.rig === 'parking', 'held: ' + held.rig);
      await L.shot(page, 'actors_standoff_hold');
      for (let i = 0; i < 40; i++) {
        const out = await page.evaluate(() => { TLV.debug.step(3); return TLV.app.S.game.knife.attackerId >= 0; });
        await L.frames(page, 1);
        if (out) break;
      }
      await page.evaluate(() => TLV.debug.step(4));
      // These ticks were stepped with hardly a frame, so his car is new to the renderer: let the 0.4 s spawn fade finish, as the frames of a real race would.
      await page.waitForFunction(() => {
        const S = TLV.app.S;
        const r = TLV.traffic.byId(S, S.game.knife.rivalVehId);
        return !r || TLV.render.vehicles._car(r.slot).fade >= 1;
      }, null, { timeout: 60000 });
      await L.frames(page, 2);
      let st = await page.evaluate(() => {
        const S = TLV.app.S;
        const k = S.game.knife;
        const rival = TLV.traffic.byId(S, k.rivalVehId);
        const twins = rival ? S.vehicles.filter((v) => v.active && v !== rival && Math.hypot(v.x - rival.x, v.y - rival.y) < 2).length : 0;
        const man = TLV.peds.byId(S, k.attackerId);
        const lens = TLV.render.camera.object;
        const onScreen = (x, y, z) => { const n = new THREE.Vector3(x, z, -y).project(lens); return Math.abs(n.x) < 1 && Math.abs(n.y) < 1 && n.z < 1; };
        const me = S.vehicles[0];
        return {
          s: TLV.debug.state().knife, cam: TLV.render.camera._state(), twins, rival: !!rival,
          framed: { man: onScreen(man.x, man.y, 1), me: onScreen(me.x, me.y, 0.8), rival: !rival || onScreen(rival.x, rival.y, 0.8) }
        };
      });
      console.log('     rival', st.rival, 'cars on top of him', st.twins, 'lens height', st.cam.z, 'range', st.cam.shot.range);
      assert.equal(st.twins, 0, 'one car in his place');
      assert.equal(st.s.stage, 'STANDOFF');
      assert.equal(st.cam.rig, 'cine-STANDOFF');
      assert.ok(st.cam.z > 2.2, 'over the parked roofs: ' + st.cam.z);
      assert.equal(st.cam.shot.blocked, 0, 'nothing stands in front of him or the cars');
      assert.deepStrictEqual(st.framed, { man: true, me: true, rival: true });
      // The knife is in his hand before the cut to DOOR_TUG, from the moment he is out of his car.
      assert.equal(await page.evaluate(() => TLV.render.people._knivesDrawn()), 1, 'knife drawn in STANDOFF');
      await L.shot(page, 'actors_standoff');
      await budget(page, 'standoff');
      // He goes round his car to the door: the held shot keeps him on screen all the way. The lens is fixed, so stepping with no frames reads it true.
      let walked = 0;
      for (let i = 0; i < 60; i++) {
        const now = await page.evaluate(() => {
          const S = TLV.app.S;
          const k = S.game.knife;
          const man = TLV.peds.byId(S, k.attackerId);
          const n = new THREE.Vector3(man.x, 1, -man.y).project(TLV.render.camera.object);
          return { stage: k.stage, door: S.vehicles[0].door, x: n.x, y: n.y };
        });
        if (now.stage !== 'STANDOFF') break;
        walked++;
        assert.ok(Math.abs(now.x) < 0.95 && Math.abs(now.y) < 0.95, 'he left the STANDOFF shot: ' + JSON.stringify(now));
        await page.evaluate(() => TLV.debug.step(2));
      }
      console.log('     in frame for', walked, 'samples of STANDOFF');
      for (let i = 0; i < 60; i++) {
        const open = await page.evaluate(() => TLV.app.S.vehicles[0].door);
        if (open === 1) break;
        await page.evaluate(() => TLV.debug.step(4));
      }
      await page.evaluate(() => TLV.debug.step(10));
      await L.frames(page, 6);
      st = await page.evaluate(() => {
        const S = TLV.app.S;
        const k = S.game.knife;
        const p = TLV.peds.byId(S, k.attackerId);
        return { stage: k.stage, door: S.vehicles[0].door, anim: p.anim, hasKnife: p.hasKnife, kind: p.kind };
      });
      assert.equal(st.stage, 'DOOR_TUG');
      assert.equal(st.door, 1, 'driver door open');
      assert.equal(st.hasKnife, true);
      await L.shot(page, 'actors_door_tug');
      await budget(page, 'door_tug');
      // The knife up close: chunky, blunt, a prop.
      await page.evaluate(() => {
        const S = TLV.app.S;
        const p = TLV.peds.byId(S, S.game.knife.attackerId);
        const lx = -Math.sin(p.h), ly = Math.cos(p.h);
        TLV.render.camera.setFree(p.x + Math.cos(p.h) * 1.6 + lx * 2.6, p.y + Math.sin(p.h) * 1.6 + ly * 2.6, 1.7, p.x, p.y, 1.75, 44);
      });
      await L.frames(page, 3);
      await page.evaluate(() => { document.getElementById('ui-root').style.display = 'none'; });
      await L.frames(page, 2);
      await L.shot(page, 'actors_knife_close');
    });
  },

  /**
   * DOOR_TUG on the street of ACCEPTANCE-1 failure 11, where the old fixed lens had a taxi across the foreground and cars on the line to the man. The bay, the parked row and the traffic
   * are real, and the contest runs to the real knife with his car where the race left it. The test has its own copy of the box test, so it does not take the camera's word that the line
   * is clear, and it counts the man's pixels.
   */
  async tug() {
    const BAY = 17436675;
    await scene('tug', '?seed=3&notitle=1&knife=force&contest=force&errand=2&quality=low&mute=1', async (page) => {
      await L.toDrive(page);
      const r = await page.evaluate((id) => {
        const S = TLV.app.S, cam = TLV.render.camera;
        TLV.debug.forceContest({ spotId: id });
        TLV.debug.step(120);
        TLV.debug.parkNow({});
        TLV.debug.step(30);
        const real = !!TLV.debug.state().knife;
        for (let i = 0; i < 900; i++) {
          TLV.debug.step(1);
          cam.frame(S, 1, 1 / 60);
          const k = S.game.knife;
          const man = k && k.stage === 'DOOR_TUG' ? TLV.peds.byId(S, k.attackerId) : null;
          if (!man || (man.anim !== 'tug' && k.stageT < 2.3)) continue;
          /** @returns {object} What the lens has in front of it now. */
          window.__tugSees = () => {
            const me = S.vehicles[0], st = cam._state(), W = S.world;
            const boxes = [], ids = [], box = {};
            const add = (x, y, h, len, wid, top) => boxes.push({ x, y, c: Math.cos(h), s: Math.sin(h), hl: len / 2, hw: wid / 2, top });
            TLV.world.parking.parkedNear(S, me.x, me.y, 30, ids);
            for (const q of ids) if (TLV.world.parking.boxOf(W, q, TLV.world.parking.state(S, q), box)) add(box.x, box.y, box.h, box.length, box.width, 1.5);
            for (const v of S.vehicles) if (v.active && v !== me && Math.hypot(v.x - me.x, v.y - me.y) < 30) add(v.x, v.y, v.h, v.length, v.width, v.length > 6 ? 3.2 : (v.kind === 'van' ? 2.3 : 1.5));
            const hits = (b, tx, ty, tz) => {
              const rx = st.x - b.x, ry = st.y - b.y, dx = tx - st.x, dy = ty - st.y;
              const o = [rx * b.c + ry * b.s, -rx * b.s + ry * b.c], d = [dx * b.c + dy * b.s, -dx * b.s + dy * b.c], half = [b.hl, b.hw];
              let t0 = 0, t1 = 1;
              for (let a = 0; a < 2; a++) {
                if (Math.abs(d[a]) < 1e-9) { if (Math.abs(o[a]) > half[a]) return false; continue; }
                const p = (-half[a] - o[a]) / d[a], q = (half[a] - o[a]) / d[a];
                t0 = Math.max(t0, Math.min(p, q));
                t1 = Math.min(t1, Math.max(p, q));
                if (t0 > t1) return false;
              }
              return Math.min(st.z + (tz - st.z) * t0, st.z + (tz - st.z) * t1) < b.top;
            };
            const at = (x, y, z) => { const n = new THREE.Vector3(x, z, -y).project(cam.object); return { x: (n.x + 1) * 640, y: (1 - n.y) * 360, z: n.z }; };
            // The taxi of the finding: a car under 5 m from the lens, with its middle in the picture.
            const near = boxes.filter((b) => { const c = at(b.x, b.y, 0.8); return Math.hypot(b.x - st.x, b.y - st.y) < 5 && c.z < 1 && c.x > 0 && c.x < 1280 && c.y > 0 && c.y < 720; }).length;
            const blocked = [1.7, 1.2, 0.6].filter((z) => boxes.some((b) => hits(b, man.x, man.y, z)));
            return { real, tick: S.tick, rig: st.rig, shot: st.shot, lens: { x: st.x, y: st.y, z: st.z }, blocked, near, cars: boxes.length, range: Math.hypot(man.x - st.x, man.y - st.y), head: at(man.x, man.y, 2.1), feet: at(man.x, man.y, 0) };
          };
          return window.__tugSees();
        }
        return null;
      }, BAY);
      assert.ok(r, 'a real DOOR_TUG');
      assert.ok(r.real, 'the knife came from the contest');
      console.log('     DOOR_TUG', JSON.stringify(r));
      await L.frames(page, 3);
      await L.shot(page, 'actors_tug_real');
      assert.equal(r.rig, 'cine-DOOR_TUG');
      assert.ok(r.cars > 8, 'a street with cars in it: ' + r.cars);
      assert.equal(r.shot.blocked, 0, 'the lens found a clear line');
      assert.deepStrictEqual(r.blocked, [], 'nothing stands between the lens and the man');
      assert.equal(r.near, 0, 'no car across the foreground');
      assert.ok(r.feet.z < 1 && r.feet.x > 0 && r.feet.x < 1280 && r.feet.y < 720, 'his feet are in frame: ' + JSON.stringify(r.feet));
      assert.ok(r.head.y > 245 && r.head.x > 0 && r.head.x < 1280, 'his head and knife sit below the prompt: ' + JSON.stringify(r.head));
      const px = await page.evaluate(() => {
        const S = TLV.app.S, man = TLV.peds.byId(S, S.game.knife.attackerId);
        const gl = TLV.render.gl().getContext();
        const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
        const read = () => { TLV.render.drawNow(); const out = new Uint8Array(W * H * 4); gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, out); return out; };
        const on = read();
        man.active = false;
        const off = read();
        man.active = true;
        read();
        let n = 0;
        for (let i = 0; i < on.length; i += 4) if (Math.abs(on[i] - off[i]) + Math.abs(on[i + 1] - off[i + 1]) + Math.abs(on[i + 2] - off[i + 2]) > 24) n++;
        return n * (1280 * 720) / (W * H);
      });
      // A man in the open at this view's 50 degrees covers about 720,000 / range^2 pixels, 19,000 at 6.1 m. The head, arm and knife of the finding were well under half of that.
      console.log('     the man covers', Math.round(px), 'pixels at', r.range.toFixed(1), 'm, floor', Math.round(360000 / (r.range * r.range)));
      assert.ok(px > 360000 / (r.range * r.range), 'most of him shows: ' + px);
      // This pose has room, so any decent lens passes it. So: stand a car on the line that lens chose, as a queue would, and take the cut again. A fixed lens stays put behind it.
      const again = await page.evaluate(() => {
        const S = TLV.app.S, cam = TLV.render.camera, k = S.game.knife, me = S.vehicles[0], man = TLV.peds.byId(S, k.attackerId), st = cam._state();
        const car = S.vehicles.filter((v) => v.active && v !== me && v.id !== k.rivalVehId).sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y))[0];
        car.x = car.px = (man.x + st.x) / 2;
        car.y = car.py = (man.y + st.y) / 2;
        car.h = car.ph = Math.atan2(man.y - st.y, man.x - st.x) + Math.PI / 2;
        car.v = 0;
        cam.setMode('chase');
        cam.frame(S, 1, 1 / 60);
        cam.setMode('auto');
        cam.frame(S, 1, 1 / 60);
        return window.__tugSees();
      });
      console.log('     with a car on that line', JSON.stringify(again.lens), JSON.stringify(again.shot));
      assert.ok(Math.hypot(again.lens.x - r.lens.x, again.lens.y - r.lens.y) + Math.abs(again.lens.z - r.lens.z) > 0.5, 'the lens moved off the blocked line');
      assert.equal(again.rig, 'cine-DOOR_TUG');
      assert.equal(again.shot.blocked, 0, 'the lens found another clear line');
      assert.deepStrictEqual(again.blocked, [], 'nothing stands between the new lens and the man');
      assert.equal(again.near, 0, 'no car across the foreground');
    });
  },

  /** The spring arm keeps the lens out of walls, and a reverse view flips only after 0.6 s. */
  async arm() {
    await scene('arm', '?seed=1&notitle=1&incidents=0&hud=0', async (page) => {
      await L.toDrive(page);
      const st = await page.evaluate(() => {
        const S = TLV.app.S;
        const W = S.world;
        // A real wall: stand 2.5 m in front of a long building face, with the car facing away from it.
        const c = W.colliders;
        const me = S.vehicles[0];
        let best = -1, bestD = 1e9;
        for (let i = 0; i < c.n; i++) {
          if (c.owner[i] < 0) continue;
          const len = Math.hypot(c.bx[i] - c.ax[i], c.by[i] - c.ay[i]);
          if (len < 16) continue;
          const d = Math.hypot(c.ax[i] - me.x, c.ay[i] - me.y);
          if (d < bestD) { bestD = d; best = i; }
        }
        const ax = c.ax[best], ay = c.ay[best], bx = c.bx[best], by = c.by[best];
        const len = Math.hypot(bx - ax, by - ay);
        const mx = (ax + bx) / 2, my = (ay + by) / 2;
        // CCW outer ring: the outside of a wall is to its right.
        const ox = (by - ay) / len, oy = -(bx - ax) / len;
        TLV.debug.teleport(mx + ox * 4, my + oy * 4, Math.atan2(oy, ox), 0);
        TLV.debug.step(2);
        return { blocked: TLV.world.spatial.pointInBuilding(W, mx + ox * 4, my + oy * 4), owner: c.owner[best] };
      });
      assert.equal(st.blocked, -1, 'standing outside the building');
      await L.frames(page, 10);
      const near = await page.evaluate(() => {
        const S = TLV.app.S;
        const cam = TLV.render.camera._state();
        return { arm: cam.armT, inside: TLV.world.spatial.pointInBuilding(S.world, cam.x, cam.y) };
      });
      assert.ok(near.arm < 0.85, 'arm shrank: ' + near.arm);
      assert.equal(near.inside, -1, 'lens outside the wall');
    });
  },

  /** Backing up under 0.6 s keeps the view. Past it, the view turns round. */
  async reverse() {
    await scene('reverse', '?seed=1&notitle=1&incidents=0&hud=0&traffic=0&peds=0', async (page) => {
      await L.toDrive(page);
      await page.evaluate(() => {
        const S = TLV.app.S;
        const route = S.game.nav.route;
        const at = { x: 0, y: 0, h: 0 };
        TLV.math.polyAt(route.px, route.py, route.cum, 200, at);
        TLV.debug.teleport(at.x, at.y, at.h, 0);
        TLV.debug.setInput({ brake: 1 });
      });
      let flipped = false;
      let backing = 0;
      for (let i = 0; i < 40 && !flipped; i++) {
        await page.evaluate(() => TLV.debug.step(6));
        await L.frames(page, 1);
        const v = await page.evaluate(() => TLV.debug.state().player.v);
        flipped = await page.evaluate(() => TLV.render.camera._state().reverse);
        if (v < -2) backing++;
        if (backing < 3) assert.equal(flipped, false, 'flipped after ' + backing + ' frames');
      }
      assert.ok(flipped, 'reverse view');
      await L.frames(page, 12);
      const st = await page.evaluate(() => {
        const h = TLV.app.S.vehicles[0].h;
        const yaw = TLV.render.camera.yaw();
        return Math.abs(Math.atan2(Math.sin(yaw - h), Math.cos(yaw - h)));
      });
      assert.ok(st > 2.2, 'looking back along the car: ' + st);
      // The arrow goes with the lens: looking back from in front of the car, a nose-anchored arrow sat a metre from the glass.
      const a = await arrowPlace(page);
      console.log('     arrow in reverse, metres ahead of the lens:', a.ahead.toFixed(1));
      assert.ok(a.visible, 'arrow up');
      assert.ok(a.ahead > 8, 'clear of the lens: ' + a.ahead);
      await L.shot(page, 'actors_reverse');
    });
  },

  /** The arrow is a sign for the driver: a tree on the same spot does not hide it. */
  async arrow() {
    await scene('arrow', '?seed=1&notitle=1&incidents=0&hud=0&traffic=0&peds=0', async (page) => {
      await L.toDrive(page);
      const spot = await page.evaluate(() => {
        // Nose 1 m short of a ficus near the start, so the trunk and the low boughs stand on the line from the lens to the arrow. Turned off a lane, so the camera has room.
        const S = TLV.app.S;
        const W = S.world;
        const me = S.vehicles[0];
        const ids = [];
        for (const lane of W.lanes) {
          for (let i = 0; i < lane.px.length; i++) {
            const x = lane.px[i], y = lane.py[i];
            if (Math.hypot(x - me.x, y - me.y) > 350) continue;
            const n = TLV.world.spatial.propsNear(W, x, y, 9, ids);
            for (let j = 0; j < n; j++) {
              const p = W.props[ids[j]];
              const d = Math.hypot(p.x - x, p.y - y);
              if (p.kind !== 'ficus' || d < 6) continue;
              const h = Math.atan2(p.y - y, p.x - x);
              const cx = p.x - Math.cos(h) * 3.2, cy = p.y - Math.sin(h) * 3.2;
              if (TLV.world.spatial.pointInBuilding(W, cx, cy) >= 0) continue;
              TLV.debug.teleport(cx, cy, h, 0);
              TLV.debug.step(2);
              return true;
            }
          }
        }
        return false;
      });
      assert.ok(spot, 'a tree by a lane');
      await L.frames(page, 14);
      assert.equal(await page.evaluate(() => TLV.render.effects._meshes().arrow.material.depthTest), false);
      const shipped = await L.shot(page, 'actors_arrow_tree');
      // The same frame with depth testing put back, to show what the fix buys. The material is restored at once.
      await page.evaluate(() => { const m = TLV.render.effects._meshes().arrow.material; m.depthTest = true; m.needsUpdate = true; });
      await L.frames(page, 3);
      const tested = await L.shot(page, 'actors_arrow_tree_depth');
      await page.evaluate(() => { const m = TLV.render.effects._meshes().arrow.material; m.depthTest = false; m.needsUpdate = true; });
      const count = (file) => Number(execFileSync('python3', ['-c', `
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert('RGB')
print(sum(1 for r, g, b in im.getdata() if g > 225 and 100 < r < 175 and b < 110))
`]).toString().trim());
      const a = count(shipped), b = count(tested);
      console.log('     arrow pixels: no depth test', a, 'with depth test', b);
      assert.ok(a > ARROW_MIN_PIXELS, 'a whole arrow: ' + a);
      assert.ok(a > b * 1.3, 'the tree no longer hides it: ' + a + ' against ' + b);
    });
  },

  /** At a real stop line the arrow leaves the signals clear: no head under it, near or far, below the horizon, above the car, at every heading it takes. */
  async stops() {
    await scene('stops', '?seed=1&notitle=1&incidents=0&hud=1&traffic=0&peds=0', async (page) => {
      await L.toDrive(page);
      const picks = await page.evaluate(() => {
        const S = TLV.app.S;
        const W = S.world;
        const out = [];
        for (const ctrl of W.ctrls) {
          for (const slot of ctrl.slots) {
            for (const de of slot) {
              const dir = W.dirEdges[de];
              if (!dir || !dir.lanes || !dir.lanes.length) continue;
              const lane = W.lanes[dir.lanes[0]];
              const n = lane.px.length;
              if (n < 2 || lane.len < 25 || !(lane.conns || []).some((q) => W.conns[q].turn === 'S')) continue;
              out.push({ lane: lane.id, x: lane.px[n - 1], y: lane.py[n - 1], h: Math.atan2(lane.py[n - 1] - lane.py[n - 2], lane.px[n - 1] - lane.px[n - 2]) });
            }
          }
        }
        const step = Math.floor(out.length / 6);
        return out.filter((_, i) => i % step === 0).slice(0, 6);
      });
      let seenFar = 0;
      for (let i = 0; i < picks.length; i++) {
        await page.evaluate((p) => { TLV.debug.teleport(p.x - Math.cos(p.h) * 2.6, p.y - Math.sin(p.h) * 2.6, p.h, 0); TLV.debug.step(1); }, picks[i]);
        await L.frames(page, 16);
        const m = await page.evaluate((lane) => {
          const lens = TLV.render.camera.object;
          const px = (v) => [(v.x + 1) * 640, (1 - v.y) * 360];
          const box = (ps) => ({ x0: Math.min(...ps.map((q) => q[0])), x1: Math.max(...ps.map((q) => q[0])), y0: Math.min(...ps.map((q) => q[1])), y1: Math.max(...ps.map((q) => q[1])) });
          const a = TLV.render.effects._meshes().arrow;
          const pos = a.geometry.attributes.position;
          const v = new THREE.Vector3();
          const pts = [];
          for (let k = 0; k < pos.count; k++) pts.push(px(v.fromBufferAttribute(pos, k).applyMatrix4(a.matrix).project(lens)));
          // A head's yellow board, by the heights in signal_heads.js: mast top less the 0.32 m drop and half of the 1.68 m board round its centre.
          const heads = TLV.render.signalHeads._near().filter((h) => h.lane === lane).map((h) => {
            const far = h.arm === 0;
            const mid = (far ? 4.2 : 5.6) - 0.32 - 0.72;
            const cx = h.x + Math.sin(h.h) * h.arm, cy = h.y - Math.cos(h.h) * h.arm;
            const corners = [];
            for (const o of [-0.36, 0.36]) {
              for (const z of [mid - 0.84, mid + 0.84]) {
                const n = new THREE.Vector3(cx + Math.sin(h.h) * o, z, -(cy - Math.cos(h.h) * o)).project(lens);
                if (n.z < 1) corners.push(px(n));
              }
            }
            return corners.length === 4 ? Object.assign({ far }, box(corners)) : null;
          }).filter((b) => b && b.x1 > 0 && b.x0 < 1280 && b.y1 > 0 && b.y0 < 720);
          const look = lens.getWorldDirection(new THREE.Vector3());
          const flat = new THREE.Vector3(look.x, 0, look.z).normalize().multiplyScalar(5000).add(lens.position);
          flat.y = lens.position.y;
          const me = TLV.app.S.vehicles[0];
          return { arrow: box(pts), heads, horizon: px(flat.project(lens))[1], roof: px(new THREE.Vector3(me.x, 1.54, -me.y).project(lens))[1] };
        }, picks[i].lane);
        const hits = m.heads.filter((b) => m.arrow.x0 < b.x1 && m.arrow.x1 > b.x0 && m.arrow.y0 < b.y1 && m.arrow.y1 > b.y0);
        seenFar += m.heads.filter((b) => b.far).length;
        console.log('     stop', i, 'arrow y', m.arrow.y0.toFixed(0), 'to', m.arrow.y1.toFixed(0), 'horizon', m.horizon.toFixed(0), 'roof', m.roof.toFixed(0), 'heads', m.heads.map((b) => (b.far ? 'far ' : 'near ') + b.y0.toFixed(0) + '-' + b.y1.toFixed(0)).join(', '));
        assert.deepStrictEqual(hits, [], 'the arrow covers a head at stop ' + i);
        assert.ok(m.arrow.y0 > m.horizon, 'below the horizon at stop ' + i);
        assert.ok(m.arrow.y1 < m.roof, 'above the roof at stop ' + i);
        if (i === 0) {
          await L.shot(page, 'actors_stop_line');
          // WP-UI's distance text is a DOM element at a fixed spot. The arrow moves down the screen with speed, so this is logged for the report, not asserted.
          console.log('     distance text box', await page.evaluate(() => { const r = document.querySelector('.hud-arrow-dist').getBoundingClientRect(); return [r.left, r.top, r.right, r.bottom].map(Math.round).join(' '); }));
        }
      }
      assert.ok(seenFar >= 3, 'far heads in view: ' + seenFar);
    });
  },

  /** A wall stands between the runner and the door: the column shows through it, and does not tint the runner in front of it. */
  async beacon() {
    await scene('beacon', '?seed=1&notitle=1&incidents=0&knife=force&errand=2&hud=1', async (page) => {
      await L.toDrive(page);
      await page.evaluate(() => { TLV.debug.forceContest({}); TLV.debug.step(120); TLV.debug.parkNow({}); TLV.debug.step(30); if (!TLV.debug.state().knife) TLV.debug.forceKnife({}); });
      for (let i = 0; i < 80; i++) {
        if (await page.evaluate(() => { TLV.debug.step(6); return TLV.app.S.vehicles[0].door; }) === 1) break;
      }
      for (let i = 0; i < 80; i++) {
        const stage = await page.evaluate(() => { TLV.debug.setInput({ interact: true }); TLV.debug.step(6); TLV.debug.setInput(null); return TLV.debug.state().knife.stage; });
        if (stage === 'CHASE') break;
      }
      const spot = await page.evaluate(() => {
        const S = TLV.app.S;
        const W = S.world;
        const e = S.game.errand;
        const sp = TLV.world.spatial;
        for (let r = 14; r <= 40; r += 3) {
          for (let a = 0; a < 48; a++) {
            const t = a / 48 * Math.PI * 2;
            const x = e.doorX + Math.cos(t) * r, y = e.doorY + Math.sin(t) * r;
            const h = Math.atan2(e.doorY - y, e.doorX - x);
            if (sp.pointInBuilding(W, x, y) >= 0) continue;
            if (!sp.rayBlocked(W, x, y, e.doorX + Math.cos(t) * 1.5, e.doorY + Math.sin(t) * 1.5)) continue;
            if (sp.rayBlocked(W, x, y, x - Math.cos(h) * 5, y - Math.sin(h) * 5)) continue;
            return { x, y, h };
          }
        }
        return null;
      });
      assert.ok(spot, 'a spot with a wall on the line to the door');
      // The foot rig's own pose, set by hand because its yaw only turns while he runs.
      await page.evaluate((b) => {
        const f = TLV.app.S.player.foot;
        f.x = f.px = b.x; f.y = f.py = b.y; f.h = f.ph = b.h; f.v = 0;
        const c = Math.cos(b.h), s = Math.sin(b.h);
        TLV.render.camera.setFree(b.x - c * 4.5, b.y - s * 4.5, 2.2, b.x + c * 4, b.y + s * 4, 1.25, 70);
        const flash = document.querySelector('.fx-flash');
        if (flash) flash.style.display = 'none';
      }, spot);
      await L.frames(page, 8);
      assert.ok(await page.evaluate(() => TLV.render.effects._state().beacon), 'beacon up');
      const on = await L.shot(page, 'actors_beacon_wall');
      // Boxes wholly on him, placed by projection: on his hair, and on his shirt. The wall round him is where the column belongs, so it must not be counted.
      const body = await page.evaluate((b) => [1.83, 1.2].map((z) => {
        const n = new THREE.Vector3(b.x, z, -b.y).project(TLV.render.camera.object);
        const x = Math.round((n.x + 1) * 640), y = Math.round((1 - n.y) * 360);
        return [x - 10, y - 10, x + 10, y + 10];
      }), spot);
      await page.evaluate(() => { TLV.render.effects._meshes().beacon.userData.behind.visible = false; });
      await L.frames(page, 3);
      const off = await L.shot(page, 'actors_beacon_wall_off');
      await page.evaluate(() => { TLV.render.effects._meshes().beacon.userData.behind.visible = true; });
      const read = JSON.parse(execFileSync('python3', ['-c', `
import json
from PIL import Image
a = Image.open(${JSON.stringify(on)}).convert('RGB'); b = Image.open(${JSON.stringify(off)}).convert('RGB')
def greener(box):
    n = 0
    for p, q in zip(a.crop(box).getdata(), b.crop(box).getdata()):
        if p[1] - q[1] > 12: n += 1
    return n
print(json.dumps({'column': greener((600, 90, 680, 190)), 'runner': sum(greener(tuple(box)) for box in ${JSON.stringify(body)})}))
`]).toString());
      console.log('     pixels the column turned green:', read.column, 'of 8000 on the wall,', read.runner, 'of 800 on the runner');
      assert.ok(read.column > 4000, 'the column shows through the wall: ' + read.column);
      assert.equal(read.runner, 0, 'and leaves the runner alone');
    });
  },

  /** Every rear, at following distance: a whole lamp, not corners of one, plain when off and red when braking. */
  async rears() {
    await scene('rears', '?seed=2&notitle=1&hud=0&incidents=0', async (page) => {
      await L.toDrive(page);
      await page.evaluate(() => {
        const S = TLV.app.S;
        const at = { x: 0, y: 0, h: 0 };
        TLV.math.polyAt(S.game.nav.route.px, S.game.nav.route.py, S.game.nav.route.cum, 170, at);
        TLV.debug.teleport(at.x, at.y, at.h, 0);
        TLV.debug.step(2);
        window.__base = at;
        S.vehicles.forEach((v, i) => { if (i && v.active) { v.x = v.px = 9000; v.y = v.py = 9000; v.lights = 0; v.mode = 'PARKED'; } });
        S.peds.forEach((p) => { if (p.active) { p.x = p.px = 9000; p.y = p.py = 9000; } });
        window.__car = S.vehicles.filter((v, i) => i && v.active)[0];
      });
      /** Stands a car, or the player, ahead of a chase lens, and gives the screen box of each brake lamp. */
      const stage = (kind, variant, lit) => page.evaluate(([k, va, on]) => {
        const S = TLV.app.S;
        const b = window.__base, v = window.__car, me = S.vehicles[0];
        const c = Math.cos(b.h), s = Math.sin(b.h);
        const player = k === 'player';
        const car = player ? me : v;
        const lampKind = player ? 'hatch' : k;
        if (player) { v.x = v.px = 9000; me.x = me.px = b.x; me.y = me.py = b.y; me.h = me.ph = b.h; } else {
          const size = TLV.const.VEHICLE_SIZES[k];
          me.x = me.px = 9000; me.y = me.py = 9000;
          v.kind = k; v.variant = va; v.length = size.length; v.width = size.width; v.door = 0; v.v = 0; v.yawRate = 0; v.horn = false;
          v.x = v.px = b.x; v.y = v.py = b.y; v.h = v.ph = b.h;
        }
        car.lights = on ? TLV.const.VL.BRAKE : 0;
        const lens = 8.5 + car.length / 2;
        TLV.render.camera.setFree(b.x - c * lens, b.y - s * lens, 2.6, b.x + c * 12, b.y + s * 12, 1, 40);
        return lampKind;
      }, [kind, variant, lit]);
      const boxes = (lampKind) => page.evaluate((k) => {
        const L0 = TLV.render.vehicles._lamps(k);
        const b = window.__base;
        const lens = TLV.render.camera.object;
        const c = Math.cos(b.h), s = Math.sin(b.h);
        return [-1, 1].map((side) => {
          const pts = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([u, w]) => {
            const lat = side * L0.rz + u * L0.w / 2, f = L0.rx - L0.proud;
            const n = new THREE.Vector3(b.x + c * f - s * lat, L0.ry + w * L0.h / 2, -(b.y + s * f + c * lat)).project(lens);
            return [(n.x + 1) * 640, (1 - n.y) * 360];
          });
          return [Math.min(...pts.map((p) => p[0])) + 1, Math.min(...pts.map((p) => p[1])) + 1, Math.max(...pts.map((p) => p[0])) - 1, Math.max(...pts.map((p) => p[1])) - 1].map(Math.round);
        });
      }, lampKind);
      const red = (file, list) => JSON.parse(execFileSync('python3', ['-c', `
import json
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert('RGB')
out = []
for box in ${JSON.stringify(list)}:
    px = list(im.crop(tuple(box)).getdata())
    out.append(sum(1 for r, g, b in px if r > 225 and g < 80 and b < 80) / max(1, len(px)))
print(json.dumps(out))
`]).toString());
      for (const [kind, variant] of [['hatch', 2], ['sedan', 3], ['taxi', 0], ['van', 0], ['van', 6], ['bus', 0], ['truck', 0], ['player', 0]]) {
        const name = kind + variant;
        const lampKind = await stage(kind, variant, false);
        await L.frames(page, 5);
        const off = red(await L.shot(page, 'actors_rear_' + name + '_off'), await boxes(lampKind));
        await stage(kind, variant, true);
        await L.frames(page, 3);
        const list = await boxes(lampKind);
        const on = red(await L.shot(page, 'actors_rear_' + name + '_on'), list);
        console.log('    ', name, 'lamp boxes', JSON.stringify(list[0]), 'red share, off', off.map((n) => n.toFixed(2)).join(' '), 'on', on.map((n) => n.toFixed(2)).join(' '));
        assert.ok(Math.max(...off) < 0.02, name + ' reads as lit when off: ' + off);
        // Lamps by the car's own right, then left. The player's left wears a cross of tape, which is the point of it, so that one lamp is held to less.
        assert.ok(on[0] > 0.85, name + ' right lamp is torn: ' + on);
        assert.ok(on[1] > (kind === 'player' ? 0.3 : 0.85), name + ' left lamp is torn: ' + on);
      }
    });
  },

  /** Signal heads show what the sim says, by instance and on screen. */
  async signals() {
    await scene('signals', '?seed=1&notitle=1&incidents=0&hud=0&traffic=0&peds=0', async (page) => {
      await L.toDrive(page);
      const seen = await page.evaluate(() => {
        const S = TLV.app.S;
        TLV.debug.step(1);
        return S.world.ctrls.length;
      });
      assert.ok(seen > 300, 'controllers');
      await L.frames(page, 3);
      const check = () => page.evaluate(() => {
        const S = TLV.app.S;
        return TLV.render.signalHeads._near().filter((h) => h.shown !== TLV.world.signals.laneState(S, h.lane)).length;
      });
      assert.equal(await check(), 0, 'every head shows its lane');
      const heads = await page.evaluate(() => TLV.render.signalHeads._counts());
      assert.ok(heads.near > 6, 'heads near the player: ' + heads.near);
      // The King George light, up close: one red and one green shot of the same head. Nearest mast to the spawn.
      const pick = await page.evaluate(() => {
        const S = TLV.app.S;
        const me = S.vehicles[0];
        const list = TLV.render.signalHeads._near().filter((h) => h.arm > 0).sort((a, b) => Math.hypot(a.x - me.x, a.y - me.y) - Math.hypot(b.x - me.x, b.y - me.y));
        const h = list[0];
        const lane = S.world.lanes[h.lane];
        const junc = TLV.world.junctions.ahead(S.world, h.lane);
        const dx = Math.cos(h.h), dy = Math.sin(h.h);
        const tipX = h.x + Math.sin(h.h) * h.arm, tipY = h.y - Math.cos(h.h) * h.arm;
        TLV.render.camera.setFree(tipX + dx * 16, tipY + dy * 16, 1.8, tipX, tipY, 4.2, 40);
        return { junc, lane: lane.id };
      });
      for (const [state, want] of [['R', 2], ['G', 0]]) {
        await page.evaluate(([j, st]) => { TLV.debug.forceSignal(j, st, 60); TLV.debug.step(2); }, [pick.junc, state]);
        await L.frames(page, 3);
        const shown = await page.evaluate((id) => TLV.render.signalHeads._near().find((h) => h.lane === id).shown, pick.lane);
        assert.equal(shown, want, 'forced ' + state);
        await L.shot(page, 'actors_signal_' + state);
      }
    });
  },

  /** Doors, hazards, reverse, horn, brake: the tells a player reads. */
  async tells() {
    await scene('tells', '?seed=4&notitle=1&incidents=0&hud=0', async (page) => {
      await L.toDrive(page);
      await page.evaluate(() => {
        const S = TLV.app.S;
        const me = S.vehicles[0];
        const lanes = S.world.lanes;
        const near = [];
        S.vehicles.forEach((v) => { if (v.active && !v.isPlayer) near.push([Math.hypot(v.x - me.x, v.y - me.y), v]); });
        near.sort((a, b) => a[0] - b[0]);
        window.__picks = near.slice(1, 7).map((n) => n[1].id);
        void lanes;
      });
      // Three cars in a row, staged by hand so each tell is in one shot.
      const pos = await page.evaluate(() => {
        const S = TLV.app.S;
        const me = S.vehicles[0];
        const VL = TLV.const.VL;
        const c = Math.cos(me.h), s = Math.sin(me.h);
        const set = [
          { lights: VL.BRAKE, door: 0, ox: 10, oy: 0 }, { lights: VL.HAZARD, door: 1, ox: 18, oy: 0 }, { lights: VL.BLINK_L, door: 0, ox: 26, oy: 0 },
          { lights: VL.BLINK_R, door: 2, ox: 34, oy: 0 }, { lights: VL.REVERSE, door: 0, ox: 42, oy: 0 }, { lights: VL.BRAKE | VL.HAZARD, door: 0, ox: 50, oy: 0 }
        ];
        window.__picks.forEach((id, i) => {
          const v = TLV.traffic.byId(S, id);
          const k = set[i];
          v.x = v.px = me.x + c * k.ox;
          v.y = v.py = me.y + s * k.ox;
          v.h = v.ph = me.h;
          v.lights = k.lights;
          v.door = k.door;
          v.v = 0;
        });
        // Hold the blink on, for a still.
        return { x: me.x, y: me.y, h: me.h };
      });
      await page.evaluate((p) => {
        TLV.render.camera.setFree(p.x - Math.sin(p.h) * -4 + Math.cos(p.h) * 2, p.y + Math.cos(p.h) * -4 + Math.sin(p.h) * 2, 2.1, p.x + Math.cos(p.h) * 24, p.y + Math.sin(p.h) * 24, 1, 38);
      }, pos);
      await L.frames(page, 7);
      await L.shot(page, 'actors_tells');
    });
  },

  /** Sparks, dents, streaks, horn rings, and the white flash. */
  async impact() {
    await scene('impact', '?seed=5&notitle=1&incidents=0&hud=0', async (page) => {
      await L.toDrive(page);
      const before = await page.evaluate(() => TLV.render.effects._state());
      await page.evaluate(() => {
        const S = TLV.app.S;
        const me = S.vehicles[0];
        const c = Math.cos(me.h), s = Math.sin(me.h);
        const at = (f, l) => ({ x: me.x + c * f - s * l, y: me.y + s * f + c * l });
        const a = at(1.9, 0.6), b = at(-0.5, 0.9), d = at(1.4, -0.9);
        S.bus.emit('player.contact', { kind: 'static', otherId: -1, vn: 9, severity: 'crash', rearEnded: false, x: a.x, y: a.y });
        S.bus.emit('player.contact', { kind: 'static', otherId: -1, vn: 5, severity: 'bump', rearEnded: false, x: b.x, y: b.y });
        S.bus.emit('player.contact', { kind: 'static', otherId: -1, vn: 2, severity: 'scrape', rearEnded: false, x: d.x, y: d.y });
        S.bus.emit('player.nearMiss', { vehId: 1, gap: 0.5, relSpeed: 9, tier: 1, x: at(0, 2).x, y: at(0, 2).y });
        TLV.debug.setInput({ horn: true });
        TLV.debug.step(4);
      });
      await L.frames(page, 1);
      const st = await page.evaluate(() => ({ fx: TLV.render.effects._state(), cam: TLV.render.camera._state() }));
      assert.ok(st.fx.particles > before.particles + 30, 'sparks: ' + st.fx.particles);
      assert.ok(st.fx.streak < 1, 'streaks running');
      assert.ok(st.cam.shakeT > 0, 'shake running');
      await L.shot(page, 'actors_impact');
      await L.frames(page, 14);
      await page.evaluate(() => {
        const me = TLV.app.S.vehicles[0];
        const c = Math.cos(me.h), s = Math.sin(me.h);
        TLV.debug.setInput(null);
        TLV.render.camera.setFree(me.x + c * 4.6 + -s * 2.2, me.y + s * 4.6 + c * 2.2, 2.1, me.x, me.y, 0.7, 42);
      });
      await L.frames(page, 8);
      await L.shot(page, 'actors_dents');
      const rest = await page.evaluate(() => TLV.render.effects._state());
      assert.ok(rest.streak >= 1, 'streaks finished');
    });
  },

  /** One of everything, staged by hand on an empty stretch of real street. The test moves sim records, which only a test may do. */
  async lineup() {
    await scene('lineup', '?seed=2&notitle=1&incidents=0&hud=0', async (page) => {
      await L.toDrive(page);
      await page.evaluate(() => {
        const S = TLV.app.S;
        const route = S.game.nav.route;
        const at = { x: 0, y: 0, h: 0 };
        TLV.math.polyAt(route.px, route.py, route.cum, 170, at);
        TLV.debug.teleport(at.x, at.y, at.h, 0);
        window.__base = at;
      });
      const stage = (rows, poses) => page.evaluate(([list, pp]) => {
        const S = TLV.app.S;
        const b = window.__base;
        const c = Math.cos(b.h), s = Math.sin(b.h), lx = -s, ly = c;
        S.vehicles.forEach((v, i) => { if (i && v.active) { v.x = v.px = 9000; v.y = v.py = 9000; } });
        S.peds.forEach((p) => { if (p.active) { p.x = p.px = 9000; p.y = p.py = 9000; } });
        const cars = S.vehicles.filter((v, i) => i && v.active);
        let d = 6;
        list.forEach((k, i) => {
          const v = cars[i];
          const size = TLV.const.VEHICLE_SIZES[k[0]];
          v.kind = k[0]; v.variant = k[1]; v.length = size.length; v.width = size.width;
          d += size.length / 2;
          v.x = v.px = b.x + c * d; v.y = v.py = b.y + s * d; v.h = v.ph = b.h;
          v.mode = 'PARKED'; v.lights = k[2] || 0; v.door = k[3] || 0; v.v = 0; v.yawRate = 0; v.horn = false;
          d += size.length / 2 + 2.2;
        });
        pp.forEach((r, i) => {
          const p = S.peds[i];
          p.active = true; p.id = 7000 + i; p.kind = r[0]; p.variant = r[1]; p.anim = r[2]; p.v = r[3]; p.hasKnife = !!r[4]; p.intent = !!r[5];
          p.x = p.px = b.x + c * (8 + i * 2.7) + lx * (i % 2 ? 1 : -0.6); p.y = p.py = b.y + s * (8 + i * 2.7) + ly * (i % 2 ? 1 : -0.6);
          p.h = p.ph = b.h; p.state = 'WALK';
        });
        return d;
      }, [rows, poses]);
      const shoot = (ox, oy, lookO, z, fov) => page.evaluate(([a, e, g, h, f]) => {
        const b = window.__base;
        const c = Math.cos(b.h), s = Math.sin(b.h), lx = -s, ly = c;
        TLV.render.camera.setFree(b.x + c * a + lx * e, b.y + s * a + ly * e, h, b.x + c * g, b.y + s * g, 1.05, f);
      }, [ox, oy, lookO, z, fov]);
      await stage([['hatch', 0], ['sedan', 3], ['taxi', 0], ['taxi', 3], ['van', 0], ['van', 6], ['bus', 0], ['truck', 1]], []);
      await shoot(27, -16, 27, 3.1, 58);
      await L.frames(page, 10);
      await L.shot(page, 'actors_cars');
      await stage([], [
        ['walker', 0, 'walk', 1.3], ['walker', 10, 'walk', 0.7], ['phone', 1, 'phone', 1.1], ['trolley', 2, 'walk', 0.8], ['trolley', 3, 'walk', 0.8],
        ['walker', 12, 'walk', 1.3], ['scooter', 4, 'ride', 6], ['delivery', 5, 'ride', 7], ['inspector', 5, 'phone', 0], ['saver', 6, 'glare', 0],
        ['attacker', 8, 'run', 5.7, true], ['walker', 2, 'idle', 0, false, true], ['walker', 3, 'sit', 0]
      ]);
      await shoot(23, -9.5, 23, 1.7, 56);
      await L.frames(page, 10);
      await L.shot(page, 'actors_people');
      // From above the parked row, so the feet and the wheels show too.
      await shoot(14, -9, 14, 5.2, 50);
      await L.frames(page, 3);
      await L.shot(page, 'actors_people_a');
      await shoot(31, -9, 31, 5.2, 50);
      await L.frames(page, 3);
      await L.shot(page, 'actors_people_b');
      const seen = await page.evaluate(() => TLV.render.people._counts());
      assert.ok(seen.doll >= 13 && seen.props >= 5, 'everyone drawn in full: ' + JSON.stringify(seen));
    });
  },

  /** On foot: bail out of the passenger side, get clear of the two cars, run for the door. */
  async chase() {
    await scene('chase', '?seed=3&notitle=1&incidents=0&knife=force&errand=2&hud=1', async (page) => {
      await L.toDrive(page);
      await page.evaluate(() => { TLV.debug.forceContest({}); TLV.debug.step(120); TLV.debug.parkNow({}); TLV.debug.step(30); if (!TLV.debug.state().knife) TLV.debug.forceKnife({}); });
      for (let i = 0; i < 80; i++) {
        const door = await page.evaluate(() => { TLV.debug.step(6); return TLV.app.S.vehicles[0].door; });
        if (door === 1) break;
      }
      for (let i = 0; i < 80; i++) {
        const stage = await page.evaluate(() => {
          TLV.debug.setInput({ interact: true });
          TLV.debug.step(6);
          TLV.debug.setInput(null);
          return TLV.debug.state().knife.stage;
        });
        if (stage === 'CHASE') break;
      }
      const moved = await page.evaluate(() => {
        const S = TLV.app.S;
        const k = S.game.knife;
        const e = S.game.errand;
        const rival = TLV.traffic.byId(S, k.rivalVehId);
        const x0 = S.player.fx, y0 = S.player.fy;
        const me = S.vehicles[0];
        const c = Math.cos(me.h), s = Math.sin(me.h);
        const along = (e.doorX - x0) * c + (e.doorY - y0) * s >= 0 ? 1 : -1;
        const right = { x: s, y: -c };
        void rival;
        // Out to the sidewalk, then along it toward the door: the way a person would go.
        for (let i = 0; i < 170; i++) {
          const dx = i < 20 ? right.x : c * along, dy = i < 20 ? right.y : s * along;
          TLV.debug.setInput({ footX: dx, footY: dy, sidestep: k.lunge === 'WINDUP' });
          TLV.debug.step(1);
          if (!S.game.knife || S.game.knife.stage !== 'CHASE') break;
        }
        return Math.hypot(S.player.fx - x0, S.player.fy - y0);
      });
      await page.evaluate(() => { const f = document.querySelector('.fx-flash'); if (f) f.style.display = 'none'; });
      await L.frames(page, 5);
      const st = await page.evaluate(() => ({ cam: TLV.render.camera._state(), fx: TLV.render.effects._state(), rear: TLV.render.rearview._state(), s: TLV.debug.state() }));
      assert.ok(moved > 10, 'ran ' + moved);
      assert.equal(st.s.player.mode, 'FOOT');
      assert.equal(st.s.knife.stage, 'CHASE');
      assert.equal(st.cam.rig, 'foot');
      assert.ok(Math.abs(st.cam.fov - 70) < 1, 'foot fov ' + st.cam.fov);
      assert.ok(st.rear.shown, 'strip stays on in a chase');
      assert.ok(st.fx.beacon, 'beacon up');
      assert.ok(st.fx.arrow, 'arrow up');
      await L.shot(page, 'actors_chase');
      await budget(page, 'chase');
    });
  }
};

(async () => {
  const want = process.argv.slice(2);
  const names = want.length ? want : Object.keys(SCENES);
  let failed = 0;
  for (const n of names) {
    try {
      await SCENES[n]();
    } catch (e) {
      failed++;
      console.log('FAIL', n, e.message);
    }
  }
  console.log(JSON.stringify(table));
  process.exit(failed ? 1 : 0);
})();
