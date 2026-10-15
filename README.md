# OTOMIG — Open Transit On Map Info Game

A transit sandbox with Mini Metro's look and drawing feel and Cities: Skylines' public-transport management, set on a real 15×15 km piece of the world from OpenStreetMap.

You draw bus, tram, metro and train lines. Passengers appear where people live and want to go. Money comes from tickets, coverage subsidies and advertising. There is no win condition — a good network settles into balance. Some places can only ever support a bus line or two, and that is fine.

**Status:** Phases 0–4 of 7 done — region import, base map, the bus core loop (lines, passengers, transfers, money, save/load), trams with on-street track and off-road dragged segments, and metro and train: track built through waypoints, stations on it, and lines that route on compatible track. Wherever track leaves the street, the terrain decides where it tunnels and bridges, and a height-profile strip shows why while you draw. The import is verified against live OpenStreetMap data: a 5 km slice of central Athens imports in about 20 seconds and two Overpass requests. The full economy (loans, the fare slider) is next — see [HANDOFF.md](HANDOFF.md).

## Running it

No build step and no dependencies to install.

```bash
npm start          # python3 -m http.server 8000
# then open http://localhost:8000
```

Click **Use the test region** for a synthetic region that needs no network at all, or search a real place and import it. Regions default to 6 × 6 km; the slider reaches 15 km. A dense 5 km import takes about 20 seconds and two Overpass requests, a 10 km one about two minutes; rural areas are much faster. Overpass's own query time dominates and is variable, so an occasional retry in the progress text is normal.

Serve it over `http://` — don't open `index.html` as a `file://` URL. ES modules, the import worker and the OSM services all need a real origin.

```bash
npm test               # 469 logic assertions, plain Node, no framework, no dependencies
npm run test:browser   # 111 assertions driving real Chromium (needs: npm install)
npm run test:live      # 25 assertions against a REAL import — hits live OSM services
npm run fixture        # regenerate fixtures/test-region.json
```

The browser suite serves the project on port 4001, loads the fixture and checks that the map genuinely renders — by sampling pixels, not by trusting MapLibre's `load` event. Screenshots land in `tests/screenshots/`. Playwright is a devDependency; `npm test` needs nothing installed.

`test:live` imports a real region from the live OSM services and is deliberately separate from the other two. It found two bugs the fixture never could — one that rendered every map as open sea, and one where Overpass reports failure as HTTP 200. Run it when the import path changes; don't loop it.

## How it is built

Plain JavaScript ES modules with JSDoc types. No TypeScript, no bundler, no framework. The only vendored library is MapLibre GL JS, pinned at v5.24.0 and copied into `vendor/` — [v5 rather than v6](RESEARCH.md) because v6 ships ESM only and would need a bundler.

- **MapLibre** draws the calm static world — land, water, roads, contour lines, heat map — entirely from our own imported GeoJSON, so the map works offline once a region is imported.
- **A Canvas 2D overlay**, synced to MapLibre's `render` event, draws everything that moves or that the player draws. Mini Metro's line patterns are far easier with a path and a stroke than with style rules.
- **A Web Worker** runs the import: Overpass parsing, building processing, elevation decoding and contour tracing.
- **The terrain decides where tunnels and bridges go**, not the player. Drag a tram line off the road, or draw metro or train track, and the grade rule smooths a profile the mode can actually climb, then classifies each 20 m sample as tunnel, bridge or at grade and prices it accordingly. Rail also has to respect the roads: it may cross them at 45° or more (each becomes a priced level crossing) but never run along them, and it bridges or tunnels motorways on its own.
- **IndexedDB** caches imported regions and autosaves. A region is fetched once and never again.

## Data and attribution

Map data © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/). Roads, buildings, water and existing railways come from the [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API); place search from [Nominatim](https://nominatim.org/).

Elevation from [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on the Registry of Open Data on AWS — Terrain Tiles by Mapzen/Tilezen, from SRTM (NASA), 3DEP (USGS), GMTED2010 (USGS), ETOPO1 (NOAA) and other sources.

The game follows the OSMF usage policies for [tiles](https://operations.osmfoundation.org/policies/tiles/) and [Nominatim](https://operations.osmfoundation.org/policies/nominatim/): visible attribution, place search on Enter only (never autocomplete, which the policy forbids), at most one search per second, results cached, and no tile prefetching or bulk download.

**Before hosting this publicly** — on GitHub Pages or anywhere else — note that Overpass asks regularly-running applications to stay under about 100 queries and 10 MB a day. A dense 6 km import transfers about 7 MB and a 15 km one about 34 MB, so a single large import can reach that on its own. One person importing a few regions is well inside casual use (10,000 queries and 1 GB a day); a public deployment where strangers import regions is not, and would need its own Overpass instance.

## Documents

- [HANDOFF.md](HANDOFF.md) — current phase, what works, known gaps, next steps. Read first.
- [RESEARCH_TILES.md](RESEARCH_TILES.md) — Phase R: whether to move buildings and POIs to vector tiles. Answer: no — the payload figure that motivated it was decoded JSON, not transfer. Measured provider terms, schema contents, alignment and costs, with rerunnable probes in `tools/`.
- [HANDOFF_maptileresearch.md](HANDOFF_maptileresearch.md) — the Phase R brief, answered. Kept for its question numbering.
- [RESEARCH.md](RESEARCH.md) — Phase 0: what to borrow from Mini Metro and Cities: Skylines, every cost and speed figure checked against public sources, the endpoint policies, and the four disputed figures (since resolved).
- `Open Transit On Map Info Game — Build Prompt & Design Spec.md` — the design spec.
- [config.js](config.js) — every tunable number in the game. There are no magic numbers anywhere else.
