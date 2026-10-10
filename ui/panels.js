/**
 * The contextual right-hand panel: line, stop, or finances.
 *
 * It re-renders from scratch on every update. The panel is small, the data is
 * already in memory, and a diffing scheme here would be more code than the
 * whole panel. Input focus is not an issue because the only controls are
 * buttons.
 */

import { STRINGS } from './strings.js';
import { formatMoney } from '../sim/economy.js';
import { CATEGORIES } from '../sim/economy.js';
import { COSTS, MODES } from '../config.js';

export function mountPanels(root, game, { onChange }) {
  const container = document.createElement('div');
  container.className = 'panel';
  root.appendChild(container);

  /** 'finances' when nothing is selected and the player asked for finances. */
  let view = null;

  function showFinances() { view = 'finances'; game.selection = null; render(); }
  function clear() { view = null; game.selection = null; render(); }

  function render() {
    const selection = game.selection;

    if (!selection && view !== 'finances') { container.hidden = true; return; }
    container.hidden = false;

    if (view === 'finances') container.innerHTML = financesHtml(game);
    else if (isLine(selection)) container.innerHTML = lineHtml(game, selection);
    else container.innerHTML = stopHtml(game, selection);

    wire();
  }

  function wire() {
    container.querySelector('[data-act="close"]')?.addEventListener('click', clear);

    const selection = game.selection;
    if (isLine(selection)) {
      container.querySelector('[data-act="add-vehicle"]')?.addEventListener('click', () => {
        game.addVehicle(selection);
        render(); onChange?.();
      });
      container.querySelector('[data-act="remove-vehicle"]')?.addEventListener('click', () => {
        game.removeVehicle(selection);
        render(); onChange?.();
      });
      container.querySelector('[data-act="delete"]')?.addEventListener('click', () => {
        game.bulldoze(selection);
        clear(); onChange?.();
      });
      for (const swatch of container.querySelectorAll('[data-color]')) {
        swatch.addEventListener('click', () => {
          selection.color = swatch.dataset.color;
          render(); onChange?.();
        });
      }
    } else if (selection) {
      container.querySelector('[data-act="delete"]')?.addEventListener('click', () => {
        game.bulldoze(selection);
        clear(); onChange?.();
      });
      const rename = container.querySelector('[data-act="rename"]');
      rename?.addEventListener('change', () => {
        selection.name = rename.value.trim() || selection.name;
        onChange?.();
      });
    }
  }

  return { render, showFinances, clear };
}

const isLine = (object) => Boolean(object && object.segments !== undefined);

function lineHtml(game, line) {
  const capacity = MODES[line.mode].capacity;
  const headway = line.headwayS;
  const atCap = line.vehicles.length >= line.maxVehicles;

  return `
    <header>
      <h3>${STRINGS.toolbar[line.mode]} ${STRINGS.panel.line}</h3>
      <button type="button" data-act="close" class="icon">×</button>
    </header>

    <div class="swatches">
      ${['#E4463C', '#2C7BD6', '#3FA64B', '#F0A52E', '#8E54A8', '#19A6A6',
         '#D9478C', '#6B4F3A', '#5A6B8C', '#9BBF30', '#E0742E', '#3C3C3C']
        .map((color) => `<button type="button" data-color="${color}"
          class="swatch ${color === line.color ? 'on' : ''}"
          style="background:${color}"></button>`).join('')}
    </div>

    <div class="rows">
      <div class="row"><span>${STRINGS.panel.vehicles}</span>
        <span class="stepper">
          <button type="button" data-act="remove-vehicle"
            ${line.vehicles.length === 0 ? 'disabled' : ''}>−</button>
          <b>${line.vehicles.length}</b>
          <button type="button" data-act="add-vehicle"
            ${atCap ? `disabled title="${STRINGS.panel.headwayCapped}"` : ''}>+</button>
        </span>
      </div>
      <div class="row"><span>${STRINGS.panel.vehicleCost}</span>
        <span>${formatMoney(COSTS.VEHICLE[line.mode])}</span></div>
      <div class="row"><span>${STRINGS.panel.headway}</span>
        <span>${Number.isFinite(headway) ? `${Math.round(headway / 60)} min` : '—'}</span></div>
      <div class="row"><span>${STRINGS.panel.length}</span>
        <span>${(line.lengthM / 1000).toFixed(1)} km</span></div>
      <div class="row"><span>${STRINGS.panel.stops}</span>
        <span>${line.stops.length}${line.loop ? ` · ${STRINGS.panel.loop}` : ''}</span></div>
      <div class="row"><span>${STRINGS.panel.ridersNow}</span>
        <span>${(line.ridersNow * game.passengersPerDot).toLocaleString()} / ${(line.vehicles.length * capacity).toLocaleString()}</span></div>
      <div class="row"><span>${STRINGS.panel.ridersPerDay}</span>
        <span>${Math.round(line.ridersPerDay).toLocaleString()}</span></div>
    </div>

    <button type="button" data-act="delete" class="danger">${STRINGS.panel.deleteLine}</button>
  `;
}

function stopHtml(game, stop) {
  const totals = game.demand.stopTotals.get(stop.id) || { residents: 0 };
  const lines = stop.lines
    .map((id) => game.network.lines.get(id))
    .filter(Boolean);

  // The oldest waiter is the one about to give up; it is the useful number.
  let longestWait = 0;
  for (const dot of stop.waiting) {
    longestWait = Math.max(longestWait, game.clock.simSeconds - dot.waitingSince);
  }

  return `
    <header>
      <h3>${STRINGS.panel.stop}</h3>
      <button type="button" data-act="close" class="icon">×</button>
    </header>

    <input type="text" data-act="rename" value="${escapeHtml(stop.name)}" />

    <div class="rows">
      <div class="row"><span>${STRINGS.panel.waiting}</span>
        <span>${(stop.waiting.length * game.passengersPerDot).toLocaleString()}</span></div>
      <div class="row"><span>${STRINGS.panel.longestWait}</span>
        <span>${Math.round(longestWait / 60)} min</span></div>
      <div class="row"><span>${STRINGS.panel.residents}</span>
        <span>${Math.round(totals.residents).toLocaleString()}</span></div>
      <div class="row"><span>${STRINGS.panel.interchange}</span>
        <span>${stop.interchange ? STRINGS.panel.yes : STRINGS.panel.no}</span></div>
    </div>

    <div class="lines-served">
      ${lines.length === 0 ? `<span class="muted">${STRINGS.panel.noLines}</span>`
        : lines.map((line) => `<span class="chip" style="background:${line.color}"></span>`).join('')}
    </div>

    <button type="button" data-act="delete" class="danger">${STRINGS.panel.deleteStop}</button>
  `;
}

function financesHtml(game) {
  const { economy } = game;
  const month = economy.month;

  return `
    <header>
      <h3>${STRINGS.panel.finances}</h3>
      <button type="button" data-act="close" class="icon">×</button>
    </header>

    <div class="rows">
      ${CATEGORIES.map((category) => `
        <div class="row ${(month[category] ?? 0) < 0 ? 'out' : 'in'}">
          <span>${STRINGS.finance[category]}</span>
          <span>${formatMoney(month[category] ?? 0)}</span>
        </div>`).join('')}
      <div class="row total">
        <span>${STRINGS.finance.net}</span>
        <span>${formatMoney(economy.monthNet)}</span>
      </div>
    </div>

    <div class="rows">
      <div class="row"><span>${STRINGS.finance.lastMonth}</span>
        <span>${formatMoney(economy.lastMonthNet)}</span></div>
      <div class="row"><span>${STRINGS.finance.coverage}</span>
        <span>${Math.round(game.demand.coverageFraction() * 100)}%</span></div>
      <div class="row"><span>${STRINGS.finance.difficulty}</span>
        <span>${economy.rules.label}</span></div>
    </div>
  `;
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
