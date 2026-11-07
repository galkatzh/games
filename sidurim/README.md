# Sidurim / סידורים (Errands: Tel Aviv)

A satirical Crazy Taxi on a real map of central Tel Aviv: you are a regular person with seven errands to run, and every other
road user is the problem. It is a 3D browser game in plain JavaScript and Three.js, and the map is built from OpenStreetMap.

Road behaviour is the joke, not who people are. Nothing in it is graphic.

## Limits

- **No person has played it.** Every driver so far is a script. Nobody yet knows whether a person can park by hand, or win a day.
- **It has never run on a real GPU.** All rendering so far was software GL (SwiftShader). Frame rate on real hardware is unknown, and so
  is every threshold of the automatic quality ladder.
- **Only Chromium has drawn it.** Firefox loaded the scripts but could not create WebGL on the test machine, and WebKit was not tried.
  A real gamepad, a real phone and a WebGL1-only GPU were only emulated.

## Play

Double-click `index.html`. It runs from `file://`, offline. There is nothing to install and no build step.

It also runs from any static server:

```sh
python3 -m http.server 8000
```

Then open <http://localhost:8000/>.

You need a browser with WebGL2, and a keyboard or a gamepad. There is no touch support.

## Controls

The title card and the pause screen show the main keys. This table comes from `js/input/input.js` and `js/ui/menus.js`.

| Action | Keyboard | Gamepad |
|---|---|---|
| Throttle | W or Up | RT |
| Brake, then reverse | S or Down | LT |
| Steer | A D or Left Right | Left stick |
| Handbrake | Space | A |
| Horn | H | B |
| Hazards: hold 1 s, stopped, to park badly | Q | Y |
| Tow to the road: hold 1.5 s below 1 m/s, costs 15 s and ₪100 | R | Back |
| Interact, such as leaving by the passenger door | E | X |
| Parking camera | C | LB |
| Rear-view mirror | V | RB |
| Pause | Esc or P | Start |
| Credits, from the title or pause screen | I | |
| Mute | M | |
| Car radio: another station | N | |
| Car radio: on or off, remembered | B | |

On foot, W A S D or the arrows move you relative to the camera, and Space sidesteps. On a gamepad use the left stick and A.

On the title card, Left and Right (or Up and Down, or 1 and 2) pick the difficulty, L switches between English and Hebrew,
M mutes, and I opens the credits, as it does on the pause screen. To start the day, press Enter or almost any other key, click the
start line, or press Start on a gamepad. Modifier and function keys do nothing there, and Esc, P, C, V, N and B do not start it either.

At the end of a run, Enter or R starts another, or Start on a gamepad. Left and Right, or 1 and 2, change the difficulty first.

### The car radio

From the first key you press, the radio plays a live stream from a random Israeli station: Galgalatz, Galei Tzahal, Kan, 103FM, Eco 99
and others built into `js/ui/audio.js`, joined at run time by the Israeli stations the public directory
[radio-browser.info](https://www.radio-browser.info) lists over HTTPS. N tunes to another station at random, and B turns the radio off
or on again, which the browser remembers. M mutes it with everything else, and pausing stops it. It comes back live, not where it
stopped. It is quieter behind the menus, and quieter still once you are out of the car.

A station that will not play is skipped for another, and after eight in a row the radio gives up until you press N or B. Some
stations refuse listeners outside Israel. The streams come from the stations' own servers, so the radio needs a network connection.
Without one it says so and stays quiet, and the game itself is unaffected. `radio=off` in the address keeps it off.

### URL parameters a player might want

Add them to the address, for example `index.html?lang=he&quality=low`.

| Param | Values | Effect |
|---|---|---|
| `lang` | `en`, `he` | Language. Beats the last choice made with L, which the browser remembers |
| `quality` | `auto`, `low`, `med`, `high` | Render quality. `auto`, the default, lowers the resolution while frames are slow. Try `low` on a weak GPU |
| `mute` | `1` | Starts muted |
| `radio` | `off` | No car radio. `on` forces it on, even in a browser driven by a test |
| `notitle` | `1` | Skips the title card |

Pick the difficulty on the title card, and the browser remembers it. RELAXED is the choice on a first visit: 200 s on the clock and
2.7 times the time award per errand. NORMAL is 120 s and the plain award, the design's own table, and no script that keeps to the law
has won a NORMAL day. `difficulty=normal` in the address opens the card on that choice, over the remembered one, and you can still
change it there. With `notitle=1` it is simply the difficulty, and NORMAL is the default.

Every parameter is listed under [Development](#all-url-parameters).

## How the game goes

A day is seven errands, and the last one is always the kindergarten pickup, the gan. A big 3D arrow points along the route.

**The clock.** It runs down while you drive. You earn more by parking, not by arriving. It stops during cards, payouts and the
knife encounter.

**Parking.** An errand only counts once the car is parked. The marked bay pays best, in time and money: come in slowly. When the bay
is yours the line says `CREEP. STRAIGHTEN UP.`: keep rolling slowly and square up. When it says `THE BAY IS YOURS. NOW STOP.`, stop,
and hold still while the bar fills. If `BRAKE. NO ROOM LEFT.` flashes, brake: something is close ahead. Stopping is what locks your
pose, so stop before the line says to and you take the bay as crooked as you stand. If you cannot get the bay, hold Q to use a coloured
curb, or to double-park anywhere near the door. Both pay less, and an inspector may fine you.

**The rival.** Other drivers want your bay. Watch for a blinker. Wait behind a driver who has committed to the bay and you are
paid for your manners, and another bay opens. Take the bay after his blinker came on and you have stolen it, and his rage gauge
decides what happens: a curse, your car blocked in, or the knife.

**The knife.** The driver gets out and comes for your door. Press E to leave by the passenger side before the driver's door gives
way, then run for the shop door behind the beacon. If a wall stands between you and that shop, the beacon moves to another door you
can reach. The arrow and a blue `THIS WAY` marker show the way round. You escape by reaching the door, by losing him, or by lasting
out the 25 s chase. You can only run: there is no fighting back. Three strikes ends the run.

**You lose** if the clock reaches 0, if your No-Claims bar empties, or on the third knife strike. Hitting a pedestrian is always
heavily penalized and never rewarded, and that includes the attacker. A second hit ends the run.

## Extending it

Storefronts, landmarks, errands, overlays and new map areas are all data. None of them needs an engine change. Run every command
below from the project root.

Three rules apply throughout:

- **Things bind to the map through an anchor**, `{ osm: 'n123', at: [lat, lon], name: '...' }`. It holds an OSM id of type `n`, `w`
  or `r`, and the position and name let it survive a re-import when OSM renumbers something.
- **An anchor that resolves to nothing is skipped silently.** An invalid item is skipped with a warning, listed by
  `TLV.registry.problems()`, and shown on screen with `?dev=1`.
- **Visual replacement never changes collision.** Only an overlay can do that.

To find an OSM id, click the place on <https://www.openstreetmap.org> with the query tool, or search the extract:

```sh
node -e "for (const e of require('./tools/cache/tlv_center.osm.json').elements) if (e.tags && e.tags['name:en'] === 'Falafel HaKosem') console.log(e.type, e.id, e.lat, e.lon)"
```

That prints `node 1791481321 32.0764281 34.7766833`, so the anchor is `n1791481321`.

### Add a storefront sign and a photo

A sign alone is one row. Append it to `content/tlv_center/storefronts.js`:

```js
TLV.q.push(['storefront', {
  id: 'falafel_hakosem',
  anchor: { osm: 'n1791481321', at: [32.0764, 34.7767], name: 'Falafel HaKosem' },
  sign: { text: { he: 'פלאפל הקוסם', en: 'Falafel HaKosem' } }
}]);
```

To add a photo:

1. Save it as `assets_src/storefronts/falafel_hakosem.jpg`. It must show no logo and no faces.
2. Beside it, write `assets_src/storefronts/falafel_hakosem.json`:

   ```json
   { "source": "own photo",
     "credit": { "author": "Your Name", "license": "own", "date": "2026-10" },
     "attest": { "noLogo": true, "noFaces": true } }
   ```

3. Run `node tools/pack_assets.mjs`. It writes `data/assets/sf_falafel_hakosem.js` and prints the row to use.
4. Add these three fields to the row above:

   ```js
   art: { asset: 'sf_falafel_hakosem' },
   credit: { author: 'Your Name', license: 'own', date: '2026-10' },
   attest: { noLogo: true, noFaces: true }
   ```

The photo loads when the car comes within 250 m, and the sign shows until then. If the photo is missing, the sign renders. If
there is no sign, the OSM name renders, then a label for the kind of shop.

To check that the anchor bound, open `index.html?notitle=1&dev=1` and run this in the console. `exact`, `moved` or `relocated`
means it bound. `orphan` means it was skipped.

```js
TLV.anchors.resolve(TLV.debug.current().world, { osm: 'n1791481321' }, { type: 'poi' }).how
```

### Add a landmark mesh

This example swaps Habima's extruded footprint for a model. Its row already exists in `content/tlv_center/landmarks.js`.

1. Export a GLB as `assets_src/landmarks/habima.glb`: forward +X, up +Y, in metres, with its origin on the ground under the centre.
   At most 20,000 triangles and a 1024 x 1024 texture. The tool flattens the scene into one mesh and keeps positions, normals, UVs
   and the first embedded image. Material colours are dropped, so colour must come from that texture.
2. Beside it, write `assets_src/landmarks/habima.json`. A model only attests to logos:

   ```json
   { "source": "own model",
     "credit": { "author": "Your Name", "license": "own", "date": "2026-10" },
     "attest": { "noLogo": true } }
   ```

3. Run `node tools/pack_assets.mjs`. It writes `data/assets/lm_habima.js`.
4. Change the Habima row to this:

   ```js
   TLV.q.push(['landmark', { id: 'habima', anchor: { osm: 'w149522836', at: [32.0728, 34.7790], name: 'Habima' }, mode: 'replace', style: 'civic_white', model: { asset: 'lm_habima', yawDeg: 0, scale: 1 }, credit: { author: 'Your Name', license: 'own', date: '2026-10' } }]);
   ```

The model stands at the centre of the footprint and loads within 1,000 m. Until it has loaded, or if it is missing, `style` paints
the OSM building. The modes are `restyle` (style only), `replace` (the model hides the OSM building) and `add` (the model stands
at the building's centre and hides nothing, or alone at `anchor.at` if no building resolves).

To check it, stand near the landmark and run `TLV.render.landmarks.models()` in the console. Yours should show `ready: true`.

### Add an errand

Add an object to the `ERRANDS` array in `content/tlv_center/errands.js`, above `gan_pickup`:

```js
{
  id: 'fresh_bread', tier: 2, weight: 3,
  target: { kinds: ['bakery'], named: 'prefer', anchor: null },
  fallbackKinds: ['supermarket'],
  text: { he: 'לחם מ{poi}. בלי לחם אל תחזור.', en: 'Bread from {poi}. Do not come back without it.' },
  mod: null
},
```

- `tier` is `1`, `2`, `3` or `'finale'`. A day draws two errands from each tier, then the finale. Leg length, clock and pay come from
  global tables, never from the errand.
- `target.kinds` are POI kinds, which `tools/rules/kinds.json` maps from OSM tags. `named` is `prefer`, `require` or `any`.
  `anchor` pins an errand to one place. A pin closer than a leg's minimum distance is replaced: if its door stands under 220 m in a
  straight line from where the leg starts (`doorMinM` in `js/sim/game/tune.js`), the errand takes another door of its kinds, as an
  errand with no pin does. The same happens if the anchor resolves to nothing, if the place is not an eligible target, or if no route
  reaches it.
- Pick a kind in `kindLabels` in `js/sim/game/tune.js`. Those are the labels shown for a shop with no name, and any other kind
  shows its raw id.
- Text needs both languages. A business is named only through `{poi}`, which both languages must use or neither. A sentence holding
  `{poi}` is a plain instruction, and has none of "they", "them" or "their".
- `mod` stays `null`.

To try it, open `index.html?notitle=1&errandDef=fresh_bread`, which makes it the first errand.

Two tests pin the shipped table on purpose, so a new errand fails them until you add it: the list in `tests/game/content.test.mjs`
and the count at the end of item 1 in `tests/game/errands.test.mjs`.

A new errand also changes what every seed draws, so item 1 then walks 100 different days. `tests/game/gan_binds.test.mjs` walks 400
of them with this very example added: every errand binds, and no day ends before the gan.

### Add an overlay fix to the map

An overlay is a hand correction that survives every re-import. Never edit `data/maps/`, because the importer overwrites it.

Add an op to an array in `tools/overlays/tlv_center/`. Every `.json` file there is read in name order. POI fixes go in `pois.json`:

```json
[
  { "op": "poi.rename", "anchor": { "osm": "n4914006053" }, "name": { "he": "ספרים", "en": "Books" },
    "why": "A plain label for this shop" }
]
```

Road fixes go in `roads.json`:

```json
{ "op": "road.set", "anchor": { "osm": "w154735772" }, "set": { "lanes": 2 }, "why": "Tag out of date" }
```

Then rebuild the map. `why` is required, and the import stops without it.

```sh
node tools/import.mjs tlv_center
```

Check `tools/reports/tlv_center/orphans.json` afterwards. An op whose anchor resolved to nothing is listed there. It did nothing, and
the import still exits 0.

| Op | Fields, beside `op` and `why` |
|---|---|
| `road.set`, `node.set` | `anchor`, `set: { tag: value or null }` |
| `road.add` | `points: [[lat, lon] or { osm: 'n123' }, ...]`, `tags: { highway, ... }` |
| `road.delete`, `building.delete`, `poi.hide` | `anchor` |
| `building.set` | `anchor`, `set: { tag: value or null, style: 'styleId' }` |
| `building.clip` | `anchor`, `line: [[lat, lon], [lat, lon]]`, drops the footprint to the right of the line |
| `poi.add` | `at: [lat, lon]`, `kind`, `name: { he, en }` |
| `poi.rename` | `anchor`, `name: { he, en }` |
| `poi.move` | `anchor`, `at: [lat, lon]` |
| `kerb.set` | `anchor`, `side: 'left', 'right' or 'both'`, optional `range: [s0, s1]`, `set: { tier, paint, zone, form }` |

### Re-import or enlarge the map

To re-import, run `node tools/import.mjs tlv_center`. It reads the OSM extract in `tools/cache/`, touches no network, and takes
about 10 s. The same input gives a byte-identical `data/maps/tlv_center/map.js`.

The Ayalon has a file of its own. The importer leaves the motorway out of the map, and `node tools/ayalon.mjs` writes it from the same
extract into `content/tlv_center/ayalon.js`: 126 lines of carriageway and ramp, drawn as scenery that the sim never reads. The import
does not run it, so run it yourself after the extract changes. `tests/render/ayalon.test.mjs` fails until you do. It covers
`tlv_center` only.

To make a larger map, this example extends the shipped area about 2 km north, past the Yarkon.

1. Create `tools/areas/tlv_north.json`. Keep the same `origin`. `bbox` is south, west, north, east. `sources` names the extracts to merge.

   ```json
   {
     "id": "tlv_north",
     "bbox": [32.05, 34.755, 32.12, 34.80],
     "origin": [32.075, 34.7775],
     "title": { "he": "תל אביב צפון", "en": "Tel Aviv North" },
     "sources": ["tlv_center", "tlv_north"]
   }
   ```

2. Copy the overlays, because they belong to one area. Without the `tlv_center` set, this example has 28 dead ends on major roads,
   where the underpasses used to run. With it, it has none:

   ```sh
   cp -r tools/overlays/tlv_center tools/overlays/tlv_north
   ```

3. Download the extract and import it. `--fetch` asks Overpass for this area's own extract and names the project as
   `sidurim-map-import/1.0`, because Overpass refuses a client with no name. Overpass answers 502 or 429 when it is busy, so if the
   download stops on one of those, wait a while and run it again:

   ```sh
   node tools/import.mjs tlv_north --fetch
   ```

   This writes `tools/cache/tlv_north.osm.json`, `data/maps/tlv_north/`, `tools/reports/tlv_north/`, and a new `data/maps/index.js`. The
   default stack is enough, at this area's 137,000 nodes and beyond. The fixed gates for the shipped map print `n/a` on any other area.
   Leave `--fetch` off on later imports, and the importer reads the file it already has.

4. Open `index.html?map=tlv_north`. `tlv_center` stays the default map.

A map with no key of its own in `content/index.js` uses the `default` list, and content outside the new area is skipped. `tlv_center`
has a key of its own, which adds the Ayalon, so a new area draws its fence but no motorway. To give a map a list of its own, add a key for it there.

**Add a spawn row, or the enlarged map can lose the short first errand.** A run starts on the map's spawn row, and on the first
routable lane if it has none. The first errand is pinned to one shop, so the start decides its length. On `tlv_north` with no spawn
row, its route was 1,306 m against 444 m on `tlv_center`, with the same 200 s on the RELAXED clock. With a copy of the `tlv_center` row
it was 444 m again. To add one, copy the row in `content/tlv_center/world.js` and change `map`, plus `anchor` if you want another
street.

Size targets: at most 1.6 MB of `map.js` for `tlv_center`, and 4 MB for all of Tel Aviv-Yafo.

### Pack assets

The game cannot load a loose image on `file://`, so `tools/pack_assets.mjs` turns originals into scripts.

```sh
node tools/pack_assets.mjs
```

| Folder | File | Packed as | Target |
|---|---|---|---|
| `assets_src/storefronts/` | `<id>.jpg` or `.png` | `sf_<id>` | 512 x 256, about 80 KB |
| `assets_src/tiles/` | `<id>.jpg` or `.png` | `tile_<id>` | 256 x 256, about 40 KB |
| `assets_src/landmarks/` | `<id>.glb` | `lm_<id>` | 20,000 triangles, 1024 texture |
| `assets_src/meshes/` | `<id>.glb` | `mesh_<id>` | 20,000 triangles, 1024 texture |

Each original needs a sidecar `<id>.json` beside it, as in the examples above. The tool writes `data/assets/<assetId>.js`, regenerates
`data/assets/index.js`, and prints the row to paste into your content file. `assets_src/` is never loaded by the game.

An image larger than its target size, or over twice its byte target, is cover-cropped and resized in headless Chromium, so that one
case needs Playwright (see [Browser tests](#browser-tests)). Any other image is packed as it is, and a smaller one is not enlarged. A
GLB never needs a browser.

The tool exits 0, or 1 if it refused anything. It still packs everything else. `--root DIR` works on another tree. See
[what the pack tool requires](#what-the-pack-tool-requires).

### Pack sounds

Recordings live in `assets_src/sounds/`, each original beside a sidecar that says where it came from and which spans to cut, in
seconds of the original:

```json
{ "file": "car_horn.flac", "title": "Car Horn",
  "source": "https://commons.wikimedia.org/wiki/File:Car_Horn.wav",
  "changes": "cut into two clips and a loop, mono, peak-normalized, re-encoded",
  "credit": { "author": "15HPanska_Ruttner_Jan", "license": "cc0", "date": "2019-02" },
  "cuts": { "car_a": [0.515, 0.905] },
  "loops": { "car_hold": [1.955, 2.085] } }
```

A cut is a one-shot, faded at both ends, peak-normalized and encoded as mono MP3. A loop is a held tone: the tool picks a length that
lines the seam up on the wave, crossfades it, and keeps it as 16-bit PCM so MP3 padding cannot put a gap in it. Licences are `own`,
`cc0`, `cc-by-4.0` and `cc-by-sa`. `changes` says what was done to the original, which CC BY asks for, and the credits view shows it.
Run `node tools/pack_sounds.mjs`, which needs ffmpeg. It rewrites `data/sounds/sounds.js` and
`data/sounds/index.js`. `js/ui/audio.js` knows the IDs `car_a`, `car_b`, `car_hold` and the four `bus_*` clips. Without one of them, that
horn stays synthesized.

## Graphics sources

The route for graphics is **OpenStreetMap plus Mapillary plus your own photos**. These notes were checked on 2026-11-02 against the
pages linked. They are a reading of those terms, not legal advice, and the terms change.

### Why not Google Street View

Street View imagery cannot be packed into a game. The
[Google Maps Platform Terms of Service](https://cloud.google.com/maps-platform/terms) (last modified August 26, 2026), section 3.2.3:

> (a) No Scraping. Customer will not export, extract, or otherwise scrape Google Maps Content for use outside the Services. For
> example, Customer will not: (i) pre-fetch, index, store, reshare, or rehost Google Maps Content outside the services; (ii) bulk
> download Google Maps tiles, Street View images, [...]

> (b) No Caching. Customer will not cache Google Maps Content except as expressly permitted under the Maps Service Specific Terms.

> (c) No Creating Content From Google Maps Content. Customer will not create content based on Google Maps Content.

> (e) No Use With Non-Google Maps. [...] Customer will not [...] (ii) display Street View imagery and non-Google Maps on the same screen

Packing an image into `data/assets/` is storing and rehosting it. Tracing a facade or a model from one is creating content from it.
Showing one in a game on an OpenStreetMap map is clause (e). The only Street View allowance in the
[Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms) (last modified October 28, 2026) is caching the
`pano_ID` value, which is an id and not an image.

Other routes do not help. An account with an EEA billing address falls under the
[EEA terms](https://cloud.google.com/terms/maps-platform/eea), whose section 3.3.2 has the same three clauses (a), (b) and (c). Without
the API, Google's [permissions page](https://about.google/brand-resource-center/products-and-services/geo-guidelines/) says "You may not
screenshot Street View imagery or remove it from embedded sources for any purpose."

So `tools/pack_assets.mjs` refuses an item whose file name or sidecar names Google or Street View. That reads only what you wrote, as
[what the pack tool requires](#what-the-pack-tool-requires) explains. Keeping Street View out is still your job.

### OpenStreetMap

All geometry and names come from OSM through `tools/import.mjs`. It is the first place to fix anything: correct OSM, or add an
overlay. See [Credits and licences](#credits-and-licences) for its terms.

### Mapillary

Read the [Mapillary terms](https://www.mapillary.com/terms) (effective February 15, 2024) before you ship anything from it.

Licence, section 3(b):

> Your use of any User Content provided by other users is subject to the Creative Commons Share Alike (CC BY-SA) license, unless we
> indicate otherwise.

The terms give no version number. The [OpenStreetMap wiki](https://wiki.openstreetmap.org/wiki/Mapillary) says 4.0.

**The simple use is as a reference, and nothing from it ships.** Section 13 permits using Mapillary "to develop, edit and contribute
content to OpenStreetMap". Look at the street, fix OSM, and re-import.

**Shipping an image takes more than the sidecar.** Section 11, for developers:

> If you are downloading individual images and serving them from your own servers, you must attribute the image(s) by visibly
> displaying the Mapillary logo and linking back to the Mapillary homepage or corresponding Mapillary image page.

CC BY-SA also requires you to credit the author, and the packed image stays under CC BY-SA. The pack tool copies each sidecar's `credit`
into `data/assets/index.js`, and the in-game credits view lists it as plain text: the asset, the author, the licence and the date. That
covers the credit. **It does not meet section 11**: the credits view shows no Mapillary logo and no link, and the pack tool packs a
`cc-by-sa` sidecar without asking about either.

So before a Mapillary image ships, change the credits view (`paintCredits` in `js/ui/menus.js`) to show the Mapillary logo and a link to
the image's page on Mapillary, or to its homepage, beside that asset's credit. Ask the owner first: the project's rule is to ship no
reproduction of a real logo, and it has no exception for this one yet. Until both are done, use Mapillary as a reference only. No packed
image of any kind ships in this repository today.

Also from those terms: section 5 forbids any attempt to "re-identify or unblur any aspect of any Content, including any individual or
license plate", and section 12 limits commercial use. Read section 12 before you sell anything built on it.

### Your own photos

These are the simplest: `license: "own"`, and the credits view shows them as your own work. The rules still apply: no real logos, and no faces. A shopfront
usually carries its logo, so frame or crop around it. Business names appear only as plain text.

## Development

The binding contract and every API are in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md), and gameplay numbers are in
[`docs/GAME_DESIGN.md`](docs/GAME_DESIGN.md). Both froze before the game was finished. **If you read either, read
[`docs/CHANGES.md`](docs/CHANGES.md) beside it**: it lists, section by section, every place the game now differs from them, and where
they disagree it wins. The short version:

- Classic scripts and a global `TLV`, because the game must run from `file://`. No ES modules or `fetch` in game code.
- `js/manifest.js` is the one load order, for the browser and for Node. Every file in `js/` must be listed there.
- `js/core`, `js/world` and `js/sim` run in plain Node with no DOM and no Three.js, and never touch the wall clock or
  `Math.random`. All randomness comes from `S.rng.<stream>`.
- The sim runs at a fixed 60 ticks per second. Render reads sim state between ticks and never writes it.
- Data files only push to `TLV.q`, so their load order never matters.

Tools and tests need Node 21 and no npm packages. They have been run on v21.7.2.

### Unit tests

Keep the quotes. The directory form `node --test tests/` fails on Node 21.

```sh
node --test 'tests/**/*.test.mjs'
node --test 'tests/core/**/*.test.mjs'
```

The first runs everything except the browser suites, in about 3 minutes. The second runs one package. The full run skips two wall-clock
budget tests, because they would compete with their siblings. This runs them alone, in series:

```sh
TLV_PERF=1 node --test --test-concurrency=1 'tests/world/*.test.mjs'
```

### Browser tests

Each is a plain script that opens its own headless Chromium and closes it. Run one at a time.

```sh
node tests/e2e/file_protocol.e2e.cjs
node tests/e2e/smoke.e2e.cjs
node tests/e2e/knife.e2e.cjs
node tests/e2e/replay.e2e.cjs
node tests/e2e/extensibility.e2e.cjs
node tests/ui/ui.e2e.cjs
node tests/render/city.e2e.cjs
node tests/render/shots.e2e.cjs
node tests/render/actors_scenes.e2e.cjs
node tests/render/actors_contract.e2e.cjs
node tests/game/debug.e2e.cjs
node tests/player/input.e2e.cjs
```

`file_protocol` covers `file://`, a static server, the error overlay and Hebrew. `smoke` has the errands bot finish an errand. `knife`
runs all four exits. `replay` covers replay and render determinism. `extensibility` adds a storefront, a landmark, an errand and an
overlay op on a copy of the tree, with data changes only.

Playwright is not a dependency of the project. It is found by an absolute path from the machine this was written on,
`/home/g/tagger/node_modules/playwright`, at `tools/lib/pw.cjs` line 10 and `tests/ui/lib.cjs` line 114. On another machine, install
Playwright with its Chromium anywhere you like and change those two lines. Everything else goes through `tools/lib/pw.cjs`.

Rendering is headless software GL (SwiftShader), which is slow, so the suites wait on ticks and state, never on frame rate.
Screenshots go to `$TLV_SHOTS`, by default a temp directory, never the project.

An exit of 77 means a suite only skipped, because a file it needs is missing. `--stub` runs `smoke`, `knife`, `replay` or
`extensibility` on a throwaway stub tree, which proves the script and not the game.

### Soak

Headless parallel runs against every gate in section 17.3 of the contract. `--jobs` is how many run at once, so set it for your machine.

```sh
node tools/soak.mjs --seeds 1-20 --bots patrol,idle,chaos --n 100,120 --minutes 15 --jobs 4 --inject trap
node tools/soak.mjs --seeds 1-20 --bots errands,braker --minutes 15 --jobs 4
```

The first is the traffic and people matrix, the second the game matrix. `--inject trap` needs `idle` in `--bots`, and is refused
without it. With no `--n` the target is the sim's own `stats.cap`.

Each matrix also runs one memory probe per bot and density, on the first seed, 60 sim-min long unless `--heap-minutes` says otherwise.
The Memory gate fits the heap slope over the probe's second half, against the limit of 1 MB per 10 sim-min.

The Contest gate holds its limits, BLINK in view on at least 80% of contests and the bot losing 20-45%, to at least 300 contests. A gate
on about 90 has a standard error of about 4%, so a smaller run reads the trajectories more than the rule. Under 300 it prints
`NOT JUDGED` with its n and the rates, which fails nothing and passes nothing. The second command above holds about 90, so this one
judges it:

```sh
node tools/soak.mjs --seeds 1-96 --bots errands --minutes 15 --jobs 4
```

Each prints the config every job really ran and its realised density, then the gates and a verdict, and writes
`tools/reports/soak/<timestamp>.json`, or the `--out` path. It exits 0 if all gates pass, 1 if one fails or the report cannot be
written, and 2 on bad arguments. A run that did not really happen cannot look like a pass: it fails if realised density is under 90%
of target, if any job dies, or if a gate has no data. `--allow-skip` lets a gate with no data show as SKIP, and never excuses a low
density.

The tick budget is the one gate that reads the wall clock, so soak on a quiet machine. With the load average over 40 on 16 cores it failed
at a p99 of 6.8 ms, where a run at a load of about 5 reads under 1 ms against the limit of 6.

### What is deliberately not gated

- **Frame rate and frame time.** Only software GL is available here, so hard render gates are counts, read from
  `TLV.render.info()`. Frame times are for a person on real hardware (contract, section 18).
- **Looks.** Some suites read single pixels to prove a fact, but the repository holds no reference images. Whether a frame looks right
  is for a person reading the screenshots.
- **Wall-clock budgets in the default test run.** They are skipped there and enforced by the `TLV_PERF=1` command.
- **The tick budget on short soaks.** It applies only to runs of 1 sim-minute or more.
- **Balance speed.** The `errands` bot's real mean speed is report-only.
- **Soak diagnostics.** The wait-for chains and the delay budget by junction ship in every result to find causes. They fail nothing.
- **Hashes between engines.** A hash from a browser and one from Node may differ in the last bits of `Math.sin`, `cos`, `atan2`,
  `exp`, `log` and `pow`.

### Debugging

`TLV.debug` is always available in the console and through `page.evaluate`: `state()`, `current()`, `hash()`, `pause()`, `resume()`,
`step(n)`, `setInput({ throttle: 1 })`, `exportReplay()`, `importReplay(log)`, plus hooks from each package such as
`teleport(x, y, h)`, `forceContest()` and `forceKnife()`. The full list is in section 16.2 of the contract.

### Replays and hashes

The same seed, map, content, input log and build give the same `TLV.sim.hash(S)`, within one JS engine. To record, add `?record=1`,
then call `TLV.debug.exportReplay()`. `TLV.debug.importReplay(log)` takes the seed and all params from the log.

### All URL parameters

All are optional. The browser and Node (`createTLV({ params })`) parse them alike, in `js/core/config.js`. A value that cannot be read
prints `TLV.config: ignoring` on the console and takes the default. A number out of range is clamped with no warning. The last column
says what each one really does with a bad value. A flag (0, 1) also takes `true`, `false` or nothing after the name, which means 1, and
any other number counts as 1. An unknown parameter is ignored, and a repeated one keeps its last value.

| Param | Type | Default | Effect | A bad value |
|---|---|---|---|---|
| `seed` | int | wall clock in the browser, 1 in Node | Sim seed | Not a number: warns, default. A negative or fractional number wraps to an unsigned integer: `-1` is 4294967295, `1.9` is 1 |
| `map` | string | the map index default | Map ID, or a local script path such as `tests/fixtures/mini_map.js` | An unknown ID, or a path with `..`, stops the boot on an `Unknown map` message |
| `lang` | `en`, `he` | last choice, then `en` | UI and card language | Warns and shows English. The remembered choice does not apply, because the address named a language |
| `debug` | 0, 1 | 0 | Debug overlay, also enables `invariants` | Warns, stays 0 |
| `dev` | 0, 1 | 0 | On-screen list of unresolved content and assets | Warns, stays 0 |
| `invariants` | 0, 1 | 0 | Runs invariants every 60 ticks | Warns, stays 0 |
| `record` | 0, 1 | 0 | Records input for `TLV.debug.exportReplay()` | Warns, stays 0 |
| `autoplay` | bot name | none | Bot drives: `idle`, `patrol`, `chaos`, `braker`, `errands` | Warns `unknown bot` and uses `idle`, which never moves the car and, without `notitle=1`, never leaves the title |
| `notitle` | 0, 1 | 0 | Skips the title card | Warns, stays 0 |
| `difficulty` | `relaxed`, `normal` | the title card's choice | Beats the remembered choice on the title card, where the player can still change it. It is not remembered. With `notitle=1` or a bot it is the difficulty, and `normal` is the default | Warns `TLV.game: ignoring`. The card opens on the remembered choice, and with no card the run is `normal` |
| `errand` | 1-7 | 1 | Starts at this errand | Not a number: warns, 1. Out of range: clamped to 1-7. A fraction is cut to a whole number |
| `errandDef` | id | none | Forces the definition of the errand the run starts on | No warning. An unknown id takes the first unused definition of that errand's tier that binds, so on errand 1 it is `milk` |
| `spawn` | `x,y,h` | content | Overrides the spawn pose: metres, metres, radians | Not three numbers: warns, the content's spawn |
| `clock` | seconds | difficulty | Starting clock | Not a number: warns, the difficulty's start. 0 or less: no warning, clamped to 0, and the run ends on `CLOCK` at once |
| `heat` | 0-1 | computed | Forces the director's heat | Not a number: warns, computed. Out of range: clamped to 0-1 |
| `immortal` | 0, 1 | 0 | Clock, HP, strikes and pedestrian hits never end the run. For soak | Warns, stays 0 |
| `density` | int | 100, adaptive | Traffic target. Setting it, even to 100, disables the adaptive rule and the lane-km cap | Not a number: warns, adaptive. Below 0: clamped to 0. A fraction is cut to a whole number |
| `traffic` | 0, 1 | 1 | Traffic on or off | Warns, stays 1 |
| `peds` | 0, 1 | 1 | Pedestrians on or off | Warns, stays 1 |
| `incidents` | 0, 1 | 1 | Staged incidents on or off | Warns, stays 1 |
| `contest` | `auto`, `off`, `force` | `auto` | Spot War policy | Warns, `auto` |
| `knife` | `auto`, `off`, `force` | `auto` | Forces or forbids the knife tier | Warns, `auto` |
| `quality` | `auto`, `low`, `med`, `high` | `auto` | Render quality. `auto` starts on `high`, or `low` on a software renderer, then steps the pixel ratio down to 0.6, and at the bottom drops shadows and draw range, while 2 s of frames average over 26 ms, and climbs back after 8 s of calm. The other three never change | Warns, `auto`. Case counts: `HIGH` is a bad value |
| `mute` | 0, 1 | 0 | Mutes audio. A saved mute also applies | Warns, stays 0 |
| `radio` | `auto`, `on`, `off` | `auto` | The car radio. `auto` plays it, except in a browser that reports itself driven by automation (`navigator.webdriver`), so no browser test reaches the network. B's saved choice also applies | Warns, `auto` |
| `hud` | 0, 1 | 1 | Hides the HUD for clean screenshots | Warns, stays 1 |
| `timescale` | number | 1 | Multiplies loop speed. Changes neither `DT` nor the sim's own slow motion | Not a number: warns, 1. 0 or less: clamped to 0.001, which all but stops the game |

## Credits and licences

**Map data** © OpenStreetMap contributors, available under the Open Database License (ODbL 1.0). See
<https://www.openstreetmap.org/copyright> and `data/maps/tlv_center/ATTRIBUTION.txt`, which gives the extract's timestamp. The attribution
appears on the title and pause screens, and I opens the credits view from either: the attribution, the ODbL and its address, Three.js and
its MIT licence, the credit of every packed asset and every recorded sound. It works offline and fetches nothing. `data/maps/*/map.js` is a derived database
and ships under the ODbL. So does `content/tlv_center/ayalon.js`, which `tools/ayalon.mjs` derives from the same extract and which
carries the attribution in its header. In OSM's words: "If you alter or build upon our data, you may distribute the result only under
the same license."

**Three.js** r159, MIT licence, is vendored in `vendor/three.min.js`. The licence text is `vendor/three.LICENSE`.

**Horn recordings.** Every horn you hear is cut from two recordings on Wikimedia Commons. The originals are in `assets_src/sounds/`,
unchanged except that the WAV is stored as lossless FLAC, and each sidecar there names the cuts. `node tools/pack_sounds.mjs` (it
needs ffmpeg) cuts, fades, peak-normalizes and encodes them into `data/sounds/sounds.js`, and writes their credits into
`data/sounds/index.js` for the credits view:

- [Car Horn](https://commons.wikimedia.org/wiki/File:Car_Horn.wav) by 15HPanska_Ruttner_Jan, from
  [Freesound](https://freesound.org/people/15HPanska_Ruttner_Jan/sounds/461679/), CC0 (public domain dedication). Small cars, and the
  player's own horn, which is a seamless loop of its steady tone.
- [City bus MAN SG 220 horn](https://commons.wikimedia.org/wiki/File:WWS_CityBusMANSG220horn.ogg) by Work With Sounds / Technical
  Museum of Slovenia, [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/). Cut into four clips and re-encoded. Buses and trucks
  at its own pitch, and some cars pitched up into a car horn's range.

**The car radio** plays the stations' own live streams. They are not part of the game, nothing of them is stored, and they belong to
their broadcasters.

The project has no licence for its own code yet.

### What the pack tool requires

`tools/pack_assets.mjs` refuses an item, and packs the rest, when:

- it has no sidecar, or the sidecar is not valid JSON;
- `source` is missing, is not text, or is empty;
- the file name, or any key or string in the sidecar, holds a refused word (below);
- `credit` is missing, or has no `author`;
- `credit.license` is not `own`, `cc0` or `cc-by-sa`;
- `attest` is missing, or `attest.noLogo` is not `true`;
- it is an image and `attest.noFaces` is not `true`;
- a GLB is over 20,000 triangles or has a texture over 1024.

The refused words are `google`, `goo.gl`, `ggpht`, `gmaps`, `gsv`, `street view`, `גוגל` and `סטריט ויו`. The two-word ones also match
with no gap, or with a dash, dot, underscore or plus between the words. `gmaps` and `gsv` do not match inside a longer word. Case, accents,
full-width forms and Cyrillic or Greek letters that look Latin make no difference. The check does not read meaning, so "not from Street
View" is refused too. Leave the words out.

The sidecar is an attestation, and nothing checks an image for you. The word check stops an honest label. It cannot tell where an image
came from, so a Street View capture with a clean file name and sidecar still packs. Make sure `source` is true, and the same for `noLogo`
and `noFaces` when you sign them. `credit` and `attest` go into the printed row and never into the packed file. `credit` also goes into
`data/assets/index.js`, for the credits view.
