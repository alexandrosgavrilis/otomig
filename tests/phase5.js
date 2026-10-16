/**
 * Phase 5 logic tests: loans, the fare slider, the ledger, Creative's endless
 * money, and the play-testing tuning module.
 *
 * The acceptance criteria are marked ACCEPTANCE:. One of them — "Hard on a
 * small island supports a bus line or two and little more" — is only half
 * provable in code: what Hard can AFFORD is asserted here; whether a bus line
 * or two then pays its way was measured on a real island and is recorded in
 * HANDOFF.md §14, because on the current numbers it does not.
 *
 * Imported by tests/run.js; `check` and `near` are passed in.
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import {
  CLOCK, COSTS, DEMAND, ROUTING, DIFFICULTY, INCOME, LOANS, baselineResidents,
} from '../config.js';
import { reviveRegion } from '../model/region.js';
import { Game } from '../sim/game.js';
import { Economy, CATEGORIES, monthlyPayment } from '../sim/economy.js';
import { fareFactor } from '../sim/demand.js';
import {
  TUNABLES, setTunable, readPath, defaultOf, overrides, resetAll, applyOverrides,
  exportText, loadSaved, saveCurrent, STORAGE_KEY, resolvePath, readout,
} from '../sim/tuning.js';

const fixturePath = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'test-region.json');
const fixtureText = readFileSync(fixturePath, 'utf8');

function newGame(difficulty = 'creative', season = 'urban') {
  const region = reviveRegion(JSON.parse(fixtureText));
  region.meta.difficulty = difficulty;
  region.meta.season = season;
  return new Game(region);
}

const at = (game, x, y) => game.frame.toLonLat(x, y);

function buildLine(game, points, mode = 'bus') {
  game.startLine(mode);
  for (const [x, y] of points) game.extendDraft(...at(game, x, y));
  return game.finishDraft();
}

/** Run until the calendar has rolled over `count` months. */
function runMonths(game, count) {
  game.clock.setSpeedIndex(3);
  const step = CLOCK.TICK_MS / 1000;
  let rolled = 0;
  let month = game.clock.month;
  while (rolled < count) {
    game.tick(step);
    if (game.clock.month !== month) { month = game.clock.month; rolled++; }
  }
}

const sum = (ledger) => Object.values(ledger).reduce((a, b) => a + b, 0);

export function runPhase5Tests(check, near) {
  // ─── The annuity ────────────────────────────────────────────────────────
  {
    // A textbook figure: €100,000 over 12 months at 6% a year is €8,606.64.
    near('a loan instalment is the ordinary annuity', monthlyPayment(100000, 0.06, 12),
      8606.64, 0.01);
    near('…and with no interest it is simply the amount over the months',
      monthlyPayment(1200, 0, 12), 100, 1e-9);
  }

  // ─── Loans ──────────────────────────────────────────────────────────────
  {
    const economy = new Economy('normal', 100000);
    const capital = economy.startingCapital;
    const offers = LOANS.map(({ slot }) => economy.loanOffer(slot));
    check('three loan slots, sized 20/50/100% of starting capital',
      offers.length === 3 && offers.map((o) => o.amount / capital).join() === '0.2,0.5,1');

    const before = economy.balance;
    const taken = economy.takeLoan('small');
    check('taking a loan works on Normal', taken.ok);
    near('…and credits its amount', economy.balance - before, offers[0].amount, 1e-6);
    near('…booked under loans, so the ledger still adds up',
      economy.month.loans, offers[0].amount, 1e-6);
    check('the same slot cannot be taken twice',
      economy.takeLoan('small').error === 'loanTaken');

    // No instalment in the month the money arrived.
    const afterTaking = economy.balance;
    economy.endMonth();
    near('no instalment is due at the end of the month it was taken',
      economy.balance, afterTaking, 1e-6);

    economy.endMonth();
    near('the next month-end charges one instalment',
      afterTaking - economy.balance, offers[0].payment, 1e-6);
    check('…part interest, part principal',
      economy.loanIn('small').outstanding < offers[0].amount);

    // Run the whole term out: the loan clears, and the total paid is the
    // instalment times the months, to the cent.
    const startBalance = economy.balance;
    const months = LOANS[0].termYears * 12;
    for (let i = 1; i < months; i++) economy.endMonth();
    check('a loan clears itself at the end of its term', economy.loanIn('small') === null);
    near('…having charged exactly its instalments',
      startBalance - economy.balance + offers[0].payment, offers[0].payment * months, 0.05);
    check('…and leaves no debt', economy.debt === 0);
  }

  {
    const economy = new Economy('normal', 100000);
    economy.takeLoan('medium');
    economy.endMonth(); economy.endMonth(); economy.endMonth();
    const owed = economy.loanIn('medium').outstanding;
    const before = economy.balance;
    const repaid = economy.repayLoan('medium');
    check('repaying early works', repaid.ok);
    near('…and costs exactly what is still owed, no penalty', before - economy.balance, owed, 1e-6);
    check('…freeing the slot', economy.loanIn('medium') === null && economy.loanOffer('medium'));

    economy.takeLoan('large');
    economy.balance = 10;
    check('repaying needs the money in hand',
      economy.repayLoan('large').error === 'cannotAfford' && economy.loanIn('large'));
  }

  {
    // Hard: borrowing is allowed in the red — it is the way out of the
    // game-over countdown — and instalments are owed whatever the balance.
    const economy = new Economy('hard', 10000);
    economy.balance = -50000;
    check('a loan can be taken with a negative balance', economy.takeLoan('small').ok);
    economy.balance = -1000;
    economy.endMonth(); economy.endMonth();
    check('instalments are charged even in the red', economy.balance < -1000);

    const creative = new Economy('creative', 100000);
    check('Creative has no loans',
      !creative.canBorrow && creative.takeLoan('small').error === 'noLoans');
  }

  // ─── The fare slider ────────────────────────────────────────────────────
  {
    const economy = new Economy('normal', 100000);
    check('the fare multiplier clamps to the slider range',
      economy.setFareMultiplier(5) === INCOME.FARE_MULTIPLIER_MAX &&
      economy.setFareMultiplier(0.1) === INCOME.FARE_MULTIPLIER_MIN &&
      economy.setFareMultiplier('nonsense') === INCOME.FARE_MULTIPLIER_MIN);

    const game = newGame('creative');
    buildLine(game, [[1600, 2800], [2600, 2800], [3600, 2800], [4400, 2800]]);
    game.demand.refreshIfNeeded(game.clock, game.economy.fareMultiplier);
    const rate = (g) => [...g.demand.pairRate.values()].reduce((a, b) => a + b, 0);
    const base = rate(game);
    game.economy.setFareMultiplier(2);
    game.tick(CLOCK.TICK_MS / 1000);
    near('moving the slider re-prices demand by multiplier ^ -0.3 at once',
      rate(game) / base, fareFactor(2), 1e-9);
  }

  // ─── The ledger adds up ─────────────────────────────────────────────────
  {
    const game = newGame('normal');
    const line = buildLine(game, [[1600, 2800], [2600, 2800], [3600, 2800]]);
    game.addVehicle(line);
    runMonths(game, 1);
    const start = game.economy.balance;
    game.economy.takeLoan('small');
    game.removeVehicle(line);                 // a refund
    game.addVehicle(line);                    // a purchase
    runMonths(game, 1);
    const ledger = game.economy.lastMonth;
    check('the finance panel lists every category, construction and loans included',
      CATEGORIES.includes('construction') && CATEGORIES.includes('loans') &&
      Object.keys(ledger).every((key) => CATEGORIES.includes(key)));
    near('the month\'s rows add up to the change in the balance',
      sum(ledger), game.economy.balance - start, 1e-3);
  }

  // ─── ACCEPTANCE: Creative never limits money ────────────────────────────
  {
    const game = newGame('creative');
    check('ACCEPTANCE: Creative can pay for anything', game.economy.canAfford(1e15)
      && game.economy.spend(1e15));
    const line = buildLine(game, [[1600, 2800], [2600, 2800], [3600, 2800]]);
    let bought = 0;
    while (game.addVehicle(line)) bought++;
    check('ACCEPTANCE: Creative is stopped only by the headway cap, never by money',
      line.vehicles.length === line.maxVehicles, `${bought} bought, cap ${line.maxVehicles}`);
    runMonths(game, 2);
    check('ACCEPTANCE: Creative\'s balance stays unlimited through running costs',
      game.economy.balance === Infinity && !game.economy.gameOver);

    // JSON has no Infinity: a Creative save used to come back with a null
    // balance, which only worked by accident.
    const restored = Game.fromJSON(JSON.parse(JSON.stringify(game.toJSON('k'))), game.region);
    check('ACCEPTANCE: …and still unlimited after a save and reload',
      restored.economy.balance === Infinity && restored.economy.canAfford(1e15));
  }

  // ─── ACCEPTANCE: Hard on a small place affords a bus line or two ────────
  {
    // The fixture as Countryside: a small town of ~15,000. This asserts the
    // half of the criterion that is about capital; HANDOFF.md §14 has what a
    // real island showed about running it.
    const game = newGame('hard', 'countryside');
    const capital = game.economy.startingCapital;
    const busLine = 5 * COSTS.STOP.bus + COSTS.VEHICLE.bus;
    check('ACCEPTANCE: Hard on a small place can afford two bus lines',
      capital >= 2 * busLine, `capital ${capital}, a line ${busLine}`);
    check('ACCEPTANCE: …but not a kilometre of on-street tram and its stops',
      capital < COSTS.TRACK_PER_KM.tram.onStreet + 2 * COSTS.STOP.tram + COSTS.VEHICLE.tram);
    check('ACCEPTANCE: …nor a single underground metro station',
      capital < COSTS.STOP.metro.underground);
    check('ACCEPTANCE: even the large loan does not change that',
      2 * capital < COSTS.STOP.metro.underground);
    near('Hard\'s capital comes from the profile\'s year-round population',
      capital, Math.max(DIFFICULTY.hard.capitalMin,
        DIFFICULTY.hard.capitalPerResident * baselineResidents(game.region.meta)), 1e-6);
  }

  // ─── Save and load keep the loans ───────────────────────────────────────
  {
    const game = newGame('normal');
    game.economy.takeLoan('medium');
    game.economy.endMonth(); game.economy.endMonth();
    game.economy.setFareMultiplier(1.4);
    const restored = Game.fromJSON(JSON.parse(JSON.stringify(game.toJSON('k'))), game.region);
    const a = game.economy.loanIn('medium');
    const b = restored.economy.loanIn('medium');
    check('a reload keeps the loans', Boolean(b) && b.monthsLeft === a.monthsLeft);
    near('…with what is still owed', b.outstanding, a.outstanding, 1e-6);
    near('…and the fare', restored.economy.fareMultiplier, 1.4, 1e-9);
    restored.economy.endMonth();
    game.economy.endMonth();
    near('…and the next instalment is the same either way',
      restored.economy.balance, game.economy.balance, 1e-6);
  }

  runTuningTests(check, near);
}

/** The play-testing panel's logic. Every test puts the config back after. */
function runTuningTests(check, near) {
  check('every tunable has a shipped default',
    TUNABLES.every((t) => Number.isFinite(defaultOf(resolvePath(t.path, 'normal')))));
  check('every tunable default sits inside its slider range',
    TUNABLES.every((t) => {
      const value = defaultOf(resolvePath(t.path, 'hard'));
      return value >= t.min && value <= t.max;
    }));
  check('nothing outside the list can be tuned',
    !setTunable(null, 'REGION.SIZE_KM_MAX', 99) && !setTunable(null, 'DEMAND.NOPE', 1));
  check('a non-number is refused', !setTunable(null, 'DEMAND.TRIPS_PER_RESIDENT', 'lots'));

  // Demand: a change applies on the next tick.
  {
    const game = newGame('creative');
    buildLine(game, [[1600, 2800], [2600, 2800], [3600, 2800], [4400, 2800]]);
    game.tick(CLOCK.TICK_MS / 1000);
    const rate = () => [...game.demand.pairRate.values()].reduce((a, b) => a + b, 0);
    const base = rate();
    setTunable(game, 'DEMAND.TRIPS_PER_RESIDENT', DEMAND.TRIPS_PER_RESIDENT * 2);
    game.tick(CLOCK.TICK_MS / 1000);
    near('doubling trips per resident doubles demand on the next tick', rate() / base, 2, 1e-9);
    check('the readout reports trips per day from the same table',
      readout(game).tripsPerDay > 0 && readout(game).pairs === game.demand.pairRate.size);
    resetAll(game);
    game.tick(CLOCK.TICK_MS / 1000);
    near('…and resetting puts it back', rate() / base, 1, 1e-9);
  }

  // Routing: the transfer penalty re-prices routes at once.
  {
    const game = newGame('creative');
    const east = buildLine(game, [[1600, 2800], [2600, 2800], [3400, 2800]]);
    const north = buildLine(game, [[2600, 2800], [2600, 3800], [2600, 4600]]);
    game.tick(CLOCK.TICK_MS / 1000);
    const before = game.router.route(east.stops[0], north.stops.at(-1)).seconds;
    setTunable(game, 'ROUTING.TRANSFER_PENALTY_S', ROUTING.TRANSFER_PENALTY_S + 600);
    game.tick(CLOCK.TICK_MS / 1000);
    const after = game.router.route(east.stops[0], north.stops.at(-1)).seconds;
    near('raising the transfer penalty re-prices a transferring route', after - before, 600, 1e-6);

    // Interchanges are grouped by distance; widening the walk joins stops.
    const groups = () => game.network.interchanges.size;
    const lonely = buildLine(game, [[1600, 3200], [1600, 4400]]);
    const startGroups = groups();
    setTunable(game, 'DEMAND.INTERCHANGE_M', 500);
    check('widening the interchange walk regroups stops at once', groups() > startGroups,
      `${startGroups} → ${groups()}`);
    resetAll(game);
    check('…and resetting regroups them back', groups() === startGroups && lonely);
  }

  // Patience is per difficulty and read live.
  {
    const path = resolvePath('DIFFICULTY.{difficulty}.patienceSimMinutes', 'hard');
    check('the patience slider tunes the difficulty in play', path === 'DIFFICULTY.hard.patienceSimMinutes');
    setTunable(null, path, 30);
    check('…and writes into that difficulty only',
      DIFFICULTY.hard.patienceSimMinutes === 30 && DIFFICULTY.normal.patienceSimMinutes === 15);
    check('overrides lists exactly what changed',
      JSON.stringify(overrides()) === JSON.stringify({ [path]: 30 }));
    check('the hand-back list says old → new, one per line',
      exportText() === `OTOMIG tuning — 1 changed\n${path}: 12 → 30`, exportText());
    resetAll(null);
    check('with nothing changed the list says so', /defaults/.test(exportText()));
  }

  // Persistence survives broken storage and stale paths.
  {
    const store = new Map();
    const storage = {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, value),
      removeItem: (key) => store.delete(key),
    };
    setTunable(null, 'INCOME.FARE', 2);
    saveCurrent(storage);
    check('overrides are saved', JSON.parse(store.get(STORAGE_KEY))['INCOME.FARE'] === 2);
    resetAll(null);
    saveCurrent(storage);
    check('…and the entry is removed when nothing is changed', !store.has(STORAGE_KEY));

    const applied = applyOverrides(null, { 'INCOME.FARE': 2.5, 'DEMAND.GONE_IN_A_REFACTOR': 3 });
    check('saved overrides apply, and a stale path is ignored',
      applied === 1 && readPath('INCOME.FARE') === 2.5);
    resetAll(null);

    const broken = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
    let threw = false;
    try { saveCurrent(broken); check('unreadable storage loads as no overrides', JSON.stringify(loadSaved(broken)) === '{}'); }
    catch { threw = true; }
    check('blocked storage never throws', !threw);
    check('a garbled entry loads as no overrides',
      JSON.stringify(loadSaved({ getItem: () => '{not json' })) === '{}');
  }

  check('the tuning tests leave every value at its default',
    Object.keys(overrides()).length === 0, JSON.stringify(overrides()));
}
