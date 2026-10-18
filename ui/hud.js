/**
 * The top bar: balance, date, speed, the difficulty, and the two headline
 * numbers.
 *
 * The spec's headline numbers are passengers transported (cumulative, in
 * thousands) and passengers on the network right now. The first is scaled to a
 * daily total; the second never is. Keeping them side by side makes the
 * difference between "how much work has this network done" and "how busy is it
 * this second" legible without any explanation.
 */

import { CLOCK, DIFFICULTY } from '../config.js';
import { Clock } from '../sim/clock.js';
import { formatMoney, formatThousands } from '../sim/economy.js';
import { formatDate } from '../sim/clock.js';
import { STRINGS } from './strings.js';

export function mountHud(root, game) {
  root.innerHTML = `
    <div class="topbar">
      <div class="stat" id="hud-balance-wrap">
        <b id="hud-balance">—</b><span>${STRINGS.hud.balance}</span>
      </div>
      <div class="stat" title="${STRINGS.hud.dayProgress(CLOCK.REAL_SECONDS_PER_DAY)}">
        <b id="hud-date">—</b><span id="hud-season">—</span>
        <div class="day-bar"><i id="hud-day"></i></div>
      </div>
      <div class="speeds" id="hud-speeds">
        ${CLOCK.SPEEDS.map((speed, index) => `
          <button type="button" data-speed="${index}" class="${index === 0 ? 'on' : ''}"
            title="${speed === 0 ? STRINGS.hud.paused : `${speed}×`}">
            ${speed === 0 ? '❙❙' : `${speed}×`}
          </button>`).join('')}
      </div>
      <div class="spacer"></div>
      <div class="stat difficulty" id="hud-difficulty-wrap">
        <b id="hud-difficulty">—</b><span>${STRINGS.hud.difficulty}</span>
      </div>
      <div class="spacer"></div>
      <div class="stat" title="${STRINGS.clocks.perDay}">
        <b id="hud-transported">0k</b><span>${STRINGS.hud.transported}</span>
      </div>
      <div class="stat" title="${STRINGS.clocks.live}">
        <b id="hud-onnetwork">0</b><span>${STRINGS.hud.onNetwork}</span>
      </div>
      <div class="stat" id="hud-lastmonth-wrap">
        <b id="hud-lastmonth">—</b><span>${STRINGS.hud.lastMonth}</span>
      </div>
    </div>
  `;

  const $ = (id) => root.querySelector(`#${id}`);
  const speeds = $('hud-speeds');

  speeds.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-speed]');
    if (!button) return;
    game.clock.setSpeedIndex(Number(button.dataset.speed));
    syncSpeedButtons();
  });

  function syncSpeedButtons() {
    for (const button of speeds.querySelectorAll('button')) {
      button.classList.toggle('on', Number(button.dataset.speed) === game.clock.speedIndex);
    }
  }

  function update() {
    const stats = game.stats;

    $('hud-balance').textContent = formatMoney(stats.balance);
    // Red when negative, with Hard's game-over countdown beside it.
    const negative = Number.isFinite(stats.balance) && stats.balance < 0;
    $('hud-balance-wrap').classList.toggle('negative', negative);
    const limit = game.economy.rules.gameOverMonths;
    $('hud-balance-wrap').querySelector('span').textContent =
      negative && limit
        ? `${STRINGS.hud.balance} · ${limit - stats.negativeMonths} ${STRINGS.hud.monthsLeft}`
        : STRINGS.hud.balance;

    $('hud-date').textContent = formatDate(game.clock);
    // How far through today, so a paused or slow game still shows time moving.
    $('hud-day').style.width = `${((game.clock.days % 1) * 100).toFixed(1)}%`;
    $('hud-season').textContent = STRINGS.seasons[game.region.meta.season] || '';
    const difficulty = DIFFICULTY[game.difficulty]?.label ?? game.difficulty;
    if ($('hud-difficulty').textContent !== difficulty) {
      $('hud-difficulty').textContent = difficulty;
      $('hud-difficulty-wrap').title = STRINGS.difficultyHints[game.difficulty] || '';
    }

    $('hud-transported').textContent = formatThousands(stats.transported);
    $('hud-onnetwork').textContent = stats.onNetwork.toLocaleString();

    const net = stats.lastMonthNet;
    $('hud-lastmonth').textContent = net === 0 ? '—' : formatMoney(net);
    $('hud-lastmonth-wrap').classList.toggle('negative', net < 0);

    syncSpeedButtons();
  }

  update();
  return { update, syncSpeedButtons };
}

/**
 * The legend, bottom left: what one dot is worth in this game, and which of
 * the two clocks the numbers on screen run on. The dot size is fixed for the
 * whole game, so the first line never changes; the Flows line shows only
 * while that layer is on.
 */
export function mountLegend(root, game) {
  const people = game.passengersPerDot;
  const sampleMinutes = Math.round(Clock.simSecondsPerDay / 60);
  root.innerHTML = `
    <div class="legend">
      <div class="legend-row"><span class="legend-dot"></span>
        <b>= ${people} ${people === 1 ? STRINGS.legend.person : STRINGS.legend.people}</b></div>
      <div class="legend-row legend-flows" hidden><span class="legend-arc"></span>
        <span>${STRINGS.legend.flows}</span></div>
      <div class="legend-clocks">${STRINGS.legend.clocks(sampleMinutes, CLOCK.SERVICE_HOURS_PER_DAY)}</div>
    </div>
  `;
  const flows = root.querySelector('.legend-flows');
  function update() {
    if (flows.hidden === game.showFlows) flows.hidden = !game.showFlows;
  }
  update();
  return { update };
}
