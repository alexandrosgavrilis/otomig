/**
 * Phase R probe: Overpass measurements.
 *
 *   Q3.1 — what does a roads-only query cost per km², and does a 5 km chunk
 *          survive once buildings (and their node recursion) are gone?
 *   Q4.3 — how many Athens buildings actually carry `building:levels`? This is
 *          the fair comparison for the tiles' mostly-default heights: if
 *          Overpass's vertical signal is a default too, nothing is lost.
 *
 * Overpass 504s transiently, so every query is retried. Node must send a
 * User-Agent or Overpass answers 406 (HANDOFF.md §4).
 *
 * Run: node tools/probe-overpass.js
 */

const ENDPOINT = 'https://overpass-api.de/api/interpreter';
const UA = 'OTOMIG/0.1 Phase R research probe (+https://github.com/alexandrosgavrilis/otomig)';

const ROADS = 'motorway|motorway_link|trunk|trunk_link|primary|primary_link|' +
  'secondary|secondary_link|tertiary|tertiary_link|unclassified|residential|' +
  'living_street|pedestrian';

/** The same centre as every other measurement in this project. */
const LON = 23.7275;
const LAT = 37.9838;

/** south,west,north,east for a box of `km` centred on the sample point. */
function bbox(km) {
  const dLat = km / 111.32 / 2;
  const dLon = km / (111.32 * Math.cos((LAT * Math.PI) / 180)) / 2;
  return `${(LAT - dLat).toFixed(5)},${(LON - dLon).toFixed(5)},` +
    `${(LAT + dLat).toFixed(5)},${(LON + dLon).toFixed(5)}`;
}

async function ask(label, query, attempts = 4) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    const started = Date.now();
    let response;
    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'User-Agent': UA, 'Content-Type': 'text/plain' },
        body: query,
        signal: AbortSignal.timeout(300000),
      });
    } catch (error) {
      console.log(`  ${label}: attempt ${attempt} ${error.message}`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
      continue;
    }

    const text = await response.text();
    const ms = Date.now() - started;
    const bytes = Buffer.byteLength(text);

    if (!response.ok) {
      console.log(`  ${label}: attempt ${attempt} HTTP ${response.status} ` +
        `after ${(ms / 1000).toFixed(1)}s`);
      await new Promise((r) => setTimeout(r, 5000 * attempt));
      continue;
    }

    let json;
    try { json = JSON.parse(text); } catch {
      console.log(`  ${label}: unparseable response (${bytes} B)`);
      return null;
    }
    return { json, bytes, ms, attempts: attempt };
  }
  console.log(`  ${label}: gave up after ${attempts} attempts`);
  return null;
}

// ── Q3.1 — roads-only payload and whether a big chunk survives ─────────────
console.log('=== Q3.1 — roads/rail/water only, no buildings, no POIs ===');
console.log('(for comparison: the full query measured 1.9 MB / 6.5 s at 1 km,');
console.log(' 7.5 MB / 18.4 s at 2 km, and 504 every time at 5 km)\n');

const roadsOnly = [];
for (const km of [1, 2, 5, 7.5]) {
  const bb = bbox(km);
  const query = `[out:json][timeout:180];
(
  way["highway"~"^(${ROADS})$"](${bb});
  way["natural"="water"](${bb});
  way["railway"="rail"](${bb});
  node["railway"~"^(station|halt)$"](${bb});
);
out body;
>;
out skel qt;`;

  const out = await ask(`${km} km`, query);
  if (!out) continue;
  const els = out.json.elements || [];
  const ways = els.filter((e) => e.type === 'way').length;
  const nodes = els.filter((e) => e.type === 'node').length;
  const mb = out.bytes / 1024 / 1024;
  roadsOnly.push({ km, mb, ms: out.ms, ways, nodes });
  console.log(`  ${String(km).padStart(4)} km box (${(km * km).toFixed(1)} km²): ` +
    `${mb.toFixed(2)} MB  ${(out.ms / 1000).toFixed(1)}s  ` +
    `${ways} ways  ${nodes} nodes  → ${(mb / (km * km)).toFixed(3)} MB/km²` +
    (out.attempts > 1 ? `  [${out.attempts} attempts]` : ''));
}

console.log('\n  extrapolated to a whole region, at the densest measured rate:');
const rate = roadsOnly.length
  ? Math.max(...roadsOnly.map((r) => r.mb / (r.km * r.km))) : 0;
for (const size of [6, 10, 15]) {
  console.log(`    ${size} km region: ${(rate * size * size).toFixed(1)} MB ` +
    `(full query: ${(1.87 * size * size).toFixed(0)} MB)`);
}

// ── Q4.3 — is `building:levels` any better than the tiles' default height? ──
console.log('\n=== Q4.3 — building:levels and height coverage in OSM itself ===');
const bb1 = bbox(1);
const tagQuery = `[out:json][timeout:180];
way["building"](${bb1});
out tags;`;

const tagsOut = await ask('building tags, 1 km', tagQuery);
if (tagsOut) {
  const ways = (tagsOut.json.elements || []).filter((e) => e.type === 'way');
  const withLevels = ways.filter((w) => w.tags?.['building:levels']);
  const withHeight = ways.filter((w) => w.tags?.height);
  const withEither = ways.filter((w) => w.tags?.['building:levels'] || w.tags?.height);

  console.log(`  ${ways.length} buildings in the 1 km box ` +
    `(${(tagsOut.bytes / 1024 / 1024).toFixed(2)} MB of tags alone)`);
  console.log(`  building:levels present: ${withLevels.length} ` +
    `(${(100 * withLevels.length / ways.length).toFixed(1)}%)`);
  console.log(`  height present:          ${withHeight.length} ` +
    `(${(100 * withHeight.length / ways.length).toFixed(1)}%)`);
  console.log(`  either:                  ${withEither.length} ` +
    `(${(100 * withEither.length / ways.length).toFixed(1)}%)`);

  const levelCounts = new Map();
  for (const w of withLevels) {
    const v = w.tags['building:levels'];
    levelCounts.set(v, (levelCounts.get(v) || 0) + 1);
  }
  console.log(`  levels histogram: ` + [...levelCounts.entries()]
    .sort((a, b) => b[1] - a[1]).slice(0, 12)
    .map(([v, n]) => `${v}×${n}`).join(' '));

  // What the current pipeline actually computes: DEFAULT_LEVELS for the rest.
  const share = withLevels.length / ways.length;
  console.log(`\n  → ${(100 * (1 - share)).toFixed(1)}% of buildings already fall back to`);
  console.log(`    POPULATION.DEFAULT_LEVELS in the current code.`);

  // Building categories, for Q2.4 / §4: how much does the category actually
  // discriminate, i.e. what share is bare `building=yes`?
  const bTags = new Map();
  for (const w of ways) {
    const v = w.tags?.building || '(none)';
    bTags.set(v, (bTags.get(v) || 0) + 1);
  }
  console.log(`\n  building=* histogram (Q2.4 — how much signal is in the category):`);
  console.log(`    ` + [...bTags.entries()].sort((a, b) => b[1] - a[1]).slice(0, 14)
    .map(([v, n]) => `${v}×${n}`).join(' '));
  const commercial = ways.filter((w) => w.tags &&
    (w.tags.shop || w.tags.office || w.tags.amenity || w.tags.tourism)).length;
  console.log(`    buildings carrying shop/office/amenity/tourism: ${commercial} ` +
    `(${(100 * commercial / ways.length).toFixed(1)}%)`);
}
