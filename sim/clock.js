/**
 * The two clocks, Cities: Skylines style.
 *
 * Vehicles and passengers move on the SIM clock at true speeds. Money, seasons,
 * loans and satisfaction recovery run on the CALENDAR clock, which is far
 * faster. They are deliberately decoupled: a calendar day passes in 10 real
 * seconds, which shows only 200 sim seconds of operation.
 *
 * Those 200 sim seconds are treated as a true-rate sample of a typical moment
 * in the day. So anything that feeds a daily total — tickets, advertising,
 * passengers transported — is multiplied by `CLOCK.DAILY_SCALE` (324). Live
 * counts, meaning passengers waiting or on board right now, are never scaled.
 * Getting this backwards is the easiest way to make the economy nonsense, so
 * `scaleToDaily` exists to make the intent explicit at every call site.
 */

import { CLOCK } from '../config.js';

export class Clock {
  constructor() {
    /** Index into CLOCK.SPEEDS. Starts paused so the player can look around. */
    this.speedIndex = 0;
    /** Total elapsed sim seconds. Drives all movement. */
    this.simSeconds = 0;
    /** Fractional calendar days elapsed since the start. */
    this.days = 0;

    this.year = 2026;
    /** 0-11. Indexes the seasonal profile. */
    this.month = 0;
    /** 1-based day within the month, for display. */
    this.dayOfMonth = 1;

    /** Set for one tick when the calendar rolls over. Consumers read and act. */
    this.dayTicked = false;
    this.monthTicked = false;
  }

  get speed() { return CLOCK.SPEEDS[this.speedIndex]; }
  get paused() { return this.speed === 0; }

  setSpeedIndex(index) {
    this.speedIndex = Math.max(0, Math.min(CLOCK.SPEEDS.length - 1, index));
  }

  /** Space toggles between paused and the last running speed. */
  togglePause() {
    if (this.paused) this.setSpeedIndex(this.lastRunningIndex || 1);
    else { this.lastRunningIndex = this.speedIndex; this.setSpeedIndex(0); }
  }

  /**
   * Advance both clocks by a real-time step.
   *
   * @param {number} realSeconds wall-clock seconds since the last tick
   * @returns {number} sim seconds elapsed, which is what movement integrates
   */
  advance(realSeconds) {
    this.dayTicked = false;
    this.monthTicked = false;
    if (this.paused) return 0;

    const scaled = realSeconds * this.speed;
    const simSeconds = scaled * CLOCK.SIM_SECONDS_PER_REAL_SECOND;
    this.simSeconds += simSeconds;

    const previousDay = Math.floor(this.days);
    this.days += scaled / CLOCK.REAL_SECONDS_PER_DAY;
    const wholeDays = Math.floor(this.days) - previousDay;

    for (let i = 0; i < wholeDays; i++) this.rollDay();
    return simSeconds;
  }

  /** Advance the calendar by one day, rolling months and years. */
  rollDay() {
    this.dayTicked = true;
    this.dayOfMonth++;
    if (this.dayOfMonth > daysInMonth(this.year, this.month)) {
      this.dayOfMonth = 1;
      this.month++;
      this.monthTicked = true;
      if (this.month > 11) { this.month = 0; this.year++; }
    }
  }

  /**
   * Scale a count observed over `simSeconds` of operation into a daily total.
   *
   * Everything the finance panel and the transported counter report goes
   * through here. Live counts must not.
   */
  static scaleToDaily(count) {
    return count * CLOCK.DAILY_SCALE;
  }

  /** Fraction of a sim day one sim second represents, for per-second rates. */
  static get simSecondsPerDay() {
    return CLOCK.SIM_SECONDS_PER_REAL_SECOND * CLOCK.REAL_SECONDS_PER_DAY;
  }

  toJSON() {
    return {
      speedIndex: this.speedIndex, simSeconds: this.simSeconds, days: this.days,
      year: this.year, month: this.month, dayOfMonth: this.dayOfMonth,
    };
  }

  static fromJSON(data) {
    const clock = new Clock();
    Object.assign(clock, data);
    // Always resume paused: dropping back into a running sim is disorienting.
    clock.speedIndex = 0;
    return clock;
  }
}

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

export function daysInMonth(year, month) {
  if (month === 1 && isLeapYear(year)) return 29;
  return MONTH_LENGTHS[month];
}

function isLeapYear(year) {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

export function monthName(month) {
  return MONTH_NAMES[month];
}

/** "14 March 2026" — the top bar's date. */
export function formatDate(clock) {
  return `${clock.dayOfMonth} ${MONTH_NAMES[clock.month]} ${clock.year}`;
}
