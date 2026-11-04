// tests/render/city.e2e.cjs — WP-RENDER (RENDER-CITY)
// Run: node tests/render/city.e2e.cjs [--only substring]
// Proves in Chromium what Node cannot: atlas orientation, world-to-screen placement, Hebrew order, the fallback ladders, the
// load phases, teardown, and that render never touches the sim. Software GL, so nothing here asserts frame rate.
'use strict';

const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { spawnSync } = require('node:child_process');

const pw = require('../../tools/lib/pw.cjs');
const { scenario, withPage, tempDir, finish, consoleErrors } = require('../e2e/lib/harness.cjs');

const ROOT = path.resolve(__dirname, '..', '..');
const ONLY = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only') + 1] : null;
const CLEAN = '?seed=1&quality=high&hud=0&traffic=0&peds=0';

/** Boots to a paused sim with render up. */
async function ready(page) {
  await page.waitForFunction(() => window.TLV && TLV.app && TLV.app.S && TLV.render.gl && TLV.render.gl(), null, { timeout: 180000 });
  await page.evaluate(() => TLV.debug.pause());
}

/** Runs a scenario unless --only names another. */
async function run(name, fn) {
  if (ONLY && !name.includes(ONLY)) return;
  await scenario(name, fn);
}

/** A little real PNG for the pack tool, solid rgb. */
function png(w, h, rgb) {
  const crcT = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (b) => {
    let c = 0xffffffff;
    for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (t, d) => {
    const L = Buffer.alloc(4);
    L.writeUInt32BE(d.length);
    const body = Buffer.concat([Buffer.from(t, 'latin1'), d]);
    const S = Buffer.alloc(4);
    S.writeUInt32BE(crc(body));
    return Buffer.concat([L, body, S]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head[8] = 8;
  head[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    const o = y * (w * 3 + 1);
    raw[o] = 0;
    for (let x = 0; x < w; x++) {
      raw[o + 1 + x * 3] = rgb[0];
      raw[o + 2 + x * 3] = rgb[1];
      raw[o + 3 + x * 3] = rgb[2];
    }
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A 20 x 20 x 40 m box as a GLB, origin on the ground. */
function boxGlb() {
  const a = 10, h = 40;
  const P = [[-a, 0, -a], [a, 0, -a], [a, 0, a], [-a, 0, a], [-a, h, -a], [a, h, -a], [a, h, a], [-a, h, a]];
  const F = [[0, 4, 5], [0, 5, 1], [1, 5, 6], [1, 6, 2], [2, 6, 7], [2, 7, 3], [3, 7, 4], [3, 4, 0], [4, 7, 6], [4, 6, 5]];
  const pb = Buffer.from(new Float32Array(P.flat()).buffer);
  const ib = Buffer.from(new Uint32Array(F.flat()).buffer);
  const bin = Buffer.concat([pb, ib]);
  const json = JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ mesh: 0 }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }], buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pb.length }, { buffer: 0, byteOffset: pb.length, byteLength: ib.length }],
    accessors: [{ bufferView: 0, componentType: 5126, count: 8, type: 'VEC3' }, { bufferView: 1, componentType: 5125, count: F.length * 3, type: 'SCALAR' }]
  });
  const jb = Buffer.from(json + ' '.repeat((4 - (json.length % 4)) % 4));
  const H = Buffer.alloc(12);
  H.write('glTF', 0, 'latin1');
  H.writeUInt32LE(2, 4);
  H.writeUInt32LE(28 + jb.length + bin.length, 8);
  const J = Buffer.alloc(8);
  J.writeUInt32LE(jb.length, 0);
  J.writeUInt32LE(0x4e4f534a, 4);
  const B = Buffer.alloc(8);
  B.writeUInt32LE(bin.length, 0);
  B.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([H, J, jb, B, bin]);
}

/** Saves the canvas alone, because the title screen covers it in these clean runs. */
async function canvasShot(page, name) {
  const url = await page.evaluate(() => {
    TLV.render.drawNow();
    return document.getElementById('game').toDataURL('image/png');
  });
  const dir = process.env.TLV_SHOTS || path.join(os.tmpdir(), 'tlv-e2e-shots');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${name}.png`), Buffer.from(url.split(',')[1], 'base64'));
}

/** Copies the game, without what it does not read. */
function copyTree() {
  const dest = tempDir('city');
  fs.cpSync(ROOT, dest, {
    recursive: true,
    filter: (src) => !['docs', 'tests', path.join('tools', 'cache'), path.join('tools', 'reports')].includes(path.relative(ROOT, src))
  });
  return dest;
}

async function main() {
  await run('atlas orientation: an asymmetric pattern comes back the right way up', async () => {
    await withPage({ params: CLEAN }, async ({ page }) => {
      await ready(page);
      const got = await page.evaluate(() => {
        const atlas = TLV.render.signs.atlas();
        const slot = atlas.claim('flipy-test');
        const c = atlas.ctx;
        c.setTransform(1, 0, 0, 1, 0, 0);
        const W2 = atlas.slotW, H2 = atlas.slotH;
        c.fillStyle = '#ff0000'; c.fillRect(0, 0, W2 / 2, H2 / 2);       // top left red
        c.fillStyle = '#00ff00'; c.fillRect(W2 / 2, 0, W2 / 2, H2 / 2);  // top right green
        c.fillStyle = '#0000ff'; c.fillRect(0, H2 / 2, W2 / 2, H2 / 2);  // bottom left blue
        c.fillStyle = '#ffffff'; c.fillRect(W2 / 2, H2 / 2, W2 / 2, H2 / 2);
        atlas.commit(slot, true);
        const r = new Float32Array(4);
        atlas.rect(slot, r, 0);
        const gl = TLV.render.gl();
        const scene = new THREE.Scene();
        const mat = new THREE.ShaderMaterial({
          uniforms: { t: { value: atlas.tex }, r: { value: new THREE.Vector4(r[0], r[1], r[2], r[3]) } },
          vertexShader: 'varying vec2 u; void main(){ u = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }',
          fragmentShader: 'uniform sampler2D t; uniform vec4 r; varying vec2 u; void main(){ vec2 q = vec2(mix(r.x, r.z, u.x), mix(r.w, r.y, u.y)); gl_FragColor = textureLod(t, q, 0.0); }',
          depthTest: false
        });
        const q = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
        q.frustumCulled = false;
        scene.add(q);
        const tm = gl.toneMapping;
        gl.toneMapping = THREE.NoToneMapping;
        gl.setRenderTarget(null);
        gl.render(scene, new THREE.Camera());
        gl.toneMapping = tm;
        const ctx = gl.getContext();
        const W = ctx.drawingBufferWidth, H = ctx.drawingBufferHeight;
        const px = new Uint8Array(4);
        const read = (x, y) => {
          ctx.readPixels(x, y, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
          return [px[0] > 128 ? 1 : 0, px[1] > 128 ? 1 : 0, px[2] > 128 ? 1 : 0];
        };
        return {
          topLeft: read(W >> 2, (H >> 2) * 3), topRight: read((W >> 2) * 3, (H >> 2) * 3),
          bottomLeft: read(W >> 2, H >> 2), bottomRight: read((W >> 2) * 3, H >> 2), vTop: r[1], vBottom: r[3]
        };
      });
      assert.deepStrictEqual(got.topLeft, [1, 0, 0]);
      assert.deepStrictEqual(got.topRight, [0, 1, 0]);
      assert.deepStrictEqual(got.bottomLeft, [0, 0, 1]);
      assert.deepStrictEqual(got.bottomRight, [1, 1, 1]);
      assert.ok(got.vTop < got.vBottom, 'with flipY false the top of a slot has the smaller v');
    });
  });

  await run('coordinates: a marker lands where the world says, and faces its heading', async () => {
    await withPage({ params: CLEAN }, async ({ page }) => {
      await ready(page);
      const got = await page.evaluate(() => {
        const C = TLV.render.coords;
        // Camera 40 m south of the marker, looking north, so east is screen right and up is screen up.
        const mx = -100, my = 300;
        TLV.render.setView({ x: mx, y: my - 40, z: 6, lookX: mx, lookY: my, lookZ: 6, fov: 60, buildR: 10 });
        TLV.render.drawNow();
        const out = {};
        const p = (x, y, z) => TLV.render.project(x, y, z, { sx: 0, sy: 0, visible: false });
        const c = p(mx, my, 6);
        out.centre = [Math.round(c.sx), Math.round(c.sy), c.visible];
        out.east = p(mx + 5, my, 6).sx - c.sx;
        out.north = p(mx, my + 20, 0).sy - p(mx, my, 0).sy;
        out.up = p(mx, my, 9).sy - c.sy;
        // A model with forward +X at heading h: its nose must sit at (cos h, sin h).
        const h = 0.7;
        const m = new THREE.Object3D();
        C.toThree(mx, my, 0, m.position);
        m.rotation.y = C.yaw(h);
        m.updateMatrixWorld(true);
        const nose = m.localToWorld(new THREE.Vector3(2, 0, 0));
        const w = C.fromThree(nose, { x: 0, y: 0, z: 0 });
        out.nose = [w.x - mx, w.y - my, w.z];
        const back = C.toThree(1, 2, 3, { x: 0, y: 0, z: 0 });
        out.frame = [back.x, back.y, back.z];
        // A red box at the marker shows at the projected pixel.
        const box = new THREE.Mesh(new THREE.BoxGeometry(4, 12, 4), new THREE.MeshBasicMaterial({ color: 0xff0000, fog: false, toneMapped: false, depthTest: false }));
        box.renderOrder = 100;      // A street tree may stand in the way; this test is about where, not what is in front
        C.toThree(mx, my, 6, box.position);
        TLV.render.scene().add(box);
        TLV.render.drawNow();
        const gl = TLV.render.gl().getContext();
        const px = new Uint8Array(4);
        const ratio = TLV.render.gl().getPixelRatio();
        gl.readPixels(Math.round(c.sx * ratio), Math.round(gl.drawingBufferHeight - c.sy * ratio), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
        out.pixel = Array.from(px);
        TLV.render.scene().remove(box);
        return out;
      });
      assert.deepStrictEqual(got.centre, [640, 360, true], 'centre of a 1280 x 720 view');
      assert.ok(got.east > 0, 'east is screen right');
      assert.ok(got.up < 0, 'up is screen up');
      assert.ok(got.north < 0, 'a point further north on the ground line rises on a camera looking down it');
      assert.ok(Math.abs(got.nose[0] - 2 * Math.cos(0.7)) < 1e-6 && Math.abs(got.nose[1] - 2 * Math.sin(0.7)) < 1e-6 && got.nose[2] === 0);
      assert.deepStrictEqual(got.frame, [1, 3, -2], 'world x, z, -y (section 1.4)');
      assert.ok(got.pixel[0] > 200 && got.pixel[1] < 60 && got.pixel[2] < 60, `pixel ${got.pixel}`);
    });
  });

  await run('Hebrew reads right to left on a sign board', async () => {
    await withPage({ params: CLEAN }, async ({ page }) => {
      await ready(page);
      const got = await page.evaluate(() => {
        const paint = (he) => {
          const cv = document.createElement('canvas');
          cv.width = 256;
          cv.height = 64;
          const c = cv.getContext('2d', { willReadFrequently: true });
          TLV.render.signs.paintBoard(c, 256, 64, { he, en: '', seed: 0, aspect: 4, board: ['#ffffff', '#000000'] });
          return c;
        };
        const half = (c, right) => c.getImageData(right ? 128 : 0, 8, 128, 48).data;
        const same = (a, b) => {
          let diff = 0;
          for (let i = 0; i < a.length; i += 4) diff += Math.abs(a[i] - b[i]);
          return diff;
        };
        // Alef then bet, as stored. In reading order alef must be on the right.
        const ab = paint('א ב'), aa = paint('א א'), bb = paint('ב ב');
        return {
          rightIsAlef: same(half(ab, true), half(aa, true)) < same(half(ab, true), half(bb, true)),
          leftIsBet: same(half(ab, false), half(bb, false)) < same(half(ab, false), half(aa, false))
        };
      });
      assert.deepStrictEqual(got, { rightIsAlef: true, leftIsBet: true });
    });
  });

  await run('load phases: 9 chunks at init, the rest in the background within budget', async () => {
    await withPage({ params: CLEAN }, async ({ page, logs }) => {
      await ready(page);
      const got = await page.evaluate(() => {
        const first = TLV.render.info();
        const counts = [];
        const slices = [];
        let worst = 0;
        // Frames with no draw: only the background slice, so this runs the whole spiral quickly.
        const C = TLV.render.city.chunks;
        let n = 0;
        while (C.stats().built < C.stats().total && n++ < 20000) {
          C.frame(0, 0, 0, 0);
          worst = Math.max(worst, C.stats().lastMs);
          slices.push(C.stats().lastMs);
          if (n % 50 === 0) counts.push(C.stats().built);
        }
        // A chunk's sphere comes from a plain loop for speed. It has to be the sphere three would have worked out.
        let spheres = 0;
        C.built().forEach((c) => {
          [c.ground, c.shell].forEach((m) => {
            if (!m) return;
            const g = m.geometry;
            const made = g.boundingSphere;
            g.boundingSphere = null;
            g.computeBoundingSphere();
            const same = made.center.equals(g.boundingSphere.center) && made.radius === g.boundingSphere.radius;
            g.boundingSphere = made;
            if (same) spheres++;
            else spheres = -1e9;
          });
        });
        slices.sort((a, b) => a - b);
        const median = slices[slices.length >> 1];
        const budget = TLV.tune.render.sliceMs - TLV.tune.render.sliceGuardMs;
        for (let i = 0; i < 3; i++) C.frame(0, 0, 0, 0);
        const middle = TLV.render.drawNow();
        // A jump across the map: the far side comes back on demand, and nothing is left missing.
        C.frame(0, 0, 1800, 2400);
        const away = C.stats().residentBytes;
        TLV.render.setView({ x: 1800, y: 2400, z: 3, lookX: 1800, lookY: 2500, lookZ: 3, buildR: 10 });
        const there = TLV.render.drawNow();
        return { first, n, worst, median, budget, spheres, total: C.stats(), middle, away, there };
      });
      assert.ok(got.first.chunksBuilt >= 9, `${got.first.chunksBuilt} built once the loop started`);
      assert.strictEqual(got.total.built, got.total.total);
      assert.ok(got.total.total >= 120 && got.total.total <= 142, `${got.total.total} chunks`);
      assert.ok(got.spheres >= got.total.total, `${got.spheres} bounding spheres as three makes them`);
      assert.ok(got.middle.chunkVertexMB <= 40, `${got.middle.chunkVertexMB} MB of chunk vertex buffers`);
      assert.ok(got.there.triangles > 1000);
      // The worst slice is the machine's as much as the build's: a bare 2.8 ms wait overruns 4 ms on 4-8% of tries under load here.
      // The median is not. It sat at 2.8 under a load of 30 on 16 cores, and at 3.9 before slices kept any room.
      assert.ok(got.median <= got.budget + 0.7, `median slice ${got.median} ms, for ${got.budget} ms of steps`);
      assert.deepStrictEqual(consoleErrors(logs), []);
      console.log(`      init ${Math.round(got.first.initMs)} ms, ${got.first.chunksBuilt} chunks; ${got.total.total} in ${got.n} slices, median slice ${got.median.toFixed(1)} ms, worst ${got.worst.toFixed(1)} ms; ` +
        `chunk vertex buffers ${got.middle.chunkVertexMB.toFixed(1)} MB in the middle of the map, ${(got.away / 1048576).toFixed(1)} MB after a jump`);
    });
  });

  await run('a car at top speed never reaches the unbuilt city, from the first frame after boot', async () => {
    await withPage({ params: '?seed=1&quality=low&hud=0&traffic=0&peds=0' }, async ({ page, logs }) => {
      await ready(page);
      const got = await page.evaluate(() => {
        const C = TLV.render.city.chunks;
        const S = TLV.app.S;
        const b = S.world.bounds;
        const x0 = S.player.fx, y0 = S.player.fy;
        const FPS = 20;       // A slow machine
        const V = TLV.tune.player.topSpeed;
        // The farthest corner, for the longest straight line there is. Each frame is one real slice and 1/20 s of road.
        let far = [b.minX, b.minY];
        for (const c of [[b.maxX, b.maxY], [b.minX, b.maxY], [b.maxX, b.minY]]) {
          if (Math.hypot(c[0] - x0, c[1] - y0) > Math.hypot(far[0] - x0, far[1] - y0)) far = c;
        }
        const L = Math.hypot(far[0] - x0, far[1] - y0);
        const ux = (far[0] - x0) / L, uy = (far[1] - y0) / L;
        let worst = Infinity;
        let frames = 0;
        while (C.stats().built < C.stats().total && frames < 20000) {
          frames++;
          const d = Math.min(L, V * frames / FPS);
          const x = x0 + ux * d, y = y0 + uy * d;
          C.frame(x, y, x - ux * 8, y - uy * 8);
          worst = Math.min(worst, C.unbuiltNear(x, y));
        }
        return { worst, frames, V, end: C.unbuiltNear(0, 0), stats: C.stats() };
      });
      assert.ok(got.frames > 50, `${got.frames} frames: the spiral has to still be running`);
      assert.strictEqual(got.stats.built, got.stats.total);
      assert.strictEqual(got.end, Infinity, 'nothing unbuilt at the end');
      assert.ok(got.worst >= 250, `an unbuilt chunk ${got.worst.toFixed(0)} m from the car`);
      assert.deepStrictEqual(consoleErrors(logs), []);
      console.log(`      ${got.frames} frames at 20 fps and ${got.V} m/s, nearest unbuilt chunk ${got.worst.toFixed(0)} m at the worst`);
    });
  });

  await run('every shell vertex names a real tile, and a cornice is plain and in the wall\'s own colour', async () => {
    await withPage({ params: CLEAN }, async ({ page, logs }) => {
      await ready(page);
      const got = await page.evaluate(() => {
        const C = TLV.render.city.chunks;
        const S = TLV.app.S;
        const W = S.world;
        const R = TLV.render.city.recipes;
        const SH = TLV.render.city.shells;
        const T = TLV.tune.render;
        const out = { verts: 0, bad: 0, cornices: 0, plain: 0, dark: 0, first: null };
        C.built().forEach((c) => {
          if (!c.shell) return;
          const inf = c.shell.geometry.attributes.aInfo;
          for (let v = 0; v < inf.count; v++) {
            const tile = inf.getX(v), vars = inf.getY(v);
            out.verts++;
            if (tile === 255 ? vars !== 1 : tile + vars > T.facadeLayers || vars < 1) {
              out.bad++;
              out.first = out.first || [c.cx, c.cy, tile, vars];
            }
          }
        });
        // Every wall's top row is the cornice where it has one. Read back from one building's own vertices.
        const id = W.blds.findIndex((b) => b.osm === 32635200);       // The Azrieli mall
        const parts = R.building(W, id, TLV.render.styles.choose(W, id));
        const buf = new SH.SBuf(4096);
        SH.add(buf, W, parts);
        for (let v = 0; v < buf.nv; v++) {
          if (Math.abs(buf.pos[v * 3 + 1] - parts.top) > 1e-3 || Math.abs(buf.nrm[v * 4 + 1]) > 8) continue;      // Top row, on a wall
          out.cornices++;
          if (buf.inf[v * 2] === 255) out.plain++;
          if ((buf.col[v] & 0xffffff) < 0x404040) out.dark++;
        }
        return out;
      });
      assert.ok(got.verts > 10000, `${got.verts} vertices`);
      assert.strictEqual(got.bad, 0, `tiles that do not exist: first at ${JSON.stringify(got.first)}`);
      assert.ok(got.cornices >= 40, `${got.cornices} cornice vertices`);
      assert.strictEqual(got.plain, got.cornices, 'a cornice carries no facade tile');
      assert.strictEqual(got.dark, 0, 'a cornice is not black');
      assert.deepStrictEqual(consoleErrors(logs), []);
    });
  });

  await run('the build slice keeps its budget by a clock the test drives: no step starts without room to finish', async () => {
    await withPage({ params: CLEAN }, async ({ page, logs }) => {
      await ready(page);
      const got = await page.evaluate(() => {
        const C = TLV.render.city.chunks;
        const T = TLV.tune.render;
        const P = window.performance;
        let clock = 0;
        let cost = 0.4;
        let entry = 0;
        let heavyAt = 0;
        let heavyCalls = 0;
        // A heavy step can only be late if the slice let it start late: this reads where in the slice each one begins.
        const watch = (o, name) => {
          const f = o[name];
          o[name] = function () {
            heavyAt = Math.max(heavyAt, clock - entry);
            heavyCalls++;
            return f.apply(this, arguments);
          };
          return () => { o[name] = f; };
        };
        const undo = [watch(TLV.world.parking, 'spotsNear'), watch(TLV.render.ground, 'mesh'), watch(TLV.render.city.shells, 'geometry')];
        P.now = () => (clock += cost);
        let worst = 0;
        let slices = 0;
        // Half the spiral at an even pace, then the rest with a step dearer than the whole slice: a slow machine has to get there too.
        const half = C.stats().total * 0.6;
        while (C.stats().built < half && slices++ < 200000) {
          entry = clock + cost;
          C.frame(0, 0, 0, 0);
          worst = Math.max(worst, C.stats().lastMs);
        }
        undo.forEach((u) => u());
        cost = T.sliceMs * 1.5;
        const before = C.stats().built;
        let slow = 0;
        let slowWorst = 0;
        while (C.stats().built < Math.min(C.stats().total, before + 2) && slow++ < 200000) {
          C.frame(0, 0, 0, 0);
          slowWorst = Math.max(slowWorst, C.stats().lastMs);
        }
        delete P.now;
        return { worst, slices, heavyAt, heavyCalls, slow, slowWorst, moved: C.stats().built - before, sliceMs: T.sliceMs, guard: T.sliceGuardMs, heavy: T.sliceHeavyMs, step: 0.4 };
      });
      assert.ok(got.slices > 100, `${got.slices} slices`);
      assert.ok(got.worst <= got.sliceMs - got.guard + got.step * 2, `slice of ${got.worst} ms at steps of ${got.step} ms`);
      assert.ok(got.heavyCalls > 50, `${got.heavyCalls} heavy steps seen`);
      assert.ok(got.heavyAt <= got.sliceMs - got.heavy + got.step, `a heavy step began ${got.heavyAt} ms into a slice`);
      assert.strictEqual(got.moved, 2, 'a machine slower than the slice still builds');
      assert.ok(got.slowWorst <= got.sliceMs * 1.5 + 1e-6, `one step a frame when a step is dearer than the slice: ${got.slowWorst} ms`);
      assert.deepStrictEqual(consoleErrors(logs), []);
      console.log(`      ${got.slices} slices at ${got.step} ms a step: worst ${got.worst.toFixed(1)} ms, latest heavy step ${got.heavyAt.toFixed(1)} ms in; ${got.slow} slices of one step when each costs ${got.slowWorst} ms`);
    });
  });

  await run('dispose then init works, and leaves no meshes behind', async () => {
    await withPage({ params: CLEAN }, async ({ page, logs }) => {
      await ready(page);
      const got = await page.evaluate(() => {
        const S = TLV.app.S;
        const old = TLV.render.gl();
        const before = old.info.memory.geometries;
        TLV.render.dispose();
        const left = old.info.memory.geometries;
        const gone = TLV.render.info().quality;
        TLV.render.init(document.getElementById('game'), S);
        return { before, left, gone, info: TLV.render.drawNow() };
      });
      console.log(`      geometries ${got.before} before dispose, ${got.left} after`);
      assert.strictEqual(got.gone, 'none');
      assert.ok(got.left <= 2, `${got.left} geometries left`);
      assert.ok(got.info.triangles > 1000);
      assert.ok(got.info.chunksBuilt >= 9);
      assert.deepStrictEqual(consoleErrors(logs), []);
    });
  });

  await run('sim hash is identical with render on and off, 3,600 ticks', async () => {
    const params = '?seed=7&notitle=1&quality=low&hud=0';
    const TARGET = 3700;     // Past the first ticks either page ran before it paused, so both reach the same tick
    const withRender = await withPage({ params }, async ({ page }) => {
      await ready(page);
      return page.evaluate((target) => {
        for (let guard = 0; TLV.debug.state().tick < target && guard < 100; guard++) {
          TLV.debug.step(Math.min(60, target - TLV.debug.state().tick));
          TLV.render.drawNow();
        }
        return { hash: TLV.debug.hash(), tick: TLV.debug.state().tick, quality: TLV.render.info().quality };
      }, TARGET);
    });
    const without = await withPage({
      params,
      before: async (page) => {
        // The same page in the same engine, with render's entry points gone, so the hashes must match exactly.
        await page.addInitScript(() => {
          const stop = setInterval(() => {
            if (window.TLV && TLV.app && TLV.app.boot && !window.__patched) {
              window.__patched = true;
              const boot = TLV.app.boot;
              TLV.app.boot = function () {
                TLV.render.register = function () {};
                TLV.render.init = function () {};
                TLV.render.frame = function () {};
                boot();
              };
              clearInterval(stop);
            }
          }, 0);
        });
      }
    }, async ({ page }) => {
      await page.waitForFunction(() => window.TLV && TLV.app && TLV.app.S && TLV.debug.state, null, { timeout: 180000 });
      return page.evaluate((target) => {
        TLV.debug.pause();
        TLV.debug.step(target - TLV.debug.state().tick);
        return { hash: TLV.debug.hash(), tick: TLV.debug.state().tick, quality: TLV.render.info().quality };
      }, TARGET);
    });
    console.log(`      render on ${withRender.hash} at ${withRender.tick}; render off ${without.hash} at ${without.tick}`);
    assert.strictEqual(withRender.quality, 'low');
    assert.strictEqual(without.quality, 'none', 'the second page really had no render');
    assert.strictEqual(without.tick, TARGET);
    assert.strictEqual(withRender.tick, TARGET);
    assert.strictEqual(without.hash, withRender.hash);
  });

  await run('quality: software GL starts on low by itself, and a quality the player asked for never moves', async () => {
    await withPage({ params: '?seed=1&notitle=1&hud=0&traffic=0&peds=0&mute=1' }, async ({ page, logs }) => {
      await ready(page);
      const got = await page.evaluate(() => {
        const gl = TLV.render.gl();
        const i = TLV.render.info();
        return { i, antialias: gl.getContext().getContextAttributes().antialias, shadows: gl.shadowMap.enabled, param: TLV.params.quality };
      });
      assert.strictEqual(got.param, 'auto');
      assert.strictEqual(got.i.quality, 'low');
      assert.strictEqual(got.i.auto, true);
      assert.strictEqual(got.antialias, false);
      assert.strictEqual(got.shadows, false);
      assert.deepStrictEqual(consoleErrors(logs), []);
    });
    for (const quality of ['low', 'high']) {
      await withPage({ params: `?seed=1&quality=${quality}&hud=0&traffic=0&peds=0&mute=1` }, async ({ page }) => {
        await ready(page);
        const got = await page.evaluate(() => {
          const before = TLV.render.gl().getPixelRatio();
          TLV.render.feedFrames(0.06, 2000);
          const slow = TLV.render.gl().getPixelRatio();
          TLV.render.feedFrames(0.008, 20000);
          return { before, slow, fast: TLV.render.gl().getPixelRatio(), i: TLV.render.info() };
        });
        assert.strictEqual(got.i.auto, false);
        assert.strictEqual(got.i.quality, quality);
        assert.strictEqual(got.slow, got.before);
        assert.strictEqual(got.fast, got.before);
      });
    }
  });

  await run('the ladder drives the real canvas: down, up, no blank frame, no layout change, and the sim hash does not move', async () => {
    const params = '?seed=7&notitle=1&hud=0';
    const TARGET = 1800;
    const walked = await withPage({ params }, async ({ page, logs }) => {
      await ready(page);
      const got = await page.evaluate((target) => {
        const gl = TLV.render.gl();
        const ctx = gl.getContext();
        const T = TLV.tune.render;
        const S = TLV.app.S;
        const box = () => { const r = ctx.canvas.getBoundingClientRect(); return `${r.width}x${r.height}`; };
        const css = box();
        TLV.render.feedFrames(0.008, 40000);
        const top = TLV.render.info().pixelRatio;
        const trace = [];
        const blank = [];
        const L = TLV.render.ladder();
        // Each rung is reached by a real frame, as in play: fed frames up to the last of a window, and then a real one that closes it.
        do TLV.render.feedFrames(0.008); while (L.sum > 0);
        for (let guard = 0; guard < 8 && L.rung < L.rungs.length - 1; guard++) {
          while (L.sum + 0.05 < T.dynResHoldS) TLV.render.feedFrames(0.05);
          const before = L.rung;
          TLV.render.frame(S, 1, 0.05);
          const px = new Uint8Array(4);
          ctx.readPixels(ctx.drawingBufferWidth >> 1, ctx.drawingBufferHeight >> 1, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
          if (px[0] + px[1] + px[2] === 0) blank.push(L.rung);
          if (L.rung === before) break;
          trace.push({ pixel: gl.getPixelRatio(), w: ctx.drawingBufferWidth, rung: L.rung });
          TLV.debug.step(100);
        }
        const floor = gl.getPixelRatio();
        // A stage that keeps changing is what a running sim would do to the ladder: hold it through ticks, and let it climb back.
        TLV.render.feedFrames(0.008, 40000);
        const back = gl.getPixelRatio();
        for (let guard = 0; TLV.debug.state().tick < target && guard < 100; guard++) {
          TLV.debug.step(Math.min(60, target - TLV.debug.state().tick));
          TLV.render.feedFrames(guard % 2 ? 0.05 : 0.008, 200);
          TLV.render.drawNow();
        }
        return { hash: TLV.debug.hash(), tick: TLV.debug.state().tick, css, cssAfter: box(), top, floor, back, trace, blank };
      }, TARGET);
      assert.deepStrictEqual(consoleErrors(logs), []);
      return got;
    });
    console.log(`      ${walked.top} to ${walked.floor} and back to ${walked.back}, ${JSON.stringify(walked.trace)}, hash ${walked.hash}`);
    assert.ok(walked.trace.length >= 2, 'a real walk down');
    assert.ok(walked.floor < walked.top);
    assert.ok(Math.abs(walked.floor - 0.6) < 1e-9, `floor ${walked.floor}`);
    assert.strictEqual(walked.back, walked.top);
    for (const t of walked.trace) assert.strictEqual(t.w, Math.floor(1280 * t.pixel), 'the drawing buffer follows the rung');
    assert.deepStrictEqual(walked.blank, [], 'the frame that resizes must draw after the resize');
    assert.strictEqual(walked.cssAfter, walked.css, 'the canvas keeps its place on the page');
    const still = await withPage({ params: params + '&quality=low' }, async ({ page }) => {
      await ready(page);
      return page.evaluate((target) => {
        for (let guard = 0; TLV.debug.state().tick < target && guard < 100; guard++) {
          TLV.debug.step(Math.min(60, target - TLV.debug.state().tick));
          TLV.render.drawNow();
        }
        return { hash: TLV.debug.hash(), tick: TLV.debug.state().tick };
      }, TARGET);
    });
    assert.strictEqual(walked.tick, TARGET);
    assert.strictEqual(still.tick, TARGET);
    assert.strictEqual(walked.hash, still.hash);
  });

  await run('a slow GPU with an honest name falls to the low rung on frame time alone, and keeps drawing', async () => {
    // Software GL standing in for a weak real GPU: it says nothing of what it is, so auto starts on high, and only the frames can tell.
    const hide = () => {
      const real = WebGL2RenderingContext.prototype.getParameter;
      WebGL2RenderingContext.prototype.getParameter = function (p) { return p === 37446 ? 'Some Laptop GPU' : real.call(this, p); };
    };
    await withPage({ params: '?seed=1&notitle=1&hud=0&mute=1&traffic=0&peds=0', init: hide }, async ({ page, logs }) => {
      await page.waitForFunction(() => window.TLV && TLV.app && TLV.app.S && TLV.render.gl && TLV.render.gl(), null, { timeout: 180000 });
      const start = await page.evaluate(() => {
        const gl = TLV.render.gl();
        return { i: TLV.render.info(), antialias: gl.getContext().getContextAttributes().antialias, shadows: gl.shadowMap.enabled };
      });
      assert.strictEqual(start.i.quality, 'high');
      assert.strictEqual(start.i.auto, true);
      assert.strictEqual(start.shadows, true);
      await page.waitForFunction(() => TLV.render.info().quality === 'low', null, { timeout: 150000, polling: 500 });
      await page.waitForFunction(() => TLV.render.info().shadowCalls === 0 && TLV.render.info().calls > 10, null, { timeout: 60000, polling: 250 });
      const end = await page.evaluate(() => new Promise((done) => {
        requestAnimationFrame(() => requestAnimationFrame(() => {
          const gl = TLV.render.gl();
          const ctx = gl.getContext();
          const i = TLV.render.info();
          TLV.render.drawNow();
          const px = new Uint8Array(4);
          ctx.readPixels(ctx.drawingBufferWidth >> 1, ctx.drawingBufferHeight >> 1, 1, 1, ctx.RGBA, ctx.UNSIGNED_BYTE, px);
          done({ i, px: Array.from(px), shadows: gl.shadowMap.enabled, cast: TLV.render.sky.light().castShadow, range: TLV.render.city.chunks.l1 && TLV.render.city.chunks.l1() });
        }));
      }));
      console.log(`      high ${start.i.pixelRatio}, then low ${end.i.pixelRatio}, ${end.i.triangles} triangles, ${end.i.calls} calls`);
      assert.ok(Math.abs(end.i.pixelRatio - 0.6) < 0.08, `pixel ratio ${end.i.pixelRatio}`);
      assert.strictEqual(end.shadows, false);
      assert.strictEqual(end.cast, false);
      assert.strictEqual(end.range, 500);
      assert.ok(end.px[0] + end.px[1] + end.px[2] > 0, 'still drawing');
      assert.deepStrictEqual(consoleErrors(logs), []);
    });
  });

  await run('fallback ladder: every rung, a registered storefront and landmark, and a removed asset', async () => {
    const tree = copyTree();
    // A photo and a model, through the pack tool, into data alone.
    const sf = path.join(tree, 'assets_src/storefronts');
    const lm = path.join(tree, 'assets_src/landmarks');
    fs.writeFileSync(path.join(sf, 'test_shop.png'), png(64, 32, [255, 0, 255]));
    fs.writeFileSync(path.join(sf, 'test_shop.json'), JSON.stringify({ source: 'own', credit: { author: 'Test', license: 'own', date: '2026-11' }, attest: { noLogo: true, noFaces: true } }));
    fs.writeFileSync(path.join(lm, 'test_box.glb'), boxGlb());
    fs.writeFileSync(path.join(lm, 'test_box.json'), JSON.stringify({ source: 'own', credit: { author: 'Test', license: 'own', date: '2026-11' }, attest: { noLogo: true } }));
    const pack = spawnSync(process.execPath, ['tools/pack_assets.mjs'], { cwd: tree, encoding: 'utf8' });
    assert.strictEqual(pack.status, 0, pack.stdout + pack.stderr);
    fs.appendFileSync(path.join(tree, 'content/tlv_center/storefronts.js'), `
TLV.q.push(['storefront', { id: 'ext_cafe', anchor: { osm: 'n2142643229', at: [32.0725, 34.7784], name: 'Cafe Bar HaBima' },
  art: { asset: 'sf_test_shop' }, sign: { text: { he: 'קפה ניסיון', en: 'Test Cafe' } },
  credit: { author: 'Test', license: 'own', date: '2026-11' }, attest: { noLogo: true, noFaces: true } }]);
TLV.q.push(['landmark', { id: 'ext_tower', anchor: { osm: 'w149522836', at: [32.0728, 34.7790], name: 'Habima' }, mode: 'replace',
  style: 'glass_blue', model: { asset: 'lm_test_box', yawDeg: 0, scale: 1 }, credit: { author: 'Test', license: 'own', date: '2026-11' } }]);
`);
    const view = { x: 73.7, y: -292.5, z: 1.9, lookX: 80.7, lookY: -280.4, lookZ: 2.5, fov: 55, focusX: 85, focusY: -281 };
    const look = async (page) => page.evaluate((v) => {
      TLV.render.setView(v);
      TLV.render.signs.settle(v.focusX, v.focusY);
      const info = TLV.render.drawNow();
      return { signs: info.signs, photos: info.photos, rung: TLV.render.storefronts.resolve(TLV.app.S.world.pois[TLV.anchors.resolve(TLV.app.S.world, { osm: 'n2142643229' }, { type: 'poi' }).id]).rung };
    }, view);

    await withPage({ root: tree, params: CLEAN }, async ({ page, logs }) => {
      await ready(page);
      const models = await page.evaluate(() => {
        TLV.render.setView({ x: 100, y: -300, z: 6, lookX: 144, lookY: -242, lookZ: 20, fov: 70 });
        return true;
      });
      assert.ok(models);
      // Photo and model load on demand; give the injected scripts time.
      await page.waitForFunction(() => {
        TLV.render.drawNow();
        return TLV.render.assets.state('sf_test_shop') === 'ready' && TLV.render.landmarks.models().every((m) => m.ready);
      }, null, { timeout: 60000, polling: 300 });
      const photo = await look(page);
      assert.strictEqual(photo.rung, 0, 'loaded photo');
      assert.ok(photo.photos >= 1, 'the photo pool has it');
      await canvasShot(page, 'ladder_0_photo');
      const expected = [[1, 'curated sign'], [2, 'OSM sign'], [3, 'kind label']];
      for (const [rung, label] of expected) {
        await page.evaluate((r) => TLV.render.storefronts.force(r), rung);
        const got = await look(page);
        assert.ok(got.rung === rung, `${label}: ${got.rung}`);
        assert.ok(got.signs > 0 && got.photos === 0);
        await canvasShot(page, `ladder_${rung}`);
      }
      // Blank shopfront: no sign, the shop tile stands. Plain wall: no shop tile either.
      await page.evaluate(() => TLV.render.storefronts.force(4));
      assert.strictEqual((await look(page)).rung, 4);
      await canvasShot(page, 'ladder_4_blank');
      await page.evaluate((v) => {
        TLV.render.storefronts.force(5);
        TLV.render.city.chunks.invalidate(v.focusX, v.focusY);
        TLV.render.city.chunks.buildAround(v.focusX, v.focusY, 10);
      }, view);
      assert.strictEqual((await look(page)).rung, 5);
      await canvasShot(page, 'ladder_5_plain');
      const reg = await page.evaluate(() => ({
        problems: TLV.registry.problems(), models: TLV.render.landmarks.models(),
        hidden: TLV.render.landmarks.hidesShell(TLV.anchors.resolve(TLV.app.S.world, { osm: 'w149522836' }, { type: 'building' }).id),
        collider: TLV.world.spatial.pointInBuilding(TLV.app.S.world, 144, -242)
      }));
      assert.deepStrictEqual(reg.problems, []);
      assert.ok(reg.models.some((m) => m.id === 'ext_tower' && m.ready), 'the model is up');
      assert.strictEqual(reg.hidden, true, 'the shell gave way to it');
      assert.ok(reg.collider >= 0, 'visual replacement never changes collision');
      assert.deepStrictEqual(consoleErrors(logs), []);
    });

    // The same data with the asset files gone: the index still names them, and every load fails.
    fs.rmSync(path.join(tree, 'data/assets/sf_test_shop.js'));
    fs.rmSync(path.join(tree, 'data/assets/lm_test_box.js'));
    await withPage({ root: tree, params: CLEAN }, async ({ page, logs }) => {
      await ready(page);
      await page.evaluate(() => TLV.render.setView({ x: 100, y: -300, z: 6, lookX: 144, lookY: -242, lookZ: 20, fov: 70 }));
      await page.waitForFunction(() => {
        TLV.render.drawNow();
        return TLV.render.assets.state('sf_test_shop') === 'failed' && TLV.render.assets.state('lm_test_box') === 'failed';
      }, null, { timeout: 60000, polling: 300 });
      const got = await look(page);
      assert.strictEqual(got.rung, 1, 'falls back to the curated sign');
      const hidden = await page.evaluate(() => TLV.render.landmarks.hidesShell(TLV.anchors.resolve(TLV.app.S.world, { osm: 'w149522836' }, { type: 'building' }).id));
      assert.strictEqual(hidden, false, 'the styled footprint stays');
      const errs = consoleErrors(logs).filter((t) => !t.includes('ERR_FILE_NOT_FOUND'));
      assert.deepStrictEqual(errs, [], 'a missing asset logs only ERR_FILE_NOT_FOUND');
      assert.deepStrictEqual(logs.errors, []);
    });
  });

  await run('the small test map draws too: no coast, no landmarks, no error', async () => {
    await withPage({ params: '?seed=1&quality=low&hud=0&map=tests/fixtures/mini_map.js&mute=1' }, async ({ page, logs }) => {
      await ready(page);
      const got = await page.evaluate(() => {
        TLV.render.setView({ x: -100, y: -160, z: 40, lookX: 0, lookY: 0, lookZ: 0, fov: 60 });
        return TLV.render.drawNow();
      });
      assert.ok(got.chunksBuilt >= 1 && got.triangles > 200);
      await canvasShot(page, 'mini_map');
      assert.deepStrictEqual(consoleErrors(logs), []);
    });
  });

  await run('sign bakes stay at 4 a frame, however many are due', async () => {
    await withPage({ params: CLEAN }, async ({ page }) => {
      await ready(page);
      const got = await page.evaluate(() => {
        const out = [];
        TLV.render.city.chunks.buildAround(-200, 60, 300);
        for (let i = 0; i < 14; i++) {
          TLV.render.signs.frame(-200, 60, true);
          out.push(TLV.render.signs.info().bakes);
        }
        return out;
      });
      assert.ok(Math.max(...got) === 4, got.join(' '));
    });
  });

  await run('a context restore bakes every sign again, and none shows black while they come back', async () => {
    await withPage({ params: CLEAN }, async ({ page, logs }) => {
      await ready(page);
      await page.evaluate(() => {
        window.__pixels = () => {
          TLV.render.drawNow();
          const canvas = document.getElementById('game');
          const c = document.createElement('canvas');
          c.width = canvas.width;
          c.height = canvas.height;
          const x = c.getContext('2d', { willReadFrequently: true });
          x.drawImage(canvas, 0, 0);
          return x.getImageData(0, 0, c.width, c.height).data;
        };
        TLV.render.setView({ x: 73.7, y: -292.5, z: 1.9, lookX: 80.7, lookY: -280.4, lookZ: 2.5, fov: 55, focusX: 85, focusY: -281 });
        window.__before = window.__pixels();
      });
      const shown = await page.evaluate(() => TLV.render.drawNow().signs);
      assert.ok(shown >= 5, `a view with signs in it: ${shown}`);
      await canvasShot(page, 'signs_before_restore');
      // The page's own frames run on while the sim is paused, so the first frames are read inside the event, before one of those can bake anything.
      const steps = await page.evaluate(() => new Promise((resolve) => {
        const canvas = document.getElementById('game');
        const ext = TLV.render.gl().getContext().getExtension('WEBGL_lose_context');
        canvas.addEventListener('webglcontextlost', () => setTimeout(() => ext.restoreContext(), 100), { once: true });
        canvas.addEventListener('webglcontextrestored', () => {
          const out = [];
          for (let i = 0; i < 40; i++) {
            const before = TLV.render.signs.info().total;
            const info = TLV.render.drawNow();
            const a = TLV.render.signs.atlas();
            out.push({ baked: TLV.render.signs.info().total - before, signs: info.signs, slots: a.keys.filter(Boolean).length });
          }
          resolve(out);
        }, { once: true });
        ext.loseContext();
      }));
      // A board with no bake is not drawn, so every board on show has a slot behind it, from the first frame on.
      assert.ok(steps[0].signs <= 4, JSON.stringify(steps.slice(0, 3)));
      assert.ok(steps.every((f) => f.baked <= 4 && f.signs <= f.slots), JSON.stringify(steps));
      assert.strictEqual(steps[steps.length - 1].signs, shown, JSON.stringify(steps.slice(-3)));
      const changed = await page.evaluate(() => {
        const a = window.__before, b = window.__pixels();
        let n = 0;
        for (let i = 0; i < a.length; i += 4) {
          if (Math.abs(a[i] - b[i]) + Math.abs(a[i + 1] - b[i + 1]) + Math.abs(a[i + 2] - b[i + 2]) > 24) n++;
        }
        return n / (a.length / 4);
      });
      await canvasShot(page, 'signs_after_restore');
      assert.ok(changed < 0.0005, `the same view, sign for sign: ${changed} of the pixels moved`);
      assert.deepStrictEqual(consoleErrors(logs), []);
    });
  });

  await run('the Ayalon is ground paint and one wall mesh, over ground that was bare, and with its file gone the game is the same', async () => {
    const view = { x: 1470, y: -100, z: 70, lookX: 1470.01, lookY: -100, lookZ: 0, fov: 50 };
    const read = (page) => page.evaluate((v) => {
      TLV.debug.step(300);
      TLV.render.setView(v);
      const info = TLV.render.drawNow();
      const canvas = document.getElementById('game');
      const c = document.createElement('canvas');
      c.width = canvas.width;
      c.height = canvas.height;
      const x = c.getContext('2d', { willReadFrequently: true });
      x.drawImage(canvas, 0, 0);
      /** Mean brightness of a patch around a map point. */
      const light = (wx, wy) => {
        const at = TLV.render.project(wx, wy, 0, {});
        const k = canvas.width / canvas.clientWidth;
        const d = x.getImageData(Math.round(at.sx * k) - 2, Math.round(at.sy * k) - 2, 5, 5).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
        return sum / (d.length / 4);
      };
      return {
        calls: info.calls, triangles: info.triangles, hash: TLV.debug.hash(),
        walls: TLV.render.scene().children.filter((m) => m.isMesh && m.renderOrder === -9).length,
        lanes: light(1474, -100), bare: light(1461, -100), wall: light(1466.9, -100)
      };
    }, view);
    let full;
    await withPage({ params: CLEAN }, async ({ page, logs }) => {
      await ready(page);
      full = await read(page);
      await canvasShot(page, 'ayalon_top');
      assert.deepStrictEqual(consoleErrors(logs), []);
    });
    assert.strictEqual(full.walls, 1, 'one mesh for the walls');
    assert.ok(full.lanes < full.bare * 0.7, `asphalt where bare ground was: ${JSON.stringify(full)}`);
    assert.ok(full.wall > full.lanes * 1.3, `a concrete wall on the fence's own line: ${JSON.stringify(full)}`);

    const tree = copyTree();
    fs.rmSync(path.join(tree, 'content/tlv_center/ayalon.js'));
    await withPage({ root: tree, params: CLEAN }, async ({ page, logs }) => {
      await ready(page);
      const gone = await read(page);
      assert.strictEqual(gone.walls, 0, 'no file, no walls');
      assert.ok(gone.lanes > full.lanes * 1.3, `and bare ground: ${JSON.stringify(gone)}`);
      assert.strictEqual(gone.hash, full.hash, 'the sim cannot tell');
      assert.ok(full.calls - gone.calls <= 1, `one draw call at most: ${full.calls} against ${gone.calls}`);
      assert.ok(full.triangles - gone.triangles < 12000, `a small part of the budget: ${full.triangles} against ${gone.triangles}`);
      assert.deepStrictEqual(logs.errors, []);
    });
  });

  await run('near parked cars wear the live bodies, and the rear pass puts everything back', async () => {
    await withPage(`?seed=1&quality=high&hud=0&traffic=0&peds=0`, async ({ page }) => {
      await ready(page);
      const r = await page.evaluate(async () => {
        const S = TLV.app.S;
        const W = S.world;
        const box = {};
        let spot = null;
        for (const e of W.edges) {
          if (e.nameEn !== 'Dizengoff') continue;
          const ids = [];
          TLV.world.parking.parkedNear(S, e.px[0], e.py[0], 60, ids);
          if (ids.length >= 4) { spot = TLV.world.parking.boxOf(W, ids[0], 1, box); break; }
        }
        TLV.render.city.chunks.buildAround(spot.x, spot.y, 400);
        await new Promise((f) => requestAnimationFrame(() => requestAnimationFrame(f)));
        TLV.render.city.details.frame(S, TLV.render.city.chunks.built(), spot.x, spot.y, true);
        const counts = TLV.render.city.details.counts();
        const per = TLV.render.vehicles._counts().perBody;
        const shells = TLV.render.scene().children.filter((o) => o.isInstancedMesh && o.geometry.attributes.iLamp && o.geometry.index === null && o.count > 0 && o.geometry.attributes.iFx.array[0] === 1 && o.instanceMatrix.count === TLV.tune.render.parkedBodyCap);
        const parkedMain = counts.parked;
        const details = TLV.render.city.details;
        const T = TLV.tune.render;
        const boxesNeverShown = !details._pool('parked_rear').inst.visible;
        const yaw = TLV.render.rearview.heading(S);
        const near = [];
        TLV.world.parking.parkedNear(S, spot.x, spot.y, T.rearCarM + 4, near);
        const behind = near.map((id) => TLV.world.parking.boxOf(W, id, TLV.world.parking.state(S, id), {})).filter((b) => {
          const dx = b.x - spot.x, dy = b.y - spot.y;
          return dx * dx + dy * dy < T.rearCarM * T.rearCarM && dx * Math.cos(yaw) + dy * Math.sin(yaw) < T.rearAheadM;
        });
        const nearShell = behind.filter((b) => (b.x - spot.x) ** 2 + (b.y - spot.y) ** 2 < T.parkedBodyM ** 2).length;
        details.rearMode(true);
        const rearCount = details.counts().parked_rear;
        const rearBoxes = details._pool('parked_rear').inst.visible;
        const mainBoxes = details._pool('parked').inst.visible;
        const shellsHidden = shells.every((m) => !m.visible);
        details.rearMode(false);
        const rearBoxesAfter = details._pool('parked_rear').inst.visible;
        const mainBoxesAfter = details._pool('parked').inst.visible;
        const visibleBefore = TLV.render.scene().children.filter((o) => o.visible).length;
        const cam = TLV.render.camera.object;
        const far = cam.far;
        TLV.render.city.chunks.rearMode(true, cam);
        const during = TLV.render.scene().children.filter((o) => o.visible).length;
        TLV.render.city.chunks.rearMode(false);
        const after = TLV.render.scene().children.filter((o) => o.visible).length;
        return {
          near: (counts.shell_sedan || 0) + (counts.shell_hatch || 0) + (counts.shell_taxi || 0), shellTris: shells.map((m) => m.geometry.attributes.position.count / 3),
          per: [per.sedan, per.hatch, per.taxi], parkedMain, rearCount, shellsHidden, restored: details.counts().parked, visibleBefore, during, after, far,
          behind: behind.length, nearShell, rearBoxes, mainBoxes, rearBoxesAfter, mainBoxesAfter, boxesNeverShown
        };
      });
      assert.ok(r.near >= 4, `near shells ${r.near}`);
      for (const t of r.shellTris) assert.ok(r.per.includes(t), `a near car has ${t} triangles, a live body one of ${r.per}`);
      assert.ok(r.boxesNeverShown, 'before the strip has ever come up, its boxes are not in the main view');
      assert.ok(r.nearShell >= 1, 'a car wearing a body stands behind the lens, so this reads the case that matters');
      assert.strictEqual(r.rearCount, r.behind, 'the strip draws every parked car behind the lens as a box, those in bodies too');
      assert.ok(r.rearBoxes && !r.mainBoxes, 'its own boxes stand in for the main view\'s while it draws');
      assert.ok(!r.rearBoxesAfter && r.mainBoxesAfter, 'and the main view gets its own back');
      assert.ok(r.shellsHidden, 'the strip does not draw the shells');
      assert.strictEqual(r.restored, r.parkedMain, 'the main pass gets its count back');
      assert.strictEqual(r.after, r.visibleBefore, 'the chunks the rear pass hid come back');
      assert.ok(r.during <= r.visibleBefore);
    });
  });

  await run('each pass draws only what it can show, and hands every count back', async () => {
    await withPage({ params: '?seed=1&notitle=1&quality=high&mute=1&density=150' }, async ({ page, logs }) => {
      await pw.waitForTick(page, 30, { timeoutMs: 240000 });
      await page.evaluate(() => {
        TLV.debug.setClock(600);
        TLV.debug.setInput({ start: true, interact: true });
      });
      await page.waitForFunction(() => TLV.debug.state().phase === 'DRIVE', null, { timeout: 120000, polling: 500 });
      await page.evaluate(() => {
        TLV.debug.setInput(null);
        const S = TLV.app.S;
        const near = TLV.world.lanes.project(S.world, 49, -802, 1.3, 40, {});
        const p = TLV.world.lanes.pointAt(S.world, near.laneId, near.s, {});
        TLV.debug.teleport(p.x, p.y, p.h, 0);
        TLV.render.city.chunks.buildAround(p.x, p.y, 900);
        // Time for the traffic to come to the car, or there is nothing here to sort into passes.
        for (let i = 0; i < 40; i++) {
          TLV.debug.step(60);
          const near = S.vehicles.filter((v) => v.active && !v.isPlayer && Math.hypot(v.x - S.player.fx, v.y - S.player.fy) < 72);
          if (near.length >= 10) break;
        }
      });
      for (let i = 0; i < 6 && !await page.evaluate(() => TLV.render.rearview._state().shown); i++) {
        await page.evaluate(() => TLV.render.rearview.toggle());
        await pw.waitForTick(page, await page.evaluate(() => TLV.debug.state().tick) + 3, { timeoutMs: 60000 });
      }
      const r = await page.evaluate(() => {
        const S = TLV.app.S;
        const T = TLV.tune.render;
        const details = TLV.render.city.details;
        const gl = TLV.render.gl();
        details.frame(S, TLV.render.city.chunks.built(), S.player.fx, S.player.fy, true);
        const parked = details._pool('parked');
        const cast = details._pool('ficus_cast');
        const tree = details._pool('ficus');
        const rearBox = details._pool('parked_rear');
        const bodies = TLV.render.vehicles._bodies();
        const main = TLV.render.camera.object;
        const seen = { shadow: new Map(), main: new Map(), rear: new Map() };
        const orig = gl.renderBufferDirect;
        gl.renderBufferDirect = function (camera, scene, geometry, material, object, group) {
          const pass = camera === main ? 'main' : camera.isOrthographicCamera ? 'shadow' : 'rear';
          seen[pass].set(object, object.isInstancedMesh ? object.count : 1);
          return orig.call(gl, camera, scene, geometry, material, object, group);
        };
        TLV.render.drawNow();
        gl.renderBufferDirect = orig;
        const at = (inst, i) => {
          const m = inst.instanceMatrix.array;
          return Math.hypot(m[i * 16 + 12] - S.player.fx, -m[i * 16 + 14] - S.player.fy);
        };
        const per = Object.values(bodies).map((b) => {
          const lastRear = b.rearN ? Math.max(...Array.from({ length: b.rearN }, (_, i) => at(b.mesh, i))) : 0;
          return { rearN: b.rearN, nearN: b.nearN, fullN: b.fullN, count: b.mesh.count, lastRear, inShadow: seen.shadow.get(b.mesh), inRear: seen.rear.get(b.mesh), inMain: seen.main.get(b.mesh) };
        });
        const list = (inst, a, b) => Array.from({ length: b - a }, (_, i) => at(inst, a + i));
        const yaw = TLV.render.rearview.heading(S);
        const others = S.vehicles.filter((v) => v.active && !v.isPlayer).map((v) => {
          const dx = v.x - S.player.fx, dy = v.y - S.player.fy;
          return { d: Math.hypot(dx, dy), ahead: dx * Math.cos(yaw) + dy * Math.sin(yaw) };
        });
        return {
          wantNear: others.filter((c) => c.d < 72).length,
          wantRear: others.filter((c) => c.d < 60 && c.ahead < 8).length,
          aheadOfLens: others.filter((c) => c.d < 60 && c.ahead >= 8).length,
          strip: TLV.render.rearview._state().shown,
          fleet: TLV.render.vehicles._counts(),
          per,
          parked: { castN: parked.castN, drawN: parked.drawN, count: parked.inst.count, inShadow: seen.shadow.get(parked.inst), inMain: seen.main.get(parked.inst), inRear: seen.rear.get(parked.inst) },
          castD: list(parked.inst, 0, parked.castN),
          restD: list(parked.inst, parked.castN, parked.drawN),
          cast: { castN: cast.castN, drawN: cast.drawN, count: cast.inst.count, inShadow: seen.shadow.get(cast.inst), inMain: seen.main.get(cast.inst), inRear: seen.rear.get(cast.inst) },
          tree: { count: tree.inst.count, inShadow: seen.shadow.get(tree.inst), inMain: seen.main.get(tree.inst), inRear: seen.rear.get(tree.inst) },
          treeTris: tree.inst.geometry.attributes.position.count / 3, castTris: cast.inst.geometry.attributes.position.count / 3,
          rearBox: { count: rearBox.inst.count, inRear: seen.rear.get(rearBox.inst), inMain: seen.main.get(rearBox.inst), inShadow: seen.shadow.get(rearBox.inst) },
          rearD: list(rearBox.inst, 0, rearBox.inst.count),
          limits: { cast: T.parkedCastM, rear: T.rearCarM, lod: T.lodM }
        };
      });
      console.log(`      ${r.fleet.rearCars} of ${r.fleet.nearCars} shadow cars in the strip, ${r.aheadOfLens} near ones ahead of it; parked ${r.parked.castN} of ${r.parked.drawN} cast, ${r.rearBox.count} in the strip; ${r.cast.castN} trees cast ${r.castTris}, draw ${r.treeTris}`);
      assert.ok(r.strip, 'the strip is up');
      assert.ok(r.tree.count > 0 && r.cast.castN === r.tree.count, 'every near tree casts');
      assert.ok(r.castTris < r.treeTris / 2, 'from a smaller crown');
      assert.strictEqual(r.cast.inShadow, r.tree.count);
      assert.ok(!r.cast.inMain && !r.cast.inRear, 'the caster draws in the shadow pass alone');
      assert.strictEqual(r.cast.count, 0, 'and hands its count back');
      assert.strictEqual(r.tree.inShadow, undefined, 'the near crown stays out of the shadow pass');
      assert.strictEqual(r.tree.inMain, r.tree.count);
      assert.strictEqual(r.tree.inRear, r.tree.count);
      assert.ok(r.parked.castN > 0 && r.parked.castN < r.parked.drawN, `${r.parked.castN} of ${r.parked.drawN}`);
      assert.strictEqual(r.parked.inShadow, r.parked.castN, 'the shadow pass stops at the casters');
      assert.strictEqual(r.parked.inMain, r.parked.drawN, 'the main view draws them all');
      assert.strictEqual(r.parked.count, r.parked.drawN, 'and gets its count back');
      assert.strictEqual(r.parked.inRear, undefined, 'the strip has its own boxes');
      for (const d of r.castD) assert.ok(d < r.limits.cast + 1, `a caster at ${d}`);
      for (const d of r.restD) assert.ok(d >= r.limits.cast - 1 && d < r.limits.lod + 1, `a non-caster at ${d}`);
      assert.ok(r.rearBox.count > 0);
      assert.strictEqual(r.rearBox.inRear, r.rearBox.count);
      assert.ok(!r.rearBox.inMain && !r.rearBox.inShadow, 'nothing but the strip draws those');
      for (const d of r.rearD) assert.ok(d < r.limits.rear + 1, `a strip box at ${d}`);
      let cars = 0;
      for (const b of r.per) {
        assert.ok(b.rearN <= b.nearN && b.nearN <= b.fullN, JSON.stringify(b));
        assert.strictEqual(b.count, b.fullN, 'every body gets its count back');
        assert.ok(b.lastRear < 60.5, `a car at ${b.lastRear} in the strip`);
        if (b.nearN) assert.strictEqual(b.inShadow, b.nearN);
        if (b.rearN) assert.strictEqual(b.inRear, b.rearN);
        if (b.fullN) assert.strictEqual(b.inMain, b.fullN);
        cars += b.fullN;
      }
      assert.ok(cars >= 8, `${cars} cars`);
      assert.strictEqual(r.fleet.nearCars, r.wantNear, 'the shadow map draws every car in its reach, and no other');
      assert.strictEqual(r.fleet.rearCars, r.wantRear, 'the strip draws every near car behind the lens, and no other');
      // One frame may hold no car in some tier. Over a minute of traffic, every tier has to fill, and every frame has to add up.
      const sweep = await page.evaluate(() => {
        const S = TLV.app.S;
        const cam = TLV.render.camera.object;
        const out = { frames: 0, wrong: [], rear: 0, shadowOnly: 0, far: 0 };
        for (let i = 0; i < 60; i++) {
          TLV.debug.step(60);
          TLV.render.vehicles.frame(S, 1, 0, cam);
          const yaw = TLV.render.rearview.heading(S);
          const c = S.vehicles.filter((v) => v.active && !v.isPlayer).map((v) => {
            const dx = v.x - S.player.fx, dy = v.y - S.player.fy;
            return { d: Math.hypot(dx, dy), ahead: dx * Math.cos(yaw) + dy * Math.sin(yaw) };
          });
          const near = c.filter((v) => v.d < 72).length;
          const rear = c.filter((v) => v.d < 60 && v.ahead < 8).length;
          const got = TLV.render.vehicles._counts();
          out.frames++;
          if (got.nearCars !== near || got.rearCars !== rear) out.wrong.push({ i, got: [got.nearCars, got.rearCars], want: [near, rear] });
          // The count the strip's pass really sets, and the one it hands back.
          const on = (b) => b.mesh.count;
          const sum = (f) => Object.values(TLV.render.vehicles._bodies()).reduce((n, b) => n + f(b), 0);
          const main = sum(on);
          TLV.render.vehicles.solidPass(true);
          const inStrip = sum(on);
          TLV.render.vehicles.solidPass(false);
          if (inStrip !== rear || sum(on) !== main) out.wrong.push({ i, inStrip, rear, back: sum(on), main });
          out.rear = Math.max(out.rear, rear);
          out.shadowOnly = Math.max(out.shadowOnly, near - rear);
          out.far = Math.max(out.far, c.length - near);
        }
        return out;
      });
      console.log(`      a minute of traffic: at most ${sweep.rear} in the strip, ${sweep.shadowOnly} in the shadow map alone, ${sweep.far} in the main view alone`);
      assert.deepStrictEqual(sweep.wrong, []);
      assert.ok(sweep.rear > 0 && sweep.shadowOnly > 0 && sweep.far > 0, 'all three tiers were seen');
      assert.deepStrictEqual(consoleErrors(logs), []);
    });
  });

  await run('no WebGL2: a readable boot error and no run, whatever three falls back to', async () => {
    // Real WebGL1 from the same GPU: only the webgl2 request is refused, as it is on a browser or driver that lacks it.
    const webgl1Only = () => {
      const real = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
        return type === 'webgl2' ? null : real.call(this, type, ...rest);
      };
    };
    // auto reaches the renderer by the GPU-name probe, so it is a second route to the same check.
    for (const query of ['?seed=3&quality=low&mute=1', '?seed=3&mute=1']) {
      await withPage({ params: query, init: webgl1Only }, async ({ page, logs }) => {
        await page.waitForFunction(() => document.querySelector('.ui-error-body') || (window.TLV && TLV.app && TLV.app.loop), null, { timeout: 180000 });
        const r = await page.evaluate(() => ({
          text: (document.querySelector('.ui-error-body') || {}).textContent || null,
          kind: TLV.render.gl() ? 'renderer up' : 'no renderer',
          loop: !!TLV.app.loop,
          title: !!document.querySelector('.scr-title')
        }));
        assert.match(r.text || '', /^Boot failed: .*WebGL2/, query);
        assert.match(r.text, /browser|driver/, 'it says what to do about it');
        assert.deepStrictEqual({ kind: r.kind, loop: r.loop, title: r.title }, { kind: 'no renderer', loop: false, title: false }, 'nothing runs behind the overlay');
        assert.deepStrictEqual(consoleErrors(logs).filter((m) => /shader|Illegal use|extension is disabled/i.test(m)), [], 'no material ever compiled');
      });
    }
  });

  await run('file:// smoke: title, then DRIVE, with no console errors', async () => {
    await withPage({ params: '?seed=1&quality=low&traffic=0&peds=0&mute=1' }, async ({ page, logs }) => {
      await page.waitForFunction(() => window.TLV && TLV.app && TLV.app.S && TLV.debug.state && TLV.debug.state().phase === 'TITLE', null, { timeout: 180000 });
      await page.evaluate(() => TLV.debug.startRun && TLV.debug.startRun({}));
      await page.waitForFunction(() => {
        const s = TLV.debug.state();
        if (s.phase === 'CARD') TLV.debug.setInput({ start: true, interact: true, throttle: 1 });
        return s.phase === 'DRIVE';
      }, null, { timeout: 240000, polling: 400 });
      const phase = await page.evaluate(() => TLV.debug.state().phase);
      assert.strictEqual(phase, 'DRIVE');
      assert.deepStrictEqual(consoleErrors(logs), []);
      assert.deepStrictEqual(logs.errors, []);
    });
  });
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
}).finally(finish);
