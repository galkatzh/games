// tools/lib/classic.mjs — WP-CORE
// Loads the game's classic scripts in Node (ARCHITECTURE 5). Files are compiled in the main realm, never in a vm context:
// a context makes Math lookups 33 times slower, and its objects fail deepStrictEqual against test literals.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** Node runs these five, in this order. render and ui are browser only. */
const REGISTER_ORDER = ['world', 'player', 'traffic', 'peds', 'game'];

/** Compiles one classic script as a function of (window, TLV) and runs it. */
function runScript(filename, win) {
  const src = fs.readFileSync(filename, 'utf8');
  const fn = vm.compileFunction(src, ['window', 'TLV'], { filename });
  fn(win, win.TLV);
}

/**
 * Runs each file that exists. The rest go on the returned list.
 * @returns {string[]} Relative paths that do not exist.
 */
function runFiles(root, files, win) {
  const absent = [];
  for (const file of files) {
    const filename = path.resolve(root, file);
    if (fs.existsSync(filename)) runScript(filename, win);
    else absent.push(file);
  }
  return absent;
}

/** Expands the 'sim' token. */
function expandFiles(files, manifest) {
  const list = files === undefined || files === 'sim' ? ['sim'] : files;
  return list.flatMap((f) => (f === 'sim' ? manifest.sim : [f]));
}

/** @returns {?string} The ID in the last queued map payload. */
function queuedMapId(TLV) {
  for (let i = TLV.q.length - 1; i >= 0; i--) {
    const item = TLV.q[i];
    if (Array.isArray(item) && item[0] === 'map') return item[1].id;
  }
  return null;
}

/** @returns {boolean} True when a map option is a script path, not a map ID. */
function isMapPath(map) {
  return map.includes('/') || map.endsWith('.js');
}

/** @returns {*} A key the object itself holds, else undefined. A map ID is any string: 'constructor' must not find Object's. */
function own(obj, key) {
  return obj && Object.prototype.hasOwnProperty.call(obj, key) ? obj[key] : undefined;
}

/** @returns {string} The script holding a map: a path as given, else the map index entry, else the importer's path. */
function mapScript(map, TLV) {
  if (isMapPath(map)) return map;
  const entry = own(TLV.mapIndex && TLV.mapIndex.maps, map);
  return entry ? entry.src : `data/maps/${map}/map.js`;
}

/**
 * Picks the map to load. params.map is the same request as ?map=, so it is honoured with or without a files array, and,
 * as in config.normalize, empty means unset.
 * @returns {?string} Map ID or path, or null for no map.
 */
function chooseMap(opts, explicit) {
  if (opts.map !== undefined) return opts.map;
  const requested = opts.params && opts.params.map;
  if (requested) return String(requested);
  return explicit ? null : 'tlv_center';
}

/**
 * Loads the game's sim code into a fresh, independent TLV.
 * @param {object} [opts]
 * @param {string} [opts.root] Project root. Default: resolved from this file.
 * @param {'sim'|string[]} [opts.files] Default 'sim', meaning TLV.manifest.sim. An array may contain the token 'sim'.
 * @param {?string} [opts.map] Map ID, or a path such as 'tests/fixtures/mini_map.js'. Default params.map, else 'tlv_center'.
 * @param {boolean} [opts.content] Load the content list. Default true.
 * @param {object} [opts.params] Partial params. TLV.params = TLV.config.normalize(params), and seed null becomes 1.
 * @param {boolean} [opts.allowMissing] Tolerate absent files and absent register() functions.
 *   An explicit files array implies allowMissing true, map null and content false, unless those are set. Setting
 *   params.map counts as setting the map.
 * @returns {object} TLV, after register() and drain(). TLV._missing lists the files that were absent.
 */
export function createTLV(opts = {}) {
  const root = path.resolve(opts.root || PROJECT_ROOT);
  const explicit = Array.isArray(opts.files);
  const allowMissing = opts.allowMissing !== undefined ? opts.allowMissing : explicit;
  const map = chooseMap(opts, explicit);
  const content = opts.content !== undefined ? opts.content : !explicit;

  const win = {};
  runScript(path.join(root, 'js/core/namespace.js'), win);
  runScript(path.join(root, 'js/manifest.js'), win);
  const TLV = win.TLV;

  const absent = runFiles(root, expandFiles(opts.files, TLV.manifest), win);
  if (map && !isMapPath(map)) absent.push(...runFiles(root, ['data/maps/index.js'], win));
  if (content) absent.push(...runFiles(root, ['content/index.js'], win));

  let mapId = null;
  if (map) {
    absent.push(...runFiles(root, [mapScript(map, TLV)], win));
    mapId = queuedMapId(TLV) || map;
  }
  if (content && TLV.contentFiles) {
    absent.push(...runFiles(root, own(TLV.contentFiles, mapId) || TLV.contentFiles.default, win));
  }
  if (absent.length && !allowMissing) {
    throw new Error(`createTLV: ${absent.length} files are missing under ${root}:\n  ${absent.join('\n  ')}`);
  }

  if (TLV.config) {
    TLV.params = TLV.config.normalize(opts.params);
    if (TLV.params.seed === null) TLV.params.seed = 1;
    if (mapId) TLV.params.map = mapId;
  }

  for (const pkg of REGISTER_ORDER) {
    if (TLV[pkg] && typeof TLV[pkg].register === 'function') TLV[pkg].register();
    else if (!allowMissing) throw new Error(`createTLV: TLV.${pkg}.register is missing`);
  }
  if (TLV.registry) TLV.registry.drain();

  TLV._missing = absent;
  TLV._allowMissing = allowMissing;
  return TLV;
}

/**
 * Creates a sim on the world of the loaded map, and makes it the sim that TLV.debug hooks act on.
 * @param {object} TLV From createTLV.
 * @param {object} [opts] As TLV.sim.create. world defaults to TLV.world.get(opts.map or TLV.params.map); params merge over
 *   TLV.params; allowMissing defaults to the createTLV value.
 * @returns {object} SimState.
 */
export function createSim(TLV, opts = {}) {
  const mapId = opts.map || TLV.params.map;
  const allowMissing = opts.allowMissing !== undefined ? opts.allowMissing : TLV._allowMissing;
  let world = opts.world || null;
  if (!world && mapId && TLV.world && typeof TLV.world.get === 'function') world = TLV.world.get(mapId);
  if (!world && !allowMissing) throw new Error(`createSim: no world for map ${mapId}`);

  const { map, ...rest } = opts;
  const S = TLV.sim.create({ ...rest, world, allowMissing, params: { ...TLV.params, ...opts.params } });
  TLV.debug.use(S);
  return S;
}
