/**
 * How a passenger gets from A to B.
 *
 * The graph is not the map. Its nodes are *platforms* — a (stop, line,
 * direction) triple — plus two nodes per stop: where a trip STARTS, and where
 * a passenger has ARRIVED by getting off something. The edges:
 *
 *   start → platform    first boarding, costing half the headway (expected wait)
 *   arrived → platform  a change of vehicle: the wait plus the transfer penalty
 *   platform → platform riding one hop, costing travel time plus the dwell
 *   platform → arrived  alighting, free
 *   arrived → arrived   walking inside an interchange, at walking speed
 *
 * Modelling platforms rather than stops is what makes transfers honest: staying
 * on a vehicle costs nothing, while changing costs a wait and a penalty, so
 * the router stops proposing silly four-leg trips.
 *
 * **Every change of vehicle pays the penalty — including at the same stop.**
 * Splitting each stop into "start" and "arrived" is what makes that possible:
 * with one node per stop, getting off and back on at the same stop looked
 * like a first boarding and cost only the wait, so a shared stop was a free
 * transfer while a stop 50 m away cost five minutes. In reality people often
 * prefer a slightly longer ride to a change, however quick the change is
 * (Alex, Oct 16 2026). Walking to the final destination after getting off is
 * not a change and pays nothing extra.
 *
 * Routes are Dijkstra from one origin to everywhere, computed on demand and
 * cached until the network changes.
 */

import { ROUTING } from '../config.js';
import { MinHeap } from '../build/road-routing.js';

/** @typedef {{lineId:string, direction:number, fromStop:string, toStop:string}} Leg */
/** @typedef {{legs: Leg[], seconds: number}} Route */

export class Router {
  /** @param {import('../model/network.js').Network} network */
  constructor(network) {
    this.network = network;
    /** Origin stop id → (destination stop id → Route). @type {Map<string, Map<string, Route>>} */
    this.cache = new Map();
    this.builtForVersion = -1;
    this.nodes = [];
    this.nodeIndex = new Map();
    this.adjacency = [];
  }

  /** Rebuild the graph if the network has changed since last time. */
  refreshIfNeeded() {
    if (this.builtForVersion === this.network.version) return false;
    this.build();
    this.builtForVersion = this.network.version;
    this.cache.clear();
    return true;
  }

  /** Intern a node id, returning its index. */
  nodeFor(id) {
    let index = this.nodeIndex.get(id);
    if (index === undefined) {
      index = this.nodes.length;
      this.nodes.push(id);
      this.nodeIndex.set(id, index);
      this.adjacency.push([]);
    }
    return index;
  }

  edge(fromId, toId, seconds, kind, meta = null) {
    const from = this.nodeFor(fromId);
    const to = this.nodeFor(toId);
    this.adjacency[from].push({ to, seconds, kind, meta });
  }

  build() {
    this.nodes = [];
    this.nodeIndex = new Map();
    this.adjacency = [];

    const { network } = this;

    // Stop nodes first, so every stop exists even with no lines.
    for (const stop of network.stops.values()) {
      this.nodeFor(startNode(stop.id));
      this.nodeFor(arrivedNode(stop.id));
    }

    for (const line of network.activeLines) {
      // Past the timetable threshold people arrive for the departure rather
      // than at random, so the wait stops growing with the headway.
      const headwayWait = ROUTING.BOARDING_WAIT_FRACTION
        * Math.min(line.headwayS, ROUTING.TIMETABLE_HEADWAY_S);
      if (!Number.isFinite(headwayWait)) continue;

      for (const direction of directionsServed(line)) {
        const order = stopOrder(line, direction);

        for (let i = 0; i < order.length; i++) {
          const stopId = order[i];
          const platform = platformNode(stopId, line.id, direction);

          // Board here as the trip's first vehicle, or as a change; alight
          // here. Boarding costs the expected wait, and a change adds the
          // transfer penalty.
          this.edge(startNode(stopId), platform, headwayWait, 'board',
            { lineId: line.id, direction });
          this.edge(arrivedNode(stopId), platform, headwayWait + ROUTING.TRANSFER_PENALTY_S,
            'transfer', { lineId: line.id, direction });
          this.edge(platform, arrivedNode(stopId), 0, 'alight',
            { lineId: line.id, direction });

          // Ride to the next stop in this direction.
          if (i < order.length - 1) {
            const nextStopId = order[i + 1];
            const seconds = hopSeconds(line, direction, i);
            this.edge(platform, platformNode(nextStopId, line.id, direction), seconds, 'ride',
              { lineId: line.id, direction, fromStop: stopId, toStop: nextStopId });
          }
        }
      }
    }

    // Walking inside an interchange, after getting off. No penalty here: it
    // is charged when the passenger boards again, so walking on to the final
    // destination costs only the walk.
    for (const stop of network.stops.values()) {
      for (const { stop: other, walkSeconds } of network.walkableFrom(stop)) {
        if (other.id === stop.id) continue;
        this.edge(arrivedNode(stop.id), arrivedNode(other.id), walkSeconds, 'walk');
      }
    }
  }

  /**
   * Shortest routes from one stop to every reachable stop.
   * @param {string} originId
   * @returns {Map<string, Route>}
   */
  routesFrom(originId) {
    this.refreshIfNeeded();
    const cached = this.cache.get(originId);
    if (cached) return cached;

    const start = this.nodeIndex.get(startNode(originId));
    const results = new Map();
    if (start === undefined) { this.cache.set(originId, results); return results; }

    const count = this.nodes.length;
    const distance = new Float64Array(count).fill(Infinity);
    const previous = new Int32Array(count).fill(-1);
    const viaEdge = new Array(count).fill(null);
    const settled = new Uint8Array(count);
    distance[start] = 0;

    const heap = new MinHeap();
    heap.push(start, 0);

    while (heap.size > 0) {
      const node = heap.pop();
      if (settled[node]) continue;
      settled[node] = 1;
      for (const edge of this.adjacency[node]) {
        if (settled[edge.to]) continue;
        const candidate = distance[node] + edge.seconds;
        if (candidate < distance[edge.to]) {
          distance[edge.to] = candidate;
          previous[edge.to] = node;
          viaEdge[edge.to] = edge;
          heap.push(edge.to, candidate);
        }
      }
    }

    // Reconstruct a leg list for every stop the passenger can arrive at.
    for (const stopId of this.network.stops.keys()) {
      if (stopId === originId) continue;
      const target = this.nodeIndex.get(arrivedNode(stopId));
      if (target === undefined || !Number.isFinite(distance[target])) continue;

      const legs = reconstructLegs(target, previous, viaEdge);
      // A route with no ride is just a walk; it is not a transit trip.
      if (legs.length === 0) continue;
      results.set(stopId, { legs, seconds: distance[target] });
    }

    this.cache.set(originId, results);
    return results;
  }

  /** The single best route between two stops, or null. @returns {Route|null} */
  route(fromId, toId) {
    return this.routesFrom(fromId).get(toId) || null;
  }
}

/**
 * Walk the predecessor chain and collapse it into boarding-to-alighting legs.
 * Consecutive `ride` edges on the same line and direction merge into one leg,
 * which is what the passenger experiences: one vehicle, several stops.
 */
function reconstructLegs(target, previous, viaEdge) {
  const edges = [];
  for (let node = target; previous[node] !== -1; node = previous[node]) {
    edges.push(viaEdge[node]);
  }
  edges.reverse();

  /** @type {Leg[]} */
  const legs = [];
  for (const edge of edges) {
    if (edge.kind !== 'ride') continue;
    const last = legs[legs.length - 1];
    if (last && last.lineId === edge.meta.lineId && last.direction === edge.meta.direction &&
        last.toStop === edge.meta.fromStop) {
      last.toStop = edge.meta.toStop; // Stay aboard.
    } else {
      legs.push({
        lineId: edge.meta.lineId,
        direction: edge.meta.direction,
        fromStop: edge.meta.fromStop,
        toStop: edge.meta.toStop,
      });
    }
  }
  return legs;
}

/**
 * Which directions a line actually runs.
 *
 * An open line shuttles, so both directions are always served by every
 * vehicle. A loop keeps each vehicle's direction forever, so only the
 * directions its vehicles were given are available — which is exactly the
 * Mini Metro rule the spec asks for, and the reason the player is asked
 * clockwise or anticlockwise when adding a vehicle to a loop.
 */
export function directionsServed(line) {
  if (!line.loop) return [0, 1];
  const directions = new Set(line.vehicles.map((vehicle) => vehicle.direction));
  return [...directions];
}

/**
 * The line's stops in travel order for a direction.
 * Direction 0 is the stop list as drawn; direction 1 is reversed. A loop
 * repeats its first stop at the end so the ring closes.
 */
export function stopOrder(line, direction) {
  const stops = direction === 0 ? line.stops : [...line.stops].reverse();
  return line.loop ? [...stops, stops[0]] : stops;
}

/**
 * Seconds to ride hop `i` of `stopOrder(line, direction)`, including the dwell
 * at the arriving stop.
 */
export function hopSeconds(line, direction, i) {
  const segment = segmentFor(line, direction, i);
  const travel = segment ? (segment.lengthM / 1000) / line.cruiseKmh * 3600 : 0;
  return travel + line.dwellS;
}

/**
 * The segment a hop uses. Segment `k` of the line always joins stops[k] and
 * stops[k+1] as drawn, so travelling backwards walks the same segments in
 * reverse order.
 */
export function segmentFor(line, direction, i) {
  const segmentCount = line.segments.length;
  if (segmentCount === 0) return null;
  const index = direction === 0 ? i : segmentCount - 1 - i;
  return line.segments[index] || null;
}

const startNode = (stopId) => `S:${stopId}`;
const arrivedNode = (stopId) => `A:${stopId}`;
const platformNode = (stopId, lineId, direction) => `P:${stopId}:${lineId}:${direction}`;
