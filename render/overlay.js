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

import { COLORS, RENDER, BUILD } from '../config.js';
import { STRINGS } from '../ui/strings.js';
import { formatMoney } from '../sim/economy.js';
import { patienceFor } from '../sim/passengers.js';
import {
  strokePath, drawLinePattern, drawVehicle, drawStop, drawInterchange,
  drawTrackStructure, drawDragPreview, drawBareTrack, drawLevelCrossing,
  drawTrackPreview, drawWaypoint, drawIntercityMark, drawStopGhost, drawDirectionArrows,
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

/** Which side of the road traffic keeps to: +1 right, as `offsetPolyline` counts it. */
const SIDE = BUILD.RIGHT_HAND_TRAFFIC ? 1 : -1;
const isRoadMode = (mode) => mode === 'bus' || mode === 'tram';
const zoomScaleOf = (overlay) => Math.min(2, Math.max(0.6, overlay.map.getZoom() / 14));

/**
 * Lines, with their mode pattern inside and side-by-side offsets where several
 * share the same stretch of road.
 *
 * A bus or tram line is drawn on its own side of the road — the right, for
 * right-hand traffic — so where it runs both ways along a street its two
 * directions sit side by side, two one-way streets as in Cities: Skylines,
 * with chevrons pointing the way each runs. Metro and train are drawn on
 * the track.
 *
 * Segments between the same pair of stops come out of the router as the same
 * node path, so a signature built from the path's endpoints and length is
 * enough to spot sharing without comparing whole polylines.
 */
export function linesPainter(game) {
  return (ctx, overlay) => {
    const { network } = game;
    const zoomScale = zoomScaleOf(overlay);
    const width = RENDER.LINE_WIDTH_PX * zoomScale;
    const step = RENDER.LINE_OFFSET_PX * zoomScale;

    // Group shared segments so each line in a bundle gets its own offset.
    /** @type {Map<string, Array<{line:object, segment:object}>>} */
    const bundles = new Map();
    for (const line of network.lines.values()) {
      for (const segment of line.segments) {
        const key = segmentSignature(segment, isRoadMode(line.mode));
        if (!bundles.has(key)) bundles.set(key, []);
        bundles.get(key).push({ line, segment });
      }
    }

    // A selected line stands out: every other line fades, and the selected
    // one is drawn last, on top, over a dark halo.
    const selected = game.selection && game.selection.segments !== undefined ? game.selection : null;
    const pieces = [];
    for (const bundle of bundles.values()) {
      bundle.forEach(({ line, segment }, index) => {
        const points = segment.points.map(([lon, lat]) => overlay.project(lon, lat));
        if (points.length < 2) return;
        // A road line keeps to its side; track lines straddle the track.
        const offset = isRoadMode(line.mode) ? SIDE * (step / 2 + index * step)
          : (index - (bundle.length - 1) / 2) * step;
        pieces.push({ line, segment, drawn: offsetPolyline(points, offset) });
      });
    }

    const arrows = overlay.map.getZoom() >= RENDER.LINE_ARROW_MIN_ZOOM;
    const drawPiece = ({ line, segment, drawn }) => {
      if (segment.offRoad || segment.onTrack) {
        // Dedicated track: draw it by structure so the tunnels and bridges
        // the terrain forced on the player are visible without a legend.
        drawTrackStructure(ctx, drawn, segment.kinds, line.color, width, line.mode);
      } else {
        strokePath(ctx, drawn, line.color, width);
      }
      drawLinePattern(ctx, drawn, line.mode, line.color, width);
      if (arrows && isRoadMode(line.mode)) drawDirectionArrows(ctx, drawn, width, RENDER.LINE_ARROW_SPACING_PX);
    };

    ctx.save();
    if (selected) ctx.globalAlpha = RENDER.UNSELECTED_LINE_ALPHA;
    for (const piece of pieces) if (piece.line !== selected) drawPiece(piece);
    ctx.restore();
    if (selected) {
      for (const piece of pieces) {
        if (piece.line === selected) strokePath(ctx, piece.drawn, COLORS.selectionHalo, width * 2.4);
      }
      for (const piece of pieces) if (piece.line === selected) drawPiece(piece);
    }

    // The segment currently being dragged, on top of everything, dashed.
    const drag = game.drag;
    if (drag?.preview?.points?.length >= 2) {
      const points = drag.preview.points.map(([lon, lat]) => overlay.project(lon, lat));
      drawDragPreview(ctx, points, drag.line.color, width, Boolean(drag.preview.blocked));
      drawDragLabel(ctx, points.at(-1), drag);
    }
  };
}

/**
 * Where a stop is drawn on screen. A bus or tram stop sits on its own side
 * of the road, on the lines calling there, so two stops facing each other
 * across a street are told apart; a station sits on its track.
 */
function stopPoint(overlay, lon, lat, heading, mode) {
  if (!heading) return overlay.project(lon, lat);
  return sidePoint(overlay, lon, lat, Math.atan2(heading[1], heading[0]),
    Math.max(RENDER.LINE_OFFSET_PX / 2 * zoomScaleOf(overlay), (RENDER.STOP_RADIUS_PX[mode] ?? 4) + 1));
}

/**
 * A point on screen `offsetPx` to the traffic side of `lon, lat`, for
 * something travelling `bearing` (local metres, the maths convention).
 */
function sidePoint(overlay, lon, lat, bearing, offsetPx) {
  const [x, y] = overlay.project(lon, lat);
  const angle = screenAngleOf(overlay, lon, lat, bearing);
  // Right of travel on screen (y down) is (−sin, cos).
  return [x - SIDE * Math.sin(angle) * offsetPx, y + SIDE * Math.cos(angle) * offsetPx];
}

/**
 * Built metro and train track, under the lines that run on it.
 *
 * Every piece of track is drawn bare whether or not a line uses it: a line is
 * drawn on top and covers it, and where no line runs the player still sees
 * what they have paid for and are maintaining.
 */
export function tracksPainter(game) {
  return (ctx, overlay) => {
    const zoomScale = Math.min(2, Math.max(0.6, overlay.map.getZoom() / 14));
    const width = RENDER.BARE_TRACK_PX * zoomScale;
    for (const track of game.network.tracks.values()) {
      // Existing railways are already on the base map; draw one here only to
      // show it selected.
      if (track.osm && game.selection !== track) continue;
      const points = track.points.map(([lon, lat]) => overlay.project(lon, lat));
      if (game.selection === track) {
        strokePath(ctx, points, shade(COLORS.stopStroke, 0.55), width * 5);
      }
      drawBareTrack(ctx, points, track.kinds, track.mode, width);
    }
  };
}

/**
 * A marker at every level crossing. Its own painter, pushed after the lines:
 * drawn with the track, a line running on it covered the markers almost
 * entirely, and the crossings are what a rail line costs the street.
 */
export function levelCrossingsPainter(game) {
  return (ctx, overlay) => {
    const zoomScale = Math.min(2, Math.max(0.6, overlay.map.getZoom() / 14));
    for (const track of game.network.tracks.values()) {
      for (const crossing of track.levelCrossings) {
        const [x, y] = overlay.project(crossing.lonLat[0], crossing.lonLat[1]);
        drawLevelCrossing(ctx, x, y, screenAngle(overlay, crossing), 3.5 * zoomScale);
      }
    }
  };
}

/** A road's direction on screen, from its bearing in local metres. */
function screenAngle(overlay, crossing) {
  return screenAngleOf(overlay, crossing.lonLat[0], crossing.lonLat[1], crossing.roadBearing);
}

/**
 * A heading in local metres (atan2(north, east), the maths convention) as an
 * angle on the canvas. The canvas's y axis points DOWN, so the two disagree
 * for anything not running due east or west — vehicles were drawn mirrored,
 * a bus heading north-east pointing south-east. Stepping a few metres along
 * the heading and projecting both ends is right at any map rotation and
 * pitch, which flipping the sign alone would not be.
 */
export function screenAngleOf(overlay, lon, lat, bearing) {
  const metres = 5 / 111320;
  const dLon = Math.cos(bearing) * metres / Math.cos(lat * Math.PI / 180);
  const dLat = Math.sin(bearing) * metres;
  const [x1, y1] = overlay.project(lon, lat);
  const [x2, y2] = overlay.project(lon + dLon, lat + dLat);
  return Math.atan2(y2 - y1, x2 - x1);
}

/**
 * Track being drawn with the Build track tool: the preview coloured by
 * structure and red where blocked, the waypoints placed so far, and the
 * running cost beside the cursor.
 */
export function trackDraftPainter(game) {
  return (ctx, overlay) => {
    const draft = game.trackDraft;
    if (!draft) return;
    const zoomScale = Math.min(2, Math.max(0.6, overlay.map.getZoom() / 14));
    const width = RENDER.LINE_WIDTH_PX * zoomScale * 0.75;

    const preview = draft.preview;
    if (preview?.points?.length >= 2) {
      const points = preview.points.map(([lon, lat]) => overlay.project(lon, lat));
      drawTrackPreview(ctx, points, preview.kinds, new Set(preview.blockedAt), width);
      // The level crossings it would make, so their cost is not a surprise.
      for (const crossing of preview.levelCrossings || []) {
        const [x, y] = overlay.project(crossing.lonLat[0], crossing.lonLat[1]);
        drawLevelCrossing(ctx, x, y, screenAngle(overlay, crossing), 3.5 * zoomScale);
      }
      if (draft.cursor) {
        drawTag(ctx, overlay.project(draft.cursor[0], draft.cursor[1]),
          trackLabel(preview), preview.blocked);
      }
    }
    draft.control.forEach(([lon, lat], i) => {
      const [x, y] = overlay.project(lon, lat);
      drawWaypoint(ctx, x, y, i === 0 && Boolean(draft.start));
    });
    if (preview?.joins && draft.cursor) {
      const [x, y] = overlay.project(draft.cursor[0], draft.cursor[1]);
      drawWaypoint(ctx, x, y, true);
    }
  };
}

/** What the cursor tag says about a track preview. */
export function trackLabel(preview) {
  if (preview.blocked) {
    const key = preview.reason === 'tooSteep' ? 'trackTooSteep' : preview.reason;
    return STRINGS.errors[key] || STRINGS.errors.blockedByBuilding;
  }
  const parts = [formatMoney(preview.cost)];
  const kinds = new Set(preview.kinds);
  for (const kind of ['tunnel', 'bridge']) if (kinds.has(kind)) parts.push(STRINGS.build[kind]);
  if (preview.levelCrossings?.length) {
    const count = preview.levelCrossings.length;
    parts.push(`${count} ${count === 1 ? STRINGS.build.levelCrossing : STRINGS.build.levelCrossings}`);
  }
  return parts.join(' · ');
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
    const simNow = game.clock.simSeconds;

    for (const stop of game.network.stops.values()) {
      const [x, y] = stopPoint(overlay, stop.lon, stop.lat, stop.heading, stop.mode);
      const radius = RENDER.STOP_RADIUS_PX[stop.mode] ?? 4;

      // The ring tracks the passenger nearest to giving up. Patience differs
      // by line — longer for one that keeps a timetable — so that is the
      // largest share of patience used, not simply the longest wait.
      if (stop.waiting.length > 0) {
        let nearest = 0;
        for (const dot of stop.waiting) {
          nearest = Math.max(nearest, (simNow - dot.waitingSince) / patienceFor(game, dot));
        }
        drawWaitRing(ctx, x, y, radius, nearest);
      }

      if (stop.intercity) drawIntercityMark(ctx, x, y, stop.mode);
      // A stop being dragged: a ghost where it would land, red where it can't.
      if (game.stopDrag?.stop === stop && game.stopDrag.preview) {
        const ghost = game.stopDrag.preview;
        const [gx, gy] = stopPoint(overlay, ghost.lon, ghost.lat, ghost.heading, stop.mode);
        drawStopGhost(ctx, x, y, gx, gy, stop.mode, ghost.valid);
      }
      drawStop(ctx, x, y, stop.mode, game.selection?.id === stop.id);
      drawWaiting(ctx, x, y, stop.waiting.length, radius);
    }
  };
}

/**
 * The Flows layer: an arc between every pair of stops people travel between,
 * as thick as the people a day who want that trip. Dots show who is moving
 * right now; this shows the demand underneath, including routes too quiet to
 * have a dot on them most of the time. Drawn under the lines.
 */
export function flowsPainter(game) {
  return (ctx, overlay) => {
    if (!game.showFlows) return;
    // With a stop selected, only that stop's flows: where its people go and
    // where its visitors come from, scaled to its own busiest.
    const stop = isStop(game.selection) ? game.selection : null;
    const flows = stop
      ? game.demand.flowsAt(stop.id, RENDER.FLOW_MAX_ARCS)
      : game.demand.flows(RENDER.FLOW_MAX_ARCS);
    if (flows.length === 0) return;
    const busiest = flows[0].perDay;

    ctx.save();
    ctx.strokeStyle = COLORS.flow;
    ctx.lineCap = 'round';
    for (const flow of flows) {
      const a = game.network.stops.get(flow.a);
      const b = game.network.stops.get(flow.b);
      if (!a || !b) continue;
      const [x1, y1] = overlay.project(a.lon, a.lat);
      const [x2, y2] = overlay.project(b.lon, b.lat);
      // Bow every arc to the same side of its chord, so flows that share a
      // corridor fan apart instead of drawing over one another.
      const mx = (x1 + x2) / 2 - (y2 - y1) * RENDER.FLOW_BOW;
      const my = (y1 + y2) / 2 + (x2 - x1) * RENDER.FLOW_BOW;
      // Area-true: width by the square root, so a flow ten times busier is
      // about three times as wide, not ten.
      ctx.lineWidth = Math.max(RENDER.FLOW_MIN_PX,
        RENDER.FLOW_MAX_PX * Math.sqrt(flow.perDay / busiest));
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.quadraticCurveTo(mx, my, x2, y2);
      ctx.stroke();
    }
    ctx.restore();
  };
}

/** A stop, as opposed to a line or a piece of track. */
const isStop = (object) => Boolean(object && object.waiting !== undefined && object.mode);

/** Vehicles, on top of everything. */
export function vehiclesPainter(game) {
  return (ctx, overlay) => {
    const zoomScale = Math.min(1.8, Math.max(0.7, overlay.map.getZoom() / 14));
    for (const line of game.network.lines.values()) {
      for (const vehicle of line.vehicles) {
        if (!vehicle.lon && !vehicle.lat) continue;
        // A bus or tram drives on its line, on its side of the road.
        const [x, y] = isRoadMode(line.mode)
          ? sidePoint(overlay, vehicle.lon, vehicle.lat, vehicle.bearing,
            RENDER.LINE_OFFSET_PX / 2 * zoomScaleOf(overlay))
          : overlay.project(vehicle.lon, vehicle.lat);
        if (x < -40 || y < -40 || x > overlay.width + 40 || y > overlay.height + 40) continue;
        drawVehicle(ctx, x, y, screenAngleOf(overlay, vehicle.lon, vehicle.lat, vehicle.bearing),
          line.mode, line.color,
          vehicle.load, zoomScale);
      }
    }
  };
}

/**
 * What a click would add: while a line is drawn, a dashed rubber band from
 * its last stop to a ghost of the next stop, on the side of the road it
 * would stand; with a line selected, a ghost where a click beside it would
 * insert a stop.
 */
export function draftPainter(game) {
  return (ctx, overlay) => {
    const zoomScale = zoomScaleOf(overlay);
    const hover = game.insertHover;
    if (hover && !game.draft) {
      const at = stopPoint(overlay, hover.lon, hover.lat, hover.heading, hover.line.mode);
      drawGhostStop(ctx, at, hover.line.mode, hover.line.color);
      drawTag(ctx, at, STRINGS.build.insertStop, false);
    }

    const draft = game.draft;
    if (!draft?.line || !draft.cursor) return;
    const spot = draft.spot;
    const to = spot ? stopPoint(overlay, spot.lon, spot.lat, spot.heading, draft.line.mode)
      : overlay.project(draft.cursor[0], draft.cursor[1]);
    const lastStop = game.network.stops.get(draft.line.stops.at(-1));
    if (lastStop) {
      const from = stopPoint(overlay, lastStop.lon, lastStop.lat, lastStop.heading, lastStop.mode);
      ctx.save();
      ctx.setLineDash([6, 5]);
      ctx.strokeStyle = spot ? shade(draft.line.color, 0.25) : COLORS.blocked;
      ctx.lineWidth = RENDER.LINE_WIDTH_PX * zoomScale * 0.8;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(from[0], from[1]);
      ctx.lineTo(to[0], to[1]);
      ctx.stroke();
      ctx.restore();
    }
    if (spot) drawGhostStop(ctx, to, draft.line.mode, draft.line.color);
  };
}

/** A stop that a click would place: hollow, ringed in the line's colour. */
function drawGhostStop(ctx, [x, y], mode, color) {
  ctx.save();
  ctx.globalAlpha = 0.85;
  drawStop(ctx, x, y, mode, false);
  ctx.beginPath();
  ctx.arc(x, y, (RENDER.STOP_RADIUS_PX[mode] ?? 4) + 2.5, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = color;
  ctx.stroke();
  ctx.restore();
}

/**
 * Cheap identity for a routed segment, used to spot shared road stretches:
 * one way only for a road line, which runs on its side of the road.
 */
function segmentSignature(segment, directed) {
  const points = segment.points;
  if (points.length === 0) return 'empty';
  const [aLon, aLat] = points[0];
  const [bLon, bLat] = points[points.length - 1];
  // Order-independent, so A→B and B→A bundle together.
  const forward = `${aLon.toFixed(6)},${aLat.toFixed(6)}|${bLon.toFixed(6)},${bLat.toFixed(6)}`;
  const backward = `${bLon.toFixed(6)},${bLat.toFixed(6)}|${aLon.toFixed(6)},${aLat.toFixed(6)}`;
  const ends = directed || forward < backward ? forward : backward;
  return `${ends}@${Math.round(segment.lengthM)}`;
}

/**
 * The cost (and structure) of the segment being dragged, beside the cursor.
 *
 * The spec asks for a cost preview that follows the cursor while building.
 * A drag is the one gesture that can spend money without placing a stop, so
 * it is the one that most needs saying out loud before the mouse is released.
 */
function drawDragLabel(ctx, at, drag) {
  if (!at) return;
  const preview = drag.preview;
  let text;
  if (preview.blocked) {
    text = preview.tooSteep ? STRINGS.errors.tooSteep : STRINGS.errors.blockedByBuilding;
  } else {
    const delta = drag.costDelta || 0;
    const money = `${delta >= 0 ? '+' : '−'}${formatMoney(Math.abs(delta))}`;
    const parts = [money];
    if (preview.offRoad && preview.kinds?.length) {
      const kinds = new Set(preview.kinds);
      for (const kind of ['tunnel', 'bridge']) {
        if (kinds.has(kind)) parts.push(STRINGS.build[kind]);
      }
    }
    text = parts.join(' · ');
  }
  drawTag(ctx, at, text, preview.blocked);
}

/** A small dark tag beside the cursor, red when what it describes is refused. */
function drawTag(ctx, at, text, blocked) {
  ctx.save();
  ctx.font = "700 12px 'Sansation', system-ui, sans-serif";
  ctx.textBaseline = 'middle';
  const padding = 6;
  const metrics = ctx.measureText(text);
  const x = at[0] + 12;
  const y = at[1] - 14;
  ctx.fillStyle = blocked ? COLORS.blocked : 'rgba(31,31,31,0.88)';
  ctx.beginPath();
  ctx.roundRect(x, y - 10, metrics.width + padding * 2, 20, 4);
  ctx.fill();
  ctx.fillStyle = '#FFFFFF';
  ctx.fillText(text, x + padding, y);
  ctx.restore();
}
