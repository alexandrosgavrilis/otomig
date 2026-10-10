/**
 * The left toolbar and the map interaction it drives.
 *
 * Modes and tools are a small state machine: a mode (bus for now) plus a tool
 * decides what a click on the map does. Clicking a game object always selects
 * it instead of building, as the spec requires — so a misplaced click opens a
 * panel rather than silently extending a line.
 *
 * Phase 2 ships Bus only. The other three mode buttons are present but
 * disabled, because a dead button that says "Tram" tells the player the plan;
 * a missing one tells them nothing.
 */

import { STRINGS } from './strings.js';
import { MODES, COSTS } from '../config.js';
import { formatMoney } from '../sim/economy.js';

/** Tools available in Phase 2. Build track arrives with rail in Phase 4. */
export const TOOLS = ['newLine', 'extendLine', 'editStops', 'bulldoze'];
const PHASE_2_MODES = ['bus'];

export function mountToolbar(root, game, { onChange, onToggleLayer }) {
  const state = {
    mode: 'bus',
    tool: 'newLine',
    /** The line being extended with the Extend tool. */
    extendTarget: null,
  };

  root.innerHTML = `
    <div class="toolbar">
      <div class="group" id="tb-modes">
        ${['bus', 'tram', 'metro', 'train'].map((mode, index) => `
          <button type="button" data-mode="${mode}"
            ${PHASE_2_MODES.includes(mode) ? '' : 'disabled title="Arrives in a later phase"'}
            class="${mode === state.mode ? 'on' : ''}">
            <span class="key">${index + 1}</span> ${STRINGS.toolbar[mode]}
          </button>`).join('')}
      </div>
      <hr />
      <div class="group" id="tb-tools">
        ${TOOLS.map((tool) => `
          <button type="button" data-tool="${tool}"
            class="${tool === state.tool ? 'on' : ''}">${STRINGS.toolbar[tool]}</button>`).join('')}
      </div>
      <hr />
      <div class="group">
        <button type="button" id="t-heat">${STRINGS.toolbar.heatMap}</button>
        <button type="button" id="t-contours" class="on">${STRINGS.toolbar.contours}</button>
        <button type="button" id="t-underlay">${STRINGS.toolbar.underlay}</button>
      </div>
    </div>
  `;

  const modes = root.querySelector('#tb-modes');
  const tools = root.querySelector('#tb-tools');

  modes.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]:not(:disabled)');
    if (!button) return;
    setMode(button.dataset.mode);
  });

  tools.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tool]');
    if (!button) return;
    setTool(button.dataset.tool);
  });

  function setMode(mode) {
    if (!PHASE_2_MODES.includes(mode)) return;
    state.mode = mode;
    cancelDraft();
    for (const button of modes.querySelectorAll('button')) {
      button.classList.toggle('on', button.dataset.mode === mode);
    }
    onChange?.(state);
  }

  function setTool(tool) {
    state.tool = tool;
    cancelDraft();
    for (const button of tools.querySelectorAll('button')) {
      button.classList.toggle('on', button.dataset.tool === tool);
    }
    onChange?.(state);
  }

  function cancelDraft() {
    if (game.draft) {
      game.finishDraft();
    }
    state.extendTarget = null;
  }

  for (const [id, layers] of [
    ['t-heat', ['heat']],
    ['t-contours', ['contours-minor', 'contours-major']],
    ['t-underlay', ['osm-underlay']],
  ]) {
    const button = root.querySelector(`#${id}`);
    button.addEventListener('click', () => {
      button.classList.toggle('on');
      onToggleLayer?.(layers, button.classList.contains('on'));
    });
  }

  return { state, setMode, setTool, cancelDraft, root };
}

/**
 * Wire map clicks to the current tool.
 *
 * MapLibre owns panning, so we listen on its canvas and use its click event,
 * which already gives us lon/lat. A drag never produces a click, so panning
 * and building do not fight.
 */
export function wireMapInteraction(map, game, toolbar, { onFeedback, onSelect }) {
  const state = toolbar.state;

  map.on('click', (event) => {
    const { lng: lon, lat } = event.lngLat;

    // Clicking an existing object always selects it rather than building —
    // except while drawing, where clicking a stop is how you route through it.
    const hitStop = game.network.stopNear(lon, lat, pixelsToMetres(map, 12));
    if (hitStop && !game.draft) {
      game.selection = hitStop;
      onSelect?.(hitStop);
      return;
    }

    if (state.tool === 'newLine') {
      if (!game.draft) game.startLine(state.mode);
      const result = game.extendDraft(lon, lat);
      if (result.error) onFeedback?.(errorText(result.error), event.point);
    } else if (state.tool === 'extendLine') {
      if (!state.extendTarget) {
        const line = hitStop ? game.network.lines.get(hitStop.lines[0]) : null;
        if (!line) { onFeedback?.(STRINGS.errors.pickALine, event.point); return; }
        state.extendTarget = line;
        game.draft = { line, cursor: null, valid: true };
      }
      const result = game.extendDraft(lon, lat);
      if (result.error) onFeedback?.(errorText(result.error), event.point);
    } else if (state.tool === 'bulldoze') {
      const target = hitStop || nearestLine(game, lon, lat, pixelsToMetres(map, 10));
      if (target) game.bulldoze(target);
      else onFeedback?.(STRINGS.errors.nothingThere, event.point);
    } else if (state.tool === 'editStops') {
      if (hitStop) { game.selection = hitStop; onSelect?.(hitStop); }
    }
  });

  // The rubber band follows the cursor while drawing.
  map.on('mousemove', (event) => {
    if (!game.draft) return;
    const { lng: lon, lat } = event.lngLat;
    game.draft.cursor = [lon, lat];
    game.draft.valid = Boolean(game.roadIndex.snap(lon, lat, game.draft.line.mode));
  });

  // Double-click or Enter finishes a line, Esc cancels — as in Mini Metro.
  map.on('dblclick', (event) => {
    if (!game.draft) return;
    event.preventDefault();
    game.finishDraft();
    toolbar.state.extendTarget = null;
  });
}

/** Approximate ground metres for a screen-pixel radius at the current zoom. */
export function pixelsToMetres(map, pixels) {
  const centre = map.getCenter();
  const a = map.project(centre);
  const b = map.unproject([a.x + pixels, a.y]);
  // MapLibre's own geodesic distance, so this is right at any latitude.
  return centre.distanceTo(b);
}

/** Nearest line to a point, by distance to any of its segment vertices. */
function nearestLine(game, lon, lat, maxDistM) {
  let best = null;
  let bestDist = maxDistM;
  for (const line of game.network.lines.values()) {
    for (const segment of line.segments) {
      for (const [pLon, pLat] of segment.points) {
        const distance = game.frame.distance(lon, lat, pLon, pLat);
        if (distance < bestDist) { bestDist = distance; best = line; }
      }
    }
  }
  return best;
}

function errorText(code) {
  return STRINGS.errors[code] || code;
}

/** Cost preview text for the cursor while building. */
export function costPreview(mode) {
  return `${formatMoney(COSTS.STOP[mode])} · ${MODES[mode].capacity} seats/vehicle`;
}
