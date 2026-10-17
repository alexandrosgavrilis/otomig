/**
 * The player's network: stops, lines, track, and the interchanges that emerge
 * from them.
 *
 * Nothing here knows about simulation or drawing. It owns the structure, keeps
 * derived data (segment paths, lengths, interchange groups) consistent after
 * every edit, and bumps a `version` counter so the expensive consumers — the
 * demand pair table and the passenger route cache — know when to recompute
 * rather than doing it per frame.
 */

import { MODES, DEMAND, COSTS, LINE_PALETTE, VEHICLES, BUILD } from '../config.js';
import { buildTrack, buildRailTrack, onStreetCost } from '../build/track-geometry.js';
import { RoadCorridors } from '../build/rail-roads.js';
import { TrackGraph, canRunOn } from '../build/track-routing.js';

let nextId = 1;
const newId = (prefix) => `${prefix}${nextId++}`;

/**
 * Make sure ids handed out from now on cannot collide with ones loaded from a
 * save.
 *
 * The counter is per page, so on a fresh page it starts at 1 — and a save
 * loaded there already holds `s1`, `s2`, …. Without this, the first stop built
 * after loading reused an id that was already in the network, and the two
 * stops silently became one in every Map keyed by id.
 *
 * @param {Iterable<string>} ids
 */
export function reserveIds(ids) {
  for (const id of ids) {
    const number = Number(String(id).replace(/^[a-z]+/, ''));
    if (Number.isFinite(number)) nextId = Math.max(nextId, number + 1);
  }
}

/** @typedef {'bus'|'tram'|'metro'|'train'} Mode */

/** Which price a rail station pays, by the structure of the track it sits on. [spec] */
const STATION_PRICE = {
  metro: { tunnel: 'underground', atGrade: 'atGrade', bridge: 'elevated' },
  train: { tunnel: 'tunnel', atGrade: 'atGrade', bridge: 'elevated' },
};

const isRail = (mode) => mode === 'metro' || mode === 'train';

const lonLatOf = (roadIndex, node) => {
  const [lon, lat] = roadIndex.nodeLonLat(node);
  return { lon, lat };
};

/** Stops a loop needs: three, or two for a single-stop line going one way round. */
const minLoopStops = (line) => (line.singleSided ? 2 : 3);

/** The number in an id like "s42", for ordering by when things were built. */
const idNumber = (id) => Number(String(id).replace(/\D+/g, '')) || 0;

export class Stop {
  /**
   * @param {Mode} mode
   * @param {number} lon
   * @param {number} lat
   * @param {number|string} node what this stop is snapped to: a road-graph
   *   node index for bus and tram, a track sample key for metro and train
   * @param {string} name
   * @param {string} [structure] for a station, the structure of the track
   *   under it — which decides its price
   */
  constructor(mode, lon, lat, node, name, structure = 'atGrade') {
    this.id = newId('s');
    this.mode = mode;
    this.lon = lon;
    this.lat = lat;
    this.node = node;
    /** The street or station it was named after when built. */
    this.name = name;
    /** A name the player gave it, or null to use the street's (numbered). */
    this.customName = null;
    this.structure = structure;
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
    /**
     * Intercity service, for a station on existing rail only (Phase 6). The
     * timer counts sim seconds toward the next call; `carry` holds the
     * fraction of a dot left over from the last drop.
     */
    this.intercity = false;
    this.intercityTimer = 0;
    this.intercityCarry = 0;
    this.intercityCalls = 0;
  }

  /**
   * Stations simply take the structure at their position — underground, at
   * grade or elevated — and are priced to match, as the spec says.
   */
  get cost() {
    const cost = COSTS.STOP[this.mode];
    if (typeof cost === 'number') return cost;
    return cost[STATION_PRICE[this.mode]?.[this.structure]] ?? cost.atGrade;
  }
}

/**
 * A piece of metro or train track, built with the Build track tool.
 *
 * Track is separate from lines, as the spec asks: build track, then draw lines
 * on it. A track is defined by the player's waypoints and by what it joins at
 * each end; everything else — the spline, the profile, the structures, the
 * level crossings — is derived by `buildRailTrack` and rebuilt identically on
 * load rather than saved.
 */
export class Track {
  /**
   * @param {'metro'|'train'} mode
   * @param {Array<[number,number]>} control waypoints, lon/lat
   * @param {{trackId:string, index:number}|null} start junction at the first waypoint
   * @param {{trackId:string, index:number}|null} end junction at the last waypoint
   */
  constructor(mode, control, start = null, end = null) {
    this.id = newId('t');
    this.mode = mode;
    this.control = control;
    this.start = start;
    this.end = end;
    /**
     * Heights each end was built to meet, m, or null for a free end.
     *
     * Stored rather than looked up again on load, so a track whose junction
     * partner has since been bulldozed still rebuilds to exactly the profile
     * the player paid for.
     */
    this.pins = { start: null, end: null };
    /** What was paid for it, for the refund and for maintenance. */
    this.cost = 0;

    // Derived geometry, filled by `apply`.
    this.points = [];
    this.kinds = [];
    this.height = [];
    this.terrain = [];
    this.overWater = [];
    this.blockedAt = [];
    this.levelCrossings = [];
    this.lengthM = 0;
  }

  /** Copy a built geometry onto the track. */
  apply(built) {
    this.points = built.points;
    this.kinds = built.kinds;
    this.height = built.height;
    this.terrain = built.terrain;
    this.overWater = built.overWater;
    this.blockedAt = built.blockedAt;
    this.levelCrossings = built.levelCrossings;
    this.lengthM = built.lengthM;
    return this;
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
    /**
     * The way back, where one-way streets make it differ: `backSegments[k]`
     * is the route from the end of segment k to its start, or null where the
     * way back is simply the way there, reversed. Null altogether when no
     * segment differs, which is every rail line and most bus lines.
     *
     * Its points are stored in the SAME order as segment k's — from its start
     * to its end — so the vehicle, which walks a segment backwards in
     * direction 1, follows it from the end to the start: the right way down
     * the one-way street. Nothing that walks segments needed to change.
     * @type {Array<Object|null>|null}
     */
    this.backSegments = null;
    /**
     * Single stops (Alex, Oct 17 2026): each stop is on one side of the road,
     * as in Cities: Skylines, and the line runs one way round, as a loop —
     * the player places the stops for each direction. Off (double stops, the
     * default), the line runs both ways and every stop serves both sides.
     * Buses and trams only.
     */
    this.singleSided = false;
    /** Made a loop by single stops rather than by the player closing it. */
    this.autoLoop = false;
    /** A name the player gave the line, or null for the automatic one. */
    this.name = null;
    /** Skip stops nobody needs — buses and trams only (VEHICLES.SKIP_EMPTY_STOPS). */
    this.skipEmptyStops = VEHICLES.SKIP_EMPTY_STOPS.includes(mode);
    /** Hold vehicles at stops to keep them evenly spread. */
    this.keepSpacing = true;
    /**
     * Via-points, one per segment that has been dragged off its default route,
     * keyed `"fromStopId>toStopId"`.
     *
     * Keyed by the stop pair rather than by segment index because an index
     * shifts the moment a stop is inserted or removed, which would silently
     * move a drag from one part of the line to another. With a pair key, an
     * inserted stop breaks the pair and the via is simply dropped — the
     * segment reverts to its default route, which is predictable and visible.
     *
     * What a via means depends on the mode. For a bus it forces a different
     * road route (`RoadIndex.pathThrough`). For a tram it pulls the segment
     * off the road entirely into dedicated track, priced by structure and
     * subject to the grade rule.
     * @type {Map<string, [number, number]>}
     */
    this.vias = new Map();
    /** What this line's track has cost so far, for refunds and maintenance. */
    this.trackCost = 0;
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
   * @param {import('./region.js').Region} [region] needed for off-road track:
   *   the grade rule reads the height grid and the building occupancy raster.
   */
  constructor(roadIndex, frame, region = null) {
    this.roadIndex = roadIndex;
    this.frame = frame;
    this.region = region;
    /** @type {Map<string, Stop>} */
    this.stops = new Map();
    /** @type {Map<string, Line>} */
    this.lines = new Map();
    /** @type {Map<string, Interchange>} */
    this.interchanges = new Map();
    /** Metro and train track, in the order it was built. @type {Map<string, Track>} */
    this.tracks = new Map();
    /** Routing over `tracks`, rebuilt lazily after any track changes. */
    this._trackGraph = null;
    /** The road corridors rail must respect, built on first use. */
    this._corridors = null;
    /**
     * Bumped on every structural change. The demand pair table and the route
     * cache compare against their own copy and rebuild only when it moves.
     */
    this.version = 0;
    this.colorCursor = 0;
  }

  touch() { this.version++; }

  /**
   * Add the region's existing railways as free, ready-made train track. Done
   * once, before any player track, so they come first in every iteration.
   * @param {Track[]} tracks from build/osm-rail.js
   */
  addOsmRail(tracks) {
    for (const track of tracks) this.tracks.set(track.id, track);
    this._trackGraph = null;
    this.touch();
  }

  /** Routing over every piece of built track. */
  get trackGraph() {
    if (!this._trackGraph) this._trackGraph = new TrackGraph(this.tracks.values(), this.frame);
    return this._trackGraph;
  }

  /** Road corridors for the rail-and-roads rules. Lazy: a bus game never needs them. */
  get corridors() {
    if (!this._corridors && this.region) {
      this._corridors = new RoadCorridors(this.region.roads, this.frame);
    }
    return this._corridors;
  }

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
    if (isRail(mode)) return this.addStation(lon, lat, mode);

    // On the road where it was clicked, not at the nearest node — which on a
    // main road can be a side street's (see RoadIndex.snapToRoad).
    const snapped = this.roadIndex.snapToRoad(lon, lat, mode);
    if (!snapped) return { error: 'tooFarFromRoad' };

    // Clicking an existing stop of the same mode reuses it, as in Mini Metro.
    const existing = (snapped.node !== null && this.stopAtNode(snapped.node, mode))
      || this.stopNear(snapped.lon, snapped.lat, BUILD.STOP_REUSE_M, mode);
    if (existing) return { stop: existing, reused: true };

    const node = this.roadIndex.nodeAt(snapped);
    const [stopLon, stopLat] = this.roadIndex.nodeLonLat(node);
    const stop = new Stop(mode, stopLon, stopLat, node, snapped.name || 'Stop');
    this.stops.set(stop.id, stop);
    this.recomputeInterchanges();
    this.touch();
    return { stop, reused: false };
  }

  /**
   * Place a metro or train station, snapped to compatible track within
   * `BUILD.STATION_SNAP_M`.
   *
   * A train station clicked onto metro track is refused with its own message,
   * because "too far from track" would be a lie when the track is right there.
   */
  addStation(lon, lat, mode) {
    const graph = this.trackGraph;
    const snapped = graph.snap(lon, lat, mode, BUILD.STATION_SNAP_M);
    if (!snapped) {
      const anyTrack = graph.snap(lon, lat, mode, BUILD.STATION_SNAP_M, { anyMode: true });
      return { error: anyTrack ? 'wrongTrack' : 'tooFarFromTrack' };
    }

    const existing = this.stopAtNode(snapped.key, mode);
    if (existing) return { stop: existing, reused: true };

    // On existing rail, named after the real station there if there is one.
    // Otherwise after the nearest street, like a bus stop, looking a little
    // wider: a station is often set back from the road.
    const street = this.roadIndex.snap(snapped.lon, snapped.lat, 'bus', BUILD.STOP_SNAP_M * 4);
    const stop = new Stop(mode, snapped.lon, snapped.lat, snapped.key,
      this.osmStationName(snapped.lon, snapped.lat) || street?.name || 'Station', snapped.kind);
    this.stops.set(stop.id, stop);
    this.recomputeInterchanges();
    this.touch();
    return { stop, reused: false };
  }

  // ─── Names ────────────────────────────────────────────────────────────────

  /**
   * A stop's name as shown: the player's own if they gave one, otherwise its
   * street (or station). Stops of a mode sharing a street name are numbered
   * in the order they were built — "Ermou 1", "Ermou 2" — so two stops on
   * one long road can be told apart (Alex, Oct 17 2026).
   */
  stopLabel(stop) {
    if (stop.customName) return stop.customName;
    const twins = [...this.stops.values()]
      .filter((other) => !other.customName && other.mode === stop.mode && other.name === stop.name);
    if (twins.length < 2) return stop.name;
    twins.sort((a, b) => idNumber(a.id) - idNumber(b.id));
    return `${stop.name} ${twins.indexOf(stop) + 1}`;
  }

  /**
   * A line's name: the player's own, or "first stop to last stop" by their
   * street names (unnumbered). When both ends share a name — a loop, or a
   * line up and down one long road — it is that name and the mode instead.
   *
   * @param {Object} line
   * @param {{to:string, mode:Object<string,string>}} words the UI's strings
   */
  lineLabel(line, words) {
    if (line.name) return line.name;
    const place = (id) => {
      const stop = this.stops.get(id);
      return stop ? stop.customName || stop.name : null;
    };
    const first = place(line.stops[0]);
    const last = place(line.stops.at(-1));
    const mode = words.mode[line.mode] ?? line.mode;
    if (!first) return mode;
    if (line.loop || !last || first === last) return `${first} – ${mode}`;
    return `${first} ${words.to} ${last}`;
  }

  // ─── Where each direction calls at a stop ─────────────────────────────────

  /**
   * The stop's twin across a divided road, if it stands on a one-way
   * carriageway with the opposite one directly across and within
   * BUILD.STOP_PAIR_M — a road with a central divider, never a parallel
   * street a block away (Alex, Oct 17 2026). Cached per stop and node.
   * @returns {{node:number, lon:number, lat:number, flow:[number,number]}|null}
   */
  twinOf(stop) {
    if (isRail(stop.mode)) return null;
    const cached = this._twins?.get(stop.id);
    if (cached && cached.node === stop.node) return cached.twin;
    const found = this.roadIndex.twinOf(stop.node, stop.mode, BUILD.STOP_PAIR_M);
    // Across from the stop on the other carriageway, made a node if need be.
    const twinNode = found ? this.roadIndex.nodeAt(found) : null;
    const twin = found && { node: twinNode, flow: found.flow, ...lonLatOf(this.roadIndex, twinNode) };
    (this._twins ??= new Map()).set(stop.id, { node: stop.node, twin });
    return twin;
  }

  /**
   * The road node a line calls at for stop `index`, travelling in
   * `direction`. A double-stop line on a divided road calls at the
   * carriageway running its way — the twin — for the direction the stop's
   * own carriageway does not serve, at the line's ends too, where the bus
   * crosses the divider during its layover. Everywhere else, and for
   * single-stop lines, it is the stop's own node.
   */
  stopNodeFor(line, index, direction) {
    const stop = this.stops.get(line.stops[index]);
    if (!stop || isRail(line.mode) || line.singleSided) return stop?.node;
    const count = line.stops.length;
    if (count < 2) return stop.node;
    const twin = this.twinOf(stop);
    if (!twin) return stop.node;
    // Which way direction 0 travels at this stop: from the stop before to
    // the stop after, or, at an end, along the line's one segment there.
    const atStart = !line.loop && index === 0;
    const atEnd = !line.loop && index === count - 1;
    const previous = this.stops.get(line.stops[atStart ? 0 : (index - 1 + count) % count]);
    const next = this.stops.get(line.stops[atEnd ? index : (index + 1) % count]);
    const [px, py] = this.frame.toLocal(previous.lon, previous.lat);
    const [nx, ny] = this.frame.toLocal(next.lon, next.lat);
    const ownSideForward = twin.flow[0] * (nx - px) + twin.flow[1] * (ny - py) >= 0;
    return ownSideForward === (direction === 0) ? stop.node : twin.node;
  }

  /** Is this a station on an existing railway, where intercity trains may call? */
  onOsmRail(stop) {
    if (!isRail(stop.mode) || typeof stop.node !== 'string') return false;
    const trackId = stop.node.slice(0, stop.node.lastIndexOf(':'));
    return Boolean(this.tracks.get(trackId)?.osm);
  }

  /** Name of the nearest real OSM station or halt, within a platform's length. */
  osmStationName(lon, lat) {
    let best = null;
    let bestDist = BUILD.OSM_STATION_NAME_M;
    for (const station of this.region?.stations || []) {
      if (!station.name) continue;
      const distance = this.frame.distance(lon, lat, station.lon, station.lat);
      if (distance < bestDist) { bestDist = distance; best = station.name; }
    }
    return best;
  }

  /**
   * Where a stop of this mode would stand if dropped here: a road node for a
   * bus or tram, a track sample for a station. Null when nothing is in reach.
   * @returns {{node:number|string, lon:number, lat:number, structure:string}|null}
   */
  snapStop(lon, lat, mode) {
    if (isRail(mode)) {
      const snapped = this.trackGraph.snap(lon, lat, mode, BUILD.STATION_SNAP_M);
      return snapped && { node: snapped.key, lon: snapped.lon, lat: snapped.lat, structure: snapped.kind };
    }
    // `node` is null where the stop would split a road; `snapped` makes it.
    const snapped = this.roadIndex.snapToRoad(lon, lat, mode);
    return snapped && { node: snapped.node, lon: snapped.lon, lat: snapped.lat, structure: 'atGrade', snapped };
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
    // A loop the player closed is finished; one that single stops closed is
    // still being drawn, its way back to the start worked out afresh.
    const openEnded = line.singleSided && line.autoLoop;
    if (line.loop && !openEnded) return { error: 'lineIsLoop' };
    if (openEnded && stop.id === line.stops[0]) return { ok: true };

    const noPath = isRail(line.mode) ? 'noTrackPath' : 'noRoadPath';

    // Closing the loop.
    if (!openEnded && line.stops.length >= 3 && stop.id === line.stops[0]) {
      const closing = this.routeBetween(line, this.stops.get(line.stops.at(-1)), stop);
      if (!closing) return { error: noPath };
      line.segments.push(closing);
      line.loop = true;
      this.settleLine(line);
      this.touch();
      return { ok: true };
    }

    if (line.stops.includes(stop.id)) return { error: 'alreadyOnLine' };

    if (line.stops.length > 0) {
      const previous = this.stops.get(line.stops.at(-1));
      const segment = this.routeBetween(line, previous, stop);
      if (!segment) return { error: noPath };
      line.segments.push(segment);
    }

    line.stops.push(stop.id);
    if (!stop.lines.includes(line.id)) stop.lines.push(line.id);
    this.settleLine(line);
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

    // A line needs two stops to mean anything, and a loop needs three — or
    // two, going one way round with single stops.
    if (line.stops.length < minLoopStops(line)) line.loop = false;
    if (line.stops.length < 2) {
      line.segments = [];
      line.backSegments = null;
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
      return { error: isRail(line.mode) ? 'noTrackPath' : 'noRoadPath' };
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

  /** Key for a via-point on the segment between two stops. */
  static viaKey(fromId, toId) { return `${fromId}>${toId}`; }

  /** The via-point on this segment, if the player dragged it. */
  viaFor(line, from, to) {
    return line.vias?.get(Network.viaKey(from.id, to.id)) || null;
  }

  /**
   * Route one segment between two consecutive stops.
   *
   * Three outcomes, in order of preference:
   *
   *   - **No via** — the shortest path along roads the mode may use. This is
   *     every bus segment and every undragged tram segment, and it is free:
   *     the road already exists. Tram track laid along it is charged per km as
   *     on-street track, which is the cheap rate.
   *   - **A via, bus** — still on roads, but forced through a third node, so
   *     the player can push a route down the street they meant.
   *   - **A via, tram** — the segment leaves the road entirely and becomes a
   *     spline through the dragged point: dedicated track, priced by structure
   *     and subject to the grade rule, so it can tunnel and bridge.
   *
   * @returns {{points:number[][], lengthM:number, offRoad?:boolean,
   *            kinds?:string[], runs?:Object[], blocked?:boolean,
   *            height?:number[], terrain?:number[], cost?:number}|null}
   */
  routeBetween(line, from, to, fromNode = from.node, toNode = to.node, avoidFirst = null) {
    // Metro and train never touch the roads: their stations sit on track, and
    // the path between them is the shortest on track their vehicles may use.
    if (isRail(line.mode)) {
      const path = this.trackGraph.path(from.node, to.node, line.mode);
      return path ? { ...path, onTrack: true } : null;
    }

    const via = this.viaFor(line, from, to);

    if (via && line.mode === 'tram' && this.region) {
      const track = buildTrack(
        [this.roadIndex.nodeLonLat(fromNode), via, this.roadIndex.nodeLonLat(toNode)],
        this.region, this.frame, line.mode);
      // A segment that cannot be built is not silently replaced by a road
      // route — the player dragged it there deliberately and needs to see it
      // refused. `blocked` carries the reason to the preview and the panel.
      return track;
    }

    const asSegment = (path) => ({
      points: this.roadIndex.polyline(path.nodes),
      nodes: path.nodes,
      lengthM: path.lengthM,
      ...(path.ignoresOneway ? { ignoresOneway: true } : {}),
    });

    if (via) {
      const viaNode = this.roadIndex.snap(via[0], via[1], line.mode);
      if (viaNode) {
        const path = this.roadPath([fromNode, viaNode.node, toNode], line.mode, avoidFirst);
        if (path) return asSegment(path);
      }
      // The drag landed somewhere unroutable; fall through to the plain route
      // rather than breaking the line.
    }

    const path = this.roadPath([fromNode, toNode], line.mode, avoidFirst);
    return path ? asSegment(path) : null;
  }

  /**
   * What a line's track costs to build.
   *
   * A bus pays nothing: it drives on roads that already exist. A tram pays the
   * cheap on-street rate along its road-following segments and the structure
   * rate for any segment the player dragged off the road.
   */
  trackCostOf(line) {
    // Rail track is bought with the Build track tool, before any line runs on
    // it, so drawing a line on it costs nothing more.
    if (isRail(line.mode) || !COSTS.TRACK_PER_KM[line.mode]) return 0;
    let total = 0;
    for (const segment of line.segments) {
      total += segment.offRoad
        ? (segment.cost || 0)
        : onStreetCost(segment.lengthM, line.mode);
    }
    // Where one-way streets send the way back down another street, a tram
    // needs track there too.
    for (const back of line.backSegments || []) {
      if (back) total += onStreetCost(back.lengthM, line.mode);
    }
    return Math.round(total);
  }

  /** True when any segment is blocked — by a building, or too steep to build. */
  hasBlockedSegment(line) {
    return line.segments.some((segment) => segment.blocked);
  }

  /** Recompute every segment of a line after its stop list changed. */
  rebuildSegments(line) {
    const segments = [];
    const count = line.stops.length;
    // A single-stop line runs one way round: a loop, even of two stops.
    if (line.singleSided && count >= 2 && !isRail(line.mode) && !line.loop) {
      line.loop = true;
      line.autoLoop = true;
    }
    const pairs = [];
    for (let i = 0; i < count - 1; i++) pairs.push([i, i + 1]);
    if (line.loop && count >= minLoopStops(line)) pairs.push([count - 1, 0]);
    // Hop by hop, each leaving its stop forwards: no turning round in the
    // middle of a road, at a stop or anywhere else (Alex, Oct 17 2026).
    let arrivedFrom = null;
    for (const [i, j] of pairs) {
      const segment = this.routeBetween(line,
        this.stops.get(line.stops[i]), this.stops.get(line.stops[j]),
        this.stopNodeFor(line, i, 0), this.stopNodeFor(line, j, 0), arrivedFrom);
      if (!segment) return false;
      segments.push(segment);
      arrivedFrom = segment.nodes?.length > 1 ? segment.nodes.at(-2) : null;
    }
    // A loop comes back round to its first stop; it must leave that forwards too.
    if (line.loop && segments.length > 1 && arrivedFrom !== null
        && segments[0].nodes?.[1] === arrivedFrom) {
      const again = this.routeBetween(line, this.stops.get(line.stops[0]),
        this.stops.get(line.stops[1]), this.stopNodeFor(line, 0, 0),
        this.stopNodeFor(line, 1, 0), arrivedFrom);
      if (again) segments[0] = again;
    }
    line.segments = segments;
    this.refreshBackSegments(line);
    // A double-stop line turns round at each end like a real bus: the trip
    // down starts by turning round beyond the last stop (in
    // refreshBackSegments), and the trip up by turning round from where the
    // trip down ended. Re-planned whole whenever a stop is added, so an old
    // end stop that is now in the middle loses its turn (Alex, Oct 17 2026).
    // The two ends depend on each other, so the trips are routed twice.
    if (this.turnsAtEnds(line)) {
      for (let pass = 0; pass < 2; pass++) {
        const down = this.arrivalAtStart(line);
        const turn = this.turnSegment(line, this.stopNodeFor(line, 0, 1), down,
          this.stopNodeFor(line, 0, 0), this.stopNodeFor(line, 1, 0), this.viaNodeOf(line, 0));
        if (!turn) break;
        line.segments[0] = turn;
        let arrivedFrom = turn.nodes.length > 1 ? turn.nodes.at(-2) : null;
        for (let k = 1; k < line.segments.length; k++) {
          const segment = this.routeBetween(line, this.stops.get(line.stops[k]),
            this.stops.get(line.stops[k + 1]), this.stopNodeFor(line, k, 0),
            this.stopNodeFor(line, k + 1, 0), arrivedFrom);
          if (!segment) break;
          line.segments[k] = segment;
          arrivedFrom = segment.nodes?.length > 1 ? segment.nodes.at(-2) : null;
        }
        this.refreshBackSegments(line);
      }
    }
    return true;
  }

  /**
   * Does this line turn round at its ends by road: an open double-stop BUS
   * line. Trams are double-ended, as most modern European fleets are, and
   * simply reverse at the end of the line — a turning loop would need track
   * round a block at each end.
   */
  turnsAtEnds(line) {
    return line.mode === 'bus' && !line.singleSided && !line.loop && line.stops.length >= 2
      && line.segments.every((segment) => segment.nodes && !segment.offRoad);
  }

  /** Where the trip down arrives at the first stop from, or null. */
  arrivalAtStart(line) {
    const last = line.backSegments?.[0]?.nodes ?? [...(line.segments[0]?.nodes ?? [])].reverse();
    return last.length > 1 ? last.at(-2) : null;
  }

  /**
   * A turn at the end of a line: from `fromNode` (not back the way it came),
   * round to `through` — the stop's other side, when it has one — then on to
   * `toNode`, the next stop. See `RoadIndex.turnaround`.
   * @returns {{points:number[][], nodes:number[], lengthM:number}|null}
   */
  turnSegment(line, fromNode, avoidFirst, through, toNode, viaNode = null) {
    // After turning round: the stop's other side (if it has one), the
    // segment's dragged via (if any), then the next stop.
    const after = [...(through !== fromNode && through !== toNode ? [through] : []),
      ...(viaNode !== null ? [viaNode] : []), toNode];
    const first = this.roadIndex.turnaround(fromNode, avoidFirst, after[0], line.mode);
    if (!first) return null;
    let nodes = first.nodes;
    let lengthM = first.lengthM;
    if (after.length > 1) {
      const rest = this.roadPath(after, line.mode, nodes.length > 1 ? nodes.at(-2) : null);
      if (!rest) return null;
      nodes = [...nodes, ...rest.nodes.slice(1)];
      lengthM += rest.lengthM;
    }
    return { points: this.roadIndex.polyline(nodes), nodes, lengthM };
  }

  /** The road node of a segment's dragged via, or null. */
  viaNodeOf(line, k) {
    const count = line.stops.length;
    const via = line.vias?.get(Network.viaKey(line.stops[k], line.stops[(k + 1) % count]));
    return via ? this.roadIndex.snap(via[0], via[1], line.mode)?.node ?? null : null;
  }

  /**
   * Switch a bus or tram line between double stops (both ways, every stop
   * serving both sides) and single stops (one way round, a loop). A loop that
   * single stops made is opened again on the way back; one the player closed
   * stays closed. Every vehicle runs the one way on a single-stop line.
   */
  setSingleSided(line, on) {
    if (isRail(line.mode) || Boolean(line.singleSided) === Boolean(on)) return;
    line.singleSided = Boolean(on);
    if (!on && line.autoLoop) { line.loop = false; line.autoLoop = false; }
    if (on) for (const vehicle of line.vehicles) vehicle.direction = 0;
    this.rebuildSegments(line);
    this.touch();
  }

  /**
   * After a stop is added: re-route a road line throughout, because the stop
   * that was its end is now in the middle, and on a divided road that can
   * change which side each direction calls at. Rail only needs its way back.
   */
  settleLine(line) {
    if (!isRail(line.mode) && this.rebuildSegments(line)) return;
    this.refreshBackSegments(line);
  }

  /**
   * Work out the way back for every segment of a bus or tram line, honouring
   * one-way streets. See `Line.backSegments`.
   */
  refreshBackSegments(line) {
    // Rail runs on two-way track; a single-stop line runs one way only.
    if (isRail(line.mode) || line.singleSided) { line.backSegments = null; return; }
    const count = line.stops.length;
    // The way back, hop by hop from the far end, leaving each stop forwards.
    let arrivedFrom = null;
    const back = new Array(line.segments.length).fill(null);
    for (let k = line.segments.length - 1; k >= 0; k--) {
      // The trip down begins by turning round beyond the last stop.
      if (k === line.segments.length - 1 && this.turnsAtEnds(line)) {
        const up = line.segments[k].nodes;
        const turn = this.turnSegment(line, this.stopNodeFor(line, count - 1, 0),
          up.length > 1 ? up.at(-2) : null, this.stopNodeFor(line, count - 1, 1),
          this.stopNodeFor(line, k, 1), this.viaNodeOf(line, k));
        if (turn) {
          back[k] = { ...turn, points: turn.points.slice().reverse(), back: true };
          arrivedFrom = turn.nodes.length > 1 ? turn.nodes.at(-2) : null;
          continue;
        }
      }
      back[k] = this.backSegmentFor(line, k, arrivedFrom);
      const travelled = back[k]?.nodes ?? [...(line.segments[k].nodes ?? [])].reverse();
      arrivedFrom = travelled.length > 1 ? travelled.at(-2) : null;
    }
    line.backSegments = back.some(Boolean) ? back : null;
  }

  /** The way back along segment k, or null when it is that segment reversed. */
  backSegmentFor(line, k, avoidFirst) {
    const count = line.stops.length;
    {
      const segment = line.segments[k];
      // Dedicated tram track runs both ways; so does a segment with no road path.
      if (segment.offRoad || !segment.nodes) return null;
      const start = this.stops.get(line.stops[k]);
      const end = this.stops.get(line.stops[(k + 1) % count]);
      if (!start || !end) return null;
      const via = this.viaFor(line, start, end);
      const viaNode = via ? this.roadIndex.snap(via[0], via[1], line.mode)?.node : undefined;
      // The way back calls at each stop from the side running its way.
      const from = this.stopNodeFor(line, (k + 1) % count, 1);
      const to = this.stopNodeFor(line, k, 1);
      const path = this.roadPath(
        [from, ...(viaNode !== undefined ? [viaNode] : []), to], line.mode, avoidFirst);
      if (!path) return null;
      const reversed = [...segment.nodes].reverse();
      if (path.nodes.length === reversed.length && path.nodes.every((n, i) => n === reversed[i])) {
        return null;
      }
      return {
        points: this.roadIndex.polyline(path.nodes).reverse(),
        nodes: path.nodes,
        lengthM: path.lengthM,
        back: true,
        ...(path.ignoresOneway ? { ignoresOneway: true } : {}),
      };
    }
  }

  /**
   * A road path through these nodes that obeys one-way streets — or, where
   * none exists, one that ignores them and says so. That happens where a
   * one-way street leads out of the region and the way round is outside it;
   * refusing the line there would be worse than a bus breaking the rule.
   * @returns {{nodes:number[], lengthM:number, ignoresOneway?:boolean}|null}
   */
  roadPath(nodes, mode, avoidFirst = null) {
    const legal = this.roadIndex.pathThrough(nodes, mode, { avoidFirst })
      // A stop at a dead end can only be left the way the bus came in.
      ?? (avoidFirst !== null ? this.roadIndex.pathThrough(nodes, mode) : null);
    if (legal) return legal;
    const any = this.roadIndex.pathThrough(nodes, mode, { ignoreOneway: true });
    return any && { ...any, ignoresOneway: true };
  }

  // ─── Track ────────────────────────────────────────────────────────────────

  /**
   * Work out what a piece of track would be, without building it.
   *
   * An end that joins existing track must meet that track's height, so the
   * junction is level; a free end sits wherever the grade rule wants it.
   *
   * @param {'metro'|'train'} mode
   * @param {Array<[number,number]>} control waypoints, lon/lat
   * @param {{trackId:string, index:number}|null} start
   * @param {{trackId:string, index:number}|null} end
   * @param {{start?:number|null, end?:number|null}} [pins] explicit end
   *   heights, overriding the junctions — used when rebuilding from a save
   */
  planTrack(mode, control, start = null, end = null, pins = null) {
    const startHeight = pins?.start ?? this.junctionHeight(start);
    const endHeight = pins?.end ?? this.junctionHeight(end);
    const built = buildRailTrack(control, this.region, this.frame, mode, {
      startHeight, endHeight, corridors: this.corridors,
    });
    return { ...built, pins: { start: startHeight, end: endHeight } };
  }

  /** Height of existing track at a junction, or null for a free end. */
  junctionHeight(junction) {
    if (!junction) return null;
    const track = this.tracks.get(junction.trackId);
    const height = track?.height[junction.index];
    return Number.isFinite(height) ? height : null;
  }

  /**
   * Nearest sample of existing track a new track of `mode` may join.
   * New metro track may join train track (metro vehicles run on both); new
   * train track may join only train track.
   */
  junctionAt(lon, lat, mode, maxDistM = BUILD.JUNCTION_SNAP_M) {
    const snapped = this.trackGraph.snap(lon, lat, mode, maxDistM);
    return snapped ? { trackId: snapped.trackId, index: snapped.index,
      lonLat: [snapped.lon, snapped.lat] } : null;
  }

  /** Add a planned track to the network. The caller has already paid. */
  addTrack(mode, control, start, end, built, cost) {
    const track = new Track(mode, control, start, end).apply(built);
    track.pins = built.pins;
    track.cost = cost;
    this.tracks.set(track.id, track);
    this._trackGraph = null;
    this.touch();
    return track;
  }

  /**
   * Remove a track, unless something still uses it.
   *
   * Tracks that were joined to it keep their geometry — their end heights are
   * stored — and simply become dead ends there.
   *
   * @returns {{ok:true}|{error:string}}
   */
  removeTrack(trackId) {
    if (!this.tracks.has(trackId)) return { error: 'nothingThere' };
    // Existing railways belong to someone else; the player only runs on them.
    if (this.tracks.get(trackId).osm) return { error: 'osmTrack' };
    const prefix = `${trackId}:`;
    const stationOnIt = [...this.stops.values()].some((stop) =>
      typeof stop.node === 'string' && stop.node.startsWith(prefix));
    const lineOnIt = [...this.lines.values()].some((line) =>
      line.segments.some((segment) => segment.onTrack && segment.tracks?.includes(trackId)));
    if (stationOnIt || lineOnIt) return { error: 'trackInUse' };

    this.tracks.delete(trackId);
    for (const other of this.tracks.values()) {
      if (other.start?.trackId === trackId) other.start = null;
      if (other.end?.trackId === trackId) other.end = null;
    }
    this._trackGraph = null;
    this.touch();
    return { ok: true };
  }

  /** Nearest track to a point, for selection and bulldozing. */
  trackNear(lon, lat, maxDistM) {
    let best = null;
    let bestDist = maxDistM;
    for (const track of this.tracks.values()) {
      for (const [pLon, pLat] of track.points) {
        const distance = this.frame.distance(lon, lat, pLon, pLat);
        if (distance < bestDist) { bestDist = distance; best = track; }
      }
    }
    return best;
  }

  /** May a line of this mode run on this track? Re-exported for the UI. */
  static canRunOn(lineMode, trackMode) { return canRunOn(lineMode, trackMode); }

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
