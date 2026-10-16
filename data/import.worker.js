/**
 * The import worker. Everything slow happens here so the UI never freezes:
 * a grid of Overpass requests, a few hundred thousand buildings, elevation
 * tile decoding and marching-squares contours.
 *
 * Protocol — main thread posts one message:
 *   { lon, lat, sizeKm, name, season, difficulty, populationTotal }
 * and the worker posts back, in order:
 *   { type: 'progress', step, done, total, message }
 *   { type: 'done', region }      | { type: 'error', message }
 *
 * Run as a module worker: new Worker(url, { type: 'module' }).
 */

import { buildingChunkCount, REGION } from '../config.js';
import { LocalFrame, squareBbox, chunkBbox, serialiseRegion } from '../model/region.js';
import {
  fetchChunkAdaptive, parseResponses, buildGraph, wayRing,
  buildMainQuery, buildBuildingQuery,
} from './overpass.js';
import { buildHeightGrid, buildContours } from './terrain.js';
import { joinCoastWays, seaFromCoastline, applySeaToTerrain } from './coastline.js';
import { unmappedTiles, fetchGapBuildings } from './overture.js';
import { processBuildings } from '../model/population.js';

/**
 * The steps, in order, with the share of the progress bar each gets.
 *
 * `roads` and `footprints` are two separate Overpass queries rather than one
 * grid of chunks — see RESEARCH_TILES.md §8. Roads, rail, water and POIs come
 * back in a single request for the whole region; buildings are the only part
 * heavy enough to need chunking, so they get the larger share of the bar.
 */
const STEPS = [
  { key: 'roads', label: 'Fetching roads and places', weight: 0.15 },
  { key: 'footprints', label: 'Fetching buildings', weight: 0.3 },
  { key: 'graph', label: 'Building road graph', weight: 0.05 },
  { key: 'gapfill', label: 'Filling in unmapped buildings', weight: 0.1 },
  { key: 'buildings', label: 'Processing buildings', weight: 0.15 },
  { key: 'terrain', label: 'Fetching elevation', weight: 0.15 },
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

  // 1a. Roads, rail, water, stations and POI nodes — one request for the whole
  // region. These need `>;` node recursion so the road graph keeps real OSM
  // node ids, but they drag few nodes behind them, so even a 15 km box serves
  // in one go: Phase R measured 4.71 MB and 13.5 s (RESEARCH_TILES.md §3).
  onProgress('roads', 0, 1);
  const responses = await fetchChunkAdaptive(bbox,
    (msg) => onProgress('roads', 0, 1, msg), 0, buildMainQuery);
  onProgress('roads', 1, 1);

  // 1b. Buildings, as inline geometry and chunked. This is the only heavy part
  // of the import — and the `>;` recursion over building nodes, not the box
  // area, is what used to make every chunk 504.
  const chunks = chunkBbox(bbox, buildingChunkCount(sizeKm));
  onProgress('footprints', 0, chunks.length);
  for (let i = 0; i < chunks.length; i++) {
    responses.push(...await fetchChunkAdaptive(chunks[i],
      (msg) => onProgress('footprints', i, chunks.length, msg), 0, buildBuildingQuery));
    onProgress('footprints', i + 1, chunks.length,
      chunks.length > 1 ? `Fetching buildings (${i + 1}/${chunks.length})` : undefined);
  }

  const parsed = parseResponses(responses);

  // A region with no roads is not a place you can run buses in, and in practice
  // it never means "we picked an empty bit of sea" — it means every chunk came
  // back empty and nothing noticed. Overpass used to manage that with HTTP 200
  // responses carrying a `remark`; `fetchChunk` now rejects those, and this is
  // the backstop. Failing here gives the player a message instead of a blank
  // blue map they cannot do anything with.
  if (parsed.roadWays.length === 0) {
    throw new Error('No roads found in this area. If it is not genuinely empty, ' +
      'Overpass may be overloaded — wait a minute and try again.');
  }

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

  // 3. Buildings OSM never mapped, from Overture's ML footprints — only in
  // tiles where OSM has plenty of road and few buildings. A failure here
  // never fails the import: the region is still playable on OSM alone, just
  // emptier, and the player is told.
  const osmCentroids = parsed.buildingWays.map((way) => {
    const points = way.geometry || [];
    const lon = points.reduce((sum, p) => sum + p.lon, 0) / (points.length || 1);
    const lat = points.reduce((sum, p) => sum + p.lat, 0) / (points.length || 1);
    return [lon, lat];
  });
  const { unmapped } = unmappedTiles(bbox, osmCentroids, roads);
  let gapWays = [];
  let gapError = null;
  onProgress('gapfill', 0, Math.max(1, unmapped.length));
  try {
    ({ ways: gapWays } = await fetchGapBuildings(bbox, unmapped, (done, total) =>
      onProgress('gapfill', done, total, `Filling in unmapped buildings (${done}/${total})`)));
  } catch (error) {
    gapError = String(error?.message || error);
    onProgress('gapfill', 1, 1, 'Building gap-fill unavailable — using OSM buildings only');
  }

  // 4. Buildings → residents, attraction and the occupancy raster.
  onProgress('buildings', 0, 1);
  const { demand, occupancy, residentsTotal, outlines } =
    processBuildings([...parsed.buildingWays, ...gapWays], parsed.poiNodes, parsed.nodes, frame,
      populationTotal, roads);
  onProgress('buildings', 1, 1);

  // 5. Elevation.
  const terrain = await buildHeightGrid(frame,
    (done, total) => onProgress('terrain', done, total, `Fetching elevation (${done}/${total})`));

  // 5b. The sea, from OSM's coastline where it has one, and the height grid
  // made to agree with it so the grade rule sees the same shore as the map.
  // Without a usable coastline the map traces the sea from elevation, as
  // before (render/basemap.js).
  const coastChains = joinCoastWays(parsed.coastWays).map((ids) =>
    ids.map((id) => parsed.nodes.get(id)).filter(Boolean));
  const sea = seaFromCoastline(coastChains, frame);
  if (sea) applySeaToTerrain(terrain, sea, frame, { seaDepthM: REGION.FLAT_SEA_DEPTH_M });

  // 6. Contours.
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
      /**
       * True when residents were scaled to a real total (Nominatim's), in
       * which case the seasonal profile's occupancy factor must not shrink
       * them again — see `residentsFactor` in config.js.
       */
      populationScaled: populationTotal > 0,
      importedAt: Date.now(),
      importVersion: REGION.IMPORT_VERSION,
      /** 'osm' when the sea came from OSM's coastline, 'elevation' otherwise. */
      seaSource: sea ? 'osm' : 'elevation',
      hasOsmRail: rail.edges.length > 0,
      /** Where the buildings came from, for the attribution and the record. */
      buildingSources: {
        osm: parsed.buildingWays.length,
        overture: gapWays.length,
        overtureTilesFilled: gapError ? 0 : unmapped.length,
        ...(gapError ? { overtureError: gapError } : {}),
      },
    },
    roads,
    rail,
    stations,
    water,
    ...(sea ? { sea } : {}),
    buildings: outlines,
    terrain,
    demand,
    occupancy,
    contours,
  });
}
