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
  drawTrackPreview, drawWaypoint, drawIntercityMark, drawStopGhost, drawStopPair, drawDoubleStop,
  drawOnewayArrow,
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
      // A way back that one-way streets send down another street is drawn
      // too, or the bus would be seen on a street its line does not show.
      for (const segment of [...line.segments, ...(line.backSegments || []).filter(Boolean)]) {
        const key = segmentSignature(segment);
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
        // Centre the bundle on the road: one line sits on it, two straddle it.
        const spread = (index - (bundle.length - 1) / 2) * RENDER.LINE_OFFSET_PX * zoomScale;
        pieces.push({ line, segment, drawn: offsetPolyline(points, spread) });
      });
    }

    const drawPiece = ({ line, segment, drawn }) => {
      // One direction only: a little thinner than a street served both ways.
      const own = segment.back ? width * 0.7 : width;
      if (segment.offRoad || segment.onTrack) {
        // Dedicated track: draw it by structure so the tunnels and bridges
        // the terrain forced on the player are visible without a legend.
        drawTrackStructure(ctx, drawn, segment.kinds, line.color, width, line.mode);
      } else {
        strokePath(ctx, drawn, line.color, own);
      }
      drawLinePattern(ctx, drawn, line.mode, line.color, own);
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

    // One-way arrows on top of the lines that run along one-way streets: the
    // map's own arrows are hidden underneath them.
    if (overlay.map.getZoom() >= RENDER.ONEWAY_ARROW_MIN_ZOOM) {
      for (const line of network.lines.values()) {
        if (line.mode !== 'bus' && line.mode !== 'tram') continue;
        for (const segment of [...line.segments, ...(line.backSegments || []).filter(Boolean)]) {
          drawOnewayOnSegment(ctx, overlay, game.roadIndex, segment, zoomScale);
        }
      }
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
      const [x, y] = overlay.project(stop.lon, stop.lat);
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
        const [gx, gy] = overlay.project(ghost.lon, ghost.lat);
        drawStopGhost(ctx, x, y, gx, gy, stop.mode, ghost.valid);
      }
      const selected = game.selection?.id === stop.id;
      const kerbs = stopKerbs(game, overlay, stop, x, y);
      if (!kerbs) {
        drawStop(ctx, x, y, stop.mode, selected);
      } else {
        // A double stop on a two-way road: two stops facing each other.
        if (kerbs.across) drawDoubleStop(ctx, x, y, kerbs.across, stop.mode, selected);
        // On a divided road: this side, linked to its twin across the divider.
        for (const [tx, ty] of kerbs.twins) drawStopPair(ctx, x, y, tx, ty, stop.mode);
        if (kerbs.twins.length && !kerbs.across) drawStop(ctx, x, y, stop.mode, selected);
        // Single stops: on the kerb of the side each serves.
        for (const [sx, sy] of kerbs.sides) drawStop(ctx, sx, sy, stop.mode, selected);
      }
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

/**
 * How a bus or tram stop is drawn, from the lines calling at it: `across` is
 * the unit normal to the road for a double stop (two stops facing each other
 * at the same point), `twins` the screen points of linked stops across a
 * divider, `sides` the single stops' kerbside points. Null for a stop no
 * road line calls at, and for stations.
 */
function stopKerbs(game, overlay, stop, x, y) {
  if (stop.mode === 'metro' || stop.mode === 'train') return null;
  const result = { across: null, twins: [], sides: [] };
  const offset = (RENDER.STOP_RADIUS_PX[stop.mode] ?? 4) + 3;
  let any = false;
  for (const lineId of stop.lines) {
    const line = game.network.lines.get(lineId);
    if (!line || line.segments.length === 0) continue;
    const index = line.stops.indexOf(stop.id);
    const tangent = travelAt(line, index, overlay);
    if (!tangent) continue;
    any = true;
    const [tx, ty] = tangent;
    // Right of travel on screen (y down): (−ty, tx).
    const right = BUILD.RIGHT_HAND_TRAFFIC ? [-ty, tx] : [ty, -tx];
    if (line.singleSided) {
      result.sides.push([x + right[0] * offset, y + right[1] * offset]);
      continue;
    }
    const back = game.network.stopNodeFor(line, index, 1);
    if (back !== stop.node) {
      const [lon, lat] = game.roadIndex.nodeLonLat(back);
      result.twins.push(overlay.project(lon, lat));
    } else {
      result.across = right;
    }
  }
  return any ? result : null;
}

/** Which way a line travels at its stop `index`, as a unit vector on screen. */
function travelAt(line, index, overlay) {
  const count = line.stops.length;
  const into = index > 0 ? line.segments[index - 1] : line.loop ? line.segments.at(-1) : null;
  const out = line.segments[index] ?? null;
  const pick = into?.points?.length >= 2 ? into.points.slice(-2)
    : out?.points?.length >= 2 ? out.points.slice(0, 2) : null;
  if (!pick || count < 2) return null;
  const [a, b] = pick.map(([lon, lat]) => overlay.project(lon, lat));
  const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
  return length > 0 ? [(b[0] - a[0]) / length, (b[1] - a[1]) / length] : null;
}

/**
 * Arrows on a line's one-way stretches, pointing the way traffic flows. A
 * segment's `nodes` run in travel order (a way back's too), so each arrow
 * points from one node to the next.
 */
function drawOnewayOnSegment(ctx, overlay, roadIndex, segment, zoomScale) {
  const nodes = segment.nodes;
  if (!nodes || nodes.length < 2) return;
  if (!segment.onewayAt) {
    segment.onewayAt = [];
    for (let i = 0; i + 1 < nodes.length; i++) {
      if (roadIndex.edgeBetween(nodes[i], nodes[i + 1])?.oneway) segment.onewayAt.push(i);
    }
  }
  for (const i of segment.onewayAt) {
    const [x1, y1] = overlay.project(...roadIndex.nodeLonLat(nodes[i]));
    const [x2, y2] = overlay.project(...roadIndex.nodeLonLat(nodes[i + 1]));
    if (Math.hypot(x2 - x1, y2 - y1) < RENDER.ONEWAY_ARROW_MIN_PX) continue;
    drawOnewayArrow(ctx, (x1 + x2) / 2, (y1 + y2) / 2, Math.atan2(y2 - y1, x2 - x1), 4 * zoomScale);
  }
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
        const [x, y] = overlay.project(vehicle.lon, vehicle.lat);
        if (x < -40 || y < -40 || x > overlay.width + 40 || y > overlay.height + 40) continue;
        drawVehicle(ctx, x, y, screenAngleOf(overlay, vehicle.lon, vehicle.lat, vehicle.bearing),
          line.mode, line.color,
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
