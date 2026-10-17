/**
 * Vehicles: constant cruise speed, a fixed dwell at each stop, no acceleration.
 *
 * Direction, the Mini Metro way: there is no signalling and no collision, so
 * vehicles pass through each other freely. On an open line a vehicle shuttles
 * and reverses at each terminal. On a loop it keeps its direction forever, and
 * the player chooses clockwise or anticlockwise when adding one.
 *
 * A vehicle's position is (index of the hop it is on, metres into that hop)
 * rather than one distance along the whole line. That survives the player
 * editing the line underneath it, which a global distance would not.
 */

import { MODES, COSTS, VEHICLES } from '../config.js';
import { stopOrder, hopSeconds, segmentFor } from './routing.js';

let nextVehicleId = 1;

export class Vehicle {
  /**
   * @param {import('../model/network.js').Line} line
   * @param {number} direction 0 as drawn, 1 reversed
   */
  constructor(line, direction = 0) {
    this.id = `v${nextVehicleId++}`;
    this.lineId = line.id;
    this.mode = line.mode;
    this.direction = direction;
    /** Index into stopOrder(line, direction) of the stop just left. */
    this.hop = 0;
    /** Metres travelled into the current hop. */
    this.progress = 0;
    /** Sim seconds of dwell left; 0 means moving. */
    this.dwellRemaining = 0;
    /** @type {import('./passengers.js').Dot[]} */
    this.passengers = [];
    /** Set for the tick in which the vehicle reaches a stop. */
    this.justArrivedAt = null;
    /**
     * People per dot in this game. Capacity is in people, and a dot can stand
     * for several, so the seats a vehicle has for dots depend on it. Set by
     * the Game; 1 when a vehicle is made on its own, as in tests.
     */
    this.dotSize = 1;
    /** Lon/lat and bearing, refreshed each tick for the renderer. */
    this.lon = 0;
    this.lat = 0;
    this.bearing = 0;
  }

  /** Capacity in people. */
  get capacity() { return MODES[this.mode].capacity; }
  /**
   * Capacity in dots. Until Phase 6 a vehicle took one dot per seat, so a
   * 50-person bus in a city of 10-person dots carried 500 people.
   */
  get seats() { return Math.max(1, Math.floor(this.capacity / this.dotSize)); }
  get hasRoom() { return this.passengers.length < this.seats; }
  get load() { return this.passengers.length / this.seats; }
  static price(mode) { return COSTS.VEHICLE[mode]; }
}

/**
 * Advance one vehicle.
 *
 * @param {Vehicle} vehicle
 * @param {import('../model/network.js').Line} line
 * @param {number} simSeconds
 * @param {import('../model/region.js').LocalFrame} frame
 */
export function stepVehicle(vehicle, line, simSeconds, frame) {
  vehicle.justArrivedAt = null;
  const order = stopOrder(line, vehicle.direction);
  if (order.length < 2) return;

  // Clamp after an edit shortened the line under this vehicle.
  if (vehicle.hop >= order.length - 1) {
    turnAround(vehicle, line);
    return;
  }

  if (vehicle.dwellRemaining > 0) {
    vehicle.dwellRemaining = Math.max(0, vehicle.dwellRemaining - simSeconds);
    updatePose(vehicle, line, frame);
    return;
  }

  const segment = segmentFor(line, vehicle.direction, vehicle.hop);
  const hopLength = segment?.lengthM ?? 0;
  const metresPerSecond = (line.cruiseKmh * 1000) / 3600;
  vehicle.progress += metresPerSecond * simSeconds;

  if (vehicle.progress >= hopLength) {
    // Arrived at the next stop.
    vehicle.progress = 0;
    vehicle.hop++;
    vehicle.dwellRemaining = line.dwellS;
    vehicle.justArrivedAt = order[Math.min(vehicle.hop, order.length - 1)];

    if (vehicle.hop >= order.length - 1) turnAround(vehicle, line);
  }
  updatePose(vehicle, line, frame);
}

/**
 * Reaching the end of the stop order: an open line reverses, a loop wraps.
 * A loop's stop order repeats its first stop at the end, so wrapping to hop 0
 * puts the vehicle back at the same place it just reached, with no jump.
 */
function turnAround(vehicle, line) {
  if (line.loop) {
    vehicle.hop = 0;
  } else {
    vehicle.direction = vehicle.direction === 0 ? 1 : 0;
    vehicle.hop = 0;
  }
  vehicle.progress = 0;
}

/** Recompute lon/lat and bearing from the hop and progress. */
function updatePose(vehicle, line, frame) {
  const segment = segmentFor(line, vehicle.direction, vehicle.hop);
  if (!segment || segment.points.length === 0) return;

  // Direction 1 walks the same polyline backwards.
  const forward = vehicle.direction === 0;
  const distance = forward ? vehicle.progress : segment.lengthM - vehicle.progress;
  const pose = pointAlong(segment, frame, distance);
  if (!pose) return;

  vehicle.lon = pose.lon;
  vehicle.lat = pose.lat;
  vehicle.bearing = forward ? pose.bearing : pose.bearing + Math.PI;
}

/**
 * Point and heading at a distance along a segment's polyline.
 *
 * Cumulative lengths are computed once and cached on the segment, because this
 * runs for every vehicle every frame.
 *
 * @returns {{lon:number, lat:number, bearing:number}|null}
 */
export function pointAlong(segment, frame, distanceM) {
  const points = segment.points;
  if (points.length === 0) return null;
  if (points.length === 1) return { lon: points[0][0], lat: points[0][1], bearing: 0 };

  if (!segment.cumulative) {
    const cumulative = new Float64Array(points.length);
    for (let i = 1; i < points.length; i++) {
      cumulative[i] = cumulative[i - 1] + frame.distance(
        points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
    }
    segment.cumulative = cumulative;
  }

  const cumulative = segment.cumulative;
  const total = cumulative[cumulative.length - 1];
  const target = Math.max(0, Math.min(total, distanceM));

  // Binary search for the vertex pair straddling the target distance.
  let low = 0;
  let high = cumulative.length - 1;
  while (low + 1 < high) {
    const mid = (low + high) >> 1;
    if (cumulative[mid] <= target) low = mid; else high = mid;
  }

  const spanLength = cumulative[high] - cumulative[low];
  const t = spanLength > 0 ? (target - cumulative[low]) / spanLength : 0;
  const [lon1, lat1] = points[low];
  const [lon2, lat2] = points[high];

  return {
    lon: lon1 + (lon2 - lon1) * t,
    lat: lat1 + (lat2 - lat1) * t,
    // Bearing in local metres, so it is a true screen angle rather than one
    // distorted by longitude convergence.
    bearing: Math.atan2(
      (lat2 - lat1) * frame.mPerLat,
      (lon2 - lon1) * frame.mPerLon),
  };
}

/**
 * Space a line's vehicles evenly, as the spec requires when one is added.
 *
 * Even spacing is in TIME, not distance: hops differ in length, so spreading
 * by distance would still bunch vehicles where stops are close together.
 */
export function respaceVehicles(line) {
  for (const group of spacingGroups(line)) {
    const cycle = cycleOf(line, group.direction);
    if (cycle.total <= 0) continue;
    group.vehicles.forEach((vehicle, index) => {
      // Vehicle k at k/n of the way round the WHOLE cycle — out and back on
      // an open line. Spreading over the outbound half only, as before Oct 17
      // 2026, left two buses half an outbound trip apart for ever: departures
      // a quarter and three quarters of the cycle apart instead of a half.
      placeAt(vehicle, line, cycle, (cycle.total * index) / group.vehicles.length);
    });
  }
}

/**
 * Vehicles that share one cycle and should be spread along it. On an open
 * line every vehicle runs the same out-and-back cycle; on a loop, each
 * direction is its own cycle.
 */
export function spacingGroups(line) {
  if (!line.loop) return [{ direction: 0, vehicles: [...line.vehicles] }];
  const groups = new Map();
  for (const vehicle of line.vehicles) {
    if (!groups.has(vehicle.direction)) groups.set(vehicle.direction, []);
    groups.get(vehicle.direction).push(vehicle);
  }
  return [...groups].map(([direction, vehicles]) => ({ direction, vehicles }));
}

/**
 * One full cycle as a list of hops in time: out and back on an open line,
 * once round on a loop. Each hop's seconds include the dwell at the stop it
 * arrives at, as `hopSeconds` does.
 */
export function cycleOf(line, direction = 0) {
  const hops = [];
  const directions = line.loop ? [direction] : [0, 1];
  for (const d of directions) {
    const order = stopOrder(line, d);
    for (let i = 0; i < order.length - 1; i++) hops.push({ direction: d, hop: i, seconds: hopSeconds(line, d, i) });
  }
  return { hops, total: hops.reduce((sum, h) => sum + h.seconds, 0) };
}

/**
 * Where a vehicle is in its cycle, in seconds from the cycle's start. A
 * vehicle still dwelling — or held — at a stop counts as that much behind.
 */
export function phaseOf(vehicle, line, cycle) {
  let elapsed = 0;
  for (const h of cycle.hops) {
    if (h.direction === vehicle.direction && h.hop === vehicle.hop) {
      const metresPerSecond = (line.cruiseKmh * 1000) / 3600;
      return elapsed - vehicle.dwellRemaining + vehicle.progress / metresPerSecond;
    }
    elapsed += h.seconds;
  }
  return 0;
}

/** Put a vehicle at a phase of its cycle. */
function placeAt(vehicle, line, cycle, phase) {
  let offset = phase;
  let index = 0;
  while (index < cycle.hops.length - 1 && offset >= cycle.hops[index].seconds) {
    offset -= cycle.hops[index].seconds;
    index++;
  }
  const { direction, hop, seconds } = cycle.hops[index];
  const segment = segmentFor(line, direction, hop);
  const hopLength = segment?.lengthM ?? 0;
  // The same arithmetic as `phaseOf`: a hop's time is its driving, then the
  // dwell at the stop it reaches. Spreading the dwell over the distance
  // instead, as before, placed vehicles unevenly once the two directions of
  // a line stopped being mirror images (a bus turning round at each end).
  const metresPerSecond = (line.cruiseKmh * 1000) / 3600;
  const driving = hopLength / metresPerSecond;
  if (offset <= driving || seconds <= driving) {
    vehicle.direction = direction;
    vehicle.hop = hop;
    vehicle.progress = Math.min(hopLength, offset * metresPerSecond);
    vehicle.dwellRemaining = 0;
    return;
  }
  // Part-way through the dwell: standing at the stop, at the start of the
  // next hop, with the rest of the dwell still to go.
  const next = cycle.hops[(index + 1) % cycle.hops.length];
  vehicle.direction = next.direction;
  vehicle.hop = next.hop;
  vehicle.progress = 0;
  vehicle.dwellRemaining = seconds - offset;
}

/**
 * Keep a line's vehicles evenly spread (line.keepSpacing). A vehicle that has
 * caught up with the one ahead waits at the stop it has just reached — the
 * dispatcher's oldest trick — for part of the shortfall, so the gaps settle
 * over a few stops rather than overshooting. Only ever holds, never hurries:
 * a real bus cannot make up time it does not have.
 *
 * Call for vehicles that have just arrived at a stop.
 * @returns {number} sim seconds of holding added
 */
export function holdForSpacing(vehicle, line) {
  if (!line.keepSpacing || line.vehicles.length < 2) return 0;
  const group = spacingGroups(line).find((g) => g.vehicles.includes(vehicle));
  if (!group || group.vehicles.length < 2) return 0;
  const cycle = cycleOf(line, group.direction);
  if (cycle.total <= 0) return 0;

  const mine = phaseOf(vehicle, line, cycle);
  const myIndex = group.vehicles.indexOf(vehicle);
  let gapAhead = Infinity;
  group.vehicles.forEach((other, index) => {
    if (other === vehicle) return;
    let gap = ((phaseOf(other, line, cycle) - mine) % cycle.total + cycle.total) % cycle.total;
    // Exactly level — which bunching produces, since vehicles reaching a stop
    // in the same tick all stand on it — the one listed first is ahead.
    // Without this tie-break a bunch that had fully merged was never split.
    if (gap === 0) gap = index < myIndex ? 0 : cycle.total;
    if (gap < gapAhead) gapAhead = gap;
  });
  const target = cycle.total / group.vehicles.length;
  if (!Number.isFinite(gapAhead) || gapAhead >= target * (1 - VEHICLES.SPACING_TOLERANCE)) return 0;
  const hold = Math.min(VEHICLES.SPACING_MAX_HOLD_S, (target - gapAhead) * VEHICLES.SPACING_HOLD_SHARE);
  vehicle.dwellRemaining += hold;
  vehicle.held = (vehicle.held ?? 0) + hold;
  return hold;
}

/**
 * Rough sim seconds until this vehicle reaches `stopId`, looking a couple of
 * hops ahead. Used only for the boarding grace period, so an approximation is
 * fine; returns Infinity when the stop is not imminently ahead.
 */
export function secondsToStop(vehicle, line, stopId, maxHops = 2) {
  const order = stopOrder(line, vehicle.direction);
  if (vehicle.hop >= order.length - 1) return Infinity;

  let seconds = vehicle.dwellRemaining;
  const metresPerSecond = (line.cruiseKmh * 1000) / 3600;

  for (let i = 0; i < maxHops; i++) {
    const hop = vehicle.hop + i;
    if (hop >= order.length - 1) return Infinity;
    const segment = segmentFor(line, vehicle.direction, hop);
    const hopLength = segment?.lengthM ?? 0;
    const remaining = i === 0 ? Math.max(0, hopLength - vehicle.progress) : hopLength;
    seconds += remaining / metresPerSecond;
    if (order[hop + 1] === stopId) return seconds;
    seconds += line.dwellS;
  }
  return Infinity;
}
