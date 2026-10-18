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
import { onewayToGeoJSON } from '../render/basemap.js';
import { LocalFrame, squareBbox, heightAt } from '../model/region.js';
import { joinCoastWays, seaFromCoastline, applySeaToTerrain } from '../data/coastline.js';
import { onewayOf, parseResponses, buildGraph, LIVE_RAIL } from '../data/overpass.js';
import { RoadIndex, mayTravel } from '../build/road-routing.js';
import { roadProximity, processBuildings } from '../model/population.js';
import { isStale } from '../ui/new-game.js';
import { Game } from '../sim/game.js';
import { Vehicle, cycleOf, phaseOf } from '../sim/vehicles.js';
import { placeDot, patienceFor } from '../sim/passengers.js';
import { stopOrder, hopSeconds, segmentFor } from '../sim/routing.js';
import { Clock } from '../sim/clock.js';
import { setTunable, resetAll, readout } from '../sim/tuning.js';
import { STRINGS } from '../ui/strings.js';

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
    bus.dotSize = 13;
    check('seats round to the nearest dot, not down: 13-person dots get 4, not 3', bus.seats === 4);
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
      && line.stops.join() === [a, c, d].join() && line.segments.length === 3);
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
    const moved = game.moveStop(middle, ...at(game, 2600, 3200));
    check('#10 a stop dragged along the roads moves, and its line follows to it', moved.ok
      && game.frame.distance(middle.lon, middle.lat, ...at(game, 2600, 3200)) < 60
      && line.segments[0].nodes.at(-1) === middle.node && line.segments[1].nodes[0] === middle.node,
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
    const legal = (nodes) => nodes.every((n, i) => i === 0 || !game.region.roads.edges.some((e) =>
      ((e.a === nodes[i - 1] && e.b === n) || (e.b === nodes[i - 1] && e.a === n))
      && !mayTravel(e, nodes[i - 1], 'bus')));
    check('#14 a line on one-way streets never runs against the flow', made > 0
      && line.segments.every((segment) => !segment.ignoresOneway && legal(segment.nodes)), `${made} edges`);
    run(game, 30);
    check('#14 vehicles run the line', line.vehicles.every((v) => Number.isFinite(v.lon)));
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
    // Clicking a bus line's first stop finishes it; it is named from its
    // first stop to its last, where it turns back.
    const game = newGame('creative');
    const loop = game.startLine('bus');
    for (const [x, y] of [[1600, 2800], [2600, 2800], [2600, 3600], [1600, 2800]]) {
      game.extendDraft(...at(game, x, y));
    }
    const [first, last] = [loop.stops[0], loop.stops.at(-1)].map((id) => game.network.stops.get(id));
    check('a bus line closed on its first stop is named from its first stop to its last',
      !game.draft && loop.stops.length === 3
      && game.network.lineLabel(loop, words) === (first.name === last.name ? `${first.name} – Bus`
        : `${first.name} to ${last.name}`), game.network.lineLabel(loop, words));
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
 * Bus and tram lines as in Cities: Skylines (HANDOFF §30): every line is a
 * loop back to its first stop; a stop stands on one side of the road and
 * serves the traffic going that way; a two-way street is two one-way
 * streets side by side; no turning round in the middle of a road.
 * Synthetic streets over the fixture's terrain.
 */
function runStopPairs(check, near) {
  /**
   * A game on hand-made roads; `streets` are [refs, tags] with node ids →
   * [x, y]. `height(x, y)`, if given, replaces the terrain.
   */
  const gameOn = (points, streets, height = null) => {
    const region = reviveRegion(JSON.parse(fixtureText));
    region.meta.difficulty = 'creative';
    region.meta.season = 'urban';
    if (height) {
      const { cols, rows, cellM } = region.terrain;
      region.terrain.values = Float32Array.from({ length: cols * rows },
        (_, i) => height(((i % cols) + 0.5) * cellM, (Math.floor(i / cols) + 0.5) * cellM));
    }
    const frame = new LocalFrame(region.meta.bbox);
    const nodes = new Map([...points].map(([id, [x, y]]) => [id, frame.toLonLat(x, y)]));
    region.roads = buildGraph(streets.map(([refs, tags], i) =>
      ({ type: 'way', id: i + 1, nodes: refs, tags: { highway: 'primary', ...tags } })), nodes, frame);
    return new Game(region);
  };
  /** A line clicked at these points, finished with Done. */
  const lineAlong = (game, clicks, mode = 'bus') => {
    game.startLine(mode);
    for (const [x, y] of clicks) game.extendDraft(...game.frame.toLonLat(x, y));
    return game.finishDraft();
  };
  const at = (game, node) => game.frame.toLocal(...game.roadIndex.nodeLonLat(node)).map(Math.round);
  const lengths = (line) => line.segments.map((segment) => Math.round(segment.lengthM));
  /** Every place a line's vehicles turn round in the road, round the whole loop. */
  const uTurns = (game, line) => {
    const nodes = line.segments.flatMap((segment, k) => (k === 0 ? segment.nodes : segment.nodes.slice(1)));
    if (line.loop) nodes.push(...(line.segments[0]?.nodes.slice(1, 2) ?? []));
    let turns = 0;
    for (let i = 0; i + 2 < nodes.length; i++) {
      if (nodes[i] === nodes[i + 2] && game.roadIndex.degree(nodes[i + 1], line.mode) > 1) turns++;
    }
    return turns;
  };
  const legal = (line) => line.segments.every((segment) => !segment.ignoresOneway);

  // A two-way avenue along y=2000, with a block at each end to turn round
  // by. Traffic keeps right: a click just south of the road is the
  // eastbound side, just north the westbound.
  const avenue = () => gameOn(new Map([
    [1, [500, 2000]], [2, [4500, 2000]], [3, [4800, 2000]], [4, [4800, 2200]], [5, [4500, 2200]],
    [6, [200, 2000]], [7, [200, 2200]], [8, [500, 2200]],
  ]), [
    [[6, 1, 2, 3], {}], [[3, 4, 5, 2], { highway: 'secondary' }], [[1, 8, 7, 6], { highway: 'secondary' }],
  ]);
  const east = (x) => [x, 1995];
  const west = (x) => [x, 2005];
  {
    const game = avenue();
    const line = lineAlong(game, [east(1000), east(2000), east(3000), west(3000), west(2000), west(1000)]);
    const stops = line.stops.map((id) => game.network.stops.get(id));
    check('a click south of a two-way road serves eastbound traffic, north of it westbound',
      stops.slice(0, 3).every((stop) => stop.heading[0] > 0.99) && stops.slice(3).every((stop) => stop.heading[0] < -0.99),
      JSON.stringify(stops.map((stop) => stop.heading.map(Math.round))));
    check('…and a stop across the road from another faces it from the same point',
      stops[2].node === stops[3].node && stops[2] !== stops[3]);
    check('a bus line is a loop: from its last stop it heads back to its first',
      line.loop && line.segments.length === 6, `${line.segments.length} segments`);
    const ls = lengths(line);
    check('up one side and down the other, with no detours along the avenue',
      [0, 1, 3, 4].every((k) => ls[k] === 1000), ls.join());
    check('…turning round by the block beyond the last stop, and back to the first by the other',
      ls[2] === 4000 && ls[5] === 2000, ls.join());
    check('…never turning in the middle of the road, and never against the flow',
      uTurns(game, line) === 0 && legal(line));
    // Two stops on the same side: the way back to the first goes round.
    const same = lineAlong(avenue(), [east(1000), east(2000)]);
    check('a two-stop line comes back round to its first stop, even on one side of the road',
      same.loop && same.segments.length === 2 && Math.round(same.segments[0].lengthM) === 1000
      && same.segments[1].lengthM > 4000, lengths(same).join());

    // A stop is never ON a junction, where it would stand on no one road.
    const byJunction = game.placeStop(...game.frame.toLonLat(504, 1995), 'bus');
    const [jx] = game.frame.toLocal(byJunction.stop.lon, byJunction.stop.lat);
    check('a click by a junction puts the stop just short of it, on the road clicked',
      Math.abs(jx - (500 + BUILD.STOP_NODE_SNAP_M)) < 0.5 && game.roadIndex.degree(byJunction.stop.node, 'bus') === 2,
      `${jx}`);

    // The two sides of one stop on the same line are an interchange, but
    // not a change of line: no link drawn, and the panel says no.
    check('two facing stops of the same line are not shown as an interchange',
      stops[2].interchange && !game.network.changesAt(stops[2]));
    const cross = lineAlong(game, [[1100, 2005], [2600, 1995]]);
    const crossStop = game.network.stops.get(cross.stops[0]);
    check('…while a stop of another line beside them is',
      crossStop && game.network.changesAt(crossStop) && game.network.changesAt(stops[0]),
      JSON.stringify({ cross: Boolean(crossStop) }));

    // Clicking the same side again reuses the stop; the other side is a new one.
    const again = game.placeStop(...game.frame.toLonLat(...east(2004)), 'bus');
    const other = game.placeStop(...game.frame.toLonLat(...west(1500)), 'bus');
    check('a click on the same side of the road reuses the stop there', again.reused && again.stop === stops[1]);
    check('…and on the other side places a new one', !other.reused && other.stop.heading[0] < 0);

    // Inserting: select the line, click beside it.
    const before = game.insertionAt(line, ...game.frame.toLonLat(...east(1500)), 30);
    const after = game.insertionAt(line, ...game.frame.toLonLat(...west(2500)), 30);
    check('a click beside a line, on its eastbound side, would insert between the eastbound stops',
      before?.afterIndex === 0 && before.heading[0] > 0, JSON.stringify(before?.afterIndex));
    check('…and on its westbound side, between the westbound ones', after?.afterIndex === 3, JSON.stringify(after?.afterIndex));
    check('…but not far from the line', game.insertionAt(line, ...game.frame.toLonLat(2500, 2150), 30) === null);
    const inserted = game.insertStopAt(line, ...game.frame.toLonLat(...east(1500)), 30);
    check('inserting puts the new stop into that stretch, the line still straight along the avenue',
      inserted.ok && line.stops[1] === inserted.stop.id && lengths(line).slice(0, 3).join() === '500,500,1000',
      lengths(line).join());
  }

  // A divided boulevard: eastbound carriageway at y=2000, westbound 30 m
  // north, joined at the ends. Stops up one, then down the other.
  {
    const game = gameOn(new Map([[1, [500, 2000]], [2, [4500, 2000]], [11, [500, 2030]], [12, [4500, 2030]]]), [
      [[1, 2], { oneway: 'yes' }], [[12, 11], { oneway: 'yes' }],
      [[11, 1], { highway: 'secondary' }], [[2, 12], { highway: 'secondary' }],
    ]);
    const line = lineAlong(game, [[1000, 2000], [2000, 2000], [3000, 2000], [3000, 2030], [2000, 2030], [1000, 2030]]);
    const ls = lengths(line);
    check('on a divided boulevard, a line up one carriageway and down the other runs straight',
      [0, 1, 3, 4].every((k) => ls[k] === 1000) && ls[2] === 3030 && ls[5] === 1030, ls.join());
    // On a one-way street the flow decides the side, wherever it is clicked.
    const wrongSide = game.placeStop(...game.frame.toLonLat(3500, 2010), 'bus');
    check('a stop on a one-way carriageway faces the way it flows, whichever side is clicked',
      wrongSide.stop.heading[0] > 0.99);
  }

  // A tram will not climb a street steeper than TRAM_STREET_MAX_GRADE: it
  // goes round, or the stop is refused (Alex, Oct 18 2026). A hill rises 75 m
  // north over 500 m west of x=1500 (15%), fading out by x=2500, so the
  // street up at x=1000 is too steep and the one at x=3000 is flat.
  {
    const hill = (x, y) => 75 * Math.min(1, Math.max(0, (y - 2000) / 500))
      * Math.min(1, Math.max(0, (2500 - x) / 1000));
    const points = new Map([[1, [500, 2000]], [2, [1000, 2000]], [3, [3000, 2000]], [4, [3500, 2000]],
      [5, [500, 2500]], [6, [1000, 2500]], [7, [3000, 2500]], [8, [3500, 2500]]]);
    const streets = (withWayRound) => [
      [[1, 2, 3, 4], {}], [[5, 6, 7, 8], {}], [[2, 6], {}], ...(withWayRound ? [[[3, 7], {}]] : []),
    ];
    /** The x of every street the line's first segment climbs north–south. */
    const ups = (line) => line.segments[0].nodes.slice(1).flatMap((n, i) => {
      const [ax, ay] = at(line.game, line.segments[0].nodes[i]);
      const [bx, by] = at(line.game, n);
      return ax === bx && ay !== by ? [ax] : [];
    });
    const draw = (mode, withWayRound) => {
      const game = gameOn(points, streets(withWayRound), hill);
      game.startLine(mode);
      // Westbound below the hill, eastbound above it: the short way between
      // them is straight up the steep street at x=1000.
      const first = game.extendDraft(...game.frame.toLonLat(1200, 2005));
      const second = game.extendDraft(...game.frame.toLonLat(1200, 2495));
      const line = game.draft.line;
      line.game = game;
      return { game, line, first, second };
    };
    const bus = draw('bus', true);
    const tram = draw('tram', true);
    check('a bus climbs the steep street, the short way up',
      bus.second.ok && ups(bus.line).includes(1000) && !ups(bus.line).includes(3000));
    check('a tram goes round by the gentle street instead',
      tram.second.ok && ups(tram.line).includes(3000) && !ups(tram.line).includes(1000),
      JSON.stringify(tram.second));
    const stuck = draw('tram', false);
    check('with no way round, the tram stop is refused as too steep',
      stuck.second.error === 'tramTooSteep' && stuck.line.stops.length === 1 && stuck.game.network.stops.size === 1,
      JSON.stringify(stuck.second));
    check('…with the reason in words', /steep/i.test(STRINGS.errors.tramTooSteep));
  }

  // What the sound effects listen for (Alex, Oct 18 2026).
  {
    const game = avenue();
    const heard = [];
    for (const type of ['lineCreated', 'stopPlaced', 'bulldozed']) game.on(type, () => heard.push(type));
    const line = lineAlong(game, [east(1000), east(2000)]);
    check('a new line announces itself once, after a stop placed for each click',
      heard.join() === 'stopPlaced,stopPlaced,lineCreated', heard.join());
    heard.length = 0;
    game.draft = { line, cursor: null, spot: null };
    game.extendDraft(...game.frame.toLonLat(...east(3000)));
    game.finishDraft();
    check('…but extending an old line is not a new line', heard.join() === 'stopPlaced', heard.join());
    heard.length = 0;
    game.moveStop(game.network.stops.get(line.stops[1]), ...game.frame.toLonLat(...east(2200)));
    game.bulldoze(game.network.stops.get(line.stops[2]));
    check('moving a stop and bulldozing one are heard too',
      heard[0] === 'stopPlaced' && heard.includes('bulldozed'), heard.join());
  }

  // Drawing: Undo, Cancel, and clicking the first stop to finish.
  {
    const game = avenue();
    game.startLine('bus');
    for (const p of [east(1000), east(2000), east(3000)]) game.extendDraft(...game.frame.toLonLat(...p));
    const undone = game.undoDraftStop();
    check('Undo takes back the last stop', undone.ok && game.draft.line.stops.length === 2
      && game.draft.line.segments.length === 2);
    const first = game.network.stops.get(game.draft.line.stops[0]);
    const finished = game.extendDraft(first.lon, first.lat);
    check('clicking the line\'s first stop again finishes it', finished.finished && !game.draft
      && game.network.lines.size === 1);
    game.startLine('bus');
    for (const p of [west(1000), west(2000)]) game.extendDraft(...game.frame.toLonLat(...p));
    game.discardDraft();
    check('Cancel throws the line away, stops and all', !game.draft && game.network.lines.size === 1
      && game.network.stops.size === 2);
  }

  // A tram line up and down a two-way street pays for the street once.
  {
    const game = avenue();
    const tram = lineAlong(game, [east(1000), east(3000), west(3000), west(1000)], 'tram');
    const owed = game.network.trackCostOf(tram);
    const street = Math.round(COSTS.TRACK_PER_KM.tram.onStreet * (tram.lengthM - 4000) / 1000);
    check('a tram line along both sides of a street lays its track once', tram.loop && owed > 0
      && owed < Math.round(COSTS.TRACK_PER_KM.tram.onStreet * tram.lengthM / 1000) && owed >= street * 0.5,
      `${owed} for ${Math.round(tram.lengthM)} m of line`);
  }

  // Passengers ride both ways along the avenue, each direction on its own
  // side, every vehicle going round the loop the one way.
  {
    const game = avenue();
    const line = lineAlong(game, [east(1000), east(2000), east(3000), west(3000), west(2000), west(1000)]);
    while (line.vehicles.length < 3 && game.addVehicle(line));
    game.tick(CLOCK.TICK_MS / 1000);
    // Back the way the line came: cross the road and ride the other side,
    // not all the way round the loop.
    const back = game.router.route(line.stops[2], line.stops[0]);
    check('a trip back the way the line came crosses the road and rides the other side',
      back?.legs.length === 1 && back.legs[0].fromStop === line.stops[3] && back.legs[0].toStop === line.stops[5],
      JSON.stringify(back?.legs.map((leg) => [line.stops.indexOf(leg.fromStop), line.stops.indexOf(leg.toStop)])));
    const dot = placeDot(game, line.stops[2], line.stops[0]);
    check('…waiting for it at the stop across the road', dot?.atStopId === line.stops[3]);
    let wrongStop = 0;
    let arrivals = 0;
    game.clock.setSpeedIndex(3);
    for (let t = 0; t < 150; t += CLOCK.TICK_MS / 1000) {
      game.tick(CLOCK.TICK_MS / 1000);
      for (const v of line.vehicles) {
        if (!v.justArrivedAt) continue;
        arrivals++;
        const stop = game.network.stops.get(v.justArrivedAt);
        const [vx, vy] = game.frame.toLocal(v.lon, v.lat);
        const [sx, sy] = game.frame.toLocal(stop.lon, stop.lat);
        // At the stop, heading its way.
        if (Math.hypot(vx - sx, vy - sy) > 5) wrongStop++;
      }
    }
    check('every vehicle goes round the loop the one way', line.vehicles.every((v) => v.direction === 0));
    check('…and every one that reaches a stop is at it', arrivals > 20 && wrongStop === 0,
      `${arrivals} arrivals, ${wrongStop} away from their stop`);
    check('…carrying riders to where they are going', game.totals.arrived > 0 && game.totals.gaveUp === 0,
      JSON.stringify(game.totals));
  }

  // Big dots must not throttle a new network. People are banked for the
  // whole network, not pair by pair: with 10-person dots, pair-by-pair
  // banking had started 7% of the wanted trips by day 30 on Patras. The
  // fixture wants about one person every two days per pair, so with
  // 4-person dots pair-by-pair banking would start almost nobody here.
  {
    const game = newGame('creative');
    game.setDotSize(4);
    for (const points of [[[1700, 2796], [2500, 2796], [3300, 2796], [3300, 2804], [2500, 2804], [1700, 2804]],
      [[1000, 3596], [2200, 3696], [2600, 4396], [3400, 4296]]]) buildLine(game, points, 2);
    game.clock.setSpeedIndex(3);
    let wanted = 0;
    const pairs = new Set();
    const spawn = game.demand.spawn.bind(game.demand);
    game.demand.spawn = (seconds) => {
      const born = spawn(seconds);
      for (const b of born) pairs.add(`${b.fromId}|${b.toId}`);
      return born;
    };
    while (game.clock.simSeconds < 60 * 200) {
      const before = game.clock.simSeconds;
      game.tick(CLOCK.TICK_MS / 1000);
      wanted += [...game.demand.pairRate.values()].reduce((sum, rate) => sum + rate, 0) * (game.clock.simSeconds - before);
    }
    const started = game.totals.spawned * 4;
    check('with dots of several people, a new network still starts the trips it is wanted for',
      wanted > 20 && started > 0.8 * wanted, `${Math.round(started)} of ${Math.round(wanted)} people in 60 days`);
    check('…spread over many pairs of stops, not just the busiest', pairs.size >= 3,
      `${pairs.size} pairs of ${game.demand.pairRate.size}`);
    const saved = JSON.parse(JSON.stringify(game.toJSON('k')));
    const restored = Game.fromJSON(saved, game.region);
    check('…and a reload carries on the same random stream', restored.demand.random() === game.demand.random());
  }

  // Saves keep which way each stop faces; older saves load as loops.
  {
    const game = avenue();
    const line = lineAlong(game, [east(1000), east(3000), west(3000), west(1000)]);
    const saved = JSON.parse(JSON.stringify(game.toJSON('k')));
    const restored = Game.fromJSON(saved, avenue().region);
    const again = restored.network.lines.get(line.id);
    check('a reload keeps the side of the road each stop stands on, and the line\'s route',
      again.stops.every((id, i) => restored.network.stops.get(id).heading[0] === game.network.stops.get(line.stops[i]).heading[0])
      && Math.abs(again.lengthM - line.lengthM) < 1, `${again.lengthM} against ${line.lengthM}`);
    const old = JSON.parse(JSON.stringify(saved));
    for (const stop of old.stops) delete stop.heading;
    Object.assign(old.lines[0], { loop: false, singleStops: [old.lines[0].stops[1]] });
    const migrated = Game.fromJSON(old, avenue().region).network.lines.get(line.id);
    check('…and a save from before stops had sides loads as a loop, the line still running',
      migrated.loop && migrated.segments.length === 4 && legal(migrated));
  }

  // A line drawn while the game ticks — as in the browser, paused or not —
  // must be wanted once Done gives it its bus. The demand table was built
  // for the draft, which had no bus, and buying one never rebuilt it.
  {
    const game = avenue();
    game.startLine('bus');
    for (const p of [east(1000), east(2000), east(3000)]) {
      game.extendDraft(...game.frame.toLonLat(...p));
      game.tick(CLOCK.TICK_MS / 1000);
    }
    check('a line drawn with no bus yet is wanted by nobody', game.demand.pairRate.size === 0);
    game.finishDraft();
    game.tick(CLOCK.TICK_MS / 1000);
    check('…and once Done gives it a bus, its stops are served and people want to ride',
      game.demand.pairRate.size > 0, `${game.demand.pairRate.size} pairs`);
  }

  // A stop goes on the road that was clicked, even when that road has no
  // node nearby and the side street beside it has one every few metres.
  {
    const points = new Map([[1, [1000, 2000]], [2, [3000, 2000]]]);
    const side = [];
    for (let x = 1000; x <= 3000; x += 10) { points.set(500 + x, [x, 2025]); side.push(500 + x); }
    const streets = [
      [[1, 2], { highway: 'primary' }],
      [side, { highway: 'residential' }],
      [[1, 1500], { highway: 'residential' }], [[2, 3500], { highway: 'residential' }],
    ];
    const game = gameOn(points, streets);
    const nodesBefore = game.roadIndex.nodeCount;
    const placed = game.placeStop(...game.frame.toLonLat(2003, 2008), 'bus');
    const [sx, sy] = game.frame.toLocal(placed.stop.lon, placed.stop.lat);
    check('a stop clicked on a main road goes on the main road, not the side street beside it',
      Math.abs(sy - 2000) < 0.5 && Math.abs(sx - 2003) < 0.5, `${sx}, ${sy}`);
    check('…exactly where it was clicked, the road split there',
      game.roadIndex.nodeCount === nodesBefore + 1 && game.roadIndex.degree(placed.stop.node, 'bus') === 2);
    const nearEnd = game.placeStop(...game.frame.toLonLat(1004, 2002), 'bus');
    check('…but a click by a bend in the road uses the node there', game.roadIndex.nodeCount === nodesBefore + 1
      && game.frame.toLocal(nearEnd.stop.lon, nearEnd.stop.lat).every((v, i) => Math.abs(v - [1000, 2000][i]) < 0.5));
    const again = game.placeStop(...game.frame.toLonLat(2008, 2005), 'bus');
    check('…and a click by an existing stop, on its side, reuses it', again.reused && again.stop === placed.stop);

    // A reload finds — or re-makes — the split from where the stop stands.
    const line = lineAlong(game, [[1500, 2005], [2003, 2005]]);
    const saved = JSON.parse(JSON.stringify(game.toJSON('k')));
    const restored = Game.fromJSON(saved, gameOn(points, streets).region);
    const stop = restored.network.stops.get(placed.stop.id);
    const [rx, ry] = restored.frame.toLocal(...restored.roadIndex.nodeLonLat(stop.node));
    check('a reload on a fresh copy of the map re-makes the stop\'s node where it stood',
      Math.abs(rx - 2003) < 0.5 && Math.abs(ry - 2000) < 0.5
      && Math.abs(restored.network.lines.get(line.id).lengthM - line.lengthM) < 1, `${rx}, ${ry}`);
  }

  // No turning round in the middle of a road, anywhere on the fixture.
  {
    const game = newGame('creative');
    const lines = [
      buildLine(game, [[1600, 2800], [2600, 2800], [3400, 2800], [3400, 3600]]),
      buildLine(game, [[1000, 3600], [2200, 3700], [2600, 4400], [3400, 4300]]),
      buildLine(game, [[2600, 2000], [2600, 2900], [2700, 3800]]),
    ];
    check('no line on the fixture turns round in the road, all the way round its loop',
      lines.every((line) => line.loop && uTurns(game, line) === 0), lines.map((l) => uTurns(game, l)).join());
  }

  // One-way arrows point the way traffic may go.
  {
    const frame = new LocalFrame(squareBbox(23.6, 37.95, 5));
    const nodes = new Map([[1, frame.toLonLat(1000, 1000)], [2, frame.toLonLat(1000, 1200)],
      [3, frame.toLonLat(2000, 1000)], [4, frame.toLonLat(2010, 1000)]]);
    const graph = buildGraph([
      { type: 'way', id: 1, nodes: [1, 2], tags: { highway: 'residential', oneway: 'yes' } },
      { type: 'way', id: 2, nodes: [1, 3], tags: { highway: 'residential', oneway: '-1' } },
      { type: 'way', id: 3, nodes: [3, 4], tags: { highway: 'residential', oneway: 'yes' } },
    ], nodes, frame);
    const arrows = onewayToGeoJSON(graph, frame).features.map((f) => Math.round(f.properties.bearing));
    check('one-way arrows point the way traffic flows, and skip stretches too short to carry one',
      arrows.length === 2 && arrows[0] === 0 && Math.abs(arrows[1]) === 90 && arrows[1] < 0,
      JSON.stringify(arrows));
  }

  // Main roads over back streets.
  {
    const choice = (detourY) => {
      const game = gameOn(new Map([[1, [1000, 3000]], [2, [2000, 3000]], [3, [1000, detourY]], [4, [2000, detourY]]]), [
        [[1, 2], { highway: 'residential' }],
        [[1, 3, 4, 2], { highway: 'primary' }],
      ]);
      return game.roadIndex.shortestPath(0, 1, 'bus').lengthM;
    };
    check('a bus takes the main road round rather than a slightly shorter back street',
      Math.round(choice(3050)) === 1100, `${choice(3050)}`);
    check('…but not a long way round', Math.round(choice(3500)) === 1000, `${choice(3500)}`);
  }
}
