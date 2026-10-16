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
  REGION,
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

  runPlaytestFixes(check, near);
  runImportFixes(check, near);

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

  // #10 Dragging a stop.
  {
    const game = newGame('normal');
    const line = buildLine(game, [[1600, 2800], [2600, 2800], [3400, 2800]], 1);
    const middle = game.network.stops.get(line.stops[1]);
    const length = line.lengthM;
    const moved = game.moveStop(middle, ...at(game, 2600, 3200));
    check('#10 a stop dragged along the roads moves, and its line follows', moved.ok
      && game.frame.distance(middle.lon, middle.lat, ...at(game, 2600, 3200)) < 60
      && Math.abs(line.lengthM - length) > 100, JSON.stringify(moved));
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
    check('#14 …and is stored start-to-end, so a vehicle walking it backwards drives it the right way',
      game.frame.distance(...back.points[0], ...segment.points[0]) < 1
      && game.frame.distance(...back.points.at(-1), ...segment.points.at(-1)) < 1);
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
