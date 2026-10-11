/**
 * The left toolbar and the map interaction it drives.
 *
 * Modes and tools are a small state machine: a mode plus a tool decides what a
 * click on the map does. Clicking a game object always selects it instead of
 * building, as the spec requires — so a misplaced click opens a panel rather
 * than silently extending a line.
 *
 * Bus and Tram are enabled. Metro and Train are present but disabled until
 * Phase 4, because a dead button that says "Metro" tells the player the plan;
 * a missing one tells them nothing.
 *
 * **Dragging a segment** is the one gesture that is not a click. Press on the
 * line between two stops, drag, release: for a bus that forces a different
 * road route through the dragged point, and for a tram it pulls the segment
 * off the road entirely into dedicated track. Same gesture, different meaning
 * by mode — which is why both arrive together.
 */

import { STRINGS } from './strings.js';
import { MODES, COSTS } from '../config.js';
import { formatMoney } from '../sim/economy.js';

/** Tools available in Phase 2. Build track arrives with rail in Phase 4. */
export const TOOLS = ['newLine', 'extendLine', 'editStops', 'bulldoze'];
const ENABLED_MODES = ['bus', 'tram'];

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
            ${ENABLED_MODES.includes(mode) ? '' : 'disabled title="Arrives in a later phase"'}
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
        <button type="button" id="t-buildings" class="on">${STRINGS.toolbar.buildings}</button>
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
    if (!ENABLED_MODES.includes(mode)) return;
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
    ['t-buildings', ['buildings']],
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

  // ─── Dragging a segment ───────────────────────────────────────────────────
  // Press on a line between two stops and pull. For a bus this forces a
  // different road route; for a tram it pulls the segment off the road into
  // dedicated track. MapLibre's own drag-pan has to be suspended for the
  // duration, or the map slides out from under the gesture.
  map.on('mousedown', (event) => {
    if (game.draft || state.tool === 'bulldoze') return;
    const { lng: lon, lat } = event.lngLat;
    const hit = segmentAt(game, lon, lat, pixelsToMetres(map, 10));
    if (!hit) return;

    event.preventDefault();
    map.dragPan.disable();
    game.drag = { ...hit, via: [lon, lat], preview: null };
  });

  map.on('mousemove', (event) => {
    if (!game.drag) return;
    const { lng: lon, lat } = event.lngLat;
    game.drag.via = [lon, lat];
    game.drag.preview = game.previewVia(
      game.drag.line, game.drag.fromId, game.drag.toId, game.drag.via);
    // What this drag would cost, live, so the bill is never a surprise. The
    // spec asks for a cost preview that follows the cursor; this is it for the
    // one gesture that can cost money without placing a stop.
    game.drag.costDelta = game.dragCostDelta(
      game.drag.line, game.drag.fromId, game.drag.toId, game.drag.preview);
  });

  const endDrag = (event) => {
    const drag = game.drag;
    if (!drag) return;
    game.drag = null;
    map.dragPan.enable();

    // A press that never really moved is a click, not a drag — let it be.
    if (!drag.preview) return;

    const result = game.setVia(drag.line, drag.fromId, drag.toId, drag.via);
    if (result.error) onFeedback?.(errorText(result.error), event?.point);
    else if (result.cost > 0) {
      onFeedback?.(`${STRINGS.build.trackBuilt} ${formatMoney(result.cost)}`, event?.point);
    }
  };
  map.on('mouseup', endDrag);
  // Releasing outside the canvas must not leave the map un-pannable.
  map.getCanvas().addEventListener('mouseleave', () => { if (game.drag) endDrag(null); });
}

/**
 * The line segment under a point, as the stop pair that defines it.
 *
 * Returns the stop ids rather than a segment index because a via is stored
 * against the pair — see `Line.vias` for why an index would be the wrong key.
 *
 * @returns {{line:object, fromId:string, toId:string}|null}
 */
export function segmentAt(game, lon, lat, maxDistM) {
  let best = null;
  let bestDist = maxDistM;
  for (const line of game.network.lines.values()) {
    line.segments.forEach((segment, index) => {
      // On a loop the final segment closes back to the first stop.
      const fromId = line.stops[index];
      const toId = line.stops[(index + 1) % line.stops.length];
      if (!fromId || !toId || fromId === toId) return;
      for (const [pLon, pLat] of segment.points) {
        const distance = game.frame.distance(lon, lat, pLon, pLat);
        if (distance < bestDist) { bestDist = distance; best = { line, fromId, toId }; }
      }
    });
  }
  return best;
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
