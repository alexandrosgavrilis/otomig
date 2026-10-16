/**
 * Population by profile, seasons on people, and the Overture gap-fill's
 * offline parts.
 *
 * Alex's design (Oct 16 2026): the seasonal profile the player picks says
 * what kind of place this is, which decides how many people its buildings
 * hold, and the seasonal curve moves that population rather than the trip
 * rate. See HANDOFF.md §13 and `POPULATION.PROFILE_HOUSING` in config.js.
 *
 * Imported by tests/run.js; `check` and `near` are passed in so the suites
 * report as one.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  POPULATION, SEASON_PROFILES, DIFFICULTY,
  seasonMonth, seasonalMultiplier, residentsFactor, baselineResidents,
} from '../config.js';
import { reviveRegion, squareBbox } from '../model/region.js';
import { Game } from '../sim/game.js';
import {
  tileId, parseDirectory, clipRing, unmappedTiles, tilesCovering,
} from '../data/overture.js';
import { tileToLonLat } from '../data/mvt.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const fixture = (season = 'urban', extra = {}) => {
  const region = reviveRegion(
    JSON.parse(readFileSync(join(HERE, '..', 'fixtures', 'test-region.json'), 'utf8')));
  Object.assign(region.meta, { season, ...extra });
  return region;
};
const sum = (values) => values.reduce((a, b) => a + b, 0);
const AUGUST = 7;
const JANUARY = 0;

export function runProfileTests(check, near) {
  // ─── The calendar: hemisphere and winter resorts ──────────────────────────
  {
    const north = { center: [22.7, 38.0], season: 'tourist' };
    const south = { center: [151.2, -33.9], season: 'tourist' };
    check('north of the equator, the calendar month is the curve month',
      seasonMonth(north, AUGUST) === AUGUST);
    check('south of the equator, every curve is six months out',
      seasonMonth(south, JANUARY) === 6 && seasonMonth({ ...south, season: 'urban' }, 2) === 8);
    check('a winter resort flips the tourist curve',
      seasonMonth({ ...north, seasonPeak: 'winter' }, JANUARY) === 6);
    check('…and a southern winter resort peaks in July, back where it started',
      seasonMonth({ ...south, seasonPeak: 'winter' }, 6) === 6);
    check('the winter switch only means something for Tourist',
      seasonMonth({ ...north, season: 'urban', seasonPeak: 'winter' }, 3) === 3);
    check('a northern tourist town peaks in August',
      seasonalMultiplier(north, AUGUST) === Math.max(...SEASON_PROFILES.tourist));
    check('a southern one peaks in February',
      seasonalMultiplier(south, 1) === Math.max(...SEASON_PROFILES.tourist));
  }

  // ─── How many people a profile's buildings hold ───────────────────────────
  {
    const meta = (season) => ({ season, center: [22.7, 38.0], populationTotal: 50000 });
    near('Urban is the calibration: unchanged', residentsFactor(meta('urban')), 1, 1e-12);

    const country = POPULATION.PROFILE_HOUSING.countryside;
    near('Countryside is the product of its four parts', residentsFactor(meta('countryside')),
      country.space * country.occupied * country.storeys * country.homes, 1e-12);
    check('Countryside holds well under half Urban\'s people in the same buildings',
      residentsFactor(meta('countryside')) < 0.5);

    const tourist = POPULATION.PROFILE_HOUSING.tourist;
    const permanent = tourist.space * tourist.occupied * tourist.storeys * tourist.homes;
    near('a tourist town\'s quietest month holds its permanent population',
      residentsFactor(meta('tourist')) * Math.min(...SEASON_PROFILES.tourist), permanent, 1e-12);
    check('…and its peak holds several times that',
      residentsFactor(meta('tourist')) * Math.max(...SEASON_PROFILES.tourist) > 3 * permanent);

    check('a real population total wins over the profile',
      residentsFactor({ ...meta('countryside'), populationScaled: true }) === 1);
    near('the year-round baseline is the building count times the profile',
      baselineResidents(meta('countryside')), 50000 * residentsFactor(meta('countryside')), 1e-6);
  }

  // ─── The demand model sees people, scaled ─────────────────────────────────
  {
    const urban = new Game(fixture('urban'));
    const country = new Game(fixture('countryside'));
    const raw = sum(urban.region.demand.residents);
    near('the imported grid is left as it was, so a cached region can change profile',
      sum(country.region.demand.residents), raw, 1e-6);
    // Both games start in January, so the season is in the comparison too.
    near('the same buildings hold fewer people as Countryside',
      sum(country.demand.residents) / sum(urban.demand.residents),
      (residentsFactor(country.region.meta) * seasonalMultiplier(country.region.meta, JANUARY)) /
      (residentsFactor(urban.region.meta) * seasonalMultiplier(urban.region.meta, JANUARY)), 1e-9);

    const tourist = new Game(fixture('tourist'));
    tourist.demand.scaleResidents(JANUARY);
    const winter = sum(tourist.demand.residents);
    tourist.demand.scaleResidents(AUGUST);
    const summer = sum(tourist.demand.residents);
    near('the season moves the population: a tourist town swells in August',
      summer / winter, SEASON_PROFILES.tourist[AUGUST] / SEASON_PROFILES.tourist[JANUARY], 1e-9);

    // The same region placed south of the equator peaks in the other season.
    const southern = new Game(fixture('tourist', { center: [151.2, -33.9] }));
    southern.demand.scaleResidents(AUGUST);
    check('south of the equator the same town is quiet in August',
      sum(southern.demand.residents) < winter + 1e-6);

    // The season lives in the residents now, not in the trip rate, so the
    // same catchment makes trips in proportion to the people in it.
    const line = tourist.startLine('bus');
    for (const [x, y] of [[1600, 2800], [2600, 2800], [3400, 2800]]) {
      tourist.extendDraft(...tourist.frame.toLonLat(x, y));
    }
    tourist.finishDraft();
    const rates = (month) => {
      tourist.demand.rebuild(month, 1);
      return sum([...tourist.demand.pairRate.values()]);
    };
    const catchment = () => sum([...tourist.demand.stopTotals.values()].map((t) => t.residents));
    const augustRate = rates(AUGUST);
    const augustCatchment = catchment();
    const januaryRate = rates(JANUARY);
    const januaryCatchment = catchment();
    near('trips follow the people: the rate swells exactly as the population does',
      augustRate / januaryRate, summer / winter, 1e-6);
    near('…and the stops\' catchments report the summer crowd',
      augustCatchment / januaryCatchment, summer / winter, 1e-9);
    check('the line under test was built', line.stops.length === 3);

    // Dots and money are fixed at the start from the year-round population.
    const capital = (game) => game.economy.balance;
    check('a Countryside game starts with less capital than Urban on the same buildings',
      capital(country) < capital(urban),
      `${Math.round(capital(country) / 1e6)}M vs ${Math.round(capital(urban) / 1e6)}M`);
    near('…the Normal rule: €500 per year-round resident, at least €5M',
      capital(country), Math.max(DIFFICULTY.normal.capitalMin,
        DIFFICULTY.normal.capitalPerResident * baselineResidents(country.region.meta)), 1);
  }

  // ─── Overture: PMTiles tile ids, directories, clipping, coverage ─────────
  {
    check('tile id: z0 is 0', tileId(0, 0, 0) === 0);
    check('tile ids at z1 follow the Hilbert curve',
      [tileId(1, 0, 0), tileId(1, 0, 1), tileId(1, 1, 1), tileId(1, 1, 0)].join() === '1,2,3,4');
    check('z2 starts after every lower zoom', tileId(2, 0, 0) === 5);

    // Two consecutive entries and a leaf pointer, encoded as the spec lays
    // out columns: count, id deltas, run lengths, lengths, offsets (+1, or 0
    // for "straight after the previous").
    // ids 5, 6, 10; runs 1, 1, 0; lengths 100, 50, 120; offsets 0, 100, 0.
    // Every value is under 128, so each varint is one byte.
    const entries = parseDirectory(Uint8Array.from([3, 5, 1, 4, 1, 1, 0, 100, 50, 120, 1, 0, 1]));
    check('a directory decodes its delta-encoded ids',
      entries.map((e) => e.tileId).join() === '5,6,10', JSON.stringify(entries));
    check('…an offset of 0 means straight after the previous entry',
      entries[1].offset === entries[0].offset + entries[0].length);
    check('…and a run length of 0 marks a leaf directory', entries[2].runLength === 0);

    const inside = [[10, 10], [20, 10], [20, 20], [10, 20], [10, 10]];
    check('a ring inside the tile is untouched by clipping',
      clipRing(inside, 4096).length === 5);
    const straddling = [[-100, 0], [100, 0], [100, 100], [-100, 100], [-100, 0]];
    const clipped = clipRing(straddling, 4096);
    const area = (ring) => Math.abs(ring.reduce((s, [x1, y1], i) => {
      const [x2, y2] = ring[(i + 1) % ring.length];
      return s + x1 * y2 - x2 * y1;
    }, 0) / 2);
    near('a ring over the tile edge is cut at the edge, so each half is counted once',
      area(clipped), 100 * 100, 1e-6);

    // Coverage: a tile with plenty of road and no buildings is unmapped; the
    // same tile with a building every ~15 m of road is not.
    const bbox = squareBbox(22.748, 38.012, 1);
    const [x0, y0] = tilesCovering(bbox, 14)[0];
    const [west, north] = tileToLonLat(x0, y0, 14, 0.2, 0.2, 1);
    const roadNodes = [west, north, west + 0.01, north];       // ~880 m of road
    const roads = { nodes: roadNodes, edges: [{ a: 0, b: 1, lengthM: 880, cls: 'residential' }] };
    const empty = unmappedTiles(bbox, [], roads);
    check('a tile with road and no buildings is unmapped',
      empty.unmapped.some(([x, y]) => x === x0 && y === y0));
    const housed = Array.from({ length: 60 }, (_, i) => [west + i * 0.00016, north - 0.0001]);
    const mapped = unmappedTiles(bbox, housed, roads);
    check('…and with a building every 15 m of road it counts as mapped',
      !mapped.unmapped.some(([x, y]) => x === x0 && y === y0));
    check('a tile with no road at all is left alone — open country or sea',
      empty.tiles.filter((t) => t.roadKm === 0).every((t) =>
        !empty.unmapped.some(([x, y]) => x === t.x && y === t.y)));
  }
}
