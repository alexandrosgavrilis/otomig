/**
 * Import a real region through the real app, once, and save it to a file.
 *
 * The point is to pay Overpass once and then test against real data as often
 * as needed, offline. The saved file has the same shape as
 * fixtures/test-region.json, so a Playwright script can serve it in the
 * fixture's place and open it with "Use the test region":
 *
 *   await page.route('**\/fixtures/test-region.json', (route) =>
 *     route.fulfill({ contentType: 'application/json', body: readFileSync(file) }));
 *
 * and the Node test code can load it with `reviveRegion(JSON.parse(...))`.
 *
 * It drives the actual new-game screen and import worker rather than calling
 * the data modules directly, so what is saved is exactly what a player gets.
 * The square is placed on exact coordinates, not a geocoder's first result —
 * see the note on stable subjects in tests/live.js.
 *
 * Phase 4 was tried this way at Kiato (HANDOFF.md §10), which found the sea
 * being imported as land.
 *
 * Run: node tools/import-region.js <lon> <lat> <km> <out.json>
 *      node tools/import-region.js 22.748 38.012 5 /tmp/kiato.json
 *
 * One import of one small region. Do not loop it.
 */

import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const [lon, lat, km, out] = process.argv.slice(2);
if (!out) {
  console.error('usage: node tools/import-region.js <lon> <lat> <km> <out.json>');
  process.exit(2);
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 4003;
const BASE = `http://localhost:${PORT}`;
const TIMEOUT_MS = 15 * 60 * 1000;

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: ROOT, stdio: 'ignore' });
for (let i = 0; i < 50; i++) {
  try { if ((await fetch(BASE)).ok) break; } catch { /* not up yet */ }
  await new Promise((resolve) => setTimeout(resolve, 100));
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (error) => errors.push(String(error)));

try {
  await page.goto(BASE);
  await page.waitForFunction(() => window.otomigNewGame?.map?.loaded?.(), null, { timeout: 30000 });
  await page.evaluate(([x, y, size]) => {
    window.otomigNewGame.map.jumpTo({ center: [x, y], zoom: 11.5 });
    const slider = document.getElementById('ng-size');
    slider.value = String(size);
    slider.dispatchEvent(new Event('input', { bubbles: true }));
  }, [Number(lon), Number(lat), Number(km)]);

  const started = Date.now();
  await page.click('#ng-import');
  const ticker = setInterval(async () => {
    try {
      const text = await page.textContent('#ng-progress-text');
      console.log(`  [${Math.round((Date.now() - started) / 1000)}s] ${text}`);
    } catch { /* navigating */ }
  }, 5000);

  const outcome = await Promise.race([
    page.waitForFunction(() => window.otomig?.map?.loaded?.(), null, { timeout: TIMEOUT_MS })
      .then(() => 'ok'),
    page.waitForFunction(() => {
      const box = document.getElementById('ng-error');
      return box && !box.hidden && box.textContent;
    }, null, { timeout: TIMEOUT_MS }).then((handle) => handle.jsonValue()),
  ]);
  clearInterval(ticker);
  if (outcome !== 'ok') throw new Error(`import failed: ${outcome}`);

  const json = await page.evaluate(async () => {
    const { serialiseRegion } = await import('/model/region.js');
    return JSON.stringify(serialiseRegion(window.otomig.region));
  });
  writeFileSync(out, json);

  const region = JSON.parse(json);
  const heights = region.terrain.values;
  console.log(`
  saved ${out} (${(json.length / 1048576).toFixed(1)} MB) in ${Math.round((Date.now() - started) / 1000)} s
  road edges   ${region.roads.edges.length}
  buildings    ${region.buildings.length}
  residents    ${region.meta.populationTotal}
  from OSM     ${region.meta.buildingSources?.osm ?? '?'} buildings
  gap-filled   ${region.meta.buildingSources?.overture ?? 0} from Overture, in ${region.meta.buildingSources?.overtureTilesFilled ?? 0} tiles${region.meta.buildingSources?.overtureError ? ` (FAILED: ${region.meta.buildingSources.overtureError})` : ''}
  rail edges   ${region.rail.edges.length}, stations: ${region.stations.map((s) => s.name).join(', ') || 'none'}
  terrain      ${Math.min(...heights).toFixed(1)} … ${Math.max(...heights).toFixed(1)} m`);
} finally {
  if (errors.length) console.error('page errors:', errors);
  await browser.close();
  server.kill();
}
