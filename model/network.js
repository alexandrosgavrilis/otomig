/**
 * The player's network: stops, lines and the interchanges that emerge from
 * them.
 *
 * Nothing here knows about simulation or drawing. It owns the structure, keeps
 * derived data (segment paths, lengths, interchange groups) consistent after
 * every edit, and bumps a `version` counter so the expensive consumers — the
 * demand pair table and the passenger route cache — know when to recompute
 * rather than doing it per frame.
 */

import { MODES, DEMAND, COSTS, LINE_PALETTE, VEHICLES } from '../config.js';

let nextId = 1;
const newId = (prefix) => `${prefix}${nextId++}`;

/** @typedef {'bus'|'tram'|'metro'|'train'} Mode */

export class Stop {
  /**
   * @param {Mode} mode
   * @param {number} lon
   * @param {number} lat
   * @param {number} node road-graph node this stop is snapped to
   * @param {string} name
   */
  constructor(mode, lon, lat, node, name) {
    this.id = newId('s');
    this.mode = mode;
    this.lon = lon;
    this.lat = lat;
    this.node = node;
    this.name = name;
    /** Line ids calling here. */
    this.lines = [];
    /** Interchange id, or null when this stop stands alone. */
    this.interchange = null;
    /**
     * Waiting passengers, as dot objects. Kept on the stop rather than in one
     * global list so the renderer and the boarding loop both have them to hand.
     * @type {import('../sim/passengers.js').Dot[]}
     */
    this.waiting = [];
  }

  get cost() {
    const cost = COSTS.STOP[this.mode];
    return typeof cost === 'number' ? cost : cost.atGrade;
  }
}

export class Line {
  /** @param {Mode} mode @param {string} color */
  constructor(mode, color) {
    this.id = newId('l');
    this.mode = mode;
    this.color = color;
    /** Stop ids in order. On a loop the first is not repeated at the end. */
    this.stops = [];
    /** True when the line closes back on its first stop. */
    this.loop = false;
    /**
     * One entry per segment between consecutive stops: the lon/lat polyline the
     * vehicle follows and its length. On a loop there is one more segment than
     * on an open line, closing the ring.
     * @type {Array<{points:number[][], lengthM:number}>}
     */
    this.segments = [];
    /** @type {import('../sim/vehicles.js').Vehicle[]} */
    this.vehicles = [];
    /** Cumulative counters, for the line panel. */
    this.ridersToday = 0;
    this.ridersPerDay = 0;
  }

  get capacity() { return MODES[this.mode].capacity; }
  get cruiseKmh() { return MODES[this.mode].cruiseKmh; }
  get dwellS() { return MODES[this.mode].dwellS; }

  /** Total length, m. A loop includes the closing segment. */
  get lengthM() {
    return this.segments.reduce((sum, segment) => sum + segment.lengthM, 0);
  }

  /**
   * Time for one vehicle to complete a full cycle, sim seconds.
   *
   * On an open line a cycle is out and back, because the vehicle shuttles and
   * reverses at both terminals. On a loop it is once round. This is what
   * headway is derived from, so it decides how many vehicles are useful.
   */
  get cycleSeconds() {
    const travel = (this.lengthM / 1000) / this.cruiseKmh * 3600;
    const dwells = this.stops.length * this.dwellS;
    return this.loop ? travel + dwells : 2 * (travel + dwells);
  }

  /** Sim seconds between vehicles. Infinite with no vehicles. */
  get headwayS() {
    if (this.vehicles.length === 0) return Infinity;
    return this.cycleSeconds / this.vehicles.length;
  }

  /** Vehicle cap, so headway never drops below the configured minimum. */
  get maxVehicles() {
    return Math.max(1, Math.floor(this.cycleSeconds / VEHICLES.MIN_HEADWAY_S));
  }

  /** Riders currently aboard. */
  get ridersNow() {
    return this.vehicles.reduce((sum, vehicle) => sum + vehicle.passengers.length, 0);
  }
}

/** A group of nearby stops passengers can walk between. */
export class Interchange {
  constructor(id, stopIds) {
    this.id = id;
    this.stops = stopIds;
  }
}

export class Network {
  /**
   * @param {import('../build/road-routing.js').RoadIndex} roadIndex
   * @param {import('./region.js').LocalFrame} frame
   */
  constructor(roadIndex, frame) {
    this.roadIndex = roadIndex;
    this.frame = frame;
    /** @type {Map<string, Stop>} */
    this.stops = new Map();
    /** @type {Map<string, Line>} */
    this.lines = new Map();
    /** @type {Map<string, Interchange>} */
    this.interchanges = new Map();
    /**
     * Bumped on every structural change. The demand pair table and the route
     * cache compare against their own copy and rebuild only when it moves.
     */
    this.version = 0;
    this.colorCursor = 0;
  }

  touch() { this.version++; }

  /** Next unused palette colour, cycling once they run out. */
  nextColor() {
    const used = new Set([...this.lines.values()].map((line) => line.color));
    for (const color of LINE_PALETTE) if (!used.has(color)) return color;
    return LINE_PALETTE[this.colorCursor++ % LINE_PALETTE.length];
  }

  // ─── Stops ────────────────────────────────────────────────────────────────

  /**
   * Place a stop, snapped to the nearest usable road.
   *
   * @returns {{stop: Stop, reused: boolean}|{error: string}}
   */
  addStop(lon, lat, mode) {
    const snapped = this.roadIndex.snap(lon, lat, mode);
    if (!snapped) return { error: 'tooFarFromRoad' };

    // Clicking an existing stop of the same mode reuses it, as in Mini Metro.
    const existing = this.stopAtNode(snapped.node, mode);
    if (existing) return { stop: existing, reused: true };

    const stop = new Stop(mode, snapped.lon, snapped.lat, snapped.node,
      snapped.name || 'Stop');
    this.stops.set(stop.id, stop);
    this.recomputeInterchanges();
    this.touch();
    return { stop, reused: false };
  }

  stopAtNode(node, mode) {
    for (const stop of this.stops.values()) {
      if (stop.node === node && stop.mode === mode) return stop;
    }
    return null;
  }

  /** Nearest stop of any mode within `maxDistM`, for click selection. */
  stopNear(lon, lat, maxDistM = 30, mode = null) {
    let best = null;
    let bestDist = maxDistM;
    for (const stop of this.stops.values()) {
      if (mode && stop.mode !== mode) continue;
      const distance = this.frame.distance(lon, lat, stop.lon, stop.lat);
      if (distance < bestDist) { bestDist = distance; best = stop; }
    }
    return best;
  }

  /**
   * Remove a stop entirely: drop it from every line it serves, reconnecting
   * each line's neighbours around the gap.
   */
  removeStop(stopId) {
    const stop = this.stops.get(stopId);
    if (!stop) return;
    for (const lineId of [...stop.lines]) {
      const line = this.lines.get(lineId);
      if (line) this.removeStopFromLine(line, stopId);
    }
    this.stops.delete(stopId);
    this.recomputeInterchanges();
    this.touch();
  }

  // ─── Lines ────────────────────────────────────────────────────────────────

  /** @param {Mode} mode */
  createLine(mode, color = null) {
    const line = new Line(mode, color || this.nextColor());
    this.lines.set(line.id, line);
    this.touch();
    return line;
  }

  /**
   * Append a stop to a line's end, routing the new segment along the roads.
   *
   * Clicking the line's own first stop closes it into a loop instead.
   *
   * @returns {{ok: true}|{error: string}}
   */
  extendLine(line, stop) {
    if (line.loop) return { error: 'lineIsLoop' };

    // Closing the loop.
    if (line.stops.length >= 3 && stop.id === line.stops[0]) {
      const closing = this.routeBetween(line, this.stops.get(line.stops.at(-1)), stop);
      if (!closing) return { error: 'noRoadPath' };
      line.segments.push(closing);
      line.loop = true;
      this.touch();
      return { ok: true };
    }

    if (line.stops.includes(stop.id)) return { error: 'alreadyOnLine' };

    if (line.stops.length > 0) {
      const previous = this.stops.get(line.stops.at(-1));
      const segment = this.routeBetween(line, previous, stop);
      if (!segment) return { error: 'noRoadPath' };
      line.segments.push(segment);
    }

    line.stops.push(stop.id);
    if (!stop.lines.includes(line.id)) stop.lines.push(line.id);
    this.touch();
    return { ok: true };
  }

  /** Drop a stop out of one line, reconnecting its neighbours. */
  removeStopFromLine(line, stopId) {
    const index = line.stops.indexOf(stopId);
    if (index === -1) return;

    line.stops.splice(index, 1);
    const stop = this.stops.get(stopId);
    if (stop) stop.lines = stop.lines.filter((id) => id !== line.id);

    // A line needs two stops to mean anything.
    if (line.stops.length < 2) {
      line.loop = false;
      line.segments = [];
    } else {
      this.rebuildSegments(line);
    }
    this.touch();
  }

  /** Insert a stop into the middle of a line, at a segment boundary. */
  insertStop(line, stop, afterIndex) {
    if (line.stops.includes(stop.id)) return { error: 'alreadyOnLine' };
    line.stops.splice(afterIndex + 1, 0, stop.id);
    if (!stop.lines.includes(line.id)) stop.lines.push(line.id);
    if (!this.rebuildSegments(line)) {
      // Undo: the road network can't actually serve this order.
      line.stops.splice(afterIndex + 1, 1);
      stop.lines = stop.lines.filter((id) => id !== line.id);
      this.rebuildSegments(line);
      return { error: 'noRoadPath' };
    }
    this.touch();
    return { ok: true };
  }

  deleteLine(lineId) {
    const line = this.lines.get(lineId);
    if (!line) return;
    for (const stopId of line.stops) {
      const stop = this.stops.get(stopId);
      if (stop) stop.lines = stop.lines.filter((id) => id !== lineId);
    }
    this.lines.delete(lineId);
    this.touch();
  }

  /**
   * Route one segment between two consecutive stops along the roads.
   * @returns {{points:number[][], lengthM:number}|null}
   */
  routeBetween(line, from, to) {
    const path = this.roadIndex.shortestPath(from.node, to.node, line.mode);
    if (!path) return null;
    return { points: this.roadIndex.polyline(path.nodes), lengthM: path.lengthM };
  }

  /** Recompute every segment of a line after its stop list changed. */
  rebuildSegments(line) {
    const segments = [];
    for (let i = 0; i < line.stops.length - 1; i++) {
      const segment = this.routeBetween(line,
        this.stops.get(line.stops[i]), this.stops.get(line.stops[i + 1]));
      if (!segment) return false;
      segments.push(segment);
    }
    if (line.loop && line.stops.length >= 3) {
      const closing = this.routeBetween(line,
        this.stops.get(line.stops.at(-1)), this.stops.get(line.stops[0]));
      if (!closing) return false;
      segments.push(closing);
    }
    line.segments = segments;
    return true;
  }

  // ─── Interchanges ─────────────────────────────────────────────────────────

  /**
   * Group stops within INTERCHANGE_M of each other, by transitive closure:
   * A near B and B near C puts all three in one interchange even if A and C
   * are further apart than the radius. That matches how a real interchange
   * sprawls, and it keeps the grouping independent of iteration order.
   */
  recomputeInterchanges() {
    const stops = [...this.stops.values()];
    const groupOf = new Map();
    for (const stop of stops) { stop.interchange = null; groupOf.set(stop.id, stop.id); }

    const find = (id) => {
      let root = id;
      while (groupOf.get(root) !== root) root = groupOf.get(root);
      // Path compression, so repeated lookups stay flat.
      let walk = id;
      while (groupOf.get(walk) !== root) {
        const next = groupOf.get(walk);
        groupOf.set(walk, root);
        walk = next;
      }
      return root;
    };

    for (let i = 0; i < stops.length; i++) {
      for (let j = i + 1; j < stops.length; j++) {
        const distance = this.frame.distance(
          stops[i].lon, stops[i].lat, stops[j].lon, stops[j].lat);
        if (distance <= DEMAND.INTERCHANGE_M) {
          groupOf.set(find(stops[i].id), find(stops[j].id));
        }
      }
    }

    /** @type {Map<string, string[]>} */
    const groups = new Map();
    for (const stop of stops) {
      const root = find(stop.id);
      if (!groups.has(root)) groups.set(root, []);
      groups.get(root).push(stop.id);
    }

    this.interchanges.clear();
    for (const [root, members] of groups) {
      // A single stop is not an interchange.
      if (members.length < 2) continue;
      const interchange = new Interchange(`i${root}`, members);
      this.interchanges.set(interchange.id, interchange);
      for (const id of members) this.stops.get(id).interchange = interchange.id;
    }
  }

  /**
   * Stops a passenger can walk to from here, with the walk time in sim seconds.
   * Includes the stop itself at zero cost.
   * @returns {Array<{stop: Stop, walkSeconds: number}>}
   */
  walkableFrom(stop) {
    const result = [{ stop, walkSeconds: 0 }];
    if (!stop.interchange) return result;
    const interchange = this.interchanges.get(stop.interchange);
    for (const id of interchange.stops) {
      if (id === stop.id) continue;
      const other = this.stops.get(id);
      const distance = this.frame.distance(stop.lon, stop.lat, other.lon, other.lat);
      result.push({ stop: other, walkSeconds: distance / DEMAND.WALK_SPEED_MS });
    }
    return result;
  }

  // ─── Totals ───────────────────────────────────────────────────────────────

  /** Every passenger currently waiting or aboard. The HUD's live count. */
  get passengersOnNetwork() {
    let total = 0;
    for (const stop of this.stops.values()) total += stop.waiting.length;
    for (const line of this.lines.values()) total += line.ridersNow;
    return total;
  }

  /** Lines with at least two stops and at least one vehicle actually run. */
  get activeLines() {
    return [...this.lines.values()].filter(
      (line) => line.stops.length >= 2 && line.vehicles.length > 0);
  }
}
