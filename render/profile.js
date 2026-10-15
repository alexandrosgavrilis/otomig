/**
 * The height-profile strip: a side view of the track being drawn.
 *
 * The spec's rule is that the terrain, not the player, decides where tunnels
 * and bridges go — and that the only way to avoid one is to draw a better
 * path. That only works if the player can see *why* the track went under a
 * hill. The map shows where; this strip shows the ground and the track in
 * section, coloured by structure, with the running cost underneath, so a
 * cheaper alignment is something they can hunt for rather than guess at.
 *
 * It shows the draft while track is being drawn, and the selected track
 * otherwise. Plain Canvas 2D, redrawn only when what it shows has changed.
 */

import { COLORS, RENDER } from '../config.js';
import { STRINGS } from '../ui/strings.js';
import { formatMoney } from '../sim/economy.js';

/**
 * @param {HTMLElement} root
 * @param {import('../sim/game.js').Game} game
 */
export function mountProfile(root, game) {
  root.className = 'profile';
  root.hidden = true;
  root.innerHTML = `
    <canvas width="${RENDER.PROFILE_WIDTH_PX}" height="${RENDER.PROFILE_HEIGHT_PX}"></canvas>
    <div class="profile-meta"></div>
  `;
  const canvas = root.querySelector('canvas');
  const meta = root.querySelector('.profile-meta');
  const ctx = canvas.getContext('2d');

  const dpr = window.devicePixelRatio || 1;
  canvas.style.width = `${RENDER.PROFILE_WIDTH_PX}px`;
  canvas.style.height = `${RENDER.PROFILE_HEIGHT_PX}px`;
  canvas.width = Math.round(RENDER.PROFILE_WIDTH_PX * dpr);
  canvas.height = Math.round(RENDER.PROFILE_HEIGHT_PX * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

  let shown = null;

  /** Call every frame; it does nothing unless the subject changed. */
  function update() {
    const subject = subjectOf(game);
    if (subject === shown) return;
    shown = subject;
    if (!subject) { root.hidden = true; return; }
    root.hidden = false;
    drawProfile(ctx, subject, RENDER.PROFILE_WIDTH_PX, RENDER.PROFILE_HEIGHT_PX);
    meta.textContent = describe(subject);
    meta.classList.toggle('refused', Boolean(subject.blocked));
  }

  return { update, root };
}

/** The draft's preview while drawing, else the selected track, else nothing. */
function subjectOf(game) {
  const preview = game.trackDraft?.preview;
  if (preview?.samples?.length >= 2) return preview;
  const selected = game.selection;
  if (selected?.control && selected.points?.length >= 2) return selected;
  return null;
}

/**
 * Draw ground and track in section.
 *
 * @param {CanvasRenderingContext2D} ctx
 * @param {{height:number[], terrain:number[], kinds:string[], overWater?:boolean[],
 *          blockedAt?:number[], lengthM:number}} track
 */
export function drawProfile(ctx, track, width, height) {
  ctx.clearRect(0, 0, width, height);
  const terrain = track.terrain || [];
  const heights = track.height?.length ? track.height : terrain;
  const n = terrain.length;
  if (n < 2) return;

  const pad = { left: 34, right: 8, top: 8, bottom: 8 };
  const values = [...terrain, ...heights];
  if (track.overWater?.some(Boolean)) values.push(0);
  let low = Math.min(...values);
  let high = Math.max(...values);
  // Never let a flat track fill the strip with noise: show at least 20 m.
  if (high - low < 20) { const mid = (high + low) / 2; low = mid - 10; high = mid + 10; }
  const span = high - low;
  low -= span * 0.08;
  high += span * 0.08;

  const x = (i) => pad.left + (i / (n - 1)) * (width - pad.left - pad.right);
  const y = (metres) => pad.top + (1 - (metres - low) / (high - low)) * (height - pad.top - pad.bottom);
  const floor = height - pad.bottom;

  // Water first, as a band from its surface down, so the ground sits on it.
  if (track.overWater) {
    ctx.fillStyle = COLORS.water;
    for (let i = 0; i < n; i++) {
      if (!track.overWater[i]) continue;
      const surface = Math.max(0, terrain[i]);
      const x0 = x(Math.max(0, i - 0.5));
      const x1 = x(Math.min(n - 1, i + 0.5));
      ctx.fillRect(x0, y(surface), x1 - x0, floor - y(surface));
    }
  }

  // The ground, filled down to the bottom edge.
  ctx.beginPath();
  ctx.moveTo(x(0), floor);
  for (let i = 0; i < n; i++) ctx.lineTo(x(i), y(terrain[i]));
  ctx.lineTo(x(n - 1), floor);
  ctx.closePath();
  ctx.fillStyle = COLORS.profileTerrain;
  ctx.fill();
  ctx.beginPath();
  for (let i = 0; i < n; i++) ctx[i ? 'lineTo' : 'moveTo'](x(i), y(terrain[i]));
  ctx.strokeStyle = COLORS.profileTerrainEdge;
  ctx.lineWidth = 1;
  ctx.stroke();

  // The track, one step at a time in its structure's colour; red where blocked.
  if (track.height?.length === n && track.kinds?.length === n) {
    const blocked = new Set(track.blockedAt || []);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    for (let i = 1; i < n; i++) {
      const kind = track.kinds[i];
      ctx.strokeStyle = blocked.has(i) || blocked.has(i - 1) ? COLORS.blocked : COLORS.structure[kind];
      ctx.setLineDash(kind === 'tunnel' ? [4, 3] : []);
      ctx.beginPath();
      ctx.moveTo(x(i - 1), y(heights[i - 1]));
      ctx.lineTo(x(i), y(heights[i]));
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Bridge piers: a few thin verticals down to the ground.
    ctx.strokeStyle = COLORS.structure.bridge;
    ctx.lineWidth = 1;
    const every = Math.max(1, Math.round(n / 40));
    for (let i = 0; i < n; i += every) {
      if (track.kinds[i] !== 'bridge') continue;
      ctx.beginPath();
      ctx.moveTo(x(i), y(heights[i]));
      ctx.lineTo(x(i), y(Math.max(terrain[i], track.overWater?.[i] ? 0 : terrain[i])));
      ctx.stroke();
    }
  }

  // Height scale: just the top and bottom, in metres.
  ctx.fillStyle = COLORS.stopStroke;
  ctx.font = '10px system-ui, sans-serif';
  ctx.textBaseline = 'top';
  ctx.fillText(`${Math.round(high)} m`, 2, pad.top);
  ctx.textBaseline = 'bottom';
  ctx.fillText(`${Math.round(low)} m`, 2, floor);
}

/** One line under the strip: length, cost, structures, or why it is refused. */
function describe(track) {
  if (track.blocked) {
    const key = track.reason === 'tooSteep' ? 'trackTooSteep' : track.reason;
    return STRINGS.errors[key] || STRINGS.errors.blockedByBuilding;
  }
  const lengthOf = (kind) => (track.kinds || []).filter((k) => k === kind).length;
  const step = (track.lengthM || 0) / Math.max(1, (track.kinds?.length || 1) - 1);
  const parts = [
    `${((track.lengthM || 0) / 1000).toFixed(2)} km`,
    formatMoney(track.cost ?? 0),
  ];
  for (const kind of ['tunnel', 'bridge']) {
    const metres = lengthOf(kind) * step;
    if (metres > 0) parts.push(`${STRINGS.build[kind]} ${Math.round(metres)} m`);
  }
  const crossings = track.levelCrossings?.length || 0;
  if (crossings) {
    parts.push(`${crossings} ${crossings === 1
      ? STRINGS.build.levelCrossing : STRINGS.build.levelCrossings}`);
  }
  return parts.join(' · ');
}
