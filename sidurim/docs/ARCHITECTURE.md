# Errands: Tel Aviv — Architecture (binding contract)

Audience: parallel implementers who cannot talk to each other. If it is written here, implement it exactly. If two
statements conflict, the order of authority is `docs/BRIEF.md`, then this file for engineering, then
`docs/GAME_DESIGN.md` for gameplay numbers.

If something you need is missing, choose the most conservative reading, keep it private to your package, and record it
in your final report. Never change another package's file, and never invent a new cross-package field.

Contents:

1. Coordinates and units
2. Layout and file ownership
3. Engineering rules
4. Script loading and registration
5. Loading in Node
6. Importer pipeline
7. Map data schema
8. World: derived at load
9. Sim core
10. Shared state objects
11. Event bus
12. Module APIs
13. Command contracts
14. Extension data
15. Render and UI read contract
16. Debug and test hooks
17. Tests and soak harness
18. Performance budgets
19. Definition of done per package
20. Integration acceptance
21. Decision log

---

## 1. Coordinates and units

### 1.1 World frame

| Item | Definition |
|---|---|
| Plane | 2D, right-handed seen from above. The world is **flat**; bridges stay at grade |
| `x` | Metres **east** of origin. Float64 in sim |
| `y` | Metres **north** of origin. In sim, map and UI code `y` is **never** height |
| `z` | Metres above ground, used only in render code |
| Origin | `lat0 = 32.075`, `lon0 = 34.7775`, fixed per city (`meta.origin`), not per bbox, so coordinates stay stable as the map grows |
| Projection | Importer, `TLV.anchors` and `TLV.render.styles.onDistrict` only, because `at` anchors and district polygons stay lat/lon at runtime: `x = (lon - lon0) * 94415`, `y = (lat - lat0) * 110888` (WGS84 metres per degree at 32.075 N) |
| `tlv_center` bounds | `x` in [-2124.3, 2124.3], `y` in [-2772.2, 2772.2], 4.25 x 5.54 km |
| Map integers | Decimetres (`unit = 0.1`) in the same plane |
| Time | Seconds. One tick is `DT = 1/60` s |
| Speed | m/s everywhere. km/h only for HUD display and in the map's `kmh` column |
| Angles | Radians. A name ending `Deg` is degrees, allowed only in `tune.js` and content data |

### 1.2 Heading and direction

- Heading `h`: radians, counter-clockwise from +x. `h = 0` is east, `h = pi/2` is north. Normalize to (-pi, pi] with
  `TLV.math.wrapPi`.
- Forward vector `(cos h, sin h)`. Left normal `(-sin h, cos h)`. Right normal `(sin h, -cos h)`.
- Yaw rate: positive is counter-clockwise. Steering angle: positive is left.
- Lateral offset `lat`: metres from lane centreline, positive is left of travel direction.
- Turn angle `d = wrapPi(hOut - hIn)`. `d > 0` is a left turn.
- Traffic drives on the **right**.

### 1.3 Lanes and path parameter

- Lane index `idx`: **0 is the rightmost lane** in the travel direction. `idx` increases to the left.
- `s`: metres along a lane or connector in travel direction, from its first point.
- A vehicle's `s` refers to its **body centre**. Bumper gap to leader:
  `gap = (leader.s - leader.length/2) - (me.s + me.length/2)` when on the same path.
- Lane to exit mapping: exits sorted right to left, lanes sorted right to left. So `idx = 0` takes the rightmost exit and
  the highest `idx` takes the leftmost. The measurement prototype had this inverted, which inflated conflicts by 6%.

### 1.4 Three.js frame

The **only** conversion is in `js/render/coords.js`:

| World | Three |
|---|---|
| `x` | `position.x` |
| `z` (height) | `position.y` |
| `y` (north) | `position.z = -y` |
| `h` | `rotation.y = h` for a model with forward +X |

Model authoring convention: forward +X, up +Y, left -Z, origin on the ground under the body centre, units metres.

### 1.5 Grids

| Grid | Cell | Owner | Purpose |
|---|---|---|---|
| Render chunk | 400 m | WP-RENDER | `cx = floor((x - bounds.minX)/400)`, same for `cy` |
| Lane index | 60 m | WP-WORLD | Nearest lane, spawn sampling |
| Collider index | 20 m | WP-WORLD | Building, wall and prop queries |
| Vehicle broadphase | 8 m | WP-TRAFFIC | Near-vehicle queries, rebuilt each tick |
| Surface raster | 4 m | WP-WORLD | `TLV.world.surface.at` |

---

## 2. Layout and file ownership

Every file belongs to exactly one work package. **Do not create or edit any file outside your package.** The block below
is the complete list of shipped files. You may add test files only under your own `tests/<wp>/` directory.

If a listed module grows, it stays one file. Do not add new runtime files, because `js/manifest.js` is owned by WP-CORE
and is fixed by section 4.3.

```text
# path                                         owner
index.html                                     WP-CORE
README.md                                      WP-CORE
css/ui.css                                     WP-UI
js/manifest.js                                 WP-CORE
js/core/namespace.js                           WP-CORE
js/core/constants.js                           WP-CORE
js/core/math.js                                WP-CORE
js/core/rng.js                                 WP-CORE
js/core/events.js                              WP-CORE
js/core/config.js                              WP-CORE
js/core/registry.js                            WP-CORE
js/core/invariants.js                          WP-CORE
js/core/replay.js                              WP-CORE
js/core/debug.js                               WP-CORE
js/core/sim.js                                 WP-CORE
js/core/loop.js                                WP-CORE
js/app/loader.js                               WP-CORE
js/app/main.js                                 WP-CORE
js/world/map_codec.js                          WP-MAP
js/world/anchors.js                            WP-MAP
js/world/tune.js                               WP-WORLD
js/world/geom.js                               WP-WORLD
js/world/map.js                                WP-WORLD
js/world/lanes.js                              WP-WORLD
js/world/junctions.js                          WP-WORLD
js/world/signals.js                            WP-WORLD
js/world/spatial.js                            WP-WORLD
js/world/surface.js                            WP-WORLD
js/world/sidewalks.js                          WP-WORLD
js/world/props.js                              WP-WORLD
js/world/parking.js                            WP-WORLD
js/world/routing.js                            WP-WORLD
js/world/world.js                              WP-WORLD
js/sim/player/tune.js                          WP-PLAYER
js/sim/player/vehicle.js                       WP-PLAYER
js/sim/player/collide.js                       WP-PLAYER
js/sim/player/foot.js                          WP-PLAYER
js/sim/player/bots.js                          WP-PLAYER
js/input/input.js                              WP-PLAYER
js/sim/traffic/tune.js                         WP-TRAFFIC
js/sim/traffic/pool.js                         WP-TRAFFIC
js/sim/traffic/idm.js                          WP-TRAFFIC
js/sim/traffic/gate.js                         WP-TRAFFIC
js/sim/traffic/lanechange.js                   WP-TRAFFIC
js/sim/traffic/behaviours.js                   WP-TRAFFIC
js/sim/traffic/spawner.js                      WP-TRAFFIC
js/sim/traffic/deadlock.js                     WP-TRAFFIC
js/sim/traffic/diagnostics.js                  WP-TRAFFIC
js/sim/traffic/traffic.js                      WP-TRAFFIC
js/sim/peds/tune.js                            WP-PEDS
js/sim/peds/pool.js                            WP-PEDS
js/sim/peds/walk.js                            WP-PEDS
js/sim/peds/cross.js                           WP-PEDS
js/sim/peds/riders.js                          WP-PEDS
js/sim/peds/peds.js                            WP-PEDS
js/sim/game/tune.js                            WP-GAME
js/sim/game/nav.js                             WP-GAME
js/sim/game/errands.js                         WP-GAME
js/sim/game/score.js                           WP-GAME
js/sim/game/rage.js                            WP-GAME
js/sim/game/rival.js                           WP-GAME
js/sim/game/parking.js                         WP-GAME
js/sim/game/attacker.js                        WP-GAME
js/sim/game/knife.js                           WP-GAME
js/sim/game/fairness.js                        WP-GAME
js/sim/game/incidents.js                       WP-GAME
js/sim/game/director.js                        WP-GAME
js/sim/game/flow.js                            WP-GAME
js/render/tune.js                              WP-RENDER
js/render/coords.js                            WP-RENDER
js/render/renderer.js                          WP-RENDER
js/render/sky.js                               WP-RENDER
js/render/ground.js                            WP-RENDER
js/render/roads.js                             WP-RENDER
js/render/city/recipes.js                      WP-RENDER
js/render/city/styles.js                       WP-RENDER
js/render/city/facades.js                      WP-RENDER
js/render/city/shells.js                       WP-RENDER
js/render/city/details.js                      WP-RENDER
js/render/city/skyline.js                      WP-RENDER
js/render/city/chunks.js                       WP-RENDER
js/render/atlas.js                             WP-RENDER
js/render/signs.js                             WP-RENDER
js/render/storefronts.js                       WP-RENDER
js/render/landmarks.js                         WP-RENDER
js/render/assets.js                            WP-RENDER
js/render/mesh_format.js                       WP-RENDER
js/render/vehicles.js                          WP-RENDER
js/render/people.js                            WP-RENDER
js/render/signal_heads.js                      WP-RENDER
js/render/effects.js                           WP-RENDER
js/render/camera.js                            WP-RENDER
js/render/rearview.js                          WP-RENDER
js/ui/tune.js                                  WP-UI
js/ui/strings.js                               WP-UI
js/ui/hud.js                                   WP-UI
js/ui/minimap.js                               WP-UI
js/ui/cards.js                                 WP-UI
js/ui/menus.js                                 WP-UI
js/ui/bubbles.js                               WP-UI
js/ui/audio.js                                 WP-UI
js/ui/debug_overlay.js                         WP-UI
js/ui/ui.js                                    WP-UI
content/index.js                               WP-CORE
content/tlv_center/errands.js                  WP-GAME
content/tlv_center/world.js                    WP-GAME
content/tlv_center/storefronts.js              WP-RENDER
content/tlv_center/landmarks.js                WP-RENDER
content/tlv_center/styles.js                   WP-RENDER
content/tlv_center/kit.js                      WP-RENDER
content/tlv_center/districts.js                WP-RENDER
data/maps/index.js                             WP-MAP
data/maps/tlv_center/map.js                    WP-MAP
data/maps/tlv_center/ATTRIBUTION.txt           WP-MAP
data/assets/index.js                           WP-RENDER
tools/import.mjs                               WP-MAP
tools/make_fixture.mjs                         WP-MAP
tools/lib/osm.mjs                              WP-MAP
tools/lib/graph.mjs                            WP-MAP
tools/lib/section.mjs                          WP-MAP
tools/lib/kerbs.mjs                            WP-MAP
tools/lib/pois.mjs                             WP-MAP
tools/lib/land.mjs                             WP-MAP
tools/lib/overlay.mjs                          WP-MAP
tools/lib/encode.mjs                           WP-MAP
tools/lib/report.mjs                           WP-MAP
tools/areas/tlv_center.json                    WP-MAP
tools/rules/tags.json                          WP-MAP
tools/rules/kinds.json                         WP-MAP
tools/rules/parking.json                       WP-MAP
tools/overlays/tlv_center/roads.json           WP-MAP
tools/overlays/tlv_center/pois.json            WP-MAP
tools/lib/classic.mjs                          WP-CORE
tools/lib/pw.cjs                               WP-CORE
tools/soak.mjs                                 WP-CORE
tools/pack_assets.mjs                          WP-RENDER
tests/fixtures/mini_map.js                     WP-MAP
```

Generated or hand-added directories:

| Path | Owner | Notes |
|---|---|---|
| `data/assets/<assetId>.js` | WP-RENDER, generated | Written by `tools/pack_assets.mjs` |
| `assets_src/{storefronts,landmarks,tiles,meshes}/` | WP-RENDER | Hand originals and their `<id>.json` sidecars (section 14.8), never loaded by the game |
| `tools/reports/<id>/` | WP-MAP, generated | `stats.json`, `orphans.json`, `diff.json` |
| `tools/reports/soak/` | WP-CORE, generated | Soak results |
| `tests/<wp>/` | That package | `core map world player traffic peds game render ui` |
| `tests/e2e/` | WP-CORE | Integration browser tests |
| `tools/cache/` | Frozen | `tlv_center.osm.json` already present, written only by `--fetch` |
| `vendor/`, `docs/` | Frozen | Three.js r159, and these documents. Nobody edits them |

**Package summary:**

| Package | Scope | Depends on (by contract only) |
|---|---|---|
| WP-CORE | Namespace, constants, rng, math, events, config, registry, sim step, loop, replay, debug registry, loader, boot, `index.html`, test harness, soak | Nothing |
| WP-MAP | Importer, generated map, codec, anchors, overlays, fixture | Core conventions |
| WP-WORLD | Map loading, lane graph, junctions, signals, spatial index, surface, sidewalks, props, parking spots, routing | Map schema |
| WP-PLAYER | Car physics, collision, on-foot character, input, bots | World, Traffic query API |
| WP-TRAFFIC | AI drivers, behaviours, spawn, deadlock ladder | World, Peds query API |
| WP-PEDS | Pedestrians, two-wheelers | World |
| WP-GAME | Flow, errands, nav, score, director, incidents, parking contest, rival, rage, knife, attacker AI, errand content | All sim APIs |
| WP-RENDER | Scene, city mesh, textures, vehicle and character meshes, camera, effects, storefront and landmark registries, pack tool | Read contract |
| WP-UI | HUD, minimap, menus, cards, speech bubbles, audio, debug overlay | Read contract, events |

**Implementation order.** Packages are designed to run in parallel. If an orchestrator can sequence them, start WP-CORE
and WP-MAP first, since everything tests against them. While a dependency is missing, code to this contract and test
with a private stub in your own `tests/<wp>/`. `TLV.sim.create` accepts `allowMissing: true` (section 12.1.8).

---

## 3. Engineering rules

**Language.** Plain JavaScript, ES2020, classic scripts. No `import`/`export` in game code, no TypeScript, no JSX, no
transpiler, no npm dependencies. `tools/` and `tests/` may be Node ESM (Node 21) with built-ins only, plus Playwright by
absolute path in tests only.

**Forbidden in `js/core`, `js/world`, `js/sim`** (enforced by `tests/core/lint.test.mjs`, a text search after stripping
comments and string literals):
`Math.random`, `Date.now`, `new Date`, `performance.now`, `document`, `navigator`, `localStorage`, `requestAnimationFrame`,
`setTimeout`, `setInterval`, `fetch(`, `XMLHttpRequest`, `new Worker`, `THREE`, `import `, `require(`, `process.`, `Buffer`.
The Node loader runs in the main realm (section 5), so Node globals are visible and this lint is what keeps them out.

**Forbidden everywhere in `js/`:** `new Worker` (it fails on `file://` [M]), `fetch(` or XHR of local files, ES module
syntax, CDN URLs. Three.js stays r159 from `vendor/`.

**Time in the browser only.** `js/app/main.js` may use `Date.now()` for a default seed. Render and UI may use wall-clock
time for animation that never feeds back into the sim.

**Determinism:**

- All randomness comes from `S.rng.<stream>`.
- No wall clock, no `Map` keyed by floats, no iteration whose order depends on hash values.
- Every system is a function of `S`. No module-level mutable state in sim code. Module-level constants are allowed.
  This allows several sims in one Node process. Two exemptions, neither of which feeds sim state: read-only content
  registries filled at drain (`onDef`, `onSpawn`, `onMap`, the `world.get` cache), and the current-sim pointer in `TLV.debug`.
- Same `(seed, map, content, input log, build)` gives the same `TLV.sim.hash(S)`. Identity holds within one JS engine;
  cross-engine replay is not promised.

**Allocation.** Per-tick sim code must not allocate in hot paths. Reuse pools and caller-provided `out` parameters.
Rare events may allocate.

**Sim never throws on bad data.** Invalid content is skipped with `console.warn` and listed by `TLV.registry.problems()`.
Internal invariant failures throw only in tests.

**Render never mutates sim state.** Sim code never reads render or UI state.

**Tuning.** All numbers from GAME_DESIGN live in the owning package's `tune.js` as `TLV.tune.<pkg>`, using the same
values as the design doc. Names are private to the package, except the shared keys in section 12.1.9.

**Style.** One IIFE per file, `'use strict'`, 2-space indent, JSDoc on every public function.

**Tone rules cover code too.** The content rules in `docs/BRIEF.md` apply to identifiers, comments, test data and strings.

---

## 4. Script loading and registration

### 4.1 `index.html` (WP-CORE)

Contains exactly: `<!doctype html>`, `<meta charset="utf-8">` as the first child of `<head>`, `<canvas id="game">`,
`<div id="ui-root">`, `<link rel="stylesheet" href="css/ui.css">`, and these scripts, in this order:

```html
<script src="vendor/three.min.js"></script>
<script src="js/core/namespace.js"></script>
<script src="js/manifest.js"></script>
<script src="js/app/loader.js"></script>
```

`index.html` never changes when maps or content are added.

The charset is mandatory. Without it the page decodes as windows-1252 on `file://`, injected scripts inherit that encoding,
and every Hebrew string, `₪` and `©` is corrupted, including the OSM attribution [M].

### 4.2 File template

Every file in `js/` follows this shape. Top-level code only defines things; it never calls another module at load time,
other than `TLV.ns`. Order between packages therefore does not matter, except that `namespace.js` is first.

```js
// js/world/lanes.js — WP-WORLD
(function (TLV) {
  'use strict';
  var lanes = TLV.ns('world.lanes');
  lanes.pointAt = function (W, laneId, s, out) { /* ... */ };
})(window.TLV);
```

`namespace.js` defines `TLV.q`, `TLV.ns` and `TLV.tune = {}`. `TLV.ns('a.b')` creates nested objects and returns the leaf.
Tune files assign `TLV.tune.world = {...}` and so on.

### 4.3 Manifest (`js/manifest.js`, WP-CORE)

The single source of load order for browser and Node. Exactly these lists:

```js
TLV.manifest = {
  sim: [
    'js/core/constants.js','js/core/math.js','js/core/rng.js','js/core/events.js','js/core/config.js',
    'js/core/registry.js','js/core/invariants.js','js/core/replay.js','js/core/debug.js','js/core/sim.js','js/core/loop.js',
    'js/world/map_codec.js','js/world/anchors.js','js/world/tune.js','js/world/geom.js','js/world/map.js',
    'js/world/lanes.js','js/world/junctions.js','js/world/signals.js','js/world/spatial.js','js/world/surface.js',
    'js/world/sidewalks.js','js/world/props.js','js/world/parking.js','js/world/routing.js','js/world/world.js',
    'js/sim/player/tune.js','js/sim/player/vehicle.js','js/sim/player/collide.js','js/sim/player/foot.js','js/sim/player/bots.js',
    'js/sim/traffic/tune.js','js/sim/traffic/pool.js','js/sim/traffic/idm.js','js/sim/traffic/gate.js',
    'js/sim/traffic/lanechange.js','js/sim/traffic/behaviours.js','js/sim/traffic/spawner.js',
    'js/sim/traffic/deadlock.js','js/sim/traffic/diagnostics.js','js/sim/traffic/traffic.js',
    'js/sim/peds/tune.js','js/sim/peds/pool.js','js/sim/peds/walk.js','js/sim/peds/cross.js','js/sim/peds/riders.js','js/sim/peds/peds.js',
    'js/sim/game/tune.js','js/sim/game/nav.js','js/sim/game/errands.js','js/sim/game/score.js','js/sim/game/rage.js',
    'js/sim/game/rival.js','js/sim/game/parking.js','js/sim/game/attacker.js','js/sim/game/knife.js',
    'js/sim/game/fairness.js','js/sim/game/incidents.js','js/sim/game/director.js','js/sim/game/flow.js'
  ],
  browser: [
    'js/input/input.js',
    'js/render/tune.js','js/render/coords.js','js/render/atlas.js','js/render/assets.js','js/render/mesh_format.js',
    'js/render/sky.js','js/render/ground.js','js/render/roads.js',
    'js/render/city/recipes.js','js/render/city/styles.js','js/render/city/facades.js','js/render/city/shells.js',
    'js/render/city/details.js','js/render/city/skyline.js','js/render/city/chunks.js',
    'js/render/signs.js','js/render/storefronts.js','js/render/landmarks.js','js/render/vehicles.js','js/render/people.js',
    'js/render/signal_heads.js','js/render/effects.js','js/render/camera.js','js/render/rearview.js','js/render/renderer.js',
    'js/ui/tune.js','js/ui/strings.js','js/ui/hud.js','js/ui/minimap.js','js/ui/cards.js','js/ui/menus.js',
    'js/ui/bubbles.js','js/ui/audio.js','js/ui/debug_overlay.js','js/ui/ui.js',
    'js/app/main.js'
  ]
};
```

### 4.4 The extension queue

`namespace.js` defines `TLV.q = []` first. Every data file only pushes onto it, so data script order never matters:

```js
TLV.q.push(['map' | 'errand' | 'incident' | 'storefront' | 'landmark' | 'style' | 'kit' | 'mesh' | 'asset' | 'spawn' | 'district', payload]);
```

`TLV.registry.on(type, fn)` registers a handler. `TLV.registry.drain()` dispatches queued items, in order, to handlers.
Items with no handler stay queued without error; this is why render content is harmless in Node. `drain()` is repeatable
and dispatches only unprocessed items, and `TLV.render.assets` calls it after each asset script loads, which is how late
`asset` items arrive. A handler rejects an invalid item with `TLV.registry.problem(type, id, reason)`. Handlers:

| Type | Handler module | Owner |
|---|---|---|
| `map` | `TLV.world.map.onMap` | WP-WORLD |
| `errand`, `incident`, `spawn` | `TLV.game.errands.onDef`, `TLV.game.incidents.onDef`, `TLV.game.errands.onSpawn` | WP-GAME |
| `storefront` | `TLV.render.storefronts.onDef` | WP-RENDER |
| `landmark` | `TLV.render.landmarks.onDef` | WP-RENDER |
| `style`, `kit`, `mesh`, `district` | `TLV.render.styles.onStyle`, `.onKit`, `.onMesh`, `.onDistrict` | WP-RENDER |
| `asset` | `TLV.render.assets.onAsset` | WP-RENDER |

Handlers register in each package's `TLV.<pkg>.register()` function. `TLV.app.boot` and the Node loader call these
before draining.

A `spawn` item names its own `map`. `TLV.game.errands.spawnPoint` uses only items whose `map` equals `S.world.id`.

### 4.5 Data indexes

Three generated or hand files define indexes without pushing to the queue:

```js
// data/maps/index.js (generated by importer)
TLV.mapIndex = { default: 'tlv_center',
  maps: { tlv_center: { src: 'data/maps/tlv_center/map.js', title: { he: '...', en: 'Tel Aviv Center' }, schema: [1, 0] } } };
// content/index.js (WP-CORE)
TLV.contentFiles = { default: ['content/tlv_center/world.js','content/tlv_center/errands.js',
  'content/tlv_center/styles.js','content/tlv_center/kit.js','content/tlv_center/districts.js',
  'content/tlv_center/storefronts.js','content/tlv_center/landmarks.js'] };
// data/assets/index.js (generated by pack tool)
TLV.assetIndex = { /* assetId: { src: 'data/assets/x.js', bytes: n } */ };
```

### 4.6 Browser boot (`js/app/loader.js`, `js/app/main.js`)

Loader, in order:

1. Inject `TLV.manifest.sim`, then `.browser`, then `data/maps/index.js`, `content/index.js`, `data/assets/index.js`, with
   `script.async = false`, so they execute in order.
2. When the last of those has fired `onload` or `onerror`, set `TLV.params = TLV.config.parse(location.search)`.
3. Inject the selected map's `src` and the content list from section 4.5, also with `async = false`. This must follow
   step 2, because the map ID comes from the query string.
4. Any `onerror` adds to a missing list, shown in an error overlay: `TLV.ui.showError` when defined, else plain text that
   `loader.js` writes into `#ui-root`. Boot stops if a `.sim` file or the map is missing.
5. When all are loaded, call `TLV.app.boot()`.

`data/assets/index.js` ships as `TLV.assetIndex = {};` before any asset exists.

The loader and `createTLV` use `TLV.contentFiles[mapId] || TLV.contentFiles.default`, so every map, including `mini` and a
new area, gets errands with no engine change. A map may add its own key later. Anchored content that does not resolve on
the current map is an orphan, which is skipped and never an error.

Boot, in order:

1. Call `register()` on `TLV.world`, `TLV.player`, `TLV.traffic`, `TLV.peds`, `TLV.game`, `TLV.render`, `TLV.ui`, in that
   order. Each registers its `TLV.q` handlers, invariants and debug hooks. Node calls only the first five.
2. `TLV.registry.drain()`.
3. `W = TLV.world.build(mapPayload)`. A schema major mismatch calls `TLV.ui.showError` naming the re-import command.
   `showError` must therefore work before `TLV.ui.init`, targeting `#ui-root` directly.
4. If `TLV.params.seed` is null, set it to `Date.now() >>> 0`. `S = TLV.sim.create({ seed: TLV.params.seed, world: W,
   params: TLV.params })`; stored as `TLV.app.S`.
5. `TLV.render.init(document.getElementById('game'), S)`. Builds the 9 chunks around spawn synchronously.
6. `TLV.ui.init(document.getElementById('ui-root'), S)`.
7. `TLV.input.init(window, S)`, which installs the browser control source (section 12.4).
8. `TLV.app.loop = TLV.loop.create({ S, step: TLV.sim.step, render, raf, now, timescale: TLV.params.timescale })` and start.
   `render(S, alpha, dtReal)` calls `TLV.render.frame`, then `TLV.ui.frame`, with the same arguments.

Phase 3 chunk building continues inside `TLV.render.frame` under a 4 ms slice.

---

## 5. Loading in Node

`tools/lib/classic.mjs` (WP-CORE) loads the same classic files in Node, compiled in the **main realm**. It does not use a
`vm` context. A context makes `Math.*` lookups 33 times slower and allocation about 7 times slower [M], which would distort
the tick budget, and its objects fail `assert.deepStrictEqual` and `instanceof` against test literals [M].

```js
const win = {};                                                        // one per createTLV call
const fn = vm.compileFunction(src, ['window', 'TLV'], { filename });   // no parsingContext
fn(win, win.TLV);
```

`namespace.js` runs first, with `TLV` undefined, and creates `win.TLV`, so it must use only `window.TLV`. This form measured
the same as plain code [M]. It keeps file names in stack traces, gives each `createTLV` call an independent `TLV` [M], lets
tests compare results with `assert.deepStrictEqual` directly [M], and leaves `URLSearchParams`, `atob`, `TextDecoder` and
typed arrays as the real globals. `document` does not exist, so DOM use fails at once. `process`, `Buffer` and `navigator` do
exist, which the lint in section 3 covers. The loader always runs `js/core/namespace.js` and `js/manifest.js` first, even
with an explicit `files` list.

```js
// tools/lib/classic.mjs
export function createTLV(opts?: {
  root?: string,            // project root, default: resolved from this file
  files?: 'sim' | string[], // default 'sim' = TLV.manifest.sim. An array may contain the token 'sim'
  map?: string | null,      // map id, or a path such as 'tests/fixtures/mini_map.js'; default 'tlv_center'
  content?: boolean,        // load the section 4.5 content list, default true
  params?: object,          // partial; TLV.params = TLV.config.normalize(params). Node fills seed 1 if it is null
  allowMissing?: boolean    // tolerate absent files and absent register() functions, for a package testing alone
}): TLV                     // after register() and drain()
export function createSim(TLV, opts): SimState   // wrapper for TLV.sim.create with TLV.world.get(map); calls TLV.debug.use(S)
```

- An explicit `files` array implies `allowMissing: true, map: null, content: false`, unless those are set. Example, for code
  that needs a world: `createTLV({ files: ['sim', 'js/render/city/recipes.js'], map: 'tests/fixtures/mini_map.js' })`.
- With a path, the map ID comes from the pushed payload's `id`.
- `createTLV` calls `TLV.config.normalize` and `TLV.sim.create` does too, so `S.params` is always complete.

Tests use Node's built-in `node:test` and `node:assert`. There is no custom test runner:
`node --test 'tests/<wp>/**/*.test.mjs'` runs a package; `node --test 'tests/**/*.test.mjs'` runs everything except
`*.e2e.cjs`. Keep the quotes. The directory form `node --test tests/` fails on Node 21.7.2 with `MODULE_NOT_FOUND` [M].

`tools/lib/pw.cjs` (WP-CORE) wraps Playwright:

```js
const pw = require('/home/g/driving/tools/lib/pw.cjs');
const { browser, page } = await pw.open({ params: '?seed=1&notitle=1', server: false }); // file:// by default
await pw.waitForTick(page, 600);    // polls TLV.debug.state().tick
await page.screenshot({ path });
await browser.close();
```

It uses `require('/home/g/tagger/node_modules/playwright')` and launch args
`['--use-angle=swiftshader','--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-swiftshader']`. Software GL is
slow, so tests assert ticks and state, not frame rate, and each e2e test must close its browser in a `finally`.

---

## 6. Importer pipeline (WP-MAP)

Command: `node tools/import.mjs <areaId> [--fetch] [--strict]`.

Offline by default. `--fetch` is the only network step. Output must be **byte-identical** for identical input.

Area file `tools/areas/tlv_center.json`:

```json
{ "id": "tlv_center", "bbox": [32.05, 34.755, 32.10, 34.80], "origin": [32.075, 34.7775],
  "title": { "he": "תל אביב מרכז", "en": "Tel Aviv Center" }, "sources": ["tlv_center"] }
```

`sources` lists extracts in `tools/cache/<source>.osm.json`, merged and deduplicated by OSM ID.

### 6.1 Passes (order matters)

Pass numbers are stable labels. There is no pass 8: the overlay pass moved to 3b.

| # | Pass | File | Rule |
|---|---|---|---|
| 1 | Load | `osm.mjs` | Merge sources |
| 2 | **Dedupe** | `osm.mjs` | 3,003 tagged nodes reappear later untagged [M]. Keep the tagged copy, or last-write-wins loses every signal. Unique nodes 114,284. Same for ways |
| 3 | Project | `osm.mjs` | Section 1.1, to decimetres |
| 3b | Overlay pre | `overlay.mjs` | `road.*`, `node.*`, `building.*` ops, applied to the raw OSM records so every later pass treats them as OSM data. It must precede pass 7, whose contraction compares tags, and pass 6, which must see an added road |
| 4 | Filter roads | `graph.mjs` | Keep `primary secondary tertiary unclassified residential living_street service` and `_link` forms of the first three. Drop `motorway*`, `tunnel=yes`, `tunnel=building_passage`, `access` or `motor_vehicle` = `no` or `private`, `service=parking_aisle`, `service=driveway`, and ways whose name matches `/floor\|קומה/i` (9 garage ramps). **Keep bridges**: dropping them shrinks the giant component from 473 to 366 km [M] |
| 5 | Clip | `graph.mjs` | Keep ways with at least one node in bbox. Cut at the bbox boundary. New end nodes get `flags.PORTAL` |
| 6 | Grade separation | `graph.mjs` | Find kept road polylines that cross with no shared node. Delete the lower-class way's crossing segment. Expected sites: Namir/Bnei Dan, Rokach/Namir, Ibn Gabirol/Ussishkin, HaHagana/HaHarash, Begin/Begin (about 4 km [M]). Gate: zero such crossings remain |
| 7 | Graph | `graph.mjs` | Split ways at shared nodes, contract degree-2 nodes, keep signal nodes as pass-through junctions. Contract across a way boundary only if both ways agree on `highway, name, oneway, lanes, lanes:forward, lanes:backward, maxspeed` and all `parking:*` tags: 544 way-end boundaries are degree-2 nodes and 250 of them differ in lanes, speed, oneway or class [M]. `edges.osm` is the longest contributing way |
| 9 | Normalize | `section.mjs` | Lanes and speed from `tools/rules/tags.json` (section 6.2) |
| 10 | Merge junctions | `graph.mjs` | Union nodes of degree 3 or more across edges under 25 m, smallest first, rejecting a merge if diameter exceeds 50 m. Expected about 2,316 clusters, 505 multi-node, max 11 nodes [M]. Dual carriageways resolve here: one cluster, one controller |
| 11 | Movements | `graph.mjs` | Edges with both ends in one merged cluster are internal: use them for the reachability test below, then drop them. They do not appear in `edges`. Connect each incoming arm to each outgoing arm **only if a route exists through the cluster's internal edges** (273 otherwise-invented movements are removed [M]). Ban `\|d\| > 155 deg`, except a U-turn at a dead end, which is **mandatory** (without it, connected lane-km falls from 586 to 515 [M]) |
| 12 | Roundabouts | `graph.mjs` | 26 ways [M]. Radius under 6 m becomes an ordinary junction. Otherwise `kind = RING` |
| 12b | Signal attachment | `graph.mjs` | A cluster with 3 or more arms becomes `SIGNAL` if a signal node is within 35 m (391 clusters [M]). A pass-through signal node within 35 m by road of such a cluster stays `PASS` and gets no controller (95 of 157 such nodes [M]): it is the same light, and a second controller 10 m away would have an unrelated offset. Other pass-through nodes become `SIGNAL` only if a signal node is within 6 m (mid-block lights, 62 [M]). A `PORTAL` junction is always `PRIORITY`, never `PASS`, so its lanes trim at least 3 m clear of the `BOUNDS` wall. Others stay `PRIORITY` or `PASS`. Expected total about 450 [M] |
| 13 | Cross-section | `section.mjs` | Section 6.3 |
| 14 | Connectivity | `graph.mjs` | SCC on the **directed-edge turn graph**, not nodes. Set `AI_F`, `AI_B` flags. Non-SCC edges stay player-drivable |
| 15 | Building join | `section.mjs` | 36 buildings are relations [M]: join `outer` member ways into ring 0 and `inner` into holes. Normalize winding. Spatial hash from building walls to roads. Set `front` per wall |
| 16 | Kerbs | `kerbs.mjs` | Section 6.4 |
| 17 | Crossings and stops | `kerbs.mjs` | Project to road edges. 0 of 530 bus stops are on road nodes [M], so always project. Crossings use node positions on kept roads, 1,864 expected before clipping [M] |
| 18 | POIs | `pois.mjs` | Section 6.5. Must include way and relation centroids, otherwise most kindergartens are missed: only 4 of 16 are nodes [M] |
| 19 | Land and walls | `land.mjs` | Section 6.6 |
| 20 | Overlay post | `overlay.mjs` | `poi.*`, `kerb.*` ops |
| 21 | Encode | `encode.mjs` | Section 7 |
| 22 | Verify | `report.mjs` | Decode with `js/world/map_codec.js` through the classic loader. Run the gates in section 19 |
| 23 | Report | `report.mjs` | `tools/reports/<id>/{stats,orphans,diff}.json`. `diff.json` compares to the previous run and flags a class change above ±5% |

### 6.2 Road defaults (`tools/rules/tags.json`)

Do not depend on `turn:lanes` (12 ways), turn restrictions (0) or signal direction tags (0) [M]. Derive them.

| Class | One-way lanes | Two-way per direction | Default kmh | Lane width m |
|---|---|---|---|---|
| primary | 3 | 2 | 50 | 3.4 |
| secondary | 2 | 1 | 50 | 3.3 |
| tertiary | 2 | 1 | 50 | 3.2 |
| unclassified | 1 | 1 | 30 | 3.0 |
| residential | 1 | 1 | 30 | 3.0 |
| living_street | 1 | 1 | 15 | 2.8 |
| service | 1 | 1 | 15 | 2.8 |

- `lanes` tag on a two-way way is the total, usually 2. Per-direction count is `max(1, floor(lanes/2))`, unless
  `lanes:forward` or `lanes:backward` exists. Clamp to 1-5.
- `oneway=-1` reverses the polyline (2 ways [M]). `junction=roundabout` and `junction=circular` imply one-way.
- `maxspeed` numeric values are used. Non-numeric values use the class default.

### 6.3 Cross-section

Each edge stores `laneW`, `parkL`, `parkR`, `swL`, `swR`. Defaults: parking strip 2.4 m where kerb tier allows parking,
sidewalk 2.5 m, or 3.5 m on primary and secondary. `L` and `R` are relative to digitized direction `a` to `b`.

Distance from polyline to curb, used by importer and world alike:

- Two-way: `kerbOffR = lanesF * laneW + parkR`, `kerbOffL = lanesB * laneW + parkL`.
- One-way: `kerbOffR = lanesF * laneW / 2 + parkR`, `kerbOffL = lanesF * laneW / 2 + parkL`.

The sidewalk lies beyond the curb, out to `kerbOff + sw`. The clearance corridor is that outer limit.

Corridors clip buildings on 4.2% of residential, 6.8% of living_street and 8.1% of service samples [M]. Resolve in this
fixed order until the corridor clears:

1. Set the sidewalk on that side to a minimum of 1.0 m.
2. Set the parking strip on that side to 0.
3. Clamp `laneW` down to a minimum of 2.6 m.
4. Reduce lanes per direction, minimum 1.
5. Set `flags.NARROW`.
6. If the centreline is still inside a building (48 ways, 14 tagged as passages [M]), or any lane centreline at final
   `laneW`, offset per section 8.1, crosses a wall of a building or lies inside it (about 37 more ways and 42 buildings [M]),
   the road wins: set `flags.NO_COLLIDER` on that building.

### 6.4 Kerbs (`tools/rules/parking.json`)

Tags here are non-standard: `parking:*:zone` dominates, and only 25 ways state orientation [M]. The zone value needs a
parser guard because `6sidewalk=both` exists in the data [M].

Every edge side is partitioned into kerb rows. `tier` records the evidence:

| Tier | Rule | Side-km [M] |
|---|---|---|
| 0 `curated` | From a `kerb.set` overlay; outranks everything | 0 |
| 1 `explicit` | `parking:<side>` or `:both` is yes, lane or street_side | 106.7 |
| 2 `zone` | `parking:<side>:zone` or `:both:zone` present | 272.4 |
| 3 `inferred` | No tag; residential, unclassified or living_street on both sides; tertiary on the right only | 215.5 |
| 255 `none` | Explicit `no`, links, tunnels, bridges, roundabouts, buffers, and everything else | |

Cut as tier 255 buffers: 12 m at junctions, 5 m at crossings, 15 m at stops. The stop buffer matches the red/yellow paint rule; the prototype's 12 m gave slightly more stalls.

Paint, always derived, never observed:

| `paint` | Value | Rule, first match wins |
|---|---|---|
| `red_yellow` | 2 | Within 15 m of a bus stop |
| `red_white` | 1 | Explicit `no`, or within 12 m of a junction |
| `blue_white` | 3 | Zone tag present |
| `none` | 0 | Otherwise |

### 6.5 POIs and facades (`tools/rules/kinds.json`)

`kinds.json` maps OSM tags to game kinds, for example `{"amenity=pharmacy":"pharmacy","shop=bakery":"bakery"}`. Kinds
used by errands: `convenience supermarket laundry dry_cleaning bank pharmacy bakery hairdresser greengrocer butcher
ice_cream post_office fuel`. All other tagged POIs still import with a generic kind so they can show signs.

**Sensitive** POIs get `flags.SENSITIVE`, named or not, as node, way or relation centroid. A POI is sensitive if
`amenity` is `place_of_worship`, `school`, `kindergarten` or `hospital`, **or** `building` is `school`, `kindergarten`,
`synagogue`, `mosque`, `church`, `temple`, `chapel`, `cathedral`, `shrine` or `hospital`. Building-tagged sites have no
sign and exist only for this guard. Expected 186 points before removing overlaps [M].

Facade algorithm (prototype yield 1,816 of 1,943 named in-bbox POI nodes, 93.5% [M]). 84% of POI nodes are inside a
footprint [M], so a node position cannot place a sign:

1. Host: a way POI uses itself. Otherwise the containing footprint, then the nearest within 25 m.
2. Candidate walls: host walls of at least 3 m whose outward normal faces a road within 35 m with clear line of sight.
   Skip unnamed service roads.
3. Score: +100 when `addr:street` matches the road name (757 of 913 match [M]), then wall length, POI distance, road
   distance.
4. Allocate: sort along the wall, width `clamp(len/n, 3, 9)` m. Overflowing POIs (59 from 11 walls [M]) get
   `flags.INTERIOR`: still valid targets, with one directory sign at the entrance.
5. `entX`, `entY`: door point on the sidewalk, 0.5 m outside the wall. With no facade, set `flags.NO_FACADE` and use the raw
   POI position snapped to the nearest edge side at `kerbOff + sw/2`. `NO_FACADE` POIs (about 6% of errand POIs [M]) keep
   their sign data but are never errand targets; every errand still has at least 10 targets [M].

Names: `nameHe` is `name:he` or a Hebrew `name`. `nameEn` is `name:en` or an ASCII `name`.
Never use `brand:wikidata` or brand imagery. Plain text only.

### 6.6 Land and walls

- Close the coastline against the bbox to make a `sea` polygon. Bbox west is sea.
- `land` classes: section 7.3.
- `motorway` ways (12.2 km [M]) become `walls` rows of kind `MOTORWAY_FENCE`. Then cut each fence polyline at every kept
  road crossing, removing `(kerbOff + sw + 3) / max(0.3, sin a)` m either side of the crossing point, where `a` is the
  crossing angle and `kerbOff + sw` is taken from the wider side of the road. Motorways are dropped at pass 4, so pass 6
  never sees them, and kept roads cross the fence at 40 in-bbox points on 23 ways, including Begin, La Guardia, HaHagana and
  Yitzhak Sadeh [M]. Uncut, those bridges are walls: 19.5% of directed road-km and 26 of 459 errand POIs are cut off [M].
- The bbox perimeter becomes `walls` rows of kind `BOUNDS`.
- Promenade and pedestrian ways become `paths` rows.
- `landuse=construction` areas that touch a road: 229 areas in the extract; road overlap is unmeasured, so overlap is
  detected at import, and those become `land` class `CONSTRUCTION` with a road closure only through hand overlay.

### 6.7 Overlays

Hand work never touches generated files. Import-time overlays live in `tools/overlays/<id>/*.json`, change topology or
collision, and every op needs a `why`:

```json
[{ "op": "road.set", "anchor": { "osm": "w123" }, "set": { "lanes": 3 }, "why": "Tag out of date" }]
```

Ops: `road.set`, `road.add`, `road.delete`, `node.set`, `building.set`, `building.delete`, `poi.add`, `poi.hide`,
`poi.rename`, `poi.move`, `kerb.set`.

The shipped overlay files start as empty arrays. Anchors resolve per section 14.2. **Rule: visual replacement never
changes collision.** Only import-time overlays can.

### 6.8 Adding an area

1. Create `tools/areas/tlv_north.json` with the same city `origin` and `"sources": ["tlv_center","tlv_north"]`.
2. Run `node tools/import.mjs tlv_north --fetch`. The Overpass query template is in `tools/lib/osm.mjs`.
3. `data/maps/index.js` regenerates and `?map=tlv_north` works with the default content list (section 4.5). No engine change
   is allowed or needed.

Size targets: `map.js` at most 1.6 MB for `tlv_center`, at most 4 MB for all of Tel Aviv-Yafo.

### 6.9 Attribution

`data/maps/<id>/ATTRIBUTION.txt` states the map data is derived from OpenStreetMap, © OpenStreetMap contributors, under
the ODbL 1.0, with the extract timestamp. `map.js` is a derived database and ships under ODbL.

---

## 7. Map data schema

Schema version `[1, 0]`. A major mismatch is a hard error. A minor bump only adds columns: readers ignore unknown columns
and default missing ones to 0.

### 7.1 Container

```js
TLV.q.push(['map', {
  schema: [1, 0],
  id: 'tlv_center',
  meta: {
    title: { he: '...', en: '...' },
    origin: [32.075, 34.7775],
    unit: 0.1,
    bbox: [32.05, 34.755, 32.10, 34.80],      // south, west, north, east
    bounds: [minX, minY, maxX, maxY],          // metres
    osmTime: '2026-11-01T00:38:42Z',
    importer: '1.0.0',
    overlayHash: '...',
    license: 'ODbL-1.0',
    attribution: '© OpenStreetMap contributors'
  },
  strings: ['', 'דיזנגוף', 'Dizengoff'],       // index 0 is always ''
  tables: { edges: { n: 7432, cols: { a: ['vu', '<b64>'], cls: ['u8', '<b64>'] } } }
}]);
```

### 7.2 Column encodings

| Enc | Data | Decoded type |
|---|---|---|
| `u8` | Base64 bytes | `Uint8Array` |
| `vu` | Base64 of unsigned LEB128 | `Int32Array` |
| `vz` | Base64 of zigzag then LEB128 | `Int32Array` |
| `vd` | Base64: first value then deltas, zigzag then LEB128; decode cumulative | `Int32Array` |
| `vl` | Base64 of unsigned LEB128 decoded with arithmetic, not bit shifts | `Float64Array` |
| `raw` | Plain JSON number array, for fixtures and tests | `Float64Array` |

**`vl` is mandatory for every `osm` column.** OSM node IDs here exceed 2^31 (for example 10693747873), so an `Int32Array`
would silently corrupt them.

A column named `*Off` has `n + 1` entries; the rest have `n`.

`TLV.mapCodec.decodeAll(payload)` is table-agnostic and returns `{ schema, id, meta, strings, t: { <table>: { n, col: { <name>: TypedArray } } } }`.

### 7.3 Tables

Coordinates are decimetres. "Str" means an index into `strings`. Row index is the ID.

**`juncs`** — junction clusters.

| Column | Enc | Meaning |
|---|---|---|
| `x`, `y` | `vd` | Centroid |
| `kind` | `u8` | 0 `PASS`, 1 `PRIORITY`, 2 `SIGNAL`, 3 `RING` |
| `flags` | `u8` | bit0 `PORTAL`, bit1 `DEAD_END` |

**`edges`** — road pieces between two junctions. Direction `a` to `b` is forward. Directed edge ID:
`de = edge * 2 + (forward ? 0 : 1)`.

| Column | Enc | Meaning |
|---|---|---|
| `a`, `b` | `vu` | Junction IDs |
| `ptOff` | `vu` | n+1 offsets into `pts`, shape includes both ends, in `a` to `b` order |
| `cls` | `u8` | 0 primary, 1 secondary, 2 tertiary, 3 unclassified, 4 residential, 5 living_street, 6 service |
| `lanesF`, `lanesB` | `u8` | Lanes each way. 0 for none. One-way is always forward |
| `kmh` | `u8` | Speed limit |
| `laneW` | `u8` | Lane width, decimetres |
| `parkL`, `parkR` | `u8` | Parking strip width, decimetres, 0 for none |
| `swL`, `swR` | `u8` | Sidewalk width, decimetres, 0 for none |
| `flags` | `u8` | bit0 `ROUNDABOUT`, bit1 `BRIDGE`, bit2 `NARROW`, bit3 `AI_F`, bit4 `AI_B`, bit5 `LINK` |
| `name`, `nameEn` | `vu` | Str |
| `osm` | `vl` | Way ID |

**`pts`** — `x`, `y` (`vd`).

**`moves`** — legal turns, sorted by `from`, then `to`.

| Column | Enc | Meaning |
|---|---|---|
| `from`, `to` | `vu` | Directed edge IDs. The junction is the end of `from` |
| `turn` | `u8` | 0 straight, 1 right, 2 left, 3 U-turn |

**`blds`** — buildings. `rOff` points into `brings`; ring 0 is outer, the rest are holes.

| Column | Enc | Meaning |
|---|---|---|
| `rOff` | `vu` | n+1 offsets into `brings` |
| `h` | `vu` | Height, decimetres. Importer fills from `height`, `building:levels * 3.1 m`, else 0 |
| `levels` | `u8` | 0 unknown |
| `kind` | `u8` | 0 generic, 1 residential, 2 commercial, 3 office, 4 retail, 5 civic, 6 religious, 7 school, 8 hospital, 9 industrial |
| `roof` | `u8` | 0 flat, 1 pitched, 2 dome |
| `colour` | `vu` | Str of `building:colour`, 0 for none |
| `style` | `vu` | Str of a style ID set by a `building.set` overlay, 0 for none |
| `flags` | `u8` | bit0 `NO_COLLIDER`, bit1 `GLASS` (`building:material=glass`) |
| `name`, `nameEn` | `vu` | Str |
| `osm` | `vl` | ID |
| `osmT` | `u8` | 0 node, 1 way, 2 relation |

**`brings`** — `pOff` (`vu`, n+1 offsets into `bpts`).

**`bpts`** — `x`, `y` (`vd`), `front` (`u8`). Closed implicitly: the first vertex is not repeated. Outer ring is CCW,
holes CW. `front` applies to the wall from vertex `i` to `i+1`: 0 none, else `cls + 1` of the road faced.

**`pois`**

| Column | Enc | Meaning |
|---|---|---|
| `x`, `y` | `vd` | Raw position |
| `kind` | `vu` | Str, game kind |
| `nameHe`, `nameEn` | `vu` | Str, 0 for none |
| `osm` | `vl` | ID |
| `osmT` | `u8` | As above |
| `bld` | `vu` | Building ID + 1, 0 for none |
| `wall` | `vu` | Wall index in outer ring + 1, 0 for none |
| `t` | `u8` | Sign centre along wall, 0-255 |
| `w` | `u8` | Sign width, decimetres |
| `entX`, `entY` | `vd` | Door point |
| `edge` | `vu` | Nearest edge ID + 1, 0 for none |
| `flags` | `u8` | bit0 `NAMED`, bit1 `INTERIOR`, bit2 `SENSITIVE`, bit3 `NO_FACADE` |

**`kerbs`** — partition of each edge side.

| Column | Enc | Meaning |
|---|---|---|
| `edge` | `vu` | Edge ID |
| `side` | `u8` | 0 left, 1 right, relative to digitized direction |
| `s0`, `s1` | `vu` | Extent along the edge polyline, decimetres |
| `form` | `u8` | 0 parallel, 1 diagonal, 2 perpendicular. v1 treats all as parallel |
| `paint` | `u8` | Section 6.4 |
| `zone` | `vu` | Str, 0 for none |
| `tier` | `u8` | Section 6.4 |

**`xings`** — crossings: `x`, `y` (`vd`), `edge` (`vu`), `s` (`vu`, dm), `flags` (`u8`: bit0 `SIGNAL`).

**`stops`** — bus stops: `x`, `y` (`vd`), `edge` (`vu`), `dir` (`u8`), `s` (`vu`, dm), `name` (`vu`).

**`trees`** — real tree nodes: `x`, `y` (`vd`), `species` (`u8`: 0 unknown, 1 ficus, 2 palm, 3 other).

**`lots`** — parking areas: `pOff` (`vu`, n+1 into `lotPts`), `kind` (`u8`), `entX`, `entY` (`vd`), `name` (`vu`).
**`lotPts`** — `x`, `y` (`vd`).

**`land`** — polygons: `pOff` (`vu`, n+1 into `landPts`), `cls` (`u8`): 0 `SEA`, 1 `BEACH`, 2 `PARK`, 3 `GARDEN`,
4 `WATER`, 5 `CONSTRUCTION`, 6 `SAND`, 7 `PITCH`, 8 `PLAZA`. **`landPts`** — `x`, `y` (`vd`).

**`paths`** — pedestrian ways: `pOff` (`vu`, n+1 into `pathPts`), `cls` (`u8`): 0 promenade or pedestrian, 1 footway,
2 cycleway; `name` (`vu`). **`pathPts`** — `x`, `y` (`vd`).

**`walls`** — solid lines: `pOff` (`vu`, n+1 into `wallPts`), `kind` (`u8`): 0 `BOUNDS`, 1 `MOTORWAY_FENCE`.
**`wallPts`** — `x`, `y` (`vd`).

### 7.4 Importer versus load

| Importer emits (static facts and topology) | WP-WORLD derives at load |
|---|---|
| Junction clusters and kinds | Trimmed lanes with offset polylines |
| Road polylines, classes, cross-section | Connectors (Bezier) and conflict sets |
| Legal movements | Signal controllers and slots |
| `AI_F`/`AI_B` connectivity | Lane-level flags, `left`, `right`, `opposite` |
| Buildings, `front`, collider flags | Collider segment arrays and spatial indexes |
| POIs, facades, doors | Kind index, nearest kerb |
| Kerbs, paint, tier | Parking spots, lazily per chunk |
| Crossings, stops | Zones on lanes, curb spots |
| Land, paths, walls, trees | Surface raster, sidewalks, junction polygons, synthetic street trees and lamps |

Rationale: geometry is tunable without re-import, and consumers stay independent of how the importer works.

### 7.5 Test fixture

`tests/fixtures/mini_map.js` (WP-MAP, generated by `tools/make_fixture.mjs`, encoded with `raw` columns), map ID `mini`.
It is a valid schema 1.0 map, specified exactly so tests written in parallel agree on hand-computed answers.

- Junctions at every `(x, y)` with `x, y` in {-200, 0, 200}. Centre: `SIGNAL`. North-east corner: `RING`. Others: `PRIORITY`.
- 12 straight 2-point edges, each with `a` at its west or south end. The middle east-west road (`y = 0`) is `cls` 2, 50 km/h,
  2 lanes one-way eastbound, `AI_F` only. All other edges are `cls` 4, 30 km/h, two-way with 1 lane each direction, `AI_F` and
  `AI_B`. `laneW` 3.0 m, `parkL` and `parkR` 2.4 m, `swL` and `swR` 2.5 m on every edge.
- `moves`: every incoming arm to every other outgoing arm at each junction, with no U-turns.
- One 40 x 40 m building, 15 m tall, `kind` 1, flat roof, centred in each block at `(±100, ±100)`, `front` 0.
- One POI on the south wall of each building, at `t = 0.5`, `w` 6 m, door 0.5 m south of the wall centre: pharmacy south-west,
  bakery south-east, supermarket north-west, and a school flagged `SENSITIVE` north-east.
- One crossing per edge at `s = 100`. One bus stop on the south road `y = -200`, on the western edge at `s = 100`, `dir` 0,
  adding no kerb buffer.
- Each edge side has 5 kerb rows, `paint` 0, `zone` '': tier 255 over `[0, 12]`, tier 2 over `[12, 95]`, tier 255 over
  `[95, 105]`, tier 2 over `[105, 188]`, tier 255 over `[188, 200]`.
- Bounds `[-400, -400, 400, 400]`, four `BOUNDS` walls on that rectangle, no fence, no sea, and no `trees`, `lots`, `land` or
  `paths` rows. No `spawn` item.

---

## 8. World: derived at load (WP-WORLD)

`TLV.world.build(payload) -> World`, deterministic, no RNG beyond `TLV.rng.hash32`. Target at most 400 ms in Node for
`tlv_center`, excluding lazy parking spots.

Expected scale [M, before clipping]: about 6,000 directed edges, 7,700 lanes, 11,300 connectors, 7,400 conflict pairs,
at most 29 connectors in a junction.

### 8.1 Lane construction

1. For each edge and direction with lanes, take the polyline in travel direction. Backward lanes reverse it.
2. Offset to the right of travel:
   - Two-way: `offR(idx) = (n - idx - 0.5) * laneW` from the polyline.
   - One-way: `offR(idx) = ((n - 1)/2 - idx) * laneW`.
3. Trim each end meeting a junction of kind other than `PASS`:
   `trim = clamp(0.5 * maxCarriagewayWidth(junction) + 1.5, 3, 14)` m, not more than 45% of edge length. That is the stop
   line.
4. Lane length is at least 3 m. If trimming would leave less, reduce both trims proportionally.
5. Flags: `AI_ROUTABLE` from edge `AI_F`/`AI_B`; `NARROW` from edge; `EXCLUSIVE` when `len < vehicleLen(4.4) + 8.5` (142
   lanes [M]). `EXCLUSIVE` lanes admit one car, only when empty.

### 8.2 Connectors

For each `moves` row, assign lanes per section 1.3 so every exit gets at least one lane and every lane gets at least
one exit. With `k` exits and `n` lanes, exit `t` (0 is rightmost) takes lanes
`a = floor(t*n/k)` to `b = max(a, ceil((t+1)*n/k) - 1)`, each mapped to target idx
`round(lane/max(1,n-1) * (nOut-1))`.

- Geometry: cubic Bezier from lane end to target lane start, control length `0.4 * chord`, sampled at 1.5 m.
- `len`: arc length. `vmax = min(fromLane.vmax, toLane.vmax, sqrt(3.0 / kappaMax))`.
- `conflicts`: another connector in the junction with a different source lane whose polyline intersects this one, or
  with the same target lane.
- `priority`: `10 * ring + (6 - cls) + {S:2, R:1, L:0, U:0}`.
- If the chord is under 0.5 m, as at a `PASS` junction whose lanes are untrimmed, the connector is a 2-point polyline with
  `len = max(chord, 0.1)`, `vmax = min(fromLane.vmax, toLane.vmax)`, no conflicts and no gate. A near-zero chord otherwise
  gives a NaN curvature, and `Math.min` propagates it.

### 8.3 Signals

A junction of kind `SIGNAL` gets a controller. Expected about 450 controllers [M]: about 390 clusters and about 60
mid-block lights.

- Slots: cluster approach bearings mod 180 deg at about 40 deg tolerance, capped at 4. **Assert every approach is
  served.** An out-of-range slot is a permanent red.
- Timing depends on the number of vehicle slots `n`, per controller:

| `n` | `greenS` | `amberS` | `allRedS` | `slotS` | `pedS` | `cycleS` | Longest wait |
|---|---|---|---|---|---|---|---|
| 1 | 22 | 3 | 2 | 27 | 12 | 39 | 17 s |
| 2 | 22 | 3 | 2 | 27 | 0 | 54 | 32 s |
| 3 | 14 | 3 | 2 | 19 | 0 | 57 | 43 s |
| 4 | 14 | 3 | 2 | 19 | 0 | 76 | 62 s |

  `pedS` is a synthetic pedestrian slot in which every vehicle connector is red. A one-slot light would otherwise show 5 s of
  non-green in 27, and `pedWalk` would give 5 s for a 7-12 m crossing [M]. The 14 s green keeps a 3-4 slot wait below the clock
  award, which was 59-86 s at a uniform 22 s [M].
- `offset = TLV.rng.hash32(juncId, 77) mod cycleS`. Offsets have no measurable effect on flow [M]; do not invest in green
  waves.
- **Signals are a pure function of time**, so red-runners and telegraphs can query the future:

```text
phase = (S.sig.clock + offset) mod cycleS
if phase >= n * slotS:  slot = -1                       // pedestrian slot
else:                   slot = floor(phase / slotS); r = phase mod slotS
connector in the active slot: GREEN if r < greenS; AMBER if r < greenS + amberS; else RED
every other connector: RED
```

- `S.sig.clock = S.t + S.sig.epoch`. `S.sig.epoch` is set at run start so the first light turns green `greenInS` after
  `flow.startRun` (GAME_DESIGN 19).

### 8.4 Zones

Each crossing creates one zone per lane of its edge at `s` ± 1.5 m. A crossing inside a trimmed region snaps to 1.5 m
before the stop line, or after the start.

Crossing `walk` state: `TLV.world.signals.pedWalk(S, xingId)` is true when the crossing is signalled and all lanes it
crosses are `RED`. An unsignalled crossing is a zebra with no signal state.

### 8.5 Sidewalks

OSM tags cover about 12% of ways [M], so sidewalks are generated, ignoring tags. For each edge side with `sw > 0`,
ribbon centre offset is `kerbOffset + sw/2`, trimmed at junctions. At ends, link to the nearest sidewalk end within 30 m,
going around the corner. At crossings, record a link to the sidewalk on the far side.

`kerbOffset` is `kerbOffL` or `kerbOffR`, per section 6.3.

### 8.6 Props and surface

**Props** (`W.props`) are solid and sim-visible, so WP-WORLD generates them, deterministically, and render must draw them
at these positions. Generated from `trees` (only 278 nodes [M]) and rules in `js/world/tune.js`:

| Rule | Spacing | Species |
|---|---|---|
| Residential sidewalks | 14 m | ficus |
| Seafront sidewalks (within 150 m of `SEA`) | 18 m | palm |
| Tertiary and above | 22 m | ficus |
| Lamps, all sidewalks | 30 m | lamp |

Real tree nodes suppress synthetic trees within 6 m. Positions use `hash32(edgeId, i)` jitter, never the run seed. Tree
collider radius 0.3 m, lamp 0.15 m.

**Surface raster**: 4 m cells over bounds. `TLV.world.surface.at(W, x, y)` returns `SURF.ROAD 0, SIDEWALK 1, PARK 2, SAND 3, WATER 4`.
Precedence: lanes and connectors, then sidewalks, `paths`, `land`. `WATER` is solid for the player.

### 8.7 Colliders

`W.colliders` holds segment arrays for building rings (except `NO_COLLIDER`) and `walls`. `owner` is a building ID, `-1` for
a `BOUNDS` wall, or `-2` for a `MOTORWAY_FENCE`. No lane centreline may cross a collider. This is a WP-MAP gate (section 19),
because only the importer can set `NO_COLLIDER` and cut the fence. WP-WORLD asserts it on `mini` and in soak.

### 8.8 Parking spots

Spots derive lazily per render chunk from kerb rows. See `TLV.world.parking` in section 12.3.

- Spot length 6.5 m, width 2.4 m, parallel, packed along kerb rows with `parkL`/`parkR` above 0 and tier at most 3.
- `spotId = kerbId * 1024 + n`.
- Lateral centre: `kerbOffset - 1.2` m.
- Reject a spot whose centre is inside a footprint.
- Expected about 55,000 spots (prototype 59,966 at 6.0 m [M]).
- Baseline occupancy: `hash32(S.seed, spotId) / 2^32 < 0.88`.

---

## 9. Sim core (WP-CORE)

### 9.1 Fixed step

`DT = 1/60` s. `TLV.sim.step(S)` runs one tick. The loop uses an accumulator:

```text
acc += min(0.1, dtReal) * S.timeScale * timescale
n = 0
while acc >= DT and n < MAX_SUBSTEPS(5): step(S); acc -= DT; n++
if n == MAX_SUBSTEPS: acc = 0      // drop time, never spiral
alpha = acc / DT
render(S, alpha, dtReal)      // see boot step 8
```

**Slow motion** is `S.timeScale`, set by sim code at a known tick. It only changes how many ticks run per real second;
`DT` never changes, so replays stay deterministic. `?timescale` is the separate `timescale` factor held by the loop. It never
writes `S.timeScale`, otherwise the knife's reset clobbers it.

### 9.2 Order of systems in a tick (binding)

| # | Call | Owner | Notes |
|---|---|---|---|
| 0 | `S.tick++; S.t = S.tick * DT` | CORE | |
| 1 | `TLV.sim.snapshot(S)` | CORE | Copies `x,y,h` to `px,py,ph` for active vehicles, pedestrians and foot |
| 2 | `S.controls = S.controlSource(S)` | CORE | Keyboard, bot or replay. Then apply `setInput` overrides, then pass the result to `S.recorder` if set, so the log holds what the sim saw |
| 3 | `TLV.world.signals.update(S)` | WORLD | Caches slot and state per controller |
| 4 | `TLV.game.flow.preUpdate(S, DT)` | GAME | Phase transitions, clock, nav |
| 5 | `TLV.game.director.update(S, DT)` | GAME | Stages incidents, issues commands, updates aims |
| 6 | `TLV.traffic.update(S, DT)` | TRAFFIC | Moves AI, rebuilds broadphase at the end |
| 7 | `TLV.peds.update(S, DT)` | PEDS | Moves people, updates lane obstacles |
| 8 | `TLV.player.update(S, DT)` | PLAYER | Car integration. Always called; returns at once in `FOOT` |
| 9 | `TLV.foot.update(S, DT)` | PLAYER | Always called; returns at once unless `FOOT` |
| 10 | `TLV.collide.update(S, DT)` | PLAYER | Contacts, near misses, pedestrian hits |
| 11 | `TLV.game.parking.update(S, DT)` | GAME | Capture, rival FSM, curb options |
| 12 | `TLV.game.knife.update(S, DT)` | GAME | Encounter FSM and attacker |
| 13 | `TLV.game.score.update(S, DT)` | GAME | Chain timers, bonuses |
| 14 | `TLV.game.flow.postUpdate(S, DT)` | GAME | Run-end checks |
| 15 | `TLV.traffic.maintain(S, DT)` | TRAFFIC | Spawn, despawn, adaptive cap, every 15 ticks; runs its own bucket |
| 16 | `TLV.peds.maintain(S, DT)` | PEDS | Same |
| 17 | `TLV.invariants.run(S)` | CORE | Only if `S.params.invariants` and `S.tick % 60 === 0` |

Rendering reads between ticks. Events fire synchronously to sim listeners during the tick (section 11).

`TLV.sim.step` gates only on the rows above: `S.flags.traffic` disables 6 and 15, `.peds` disables 7 and 16, `.incidents`
disables 5. All else is called every tick and gates itself, which keeps the spy test in section 19 unambiguous.

Every spawn path sets `px, py, ph` equal to the pose, otherwise a pooled slot streaks for one frame after `maintain`.

### 9.3 Random streams

`S.rng` holds one `Rng` per stream, seeded `hash32(seed, streamName)`:

| Stream | Used by |
|---|---|
| `traffic` | Driver params, routing walk, ambient behaviours |
| `spawn` | Spawn sampling |
| `ped` | People |
| `event` | Director |
| `game` | Errand binding, inspector rolls, decoys, rival |
| `foot` | Blockers and chase |
| `bot` | Bot decisions. Excluded from `TLV.sim.hash`, so a replay without the bot matches |

### 9.4 Replay and hash

Log format:

```js
{ header: { version, seed, mapId, contentHash, params }, inputs: [ /* one packed ControlState per tick, run-length encoded */ ] }
```

`contentHash` is FNV-1a over the canonical JSON of `errand`, `incident` and `spawn` items only. Assets, styles and
storefronts never affect the sim.

`TLV.sim.hash(S)` is FNV-1a over the bytes of: `tick`; each active vehicle's `id,x,y,h,v,laneId`; each active
pedestrian's `id,x,y,h`; foot pose; `game.clock, game.money, game.hp`; all RNG states except `bot`.

`chaos` teleports are never logged, so `chaos` runs are not replayable. Replay tests use another source.

---

## 10. Shared state objects

Field lists are exhaustive for cross-package use. A package may add private fields only in an object marked "private" or
with an `_` prefix. Other packages must not read those.

### 10.1 `ControlState`

Plain object reused each tick. Bots and input fill it.

```js
{
  throttle: 0..1, brake: 0..1, steer: -1..1,   // steer + is left
  handbrake: bool, horn: bool, interact: bool, hazard: bool,
  footX: -1..1, footY: -1..1,                  // world-frame move vector while on foot. Input layer rotates by camera yaw
  sidestep: bool, start: bool, restart: bool, recover: bool
}
```

`footX, footY` are world-frame so the sim never depends on the camera, and they are logged. `start` means any key on
title; `restart` means run-end restart. `hazard` is Q held, the "park badly here" verb. `recover` is R or Back held; the sim
reads it only in `DRIVE` and `SEARCH`, and `restart` only in `RUN_END`, so the input layer needs no phase logic. Camera
toggle, rear-view, pause and mute are UI-only and never enter `ControlState`; `input.js` calls them directly (section 12.4).

### 10.2 `Vehicle`

Pooled objects in `S.vehicles`, `MAX_VEHICLES = 200`, created at `sim.create` (section 12.1.8). **Slot 0 is the player's car.**
For slot 0, `laneId` and `lat` mirror `S.player.laneId` and `S.player.lat`, written by PLAYER, and `connId` is -1. Speech
bubbles are not state: they travel only on the `bubble` event (section 11).

```js
{
  // identity
  id: int,            // unique per spawn, never reused. Player is 0
  slot: int,          // index in S.vehicles
  active: bool,
  isPlayer: bool,
  kind: 'hatch'|'sedan'|'taxi'|'van'|'bus'|'truck',
  variant: 0..7,      // palette
  length, width, wheelbase: number,    // m
  // pose (body centre)
  x, y, h: number,    px, py, ph: number,    // current and previous tick
  v: number,          // signed forward speed, m/s
  vx, vy: number,     // world velocity, m/s
  yawRate: number,    accel: number,    steer: number,   // rad, + left, render use
  // lane frame
  mode: 'LANE'|'CONN'|'FREE'|'DYNAMIC'|'REJOIN'|'WRECK'|'PARKED'|'SCRIPT',
  laneId: int,        // -1 if none
  connId: int,        // -1 if none
  s: number,          // along lane or connector, at body centre
  lat: number,        // m, + left
  // presentation
  lights: int,        // bitmask VL: BRAKE 1, HAZARD 2, BLINK_L 4, BLINK_R 8, REVERSE 16, HIGH_BEAM 32
  horn: bool,
  door: 0|1|2,        // 0 closed, 1 left front open, 2 right front open
  // behaviour
  beh: string,        // section 10.3
  behT: number,       // seconds in beh
  ag: number,         // 0..1. Player 0
  stuckT: number,
  _t: object          // private to WP-TRAFFIC: driver params, route, grants
}
```

Vehicle sizes (m): hatch 4.0 x 1.75; sedan 4.4 x 1.8; taxi 4.4 x 1.8; van 5.2 x 2.0; bus 12.0 x 2.55; truck 7.5 x 2.4.
Spawn mix: sedan 54, hatch 22, taxi 10, van 8, bus 4, truck 2 (percent).

Mode meanings:

| Mode | Owner | Meaning |
|---|---|---|
| `LANE`, `CONN` | TRAFFIC | Kinematic on path |
| `FREE` | PLAYER | Player only |
| `DYNAMIC` | TRAFFIC | After impact, 2-4 s friction body, leaves lane logic, stays an obstacle |
| `REJOIN` | TRAFFIC | 1.5 s Hermite back to the lane, if offset under 1.5 m, heading error under 25 deg, `v` under 2 m/s |
| `WRECK` | TRAFFIC | Hazards on, an obstacle for at most 6 s, then `TOWED`, in view or not, so a wreck can never box in the player |
| `PARKED` | TRAFFIC | Stationary, not on lanes (materialized, or a rival once settled) |
| `SCRIPT` | TRAFFIC | Pose-driven path: stall entry, stand-off, tow |

### 10.3 Behaviour IDs (`Vehicle.beh`)

`'CRUISE','RED_RUN','TAILGATE','NOSE_IN','OVERTAKE_OUT','OVERTAKE_PASS','CUT_IN','PHANTOM_STOP',`
`'DROP_APPROACH','DROPPED','PULLOUT','BUS_APPROACH','BUS_STOPPED','BUS_PULLOUT','DOUBLE_PARK','REVERSE_FOR_SPOT',`
`'DOOR_OPEN','PARK_RACE','PARK_HOLD','RIVAL_BLOCK','RIVAL_STANDOFF','TOWED','PULL_OVER','WRONG_WAY'`

`TLV.const.BEHAVIOURS` lists them. Each except `CRUISE` must have a timeout that returns to `CRUISE` or despawns. `HONK` in
GAME_DESIGN 9 is an action any car can take, not an FSM state: it sets `Vehicle.horn` and emits `traffic.honk`.

### 10.4 `Pedestrian`

Pooled in `S.peds`, `MAX_PEDS = 96`. Two-wheeler riders are `Pedestrian` records, so all person rules apply.

```js
{
  id: int, slot: int, active: bool,
  kind: 'walker'|'phone'|'trolley'|'scooter'|'delivery'|'passenger'|'saver'|'inspector'|'attacker',
  variant: 0..15,
  x, y, h: number,  px, py, ph: number,
  v: number,          // m/s
  r: number,          // collision radius: walker 0.35, riders 0.6
  state: 'WALK'|'WAIT_CROSS'|'CROSS_LEGAL'|'CROSS_SLOW'|'JAYWALK'|'RED_CROSS'|'STROLL_ROAD'|'DROPPED'|'FLEE'|'STUMBLE'|'SCRIPT',
  stateT: number,
  onRoad: bool,
  intent: bool,       // readable intent flag, true for at least 0.8 s before stepping out
  anim: 'idle'|'walk'|'run'|'ride'|'phone'|'glare'|'tug'|'lunge'|'stumble'|'sit',
  hasKnife: bool,     // attacker only
  _p: object          // private to WP-PEDS
}
```

`state: 'SCRIPT'` is used only by the attacker. WP-PEDS does not move that record; WP-GAME writes `x, y, h, v, anim, hasKnife`.
WP-PEDS still computes `onRoad` from `TLV.world.surface.at` and reports it as a lane obstacle, so AI brakes for him.
`TLV.peds.onHit` on a `SCRIPT` pedestrian changes no state, so hitting him only takes the penalty path. Savers and inspectors
are driven by WP-PEDS through the commands in 13.2.

### 10.5 `PlayerState` (`S.player`)

```js
{
  mode: 'DRIVE'|'SNAP'|'LOCKED'|'FOOT',
  veh: Vehicle,        // S.vehicles[0]
  fx, fy: number,      // focus point: car centre, or foot position. Bubble and director centre here
  surface: int,        // SURF.*
  laneId: int, lat: number,        // nearest lane, -1 if none within 6 m
  wrongWay: bool,
  launchT: number,     // seconds left of Green Launch boost
  foot: FootState
}

FootState {
  active: bool, x, y, h, v, px, py, ph,
  stumbleT, invulnT, slowT, sidestepT, sidestepCd: number,
  anim: 'idle'|'run'|'sidestep'|'stumble'
}
```

### 10.6 Static world shapes

All immutable after build. Read-only to every package.

World values are decoded. All lengths and coordinates are metres, including `laneW, parkL, parkR, swL, swR, Kerb.s0, Kerb.s1,
Crossing.s, BusStop.s, Poi.w, Building.h`. `Poi.bld, Poi.wall, Poi.edge` are plain IDs, -1 for none. `Poi.t` is 0..1 along the
wall. All `Str` columns are strings, `''` for none. `Building.kind` and `Building.roof` stay numeric. `Junction.kind` is the
string shown below.

```js
World {
  id, meta, bounds: {minX,minY,maxX,maxY}, strings: string[],
  juncs: Junction[], edges: Edge[], dirEdges: (DirEdge|null)[], lanes: Lane[], conns: Connector[],
  ctrls: SignalCtrl[], zones: Zone[], xings: Crossing[], stops: BusStop[],
  blds: Building[], pois: Poi[], kerbs: Kerb[], lots: Lot[], land: LandPoly[], paths: PathLine[], walls: WallLine[],
  sidewalks: Sidewalk[], props: Prop[],
  colliders: { n, ax, ay, bx, by: Float32Array, owner: Int32Array },   // owner: building id, -1 BOUNDS, -2 MOTORWAY_FENCE
  index: object        // private to WP-WORLD
}

Junction { id, x, y, kind: 'PASS'|'PRIORITY'|'SIGNAL'|'RING', flags,
           inDir: Int32Array, outDir: Int32Array, conns: Int32Array, ctrl: int /* -1 */, poly: Float32Array /* x,y pairs, CCW */ }

Edge { id, a, b, px: Float32Array, py: Float32Array, cum: Float32Array, len, cls, lanesF, lanesB, kmh, laneW,
       parkL, parkR, swL, swR, kerbOffL, kerbOffR, flags, name: string, nameEn: string, osm }

DirEdge { id, edge, dir: 0|1, from, to, lanes: Int32Array /* by idx */, len, cls, vmax, aiRoutable: bool,
          moves: Int32Array /* outgoing dirEdge ids */, hIn, hOut }

Lane { id, edge, dirEdge, idx, len, vmax, width, cls, flags,  // LF: AI_ROUTABLE 1, EXCLUSIVE 2, NARROW 4
       px, py, cum: Float32Array, left, right, opposite: int /* -1 */, conns: Int32Array, zones: Int32Array /* sorted by s0 */,
       stops: Int32Array }

Connector { id, from, to /* lane ids */, junc, turn: 'S'|'R'|'L'|'U', len, vmax, px, py, cum: Float32Array,
            conflicts: Int32Array, priority, slot: int /* signal slot, -1 */ }

SignalCtrl { id, junc, offset, cycleS, greenS, amberS, allRedS, slotS, pedS, slots: Int32Array[] /* dirEdge ids per vehicle slot */ }

Zone { id, laneId, s0, s1, xing }
Crossing { id, x, y, edge, s, signal: bool, zones: Int32Array, ctrl: int, swA: int, swB: int }
BusStop { id, x, y, edge, dir, s, laneId, name: string }

Building { id, osm, osmT, h, levels, kind, roof, colour, style, flags, name, nameEn,
           rings: Float32Array[] /* x,y pairs; [0] outer CCW */, front: Uint8Array /* outer ring */, cx, cy, minX, minY, maxX, maxY }

Poi { id, x, y, kind, nameHe, nameEn, osm, osmT, bld, wall, t, w, entX, entY, edge, flags }

Kerb { id, edge, side, s0, s1, form, paint: 0|1|2|3, zone, tier }

Sidewalk { id, edge, side, px, py, cum: Float32Array, len, width, links: [{ sw, atEnd: bool, toStart: bool }], xings: Int32Array }

Prop { id, kind: 'ficus'|'palm'|'other'|'lamp', x, y, r }
Lot { id, kind, poly: Float32Array, entX, entY, name }
LandPoly { id, cls, poly: Float32Array }
PathLine { id, cls, px, py: Float32Array, name }
WallLine { id, kind, px, py: Float32Array }
```

### 10.7 `ParkingSpot`

Returned by `TLV.world.parking.spot`. Immutable. Do not retain across chunks in hot paths.

```js
ParkingSpot {
  id: int, kerb: int, edge: int, side: 0|1,
  x, y, h: number,     // centre; h is along the adjacent lane's travel direction
  len: 6.5, wid: 2.4,
  paint: 0|1|2|3, zone: string, tier: int,
  laneId: int, laneS: number     // adjacent lane and position
}
```

`S.parking` (dynamic, owned by WP-WORLD):

```js
{ overrides: Map<int, int> }   // spotId -> OCC_FREE 0, OCC_PARKED 1, OCC_VEHICLE 2, OCC_MOTO 3
```

`OCC_VEHICLE` means a live `Vehicle` is there, so no static car is drawn or collided. Keys are integers, so `Map`
insertion order stays deterministic.

### 10.8 `Route`

```js
Route {
  dirEdges: Int32Array, len: number,
  px, py, cum: Float32Array,        // lane-centre polyline for arrow and minimap, 3 m spacing or better
  fromS: number, toS: number        // along first and last dirEdge
}
```

### 10.9 `GameState` (`S.game`, owned by WP-GAME)

```js
GameState {
  phase: 'TITLE'|'CARD'|'DRIVE'|'SEARCH'|'HOLD'|'PAYOUT'|'BLOCKED'|'ENCOUNTER'|'RESOLVE'|'RUN_END',
  phaseT: number,
  clock: number,            // seconds
  money: number,            // shekels
  hp: number,               // 0..100
  errandIndex: int,         // 0..6
  errand: Errand|null,
  contest: Contest|null,
  knife: KnifeEncounter|null,
  nav: Nav,
  park: ParkState,
  chain: { n: int, mult: number, windowT: number, bank: number },
  contacts: int,            // this errand, excluding rearEnded contacts
  pedHits: int,             // this run
  pedHitThisErrand: bool,
  knivesDone: int,
  lastKnifeErrand: int,     // -1
  heat: number,             // 0..1
  director: { state: 'BUILD'|'PEAK'|'BREATHE', stateT: number, nextT: number, incidents: Incident[] },
  obstacles: Obstacle[],    // staged chase blockers
  stats: RunStats,
  endReason: null|'CLOCK'|'TOWED'|'CAUGHT'|'REVOKED'|'WIN',
  rank: string|null         // key such as 'NEW_DRIVER'; strings.js holds the text
}

ParkState {
  stage: null|'ARMED'|'SNAP'|'FILL',
  kind: null|'BAY'|'CURB'|'DOUBLE',
  bar: number,              // 0..1 for the HUD: across SNAP and FILL for a bay, across the Q hold otherwise
  x, y, h: number           // pose being parked into
}

RunStats { honksReceived, spotsStolen, nearMisses, contacts, errandsDone, redsRun,
           incidents: { staged, avoided, hit, aborted, byId: {} } }

Errand {
  index: int,               // 0-based, like errandIndex and every event index. ?errand= is 1-based
  defId: string, text: { he, en },    // {poi} already resolved
  poiId: int,               // -1 for synthetic
  name: { he, en },
  doorX, doorY: number,
  routeLen: number,         // bay route, locked when the first bay is set. Drives award and pay. GAME_DESIGN 7
  award: number,            // base clock seconds; the method multiplier M applies on parking
  bayId: int,               // current bay, the only stall that can arm capture. -1 when none remains
  decoys: [{ spotId, kind: 'MOTORBIKE'|'SAVER', pedId: int }],
  contests: int,
  quality: null|'PERFECT'|'GOOD'|'UGLY'|'DOUBLE',
  parkMethod: null|'BAY'|'RED_WHITE'|'RED_YELLOW'|'DOUBLE',
  pay: number|null,         // null until computed
  mod: null
}

Contest {
  rivalId: int,             // vehicle id
  spotId: int,
  state: 'CRUISE'|'BLINK'|'CREEP'|'COMMIT'|'WON'|'DENIED'|'FAILED',
  stateT: number,
  ctl: RaceCtl,             // shared with the PARK_RACE command, section 13.1
  steal: bool,              // set when the player arms, GAME_DESIGN 14
  rage: number,             // live, shown by gauge
  factors: { blinkerFirst, passed, close, honked: bool, steals: int },
  tier: null|'CURSE'|'BLOCK'|'KNIFE',
  winner: null|'player'|'rival'
}

RaceCtl { speedScale: number, mayBlink: bool, holdCreep: bool }

KnifeEncounter {
  stage: 'STANDOFF'|'DOOR_TUG'|'BAIL'|'DRAGGED'|'CHASE'|'RESOLVE',
  stageT: number,
  tugBar: number,           // 1 to 0
  attackerId: int,          // pedestrian id
  rivalVehId: int,
  gap: number,              // metres of path between attacker and player
  strikes: int,             // 0..3, per encounter
  lunge: 'NONE'|'WINDUP'|'STRIKE'|'RECOVER',
  lungeT: number,
  outOfSightT: number,
  shaken: bool, shakenT: number,      // GAME_DESIGN 15.4
  exit: null|'REACHED_SHOP'|'SHAKEN'|'WHISTLE'|'CAUGHT'
}

Nav {
  route: Route|null,        // to the current bay, from errand start
  s: number,
  remaining: number,        // metres of route left to the bay; Infinity with no route
  targetX, targetY: number,
  arrowH: number,           // heading of 3D arrow, toward route point 30 m ahead; direct bearing to the door on foot
  offRoute: bool, offRouteT: number, recalcT: number
}

Obstacle { id, kind: 'CHAIRS'|'LEASH'|'CHATTERS'|'FALLEN_SCOOTER', x, y, r, active: bool }

Incident {
  id: int, defId: string,
  state: 'TELEGRAPH'|'ACTIVE'|'COMMIT'|'DONE',
  startT: number,
  anchor: { type: string, x, y, laneId, s },
  aim: Aim,
  actors: [{ type: 'veh'|'ped', id: int }],
  minGap: number, contacted: bool,
  outcome: null|'AVOIDED'|'HIT'|'ABORTED'
}

Aim { x, y: number, tImpact: number /* absolute S.t */, frozen: bool }
```

Phase transitions (binding):

| From | Event | To |
|---|---|---|
| `TITLE` | `controls.start`, or the first `flow.preUpdate` with `notitle` | `flow.startRun`, then `CARD` |
| `CARD` | The later of its timer (3 s on errand 1, else 2 s) and pull-out completion | `DRIVE` |
| `DRIVE` | `nav.remaining` at most 140 m | `SEARCH`; the contest starts here |
| `DRIVE` or `SEARCH` | Capture armed, or Q hold started (GAME_DESIGN 12.3) | `HOLD` |
| `HOLD` | Cancelled | `SEARCH` if `nav.remaining` is at most 140 m, else `DRIVE` |
| `HOLD` | Bar full | `PAYOUT` |
| `PAYOUT` | +0.3 s, contest tier `BLOCK` | `BLOCKED` (5 s), then back to `PAYOUT` |
| `PAYOUT` | +0.3 s, contest tier `KNIFE` | `ENCOUNTER` |
| `ENCOUNTER` | `knife.exit` set, not `CAUGHT` | `RESOLVE` (4 s, skippable) |
| `RESOLVE` or `PAYOUT` | Done, errand 7 | `RUN_END`, reason `WIN` |
| `RESOLVE` or `PAYOUT` | Done, otherwise | `CARD`, with car pulled out to the lane and the next errand bound |
| Any live phase | Clock 0, HP 0, second pedestrian hit, strike 3 | `RUN_END` |
| `RUN_END` | `controls.restart` | `flow.startRun`, then `CARD`, a new run on the same `S`. RNG streams continue, so replays stay valid |

**The `HOLD` to `PAYOUT` tick**, in this order: compute `rage` and the final `tier`; apply the clock award `award * M`, the
SPOTLESS bonus and inspector rolls; if the tier is not `KNIFE`, compute pay and emit `errand.parked`; if it is, emit
`errand.parked` with `pay: null`. The 0.3 s is a reveal delay: `contest.result` is emitted at +0.3 s. At `RESOLVE` entry
compute pay with the exit multiplier and emit `errand.paid`. `PAYOUT` lasts 2.5 s. `BLOCKED` saves `phaseT`; the return
restores it and does not re-run entry, so nothing is paid twice.

**Locks.** Driving controls are locked from `TITLE` until `DRIVE`, and from `park.stage` `SNAP` until the next `DRIVE`, through
`TLV.player.setLocked`. `ARMED` leaves the player in control.

**Recover.** In `DRIVE` or `SEARCH`, `controls.recover` held 1.5 s below 1 m/s makes `flow.preUpdate` call
`TLV.player.setPose` on the nearest `AI_ROUTABLE` lane centre in travel direction, apply -15 s and -₪100, recalculate nav and
emit `player.recover`. It counts as no contact.

**Pull-out rule.** A parked car between two others cannot always steer out. At `CARD` entry after parking,
`TLV.player.snapTo` moves the car to the adjacent lane centre over 1.0 s in travel direction, with parked-car collision
off during the snap. If a vehicle occupies the target within 8 m, it waits up to 3 s, then proceeds. This can take 4 s, so
`CARD` always outlasts it.

---

## 11. Event bus

`S.bus` is created per sim. Two delivery paths:

- **Sim listeners**: `S.bus.on(name, fn)`. Called synchronously inside `emit`, in subscription order. Subscribe only in
  `init` functions, so order is deterministic.
- **Frame consumers** (render, UI, audio): `S.bus.drain(fn)` once per rendered frame, receiving `(name, payload)` for
  every event since the last drain, in order. Buffering is off until `S.bus.enableDrain()`, called by `TLV.ui.init`, so
  headless runs buffer nothing. The buffer is capped at 2,048; the oldest are dropped. Sim listeners must never use `drain`.

Payloads are small plain objects, freshly allocated: never reuse a payload object, since `drain` reads it later. All `x, y`
are metres. Events below are the complete cross-package list. Anything else is private and prefixed `_`.

In the Listeners column, a module name is a sim listener. RENDER, UI and AUDIO are frame consumers. `soak` is `tools/soak.mjs`,
and `debug` is `js/ui/debug_overlay.js`. Read-only test and soak listeners may subscribe after `create`, because they change
nothing.

| Event | Emitter | Listeners | Payload |
|---|---|---|---|
| `player.contact` | PLAYER | GAME `score`, `director`; RENDER; UI; AUDIO | `{ kind: 'vehicle'\|'parked'\|'static', otherId, vn, severity: 'scrape'\|'bump'\|'crash', rearEnded: bool, x, y }`. Never emitted for a `BOUNDS` wall or the water edge |
| `player.hitPed` | PLAYER | GAME `score`; UI; AUDIO | `{ pedId, pedKind, speed, x, y }` |
| `player.nearMiss` | PLAYER | GAME `score`; RENDER; AUDIO | `{ vehId, gap, relSpeed, tier: 1\|2, x, y }` |
| `player.wrongWay` | PLAYER | UI | `{ on: bool }` |
| `player.surface` | PLAYER | RENDER; AUDIO | `{ surface }` |
| `player.mode` | PLAYER | RENDER; UI | `{ mode }` |
| `player.brushPed` | PLAYER | AUDIO | `{ pedId }` |
| `player.horn` | PLAYER | TRAFFIC; PEDS; GAME `rage`; AUDIO | `{ x, y, h }`, on the rising edge and each 1 s held. TRAFFIC applies the +30% accel cone, PEDS the freeze and glare, GAME the rage factor |
| `player.launch` | PLAYER | GAME `score`; UI; AUDIO | `{ }`, Green Launch earned. PLAYER applies the boost, GAME pays the bonus |
| `player.redRun` | PLAYER | GAME `score`; UI | `{ juncId }`, when the car crosses a stop line whose connector state is `RED`. UI shows "The camera has been broken since 2019." on the first one |
| `player.waterEdge` | PLAYER | UI | `{ x, y }`, on touching `WATER`. UI shows "The sea is not a shortcut." |
| `player.recover` | GAME | UI | `{ x, y }` |
| `traffic.spawn` | TRAFFIC | RENDER; `debug` | `{ vehId, kind }` |
| `traffic.despawn` | TRAFFIC | GAME `rival`, `incidents`; `debug` | `{ vehId, reason: 'range'\|'watchdog'\|'script'\|'wreck' }` |
| `traffic.behaviour` | TRAFFIC | GAME `incidents`; `soak`; `debug` | `{ vehId, beh, prev }` |
| `traffic.redRun` | TRAFFIC | AUDIO; `soak` | `{ vehId, juncId }` |
| `traffic.honk` | TRAFFIC | GAME `score`; UI; AUDIO | `{ vehId, atPlayer: bool, x, y }` |
| `traffic.wreck` | TRAFFIC | GAME `incidents`; AUDIO | `{ vehId }` |
| `traffic.parkRace` | TRAFFIC | GAME `rival` | `{ vehId, stage: 'BLINK'\|'CREEP'\|'COMMIT'\|'IN_SPOT'\|'FAILED', spotId }` |
| `traffic.door` | TRAFFIC | GAME `incidents`; AUDIO | `{ vehId, open: bool }` |
| `ped.spawn` | PEDS | `debug` | `{ pedId, kind }` |
| `ped.despawn` | PEDS | GAME `parking`, `incidents`; `debug` | `{ pedId }` |
| `ped.intent` | PEDS | GAME `incidents` | `{ pedId }` |
| `ped.stepOut` | PEDS | GAME `incidents` | `{ pedId, state }` |
| `ped.bell` | PEDS | AUDIO | `{ pedId }` |
| `nav.recalc` | GAME | UI | `{ }` |
| `errand.start` | GAME | UI; AUDIO | `{ index, defId }` |
| `errand.search` | GAME | RENDER; UI | `{ bayId }` |
| `errand.parked` | GAME | UI; AUDIO | `{ index, quality, method, pay: number\|null, award, spotless: bool }`. `pay` is null on a knife errand, and `award` is the seconds actually applied |
| `errand.paid` | GAME | UI | `{ index, pay, exit }`, at `RESOLVE` entry on a knife errand only |
| `inspector.ticket` | GAME | UI; AUDIO | `{ amount, kind: 'TICKET'\|'TOW' }` |
| `contest.start` | GAME | UI; AUDIO | `{ rivalId, spotId }` |
| `contest.state` | GAME | UI | `{ state }` |
| `contest.result` | GAME | UI; AUDIO | `{ winner, tier }`. `tier` is null when the player took the bay without a steal |
| `knife.stage` | GAME | RENDER; UI; AUDIO | `{ stage }` |
| `knife.lunge` | GAME | RENDER; AUDIO | `{ phase: 'WINDUP'\|'STRIKE'\|'RECOVER' }` |
| `knife.strike` | GAME | RENDER; UI; AUDIO | `{ strikes }` |
| `knife.exit` | GAME | UI; AUDIO | `{ exit }` |
| `incident.telegraph` | GAME | UI; AUDIO | `{ id, defId, x, y }`. UI shows a direction chevron, so a muted player gets the telegraph too |
| `incident.end` | GAME | `debug` | `{ id, defId, outcome }` |
| `score.bonus` | GAME | UI; AUDIO | `{ id, amount, seconds }`. `id` is one of `BEAT_THE_HONK, HANDBRAKE_PARK, AFTER_YOU, GAVE_WAY, SPOTLESS, EXIT_REACHED_SHOP`, and `strings.js` keys its text on `id` |
| `score.chain` | GAME | UI | `{ n, mult, bank }` |
| `clock.warn` | GAME | UI; AUDIO | `{ level: 1\|2 }` |
| `run.start` | GAME | RENDER; UI; AUDIO | `{ seed }` |
| `run.end` | GAME | UI; AUDIO | `{ reason, money, rank, stats }`. `rank` is a key |
| `bubble` | TRAFFIC, PEDS, GAME | UI | `{ who: 'veh'\|'ped', id, text, ttl }`. Text is symbols only. This is the only path for speech bubbles |

---

## 12. Module APIs

Signatures use `S` for `SimState`, `W` for `World`. `out` parameters are caller-owned. Anything not listed is private.
Every API must tolerate `-1` IDs by returning `null`, `false` or `0`.

### 12.1 WP-CORE

#### 12.1.1 `TLV.const` (`constants.js`)

```js
DT: 1/60, TICK_HZ: 60, MAX_SUBSTEPS: 5, MAX_VEHICLES: 200, MAX_PEDS: 96,
UNIT: 0.1, M_PER_DEG_LAT: 110888, M_PER_DEG_LON: 94415,
ROAD: { PRIMARY:0, SECONDARY:1, TERTIARY:2, UNCLASSIFIED:3, RESIDENTIAL:4, LIVING:5, SERVICE:6 },
LF: { AI_ROUTABLE:1, EXCLUSIVE:2, NARROW:4 },
EF: { ROUNDABOUT:1, BRIDGE:2, NARROW:4, AI_F:8, AI_B:16, LINK:32 },
VL: { BRAKE:1, HAZARD:2, BLINK_L:4, BLINK_R:8, REVERSE:16, HIGH_BEAM:32 },
SURF: { ROAD:0, SIDEWALK:1, PARK:2, SAND:3, WATER:4 },
SIG: { GREEN:0, AMBER:1, RED:2 },
OCC: { FREE:0, PARKED:1, VEHICLE:2, MOTO:3 },
PAINT: { NONE:0, RED_WHITE:1, RED_YELLOW:2, BLUE_WHITE:3 },
POIF: { NAMED:1, INTERIOR:2, SENSITIVE:4, NO_FACADE:8 },
BEHAVIOURS: [...], PED_STATES: [...], PHASES: [...], VEHICLE_SIZES: {...},
newVehicle(slot) -> Vehicle, newPedestrian(slot) -> Pedestrian, newGameState() -> GameState   // every field defaulted
```

#### 12.1.2 `TLV.math` (`math.js`)

```js
clamp(x, a, b), lerp(a, b, t), invLerp(a, b, x), smoothstep(a, b, x), sign(x)
wrapPi(a) -> (-pi, pi]; angDiff(a, b) -> wrapPi(a - b)
dist(ax, ay, bx, by), dist2(ax, ay, bx, by)
polyLen(px, py) -> number
cumLen(px, py) -> Float32Array
polyAt(px, py, cum, s, out) -> out {x, y, h}     // clamps s
polyProject(px, py, cum, x, y, hintS, out) -> out {s, d, side}  // side + is left
segSegHit(ax,ay,bx,by, cx,cy,dx,dy) -> bool
pointSegDist(px,py, ax,ay,bx,by) -> number
pointInPoly(x, y, poly) -> bool
obbOverlap(a, b) -> bool             // a,b: {x,y,h,length,width}
obbGap(a, b) -> number               // separation, m, <=0 when overlapping
obbSat(a, b, out) -> bool            // out {nx, ny, depth, cx, cy}
```

#### 12.1.3 `TLV.rng` (`rng.js`)

Mulberry32.

```js
create(seed) -> Rng
Rng: next() -> [0,1); int(n) -> 0..n-1; range(a, b) -> float; bool(p); pick(arr); beta22(); state() -> uint32; setState(u)
hash32(...ints) -> uint32           // FNV-1a over 32-bit ints, stable forever
hashStr(str) -> uint32
```

#### 12.1.4 `TLV.events` (`events.js`)

```js
createBus() -> Bus
Bus: on(name, fn); off(name, fn); emit(name, payload); enableDrain(); drain(fn)
```

#### 12.1.5 `TLV.config` (`config.js`)

```js
normalize(obj) -> Params          // applies the section 16.1 defaults to a partial object
parse(queryString) -> Params      // normalize() of the parsed query, numbers coerced
```

`seed` defaults to `null` here, because `js/core` may not read the clock: `main.js` fills `Date.now() >>> 0`, and Node fills 1.
`TLV.params` is set by loader or Node. Code reads `S.params`, not `TLV.params`.

#### 12.1.6 `TLV.registry` (`registry.js`)

```js
on(type, fn); drain(); problem(type, id, reason); problems() -> [{type, id, reason}]; contentHash() -> uint32
```

#### 12.1.7 `TLV.invariants` (`invariants.js`)

```js
register(name, fn)       // fn(S) -> null | string (failure text)
run(S) -> string[]       // failures, also pushed to S.invariantFailures (max 100)
```

Each package registers its own in `register()`. Section 17.3 lists required ones.

#### 12.1.8 `TLV.sim` (`sim.js`)

```js
create(opts) -> S
  opts: { seed?: int, world: World, params?: object, controlSource?: fn, allowMissing?: bool, flags?: {traffic, peds, incidents} }
step(S)
snapshot(S)
hash(S) -> uint32
```

`create` does this, in order:

1. `S.params = TLV.config.normalize(opts.params)`. The seed is `opts.seed`, else `S.params.seed`, else 1.
2. Build RNG streams, the bus and `S.flags`.
3. Zero `S.controls`. Set `S.controlSource` to `opts.controlSource`, else `TLV.bots.create(S.params.autoplay)` if set, else a
   function returning `S.controls`. `TLV.input.init` replaces this default in the browser (section 12.4).
4. Build `S.vehicles` and `S.peds` at full length from `TLV.const.newVehicle(slot)` and `newPedestrian(slot)`, with every field
   defaulted, `active: false`, and `_t: {}` or `_p: {}`. `pool.js` in TRAFFIC and PEDS only allocates and frees slots. Slot 0 is
   never in the vehicle free list.
5. `S.recorder = TLV.replay.createRecorder(S)` if `S.params.record`, else null.
6. Call `TLV.world.parking.init(S)`, `TLV.world.signals.init(S)`, `TLV.player.init(S)`, `TLV.traffic.init(S)`, `TLV.peds.init(S)`,
   `TLV.game.flow.init(S)`. These create `S.parking`, `S.sig`, `S.player`, `S.traffic`, `S.pedsys` and `S.game` respectively.
   `player.init` activates slot 0 with `id 0, isPlayer true, mode 'FREE', kind 'hatch'`. `flow.init` calls the other WP-GAME
   `init` functions. Bus subscriptions happen in these `init` calls, so their order is fixed.

With `allowMissing`, a missing function in the step table or the `init` chain is skipped with one warning, so a package can test
alone. `create` then fills what is absent: `S.player` with `{ mode: 'DRIVE', veh: S.vehicles[0], fx: 0, fy: 0 }`, slot 0
activated as above, and `S.game` with `TLV.const.newGameState()` at `phase: 'DRIVE'`.

`SimState`:

```js
{
  seed, tick, t, timeScale: 1, params, flags: {traffic, peds, incidents},
  world: World, bus: Bus,
  rng: { traffic, spawn, ped, event, game, foot, bot },
  vehicles: Vehicle[], peds: Pedestrian[],
  player: PlayerState, parking: {...}, sig: { clock, epoch, slot: Int8Array, state: Int8Array, forced: object|null },
  traffic: object /* private except stats */, pedsys: object /* private */,
  game: GameState, controls: ControlState, controlSource: fn, recorder: object|null, invariantFailures: string[]
}
```

`S.traffic.stats` is public, read-only: `{ count, cap, meanSpeed, stationaryShare, removals, wrecks }`.

#### 12.1.9 Shared tuning keys

Other packages may read these. Their owner must define them with these exact names.

| Key | Value | Owner |
|---|---|---|
| `TLV.tune.player.brake` | 14 | PLAYER |
| `TLV.tune.player.topSpeed` | 26.4 | PLAYER |
| `TLV.tune.player.footSpeed` | 6.4 | PLAYER |
| `TLV.tune.traffic.bubbleSpawnMin`, `.bubbleSpawnMax`, `.bubbleDespawn` | 140, 300, 390 | TRAFFIC |
| `TLV.tune.traffic.hardBrake` | 8 | TRAFFIC |
| `TLV.tune.traffic.visibleM`, `.visibleDeg` | 170, 75 | TRAFFIC |
| `TLV.tune.traffic.parkBlinkM`, `.parkCommitM` | 30, 10 | TRAFFIC |
| `TLV.tune.peds.intentS` | 0.8 | PEDS |
| `TLV.tune.world.spotLen`, `.spotWid` | 6.5, 2.4 | WORLD |

#### 12.1.10 `TLV.loop` (`loop.js`)

DOM-free. `main.js` injects `raf` and `now`.

```js
create({ S, step, render, raf, now, timescale }) -> Loop
Loop: start(); stop(); pause(); resume(); stepN(n); isPaused()
```

`render` is `render(S, alpha, dtReal)`. `pause()` stops steps; render continues, so the pause screen stays live.

#### 12.1.11 `TLV.replay` (`replay.js`)

```js
createRecorder(S) -> { record(controls), finish() -> ReplayLog }
createPlayer(log) -> controlSource
```

#### 12.1.12 `TLV.app` (`main.js`, browser only)

```js
boot(); S: SimState; loop: Loop
```

### 12.2 WP-MAP

```js
TLV.mapCodec.decodeAll(payload) -> Decoded        // section 7.2
TLV.mapCodec.decodeColumn(enc, data) -> TypedArray
TLV.anchors.resolve(W, anchor, opts) -> { how: 'exact'|'moved'|'relocated'|'orphan', type, id, ids } // section 14.2
```

`opts.type` is required: `'building'`, `'poi'` or `'edge'`. A way ID can be both a building and a POI, so the type is never
guessed. `ids` lists every match, in travel order for edges, and `id` is `ids[0]`. 1,169 of 3,824 kept ways split into several
edges [M]. An orphan returns `id: -1, ids: []`. `TLV.anchors` must also work in the importer on an intermediate structure,
through an adapter passed as `opts.index`.

### 12.3 WP-WORLD

```js
// world.js
TLV.world.register()
TLV.world.build(payload) -> W
TLV.world.get(mapId) -> W | null                // cached build of the drained map

// map.js
TLV.world.map.onMap(payload)
TLV.world.map.payload(mapId) -> payload

// geom.js
TLV.world.geom.offsetPolyline(px, py, offRight) -> { px, py }   // offRight + is right of direction
TLV.world.geom.bezierPoly(p0, p1, p2, p3, spacing) -> { px, py }

// lanes.js
TLV.world.lanes.pointAt(W, laneId, s, out) -> out {x, y, h}
TLV.world.lanes.connPointAt(W, connId, s, out) -> out {x, y, h}
TLV.world.lanes.project(W, x, y, h, maxDist, out) -> out {laneId, s, lat, dist, headingErr} | null
   // h may be null to ignore heading. Prefers lanes whose heading is within 90 deg of h
TLV.world.lanes.lanesNear(W, x, y, r, out: Int32Array) -> count
TLV.world.lanes.nextConns(W, laneId) -> Int32Array

// junctions.js
TLV.world.junctions.ahead(W, laneId) -> juncId
TLV.world.junctions.connFor(W, laneId, toDirEdge) -> connId | -1

// signals.js
TLV.world.signals.init(S)
TLV.world.signals.update(S)
TLV.world.signals.connState(S, connId) -> SIG.*             // PASS and PRIORITY junctions return GREEN
TLV.world.signals.laneState(S, laneId) -> SIG.*             // Rightmost connector's state; GREEN if unsignalled
TLV.world.signals.stateAt(S, connId, t) -> SIG.*            // pure, any future t
TLV.world.signals.timeToGreen(S, connId) -> seconds         // 0 if green
TLV.world.signals.timeToRed(S, connId) -> seconds           // Infinity if unsignalled
TLV.world.signals.pedWalk(S, xingId) -> bool
TLV.world.signals.alignGreen(S, connId, seconds)            // sets S.sig.epoch so connId turns green in `seconds`
TLV.world.signals.force(S, juncId, state, holdS)            // debug override

// spatial.js
TLV.world.spatial.collidersNear(W, x, y, r, out: Int32Array) -> count   // indices into W.colliders
TLV.world.spatial.propsNear(W, x, y, r, out) -> count
TLV.world.spatial.poisNear(W, x, y, r, out) -> count
TLV.world.spatial.pointInBuilding(W, x, y) -> bldId | -1
TLV.world.spatial.rayBlocked(W, x0, y0, x1, y1) -> bool     // 2D test against colliders only
TLV.world.spatial.sensitiveNear(W, x, y, r) -> bool

// surface.js
TLV.world.surface.at(W, x, y) -> SURF.*

// sidewalks.js
TLV.world.sidewalks.nearest(W, x, y, out) -> out {sw, s, d} | null
TLV.world.sidewalks.pointAt(W, swId, s, out) -> out {x, y, h}
TLV.world.sidewalks.nextAt(W, swId, atEnd, rngNext) -> { sw, toStart } | null

// routing.js
TLV.world.routing.route(W, fromX, fromY, fromH, toLaneId, toS, opts) -> Route | null
TLV.world.routing.routeLanes(W, fromLaneId, fromS, toLaneId, toS, opts) -> Route | null
   // opts: { ai: bool } restricts to aiRoutable. Cost = len/vmax + 12 s per signal + 3 s per left turn.
   // A* with an admissible heuristic. Uses preallocated typed arrays
TLV.world.routing.project(route, x, y, hintS, out) -> out {s, d}
TLV.world.routing.randomExit(W, laneId, rng) -> connId      // weighted walk, section 13.3 weights

// parking.js
TLV.world.parking.init(S)
TLV.world.parking.reset(S)                                                // clears all overrides, back to baseline
TLV.world.parking.spot(W, spotId) -> ParkingSpot | null
TLV.world.parking.spotsNear(W, x, y, r, out: number[]) -> count           // ids; pure, derives lazily
TLV.world.parking.state(S, spotId) -> OCC.*
TLV.world.parking.setState(S, spotId, occ)
TLV.world.parking.parkedNear(S, x, y, r, out: number[]) -> count          // spots drawn or collided as static cars
TLV.world.parking.boxOf(W, spotId, occ, out) -> out {x, y, h, length, width}
TLV.world.parking.kerbAt(W, x, y, r, out) -> out {kerb, side, paint, dist, h} | null
TLV.world.parking.roadDistance(W, x, y, spotId) -> metres                 // along road graph, max 400, else Infinity
```

`parkedNear` returns spots with state `PARKED` or `MOTO`. Fill staging uses `setState` in bulk. Static car `variant` is
`hash32(spotId) & 7`.

### 12.4 WP-PLAYER

```js
// vehicle.js
TLV.player.register()
TLV.player.init(S)                  // places the car from TLV.game.errands.spawnPoint(S). Module absent under allowMissing: first AI_ROUTABLE lane at len/2
TLV.player.update(S, dt)
TLV.player.setPose(S, x, y, h, v)   // teleport; also sets px,py,ph
TLV.player.snapTo(S, x, y, h, durS, opts)   // Hermite pose blend; opts { ghost: bool, hold: bool }. Mode 'SNAP' then opts.hold ? 'LOCKED' : 'DRIVE'
TLV.player.setLocked(S, locked)     // 'LOCKED' ignores driving controls
TLV.player.isStopped(S) -> bool     // |v| < 0.2
TLV.player.projected(S, seconds, out) -> out {x, y}   // straight-line prediction

// collide.js
TLV.collide.update(S, dt)
TLV.collide.resolveStatic(S, body, out) -> bool
   // body {x,y,h,length,width,vx,vy}; pushes it out of colliders and props, writes corrected velocity. Used by DYNAMIC AI too
TLV.collide.touchingKerb(S) -> bool

// foot.js
TLV.foot.enter(S, x, y, h)          // resolves the point out of colliders and props, then S.player.mode = 'FOOT'
TLV.foot.exit(S)                    // back into car, mode 'DRIVE'
TLV.foot.update(S, dt)              // also treats active S.game.obstacles as a brush: 0.4 s at half speed
TLV.foot.applyHit(S)                // stumble and invulnerability per GAME_DESIGN 15.2

// bots.js
TLV.bots.create(name, opts) -> controlSource(S) -> ControlState
   // names: 'idle','patrol','chaos','braker','errands'. All randomness comes from S.rng.bot
```

Binding on WP-PLAYER:

- Within 30 m of `W.bounds`, top speed caps at 8 m/s. A `BOUNDS` wall (collider `owner` -1) and `WATER` are solid, but they
  cost no HP and emit no `player.contact`. Touching `WATER` emits `player.waterEdge`, at most once per 5 s.
- `player.redRun` fires when the car crosses a stop line and `TLV.world.signals.laneState` for that lane is `RED`.

Bots:

| Bot | Behaviour |
|---|---|
| `idle` | No input. The player sits still (worst case for deadlock) |
| `patrol` | Routes to random targets, obeys signals, overtakes nothing |
| `chaos` | Random controls plus occasional teleports |
| `braker` | Follows route at lane speed; on any obstacle ahead, reacts after `t_r` with full brake only |
| `errands` | Plays full errands including parking; steals bays; presses E at 1.0 s; runs to the door |

`js/input/input.js` (browser only):

```js
TLV.input.init(win, S)                       // sets S.controlSource to S => TLV.input.sample(S, S.controls), unless S.params.autoplay is set
TLV.input.sample(S, out) -> ControlState
```

`sample` needs camera yaw for the foot vector: it reads `TLV.render.camera.yaw()`.

UI-only keys are handled in `input.js`, not in `ControlState`:

| Keyboard | Gamepad | Call |
|---|---|---|
| Esc, P | Start | `TLV.ui.togglePause()`. In `TITLE` and `RUN_END`, Start sets `start` or `restart` instead |
| C | LB | `TLV.render.camera.toggleParking()` |
| V | RB | `TLV.render.rearview.toggle()` |
| M | | `TLV.ui.toggleMute()` |

### 12.5 WP-TRAFFIC

```js
TLV.traffic.register()
TLV.traffic.init(S)
TLV.traffic.update(S, dt)
TLV.traffic.maintain(S, dt)
TLV.traffic.prewarm(S)                                           // see below; called by flow.startRun
TLV.traffic.spawn(S, spec) -> Vehicle | null
   // spec: { laneId, s, v?, kind?, variant?, ag?, route?: Route, force?: bool }. Null if the pool is full or the slot overlaps
TLV.traffic.spawnOutOfView(S, x, y, r, spec) -> Vehicle | null   // lane near (x,y), hidden from player by ray or distance
TLV.traffic.despawn(S, veh, reason)                              // always goes through releaseAll; restores the spot's stored occupancy
TLV.traffic.command(S, veh, cmd) -> bool                         // section 13.1
TLV.traffic.release(S, veh)                                      // back to CRUISE
TLV.traffic.applyImpact(S, veh, jx, jy)                          // impulse in m/s applied by collide; enters DYNAMIC if needed
TLV.traffic.materializeParked(S, spotId) -> Vehicle | null       // live PARKED vehicle; spot state becomes VEHICLE, prior state kept in _t
TLV.traffic.byId(S, id) -> Vehicle | null                        // events and state carry IDs, commands take objects
TLV.traffic.leadOn(S, laneId, s, maxDist) -> Vehicle | null      // nearest ahead, AI only
TLV.traffic.followerOf(S, veh, maxDist) -> Vehicle | null
TLV.traffic.vehiclesNear(S, x, y, r, out: Vehicle[]) -> count    // from the 8 m broadphase, includes the player, skips inactive slots
TLV.traffic.visibleToPlayer(S, x, y) -> bool                     // within 170 m of the player, within ±75 deg of heading, not ray-blocked
TLV.traffic.setDensity(S, target)                                // overrides adaptive cap
TLV.traffic.diagnostics(S) -> object                             // wait-for chains and delay budget by junction
```

`TLV.traffic.prewarm(S)` despawns anything beyond `bubbleDespawn`, fills the bubble to target at 20-300 m from
`S.player.fx/fy` ignoring visibility, keeps the 12 m gap rule, and leaves the player's lane clear from the car to the next stop
line. It then runs `traffic.update` 300 times, advancing `S.sig.epoch` by `DT` each time, with `S.tick` unchanged and no events
emitted. Cars otherwise take about 28 s to arrive from the 140 m ring [M], so the scripted first minute would play on an
empty street, on every restart too.

**Internal requirements binding on WP-TRAFFIC** (from measurement, do not simplify away):

- IDM with delta 4, accel clamped to [-8, a]. MOBIL for lane change.
- A lane-changing car is **registered in both lanes** for 1.5-2.5 s.
- Single obstacle interface: the player, wrecks, stopped cars and crossing occupants all project to
  `(laneId, s, halfLen, v)` entries in the per-lane lists. The player registers on up to 3 overlapped lanes. When
  off-lane, a 40 m sensor cone at 10 Hz does the same.
- Junction gate. A car requests a grant at distance `max(12, v²/5 + 6)`. A grant needs: phase allows; no conflicting
  connector occupied; exit has `length + 2.5` m free after reservations. `EXCLUSIVE` lanes admit one car when empty.
  Grants increment `occ` and `reserved`.
- Unsignalled priority: ring, then major road, then arrival order; straight, then right, then left. Impatience overrides
  priority after 10 s, never occupancy.
- Mandatory lane changes start 60 m out. **No car stops to wait for a gap.** A car that misses its exit takes any connector
  from its current lane.
- Routing: weighted random walk. A* only for rivals and drop-offs, at most one call per 0.5 s.
- One single `releaseAll(S, veh)` is used by every exit path. Conservation of `occ` and `reserved` depends on it.
- FSM evaluates at 5 Hz in staggered buckets. IDM runs every tick.
- Spawn: ring 140-300 m from `S.player.fx/fy`, despawn at 390 m. Lanes come from the 60 m grid index, because uniform lane
  sampling reached only 26 of 180 cars [M]. Reject gap under 12 m, within 15 m of a lane end, and anything
  `visibleToPlayer`. Weight by class (section 13.3) and bias ahead on the player's road so perceived density stays high. The
  visibility rule is deliberately narrow: at 300 m with no cone, 86.7% of the road ahead inside the ring was rejected [M].
  RENDER fades in cars first drawn inside 300 m.
- Density: default 100, adaptive 70-120, per GAME_DESIGN 9. The target is `min(N, 11 * laneKmInBubble)`, because lane-km in
  the bubble ranges 3.8-13.3 at errand POIs [M]. `?density` sets the target directly and disables both the adaptive rule and
  this cap, so soak tests the N it asks for. Never exceed 120 ambient, since deadlock was validated only to N=120.
- People: hard-brake at TTC to a person under `max(0.8, v/16 + 0.25)` s, which is the stopping time at -8 m/s² plus margin.
- Blockers: on a lane with `left`, `right` and `opposite` all -1, `PHANTOM_STOP`, `DROPPED`, `DOUBLE_PARK` and `BUS_STOPPED` end
  at most 6 s after the player comes within 30 m behind the car, and every commanded `holdS` is clamped the same way.
  41.8% of route-km is one-lane one-way [M]. `WRECK` lasts at most 6 s in every case.
- A despawned materialized car restores the spot's prior occupancy, kept in `_t`, otherwise the spot stays `VEHICLE` forever
  as an invisible hole. `IN_SPOT` stores prior `PARKED`, so a rival who won becomes a static car on despawn. `PULLOUT` stores
  prior `FREE`.

**Deadlock ladder (mandatory):**

| Level | Mechanism |
|---|---|
| L0 | Turn-level SCC, movement filter (importer) |
| L1 | Box rule plus exclusive short lanes |
| L2 | Queue head blocked 5 s, not on red: re-pick a connector that passes the gate |
| L3 | Watchdog at `stuckT > max(60, 1.3 * cycle)` s: despawn if unseen, else `PULL_OVER`, which leaves lane lists immediately. **No distance guard.** Results at N=120, 6 seeds [M]: guard 5/6 runs ended in a cycle; L2 and no guard 0/6, max wait 60 s or less |
| L4 | Over 30% of bubble stuck: stop spawning, clear unseen blockers |

Exempt from the watchdog, only for their bounded timers: `PHANTOM_STOP`, `DROPPED`, `RIVAL_BLOCK`, `DOUBLE_PARK`,
`BUS_STOPPED`, `PARK_HOLD`, `RIVAL_STANDOFF`. Their followers are not exempt.

Known trap [M]: a 295 m, 6-lane one-way loop near (470, -600), around Carlebach, Kiryat Sefer and HaHashmonaim, holds 44
cars. There are 146 one-way rings of 420 m or less. Include it in soak.

`diagnostics.js` ships the wait-for chain walker (only following stationary blockers) and the delay budget by junction.

### 12.6 WP-PEDS

```js
TLV.peds.register()
TLV.peds.init(S)
TLV.peds.update(S, dt)
TLV.peds.maintain(S, dt)
TLV.peds.spawn(S, spec) -> Pedestrian | null
   // spec: { kind, x, y, h?, state?, variant?, swId?, swS? }. If no sidewalk given and state != 'SCRIPT', snaps to nearest
   // Null if the pool is full, except kind 'attacker', which evicts the farthest unseen pedestrian and never returns null
TLV.peds.despawn(S, ped)
TLV.peds.byId(S, id) -> Pedestrian | null
TLV.peds.command(S, ped, cmd) -> bool                      // section 13.2
TLV.peds.pedsNear(S, x, y, r, out: Pedestrian[]) -> count
TLV.peds.obstaclesOnLane(S, laneId, out: LaneObstacle[]) -> count   // {s, halfLen, v}. Includes the on-foot player
TLV.peds.zoneOccupied(S, zoneId) -> bool
TLV.peds.onHit(S, ped, ix, iy, speed)                      // enters STUMBLE, non-graphic; no state change on a SCRIPT pedestrian
TLV.peds.onBrush(S, ped)
TLV.peds.scare(S, x, y, r)                                 // FLEE
```

Requirements: 40-60 active within 120 m; update at 20 Hz in 3 buckets; invariant AI-person contacts is 0; zone dwell capped
at 25 s. Hop-back at TTC under 1 s applies to ambient walkers only. A walker commanded with `aim` holds its path, and the
fairness gate protects it. No walker, staged or ambient, steps out when an AI vehicle is within `v²/16 + 3` m of the conflict
point.

### 12.7 WP-GAME

```js
TLV.game.register()                     // registry handlers, debug hooks, invariants

// flow.js
TLV.game.flow.init(S)                   // creates S.game at 'TITLE'. Never calls startRun, see notitle below
TLV.game.flow.preUpdate(S, dt)
TLV.game.flow.postUpdate(S, dt)
TLV.game.flow.startRun(S, opts?)        // opts { errandIndex?, defId?, clock? }
TLV.game.flow.endRun(S, reason)

// errands.js
TLV.game.errands.onDef(def); TLV.game.errands.onSpawn(def)
TLV.game.errands.defs() -> ErrandDef[]
TLV.game.errands.plan(S) -> string[]    // 7 defIds for the run
TLV.game.errands.bind(S, index) -> Errand | null
   // POI and door route. Ladder per GAME_DESIGN 6. A def whose target.anchor resolves skips the ladder; an orphan anchor uses it.
   // SENSITIVE and NO_FACADE POIs are never eligible. Doors under 220 m straight-line from the start point are rejected.
   // {poi} resolves per language to that name, then the other language's name, then TLV.tune.game.kindLabels[kind].
   // Null only on a map too small to bind; flow then skips that errand. Never null on tlv_center.
   // gan_pickup binds a door on a residential edge at least 60 m from any SENSITIVE POI (91% of residential ways qualify [M])
TLV.game.errands.spawnPoint(S) -> { x, y, h, laneId, s, connId }
   // Reads only S.world, S.params (?spawn) and spawn defs, never S.game, because player.init runs first

// nav.js
TLV.game.nav.setTarget(S, laneId, s, x, y)   // the current bay, from errand start. The door is only a marker until the chase
TLV.game.nav.update(S, dt)

// score.js
TLV.game.score.init(S)                  // subscribes to player.contact, .nearMiss, .hitPed, .launch, .redRun, traffic.honk
TLV.game.score.update(S, dt)
TLV.game.score.computePay(S) -> number
TLV.game.score.bonus(S, id, amount, seconds)   // id: section 11 list. GAME holds no display strings
TLV.game.score.rank(money) -> string           // key: NEW_DRIVER, BUS_DRIVER, TAXI_DRIVER, DELIVERY_RIDER, LEGEND

// rage.js
TLV.game.rage.compute(S) -> number      // pure on S.game.contest
TLV.game.rage.tier(S, rage) -> 'CURSE'|'BLOCK'|'KNIFE'   // applies the knife rules

// rival.js
TLV.game.rival.start(S, spotId, opts) -> Contest | null  // source order per GAME_DESIGN 13.2. Null means no contest
TLV.game.rival.update(S, dt)            // re-solves ctl.speedScale, mirrors traffic.parkRace into Contest.state

// parking.js
TLV.game.parking.init(S)
TLV.game.parking.update(S, dt)
TLV.game.parking.stageBlock(S)          // clears old staging outside 60 m of the player, fills block, picks bay, places decoys
TLV.game.parking.nextBay(S) -> spotId | -1
TLV.game.parking.tryArm(S) -> bool      // only errand.bayId can arm, never a decoy stall

// knife.js and attacker.js
TLV.game.knife.begin(S)
TLV.game.knife.update(S, dt)
TLV.game.attacker.spawn(S, x, y, h) -> Pedestrian        // never null, see TLV.peds.spawn
TLV.game.attacker.update(S, dt)         // breadcrumb pursuit, lunge

// director, incidents, fairness
TLV.game.director.init(S)
TLV.game.director.update(S, dt)
TLV.game.director.predict(S, ttaS, out) -> out {x, y, laneId, s}
TLV.game.incidents.onDef(def)
TLV.game.incidents.defs() -> IncidentDef[]
TLV.game.incidents.stage(S, defId, opts) -> Incident | null    // opts.force skips the gate, for debug
TLV.game.fairness.check(S, candidate) -> bool
```

**`flow.startRun` order (binding):**

1. Reset `S.game` from `TLV.const.newGameState()`.
2. `TLV.world.parking.reset(S)`.
3. Despawn any rival, attacker, savers and inspectors.
4. `sp = TLV.game.errands.spawnPoint(S)`. `TLV.foot.exit(S)` if on foot, then `TLV.player.setPose(S, sp.x, sp.y, sp.h, 0)`.
5. Despawn vehicles within 30 m of spawn.
6. If the spawn def has `tailCar`, call `TLV.traffic.spawn(S, { laneId: sp.laneId, s: sp.s - 8.5, v: 0, ag: 0.8, force: true })`.
7. `TLV.traffic.prewarm(S)`, unless `S.flags.traffic` is false.
8. If `sp.connId >= 0`, `TLV.world.signals.alignGreen(S, sp.connId, def.greenInS)`.
9. `plan`, `bind`, `stageBlock`, then `nav.setTarget` on the bay. `Errand.routeLen` is then `nav.route.len`, or the door route if
   there is no route, and `Errand.award` follows from it. The next-errand path at `CARD` entry does the same from `bind` on.
10. Emit `run.start` and `errand.start`.

With `notitle`, `startRun` runs at the first `flow.preUpdate`, not in `init`. `flow.init` runs before `TLV.ui.init` calls
`enableDrain`, so `run.start` and `errand.start` would otherwise be lost.

**Nav rules.** If no route exists from the current lane, route from the nearest `AI_ROUTABLE` lane within 60 m regardless of
heading; failing that, `arrowH` is the direct bearing and `remaining` is Infinity. The graph has 85 sink nodes and 59 one-way
exits at the bbox, all player-drivable [M]. Recalculate after 25 m off route for 1 s, or after 2 s of `S.player.wrongWay`, at most
once per second, and emit `nav.recalc`. While `S.player.mode` is `FOOT`, `arrowH` is the direct bearing to the door, never the car
route.

### 12.8 WP-RENDER

```js
TLV.render.register()
TLV.render.init(canvas, S)
TLV.render.frame(S, alpha, dtReal)
TLV.render.onEvent(name, payload)                              // called by TLV.ui.frame for every drained event
TLV.render.resize(w, h)
TLV.render.dispose()
TLV.render.project(x, y, z, out) -> out {sx, sy, visible}      // for UI bubbles, CSS pixels
TLV.render.info() -> { calls, triangles, textures, geometries, chunksBuilt, chunksTotal, quality }
TLV.render.camera.yaw() -> radians                             // world heading the camera looks along
TLV.render.camera.setMode('auto'|'chase'|'parking'|'foot'|'free')
TLV.render.camera.toggleParking()
TLV.render.rearview.toggle()
TLV.render.coords.toThree(x, y, z, outVec3)
TLV.render.coords.fromThree(vec3, out)
TLV.render.storefronts.onDef(def); TLV.render.landmarks.onDef(def); TLV.render.assets.onAsset(a)
TLV.render.styles.onStyle(def); .onKit(def); .onMesh(def); .onDistrict(def)
TLV.render.city.recipes.building(W, bldId, styleId) -> Parts   // pure, plain objects, no THREE
```

`render.register()` runs in the browser only. `TLV.render.city.recipes` is pure, without `THREE`, and is unit tested in
Node by loading it with `files: ['sim', 'js/render/city/recipes.js'], map: 'tests/fixtures/mini_map.js'`.

Implementation requirements are in section 15.3.

### 12.9 WP-UI

```js
TLV.ui.register()
TLV.ui.init(root, S)
TLV.ui.frame(S, alpha, dtReal)          // called from main loop; drains S.bus
TLV.ui.setLang('en'|'he')
TLV.ui.showError(text)                  // works before init, targeting #ui-root
TLV.ui.togglePause()                    // TLV.app.loop.pause() or .resume(), plus the pause screen
TLV.ui.toggleMute()
TLV.audio.init(); TLV.audio.unlock(); TLV.audio.setMuted(bool)
```

`TLV.ui.frame` is the sole caller of `S.bus.drain`. It forwards each event to audio, hud, cards, bubbles, and to
`TLV.render.onEvent(name, payload)`, which WP-RENDER must define.

---

## 13. Command contracts

### 13.1 Traffic commands

`TLV.traffic.command(S, veh, cmd)` returns `false` if the vehicle cannot comply. It never throws. `cmd.aim`, where allowed,
is a shared `Aim` object: the caller mutates `tImpact` until `frozen`. The actor sets its speed so it reaches `(aim.x,
aim.y)` at `aim.tImpact`, clamped to `[0, 1.3 * lane vmax]`. Every `holdS` is subject to the blocker cap in section 12.5.

| `cmd.type` | Fields | Behaviour |
|---|---|---|
| `RED_RUN` | `aim?` | Skip the phase check at the next junction |
| `TAILGATE` | `durS`, `targetId` | Tail the target. `T = 0.1`, `s0 = 1.4` |
| `NOSE_IN` | `targetLaneId?`, `aim?` | Force a gap-accepting merge |
| `OVERTAKE` | `targetId`, `aim?` | Pass and cut in |
| `PHANTOM_STOP` | `decel`, `holdS` | Stop in lane |
| `DROP_OFF` | `holdS`, `door: 'traffic'\|'curb'`, `passenger: bool` | Pull half to curb, hazards, door, spawn via `TLV.peds.spawn` |
| `DOUBLE_PARK` | `holdS` | Stop, hazards, driver gone |
| `REVERSE_FOR_SPOT` | `distM`, `aim?` | Reverse down the lane |
| `WRONG_WAY` | `aim?`, `distM?`, `holdS?` | A car on a one-lane one-way lane turns to face the traffic and drives against it, as a pose script listed on the lane as an oncoming obstacle. It stops short of any body, stands `holdS`, backs out to the lane's end, then backs across the junction into a street leading to it and is a `CRUISE` car again. With nowhere to back into it stands with hazards and despawns |
| `BUS_PULLOUT` | `aim?` | Leave stop with no blinker |
| `DOOR_OPEN` | `side: 'traffic'\|'curb'`, `holdS` | Requires a `PARKED` vehicle from `materializeParked`. The door adds a 1.0 x 0.2 m box, centred in the vehicle frame at `(+0.25 * length, ±(width/2 + 0.5))`, long axis lateral. `TLV.collide` treats it as part of the vehicle |
| `PULLOUT` | | Requires a `PARKED` vehicle from `materializeParked`. Signals and leaves through `NOSE_IN`. The spot becomes `FREE` once the body is clear |
| `PARK_RACE` | `spotId`, `ctl: RaceCtl`, `route` | TRAFFIC owns the approach and emits `traffic.parkRace` at each stage. Follows `route` at `ctl.speedScale` of desired speed, reading `ctl` at FSM rate. Once `ctl.mayBlink` and within `parkBlinkM` of the stall by route: curb-side blinker, slow (`BLINK`). Then 5-7 m/s with `lat` toward the curb (`CREEP`). Within `parkCommitM`: block the lane in `SCRIPT` and steer in (`COMMIT`), body 50% inside within 1.5 s. `IN_SPOT` fires on the tick the body is 50% inside and sets the spot to `VEHICLE`; mode becomes `PARKED` when settled. With `ctl.holdCreep`, he stops at the `COMMIT` line and waits. 60 s timeout: `FAILED`, blinker off, `CRUISE` |
| `PARK_HOLD` | `maxS` | Stop in lane, blinker on, then `CRUISE` after `maxS`. GAME sends it when the player arms on a steal, because `PARK_RACE` would drive into the player's bay and `PARK_ABORT` would drive him off before the tier is known. A later `PARK_RACE` with the same `ctl` resumes from `COMMIT` |
| `PARK_ABORT` | | Blinker off, drive on |
| `RIVAL_BLOCK` | `holdS` | Stops beside the player's car, horn, `bubble` event |
| `RIVAL_STANDOFF` | `x`, `y`, `h`, `durS` | `durS` is the `SCRIPT` blend to the nose-in pose across the player's bumper; the door opens at the end. The car then holds until `TOWED` or `CANCEL`, with a 60 s timeout, because it must stay through a chase of up to 25 s plus `RESOLVE` |
| `TOWED` | | `SCRIPT`: drive away slowly, then despawn |
| `CANCEL` | | Same as `TLV.traffic.release` |

### 13.2 Pedestrian commands

| `cmd.type` | Fields | Behaviour |
|---|---|---|
| `ZEBRA_STEP` | `xingId`, `aim` | Intent 0.8 s, then step out so as to meet `aim` |
| `SLOW_CROSS` | `xingId`, `speed: 0.6`, `dwellS` | Crosses slowly, blocks the zone. `kind: 'trolley'` for the shopping trolley |
| `RED_CROSS` | `xingId`, `aim?` | Crosses against signal |
| `JAYWALK` | `x`, `y`, `toX`, `toY`, `aim?` | Mid-block crossing |
| `SCOOTER_SALMON` | `laneId`, `s`, `aim?` | Rides against a one-way lane |
| `DELIVERY_POP` | `xingId`, `aim?` | Rider leaves sidewalk into road at 6-9 m/s |
| `ROAD_STROLL` | `laneId`, `s`, `distM?`, `dwellS?` | Walks `distM` down the lane the way it runs, near its middle, at 0.8 m/s. A car on the lane within 15 m is ignored for `dwellS`, then they move aside slowly and leave |
| `SAVE_BAY` | `spotId` | Stands in the bay, gestures, leaves when the bay is taken. Stays in `S.peds` as `kind: 'saver'` |
| `INSPECT` | `x`, `y` | Inspector walks to the point, writes, leaves |
| `CANCEL` | | Back to `WALK` |

### 13.3 Routing weights

Weighted walk and spawn weight by class: primary 5, secondary 4, tertiary 3, unclassified 1, residential 1, living_street
0.3, service 0.15.

### 13.4 Incident definition

```js
TLV.q.push(['incident', {
  id: 'BUS_PULLOUT', minHeat: 0, weight: 3, cooldownS: 30,
  anchor: 'busStop',     // 'junction'|'busStop'|'parkedCar'|'leadCar'|'crossing'|'oneWayEdge'|'tailSlot'|'sideStreet'|'smallOneWay'|'smallStreet'
  telegraph: { s: 1.2, cue: 'noseOut' },
  tta: [2.2, 3.2],
  escape: 'laneOrBrake', // 'brake'|'laneOrBrake'|'none'
  search: false,
  actors: [{ kind: 'bus', command: 'BUS_PULLOUT' }]
}]);
```

The 17 shipped definitions live in `js/sim/game/incidents.js` (they are code-adjacent) and are pushed in `TLV.game.register()`.

---

## 14. Extension data

Every extension is a queue item. Invalid items are skipped with a warning and listed by `TLV.registry.problems()`.
`?dev=1` shows the list on screen. Nothing here needs an engine change.

### 14.1 Files

Photos must be packed into `.js` as data URIs, because a sibling JPG on `file://` throws `SecurityError` when uploaded to
WebGL, even through a canvas [M]. A data-URI image from an injected script uploads correctly, and a missing script fires
`onerror`, which triggers the fallback [M]. **There is no raw image code path.**

### 14.2 Anchors

Everything binds through an anchor, resolved by `TLV.anchors.resolve` against the table named by `opts.type`, tried in this
order:

```js
{ osm: 'w90723265', at: [32.074, 34.792], name: 'Azrieli Circular' }
```

1. `exact`: same OSM type and ID.
2. `moved`: same normalized name within 60 m of `at`.
3. `relocated`: point-in-footprint at `at` for a building, which survives OSM splitting or redrawing it; nearest POI or edge
   within 15 m of `at` otherwise.
4. `orphan`: logged to `orphans.json`. Fails only under `--strict`.

`osm` prefix: `n`, `w` or `r`.

### 14.3 Storefront

```js
TLV.q.push(['storefront', {
  id: 'carmel_spice',                                 // required, unique
  anchor: { osm: 'n123', at: [32.068, 34.768], name: '...' },   // required
  art: { asset: 'sf_carmel_spice' },                  // optional
  sign: { text: { he: '...', en: '...' } },           // optional
  credit: { author: '...', license: 'own', date: '2026-10' },   // required if art
  attest: { noLogo: true, noFaces: true }             // required if art
}]);
```

Fallback ladder, where every rung always renders:

| Surface | Ladder |
|---|---|
| Storefront | Loaded photo, curated sign, OSM sign, kind label ("מאפייה / Bakery"), blank shopfront, plain wall |
| Landmark | Packed model, style on OSM footprint extrusion, default building |

### 14.4 Landmark

```js
TLV.q.push(['landmark', {
  id: 'azrieli_circular',
  anchor: { osm: 'w90723265', at: [32.074, 34.792] },
  mode: 'restyle',            // 'restyle'|'replace'|'add'
  style: 'glass_blue',
  model: { asset: 'lm_azrieli_circular', yawDeg: 0, scale: 1 },  // optional
  skyline: true,
  credit: { /* required if model */ }
}]);
```

**Rule: visual replacement never changes collision.**

Shipped `content/tlv_center/landmarks.js` restyles at least these verified OSM IDs [M]:

| Landmark | ID | Height |
|---|---|---|
| Azrieli Circular | `w90723265` | 187 m |
| Azrieli Triangular | `w90723261` | 169 m |
| Azrieli Square | `w90723278` | 154 m |
| Azrieli Sarona | `w509799257` | 22 m in OSM; low part only |
| Azrieli Town offices | `w860931326` | 156 m |
| Habima | `w149522836` | 27 m |
| Sarona Market | `w284108856` | |
| Tel Aviv-Yafo Municipality | `w31786632` | 52 m |
| Dizengoff Center | `r15311025` (multipolygon building) | |
| Jaffa Clock Tower | `w640627236` | 18 m |

Carmel Market (`w149546103`) is `amenity=marketplace` in OSM, not a building, so `restyle` cannot apply. It ships as a
plain POI sign, not a landmark.

### 14.5 Errand

```js
TLV.q.push(['errand', {
  id: 'grandma_pills',            // required
  tier: 2,                        // 1, 2, 3 or 'finale'
  weight: 3,
  target: {
    kinds: ['pharmacy'],          // or synthetic: 'residential_door'
    named: 'prefer',              // 'prefer'|'require'|'any'
    anchor: null                  // optional, pins a story errand: skips the ladder when it resolves
  },
  fallbackKinds: ['convenience'],
  text: { he: '...', en: 'Grandma needs her pills from {poi}' },
  mod: null
}]);
```

Leg length, clock and pay come from the global tables in GAME_DESIGN 6 and 7, never from the errand. `named` must stay
`prefer` for ATMs and post offices, because only 2 of 59 ATMs and 2 of 11 post offices are named [M].

`milk` is the one pinned errand: `anchor: { osm: 'n11238493213', at: [32.0749, 34.7820], name: 'Carrefour' }` (GAME_DESIGN 6).

Lint (`tests/game/content.test.mjs`): text references a business only through `{poi}`. A sentence containing `{poi}` is a plain
instruction, and contains none of `they`, `them`, `their`. `SENSITIVE` POIs are never bound.

### 14.6 Spawn

`content/tlv_center/world.js`:

```js
TLV.q.push(['spawn', { map: 'tlv_center', anchor: { osm: 'w154735772', at: [32.0759, 34.7766], name: 'המלך ג׳ורג׳' },
  sFromEnd: 40, greenInS: 3, tailCar: true }]);
```

Ways 154735772 and 852315914 are HaMelekh George (King George), one lane, one-way, 183 m together. They contract into one edge
(pass 7) that ends at the signal cluster with HaNeviim at (-62, 139) [M]. `spawnPoint` resolves the anchor with `type: 'edge'`,
then finds the first `SIGNAL` junction ahead, walking through `PASS` junctions. `sFromEnd` is measured back from that stop line.
`connId` is any connector from the spawn lane at that junction, since connectors of one approach share a slot. `flow.startRun`
calls `TLV.world.signals.alignGreen` with `greenInS`, and adds the stopped follower when `tailCar` is set.

A map with no `spawn` item, such as `mini`, uses the first `AI_ROUTABLE` lane at `s = len/2`, returns `connId: -1`, and skips
alignment and the follower.

### 14.7 Styles, kits, meshes, districts

```js
TLV.q.push(['style', { id: 'bauhaus_plaster', tiles: { wall: 'ribbon_a', ground: 'pilotis_a' },
  palette: ['#f4efe6', '#efe3d0'], bayM: 3.4, floorM: 3.1, balconyEvery: 2,
  slots: { 'bld.balcony': 'curved', 'bld.rooftop': ['boiler_row', 'tank'] } }]);
TLV.q.push(['kit', { slot: 'bld.rooftop', id: 'boiler_row', priority: 10, when: { roof: 'flat' },
  emit: function (ctx, out) { out.instance('boiler', x, y, z, yaw); } }]);
TLV.q.push(['mesh', { id: 'boiler', asset: 'mesh_boiler', fallback: 'proc:boiler', max: 1500 }]);
TLV.q.push(['district', { id: 'white_city', poly: [[lat, lon], /* ... */], weights: { bauhaus_plaster: 5, modern: 1 } }]);
```

Slots: `facade.tile`, `bld.ground`, `bld.balcony`, `bld.rooftop`, `bld.roof`, `street.tree`, `street.furniture`,
`curb.paint`, `sign.board`.

To replace one piece: use a mesh with the same ID, a higher-priority provider, or a tile with `{asset}` instead of
`paint()`. A throwing provider is caught, and the next one runs.

**Stability.** Every slot has its own stream, `hash32(osmId, hashStr(slotId))`, derived from OSM ID, not row index.
Swapping one slot cannot reshuffle the others, and re-imports do not repaint the city.

Style choice order: landmark, then `building.set`, then district weights adjusted by OSM hints (`GLASS`, height over 60 m,
`building:colour` on 455 buildings [M]). Districts cover White City, Neve Tzedek, Florentin, Jaffa and the seafront.

### 14.8 Assets and the pack tool

`node tools/pack_assets.mjs` (no third-party dependencies). JPG and PNG resizing without a library is not practical in
plain Node, so resizing uses headless Chromium through `tools/lib/pw.cjs` when the input is larger than the target.

- Input: `assets_src/<kind>/<id>.<ext>`, plus a sidecar `assets_src/<kind>/<id>.json` holding `source, credit, attest`. The
  sidecar is pack-tool input only; `credit` and `attest` also appear in the printed registry row.
- Storefronts: 512 x 256, about 80 KB.
- Writes `data/assets/<assetId>.js` and regenerates `data/assets/index.js`. Prints the exact registry row.
- **Refuses** any item with missing `credit`, missing `attest`, or `source: 'streetview'`. Licences are limited to
  `own`, `cc0`, `cc-by-sa`. Google imagery is refused; extensions use OSM, Mapillary (CC BY-SA) and own photos.
- Meshes: GLB to `tlvmesh` (base64 interleaved buffer) via a hand-written GLB reader. Budget 20k triangles, 1024²
  texture.

Asset item: `TLV.q.push(['asset', { id, type: 'image'|'tlvmesh', mime, w, h, data: 'data:image/jpeg;base64,...' }])`.

Asset states: `absent`, `queued`, `ready`, `failed`. Loaded by script injection, at most 2 in flight. The sim never reads
them. The base64 string is released after decode.

Hebrew text: v1 uses a system font stack (`'Arial Hebrew','Noto Sans Hebrew',Arial,sans-serif`) with `canvas.direction`
set per script. No font is packed in v1. An `asset` of `type: 'font'` is reserved.

---

## 15. Render and UI read contract

### 15.1 What render and UI may read

Read-only, between ticks:

| Source | Fields |
|---|---|
| `S.world` | Everything in section 10.6 |
| `S.vehicles[i]` | `active, kind, variant, x, y, h, px, py, ph, v, vx, vy, yawRate, accel, steer, lights, horn, door, isPlayer, mode, length, width` |
| `S.peds[i]` | `active, kind, variant, x, y, h, px, py, ph, v, anim, intent, hasKnife` |
| `S.player` | Section 10.5 |
| `S.game` | Section 10.9 |
| `S.traffic.stats` | Public |
| `S.sig` | Through `TLV.world.signals.*` only |
| `S.parking` | Through `TLV.world.parking.parkedNear`, `.state`, `.boxOf` only |
| `S.t, S.tick, S.timeScale` | |

Interpolate: `lerp(px, x, alpha)`, and `h` with `wrapPi`.

### 15.2 Writes

Render and UI write nothing into `S`. Input is the only path from the browser to the sim, through `ControlState`.

### 15.3 Rendering implementation requirements

**Chunks.** 400 m grid, about 136 occupied, at most 471 buildings [M]. A chunk has one merged shell mesh and one ground mesh,
built with typed-array merges, because `three.min.js` has no `mergeGeometries` or `GLTFLoader` [M].

**Facades.** One `sampler2DArray`, 256 x 256 x 32 layers, about 11 MB with mips. `MeshLambertMaterial` patched with
`onBeforeCompile` [M, rendered 4 layers correctly in r159]. Painted at boot by canvas painters, or from packed tiles.
Vertex attributes `aUv` (metres over bay and floor size), `aTile`, tint. Bay count is rounded so windows never cut. Ground
floors are separate quads on `front` walls.

**Whole-map shells** are 193k triangles [M], so polygons are not the bottleneck. Draw calls, detail instances and texture
memory are.

| Content tier | Range | Contents |
|---|---|---|
| L0 | Up to 150 m | Balconies, boilers, AC, tanks, awnings, signs, from global `InstancedMesh` pools |
| L1 | Up to 700 m | Shell only; trees to 350 m, parked cars to 250 m |
| L2 | Beyond 700 m | One global skyline mesh of buildings at least 30 m tall, so Azrieli stays a navigation aid |

Pool caps: balcony 6k, AC 3k, boiler 1.5k, tank 400, ficus 2.5k, palm 800, parked car 1.5k, lamp 800, sign 256. Peak was
10.4k bay-floors in 150 m [M]. The pool drops the farthest instances first.

**Signs and atlases.** `AtlasSlots`: 2048², 256 x 64 slots (256 slots) for signs, 512 x 256 (32 slots) for photos, LRU
eviction, `copyTextureToTexture` per slot, at most 4 bakes per frame. Peak demand 106 signs in a 200 m disc [M].
**Check atlas orientation with `flipY` first:** the earlier test tile was symmetric, so this is unverified.

**Vehicles and people.** `InstancedMesh`, at most 6 bodies. Brake lights, hazards and blinkers via instance colour or a
small light mesh. A car first drawn inside 300 m fades in over 0.4 s, keyed on `traffic.spawn`.

**Gameplay props.** RENDER draws `MOTO` spots only within 8 m of the player; collision is always on. RENDER draws active
`S.game.obstacles`. Each `PORTAL` junction gets barriers and a "Road closed since forever." sign, text in `js/render/tune.js`.

**Lights and sky.** Warm Mediterranean: low sun, warm ambient, one 1024² shadow map within 80-100 m, blob shadows beyond.
Fog hides the edge. Dynamic resolution as fallback.

**Load phases:**

| Phase | Work | Target |
|---|---|---|
| 0 | Synchronous scripts | |
| 1 | Decode, spatial index, sim ready | 400 ms |
| 2 | Bake tiles, build 9 chunks around spawn, show title | 1.5 s on a mid-range laptop |
| 3 | Remaining chunks in a spiral at 4 ms per frame or less | Background |
| 4 | Assets by injection: storefronts within 250 m, landmarks within 1 km | On demand |

---

## 16. Debug and test hooks

### 16.1 URL parameters

All optional. Parsed by `TLV.config.parse`. Browser and `createTLV({ params })` behave the same.

| Param | Type | Default | Effect | Owner |
|---|---|---|---|---|
| `seed` | int | null, then wall-clock in browser, 1 in Node | Sim seed | CORE |
| `map` | string | `TLV.mapIndex.default` | Map ID | CORE |
| `lang` | `en`,`he` | `en` | UI and card language | UI |
| `debug` | 0, 1 | 0 | Debug overlay, enables `invariants` | UI, CORE |
| `dev` | 0, 1 | 0 | On-screen unresolved content and asset list | UI |
| `invariants` | 0, 1 | 0 | Runs invariants each 60 ticks | CORE |
| `record` | 0, 1 | 0 | Records `ControlState` for `exportReplay` | CORE |
| `autoplay` | bot name | none | Uses `TLV.bots.create(name)` as control source | CORE |
| `notitle` | 0, 1 | 0 | Runs `flow.startRun` at the first `flow.preUpdate` | GAME |
| `errand` | 1-7 | 1 | Start at this errand. 1-based, unlike `Errand.index` | GAME |
| `errandDef` | id | none | Force the def for the first errand | GAME |
| `spawn` | `x,y,h` | content | Override spawn, read by `errands.spawnPoint` | GAME |
| `clock` | seconds | 120 | Starting clock | GAME |
| `heat` | 0-1 | computed | Force heat | GAME |
| `immortal` | 0, 1 | 0 | Clock, HP, strikes and pedestrian hits never end the run. Soak only | GAME |
| `density` | int | 100 | Traffic target. Disables the adaptive rule and the lane-km cap | TRAFFIC |
| `traffic` | 0, 1 | 1 | Sets `flags.traffic` | CORE |
| `peds` | 0, 1 | 1 | Sets `flags.peds` | CORE |
| `incidents` | 0, 1 | 1 | Sets `flags.incidents` | CORE |
| `contest` | `auto`,`off`,`force` | `auto` | Contest policy | GAME |
| `knife` | `auto`,`off`,`force` | `auto` | Force or forbid the knife tier | GAME |
| `quality` | `low`,`med`,`high` | auto | Render quality | RENDER |
| `mute` | 0, 1 | 0 | Mute audio | UI |
| `hud` | 0, 1 | 1 | Hide HUD for clean screenshots | UI |
| `timescale` | number | 1 | Multiplies loop speed inside `TLV.loop`. Touches neither `DT` nor `S.timeScale` | CORE |

### 16.2 `TLV.debug`

`debug.js` (WP-CORE) provides `TLV.debug.register(name, fn)`, which sets `TLV.debug[name]`, and always exposes it. Each
owner registers its hooks in its `register()`. Hooks never take `S`. `TLV.debug.use(S)` sets the current sim, and `createSim`
calls it. Hooks read `TLV.debug.current()`, which returns that sim, or `TLV.app.S` in the browser.

All return JSON-serializable values, safe for `page.evaluate`.

| Hook | Owner | Effect |
|---|---|---|
| `state()` | CORE | See below |
| `hash()` | CORE | `TLV.sim.hash(S)` |
| `pause()`, `resume()`, `step(n)` | CORE | Loop control; `step` runs `n` ticks synchronously |
| `setInput(partial \| null)` | CORE | Overrides `ControlState` fields until cleared |
| `exportReplay()`, `importReplay(log)` | CORE | |
| `teleport(x, y, h, v = 0)` | PLAYER | |
| `setPlayerMode(mode)` | PLAYER | |
| `spawnCar(spec)` | TRAFFIC | Returns vehicle ID |
| `commandCar(id, cmd)` | TRAFFIC | |
| `setDensity(n)` | TRAFFIC | |
| `trafficDiagnostics()` | TRAFFIC | |
| `spawnPed(spec)`, `commandPed(id, cmd)` | PEDS | |
| `forceSignal(juncId, 'G'\|'R', holdS)` | WORLD | |
| `startRun(opts)` | GAME | |
| `setClock(s)`, `setMoney(n)`, `setHP(n)`, `setHeat(h)`, `setStrikes(n)` | GAME | |
| `setErrand(index, defId?)` | GAME | Rebinds the current errand |
| `forceContest({ rage?, etaDelta?, spotId? })` | GAME | Starts a rival now and places the player within 60 m of the bay unless `{ keepPose: true }`. Returns `{ rivalId, spotId }` |
| `forceKnife({ stage?, gap? })` | GAME | Enters the encounter now, at `stage` (default `STANDOFF`), spawning a rival if needed |
| `forceIncident(id, opts)` | GAME | Stages now, skipping the gate if `opts.force`. Returns incident ID or null |
| `parkNow({ quality?, method? })` | GAME | Completes parking at the current bay |
| `endRun(reason)` | GAME | |
| `camera(mode)` | RENDER | |
| `renderInfo()` | RENDER | `TLV.render.info()` |
| `showLanes(bool)`, `showSpots(bool)` | RENDER | Debug overlays |
| `ui(name, visible)` | UI | Force a card or screen |

`state()` returns:

```js
{ tick, t, seed, map, phase, phaseT, clock, money, hp, heat, errandIndex, errandId, doorX, doorY, bayId,
  player: { mode, x, y, h, v, laneId, surface, wrongWay },
  counts: { vehicles, peds, target },
  traffic: { meanSpeed, stationaryShare },
  contest: { state, rage, tier, rivalId } | null,
  knife: { stage, strikes, gap, exit } | null,
  incidents: [{ id, defId, state }],
  chain: { n, mult, bank }, park: { stage, kind, bar },
  stats, endReason, rank, problems: n, invariantFailures: n }
```

---

## 17. Tests and soak harness

### 17.1 Conventions

- `tests/<wp>/*.test.mjs`: `node:test`, headless, uses `createTLV`. Compare results directly with `assert.deepStrictEqual`.
- `tests/<wp>/*.e2e.cjs`: Playwright, run directly with `node`. Uses `tools/lib/pw.cjs`.
- Every test creates its own sim. Tests must not depend on order.
- Screenshots go to the scratchpad, not the project.
- Shut down every browser and server you start.

Tests named by GAME_DESIGN 24, which owners must provide:

| File | Owner |
|---|---|
| `tests/core/lint.test.mjs`, `tests/core/determinism.test.mjs` | CORE |
| `tests/e2e/file_protocol.e2e.cjs`, `tests/e2e/smoke.e2e.cjs`, `tests/e2e/knife.e2e.cjs` | CORE |
| `tests/traffic/behaviours.test.mjs` | TRAFFIC |
| `tests/game/errands.test.mjs`, `nav.test.mjs`, `parking.test.mjs`, `knife.test.mjs`, `content.test.mjs`, `clock.test.mjs` | GAME |

### 17.2 Soak

`node tools/soak.mjs --seeds 1-20 --bots patrol,idle,chaos --n 100,120 --minutes 15 --jobs 14 [--map tlv_center] [--inject trap]`

Runs a parallel matrix through child processes, one sim each, no browser. Each sim uses `notitle=1`, `immortal=1`, and
`?density=N`. Writes `tools/reports/soak/<timestamp>.json`. A second matrix, `--bots errands,braker` with no `--n`, runs at default
density for the Contest and Fairness gates.

**Harness rule.** Arguments go through `process.argv`, never a shell-split string. Zsh does not word-split `$VAR`, which
silently produced invalid runs in both design phases: spawning failed and results looked plausible. The harness must
print realised config and realised density, and **fail if realised N is under 90% of target**.

`--inject trap` teleports the `idle` player beside the known ring at (470, -600).

### 17.3 Soak gates

| Check | Rule | Owner of the invariant |
|---|---|---|
| Lane bound | Lateral at most `width/2 + 1` m unless in an exempt state | TRAFFIC |
| Overlap | No AI-AI OBB overlap outside `WRECK`; no AI body centre in a building while in mode `LANE` | TRAFFIC |
| Lane colliders | No lane centreline crosses a collider | WORLD |
| Ordering | Lane lists sorted, gap at least -0.1 m | TRAFFIC |
| Conservation | Recount `occ` and `reserved` every 300 ticks, must equal counters | TRAFFIC |
| Stuck bound | Max `stuckT` at most watchdog + 5 s | TRAFFIC |
| Numeric | No NaN or Infinity in any pose | CORE |
| People | AI-person contacts = 0 | PEDS |
| Flow | Space-mean speed at least 4.5 m/s; stationary share at most 45% | TRAFFIC |
| Determinism | Hash every 1000 ticks matches across two runs of one seed | CORE |
| Memory | Heap slope under 1 MB per 10 sim-min | CORE |
| Behaviours | Each ambient behaviour fires at least once per 15 sim-min over all seeds | TRAFFIC |
| Fairness | `braker` bot avoids at least 95% of staged incidents | GAME |
| Nearby traffic | At least 6 cars within 100 m of the `patrol` bot on 80% of samples | TRAFFIC |
| Contest | On the `errands` bot, the rival reaches `BLINK` in view before capture on at least 80% of contests, and the bot loses 20-45% of them | GAME |

Ship with two diagnostics, because a single end-of-run snapshot did not find root causes: the wait-for chain walker and
the delay budget by junction.

### 17.4 Clock check

`tests/game/clock.test.mjs` drives real `flow` and `errands` with a kinematic ghost that moves along `nav.route` at a tier
speed and parks after a tier delay, ignoring collisions. It must reproduce GAME_DESIGN 7's table within one errand on 20
seeds. A separate report-only soak prints the `errands` bot's real mean speed for balance review.

---

## 18. Performance budgets

Reference hardware: Iris Xe class laptop, 60 fps. Real-GPU numbers are estimates: only SwiftShader is available here, so
**hard gates are counts**, checked by `TLV.render.info()`, and frame times are checked by a person on real hardware.

| Item | Budget | Gate type |
|---|---|---|
| Sim tick, mean at N=100 with 50 people | At most 3 ms in Node on this machine | Automated |
| Sim tick, p99 | At most 6 ms | Automated |
| Render frame | At most 9 ms on reference GPU | Manual |
| Draw calls, main pass | At most 72 typical | `info()` |
| Draw calls, total | At most 110, hard cap 150 | `info()` |
| Shadow pass within 100 m | At most 30 | `info()` |
| Triangles | At most 400k | `info()` |
| Textures | At most 64 MB (facades 11, signs 6, photos 6, landmarks, fonts) | Estimated |
| Vertex buffers | At most 40 MB | Estimated |
| JS heap | At most 250 MB | Automated in soak |
| GPU memory | At most 300 MB | Estimated |
| `map.js` | At most 1.6 MB | Automated |
| Map decode | At most 50 ms in Node | Automated |
| `world.build` | At most 400 ms in Node | Automated |
| Time to title | At most 3 s on reference laptop | Manual |
| Sign bakes | At most 4 per frame | `info()` |
| Background chunk build | At most 4 ms per frame | `info()` |
| Routing | At most 2 ms per A* call, p99 | Automated |

The prototype costs 0.06 ms mean, 0.34 ms p99 at 120-180 cars [M]. Sim CPU is not the constraint. **Draw calls are.**

---

## 19. Definition of done per package

Every package: its tests pass, the lint test passes, no file outside its ownership was touched, content follows
BRIEF tone rules, and a final report lists anything decided under the "missing contract" clause.

### WP-CORE

1. `node --test 'tests/core/**/*.test.mjs'` passes, including lint and a determinism test on a stub system.
2. `index.html` over `file://` runs with all other packages stubbed, showing a clear error overlay listing missing files.
3. `tools/lib/classic.mjs` loads all of `TLV.manifest.sim` in Node, with no `document` reference.
4. `TLV.sim.step` matches the table in 9.2 exactly; a test records call order with spies.
5. `tools/soak.mjs` fails when realised N is under 90%, proven by a test with a broken spawner stub.
6. Fixed step: 1000 ticks at varied `dtReal` patterns gives one hash; `timeScale` 0.6 does not change the hash per tick.
7. `README.md` explains how to run, covers the attribution "© OpenStreetMap contributors", and lists URL params.
8. `tests/e2e/file_protocol.e2e.cjs` also asserts a Hebrew string has its expected length.
9. `createTLV` gives each call an independent `TLV`, and `assert.deepStrictEqual` passes on a typed array built in game code.

### WP-MAP

1. `node tools/import.mjs tlv_center` exits 0, and two runs give byte-identical `map.js` (SHA-256 test).
2. Gates, all checked by `verify` on decoded data:

| Gate | Value |
|---|---|
| Unique nodes after dedupe | 114,284 |
| Signal nodes retained | At least 700 |
| `SIGNAL` junctions | 300 to 520 |
| Junction clusters with degree 3 or more | 2,000 to 2,700 |
| Movements | At least 9,000 |
| Turn-level SCC | At least 90% of in-bbox lane-km (measured 93.0%, 560 of 602 [M]) |
| Same-plane crossings with no junction | 0 |
| Kept lane centrelines crossing a `walls` row, at final `laneW`, ignoring the last 3 m at a `PORTAL` | 0 |
| Lane centrelines crossing a building that has a collider | 0 |
| Buildings | At least 14,000 |
| Named POI facade yield | At least 90% |
| Sensitive POIs | At least 150, including at least 14 with `amenity=kindergarten` |
| Kerb stalls (derived at 6.5 m) | At least 50,000 |
| `osm` column round-trip | Max ID preserved exactly |
| `map.js` size | At most 1.6 MB |

3. `tests/fixtures/mini_map.js` exists and decodes.
4. An overlay that sets `lanes` on one way changes only that way in a re-import diff.
5. A second area definition with a sub-bbox of the same extract imports with no code change.
6. `ATTRIBUTION.txt` exists, and `meta.attribution` is set.

### WP-WORLD

1. `TLV.world.build` on `tlv_center` and `mini` succeeds in budget.
2. Lane offsets: on every two-way edge, `idx` 0 is farther right than `idx` 1, and forward and backward lanes do not
   overlap. Test on `mini` and 200 random real edges.
3. Connector mapping: rightmost lane takes the rightmost exit. On multi-lane approaches, no straight connector crosses a
   right-turn connector from a lane to its left.
4. Every `AI_ROUTABLE` lane has at least one connector, every approach of every controller is served, and `conflicts` is
   symmetric.
5. Signal state agrees with the pure formula over 10,000 random `(conn, t)` pairs; `alignGreen` works.
6. `routing.route` returns a legal route for 500 random POI pairs, never traversing a `moves`-absent turn, within budget.
7. Spots: none in a footprint. `spotsNear` is identical across call orders. No spot on tier 255.
8. `project` then `pointAt` round-trips within 0.05 m on 1,000 samples.
9. `rayBlocked`, `pointInBuilding`, `surface.at` verified on `mini` geometry by hand-computed answers.
10. Signal timing matches the table in 8.3 for every `n`. A one-slot controller shows `RED` 3 s before green.
11. No lane centreline crosses a collider on `mini`. No connector has a NaN in `len`, `vmax` or any point on `tlv_center`.

### WP-PLAYER

1. Handling tests within tolerance: 0-60 km/h in 3.3 ± 0.2 s; top 26.4 ± 0.2 m/s; brake from top in 25 ± 2 m; min radius at
   top 63 ± 5 m; 90 deg handbrake at 16 m/s in 0.7 ± 0.2 s.
2. Wall glance under 30 deg keeps at least 80% tangential speed; head-on never dead-stops with `v = 0` and stuck.
3. Scrape, bump and crash events at the correct `vn`, on the 0.5 s same-body guard.
4. Near miss fires at 0.45 and 0.9 m gaps with 6 m/s relative speed, and **never** for a person.
5. `player.hitPed` fires for every `Pedestrian` kind, including `attacker` and riders.
6. Foot: run 6.4 m/s, sidestep 2 m in 0.3 s, collides with buildings and parked boxes.
7. All 5 bots run 5 sim-min with no invariant failure.
8. In a browser: keyboard reaches `ControlState`; `footX/Y` rotates with camera yaw.
9. `BOUNDS` and `WATER` contact cost no HP and emit no `player.contact`. `player.redRun` and `player.waterEdge` fire.
10. `foot.enter` beside a wall ends clear of colliders. `foot.update` applies the brush from `S.game.obstacles`.

### WP-TRAFFIC

1. Soak matrix passes at N=100 and N=120 for seeds 1-20, bots `patrol`, `idle`, `chaos`, including `--inject trap`.
2. `tests/traffic/behaviours.test.mjs` has one scenario for each behaviour in 10.3, asserting its trigger, effect, and
   timeout exit. Each scenario also asserts `occ`/`reserved` conservation.
3. `RED_RUN`: AI on green yields, invariant no overlap.
4. `TAILGATE`: gap 1.4-3 m at 10 m/s for 6 s; player braking at 14 m/s² produces a rear-end contact.
5. Every command in 13.1 returns a correct `bool`, and `CANCEL` restores `CRUISE`.
6. Tick budget met.
7. `PARK_RACE` reaches `IN_SPOT` on 95% of 200 random spots on `tlv_center`. `ctl.holdCreep` holds him at the `COMMIT` line.
8. `prewarm` reaches target with the player's lane clear, emits no events, and is deterministic.
9. A despawned materialized car restores the spot. A `PARK_HOLD` rival stays put until released.
10. A `DOUBLE_PARK` on a lane with no neighbours ends within 6 s of the player arriving. A `WRECK` becomes `TOWED` within 6 s.

### WP-PEDS

1. 40-60 active within 120 m on `tlv_center`, sustained for 10 sim-min.
2. Scenario for every state and command in 10.4 and 13.2.
3. `intent` true for at least 0.8 s before any step-out, by test.
4. Never starts crossing with player TTC under 1.5 s, or with an AI vehicle within `v²/16 + 3` m. Commanded walkers with `aim`
   do not hop back; ambient walkers do.
5. AI-person contacts = 0 in soak.
6. Zone dwell at most 25 s; a stopped crowd never deadlocks traffic.
7. Riders count as people: every hit produces `player.hitPed`.

### WP-GAME

1. `errands.test.mjs`: 100 seeds give 7 errands ending in `gan_pickup`, with no `SENSITIVE` or `NO_FACADE` POI bound, no bay
   within 60 m of one, every POI kind in its def's kinds or `fallbackKinds`, every door at least 220 m straight-line from its
   start point, and errand 1 bound to the pinned door.
2. `clock.test.mjs` passes.
3. `parking.test.mjs`: PERFECT, GOOD, UGLY by scripted controls from lane centre; speed and angle limits; cancel in each
   `park.stage`; only `errand.bayId` arms; curb and double-park options by Q only, with their `M` and no SPOTLESS; inspector
   rolls with a fixed seed.
4. Rival: reaches every state; rival win leads to next bay, whose car pulls out; third bay is free; `AFTER YOU` pays; `HOLD`
   cancel returns him to `COMMIT`; arming with him in `CRUISE` is not a steal.
5. Rage: every factor; tiers at 44, 45, 74, 75; every knife rule (first forced, not consecutive, max 3, never on 1 or 7, `BLOCK`
   when the bay is over 150 m from the door).
6. `knife.test.mjs`: every stage in order; `DRAGGED` at 2.5 s; `lead = 9 - 3t`; all four exits reachable from scripted input;
   attacker 5.7 or 6.6 m/s; clock frozen; controls locked, so `player.hitPed` cannot fire in `STANDOFF` or `DOOR_TUG`.
7. Pedestrian hit: all penalties; second ends the run; hitting the attacker gives no benefit by any path.
8. All 17 incidents stage on `tlv_center` and pass the fairness gate; `braker` meets 95%.
9. All `TLV.debug` hooks in 16.2 work from `page.evaluate`.
10. All run-end reasons are reachable, and restart works. `startRun` follows the order in 12.7, and `?notitle=1` delivers
    `run.start` to a frame consumer.
11. `content.test.mjs` passes the `{poi}` lint and the tone word check.
12. Pay is applied exactly once on every path through `PAYOUT`, `BLOCKED`, `ENCOUNTER` and `RESOLVE`.
13. Nav: no-route, off-route and wrong-way rules in 12.7. Recover applies its costs and counts as no contact.

### WP-RENDER

1. `file://` smoke: title, then `DRIVE`, with no console errors; asserted by Playwright. A missing asset script always logs
   `net::ERR_FILE_NOT_FOUND` [M], so fallback tests allow exactly that message.
2. Screenshots captured, viewed and judged by the implementer, at 1280 x 720: Dizengoff street level, Azrieli skyline,
   seafront, a parking camera view, knife `STANDOFF`, on-foot chase. Claims about visuals require a screenshot.
3. `info()` within budget on all of those.
4. Coordinates: a test places a marker at known `(x, y)` and `h` and verifies world-to-screen placement and facing.
5. Buildings match footprints; Azrieli's three towers are recognizable; the sea is on the west.
6. Hebrew signs read correctly right to left, on a screenshot.
7. Fallback ladder: every rung forced and shown; a registered storefront and landmark show with no engine change; removing
   the asset falls back without error.
8. Pack tool: refuses missing `credit`, missing `attest`, and `source: streetview`.
9. Rear-view strip and tailgater ghosting work.
10. No blood or gore assets exist. Knife is chunky, attacker is a palette swap with no iconography.
11. Sim hash is identical with render on and off for 3,600 ticks.

### WP-UI

1. All HUD elements in GAME_DESIGN 20 present and legible at 1280 x 720, by screenshot.
2. Every event in section 11 has a defined UI or audio handling, or an explicit "none".
3. `?lang=he` renders right to left.
4. OSM attribution on title and pause screens.
5. All 5 end screens shown through `TLV.debug.ui` and by real end conditions.
6. Audio silent until unlock; `?mute=1` works; no audio files are shipped.
7. Minimap draws route and player, in the correct orientation.
8. UI never writes to `S`.
9. Bubble text is symbols only.
10. Pause, mute and the first-minute prompts in GAME_DESIGN 19 work. `incident.telegraph` shows a direction chevron.

---

## 20. Integration acceptance

Run after all packages land. WP-CORE owns `tests/e2e/`.

1. `node --test 'tests/**/*.test.mjs'` passes.
2. `tests/e2e/file_protocol.e2e.cjs`: `file://`, all network requests blocked, reaches `DRIVE`, no console errors, and a Hebrew
   string has its expected length.
3. The same page works from a static server.
4. `tests/e2e/smoke.e2e.cjs`: `?autoplay=errands&seed=1` completes at least one errand with traffic and pedestrians on.
5. `tests/e2e/knife.e2e.cjs`: `forceKnife`, then all four exits, with screenshots.
6. Soak: the matrix in 17.2 passes all gates in 17.3.
7. Replay: export a 60 s log from a `?record=1&autoplay=patrol` run, re-run in Node with no bot, same hash. `chaos` is excluded.
8. Determinism with render: same seed gives the same hash with and without render.
9. Traceability: each row in GAME_DESIGN 24 has a passing test or a reviewed screenshot.
10. Extensibility: add one `storefront`, one `landmark`, one `errand` and one overlay op, with only data changes.

---

## 21. Decision log

Conflicts between the design proposals, resolved. Do not reopen.

| # | Conflict | Decision | Why |
|---|---|---|---|
| 1 | Feel proposal's clock assumed 12-14 m/s; simulation proposal measured traffic at 3-6 m/s | Rescaled: start 120 s, `L/8 + 14`, legs 450-1050 m | Reference ghosts show 14 m/s needs running every red [M] |
| 2 | Default density 150 versus playability | Default 100, adaptive 70-120 | At N=100, 5.4 m/s and 26% stationary [M]; deadlock validated only to N=120 |
| 3 | Structure-of-arrays versus readable contracts | Pooled plain objects with stable slots | 200 vehicles is small; cross-package contracts are the main risk; zero-allocation is still met |
| 4 | Lane index direction undefined; prototype inverted | `idx` 0 is rightmost, right exit | Corrected mapping cut conflicts 6% and improved N=120 speed from 4.4 to 5.3 m/s [M, 4 seeds, modest evidence] |
| 5 | `motorway_link` as ramp source lanes versus excluded | Excluded. Ayalon is a fenced strip | Measured connectivity was on the excluded net; `NOSE_IN` provides merges everywhere |
| 6 | SCC gate at 570 lane-km | At least 90% of in-bbox lane-km | 570 was before clipping; clipped network measures 93.0% [M] |
| 7 | Tree nodes visual, or solid | `W.props` are solid, world-owned, rendered at those positions | Collision must be deterministic and match visuals |
| 8 | Bays staged versus spots simulated | Real spots from `kerbs`; occupancy staged via `setState` | Keeps real curb geometry and guarantees a contest |
| 9 | Errand has a `timer` and `dwellS` versus a global clock | Global clock table, no dwell | One balance model; parking completes the errand |
| 10 | Schools and kindergartens never conflict sites, versus gan finale | Gan is fictional, synthetic, no knife; 60 m buffer | Keeps the story beat and the content guard |
| 11 | `TLV.registerErrand` versus `TLV.q` | `TLV.q` for all data | Load order independence |
| 12 | `Int32Array` for all columns | `vl`/`Float64Array` for OSM IDs | Node IDs exceed 2^31 [M] |
| 13 | `index.html` script list versus injected manifest | Injected manifest, shared with Node | One source of truth |
| 14 | Physical `AEB` for tailgaters versus rear-end rule | Hard brake floor -8, player can reach -14 | Rear-end emerges naturally from the difference |
| 15 | Stall length 6.0 versus 6.5 m | 6.5 m | Matches the bay rule; tunable without re-import |
| 16 | Parked car between neighbours may be trapped | Pull-out snap at `CARD` entry | Avoids a low-speed fender-bender tax at every errand |
| 17 | Packed Hebrew font | System font stack in v1 | No font in repo; Arial and Noto cover Hebrew on target systems |
| 18 | `Date.now` default seed | Allowed in `js/app/main.js` only | The brief's rule binds sim code |
| 19 | `map.js` at 1.2 MB | 1.6 MB | The 1.2 MB target predates `moves`, `kerbs`, `land`, `paths` and real attribute data |
| 20 | Load target of 100 ms and 800 ms | 400 ms and 1.5 s | Earlier figures excluded lane, connector and raster building, and were unmeasured |
| 21 | Node loader in a `vm` context with parameter hacks, versus main realm | `vm.compileFunction` in the main realm | Same speed as plain code, and no realm mismatch in tests [M] |
| 22 | Pin `milk` from the original Dizengoff spawn (769 m) versus move the spawn | Spawn moved to King George, door kept, about 575 m | At 769 m a queue-bound player dies on errand 1 and a typical one arrives with 2.5 s left [A] |
| 23 | `traffic.populate` in `init` versus `traffic.prewarm` in `startRun` | `prewarm` | Only `startRun` also covers restart, where the player teleports into an empty bubble |
| 24 | `HOLD` cancel: rival leaves, versus rival returns to `COMMIT` | Returns to `COMMIT` | Otherwise arm-and-cancel removes any rival for free |
| 25 | `SEARCH` keyed on the door versus the bay | The bay, at 140 m | Keyed on the door, the bay is 40-79 m ahead and no rival can reach `BLINK` in time [M] |
| 26 | Fixed 27 s slot versus per-controller timing | Table in 8.3 | One-slot lights had no red, and 4-slot lights waited 86 s [M] |
| 27 | Award and pay on the door route versus the bay route | Bay route | The player only drives to the bay. On the door route a good player wins with 56 s spare and no SPOTLESS, and the table in GAME_DESIGN 7 does not hold [A] |

Deviations from the brief: **none.**
