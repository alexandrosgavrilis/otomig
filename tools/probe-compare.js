/**
 * Phase R probe: tiles against Overpass on exactly the same box.
 *
 * Every earlier comparison was unfair — a z14 tile covers 3.7 km² while the
 * Overpass ground truth was a 1 km box of the densest part of Athens, so the
 * per-km² figures were measuring different places. This clips the tile features
 * to the Overpass bbox and counts both sides the same way.
 *
 *   Q2.1/Q2.2 — POI recovery and whether subclass is the raw OSM value
 *   Q2.3      — how many buildings have a real height, both sides
 *   Q5.1      — do tile buildings and Overpass roads line up geometrically?
 *               This is the integration risk of the hybrid: a building that
 *               overlaps the street would block Phase 4 track in mid-road.
 *
 * Run: node tools/probe-compare.js
 */

import { gunzipSync, inflateSync } from 'node:zlib';
import { decodeTile, tileXY, tileToLonLat } from './mvt.js';

const LON = 23.7275;
const LAT = 37.9838;
const BOX_KM = 1;
const Z = 14;
const UA = 'OTOMIG/0.1 Phase R research probe (+https://github.com/alexandrosgavrilis/otomig)';

const ROADS = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|' +
  'secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|' +
  'living_street|pedestrian';
const AMENITIES = 'school|kindergarten|university|college|hospital|clinic|' +
  'doctors|pharmacy|restaurant|cafe|fast_food|bar|pub|bank|post_office|' +
  'library|theatre|cinema|museum|marketplace|townhall|police|fire_station|' +
  'place_of_worship|sports_centre|swimming_pool|fuel|car_rental';

const dLat = BOX_KM / 111.32 / 2;
const dLon = BOX_KM / (111.32 * Math.cos((LAT * Math.PI) / 180)) / 2;
const BOX = { w: LON - dLon, s: LAT - dLat, e: LON + dLon, n: LAT + dLat };
const inBox = (lon, lat) => lon >= BOX.w && lon <= BOX.e && lat >= BOX.s && lat <= BOX.n;

function maybeDecompress(buf) {
  if (buf[0] === 0x1f && buf[1] === 0x8b) return gunzipSync(buf);
  if (buf[0] === 0x78) return inflateSync(buf);
  return buf;
}

async function overpass(query, attempts = 6) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const response = await fetch('https://overpass-api.de/api/interpreter', {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'text/plain' },
        body: query,
        signal: AbortSignal.timeout(300000),
      });
      if (!response.ok) { await new Promise((r) => setTimeout(r, 4000 * i)); continue; }
      return await response.json();
    } catch { await new Promise((r) => setTimeout(r, 4000 * i)); }
  }
  throw new Error('Overpass gave up');
}

// ── tile side: fetch the tiles covering the box, clip to it ────────────────
const [x0, y0] = tileXY(BOX.w, BOX.n, Z);
const [x1, y1] = tileXY(BOX.e, BOX.s, Z);
const tileList = [];
for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tileList.push([x, y]);

console.log(`=== same box, both sources: ${BOX_KM} km at ${LON}, ${LAT} ===`);
console.log(`    ${tileList.length} z${Z} tile(s) cover it: ` +
  tileList.map(([x, y]) => `${x}/${y}`).join(' '));

/** Tile features, clipped to the box, in lon/lat. */
const tileBuildings = [];   // { id, ring: [[lon,lat]...], height }
const tilePois = new Map(); // id → { lon, lat, kind, raw }

for (const [tx, ty] of tileList) {
  const response = await fetch(`https://tiles.versatiles.org/tiles/osm/${Z}/${tx}/${ty}`,
    { headers: { 'User-Agent': UA } });
  if (!response.ok) continue;
  const layers = decodeTile(maybeDecompress(Buffer.from(await response.arrayBuffer())));

  const b = layers.buildings;
  if (b) {
    for (const f of b.features) {
      const ring = f.rings[0]?.map(([px, py]) => tileToLonLat(tx, ty, Z, px, py, b.extent));
      if (!ring || ring.length < 3) continue;
      // Clip by centroid, the same rule processBuildings uses for demand cells.
      let cx = 0, cy = 0;
      for (const [lo, la] of ring) { cx += lo; cy += la; }
      cx /= ring.length; cy /= ring.length;
      if (!inBox(cx, cy)) continue;
      tileBuildings.push({ id: f.id, ring, height: f.properties.height, cx, cy });
    }
  }

  const p = layers.pois;
  if (p) {
    for (const f of p.features) {
      const pt = f.rings[0]?.[0];
      if (!pt) continue;
      const [lo, la] = tileToLonLat(tx, ty, Z, pt[0], pt[1], p.extent);
      if (!inBox(lo, la)) continue;
      const raw = f.properties;
      const kind = raw.shop ?? raw.amenity ?? raw.tourism ?? raw.leisure ??
        raw.office ?? raw.historic ?? raw.emergency ?? raw.man_made ?? '(unkeyed)';
      tilePois.set(f.id, { lon: lo, lat: la, kind: String(kind), raw });
    }
  }
}

// ── Overpass side, same box ───────────────────────────────────────────────
const bb = `${BOX.s.toFixed(6)},${BOX.w.toFixed(6)},${BOX.n.toFixed(6)},${BOX.e.toFixed(6)}`;

const opBuildings = await overpass(`[out:json][timeout:180];
way["building"](${bb});
out tags center;`);

const opPois = await overpass(`[out:json][timeout:180];
(
  node["shop"](${bb});
  node["amenity"~"^(${AMENITIES})$"](${bb});
);
out body;`);

const opRoads = await overpass(`[out:json][timeout:180];
way["highway"~"^(${ROADS})$"](${bb});
out geom;`);

const opB = (opBuildings.elements || []).filter((e) => e.type === 'way');
const opP = (opPois.elements || []).filter((e) => e.type === 'node');
const opR = (opRoads.elements || []).filter((e) => e.type === 'way' && e.geometry);

// ── Q2.3: heights, both sides ─────────────────────────────────────────────
console.log(`\n--- buildings (Q2.3) ---`);
console.log(`  Overpass: ${opB.length} buildings`);
console.log(`  tiles:    ${tileBuildings.length} buildings ` +
  `(${(100 * tileBuildings.length / opB.length).toFixed(0)}% of Overpass)`);

const opLevels = opB.filter((w) => w.tags?.['building:levels']).length;
const opHeight = opB.filter((w) => w.tags?.height).length;
const tileRealHeight = tileBuildings.filter((b) => b.height !== undefined && b.height !== 5).length;
console.log(`  Overpass building:levels present: ${opLevels} ` +
  `(${(100 * opLevels / opB.length).toFixed(1)}%)`);
console.log(`  Overpass height present:          ${opHeight} ` +
  `(${(100 * opHeight / opB.length).toFixed(1)}%)`);
console.log(`  tiles, height other than the 5 m default: ${tileRealHeight} ` +
  `(${(100 * tileRealHeight / tileBuildings.length).toFixed(1)}%)`);
console.log(`  → both sources default the vertical dimension for ~95% of buildings.`);

// ── Q2.4: how much signal is in the building category at all? ─────────────
const catCounts = new Map();
for (const w of opB) {
  const v = w.tags?.building || '(none)';
  catCounts.set(v, (catCounts.get(v) || 0) + 1);
}
const bareYes = catCounts.get('yes') || 0;
console.log(`\n--- building categories (Q2.4) ---`);
console.log(`  bare building=yes: ${bareYes}/${opB.length} ` +
  `(${(100 * bareYes / opB.length).toFixed(1)}%)`);
const withUseful = opB.filter((w) => w.tags && (w.tags.shop || w.tags.office ||
  w.tags.amenity || w.tags.tourism)).length;
console.log(`  carrying shop/office/amenity/tourism: ${withUseful} ` +
  `(${(100 * withUseful / opB.length).toFixed(1)}%)`);
console.log(`  → the category classifyBuilding() reads is absent for most buildings`);
console.log(`    on the Overpass side too, so the tiles lose less than assumed.`);

// ── Q2.1/Q2.2: POI recovery and granularity ───────────────────────────────
console.log(`\n--- POIs (Q2.1, Q2.2) ---`);
const opKinds = new Map();
for (const n of opP) {
  const k = n.tags?.shop ?? n.tags?.amenity ?? '(other)';
  opKinds.set(String(k), (opKinds.get(String(k)) || 0) + 1);
}
// Restrict the tile side to the same tag space Overpass was asked for.
const tileComparable = [...tilePois.values()].filter((p) =>
  p.raw.shop || (p.raw.amenity && AMENITIES.split('|').includes(p.raw.amenity)));

console.log(`  Overpass shop+amenity nodes:  ${opP.length}`);
console.log(`  tile POIs in the same tag space: ${tileComparable.length} ` +
  `(${(100 * tileComparable.length / opP.length).toFixed(0)}% recovery)`);
console.log(`  tile POIs, all kinds:         ${tilePois.size}`);
console.log(`  distinct kinds — Overpass ${opKinds.size}, tiles ` +
  `${new Set([...tilePois.values()].map((p) => p.kind)).size}`);

const tileKinds = new Map();
for (const p of tilePois.values()) tileKinds.set(p.kind, (tileKinds.get(p.kind) || 0) + 1);
console.log(`  tile kinds (raw OSM values, top 20):`);
console.log(`    ` + [...tileKinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  .map(([k, n]) => `${k}×${n}`).join(' '));
console.log(`  Overpass kinds (top 20):`);
console.log(`    ` + [...opKinds.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
  .map(([k, n]) => `${k}×${n}`).join(' '));

// Are the tile POIs a subset, i.e. does Shortbread drop whole categories?
const opKindSet = new Set(opKinds.keys());
const tileKindSet = new Set([...tilePois.values()].map((p) => p.kind));
const missing = [...opKindSet].filter((k) => !tileKindSet.has(k));
console.log(`  kinds Overpass has that the tiles do not: ${missing.length}` +
  (missing.length ? ` → ${missing.slice(0, 25).join(' ')}` : ''));

// ── Q5.1: do tile buildings sit in Overpass roads? ────────────────────────
console.log(`\n--- alignment (Q5.1) ---`);
const mPerDegLat = 111320;
const mPerDegLon = 111320 * Math.cos((LAT * Math.PI) / 180);
const toM = ([lo, la]) => [(lo - BOX.w) * mPerDegLon, (la - BOX.s) * mPerDegLat];

/** Shortest distance in metres from point p to segment ab. */
function distToSegment(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  let t = ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy));
}

// Build a coarse 50 m spatial index of road segments so this is not O(n*m).
const CELL = 50;
const grid = new Map();
const key = (c, r) => `${c},${r}`;
let segCount = 0;
for (const way of opR) {
  const pts = way.geometry.map((g) => toM([g.lon, g.lat]));
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    segCount++;
    const c0 = Math.floor(Math.min(a[0], b[0]) / CELL), c1 = Math.floor(Math.max(a[0], b[0]) / CELL);
    const r0 = Math.floor(Math.min(a[1], b[1]) / CELL), r1 = Math.floor(Math.max(a[1], b[1]) / CELL);
    for (let c = c0; c <= c1; c++) for (let r = r0; r <= r1; r++) {
      const k = key(c, r);
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push([a, b]);
    }
  }
}
console.log(`  ${opR.length} Overpass road ways, ${segCount} segments indexed`);

/** How far a point is from the nearest road centreline. */
function nearestRoad(p) {
  const c = Math.floor(p[0] / CELL), r = Math.floor(p[1] / CELL);
  let best = Infinity;
  for (let dc = -1; dc <= 1; dc++) for (let dr = -1; dr <= 1; dr++) {
    for (const [a, b] of grid.get(key(c + dc, r + dr)) || []) {
      const d = distToSegment(p, a, b);
      if (d < best) best = d;
    }
  }
  return best;
}

// A building vertex closer to a road centreline than half a carriageway means
// the footprint overlaps the street. ~3.5 m is one lane; take 3 m as the line.
const OVERLAP_M = 3;
let checked = 0, overlapping = 0;
const worst = [];
for (const b of tileBuildings) {
  const pts = b.ring.map(toM);
  let minD = Infinity;
  for (const p of pts) {
    const d = nearestRoad(p);
    if (d < minD) minD = d;
  }
  if (minD === Infinity) continue;   // no road within the search radius
  checked++;
  if (minD < OVERLAP_M) {
    overlapping++;
    worst.push({ id: b.id, d: minD, cx: b.cx, cy: b.cy });
  }
}
worst.sort((a, b) => a.d - b.d);
console.log(`  ${checked} tile buildings had a road segment within reach`);
console.log(`  buildings whose outline comes within ${OVERLAP_M} m of a road centreline: ` +
  `${overlapping} (${(100 * overlapping / checked).toFixed(1)}%)`);
console.log(`  worst 8 (metres from centreline):`);
for (const w of worst.slice(0, 8)) {
  console.log(`    id ${w.id}  ${w.d.toFixed(2)} m  at ${w.cx.toFixed(5)}, ${w.cy.toFixed(5)}`);
}

// The control: do OVERPASS's own buildings overlap Overpass roads just as much?
// If they do, the overlap is OSM's own tagging, not a cross-source misalignment.
const opBoxed = opB.filter((w) => w.center && inBox(w.center.lon, w.center.lat));
const opBGeom = await overpass(`[out:json][timeout:180];
way["building"](${bb});
out geom;`);
const opBRings = (opBGeom.elements || []).filter((e) => e.type === 'way' && e.geometry);
let opChecked = 0, opOverlap = 0;
const opWorst = [];
for (const w of opBRings) {
  const pts = w.geometry.map((g) => toM([g.lon, g.lat]));
  let minD = Infinity;
  for (const p of pts) {
    const d = nearestRoad(p);
    if (d < minD) minD = d;
  }
  if (minD === Infinity) continue;
  opChecked++;
  if (minD < OVERLAP_M) { opOverlap++; opWorst.push(minD); }
}
opWorst.sort((a, b) => a - b);
console.log(`\n  CONTROL — Overpass buildings against the same Overpass roads:`);
console.log(`  ${opOverlap}/${opChecked} (${(100 * opOverlap / opChecked).toFixed(1)}%) ` +
  `come within ${OVERLAP_M} m; worst ${opWorst.slice(0, 5).map((d) => d.toFixed(2)).join(', ')} m`);
console.log(`  → if the two rates match, the overlap is OSM's own geometry,`);
console.log(`    not a cross-source alignment problem.`);
