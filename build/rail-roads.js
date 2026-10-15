/**
 * Rail and roads: where track meets the street network, and what the spec
 * lets it do there.
 *
 * Train track and overground metro track may cross roads but never run along
 * them. Concretely, for at-grade track:
 *
 *   - a crossing must meet the road at `BUILD.MIN_CROSSING_ANGLE_DEG` or more;
 *   - more than `BUILD.MAX_ALONG_ROAD_M` of continuous track inside a road's
 *     corridor is blocked;
 *   - every valid crossing becomes a level crossing, at a price;
 *   - motorways and trunk roads are never crossed at grade at all — the grade
 *     rule is handed a clearance target instead, and builds the bridge or
 *     tunnel itself.
 *
 * Roads that are themselves on a bridge or in a tunnel in OSM don't count:
 * the rail passes under or over them. Footways, paths and cycleways never
 * reach the road graph in the first place (see `ROAD_CLASSES` in
 * data/overpass.js), so they are ignored by construction.
 *
 * Trams are exempt, and never come through here.
 *
 * Everything works in local metres. Road edges are straight node-to-node
 * segments, so a crossing is an exact segment intersection, not a guess.
 */

import { BUILD } from '../config.js';

/** Bucket size for the segment grid, m. Big enough that a 20 m track step spans at most two. */
const CELL_M = 50;

/** Half-width of a road's corridor, by class. */
export function corridorHalfWidth(cls) {
  return BUILD.ROAD_CORRIDOR_M[cls] ?? BUILD.ROAD_CORRIDOR_M.default;
}

/** Is this road class crossed only by bridge or tunnel? */
export function isGradeSeparated(cls) {
  return BUILD.GRADE_SEPARATED_ROADS.includes(cls);
}

/**
 * A spatial index over the road segments that rail has to respect.
 *
 * Built once per game, lazily, because a bus-only game never needs it.
 */
export class RoadCorridors {
  /**
   * @param {import('../model/region.js').RoadGraph} roads
   * @param {import('../model/region.js').LocalFrame} frame
   */
  constructor(roads, frame) {
    /** Flat [ax, ay, bx, by] per segment. */
    this.coords = [];
    /** @type {Array<{cls:string, halfWidth:number}>} */
    this.meta = [];

    for (const edge of roads.edges) {
      // A road on a bridge or in a tunnel is already grade-separated from us.
      if (edge.bridge || edge.tunnel) continue;
      const [ax, ay] = frame.toLocal(roads.nodes[2 * edge.a], roads.nodes[2 * edge.a + 1]);
      const [bx, by] = frame.toLocal(roads.nodes[2 * edge.b], roads.nodes[2 * edge.b + 1]);
      this.coords.push(ax, ay, bx, by);
      this.meta.push({ cls: edge.cls, halfWidth: corridorHalfWidth(edge.cls) });
    }

    this.cols = Math.max(1, Math.ceil(frame.widthM / CELL_M));
    this.rows = Math.max(1, Math.ceil(frame.heightM / CELL_M));
    /** Cell index → segment indices. Sparse: most cells of a rural region are empty. */
    this.cells = new Map();

    for (let s = 0; s < this.meta.length; s++) {
      const [ax, ay, bx, by] = this.coords.slice(4 * s, 4 * s + 4);
      // Insert by the corridor's bounding box, not the centreline's, so a point
      // query finds every corridor it might be inside.
      const pad = this.meta[s].halfWidth;
      this.forCells(Math.min(ax, bx) - pad, Math.min(ay, by) - pad,
        Math.max(ax, bx) + pad, Math.max(ay, by) + pad, (cell) => {
          let list = this.cells.get(cell);
          if (!list) this.cells.set(cell, list = []);
          list.push(s);
        });
    }
  }

  forCells(minX, minY, maxX, maxY, visit) {
    const c0 = Math.max(0, Math.floor(minX / CELL_M));
    const c1 = Math.min(this.cols - 1, Math.floor(maxX / CELL_M));
    const r0 = Math.max(0, Math.floor(minY / CELL_M));
    const r1 = Math.min(this.rows - 1, Math.floor(maxY / CELL_M));
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) visit(r * this.cols + c);
    }
  }

  /** Segment indices whose corridors might touch a box. */
  candidates(minX, minY, maxX, maxY) {
    const found = new Set();
    this.forCells(minX, minY, maxX, maxY, (cell) => {
      for (const s of this.cells.get(cell) || []) found.add(s);
    });
    return found;
  }

  /**
   * Every place the track's centreline crosses a road's centreline.
   *
   * @param {Array<[number,number]>} samples evenly spaced local-metre points
   * @returns {Array<{index:number, x:number, y:number, angleDeg:number,
   *                   cls:string, gradeSeparated:boolean, roadBearing:number}>}
   *   `index` is the track step the crossing lies on: between sample `index`
   *   and `index + 1`.
   */
  crossings(samples) {
    const found = [];
    for (let i = 0; i < samples.length - 1; i++) {
      const [px, py] = samples[i];
      const [qx, qy] = samples[i + 1];
      for (const s of this.candidates(Math.min(px, qx), Math.min(py, qy),
        Math.max(px, qx), Math.max(py, qy))) {
        const [ax, ay, bx, by] = this.coords.slice(4 * s, 4 * s + 4);
        const hit = intersect(px, py, qx, qy, ax, ay, bx, by);
        if (!hit) continue;

        // Two road segments meeting at a node both report a crossing at that
        // node. It is one road, crossed once.
        const duplicate = found.some((other) =>
          Math.hypot(other.x - hit.x, other.y - hit.y) < 1 && other.cls === this.meta[s].cls);
        if (duplicate) continue;

        found.push({
          index: i,
          x: hit.x,
          y: hit.y,
          angleDeg: crossingAngle(qx - px, qy - py, bx - ax, by - ay),
          cls: this.meta[s].cls,
          gradeSeparated: isGradeSeparated(this.meta[s].cls),
          roadBearing: Math.atan2(by - ay, bx - ax),
        });
      }
    }
    return found;
  }

  /** Is this point inside any road's corridor? */
  inCorridor(x, y) {
    for (const s of this.candidates(x, y, x, y)) {
      const [ax, ay, bx, by] = this.coords.slice(4 * s, 4 * s + 4);
      if (pointSegmentDistance(x, y, ax, ay, bx, by) <= this.meta[s].halfWidth) return true;
    }
    return false;
  }
}

/**
 * Apply the rail-and-roads rules to a classified track.
 *
 * Only at-grade samples are judged: a bridge passes over the road and a tunnel
 * under it, and either may follow a road for as long as it likes, as real
 * elevated railways do.
 *
 * @param {Array<[number,number]>} samples
 * @param {string[]} kinds per-sample structure
 * @param {ReturnType<RoadCorridors['crossings']>} crossings
 * @param {RoadCorridors} corridors
 * @param {number} stepM
 * @returns {{levelCrossings:Array<{x:number,y:number,roadBearing:number}>,
 *            shallow:number[], along:number[]}} sample indices blocked by each rule
 */
export function judgeRoadRules(samples, kinds, crossings, corridors, stepM) {
  const levelCrossings = [];
  const shallow = [];

  for (const crossing of crossings) {
    // Which sample the crossing belongs to: the nearer end of its step.
    const [ax, ay] = samples[crossing.index];
    const [bx, by] = samples[crossing.index + 1];
    const nearer = Math.hypot(crossing.x - ax, crossing.y - ay) <=
      Math.hypot(crossing.x - bx, crossing.y - by) ? crossing.index : crossing.index + 1;
    if (kinds[nearer] !== 'atGrade') continue;

    // A grade-separated road crossed at grade can only mean the clearance
    // target could not be met; the grade rule refuses that case itself, so
    // there is nothing to add here.
    if (crossing.gradeSeparated) continue;

    // A hair of tolerance, so a track drawn at exactly 45° across a street
    // grid is not refused over floating-point dust.
    if (crossing.angleDeg < BUILD.MIN_CROSSING_ANGLE_DEG - 1e-6) {
      shallow.push(crossing.index, crossing.index + 1);
    } else {
      levelCrossings.push({ x: crossing.x, y: crossing.y, roadBearing: crossing.roadBearing });
    }
  }

  // Running along a road: a run of consecutive at-grade samples inside any
  // road's corridor. Each sample stands for one step of track, so a run of k
  // samples is k × stepM long. A square crossing of the widest corridor holds
  // at most two samples (24 m), and a 45° crossing at most two as well, so the
  // 40 m limit catches running along a road without ever catching a crossing.
  const along = [];
  let run = [];
  const flush = () => {
    if (run.length * stepM > BUILD.MAX_ALONG_ROAD_M) along.push(...run);
    run = [];
  };
  for (let i = 0; i < samples.length; i++) {
    if (kinds[i] === 'atGrade' && corridors.inCorridor(samples[i][0], samples[i][1])) run.push(i);
    else flush();
  }
  flush();

  return { levelCrossings, shallow, along };
}

/**
 * Intersection of segments PQ and AB, or null. Touching at an endpoint counts,
 * so a crossing exactly on a track sample is not lost between two steps.
 */
function intersect(px, py, qx, qy, ax, ay, bx, by) {
  const rx = qx - px, ry = qy - py;
  const sx = bx - ax, sy = by - ay;
  const denominator = rx * sy - ry * sx;
  if (Math.abs(denominator) < 1e-12) return null; // parallel
  const t = ((ax - px) * sy - (ay - py) * sx) / denominator;
  const u = ((ax - px) * ry - (ay - py) * rx) / denominator;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { x: px + rx * t, y: py + ry * t };
}

/** The acute angle between two directions, degrees, 0–90. */
export function crossingAngle(dx1, dy1, dx2, dy2) {
  const dot = Math.abs(dx1 * dx2 + dy1 * dy2);
  const lengths = Math.hypot(dx1, dy1) * Math.hypot(dx2, dy2);
  if (lengths === 0) return 90;
  return Math.acos(Math.min(1, dot / lengths)) * 180 / Math.PI;
}

function pointSegmentDistance(x, y, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const lengthSq = dx * dx + dy * dy;
  const t = lengthSq === 0 ? 0 : Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / lengthSq));
  return Math.hypot(x - (ax + dx * t), y - (ay + dy * t));
}
