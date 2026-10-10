# OTOMIG — Open Transit On Map Info Game

A transit sandbox with Mini Metro's look and drawing feel and Cities: Skylines' public-transport management, set on a real 15×15 km piece of the world from OpenStreetMap.

You draw bus, tram, metro and train lines. Passengers appear where people live and want to go. Money comes from tickets, coverage subsidies and advertising. There is no win condition — a good network settles into balance. Some places can only ever support a bus line or two, and that is fine.

**Status:** Phase 1 of 7 (region and map). See [HANDOFF.md](HANDOFF.md).

## Running it

No build step and no dependencies to install.

```bash
npm start          # python3 -m http.server 8000
# then open http://localhost:8000
```

Click **Use the test region** for a synthetic region that needs no network at all, or search a real place and import it.

Serve it over `http://` — don't open `index.html` as a `file://` URL. ES modules, the import worker and the OSM services all need a real origin.

```bash
npm test           # 113 assertions, plain Node, no framework
npm run fixture    # regenerate fixtures/test-region.json
```

## How it is built

Plain JavaScript ES modules with JSDoc types. No TypeScript, no bundler, no framework. The only vendored library is MapLibre GL JS, pinned at v5.24.0 and copied into `vendor/` — [v5 rather than v6](RESEARCH.md) because v6 ships ESM only and would need a bundler.

- **MapLibre** draws the calm static world — land, water, roads, contour lines, heat map — entirely from our own imported GeoJSON, so the map works offline once a region is imported.
- **A Canvas 2D overlay**, synced to MapLibre's `render` event, draws everything that moves or that the player draws. Mini Metro's line patterns are far easier with a path and a stroke than with style rules.
- **A Web Worker** runs the import: Overpass parsing, building processing, elevation decoding and contour tracing.
- **IndexedDB** caches imported regions and autosaves. A region is fetched once and never again.

## Data and attribution

Map data © OpenStreetMap contributors, [ODbL](https://opendatacommons.org/licenses/odbl/). Roads, buildings, water and existing railways come from the [Overpass API](https://wiki.openstreetmap.org/wiki/Overpass_API); place search from [Nominatim](https://nominatim.org/).

Elevation from [Terrain Tiles](https://registry.opendata.aws/terrain-tiles/) on the Registry of Open Data on AWS — Terrain Tiles by Mapzen/Tilezen, from SRTM (NASA), 3DEP (USGS), GMTED2010 (USGS), ETOPO1 (NOAA) and other sources.

The game follows the OSMF usage policies for [tiles](https://operations.osmfoundation.org/policies/tiles/) and [Nominatim](https://operations.osmfoundation.org/policies/nominatim/): visible attribution, place search on Enter only (never autocomplete, which the policy forbids), at most one search per second, results cached, and no tile prefetching or bulk download.

**Before hosting this publicly** — on GitHub Pages or anywhere else — note that Overpass asks regularly-running applications to stay under about 100 queries and 10 MB a day, and a single dense 15 km import can approach that on its own. One person importing a few regions is well inside casual use; a public deployment where strangers import regions is not, and would need its own Overpass instance.

## Documents

- [HANDOFF.md](HANDOFF.md) — current phase, what works, known gaps, next steps. Read first.
- [RESEARCH.md](RESEARCH.md) — Phase 0: what to borrow from Mini Metro and Cities: Skylines, every cost and speed figure checked against public sources, the endpoint policies, and four figures that need a decision.
- `Open Transit On Map Info Game — Build Prompt & Design Spec.md` — the design spec.
- [config.js](config.js) — every tunable number in the game. There are no magic numbers anywhere else.
