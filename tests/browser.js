/**
 * Browser smoke test: drives the real app in Chromium via Playwright.
 *
 * `npm test` covers the logic with no browser. This covers the half that only a
 * browser can answer — does MapLibre actually render, does the module graph
 * load, does the worker start, does IndexedDB persist, does the canvas overlay
 * line up — using the fixture, so it needs no network.
 *
 * Run: npm run test:browser          (add --headed to watch it)
 * Screenshots land in tests/screenshots/.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = 4001;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'tests', 'screenshots');
const BASE = `http://localhost:${PORT}`;

let passed = 0;
const failures = [];

function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok    ${name}`); return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

/** Serve the project on PORT and wait until it answers. */
async function serve() {
  const server = spawn('python3', ['-m', 'http.server', String(PORT)],
    { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 50; i++) {
    try {
      const response = await fetch(BASE);
      if (response.ok) return server;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  server.kill();
  throw new Error(`server did not start on ${PORT}`);
}

const server = await serve();
mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

// Collect everything the page complains about. The OSM tile requests on the
// new-game screen will fail in a sandbox with no network, and that is expected,
// so network noise from known external hosts is filtered out.
const EXTERNAL = ['tile.openstreetmap.org', 'nominatim.openstreetmap.org',
  's3.amazonaws.com', 'overpass-api.de'];
const isExternal = (text) => EXTERNAL.some((host) => text.includes(host));

const consoleErrors = [];
const pageErrors = [];
/**
 * MapLibre reports a bad style through its `error` event, which main.js routes
 * to console.warn. A style validation error is fatal — the `load` event never
 * fires and the map stays blank — so these must be collected separately from
 * ordinary warnings and treated as failures.
 */
const mapErrors = [];
page.on('console', (message) => {
  const text = message.text();
  if (isExternal(text)) return;
  if (text.includes('map error')) mapErrors.push(text.split('\n')[0]);
  else if (message.type() === 'error') consoleErrors.push(text);
});
page.on('pageerror', (error) => pageErrors.push(String(error)));

try {
  // ─── New-game screen ──────────────────────────────────────────────────────
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('.ng-panel', { timeout: 10000 });

  check('new-game screen mounts', await page.isVisible('.ng-panel'));
  check('the title renders', (await page.textContent('.ng-panel h1'))?.trim() === 'OTOMIG');
  check('all four seasons are offered',
    (await page.locator('#ng-season button').count()) === 4);
  check('all four difficulties are offered',
    (await page.locator('#ng-difficulty button').count()) === 4);
  check('the size slider spans 5–15 km',
    await page.getAttribute('#ng-size', 'min') === '5' &&
    await page.getAttribute('#ng-size', 'max') === '15');

  // The policy-critical one: search must not fire while typing.
  let searchRequests = 0;
  page.on('request', (request) => {
    if (request.url().includes('nominatim')) searchRequests++;
  });
  await page.fill('#ng-search', 'Athens');
  await page.waitForTimeout(1200);
  check('typing never triggers a Nominatim request (autocomplete is forbidden)',
    searchRequests === 0, `${searchRequests} requests fired`);

  await page.screenshot({ path: join(SHOTS, '1-new-game.png') });

  // ─── Load the fixture and render the map ──────────────────────────────────
  await page.click('#ng-fixture');

  // main.js sets window.otomig once MapLibre has fired 'load'.
  await page.waitForFunction(() => window.otomig?.map?.loaded?.(), null, { timeout: 30000 });
  check('the game screen mounts and MapLibre reports loaded', true);

  const info = await page.evaluate(() => {
    const { region, map, overlay } = window.otomig;
    const style = map.getStyle();
    return {
      name: region.meta.name,
      residents: region.meta.populationTotal,
      roadEdges: region.roads.edges.length,
      layers: style.layers.map((l) => l.id),
      sources: Object.keys(style.sources),
      // querySourceFeatures reads what MapLibre actually tiled and will draw,
      // which is a stronger claim than reading back the GeoJSON we handed it.
      seaFeatures: map.querySourceFeatures('sea').length,
      waterFeatures: map.querySourceFeatures('water').length,
      contourFeatures: map.querySourceFeatures('contours').length,
      canvasWidth: overlay.canvas.width,
      cssWidth: overlay.canvas.clientWidth,
      dpr: window.devicePixelRatio,
      center: map.getCenter(),
      zoom: map.getZoom(),
    };
  });

  check('the fixture region loaded', info.name.includes('Test Region'));
  check('residents are reported', info.residents > 1000, `${info.residents}`);
  check('road edges are present', info.roadEdges > 1000, `${info.roadEdges}`);
  check('every base-map layer is in the style',
    ['background', 'sea', 'water', 'contours-minor', 'contours-major',
     'roads-minor', 'roads-major', 'rail-existing', 'heat', 'osm-underlay']
      .every((id) => info.layers.includes(id)),
    `got ${info.layers.join(', ')}`);
  check('sea polygons are tiled and drawable', info.seaFeatures > 0, `${info.seaFeatures}`);
  check('water polygons are tiled and drawable', info.waterFeatures > 0, `${info.waterFeatures}`);
  check('contours are tiled and drawable', info.contourFeatures > 0, `${info.contourFeatures}`);
  check('the overlay canvas is scaled for device pixels',
    info.canvasWidth === Math.round(info.cssWidth * info.dpr),
    `${info.canvasWidth} vs ${info.cssWidth}×${info.dpr}`);
  check('the map is centred on the region',
    Math.abs(info.center.lng - 23.6) < 0.05 && Math.abs(info.center.lat - 37.95) < 0.05,
    `${info.center.lng.toFixed(3)}, ${info.center.lat.toFixed(3)}`);

  await page.waitForTimeout(600); // Let tiles and labels settle before the shot.
  await page.screenshot({ path: join(SHOTS, '2-map.png') });

  // ─── The map actually painted something ───────────────────────────────────
  // A style can be "loaded" and still paint an empty canvas, so check the
  // pixels. Reading the WebGL canvas directly returns black unless the map is
  // built with `preserveDrawingBuffer`, which costs performance in normal play
  // — so screenshot through the compositor instead and decode that, which
  // measures what the player would actually see and costs the game nothing.
  const shot = (await page.locator('#map').screenshot()).toString('base64');
  const palette = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const counts = new Map();
    for (let i = 0; i < data.length; i += 4 * 97) { // Sparse sample; plenty.
      const key = `${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
  }, shot);
  check('the map painted several distinct colours',
    palette.length >= 3, `found ${palette.length}: ${palette.map((p) => p[0]).join(' | ')}`);
  // Land #F4F1EA is (244,241,234) → >>3 gives 30,30,29.
  check('the land colour dominates the map',
    palette[0][0] === '30,30,29', `dominant colour was ${palette[0][0]}`);
  // Water #BFD9E8 is (191,217,232) → >>3 gives 23,27,29. The fixture's bay,
  // lake and river mean water must be on screen — and the amount matters:
  // this is what caught flat zero-height land being painted as sea.
  {
    const total = palette.reduce((sum, [, count]) => sum + count, 0);
    const water = palette.find(([key]) => key === '23,27,29')?.[1] ?? 0;
    const share = water / total;
    check('water is on screen', water > 0);
    check('water covers a plausible share of the region, not a flooded valley',
      share > 0.01 && share < 0.25, `${(share * 100).toFixed(1)}% of sampled pixels`);
  }

  // ─── Toggles ──────────────────────────────────────────────────────────────
  const visibility = (id) => page.evaluate(
    (layer) => window.otomig.map.getLayoutProperty(layer, 'visibility'), id);

  check('contours start visible', (await visibility('contours-minor')) !== 'none');
  await page.click('#t-contours');
  check('contours toggle off', (await visibility('contours-minor')) === 'none');
  await page.click('#t-contours');
  check('contours toggle back on', (await visibility('contours-minor')) !== 'none');

  check('the heat map starts hidden', (await visibility('heat')) === 'none');
  await page.click('#t-heat');
  check('the heat map toggles on', (await visibility('heat')) === 'visible');
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(SHOTS, '3-heatmap.png') });
  await page.click('#t-heat');

  // ─── Pan and zoom ─────────────────────────────────────────────────────────
  const before = await page.evaluate(() => window.otomig.map.getZoom());
  await page.evaluate(() => window.otomig.map.zoomTo(window.otomig.map.getZoom() + 2.5));
  await page.waitForTimeout(900);
  const after = await page.evaluate(() => window.otomig.map.getZoom());
  check('zoom changes the map', after > before + 2, `${before.toFixed(2)} → ${after.toFixed(2)}`);
  check('minor roads appear when zoomed in',
    after >= 14 && (await visibility('roads-minor')) !== 'none');
  await page.screenshot({ path: join(SHOTS, '4-zoomed.png') });

  // maxBounds must keep the player inside the imported square.
  await page.evaluate(() => window.otomig.map.jumpTo({ center: [30, 45], zoom: 12 }));
  await page.waitForTimeout(500);
  const clamped = await page.evaluate(() => window.otomig.map.getCenter());
  check('the map is clamped to the imported region',
    Math.abs(clamped.lng - 23.6) < 0.2 && Math.abs(clamped.lat - 37.95) < 0.2,
    `drifted to ${clamped.lng.toFixed(2)}, ${clamped.lat.toFixed(2)}`);

  // ─── IndexedDB ────────────────────────────────────────────────────────────
  const dbOk = await page.evaluate(async () => {
    const { putRegion, getRegion, listRegions } = await import('/data/cache.js');
    await putRegion('smoke-test', { meta: { name: 'smoke' } });
    const back = await getRegion('smoke-test');
    const keys = await listRegions();
    return { name: back?.meta?.name, listed: keys.includes('smoke-test') };
  });
  check('IndexedDB stores and reads a region back', dbOk.name === 'smoke');
  check('IndexedDB lists cached region keys', dbOk.listed === true);

  // ─── The import worker starts and runs ────────────────────────────────────
  // The part most likely to break is the module worker resolving its whole
  // import graph — if any path is wrong it dies instantly with an onerror.
  // Reaching Overpass is not tested here and cannot be: whether it answers
  // depends on the network, so we only require that the worker boots, reports
  // progress, and stays alive rather than failing to load.
  const workerResult = await page.evaluate(() => new Promise((resolve) => {
    const worker = new Worker('/data/import.worker.js', { type: 'module' });
    const messages = [];
    const finish = (outcome, message) => {
      worker.terminate();
      resolve({ outcome, message, messages });
    };
    const timer = setTimeout(() => finish('still-working'), 8000);
    worker.onmessage = (event) => {
      messages.push(event.data.type);
      if (event.data.type === 'error' || event.data.type === 'done') {
        clearTimeout(timer);
        finish(event.data.type, event.data.message);
      }
    };
    worker.onerror = (event) => {
      clearTimeout(timer);
      finish('workererror', event.message);
    };
    worker.postMessage({ lon: 23.6, lat: 37.95, sizeKm: 5, name: 'x',
      season: 'urban', difficulty: 'normal', populationTotal: 0 });
  }));

  check('the module worker resolves its whole import graph',
    workerResult.outcome !== 'workererror',
    `worker failed to load: ${workerResult.message}`);
  check('the worker starts the import and reports progress',
    workerResult.messages.includes('progress'),
    `messages: ${workerResult.messages.join(', ') || '(none)'}`);
  check('the worker either errors cleanly or keeps working — never dies silently',
    ['error', 'done', 'still-working'].includes(workerResult.outcome),
    `outcome ${workerResult.outcome}: ${workerResult.message}`);

  // ─── Nothing threw ────────────────────────────────────────────────────────
  check('the style is valid — no MapLibre errors', mapErrors.length === 0,
    mapErrors.join(' | '));
  check('no uncaught page errors', pageErrors.length === 0, pageErrors.join(' | '));
  check('no unexpected console errors', consoleErrors.length === 0, consoleErrors.join(' | '));
} finally {
  await browser.close();
  server.kill();
}

console.log(`\nscreenshots in tests/screenshots/`);
if (failures.length) {
  console.error(`\n${failures.length} failed, ${passed} passed`);
  process.exit(1);
}
console.log(`${passed} passed`);
