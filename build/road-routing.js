/**
 * Routing on the road graph: snapping clicks to roads, and the shortest path
 * between two road nodes for a given mode.
 *
 * "The player draws, the game engineers." The player clicks two stops; this
 * works out how the bus actually gets between them.
 *
 * One-way streets are obeyed (Alex, Oct 16 2026; the spec's v1 ignored them).
 * An edge may carry `oneway` (1: only from a to b, -1: only from b to a) and
 * `onewayExempt`, the modes allowed against the flow on a contraflow lane.
 * Regions imported before carry no `oneway`, so every edge stays two-way.
 */

import { BUILD } from '../config.js';

/**
 * Precomputed structures for one region's road graph. Built once per region
 * and reused for every click and every path, because rebuilding adjacency for
 * 6,000 edges on each click would be felt.
 */
export class RoadIndex {
  /**
   * @param {import('../model/region.js').RoadGraph} graph
   * @param {import('../model/region.js').LocalFrame} frame
   */
  constructor(graph, frame) {
    this.graph = graph;
    this.frame = frame;
    this.nodeCount = graph.nodes.length / 2;

    /**
     * Adjacency as a flat CSR-style pair of arrays rather than an array of
     * arrays: one allocation instead of tens of thousands, which matters
     * because Dijkstra walks this on every stop placement.
     * @type {{start: Int32Array, edges: Int32Array}}
     */
    this.adjacency = buildAdjacency(graph, this.nodeCount);

    /** Uniform grid over node positions, for nearest-node queries. */
    this.spatial = buildSpatialIndex(graph, frame, this.nodeCount);
  }

  /** Local-metre position of a graph node. @returns {[number,number]} */
  nodePosition(index) {
    return this.frame.toLocal(this.graph.nodes[2 * index], this.graph.nodes[2 * index + 1]);
  }

  /** Lon/lat of a graph node. @returns {[number,number]} */
  nodeLonLat(index) {
    return [this.graph.nodes[2 * index], this.graph.nodes[2 * index + 1]];
  }

  /**
   * Nearest node reachable by `mode` within `maxDistM` of a lon/lat.
   *
   * Only nodes touching a road the mode may use count — clicking beside a
   * footpath must not place a bus stop on it.
   *
   * @param {number} lon
   * @param {number} lat
   * @param {'bus'|'tram'} mode
   * @param {number} [maxDistM]
   * @returns {{node:number, lon:number, lat:number, distanceM:number, name?:string}|null}
   */
  snap(lon, lat, mode, maxDistM = BUILD.STOP_SNAP_M) {
    const allowed = ALLOWED_CLASSES[mode];
    const [x, y] = this.frame.toLocal(lon, lat);
    const { cellM, cols, rows, cellStart, cellNodes } = this.spatial;

    const radius = Math.ceil(maxDistM / cellM);
    const col0 = Math.floor(x / cellM);
    const row0 = Math.floor(y / cellM);

    let best = null;
    let bestDist = maxDistM;

    for (let row = row0 - radius; row <= row0 + radius; row++) {
      if (row < 0 || row >= rows) continue;
      for (let col = col0 - radius; col <= col0 + radius; col++) {
        if (col < 0 || col >= cols) continue;
        const cell = row * cols + col;
        for (let i = cellStart[cell]; i < cellStart[cell + 1]; i++) {
          const node = cellNodes[i];
          if (!this.nodeServes(node, allowed)) continue;
          const [nx, ny] = this.nodePosition(node);
          const distance = Math.hypot(nx - x, ny - y);
          if (distance < bestDist) { bestDist = distance; best = node; }
        }
      }
    }

    if (best === null) return null;
    const [bLon, bLat] = this.nodeLonLat(best);
    return { node: best, lon: bLon, lat: bLat, distanceM: bestDist, name: this.streetName(best) };
  }

  /**
   * Which way traffic flows at a node on a one-way carriageway, as a unit
   * vector in local metres — or null if any road at the node the mode may use
   * runs both ways (it is not a carriageway, or it is a junction with one).
   */
  flowAt(node, mode) {
    const allowed = ALLOWED_CLASSES[mode];
    const { start, edges } = this.adjacency;
    const [x, y] = this.nodePosition(node);
    let fx = 0;
    let fy = 0;
    let count = 0;
    for (let i = start[node]; i < start[node + 1]; i++) {
      const edge = this.graph.edges[edges[i]];
      if (!allowed.has(edge.cls)) continue;
      if (!edge.oneway || edge.onewayExempt?.includes(mode)) return null;
      const other = edge.a === node ? edge.b : edge.a;
      const [ox, oy] = this.nodePosition(other);
      const length = Math.hypot(ox - x, oy - y) || 1;
      // Leaving along it, or arriving along it: either way, the flow.
      const sign = mayTravel(edge, node, mode) ? 1 : -1;
      fx += sign * (ox - x) / length;
      fy += sign * (oy - y) / length;
      count++;
    }
    const length = Math.hypot(fx, fy);
    return count && length > 0 ? [fx / length, fy / length] : null;
  }

  /**
   * The other half of a divided road: the nearest node within `maxM` on a
   * one-way carriageway running the opposite way to this one. A stop on one
   * side of a dual carriageway has a twin across the median, as real stops do.
   * @returns {{node:number, flow:[number,number]}|null} `flow` is THIS node's
   */
  twinOf(node, mode, maxM) {
    const flow = this.flowAt(node, mode);
    if (!flow) return null;
    const allowed = ALLOWED_CLASSES[mode];
    const [x, y] = this.nodePosition(node);
    const { cellM, cols, rows, cellStart, cellNodes } = this.spatial;
    const radius = Math.ceil(maxM / cellM);
    const col0 = Math.floor(x / cellM);
    const row0 = Math.floor(y / cellM);
    let best = null;
    let bestDist = maxM;
    for (let row = row0 - radius; row <= row0 + radius; row++) {
      if (row < 0 || row >= rows) continue;
      for (let col = col0 - radius; col <= col0 + radius; col++) {
        if (col < 0 || col >= cols) continue;
        const cell = row * cols + col;
        for (let i = cellStart[cell]; i < cellStart[cell + 1]; i++) {
          const other = cellNodes[i];
          if (other === node || !this.nodeServes(other, allowed)) continue;
          const [ox, oy] = this.nodePosition(other);
          const distance = Math.hypot(ox - x, oy - y);
          if (distance >= bestDist) continue;
          // Across the road, not along it: a node further down the same
          // carriageway, or round a corner, is not the other half.
          const along = Math.abs((ox - x) * flow[0] + (oy - y) * flow[1]);
          if (along > 0.5 * distance) continue;
          // And running the other way, near enough exactly — not a one-way
          // side street that happens to be close.
          const otherFlow = this.flowAt(other, mode);
          if (!otherFlow || otherFlow[0] * flow[0] + otherFlow[1] * flow[1] > -0.8) continue;
          bestDist = distance;
          best = other;
        }
      }
    }
    return best === null ? null : { node: best, flow };
  }

  /** Does any edge at this node belong to a class the mode may use? */
  nodeServes(node, allowed) {
    const { start, edges } = this.adjacency;
    for (let i = start[node]; i < start[node + 1]; i++) {
      if (allowed.has(this.graph.edges[edges[i]].cls)) return true;
    }
    return false;
  }

  /** Name of a street at this node, for auto-naming stops. */
  streetName(node) {
    const { start, edges } = this.adjacency;
    for (let i = start[node]; i < start[node + 1]; i++) {
      const name = this.graph.edges[edges[i]].name;
      if (name) return name;
    }
    return undefined;
  }

  /**
   * Shortest path between two nodes along roads the mode may use.
   *
   * Plain Dijkstra with a binary heap. A* with a straight-line heuristic would
   * be faster, but paths here are short (stop to stop) and Dijkstra is one
   * fewer thing to get subtly wrong.
   *
   * @param {number} fromNode
   * @param {number} toNode
   * @param {'bus'|'tram'} mode
   * @param {{ignoreOneway?:boolean}} [options] the fallback when no legal path
   *   exists, which happens where a one-way street runs out of the region
   * @returns {{nodes:number[], lengthM:number}|null} null when unreachable
   */
  shortestPath(fromNode, toNode, mode, { ignoreOneway = false } = {}) {
    if (fromNode === toNode) return { nodes: [fromNode], lengthM: 0 };
    const allowed = ALLOWED_CLASSES[mode];
    const { start, edges } = this.adjacency;

    const distance = new Float64Array(this.nodeCount).fill(Infinity);
    const previous = new Int32Array(this.nodeCount).fill(-1);
    const settled = new Uint8Array(this.nodeCount);
    distance[fromNode] = 0;

    const heap = new MinHeap();
    heap.push(fromNode, 0);

    while (heap.size > 0) {
      const node = heap.pop();
      if (settled[node]) continue;
      settled[node] = 1;
      if (node === toNode) break;

      for (let i = start[node]; i < start[node + 1]; i++) {
        const edge = this.graph.edges[edges[i]];
        if (!allowed.has(edge.cls)) continue;
        if (!ignoreOneway && !mayTravel(edge, node, mode)) continue;
        const next = edge.a === node ? edge.b : edge.a;
        if (settled[next]) continue;
        const candidate = distance[node] + edge.lengthM;
        if (candidate < distance[next]) {
          distance[next] = candidate;
          previous[next] = node;
          heap.push(next, candidate);
        }
      }
    }

    if (!Number.isFinite(distance[toNode])) return null;

    const nodes = [];
    for (let node = toNode; node !== -1; node = previous[node]) nodes.push(node);
    nodes.reverse();
    return { nodes, lengthM: distance[toNode] };
  }

  /**
   * A path through several waypoints, each leg routed separately.
   * Via-points come from the player dragging a line, which forces a different
   * road route without placing a stop.
   *
   * @param {number[]} nodes stop and via nodes in order
   * @param {'bus'|'tram'} mode
   * @returns {{nodes:number[], lengthM:number}|null}
   */
  pathThrough(nodes, mode, options) {
    if (nodes.length < 2) return null;
    const all = [nodes[0]];
    let lengthM = 0;
    for (let i = 0; i < nodes.length - 1; i++) {
      const leg = this.shortestPath(nodes[i], nodes[i + 1], mode, options);
      if (!leg) return null;
      all.push(...leg.nodes.slice(1)); // Skip the duplicated junction node.
      lengthM += leg.lengthM;
    }
    return { nodes: all, lengthM };
  }

  /** A node path as a lon/lat polyline, ready to draw. @returns {number[][]} */
  polyline(nodes) {
    return nodes.map((node) => this.nodeLonLat(node));
  }
}

/** May a vehicle of this mode leave `fromNode` along this edge? */
export function mayTravel(edge, fromNode, mode) {
  if (!edge.oneway || edge.onewayExempt?.includes(mode)) return true;
  return edge.oneway === 1 ? fromNode === edge.a : fromNode === edge.b;
}

/** Road classes each mode may use. Tram is the stricter list. */
const ALLOWED_CLASSES = {
  bus: new Set(BUILD.BUS_ROADS),
  tram: new Set(BUILD.TRAM_ROADS),
};

/** Build CSR adjacency: node → the indices of edges touching it. */
function buildAdjacency(graph, nodeCount) {
  const counts = new Int32Array(nodeCount + 1);
  for (const edge of graph.edges) { counts[edge.a]++; counts[edge.b]++; }

  const start = new Int32Array(nodeCount + 1);
  for (let i = 0; i < nodeCount; i++) start[i + 1] = start[i] + counts[i];

  const cursor = start.slice(0, nodeCount);
  const edges = new Int32Array(start[nodeCount]);
  graph.edges.forEach((edge, index) => {
    edges[cursor[edge.a]++] = index;
    edges[cursor[edge.b]++] = index;
  });
  return { start, edges };
}

/** Uniform grid bucketing node indices, for nearest-node search. */
function buildSpatialIndex(graph, frame, nodeCount) {
  const cellM = 100;
  const cols = Math.max(1, Math.ceil(frame.widthM / cellM));
  const rows = Math.max(1, Math.ceil(frame.heightM / cellM));

  const cellOf = new Int32Array(nodeCount);
  const counts = new Int32Array(cols * rows + 1);
  for (let node = 0; node < nodeCount; node++) {
    const [x, y] = frame.toLocal(graph.nodes[2 * node], graph.nodes[2 * node + 1]);
    const col = Math.min(cols - 1, Math.max(0, Math.floor(x / cellM)));
    const row = Math.min(rows - 1, Math.max(0, Math.floor(y / cellM)));
    const cell = row * cols + col;
    cellOf[node] = cell;
    counts[cell]++;
  }

  const cellStart = new Int32Array(cols * rows + 1);
  for (let i = 0; i < cols * rows; i++) cellStart[i + 1] = cellStart[i] + counts[i];

  const cursor = cellStart.slice(0, cols * rows);
  const cellNodes = new Int32Array(nodeCount);
  for (let node = 0; node < nodeCount; node++) cellNodes[cursor[cellOf[node]]++] = node;

  return { cellM, cols, rows, cellStart, cellNodes };
}

/**
 * Binary min-heap keyed by priority. Lazy deletion: a node may be pushed more
 * than once and stale entries are skipped via the `settled` array, which is
 * cheaper than supporting decrease-key.
 */
export class MinHeap {
  constructor() {
    this.items = [];
    this.priorities = [];
  }

  get size() { return this.items.length; }

  push(item, priority) {
    this.items.push(item);
    this.priorities.push(priority);
    let i = this.items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.priorities[parent] <= this.priorities[i]) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  pop() {
    const top = this.items[0];
    const lastItem = this.items.pop();
    const lastPriority = this.priorities.pop();
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.priorities[0] = lastPriority;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < this.items.length && this.priorities[left] < this.priorities[smallest]) smallest = left;
        if (right < this.items.length && this.priorities[right] < this.priorities[smallest]) smallest = right;
        if (smallest === i) break;
        this.swap(i, smallest);
        i = smallest;
      }
    }
    return top;
  }

  swap(a, b) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.priorities[a], this.priorities[b]] = [this.priorities[b], this.priorities[a]];
  }
}
