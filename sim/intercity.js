/**
 * Intercity service (Phase 6): uncontrollable NPC trains calling at stations
 * on existing rail whose service the player has switched on.
 *
 * Nothing about the intercity train itself is simulated — it runs on someone
 * else's timetable, outside the region. What the player sees is what it
 * leaves behind: a ticket for every passenger aboard, and a share of them
 * stepping off as new trips into the player's network.
 *
 * Arrivals are spread over the stops the station is connected to in the same
 * proportions as ordinary trips (attraction × distance). The split is by
 * largest remainder rather than at random, so a call always lands the same
 * way and the tests can check it exactly.
 */

import { INTERCITY } from '../config.js';
import { placeDot } from './passengers.js';

/**
 * Advance every intercity station's timer and make the calls that fall due.
 * @returns {{calls:number, dots:number}}
 */
export function stepIntercity(game, simSeconds) {
  const result = { calls: 0, dots: 0 };
  if (simSeconds <= 0) return result;

  for (const stop of game.network.stops.values()) {
    if (!stop.intercity) continue;
    stop.intercityTimer += simSeconds;
    while (stop.intercityTimer >= INTERCITY.INTERVAL_SIM_S) {
      stop.intercityTimer -= INTERCITY.INTERVAL_SIM_S;
      result.dots += intercityCall(game, stop);
      result.calls++;
    }
  }
  return result;
}

/**
 * One train calls: its passengers pay, and some step off into the network.
 * @returns {number} dots placed
 */
export function intercityCall(game, stop) {
  const aboard = INTERCITY.PASSENGERS_PER_CALL;
  game.economy.recordIntercity(aboard);
  stop.intercityCalls++;

  // People leaving the train, in dots, carrying the fraction to the next call.
  const people = aboard * INTERCITY.DROP_FRACTION + stop.intercityCarry * game.passengersPerDot;
  const dots = Math.floor(people / game.passengersPerDot);
  stop.intercityCarry = (people - dots * game.passengersPerDot) / game.passengersPerDot;

  const destinations = game.demand.destinationsFrom(stop.id);
  let placed = 0;
  for (const { toId, count } of apportion(destinations, dots)) {
    for (let i = 0; i < count; i++) {
      if (placeDot(game, stop.id, toId)) placed++;
    }
  }
  game.totals.spawned += placed;
  return placed;
}

/**
 * Split `total` whole dots across weighted destinations: everyone gets the
 * floor of their share, and the leftovers go to the largest remainders.
 * @returns {Array<{toId:string, count:number}>}
 */
export function apportion(destinations, total) {
  const sum = destinations.reduce((acc, d) => acc + d.weight, 0);
  if (!(sum > 0) || total <= 0) return [];
  const shares = destinations.map((d) => {
    const exact = (d.weight / sum) * total;
    return { toId: d.toId, count: Math.floor(exact), remainder: exact - Math.floor(exact) };
  });
  let left = total - shares.reduce((acc, s) => acc + s.count, 0);
  const byRemainder = [...shares].sort((a, b) => b.remainder - a.remainder
    || (a.toId < b.toId ? -1 : 1));
  for (const share of byRemainder) {
    if (left <= 0) break;
    share.count++;
    left--;
  }
  return shares.filter((s) => s.count > 0).map(({ toId, count }) => ({ toId, count }));
}
