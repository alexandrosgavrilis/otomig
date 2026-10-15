/**
 * The new-game screen: find a place, place the square, pick a season and a
 * difficulty, import.
 *
 * This is the only screen that touches the public OSM services, and it follows
 * both usage policies: standard raster tiles with visible attribution and no
 * prefetching, and Nominatim search that fires on Enter only — never as you
 * type, because client-side autocomplete is expressly forbidden — at most one
 * request per second, with results cached in IndexedDB.
 */

import { REGION, NOMINATIM, SEASON_PROFILES, DIFFICULTY, ATTRIBUTION } from '../config.js';
import { squareBbox } from '../model/region.js';
import { getGeocode, putGeocode, regionKey, getRegion, putRegion, listRegions } from '../data/cache.js';
import { STRINGS } from './strings.js';

/** Enforces Nominatim's one-request-per-second limit across the whole session. */
let lastGeocodeAt = 0;

/**
 * Search for a place. Cached results never hit the network at all, which is
 * both faster and what the policy asks for.
 *
 * @param {string} query
 * @returns {Promise<Array<{name:string, lon:number, lat:number, population:number}>>}
 */
export async function searchPlace(query) {
  const trimmed = query.trim();
  if (!trimmed) return [];

  if (NOMINATIM.CACHE) {
    const cached = await getGeocode(trimmed);
    if (cached) return cached;
  }

  // Space out requests to honour the rate limit.
  const wait = NOMINATIM.MIN_INTERVAL_MS - (Date.now() - lastGeocodeAt);
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastGeocodeAt = Date.now();

  const url = new URL(NOMINATIM.ENDPOINT);
  url.searchParams.set('q', trimmed);
  url.searchParams.set('format', 'jsonv2');
  url.searchParams.set('limit', '5');
  url.searchParams.set('extratags', '1'); // Carries the `population` tag.

  const response = await fetch(url);
  if (!response.ok) throw new Error(`Nominatim HTTP ${response.status}`);
  const raw = await response.json();

  const results = raw.map((place) => ({
    name: place.display_name,
    lon: parseFloat(place.lon),
    lat: parseFloat(place.lat),
    population: parseInt(place.extratags?.population, 10) || 0,
  }));

  if (NOMINATIM.CACHE) await putGeocode(trimmed, results);
  return results;
}

/**
 * Mount the new-game screen.
 *
 * @param {HTMLElement} root
 * @param {(region: import('../model/region.js').Region) => void} onReady
 *        Called with the imported (or cached, or fixture) region.
 */
export function mountNewGame(root, onReady) {
  const state = {
    lon: 23.6,
    lat: 37.95,
    sizeKm: REGION.SIZE_KM_DEFAULT,
    season: 'urban',
    difficulty: 'normal',
    populationTotal: 0,
    placeName: '',
  };

  root.innerHTML = `
    <div class="ng">
      <div class="ng-map" id="ng-map"></div>
      <div class="ng-panel">
        <h1>${STRINGS.title}</h1>
        <p class="ng-sub">${STRINGS.newGame.subtitle}</p>

        <label class="ng-label">${STRINGS.newGame.search}</label>
        <form class="ng-search" id="ng-search-form">
          <input id="ng-search" type="search" placeholder="${STRINGS.newGame.searchPlaceholder}"
                 autocomplete="off" />
          <button type="submit">${STRINGS.newGame.searchButton}</button>
        </form>
        <div class="ng-hint">${STRINGS.newGame.searchHint}</div>
        <ul class="ng-results" id="ng-results"></ul>

        <label class="ng-label">
          ${STRINGS.newGame.size} <span id="ng-size-value">${state.sizeKm} km</span>
        </label>
        <input id="ng-size" type="range" min="${REGION.SIZE_KM_MIN}"
               max="${REGION.SIZE_KM_MAX}" step="1" value="${state.sizeKm}" />

        <label class="ng-label">${STRINGS.newGame.season}</label>
        <div class="ng-choices" id="ng-season">
          ${Object.keys(SEASON_PROFILES).map((key) => `
            <button type="button" data-value="${key}"
              class="${key === state.season ? 'on' : ''}">${STRINGS.seasons[key]}</button>
          `).join('')}
        </div>

        <label class="ng-label">${STRINGS.newGame.difficulty}</label>
        <div class="ng-choices" id="ng-difficulty">
          ${Object.entries(DIFFICULTY).map(([key, d]) => `
            <button type="button" data-value="${key}"
              class="${key === state.difficulty ? 'on' : ''}">${d.label}</button>
          `).join('')}
        </div>
        <div class="ng-hint" id="ng-difficulty-hint">${STRINGS.difficultyHints[state.difficulty]}</div>

        <button class="ng-go" id="ng-import">${STRINGS.newGame.importButton}</button>
        <div class="ng-progress" id="ng-progress" hidden>
          <div class="ng-bar"><div class="ng-bar-fill" id="ng-bar-fill"></div></div>
          <div class="ng-progress-text" id="ng-progress-text"></div>
        </div>
        <div class="ng-error" id="ng-error" hidden></div>

        <div class="ng-alt">
          <button type="button" id="ng-fixture">${STRINGS.newGame.fixtureButton}</button>
          <div class="ng-hint">${STRINGS.newGame.fixtureHint}</div>
        </div>
        <div class="ng-alt" id="ng-cached-wrap" hidden>
          <label class="ng-label">${STRINGS.newGame.cached}</label>
          <ul class="ng-results" id="ng-cached"></ul>
        </div>

        <footer class="ng-attr">${ATTRIBUTION.osm}</footer>
      </div>
    </div>
  `;

  // ─── The selection map: standard OSM tiles, attribution visible ───────────
  const map = new maplibregl.Map({
    container: 'ng-map',
    style: {
      version: 8,
      sources: {
        osm: {
          type: 'raster',
          tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'],
          tileSize: 256,
          maxzoom: 19,
          attribution: ATTRIBUTION.osm,
        },
      },
      layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
    },
    center: [state.lon, state.lat],
    zoom: 11,
    dragRotate: false,
    pitchWithRotate: false,
  });
  map.touchZoomRotate.disableRotation();
  // For the live tests, which place the square on exact coordinates rather
  // than trusting a geocoder's first result. main.js does the same for the
  // game map once it is loaded.
  window.otomigNewGame = { map };
  map.addControl(new maplibregl.AttributionControl({ compact: false }));
  map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right');

  /** The square sits at the map centre; panning the map moves the region. */
  function squareGeoJSON() {
    const [w, s, e, n] = squareBbox(state.lon, state.lat, state.sizeKm);
    return {
      type: 'FeatureCollection',
      features: [{
        type: 'Feature',
        geometry: { type: 'Polygon', coordinates: [[[w, s], [e, s], [e, n], [w, n], [w, s]]] },
        properties: {},
      }],
    };
  }

  map.on('load', () => {
    map.addSource('square', { type: 'geojson', data: squareGeoJSON() });
    map.addLayer({
      id: 'square-fill', type: 'fill', source: 'square',
      paint: { 'fill-color': '#E4463C', 'fill-opacity': 0.12 },
    });
    map.addLayer({
      id: 'square-line', type: 'line', source: 'square',
      paint: { 'line-color': '#E4463C', 'line-width': 2 },
    });
  });

  function updateSquare() {
    const source = map.getSource('square');
    if (source) source.setData(squareGeoJSON());
  }

  map.on('move', () => {
    const center = map.getCenter();
    state.lon = center.lng;
    state.lat = center.lat;
    updateSquare();
  });

  // ─── Controls ─────────────────────────────────────────────────────────────
  const $ = (id) => root.querySelector(`#${id}`);

  $('ng-size').addEventListener('input', (event) => {
    state.sizeKm = Number(event.target.value);
    $('ng-size-value').textContent = `${state.sizeKm} km`;
    updateSquare();
  });

  function wireChoices(containerId, onPick) {
    const container = $(containerId);
    container.addEventListener('click', (event) => {
      const button = event.target.closest('button[data-value]');
      if (!button) return;
      container.querySelectorAll('button').forEach((b) => b.classList.remove('on'));
      button.classList.add('on');
      onPick(button.dataset.value);
    });
  }
  wireChoices('ng-season', (value) => { state.season = value; });
  wireChoices('ng-difficulty', (value) => {
    state.difficulty = value;
    $('ng-difficulty-hint').textContent = STRINGS.difficultyHints[value];
  });

  // Search fires on submit (Enter or the button) — never while typing.
  $('ng-search-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const query = $('ng-search').value;
    const list = $('ng-results');
    list.innerHTML = `<li class="ng-muted">${STRINGS.newGame.searching}</li>`;
    try {
      const results = await searchPlace(query);
      if (!results.length) {
        list.innerHTML = `<li class="ng-muted">${STRINGS.newGame.noResults}</li>`;
        return;
      }
      list.innerHTML = '';
      for (const place of results) {
        const item = document.createElement('li');
        item.textContent = place.name;
        item.addEventListener('click', () => {
          state.placeName = place.name.split(',')[0];
          state.populationTotal = place.population;
          map.flyTo({ center: [place.lon, place.lat], zoom: 11.5 });
          list.innerHTML = '';
          $('ng-search').value = state.placeName;
        });
        list.appendChild(item);
      }
    } catch (error) {
      list.innerHTML = `<li class="ng-muted">${STRINGS.newGame.searchFailed}</li>`;
      console.warn('Nominatim search failed:', error);
    }
  });

  // ─── Import ───────────────────────────────────────────────────────────────
  function showProgress(fraction, message) {
    $('ng-progress').hidden = false;
    $('ng-bar-fill').style.width = `${Math.round(fraction * 100)}%`;
    $('ng-progress-text').textContent = message;
  }
  function showError(message) {
    $('ng-error').hidden = false;
    $('ng-error').textContent = message;
    $('ng-import').disabled = false;
  }

  $('ng-import').addEventListener('click', async () => {
    $('ng-error').hidden = true;
    $('ng-import').disabled = true;

    const key = regionKey(state.lon, state.lat, state.sizeKm);

    // A region already imported reloads instantly; we never fetch it twice.
    try {
      const cached = await getRegion(key);
      if (cached) {
        showProgress(1, STRINGS.newGame.loadedFromCache);
        cached.meta.season = state.season;
        cached.meta.difficulty = state.difficulty;
        onReady(cached);
        return;
      }
    } catch (error) {
      console.warn('region cache read failed:', error);
    }

    showProgress(0, STRINGS.newGame.starting);

    const worker = new Worker(new URL('../data/import.worker.js', import.meta.url),
      { type: 'module' });

    worker.onmessage = async (event) => {
      const message = event.data;
      if (message.type === 'progress') {
        showProgress(message.fraction, message.message);
      } else if (message.type === 'done') {
        worker.terminate();
        showProgress(1, STRINGS.newGame.saving);
        try {
          await putRegion(key, message.region);
        } catch (error) {
          console.warn('region cache write failed:', error);
        }
        onReady(message.region);
      } else if (message.type === 'error') {
        worker.terminate();
        showError(`${STRINGS.newGame.importFailed} ${message.message}`);
      }
    };
    worker.onerror = (event) => {
      worker.terminate();
      showError(`${STRINGS.newGame.importFailed} ${event.message || 'worker error'}`);
    };

    worker.postMessage({
      lon: state.lon,
      lat: state.lat,
      sizeKm: state.sizeKm,
      name: state.placeName || STRINGS.newGame.unnamed,
      season: state.season,
      difficulty: state.difficulty,
      populationTotal: state.populationTotal,
    });
  });

  // The fixture: a synthetic region, so the game is playable with no network.
  $('ng-fixture').addEventListener('click', async () => {
    $('ng-error').hidden = true;
    showProgress(0.5, STRINGS.newGame.loadingFixture);
    try {
      const response = await fetch(new URL('../fixtures/test-region.json', import.meta.url));
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const region = await response.json();
      region.meta.season = state.season;
      region.meta.difficulty = state.difficulty;
      showProgress(1, STRINGS.newGame.loadedFixture);
      onReady(region);
    } catch (error) {
      showError(`${STRINGS.newGame.fixtureFailed} ${error.message}`);
    }
  });

  // Offer anything already in the cache.
  listRegions().then((keys) => {
    if (!keys.length) return;
    $('ng-cached-wrap').hidden = false;
    const list = $('ng-cached');
    for (const key of keys) {
      const item = document.createElement('li');
      item.textContent = key;
      item.addEventListener('click', async () => {
        const region = await getRegion(key);
        if (!region) return;
        region.meta.season = state.season;
        region.meta.difficulty = state.difficulty;
        onReady(region);
      });
      list.appendChild(item);
    }
  }).catch((error) => console.warn('listing cached regions failed:', error));
}
