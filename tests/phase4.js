/**
 * Phase 4 logic tests: rail track, the full grade rule, the rail-and-roads
 * rules, stations, and track compatibility.
 *
 * The acceptance criteria are asserted here, marked ACCEPTANCE:, against the
 * fixture's real terrain:
 *
 *   - metro track stays underground on flat land and surfaces, brightened,
 *     across a valley;
 *   - train track on hilly ground produces tunnels and bridges;
 *   - a metro line runs on train track, but a train line is refused on metro
 *     track.
 *
 * The alignments used were found by searching the fixture, not by eye: it is
 * a dense town on a 200 m street grid, and most straight lines across it are
 * (correctly) refused for buildings or for running along a street.
 *
 * Imported by tests/run.js; `check` and `near` are passed in so the suites
 * report as one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BUILD, COSTS, RENDER } from '../config.js';
import { reviveRegion, LocalFrame, squareBbox } from '../model/region.js';
import { Track, Stop } from '../model/network.js';
import { Game } from '../sim/game.js';
import {
  smoothProfile, classifyStructures, runsOf, maxGradeOf, overInlandWater,
} from '../build/track-geometry.js';
import { RoadCorridors, judgeRoadRules, crossingAngle } from '../build/rail-roads.js';
import { TrackGraph, canRunOn } from '../build/track-routing.js';
import { drawTrackStructure, shade } from '../render/shapes.js';
import { stepVehicle } from '../sim/vehicles.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = () => reviveRegion(
  JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'test-region.json'), 'utf8')));

/** A game on the fixture with money no object. */
function richGame() {
  const game = new Game(fixture());
  game.economy.balance = 1e12;
  return game;
}

/**
 * Draw track the way the player does — waypoint clicks, then Enter — in local
 * metres. Returns the built track, or the refusal.
 */
/** Track the player built: existing railways are track from the start. */
const playerTracks = (game) => [...game.network.tracks.values()].filter((t) => !t.osm).length;

function drawTrack(game, mode, points) {
  game.startTrack(mode);
  let result = { ok: true };
  for (const [x, y] of points) {
    result = game.addTrackPoint(...game.frame.toLonLat(x, y));
    if (result.error || result.finished) break;
  }
  if (!result.error && !result.finished) result = game.finishTrack();
  if (result.error) game.cancelTrack();
  return result;
}

const kindsOf = (track) => new Set(track.kinds);

export function runPhase4Tests(check, near) {
  // ─── Pins anywhere along the profile ──────────────────────────────────────
  {
    const step = BUILD.SAMPLE_M;
    const g = BUILD.MAX_GRADE.train;
    const flat = new Array(60).fill(10);
    const pins = [{ index: 0, height: 10 }, { index: 30, height: 20 }, { index: 59, height: 10 }];
    const profile = smoothProfile(flat, step, g, pins);
    check('a mid-profile pin is met exactly', profile && Math.abs(profile[30] - 20) < 1e-9,
      profile ? profile[30].toFixed(3) : 'null');
    check('…with the ends still pinned',
      Math.abs(profile[0] - 10) < 1e-9 && Math.abs(profile[59] - 10) < 1e-9);
    check('…and the grade limit still honoured', maxGradeOf(profile, step) <= g + 1e-9);
    check('the ramps up to a pin come out of the smoothing, not a step',
      profile[29] < 20 && profile[29] > 10 && profile[31] < 20);

    check('pins further apart than the grade can climb are refused',
      smoothProfile(flat, step, g, [{ index: 0, height: 0 }, { index: 1, height: 10 }]) === null);
    check('the old {start, end} pin form still works',
      smoothProfile([0, 0, 0], step, g, { start: 0, end: 0 })?.length === 3);
  }

  // ─── Forced structures and water ──────────────────────────────────────────
  {
    const step = BUILD.SAMPLE_M;
    const n = 30;
    const ground = new Array(n).fill(0);
    const dry = new Array(n).fill(false);

    // Two samples forced to a bridge — far shorter than the merge minimum.
    const forced = [];
    forced[14] = 'bridge'; forced[15] = 'bridge';
    const kinds = classifyStructures(ground, ground, dry, step, forced);
    check('a forced structure survives the short-run merge',
      kinds[14] === 'bridge' && kinds[15] === 'bridge', runsOf(kinds).map((r) => r.kind).join(','));

    // A river two samples wide must not be merged into its banks.
    const river = dry.slice();
    river[10] = true; river[11] = true;
    const crossing = classifyStructures(ground, ground, river, step);
    check('a narrow river is still bridged, not crossed at grade',
      crossing[10] === 'bridge' && crossing[11] === 'bridge');

    const deep = new Array(n).fill(-20);
    check('a metro deep under water is still a tunnel',
      classifyStructures(deep, ground, river, step)[10] === 'tunnel');
  }

  // ─── Rail and roads, on a hand-made road ──────────────────────────────────
  {
    const frame = new LocalFrame(squareBbox(23.6, 37.95, 2));
    const node = (x, y) => frame.toLonLat(x, y);
    // One east–west primary road through the middle of a 2 km square, one
    // north–south motorway, and one secondary on a bridge.
    const nodes = [...node(0, 1000), ...node(2000, 1000),
      ...node(1500, 0), ...node(1500, 2000),
      ...node(500, 0), ...node(500, 2000)].flat();
    const roads = {
      nodes,
      edges: [
        { a: 0, b: 1, cls: 'primary', lengthM: 2000, tunnel: false, bridge: false },
        { a: 2, b: 3, cls: 'motorway', lengthM: 2000, tunnel: false, bridge: false },
        { a: 4, b: 5, cls: 'secondary', lengthM: 2000, tunnel: false, bridge: true },
      ],
    };
    const corridors = new RoadCorridors(roads, frame);
    const line = (x0, y0, x1, y1) => {
      const out = [];
      const length = Math.hypot(x1 - x0, y1 - y0);
      for (let d = 0; d <= length + 1e-9; d += BUILD.SAMPLE_M) {
        out.push([x0 + (x1 - x0) * d / length, y0 + (y1 - y0) * d / length]);
      }
      return out;
    };

    near('crossing angle: square', crossingAngle(1, 0, 0, 1), 90, 1e-9);
    near('crossing angle: direction does not matter', crossingAngle(1, 1, -1, 0), 45, 1e-9);

    const square = line(1000, 600, 1010, 1400);
    const found = corridors.crossings(square);
    check('a track across the road finds exactly one crossing', found.length === 1,
      `${found.length}`);
    check('…of the right road, at nearly a right angle',
      found[0]?.cls === 'primary' && found[0].angleDeg > 85);

    check('a road on a bridge does not count — the rail passes under it',
      corridors.crossings(line(300, 500, 700, 500)).length === 0);
    check('a motorway crossing is flagged as grade-separated',
      corridors.crossings(line(1300, 500, 1700, 500))[0]?.gradeSeparated === true);

    const atGrade = (samples) => samples.map(() => 'atGrade');
    const squareRules = judgeRoadRules(square, atGrade(square), found, corridors, BUILD.SAMPLE_M);
    check('a square crossing becomes one level crossing', squareRules.levelCrossings.length === 1);
    check('…and is neither shallow nor along the road',
      squareRules.shallow.length === 0 && squareRules.along.length === 0);

    const shallow = line(700, 960, 1300, 1060);
    const shallowRules = judgeRoadRules(shallow, atGrade(shallow),
      corridors.crossings(shallow), corridors, BUILD.SAMPLE_M);
    check('a crossing shallower than 45° is refused', shallowRules.shallow.length > 0,
      `angle ${corridors.crossings(shallow)[0]?.angleDeg.toFixed(1)}`);

    const along = line(200, 1003, 1200, 1003);
    const alongRules = judgeRoadRules(along, atGrade(along), [], corridors, BUILD.SAMPLE_M);
    check('running along a road for more than 40 m is refused',
      alongRules.along.length * BUILD.SAMPLE_M > BUILD.MAX_ALONG_ROAD_M);

    const bridged = judgeRoadRules(along, along.map(() => 'bridge'), [], corridors, BUILD.SAMPLE_M);
    check('…but a bridge may run along a road, as an elevated railway does',
      bridged.along.length === 0);

    const diagonal = line(600, 600, 1000, 1000 + 400);
    check('a 45° crossing is allowed — the limit is inclusive',
      judgeRoadRules(diagonal, atGrade(diagonal), corridors.crossings(diagonal),
        corridors, BUILD.SAMPLE_M).shallow.length === 0);
  }

  // ─── Track compatibility ──────────────────────────────────────────────────
  {
    check('metro may run on metro track', canRunOn('metro', 'metro'));
    check('metro may run on train track', canRunOn('metro', 'train'));
    check('train may run on train track', canRunOn('train', 'train'));
    check('train may NOT run on metro track', !canRunOn('train', 'metro'));
    check('neither bus nor tram runs on rail track', !canRunOn('bus', 'train') && !canRunOn('tram', 'metro'));

    // A tiny graph: train track A, metro track M joined to it.
    const frame = new LocalFrame(squareBbox(23.6, 37.95, 2));
    const fake = (id, mode, xs, start = null) => {
      const track = new Track(mode, [], start, null);
      track.id = id;
      track.points = xs.map((x) => frame.toLonLat(x, 500));
      track.kinds = xs.map(() => 'atGrade');
      return track;
    };
    const a = fake('tA', 'train', [0, 20, 40, 60]);
    const m = fake('tM', 'metro', [60, 80, 100], { trackId: 'tA', index: 3 });
    const graph = new TrackGraph([a, m], frame);
    check('a metro line routes from train track onto metro track through a junction',
      graph.path('tA:0', 'tM:2', 'metro') !== null);
    check('a train line cannot follow it onto the metro track',
      graph.path('tA:0', 'tM:2', 'train') === null);
    near('a path through a junction measures its real length',
      graph.path('tA:0', 'tM:2', 'metro').lengthM, 100, 0.5);

    // Tracks join wherever they cross at the same height, with no click on
    // the spot; a bridge passing over does not (Alex, Oct 18 2026).
    const level = (track, h) => { track.height = track.points.map(() => h); return track; };
    const across = (id, h) => {
      const track = new Track('train', [], null, null);
      track.id = id;
      track.points = [450, 470, 490, 510, 530, 550].map((y) => frame.toLonLat(30, y));
      track.kinds = track.points.map(() => 'atGrade');
      return level(track, h);
    };
    const flat = new TrackGraph([level(fake('tA', 'train', [0, 20, 40, 60]), 10), across('tX', 10)], frame);
    check('track crossing other track at the same height joins it',
      flat.path('tA:0', 'tX:5', 'train') !== null);
    const over = new TrackGraph([level(fake('tA', 'train', [0, 20, 40, 60]), 10), across('tB', 18)], frame);
    check('…but a bridge passing over it does not',
      over.path('tA:0', 'tB:5', 'train') === null);
  }

  // Drawn the way a player draws, crossing a track built earlier.
  {
    const game = richGame();
    const first = drawTrack(game, 'metro', [[4200, 600], [5200, 900]]);
    const second = drawTrack(game, 'metro', [[4700, 300], [4750, 1200]]);
    const crossing = second.track && game.network.trackGraph.crossings(second.track.points, second.track.height, second.track.id);
    check('a new track drawn across one built earlier joins it, with no click on the spot',
      first.ok && second.ok && !second.track.start && !second.track.end && crossing?.length === 1,
      JSON.stringify({ first: first.error, second: second.error, crossings: crossing?.length }));
    const a = game.network.addStop(...game.frame.toLonLat(4250, 615), 'metro');
    const b = game.network.addStop(...game.frame.toLonLat(4745, 1110), 'metro');
    const line = game.network.createLine('metro');
    game.network.extendLine(line, a.stop);
    const joined = game.network.extendLine(line, b.stop);
    check('…so a metro line runs from one onto the other', joined.ok && line.segments.length === 1,
      JSON.stringify(joined));
  }

  // ─── ACCEPTANCE: metro underground on the flat, surfacing over a valley ───
  {
    const game = richGame();

    const flat = drawTrack(game, 'metro', [[4200, 600], [5200, 900]]);
    check('ACCEPTANCE: metro track can be built', flat.ok === true, flat.error);
    check('ACCEPTANCE: metro track stays underground on flat land',
      flat.track && [...kindsOf(flat.track)].join() === 'tunnel',
      flat.track && [...kindsOf(flat.track)].join());
    check('…and passes beneath the town\'s buildings and streets without a word',
      flat.track?.levelCrossings.length === 0);

    // East–west across the notch the fixture cuts through its ridge.
    const valley = drawTrack(game, 'metro', [[2500, 4400], [4700, 4400]]);
    check('ACCEPTANCE: a metro track across the valley can be built', valley.ok === true,
      valley.error);
    const runs = valley.track ? runsOf(valley.track.kinds).map((r) => r.kind) : [];
    check('ACCEPTANCE: it is underground either side of the valley',
      runs[0] === 'tunnel' && runs.at(-1) === 'tunnel', runs.join(' → '));
    check('ACCEPTANCE: and surfaces where the land drops away beneath it',
      runs.slice(1, -1).some((kind) => kind !== 'tunnel'), runs.join(' → '));
    check('the metro honoured its own grade limit over real terrain',
      maxGradeOf(valley.track.height, BUILD.SAMPLE_M) <= BUILD.MAX_GRADE.metro + 1e-9);

    // The drawing: metro is the inverse — plain underground, brightened above.
    const strokes = [];
    const ctx = mockContext(strokes);
    const color = '#2C7BD6';
    const points = valley.track.points.map((_, i) => [i, 0]);
    drawTrackStructure(ctx, points, valley.track.kinds, color, 6, 'metro');
    const bright = shade(color, RENDER.METRO_SURFACE_LIGHTEN);
    check('ACCEPTANCE: the surfaced stretch is drawn brightened',
      strokes.includes(bright), [...new Set(strokes)].join(' '));
    check('…and the underground stretches in the line\'s plain colour',
      strokes.includes(color));

    const tramStrokes = [];
    drawTrackStructure(mockContext(tramStrokes), points, valley.track.kinds, color, 6, 'tram');
    check('other modes are NOT inverted — their tunnels darken instead',
      !tramStrokes.includes(bright) && tramStrokes.includes(shade(color, -RENDER.TUNNEL_DARKEN)));
  }

  // ─── ACCEPTANCE: train on hilly ground gets tunnels and bridges ───────────
  {
    const game = richGame();
    // From beside the river's mouth, north-west across the river and through
    // the ridge. Found by searching for an alignment that keeps both
    // structures and stays clear of buildings when nudged ±10 m, so the
    // browser suite can draw it with real clicks.
    const result = drawTrack(game, 'train', [[1900, 1000], [700, 3400]]);
    check('ACCEPTANCE: train track can be built across the hills', result.ok === true,
      result.error);
    const track = result.track;
    const kinds = track ? kindsOf(track) : new Set();
    check('ACCEPTANCE: train track on hilly ground gets a tunnel', kinds.has('tunnel'),
      [...kinds].join());
    check('ACCEPTANCE: …and a bridge', kinds.has('bridge'), [...kinds].join());
    check('…and the player chose neither: no tool for them exists',
      !('buildTunnel' in game) && !('buildBridge' in game));
    check('train track honours the 2.5% limit',
      maxGradeOf(track.height, BUILD.SAMPLE_M) <= BUILD.MAX_GRADE.train + 1e-9,
      maxGradeOf(track.height, BUILD.SAMPLE_M).toFixed(4));

    // The bridge is over the river — not merely the sea's edge — and
    // genuinely clears it.
    const local = track.points.map(([lon, lat]) => game.frame.toLocal(lon, lat));
    const overRiver = local.map(([x, y], i) => (overInlandWater(game.region, x, y) ? i : -1))
      .filter((i) => i >= 0);
    check('the track crosses the river', overRiver.length > 0);
    check('…on a bridge, every sample of it',
      overRiver.every((i) => track.kinds[i] === 'bridge'));
    check('…at least 8 m above the water, as the spec requires',
      overRiver.every((i) => track.height[i] - Math.max(0, track.terrain[i])
        >= BUILD.WATER_CLEARANCE_M - 1e-6));

    const charged = 1e12 - game.economy.balance;
    near('the player paid exactly what the track was priced at', charged, result.cost, 1);
    check('a tunnel-heavy train track costs far more than the same length at grade',
      result.cost > COSTS.TRACK_PER_KM.train.atGrade * track.lengthM / 1000 * 2);
  }

  // ─── Motorways are never crossed at grade ─────────────────────────────────
  {
    const game = richGame();
    // The fixture's Coastal Motorway runs north–south at x ≈ 5600.
    const result = drawTrack(game, 'train', [[5000, 700], [5950, 700]]);
    check('a train track can cross the motorway', result.ok === true, result.error);
    const track = result.track;
    check('…as a short bridge or tunnel, built without being asked for',
      track && runsOf(track.kinds).some((run) => run.kind !== 'atGrade'
        && (run.end - run.start + 1) * BUILD.SAMPLE_M < 300));
    // Find the samples straddling the motorway and check the clearance there.
    const motorwayX = game.frame.widthM - 400;
    const samples = track.points.map(([lon, lat]) => game.frame.toLocal(lon, lat));
    const at = samples.findIndex(([x]) => x >= motorwayX);
    const clearAbove = track.height[at] - track.terrain[at] >= BUILD.MOTORWAY_CLEARANCE_ABOVE_M - 1;
    const clearBelow = track.terrain[at] - track.height[at] >= BUILD.MOTORWAY_CLEARANCE_BELOW_M - 1;
    check('…clearing the motorway by the configured margin', clearAbove || clearBelow,
      `track ${track.height[at].toFixed(1)} m over ground ${track.terrain[at].toFixed(1)} m`);
    check('…and with no level crossing on the motorway itself',
      track.levelCrossings.every(({ lonLat }) =>
        Math.abs(game.frame.toLocal(...lonLat)[0] - motorwayX) > 20));

    check('ordinary streets it crosses at grade become level crossings',
      track.levelCrossings.length > 0, `${track.levelCrossings.length}`);
    near('…each charged at the level-crossing price',
      result.cost - game.network.planTrack('train', track.control).structureCost,
      track.levelCrossings.length * COSTS.LEVEL_CROSSING, 1);
  }

  // ─── Refusals on the fixture ──────────────────────────────────────────────
  {
    const game = richGame();
    const along = game.network.planTrack('train',
      [[1000, 5200], [1800, 5200]].map(([x, y]) => game.frame.toLonLat(x, y)));
    check('train track laid down a street is refused', along.blocked && along.reason === 'alongRoad',
      along.reason);
    const shallow = game.network.planTrack('train',
      [[1000, 5150], [1800, 5300]].map(([x, y]) => game.frame.toLonLat(x, y)));
    check('train track crossing a street too shallowly is refused',
      shallow.blocked && shallow.reason === 'crossingTooShallow', shallow.reason);
    const steep = game.network.planTrack('train',
      [[5200, 4900], [5900, 5000]].map(([x, y]) => game.frame.toLonLat(x, y)));
    check('train track between ends too far apart in height is refused as too steep',
      steep.blocked && steep.reason === 'tooSteep', steep.reason);

    const balance = game.economy.balance;
    const refused = drawTrack(game, 'train', [[1000, 5200], [1800, 5200]]);
    check('the game refuses to build a blocked track', refused.error === 'alongRoad',
      JSON.stringify(refused));
    check('…and charges nothing for it', game.economy.balance === balance);
    check('…and builds nothing', playerTracks(game) === 0);
  }

  // ─── The Build track gestures ─────────────────────────────────────────────
  {
    const game = richGame();
    const at = (x, y) => game.frame.toLonLat(x, y);
    game.startTrack('train');
    game.addTrackPoint(...at(1000, 5200));
    game.addTrackPoint(...at(1000, 5201)); // the first click of a double-click
    check('a waypoint on top of the last one is ignored', game.trackDraft.control.length === 1);
    game.addTrackPoint(...at(1800, 5200));
    const blocked = game.finishTrack();
    check('finishing a blocked track is refused', blocked.error === 'alongRoad', blocked.error);
    check('…and the draft is kept, so the player can reroute', game.trackDraft?.control.length === 2);
    game.removeTrackPoint();
    check('Backspace takes back the last waypoint', game.trackDraft.control.length === 1);

    const preview = game.previewTrack(...at(1000, 4000));
    check('the cursor previews the track before it is placed',
      preview && preview.kinds.length > 1 && Number.isFinite(preview.cost));
    check('…without building or charging anything',
      playerTracks(game) === 0 && game.economy.balance === 1e12);
    game.cancelTrack();
    check('Esc throws the draft away', game.trackDraft === null);

    // Junctions: start on existing track, end on other existing track.
    const a = drawTrack(game, 'train', [[1900, 1000], [700, 3400]]);
    const b = drawTrack(game, 'train', [[5000, 700], [5950, 700]]);
    game.startTrack('metro');
    game.addTrackPoint(...at(1300, 2200));
    check('a first click on existing track starts a junction',
      game.trackDraft.start?.trackId === a.track.id);
    game.addTrackPoint(...at(2000, 1900));
    const joined = game.addTrackPoint(...at(5402, 702));
    check('a later click on existing track ends the track there and builds it',
      joined.ok === true && joined.finished === true, JSON.stringify(joined.error));
    const metro = joined.track;
    check('…joined at both ends', metro?.start?.trackId === a.track.id
      && metro?.end?.trackId === b.track.id);
    check('a junction is level: the new track meets the old one\'s height',
      Math.abs(metro.height[0] - a.track.height[metro.start.index]) < 1e-6 &&
      Math.abs(metro.height.at(-1) - b.track.height[metro.end.index]) < 1e-6);

    // Train track may not start from metro track.
    game.startTrack('train');
    game.addTrackPoint(...metro.points[Math.floor(metro.points.length / 2)]);
    check('new train track does not join metro track', game.trackDraft.start === null);
    game.cancelTrack();
  }

  // ─── ACCEPTANCE: metro on train track; train refused on metro track ───────
  {
    const game = richGame();
    const at = (x, y) => game.frame.toLonLat(x, y);
    const a = drawTrack(game, 'train', [[1900, 1000], [700, 3400]]).track;
    const b = drawTrack(game, 'train', [[5000, 700], [5950, 700]]).track;
    game.startTrack('metro');
    game.addTrackPoint(...at(1300, 2200));
    game.addTrackPoint(...at(2000, 1900));
    const m = game.addTrackPoint(...at(5402, 702)).track;
    check('the compatibility network was built', Boolean(a && b && m));

    // A metro line on the train track.
    const metroLine = game.startLine('metro');
    const s1 = game.extendDraft(...at(1540, 1720));
    const s2 = game.extendDraft(...at(1000, 2800));
    game.finishDraft();
    check('ACCEPTANCE: a metro line can be drawn on train track',
      !s1.error && !s2.error && metroLine.stops.length === 2, `${s1.error} ${s2.error}`);
    check('…routed along the track, not the roads',
      metroLine.segments[0]?.onTrack === true && metroLine.segments[0].tracks.includes(a.id));
    check('…carrying the track\'s structures with it, for drawing',
      metroLine.segments[0].kinds.includes('tunnel'));

    // And it actually runs.
    const vehicle = metroLine.vehicles[0];
    check('…and was given a vehicle', Boolean(vehicle));
    const startLat = vehicle && (stepVehicle(vehicle, metroLine, 0.01, game.frame), vehicle.lat);
    for (let i = 0; i < 20; i++) stepVehicle(vehicle, metroLine, 5, game.frame);
    check('ACCEPTANCE: the metro vehicle moves along the train track',
      Math.abs(vehicle.lat - startLat) > 1e-4);

    // A train station on metro track is refused outright.
    const mid = m.points[Math.floor(m.points.length / 2)];
    const trainLine = game.startLine('train');
    const refused = game.extendDraft(...mid);
    check('ACCEPTANCE: a train station on metro track is refused',
      refused.error === 'wrongTrack', JSON.stringify(refused));
    game.finishDraft();
    check('…and leaves no line behind', !game.network.lines.has(trainLine.id));

    // A train line between two train tracks joined only by metro track.
    const t1 = game.startLine('train');
    const okA = game.extendDraft(...at(1120, 2560));
    const noPath = game.extendDraft(...at(5800, 700));
    check('ACCEPTANCE: a train line is refused across metro track',
      !okA.error && noPath.error === 'noTrackPath', `${okA.error} ${noPath.error}`);
    game.finishDraft();
    check('…and the refused station is not left behind, unpaid-for',
      ![...game.network.stops.values()].some((stop) =>
        stop.mode === 'train' && stop.lines.length === 0 && stop.id !== okA.stop?.id));

    const m1 = game.startLine('metro');
    const okB = game.extendDraft(...at(1120, 2560));
    const viaMetro = game.extendDraft(...at(5800, 700));
    game.finishDraft();
    check('…while a metro line takes the same route without complaint',
      !okB.error && !viaMetro.error && m1.segments[0]?.tracks.includes(m.id),
      `${okB.error} ${viaMetro.error}`);
    void t1;
  }

  // ─── Stations ─────────────────────────────────────────────────────────────
  {
    const game = richGame();
    const at = (x, y) => game.frame.toLonLat(x, y);
    drawTrack(game, 'metro', [[4200, 600], [5200, 900]]);
    const far = game.placeStop(...at(4200, 2000), 'metro');
    check('a station away from track is refused', far.error === 'tooFarFromTrack', far.error);

    const before = game.economy.balance;
    const underground = game.placeStop(...at(4700, 760), 'metro');
    check('a metro station snaps onto the track', !underground.error, underground.error);
    check('…takes the structure at its position', underground.stop?.structure === 'tunnel');
    near('…and is priced to match: underground', before - game.economy.balance,
      COSTS.STOP.metro.underground, 1);
    check('a station is not snapped to a road node',
      typeof underground.stop.node === 'string');

    const train = drawTrack(game, 'train', [[5000, 700], [5950, 700]]).track;
    const index = train.kinds.indexOf('atGrade');
    const before2 = game.economy.balance;
    const atGrade = game.placeStop(...train.points[index], 'train');
    near('a train station at grade costs the at-grade price', before2 - game.economy.balance,
      COSTS.STOP.train.atGrade, 1);
    const again = game.placeStop(...train.points[index], 'train');
    check('clicking the same station again reuses it', again.reused === true
      && again.stop.id === atGrade.stop.id);
  }

  // ─── Bulldozing, maintenance ──────────────────────────────────────────────
  {
    const game = richGame();
    const at = (x, y) => game.frame.toLonLat(x, y);
    const a = drawTrack(game, 'train', [[1900, 1000], [700, 3400]]).track;
    const b = drawTrack(game, 'train', [[5000, 700], [5950, 700]]).track;

    const without = game.economy.maintenancePerYear(game.network, false);
    check('bare track is maintained whether or not anything runs on it',
      without >= (a.cost + b.cost) * COSTS.MAINTENANCE_RATE - 1);
    const discounted = game.economy.maintenancePerYear(game.network, true);
    near('…25% cheaper in a region with existing railways', discounted,
      without * (1 - COSTS.OSM_RAIL_DISCOUNT), 1);

    const line = game.startLine('train');
    game.extendDraft(...at(1540, 1720));
    game.extendDraft(...at(1000, 2800));
    game.finishDraft();
    const inUse = game.bulldoze(a);
    check('track carrying a line cannot be bulldozed', inUse.error === 'trackInUse',
      JSON.stringify(inUse));
    check('…and is still there', game.network.tracks.has(a.id));

    game.bulldoze(line);
    for (const stop of [...game.network.stops.values()]) game.bulldoze(stop);
    const balance = game.economy.balance;
    const removed = game.bulldoze(a);
    check('bare track can be bulldozed', removed.ok === true && !game.network.tracks.has(a.id),
      JSON.stringify(removed));
    near('…refunding half of what it cost', game.economy.balance - balance,
      a.cost * COSTS.REFUND_RATE, 1);
  }

  // ─── Save and load ────────────────────────────────────────────────────────
  {
    const game = richGame();
    const at = (x, y) => game.frame.toLonLat(x, y);
    const a = drawTrack(game, 'train', [[1900, 1000], [700, 3400]]).track;
    drawTrack(game, 'train', [[5000, 700], [5950, 700]]);
    game.startTrack('metro');
    game.addTrackPoint(...at(1300, 2200));
    game.addTrackPoint(...at(2000, 1900));
    game.addTrackPoint(...at(5402, 702));
    const line = game.startLine('metro');
    game.extendDraft(...at(1540, 1720));
    game.extendDraft(...at(5800, 700));
    game.finishDraft();

    const save = JSON.parse(JSON.stringify(game.toJSON('fixture')));
    check('a save with rail stays small', JSON.stringify(save).length < 20000,
      `${JSON.stringify(save).length} bytes`);

    const restored = Game.fromJSON(save, fixture());
    check('every track survives a reload', restored.network.tracks.size === game.network.tracks.size);
    const again = restored.network.tracks.get(a.id);
    check('…rebuilt to exactly the same geometry',
      again && again.kinds.join() === a.kinds.join()
      && again.points.length === a.points.length
      && Math.abs(again.height[40] - a.height[40]) < 1e-9);
    const metro = [...restored.network.tracks.values()].find((t) => t.mode === 'metro');
    check('…junctions included', Boolean(metro?.start && metro?.end));
    const restoredLine = restored.network.lines.get(line.id);
    check('a rail line is re-routed on the reloaded track',
      restoredLine?.segments[0]?.onTrack === true
      && Math.abs(restoredLine.segments[0].lengthM - line.segments[0].lengthM) < 1e-6);
    check('stations keep their structure',
      [...restored.network.stops.values()].every((stop) =>
        stop.structure === game.network.stops.get(stop.id)?.structure));

    // The id collision this phase fixed. On a fresh page the id counter
    // starts at 1, and loading a save advances it by one per object rebuilt —
    // but a save's ids run higher than its object count as soon as anything
    // has been deleted (and stops, lines and track share one counter). In
    // this process the counter is long past the save's ids, so reproduce the
    // fresh page by renumbering the save to the ids the counter will reach
    // right after loading it.
    const next = Number(new Stop('bus', 0, 0, 0, '').id.slice(1)) + 1;
    const ids = [...save.stops, ...save.lines, ...save.tracks].map((item) => item.id);
    const renumber = new Map(ids.map((id, i) => [id, `${id[0]}${next + ids.length + i}`]));
    const clashing = JSON.parse(JSON.stringify(save)
      .replace(/\b[slt]\d+\b/g, (id) => renumber.get(id) ?? id));
    const reloaded = Game.fromJSON(clashing, fixture());
    const placed = reloaded.placeStop(...at(2400, 2400), 'bus');
    check('a stop built after loading never reuses an id from the save',
      placed.stop && !clashing.stops.some((stop) => stop.id === placed.stop.id)
      && reloaded.network.stops.size === clashing.stops.length + 1, placed.stop?.id);
    check('…and the renumbered save still loads whole',
      reloaded.network.lines.get(renumber.get(line.id))?.segments[0]?.onTrack === true);
  }
}

/** Just enough of a 2D context to record which colours were stroked. */
function mockContext(strokes) {
  const state = { strokeStyle: '' };
  return new Proxy({}, {
    get(target, key) {
      if (key === 'stroke') return () => strokes.push(state.strokeStyle);
      if (key in state) return state[key];
      return () => {};
    },
    set(target, key, value) {
      if (key === 'strokeStyle') state.strokeStyle = value;
      return true;
    },
  });
}
