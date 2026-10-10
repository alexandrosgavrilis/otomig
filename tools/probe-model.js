/**
 * Phase R probe: run the real population model both ways on real data.
 *
 * Answers §4 (Q4.1–Q4.4) with a measurement instead of a proposal. The
 * question is what the demand grid loses when building footprints arrive from
 * vector tiles — i.e. with a height but no OSM tags — instead of from Overpass.
 *
 * Side A: today's pipeline. Overpass buildings with full tags, classifyBuilding,
 *         floor area x category weight, building:levels or DEFAULT_LEVELS.
 * Side B: the candidate. Tile buildings (outline + height, no tags), POI nodes
 *         from Overpass carrying all the attraction.
 *
 * Both sides are scored on the thing that actually matters: where the heat map
 * points. If the top unserved cells are the same places, the model survives.
 *
 * Run: node tools/probe-model.js
 */

import { gunzipSync, inflateSync } from 'node:zlib';
import { decodeTile, tileXY, tileToLonLat } from './mvt.js';
import { LocalFrame, ringAreaM2, ringCentroid } from '../model/region.js';
import { classifyBuilding } from '../data/overpass.js';
import { POPULATION, REGION } from '../config.js';

const LON = 23.7275;
const LAT = 37.9838;
const SIZE_KM = 2;
const Z = 14;
const UA = 'OTOMIG/0.1 Phase R research probe (+https://github.com/alexandrosgavrilis/otomig)';

const AMENITIES = POPULATION.POI_AMENITIES;

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

async function overpass(query, attempts = 8) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const r = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'text/plain' },
        body: query,
        signal: AbortSignal.timeout(300000),
      });
      if (!r.ok) { await new Promise((s) => setTimeout(s, 4000 * i)); continue; }
      return await r.json();
    } catch { await new Promise((s) => setTimeout(s, 4000 * i)); }
  }
  throw new Error('Overpass gave up');
}

const bb = `${bbox[1].toFixed(6)},${bbox[0].toFixed(6)},${bbox[3].toFixed(6)},${bbox[2].toFixed(6)}`;

console.log(`=== population model, both ways, ${SIZE_KM} km box of central Athens ===\n`);

// ── data: Overpass buildings (tagged, with geometry) and POI nodes ─────────
const opB = await overpass(`[out:json][timeout:300];
way["building"](${bb});
out geom;`);
const opBuildings = (opB.elements || []).filter((e) => e.type === 'way' && e.geometry);

const opP = await overpass(`[out:json][timeout:300];
(
  node["shop"](${bb});
  node["amenity"~"^(${AMENITIES.join('|')})$"](${bb});
);
out body;`);
const poiNodes = (opP.elements || []).filter((e) => e.type === 'node');

// ── data: tile buildings (outline + height, no tags) ──────────────────────
const [x0, y0] = tileXY(bbox[0], bbox[3], Z);
const [x1, y1] = tileXY(bbox[2], bbox[1], Z);
const tileBuildings = [];
const seenIds = new Set();
for (let x = x0; x <= x1; x++) {
  for (let y = y0; y <= y1; y++) {
    const r = await fetch(`https://tiles.versatiles.org/tiles/osm/${Z}/${x}/${y}`,
      { headers: { 'User-Agent': UA } });
    if (!r.ok) continue;
    const layers = decodeTile(maybeDecompress(Buffer.from(await r.arrayBuffer())));
    const b = layers.buildings;
    if (!b) continue;
    for (const f of b.features) {
      if (seenIds.has(f.id)) continue;      // Q2.5: dedupe clipped buildings
      const ring = f.rings[0]?.map(([px, py]) => tileToLonLat(x, y, Z, px, py, b.extent));
      if (!ring || ring.length < 3) continue;
      const [clon, clat] = ringCentroid(ring);
      if (!inBox(clon, clat)) continue;
      seenIds.add(f.id);
      tileBuildings.push({ id: f.id, ring, height: f.properties.height });
    }
  }
}

console.log(`  Overpass: ${opBuildings.length} tagged buildings, ${poiNodes.length} POI nodes`);
console.log(`  tiles:    ${tileBuildings.length} buildings (deduped by osm id)\n`);

// ── the grid both sides are scored on ─────────────────────────────────────
const cellM = REGION.DEMAND_CELL_M;
const cols = Math.ceil(frame.widthM / cellM);
const rows = Math.ceil(frame.heightM / cellM);
const makeGrid = () => ({
  residents: new Float64Array(cols * rows),
  attraction: new Float64Array(cols * rows),
});
const cellOf = (lon, lat) => {
  const [x, y] = frame.toLocal(lon, lat);
  const col = Math.floor(x / cellM);
  const row = Math.floor(y / cellM);
  if (col < 0 || row < 0 || col >= cols || row >= rows) return -1;
  return row * cols + col;
};

function parseLevels(tags) {
  const raw = tags?.['building:levels'];
  if (!raw) return null;
  const v = parseFloat(String(raw).split(/[;,]/)[0]);
  return Number.isFinite(v) && v > 0 && v <= 200 ? v : null;
}

// ── Side A — today ────────────────────────────────────────────────────────
const A = makeGrid();
let aResidents = 0, aBuildingAttraction = 0, aResidentialAttraction = 0, aPoiAttraction = 0;
for (const way of opBuildings) {
  const ring = way.geometry.map((g) => [g.lon, g.lat]);
  if (ring.length < 3) continue;
  const areaM2 = ringAreaM2(ring, frame);
  if (areaM2 < 10) continue;
  const [clon, clat] = ringCentroid(ring);
  const index = cellOf(clon, clat);
  if (index < 0) continue;

  const levels = parseLevels(way.tags) ?? POPULATION.DEFAULT_LEVELS;
  const floorArea = areaM2 * levels;
  const { residential, category } = classifyBuilding(way.tags || {});

  if (residential) {
    const residents = floorArea / POPULATION.M2_PER_RESIDENT;
    A.residents[index] += residents;
    aResidents += residents;
    const add = floorArea * POPULATION.ATTRACTION_WEIGHTS.residential;
    A.attraction[index] += add;
    aResidentialAttraction += add;
  } else {
    const add = floorArea * (POPULATION.ATTRACTION_WEIGHTS[category] ?? 1.0);
    A.attraction[index] += add;
    aBuildingAttraction += add;
  }
}
for (const node of poiNodes) {
  const index = cellOf(node.lon, node.lat);
  if (index < 0) continue;
  A.attraction[index] += POPULATION.POINT_ATTRACTION;
  aPoiAttraction += POPULATION.POINT_ATTRACTION;
}

const aTotal = aBuildingAttraction + aResidentialAttraction + aPoiAttraction;
console.log(`--- Side A, today's model: where attraction comes from ---`);
console.log(`  non-residential buildings (floor area x category): ` +
  `${(100 * aBuildingAttraction / aTotal).toFixed(1)}%`);
console.log(`  residential buildings (x0.2):                      ` +
  `${(100 * aResidentialAttraction / aTotal).toFixed(1)}%`);
console.log(`  POI nodes (x${POPULATION.POINT_ATTRACTION}):` +
  `${' '.repeat(39 - String(POPULATION.POINT_ATTRACTION).length)}` +
  `${(100 * aPoiAttraction / aTotal).toFixed(1)}%`);
console.log(`  residents: ${Math.round(aResidents).toLocaleString()} ` +
  `(${Math.round(aResidents / (SIZE_KM * SIZE_KM)).toLocaleString()}/km²; ` +
  `central Athens is ~20,000/km²)`);

// ── Side B — the candidate ───────────────────────────────────────────────
// Buildings arrive with an outline and a height, no tags. Residents come from
// volume; attraction comes from the POI nodes, which Overpass still supplies in
// full, scaled by the volume of the building they sit in or near.
const B = makeGrid();
let bResidents = 0, bPoiAttraction = 0, bResidentialAttraction = 0;
const SHORTBREAD_DEFAULT_H = 5;
const M_PER_LEVEL = 3;

for (const b of tileBuildings) {
  const areaM2 = ringAreaM2(b.ring, frame);
  if (areaM2 < 10) continue;
  const [clon, clat] = ringCentroid(b.ring);
  const index = cellOf(clon, clat);
  if (index < 0) continue;

  // A real height when there is one, otherwise the same default the current
  // code already applies to 95% of buildings.
  const height = Number(b.height);
  const levels = Number.isFinite(height) && height !== SHORTBREAD_DEFAULT_H
    ? Math.max(1, height / M_PER_LEVEL)
    : POPULATION.DEFAULT_LEVELS;
  const floorArea = areaM2 * levels;

  // Without tags every building is treated as residential, which is what
  // classifyBuilding already concludes for 82% of them.
  const residents = floorArea / POPULATION.M2_PER_RESIDENT;
  B.residents[index] += residents;
  bResidents += residents;
  const add = floorArea * POPULATION.ATTRACTION_WEIGHTS.residential;
  B.attraction[index] += add;
  bResidentialAttraction += add;
}

// POIs keep their raw OSM tag, so the existing weights apply directly.
const POI_WEIGHT = {
  school: 1.5, kindergarten: 1.5, university: 1.5, college: 1.5,
  hospital: 1.5, clinic: 1.5, doctors: 1.2,
};
for (const node of poiNodes) {
  const index = cellOf(node.lon, node.lat);
  if (index < 0) continue;
  const kind = node.tags?.amenity || node.tags?.shop;
  const weight = POI_WEIGHT[kind] ?? 1.0;
  const add = POPULATION.POINT_ATTRACTION * weight;
  B.attraction[index] += add;
  bPoiAttraction += add;
}

const bTotal = bPoiAttraction + bResidentialAttraction;
console.log(`\n--- Side B, candidate: buildings untagged, POIs weighted ---`);
console.log(`  residential buildings (x0.2): ${(100 * bResidentialAttraction / bTotal).toFixed(1)}%`);
console.log(`  POI nodes (weighted):         ${(100 * bPoiAttraction / bTotal).toFixed(1)}%`);
console.log(`  residents: ${Math.round(bResidents).toLocaleString()} ` +
  `(${Math.round(bResidents / (SIZE_KM * SIZE_KM)).toLocaleString()}/km²)`);
console.log(`  residents vs Side A: ${(100 * bResidents / aResidents - 100).toFixed(1)}%`);

// ── Q4.4 — does the heat map still point at the same places? ─────────────
function normalise(arr) {
  const max = Math.max(...arr);
  return max > 0 ? Array.from(arr, (v) => v / max) : Array.from(arr);
}
function pearson(p, q) {
  const n = p.length;
  const mp = p.reduce((a, b) => a + b, 0) / n;
  const mq = q.reduce((a, b) => a + b, 0) / n;
  let num = 0, dp = 0, dq = 0;
  for (let i = 0; i < n; i++) {
    num += (p[i] - mp) * (q[i] - mq);
    dp += (p[i] - mp) ** 2;
    dq += (q[i] - mq) ** 2;
  }
  return num / Math.sqrt(dp * dq);
}

// The heat map shows unserved demand = residents + attraction per cell. With no
// network built, every cell is unserved, so this is the whole signal.
const heatA = normalise(Array.from(A.residents, (v, i) => v + A.attraction[i]));
const heatB = normalise(Array.from(B.residents, (v, i) => v + B.attraction[i]));

console.log(`\n--- Q4.4 — does the heat map still point at the same places? ---`);
console.log(`  grid ${cols}x${rows} = ${cols * rows} cells of ${cellM} m`);
console.log(`  Pearson correlation of per-cell heat: ${pearson(heatA, heatB).toFixed(3)}`);

const rank = (heat) => heat
  .map((v, i) => [i, v]).sort((p, q) => q[1] - p[1]).map(([i]) => i);
const rankA = rank(heatA);
const rankB = rank(heatB);
for (const k of [5, 10, 20, 50]) {
  const topA = new Set(rankA.slice(0, k));
  const overlap = rankB.slice(0, k).filter((i) => topA.has(i)).length;
  console.log(`  top-${String(k).padStart(2)} hottest cells shared: ${overlap}/${k} ` +
    `(${(100 * overlap / k).toFixed(0)}%)`);
}

const label = (index) => {
  const col = index % cols, row = Math.floor(index / cols);
  const [lon, lat] = frame.toLonLat((col + 0.5) * cellM, (row + 0.5) * cellM);
  return `${lon.toFixed(4)},${lat.toFixed(4)}`;
};
console.log(`  top 5, Side A: ${rankA.slice(0, 5).map(label).join('  ')}`);
console.log(`  top 5, Side B: ${rankB.slice(0, 5).map(label).join('  ')}`);

// ── Q5.5 — how big is the region in IndexedDB? ──────────────────────────
console.log(`\n--- Q5.5 — stored size of the building outlines ---`);
const round6 = (v) => Math.round(v * 1e6) / 1e6;
const outlinesTile = tileBuildings.map((b) =>
  b.ring.map(([lo, la]) => [round6(lo), round6(la)]));
const outlinesOp = opBuildings
  .filter((w) => w.geometry.length >= 3)
  .map((w) => w.geometry.map((g) => [round6(g.lon), round6(g.lat)]));
const jsonTile = JSON.stringify(outlinesTile).length;
const jsonOp = JSON.stringify(outlinesOp).length;
console.log(`  tiles:    ${outlinesTile.length} outlines, ` +
  `${(jsonTile / 1048576).toFixed(2)} MB of JSON ` +
  `(${(jsonTile / outlinesTile.length).toFixed(0)} B each)`);
console.log(`  Overpass: ${outlinesOp.length} outlines, ` +
  `${(jsonOp / 1048576).toFixed(2)} MB of JSON ` +
  `(${(jsonOp / outlinesOp.length).toFixed(0)} B each)`);
for (const km of [6, 15]) {
  const scale = (km * km) / (SIZE_KM * SIZE_KM);
  console.log(`  projected at ${km} km, this density: ` +
    `${(jsonTile * scale / 1048576).toFixed(0)} MB (tiles), ` +
    `${(jsonOp * scale / 1048576).toFixed(0)} MB (Overpass)`);
}
