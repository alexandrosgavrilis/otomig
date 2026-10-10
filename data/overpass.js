/**
 * Overpass: build the queries, fetch them, parse the responses.
 *
 * **Two queries, not one grid of chunks.** Phase R established that the thing
 * making Overpass refuse large boxes was never the box area — it was the `>;`
 * recursion over building geometry nodes, which a dense city supplies at about
 * 9,000 per km². Split on that line and the picture inverts:
 *
 *   - `buildMainQuery` — roads, rail, water, stations and POI nodes, with the
 *     recursion, because shared OSM node ids are what the routing graph is
 *     built from. One request covers a whole 15 km region in ~13 s.
 *   - `buildBuildingQuery` — buildings as `out geom`, no recursion. The only
 *     part heavy enough to need chunking at all.
 *
 * Payload turned out not to be the constraint it was thought to be: Overpass
 * gzips its JSON about 7.5×, so a dense 6 km import is ~7 MB on the wire rather
 * than the ~66 MB that decoded-size measurements suggested. The old caution
 * still applies though, and costs nothing: never `out meta`, and get node
 * geometry with `out skel qt`, which emits bare id/lat/lon and nothing else.
 *
 * Numbers and method: RESEARCH_TILES.md §3 and §8.
 */

import { REGION, BUILD, POPULATION } from '../config.js';
import { chunkBbox } from '../model/region.js';

/** Road classes we keep. Service roads, tracks, footways and paths are not roads here. */
const ROAD_CLASSES = [
  'motorway', 'motorway_link', 'trunk', 'trunk_link', 'primary', 'primary_link',
  'secondary', 'secondary_link', 'tertiary', 'tertiary_link',
  'unclassified', 'residential', 'living_street', 'pedestrian',
];

/** Tags that make a building non-residential, used when `building=yes`. */
const COMMERCIAL_TAGS = ['shop', 'office', 'amenity', 'tourism'];

/** Overpass bbox order is south,west,north,east, unlike ours. */
function bboxQL([west, south, east, north]) {
  return `${south},${west},${north},${east}`;
}

/**
 * Everything except buildings, for one box.
 *
 * `out body` gives us tagged elements; `>;` recurses down to their nodes and
 * `out skel qt` emits those as bare coordinates. Roads and rail genuinely need
 * that recursion — shared OSM node ids are what let the routing graph cross way
 * boundaries without stitching — but it is cheap here, because roads drag far
 * fewer nodes behind them than buildings do.
 *
 * This is deliberately one query for the whole region rather than a grid of
 * chunks. Phase R measured a 15 km box of central Athens served in a single
 * request: 4.71 MB on the wire, 13.5 s. See RESEARCH_TILES.md §3.
 *
 * @param {[number,number,number,number]} bbox [west, south, east, north]
 */
export function buildMainQuery(bbox) {
  const bb = bboxQL(bbox);
  const roads = ROAD_CLASSES.join('|');
  // Only amenities people actually travel to; see POPULATION.POI_AMENITIES.
  const amenities = POPULATION.POI_AMENITIES.join('|');

  return `[out:json][timeout:${Math.round(REGION.OVERPASS_TIMEOUT_MS / 1000)}];
(
  way["highway"~"^(${roads})$"](${bb});
  way["natural"="water"](${bb});
  way["railway"="rail"](${bb});
  node["railway"~"^(station|halt)$"](${bb});
  node["shop"](${bb});
  node["amenity"~"^(${amenities})$"](${bb});
);
out body;
>;
out skel qt;`;
}

/**
 * Buildings for one box, as inline geometry.
 *
 * `out geom` attaches each way's coordinates directly instead of emitting the
 * nodes separately, which means **no `>;` recursion**. That recursion was the
 * whole problem: a dense box drags ~9,000 building geometry nodes per km²
 * through it, and it — not the box area — is what made Overpass return 504 on
 * every 5 km chunk. Without it the same server happily builds a 15 km box
 * (RESEARCH_TILES.md §3).
 *
 * Buildings need no node ids. Nothing joins them to anything; they become
 * rings, a floor-area estimate and an occupancy raster. Roads are the only
 * thing whose topology matters, and they keep `out body` above.
 *
 * Full geometry rather than centroids, because outlines are drawn on the map
 * and Phase 4's "track cannot cross a building" rule has to agree with what the
 * player can see.
 *
 * @param {[number,number,number,number]} bbox [west, south, east, north]
 */
export function buildBuildingQuery(bbox) {
  return `[out:json][timeout:${Math.round(REGION.OVERPASS_TIMEOUT_MS / 1000)}];
way["building"](${bboxQL(bbox)});
out geom;`;
}

/**
 * Fetch one chunk, retrying with backoff on 429 (rate limited) and 504
 * (gateway timeout) — the two failures Overpass actually returns under load.
 *
 * @param {[number,number,number,number]} bbox
 * @param {(msg:string)=>void} [log]
 * @returns {Promise<Object>} the raw Overpass JSON
 */
export async function fetchChunk(bbox, log, buildBody = buildMainQuery) {
  const body = buildBody(bbox);
  let delay = REGION.OVERPASS_RETRY_MS;

  // Two different failures wear the same retry loop, and they want opposite
  // treatment:
  //
  //   429 and dropped connections mean "not now" — waiting genuinely helps, so
  //   these get the full ladder.
  //
  //   504 and a `remark` mean "this query is too big for me". Re-sending the
  //   identical query mostly fails identically; what helps is asking for less,
  //   which only `fetchChunkAdaptive` can do by subdividing. Burning the full
  //   ladder first just delays the fix — measured at 22 Overpass requests for a
  //   10 km import that should cost 5. They get one retry, because Phase R
  //   showed a 504 often is transient, and then we give up so the box can be
  //   split.
  const heavyBudget = Math.min(REGION.OVERPASS_HEAVY_RETRY_MAX, REGION.OVERPASS_RETRY_MAX);
  let heavyAttempts = 0;

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

    if (response.ok) {
      const json = await response.json();
      // Overpass does not always signal failure with a status code. A query
      // that times out or runs out of memory server-side comes back as
      // **HTTP 200** with an empty `elements` array and a `remark` explaining
      // why. Treated as success it silently yields a region with no roads and
      // no buildings, which reaches the player as an empty blue map with no
      // error — exactly what the first live imports produced. Treat it as the
      // failure it is, and let the retry and subdivision logic handle it.
      if (json.remark) {
        if (lastAttempt || heavyAttempts >= heavyBudget) {
          throw new Error(`Overpass: ${json.remark}`);
        }
        heavyAttempts++;
        log?.(`Overpass could not finish the query, retrying in ${delay / 1000}s`);
        await new Promise((r) => setTimeout(r, delay));
        delay *= 2;
        continue;
      }
      return json;
    }

    const retryable = response.status === 429 || response.status === 504;
    // A 504 is the "too big" signal; 429 is pure rate limiting.
    if (response.status === 504) heavyAttempts++;
    const outOfBudget = response.status === 504 && heavyAttempts > heavyBudget;
    if (!retryable || lastAttempt || outOfBudget) {
      throw new Error(`Overpass HTTP ${response.status}`);
    }

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
 * Fetch a chunk, splitting it into four and recursing if Overpass refuses.
 *
 * This is what lets one chunk count serve both a dense city and an empty
 * island. A 504 means the server gave up building the result, and retrying the
 * identical query just fails again — the only thing that helps is asking for
 * less. Sparse regions never subdivide and pay nothing for this.
 *
 * @param {[number,number,number,number]} bbox
 * @param {(msg:string)=>void} [log]
 * @param {number} [depth]
 * @returns {Promise<Object[]>} one or more raw Overpass responses
 */
export async function fetchChunkAdaptive(bbox, log, depth = 0, buildBody = buildMainQuery) {
  try {
    return [await fetchChunk(bbox, log, buildBody)];
  } catch (error) {
    if (depth >= REGION.OVERPASS_MAX_SUBDIVIDE) throw error;

    const message = String(error?.message || error);
    // 504 and timeouts mean "too much to build". A 400 means our query is
    // wrong and splitting it would just fail four times as slowly.
    // Overpass's own `remark` wording is included: it reports a server-side
    // give-up as "runtime error: Query timed out" or "out of memory", both of
    // which a smaller box can fix.
    const tooHeavy = message.includes('504') || message.includes('timed out') ||
      message.includes('unreachable') || message.includes('out of memory') ||
      message.includes('runtime error');
    if (!tooHeavy) throw error;

    log?.('Area too dense for one query — splitting it');
    const responses = [];
    for (const quarter of chunkBbox(bbox, 2)) {
      responses.push(...await fetchChunkAdaptive(quarter, log, depth + 1, buildBody));
    }
    return responses;
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
        } else if (tags.shop || POPULATION.POI_AMENITIES.includes(tags.amenity)) {
          // Mirrors the query filter, so a stray amenity arriving from a
          // cached or hand-made response is rejected the same way.
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

/**
 * A way → a lon/lat ring. Used for buildings and water.
 *
 * Handles both Overpass output modes, because the import uses both: water
 * arrives from `out body` + `>;` as node references to look up, and buildings
 * arrive from `out geom` with their coordinates attached. Preferring the inline
 * geometry keeps the building path independent of the node map entirely.
 *
 * @param {Object} way
 * @param {Map<number,[number,number]>} [osmNodes] only needed for `out body` ways
 * @returns {Array<[number,number]>}
 */
export function wayRing(way, osmNodes) {
  if (Array.isArray(way.geometry)) {
    const ring = [];
    // Overpass emits `null` for a point outside the queried box when a way is
    // clipped; skipping them would silently reshape the building.
    for (const point of way.geometry) {
      if (point) ring.push([point.lon, point.lat]);
    }
    return ring;
  }

  const ring = [];
  for (const ref of way.nodes || []) {
    const coord = osmNodes?.get(ref);
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
