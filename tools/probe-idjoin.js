/**
 * Phase R probe: nail down how tile geometry joins to Overpass building tags.
 *
 * tools/probe-join.js found the tile feature id is not the bare OSM way id, and
 * that dividing by 10 matched only 43%. The id-mod-10 histogram was {2: 330,
 * 3: 70}, which looks like `osm_id * 10 + type` with 2 = way and 3 = relation —
 * 17.5% relations matches OSM's share of multipolygon buildings. This tests
 * that hypothesis cleanly, split by type, and falls back to a centroid join if
 * the id route does not hold.
 *
 * Run: node tools/probe-idjoin.js
 */

import { gunzipSync, inflateSync } from 'node:zlib';
import { decodeTile, tileXY, tileToLonLat } from './mvt.js';

const LON = 23.7275;
const LAT = 37.9838;
const Z = 14;
const UA = 'OTOMIG/0.1 Phase R research probe (+https://github.com/alexandrosgavrilis/otomig)';
const M_PER_DEG_LAT = 111320;
const M_PER_DEG_LON = 111320 * Math.cos((LAT * Math.PI) / 180);

function maybeDecompress(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
  if (buf[0] === 0x78) return inflateSync(buf);
  return buf;
}

async function overpass(query, attempts = 10) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'text/plain' },
        body: query,
        signal: AbortSignal.timeout(600000),
      });
      if (!r.ok) { process.stdout.write(`[${r.status}]`); await new Promise((s) => setTimeout(s, 4000 * i)); continue; }
      return await r.json();
    } catch (e) { process.stdout.write('[net]'); await new Promise((s) => setTimeout(s, 4000 * i)); }
  }
  throw new Error('Overpass gave up');
}

// ── tile side ─────────────────────────────────────────────────────────────
const [tx, ty] = tileXY(LON, LAT, Z);
const r = await fetch(`https://tiles.versatiles.org/tiles/osm/${Z}/${tx}/${ty}`,
  { headers: { 'User-Agent': UA } });
const layers = decodeTile(maybeDecompress(Buffer.from(await r.arrayBuffer())));
const b = layers.buildings;

const tileFeatures = b.features.map((f) => {
  const ring = f.rings[0].map(([px, py]) => tileToLonLat(tx, ty, Z, px, py, b.extent));
  let cx = 0, cy = 0;
  for (const [lo, la] of ring) { cx += lo; cy += la; }
  return { id: f.id, type: f.id % 10, osmId: Math.floor(f.id / 10),
    lon: cx / ring.length, lat: cy / ring.length };
});

const byType = new Map();
for (const f of tileFeatures) byType.set(f.type, (byType.get(f.type) || 0) + 1);
console.log(`=== tile feature ids, one z14 tile, ${tileFeatures.length} buildings ===`);
console.log(`  id mod 10: ` + [...byType.entries()].sort()
  .map(([k, n]) => `${k}→${n} (${(100 * n / tileFeatures.length).toFixed(1)}%)`).join('  '));

// ── hypothesis: id = osm_id * 10 + type, 2 = way, 3 = relation ───────────
console.log(`\n=== testing id = osm_id*10 + type ===`);
for (const type of [...byType.keys()].sort()) {
  const subset = tileFeatures.filter((f) => f.type === type).slice(0, 50);
  const kind = type === 2 ? 'way' : type === 3 ? 'relation' : 'way';
  const out = await overpass(`[out:json][timeout:180];
${kind}(id:${subset.map((f) => f.osmId).join(',')});
out tags center;`);
  const got = new Map((out.elements || []).filter((e) => e.center).map((e) => [e.id, e]));

  let exists = 0, near = 0, isBuilding = 0;
  let worst = 0;
  for (const f of subset) {
    const el = got.get(f.osmId);
    if (!el) continue;
    exists++;
    if (el.tags?.building) isBuilding++;
    const dM = Math.hypot((el.center.lon - f.lon) * M_PER_DEG_LON,
      (el.center.lat - f.lat) * M_PER_DEG_LAT);
    if (dM < 30) { near++; if (dM > worst) worst = dM; }
  }
  console.log(`  type ${type} as ${kind}: ${exists}/${subset.length} exist, ` +
    `${isBuilding} tagged building=*, ${near} within 30 m ` +
    `(worst matched ${worst.toFixed(1)} m)`);
}

// ── full-tile join, both routes, against a bbox-matched tag table ────────
// The tile covers more than its own bbox once clipped features are counted, so
// the tag table is fetched for a box a little larger than the tile.
const pad = 1.3;
const spanLon = (360 / 2 ** Z) * pad;
const spanLat = spanLon * Math.cos((LAT * Math.PI) / 180);
const [w0, n0] = tileToLonLat(tx, ty, Z, 0, 0, b.extent);
const [e0, s0] = tileToLonLat(tx, ty, Z, b.extent, b.extent, b.extent);
const bb = `${(s0 - (n0 - s0) * 0.15).toFixed(6)},${(w0 - (e0 - w0) * 0.15).toFixed(6)},` +
  `${(n0 + (n0 - s0) * 0.15).toFixed(6)},${(e0 + (e0 - w0) * 0.15).toFixed(6)}`;

console.log(`\n=== full-tile join against Overpass tags for the same box (+15% pad) ===`);
const tagsOut = await overpass(`[out:json][timeout:300];
(
  way["building"](${bb});
  relation["building"](${bb});
);
out tags center;`);
const elements = (tagsOut.elements || []);
const wayTags = new Map(elements.filter((e) => e.type === 'way').map((e) => [e.id, e]));
const relTags = new Map(elements.filter((e) => e.type === 'relation').map((e) => [e.id, e]));
console.log(`  Overpass: ${wayTags.size} building ways, ${relTags.size} building relations`);

let idMatched = 0, idWrongPlace = 0;
for (const f of tileFeatures) {
  const table = f.type === 3 ? relTags : wayTags;
  const el = table.get(f.osmId);
  if (!el) continue;
  if (!el.center) { idMatched++; continue; }
  const dM = Math.hypot((el.center.lon - f.lon) * M_PER_DEG_LON,
    (el.center.lat - f.lat) * M_PER_DEG_LAT);
  if (dM < 30) idMatched++; else idWrongPlace++;
}
console.log(`  id join (osm_id*10 + type): ${idMatched}/${tileFeatures.length} matched ` +
  `(${(100 * idMatched / tileFeatures.length).toFixed(1)}%), ` +
  `${idWrongPlace} matched an id but the wrong place`);

// ── fallback: centroid join, which needs no knowledge of the id scheme ───
const CELL_M = 20;
const grid = new Map();
const key = (c, rr) => `${c},${rr}`;
for (const el of elements) {
  if (!el.center) continue;
  const x = el.center.lon * M_PER_DEG_LON;
  const y = el.center.lat * M_PER_DEG_LAT;
  const k = key(Math.floor(x / CELL_M), Math.floor(y / CELL_M));
  if (!grid.has(k)) grid.set(k, []);
  grid.get(k).push({ el, x, y });
}

let centroidMatched = 0;
let sumD = 0;
const TOLERANCE_M = 8;
for (const f of tileFeatures) {
  const x = f.lon * M_PER_DEG_LON;
  const y = f.lat * M_PER_DEG_LAT;
  const c = Math.floor(x / CELL_M), rr = Math.floor(y / CELL_M);
  let best = null, bestD = Infinity;
  for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
    for (const cand of grid.get(key(c + dc, rr + dr)) || []) {
      const d = Math.hypot(cand.x - x, cand.y - y);
      if (d < bestD) { bestD = d; best = cand; }
    }
  }
  if (best && bestD < TOLERANCE_M) { centroidMatched++; sumD += bestD; }
}
console.log(`  centroid join (<=${TOLERANCE_M} m): ${centroidMatched}/${tileFeatures.length} ` +
  `matched (${(100 * centroidMatched / tileFeatures.length).toFixed(1)}%), ` +
  `mean offset ${(sumD / Math.max(1, centroidMatched)).toFixed(2)} m`);

console.log(`\n  note: the tile carries ${tileFeatures.length} features for a box holding ` +
  `${wayTags.size + relTags.size} OSM buildings —`);
console.log(`  the excess is building:part and edge-clipped duplicates, which is why`);
console.log(`  neither join can reach 100% and why the match rate is the wrong metric.`);
console.log(`  What matters is the reverse: what share of OSM buildings found an outline.`);

const matchedIds = new Set();
for (const f of tileFeatures) {
  const table = f.type === 3 ? relTags : wayTags;
  if (table.has(f.osmId)) matchedIds.add(`${f.type}/${f.osmId}`);
}
const osmTotal = wayTags.size + relTags.size;
console.log(`  OSM buildings that found a tile outline by id: ${matchedIds.size}/${osmTotal} ` +
  `(${(100 * matchedIds.size / osmTotal).toFixed(1)}%)`);
