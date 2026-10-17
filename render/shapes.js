/**
 * Mini Metro's vocabulary, in Canvas 2D: thick flat lines with a faint pattern
 * inside, double-ended vehicles, white stops, dark passenger dots.
 *
 * Each mode is told apart twice over — once by the pattern running inside its
 * line, once by the silhouette of its vehicles — so the map reads at a glance
 * without a legend and without text.
 */

import { RENDER, COLORS } from '../config.js';

/** Mix a hex colour toward black (negative) or white (positive). */
export function shade(hex, amount) {
  const value = parseInt(hex.slice(1), 16);
  let r = (value >> 16) & 255;
  let g = (value >> 8) & 255;
  let b = value & 255;
  if (amount >= 0) {
    r += (255 - r) * amount; g += (255 - g) * amount; b += (255 - b) * amount;
  } else {
    const k = 1 + amount;
    r *= k; g *= k; b *= k;
  }
  return `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
}

/**
 * Stroke a polyline of screen points with the line's colour and width.
 * Round joins and caps are what stop a bus route's corners looking chipped.
 */
export function strokePath(ctx, points, color, width) {
  if (points.length < 2) return;
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = width;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(points[0][0], points[0][1]);
  for (let i = 1; i < points.length; i++) ctx.lineTo(points[i][0], points[i][1]);
  ctx.stroke();
  ctx.restore();
}

/**
 * The faint pattern that runs inside a line and names its mode: dotted circles
 * for tram, triangles for metro, squares for train. Bus has none.
 *
 * Marks are placed at a fixed screen spacing along the path and rotated to
 * follow it, so they stay legible at every zoom.
 */
export function drawLinePattern(ctx, points, mode, color, width) {
  if (mode === 'bus' || points.length < 2) return;

  const spacing = Math.max(10, width * 2.2);
  const size = width * 0.26;
  ctx.save();
  ctx.fillStyle = shade(color, 0.55); // Faint: it must not fight the colour.

  let carry = spacing / 2;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const angle = Math.atan2(dy, dx);

    for (let d = carry; d < length; d += spacing) {
      const t = d / length;
      drawMark(ctx, mode, x1 + dx * t, y1 + dy * t, size, angle);
    }
    carry = (carry - length) % spacing;
    if (carry < 0) carry += spacing;
  }
  ctx.restore();
}

function drawMark(ctx, mode, x, y, size, angle) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.beginPath();
  if (mode === 'tram') {
    ctx.arc(0, 0, size, 0, Math.PI * 2);
  } else if (mode === 'metro') {
    ctx.moveTo(size, 0);
    ctx.lineTo(-size * 0.8, size * 0.9);
    ctx.lineTo(-size * 0.8, -size * 0.9);
    ctx.closePath();
  } else {
    ctx.rect(-size, -size, size * 2, size * 2);
  }
  ctx.fill();
  ctx.restore();
}

/**
 * A vehicle: a rectangle whose ends are shaped by mode, because vehicles run
 * both ways and so both ends must look alike.
 *
 *   bus    plain rectangle
 *   tram   both ends rounded
 *   metro  both ends pointed, like a pencil
 *   train  a smaller square attached at both ends
 *
 * A small light chevron shows which way it is actually going, and an inner
 * fill that grows with the load shows how full it is.
 *
 * @param {number} load 0..1
 */
export function drawVehicle(ctx, x, y, angle, mode, color, load, scale = 1) {
  const length = Math.max(RENDER.VEHICLE_MIN_PX, 13 * scale);
  const width = Math.max(RENDER.VEHICLE_MIN_PX * 0.55, 7 * scale);
  const half = length / 2;
  const halfWidth = width / 2;

  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);

  ctx.beginPath();
  if (mode === 'tram') {
    roundedRect(ctx, -half, -halfWidth, length, width, halfWidth);
  } else if (mode === 'metro') {
    const nose = halfWidth * 0.9;
    ctx.moveTo(half, 0);
    ctx.lineTo(half - nose, -halfWidth);
    ctx.lineTo(-half + nose, -halfWidth);
    ctx.lineTo(-half, 0);
    ctx.lineTo(-half + nose, halfWidth);
    ctx.lineTo(half - nose, halfWidth);
    ctx.closePath();
  } else {
    ctx.rect(-half, -halfWidth, length, width);
  }
  ctx.fillStyle = color;
  ctx.fill();
  ctx.lineWidth = 1;
  ctx.strokeStyle = shade(color, -0.45);
  ctx.stroke();

  // Train's cab boxes at both ends.
  if (mode === 'train') {
    const box = halfWidth * 0.8;
    ctx.fillStyle = shade(color, -0.25);
    ctx.fillRect(half, -box / 2, box, box);
    ctx.fillRect(-half - box, -box / 2, box, box);
  }

  // Load: a dark inner bar growing from the back.
  if (load > 0) {
    ctx.fillStyle = shade(color, -0.4);
    const inner = (length - 4) * Math.min(1, load);
    ctx.fillRect(-half + 2, -halfWidth + 2, inner, width - 4);
  }

  // Direction chevron, light so it reads against the line colour.
  ctx.strokeStyle = 'rgba(255,255,255,0.85)';
  ctx.lineWidth = 1.4;
  ctx.lineCap = 'round';
  ctx.beginPath();
  const tip = half - 2.5;
  ctx.moveTo(tip - 3, -halfWidth * 0.55);
  ctx.lineTo(tip, 0);
  ctx.lineTo(tip - 3, halfWidth * 0.55);
  ctx.stroke();

  ctx.restore();
}

function roundedRect(ctx, x, y, width, height, radius) {
  const r = Math.min(radius, height / 2, width / 2);
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + width - r, y);
  ctx.arcTo(x + width, y, x + width, y + r, r);
  ctx.lineTo(x + width, y + height - r);
  ctx.arcTo(x + width, y + height, x + width - r, y + height, r);
  ctx.lineTo(x + r, y + height);
  ctx.arcTo(x, y + height, x, y + height - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
}

/** A stop: white circle, dark outline. Rail stations are larger. */
export function drawStop(ctx, x, y, mode, selected = false, radius = RENDER.STOP_RADIUS_PX[mode] ?? 4) {
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.fillStyle = COLORS.stopFill;
  ctx.fill();
  ctx.lineWidth = selected ? 2.5 : 1.6;
  ctx.strokeStyle = selected ? COLORS.passenger : COLORS.stopStroke;
  ctx.stroke();
  ctx.restore();
}

/**
 * A station intercity trains call at: a second, dashed ring outside it, in the
 * stop's own ink — the main-line station on a Mini Metro map.
 */
export function drawIntercityMark(ctx, x, y, mode) {
  const radius = (RENDER.STOP_RADIUS_PX[mode] ?? 4) + 3.5;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.setLineDash([3, 2]);
  ctx.lineWidth = 1.6;
  ctx.strokeStyle = COLORS.stopStroke;
  ctx.stroke();
  ctx.restore();
}

/**
 * Small white chevrons along a bus or tram line, pointing the way it runs,
 * as Cities: Skylines draws its lines: the two directions of a line along
 * one street then read apart at a glance, and on a one-way street they
 * point the way it flows.
 */
export function drawDirectionArrows(ctx, points, width, spacing) {
  const size = width * 0.32;
  ctx.save();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)';
  ctx.lineWidth = Math.max(1.2, width * 0.22);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  let carry = spacing / 2;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const dx = points[i][0] - x1;
    const dy = points[i][1] - y1;
    const length = Math.hypot(dx, dy);
    if (length === 0) continue;
    const ux = dx / length;
    const uy = dy / length;
    for (let d = carry; d < length; d += spacing) {
      const x = x1 + ux * d;
      const y = y1 + uy * d;
      ctx.beginPath();
      ctx.moveTo(x - ux * size - uy * size, y - uy * size + ux * size);
      ctx.lineTo(x, y);
      ctx.lineTo(x - ux * size + uy * size, y - uy * size - ux * size);
      ctx.stroke();
    }
    carry = (carry - length) % spacing;
    if (carry < 0) carry += spacing;
  }
  ctx.restore();
}

/**
 * Where a dragged stop would land: a dashed tether from where it stands and
 * a hollow ring at the target, red where it cannot go.
 */
export function drawStopGhost(ctx, x, y, gx, gy, mode, valid) {
  const radius = RENDER.STOP_RADIUS_PX[mode] ?? 4;
  const color = valid ? COLORS.stopStroke : COLORS.blocked;
  ctx.save();
  ctx.setLineDash([4, 3]);
  ctx.lineWidth = 1.4;
  ctx.strokeStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(gx, gy);
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(gx, gy, radius + 1, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

/** One outlined ring around the stops an interchange joins. */
export function drawInterchange(ctx, points) {
  if (points.length < 2) return;
  let cx = 0;
  let cy = 0;
  for (const [x, y] of points) { cx += x; cy += y; }
  cx /= points.length;
  cy /= points.length;

  let radius = 0;
  for (const [x, y] of points) radius = Math.max(radius, Math.hypot(x - cx, y - cy));

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius + 7, 0, Math.PI * 2);
  ctx.strokeStyle = COLORS.stopStroke;
  ctx.lineWidth = 1.4;
  ctx.stroke();
  ctx.restore();
}

/**
 * Passengers waiting beside a stop: small dark dots in a tidy cluster. Past
 * MAX_PASSENGER_DOTS the cluster stops growing and a "+N" takes over, so a
 * busy stop stays readable instead of turning into a blob.
 */
export function drawWaiting(ctx, x, y, count, radius) {
  if (count <= 0) return;
  const shown = Math.min(count, RENDER.MAX_PASSENGER_DOTS);
  const dotRadius = 1.8;
  const gap = 5;
  const perRow = 4;

  ctx.save();
  ctx.fillStyle = COLORS.passenger;
  for (let i = 0; i < shown; i++) {
    const col = i % perRow;
    const row = Math.floor(i / perRow);
    ctx.beginPath();
    ctx.arc(x + radius + 5 + col * gap, y - radius - 2 + row * gap, dotRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  if (count > shown) {
    ctx.font = "700 9px 'Sansation', system-ui, sans-serif";
    ctx.textBaseline = 'middle';
    ctx.fillText(`+${count - shown}`,
      x + radius + 5 + perRow * gap, y - radius - 2 + gap);
  }
  ctx.restore();
}

/**
 * The waiting timer: a thin arc around a stop that fills as its oldest
 * passenger runs out of patience. It only appears past the halfway mark, so a
 * healthy stop stays quiet and a struggling one draws the eye.
 *
 * @param {number} fraction 0..1 of patience used by the oldest passenger
 */
export function drawWaitRing(ctx, x, y, radius, fraction) {
  if (fraction < RENDER.WAIT_RING_AT) return;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, radius + 3.5, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * Math.min(1, fraction));
  ctx.strokeStyle = fraction > 0.85 ? '#E4463C' : COLORS.stopStroke;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

/**
 * Offset a polyline sideways by `offset` screen pixels, so lines sharing a
 * road sit beside each other rather than on top, as in Mini Metro.
 *
 * This offsets each vertex along the average of its two adjacent edge normals.
 * It is not a true mitred offset and will pinch on very sharp corners, which
 * at these widths is invisible — and far less code than doing it properly.
 */
export function offsetPolyline(points, offset) {
  if (offset === 0 || points.length < 2) return points;
  const out = [];

  for (let i = 0; i < points.length; i++) {
    const previous = points[i - 1];
    const next = points[i + 1];
    const [x, y] = points[i];

    let nx = 0;
    let ny = 0;
    if (previous) {
      const dx = x - previous[0];
      const dy = y - previous[1];
      const length = Math.hypot(dx, dy) || 1;
      nx += -dy / length; ny += dx / length;
    }
    if (next) {
      const dx = next[0] - x;
      const dy = next[1] - y;
      const length = Math.hypot(dx, dy) || 1;
      nx += -dy / length; ny += dx / length;
    }
    const length = Math.hypot(nx, ny) || 1;
    out.push([x + (nx / length) * offset, y + (ny / length) * offset]);
  }
  return out;
}

/**
 * Draw an off-road track segment coloured by structure.
 *
 * The spec's rule is that the player never chooses where a tunnel or a bridge
 * goes — the terrain decides — so the drawing has to make that decision
 * legible without a legend:
 *
 *   - **tunnel** — the line darkens toward black (`RENDER.TUNNEL_DARKEN`) and
 *     thins, because it is under the ground the player is looking at.
 *   - **bridge** — a pale casing is laid under the line, so it reads as a deck
 *     carrying the track over whatever is below.
 *   - **at grade** — the plain line.
 *
 * **Metro is the inverse**, as the spec asks: underground is a metro's normal
 * state, so its tunnels are drawn in the plain colour and anything overground
 * — at grade or on a bridge — is brightened toward white
 * (`RENDER.METRO_SURFACE_LIGHTEN`). A metro line surfacing across a valley
 * therefore lights up exactly where it leaves the ground.
 *
 * `points` and `kinds` are parallel: the grade rule samples every
 * `BUILD.SAMPLE_M`, and each sample carries its own classification.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<[number,number]>} points screen coordinates
 * @param {string[]} kinds one of 'atGrade' | 'tunnel' | 'bridge' per point
 * @param {string} color the line colour
 * @param {number} width
 * @param {string} [mode] the line's mode; 'metro' inverts the colouring
 */
export function drawTrackStructure(ctx, points, kinds, color, width, mode = null) {
  if (points.length < 2) return;
  if (!kinds || kinds.length !== points.length) {
    strokePath(ctx, points, color, width);
    return;
  }

  // Bridge casings go down first, as one pass under everything, so a deck
  // never paints over the track of the run next to it.
  ctx.save();
  for (const run of contiguousRuns(kinds)) {
    if (run.kind !== 'bridge') continue;
    const slice = points.slice(run.start, run.end + 2);
    strokePath(ctx, slice, shade(color, 0.72), width * 2.1);
    strokePath(ctx, slice, '#FFFFFF', width * 1.5);
  }

  for (const run of contiguousRuns(kinds)) {
    // Overlap by one point so consecutive runs join without a seam.
    const slice = points.slice(run.start, run.end + 2);
    if (mode === 'metro') {
      strokePath(ctx, slice, run.kind === 'tunnel'
        ? color : shade(color, RENDER.METRO_SURFACE_LIGHTEN), width);
    } else if (run.kind === 'tunnel') {
      ctx.globalAlpha = 0.55;
      strokePath(ctx, slice, shade(color, -RENDER.TUNNEL_DARKEN), width * 0.8);
      ctx.globalAlpha = 1;
    } else {
      strokePath(ctx, slice, color, width);
    }
  }
  ctx.restore();
}

/** Contiguous runs of equal values, as {kind, start, end} inclusive. */
function contiguousRuns(kinds) {
  const runs = [];
  for (let i = 0; i < kinds.length; i++) {
    if (i === 0 || kinds[i] !== kinds[i - 1]) runs.push({ kind: kinds[i], start: i, end: i });
    else runs.at(-1).end = i;
  }
  return runs;
}

/**
 * Bare track: built, whether or not a line runs on it. Thin grey, as the spec
 * asks; train track carries sleeper ticks and metro track is plain, so the
 * two kinds read apart before any line is drawn on them.
 *
 * Tunnels are drawn dashed and faint — the track is there, but under the
 * ground — and bridges get a thin casing so a viaduct reads as one.
 *
 * @param {Array<[number,number]>} points screen coordinates
 * @param {string[]} kinds per-point structure
 * @param {'metro'|'train'} mode
 * @param {number} width
 */
export function drawBareTrack(ctx, points, kinds, mode, width) {
  if (points.length < 2) return;
  ctx.save();
  for (const run of contiguousRuns(kinds)) {
    const slice = points.slice(run.start, run.end + 2);
    if (run.kind === 'tunnel') {
      ctx.setLineDash([width * 2.5, width * 2]);
      ctx.globalAlpha = 0.6;
      strokePath(ctx, slice, COLORS.bareTrack, width);
      ctx.setLineDash([]);
      ctx.globalAlpha = 1;
      continue;
    }
    if (run.kind === 'bridge') strokePath(ctx, slice, COLORS.sleeper, width * 2.6);
    if (run.kind === 'bridge') strokePath(ctx, slice, '#FFFFFF', width * 1.6);
    strokePath(ctx, slice, COLORS.bareTrack, width);
    if (mode === 'train') drawSleepers(ctx, slice, width * 2.2);
  }
  ctx.restore();
}

/** Short ticks across a polyline at a fixed screen spacing. */
function drawSleepers(ctx, points, length) {
  ctx.save();
  ctx.strokeStyle = COLORS.sleeper;
  ctx.lineWidth = 1;
  ctx.beginPath();
  let carry = RENDER.SLEEPER_SPACING_PX / 2;
  for (let i = 1; i < points.length; i++) {
    const [x1, y1] = points[i - 1];
    const [x2, y2] = points[i];
    const dx = x2 - x1;
    const dy = y2 - y1;
    const span = Math.hypot(dx, dy);
    if (span === 0) continue;
    const nx = (-dy / span) * length / 2;
    const ny = (dx / span) * length / 2;
    for (let d = carry; d < span; d += RENDER.SLEEPER_SPACING_PX) {
      const x = x1 + dx * (d / span);
      const y = y1 + dy * (d / span);
      ctx.moveTo(x - nx, y - ny);
      ctx.lineTo(x + nx, y + ny);
    }
    carry = (carry - span) % RENDER.SLEEPER_SPACING_PX;
    if (carry < 0) carry += RENDER.SLEEPER_SPACING_PX;
  }
  ctx.stroke();
  ctx.restore();
}

/**
 * A level crossing: a small striped bar laid across the road, like the
 * barrier it stands for. Drawn along the road, so it sits across the track.
 *
 * @param {number} angle the road's direction on screen, radians
 */
export function drawLevelCrossing(ctx, x, y, angle, size) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  const length = size * 2.4;
  const height = size * 0.9;
  ctx.fillStyle = '#FFFFFF';
  ctx.fillRect(-length / 2, -height / 2, length, height);
  ctx.fillStyle = COLORS.blocked;
  const stripes = 4;
  for (let i = 0; i < stripes; i += 2) {
    ctx.fillRect(-length / 2 + (length / stripes) * i, -height / 2, length / stripes, height);
  }
  ctx.strokeStyle = COLORS.stopStroke;
  ctx.lineWidth = 0.8;
  ctx.strokeRect(-length / 2, -height / 2, length, height);
  ctx.restore();
}

/**
 * Track being drawn with the Build track tool, coloured by structure — at
 * grade, tunnel, bridge — with anything blocked in red, as the spec asks.
 * Nothing about it is built yet, so it is dashed like every other preview.
 *
 * @param {Array<[number,number]>} points screen coordinates
 * @param {string[]} kinds per-point structure, may be empty when refused outright
 * @param {Set<number>} blocked indices of blocked samples
 * @param {number} width
 */
export function drawTrackPreview(ctx, points, kinds, blocked, width) {
  if (points.length < 2) return;
  ctx.save();
  ctx.setLineDash([width * 1.6, width * 1.0]);
  if (!kinds || kinds.length !== points.length) {
    strokePath(ctx, points, COLORS.blocked, width);
    ctx.restore();
    return;
  }
  // Paint by run of (structure, blocked), so a blocked stretch inside a bridge
  // still shows red.
  const keys = kinds.map((kind, i) => (blocked.has(i) ? 'blocked' : kind));
  for (const run of contiguousRuns(keys)) {
    const slice = points.slice(run.start, run.end + 2);
    const color = run.kind === 'blocked' ? COLORS.blocked : COLORS.structure[run.kind];
    if (run.kind === 'bridge') {
      ctx.setLineDash([]);
      strokePath(ctx, slice, '#FFFFFF', width * 1.9);
      ctx.setLineDash([width * 1.6, width * 1.0]);
    }
    strokePath(ctx, slice, color, run.kind === 'tunnel' ? width * 0.8 : width);
  }
  ctx.restore();
}

/** A waypoint of track being drawn: a small hollow square, not a stop. */
export function drawWaypoint(ctx, x, y, joined = false) {
  ctx.save();
  ctx.fillStyle = joined ? COLORS.stopStroke : '#FFFFFF';
  ctx.strokeStyle = COLORS.stopStroke;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.rect(x - 3.5, y - 3.5, 7, 7);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

/**
 * The live preview of a segment being dragged, before it is paid for.
 *
 * Drawn dashed so it reads as provisional, and red wherever it is blocked —
 * which is the spec's requirement that a blocked stretch shows red and cannot
 * be confirmed until the player reroutes it.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {Array<[number,number]>} points screen coordinates
 * @param {string} color
 * @param {number} width
 * @param {boolean} blocked
 */
export function drawDragPreview(ctx, points, color, width, blocked) {
  if (points.length < 2) return;
  ctx.save();
  ctx.setLineDash([width * 1.6, width * 1.2]);
  strokePath(ctx, points, blocked ? '#D14A3F' : color, width);
  ctx.restore();
}
