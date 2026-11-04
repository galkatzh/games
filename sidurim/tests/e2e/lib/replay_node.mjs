// tests/e2e/lib/replay_node.mjs — WP-CORE
// The Node half of replay.e2e.cjs: runs a sim with no render and prints its hashes. Arguments arrive through argv.
//   --root <dir> --replay <log.json>                 replays a log, with no bot
//   --root <dir> --seed <n> --ticks <n> --bot <name> plays the same bot headless
import fs from 'node:fs';
import { createSim, createTLV } from '../../../tools/lib/classic.mjs';

const args = {};
for (let i = 2; i < process.argv.length; i += 2) args[process.argv[i].slice(2)] = process.argv[i + 1];

const STUB_MAP = 'stub';

/** @returns {?string} The map the tree holds: the real one, or the stub tree's. */
function treeMap(root) {
  return fs.existsSync(`${root}/data/maps/tlv_center/map.js`) ? 'tlv_center' : STUB_MAP;
}

let S;
let TLV;
let ticks;
if (args.replay) {
  const log = JSON.parse(fs.readFileSync(args.replay, 'utf8'));
  const { header } = log;
  ticks = log.inputs.reduce((sum, run) => sum + run[0], 0);
  TLV = createTLV({ root: args.root, map: header.mapId, params: { ...header.params, autoplay: null } });
  S = createSim(TLV, { seed: header.seed, controlSource: TLV.replay.createPlayer(log) });
} else {
  ticks = Number(args.ticks);
  TLV = createTLV({ root: args.root, map: treeMap(args.root), params: { seed: Number(args.seed), notitle: 1, mute: 1, autoplay: args.bot } });
  S = createSim(TLV, {});
}
for (let i = 0; i < ticks; i++) TLV.sim.step(S);
console.log(JSON.stringify({ hash: TLV.sim.hash(S), hashFloat32: TLV.sim._hashFloat32(S), tick: S.tick }));
