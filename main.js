/**
 * Entry point: new-game screen, then the game screen and its loop.
 *
 * The loop is a plain requestAnimationFrame driving Game.advance with real
 * elapsed time. The Game does its own fixed-step subdivision, so a dropped
 * frame slows nothing down and a fast monitor speeds nothing up.
 */

import { ATTRIBUTION, PLAYABLE_MODES } from './config.js';
import { reviveRegion } from './model/region.js';
import { regionKey as makeRegionKey } from './data/cache.js';
import { createMap, setLayerVisible, setHeatMapData } from './render/basemap.js';
import {
  Overlay, regionBoundaryPainter, linesPainter, interchangesPainter,
  stopsPainter, vehiclesPainter, draftPainter, tracksPainter, trackDraftPainter,
  levelCrossingsPainter, flowsPainter,
} from './render/overlay.js';
import { mountProfile } from './render/profile.js';
import { Game } from './sim/game.js';
import {
  autosave, saveGame, loadGame, newestSaveOf, exportSaveFile, importSaveFile,
} from './model/save.js';
import { mountNewGame } from './ui/new-game.js';
import { mountHud, mountLegend } from './ui/hud.js';
import { mountToolbar, wireMapInteraction } from './ui/toolbar.js';
import { mountPanels } from './ui/panels.js';
import { mountTuning } from './ui/tuning.js';
import { applyOverrides, loadSaved } from './sim/tuning.js';
import { STRINGS } from './ui/strings.js';

const app = document.getElementById('app');
mountNewGame(app, (region) => startGame(region), {
  // A save chosen on the start screen, or a save file opened there.
  onResume: ({ game }) => startGame(game.region, game),
});

/**
 * Show the game screen: a new game on a region, or a loaded one.
 *
 * Until Oct 17 2026 Load and Import file passed only the loaded game's REGION
 * here, and a fresh game was made on it — so loading always showed an empty
 * network and the starting money, and nothing ever seemed to have been saved.
 *
 * @param {import('./model/region.js').Region} region
 * @param {Game} [loaded] a game rebuilt from a save
 */
/** Shuts the running game screen down, before another replaces it. */
let stopCurrent = null;

function startGame(region, loaded = null) {
  // A load replaces the screen. Without stopping the old one, its frame loop,
  // monthly autosave and keyboard handlers all kept running: Space paused
  // twice (doing nothing) and the abandoned game could overwrite the autosave.
  stopCurrent?.();
  const shutdown = new AbortController();
  reviveRegion(region);
  // Play-testing overrides from the tuning panel, kept from the last session.
  // Applied before the game exists, so its first demand table uses them.
  applyOverrides(null, loadSaved());
  const game = loaded ?? new Game(region);
  const regionKey = makeRegionKey(region.meta.center[0], region.meta.center[1], region.meta.sizeKm);

  app.innerHTML = `
    <div class="game">
      <div id="map"></div>
      <canvas id="overlay"></canvas>
      <div id="hud"></div>
      <div id="toolbar"></div>
      <div id="panels"></div>
      <div id="profile"></div>
      <div id="tuning"></div>
      <div id="legend"></div>
      <div class="saves" id="saves">
        <button type="button" id="s-finances">${STRINGS.toolbar.finances}</button>
        <button type="button" id="s-save">${STRINGS.saves.save}</button>
        <button type="button" id="s-load">${STRINGS.saves.load}</button>
        <button type="button" id="s-export">${STRINGS.saves.export}</button>
        <button type="button" id="s-import">${STRINGS.saves.import}</button>
        <input type="file" id="s-file" accept=".otomig,.json,.gz,application/json,application/gzip" hidden />
      </div>
      <div class="attribution">${ATTRIBUTION.osm} · ${ATTRIBUTION.terrain}${
        region.meta.buildingSources?.overture > 0 ? ` · ${ATTRIBUTION.overture}` : ''}</div>
    </div>
  `;

  const map = createMap(document.getElementById('map'), region, game.frame);
  const hud = mountHud(document.getElementById('hud'), game);
  const legend = mountLegend(document.getElementById('legend'), game);
  const panels = mountPanels(document.getElementById('panels'), game, {
    onChange: () => hud.update(),
  });

  const tuning = mountTuning(document.getElementById('tuning'),
    document.getElementById('saves'), game);

  const profile = mountProfile(document.getElementById('profile'), game);
  game.onTick(() => profile.update());

  const toolbar = mountToolbar(document.getElementById('toolbar'), game, {
    onChange: () => { game.selection = null; panels.render(); },
    onToggleLayer: (layers, visible) => {
      for (const layer of layers) setLayerVisible(map, layer, visible);
      if (layers.includes('heat') && visible) {
        setHeatMapData(map, region, game.demand.unserved);
      }
    },
  });

  // The drawing bar only ever reports a refusal.
  toolbar.onFeedback = (message) => showFeedback(message, undefined, { refused: true });
  wireMapInteraction(map, game, toolbar, {
    onFeedback: (message, point, options) => showFeedback(message, point, options),
    onSelect: () => panels.render(),
  });

  map.on('load', () => {
    const overlay = new Overlay(document.getElementById('overlay'), map);
    overlay.painters.push(
      regionBoundaryPainter(region.meta.bbox),
      flowsPainter(game),
      tracksPainter(game),
      linesPainter(game),
      levelCrossingsPainter(game),
      interchangesPainter(game),
      stopsPainter(game),
      draftPainter(game),
      trackDraftPainter(game),
      vehiclesPainter(game),
    );
    overlay.draw();

    // The overlay only ever redraws on MapLibre's render event, which does not
    // fire while the map is still. Nudge it each frame so vehicles move even
    // when the player is not panning.
    game.onTick(() => overlay.draw());

    window.otomig = { game, region, map, overlay, frame: game.frame };
  });

  wireSaveButtons(game, regionKey, panels, hud);
  wireKeyboard(game, toolbar, panels, hud, tuning, (message) => showFeedback(message), shutdown.signal);

  // Keep the heat map honest as coverage changes.
  let lastHeatVersion = -1;
  game.onTick(() => {
    if (game.network.version === lastHeatVersion) return;
    lastHeatVersion = game.network.version;
    if (map.getLayer('heat')) setHeatMapData(map, region, game.demand.unserved);
  });

  // Autosave on the in-game month boundary.
  let lastMonth = game.clock.month;
  game.onTick(() => {
    if (game.clock.month === lastMonth) return;
    lastMonth = game.clock.month;
    autosave(game, regionKey);
  });

  // The panel follows the game every tick: a selection re-renders, the
  // finances rewrite their figures, and a selection that went away — however
  // it went: bulldozed from the map, Esc, or deleted from its own panel —
  // hides the panel. Without that a bulldozed stop stayed on screen in a
  // panel of its own.
  game.onTick(() => {
    hud.update();
    legend.update();
    toolbar.update();
    panels.update();
    tuning.update();
    if (game.economy.gameOver) showGameOver(game);
  });

  // ─── The loop ─────────────────────────────────────────────────────────────
  let previous = performance.now();
  function frame(now) {
    if (shutdown.signal.aborted) return;
    const realSeconds = Math.min(0.25, (now - previous) / 1000);
    previous = now;
    game.advance(realSeconds);
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  stopCurrent = () => {
    shutdown.abort();
    // The debugging handle pointed at this game; it must not outlive it.
    if (window.otomig?.game === game) window.otomig = null;
    game.listeners.clear();
    map.remove();
  };
}

/**
 * 1–4 pick modes, Space pauses, Esc cancels, Delete removes the selection,
 * Enter finishes. While track is being drawn, Backspace takes back the last
 * waypoint instead — the only way to reroute around something blocking it
 * without starting again. ` opens the play-testing panel.
 */
function wireKeyboard(game, toolbar, panels, hud, tuning, feedback, signal) {
  window.addEventListener('keydown', (event) => {
    if (event.target instanceof HTMLInputElement) return;
    if (event.target instanceof HTMLTextAreaElement) return;

    if (event.code === 'Backquote') {
      tuning.toggle();
    } else if (/^[1-9]$/.test(event.key) && Number(event.key) <= PLAYABLE_MODES.length) {
      toolbar.setMode(PLAYABLE_MODES[Number(event.key) - 1]);
    } else if (event.code === 'Space') {
      event.preventDefault();
      game.clock.togglePause();
      hud.syncSpeedButtons();
    } else if (event.key === 'Escape') {
      toolbar.cancelDraft();
      game.selection = null;
      panels.render();
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      // While drawing, Backspace takes back the last step — a waypoint, or a
      // stop. Otherwise it removes the selection, like Delete.
      if (game.trackDraft) { game.removeTrackPoint(); return; }
      if (game.draft && event.key === 'Backspace') {
        const result = game.undoDraftStop();
        if (result.error) feedback(STRINGS.errors[result.error] || result.error);
        hud.update();
        return;
      }
      if (game.selection) {
        const result = game.bulldoze(game.selection);
        if (result?.error) feedback(STRINGS.errors[result.error] || result.error);
        panels.render(); hud.update();
      }
    } else if (event.key === 'Enter') {
      if (game.trackDraft) {
        const result = game.finishTrack();
        if (result.error) feedback(STRINGS.errors[result.error] || result.error);
        hud.update();
      } else if (game.draft) game.finishDraft();
    }
  }, { signal });
}

function wireSaveButtons(game, regionKey, panels, hud) {
  const $ = (id) => document.getElementById(id);
  const toast = (message) => showFeedback(message, { x: window.innerWidth - 150, y: window.innerHeight - 70 });

  $('s-finances').addEventListener('click', () => panels.showFinances());

  $('s-save').addEventListener('click', async () => {
    try {
      await saveGame(game, regionKey);
      toast(STRINGS.saves.saved);
    } catch (error) {
      toast(`${STRINGS.saves.failed} ${error.message}`);
    }
  });

  // Load this region's newest save, manual or auto.
  $('s-load').addEventListener('click', async () => {
    const slot = await newestSaveOf(regionKey);
    if (!slot) { toast(STRINGS.saves.noSave); return; }
    const result = await loadGame(slot);
    if (result.error) { toast(STRINGS.saves[result.error] || result.error); return; }
    // Reloading rebuilds the whole screen, which is simpler and less
    // error-prone than swapping a live Game out from under the renderer.
    startGame(result.game.region, result.game);
    toast(STRINGS.saves.loaded);
  });

  $('s-export').addEventListener('click', async () => {
    toast(STRINGS.saves.exporting);
    await exportSaveFile(game, regionKey);
  });
  $('s-import').addEventListener('click', () => $('s-file').click());
  $('s-file').addEventListener('change', async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    const result = await importSaveFile(file);
    if (result.error) { toast(STRINGS.saves[result.error] || result.error); return; }
    startGame(result.game.region, result.game);
    toast(STRINGS.saves.loaded);
  });
}

/** A short message near the cursor, with Mini Metro's refusal shake. */
function showFeedback(message, point, { refused = false } = {}) {
  const existing = document.querySelector('.feedback');
  if (existing) existing.remove();

  const element = document.createElement('div');
  // A refusal in the logo's red; news that something was built in ink.
  element.className = refused ? 'feedback refused' : 'feedback';
  element.textContent = message;
  element.style.left = `${point?.x ?? window.innerWidth / 2}px`;
  element.style.top = `${point?.y ?? window.innerHeight / 2}px`;
  document.querySelector('.game')?.appendChild(element);
  setTimeout(() => element.remove(), 1800);
}

/** Hard's twelve negative months. Calm, as the spec asks. */
function showGameOver(game) {
  if (document.querySelector('.gameover')) return;
  const element = document.createElement('div');
  element.className = 'gameover';
  element.innerHTML = `
    <h2>${STRINGS.gameOver.title}</h2>
    <p>${STRINGS.gameOver.body}</p>
    <button type="button" onclick="location.reload()">${STRINGS.gameOver.again}</button>
  `;
  document.querySelector('.game')?.appendChild(element);
}
