/**
 * IndexedDB: imported regions, save slots, and the Nominatim search cache.
 *
 * Regions are the expensive thing — one import is a few minutes and several MB
 * off Overpass — so they are cached forever, keyed by centre and size. The
 * Nominatim cache exists because the usage policy requires it.
 */

import { SAVE } from '../config.js';

/** @type {Promise<IDBDatabase>|null} */
let dbPromise = null;

const STORE_REGIONS = 'regions';
const STORE_SAVES = 'saves';
const STORE_GEOCODE = 'geocode';

function open() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(SAVE.DB_NAME, SAVE.DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_REGIONS)) db.createObjectStore(STORE_REGIONS);
      if (!db.objectStoreNames.contains(STORE_SAVES)) db.createObjectStore(STORE_SAVES);
      if (!db.objectStoreNames.contains(STORE_GEOCODE)) db.createObjectStore(STORE_GEOCODE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return dbPromise;
}

/** Wrap one IndexedDB request in a promise. */
function run(storeName, mode, action) {
  return open().then((db) => new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const request = action(tx.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}

/**
 * Cache key for a region. Rounded to ~10 m so re-placing the square by a pixel
 * reuses the import instead of re-fetching it.
 */
export function regionKey(lon, lat, sizeKm) {
  return `${lon.toFixed(4)},${lat.toFixed(4)},${sizeKm}`;
}

/** @returns {Promise<import('../model/region.js').Region|undefined>} */
export function getRegion(key) {
  return run(STORE_REGIONS, 'readonly', (store) => store.get(key));
}

export function putRegion(key, region) {
  return run(STORE_REGIONS, 'readwrite', (store) => store.put(region, key));
}

export function listRegions() {
  return run(STORE_REGIONS, 'readonly', (store) => store.getAllKeys());
}

export function deleteRegion(key) {
  return run(STORE_REGIONS, 'readwrite', (store) => store.delete(key));
}

/** @returns {Promise<Object|undefined>} */
export function getSave(slot) {
  return run(STORE_SAVES, 'readonly', (store) => store.get(slot));
}

export function putSave(slot, state) {
  return run(STORE_SAVES, 'readwrite', (store) => store.put(state, slot));
}

export function listSaves() {
  return run(STORE_SAVES, 'readonly', (store) => store.getAll());
}

/**
 * Nominatim results, cached because the policy requires it: "clients sending
 * repeatedly the same query may be classified as faulty and blocked".
 */
export function getGeocode(query) {
  return run(STORE_GEOCODE, 'readonly', (store) => store.get(query.toLowerCase().trim()));
}

export function putGeocode(query, results) {
  return run(STORE_GEOCODE, 'readwrite',
    (store) => store.put(results, query.toLowerCase().trim()));
}
