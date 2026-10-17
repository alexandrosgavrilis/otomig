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

  /**
   * The nearest point ON a road the mode may use, within `maxDistM` — not
   * the nearest node. A main road often has nodes only at its junctions,
   * hundreds of metres apart, while the side street beside it has one every
   * few metres, so snapping to nodes put a stop clicked squarely on the main
   * road onto the side street (Alex, Oct 17 2026).
   *
   * Within BUILD.STOP_NODE_SNAP_M of a node the node is used; otherwise the
   * result names the edge and how far along it, and `nodeAt` makes a node
   * there when a stop is actually placed. Snapping alone changes nothing.
   *
   * @returns {{node:number|null, edge:number, t:number, lon:number, lat:number,
   *            distanceM:number, name?:string}|null}
   */
  snapToRoad(lon, lat, mode, maxDistM = BUILD.STOP_SNAP_M) {
    const allowed = ALLOWED_CLASSES[mode];
    const [x, y] = this.frame.toLocal(lon, lat);
    const grid = this.edgeGrid();
    const radius = Math.ceil(maxDistM / grid.cellM);
    const col0 = Math.floor(x / grid.cellM);
    const row0 = Math.floor(y / grid.cellM);
    let best = null;
    let bestDist = maxDistM;
    const seen = new Set();
    for (let row = row0 - radius; row <= row0 + radius; row++) {
      for (let col = col0 - radius; col <= col0 + radius; col++) {
        for (const index of grid.cells.get(row * grid.cols + col) || []) {
          if (seen.has(index)) continue;
          seen.add(index);
          const edge = this.graph.edges[index];
          if (!allowed.has(edge.cls)) continue;
          const [ax, ay] = this.nodePosition(edge.a);
          const [bx, by] = this.nodePosition(edge.b);
          const dx = bx - ax;
          const dy = by - ay;
          const lengthSq = dx * dx + dy * dy;
          const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq)) : 0;
          const distance = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
          if (distance < bestDist) { bestDist = distance; best = { index, t, edge, ax, ay, dx, dy }; }
        }
      }
    }
    if (!best) return null;
    const { index, t, edge, ax, ay, dx, dy } = best;
    const lengthM = Math.hypot(dx, dy);
    let node = null;
    if (t * lengthM <= BUILD.STOP_NODE_SNAP_M) node = edge.a;
    else if ((1 - t) * lengthM <= BUILD.STOP_NODE_SNAP_M) node = edge.b;
    const [pLon, pLat] = node !== null ? this.nodeLonLat(node)
      : this.frame.toLonLat(ax + t * dx, ay + t * dy);
    return { node, edge: index, t, lon: pLon, lat: pLat, distanceM: bestDist,
      name: edge.name ?? (node !== null ? this.streetName(node) : undefined) };
  }

  /** The node for a snapped point, splitting its edge there if it has none. */
  nodeAt(snapped) {
    return snapped.node ?? this.splitEdge(snapped.edge, snapped.t);
  }

  /**
   * Put a node part-way along an edge, splitting it in two with the same
   * class, name, one-way rule and structure, and lengths in proportion. The
   * region's road graph is changed in place, so routing, snapping and saved
   * files all see it; a save made in the browser re-creates it on load from
   * the stop's position.
   * @returns {number} the new node
   */
  splitEdge(edgeIndex, t) {
    const edge = this.graph.edges[edgeIndex];
    const [ax, ay] = this.nodePosition(edge.a);
    const [bx, by] = this.nodePosition(edge.b);
    const [lon, lat] = this.frame.toLonLat(ax + t * (bx - ax), ay + t * (by - ay));
    const node = this.graph.nodes.length / 2;
    this.graph.nodes.push(lon, lat);
    this.graph.edges[edgeIndex] = { ...edge, b: node, lengthM: edge.lengthM * t };
    this.graph.edges.push({ ...edge, a: node, lengthM: edge.lengthM * (1 - t) });
    this.nodeCount = this.graph.nodes.length / 2;
    this.adjacency = buildAdjacency(this.graph, this.nodeCount);
    this.spatial = buildSpatialIndex(this.graph, this.frame, this.nodeCount);
    this._edgeGrid = null;
    return node;
  }

  /** Edges bucketed into a 50 m grid, built on first use. */
  edgeGrid() {
    if (this._edgeGrid) return this._edgeGrid;
    const cellM = 50;
    const cols = Math.max(1, Math.ceil(this.frame.widthM / cellM));
    const cells = new Map();
    this.graph.edges.forEach((edge, index) => {
      const [ax, ay] = this.nodePosition(edge.a);
      const [bx, by] = this.nodePosition(edge.b);
      for (let row = Math.floor(Math.min(ay, by) / cellM); row <= Math.floor(Math.max(ay, by) / cellM); row++) {
        for (let col = Math.floor(Math.min(ax, bx) / cellM); col <= Math.floor(Math.max(ax, bx) / cellM); col++) {
          const key = row * cols + col;
          if (!cells.has(key)) cells.set(key, []);
          cells.get(key).push(index);
        }
      }
    });
    this._edgeGrid = { cellM, cols, cells };
    return this._edgeGrid;
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
   * vector in local metres — or null if the main road there runs both ways.
   *
   * Judged by the MAIN road at the node only: its highest class, with ramps
   * (`*_link`) and smaller side streets ignored. Looking at every road there,
   * as before, a ramp or a two-way side street joining the carriageway made
   * the node look like no carriageway at all, so a stop at an interchange got
   * no twin and the way back looped round the cloverleaf (Alex, Oct 17 2026).
   */
  flowAt(node, mode) {
    const allowed = ALLOWED_CLASSES[mode];
    const { start, edges } = this.adjacency;
    let mainRank = Infinity;
    for (let i = start[node]; i < start[node + 1]; i++) {
      const edge = this.graph.edges[edges[i]];
      if (!allowed.has(edge.cls) || edge.cls.endsWith('_link')) continue;
      mainRank = Math.min(mainRank, classRank(edge.cls));
    }
    if (!Number.isFinite(mainRank)) return null;
    const [x, y] = this.nodePosition(node);
    let fx = 0;
    let fy = 0;
    for (let i = start[node]; i < start[node + 1]; i++) {
      const edge = this.graph.edges[edges[i]];
      if (!allowed.has(edge.cls) || edge.cls.endsWith('_link') || classRank(edge.cls) !== mainRank) continue;
      if (!edge.oneway || edge.onewayExempt?.includes(mode)) return null;
      const other = edge.a === node ? edge.b : edge.a;
      const [ox, oy] = this.nodePosition(other);
      const length = Math.hypot(ox - x, oy - y) || 1;
      // Leaving along it, or arriving along it: either way, the flow.
      const sign = mayTravel(edge, node, mode) ? 1 : -1;
      fx += sign * (ox - x) / length;
      fy += sign * (oy - y) / length;
    }
    const length = Math.hypot(fx, fy);
    return length > 0 ? [fx / length, fy / length] : null;
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

  /**
   * Dijkstra from one node over legal moves, as far as `maxCost`: the cost
   * and predecessor of every node reached. With `reverse`, it searches
   * backwards — the cost of getting FROM each node TO `source` — which is
   * what a turnaround needs from its far end.
   * @returns {{cost: Map<number,number>, prev: Map<number,number>}}
   */
  searchFrom(source, mode, { avoidFirst = null, reverse = false, maxCost = Infinity } = {}) {
    const allowed = ALLOWED_CLASSES[mode];
    const { start, edges } = this.adjacency;
    const cost = new Map([[source, 0]]);
    const prev = new Map();
    const settled = new Set();
    const heap = new MinHeap();
    heap.push(source, 0);
    while (heap.size > 0) {
      const node = heap.pop();
      if (settled.has(node)) continue;
      settled.add(node);
      const here = cost.get(node);
      if (here > maxCost) break;
      for (let i = start[node]; i < start[node + 1]; i++) {
        const edge = this.graph.edges[edges[i]];
        if (!allowed.has(edge.cls)) continue;
        const next = edge.a === node ? edge.b : edge.a;
        // Forwards a vehicle goes node → next; backwards it would have come next → node.
        if (!mayTravel(edge, reverse ? next : node, mode)) continue;
        if (node === source && next === avoidFirst) continue;
        if (settled.has(next)) continue;
        const candidate = here + edgeCost(edge);
        if (candidate < (cost.get(next) ?? Infinity)) {
          cost.set(next, candidate);
          prev.set(next, node);
          heap.push(next, candidate);
        }
      }
    }
    return { cost, prev };
  }

  /**
   * Turning a vehicle round at the end of a line: from `fromNode`, not back
   * the way it came (`avoidFirst`), to `toNode`. Either by going round —
   * the ordinary shortest path that never doubles back — or by driving on to
   * a junction ahead, U-turning there and coming back, whichever is shorter.
   * U-turns are allowed only at junctions (three or more roads), never in
   * the middle of a road (Alex, Oct 17 2026).
   * @returns {{nodes:number[], lengthM:number, cost:number}|null}
   */
  turnaround(fromNode, avoidFirst, toNode, mode, maxCost = 4000) {
    const round = this.shortestPath(fromNode, toNode, mode, { avoidFirst });
    const ahead = this.searchFrom(fromNode, mode, { avoidFirst, maxCost });
    const back = this.searchFrom(toNode, mode, { reverse: true, maxCost });
    let best = null;
    let bestCost = round ? round.cost : Infinity;
    for (const [junction, there] of ahead.cost) {
      if (junction === fromNode || this.degree(junction, mode) < 3) continue;
      const home = back.cost.get(junction);
      if (home === undefined || there + home >= bestCost) continue;
      bestCost = there + home;
      best = junction;
    }
    if (best === null) return round;
    const nodes = [];
    for (let node = best; node !== undefined; node = ahead.prev.get(node)) nodes.push(node);
    nodes.reverse();
    for (let node = back.prev.get(best); node !== undefined; node = back.prev.get(node)) nodes.push(node);
    let lengthM = 0;
    for (let i = 1; i < nodes.length; i++) lengthM += this.edgeBetween(nodes[i - 1], nodes[i])?.lengthM ?? 0;
    return { nodes, lengthM, cost: bestCost };
  }

  /** The edge joining two nodes, or null. */
  edgeBetween(a, b) {
    const { start, edges } = this.adjacency;
    for (let i = start[a]; i < start[a + 1]; i++) {
      const edge = this.graph.edges[edges[i]];
      if ((edge.a === a && edge.b === b) || (edge.a === b && edge.b === a)) return edge;
    }
    return null;
  }

  /** How many roads the mode may use meet at a node: 1 is a dead end. */
  degree(node, mode) {
    const allowed = ALLOWED_CLASSES[mode];
    const { start, edges } = this.adjacency;
    let count = 0;
    for (let i = start[node]; i < start[node + 1]; i++) {
      if (allowed.has(this.graph.edges[edges[i]].cls)) count++;
    }
    return count;
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
   * The best path between two nodes along roads the mode may use: shortest
   * by a cost that prefers main roads (`BUILD.ROAD_CLASS_COST`), so a bus
   * keeps to the avenue rather than threading through back streets to save
   * fifty metres. `lengthM` is the true length.
   *
   * Plain Dijkstra with a binary heap. A* with a straight-line heuristic would
   * be faster, but paths here are short (stop to stop) and Dijkstra is one
   * fewer thing to get subtly wrong.
   *
   * @param {number} fromNode
   * @param {number} toNode
   * @param {'bus'|'tram'} mode
   * @param {{ignoreOneway?:boolean, avoidFirst?:number}} [options]
   *   `ignoreOneway`: the fallback when no legal path exists, which happens
   *   where a one-way street runs out of the region. `avoidFirst`: a node the
   *   path may not step to first — the one the vehicle has just come from,
   *   so it never turns round in the middle of a road.
   * @returns {{nodes:number[], lengthM:number}|null} null when unreachable
   */
  shortestPath(fromNode, toNode, mode, { ignoreOneway = false, avoidFirst = null } = {}) {
    if (fromNode === toNode) return { nodes: [fromNode], lengthM: 0 };
    const allowed = ALLOWED_CLASSES[mode];
    const { start, edges } = this.adjacency;

    const distance = new Float64Array(this.nodeCount).fill(Infinity);
    const previous = new Int32Array(this.nodeCount).fill(-1);
    // The edge each node was reached by, so the path's true length can be
    // summed: the search minimises a weighted cost, not metres.
    const previousEdge = new Int32Array(this.nodeCount).fill(-1);
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
        if (node === fromNode && next === avoidFirst) continue;
        const candidate = distance[node] + edgeCost(edge);
        if (candidate < distance[next]) {
          distance[next] = candidate;
          previous[next] = node;
          previousEdge[next] = edges[i];
          heap.push(next, candidate);
        }
      }
    }

    if (!Number.isFinite(distance[toNode])) return null;

    const nodes = [];
    let lengthM = 0;
    for (let node = toNode; node !== -1; node = previous[node]) {
      nodes.push(node);
      if (previousEdge[node] !== -1) lengthM += this.graph.edges[previousEdge[node]].lengthM;
    }
    nodes.reverse();
    return { nodes, lengthM, cost: distance[toNode] };
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
  pathThrough(nodes, mode, options = {}) {
    if (nodes.length < 2) return null;
    const all = [nodes[0]];
    let lengthM = 0;
    let avoidFirst = options.avoidFirst ?? null;
    for (let i = 0; i < nodes.length - 1; i++) {
      const leg = this.shortestPath(nodes[i], nodes[i + 1], mode, { ...options, avoidFirst });
      if (!leg) return null;
      all.push(...leg.nodes.slice(1)); // Skip the duplicated junction node.
      lengthM += leg.lengthM;
      // No turning round at a via either.
      avoidFirst = leg.nodes.length > 1 ? leg.nodes.at(-2) : avoidFirst;
    }
    return { nodes: all, lengthM };
  }

  /** A node path as a lon/lat polyline, ready to draw. @returns {number[][]} */
  polyline(nodes) {
    return nodes.map((node) => this.nodeLonLat(node));
  }
}

/** Road classes from most to least important, for telling a main road from its side streets. */
const CLASS_ORDER = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'unclassified',
  'residential', 'living_street', 'pedestrian'];
const classRank = (cls) => {
  const rank = CLASS_ORDER.indexOf(cls.replace(/_link$/, ''));
  return rank === -1 ? CLASS_ORDER.length : rank;
};

/**
 * What an edge costs to route along: its length, weighted by its class, so
 * routes keep to main roads unless a back street saves real distance.
 */
export function edgeCost(edge) {
  return edge.lengthM * (BUILD.ROAD_CLASS_COST[edge.cls] ?? 1);
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
