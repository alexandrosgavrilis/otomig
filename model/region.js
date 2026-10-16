/**
 * The imported region: geometry helpers, grids, and the data shape every other
 * module reads.
 *
 * A region is imported once, cached in IndexedDB and never fetched again. The
 * shape below is the contract between the import worker (which produces it),
 * the fixture (which fakes it) and everything else (which consumes it).
 *
 * @typedef {Object} Region
 * @property {RegionMeta}  meta
 * @property {RoadGraph}   roads
 * @property {number[][][]} water     Polygon rings, [[ [lon,lat], ... ], ...]
 * @property {number[][][]} buildings Footprint outlines, same shape. Drawn on
 *                                    the map and used by the Phase 4 rule that
 *                                    track may not cross a building.
 * @property {RoadGraph}   rail       Existing OSM rail (Phase 6). Edges carry no class.
 * @property {RailStation[]} stations Existing OSM stations and halts.
 * @property {Grid}        terrain    Height grid, metres above sea level.
 * @property {DemandGrid}  demand     Residents and attraction per cell.
 * @property {Occupancy}   occupancy  One bit per cell: is a building here.
 * @property {Object}      contours   GeoJSON FeatureCollection of contour lines.
 *
 * @typedef {Object} RegionMeta
 * @property {string} name
 * @property {[number,number]} center      [lon, lat]
 * @property {number} sizeKm
 * @property {[number,number,number,number]} bbox  [west, south, east, north]
 * @property {string} season               Key into SEASON_PROFILES.
 * @property {string} difficulty           Key into DIFFICULTY.
 * @property {number} populationTotal      0 when unknown.
 * @property {number} importedAt           Epoch ms.
 * @property {boolean} hasOsmRail          Drives the maintenance discount.
 *
 * @typedef {Object} RoadGraph
 * @property {number[]} nodes   Flat [lon, lat, lon, lat, ...]; node i is at 2i.
 * @property {RoadEdge[]} edges
 *
 * @typedef {Object} RoadEdge
 * @property {number} a         Node index.
 * @property {number} b         Node index.
 * @property {string} cls       OSM highway class, e.g. 'residential'.
 * @property {number} lengthM
 * @property {boolean} tunnel
 * @property {boolean} bridge
 * @property {string} [name]    Street name, used to auto-name stops.
 *
 * @typedef {Object} RailStation
 * @property {number} lon
 * @property {number} lat
 * @property {string} name
 * @property {boolean} halt
 *
 * @typedef {Object} Grid
 * @property {number} cols
 * @property {number} rows
 * @property {number} cellM
 * @property {number[]} values   Row-major, length cols*rows.
 *
 * @typedef {Object} DemandGrid
 * @property {number} cols
 * @property {number} rows
 * @property {number} cellM
 * @property {number[]} residents
 * @property {number[]} attraction
 *
 * @typedef {Object} Occupancy
 * @property {number} cols
 * @property {number} rows
 * @property {number} cellM
 * @property {Uint8Array|number[]} bits   One bit per cell, 8 cells per byte.
 */

import { REGION } from '../config.js';

/** Mean Earth radius, m. */
const EARTH_R = 6371008.8;

/**
 * A region is small enough (15 km) that we can treat it as flat. Every module
 * works in local metres from the region's south-west corner, converting only at
 * the edges. This keeps the grade rule, the grids and the collision checks in
 * plain metres with no projection maths scattered about.
 */
export class LocalFrame {
  /** @param {[number,number,number,number]} bbox [west, south, east, north] */
  constructor(bbox) {
    const [west, south, east, north] = bbox;
    this.bbox = bbox;
    this.west = west;
    this.south = south;
    /** Metres per degree of longitude at the region's mid-latitude. */
    this.mPerLon = (Math.PI / 180) * EARTH_R * Math.cos(((south + north) / 2) * Math.PI / 180);
    /** Metres per degree of latitude. */
    this.mPerLat = (Math.PI / 180) * EARTH_R;
    this.widthM = (east - west) * this.mPerLon;
    this.heightM = (north - south) * this.mPerLat;
  }

  /** @returns {[number,number]} metres east and north of the SW corner. */
  toLocal(lon, lat) {
    return [(lon - this.west) * this.mPerLon, (lat - this.south) * this.mPerLat];
  }

  /** @returns {[number,number]} [lon, lat] */
  toLonLat(x, y) {
    return [this.west + x / this.mPerLon, this.south + y / this.mPerLat];
  }

  /** Great-circle-free distance between two lon/lat points, m. Good enough at 15 km. */
  distance(lon1, lat1, lon2, lat2) {
    const dx = (lon2 - lon1) * this.mPerLon;
    const dy = (lat2 - lat1) * this.mPerLat;
    return Math.hypot(dx, dy);
  }
}

/**
 * Build the bbox for a square region of `sizeKm` centred on [lon, lat].
 * @returns {[number,number,number,number]} [west, south, east, north]
 */
export function squareBbox(lon, lat, sizeKm) {
  const halfM = (sizeKm * 1000) / 2;
  const mPerLat = (Math.PI / 180) * EARTH_R;
  const mPerLon = mPerLat * Math.cos((lat * Math.PI) / 180);
  const dLat = halfM / mPerLat;
  const dLon = halfM / mPerLon;
  return [lon - dLon, lat - dLat, lon + dLon, lat + dLat];
}

/**
 * Split a bbox into n×n chunks for Overpass. Returns them in row-major order so
 * progress reporting reads naturally.
 * @returns {Array<[number,number,number,number]>}
 */
export function chunkBbox(bbox, n) {
  const [west, south, east, north] = bbox;
  const dLon = (east - west) / n;
  const dLat = (north - south) / n;
  const out = [];
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      out.push([west + col * dLon, south + row * dLat, west + (col + 1) * dLon, south + (row + 1) * dLat]);
    }
  }
  return out;
}

/** Allocate a grid of `cellM` cells covering the frame, filled with `fill`. */
export function makeGrid(frame, cellM, fill = 0) {
  const cols = Math.ceil(frame.widthM / cellM);
  const rows = Math.ceil(frame.heightM / cellM);
  return { cols, rows, cellM, values: new Array(cols * rows).fill(fill) };
}

/** Cell index for a local metre position, or -1 when outside. */
export function cellIndex(grid, x, y) {
  const col = Math.floor(x / grid.cellM);
  const row = Math.floor(y / grid.cellM);
  if (col < 0 || row < 0 || col >= grid.cols || row >= grid.rows) return -1;
  return row * grid.cols + col;
}

/** Centre of a cell, in local metres. @returns {[number,number]} */
export function cellCenter(grid, index) {
  const col = index % grid.cols;
  const row = Math.floor(index / grid.cols);
  return [(col + 0.5) * grid.cellM, (row + 0.5) * grid.cellM];
}

/**
 * Height at a local position, bilinearly interpolated from the terrain grid.
 * The grade rule samples every 20 m against a ~30 m grid, so interpolating
 * rather than snapping is what keeps the smoothed profile from stepping.
 */
export function heightAt(terrain, x, y) {
  const { cols, rows, cellM, values } = terrain;
  // Grid values sit at cell centres, so shift by half a cell.
  const fx = Math.min(Math.max(x / cellM - 0.5, 0), cols - 1);
  const fy = Math.min(Math.max(y / cellM - 0.5, 0), rows - 1);
  const x0 = Math.floor(fx), y0 = Math.floor(fy);
  const x1 = Math.min(x0 + 1, cols - 1), y1 = Math.min(y0 + 1, rows - 1);
  const tx = fx - x0, ty = fy - y0;
  const h00 = values[y0 * cols + x0], h10 = values[y0 * cols + x1];
  const h01 = values[y1 * cols + x0], h11 = values[y1 * cols + x1];
  return (
    h00 * (1 - tx) * (1 - ty) + h10 * tx * (1 - ty) +
    h01 * (1 - tx) * ty + h11 * tx * ty
  );
}

/** Is a building occupying the cell at this local position? */
export function isOccupied(occupancy, x, y) {
  const col = Math.floor(x / occupancy.cellM);
  const row = Math.floor(y / occupancy.cellM);
  if (col < 0 || row < 0 || col >= occupancy.cols || row >= occupancy.rows) return false;
  const bit = row * occupancy.cols + col;
  return (occupancy.bits[bit >> 3] & (1 << (bit & 7))) !== 0;
}

/** Set the occupancy bit at a cell position. */
export function setOccupied(occupancy, col, row) {
  if (col < 0 || row < 0 || col >= occupancy.cols || row >= occupancy.rows) return;
  const bit = row * occupancy.cols + col;
  occupancy.bits[bit >> 3] |= 1 << (bit & 7);
}

/** Allocate an empty occupancy grid for the frame. */
export function makeOccupancy(frame, cellM = REGION.OCCUPANCY_CELL_M) {
  const cols = Math.ceil(frame.widthM / cellM);
  const rows = Math.ceil(frame.heightM / cellM);
  return { cols, rows, cellM, bits: new Uint8Array(Math.ceil((cols * rows) / 8)) };
}

/** Is this position below sea level, i.e. sea rather than land? */
export function isSea(terrain, x, y) {
  return heightAt(terrain, x, y) < REGION.SEA_LEVEL_M;
}

/**
 * Shoelace area of a lon/lat ring, in m². Used for building footprints.
 * @param {number[][]} ring
 */
export function ringAreaM2(ring, frame) {
  let sum = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const [x1, y1] = frame.toLocal(ring[i][0], ring[i][1]);
    const j = (i + 1) % n;
    const [x2, y2] = frame.toLocal(ring[j][0], ring[j][1]);
    sum += x1 * y2 - x2 * y1;
  }
  return Math.abs(sum) / 2;
}

/** Centroid of a lon/lat ring. @returns {[number,number]} [lon, lat] */
export function ringCentroid(ring) {
  let lon = 0, lat = 0;
  for (const [a, b] of ring) { lon += a; lat += b; }
  return [lon / ring.length, lat / ring.length];
}

/** Point-in-ring test, lon/lat. Ray casting. */
export function pointInRing(lon, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

/**
 * Revive a region parsed from JSON: restore the typed array the shape expects,
 * and settle where the open sea is.
 *
 * Settling the sea here rather than at import means regions already cached
 * in IndexedDB are corrected on their next load, without re-importing.
 */
export function reviveRegion(region) {
  if (region.occupancy && !(region.occupancy.bits instanceof Uint8Array)) {
    region.occupancy.bits = new Uint8Array(region.occupancy.bits);
  }
  if (region.terrain) settleSea(region.terrain);
  if (region.contours) pruneContourSpecks(region.contours);
  return region;
}

/**
 * Drop closed contour loops too small to mean anything — see
 * `REGION.CONTOUR_MIN_LOOP_M`. Done on load rather than at import, so regions
 * cached before the rule are cleaned up too. Open lines (running off the
 * region's edge) are always kept.
 *
 * @param {{features: Object[]}} contours GeoJSON, modified in place
 * @returns {number} loops dropped
 */
export function pruneContourSpecks(contours) {
  const before = contours.features.length;
  contours.features = contours.features.filter((feature) => {
    const coords = feature.geometry?.coordinates;
    if (!coords || coords.length < 2) return false;
    const first = coords[0];
    const last = coords[coords.length - 1];
    const closed = Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9;
    if (!closed) return true;
    return pathLengthM(coords) >= REGION.CONTOUR_MIN_LOOP_M;
  });
  return before - contours.features.length;
}

/** Length of a lon/lat path in metres, flat-earth — exact enough at this scale. */
function pathLengthM(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) {
    const [lon1, lat1] = coords[i - 1];
    const [lon2, lat2] = coords[i];
    const mPerLon = 111320 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
    total += Math.hypot((lon2 - lon1) * mPerLon, (lat2 - lat1) * 110574);
  }
  return total;
}

/**
 * Mark open sea that the elevation data reports as exactly sea level.
 *
 * Where the tiles carry no bathymetry the sea is a flat plateau of 0 m, which
 * on its own is indistinguishable from land at 0 m — and treating either as
 * the other is a visible bug. Phase 1 met the land case (a flat valley floor
 * painted as sea) and resolved it by calling exactly 0 m land. Kiato met the
 * sea case: the Gulf of Corinth read as land.
 *
 * Connectivity tells them apart. Ground at or below sea level that is joined
 * to the edge of the region, through ground also at or below sea level, is
 * open sea and is lowered to `REGION.FLAT_SEA_DEPTH_M`. An enclosed plateau —
 * a valley floor, a dry basin — touches no edge and stays land. Anything
 * already below sea level is sea as before; this only adds to it.
 *
 * The one case it gets wrong is a flat plain at exactly 0 m that runs off the
 * edge of the region, which is rare: a polder sits below sea level, not at it.
 *
 * Idempotent, so it is safe to run on every load.
 *
 * @param {Grid} terrain modified in place
 * @returns {number} cells newly marked as sea
 */
export function settleSea(terrain) {
  const { cols, rows, values } = terrain;
  const level = REGION.SEA_LEVEL_M;
  const seen = new Uint8Array(cols * rows);
  const stack = [];
  const visit = (index) => {
    if (seen[index] || !(values[index] <= level)) return;
    seen[index] = 1;
    stack.push(index);
  };
  for (let col = 0; col < cols; col++) { visit(col); visit((rows - 1) * cols + col); }
  for (let row = 0; row < rows; row++) { visit(row * cols); visit(row * cols + cols - 1); }

  let marked = 0;
  while (stack.length > 0) {
    const index = stack.pop();
    if (values[index] > REGION.FLAT_SEA_DEPTH_M) {
      values[index] = REGION.FLAT_SEA_DEPTH_M;
      marked++;
    }
    const col = index % cols;
    if (col > 0) visit(index - 1);
    if (col < cols - 1) visit(index + 1);
    if (index >= cols) visit(index - cols);
    if (index < (rows - 1) * cols) visit(index + cols);
  }
  return marked;
}

/** Make a region JSON-safe for saving or fixture export. */
export function serialiseRegion(region) {
  return {
    ...region,
    occupancy: { ...region.occupancy, bits: Array.from(region.occupancy.bits) },
  };
}
