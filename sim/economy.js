/**
 * Money: tickets and advertising in, running costs and maintenance out.
 *
 * The scaling rule from the spec is the thing to keep straight. Live counts are
 * never scaled; anything that feeds a daily total is multiplied by
 * CLOCK.DAILY_SCALE, because one calendar day only shows 200 sim seconds of
 * operation. Tickets are counted as they are earned during the day and scaled
 * once, at the day boundary.
 *
 * Phase 2 covers tickets, advertising, vehicle running costs and maintenance.
 * Subsidies, loans and the fare slider's full economy arrive in Phase 5; the
 * subsidy is already wired here because coverage is the one number Phase 2
 * makes meaningful.
 */

import { INCOME, COSTS, DIFFICULTY, CLOCK } from '../config.js';

/** The categories the finance panel reports, in display order. */
export const CATEGORIES = ['tickets', 'advertising', 'subsidy', 'running', 'maintenance'];

export class Economy {
  /**
   * @param {string} difficulty key into DIFFICULTY
   * @param {number} residents region population, for starting capital
   */
  constructor(difficulty, residents, passengersPerDot = 10) {
    this.difficulty = difficulty;
    /** Passengers one dot stands for. Scales with the region; see config.js. */
    this.passengersPerDot = passengersPerDot;
    const rules = DIFFICULTY[difficulty];

    this.unlimited = rules.unlimitedMoney;
    this.balance = this.unlimited ? Infinity
      : Math.max(rules.capitalMin, rules.capitalPerResident * residents);
    this.startingCapital = this.balance;

    /** Running totals for the day in progress, in raw (unscaled) counts. */
    this.today = { firstBoardings: 0, trips: 0 };
    /** Euro totals for the month in progress, by category. */
    this.month = blankLedger();
    /** Last completed month, for the top bar's "last month" figure. */
    this.lastMonth = blankLedger();
    /** Cumulative passengers transported, scaled — the headline number. */
    this.transported = 0;

    /** Consecutive whole months ended with a negative balance (Hard's clock). */
    this.negativeMonths = 0;
    this.gameOver = false;

    this.fareMultiplier = 1;
  }

  get rules() { return DIFFICULTY[this.difficulty]; }

  /** Can the player afford this, and are they allowed to spend right now? */
  canAfford(amount) {
    if (this.unlimited) return true;
    if (this.rules.blockBuildWhenNegative && this.balance < 0) return false;
    return this.balance >= amount;
  }

  /** Spend. Returns false and changes nothing when it isn't allowed. */
  spend(amount, category = 'construction') {
    if (this.unlimited) return true;
    if (!this.canAfford(amount)) return false;
    this.balance -= amount;
    this.month[category] = (this.month[category] ?? 0) - amount;
    return true;
  }

  /** Bulldozing or selling returns half, in every mode. */
  refund(constructionCost) {
    const amount = constructionCost * COSTS.REFUND_RATE;
    if (!this.unlimited) this.balance += amount;
    return amount;
  }

  /**
   * Record one tick's passenger activity. These are raw counts over the tick;
   * they are scaled to daily totals when the day rolls over.
   */
  recordTick({ firstBoardings, arrived }) {
    this.today.firstBoardings += firstBoardings;
    this.today.trips += arrived;
  }

  /**
   * Close out a calendar day: scale the day's counts into money, then charge
   * the day's share of running costs and maintenance.
   *
   * @param {import('../model/network.js').Network} network
   * @param {number} coverageFraction residents within any catchment, 0..1
   * @param {boolean} hasOsmRail drives the 25% rail maintenance discount
   */
  endDay(network, coverageFraction, hasOsmRail) {
    // Dots are the unit the simulation counts in; money is owed per person.
    const dotsToPassengers = (dots) => dots * this.passengersPerDot;

    // Tickets: one per trip, charged at first boarding. On Hard a slice of
    // riders evade the fare — but advertising is paid by everyone anyway.
    const paidBoardings = dotsToPassengers(this.today.firstBoardings) * CLOCK.DAILY_SCALE;
    const evaded = paidBoardings * this.rules.fareEvasion;
    const tickets = (paidBoardings - evaded) * INCOME.FARE * this.fareMultiplier;

    const trips = dotsToPassengers(this.today.trips) * CLOCK.DAILY_SCALE;
    const advertising = paidBoardings * INCOME.ADVERTISING_PER_TRIP;

    this.transported += trips;
    this.credit('tickets', tickets);
    this.credit('advertising', advertising);

    // Costs accrue daily; the panel reports them monthly.
    const runningPerDay = this.runningCostPerYear(network) / 365;
    const maintenancePerDay = this.maintenancePerYear(network, hasOsmRail) / 365;
    this.debit('running', runningPerDay);
    this.debit('maintenance', maintenancePerDay);

    // The state covers a share of running costs, scaled by how many residents
    // live within reach of a stop. It counts buildings, not ridership, so
    // serving a quiet village pays the same as serving a busy street — and it
    // can never exceed running costs.
    const share = this.rules.subsidyShare;
    const subsidy = Math.min(runningPerDay, runningPerDay * share * coverageFraction);
    this.credit('subsidy', subsidy);

    this.today = { firstBoardings: 0, trips: 0 };
  }

  /** Close out a month: roll the ledger and advance Hard's game-over clock. */
  endMonth() {
    this.lastMonth = this.month;
    this.month = blankLedger();

    if (this.unlimited) return;
    if (this.balance < 0) this.negativeMonths++;
    else this.negativeMonths = 0;

    const limit = this.rules.gameOverMonths;
    if (limit && this.negativeMonths >= limit) this.gameOver = true;
  }

  credit(category, amount) {
    if (!(amount > 0)) return;
    if (!this.unlimited) this.balance += amount;
    this.month[category] = (this.month[category] ?? 0) + amount;
  }

  debit(category, amount) {
    if (!(amount > 0)) return;
    if (!this.unlimited) this.balance -= amount;
    this.month[category] = (this.month[category] ?? 0) - amount;
  }

  /** Every vehicle's annual running cost. */
  runningCostPerYear(network) {
    let total = 0;
    for (const line of network.lines.values()) {
      total += line.vehicles.length * COSTS.RUNNING_PER_VEHICLE_YEAR[line.mode];
    }
    return total;
  }

  /**
   * Maintenance: a fixed fraction of construction cost per year. Rail
   * maintenance is 25% cheaper when the region has OSM railways, in every
   * difficulty — and the player never pays maintenance on the existing rail
   * itself, only on their own.
   */
  maintenancePerYear(network, hasOsmRail) {
    let total = 0;
    for (const stop of network.stops.values()) {
      const isRail = stop.mode === 'metro' || stop.mode === 'train';
      const discount = isRail && hasOsmRail ? 1 - COSTS.OSM_RAIL_DISCOUNT : 1;
      total += stop.cost * COSTS.MAINTENANCE_RATE * discount;
    }
    return total;
  }

  /** Net result for the month so far. */
  get monthNet() {
    return Object.values(this.month).reduce((a, b) => a + b, 0);
  }

  get lastMonthNet() {
    return Object.values(this.lastMonth).reduce((a, b) => a + b, 0);
  }

  toJSON() {
    return {
      difficulty: this.difficulty, passengersPerDot: this.passengersPerDot,
      balance: this.balance,
      startingCapital: this.startingCapital, today: this.today,
      month: this.month, lastMonth: this.lastMonth, transported: this.transported,
      negativeMonths: this.negativeMonths, gameOver: this.gameOver,
      fareMultiplier: this.fareMultiplier,
    };
  }

  static fromJSON(data) {
    const economy = new Economy(data.difficulty, 0, data.passengersPerDot ?? 10);
    Object.assign(economy, data);
    economy.unlimited = DIFFICULTY[data.difficulty].unlimitedMoney;
    return economy;
  }
}

function blankLedger() {
  return Object.fromEntries(CATEGORIES.map((category) => [category, 0]));
}

/** "€1.2M", "€430k", "€-5.1M" — compact money for the HUD. */
export function formatMoney(amount) {
  if (!Number.isFinite(amount)) return '∞';
  const sign = amount < 0 ? '-' : '';
  const value = Math.abs(amount);
  if (value >= 1e9) return `${sign}€${(value / 1e9).toFixed(2)}B`;
  if (value >= 1e6) return `${sign}€${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${sign}€${Math.round(value / 1e3)}k`;
  return `${sign}€${Math.round(value)}`;
}

/** Passengers transported, in thousands, as the spec's headline number. */
export function formatThousands(count) {
  return `${(count / 1000).toFixed(count < 100000 ? 1 : 0)}k`;
}
