/**
 * After Phase 6 — what a dot means, timetables, flows, and the ferry
 * groundwork (HANDOFF.md §16 and §17).
 *
 * Imported by tests/run.js; `check` and `near` are passed in.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CLOCK, MODES, ROUTING, PATIENCE, DIFFICULTY, PLAYABLE_MODES, PLANNED_MODES, FERRY,
} from '../config.js';
import { reviveRegion } from '../model/region.js';
import { Game } from '../sim/game.js';
import { Vehicle } from '../sim/vehicles.js';
import { placeDot, patienceFor } from '../sim/passengers.js';
import { stopOrder, hopSeconds } from '../sim/routing.js';
import { Clock } from '../sim/clock.js';
import { setTunable, resetAll, readout } from '../sim/tuning.js';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'test-region.json');
const fixtureText = readFileSync(fixturePath, 'utf8');

function newGame(difficulty = 'creative') {
  const region = reviveRegion(JSON.parse(fixtureText));
  region.meta.difficulty = difficulty;
  region.meta.season = 'urban';
  return new Game(region);
}

const at = (game, x, y) => game.frame.toLonLat(x, y);

function buildLine(game, points, vehicles = 1) {
  game.startLine('bus');
  for (const [x, y] of points) game.extendDraft(...at(game, x, y));
  const line = game.finishDraft();
  while (line.vehicles.length < vehicles && game.addVehicle(line));
  return line;
}

function run(game, realSeconds, speedIndex = 3) {
  game.clock.setSpeedIndex(speedIndex);
  const step = CLOCK.TICK_MS / 1000;
  for (let t = 0; t < realSeconds; t += step) game.tick(step);
}

/** The expected wait a route charges for its first boarding. */
function firstWait(game, route) {
  const leg = route.legs[0];
  const line = game.network.lines.get(leg.lineId);
  const order = stopOrder(line, leg.direction);
  let ride = 0;
  for (let i = order.indexOf(leg.fromStop); order[i] !== leg.toStop; i++) {
    ride += hopSeconds(line, leg.direction, i);
  }
  return route.seconds - ride;
}

export function runPhase7Tests(check, near) {
  // ─── Capacity is in people ──────────────────────────────────────────────
  {
    const game = newGame();
    const line = buildLine(game, [[1600, 2800], [2600, 2800], [3400, 2800]]);
    const bus = new Vehicle(line);
    check('a vehicle on its own seats one dot per person', bus.seats === MODES.bus.capacity);
    bus.dotSize = 10;
    check('with 10-person dots a 50-person bus seats 5 dots', bus.seats === 5);
    bus.passengers = new Array(5).fill({});
    check('…and is full at 5', !bus.hasRoom && bus.load === 1);
    bus.dotSize = 60;
    check('a dot bigger than a bus still gets a seat', bus.seats === 1);

    // In play: pile 30 ten-person dots on a stop and watch the bus load.
    game.setDotSize(10);
    check('setting the dot size reaches every vehicle', line.vehicles.every((v) => v.dotSize === 10));
    game.tick(CLOCK.TICK_MS / 1000);
    for (let i = 0; i < 30; i++) placeDot(game, line.stops[0], line.stops[2]);
    let most = 0;
    game.clock.setSpeedIndex(3);
    for (let t = 0; t < 30; t += CLOCK.TICK_MS / 1000) {
      game.tick(CLOCK.TICK_MS / 1000);
      for (const vehicle of line.vehicles) most = Math.max(most, vehicle.passengers.length);
    }
    check('a bus never carries more people than its capacity', most > 0 && most * 10 <= MODES.bus.capacity,
      `${most} dots of 10`);
    check('a bought vehicle takes the game\'s dot size', game.addVehicle(line)
      && line.vehicles.at(-1).dotSize === 10);
  }

  // ─── The dot keeps its size for the whole game ──────────────────────────
  {
    const game = newGame();
    const line = buildLine(game, [[1600, 2800], [2600, 2800]]);
    game.setDotSize(7);
    const restored = Game.fromJSON(JSON.parse(JSON.stringify(game.toJSON('k'))), game.region);
    const restoredLine = restored.network.lines.get(line.id);
    check('a reload keeps the dot size the game began with, whatever the rule says now',
      restored.passengersPerDot === 7 && restored.demand.passengersPerDot === 7
      && restoredLine.vehicles.every((v) => v.dotSize === 7));
  }

  // ─── Timetables ─────────────────────────────────────────────────────────
  {
    // One bus on a long line: well past the timetable threshold.
    const game = newGame('hard');
    game.economy.balance = 1e9;
    const slow = buildLine(game, [[600, 2800], [2000, 2800], [3400, 2800], [4800, 2800]], 1);
    const fast = buildLine(game, [[1600, 3600], [2600, 3600], [3400, 3600]], 1);
    while (fast.headwayS > ROUTING.TIMETABLE_HEADWAY_S / 2 && game.addVehicle(fast));
    game.tick(CLOCK.TICK_MS / 1000);
    check('the test line runs less often than the timetable threshold',
      slow.headwayS > ROUTING.TIMETABLE_HEADWAY_S, `${Math.round(slow.headwayS)} s`);

    const slowRoute = game.router.route(slow.stops[0], slow.stops[1]);
    near('route choice counts a timetabled line\'s wait as the threshold\'s',
      firstWait(game, slowRoute), ROUTING.BOARDING_WAIT_FRACTION * ROUTING.TIMETABLE_HEADWAY_S, 1e-6);
    const fastRoute = game.router.route(fast.stops[0], fast.stops[1]);
    near('…while a frequent line still costs half its headway',
      firstWait(game, fastRoute), ROUTING.BOARDING_WAIT_FRACTION * fast.headwayS, 1e-6);

    const waitingSlow = placeDot(game, slow.stops[0], slow.stops[1]);
    const waitingFast = placeDot(game, fast.stops[0], fast.stops[1]);
    near('someone waiting for a timetabled line waits a full headway plus the grace',
      patienceFor(game, waitingSlow), slow.headwayS + PATIENCE.GRACE_SIM_S, 1e-6);
    near('…and for a frequent line, the difficulty\'s patience',
      patienceFor(game, waitingFast), DIFFICULTY.hard.patienceSimMinutes * 60, 1e-6);
  }
  {
    // The point of it: on Hard, a half-hourly bus loses its riders without
    // timetables and keeps them with.
    const gaveUp = (threshold) => {
      const game = newGame('hard');
      game.economy.balance = 1e9;
      buildLine(game, [[600, 2800], [2000, 2800], [3400, 2800], [4800, 2800]], 1);
      setTunable(game, 'ROUTING.TIMETABLE_HEADWAY_S', threshold);
      run(game, 120);
      resetAll(game);
      return { gaveUp: game.totals.gaveUp, spawned: game.totals.spawned };
    };
    const without = gaveUp(3600);
    const withTimetable = gaveUp(ROUTING.TIMETABLE_HEADWAY_S);
    check('ACCEPTANCE: without timetables, riders of an infrequent bus give up on Hard',
      without.gaveUp > 0, JSON.stringify(without));
    check('ACCEPTANCE: with timetables, they wait for it',
      withTimetable.gaveUp === 0 && withTimetable.spawned > 0, JSON.stringify(withTimetable));
  }

  // ─── Flows ──────────────────────────────────────────────────────────────
  {
    const game = newGame();
    buildLine(game, [[1600, 2800], [2600, 2800], [3400, 2800], [4400, 2800]]);
    buildLine(game, [[2600, 2800], [2600, 3800], [2600, 4600]]);
    game.tick(CLOCK.TICK_MS / 1000);
    const flows = game.demand.flows();
    const perDay = CLOCK.DAILY_SCALE * Clock.simSecondsPerDay;
    check('flows exist for a connected network', flows.length > 0);
    check('…busiest first', flows.every((f, i) => i === 0 || flows[i - 1].perDay >= f.perDay));
    check('…one per pair of stops, both directions together',
      new Set(flows.map((f) => `${f.a}|${f.b}`)).size === flows.length && flows.every((f) => f.a < f.b));
    const { a, b, perDay: busiest } = flows[0];
    near('…counting people a day both ways',
      busiest, ((game.demand.pairRate.get(`${a}|${b}`) ?? 0)
        + (game.demand.pairRate.get(`${b}|${a}`) ?? 0)) * perDay, 1e-6);
    near('…adding up to the day\'s expected trips',
      flows.reduce((sum, f) => sum + f.perDay, 0), readout(game).tripsPerDay, 1e-6);
    check('…and a limit keeps only the busiest', game.demand.flows(2).length === 2
      && game.demand.flows(2)[0] === flows[0]);

    setTunable(game, 'DEMAND.TRIPS_PER_RESIDENT', 0.8);
    game.tick(CLOCK.TICK_MS / 1000);
    near('flows follow a rebuilt demand table', game.demand.flows()[0].perDay, busiest * 2, 1e-6);
    resetAll(game);
  }

  // ─── Ferry groundwork ───────────────────────────────────────────────────
  {
    check('four modes are playable, in keyboard order',
      PLAYABLE_MODES.join() === 'bus,tram,metro,train');
    check('ferry is planned, not playable, and kept out of MODES so nothing meets it half-built',
      PLANNED_MODES.includes('ferry') && !PLAYABLE_MODES.includes('ferry') && !('ferry' in MODES));
    check('the ferry placeholders are all there for the phase that builds it',
      ['capacity', 'cruiseKmh', 'dwellS', 'vehicleCost', 'runningPerYear', 'terminalCost',
        'catchmentM'].every((key) => FERRY[key] > 0));
  }
}
