# HANDOFF.md

Read this first in every session. Update it last.

**Current state:** Phase 0 complete. Phase 1 code complete, **not yet verified in a browser.**
**Last session:** Oct 10, 2026 — Phase 0 (research) and Phase 1 (region and map).
**Next session:** verify Phase 1 in Alex's browser, then Phase 2 (buses and passengers).

---

## What Alex needs to do before Phase 2

Phase 1's acceptance criteria are all things only a real browser with real network can show, and this sandbox has neither. **I could not verify any of the three.** Please run through this list — it is about ten minutes:

```bash
cd "OTOMIG v0.1.0"
npm start                 # python3 -m http.server 8000
# open http://localhost:8000
```

Never open `index.html` as a `file://` URL. Nominatim's usage policy requires requests to identify themselves, and a browser cannot set `User-Agent` — we satisfy it via the `Referer` header, which the browser only sends over `http://`. Modules and the worker also need a real origin.

1. **Click "Use the test region".** This needs no network at all. You should get a calm off-white map: a bay in the south-west, a lake, a river, a street grid, faint contour lines, an existing railway. If this works, rendering and the data contract are sound.
2. **Toggle all three buttons** (Demand, Contours, Real map). The Real map one needs internet and disables itself if the tile server refuses localhost — that is intended behaviour, not a bug.
3. **Import a real region.** Search a place, place the square, pick season and difficulty, Import. Watch the progress bar. **This is the first time the live Overpass and elevation code has ever run** — see the risks below.
4. **Reload the same region.** It must come back instantly from IndexedDB without refetching.
5. **Time a dense 15 km city.** The acceptance criterion is about two minutes or less. I have no idea whether we hit it; if not, the first thing to try is trimming the Overpass building query.

### The one thing most likely to break

Elevation decoding. We fetch Terrarium PNGs and read their pixels, which only works if the S3 bucket sends CORS headers. I could not reach the bucket to check. [data/terrain.js](data/terrain.js) already uses the safer route — `fetch()` → `createImageBitmap()` → `OffscreenCanvas`, which does not taint the canvas the way `<img>` + `drawImage` would — but if you see a `SecurityError` or an opaque network failure during "Fetching elevation", that is this. Tell me and I will add a proxy-free fallback.

Second most likely: Overpass rejecting or timing out on a dense 15 km box. The code retries 429 and 504 with backoff ([data/overpass.js](data/overpass.js)), but a very dense city may need the 3×3 chunking raised to 4×4 (`REGION.OVERPASS_CHUNKS` in [config.js](config.js)).

### The push didn't happen

Committed locally on `main` (one commit, `origin` set to `https://github.com/alexandrosgavrilis/otomig.git`), but **not pushed** — this machine has no GitHub credentials. `~/.gitconfig` has a helper for GitLab only, and the generic `credential.helper = cache` is empty. So:

```bash
# create the repo once (any name — adjust the remote if you pick another)
git push -u origin main
```

If you want me to push in future sessions, the simplest fix is installing `gh` and running `gh auth login`, or adding a GitHub entry to the credential helper the way GitLab already has one.

---

## Four decisions waiting on you

From Phase 0. Full reasoning and sources in [RESEARCH.md](RESEARCH.md) under "Conflicts for Alex to decide". None are applied — [config.js](config.js) holds the spec's values, with each disputed one marked `[C1]`..`[C4]`.

| | What | My suggestion |
| --- | --- | --- |
| **C1** | The spec's Eno citation ("German trams ~$36M/mile") doesn't appear in Eno's database article, which deliberately publishes no per-mode figures. The €15M/km tram cost is still well supported — by German project reporting. | Keep €15M, swap the citation. |
| **C2** | Metro tunnel €120M/km is at the optimistic edge of the spec's own cited $180–270M/km range. | Keep €120M for playability; document it as "efficient European builder". Raising it makes metro loan-only. |
| **C3** | Train tunnel (€80M/km) is cheaper than metro tunnel (€120M/km), which is backwards — heavy rail bores are bigger. As written, the cheapest way through a hill is a train line. | Raise train tunnel to ~€110M/km. Or keep it as a deliberate gameplay choice — your call. |
| **C4** | Loan terms outlast the game. One in-game year ≈ 1 real hour, so the Large loan's 20-year term is 20 real hours and can never be repaid. CS1 uses 1/5/10 years. | 3/6/12 years at 4/6/9%. |

Good news from the same research: **the spec's cruise speeds and capacities are right.** They look wrong against real commercial speeds until you work the dwell through — bus at 25 km/h cruise with a 20 s dwell and 400 m spacing comes out at 18.5 km/h door to door, which is exactly real. All four modes land in the real range, and all four capacities are a consistent ~60% of crush capacity. `tests/run.js` now guards those numbers so a future retune can't silently break the match.

---

## What works

Verified by `npm test` — 113 assertions, all passing, no dependencies:

- **Geometry.** `LocalFrame` (lon/lat ↔ local metres), `squareBbox`, `chunkBbox` tiles a bbox with no gaps or drift, ring area and point-in-ring.
- **Grids.** Terrain height grid with bilinear interpolation (exact on a linear ramp), 200 m demand grid, 10 m building occupancy bitset, 30 m height grid.
- **Overpass parsing.** Road class filtering (service, footway, path correctly excluded), building/water/rail separation, abandoned rail rejected, chunk-overlap de-duplication, shared OSM nodes collapsing into one graph node so routing crosses way boundaries, building classification into residential and the six attraction categories.
- **Terrain.** Terrarium decode formula, slippy tile maths, tile→grid resampling, marching-squares contours at 20/100 m, sea polygons.
- **The fixture.** Every field of the data contract, cross-checked — including regenerating the contours from the stored terrain and confirming they match, which proves the fixture came out of the real pipeline.
- **Base map GeoJSON.** Major/minor road partition, closed water rings, normalised heat map.

Written but **unverifiable here** (no browser, no network to Overpass/S3/Nominatim): live import, the module worker, IndexedDB, MapLibre rendering, the canvas overlay, the new-game screen.

## Layout

```
index.html  style.css  config.js  main.js      package.json (no deps; vendored pin)
data/    overpass.js  terrain.js  import.worker.js  cache.js
model/   region.js (contract, frame, grids)  population.js
render/  basemap.js (MapLibre style)  overlay.js (Canvas 2D)
ui/      new-game.js  strings.js
vendor/  maplibre-gl.js  maplibre-gl.css  LICENSE.txt     (v5.24.0, UMD)
fixtures/ make-fixture.js  test-region.json              (npm run fixture)
tests/   run.js                                          (npm test)
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
