/**
 * Phase R probe: a whole region's worth of vector tiles, measured the same way
 * tools/probe-region.sh measures Overpass — wire bytes and wall clock.
 *
 * Answers Q5.4 (decode time), Q2.2 (POI recovery against Overpass ground
 * truth), Q2.5 (dedupe across tile edges in practice) and the request-burst
 * half of Q1.1.
 *
 * Both planet providers cap at zoom 14 (confirmed from their TileJSON), so the
 * grid is z14 regardless of what HANDOFF.md §5 assumed.
 *
 * Run: node tools/probe-tile-region.js [sizeKm] [provider]
 */

import { gunzipSync, inflateSync } from 'node:zlib';
import { decodeTile, tileXY, tileToLonLat } from './mvt.js';

const SIZE_KM = Number(process.argv[2]) || 6;
const WHICH = process.argv[3] || 'versatiles';
const LON = 23.7275;
const LAT = 37.9838;
const Z = 14;
const CONCURRENCY = 6;
const UA = 'OTOMIG/0.1 Phase R research probe (+https://github.com/alexandrosgavrilis/otomig)';

const PROVIDERS = {
  versatiles: (z, x, y) => `https://tiles.versatiles.org/tiles/osm/${z}/${x}/${y}`,
  openfreemap: (z, x, y) =>
    `https://tiles.openfreemap.org/planet/20261004_113936_pt/${z}/${x}/${y}.pbf`,
};

function maybeDecompress(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
  if (buf[0] === 0x78) return inflateSync(buf);
  return buf;
}

/** The tile range covering a square region, the same bbox the game would use. */
function tileRange(lon, lat, sizeKm, z) {
  const dLat = sizeKm / 111.32 / 2;
  const dLon = sizeKm / (111.32 * Math.cos((lat * Math.PI) / 180)) / 2;
  const [x0, y0] = tileXY(lon - dLon, lat + dLat, z);  // NW
  const [x1, y1] = tileXY(lon + dLon, lat - dLat, z);  // SE
  const tiles = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push([x, y]);
  return { tiles, bbox: [lon - dLon, lat - dLat, lon + dLon, lat + dLat] };
}

/** Run `work` over `items` with a fixed number of workers in flight. */
async function pooled(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: limit }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await work(items[i], i);
    }
  }));
  return results;
}

const { tiles, bbox } = tileRange(LON, LAT, SIZE_KM, Z);
const url = PROVIDERS[WHICH];
const tileSpanM = (156543.03 * Math.cos((LAT * Math.PI) / 180) / 2 ** Z) * 256;

console.log(`=== ${WHICH}, ${SIZE_KM} km region at central Athens, z${Z} ===`);
console.log(`    ${tiles.length} tiles, ${Math.round(tileSpanM)} m span each, ` +
  `precision ${(tileSpanM / 4096).toFixed(2)} m`);
console.log(`    bbox ${bbox.map((v) => v.toFixed(4)).join(', ')}`);
console.log(`    concurrency ${CONCURRENCY}\n`);

const startFetch = Date.now();
let wireTotal = 0;
let failures = 0;

const fetched = await pooled(tiles, CONCURRENCY, async ([x, y]) => {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await fetch(url(Z, x, y), {
        headers: { 'User-Agent': UA },
        signal: AbortSignal.timeout(60000),
      });
      if (!response.ok) {
        if (response.status === 404) return { x, y, bytes: null, status: 404 };
        await new Promise((r) => setTimeout(r, 1000 * attempt));
        continue;
      }
      const bytes = Buffer.from(await response.arrayBuffer());
      wireTotal += bytes.length;
      return { x, y, bytes, status: 200 };
    } catch {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
  failures++;
  return { x, y, bytes: null, status: 0 };
});

const fetchMs = Date.now() - startFetch;
console.log(`  fetch: ${(wireTotal / 1048576).toFixed(2)} MB wire, ` +
  `${(fetchMs / 1000).toFixed(1)}s, ${failures} failed, ` +
  `${fetched.filter((f) => f.status === 404).length} empty (404)`);

// ── decode (Q5.4) ──────────────────────────────────────────────────────────
const startDecode = Date.now();
let decodedBytes = 0;
const buildingIds = new Set();
const poiIds = new Set();
let buildingFeatures = 0;
let poiFeatures = 0;
let ringPoints = 0;
const poiKinds = new Map();
const heightValues = new Map();

for (const tile of fetched) {
  if (!tile.bytes || !tile.bytes.length) continue;
  const plain = maybeDecompress(tile.bytes);
  decodedBytes += plain.length;
  const layers = decodeTile(plain);

  const b = layers.buildings || layers.building;
  if (b) {
    for (const f of b.features) {
      buildingFeatures++;
      buildingIds.add(f.id);
      for (const r of f.rings) ringPoints += r.length;
      const h = f.properties.height ?? f.properties.render_height;
      if (h !== undefined) heightValues.set(String(h), (heightValues.get(String(h)) || 0) + 1);
    }
  }

  const p = layers.pois || layers.poi;
  if (p) {
    for (const f of p.features) {
      poiFeatures++;
      poiIds.add(f.id);
      // Shortbread keeps raw OSM keys; OpenMapTiles folds them into subclass.
      const kind = f.properties.subclass ?? f.properties.shop ?? f.properties.amenity ??
        f.properties.tourism ?? f.properties.leisure ?? f.properties.office ?? '(other)';
      poiKinds.set(String(kind), (poiKinds.get(String(kind)) || 0) + 1);
    }
  }
}
const decodeMs = Date.now() - startDecode;

const areaKm2 = SIZE_KM * SIZE_KM;
console.log(`  decode: ${(decodeMs)} ms for ${(decodedBytes / 1048576).toFixed(1)} MB ` +
  `decompressed (${(decodeMs / tiles.length).toFixed(1)} ms/tile)`);
console.log(`  gzip ratio on the wire: ${(decodedBytes / wireTotal).toFixed(1)}x\n`);

console.log(`  buildings: ${buildingFeatures} features, ${buildingIds.size} distinct ids ` +
  `→ ${buildingFeatures - buildingIds.size} duplicates across tile edges ` +
  `(${(100 * (buildingFeatures - buildingIds.size) / buildingFeatures).toFixed(1)}%)`);
console.log(`             ${Math.round(buildingIds.size / areaKm2)}/km² ` +
  `(Overpass ground truth 1,835/km² in the dense centre)`);
console.log(`             ${ringPoints} ring points total, ` +
  `${(ringPoints / buildingFeatures).toFixed(1)} per building`);

const heights = [...heightValues.entries()].sort((a, b) => b[1] - a[1]);
const heightTotal = heights.reduce((a, [, n]) => a + n, 0);
if (heights.length) {
  console.log(`             height: modal ${heights[0][0]} m on ` +
    `${(100 * heights[0][1] / heightTotal).toFixed(1)}% — ` +
    `${heights.length} distinct values`);
}

console.log(`\n  POIs: ${poiFeatures} features, ${poiIds.size} distinct ids ` +
  `→ ${Math.round(poiIds.size / areaKm2)}/km² ` +
  `(Overpass kept 1,334/km² shop+amenity in the dense centre)`);
console.log(`        ${poiKinds.size} distinct kinds; top 20:`);
console.log(`        ` + [...poiKinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  .map(([k, n]) => `${k}×${n}`).join(' '));

console.log(`\n=== against the measured Overpass import of the same region ===`);
console.log(`  Overpass, 6 km Athens: 6.8 MB wire, 9 requests, 4m 48s wall clock`);
console.log(`  ${WHICH}, same box:    ${(wireTotal / 1048576).toFixed(1)} MB wire, ` +
  `${tiles.length} requests, ${(fetchMs / 1000).toFixed(0)}s wall clock ` +
  `+ ${(decodeMs / 1000).toFixed(1)}s decode`);
