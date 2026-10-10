# tools/ — Phase R probes

Research scripts, not part of the game. Nothing in `data/`, `model/`, `sim/`,
`render/` or `ui/` imports from here, and `npm test` does not run them.

They exist because [RESEARCH_TILES.md](../RESEARCH_TILES.md) claims a lot of
numbers and every one of them should be checkable. All of them hit the live
APIs, so they are slow and they will disagree with the recorded figures by a
little — Overpass timing varies by an order of magnitude between runs, and the
tile builds move on.

```bash
bash tools/probe-payload.sh 2      # wire vs decoded bytes by query shape
bash tools/probe-region.sh 6       # a whole region import, as the game does it
bash tools/probe-split.sh          # Overpass without buildings, at region scale
bash tools/probe-architecture.sh 15 3
node tools/probe-tiles.js          # provider survey
node tools/probe-tile-region.js 6 versatiles
node tools/probe-compare.js        # same-box comparison + the alignment control
node tools/probe-idjoin.js         # the osm_id x 10 + type id scheme
node tools/probe-model-joined.js 4 # the demand grid, both sources
```

Two things to know before adding more:

**Node's `fetch` lies about transfer size.** Undici decompresses transparently
and still reports `content-encoding: gzip`, so `arrayBuffer().length` is the
*decoded* size. This is what hid the 7.3x gzip ratio and sent Phase R chasing a
payload problem that did not exist. Measure wire bytes with `curl` writing the
raw body to a file, which is why the payload probes are shell scripts.

**Overpass needs a `User-Agent` from Node** or it answers 406, and it 504s
transiently under load — a single failure means nothing. Every probe here
retries with backoff. The browser is unaffected: it always sends a
`User-Agent`, and the game identifies itself via `Referer`.
