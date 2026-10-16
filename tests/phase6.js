/**
 * Phase 6 logic tests: existing OSM railways as ready-made train track.
 *
 * The fixture carries one live line (the Coast Line, three stations) and an
 * abandoned branch the parser already rejects. Switches, rings and tagged
 * structures are tested on small synthetic rail graphs laid over the
 * fixture's terrain, because the fixture's own line has none of them.
 *
 * Imported by tests/run.js; `check` and `near` are passed in.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BUILD, COSTS, CLOCK, INCOME, INTERCITY } from '../config.js';
import { reviveRegion } from '../model/region.js';
import { Game } from '../sim/game.js';
import { osmRailTracks, railChains, structureHeights } from '../build/osm-rail.js';
import { TrackGraph, trackNodeKey } from '../build/track-routing.js';
import { stepIntercity, intercityCall, apportion } from '../sim/intercity.js';
import { setTunable, resetAll } from '../sim/tuning.js';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'test-region.json');
const fixtureText = readFileSync(fixturePath, 'utf8');

function newGame(difficulty = 'creative') {
  const region = reviveRegion(JSON.parse(fixtureText));
  region.meta.difficulty = difficulty;
  region.meta.season = 'urban';
  return new Game(region);
}

const osmTracks = (game) => [...game.network.tracks.values()].filter((t) => t.osm);
const station = (game, name) => game.region.stations.find((s) => s.name === name);

/** A rail graph from local-metre polylines, in the import's own shape. */
function railGraph(game, ways) {
  const nodes = [];
  const edges = [];
  const indexOf = new Map();
  const node = ([x, y]) => {
    const key = `${x},${y}`;
    if (!indexOf.has(key)) {
      indexOf.set(key, nodes.length / 2);
      nodes.push(...game.frame.toLonLat(x, y));
    }
    return indexOf.get(key);
  };
  for (const { points, tunnel = false, bridge = false, name } of ways) {
    for (let i = 1; i < points.length; i++) {
      const a = node(points[i - 1]);
      const b = node(points[i]);
      const lengthM = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
      edges.push({ a, b, cls: 'rail', lengthM, tunnel, bridge, ...(name ? { name } : {}) });
    }
  }
  return { nodes, edges };
}

export function runPhase6Tests(check, near) {
  // ─── The Coast Line becomes track ───────────────────────────────────────
  {
    const game = newGame();
    const tracks = osmTracks(game);
    const railLength = game.region.rail.edges.reduce((sum, edge) => sum + edge.lengthM, 0);
    check('ACCEPTANCE: existing rail is imported as train track', tracks.length >= 1
      && tracks.every((t) => t.mode === 'train'), `${tracks.length} tracks`);
    check('ACCEPTANCE: …with no construction cost', tracks.every((t) => t.cost === 0));
    near('…covering the whole railway', tracks.reduce((sum, t) => sum + t.lengthM, 0),
      railLength, 1);
    check('…sampled no further apart than built track',
      tracks.every((t) => t.points.every((p, i) => i === 0 ||
        game.frame.distance(...t.points[i - 1], ...p) <= BUILD.SAMPLE_M + 1e-6)));
    check('…with a height and a structure for every sample',
      tracks.every((t) => t.height.length === t.points.length && t.kinds.length === t.points.length
        && t.height.every(Number.isFinite)));
    check('a straight railway with no switches is one track', tracks.length === 1);
    check('…named after the OSM way', tracks[0].name === 'Coast Line', tracks[0].name);
    check('the region knows it has rail, which drives the discount', game.region.meta.hasOsmRail);
  }

  // ─── Stations, lines and money on existing rail ─────────────────────────
  {
    const game = newGame('normal');
    const balance = game.economy.balance;
    const west = station(game, 'Harbour West');
    const central = station(game, 'Central');

    game.startLine('train');
    const first = game.extendDraft(west.lon, west.lat);
    const second = game.extendDraft(central.lon, central.lat);
    const line = game.finishDraft();
    check('ACCEPTANCE: a train line runs on existing rail', first.ok && second.ok
      && line.segments.length === 1 && line.segments[0].onTrack,
      JSON.stringify([first, second]));
    check('…over the existing track itself',
      line.segments[0].tracks?.every((id) => id.startsWith('osm')), line.segments[0].tracks?.join());
    const stopNames = line.stops.map((id) => game.network.stops.get(id).name);
    check('a station on existing rail takes the real station\'s name',
      stopNames.join() === 'Harbour West,Central', stopNames.join());
    const paid = balance - game.economy.balance;
    near('…and the player pays for the stations and the train, never for the track',
      paid, 2 * COSTS.STOP.train.atGrade + COSTS.VEHICLE.train, 1e-6);

    // Metro may run on train track; existing rail is train track. On
    // Creative, since Normal's capital went on the train line.
    const metroGame = newGame('creative');
    metroGame.startLine('metro');
    const metroA = metroGame.extendDraft(central.lon, central.lat);
    const east = station(metroGame, 'East Junction');
    const metroB = metroGame.extendDraft(east.lon, east.lat);
    const metro = metroGame.finishDraft();
    check('ACCEPTANCE: a metro line runs on existing rail too',
      metroA.ok && metroB.ok && metro.segments[0]?.onTrack, JSON.stringify([metroA, metroB]));

    // Running costs and the stations' upkeep, but nothing for the railway.
    const withRail = game.economy.maintenancePerYear(game.network, true);
    const stationsOnly = [...game.network.stops.values()]
      .reduce((sum, stop) => sum + stop.cost * COSTS.MAINTENANCE_RATE * (1 - COSTS.OSM_RAIL_DISCOUNT), 0);
    near('ACCEPTANCE: the player never pays maintenance on existing rail',
      withRail, stationsOnly, 1e-6);

    const osm = osmTracks(game)[0];
    check('existing rail cannot be bulldozed', game.bulldoze(osm).error === 'osmTrack'
      && game.network.tracks.has(osm.id));

    // A reload rebuilds the railway from the region and keeps the stations on it.
    const saved = JSON.parse(JSON.stringify(game.toJSON('k')));
    check('existing rail is not written into the save',
      saved.tracks.every((t) => !String(t.id).startsWith('osm')));
    const restored = Game.fromJSON(saved, game.region);
    const restoredLine = restored.network.lines.get(line.id);
    check('a reload keeps a line on existing rail running on it',
      restoredLine.segments.length === 1 && restoredLine.segments[0].onTrack);
    near('…the same length as before', restoredLine.lengthM, line.lengthM, 1e-6);
    check('…with its stations on the same samples', restoredLine.stops.every((id) =>
      restored.network.stops.get(id).node === game.network.stops.get(id).node));
  }

  // ─── Player track joins existing rail ───────────────────────────────────
  {
    const game = newGame('creative');
    const central = station(game, 'Central');
    const junction = game.network.junctionAt(central.lon, central.lat, 'train');
    check('ACCEPTANCE: new train track can join existing rail',
      junction && junction.trackId.startsWith('osm'), JSON.stringify(junction));
    check('…and so can new metro track',
      game.network.junctionAt(central.lon, central.lat, 'metro')?.trackId.startsWith('osm'));
    const osm = game.network.tracks.get(junction.trackId);
    near('a junction with existing rail meets it at its height',
      game.network.junctionHeight(junction), osm.height[junction.index], 1e-9);
  }

  // ─── Player track maintenance gets the discount ─────────────────────────
  {
    const game = newGame('creative');
    const track = { cost: 10e6, osm: false };
    const network = { stops: new Map(), lines: new Map(), tracks: new Map([['t', track]]) };
    near('ACCEPTANCE: with OSM rail in the region, the player\'s own track is 25% cheaper to keep',
      game.economy.maintenancePerYear(network, true),
      10e6 * COSTS.MAINTENANCE_RATE * (1 - COSTS.OSM_RAIL_DISCOUNT), 1e-6);
    near('…and full price without it', game.economy.maintenancePerYear(network, false),
      10e6 * COSTS.MAINTENANCE_RATE, 1e-6);
  }

  // ─── Switches, rings and structures, on synthetic graphs ────────────────
  {
    const game = newGame();
    // A Y: a trunk from the west splitting at (3000, 3000) into two branches.
    const rail = railGraph(game, [
      { points: [[1000, 3000], [2000, 3000], [3000, 3000]], name: 'Trunk' },
      { points: [[3000, 3000], [4000, 3600], [5000, 3600]] },
      { points: [[3000, 3000], [4000, 2400], [5000, 2400]] },
    ]);
    const chains = railChains(rail);
    check('a switch splits the railway into one chain per arm', chains.length === 3,
      `${chains.length}`);
    const region = { ...game.region, rail };
    const tracks = osmRailTracks(region, game.frame);
    const linked = tracks.filter((t) => t.start || t.end);
    check('…joined at the switch by junctions', linked.length === 2, `${linked.length}`);
    const graph = new TrackGraph(tracks, game.frame);
    const north = graph.snap(...game.frame.toLonLat(5000, 3600), 'train', 30);
    const south = graph.snap(...game.frame.toLonLat(5000, 2400), 'train', 30);
    const path = graph.path(north.key, south.key, 'train');
    // Each branch is 1,166 m to the switch then 1,000 m on, so 4,332 m in all.
    near('a train can run from one branch to the other through the switch',
      path?.lengthM ?? 0, 2 * (Math.hypot(1000, 600) + 1000), 1);
    check('ids are fixed by the region, so a saved station key keeps its place',
      osmRailTracks(region, game.frame).map((t) => t.id).join() === tracks.map((t) => t.id).join()
      && tracks[0].id === 'osm0' && trackNodeKey(tracks[0].id, 3) === 'osm0:3');

    // A ring with no switch: one closed track.
    const ring = railGraph(game, [{ points: [[2000, 2000], [4000, 2000], [4000, 4000], [2000, 4000], [2000, 2000]] }]);
    const ringTracks = osmRailTracks({ ...game.region, rail: ring }, game.frame);
    check('a ring with no switch is one track, closed on itself',
      ringTracks.length === 1 && ringTracks[0].end?.trackId === ringTracks[0].id
      && ringTracks[0].end.index === 0);

    // Tunnels and bridges come from the tags, not the grade rule.
    const tagged = railGraph(game, [
      { points: [[1000, 4500], [1600, 4500]] },
      { points: [[1600, 4500], [2200, 4500]], tunnel: true },
      { points: [[2200, 4500], [2800, 4500]] },
      { points: [[2800, 4500], [3200, 4500]], bridge: true },
      { points: [[3200, 4500], [3800, 4500]] },
    ]);
    const [structured] = osmRailTracks({ ...game.region, rail: tagged }, game.frame);
    const metres = (kind) => structured.kinds.filter((k) => k === kind).length * BUILD.SAMPLE_M;
    near('ACCEPTANCE: a tunnel tagged in OSM is a tunnel', metres('tunnel'), 600 + BUILD.SAMPLE_M, BUILD.SAMPLE_M);
    near('ACCEPTANCE: a bridge tagged in OSM is a bridge', metres('bridge'), 400 + BUILD.SAMPLE_M, BUILD.SAMPLE_M);
    check('…and nothing else is a structure, whatever the terrain',
      structured.kinds.filter((k) => k !== 'atGrade').length * BUILD.SAMPLE_M <= 1000 + 3 * BUILD.SAMPLE_M);

    const heights = structureHeights(
      ['atGrade', 'tunnel', 'tunnel', 'tunnel', 'atGrade'], [10, 50, 80, 50, 30]);
    check('a tunnel runs straight from portal to portal, under the hill',
      heights.join() === '10,15,20,25,30', heights.join());
  }

  // ─── Intercity service ──────────────────────────────────────────────────
  {
    const game = newGame('creative');
    const west = station(game, 'Harbour West');
    const central = station(game, 'Central');
    game.startLine('train');
    game.extendDraft(west.lon, west.lat);
    game.extendDraft(central.lon, central.lat);
    const line = game.finishDraft();
    const [westStop, centralStop] = line.stops.map((id) => game.network.stops.get(id));

    game.startLine('bus');
    game.extendDraft(...game.frame.toLonLat(1600, 2800));
    game.extendDraft(...game.frame.toLonLat(2600, 2800));
    const bus = game.finishDraft();
    const busStop = game.network.stops.get(bus.stops[0]);
    check('intercity is refused at a bus stop',
      game.toggleIntercity(busStop).error === 'intercityNeedsRail' && !busStop.intercity);
    check('ACCEPTANCE: a station on existing rail can toggle intercity service',
      game.toggleIntercity(westStop).on === true && westStop.intercity);

    game.tick(CLOCK.TICK_MS / 1000); // build the demand table
    const waitingBefore = westStop.waiting.length;
    const calls = stepIntercity(game, INTERCITY.INTERVAL_SIM_S);
    check('ACCEPTANCE: an intercity train calls once per interval',
      calls.calls === 1 && westStop.intercityCalls === 1, JSON.stringify(calls));
    const expectedDots = Math.floor(INTERCITY.PASSENGERS_PER_CALL * INTERCITY.DROP_FRACTION
      / game.passengersPerDot);
    check('ACCEPTANCE: …dropping its share of passengers into the network as new trips',
      calls.dots === expectedDots && westStop.waiting.length - waitingBefore === expectedDots,
      `${calls.dots} of ${expectedDots}`);
    check('…every one bound somewhere the network goes',
      westStop.waiting.slice(waitingBefore).every((dot) => dot.toId === centralStop.id));
    check('…and nothing calls again until the next interval',
      stepIntercity(game, INTERCITY.INTERVAL_SIM_S / 2).calls === 0);

    const before = game.economy.month.intercity;
    game.economy.endDay(game.network, 0, true);
    near('ACCEPTANCE: each call pays one ticket per passenger aboard, scaled like any daily total',
      game.economy.month.intercity - before,
      INTERCITY.PASSENGERS_PER_CALL * CLOCK.DAILY_SCALE * INCOME.FARE * game.economy.fareMultiplier,
      1e-6);

    check('switching it off stops the calls',
      game.toggleIntercity(westStop).on === false
      && stepIntercity(game, 10 * INTERCITY.INTERVAL_SIM_S).calls === 0);

    // Service on at both stations, mid-interval, then a save and a reload.
    game.toggleIntercity(centralStop);
    game.toggleIntercity(westStop);
    stepIntercity(game, INTERCITY.INTERVAL_SIM_S / 3);
    const saved = JSON.parse(JSON.stringify(game.toJSON('k')));
    const restored = Game.fromJSON(saved, game.region);
    const restoredWest = restored.network.stops.get(westStop.id);
    check('a reload keeps intercity service and its timer',
      restoredWest.intercity && restoredWest.intercityTimer === westStop.intercityTimer
      && restoredWest.intercityCalls === westStop.intercityCalls);

    // The split is exact and deterministic.
    const shares = apportion([{ toId: 'a', weight: 1 }, { toId: 'b', weight: 1 }, { toId: 'c', weight: 2 }], 5);
    check('arrivals are split by largest remainder',
      JSON.stringify(shares) === JSON.stringify([
        { toId: 'a', count: 1 }, { toId: 'b', count: 1 }, { toId: 'c', count: 3 }]),
      JSON.stringify(shares));
    check('…and nothing is split with nowhere to go', apportion([], 5).length === 0);

    // With big dots, the fraction of a dot carries over to the next call.
    const fake = { ...game, passengersPerDot: 7, economy: game.economy,
      demand: { destinationsFrom: () => [] }, totals: { spawned: 0 } };
    const lonely = { intercityCarry: 0, intercityCalls: 0, id: 'x' };
    intercityCall(fake, lonely);
    near('a fraction of a dot carries to the next call',
      lonely.intercityCarry * 7, (INTERCITY.PASSENGERS_PER_CALL * INTERCITY.DROP_FRACTION) % 7, 1e-9);

    setTunable(game, 'INTERCITY.INTERVAL_SIM_S', 600);
    check('the intercity interval is tunable in the ` panel', INTERCITY.INTERVAL_SIM_S === 600);
    resetAll(game);
  }

  // ─── Regions without rail ───────────────────────────────────────────────
  {
    const game = newGame();
    check('a region with no rail gets no existing track',
      osmRailTracks({ ...game.region, rail: { nodes: [], edges: [] } }, game.frame).length === 0
      && osmRailTracks({ ...game.region, rail: undefined }, game.frame).length === 0);
  }
}
