/**
 * Phase R probe: can tile geometry be joined to Overpass tags on the OSM id?
 *
 * tools/probe-model.js showed that dropping building tags costs real accuracy —
 * 39% of attraction comes from the non-residential category, and the heat map
 * correlation falls to 0.60 with none of the top 5 cells shared. So the hybrid
 * only works if the tags come back.
 *
 * They can come back cheaply: `way["building"]; out tags;` has no `>;`
 * recursion and no geometry, which is exactly the part that is expensive. If the
 * tile feature id is the OSM way id, geometry and tags join directly.
 *
 * This probe checks:
 *   1. what the tile feature id actually encodes
 *   2. what a tags-only building query costs at region scale
 *   3. that the join lands — tags matched to the right outline
 *
 * Run: node tools/probe-join.js
 */

import { gunzipSync, inflateSync } from 'node:zlib';
import { decodeTile, tileXY, tileToLonLat } from './mvt.js';

const LON = 23.7275;
const LAT = 37.9838;
const Z = 14;
const UA = 'OTOMIG/0.1 Phase R research probe (+https://github.com/alexandrosgavrilis/otomig)';

function maybeDecompress(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
  if (buf[0] === 0x78) return inflateSync(buf);
  return buf;
}

async function overpass(query, attempts = 8) {
  for (let i = 1; i <= attempts; i++) {
    const started = Date.now();
    try {
      const r = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'text/plain',
          'Accept-Encoding': 'gzip' },
        body: query,
        signal: AbortSignal.timeout(600000),
      });
      const text = await r.text();
      if (!r.ok) {
        process.stdout.write(`[${r.status}]`);
        await new Promise((s) => setTimeout(s, 4000 * i));
        continue;
      }
      return { json: JSON.parse(text), ms: Date.now() - started,
        bytes: Buffer.byteLength(text), attempts: i };
    } catch (e) {
      process.stdout.write(`[${e.message.slice(0, 20)}]`);
      await new Promise((s) => setTimeout(s, 4000 * i));
    }
  }
  throw new Error('Overpass gave up');
}

// ── 1. What does the tile feature id encode? ──────────────────────────────
console.log('=== 1. what is the tile feature id? ===');
const [tx, ty] = tileXY(LON, LAT, Z);
const response = await fetch(`https://tiles.versatiles.org/tiles/osm/${Z}/${tx}/${ty}`,
  { headers: { 'User-Agent': UA } });
const layers = decodeTile(maybeDecompress(Buffer.from(await response.arrayBuffer())));
const blayer = layers.buildings;

const sample = blayer.features.slice(0, 400).map((f) => {
  const ring = f.rings[0].map(([px, py]) => tileToLonLat(tx, ty, Z, px, py, blayer.extent));
  let cx = 0, cy = 0;
  for (const [lo, la] of ring) { cx += lo; cy += la; }
  return { id: f.id, lon: cx / ring.length, lat: cy / ring.length, height: f.properties.height };
});

console.log(`  ${sample.length} sampled ids, e.g. ` +
  sample.slice(0, 6).map((s) => s.id).join(', '));
console.log(`  id mod 10 distribution: ` + JSON.stringify(
  sample.reduce((acc, s) => { const k = s.id % 10; acc[k] = (acc[k] || 0) + 1; return acc; }, {})));

// Planetiler packs the OSM element type into the low bits of the feature id.
// Test the obvious candidates by asking Overpass whether the decoded id is a
// real way whose centre sits where the tile put it.
const CANDIDATES = {
  'id as-is': (id) => id,
  'id >> 3 (3-bit type tag)': (id) => Math.floor(id / 8),
  'id / 10 (decimal type tag)': (id) => Math.floor(id / 10),
};

for (const [label, decode] of Object.entries(CANDIDATES)) {
  const ids = sample.slice(0, 40).map((s) => decode(s.id));
  const out = await overpass(`[out:json][timeout:120];
way(id:${ids.join(',')});
out tags center;`);
  const got = (out.json.elements || []).filter((e) => e.type === 'way' && e.center);
  // A hit means the way exists AND its centre is within ~30 m of where the tile
  // drew it, which rules out coincidental id collisions.
  let near = 0;
  const byId = new Map(got.map((w) => [w.id, w]));
  for (const s of sample.slice(0, 40)) {
    const w = byId.get(decode(s.id));
    if (!w) continue;
    const dM = Math.hypot((w.center.lon - s.lon) * 111320 *
      Math.cos((LAT * Math.PI) / 180), (w.center.lat - s.lat) * 111320);
    if (dM < 30) near++;
  }
  const buildings = got.filter((w) => w.tags?.building).length;
  console.log(`  ${label.padEnd(28)} → ${got.length}/40 ways exist, ` +
    `${buildings} tagged building, ${near} within 30 m of the tile outline`);
}

// ── 2. What does a tags-only building query cost? ────────────────────────
console.log('\n=== 2. cost of `way["building"]; out tags;` at region scale ===');
console.log('    (for contrast, out geom measured 6.42 MB wire / 12.2 s at 6 km');
console.log('     and 29.57 MB wire / 25.4 s + 4 retries at 15 km)\n');

for (const km of [2, 6, 15]) {
  const dLat = km / 111.32 / 2;
  const dLon = km / (111.32 * Math.cos((LAT * Math.PI) / 180)) / 2;
  const bb = `${(LAT - dLat).toFixed(5)},${(LON - dLon).toFixed(5)},` +
    `${(LAT + dLat).toFixed(5)},${(LON + dLon).toFixed(5)}`;
  const out = await overpass(`[out:json][timeout:600];
way["building"](${bb});
out tags;`);
  const ways = (out.json.elements || []).filter((e) => e.type === 'way');
  const tagged = ways.filter((w) => w.tags && Object.keys(w.tags).length > 1).length;
  console.log(`  ${String(km).padStart(2)} km: ${ways.length} buildings, ` +
    `${(out.bytes / 1048576).toFixed(2)} MB decoded, ` +
    `${(out.ms / 1000).toFixed(1)}s` +
    (out.attempts > 1 ? ` (${out.attempts} attempts)` : '') +
    `, ${tagged} with tags beyond building=*`);
}

// ── 3. Does the join actually land? ─────────────────────────────────────
console.log('\n=== 3. join quality over one whole tile ===');
const dLat = 1.93 / 111.32 / 2;
const dLon = 1.93 / (111.32 * Math.cos((LAT * Math.PI) / 180)) / 2;
const bb = `${(LAT - dLat).toFixed(5)},${(LON - dLon).toFixed(5)},` +
  `${(LAT + dLat).toFixed(5)},${(LON + dLon).toFixed(5)}`;
const tagsOut = await overpass(`[out:json][timeout:300];
way["building"](${bb});
out tags;`);
const tagsById = new Map((tagsOut.json.elements || [])
  .filter((e) => e.type === 'way').map((w) => [w.id, w.tags]));

console.log(`  Overpass tag table: ${tagsById.size} building ways`);

for (const [label, decode] of Object.entries(CANDIDATES)) {
  let matched = 0;
  const all = blayer.features.map((f) => decode(f.id));
  for (const id of all) if (tagsById.has(id)) matched++;
  console.log(`  ${label.padEnd(28)} → ${matched}/${all.length} tile features ` +
    `matched a tag record (${(100 * matched / all.length).toFixed(1)}%)`);
}
