/**
 * Track geometry: the spline, the grade rule, and structure classification.
 *
 * This is where the player stops choosing and the terrain decides. They draw a
 * line; this module works out where it has to tunnel, where it has to bridge,
 * and whether it is blocked by a building. The only way to avoid a tunnel is to
 * draw a better path.
 *
 * Everything here works in **local metres** via `LocalFrame`, not lon/lat. A
 * region is at most 15 km across, which is flat enough that the conversion is
 * exact to centimetres, and grades, clearances and collision cells are all
 * naturally metric. Only the endpoints convert.
 *
 * Phase 3 uses this for off-road tram segments. Phase 4 uses the same code for
 * metro and train track, which is why it is written per-mode rather than for
 * trams specifically.
 */

import { BUILD, COSTS, REGION } from '../config.js';
import { heightAt, isSea, isOccupied, pointInRing, LocalFrame } from '../model/region.js';
import { judgeRoadRules } from './rail-roads.js';

/**
 * Centripetal Catmull-Rom through the control points, resampled to an even
 * spacing.
 *
 * Centripetal (alpha = 0.5) rather than uniform or chordal because it is the
 * only one of the three that provably never forms a cusp or a self-
 * intersection between control points — which matters when the player is
 * dragging a point around and we are costing the result live.
 *
 * @param {Array<[number,number]>} control local-metre points, at least 2
 * @param {number} [sampleM] spacing of the returned points
 * @returns {Array<[number,number]>} evenly spaced local-metre points
 */
export function splinePoints(control, sampleM = BUILD.SAMPLE_M) {
  const points = control.filter((p, i) =>
    i === 0 || Math.hypot(p[0] - control[i - 1][0], p[1] - control[i - 1][1]) > 1e-6);
  if (points.length < 2) return points.slice();
  if (points.length === 2) return resample(points, sampleM);

  // Duplicate the ends so the first and last spans have neighbours to curve
  // against. Reflecting instead would overshoot; duplicating just makes the
  // ends behave like a straight run into the first real control point.
  const padded = [points[0], ...points, points.at(-1)];
  const curve = [];

  for (let i = 0; i + 3 < padded.length; i++) {
    const [p0, p1, p2, p3] = padded.slice(i, i + 4);
    const t0 = 0;
    const t1 = t0 + knot(p0, p1);
    const t2 = t1 + knot(p1, p2);
    const t3 = t2 + knot(p2, p3);
    // A zero-length knot interval would divide by zero below.
    if (t1 === t0 || t2 === t1 || t3 === t2) { curve.push(p1); continue; }

    // Enough subdivisions that the resample below has a smooth curve to walk,
    // independent of how far apart the control points are.
    const steps = Math.max(8, Math.ceil(dist(p1, p2) / (sampleM / 4)));
    for (let s = 0; s < steps; s++) {
      const t = t1 + (t2 - t1) * (s / steps);
      const a1 = lerpT(p0, p1, t0, t1, t);
      const a2 = lerpT(p1, p2, t1, t2, t);
      const a3 = lerpT(p2, p3, t2, t3, t);
      const b1 = lerpT(a1, a2, t0, t2, t);
      const b2 = lerpT(a2, a3, t1, t3, t);
      curve.push(lerpT(b1, b2, t1, t2, t));
    }
  }
  curve.push(points.at(-1));
  return resample(curve, sampleM);
}

const dist = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
/** Centripetal knot spacing: the square root of chord length. */
const knot = (a, b) => Math.sqrt(dist(a, b)) || 1e-6;

function lerpT(a, b, ta, tb, t) {
  const f = (tb - t) / (tb - ta);
  const g = (t - ta) / (tb - ta);
  return [a[0] * f + b[0] * g, a[1] * f + b[1] * g];
}

/**
 * Walk a polyline and emit a point every `spacing` metres.
 *
 * The grade rule, the collision check and the cost all assume evenly spaced
 * samples — an uneven spacing would weight a dense corner more heavily than a
 * long straight, and the smoothing step would clamp different distances per
 * step.
 *
 * @param {Array<[number,number]>} points
 * @param {number} spacing
 */
export function resample(points, spacing) {
  if (points.length < 2) return points.slice();
  const out = [points[0]];
  let carry = 0;

  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    let segment = dist(a, b);
    if (segment === 0) continue;
    let travelled = spacing - carry;
    while (travelled <= segment) {
      const t = travelled / segment;
      out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      travelled += spacing;
    }
    carry = segment - (travelled - spacing);
  }

  // Always finish exactly on the last control point, so the track meets the
  // stop it was drawn to rather than stopping up to one sample short.
  const last = points.at(-1);
  if (dist(out.at(-1), last) > 1e-6) out.push(last);
  return out;
}

/**
 * The height each sample would sit at if terrain were no obstacle.
 *
 * Tram and train follow the ground but never dip below a clearance above
 * water; metro sits a fixed depth underground, because a metro is underground
 * by default and only surfaces where the land falls away beneath it.
 *
 * @param {Array<[number,number]>} samples local metres
 * @param {Object} region
 * @param {string} mode
 * @returns {{desired:number[], terrain:number[], overWater:boolean[]}}
 */
export function desiredProfile(samples, region, mode) {
  const terrain = samples.map(([x, y]) => heightAt(region.terrain, x, y));
  const overWater = samples.map(([x, y]) =>
    isSea(region.terrain, x, y) || overInlandWater(region, x, y));
  const desired = terrain.map((ground, i) => {
    if (mode === 'metro') return ground - BUILD.METRO_DEPTH_M;
    if (!overWater[i]) return ground;
    // Over the sea the water surface is 0 m; over a lake the stored terrain is
    // effectively the water level, so clear whichever is higher.
    const surface = Math.max(0, ground);
    return Math.max(ground, surface + BUILD.WATER_CLEARANCE_M);
  });
  return { desired, terrain, overWater };
}

/** Lakes and rivers per region, in local metres with a bounding box each. */
const inlandWater = new WeakMap();

/**
 * Is this point on a lake or a river?
 *
 * The sea comes from the height grid, but lakes and rivers do not: the
 * elevation data has them as dry ground at the water's level, so a track
 * across a river would otherwise run straight through it at grade. The OSM
 * water polygons are what know where they are.
 */
export function overInlandWater(region, x, y) {
  let rings = inlandWater.get(region);
  if (!rings) {
    const frame = new LocalFrame(region.meta.bbox);
    rings = (region.water || []).map((ring) => {
      const local = ring.map(([lon, lat]) => frame.toLocal(lon, lat));
      const xs = local.map((p) => p[0]);
      const ys = local.map((p) => p[1]);
      return { local, minX: Math.min(...xs), maxX: Math.max(...xs),
        minY: Math.min(...ys), maxY: Math.max(...ys) };
    });
    inlandWater.set(region, rings);
  }
  for (const ring of rings) {
    if (x < ring.minX || x > ring.maxX || y < ring.minY || y > ring.maxY) continue;
    if (pointInRing(x, y, ring.local)) return true;
  }
  return false;
}

/**
 * Smooth a desired profile until no step exceeds the mode's maximum grade.
 *
 * The method, since the spec asks for it to be documented: build the highest
 * grade-feasible profile that stays at or below the desired one, build the
 * lowest that stays at or above it, and take the average.
 *
 *   lower[i] = min(desired[i], lower[i∓1] + g)   forward, then backward
 *   upper[i] = max(desired[i], upper[i∓1] − g)   forward, then backward
 *   height   = (lower + upper) / 2
 *
 * Both envelopes are feasible by construction, and the average of two profiles
 * whose steps are each within ±g has steps within ±g too — so the result is
 * feasible in one pass, with no iteration and no convergence test. The lower
 * envelope alone would cut through every hill and never bridge a valley; the
 * upper would bridge everything and never tunnel. Averaging gives tunnels
 * through hills and bridges over valleys, which is the behaviour the spec
 * describes.
 *
 * **Pinned ends.** An off-road segment runs between two stops that sit on the
 * street, so the track has to physically arrive at their height — a profile
 * that starts 36 m in the air means the tram leaves the stop on a bridge going
 * nowhere. Passing `pin` constrains the desired profile to the cone reachable
 * from both ends at the grade limit before the envelopes are built, which
 * makes the result meet the ends exactly and stay feasible in between. If the
 * two ends are further apart in height than the grade can bridge over the
 * length of the segment, no profile exists and this returns `null` — the
 * segment is genuinely too steep to build.
 *
 * **Pins anywhere.** Phase 4 needs more than the ends: a motorway crossing
 * pins the track a clearance above or below the road, mid-segment. The same
 * cone argument covers it. Clamp every sample into the cone of every pin,
 * `|h[i] − pin.height| ≤ g·|i − pin.index|`; then at a pinned sample the
 * lower envelope cannot go below the pin (every sample is within reach of
 * it) nor the upper above it, so both envelopes — and their average — pass
 * through it exactly. A set of pins is feasible exactly when each pair of
 * neighbouring pins is within reach of the other.
 *
 * @param {number[]} desired
 * @param {number} stepM distance between samples
 * @param {number} maxGrade as a fraction, e.g. 0.07
 * @param {{start:number, end:number}|Array<{index:number, height:number}>} [pin]
 *   heights the ends must meet, or any set of samples pinned to a height
 * @returns {number[]|null} null when the pins cannot be satisfied
 */
export function smoothProfile(desired, stepM, maxGrade, pin = null) {
  const n = desired.length;
  if (n === 0) return [];
  const g = maxGrade * stepM;

  if (pin && !Array.isArray(pin) && n === 1) return [pin.start];
  const pins = !pin ? []
    : Array.isArray(pin) ? pin.slice().sort((a, b) => a.index - b.index)
    : [{ index: 0, height: pin.start }, { index: n - 1, height: pin.end }];

  if (pins.length > 0) {
    // Unreachable: two pins differ by more than the grade can climb between them.
    for (let k = 1; k < pins.length; k++) {
      const reach = g * (pins[k].index - pins[k - 1].index);
      if (Math.abs(pins[k].height - pins[k - 1].height) > reach + 1e-9) return null;
    }
    desired = desired.map((value, i) => {
      let floor = -Infinity;
      let ceiling = Infinity;
      for (const { index, height } of pins) {
        const reach = g * Math.abs(i - index);
        floor = Math.max(floor, height - reach);
        ceiling = Math.min(ceiling, height + reach);
      }
      return Math.min(ceiling, Math.max(floor, value));
    });
  }

  const lower = desired.slice();
  for (let i = 1; i < n; i++) lower[i] = Math.min(lower[i], lower[i - 1] + g);
  for (let i = n - 2; i >= 0; i--) lower[i] = Math.min(lower[i], lower[i + 1] + g);

  const upper = desired.slice();
  for (let i = 1; i < n; i++) upper[i] = Math.max(upper[i], upper[i - 1] - g);
  for (let i = n - 2; i >= 0; i--) upper[i] = Math.max(upper[i], upper[i + 1] - g);

  return lower.map((low, i) => (low + upper[i]) / 2);
}

/**
 * Label each sample at-grade, tunnel or bridge, then merge away the flicker.
 *
 * `forced` marks samples whose structure is not the terrain's to decide — the
 * samples either side of a motorway crossing, which must be a bridge or a
 * tunnel however short. A run containing a forced sample is never merged
 * away, or a short motorway bridge would flicker back to a level crossing.
 *
 * A bridge over water is protected the same way. A river is often narrower
 * than the 60 m merge threshold, and merging its one or two samples into the
 * banks would run the track through the river at grade.
 *
 * @param {number[]} height smoothed track height
 * @param {number[]} terrain ground height at the same samples
 * @param {boolean[]} overWater
 * @param {number} stepM
 * @param {Array<string|undefined>} [forced] a structure per sample, or empty
 * @returns {string[]} one of 'atGrade' | 'tunnel' | 'bridge' per sample
 */
export function classifyStructures(height, terrain, overWater, stepM, forced = []) {
  const kinds = height.map((h, i) => {
    if (forced[i]) return forced[i];
    if (terrain[i] - h >= BUILD.TUNNEL_BELOW_M) return 'tunnel';
    if (h - terrain[i] >= BUILD.BRIDGE_ABOVE_M || overWater[i]) return 'bridge';
    return 'atGrade';
  });

  // Merge runs shorter than the minimum into whichever neighbour is longer, so
  // a few metres of rounding does not produce a two-sample "bridge".
  const minSamples = Math.max(1, Math.round(BUILD.MIN_STRUCTURE_RUN_M / stepM));
  for (let pass = 0; pass < 4; pass++) {
    const runs = runsOf(kinds);
    if (runs.length <= 1) break;
    let changed = false;
    for (let r = 0; r < runs.length; r++) {
      const run = runs[r];
      if (run.end - run.start + 1 >= minSamples) continue;
      if (hasForced(forced, run)) continue;
      if (run.kind === 'bridge' && hasWater(overWater, run)) continue;
      const before = runs[r - 1];
      const after = runs[r + 1];
      const winner = !before ? after : !after ? before
        : (before.end - before.start) >= (after.end - after.start) ? before : after;
      if (!winner) continue;
      for (let i = run.start; i <= run.end; i++) kinds[i] = winner.kind;
      changed = true;
    }
    if (!changed) break;
  }
  return kinds;
}

function hasForced(forced, run) {
  for (let i = run.start; i <= run.end; i++) if (forced[i]) return true;
  return false;
}

function hasWater(overWater, run) {
  for (let i = run.start; i <= run.end; i++) if (overWater[i]) return true;
  return false;
}

/** Contiguous runs of equal values, as {kind, start, end} inclusive. */
export function runsOf(kinds) {
  const runs = [];
  for (let i = 0; i < kinds.length; i++) {
    if (i === 0 || kinds[i] !== kinds[i - 1]) runs.push({ kind: kinds[i], start: i, end: i });
    else runs.at(-1).end = i;
  }
  return runs;
}

/**
 * Build a piece of off-road track and tell the caller everything about it.
 *
 * @param {Array<[number,number]>} controlLonLat control points, lon/lat
 * @param {Object} region
 * @param {import('../model/region.js').LocalFrame} frame
 * @param {string} mode
 * @returns {{points:Array<[number,number]>, lengthM:number, samples:Array<[number,number]>,
 *            height:number[], terrain:number[], kinds:string[],
 *            runs:Array<{kind:string,start:number,end:number,lengthM:number}>,
 *            blockedAt:number[], blocked:boolean, cost:number, offRoad:true}}
 */
export function buildTrack(controlLonLat, region, frame, mode) {
  const control = controlLonLat.map(([lon, lat]) => frame.toLocal(lon, lat));
  const samples = splinePoints(control, BUILD.SAMPLE_M);
  const stepM = BUILD.SAMPLE_M;

  const { desired, terrain, overWater } = desiredProfile(samples, region, mode);
  // The ends meet the stops they were drawn between, which are on the street.
  const pin = { start: desired[0], end: desired.at(-1) };
  const maxGrade = BUILD.MAX_GRADE[mode] ?? BUILD.MAX_GRADE.tram;
  const height = smoothProfile(desired, stepM, maxGrade, pin);
  if (!height) {
    return {
      points: samples.map(([x, y]) => frame.toLonLat(x, y)),
      samples, height: [], terrain, kinds: [], runs: [], blockedAt: [],
      blocked: true, tooSteep: true, lengthM: 0, cost: 0, offRoad: true,
    };
  }
  const kinds = classifyStructures(height, terrain, overWater, stepM);

  const runs = runsOf(kinds).map((run) => ({
    ...run,
    lengthM: (run.end - run.start) * stepM || stepM,
  }));

  const blockedAt = blockedSamples(samples, kinds, region, frame);

  let lengthM = 0;
  for (let i = 1; i < samples.length; i++) lengthM += dist(samples[i - 1], samples[i]);

  return {
    points: samples.map(([x, y]) => frame.toLonLat(x, y)),
    samples, height, terrain, kinds, runs, blockedAt,
    blocked: blockedAt.length > 0,
    lengthM,
    cost: trackCost(runs, stepM, mode),
    offRoad: true,
  };
}

/**
 * Which samples are blocked by a building.
 *
 * Tunnels pass beneath buildings freely, so only overground samples count.
 *
 * **The lead-in exemption.** An off-road segment starts and ends at stops,
 * which sit on road centrelines — and Phase R measured that about a quarter of
 * buildings in a dense city come within 3 m of a road centreline in OSM itself
 * (RESEARCH_TILES.md §5.1). Without an exemption, the first and last samples
 * of almost every off-road segment in a real city would land in a building's
 * occupancy cell and block track that visibly runs down the middle of a
 * street. The spec exempts on-street tram track from this rule; the first and
 * last `OFF_ROAD_STREET_LEAD_M` of an off-road segment are still leaving and
 * rejoining the street, so they are exempt too.
 *
 * Rail track built with the Build track tool passes `leadM = 0`: it does not
 * start on a street, so it gets no exemption.
 *
 * @param {number} [leadM] how much of each end is exempt
 * @returns {number[]} indices of blocked samples
 */
export function blockedSamples(samples, kinds, region, frame,
  leadM = BUILD.OFF_ROAD_STREET_LEAD_M) {
  if (!region.occupancy) return [];
  const leadSamples = Math.round(leadM / BUILD.SAMPLE_M);
  const blocked = [];
  for (let i = 0; i < samples.length; i++) {
    if (kinds[i] === 'tunnel') continue;
    if (i < leadSamples || i >= samples.length - leadSamples) continue;
    const [x, y] = samples[i];
    if (isOccupied(region.occupancy, x, y)) blocked.push(i);
  }
  return blocked;
}

/**
 * Build a piece of metro or train track: the whole grade rule, the building
 * rule and the rail-and-roads rules, in the order the spec gives them.
 *
 *   1. Spline through the waypoints, sampled every 20 m.
 *   2. Desired height: the terrain for train (cleared above water), 15 m
 *      under it for metro.
 *   3. Smooth with the ends pinned. A free end sits at its desired height; an
 *      end that joins existing track has to meet that track's height.
 *   4. Hard targets, then smooth again with them pinned. Over water a train
 *      is pinned at the clearance. At a motorway or trunk crossing the track
 *      is pinned 7 m above or 8 m below the road — whichever is nearer — if
 *      it is not already clear. The ramps then come out of the smoothing on
 *      their own, so the crossing becomes a short bridge or tunnel without
 *      the player choosing it.
 *   5. Classify and merge structures, keeping the forced crossings.
 *   6. Block anything overground inside a building, and any at-grade
 *      crossing that is too shallow or runs along a road.
 *   7. Price it: structure by structure, plus each level crossing.
 *
 * Unlike an off-road tram segment, nothing here is exempt at the ends: rail
 * track does not start on a street.
 *
 * @param {Array<[number,number]>} controlLonLat waypoints, lon/lat
 * @param {Object} region
 * @param {import('../model/region.js').LocalFrame} frame
 * @param {'metro'|'train'} mode
 * @param {{startHeight?:number|null, endHeight?:number|null,
 *          corridors?:import('./rail-roads.js').RoadCorridors|null}} [options]
 */
export function buildRailTrack(controlLonLat, region, frame, mode, options = {}) {
  const stepM = BUILD.SAMPLE_M;
  const control = controlLonLat.map(([lon, lat]) => frame.toLocal(lon, lat));
  const samples = splinePoints(control, stepM);
  const points = samples.map(([x, y]) => frame.toLonLat(x, y));
  const empty = {
    points, samples, height: [], terrain: [], overWater: [], kinds: [], runs: [],
    blockedAt: [], blocked: true, reason: null, lengthM: 0, cost: 0,
    levelCrossings: [], gradeSeparatedCrossings: 0,
  };
  if (samples.length < 2) return { ...empty, reason: 'tooShort' };

  const { desired, terrain, overWater } = desiredProfile(samples, region, mode);
  const maxGrade = BUILD.MAX_GRADE[mode];
  const ends = [
    { index: 0, height: options.startHeight ?? desired[0] },
    { index: samples.length - 1, height: options.endHeight ?? desired.at(-1) },
  ];

  let height = smoothProfile(desired, stepM, maxGrade, ends);
  if (!height) return { ...empty, terrain, overWater, reason: 'tooSteep', tooSteep: true };

  // Water clearance is a floor, not a wish. Averaging the envelopes would
  // otherwise leave a train about halfway up to it over a river, so every
  // over-water sample still below the clearance is pinned to it. Metro is
  // exempt: it passes under water by default.
  const waterPins = [];
  if (mode !== 'metro') {
    for (let i = 0; i < samples.length; i++) {
      if (!overWater[i]) continue;
      const clear = Math.max(0, terrain[i]) + BUILD.WATER_CLEARANCE_M;
      if (height[i] < clear) waterPins.push({ index: i, height: clear });
    }
  }

  // Motorway and trunk crossings: each wants the track a clearance above or
  // below the road. Try the nearer side for every crossing first; if those
  // cannot all be met at once, try going over all of them, then under.
  const crossings = options.corridors ? options.corridors.crossings(samples) : [];
  const separated = crossings.filter((crossing) => crossing.gradeSeparated);
  const gradeSeparatedCrossings = separated.length;
  let forced = [];

  if (waterPins.length > 0 || separated.length > 0) {
    let solved = null;
    for (const side of ['nearer', 'above', 'below']) {
      const attempt = crossingPins(separated, height, region, side);
      const smoothed = smoothProfile(desired, stepM, maxGrade,
        dedupePins([...ends, ...waterPins, ...attempt.pins]));
      if (smoothed) { solved = { height: smoothed, forced: attempt.forced }; break; }
      if (separated.length === 0) break;
    }
    if (!solved) {
      return { ...empty, terrain, overWater, gradeSeparatedCrossings,
        reason: 'tooSteep', tooSteep: true };
    }
    height = solved.height;
    forced = solved.forced;
  }

  const kinds = classifyStructures(height, terrain, overWater, stepM, forced);
  const runs = runsOf(kinds).map((run) => ({
    ...run,
    lengthM: (run.end - run.start) * stepM || stepM,
  }));

  const buildingBlocked = blockedSamples(samples, kinds, region, frame, 0);
  const rules = options.corridors
    ? judgeRoadRules(samples, kinds, crossings, options.corridors, stepM)
    : { levelCrossings: [], shallow: [], along: [] };

  // One reason is reported, the one most worth fixing first.
  const reason = buildingBlocked.length ? 'blockedByBuilding'
    : rules.shallow.length ? 'crossingTooShallow'
    : rules.along.length ? 'alongRoad'
    : null;
  const blockedAt = [...new Set([...buildingBlocked, ...rules.shallow, ...rules.along])]
    .sort((a, b) => a - b);

  let lengthM = 0;
  for (let i = 1; i < samples.length; i++) lengthM += dist(samples[i - 1], samples[i]);

  const structureCost = trackCost(runs, stepM, mode);
  const levelCrossings = rules.levelCrossings.map(({ x, y, roadBearing }) =>
    ({ lonLat: frame.toLonLat(x, y), roadBearing }));

  return {
    points, samples, height, terrain, overWater, kinds, runs, blockedAt,
    blocked: blockedAt.length > 0,
    reason,
    lengthM,
    structureCost,
    levelCrossings,
    gradeSeparatedCrossings,
    cost: structureCost + levelCrossings.length * COSTS.LEVEL_CROSSING,
  };
}

/**
 * Pins that hold the track clear of each motorway or trunk road it crosses,
 * on the two samples either side of the crossing.
 *
 * @param {'nearer'|'above'|'below'} side which clearance to aim for
 * @returns {{pins:Array<{index:number,height:number}>, forced:string[]}}
 */
function crossingPins(crossings, height, region, side) {
  const pins = [];
  const forced = [];
  for (const crossing of crossings) {
    const road = heightAt(region.terrain, crossing.x, crossing.y);
    const i = crossing.index;
    const here = (height[i] + height[i + 1]) / 2;
    const above = road + BUILD.MOTORWAY_CLEARANCE_ABOVE_M;
    const below = road - BUILD.MOTORWAY_CLEARANCE_BELOW_M;
    let target;
    if (side === 'above') target = Math.max(here, above);
    else if (side === 'below') target = Math.min(here, below);
    // Already clear of the road: hold it there, so other pins cannot drag
    // it back down onto the carriageway.
    else if (here >= above || here <= below) target = here;
    else target = above - here <= here - below ? above : below;

    const kind = target > road ? 'bridge' : 'tunnel';
    for (const index of [i, i + 1]) {
      pins.push({ index, height: target });
      forced[index] = kind;
    }
  }
  return { pins, forced };
}

/**
 * One pin per sample. The first wins, and the ends are listed first, so the
 * track always meets the junction it was drawn to; two motorways crossed in
 * one 20 m step simply share the first one's clearance, and a motorway over
 * a river keeps the water's.
 */
function dedupePins(pins) {
  const byIndex = new Map();
  for (const pin of pins) if (!byIndex.has(pin.index)) byIndex.set(pin.index, pin);
  return [...byIndex.values()];
}

/**
 * What a run of track costs, by structure.
 *
 * @param {Array<{kind:string,lengthM:number}>} runs
 * @param {number} stepM
 * @param {string} mode
 */
export function trackCost(runs, stepM, mode) {
  const rates = COSTS.TRACK_PER_KM[mode];
  if (!rates) return 0;
  let total = 0;
  for (const run of runs) {
    const rate = rates[run.kind] ?? rates.atGrade;
    total += rate * (run.lengthM / 1000);
  }
  return Math.round(total);
}

/**
 * What on-street tram track costs: cheap per km, no structures, no grade rule,
 * because it follows a road that already exists.
 *
 * @param {number} lengthM
 * @param {string} mode
 */
export function onStreetCost(lengthM, mode) {
  const rates = COSTS.TRACK_PER_KM[mode];
  if (!rates?.onStreet) return 0;
  return Math.round(rates.onStreet * (lengthM / 1000));
}

/**
 * The steepest grade anywhere in a profile, as a fraction. Used by the tests
 * to prove the smoothing actually honours the limit.
 */
export function maxGradeOf(height, stepM) {
  let worst = 0;
  for (let i = 1; i < height.length; i++) {
    worst = Math.max(worst, Math.abs(height[i] - height[i - 1]) / stepM);
  }
  return worst;
}
