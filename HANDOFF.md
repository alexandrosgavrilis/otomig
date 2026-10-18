# HANDOFF.md

Read this first in every session. Update it last.

**State:** Phases 0–4, R, Q, **5 and 6** complete — every phase of the build plan is in. Phase 5: loans, the fare slider and a full finance panel (§11). Phase 6: existing OSM railways are free, ready-made train track, and stations on them can switch on intercity service (§14). There is also a **play-testing panel on the ` key** that tunes passenger behaviour and money live (§15). Every acceptance criterion is asserted in code; the economic half of "Hard on a small island" is measured on a real island, and holds since timetables (§15, §16).
**Latest:** Oct 17, 2026 (evening) — bus and tram lines rebuilt to work exactly as in Cities: Skylines, and the double/single stop machinery removed (§30); then two passenger fixes: trips may start across the road, and big dots no longer throttle a new network (§31). Oct 18: tracks join where they cross, trams refuse streets over 10%, refusals are red, and the top bar shows the difficulty (§32).
**Last session:** Oct 16, 2026 (evening and night) — Phase 5, Phase 6 with intercity, the tuning panel, a fix for panel buttons that could lose clicks (§11), a balance measurement on Poros (§15), then Alex's decisions on what a dot means: capacity in people, a dot sized to cap what is drawn, a legend, timetables, a Flows layer, and groundwork for ferries (§16, §17).
**Before that:** Oct 15–16, 2026 — Phase 4 (rail), a real-data trial at Kiato (§10), lines sharing stops (§12), buildings filled in from Overture, population set by the seasonal profile, and a transfer penalty on every change of vehicle (§13).
**Earlier still:** Oct 10, 2026 — Phase 0 (research), Phase 1 (region and map), Phase 2 (buses and passengers), Phase R (data architecture), first live import, Phase Q (query restructure), Phase 3 (trams).

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
| **Next** | **Alex's play-test.** Open the tuning panel with **`**, change what feels wrong, press *Copy changes* and hand the list over; it becomes the new defaults in [config.js](config.js). The questions most worth answering are in §15. After that: bug fixes and the spec's polish list (side-by-side offsets for shared track, performance, small UX fixes). |
| **Done, Oct 16 (evening)** | Phase 5 (§11), Phase 6 with intercity (§14), the tuning panel (§15). |
| **Done, Oct 17** | Alex's first play-test list, all 14 items (§18): contour specks gone and the sea from OSM's coastline; a steady heat map that ignores unserved stops; vehicles facing their way; a day bar; bulldozing a stop at a time; undo and Finish buttons for touch; dragging stops; Patras's narrow-gauge railway; request stops; flows per stop; buildings far from roads make no demand; one-way streets. **Regions imported before this are re-fetched once when next chosen.** |
| **Done, Oct 16 (night)** | Capacity counted in people; the dot sized to cap what is drawn at ~200; the legend; timetable-aware waiting; the Flows layer; which clock each number uses (§16). Ferry groundwork (§17). |
| **Done, Oct 16** | Unmapped buildings are filled in from Overture's ML footprints, and the seasonal profile now decides how many people the buildings hold, with the curve moving the population (§13). |
| **Decided, Oct 16** | Every change of vehicle pays the 5-minute transfer penalty, at the same stop too (§13). The town populations' ~1.5× overshoot is accepted. The stepped coastline is accepted as it is. |
| **Still to try live** | Rail has been tried on a real import at Kiato (§10). Corinth, the case where buildings bite, has not. `tools/import-region.js` snapshots a region once for offline testing. |
| Shelved | Vector tiles for *all* building geometry (Overture now fills only the gaps, §13). Viable and fully costed ([RESEARCH_TILES.md](RESEARCH_TILES.md) §8), worth it only if dense 15 km imports become the priority. |

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

**`npm start` is [tools/serve.js](tools/serve.js), not Python's server, since Oct 17 2026.** `python3 -m http.server` sends no cache headers, so a browser could keep an old module after an update and run a mix of old and new files; Alex's import failed with "ways is not iterable" when a new worker met a cached old `data/overpass.js`. The Node server sends `Cache-Control: no-cache` (unchanged files still return a quick 304), listens on every interface like Python's did so a tablet on the network can play, and is what the browser suite, the live test and `tools/import-region.js` now use. After pulling an update into a browser that last ran the old server, hard-refresh once (Ctrl+Shift+R).

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
npm test                            # 773 logic assertions, plain Node, no dependencies
npm run test:browser                # 181 assertions in real Chromium via Playwright
npm run test:browser -- --headed    # ...and watch it
npm run test:live                   # 24 assertions against a REAL import — hits live OSM services
npm run test:live -- --km 5         # ...at a given size (default 5, the slider minimum)
npm run fixture                     # regenerate fixtures/test-region.json
```

The browser suite serves on **port 4001**, loads the fixture, and checks that MapLibre genuinely renders by sampling pixels rather than trusting the `load` event. Screenshots land in `tests/screenshots/` — **look at them.** They have caught things no assertion did.

`test:live` serves on **port 4002** and is deliberately *not* part of `npm test` or `test:browser`: it geocodes through Nominatim, pulls a real region from Overpass and fetches real elevation tiles. One import of one small region is well inside casual use — **do not loop it.** Overpass is also genuinely flaky, so an occasional retry in its output is normal rather than a regression. Its screenshots are `tests/screenshots/live-*.png`.

Playwright is a devDependency. `npm test` stays dependency-free.

Each phase's acceptance criteria live in `tests/phase2.js` to `tests/phase7.js` marked `ACCEPTANCE:` (phase7 is the work after Phase 6, §16–17), so they stay checked rather than being verified once by hand. Phase 3's drag gesture and Phase 4's waypoint clicks, Enter, double-click and station clicks are additionally driven through real mouse and keyboard events in `tests/browser.js`, because MapLibre's own handling is the thing most likely to break them.

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

**One dot no longer always means ten passengers.** *Revised Oct 16 2026 — see §16 for the current rule: one person per dot in small places, growing only to cap what is drawn at about 200.* It scales with the region: `passengersPerDot(residents)` in [config.js](config.js) — originally 1 up to ~150,000 residents, 10 at a million, capped at 50.

The reason is arithmetic, not taste. Visible dots ≈ `(trips/day × journey length ÷ 18 h) ÷ dot size`, so at a fixed 10 a town of 40,000 showed about one dot at a time and a village showed none. That was never a bug: a village really does have about four people on its buses at any moment, and four people is less than half a dot.

The scale is fixed at import and never changes mid-game — a dot that silently changed meaning would make every count on screen a lie. Every dot↔people conversion now reads one value; there were four hardcoded `× 10`s, one of them inside ticket income, which would have silently desynced the money.

### Two more spec amendments, Alex's decisions of Oct 16 2026 (§13)

- **"No fallback for areas with poor building coverage" no longer holds.** Where OSM has the roads but not the buildings, the import fills in Microsoft's ML footprints from Overture Maps.
- **The seasonal profiles multiply the population, not trip generation**, and the profile also decides how many people the buildings hold. The seasons flip south of the equator, and Tourist can peak in winter.

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
14. **Every change of vehicle pays the transfer penalty; a first boarding never does.** *Changed Oct 16 2026, Alex's decision:* the penalty used to sit on the walk between two stops, so changing lines at the same stop was free. Each stop now has a "start" node and an "arrived" node, and boarding from "arrived" — at the same stop or after walking to the next one — adds the penalty. See §13.
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

Verified by `npm test` (766) and `npm run test:browser` (179). Phases 3 to 6 have their own sections: §9, §10, §11 and §14.

**Phase 1.** `LocalFrame` and the bbox/chunk maths; terrain height grid with bilinear interpolation (exact on a ramp); 200 m demand grid; 10 m occupancy bitset; Overpass parsing with road-class filtering, abandoned-rail rejection, chunk-overlap de-duplication and shared-node collapsing; Terrarium decode and tile resampling; marching-squares contours and sea polygons; the base-map GeoJSON. In the browser: the new-game screen, search firing no request while typing, MapLibre rendering real pixels, layer toggles, zoom revealing minor roads, `maxBounds`, IndexedDB round-trips, the module worker booting.

**Phase 2.** The two clocks reconciling to an 18-hour service day; Dijkstra road routing; catchments and the sparse O-D pair table; seasonal multipliers (Tourist swells in August) and fare elasticity at exactly 2^−0.3; the platform graph with transfers costing a wait and a penalty while staying aboard is free; vehicles shuttling and looping, spaced evenly in time; patience, the grace period, satisfaction dropping 0.15 and recovering 0.02/day; tickets, advertising, running costs, maintenance, Hard's twelve-month game over; save/load round-tripping stops, lines, vehicle positions, balance and calendar.

**Acceptance, asserted in code:** two bus lines sharing an interchange carry passengers who transfer and arrive; neglected routes visibly dip; money moves; a reload restores the game exactly.

---

## 7. Layout

```
index.html  style.css  config.js  main.js      package.json (no runtime deps)
data/    overpass.js  terrain.js  coastline.js (OSM coast → sea)  import.worker.js  cache.js
         overture.js (ML building gap-fill, PMTiles)  mvt.js (vector tile decoder)
model/   region.js (contract, frame, grids)  population.js  network.js (stops, lines, track)  save.js
build/   road-routing.js  track-geometry.js (spline, grade rule, structures, buildRailTrack)
         rail-roads.js (crossings, corridors)  track-routing.js (stations and paths on track)
         osm-rail.js (existing railways → ready-made track)
sim/     clock.js  demand.js  routing.js  vehicles.js  passengers.js
         economy.js (incl. loans)  intercity.js  tuning.js (live config, for the ` panel)  game.js
render/  basemap.js (MapLibre style)  overlay.js (Canvas 2D)  shapes.js  profile.js (height strip)
ui/      new-game.js  hud.js  toolbar.js  panels.js  tuning.js (the ` panel)  strings.js
vendor/  maplibre-gl.js  maplibre-gl.css  LICENSE.txt      (v5.24.0, UMD)
fixtures/ make-fixture.js  test-region.json               (npm run fixture)
tests/   run.js  phase2.js … phase7.js  profiles.js  browser.js  live.js  screenshots/
```

The fixture is a 6×6 km synthetic coast: a bay in the south-west, a lake, a river, a ridge with a notched valley (for Phase 4's tunnels and bridges), a motorway, a pedestrian street, a road tunnel and bridge, an existing railway with three stations, and an abandoned branch the parser must reject. **41,828 residents, ~1,162/km²** — a small town, so `passengersPerDot` is 1. It carries 1,971 building outlines.

---

## 8. Known gaps

- **A drag always wins over a click near a line.** Pressing within 10 px of a bus or tram segment starts a drag. A press that never moves falls through to a click, which is how Edit stops selects a line — but a hand that wobbles a pixel drags instead.
- **Edit stops** selects stops, lines and track, and since Oct 17 drags a stop to move it (§18). Clicking a segment to insert a stop is still unwired; `Network.insertStop` exists and is tested.
- **A cost preview follows the cursor only while dragging a segment**, not while placing stops. The drag is the gesture that can spend tens of millions without placing anything, so it was the one that needed it most; stop placement still gives no running total.
- **Water from multipolygon relations is not imported.** Only `way[natural=water]`. Big lakes and most coastal water in OSM are relations, so a region with one will be missing it. The sea mask comes from elevation and is unaffected.
- **A land island inside a sea area is painted as sea** — the tracer returns it as its own ring, not a hole. Rare; fix is ring-containment tests.
- ~~**Save slots are one slot** in the UI.~~ One save and one autosave per region, and save files that carry the map (§20).
- **`revalidateDots` releases passengers aboard a deleted line** at the next stop rather than somewhere sensible.
- **Nominatim's `population` extratag is often absent**, and the new-game screen has no "type the population" field, which the spec allows for.
- ~~**One-way roads are ignored**, per the spec's v1 decision.~~ Obeyed since Oct 17 (§18).
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
- ~~**Existing OSM rail is not yet usable track.**~~ It is, from Phase 6 (§14). **Still true:** the rail-and-roads rules ignore it, so new track drawn *across* existing rail is neither a crossing nor a junction (see the first gap above).
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

- ~~**A line cannot be started at an existing stop.**~~ Fixed the same day, on Alex's instruction — see §12.4.
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

## 11. Phase 5 — full economy. Done.

Seasonal profiles, coverage subsidies, all four difficulty levels and Hard's game over were in place before (§13 and Phase 2). This phase added what was missing: **loans**, the **fare slider** and a **finance panel** that adds up. Asserted in [tests/phase5.js](tests/phase5.js), and through real clicks in [tests/browser.js](tests/browser.js).

| Acceptance criterion | Where it stands |
| --- | --- |
| a Tourist region visibly swells in August | asserted since §13 (`tests/phase2.js`, `tests/profiles.js`) |
| Creative never limits money | asserted: a €10¹⁵ purchase, vehicles up to the headway cap, two months of running costs, and a save and reload |
| Hard on a small island supports a bus line or two and little more | What Hard can *afford* is asserted: two bus lines yes, a kilometre of tram or a metro station no, not even with the large loan. Whether they *pay their way* is measured on Poros: **no** as first built (§15), **yes since timetables** — about +€2k a month on Hard as Tourist (§16). That a timetabled bus keeps its riders on Hard is asserted |

### Loans

[sim/economy.js](sim/economy.js). Three slots sized 20/50/100% of starting capital, at Alex's C4 terms (3/6/12 years at 4/6/9%). Each repays in fixed monthly instalments, an ordinary annuity, and can be repaid early. The finance panel shows each slot's offer, or what is owed, the instalment and the years left.

Decisions worth not relitigating:

1. **Borrowing is allowed with a negative balance.** That is when a loan is most needed, and on Hard it is the way out of the game-over countdown. Repaying early needs the money in hand.
2. **Instalments are charged whatever the balance**, at the end of each month. A debt is owed whether or not there is money for it, which is what makes the large loan a real risk on Hard.
3. **No instalment at the end of the month the loan was taken.** Borrowing on the 29th should not cost a payment on the 30th.
4. **No penalty for repaying early**: the outstanding principal is all that is owed.
5. **Creative has no loans** (its money has no end), as the spec says.

### The finance panel adds up

The panel used to list five categories and a net that included construction it did not show. Every category is now listed — tickets, intercity tickets, advertising, subsidy, running, maintenance, construction and loans — and refunds are booked against construction, so **the rows always sum to the change in the balance**. A test checks it to the cent across a month with a loan, a refund and a purchase. Taking a loan therefore shows as income that month, which answers "why did my balance jump?" on the panel.

The **fare slider** (0.5×–2×) sits in the panel and shows the fare and the demand factor it implies. It re-prices demand on the next tick.

### Fixed on the way — panel buttons could lose clicks

The line, stop and track panels were **rebuilt from scratch every tick**, so a button was replaced between the mouse press and its release and the click could simply vanish: +/− on a line, Delete, and a stop being renamed lost the player's typing. Every earlier test drove those panels through the model, never by clicking, so nothing caught it; the new intercity toggle could not be clicked at all, which is what exposed it. The panel now rewrites only the text that changed and rebuilds only when its structure or the selected object changes ([ui/panels.js](ui/panels.js) `patch`). The browser suite presses + three times for real with the sim at 4×, and **fails without the fix** (checked by forcing the old behaviour back in).

### Known gaps

- **The finance panel is one panel**, not separate Finances and Loans panels as the spec lists them. Three loans fit; it scrolls on a short screen.
- **Hard's countdown says nothing about loans.** A player in the red may not think to borrow.

---

## 12. Four questions after Kiato — Oct 15 2026

Alex's questions after the Kiato trial, answered with measurements. Two need his decision (marked **Decide**).

### 1. Why Kiato has 45 buildings when Lefkada has thousands

**It is OSM, not the importer.** Asked directly, Overpass has exactly 45 `way["building"]` and no building relations in Kiato's 5 km box, and the import got all 45.

**What "Lefkada" means here — measured in boxes, not as a place name.** Every Lefkada figure below is labelled with its box. The first answer to this question compared Kiato against *Lefkada town* only, and gave the town's population against a box that also holds villages; Alex caught the mix-up, and it is corrected here.

| 5 km box unless stated | buildings | from the 2022 bulk import | residential roads |
| --- | --- | --- | --- |
| Kiato | 45 | 0 | 446 |
| Lefkada town | 4,856 | 3,941 (81%) | 423 |
| Lefkada island (bbox 20.54–20.73 E, 38.56–38.86 N) | 9,243 | 6,051 (65%) | 1,558 |
| rural Lefkada — Karya | **93** | 0 | 122 |
| rural Lefkada — west coast, Agios Nikitas to Kalamitsi | **280** | 0 | 45 |
| Nidri | 322 | 63 (20%) | 143 |
| Vasiliki | 131 | 0 | 69 |

**Only Lefkada *town* is well mapped; rural Lefkada is as sparse as Kiato.** Over half the island's buildings are in the town box, and four out of five of those came from one bulk import.

**The town's buildings were imported, not hand-mapped.** In a 3.5 × 3.3 km box over the town centre, 3,096 of 3,974 buildings (78%) were created by one account, *Cascafico*, in 2022, and 96% are still at version 1. That account's changesets over Lefkada include three of 10,000, 10,000 and 629 changes on 26 May 2022, and one of 4,793 on 14 June 2022, all commented **"buildings supervised import"** with source **Microsoft GlobalMLBuildingFootprints** and Maxar imagery. The OSM wiki's import page for that dataset names Lefkada and Preveza as its quality-test areas, and records no wider Greek import. So Lefkada town is the exception, and **most of Greece outside the cities is probably like Kiato and rural Lefkada**: roads well mapped, buildings barely.

This matters because buildings are the whole population model. Residents are floor area ÷ 40 m², so a region without buildings has no residents and no demand.

### 2. What we can do about it — *decided Oct 16: see §13*

The spec says "No fallback for areas with poor building coverage: OSM is good enough." Kiato shows that is not true for much of Greece. Measured with [tools/probe-overture-buildings.js](tools/probe-overture-buildings.js):

| 5 km box | buildings | residents by our model | real population |
| --- | --- | --- | --- |
| Kiato, OSM | 45 | 1,336 | ~11,100 by OSM `place` tags (Kiato 9,907, Kato Dimini 1,198, Kokkinia 44) |
| Kiato, OSM + Overture's Microsoft footprints | 6,926 | **~53,900** | same |
| Lefkada town, OSM | 4,838 | **~36,000** | ~9,300–11,000: the town alone was 9,253 at the 2021 census, and the box adds a few villages; the municipal unit, larger than the box, was 13,540 |

**Overture Maps fills the gap.** Its buildings theme merges OSM with Microsoft's and Google's ML footprints (OSM wins where both exist). It is published as one PMTiles archive on public S3 that answers range requests with `Access-Control-Allow-Origin: *`. A browser can therefore read just the tiles over a region with no key and no server: 13 tiles, 54 requests, about 2 MB for Kiato. It is ODbL, the same as OSM, and needs "Overture Maps Foundation" in the attribution line. The release path changes; the latest is named in `https://stac.overturemaps.org/catalog.json`.

**But footprints alone overshoot about 4×, and a fully mapped Lefkada town overshoots about 3.3–3.9×.** ML footprints carry no category, levels or height, so every one counts as a 2-level home. That includes farm sheds and greenhouses: 23% are under 40 m², and the median is 113 m². And the 40 m² × 2 levels calibration was made on central Athens apartment blocks. In a Greek town, holiday homes, storage and farm buildings are counted as homes too. **Getting *where* people live right does not get *how many* right. That needs a total.**

The options, cheapest first:

| | what | effort | changes the spec? |
| --- | --- | --- | --- |
| **A** | Read OSM `place` nodes' `population` in the main query (no extra request), and scale residents to the sum of the places inside the box. The scaling mechanism already exists for Nominatim's figure. **Caveats, measured:** the tags can be a census out of date (Lefkada town is tagged 8,673; the 2021 census says 9,253); most villages carry no tag at all (none of rural Lefkada's do); and a place near the box edge brings its whole population with it. "Plausible, not accurate" covers the first; the other two need a rule — for instance, scale only the cells near tagged places and leave the rest at the building estimate. | small | no — the spec already allows a population total |
| **B** | Warn on the new-game screen when buildings are sparse for the road network. Kiato has 0.1 buildings per residential road; Lefkada has 11. | small | no |
| **C** | Where OSM has no buildings, take Overture's ML footprints as unclassified homes (default levels, residential). They give *where*; A gives *how many*. Categories and attraction still come from OSM. | a session: PMTiles reader, MVT decode (both already prototyped), clipped-polygon handling | yes — it adds a fallback the spec rules out, and a second data source |
| **D** | The spec's "typed by the player" population field, never built. | small | no |

**Recommendation: A and B now, C as its own task if Alex wants it.** A alone fixes the *count* wherever places are tagged, including Lefkada town's overshoot. With C as well, the *distribution* is right in unmapped places too. Without C, Kiato's 11,000 people would all live in its 45 mapped buildings. C also brings back the tile machinery Phase R decided against for buildings. The objection then was that tiles lack building categories, which does not apply to a gap-filler, but the clipped-at-tile-edge geometry objection still does.

### 3. What "motorway crossing" means, exactly

**There is never contact with the motorway.** Precisely, as built:

- **Which roads:** `motorway`, `motorway_link`, `trunk`, `trunk_link` (`BUILD.GRADE_SEPARATED_ROADS`). A dual carriageway is two OSM ways, so two crossings.
- **When it applies:** wherever the track's centreline crosses the road's centreline, **unless OSM tags that stretch of road `bridge` or `tunnel`**. Then the road is already in the air or underground there, and the track passes under or over it at whatever height the grade rule chooses, with no check. This is the real-world "the motorway goes over the railway" case, and it is common: where an existing motorway meets an existing railway, OSM almost always has the motorway on a bridge.
- **What happens otherwise:** the motorway is treated as being on the ground (OSM carries no road heights, so its height is the terrain's at the crossing point). The two track samples either side of it are pinned **at least 7 m above** it, an overbridge, or **at least 8 m below**, an underpass, whichever is nearer the profile the track would have had. The smoothing then builds the ramps. Those samples are forced to `bridge` or `tunnel` and priced at that rate. The road is never modified, and there is never a level crossing with a motorway.
- **So an "underpass" is the railway dropping into a short cut-and-cover tunnel under a road that stays where it is.** In real life the cheaper and more common build is the reverse: the railway stays level and the road is lifted onto a bridge over it. We cannot model that, because we never touch roads. The effect is cost: an underpass is priced as track tunnel (€120M/km for train), so a 60 m one is about €7M plus its ramps — in the plausible range for a road-over-rail bridge, by luck more than design.
- **Known approximations.** A motorway on an untagged embankment or cutting is a few metres off, because its height is taken from the terrain. The clearance is enforced at the samples either side of the centreline, not across the full 24 m corridor; at 2.5% the track moves 0.3 m over 12 m, which doesn't matter.
- **Trams are exempt from all of this**, including motorways: the spec lets off-road tram segments cross roads at grade "as real trams do", and the code never checks a dragged tram against roads at all. A tram can be dragged across a motorway at grade. Probably not what the spec meant — worth a line from Alex.

### 4. Shared stops — done, with one question — **Decide**

**One stop serving several lines already worked in the model and in routing**; only the gesture was missing. A stop holds a list of lines. Clicking an existing stop while drawing reuses it. Passenger routing is built on (stop, line, direction) platforms joined through each stop, so a shared stop is a junction: a passenger alights from one line and boards another there, with no walk. `tests/phase2.js` now asserts all of it: a second line started at an existing stop shares it, the stop lists both lines, no second stop is built on the spot, and a route between the two lines' far ends changes at that stop.

**What was broken was the click.** "A click on a stop selects it" ran before every tool, so:

- **New line could not start at an existing stop.** It now does. A stop of the same mode is shared. A stop of another mode can't be shared (a stop has one mode), so the new line gets its own stop beside it, which forms an interchange.
- **Bulldoze could not remove a stop by clicking it.** It selected it instead. A Phase 2 bug, never caught because no test clicked it.
- **Extend line could never start.** It picks its line by a click on a stop, which was always swallowed as a selection. Once reachable, it had a second bug: the picking click also tried to add the picked stop to its own line.

Selecting is now Edit stops' job alone. That departs from the spec's "clicking any game object selects it", on Alex's instruction that lines share stops. The browser suite drives all four tools through real clicks.

**Decided Oct 16 — every change pays the penalty, implemented in §13.** The question as it was put: Changing lines *at the same stop* costs a passenger the expected wait (half the headway) and nothing more. Changing between two *nearby* stops costs the walk **plus the spec's 5-minute transfer penalty**. HANDOFF decision 14 says "only an actual change of vehicle is penalised", but a same-stop change of vehicle isn't. Either is defensible: a cross-platform change really is easier than a walk. But it is a gameplay choice. It decides whether players funnel lines through shared stops, and the code and its documentation disagree. Options: keep it and correct decision 14's wording, or add the penalty to every change of line.

**Not done:** one stop shared by two *modes* (a bus and a tram at one platform, or metro and train at one station). A stop has exactly one mode, which sets its price, size, drawing and catchment; sharing across modes is a model change. Cross-mode transfers go through an interchange, with the walk and the penalty.

---

## 13. Buildings from Overture, and population by profile — Oct 16 2026

Alex's decisions on §12.2, implemented:

1. **Fill in unmapped buildings from open ML footprints.** This changes the spec's "no fallback for areas with poor building coverage".
2. **Let the seasonal profile decide how many people the buildings hold**, with multipliers built from published urban vs rural figures, not tuned to our case studies.
3. **Apply the seasonal curve to population, not trip generation.**
4. **Flip the seasons by hemisphere automatically**, and **offer Tourist a summer or winter peak.**

### Building data: which open sources exist

- **Google Open Buildings** covers only Africa, South and Southeast Asia and Latin America — not Europe, not Greece.
- **Microsoft's ML footprints** cover Greece (6M added in 2025).
- **Overture Maps' buildings theme** merges OSM, Microsoft and Google (OSM wins where both exist), so one source gives whichever exists anywhere. It is ODbL, like OSM.

**[data/overture.js](data/overture.js)** reads it during the import. It finds the current release from Overture's STAC catalog (CORS-open), then reads the buildings PMTiles archive on public S3 by range request, keyless. Rules:

- **Only tiles where OSM looks unmapped are fetched**: under `OVERTURE.MAPPED_BUILDINGS_PER_ROAD_KM` (15) OSM buildings per km of road in the z14 tile. Measured: Kiato's tiles run 0–2.9. A tile with no road is skipped (open country or sea).
- **Only non-OSM footprints are kept.** OSM's own buildings still come from Overpass with their tags, which attraction needs. ML footprints arrive as plain `building=yes`, homes to the population model.
- **Each piece is clipped to its own tile**, so a building straddling two tiles has its floor area counted once.
- **A failure never fails the import.** It falls back to OSM only, the progress bar says so, and `meta.buildingSources.overtureError` records why.
- **The footer credits Overture and Microsoft** for any region that used them.

PMTiles and MVT are read directly, no libraries. The MVT decoder moved from `tools/` to [data/mvt.js](data/mvt.js) and now runs on a plain `Uint8Array`, so the worker and Node share it.

Measured through the real import worker, three live imports with [tools/import-region.js](tools/import-region.js):

| 5 km box | OSM buildings | gap-filled | tiles fetched | building-derived residents |
| --- | --- | --- | --- | --- |
| Kiato | 45 | **7,000** | 13 (about 10 s) | 49,412 |
| Lefkada town | 4,858 | 74 | 7 | 33,456 |
| central Athens | 51,862 | 0 | **0** | 503,512 (502,376 before: OSM drift) |

### Population by profile

`POPULATION.PROFILE_HOUSING` in [config.js](config.js) scales the building-derived count per profile, relative to Athens (Urban = 1, the calibration). **No published "people per building, urban vs rural" average exists.** Household size alone runs from 2 to 9 across countries (UN DESA). So each profile is the product of four parts, each from the nearest published figure, or **named as an assumption** where there is none:

| part | Countryside | Tourist | source |
| --- | --- | --- | --- |
| floor space per person | 0.85 | 0.9 | EU rooms per person 1.5 cities vs 1.7 rural; China 38.6 vs 48.9 m² |
| homes lived in | 0.92 | 0.62 | Lithuania 2021 census, 80% rural vs 86.5% urban; Greece 2021, 34.5% unoccupied nationally (Tourist is an **assumption** scaled from it) |
| storeys where unknown | 0.75 | 1 | **assumption**: rural houses ~1.5 storeys against the calibrated 2 |
| footprints that are homes | 0.6 | 0.8 | **assumption**: barns, sheds, greenhouses; studies say only that unadjusted rural models overestimate |
| **product** | **0.352** | **0.446** permanent | |

University keeps Urban's 1: a university town is a town of flats, and its curve empties it in summer. For Tourist, `lowSeasonIsPermanent` makes the curve's quietest month equal the permanent population, so every other month adds visitors on top.

**Checked against the case studies afterwards, not tuned to them:**

| place, profile | quietest month | real year-round | building count alone |
| --- | --- | --- | --- |
| Athens, Urban | 503,512 (January) | ~500,000 | same — the calibration |
| Kiato, Countryside | 15,649 | ~11,000–12,000 (OSM tags 11,149, plus untagged villages) | 49,412 |
| Lefkada town, Tourist | 14,935 | ~9,300–11,000 (2021 census, town 9,253) | 33,456 |

**Both towns land about 1.4–1.6× over, from 3–4× before. Alex, Oct 16: accepted — "we will never get more exact than this, and we don't have to."** Leave it. If it ever needs revisiting, the two assumptions (storeys, homes share) are the parts to look at, with published figures rather than by fitting these towns.

**The profile is now the player's statement about the place.** Kiato as Urban holds 49,000 people and starts with €24.7M (Normal); as Countryside, 15,600 and €8.7M. A real total from Nominatim (`meta.populationScaled`) still wins over the profile.

### Seasons on people, and the calendar

- **The curve multiplies residents, not the trip rate** (`DemandModel.scaleResidents`). **More people make more trips**: a tourist town in August produces about five times January's trips, each person travelling at the usual rate. The totals match what the old model gave (there the curve multiplied the trip rate). The difference is that the people themselves are now counted: catchments, the heat map and everything else that counts people swell and shrink with the season. Tested: trips and catchments move by exactly the population's ratio.
- **The import's resident grid is never modified**, so a cached region can be replayed under another profile without re-importing.
- **Dot size and starting capital use the year-round baseline** (`baselineResidents`), not the raw building count.
- **The seasons flip south of the equator automatically**, and **Tourist has a Summer peak / Winter peak switch** on the new-game screen, offered with Tourist on every difficulty. Alex's "depending on difficulty" was read as "depending on the destination". The two flips combine, so a southern winter resort peaks in July.
- The spec's curves are unchanged. As population curves they say Athens empties by 25% in August (Urban 0.75 — the Greek August exodus is real), and a tourist town holds 5× its permanent population at the August peak (Tourist 2.5 against 0.5).

### Known gaps

- **The coastline is visibly stepped at street zoom.** The sea is traced from the 30 m elevation grid. **Won't fix (Alex, Oct 16):** cosmetic, and tokens belong to more pressing things. Do not spend a session on it.
- **ML footprints newer than Overture's OSM snapshot are not de-duplicated** against OSM buildings mapped since then. Overture releases monthly, so the overlap is small.
- **The Overture archive is 181 GB and release-named.** We always read the latest. If Overture stops publishing PMTiles, the import silently falls back to OSM only and says so.

### Every change of vehicle pays the transfer penalty — Oct 16 2026

Alex's decision on §12.4: people often prefer a slightly longer trip to one with a change, however quick the change is, so a change of line at the **same** stop pays the 5-minute penalty too. Before, it cost only the wait, because the penalty sat on the walk between stops.

[sim/routing.js](sim/routing.js) now gives every stop two nodes. **Start** is where a trip begins; boarding from it costs the expected wait. **Arrived** is reached by getting off; boarding from it costs the wait plus `ROUTING.TRANSFER_PENALTY_S`. Walking between interchange stops goes arrived → arrived at walking speed, and the penalty is charged on the next boarding, so walking on to the final destination after getting off costs only the walk. Changing direction on the same line counts as a change too. `tests/phase2.js` checks that a shared-stop route costs exactly two waits, the rides and one penalty, and fails 300 s short without the fix.

---

## 14. Phase 6 — existing OSM rail. Done.

All three of the spec's bullets: the discount, ready-made track, and intercity service. Asserted in [tests/phase6.js](tests/phase6.js) marked `ACCEPTANCE:`, and through real clicks in [tests/browser.js](tests/browser.js).

| Acceptance criterion (from the spec's Phase 6 bullets) | Where it is proved |
| --- | --- |
| the player's own track is 25% cheaper to keep where the region has OSM rail | `maintenancePerYear`, with and without |
| existing rail is train track with no construction cost | the fixture's Coast Line, length checked against the imported rail graph |
| its tunnels and bridges come from OSM tags, not the grade rule | a synthetic railway with a tagged tunnel and bridge over the fixture's terrain |
| the player can join it with their own track, and run train or metro lines on it | junctions for train and metro track; a train line and a metro line placed by clicking real stations |
| the player never pays maintenance on it | maintenance with lines on it equals the stations' upkeep alone |
| intercity calls pay a ticket per passenger aboard, and drop some of them into the network | one call, its tickets to the cent, and its arrivals on the platform bound for the connected station |

### How it works

- **[build/osm-rail.js](build/osm-rail.js)** converts the imported rail graph into the same `Track` objects the player builds, so station snapping, line routing, junctions and the profile strip work on it unchanged. The graph is cut into chains at every switch, crossing and dead end; one chain is one track, and each switch becomes a junction. Each chain is resampled every 20 m without cutting any OSM vertex.
- **Heights**: the terrain at grade, and a straight run from portal to portal across a tunnel or bridge. Only seen in the profile strip and as the height new track meets at a junction.
- **Ids are `osm0`, `osm1`, … in an order fixed by the region alone**, so a station's stored sample key (`osm3:41`) means the same place after a reload. Existing rail is never written into a save; it is rebuilt from the region.
- **Stations on existing rail take the real station's name** when an OSM station or halt is within 150 m (`BUILD.OSM_STATION_NAME_M`). That only helps where a real station exists — Kiato has one — so §10's "Station" fallback is still what most new stations in the countryside get.
- **It cannot be bulldozed**, and its panel says so. The overlay does not draw it (the base map already does) except to highlight it when selected.

### Intercity service

[sim/intercity.js](sim/intercity.js). A station on existing rail has an **Intercity service** toggle in its panel; the map marks it with a dashed outer ring. While it is on, an NPC train calls every `INTERCITY.INTERVAL_SIM_S` of **sim** time. Each call:

- pays one ticket per passenger aboard (`PASSENGERS_PER_CALL`), at the player's fare, under its own finance row. Like every daily total it is scaled by `CLOCK.DAILY_SCALE`;
- drops `DROP_FRACTION` of them onto the platform as new trips, sent to the stations the network connects, weighted like ordinary demand (attraction × distance). The split is **by largest remainder, not random**, so a call always lands the same way. A fraction of a dot carries to the next call.

**Watch this in play — probably too generous.** At the shipped values (a call every 30 sim minutes, 300 aboard) one station earns about **€16k a day, ~€5.9M a year**, and the toggle is free. A bus line costs €250k a year per bus to run. All three values are in the tuning panel's *Intercity* group. These three numbers were in config.js from Phase 0, unsourced; the spec names none.

### Known gaps

- **New track drawn across existing rail** is neither a junction nor a crossing (the same gap as player track, §10).
- **No intercity train is drawn.** Its arrivals simply appear on the platform.
- **Intercity calls continue at a station no line serves**, paying tickets with nowhere for the arrivals to go. The spec does not say otherwise; worth a decision if it is exploited.

---

## 15. Play-testing: the tuning panel, and what a real island showed — Oct 16 2026

### The tuning panel (` key)

Alex's request: passenger behaviour needs frequent tweaking during play-tests, so give it sliders, and hand back the values once they feel right.

- **` opens it.** Sliders for demand (trips per resident, distance decay, walk floor, fare elasticity, catchments), routing (transfer penalty, expected wait, walking speed, interchange distance), patience and satisfaction (patience for the difficulty in play, grace, give-up penalty, floor, recovery), money (base fare, advertising, subsidy share, running cost per mode) and intercity.
- **Changes apply live.** Each value is written straight into the config object, and the cache it feeds (demand table, routes, interchanges) is thrown away; the effect shows within a tick. A "Right now" block shows expected trips per day, waiting and on-board counts, give-ups and satisfaction, so the effect can be read without waiting for the month's books.
- **Changes survive a reload** (localStorage), and a red **"Tuning: N changed"** badge sits in the save strip while any are active, so they are never forgotten. ↺ resets one value, *Reset all* resets everything.
- **Copy changes** puts the hand-back list on the clipboard and in a box under the button, in the form `DEMAND.TRIPS_PER_RESIDENT: 0.4 → 0.8`. **To apply a list Alex hands over:** write each new value into [config.js](config.js) at that path, with a note on why, and update any test that pins the old value.
- The logic is [sim/tuning.js](sim/tuning.js) (DOM-free, tested in Node); the panel is [ui/tuning.js](ui/tuning.js). Adding a tunable is one line in `TUNABLES` and one label in `STRINGS.tuning.labels`.

### What Hard on a small island does — measured, not met

Phase 5's criterion is "Hard on a small island supports a bus line or two and little more". To test it, **Poros** was imported once ([tools/import-region.js](tools/import-region.js) `23.47 37.505 6`): 3,688 buildings (399 from OSM, 3,297 filled in from Overture), Poros town and Galatas across the strait. Then [tools/probe-balance.js](tools/probe-balance.js) played a year with two 5-stop bus lines, one bus each, through the densest streets. It is offline and runs in about a second; rerun it after any tuning.

Poros as **Tourist** (16,217 year-round residents by the model; capital €1.6M on Hard), two lines reaching 55% coverage, a month on average. **Measured before timetables (§16), which changed the answer:**

| | tickets | subsidy | running | **net** | passengers who gave up |
| --- | --- | --- | --- | --- | --- |
| Hard, as shipped | €11k | €11k | −€42k | **−€20k** | **331 of 605** |
| Normal | €14k | €16k | −€42k | −€12k | 285 of 628 |
| Easy | €22k | €20k | −€42k | €0 | 186 of 720 |
| Hard, bus running cost halved to €125k | €11k | €6k | −€21k | −€5k | 331 of 605 |
| Hard, subsidy share 100% | €11k | €23k | −€42k | −€8k | 331 of 605 |
| **Hard, patience 12 → 30 min** | **€32k** | €11k | −€42k | **+€2k** | **0 of 813** |

On Hard as shipped, August is the best month at −€11k and November the worst at −€25k. Building both lines leaves €612k, so the network runs about two and a half years before the balance goes negative, and Hard's 12-month countdown ends it about a year after that. **So Hard can afford a bus line or two, but cannot sustain them.** Poros as **Countryside** (6,392 people, €1.0M) affords one line with one bus, sees 31 passengers all year, and loses €15k a month.

**Patience is the dominant lever, by far.** One bus on a 4–5 km line comes every ~30 minutes, and Hard's passengers give up after 12. So about half of all riders give up, and every give-up also cuts that route's future demand through satisfaction. Halving running costs or doubling the subsidy does less than letting people wait.

**Real people on a half-hourly rural bus check the timetable** rather than turning up at random. Alex agreed, and it is built (§16).

**Two smaller things the measurement showed:**

- ~~**A small island looks empty.**~~ *Overstated, corrected after measuring:* Poros spawns about two dots per *calendar* day (each standing for 324 trips a real day), but dots linger while waiting and riding, so **6 are on screen on average, 17 at most, and the screen is empty 2% of the time** (Easy: 10, 29, 1%). Sparse, not empty.
- **Riders per day jumps in steps of 324** on a small network, because one dot in the day's sample is 324 people a day. The line panel figure is honest but coarse there.


---

## 16. What a dot means, timetables, and flows — Oct 16 2026 (night)

Alex's decisions after §15, all six of the proposal built:

1. **Capacity is counted in people.** It was counted in dots — an oversight, not a choice: the spec gives capacity in passengers and one dot as ten of them. In a city of 10-person dots a 50-seat bus carried 500 people. A vehicle now has `seats = capacity ÷ people per dot` ([sim/vehicles.js](sim/vehicles.js)). No effect where a dot is one person, which is everywhere the game has been played so far.
2. **One person per dot in small places, always. The dot only grows to cap what is drawn** (Alex: "Small places will have 1 person 1 dot. Always about X dots should only exist as a rule to LIMIT the dots rendered in larger places"; X = 200). Fractional dots were considered and rejected.
3. **A legend** bottom left: "● = N people", and a line saying which clock is which.
4. **Timetables**: past a 10-minute headway passengers time their arrival.
5. **A Flows layer** (toolbar *Flows*): the demand under the dots.
6. **Which clock each number uses**: tooltips on the live and per-day figures, and the legend.

### The dot rule

`people per dot = ⌈ year-round residents × 3 per 1,000 ÷ 200 ⌉`, between 1 and 50 ([config.js](config.js) `passengersPerDot`, `DEMAND.VISIBLE_DOTS_*`).

- **3 per 1,000 is measured**, not guessed. By Little's law the dots on screen are trips per second × how long each trip lasts ÷ dot size, so the one unknown is dots per resident for a well-built network at one person per dot. Bus grids over the fixture town: **2.8 per 1,000 covering 72% of residents** (43 stops, 8,875 trips a day), **5.4 covering 100%** (131 stops, 16,331 trips a day — 39% of residents, almost the whole 0.4-trip rate). A compact island runs lower: Poros fully gridded showed 1.6, because trips are short. So the cap is "about 200" for a well-built network; one covering every last resident can reach ~2×.
- **Year-round population, not the busiest month.** It was first written for the busiest month, and that gave Lefkada town as Tourist (~75,000 in August by the model, ~10,000 real people) two people per dot — exactly what a small place must not get. A Tourist August now runs over 200 instead, which "about 200" allows.
- **Results:** the fixture town, Poros, Kiato and Lefkada town stay at 1 (tested for Lefkada). Anything under ~67,000 year-round residents is 1. Central Athens (500k) is 8, up from 5. The cap of 50 is a bus: a dot must fit in the smallest vehicle.
- **Fixed for the whole game, and kept across a rule change:** a save carries its dot size, and `Game.setDotSize` applies it to the game, the demand model, the economy and every vehicle at once. Before, a reload recomputed it from the rule — harmless only while the rule never changed.
- `VISIBLE_DOTS_TARGET` is not in the tuning panel: it can only take effect in a new game.

### Timetables

[sim/routing.js](sim/routing.js), [sim/passengers.js](sim/passengers.js) `patienceFor`, threshold `ROUTING.TIMETABLE_HEADWAY_S` (10 min, in the tuning panel).

- **Route choice** counts the wait as `BOARDING_WAIT_FRACTION × min(headway, threshold)`: an infrequent line costs at most what a 10-minute line does — still a little worse than a frequent one, never a half-hour stand at the stop. Continuous at the threshold.
- **Patience** for a passenger waiting for a timetabled line is `max(difficulty patience, headway + grace)`. The stop's waiting ring uses the same, so it does not fill red for people who are fine.
- Dots still appear at random times and wait on screen; only their patience and the route cost changed. Making them appear just before the departure would be truer to life and a bigger change.
- **Asserted:** on Hard, one bus on a long line loses riders with the rule off and none with it on.

**Poros re-measured with it** (`tools/probe-balance.js`, two lines, one bus each, a month on average):

| | tickets | subsidy | running | net | gave up |
| --- | --- | --- | --- | --- | --- |
| Hard, Tourist | €32k | €11k | −€42k | **+€2k** | 0 of 813 |
| Normal, Tourist | €33k | €16k | −€42k | +€7k | 0 of 813 |
| Easy, Tourist | €33k | €20k | −€42k | +€11k | 0 of 813 |
| Hard, Countryside | €1k | €6k | −€21k | −€14k | 0 of 32 |

Hard as Tourist now runs at a loss from November to April (−€8k to −€15k a month) and makes it back in summer (+€48k in August), ending the year ahead. That is the criterion. **Countryside Poros (6,400 people) still cannot keep even one bus**, and only one is affordable; whether Countryside should be that harsh is a play-test question.

### Flows

`DemandModel.flows()` merges each pair of stops' demand both ways into people a day, busiest first, cached until the table rebuilds. `flowsPainter` draws the busiest 300 as arcs under the lines, width by the square root of the flow, bowed to one side so flows sharing a corridor fan apart. The flows add up exactly to the tuning panel's expected trips a day. Rare routes that hardly ever have a dot on them still show — the thing Alex wanted dots to do, which dots cannot do honestly (one Poros route in two produces a dot only every ~50 calendar days).

### The two clocks, as other games handle them

For the record, since Alex asked: every game in the genre has two tiers of time. **Transport Fever 2** is closest to ours and more extreme — a calendar day lasts 2 seconds by default, every resident is an individual agent, line frequency is shown in real time at normal speed, and lengthening the day scales monthly production and demand to stay balanced (our `DAILY_SCALE`). **Cities: Skylines** compresses one clock (~24 real minutes a day in CS1, ~72 in CS2). **Mini Metro** abstracts time to weekly upgrades and passengers to destination shapes. Sources: [TF2 Simulation Overview](https://wiki.transportfever2.com/doku.php?id=gamemanual%3Asimulationoverview), [TF2 Statistics and Data Layers](https://wiki.transportfever2.com/doku.php?id=gamemanual%3Astatisticsdatalayers), [Mini Metro](https://en.wikipedia.org/wiki/Mini_Metro_(video_game)), RESEARCH.md for CS.

---

## 17. Ferries — groundwork only

Alex: "pave the way for ferries in a very basic way, but don't add anything major." Done:

- `PLAYABLE_MODES` and `PLANNED_MODES` in [config.js](config.js) are the one list of modes; the toolbar and the 1–4 keys read them. Ferry is planned: a disabled toolbar button, as each mode was before its phase.
- `FERRY` in config holds **placeholder, unsourced** figures (a small strait ferry: 250 people, ~15 knots, 3-minute dwell, €6M a boat, €1.2M a year to run, €2M a terminal, 800 m catchment). Ferry is deliberately **not** in `MODES`, so nothing that loops over the playable modes meets it half-built.
- Asserted: the four playable modes, ferry planned and absent from `MODES`, every placeholder present; in the browser, the button is disabled and 5 does nothing.

**The plan, when ferries are built:**

1. **Research the figures**, as Phase 0 did for the other modes, and move ferry into `MODES`, `COSTS`, `DEMAND.CATCHMENT_M`, `RENDER.STOP_RADIUS_PX` and `PLAYABLE_MODES`.
2. **Terminals** snap to a point that is both within `terminalShoreM` of water and on the road network, so passengers can walk to them.
3. **Routing on water**: a path over the sea mask and the OSM water polygons. The height grid already marks the sea (`settleSea`); a grid A* over water cells, smoothed, is the counterpart of `RoadIndex` for roads. OSM's `route=ferry` ways are real crossings and could seed it the way existing rail seeds track (Phase 6) — that needs one more clause in the Overpass query.
4. **Everything else already works for any mode**: lines, vehicles, the demand model, routing with transfers, the economy, intercity-style arrivals for a mainland connection.
5. **The lifeline subsidy** the spec's subsidy rule is modelled on was a ferry subsidy in the first place; ferries are where it should be most generous.

Known gaps for this section: none yet, since nothing is built.

---

## 18. Alex's first play-test — Oct 17 2026

Fourteen items, all done. Asserted in [tests/phase7.js](tests/phase7.js) (`#1`–`#14` in the names) and, for the gestures, in [tests/browser.js](tests/browser.js). Then checked against a fresh real import of **Patras** (6 km at 21.74, 38.25) — the place Alex was playing.

| # | Reported | What it was, and what changed |
| --- | --- | --- |
| 1 | Squares all over the map with contours on; buggy shoreline | Closed contour loops round single 30 m cells, ~85 m diamonds. Loops under `CONTOUR_MIN_LOOP_M` (250 m) are dropped on load, so cached regions are clean too. **The sea now comes from OSM's coastline** ([data/coastline.js](data/coastline.js)) and the height grid is corrected to match it, so the grade rule agrees with the map. Where a region has no usable coastline, the elevation trace is smoothed (Chaikin, two passes) and specks under 4 cells dropped |
| 2 | Heat map flickers while placing a line, paused | It was normalised to the peak of the *unserved* cells, so covering the busiest cell rescaled the whole map. Now normalised to the region's peak |
| 3 | Vehicles don't face their way | The bearing was a maths angle (y up) drawn on a canvas (y down): every vehicle not running due east or west was mirrored. Now projected to a true screen angle, right at any map rotation |
| 4 | A progress bar for the day | Under the date |
| 5 | Bulldoze section by section | Alex chose: a stop goes and its neighbours are joined. A click on a line between stops takes the nearer stop off that line. A line left with one stop goes, with its vehicles and that stop refunded; tram track is settled. Delete line stays on the line panel |
| 6 | An unserved stop shows its demand as satisfied | Only stops on a running line (two stops, a vehicle) cover anyone — for the heat map, the demand and the coverage subsidy. The stop's panel still says what it *would* cover |
| 7 | No demand from buildings away from roads | Over `POPULATION.MAX_ROAD_DISTANCE_M` (100 m) from any road, a building or POI makes no residents and no attraction; it is still drawn and still blocks track. Needs the new import |
| 8 | Undo the last stop | Backspace while drawing, and an Undo button; it gives back that step's cost in full |
| 9 | A Finish line button for touch | Undo / Finish / Cancel appear in the toolbar while a line or track is being drawn |
| 10 | Dragging a stop does nothing | It was never wired. Edit stops: press on a stop and drag; it re-snaps, every line through it re-routes, the difference is settled, and anything unroutable or unaffordable puts it back |
| 11 | Existing rail doesn't work in Patras | Patras's railway is metre gauge, `railway=narrow_gauge`, and only `rail` was imported. Narrow gauge now is; yard tracks and spurs are left out so stations don't land on a siding. **Patras: 345 rail edges, 11 km of track; a train line Αγυιά–Ανθείας builds on it with the real station names** |
| 12 | Buses and trams may skip stops nobody needs | `VEHICLES.SKIP_EMPTY_STOPS`: a bus or tram with nobody getting off and nobody waiting does not dwell. Line ends always dwell; metro and train always stop |
| 13 | Flows per stop | With a stop selected, the Flows layer shows only that stop's flows; its panel lists its five busiest destinations a day |
| 14 | Buses and trams should obey one-way streets | `oneway` is imported (with roundabouts and motorways implied, and `oneway:bus`/`psv`/`tram=no` contraflow); the router obeys it; a line gets its own way back where it differs (`Line.backSegments`), drawn a little thinner. **Patras: 21% of road edges are one-way; 10 of 10 test lines got their own way back, none had to break a rule** |

### Decisions worth not relitigating

1. **`REGION.IMPORT_VERSION` (now 2).** Items 1, 7, 11 and 14 need data the old import did not fetch. A cached region from an older import is fetched again the next time it is chosen on the new-game screen (one import, as normal). Saves keep loading whatever is cached; an old save on a refreshed region could find existing-rail ids shifted if the refresh added rail, which only matters for a station placed on existing rail.
2. **Back segments are stored start-to-end**, like their forward twin, so a vehicle walking segment *k* backwards in direction 1 drives the way back the right way. Vehicles, journey times and passenger routing needed no other change.
3. **When no legal route exists, the line breaks the rule rather than being refused** (`ignoresOneway` on the segment). That happens where a one-way street leads out of the region and the way round is outside it. None in Patras.
4. **Undo refunds in full; Bulldoze refunds half.** Taking back a mis-click should be free.
5. **The heat map's scale is the region's peak, served or not**, so it changes only with the season.
6. **Coastline maths in local metres, land on the left**, walking the boundary clockwise between pieces; a chain that stops in mid-region means bad data, and the import falls back to elevation rather than guess. Islands are holes; a region with islands and no crossing coast is open sea.

### Known gaps

- ~~**Dragging a stop or a segment needs a mouse.**~~ *Fixed the same day, on Alex's word ("hold and drag, like you would with your mouse"):* on a touch screen, hold a finger still on a stop or a line for `INPUT.TOUCH_HOLD_MS` (350 ms), then drag. A swipe that moves sooner pans the map, so lines everywhere do not steal panning; a mouse still picks up at once. Two fingers never drag. The browser suite drives both through real touch events (the DevTools protocol; Playwright itself can only tap).
- **Dots still appear at random times**, even for a timetabled line (§16).
- **The fixture has no coastline**, so the browser suite runs the elevation fallback; the OSM path is covered by synthetic coasts in the logic suite and by Patras.
- **A tram on a one-way street pays for track both ways** where the way back runs elsewhere — right for a tram, which needs rails on both streets.

---

## 19. Names, and keeping vehicles spread — Oct 17 2026

Alex's requests, all in [tests/phase7.js](tests/phase7.js) and, for the panel, [tests/browser.js](tests/browser.js):

- **Lines have names.** By default "first stop to last stop", by the stops' street names; when both ends share a name (a loop, or a line along one road) it is "Name – Bus" (Tram, Metro, Train). Renamed in the line panel; clearing the field, or typing the automatic name back, returns to automatic. `Network.lineLabel`.
- **Stops sharing a street are numbered** in the order they were built — "Ermou 1", "Ermou 2" — within a mode. A stop the player renamed keeps its name and drops out of the numbering. The street name is kept as `stop.name` and the player's as `stop.customName`, so renaming no longer overwrites what the stop was named after. `Network.stopLabel`. Old saves treat their stored name as the street name.
- **Edit stops is now "Line / Stops".** Only the label; the tool id is still `editStops`.
- **Keeping vehicles evenly spread** (`line.keepSpacing`, on by default, all modes). A vehicle that has caught up with the one ahead (closer than 90% of the even gap, by time round the cycle) waits at the stop it has just reached for half the shortfall, at most 90 s — even at a stop it would otherwise skip. `holdForSpacing` in [sim/vehicles.js](sim/vehicles.js). It only ever holds; a bus cannot make up time it does not have.
- **Skip empty stops is per line** (`line.skipEmptyStops`), on by default for buses and trams, not offered for metro and train.

**A spacing bug found on the way, there since Phase 2:** on an open line, `respaceVehicles` spread vehicles over the *outbound half* of the cycle only, so two buses left the first stop a quarter and three quarters of the cycle apart instead of half and half — built-in bunching from the moment a bus was added. Vehicles are now placed by phase round the whole out-and-back cycle (`cycleOf`, `phaseOf`), half of them starting on the way back.

**And one in the hold itself:** vehicles that reach a stop in the same tick all stand exactly on it, so a fully merged bunch had no vehicle "behind" another and was never split. Level vehicles now count the one listed first as ahead. The test that caught it bunches three buses on a line nobody rides and checks they spread out with the rule on and stay bunched with it off.

---

## 20. Saving that works, and save files that carry the map — Oct 17 2026

Alex: "it didn't store my network and money … we need a way to save both the region locally to prevent needless re-imports and the network, so people can play again even on another browser/device if they have the file."

**The bug: Load never loaded anything, since Phase 2.** `startGame(result.game.region)` was handed only the loaded game's region and built a fresh `Game` on it, so Load and Import file always showed an empty network and the starting money. The logic suite proved `Game.fromJSON` restores everything; no test ever clicked Load. `startGame(region, loaded)` now takes the loaded game, and the browser suite clicks Save, changes the network, clicks Load and compares.

**A second bug behind it:** every load built a new game screen without stopping the old one, so the old frame loop, keyboard handler and monthly autosave kept running — Space paused twice (doing nothing), and the abandoned game could overwrite the autosave. `startGame` now shuts the previous screen down (an `AbortController` for the listeners, the frame loop stops, the map is removed).

**What saves now:**

- **In the browser**: one save and one autosave **per region** (`game:<key>`, `auto:<key>`) — before, one slot was shared by every region. A save holds the game and refers to the region by key; saving puts the region in the cache if it is not there (the test region never was, so its saves could not load). Load in the game takes the region's newest save.
- **The start screen** lists saves under **Continue** (region, in-game date, balance, autosave or not) and has **Open save file**, so a new device can start from a file before importing anything.
- **Save to file** (was "Export file") writes **one file with the game and its whole region**, `format: 'otomig-save', version: 2`, gzip-compressed where the browser can (`CompressionStream`) as `.otomig` — about a seventh of the JSON. **Opening it** rebuilds the game on the file's own region, exactly as saved, and caches that region if the browser has none under its key; one already cached is left alone, since it may be a newer import and other saves may rely on it. Old game-only files (`version: 1`) still open where their region is cached, and say what to do where it is not.

Asserted in the logic suite (a gzipped file round-trips with no storage at all: network, money, loans, calendar, line names) and in the browser: Save then Load restores; after a load Space pauses once; a downloaded file opens in a **fresh browser context with nothing stored**, with the network and money intact and its map cached there; and that browser's start screen then offers Continue.

**Known gaps:** saves have no names of their own and there is no way to delete one; a region refreshed by a newer import (`REGION.IMPORT_VERSION`) under the same key is what later in-browser saves load against — a save file is the way to keep a game on its exact original map.

---

## 21. Selected lines, red tools, and stops on divided roads — Oct 17 2026

**The stop pairs below are superseded by §30.** The selected-line and red-tool changes stand.

- **A selected line stands out**: every other line fades to `RENDER.UNSELECTED_LINE_ALPHA` (0.3) and the selected one is drawn last, over a dark halo (`COLORS.selectionHalo`).
- **The tools group selects in red** (New line, Extend line, Line / Stops, Build track, Bulldoze), so the toolbar's three groups — modes, tools, layers — read apart. Modes and layers stay ink.
- **Stops on divided roads are pairs.** Alex: stops and pathfinding went odd where a road splits into two one-way carriageways, and building a line along one meant drawing a ring. The cause: a stop snapped to ONE node, on one carriageway, so the line going the other way could only reach it by driving on to a turning and coming back down the same carriageway. Real stops on such roads face each other across the median, so now a bus or tram stop on a one-way carriageway gets a **twin** — the nearest node within `BUILD.STOP_PAIR_M` (45 m) on a carriageway running exactly the other way, *across* the road rather than along it — and each direction calls at the side running its way (`Network.stopNodeFor`, `RoadIndex.twinOf`). At a line's end the two directions use opposite sides too: the bus arrives on one carriageway and leaves from the other, jumping the 20–40 m across the median during its layover in place of the U-turn. The pair is drawn as a small second circle joined across the road.

**Measured on Patras** (12 test lines along divided roads, way back ÷ way there): **median 1.12, worst 2.07** with pairs, against **median 5.67, worst 19.08** without. A first version that left line ends unpaired and matched twins loosely managed only a median of 3.2 and one case of 30.7 — a one-way side street taken for the other carriageway — which is why the across-the-road and exactly-opposite tests are there. A synthetic boulevard in [tests/phase7.js](tests/phase7.js) asserts the twin, which side each direction uses, and a way back under half as long as without.

**Not done:** a turn round through a real gap in the median at a line's end; the jump stands in for it.

---

## 22. The OTOMIG look — Oct 17 2026

- **The logo** (designed by Alex's girlfriend, `ui/Otoming.png`, 3508×2480 with a transparent background) is cropped to `ui/logo.png` (1100 px wide) and is the new-game screen's title. Its emblem — the O and the arrows — is the browser-tab icon, `ui/icon.png`.
- **The palette is the logo's**, as CSS tokens in [style.css](style.css): OTOMIG blue `#306499` (`--accent`) for everything the game highlights — the selected tool, the Import button, sliders, Finish line, the tuning panel; the logo's red `#A03B2C` (`--danger`) only for what destroys or warns — Bulldoze, negative money, delete buttons, a refused track (`COLORS.blocked`); its gold `#CDB341` (`--gold`) for the day bar. Land, ink and lines stay the Mini Metro neutrals. Line colours are unchanged.
- **Bulldoze** always wears a faint red outline, turns the logo's red when selected, and reads "Bulldoze /!\" — the one tool that destroys should never be picked up by mistake.
- **The font is Sansation** (Bernd Montag, SIL Open Font License), regular and bold, Latin, extended Latin and Greek, **served from `vendor/fonts/`** like MapLibre rather than from Google, so the game still works offline. The canvas labels (drag cost, profile strip, level crossings) use it too. The licence is `vendor/fonts/OFL-Sansation.txt`.

---

## 23. Stops are areas; routes keep to main roads; Done and Cancel — Oct 17 2026

**The stop areas below were REVERTED the same day (§24): in play they made routes worse, sending lines to stop points a block away. The Done/Cancel bar and the road-class weighting (now milder) stay.**

Alex, after playing central Athens: the divided highway was "handled beautifully", but bus and tram routes elsewhere zigzagged and looped round blocks near stops. Two causes, both fixed:

1. **A stop was one node.** On Athens's one-way pairs — a street each way, a block apart — the direction that could not pass the stop's node legally drove round the block to reach it, and back. §21's twin only looked 45 m across a median. **A stop is now an area** (`BUILD.STOP_AREA_M`, 110 m; 45 m at a line's ends): for each direction, `Network.planStopNodes` chooses the node every stop is called at, for the whole line at once — a Viterbi pass over each stop's nearest usable nodes (`STOP_AREA_CANDIDATES`, 12; dead ends excluded unless the player put the stop there), each hop costing its weighted route and each metre away from the player's point costing `STOP_MOVE_WEIGHT` (1.5 — it must stay under 2, or the way back still zigzags across to every stop on a one-way pair). Consecutive stops are never served from one node. A repair pass (`repairDoublingBack`) then looks at any stop where the bus would arrive along a street and leave back down it, trying the stop's other nodes with the real routes in and out and charging doubling back at `DOUBLING_BACK_WEIGHT` per metre. This replaces §21's twin; the divided road is simply one case of it. Where a direction calls away from the stop's own point, the overlay draws the small connected circle there.
2. **Routes went by length alone**, so buses cut through residential streets to save fifty metres. **`BUILD.ROAD_CLASS_COST`** weights the routing cost by class (primary 1, secondary 1.05, tertiary 1.15, unclassified 1.35, residential 1.6, living street 3); `shortestPath` minimises it and still reports true length.

**Measured on Patras**, 22 random six-stop lines through the dense centre, against one-point stops routed by length:

| | route ÷ straight line, median | 90th percentile | visible spikes (doubling back >25 m) | drawing a line |
| --- | --- | --- | --- | --- |
| before | 1.83 | 2.70 | 25 of 132 stop calls | ~20–40 ms |
| after | **1.66** | 2.66 | **4 of 132** | ~200–240 ms (about 35 ms a click) |

And along Patras's divided roads, the way back ÷ the way there: median **1.00**, worst 1.33 — against 1.90 and 13.7 without stop areas.

**One behaviour change to know:** a stop placed within 110 m of a clean route is served from that route rather than pulling the line up a side street and straight back; dragging such a stop moves its marker and catchment and where the line calls, but may not change the route. A stop further off (a cul-de-sac, say) is still driven to.

**Done and Cancel.** While a line or track is drawn, a bar floats at the top centre — "Bus line · 3 stops", **↶ Undo**, **✓ Done**, **✕ Cancel** — finger-sized, and off the toolbar. **Cancel now throws the line away**, every step undone and refunded in full; stops it shares with other lines stay. Esc and changing tool still keep what was drawn so far, as in Mini Metro.

**Waiting on Alex's approval before starting** (his instruction): new track joining existing track it crosses (and OSM rail), and a gentle grade check for trams.

---

## 24. Double and single stops, no U-turns, one-way arrows — Oct 17 2026

**§24 to §29 describe line rules that §30 replaced** — kept as the record of what was tried and why. Still current from them: no turning round in the road (now done properly, §30), stops on the road that was clicked (§26), the version bump that made new lines wanted (§28), the one-way arrows on the map.

Alex, after trying §23's stop areas in Athens: "this made it worse" — stops served from points a block away, lines touring the blocks. His simpler rules, built as asked:

- **No turning round in the middle of a road**, for buses and trams, anywhere: a route leaves each stop forwards (`shortestPath`'s `avoidFirst`, carried hop to hop in `rebuildSegments` and `refreshBackSegments`, and through a dragged via). The only exception is a dead end — or a street whose only way out is back the way it came — where no legal path exists; on Patras every remaining doubling back was one of those. A double-stop line still reverses at its two end stops, during the layover.
- **Double stops** (`line.singleSided = false`, the default): the line runs both ways along the same streets, and a stop serves both sides of the road — drawn as two small stops facing each other across it, and passengers board whichever direction suits their trip. On a **one-way** road, a stop is paired with the opposite carriageway only if that runs exactly the other way and lies **directly across within `BUILD.STOP_PAIR_M` (35 m)** — a road with a divider; a parallel street a block away is not paired (`RoadIndex.twinOf`, restored from §21, tightened).
- *(Superseded by §29: single or double is now chosen stop by stop, and there is no automatic loop.)* **Single stops** (`line.singleSided = true`): each stop is on one side, as in Cities: Skylines, and the line runs **one way round as a loop** — closed back to its first stop automatically (`line.autoLoop`), even with two stops, and still extendable while drawing; the player places the stops for each direction. Each stop is drawn on the kerb of the side it serves (`BUILD.RIGHT_HAND_TRAFFIC`). Switching back to double stops reopens a loop that single stops closed; one the player closed stays closed.
- **The switch** is in the drawing bar ("⇄ Double stops" / "→ Single stops", remembered for the next line as `game.singleStopsDefault`) and on the line panel ("Stops: Double / Single"). `Network.setSingleSided` / `Game.setSingleSided`.
- **One-way arrows**: black arrows on every one-way street from zoom 15 (a MapLibre symbol layer, `oneway-arrows`, one arrow per stretch of 25 m or more, decluttered by MapLibre), and drawn again **on top of** bus and tram lines wherever they run along a one-way street, since the lines hide the map beneath.

Removed: §23's `planStopNodes`/Viterbi plan, the doubling-back repair, `STOP_AREA_*`, `STOP_MOVE_WEIGHT`, `DOUBLING_BACK_WEIGHT`. Road-class weighting stays, milder (residential 1.25, living street 2), because strong weights sent lines round blocks to avoid a short side street.

**Known gaps:** a single stop's side follows the line's direction of travel, not where on the road the player clicked; stops are still shared between lines, so a stop used by a double and a single line is drawn both ways. Central Patras is so densely one-way that a double-stop line's way back often takes a different street, which is now visible thanks to the arrows — that is the rules working, not a fault.

---

## 25. A line is one trip up and one trip down, turning round at the ends — Oct 17 2026

Alex pinpointed the remaining fault on a divided road at an interchange in Athens: a two-stop double-stop line turned round via the cloverleaf (good), but after adding stops further along the road, the old end stop still looped round the cloverleaf. In Cities: Skylines the whole route is re-planned as one trip up the road and one down, turning round only beyond the last stop.

Two causes, both fixed:

1. **The middle stop had no twin.** `RoadIndex.flowAt` judged a node by EVERY road at it, so a ramp or a two-way side street joining the carriageway at the stop made it look like no carriageway at all — no twin, and the way back had to loop round the interchange to reach the stop's own side. It now judges only the **main road** at the node: its highest class, ramps (`*_link`) and smaller side streets ignored.
2. **Turning round was a jump.** A double-stop **bus** line now turns round by road at each end (`RoadIndex.turnaround`, `Network.turnSegment`): from the end stop, not back the way it came, either round a block (the ordinary shortest path) or on to the nearest **junction** ahead, a U-turn there, and back — whichever is shorter. U-turns are allowed only at junctions (three or more roads), never in the middle of a road. The trip down starts with the turn beyond the last stop (`refreshBackSegments`); the trip up starts with the turn from where the trip down ended (`rebuildSegments`, two passes, since each end depends on the other). The whole line is re-planned on every stop added, so an old end stop that becomes a middle stop simply loses its turn.

**Trams do not turn round by road**: like most modern European fleets they are double-ended and reverse at the end of the line, which needs no turning loop of track. Single-stop lines are loops and never turn.

**Fixed on the way:** `placeAt` (vehicle spacing) spread each hop's dwell over its distance while `phaseOf` counts it at the stop — harmless while a line's two directions mirrored each other, uneven once a turnaround made them differ. A vehicle due mid-dwell now stands at the stop with the rest of its dwell to go.

**Measured on Patras**, lines of four stops along genuinely divided roads (every stop's carriageway with an opposite one across within 35 m): every middle stop found its twin (30 of 30), and the way back between the middle stops is a **median 1.00** of the way there, **worst 1.33** — no detour loops. Along ordinary one-way streets (no divider) the way back takes another street, by design (§24).

---

## 26. A stop goes on the road that was clicked — Oct 17 2026

Alex: "Clicking on the right road puts the stops on a neighboring road regardless." Stops snapped to the nearest road NODE. A main road often has nodes only at its junctions, hundreds of metres apart, while the side street beside it has one every few metres — so the nearest node was usually the side street's. **Measured on Patras**: clicking the middle of 127 main-road stretches of 80 m or more, the old snap put the stop on a **different road 58% of the time** (74 clicks), and over 30 m from the click 58 times.

Now `RoadIndex.snapToRoad` finds the nearest point ON a road the mode may use (a 50 m grid of edges), and the stop goes exactly there: within `BUILD.STOP_NODE_SNAP_M` (15 m) of a junction it uses the junction; otherwise placing the stop **splits the edge** there (`splitEdge` — same class, name, one-way rule and structure, lengths in proportion), so routing, one-way rules and turnarounds treat it as any other node. Snapping alone never changes the graph; only placing or dropping a stop does. A click within `STOP_REUSE_M` (15 m) of an existing stop of the mode reuses it. Same 127 clicks: **0** off the clicked road.

**Saves:** the split lives in the in-memory region. A save file carries that region, splits included. A save in the browser refers to the cached region, which does not have them, so `Game.fromJSON` re-finds — or re-makes — each bus and tram stop's node from its stored position (asserted: a reload on a fresh copy of the map puts the node back exactly and the line keeps its length).

---

## 27. Double stops along a whole avenue: the twin is found on the road, not at a node — Oct 17 2026

Alex, after adding five double stops along a major avenue in Athens: "What I would expect to see is literally just two red lines going up. No detours." The order was already right — the trip up calls R1…RN, turns, and the trip down calls LN…L1 — but each stop was drawn as a two-sided stop rather than a twin across the road: **no twin had been found**, so the trip down had to reach every stop on the up carriageway through the side streets.

The same cause as §26, in the twin search: `RoadIndex.twinOf` looked for a NODE on the opposite carriageway within 35 m, and a main road's carriageways have nodes only at junctions, so a stop placed between junctions found none. It now looks for the nearest point **on an opposite carriageway's edge** — running exactly the other way, directly across, within `STOP_PAIR_M` — and `Network.twinOf` makes a node there (`nodeAt`, splitting the edge as §26 does), re-made on load like any split.

**Measured on Patras**, twelve lines of five double stops clicked along genuinely divided roads: middle stops paired across **18 of 36 → 36 of 36**; the trip down between them **median 2.21× → 1.02×** the trip up, worst 6.18 → 1.03, hops over 1.5×: 13 of 24 → 0. A synthetic avenue with junctions 2 km apart and stops clicked between them is asserted in `tests/phase7.js`.

**Boarding checked afterwards (Alex asked).** Sixty days on Patras with four lines — a double-stop bus line along the divided avenue (all five stops paired across), a double-stop line through the one-way old town, a single-stop loop and a double-stop tram — every boarding recorded by stop and direction: 48 boardings, **0 onto a vehicle going the wrong way or on the wrong line**, both directions boarding on every double-stop line (the loop one way only, as designed), 45 arrived and 3 still aboard at the end, none gave up, nobody left waiting. Kept as a test: a synthetic divided avenue with paired stops and turns at its ends, run for sixty days, must board riders both ways and never the wrong way.

## 28. Nobody rode a newly drawn line; buses jumped carriageways at a motorway's end — Oct 17 2026

Alex: "no passengers boarded any bus lines no matter how long or how many stops", on a reloaded Athens and a fresh Megara, and "up until we messed with the lines pathfinding everything worked well".

**Not the pathfinding — an older bug the play-test fixes exposed.** Since §18 #6 a stop counts as served only once a line with a vehicle calls there. The demand table and the router rebuild only when `network.version` changes, and buying a vehicle never changed it. In the browser the game ticks all the while a line is drawn, paused or not, so the table was built for the draft — no vehicle, nothing served — and Done's free bus never rebuilt it: **0 pairs, forever**, until some later edit happened to bump the version (extending the line, say), which is why it seemed to work before. The headless tests and probes never tick during drafting, so they never saw it; the same Megara line driven through the real UI showed it at every commit back to `0b3cbb5`. `Game.invalidate()` now bumps the version too, and every caller of it is a network change. Asserted in both suites: a line drawn while ticking is wanted once Done gives it a bus.

**The jump.** A double-stop line along the Olympia Odos at Megara (a motorway: buses may use it) had no legal way round at either end — the next exits lie outside the 6 km region — so `turnSegment` returned nothing and the bus simply reappeared on the other carriageway, 17 m across. Where no turnaround exists, it now crosses straight over to the stop's twin (`Network.crossover`), a U-turn across the median drawn as part of the line. Asserted on a synthetic motorway with no way round.

**Still sparse, by the model's own rule.** With the fix, the Megara line through the town centre (four stops, 2 people per dot) wants about 350 trips a day, which is about one dot every two calendar days — 4 spawned in 12 days. That is the 324× sample of §16 working as designed, not a bug; whether a small network should look busier is a tuning question for Alex.

**Open question for Alex:** should buses be allowed to stop on motorways at all? A real bus would use the parallel road (at Megara, the one-way *Παράπλευρη Οδός* either side); stops could snap to the nearest non-motorway road while buses still drive on motorways between stops.

## 29. Single or double, stop by stop — Oct 17 2026

Alex: "single stop vs double stop should be more like a tool while drawing the road, rather than working as either–or. I should be able to create some sections fast and efficiently using double stop, and some where detail matters using single stop." Also: Undo did nothing in single-stop mode.

**The rule.** A line keeps `singleStops`, a set of its stop ids; every other stop is double. The trip out calls at every stop in the order drawn. The way back (direction 1) calls at the double stops, in reverse and from the far side of the road, and at both ends of the line, where the vehicle turns round. A single stop is therefore served one way only, exactly where it was placed; to serve the other direction, place another single stop on the way back. All double is the line as before. All single runs out calling everywhere and comes straight back — what the old automatic loop did, without being one. `Network.downCallsOf` / `line.downCalls` hold the way back's stops, and `backSegments[j]` is now the hop between `downCalls[j+1]` and `downCalls[j]` (with only double stops, j is still the segment index, so nothing else had to change). `stopOrder` and `segmentFor` read these, and the router, vehicles, spacing and boarding all go through those two.

**Drawing.** The drawing bar's *Double / Single stops* switch is `game.singleStopsDefault`: it decides the kind of the NEXT stop placed and leaves the ones already placed alone. Afterwards, the line panel shows Double, Single or Mixed and sets every stop at once; a stop's own panel has a Double/Single switch per line calling there.

**Riding round the end.** A passenger at a single stop beyond the last double one gets back by riding round the end of the line. The router has a `turn` edge from a line end's platform in one direction to the other, costing the layover, and a passenger whose next leg is the same vehicle's next trip stays aboard (`alightHere`) — no transfer penalty, no getting off.

**Undo and Cancel.** A single-stop line closed itself into a loop; Undo reopened it and the rebuild closed it again, so nothing happened — and Cancel, which repeats Undo until the line is empty, never finished. There is no automatic loop any more. Old saves (`singleSided`, `autoLoop`) load as open lines with every stop single.

**Found on the way:** a vehicle going round a loop *backwards* walked each hop along the neighbouring segment — `segmentFor` took the closing segment for the first hop — so it announced each stop a whole hop away from it (1,000 m on the fixture). Fixed by the new hop numbering; a test now checks that every vehicle reaching a stop is at it, on double, single and mixed lines and round loops both ways.

Trams follow the same rule but still reverse at their ends rather than turning round a block, and a tram's way back only pays for track the way out has not laid.

## 30. Bus and tram lines as in Cities: Skylines — Oct 17 2026 (evening)

Alex: the last sessions overcomplicated line paths (double vs single stops, twins across dividers, turnarounds, crossovers), partly from asking for simpler rules in several ways at once. The instruction: mirror Cities: Skylines exactly, simplify as far as possible, idiot-proof, the most efficient route without backtracking, two-way streets treated as two one-way streets side by side.

**The rules — the whole of them:**

- **A bus or tram stop stands on one side of the road** and serves the traffic going that way (`Stop.heading`, a unit vector). On a two-way street the side clicked decides, traffic keeping right (`RoadIndex.headingAt`, `BUILD.RIGHT_HAND_TRAFFIC`); on a one-way street the flow decides. A stop for the other direction is a second stop across the road; it snaps to the first one's node, so the two face each other. Clicking a stop on the same side reuses it.
- **Every bus or tram line is a loop**: from its last stop it heads back to its first (`Line.loop` is a getter — true for road modes with two or more stops). A line up a boulevard and back is its stops up one side, then down the other. Clicking the first stop again finishes the line (`Game.extendDraft` → `finished`). Vehicles all run the one way, direction 0.
- **Routing is one search** (`RoadIndex.stopPath`): Dijkstra over road edges *in a direction* rather than over nodes, leaving each stop along its heading and arriving at the next along its heading, obeying one-way streets. Having arrived at a node along a road, a vehicle may leave along any other — so **it never turns round in the road**; a U-turn happens only where there is no other way on (a dead end). Where nothing legal exists (a one-way street leading out of the region), it falls back to ignoring the rules rather than refusing the line. Road-class weighting is unchanged.
- **A stop is never on a junction**: a click within `STOP_NODE_SNAP_M` of one goes that far short of it, on the road clicked, because at a junction it would stand on no one road and so on no side of one.
- **Inserting a stop**: with *Line / Stops*, select a line; hovering beside it shows a ghost stop and "Insert a stop here"; a click inserts it into that stretch (`Game.insertionAt` / `insertStopAt`, `Network.segmentNear`). Where the line runs both ways along a street, the stretch going the way the new stop would face wins.
- **Drawing**: road lines are drawn on their side of the road, so a line served both ways along a street shows as two parallel lines; white chevrons along every bus and tram line point the way it runs (from zoom 14, `RENDER.LINE_ARROW_*`). Stops sit on their kerb, on their line; vehicles drive on their side. While drawing, a ghost shows where — and on which side — the next stop would go.
- **Trams** follow the same rules. Track is charged once per street, however many times the line runs along it. **Metro and train are unchanged**: they run out and back on two-way track, and the player can still close one into a loop.

**Removed:** `singleStops`, `downCalls`, `backSegments`, `stopNodeFor`, `twinOf` (both), `flowAt`, `turnaround`, `searchFrom`, `turnSegment`, `crossover`, `setSingleStops`, `stopsKind`, `runsBothWays`, the router's `turn` edges and riding on round the end, the drawing bar's Double/Single switch and the panels' stop-kind rows, `BUILD.STOP_PAIR_M`. `model/network.js` went from 1,288 lines to 945. Old saves load: stops get a heading from where they stand, and bus and tram lines become loops.

**Measured on Patras** (the snapshot from §25–27), 25 lines drawn up one side of a real two-way named road and back down the other, eight stops each: every hop between consecutive stops a **median 1.03×** the distance along the road; **0 U-turns, 0 wrong-way stretches**; about **48 ms to draw a whole line** (~6 ms a click). The five hops over 1.5× (worst 2.42) were all a click 4 m off the centreline beside a junction, which snapped to the cross street — the snap doing what the ghost shows, not the routing.

**Worth knowing:**
- A click exactly on a road's centreline picks a side arbitrarily (the road's drawing direction). Real clicks are never exact, and the ghost shows the side before clicking; tests click a few metres to the side.
- A click right beside a junction can land on the side street, as above. A preference for the bigger road on a near-tie would fix it invisibly; not done, to keep the snap simple. Say if it bites.
- Turning round at the end of a line goes round the block beyond the last stop, as Cities: Skylines buses do. On a road with no block to go round (a motorway whose exits are outside the region) the fallback ignores one-way rules for that stretch.

Asserted in [tests/phase7.js](tests/phase7.js) (`runStopPairs`: avenue up one side and down the other, divided boulevard, sides and reuse, junctions, insertion, Undo/Cancel/closing, tram track once per street, riders on the loop, saves old and new, no U-turns on the fixture) and in [tests/browser.js](tests/browser.js) (insert a stop by hover and click). 753 logic and 178 browser assertions passed at the time (758 after §31).

## 31. Passengers: starting across the road, and dots that no longer throttle demand — Oct 17 2026 (evening)

**Starting across the road.** Two stops facing each other stand at the same point, and demand gives each 200 m cell to the nearest stop, so the first one placed got every resident and its partner none. The passenger router let a trip start only at its own stop, so anyone going back the way the line came rode all the way round the loop. A trip may now start by walking to another stop of its interchange (`Router.build`, start → start walk edges), still a first boarding with no transfer penalty; `placeDot` already stood the dot where its first leg boards.

**Dots no longer throttle demand.** Alex asked whether people waiting "10 at a time" throttles the network. It did, badly. The game shows a 1-in-324 sample of the day, so a whole network wants only a handful of sample-people a calendar day, spread over hundreds of stop pairs, and each pair banked people until it had a whole dot of its own. Measured on Patras, three bus lines, share of wanted trips actually started:

| dot | before: day 5 / day 30 | now: day 1 / day 5 / day 30 |
| --- | --- | --- |
| 1 | 29% / 86% | 97% / 99% / 100% |
| 4 | 0% / 37% | 83% / 99% / 99% |
| 10 | 0% / **7%** | 69% / 97% / 99% |
| 30 | 0% / 0% | 0% / 83% / 97% |

Now people are banked for the whole network (`DemandModel.carry`), and each time a dot's worth has built up a dot is born on a trip picked at random, weighted by each pair's rate (`spawn`, a cumulative table and a binary search). Every pair gets its share on average and nothing waits to fill. The random stream is seeded and saved (`DemandModel.random`, mulberry32), so a game and a test play out the same every time and a reload carries on. Old saves' per-pair accumulators are dropped. What remains at day 1 for big dots is honest sparsity: that network wants ~14 sample-people a calendar day in all.

**Two more dot effects — both changed on Alex's decision the same evening:**
- **Seats round down**: a vehicle holds `floor(capacity / dotSize)` dots. A 50-person bus is exact at 10-person dots, but holds 45 people at 9, 39 at 13, 34 at 17, and 26–49 at 26–49 (one seat). Rounding to the nearest instead would remove the bias. It only bites on regions big enough for dots over ~10, and only once vehicles are full.
- **Giving up costs satisfaction per dot, not per person**: ten 1-person dots giving up cost ten `GIVE_UP_PENALTY`s, one 10-person dot costs one. Small towns are punished hardest.

**Decided, Oct 17 2026:** seats now round to the nearest whole dot (`Vehicle.seats`, every mode — the same bias in all, and one rule), and a dot giving up costs `GIVE_UP_PENALTY` × the people it stands for (`DemandModel.penalise`). Consequence worth knowing: with 0.15 a person, one 10-person dot giving up drops its pair from 1 to the 0.2 floor at once, and at 0.02 a day it takes 40 days to recover — exactly what ten one-person give-ups always cost a small town. If big cities feel too unforgiving, `PATIENCE.GIVE_UP_PENALTY` is on the tuning panel.

## 32. Tracks join where they meet; trams and steep streets — Oct 18 2026

Both were waiting on Alex's go-ahead since §23.

**Tracks join wherever they cross.** A junction used to need a click on the exact spot (the first click, or the click that ends a track). Now `TrackGraph` also joins a player's track to any track it crosses at the same height, within `BUILD.JOIN_HEIGHT_M` (3 m): another player track or an existing railway. A tunnel or a bridge passing over or under is several metres clear and does not join. The junctions are worked out from the geometry every time the graph is built, so saves are unchanged and old saves gain them. Existing railways were already joined where their ways share a node; railway-to-railway crossings are left alone (a level crossing of two lines is not a switch). While drawing, the preview marks each place the new track will join with a filled junction square (`TrackGraph.crossings`). Compatibility is unchanged: metro may run on to train track, train never on to metro track.

**Trams refuse streets steeper than `BUILD.TRAM_STREET_MAX_GRADE` (10%).** Real trams mostly manage 6–8%, so this is kinder, and far kinder than metro track's 4.5%. Each stretch of street is judged from the terrain at its two ends (`RoadIndex.gradeOf`); tram routing simply will not use one that is too steep, and goes round if it can. Where it cannot, the stop is refused with "Too steep for a tram — the street climbs too much." No profile strip. On Patras, 10% rules out 3.1% of the streets trams may use, essentially the upper town (6% would rule out 11.5%). On the tuning panel ("Steepest street a tram climbs"); it applies to the next route planned. Buses climb anything. Off-road (dragged) tram track keeps its own grade rule, 7%.

**Refusals are red.** Every refused click — too steep, too far from a road, can't afford, no route — now shows in the logo's red (`.feedback.refused`); news that something was built stays in ink.

**The top bar shows the difficulty**, between the speed buttons and Transported, with its description on hover. In the console: `otomig.game.difficulty`.

The fixture's ridge has streets of 15% to 180% (it is synthetic and has cliffs), so the two tests that drag a tram over it — Phase 3's and the browser's — lift the street limit for that block, and Phase 3's maintenance test moved its tram line to the flat. 768 logic and 178 browser assertions pass.

**Interchanges are drawn as thin lines**, black at 30% (`COLORS.interchangeLink`), between each two stops of an interchange within walking distance of each other, in place of the ring round them all. Two stops sharing a line get no line between them: the two sides of one stop still count as an interchange, but changing there is no change. That costs nothing, so the mechanic is untouched. The router uses it to let a trip start across the road (§31), and never "changes" on to the same line, since staying aboard is free and changing costs a wait and the transfer penalty. The stop panel's "Interchange" row follows the same rule (`Network.changesAt`): yes only where a stop of another line is within the interchange. A stop no line calls at is never a change either, on the map or in the panel (`Network.isChange`).

## 33. Sound effects — Oct 18 2026

Alex supplied fifteen sounds from Freesound, each named for its event. They are in [soundfx/](soundfx/) as mono 96 kbps mp3s with plain names (37 MB of wav became 1.2 MB), levelled with ffmpeg to one loudness — one-shots −24 dBFS mean, loops −28, peaks under −3 dBFS — and one-shots trimmed of silence. The originals sit in `soundfx/originals/`, kept out of git. Credits: [soundfx/Attribution.txt](soundfx/Attribution.txt) (with which file is which) and the README. **One is CC BY-NC** (the train loop): fine while the game is free, to be replaced if it is ever sold.

[ui/sound.js](ui/sound.js) plays them with Web Audio, quiet by design (`AUDIO` in config.js: master 0.45, effects 0.6, loops 0.35):

| sound | when |
| --- | --- |
| `new-line-<mode>` | a new line is finished (not an old one extended) — `Game.emit('lineCreated')` |
| `stop` | a stop is added to a line or moved — `stopPlaced` |
| `bulldoze` | anything bulldozed or deleted — `bulldozed` |
| `finances` | the finances panel opens — `financesOpened` |
| `month` | the month turns |
| `station-full` | a stop passes the crowd it can show (`RENDER.MAX_PASSENGER_DOTS`, where it says "+N"); each stop once until it empties, at most every 8 s |
| `loop-<mode>` | while a line of that mode is selected, fading in and out |

Browsers allow sound only after the player has touched the page, so nothing loads until the first click or key; the tab going hidden suspends it. Loops decode to exactly their original length in Chromium (the encoder's gapless header), so they repeat without a gap. There is no mute control yet. Ferry sounds are wired for when ferries arrive.

