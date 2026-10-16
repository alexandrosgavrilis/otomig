/**
 * The play-testing panel: a slider for every tunable passenger-behaviour and
 * money value, applied live. Toggled with the ` key.
 *
 * All the logic — what is tunable, what a change invalidates, persistence and
 * the hand-back list — is in sim/tuning.js. This file only draws it.
 *
 * The sliders are built once and never re-rendered, so a drag is never cut
 * short; only the "Right now" figures are rewritten each tick.
 */

import { STRINGS } from './strings.js';
import {
  TUNABLES, resolvePath, readPath, defaultOf, setTunable, overrides, resetAll,
  exportText, saveCurrent, readout,
} from '../sim/tuning.js';

/**
 * @param {HTMLElement} root the panel's container
 * @param {HTMLElement} badgeSlot where the "N changed" badge goes
 */
export function mountTuning(root, badgeSlot, game) {
  const panel = document.createElement('div');
  panel.className = 'tuning';
  panel.hidden = true;
  root.appendChild(panel);

  const badge = document.createElement('button');
  badge.type = 'button';
  badge.className = 'tuning-badge';
  badge.addEventListener('click', () => toggle(true));
  badgeSlot.prepend(badge);

  const label = (path) => STRINGS.tuning.labels[path] ?? path;

  /** One slider per tunable, for this game's difficulty. */
  const rows = TUNABLES.map((tunable) => ({
    ...tunable,
    concrete: resolvePath(tunable.path, game.difficulty),
  }));

  function show(tunable, value) {
    const shown = value * (tunable.scale ?? 1);
    const digits = Math.max(0, -Math.floor(Math.log10((tunable.step * (tunable.scale ?? 1)) || 1)));
    return `${shown.toFixed(Math.min(3, digits))}${tunable.unit ? ` ${tunable.unit}` : ''}`;
  }

  function build() {
    const groups = [...new Set(rows.map((row) => row.group))];
    panel.innerHTML = `
      <header>
        <h3>${STRINGS.tuning.title}</h3>
        <button type="button" data-act="close" class="icon">×</button>
      </header>
      <p class="muted">${STRINGS.tuning.hint}</p>
      <div class="tuning-actions">
        <button type="button" data-act="copy">${STRINGS.tuning.copy}</button>
        <button type="button" data-act="reset">${STRINGS.tuning.reset}</button>
      </div>
      <textarea readonly rows="3" data-act="export" hidden></textarea>

      <section>
        <span class="section">${STRINGS.tuning.groups.live}</span>
        ${Object.keys(STRINGS.tuning.readout).map((key) => `
          <div class="row"><span>${STRINGS.tuning.readout[key]}</span>
            <span data-readout="${key}"></span></div>`).join('')}
      </section>

      ${groups.map((group) => `
        <section>
          <span class="section">${STRINGS.tuning.groups[group] ?? group}</span>
          ${rows.filter((row) => row.group === group).map((row) => `
            <div class="tunable" data-path="${row.concrete}">
              <span class="row">
                <span>${label(row.path)}</span>
                <span><b data-value></b>
                  <button type="button" class="icon" data-act="reset-one"
                    title="${STRINGS.tuning.resetOne}">↺</button></span>
              </span>
              <input type="range" min="${row.min}" max="${row.max}" step="${row.step}"
                aria-label="${label(row.path)}" />
            </div>`).join('')}
        </section>`).join('')}
    `;

    panel.querySelector('[data-act="close"]').addEventListener('click', () => toggle(false));
    panel.querySelector('[data-act="copy"]').addEventListener('click', copy);
    panel.querySelector('[data-act="reset"]').addEventListener('click', () => {
      resetAll(game);
      changed();
    });

    for (const element of panel.querySelectorAll('.tunable')) {
      const row = rows.find((candidate) => candidate.concrete === element.dataset.path);
      const slider = element.querySelector('input');
      slider.addEventListener('input', () => {
        setTunable(game, row.concrete, Number(slider.value));
        changed();
      });
      // Hand the keyboard back to the game once the drag ends, or Space and
      // 1–4 would go to the slider.
      slider.addEventListener('change', () => slider.blur());
      element.querySelector('[data-act="reset-one"]').addEventListener('click', () => {
        setTunable(game, row.concrete, defaultOf(row.concrete));
        changed();
      });
    }
    syncSliders();
  }

  /** Bring every slider, value and reset button in line with the config. */
  function syncSliders() {
    for (const element of panel.querySelectorAll('.tunable')) {
      const row = rows.find((candidate) => candidate.concrete === element.dataset.path);
      const value = readPath(row.concrete);
      const slider = element.querySelector('input');
      if (Number(slider.value) !== value) slider.value = String(value);
      element.querySelector('[data-value]').textContent = show(row, value);
      const isDefault = value === defaultOf(row.concrete);
      element.classList.toggle('changed', !isDefault);
      element.querySelector('[data-act="reset-one"]').hidden = isDefault;
    }
  }

  function changed() {
    saveCurrent();
    syncSliders();
    syncBadge();
    const area = panel.querySelector('[data-act="export"]');
    if (!area.hidden) area.value = exportText();
  }

  function syncBadge() {
    const count = Object.keys(overrides()).length;
    badge.hidden = count === 0;
    badge.textContent = STRINGS.tuning.badge(count);
  }

  /**
   * Put the hand-back list on the clipboard, and in a box beside the button
   * too: the clipboard can be refused, and the text must be reachable anyway.
   */
  async function copy() {
    const text = exportText();
    const area = panel.querySelector('[data-act="export"]');
    area.hidden = false;
    area.value = text;
    area.select();
    try {
      await navigator.clipboard.writeText(text);
      panel.querySelector('[data-act="copy"]').textContent = STRINGS.tuning.copied;
      setTimeout(() => {
        panel.querySelector('[data-act="copy"]').textContent = STRINGS.tuning.copy;
      }, 1500);
    } catch {
      // The text is selected in the box; Ctrl+C still works.
    }
  }

  function update() {
    if (panel.hidden) return;
    const figures = readout(game);
    const format = {
      tripsPerDay: (v) => Math.round(v).toLocaleString(),
      meanUnhappySatisfaction: (v) => v.toFixed(2),
      coverage: (v) => `${Math.round(v * 100)}%`,
    };
    for (const element of panel.querySelectorAll('[data-readout]')) {
      const key = element.dataset.readout;
      const value = figures[key];
      const text = (format[key] ?? ((v) => Math.round(v).toLocaleString()))(value);
      if (element.textContent !== text) element.textContent = text;
    }
  }

  function toggle(open = panel.hidden) {
    panel.hidden = !open;
    if (open) { syncSliders(); update(); }
  }

  build();
  syncBadge();
  return { toggle, update, get open() { return !panel.hidden; } };
}
