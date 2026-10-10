/**
 * Phase R probe: why does the joined hybrid still only correlate 0.81?
 *
 * tools/probe-model-joined.js matches 30,478 tile rings to 30,686 Overpass
 * rings with identical tags, yet the demand grid correlates only 0.81 and
 * residents come out 10% high. Dropping building:part and keeping the largest
 * clipped fragment both failed to move it. So the difference is per building,
 * not per set. This compares matched pairs directly: area, centroid and vertex
 * count.
 *
 * Run: node tools/probe-diff.js
 */

import { gunzipSync, inflateSync } from 'node:zlib';
import { decodeTile, tileXY, tileToLonLat } from './mvt.js';
import { LocalFrame, ringAreaM2, ringCentroid } from '../model/region.js';

const LON = 23.7275;
const LAT = 37.9838;
const SIZE_KM = 2;
const Z = 14;
const UA = 'OTOMIG/0.1 Phase R research probe (+https://github.com/alexandrosgavrilis/otomig)';

const dLat = SIZE_KM / 111.32 / 2;
const dLon = SIZE_KM / (111.32 * Math.cos((LAT * Math.PI) / 180)) / 2;
const bbox = [LON - dLon, LAT - dLat, LON + dLon, LAT + dLat];
const frame = new LocalFrame(bbox);

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
    } catch { await new Promise((s) => setTimeout(s, 4000 * i)); }
  }
  throw new Error('Overpass gave up');
}

const bb = `${bbox[1].toFixed(6)},${bbox[0].toFixed(6)},${bbox[3].toFixed(6)},${bbox[2].toFixed(6)}`;
const opGeom = await overpass(`[out:json][timeout:300];
way["building"](${bb});
out geom;`);
const opById = new Map();
for (const w of (opGeom.elements || [])) {
  if (w.type !== 'way' || !w.geometry) continue;
  const ring = w.geometry.map((g) => [g.lon, g.lat]);
  if (ring.length < 3) continue;
  opById.set(w.id, ring);
}

// Tile rings, all fragments kept so clipping can be seen separately.
const [x0, y0] = tileXY(bbox[0], bbox[3], Z);
const [x1, y1] = tileXY(bbox[2], bbox[1], Z);
const tileFrags = new Map();   // osm way id → [rings]
for (let x = x0; x <= x1; x++) {
  for (let y = y0; y <= y1; y++) {
    const r = await fetch(`https://tiles.versatiles.org/tiles/osm/${Z}/${x}/${y}`,
      { headers: { 'User-Agent': UA } });
    if (!r.ok) continue;
    const b = decodeTile(maybeDecompress(Buffer.from(await r.arrayBuffer()))).buildings;
    if (!b) continue;
    for (const f of b.features) {
      if (f.id % 10 !== 2) continue;                 // ways only, for a clean pair
      const osmId = Math.floor(f.id / 10);
      if (!opById.has(osmId)) continue;
      // Every ring of the feature, not just the first — a multipolygon or a
      // clipped piece can produce several.
      const rings = f.rings
        .map((ring) => ring.map(([px, py]) => tileToLonLat(x, y, Z, px, py, b.extent)))
        .filter((ring) => ring.length >= 3);
      if (!rings.length) continue;
      if (!tileFrags.has(osmId)) tileFrags.set(osmId, []);
      tileFrags.get(osmId).push(...rings);
    }
  }
}

console.log(`=== matched pairs: ${tileFrags.size} buildings in both sources ===\n`);

const M_LAT = 111320, M_LON = 111320 * Math.cos((LAT * Math.PI) / 180);
const areaRatios = [];
const centroidShifts = [];
const vertexDelta = [];
let multiFragment = 0;
let ringCountMismatch = 0;

for (const [osmId, rings] of tileFrags) {
  const opRing = opById.get(osmId);
  const opArea = ringAreaM2(opRing, frame);
  if (opArea < 10) continue;

  if (rings.length > 1) multiFragment++;
  // Sum the fragments' areas: that is what the whole building should weigh.
  const tileArea = rings.reduce((a, ring) => a + ringAreaM2(ring, frame), 0);
  const biggest = rings.reduce((best, ring) =>
    ringAreaM2(ring, frame) > ringAreaM2(best, frame) ? ring : best, rings[0]);

  areaRatios.push(tileArea / opArea);
  if (rings.length !== 1) ringCountMismatch++;

  const [oLon, oLat] = ringCentroid(opRing);
  const [tLon, tLat] = ringCentroid(biggest);
  centroidShifts.push(Math.hypot((tLon - oLon) * M_LON, (tLat - oLat) * M_LAT));
  vertexDelta.push(biggest.length - opRing.length);
}

const stats = (xs, label, unit = '') => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  console.log(`  ${label.padEnd(26)} p10 ${q(0.1).toFixed(3)}  median ${q(0.5).toFixed(3)}  ` +
    `mean ${mean.toFixed(3)}  p90 ${q(0.9).toFixed(3)}  p99 ${q(0.99).toFixed(3)}  ` +
    `max ${s[s.length - 1].toFixed(2)}${unit}`);
};

stats(areaRatios, 'tile area / Overpass area');
stats(centroidShifts, 'centroid shift (m)', ' m');
stats(vertexDelta, 'vertex count difference');
console.log(`\n  buildings arriving as >1 ring (clipped or multipolygon): ` +
  `${multiFragment}/${tileFrags.size} (${(100 * multiFragment / tileFrags.size).toFixed(1)}%)`);

// How much total floor area does each source claim, over matched pairs only?
let opTotal = 0, tileTotal = 0;
for (const [osmId, rings] of tileFrags) {
  const opRing = opById.get(osmId);
  const a = ringAreaM2(opRing, frame);
  if (a < 10) continue;
  opTotal += a;
  tileTotal += rings.reduce((s, ring) => s + ringAreaM2(ring, frame), 0);
}
console.log(`\n  total footprint over matched pairs: ` +
  `Overpass ${Math.round(opTotal).toLocaleString()} m², ` +
  `tiles ${Math.round(tileTotal).toLocaleString()} m² ` +
  `(${(100 * tileTotal / opTotal - 100).toFixed(1)}%)`);

// How many centroid shifts are large enough to change a 200 m demand cell?
const big = centroidShifts.filter((d) => d > 100).length;
const moderate = centroidShifts.filter((d) => d > 20).length;
console.log(`  centroid shifts > 20 m: ${moderate} (${(100 * moderate / centroidShifts.length).toFixed(2)}%)`);
console.log(`  centroid shifts > 100 m: ${big} (${(100 * big / centroidShifts.length).toFixed(2)}%)`);

// The worst offenders, to see what they are.
const worst = [...tileFrags.entries()].map(([osmId, rings]) => {
  const opRing = opById.get(osmId);
  const opArea = ringAreaM2(opRing, frame);
  const tileArea = rings.reduce((a, r) => a + ringAreaM2(r, frame), 0);
  return { osmId, opArea, tileArea, ratio: tileArea / Math.max(1, opArea), n: rings.length };
}).filter((w) => w.opArea >= 10).sort((a, b) => b.ratio - a.ratio).slice(0, 8);
console.log(`\n  worst area ratios (tile / Overpass):`);
for (const w of worst) {
  console.log(`    way ${w.osmId}: Overpass ${w.opArea.toFixed(0)} m², ` +
    `tiles ${w.tileArea.toFixed(0)} m² in ${w.n} ring(s) → x${w.ratio.toFixed(1)}`);
}
