/**
 * Phase R probe, round two: the specific questions the first round raised.
 *
 *   - OpenFreeMap's building layer returned only 43 features for a z14 tile of
 *     central Athens, where Overpass finds ~6,800. Was that the stale version
 *     string, or is it real?
 *   - Versatiles/Shortbread building height: which key, and how many have one?
 *   - Are feature ids stable across tile boundaries, so a clipped building can
 *     be deduped? (Q2.5)
 *   - Ground-truth POI counts per class against Overpass for the same box.
 *
 * Run: node tools/probe-detail.js
 */

import { gunzipSync, inflateSync } from 'node:zlib';
import { decodeTile, tileXY, tileToLonLat } from './mvt.js';

const LON = 23.7275;
const LAT = 37.9838;
const UA = 'OTOMIG/0.1 Phase R research probe (+https://github.com/alexandrosgavrilis/otomig)';

const SOURCES = {
  'openfreemap-current': (z, x, y) =>
    `https://tiles.openfreemap.org/planet/20261004_113936_pt/${z}/${x}/${y}.pbf`,
  'openfreemap-stale': (z, x, y) =>
    `https://tiles.openfreemap.org/planet/20250122_001001_pt/${z}/${x}/${y}.pbf`,
  versatiles: (z, x, y) => `https://tiles.versatiles.org/tiles/osm/${z}/${x}/${y}`,
};

function maybeDecompress(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
  if (buf[0] === 0x78) return inflateSync(buf);
  return buf;
}

async function getTile(source, z, x, y) {
  const url = SOURCES[source](z, x, y);
  const started = Date.now();
  const response = await fetch(url, { headers: { 'User-Agent': UA } });
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!response.ok) return { status: response.status, bytes: bytes.length, layers: null };
  return {
    status: response.status,
    bytes: bytes.length,
    ms: Date.now() - started,
    layers: bytes.length ? decodeTile(maybeDecompress(bytes)) : {},
  };
}

function tally(features, key) {
  const counts = new Map();
  for (const f of features) {
    const v = f.properties[key];
    if (v === undefined) continue;
    counts.set(String(v), (counts.get(String(v)) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]);
}

// ── 1. Building counts: both OpenFreeMap versions and Versatiles ────────────
console.log('=== Q2.3/Q2.4 — building layer coverage, z14 central Athens ===');
const [tx, ty] = tileXY(LON, LAT, 14);
const tileKm2 = (1927 / 1000) ** 2;

for (const source of Object.keys(SOURCES)) {
  const tile = await getTile(source, 14, tx, ty);
  if (!tile.layers) { console.log(`${source}: HTTP ${tile.status}`); continue; }
  const b = tile.layers.building || tile.layers.buildings;
  if (!b) { console.log(`${source}: no building layer`); continue; }

  console.log(`\n${source}: ${(tile.bytes / 1024).toFixed(0)} KB tile, ` +
    `${b.features.length} buildings = ${Math.round(b.features.length / tileKm2)}/km² ` +
    `(Overpass ground truth: 1,835/km²)`);

  for (const key of ['render_height', 'height', 'min_height', 'render_min_height',
    'levels', 'dummy', 'colour', 'hide_3d']) {
    const present = b.features.filter((f) => key in f.properties).length;
    if (!present) continue;
    const t = tally(b.features, key);
    console.log(`  ${key}: present on ${present}/${b.features.length} ` +
      `(${(100 * present / b.features.length).toFixed(1)}%), ${t.length} distinct` +
      (t.length <= 14 ? ` → ${t.map(([v, n]) => `${v}×${n}`).join(' ')}`
        : ` → top: ${t.slice(0, 10).map(([v, n]) => `${v}×${n}`).join(' ')}`));
  }

  // Are the heights real, or one filled-in default? Look at the share sitting
  // on the single most common value.
  const h = tally(b.features, 'render_height').concat(tally(b.features, 'height'));
  if (h.length) {
    const total = h.reduce((a, [, n]) => a + n, 0);
    console.log(`  modal height ${h[0][0]} m covers ${(100 * h[0][1] / total).toFixed(1)}% ` +
      `of buildings with a height`);
  }
}

// ── 2. Id stability across the tile boundary (Q2.5) ─────────────────────────
console.log(`\n=== Q2.5 — clipped buildings: is there an id to dedupe on? ===`);
for (const source of ['openfreemap-current', 'versatiles']) {
  const left = await getTile(source, 14, tx, ty);
  const right = await getTile(source, 14, tx + 1, ty);
  const lb = left.layers?.building || left.layers?.buildings;
  const rb = right.layers?.building || right.layers?.buildings;
  if (!lb || !rb) { console.log(`${source}: no building layer`); continue; }

  const leftIds = new Set(lb.features.map((f) => f.id));
  const shared = rb.features.filter((f) => leftIds.has(f.id));
  // A building clipped by the shared edge appears in both tiles. Count how many
  // features in each tile touch that shared edge.
  const onRightEdge = lb.features.filter((f) =>
    f.rings.some((r) => r.some(([px]) => px >= lb.extent))).length;
  const onLeftEdge = rb.features.filter((f) =>
    f.rings.some((r) => r.some(([px]) => px <= 0))).length;

  console.log(`\n${source}: ${lb.features.length} + ${rb.features.length} buildings; ` +
    `${onRightEdge} touch the shared edge from the left tile, ${onLeftEdge} from the right`);
  console.log(`  feature ids shared between the two tiles: ${shared.length}`);
  console.log(`  id range: ${Math.min(...lb.features.map((f) => f.id))} … ` +
    `${Math.max(...lb.features.map((f) => f.id))}`);
  console.log(`  ids unique within a tile: ${leftIds.size}/${lb.features.length}`);
}

// ── 3. POI counts and granularity vs Overpass ground truth ─────────────────
console.log(`\n=== Q2.1/Q2.2 — POI granularity and count ===`);
for (const source of ['openfreemap-current', 'versatiles']) {
  const tile = await getTile(source, 14, tx, ty);
  const poi = tile.layers?.poi || tile.layers?.pois;
  if (!poi) continue;
  console.log(`\n${source}: ${poi.features.length} POIs = ` +
    `${Math.round(poi.features.length / tileKm2)}/km²`);

  // Shortbread keeps the raw OSM keys; OpenMapTiles folds them into subclass.
  if (poi.features[0] && 'subclass' in poi.features[0].properties) {
    const sub = tally(poi.features, 'subclass');
    console.log(`  subclass: ${sub.length} distinct`);
    const cls = tally(poi.features, 'class');
    console.log(`  class: ${cls.length} distinct`);
    // Does class ever differ from subclass in a way that proves subclass is raw?
    const pairs = new Set(poi.features.map((f) =>
      `${f.properties.class}/${f.properties.subclass}`));
    console.log(`  distinct class/subclass pairs: ${pairs.size}`);
    console.log(`  sample: ${[...pairs].slice(0, 25).join('  ')}`);
  } else {
    for (const key of ['shop', 'amenity', 'tourism', 'office', 'leisure', 'highway']) {
      const t = tally(poi.features, key);
      if (t.length) console.log(`  ${key}: ${t.length} distinct, ${t.reduce((a, [, n]) => a + n, 0)} features`);
    }
  }
}

// ── 4. Does the geometry decode to sane lon/lat? Sanity check the decoder. ──
console.log(`\n=== decoder sanity: first building centroid in lon/lat ===`);
const vt = await getTile('versatiles', 14, tx, ty);
const vb = vt.layers.buildings;
const ring = vb.features[0].rings[0];
const mid = ring[0];
console.log(`  tile-local ${mid} (extent ${vb.extent}) → ` +
  tileToLonLat(tx, ty, 14, mid[0], mid[1], vb.extent).map((v) => v.toFixed(5)).join(', '));
console.log(`  tile covers lon ${tileToLonLat(tx, ty, 14, 0, 0, vb.extent)[0].toFixed(4)} … ` +
  `${tileToLonLat(tx, ty, 14, vb.extent, 0, vb.extent)[0].toFixed(4)}, sample point lon ${LON}`);
