/**
 * Generate fixtures/test-region.json — a synthetic region for development.
 *
 * The sandbox this was built in cannot reach Overpass or the elevation tiles, so
 * the fixture exists to test game logic against data shaped exactly like a real
 * import. "Exactly" is guaranteed by construction: this script synthesises OSM
 * elements in Overpass's own JSON shape and then runs them through the real
 * pipeline — parseResponses, buildGraph, processBuildings, buildContours. Only
 * the height grid is analytic rather than decoded from PNG tiles, because tiles
 * are the one input with no offline substitute.
 *
 * The region is deliberately awkward: a bay in the south-west (so there is sea
 * and a coast), a ridge and a valley across the middle (so the grade rule has
 * tunnels and bridges to find in Phase 4), a lake, a motorway (so the no-level-
 * crossing rule has something to trip on), and an existing railway with three
 * stations for Phase 6.
 *
 * Run: npm run fixture
 */

import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { REGION } from '../config.js';
import { LocalFrame, squareBbox, serialiseRegion } from '../model/region.js';
import { parseResponses, buildGraph, wayRing } from '../data/overpass.js';
import { buildContours } from '../data/terrain.js';
import { processBuildings } from '../model/population.js';

// A 6 km square on a plausible Mediterranean coast. Small enough to stay a
// readable JSON file, big enough for several bus lines and a tram.
const CENTER_LON = 23.6;
const CENTER_LAT = 37.95;
const SIZE_KM = 6;

const bbox = squareBbox(CENTER_LON, CENTER_LAT, SIZE_KM);
const frame = new LocalFrame(bbox);

let nextId = 1;
const id = () => nextId++;

/** @type {Object[]} */
const elements = [];
/** Local-metre point → OSM node id, so ways share nodes and the graph connects. */
const nodeIds = new Map();

/** Get (or make) an OSM node at a local-metre position. */
function nodeAt(x, y) {
  const key = `${Math.round(x)},${Math.round(y)}`;
  let existing = nodeIds.get(key);
  if (existing) return existing;
  const [lon, lat] = frame.toLonLat(x, y);
  existing = id();
  nodeIds.set(key, existing);
  elements.push({ type: 'node', id: existing, lon, lat });
  return existing;
}

/** Add a way through a list of local-metre points. */
function way(points, tags) {
  elements.push({
    type: 'way',
    id: id(),
    nodes: points.map(([x, y]) => nodeAt(x, y)),
    tags,
  });
}

// ─── Terrain ──────────────────────────────────────────────────────────────────

/**
 * Analytic height field, metres. Negative is sea.
 *
 *  - A bay in the south-west corner, dropping to about −25 m.
 *  - A ridge running north-east to south-west peaking around 180 m.
 *  - A valley cut through the ridge, which is what should force a bridge.
 *  - Gentle noise so contour lines aren't unnaturally smooth.
 */
function heightAtLocal(x, y) {
  const kx = x / 1000, ky = y / 1000; // km from the SW corner

  // Bay: distance from the SW corner, shallow shelf then seabed.
  const fromCorner = Math.hypot(kx, ky);
  const bay = fromCorner < 2.2 ? -28 * (1 - fromCorner / 2.2) ** 1.4 : 0;

  // Ridge: a Gaussian band along the line y = x + 1.2 km.
  const acrossRidge = (ky - kx - 1.2) / Math.SQRT2;
  const ridge = 180 * Math.exp(-(acrossRidge ** 2) / 0.6);

  // Valley: a notch cut through the ridge along x = 3.6 km. It scales with the
  // ridge rather than subtracting a flat amount, so it carves a gap where
  // there is a ridge and does nothing on the open plain. Subtracting a
  // constant instead would drive a wide area below zero and — once clamped —
  // leave a plateau of exact zeros, which the sea tracer would read as water.
  const notch = Math.exp(-(((kx - 3.6) / 0.45) ** 2));
  const ridgeCut = ridge * (1 - 0.92 * notch);

  // Coastal plain rising inland, plus a little texture.
  const plain = 12 * Math.min(fromCorner, 3);
  const noise =
    6 * Math.sin(kx * 2.3) * Math.cos(ky * 1.9) +
    3 * Math.sin(kx * 5.1 + 1.3) * Math.sin(ky * 4.7);

  // Land never sits at exactly 0 m: that is the sea tracer's boundary value.
  const land = Math.max(1.5, plain + ridgeCut + noise);
  return bay < 0 ? bay : land;
}

function buildTerrain() {
  const cellM = REGION.HEIGHT_CELL_M;
  const cols = Math.ceil(frame.widthM / cellM);
  const rows = Math.ceil(frame.heightM / cellM);
  const values = new Array(cols * rows);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      values[row * cols + col] = heightAtLocal((col + 0.5) * cellM, (row + 0.5) * cellM);
    }
  }
  return { cols, rows, cellM, values };
}

const terrain = buildTerrain();
const isLand = (x, y) => heightAtLocal(x, y) >= 0;

// ─── Roads ────────────────────────────────────────────────────────────────────

const W = frame.widthM;
const H = frame.heightM;
const BLOCK = 200; // Street grid spacing, m.

/** Street class by position, so the network has a believable hierarchy. */
function roadClass(index, coord) {
  if (Math.abs(coord - 3000) < 1) return 'primary';     // One main cross-axis each way
  if (index % 5 === 0) return 'secondary';
  if (index % 3 === 0) return 'tertiary';
  return 'residential';
}

/**
 * Lay the grid as one way per continuous run of land, so a street that crosses
 * the bay becomes two separate ways rather than one way bridging the water.
 */
function laySegmentedLine(points, tags) {
  let run = [];
  for (const p of points) {
    if (isLand(p[0], p[1])) {
      run.push(p);
    } else {
      if (run.length >= 2) way(run, tags);
      run = [];
    }
  }
  if (run.length >= 2) way(run, tags);
}

// East–west streets.
let index = 0;
for (let y = BLOCK; y < H; y += BLOCK, index++) {
  const cls = roadClass(index, y);
  const points = [];
  for (let x = 0; x <= W; x += 50) points.push([x, y]);
  laySegmentedLine(points, { highway: cls, name: `${streetName(index)} Street` });
}

// North–south streets.
index = 0;
for (let x = BLOCK; x < W; x += BLOCK, index++) {
  const cls = roadClass(index, x);
  const points = [];
  for (let y = 0; y <= H; y += 50) points.push([x, y]);
  laySegmentedLine(points, { highway: cls, name: `${streetName(index)} Avenue` });
}

// A motorway along the eastern edge: the rail rules must never cross it at grade.
way(
  Array.from({ length: 61 }, (_, i) => [W - 400, (i / 60) * H]),
  { highway: 'motorway', name: 'Coastal Motorway', ref: 'A1' },
);

// A pedestrian street through the centre — trams may use it, buses may not.
way(
  Array.from({ length: 11 }, (_, i) => [2800 + i * 40, 3000]),
  { highway: 'pedestrian', name: 'Market Walk' },
);

// A road tunnel through the ridge and a bridge over the valley, so buses can
// inherit OSM structures without the grade rule being involved.
way([[2600, 3800], [2800, 4000], [3000, 4200]],
  { highway: 'secondary', tunnel: 'yes', name: 'Ridge Tunnel' });
way([[3400, 2200], [3600, 2200], [3800, 2200]],
  { highway: 'secondary', bridge: 'yes', name: 'Valley Bridge' });

/** Readable street names so auto-naming stops produces something human. */
function streetName(i) {
  const names = ['Harbour', 'Olive', 'Pine', 'Market', 'Station', 'Chapel', 'Mill',
    'Garden', 'Vine', 'Quarry', 'Spring', 'Bridge', 'Cedar', 'Anchor', 'Lemon',
    'Fountain', 'Kiln', 'Orchard', 'Beacon', 'Laurel', 'Rope', 'Salt', 'Thyme',
    'Ferry', 'Myrtle', 'Cypress', 'Sage', 'Almond', 'Fig', 'Caper'];
  return names[i % names.length];
}

// ─── Buildings ────────────────────────────────────────────────────────────────

/** A rectangular footprint centred on a point, as a closed ring. */
function footprint(cx, cy, w, h) {
  return [
    [cx - w / 2, cy - h / 2], [cx + w / 2, cy - h / 2],
    [cx + w / 2, cy + h / 2], [cx - w / 2, cy + h / 2],
    [cx - w / 2, cy - h / 2],
  ];
}

/** Deterministic pseudo-random, so the fixture is byte-identical every run. */
let seed = 20261010;
function random() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}

/**
 * Fill the blocks with buildings: dense and tall near the centre, sparse and
 * low at the edges, nothing in the water or on the ridge top.
 *
 * Density is tuned to give roughly 1,500 residents per km² — a small real
 * town. An earlier, thinner version produced about 250/km², and at that
 * density the demand model is arithmetically correct but spawns well under
 * one passenger dot per in-game day, so the core loop could not be observed
 * in the fixture at all. A test fixture has to be dense enough to exercise
 * what it is testing.
 */
const CENTRE_X = 3000, CENTRE_Y = 2800;
for (let bx = BLOCK; bx < W - BLOCK; bx += BLOCK) {
  for (let by = BLOCK; by < H - BLOCK; by += BLOCK) {
    const fromCentre = Math.hypot(bx - CENTRE_X, by - CENTRE_Y) / 1000;
    // Density falls off from the centre; the ridge is too steep to build on.
    const density = Math.max(0, 1 - fromCentre / 4.6);
    const steep = heightAtLocal(bx, by) > 120;
    if (steep || random() > density) continue;

    const perBlock = 4 + Math.floor(random() * 6);
    for (let i = 0; i < perBlock; i++) {
      const cx = bx + 20 + random() * (BLOCK - 70);
      const cy = by + 20 + random() * (BLOCK - 70);
      if (!isLand(cx, cy)) continue;

      const w = 8 + random() * 16;
      const h = 8 + random() * 16;
      const levels = fromCentre < 0.8 ? 5 + Math.floor(random() * 6)
        : fromCentre < 1.8 ? 3 + Math.floor(random() * 4)
        : 2 + Math.floor(random() * 3);

      // A commercial core, residential elsewhere.
      const commercial = fromCentre < 0.9 && random() < 0.6;
      const tags = commercial
        ? { building: 'retail', shop: random() < 0.5 ? 'supermarket' : 'clothes',
            'building:levels': String(levels) }
        : { building: random() < 0.35 ? 'apartments' : 'house',
            'building:levels': String(levels) };
      way(footprint(cx, cy, w, h), tags);
    }
  }
}

// Named attractions, so the attraction weights have something distinct to bite on.
way(footprint(2400, 3400, 120, 80), { building: 'university', amenity: 'university', 'building:levels': '3', name: 'Coast University' });
way(footprint(3800, 3600, 90, 70), { building: 'hospital', amenity: 'hospital', 'building:levels': '5', name: 'Regional Hospital' });
way(footprint(2900, 2500, 60, 40), { building: 'school', amenity: 'school', 'building:levels': '2', name: 'Harbour School' });
way(footprint(3100, 1900, 70, 50), { building: 'hotel', tourism: 'hotel', 'building:levels': '6', name: 'Bay Hotel' });
way(footprint(2600, 2900, 100, 60), { building: 'office', office: 'company', 'building:levels': '8', name: 'Exchange House' });

// Standalone shops and amenities with no building of their own.
for (let i = 0; i < 40; i++) {
  const x = 1800 + random() * 2600;
  const y = 1800 + random() * 2600;
  if (!isLand(x, y)) continue;
  const [lon, lat] = frame.toLonLat(x, y);
  elements.push({
    type: 'node', id: id(), lon, lat,
    tags: random() < 0.5 ? { shop: 'bakery' } : { amenity: 'cafe' },
  });
}

// ─── Water ────────────────────────────────────────────────────────────────────

// An inland lake in the north-west, well clear of the bay.
way(
  Array.from({ length: 25 }, (_, i) => {
    const angle = (i / 24) * Math.PI * 2;
    return [1200 + 260 * Math.cos(angle), 4600 + 170 * Math.sin(angle)];
  }),
  { natural: 'water', water: 'lake', name: 'Lake Kerani' },
);

// A river running from the ridge down to the bay, as a thin polygon.
const riverLeft = [], riverRight = [];
for (let i = 0; i <= 20; i++) {
  const t = i / 20;
  const x = 4200 - t * 2400 + 180 * Math.sin(t * 4);
  const y = 5200 - t * 4400;
  riverLeft.push([x - 14, y]);
  riverRight.push([x + 14, y]);
}
way([...riverLeft, ...riverRight.reverse(), riverLeft[0]],
  { natural: 'water', water: 'river', name: 'Kerani River' });

// ─── Existing rail (Phase 6) ──────────────────────────────────────────────────

way(
  Array.from({ length: 31 }, (_, i) => {
    const x = (i / 30) * W;
    return [x, 1500 + 160 * Math.sin((x / W) * Math.PI * 1.5)];
  }),
  { railway: 'rail', usage: 'main', name: 'Coast Line' },
);

for (const [x, name, halt] of [[900, 'Harbour West', true], [3000, 'Central', false], [5100, 'East Junction', false]]) {
  const y = 1500 + 160 * Math.sin((x / W) * Math.PI * 1.5);
  const [lon, lat] = frame.toLonLat(x, y);
  elements.push({
    type: 'node', id: id(), lon, lat,
    tags: { railway: halt ? 'halt' : 'station', name },
  });
}

// An abandoned branch, which the parser must reject.
way([[3000, 1500], [3000, 900], [3000, 400]],
  { railway: 'rail', abandoned: 'yes', name: 'Old Quarry Branch' });

// ─── Run the real pipeline ────────────────────────────────────────────────────

const parsed = parseResponses([{ elements }]);
const roads = buildGraph(parsed.roadWays, parsed.nodes, frame);
const rail = buildGraph(parsed.railWays, parsed.nodes, frame);
const water = parsed.waterWays
  .map((w) => wayRing(w, parsed.nodes))
  .filter((ring) => ring.length >= 4);
const stations = parsed.stationNodes.map((node) => ({
  lon: node.lon, lat: node.lat,
  name: node.tags?.name || 'Station',
  halt: node.tags?.railway === 'halt',
}));
const { demand, occupancy, residentsTotal } =
  processBuildings(parsed.buildingWays, parsed.poiNodes, parsed.nodes, frame, 0);
const contours = buildContours(terrain, frame);

const region = serialiseRegion({
  meta: {
    name: 'Test Region (synthetic)',
    center: [CENTER_LON, CENTER_LAT],
    sizeKm: SIZE_KM,
    bbox,
    season: 'urban',
    difficulty: 'normal',
    populationTotal: Math.round(residentsTotal),
    importedAt: Date.now(),
    hasOsmRail: rail.edges.length > 0,
    synthetic: true,
  },
  roads, rail, stations, water, terrain, demand, occupancy, contours,
});

const outPath = join(dirname(fileURLToPath(import.meta.url)), 'test-region.json');
writeFileSync(outPath, JSON.stringify(region));

const occupiedCells = Array.from(occupancy.bits)
  .reduce((sum, byte) => sum + byte.toString(2).split('1').length - 1, 0);
let minH = Infinity, maxH = -Infinity, seaCells = 0;
for (const h of terrain.values) {
  if (h < minH) minH = h;
  if (h > maxH) maxH = h;
  if (h < 0) seaCells++;
}

console.log(`fixtures/test-region.json written
  road nodes        ${roads.nodes.length / 2}
  road edges        ${roads.edges.length}
  rail edges        ${rail.edges.length}  (abandoned branch correctly rejected: ${rail.edges.length < 40})
  stations          ${stations.length}
  water polygons    ${water.length}
  buildings parsed  ${parsed.buildingWays.length}
  POI nodes         ${parsed.poiNodes.length}
  residents         ${Math.round(residentsTotal).toLocaleString()}
  demand grid       ${demand.cols}x${demand.rows} @ ${demand.cellM}m
  occupancy         ${occupancy.cols}x${occupancy.rows} @ ${occupancy.cellM}m, ${occupiedCells} cells set
  terrain           ${terrain.cols}x${terrain.rows} @ ${terrain.cellM}m, ${minH.toFixed(0)}..${maxH.toFixed(0)}m, ${seaCells} sea cells
  contour lines     ${contours.features.length}`);
