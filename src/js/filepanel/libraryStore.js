/**
 * libraryStore.js - Pure data layer for the library file panel section.
 *
 * Communicates with Tauri IPC for library scanning and directory removal.
 * Persists collapsed states to localStorage. Zero DOM dependencies.
 */

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
  return tree.some((provider) => hasNodes(provider.nodes));
}

function hasNodes(nodes) {
  return Array.isArray(nodes) && nodes.length > 0;
}

export async function deleteLibraryEntry(path) {
  if (!window.__TAURI__ || !path) return false;
  try {
    await window.__TAURI__.core.invoke('remove_directory', { path });
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

export function orderProviders(tree = _libraryTreeCache) {
  if (!Array.isArray(tree)) return [];
  const stored = getProviderOrder();
  const present = new Set(tree.map((p) => p?.name).filter(Boolean));
  const kept = stored.filter((name) => present.has(name));
  for (const provider of tree) {
    if (provider?.name && !kept.includes(provider.name)) {
      kept.push(provider.name);
    }
  }
  saveProviderOrder(kept);
  const rank = new Map(kept.map((name, index) => [name, index]));
  return [...tree].sort((a, b) => (rank.get(a?.name) ?? -1) - (rank.get(b?.name) ?? -1));
}
