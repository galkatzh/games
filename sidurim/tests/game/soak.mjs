#!/usr/bin/env node
// tests/game/soak.mjs — WP-GAME
// Runs tools/soak.mjs on every real sim package while WP-RENDER's content files do not exist. Plain tools/soak.mjs loads the whole
// content list and stops on those five files, none of which holds sim content. This passes the real files through the soak's --stub
// flag, with the two content files the sim reads. Every other argument goes through unchanged. Once WP-RENDER lands, plain
// tools/soak.mjs is the command, and this file has no reason to.
//
//   node tests/game/soak.mjs --seeds 1-20 --bots errands,braker --minutes 15 --jobs 14
// The Memory gate reads tools/soak.mjs's memory probe, one 60 sim-min job per bot: see the note there.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const win = { TLV: { ns() { return {}; }, q: [], tune: {} } };
vm.compileFunction(fs.readFileSync(path.join(ROOT, 'js/manifest.js'), 'utf8'), ['window', 'TLV'])(win, win.TLV);
const files = win.TLV.manifest.sim.filter((f) => !f.startsWith('js/core/'));
files.push('data/maps/index.js', 'data/maps/tlv_center/map.js', 'content/tlv_center/world.js', 'content/tlv_center/errands.js');

const args = [path.join(ROOT, 'tools/soak.mjs'), ...process.argv.slice(2)];
for (const file of files) args.push('--stub', path.join(ROOT, file));
const child = spawn(process.execPath, args, { stdio: 'inherit', shell: false });
child.on('close', (code) => { process.exitCode = code === null ? 1 : code; });
