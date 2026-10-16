/**
 * Population from buildings: residents, attraction, the demand grid, and the
 * building occupancy raster used for track collision checks.
 *
 * Deliberately crude, as the spec asks: floor area divided by a constant gives
 * residents, floor area times a category weight gives attraction.
 *
 * The spec discards footprint polygons after rasterising them. We keep a
 * simplified copy instead, because buildings are drawn on the map — seeing the
 * city you are serving is the point — and because the Phase 4 rule that track
 * cannot cross a building must agree with the outline on screen.
 */

import { REGION, POPULATION } from '../config.js';
import { classifyBuilding, wayRing } from '../data/overpass.js';
import { ringAreaM2, ringCentroid, makeOccupancy, setOccupied } from './region.js';

/**
 * Process building ways into the demand grid and the occupancy raster.
 *
 * @param {Object[]} buildingWays
 * @param {Object[]} poiNodes            Standalone shop/amenity points.
 * @param {Map<number,[number,number]>} osmNodes
 * @param {import('./region.js').LocalFrame} frame
 * @param {number} populationTotal       0 when unknown; otherwise residents are scaled to it.
 * @returns {{demand: import('./region.js').DemandGrid,
 *            occupancy: import('./region.js').Occupancy,
 *            residentsTotal: number}}
 */
export function processBuildings(buildingWays, poiNodes, osmNodes, frame, populationTotal,
  roads = null) {
  // Without a road graph (older callers, unit tests) every building counts.
  const nearRoad = roads ? roadProximity(roads, frame, POPULATION.MAX_ROAD_DISTANCE_M) : () => true;
  const cellM = REGION.DEMAND_CELL_M;
  const cols = Math.ceil(frame.widthM / cellM);
  const rows = Math.ceil(frame.heightM / cellM);
  const demand = {
    cols, rows, cellM,
    residents: new Array(cols * rows).fill(0),
    attraction: new Array(cols * rows).fill(0),
  };
  const occupancy = makeOccupancy(frame);
  /**
   * Outlines kept for rendering. Coordinates are rounded to 6 decimals —
   * about 10 cm, far finer than anything drawn — which roughly halves the
   * stored size against raw OSM precision.
   * @type {number[][][]}
   */
  const outlines = [];

  let residentsTotal = 0;

  for (const way of buildingWays) {
    const tags = way.tags || {};

    const ring = wayRing(way, osmNodes);
    if (ring.length < 3) continue;

    const areaM2 = ringAreaM2(ring, frame);
    if (areaM2 < 10) continue; // Noise, or a mis-tagged node cluster.
    const [lon, lat] = ringCentroid(ring);

    const levels = parseLevels(tags) ?? POPULATION.DEFAULT_LEVELS;
    const floorArea = areaM2 * levels;
    const { residential, category } = classifyBuilding(tags);

    const [x, y] = frame.toLocal(lon, lat);
    const col = Math.floor(x / cellM);
    const row = Math.floor(y / cellM);

    if (col >= 0 && row >= 0 && col < cols && row < rows && nearRoad(x, y)) {
      const index = row * cols + col;
      if (residential) {
        const residents = floorArea / POPULATION.M2_PER_RESIDENT;
        demand.residents[index] += residents;
        residentsTotal += residents;
        // Residential buildings also attract a little: people visit each other.
        demand.attraction[index] += floorArea * POPULATION.ATTRACTION_WEIGHTS.residential;
      } else {
        const weight = POPULATION.ATTRACTION_WEIGHTS[category] ?? 1.0;
        demand.attraction[index] += floorArea * weight;
      }
    }

    // Occupancy for Phase 4's "buildings block surface track". A real ring is
    // burnt exactly; a centroid-only building is approximated by a square of
    // the assumed area, which at 10 m cells is close enough for a collision
    // check on the kind of building that takes this path.
    rasteriseRing(ring, frame, occupancy);
    outlines.push(ring.map(([pLon, pLat]) => [round6(pLon), round6(pLat)]));
  }

  // Standalone shops and amenities with no building of their own.
  for (const node of poiNodes) {
    const [x, y] = frame.toLocal(node.lon, node.lat);
    const col = Math.floor(x / cellM);
    const row = Math.floor(y / cellM);
    if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
    if (!nearRoad(x, y)) continue;
    demand.attraction[row * cols + col] += POPULATION.POINT_ATTRACTION;
  }

  // If the region has a known population, trust it over our floor-area guess.
  if (populationTotal > 0 && residentsTotal > 0) {
    const scale = populationTotal / residentsTotal;
    for (let i = 0; i < demand.residents.length; i++) demand.residents[i] *= scale;
    residentsTotal = populationTotal;
  }

  return { demand, occupancy, residentsTotal, outlines };
}

/**
 * A test for "within `maxM` of a road", in local metres. Road segments are
 * bucketed into a grid of `maxM` cells, so a query looks at the 3×3 cells
 * around it — fast enough for 50,000 buildings.
 *
 * @param {import('./region.js').RoadGraph} roads
 * @returns {(x:number, y:number) => boolean}
 */
export function roadProximity(roads, frame, maxM) {
  const cols = Math.max(1, Math.ceil(frame.widthM / maxM));
  const rows = Math.max(1, Math.ceil(frame.heightM / maxM));
  /** @type {Map<number, number[][]>} cell → segments as [x1, y1, x2, y2] */
  const cells = new Map();
  const local = (node) => frame.toLocal(roads.nodes[2 * node], roads.nodes[2 * node + 1]);
  const clampCol = (x) => Math.min(cols - 1, Math.max(0, Math.floor(x / maxM)));
  const clampRow = (y) => Math.min(rows - 1, Math.max(0, Math.floor(y / maxM)));

  for (const edge of roads.edges) {
    const [x1, y1] = local(edge.a);
    const [x2, y2] = local(edge.b);
    const segment = [x1, y1, x2, y2];
    // Every cell the segment's bounding box touches; edges are short.
    for (let row = clampRow(Math.min(y1, y2)); row <= clampRow(Math.max(y1, y2)); row++) {
      for (let col = clampCol(Math.min(x1, x2)); col <= clampCol(Math.max(x1, x2)); col++) {
        const key = row * cols + col;
        if (!cells.has(key)) cells.set(key, []);
        cells.get(key).push(segment);
      }
    }
  }

  return (x, y) => {
    const col = clampCol(x);
    const row = clampRow(y);
    for (let r = row - 1; r <= row + 1; r++) {
      for (let c = col - 1; c <= col + 1; c++) {
        if (r < 0 || c < 0 || r >= rows || c >= cols) continue;
        for (const segment of cells.get(r * cols + c) || []) {
          if (pointSegmentDistance(x, y, segment) <= maxM) return true;
        }
      }
    }
    return false;
  };
}

function pointSegmentDistance(x, y, [x1, y1, x2, y2]) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / lengthSq)) : 0;
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy));
}

/** ~10 cm precision. Finer than anything we draw, and half the bytes. */
function round6(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * `building:levels` is free text in OSM: "3", "2.5", "3;4" and worse all occur.
 * Take the first number that parses and looks like a building.
 * @returns {number|null}
 */
function parseLevels(tags) {
  const raw = tags['building:levels'];
  if (!raw) return null;
  const value = parseFloat(String(raw).split(/[;,]/)[0]);
  if (!Number.isFinite(value) || value <= 0 || value > 200) return null;
  return value;
}

/**
 * Burn a lon/lat ring into the occupancy grid by scanline fill.
 *
 * Cells are 10 m, buildings are often smaller than that, so a pure scanline
 * would miss small houses entirely — their edges never cross a row centre. The
 * edge walk afterwards catches those.
 */
function rasteriseRing(ring, frame, occupancy) {
  const { cellM, rows, cols } = occupancy;

  // Ring in occupancy cell coordinates.
  const pts = ring.map(([lon, lat]) => {
    const [x, y] = frame.toLocal(lon, lat);
    return [x / cellM, y / cellM];
  });

  let minRow = Infinity, maxRow = -Infinity;
  for (const [, py] of pts) {
    if (py < minRow) minRow = py;
    if (py > maxRow) maxRow = py;
  }
  minRow = Math.max(0, Math.floor(minRow));
  maxRow = Math.min(rows - 1, Math.ceil(maxRow));

  for (let row = minRow; row <= maxRow; row++) {
    const yc = row + 0.5;
    /** Where the ring's edges cross this row's centre line. */
    const crossings = [];
    for (let i = 0, n = pts.length; i < n; i++) {
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[(i + 1) % n];
      if (y1 === y2) continue;
      if (yc >= Math.min(y1, y2) && yc < Math.max(y1, y2)) {
        crossings.push(x1 + ((yc - y1) / (y2 - y1)) * (x2 - x1));
      }
    }
    crossings.sort((a, b) => a - b);
    for (let i = 0; i + 1 < crossings.length; i += 2) {
      const from = Math.max(0, Math.floor(crossings[i]));
      const to = Math.min(cols - 1, Math.ceil(crossings[i + 1]));
      for (let col = from; col <= to; col++) setOccupied(occupancy, col, row);
    }
  }

  // Walk the outline so buildings smaller than one cell still register.
  for (let i = 0, n = pts.length; i < n; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[(i + 1) % n];
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1)));
    for (let s = 0; s <= steps; s++) {
      const t = s / steps;
      setOccupied(occupancy, Math.floor(x1 + (x2 - x1) * t), Math.floor(y1 + (y2 - y1) * t));
    }
  }
}

/** Sum of residents across the demand grid. */
export function totalResidents(demand) {
  return demand.residents.reduce((a, b) => a + b, 0);
}
