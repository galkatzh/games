# Hand originals

Never loaded by the game. `node tools/pack_assets.mjs` turns these into `data/assets/<assetId>.js`. Run it from the project root.

    assets_src/storefronts/<id>.jpg|png   512 x 256, about 80 KB, packed as sf_<id>
    assets_src/tiles/<id>.jpg|png         256 x 256, about 40 KB, packed as tile_<id>
    assets_src/landmarks/<id>.glb         at most 20k triangles and a 1024 texture, packed as lm_<id>
    assets_src/meshes/<id>.glb            same, packed as mesh_<id>
    assets_src/<kind>/<id>.json           sidecar, required

Sidecar:

    { "source": "own photo",
      "credit": { "author": "...", "license": "own", "date": "2026-10" },
      "attest": { "noLogo": true, "noFaces": true } }

A GLB needs only `noLogo`. An image needs both.

Licences: `own`, `cc0`, `cc-by-sa`. These cover the art, item by item. The project has no licence for its own code yet. The tool refuses a missing sidecar, `credit` or `attest`, a `source` that is missing, empty or not
text, and a file name or sidecar that names Google or Street View. The word list is in "What the pack tool requires" in the main
`README.md`. It reads what you wrote, not the image, so keeping Street View out is still your job. Use OSM, Mapillary (CC BY-SA) or your
own photos. No real logos.

An image over its target is resized in headless Chromium, which needs Playwright. One inside the target needs nothing else. If
anything is refused, the tool exits 1 and still packs the rest.

A GLB is authored forward +X, up +Y, metres, with its origin on the ground under the centre. Material colours are dropped, so colour
comes from the first embedded image.

Before you pack a Mapillary image, read "Graphics sources" in the main `README.md`. The sidecar is not enough. CC BY-SA requires a
credit, and the credits view (I, on the title or pause screen) shows each sidecar's `credit` as text. Mapillary also requires a visible
Mapillary logo and a link back to Mapillary, and the credits view shows neither. So a Mapillary image cannot ship until someone adds both
to that view, with the owner's agreement to show a real logo. The pack tool does not check this.

The Ayalon is not art and is never packed. `node tools/ayalon.mjs` writes `content/tlv_center/ayalon.js` from the OSM extract, and it
ships under the ODbL like the map.
