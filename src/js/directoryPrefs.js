import { Core } from './core.js';
import { applySort } from './services/sorting.js';
import { normalizePathKey, pathsEqual } from './services/pathUtils.js';
import { splitArchivePath } from './services/archivePath.js';

let sortReconciliationPromise = null;

function isColumnEnabled(col, fd) {
  if (!col || col === 'name') return true;
  if (!['ext', 'date', 'size', 'dims'].includes(col)) return false;
  const cols = fd?.file_list_columns;
  if (!cols || typeof cols !== 'object') {
    return true;
  }
  if (col === 'ext' || col === 'date') {
    return cols[col] !== false;
  }
  return Boolean(cols[col]);
}

function resolveEnabledSortPref(pref, fd) {
  if (pref && isColumnEnabled(pref.col, fd)) {
    return pref;
  }
  const def = fd?.default_sort || { col: 'name', desc: false };
  if (isColumnEnabled(def.col, fd)) {
    return def;
  }
  return { col: 'name', desc: false };
}

export const DirectoryPrefs = {
  isColumnEnabled(col) {
    const fd = Core.getState()?.config?.frontend_data;
    return isColumnEnabled(col, fd);
  },

  sortList(list, col, desc) {
    return applySort(list, col, desc, Core.getState().manhwaEnabled);
  },

  getSortPrefs(directoryPath) {
    const state = Core.getState();
    if (!state || !state.config || !state.config.frontend_data) return { col: 'name', desc: false };
    
    const fd = state.config.frontend_data;

    if (!fd.default_sort) fd.default_sort = { col: 'name', desc: false };
    if (!fd.directory_sort) fd.directory_sort = {};

    if (directoryPath) {
      if (fd.directory_sort[directoryPath]) {
        return resolveEnabledSortPref(fd.directory_sort[directoryPath], fd);
      }
      for (const [key, pref] of Object.entries(fd.directory_sort)) {
        if (pathsEqual(key, directoryPath)) {
          return resolveEnabledSortPref(pref, fd);
        }
      }
    }
    return resolveEnabledSortPref(fd.default_sort, fd);
  },

  setSortPrefs(directoryPath, col, desc) {
    if (!directoryPath) return; // Global default is config-file-only, not UI-set
    const state = Core.getState();
    if (!state || !state.config || !state.config.frontend_data) return;
    
    const fd = state.config.frontend_data;
    if (!fd.default_sort) fd.default_sort = { col: 'name', desc: false };
    if (!fd.directory_sort) fd.directory_sort = {};

    for (const key of Object.keys(fd.directory_sort)) {
      if (pathsEqual(key, directoryPath)) {
        delete fd.directory_sort[key];
      }
    }

    // Only store deviations from the default; remove redundant entries
    if (col === fd.default_sort.col && desc === fd.default_sort.desc) {
      // Reverted to default, already deleted
    } else {
      fd.directory_sort[directoryPath] = { col, desc };
      
      const keys = Object.keys(fd.directory_sort);
      if (keys.length > 100) {
        delete fd.directory_sort[keys[0]];
      }
    }
    
    Core.persistConfig();
  },

  removeSortPrefs(directoryPath, options = {}) {
    if (!directoryPath) return false;
    const state = Core.getState();
    const fd = state?.config?.frontend_data;
    if (!fd?.directory_sort) return false;

    let removed = false;
    if (fd.directory_sort[directoryPath]) {
      delete fd.directory_sort[directoryPath];
      removed = true;
    }

    for (const key of Object.keys(fd.directory_sort)) {
      if (pathsEqual(key, directoryPath)) {
        delete fd.directory_sort[key];
        removed = true;
      }
    }

    if (removed) {
      Core.persistConfig(options);
    }
    return removed;
  },

  async reconcileDirectorySort() {
    if (sortReconciliationPromise) return sortReconciliationPromise;

    const invoke = window.__TAURI__?.core?.invoke?.bind(window.__TAURI__.core);
    const state = Core.getState();
    const fd = state?.config?.frontend_data;
    const directorySort = fd?.directory_sort;
    if (typeof invoke !== 'function' || !directorySort) return false;

    const movingLibrary = await window.__TAURI__?.core
      ?.invoke('library_move_in_progress')
      .catch(() => false);
    if (movingLibrary) return false;

    const paths = Object.keys(directorySort);
    if (paths.length === 0) return false;

    sortReconciliationPromise = Promise.all(paths.map(async (path) => {
      if (!path || path === 'Drives' || path === '__DRIVES__') return null;

      const targetPath = splitArchivePath(path).archivePath;

      try {
        const kind = await invoke('get_path_kind', { path: targetPath });
        return kind === 'missing' ? path : null;
      } catch (err) {
        console.warn('[DirectoryPrefs] Failed to validate saved sort path:', err);
        return null;
      }
    })).then((stalePaths) => {
      const stale = new Set(stalePaths.filter(Boolean));
      if (stale.size === 0) return false;

      const currentFd = Core.getState()?.config?.frontend_data;
      if (!currentFd?.directory_sort) return false;

      let changed = false;
      for (const path of stale) {
        if (path in currentFd.directory_sort) {
          delete currentFd.directory_sort[path];
          changed = true;
        }
      }

      if (changed) {
        Core.persistConfig({ immediate: true });
      }
      return changed;
    }).finally(() => {
      sortReconciliationPromise = null;
    });

    return sortReconciliationPromise;
  },

  sortCurrentState(directoryPath, col, desc) {
    if (!directoryPath) return; // No active directory, nothing to sort/persist.
    this.setSortPrefs(directoryPath, col, desc);
    const state = Core.getState();
    const sortedList = this.sortList(state.list, col, desc);
    
    // Keep the currently viewed file selected
    const newIdx = sortedList.indexOf(state.list[state.index]);
    Core.setListAndIndex(sortedList, newIdx);
  }
};
