/**
 * The game: one object holding every piece of live state, and the fixed-step
 * loop that advances it.
 *
 * Everything the UI and the renderer need hangs off here, so there is exactly
 * one thing to pass around and exactly one thing to serialise.
 */

import {
  CLOCK, COSTS, MODES, BUILD, passengersPerDot, baselineResidents,
} from '../config.js';
import { LocalFrame } from '../model/region.js';
import { Network, Stop, Line, Track, reserveIds } from '../model/network.js';
import { RoadIndex } from '../build/road-routing.js';
import { buildTrack, onStreetCost } from '../build/track-geometry.js';
import { osmRailTracks } from '../build/osm-rail.js';
import { Clock } from './clock.js';
import { DemandModel } from './demand.js';
import { Router, stopOrder } from './routing.js';
import { Vehicle, stepVehicle, respaceVehicles } from './vehicles.js';
import { stepPassengers, spawnDots, revalidateDots } from './passengers.js';
import { Economy } from './economy.js';
import { stepIntercity } from './intercity.js';

export class Game {
  /** @param {import('../model/region.js').Region} region */
  constructor(region) {
    this.region = region;
    this.frame = new LocalFrame(region.meta.bbox);
    this.difficulty = region.meta.difficulty || 'normal';

    this.roadIndex = new RoadIndex(region.roads, this.frame);
    this.network = new Network(this.roadIndex, this.frame, region);
    // Existing railways are ready-made train track from the start (Phase 6).
    this.network.addOsmRail(osmRailTracks(region, this.frame));
    this.clock = new Clock();
    this.router = new Router(this.network);
    this.demand = new DemandModel(region, this.frame, this.network);
    /**
     * Passengers one dot stands for, scaled to the region and fixed for the
     * whole game. Every dot↔people conversion reads this; nothing hardcodes 10.
     */
    // Both fixed at the start from the year-round population the profile
    // implies, not the raw building count: Kiato's buildings come to ~50,000
    // residents as Urban and ~18,000 as Countryside, and it is capitalised
    // and dotted accordingly.
    this.passengersPerDot = passengersPerDot(baselineResidents(region.meta));
    this.economy = new Economy(this.difficulty, baselineResidents(region.meta),
      this.passengersPerDot);

    /** Whether the Flows layer is drawn. A view setting, never saved. */
    this.showFlows = false;
    /** Currently selected object (stop or line), for the right-hand panel. */
    this.selection = null;
    /** In-progress line drawing: { line, cursor, spot } — `spot` where the next stop would go. */
    this.draft = null;
    /**
     * In-progress segment drag: { line, fromId, toId, via, preview }.
     * `preview` is the segment the drag *would* produce — costed and checked
     * but not paid for — so the overlay can show it and the player can see a
     * blocked stretch before committing.
     */
    this.drag = null;
    /** A stop being dragged with Edit stops: { stop, cursor, preview }. */
    this.stopDrag = null;
    /**
     * Where a click would insert a stop into the selected line:
     * { line, lon, lat, heading, afterIndex }, or null. See `insertionAt`.
     */
    this.insertHover = null;
    /**
     * In-progress track: { mode, control, start, end, cursor, preview }.
     * `preview` is the track as it would be built with the cursor as the next
     * waypoint — structures, profile, cost and anything blocking it — which is
     * what the overlay and the height-profile strip draw.
     */
    this.trackDraft = null;
    /** Set when the network changed and dots need revalidating. */
    this.networkDirty = false;
    /**
     * Lifetime counters, in dots. Instantaneous state tells you how busy the
     * network is right now; these tell you whether it has ever worked at all,
     * which is what you want when a sparse network is empty at the moment you
     * happen to look.
     */
    this.totals = { spawned: 0, boarded: 0, arrived: 0, gaveUp: 0 };

    /** Listeners fired after each tick, for the HUD. */
    this.listeners = new Set();

    this.lastRealTime = 0;
    this.accumulator = 0;
  }

  onTick(callback) {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /**
   * Mark the network changed; the next tick repairs routes and rebuilds.
   *
   * It bumps the network's version too, because the router and the demand
   * table rebuild on that alone. Buying a line its first vehicle changes no
   * stop or segment, yet it is what makes the line's stops served: without
   * the bump, a line drawn while the game ticked kept the table built for it
   * vehicle-less, and nobody ever wanted to ride it (Alex, Oct 17 2026).
   */
  invalidate() {
    this.networkDirty = true;
    this.network.touch();
  }

  /**
   * Advance the game by real elapsed time, in fixed steps.
   *
   * A fixed timestep keeps movement reproducible regardless of frame rate, and
   * stops a hitch from teleporting every vehicle. The backlog is capped so
   * returning to a backgrounded tab does not try to simulate the whole gap.
   *
   * @param {number} realSeconds
   */
  advance(realSeconds) {
    const step = CLOCK.TICK_MS / 1000;
    this.accumulator = Math.min(this.accumulator + realSeconds, 1.0);

    while (this.accumulator >= step) {
      this.accumulator -= step;
      this.tick(step);
    }
    for (const listener of this.listeners) listener(this);
  }

  /** One fixed step. */
  tick(realSeconds) {
    if (this.economy.gameOver) return;

    const simSeconds = this.clock.advance(realSeconds);

    if (this.networkDirty) {
      this.networkDirty = false;
      this.router.refreshIfNeeded();
      revalidateDots(this);
    }

    // Rebuilds are cheap to ask for and almost always no-ops.
    this.router.refreshIfNeeded();
    this.demand.refreshIfNeeded(this.clock, this.economy.fareMultiplier);

    if (simSeconds > 0) {
      for (const line of this.network.lines.values()) {
        if (line.segments.length === 0) continue;
        for (const vehicle of line.vehicles) {
          stepVehicle(vehicle, line, simSeconds, this.frame);
        }
      }

      this.totals.spawned += spawnDots(this, simSeconds);
      stepIntercity(this, simSeconds);
      const stats = stepPassengers(this, simSeconds);
      this.totals.boarded += stats.boarded;
      this.totals.arrived += stats.arrived;
      this.totals.gaveUp += stats.gaveUp;
      this.economy.recordTick(stats);
    }

    if (this.clock.dayTicked) {
      this.economy.endDay(this.network, this.demand.coverageFraction(),
        this.region.meta.hasOsmRail);
      this.demand.recoverDaily();

      // Roll each line's daily ridership so the panel has a stable figure.
      for (const line of this.network.lines.values()) {
        line.ridersPerDay = line.ridersToday * this.passengersPerDot * CLOCK.DAILY_SCALE;
        line.ridersToday = 0;
      }
    }
    if (this.clock.monthTicked) this.economy.endMonth();
  }

  // ─── Player actions ───────────────────────────────────────────────────────

  /**
   * Place a stop for a mode, charging for it. A click within `reuseM` of a
   * stop on the same side of the road reuses that stop.
   * @returns {{stop:object, reused:boolean}|{error:string}}
   */
  placeStop(lon, lat, mode, reuseM) {
    const result = this.network.addStop(lon, lat, mode, reuseM);
    if (result.error) return result;
    if (result.reused) return result;

    const cost = result.stop.cost;
    if (!this.economy.spend(cost, 'construction')) {
      this.network.stops.delete(result.stop.id);
      this.network.recomputeInterchanges();
      return { error: 'cannotAfford' };
    }
    this.invalidate();
    return result;
  }

  /** Start a new line in a mode. */
  startLine(mode) {
    const line = this.network.createLine(mode);
    this.draft = { line, cursor: null, spot: null };
    return line;
  }

  /**
   * Add a stop to the end of the line being drawn. Clicking the line's first
   * stop again finishes it, as in Cities: Skylines — a bus or tram line
   * heads back there anyway, and a metro or train line is closed into a loop.
   * @returns {{ok:true, stop?:object, finished?:boolean}|{error:string}}
   */
  extendDraft(lon, lat, reuseM) {
    if (!this.draft) return { error: 'noDraft' };
    const line = this.draft.line;
    const placed = this.placeStop(lon, lat, line.mode, reuseM);
    if (placed.error) return placed;

    if (placed.stop.id === line.stops[0] && line.stops.length >= 2) {
      if (line.mode === 'metro' || line.mode === 'train') {
        const closed = this.network.extendLine(line, placed.stop);
        if (closed.error) return closed;
      }
      this.finishDraft();
      return { ok: true, finished: true };
    }
    return this.addStopToLine(line, placed, line.stops.length - 1);
  }

  /**
   * Where a click beside a line would insert a stop into it — Line / Stops,
   * with the line selected, as in Cities: Skylines: the stop a click here
   * would place, and which stretch of the line it would go into. Null when
   * the point is not within `reachM` of the line or of a road.
   * @returns {{line:object, lon:number, lat:number, heading?:number[], afterIndex:number}|null}
   */
  insertionAt(line, lon, lat, reachM) {
    const spot = this.network.snapStop(lon, lat, line.mode);
    if (!spot) return null;
    const near = this.network.segmentNear(line, lon, lat, reachM, spot.heading);
    if (!near) return null;
    return { line, lon: spot.lon, lat: spot.lat, heading: spot.heading, afterIndex: near.index };
  }

  /** Insert a stop into a line where it was clicked beside it. See `insertionAt`. */
  insertStopAt(line, lon, lat, reachM) {
    const where = this.insertionAt(line, lon, lat, reachM);
    if (!where) return { error: 'notNearLine' };
    const placed = this.placeStop(lon, lat, line.mode);
    if (placed.error) return placed;
    return this.addStopToLine(line, placed, where.afterIndex);
  }

  /**
   * Put a placed stop into a line after stop `afterIndex`, paying for any
   * tram track the new route needs. A bus rides on roads that already exist
   * and pays nothing here. Anything refused gives the stop back.
   */
  addStopToLine(line, placed, afterIndex) {
    const before = this.network.trackCostOf(line);
    const result = this.network.insertStop(line, placed.stop, afterIndex);
    if (result.error) {
      this.refundStop(placed);
      return result;
    }
    const owed = this.network.trackCostOf(line) - before;
    if (owed > 0 && !this.economy.spend(owed, 'construction')) {
      this.network.removeStopFromLine(line, placed.stop.id);
      this.refundStop(placed);
      return { error: 'cannotAfford' };
    }
    line.trackCost += Math.max(0, owed);
    if (line.vehicles.length > 0) respaceVehicles(line);
    this.invalidate();
    return { ok: true, stop: placed.stop };
  }

  /**
   * Undo a `placeStop` that a later step rejected.
   *
   * Only a stop we actually created and paid for is removed — reusing an
   * existing stop costs nothing and deleting it would take it away from the
   * lines already calling there.
   */
  refundStop(placed) {
    if (!placed?.stop || placed.reused) return;
    if (placed.stop.lines.length > 0) return;
    this.economy.refund(placed.stop.cost);
    this.network.removeStop(placed.stop.id);
  }

  /**
   * Drag a segment off its default route.
   *
   * For a bus the via forces a different road route; for a tram it pulls the
   * segment off the road into dedicated track. Either way the line is rebuilt
   * and the cost difference settled — and if the result cannot be built or
   * cannot be afforded, the drag is rolled back so the player never ends up
   * with a line they cannot run.
   *
   * @param {Object} line
   * @param {string} fromStopId
   * @param {string} toStopId
   * @param {[number,number]|null} via lon/lat, or null to clear the drag
   * @returns {{ok:true, cost:number}|{error:string}}
   */
  setVia(line, fromStopId, toStopId, via) {
    const key = `${fromStopId}>${toStopId}`;
    const previous = line.vias.get(key) || null;
    const before = this.network.trackCostOf(line);

    if (via) line.vias.set(key, via); else line.vias.delete(key);
    if (!this.network.rebuildSegments(line)) {
      this.restoreVia(line, key, previous);
      return { error: 'noRoadPath' };
    }
    if (this.network.hasBlockedSegment(line)) {
      const reason = line.segments.find((segment) => segment.blocked);
      this.restoreVia(line, key, previous);
      return { error: reason?.tooSteep ? 'tooSteep' : 'blockedByBuilding' };
    }

    const owed = this.network.trackCostOf(line) - before;
    if (owed > 0 && !this.economy.spend(owed, 'construction')) {
      this.restoreVia(line, key, previous);
      return { error: 'cannotAfford' };
    }
    // A drag that makes the line cheaper gives back the usual half, because
    // the track it replaced has been torn up like anything else.
    if (owed < 0) this.economy.refund(-owed);
    line.trackCost = Math.max(0, line.trackCost + owed);

    this.network.touch();
    this.invalidate();
    return { ok: true, cost: owed };
  }

  /**
   * What a drag would produce, without committing or charging anything.
   *
   * Mirrors `Network.routeBetween` exactly, so the preview the player is
   * looking at is the segment they will get.
   *
   * @returns {{points:number[][], lengthM:number, blocked?:boolean,
   *            kinds?:string[], cost?:number, offRoad?:boolean}|null}
   */
  previewVia(line, fromStopId, toStopId, via) {
    const from = this.network.stops.get(fromStopId);
    const to = this.network.stops.get(toStopId);
    if (!from || !to) return null;
    // Routed exactly as it would be, with the via in place for a moment.
    const key = Network.viaKey(fromStopId, toStopId);
    const previous = line.vias.get(key);
    if (via) line.vias.set(key, via); else line.vias.delete(key);
    const segment = this.network.routeBetween(line, from, to);
    if (previous) line.vias.set(key, previous); else line.vias.delete(key);
    return segment;
  }

  /**
   * What committing the current drag would cost, over what the segment costs
   * now. Shown live so the player is never surprised by the bill.
   */
  dragCostDelta(line, fromStopId, toStopId, preview) {
    if (!preview || !COSTS.TRACK_PER_KM[line.mode]) return 0;
    const current = line.segments[this.segmentIndexFor(line, fromStopId, toStopId)];
    const costOf = (segment) => !segment ? 0
      : segment.offRoad ? (segment.cost || 0) : onStreetCost(segment.lengthM, line.mode);
    return Math.round(costOf(preview) - costOf(current));
  }

  /** Which segment of a line joins these two stops, or -1. */
  segmentIndexFor(line, fromStopId, toStopId) {
    for (let i = 0; i < line.stops.length; i++) {
      const next = line.stops[(i + 1) % line.stops.length];
      if (line.stops[i] === fromStopId && next === toStopId) {
        if (i < line.stops.length - 1 || line.loop) return i;
      }
    }
    return -1;
  }

  /** Put a via back as it was and rebuild, after a rejected drag. */
  restoreVia(line, key, previous) {
    if (previous) line.vias.set(key, previous); else line.vias.delete(key);
    this.network.rebuildSegments(line);
  }

  /**
   * Where a stop being dragged would land, for the preview. Null where it
   * cannot go.
   */
  previewStopMove(stop, lon, lat) {
    const snapped = this.network.snapStop(lon, lat, stop.mode);
    if (!snapped) return null;
    // Taken: a station already there, or a stop already on that side of the road.
    const sameSide = (other) => !snapped.heading
      || other.heading[0] * snapped.heading[0] + other.heading[1] * snapped.heading[1] > 0.7;
    const taken = (snapped.heading ? null : this.network.stopAtNode(snapped.node, stop.mode))
      || [...this.network.stops.values()].find((other) => other !== stop && other.mode === stop.mode
        && sameSide(other)
        && this.frame.distance(other.lon, other.lat, snapped.lon, snapped.lat) < BUILD.STOP_REUSE_M);
    return { ...snapped, valid: !taken || taken === stop };
  }

  /**
   * Move a stop: Edit stops, press on a stop and drag it.
   *
   * The stop re-snaps to a road (bus, tram) or to track (metro, train), every
   * line through it is re-routed, and the difference is settled — tram track
   * gained or given up, and for a station the price of the structure under it
   * (moving onto a viaduct costs more). Anything that cannot be routed or
   * paid for puts everything back as it was.
   *
   * @returns {{ok:true, cost:number}|{error:string}}
   */
  moveStop(stop, lon, lat) {
    const target = this.previewStopMove(stop, lon, lat);
    if (!target) return { error: stop.mode === 'metro' || stop.mode === 'train' ? 'tooFarFromTrack' : 'tooFarFromRoad' };
    if (!target.valid) return { error: 'stopThere' };
    const turned = target.heading && target.heading[0] * stop.heading[0] + target.heading[1] * stop.heading[1] < 0;
    if (target.node === stop.node && !turned) return { ok: true, cost: 0 };
    // Dropped part-way along a road: the road gets a node there.
    if (target.node === null) {
      target.node = this.roadIndex.nodeAt(target.snapped);
      [target.lon, target.lat] = this.roadIndex.nodeLonLat(target.node);
    }

    const lines = stop.lines.map((id) => this.network.lines.get(id)).filter(Boolean);
    const old = { lon: stop.lon, lat: stop.lat, node: stop.node, structure: stop.structure, heading: stop.heading };
    const oldCost = stop.cost;
    const trackBefore = lines.map((line) => this.network.trackCostOf(line));

    const put = (place) => {
      Object.assign(stop, place);
      for (const line of lines) this.network.rebuildSegments(line);
    };
    const restore = (error) => {
      put(old);
      this.network.recomputeInterchanges();
      this.network.touch();
      return { error };
    };

    Object.assign(stop, { lon: target.lon, lat: target.lat, node: target.node, structure: target.structure,
      heading: target.heading ?? null });
    for (const line of lines) {
      if (!this.network.rebuildSegments(line)) {
        return restore(stop.mode === 'metro' || stop.mode === 'train' ? 'noTrackPath' : 'noRoadPath');
      }
      if (this.network.hasBlockedSegment(line)) {
        const reason = line.segments.find((segment) => segment.blocked);
        return restore(reason?.tooSteep ? 'tooSteep' : 'blockedByBuilding');
      }
    }

    const trackOwed = lines.reduce((sum, line, i) =>
      sum + this.network.trackCostOf(line) - trackBefore[i], 0);
    const owed = trackOwed + stop.cost - oldCost;
    if (owed > 0 && !this.economy.spend(owed, 'construction')) return restore('cannotAfford');
    if (owed < 0) this.economy.refund(-owed);
    lines.forEach((line, i) => {
      line.trackCost = Math.max(0, line.trackCost + this.network.trackCostOf(line) - trackBefore[i]);
    });

    this.network.recomputeInterchanges();
    this.network.touch();
    this.invalidate();
    return { ok: true, cost: owed };
  }

  /**
   * Take back the last stop added to the line being drawn. Backspace and
   * the Undo button.
   * Track is settled and a stop nothing else uses is refunded, so undoing a
   * mistake costs nothing.
   * @returns {{ok:true}|{error:string}}
   */
  undoDraftStop() {
    const line = this.draft?.line;
    if (!line || line.stops.length === 0) return { error: 'nothingToUndo' };
    const before = this.network.trackCostOf(line);

    const stopId = line.stops.at(-1);
    this.network.removeStopFromLine(line, stopId);

    // Undo gives back what that step cost in full, track and stop alike:
    // taking back a mis-click should be free, unlike bulldozing.
    const owed = this.network.trackCostOf(line) - before;
    if (owed < 0) this.economy.credit('construction', -owed);
    line.trackCost = Math.max(0, line.trackCost + Math.min(0, owed));

    const stop = this.network.stops.get(stopId);
    if (stop && stop.lines.length === 0) {
      // Bought for this line a moment ago, so it is given back in full.
      this.economy.credit('construction', stop.cost);
      this.network.removeStop(stopId);
    }
    this.invalidate();
    return { ok: true };
  }

  /**
   * Throw away the line being drawn — the Cancel button. Every step is
   * undone, so the stops and track placed for it are given back in full;
   * stops it shares with other lines stay. (Esc and changing tool keep what
   * was drawn so far, as in Mini Metro.)
   */
  discardDraft() {
    if (!this.draft) return;
    while (this.draft.line.stops.length > 0) {
      if (this.undoDraftStop().error) break;
    }
    const line = this.draft.line;
    this.draft = null;
    this.network.deleteLine(line.id);
    this.invalidate();
  }

  /** Finish drawing. A line with fewer than two stops is discarded. */
  finishDraft() {
    if (!this.draft) return;
    const line = this.draft.line;
    this.draft = null;
    if (line.stops.length < 2) {
      this.network.deleteLine(line.id);
    } else if (line.vehicles.length === 0) {
      // A line with no vehicles carries nobody, so give it one to start with
      // if it can be afforded — otherwise the player sees nothing happen.
      this.addVehicle(line);
    }
    this.invalidate();
    return line;
  }

  // ─── Building track ───────────────────────────────────────────────────────

  /** Start drawing metro or train track. Nothing is built until it is finished. */
  startTrack(mode) {
    this.trackDraft = { mode, control: [], start: null, end: null, cursor: null, preview: null };
    return this.trackDraft;
  }

  /**
   * A Build track click: a waypoint, or a junction with existing track.
   *
   * The first click joins existing track if it lands on some; otherwise the
   * track starts with a free end. A later click on existing track ends the
   * track there, as a junction, and finishes it — the way closing a loop
   * finishes a line in Mini Metro. If that track cannot be built, the
   * junction is taken back off so the player can reroute.
   *
   * @param {number} [snapM] how near existing track a click must be to join it
   * @returns {{ok:true, finished?:boolean, track?:Track, cost?:number}|{error:string}}
   */
  addTrackPoint(lon, lat, snapM = BUILD.JUNCTION_SNAP_M) {
    const draft = this.trackDraft;
    if (!draft) return { error: 'noDraft' };
    const junction = this.network.junctionAt(lon, lat, draft.mode, snapM);

    if (draft.control.length === 0) {
      draft.control.push(junction ? junction.lonLat : [lon, lat]);
      draft.start = junction ? { trackId: junction.trackId, index: junction.index } : null;
      return { ok: true };
    }

    const point = this.endJunction(draft, junction) ? junction.lonLat : [lon, lat];
    const last = draft.control.at(-1);
    if (this.frame.distance(last[0], last[1], point[0], point[1]) < BUILD.WAYPOINT_MIN_M) {
      return { ok: true }; // the first half of a double-click
    }

    draft.control.push(point);
    if (!this.endJunction(draft, junction)) return { ok: true };

    draft.end = { trackId: junction.trackId, index: junction.index };
    const result = this.finishTrack();
    if (result.error) { draft.control.pop(); draft.end = null; }
    return { ...result, finished: !result.error };
  }

  /**
   * Does this junction end the draft? Not when it is the track the draft
   * started from, close to where it started: drawing away from a track, the
   * first waypoint or two are inevitably still near it, and finishing the
   * moment the player clicked would leave a stub they never meant.
   */
  endJunction(draft, junction) {
    if (!junction) return false;
    if (!draft.start || junction.trackId !== draft.start.trackId) return true;
    const [startLon, startLat] = draft.control[0];
    return this.frame.distance(startLon, startLat, junction.lonLat[0], junction.lonLat[1])
      > 3 * BUILD.JUNCTION_SNAP_M;
  }

  /**
   * Preview the draft with the cursor as its next waypoint, for the overlay
   * and the profile strip. Costs and checks everything, builds nothing.
   */
  previewTrack(lon, lat, snapM = BUILD.JUNCTION_SNAP_M) {
    const draft = this.trackDraft;
    if (!draft || draft.control.length === 0) return null;
    const junction = this.network.junctionAt(lon, lat, draft.mode, snapM);
    const atJunction = this.endJunction(draft, junction);
    draft.cursor = atJunction ? junction.lonLat : [lon, lat];
    draft.preview = this.network.planTrack(draft.mode, [...draft.control, draft.cursor],
      draft.start, atJunction ? { trackId: junction.trackId, index: junction.index } : null);
    draft.preview.joins = atJunction;
    return draft.preview;
  }

  /** Take back the last waypoint, so a blocked stretch can be redrawn. */
  removeTrackPoint() {
    const draft = this.trackDraft;
    if (!draft || draft.control.length === 0) return;
    draft.control.pop();
    if (draft.control.length === 0) draft.start = null;
    draft.end = null;
    draft.preview = null;
  }

  /**
   * Build the drafted track, if it can be built and afforded.
   *
   * A blocked or unaffordable track is refused and the draft is KEPT, so the
   * player can reroute rather than start again — the spec's "cannot be
   * confirmed until the player reroutes it".
   *
   * @returns {{ok:true, track:Track, cost:number}|{error:string}|{cancelled:true}}
   */
  finishTrack() {
    const draft = this.trackDraft;
    if (!draft) return { error: 'noDraft' };
    if (draft.control.length < 2) {
      this.trackDraft = null;
      return { cancelled: true };
    }

    const built = this.network.planTrack(draft.mode, draft.control, draft.start, draft.end);
    if (built.blocked) return { error: built.reason === 'tooSteep' ? 'trackTooSteep' : built.reason };
    if (!this.economy.spend(built.cost, 'construction')) return { error: 'cannotAfford' };

    const track = this.network.addTrack(draft.mode, draft.control, draft.start, draft.end,
      built, built.cost);
    this.trackDraft = null;
    this.invalidate();
    return { ok: true, track, cost: built.cost };
  }

  cancelTrack() {
    this.trackDraft = null;
  }

  /**
   * Switch intercity service on or off at a station on existing rail. Free:
   * the trains belong to someone else, and the station is already paid for.
   * @returns {{ok:true, on:boolean}|{error:string}}
   */
  toggleIntercity(stop) {
    if (!stop || !this.network.onOsmRail(stop)) return { error: 'intercityNeedsRail' };
    stop.intercity = !stop.intercity;
    return { ok: true, on: stop.intercity };
  }

  /**
   * Set how many people a dot stands for, everywhere that converts between
   * the two. Only ever called at the start of a game or when loading one: a
   * dot that changed meaning mid-game would make every count on screen lie.
   */
  setDotSize(people) {
    this.passengersPerDot = people;
    this.demand.passengersPerDot = people;
    this.economy.passengersPerDot = people;
    for (const line of this.network.lines.values()) {
      for (const vehicle of line.vehicles) vehicle.dotSize = people;
    }
  }

  /** Buy a vehicle for a line. @returns {boolean} */
  addVehicle(line, direction = 0) {
    if (line.vehicles.length >= line.maxVehicles) return false;
    if (!this.economy.spend(COSTS.VEHICLE[line.mode], 'construction')) return false;
    // Round a metro or train loop either way; a bus or tram goes the way its stops face.
    const vehicle = new Vehicle(line, line.closed ? direction : 0);
    vehicle.dotSize = this.passengersPerDot;
    line.vehicles.push(vehicle);
    respaceVehicles(line);
    this.invalidate();
    return true;
  }

  /** Sell a vehicle, refunding half. */
  removeVehicle(line) {
    const vehicle = line.vehicles.pop();
    if (!vehicle) return false;
    // Anyone aboard is put back on the street rather than vanishing.
    const stop = this.network.stops.get(line.stops[0]);
    if (stop) {
      for (const dot of vehicle.passengers) {
        dot.atStopId = stop.id;
        dot.waitingSince = this.clock.simSeconds;
        stop.waiting.push(dot);
      }
    }
    this.economy.refund(COSTS.VEHICLE[line.mode]);
    respaceVehicles(line);
    this.invalidate();
    return true;
  }

  /**
   * Bulldoze a stop, a whole line or a piece of track, refunding half.
   * @returns {{ok:true}|{error:string}}
   */
  bulldoze(target) {
    if (!target) return { error: 'nothingThere' };
    if (target instanceof Track) {
      // Track still carrying a station or a line stays: tearing it out would
      // strand the line, and the player did not ask to remove that.
      const removed = this.network.removeTrack(target.id);
      if (removed.error) return removed;
      this.economy.refund(target.cost);
    } else if (target.stops !== undefined && target.segments !== undefined) {
      // A line: refund its vehicles, then delete it. Its stops stay, because
      // other lines may use them and the player did not ask to remove them.
      for (const vehicle of target.vehicles) this.economy.refund(COSTS.VEHICLE[target.mode]);
      // Track is refunded at the same rate as everything else; a bus line has
      // none, because it never built any.
      if (target.trackCost > 0) this.economy.refund(target.trackCost);
      this.network.deleteLine(target.id);
    } else {
      // A stop: taken out of every line through it, each line rejoined
      // around it, and then removed and refunded.
      for (const lineId of [...target.lines]) {
        const line = this.network.lines.get(lineId);
        if (line) this.removeStopFromLine(line, target.id);
      }
      if (this.network.stops.has(target.id)) {
        this.economy.refund(target.cost);
        this.network.removeStop(target.id);
      }
    }
    if (this.selection === target) this.selection = null;
    this.invalidate();
    return { ok: true };
  }

  /**
   * Take one stop out of one line and join its neighbours directly — the
   * Bulldoze tool's unit of work, a stop and the line up to the next one
   * (Alex, Oct 16 2026). It used to remove the whole line in one click.
   *
   * The line is settled: tram track it no longer needs is refunded at half,
   * track the new join needs is charged, a line left with one stop is
   * removed with its vehicles refunded, and a stop no line uses any more is
   * removed and refunded too.
   *
   * @returns {{ok:true, lineRemoved:boolean, stopRemoved:boolean}|{error:string}}
   */
  removeStopFromLine(line, stopId) {
    const index = line.stops.indexOf(stopId);
    if (index === -1) return { error: 'nothingThere' };
    const wasClosed = line.closed;
    const before = this.network.trackCostOf(line);
    this.network.removeStopFromLine(line, stopId);

    let lineRemoved = false;
    /** Stops that may have been left with no line, to settle below. */
    const orphans = [stopId];
    if (line.stops.length < 2) {
      for (const vehicle of line.vehicles) this.economy.refund(COSTS.VEHICLE[line.mode]);
      if (line.trackCost > 0) this.economy.refund(line.trackCost);
      orphans.push(...line.stops);
      this.network.deleteLine(line.id);
      lineRemoved = true;
      if (this.selection === line) this.selection = null;
    } else {
      const owed = this.network.trackCostOf(line) - before;
      if (owed > 0 && !this.economy.spend(owed, 'construction')) {
        // The join around the stop needs track the player cannot pay for.
        line.closed = wasClosed;
        this.network.insertStop(line, this.network.stops.get(stopId), index - 1);
        return { error: 'cannotAfford' };
      }
      if (owed < 0) this.economy.refund(-owed);
      line.trackCost = Math.max(0, line.trackCost + owed);
      // Vehicles past the new end of the line are put back on it.
      for (const vehicle of line.vehicles) vehicle.hop = Math.min(vehicle.hop, line.stops.length - 2);
      respaceVehicles(line);
    }

    // A stop no line calls at any more goes too, refunded: the one taken
    // off, and the last stop of a line that has just been removed.
    let stopRemoved = false;
    for (const id of orphans) {
      const stop = this.network.stops.get(id);
      if (!stop || stop.lines.length > 0) continue;
      this.economy.refund(stop.cost);
      this.network.removeStop(id);
      if (id === stopId) stopRemoved = true;
      if (this.selection === stop) this.selection = null;
    }
    this.invalidate();
    return { ok: true, lineRemoved, stopRemoved };
  }

  // ─── Totals for the HUD ───────────────────────────────────────────────────

  get stats() {
    return {
      balance: this.economy.balance,
      transported: this.economy.transported,
      onNetwork: this.network.passengersOnNetwork * this.passengersPerDot,
      lastMonthNet: this.economy.lastMonthNet,
      negativeMonths: this.economy.negativeMonths,
      gameOver: this.economy.gameOver,
    };
  }

  // ─── Save and load ────────────────────────────────────────────────────────

  /**
   * A save holds the network, the clocks and the money — but NOT the region,
   * which is cached separately and is far larger. A save therefore references
   * its region by key and is small enough to e-mail.
   */
  toJSON(regionKey) {
    return {
      version: 1,
      regionKey,
      regionMeta: this.region.meta,
      difficulty: this.difficulty,
      clock: this.clock.toJSON(),
      economy: this.economy.toJSON(),
      demand: this.demand.toJSON(),
      // Track is saved as the player drew it — waypoints, junctions, end
      // heights and what was paid — and its geometry rebuilt on load, so a
      // save stays a few kilobytes however much track there is.
      // Existing railways are not saved: they are rebuilt from the region.
      tracks: [...this.network.tracks.values()].filter((track) => !track.osm).map((track) => ({
        id: track.id, mode: track.mode, control: track.control,
        start: track.start, end: track.end, pins: track.pins, cost: track.cost,
      })),
      stops: [...this.network.stops.values()].map((stop) => ({
        id: stop.id, mode: stop.mode, lon: stop.lon, lat: stop.lat,
        node: stop.node, name: stop.name, lines: stop.lines, structure: stop.structure,
        ...(stop.heading ? { heading: stop.heading } : {}),
        ...(stop.customName ? { customName: stop.customName } : {}),
        ...(stop.intercity || stop.intercityCalls ? {
          intercity: stop.intercity, intercityTimer: stop.intercityTimer,
          intercityCarry: stop.intercityCarry, intercityCalls: stop.intercityCalls,
        } : {}),
      })),
      lines: [...this.network.lines.values()].map((line) => ({
        id: line.id, mode: line.mode, color: line.color, stops: line.stops,
        loop: line.closed,
        name: line.name,
        skipEmptyStops: line.skipEmptyStops,
        keepSpacing: line.keepSpacing,
        // Segments are derived and not stored, but the drags that shape them
        // are the player's own decisions and have to survive a reload.
        vias: [...line.vias.entries()],
        trackCost: line.trackCost,
        vehicles: line.vehicles.map((vehicle) => ({
          id: vehicle.id, direction: vehicle.direction, hop: vehicle.hop,
          progress: vehicle.progress, dwellRemaining: vehicle.dwellRemaining,
        })),
      })),
    };
  }

  /**
   * Rebuild a game from a save and its region.
   *
   * Passengers are deliberately NOT saved. They are transient, they would
   * multiply the save size by a lot, and a network reloaded empty refills
   * within a few sim seconds. What must survive is the structure, the money
   * and the satisfaction history — which it does.
   */
  static fromJSON(data, region) {
    const game = new Game(region);
    game.difficulty = data.difficulty;
    game.clock = Clock.fromJSON(data.clock);
    game.economy = Economy.fromJSON(data.economy);
    game.demand.loadJSON(data.demand);
    // The dot keeps the size it had when the game began, even if the rule for
    // choosing it has changed since.
    game.setDotSize(game.economy.passengersPerDot);

    // Track first, in the order it was built, because lines route over it.
    for (const saved of data.tracks || []) {
      const built = game.network.planTrack(saved.mode, saved.control,
        saved.start, saved.end, saved.pins);
      const track = new Track(saved.mode, saved.control, saved.start, saved.end).apply(built);
      track.id = saved.id;
      track.pins = saved.pins;
      track.cost = saved.cost;
      game.network.tracks.set(track.id, track);
      game.network._trackGraph = null;
    }

    for (const saved of data.stops) {
      // A bus or tram stop may stand where the player split a road; the
      // region in the cache does not have that node, so find it again — or
      // make it again — from where the stop stands.
      // Saves from before stops had sides face the way the road was drawn.
      let node = saved.node;
      let heading = saved.heading ?? null;
      if (saved.mode === 'bus' || saved.mode === 'tram') {
        const snapped = game.roadIndex.snapToRoad(saved.lon, saved.lat, saved.mode, 5);
        if (snapped) {
          heading ??= game.roadIndex.headingAt(snapped, saved.lon, saved.lat, saved.mode);
          node = game.roadIndex.nodeAt(snapped);
        }
        heading ??= [1, 0];
      }
      const stop = new Stop(saved.mode, saved.lon, saved.lat, node, saved.name,
        saved.structure, heading);
      stop.id = saved.id;
      stop.lines = saved.lines;
      stop.customName = saved.customName || null;
      stop.intercity = Boolean(saved.intercity);
      stop.intercityTimer = saved.intercityTimer || 0;
      stop.intercityCarry = saved.intercityCarry || 0;
      stop.intercityCalls = saved.intercityCalls || 0;
      game.network.stops.set(stop.id, stop);
    }

    for (const saved of data.lines) {
      const line = new Line(saved.mode, saved.color);
      line.id = saved.id;
      line.stops = saved.stops;
      // Only a metro or train line is closed by the player; a bus or tram
      // line is always a loop, whatever an older save says.
      line.closed = Boolean(saved.loop) && (saved.mode === 'metro' || saved.mode === 'train');
      line.name = saved.name || null;
      // Saves from before these switches existed get the defaults.
      if (saved.skipEmptyStops !== undefined) line.skipEmptyStops = saved.skipEmptyStops;
      if (saved.keepSpacing !== undefined) line.keepSpacing = saved.keepSpacing;
      // Vias must be restored BEFORE the segments are rebuilt, or every
      // dragged segment silently snaps back to its default road route.
      line.vias = new Map(saved.vias || []);
      line.trackCost = saved.trackCost || 0;
      game.network.lines.set(line.id, line);
      // Segments are derived, so re-route them rather than storing polylines.
      game.network.rebuildSegments(line);

      for (const savedVehicle of saved.vehicles) {
        const vehicle = new Vehicle(line, savedVehicle.direction);
        vehicle.id = savedVehicle.id;
        vehicle.hop = savedVehicle.hop;
        vehicle.progress = savedVehicle.progress;
        vehicle.dwellRemaining = savedVehicle.dwellRemaining;
        vehicle.dotSize = game.passengersPerDot;
        line.vehicles.push(vehicle);
      }
      // A vehicle on a hop or a way round the line no longer has — from a
      // save older than bus and tram loops — starts again from its first stop.
      for (const vehicle of line.vehicles) {
        if (!line.closed && line.loop) vehicle.direction = 0;
        if (vehicle.hop < stopOrder(line, vehicle.direction).length - 1) continue;
        Object.assign(vehicle, { hop: 0, progress: 0, dwellRemaining: 0 });
      }
    }

    // Ids from the save must never be handed out again on this page.
    reserveIds([...data.stops.map((s) => s.id), ...data.lines.map((l) => l.id),
      ...(data.tracks || []).map((t) => t.id)]);

    game.network.recomputeInterchanges();
    game.network.touch();
    game.invalidate();
    return game;
  }
}

/** Cost of one vehicle, for the UI's +/- buttons. */
export function vehiclePrice(mode) {
  return COSTS.VEHICLE[mode];
}

/** Capacity of one vehicle, for the line panel. */
export function vehicleCapacity(mode) {
  return MODES[mode].capacity;
}
