# HANDOFF.md

Read this first in every session. Update it last.

**State:** Phases 0, 1, 2, R, Q, 3 and **4** complete. Rail is in: track built with the Build track tool, the full grade rule, the rail-and-roads rules, stations, metro and train lines on track, and the height-profile strip. Every Phase 4 acceptance criterion is asserted in code (§10).
**Last session:** Oct 15, 2026 — Phase 4 (rail), plus three bugs it turned up in earlier phases (§10, "Fixed on the way").
**Earlier:** Oct 10, 2026 — Phase 0 (research), Phase 1 (region and map), Phase 2 (buses and passengers), Phase R (data architecture), first live import, Phase Q (query restructure), Phase 3 (trams).

**Phase R is done, and it cancelled Phase D.** See [RESEARCH_TILES.md](RESEARCH_TILES.md).

The payload crisis that reordered the roadmap was a measurement error. `1.87 MB/km²` is Overpass's **decoded JSON**; it gzips 7.3–7.8× and browsers always ask for gzip, so a 6 km dense import is **6.8 MB on the wire, not 66**. And the 504s were never about chunk area — they were the `>;` recursion over building geometry nodes. Drop buildings and a whole **15 km** box of roads, rail, water and every POI node serves in **one request, 4.71 MB, 13.5 s**.

**Phase Q is done too.** The query is now two requests: everything-but-buildings for the whole region, then buildings as `out geom`, chunked. Measured against the live API, before and after:

| region | before | after |
| --- | --- | --- |
| 5 km | 5–10 requests, 49–120 s | **2 requests, 22 s** |
| 10 km | 22 requests, 289 s | **6 requests, 123 s** |

The region comes out identical — same 51,700 buildings and 502,376 residents for central Athens — and the fixture regenerates byte-for-byte, so nothing downstream moved.

| | |
| --- | --- |
| **Next** | **Phase 5 — full economy.** Loans, the fare slider, the finance panel, all four difficulties end to end, Hard's game over. Much of the plumbing already exists — see §11. |
| **Open question** | Clicking an existing stop with New line selects it, so a metro line cannot be *started* at a train station — only routed through one. Should a click on a stop of another mode start the new line there? (§10, "Tried on a real import") |
| **Still to try live** | Rail has been tried on a real import at Kiato (§10). Corinth, the case where buildings bite, has not. `tools/import-region.js` snapshots a region once for offline testing. |
| Shelved | Vector tiles for building geometry. Viable and fully costed ([RESEARCH_TILES.md](RESEARCH_TILES.md) §8), purely additive, worth it only if dense 15 km imports become the priority. |

The reason Phase R was ordered before Phase 3 was that a data-layer rewrite would change the occupancy raster's provenance. It never happened, so the raster is exactly what it was.

---

## 1. Pushing, and the live import

### Push — resolved, and `gh` is authenticated

`https://github.com/alexandrosgavrilis/otomig` exists, `main` tracks it, and everything through Phase R is pushed. The 2021 password-auth problem recorded here before is gone.

`gh` 2.102.0 at `~/.local/bin/gh` is logged in as `alexandrosgavrilis` with the token in the keyring. **Being logged in to `gh` is not enough on its own** — `git push` still failed with `could not read Username for 'https://github.com'` until `gh auth setup-git` was run, which installs `credential.https://github.com.helper = !gh auth git-credential`. That is now configured globally, so pushes need no prompt. If a future machine hits the same error, that one command is the fix.

**The repo is PUBLIC**, deliberately. The earlier instruction in this file said `--private`; Alex's decision on Oct 10 2026 was to leave it public, because nothing in the project needs to be secret. There are no API keys anywhere — Overpass, Nominatim and the elevation tiles all work keyless, and that is a property worth keeping. Say so in any future README edit rather than re-raising it.

### Run one live import

Everything is verified against the fixture, which needs no network. The assembly — worker → Overpass → elevation → IndexedDB → playable map — had never run as a whole.

```bash
npm start      # then open http://localhost:8000
```

**Never open `index.html` as a `file://` URL.** `User-Agent` is a forbidden header name, so a browser silently ignores any attempt to set it; we identify to the OSM services via `Referer`, which is only sent over `http://`.

**Done, Oct 10 2026 — and it found two bugs that the fixture could never have caught.** Phase 0 recorded that the sandbox could not reach the OSM endpoints, which was false, so this is automated now: `npm run test:live` drives a real import of central Athens through Chromium. 24 assertions. See §2.

Central Athens, 5 km, as actually imported:

| | |
| --- | --- |
| road edges / nodes | 25,974 / 21,172 |
| buildings | 51,700 — **2,068/km²**, against Phase R's 1,835/km² ground truth |
| residents | 502,376 — **20,095/km²**, against a real ~20,000/km² |
| rail edges / stations | 221 / 19 |
| elevation | 27.5 m … 257.1 m, 50 contour features |
| region JSON | 13.3 MB (6.3 MB in IndexedDB) |
| import | ~50–120 s, 5–10 Overpass requests; cached reload ~9 s |

**The population model is calibrated.** `M2_PER_RESIDENT: 40` and `DEFAULT_LEVELS: 2` put central Athens within 0.5% of its real density. That was a guess in Phase 1 and is now a measurement.

### The two bugs

Both would have reached Alex as a broken screen, and both were invisible to 272 passing unit tests.

1. **The whole map was sea.** `fetchTerrariumTile` sized its output array from `bitmap.width` *after* calling `bitmap.close()`, which sets width and height to 0. Every tile decoded to a zero-length `Float32Array`, every height sampled back as `undefined`, every contour vanished, and the sea mask swallowed the region. Nothing threw. The unit tests never caught it because they feed `sampleTilesToGrid` synthetic `Float32Array`s and never call `fetchTerrariumTile` — the bug lived entirely in the four lines no test could reach. `sampleTilesToGrid` now rejects a wrongly-sized tile instead of writing `undefined` into the grid.

2. **Overpass reports failure with HTTP 200.** A query that times out or runs out of memory server-side returns **200** with an empty `elements` array and a `remark` saying why. `fetchChunk` treated any 200 as success, so a loaded Overpass produced a silently empty region — no roads, no buildings, no error, just a blank blue map. The remark is now treated as the failure it is, and it feeds the existing retry and subdivision logic because the wording contains "timed out". `importRegion` also refuses outright to build a region with zero roads, as a backstop.

**Test-design note worth keeping.** The test first geocoded `"Athens"` and used Nominatim's first result. That result moves between calls, and some of those points put a 5 km box mostly out to sea — which legitimately imports almost nothing and made the test fail at random. It now geocodes `"Syntagma Square, Athens"`. Live tests need a *stable* subject, or their failures teach you nothing.

---

## 2. Testing

```bash
npm test                            # 469 logic assertions, plain Node, no dependencies
npm run test:browser                # 111 assertions in real Chromium via Playwright
npm run test:browser -- --headed    # ...and watch it
npm run test:live                   # 24 assertions against a REAL import — hits live OSM services
npm run test:live -- --km 5         # ...at a given size (default 5, the slider minimum)
npm run fixture                     # regenerate fixtures/test-region.json
```

The browser suite serves on **port 4001**, loads the fixture, and checks that MapLibre genuinely renders by sampling pixels rather than trusting the `load` event. Screenshots land in `tests/screenshots/` — **look at them.** They have caught things no assertion did.

`test:live` serves on **port 4002** and is deliberately *not* part of `npm test` or `test:browser`: it geocodes through Nominatim, pulls a real region from Overpass and fetches real elevation tiles. One import of one small region is well inside casual use — **do not loop it.** Overpass is also genuinely flaky, so an occasional retry in its output is normal rather than a regression. Its screenshots are `tests/screenshots/live-*.png`.

Playwright is a devDependency. `npm test` stays dependency-free.

Each phase's acceptance criteria live in `tests/phase2.js`, `tests/phase3.js` and `tests/phase4.js` marked `ACCEPTANCE:`, so they stay checked rather than being verified once by hand. Phase 3's drag gesture and Phase 4's waypoint clicks, Enter, double-click and station clicks are additionally driven through real mouse and keyboard events in `tests/browser.js`, because MapLibre's own handling is the thing most likely to break them.

`npm test` takes about 35 s of wall time but only ~2 s of CPU: some Phase 1 fetch tests wait out real retry backoff. That predates Phase 4 (the suite before it measured the same) and is harmless, but it is why the suite feels slow.

### Four bugs the browser suite caught

All four would have met Alex as a broken screen:

1. **The whole game layer rendered into a 300×150 box in the corner.** A `<canvas>` is a replaced element, so `position: absolute; inset: 0` does *not* stretch it — `width: auto` resolves to the intrinsic 300×150. Map, HUD, toolbar and panels all looked perfect; lines, stops and vehicles were invisible. Every assertion passed, because they asserted the *model* had a line, not that it could be seen. The suite now checks the overlay's CSS box against the viewport and samples it for the line's own colour.
2. **The MapLibre style was invalid**, so `load` never fired and the map stayed blank. `line-cap` is a *layout* property, not paint; and a `zoom` expression may only be the direct input of a top-level `interpolate`, so wrapping one in `['*', …]` is rejected.
3. **Land at exactly 0 m was painted as sea.** Marching squares puts a corner equal to the trace level on the low side, so flat zero-height ground read as water — a whole valley floor appeared as a blue tower. Now traced half a metre *below* sea level. **Superseded in part by Kiato (§10):** real elevation tiles without bathymetry report open sea as exactly 0 m too, which this rule turned into land. `settleSea` now tells the two apart by connectivity — 0 m ground joined to the region edge is sea, an enclosed 0 m plateau stays land — and the half-metre offset stays for the enclosed case.
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
19. **Two kinds of Overpass failure get opposite treatment.** A 429 or a dropped connection means "not now", so it keeps the full retry ladder. A 504, or a 200 carrying a `remark`, means "this query is too big for me" — re-sending it unchanged mostly fails the same way, and the only real fix is `fetchChunkAdaptive` subdividing the box. Those get `OVERPASS_HEAVY_RETRY_MAX` (1) retries and then give up so the split can happen. Measured: a 10 km import cost **22 Overpass requests and 289 s** on the full ladder, and **6 requests and 123 s** with the small budget. The old code's comment already said retrying an identical 504 was useless while the code did it four times.
20. **Modes were enabled phase by phase**, present but disabled until their phase shipped: a dead button that says "Tram" tells the player the plan, a missing one tells them nothing. All four are enabled as of Phase 4. Build track is the one tool still disabled by mode, for bus and tram.

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

Verified by `npm test` (469) and `npm run test:browser` (111). Phases 3 and 4 have their own sections, §9 and §10.

**Phase 1.** `LocalFrame` and the bbox/chunk maths; terrain height grid with bilinear interpolation (exact on a ramp); 200 m demand grid; 10 m occupancy bitset; Overpass parsing with road-class filtering, abandoned-rail rejection, chunk-overlap de-duplication and shared-node collapsing; Terrarium decode and tile resampling; marching-squares contours and sea polygons; the base-map GeoJSON. In the browser: the new-game screen, search firing no request while typing, MapLibre rendering real pixels, layer toggles, zoom revealing minor roads, `maxBounds`, IndexedDB round-trips, the module worker booting.

**Phase 2.** The two clocks reconciling to an 18-hour service day; Dijkstra road routing; catchments and the sparse O-D pair table; seasonal multipliers (Tourist swells in August) and fare elasticity at exactly 2^−0.3; the platform graph with transfers costing a wait and a penalty while staying aboard is free; vehicles shuttling and looping, spaced evenly in time; patience, the grace period, satisfaction dropping 0.15 and recovering 0.02/day; tickets, advertising, running costs, maintenance, Hard's twelve-month game over; save/load round-tripping stops, lines, vehicle positions, balance and calendar.

**Acceptance, asserted in code:** two bus lines sharing an interchange carry passengers who transfer and arrive; neglected routes visibly dip; money moves; a reload restores the game exactly.

---

## 7. Layout

```
index.html  style.css  config.js  main.js      package.json (no runtime deps)
data/    overpass.js  terrain.js  import.worker.js  cache.js
model/   region.js (contract, frame, grids)  population.js  network.js (stops, lines, track)  save.js
build/   road-routing.js  track-geometry.js (spline, grade rule, structures, buildRailTrack)
         rail-roads.js (crossings, corridors)  track-routing.js (stations and paths on track)
sim/     clock.js  demand.js  routing.js  vehicles.js  passengers.js
         economy.js  game.js
render/  basemap.js (MapLibre style)  overlay.js (Canvas 2D)  shapes.js  profile.js (height strip)
ui/      new-game.js  hud.js  toolbar.js  panels.js  strings.js
vendor/  maplibre-gl.js  maplibre-gl.css  LICENSE.txt      (v5.24.0, UMD)
fixtures/ make-fixture.js  test-region.json               (npm run fixture)
tests/   run.js  phase2.js  phase3.js  phase4.js  browser.js  live.js  screenshots/
```

The fixture is a 6×6 km synthetic coast: a bay in the south-west, a lake, a river, a ridge with a notched valley (for Phase 4's tunnels and bridges), a motorway, a pedestrian street, a road tunnel and bridge, an existing railway with three stations, and an abandoned branch the parser must reject. **41,828 residents, ~1,162/km²** — a small town, so `passengersPerDot` is 1. It carries 1,971 building outlines.

---

## 8. Known gaps

- **A drag always wins over a click near a line.** Pressing within 10 px of a bus or tram segment starts a drag. A press that never moves falls through to a click, which is how Edit stops selects a line — but a hand that wobbles a pixel drags instead.
- **Edit stops is select-only.** It selects stops, lines and track (from Phase 4 — before that, no click anywhere opened the line panel). Dragging a stop to move it and clicking a segment to insert one are unwired; `Network.insertStop` and `removeStopFromLine` exist and are tested.
- **A cost preview follows the cursor only while dragging a segment**, not while placing stops. The drag is the gesture that can spend tens of millions without placing anything, so it was the one that needed it most; stop placement still gives no running total.
- **Water from multipolygon relations is not imported.** Only `way[natural=water]`. Big lakes and most coastal water in OSM are relations, so a region with one will be missing it. The sea mask comes from elevation and is unaffected.
- **A land island inside a sea area is painted as sea** — the tracer returns it as its own ring, not a hole. Rare; fix is ring-containment tests.
- **Save slots are one slot** in the UI. `model/save.js` supports any number.
- **`revalidateDots` releases passengers aboard a deleted line** at the next stop rather than somewhere sensible.
- **Nominatim's `population` extratag is often absent**, and the new-game screen has no "type the population" field, which the spec allows for.
- **One-way roads are ignored**, per the spec's v1 decision.
- **Import payload is not a problem** (§4, corrected). What remains is **region size in storage**: a dense 15 km region holds ~300,000 building outlines and ~76 MB of JSON in IndexedDB, identically whatever the source. Created by the decision to keep and draw footprints, which is still the right decision. It is an encoding problem — delta-encoded typed arrays instead of nested JSON arrays — and deserves its own task. See [RESEARCH_TILES.md](RESEARCH_TILES.md) §5.5.
- **Overpass timing is unpredictable.** The same 2 km box measured 18.4 s, then 2.3 s, then 2.7 s on one afternoon. Region figures are single runs; read them as "minutes, variable".
- **Rail gaps from Phase 4** — see §10, "Known gaps".
- **Building multipolygon relations are not imported.** `parseResponses` handles `way["building"]` only, so a mall or a courtyard block tagged as a relation is missing — the same gap as water. Measured at 166 relations against 30,686 ways over a 4 km box of Athens, but they are large buildings.

---

## 9. Phase 3 — trams. Done.

Tram is enabled, on-street track is built and charged with the line, and dragging a segment pulls it off the road into dedicated track with the grade rule applied. The acceptance criteria are asserted in [tests/phase3.js](tests/phase3.js) marked `ACCEPTANCE:` and again through a real mouse drag in [tests/browser.js](tests/browser.js), so they stay checked rather than being verified once by hand.

Measured on the fixture, between two stops either side of the ridge:

| | |
| --- | --- |
| on-street, following the road | 1,400 m, **€21M** |
| dragged off-road through one via-point | 1,878 m, **€101M** — 37 samples at grade, 29 bridge, 29 tunnel |

**The grade rule, since the spec asks for the method to be documented.** Build the highest grade-feasible profile that stays at or below the terrain, build the lowest that stays at or above it, average the two. Both envelopes are feasible by construction, and the average of two profiles whose steps are each within ±g has steps within ±g too — so it is feasible in one pass, with no iteration and no convergence test. The lower envelope alone would cut through every hill and never bridge a valley; the upper would bridge everything and never tunnel. Averaging gives tunnels through hills and bridges over valleys. See `smoothProfile` in [build/track-geometry.js](build/track-geometry.js).

### Decisions worth not relitigating

1. **The ends are pinned.** An off-road segment runs between two stops that sit on the street, so the profile is constrained to the cone reachable from both ends before the envelopes are built. Without it a segment over a ridge started 36 m in the air — the tram left the stop on a bridge going nowhere. If the two ends are further apart in height than the grade can climb over the segment's length, no profile exists and the drag is refused as `tooSteep`.
2. **Via-points are keyed by the stop pair, not the segment index.** An index shifts the moment a stop is inserted or removed, which would silently move a drag to a different part of the line. With a pair key, inserting a stop breaks the pair and the via is dropped — the segment reverts to its road route, which is predictable and visible.
3. **`BUILD.OFF_ROAD_STREET_LEAD_M` (25 m) exempts each end from the building-collision rule.** This is the Phase R finding landing exactly where it was predicted to: 23.7% of buildings in central Athens come within 3 m of a road centreline in OSM itself. An off-road segment starts and ends at stops on road centrelines, so without the exemption almost every drag in a real city would be blocked by a building sitting on the street it leaves from. The spec exempts on-street tram track; this makes that exemption real at the point where the track leaves and rejoins the street rather than leaving it to luck.
4. **Track maintenance was missing and is now charged.** `maintenancePerYear` only counted stops. A tram line's track is worth tens of millions a kilometre against half a million a stop, so leaving it out would have made trams nearly free to keep — exactly backwards. Bus lines contribute nothing, having no track.
5. **The drag is one gesture with two meanings.** For a bus it forces a different road route through the dragged point; for a tram it pulls the segment off the road entirely. Implementing one gave the other for free, which is why the spec's bus via-points ship here rather than in Phase 2.
6. **MapLibre's drag-pan is suspended for the duration of a drag** and restored on mouseup *and* on the canvas's `mouseleave`. Releasing outside the canvas would otherwise leave the map permanently un-pannable. The browser suite asserts `dragPan.isEnabled()` after the gesture.

---

## 10. Phase 4 — rail. Done.

Metro and Train are enabled. Rail is built in two steps, as the spec asks: **Build track** lays metro or train track through waypoint clicks, then **New line** places stations on it and routes between them on track. The acceptance criteria are asserted in [tests/phase4.js](tests/phase4.js) marked `ACCEPTANCE:`, and again through real clicks, keys and a double-click in [tests/browser.js](tests/browser.js).

| Acceptance criterion | Where it is proved |
| --- | --- |
| track is a smooth curve through waypoints | centripetal Catmull-Rom from Phase 3, now driven by Build track clicks |
| the grade rule gives tunnels and bridges without the player choosing | no tunnel or bridge tool exists; the tests check the terrain put them there |
| metro stays underground on flat land and surfaces brightened across a valley | fixture plain, and the fixture's ridge notch; the colour is checked on a recording canvas context |
| train track on hilly ground produces tunnels and bridges | a bridge over the river, then a tunnel through the ridge |
| a metro line runs on train track; a train line is refused on metro track | both station placement and pathfinding are refused for train |
| the height-profile strip shows what is being built | pixel-sampled in Chromium, with the running cost under it |

Measured on the fixture:

| track | length | cost | structures (terrain-chosen) | level crossings |
| --- | --- | --- | --- | --- |
| metro, flat plain | 1.04 km | €84.8M | tunnel 1,080 m | 0 |
| metro, across the ridge notch | 2.20 km | €161.2M | tunnel 800 m → **bridge 600 m** → tunnel 820 m | 0 |
| train, river then ridge | 2.68 km | €277.0M | **bridge 420 m** → **tunnel 2,180 m** → at grade 120 m | 1 |
| train, over the motorway | 0.95 km | €17.0M | at grade 540 m → **bridge 100 m** → at grade 340 m | 4 |

Planning a track takes 1–6 ms (the road corridor index costs ~30 ms once, on first use), so the preview is re-planned on every mouse move.

### How it works

- **[build/track-geometry.js](build/track-geometry.js) `buildRailTrack`** runs the spec's steps in order: spline, desired height, smoothing with the ends pinned, hard targets (water clearance, motorway clearance) pinned and smoothed again, classification, then the building and road rules, then the price. `smoothProfile` now takes pins *anywhere* along the profile, not just the ends. The same cone argument as Phase 3 proves a pinned sample is met exactly and the result stays feasible in one pass. The proof is in its comment.
- **[build/rail-roads.js](build/rail-roads.js)** indexes road segments in a 50 m grid and does exact segment intersection, because OSM road edges are straight node-to-node. Roads on a bridge or in a tunnel are skipped; footways never reach the road graph at all.
- **[build/track-routing.js](build/track-routing.js)** is the road graph's counterpart: nodes are every 20 m track sample, edges join consecutive samples plus a zero-length edge at each junction. **Compatibility lives on the nodes**: a train line may only visit train-track samples. That one rule *is* "metro runs on train track, train is refused on metro track", with no special cases at junctions.
- **Track is a first-class object** (`Track` in [model/network.js](model/network.js)), separate from lines. A track saves only its waypoints, junctions, end heights and price; its geometry is rebuilt on load. Three tracks and a line save in well under the 20 kB budget.

### Decisions worth not relitigating

1. **New metro track may join train track; new train track may join only train track.** *Confirmed by Alex, Oct 15 2026: only metro crosses onto train track, never the other way round.* The spec says "clicking existing track of the same type makes a junction". This reads that rule through compatibility: a junction is made wherever the new track's vehicles can carry on. Metro onto train track is useful (a metro line can continue onto it) and harmless; train onto metro track would lead nowhere a train may go.
2. **Free ends are pinned at their desired height**: a train terminus at grade, a metro terminus 15 m down. The alternative is a track that ends in mid-air or deep underground — the exact bug Phase 3 fixed for trams. The cost is that a short train track between two points too far apart in height is refused as too steep, and the player has to draw a longer way round. That is the spec's intent ("the only way to avoid them is to draw a better, usually longer, path"), and the profile strip shows why.
3. **Water clearance is a hard floor for train track**, not a target. The spec puts "never lower than 8 m above any water surface" in the desired profile, but averaging the two envelopes then left a train about halfway up to it over a river. Over-water samples below the clearance are pinned to it. Metro is exempt, since it passes under water.
4. **Motorway clearance tries the nearer side, then above, then below** before refusing. The spec says "whichever is nearer". A nearer side that cannot be reached within the grade would otherwise refuse a crossing that the other side could make.
5. **Structure runs over water and at motorway crossings are protected from the 60 m merge.** A 28 m river was being merged into its banks, so the track crossed it at grade, and a short metro motorway bridge would have flickered back to a level crossing.
6. **Lakes and rivers now count as water for the grade rule**, from the OSM water polygons. Before, only the sea counted, because the elevation data shows a river as dry ground at water level. This applies to off-road tram segments too: a tram dragged across a river now gets a bridge. Trams do not get the hard 8 m floor; their segments are short, and the spec's tram rule is unchanged.
7. **An at-grade crossing takes the structure of the nearer of its two samples.** "At grade" for the road rules means that sample's classification; a ramp sample 5 m up counts as at grade.
8. **"Running along a road" counts samples, at 20 m each**, across *any* road's corridor. With the spec's corridor widths, a square crossing of the widest road holds two samples (40 m, allowed) and so does a 45° one, so the 40 m limit catches running along a road without ever catching a legal crossing. The 45° limit has a 1e-6° tolerance, because a diagonal across a street grid is 45° give or take float error.
9. **No exemption at the ends for rail.** Phase 3's 25 m street lead-in exists because off-road tram segments start on a street. Rail track never does.
10. **Stations snap to the nearest 20 m sample**, not a projected point. That is at most 10 m out, invisible at any zoom where clicking works, and it gives every station a stable graph node (`"t3:41"`) that survives a reload.
11. **Clicking existing track ends the draft there and builds it**, the way closing a loop finishes a line in Mini Metro. The exception is the track you started from, within 90 m of the start: drawing away from a track, the first waypoint is inevitably still near it.
12. **A blocked track is refused and the draft is kept.** **Backspace** takes back the last waypoint, which is the only way to reroute around a blocked stretch without starting over. Esc discards the draft. Switching mode or tool discards it too, since nothing about it has been paid for.
13. **Junction snap is 30 m, or 10 px when zoomed out further.** Missing a junction by a few metres silently makes a dead end that looks connected, so the snap is generous.
14. **Rail lines pay nothing for track.** Track is bought with Build track and maintained on its own (1.5%/yr, 25% off with OSM rail), whether or not a line runs on it. Bulldozing refunds half, and is refused while a station or a line still uses the track.
15. **Rail lines cannot be dragged.** They follow their track; there is nothing to drag them to.

### Fixed on the way — three bugs from earlier phases

1. **The right-hand panel could never close.** `.panel { display: flex }` overrode the `hidden` attribute, so the × button, Esc and bulldozing all left it on screen, showing a stop that no longer existed. One global `[hidden] { display: none !important }`; the browser suite now asserts the panel closes, and fails without the rule.
2. **No click ever selected a line.** The line panel (vehicles +/−, colour, delete) was unreachable in the UI since Phase 2; the tests reached it through the model. Edit stops now selects stops, lines and track.
3. **Ids could collide after loading a save on a fresh page.** The id counter starts at 1 per page and stops, lines and track share it, so a save's ids run past its object count. The first stop built after loading could reuse a live id and silently merge two stops in every Map keyed by id. `reserveIds` in [model/network.js](model/network.js) now bumps the counter past everything loaded. The test reproduces a fresh page and fails without the fix.

### Known gaps

- **Junctions are only made at the ends of new track.** New track drawn across existing track crosses it without connecting, and a rail-on-rail crossing at grade is neither refused nor drawn as a diamond.
- **Track cannot be edited**, only bulldozed (if unused) and redrawn.
- **Lines sharing only part of their track are not offset side by side.** Bundling still keys on a whole segment's ends and length, which works for buses on the same road between the same stops and not for two rail lines that share half a route.
- **The profile strip sits bottom centre over the map**, and while drawing near the bottom of the screen it hides the track being drawn. Pan, or move it, if it gets in the way.
- **Existing OSM rail is not yet usable track**; that is Phase 6. The rail-and-roads rules also ignore it, so new track crossing OSM rail is not treated as a crossing.
- **A track whose junction partner is bulldozed becomes a dead end there**, keeping its stored end height. Correct, but nothing tells the player.
- **The fixture is a hard place to build rail**, and that is intended: of 1,753 straight probes across it, 63 are buildable. The rest are refused for buildings, for running along the 200 m street grid, or as too steep. The tests use alignments found by search, robust to ±10 m so that browser clicks reproduce them.

### Tried on a real import: Kiato, Oct 15 2026

5 km at (22.748, 38.012), through the real new-game screen and import worker. 110 s, two Overpass requests, no page errors. 6,026 road edges including the A8 motorway, 162 edges of live Proastiakos rail with Kiato station, terrain from sea level to 161 m — and only **45 buildings**, which is OSM, not the importer: the town is barely mapped.

The region was saved once with [tools/import-region.js](tools/import-region.js) and everything after ran offline: the game logic in Node, and the real UI in Chromium with the saved region served in the fixture's place.

**Found and fixed:**

1. **The sea was land.** The tiles have no bathymetry for the Gulf of Corinth: 10,327 of 27,889 cells are exactly 0.000 m. Phase 1's rule that exactly 0 m is land (written for a synthetic valley floor) imported the whole gulf as land, and the grade rule would have run train track across it at grade. `settleSea` in [model/region.js](model/region.js) now lowers 0 m ground joined to the region edge to `REGION.FLAT_SEA_DEPTH_M`. It runs in `reviveRegion`, so regions already cached are corrected on their next load.
2. **A staircase of rings along every flat coast** — the 0 m contour traced through centimetres of noise in that flat sea, drawn as a *major* contour because 0 is a multiple of 100. Contours now start above sea level, and the map filters out the 0 m line in regions cached before that.
3. **An empty white panel at game start.** The panel was only ever hidden by its first render, which waited for a selection. Before today's `[hidden]` fix it was simply always on screen.
4. **Level-crossing markers were drawn under the lines**, so on a line they were almost invisible. They are their own painter now, above the lines.

**What rail does on real ground** — 600 random straight tracks, both modes:

| | buildable | refused: shallow crossing | too steep | buildings |
| --- | --- | --- | --- | --- |
| train | 107 of 353 | 122 | 91 | 33 |
| metro | 319 of 353 | 6 | 28 | — |

- **Shallow crossings are the commonest refusal for train.** Real roads curve, and the angle is judged on the short OSM segment actually crossed, so a long straight line meets something at under 45° somewhere. That is the spec's rule working, but it makes train track noticeably harder to place in a real road network than on the fixture's grid. Worth watching in play.
- **Grade-limited train track makes long viaducts.** A 1.5 km track climbing 33 m (2.46% average against 2.5%) has exactly one feasible profile, a straight ramp: a 20 m-high viaduct over the flat start, then a cutting and a short tunnel. It is what a real railway would need, and the profile strip shows it plainly.
- **Metro surfaces into a shallow cutting on a hillside steeper than 4.5%.** The spec's averaging leaves it 6–7 m under the ground, and the spec calls under 8 m "at grade". Literal and correct, but it means an overground metro stretch — subject to buildings and roads — where a player would expect a tunnel.
- **The A8 crossing works as designed**: dual carriageways are two crossings, spanned by one 120 m bridge with ramps; seven ordinary roads on the same track became level crossings.
- **Station names fall back to "Station"** wherever no named street is within 200 m, which in rural Kiato is most places.

**Not fixed — needs a decision or is out of scope:**

- **A line cannot be started at an existing stop.** With New line and nothing being drawn, a click on any existing stop selects it — the spec's "clicking an object selects it". So a metro line can only *pass through* a train station's location, never start there, and the same is true of a second bus line from an existing bus stop. With interchanges this is the first thing a player tries. A gameplay change, so it is Alex's call.
- **A discarded one-stop line leaves its stop behind**, paid for and unused. Pre-existing, all modes.

### Where to test it live

The survey below was done before Phase 4, to choose where rail should be tried against real data. It still stands.


**Alex's call, and the numbers back it.** Rail cannot cross buildings, so testing track building in a dense city means almost every alignment is blocked before the geometry is exercised at all. Surveyed with [tools/probe-railtest.js](tools/probe-railtest.js) over 5 km boxes:

| site | usable rail ways | stations | buildings/km² |
| --- | --- | --- | --- |
| **Kiato** (22.748, 38.012) | 42 | 1 | **2** |
| Aigio (22.085, 38.248) | 48 | 1 | 10 |
| Diakopto (22.199, 38.196) | 30 | 1 | 13 |
| Xylokastro (22.630, 38.078) | 59 | 0 | 16 |
| Corinth (22.935, 37.940) | 49 | 1 | 224 |
| *central Athens (control)* | 59 | 21 | **1,837** |

**Use Kiato or Aigio for the geometry** — live standard-gauge Proastiakos track to connect to, a station, and effectively nothing in the way. **Use Corinth as the middle case**: a real town at 12% of Athens's building count, dense enough that the building rule genuinely bites without making every alignment impossible. Keep Athens as the stress test for the *import*, not for drawing track.

Three traps, all measured rather than assumed:

- **Most of the Peloponnese network is dead-tagged.** The system largely closed in 2011 and much of it is `railway=disused` or `abandoned`, which `isDeadRail` in [data/overpass.js](data/overpass.js) correctly rejects. "Near existing rail" on a map is not the same as rail the importer will keep — Zevgolatio (22.820, 37.970) looks railway-adjacent and returns **zero** usable rail ways. The north-coast Proastiakos line is the live one.
- **`REGION.SIZE_KM_MIN` is 5, so a 1×1 km region is not currently possible.** The slider minimum would have to drop first. A 5 km rural box is already sparse enough to draw freely, so this is only worth changing if a tighter box is actually wanted for iteration speed. Note that `npm run test:live -- --km 1` would not silently lie about it: the HTML range input clamps to 5 and the test's `size set to N km` assertion fails, which is the right failure but a confusing message.
- **Rural means almost no demand.** Kiato returns 45 buildings across 25 km², so residents and attraction will be close to nothing and no one will ride the line. That is fine for testing track geometry, the grade rule and crossings, and useless for testing whether a rail line earns money. Those need Corinth or Athens.

---

## 11. Phase 5 — full economy (next)

Seasonal profiles, coverage subsidies, loans, all four difficulty levels, Hard's game over, the fare slider, the finance panel.

**Accept when:** a Tourist region visibly swells in August; Hard on a small island supports a bus line or two and little more; Creative never limits money.

**Already in place**, so this phase is mostly UI and verification:

1. **Seasonal multipliers** are applied to trip generation in `sim/demand.js`, and `tests/phase2.js` already asserts Tourist swells in August.
2. **The coverage subsidy** is computed daily in `Economy.endDay`, capped at running costs, from `DIFFICULTY[*].subsidyShare`.
3. **Difficulty rules** (`DIFFICULTY` in [config.js](config.js)) drive starting capital, patience, fare evasion, build-blocking when negative and Hard's 12-month game over. `economy.gameOver` is checked every tick and `showGameOver` in [main.js](main.js) puts up the calm ending.
4. **`economy.fareMultiplier`** exists, is saved, scales tickets and feeds the demand model's elasticity. **There is no slider for it yet.**
5. **Loans are configured** (`LOANS` in config — 3/6/12 years at 4/6/9%, Alex's decision C4) **but not implemented**: no state, no repayment, no UI. That is the main build.
6. **The finance panel** exists with monthly income and expenses by category, but no loans view.

**Watch out for:** maintenance now includes metro and train track, which dwarfs everything else once rail is built. A 2.7 km tunnelled train track costs €4.2M a year to keep before a single train runs. Hard's balance will feel that, which is probably right, but check it against the "a bus line or two on a small island" criterion before retuning anything else.
