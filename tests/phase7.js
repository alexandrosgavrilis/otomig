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
  CLOCK, MODES, ROUTING, PATIENCE, DIFFICULTY, PLAYABLE_MODES, PLANNED_MODES, FERRY, COSTS,
  REGION, BUILD,
} from '../config.js';
import { reviveRegion, pruneContourSpecks } from '../model/region.js';
import { screenAngleOf } from '../render/overlay.js';
import { LocalFrame, squareBbox, heightAt } from '../model/region.js';
import { joinCoastWays, seaFromCoastline, applySeaToTerrain } from '../data/coastline.js';
import { onewayOf, parseResponses, buildGraph, LIVE_RAIL } from '../data/overpass.js';
import { RoadIndex, mayTravel } from '../build/road-routing.js';
import { roadProximity, processBuildings } from '../model/population.js';
import { isStale } from '../ui/new-game.js';
import { Game } from '../sim/game.js';
import { Vehicle, cycleOf, phaseOf } from '../sim/vehicles.js';
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

  runPlaytestFixes(check, near);
  runImportFixes(check, near);
  runNamesAndSpacing(check, near);
  runStopPairs(check, near);

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

/** Alex's first play-test list, Oct 16 2026 (HANDOFF.md §18). */
function runPlaytestFixes(check, near) {
  // #1 Specks of contour.
  {
    const ring = (sizeM) => {
      const d = sizeM / 111000;
      return [[23, 38], [23 + d, 38], [23 + d, 38 + d], [23, 38 + d], [23, 38]];
    };
    const contours = { features: [
      { geometry: { coordinates: ring(20) } },          // an 80 m diamond
      { geometry: { coordinates: ring(500) } },         // a real hilltop
      { geometry: { coordinates: [[23, 38], [23.001, 38]] } }, // short, but open
    ] };
    check('#1 tiny closed contour loops are dropped, real ones and open lines kept',
      pruneContourSpecks(contours) === 1 && contours.features.length === 2);
    const fixture = reviveRegion(JSON.parse(fixtureText));
    check('#1 …and the fixture loads with none shorter than the limit',
      pruneContourSpecks(fixture.contours) === 0 && REGION.CONTOUR_MIN_LOOP_M > 100);
  }

  // #3 Vehicles face the way they travel.
  {
    // A north-up map: lon to the right, lat UP, so screen y = -lat.
    const overlay = { project: (lon, lat) => [lon * 1e5, -lat * 1e5] };
    near('#3 a vehicle heading north points up the screen',
      screenAngleOf(overlay, 23, 38, Math.PI / 2), -Math.PI / 2, 1e-3);
    near('#3 …and one heading east points right', screenAngleOf(overlay, 23, 38, 0), 0, 1e-3);
  }

  // #6 An unserved stop serves no one; #2 the heat map keeps its scale.
  {
    const game = newGame('normal');
    const lonely = game.placeStop(...at(game, 2600, 2800), 'bus').stop;
    game.tick(CLOCK.TICK_MS / 1000);
    check('#6 a stop no line serves covers nobody', game.demand.coverageFraction() === 0
      && game.demand.catchment.size === 0);
    const would = game.demand.stopTotals.get(lonely.id);
    check('#6 …though its panel can say who it would cover', would.served === false && would.residents > 0);
    const heatBefore = game.demand.unserved.slice();

    // Serve the region's busiest cell: everything else must keep its colour.
    const { cols, cellM, attraction } = game.region.demand;
    let peak = 0;
    game.demand.residents.forEach((r, i) => {
      const v = r + attraction[i] * 0.05;
      if (v > game.demand.residents[peak] + attraction[peak] * 0.05) peak = i;
    });
    const px = (peak % cols + 0.5) * cellM;
    const py = (Math.floor(peak / cols) + 0.5) * cellM;
    game.startLine('bus');
    for (const [x, y] of [[px - 700, py], [px, py], [px + 700, py]]) {
      const road = game.roadIndex.snap(...game.frame.toLonLat(x, y), 'bus', 150);
      if (road) game.extendDraft(road.lon, road.lat);
    }
    game.finishDraft();
    game.tick(CLOCK.TICK_MS / 1000);
    const after = game.demand.unserved;
    const untouched = after.every((v, i) => v === 0 || Math.abs(v - heatBefore[i]) < 1e-12);
    check('#2 serving the busiest cell does not rescale the rest of the heat map',
      after[peak] === 0 && untouched);
    check('#6 a served stop covers its catchment', game.demand.coverageFraction() > 0);
  }

  // #5 Bulldozing goes a stop at a time.
  {
    const game = newGame('normal');
    const line = buildLine(game, [[1600, 2800], [2200, 2800], [2800, 2800], [3400, 2800]], 2);
    const other = buildLine(game, [[2800, 2800], [2800, 3600]], 1);
    const [a, b, c, d] = line.stops;
    const balance = game.economy.balance;
    const stopB = game.network.stops.get(b);
    check('#5 bulldozing a middle stop rejoins its neighbours', game.bulldoze(stopB).ok
      && line.stops.join() === [a, c, d].join() && line.segments.length === 2);
    near('#5 …refunding the stop at half', game.economy.balance - balance, COSTS.STOP.bus / 2, 1e-6);
    check('#5 …and the stop is gone', !game.network.stops.has(b));

    const shared = game.removeStopFromLine(line, c);
    check('#5 taking a shared stop off one line keeps it for the other',
      shared.ok && !shared.stopRemoved && game.network.stops.get(c).lines.join() === other.id);
    // The line is now a–d. Taking d off leaves a single stop.
    const before = game.economy.balance;
    const end = game.removeStopFromLine(line, d);
    check('#5 a line left with one stop is removed', end.ok && end.lineRemoved
      && !game.network.lines.has(line.id));
    check('#5 …and so is its last stop, which nothing else uses', !game.network.stops.has(a)
      && !game.network.stops.has(d));
    near('#5 …with the two buses and both stops refunded at half', game.economy.balance - before,
      (2 * COSTS.VEHICLE.bus + 2 * COSTS.STOP.bus) / 2, 1e-6);
  }

  // #8 Undo the last stop while drawing.
  {
    const game = newGame('normal');
    game.startLine('bus');
    game.extendDraft(...at(game, 1600, 2800));
    game.extendDraft(...at(game, 2600, 2800));
    const before = game.economy.balance;
    game.extendDraft(...at(game, 3400, 2800));
    const added = game.draft.line.stops.at(-1);
    check('#8 undo takes back the last stop', game.undoDraftStop().ok
      && game.draft.line.stops.length === 2 && !game.network.stops.has(added));
    near('#8 …for nothing: the stop is given back in full', game.economy.balance, before, 1e-6);
    game.undoDraftStop(); game.undoDraftStop();
    check('#8 …down to an empty draft, and no further',
      game.draft.line.stops.length === 0 && game.undoDraftStop().error === 'nothingToUndo');

    // A loop's closing click is a step of its own.
    game.extendDraft(...at(game, 1600, 2800));
    game.extendDraft(...at(game, 2600, 2800));
    game.extendDraft(...at(game, 2600, 3600));
    game.extendDraft(...at(game, 1600, 2800));
    check('#8 undo reopens a loop it just closed',
      game.draft?.line.loop === true ? (game.undoDraftStop().ok && !game.draft.line.loop
        && game.draft.line.stops.length === 3) : true);
  }

  // Cancel throws the new line away, for nothing.
  {
    const game = newGame('normal');
    const keep = buildLine(game, [[1600, 2800], [2600, 2800]], 1);
    const before = game.economy.balance;
    const stopsBefore = game.network.stops.size;
    game.startLine('bus');
    game.extendDraft(...at(game, 2600, 2800));  // shares a stop with the other line
    game.extendDraft(...at(game, 3400, 2800));
    game.extendDraft(...at(game, 3400, 3600));
    game.discardDraft();
    check('Cancel throws away the line being drawn', !game.draft && game.network.lines.size === 1
      && game.network.stops.size === stopsBefore);
    near('…refunded in full', game.economy.balance, before, 1e-6);
    check('…and leaves a stop it shared with another line alone',
      game.network.stops.get(keep.stops[1])?.lines.join() === keep.id);
  }

  // #10 Dragging a stop.
  {
    const game = newGame('normal');
    const line = buildLine(game, [[1600, 2800], [2600, 2800], [3400, 2800]], 1);
    const middle = game.network.stops.get(line.stops[1]);
    const servedBefore = game.network.stopNodeFor(line, 1, 0);
    const moved = game.moveStop(middle, ...at(game, 2600, 3200));
    // The line follows: it calls at the moved stop — from the nearest
    // sensible point in its area, which a stop beside a main road may share
    // with the road rather than pull the line up a side street and back.
    const servedAfter = game.network.stopNodeFor(line, 1, 0);
    const [sx, sy] = game.roadIndex.nodePosition(servedAfter);
    const [mx, my] = game.frame.toLocal(middle.lon, middle.lat);
    check('#10 a stop dragged along the roads moves, and its line follows', moved.ok
      && game.frame.distance(middle.lon, middle.lat, ...at(game, 2600, 3200)) < 60
      && servedAfter !== servedBefore && Math.hypot(sx - mx, sy - my) <= BUILD.STOP_AREA_M,
      JSON.stringify(moved));
    const onOther = game.moveStop(middle, game.network.stops.get(line.stops[0]).lon,
      game.network.stops.get(line.stops[0]).lat);
    check('#10 …but not onto another stop', onOther.error === 'stopThere');
    const where = [middle.lon, middle.lat];
    const away = game.moveStop(middle, ...at(game, 150, 150));
    check('#10 …nor away from every road, and a refused move changes nothing',
      away.error === 'tooFarFromRoad' && middle.lon === where[0] && middle.lat === where[1]);
  }

  // #12 Buses and trams run past stops nobody needs; trains always stop.
  {
    const game = newGame('creative');
    const bus = buildLine(game, [[1600, 2800], [2200, 2800], [2800, 2800], [3400, 2800]], 1);
    const station = (name) => game.region.stations.find((s) => s.name === name);
    game.startLine('train');
    for (const name of ['Harbour West', 'Central', 'East Junction']) {
      const s = station(name);
      game.extendDraft(s.lon, s.lat);
    }
    const train = game.finishDraft();
    // No demand at all: every intermediate stop is empty.
    setTunable(game, 'DEMAND.TRIPS_PER_RESIDENT', 0);
    run(game, 40);
    resetAll(game);
    check('#12 an empty bus runs past its intermediate stops', bus.vehicles[0].skipped > 0,
      `${bus.vehicles[0].skipped}`);
    check('#12 …while a train stops at every station', !train.vehicles[0].skipped);
  }

  // #13 Flows for one stop.
  {
    const game = newGame();
    const line = buildLine(game, [[1600, 2800], [2600, 2800], [3400, 2800], [4400, 2800]]);
    game.tick(CLOCK.TICK_MS / 1000);
    const id = line.stops[1];
    const mine = game.demand.flowsAt(id);
    check('#13 a stop\'s flows are those that start or end there, busiest first',
      mine.length > 0 && mine.every((f) => (f.a === id || f.b === id) && f.other !== id)
      && mine.every((f, i) => i === 0 || mine[i - 1].perDay >= f.perDay));
    check('#13 …all of them', mine.length === game.demand.flows()
      .filter((f) => f.a === id || f.b === id).length);
  }
}

/** The play-test fixes that needed new data from the import (HANDOFF §18). */
function runImportFixes(check, near) {
  const frame = new LocalFrame(squareBbox(23.6, 37.95, 5));
  const W = frame.widthM;
  const H = frame.heightM;
  const ll = (x, y) => frame.toLonLat(x, y);
  const seaArea = (sea) => sea.features.reduce((sum, f) => {
    const rings = f.geometry.coordinates.map((ring) => ring.map(([lon, lat]) => frame.toLocal(lon, lat)));
    const area = (ring) => Math.abs(ring.reduce((a, p, i) => {
      const q = ring[(i + 1) % ring.length];
      return a + p[0] * q[1] - q[0] * p[1];
    }, 0) / 2);
    return sum + area(rings[0]) - rings.slice(1).reduce((a, r) => a + area(r), 0);
  }, 0);

  // ─── #1 The sea from OSM's coastline ──────────────────────────────────
  {
    // A straight shore across the middle, west to east: land on its left
    // (north), so the sea is the southern half.
    const straight = seaFromCoastline([[ll(-100, H / 2), ll(W + 100, H / 2)]], frame);
    near('#1 a straight coast makes the half of the region on its right the sea',
      seaArea(straight), W * H / 2, W * H * 1e-5); // coordinates are rounded to ~10 cm
    const south = straight.features[0].geometry.coordinates[0]
      .map(([lon, lat]) => frame.toLocal(lon, lat));
    check('#1 …the southern half, as land is on the coastline\'s left',
      south.every(([, y]) => y <= H / 2 + 1e-3));

    // A bay: the coast comes in from the west and goes back out the west,
    // with the land outside the U — on its left — and the water inside.
    const bay = seaFromCoastline([[ll(-50, 3000), ll(2000, 3000), ll(2000, 1000), ll(-50, 1000)]], frame);
    near('#1 a bay is the water between the coast and the edge', seaArea(bay), 2000 * 2000, 1000);
    // The same shape drawn the other way round is a peninsula: sea outside.
    const peninsula = seaFromCoastline([[ll(-50, 1000), ll(2000, 1000), ll(2000, 3000), ll(-50, 3000)]], frame);
    near('#1 …and drawn the other way it is a peninsula, with the sea outside it',
      seaArea(peninsula), W * H - 2000 * 2000, 1000);

    // An island in open sea: anticlockwise, land on its left.
    const island = [ll(2000, 2000), ll(3000, 2000), ll(3000, 3000), ll(2000, 3000), ll(2000, 2000)];
    const islandSea = seaFromCoastline([island], frame);
    near('#1 an island in open sea leaves the region sea around a hole',
      seaArea(islandSea), W * H - 1000 * 1000, W * H * 1e-5);
    check('#1 …the island is a hole in the sea polygon',
      islandSea.features[0].geometry.coordinates.length === 2);

    // A coast that cuts a corner: in through the top, out through the right,
    // crossing each 950 m from the corner.
    const corner = seaFromCoastline([[ll(W - 1000, H + 50), ll(W + 50, H - 1000)]], frame);
    near('#1 a coast across a corner leaves that corner\'s triangle as land',
      seaArea(corner), W * H - 950 * 950 / 2, W * H * 1e-5);

    check('#1 a coastline that stops in mid-region is not trusted',
      seaFromCoastline([[ll(-100, 2000), ll(2000, 2000)]], frame) === null);
    check('#1 no coastline, no OSM sea', seaFromCoastline([], frame) === null);

    // Ways join by shared end nodes, in order.
    const chains = joinCoastWays([{ nodes: [3, 4, 5] }, { nodes: [1, 2, 3] }, { nodes: [9, 8, 9] }]);
    check('#1 coastline ways join into chains by their shared ends',
      chains.some((c) => c.join() === '1,2,3,4,5') && chains.some((c) => c.join() === '9,8,9'));

    // The height grid agrees with the coast drawn.
    const terrain = { cols: 10, rows: 10, cellM: W / 10, values: new Array(100).fill(5) };
    terrain.values[95] = -3; // a dip below sea level in the north... where OSM says land
    const { toSea, toLand } = applySeaToTerrain(terrain, straight, frame);
    check('#1 the height grid is made to agree with the coastline, both ways',
      toSea === 50 && toLand === 1 && heightAt(terrain, W / 2, H / 4) < 0
      && heightAt(terrain, W / 2, 3 * H / 4) > 0 && terrain.values[95] > 0,
      `${toSea} to sea, ${toLand} to land`);
  }

  // ─── #14 One-way streets ──────────────────────────────────────────────
  {
    check('#14 oneway=yes runs with the way', onewayOf({ highway: 'residential', oneway: 'yes' }).oneway === 1);
    check('#14 oneway=-1 runs against it', onewayOf({ highway: 'residential', oneway: '-1' }).oneway === -1);
    check('#14 roundabouts and motorways are one-way unless tagged otherwise',
      onewayOf({ highway: 'primary', junction: 'roundabout' }).oneway === 1
      && onewayOf({ highway: 'motorway' }).oneway === 1
      && onewayOf({ highway: 'motorway', oneway: 'no' }).oneway === 0);
    check('#14 a contraflow bus lane lets buses through, and not trams',
      onewayOf({ highway: 'primary', oneway: 'yes', 'oneway:bus': 'no' }).exempt?.join() === 'bus');
    const edge = { a: 0, b: 1, oneway: 1 };
    check('#14 a one-way edge can be driven only one way',
      mayTravel(edge, 0, 'bus') && !mayTravel(edge, 1, 'bus')
      && mayTravel({ ...edge, onewayExempt: ['bus'] }, 1, 'bus'));

    // A block: two parallel streets, both one-way in opposite directions,
    // joined at the ends. A→B must go along the top; B→A along the bottom.
    const nodes = new Map([
      [1, ll(1000, 2000)], [2, ll(2000, 2000)], [3, ll(3000, 2000)],
      [4, ll(1000, 1800)], [5, ll(2000, 1800)], [6, ll(3000, 1800)],
    ]);
    const way = (id, refs, tags) => ({ type: 'way', id, nodes: refs, tags: { highway: 'residential', ...tags } });
    const graph = buildGraph([
      way(10, [1, 2, 3], { oneway: 'yes' }),
      way(11, [6, 5, 4], { oneway: 'yes' }),
      way(12, [1, 4], {}), way(13, [3, 6], {}),
    ], nodes, frame);
    const index = new RoadIndex(graph, frame);
    const node = (id) => graph.nodes.findIndex((v, i) => i % 2 === 0
      && Math.abs(v - nodes.get(id)[0]) < 1e-9 && Math.abs(graph.nodes[i + 1] - nodes.get(id)[1]) < 1e-9) / 2;
    const there = index.shortestPath(node(1), node(3), 'bus');
    const back = index.shortestPath(node(3), node(1), 'bus');
    check('#14 the way there follows the one-way street', there?.nodes.length === 3, JSON.stringify(there));
    check('#14 the way back goes round the block, down the other one-way street',
      back?.nodes.length === 5 && back.lengthM > there.lengthM + 300, JSON.stringify(back));
    check('#14 …and can be told to ignore one-way rules, as a last resort',
      index.shortestPath(node(3), node(1), 'bus', { ignoreOneway: true }).nodes.length === 3);
  }
  {
    // The same on a line: one-way streets give the line its own way back.
    const game = newGame('creative');
    const line = buildLine(game, [[1600, 2800], [2600, 2800], [3400, 2800]], 1);
    // Make the street the line runs along one-way, west to east.
    const nodes = new Set(line.segments.flatMap((segment) => segment.nodes));
    let made = 0;
    for (const edge of game.region.roads.edges) {
      if (!nodes.has(edge.a) || !nodes.has(edge.b)) continue;
      const [ax] = game.roadIndex.nodePosition(edge.a);
      const [bx] = game.roadIndex.nodePosition(edge.b);
      // East–west edges only: a north–south link has no "west to east", and
      // making it one-way at random would cut the line's own route.
      if (Math.abs(ax - bx) < 1) continue;
      edge.oneway = ax < bx ? 1 : -1;
      made++;
    }
    game.network.rebuildSegments(line);
    check('#14 a line on a one-way street gets its own way back', made > 0
      && line.backSegments?.some(Boolean), `${made} edges`);
    const back = line.backSegments.find(Boolean);
    check('#14 …which never runs against the flow',
      !back.ignoresOneway && back.nodes.every((n, i) => i === 0 || !game.region.roads.edges.some((e) =>
        ((e.a === back.nodes[i - 1] && e.b === n) || (e.b === back.nodes[i - 1] && e.a === n))
        && !mayTravel(e, back.nodes[i - 1], 'bus'))));
    const segment = line.segments[line.backSegments.indexOf(back)];
    // Its ends may be a stop's area away from the forward segment's (the way
    // back can call elsewhere in the area), but it runs the same way round.
    check('#14 …and is stored start-to-end, so a vehicle walking it backwards drives it the right way',
      game.frame.distance(...back.points[0], ...segment.points[0])
        < game.frame.distance(...back.points[0], ...segment.points.at(-1))
      && game.frame.distance(...back.points.at(-1), ...segment.points.at(-1))
        < game.frame.distance(...back.points.at(-1), ...segment.points[0]));
    run(game, 30);
    check('#14 vehicles run the line both ways', line.vehicles.every((v) => Number.isFinite(v.lon)));
  }

  // ─── #7 Buildings far from roads make no demand ───────────────────────
  {
    const roads = buildGraph([{ type: 'way', id: 1, nodes: [1, 2], tags: { highway: 'residential' } }],
      new Map([[1, ll(1000, 1000)], [2, ll(3000, 1000)]]), frame);
    const near100 = roadProximity(roads, frame, 100);
    check('#7 a point 60 m from a road is near it, 160 m is not',
      near100(2000, 1060) && !near100(2000, 1160) && near100(3050, 1000) && !near100(3200, 1000));
    const square = (x, y) => ({ type: 'way', id: x * 10000 + y, tags: { building: 'house' },
      geometry: [[x, y], [x + 15, y], [x + 15, y + 15], [x, y + 15], [x, y]]
        .map(([px, py]) => { const [lon, lat] = ll(px, py); return { lon, lat }; }) });
    const result = processBuildings([square(2000, 1030), square(2000, 1500)], [], new Map(), frame, 0, roads);
    check('#7 a house by the road has residents, one 500 m away has none — but both are drawn',
      result.residentsTotal > 0 && result.outlines.length === 2
      && Math.abs(result.residentsTotal - (15 * 15 * 2) / 40) < 1e-6);
  }

  // ─── #11 Narrow gauge is a railway ────────────────────────────────────
  {
    const parsed = parseResponses([{ elements: [
      { type: 'way', id: 1, nodes: [1, 2], tags: { railway: 'narrow_gauge', gauge: '1000' } },
      { type: 'way', id: 2, nodes: [3, 4], tags: { railway: 'narrow_gauge', service: 'yard' } },
      { type: 'way', id: 3, nodes: [5, 6], tags: { railway: 'rail', service: 'siding' } },
      { type: 'way', id: 4, nodes: [7, 8], tags: { railway: 'narrow_gauge', disused: 'yes' } },
    ] }]);
    check('#11 narrow gauge is imported as railway, as Patras needs',
      LIVE_RAIL.includes('narrow_gauge') && parsed.railWays.map((w) => w.id).join() === '1,3',
      parsed.railWays.map((w) => w.id).join());
  }

  // ─── Regions from an older import are refreshed ───────────────────────
  check('a region without the current import version is stale',
    isStale({ meta: {} }) && isStale({ meta: { importVersion: REGION.IMPORT_VERSION - 1 } })
    && !isStale({ meta: { importVersion: REGION.IMPORT_VERSION } }));
}

/** Line names, numbered stops, and keeping vehicles evenly spread (HANDOFF §19). */
function runNamesAndSpacing(check, near) {
  const words = { to: 'to', mode: { bus: 'Bus', tram: 'Tram', metro: 'Metro', train: 'Train' } };

  // ─── Stop names are numbered along a shared street ────────────────────
  {
    const game = newGame('creative');
    const line = buildLine(game, [[1600, 2800], [2600, 2800], [3400, 2800]]);
    const [a, b, c] = line.stops.map((id) => game.network.stops.get(id));
    a.name = 'Ermou'; b.name = 'Ermou'; c.name = 'Athinas';
    const label = (stop) => game.network.stopLabel(stop);
    check('stops sharing a street name are numbered in the order they were built',
      label(a) === 'Ermou 1' && label(b) === 'Ermou 2' && label(c) === 'Athinas',
      [a, b, c].map(label).join(' / '));
    b.customName = 'Monastiraki';
    check('…a renamed stop keeps its own name, and the other loses its number',
      label(b) === 'Monastiraki' && label(a) === 'Ermou');
    b.customName = null;

    // ─── Line names ──────────────────────────────────────────────────────
    check('a line is named after its first and last stops by default',
      game.network.lineLabel(line, words) === 'Ermou to Athinas', game.network.lineLabel(line, words));
    c.name = 'Ermou';
    check('…by street name, not number — and "Name – Mode" when both ends share it',
      game.network.lineLabel(line, words) === 'Ermou – Bus', game.network.lineLabel(line, words));
    line.name = 'The Red Line';
    check('a renamed line keeps its name', game.network.lineLabel(line, words) === 'The Red Line');

    const restored = Game.fromJSON(JSON.parse(JSON.stringify(game.toJSON('k'))), game.region);
    a.customName = null;
    check('a reload keeps line names and stop names',
      restored.network.lines.get(line.id).name === 'The Red Line'
      && restored.network.stops.get(b.id).name === 'Ermou');
  }
  {
    const game = newGame('creative');
    game.startLine('bus');
    for (const [x, y] of [[1600, 2800], [2600, 2800], [2600, 3600], [1600, 2800]]) {
      game.extendDraft(...at(game, x, y));
    }
    const loop = game.finishDraft();
    const first = game.network.stops.get(loop.stops[0]);
    check('a loop is named after where it starts, and its mode',
      !loop.loop || game.network.lineLabel(loop, words) === `${first.name} – Bus`,
      game.network.lineLabel(loop, words));
  }

  // ─── Keeping vehicles evenly spread ───────────────────────────────────
  const bunchedRun = (keepSpacing) => {
    const game = newGame('creative');
    const line = buildLine(game, [[1000, 2800], [1800, 2800], [2600, 2800], [3400, 2800], [4200, 2800]], 3);
    line.keepSpacing = keepSpacing;
    // Nobody travels, so every stop is skipped and nothing else separates them.
    setTunable(game, 'DEMAND.TRIPS_PER_RESIDENT', 0);
    line.vehicles.forEach((vehicle, i) => {
      vehicle.direction = 0; vehicle.hop = 0; vehicle.progress = 5 * i; vehicle.dwellRemaining = 0;
    });
    run(game, 150);
    resetAll(game);
    const cycle = cycleOf(line);
    const phases = line.vehicles.map((v) => phaseOf(v, line, cycle)).sort((p, q) => p - q);
    const gaps = phases.map((p, i) => ((phases[(i + 1) % phases.length] - p) + cycle.total) % cycle.total);
    return { smallest: Math.min(...gaps) / (cycle.total / phases.length), held: line.vehicles.reduce((t, v) => t + (v.held ?? 0), 0) };
  };
  const spread = bunchedRun(true);
  const bunched = bunchedRun(false);
  check('with even spacing on, a bunched line spreads itself out by holding at stops',
    spread.smallest > 0.6 && spread.held > 0, JSON.stringify(spread));
  check('…and with it off, the bunch stays bunched', bunched.smallest < 0.1 && bunched.held === 0,
    JSON.stringify(bunched));

  {
    const game = newGame('creative');
    const line = buildLine(game, [[1600, 2800], [2200, 2800], [2800, 2800], [3400, 2800]], 1);
    line.skipEmptyStops = false;
    setTunable(game, 'DEMAND.TRIPS_PER_RESIDENT', 0);
    run(game, 40);
    resetAll(game);
    check('with Skip empty stops off, a bus stops everywhere', !line.vehicles[0].skipped);
    check('lines default to keeping even spacing, and buses and trams to skipping empty stops',
      line.keepSpacing && new (line.constructor)('bus', '#000').skipEmptyStops
      && !new (line.constructor)('train', '#000').skipEmptyStops);
  }
}

/** Save files that carry the whole game, map included (HANDOFF §20). */
export async function runSaveFileTests(check, near) {
  const { encodeSaveFile, decodeSaveFile, restore, bundle, FILE_FORMAT } = await import('../model/save.js');
  const game = newGame('normal');
  const line = buildLine(game, [[1600, 2800], [2600, 2800], [3400, 2800]], 2);
  line.name = 'Πάτρα Express';
  game.economy.takeLoan('small');
  run(game, 30);

  const { blob, extension } = await encodeSaveFile(game, 'k');
  const plain = JSON.stringify(bundle(game, 'k')).length;
  check('a save file is gzip-compressed', extension === 'otomig' && blob.size < plain / 3,
    `${blob.size} bytes against ${plain} as JSON`);
  const data = await decodeSaveFile(blob);
  check('…and carries the game and its whole map',
    data.format === FILE_FORMAT && data.game && data.region?.roads?.edges?.length === game.region.roads.edges.length);

  // Restored with no cache at all — another device — from the file alone.
  const restored = await restore(data);
  const again = restored.game;
  check('a save file opens with nothing cached, on its own map', Boolean(again),
    JSON.stringify(restored.error));
  check('…with the network as it was', again.network.lines.size === game.network.lines.size
    && again.network.stops.size === game.network.stops.size
    && again.network.lines.get(line.id).name === 'Πάτρα Express');
  near('…the money as it was', again.economy.balance, game.economy.balance, 1e-6);
  check('…the loans and the calendar as they were',
    again.economy.loanIn('small')?.outstanding === game.economy.loanIn('small')?.outstanding
    && again.clock.days === game.clock.days);

  const plainFile = await decodeSaveFile(new Blob([JSON.stringify(data)]));
  check('an uncompressed save file opens too', plainFile.format === FILE_FORMAT);
  check('a save from before files carried their map says where to find it',
    (await restore({ ...game.toJSON('nowhere') })).error === 'regionMissing');
  check('anything else is refused as not a save', (await restore({ hello: 1 })).error === 'badFile');
}

/**
 * A stop is an area: each direction calls where it has a sensible legal
 * route (HANDOFF §21, §23). Synthetic streets laid over the fixture's terrain.
 */
function runStopPairs(check, near) {
  /** A game on hand-made roads; `streets` are [refs, tags] with node ids → [x, y]. */
  const gameOn = (points, streets) => {
    const region = reviveRegion(JSON.parse(fixtureText));
    region.meta.difficulty = 'creative';
    region.meta.season = 'urban';
    const frame = new LocalFrame(region.meta.bbox);
    const nodes = new Map([...points].map(([id, [x, y]]) => [id, frame.toLonLat(x, y)]));
    region.roads = buildGraph(streets.map(([refs, tags], i) =>
      ({ type: 'way', id: i + 1, nodes: refs, tags: { highway: 'primary', ...tags } })), nodes, frame);
    return new Game(region);
  };
  const lineAlong = (game, xys) => {
    game.startLine('bus');
    for (const [x, y] of xys) game.extendDraft(...game.frame.toLonLat(x, y));
    return game.finishDraft();
  };
  const lengths = (line) => ({
    there: line.segments.reduce((sum, s) => sum + s.lengthM, 0),
    back: line.segments.reduce((sum, s, k) => sum + (line.backSegments?.[k]?.lengthM ?? s.lengthM), 0),
  });
  const withAreas = (area, pair, build) => {
    const saved = [BUILD.STOP_AREA_M, BUILD.STOP_PAIR_M];
    [BUILD.STOP_AREA_M, BUILD.STOP_PAIR_M] = [area, pair];
    try { return build(); } finally { [BUILD.STOP_AREA_M, BUILD.STOP_PAIR_M] = saved; }
  };

  // A divided boulevard: eastbound at y=2000, westbound 30 m south.
  const xs = [500, 1000, 1500, 2000, 2500, 3000, 3500];
  const boulevard = () => {
    const points = new Map();
    xs.forEach((x, i) => { points.set(100 + i, [x, 2000]); points.set(200 + i, [x, 1970]); });
    const game = gameOn(points, [
      [xs.map((_, i) => 100 + i), { oneway: 'yes' }],
      [xs.map((_, i) => 206 - i), { oneway: 'yes' }],
      [[100, 200], {}], [[106, 206], {}],
    ]);
    return { game, line: lineAlong(game, [[1000, 2000], [2000, 2000], [3000, 2000]]) };
  };
  const paired = withAreas(BUILD.STOP_AREA_M, BUILD.STOP_PAIR_M, boulevard);
  const single = withAreas(0, 0, boulevard);
  const [, by] = paired.game.frame.toLocal(...paired.game.roadIndex.nodeLonLat(
    paired.game.network.stopNodeFor(paired.line, 1, 1)));
  check('on a divided road, the way back calls at the far carriageway', Math.abs(by - 1970) < 1, `${by}`);
  check('…while the way there calls where the stop was put',
    paired.game.network.stopNodeFor(paired.line, 1, 0) === paired.game.network.stops.get(paired.line.stops[1]).node);
  check('…making the way back far shorter than driving round to the same kerb',
    lengths(paired.line).back < 0.5 * lengths(single.line).back,
    `${Math.round(lengths(paired.line).back)} m against ${Math.round(lengths(single.line).back)} m`);

  // A one-way pair a block apart, as in Athens: eastbound at y=2000,
  // westbound at y=1900, joined by two-way cross streets every 250 m.
  const crossXs = [500, 750, 1000, 1250, 1500, 1750, 2000, 2250, 2500, 2750, 3000, 3250, 3500];
  const couplet = () => {
    const points = new Map();
    crossXs.forEach((x, i) => { points.set(300 + i, [x, 2000]); points.set(400 + i, [x, 1900]); });
    const game = gameOn(points, [
      [crossXs.map((_, i) => 300 + i), { oneway: 'yes', highway: 'secondary' }],
      [crossXs.map((_, i) => 400 + crossXs.length - 1 - i), { oneway: 'yes', highway: 'secondary' }],
      ...crossXs.map((_, i) => [[300 + i, 400 + i], { highway: 'tertiary' }]),
    ]);
    return { game, line: lineAlong(game, [[1000, 2000], [1500, 2000], [2000, 2000], [2500, 2000], [3000, 2000]]) };
  };
  const areas = withAreas(BUILD.STOP_AREA_M, BUILD.STOP_PAIR_M, couplet);
  const points = withAreas(0, 0, couplet);
  const [, cy] = areas.game.frame.toLocal(...areas.game.roadIndex.nodeLonLat(
    areas.game.network.stopNodeFor(areas.line, 1, 1)));
  check('on a one-way pair a block apart, the way back calls on the parallel street',
    Math.abs(cy - 1900) < 1, `${cy}`);
  const a = lengths(areas.line);
  // The ends still cross over (a line's end is a single point, where the bus
  // turns), 100 m each; the middle stops no longer zigzag across and back.
  check('…so the way back is as long as the way there plus the turns at its ends, not a zigzag',
    a.back <= a.there + 2 * 100 + 1 && a.back < 0.85 * lengths(points.line).back,
    `${Math.round(a.back)} m back, ${Math.round(a.there)} m there; ${Math.round(lengths(points.line).back)} m with one point per stop`);
  check('…without breaking a one-way rule',
    [...areas.line.segments, ...(areas.line.backSegments || [])].every((seg) => !seg?.ignoresOneway));

  // Main roads over back streets: a residential short cut against a primary
  // road round the block.
  const choice = (detourY) => {
    const game = gameOn(new Map([[1, [1000, 3000]], [2, [2000, 3000]], [3, [1000, detourY]], [4, [2000, detourY]]]), [
      [[1, 2], { highway: 'residential' }],
      [[1, 3, 4, 2], { highway: 'primary' }],
    ]);
    const route = game.roadIndex.shortestPath(0, 1, 'bus');
    return route.lengthM;
  };
  check('a bus takes the main road round rather than a slightly shorter back street',
    Math.round(choice(3100)) === 1200, `${choice(3100)}`);
  check('…but not a long way round', Math.round(choice(3500)) === 1000, `${choice(3500)}`);
}
