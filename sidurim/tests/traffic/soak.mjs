#!/usr/bin/env node
// tests/traffic/soak.mjs — WP-TRAFFIC
// Runs tools/soak.mjs on the real world and real traffic while WP-GAME does not exist yet. The soak's --stub flag loads a file list
// in place of everything past js/core, so this passes every real sim file that exists, the real map, and a stand-in for what does
// not: WP-PLAYER and WP-PEDS are used when they are there. Every other argument goes through unchanged. Once js/sim/game exists,
// plain tools/soak.mjs is the command, and this file has no reason to.
//
//   node tests/traffic/soak.mjs --seeds 1-20 --bots patrol,idle,chaos --n 100,120 --minutes 15 --jobs 14
//   SOAK_STUBS=1 node tests/traffic/soak.mjs ...     uses the stand-ins even if the real packages exist
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** @returns {string[]} The sim manifest, read from the file that defines it. */
function manifest() {
  const win = { TLV: { ns() { return {}; }, q: [], tune: {} } };
  const src = fs.readFileSync(path.join(ROOT, 'js/manifest.js'), 'utf8');
  vm.compileFunction(src, ['window', 'TLV'])(win, win.TLV);
  return win.TLV.manifest.sim;
}

const exists = (file) => fs.existsSync(path.join(ROOT, file));
const list = manifest();
const realPackage = (dir) => !process.env.SOAK_STUBS && list.filter((f) => f.startsWith(dir)).every(exists);
const take = (dir) => list.filter((f) => f.startsWith(dir));

const stubs = [...take('js/world/')];
stubs.push(...(realPackage('js/sim/player/') ? take('js/sim/player/') : ['tests/traffic/stubs/player_stub.js']));
stubs.push(...take('js/sim/traffic/'));
if (realPackage('js/sim/peds/')) stubs.push(...take('js/sim/peds/'));
else stubs.push('tests/traffic/stubs/peds_stub.js');
stubs.push('tests/traffic/stubs/spawn_stub.js', 'data/maps/index.js', 'data/maps/tlv_center/map.js');
console.log(`soak: ${stubs.filter((f) => f.startsWith('tests/')).join(', ')} stand in`);

const args = [path.join(ROOT, 'tools/soak.mjs'), ...process.argv.slice(2)];
for (const file of stubs) args.push('--stub', path.join(ROOT, file));
const child = spawn(process.execPath, args, { stdio: 'inherit', shell: false });
child.on('close', (code) => { process.exitCode = code === null ? 1 : code; });
