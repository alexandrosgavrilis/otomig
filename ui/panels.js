/**
 * The contextual right-hand panel: line, stop, or finances.
 *
 * Line, stop and track views are rendered to an HTML string on every update,
 * but the DOM is only REPLACED when that string's structure changes — a
 * different object selected, a button enabled or disabled, a row appearing.
 * Otherwise only the text that changed is rewritten (`patch`). Replacing the
 * DOM every tick, as the panel did until Phase 6, detached every button
 * between a mouse press and its release, so a click on +, Delete or a toggle
 * could simply be lost, and a stop being renamed lost the player's typing.
 *
 * The finances view cannot work that way: it holds the fare slider, and
 * replacing a slider under the player's mouse ends the drag. So it is built
 * once and then only its figures are rewritten each tick (`[data-live]`). It
 * is rebuilt only when its *shape* changes — a loan taken or repaid, or a
 * button becoming usable — which never happens mid-drag.
 */

import { STRINGS } from './strings.js';
import { formatMoney, CATEGORIES } from '../sim/economy.js';
import { fareFactor } from '../sim/demand.js';
import { COSTS, MODES, INCOME, LOANS, INTERCITY, VEHICLES } from '../config.js';

export function mountPanels(root, game, { onChange }) {
  const container = document.createElement('div');
  container.className = 'panel';
  root.appendChild(container);

  /** 'finances' when nothing is selected and the player asked for finances. */
  let view = null;
  /**
   * Why the last delete on the selected object was refused. The panel is
   * redrawn every tick, so the reason has to live here rather than in the DOM.
   */
  let refusal = null;

  /** The finances view's shape when it was last built; see the file comment. */
  let financeShape = null;
  /** What the line, stop or track view was last built for. */
  let shownFor = null;

  function showFinances() { view = 'finances'; game.selection = null; render(); game.emit('financesOpened'); }
  function clear() { view = null; game.selection = null; render(); }

  /**
   * Called every tick. The finances view rewrites its figures in place; the
   * others re-render while something is selected.
   */
  function update() {
    if (view === 'finances' && !game.selection) {
      if (financesShape(game) !== financeShape) render();
      else refreshLive();
      return;
    }
    render();
  }

  function render() {
    const selection = game.selection;
    // Selecting something on the map replaces the finances view.
    if (selection) view = null;

    if (!selection && view !== 'finances') {
      container.hidden = true;
      shownFor = null;
      return;
    }
    container.hidden = false;

    if (view === 'finances') {
      container.innerHTML = financesHtml(game, refusal);
      financeShape = financesShape(game);
      shownFor = 'finances';
      refreshLive();
      wire();
      return;
    }

    let html;
    if (isLine(selection)) html = lineHtml(game, selection);
    else if (isTrack(selection)) {
      html = trackHtml(game, selection, refusal?.target === selection ? refusal.text : '');
    }
    else html = stopHtml(game, selection);

    // A different object always gets fresh controls, because the handlers
    // are bound to the object that was selected when they were wired.
    const rebuilt = patch(container, html, shownFor !== selection);
    shownFor = selection;
    if (rebuilt) wire();
  }

  /** Rewrite the finances view's figures without touching its controls. */
  function refreshLive() {
    const values = financeFigures(game);
    for (const element of container.querySelectorAll('[data-live]')) {
      const key = element.dataset.live;
      const text = values[key]?.text ?? values[key];
      if (text !== undefined && element.textContent !== text) element.textContent = text;
      if (values[key]?.className !== undefined) {
        element.closest('.row')?.classList.toggle('in', values[key].className === 'in');
        element.closest('.row')?.classList.toggle('out', values[key].className === 'out');
      }
    }
  }

  function wire() {
    container.querySelector('[data-act="close"]')?.addEventListener('click', clear);

    if (view === 'finances' && !game.selection) {
      const fare = container.querySelector('[data-act="fare"]');
      fare?.addEventListener('input', () => {
        game.economy.setFareMultiplier(Number(fare.value));
        refreshLive();
      });
      // Hand the keyboard back to the game once the drag ends.
      fare?.addEventListener('change', () => fare.blur());
      for (const button of container.querySelectorAll('[data-loan]')) {
        button.addEventListener('click', () => {
          const slot = button.dataset.loan;
          const result = button.dataset.act === 'take-loan'
            ? game.economy.takeLoan(slot) : game.economy.repayLoan(slot);
          refusal = result.error
            ? { target: 'finances', text: STRINGS.errors[result.error] || result.error } : null;
          render(); onChange?.();
        });
      }
      return;
    }

    const selection = game.selection;
    if (isTrack(selection)) {
      container.querySelector('[data-act="delete"]')?.addEventListener('click', () => {
        const result = game.bulldoze(selection);
        if (result?.error) {
          refusal = { target: selection, text: STRINGS.errors[result.error] || result.error };
          render();
          return;
        }
        clear(); onChange?.();
      });
    } else if (isLine(selection)) {
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
      container.querySelector('[data-act="keep-spacing"]')?.addEventListener('click', () => {
        selection.keepSpacing = !selection.keepSpacing;
        render(); onChange?.();
      });
      container.querySelector('[data-act="skip-stops"]')?.addEventListener('click', () => {
        selection.skipEmptyStops = !selection.skipEmptyStops;
        render(); onChange?.();
      });
      const renameLine = container.querySelector('[data-act="rename-line"]');
      renameLine?.addEventListener('change', () => {
        // Empty, or the automatic name typed back in, returns to automatic.
        const value = renameLine.value.trim();
        selection.name = null;
        selection.name = value && value !== lineLabel(game, selection) ? value : null;
        render(); onChange?.();
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
      container.querySelector('[data-act="intercity"]')?.addEventListener('click', () => {
        game.toggleIntercity(selection);
        render(); onChange?.();
      });
      const rename = container.querySelector('[data-act="rename"]');
      rename?.addEventListener('change', () => {
        const value = rename.value.trim();
        selection.customName = null;
        selection.customName = value && value !== game.network.stopLabel(selection) ? value : null;
        render(); onChange?.();
      });
    }
  }

  // Start hidden. Until the first render the container had no `hidden`
  // attribute, so an empty white box sat in the corner until something was
  // selected.
  render();
  return { render, update, showFinances, clear };
}

/**
 * Bring `target` in line with `html`. When the new markup has the same
 * elements and attributes as what is there, only text nodes are rewritten and
 * every element — and so any button being pressed, or input being typed in —
 * survives. Otherwise, or when `force` is set, the contents are replaced.
 *
 * @returns {boolean} whether the contents were replaced
 */
function patch(target, html, force = false) {
  const template = document.createElement('template');
  template.innerHTML = html;
  if (force || !sameShape(target, template.content)) {
    target.replaceChildren(template.content);
    return true;
  }
  copyText(target, template.content);
  return false;
}

function sameShape(a, b) {
  if (a.childNodes.length !== b.childNodes.length) return false;
  for (let i = 0; i < a.childNodes.length; i++) {
    const x = a.childNodes[i];
    const y = b.childNodes[i];
    if (x.nodeType !== y.nodeType) return false;
    if (x.nodeType !== Node.ELEMENT_NODE) continue;
    if (x.tagName !== y.tagName || x.attributes.length !== y.attributes.length) return false;
    for (const attribute of y.attributes) {
      if (x.getAttribute(attribute.name) !== attribute.value) return false;
    }
    if (!sameShape(x, y)) return false;
  }
  return true;
}

function copyText(a, b) {
  for (let i = 0; i < a.childNodes.length; i++) {
    const x = a.childNodes[i];
    const y = b.childNodes[i];
    if (x.nodeType === Node.TEXT_NODE) {
      if (x.nodeValue !== y.nodeValue) x.nodeValue = y.nodeValue;
    } else if (x.nodeType === Node.ELEMENT_NODE) copyText(x, y);
  }
}

const isLine = (object) => Boolean(object && object.segments !== undefined);
const isTrack = (object) => Boolean(object && object.control !== undefined);

/** Built metro or train track: what it is made of and what it costs to keep. */
function trackHtml(game, track, refusal) {
  const step = track.lengthM / Math.max(1, track.kinds.length - 1);
  const metres = (kind) => track.kinds.filter((k) => k === kind).length * step;
  const junctions = [track.start, track.end].filter(Boolean).length;
  const discount = game.region.meta.hasOsmRail ? 1 - COSTS.OSM_RAIL_DISCOUNT : 1;

  // An existing railway: free to run on, kept by someone else, not removable.
  if (track.osm) {
    return `
      <header>
        <h3>${STRINGS.panel.existingRail}</h3>
        <button type="button" data-act="close" class="icon">×</button>
      </header>
      ${track.name ? `<span>${escapeHtml(track.name)}</span>` : ''}
      <div class="rows">
        <div class="row"><span>${STRINGS.panel.length}</span>
          <span>${(track.lengthM / 1000).toFixed(2)} km</span></div>
        ${['atGrade', 'tunnel', 'bridge'].map((kind) => metres(kind) > 0 ? `
          <div class="row"><span>${STRINGS.panel[kind]}</span>
            <span>${Math.round(metres(kind))} m</span></div>` : '').join('')}
        <div class="row"><span>${STRINGS.panel.junctions}</span><span>${junctions}</span></div>
      </div>
      <span class="muted">${STRINGS.panel.existingRailHint}</span>
    `;
  }

  return `
    <header>
      <h3>${STRINGS.toolbar[track.mode]} ${STRINGS.panel.track}</h3>
      <button type="button" data-act="close" class="icon">×</button>
    </header>

    <div class="rows">
      <div class="row"><span>${STRINGS.panel.length}</span>
        <span>${(track.lengthM / 1000).toFixed(2)} km</span></div>
      ${['atGrade', 'tunnel', 'bridge'].map((kind) => metres(kind) > 0 ? `
        <div class="row"><span>${STRINGS.panel[kind]}</span>
          <span>${Math.round(metres(kind))} m</span></div>` : '').join('')}
      <div class="row"><span>${STRINGS.panel.levelCrossings}</span>
        <span>${track.levelCrossings.length}</span></div>
      <div class="row"><span>${STRINGS.panel.junctions}</span><span>${junctions}</span></div>
      <div class="row"><span>${STRINGS.panel.trackCost}</span>
        <span>${formatMoney(track.cost)}</span></div>
      <div class="row"><span>${STRINGS.panel.maintenance}</span>
        <span>${formatMoney(track.cost * COSTS.MAINTENANCE_RATE * discount)}</span></div>
    </div>

    ${refusal ? `<span class="muted">${escapeHtml(refusal)}</span>` : ''}
    <button type="button" data-act="delete" class="danger">${STRINGS.panel.deleteTrack}</button>
  `;
}

function lineHtml(game, line) {
  const capacity = MODES[line.mode].capacity;
  const headway = line.headwayS;
  const atCap = line.vehicles.length >= line.maxVehicles;

  return `
    <header>
      <h3>${STRINGS.toolbar[line.mode]} ${STRINGS.panel.line}</h3>
      <button type="button" data-act="close" class="icon">×</button>
    </header>

    <input type="text" data-act="rename-line" value="${escapeHtml(lineLabel(game, line))}"
      aria-label="${STRINGS.panel.lineName}" />

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
      <div class="row" title="${STRINGS.clocks.live}"><span>${STRINGS.panel.headway}</span>
        <span>${Number.isFinite(headway) ? `${Math.round(headway / 60)} min` : '—'}</span></div>
      <div class="row"><span>${STRINGS.panel.length}</span>
        <span>${(line.lengthM / 1000).toFixed(1)} km</span></div>
      <div class="row"><span>${STRINGS.panel.stops}</span>
        <span>${line.stops.length}${line.closed ? ` · ${STRINGS.panel.loop}` : ''}</span></div>
      <div class="row" title="${STRINGS.clocks.live}"><span>${STRINGS.panel.ridersNow}</span>
        <span>${(line.ridersNow * game.passengersPerDot).toLocaleString()} / ${(line.vehicles.length * capacity).toLocaleString()}</span></div>
      <div class="row" title="${STRINGS.clocks.perDay}"><span>${STRINGS.panel.ridersPerDay}</span>
        <span>${Math.round(line.ridersPerDay).toLocaleString()}</span></div>
    </div>

    <div class="rows">
      <span class="section">${STRINGS.panel.rules}</span>
      <div class="row" title="${STRINGS.panel.keepSpacingHint}"><span>${STRINGS.panel.keepSpacing}</span>
        <button type="button" data-act="keep-spacing" class="${line.keepSpacing ? 'on' : ''}">
          ${line.keepSpacing ? STRINGS.panel.on : STRINGS.panel.off}</button></div>
      ${VEHICLES.SKIP_EMPTY_STOPS.includes(line.mode) ? `
        <div class="row" title="${STRINGS.panel.skipStopsHint}"><span>${STRINGS.panel.skipStops}</span>
          <button type="button" data-act="skip-stops" class="${line.skipEmptyStops ? 'on' : ''}">
            ${line.skipEmptyStops ? STRINGS.panel.on : STRINGS.panel.off}</button></div>` : ''}
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
      <h3>${stop.mode === 'metro' || stop.mode === 'train'
        ? `${STRINGS.toolbar[stop.mode]} ${STRINGS.panel.station}` : STRINGS.panel.stop}</h3>
      <button type="button" data-act="close" class="icon">×</button>
    </header>

    <input type="text" data-act="rename" value="${escapeHtml(game.network.stopLabel(stop))}"
      aria-label="${STRINGS.panel.stopName}" />

    <div class="rows">
      <div class="row" title="${STRINGS.clocks.live}"><span>${STRINGS.panel.waiting}</span>
        <span>${(stop.waiting.length * game.passengersPerDot).toLocaleString()}</span></div>
      <div class="row" title="${STRINGS.clocks.live}"><span>${STRINGS.panel.longestWait}</span>
        <span>${Math.round(longestWait / 60)} min</span></div>
      <div class="row"><span>${STRINGS.panel.residents}</span>
        <span>${Math.round(totals.residents).toLocaleString()}${
          totals.served === false ? ` · ${STRINGS.panel.notServed}` : ''}</span></div>
      <div class="row"><span>${STRINGS.panel.interchange}</span>
        <span>${game.network.changesAt(stop) ? STRINGS.panel.yes : STRINGS.panel.no}</span></div>
      ${stop.mode === 'metro' || stop.mode === 'train' ? `
        <div class="row"><span>${STRINGS.panel.structure}</span>
          <span>${STRINGS.panel.structureNames[stop.structure] || stop.structure}</span></div>` : ''}
    </div>

    ${game.network.onOsmRail(stop) ? `
      <div class="rows">
        <div class="row"><span>${STRINGS.panel.intercity}</span>
          <button type="button" data-act="intercity" class="${stop.intercity ? 'on' : ''}"
            title="${STRINGS.panel.intercityHint}">
            ${stop.intercity ? STRINGS.panel.intercityOn : STRINGS.panel.intercityOff}</button></div>
        ${stop.intercity ? `
          <div class="row"><span>${STRINGS.panel.intercityNext}</span>
            <span>${Math.ceil((INTERCITY.INTERVAL_SIM_S - stop.intercityTimer) / 60)} min</span></div>` : ''}
        ${stop.intercityCalls ? `
          <div class="row"><span>${STRINGS.panel.intercityCalls}</span>
            <span>${stop.intercityCalls}</span></div>` : ''}
      </div>` : ''}

    ${flowsHtml(game, stop)}

    <div class="lines-served">
      ${lines.length === 0 ? `<span class="muted">${STRINGS.panel.noLines}</span>`
        : lines.map((line) => `<span class="chip" style="background:${line.color}"
            title="${escapeHtml(lineLabel(game, line))}"></span>`).join('')}
    </div>

    <button type="button" data-act="delete" class="danger">${STRINGS.panel.deleteStop}</button>
  `;
}

/**
 * The finances view's figures, keyed by `data-live`. Everything that changes
 * from tick to tick lives here, so the view never has to be rebuilt for it.
 */
function financeFigures(game) {
  const { economy } = game;
  const figures = {};
  for (const category of CATEGORIES) {
    const amount = economy.month[category] ?? 0;
    figures[category] = {
      text: formatMoney(amount),
      className: amount > 0 ? 'in' : amount < 0 ? 'out' : '',
    };
  }
  figures.net = formatMoney(economy.monthNet);
  figures.lastMonth = formatMoney(economy.lastMonthNet);
  figures.coverage = `${Math.round(game.demand.coverageFraction() * 100)}%`;
  figures.balance = formatMoney(economy.balance);
  figures.debt = formatMoney(economy.debt);

  const multiplier = economy.fareMultiplier;
  figures.fare = `${formatFare(INCOME.FARE * multiplier)} · ×${multiplier.toFixed(2)}`;
  figures.fareDemand = `${STRINGS.finance.fareDemand} ×${fareFactor(multiplier).toFixed(2)}`;

  for (const loan of economy.loans) {
    figures[`loan-${loan.slot}`] = `${formatMoney(loan.outstanding)} ${STRINGS.finance.owed} · `
      + `${formatMoney(loan.payment)}${STRINGS.finance.perMonth} · `
      + `${Math.ceil(loan.monthsLeft / 12 * 10) / 10} ${STRINGS.finance.yearsLeft}`;
  }
  return figures;
}

/**
 * What decides the view's structure: which loans exist and which buttons are
 * usable. When this string changes the view is rebuilt; otherwise only the
 * figures are rewritten.
 */
function financesShape(game) {
  const { economy } = game;
  return LOANS.map(({ slot }) => {
    const loan = economy.loanIn(slot);
    return loan ? `${slot}:owed:${economy.balance >= loan.outstanding}` : `${slot}:free`;
  }).join('|');
}

function financesHtml(game, refusal) {
  const { economy } = game;
  const multiplier = economy.fareMultiplier;

  const loanRow = ({ slot }) => {
    const loan = economy.loanIn(slot);
    const offer = economy.loanOffer(slot);
    const name = STRINGS.finance.loanSlots[slot];
    if (loan) {
      return `
        <div class="loan taken">
          <div class="row"><span>${name}</span><span>${formatMoney(loan.amount)}</span></div>
          <span class="muted" data-live="loan-${slot}"></span>
          <button type="button" data-act="repay-loan" data-loan="${slot}"
            ${economy.balance >= loan.outstanding ? '' : 'disabled'}
            title="${STRINGS.finance.repayHint}">${STRINGS.finance.repay}</button>
        </div>`;
    }
    return `
      <div class="loan">
        <div class="row"><span>${name}</span><span>${formatMoney(offer.amount)}</span></div>
        <span class="muted">${Math.round(offer.interest * 100)}% · ${offer.termYears} ${STRINGS.finance.years}
          · ${formatMoney(offer.payment)}${STRINGS.finance.perMonth}</span>
        <button type="button" data-act="take-loan" data-loan="${slot}">${STRINGS.finance.borrow}</button>
      </div>`;
  };

  return `
    <header>
      <h3>${STRINGS.panel.finances}</h3>
      <button type="button" data-act="close" class="icon">×</button>
    </header>

    <div class="rows">
      <div class="row total"><span>${STRINGS.finance.balance}</span>
        <span data-live="balance"></span></div>
    </div>

    <div class="rows">
      <span class="section">${STRINGS.finance.thisMonth}</span>
      ${CATEGORIES.map((category) => `
        <div class="row">
          <span>${STRINGS.finance[category]}</span>
          <span data-live="${category}"></span>
        </div>`).join('')}
      <div class="row total">
        <span>${STRINGS.finance.net}</span>
        <span data-live="net"></span>
      </div>
    </div>

    <div class="rows">
      <div class="row"><span>${STRINGS.finance.lastMonth}</span>
        <span data-live="lastMonth"></span></div>
      <div class="row"><span>${STRINGS.finance.coverage}</span>
        <span data-live="coverage"></span></div>
      <div class="row"><span>${STRINGS.finance.difficulty}</span>
        <span>${economy.rules.label}</span></div>
    </div>

    <div class="rows">
      <span class="section">${STRINGS.finance.ticketPrice}</span>
      <div class="row"><span data-live="fare"></span><span data-live="fareDemand"></span></div>
      <input type="range" data-act="fare" min="${INCOME.FARE_MULTIPLIER_MIN}"
        max="${INCOME.FARE_MULTIPLIER_MAX}" step="0.05" value="${multiplier}"
        aria-label="${STRINGS.finance.ticketPrice}" />
    </div>

    ${economy.canBorrow ? `
      <div class="rows">
        <span class="section">${STRINGS.finance.loans}</span>
        ${LOANS.map(loanRow).join('')}
        ${economy.loans.length ? `<div class="row"><span>${STRINGS.finance.debt}</span>
          <span data-live="debt"></span></div>` : ''}
        ${refusal?.target === 'finances' ? `<span class="muted">${escapeHtml(refusal.text)}</span>` : ''}
      </div>` : ''}
  `;
}

/** "€1.50" — a fare needs its cents, unlike every other sum in the game. */
function formatFare(amount) {
  return `€${amount.toFixed(2)}`;
}

/** A stop's busiest destinations, from the same table as the Flows layer. */
function flowsHtml(game, stop) {
  const flows = game.demand.flowsAt(stop.id, 5);
  return `
    <div class="rows" title="${STRINGS.clocks.perDay}">
      <span class="section">${STRINGS.panel.topFlows}</span>
      ${flows.length === 0 ? `<span class="muted">${STRINGS.panel.noFlows}</span>`
        : flows.map((flow) => `
          <div class="row"><span>${escapeHtml(labelOf(game, flow.other))}</span>
            <span>${Math.round(flow.perDay).toLocaleString()}${STRINGS.panel.perDay}</span></div>`).join('')}
    </div>`;
}

/** A line's name as shown — the player's, or the automatic one. */
function lineLabel(game, line) {
  return game.network.lineLabel(line, { to: STRINGS.panel.to, mode: STRINGS.toolbar });
}

function labelOf(game, stopId) {
  const stop = game.network.stops.get(stopId);
  return stop ? game.network.stopLabel(stop) : '?';
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (character) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[character]);
}
