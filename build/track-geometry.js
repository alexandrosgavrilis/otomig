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
import { heightAt, isSea, isOccupied } from '../model/region.js';

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
  const overWater = samples.map(([x, y]) => isSea(region.terrain, x, y));
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
 * @param {number[]} desired
 * @param {number} stepM distance between samples
 * @param {number} maxGrade as a fraction, e.g. 0.07
 * @param {{start:number, end:number}} [pin] heights the ends must meet
 * @returns {number[]|null} null when `pin` cannot be satisfied
 */
export function smoothProfile(desired, stepM, maxGrade, pin = null) {
  const n = desired.length;
  if (n === 0) return [];
  const g = maxGrade * stepM;

  if (pin) {
    if (n === 1) return [pin.start];
    // Unreachable: the ends differ by more than the grade can climb.
    if (Math.abs(pin.end - pin.start) > g * (n - 1) + 1e-9) return null;
    desired = desired.map((value, i) => {
      const floor = Math.max(pin.start - g * i, pin.end - g * (n - 1 - i));
      const ceiling = Math.min(pin.start + g * i, pin.end + g * (n - 1 - i));
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
 * @param {number[]} height smoothed track height
 * @param {number[]} terrain ground height at the same samples
 * @param {boolean[]} overWater
 * @param {number} stepM
 * @returns {string[]} one of 'atGrade' | 'tunnel' | 'bridge' per sample
 */
export function classifyStructures(height, terrain, overWater, stepM) {
  const kinds = height.map((h, i) => {
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
 * @returns {number[]} indices of blocked samples
 */
export function blockedSamples(samples, kinds, region, frame) {
  if (!region.occupancy) return [];
  const leadSamples = Math.round(BUILD.OFF_ROAD_STREET_LEAD_M / BUILD.SAMPLE_M);
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
