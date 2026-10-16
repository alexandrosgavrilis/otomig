/**
 * Live tuning: change config values while the game runs, for play-testing.
 *
 * Passenger behaviour is the part of the game most likely to need retuning,
 * and retuning it by editing config.js and reloading is slow. The debug panel
 * (ui/tuning.js, toggled with the ` key) writes through this module instead.
 *
 * The config objects are plain mutable objects, so a tuned value is simply
 * written into them — every reader already looks values up when it uses them.
 * What a change does need is the right cache thrown away: the demand table,
 * the routing graph and the interchanges are each rebuilt only when told to.
 *
 * Overrides persist in localStorage so a play-test survives a reload, and the
 * game shows a badge while any are active so they are never forgotten.
 * `exportText` produces the list Alex hands back once he is happy, which is
 * then written into config.js as the new defaults.
 *
 * Nothing here touches the DOM, so the Node suite tests it.
 */

import { DEMAND, PATIENCE, ROUTING, DIFFICULTY, INCOME, COSTS, CLOCK, INTERCITY } from '../config.js';
import { Clock } from './clock.js';

/**
 * What a change invalidates:
 *   live     read every tick; nothing to rebuild
 *   demand   the pair table and catchments
 *   network  interchanges, then everything downstream of the network
 */
const ROOTS = { DEMAND, PATIENCE, ROUTING, DIFFICULTY, INCOME, COSTS, INTERCITY };

/**
 * Every tunable, grouped for the panel. `scale` and `unit` only change how a
 * value is shown (seconds as minutes, fractions as percent); the stored value
 * is always the config's own unit.
 *
 * `{difficulty}` in a path is replaced by the game's difficulty, so the
 * patience slider tunes the rules actually in play.
 */
export const TUNABLES = [
  { group: 'demand', path: 'DEMAND.TRIPS_PER_RESIDENT', min: 0, max: 2, step: 0.01, affects: 'demand' },
  { group: 'demand', path: 'DEMAND.DECAY_KM', min: 0.5, max: 15, step: 0.1, unit: 'km', affects: 'demand' },
  { group: 'demand', path: 'DEMAND.WALK_FLOOR_M', min: 0, max: 2000, step: 50, unit: 'm', affects: 'demand' },
  { group: 'demand', path: 'DEMAND.FARE_EXPONENT', min: -1.5, max: 0, step: 0.05, affects: 'demand' },
  { group: 'demand', path: 'DEMAND.CATCHMENT_M.bus', min: 100, max: 1500, step: 25, unit: 'm', affects: 'demand' },
  { group: 'demand', path: 'DEMAND.CATCHMENT_M.tram', min: 100, max: 1500, step: 25, unit: 'm', affects: 'demand' },
  { group: 'demand', path: 'DEMAND.CATCHMENT_M.metro', min: 100, max: 1500, step: 25, unit: 'm', affects: 'demand' },
  { group: 'demand', path: 'DEMAND.CATCHMENT_M.train', min: 100, max: 1500, step: 25, unit: 'm', affects: 'demand' },

  { group: 'routing', path: 'ROUTING.TRANSFER_PENALTY_S', min: 0, max: 1200, step: 30, scale: 1 / 60, unit: 'min', affects: 'network' },
  { group: 'routing', path: 'ROUTING.TIMETABLE_HEADWAY_S', min: 120, max: 3600, step: 60, scale: 1 / 60, unit: 'min', affects: 'network' },
  { group: 'routing', path: 'ROUTING.BOARDING_WAIT_FRACTION', min: 0, max: 1, step: 0.05, affects: 'network' },
  { group: 'routing', path: 'DEMAND.WALK_SPEED_MS', min: 0.5, max: 2.5, step: 0.1, unit: 'm/s', affects: 'network' },
  { group: 'routing', path: 'DEMAND.INTERCHANGE_M', min: 0, max: 500, step: 10, unit: 'm', affects: 'network' },

  { group: 'patience', path: 'DIFFICULTY.{difficulty}.patienceSimMinutes', min: 1, max: 60, step: 1, unit: 'min', affects: 'live' },
  { group: 'patience', path: 'PATIENCE.GRACE_SIM_S', min: 0, max: 180, step: 5, unit: 's', affects: 'live' },
  { group: 'patience', path: 'PATIENCE.GIVE_UP_PENALTY', min: 0, max: 1, step: 0.01, affects: 'live' },
  { group: 'patience', path: 'PATIENCE.SATISFACTION_FLOOR', min: 0, max: 1, step: 0.05, affects: 'live' },
  { group: 'patience', path: 'PATIENCE.RECOVERY_PER_DAY', min: 0, max: 0.2, step: 0.005, affects: 'live' },

  { group: 'money', path: 'INCOME.FARE', min: 0, max: 5, step: 0.05, unit: '€', affects: 'live' },
  { group: 'money', path: 'INCOME.ADVERTISING_PER_TRIP', min: 0, max: 0.5, step: 0.01, unit: '€', affects: 'live' },
  { group: 'money', path: 'DIFFICULTY.{difficulty}.subsidyShare', min: 0, max: 1, step: 0.05, scale: 100, unit: '%', affects: 'live' },
  { group: 'money', path: 'COSTS.RUNNING_PER_VEHICLE_YEAR.bus', min: 0, max: 1e6, step: 10e3, scale: 1e-3, unit: 'k€/yr', affects: 'live' },
  { group: 'money', path: 'COSTS.RUNNING_PER_VEHICLE_YEAR.tram', min: 0, max: 3e6, step: 50e3, scale: 1e-3, unit: 'k€/yr', affects: 'live' },
  { group: 'money', path: 'COSTS.RUNNING_PER_VEHICLE_YEAR.metro', min: 0, max: 8e6, step: 100e3, scale: 1e-3, unit: 'k€/yr', affects: 'live' },
  { group: 'money', path: 'COSTS.RUNNING_PER_VEHICLE_YEAR.train', min: 0, max: 8e6, step: 100e3, scale: 1e-3, unit: 'k€/yr', affects: 'live' },

  { group: 'intercity', path: 'INTERCITY.INTERVAL_SIM_S', min: 300, max: 14400, step: 300, scale: 1 / 60, unit: 'min', affects: 'live' },
  { group: 'intercity', path: 'INTERCITY.PASSENGERS_PER_CALL', min: 0, max: 1000, step: 10, affects: 'live' },
  { group: 'intercity', path: 'INTERCITY.DROP_FRACTION', min: 0, max: 1, step: 0.05, scale: 100, unit: '%', affects: 'live' },
];

/**
 * The shipped value of every tunable, for every difficulty, captured before
 * any override is applied. Taken when this module first loads.
 */
const DEFAULTS = new Map();
for (const tunable of TUNABLES) {
  for (const path of expand(tunable.path)) DEFAULTS.set(path, readPath(path));
}

/** A tunable's concrete path for one game. */
export function resolvePath(path, difficulty) {
  return path.replace('{difficulty}', difficulty);
}

/** Every concrete path a templated one stands for. */
function expand(path) {
  return path.includes('{difficulty}')
    ? Object.keys(DIFFICULTY).map((difficulty) => resolvePath(path, difficulty))
    : [path];
}

function locate(path) {
  const [root, ...keys] = path.split('.');
  let object = ROOTS[root];
  for (const key of keys.slice(0, -1)) object = object?.[key];
  if (!object || typeof object !== 'object') return null;
  return { object, key: keys.at(-1) };
}

export function readPath(path) {
  const place = locate(path);
  return place ? place.object[place.key] : undefined;
}

export function defaultOf(path) {
  return DEFAULTS.get(path);
}

/**
 * Write one value and invalidate whatever depends on it.
 * @returns {boolean} whether the path is tunable and the value was written
 */
export function setTunable(game, path, value) {
  if (!DEFAULTS.has(path)) return false;
  const number = Number(value);
  if (!Number.isFinite(number)) return false;
  const place = locate(path);
  place.object[place.key] = number;

  const tunable = TUNABLES.find((entry) => expand(entry.path).includes(path));
  if (game) invalidateFor(game, tunable.affects);
  return true;
}

/** Throw away the caches a change of this kind makes stale. */
function invalidateFor(game, affects) {
  if (affects === 'demand') {
    game.demand.builtForVersion = -1;
  } else if (affects === 'network') {
    // Interchanges are grouped by distance, routes priced by penalty and
    // walking speed; touching the network rebuilds the router and the demand
    // table, and invalidating re-routes the passengers already out there.
    game.network.recomputeInterchanges();
    game.network.touch();
    game.invalidate();
  }
}

/** Every path whose value differs from its shipped default. */
export function overrides() {
  const changed = {};
  for (const [path, value] of DEFAULTS) {
    const current = readPath(path);
    if (current !== value) changed[path] = current;
  }
  return changed;
}

/** Put every value back as shipped. */
export function resetAll(game) {
  for (const [path, value] of DEFAULTS) {
    if (readPath(path) !== value) setTunable(game, path, value);
  }
}

/**
 * Apply saved overrides, ignoring any path that is no longer tunable — a
 * stale entry from an older build must not break the game.
 * @returns {number} how many were applied
 */
export function applyOverrides(game, saved) {
  let applied = 0;
  for (const [path, value] of Object.entries(saved || {})) {
    if (setTunable(game, path, value)) applied++;
  }
  return applied;
}

/**
 * The hand-back list: every changed value, old → new, one per line. Plain
 * text so it pastes anywhere, and exact so it can be written straight into
 * config.js.
 */
export function exportText() {
  const changed = overrides();
  const paths = Object.keys(changed);
  if (paths.length === 0) return 'OTOMIG tuning: all values at their defaults.';
  return [
    `OTOMIG tuning — ${paths.length} changed`,
    ...paths.map((path) => `${path}: ${DEFAULTS.get(path)} → ${changed[path]}`),
  ].join('\n');
}

// ─── Persistence ──────────────────────────────────────────────────────────────

export const STORAGE_KEY = 'otomig.tuning';

/** Read saved overrides. Storage can be missing or throw; then there are none. */
export function loadSaved(storage = globalThis.localStorage) {
  try {
    const text = storage?.getItem(STORAGE_KEY);
    return text ? JSON.parse(text) : {};
  } catch {
    return {};
  }
}

/** Save the current overrides, or clear the entry when there are none. */
export function saveCurrent(storage = globalThis.localStorage) {
  try {
    const changed = overrides();
    if (Object.keys(changed).length === 0) storage?.removeItem(STORAGE_KEY);
    else storage?.setItem(STORAGE_KEY, JSON.stringify(changed));
  } catch {
    // A private window or blocked storage: tuning still works, it just
    // does not survive a reload.
  }
}

/**
 * Live figures for the panel, so the effect of a slider can be read off
 * without waiting for the month's books.
 */
export function readout(game) {
  let ratePerSimSecond = 0;
  for (const rate of game.demand.pairRate.values()) ratePerSimSecond += rate;
  let waiting = 0;
  for (const stop of game.network.stops.values()) waiting += stop.waiting.length;
  let satisfactionSum = 0;
  let unhappyPairs = 0;
  for (const value of game.demand.satisfaction.values()) {
    if (value < 1) { satisfactionSum += value; unhappyPairs++; }
  }
  const people = (dots) => dots * game.passengersPerDot;

  return {
    // The pair rate is in people per sim second; a day is 18 h of service.
    tripsPerDay: ratePerSimSecond * CLOCK.DAILY_SCALE * Clock.simSecondsPerDay,
    pairs: game.demand.pairRate.size,
    waiting: people(waiting),
    onBoard: people(game.network.passengersOnNetwork - waiting),
    spawned: people(game.totals.spawned),
    arrived: people(game.totals.arrived),
    gaveUp: people(game.totals.gaveUp),
    unhappyPairs,
    meanUnhappySatisfaction: unhappyPairs ? satisfactionSum / unhappyPairs : 1,
    coverage: game.demand.coverageFraction(),
  };
}
