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
export function drawStop(ctx, x, y, mode, selected = false) {
  const radius = RENDER.STOP_RADIUS_PX[mode] ?? 4;
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
    ctx.font = '600 9px system-ui, sans-serif';
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
