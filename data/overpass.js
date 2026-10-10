/**
 * Overpass: build the queries, fetch the chunks, parse the response.
 *
 * Payload size is the thing to watch. The Overpass usage policy asks regular
 * users to stay under ~10 MB/day, and a dense 15 km building query can exceed
 * that alone (RESEARCH.md §4). So: never `out meta`, fetch tags only for the
 * ways we keep, and get node geometry with `out skel qt`, which emits bare
 * id/lat/lon and nothing else.
 */

import { REGION, BUILD } from '../config.js';

/** Road classes we keep. Service roads, tracks, footways and paths are not roads here. */
const ROAD_CLASSES = [
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  'unclassified', 'residential', 'living_street', 'pedestrian',
];

/** Tags that make a building non-residential, used when `building=yes`. */
const COMMERCIAL_TAGS = ['shop', 'office', 'amenity', 'tourism'];

/**
 * Overpass QL for one chunk.
 *
 * `out body` gives us tagged elements; `>;` recurses down to their nodes and
 * `out skel qt` emits those as bare coordinates. That pairing is what keeps a
 * dense city's response to tens of MB rather than hundreds.
 *
 * @param {[number,number,number,number]} bbox [west, south, east, north]
 */
export function buildQuery(bbox) {
  const [west, south, east, north] = bbox;
  // Overpass bbox order is south,west,north,east.
  const bb = `${south},${west},${north},${east}`;
  const roads = ROAD_CLASSES.join('|');

  return `[out:json][timeout:180];
(
  way["highway"~"^(${roads})$"](${bb});
  way["building"](${bb});
  way["natural"="water"](${bb});
  way["railway"="rail"](${bb});
  node["railway"~"^(station|halt)$"](${bb});
  node["shop"](${bb});
  node["amenity"](${bb});
);
out body;
>;
out skel qt;`;
}

/**
 * Fetch one chunk, retrying with backoff on 429 (rate limited) and 504
 * (gateway timeout) — the two failures Overpass actually returns under load.
 *
 * @param {[number,number,number,number]} bbox
 * @param {(msg:string)=>void} [log]
 * @returns {Promise<Object>} the raw Overpass JSON
 */
export async function fetchChunk(bbox, log) {
  const body = buildQuery(bbox);
  let delay = REGION.OVERPASS_RETRY_MS;

  for (let attempt = 0; attempt <= REGION.OVERPASS_RETRY_MAX; attempt++) {
    const lastAttempt = attempt === REGION.OVERPASS_RETRY_MAX;
    let response;
    try {
      response = await fetchWithTimeout(REGION.OVERPASS_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body,
      }, REGION.OVERPASS_TIMEOUT_MS);
    } catch (error) {
      // A dropped or timed-out connection is as retryable as a 504, and is
      // what a blocked network looks like from inside the browser.
      if (lastAttempt) {
        throw new Error(`Overpass unreachable: ${error?.message || error}`);
      }
      log?.(`Overpass did not answer, retrying in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
      delay *= 2;
      continue;
    }

    if (response.ok) return response.json();

    const retryable = response.status === 429 || response.status === 504;
    if (!retryable || lastAttempt) throw new Error(`Overpass HTTP ${response.status}`);

    log?.(`Overpass ${response.status}, retrying in ${delay / 1000}s`);
    await new Promise((r) => setTimeout(r, delay));
    delay *= 2;
  }
  throw new Error('unreachable');
}

/**
 * `fetch` with a deadline. Without one, a connection that is silently dropped
 * — a firewall, a captive portal, a sandbox with no route out — never settles,
 * and the import hangs behind a progress bar that will never move again.
 *
 * @param {string|URL} url
 * @param {RequestInit} options
 * @param {number} timeoutMs
 */
export async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw new Error(`timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Parse one or more Overpass responses into the raw pieces the region builder
 * needs. Chunks overlap at their edges, so elements are de-duplicated by id.
 *
 * @param {Object[]} responses
 * @returns {{roadWays: Object[], buildingWays: Object[], waterWays: Object[],
 *            railWays: Object[], stationNodes: Object[], poiNodes: Object[],
 *            nodes: Map<number, [number,number]>}}
 */
export function parseResponses(responses) {
  /** @type {Map<number, [number, number]>} */
  const nodes = new Map();
  const seenWays = new Set();
  const seenNodes = new Set();

  const roadWays = [];
  const buildingWays = [];
  const waterWays = [];
  const railWays = [];
  const stationNodes = [];
  const poiNodes = [];

  for (const response of responses) {
    for (const el of response.elements || []) {
      if (el.type === 'node') {
        nodes.set(el.id, [el.lon, el.lat]);
        const tags = el.tags;
        if (!tags || seenNodes.has(el.id)) continue;
        seenNodes.add(el.id);
        if (tags.railway === 'station' || tags.railway === 'halt') {
          stationNodes.push(el);
        } else if (tags.shop || tags.amenity) {
          poiNodes.push(el);
        }
      } else if (el.type === 'way') {
        if (seenWays.has(el.id)) continue;
        seenWays.add(el.id);
        const tags = el.tags || {};
        if (tags.highway && ROAD_CLASSES.includes(tags.highway)) roadWays.push(el);
        else if (tags.building) buildingWays.push(el);
        else if (tags.natural === 'water') waterWays.push(el);
        else if (tags.railway === 'rail' && !isDeadRail(tags)) railWays.push(el);
      }
    }
  }
  return { roadWays, buildingWays, waterWays, railWays, stationNodes, poiNodes, nodes };
}

/** Abandoned, disused and razed rail is not usable track. */
function isDeadRail(tags) {
  return Boolean(tags.abandoned || tags.disused || tags.razed ||
    tags['railway:abandoned'] || tags['railway:disused']);
}

/**
 * Turn Overpass ways into a road graph: shared nodes become shared graph nodes,
 * so routing works across way boundaries without any extra stitching.
 *
 * @param {Object[]} ways
 * @param {Map<number, [number,number]>} osmNodes
 * @param {import('../model/region.js').LocalFrame} frame
 * @returns {import('../model/region.js').RoadGraph}
 */
export function buildGraph(ways, osmNodes, frame) {
  /** OSM node id → our node index. */
  const indexOf = new Map();
  const nodes = [];
  const edges = [];

  const nodeIndex = (osmId) => {
    let index = indexOf.get(osmId);
    if (index === undefined) {
      const coord = osmNodes.get(osmId);
      if (!coord) return -1;
      index = nodes.length / 2;
      nodes.push(coord[0], coord[1]);
      indexOf.set(osmId, index);
    }
    return index;
  };

  for (const way of ways) {
    const tags = way.tags || {};
    const cls = tags.highway || 'rail';
    const tunnel = Boolean(tags.tunnel) && tags.tunnel !== 'no';
    const bridge = Boolean(tags.bridge) && tags.bridge !== 'no';
    const name = tags.name;

    const refs = way.nodes || [];
    for (let i = 0; i < refs.length - 1; i++) {
      const a = nodeIndex(refs[i]);
      const b = nodeIndex(refs[i + 1]);
      if (a < 0 || b < 0 || a === b) continue;
      const lengthM = frame.distance(nodes[2 * a], nodes[2 * a + 1], nodes[2 * b], nodes[2 * b + 1]);
      if (lengthM === 0) continue;
      edges.push({ a, b, cls, lengthM, tunnel, bridge, ...(name ? { name } : {}) });
    }
  }
  return { nodes, edges };
}

/** Way nodes → a lon/lat ring. Used for buildings and water. */
export function wayRing(way, osmNodes) {
  const ring = [];
  for (const ref of way.nodes || []) {
    const coord = osmNodes.get(ref);
    if (coord) ring.push(coord);
  }
  return ring;
}

/**
 * Classify a building for the population model.
 *
 * Residential: house, apartments, residential, terrace, detached, and
 * `building=yes` with no commercial tags. Everything else is an attraction with
 * a category weight.
 *
 * @returns {{residential: boolean, category: string}}
 */
export function classifyBuilding(tags) {
  const b = tags.building;
  const RESIDENTIAL = ['house', 'apartments', 'residential', 'terrace', 'detached',
    'semidetached_house', 'bungalow', 'dormitory'];

  if (RESIDENTIAL.includes(b)) return { residential: true, category: 'residential' };

  if (tags.amenity === 'school' || tags.amenity === 'kindergarten' || b === 'school') {
    return { residential: false, category: 'school' };
  }
  if (tags.amenity === 'university' || tags.amenity === 'college' || b === 'university') {
    return { residential: false, category: 'university' };
  }
  if (tags.amenity === 'hospital' || tags.amenity === 'clinic' || b === 'hospital') {
    return { residential: false, category: 'hospital' };
  }
  if (tags.tourism === 'hotel' || b === 'hotel') return { residential: false, category: 'hotel' };
  if (tags.office || b === 'office' || b === 'commercial') {
    return { residential: false, category: 'office' };
  }
  if (tags.shop || b === 'retail' || b === 'supermarket') {
    return { residential: false, category: 'shop' };
  }

  // `building=yes` and friends: residential unless something says otherwise.
  const hasCommercial = COMMERCIAL_TAGS.some((t) => tags[t]);
  if (!hasCommercial) return { residential: true, category: 'residential' };
  return { residential: false, category: 'shop' };
}

/** Road classes a given mode may use. Kept here so the lists live with the parser. */
export const DRIVABLE = {
  bus: new Set(BUILD.BUS_ROADS),
  tram: new Set(BUILD.TRAM_ROADS),
};
