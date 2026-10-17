/**
 * Saving: a save per region in IndexedDB, an autosave each in-game month, and
 * save files that carry everything.
 *
 * In the browser, a save stores the game — network, money, calendar,
 * satisfaction — and refers to its region by key, since the region is cached
 * by that key already and is megabytes. Saving makes sure the region really
 * is in the cache (the test region never was, so its saves could not load).
 *
 * A save FILE is different: it carries the region too, so it can be opened
 * on another browser or device with nothing imported there (Alex, Oct 17
 * 2026). Opening one caches its region, so that region is never fetched
 * again. Files are gzip-compressed where the browser can — a 6 km city is
 * about 8 MB of JSON and roughly 1 MB compressed. Files from before (game
 * only, `version: 1`) still open wherever their region is cached.
 */

import { SAVE } from '../config.js';
import {
  getSave, putSave, listSaves, getRegion, putRegion,
} from '../data/cache.js';
import { reviveRegion, serialiseRegion } from './region.js';
import { Game } from '../sim/game.js';

/** Slot keys: one manual save and one autosave per region. */
export const manualSlot = (regionKey) => `game:${regionKey}`;
export const autoSlot = (regionKey) => `auto:${regionKey}`;

/** What a save file says it is, so any other JSON is refused clearly. */
export const FILE_FORMAT = 'otomig-save';
export const FILE_VERSION = 2;

/**
 * Save the game to its region's slot.
 * @param {Game} game
 * @param {string} regionKey
 * @param {{auto?: boolean}} [options]
 */
export async function saveGame(game, regionKey, { auto = false } = {}) {
  await ensureRegionCached(game.region, regionKey);
  const slot = auto ? autoSlot(regionKey) : manualSlot(regionKey);
  const payload = {
    ...game.toJSON(regionKey),
    slot,
    auto,
    savedAt: Date.now(),
    regionImportedAt: game.region.meta.importedAt ?? null,
  };
  await putSave(slot, payload);
  return payload;
}

/** Put the region in the cache if it is not there — the test region, say. */
async function ensureRegionCached(region, regionKey) {
  if (await getRegion(regionKey)) return;
  await putRegion(regionKey, serialiseRegion(region));
}

/**
 * Load a slot and rebuild the game.
 * @returns {Promise<{game: Game, regionKey: string}|{error: string}>}
 */
export async function loadGame(slot) {
  const data = await getSave(slot);
  if (!data) return { error: 'noSave' };
  return restore(data);
}

/** The newest save of this region, manual or auto, or null. */
export async function newestSaveOf(regionKey) {
  const saves = await Promise.all([getSave(manualSlot(regionKey)), getSave(autoSlot(regionKey))]);
  const found = saves.filter(Boolean).sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
  return found[0]?.slot ?? null;
}

/**
 * Rebuild a game from a save: a slot's, a version-1 file's (game only), or a
 * full save file's (game and region).
 * @returns {Promise<{game: Game, regionKey: string}|{error: string}>}
 */
export async function restore(data) {
  if (data?.format === FILE_FORMAT) {
    if (data.version !== FILE_VERSION || !data.game || !data.region) return { error: 'badVersion' };
    return restoreBundle(data);
  }
  if (data?.version !== 1 || !data.regionKey) return { error: 'badFile' };

  let region = null;
  try { region = await getRegion(data.regionKey); } catch { /* no storage here */ }
  if (!region) return { error: 'regionMissing' };
  region = reviveRegion(region);
  // The save carries the season and difficulty chosen for THIS game, which may
  // differ from whatever the cached region was last imported with.
  region.meta = { ...region.meta, ...data.regionMeta };
  return { game: Game.fromJSON(data, region), regionKey: data.regionKey };
}

/**
 * A full save file: the game is rebuilt on the file's own region, exactly as
 * it was saved. The region is cached if this browser has none under that key;
 * one already there is left alone — it may be a newer import of the place,
 * and other saves may rely on it.
 */
async function restoreBundle(data) {
  const key = data.game.regionKey;
  try {
    if (!(await getRegion(key))) await putRegion(key, data.region);
  } catch (error) {
    // A full disk, or no storage at all, must not stop the game opening; the
    // region is simply not cached.
    console.warn('caching the save file\'s region failed:', error?.message ?? error);
  }
  const region = reviveRegion(data.region);
  region.meta = { ...region.meta, ...data.game.regionMeta };
  return { game: Game.fromJSON(data.game, region), regionKey: key };
}

/** Every save there is, newest first, for the Continue list. */
export async function listSaveSlots() {
  const saves = await listSaves();
  return saves
    .filter((save) => save && save.regionKey)
    .sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0))
    .map((save) => ({
      slot: save.slot,
      auto: Boolean(save.auto ?? save.slot === 'autosave'),
      savedAt: save.savedAt,
      regionName: save.regionMeta?.name,
      date: save.clock ? { day: save.clock.dayOfMonth, month: save.clock.month, year: save.clock.year } : null,
      balance: save.economy?.balance,
    }));
}

/** Autosave, called when the in-game month rolls over. */
export async function autosave(game, regionKey) {
  if (!SAVE.AUTOSAVE_MONTHLY) return;
  try {
    await saveGame(game, regionKey, { auto: true });
  } catch (error) {
    // A failed autosave must never interrupt play.
    console.warn('autosave failed:', error);
  }
}

// ─── Save files ───────────────────────────────────────────────────────────────

/** Everything needed to play this game anywhere: the game and its region. */
export function bundle(game, regionKey) {
  return {
    format: FILE_FORMAT,
    version: FILE_VERSION,
    savedAt: Date.now(),
    game: game.toJSON(regionKey),
    region: serialiseRegion(game.region),
  };
}

/** The bundle as a file's contents: gzip where the browser can, JSON if not. */
export async function encodeSaveFile(game, regionKey) {
  const text = JSON.stringify(bundle(game, regionKey));
  if (typeof CompressionStream === 'undefined') {
    return { blob: new Blob([text], { type: 'application/json' }), extension: 'json' };
  }
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream('gzip'));
  const bytes = await new Response(stream).arrayBuffer();
  return { blob: new Blob([bytes], { type: 'application/gzip' }), extension: 'otomig' };
}

/** Read a save file, gzipped or plain, back into an object. */
export async function decodeSaveFile(blob) {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let text;
  if (bytes[0] === 0x1f && bytes[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') throw new Error('gzip unsupported');
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
    text = await new Response(stream).text();
  } else {
    text = new TextDecoder().decode(bytes);
  }
  return JSON.parse(text);
}

/** Download the whole game — network, money and region — as one file. */
export async function exportSaveFile(game, regionKey) {
  const { blob, extension } = await encodeSaveFile(game, regionKey);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `otomig-${slugify(game.region.meta.name)}-${stamp()}.${extension}`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked later, not at once: some browsers start the download after click returns.
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}

/**
 * Open a save file the player picked.
 * @param {File} file
 */
export async function importSaveFile(file) {
  let data;
  try {
    data = await decodeSaveFile(file);
  } catch {
    return { error: 'badFile' };
  }
  return restore(data);
}

function slugify(name) {
  // Letters of any alphabet: "Πάτρα" makes a perfectly good file name.
  return String(name || 'region').toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '') || 'region';
}

function stamp() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}
