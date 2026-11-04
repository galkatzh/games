// tests/ui/credits_pack.test.mjs — the credits view reads data/assets/index.js, so every packed asset's credit has to reach it there,
// loaded or not. The packed file itself stays free of the sidecar.
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { packAll } from '../../tools/pack_assets.mjs';

/** @returns {Buffer} Enough of a PNG for the tool's header read: signature and IHDR. */
function png(w, h) {
  const head = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const size = Buffer.alloc(8);
  size.writeUInt32BE(w, 0);
  size.writeUInt32BE(h, 4);
  return Buffer.concat([head, size, Buffer.alloc(9)]);
}

test('each credit lands in the index, and the packed file carries none of it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlv-credits-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  for (const k of ['storefronts', 'landmarks', 'tiles', 'meshes']) fs.mkdirSync(path.join(root, 'assets_src', k), { recursive: true });
  const shop = { author: 'A Photographer', license: 'cc-by-sa', date: '2026-10' };
  const tile = { author: 'Your Name', license: 'own', date: '2026-09' };
  const put = (kind, id, credit) => {
    fs.writeFileSync(path.join(root, 'assets_src', kind, `${id}.png`), png(64, 32));
    fs.writeFileSync(path.join(root, 'assets_src', kind, `${id}.json`), JSON.stringify({ source: 'mapillary', credit, attest: { noLogo: true, noFaces: true } }));
  };
  put('storefronts', 'shop', shop);
  put('tiles', 'wall', tile);
  const r = await packAll(root, () => {});
  assert.deepStrictEqual(r, { packed: ['sf_shop', 'tile_wall'], refused: [] });
  const scope = { TLV: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, 'data/assets/index.js'), 'utf8'), scope);
  assert.deepStrictEqual({ ...scope.TLV.assetIndex.sf_shop.credit }, shop);
  assert.deepStrictEqual({ ...scope.TLV.assetIndex.tile_wall.credit }, tile);
  assert.ok(!fs.readFileSync(path.join(root, 'data/assets/sf_shop.js'), 'utf8').includes('"credit"'));
  assert.ok(!fs.readFileSync(path.join(root, 'data/assets/index.js'), 'utf8').includes('noFaces'), 'the attestation stays with the tool');
});
