# RESEARCH.md — Phase 0

Oct 10, 2026. Sources are public only: official and community wikis, developer/press material, operator and industry reporting, and the OSMF operations policies. No decompiled code, no extracted assets.

Verdict up front: **the spec's numbers hold up better than expected.** The cruise speeds, the capacities and the time model are all internally consistent and land close to real-world figures once you work the arithmetic through. Four figures needed a decision; Alex resolved all four on Oct 10, 2026 and they are now applied in `config.js` — see [Conflicts](#conflicts--resolved-by-alex-oct-10-2026) at the end.

---

## 1. Mini Metro — what to borrow

| Mechanic | How Mini Metro does it | What OTOMIG should do |
| --- | --- | --- |
| Line drawing | Click/drag between stations; click the first station to close a loop. Lines are a limited resource. | Already the spec. Money replaces the line limit — a deliberate change, keeps the sandbox open. |
| Loops | "You can connect a line's end to its beginning, and trains will go around in a circle in either direction." On a non-loop, passengers won't board a train whose destination lies behind it; **on a loop they board regardless** ([Steam discussion](https://steamcommunity.com/app/287980/discussions/0/530645446309743308)). | Matches the spec's "direction is whichever reaches the alighting stop sooner". No change. |
| Crowding | Station holds **6 passengers**; past that an overcrowd timer runs **45 s, plus a 2-second grace period** in case a train is almost there ([Mini Metro wiki](https://mini-metro.fandom.com/wiki/Mini_Metro), [Steam](https://steamcommunity.com/app/287980/discussions/0/35221584552224188/)). | OTOMIG uses per-passenger patience instead of a station cap — correct for "no sudden game over". **Borrow the grace period**: don't let a dot give up if a vehicle it can board is within `PATIENCE_GRACE_SIM_S` of arriving. This single rule is what makes Mini Metro feel fair rather than punishing. New config value below. |
| Routing | Passengers take the shortest route to any station of their shape. No transfer cost. | OTOMIG needs real Dijkstra for transfers (spec §Passenger routing). Keep the 5-minute transfer penalty — it is what stops the router from proposing silly 4-leg trips. |
| Feedback | Almost no text. Crowding reads as a growing ring. | Already the spec (waiting-timer ring). |

The design lesson, not a number: Mini Metro's limits are *counts* (lines, trains, tunnels), which force trade-offs every week. OTOMIG's only limit is money. On Creative that means no trade-offs at all — expect Creative to feel empty, and treat that as fine (it is a sketchpad), but it means **Hard is where the game actually lives**, and Hard is worth tuning first.

## 2. Cities: Skylines — time, money, capacities

- **Time model.** CS1 ran roughly 1 real second = 1 in-game minute (a day ≈ 24 real minutes) ([TV Tropes summary](https://tvtropes.org/pmwiki/pmwiki.php/VideoGame/CitiesSkylines)); CS2 slowed this to about **72 real minutes per in-game day** at 1× ([Steam](https://steamcommunity.com/app/949230/discussions/0/3937895062993758500/)). Both run one clock for everything. OTOMIG's **two** clocks (sim 20×, calendar 1 day / 10 real s) make the calendar ~144× faster than CS1's. That is the right call for a game with no day/night: it means a month is 5 real minutes, so a Tourist region's August peak is actually *visible* in a sitting. Keep it.
- **Loans.** CS1: ₡20,000 at 5% / 52 weeks, ₡60,000 at 10% / 260 weeks, ₡200,000 at 15% / 520 weeks — i.e. **1, 5 and 10 years, at 5/10/15%** ([Guide Strats](https://guidestrats.com/cities-skylines-loans/)). The spec's 5/10/20 years at 3/5/8% is cheaper and longer than CS1 on every axis. See conflict C4.
- **Operating cost model.** CS1 splits transport into revenue (passengers × fare), variable cost (per vehicle in service, e.g. 12₵/bus, 20₵/tram, ~50₵/metro, ~100₵/train per week) and fixed cost (depots, stations, track) — with **depots often 70% or more of total cost** ([Transportation Economics guide](https://steamcommunity.com/sharedfiles/filedetails/?id=1969237818)). OTOMIG has no depots (out of scope) and folds fixed cost into 1.5%/yr maintenance. Worth knowing: CS1's cost curve is dominated by the thing OTOMIG deliberately omits, so **OTOMIG's running costs will bite less than CS1's**. If Hard feels too easy in Phase 5, raise running cost per vehicle before touching anything else.
- **Capacities.** CS1 is abstract and much smaller than reality: bus 30, metro 180 (120–500 with Hubs & Transport), train 240 ([Hubs and Transport](https://skylines.paradoxwikis.com/Hubs_and_Transport), [Transportation Economics](https://steamcommunity.com/sharedfiles/filedetails/?id=1969237818)). OTOMIG uses real-world capacities instead. Don't copy CS1 here — but note the consequence: one OTOMIG metro (900) does the work of five CS1 metros, so the 1-minute minimum headway cap is doing real work and must not be loosened.

## 3. The spec's own numbers, checked

**Speeds — these are right, and the reason is worth writing down.** The spec's cruise speeds look far too fast against real commercial speeds (urban bus averages ~15–20 km/h, trams in the teens to ~20, metros 30–40, German S-Bahn ~55 km/h — [Transit Costs speed map](https://tpa.transitcosts.com/journey/speed), [Marco Chitti on trams](https://marcochitti.substack.com/p/build-trams-but-build-them-well), [Frankfurt S-Bahn](https://en.wikipedia.org/wiki/Public_transport_in_Frankfurt_am_Main)). But cruise speed is *between* stops, and the dwell is modelled separately. Working it through at typical stop spacing:

| Mode | Cruise | Dwell | Typical spacing | Effective door-to-door | Real-world |
| --- | --- | --- | --- | --- | --- |
| Bus | 25 km/h | 20 s | 400 m | **18.5 km/h** | 15–20 |
| Tram | 30 km/h | 20 s | 500 m | **22.5 km/h** | 15–22 |
| Metro | 60 km/h | 30 s | 1000 m | **40 km/h** | 30–40 |
| Train | 90 km/h | 45 s | 2000 m | **57.6 km/h** | ~55 (S-Bahn) |

All four land inside or at the top of the real range. **No change needed** — but the spec should say *cruise* everywhere it says speed, because the numbers are only defensible read that way.

**Capacities — consistently conservative, and that's coherent.** A 12 m city bus really holds 70–116 ([typical 12 m bus: ~20–40 seated + ~70 standing](https://www.lamilux.com/hub/transportation/vehicles-in-the-bus-sector.html); [SOR NB 12](https://en.wikipedia.org/wiki/SOR_NB_12) 36+80). A 32 m low-floor tram holds 300–375 ([Bozankaya](https://en.wikipedia.org/wiki/Bozankaya) 370, [Škoda 26T](https://en.wikipedia.org/wiki/%C5%A0koda_26_T) 300). So the spec's 50 and 200 are both about 55–65% of crush capacity — a *comfortable* load, not a crush load, applied consistently across modes. Metro 900 against Bucharest's six-car trains at 1,200 each is the same ratio. Keep all four as they are; they are not errors, they are one consistent choice.

**Construction costs.** The spec's €120M/km tunnelled metro sits at the efficient-European end of a wide real range: the Transit Costs Project's weighted average across 755 lines is **$252M/km** (inflation-adjusted to 2025), with the most efficient countries at **$100–200M/km** and fully-underground Spanish and French lines as low as **$80–120M/km** ([Transit Costs data](https://transitcosts.com/new-data/), [Transit Costs study](https://transitcosts.com/transit-costs-study-final-report/)). Eno's database gives tunnelled non-US projects **$215M/km** against $354M/km in the US, and at-grade **$52M/km** non-US ([Eno](https://enotrans.org/article/eno-releases-first-iteration-of-transit-construction-cost-database/)). Tram at-grade €15M/km on-street is supported by German practice — recent German light rail track at **£13–20M/km**, and an Essen 5 km at-grade line at about €89M ≈ **€17.8M/km** ([Bath Trams' survey of German costs](https://bathtrams.uk/cost-of-installing-trams/)). Two caveats in C1 and C2 below.

## 4. Endpoints and usage policies — all verified, two implementation traps

- **Nominatim** ([policy](https://operations.osmfoundation.org/policies/nominatim/)): max **1 request/second**; **autocomplete is expressly forbidden** ("you must not implement such a service on the client side") — the spec's search-on-Enter already complies; results **must be cached** on our side ("clients sending repeatedly the same query may be classified as faulty and blocked"); attribution required. **Trap: a browser cannot set `User-Agent`.** The policy accepts "a valid HTTP Referer *or* User-Agent"; we satisfy it via Referer, which the browser sends automatically — but that means the app must never be opened from a `file://` URL (no Referer sent). Serve over `http://localhost` always.
- **OSM standard tiles** ([policy](https://operations.osmfoundation.org/policies/tiles/)): visible "© OpenStreetMap contributors" attribution; unique User-Agent (same browser trap — Referer covers us); **no bulk download or prefetching** ("any pre-emptive fetching of tiles other than those a user is actively viewing"); honour cache headers; no SLA, may be blocked without notice. The spec's two uses — region-selection screen and the optional faded underlay — are both "actively viewing", so both are compliant. Keep MapLibre's prefetch off (`maxTileCacheSize` default is fine; do not raise `prefetchZoomDelta`).
- **Overpass** ([wiki](https://wiki.openstreetmap.org/wiki/Overpass_API)): casual use is fine under 10,000 queries and 1 GB/day; **for anything set up to run regularly, divide by 100 — under 100 queries and under 10 MB/day.** Our chunking is 9–36 queries per import, which is nothing; the risk is the **10 MB** figure, which a dense import blows past comfortably — measured at 1.87 MB/km² over central Athens, so even the 6 km default is tens of MB. See the postscript. Mitigations, all cheap: request only the tags we keep, never `out meta`, use `out body` for ways plus `out skel qt` for node geometry, and cache imported regions in IndexedDB forever as the spec already requires. For one person importing a handful of regions this is well inside casual use; it would only matter if OTOMIG were ever hosted publicly, which is worth a note in the README before GitHub Pages.
- **AWS Terrain Tiles / Terrarium** ([registry](https://registry.opendata.aws/terrain-tiles/), [open-data-registry entry](https://github.com/awslabs/open-data-registry/blob/main/datasets/terrain-tiles.yaml)): no API key, zooms 0–15, `(R*256 + G + B/256) − 32768` metres — the spec's formula is correct. Required attribution per [tilezen/joerd](https://github.com/tilezen/joerd/blob/master/docs/attribution.md) is reproduced verbatim in `config.js`. **Resolved by direct test (see the postscript):** `Access-Control-Allow-Origin: *` is present on GET, so decoding pixels is safe. We go through `fetch()` → `createImageBitmap()` rather than `<img>` + `drawImage` anyway, which cannot taint the canvas either way.
- **Zoom choice, settled by arithmetic.** Terrarium metres/pixel = `156543.03 × cos(lat) / 2^z`:

  | | z12 | z13 |
  | --- | --- | --- |
  | Athens (38°N) | **30.1 m** | 15.1 m |
  | Berlin (52°N) | **23.5 m** | 11.8 m |
  | Oslo (60°N) | **19.1 m** | 9.6 m |

  **Use z12.** It gives the spec's "about 30 m cells" at Mediterranean latitudes, needs only 3–5 tiles per side for a 15 km box (9–25 tiles total), and z13 is false precision anyway — the underlying SRTM data is ~30 m.

## 5. Build decision: pin MapLibre **v5**, not v6

This one is load-bearing for "no build step". **MapLibre GL JS v6 (latest 6.13.0) ships ESM only** — `dist/` contains `maplibre-gl.mjs` plus a separate `maplibre-gl-shared.mjs` and `maplibre-gl-worker.mjs`, with an `exports` map offering `import` and no `require`. No UMD bundle exists, so there is no single file to drop in a `<script>` tag, and the worker is a separate module whose path must resolve correctly at runtime. **v5.24.0 still ships `dist/maplibre-gl.js`** as a self-contained UMD build — one script tag, no module resolution, no worker path problem, and it matches the spec's suggested `vendor/maplibre-gl.js` layout exactly. Pinned v5.24.0 and vendored. Revisit only if a v6-only feature is ever needed.

## 6. Suggested `config.js` values

Everything the spec specifies is carried over unchanged. These are the additions and the ones research pins down:

```js
MAPLIBRE_VERSION: '5.24.0',        // §5 — v6 is ESM-only, breaks the no-build-step rule
TERRAIN_ZOOM: 12,                  // §4 — ~20–30 m cells; z13 is false precision vs SRTM
PATIENCE_GRACE_SIM_S: 30,          // §1 — Mini Metro's 2 s grace, scaled to a 15-min patience
OVERPASS_CHUNKS: 3,                // 3×3 = 9 queries/import, inside Overpass casual use
NOMINATIM_MIN_INTERVAL_MS: 1000,   // §4 — policy maximum is 1 req/s
NOMINATIM_CACHE: true,             // §4 — policy requires caching results our side
OSM_UNDERLAY_PREFETCH: false,      // §4 — prefetching is forbidden by the tile policy
```

`PATIENCE_GRACE_SIM_S: 30` is my number, not a sourced one: it is Mini Metro's grace idea (2 s against a 45 s timer, ~4%) widened deliberately to ~3% of a 15-minute patience in sim seconds, which at bus cruise speed is roughly the last 200 m of a vehicle's approach. Tune in Phase 2 once dots are actually visible.

## Conflicts — resolved by Alex, Oct 10 2026

All four are now applied in `config.js`. Decisions recorded below.

- **C1 — RESOLVED: keep €15M, swap the citation.** The Eno citation in the spec doesn't say what the spec says. The spec claims "German tram projects averaged about $36M per mile (Eno)". Eno's cost-database article gives at-grade non-US projects at **$52M/km**, tunnelled non-US at $215M/km, and explicitly states that **"light rail is not necessarily cheaper than heavy rail. Grade alignment, rather than mode, is the major determinant of cost"** — i.e. it deliberately does *not* publish per-mode figures. The €15M/km on-street tram figure is still well supported, just by German project reporting ([£13–20M/km](https://bathtrams.uk/cost-of-installing-trams/)) rather than by Eno. Written up the sourced way in §3; `config.js` carries the corrected attribution.
- **C2 and C3 — RESOLVED: swap them. Metro tunnel €80M/km, train tunnel €120M/km.** One change fixes both complaints: heavy-rail bores are larger and really do cost more per km than metro tunnels, so the spec's ordering was backwards, and €80M/km keeps metro reachable rather than a loan-only endgame. €80M/km sits just below the efficient-European band ($80–120M/km in Spain and France) — knowingly optimistic, chosen for playability. Original C2 note follows.
  Metro tunnel €120M/km was already at the optimistic edge of the spec's own cited range. The spec cites $180–270M/km and then prices tunnel at €120M/km. Research says €120M/km is real but only for the most efficient builders (Spain, France: $80–120M/km). Raising it to a realistic €180–200M/km would put metro out of reach for most of a game: on Normal a 200k-resident region starts with ~€100M, which at €120M/km already buys less than a kilometre. Resolved downward to €80M/km rather than up.
  Train keeps its at-grade advantage (€15M against metro's €30M), which is now the thing that distinguishes the two modes.
- **C4 — RESOLVED: 3/6/12 years at 4/6/9%.** Loan terms were longer than the game's own horizon. One in-game year is ~1 real hour, so the Large loan's 20-year term is 20 real hours of play — it can never be repaid in any realistic session, and its 8%/yr interest compounds across a span the player will never see the end of. CS1's equivalents are 1/5/10 years at 5/10/15%. Three distinct risk levels remain, but the Small loan clears in about three real hours and the Large one is a decision with a visible end.

## Postscript — live endpoint testing, Oct 10 2026

§4 above was written without network access to the endpoints, on the spec's word that the sandbox could not reach them. That turned out to be false. All four were subsequently tested directly, and the findings supersede the cautions above:

- **Terrarium elevation.** CORS is present on GET (not on HEAD, which is what made it look missing). The decode formula is confirmed against live tiles — Mont Blanc reads 1,719…**4,790 m** against a true summit of 4,806 m, and `tileXY` is correct.
- **Nominatim.** Works as documented, `extratags` included.
- **Overpass.** 406s a request with no `User-Agent` — irrelevant to a browser, which always sends one, but it means the game cannot identify itself that way (`User-Agent` is a forbidden header name) and relies on `Referer`. More importantly it fails on chunk **area**: a 2 km box of central Athens serves in 18 s and 7.5 MB, a 5 km box returns 504 every time. Payload measures **1.87 MB/km²** there, of which buildings are 49%.

Full numbers, the fixes applied, and the open question about the Phase 1 acceptance criterion are in [HANDOFF.md](HANDOFF.md) §4.

## Sources

[Mini Metro wiki](https://mini-metro.fandom.com/wiki/Mini_Metro) · [Mini Metro overcrowd timer discussion](https://steamcommunity.com/app/287980/discussions/0/35221584552224188/) · [Mini Metro loops discussion](https://steamcommunity.com/app/287980/discussions/0/530645446309743308) · [Dinosaur Polo Club](https://dinopoloclub.com/games/mini-metro/) · [CS Hubs and Transport wiki](https://skylines.paradoxwikis.com/Hubs_and_Transport) · [CS Transportation Economics guide](https://steamcommunity.com/sharedfiles/filedetails/?id=1969237818) · [CS2 Transportation wiki](https://cs2.paradoxwikis.com/Transportation) · [CS2 simulation speed](https://steamcommunity.com/app/949230/discussions/0/3937895062993758500/) · [CS loans](https://guidestrats.com/cities-skylines-loans/) · [CS time model](https://tvtropes.org/pmwiki/pmwiki.php/VideoGame/CitiesSkylines) · [Transit Costs data](https://transitcosts.com/new-data/) · [Transit Costs final report](https://transitcosts.com/transit-costs-study-final-report/) · [Transit Costs speed map](https://tpa.transitcosts.com/journey/speed) · [Eno cost database](https://enotrans.org/article/eno-releases-first-iteration-of-transit-construction-cost-database/) · [German tram costs](https://bathtrams.uk/cost-of-installing-trams/) · [UK tram costs](https://bathtrams.uk/4-cost-of-tram-light-rail-installation/) · [Marco Chitti, trams](https://marcochitti.substack.com/p/build-trams-but-build-them-well) · [Frankfurt S-Bahn](https://en.wikipedia.org/wiki/Public_transport_in_Frankfurt_am_Main) · [12 m bus capacity](https://www.lamilux.com/hub/transportation/vehicles-in-the-bus-sector.html) · [SOR NB 12](https://en.wikipedia.org/wiki/SOR_NB_12) · [Bozankaya trams](https://en.wikipedia.org/wiki/Bozankaya) · [Škoda 26T](https://en.wikipedia.org/wiki/%C5%A0koda_26_T) · [Nominatim policy](https://operations.osmfoundation.org/policies/nominatim/) · [OSM tile policy](https://operations.osmfoundation.org/policies/tiles/) · [Overpass API wiki](https://wiki.openstreetmap.org/wiki/Overpass_API) · [Terrain Tiles registry](https://registry.opendata.aws/terrain-tiles/) · [Terrain Tiles dataset entry](https://github.com/awslabs/open-data-registry/blob/main/datasets/terrain-tiles.yaml) · [Tilezen attribution](https://github.com/tilezen/joerd/blob/master/docs/attribution.md)
