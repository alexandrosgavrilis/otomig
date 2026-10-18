/**
 * Money: tickets and advertising in, running costs and maintenance out.
 *
 * The scaling rule from the spec is the thing to keep straight. Live counts are
 * never scaled; anything that feeds a daily total is multiplied by
 * CLOCK.DAILY_SCALE, because one calendar day only shows 200 sim seconds of
 * operation. Tickets are counted as they are earned during the day and scaled
 * once, at the day boundary.
 *
 * Loans are the one piece of borrowed money. Taking one credits the
 * `loans` category and every instalment debits it, so the ledger's rows always
 * add up to the change in the balance — "why did my balance jump?" has an
 * answer on the panel.
 */

import { INCOME, COSTS, DIFFICULTY, CLOCK, LOANS } from '../config.js';

/**
 * The categories the finance panel reports, in display order. Construction and
 * loans are listed so the rows add up to the month's net; before Phase 5 the
 * panel left construction out and its rows did not sum to the total under them.
 */
export const CATEGORIES = [
  'tickets', 'intercity', 'advertising', 'subsidy', 'running', 'maintenance',
  'construction', 'loans',
];

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
    this.today = { firstBoardings: 0, trips: 0, intercity: 0 };
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

    /**
     * Loans taken and not yet repaid, at most one per slot.
     * @type {Array<{slot:string, amount:number, interest:number, termYears:number,
     *   payment:number, outstanding:number, monthsLeft:number, fresh:boolean}>}
     */
    this.loans = [];
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
    // Booked against construction, so the ledger still sums to the balance.
    this.credit('construction', amount);
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
   * An intercity call: one ticket per passenger aboard, in PEOPLE rather than
   * dots, since the passengers aboard are never drawn. Scaled at day end like
   * every other daily total.
   */
  recordIntercity(passengers) {
    this.today.intercity = (this.today.intercity ?? 0) + passengers;
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
    this.credit('intercity',
      (this.today.intercity ?? 0) * CLOCK.DAILY_SCALE * INCOME.FARE * this.fareMultiplier);
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

    this.today = { firstBoardings: 0, trips: 0, intercity: 0 };
  }

  /** Close out a month: pay instalments, roll the ledger, advance Hard's clock. */
  endMonth() {
    // Instalments land in the month they are paid for, before it is rolled.
    this.payInstalments();

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

  /** Set the ticket price multiplier, clamped to the slider's range. */
  setFareMultiplier(multiplier) {
    const value = Number(multiplier);
    if (!Number.isFinite(value)) return this.fareMultiplier;
    this.fareMultiplier = Math.min(INCOME.FARE_MULTIPLIER_MAX,
      Math.max(INCOME.FARE_MULTIPLIER_MIN, value));
    return this.fareMultiplier;
  }

  // ─── Loans ────────────────────────────────────────────────────────────────

  /** May this game borrow at all? Never in Creative, whose money has no end. */
  get canBorrow() {
    return !this.unlimited && Boolean(this.rules.loans);
  }

  /**
   * What a slot would lend, on what terms. Sized from the starting capital, so
   * a small island's loans are small too.
   */
  loanOffer(slot) {
    const terms = LOANS.find((loan) => loan.slot === slot);
    if (!terms || !Number.isFinite(this.startingCapital)) return null;
    const amount = Math.round(this.startingCapital * terms.fraction);
    const months = terms.termYears * 12;
    return {
      slot, amount, interest: terms.interest, termYears: terms.termYears,
      payment: monthlyPayment(amount, terms.interest, months),
    };
  }

  /** The active loan in a slot, if any. */
  loanIn(slot) {
    return this.loans.find((loan) => loan.slot === slot) || null;
  }

  /**
   * Borrow. Allowed with a negative balance — that is when a loan is most
   * needed, and on Hard it is the way out of the game-over countdown.
   * @returns {{ok:true, loan:object}|{error:string}}
   */
  takeLoan(slot) {
    if (!this.canBorrow) return { error: 'noLoans' };
    if (this.loanIn(slot)) return { error: 'loanTaken' };
    const offer = this.loanOffer(slot);
    if (!offer || offer.amount <= 0) return { error: 'noLoans' };

    const loan = {
      ...offer,
      outstanding: offer.amount,
      monthsLeft: offer.termYears * 12,
      // No instalment is due at the end of the month the money arrived in:
      // borrowing on the 29th should not cost a payment on the 30th.
      fresh: true,
    };
    this.loans.push(loan);
    this.credit('loans', offer.amount);
    return { ok: true, loan };
  }

  /**
   * Repay a loan in full, early. No penalty: the outstanding principal is all
   * that is owed, so repaying early simply saves the interest still to come.
   * It needs the money in hand, like anything else bought.
   * @returns {{ok:true, paid:number}|{error:string}}
   */
  repayLoan(slot) {
    const loan = this.loanIn(slot);
    if (!loan) return { error: 'noLoan' };
    if (this.balance < loan.outstanding) return { error: 'cannotAfford' };
    const paid = loan.outstanding;
    this.debit('loans', paid);
    this.loans = this.loans.filter((other) => other !== loan);
    return { ok: true, paid };
  }

  /**
   * The monthly instalment on every loan: interest on what is outstanding,
   * and the rest off the principal. Charged whatever the balance — a debt is
   * owed whether or not there is money for it, which is exactly what makes a
   * large loan a risk on Hard.
   */
  payInstalments() {
    for (const loan of this.loans) {
      if (loan.fresh) { loan.fresh = false; continue; }
      const interest = loan.outstanding * loan.interest / 12;
      // The last instalment clears whatever rounding has left behind.
      const payment = loan.monthsLeft <= 1
        ? loan.outstanding + interest
        : Math.min(loan.payment, loan.outstanding + interest);
      this.debit('loans', payment);
      loan.outstanding = Math.max(0, loan.outstanding + interest - payment);
      loan.monthsLeft--;
    }
    this.loans = this.loans.filter((loan) => loan.monthsLeft > 0 && loan.outstanding > 0.005);
  }

  /** Everything still owed, principal only. */
  get debt() {
    return this.loans.reduce((total, loan) => total + loan.outstanding, 0);
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
    // Track, from Phase 3 onward. A tram line's track is worth far more than
    // its stops — tens of millions a kilometre against half a million a stop —
    // so leaving it out would make trams nearly free to keep, which is exactly
    // backwards. A bus line has no track and contributes nothing here.
    for (const line of network.lines.values()) {
      if (!line.trackCost) continue;
      const isRail = line.mode === 'metro' || line.mode === 'train';
      const discount = isRail && hasOsmRail ? 1 - COSTS.OSM_RAIL_DISCOUNT : 1;
      total += line.trackCost * COSTS.MAINTENANCE_RATE * discount;
    }
    // Metro and train track, from Phase 4. It belongs to no line — it is
    // built first and lines are drawn on it — so it is charged on its own,
    // whether anything runs on it or not. Bare track still has to be kept.
    for (const track of network.tracks?.values() ?? []) {
      // Existing railways are kept by whoever owns them, never by the player.
      if (track.osm) continue;
      const discount = hasOsmRail ? 1 - COSTS.OSM_RAIL_DISCOUNT : 1;
      total += track.cost * COSTS.MAINTENANCE_RATE * discount;
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
      loans: this.loans,
    };
  }

  static fromJSON(data) {
    const economy = new Economy(data.difficulty, 0, data.passengersPerDot ?? 10);
    Object.assign(economy, data);
    economy.unlimited = DIFFICULTY[data.difficulty].unlimitedMoney;
    // JSON has no Infinity: Creative's balance and capital come back as null.
    if (economy.unlimited) {
      economy.balance = Infinity;
      economy.startingCapital = Infinity;
    }
    economy.loans = (data.loans || []).map((loan) => ({ ...loan }));
    economy.month = { ...blankLedger(), ...data.month };
    economy.lastMonth = { ...blankLedger(), ...data.lastMonth };
    return economy;
  }
}

/**
 * The fixed instalment that repays `amount` over `months` at an annual rate,
 * interest charged monthly on what is outstanding — an ordinary annuity.
 */
export function monthlyPayment(amount, annualRate, months) {
  if (months <= 0) return amount;
  const rate = annualRate / 12;
  if (rate === 0) return amount / months;
  return amount * rate / (1 - (1 + rate) ** -months);
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

/**
 * A count for the HUD, in the unit it has reached: 950, 12.3k, 123k, 4.5M,
 * 1.2B. One decimal below 100 of a unit. It used to be thousands always, so
 * a grown network read 100,000k (Alex, Oct 18 2026).
 */
export function formatCount(count) {
  if (Math.abs(Math.round(count)) < 1000) return String(Math.round(count));
  const units = ['k', 'M', 'B', 'T'];
  let value = count / 1000;
  for (let i = 0; i < units.length; i++) {
    const text = value.toFixed(Math.abs(value) < 100 ? 1 : 0);
    // 999.96k rounds to 1000k: that is 1.0M.
    if (Math.abs(Number(text)) < 1000 || i === units.length - 1) return `${text}${units[i]}`;
    value /= 1000;
  }
  return String(count);
}
