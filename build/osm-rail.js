/**
 * Existing OSM railways as ready-made train track (Phase 6).
 *
 * The import keeps live rail as a graph — OSM nodes and the edges between
 * them, tagged tunnel or bridge — exactly like the road graph. Player-built
 * track is something else: a `Track` sampled every 20 m, with a structure and
 * a height per sample, joined to other track by junction links. Everything
 * that works on track — station snapping, line routing, junctions for new
 * track, the profile strip — reads that form. So OSM rail is converted into
 * it once, and from then on it is simply more train track that costs nothing.
 *
 * The graph is cut into chains at every node that is not a plain
 * continuation (a switch, a crossing or a dead end), so one chain is one
 * `Track`, and each switch becomes a junction between chains.
 *
 * Structures come from the OSM tags, not the grade rule, as the spec asks: a
 * sample on a tunnel or bridge edge is a tunnel or bridge. Heights follow the
 * terrain at grade; across a tunnel or bridge they run straight from one end
 * to the other, the way a bridge deck or a bore does. Neither is ever seen
 * except in the profile strip and as the height new track meets at a junction.
 *
 * Ids are `osm0`, `osm1`, … in a fixed order derived from the region alone,
 * so a station's stored sample key (`osm3:41`) still means the same place
 * after a reload.
 */

import { BUILD } from '../config.js';
import { heightAt } from '../model/region.js';
import { Track } from '../model/network.js';

export const OSM_TRACK_PREFIX = 'osm';

/**
 * @param {import('../model/region.js').Region} region
 * @param {import('../model/region.js').LocalFrame} frame
 * @returns {Track[]}
 */
export function osmRailTracks(region, frame) {
  const rail = region.rail;
  if (!rail?.edges?.length) return [];

  const chains = railChains(rail);
  const tracks = chains.map((chain, i) => chainTrack(chain, rail, region, frame, `${OSM_TRACK_PREFIX}${i}`));

  // Switches: every chain ending at a node joins the first chain that ended
  // there. Linking each to one hub keeps every pair connected through it.
  /** @type {Map<number, {trackId:string, index:number}>} */
  const hubs = new Map();
  chains.forEach((chain, i) => {
    const track = tracks[i];
    const ends = [
      { node: chain.nodes[0], index: 0, side: 'start' },
      { node: chain.nodes.at(-1), index: track.points.length - 1, side: 'end' },
    ];
    for (const end of ends) {
      const hub = hubs.get(end.node);
      if (!hub) { hubs.set(end.node, { trackId: track.id, index: end.index }); continue; }
      // A loop closing on itself joins its own start.
      if (hub.trackId === track.id && hub.index === end.index) continue;
      track[end.side] = hub;
    }
  });
  return tracks;
}

/**
 * Cut the rail graph into chains of edges between nodes that are not plain
 * continuations. A ring with no such node (a loop line on its own) is cut at
 * its lowest-numbered node so the result never depends on iteration order.
 *
 * @returns {Array<{nodes:number[], edges:number[]}>}
 */
export function railChains(rail) {
  /** node → [{edge, other}] */
  const adjacency = new Map();
  const add = (node, edge, other) => {
    if (!adjacency.has(node)) adjacency.set(node, []);
    adjacency.get(node).push({ edge, other });
  };
  rail.edges.forEach((edge, i) => { add(edge.a, i, edge.b); add(edge.b, i, edge.a); });

  const isBreak = (node) => adjacency.get(node).length !== 2;
  const used = new Uint8Array(rail.edges.length);
  const chains = [];

  const walk = (start, first) => {
    const nodes = [start];
    const edges = [];
    let node = start;
    let step = first;
    for (;;) {
      used[step.edge] = 1;
      edges.push(step.edge);
      node = step.other;
      nodes.push(node);
      if (node === start || isBreak(node)) break;
      step = adjacency.get(node).find((next) => !used[next.edge]);
      if (!step) break;
    }
    chains.push({ nodes, edges });
  };

  const order = [...adjacency.keys()].sort((a, b) => a - b);
  for (const node of order) {
    if (!isBreak(node)) continue;
    for (const step of adjacency.get(node)) if (!used[step.edge]) walk(node, step);
  }
  // Whatever is left is made of rings with no break in them.
  for (const node of order) {
    for (const step of adjacency.get(node)) if (!used[step.edge]) walk(node, step);
  }
  return chains;
}

/** One chain → one train Track, sampled every BUILD.SAMPLE_M. */
function chainTrack(chain, rail, region, frame, id) {
  const lonLat = (node) => [rail.nodes[2 * node], rail.nodes[2 * node + 1]];
  const kindOf = (edge) => edge.tunnel ? 'tunnel' : edge.bridge ? 'bridge' : 'atGrade';

  const points = [];
  const kinds = [];
  // Walk each edge in equal steps no longer than a sample, so every vertex
  // of the OSM way is kept and the track never cuts a corner.
  chain.edges.forEach((edgeIndex, i) => {
    const edge = rail.edges[edgeIndex];
    const [lonA, latA] = lonLat(chain.nodes[i]);
    const [lonB, latB] = lonLat(chain.nodes[i + 1]);
    const steps = Math.max(1, Math.ceil(edge.lengthM / BUILD.SAMPLE_M));
    if (i === 0) { points.push([lonA, latA]); kinds.push(kindOf(edge)); }
    // The sample this edge starts on is shared with the edge before it; it
    // is a structure if either edge is one.
    else if (kindOf(edge) !== 'atGrade') kinds[kinds.length - 1] = kindOf(edge);
    for (let s = 1; s <= steps; s++) {
      const t = s / steps;
      points.push([lonA + (lonB - lonA) * t, latA + (latB - latA) * t]);
      kinds.push(kindOf(edge));
    }
  });

  const terrain = points.map(([lon, lat]) => {
    const [x, y] = frame.toLocal(lon, lat);
    return heightAt(region.terrain, x, y);
  });
  const height = structureHeights(kinds, terrain);

  let lengthM = 0;
  for (let i = 1; i < points.length; i++) {
    lengthM += frame.distance(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  }

  const track = new Track('train', [points[0], points.at(-1)]);
  track.id = id;
  track.osm = true;
  track.name = rail.edges[chain.edges[0]].name || null;
  track.apply({
    points, kinds, height, terrain,
    overWater: points.map(() => false),
    blockedAt: [],
    levelCrossings: [],
    lengthM,
  });
  track.pins = { start: height[0], end: height.at(-1) };
  return track;
}

/**
 * Heights for a tagged profile: the terrain at grade, and a straight run from
 * the last at-grade sample before a tunnel or bridge to the first one after.
 * A structure that reaches the end of the chain keeps the terrain's height at
 * that end, since there is nothing beyond it to aim for.
 */
export function structureHeights(kinds, terrain) {
  const height = terrain.slice();
  let i = 0;
  while (i < kinds.length) {
    if (kinds[i] === 'atGrade') { i++; continue; }
    let end = i;
    while (end + 1 < kinds.length && kinds[end + 1] !== 'atGrade') end++;
    const before = i > 0 ? i - 1 : i;
    const after = end + 1 < kinds.length ? end + 1 : end;
    const from = terrain[before];
    const to = terrain[after];
    for (let j = i; j <= end; j++) {
      const t = after === before ? 0 : (j - before) / (after - before);
      height[j] = from + (to - from) * t;
    }
    i = end + 1;
  }
  return height;
}
