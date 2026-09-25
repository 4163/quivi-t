/**
 * favoritesStore.js - Pure data layer for favorites.
 * Communicates with Core for persistence.
 */

import { Core } from '../core.js';

let configLoaded = false;
let reconciliationPromise = null;

window.addEventListener('quivit-config-loaded', () => {
  configLoaded = true;
});

export function getFavorites() {
  const favs = Core.getState().config?.frontend_data?.favorites;
  return Array.isArray(favs) ? favs : [];
}

export function saveFavorites(favs) {
  Core.getState().config.frontend_data.favorites = favs;
  // Favorites are rare explicit gestures; persist now so a config reload
  // never discards them inside the preference debounce window.
  if (configLoaded) Core.persistConfig({ immediate: true });
}

function getFavoriteTargetPath(favorite) {
  const path = favorite?.path;
  if (typeof path !== 'string' || !path) return '';

  // Archive-entry favorites use "<archive path>|<entry name>". The archive
  // itself is the filesystem target whose removal or move makes the favorite
  // stale.
  const separator = path.indexOf('|');
  return separator === -1 ? path : path.slice(0, separator);
}

/**
 * Removes favorites whose filesystem target no longer exists. A move makes
 * the saved path missing, so it follows the same reconciliation path as a
 * deletion. Concurrent callers share one pass to avoid duplicate IPC work.
 */
export async function reconcileFavorites() {
  if (reconciliationPromise) return reconciliationPromise;

  const invoke = window.__TAURI__?.core?.invoke?.bind(window.__TAURI__.core);
  const snapshot = getFavorites().slice();
  if (typeof invoke !== 'function' || snapshot.length === 0) return false;

  reconciliationPromise = Promise.all(snapshot.map(async favorite => {
    const targetPath = getFavoriteTargetPath(favorite);
    if (!targetPath) return favorite;

    try {
      const kind = await invoke('get_path_kind', { path: targetPath });
      return kind === 'missing' ? favorite : null;
    } catch (err) {
      console.warn('[Favorites] Failed to validate saved path:', err);
      return null;
    }
  })).then(staleFavorites => {
    const stale = new Set(staleFavorites.filter(Boolean));
    if (stale.size === 0) return false;

    // Retain entries changed after this pass started. For example, a user can
    // remove and immediately re-add a favorite while IPC is still resolving.
    const current = getFavorites();
    const next = current.filter(favorite => !stale.has(favorite));
    if (next.length === current.length) return false;

    saveFavorites(next);
    return true;
  }).finally(() => {
    reconciliationPromise = null;
  });

  return reconciliationPromise;
}

export function getFavoritesCollapsed() {
  return Core.getState().config?.frontend_data?.favorites_collapsed === true;
}

export function saveFavoritesCollapsed(collapsed) {
  const fd = Core.getState().config.frontend_data;
  const next = collapsed === true;
  if (fd.favorites_collapsed === next) return;
  fd.favorites_collapsed = next;
  if (configLoaded) Core.persistConfig({ immediate: true });
}

export function isFavorite(path) {
  return getFavorites().some(f => f.path === path);
}

export function toggleFavorite(entry) {
  let favs = getFavorites();
  const idx = favs.findIndex(f => f.path === entry.path);
  if (idx === -1) {
    favs.push({ path: entry.path, name: entry.name, is_dir: entry.is_dir, is_drive: entry.is_drive, ext: entry.ext, is_hidden: entry.is_hidden });
  } else {
    favs.splice(idx, 1);
  }
  saveFavorites(favs);
  return idx === -1;
}
