// tests/render/actors_contract.e2e.cjs — RENDER-ACTORS
// Run: node tests/render/actors_contract.e2e.cjs [check ...]
// The non-visual half of ARCHITECTURE 19 WP-RENDER: item 11 (sim hash identical with render on and off for 3,600 ticks), item 10 (a
// hit shows no red, and the attacker is a palette swap), and that what is drawn matches what the sim holds.
'use strict';

const assert = require('node:assert');
const { execFileSync } = require('node:child_process');
const L = require('./actors_lib.cjs');

/** Query for the hash run: a bot that plays errands, parks, and meets the knife, so the camera, foot and door paths all run. */
const HASH_QUERY = '?seed=7&notitle=1&autoplay=errands&knife=force&immortal=1&hud=0&quality=low';
const HASH_TICKS = 3600;
const HASH_STEP = 60;
/** The loop runs until pause lands, and boot speed differs between pages, so hashes are compared by absolute tick, from here on. */
const HASH_FROM = 600;
const PIXELS = 1280 * 720;
/** GAME_DESIGN 24 row 26's threshold for strong red, as a share of the capture: 1,843 pixels at 1280 x 720. */
const RED_LIMIT = 0.002;
/** A street with no red car in shot. A shop sign and an awning sit under this. The corner of a red car at the edge of the frame does not, at 0.0013, and the old baseline was at 0.053. */
const RED_BASELINE = 0.001;
/** GAME_DESIGN 15.2. */
const LUNGE_FINE = 100;

/** Serves every render and UI file empty, so this page has no render at all. */
async function noRender(page) {
  await page.route(/\/js\/(render|ui)\//, (route) => route.fulfill({ contentType: 'text/javascript', body: '' }));
  await page.route(/\/css\/ui\.css/, (route) => route.fulfill({ contentType: 'text/css', body: '' }));
}

/** Steps a page and returns tick-to-hash from HASH_FROM on. With frames on, a real frame is rendered between steps. */
async function hashes(page, withFrames) {
  const start = await page.evaluate(() => { TLV.debug.pause(); return TLV.debug.state().tick; });
  assert.ok(start < HASH_FROM, 'paused at tick ' + start);
  await page.evaluate((to) => { TLV.debug.step(to - TLV.debug.state().tick); }, HASH_FROM);
  const out = [];
  for (let t = 0; t <= HASH_TICKS; t += HASH_STEP) {
    const at = await page.evaluate(() => [TLV.debug.state().tick, TLV.debug.hash()]);
    out.push(at);
    // Both pages meet the knife on the same tick, so the camera, door, foot and attacker code all run against the hash.
    if (t === HASH_TICKS / 2) await page.evaluate(() => { TLV.debug.forceContest({}); TLV.debug.step(1); TLV.debug.parkNow({}); TLV.debug.step(1); if (!TLV.debug.state().knife) TLV.debug.forceKnife({}); });
    await page.evaluate((n) => { TLV.debug.step(n); }, HASH_STEP);
    if (withFrames) await L.frames(page, 1);
  }
  return out;
}

const CHECKS = {
  /** Item 11. */
  async hash() {
    const on = await L.openGame(HASH_QUERY);
    let a;
    let phases;
    try {
      a = await hashes(on.page, true);
      phases = await on.page.evaluate(() => {
        const s = TLV.debug.state();
        return { tick: s.tick, errand: s.errandIndex, knives: TLV.app.S.game.knivesDone, phase: s.phase, foot: TLV.app.S.player.mode };
      });
      assert.ok(await on.page.evaluate(() => !!TLV.render.info().calls), 'render really ran');
      L.assertClean(on);
    } finally {
      await on.browser.close();
    }
    const pw = require('../../tools/lib/pw.cjs');
    const off = await pw.open({ params: HASH_QUERY, server: true, before: noRender });
    let b;
    try {
      await off.page.waitForFunction(() => window.TLV && TLV.app && TLV.app.S, null, { timeout: 120000 });
      assert.ok(await off.page.evaluate(() => !(TLV.render && TLV.render.frame)), 'this page has no render');
      b = await hashes(off.page, false);
    } finally {
      await off.browser.close();
    }
    assert.deepStrictEqual(a, b);
    console.log('     hash at', JSON.stringify(a[a.length - 1]), JSON.stringify(phases));
  },

  /**
   * Item 10 and GAME_DESIGN 24 row 26. A lunge lands through the sim on a player standing still, and nothing here emits the event. The baseline street has no red car in shot, so "no red"
   * means what it says: the capture stays under the row's threshold before the strike, on the flash and after it.
   */
  async hit() {
    const g = await L.openGame('?seed=4&notitle=1&incidents=0&knife=force&errand=2&hud=0&mute=1');
    try {
      const { page } = g;
      await L.toDrive(page);
      await page.evaluate(() => {
        const S = TLV.app.S;
        window.__knife = [];
        S.bus.on('knife.lunge', (e) => window.__knife.push(e.phase));
        S.bus.on('knife.strike', (e) => window.__knife.push('strike ' + e.strikes));
        TLV.debug.forceContest({});
        TLV.debug.step(60);
        TLV.debug.parkNow({});
        TLV.debug.step(30);
        if (!TLV.debug.state().knife) TLV.debug.forceKnife({});
        /** The canvas as it stands. The frame and the read are one task, so on the flash this is the flash itself and not whatever a screenshot lands on later. */
        window.__white = () => {
          TLV.render.drawNow();
          const gl = TLV.render.gl().getContext();
          const W = gl.drawingBufferWidth, H = gl.drawingBufferHeight;
          const px = new Uint8Array(W * H * 4);
          gl.readPixels(0, 0, W, H, gl.RGBA, gl.UNSIGNED_BYTE, px);
          let white = 0;
          for (let i = 0; i < px.length; i += 4) if (px[i] > 240 && px[i + 1] > 240 && px[i + 2] > 240) white++;
          return white / (W * H);
        };
      });
      // Out of the car by the E the prompt asks for, then no controls at all, and he comes. On this seed his car is orange, and the street in shot has no red car.
      // The rig gets its frames by hand, one a tick, so it keeps up without a slow GL frame for each.
      await page.evaluate(() => {
        const S = TLV.app.S, cam = TLV.render.camera;
        const tick = () => { TLV.debug.step(1); TLV.debug.setInput(null); cam.frame(S, 1, 1 / 60); };
        for (let i = 0; i < 600 && TLV.debug.state().knife.stage !== 'CHASE'; i++) {
          TLV.debug.setInput({ interact: true });
          tick();
        }
        for (let i = 0; i < 900 && S.game.knife.lunge === 'NONE'; i++) tick();
      });
      assert.equal(await page.evaluate(() => TLV.app.S.game.knife.lunge), 'WINDUP', 'he winds up');
      await L.frames(page, 3);
      const count = (file) => Number(execFileSync('python3', ['-c', `
from PIL import Image
im = Image.open(${JSON.stringify(file)}).convert('RGB')
print(sum(1 for r, g, b in im.getdata() if r > 170 and g < 70 and b < 70))
`]).toString().trim()) / PIXELS;
      const before = await page.evaluate(() => ({ money: TLV.app.S.game.money, strikes: TLV.app.S.game.knife.strikes, white: window.__white() }));
      const a = count(await L.shot(page, 'actors_hit_before'));
      assert.equal(before.strikes, 0);
      assert.ok(a < RED_BASELINE, 'the baseline has no red car in shot: ' + a);
      assert.ok(before.white < 0.2, 'the baseline is a street: ' + before.white);
      const landed = await page.evaluate(() => {
        const S = TLV.app.S, k = S.game.knife;
        for (let i = 0; i < 120 && !k.strikes; i++) TLV.debug.step(1);
        // The UI drains the strike at the end of a real frame, and the flash runs down on the real frames after it. A wait from this side of the bridge let two go by under
        // load and read 0.62, which is no longer white. So the page watches from the strike's own task and reads on the first frame that has it.
        window.__flashed = new Promise((resolve) => {
          const read = () => {
            const level = TLV.render.effects._state().flash;
            if (level > 0) resolve({ level, white: window.__white(), stars: TLV.render.people._dizzyDrawn() });
            else requestAnimationFrame(read);
          };
          requestAnimationFrame(read);
        });
        return { strikes: k.strikes, money: S.game.money, invuln: S.player.foot.invulnT, events: window.__knife.slice() };
      });
      assert.equal(landed.strikes, 1, 'the sim counted the strike');
      assert.deepStrictEqual(landed.events, ['WINDUP', 'STRIKE', 'strike 1'], 'the sim landed it');
      assert.equal(before.money - landed.money, LUNGE_FINE, 'the fine');
      assert.ok(landed.invuln > 0, 'the hit took');
      const flashed = await page.evaluate(() => window.__flashed);
      assert.ok(flashed.level > 0.5, 'white flash ' + flashed.level);
      assert.ok(flashed.stars >= 1, 'a lunge hit keeps its stars (GAME_DESIGN 15.2): ' + flashed.stars);
      assert.ok(flashed.white > 0.5, 'the frame is white: ' + flashed.white + ' at flash ' + flashed.level);
      const w = count(await L.shot(page, 'actors_hit_flash'));
      assert.ok(w < RED_LIMIT, 'no red in the flash: ' + w);
      // The HUD's white layer only runs down on a live sim, so a paused page stays white for good and any count of it reads 0. The hit leaves him 1.5 s of cover to fade in.
      await page.evaluate(() => TLV.debug.resume());
      await page.waitForFunction(() => TLV.render.effects._state().flash === 0 && Number(document.querySelector('.fx-flash').style.opacity || 0) === 0, null, { timeout: 60000 });
      await page.evaluate(() => TLV.debug.pause());
      assert.equal(await page.evaluate(() => TLV.app.S.game.knife.strikes), 1, 'one strike');
      await L.frames(page, 2);
      const street = await page.evaluate(() => window.__white());
      const c = count(await L.shot(page, 'actors_hit_after'));
      console.log('     strong red share: before', a.toFixed(5), 'flash', w.toFixed(5), 'after', c.toFixed(5), 'limit', RED_LIMIT, '; white', flashed.white.toFixed(3), 'then', street.toFixed(3), '; flash', flashed.level, landed.events.join(' '));
      assert.ok(street < 0.2, 'the street is back: ' + street);
      assert.ok(c < RED_LIMIT, 'no red left behind: ' + c);
      L.assertClean(g);
    } finally {
      await g.browser.close();
    }
  },

  /**
   * GAME_DESIGN 8.3: a person the car hits gets no comic animation. A real collision with a real crosser, drawn on every step of the whole
   * stumble. The same page then lands a lunge, so a counter that can never read above 0 cannot pass this.
   */
  async carHitStraight() {
    const g = await L.openGame('?seed=9&notitle=1&incidents=0&traffic=0&contest=off&errand=3&immortal=1&hud=0&mute=1&quality=low');
    try {
      const { page } = g;
      await L.toDrive(page);
      const r = await page.evaluate(() => {
        const S = TLV.app.S, people = TLV.render.people, veh = S.player.veh;
        const crossing = (q) => q.active && q.kind !== 'attacker' && (q.state === 'CROSS_LEGAL' || q.state === 'JAYWALK' || q.state === 'CROSS_SLOW' || q.state === 'RED_CROSS');
        for (let i = 0; i < 90 && !S.peds.some(crossing); i++) TLV.debug.step(30);
        const p = S.peds.find(crossing);
        if (!p) return { crosser: false };
        const was = p.state;
        const h = p.h + Math.PI / 2, gap = veh.length / 2 + 1.5;
        TLV.player.setPose(S, p.x - Math.cos(h) * gap, p.y - Math.sin(h) * gap, h, 4);
        TLV.debug.setInput({ throttle: 0.2 });
        for (let i = 0; i < 120 && S.game.pedHits === 0; i++) TLV.debug.step(1);
        TLV.debug.setInput({ brake: 1 });
        const seen = {};
        let frames = 0, stars = 0, full = 0;
        while (p.active && p.state === 'STUMBLE' && frames < 60) {
          TLV.render.drawNow();
          frames++;
          seen[p.anim] = (seen[p.anim] || 0) + 1;
          stars += people._dizzyDrawn();
          full = Math.max(full, people._counts().doll);
          TLV.debug.step(6);
        }
        return { crosser: true, was, id: p.id, hits: S.game.pedHits, frames, seen, stars, full };
      });
      console.log('     car hit', JSON.stringify(r));
      assert.ok(r.crosser, 'a real crosser came up');
      assert.equal(r.hits, 1, 'the sim counted the hit');
      assert.ok(r.frames >= 10, 'the whole stumble was drawn: ' + r.frames);
      for (const anim of ['stumble', 'sit', 'idle']) assert.ok(r.seen[anim], 'it fell, sat and stood: ' + anim + ' in ' + JSON.stringify(r.seen));
      assert.ok(r.full >= 1, 'that person was drawn in full, where the stars would show');
      assert.equal(r.stars, 0, 'no stars on a person the car hit');
      L.assertClean(g);
    } finally {
      await g.browser.close();
    }
  },

  /** Item 10: the attacker is the same doll, in another shirt, and nobody wears a symbol. */
  async palette() {
    const g = await L.openGame('?seed=3&notitle=1&incidents=0&hud=0');
    try {
      const r = await g.page.evaluate(() => {
        const out = [];
        for (let id = 1; id < 400; id++) {
          const a = TLV.render.people._look('attacker', id, id & 15);
          const w = TLV.render.people._look('walker', id, 0);
          out.push({ a, w });
        }
        return { pairs: out, shirt: TLV.render.people._attackerShirt() };
      });
      for (const { a, w } of r.pairs) {
        assert.equal(a.shirt, r.shirt);
        assert.deepStrictEqual({ pants: a.pants, skin: a.skin, hair: a.hair }, { pants: w.pants, skin: w.skin, hair: w.hair }, 'same person underneath');
        assert.ok(a.acc.every((n) => n === 'BODY' || n.startsWith('HAIR_')), 'attacker wears nothing but hair: ' + a.acc);
      }
    } finally {
      await g.browser.close();
    }
  },

  /** The strip stays below the No-Claims bar as the HUD scales. WP-UI's report found this at 1080p. */
  async strip1080() {
    const g = await L.openGame('?seed=1&notitle=1&incidents=0&quality=low', { viewport: { width: 1920, height: 1080 } });
    try {
      await L.toDrive(g.page);
      await L.frames(g.page, 2);
      await g.page.evaluate(() => { if (!TLV.render.rearview._state().shown) TLV.render.rearview.toggle(); });
      await L.frames(g.page, 4);
      const r = await g.page.evaluate(() => {
        const box = document.getElementById('rearview-frame').getBoundingClientRect();
        const bar = document.querySelector('.hud-hp').getBoundingClientRect();
        return { stripTop: box.top, barBottom: bar.bottom, shown: TLV.render.rearview._state().shown };
      });
      console.log('     1080p', JSON.stringify(r));
      assert.ok(r.shown, 'strip up');
      assert.ok(r.stripTop >= r.barBottom, 'strip clears the bar');
      await L.shot(g.page, 'actors_strip_1080');
    } finally {
      await g.browser.close();
    }
  },

  /** What is drawn is what the sim holds. */
  async instances() {
    const g = await L.openGame('?seed=6&notitle=1&incidents=0&hud=0');
    try {
      await L.toDrive(g.page);
      await L.frames(g.page, 3);
      const r = await g.page.evaluate(() => {
        const S = TLV.app.S;
        const want = { };
        let cars = 0;
        S.vehicles.forEach((v) => { if (v.active) { cars++; want[v.kind] = (want[v.kind] || 0) + 1; } });
        const c = TLV.render.vehicles._counts();
        const p = TLV.render.people._counts();
        const drawn = c.hatch + c.sedan + c.taxi + c.van + c.bus + c.truck + c.player + c.lite;
        const peds = S.peds.filter((q) => q.active).length;
        return { cars, drawn, peds, doll: p.doll, lite: p.lite, counts: c, want };
      });
      assert.equal(r.drawn, r.cars, 'one car drawn per active car');
      assert.equal(r.doll + r.lite, r.peds, 'one person drawn per active person');
      L.assertClean(g);
    } finally {
      await g.browser.close();
    }
  },

  /**
   * The owner's limit on the ghost. A tailgater keeps it, whatever its size, but it may not lay a hatched sheet over the view: a bus 1.4 m behind covered 0.2 of the
   * pixels, and a truck's cargo box drew a hard band across the frame. A car on the line still ghosts, and a bus crossing at the lens stays solid.
   */
  async ghost() {
    const g = await L.openGame('?seed=7&notitle=1&incidents=0&hud=0&traffic=0&peds=0&quality=low');
    const { page } = g;
    try {
      await L.toDrive(page);
      await page.evaluate(() => {
        TLV.debug.setInput({ throttle: 0.5 });
        TLV.debug.step(120);
        TLV.debug.setInput({ throttle: 0.18 });
        TLV.debug.step(60);
      });
      /** Puts a car in the sim at a place around the player, runs the view until the ghost settles, and reads what it covers. */
      const place = (spec) => page.evaluate((o) => {
        const S = TLV.app.S;
        const me = S.vehicles[0];
        const id = TLV.debug.spawnCar({ laneId: S.player.laneId, s: 3, kind: o.kind, force: true });
        const v = S.vehicles.find((c) => c.id === id);
        const h = me.h + (o.turn || 0);
        v.x = me.x + Math.cos(me.h) * o.along;
        v.y = me.y + Math.sin(me.h) * o.along;
        v.h = h;
        v.v = 0;
        const canvas = document.getElementById('game');
        const grab = () => {
          TLV.render.drawNow();
          const c = document.createElement('canvas');
          c.width = canvas.width;
          c.height = canvas.height;
          const x = c.getContext('2d', { willReadFrequently: true });
          x.drawImage(canvas, 0, 0);
          return x.getImageData(0, 0, c.width, c.height).data;
        };
        return new Promise((resolve) => {
          let n = 0;
          const step = () => {
            TLV.render.frame(S, 1, 1 / 20);
            if (++n < 40) {
              requestAnimationFrame(step);
              return;
            }
            const a = grab();
            const bodies = Object.values(TLV.render.vehicles._bodies()).map((b) => b.mesh);
            bodies.forEach((m) => { m.visible = false; });
            const b = grab();
            bodies.forEach((m) => { m.visible = true; });
            let hit = 0;
            for (let i = 0; i < a.length; i += 4) {
              if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 30) hit++;
            }
            const out = { ghost: TLV.render.camera.isGhost(v.slot), tailing: TLV.render.camera._state().tailing, share: hit / (a.length / 4) };
            v.x += 500;
            resolve(out);
          };
          step();
        });
      }, spec);
      const back = (kind, gap) => -(2.2 + gap + { sedan: 2.2, bus: 6, truck: 3.8 }[kind]);
      const bus = await place({ kind: 'bus', along: back('bus', 1.4) });
      assert.ok(bus.ghost && bus.tailing, 'a tailgating bus keeps its ghost: ' + JSON.stringify(bus));
      assert.ok(bus.share < 0.08, 'and it covers little of the frame: ' + JSON.stringify(bus));
      const truck = await place({ kind: 'truck', along: back('truck', 1.4) });
      assert.ok(truck.ghost && truck.share < 0.08, 'a tailgating truck: ' + JSON.stringify(truck));
      const sedan = await place({ kind: 'sedan', along: back('sedan', 1.4) });
      assert.ok(sedan.ghost && sedan.share > 0.002, 'a tailgating car is still there to see: ' + JSON.stringify(sedan));
      const crossing = await place({ kind: 'bus', along: -3.8, turn: Math.PI / 2 });
      assert.ok(!crossing.ghost, 'a bus across the view stays solid: ' + JSON.stringify(crossing));
      const near = await place({ kind: 'sedan', along: -3, turn: Math.PI / 2 });
      assert.ok(near.ghost, 'a car on the line, small enough in the frame, still ghosts: ' + JSON.stringify(near));
      L.assertClean(g);
    } finally {
      await g.browser.close();
    }
  }
};

(async () => {
  const want = process.argv.slice(2);
  const names = want.length ? want : Object.keys(CHECKS);
  let failed = 0;
  for (const n of names) {
    try {
      await CHECKS[n]();
      console.log('ok  ', n);
    } catch (e) {
      failed++;
      console.log('FAIL', n, String(e.message).slice(0, 1200));
    }
  }
  process.exit(failed ? 1 : 0);
})();
