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
import { heightAt } from '../model/region.js';

/**
 * Precomputed structures for one region's road graph. Built once per region
 * and reused for every click and every path, because rebuilding adjacency for
 * 6,000 edges on each click would be felt.
 */
export class RoadIndex {
  /**
   * @param {import('../model/region.js').RoadGraph} graph
   * @param {import('../model/region.js').LocalFrame} frame
   * @param {Object} [terrain] the region's height grid, for how steep each
   *   street is; without it every street counts as flat
   */
  constructor(graph, frame, terrain = null) {
    this.graph = graph;
    this.frame = frame;
    this.terrain = terrain;
    /** Each edge's grade, by index, worked out when first asked. */
    this.grades = new Map();
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
   * Within BUILD.STOP_NODE_SNAP_M of a node the node is used — unless it is
   * a junction, where a stop would stand on no one road and so on no side
   * of one: it goes that far short of the junction instead. Otherwise the
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
    const { index, edge, ax, ay, dx, dy } = best;
    let { t } = best;
    const lengthM = Math.hypot(dx, dy);
    const near = Math.min(BUILD.STOP_NODE_SNAP_M, lengthM / 2);
    let node = null;
    if (lengthM === 0 || t * lengthM <= near) {
      if (lengthM === 0 || this.degree(edge.a, mode) <= 2) node = edge.a; else t = near / lengthM;
    } else if ((1 - t) * lengthM <= near) {
      if (this.degree(edge.b, mode) <= 2) node = edge.b; else t = 1 - near / lengthM;
    }
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
    this.grades.clear();
    return node;
  }

  /** How steep a road edge is, rise over run, from the terrain at its two ends. */
  gradeOf(index) {
    if (!this.terrain) return 0;
    let grade = this.grades.get(index);
    if (grade === undefined) {
      const edge = this.graph.edges[index];
      const [ax, ay] = this.nodePosition(edge.a);
      const [bx, by] = this.nodePosition(edge.b);
      const run = Math.hypot(bx - ax, by - ay);
      grade = run > 0 ? Math.abs(heightAt(this.terrain, bx, by) - heightAt(this.terrain, ax, ay)) / run : 0;
      this.grades.set(index, grade);
    }
    return grade;
  }

  /**
   * Can a vehicle of this mode climb this edge? A tram cannot take a street
   * steeper than BUILD.TRAM_STREET_MAX_GRADE (Alex, Oct 18 2026); a bus
   * climbs anything.
   */
  climbable(index, mode) {
    return mode !== 'tram' || this.gradeOf(index) <= BUILD.TRAM_STREET_MAX_GRADE;
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
   * Which way a stop placed at `snapped` serves traffic, as a unit vector in
   * local metres. Every two-way street is two one-way streets side by side,
   * as in Cities: Skylines: a stop stands on one side of it and is called at
   * by vehicles going that side's way — the side that was clicked, with
   * traffic on the right (BUILD.RIGHT_HAND_TRAFFIC). On a one-way street the
   * flow decides, whichever side was clicked. Call before `nodeAt` splits
   * the edge.
   * @returns {[number, number]}
   */
  headingAt(snapped, lon, lat, mode) {
    const edge = this.graph.edges[snapped.edge];
    const [ax, ay] = this.nodePosition(edge.a);
    const [bx, by] = this.nodePosition(edge.b);
    const length = Math.hypot(bx - ax, by - ay) || 1;
    const along = [(bx - ax) / length, (by - ay) / length];
    const back = [-along[0], -along[1]];
    if (edge.oneway && !edge.onewayExempt?.includes(mode)) return edge.oneway === 1 ? along : back;
    const [x, y] = this.frame.toLocal(lon, lat);
    // The click is right of a→b when it lies toward (along.y, −along.x), y pointing north.
    const right = (x - ax) * along[1] - (y - ay) * along[0] >= 0;
    return right === BUILD.RIGHT_HAND_TRAFFIC ? along : back;
  }

  /**
   * The edge at `node` that a vehicle travelling `heading` arrives along:
   * the one pointing most nearly backwards. -1 if the node has none.
   */
  edgeBehind(node, heading, mode) {
    const allowed = ALLOWED_CLASSES[mode];
    const { start, edges } = this.adjacency;
    const [x, y] = this.nodePosition(node);
    let best = -1;
    let bestDot = Infinity;
    for (let i = start[node]; i < start[node + 1]; i++) {
      const edge = this.graph.edges[edges[i]];
      if (!allowed.has(edge.cls)) continue;
      const [ox, oy] = this.nodePosition(edge.a === node ? edge.b : edge.a);
      const length = Math.hypot(ox - x, oy - y) || 1;
      const dot = ((ox - x) * heading[0] + (oy - y) * heading[1]) / length;
      if (dot < bestDot) { bestDot = dot; best = edges[i]; }
    }
    return best;
  }

  /**
   * How a bus or tram gets from one stop to the next: leaving `from` going
   * `fromHeading`, through any `vias` (a dragged segment), and arriving at
   * `to` going `toHeading` — on the side of the road each stop stands on.
   * It obeys one-way streets and never turns round in the middle of a road:
   * a U-turn happens only where there is no other way on, at a dead end.
   *
   * The search runs over road edges in a direction rather than over nodes,
   * which is what lets it forbid U-turns: having arrived at a node along one
   * road, a vehicle may leave along any other.
   *
   * @param {number[]} [vias] nodes to pass through, in order
   * @returns {{nodes:number[], lengthM:number}|null} null when there is no legal way
   */
  stopPath(from, fromHeading, to, toHeading, mode, vias = []) {
    const points = [from, ...vias, to].filter((node, i, all) => i === 0 || node !== all[i - 1]);
    if (points.length === 1) points.push(to); // A stop to the stop facing it.
    let nodes = [from];
    let lengthM = 0;
    // Leaving the first stop forwards; leaving a via along any road but the one it came in by.
    let notOut = this.edgeBehind(from, fromHeading, mode);
    for (let i = 1; i < points.length; i++) {
      const last = i === points.length - 1;
      const leg = this.directedLeg(points[i - 1], notOut, points[i],
        last ? this.edgeBehind(to, toHeading, mode) : -1, mode);
      if (!leg) return null;
      nodes = nodes.concat(leg.nodes.slice(1));
      lengthM += leg.lengthM;
      notOut = leg.lastEdge;
    }
    return { nodes, lengthM };
  }

  /**
   * One leg of `stopPath`: Dijkstra over directed edges from `source` to
   * `target`, not leaving along edge `notOut` and, unless `arriveBy` is -1,
   * arriving along edge `arriveBy`.
   * @returns {{nodes:number[], lengthM:number, lastEdge:number}|null}
   */
  directedLeg(source, notOut, target, arriveBy, mode) {
    if (source === target && arriveBy === -1) return { nodes: [source], lengthM: 0, lastEdge: notOut };
    const allowed = ALLOWED_CLASSES[mode];
    const { start, edges } = this.adjacency;
    const all = this.graph.edges;
    // State 2e is edge e walked a → b, state 2e+1 walked b → a.
    const cost = new Float64Array(all.length * 2).fill(Infinity);
    const previous = new Int32Array(all.length * 2).fill(-1);
    const settled = new Uint8Array(all.length * 2);
    const heap = new MinHeap();
    const headOf = (state) => (state & 1 ? all[state >> 1].a : all[state >> 1].b);

    /** Every way on from `node`, having arrived along `came` (-1 at the start). */
    const expand = (node, came, here, from) => {
      const ways = [];
      for (let i = start[node]; i < start[node + 1]; i++) {
        const index = edges[i];
        const edge = all[index];
        if (!allowed.has(edge.cls) || !mayTravel(edge, node, mode) || !this.climbable(index, mode)) continue;
        ways.push(index);
      }
      const onward = ways.filter((index) => index !== came);
      // Turning round only where there is no other way on.
      for (const index of onward.length > 0 ? onward : ways) {
        const state = 2 * index + (all[index].a === node ? 0 : 1);
        const candidate = here + edgeCost(all[index]);
        if (settled[state] || candidate >= cost[state]) continue;
        cost[state] = candidate;
        previous[state] = from;
        heap.push(state, candidate);
      }
    };
    expand(source, notOut, 0, -1);

    while (heap.size > 0) {
      const state = heap.pop();
      if (settled[state]) continue;
      settled[state] = 1;
      const head = headOf(state);
      if (head === target && (arriveBy === -1 || state >> 1 === arriveBy)) {
        const nodes = [];
        let lengthM = 0;
        for (let s = state; s !== -1; s = previous[s]) {
          nodes.push(headOf(s));
          lengthM += all[s >> 1].lengthM;
        }
        nodes.push(source);
        nodes.reverse();
        return { nodes, lengthM, lastEdge: state >> 1 };
      }
      expand(head, state >> 1, cost[state], state);
    }
    return null;
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
   * @param {{ignoreOneway?:boolean, ignoreGrade?:boolean}} [options]
   *   `ignoreOneway`: the fallback when no legal path exists, which happens
   *   where a one-way street runs out of the region. `ignoreGrade`: streets
   *   too steep for a tram count too — to show where one was refused.
   * @returns {{nodes:number[], lengthM:number}|null} null when unreachable
   */
  shortestPath(fromNode, toNode, mode, { ignoreOneway = false, ignoreGrade = false } = {}) {
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
        if (!ignoreGrade && !this.climbable(edges[i], mode)) continue;
        const next = edge.a === node ? edge.b : edge.a;
        if (settled[next]) continue;
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
