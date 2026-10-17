/**
 * Passengers: waiting, boarding, transferring, arriving, and giving up.
 *
 * A dot stands for several real passengers — how many depends on the region's
 * size, see `passengersPerDot` in config.js. A dot waits at its boarding stop,
 * takes the first vehicle of its line heading the right way that has room,
 * walks at transfers, and vanishes when it arrives.
 *
 * The patience rule is the one that gives the game its slow, visible failure:
 * past 15 sim minutes (12 on Hard, 20 on Easy) a dot gives up, the pair's
 * satisfaction drops, and fewer passengers spawn on that route for a while.
 * Borrowed from Mini Metro and important: a dot will NOT give up if a vehicle
 * it can board is nearly here. Without that grace, players lose passengers to
 * near-misses and the game feels unfair rather than demanding.
 */

import { PATIENCE, DIFFICULTY, ROUTING, VEHICLES } from '../config.js';
import { secondsToStop, holdForSpacing } from './vehicles.js';

let nextDotId = 1;

export class Dot {
  /**
   * @param {string} fromId origin stop id
   * @param {string} toId final destination stop id
   * @param {import('./routing.js').Route} route
   * @param {number} simNow
   */
  constructor(fromId, toId, route, simNow) {
    this.id = `d${nextDotId++}`;
    this.fromId = fromId;
    this.toId = toId;
    this.route = route;
    /** Which leg of the route the dot is on. */
    this.legIndex = 0;
    /** Sim time it started waiting at its current stop. */
    this.waitingSince = simNow;
    this.bornAt = simNow;
    /** True once the first fare has been charged. */
    this.ticketPaid = false;
    /** The stop it is standing at, or null while aboard. */
    this.atStopId = fromId;
  }

  /** @returns {import('./routing.js').Leg|undefined} */
  get leg() { return this.route.legs[this.legIndex]; }
}

/**
 * Everything that happens to passengers in one tick, in the order it must
 * happen: alight before boarding (so seats free up for the people waiting),
 * then board, then expire anyone out of patience.
 *
 * @param {object} game
 * @param {number} simSeconds
 * @returns {{arrived:number, boarded:number, gaveUp:number, firstBoardings:number}}
 */
export function stepPassengers(game, simSeconds) {
  const { network, clock, demand } = game;
  const stats = { arrived: 0, boarded: 0, gaveUp: 0, firstBoardings: 0, transferred: 0 };
  const simNow = clock.simSeconds;

  for (const line of network.lines.values()) {
    for (const vehicle of line.vehicles) {
      const stopId = vehicle.justArrivedAt;
      if (!stopId) continue;
      const stop = network.stops.get(stopId);
      if (!stop) continue;

      const before = stats.arrived + stats.boarded + stats.transferred;
      alightHere(game, vehicle, stop, simNow, stats);
      boardHere(game, line, vehicle, stop, stats);
      const nobody = stats.arrived + stats.boarded + stats.transferred === before;

      // A request stop: nobody off, nobody on, so a bus or tram drives on —
      // if its line skips empty stops. Not at a line end, where the vehicle
      // turns round and lays over.
      const lineEnd = !line.loop && vehicle.hop === 0;
      if (nobody && !lineEnd && line.skipEmptyStops
          && VEHICLES.SKIP_EMPTY_STOPS.includes(line.mode)) {
        vehicle.dwellRemaining = 0;
        vehicle.skipped = (vehicle.skipped ?? 0) + 1;
      }
      // Too close behind the vehicle ahead: wait here, even at an empty stop.
      holdForSpacing(vehicle, line);
    }
  }

  expirePatience(game, simNow, stats);
  return stats;
}

/** Everyone whose current leg ends here gets off. */
function alightHere(game, vehicle, stop, simNow, stats) {
  const { network } = game;
  const staying = [];

  for (const dot of vehicle.passengers) {
    const leg = dot.leg;
    if (!leg || leg.toStop !== stop.id) { staying.push(dot); continue; }

    dot.legIndex++;

    if (dot.legIndex >= dot.route.legs.length) {
      // Journey complete.
      stats.arrived++;
      continue;
    }

    // Riding on through the end of the line: the vehicle has turned round
    // here and its next trip is the passenger's next leg.
    const next = dot.leg;
    if (next.lineId === vehicle.lineId && next.direction === vehicle.direction
        && next.fromStop === stop.id) {
      staying.push(dot);
      continue;
    }

    // A transfer: walk to the next leg's boarding stop and wait again.
    const nextStopId = dot.route.legs[dot.legIndex].fromStop;
    const nextStop = network.stops.get(nextStopId);
    if (!nextStop) { stats.arrived++; continue; } // Stop vanished mid-trip.

    dot.atStopId = nextStop.id;
    dot.waitingSince = simNow;
    nextStop.waiting.push(dot);
    stats.transferred++;
  }

  vehicle.passengers = staying;
}

/**
 * Board whoever is waiting for this line and direction, first come first
 * served, until the vehicle is full.
 */
function boardHere(game, line, vehicle, stop, stats) {
  if (stop.waiting.length === 0) return;
  const remaining = [];

  for (const dot of stop.waiting) {
    const leg = dot.leg;
    const wantsThis = leg && leg.lineId === line.id && leg.direction === vehicle.direction &&
      leg.fromStop === stop.id;

    if (!wantsThis || !vehicle.hasRoom) { remaining.push(dot); continue; }

    vehicle.passengers.push(dot);
    dot.atStopId = null;
    stats.boarded++;

    // The fare is charged once per trip, at the first boarding. Transfers are
    // free, so a dot that has already paid rides on.
    if (!dot.ticketPaid) {
      dot.ticketPaid = true;
      stats.firstBoardings++;
    }
    line.ridersToday++;
  }

  stop.waiting = remaining;
}

/**
 * Anyone who has waited longer than their patience gives up — unless a vehicle
 * they could board is within the grace window.
 */
function expirePatience(game, simNow, stats) {
  const { network, demand } = game;

  for (const stop of network.stops.values()) {
    if (stop.waiting.length === 0) continue;
    const staying = [];

    for (const dot of stop.waiting) {
      const waited = simNow - dot.waitingSince;
      if (waited <= patienceFor(game, dot)) { staying.push(dot); continue; }

      // Mini Metro's grace period: don't punish a near-miss.
      if (rescueIsClose(network, dot, stop)) { staying.push(dot); continue; }

      stats.gaveUp++;
      // An unpaid ticket is simply never collected. A dot that gave up on a
      // transfer has already paid, and that money stays paid.
      demand.penalise(dot.fromId, dot.toId);
    }
    stop.waiting = staying;
  }
}

/**
 * How long this passenger will wait, in sim seconds. The difficulty sets it —
 * unless the line it is waiting for keeps a timetable (ROUTING.
 * TIMETABLE_HEADWAY_S), in which case it waits at least a full headway plus
 * the grace: someone who checked the timetable knows the bus is coming.
 */
export function patienceFor(game, dot) {
  const base = DIFFICULTY[game.difficulty].patienceSimMinutes * 60;
  const line = dot.leg ? game.network.lines.get(dot.leg.lineId) : null;
  const headway = line?.headwayS ?? Infinity;
  if (!Number.isFinite(headway) || headway < ROUTING.TIMETABLE_HEADWAY_S) return base;
  return Math.max(base, headway + PATIENCE.GRACE_SIM_S);
}

/** Is a boardable vehicle arriving within the grace window? */
function rescueIsClose(network, dot, stop) {
  const leg = dot.leg;
  if (!leg) return false;
  const line = network.lines.get(leg.lineId);
  if (!line) return false;

  for (const vehicle of line.vehicles) {
    if (vehicle.direction !== leg.direction || !vehicle.hasRoom) continue;
    if (secondsToStop(vehicle, line, stop.id) <= PATIENCE.GRACE_SIM_S) return true;
  }
  return false;
}

/**
 * Create the dots the demand model asked for, routing each one. A pair with no
 * route is dropped silently: the demand model already filters to connected
 * pairs, but the network can change between a rebuild and a spawn.
 *
 * @returns {number} dots created
 */
export function spawnDots(game, simSeconds) {
  let created = 0;
  for (const { fromId, toId } of game.demand.spawn(simSeconds)) {
    if (placeDot(game, fromId, toId)) created++;
  }
  return created;
}

/**
 * Route one new passenger and stand it at the stop its first leg boards from.
 * Shared by ordinary demand and by intercity arrivals.
 *
 * @returns {Dot|null} null when the stop is gone or there is no route
 */
export function placeDot(game, fromId, toId) {
  const { network, router, clock } = game;
  const stop = network.stops.get(fromId);
  if (!stop) return null;
  const route = router.route(fromId, toId);
  if (!route || route.legs.length === 0) return null;

  const dot = new Dot(fromId, toId, route, clock.simSeconds);
  // The dot must wait where its first leg actually boards, which may be a
  // neighbouring stop in the same interchange rather than its origin.
  const boardingStop = network.stops.get(route.legs[0].fromStop) || stop;
  dot.atStopId = boardingStop.id;
  boardingStop.waiting.push(dot);
  return dot;
}

/**
 * Drop any dot whose route refers to a line or stop that no longer exists.
 * Called after the player edits the network: a dot holding a stale route would
 * otherwise wait forever for a vehicle that is never coming.
 */
export function revalidateDots(game) {
  const { network, router } = game;
  let stranded = 0;

  const routeStillValid = (dot) => {
    for (let i = dot.legIndex; i < dot.route.legs.length; i++) {
      const leg = dot.route.legs[i];
      const line = network.lines.get(leg.lineId);
      if (!line || !network.stops.has(leg.fromStop) || !network.stops.has(leg.toStop)) return false;
      if (!line.stops.includes(leg.fromStop) || !line.stops.includes(leg.toStop)) return false;
    }
    return true;
  };

  for (const stop of network.stops.values()) {
    const staying = [];
    for (const dot of stop.waiting) {
      if (routeStillValid(dot)) { staying.push(dot); continue; }
      // Try to re-route from where the dot is standing before giving up on it.
      const replacement = router.route(stop.id, dot.toId);
      if (replacement && replacement.legs.length > 0) {
        dot.route = replacement;
        dot.legIndex = 0;
        staying.push(dot);
      } else {
        stranded++;
      }
    }
    stop.waiting = staying;
  }

  // Passengers aboard a vehicle whose route died ride to the next stop and are
  // released there; dropping them mid-tunnel would be worse.
  for (const line of network.lines.values()) {
    for (const vehicle of line.vehicles) {
      vehicle.passengers = vehicle.passengers.filter((dot) => {
        if (routeStillValid(dot)) return true;
        stranded++;
        return false;
      });
    }
  }
  return stranded;
}
