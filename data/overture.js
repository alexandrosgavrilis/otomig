/**
 * Buildings OSM has not mapped, from Overture Maps' building tiles.
 *
 * The population model is buildings: no buildings, no residents, no demand.
 * Much of Greece outside the cities has its roads mapped in OSM and almost
 * none of its buildings — Kiato's 5 km box has 45 — while Microsoft's ML
 * footprints cover it. Overture's buildings theme merges OSM with those
 * footprints (OSM wins where both exist) and publishes the lot as one PMTiles
 * archive on public S3, which answers range requests with
 * `Access-Control-Allow-Origin: *`. So the import can read just the tiles over
 * a region, from the browser, with no key and no server of our own.
 *
 * Two rules keep this a gap-filler rather than a second source of truth:
 *
 *   - **Only unmapped tiles are fetched.** `unmappedTiles` compares OSM's
 *     buildings to the road length in each tile; a well-mapped city fetches
 *     nothing, which matters because Overture's tiles there are mostly the OSM
 *     buildings we already have.
 *   - **Only non-OSM footprints are kept.** OSM's buildings come from Overpass
 *     with their tags, which the attraction model needs. ML footprints carry
 *     no category, so they arrive as plain `building=yes` — homes, to the
 *     population model.
 *
 * PMTiles v3 and MVT are both small closed formats, read directly here and in
 * data/mvt.js rather than through libraries, as the no-build-step rule asks.
 * https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 */

import { OVERTURE } from '../config.js';
import { decodeTile, tileXY, tileToLonLat } from './mvt.js';

/** Fetch with a timeout: `fetch` has none, and a dropped connection would hang the import. */
async function fetchWithTimeout(url, options = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OVERTURE.TIMEOUT_MS);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The current release's buildings archive. Release paths change; ask the catalog. */
export async function latestBuildingsUrl() {
  const response = await fetchWithTimeout(OVERTURE.STAC_URL);
  if (!response.ok) throw new Error(`Overture catalog: HTTP ${response.status}`);
  const { latest } = await response.json();
  if (!latest) throw new Error('Overture catalog names no latest release');
  return OVERTURE.TILES_URL.replace('{release}', latest);
}

/** Gunzip in the browser or in Node, with no library. */
async function gunzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const decompress = (bytes, kind) => (kind === 2 ? gunzip(bytes) : bytes);

/**
 * A PMTiles v3 archive read over HTTP range requests.
 * Directories are cached, so a region's tiles cost one request each after the
 * first few.
 */
export class PMTiles {
  constructor(url) {
    this.url = url;
    this.header = null;
    this.directories = new Map();
  }

  async range(offset, length) {
    const response = await fetchWithTimeout(this.url,
      { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
    if (response.status !== 206 && response.status !== 200) {
      throw new Error(`Overture tiles: HTTP ${response.status}`);
    }
    return new Uint8Array(await response.arrayBuffer());
  }

  async readHeader() {
    if (this.header) return this.header;
    this.header = parseHeader(await this.range(0, 127));
    return this.header;
  }

  async directory(offset, length) {
    const key = `${offset}:${length}`;
    if (!this.directories.has(key)) {
      const bytes = await decompress(await this.range(offset, length),
        this.header.internalCompression);
      this.directories.set(key, parseDirectory(bytes));
    }
    return this.directories.get(key);
  }

  /** One tile's decompressed bytes, or null if the archive has none there. */
  async tile(z, x, y) {
    const header = await this.readHeader();
    const id = tileId(z, x, y);
    let entries = await this.directory(header.rootOffset, header.rootLength);
    for (let depth = 0; depth < 4; depth++) {
      const entry = findEntry(entries, id);
      if (!entry) return null;
      if (entry.runLength === 0) {
        entries = await this.directory(header.leafOffset + entry.offset, entry.length);
        continue;
      }
      if (id >= entry.tileId + entry.runLength) return null;
      return decompress(await this.range(header.tileOffset + entry.offset, entry.length),
        header.tileCompression);
    }
    return null;
  }
}

/** The fixed 127-byte header. */
export function parseHeader(bytes) {
  const text = String.fromCharCode(...bytes.subarray(0, 7));
  if (text !== 'PMTiles' || bytes[7] !== 3) throw new Error('not a PMTiles v3 archive');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u64 = (offset) => Number(view.getBigUint64(offset, true));
  return {
    rootOffset: u64(8), rootLength: u64(16),
    leafOffset: u64(40), tileOffset: u64(56),
    internalCompression: bytes[97], tileCompression: bytes[98],
    minZoom: bytes[100], maxZoom: bytes[101],
  };
}

/**
 * A directory: tile ids delta-encoded, then run lengths, lengths and offsets,
 * each as a column of varints. An offset of 0 after the first entry means
 * "straight after the previous entry".
 *
 * @returns {Array<{tileId:number, runLength:number, length:number, offset:number}>}
 */
export function parseDirectory(bytes) {
  let pos = 0;
  const varint = () => {
    let result = 0;
    let shift = 0;
    let byte;
    do {
      byte = bytes[pos++];
      result += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    } while (byte & 0x80);
    return result;
  };
  const count = varint();
  const entries = Array.from({ length: count }, () => ({}));
  let last = 0;
  for (const entry of entries) { last += varint(); entry.tileId = last; }
  for (const entry of entries) entry.runLength = varint();
  for (const entry of entries) entry.length = varint();
  entries.forEach((entry, i) => {
    const value = varint();
    entry.offset = value === 0 && i > 0
      ? entries[i - 1].offset + entries[i - 1].length
      : value - 1;
  });
  return entries;
}

/** The last entry whose tile id is at or before `id`. */
function findEntry(entries, id) {
  let low = 0;
  let high = entries.length - 1;
  let hit = null;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (entries[mid].tileId <= id) { hit = entries[mid]; low = mid + 1; } else high = mid - 1;
  }
  return hit;
}

/**
 * A tile's id: every tile at lower zooms first, then a Hilbert curve across
 * this zoom, so that nearby tiles sit near each other in the archive.
 */
export function tileId(z, x, y) {
  let id = (4 ** z - 1) / 3;
  const xy = [x, y];
  for (let s = 2 ** (z - 1); s >= 1; s /= 2) {
    const rx = (xy[0] & s) > 0 ? 1 : 0;
    const ry = (xy[1] & s) > 0 ? 1 : 0;
    id += s * s * ((3 * rx) ^ ry);
    if (ry === 0) {
      if (rx === 1) { xy[0] = s - 1 - xy[0]; xy[1] = s - 1 - xy[1]; }
      [xy[0], xy[1]] = [xy[1], xy[0]];
    }
  }
  return id;
}

/** The z/x/y tiles covering a bbox. @returns {Array<[number,number]>} */
export function tilesCovering(bbox, z) {
  const [west, south, east, north] = bbox;
  const [x0, y0] = tileXY(west, north, z);
  const [x1, y1] = tileXY(east, south, z);
  const tiles = [];
  for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) tiles.push([x, y]);
  return tiles;
}

/** A tile's lon/lat bounds, [west, south, east, north]. */
export function tileBounds(x, y, z) {
  const [west, north] = tileToLonLat(x, y, z, 0, 0, 1);
  const [east, south] = tileToLonLat(x, y, z, 1, 1, 1);
  return [west, south, east, north];
}

/**
 * Which tiles OSM has not mapped, judged by buildings per km of road.
 *
 * Roads are the one thing OSM maps almost everywhere, so they are the yardstick:
 * a tile with plenty of road and few buildings is a tile whose buildings were
 * never drawn. A tile with no road at all is open country or sea and is left
 * alone — there is nobody there to serve.
 *
 * @param {Array<[number,number]>} buildingCentroids OSM buildings, lon/lat
 * @param {import('../model/region.js').RoadGraph} roads
 * @returns {{unmapped:Array<[number,number]>, tiles:Array<{x:number,y:number,buildings:number,roadKm:number}>}}
 */
export function unmappedTiles(bbox, buildingCentroids, roads, z = OVERTURE.ZOOM) {
  const stats = new Map(tilesCovering(bbox, z).map(([x, y]) =>
    [`${x}/${y}`, { x, y, buildings: 0, roadKm: 0 }]));
  const statAt = (lon, lat) => {
    const [x, y] = tileXY(lon, lat, z);
    return stats.get(`${x}/${y}`);
  };
  for (const [lon, lat] of buildingCentroids) {
    const stat = statAt(lon, lat);
    if (stat) stat.buildings++;
  }
  for (const edge of roads.edges) {
    // Credit each edge to the tile holding its midpoint; edges are tens of
    // metres against a 1.2 km tile, so the error is negligible.
    const lon = (roads.nodes[2 * edge.a] + roads.nodes[2 * edge.b]) / 2;
    const lat = (roads.nodes[2 * edge.a + 1] + roads.nodes[2 * edge.b + 1]) / 2;
    const stat = statAt(lon, lat);
    if (stat) stat.roadKm += edge.lengthM / 1000;
  }
  const tiles = [...stats.values()];
  const unmapped = tiles
    .filter((t) => t.roadKm > 0 && t.buildings / t.roadKm < OVERTURE.MAPPED_BUILDINGS_PER_ROAD_KM)
    .map((t) => [t.x, t.y]);
  return { unmapped, tiles };
}

/**
 * Clip a ring to the tile square [0, extent]², Sutherland–Hodgman.
 *
 * Vector tiles carry a buffer, so a building straddling two tiles appears in
 * both with overlapping pieces. Clipping each piece to its own tile makes the
 * pieces abut instead, so the building's floor area is counted once.
 */
export function clipRing(ring, extent) {
  const edges = [
    (p) => p[0] >= 0, (p) => p[0] <= extent, (p) => p[1] >= 0, (p) => p[1] <= extent,
  ];
  const cut = [
    (a, b) => lerpAt(a, b, (0 - a[0]) / (b[0] - a[0])),
    (a, b) => lerpAt(a, b, (extent - a[0]) / (b[0] - a[0])),
    (a, b) => lerpAt(a, b, (0 - a[1]) / (b[1] - a[1])),
    (a, b) => lerpAt(a, b, (extent - a[1]) / (b[1] - a[1])),
  ];
  let points = ring.slice(0, ring.length > 1 && samePoint(ring[0], ring.at(-1)) ? -1 : undefined);
  for (let side = 0; side < 4 && points.length > 0; side++) {
    const inside = edges[side];
    const out = [];
    for (let i = 0; i < points.length; i++) {
      const current = points[i];
      const previous = points[(i + points.length - 1) % points.length];
      if (inside(current)) {
        if (!inside(previous)) out.push(cut[side](previous, current));
        out.push(current);
      } else if (inside(previous)) {
        out.push(cut[side](previous, current));
      }
    }
    points = out;
  }
  if (points.length >= 3) points.push(points[0]);
  return points;
}

const lerpAt = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const samePoint = (a, b) => a[0] === b[0] && a[1] === b[1];

/**
 * Overture's non-OSM building footprints inside `bbox`, in the shape Overpass
 * `out geom` gives buildings, so they go through processBuildings unchanged.
 *
 * Holes are dropped (the first ring of each polygon is its outline): a
 * courtyard in an ML footprint is rare and too small to matter to a 200 m
 * demand cell. A piece is kept when its centroid is inside the region.
 *
 * @param {Array<[number,number]>} tiles z/x/y pairs at `OVERTURE.ZOOM`
 * @param {(done:number, total:number)=>void} [onProgress]
 * @returns {Promise<{ways:Object[], tilesRead:number}>}
 */
export async function fetchGapBuildings(bbox, tiles, onProgress = () => {}) {
  if (tiles.length === 0) return { ways: [], tilesRead: 0 };
  const archive = new PMTiles(await latestBuildingsUrl());
  const z = OVERTURE.ZOOM;
  const [west, south, east, north] = bbox;
  const ways = [];
  let tilesRead = 0;

  for (const [x, y] of tiles) {
    const bytes = await archive.tile(z, x, y);
    onProgress(++tilesRead, tiles.length);
    if (!bytes) continue;
    for (const layer of Object.values(decodeTile(bytes))) {
      if (layer.name !== 'building') continue;
      for (const feature of layer.features) {
        if (feature.type !== 'polygon') continue;
        if (feature.properties['@geometry_source'] === 'OpenStreetMap') continue;
        const ring = clipRing(feature.rings[0] || [], layer.extent);
        if (ring.length < 4) continue;
        const geometry = ring.map(([px, py]) => {
          const [lon, lat] = tileToLonLat(x, y, z, px, py, layer.extent);
          return { lon, lat };
        });
        const cLon = geometry.reduce((sum, p) => sum + p.lon, 0) / geometry.length;
        const cLat = geometry.reduce((sum, p) => sum + p.lat, 0) / geometry.length;
        if (cLon < west || cLon > east || cLat < south || cLat > north) continue;
        ways.push({ type: 'way', geometry, tags: { building: 'yes', 'source:overture': 'yes' } });
      }
    }
  }
  return { ways, tilesRead };
}
