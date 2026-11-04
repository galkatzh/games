// tests/render/helpers.mjs — WP-RENDER
// A Node TLV with the pure parts of the renderer and the shipped content wired to their handlers.
import { createTLV, createSim } from '../../tools/lib/classic.mjs';

export { createSim };

/** Pure render files. recipes.js is the contract's; tune and styles have no THREE at load, so tests can read them too. */
export const PURE = ['sim', 'js/render/tune.js', 'js/render/city/recipes.js', 'js/render/city/styles.js'];

/**
 * @param {object} [opts]
 * @param {string} [opts.map] Map ID or path.
 * @param {boolean} [opts.content] Load and route the content list.
 * @returns {object} TLV.
 */
export function pureTLV(opts = {}) {
  const TLV = createTLV({ files: PURE, map: opts.map || 'tlv_center', content: opts.content !== false, allowMissing: true });
  const S = TLV.render.styles;
  TLV.registry.on('style', S.onStyle);
  TLV.registry.on('kit', S.onKit);
  TLV.registry.on('mesh', S.onMesh);
  TLV.registry.on('district', S.onDistrict);
  TLV.registry.drain();
  return TLV;
}
