// tests/render/pack.test.mjs — WP-RENDER
import test from 'node:test';
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { packAll, readGlb, checkSidecar, imageSize } from '../../tools/pack_assets.mjs';

const TOOL = path.resolve('tools/pack_assets.mjs');

const GOOD = { source: 'own photo', credit: { author: 'Test', license: 'own', date: '2026-10' }, attest: { noLogo: true, noFaces: true } };

/** A real PNG, small enough that the tool needs no browser. */
export function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 255] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  const raw = Buffer.alloc((w * 3 + 1) * h, 120);
  for (let y = 0; y < h; y++) raw[y * (w * 3 + 1)] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

/** A GLB of `tris` triangles, with a node that moves it 10 m up. */
export function glb(tris) {
  const pos = [];
  const idx = [];
  for (let i = 0; i < tris; i++) {
    pos.push(i, 0, 0, i + 1, 0, 0, i, 1, 0);
    idx.push(i * 3, i * 3 + 1, i * 3 + 2);
  }
  const pb = Buffer.from(new Float32Array(pos).buffer);
  const ib = Buffer.from(new Uint32Array(idx).buffer);
  const bin = Buffer.concat([pb, ib]);
  const json = JSON.stringify({
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, translation: [0, 10, 0] }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1 }] }],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: pb.length }, { buffer: 0, byteOffset: pb.length, byteLength: ib.length }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: tris * 3, type: 'VEC3' },
      { bufferView: 1, componentType: 5125, count: idx.length, type: 'SCALAR' }
    ]
  });
  const pad = (4 - (json.length % 4)) % 4;
  const jb = Buffer.from(json + ' '.repeat(pad));
  const head = Buffer.alloc(12);
  head.write('glTF', 0, 'latin1');
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + jb.length + 8 + bin.length, 8);
  const cj = Buffer.alloc(8);
  cj.writeUInt32LE(jb.length, 0);
  cj.writeUInt32LE(0x4e4f534a, 4);
  const cb = Buffer.alloc(8);
  cb.writeUInt32LE(bin.length, 0);
  cb.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([head, cj, jb, cb, bin]);
}

function tree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlv-pack-'));
  for (const k of ['storefronts', 'landmarks', 'tiles', 'meshes']) fs.mkdirSync(path.join(root, 'assets_src', k), { recursive: true });
  return root;
}

function item(root, kind, id, ext, buf, side) {
  fs.writeFileSync(path.join(root, 'assets_src', kind, `${id}.${ext}`), buf);
  if (side !== undefined) fs.writeFileSync(path.join(root, 'assets_src', kind, `${id}.json`), JSON.stringify(side));
}

/** The queue item an asset file pushes. */
function pushed(file) {
  const q = [];
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { TLV: { q } });
  return q[0][1];
}

test('a credited photo packs to a data URI and into the index', async () => {
  const root = tree();
  item(root, 'storefronts', 'shop', 'png', png(64, 32), GOOD);
  const out = [];
  const r = await packAll(root, (s) => out.push(s));
  assert.deepStrictEqual(r, { packed: ['sf_shop'], refused: [] });
  const a = pushed(path.join(root, 'data/assets/sf_shop.js'));
  assert.strictEqual(a.type, 'image');
  assert.ok(a.data.startsWith('data:image/png;base64,'));
  assert.strictEqual(a.w, 64);
  const index = fs.readFileSync(path.join(root, 'data/assets/index.js'), 'utf8');
  assert.ok(index.includes('"sf_shop"') && index.includes('data/assets/sf_shop.js'));
  const row = out.find((s) => s.startsWith("TLV.q.push(['storefront'"));
  assert.ok(row.includes("asset: 'sf_shop'") && row.includes('"license":"own"'), 'the exact row is printed');
  assert.ok(!fs.readFileSync(path.join(root, 'data/assets/sf_shop.js'), 'utf8').includes('"credit"'), 'the sidecar stays out of game data');
  fs.rmSync(root, { recursive: true });
});

for (const [name, change, word] of [
  ['missing credit', (s) => { delete s.credit; }, 'credit'],
  ['missing attest', (s) => { delete s.attest; }, 'attest'],
  ['source: streetview', (s) => { s.source = 'streetview'; }, 'Google'],
  ['a Street View source in other words', (s) => { s.source = 'Google Street View capture'; }, 'Google'],
  ['a licence outside the list', (s) => { s.credit.license = 'all-rights-reserved'; }, 'licence'],
  ['noLogo not attested', (s) => { s.attest.noLogo = false; }, 'noLogo']
]) {
  test(`the tool refuses ${name}, and writes nothing for it`, async () => {
    const root = tree();
    const side = JSON.parse(JSON.stringify(GOOD));
    change(side);
    item(root, 'storefronts', 'bad', 'png', png(16, 16), side);
    const r = await packAll(root, () => {});
    assert.deepStrictEqual(r.packed, []);
    assert.strictEqual(r.refused.length, 1);
    assert.ok(r.refused[0].reason.includes(word), r.refused[0].reason);
    assert.ok(!fs.existsSync(path.join(root, 'data/assets/sf_bad.js')));
    fs.rmSync(root, { recursive: true });
  });
}

test('a picture with no sidecar is refused', async () => {
  const root = tree();
  item(root, 'storefronts', 'bare', 'png', png(16, 16));
  const r = await packAll(root, () => {});
  assert.strictEqual(r.refused.length, 1);
  fs.rmSync(root, { recursive: true });
});

test('the command line exits non-zero on a refusal', () => {
  const root = tree();
  const side = JSON.parse(JSON.stringify(GOOD));
  side.source = 'streetview';
  item(root, 'storefronts', 'bad', 'png', png(16, 16), side);
  const run = spawnSync(process.execPath, [TOOL, '--root', root], { encoding: 'utf8' });
  assert.strictEqual(run.status, 1);
  assert.ok(run.stdout.includes('REFUSED'));
  fs.rmSync(root, { recursive: true });
});

test('a GLB reads to tlvmesh, with node transforms applied', async () => {
  const m = readGlb(glb(2));
  assert.strictEqual(m.vertices, 6);
  assert.strictEqual(m.indices, 6);
  const f = new Float32Array(m.block.buffer, m.block.byteOffset, m.vertices * 8);
  assert.strictEqual(f[1], 10, 'the node moved it up');
  assert.strictEqual(m.block.length, 6 * 8 * 4 + 6 * 4);
  const root = tree();
  const side = { ...GOOD, attest: { noLogo: true } };
  item(root, 'landmarks', 'box', 'glb', glb(4), side);
  const r = await packAll(root, () => {});
  assert.deepStrictEqual(r.packed, ['lm_box']);
  const a = pushed(path.join(root, 'data/assets/lm_box.js'));
  assert.strictEqual(a.type, 'tlvmesh');
  assert.strictEqual(a.meta.vertices, 12);
  fs.rmSync(root, { recursive: true });
});

test('a mesh over 20k triangles is refused', async () => {
  const root = tree();
  item(root, 'meshes', 'huge', 'glb', glb(20001), { ...GOOD, attest: { noLogo: true } });
  const r = await packAll(root, () => {});
  assert.ok(r.refused[0].reason.includes('20000'), r.refused[0].reason);
  fs.rmSync(root, { recursive: true });
});

test('imageSize reads PNG headers, and checkSidecar passes a good sidecar', () => {
  assert.deepStrictEqual(imageSize(png(7, 9)), { w: 7, h: 9 });
  assert.doesNotThrow(() => checkSidecar(GOOD, true));
});
