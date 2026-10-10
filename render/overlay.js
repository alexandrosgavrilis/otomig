/**
 * The Canvas 2D overlay: one canvas sitting exactly over the MapLibre map,
 * where everything that moves or that the player draws is rendered.
 *
 * MapLibre owns the calm static world. This owns lines, stops, vehicles and
 * passengers, because Mini Metro's line patterns — dotted circles inside a
 * tram line, triangles inside a metro line — are far easier with a path and a
 * stroke than with style rules.
 *
 * The two stay glued together by redrawing on MapLibre's own `render` event and
 * projecting every position through `map.project`. That is the only correct
 * hook: `move` fires too rarely during inertial panning, and a rAF loop of our
 * own would drift a frame behind the map.
 *
 * Phase 1 draws only the region boundary, which is enough to prove the
 * projection and the device-pixel scaling are right. Phase 2 fills it in.
 */

import { COLORS, RENDER, DIFFICULTY } from '../config.js';
import {
  strokePath, drawLinePattern, drawVehicle, drawStop, drawInterchange,
  drawWaiting, drawWaitRing, offsetPolyline, shade,
} from './shapes.js';

export class Overlay {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {maplibregl.Map} map
   */
  constructor(canvas, map) {
    this.canvas = canvas;
    this.map = map;
    this.ctx = canvas.getContext('2d');
    /** Painters run in order on every frame. Phase 2 pushes lines and vehicles. */
    this.painters = [];

    this._onRender = () => this.draw();
    this._onResize = () => { this.resize(); this.draw(); };

    map.on('render', this._onRender);
    window.addEventListener('resize', this._onResize);
    this.resize();
  }

  /**
   * Match the canvas's backing store to the display size times the device pixel
   * ratio, then scale the context so all drawing code can work in CSS pixels.
   * Without this, every line is soft on a high-DPI screen.
   */
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const { clientWidth, clientHeight } = this.canvas;
    this.canvas.width = Math.round(clientWidth * dpr);
    this.canvas.height = Math.round(clientHeight * dpr);
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.width = clientWidth;
    this.height = clientHeight;
  }

  /** Project a lon/lat to CSS pixels on the canvas. @returns {[number,number]} */
  project(lon, lat) {
    const point = this.map.project([lon, lat]);
    return [point.x, point.y];
  }

  /** Unproject CSS pixels back to lon/lat. @returns {[number,number]} */
  unproject(x, y) {
    const lngLat = this.map.unproject([x, y]);
    return [lngLat.lng, lngLat.lat];
  }

  draw() {
    const { ctx } = this;
    ctx.clearRect(0, 0, this.width, this.height);
    for (const painter of this.painters) painter(ctx, this);
  }

  destroy() {
    this.map.off('render', this._onRender);
    window.removeEventListener('resize', this._onResize);
  }
}

/**
 * A hairline around the imported square, so the edge of the world is visible
 * rather than just an abrupt end to the roads.
 *
 * @param {[number,number,number,number]} bbox
 */
export function regionBoundaryPainter(bbox) {
  const [west, south, east, north] = bbox;
  return (ctx, overlay) => {
    const corners = [[west, south], [east, south], [east, north], [west, north]]
      .map(([lon, lat]) => overlay.project(lon, lat));

    ctx.save();
    ctx.strokeStyle = COLORS.roadMajor;
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(corners[0][0], corners[0][1]);
    for (let i = 1; i < corners.length; i++) ctx.lineTo(corners[i][0], corners[i][1]);
    ctx.closePath();
    ctx.stroke();
    ctx.restore();
  };
}

/* ─── Game painters ────────────────────────────────────────────────────────
 *
 * Each returns a painter closure for Overlay.painters. They are pushed in
 * draw order: lines first, then interchange rings, stops, waiting passengers,
 * and finally vehicles on top.
 */

/**
 * Lines, with their mode pattern inside and side-by-side offsets where several
 * share the same stretch of road.
 *
 * Segments between the same pair of stops come out of the router as the same
 * node path, so a signature built from the path's endpoints and length is
 * enough to spot sharing without comparing whole polylines.
 */
export function linesPainter(game) {
  return (ctx, overlay) => {
    const { network } = game;
    const zoomScale = Math.min(2, Math.max(0.6, overlay.map.getZoom() / 14));
    const width = RENDER.LINE_WIDTH_PX * zoomScale;

    // Group shared segments so each line in a bundle gets its own offset.
    /** @type {Map<string, Array<{line:object, segment:object}>>} */
    const bundles = new Map();
    for (const line of network.lines.values()) {
      for (const segment of line.segments) {
        const key = segmentSignature(segment);
        if (!bundles.has(key)) bundles.set(key, []);
        bundles.get(key).push({ line, segment });
      }
    }

    for (const bundle of bundles.values()) {
      bundle.forEach(({ line, segment }, index) => {
        const points = segment.points.map(([lon, lat]) => overlay.project(lon, lat));
        if (points.length < 2) return;

        // Centre the bundle on the road: one line sits on it, two straddle it.
        const spread = (index - (bundle.length - 1) / 2) * RENDER.LINE_OFFSET_PX * zoomScale;
        const drawn = offsetPolyline(points, spread);

        strokePath(ctx, drawn, line.color, width);
        drawLinePattern(ctx, drawn, line.mode, line.color, width);
      });
    }
  };
}

/** Interchange rings, under the stops they join. */
export function interchangesPainter(game) {
  return (ctx, overlay) => {
    for (const interchange of game.network.interchanges.values()) {
      const points = interchange.stops
        .map((id) => game.network.stops.get(id))
        .filter(Boolean)
        .map((stop) => overlay.project(stop.lon, stop.lat));
      drawInterchange(ctx, points);
    }
  };
}

/** Stops, their waiting passengers, and the patience ring. */
export function stopsPainter(game) {
  return (ctx, overlay) => {
    const patienceSeconds = DIFFICULTY[game.difficulty].patienceSimMinutes * 60;
    const simNow = game.clock.simSeconds;

    for (const stop of game.network.stops.values()) {
      const [x, y] = overlay.project(stop.lon, stop.lat);
      const radius = RENDER.STOP_RADIUS_PX[stop.mode] ?? 4;

      // The ring tracks the OLDEST waiting passenger, because that is the one
      // about to give up.
      if (stop.waiting.length > 0) {
        let oldest = 0;
        for (const dot of stop.waiting) {
          oldest = Math.max(oldest, simNow - dot.waitingSince);
        }
        drawWaitRing(ctx, x, y, radius, oldest / patienceSeconds);
      }

      drawStop(ctx, x, y, stop.mode, game.selection?.id === stop.id);
      drawWaiting(ctx, x, y, stop.waiting.length, radius);
    }
  };
}

/** Vehicles, on top of everything. */
export function vehiclesPainter(game) {
  return (ctx, overlay) => {
    const zoomScale = Math.min(1.8, Math.max(0.7, overlay.map.getZoom() / 14));
    for (const line of game.network.lines.values()) {
      for (const vehicle of line.vehicles) {
        if (!vehicle.lon && !vehicle.lat) continue;
        const [x, y] = overlay.project(vehicle.lon, vehicle.lat);
        if (x < -40 || y < -40 || x > overlay.width + 40 || y > overlay.height + 40) continue;
        drawVehicle(ctx, x, y, vehicle.bearing, line.mode, line.color,
          vehicle.load, zoomScale);
      }
    }
  };
}

/**
 * The line currently being drawn: the confirmed part solid, plus a dashed
 * rubber band from the last stop to the cursor, so the player can see what a
 * click would add before committing to it.
 */
export function draftPainter(game) {
  return (ctx, overlay) => {
    const draft = game.draft;
    if (!draft || !draft.line) return;
    const zoomScale = Math.min(2, Math.max(0.6, overlay.map.getZoom() / 14));

    if (draft.cursor && draft.line.stops.length > 0) {
      const lastStop = game.network.stops.get(draft.line.stops.at(-1));
      if (!lastStop) return;
      const from = overlay.project(lastStop.lon, lastStop.lat);
      const to = overlay.project(draft.cursor[0], draft.cursor[1]);

      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = draft.valid === false
        ? '#E4463C'
        : shade(draft.line.color, 0.25);
      ctx.lineWidth = RENDER.LINE_WIDTH_PX * zoomScale * 0.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(from[0], from[1]);
      ctx.lineTo(to[0], to[1]);
      ctx.stroke();
      ctx.restore();
    }
  };
}

/** Cheap identity for a routed segment, used to spot shared road stretches. */
function segmentSignature(segment) {
  const points = segment.points;
  if (points.length === 0) return 'empty';
  const [aLon, aLat] = points[0];
  const [bLon, bLat] = points[points.length - 1];
  // Order-independent, so A→B and B→A bundle together.
  const forward = `${aLon.toFixed(6)},${aLat.toFixed(6)}|${bLon.toFixed(6)},${bLat.toFixed(6)}`;
  const backward = `${bLon.toFixed(6)},${bLat.toFixed(6)}|${aLon.toFixed(6)},${aLat.toFixed(6)}`;
  const ends = forward < backward ? forward : backward;
  return `${ends}@${Math.round(segment.lengthM)}`;
}
