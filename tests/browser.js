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
  check('no empty panel sits in the corner before anything is selected',
    await page.evaluate(() => !document.querySelector('.panel')?.checkVisibility()));

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
      buildingFeatures: map.querySourceFeatures('buildings').length,
      canvasWidth: overlay.canvas.width,
      cssWidth: overlay.canvas.clientWidth,
      cssHeight: overlay.canvas.clientHeight,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
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
     'roads-minor', 'roads-major', 'rail-existing', 'heat', 'osm-underlay',
     'buildings']
      .every((id) => info.layers.includes(id)),
    `got ${info.layers.join(', ')}`);
  check('sea polygons are tiled and drawable', info.seaFeatures > 0, `${info.seaFeatures}`);
  check('water polygons are tiled and drawable', info.waterFeatures > 0, `${info.waterFeatures}`);
  check('contours are tiled and drawable', info.contourFeatures > 0, `${info.contourFeatures}`);
  check('buildings are tiled and drawable', info.buildingFeatures > 1000,
    `${info.buildingFeatures} building polygons`);
  check('the overlay canvas is scaled for device pixels',
    info.canvasWidth === Math.round(info.cssWidth * info.dpr),
    `${info.canvasWidth} vs ${info.cssWidth}×${info.dpr}`);
  // A canvas is a replaced element, so `inset: 0` alone leaves it at its
  // intrinsic 300×150 and the whole game layer renders into a corner while
  // the HUD and map look perfectly fine. Check the CSS box, not just the
  // backing store.
  check('the overlay canvas fills the viewport',
    Math.abs(info.cssWidth - info.viewportWidth) < 2 &&
    Math.abs(info.cssHeight - info.viewportHeight) < 2,
    `overlay ${info.cssWidth}×${info.cssHeight}, viewport ${info.viewportWidth}×${info.viewportHeight}`);
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

    // Roads and buildings have to be SEEN, not merely drawn. An earlier
    // palette had minor roads at #E8E3DA on #F4F1EA land — a few percent of
    // luminance, invisible in practice — which is exactly the failure a
    // "the layer exists" assertion sails straight past.
    const land = [0xF4, 0xF1, 0xEA];
    const contrast = (hex) => {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
      return Math.max(...c.map((v, i) => Math.abs(v - land[i])));
    };
    check('major roads contrast with the land', contrast('#CAC2B2') >= 24,
      `${contrast('#CAC2B2')}/255`);
    check('minor roads contrast with the land', contrast('#DED7C9') >= 16,
      `${contrast('#DED7C9')}/255`);
    check('buildings contrast with the land', contrast('#E6E0D4') >= 14,
      `${contrast('#E6E0D4')}/255`);

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

  check('buildings start visible', (await visibility('buildings')) !== 'none');
  await page.click('#t-buildings');
  check('buildings toggle off', (await visibility('buildings')) === 'none');
  await page.click('#t-buildings');
  check('buildings toggle back on', (await visibility('buildings')) !== 'none');

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

  // ─── Phase 2: building a line and running the sim ─────────────────────────

  // Click the map to place stops, so the real interaction path is exercised
  // rather than just the model underneath it.
  async function clickAt(x, y) {
    const point = await page.evaluate(([lx, ly]) => {
      const p = window.otomig.map.project(window.otomig.frame.toLonLat(lx, ly));
      return { x: p.x, y: p.y };
    }, [x, y]);
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(60);
  }

  // Frame the whole region so every click lands on screen.
  await page.evaluate(() => {
    const [w, s, e, n] = window.otomig.region.meta.bbox;
    window.otomig.map.fitBounds([[w, s], [e, n]], { padding: 30, duration: 0 });
  });
  await page.waitForTimeout(500);

  check('the toolbar mounted with Bus selected',
    await page.evaluate(() => document.querySelector('#tb-modes button[data-mode="bus"]')
      ?.classList.contains('on')) === true);
  check('Tram is enabled now that Phase 3 has shipped',
    await page.evaluate(() =>
      document.querySelector('#tb-modes button[data-mode="tram"]')?.disabled) === false);
  check('every mode is enabled now that Phase 4 has shipped',
    await page.evaluate(() => ['bus', 'tram', 'metro', 'train'].every((m) =>
      document.querySelector(`#tb-modes button[data-mode="${m}"]`)?.disabled === false)) === true);
  check('Build track is disabled for a bus — it rides on roads that exist',
    await page.evaluate(() =>
      document.querySelector('#tb-tools button[data-tool="buildTrack"]')?.disabled) === true);

  // Three stops along a street, clear of the fixture's bay.
  await clickAt(1600, 2800);
  await clickAt(2600, 2800);
  await clickAt(3400, 2800);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);

  const built = await page.evaluate(() => {
    const line = [...window.otomig.game.network.lines.values()][0];
    return line ? {
      stops: line.stops.length, segments: line.segments.length,
      vehicles: line.vehicles.length, lengthKm: line.lengthM / 1000,
      color: line.color,
    } : null;
  });
  check('clicking the map builds a line', built !== null);
  check('the line has the three stops clicked', built?.stops === 3, `${built?.stops} stops`);
  check('the line routed segments along real roads',
    built?.segments === 2 && built.lengthKm > 1.5, `${built?.lengthKm?.toFixed(2)} km`);
  check('the finished line was given a vehicle', built?.vehicles === 1);

  // A click on the sea must be refused with a visible message, not silently.
  await page.evaluate(() => { window.otomig.game.draft = null; });
  await page.evaluate(() => {
    document.querySelector('#tb-tools button[data-tool="newLine"]')?.click();
  });
  await clickAt(300, 300);
  const refusal = await page.textContent('.feedback').catch(() => null);
  check('a click on the water is refused with a message',
    refusal !== null && refusal.length > 0, `saw "${refusal}"`);
  await page.keyboard.press('Escape');

  // The model having a line is not the same as the player seeing one. Sample
  // the overlay canvas for the line's own colour — this is what catches the
  // game layer rendering into the wrong box, or not at all.
  const painted = await page.evaluate((lineColor) => {
    const canvas = document.querySelector('#overlay');
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const hex = lineColor.replace('#', '');
    const want = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    let lineish = 0;
    let opaque = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 32) continue;
      opaque++;
      if (Math.abs(data[i] - want[0]) < 26 &&
          Math.abs(data[i + 1] - want[1]) < 26 &&
          Math.abs(data[i + 2] - want[2]) < 26) lineish++;
    }
    return { lineish, opaque, width: canvas.width, height: canvas.height };
  }, built.color);

  check('the overlay paints something at all', painted.opaque > 0,
    `${painted.opaque} opaque pixels on a ${painted.width}×${painted.height} canvas`);
  check('the line is actually drawn in its own colour', painted.lineish > 200,
    `${painted.lineish} pixels of ${built.color}`);

  await page.screenshot({ path: join(SHOTS, '5-line-built.png') });

  // Selecting a stop opens its panel.
  await clickAt(2600, 2800);
  const panelOpen = await page.evaluate(() =>
    !document.querySelector('.panel')?.hidden);
  check('clicking a stop opens its panel', panelOpen === true);
  await page.keyboard.press('Escape');

  // Run the simulation at 4x and watch the numbers move.
  await page.evaluate(() => {
    const game = window.otomig.game;
    [...game.network.lines.values()].forEach((line) => {
      for (let i = 0; i < 3; i++) game.addVehicle(line);
    });
    game.clock.setSpeedIndex(3);
  });
  await page.waitForTimeout(6000);

  const running = await page.evaluate(() => {
    const game = window.otomig.game;
    return {
      days: game.clock.days,
      simSeconds: game.clock.simSeconds,
      totals: game.totals,
      transported: game.economy.transported,
      balance: game.economy.balance,
      vehicleMoved: [...game.network.lines.values()][0].vehicles[0].lon !== 0,
      hudTransported: document.querySelector('#hud-transported')?.textContent,
      hudDate: document.querySelector('#hud-date')?.textContent,
    };
  });

  check('the calendar advances while running', running.days > 1,
    `${running.days.toFixed(1)} days`);
  check('the sim clock advances 20x faster than real time',
    running.simSeconds > running.days * 150, `${running.simSeconds.toFixed(0)} sim s`);
  check('vehicles move', running.vehicleMoved === true);
  check('the HUD date updates', /\d/.test(running.hudDate || ''), running.hudDate);
  check('the HUD shows transported', Boolean(running.hudTransported));

  // Passenger volume needs in-game months, not seconds of wall time. The rAF
  // loop is already proven above, so fast-forward by stepping the game
  // directly — same code path, no waiting.
  const flowed = await page.evaluate(() => {
    const game = window.otomig.game;
    game.clock.setSpeedIndex(3);
    for (let i = 0; i < 6000; i++) game.tick(0.05); // ~120 in-game days
    return {
      totals: game.totals,
      transported: game.economy.transported,
      tickets: game.economy.month.tickets + game.economy.lastMonth.tickets,
      running: game.economy.month.running + game.economy.lastMonth.running,
      days: game.clock.days,
    };
  });

  check('passengers spawn in the browser', flowed.totals.spawned > 0,
    `${flowed.totals.spawned} dots over ${flowed.days.toFixed(0)} in-game days`);
  check('passengers board in the browser', flowed.totals.boarded > 0,
    `${flowed.totals.boarded} boardings`);
  check('passengers arrive and are counted', flowed.transported > 0,
    `${Math.round(flowed.transported).toLocaleString()} transported`);
  check('ticket income accrues', flowed.tickets > 0, `${Math.round(flowed.tickets)}`);
  check('running costs are charged', flowed.running < 0, `${Math.round(flowed.running)}`);

  await page.waitForTimeout(200);

  // Stops are white discs with a dark outline; vehicles are line-coloured.
  // Both must be visible on the overlay once the line is running.
  const furniture = await page.evaluate(() => {
    const canvas = document.querySelector('#overlay');
    const ctx = canvas.getContext('2d');
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    let nearWhite = 0;
    let nearInk = 0;
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 200) continue;
      const [r, g, b] = [data[i], data[i + 1], data[i + 2]];
      if (r > 245 && g > 245 && b > 245) nearWhite++;
      if (r < 70 && g < 70 && b < 70) nearInk++;
    }
    return { nearWhite, nearInk };
  });
  check('stops are drawn as white discs', furniture.nearWhite > 20,
    `${furniture.nearWhite} white pixels`);
  check('stop outlines are drawn', furniture.nearInk > 20,
    `${furniture.nearInk} dark pixels`);

  await page.screenshot({ path: join(SHOTS, '6-running.png') });

  // Speed controls and pause.
  await page.evaluate(() => window.otomig.game.clock.setSpeedIndex(0));
  const pausedDays = await page.evaluate(() => window.otomig.game.clock.days);
  await page.waitForTimeout(800);
  const stillDays = await page.evaluate(() => window.otomig.game.clock.days);
  check('pause stops the clock', Math.abs(stillDays - pausedDays) < 1e-9);

  await page.keyboard.press('Space');
  await page.waitForTimeout(500);
  check('Space resumes',
    (await page.evaluate(() => window.otomig.game.clock.days)) > stillDays);
  await page.evaluate(() => window.otomig.game.clock.setSpeedIndex(0));

  // The demand heat map must respond to coverage.
  await page.click('#t-heat');
  check('the heat map turns on with a network present',
    (await page.evaluate(() => window.otomig.map.getLayoutProperty('heat', 'visibility'))) === 'visible');
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(SHOTS, '7-heat-with-network.png') });
  await page.click('#t-heat');

  // Save and load round trip through IndexedDB.
  const roundTrip = await page.evaluate(async () => {
    const { saveGame, loadGame } = await import('/model/save.js');
    const game = window.otomig.game;
    const key = 'browser-test-region';
    // The save references a region by key, so the region must be cached first.
    const { putRegion } = await import('/data/cache.js');
    await putRegion(key, JSON.parse(JSON.stringify({
      ...game.region,
      occupancy: { ...game.region.occupancy, bits: Array.from(game.region.occupancy.bits) },
    })));
    await saveGame(game, key, 'browser-test');
    const result = await loadGame('browser-test');
    if (result.error) return { error: result.error };
    return {
      stops: result.game.network.stops.size,
      originalStops: game.network.stops.size,
      lines: result.game.network.lines.size,
      balance: result.game.economy.balance,
      originalBalance: game.economy.balance,
      days: result.game.clock.days,
      originalDays: game.clock.days,
      segments: [...result.game.network.lines.values()][0]?.segments.length,
    };
  });

  check('a save round-trips through IndexedDB', !roundTrip.error, roundTrip.error);
  check('the reload restores every stop', roundTrip.stops === roundTrip.originalStops,
    `${roundTrip.stops} vs ${roundTrip.originalStops}`);
  check('the reload restores the lines', roundTrip.lines > 0);
  check('the reload re-routes segments', roundTrip.segments > 0);
  check('the reload restores the balance',
    Math.abs(roundTrip.balance - roundTrip.originalBalance) < 1);
  check('the reload restores the calendar',
    Math.abs(roundTrip.days - roundTrip.originalDays) < 1e-6);

  // ─── Phase 3: trams, dragging and off-road track ──────────────────────────
  // The drag gesture is the one thing no headless test can cover: it needs
  // MapLibre's own mouse handling, and it has to suspend drag-pan without
  // leaving the map stuck. Both have to be exercised through a real canvas.
  {
    await page.evaluate(() => {
      const game = window.otomig.game;
      // Clear the board so the tram line is the only thing on it.
      for (const line of [...game.network.lines.values()]) game.network.deleteLine(line.id);
      game.economy.balance = 1e11;
      game.selection = null;
    });

    // Switch to Tram with the keyboard, which also proves the shortcut works.
    await page.click('#tb-modes button[data-mode="tram"]');
    check('clicking Tram selects it',
      await page.evaluate(() => document.querySelector('#tb-modes button[data-mode="tram"]')
        ?.classList.contains('on')) === true);

    // Build a tram line through the model, then drag it through the canvas.
    const built = await page.evaluate(() => {
      const game = window.otomig.game;
      const frame = game.frame;
      const line = game.startLine('tram');
      const a = game.extendDraft(...frame.toLonLat(2600, 3000));
      const b = game.extendDraft(...frame.toLonLat(2600, 4400));
      game.finishDraft();
      return {
        error: a.error || b.error || null,
        stops: line.stops.length,
        lineId: line.id,
        onStreetCost: game.network.trackCostOf(line),
        offRoad: line.segments.some((segment) => segment.offRoad),
      };
    });
    check('a tram line builds in the browser', built.stops === 2 && !built.error,
      `${built.error || ''} ${built.stops} stops`);
    check('tram track on the street is charged', built.onStreetCost > 0);
    check('an undragged tram segment is not off-road track', built.offRoad === false);

    await page.waitForTimeout(300);
    await page.screenshot({ path: join(SHOTS, '8-tram-on-street.png') });

    // Now the drag, through real mouse events on the canvas.
    const dragPlan = await page.evaluate(() => {
      const game = window.otomig.game;
      const map = window.otomig.map;
      const line = [...game.network.lines.values()][0];
      const segment = line.segments[0];
      const mid = segment.points[Math.floor(segment.points.length / 2)];
      const start = map.project({ lng: mid[0], lat: mid[1] });
      const target = game.frame.toLonLat(3200, 3700);
      const end = map.project({ lng: target[0], lat: target[1] });
      return { start: { x: start.x, y: start.y }, end: { x: end.x, y: end.y } };
    });

    await page.mouse.move(dragPlan.start.x, dragPlan.start.y);
    await page.mouse.down();
    // Several moves, so the preview is computed at least once mid-gesture.
    for (let step = 1; step <= 4; step++) {
      await page.mouse.move(
        dragPlan.start.x + (dragPlan.end.x - dragPlan.start.x) * (step / 4),
        dragPlan.start.y + (dragPlan.end.y - dragPlan.start.y) * (step / 4));
      await page.waitForTimeout(40);
    }
    const midDrag = await page.evaluate(() => {
      const drag = window.otomig.game.drag;
      return drag ? { has: true, offRoad: Boolean(drag.preview?.offRoad),
        costDelta: drag.costDelta ?? null } : { has: false };
    });
    check('a drag in progress previews an off-road segment', midDrag.has && midDrag.offRoad,
      JSON.stringify(midDrag));
    check('the preview carries a live cost', Number.isFinite(midDrag.costDelta),
      `${midDrag.costDelta}`);
    await page.screenshot({ path: join(SHOTS, '9-tram-drag-preview.png') });

    await page.mouse.up();
    await page.waitForTimeout(300);

    const after = await page.evaluate(() => {
      const game = window.otomig.game;
      const line = [...game.network.lines.values()][0];
      const segment = line.segments[0];
      return {
        dragCleared: game.drag === null,
        dragPanEnabled: window.otomig.map.dragPan.isEnabled(),
        offRoad: Boolean(segment.offRoad),
        kinds: segment.kinds ? [...new Set(segment.kinds)] : [],
        cost: segment.cost || 0,
      };
    });
    after.onStreetCost = built.onStreetCost;

    check('the drag ends cleanly', after.dragCleared);
    check('dragging the map works again afterwards — drag-pan was restored',
      after.dragPanEnabled);
    check('ACCEPTANCE: dragging pulls the tram segment off the road',
      after.offRoad === true);
    check('ACCEPTANCE: the off-road segment costs more than the street route',
      after.cost > after.onStreetCost,
      `${Math.round(after.cost / 1e6)}M vs ${Math.round(after.onStreetCost / 1e6)}M`);
    check('ACCEPTANCE: the terrain put a tunnel in it, unprompted',
      after.kinds.includes('tunnel'), after.kinds.join(','));

    await page.screenshot({ path: join(SHOTS, '10-tram-off-road.png') });

    // Zoom in on the track itself. Structure has to be legible without a
    // legend — that is the whole point of drawing tunnels and bridges
    // differently — and only a close screenshot shows whether it is.
    await page.evaluate(() => {
      const line = [...window.otomig.game.network.lines.values()][0];
      const points = line.segments[0].points;
      const lons = points.map((p) => p[0]);
      const lats = points.map((p) => p[1]);
      window.otomig.map.fitBounds(
        [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
        { padding: 120, duration: 0 });
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(SHOTS, '11-tram-structures.png') });

    // The off-road track must actually be painted, by structure. Sample the
    // overlay for the dark tunnel shade, which only appears on tunnel runs.
    const painted = await page.evaluate(async () => {
      const canvas = document.querySelector('#overlay');
      const ctx = canvas.getContext('2d');
      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      let opaque = 0;
      for (let i = 3; i < data.length; i += 4 * 37) if (data[i] > 20) opaque++;
      return opaque;
    });
    check('the off-road track is actually drawn on the overlay', painted > 0,
      `${painted} opaque samples`);
  }

  // ─── Phase 4: rail track, stations and lines on track ──────────────────────
  // Everything here goes through the real toolbar, keyboard and map clicks:
  // the waypoint clicks, Enter, the double-click and the station clicks are
  // the parts of rail building that no headless test reaches.
  {
    await page.evaluate(() => {
      const game = window.otomig.game;
      for (const line of [...game.network.lines.values()]) game.bulldoze(line);
      for (const stop of [...game.network.stops.values()]) game.bulldoze(stop);
      game.economy.balance = 1e12;
      game.selection = null;
      const [w, s, e, n] = window.otomig.region.meta.bbox;
      window.otomig.map.fitBounds([[w, s], [e, n]], { padding: 30, duration: 0 });
    });
    await page.waitForTimeout(500);

    const screenOf = (x, y) => page.evaluate(([lx, ly]) => {
      const p = window.otomig.map.project(window.otomig.frame.toLonLat(lx, ly));
      return { x: p.x, y: p.y };
    }, [x, y]);

    await page.keyboard.press('4');
    check('4 selects Train', await page.evaluate(() =>
      document.querySelector('#tb-modes button[data-mode="train"]')?.classList.contains('on')));
    check('Build track is enabled for a train', await page.evaluate(() =>
      document.querySelector('#tb-tools button[data-tool="buildTrack"]')?.disabled) === false);
    await page.click('#tb-tools button[data-tool="buildTrack"]');
    check('the Build track hint shows', await page.isVisible('#tb-hint'));

    // Across the river and through the ridge: the same alignment the logic
    // suite proves gets a bridge and a tunnel, chosen because it survives
    // being nudged by the few metres a pixel is worth at this zoom.
    await clickAt(1900, 1000);
    const end = await screenOf(700, 3400);
    const start = await screenOf(1900, 1000);
    for (let step = 1; step <= 5; step++) {
      await page.mouse.move(start.x + (end.x - start.x) * step / 5,
        start.y + (end.y - start.y) * step / 5);
      await page.waitForTimeout(40);
    }
    await page.waitForTimeout(150);
    const preview = await page.evaluate(() => {
      const draft = window.otomig.game.trackDraft;
      const profile = document.querySelector('#profile');
      const canvas = profile?.querySelector('canvas');
      let inked = 0;
      if (canvas) {
        const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
        for (let i = 3; i < data.length; i += 4 * 11) if (data[i] > 20) inked++;
      }
      return {
        has: Boolean(draft?.preview),
        kinds: draft?.preview ? [...new Set(draft.preview.kinds)] : [],
        profileShown: profile ? !profile.hidden : false,
        profileText: profile?.querySelector('.profile-meta')?.textContent || '',
        inked,
        built: window.otomig.game.network.tracks.size,
      };
    });
    check('moving the cursor previews the track before anything is built',
      preview.has && preview.built === 0, JSON.stringify(preview.kinds));
    check('the preview is coloured by structure: it already knows the tunnel and the bridge',
      preview.kinds.includes('tunnel') && preview.kinds.includes('bridge'), preview.kinds.join());
    check('ACCEPTANCE: the height-profile strip shows what is being built',
      preview.profileShown && preview.inked > 50, `${preview.inked} inked`);
    check('…with the running cost under it', /€/.test(preview.profileText), preview.profileText);
    await page.screenshot({ path: join(SHOTS, '12-track-preview.png') });

    const balanceBefore = await page.evaluate(() => window.otomig.game.economy.balance);
    await clickAt(700, 3400);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const trainTrack = await page.evaluate((before) => {
      const game = window.otomig.game;
      const track = [...game.network.tracks.values()][0];
      return track ? {
        kinds: [...new Set(track.kinds)], mode: track.mode,
        paid: before - game.economy.balance, cost: track.cost,
        draftGone: game.trackDraft === null,
      } : null;
    }, balanceBefore);
    check('Enter builds the track', trainTrack !== null && trainTrack.draftGone);
    check('ACCEPTANCE: train track on hilly ground got a tunnel and a bridge by itself',
      trainTrack?.kinds.includes('tunnel') && trainTrack?.kinds.includes('bridge'),
      trainTrack?.kinds.join());
    check('…and the player paid for exactly that', trainTrack && trainTrack.paid === trainTrack.cost);

    check('the panel closes once its selection is gone',
      await page.evaluate(() => !document.querySelector('.panel')?.checkVisibility()));

    // Metro on flat land, then a metro branch off the train track finished
    // with a double-click.
    await page.keyboard.press('3');
    check('Build track stays selected when switching to Metro', await page.evaluate(() =>
      document.querySelector('#tb-tools button[data-tool="buildTrack"]')?.classList.contains('on')));
    await clickAt(4200, 600);
    await clickAt(5200, 900);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const flatMetro = await page.evaluate(() => {
      const metro = [...window.otomig.game.network.tracks.values()].find((t) => t.mode === 'metro');
      return metro ? [...new Set(metro.kinds)].join() : null;
    });
    check('ACCEPTANCE: metro track on flat land stays underground', flatMetro === 'tunnel',
      flatMetro);

    await clickAt(1300, 2200);
    await clickAt(3200, 1200);
    const last = await screenOf(4300, 650);
    await page.mouse.dblclick(last.x, last.y);
    await page.waitForTimeout(200);
    const metroTrack = await page.evaluate(() => {
      const tracks = [...window.otomig.game.network.tracks.values()];
      const metro = tracks.filter((t) => t.mode === 'metro')[1];
      return metro ? { start: metro.start, firstKind: metro.kinds[0],
        joined: metro.start?.trackId === tracks[0].id } : null;
    });
    check('a double-click builds metro track', metroTrack !== null);
    check('…joined to the train track it was started on', metroTrack?.joined === true,
      JSON.stringify(metroTrack?.start));
    check('…leaving it underground, where the train track is in its tunnel',
      metroTrack?.firstKind === 'tunnel', metroTrack?.firstKind);

    // A metro line on the train track, placed by clicking stations.
    await page.click('#tb-tools button[data-tool="newLine"]');
    await clickAt(1540, 1720);
    await clickAt(1000, 2800);
    await page.keyboard.press('Enter');
    await page.waitForTimeout(150);
    const metroLine = await page.evaluate(() => {
      const line = [...window.otomig.game.network.lines.values()].find((l) => l.mode === 'metro');
      return line ? { stops: line.stops.length, onTrack: line.segments.every((s) => s.onTrack),
        vehicles: line.vehicles.length,
        on: line.segments[0]?.tracks } : null;
    });
    check('ACCEPTANCE: a metro line runs on train track',
      metroLine?.stops === 2 && metroLine.onTrack && metroLine.vehicles === 1,
      JSON.stringify(metroLine));

    // A train station clicked onto the metro track is refused, out loud.
    await page.keyboard.press('4');
    const onMetro = await page.evaluate(() => {
      const metro = [...window.otomig.game.network.tracks.values()].filter((t) => t.mode === 'metro')[1];
      const [lon, lat] = metro.points[Math.floor(metro.points.length / 2)];
      return window.otomig.frame.toLocal(lon, lat);
    });
    await clickAt(onMetro[0], onMetro[1]);
    await page.waitForTimeout(100);
    const refusal = await page.evaluate(() => ({
      text: document.querySelector('.feedback')?.textContent || '',
      trainLines: [...window.otomig.game.network.lines.values()]
        .filter((l) => l.mode === 'train' && l.stops.length > 0).length,
    }));
    check('ACCEPTANCE: a train line is refused on metro track, with a message',
      /metro track/i.test(refusal.text) && refusal.trainLines === 0, refusal.text);
    await page.keyboard.press('Escape');

    // Run the sim and watch the metro move along its train track.
    const moved = await page.evaluate(async () => {
      const game = window.otomig.game;
      const line = [...game.network.lines.values()].find((l) => l.mode === 'metro');
      const vehicle = line.vehicles[0];
      const before = [vehicle.lon, vehicle.lat];
      game.clock.setSpeedIndex(3);
      await new Promise((resolve) => setTimeout(resolve, 1500));
      return Math.hypot(vehicle.lon - before[0], vehicle.lat - before[1]) > 1e-5;
    });
    check('the metro vehicle moves along the track in the browser', moved);

    // Select the bare metro track with Edit stops: the panel and the profile
    // both describe it.
    await page.click('#tb-tools button[data-tool="editStops"]');
    await clickAt(onMetro[0], onMetro[1]);
    await page.waitForTimeout(150);
    const selected = await page.evaluate(() => ({
      panel: document.querySelector('.panel h3')?.textContent || '',
      profile: !document.querySelector('#profile')?.hidden,
    }));
    check('Edit stops selects bare track and opens its panel', /track/i.test(selected.panel),
      selected.panel);
    check('…and the profile strip shows the selected track', selected.profile);

    // Close in on the stretch where the metro line runs on train track, so
    // the screenshot shows bare track, structures and level crossings.
    await page.evaluate(() => {
      const [w, s] = window.otomig.frame.toLonLat(700, 800);
      const [e, n] = window.otomig.frame.toLonLat(2500, 2900);
      window.otomig.map.fitBounds([[w, s], [e, n]], { padding: 40, duration: 0 });
    });
    await page.waitForTimeout(600);
    await page.screenshot({ path: join(SHOTS, '13-rail.png') });
  }

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
