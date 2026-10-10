/**
 * Saving: IndexedDB slots, an autosave each in-game month, and JSON file
 * export/import.
 *
 * A save deliberately does not contain the region. Regions are megabytes and
 * are already cached by their own key, so a save stores that key and is small
 * enough to e-mail. Loading re-reads the region from the cache; if it is
 * missing — a save moved to another machine — the loader says so plainly
 * rather than failing halfway through.
 */

import { SAVE } from '../config.js';
import { getSave, putSave, listSaves, getRegion } from '../data/cache.js';
import { reviveRegion } from './region.js';
import { Game } from '../sim/game.js';

/** Slot key for IndexedDB. Slot 0 is reserved for the autosave. */
export const AUTOSAVE_SLOT = 'autosave';
export const slotKey = (index) => `slot${index}`;

/**
 * @param {Game} game
 * @param {string} regionKey the key the region is cached under
 * @param {string} slot
 */
export async function saveGame(game, regionKey, slot = AUTOSAVE_SLOT) {
  const payload = {
    ...game.toJSON(regionKey),
    slot,
    savedAt: Date.now(),
    label: `${game.region.meta.name} — ${game.clock.dayOfMonth}/${game.clock.month + 1}/${game.clock.year}`,
  };
  await putSave(slot, payload);
  return payload;
}

/**
 * Load a slot and rebuild the game.
 * @returns {Promise<{game: Game, regionKey: string}|{error: string}>}
 */
export async function loadGame(slot = AUTOSAVE_SLOT) {
  const data = await getSave(slot);
  if (!data) return { error: 'noSave' };
  return rebuild(data);
}

/** Shared by slot loading and file import. */
async function rebuild(data) {
  if (data.version !== 1) return { error: 'badVersion' };

  let region = await getRegion(data.regionKey);
  if (!region) return { error: 'regionMissing' };
  region = reviveRegion(region);

  // The save carries the season and difficulty chosen for THIS game, which may
  // differ from whatever the cached region was last imported with.
  region.meta = { ...region.meta, ...data.regionMeta };

  return { game: Game.fromJSON(data, region), regionKey: data.regionKey };
}

/** Every slot with a save in it, newest first. */
export async function listSaveSlots() {
  const saves = await listSaves();
  return saves
    .filter(Boolean)
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
    .map((save) => ({
      slot: save.slot, label: save.label, savedAt: save.savedAt,
      regionName: save.regionMeta?.name,
    }));
}

/** Autosave, called when the in-game month rolls over. */
export async function autosave(game, regionKey) {
  if (!SAVE.AUTOSAVE_MONTHLY) return;
  try {
    await saveGame(game, regionKey, AUTOSAVE_SLOT);
  } catch (error) {
    // A failed autosave must never interrupt play.
    console.warn('autosave failed:', error);
  }
}

/** Download the current game as a JSON file. */
export function exportSaveFile(game, regionKey) {
  const payload = { ...game.toJSON(regionKey), savedAt: Date.now() };
  const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `otomig-${slugify(game.region.meta.name)}-${stamp()}.json`;
  link.click();
  URL.revokeObjectURL(url);
}

/**
 * Read a save back from a file the player picked.
 * @param {File} file
 */
export async function importSaveFile(file) {
  let data;
  try {
    data = JSON.parse(await file.text());
  } catch {
    return { error: 'badFile' };
  }
  return rebuild(data);
}

function slugify(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'region';
}

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}
