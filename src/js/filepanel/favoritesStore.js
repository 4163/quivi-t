/**
 * favoritesStore.js - Pure data layer for favorites loadouts.
 * Communicates with Core for persistence.
 */

import { Core } from '../core.js';

let configLoaded = false;
let reconciliationPromise = null;

window.addEventListener('quivit-config-loaded', () => {
  configLoaded = true;
});

export const DEFAULT_LOADOUT_NAME = 'Favorites 1';

export function getNextLoadoutName(state, excludeName = '') {
  const existingNames = new Set(
    (state?.loadouts || [])
      .filter(l => typeof l?.name === 'string' && l.name.toLowerCase() !== (excludeName || '').toLowerCase())
      .map(l => l.name.toLowerCase())
  );
  let n = 1;
  while (existingNames.has(`favorites ${n}`)) {
    n++;
  }
  return `Favorites ${n}`;
}

function normalizeFavorites(raw) {
  if (!raw || typeof raw !== 'object') {
    return {
      active: DEFAULT_LOADOUT_NAME,
      loadouts: [{ name: DEFAULT_LOADOUT_NAME, items: [] }]
    };
  }

  // Handle legacy array if present.
  if (Array.isArray(raw)) {
    return {
      active: DEFAULT_LOADOUT_NAME,
      loadouts: [{ name: DEFAULT_LOADOUT_NAME, items: raw }]
    };
  }

  let loadouts = Array.isArray(raw.loadouts) ? raw.loadouts : [];
  if (loadouts.length === 0) {
    loadouts = [{ name: DEFAULT_LOADOUT_NAME, items: [] }];
  } else {
    // Sanitize each loadout, migrate legacy 'Default' name, and ensure uniqueness.
    const seenNames = new Set();
    loadouts = loadouts.map(l => {
      let name = (typeof l?.name === 'string' && l.name.trim()) ? l.name.trim() : DEFAULT_LOADOUT_NAME;
      if (name.toLowerCase() === 'default') name = DEFAULT_LOADOUT_NAME;
      let uniqueName = name;
      let n = 2;
      while (seenNames.has(uniqueName.toLowerCase())) {
        uniqueName = `${name} (${n++})`;
      }
      seenNames.add(uniqueName.toLowerCase());
      return {
        name: uniqueName,
        items: Array.isArray(l?.items) ? l.items : []
      };
    });
  }

  let active = (typeof raw.active === 'string' && raw.active.trim()) ? raw.active.trim() : loadouts[0].name;
  if (active.toLowerCase() === 'default') active = DEFAULT_LOADOUT_NAME;
  if (!loadouts.some(l => l.name === active)) {
    active = loadouts[0].name;
  }

  return { active, loadouts };
}

export function getFavoritesState() {
  const fd = Core.getState().config?.frontend_data;
  return normalizeFavorites(fd?.favorites);
}

export function getActiveLoadoutName() {
  return getFavoritesState().active;
}

export function getActiveLoadout() {
  const state = getFavoritesState();
  return state.loadouts.find(l => l.name === state.active) || state.loadouts[0];
}

export function getActiveFavorites() {
  return getActiveLoadout().items;
}

export function saveFavorites(favState) {
  const state = normalizeFavorites(favState);
  const cfg = Core.getState().config;
  if (cfg?.frontend_data) {
    cfg.frontend_data.favorites = state;
  }
  if (configLoaded) Core.persistConfig({ immediate: true });
  window.dispatchEvent(new CustomEvent('quivit-favorites-changed'));
}

export function setActiveLoadout(name) {
  const state = getFavoritesState();
  if (!state.loadouts.some(l => l.name === name)) return;
  state.active = name;
  saveFavorites(state);
}

export function createLoadout(name) {
  const state = getFavoritesState();
  const trimmed = (name || '').trim();
  const finalName = trimmed || getNextLoadoutName(state);

  const existing = state.loadouts.find(l => l.name.toLowerCase() === finalName.toLowerCase());
  if (existing) {
    return existing;
  }
  const newLoadout = { name: finalName, items: [] };
  state.loadouts.push(newLoadout);
  saveFavorites(state);
  return newLoadout;
}

export function renameLoadout(oldName, newName) {
  const state = getFavoritesState();
  const loadout = state.loadouts.find(l => l.name === oldName);
  if (!loadout) return false;

  const trimmed = (newName || '').trim();
  const targetName = trimmed || getNextLoadoutName(state, oldName);

  if (targetName === oldName) {
    return true;
  }

  const existingIdx = state.loadouts.findIndex(
    l => l !== loadout && l.name.toLowerCase() === targetName.toLowerCase()
  );
  if (existingIdx !== -1) return false; // Name conflict

  loadout.name = targetName;
  if (state.active === oldName) {
    state.active = targetName;
  }
  saveFavorites(state);
  return true;
}

export function deleteLoadout(name) {
  const state = getFavoritesState();
  if (state.loadouts.length <= 1) return false; // Always keep at least one
  const idx = state.loadouts.findIndex(l => l.name === name);
  if (idx === -1) return false;

  state.loadouts.splice(idx, 1);
  if (state.active === name) {
    state.active = state.loadouts[0].name;
  }
  saveFavorites(state);
  return true;
}

export function isFavorite(path) {
  return getActiveFavorites().some(item => item.path === path);
}

export function toggleFavorite(entry) {
  const state = getFavoritesState();
  const activeLoadout = state.loadouts.find(l => l.name === state.active) || state.loadouts[0];
  const idx = activeLoadout.items.findIndex(item => item.path === entry.path);
  if (idx === -1) {
    activeLoadout.items.push({
      path: entry.path,
      name: entry.name,
      is_dir: entry.is_dir,
      is_drive: entry.is_drive,
      ext: entry.ext,
      is_hidden: entry.is_hidden
    });
  } else {
    activeLoadout.items.splice(idx, 1);
  }
  saveFavorites(state);
  return idx === -1;
}

export function getFavoritesCollapsed() {
  return Core.getState().config?.frontend_data?.favorites_collapsed === true;
}

export function saveFavoritesCollapsed(collapsed) {
  const fd = Core.getState().config?.frontend_data;
  if (!fd) return;
  const next = collapsed === true;
  if (fd.favorites_collapsed === next) return;
  fd.favorites_collapsed = next;
  if (configLoaded) Core.persistConfig({ immediate: true });
}

function getFavoriteTargetPath(favorite) {
  const path = favorite?.path;
  if (typeof path !== 'string' || !path) return '';
  const separator = path.indexOf('|');
  return separator === -1 ? path : path.slice(0, separator);
}

export async function reconcileFavorites() {
  if (reconciliationPromise) return reconciliationPromise;

  const invoke = window.__TAURI__?.core?.invoke?.bind(window.__TAURI__.core);
  const state = getFavoritesState();
  const allItems = state.loadouts.flatMap(l => l.items);
  if (typeof invoke !== 'function' || allItems.length === 0) return false;

  const uniquePaths = Array.from(new Set(allItems.map(getFavoriteTargetPath).filter(Boolean)));
  reconciliationPromise = Promise.all(uniquePaths.map(async targetPath => {
    try {
      const kind = await invoke('get_path_kind', { path: targetPath });
      return kind === 'missing' ? targetPath : null;
    } catch {
      return null;
    }
  })).then(missingPaths => {
    const missingSet = new Set(missingPaths.filter(Boolean));
    if (missingSet.size === 0) return false;

    let modified = false;
    const currentState = getFavoritesState();
    for (const loadout of currentState.loadouts) {
      const prevLen = loadout.items.length;
      loadout.items = loadout.items.filter(item => !missingSet.has(getFavoriteTargetPath(item)));
      if (loadout.items.length !== prevLen) {
        modified = true;
      }
    }

    if (modified) {
      saveFavorites(currentState);
      return true;
    }
    return false;
  }).finally(() => {
    reconciliationPromise = null;
  });

  return reconciliationPromise;
}
