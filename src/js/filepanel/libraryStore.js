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

export function hasGalleries(tree = _libraryTreeCache) {
  if (!Array.isArray(tree) || tree.length === 0) return false;
  return tree.some((p) => Array.isArray(p.galleries) && p.galleries.length > 0);
}

export async function deleteGallery(path) {
  if (!window.__TAURI__ || !path) return false;
  try {
    await window.__TAURI__.core.invoke('remove_directory', { path });
    for (const provider of _libraryTreeCache) {
      if (Array.isArray(provider.galleries)) {
        const idx = provider.galleries.findIndex((g) => g.path === path);
        if (idx !== -1) {
          provider.galleries.splice(idx, 1);
          break;
        }
      }
    }
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

export function getProviderCollapsed(providerName) {
  if (!providerName) return false;
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
