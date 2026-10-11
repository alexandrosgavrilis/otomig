/**
 * Find a good region for testing Phase 4 (rail).
 *
 * Alex's point: central Athens is a bad place to test track building, because
 * "track may not cross a building" plus a dense city means almost every
 * alignment is blocked. Phase R measured the scale of that — 23.7% of Athens
 * buildings come within 3 m of a road centreline — so rail needs somewhere
 * with existing railway to connect to and room to actually draw.
 *
 * The Peloponnese is the obvious candidate, with one trap: most of its network
 * closed in 2011 and is tagged `railway=disused` or `abandoned`, which
 * `isDeadRail` in data/overpass.js correctly rejects. So "near existing rail"
 * has to mean rail that is still *tagged as rail*, not just visible on a map.
 *
 * This measures candidates on what actually matters: usable rail, building
 * density, and whether there are roads to put stops on at all.
 *
 * Run: node tools/probe-railtest.js
 */

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const UA = 'OTOMIG/0.1 Phase 4 siting probe (+https://github.com/alexandrosgavrilis/otomig)';
const BOX_KM = 5;   // REGION.SIZE_KM_MIN — the smallest region the slider allows

const CANDIDATES = [
  { name: 'Kiato (Proastiakos terminus)', lon: 22.7480, lat: 38.0120 },
  { name: 'Xylokastro', lon: 22.6300, lat: 38.0780 },
  { name: 'Diakopto (rack railway jct)', lon: 22.1990, lat: 38.1960 },
  { name: 'Aigio', lon: 22.0850, lat: 38.2480 },
  { name: 'Corinth (Korinthos)', lon: 22.9350, lat: 37.9400 },
  { name: 'Zevgolatio / plain', lon: 22.8200, lat: 37.9700 },
  // A control: the place we have been testing in, for contrast.
  { name: 'CONTROL — central Athens', lon: 23.7275, lat: 37.9838 },
];

function bbox(lon, lat, km) {
  const dLat = km / 111.32 / 2;
  const dLon = km / (111.32 * Math.cos((lat * Math.PI) / 180)) / 2;
  return `${(lat - dLat).toFixed(5)},${(lon - dLon).toFixed(5)},` +
    `${(lat + dLat).toFixed(5)},${(lon + dLon).toFixed(5)}`;
}

async function ask(query, attempts = 6) {
  for (let i = 1; i <= attempts; i++) {
    try {
      const response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'text/plain' },
        body: query,
        signal: AbortSignal.timeout(300000),
      });
      if (!response.ok) { process.stdout.write(`[${response.status}]`); await wait(4000 * i); continue; }
      const json = await response.json();
      if (json.remark) { process.stdout.write('[remark]'); await wait(4000 * i); continue; }
      return json;
    } catch { await wait(4000 * i); }
  }
  return null;
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** Mirrors isDeadRail in data/overpass.js — abandoned track is not usable track. */
function isDeadRail(tags = {}) {
  return Boolean(tags.abandoned || tags.disused || tags.razed ||
    tags['railway:abandoned'] || tags['railway:disused']);
}

console.log(`=== Phase 4 test-site survey, ${BOX_KM} km boxes ===`);
console.log(`    (${BOX_KM} km is REGION.SIZE_KM_MIN — the smallest the slider allows)\n`);
console.log('site'.padEnd(32) + 'rail'.padStart(7) + 'dead'.padStart(7) +
  'stations'.padStart(10) + 'buildings'.padStart(11) + 'bldg/km²'.padStart(10) +
  'roads'.padStart(8));
console.log('-'.repeat(85));

const area = BOX_KM * BOX_KM;
const results = [];

for (const site of CANDIDATES) {
  const bb = bbox(site.lon, site.lat, BOX_KM);
  const data = await ask(`[out:json][timeout:180];
(
  way["railway"](${bb});
  node["railway"~"^(station|halt)$"](${bb});
  way["building"](${bb});
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|unclassified|residential)$"](${bb});
);
out tags;`);

  if (!data) { console.log(`${site.name.padEnd(32)}  query failed`); continue; }
  const elements = data.elements || [];

  const railWays = elements.filter((e) => e.type === 'way' && e.tags?.railway === 'rail');
  const usable = railWays.filter((w) => !isDeadRail(w.tags));
  const dead = railWays.length - usable.length;
  const stations = elements.filter((e) => e.type === 'node' &&
    ['station', 'halt'].includes(e.tags?.railway)).length;
  const buildings = elements.filter((e) => e.type === 'way' && e.tags?.building).length;
  const roads = elements.filter((e) => e.type === 'way' && e.tags?.highway).length;

  results.push({ site, usable: usable.length, dead, stations, buildings, roads });
  console.log(
    site.name.padEnd(32) +
    String(usable.length).padStart(7) +
    String(dead).padStart(7) +
    String(stations).padStart(10) +
    String(buildings).padStart(11) +
    String(Math.round(buildings / area)).padStart(10) +
    String(roads).padStart(8));
}

console.log(`\n=== what this means for Phase 4 ===`);
const control = results.find((r) => r.site.name.startsWith('CONTROL'));
for (const r of results) {
  if (r === control) continue;
  const ratio = control ? (r.buildings / Math.max(1, control.buildings)) : NaN;
  const verdict = r.usable === 0 ? 'NO usable rail — the network here is dead-tagged'
    : r.roads === 0 ? 'no roads to put stops on'
    : r.buildings / area > 400 ? 'still fairly built up'
    : 'good: live rail, room to draw';
  console.log(`  ${r.site.name.padEnd(32)} ${verdict}` +
    (Number.isFinite(ratio) ? `  (${(100 * ratio).toFixed(0)}% of Athens's building count)` : ''));
}
