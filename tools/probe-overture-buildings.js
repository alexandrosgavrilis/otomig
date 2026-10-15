/**
 * How many buildings does Overture have where OSM has almost none?
 *
 * Kiato's 5 km box has 45 buildings in OSM; Lefkada town's has 4,856, because
 * Lefkada had a supervised import of Microsoft's ML building footprints in
 * 2022 and Kiato never did (HANDOFF.md §12). Overture Maps publishes a
 * buildings theme that merges OSM with the Microsoft and Google ML footprints,
 * as one PMTiles archive on public S3 that answers range requests with
 * `Access-Control-Allow-Origin: *` — so a browser could read just the tiles
 * over a region, keyless, from static hosting.
 *
 * This measures whether that is worth doing: buildings per box by source, and
 * which attributes they carry.
 *
 * PMTiles v3 is read directly — a 127-byte header, varint-encoded directories
 * keyed by Hilbert tile id — because the format is small and closed, the same
 * reasoning as tools/mvt.js. https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 *
 * Run: node tools/probe-overture-buildings.js
 */

import { gunzipSync } from 'node:zlib';
import { decodeTile, tileXY, tileToLonLat } from './mvt.js';
import { POPULATION } from '../config.js';

const STAC = 'https://stac.overturemaps.org/catalog.json';
const TILES = (release) =>
  `https://overturemaps-extras-us-west-2.s3.us-west-2.amazonaws.com/tiles/${release}/buildings.pmtiles`;

const SITES = [
  { name: 'Kiato', lon: 22.748, lat: 38.012, osm: 45 },
  { name: 'Lefkada town', lon: 20.705, lat: 38.830, osm: 4856 },
];
const BOX_KM = 5;

let bytesFetched = 0;
let requests = 0;

async function range(url, offset, length) {
  requests++;
  const response = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
  if (response.status !== 206 && response.status !== 200) throw new Error(`HTTP ${response.status}`);
  const buffer = Buffer.from(await response.arrayBuffer());
  bytesFetched += buffer.length;
  return buffer;
}

function readHeader(buf) {
  if (buf.toString('ascii', 0, 7) !== 'PMTiles' || buf[7] !== 3) throw new Error('not PMTiles v3');
  const u64 = (o) => Number(buf.readBigUInt64LE(o));
  return {
    rootOffset: u64(8), rootLength: u64(16),
    leafOffset: u64(40), tileOffset: u64(56),
    internalCompression: buf[97], tileCompression: buf[98],
    minZoom: buf[100], maxZoom: buf[101],
  };
}

const decompress = (buf, kind) => (kind === 2 ? gunzipSync(buf) : buf);

/** Directory entries: {tileId, offset, length, runLength}. */
function readDirectory(buf) {
  let pos = 0;
  const varint = () => {
    let result = 0, shift = 0, byte;
    do { byte = buf[pos++]; result += (byte & 0x7f) * 2 ** shift; shift += 7; } while (byte & 0x80);
    return result;
  };
  const n = varint();
  const entries = Array.from({ length: n }, () => ({}));
  let last = 0;
  for (const e of entries) { last += varint(); e.tileId = last; }
  for (const e of entries) e.runLength = varint();
  for (const e of entries) e.length = varint();
  entries.forEach((e, i) => {
    const value = varint();
    e.offset = value === 0 && i > 0 ? entries[i - 1].offset + entries[i - 1].length : value - 1;
  });
  return entries;
}

/** Hilbert tile id, as the spec defines it. */
function tileId(z, x, y) {
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

async function findTile(url, header, root, id) {
  let entries = root;
  for (let depth = 0; depth < 4; depth++) {
    let lo = 0, hi = entries.length - 1, hit = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (entries[mid].tileId <= id) { hit = entries[mid]; lo = mid + 1; } else hi = mid - 1;
    }
    if (!hit) return null;
    if (hit.runLength === 0) {
      const leaf = await range(url, header.leafOffset + hit.offset, hit.length);
      entries = readDirectory(decompress(leaf, header.internalCompression));
      continue;
    }
    if (id >= hit.tileId + hit.runLength) return null;
    const tile = await range(url, header.tileOffset + hit.offset, hit.length);
    return decompress(tile, header.tileCompression);
  }
  return null;
}

const release = (await (await fetch(STAC)).json()).latest;
const url = TILES(release);
const header = readHeader(await range(url, 0, 127));
const root = readDirectory(decompress(await range(url, header.rootOffset, header.rootLength),
  header.internalCompression));
console.log(`Overture ${release} buildings.pmtiles — zoom ${header.minZoom}–${header.maxZoom}`);

for (const site of SITES) {
  const dLat = BOX_KM / 2 / 111.32;
  const dLon = BOX_KM / 2 / (111.32 * Math.cos(site.lat * Math.PI / 180));
  const [w, s, e, n] = [site.lon - dLon, site.lat - dLat, site.lon + dLon, site.lat + dLat];
  const z = header.maxZoom;
  const [x0, y0] = tileXY(w, n, z);
  const [x1, y1] = tileXY(e, s, z);

  const seen = new Set();
  const bySource = {};
  // Floor area the way model/population.js counts it: footprint × levels.
  // ML footprints carry no levels, so they get the default — which is the
  // number that matters if they were ever used for residents.
  const areaBySource = {};
  const footprints = [];
  const mPerDegLat = 111320;
  const mPerDegLon = 111320 * Math.cos(site.lat * Math.PI / 180);
  const keys = {};
  let withHeight = 0, withFloors = 0, withClass = 0, tiles = 0, tileBytes = 0;
  for (let x = x0; x <= x1; x++) {
    for (let y = y0; y <= y1; y++) {
      const data = await findTile(url, header, root, tileId(z, x, y));
      if (!data) continue;
      tiles++;
      tileBytes += data.length;
      for (const layer of Object.values(decodeTile(data))) {
        if (!/building/.test(layer.name) || /part/.test(layer.name)) continue;
        for (const feature of layer.features) {
          const props = feature.properties || {};
          const id = props.id ?? `${layer.name}:${feature.id}`;
          // Area per clipped piece, so a building split across two tiles is
          // counted whole; only pieces whose centre lies in the box count.
          const ring = feature.rings[0] || [];
          const lonLat = ring.map(([px, py]) => tileToLonLat(x, y, z, px, py, layer.extent));
          const cLon = lonLat.reduce((sum, p) => sum + p[0], 0) / (lonLat.length || 1);
          const cLat = lonLat.reduce((sum, p) => sum + p[1], 0) / (lonLat.length || 1);
          const inBox = cLon >= w && cLon <= e && cLat >= s && cLat <= n;
          let area = 0;
          for (const r of feature.rings) {
            const pts = r.map(([px, py]) => tileToLonLat(x, y, z, px, py, layer.extent));
            let sum = 0;
            for (let i = 0; i < pts.length; i++) {
              const [x1, y1] = pts[i];
              const [x2, y2] = pts[(i + 1) % pts.length];
              sum += (x1 * mPerDegLon) * (y2 * mPerDegLat) - (x2 * mPerDegLon) * (y1 * mPerDegLat);
            }
            area += sum / 2;
          }
          area = Math.abs(area);
          const sourceOf = String(props['@geometry_source'] ?? props.sources ?? 'unknown')
            .match(/OpenStreetMap|Microsoft|Google|Esri|meta|USGS|unknown/i)?.[0] ?? 'other';
          if (inBox) {
            areaBySource[sourceOf] = (areaBySource[sourceOf] || 0) + area;
            if (!seen.has(id)) footprints.push(area);
          }
          if (seen.has(id) || !inBox) continue;
          seen.add(id);
          for (const key of Object.keys(props)) keys[key] = (keys[key] || 0) + 1;
          const source = String(props['@geometry_source'] ?? props.sources ?? 'unknown')
            .match(/OpenStreetMap|Microsoft|Google|Esri|meta|USGS|unknown/i)?.[0] ?? 'other';
          bySource[source] = (bySource[source] || 0) + 1;
          if (props.height != null) withHeight++;
          if (props.num_floors != null) withFloors++;
          if (props.class != null || props.subtype != null) withClass++;
        }
      }
    }
  }
  footprints.sort((a, b) => a - b);
  const residents = (m2) => Math.round(m2 * POPULATION.DEFAULT_LEVELS / POPULATION.M2_PER_RESIDENT);
  console.log(`\n${site.name}: ${seen.size} buildings inside the box, from ${tiles} z${z} tiles ` +
    `(${(tileBytes / 1048576).toFixed(1)} MB), against ${site.osm} in OSM`);
  console.log(`  by geometry source: ${JSON.stringify(bySource)}`);
  console.log(`  with height ${withHeight}, with floors ${withFloors}, with class/subtype ${withClass}`);
  console.log(`  properties seen: ${Object.entries(keys).map(([k, v]) => `${k}:${v}`).join(' ')}`);
  console.log(`  footprint median ${Math.round(footprints[footprints.length >> 1])} m², ` +
    `${Math.round(100 * footprints.filter((a) => a < 40).length / footprints.length)}% under 40 m²`);
  console.log(`  residents at ${POPULATION.DEFAULT_LEVELS} levels, ${POPULATION.M2_PER_RESIDENT} m² each: ` +
    Object.entries(areaBySource).map(([k, v]) => `${k} ${residents(v).toLocaleString()}`).join(', '));
}
console.log(`\n${requests} range requests, ${(bytesFetched / 1048576).toFixed(1)} MB fetched`);
