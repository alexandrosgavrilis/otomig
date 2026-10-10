/**
 * Phase R probe: fetch one real vector tile from each candidate provider over
 * central Athens and dump what is actually in it.
 *
 * Answers Q2.1–Q2.6. Run: node tools/probe-tiles.js [zoom]
 *
 * The sample point is the same 1 km box used for the Overpass measurements in
 * HANDOFF.md §4, so counts here are comparable to that ground truth:
 * 23.7275, 37.9838 → 1.88 MB, 1,835 buildings, 1,334 kept POI nodes.
 */

import { gunzipSync, inflateSync } from 'node:zlib';
import { decodeTile, tileXY } from './mvt.js';

const LON = 23.7275;
const LAT = 37.9838;
const UA = 'OTOMIG/0.1 Phase R research probe (+https://github.com/alexandrosgavrilis/otomig)';

const PROVIDERS = [
  {
    name: 'OpenFreeMap',
    schema: 'OpenMapTiles (shortbread-ish fork)',
    url: (z, x, y) => `https://tiles.openfreemap.org/planet/20250122_001001_pt/${z}/${x}/${y}.pbf`,
  },
  {
    name: 'Versatiles',
    schema: 'Shortbread',
    url: (z, x, y) => `https://tiles.versatiles.org/tiles/osm/${z}/${x}/${y}`,
  },
  {
    name: 'Protomaps (api, keyless attempt)',
    schema: 'Protomaps basemap',
    url: (z, x, y) => `https://api.protomaps.com/tiles/v4/${z}/${x}/${y}.mvt`,
  },
];

/** Tiles are often served gzipped or deflated regardless of Accept-Encoding. */
function maybeDecompress(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
  if (buf[0] === 0x78) return inflateSync(buf);
  return buf;
}

async function fetchTile(url) {
  const started = Date.now();
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  const bytes = Buffer.from(await response.arrayBuffer());
  return {
    status: response.status,
    ms: Date.now() - started,
    bytes,
    cors: response.headers.get('access-control-allow-origin'),
    type: response.headers.get('content-type'),
    encoding: response.headers.get('content-encoding'),
  };
}

/** Distinct values of a property across a layer, with counts, most common first. */
function tally(features, key) {
  const counts = new Map();
  for (const f of features) {
    const v = f.properties[key];
    const k = v === undefined ? '(absent)' : String(v);
    counts.set(k, (counts.get(k) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

async function probe(provider, z) {
  const [x, y] = tileXY(LON, LAT, z);
  const url = provider.url(z, x, y);
  console.log(`\n${'='.repeat(78)}\n${provider.name}  z${z}/${x}/${y}\n  ${url}`);

  let result;
  try {
    result = await fetchTile(url);
  } catch (error) {
    console.log(`  FETCH FAILED: ${error.message}`);
    return null;
  }

  console.log(`  HTTP ${result.status}  ${(result.bytes.length / 1024).toFixed(1)} KB  ` +
    `${result.ms} ms  type=${result.type}  cors=${result.cors}`);
  if (result.status !== 200) {
    console.log(`  body: ${result.bytes.toString('utf8').slice(0, 200)}`);
    return null;
  }

  let layers;
  try {
    layers = decodeTile(maybeDecompress(result.bytes));
  } catch (error) {
    console.log(`  DECODE FAILED: ${error.message}`);
    return null;
  }

  console.log(`  layers: ${Object.keys(layers).length}`);
  for (const [name, layer] of Object.entries(layers)) {
    const keys = new Set();
    for (const f of layer.features) for (const k of Object.keys(f.properties)) keys.add(k);
    console.log(`    ${name.padEnd(22)} ${String(layer.features.length).padStart(5)} feat  ` +
      `extent ${layer.extent}  v${layer.version}  keys: ${[...keys].sort().join(', ') || '(none)'}`);
  }
  return { provider, z, x, y, layers, result };
}

const zoomArg = Number(process.argv[2]);
const zooms = Number.isFinite(zoomArg) ? [zoomArg] : [14, 15, 16];

const found = [];
for (const provider of PROVIDERS) {
  for (const z of zooms) {
    const out = await probe(provider, z);
    if (out) found.push(out);
  }
}

// Detail dump for whichever providers answered: the three questions that decide
// the hybrid — POI subclass granularity, building heights, and dedupe ids.
for (const { provider, z, layers } of found) {
  console.log(`\n${'-'.repeat(78)}\nDETAIL — ${provider.name} z${z}`);

  for (const poiName of ['poi', 'pois', 'place', 'poi_label']) {
    const poi = layers[poiName];
    if (!poi) continue;
    console.log(`  [${poiName}] ${poi.features.length} features`);
    for (const key of ['class', 'subclass', 'rank', 'kind', 'amenity', 'shop']) {
      const t = tally(poi.features, key);
      if (t.length === 1 && t[0][0] === '(absent)') continue;
      console.log(`    ${key} (${t.length} distinct): ` +
        t.slice(0, 40).map(([v, n]) => `${v}×${n}`).join(' '));
    }
  }

  for (const bName of ['building', 'buildings']) {
    const b = layers[bName];
    if (!b) continue;
    const heights = b.features.map((f) => f.properties.render_height ??
      f.properties.height ?? f.properties.levels ?? null);
    const real = heights.filter((h) => h !== null);
    const distinct = [...new Set(real)].sort((p, q) => p - q);
    console.log(`  [${bName}] ${b.features.length} features; ` +
      `${real.length} with a height value (${distinct.length} distinct)`);
    console.log(`    height histogram: ` + tally(b.features, 'render_height')
      .slice(0, 12).map(([v, n]) => `${v}×${n}`).join(' '));
    const withId = b.features.filter((f) => f.id !== null && f.id !== 0).length;
    console.log(`    feature ids present: ${withId}/${b.features.length}; ` +
      `osm_id property: ${b.features.filter((f) => 'osm_id' in f.properties).length}`);
    // Clipping: a ring touching 0 or extent is cut at the tile edge.
    let clipped = 0;
    for (const f of b.features) {
      const touches = f.rings.some((r) => r.some(([px, py]) =>
        px <= 0 || py <= 0 || px >= b.extent || py >= b.extent));
      if (touches) clipped++;
    }
    console.log(`    features touching the tile edge (clipped): ${clipped}`);
  }

  for (const tName of ['transportation', 'streets']) {
    const t = layers[tName];
    if (!t) continue;
    const classes = tally(t.features, 'class').concat(tally(t.features, 'kind'))
      .filter(([v]) => v !== '(absent)');
    console.log(`  [${tName}] ${t.features.length} features; classes: ` +
      classes.map(([v, n]) => `${v}×${n}`).join(' '));
  }
}
