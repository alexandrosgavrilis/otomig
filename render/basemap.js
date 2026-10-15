/**
 * The base map: a MapLibre style built entirely from our own imported GeoJSON.
 *
 * No external tiles are involved, so the map works offline once a region is
 * imported. The only optional network layer is the faded OSM raster underlay,
 * which is off by default and dropped without complaint if the tile server
 * refuses us.
 *
 * MapLibre draws the calm, static world — land, water, roads, contours, heat
 * map. Everything that moves or that the player draws is on the Canvas 2D
 * overlay instead, because custom line patterns are far easier there.
 */

import { COLORS, REGION, OSM_UNDERLAY, RENDER, ATTRIBUTION } from '../config.js';
import { buildSeaPolygons } from '../data/terrain.js';

/** Road classes drawn as "major", with their line widths in px. */
const MAJOR_WIDTH = {
  motorway: 4, motorway_link: 3, trunk: 4, trunk_link: 3,
  primary: 3, primary_link: 2.5, secondary: 3, secondary_link: 2.5,
  tertiary: 2, tertiary_link: 2,
};

/**
 * Convert the region's road graph to GeoJSON.
 *
 * Each edge becomes its own two-point LineString. That is more features than
 * strictly necessary, but it keeps per-edge properties (class, tunnel, bridge)
 * intact for styling, and MapLibre handles tens of thousands of short lines
 * without trouble.
 *
 * @param {import('../model/region.js').RoadGraph} graph
 * @param {'major'|'minor'|'all'} which
 */
export function roadsToGeoJSON(graph, which = 'all') {
  const features = [];
  for (const edge of graph.edges) {
    const isMajor = edge.cls in MAJOR_WIDTH;
    if (which === 'major' && !isMajor) continue;
    if (which === 'minor' && isMajor) continue;
    features.push({
      type: 'Feature',
      geometry: {
        type: 'LineString',
        coordinates: [
          [graph.nodes[2 * edge.a], graph.nodes[2 * edge.a + 1]],
          [graph.nodes[2 * edge.b], graph.nodes[2 * edge.b + 1]],
        ],
      },
      properties: {
        cls: edge.cls,
        width: MAJOR_WIDTH[edge.cls] ?? 1.5,
        tunnel: edge.tunnel ? 1 : 0,
        bridge: edge.bridge ? 1 : 0,
      },
    });
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Building outlines to GeoJSON polygons.
 *
 * One feature per building. A dense 6 km region is tens of thousands of small
 * polygons, which MapLibre handles comfortably as a single GeoJSON source —
 * it tiles and indexes them once at load.
 */
export function buildingsToGeoJSON(buildings) {
  return {
    type: 'FeatureCollection',
    features: (buildings || []).map((ring) => {
      const coords = ring.slice();
      const first = coords[0], last = coords[coords.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
      return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [coords] },
        properties: {},
      };
    }).filter((f) => f.geometry.coordinates[0].length >= 4),
  };
}

/** Lake and river rings to GeoJSON polygons. */
export function waterToGeoJSON(water) {
  return {
    type: 'FeatureCollection',
    features: water.map((ring) => {
      const coords = ring.slice();
      const first = coords[0], last = coords[coords.length - 1];
      if (first[0] !== last[0] || first[1] !== last[1]) coords.push(first);
      return {
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [coords] },
        properties: {},
      };
    }),
  };
}

/**
 * The demand heat map: one square per 200 m cell, carrying a 0..1 intensity.
 *
 * In Phase 1 nothing is served yet, so intensity is simply total demand. Phase 2
 * replaces the values with *unserved* demand by calling `setHeatMapData` — the
 * geometry never changes, only the numbers.
 *
 * @param {import('../model/region.js').DemandGrid} demand
 * @param {import('../model/region.js').LocalFrame} frame
 */
export function demandToGeoJSON(demand, frame) {
  const { cols, rows, cellM, residents, attraction } = demand;

  // Normalise against a high percentile rather than the maximum: one tower
  // block shouldn't flatten the whole map to near-zero.
  const totals = residents.map((r, i) => r + attraction[i] * 0.05);
  const sorted = totals.filter((v) => v > 0).sort((a, b) => a - b);
  const scale = sorted.length ? sorted[Math.floor(sorted.length * 0.95)] || 1 : 1;

  const features = [];
  for (let row = 0; row < rows; row++) {
    for (let col = 0; col < cols; col++) {
      const index = row * cols + col;
      const intensity = Math.min(1, totals[index] / scale);
      if (intensity < 0.02) continue; // Empty cells add nothing but file size.
      const [w, s] = frame.toLonLat(col * cellM, row * cellM);
      const [e, n] = frame.toLonLat((col + 1) * cellM, (row + 1) * cellM);
      features.push({
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
        properties: { intensity, cell: index },
      });
    }
  }
  return { type: 'FeatureCollection', features };
}

/**
 * Build the complete MapLibre style for an imported region.
 *
 * @param {import('../model/region.js').Region} region
 * @param {import('../model/region.js').LocalFrame} frame
 */
/**
 * The heat map's GeoJSON, kept here so `setHeatMapData` can edit and re-set it
 * without reading MapLibre's private source state.
 * @type {WeakMap<object, Object>}
 */
const heatData = new WeakMap();

export function buildStyle(region, frame) {
  const heat = demandToGeoJSON(region.demand, frame);
  heatData.set(region, heat);

  const sources = {
    sea: { type: 'geojson', data: buildSeaPolygons(region.terrain, frame) },
    water: { type: 'geojson', data: waterToGeoJSON(region.water) },
    buildings: { type: 'geojson', data: buildingsToGeoJSON(region.buildings) },
    contours: { type: 'geojson', data: region.contours },
    roadsMajor: { type: 'geojson', data: roadsToGeoJSON(region.roads, 'major') },
    roadsMinor: { type: 'geojson', data: roadsToGeoJSON(region.roads, 'minor') },
    rail: { type: 'geojson', data: roadsToGeoJSON(region.rail, 'all') },
    heat: { type: 'geojson', data: heat },
  };

  // The real-map underlay. Attribution is attached to the source so MapLibre
  // shows it only while the layer is actually on.
  sources.osmUnderlay = {
    type: 'raster',
    tiles: [OSM_UNDERLAY.TILE_URL],
    tileSize: 256,
    maxzoom: 19,
    attribution: ATTRIBUTION.osm,
  };

  const layers = [
    { id: 'background', type: 'background', paint: { 'background-color': COLORS.land } },

    // Underlay sits above the land fill but below everything we draw, so our
    // roads and lines stay readable on top of real street detail.
    {
      id: 'osm-underlay',
      type: 'raster',
      source: 'osmUnderlay',
      layout: { visibility: 'none' },
      paint: {
        'raster-saturation': OSM_UNDERLAY.SATURATION,
        'raster-opacity': OSM_UNDERLAY.OPACITY,
      },
    },

    { id: 'sea', type: 'fill', source: 'sea', paint: { 'fill-color': COLORS.water } },
    { id: 'water', type: 'fill', source: 'water', paint: { 'fill-color': COLORS.water } },

    // Buildings sit under the roads, so a street always reads on top of the
    // blocks it runs between. The outline only appears once zoomed in enough
    // for individual buildings to be distinguishable.
    {
      id: 'buildings',
      type: 'fill',
      source: 'buildings',
      paint: {
        'fill-color': COLORS.building,
        'fill-outline-color': [
          'interpolate', ['linear'], ['zoom'],
          14, COLORS.building,      // merge into the fill when far out
          16, COLORS.buildingStroke,
        ],
      },
    },

    // Contours: faint every 20 m, a touch stronger every 100 m. Only above
    // sea level — see `buildContours`. The filter repeats that rule for
    // regions cached before it, which still carry a 0 m line.
    {
      id: 'contours-minor',
      type: 'line',
      source: 'contours',
      filter: ['all', ['!', ['get', 'major']], ['>', ['get', 'elevation'], REGION.SEA_LEVEL_M]],
      paint: { 'line-color': COLORS.contour, 'line-width': 0.7 },
    },
    {
      id: 'contours-major',
      type: 'line',
      source: 'contours',
      filter: ['all', ['get', 'major'], ['>', ['get', 'elevation'], REGION.SEA_LEVEL_M]],
      paint: { 'line-color': COLORS.contourMajor, 'line-width': 1.1 },
    },

    // Minor roads appear only when zoomed in, as the spec asks.
    {
      id: 'roads-minor',
      type: 'line',
      source: 'roadsMinor',
      minzoom: RENDER.MINOR_ROAD_MIN_ZOOM,
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': COLORS.roadMinor,
        'line-width': ['interpolate', ['linear'], ['zoom'], 14, 1, 17, 3],
      },
    },
    {
      id: 'roads-major',
      type: 'line',
      source: 'roadsMajor',
      layout: { 'line-cap': 'round' },
      paint: {
        'line-color': COLORS.roadMajor,
        // Scale the per-class width with zoom so the map reads at every scale.
        // `zoom` is only legal as the direct input of a top-level interpolate,
        // so the per-feature multiply has to live inside each stop rather than
        // wrapping the interpolate.
        'line-width': [
          'interpolate', ['linear'], ['zoom'],
          11, ['*', ['get', 'width'], 0.5],
          13, ['*', ['get', 'width'], 1.0],
          16, ['*', ['get', 'width'], 2.2],
        ],
      },
    },

    // Existing OSM rail, drawn like train track but slightly darker.
    {
      id: 'rail-existing',
      type: 'line',
      source: 'rail',
      paint: {
        'line-color': '#A69E91',
        'line-width': ['interpolate', ['linear'], ['zoom'], 11, 1, 16, 3],
      },
    },

    // Heat map, off by default.
    {
      id: 'heat',
      type: 'fill',
      source: 'heat',
      layout: { visibility: 'none' },
      paint: {
        'fill-color': [
          'interpolate', ['linear'], ['get', 'intensity'],
          0, COLORS.heat[0],
          0.5, COLORS.heat[1],
          1, COLORS.heat[2],
        ],
      },
    },
  ];

  return {
    version: 8,
    name: region.meta.name,
    sources,
    layers,
    // No glyphs or sprites: the base map draws no text and no icons.
  };
}

/**
 * Create the MapLibre map for a region. Interaction is pan and zoom only —
 * rotation and pitch are off, because the Canvas overlay projects with
 * `map.project` and a tilted map would make Mini Metro-style flat shapes lie.
 *
 * @param {HTMLElement} container
 * @param {import('../model/region.js').Region} region
 * @param {import('../model/region.js').LocalFrame} frame
 */
export function createMap(container, region, frame) {
  const [west, south, east, north] = region.meta.bbox;
  const map = new maplibregl.Map({
    container,
    style: buildStyle(region, frame),
    bounds: [[west, south], [east, north]],
    fitBoundsOptions: { padding: 20 },
    // Keep the player inside the imported square: there is no data outside it.
    maxBounds: [[west - 0.02, south - 0.02], [east + 0.02, north + 0.02]],
    minZoom: 10,
    maxZoom: 18,
    pitchWithRotate: false,
    dragRotate: false,
    touchZoomRotate: true,
    attributionControl: false,
  });
  map.touchZoomRotate.disableRotation();
  map.keyboard.disable(); // 1–4, Space and Esc belong to the game.
  return map;
}

/** Toggle a style layer's visibility. */
export function setLayerVisible(map, layerId, visible) {
  if (!map.getLayer(layerId)) return;
  map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
}

/**
 * Replace the heat map values without rebuilding its geometry. Phase 2 calls
 * this whenever catchments change.
 *
 * @param {maplibregl.Map} map
 * @param {import('../model/region.js').Region} region the region buildStyle was called with
 * @param {number[]} intensities one per demand cell, 0..1
 */
export function setHeatMapData(map, region, intensities) {
  const source = map.getSource('heat');
  const data = heatData.get(region);
  if (!source || !data) return;
  for (const feature of data.features) {
    feature.properties.intensity = intensities[feature.properties.cell] ?? 0;
  }
  source.setData(data);
}
