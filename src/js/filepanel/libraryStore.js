/**
 * libraryStore.js - Pure data layer for the library file panel section.
 *
 * Communicates with Tauri IPC for library scanning and directory removal.
 * Persists collapsed states to localStorage. Zero DOM dependencies.
 */

import { DirectoryPrefs } from '../directoryPrefs.js';

let _libraryTreeCache = [];

export async function fetchLibraryTree() {
  if (!window.__TAURI__) {
    return [];
  }
  try {
    const tree = await window.__TAURI__.core.invoke('read_library_tree');
    _libraryTreeCache = Array.isArray(tree) ? tree : [];
    return _libraryTreeCache;
  } catch (err) {
    console.error('[LibraryStore] Failed to fetch library tree:', err);
    return [];
  }
}

export function getLibraryTree() {
  return _libraryTreeCache;
}

export function hasLibraryEntries(tree = _libraryTreeCache) {
  if (!Array.isArray(tree) || tree.length === 0) return false;
  return tree.some((provider) => hasProviderNodes(provider));
}

export function hasProviderNodes(provider) {
  return Array.isArray(provider?.nodes) && provider.nodes.length > 0;
}

export async function deleteLibraryEntry(path) {
  if (!window.__TAURI__ || !path) return false;
  try {
    await window.__TAURI__.core.invoke('remove_directory', { path });
    DirectoryPrefs.removeSortPrefs(path, { immediate: true });
    return true;
  } catch (err) {
    console.error('[LibraryStore] Failed to remove gallery:', err);
    throw err;
  }
}

export function getLibraryCollapsed() {
  try {
    return localStorage.getItem('quivit_library_collapsed') === 'true';
  } catch {
    return false;
  }
}

export function saveLibraryCollapsed(collapsed) {
  try {
    localStorage.setItem('quivit_library_collapsed', String(!!collapsed));
  } catch {}
}

export function getProviderCollapsed(providerName) {  if (!providerName) return false;
  try {
    const raw = localStorage.getItem('quivit_library_providers_collapsed');
    if (!raw) return false;
    const map = JSON.parse(raw);
    return map?.[providerName] === true;
  } catch {
    return false;
  }
}

export function saveProviderCollapsed(providerName, collapsed) {
  if (!providerName) return;
  try {
    const raw = localStorage.getItem('quivit_library_providers_collapsed');
    const map = raw ? JSON.parse(raw) : {};
    map[providerName] = !!collapsed;
    localStorage.setItem('quivit_library_providers_collapsed', JSON.stringify(map));
  } catch {}
}

// Provider display order is frontend state: first-seen order sticks, and
// names never seen before append at the end. Imports never move existing
// entries. Manual arrange builds on this same list later, so the backend
// stays out of ordering entirely.
export function getProviderOrder() {
  try {
    const raw = localStorage.getItem('quivit_library_provider_order');
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list.filter((n) => typeof n === 'string') : [];
  } catch {
    return [];
  }
}

export function saveProviderOrder(order) {
  try {
    localStorage.setItem('quivit_library_provider_order', JSON.stringify(order.filter((n) => typeof n === 'string')));
  } catch {}
}

const ACTIVE_PROVIDER_KEY = 'quivit_library_active_provider';
const ACTIVE_EXPLICIT_KEY = 'quivit_library_active_explicit';

// Direct image and video links import under this provider. It stays pinned
// above All in the Imports menu even before its first import lands.
export const MISC_PROVIDER = 'Misc';

export function getActiveProvider() {
  try {
    const raw = localStorage.getItem(ACTIVE_PROVIDER_KEY);
    if (typeof raw !== 'string') return null;
    const name = raw.trim();
    return name ? name : null;
  } catch {
    return null;
  }
}

export function setActiveProvider(nameOrNull, options = {}) {
  const next = (typeof nameOrNull === 'string' && nameOrNull.trim())
    ? nameOrNull.trim()
    : null;
  try {
    if (next === null) {
      localStorage.removeItem(ACTIVE_PROVIDER_KEY);
    } else {
      localStorage.setItem(ACTIVE_PROVIDER_KEY, next);
    }
    // Menu clicks latch explicitly. Auto-activate never sets this, so the
    // first import keeps following what was imported until the user picks.
    if (options.explicit === true) {
      localStorage.setItem(ACTIVE_EXPLICIT_KEY, 'true');
    }
  } catch {}
  if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
    window.dispatchEvent(new CustomEvent('quivit-library-active-changed', { detail: { active: next } }));
  }
  return next;
}

export function hasExplicitActiveChoice() {
  try {
    return localStorage.getItem(ACTIVE_EXPLICIT_KEY) === 'true';
  } catch {
    return false;
  }
}

export function clearExplicitActiveChoice() {
  try {
    localStorage.removeItem(ACTIVE_EXPLICIT_KEY);
  } catch {}
}

// Resolves the stored filter against the live tree. When the active
// provider is gone, heals to the nearest neighbor in the previous order
// (next first, then previous, tab-close style) and persists it, so the
// view follows the list instead of dropping to All. Pass the stored
// order captured before orderProviders prunes it.
export function resolveActiveProvider(tree = _libraryTreeCache, prevOrder = null) {
  const active = getActiveProvider();
  if (!active || !Array.isArray(tree)) return null;
  const present = tree.filter((p) => p?.name && hasProviderNodes(p));
  if (present.some((p) => p.name === active)) return active;
  const order = Array.isArray(prevOrder) && prevOrder.length > 0
    ? prevOrder
    : present.map((p) => p.name);
  let next = null;
  const at = order.indexOf(active);
  if (at !== -1) {
    for (let i = at + 1; i < order.length && !next; i++) {
      if (present.some((p) => p.name === order[i])) next = order[i];
    }
    for (let i = at - 1; i >= 0 && !next; i--) {
      if (present.some((p) => p.name === order[i])) next = order[i];
    }
  }
  if (!next && present.length > 0) next = present[0].name;
  setActiveProvider(next);
  return next;
}

export function orderProviders(tree = _libraryTreeCache) {
  if (!Array.isArray(tree)) return [];
  const stored = getProviderOrder();
  // Only providers holding imports keep rank. Emptied dirs drop out, so a
  // re-import appends newest instead of reclaiming its old slot.
  const present = new Set(tree.filter((p) => hasProviderNodes(p)).map((p) => p?.name).filter(Boolean));
  const kept = stored.filter((name) => present.has(name));
  for (const provider of tree) {
    if (provider?.name && hasProviderNodes(provider) && !kept.includes(provider.name)) {
      kept.push(provider.name);
    }
  }
  saveProviderOrder(kept);
  const rank = new Map(kept.map((name, index) => [name, index]));
  return [...tree].sort((a, b) => (rank.get(a?.name) ?? Infinity) - (rank.get(b?.name) ?? Infinity));
}
