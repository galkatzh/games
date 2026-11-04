// tests/render/shots.e2e.cjs — WP-RENDER (RENDER-CITY)
// Run: TLV_SHOTS=dir [TLV_DENSITY=150] [TLV_STRIP=1] node tests/render/shots.e2e.cjs [name ...]
// TLV_DENSITY sets the traffic density (60 by default), and TLV_STRIP pins the rear-view strip up, for the worst case of a view.
// Takes the review screenshots from the game's own camera, and prints info() at each. Prints a budget verdict; a person judges
// the pictures (section 19, WP-RENDER item 2).
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const pw = require('../../tools/lib/pw.cjs');

const OUT = process.env.TLV_SHOTS || path.join(os.tmpdir(), 'tlv-render-shots');
const DENSITY = process.env.TLV_DENSITY || '60';
/** The cap is 400,000. With the strip pinned up, the worst case of a view, the owner asked for room under it. */
const TRIANGLES = process.env.TLV_STRIP ? 390000 : 400000;

/** x, y and h are the car; `yaw` turns the camera's view by moving the car. `mode` is a camera mode. */
const VIEWS = [
  { name: 'dizengoff', x: -344, y: 600, h: -1.57, hud: 1 },
  { name: 'dizengoff_bridges', x: -112, y: -36, h: 2.2, hud: 1 },
  { name: 'azrieli_skyline', x: 640, y: -178, h: 0, hud: 1 },
  { name: 'seafront', x: -1000, y: 400, h: 1.3, hud: 1 },
  { name: 'parking_camera', x: -344, y: 600, h: -1.57, hud: 1, mode: 'parking' },
  { name: 'rothschild', x: 49, y: -802, h: 1.3, hud: 1 },
  { name: 'junction_george', x: -180, y: -55, h: 0.94, hud: 1 },
  // The Ayalon from Kaplan bridge, looking south past Azrieli: a held view, as a person standing on the bridge sees it. Last, because it leaves the car where it is.
  { name: 'ayalon_kaplan', x: 1540, y: 100, h: 0, hud: 1, view: { x: 1548, y: 100, z: 6, lookX: 1490, lookY: -300, lookZ: 0, fov: 60 } }
];

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const want = process.argv.slice(2);
  const list = want.length ? VIEWS.filter((v) => want.includes(v.name)) : VIEWS;
  const { browser, page, logs } = await pw.open({ params: `?seed=1&notitle=1&quality=high&mute=1&density=${DENSITY}` });
  let over = 0;
  try {
    await pw.waitForTick(page, 30, { timeoutMs: 240000 });
    await page.evaluate(() => {
      TLV.debug.setClock(600);
      TLV.debug.setInput({ start: true, interact: true });
    });
    await page.waitForFunction(() => TLV.debug.state().phase === 'DRIVE', null, { timeout: 120000, polling: 500 });
    await page.evaluate(() => TLV.debug.setInput(null));
    // toggle() flips what is on screen, and that only changes on a frame: flip, wait, and ask again until it says on.
    for (let i = 0; process.env.TLV_STRIP && i < 4; i++) {
      if (await page.evaluate(() => TLV.render.rearview._state().pref) === 'on') break;
      await page.evaluate(() => TLV.render.rearview.toggle());
      await pw.waitForTick(page, await page.evaluate(() => TLV.debug.state().tick) + 3, { timeoutMs: 60000 });
    }
    for (const v of list) {
      await page.evaluate((view) => {
        const S = TLV.app.S;
        const near = TLV.world.lanes.project(S.world, view.x, view.y, view.h, 40, {});
        const p = near ? TLV.world.lanes.pointAt(S.world, near.laneId, near.s, {}) : view;
        TLV.debug.teleport(p.x, p.y, p.h, 0);
        TLV.render.city.chunks.buildAround(p.x, p.y, 900);
        TLV.render.city.details.frame(S, TLV.render.city.chunks.built(), p.x, p.y, true);
        TLV.render.signs.settle(p.x, p.y);
        if (view.mode) TLV.debug.camera(view.mode);
        else TLV.debug.camera('auto');
        TLV.render.setView(view.view || null);
      }, v);
      const start = await page.evaluate(() => TLV.debug.state().tick);
      await pw.waitForTick(page, start + 40, { timeoutMs: 180000 });
      await page.evaluate(() => {
        const s = TLV.app.S;
        TLV.render.signs.settle(s.player.fx, s.player.fy);
      });
      const tick = await page.evaluate(() => TLV.debug.state().tick);
      await pw.waitForTick(page, tick + 4, { timeoutMs: 120000 });
      const file = path.join(OUT, `${v.name}.png`);
      await pw.screenshot(page, file);
      const i = await page.evaluate(() => TLV.render.info());
      const ok = i.calls <= 110 && i.mainCalls <= 72 && i.triangles <= TRIANGLES;
      if (!ok) over++;
      if (process.env.TLV_STRIP && i.calls === i.mainCalls + i.shadowCalls) throw new Error(`${v.name}: the strip is not up, so this is not the worst case`);
      console.log(`${v.name}: calls ${i.calls} (main ${i.mainCalls}, shadow ${i.shadowCalls}) triangles ${i.triangles} textures ${i.textures} ` +
        `geometries ${i.geometries} chunks ${i.chunksBuilt}/${i.chunksTotal} signs ${i.signs} ${ok ? 'in budget' : 'OVER BUDGET'} -> ${file}`);
    }
    const errs = logs.console.filter((m) => m.type === 'error').map((m) => m.text);
    console.log('console errors:', errs.length, errs.slice(0, 5).join('\n'), logs.errors.slice(0, 3).join('\n'));
  } finally {
    await browser.close();
  }
  if (over) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
