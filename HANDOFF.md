# HANDOFF.md

Read this first in every session. Update it last.

**State:** Phases 0, 1 and 2 complete. Verified in a real browser against the fixture; the live import has never been run end to end.
**Last session:** Oct 10, 2026 — Phase 0 (research), Phase 1 (region and map), Phase 2 (buses and passengers).

**Phase R is done, and it cancelled Phase D.** See [RESEARCH_TILES.md](RESEARCH_TILES.md).

The payload crisis that reordered the roadmap was a measurement error. `1.87 MB/km²` is Overpass's **decoded JSON**; it gzips 7.3–7.8× and browsers always ask for gzip, so a 6 km dense import is **6.8 MB on the wire, not 66**. And the 504s were never about chunk area — they were the `>;` recursion over building geometry nodes. Drop buildings and a whole **15 km** box of roads, rail, water and every POI node serves in **one request, 4.71 MB, 13.5 s**.

| | |
| --- | --- |
| **Next** | **Phase Q — restructure the Overpass query.** Two requests replace nine to thirty-six. One file, no new dependency, model bit-identical. Scope in [RESEARCH_TILES.md](RESEARCH_TILES.md) §8. |
| Then | Phase 3 — trams. **No longer blocked.** |
| Shelved | Vector tiles for building geometry. Viable and fully costed (§8), purely additive, worth it only if dense 15 km imports become the priority. |

The reason Phase R was ordered before Phase 3 was that a data-layer rewrite would change the occupancy raster's provenance. It no longer does, so trams can follow Phase Q immediately — or precede it.

---

## 1. Two things only Alex can do

### Push — nine commits are waiting

Committed on `main`, `origin` set to `https://github.com/alexandrosgavrilis/otomig.git`, **not pushed**. GitHub removed password auth for git over HTTPS in 2021, and signing in with Google never creates a git password, so the credential prompt is unanswerable as-is.

`gh` 2.102.0 is installed at `~/.local/bin/gh` (already on PATH via `.profile`):

```bash
gh auth login          # GitHub.com → HTTPS → Yes → Login with a web browser
gh repo create otomig --private
git push -u origin main
```

That also configures the git credential helper permanently, so later sessions can push without asking.

### Run one live import

Everything is verified against the fixture, which needs no network. The assembly — worker → Overpass → elevation → IndexedDB → playable map — has never run as a whole.

```bash
npm start      # then open http://localhost:8000
```

**Never open `index.html` as a `file://` URL.** `User-Agent` is a forbidden header name, so a browser silently ignores any attempt to set it; we identify to the OSM services via `Referer`, which is only sent over `http://`.

The default region is now 6 km, so the first import should take a few minutes rather than twenty. Then reload the same region and confirm it comes back instantly from IndexedDB.

---

## 2. Testing

```bash
npm test                            # 270 logic assertions, plain Node, no dependencies
npm run test:browser                # 75 assertions in real Chromium via Playwright
npm run test:browser -- --headed    # ...and watch it
npm run fixture                     # regenerate fixtures/test-region.json
```

The browser suite serves on **port 4001**, loads the fixture, and checks that MapLibre genuinely renders by sampling pixels rather than trusting the `load` event. Screenshots land in `tests/screenshots/` — **look at them.** They have caught things no assertion did.

Playwright is a devDependency. `npm test` stays dependency-free.

Phase 2's acceptance criteria live in `tests/phase2.js` marked `ACCEPTANCE:`, so they stay checked rather than being verified once by hand.

### Four bugs the browser suite caught

All four would have met Alex as a broken screen:

1. **The whole game layer rendered into a 300×150 box in the corner.** A `<canvas>` is a replaced element, so `position: absolute; inset: 0` does *not* stretch it — `width: auto` resolves to the intrinsic 300×150. Map, HUD, toolbar and panels all looked perfect; lines, stops and vehicles were invisible. Every assertion passed, because they asserted the *model* had a line, not that it could be seen. The suite now checks the overlay's CSS box against the viewport and samples it for the line's own colour.
2. **The MapLibre style was invalid**, so `load` never fired and the map stayed blank. `line-cap` is a *layout* property, not paint; and a `zoom` expression may only be the direct input of a top-level `interpolate`, so wrapping one in `['*', …]` is rejected.
3. **Land at exactly 0 m was painted as sea.** Marching squares puts a corner equal to the trace level on the low side, so flat zero-height ground read as water — a whole valley floor appeared as a blue tower. Now traced half a metre *below* sea level. Not a fixture quirk: reclaimed coast and polder are plateaux of exact zeros in real elevation data.
4. **`fetch` has no timeout**, so a dropped connection would hang an import forever behind a frozen progress bar. Overpass and terrain requests now abort and retry.

---

## 3. Decisions on the record

### Phase 0 conflicts — all resolved by Alex, Oct 10 2026

Applied in [config.js](config.js); reasoning and sources in [RESEARCH.md](RESEARCH.md).

| | Decision |
| --- | --- |
| **C1** | Tram on-street stays **€15M/km**; the Eno citation is replaced with German project reporting, which is what actually supports the number. |
| **C2 + C3** | **Metro and train tunnel costs swapped: metro €80M/km, train €120M/km.** Fixes both complaints at once — heavy-rail bores genuinely cost more than metro bores, and €80M/km keeps metro reachable instead of loan-only. Knowingly below the efficient-European band, for playability. |
| **C4** | Loans are **3/6/12 years at 4/6/9%**, down from 5/10/20 at 3/5/8. |

Good news from the same research, and worth not relitigating: **the spec's cruise speeds and capacities are right.** They look wrong against real commercial speeds until the dwell is worked through — bus at 25 km/h cruise with a 20 s dwell and 400 m spacing is 18.5 km/h door to door, which is exactly real. `tests/run.js` guards those relationships so a retune can't silently break them.

### One spec amendment, applied — flag if you disagree

**One dot no longer always means ten passengers.** It scales with the region: `passengersPerDot(residents)` in [config.js](config.js) — 1 up to ~150,000 residents, 10 at a million, capped at 50.

The reason is arithmetic, not taste. Visible dots ≈ `(trips/day × journey length ÷ 18 h) ÷ dot size`, so at a fixed 10 a town of 40,000 showed about one dot at a time and a village showed none. That was never a bug: a village really does have about four people on its buses at any moment, and four people is less than half a dot.

The scale is fixed at import and never changes mid-game — a dot that silently changed meaning would make every count on screen a lie. Every dot↔people conversion now reads one value; there were four hardcoded `× 10`s, one of them inside ticket income, which would have silently desynced the money.

### Where the spec was silent

1. **MapLibre v5.24.0, not v6.** v6 ships ESM only — a bare `.mjs` plus separate shared and worker modules, no UMD — which needs a bundler and breaks the no-build-step rule.
2. **Everything works in local metres.** `LocalFrame` converts lon/lat to metres from the region's SW corner once, at the edges. A 15 km region is flat enough that this is exact to centimetres, and it keeps the grade rule, grids and collision checks in plain metres. **Phase 4 depends heavily on this.**
3. **Sea polygons by padding the height grid** with a one-cell border of high land before marching squares, so every sea area closes on itself and there is no open coastline to stitch against the region edge.
4. **Terrain at zoom 12** — 30 m/px at 38°N, 24 m at 52°N. z13 is false precision against ~30 m SRTM source data.
5. **The fixture is built by the real pipeline.** `make-fixture.js` synthesises OSM elements in Overpass's own JSON shape and runs them through `parseResponses` → `buildGraph` → `processBuildings` → `buildContours`, so its shape cannot drift from real imported data. Only the height grid is analytic.
6. **Terrain tiles decode via `fetch` + `createImageBitmap`**, not `<img>` + `drawImage`, which would taint the canvas.
7. **Region cache keys round the centre to 4 decimals** (~10 m), so nudging the square by a pixel reuses the import.
8. **`meta.populationTotal` holds our computed residents**, not the OSM tag. The tag, when present, scales the floor-area estimate and is then discarded.
9. **Buildings land in one demand cell by centroid**, not split across cells by area. Cells are 200 m and buildings are metres.
10. **`POINT_ATTRACTION = 50`** for a standalone POI node. The spec says "a small fixed amount" without naming it. Pure guess — retune when real data is in.
11. **MapLibre's keyboard handling is disabled**, so 1–4, Space and Esc belong to the game.
12. **Passengers are not saved.** Transient, would multiply save size, and a reloaded network refills within seconds. Structure, money and satisfaction history survive. A save is under 20 kB and a test enforces it.
13. **Line segments are re-routed on load, not stored** — derived from stops plus the road graph, so storing them would be larger and a chance to go stale.
14. **The transfer penalty sits on the walking edge, not on boarding**, so a passenger's first boarding is never penalised — only an actual change of vehicle.
15. **A finished line is given one vehicle automatically** if affordable. A line with no vehicles carries nobody, and a player who draws one and sees nothing happen has no way to tell what is wrong.
16. **Lifetime counters** (`game.totals`) alongside instantaneous state. On a sparse network the instant you look is usually between passengers.
17. **Vehicles are spaced evenly in time, not distance.** Hops differ in length, so distance spacing still bunches vehicles where stops are close.
18. **Buildings are drawn, and their outlines are kept.** The spec says neither — it discards footprints after rasterising and says buildings are not drawn. Reversed on Alex's instruction: seeing the city you are serving is the point of a real map, and from Phase 4 the "no track through buildings" rule must agree with what is on screen. Road colours were also darkened from the spec's `#DCD6CC`, which against `#F4F1EA` land is a few percent of luminance — drawn, but invisible.
19. **Only Bus is enabled**; Tram, Metro and Train buttons are present but disabled. A dead button that says "Tram" tells the player the plan; a missing one tells them nothing.

---

## 4. Live endpoints — all four tested directly

An earlier note in this file claimed the sandbox could not reach Overpass, Nominatim, the elevation bucket or the OSM tile server. **That was wrong** — the spec said so and it was repeated without checking. All four are reachable, and have now been exercised.

**Elevation: resolved, no action needed.** `Access-Control-Allow-Origin: *` is present on GET (absent on HEAD, which is what made it look missing at first), so there is no tainted-canvas problem. The decode formula is confirmed against live tiles: London −5…30 m, Athens −3…263 m, Mont Blanc 1,719…**4,790 m** against a true summit of 4,806. `tileXY` is correct.

**Nominatim: fine.** Returns results with `extratags` as expected.

**Overpass, problem 1 — it 406s a request with no `User-Agent`.** Browsers always send one, so the game is unaffected. Any Node-side test of the live API must set it. The game cannot set it: `User-Agent` is a forbidden header name and `fetch` silently ignores the attempt. We identify via `Referer`.

**Overpass, problem 2 — it fails on chunk AREA.** Measured over central Athens:

| Box | Result |
| --- | --- |
| 1 km | 200, 1.9 MB, 6.5 s |
| 2 km | 200, 7.5 MB, 18.4 s |
| 3 km | 504 |
| 5 km | **504, every time** |

Two fixes. `fetchChunkAdaptive` splits a refused chunk into four and recurses (`OVERPASS_MAX_SUBDIVIDE`, 3 levels, down to 625 m); sparse regions never subdivide and pay nothing. And the chunk grid now derives from a target tile *size* (`OVERPASS_CHUNK_TARGET_KM`, 2.5 km) rather than a fixed 3×3 count — previously a 15 km region began with 5 km chunks, all nine guaranteed to fail, each burning a 2+4+8+16 s retry cycle before subdividing, about four wasted minutes before any real work.

| Region | Grid | Requests | Chunk |
| --- | --- | --- | --- |
| 5 km | 2×2 | 4 | 2.50 km |
| **6 km (default)** | **3×3** | **9** | **2.00 km** |
| 10 km | 4×4 | 16 | 2.50 km |
| 15 km | 6×6 | 36 | 2.50 km |

36 requests for the largest region is inside Overpass's ~100/day guidance for a regular user.

**Most 504s are transient and the retry absorbs them.** Running the real `fetchChunkAdaptive` against the centre chunk of a 6 km Athens import: it 504'd, retried, recovered in 4 seconds with no subdivision — 1,249 roads, 7,878 buildings, 4,336 POIs. The same 2 km box had succeeded outright earlier the same day. Overpass has bad minutes; `kumi.systems` was 500ing even on `/api/status`.

### Import cost — corrected by Phase R, Oct 10 2026

**The figures below were wrong, and the error drove a roadmap change.** `1.87 MB/km²` is the size of the **decoded JSON**. Overpass serves it gzipped at 7.3–7.8×, and a browser always sends `Accept-Encoding: gzip`. Neither `curl` without `--compressed` nor Node's `fetch` reports the wire size — the latter decompresses transparently even when told not to — so nobody saw it.

| Region | estimate below | **measured on the wire** |
| --- | --- | --- |
| 6 km (default) | ~66 MB | **6.8 MB** |
| 15 km | ~420 MB | **34.4 MB** |

What *is* slow is Overpass's own query time, and only because of buildings: a 6 km import measured 4 m 48 s across 9 chunks with transient 504s and 429s. [RESEARCH_TILES.md](RESEARCH_TILES.md) §8 cuts that to two requests. The original text follows for the record.

At the measured **1.87 MB/km²** for central Athens, payload is the open problem:

| Region | Dense city estimate |
| --- | --- |
| 6 km (default) | ~66 MB, a few minutes |
| 15 km | ~420 MB, 10–20 minutes |

Payload scales with feature *density*, not area — a rural 15 km box may be a few MB, so the slider reaching 15 is genuinely useful outside cities.

### Building polygons: measured, split tried, then reverted

Building polygons are the single biggest component. Measured over the same 1 km box:

| | |
| --- | --- |
| buildings, full polygons | 1.228 MB (11,063 elements) |
| buildings, centroids only | 0.339 MB (1,835 elements) |
| **difference** | **0.889 MB = 47% of the whole import** |

1,835 buildings drag 9,228 geometry nodes behind them; that is the mass. Overpass can return tags plus a centre point without the corner nodes (`out tags center`), and it can do so in the *same* request via named sets, so the saving costs no extra round trips. It was implemented and then **reverted** — see git history if it is ever wanted back.

**Why reverted: buildings are now drawn.** The spec says "Buildings are not drawn" and "the polygons themselves are discarded after import", but Alex's intent was always to see the city he is serving — that is the point of putting the game on a real map. Beyond the drawing, Phase 4's rule that track may not cross a building uses the occupancy raster. While buildings were invisible, approximating one as a square of assumed area was defensible. Once the outline is on screen, a tram blocked by a building it does not visibly touch is a bug the player can point at. **The collision check has to agree with what is visible**, so the real footprints are needed either way.

`processBuildings` now returns `outlines` alongside the grids, rounded to 6 decimals (~10 cm, far finer than anything drawn, roughly half the bytes). They live on the region as `region.buildings` and are drawn by the `buildings` fill layer, under the roads, with the outline fading in past zoom 14. There is a toolbar toggle.

So the payload stays as it was. The default dropping to 6 km is the mitigation, and the remaining lever — a vector-tile hybrid — is now doubly rejected: tile schemas carry no building category (gutting attraction, which is floor area × category weight) *and* their geometry is clipped and simplified per tile, which would make the visible outline disagree with the collision check in a different way.

### The POI trim was worth 2.9%, not the 15–18% estimated

Measured A/B on the same 1 km box: 1,558 shop/amenity nodes become 1,334. Only 224 dropped — benches (34), waste baskets (43), recycling (22), telephones, ATMs, postboxes, parking entrances. The earlier 18% figure was the share of *all* POI nodes, and the list keeps 86% of them.

**Kept anyway, because it is a correctness fix.** Every POI node contributes `POINT_ATTRACTION`, so a park bench was generating as much trip attraction as a bakery, and about 14% of point attraction in that sample was street furniture. Worse in suburbs, where benches and parking outnumber shops.

---

## 5. The proposed data architecture (Phase D) — SUPERSEDED

**Not built, and now not recommended.** Phase R measured it and the answer is in [RESEARCH_TILES.md](RESEARCH_TILES.md). Four of this section's load-bearing claims did not survive:

| claimed below | measured |
| --- | --- |
| 6 km dense costs ~66 MB | **6.8 MB on the wire** — the saving the hybrid existed to deliver is already there |
| fetch at z15–z16 for near-raw detail | **maxzoom is 14** at every free planet provider. z14 is still 0.47 m precision, so this costs nothing |
| `poi` carries the weights, so attraction *inverts* rather than degrades | POI `subclass` is indeed raw — but the **building category drives 39% of attraction**, and dropping it measured heat-map correlation 0.601 with 0 of the top 5 cells shared |
| roads are 9% of payload, so keeping them on Overpass is nearly free | True, and better: **everything except buildings** is one 13.5 s request for a whole 15 km box |

The section is kept because its reasoning about topology and shared node ids is still correct and still the reason roads must never come from tiles. Everything below this line is the original text.

### Where the payload actually goes

Measured over a 1 km box of central Athens, 1.88 MB total:

| | share |
| --- | --- |
| Buildings — ways plus their exclusive geometry nodes | **49%** |
| Shop/amenity POI nodes | 18% |
| **Roads — ways plus their junction nodes** | **~9%** |
| Water, rail, everything else | <1% |

Only ~1,260 of 10,488 geometry nodes belong to roads. **The part we most need Overpass's fidelity for is the small part.**

### The hybrid

**Roads, rail and water stay on Overpass. Buildings and POIs move to vector tiles.**

This was arrived at by elimination. A pure vector-tile import looked attractive — a 6 km region is ~4.4 MB of z15 tiles against ~66 MB of Overpass — but MVT carries geometry without topology: ways are clipped at tile edges and there are no shared nodes. Our whole routing layer depends on shared OSM node ids, which is what lets Dijkstra cross way boundaries for free. Reconstructing junctions from proximity means deciding whether two lines a metre apart are a crossroads or a **flyover**, and the failure mode is intermittent and horrible.

Keeping roads on Overpass removes that risk entirely, and costs almost nothing because roads are 9% of the payload. It also keeps real `highway=*` classes and `tunnel`/`bridge` tags, which the tram rules and Phase 4's grade rule both need.

| | Today | Hybrid (estimated) |
| --- | --- | --- |
| 6 km dense | ~66 MB | **~19 MB** (6 Overpass + 13 tiles at z16) |
| 15 km dense | ~420 MB | ~115 MB |
| Topology risk | none | **none** |
| Building outlines | yes | yes |
| Attraction source | building categories | POI categories + building volume |

### Two insights that made it work

**Zoom defeats the generalisation objection.** Vector tiles are simplified and POI-thinned, but that is a *low-zoom* behaviour. At z15 the quantisation grid is 0.24 m — finer than our 20 m grade sampling and 10 m occupancy cells — and at z16 the POI layer is essentially unthinned. Alex's point: if the player can only build at high zoom, the tiles in front of them already contain everything. Fetching at z15–16 gets near-raw detail.

| zoom | tile span | precision | 6 km | 15 km |
| --- | --- | --- | --- | --- |
| z14 | 1,927 m | 0.47 m | 25 tiles | 81 |
| z15 | 964 m | 0.24 m | 64 tiles | 289 |
| z16 | 482 m | 0.12 m | 196 tiles | 1,089 |

**POI categories survive; building categories do not.** The two are different layers. `building` carries geometry and `render_height` and nothing else, but `poi` carries `class` and `subclass`, where subclass is believed to be the raw OSM tag value. So the attraction model **inverts** rather than degrades: POIs become the destinations carrying the weights, with building volume as a "how much of it" multiplier. Arguably better — a POI is a literal destination, whereas a large untagged building might be a warehouse.

### Rejected: dynamic streaming

Accumulating features as the player pans breaks four things: determinism (a route re-routes when more tiles arrive), **saves** (the save would depend on where you had *looked*, not what you had built), demand (catchments shift underfoot), and the economy. It also gains nothing — 196 tiles in parallel behind the existing progress bar takes seconds. Keep the zoom insight as *which zoom we fetch*; drop the streaming.

A build-zoom restriction then becomes a pure gameplay choice rather than a data constraint, and I would probably not impose it: zooming out to see your whole network is half of Mini Metro's appeal.

### Held in reserve: file import

An escape hatch, not a default. [extract.bbbike.org](https://extract.bbbike.org) is built for exactly this and carries no policy anxiety, but it is asynchronous and makes the player leave the game before playing it. We already have a `Region` JSON contract and a file picker for saves, so a `tools/make-region.js` would be cheap. Worth having for "Overpass is down" or "I want a dense 15 km city". **PMTiles** is the elegant long-term version — one archive, HTTP range requests, no tile server, works from static hosting if this ever lives on GitHub Pages.

### What a rewrite would touch

**Rewritten:** the Overpass query (trimmed to roads/rail/water), a new tiles module, `data/import.worker.js`, `model/population.js` (POI-led attraction), `fixtures/make-fixture.js`, the Phase 1 parsing tests.

**Untouched:** `build/road-routing.js` — because roads still arrive with real node ids. All of `sim/`, `model/network.js`, `render/overlay.js`, `render/shapes.js`, every `ui/` file. The `Region` contract in `model/region.js` survives nearly intact.

**The whole data layer, none of the game.** Roughly one session, low risk — against one and a half and one large unknown for the pure-tile version.

---

## 6. What works

Verified by `npm test` (270) and `npm run test:browser` (75).

**Phase 1.** `LocalFrame` and the bbox/chunk maths; terrain height grid with bilinear interpolation (exact on a ramp); 200 m demand grid; 10 m occupancy bitset; Overpass parsing with road-class filtering, abandoned-rail rejection, chunk-overlap de-duplication and shared-node collapsing; Terrarium decode and tile resampling; marching-squares contours and sea polygons; the base-map GeoJSON. In the browser: the new-game screen, search firing no request while typing, MapLibre rendering real pixels, layer toggles, zoom revealing minor roads, `maxBounds`, IndexedDB round-trips, the module worker booting.

**Phase 2.** The two clocks reconciling to an 18-hour service day; Dijkstra road routing; catchments and the sparse O-D pair table; seasonal multipliers (Tourist swells in August) and fare elasticity at exactly 2^−0.3; the platform graph with transfers costing a wait and a penalty while staying aboard is free; vehicles shuttling and looping, spaced evenly in time; patience, the grace period, satisfaction dropping 0.15 and recovering 0.02/day; tickets, advertising, running costs, maintenance, Hard's twelve-month game over; save/load round-tripping stops, lines, vehicle positions, balance and calendar.

**Acceptance, asserted in code:** two bus lines sharing an interchange carry passengers who transfer and arrive; neglected routes visibly dip; money moves; a reload restores the game exactly.

---

## 7. Layout

```
index.html  style.css  config.js  main.js      package.json (no runtime deps)
data/    overpass.js  terrain.js  import.worker.js  cache.js
model/   region.js (contract, frame, grids)  population.js  network.js  save.js
build/   road-routing.js                     ← track-geometry.js arrives in Phase 3
sim/     clock.js  demand.js  routing.js  vehicles.js  passengers.js
         economy.js  game.js
render/  basemap.js (MapLibre style)  overlay.js (Canvas 2D)  shapes.js
ui/      new-game.js  hud.js  toolbar.js  panels.js  strings.js
vendor/  maplibre-gl.js  maplibre-gl.css  LICENSE.txt      (v5.24.0, UMD)
fixtures/ make-fixture.js  test-region.json               (npm run fixture)
tests/   run.js  phase2.js  browser.js  screenshots/
```

The fixture is a 6×6 km synthetic coast: a bay in the south-west, a lake, a river, a ridge with a notched valley (for Phase 4's tunnels and bridges), a motorway, a pedestrian street, a road tunnel and bridge, an existing railway with three stations, and an abandoned branch the parser must reject. **41,828 residents, ~1,162/km²** — a small town, so `passengersPerDot` is 1. It carries 1,971 building outlines.

---

## 8. Known gaps

- **Dragging to shape a route is not implemented.** The spec's via-points (drag between two stops to force a different road route) are not wired to the mouse, though `RoadIndex.pathThrough` supports them. Belongs with tram off-road dragging in Phase 3 — same gesture.
- **Edit stops is select-only.** Dragging a stop to move it and clicking a segment to insert one are unwired; `Network.insertStop` and `removeStopFromLine` exist and are tested.
- **No cost preview follows the cursor** while building.
- **Water from multipolygon relations is not imported.** Only `way[natural=water]`. Big lakes and most coastal water in OSM are relations, so a region with one will be missing it. The sea mask comes from elevation and is unaffected.
- **A land island inside a sea area is painted as sea** — the tracer returns it as its own ring, not a hole. Rare; fix is ring-containment tests.
- **Save slots are one slot** in the UI. `model/save.js` supports any number.
- **`revalidateDots` releases passengers aboard a deleted line** at the next stop rather than somewhere sensible.
- **Nominatim's `population` extratag is often absent**, and the new-game screen has no "type the population" field, which the spec allows for.
- **One-way roads are ignored**, per the spec's v1 decision.
- **Import payload is not a problem** (§4, corrected). What remains is **region size in storage**: a dense 15 km region holds ~300,000 building outlines and ~76 MB of JSON in IndexedDB, identically whatever the source. Created by the decision to keep and draw footprints, which is still the right decision. It is an encoding problem — delta-encoded typed arrays instead of nested JSON arrays — and deserves its own task. See [RESEARCH_TILES.md](RESEARCH_TILES.md) §5.5.
- **Overpass timing is unpredictable.** The same 2 km box measured 18.4 s, then 2.3 s, then 2.7 s on one afternoon. Region figures are single runs; read them as "minutes, variable".
- **Building multipolygon relations are not imported.** `parseResponses` handles `way["building"]` only, so a mall or a courtyard block tagged as a relation is missing — the same gap as water. Measured at 166 relations against 30,686 ways over a 4 km box of Athens, but they are large buildings.

---

## 9. Phase 3 — trams (no longer blocked)

Phase R settled the data architecture without a rewrite, so the occupancy raster's provenance does not change and this no longer waits on anything.

One finding from Phase R lands squarely here, and it is worth knowing before the grade rule is written: **about a quarter of buildings in a dense city come within 3 m of a road centreline in OSM itself** — 23.7% measured, against a 26.9% same-source control, worst case 8 cm. So "track may not cross a building" will block on-street alignments routinely, no matter where the footprints came from. On-street tram track follows roads and is meant to be exempt, but the exemption has to be real rather than incidental. See [RESEARCH_TILES.md](RESEARCH_TILES.md) §5.1.

Tram-road snapping, on-street track, off-road dragging, the grade rule for off-road segments, tram visuals.

**Accept when:** a tram line follows only allowed roads, a dragged segment leaves the road at a higher price, and a steep off-road segment gets a tunnel by itself.

Most of the scaffolding exists:

1. **Road restriction is done.** `BUILD.TRAM_ROADS` and `RoadIndex.snap(lon, lat, 'tram')` already limit trams to trunk/primary/secondary/tertiary (+links) and pedestrian streets. The fixture has a pedestrian street ("Market Walk") and plenty of residential roads to prove both sides of the rule.
2. **Tram visuals are done.** The dotted-circle line pattern and rounded-end vehicle shape are in [render/shapes.js](render/shapes.js) and selected by mode, so enabling Tram should just work.
3. **Enable `'tram'` in `PHASE_2_MODES`** in [ui/toolbar.js](ui/toolbar.js) — and rename that constant.
4. **The new work is `build/track-geometry.js`**: the spline for dragged off-road segments, the grade rule, and structure classification. [model/region.js](model/region.js) already provides `heightAt` (bilinear, tested exact on a ramp) and `isOccupied` for the building collision check. The fixture's ridge and notched valley exist specifically so tunnels and bridges have something to find.
5. **Dragging is the shared gesture.** Implementing off-road tram drags also gives bus via-points for free — do them together.

Watch out for: the grade rule samples every 20 m (`BUILD.SAMPLE_M`) against a ~30 m height grid, which is why `heightAt` interpolates rather than snapping. Don't change that to nearest-cell or the smoothed profile will step.
