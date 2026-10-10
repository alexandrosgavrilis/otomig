/**
 * Elevation: fetch Terrarium tiles, decode them into a height grid, and trace
 * contour lines with marching squares.
 *
 * Runs in the import worker. The sea mask falls out of the height grid for free
 * (anything below 0 m), which is why we never build coastline polygons.
 */

import { REGION } from '../config.js';

/** Slippy-map tile x/y for a lon/lat at a zoom. @returns {[number,number]} */
export function tileXY(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return [x, y];
}

/** Lon/lat of a tile's north-west corner. @returns {[number,number]} */
export function tileNW(x, y, z) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const latRad = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n)));
  return [lon, (latRad * 180) / Math.PI];
}

/**
 * Decode one Terrarium PNG into a Float32Array of heights, 256×256.
 *
 * The canvas route (`drawImage` + `getImageData`) taints on a cross-origin
 * image unless the response carries CORS headers, so we fetch the bytes
 * ourselves and go through createImageBitmap — that path never taints and works
 * in a worker. See RESEARCH.md §4.
 *
 * @param {string} url
 * @returns {Promise<Float32Array>} 256*256 heights in metres
 */
export async function fetchTerrariumTile(url) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`terrain tile ${url}: HTTP ${response.status}`);
  const bitmap = await createImageBitmap(await response.blob());

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0);
  const { data } = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
  bitmap.close();

  const heights = new Float32Array(bitmap.width * bitmap.height);
  for (let i = 0, p = 0; i < heights.length; i++, p += 4) {
    heights[i] = data[p] * 256 + data[p + 1] + data[p + 2] / 256 - REGION.TERRAIN_OFFSET;
  }
  return heights;
}

/**
 * Build the region's height grid by fetching every Terrarium tile the bbox
 * touches and sampling them into HEIGHT_CELL_M cells.
 *
 * @param {import('../model/region.js').LocalFrame} frame
 * @param {(done:number,total:number)=>void} [onProgress]
 * @returns {Promise<import('../model/region.js').Grid>}
 */
export async function buildHeightGrid(frame, onProgress) {
  const z = REGION.TERRAIN_ZOOM;
  const [west, south, east, north] = frame.bbox;
  const [x0, y0] = tileXY(west, north, z); // NW corner → lowest x, lowest y
  const [x1, y1] = tileXY(east, south, z);

  /** @type {Map<string, Float32Array>} */
  const tiles = new Map();
  const total = (x1 - x0 + 1) * (y1 - y0 + 1);
  let done = 0;

  for (let tx = x0; tx <= x1; tx++) {
    for (let ty = y0; ty <= y1; ty++) {
      const url = REGION.TERRAIN_TILE_URL
        .replace('{z}', String(z)).replace('{x}', String(tx)).replace('{y}', String(ty));
      tiles.set(`${tx}/${ty}`, await fetchTerrariumTile(url));
      onProgress?.(++done, total);
    }
  }

  return sampleTilesToGrid(frame, tiles, z);
}

/**
 * Resample fetched tiles into the region's height grid. Split out from the
 * fetching so it can be tested against synthetic tiles with no network.
 *
 * @param {import('../model/region.js').LocalFrame} frame
 * @param {Map<string, Float32Array>} tiles keyed `x/y`, each 256×256
 * @param {number} z
 */
export function sampleTilesToGrid(frame, tiles, z) {
  const cellM = REGION.HEIGHT_CELL_M;
  const cols = Math.ceil(frame.widthM / cellM);
  const rows = Math.ceil(frame.heightM / cellM);
  const values = new Array(cols * rows).fill(0);
  const n = 2 ** z;

  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      // Sample at the cell centre.
      const [lon, lat] = frame.toLonLat((col + 0.5) * cellM, (row + 0.5) * cellM);
      // Exact (fractional) tile coordinates for this point.
      const fx = ((lon + 180) / 360) * n;
      const latRad = (lat * Math.PI) / 180;
      const fy = ((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n;
      const tx = Math.floor(fx), ty = Math.floor(fy);
      const tile = tiles.get(`${tx}/${ty}`);
      if (!tile) continue; // Outside what we fetched; leave at 0.
      const px = Math.min(255, Math.floor((fx - tx) * 256));
      const py = Math.min(255, Math.floor((fy - ty) * 256));
      values[row * cols + col] = tile[py * 256 + px];
    }
  }
  return { cols, rows, cellM, values };
}

/**
 * Trace contour lines from the height grid with marching squares.
 *
 * Each cell is handled independently and emits up to two short segments, which
 * are then joined end-to-end into polylines. Joining is what makes the lines
 * drawable as GeoJSON LineStrings rather than thousands of two-point stubs.
 *
 * @param {import('../model/region.js').Grid} terrain
 * @param {import('../model/region.js').LocalFrame} frame
 * @returns {Object} GeoJSON FeatureCollection; each feature has {elevation, major}
 */
export function buildContours(terrain, frame) {
  const { cols, rows, cellM, values } = terrain;
  let min = Infinity, max = -Infinity;
  for (const v of values) { if (v < min) min = v; if (v > max) max = v; }

  const step = REGION.CONTOUR_INTERVAL_M;
  const features = [];
  const first = Math.ceil(min / step) * step;

  for (let level = first; level <= max; level += step) {
    const segments = marchingSquares(values, cols, rows, level);
    if (!segments.length) continue;
    const major = Math.abs(level % REGION.CONTOUR_MAJOR_M) < 1e-6;

    for (const line of joinSegments(segments)) {
      // Grid coordinates are in cell units; convert to metres, then to lon/lat.
      const coords = line.map(([gx, gy]) =>
        frame.toLonLat((gx + 0.5) * cellM, (gy + 0.5) * cellM));
      features.push({
        type: 'Feature',
        geometry: { type: 'LineString', coordinates: coords },
        properties: { elevation: level, major },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Trace one level of a scalar grid into joined polylines, in fractional cell
 * coordinates. Shared by the contour tracer and the sea outline.
 */
export function traceLevel(values, cols, rows, level) {
  return joinSegments(marchingSquares(values, cols, rows, level));
}

/**
 * Sea polygons for rendering, traced from the height grid at 0 m.
 *
 * The spec avoids building coastline polygons because closing an open coastline
 * against the region boundary is notoriously fiddly. The trick that removes the
 * problem entirely: pad the height grid with a one-cell border of very high
 * land before tracing. Every sea area is then fully enclosed by land, so
 * marching squares returns closed rings with no open ends to stitch. The coast
 * is clipped one cell inside the bbox, which is invisible at any play zoom.
 *
 * Known limit: a land island sitting inside a sea area comes back as its own
 * ring rather than a hole in the sea ring, so it would be painted as sea. Real
 * 15 km regions rarely contain one, and the fix (ring containment tests) is not
 * worth the code until a region needs it.
 *
 * @param {import('../model/region.js').Grid} terrain
 * @param {import('../model/region.js').LocalFrame} frame
 * @returns {Object} GeoJSON FeatureCollection of Polygons
 */
export function buildSeaPolygons(terrain, frame) {
  const { cols, rows, cellM, values } = terrain;

  // Pad by one cell of high land so every sea region closes on itself.
  const pc = cols + 2, pr = rows + 2;
  const padded = new Array(pc * pr).fill(1000);
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      padded[(row + 1) * pc + (col + 1)] = values[row * cols + col];
    }
  }

  // Trace at just above sea level: cells below 0 m are the sea side.
  const rings = traceLevel(padded, pc, pr, REGION.SEA_LEVEL_M);
  const features = [];

  for (const ring of rings) {
    if (ring.length < 4) continue;
    // Undo the one-cell pad, then cell coordinates → metres → lon/lat.
    const coords = ring.map(([gx, gy]) =>
      frame.toLonLat((gx - 1 + 0.5) * cellM, (gy - 1 + 0.5) * cellM));
    // Close the ring; GeoJSON polygons require it.
    const first = coords[0], last = coords[coords.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
    if (coords.length < 4) continue;
    features.push({
      type: 'Feature',
      geometry: { type: 'Polygon', coordinates: [coords] },
      properties: {},
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Marching squares over a scalar grid at one level.
 * Returns segments as [[x1,y1],[x2,y2]] pairs in fractional cell coordinates.
 */
function marchingSquares(values, cols, rows, level) {
  const segments = [];
  const at = (col, row) => values[row * cols + col];
  /** Linear interpolation of the crossing point between two corners. */
  const lerp = (v1, v2) => (level - v1) / (v2 - v1 || 1e-9);

  for (let row = 0; row < rows - 1; row++) {
    for (let col = 0; col < cols - 1; col++) {
      const tl = at(col, row), tr = at(col + 1, row);
      const br = at(col + 1, row + 1), bl = at(col, row + 1);

      // Corner bitmask: which corners are above the level.
      let code = 0;
      if (tl > level) code |= 8;
      if (tr > level) code |= 4;
      if (br > level) code |= 2;
      if (bl > level) code |= 1;
      if (code === 0 || code === 15) continue;

      // Crossing points on each edge, in cell coordinates.
      const top    = [col + lerp(tl, tr), row];
      const right  = [col + 1, row + lerp(tr, br)];
      const bottom = [col + lerp(bl, br), row + 1];
      const left   = [col, row + lerp(tl, bl)];

      // The 14 non-trivial cases. Saddles (5 and 10) emit two segments.
      switch (code) {
        case 1: case 14: segments.push([left, bottom]); break;
        case 2: case 13: segments.push([bottom, right]); break;
        case 3: case 12: segments.push([left, right]); break;
        case 4: case 11: segments.push([top, right]); break;
        case 6: case 9:  segments.push([top, bottom]); break;
        case 7: case 8:  segments.push([left, top]); break;
        case 5:  segments.push([left, top], [bottom, right]); break;
        case 10: segments.push([left, bottom], [top, right]); break;
      }
    }
  }
  return segments;
}

/**
 * Join loose segments into polylines by matching endpoints.
 *
 * Endpoints are quantised to a small grid so floating-point noise doesn't stop
 * two segments that genuinely share a point from joining.
 */
function joinSegments(segments) {
  const key = (p) => `${Math.round(p[0] * 1e4)},${Math.round(p[1] * 1e4)}`;
  /** @type {Map<string, Array<{seg:number[][], atStart:boolean}>>} */
  const ends = new Map();
  const used = new Array(segments.length).fill(false);

  segments.forEach((seg, i) => {
    for (const atStart of [true, false]) {
      const k = key(atStart ? seg[0] : seg[1]);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push({ index: i, atStart });
    }
  });

  const lines = [];
  for (let i = 0; i < segments.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    const line = [segments[i][0], segments[i][1]];

    // Walk forward from the tail, then backward from the head.
    for (const forward of [true, false]) {
      for (;;) {
        const tip = forward ? line[line.length - 1] : line[0];
        const candidates = ends.get(key(tip)) || [];
        const next = candidates.find((c) => !used[c.index]);
        if (!next) break;
        used[next.index] = true;
        const seg = segments[next.index];
        const other = next.atStart ? seg[1] : seg[0];
        if (forward) line.push(other); else line.unshift(other);
      }
    }
    if (line.length > 2) lines.push(line); // Drop single stubs; they're noise.
  }
  return lines;
}
