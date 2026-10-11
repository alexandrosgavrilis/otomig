/**
 * The game: one object holding every piece of live state, and the fixed-step
 * loop that advances it.
 *
 * Everything the UI and the renderer need hangs off here, so there is exactly
 * one thing to pass around and exactly one thing to serialise.
 */

import { CLOCK, COSTS, MODES, passengersPerDot } from '../config.js';
import { LocalFrame } from '../model/region.js';
import { Network, Stop, Line } from '../model/network.js';
import { RoadIndex } from '../build/road-routing.js';
import { buildTrack, onStreetCost } from '../build/track-geometry.js';
import { Clock } from './clock.js';
import { DemandModel } from './demand.js';
import { Router } from './routing.js';
import { Vehicle, stepVehicle, respaceVehicles } from './vehicles.js';
import { stepPassengers, spawnDots, revalidateDots } from './passengers.js';
import { Economy } from './economy.js';

export class Game {
  /** @param {import('../model/region.js').Region} region */
  constructor(region) {
    this.region = region;
    this.frame = new LocalFrame(region.meta.bbox);
    this.difficulty = region.meta.difficulty || 'normal';

    this.roadIndex = new RoadIndex(region.roads, this.frame);
    this.network = new Network(this.roadIndex, this.frame, region);
    this.clock = new Clock();
    this.router = new Router(this.network);
    this.demand = new DemandModel(region, this.frame, this.network);
    /**
     * Passengers one dot stands for, scaled to the region and fixed for the
     * whole game. Every dot↔people conversion reads this; nothing hardcodes 10.
     */
    this.passengersPerDot = passengersPerDot(region.meta.populationTotal);
    this.economy = new Economy(this.difficulty, region.meta.populationTotal,
      this.passengersPerDot);

    /** Currently selected object (stop or line), for the right-hand panel. */
    this.selection = null;
    /** In-progress line drawing: { line, cursor, valid }. */
    this.draft = null;
    /**
     * In-progress segment drag: { line, fromId, toId, via, preview }.
     * `preview` is the segment the drag *would* produce — costed and checked
     * but not paid for — so the overlay can show it and the player can see a
     * blocked stretch before committing.
     */
    this.drag = null;
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

  /** Mark the network changed; the next tick repairs routes and rebuilds. */
  invalidate() {
    this.networkDirty = true;
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
   * Place a stop for a mode, charging for it.
   * @returns {{stop:object, reused:boolean}|{error:string}}
   */
  placeStop(lon, lat, mode) {
    const result = this.network.addStop(lon, lat, mode);
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
    this.draft = { line, cursor: null, valid: true };
    return line;
  }

  /** Add a stop to the line being drawn. */
  extendDraft(lon, lat) {
    if (!this.draft) return { error: 'noDraft' };
    const line = this.draft.line;
    const placed = this.placeStop(lon, lat, line.mode);
    if (placed.error) return placed;

    const before = this.network.trackCostOf(line);
    const result = this.network.extendLine(line, placed.stop);
    if (result.error) {
      this.refundStop(placed);
      return result;
    }

    // Tram track is bought with the segment. A bus rides on roads that already
    // exist and pays nothing here.
    const owed = this.network.trackCostOf(line) - before;
    if (owed > 0 && !this.economy.spend(owed, 'construction')) {
      this.network.removeStopFromLine(line, placed.stop.id);
      this.refundStop(placed);
      return { error: 'cannotAfford' };
    }
    line.trackCost += Math.max(0, owed);

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

    if (line.mode === 'tram' && via) {
      return buildTrack(
        [this.roadIndex.nodeLonLat(from.node), via, this.roadIndex.nodeLonLat(to.node)],
        this.region, this.frame, line.mode);
    }
    if (via) {
      const snapped = this.roadIndex.snap(via[0], via[1], line.mode);
      if (snapped) {
        const path = this.roadIndex.pathThrough([from.node, snapped.node, to.node], line.mode);
        if (path) {
          return { points: this.roadIndex.polyline(path.nodes), lengthM: path.lengthM };
        }
      }
    }
    const path = this.roadIndex.shortestPath(from.node, to.node, line.mode);
    return path
      ? { points: this.roadIndex.polyline(path.nodes), lengthM: path.lengthM }
      : null;
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

  /** Buy a vehicle for a line. @returns {boolean} */
  addVehicle(line, direction = 0) {
    if (line.vehicles.length >= line.maxVehicles) return false;
    if (!this.economy.spend(COSTS.VEHICLE[line.mode], 'construction')) return false;
    line.vehicles.push(new Vehicle(line, line.loop ? direction : 0));
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

  /** Bulldoze a stop or a whole line, refunding half. */
  bulldoze(target) {
    if (!target) return;
    if (target.stops !== undefined && target.segments !== undefined) {
      // A line: refund its vehicles, then delete it. Its stops stay, because
      // other lines may use them and the player did not ask to remove them.
      for (const vehicle of target.vehicles) this.economy.refund(COSTS.VEHICLE[target.mode]);
      // Track is refunded at the same rate as everything else; a bus line has
      // none, because it never built any.
      if (target.trackCost > 0) this.economy.refund(target.trackCost);
      this.network.deleteLine(target.id);
    } else {
      this.economy.refund(target.cost);
      this.network.removeStop(target.id);
    }
    if (this.selection === target) this.selection = null;
    this.invalidate();
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
      stops: [...this.network.stops.values()].map((stop) => ({
        id: stop.id, mode: stop.mode, lon: stop.lon, lat: stop.lat,
        node: stop.node, name: stop.name, lines: stop.lines,
      })),
      lines: [...this.network.lines.values()].map((line) => ({
        id: line.id, mode: line.mode, color: line.color, stops: line.stops,
        loop: line.loop,
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

    for (const saved of data.stops) {
      const stop = new Stop(saved.mode, saved.lon, saved.lat, saved.node, saved.name);
      stop.id = saved.id;
      stop.lines = saved.lines;
      game.network.stops.set(stop.id, stop);
    }

    for (const saved of data.lines) {
      const line = new Line(saved.mode, saved.color);
      line.id = saved.id;
      line.stops = saved.stops;
      line.loop = saved.loop;
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
        line.vehicles.push(vehicle);
      }
    }

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
