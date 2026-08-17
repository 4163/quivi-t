/**
 * favoritesStore.js - Pure data layer for favorites.
 * Communicates with Core for persistence.
 */

import { Core } from '../core.js';

let configLoaded = false;
window.addEventListener('quivit-config-loaded', () => {
  configLoaded = true;
});

export function getFavorites() {
  const favs = Core.getState().config?.frontend_data?.favorites;
  return Array.isArray(favs) ? favs : [];
}

export function saveFavorites(favs) {
  Core.getState().config.frontend_data.favorites = favs;
  if (configLoaded) Core.persistConfig();
}

export function getFavoritesCollapsed() {
  return Core.getState().config?.frontend_data?.favorites_collapsed === true;
}

export function saveFavoritesCollapsed(collapsed) {
  Core.getState().config.frontend_data.favorites_collapsed = collapsed;
  if (configLoaded) Core.persistConfig();
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
