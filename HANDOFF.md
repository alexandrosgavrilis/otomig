# HANDOFF.md

Read this first in every session. Update it last.

**Current state:** Phases 0, 1 and 2 complete, verified in a real browser except the live network path.
**Last session:** Oct 10, 2026 — Phase 0 (research), Phase 1 (region and map), Phase 2 (buses and passengers).
**Next session:** confirm a live import works, then Phase 3 (trams).

## Testing

```bash
npm test            # 240 logic assertions, plain Node, no dependencies
npm run test:browser    # 68 assertions driving real Chromium via Playwright
npm run test:browser -- --headed    # ...and watch it
```

The browser suite serves the project on **port 4001**, loads the fixture, and checks that MapLibre really renders (by sampling pixels from a screenshot, not just trusting the `load` event), that the toggles work, that pan/zoom and `maxBounds` behave, that IndexedDB round-trips, and that the module worker resolves its import graph. Screenshots land in `tests/screenshots/` — look at them, they catch things assertions don't.

Playwright is a devDependency. `npm test` stays dependency-free.

### Bugs the browser suite caught

Three in Phase 1, one in Phase 2 — all of which would have met you as a broken screen.

**Phase 2: the entire game layer rendered into a 300×150 box in the corner.** A `<canvas>` is a replaced element, so `position: absolute; inset: 0` does *not* stretch it — `width: auto` resolves to the intrinsic 300×150. The map, HUD, toolbar and panels all looked perfect; lines, stops and vehicles were simply invisible. Fixed with explicit `width/height: 100%` in [style.css](style.css). The suite now checks the overlay's CSS box against the viewport, and samples the overlay for the line's own colour — asserting the model has a line is not the same as asserting the player can see one.

### Phase 1 bugs

Both would have met you as a blank or wrong map:

1. **The MapLibre style was invalid**, so `load` never fired and the map stayed empty. `line-cap` is a *layout* property, not paint; and a `zoom` expression may only be the direct input of a top-level `interpolate`, so wrapping one in a `['*', ...]` is rejected. Fixed in [render/basemap.js](render/basemap.js).
2. **Land at exactly 0 m was painted as sea.** Marching squares treats a corner equal to the trace level as being on the low side, so a flat zero-height area read as water — in the fixture, a whole valley floor appeared as a blue tower. [data/terrain.js](data/terrain.js) now traces half a metre *below* sea level, so "exactly sea level" counts as land. This was never a fixture-only quirk: reclaimed coast and polder are plateaux of exact zeros in real elevation data.

A third, found by the worker test: **`fetch` has no timeout**, so a silently dropped connection would hang an import forever behind a frozen progress bar. Overpass and terrain requests are now aborted and retried ([`fetchWithTimeout`](data/overpass.js)).

## What still needs your machine

Everything above was verified against the fixture, which needs no network. **The live import path has still never run** — this sandbox cannot reach Overpass, Nominatim or the elevation bucket. Please do this once:

```bash
npm start      # then open http://localhost:8000
```

Never open `index.html` as a `file://` URL. Nominatim's policy requires requests to identify themselves; a browser cannot set `User-Agent`, so we rely on `Referer`, which is only sent over `http://`.

1. **Import a real region** — search a place, place the square, Import.
2. **Reload it.** It must come back instantly from IndexedDB without refetching.
3. **Time a dense 15 km city.** The acceptance criterion is about two minutes or less. If it's slower, trim the Overpass building query first.

**Most likely to break: elevation decoding.** We read pixels out of Terrarium PNGs, which needs the S3 bucket to send CORS headers, and I could not reach it to check. [data/terrain.js](data/terrain.js) already uses the safer `fetch()` → `createImageBitmap()` route rather than `<img>` + `drawImage`, which would taint the canvas — but if "Fetching elevation" fails, that is this. **Second: Overpass** rejecting a dense 15 km box; try raising `REGION.OVERPASS_CHUNKS` from 3 to 4.

### The push didn't happen

Committed locally on `main` (one commit, `origin` set to `https://github.com/alexandrosgavrilis/otomig.git`), but **not pushed** — this machine has no GitHub credentials. `~/.gitconfig` has a helper for GitLab only, and the generic `credential.helper = cache` is empty. So:

```bash
# create the repo once (any name — adjust the remote if you pick another)
git push -u origin main
```

If you want me to push in future sessions, the simplest fix is installing `gh` and running `gh auth login`, or adding a GitHub entry to the credential helper the way GitLab already has one.

---

## Phase 0 decisions — all four resolved (Oct 10, 2026)

Applied in [config.js](config.js); reasoning and sources in [RESEARCH.md](RESEARCH.md).

| | Decision |
| --- | --- |
| **C1** | Tram on-street stays **€15M/km**; the Eno citation is replaced with German project reporting, which is what actually supports the number. |
| **C2 + C3** | **Metro and train tunnel costs swapped: metro €80M/km, train €120M/km.** Fixes both complaints at once — heavy-rail bores genuinely cost more than metro bores, and €80M/km keeps metro reachable instead of loan-only. Knowingly below the efficient-European band, for playability. |
| **C4** | Loans are now **3/6/12 years at 4/6/9%**, down from 5/10/20 at 3/5/8. |

Good news from the same research: **the spec's cruise speeds and capacities are right.** They look wrong against real commercial speeds until you work the dwell through — bus at 25 km/h cruise with a 20 s dwell and 400 m spacing comes out at 18.5 km/h door to door, which is exactly real. All four modes land in the real range, and all four capacities are a consistent ~60% of crush capacity. `tests/run.js` now guards those numbers so a future retune can't silently break the match.

---

## What works

Verified by `npm test` (113 logic assertions) and `npm run test:browser` (36 in real Chromium):

- **Geometry.** `LocalFrame` (lon/lat ↔ local metres), `squareBbox`, `chunkBbox` tiles a bbox with no gaps or drift, ring area and point-in-ring.
- **Grids.** Terrain height grid with bilinear interpolation (exact on a linear ramp), 200 m demand grid, 10 m building occupancy bitset, 30 m height grid.
- **Overpass parsing.** Road class filtering (service, footway, path correctly excluded), building/water/rail separation, abandoned rail rejected, chunk-overlap de-duplication, shared OSM nodes collapsing into one graph node so routing crosses way boundaries, building classification into residential and the six attraction categories.
- **Terrain.** Terrarium decode formula, slippy tile maths, tile→grid resampling, marching-squares contours at 20/100 m, sea polygons.
- **The fixture.** Every field of the data contract, cross-checked — including regenerating the contours from the stored terrain and confirming they match, which proves the fixture came out of the real pipeline.
- **Base map GeoJSON.** Major/minor road partition, closed water rings, normalised heat map.

- **In the browser.** The new-game screen mounts with all four seasons and difficulties; typing in the search box fires no Nominatim request (the policy forbids autocomplete); the fixture loads; MapLibre renders real pixels in the right colours; contour and heat-map toggles work; zoom reveals minor roads; `maxBounds` keeps the player inside the region; IndexedDB round-trips a region; the module worker boots and reports progress; no console or page errors.

Still **unverified** — needs network this sandbox doesn't have: live Overpass import, Nominatim search results, Terrarium elevation decoding.

## Layout

```
index.html  style.css  config.js  main.js      package.json (no deps; vendored pin)
data/    overpass.js  terrain.js  import.worker.js  cache.js
model/   region.js (contract, frame, grids)  population.js
render/  basemap.js (MapLibre style)  overlay.js (Canvas 2D)
ui/      new-game.js  strings.js
vendor/  maplibre-gl.js  maplibre-gl.css  LICENSE.txt     (v5.24.0, UMD)
fixtures/ make-fixture.js  test-region.json              (npm run fixture)
tests/   run.js (npm test)  browser.js (npm run test:browser)  screenshots/
```

Not yet created, and deliberately so: `build/`, `sim/`, `ui/hud.js`, `ui/toolbar.js`, `ui/panels.js`, `model/network.js`, `model/save.js`, `render/shapes.js`. They arrive with the phase that needs them.

## Decisions I made where the spec was silent

1. **MapLibre v5.24.0, not v6.** v6 ships ESM only — a bare `.mjs` plus a separate shared chunk and worker module, no UMD — which would need a bundler and break the no-build-step rule. v5 is one `<script>` tag. [RESEARCH.md §5](RESEARCH.md).
2. **Everything works in local metres.** `LocalFrame` converts lon/lat to metres from the region's SW corner once, at the edges. A 15 km region is flat enough that this is exact to centimetres, and it keeps the grade rule, the grids and collision checks in plain metres with no projection maths scattered about. Phase 4 depends heavily on this.
3. **Sea polygons by padding the height grid.** The spec avoided coastline polygons because closing them against the region edge is fiddly. Padding the grid with a one-cell border of high land before marching squares makes every sea area close on itself, so there is nothing to stitch. Costs one cell of inset, invisible at play zoom.
4. **Terrain at zoom 12.** Arithmetic, not taste: z12 is 30 m/px at 38°N and 24 m at 52°N, which is the spec's "about 30 m cells", and z13 is false precision against ~30 m SRTM source data.
5. **The fixture is built by the real pipeline.** `make-fixture.js` synthesises OSM elements in Overpass's own JSON shape and runs them through `parseResponses` → `buildGraph` → `processBuildings` → `buildContours`. The shape therefore cannot drift from real imported data, and the tests exercise the real parser. Only the height grid is analytic, because tiles have no offline substitute.
6. **Terrain tiles decode via `fetch` + `createImageBitmap`**, not `<img>` + `drawImage`, because the latter taints the canvas on a cross-origin image and `getImageData` then throws.
7. **Region cache keys round the centre to 4 decimals** (~10 m), so nudging the square by a pixel reuses the import instead of refetching it.
8. **`meta.populationTotal` holds our computed residents**, not the OSM tag. The tag, when present, is used to scale the floor-area estimate and is then discarded.
9. **Buildings land in one demand cell**, by centroid, rather than being split across cells by area. Cells are 200 m and buildings are metres; splitting would be more correct and invisible.
10. **`POINT_ATTRACTION = 50`** for a standalone shop or amenity node. The spec says "a small fixed amount each" without naming it. Pure guess — retune in Phase 2.
11. **MapLibre's keyboard handling is disabled**, so 1–4, Space and Esc are free for the game as the spec's keyboard section requires.
12. **The heat map shows total demand in Phase 1.** With no stops, nothing is served, so total demand *is* unserved demand. Phase 2 swaps the numbers via `setHeatMapData`; the geometry never changes.

## Known gaps and limitations

- **Water from multipolygon relations is not imported.** We query and parse `way["natural"="water"]` only. Big lakes and most coastal water in OSM are relations, so a region with one will be missing it. The sea mask comes from elevation and is unaffected. Worth fixing early in Phase 2 if a region you care about looks wrong.
- **A land island inside a sea area is painted as sea.** The sea tracer returns the island as its own ring rather than a hole. Rare at 15 km; the fix is ring-containment tests, not worth the code until a region needs it.
- **The fixture is sparse** — 9,258 residents over 6×6 km, 720 buildings. Fine for testing logic, not representative of a real city's density. Don't tune demand constants against it; tune them against a real import.
- **No save/load yet.** `data/cache.js` has the save-slot stores ready and unused. Phase 2.
- **Nominatim's `population` extratag is often absent**, so most regions will fall back to our floor-area estimate. The new-game screen has no "type the population" field yet, which the spec allows for — add it in Phase 2 if the estimates look off.
- **One-way roads are ignored**, per the spec's v1 decision.

## Next: Phase 2 — buses and passengers

The core loop. Bus lines and stops, vehicles, demand grid and heat map, passenger spawning, routing with transfers, patience and satisfaction, tickets and running costs, HUD, speed controls, save and load.

Accept when: two bus lines sharing an interchange carry passengers who transfer and arrive; neglected stops lose passengers and ridership dips; money moves; a reload restores the game exactly.

Suggested order, since this phase is the largest:

1. `sim/clock.js` — the two clocks. `CLOCK.DAILY_SCALE` is already correct and tested at 324.
2. `model/network.js` — stops, lines, the interchange rule (150 m).
3. `build/road-routing.js` — Dijkstra on the road graph between consecutive stops. The graph already collapses shared nodes, so this should be straightforward.
4. `sim/demand.js` — catchments, the pair table, spawning. Recompute only on network or month change, store sparsely.
5. `sim/routing.js` — the (stop, line) platform graph and passenger Dijkstra.
6. `sim/vehicles.js`, `sim/passengers.js` — movement, boarding, patience. Don't forget `PATIENCE.GRACE_SIM_S`: it is Mini Metro's 2-second grace, and it is the single rule that makes waiting feel fair rather than punishing.
7. `sim/economy.js` — tickets, advertising, running costs.
8. `ui/hud.js`, `ui/toolbar.js`, `ui/panels.js`, `render/shapes.js`.
9. `model/save.js` — IndexedDB slots plus JSON export/import.

The canvas overlay is already wired to MapLibre's `render` event with device-pixel scaling handled, and draws through `Overlay.painters` — Phase 2 pushes painters onto that array rather than touching the sync logic. `main.js` currently builds the Phase 1 toolbar (three toggles) inline; move it to `ui/toolbar.js` when the mode and tool buttons arrive.
