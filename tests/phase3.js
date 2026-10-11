/**
 * Phase 3 logic tests: trams, off-road track and the grade rule.
 *
 * The last section drives the phase's actual acceptance criteria — a tram line
 * that follows only allowed roads, a dragged segment that leaves the road at a
 * higher price, and a steep off-road segment that gets a tunnel by itself —
 * because an acceptance criterion that is only ever checked by hand stops
 * being checked.
 *
 * Imported by tests/run.js; `check` and `near` are passed in so the suites
 * report as one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BUILD, COSTS } from '../config.js';
import { reviveRegion, setOccupied } from '../model/region.js';
import { Network } from '../model/network.js';
import { Game } from '../sim/game.js';
import {
  splinePoints, resample, smoothProfile, classifyStructures, runsOf,
  maxGradeOf, trackCost, onStreetCost, buildTrack, blockedSamples,
} from '../build/track-geometry.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = () => reviveRegion(
  JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'test-region.json'), 'utf8')));

export function runPhase3Tests(check, near) {
  // ─── The spline ───────────────────────────────────────────────────────────
  {
    const control = [[0, 0], [100, 0], [100, 100]];
    const points = splinePoints(control, 20);
    check('the spline starts on the first control point',
      points[0][0] === 0 && points[0][1] === 0);
    check('the spline ends on the last control point',
      Math.abs(points.at(-1)[0] - 100) < 1e-6 && Math.abs(points.at(-1)[1] - 100) < 1e-6);
    check('the spline is sampled at roughly the configured spacing', (() => {
      // The final step is whatever is left over, so check the interior.
      for (let i = 1; i < points.length - 1; i++) {
        const step = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
        if (Math.abs(step - 20) > 1) return false;
      }
      return true;
    })());

    // Centripetal Catmull-Rom's whole selling point: it rounds the corner
    // rather than cutting it or looping past it.
    const corner = points.some(([x, y]) => x > 60 && y > 10 && y < 60);
    check('the spline curves through the corner instead of cutting it', corner);

    // Two coincident control points used to divide by zero in the knot spacing.
    const degenerate = splinePoints([[0, 0], [0, 0], [50, 0]], 20);
    check('duplicate control points do not break the spline',
      degenerate.length >= 2 && degenerate.every(([x, y]) =>
        Number.isFinite(x) && Number.isFinite(y)));
    check('a two-point spline is just the straight line',
      splinePoints([[0, 0], [100, 0]], 20).length === 6);
  }

  {
    const even = resample([[0, 0], [100, 0]], 25);
    check('resample walks a straight line at the given spacing',
      even.length === 5 && Math.abs(even[1][0] - 25) < 1e-9);
    check('resample always lands exactly on the final point',
      Math.abs(even.at(-1)[0] - 100) < 1e-9);
  }

  // ─── The grade rule ───────────────────────────────────────────────────────
  {
    const step = BUILD.SAMPLE_M;
    const g = BUILD.MAX_GRADE.tram;

    const flat = smoothProfile(new Array(10).fill(5), step, g);
    check('flat ground needs no smoothing', flat.every((h) => Math.abs(h - 5) < 1e-9));

    // A cliff far steeper than any mode allows must come out within the limit.
    const cliff = Array.from({ length: 40 }, (_, i) => (i < 20 ? 0 : 100));
    const smoothed = smoothProfile(cliff, step, g);
    near('a cliff is smoothed to exactly the grade limit',
      maxGradeOf(smoothed, step), g, 1e-9);

    for (const [mode, limit] of Object.entries(BUILD.MAX_GRADE)) {
      const profile = smoothProfile(cliff, step, limit);
      check(`${mode} never exceeds its own maximum grade`,
        maxGradeOf(profile, step) <= limit + 1e-9,
        `${maxGradeOf(profile, step).toFixed(4)} > ${limit}`);
    }

    // Pinned ends: an off-road segment has to physically meet its stops.
    const bump = (i, amp) => amp * Math.exp(-(((i - 30) / 6) ** 2));
    const ridge = Array.from({ length: 60 }, (_, i) => bump(i, 80));
    const overRidge = smoothProfile(ridge, step, g, { start: ridge[0], end: ridge.at(-1) });
    near('a pinned profile starts exactly at the stop height', overRidge[0], ridge[0], 1e-6);
    near('a pinned profile ends exactly at the stop height', overRidge.at(-1), ridge.at(-1), 1e-6);
    check('a pinned profile still honours the grade limit',
      maxGradeOf(overRidge, step) <= g + 1e-9);
    check('the track cuts through a hill rather than climbing it',
      Math.max(...ridge.map((t, i) => t - overRidge[i])) > BUILD.TUNNEL_BELOW_M);

    const valley = Array.from({ length: 60 }, (_, i) => bump(i, -60));
    const overValley = smoothProfile(valley, step, g, { start: valley[0], end: valley.at(-1) });
    check('the track spans a valley rather than diving into it',
      Math.max(...overValley.map((h, i) => h - valley[i])) > BUILD.BRIDGE_ABOVE_M);

    check('ends further apart than the grade can climb are refused',
      smoothProfile([0, 200], 200, 0.07, { start: 0, end: 200 }) === null);
    check('ends the grade CAN reach are accepted',
      smoothProfile([0, 10], 200, 0.07, { start: 0, end: 10 }) !== null);
  }

  // ─── Structure classification ─────────────────────────────────────────────
  {
    const step = BUILD.SAMPLE_M;
    const n = 40;
    const flatTerrain = new Array(n).fill(0);
    const noWater = new Array(n).fill(false);

    const deep = classifyStructures(new Array(n).fill(-20), flatTerrain, noWater, step);
    check('track well below the ground is a tunnel', deep.every((k) => k === 'tunnel'));

    const high = classifyStructures(new Array(n).fill(20), flatTerrain, noWater, step);
    check('track well above the ground is a bridge', high.every((k) => k === 'bridge'));

    const level = classifyStructures(flatTerrain, flatTerrain, noWater, step);
    check('track on the ground is at grade', level.every((k) => k === 'atGrade'));

    // Small cuttings and embankments are free, per the spec.
    const shallow = classifyStructures(new Array(n).fill(-BUILD.TUNNEL_BELOW_M + 1),
      flatTerrain, noWater, step);
    check('a shallow cutting is not a tunnel', shallow.every((k) => k === 'atGrade'));

    // Over water is always a bridge, whatever the height says.
    const water = classifyStructures(flatTerrain, flatTerrain,
      new Array(n).fill(true), step);
    check('track over water is a bridge', water.every((k) => k === 'bridge'));

    // Short runs are merged away so the line does not flicker.
    const flicker = new Array(n).fill(0);
    flicker[20] = -30; // one lone sample deep underground
    const merged = classifyStructures(flicker, flatTerrain, noWater, step);
    check('a structure run shorter than the minimum is merged away',
      runsOf(merged).length === 1, runsOf(merged).map((r) => r.kind).join(','));

    const longEnough = flatTerrain.slice();
    const tunnelSamples = Math.ceil(BUILD.MIN_STRUCTURE_RUN_M / step) + 2;
    for (let i = 10; i < 10 + tunnelSamples; i++) longEnough[i] = -30;
    const kept = classifyStructures(longEnough, flatTerrain, noWater, step);
    check('a structure run longer than the minimum survives',
      kept.includes('tunnel'), runsOf(kept).map((r) => r.kind).join(','));
  }

  // ─── Costs ────────────────────────────────────────────────────────────────
  {
    near('on-street tram track is charged at the on-street rate',
      onStreetCost(1000, 'tram'), COSTS.TRACK_PER_KM.tram.onStreet, 1);
    check('a bus pays nothing for track — it drives on roads that exist',
      onStreetCost(1000, 'bus') === 0);

    const km = [{ kind: 'atGrade', lengthM: 1000 }];
    near('at-grade off-road tram track costs the at-grade rate',
      trackCost(km, 20, 'tram'), COSTS.TRACK_PER_KM.tram.atGrade, 1);
    check('a tunnel costs more than at grade',
      trackCost([{ kind: 'tunnel', lengthM: 1000 }], 20, 'tram') >
      trackCost(km, 20, 'tram'));
    check('off-road at-grade costs more than on-street',
      COSTS.TRACK_PER_KM.tram.atGrade > COSTS.TRACK_PER_KM.tram.onStreet);
  }

  // ─── Tram road restriction ────────────────────────────────────────────────
  {
    const region = fixture();
    const game = new Game(region);
    check('trams may not use residential roads',
      !BUILD.TRAM_ROADS.includes('residential'));
    check('trams may use pedestrian streets',
      BUILD.TRAM_ROADS.includes('pedestrian'));
    check('buses may use residential roads', BUILD.BUS_ROADS.includes('residential'));
    check('buses may NOT use pedestrian streets — that is the tram\'s privilege',
      !BUILD.BUS_ROADS.includes('pedestrian'));

    // The fixture has a pedestrian street ("Market Walk") precisely so both
    // sides of the rule have something real to bite on.
    const pedestrianEdges = region.roads.edges.filter((e) => e.cls === 'pedestrian');
    check('the fixture still contains a pedestrian street', pedestrianEdges.length > 0);
    const residentialEdges = region.roads.edges.filter((e) => e.cls === 'residential');
    check('the fixture still contains residential roads', residentialEdges.length > 0);

    // A node on a residential road must snap for a bus and not for a tram —
    // but only if it is a *pure* residential node. Most residential nodes are
    // junctions that also carry a secondary or tertiary road, and snapping a
    // tram to one of those is correct: the tram is using the bigger road.
    const tramClasses = new Set(BUILD.TRAM_ROADS);
    const classesAt = (node) => new Set(region.roads.edges
      .filter((e) => e.a === node || e.b === node).map((e) => e.cls));
    const pureResidential = residentialEdges
      .map((e) => e.a)
      .find((node) => ![...classesAt(node)].some((cls) => tramClasses.has(cls)));
    check('the fixture has a residential node that is not a tram junction',
      pureResidential !== undefined);

    if (pureResidential !== undefined) {
      const [lon, lat] = game.roadIndex.nodeLonLat(pureResidential);
      check('a purely residential node snaps for a bus',
        Boolean(game.roadIndex.snap(lon, lat, 'bus')));
      const tramSnap = game.roadIndex.snap(lon, lat, 'tram');
      check('a tram is never snapped onto a residential-only node',
        !tramSnap || tramSnap.node !== pureResidential);
    }
  }

  // ─── ACCEPTANCE: trams, off-road drags and automatic tunnels ──────────────
  {
    const region = fixture();
    const game = new Game(region);
    game.economy.balance = 1e11; // Not a test of affordability.
    const frame = game.frame;

    // Two stops either side of the fixture's ridge, which runs north-east to
    // south-west and peaks around 180 m. It exists for exactly this.
    const line = game.startLine('tram');
    const a = game.extendDraft(...frame.toLonLat(2600, 3000));
    const b = game.extendDraft(...frame.toLonLat(2600, 4400));
    game.finishDraft();

    check('ACCEPTANCE: a tram line can be drawn', !a.error && !b.error && line.stops.length === 2,
      `${a.error || ''} ${b.error || ''}`);

    check('ACCEPTANCE: a tram line follows only allowed roads', (() => {
      for (const segment of line.segments) {
        if (segment.offRoad) continue;
        for (const [lon, lat] of segment.points) {
          const snapped = game.roadIndex.snap(lon, lat, 'tram', 30);
          if (!snapped) return false;
        }
      }
      return true;
    })());

    const onStreetLength = line.lengthM;
    const onStreetPrice = game.network.trackCostOf(line);
    check('ACCEPTANCE: on-street tram track is charged, and cheaply',
      onStreetPrice > 0, `${onStreetPrice}`);
    near('…at the on-street rate',
      onStreetPrice, onStreetCost(onStreetLength, 'tram'), 1);

    // Now drag the segment off the road, over the ridge.
    const [from, to] = line.stops;
    const balanceBefore = game.economy.balance;
    const dragged = game.setVia(line, from, to, frame.toLonLat(3200, 3700));
    check('ACCEPTANCE: a segment can be dragged off the road',
      dragged.ok === true, JSON.stringify(dragged));

    const segment = line.segments[0];
    check('ACCEPTANCE: the dragged segment is dedicated track, not a road route',
      segment.offRoad === true);
    check('ACCEPTANCE: the dragged segment costs more than the road route it replaced',
      segment.cost > onStreetPrice,
      `off-road ${Math.round(segment.cost / 1e6)}M vs on-street ${Math.round(onStreetPrice / 1e6)}M`);
    check('…and the player was actually charged the difference',
      balanceBefore - game.economy.balance === dragged.cost,
      `${balanceBefore - game.economy.balance} vs ${dragged.cost}`);

    const kinds = new Set(segment.kinds);
    check('ACCEPTANCE: a steep off-road segment gets a tunnel by itself',
      kinds.has('tunnel'),
      `structures found: ${[...kinds].join(', ')}`);
    check('…and the player never chose it — no tunnel tool exists',
      !('tunnel' in game) && segment.kinds.length > 0);

    check('the grade rule honoured the tram limit over real terrain',
      maxGradeOf(segment.height, BUILD.SAMPLE_M) <= BUILD.MAX_GRADE.tram + 1e-9,
      `${maxGradeOf(segment.height, BUILD.SAMPLE_M).toFixed(4)}`);
    check('the track meets both stops at ground level',
      Math.abs(segment.height[0] - segment.terrain[0]) < 1e-6 &&
      Math.abs(segment.height.at(-1) - segment.terrain.at(-1)) < 1e-6);

    // Clearing the drag puts the line back on the road and refunds half.
    const beforeClear = game.economy.balance;
    const cleared = game.setVia(line, from, to, null);
    check('clearing a drag returns the segment to the road',
      cleared.ok && line.segments[0].offRoad !== true);
    check('…and refunds, rather than charging again', game.economy.balance > beforeClear);
  }

  // ─── A bus drag is a via-point, not off-road track ────────────────────────
  {
    const region = fixture();
    const game = new Game(region);
    game.economy.balance = 1e11;
    const frame = game.frame;

    const line = game.startLine('bus');
    game.extendDraft(...frame.toLonLat(2400, 1200));
    game.extendDraft(...frame.toLonLat(3400, 1200));
    game.finishDraft();

    if (line.stops.length === 2) {
      const [from, to] = line.stops;
      const direct = line.segments[0].lengthM;
      const result = game.setVia(line, from, to, frame.toLonLat(2900, 2000));
      check('a bus drag is accepted', result.ok === true, JSON.stringify(result));
      check('a bus drag stays on the roads — never dedicated track',
        line.segments[0].offRoad !== true);
      check('a bus drag forces a longer route through the dragged point',
        line.segments[0].lengthM > direct,
        `${Math.round(line.segments[0].lengthM)} vs ${Math.round(direct)}`);
      check('a bus pays nothing for being dragged', result.cost === 0, `${result.cost}`);
    } else {
      check('a bus line could be drawn for the drag test', false,
        `${line.stops.length} stops`);
    }
  }

  // ─── Track maintenance ────────────────────────────────────────────────────
  {
    const region = fixture();
    const game = new Game(region);
    game.economy.balance = 1e11;
    const frame = game.frame;

    const bus = game.startLine('bus');
    game.extendDraft(...frame.toLonLat(2400, 1200));
    game.extendDraft(...frame.toLonLat(3400, 1200));
    game.finishDraft();
    const busOnly = game.economy.maintenancePerYear(game.network, false);

    const tram = game.startLine('tram');
    game.extendDraft(...frame.toLonLat(2600, 3000));
    game.extendDraft(...frame.toLonLat(2600, 4400));
    game.finishDraft();
    const withTram = game.economy.maintenancePerYear(game.network, false);

    check('a bus line pays no track maintenance — it has no track',
      bus.trackCost === 0);
    check('a tram line pays maintenance on its track', withTram > busOnly,
      `${Math.round(withTram)} vs ${Math.round(busOnly)}`);

    // Isolate the track component: the tram line also added two stops, which
    // carry their own maintenance.
    const trackPart = tram.trackCost;
    tram.trackCost = 0;
    const withoutTrack = game.economy.maintenancePerYear(game.network, false);
    tram.trackCost = trackPart;
    near('…at exactly the configured rate',
      withTram - withoutTrack, trackPart * COSTS.MAINTENANCE_RATE, 1);
    check('track maintenance is a real cost, not a rounding error',
      withTram - withoutTrack > 1e5,
      `${Math.round(withTram - withoutTrack)}/yr on ` +
      `${Math.round(trackPart / 1e6)}M of track`);
  }

  // ─── Buildings block surface track ────────────────────────────────────────
  {
    const region = fixture();
    const game = new Game(region);
    const frame = game.frame;

    // Find a short stretch of genuinely empty ground to use as the baseline.
    // The fixture is full of buildings, so picking coordinates by eye picks
    // one of them — which is how this test first "failed" against correct code.
    let span = null;
    for (let y = 1200; y <= 4600 && !span; y += 200) {
      for (let x = 2400; x <= 4600; x += 200) {
        const control = [frame.toLonLat(x, y), frame.toLonLat(x + 200, y + 60),
          frame.toLonLat(x + 400, y)];
        const track = buildTrack(control, region, frame, 'tram');
        if (!track.blocked && track.kinds.every((k) => k === 'atGrade')) {
          span = { x, y, control, track };
          break;
        }
      }
    }
    check('the fixture has some empty ground to build across', span !== null);

    if (span) {
      check('a short off-road run over clear ground is not blocked', !span.track.blocked);

      // Burn a wall of occupancy across the middle of that run, far enough
      // from both ends to be past the street lead-in.
      const { cellM } = region.occupancy;
      const midX = span.x + 200;
      for (let x = midX - 50; x <= midX + 50; x += cellM / 2) {
        for (let y = span.y - 80; y <= span.y + 140; y += cellM / 2) {
          setOccupied(region.occupancy, Math.floor(x / cellM), Math.floor(y / cellM));
        }
      }

      const blocked = buildTrack(span.control, region, frame, 'tram');
      check('ACCEPTANCE: a building blocks surface track', blocked.blocked,
        `${blocked.blockedAt.length} blocked samples`);

      check('…and the game refuses to build through it', (() => {
        const g2 = new Game(region);
        g2.economy.balance = 1e11;
        const line = g2.startLine('tram');
        g2.extendDraft(span.control[0][0], span.control[0][1]);
        g2.extendDraft(span.control[2][0], span.control[2][1]);
        if (line.stops.length !== 2) return true; // no tram road here to test with
        g2.finishDraft();
        const result = g2.setVia(line, line.stops[0], line.stops[1], span.control[1]);
        return result.error === 'blockedByBuilding';
      })());

      // Tunnels pass beneath buildings freely, per the spec.
      const allTunnel = new Array(blocked.samples.length).fill('tunnel');
      check('a tunnel passes beneath a building freely',
        blockedSamples(blocked.samples, allTunnel, region, frame).length === 0);

      // The lead-in at each end is street running, and exempt.
      const allAtGrade = new Array(blocked.samples.length).fill('atGrade');
      const lead = Math.round(BUILD.OFF_ROAD_STREET_LEAD_M / BUILD.SAMPLE_M);
      check('the street lead-in at each end is exempt from the building rule',
        blockedSamples(blocked.samples, allAtGrade, region, frame)
          .every((i) => i >= lead && i < blocked.samples.length - lead));
    }
  }
}
