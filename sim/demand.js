/**
 * Who wants to go where.
 *
 * The model is deliberately simple and recomputed rarely: catchments assign
 * each demand cell to its nearest stop, every stop pair gets an expected
 * passengers-per-sim-second rate, and dots pop out whenever a pair's
 * accumulator reaches one dot's worth.
 *
 * The one rule that gives the game its shape: a stop's trips are divided by the
 * attraction of the WHOLE region, not just the served part. Trips aimed at
 * places with no stop are simply lost, so extending coverage raises ridership
 * directly rather than just redistributing it.
 */

import {
  DEMAND, PATIENCE, CLOCK, passengersPerDot, residentsFactor, seasonalMultiplier,
  baselineResidents,
} from '../config.js';
import { Clock } from './clock.js';

export class DemandModel {
  /**
   * @param {import('../model/region.js').Region} region
   * @param {import('../model/region.js').LocalFrame} frame
   * @param {import('../model/network.js').Network} network
   */
  constructor(region, frame, network) {
    this.region = region;
    this.frame = frame;
    this.network = network;
    /**
     * Passengers per dot, fixed for this region at import. Everything that
     * converts between dots and people reads this one value.
     */
    this.passengersPerDot = passengersPerDot(baselineResidents(region.meta));

    /**
     * Residents per demand cell as the game sees them this month: the
     * building-derived count from the import, scaled for the profile and the
     * season. The import's own grid is never modified, so a cached region can
     * be replayed under a different profile.
     * @type {number[]}
     */
    this.residents = [];
    this.scaleResidents(0);

    /** Cell index → stop id, for cells inside some catchment. @type {Map<number,string>} */
    this.catchment = new Map();
    /** Stop id → residents and attraction summed over its catchment. */
    this.stopTotals = new Map();
    /**
     * Sparse pair table: `${fromId}|${toId}` → expected passengers per sim
     * second. Only connected pairs appear, so this stays far smaller than
     * stops².
     * @type {Map<string, number>}
     */
    this.pairRate = new Map();
    /**
     * People banked toward the next dot, for the whole network at once. See
     * `spawn`. Rebuilt with the pair table: its cumulative rates and keys.
     */
    this.carry = 0;
    this.spawnTable = null;
    /** State of the random stream that picks each new dot's trip, saved with the game. */
    this.randomState = 1;
    /**
     * Same keys → satisfaction, 0.2..1. Survives network rebuilds, because a
     * route the player neglected should stay unpopular even if they redraw it.
     * @type {Map<string, number>}
     */
    this.satisfaction = new Map();

    /** Ordered stop pairs the network connects, from the last rebuild. */
    this.connected = new Set();
    /** `flows()` merged and sorted, until the next rebuild. */
    this.sortedFlows = null;

    /** Per-cell unserved demand, 0..1, for the heat map. */
    this.unserved = new Array(region.demand.cols * region.demand.rows).fill(0);

    this.builtForVersion = -1;
    this.builtForMonth = -1;
    this.builtForFare = -1;
  }

  /**
   * Rebuild the pair table if the network, the month or the fare has changed.
   * Called every tick but almost always returns immediately — the spec is
   * explicit that this must never run per frame.
   */
  refreshIfNeeded(clock, fareMultiplier) {
    if (this.builtForVersion === this.network.version &&
        this.builtForMonth === clock.month &&
        this.builtForFare === fareMultiplier) return false;

    this.rebuild(clock.month, fareMultiplier);
    this.builtForVersion = this.network.version;
    this.builtForMonth = clock.month;
    this.builtForFare = fareMultiplier;
    return true;
  }

  rebuild(month, fareMultiplier) {
    this.scaleResidents(month);
    this.buildCatchments();
    this.buildPairTable(month, fareMultiplier);
    this.buildUnservedMap();
  }

  /**
   * Scale the imported residents for the profile and this month's season.
   *
   * The seasonal curve applies to people, not to trip rates: a tourist town
   * in August has more people in it, each making trips at the usual rate.
   */
  scaleResidents(month) {
    const factor = residentsFactor(this.region.meta) * seasonalMultiplier(this.region.meta, month);
    this.residents = this.region.demand.residents.map((value) => value * factor);
  }

  /**
   * Assign every demand cell within walking radius of a SERVED stop to its
   * nearest served stop, and sum residents and attraction per stop.
   *
   * Walking radius depends on mode: 400 m for bus and tram, 600 m for metro
   * and train, so a metro station pulls from a wider area.
   *
   * Only a stop on a running line — at least two stops and a vehicle — covers
   * anyone. A stop standing on its own used to count as served, so the heat
   * map went quiet around it and the coverage subsidy paid for it, with no
   * bus ever calling (Alex, Oct 16 2026). An unserved stop still gets totals,
   * marked `served: false`, so its panel can say what it WOULD cover.
   */
  buildCatchments() {
    const { cols, rows, cellM, attraction } = this.region.demand;
    const { residents } = this;
    this.catchment.clear();
    this.stopTotals.clear();

    const servedIds = new Set();
    for (const line of this.network.activeLines) for (const id of line.stops) servedIds.add(id);
    const stops = [...this.network.stops.values()].filter((stop) => servedIds.has(stop.id));
    for (const stop of stops) {
      this.stopTotals.set(stop.id, { residents: 0, attraction: 0, served: true });
    }
    for (const stop of this.network.stops.values()) {
      if (!servedIds.has(stop.id)) this.stopTotals.set(stop.id, this.wouldCover(stop));
    }
    if (stops.length === 0) return;

    // Precompute stop positions in local metres once.
    const positions = stops.map((stop) => {
      const [x, y] = this.frame.toLocal(stop.lon, stop.lat);
      return { stop, x, y, radius: DEMAND.CATCHMENT_M[stop.mode] };
    });

    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const index = row * cols + col;
        if (residents[index] === 0 && attraction[index] === 0) continue;
        const cx = (col + 0.5) * cellM;
        const cy = (row + 0.5) * cellM;

        let nearest = null;
        let nearestDist = Infinity;
        for (const position of positions) {
          const distance = Math.hypot(position.x - cx, position.y - cy);
          if (distance <= position.radius && distance < nearestDist) {
            nearestDist = distance;
            nearest = position.stop;
          }
        }
        if (!nearest) continue;

        this.catchment.set(index, nearest.id);
        const totals = this.stopTotals.get(nearest.id);
        totals.residents += residents[index];
        totals.attraction += attraction[index];
      }
    }
  }

  /** What a stop no line serves would cover on its own, for its panel. */
  wouldCover(stop) {
    const { cols, rows, cellM, attraction } = this.region.demand;
    const [x, y] = this.frame.toLocal(stop.lon, stop.lat);
    const radius = DEMAND.CATCHMENT_M[stop.mode];
    const totals = { residents: 0, attraction: 0, served: false };
    const c0 = Math.max(0, Math.floor((x - radius) / cellM));
    const c1 = Math.min(cols - 1, Math.floor((x + radius) / cellM));
    const r0 = Math.max(0, Math.floor((y - radius) / cellM));
    const r1 = Math.min(rows - 1, Math.floor((y + radius) / cellM));
    for (let row = r0; row <= r1; row++) {
      for (let col = c0; col <= c1; col++) {
        if (Math.hypot((col + 0.5) * cellM - x, (row + 0.5) * cellM - y) > radius) continue;
        totals.residents += this.residents[row * cols + col];
        totals.attraction += attraction[row * cols + col];
      }
    }
    return totals;
  }

  /**
   * Build the sparse origin→destination rate table.
   *
   * For stop s: trips produced = catchment residents × trips per resident.
   * The season is already in the residents (`scaleResidents`). Those trips are split across destinations in
   * proportion to attraction × f(distance) — but the denominator sums over
   * every cell in the region, served or not, so unserved attraction swallows
   * its share and that demand is lost.
   */
  buildPairTable(month, fareMultiplier) {
    this.pairRate.clear();
    this.spawnTable = null;
    this.connected = new Set();
    this.sortedFlows = null;
    const stops = [...this.network.stops.values()];
    if (stops.length < 2) return;

    // Fare elasticity: demand scales by (price multiplier) ^ -0.3.
    const fareFactor = fareMultiplier ** DEMAND.FARE_EXPONENT;

    const { cols, rows, cellM, attraction } = this.region.demand;
    const connected = this.connectedPairs();
    this.connected = connected;

    for (const from of stops) {
      const totals = this.stopTotals.get(from.id);
      if (!totals?.served || totals.residents <= 0) continue;

      const tripsPerDay = totals.residents * DEMAND.TRIPS_PER_RESIDENT;
      if (tripsPerDay <= 0) continue;

      const [fx, fy] = this.frame.toLocal(from.lon, from.lat);

      // Denominator: the whole region's attraction, distance-weighted.
      let totalWeight = 0;
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const index = row * cols + col;
          const a = attraction[index];
          if (a <= 0) continue;
          const distance = Math.hypot((col + 0.5) * cellM - fx, (row + 0.5) * cellM - fy);
          totalWeight += a * decay(distance);
        }
      }
      if (totalWeight <= 0) continue;

      for (const to of stops) {
        if (to.id === from.id) continue;
        const key = pairKey(from.id, to.id);
        if (!connected.has(key)) continue;

        const toTotals = this.stopTotals.get(to.id);
        if (!toTotals?.served || toTotals.attraction <= 0) continue;

        const distance = this.frame.distance(from.lon, from.lat, to.lon, to.lat);
        const weight = toTotals.attraction * decay(distance);
        if (weight <= 0) continue;

        const share = weight / totalWeight;
        const satisfaction = this.satisfaction.get(key) ?? 1;
        const perDay = tripsPerDay * share * satisfaction * fareFactor;

        /*
         * Convert a daily trip count into the true average spawn rate per sim
         * second — the hinge the whole two-clock model turns on.
         *
         * A day is 18 h = 64,800 seconds of real service, so the real rate is
         * perDay / 64,800. One calendar day shows only 200 sim seconds, so
         * over a day we actually spawn perDay / 324 dots — and the reporting
         * side multiplies daily totals back up by exactly that 324. The two
         * cancel, which is what makes the fast calendar honest.
         *
         * 64,800 is DAILY_SCALE × simSecondsPerDay, written that way so
         * changing any clock constant in config.js keeps this correct.
         */
        this.pairRate.set(key, perDay / (CLOCK.DAILY_SCALE * Clock.simSecondsPerDay));
      }
    }
  }

  /**
   * Which ordered stop pairs the network can actually carry someone between.
   *
   * A simple reachability closure over "same line" and "same interchange"
   * edges. The passenger router works out the actual best route later; this
   * only decides whether a pair may spawn at all.
   * @returns {Set<string>}
   */
  connectedPairs() {
    /** Stop id → stop ids reachable in one line ride or one walk. */
    const neighbours = new Map();
    const add = (a, b) => {
      if (!neighbours.has(a)) neighbours.set(a, new Set());
      neighbours.get(a).add(b);
    };

    for (const stop of this.network.stops.values()) {
      add(stop.id, stop.id);
      for (const { stop: walkable } of this.network.walkableFrom(stop)) {
        add(stop.id, walkable.id);
        add(walkable.id, stop.id);
      }
    }
    // A line with no vehicles carries nobody, so it connects nothing.
    for (const line of this.network.activeLines) {
      for (const a of line.stops) {
        for (const b of line.stops) if (a !== b) add(a, b);
      }
    }

    // Transitive closure by breadth-first search from each stop.
    const connected = new Set();
    for (const start of this.network.stops.keys()) {
      const seen = new Set([start]);
      const queue = [start];
      while (queue.length) {
        const current = queue.shift();
        for (const next of neighbours.get(current) || []) {
          if (seen.has(next)) continue;
          seen.add(next);
          queue.push(next);
          connected.add(pairKey(start, next));
        }
      }
    }
    return connected;
  }

  /**
   * Unserved demand per cell, normalised 0..1 for the heat map.
   * A cell inside any catchment contributes nothing: it is served.
   */
  buildUnservedMap() {
    const { attraction } = this.region.demand;
    const { residents } = this;
    const values = new Array(residents.length).fill(0);
    let peak = 0;

    for (let i = 0; i < residents.length; i++) {
      // Attraction is a floor-area number and dwarfs resident counts, so it is
      // damped to keep the map readable as "where people are".
      const value = residents[i] + attraction[i] * 0.05;
      // The scale is the whole region's peak, served or not. Normalising to
      // the peak of what is still UNSERVED made every stop that covered the
      // busiest cell rescale the entire map, which flickered wildly while a
      // line was being placed (Alex, Oct 16 2026).
      if (value > peak) peak = value;
      if (!this.catchment.has(i)) values[i] = value;
    }

    this.unserved = peak > 0 ? values.map((v) => v / peak) : values;
  }

  /**
   * The dots to create after `simSeconds`.
   *
   * People are banked for the whole network at once, and each time a dot's
   * worth has built up, one dot is born on a trip picked at random, weighted
   * by how many people want each pair. Every pair gets its share on average.
   *
   * Banking pair by pair instead, as before, throttled the network hard: the
   * game shows a 1-in-324 sample of the day, so a network wants only a few
   * dots a day, spread over hundreds of pairs — and each pair waited for a
   * whole dot of its own. A new network on 10-person dots had started 7% of
   * its trips by day 30 (Alex, Oct 17 2026).
   *
   * @param {number} simSeconds elapsed sim seconds
   * @returns {Array<{fromId:string, toId:string}>}
   */
  spawn(simSeconds) {
    const born = [];
    if (simSeconds <= 0) return born;
    if (!this.spawnTable) {
      const keys = [...this.pairRate.keys()];
      const cumulative = new Float64Array(keys.length);
      let total = 0;
      keys.forEach((key, i) => { total += Math.max(0, this.pairRate.get(key)); cumulative[i] = total; });
      this.spawnTable = { keys, cumulative, total };
    }
    const { keys, cumulative, total } = this.spawnTable;
    if (total <= 0) return born;

    this.carry += total * simSeconds;
    while (this.carry >= this.passengersPerDot) {
      this.carry -= this.passengersPerDot;
      // The first pair whose running total passes a random point.
      const target = this.random() * total;
      let lo = 0;
      let hi = keys.length - 1;
      while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid] > target) hi = mid; else lo = mid + 1;
      }
      const [fromId, toId] = keys[lo].split('|');
      born.push({ fromId, toId });
    }
    return born;
  }

  /**
   * A number in [0, 1) from a seeded stream (mulberry32), so a game — and a
   * test — plays out the same way every time, and a save carries on as it was.
   */
  random() {
    this.randomState = (this.randomState + 0x6D2B79F5) | 0;
    let t = this.randomState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /**
   * Where people arriving at a stop from outside the region want to go:
   * every stop the network connects it to, weighted like ordinary trips by
   * attraction and distance. Used for intercity arrivals.
   * @returns {Array<{toId:string, weight:number}>}
   */
  destinationsFrom(fromId) {
    const from = this.network.stops.get(fromId);
    if (!from) return [];
    const result = [];
    for (const to of this.network.stops.values()) {
      if (to.id === fromId || !this.connected.has(pairKey(fromId, to.id))) continue;
      const attraction = this.stopTotals.get(to.id)?.attraction ?? 0;
      const weight = attraction * decay(this.frame.distance(from.lon, from.lat, to.lon, to.lat));
      if (weight > 0) result.push({ toId: to.id, weight });
    }
    return result;
  }

  /**
   * People a day wanting to travel between each pair of stops, both
   * directions together, busiest first: what the Flows layer draws. Only
   * pairs the network connects carry any demand, so every flow is a trip the
   * player's network can make — including the rare ones that only produce a
   * dot every few minutes.
   *
   * @param {number} [limit]
   * @returns {Array<{a:string, b:string, perDay:number}>}
   */
  flows(limit = Infinity) {
    // The overlay asks every frame; the answer only changes with the table.
    if (!this.sortedFlows) this.sortedFlows = this.mergeFlows();
    return this.sortedFlows.slice(0, limit);
  }

  /**
   * One stop's flows: people a day between it and each other stop, both
   * directions together, busiest first. For the Flows layer with a stop
   * selected, and the stop's own panel.
   * @returns {Array<{a:string, b:string, other:string, perDay:number}>}
   */
  flowsAt(stopId, limit = Infinity) {
    return this.flows()
      .filter((flow) => flow.a === stopId || flow.b === stopId)
      .slice(0, limit)
      .map((flow) => ({ ...flow, other: flow.a === stopId ? flow.b : flow.a }));
  }

  mergeFlows() {
    const perSimSecondToPerDay = CLOCK.DAILY_SCALE * Clock.simSecondsPerDay;
    const merged = new Map();
    for (const [key, rate] of this.pairRate) {
      if (!(rate > 0)) continue;
      const [from, to] = key.split('|');
      const [a, b] = from < to ? [from, to] : [to, from];
      const pair = `${a}|${b}`;
      const flow = merged.get(pair) || { a, b, perDay: 0 };
      flow.perDay += rate * perSimSecondToPerDay;
      merged.set(pair, flow);
    }
    return [...merged.values()].sort((x, y) => y.perDay - x.perDay);
  }

  /**
   * A dot gave up: knock this pair's satisfaction down by the penalty for
   * every person it stands for — what that many people giving up one by one
   * would cost. Charged per dot, as before, a big city's 10-person dot cost
   * a tenth of what ten people cost a small town (Alex, Oct 17 2026).
   */
  penalise(fromId, toId) {
    const key = pairKey(fromId, toId);
    const current = this.satisfaction.get(key) ?? 1;
    this.satisfaction.set(key, Math.max(PATIENCE.SATISFACTION_FLOOR,
      current - PATIENCE.GIVE_UP_PENALTY * this.passengersPerDot));
    // Force a rebuild so the lower satisfaction shows up in spawn rates.
    this.builtForVersion = -1;
  }

  /** Satisfaction creeps back toward 1 each calendar day. */
  recoverDaily() {
    let changed = false;
    for (const [key, value] of this.satisfaction) {
      if (value >= 1) continue;
      this.satisfaction.set(key, Math.min(1, value + PATIENCE.RECOVERY_PER_DAY));
      changed = true;
    }
    if (changed) this.builtForVersion = -1;
  }

  /** Residents within any stop's walking radius, over all residents. */
  coverageFraction() {
    const { residents } = this;
    let covered = 0;
    let total = 0;
    for (let i = 0; i < residents.length; i++) {
      total += residents[i];
      if (this.catchment.has(i)) covered += residents[i];
    }
    return total > 0 ? covered / total : 0;
  }

  toJSON() {
    return { satisfaction: [...this.satisfaction], carry: this.carry, random: this.randomState };
  }

  loadJSON(data) {
    this.satisfaction = new Map(data?.satisfaction || []);
    this.carry = data?.carry ?? 0;
    this.randomState = data?.random ?? 1;
    this.builtForVersion = -1;
  }
}

/** Distance decay. People walk under 800 m, so those trips never ride. */
function decay(distanceM) {
  if (distanceM < DEMAND.WALK_FLOOR_M) return 0;
  return Math.exp(-distanceM / (DEMAND.DECAY_KM * 1000));
}

export function pairKey(fromId, toId) {
  return `${fromId}|${toId}`;
}

/** Fare multiplier → the demand factor it implies. Shared with the UI. */
export function fareFactor(multiplier) {
  return multiplier ** DEMAND.FARE_EXPONENT;
}
