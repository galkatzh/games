#!/usr/bin/env node
// tools/pack_assets.mjs — WP-RENDER
// Packs hand originals from assets_src/ into data/assets/<assetId>.js, as data URIs, because a sibling image on file:// cannot
// reach WebGL (ARCHITECTURE 14.1, 14.8). No third-party dependencies. Run: node tools/pack_assets.mjs [--root DIR]
//
// Input: assets_src/<kind>/<id>.<ext> beside assets_src/<kind>/<id>.json, which holds { source, credit, attest }.
// Refuses an item with no source, no credit, no attest, a licence outside own/cc0/cc-by-sa, or a file name or sidecar that names Google
// or Street View. Those are checks of what the author wrote, and nothing reads the image. The sidecar is tool input: credit and attest
// appear in the printed registry row, and never in the packed file. Each credit also goes in data/assets/index.js, which the game always
// loads, because the credits view has to name every asset, loaded or not, and CC BY-SA requires it.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const LICENCES = ['own', 'cc0', 'cc-by-sa'];
/** Words refused outright, after fold(), wherever the file name or sidecar says them: Google's names and image hosts, and Street View. */
const REFUSED_WORDS = /google|goo\.gl|ggpht|(?<!\p{L})(?:gmaps|gsv)(?!\p{L})|street[\s._+\p{Pd}]*view|גוגל|סטריט[\s._+\p{Pd}]*ו{1,2}יו/u;
/** Cyrillic, Greek and IPA letters that read as a Latin letter of those words, each followed by that letter. */
const LOOKALIKES = new Map('аa еe оo рp ѕs іi ԍg һh нh тt мm ԝw ѵv ӏl αa εe ιi οo ρp τt νv μm ηh ωw ɡg ıi'.split(' ').map(([from, to]) => [from, to]));

const KINDS = {
  storefronts: { prefix: 'sf_', w: 512, h: 256, bytes: 80 * 1024 },
  tiles: { prefix: 'tile_', w: 256, h: 256, bytes: 40 * 1024 },
  landmarks: { prefix: 'lm_' },
  meshes: { prefix: 'mesh_' }
};

const MESH_MAX_TRIANGLES = 20000;
const MESH_MAX_TEXTURE = 1024;
const IMAGE_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };

/** Fails one item. */
class Refused extends Error {}

/** @returns {string} Text in lower case, with accents, invisible marks, full-width forms and lookalike letters taken out. */
function fold(text) {
  return text.normalize('NFKD').toLowerCase().replace(/[\p{M}\p{Cf}]/gu, '').replace(/\P{ASCII}/gu, (c) => LOOKALIKES.get(c) || c);
}

/** @returns {string[]} Every key and string in a parsed sidecar, each on its own so that two fields never read as one phrase. */
function sidecarText(value) {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).flatMap(([key, v]) => [key, ...sidecarText(v)]);
}

/**
 * Checks a sidecar, and the name of the file it belongs to.
 * @param {object} side Parsed sidecar.
 * @param {boolean} photo True for images, which must also attest to having no faces.
 * @param {string} [fileName] The original's file name.
 * @throws {Refused} When the item may not ship.
 */
export function checkSidecar(side, photo, fileName = '') {
  if (!side || typeof side !== 'object') throw new Refused('no sidecar');
  if (typeof side.source !== 'string' || !fold(side.source).trim()) throw new Refused('source must be text that says where the item came from');
  const named = [fileName, ...sidecarText(side)].find((text) => REFUSED_WORDS.test(fold(text)));
  if (named !== undefined) {
    throw new Refused(`"${named}" names Google or Street View: Google imagery may not be packed. Use OSM, Mapillary (CC BY-SA) or your own photos`);
  }
  if (!side.credit || typeof side.credit !== 'object') throw new Refused('missing credit');
  if (!side.credit.author) throw new Refused('credit has no author');
  if (!LICENCES.includes(side.credit.license)) throw new Refused(`licence "${side.credit.license}" is not one of ${LICENCES.join(', ')}`);
  if (!side.attest || typeof side.attest !== 'object') throw new Refused('missing attest');
  if (side.attest.noLogo !== true) throw new Refused('attest.noLogo must be true: no real logos ship');
  if (photo && side.attest.noFaces !== true) throw new Refused('attest.noFaces must be true');
}

/** @returns {{w:number,h:number}|null} Size from a PNG or JPEG header. */
export function imageSize(buf) {
  if (buf.length > 24 && buf.readUInt32BE(0) === 0x89504e47) return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) {
        i++;
        continue;
      }
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

/** Resizes in headless Chromium, cover-cropped to the target, stepping JPEG quality down to the byte target. */
async function resizeInChromium(buf, mime, target) {
  const require = createRequire(import.meta.url);
  const pw = require(path.join(PROJECT_ROOT, 'tools/lib/pw.cjs'));
  const { browser, page } = await pw.open({ goto: false });
  try {
    const url = await page.evaluate(async ({ uri, w, h, bytes }) => {
      const img = new Image();
      img.src = uri;
      await img.decode();
      const cv = document.createElement('canvas');
      cv.width = w;
      cv.height = h;
      const k = Math.max(w / img.width, h / img.height);
      const sw = w / k, sh = h / k;
      cv.getContext('2d').drawImage(img, (img.width - sw) / 2, (img.height - sh) / 2, sw, sh, 0, 0, w, h);
      let out = '';
      for (let q = 0.85; q >= 0.35; q -= 0.1) {
        out = cv.toDataURL('image/jpeg', q);
        if (out.length * 0.75 <= bytes) break;
      }
      return out;
    }, { uri: `data:${mime};base64,${buf.toString('base64')}`, w: target.w, h: target.h, bytes: target.bytes });
    return { mime: 'image/jpeg', data: Buffer.from(url.split(',')[1], 'base64') };
  } finally {
    await browser.close();
  }
}

/** Reads one accessor into a plain array of numbers. */
function readAccessor(gltf, bin, index) {
  const acc = gltf.accessors[index];
  const view = gltf.bufferViews[acc.bufferView];
  const comps = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[acc.type];
  const size = { 5120: 1, 5121: 1, 5122: 2, 5123: 2, 5125: 4, 5126: 4 }[acc.componentType];
  if (!comps || !size) throw new Refused(`accessor ${index} has an unknown type`);
  const stride = view.byteStride || comps * size;
  const base = (view.byteOffset || 0) + (acc.byteOffset || 0);
  const out = new Array(acc.count * comps);
  for (let i = 0; i < acc.count; i++) {
    for (let c = 0; c < comps; c++) {
      const o = base + i * stride + c * size;
      let v;
      switch (acc.componentType) {
        case 5120: v = bin.readInt8(o); break;
        case 5121: v = bin.readUInt8(o); break;
        case 5122: v = bin.readInt16LE(o); break;
        case 5123: v = bin.readUInt16LE(o); break;
        case 5125: v = bin.readUInt32LE(o); break;
        default: v = bin.readFloatLE(o);
      }
      out[i * comps + c] = v;
    }
  }
  return out;
}

/** 4x4 column-major multiply. */
function mul(a, b) {
  const r = new Array(16).fill(0);
  for (let c = 0; c < 4; c++) for (let row = 0; row < 4; row++) for (let k = 0; k < 4; k++) r[c * 4 + row] += a[k * 4 + row] * b[c * 4 + k];
  return r;
}

/** Node transform as a matrix. */
function nodeMatrix(n) {
  if (n.matrix) return n.matrix;
  const t = n.translation || [0, 0, 0];
  const s = n.scale || [1, 1, 1];
  const [x, y, z, w] = n.rotation || [0, 0, 0, 1];
  return [
    (1 - 2 * (y * y + z * z)) * s[0], (2 * (x * y + z * w)) * s[0], (2 * (x * z - y * w)) * s[0], 0,
    (2 * (x * y - z * w)) * s[1], (1 - 2 * (x * x + z * z)) * s[1], (2 * (y * z + x * w)) * s[1], 0,
    (2 * (x * z + y * w)) * s[2], (2 * (y * z - x * w)) * s[2], (1 - 2 * (x * x + y * y)) * s[2], 0,
    t[0], t[1], t[2], 1
  ];
}

/**
 * Hand-written GLB reader. Flattens the default scene into one interleaved mesh.
 * @param {Buffer} buf GLB file.
 * @returns {{vertices:number, indices:number, block:Buffer, texture:?string}} tlvmesh parts.
 */
export function readGlb(buf) {
  if (buf.length < 20 || buf.toString('latin1', 0, 4) !== 'glTF') throw new Refused('not a GLB file');
  if (buf.readUInt32LE(4) !== 2) throw new Refused('only glTF 2 is read');
  const jsonLen = buf.readUInt32LE(12);
  if (buf.readUInt32LE(16) !== 0x4e4f534a) throw new Refused('GLB has no JSON chunk first');
  const gltf = JSON.parse(buf.toString('utf8', 20, 20 + jsonLen));
  const binStart = 20 + jsonLen;
  const bin = binStart + 8 <= buf.length ? buf.subarray(binStart + 8, binStart + 8 + buf.readUInt32LE(binStart)) : Buffer.alloc(0);

  const verts = [];
  const idx = [];
  const walk = (nodeId, parent) => {
    const node = gltf.nodes[nodeId];
    const m = mul(parent, nodeMatrix(node));
    if (node.mesh !== undefined) {
      for (const prim of gltf.meshes[node.mesh].primitives) {
        if (prim.mode !== undefined && prim.mode !== 4) continue;
        const pos = readAccessor(gltf, bin, prim.attributes.POSITION);
        const nrm = prim.attributes.NORMAL !== undefined ? readAccessor(gltf, bin, prim.attributes.NORMAL) : null;
        const uv = prim.attributes.TEXCOORD_0 !== undefined ? readAccessor(gltf, bin, prim.attributes.TEXCOORD_0) : null;
        const count = pos.length / 3;
        const first = verts.length / 8;
        for (let i = 0; i < count; i++) {
          const x = pos[i * 3], y = pos[i * 3 + 1], z = pos[i * 3 + 2];
          verts.push(m[0] * x + m[4] * y + m[8] * z + m[12], m[1] * x + m[5] * y + m[9] * z + m[13], m[2] * x + m[6] * y + m[10] * z + m[14]);
          if (nrm) {
            const a = nrm[i * 3], b = nrm[i * 3 + 1], c = nrm[i * 3 + 2];
            const nx = m[0] * a + m[4] * b + m[8] * c, ny = m[1] * a + m[5] * b + m[9] * c, nz = m[2] * a + m[6] * b + m[10] * c;
            const L = Math.hypot(nx, ny, nz) || 1;
            verts.push(nx / L, ny / L, nz / L);
          } else {
            verts.push(0, 1, 0);
          }
          verts.push(uv ? uv[i * 2] : 0, uv ? uv[i * 2 + 1] : 0);
        }
        const tri = prim.indices !== undefined ? readAccessor(gltf, bin, prim.indices) : Array.from({ length: count }, (_, i) => i);
        for (const t of tri) idx.push(first + t);
      }
    }
    for (const child of node.children || []) walk(child, m);
  };
  const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  const scene = gltf.scenes ? gltf.scenes[gltf.scene || 0] : { nodes: (gltf.nodes || []).map((_, i) => i) };
  for (const n of scene.nodes || []) walk(n, identity);
  if (!idx.length) throw new Refused('GLB holds no triangles');
  if (idx.length / 3 > MESH_MAX_TRIANGLES) throw new Refused(`${idx.length / 3} triangles, the budget is ${MESH_MAX_TRIANGLES}`);

  let texture = null;
  const img = gltf.images && gltf.images[0];
  if (img && img.bufferView !== undefined) {
    const v = gltf.bufferViews[img.bufferView];
    const data = bin.subarray(v.byteOffset || 0, (v.byteOffset || 0) + v.byteLength);
    const size = imageSize(data);
    if (size && (size.w > MESH_MAX_TEXTURE || size.h > MESH_MAX_TEXTURE)) {
      throw new Refused(`texture ${size.w} x ${size.h}, the budget is ${MESH_MAX_TEXTURE}`);
    }
    texture = `data:${img.mimeType || 'image/png'};base64,${data.toString('base64')}`;
  }

  const vb = Buffer.from(new Float32Array(verts).buffer);
  const ib = Buffer.from(new Uint32Array(idx).buffer);
  return { vertices: verts.length / 8, indices: idx.length, block: Buffer.concat([vb, ib]), texture };
}

/** @returns {string} The registry row to paste into content. */
function rowFor(kind, id, assetId, side) {
  const credit = JSON.stringify(side.credit);
  const attest = JSON.stringify(side.attest);
  if (kind === 'storefronts') {
    return `TLV.q.push(['storefront', { id: '${id}', anchor: { osm: 'n...', at: [lat, lon], name: '...' }, art: { asset: '${assetId}' }, credit: ${credit}, attest: ${attest} }]);`;
  }
  if (kind === 'landmarks') {
    return `TLV.q.push(['landmark', { id: '${id}', anchor: { osm: 'w...', at: [lat, lon] }, mode: 'replace', model: { asset: '${assetId}', yawDeg: 0, scale: 1 }, credit: ${credit} }]);`;
  }
  if (kind === 'tiles') return `TLV.q.push(['kit', { slot: 'facade.tile', id: '${id}', asset: '${assetId}' }]); // credit ${credit}, attest ${attest}`;
  return `TLV.q.push(['mesh', { id: '${id}', asset: '${assetId}', fallback: 'proc:${id}', max: 500 }]); // credit ${credit}, attest ${attest}`;
}

/** Packs one image. */
async function packImage(file, buf, target) {
  const ext = path.extname(file).toLowerCase();
  let mime = IMAGE_EXT[ext];
  const size = imageSize(buf);
  if (!size) throw new Refused('unreadable image header');
  let data = buf;
  let w = size.w;
  let h = size.h;
  if (w > target.w || h > target.h || buf.length > target.bytes * 2) {
    const out = await resizeInChromium(buf, mime, target);
    data = out.data;
    mime = out.mime;
    w = target.w;
    h = target.h;
  }
  return { type: 'image', mime, w, h, data: `data:${mime};base64,${data.toString('base64')}` };
}

/** @returns {Object<string,object>} The credit of each asset that still has its sidecar, by asset id. */
function creditsOnDisk(root) {
  const out = {};
  for (const kind of Object.keys(KINDS)) {
    const dir = path.join(root, 'assets_src', kind);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      if (name.startsWith('.') || path.extname(name).toLowerCase() !== '.json') continue;
      try {
        const side = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
        if (side && side.credit) out[KINDS[kind].prefix + path.basename(name, '.json')] = side.credit;
      } catch (e) {
        if (!(e instanceof SyntaxError)) throw e;
      }
    }
  }
  return out;
}

/** Writes data/assets/index.js from the asset files on disk, so it can never drift from them. */
function writeIndex(root) {
  const dir = path.join(root, 'data/assets');
  const credits = creditsOnDisk(root);
  const rows = {};
  for (const name of fs.readdirSync(dir).sort()) {
    if (name === 'index.js' || !name.endsWith('.js')) continue;
    const id = name.slice(0, -3);
    rows[id] = { src: `data/assets/${name}`, bytes: fs.statSync(path.join(dir, name)).size, credit: credits[id] || null };
  }
  const body = JSON.stringify(rows, null, 2);
  fs.writeFileSync(path.join(dir, 'index.js'), `// data/assets/index.js — generated by tools/pack_assets.mjs. Do not edit.\nTLV.assetIndex = ${body};\n`);
  return Object.keys(rows).length;
}

/**
 * Packs every item.
 * @param {string} root Project root.
 * @param {function(string):void} log Output.
 * @returns {Promise<{packed:string[], refused:{id:string, reason:string}[]}>} What happened.
 */
export async function packAll(root, log) {
  const packed = [];
  const refused = [];
  const out = path.join(root, 'data/assets');
  fs.mkdirSync(out, { recursive: true });
  for (const kind of Object.keys(KINDS)) {
    const dir = path.join(root, 'assets_src', kind);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir).sort()) {
      const ext = path.extname(name).toLowerCase();
      if (name.startsWith('.') || ext === '.json' || name === 'README.md' || name === '.gitkeep') continue;
      const id = path.basename(name, path.extname(name));
      const file = path.join(dir, name);
      try {
        const sidecar = path.join(dir, `${id}.json`);
        if (!fs.existsSync(sidecar)) throw new Refused('no sidecar: missing credit and attest');
        const side = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
        const isMesh = ext === '.glb';
        if (!isMesh && !IMAGE_EXT[ext]) throw new Refused(`cannot pack ${ext}`);
        checkSidecar(side, !isMesh, name);
        const K = KINDS[kind];
        const assetId = K.prefix + id;
        const buf = fs.readFileSync(file);
        let item;
        if (isMesh) {
          const m = readGlb(buf);
          item = {
            id: assetId, type: 'tlvmesh', mime: 'application/x-tlvmesh', data: m.block.toString('base64'),
            meta: { vertices: m.vertices, indices: m.indices, texture: m.texture }
          };
        } else {
          if (!K.w) throw new Refused(`${kind} takes .glb only`);
          const img = await packImage(file, buf, K);
          item = { id: assetId, type: img.type, mime: img.mime, w: img.w, h: img.h, data: img.data };
        }
        fs.writeFileSync(path.join(out, `${assetId}.js`), `// ${assetId}, generated by tools/pack_assets.mjs. Do not edit.\nTLV.q.push(['asset', ${JSON.stringify(item)}]);\n`);
        packed.push(assetId);
        log(`packed ${assetId}`);
        log(rowFor(kind, id, assetId, side));
      } catch (e) {
        if (!(e instanceof Refused) && !(e instanceof SyntaxError)) throw e;
        refused.push({ id: `${kind}/${id}`, reason: e.message });
        log(`REFUSED ${kind}/${id}: ${e.message}`);
      }
    }
  }
  const n = writeIndex(root);
  log(`index: ${n} assets`);
  return { packed, refused };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--root');
  const root = at > 0 ? path.resolve(process.argv[at + 1]) : PROJECT_ROOT;
  packAll(root, (s) => console.log(s)).then((r) => {
    if (r.refused.length) process.exitCode = 1;
  }).catch((e) => {
    console.error(e);
    process.exitCode = 2;
  });
}
