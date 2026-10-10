/**
 * The import worker. Everything slow happens here so the UI never freezes:
 * nine Overpass requests, a few hundred thousand buildings, elevation tile
 * decoding and marching-squares contours.
 *
 * Protocol — main thread posts one message:
 *   { lon, lat, sizeKm, name, season, difficulty, populationTotal }
 * and the worker posts back, in order:
 *   { type: 'progress', step, done, total, message }
 *   { type: 'done', region }      | { type: 'error', message }
 *
 * Run as a module worker: new Worker(url, { type: 'module' }).
 */

import { REGION } from '../config.js';
import { LocalFrame, squareBbox, chunkBbox, serialiseRegion } from '../model/region.js';
import { fetchChunkAdaptive, parseResponses, buildGraph, wayRing } from './overpass.js';
import { buildHeightGrid, buildContours } from './terrain.js';
import { processBuildings } from '../model/population.js';

/** The steps, in order, with the share of the progress bar each gets. */
const STEPS = [
  { key: 'roads', label: 'Fetching map data', weight: 0.45 },
  { key: 'graph', label: 'Building road graph', weight: 0.05 },
  { key: 'buildings', label: 'Processing buildings', weight: 0.2 },
  { key: 'terrain', label: 'Fetching elevation', weight: 0.2 },
  { key: 'contours', label: 'Tracing contours', weight: 0.1 },
];

self.onmessage = async (event) => {
  try {
    const region = await importRegion(event.data, report);
    self.postMessage({ type: 'done', region });
  } catch (error) {
    self.postMessage({ type: 'error', message: String(error?.message || error) });
  }
};

/** Report progress as a single 0..1 fraction plus a human step label. */
function report(stepKey, done, total, message) {
  let base = 0;
  for (const step of STEPS) {
    if (step.key === stepKey) {
      const fraction = total > 0 ? done / total : 0;
      self.postMessage({
        type: 'progress',
        step: stepKey,
        fraction: base + step.weight * fraction,
        message: message || step.label,
      });
      return;
    }
    base += step.weight;
  }
}

/**
 * @param {{lon:number, lat:number, sizeKm:number, name:string, season:string,
 *          difficulty:string, populationTotal:number}} request
 * @param {(step:string, done:number, total:number, message?:string)=>void} onProgress
 * @returns {Promise<Object>} a JSON-safe region
 */
export async function importRegion(request, onProgress) {
  const { lon, lat, sizeKm, name, season, difficulty, populationTotal = 0 } = request;
  const bbox = squareBbox(lon, lat, sizeKm);
  const frame = new LocalFrame(bbox);

  // 1. Overpass, as 3×3 chunks merged together.
  const chunks = chunkBbox(bbox, REGION.OVERPASS_CHUNKS);
  const responses = [];
  onProgress('roads', 0, chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    responses.push(...await fetchChunkAdaptive(chunks[i],
      (msg) => onProgress('roads', i, chunks.length, msg)));
    onProgress('roads', i + 1, chunks.length, `Fetching map data (${i + 1}/${chunks.length})`);
  }

  const parsed = parseResponses(responses);

  // 2. Road and rail graphs.
  onProgress('graph', 0, 1);
  const roads = buildGraph(parsed.roadWays, parsed.nodes, frame);
  const rail = buildGraph(parsed.railWays, parsed.nodes, frame);
  const stations = parsed.stationNodes.map((node) => ({
    lon: node.lon,
    lat: node.lat,
    name: node.tags?.name || 'Station',
    halt: node.tags?.railway === 'halt',
  }));
  const water = parsed.waterWays
    .map((way) => wayRing(way, parsed.nodes))
    .filter((ring) => ring.length >= 4);
  onProgress('graph', 1, 1);

  // 3. Buildings → residents, attraction and the occupancy raster.
  onProgress('buildings', 0, 1);
  const { demand, occupancy, residentsTotal } =
    processBuildings(parsed.buildingWays, parsed.poiNodes, parsed.nodes, frame, populationTotal);
  onProgress('buildings', 1, 1);

  // 4. Elevation.
  const terrain = await buildHeightGrid(frame,
    (done, total) => onProgress('terrain', done, total, `Fetching elevation (${done}/${total})`));

  // 5. Contours.
  onProgress('contours', 0, 1);
  const contours = buildContours(terrain, frame);
  onProgress('contours', 1, 1);

  return serialiseRegion({
    meta: {
      name: name || 'Unnamed region',
      center: [lon, lat],
      sizeKm,
      bbox,
      season,
      difficulty,
      populationTotal: Math.round(residentsTotal),
      importedAt: Date.now(),
      hasOsmRail: rail.edges.length > 0,
    },
    roads,
    rail,
    stations,
    water,
    terrain,
    demand,
    occupancy,
    contours,
  });
}
