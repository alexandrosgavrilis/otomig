/**
 * Plain Node test runner. No dependencies, no framework — `node tests/run.js`.
 *
 * These test the logic that has no business being wrong: the geometry, the
 * grids, the parser, and the shape of the fixture against the data contract in
 * model/region.js. Anything needing a DOM, a canvas or the network is out of
 * scope here and is listed in HANDOFF.md as needing Alex's browser.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { CLOCK, REGION, MODES, POPULATION } from '../config.js';
import {
  LocalFrame, squareBbox, chunkBbox, makeGrid, cellIndex, cellCenter,
  heightAt, isOccupied, setOccupied, makeOccupancy, ringAreaM2, pointInRing,
  reviveRegion,
} from '../model/region.js';
import { parseResponses, buildGraph, classifyBuilding, buildQuery, fetchChunk } from '../data/overpass.js';
import { processBuildings } from '../model/population.js';
import { tileXY, tileNW, buildContours, buildSeaPolygons, sampleTilesToGrid } from '../data/terrain.js';
import {
  roadsToGeoJSON, waterToGeoJSON, demandToGeoJSON, buildingsToGeoJSON,
} from '../render/basemap.js';
import { runPhase2Tests } from './phase2.js';

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) { passed++; return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}

function near(name, actual, expected, tolerance) {
  check(name, Math.abs(actual - expected) <= tolerance,
    `expected ${expected} ±${tolerance}, got ${actual}`);
}

// ─── config ───────────────────────────────────────────────────────────────────

near('CLOCK.DAILY_SCALE is the spec\'s 324', CLOCK.DAILY_SCALE, 324, 0.001);
check('every mode has capacity, speed and dwell',
  ['bus', 'tram', 'metro', 'train'].every((m) =>
    MODES[m].capacity > 0 && MODES[m].cruiseKmh > 0 && MODES[m].dwellS > 0));

// Effective door-to-door speeds, the calculation that justified the spec's
// cruise speeds in RESEARCH.md section 3. If someone retunes a cruise speed or
// a dwell, this is what catches it drifting away from reality.
const EFFECTIVE = { bus: [400, 15, 22], tram: [500, 15, 25], metro: [1000, 30, 45], train: [2000, 50, 62] };
for (const [mode, [spacingM, lowKmh, highKmh]] of Object.entries(EFFECTIVE)) {
  const { cruiseKmh, dwellS } = MODES[mode];
  const seconds = spacingM / (cruiseKmh / 3.6) + dwellS;
  const effective = (spacingM / seconds) * 3.6;
  check(`${mode} effective speed is plausible`, effective >= lowKmh && effective <= highKmh,
    `${effective.toFixed(1)} km/h at ${spacingM} m spacing, want ${lowKmh}–${highKmh}`);
}

// ─── geometry ─────────────────────────────────────────────────────────────────

{
  const bbox = squareBbox(23.6, 37.95, 10);
  const frame = new LocalFrame(bbox);
  near('squareBbox width is the requested km', frame.widthM, 10000, 1);
  near('squareBbox height is the requested km', frame.heightM, 10000, 1);

  const [x, y] = frame.toLocal(23.6, 37.95);
  near('region centre is at half width', x, 5000, 1);
  near('region centre is at half height', y, 5000, 1);

  const [lon, lat] = frame.toLonLat(x, y);
  near('toLocal/toLonLat round-trips longitude', lon, 23.6, 1e-9);
  near('toLocal/toLonLat round-trips latitude', lat, 37.95, 1e-9);

  near('distance matches a known offset', frame.distance(23.6, 37.95, 23.6, 38.04), 10007, 20);
}

{
  // Chunks must tile the bbox exactly: no gaps (data would be missing) and no
  // drift (merged chunks would not line up).
  const bbox = squareBbox(10, 50, 15);
  const chunks = chunkBbox(bbox, 3);
  check('chunkBbox returns n²', chunks.length === 9);
  near('chunks span the full west edge', chunks[0][0], bbox[0], 1e-12);
  near('chunks span the full east edge', chunks[8][2], bbox[2], 1e-12);
  near('chunks span the full south edge', chunks[0][1], bbox[1], 1e-12);
  near('chunks span the full north edge', chunks[8][3], bbox[3], 1e-12);
  near('adjacent chunks share an edge', chunks[0][2], chunks[1][0], 1e-12);
}

// ─── grids ────────────────────────────────────────────────────────────────────

{
  const frame = new LocalFrame(squareBbox(0, 0, 1));
  const grid = makeGrid(frame, 100);
  check('1 km at 100 m cells is 10 columns', grid.cols === 10 && grid.rows === 10);
  check('cellIndex finds the first cell', cellIndex(grid, 50, 50) === 0);
  check('cellIndex finds the last cell', cellIndex(grid, 950, 950) === 99);
  check('cellIndex rejects positions outside', cellIndex(grid, -1, 50) === -1
    && cellIndex(grid, 50, 1001) === -1);
  const [cx, cy] = cellCenter(grid, 0);
  check('cellCenter is the cell middle', cx === 50 && cy === 50);
}

{
  // A linear ramp: bilinear interpolation must reproduce it exactly between
  // cell centres, which is what stops the grade rule from stepping.
  const cols = 5, rows = 5, cellM = 30;
  const values = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) values.push(col * 10);
  }
  const terrain = { cols, rows, cellM, values };
  near('heightAt matches at a cell centre', heightAt(terrain, 45, 45), 10, 1e-9);
  near('heightAt interpolates halfway', heightAt(terrain, 60, 45), 15, 1e-9);
  near('heightAt clamps below the grid', heightAt(terrain, 0, 0), 0, 1e-9);
  near('heightAt clamps above the grid', heightAt(terrain, 10000, 10000), 40, 1e-9);
}

{
  const frame = new LocalFrame(squareBbox(0, 0, 1));
  const occupancy = makeOccupancy(frame, 10);
  check('occupancy starts empty', !isOccupied(occupancy, 55, 55));
  setOccupied(occupancy, 5, 5);
  check('occupancy records the set cell', isOccupied(occupancy, 55, 55));
  check('occupancy leaves the neighbour clear', !isOccupied(occupancy, 65, 55));
  check('occupancy ignores positions outside', !isOccupied(occupancy, -5, 55));
}

{
  const frame = new LocalFrame(squareBbox(23.6, 37.95, 10));
  // A 100 m square, built in lon/lat via the frame so the area maths is tested
  // end to end rather than against itself.
  const ring = [[0, 0], [100, 0], [100, 100], [0, 100]]
    .map(([x, y]) => frame.toLonLat(x, y));
  near('ringAreaM2 measures a 100 m square', ringAreaM2(ring, frame), 10000, 2);
  check('pointInRing finds an inside point', pointInRing(...frame.toLonLat(50, 50), ring));
  check('pointInRing rejects an outside point', !pointInRing(...frame.toLonLat(150, 50), ring));
}

// ─── tiles ────────────────────────────────────────────────────────────────────

{
  const z = REGION.TERRAIN_ZOOM;
  const [tx, ty] = tileXY(23.6, 37.95, z);
  const [nwLon, nwLat] = tileNW(tx, ty, z);
  check('tileNW is north-west of the point', nwLon <= 23.6 && nwLat >= 37.95);
  const [nextLon, nextLat] = tileNW(tx + 1, ty + 1, z);
  check('the point falls inside its own tile', nextLon > 23.6 && nextLat < 37.95);

  // One synthetic tile, sampled into a grid: proves the resampler maps the
  // region onto tile pixels without a network fetch.
  const frame = new LocalFrame(squareBbox(23.6, 37.95, 2));
  const tile = new Float32Array(256 * 256).fill(123);
  const tiles = new Map();
  for (let x = tx - 1; x <= tx + 1; x++) {
    for (let y = ty - 1; y <= ty + 1; y++) tiles.set(`${x}/${y}`, tile);
  }
  const grid = sampleTilesToGrid(frame, tiles, z);
  check('sampled grid has the configured cell size', grid.cellM === REGION.HEIGHT_CELL_M);
  check('sampled grid reads the tile values', grid.values.every((v) => v === 123),
    `found ${grid.values.filter((v) => v !== 123).length} wrong cells`);
  check('every sampled height is a real number', grid.values.every(Number.isFinite));

  // The first live import produced a region that was entirely sea, because
  // `fetchTerrariumTile` sized its output from `bitmap.width` *after* calling
  // `bitmap.close()`, which zeroes it. Every tile came back empty, every
  // sample read `undefined`, and nothing complained. The resampler now refuses
  // a wrongly-sized tile rather than writing undefined into the grid.
  const empty = new Map(tiles);
  empty.set(`${tx}/${ty}`, new Float32Array(0));
  let threw = false;
  try { sampleTilesToGrid(frame, empty, z); } catch { threw = true; }
  check('a zero-length terrain tile is rejected, not silently sampled', threw);
}

// ─── Overpass failure modes ───────────────────────────────────────────────────

{
  // Overpass reports a server-side give-up as HTTP 200 with a `remark` and an
  // empty `elements` array, not as an error status. The first live imports
  // produced completely empty regions this way — no roads, no buildings, no
  // error — and reached the screen as a blank blue map. Stub `fetch` and prove
  // the remark is treated as a failure.
  const realFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return {
      ok: true,
      status: 200,
      json: async () => ({ version: 0.6, remark: 'runtime error: Query timed out', elements: [] }),
    };
  };
  let message = '';
  try {
    await fetchChunk([23.7, 37.9, 23.8, 38.0]);
  } catch (error) {
    message = String(error.message);
  } finally {
    globalThis.fetch = realFetch;
  }
  check('an Overpass 200 carrying a remark is rejected, not imported as empty',
    message.includes('Query timed out'), `got "${message}"`);
  check('...and it was retried before giving up', calls > 1, `${calls} attempts`);
}

// ─── Overpass parsing ─────────────────────────────────────────────────────────

{
  const elements = [
    { type: 'node', id: 1, lon: 0, lat: 0 },
    { type: 'node', id: 2, lon: 0.001, lat: 0 },
    { type: 'node', id: 3, lon: 0.002, lat: 0 },
    { type: 'way', id: 10, nodes: [1, 2], tags: { highway: 'residential', name: 'A' } },
    // Shares node 2 with way 10, so the graph must connect them.
    { type: 'way', id: 11, nodes: [2, 3], tags: { highway: 'residential', name: 'B' } },
    { type: 'way', id: 12, nodes: [1, 2, 3], tags: { highway: 'service' } },
    { type: 'way', id: 13, nodes: [1, 2, 3], tags: { highway: 'footway' } },
    { type: 'way', id: 14, nodes: [1, 2, 3, 1], tags: { building: 'house' } },
    { type: 'way', id: 15, nodes: [1, 2, 3, 1], tags: { natural: 'water' } },
    { type: 'way', id: 16, nodes: [1, 2], tags: { railway: 'rail' } },
    { type: 'way', id: 17, nodes: [2, 3], tags: { railway: 'rail', abandoned: 'yes' } },
    { type: 'node', id: 20, lon: 0, lat: 0, tags: { railway: 'station', name: 'S' } },
    { type: 'node', id: 21, lon: 0, lat: 0, tags: { shop: 'bakery' } },
    { type: 'node', id: 22, lon: 0, lat: 0, tags: { amenity: 'cafe' } },
  ];
  const parsed = parseResponses([{ elements }]);

  check('roads are kept', parsed.roadWays.length === 2);
  check('service and footway are not roads',
    !parsed.roadWays.some((w) => ['service', 'footway'].includes(w.tags.highway)));
  check('buildings are kept', parsed.buildingWays.length === 1);
  check('water is kept', parsed.waterWays.length === 1);
  check('live rail is kept', parsed.railWays.length === 1);
  check('abandoned rail is rejected',
    !parsed.railWays.some((w) => w.tags.abandoned));
  check('stations are kept', parsed.stationNodes.length === 1);
  check('POI nodes are kept', parsed.poiNodes.length === 2);

  // Chunks overlap, so the same element arrives more than once.
  const twice = parseResponses([{ elements }, { elements }]);
  check('duplicate ways are de-duplicated', twice.roadWays.length === 2);
  check('duplicate POI nodes are de-duplicated', twice.poiNodes.length === 2);

  const frame = new LocalFrame(squareBbox(0.001, 0, 1));
  const graph = buildGraph(parsed.roadWays, parsed.nodes, frame);
  check('shared OSM nodes become one graph node', graph.nodes.length / 2 === 3,
    `got ${graph.nodes.length / 2} nodes`);
  check('each road way contributes its edges', graph.edges.length === 2);
  check('edges carry a positive length', graph.edges.every((e) => e.lengthM > 0));
  check('edges carry the street name', graph.edges.every((e) => e.name));
}

{
  check('apartments are residential', classifyBuilding({ building: 'apartments' }).residential);
  check('building=yes with no tags is residential', classifyBuilding({ building: 'yes' }).residential);
  check('building=yes with a shop is not residential',
    !classifyBuilding({ building: 'yes', shop: 'bakery' }).residential);
  check('a hospital is categorised', classifyBuilding({ amenity: 'hospital' }).category === 'hospital');
  check('a university is categorised', classifyBuilding({ amenity: 'university' }).category === 'university');
  check('a hotel is categorised', classifyBuilding({ tourism: 'hotel' }).category === 'hotel');
  check('an office is categorised', classifyBuilding({ office: 'company' }).category === 'office');
}

// ─── the fixture, against the data contract ───────────────────────────────────

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'test-region.json');
const region = reviveRegion(JSON.parse(readFileSync(fixturePath, 'utf8')));
const frame = new LocalFrame(region.meta.bbox);

check('fixture has every top-level field the contract names',
  ['meta', 'roads', 'rail', 'stations', 'water', 'terrain', 'demand', 'occupancy', 'contours']
    .every((key) => region[key] !== undefined));

check('fixture meta is complete',
  ['name', 'center', 'sizeKm', 'bbox', 'season', 'difficulty', 'populationTotal', 'importedAt', 'hasOsmRail']
    .every((key) => region.meta[key] !== undefined));

check('fixture roads have nodes and edges',
  region.roads.nodes.length > 0 && region.roads.edges.length > 0);
check('fixture road node list is flat lon/lat pairs', region.roads.nodes.length % 2 === 0);
check('every edge references a real node',
  region.roads.edges.every((e) =>
    e.a >= 0 && e.b >= 0 && 2 * e.a + 1 < region.roads.nodes.length && 2 * e.b + 1 < region.roads.nodes.length));
check('every edge has a class, a length and structure flags',
  region.roads.edges.every((e) =>
    typeof e.cls === 'string' && e.lengthM > 0 &&
    typeof e.tunnel === 'boolean' && typeof e.bridge === 'boolean'));

check('fixture contains a road tunnel', region.roads.edges.some((e) => e.tunnel));
check('fixture contains a road bridge', region.roads.edges.some((e) => e.bridge));
check('fixture contains a motorway', region.roads.edges.some((e) => e.cls === 'motorway'));
check('fixture contains a pedestrian street', region.roads.edges.some((e) => e.cls === 'pedestrian'));
check('fixture contains residential roads', region.roads.edges.some((e) => e.cls === 'residential'));

check('fixture has existing rail', region.rail.edges.length > 0);
check('fixture flags existing rail in meta', region.meta.hasOsmRail === true);
check('fixture has stations', region.stations.length === 3);
check('fixture has a halt among them', region.stations.some((s) => s.halt));
check('fixture has water polygons', region.water.length >= 2);
check('water rings are rings', region.water.every((ring) => ring.length >= 4));

const { terrain, demand, occupancy } = region;
check('terrain grid is the right size',
  terrain.cols === Math.ceil(frame.widthM / terrain.cellM) &&
  terrain.rows === Math.ceil(frame.heightM / terrain.cellM));
check('terrain values fill the grid', terrain.values.length === terrain.cols * terrain.rows);
check('terrain values are all finite', terrain.values.every(Number.isFinite));
check('fixture has sea (negative heights)', terrain.values.some((h) => h < 0));
check('fixture has high ground for the grade rule', terrain.values.some((h) => h > 150));

check('demand grid uses the configured cell size', demand.cellM === REGION.DEMAND_CELL_M);
check('demand arrays fill the grid',
  demand.residents.length === demand.cols * demand.rows &&
  demand.attraction.length === demand.cols * demand.rows);
check('fixture has residents', demand.residents.reduce((a, b) => a + b, 0) > 1000);
check('fixture has attraction', demand.attraction.reduce((a, b) => a + b, 0) > 0);
check('residents are never negative', demand.residents.every((v) => v >= 0));
check('meta residents match the demand grid',
  Math.abs(region.meta.populationTotal - demand.residents.reduce((a, b) => a + b, 0)) < 1);

check('occupancy uses the configured cell size', occupancy.cellM === REGION.OCCUPANCY_CELL_M);
check('occupancy bitset is the right length',
  occupancy.bits.length === Math.ceil((occupancy.cols * occupancy.rows) / 8));
check('reviveRegion restores the typed array', occupancy.bits instanceof Uint8Array);
{
  let set = 0;
  for (const byte of occupancy.bits) set += byte.toString(2).split('1').length - 1;
  check('occupancy has buildings burnt into it', set > 1000, `${set} cells set`);
  check('occupancy is not saturated', set < occupancy.cols * occupancy.rows * 0.5);
}

check('fixture has contours', region.contours.features.length > 0);
check('contours are LineStrings with enough points',
  region.contours.features.every((f) =>
    f.geometry.type === 'LineString' && f.geometry.coordinates.length >= 3));
check('contours carry an elevation and a major flag',
  region.contours.features.every((f) =>
    Number.isFinite(f.properties.elevation) && typeof f.properties.major === 'boolean'));
check('contour elevations are multiples of the interval',
  region.contours.features.every((f) => f.properties.elevation % REGION.CONTOUR_INTERVAL_M === 0));
check('some contours are major', region.contours.features.some((f) => f.properties.major));
{
  // The terrain grid is padded up to a whole number of cells, so its last row
  // and column of cell centres can sit up to half a cell beyond the bbox — and
  // a contour traced through them lands there too. Harmless (heightAt clamps,
  // and the map is bounded to the bbox), but it means "inside the region" has
  // to mean "within one cell of it".
  const slack = terrain.cellM;
  const [west, south, east, north] = region.meta.bbox;
  const dLon = slack / frame.mPerLon;
  const dLat = slack / frame.mPerLat;
  check('contour coordinates are inside the region, within the grid padding',
    region.contours.features.every((f) => f.geometry.coordinates.every(([lon, lat]) =>
      lon >= west - dLon && lon <= east + dLon &&
      lat >= south - dLat && lat <= north + dLat)));
}

// Contours regenerated from the fixture's own terrain must match what is stored,
// which proves the fixture was built by the real pipeline and not by hand.
{
  const rebuilt = buildContours(terrain, frame);
  check('contours reproduce from the stored terrain',
    rebuilt.features.length === region.contours.features.length,
    `stored ${region.contours.features.length}, rebuilt ${rebuilt.features.length}`);
}

// ─── sea polygons ─────────────────────────────────────────────────────────────

{
  const sea = buildSeaPolygons(terrain, frame);
  check('sea polygons are produced', sea.features.length > 0);
  check('sea rings are closed', sea.features.every((f) => {
    const ring = f.geometry.coordinates[0];
    return ring.length >= 4 &&
      ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  }));
  // The fixture's bay is in the south-west, so at least one ring must sit there.
  const [west, south] = region.meta.bbox;
  check('a sea ring lies in the south-west bay', sea.features.some((f) =>
    f.geometry.coordinates[0].some(([lon, lat]) =>
      lon < west + 0.02 && lat < south + 0.02)));
}

// ─── GeoJSON for the base map ─────────────────────────────────────────────────

{
  const major = roadsToGeoJSON(region.roads, 'major');
  const minor = roadsToGeoJSON(region.roads, 'minor');
  const all = roadsToGeoJSON(region.roads, 'all');
  check('major and minor roads partition the edge list',
    major.features.length + minor.features.length === all.features.length);
  check('every road feature is a two-point LineString',
    all.features.every((f) =>
      f.geometry.type === 'LineString' && f.geometry.coordinates.length === 2));
  check('major roads carry a width', major.features.every((f) => f.properties.width > 0));
  check('motorways are major', major.features.some((f) => f.properties.cls === 'motorway'));
  check('residential roads are minor', minor.features.some((f) => f.properties.cls === 'residential'));

  const water = waterToGeoJSON(region.water);
  check('water polygons are closed rings', water.features.every((f) => {
    const ring = f.geometry.coordinates[0];
    return ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
  }));

  const heat = demandToGeoJSON(region.demand, frame);
  check('heat map has cells', heat.features.length > 0);
  check('heat intensities are normalised 0..1',
    heat.features.every((f) => f.properties.intensity >= 0 && f.properties.intensity <= 1));
  check('heat cells carry their grid index',
    heat.features.every((f) => Number.isInteger(f.properties.cell)));
  check('heat map reaches full intensity somewhere',
    heat.features.some((f) => f.properties.intensity > 0.9));
}

// ─── buildings are kept and drawable ──────────────────────────────────────────

{
  const query = buildQuery([23.72, 37.97, 23.73, 37.99]);
  check('buildings are fetched with their geometry',
    query.includes('way["building"]') && query.includes('>;\nout skel qt;'));
  check('the query is a single request',
    (query.match(/^\[out:json/gm) || []).length === 1);
  check('no centroid-only shortcut remains', !query.includes('out tags center'));
}

{
  // Outlines must survive the import, because they are drawn and because the
  // Phase 4 "no track through buildings" rule has to agree with what is
  // visible on screen.
  const frame = new LocalFrame(squareBbox(23.6, 37.95, 2));
  const square = [[0, 0], [20, 0], [20, 20], [0, 20]].map(([x, y]) =>
    frame.toLonLat(1100 + x, 1100 + y));
  const osmNodes = new Map(square.map((c, i) => [i + 1, c]));
  const way = {
    type: 'way', id: 1, nodes: [1, 2, 3, 4],
    tags: { building: 'apartments', 'building:levels': '4' },
  };
  const { outlines, residentsTotal, occupancy } =
    processBuildings([way], [], osmNodes, frame, 0);

  check('an outline is kept for every building', outlines.length === 1);
  check('the outline is a ring of lon/lat pairs',
    outlines[0].length === 4 && outlines[0].every((c) => c.length === 2));
  check('outline coordinates are rounded, not raw',
    outlines[0].every(([lon, lat]) =>
      Math.abs(lon * 1e6 - Math.round(lon * 1e6)) < 1e-9 &&
      Math.abs(lat * 1e6 - Math.round(lat * 1e6)) < 1e-9));
  near('residents come from the real footprint, not an assumption',
    residentsTotal, 20 * 20 * 4 / POPULATION.M2_PER_RESIDENT, 0.5);
  check('the real footprint is burnt into the occupancy grid',
    isOccupied(occupancy, 1110, 1110) && !isOccupied(occupancy, 1200, 1200));
}

{
  const buildings = buildingsToGeoJSON(region.buildings);
  check('the fixture carries building outlines',
    Array.isArray(region.buildings) && region.buildings.length > 1000,
    `${region.buildings?.length} outlines`);
  check('every building becomes a drawable polygon',
    buildings.features.length === region.buildings.length);
  check('building rings are closed for GeoJSON',
    buildings.features.every((f) => {
      const ring = f.geometry.coordinates[0];
      return ring.length >= 4 &&
        ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1];
    }));
  check('buildings sit inside the region',
    buildings.features.every((f) => f.geometry.coordinates[0].every(([lon, lat]) =>
      lon >= region.meta.bbox[0] && lon <= region.meta.bbox[2] &&
      lat >= region.meta.bbox[1] && lat <= region.meta.bbox[3])));
  check('buildingsToGeoJSON tolerates a region with none',
    buildingsToGeoJSON(undefined).features.length === 0);
}

// ─── Phase 2: the core loop ───────────────────────────────────────────────────

runPhase2Tests(check, near);

// ─── report ───────────────────────────────────────────────────────────────────

if (failures.length) {
  console.error(`\n${failures.length} failed, ${passed} passed\n`);
  for (const failure of failures) console.error(`  FAIL  ${failure}`);
  process.exit(1);
}
console.log(`${passed} passed`);
