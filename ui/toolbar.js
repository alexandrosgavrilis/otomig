/**
 * The left toolbar and the map interaction it drives.
 *
 * Modes and tools are a small state machine: a mode plus a tool decides what a
 * click on the map does — including a click on an existing stop. Edit stops
 * selects whatever it is clicked on, and with a line selected a click beside
 * it inserts a stop there, as in Cities: Skylines; New line starts from (or
 * continues through) the stop, so lines can share stops as real ones do, and
 * clicking the line's first stop again finishes it; Extend line picks the
 * stop's line; Bulldoze removes it.
 *
 * All four modes are enabled. **Build track** is the one tool that belongs to
 * only some of them: metro and train are built in two steps — track first,
 * then lines on it — so the tool is disabled for bus and tram, which ride on
 * roads that already exist.
 *
 * **Dragging a segment** is the one gesture that is not a click. Press on the
 * line between two stops, drag, release: for a bus that forces a different
 * road route through the dragged point, and for a tram it pulls the segment
 * off the road entirely into dedicated track. Same gesture, different meaning
 * by mode — which is why both arrive together.
 */

import { STRINGS } from './strings.js';
import { MODES, COSTS, BUILD, INPUT, PLAYABLE_MODES, PLANNED_MODES } from '../config.js';
import { formatMoney } from '../sim/economy.js';

export const TOOLS = ['newLine', 'extendLine', 'editStops', 'buildTrack', 'bulldoze'];
const MODE_LIST = PLAYABLE_MODES;
const RAIL_MODES = ['metro', 'train'];

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
        ${MODE_LIST.map((mode, index) => `
          <button type="button" data-mode="${mode}"
            class="${mode === state.mode ? 'on' : ''}">
            <span class="key">${index + 1}</span> ${STRINGS.toolbar[mode]}
          </button>`).join('')}
        ${PLANNED_MODES.map((mode) => `
          <button type="button" data-mode="${mode}" disabled
            title="${STRINGS.toolbar.planned}">
            <span class="key"></span> ${STRINGS.toolbar[mode]}
          </button>`).join('')}
      </div>
      <hr />
      <div class="group" id="tb-tools">
        ${TOOLS.map((tool) => `
          <button type="button" data-tool="${tool}"
            class="${tool === state.tool ? 'on' : ''}">${STRINGS.toolbar[tool]}</button>`).join('')}
      </div>
      <div class="hint" id="tb-hint" hidden>${STRINGS.build.trackHint}</div>

      <hr />
      <div class="group">
        <button type="button" id="t-heat">${STRINGS.toolbar.heatMap}</button>
        <button type="button" id="t-flows" title="${STRINGS.toolbar.flowsHint}">${STRINGS.toolbar.flows}</button>
        <button type="button" id="t-buildings" class="on">${STRINGS.toolbar.buildings}</button>
        <button type="button" id="t-contours" class="on">${STRINGS.toolbar.contours}</button>
        <button type="button" id="t-underlay">${STRINGS.toolbar.underlay}</button>
      </div>
    </div>
  `;

  const modes = root.querySelector('#tb-modes');
  const tools = root.querySelector('#tb-tools');
  const hint = root.querySelector('#tb-hint');
  // Undo / Done / Cancel float at the top centre of the screen while a line
  // or track is being drawn — big enough for a finger, and off the toolbar,
  // which has enough in it (Alex, Oct 17 2026).
  const draftBar = document.createElement('div');
  draftBar.className = 'draft-bar';
  draftBar.id = 'tb-draft';
  draftBar.hidden = true;
  draftBar.innerHTML = `
    <span class="draft-what" data-draft-what></span>
    <button type="button" data-draft="undo" title="${STRINGS.draft.undoHint}">${STRINGS.draft.undo}</button>
    <button type="button" data-draft="finish" class="primary" title="${STRINGS.draft.finishHint}">${STRINGS.draft.finish}</button>
    <button type="button" data-draft="cancel" title="${STRINGS.draft.cancelHint}">${STRINGS.draft.cancel}</button>
  `;
  (root.closest('.game') || root).appendChild(draftBar);
  syncTools();

  // Undo, Finish and Cancel while a line or track is being drawn: what
  // Backspace, Enter and Esc do, for a screen with no keyboard.
  draftBar.addEventListener('click', (event) => {
    const action = event.target.closest('button[data-draft]')?.dataset.draft;
    if (!action) return;
    if (game.trackDraft) {
      if (action === 'undo') game.removeTrackPoint();
      else if (action === 'finish') {
        const result = game.finishTrack();
        if (result.error) onFeedbackForDraft?.(STRINGS.errors[result.error] || result.error);
      } else game.cancelTrack();
    } else if (game.draft) {
      if (action === 'undo') {
        const result = game.undoDraftStop();
        if (result.error) onFeedbackForDraft?.(STRINGS.errors[result.error] || result.error);
      } else if (action === 'finish') game.finishDraft();
      else game.discardDraft();
    }
    update();
    onChange?.(state);
  });

  /** Show the draft bar only while something is being drawn, saying what. */
  function update() {
    const drawing = Boolean(game.draft || game.trackDraft);
    if (draftBar.hidden === drawing) draftBar.hidden = !drawing;
    if (!drawing) return;
    const what = game.trackDraft
      ? STRINGS.draft.drawingTrack(STRINGS.toolbar[game.trackDraft.mode], game.trackDraft.control.length)
      : STRINGS.draft.drawingLine(STRINGS.toolbar[game.draft.line.mode], game.draft.line.stops.length);
    const label = draftBar.querySelector('[data-draft-what]');
    if (label.textContent !== what) label.textContent = what;
  }
  let onFeedbackForDraft = null;

  modes.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-mode]:not(:disabled)');
    if (!button) return;
    setMode(button.dataset.mode);
  });

  tools.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tool]:not(:disabled)');
    if (!button) return;
    setTool(button.dataset.tool);
  });

  function setMode(mode) {
    if (!MODE_LIST.includes(mode)) return;
    state.mode = mode;
    cancelDraft();
    for (const button of modes.querySelectorAll('button')) {
      button.classList.toggle('on', button.dataset.mode === mode);
    }
    // Build track means nothing for a bus or a tram.
    if (state.tool === 'buildTrack' && !RAIL_MODES.includes(mode)) state.tool = 'newLine';
    syncTools();
    onChange?.(state);
  }

  function setTool(tool) {
    if (tool === 'buildTrack' && !RAIL_MODES.includes(state.mode)) return;
    state.tool = tool;
    cancelDraft();
    syncTools();
    onChange?.(state);
  }

  function syncTools() {
    for (const button of tools.querySelectorAll('button')) {
      button.classList.toggle('on', button.dataset.tool === state.tool);
      if (button.dataset.tool === 'buildTrack') {
        button.disabled = !RAIL_MODES.includes(state.mode);
        button.title = button.disabled ? STRINGS.errors.trackOnlyRail : '';
      }
    }
    hint.hidden = state.tool !== 'buildTrack';
  }

  /**
   * Esc, or switching mode or tool. A line being drawn is kept as far as it
   * got, as in Mini Metro; track being drawn is discarded, because nothing
   * about it has been built or paid for yet.
   */
  function cancelDraft() {
    if (game.draft) {
      game.finishDraft();
    }
    game.cancelTrack();
    state.extendTarget = null;
  }

  // Flows are drawn by the overlay, not MapLibre, so they are a game flag.
  const flowsButton = root.querySelector('#t-flows');
  flowsButton.addEventListener('click', () => {
    game.showFlows = !game.showFlows;
    flowsButton.classList.toggle('on', game.showFlows);
    onToggleLayer?.(['flows'], game.showFlows);
  });

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

  return {
    state, setMode, setTool, cancelDraft, root, update,
    /** Where the draft buttons report a refusal; set once the map is wired. */
    set onFeedback(callback) { onFeedbackForDraft = callback; },
  };
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

    // Building track: every click is a waypoint, or a junction when it lands
    // on existing track. Nothing is selected, because stations sit on track
    // and clicking one is how a branch is started from it.
    if (state.tool === 'buildTrack') {
      if (!game.trackDraft) game.startTrack(state.mode);
      const result = game.addTrackPoint(lon, lat, junctionSnapM(map));
      reportTrack(result, event.point);
      return;
    }

    // What a click on an existing stop means is up to the tool. This used to
    // be decided once, before any tool, as "select it" — which left Bulldoze
    // unable to remove a stop, Extend line unable to pick its line, and New
    // line unable to start at a stop that already existed. Selecting is Edit
    // stops' job.
    const stopReach = pixelsToMetres(map, 12);
    const hitStop = game.network.stopNear(lon, lat, stopReach);

    if (state.tool === 'newLine') {
      // A click on an existing stop of the same mode, on the same side of
      // the road, shares it, as real lines share stops. A stop of another
      // mode cannot be shared, so the new line gets its own stop beside it,
      // which forms an interchange. Clicking the line's first stop again
      // finishes it.
      if (!game.draft) game.startLine(state.mode);
      const result = game.extendDraft(lon, lat, stopReach);
      if (result.error) onFeedback?.(errorText(result.error), event.point);
    } else if (state.tool === 'extendLine') {
      if (!state.extendTarget) {
        const line = hitStop ? game.network.lines.get(hitStop.lines[0]) : null;
        if (!line) { onFeedback?.(STRINGS.errors.pickALine, event.point); return; }
        state.extendTarget = line;
        game.draft = { line, cursor: null, spot: null };
        // This click only picked the line. Carrying on would try to add the
        // picked stop to its own line and refuse with "already on this line".
        return;
      }
      const result = game.extendDraft(lon, lat, stopReach);
      if (result.error) onFeedback?.(errorText(result.error), event.point);
      if (result.finished) state.extendTarget = null;
    } else if (state.tool === 'bulldoze') {
      // Section by section: a stop goes, and each line through it is joined
      // across the gap. A click on a line between stops takes the nearer of
      // the two stops off that line only. A whole line is deleted from its
      // panel, not with the bulldozer.
      const reach = pixelsToMetres(map, 10);
      let result;
      if (hitStop) {
        result = game.bulldoze(hitStop);
      } else {
        const hit = segmentAt(game, lon, lat, reach, { includeRail: true });
        if (hit) {
          const nearer = [hit.fromId, hit.toId]
            .map((id) => game.network.stops.get(id))
            .sort((a, b) => game.frame.distance(lon, lat, a.lon, a.lat)
              - game.frame.distance(lon, lat, b.lon, b.lat))[0];
          result = game.removeStopFromLine(hit.line, nearer.id);
        } else {
          result = game.bulldoze(game.network.trackNear(lon, lat, reach));
        }
      }
      if (result?.error) onFeedback?.(errorText(result.error), event.point);
    } else if (state.tool === 'editStops') {
      // Select whatever is under the cursor: a stop first, then a line, then
      // bare track. With a line selected, a click beside it inserts a stop
      // into it there instead.
      const reach = pixelsToMetres(map, 10);
      const line = selectedLine();
      if (!hitStop && line && game.insertionAt(line, lon, lat, reach)) {
        const result = game.insertStopAt(line, lon, lat, reach);
        if (result.error) onFeedback?.(errorText(result.error), event.point);
        game.insertHover = null;
        return;
      }
      const target = hitStop || nearestLine(game, lon, lat, reach)
        || game.network.trackNear(lon, lat, reach);
      game.selection = target || null;
      onSelect?.(target);
    }
  });

  /** The line selected with Edit stops, which a click beside inserts a stop into. */
  function selectedLine() {
    const selection = game.selection;
    return state.tool === 'editStops' && selection?.segments !== undefined
      && game.network.lines.has(selection.id) ? selection : null;
  }

  function reportTrack(result, point) {
    if (result.error) onFeedback?.(errorText(result.error), point);
    else if (result.track) {
      onFeedback?.(`${STRINGS.build.trackBuilt} ${formatMoney(result.cost)}`, point);
    }
  }

  // The rubber band follows the cursor while drawing.
  map.on('mousemove', (event) => {
    const { lng: lon, lat } = event.lngLat;
    // Track being drawn re-plans on every move, so the structures, the cost
    // and anything blocking it are live before a waypoint is placed.
    if (game.trackDraft) game.previewTrack(lon, lat, junctionSnapM(map));
    // A ghost of the stop a click would insert into the selected line.
    const line = selectedLine();
    game.insertHover = line && !game.drag && !game.stopDrag
      && !game.network.stopNear(lon, lat, pixelsToMetres(map, 12))
      ? game.insertionAt(line, lon, lat, pixelsToMetres(map, 10)) : null;
    if (!game.draft) return;
    game.draft.cursor = [lon, lat];
    // Where the next stop would stand, and on which side of the road.
    game.draft.spot = game.network.snapStop(lon, lat, game.draft.line.mode);
  });

  // Double-click or Enter finishes a line, Esc cancels — as in Mini Metro.
  map.on('dblclick', (event) => {
    if (game.trackDraft) {
      event.preventDefault();
      reportTrack(game.finishTrack(), event.point);
      return;
    }
    if (!game.draft) return;
    event.preventDefault();
    game.finishDraft();
    toolbar.state.extendTarget = null;
  });

  // ─── Dragging a stop or a segment ─────────────────────────────────────────
  // Press on a line between two stops and pull: for a bus this forces a
  // different road route, for a tram it pulls the segment off the road into
  // dedicated track. With Edit stops, press on a stop and pull to move it.
  // MapLibre's own drag-pan is suspended for the duration, or the map slides
  // out from under the gesture.
  //
  // A mouse picks things up the moment it presses. A finger has to HOLD
  // first (INPUT.TOUCH_HOLD_MS), because on a tablet the same swipe also pans
  // the map, and lines are everywhere: a quick swipe pans, a press held still
  // on a stop or a line picks it up.

  /** What a press here would pick up, or null. */
  function grabbable(lon, lat) {
    if (game.draft || game.trackDraft) return null;
    if (state.tool === 'bulldoze' || state.tool === 'buildTrack') return null;
    // A stop first: every stop sits on its own line's segments.
    if (state.tool === 'editStops') {
      const stop = game.network.stopNear(lon, lat, pixelsToMetres(map, 12));
      if (stop) return { stop };
    }
    const hit = segmentAt(game, lon, lat, pixelsToMetres(map, 10));
    return hit ? { segment: hit, lonLat: [lon, lat] } : null;
  }

  function startDrag(grab) {
    map.dragPan.disable();
    if (grab.stop) game.stopDrag = { stop: grab.stop, preview: null };
    else game.drag = { ...grab.segment, via: grab.lonLat, preview: null };
  }

  function moveDrag(lon, lat) {
    if (game.stopDrag) {
      game.stopDrag.preview = game.previewStopMove(game.stopDrag.stop, lon, lat)
        || { lon, lat, valid: false };
      game.stopDrag.cursor = [lon, lat];
      return;
    }
    if (!game.drag) return;
    game.drag.via = [lon, lat];
    game.drag.preview = game.previewVia(
      game.drag.line, game.drag.fromId, game.drag.toId, game.drag.via);
    // What this drag would cost, live, so the bill is never a surprise. The
    // spec asks for a cost preview that follows the cursor; this is it for the
    // one gesture that can cost money without placing a stop.
    game.drag.costDelta = game.dragCostDelta(
      game.drag.line, game.drag.fromId, game.drag.toId, game.drag.preview);
  }

  const endDrag = (event) => {
    if (game.stopDrag) {
      const { stop, cursor } = game.stopDrag;
      game.stopDrag = null;
      map.dragPan.enable();
      // A press that never moved is a click: it selects, as before.
      if (!cursor) return;
      const result = game.moveStop(stop, cursor[0], cursor[1]);
      if (result.error) onFeedback?.(errorText(result.error), event?.point);
      else if (result.cost > 0) onFeedback?.(formatMoney(result.cost), event?.point);
      return;
    }
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

  // Mouse.
  map.on('mousedown', (event) => {
    const grab = grabbable(event.lngLat.lng, event.lngLat.lat);
    if (!grab) return;
    event.preventDefault();
    startDrag(grab);
  });
  map.on('mousemove', (event) => moveDrag(event.lngLat.lng, event.lngLat.lat));
  map.on('mouseup', endDrag);
  // Releasing outside the canvas must not leave the map un-pannable.
  map.getCanvas().addEventListener('mouseleave', () => {
    if (game.drag || game.stopDrag) endDrag(null);
  });

  // Touch: hold, then drag.
  let hold = null;
  const cancelHold = () => { if (hold) clearTimeout(hold.timer); hold = null; };
  map.on('touchstart', (event) => {
    cancelHold();
    // Two fingers are a pinch, never a drag.
    if (event.points.length !== 1) return;
    const grab = grabbable(event.lngLat.lng, event.lngLat.lat);
    if (!grab) return;
    hold = {
      grab,
      point: event.point,
      timer: setTimeout(() => {
        const held = hold;
        hold = null;
        if (!held) return;
        startDrag(held.grab);
        // A tick under the finger says "picked up", where the device can.
        globalThis.navigator?.vibrate?.(15);
      }, INPUT.TOUCH_HOLD_MS),
    };
  });
  map.on('touchmove', (event) => {
    if (hold) {
      // Moved before the hold completed: it was a pan after all.
      const moved = Math.hypot(event.point.x - hold.point.x, event.point.y - hold.point.y);
      if (moved > INPUT.TOUCH_SLOP_PX || event.points.length !== 1) cancelHold();
      return;
    }
    if (!game.drag && !game.stopDrag) return;
    event.preventDefault();
    moveDrag(event.lngLat.lng, event.lngLat.lat);
  });
  map.on('touchend', (event) => { cancelHold(); endDrag(event); });
  map.on('touchcancel', () => { cancelHold(); if (game.drag || game.stopDrag) endDrag(null); });
}

/**
 * The line segment under a point, as the stop pair that defines it.
 *
 * Returns the stop ids rather than a segment index because a via is stored
 * against the pair — see `Line.vias` for why an index would be the wrong key.
 *
 * @returns {{line:object, fromId:string, toId:string}|null}
 */
export function segmentAt(game, lon, lat, maxDistM, { includeRail = false } = {}) {
  let best = null;
  let bestDist = maxDistM;
  for (const line of game.network.lines.values()) {
    // A metro or train line follows its track; there is nothing to drag it to.
    if (!includeRail && RAIL_MODES.includes(line.mode)) continue;
    const near = game.network.segmentNear(line, lon, lat, bestDist);
    if (!near) continue;
    // On a loop the final segment closes back to the first stop.
    const fromId = line.stops[near.index];
    const toId = line.stops[(near.index + 1) % line.stops.length];
    if (!fromId || !toId || fromId === toId) continue;
    bestDist = near.distance;
    best = { line, fromId, toId };
  }
  return best;
}

/**
 * How near existing track a Build track click must be to join it: the
 * configured distance, or ten pixels when zoomed out so far that the
 * configured distance is smaller than the cursor.
 */
function junctionSnapM(map) {
  return Math.max(BUILD.JUNCTION_SNAP_M, pixelsToMetres(map, 10));
}

/** Approximate ground metres for a screen-pixel radius at the current zoom. */
export function pixelsToMetres(map, pixels) {
  const centre = map.getCenter();
  const a = map.project(centre);
  const b = map.unproject([a.x + pixels, a.y]);
  // MapLibre's own geodesic distance, so this is right at any latitude.
  return centre.distanceTo(b);
}

/** Nearest line to a point within `maxDistM`, or null. */
function nearestLine(game, lon, lat, maxDistM) {
  return segmentAt(game, lon, lat, maxDistM, { includeRail: true })?.line ?? null;
}

function errorText(code) {
  return STRINGS.errors[code] || code;
}

/** Cost preview text for the cursor while building. */
export function costPreview(mode) {
  return `${formatMoney(COSTS.STOP[mode])} · ${MODES[mode].capacity} seats/vehicle`;
}
