/**
 * Population from buildings: residents, attraction, the demand grid, and the
 * building occupancy raster used for track collision checks.
 *
 * Deliberately crude, as the spec asks: floor area divided by a constant gives
 * residents, floor area times a category weight gives attraction. The footprint
 * polygons are discarded once rasterised — the game only ever needs the bits.
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
export function processBuildings(buildingWays, poiNodes, osmNodes, frame, populationTotal) {
  const cellM = REGION.DEMAND_CELL_M;
  const cols = Math.ceil(frame.widthM / cellM);
  const rows = Math.ceil(frame.heightM / cellM);
  const demand = {
    cols, rows, cellM,
    residents: new Array(cols * rows).fill(0),
    attraction: new Array(cols * rows).fill(0),
  };
  const occupancy = makeOccupancy(frame);

  let residentsTotal = 0;

  for (const way of buildingWays) {
    const tags = way.tags || {};

    /*
     * A building arrives one of two ways. Most residential buildings come
     * back from `out tags center` — tags and a centre point, no corner nodes
     * — because their polygons are 47% of the import payload and their
     * footprints are similar enough that an assumed area washes out across a
     * 200 m demand cell. Everything whose exact shape matters still carries
     * its full ring. See POPULATION.CENTROID_BUILDINGS.
     */
    const ring = wayRing(way, osmNodes);
    const hasShape = ring.length >= 3;

    let areaM2;
    let lon;
    let lat;
    if (hasShape) {
      areaM2 = ringAreaM2(ring, frame);
      [lon, lat] = ringCentroid(ring);
    } else if (way.center) {
      areaM2 = assumedArea(tags);
      ({ lon, lat } = way.center);
    } else {
      continue; // Neither geometry nor a centre: nothing usable.
    }
    if (areaM2 < 10) continue; // Noise, or a mis-tagged node cluster.

    const levels = parseLevels(tags) ?? POPULATION.DEFAULT_LEVELS;
    const floorArea = areaM2 * levels;
    const { residential, category } = classifyBuilding(tags);

    const [x, y] = frame.toLocal(lon, lat);
    const col = Math.floor(x / cellM);
    const row = Math.floor(y / cellM);

    if (col >= 0 && row >= 0 && col < cols && row < rows) {
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
    if (hasShape) rasteriseRing(ring, frame, occupancy);
    else rasteriseSquare(x, y, Math.sqrt(areaM2), occupancy);
  }

  // Standalone shops and amenities with no building of their own.
  for (const node of poiNodes) {
    const [x, y] = frame.toLocal(node.lon, node.lat);
    const col = Math.floor(x / cellM);
    const row = Math.floor(y / cellM);
    if (col < 0 || row < 0 || col >= cols || row >= rows) continue;
    demand.attraction[row * cols + col] += POPULATION.POINT_ATTRACTION;
  }

  // If the region has a known population, trust it over our floor-area guess.
  if (populationTotal > 0 && residentsTotal > 0) {
    const scale = populationTotal / residentsTotal;
    for (let i = 0; i < demand.residents.length; i++) demand.residents[i] *= scale;
    residentsTotal = populationTotal;
  }

  return { demand, occupancy, residentsTotal };
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
 * Assumed footprint for a building that arrived as a centroid, m².
 * Keyed on the `building` value, falling back to a general default.
 */
function assumedArea(tags) {
  return POPULATION.ASSUMED_AREA_M2[tags.building]
    ?? POPULATION.ASSUMED_AREA_M2.default;
}

/** Burn an axis-aligned square of side `sideM` centred on a local position. */
function rasteriseSquare(x, y, sideM, occupancy) {
  const { cellM, cols, rows } = occupancy;
  const half = sideM / 2;
  const fromCol = Math.max(0, Math.floor((x - half) / cellM));
  const toCol = Math.min(cols - 1, Math.floor((x + half) / cellM));
  const fromRow = Math.max(0, Math.floor((y - half) / cellM));
  const toRow = Math.min(rows - 1, Math.floor((y + half) / cellM));
  for (let row = fromRow; row <= toRow; row++) {
    for (let col = fromCol; col <= toCol; col++) setOccupied(occupancy, col, row);
  }
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
