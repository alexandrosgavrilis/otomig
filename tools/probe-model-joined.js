/**
 * Phase R probe: the acceptance test for the recommended architecture.
 *
 * tools/probe-model.js showed that tile outlines WITHOUT tags wreck the heat
 * map (Pearson 0.60, none of the top 5 cells shared) because 39% of attraction
 * comes from the building category. tools/probe-idjoin.js then showed the tile
 * feature id is `osm_id * 10 + type` and joins to Overpass tags at 99.3%.
 *
 * So the real candidate keeps every tag and changes only where the ring comes
 * from. This runs the unmodified population model on both and compares:
 *
 *   Side A — Overpass rings + Overpass tags  (today)
 *   Side C — tile rings + Overpass tags, joined on the id  (recommended)
 *
 * If the heat maps agree, the hybrid costs nothing in model fidelity and the
 * whole of §4 in HANDOFF_maptileresearch.md is moot.
 *
 * Run: node tools/probe-model-joined.js
 */

import { gunzipSync, inflateSync } from 'node:zlib';
import { decodeTile, tileXY, tileToLonLat } from './mvt.js';
import { LocalFrame, ringAreaM2, ringCentroid } from '../model/region.js';
import { classifyBuilding } from '../data/overpass.js';
import { POPULATION, REGION } from '../config.js';

const LON = 23.7275;
const LAT = 37.9838;
const SIZE_KM = Number(process.argv[2]) || 4;
const Z = 14;
/**
 * Shortbread's `buildings` layer carries `building:part=*` polygons alongside
 * `building=*`, so a building modelled in 3D contributes its outline AND each
 * of its parts. Taken naively that double-counts floor area — measured at
 * +20% residents over a 2 km box. A part has no `building=*` way of its own,
 * so it is exactly the set that fails the id join: dropping unjoined rings
 * removes the double count and costs nothing else.
 */
const DROP_UNJOINED = process.env.KEEP_UNJOINED !== '1';
const UA = 'OTOMIG/0.1 Phase R research probe (+https://github.com/alexandrosgavrilis/otomig)';

const dLat = SIZE_KM / 111.32 / 2;
const dLon = SIZE_KM / (111.32 * Math.cos((LAT * Math.PI) / 180)) / 2;
const bbox = [LON - dLon, LAT - dLat, LON + dLon, LAT + dLat];
const frame = new LocalFrame(bbox);
const inBox = (lon, lat) =>
  lon >= bbox[0] && lon <= bbox[2] && lat >= bbox[1] && lat <= bbox[3];

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
        body: query, signal: AbortSignal.timeout(600000),
      });
      if (!r.ok) { process.stdout.write(`[${r.status}]`); await new Promise((s) => setTimeout(s, 4000 * i)); continue; }
      return await r.json();
    } catch { process.stdout.write('[net]'); await new Promise((s) => setTimeout(s, 4000 * i)); }
  }
  throw new Error('Overpass gave up');
}

const bb = `${bbox[1].toFixed(6)},${bbox[0].toFixed(6)},${bbox[3].toFixed(6)},${bbox[2].toFixed(6)}`;

// ── sources ───────────────────────────────────────────────────────────────
const opGeom = await overpass(`[out:json][timeout:300];
way["building"](${bb});
out geom;`);
const opBuildings = (opGeom.elements || []).filter((e) => e.type === 'way' && e.geometry);

const opTags = await overpass(`[out:json][timeout:300];
(
  way["building"](${bb});
  relation["building"](${bb});
);
out tags;`);
const wayTags = new Map((opTags.elements || [])
  .filter((e) => e.type === 'way').map((e) => [e.id, e.tags || {}]));
const relTags = new Map((opTags.elements || [])
  .filter((e) => e.type === 'relation').map((e) => [e.id, e.tags || {}]));

const opPoi = await overpass(`[out:json][timeout:300];
(
  node["shop"](${bb});
  node["amenity"~"^(${POPULATION.POI_AMENITIES.join('|')})$"](${bb});
);
out body;`);
const poiNodes = (opPoi.elements || []).filter((e) => e.type === 'node');

// Tile outlines, deduped by feature id, joined to tags on osm_id*10 + type.
const [x0, y0] = tileXY(bbox[0], bbox[3], Z);
const [x1, y1] = tileXY(bbox[2], bbox[1], Z);
/**
 * A building straddling a tile boundary is clipped into a fragment in each
 * tile, under the same feature id. Taking whichever fragment arrives first
 * shrinks the footprint and — because the demand grid places a building by
 * centroid — can drop it into the wrong 200 m cell. Keeping the largest
 * fragment is the cheap fix; a proper union of the pieces is the exact one.
 * Measured effect of getting this wrong: heat correlation 0.82 instead of the
 * figure this probe reports.
 */
const byId = new Map();
let joined = 0, unjoined = 0;
for (let x = x0; x <= x1; x++) {
  for (let y = y0; y <= y1; y++) {
    const r = await fetch(`https://tiles.versatiles.org/tiles/osm/${Z}/${x}/${y}`,
      { headers: { 'User-Agent': UA } });
    if (!r.ok) continue;
    const b = decodeTile(maybeDecompress(Buffer.from(await r.arrayBuffer()))).buildings;
    if (!b) continue;
    for (const f of b.features) {
      const ring = f.rings[0]?.map(([px, py]) => tileToLonLat(x, y, Z, px, py, b.extent));
      if (!ring || ring.length < 3) continue;
      // WAYS_ONLY=1 drops relation-derived buildings (type 3) so the tile set
      // is apples-to-apples with Overpass's `way["building"]` query, which
      // returns no relations at all. Including them moved heat correlation
      // from 0.893 to 0.807 — not tiles being wrong, tiles being more
      // complete than the pipeline is today.
      if (process.env.WAYS_ONLY === '1' && f.id % 10 !== 2) continue;
      const areaM2 = ringAreaM2(ring, frame);
      const previous = byId.get(f.id);
      if (previous && previous.areaM2 >= areaM2) continue;
      byId.set(f.id, { id: f.id, ring, areaM2, height: f.properties.height });
    }
  }
}

const tileBuildings = [];
for (const entry of byId.values()) {
  const [clon, clat] = ringCentroid(entry.ring);
  if (!inBox(clon, clat)) continue;
  const type = entry.id % 10;
  const osmId = Math.floor(entry.id / 10);
  const tags = (type === 3 ? relTags : wayTags).get(osmId);
  if (tags) joined++; else unjoined++;
  if (!tags && DROP_UNJOINED) continue;
  tileBuildings.push({ ring: entry.ring, tags: tags || {}, height: entry.height });
}

console.log(`=== recommended architecture, acceptance test ` +
  `(${SIZE_KM} km box, central Athens) ===\n`);
console.log(`  Overpass: ${opBuildings.length} rings, ${wayTags.size} way tags, ` +
  `${relTags.size} relation tags, ${poiNodes.length} POI nodes`);
console.log(`  tiles:    ${tileBuildings.length} rings deduped — ` +
  `${joined} joined to tags (${(100 * joined / (joined + unjoined)).toFixed(1)}%), ` +
  `${unjoined} unjoined\n`);

// ── the model, run identically on both ───────────────────────────────────
const cellM = REGION.DEMAND_CELL_M;
const cols = Math.ceil(frame.widthM / cellM);
const rows = Math.ceil(frame.heightM / cellM);
const cellOf = (lon, lat) => {
  const [x, y] = frame.toLocal(lon, lat);
  const col = Math.floor(x / cellM), row = Math.floor(y / cellM);
  return (col < 0 || row < 0 || col >= cols || row >= rows) ? -1 : row * cols + col;
};
function parseLevels(tags) {
  const raw = tags?.['building:levels'];
  if (!raw) return null;
  const v = parseFloat(String(raw).split(/[;,]/)[0]);
  return Number.isFinite(v) && v > 0 && v <= 200 ? v : null;
}

/**
 * `processBuildings` in miniature, taking rings and tags from either source.
 * `heightFallback` lets the tile side use its own height where OSM has no
 * `building:levels` — the one place the tiles add signal rather than lose it.
 */
function run(buildings, { useTileHeight = false } = {}) {
  const residents = new Float64Array(cols * rows);
  const attraction = new Float64Array(cols * rows);
  let total = 0;
  for (const bld of buildings) {
    const ring = bld.ring;
    const areaM2 = ringAreaM2(ring, frame);
    if (areaM2 < 10) continue;
    const [clon, clat] = ringCentroid(ring);
    const index = cellOf(clon, clat);
    if (index < 0) continue;

    let levels = parseLevels(bld.tags);
    if (levels === null && useTileHeight) {
      const h = Number(bld.height);
      // Shortbread fills 5 m where OSM says nothing, so only a different value
      // is real information.
      if (Number.isFinite(h) && h !== 5) levels = Math.max(1, h / 3);
    }
    if (levels === null) levels = POPULATION.DEFAULT_LEVELS;

    const floorArea = areaM2 * levels;
    const { residential, category } = classifyBuilding(bld.tags);
    if (residential) {
      const people = floorArea / POPULATION.M2_PER_RESIDENT;
      residents[index] += people;
      total += people;
      attraction[index] += floorArea * POPULATION.ATTRACTION_WEIGHTS.residential;
    } else {
      attraction[index] += floorArea * (POPULATION.ATTRACTION_WEIGHTS[category] ?? 1.0);
    }
  }
  for (const node of poiNodes) {
    const index = cellOf(node.lon, node.lat);
    if (index >= 0) attraction[index] += POPULATION.POINT_ATTRACTION;
  }
  return { residents, attraction, total };
}

const A = run(opBuildings.map((w) => ({
  ring: w.geometry.map((g) => [g.lon, g.lat]), tags: w.tags || {} })));
const C = run(tileBuildings, { useTileHeight: true });

console.log(`--- residents ---`);
console.log(`  Side A (Overpass rings): ${Math.round(A.total).toLocaleString()} ` +
  `(${Math.round(A.total / (SIZE_KM ** 2)).toLocaleString()}/km²)`);
console.log(`  Side C (tile rings):     ${Math.round(C.total).toLocaleString()} ` +
  `(${Math.round(C.total / (SIZE_KM ** 2)).toLocaleString()}/km²)  ` +
  `${(100 * C.total / A.total - 100).toFixed(1)}% vs A`);

function pearson(p, q) {
  const n = p.length;
  const mp = p.reduce((a, v) => a + v, 0) / n;
  const mq = q.reduce((a, v) => a + v, 0) / n;
  let num = 0, dp = 0, dq = 0;
  for (let i = 0; i < n; i++) {
    num += (p[i] - mp) * (q[i] - mq); dp += (p[i] - mp) ** 2; dq += (q[i] - mq) ** 2;
  }
  return num / Math.sqrt(dp * dq);
}
const heat = (g) => Array.from(g.residents, (v, i) => v + g.attraction[i]);
const hA = heat(A), hC = heat(C);

console.log(`\n--- Q4.4, the heat map ---`);
console.log(`  grid ${cols}x${rows}, ${cellM} m cells`);
console.log(`  Pearson correlation:  ${pearson(hA, hC).toFixed(4)}`);
console.log(`  residents correlation: ${pearson(Array.from(A.residents), Array.from(C.residents)).toFixed(4)}`);
console.log(`  attraction correlation:${pearson(Array.from(A.attraction), Array.from(C.attraction)).toFixed(4)}`);

const rank = (h) => h.map((v, i) => [i, v]).sort((p, q) => q[1] - p[1]).map(([i]) => i);
const rA = rank(hA), rC = rank(hC);
for (const k of [5, 10, 20, 50]) {
  const top = new Set(rA.slice(0, k));
  const shared = rC.slice(0, k).filter((i) => top.has(i)).length;
  console.log(`  top-${String(k).padStart(2)} hottest cells shared: ${shared}/${k} ` +
    `(${(100 * shared / k).toFixed(0)}%)`);
}
console.log(`\n  for comparison, tile rings with NO tags (tools/probe-model.js):`);
console.log(`    Pearson 0.601, top-5 shared 0/5, residents +48%`);
