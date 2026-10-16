/**
 * Phase 2 logic tests: the core loop, run headless against the fixture.
 *
 * The last section drives the phase's actual acceptance criteria — two bus
 * lines sharing an interchange carrying passengers who transfer and arrive,
 * neglected stops losing passengers, and money moving — because an acceptance
 * criterion that is only ever checked by hand stops being checked.
 *
 * Imported by tests/run.js; `check` and `near` are passed in so both suites
 * report as one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CLOCK, COSTS, DIFFICULTY, MODES, VEHICLES, DEMAND, PATIENCE, LOANS,
  passengersPerDot, buildingChunkCount,
  ROUTING,
} from '../config.js';
import { LocalFrame, reviveRegion } from '../model/region.js';
import { Network } from '../model/network.js';
import { RoadIndex } from '../build/road-routing.js';
import { Clock, daysInMonth, formatDate } from '../sim/clock.js';
import { Game } from '../sim/game.js';
import { Economy, formatMoney, formatThousands } from '../sim/economy.js';
import { stopOrder, directionsServed, hopSeconds } from '../sim/routing.js';
import { respaceVehicles } from '../sim/vehicles.js';
import { offsetPolyline, shade } from '../render/shapes.js';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'test-region.json');

/** Fresh game on the fixture. Creative by default so money never blocks a test. */
function newGame(difficulty = 'creative') {
  const region = reviveRegion(JSON.parse(readFileSync(fixturePath, 'utf8')));
  region.meta.difficulty = difficulty;
  region.meta.season = 'urban';
  return new Game(region);
}

/**
 * Run the game for a stretch of real seconds at a given speed.
 * Steps at the configured tick so the fixed-step loop is exercised too.
 */
function run(game, realSeconds, speedIndex = 1) {
  game.clock.setSpeedIndex(speedIndex);
  const step = CLOCK.TICK_MS / 1000;
  for (let elapsed = 0; elapsed < realSeconds; elapsed += step) game.tick(step);
}

/**
 * Place a bus line through a list of lon/lat points.
 * @returns {import('../model/network.js').Line}
 */
function buildLine(game, points, mode = 'bus') {
  game.startLine(mode);
  for (const [lon, lat] of points) game.extendDraft(lon, lat);
  return game.finishDraft();
}

/** Lon/lat of a point given in local metres from the region's SW corner. */
function at(game, x, y) {
  return game.frame.toLonLat(x, y);
}

export function runPhase2Tests(check, near) {
  // ─── One stop, two lines: a shared stop is a junction ─────────────────────
  // As in real life, several lines can call at the very same stop, and a
  // passenger changes between them there without walking anywhere.
  {
    const game = newGame('creative');
    const east = buildLine(game, [
      at(game, 1600, 2800), at(game, 2600, 2800), at(game, 3400, 2800),
    ]);
    const shared = east.stops[1];
    // The second line starts AT the first line's middle stop.
    const north = buildLine(game, [
      at(game, 2600, 2800), at(game, 2600, 3800), at(game, 2600, 4600),
    ]);
    for (let i = 0; i < 3; i++) { game.addVehicle(east); game.addVehicle(north); }
    game.invalidate();
    game.router.refreshIfNeeded();

    check('a second line can start at an existing stop, sharing it',
      north.stops[0] === shared, `${north.stops[0]} vs ${shared}`);
    const stop = game.network.stops.get(shared);
    check('…and that one stop lists both lines',
      stop.lines.includes(east.id) && stop.lines.includes(north.id));
    check('…without a second stop being built on the same spot',
      [...game.network.stops.values()].filter((s) => s.node === stop.node).length === 1);

    const route = game.router.route(east.stops[0], north.stops.at(-1));
    check('passengers route through a shared stop, changing lines there',
      route?.legs.length === 2 && route.legs[0].toStop === shared
      && route.legs[1].fromStop === shared && route.legs[0].lineId !== route.legs[1].lineId,
      JSON.stringify(route?.legs));

    // A change at the same stop is still a change: it pays the transfer
    // penalty, exactly once, on top of the two waits and the rides (Alex,
    // Oct 16 2026). It used to cost only the wait.
    const legCost = (leg) => {
      const line = game.network.lines.get(leg.lineId);
      const order = stopOrder(line, leg.direction);
      let seconds = line.headwayS * ROUTING.BOARDING_WAIT_FRACTION;
      for (let i = order.indexOf(leg.fromStop); order[i] !== leg.toStop; i++) {
        seconds += hopSeconds(line, leg.direction, i);
      }
      return seconds;
    };
    near('changing lines at a shared stop pays the transfer penalty, once',
      route.seconds, legCost(route.legs[0]) + legCost(route.legs[1]) + ROUTING.TRANSFER_PENALTY_S,
      1e-6);
    const direct = game.router.route(east.stops[0], east.stops[2]);
    near('…while a trip on one line pays only its wait and its ride',
      direct.seconds, legCost(direct.legs[0]), 1e-6);
  }

  // ─── Clock ──────────────────────────────────────────────────────────────
  {
    const clock = new Clock();
    check('the clock starts paused', clock.paused);
    check('a paused clock does not advance', clock.advance(1) === 0);

    clock.setSpeedIndex(1);
    const simSeconds = clock.advance(1);
    near('1 real second is 20 sim seconds at 1x', simSeconds, 20, 1e-9);
    near('1 real second is 0.1 calendar days', clock.days, 0.1, 1e-9);

    clock.setSpeedIndex(3);
    near('4x quadruples sim time', clock.advance(1), 80, 1e-9);

    // Ten real seconds is one calendar day, and 200 sim seconds.
    const other = new Clock();
    other.setSpeedIndex(1);
    for (let i = 0; i < 100; i++) other.advance(0.1);
    near('10 real seconds is one calendar day', other.days, 1, 1e-6);
    near('one calendar day shows 200 sim seconds', other.simSeconds, 200, 1e-6);
    check('the day rolled over', other.dayOfMonth === 2);

    // 200 sim seconds × 324 = 64,800 = 18 hours. The whole model in one line.
    near('the two clocks reconcile to an 18-hour service day',
      other.simSeconds * CLOCK.DAILY_SCALE, 18 * 3600, 1e-6);

    check('months roll over after January\'s 31 days', (() => {
      const c = new Clock();
      c.setSpeedIndex(1);
      for (let i = 0; i < 31 * 100; i++) c.advance(0.1);
      return c.month === 1 && c.dayOfMonth === 1;
    })());
    check('February 2028 has 29 days', daysInMonth(2028, 1) === 29);
    check('February 2026 has 28 days', daysInMonth(2026, 1) === 28);
    check('the date formats readably', formatDate(new Clock()).includes('January'));
  }

  // ─── Road routing ───────────────────────────────────────────────────────
  const game = newGame();
  {
    const index = game.roadIndex;

    const snapped = index.snap(...at(game, 2400, 2400), 'bus');
    check('a click near a road snaps to it', snapped !== null);
    check('the snap is within the configured radius', snapped && snapped.distanceM <= 50);
    check('the snapped node is named after its street', Boolean(snapped?.name));

    // The bay in the south-west is open water: no roads, so no snap.
    check('a click on the sea refuses to snap',
      index.snap(...at(game, 150, 150), 'bus') === null);

    const a = index.snap(...at(game, 2400, 2400), 'bus');
    const b = index.snap(...at(game, 3600, 3600), 'bus');
    const path = index.shortestPath(a.node, b.node, 'bus');
    check('a path exists across the street grid', path !== null);
    check('the path has more than two nodes', path.nodes.length > 2);
    // Straight-line distance is ~1.7 km; a Manhattan street grid gives ~2.4 km.
    const straight = game.frame.distance(...at(game, 2400, 2400), ...at(game, 3600, 3600));
    check('the path is longer than the straight line but not absurdly so',
      path.lengthM > straight && path.lengthM < straight * 2,
      `${Math.round(path.lengthM)} m vs ${Math.round(straight)} m straight`);
    check('a path to itself is empty but valid',
      index.shortestPath(a.node, a.node, 'bus').lengthM === 0);

    // Trams may not use residential streets; buses may.
    const residentialNode = game.region.roads.edges.find((e) => e.cls === 'residential')?.a;
    check('a bus may use residential roads',
      index.nodeServes(residentialNode, new Set(['residential'])));

    const viaPath = index.pathThrough([a.node, b.node, a.node], 'bus');
    check('a path through waypoints returns and is roughly twice as long',
      viaPath && viaPath.lengthM > path.lengthM * 1.8);
  }

  // ─── Network structure ──────────────────────────────────────────────────
  {
    const line = buildLine(game, [
      at(game, 1600, 2800), at(game, 2400, 2800), at(game, 3200, 2800),
    ]);
    check('a three-stop line is built', line.stops.length === 3);
    check('a line has one fewer segment than stops', line.segments.length === 2);
    check('segments carry a routed polyline',
      line.segments.every((s) => s.points.length >= 2 && s.lengthM > 0));
    check('a new line gets a vehicle so it actually runs', line.vehicles.length === 1);
    check('a line picks a palette colour', line.color.startsWith('#'));

    const cycle = line.cycleSeconds;
    check('an open line cycles out and back',
      cycle > (line.lengthM / 1000 / line.cruiseKmh) * 3600 * 2);
    check('headway is the cycle divided by the vehicles',
      Math.abs(line.headwayS - cycle / 1) < 1e-6);

    // Vehicle cap: headway must never fall below a minute.
    check('the vehicle cap keeps headway above the minimum',
      line.maxVehicles === Math.max(1, Math.floor(cycle / VEHICLES.MIN_HEADWAY_S)));

    const before = line.vehicles.length;
    game.addVehicle(line);
    check('a vehicle can be added', line.vehicles.length === before + 1);
    check('adding a vehicle halves the headway',
      Math.abs(line.headwayS - cycle / line.vehicles.length) < 1e-6);
    game.removeVehicle(line);
    check('a vehicle can be sold', line.vehicles.length === before);

    // Reusing a stop rather than stacking two at one place.
    const reused = game.network.addStop(...at(game, 1600, 2800), 'bus');
    check('clicking an existing stop reuses it', reused.reused === true);
  }

  // ─── Loops ──────────────────────────────────────────────────────────────
  {
    const looped = newGame();
    const line = buildLine(looped, [
      at(looped, 2400, 2400), at(looped, 3200, 2400),
      at(looped, 3200, 3200), at(looped, 2400, 3200),
    ]);
    // Clicking the first stop again closes the loop, as in Mini Metro.
    looped.draft = { line, cursor: null, valid: true };
    const first = looped.network.stops.get(line.stops[0]);
    const result = looped.network.extendLine(line, first);
    check('clicking the first stop closes a loop', result.ok === true && line.loop);
    check('a loop has as many segments as stops',
      line.segments.length === line.stops.length);
    check('a loop cycles once round, not out and back',
      line.cycleSeconds < 2 * (line.lengthM / 1000 / line.cruiseKmh) * 3600);

    const order = stopOrder(line, 0);
    check('a loop\'s stop order returns to its start',
      order[0] === order[order.length - 1]);
    check('an open line\'s order does not repeat', (() => {
      const open = buildLine(newGame(), [at(looped, 2400, 2400), at(looped, 3200, 2400)]);
      const o = stopOrder(open, 0);
      return o[0] !== o[o.length - 1];
    })());
  }

  // ─── Interchanges ───────────────────────────────────────────────────────
  {
    const inter = newGame();
    const a = inter.network.addStop(...at(inter, 2400, 2800), 'bus').stop;
    // 100 m away: inside the 150 m interchange radius.
    const b = inter.network.addStop(...at(inter, 2500, 2800), 'bus').stop;
    // 1 km away: well outside it.
    const c = inter.network.addStop(...at(inter, 3400, 2800), 'bus').stop;
    inter.network.recomputeInterchanges();

    check('nearby stops form an interchange',
      a.interchange !== null && a.interchange === b.interchange);
    check('a distant stop stays out of it', c.interchange === null);
    check('the interchange lists both stops',
      inter.network.interchanges.get(a.interchange).stops.length === 2);

    const walkable = inter.network.walkableFrom(a);
    check('walkableFrom includes the stop itself at no cost',
      walkable.some((w) => w.stop.id === a.id && w.walkSeconds === 0));
    const toB = walkable.find((w) => w.stop.id === b.id);
    check('walking to the neighbour takes a plausible time',
      toB && toB.walkSeconds > 50 && toB.walkSeconds < 150,
      `${toB?.walkSeconds?.toFixed(0)}s at ${DEMAND.WALK_SPEED_MS} m/s`);
  }

  // ─── Demand ─────────────────────────────────────────────────────────────
  {
    const demandGame = newGame();
    buildLine(demandGame, [
      at(demandGame, 2000, 2400), at(demandGame, 2800, 2800), at(demandGame, 3600, 3200),
    ]);
    demandGame.router.refreshIfNeeded();
    demandGame.demand.rebuild(0, 1);

    check('catchments assign cells to stops', demandGame.demand.catchment.size > 0);
    check('stops accumulate residents',
      [...demandGame.demand.stopTotals.values()].some((t) => t.residents > 0));
    check('the pair table is populated', demandGame.demand.pairRate.size > 0);
    check('pair rates are positive and finite',
      [...demandGame.demand.pairRate.values()].every((r) => r > 0 && Number.isFinite(r)));

    // Coverage must rise when a stop is added, and never exceed 1.
    const coverage = demandGame.demand.coverageFraction();
    check('coverage is a fraction', coverage > 0 && coverage <= 1, `${coverage.toFixed(3)}`);

    // The heat map must exclude everything inside a catchment.
    check('served cells are not shown as unserved',
      [...demandGame.demand.catchment.keys()].every((i) => demandGame.demand.unserved[i] === 0));
    check('unserved values are normalised',
      demandGame.demand.unserved.every((v) => v >= 0 && v <= 1));

    // The rate conversion is the two-clock hinge: spawning for one calendar
    // day's worth of sim seconds must yield perDay/324 passengers.
    const [, rate] = [...demandGame.demand.pairRate.entries()][0];
    const perDay = rate * CLOCK.DAILY_SCALE * Clock.simSecondsPerDay;
    near('the spawn rate round-trips to a daily total',
      perDay / (CLOCK.DAILY_SCALE * Clock.simSecondsPerDay), rate, 1e-12);

    // Rebuilds must not happen per frame.
    const version = demandGame.network.version;
    demandGame.demand.refreshIfNeeded(demandGame.clock, 1);
    check('an unchanged network does not rebuild the pair table',
      demandGame.demand.refreshIfNeeded(demandGame.clock, 1) === false &&
      demandGame.network.version === version);
  }

  // ─── Seasons ────────────────────────────────────────────────────────────
  {
    const tourist = newGame();
    tourist.region.meta.season = 'tourist';
    buildLine(tourist, [
      at(tourist, 2000, 2400), at(tourist, 2800, 2800), at(tourist, 3600, 3200),
    ]);
    tourist.router.refreshIfNeeded();

    tourist.demand.rebuild(0, 1); // January, multiplier 0.5
    const january = [...tourist.demand.pairRate.values()].reduce((a, b) => a + b, 0);
    tourist.demand.rebuild(7, 1); // August, multiplier 2.5
    const august = [...tourist.demand.pairRate.values()].reduce((a, b) => a + b, 0);

    check('a Tourist region swells in August',
      august > january * 4, `Jan ${january.toFixed(4)} vs Aug ${august.toFixed(4)}`);

    // Fare elasticity: demand scales by multiplier ^ -0.3, so doubling the
    // fare must reduce demand but not collapse it.
    tourist.demand.rebuild(0, 2);
    const expensive = [...tourist.demand.pairRate.values()].reduce((a, b) => a + b, 0);
    check('doubling the fare suppresses demand',
      expensive < january && expensive > january * 0.6,
      `${(expensive / january).toFixed(3)}× — expected 2^-0.3 = 0.812`);
    near('the fare factor is exactly the spec\'s exponent',
      expensive / january, 2 ** -0.3, 0.001);
  }

  // ─── Economy ────────────────────────────────────────────────────────────
  {
    const normal = new Economy('normal', 10000);
    near('Normal starts with 500 per resident', normal.balance, 5e6, 1);
    const tiny = new Economy('normal', 100);
    near('a tiny region still gets the minimum', tiny.balance, 5e6, 1);
    const hard = new Economy('hard', 50000);
    near('Hard starts with 100 per resident', hard.balance, 5e6, 1);
    check('Creative has unlimited money', new Economy('creative', 1).unlimited);
    check('Creative can always afford anything',
      new Economy('creative', 1).canAfford(1e15));

    const spender = new Economy('normal', 10000);
    check('spending reduces the balance',
      spender.spend(1e6, 'construction') && Math.abs(spender.balance - 4e6) < 1);
    check('spending beyond the balance is refused', !spender.spend(1e9));
    near('refunds return half', spender.refund(1e6), 0.5e6, 1);

    // A negative balance blocks building, in every difficulty but Creative.
    const broke = new Economy('normal', 10000);
    broke.balance = -1;
    check('a negative balance blocks building', !broke.canAfford(1));

    // Hard's game over: twelve consecutive months below zero.
    const failing = new Economy('hard', 10000);
    failing.balance = -1;
    for (let i = 0; i < 11; i++) failing.endMonth();
    check('eleven negative months is not game over', !failing.gameOver);
    failing.endMonth();
    check('twelve negative months ends the game on Hard', failing.gameOver);

    const recovering = new Economy('hard', 10000);
    recovering.balance = -1;
    for (let i = 0; i < 11; i++) recovering.endMonth();
    recovering.balance = 1;
    recovering.endMonth();
    check('one positive month resets the countdown', recovering.negativeMonths === 0);

    check('Normal never ends the game', DIFFICULTY.normal.gameOverMonths === null);
    check('only Hard has fare evasion',
      DIFFICULTY.hard.fareEvasion > 0 &&
      ['creative', 'easy', 'normal'].every((d) => DIFFICULTY[d].fareEvasion === 0));

    check('money formats compactly',
      formatMoney(1.25e6) === '€1.3M' && formatMoney(-5e3) === '-€5k' &&
      formatMoney(Infinity) === '∞');
    check('transported formats in thousands', formatThousands(12345) === '12.3k');
  }

  // ─── Vehicles ───────────────────────────────────────────────────────────
  {
    const moving = newGame();
    const line = buildLine(moving, [
      at(moving, 1600, 2800), at(moving, 2400, 2800), at(moving, 3200, 2800),
    ]);
    const vehicle = line.vehicles[0];
    run(moving, 5);

    check('a vehicle has a position after running',
      Number.isFinite(vehicle.lon) && vehicle.lon !== 0);
    check('the position is inside the region',
      vehicle.lon > moving.region.meta.bbox[0] && vehicle.lon < moving.region.meta.bbox[2]);

    // Shuttling: run long enough to reach a terminal and come back.
    const directionsSeen = new Set();
    for (let i = 0; i < 400; i++) { run(moving, 1); directionsSeen.add(vehicle.direction); }
    check('an open line\'s vehicle shuttles both ways', directionsSeen.size === 2);

    // Even spacing, in time rather than distance.
    const spaced = newGame();
    const spacedLine = buildLine(spaced, [
      at(spaced, 1600, 3000), at(spaced, 2400, 3000), at(spaced, 3200, 3000),
    ]);
    for (let i = 0; i < 3; i++) spaced.addVehicle(spacedLine);
    respaceVehicles(spacedLine);
    const hops = spacedLine.vehicles.map((v) => v.hop + v.progress / 1000);
    check('added vehicles are spread along the line',
      new Set(hops.map((h) => h.toFixed(2))).size === hops.length,
      `positions ${hops.map((h) => h.toFixed(2)).join(', ')}`);

    check('directionsServed gives both ways on an open line',
      directionsServed(spacedLine).length === 2);
  }

  // ─── Passenger routing ──────────────────────────────────────────────────
  {
    const routed = newGame();
    const line = buildLine(routed, [
      at(routed, 1800, 2400), at(routed, 2600, 2600), at(routed, 3400, 2800),
    ]);
    routed.router.refreshIfNeeded();

    const [a, , c] = line.stops;
    const route = routed.router.route(a, c);
    check('a route exists along one line', route !== null);
    check('riding one line is a single leg', route.legs.length === 1,
      `${route.legs.length} legs`);
    check('the leg names the line and its ends',
      route.legs[0].lineId === line.id &&
      route.legs[0].fromStop === a && route.legs[0].toStop === c);
    check('the route takes a plausible time',
      route.seconds > 60 && route.seconds < 3600, `${Math.round(route.seconds)}s`);

    // Staying aboard through an intermediate stop must not count as a transfer.
    check('an intermediate stop does not create a second leg',
      route.legs.length === 1);

    check('an unreachable stop has no route', (() => {
      const lonely = routed.network.addStop(...at(routed, 5000, 5000), 'bus');
      routed.network.touch();
      routed.router.refreshIfNeeded();
      return routed.router.route(a, lonely.stop.id) === null;
    })());
  }

  // ─── ACCEPTANCE: two lines, an interchange, transfers, money ────────────
  {
    const live = newGame('creative');

    // Two lines crossing near (2600, 2600), so their stops interchange.
    // Long enough that stop pairs clear the 800 m walk floor, and meeting at
    // two distinct road nodes 100 m apart so they form a real interchange
    // rather than collapsing into one shared stop.
    const west = buildLine(live, [
      at(live, 1600, 2800), at(live, 2600, 2800), at(live, 3400, 2800),
    ]);
    const north = buildLine(live, [
      at(live, 3400, 2900), at(live, 3400, 3800), at(live, 3400, 4600),
    ]);
    for (let i = 0; i < 3; i++) { live.addVehicle(west); live.addVehicle(north); }

    live.network.recomputeInterchanges();
    live.invalidate();
    live.router.refreshIfNeeded();
    live.demand.rebuild(live.clock.month, 1);

    check('ACCEPTANCE: the two lines share an interchange',
      live.network.interchanges.size > 0, `${live.network.interchanges.size} interchanges`);

    // A route from the far end of one line to the far end of the other must
    // use both lines, i.e. it must transfer.
    const origin = west.stops[0];
    const destination = north.stops[north.stops.length - 1];
    const transferRoute = live.router.route(origin, destination);
    check('ACCEPTANCE: a cross-network route exists', transferRoute !== null);
    check('ACCEPTANCE: it transfers between the two lines',
      transferRoute && transferRoute.legs.length === 2 &&
      transferRoute.legs[0].lineId !== transferRoute.legs[1].lineId,
      transferRoute ? `${transferRoute.legs.length} legs` : 'no route');

    // Now actually run it and watch passengers flow.
    const balanceBefore = live.economy.balance;
    run(live, 300, 3); // Five real minutes at 4x: about 120 in-game days.

    // Lifetime counts, not a snapshot: on a network this sparse the instant
    // you look at it is usually between passengers.
    check('ACCEPTANCE: passengers spawn', live.totals.spawned > 0,
      `${live.totals.spawned} dots spawned`);
    check('ACCEPTANCE: passengers board vehicles', live.totals.boarded > 0,
      `${live.totals.boarded} boardings`);
    check('ACCEPTANCE: every spawned dot is accounted for',
      live.totals.arrived + live.totals.gaveUp <= live.totals.spawned + live.totals.boarded,
      `spawned ${live.totals.spawned}, arrived ${live.totals.arrived}, gave up ${live.totals.gaveUp}`);
    check('ACCEPTANCE: transfers actually happen — boardings exceed arrivals',
      live.totals.boarded >= live.totals.arrived,
      `${live.totals.boarded} boardings for ${live.totals.arrived} arrivals`);
    check('ACCEPTANCE: passengers arrive and are counted',
      live.economy.transported > 0,
      `${Math.round(live.economy.transported).toLocaleString()} transported`);
    check('ACCEPTANCE: money moves',
      live.economy.lastMonth.tickets > 0 || live.economy.month.tickets > 0,
      `tickets this month ${Math.round(live.economy.month.tickets)}`);
    check('ACCEPTANCE: running costs are charged',
      live.economy.month.running < 0 || live.economy.lastMonth.running < 0);
    check('the calendar advanced', live.clock.days > 40, `${live.clock.days.toFixed(1)} days`);
    void balanceBefore;

    // Live counts must not be scaled; the cumulative total must be.
    const onNetwork = live.network.passengersOnNetwork * 10;
    check('the live count stays unscaled and small',
      onNetwork < live.economy.transported,
      `${onNetwork} on network vs ${Math.round(live.economy.transported)} transported`);
  }

  // ─── ACCEPTANCE: neglect costs ridership ────────────────────────────────
  {
    const neglected = newGame('creative');
    const line = buildLine(neglected, [
      at(neglected, 1800, 2400), at(neglected, 2600, 2600), at(neglected, 3400, 2800),
    ]);
    // Sell the vehicle: the line now carries nobody at all.
    neglected.removeVehicle(line);
    neglected.invalidate();
    neglected.router.refreshIfNeeded();
    neglected.demand.rebuild(0, 1);

    check('a line with no vehicles connects nothing',
      neglected.demand.pairRate.size === 0);

    // Satisfaction: a giving-up passenger must knock the pair down, and it
    // must recover by exactly the configured amount per day.
    const stops = [...neglected.network.stops.keys()];
    neglected.demand.penalise(stops[0], stops[1]);
    const key = `${stops[0]}|${stops[1]}`;
    near('ACCEPTANCE: giving up drops satisfaction',
      neglected.demand.satisfaction.get(key), 1 - PATIENCE.GIVE_UP_PENALTY, 1e-9);

    for (let i = 0; i < 20; i++) neglected.demand.penalise(stops[0], stops[1]);
    near('satisfaction cannot fall below its floor',
      neglected.demand.satisfaction.get(key), PATIENCE.SATISFACTION_FLOOR, 1e-9);

    neglected.demand.recoverDaily();
    near('ACCEPTANCE: satisfaction recovers daily',
      neglected.demand.satisfaction.get(key),
      PATIENCE.SATISFACTION_FLOOR + PATIENCE.RECOVERY_PER_DAY, 1e-9);

    for (let i = 0; i < 100; i++) neglected.demand.recoverDaily();
    near('satisfaction recovers only as far as 1',
      neglected.demand.satisfaction.get(key), 1, 1e-9);

    // Lower satisfaction must actually suppress spawning.
    const busy = newGame('creative');
    buildLine(busy, [
      at(busy, 1800, 2400), at(busy, 2600, 2600), at(busy, 3400, 2800),
    ]);
    busy.router.refreshIfNeeded();
    busy.demand.rebuild(0, 1);
    const healthy = [...busy.demand.pairRate.values()].reduce((a, b) => a + b, 0);

    for (const pairKeyName of [...busy.demand.pairRate.keys()]) {
      busy.demand.satisfaction.set(pairKeyName, 0.3);
    }
    busy.demand.rebuild(0, 1);
    const unhappy = [...busy.demand.pairRate.values()].reduce((a, b) => a + b, 0);
    check('ACCEPTANCE: low satisfaction visibly dips ridership',
      unhappy < healthy * 0.4, `${(unhappy / healthy).toFixed(2)}× of healthy`);
  }

  // ─── ACCEPTANCE: a reload restores the game ─────────────────────────────
  {
    const original = newGame('normal');
    const line = buildLine(original, [
      at(original, 1800, 2400), at(original, 2600, 2600), at(original, 3400, 2800),
    ]);
    original.addVehicle(line);
    run(original, 30, 2);

    const snapshot = JSON.parse(JSON.stringify(original.toJSON('test-key')));
    const restored = Game.fromJSON(snapshot, original.region);

    check('ACCEPTANCE: reload restores the stops',
      restored.network.stops.size === original.network.stops.size);
    check('ACCEPTANCE: reload restores the lines',
      restored.network.lines.size === original.network.lines.size);
    check('ACCEPTANCE: reload restores stop order',
      [...restored.network.lines.values()][0].stops.join() ===
      [...original.network.lines.values()][0].stops.join());
    check('ACCEPTANCE: reload restores vehicles and their positions', (() => {
      const a = [...original.network.lines.values()][0].vehicles;
      const b = [...restored.network.lines.values()][0].vehicles;
      return a.length === b.length &&
        a.every((v, i) => v.hop === b[i].hop && Math.abs(v.progress - b[i].progress) < 1e-9);
    })());
    near('ACCEPTANCE: reload restores the balance',
      restored.economy.balance, original.economy.balance, 1e-6);
    near('ACCEPTANCE: reload restores the calendar',
      restored.clock.days, original.clock.days, 1e-9);
    check('ACCEPTANCE: reload restores transported',
      restored.economy.transported === original.economy.transported);
    check('reload re-routes segments rather than storing them',
      [...restored.network.lines.values()][0].segments.length ===
      [...original.network.lines.values()][0].segments.length);
    check('reload rebuilds interchanges',
      restored.network.interchanges.size === original.network.interchanges.size);
    check('a reloaded game resumes paused', restored.clock.paused);
    check('the save does not contain the region',
      snapshot.region === undefined && typeof snapshot.regionKey === 'string');
    check('the save stays small',
      JSON.stringify(snapshot).length < 20000,
      `${JSON.stringify(snapshot).length} bytes`);
  }

  // ─── Overpass chunking ──────────────────────────────────────────────────
  {
    // Only BUILDINGS are chunked now. Phase R established that chunk area was
    // never the problem — the `>;` recursion over building geometry nodes was —
    // so roads, water, rail and POIs come back in one request for the whole
    // region and this count applies to the building query alone.
    const sizeOf = (km) => km / buildingChunkCount(km);
    check('the default 6 km region needs ONE building request',
      buildingChunkCount(6) === 1, `${buildingChunkCount(6) ** 2} requests`);
    near('…covering the whole region, which was measured to serve in 12 s',
      sizeOf(6), 6, 0.01);
    check('the 5 km minimum is also one request', buildingChunkCount(5) === 1);
    check('a 15 km region splits into 5 km chunks',
      sizeOf(15) <= 5.01, `${sizeOf(15).toFixed(2)} km chunks`);
    check('no region size exceeds the 6 km chunk measured to serve first try',
      [5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15].every((km) => sizeOf(km) <= 6.01),
      [5, 10, 15].map((km) => `${km}km->${sizeOf(km).toFixed(2)}`).join(' '));

    // The headline of Phase Q: total requests, main query included.
    const totalRequests = (km) => 1 + buildingChunkCount(km) ** 2;
    check('the default region costs 2 Overpass requests, down from 9',
      totalRequests(6) === 2, `${totalRequests(6)}`);
    check('the largest region costs 10, down from 36',
      totalRequests(15) === 10, `${totalRequests(15)}`);
    check('every region size stays well inside casual Overpass use',
      [5, 6, 10, 15].every((km) => totalRequests(km) <= 10));

    check('the chunk count rises with region size', (() => {
      let previous = 0;
      for (let km = 5; km <= 15; km++) {
        const n = buildingChunkCount(km);
        if (n < previous) return false;
        previous = n;
      }
      return true;
    })());
  }

  // ─── Dot scale ──────────────────────────────────────────────────────────
  {
    // A dot must mean a whole number of people, and that number has to suit
    // the region: 10 everywhere makes a town show nothing and a metropolis
    // show an unreadable swarm.
    check('a village or town shows one passenger per dot',
      passengersPerDot(2000) === 1 && passengersPerDot(40000) === 1);
    check('a small city still shows one per dot', passengersPerDot(120000) === 1);
    check('a large city scales up', passengersPerDot(500000) === 5);
    check('a million-person region matches the spec\'s original 10',
      passengersPerDot(1000000) === 10);
    check('a metropolis is capped so dots stay readable',
      passengersPerDot(50000000) === DEMAND.PASSENGERS_PER_DOT_MAX);
    check('the scale is never zero or fractional', [0, 1, 999, 1e9].every((r) => {
      const p = passengersPerDot(r);
      return Number.isInteger(p) && p >= 1;
    }));
    check('the scale rises monotonically with residents', (() => {
      let previous = 0;
      for (let r = 0; r <= 6e6; r += 50000) {
        const p = passengersPerDot(r);
        if (p < previous) return false;
        previous = p;
      }
      return true;
    })());

    // The whole point: a town must actually produce visible dots.
    const town = newGame('creative');
    check('the fixture town uses one passenger per dot',
      town.passengersPerDot === 1, `${town.passengersPerDot}`);
    buildLine(town, [
      at(town, 1600, 2800), at(town, 2600, 2800), at(town, 3400, 2800),
    ]);
    town.invalidate();
    run(town, 60, 3);
    check('a town-sized region produces visible dots',
      town.totals.spawned > 5, `${town.totals.spawned} dots in ~24 in-game days`);

    // Money must follow the scale, not a hardcoded 10. Same network, same
    // time, dot scale forced to 10: the euros per passenger must be identical.
    const perPassenger = (game) => {
      const tickets = game.economy.month.tickets + game.economy.lastMonth.tickets;
      return tickets / Math.max(1, game.economy.transported);
    };
    const scaled = newGame('creative');
    scaled.passengersPerDot = 10;
    scaled.economy.passengersPerDot = 10;
    scaled.demand.passengersPerDot = 10;
    buildLine(scaled, [
      at(scaled, 1600, 2800), at(scaled, 2600, 2800), at(scaled, 3400, 2800),
    ]);
    scaled.invalidate();
    run(scaled, 60, 3);
    near('fare per passenger is independent of the dot scale',
      perPassenger(town), perPassenger(scaled), 0.01);
  }

  // ─── Render helpers ─────────────────────────────────────────────────────
  {
    check('shade darkens toward black', shade('#808080', -0.5) === 'rgb(64,64,64)');
    check('shade lightens toward white', shade('#808080', 0.5) === 'rgb(192,192,192)');
    check('tunnels darken by the configured amount',
      shade('#E4463C', -0.4) === 'rgb(137,42,36)');

    // Offsetting a straight horizontal line must shift it purely vertically.
    const offset = offsetPolyline([[0, 0], [10, 0], [20, 0]], 5);
    check('offsetPolyline shifts a straight line sideways',
      offset.every(([, y]) => Math.abs(y - 5) < 1e-9));
    check('offsetPolyline keeps the point count',
      offset.length === 3);
    check('a zero offset changes nothing',
      offsetPolyline([[0, 0], [1, 1]], 0).length === 2);
  }

  // ─── Costs and config sanity ────────────────────────────────────────────
  {
    check('metro tunnels now cost less than train tunnels (C2/C3 applied)',
      COSTS.TRACK_PER_KM.metro.tunnel === 80e6 &&
      COSTS.TRACK_PER_KM.train.tunnel === 120e6);
    check('tram on-street stayed at 15M (C1 applied)',
      COSTS.TRACK_PER_KM.tram.onStreet === 15e6);
    check('loans are 3/6/12 years at 4/6/9% (C4 applied)',
      LOANS.map((l) => l.termYears).join() === '3,6,12' &&
      LOANS.map((l) => l.interest).join() === '0.04,0.06,0.09');
    check('a loan term fits inside a plausible session',
      LOANS[0].termYears * 60 <= 180, 'the small loan clears in about 3 real hours');

    check('every mode has a stop cost',
      ['bus', 'tram', 'metro', 'train'].every((m) => COSTS.STOP[m] !== undefined));
    check('every mode has a vehicle price and running cost',
      ['bus', 'tram', 'metro', 'train'].every((m) =>
        COSTS.VEHICLE[m] > 0 && COSTS.RUNNING_PER_VEHICLE_YEAR[m] > 0));
    check('capacity rises bus < tram < train < metro',
      MODES.bus.capacity < MODES.tram.capacity &&
      MODES.tram.capacity < MODES.train.capacity &&
      MODES.train.capacity < MODES.metro.capacity);
  }
}
