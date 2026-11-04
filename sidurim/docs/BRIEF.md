# Project brief (source of truth for every contributor)

## The request, verbatim

> Build an HTML-javascript (ideally no build) game, in the spirit of crazy taxi, but with a few twists.
> The user plays a regular person in Tel Aviv, doing run errands. The goal is to get to the target place
> and park the car without inflicting damange, or getting damaged by any other car. Cars around drive like
> crazy, crossing in red light, behaving very aggressively, sticking to the players car from the back,
> aggressively joining the traffic on busy roads, bypassing dangerously. Likewise pedestrians try to cross
> the road unexpectedly, walk slowly, cross on red lights etc. Cars may also suddenly stop for unclear
> reasons, including dropping passengers off. Importantly, one has to park the car when they arrive, and
> they may face a fierce "competition" of other cars trying to park at the same spot. If they park while
> another car tries to park at the same spot, the driver may get outside with a knife and try to get them
> out of the car and stab them, so they have to run away. Eventually I'd like a pretty faithful map of Tel
> Aviv, maybe based on google street view or something like that, so the game should be extensible in that
> way, and allow adding graphics for known storefronts, locations, etc.

## Decisions already made (do not reopen)

**Runtime / no build**
- The game is static files. It must run by double-clicking `index.html` (`file://`) AND from any static server.
  Therefore: classic `<script>` tags, a global `window.TLV` namespace, no ES modules in game code, and no `fetch()`
  of local files for required data. Map/content data ships as `.js` files that register themselves into `TLV`.
- Three.js r159 is vendored at `vendor/three.min.js` (global `THREE`). It is the last release with a classic build.
  Do not upgrade it and do not load anything from a CDN at runtime. The game must work offline.
- No npm dependencies in the game. No bundler, no transpiler, no TypeScript.
- `tools/` may be Node ESM with no third-party dependencies. These are optional developer tools, never needed to play.

**Simulation**
- Simulation is separated from rendering. Everything under `js/core`, `js/world`, `js/sim` must run in plain Node with
  no DOM and no THREE, so it can be unit-tested and soak-tested headless.
- Fixed timestep, seeded RNG, deterministic given (seed, input log). Never use `Math.random()` or `Date.now()` in sim code.
- Rendering reads sim state; it never mutates it.

**Presentation**
- 3D with a third-person chase camera, Crazy Taxi style, big bold arcade HUD. Stylized low-poly, warm Mediterranean look.
  An additional high/top-down assist camera for parking.

**Map**
- Real geography from OpenStreetMap, via an offline importer. Raw extract is already downloaded:
  `tools/cache/tlv_center.osm.json` (bbox south 32.050, west 34.755, north 32.100, east 34.800; Overpass JSON; 17.5 MB).
  Yarkon River to Jaffa, the sea to the Ayalon. Do not re-download unless the importer needs extra tags.
- OSM is ODbL: attribution "© OpenStreetMap contributors" must appear in-game and in docs.
- Do NOT use Google Street View as a data source. Google's Maps Platform terms forbid scraping, caching and deriving
  content. The documented extension route is OSM + Mapillary (CC BY-SA) + your own photos.
- The game must remain extensible: bigger map extracts, hand-curated overlays, storefront/landmark graphics added
  through a data registry with no engine changes. If an image is absent, a procedural fallback must render.

**Tone / content rules**
- Comic satire of Tel Aviv driving, affectionate and absurd, like a cartoon.
- The knife attacker is a generic enraged driver. No ethnic, religious, national or political coding of any antagonist,
  by name, dress, speech or anything else. The same goes for all NPCs: road behavior is the joke, not who people are.
- Violence is non-graphic: no blood, no gore. Hits show as screen flash/stumble, and the fail state is comic.
- Hitting a pedestrian is always heavily penalized and never rewarded. There is no score, achievement or benefit for
  running anyone over, including the attacker.
- Real business names may appear as plain text labels from OSM. Do not ship reproductions of real logos.

## Environment

- Linux, Node v21.7.2, Python 3.12, Google Chrome 148. 16 cores.
- Not a git repository. Do not run `git init`. Do not commit.
- Browser testing: Playwright is available by absolute path, it is NOT a project dependency:
  `require('/home/g/tagger/node_modules/playwright')` (v1.62.1) with cached Chromium.
  Launch args that give working WebGL2 headless (software, SwiftShader, so slow; expect single-digit FPS):
  `['--use-angle=swiftshader','--enable-webgl','--ignore-gpu-blocklist','--enable-unsafe-swiftshader']`.
- Screenshots can be taken with Playwright and viewed with the Read tool. Look at them. Claims about visuals need a screenshot.
- Temporary files go in the scratchpad directory given to you, not in the project.
- Shut down any process you start. Do not leave servers running.

## OSM extract profile (measured)

Nodes 117,287; ways 23,989; relations 37.
Drivable ways 4,539 (residential 1863, service 1004, tertiary 883, secondary 344, secondary_link 90, motorway_link 78,
living_street 72, unclassified 65, tertiary_link 62, motorway 49, primary 25, primary_link 4). 3,160 of those are one-way.
`lanes` tagged on 1,393; `maxspeed` on 1,185; named 3,328; `name:en` on 3,238.
Buildings 14,513 ways + 36 relations. `building:levels` on 2,754 (mode 3-5), `height` on 271, named 546.
Nodes: traffic_signals 728, crossing 2,121, bus_stop 530, tree 278.
POIs: shops 932, amenities 2,652 (restaurant 365, cafe 273, fast_food 226, bar 126, atm 59, bank 57, pharmacy 38,
fuel 26, ...), named POIs 2,190. Shop kinds: clothes 138, supermarket 115, convenience 76, bakery 50, hairdresser 41,
laundry 14, greengrocer 15, butcher 14, kiosk 13...
Parking: about 1,200 street ways carry `parking:*`/`parking_zone` tags; 253 `amenity=parking` areas; 79 parking_entrance.
Land: parks 166, gardens 79, beach 13, water 39, coastline 8, construction 229, tree_row 11.
Landmarks present: Azrieli Center (Circular/Triangular/Square towers, Spiral, Sarona), Dizengoff, Habima, Carmel Market,
Sarona Market, Tel Aviv-Yafo Municipality, Ichilov-area, HaCarmel Parking.
Street names are in Hebrew in `name`, English in `name:en`.
