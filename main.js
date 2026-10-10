/**
 * Entry point. Shows the new-game screen, then hands the imported region to the
 * game screen.
 *
 * Phase 1 scope: the map is real and explorable, but nothing is drawable yet.
 * The toolbar's mode and tool buttons are deliberately absent rather than
 * present-and-dead — Phase 2 adds them along with the things they do.
 */

import { ATTRIBUTION } from './config.js';
import { LocalFrame, reviveRegion } from './model/region.js';
import { createMap, setLayerVisible } from './render/basemap.js';
import { Overlay, regionBoundaryPainter } from './render/overlay.js';
import { mountNewGame } from './ui/new-game.js';
import { STRINGS } from './ui/strings.js';

const app = document.getElementById('app');

mountNewGame(app, (region) => startGame(region));

/** @param {import('./model/region.js').Region} region */
function startGame(region) {
  reviveRegion(region);
  const frame = new LocalFrame(region.meta.bbox);

  app.innerHTML = `
    <div class="game">
      <div id="map"></div>
      <canvas id="overlay"></canvas>

      <div class="topbar">
        <div class="stat"><b id="hud-name">${region.meta.name}</b><span>${STRINGS.region.residents}: <span id="hud-residents"></span></span></div>
        <div class="spacer"></div>
        <div class="stat"><b>—</b><span>${STRINGS.hud.transported}</span></div>
        <div class="stat"><b>—</b><span>${STRINGS.hud.onNetwork}</span></div>
      </div>

      <div class="toolbar">
        <div class="group">
          <button type="button" id="t-heat">${STRINGS.toolbar.heatMap}</button>
          <button type="button" id="t-contours" class="on">${STRINGS.toolbar.contours}</button>
          <button type="button" id="t-underlay">${STRINGS.toolbar.underlay}</button>
        </div>
      </div>

      <div class="region-card">
        <h2>${region.meta.name}</h2>
        <div class="row">${STRINGS.region.residents} <span id="rc-residents"></span></div>
        <div class="row">${STRINGS.region.area} <span>${region.meta.sizeKm} × ${region.meta.sizeKm} km</span></div>
        <div class="row">${STRINGS.region.roads} <span id="rc-roads"></span></div>
        <div class="row"><span id="rc-rail"></span></div>
      </div>

      <div class="attribution">${ATTRIBUTION.osm} · ${ATTRIBUTION.terrain}</div>
    </div>
  `;

  const residents = region.meta.populationTotal.toLocaleString();
  const roadKm = Math.round(region.roads.edges.reduce((sum, e) => sum + e.lengthM, 0) / 1000);
  document.getElementById('hud-residents').textContent = residents;
  document.getElementById('rc-residents').textContent = residents;
  document.getElementById('rc-roads').textContent = `${roadKm.toLocaleString()} km`;
  document.getElementById('rc-rail').textContent =
    region.meta.hasOsmRail ? STRINGS.region.hasRail : STRINGS.region.noRail;

  const map = createMap(document.getElementById('map'), region, frame);

  map.on('load', () => {
    const overlay = new Overlay(document.getElementById('overlay'), map);
    overlay.painters.push(regionBoundaryPainter(region.meta.bbox));
    overlay.draw();

    // Expose the live objects for console poking during development. This is
    // the only global the game sets, and nothing reads it.
    window.otomig = { region, frame, map, overlay };
  });

  wireToggle('t-heat', () => setLayerVisible(map, 'heat', toggleState('t-heat')));
  wireToggle('t-contours', () => {
    const on = toggleState('t-contours');
    setLayerVisible(map, 'contours-minor', on);
    setLayerVisible(map, 'contours-major', on);
  });
  wireToggle('t-underlay', () => setLayerVisible(map, 'osm-underlay', toggleState('t-underlay')));

  // The underlay needs the internet and may be refused. Drop it without fuss,
  // as the spec asks, rather than showing the player a tile error.
  map.on('error', (event) => {
    const url = event?.error?.url || '';
    if (url.includes('tile.openstreetmap.org')) {
      setLayerVisible(map, 'osm-underlay', false);
      const button = document.getElementById('t-underlay');
      if (button) { button.classList.remove('on'); button.disabled = true; }
      return;
    }
    console.warn('map error:', event?.error || event);
  });
}

function wireToggle(id, onChange) {
  const button = document.getElementById(id);
  if (!button) return;
  button.addEventListener('click', () => {
    button.classList.toggle('on');
    onChange();
  });
}

function toggleState(id) {
  return document.getElementById(id).classList.contains('on');
}
