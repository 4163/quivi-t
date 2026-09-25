/**
 * bookmarksStore.js - Pure data layer for bookmarks.
 * Communicates with Core for persistence.
 */

import { Core } from '../core.js';

let configLoaded = false;
let reconciliationPromise = null;

window.addEventListener('quivit-config-loaded', () => {
  configLoaded = true;
});

export function getBookmarks() {
  const bms = Core.getState().config?.frontend_data?.bookmarks;
  return Array.isArray(bms) ? bms : [];
}

export function saveBookmarks(bms) {
  Core.getState().config.frontend_data.bookmarks = bms;
  // Bookmarks are rare explicit gestures; persist now so a config reload
  // never discards them inside the preference debounce window.
  if (configLoaded) Core.persistConfig({ immediate: true });
}

function getBookmarkTargetPath(bookmark) {
  const path = bookmark?.path;
  if (typeof path !== 'string' || !path) return '';

  // Archive-entry bookmarks use "<archive path>|<entry name>". The archive
  // itself is the filesystem target whose removal or move makes the bookmark
  // stale.
  const separator = path.indexOf('|');
  return separator === -1 ? path : path.slice(0, separator);
}

/**
 * Removes bookmarks whose filesystem target no longer exists. A move makes
 * the saved path missing, so it follows the same reconciliation path as a
 * deletion. Concurrent callers share one pass to avoid duplicate IPC work.
 */
export async function reconcileBookmarks() {
  if (reconciliationPromise) return reconciliationPromise;

  const invoke = window.__TAURI__?.core?.invoke?.bind(window.__TAURI__.core);
  const snapshot = getBookmarks().slice();
  if (typeof invoke !== 'function' || snapshot.length === 0) return false;

  reconciliationPromise = Promise.all(snapshot.map(async bookmark => {
    const targetPath = getBookmarkTargetPath(bookmark);
    if (!targetPath) return bookmark;

    try {
      const kind = await invoke('get_path_kind', { path: targetPath });
      return kind === 'missing' ? bookmark : null;
    } catch (err) {
      console.warn('[Bookmarks] Failed to validate saved path:', err);
      return null;
    }
  })).then(staleBookmarks => {
    const stale = new Set(staleBookmarks.filter(Boolean));
    if (stale.size === 0) return false;

    // Retain entries changed after this pass started. For example, a user can
    // remove and immediately re-add a bookmark while IPC is still resolving.
    const current = getBookmarks();
    const next = current.filter(bookmark => !stale.has(bookmark));
    if (next.length === current.length) return false;

    saveBookmarks(next);
    return true;
  }).finally(() => {
    reconciliationPromise = null;
  });

  return reconciliationPromise;
}

export function getBookmarksCollapsed() {
  return Core.getState().config?.frontend_data?.bookmarks_collapsed === true;
}

export function saveBookmarksCollapsed(collapsed) {
  const fd = Core.getState().config.frontend_data;
  const next = collapsed === true;
  if (fd.bookmarks_collapsed === next) return;
  fd.bookmarks_collapsed = next;
  if (configLoaded) Core.persistConfig({ immediate: true });
}

export function isBookmark(path) {
  return getBookmarks().some(b => b.path === path);
}

export function toggleBookmark(entry) {
  let bms = getBookmarks();
  const idx = bms.findIndex(b => b.path === entry.path);
  if (idx === -1) {
    bms.push({ path: entry.path, name: entry.name, is_dir: entry.is_dir, is_drive: entry.is_drive, ext: entry.ext, is_hidden: entry.is_hidden });
  } else {
    bms.splice(idx, 1);
  }
  saveBookmarks(bms);
  return idx === -1;
}
