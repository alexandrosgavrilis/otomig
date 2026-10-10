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

import { DEMAND, PATIENCE, CLOCK, SEASON_PROFILES } from '../config.js';
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
    /** Same keys → accumulated fractional passengers awaiting a dot. */
    this.pairAccumulator = new Map();
    /**
     * Same keys → satisfaction, 0.2..1. Survives network rebuilds, because a
     * route the player neglected should stay unpopular even if they redraw it.
     * @type {Map<string, number>}
     */
    this.satisfaction = new Map();

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
    this.buildCatchments();
    this.buildPairTable(month, fareMultiplier);
    this.buildUnservedMap();
  }

  /**
   * Assign every demand cell within walking radius of a stop to its NEAREST
   * stop, and sum residents and attraction per stop.
   *
   * Walking radius depends on mode: 400 m for bus and tram, 600 m for metro
   * and train, so a metro station pulls from a wider area.
   */
  buildCatchments() {
    const { cols, rows, cellM, residents, attraction } = this.region.demand;
    this.catchment.clear();
    this.stopTotals.clear();

    const stops = [...this.network.stops.values()];
    for (const stop of stops) this.stopTotals.set(stop.id, { residents: 0, attraction: 0 });
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

  /**
   * Build the sparse origin→destination rate table.
   *
   * For stop s: trips produced = catchment residents × trips per resident ×
   * the month's multiplier. Those trips are split across destinations in
   * proportion to attraction × f(distance) — but the denominator sums over
   * every cell in the region, served or not, so unserved attraction swallows
   * its share and that demand is lost.
   */
  buildPairTable(month, fareMultiplier) {
    this.pairRate.clear();
    const stops = [...this.network.stops.values()];
    if (stops.length < 2) return;

    const seasonal = SEASON_PROFILES[this.region.meta.season]?.[month] ?? 1;
    // Fare elasticity: demand scales by (price multiplier) ^ -0.3.
    const fareFactor = fareMultiplier ** DEMAND.FARE_EXPONENT;

    const { cols, rows, cellM, attraction } = this.region.demand;
    const connected = this.connectedPairs();

    for (const from of stops) {
      const totals = this.stopTotals.get(from.id);
      if (!totals || totals.residents <= 0) continue;

      const tripsPerDay = totals.residents * DEMAND.TRIPS_PER_RESIDENT * seasonal;
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
        if (!toTotals || toTotals.attraction <= 0) continue;

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
    const { residents, attraction } = this.region.demand;
    const values = new Array(residents.length).fill(0);
    let peak = 0;

    for (let i = 0; i < residents.length; i++) {
      if (this.catchment.has(i)) continue;
      // Attraction is a floor-area number and dwarfs resident counts, so it is
      // damped to keep the map readable as "where people are".
      const value = residents[i] + attraction[i] * 0.05;
      values[i] = value;
      if (value > peak) peak = value;
    }

    this.unserved = peak > 0 ? values.map((v) => v / peak) : values;
  }

  /**
   * Advance the spawn accumulators and return the dots to create.
   *
   * @param {number} simSeconds elapsed sim seconds
   * @returns {Array<{fromId:string, toId:string}>}
   */
  spawn(simSeconds) {
    const born = [];
    if (simSeconds <= 0) return born;

    for (const [key, rate] of this.pairRate) {
      if (rate <= 0) continue;
      const accumulated = (this.pairAccumulator.get(key) ?? 0) + rate * simSeconds;
      if (accumulated < DEMAND.PASSENGERS_PER_DOT) {
        this.pairAccumulator.set(key, accumulated);
        continue;
      }
      const dots = Math.floor(accumulated / DEMAND.PASSENGERS_PER_DOT);
      this.pairAccumulator.set(key, accumulated - dots * DEMAND.PASSENGERS_PER_DOT);
      const [fromId, toId] = key.split('|');
      for (let i = 0; i < dots; i++) born.push({ fromId, toId });
    }
    return born;
  }

  /** A passenger gave up: knock this pair's satisfaction down. */
  penalise(fromId, toId) {
    const key = pairKey(fromId, toId);
    const current = this.satisfaction.get(key) ?? 1;
    this.satisfaction.set(key,
      Math.max(PATIENCE.SATISFACTION_FLOOR, current - PATIENCE.GIVE_UP_PENALTY));
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
    const { residents } = this.region.demand;
    let covered = 0;
    let total = 0;
    for (let i = 0; i < residents.length; i++) {
      total += residents[i];
      if (this.catchment.has(i)) covered += residents[i];
    }
    return total > 0 ? covered / total : 0;
  }

  toJSON() {
    return { satisfaction: [...this.satisfaction], accumulator: [...this.pairAccumulator] };
  }

  loadJSON(data) {
    this.satisfaction = new Map(data?.satisfaction || []);
    this.pairAccumulator = new Map(data?.accumulator || []);
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
