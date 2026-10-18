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

/** One key for a road edge, whichever way it is walked. */
const edgeKey = (a, b) => (a < b ? `${a}-${b}` : `${b}-${a}`);

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
   * @param {[number,number]|null} [heading] for a bus or tram stop, which way
   *   the traffic it serves travels — see `heading` below
   */
  constructor(mode, lon, lat, node, name, structure = 'atGrade', heading = null) {
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
    /**
     * A bus or tram stop stands on one side of the road, as in Cities:
     * Skylines, and vehicles call at it going that side's way: this is that
     * way, a unit vector in local metres. A stop for the other direction is
     * another stop, across the road. Null for stations, whose track runs
     * both ways.
     */
    this.heading = heading;
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
    /**
     * A metro or train line the player closed into a loop. Read `loop`
     * rather than this: a bus or tram line is always a loop.
     */
    this.closed = false;
    /**
     * One entry per segment between consecutive stops: the lon/lat polyline the
     * vehicle follows and its length. On a loop there is one more segment than
     * on an open line, closing the ring.
     * @type {Array<{points:number[][], lengthM:number}>}
     */
    this.segments = [];
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
     * road route (`RoadIndex.stopPath`'s vias). For a tram it pulls the segment
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

  /**
   * True when the line closes back on its first stop. A bus or tram line
   * always does, as in Cities: Skylines: from its last stop it heads back to
   * its first, so a line up a road and back down it is its stops up one side
   * and then down the other. A metro or train line runs out and back on its
   * two-way track unless the player closes it.
   */
  get loop() {
    return isRail(this.mode) ? this.closed : this.stops.length >= 2;
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
    const once = travel + this.stops.length * this.dwellS;
    return this.loop ? once : 2 * once;
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
   * Place a bus or tram stop on the road where it was clicked, on the side
   * that was clicked (see `RoadIndex.headingAt`).
   *
   * Clicking an existing stop on the same side reuses it, as in Mini Metro;
   * `reuseM` is how near counts. A stop across the road from an existing
   * one snaps to its node, so the two face each other.
   *
   * @returns {{stop: Stop, reused: boolean}|{error: string}}
   */
  addStop(lon, lat, mode, reuseM = BUILD.STOP_REUSE_M) {
    if (isRail(mode)) return this.addStation(lon, lat, mode);

    // On the road where it was clicked, not at the nearest node — which on a
    // main road can be a side street's (see RoadIndex.snapToRoad).
    const snapped = this.roadIndex.snapToRoad(lon, lat, mode);
    if (!snapped) return { error: 'tooFarFromRoad' };
    const heading = this.roadIndex.headingAt(snapped, lon, lat, mode);
    // Near the click, or near where it snapped to — a click by a junction
    // snaps a little way from it.
    const facing = (stop) => stop.heading[0] * heading[0] + stop.heading[1] * heading[1] > 0.7;
    const sameSide = this.stopNear(lon, lat, Math.max(reuseM, BUILD.STOP_REUSE_M), mode, facing)
      || this.stopNear(snapped.lon, snapped.lat, BUILD.STOP_REUSE_M, mode, facing);
    if (sameSide) return { stop: sameSide, reused: true };

    const node = this.roadIndex.nodeAt(snapped);
    const [stopLon, stopLat] = this.roadIndex.nodeLonLat(node);
    const stop = new Stop(mode, stopLon, stopLat, node, snapped.name || 'Stop', 'atGrade', heading);
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
   * street names (unnumbered). When both ends share a name — a closed
   * loop, or a line up and down one long road — it is that name and the
   * mode instead.
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
    if (line.closed || !last || first === last) return `${first} – ${mode}`;
    return `${first} ${words.to} ${last}`;
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
   * bus or tram, and which way it would face; a track sample for a station.
   * Null when nothing is in reach.
   * @returns {{node:number|string|null, lon:number, lat:number, structure:string,
   *            heading?:[number,number], snapped?:Object}|null}
   */
  snapStop(lon, lat, mode) {
    if (isRail(mode)) {
      const snapped = this.trackGraph.snap(lon, lat, mode, BUILD.STATION_SNAP_M);
      return snapped && { node: snapped.key, lon: snapped.lon, lat: snapped.lat, structure: snapped.kind };
    }
    // `node` is null where the stop would split a road; `snapped` makes it.
    const snapped = this.roadIndex.snapToRoad(lon, lat, mode);
    return snapped && { node: snapped.node, lon: snapped.lon, lat: snapped.lat, structure: 'atGrade',
      heading: this.roadIndex.headingAt(snapped, lon, lat, mode), snapped };
  }

  stopAtNode(node, mode) {
    for (const stop of this.stops.values()) {
      if (stop.node === node && stop.mode === mode) return stop;
    }
    return null;
  }

  /**
   * Nearest stop within `maxDistM`, of one mode or any, for click selection.
   * Two stops facing each other across a road stand at the same point, so
   * between those the side of the road the click is on decides.
   * @param {(stop: Stop) => boolean} [accept] only stops this accepts
   */
  stopNear(lon, lat, maxDistM = 30, mode = null, accept = null) {
    const [x, y] = this.frame.toLocal(lon, lat);
    let best = null;
    let bestScore = Infinity;
    for (const stop of this.stops.values()) {
      if ((mode && stop.mode !== mode) || (accept && !accept(stop))) continue;
      const distance = this.frame.distance(lon, lat, stop.lon, stop.lat);
      if (distance >= maxDistM) continue;
      let score = distance;
      if (stop.heading) {
        // The stop's side of the road: right of its heading for right-hand traffic.
        const [sx, sy] = this.frame.toLocal(stop.lon, stop.lat);
        const right = (x - sx) * stop.heading[1] - (y - sy) * stop.heading[0];
        if ((right >= 0) !== BUILD.RIGHT_HAND_TRAFFIC) score += 1;
      }
      if (score < bestScore) { bestScore = score; best = stop; }
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
   * Append a stop to a line's end. A bus or tram line re-routes its way back
   * to the first stop from the new end; for a metro or train line, clicking
   * its own first stop closes it into a loop instead.
   *
   * @returns {{ok: true}|{error: string}}
   */
  extendLine(line, stop) {
    if (line.closed) return { error: 'lineIsLoop' };
    if (isRail(line.mode) && line.stops.length >= 3 && stop.id === line.stops[0]) {
      line.closed = true;
      if (!this.rebuildSegments(line)) { line.closed = false; this.rebuildSegments(line); return { error: 'noTrackPath' }; }
      this.touch();
      return { ok: true };
    }
    return this.insertStop(line, stop, line.stops.length - 1);
  }

  /** Drop a stop out of one line, reconnecting its neighbours. */
  removeStopFromLine(line, stopId) {
    const index = line.stops.indexOf(stopId);
    if (index === -1) return;

    line.stops.splice(index, 1);
    const stop = this.stops.get(stopId);
    if (stop) stop.lines = stop.lines.filter((id) => id !== line.id);

    // A closed metro or train loop needs three stops.
    if (line.stops.length < 3) line.closed = false;
    this.rebuildSegments(line);
    this.touch();
  }

  /**
   * Put a stop into a line after stop `afterIndex` (-1 for the very start),
   * and re-route the line. Refused, and the line left as it was, when the
   * roads or track cannot serve the new order.
   * @returns {{ok: true}|{error: string}}
   */
  insertStop(line, stop, afterIndex) {
    if (line.stops.includes(stop.id)) return { error: 'alreadyOnLine' };
    line.stops.splice(afterIndex + 1, 0, stop.id);
    if (!stop.lines.includes(line.id)) stop.lines.push(line.id);
    if (!this.rebuildSegments(line)) {
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
   *   - **No via** — the best legal way along roads the mode may use, from
   *     the side of the road one stop stands on to the side the next stands
   *     on, never turning round in the road (`RoadIndex.stopPath`). This is
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
  routeBetween(line, from, to) {
    // Metro and train never touch the roads: their stations sit on track, and
    // the path between them is the shortest on track their vehicles may use.
    if (isRail(line.mode)) {
      const path = this.trackGraph.path(from.node, to.node, line.mode);
      return path ? { ...path, onTrack: true } : null;
    }

    const via = this.viaFor(line, from, to);

    if (via && line.mode === 'tram' && this.region) {
      // A segment that cannot be built is not silently replaced by a road
      // route — the player dragged it there deliberately and needs to see it
      // refused. `blocked` carries the reason to the preview and the panel.
      return buildTrack(
        [this.roadIndex.nodeLonLat(from.node), via, this.roadIndex.nodeLonLat(to.node)],
        this.region, this.frame, line.mode);
    }

    // A drag that landed somewhere unroutable is simply ignored.
    const viaNode = via ? this.roadIndex.snap(via[0], via[1], line.mode)?.node : undefined;
    const vias = viaNode === undefined ? [] : [viaNode];
    const asSegment = (path) => ({
      points: this.roadIndex.polyline(path.nodes), nodes: path.nodes, lengthM: path.lengthM,
    });
    const path = this.roadIndex.stopPath(from.node, from.heading, to.node, to.heading, line.mode, vias);
    if (path) return asSegment(path);
    // No legal way at all — a one-way street leading out of the region, say.
    // Breaking the rule beats refusing the line.
    const nodes = [from.node, ...vias, to.node];
    const any = this.roadIndex.pathThrough(nodes, line.mode, { ignoreOneway: true });
    if (any) return { ...asSegment(any), ignoresOneway: true };
    // A tram that could only get there up a street too steep for it: the
    // way it would have gone, refused (see `blockedError`).
    const steep = line.mode === 'tram'
      && this.roadIndex.pathThrough(nodes, line.mode, { ignoreOneway: true, ignoreGrade: true });
    return steep ? { ...asSegment(steep), blocked: true, streetTooSteep: true } : null;
  }

  /**
   * What a line's track costs to build.
   *
   * A bus pays nothing: it drives on roads that already exist. A tram pays the
   * cheap on-street rate along its road-following segments — once per
   * street, however many times the line runs along it — and the structure
   * rate for any segment the player dragged off the road.
   */
  trackCostOf(line) {
    // Rail track is bought with the Build track tool, before any line runs on
    // it, so drawing a line on it costs nothing more.
    if (isRail(line.mode) || !COSTS.TRACK_PER_KM[line.mode]) return 0;
    let total = 0;
    let onStreetM = 0;
    const laid = new Set();
    for (const segment of line.segments) {
      if (segment.offRoad) { total += segment.cost || 0; continue; }
      if (!segment.nodes) { onStreetM += segment.lengthM; continue; }
      for (let i = 1; i < segment.nodes.length; i++) {
        const key = edgeKey(segment.nodes[i - 1], segment.nodes[i]);
        if (laid.has(key)) continue;
        laid.add(key);
        onStreetM += this.roadIndex.edgeBetween(segment.nodes[i - 1], segment.nodes[i])?.lengthM ?? 0;
      }
    }
    return Math.round(total + onStreetCost(onStreetM, line.mode));
  }

  /**
   * The segment of a line nearest a point, within `maxDistM`, and how far:
   * what a click there picks, and where a stop clicked there is inserted.
   * Where the line runs both ways along a street, the stretch going the way
   * such a stop would face (`heading`) wins.
   * @returns {{index:number, distance:number}|null}
   */
  segmentNear(line, lon, lat, maxDistM, heading = null) {
    const [x, y] = this.frame.toLocal(lon, lat);
    let best = null;
    let bestScore = Infinity;
    line.segments.forEach((segment, index) => {
      const points = segment.points.map(([pLon, pLat]) => this.frame.toLocal(pLon, pLat));
      for (let i = 1; i < points.length; i++) {
        const [ax, ay] = points[i - 1];
        const dx = points[i][0] - ax;
        const dy = points[i][1] - ay;
        const lengthSq = dx * dx + dy * dy;
        const t = lengthSq > 0 ? Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq)) : 0;
        const distance = Math.hypot(x - (ax + t * dx), y - (ay + t * dy));
        if (distance >= maxDistM) continue;
        const against = heading && dx * heading[0] + dy * heading[1] < 0;
        const score = distance + (against ? maxDistM : 0);
        if (score < bestScore) { bestScore = score; best = { index, distance }; }
      }
    });
    return best;
  }

  /** True when any segment is blocked — by a building, or too steep to build. */
  hasBlockedSegment(line) {
    return line.segments.some((segment) => segment.blocked);
  }

  /** Why a line's blocked segment is refused, as an error code, or null. */
  blockedError(line) {
    const segment = line.segments.find((s) => s.blocked);
    if (!segment) return null;
    return segment.streetTooSteep ? 'tramTooSteep' : segment.tooSteep ? 'tooSteep' : 'blockedByBuilding';
  }

  /**
   * Route every segment of a line from its stops: each stop to the next,
   * and on a loop the last back to the first.
   * @returns {boolean} false when some segment has no route
   */
  rebuildSegments(line) {
    const count = line.stops.length;
    const segments = [];
    for (let i = 0; i < (line.loop ? count : count - 1); i++) {
      const segment = this.routeBetween(line,
        this.stops.get(line.stops[i]), this.stops.get(line.stops[(i + 1) % count]));
      if (!segment) return false;
      segments.push(segment);
    }
    line.segments = segments;
    return true;
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
