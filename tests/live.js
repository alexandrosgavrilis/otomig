/**
 * Live import test: the one assembly that has never run end to end.
 *
 * `npm test` covers the logic with no browser. `npm run test:browser` covers
 * rendering against the fixture, with no network. Neither has ever exercised
 * the real thing: Nominatim search → Overpass → elevation tiles → the import
 * worker → IndexedDB → a playable map.
 *
 * Phase 0 recorded that the sandbox could not reach the OSM endpoints, and
 * HANDOFF.md §1 therefore listed this as something only Alex could do. Phase R
 * disproved that — all four endpoints are reachable — so it is automatable, and
 * being automatable means it can be a regression test rather than a ritual.
 *
 * This hits live third-party services, so it is NOT part of `npm test` or
 * `npm run test:browser`. Run it deliberately:
 *
 *   npm run test:live                 (add --headed to watch it)
 *   npm run test:live -- --km 5       (default 5, the slider minimum)
 *
 * Be a good citizen: it is one import of one small region. Do not loop it.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const PORT = 4002;
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SHOTS = join(ROOT, 'tests', 'screenshots');
const BASE = `http://localhost:${PORT}`;

const argKm = process.argv.indexOf('--km');
const SIZE_KM = argKm > -1 ? Number(process.argv[argKm + 1]) : 5;
/**
 * Central Athens: every Phase R measurement is calibrated here, so the density
 * assertions below can be real numbers rather than "greater than zero".
 *
 * Deliberately a specific landmark rather than "Athens". Nominatim's first
 * result for a bare city name moves between calls, and some of those points
 * put a 5 km box mostly out to sea — which legitimately yields almost no
 * roads and made this test fail at random. Geocoding a square in the middle
 * of the city is stable.
 */
const PLACE = 'Syntagma Square, Athens';
const HEADED = process.argv.includes('--headed');
/** A dense import is minutes, and Overpass 504s transiently. Be generous. */
const IMPORT_TIMEOUT_MS = 15 * 60 * 1000;

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) { passed++; console.log(`  ok    ${name}`); return; }
  failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
  console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`);
}

async function serve() {
  const server = spawn(process.execPath, [join(ROOT, 'tools', 'serve.js'), String(PORT)],
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
const browser = await chromium.launch({ headless: !HEADED });
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

/** Every request the page makes to a third party, so the policy claims are checkable. */
const calls = [];
page.on('request', (request) => {
  const url = request.url();
  if (url.startsWith(BASE)) return;
  calls.push({ url, headers: request.headers() });
});
const pageErrors = [];
page.on('pageerror', (error) => pageErrors.push(String(error)));
page.on('console', (message) => {
  if (message.type() === 'error') pageErrors.push(message.text());
});

try {
  console.log(`\nLive import — ${PLACE}, ${SIZE_KM} km\n`);

  // ── 1. the app loads ───────────────────────────────────────────────────
  await page.goto(BASE, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#ng-import', { timeout: 30000 });
  check('new-game screen renders', true);

  // ── 2. Nominatim, live ─────────────────────────────────────────────────
  // The policy forbids autocomplete, so the app searches on submit only.
  const nominatimCalls = () => calls.filter((c) => c.url.includes('nominatim')).length;
  await page.fill('#ng-search', PLACE);
  const beforeSearch = nominatimCalls();
  await page.waitForTimeout(1500);
  // Count Nominatim only. The new-game screen shows an OSM raster preview, so
  // tile requests fire the whole time and are not a policy question.
  check('typing fires no Nominatim request (the policy forbids autocomplete)',
    nominatimCalls() === beforeSearch, `${nominatimCalls() - beforeSearch} fired`);

  await page.press('#ng-search', 'Enter');
  await page.waitForFunction(
    () => document.querySelectorAll('#ng-results li:not(.ng-muted)').length > 0,
    null, { timeout: 60000 });
  const resultCount = await page.evaluate(() =>
    document.querySelectorAll('#ng-results li:not(.ng-muted)').length);
  check('Nominatim returns live results', resultCount > 0, `${resultCount} results`);

  const nominatim = calls.filter((c) => c.url.includes('nominatim'));
  check('Nominatim was actually called', nominatim.length > 0);
  check('one search sent one Nominatim request, not several',
    nominatim.length === 1, `${nominatim.length} requests`);
  check('the search request carries a Referer (how we identify, not User-Agent)',
    Boolean(nominatim[0]?.headers.referer),
    `referer=${nominatim[0]?.headers.referer}`);

  await page.click('#ng-results li:not(.ng-muted)');

  // ── 3. set the size and go ─────────────────────────────────────────────
  await page.evaluate((km) => {
    const slider = document.getElementById('ng-size');
    slider.value = String(km);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }, SIZE_KM);
  check(`size set to ${SIZE_KM} km`,
    (await page.textContent('#ng-size-value')).includes(String(SIZE_KM)));

  await page.screenshot({ path: join(SHOTS, 'live-1-new-game.png') });

  const started = Date.now();
  await page.click('#ng-import');

  // Report progress as it happens, so a stalled import is visible rather than
  // just slow. This is also the only place the step weights get exercised.
  let lastText = '';
  const ticker = setInterval(async () => {
    try {
      const text = await page.textContent('#ng-progress-text');
      if (text && text !== lastText) {
        lastText = text;
        const fill = await page.getAttribute('#ng-bar-fill', 'style');
        console.log(`        [${((Date.now() - started) / 1000).toFixed(0)}s] ` +
          `${text}  ${fill || ''}`);
      }
    } catch { /* page navigating */ }
  }, 2000);

  // Done when main.js publishes window.otomig with a loaded map; failed when
  // the error box appears.
  const outcome = await Promise.race([
    page.waitForFunction(() => window.otomig?.map?.loaded?.() ? 'ok' : false,
      null, { timeout: IMPORT_TIMEOUT_MS }).then(() => 'ok'),
    page.waitForFunction(() => {
      const box = document.getElementById('ng-error');
      return box && !box.hidden && box.textContent ? box.textContent : false;
    }, null, { timeout: IMPORT_TIMEOUT_MS }).then((h) => h.jsonValue()),
  ]);
  clearInterval(ticker);

  const elapsed = (Date.now() - started) / 1000;
  if (outcome !== 'ok') {
    check(`import completed (failed after ${elapsed.toFixed(0)}s)`, false, String(outcome));
    throw new Error(`import failed: ${outcome}`);
  }
  console.log(`\n  import finished in ${elapsed.toFixed(0)}s\n`);
  check('import completed', true);

  // ── 4. is the region real? ─────────────────────────────────────────────
  const region = await page.evaluate(() => {
    const r = window.otomig.region;
    const sum = (a) => a.reduce((x, y) => x + y, 0);
    return {
      name: r.meta.name,
      sizeKm: r.meta.sizeKm,
      population: r.meta.populationTotal,
      roadNodes: r.roads.nodes.length / 2,
      roadEdges: r.roads.edges.length,
      railEdges: r.rail?.edges.length ?? 0,
      stations: r.stations?.length ?? 0,
      buildings: r.buildings?.length ?? 0,
      water: r.water?.length ?? 0,
      contours: r.contours?.features?.length ?? 0,
      demandCells: r.demand.cols * r.demand.rows,
      residents: sum(r.demand.residents),
      attraction: sum(r.demand.attraction),
      roadClasses: [...new Set(r.roads.edges.map((e) => e.cls))].sort(),
      heightRange: [Math.min(...r.terrain.values), Math.max(...r.terrain.values)],
      bytes: JSON.stringify(r).length,
    };
  });

  console.log('  region as imported:');
  for (const [k, v] of Object.entries(region)) {
    if (k === 'roadClasses') { console.log(`    ${k.padEnd(13)} ${v.join(', ')}`); continue; }
    console.log(`    ${k.padEnd(13)} ${typeof v === 'number' ? v.toLocaleString() : JSON.stringify(v)}`);
  }
  console.log();

  const areaKm2 = SIZE_KM * SIZE_KM;
  check('roads were imported', region.roadEdges > 100, `${region.roadEdges} edges`);
  check('roads share nodes (topology survived)',
    region.roadNodes < region.roadEdges * 2,
    `${region.roadNodes} nodes for ${region.roadEdges} edges`);
  check('several road classes present', region.roadClasses.length >= 4,
    region.roadClasses.join(','));
  check('buildings were imported', region.buildings > 1000,
    `${region.buildings} outlines`);
  check('building density is plausible for a dense city',
    region.buildings / areaKm2 > 300,
    `${Math.round(region.buildings / areaKm2)}/km²`);
  check('residents are plausible (European city 3k–30k/km²)',
    region.residents / areaKm2 > 2000 && region.residents / areaKm2 < 40000,
    `${Math.round(region.residents / areaKm2).toLocaleString()}/km²`);
  check('attraction is non-zero', region.attraction > 0);
  check('terrain decoded to sane heights (Athens: sea level to a few hundred m)',
    region.heightRange[0] > -50 && region.heightRange[1] > 20 &&
    region.heightRange[1] < 1500, JSON.stringify(region.heightRange));
  check('contours were traced', region.contours > 0, `${region.contours} features`);

  // ── 5. does it render? Sample pixels, do not trust 'load'. ─────────────
  await page.evaluate(() => {
    const [w, s, e, n] = window.otomig.region.meta.bbox;
    window.otomig.map.fitBounds([[w, s], [e, n]], { padding: 20, duration: 0 });
  });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: join(SHOTS, 'live-2-map.png') });

  // Reading the WebGL canvas directly returns black unless the map is built
  // with `preserveDrawingBuffer`, which costs performance in normal play. Go
  // through the compositor instead, exactly as tests/browser.js does — that
  // measures what the player would actually see and costs the game nothing.
  const shot = (await page.locator('#map').screenshot()).toString('base64');
  const palette = await page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = image.width;
    canvas.height = image.height;
    canvas.getContext('2d').drawImage(image, 0, 0);
    const { data } = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height);
    const counts = new Map();
    for (let i = 0; i < data.length; i += 4 * 97) {
      const key = `${data[i] >> 3},${data[i + 1] >> 3},${data[i + 2] >> 3}`;
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, shot);
  check('the map paints a real scene, not one flat colour', palette.length >= 4,
    `${palette.length} distinct colours: ${palette.slice(0, 6).map((p) => p[0]).join(' | ')}`);
  // A real city has roads over land. If land were the only thing painted, the
  // most common colour would take essentially the whole map.
  const topShare = palette[0][1] / palette.reduce((a, [, n]) => a + n, 0);
  check('roads and buildings break up the land colour',
    topShare < 0.95, `the most common colour covers ${(100 * topShare).toFixed(1)}%`);

  // ── 6. the cache — the whole point of importing once ──────────────────
  const cachedBytes = await page.evaluate(async () => {
    const estimate = await navigator.storage?.estimate?.();
    return estimate?.usage ?? 0;
  });
  console.log(`\n  IndexedDB usage after import: ` +
    `${(cachedBytes / 1048576).toFixed(1)} MB ` +
    `(region JSON is ${(region.bytes / 1048576).toFixed(1)} MB)`);

  const reloadStart = Date.now();
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#ng-cached-wrap:not([hidden]) #ng-cached li', { timeout: 30000 });
  check('the imported region is offered from cache on reload', true);

  await page.click('#ng-cached li');
  await page.waitForFunction(() => window.otomig?.map?.loaded?.(), null, { timeout: 60000 });
  const reloadSeconds = (Date.now() - reloadStart) / 1000;
  check('cached region loads without touching the network',
    reloadSeconds < 20, `took ${reloadSeconds.toFixed(1)}s`);
  console.log(`  cached reload: ${reloadSeconds.toFixed(1)}s against ` +
    `${elapsed.toFixed(0)}s for the import`);

  const reloadedResidents = await page.evaluate(() =>
    window.otomig.region.demand.residents.reduce((a, b) => a + b, 0));
  check('the cached region is identical',
    Math.abs(reloadedResidents - region.residents) < 1,
    `${Math.round(reloadedResidents)} vs ${Math.round(region.residents)}`);

  await page.screenshot({ path: join(SHOTS, 'live-3-from-cache.png') });

  // ── 7. what did we actually ask the internet for? ─────────────────────
  const byHost = new Map();
  for (const c of calls) {
    const host = new URL(c.url).host;
    byHost.set(host, (byHost.get(host) || 0) + 1);
  }
  console.log('\n  third-party requests made:');
  for (const [host, n] of [...byHost.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`    ${String(n).padStart(4)}  ${host}`);
  }
  const overpassCalls = byHost.get('overpass-api.de') || 0;
  check('Overpass was called', overpassCalls > 0, `${overpassCalls} requests`);

  // Phase Q: one request for roads/water/rail/POIs over the whole region, plus
  // one per building chunk. Retries push the real count up, and Overpass is
  // genuinely flaky, so allow headroom — the point is that it is a handful and
  // not the 9-to-36 chunk grid this replaced.
  const chunksPerSide = Math.max(1, Math.ceil(SIZE_KM / 6));
  const ideal = 1 + chunksPerSide ** 2;
  check(`Overpass requests stayed near the ideal ${ideal} for ${SIZE_KM} km`,
    overpassCalls <= ideal * 3,
    `${overpassCalls} sent, ideal ${ideal} (retries allowed)`);
  console.log(`  ideal for ${SIZE_KM} km is ${ideal} requests ` +
    `(1 main + ${chunksPerSide}x${chunksPerSide} building chunks); ` +
    `${overpassCalls} were sent`);

  check('no uncaught page errors', pageErrors.length === 0,
    pageErrors.slice(0, 3).join(' | '));
} catch (error) {
  failures.push(`threw: ${error.message}`);
  console.log(`\n  THREW  ${error.message}`);
  try { await page.screenshot({ path: join(SHOTS, 'live-failure.png') }); } catch { /* gone */ }
} finally {
  await browser.close();
  server.kill();
}

console.log(`\n${passed} passed${failures.length ? `, ${failures.length} FAILED` : ''}`);
for (const f of failures) console.log(`  - ${f}`);
console.log(`screenshots in tests/screenshots/live-*.png — look at them.`);
process.exit(failures.length ? 1 : 0);
