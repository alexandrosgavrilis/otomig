/**
 * Routing on built track: snapping stations to it, and the shortest path
 * between two stations on track a line's vehicles are allowed to use.
 *
 * The road graph's counterpart for rail. Its nodes are the 20 m samples of
 * every piece of track the player has built; its edges join consecutive
 * samples along a track, plus a junction wherever one track was drawn from or
 * to another, or crosses another at the same height.
 *
 * Compatibility lives on the nodes: a train line may only visit samples of
 * train track, while a metro line may visit any. That one rule is the whole of
 * "metro runs on train track, train is refused on metro track", and it falls
 * out of Dijkstra without any special cases at junctions.
 */

import { BUILD } from '../config.js';
import { MinHeap } from './road-routing.js';

const CELL_M = 50;

/**
 * Where two straight stretches p1–p2 and q1–q2 cross, as how far along each
 * (0..1), or null. Touching counts, so a track ending on another joins it.
 */
function intersect([x1, y1], [x2, y2], [x3, y3], [x4, y4]) {
  const d = (x2 - x1) * (y4 - y3) - (y2 - y1) * (x4 - x3);
  if (Math.abs(d) < 1e-9) return null;
  const s = ((x3 - x1) * (y4 - y3) - (y3 - y1) * (x4 - x3)) / d;
  const t = ((x3 - x1) * (y2 - y1) - (y3 - y1) * (x2 - x1)) / d;
  const e = 1e-6;
  return s >= -e && s <= 1 + e && t >= -e && t <= 1 + e ? { s, t } : null;
}

/** Stable id for a track sample. Stations store this, so it must survive a rebuild. */
export const trackNodeKey = (trackId, index) => `${trackId}:${index}`;

/** May a line of `lineMode` run on track of `trackMode`? */
export function canRunOn(lineMode, trackMode) {
  return (BUILD.TRACK_COMPATIBILITY[lineMode] || []).includes(trackMode);
}

export class TrackGraph {
  /**
   * @param {Iterable<import('../model/network.js').Track>} tracks
   * @param {import('../model/region.js').LocalFrame} frame
   */
  constructor(tracks, frame) {
    this.frame = frame;
    /** @type {Map<string, number>} sample key → node index */
    this.index = new Map();
    /** Per node: owning track, sample index, track mode, structure, lon/lat. */
    this.nodes = [];
    /** @type {Array<Array<{to:number, lengthM:number}>>} */
    this.adjacency = [];

    const list = [...tracks];
    for (const track of list) {
      track.points.forEach((lonLat, i) => {
        this.index.set(trackNodeKey(track.id, i), this.nodes.length);
        this.nodes.push({ track, sample: i, mode: track.mode, kind: track.kinds[i], lonLat,
          xy: frame.toLocal(lonLat[0], lonLat[1]), height: track.height[i] });
        this.adjacency.push([]);
      });
    }
    /** Every stretch between two samples, bucketed by 50 m cell: cell → first node indices. */
    this.cells = new Map();
    this.nodes.forEach((node, n) => {
      if (n + 1 < this.nodes.length && this.nodes[n + 1].track === node.track) {
        for (const cell of this.cellsAlong(node.xy, this.nodes[n + 1].xy)) {
          if (!this.cells.has(cell)) this.cells.set(cell, []);
          this.cells.get(cell).push(n);
        }
      }
    });

    for (const track of list) {
      for (let i = 1; i < track.points.length; i++) {
        this.link(trackNodeKey(track.id, i - 1), trackNodeKey(track.id, i));
      }
      // Junctions. A junction whose track has since been bulldozed is simply
      // gone: the key no longer resolves and the end is a dead end.
      if (track.start) {
        this.link(trackNodeKey(track.id, 0), trackNodeKey(track.start.trackId, track.start.index));
      }
      if (track.end) {
        this.link(trackNodeKey(track.id, track.points.length - 1),
          trackNodeKey(track.end.trackId, track.end.index));
      }
    }

    // Wherever a player's track crosses another at the same height, the two
    // are joined, with no need to click the exact spot (Alex, Oct 18 2026).
    // Existing railways already meet at their shared nodes, and a tunnel or
    // a bridge passes over or under without joining.
    for (const track of list) {
      if (track.osm) continue;
      for (const meeting of this.crossings(track.points, track.height, track.id)) {
        this.link(trackNodeKey(track.id, meeting.index), trackNodeKey(meeting.trackId, meeting.otherIndex));
      }
    }
  }

  /** The 50 m cells a straight stretch between two local points passes through. */
  cellsAlong([ax, ay], [bx, by]) {
    const cells = [];
    for (let row = Math.floor(Math.min(ay, by) / CELL_M); row <= Math.floor(Math.max(ay, by) / CELL_M); row++) {
      for (let col = Math.floor(Math.min(ax, bx) / CELL_M); col <= Math.floor(Math.max(ax, bx) / CELL_M); col++) {
        cells.push(`${col},${row}`);
      }
    }
    return cells;
  }

  /**
   * Where a run of track samples crosses built track at the same height
   * (within BUILD.JOIN_HEIGHT_M): for each crossing, the sample of each
   * nearest to it. Used to join tracks, and to show a track being drawn
   * where it will join.
   * @param {number[][]} points lon/lat samples
   * @param {number[]} height per sample, m
   * @param {string} [ownId] a track not to look for crossings with: itself
   * @returns {Array<{index:number, trackId:string, otherIndex:number, lonLat:number[]}>}
   */
  crossings(points, height, ownId = null) {
    const xy = points.map(([lon, lat]) => this.frame.toLocal(lon, lat));
    const found = [];
    const seen = new Set();
    for (let i = 1; i < xy.length; i++) {
      for (const cell of this.cellsAlong(xy[i - 1], xy[i])) {
        for (const n of this.cells.get(cell) || []) {
          const node = this.nodes[n];
          if (node.track.id === ownId || seen.has(n)) continue;
          const next = this.nodes[n + 1];
          const hit = intersect(xy[i - 1], xy[i], node.xy, next.xy);
          if (!hit) continue;
          seen.add(n);
          const here = height[i - 1] + (height[i] - height[i - 1]) * hit.s;
          const there = node.height + (next.height - node.height) * hit.t;
          if (!(Math.abs(here - there) <= BUILD.JOIN_HEIGHT_M)) continue;
          const other = hit.t < 0.5 ? node : next;
          found.push({ index: hit.s < 0.5 ? i - 1 : i, trackId: other.track.id, otherIndex: other.sample,
            lonLat: other.lonLat });
        }
      }
    }
    return found;
  }

  link(keyA, keyB) {
    const a = this.index.get(keyA);
    const b = this.index.get(keyB);
    if (a === undefined || b === undefined || a === b) return;
    const [lonA, latA] = this.nodes[a].lonLat;
    const [lonB, latB] = this.nodes[b].lonLat;
    const lengthM = this.frame.distance(lonA, latA, lonB, latB);
    this.adjacency[a].push({ to: b, lengthM });
    this.adjacency[b].push({ to: a, lengthM });
  }

  /**
   * Nearest track sample within `maxDistM`, on track a mode may use.
   *
   * Used for both stations (`mode` is the line's) and junctions (`mode` is
   * the track being built: new metro track may join train track, because
   * metro vehicles can continue onto it; new train track may join only train
   * track).
   *
   * Track samples are 20 m apart, so snapping to a sample rather than
   * projecting onto the curve puts a station at most 10 m from where the
   * player clicked — invisible at any zoom where clicking is possible.
   *
   * @returns {{key:string, node:number, trackId:string, index:number,
   *            lon:number, lat:number, distanceM:number, kind:string, mode:string}|null}
   */
  snap(lon, lat, mode, maxDistM, { anyMode = false } = {}) {
    let best = null;
    let bestDist = maxDistM;
    this.nodes.forEach((node, n) => {
      if (!anyMode && !canRunOn(mode, node.mode)) return;
      const distance = this.frame.distance(lon, lat, node.lonLat[0], node.lonLat[1]);
      if (distance < bestDist) { bestDist = distance; best = n; }
    });
    if (best === null) return null;
    const node = this.nodes[best];
    return {
      key: trackNodeKey(node.track.id, node.sample),
      node: best,
      trackId: node.track.id,
      index: node.sample,
      lon: node.lonLat[0],
      lat: node.lonLat[1],
      distanceM: bestDist,
      kind: node.kind,
      mode: node.mode,
    };
  }

  /**
   * Shortest path between two samples, using only track the line may run on.
   *
   * @param {string} fromKey
   * @param {string} toKey
   * @param {'metro'|'train'} lineMode
   * @returns {{points:number[][], kinds:string[], lengthM:number, tracks:string[]}|null}
   */
  path(fromKey, toKey, lineMode) {
    const from = this.index.get(fromKey);
    const to = this.index.get(toKey);
    if (from === undefined || to === undefined) return null;
    const usable = (n) => canRunOn(lineMode, this.nodes[n].mode);
    if (!usable(from) || !usable(to)) return null;

    const count = this.nodes.length;
    const distance = new Float64Array(count).fill(Infinity);
    const previous = new Int32Array(count).fill(-1);
    const settled = new Uint8Array(count);
    distance[from] = 0;
    const heap = new MinHeap();
    heap.push(from, 0);

    while (heap.size > 0) {
      const node = heap.pop();
      if (settled[node]) continue;
      settled[node] = 1;
      if (node === to) break;
      for (const edge of this.adjacency[node]) {
        if (settled[edge.to] || !usable(edge.to)) continue;
        const candidate = distance[node] + edge.lengthM;
        if (candidate < distance[edge.to]) {
          distance[edge.to] = candidate;
          previous[edge.to] = node;
          heap.push(edge.to, candidate);
        }
      }
    }
    if (!Number.isFinite(distance[to])) return null;

    const nodes = [];
    for (let n = to; n !== -1; n = previous[n]) nodes.push(n);
    nodes.reverse();
    return {
      points: nodes.map((n) => this.nodes[n].lonLat),
      kinds: nodes.map((n) => this.nodes[n].kind),
      lengthM: distance[to],
      // Which tracks the path runs over, so a track carrying a line cannot be
      // bulldozed out from under it.
      tracks: [...new Set(nodes.map((n) => this.nodes[n].track.id))],
    };
  }
}
