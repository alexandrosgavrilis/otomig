# RESEARCH_TILES.md — Phase R

Oct 10, 2026. Deliverable for [HANDOFF_maptileresearch.md](HANDOFF_maptileresearch.md).

Every number below was measured against the live APIs today. The probe scripts
are in [tools/](tools/) and are rerunnable; each claim names the one that
produced it. Where something could not be verified, it says so.

---

## Verdict up front

**The problem Phase R was convened to solve does not exist.**

`1.87 MB/km²` — the figure the whole hybrid proposal rests on — is the size of
Overpass's **decoded JSON**. Overpass serves that JSON gzipped at **7.3–7.8×**,
and a browser always sends `Accept-Encoding: gzip`. The bytes that actually
cross the wire are **0.19–0.25 MB/km²**.

| | HANDOFF §4 estimate | measured on the wire |
| --- | --- | --- |
| 6 km dense (default) | ~66 MB | **6.8 MB** |
| 15 km dense (slider max) | ~420 MB | **34.4 MB** |

Nobody measured transfer; `curl` without `--compressed` and Node's `fetch`
both hide it, the latter by decompressing transparently even when told not to.
Source: [tools/probe-payload.sh](tools/probe-payload.sh),
[tools/probe-region.sh](tools/probe-region.sh).

**The second finding matters more.** Overpass's 504s were never about area.
They were about the `>;` recursion over building geometry nodes. Remove
buildings and the same query serves a box **14× larger** than the one that
"504s every time":

| query | 5 km box | 7.5 km box | 15 km box |
| --- | --- | --- | --- |
| today's, with buildings | **504, every time** | — | — |
| roads + rail + water | 3.86 MB, **1.7 s** | 7.56 MB, 3.1 s | — |
| …plus all POI nodes | — | — | 4.71 MB wire, **13.5 s, one request** |

So **a whole 15 km region's roads, rail, water, stations and every POI node
arrive in a single Overpass request in 13.5 seconds.** The chunk grid, the
adaptive subdivision and 35 of the 36 requests exist to work around a problem
that only buildings cause. Source: [tools/probe-overpass.js](tools/probe-overpass.js),
[tools/probe-split.sh](tools/probe-split.sh).

**Recommendation: restructure the Overpass query. Do not rewrite the data
layer, and do not adopt vector tiles yet.** Details in §8. The vector-tile
work is real, viable and fully costed below — but it buys one thing only
(dense 15 km imports in 30 s instead of 5 min) and it is additive later, so it
does not need to block Phase 3.

---

## 1. Provider and licensing

**Q1.1 — who permits a few-hundred-tile burst?** Two providers do, measured and
in writing. Both answer with `access-control-allow-origin: *` and need no key.

| | OpenFreeMap | Versatiles | Protomaps API |
| --- | --- | --- | --- |
| API key | none | none | **required** — 403 `Missing key query param` |
| stated limit | "no limits on the number of map views or requests" | **`rate=200r/s` per IP** | n/a |
| CORS | `*` | `*` | absent on the keyless 403 |
| commercial use | "Is commercial usage allowed? Yes" | yes | tiered |
| software licence | MIT | MIT | — |
| schema | OpenMapTiles | **Shortbread 1.0** | Protomaps basemap |
| **max zoom** | **14** | **14** | 15 |

Versatiles' limit is not a vague fair-use note — it is in their own nginx
config as `limit_req_zone … rate=200r/s`, returning 429 beyond. An 81-tile
burst at concurrency 6 measured **7 s, zero failures**. That is three orders of
magnitude inside the limit.

Both carry caveats worth recording. Versatiles' own documentation says *"We
can't guarantee 100% uptime: GitHub sponsorships and donations are currently
not high enough to fund 24/7 support"* and *"If you rely on a stable map
server, we highly recommend hosting it yourself"* (historical uptime ~99.99%).
OpenFreeMap offers weekly full-planet downloads for self-hosting.

Sources: [openfreemap.org](https://openfreemap.org),
[docs.versatiles.org](https://docs.versatiles.org/guides/use_tiles_versatiles_org),
[tiles.versatiles.org nginx.conf](https://github.com/versatiles-org/tiles.versatiles.org/blob/main/nginx/nginx.conf),
[tools/probe-tiles.js](tools/probe-tiles.js).

**Q1.2 — is caching the derived region a redistribution problem?** No. The
tile data is OSM under ODbL, and a derived region stored in IndexedDB is a
derivative database used privately — attribution satisfies it, which the footer
already does. The region is **not** part of the exported save (saves are under
20 kB and carry structure only), so nothing is redistributed. Versatiles'
software is MIT; its `osm` tileset is OSM **plus** ESA WorldCover, which adds a
CC BY 4.0 obligation (Q1.4).

**Q1.3 — PMTiles against a public planet archive: measured, and it fails.**
Range requests work perfectly — `HTTP 206`, `accept-ranges: bytes`,
`content-range: bytes 0-16/138736840194` — and dated builds exist for at least
`20261004` through `20261009`. But **no `access-control-allow-origin` header is
present**, so a browser cannot read them. This confirms Protomaps' own warning
rather than contradicting it. The elegant endgame is closed unless we host our
own extract.

**Q1.4 — attribution.** Additive, not replacing:

- OpenFreeMap: `OpenFreeMap © OpenMapTiles Data from OpenStreetMap`
- Versatiles: `© OpenStreetMap contributors · CC BY 4.0 ESA WorldCover 2021`

Neither replaces the existing OSM + Terrarium footer.

---

## 2. Schema — what is actually in the tiles

**Q2.1 — `subclass` is the raw OSM tag value. Confirmed.** One z14 tile over
central Athens carries 7,016 POIs with **202 distinct `subclass` values** and
205 distinct `class`/`subclass` pairs: `shop/doityourself`, `post/post_box`,
`college/university`, `town_hall/courthouse`. `class` is the coarse bucket;
`subclass` is raw. Shortbread is better still — it keeps the original keys
(`shop`, `amenity`, `tourism`, `leisure`, `office`) with no folding at all.

**Q2.2 — POI thinning stops at z14 because z14 is the end of the road.**
Both planet providers report `"maxzoom": 14` in their TileJSON, and z15/z16
return an empty 200 (OpenFreeMap) or 404 (Versatiles). **The "fetch at z15–16
for near-raw detail" premise in HANDOFF §5 is not available.** The good news is
that it was never needed: a z14 tile is 1,928 m across with extent 4096, giving
**0.47 m precision** — still far finer than the 20 m grade sampling and 10 m
occupancy cells.

Recovery, on the same 1 km box as the Overpass ground truth
([tools/probe-compare.js](tools/probe-compare.js)):

| | Overpass | tiles | recovery |
| --- | --- | --- | --- |
| shop + amenity nodes | 1,319 | 1,008 | **76%** |
| distinct kinds | 134 | 81 | — |

The 24% miss is **not** a random sample. Shortbread's `pois` layer uses an
allow-list, so 82 whole kinds vanish: `copyshop`×31, `bookmaker`×19,
`shop=yes`×54, `locksmith`, `electronics`, `variety_store`, `confectionery`,
`cosmetics`, `deli`. OpenMapTiles' `poi` layer is denser than Overpass
(1,889/km² vs 1,558/km²) because it adds bus stops, gates and parks.

**Q2.3 — the premise inverts: tiles carry *more* vertical signal than
Overpass.** Measured on the same 1 km box:

| | share with a real height |
| --- | --- |
| Overpass `building:levels` | **4.7%** |
| Overpass `height` | 2.2% |
| Shortbread `height` ≠ the 5 m default | **14.9%** |

So `render_height` *is* mostly a default (94.1% sit on exactly 5 m across a
6 km region) — but the thing it replaces is defaulted harder. **95.3% of
buildings already fall back to `POPULATION.DEFAULT_LEVELS` in the current
code.** The decision table's "probably fatal to the hybrid" verdict rested on
comparing the tiles against a signal Overpass does not actually have.

OpenFreeMap is a separate story and a disqualifying one: its `building` layer
returned **43 features for a 3.7 km² tile — 12/km² against a ground truth of
1,835/km²**. It carries only buildings with 3D tags. **OpenFreeMap cannot
supply building footprints at all.** Versatiles/Shortbread can: 2,118
buildings against Overpass's 1,830 on the same box.

**Q2.4 — no schema carries a building category, and it matters less than
assumed but not as little as hoped.** In central Athens **82.1% of buildings
are bare `building=yes`** and only **4.3%** carry shop/office/amenity/tourism —
so `classifyBuilding` is already guessing for four buildings in five. But the
thin tail is weighty: running the real model over a 2 km box
([tools/probe-model.js](tools/probe-model.js)), attraction decomposes as

| source | share of all attraction |
| --- | --- |
| non-residential buildings (floor area × category) | **39.3%** |
| residential buildings (× 0.2) | 46.1% |
| POI nodes (× 50) | 14.7% |

Dropping the category is therefore **not** free. Measured consequence: heat-map
correlation falls to **0.601**, none of the top 5 cells survive, and residents
inflate 48%. §4 below says what to do about it.

**Q2.5 — clipped, yes; dedupable, yes, and the id is better than hoped.**
6.1% of building features are duplicates across tile edges at 6 km, 7.4% at
15 km. There is no `osm_id` property, but the **MVT feature id is
`osm_id × 10 + type`** (2 = way, 3 = relation) — verified 50/50 by fetching the
decoded ids back from Overpass and confirming each centre lands within 30 m of
the tile outline. **99.3% of tile building features join to a real OSM
building.** Source: [tools/probe-idjoin.js](tools/probe-idjoin.js).

Two traps found while proving it:

1. Shortbread's `buildings` layer carries **`building:part=*` alongside
   `building=*`**, so a 3D-modelled building contributes its outline *and* each
   of its parts. Taken naively that inflates residents by 20%. Parts have no
   `building=*` way, so they are exactly the set that fails the id join —
   dropping unjoined rings removes the double count for free.
2. When deduping, **keep the largest fragment, not the first one seen.** The
   first may be a clipped sliver, which shrinks the footprint and moves the
   centroid into a different 200 m demand cell.

**Q2.6 — `pedestrian` is distinguished** in Shortbread's `streets.kind`
(`pedestrian`×9 in the sample tile). OpenMapTiles puts it in
`transportation.subclass` rather than `class`. Moot either way — roads stay on
Overpass.

---

## 3. Overpass, roads only

**Q3.1 — the 504s were node recursion, not area. Measured.** Stripping
buildings from the query:

| box | decoded | time | ways | nodes |
| --- | --- | --- | --- | --- |
| 1 km | 0.23 MB | 2.9 s | 321 | 1,250 |
| 2 km | 0.86 MB | 1.3 s | 1,269 | 4,709 |
| **5 km** | 3.86 MB | **1.7 s** | 6,289 | 21,585 |
| 7.5 km | 7.56 MB | 3.1 s | 12,921 | 41,774 |

The 5 km box that returned 504 on every attempt with buildings in the query
now serves in under two seconds. Adding POI nodes back (they need no recursion)
still leaves a whole 15 km box as **one request, 4.71 MB wire, 13.5 s**.

**Q3.2 — `OVERPASS_CHUNK_TARGET_KM` should not apply to the non-building
query at all.** One request covers the slider's maximum. Chunking is only
needed for buildings, and only to keep each `out geom` response small enough
that Overpass does not give up.

**Q3.3 — `building:levels` is not the only thing lost.** `classifyBuilding`
reads `building`, `shop`, `office`, `amenity` and `tourism` off the building
way, and §2.4 shows those drive 39% of attraction. **If building geometry moves
to tiles, building *tags* must still come from Overpass** or the model
degrades measurably. Fortunately they are nearly free there: `way["building"];
out tags;` has no recursion and no geometry — **26.24 MB decoded (~3.5 MB wire)
in 5.0 s for all 274,685 buildings in a 15 km box.**

---

## 4. The attraction model

**Under the recommendation in §8, nothing changes.** Buildings keep their
Overpass tags, POIs keep their raw OSM values, `classifyBuilding`,
`ATTRACTION_WEIGHTS`, `building:levels` and `POINT_ATTRACTION` all stay as they
are. Q4.1 and Q4.2 do not need answering, and that is the most useful result in
this document: **the model was never the blocker, and redesigning it would have
been work done for a payload problem that was a measurement error.**

For the record, if buildings ever do move to tiles, the measurements say:

- **Do not invert the model.** Tile rings *with* Overpass tags joined on the id
  reproduce the heat map at Pearson **0.89** with 9 of the top 10 cells shared.
  Tile rings *without* tags give **0.601** and 0 of the top 5
  ([tools/probe-model-joined.js](tools/probe-model-joined.js),
  [tools/probe-model.js](tools/probe-model.js)).
- **Q4.3, residents:** keep `building:levels` where OSM has it (4.7%), and use
  the tile `height ÷ 3` where it is not the 5 m default (a further 14.9%) — a
  net gain in coverage. Side A yields 19,435 residents/km² for central Athens
  against a real ~20,000, so the current constants are sound.
- **Q4.4:** honestly reported — I could not close the gap between 0.89 and 1.0.
  Per building the geometries agree almost exactly (median area ratio **1.001**,
  median centroid shift **0.6 m**, 0.01% shifted more than 20 m —
  [tools/probe-diff.js](tools/probe-diff.js)), yet the grid correlates 0.89 and
  residents run ~9% high. Part of it is that tiles include multipolygon
  buildings that `way["building"]` misses, which is tiles being *more* complete:
  excluding relations moved correlation from 0.807 to 0.893. The residual ~9% is
  unexplained and is probably an artefact of box-edge handling in my probe
  rather than the architecture. **If tiles are ever adopted, re-verify this
  through the real `processBuildings` rather than trusting my figure.**

---

## 5. Integration and performance

**Q5.1 — there is no cross-source alignment problem. This was the stated
integration risk of the hybrid and it is measurably absent.** Tile building
outlines against Overpass road centrelines, with Overpass's *own* buildings as
the control:

| | within 3 m of a road centreline | worst |
| --- | --- | --- |
| tile buildings | 23.7% | 0.08 m |
| **Overpass buildings (control)** | **26.9%** | 0.07 m |

The rates and the worst cases match, so the overlap is OSM's own geometry, not
a rounding mismatch between sources. **A separate and more important finding
falls out of it:** about a quarter of buildings in a dense city touch a road
centreline *in OSM itself*, whichever source they come from. Phase 4's "track
may not cross a building" rule will therefore block on-street alignments
routinely. That is a Phase 4 design problem, it exists today, and it is
independent of this decision.

**Q5.2 — tiles are months stale; Overpass is live.** The Versatiles build
reports `osmosisreplicationtime 2026-06-07`, built 2026-06-18 — **four months
old**. OpenFreeMap's current version string is `20261004`, six days old. For
building *footprints* staleness is near-harmless (buildings do not move), which
is a point in the hybrid's favour: the stale source would carry the
slowest-changing data. A building added in the last four months would simply be
missing.

**Q5.3 — yes, and with no dependency at all.**
[tools/mvt.js](tools/mvt.js) is a complete MVT decoder in ~230 lines of plain
ESM with zero imports beyond `node:zlib` for the gzip check. MVT is a closed
four-message protobuf schema, so it needs a varint reader and nothing else;
`@mapbox/vector-tile` + `pbf` are general protobuf machinery we would not
otherwise use. Verified against live tiles — geometry round-trips to the
correct lon/lat, and the decoded ids resolve to the right OSM ways. **The
no-build-step rule survives.**

**Q5.4 — decoding is free.** 71 ms per tile. A 6 km region (16 tiles) decodes
in **1.1 s**; a 15 km region (81 tiles) in **1.5 s**.

**Q5.5 — the real unsolved size problem, and it is not about the source.**
Building outlines stored as JSON:

| | per outline | 6 km dense | 15 km dense |
| --- | --- | --- | --- |
| from tiles | 151 B | ~12 MB | **~76 MB** |
| from Overpass | 180 B | ~12 MB | ~76 MB |

A dense 15 km region carries roughly **300,000 building outlines**. The fixture
is 2.2 MB with 1,971. This is the one thing in HANDOFF §4 that remains a
genuine problem after today's measurements, it is **identical for both
sources**, and it was created by the decision to keep and draw footprints —
which is the right decision for the game. It is a storage-encoding problem, not
a data-source problem: packing coordinates into delta-encoded typed arrays
instead of nested JSON arrays is the obvious lever and is worth its own task.

---

## 6. Fallback path

Not pursued, because §8 removes the need. Recorded so the next session does not
re-open it: [extract.bbbike.org](https://extract.bbbike.org) remains the
escape hatch for "Overpass is down", and a Node-side `tools/make-region.js`
emitting the existing `Region` JSON contract is the cheap shape for it, since
the file picker already exists. PMTiles is closed off from the browser by
Q1.3's missing CORS header.

---

## 7. The decision table, filled in

Three of the six branches turned out to rest on premises that measurement
contradicted, so each row says what was asked, what was found, and what
follows.

| If… | Found | Then |
| --- | --- | --- |
| No provider permits a ~200-tile burst (Q1.1) | **Two do.** Versatiles states 200 r/s per IP; 81 tiles measured 7 s, 0 failures | Not a blocker. But the burst is 16–81 tiles, not 200 — maxzoom 14 |
| A schema carries building categories (Q2.4) | **None does** | §4 would be needed *if* tiles supplied buildings — but the category is only 4.3% of buildings and 39% of attraction, so the fix is to join Overpass tags, not to redesign |
| `subclass` is coarse (Q2.1) | **It is raw.** 202 distinct values; Shortbread keeps the original keys | Weights would be fine. Moot — POIs stay on Overpass, where recovery is 100% rather than 76% |
| `render_height` is mostly a default (Q2.3) | **It is — 94.1% at 5 m. But Overpass's `building:levels` is on only 4.7%** | **Not fatal.** The premise was wrong: tiles carry more vertical signal (14.9%) than the thing they replace. 95.3% of buildings already use `DEFAULT_LEVELS` today |
| Roads/buildings misalign by more than a few metres (Q5.1) | **No.** 23.7% vs a 26.9% same-source control; worst case 0.08 m vs 0.07 m | No snapping needed. Separately: Phase 4's building-collision rule will block on-street track ~25% of the time regardless of source |
| A roads-only query serves 5 km chunks (Q3.1) | **It serves a 15 km box in one request, 13.5 s** | **Raise it all the way.** This is the finding that changes the architecture |
| Everything checks out | **The payload problem was a measurement error** | **Do not proceed to Phase D as scoped.** Restructure the query instead — §8 |

---

## 8. Recommendation — **implemented, Oct 10 2026**

Built and verified against the live API the same day. Measured before and after,
central Athens: **5 km went from 5–10 requests and 49–120 s to 2 requests and
22 s; 10 km from 22 requests and 289 s to 6 requests and 123 s.** The region is
identical and the fixture regenerates unchanged.

One thing this document did not anticipate: the retry ladder was fighting the
subdivision logic. `fetchChunk` re-sent a 504'd query four times before
`fetchChunkAdaptive` was ever allowed to split the box, which is most of where
those 22 requests went. 504s now get one retry and then give up so the split can
happen. See HANDOFF.md §3 decision 19.

### Keep one data source. Restructure the query.

Two Overpass requests replace nine to thirty-six:

1. **Everything except buildings** — roads, rail, water, station nodes and all
   shop/amenity POI nodes, with `out body; >; out skel qt` so roads keep their
   shared OSM node ids and the routing graph is untouched.
   *Measured: one request, 4.71 MB wire, 13.5 s, for a whole 15 km box.*
2. **Buildings** — `way["building"]; out geom;`, which inlines each ring and
   skips the node recursion that caused every 504. Chunked only as much as
   reliability needs.
   *Measured: 6.42 MB wire / 12.2 s for a 6 km box, first attempt.*

| | today | restructured |
| --- | --- | --- |
| 6 km dense (default) | 6.8 MB, 9 requests, **4 m 48 s** | ~7.8 MB, **2 requests, ~22 s** |
| 15 km dense | 34.4 MB, 10 requests, 21 sent, **4 m 54 s** | ~34 MB, ~5 requests, ~1–2 min |
| topology | real node ids | unchanged |
| POI fidelity | 100% | unchanged |
| building tags | full | unchanged |
| model, heat map, tests | — | **bit-identical** |
| new dependencies | none | none |

Why this over the hybrid:

- **It is a change to one file.** `buildQuery` splits in two and the chunk grid
  stops applying to the non-building half. No new module, no MVT decoder in the
  runtime, no id join, no fragment dedupe, no `building:part` filter, no second
  licence, no second provider's uptime, no four-month staleness, and no 9%
  unexplained drift in the demand grid.
- **It fixes the thing that was actually broken.** The 504 storms, the adaptive
  subdivision, the "about four wasted minutes before any real work" — all of it
  traces to building node recursion, and all of it goes away.
- **Phase 3 is unblocked without a rewrite.** The one stated overlap in
  HANDOFF §9 was that the occupancy raster's provenance would change if
  buildings moved to tiles. Under this recommendation it does not change at
  all, so trams can start immediately.

The honest cost: a dense **15 km** import lands around one to two minutes
rather than comfortably inside it, and Overpass's transient 504/429s make the
tail unpredictable — 11 retries across 10 requests in today's worst run. That
is the one thing the hybrid genuinely fixes.

### Keep the tile path on the shelf, fully costed

If dense 15 km imports become the thing that matters, the hybrid is viable and
this document contains everything needed to build it: Versatiles z14 for
building geometry, deduped by `osm_id × 10 + type` keeping the largest
fragment, unjoined rings dropped to remove `building:part`, joined to a
`way["building"]; out tags;` query, with [tools/mvt.js](tools/mvt.js) as the
decoder. *Measured end to end at 15 km: ~27 MB, 2 Overpass requests plus 81
CDN requests, **~30 s**.*

It is additive. It changes only where a building's ring comes from, so it can
be added after Phase 3 without redoing anything — which is precisely the
question Phase R was ordered to settle.

### What to do about §5.5 instead

The genuine remaining problem is that a dense 15 km region holds ~300,000
building outlines and ~76 MB of JSON in IndexedDB, identically from either
source. That deserves the attention the payload scare was getting.

---

## 9. What could not be verified

- **The 0.89-vs-1.0 heat-map gap** in §4. The geometries agree per building to
  0.1% of area and 0.6 m of centroid, so the residual is probably my probe's
  box-edge handling, but I did not prove it. It only matters if the tile path
  is adopted.
- **Protomaps' basemap schema** was not inspected. Its API requires a key
  (403 `Missing key query param`) and its public planet builds have no CORS
  header, so neither route was testable. Its `buildings` layer may well carry
  more than Shortbread's.
- **Overpass timing variance is large and I did not characterise it.** The same
  2 km box measured 18.4 s on Oct 10 earlier, then 2.3 s, then 2.7 s. The
  4 m 48 s and 4 m 54 s region figures are single runs and should be read as
  "minutes, unpredictable" rather than as precise numbers.
- **No live import has been run through the game itself.** Everything here is
  `curl` and Node against the same endpoints the worker uses. The browser path
  (`Referer` instead of `User-Agent`, the worker, IndexedDB) is still unproven —
  see HANDOFF §1.

---

## Probe scripts

| | |
| --- | --- |
| [tools/mvt.js](tools/mvt.js) | dependency-free MVT decoder (Q5.3) |
| [tools/probe-tiles.js](tools/probe-tiles.js) | provider survey, layer and field dump |
| [tools/probe-detail.js](tools/probe-detail.js) | building coverage, heights, id stability |
| [tools/probe-overpass.js](tools/probe-overpass.js) | roads-only cost; `building:levels` coverage |
| [tools/probe-payload.sh](tools/probe-payload.sh) | **wire vs decoded bytes by query shape** |
| [tools/probe-region.sh](tools/probe-region.sh) | a whole region import, as shipped |
| [tools/probe-split.sh](tools/probe-split.sh) | Overpass without buildings, at region scale |
| [tools/probe-architecture.sh](tools/probe-architecture.sh) | the candidate, end to end at 15 km |
| [tools/probe-tile-region.js](tools/probe-tile-region.js) | a region's worth of tiles, timed |
| [tools/probe-compare.js](tools/probe-compare.js) | same-box comparison; alignment + control |
| [tools/probe-idjoin.js](tools/probe-idjoin.js) | the `osm_id × 10 + type` id scheme |
| [tools/probe-model.js](tools/probe-model.js) | the model with untagged tile buildings |
| [tools/probe-model-joined.js](tools/probe-model-joined.js) | the model with the id join |
| [tools/probe-diff.js](tools/probe-diff.js) | per-building geometry differences |

`tools/probe-join.js` is superseded by `probe-idjoin.js` and kept only for the
id-encoding dead ends it ruled out.
