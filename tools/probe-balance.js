/**
 * Play a region headless for a year with a simple bus network, and print the
 * money month by month. The tool behind HANDOFF.md §15's balance figures.
 *
 * Stops go on the densest demand cells, at least 500 m apart; each line grows
 * greedily from the densest unused cell to the nearest one the road network
 * actually reaches (an island and the mainland across a strait have no road
 * between them). It is a crude network on purpose — the question is what the
 * numbers do, not how well a bot plays.
 *
 * Run: node tools/probe-balance.js <region.json> <season> <difficulty> <lines> <busesPerLine> [months]
 *      node tools/probe-balance.js /tmp/poros.json tourist hard 2 1
 *
 * The region is a snapshot from tools/import-region.js, or the fixture.
 * TUNE applies tuning-panel overrides by config path, comma-separated:
 *      TUNE=DIFFICULTY.hard.patienceSimMinutes=30 node tools/probe-balance.js …
 * STOPS sets stops per line (default 5).
 *
 * Offline: no network, a year in about a second.
 */

import { readFileSync } from 'node:fs';
import { CLOCK, baselineResidents } from '../config.js';
import { reviveRegion } from '../model/region.js';
import { Game } from '../sim/game.js';
import { formatMoney } from '../sim/economy.js';
import { setTunable } from '../sim/tuning.js';

const [file, season, difficulty, lineArg, busArg, monthArg] = process.argv.slice(2);
if (!busArg) {
  console.error('usage: node tools/probe-balance.js <region.json> <season> <difficulty> <lines> <busesPerLine> [months]');
  process.exit(2);
}
const lineCount = Number(lineArg);
const busesPerLine = Number(busArg);
const monthCount = Number(monthArg) || 12;
const stopsPerLine = Number(process.env.STOPS) || 5;

const region = reviveRegion(JSON.parse(readFileSync(file, 'utf8')));
region.meta.difficulty = difficulty;
region.meta.season = season;
const game = new Game(region);
for (const pair of (process.env.TUNE || '').split(',').filter(Boolean)) {
  const [path, value] = pair.split('=');
  if (!setTunable(game, path, value)) console.log(`not tunable: ${path}`);
}

// Candidate stops: the densest cells, at least 500 m apart.
const { cols, cellM } = region.demand;
const cells = [...game.demand.residents.keys()]
  .sort((a, b) => game.demand.residents[b] - game.demand.residents[a]);
const picks = [];
for (const i of cells) {
  const x = (i % cols + 0.5) * cellM;
  const y = (Math.floor(i / cols) + 0.5) * cellM;
  if (picks.every(([px, py]) => Math.hypot(px - x, py - y) >= 500)) picks.push([x, y]);
  if (picks.length >= 12 * lineCount) break;
}

console.log(`${season}/${difficulty}: year-round residents ${Math.round(baselineResidents(region.meta))}, `
  + `capital ${formatMoney(game.economy.balance)}, ${game.passengersPerDot} per dot`);

const distance = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
for (let l = 0; l < lineCount && picks.length; l++) {
  game.startLine('bus');
  let last = null;
  while (game.draft.line.stops.length < stopsPerLine && picks.length) {
    const ranked = last ? [...picks].sort((a, b) => distance(a, last) - distance(b, last)) : [...picks];
    let added = false;
    for (const pick of ranked.slice(0, 8)) {
      // Stand the stop on the nearest road, as a player would: a cell centre
      // can sit between streets, out of the stop snap's reach.
      const [lon, lat] = game.frame.toLonLat(pick[0], pick[1]);
      const road = game.roadIndex.snap(lon, lat, 'bus', 150);
      const result = road ? game.extendDraft(road.lon, road.lat) : { error: 'noRoad' };
      if (!result.error) { picks.splice(picks.indexOf(pick), 1); last = pick; added = true; break; }
      // A first stop that cannot be placed is no use to any line.
      if (!last) picks.splice(picks.indexOf(pick), 1);
    }
    if (!added) break;
  }
  const line = game.finishDraft();
  if (line) for (let i = 1; i < busesPerLine; i++) game.addVehicle(line);
}
game.demand.refreshIfNeeded(game.clock, game.economy.fareMultiplier);

const lines = [...game.network.lines.values()];
console.log(`built: ${lines.map((l) => `${l.stops.length} stops/${l.vehicles.length} bus/`
  + `${(l.lengthM / 1000).toFixed(1)} km`).join(', ')}; left ${formatMoney(game.economy.balance)}; `
  + `coverage ${Math.round(game.demand.coverageFraction() * 100)}%`);

game.clock.setSpeedIndex(3);
const step = CLOCK.TICK_MS / 1000;
const totals = { tickets: 0, subsidy: 0, running: 0, maintenance: 0 };
let month = game.clock.month;
let months = 0;
while (months < monthCount && !game.economy.gameOver) {
  game.tick(step);
  if (game.clock.month === month) continue;
  month = game.clock.month;
  months++;
  const ledger = game.economy.lastMonth;
  for (const key of Object.keys(totals)) totals[key] += ledger[key];
  console.log(`  month ${String(months).padStart(2)}  balance ${formatMoney(game.economy.balance).padStart(7)}`
    + `  net ${formatMoney(game.economy.lastMonthNet).padStart(6)}  |  tickets ${formatMoney(ledger.tickets)}`
    + `  subsidy ${formatMoney(ledger.subsidy)}  running ${formatMoney(ledger.running)}`);
}

const average = (key) => formatMoney(totals[key] / months);
const operating = (totals.tickets + totals.subsidy + totals.running + totals.maintenance) / months;
console.log(`  a month on average: tickets ${average('tickets')}, subsidy ${average('subsidy')}, `
  + `running ${average('running')}, maintenance ${average('maintenance')} → ${formatMoney(operating)}`);
console.log(`  passengers who gave up: ${game.totals.gaveUp} of ${game.totals.spawned} dots`
  + `${game.economy.gameOver ? ' — GAME OVER' : ''}`);
