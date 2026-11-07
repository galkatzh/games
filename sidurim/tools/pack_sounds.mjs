#!/usr/bin/env node
// tools/pack_sounds.mjs — WP-UI
// Packs recorded sounds from assets_src/sounds/ into data/sounds/sounds.js, as data URIs, because a sibling audio file on file://
// cannot be fetched into WebAudio. Needs ffmpeg on the PATH. Run from the project root: node tools/pack_sounds.mjs [--root DIR]
//
// Input: assets_src/sounds/<name>.json beside the original it names in `file`:
//   { file, title, source, changes, credit: { author, license, date }, cuts: { id: [fromS, toS] }, loops: { id: [fromS, toS] } }
// A cut is a one-shot: it is faded at both ends, peak-normalized and encoded as mono MP3. A loop is a held tone: the tool finds a loop
// length that is a whole number of the tone's periods, crossfades the seam, and writes exact 16-bit PCM, because MP3 padding would put
// a gap in the loop. data/sounds/index.js gets every credit, because the credits view names each sound whether it has loaded or not,
// and CC BY requires it.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export const LICENCES = ['own', 'cc0', 'cc-by-4.0', 'cc-by-sa'];
const RATE = 44100;
const FADE_IN_S = 0.004;
const FADE_OUT_S = 0.03;
const PEAK = 0.89;
const LOOP_XFADE_S = 0.012;
const MP3_KBPS = 64;

/** Fails one sidecar. */
class Refused extends Error {}

/** @returns {Float32Array} Mono samples at RATE from part of a file. */
function decode(file, from, to) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-ss', String(from), '-to', String(to), '-i', file,
    '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], { maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Refused(`ffmpeg could not read ${path.basename(file)}: ${String(r.stderr || r.error)}`);
  const b = r.stdout;
  return new Float32Array(b.buffer.slice(b.byteOffset, b.byteOffset + b.length));
}

/** Scales to PEAK. */
function normalize(x) {
  let peak = 0;
  for (let i = 0; i < x.length; i++) peak = Math.max(peak, Math.abs(x[i]));
  if (peak > 1e-6) for (let i = 0; i < x.length; i++) x[i] *= PEAK / peak;
  return x;
}

/** Fades both ends, so a cut never clicks. */
function fade(x) {
  const fi = Math.round(FADE_IN_S * RATE);
  const fo = Math.round(FADE_OUT_S * RATE);
  for (let i = 0; i < fi && i < x.length; i++) x[i] *= i / fi;
  for (let i = 0; i < fo && i < x.length; i++) x[x.length - 1 - i] *= i / fo;
  return x;
}

/** @returns {Buffer} MP3 bytes. */
function mp3(x) {
  const input = Buffer.from(x.buffer, x.byteOffset, x.byteLength);
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', '-',
    '-c:a', 'libmp3lame', '-b:a', `${MP3_KBPS}k`, '-f', 'mp3', '-'], { input, maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Refused(`ffmpeg could not encode MP3: ${String(r.stderr || r.error)}`);
  return r.stdout;
}

/** @returns {Buffer} A mono 16-bit PCM WAV. */
function wav(x) {
  const data = Buffer.alloc(x.length * 2);
  for (let i = 0; i < x.length; i++) data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(x[i] * 32767))), i * 2);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0);
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8);
  head.write('fmt ', 12);
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(RATE, 24);
  head.writeUInt32LE(RATE * 2, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36);
  head.writeUInt32LE(data.length, 40);
  return Buffer.concat([head, data]);
}

/**
 * Builds a seamless loop from a steady stretch of tone. The loop length is the lag, within the stretch, at which the tone best
 * matches itself, so the seam falls on the same point of the wave. The last LOOP_XFADE_S then crossfades into the first.
 * @param {Float32Array} x Steady samples.
 * @returns {Float32Array} One loop.
 */
export function makeLoop(x) {
  const xf = Math.round(LOOP_XFADE_S * RATE);
  const win = Math.round(0.01 * RATE);
  const minL = Math.round(x.length * 0.6);
  const maxL = x.length - xf - win;
  if (maxL <= minL) throw new Refused('a loop needs a longer stretch');
  let best = -Infinity;
  let bestL = maxL;
  for (let L = minL; L <= maxL; L++) {
    let c = 0;
    let a = 0;
    let b = 0;
    for (let j = 0; j < win; j++) {
      c += x[j] * x[L + j];
      a += x[j] * x[j];
      b += x[L + j] * x[L + j];
    }
    const score = c / (Math.sqrt(a * b) + 1e-12);
    if (score > best) {
      best = score;
      bestL = L;
    }
  }
  // Sample i of the loop is x[i], but the head blends in what follows the seam, x[L + i], so the wrap from x[L - 1] to the head is
  // a step of one sample along the tone.
  const out = new Float32Array(bestL);
  for (let i = 0; i < bestL; i++) out[i] = x[i];
  for (let i = 0; i < xf; i++) {
    const w = i / xf;
    out[i] = x[i] * w + x[bestL + i] * (1 - w);
  }
  return normalize(out);
}

/** @returns {string} A data URI. */
function uri(mime, buf) {
  return `data:${mime};base64,${buf.toString('base64')}`;
}

/** Checks a sidecar. @throws {Refused} */
export function checkSidecar(side) {
  if (!side || typeof side !== 'object') throw new Refused('no sidecar');
  if (typeof side.file !== 'string' || !side.file) throw new Refused('file must name the original');
  if (typeof side.source !== 'string' || !side.source.trim()) throw new Refused('source must say where the recording came from');
  if (!side.credit || typeof side.credit.author !== 'string' || !side.credit.author) throw new Refused('credit needs an author');
  if (!LICENCES.includes(side.credit.license)) throw new Refused(`licence must be one of ${LICENCES.join(', ')}`);
  const spans = { ...(side.cuts || {}), ...(side.loops || {}) };
  if (!Object.keys(spans).length) throw new Refused('nothing to cut');
  for (const [id, span] of Object.entries(spans)) {
    if (!/^[a-z][a-z0-9_]*$/.test(id)) throw new Refused(`bad sound id ${id}`);
    if (!Array.isArray(span) || span.length !== 2 || !(span[1] > span[0]) || span[0] < 0) throw new Refused(`bad span for ${id}`);
  }
}

/**
 * Packs every sidecar under root.
 * @param {string} root Project root.
 * @param {function(string):void} log Progress lines.
 * @returns {{packed: string[], refused: string[]}} Sound IDs packed, and sidecars refused.
 */
export function packAll(root, log) {
  const dir = path.join(root, 'assets_src', 'sounds');
  const sounds = {};
  const credits = [];
  const refused = [];
  const names = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
  for (const name of names) {
    try {
      const side = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
      checkSidecar(side);
      const file = path.join(dir, side.file);
      if (!fs.existsSync(file)) throw new Refused(`no file ${side.file}`);
      const ids = [];
      for (const [id, [from, to]] of Object.entries(side.cuts || {})) {
        if (sounds[id]) throw new Refused(`sound ${id} is packed twice`);
        const bytes = mp3(normalize(fade(decode(file, from, to))));
        sounds[id] = uri('audio/mpeg', bytes);
        ids.push(id);
        log(`  ${id}: ${(to - from).toFixed(2)} s, ${bytes.length} bytes`);
      }
      for (const [id, [from, to]] of Object.entries(side.loops || {})) {
        if (sounds[id]) throw new Refused(`sound ${id} is packed twice`);
        const loop = makeLoop(decode(file, from, to));
        sounds[id] = uri('audio/wav', wav(loop));
        ids.push(id);
        log(`  ${id}: loop of ${(loop.length / RATE * 1000).toFixed(1)} ms`);
      }
      credits.push({ title: side.title || side.file, author: side.credit.author, license: side.credit.license, date: side.credit.date || '',
        source: side.source.split(/\s/)[0], changes: typeof side.changes === 'string' ? side.changes : '', sounds: ids });
      log(`packed ${name}: ${ids.join(', ')}`);
    } catch (e) {
      if (!(e instanceof Refused) && !(e instanceof SyntaxError)) throw e;
      refused.push(name);
      log(`REFUSED ${name}: ${e.message}`);
    }
  }
  const out = path.join(root, 'data', 'sounds');
  fs.mkdirSync(out, { recursive: true });
  const head = '// generated by tools/pack_sounds.mjs from assets_src/sounds. Do not edit.\n';
  fs.writeFileSync(path.join(out, 'sounds.js'), `${head}TLV.sounds = ${JSON.stringify(sounds, null, 1)};\n`);
  fs.writeFileSync(path.join(out, 'index.js'),
    `${head}TLV.soundIndex = ${JSON.stringify({ src: 'data/sounds/sounds.js', ids: Object.keys(sounds), credits }, null, 2)};\n`);
  return { packed: Object.keys(sounds), refused };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const at = process.argv.indexOf('--root');
  const root = at > 0 ? path.resolve(process.argv[at + 1]) : PROJECT_ROOT;
  const r = packAll(root, (line) => console.log(line));
  console.log(`${r.packed.length} sounds packed, ${r.refused.length} refused`);
  process.exit(r.refused.length ? 1 : 0);
}
