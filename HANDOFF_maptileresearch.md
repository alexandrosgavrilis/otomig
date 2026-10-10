# HANDOFF_maptileresearch.md — Phase R

**Purpose.** Decide the final data architecture before any more game is built on the current one. Read [HANDOFF.md](HANDOFF.md) §4 and §5 first — §4 is what was measured, §5 is what is proposed.

**Deliverable.** A short `RESEARCH_TILES.md` answering the questions below, each with a source or a measurement, ending in one recommendation against the decision table in §7. Every claim links its source, as in [RESEARCH.md](RESEARCH.md).

**Order of work.** Phase R (this) → Phase D (rewrite, if supported) → Phase 3 (trams).

---

## 0. What is already settled — do not re-derive

Measured against the live APIs on Oct 10, 2026. These are facts, not assumptions.

| | |
| --- | --- |
| Overpass payload, central Athens | **1.87 MB/km²** |
| …of which buildings | 49% (ways + their exclusive geometry nodes) |
| …of which POI nodes | 18% |
| …of which **roads** | **~9%** — only 1,260 of 10,488 geometry nodes are road nodes |
| Overpass chunk limit | 2 km box serves in 18 s / 7.5 MB; **5 km box 504s every time** |
| Overpass without a `User-Agent` | 406. Browsers always send one; `fetch` cannot set it (forbidden header) |
| Terrarium elevation | CORS `*` present on GET; decode formula verified (Mont Blanc 4,790 m vs true 4,806) |
| Building footprints, same sample | p10 106 m², median 220, mean 285, p90 514, p99 1,421; largest 10% hold **29% of all floor area** |

Tile arithmetic (lat 38°N), already computed:

| zoom | tile span | MVT precision | 6 km region | 15 km region |
| --- | --- | --- | --- | --- |
| z14 | 1,927 m | 0.47 m | 25 tiles | 81 |
| z15 | 964 m | 0.24 m | 64 tiles | 289 |
| z16 | 482 m | 0.12 m | 196 tiles | 1,089 |

---

## 1. Provider and licensing — the question that can kill the whole idea

Answer this first. If no provider permits it, nothing below matters.

**Q1.1 — Which vector tile provider allows fetching ~200 tiles in a burst to build a game region, and caching them locally?**
Candidates: [OpenFreeMap](https://openfreemap.org), [Protomaps](https://protomaps.com), [Versatiles](https://versatiles.org), MapTiler, Stadia Maps, Mapbox. For each: terms of use, whether an API key is required, rate limits, attribution text, and whether local caching (we would store the derived region in IndexedDB, not the tiles) is permitted.
*Why it matters:* this is a burst of a few hundred requests per import. Most free raster policies forbid exactly that. Vector providers differ, and some are explicitly relaxed.
*Note:* OSM's own `tile.openstreetmap.org` is **raster** and carries no features at all. It is not a candidate.

**Q1.2 — Is storing the derived region (outlines, POIs) in IndexedDB a redistribution problem under the provider's licence, separately from OSM's ODbL?**
*Why:* we cache a region forever and the player may export it as a file. ODbL is fine with attribution; a provider's own terms may add conditions.

**Q1.3 — PMTiles: is there a public OSM-wide archive we can HTTP range-request for just our bbox, without running a tile server?**
*Why:* this is the elegant endgame — one file, range requests, static hosting, no per-tile round trips, no rate limit. If a public archive exists and permits range reads, it may beat the per-tile approach outright.
*How:* check Protomaps' daily builds and whether range requests against them are sanctioned.

**Q1.4 — What is the attribution string each provider requires**, and does it replace or add to our existing OSM + Terrarium footer?

---

## 2. Schema — is the data actually in there?

**Q2.1 — What exactly does the `poi` layer carry?** Confirm the fields (`class`, `subclass`, `rank`, `name`), and **confirm that `subclass` is the raw OSM tag value** (`bakery`, `university`, `hospital`) rather than a coarse bucket.
*Why:* the entire attraction model now rests on this. If `subclass` is coarse, the weights really do become decorative and the hybrid loses most of its point.
*How:* fetch one z16 tile over central Athens, decode it, and dump the distinct `class`/`subclass` pairs. Compare against what Overpass returns for the same box — we already know that box has 1,334 shop/amenity nodes after the trim.

**Q2.2 — At what zoom does POI rank-thinning stop?** Count POIs per layer at z14, z15, z16 against the Overpass ground truth for the same area.
*Why:* decides the fetch zoom, which drives tile count (64 vs 196 for a 6 km region) and therefore payload and request burst.
*Target:* the zoom at which we recover ≥90% of Overpass's POI count.

**Q2.3 — Does the `building` layer carry `render_height` / `render_min_height`, at what zoom, and what fraction of buildings have a real height rather than a schema default?**
*Why:* building volume is the proposed replacement for floor-area-times-category. If 80% of heights are a filled-in default, that multiplier is noise and the model needs rethinking.

**Q2.4 — Do any schemas carry a building category after all?** Compare OpenMapTiles, Shortbread, and the Protomaps basemap schema. They differ.
*Why:* if one does, the attraction model does not need inverting at all and Phase D gets much smaller.

**Q2.5 — Are buildings clipped at tile boundaries, and is there an id to dedupe on?**
*Why:* a building split across two tiles is two polygons. For rendering that is invisible; for floor area it is double-counted, and for the occupancy raster it may leave a seam. Check whether the layer carries `osm_id`.

**Q2.6 — Does the `transportation` layer's `class` distinguish `pedestrian`?**
*Why:* the tram rule specifically allows pedestrian streets and forbids residential ones. Only relevant as a cross-check, since roads stay on Overpass — but worth knowing if the hybrid ever shifts.

---

## 3. Overpass, roads only

**Q3.1 — What does a roads-only query actually cost per km², and does a 5 km chunk survive?**
*Why:* the estimate of 9% / ~6 MB per 6 km region is extrapolated from a breakdown, not measured directly. And the 504s we hit were plausibly caused by node recursion over thousands of buildings — if dropping buildings fixes that, `OVERPASS_CHUNK_TARGET_KM` can rise and the request count falls.
*How:* take `buildQuery`, strip everything but `highway`, `railway` and `natural=water`, and run it against 2 km and 5 km boxes of central Athens. Remember the `User-Agent` for Node-side tests.

**Q3.2 — If 5 km chunks now work, what is the right chunk target?** Re-derive `OVERPASS_CHUNK_TARGET_KM`; a 15 km region currently needs 36 requests at 2.5 km.

**Q3.3 — Does dropping buildings from Overpass change what we lose?** Buildings currently supply `building:levels`. Confirm nothing else in the pipeline reads building tags from Overpass once tiles supply the footprints.

---

## 4. The attraction model, redesigned

This is a design question, not a lookup. It needs a written proposal, not just facts.

**Q4.1 — Propose the mapping from `poi.class`/`subclass` to attraction weight**, replacing `POPULATION.ATTRACTION_WEIGHTS`. The current weights are shops/offices 1.0, schools/universities 1.5, hospitals 1.5, hotels 1.0, residential 0.2.

**Q4.2 — Propose the formula combining POI weight with building volume.** Today: `floor area × category weight`. Candidate: POIs carry the weight; a building's volume scales the POIs inside or near it. Needs to be written down and sanity-checked.

**Q4.3 — Where do residents come from now?** Currently `footprint area × levels ÷ 40`. Tiles give footprint area (good) and `render_height` instead of levels (so levels ≈ height ÷ 3, pending Q2.3). Confirm this still produces plausible densities — real European cities run 3,000–8,000 residents/km², central Athens ~20,000.

**Q4.4 — Does the heat map still read correctly?** The acceptance test is qualitative: does unserved demand still point at places where a stop would obviously help?

---

## 5. Integration and performance

**Q5.1 — Do Overpass roads and tile buildings align geometrically?** Different sources, different rounding, possibly different OSM snapshots.
*Why:* if a tile building overlaps an Overpass road by a few metres, Phase 4's "track may not cross a building" rule will block track that visibly runs down the middle of a street. **This is the integration risk of the hybrid** and deserves a real test: overlay both for one dense block and measure the worst overlap.

**Q5.2 — How stale are the tiles relative to Overpass?** Overpass is live; tile builds may be days or weeks old. Does a mismatch matter for us?

**Q5.3 — Can an MVT decoder be vendored without a build step?** `@mapbox/vector-tile` + `pbf` are ~15 KB but CommonJS. Check for an ESM build, or whether a single-file bundle can be vendored the way MapLibre was.
*Why:* this is the first runtime dependency. The no-build-step rule is load-bearing (see RESEARCH.md §5).

**Q5.4 — How long does decoding 196 tiles take in a worker?** Compare against the current import, and against the "about two minutes" the spec asks for.

**Q5.5 — How large is a region in IndexedDB** once it carries full building outlines from tiles? The fixture is 2.2 MB for 6 km synthetic; a real dense 6 km will be far larger.

---

## 6. Fallback path

**Q6.1 — What does BBBike's extract service offer?** Formats, bbox size limits, turnaround time, terms.

**Q6.2 — Is parsing `.osm.pbf` in browser JS worth it, or should `tools/make-region.js` run in Node and emit a region JSON** against the existing contract? The latter needs almost no new game code — we already have a file picker for saves.

---

## 7. Decision table

Fill this in; it is the actual output.

| If… | Then |
| --- | --- |
| No provider permits a ~200-tile burst (Q1.1) | **Stop.** Keep Overpass; revisit only the file-import fallback (§6). |
| A schema carries building categories (Q2.4) | Hybrid gets much simpler — no attraction redesign needed. Proceed, skip §4. |
| `subclass` is coarse, not raw OSM values (Q2.1) | Attraction weights become decorative. Weigh whether the payload saving is still worth it. |
| `render_height` is mostly a default (Q2.3) | Residents lose their vertical signal. Probably fatal to the hybrid — say so. |
| Roads/buildings misalign by more than a few metres (Q5.1) | Phase 4 will block track in the street. Either snap buildings to the road graph, or keep buildings on Overpass too. |
| A roads-only Overpass query serves 5 km chunks (Q3.1) | Raise the chunk target; fewer requests regardless of what else is decided. |
| Everything checks out | Proceed to Phase D as scoped in HANDOFF §5. |

---

## 8. How to answer these

Most are one small script away. The pattern that worked for the Overpass research:

- Fetch one real tile, decode it, dump the distinct attribute values. Do not trust documentation over data — the Overpass `User-Agent` 406 and the S3 CORS-on-GET-but-not-HEAD were both found that way, and both contradicted what the docs implied.
- Compare against Overpass ground truth for the same bbox. We have a known sample: a 1 km box at `23.7275, 37.9838` returns 1.88 MB, 1,835 buildings, 1,334 kept POI nodes.
- Measure twice when a server is involved. Overpass 504s transiently and the first failure means nothing; `kumi.systems` was returning 500 on `/api/status` for an entire afternoon.
- Record what you could **not** verify, and say so plainly in the output. The last round's worst error was repeating the spec's claim that the sandbox could not reach the endpoints, without checking.

### Scratch space

`tools/` does not exist yet. Put throwaway probe scripts there rather than in `tests/`, and keep whichever ones turn out to be worth rerunning.
