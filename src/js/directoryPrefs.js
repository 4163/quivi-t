import { Core } from './core.js';
import { applySort } from './services/sorting.js';

export const DirectoryPrefs = {
  getSortPrefs(directoryPath) {
    const state = Core.getState();
    if (!state || !state.config || !state.config.frontend_data) return { col: 'name', desc: false };
    
    const fd = state.config.frontend_data;

    if (!fd.default_sort) fd.default_sort = { col: 'name', desc: false };
    if (!fd.directory_sort) fd.directory_sort = {};

    if (directoryPath && fd.directory_sort[directoryPath]) {
      return fd.directory_sort[directoryPath];
    }
    return fd.default_sort;
  },

  setSortPrefs(directoryPath, col, desc) {
    if (!directoryPath) return; // Global default is config-file-only, not UI-set
    const state = Core.getState();
    if (!state || !state.config || !state.config.frontend_data) return;
    
    const fd = state.config.frontend_data;
    if (!fd.default_sort) fd.default_sort = { col: 'name', desc: false };
    if (!fd.directory_sort) fd.directory_sort = {};

    // Only store deviations from the default; remove redundant entries
    if (col === fd.default_sort.col && desc === fd.default_sort.desc) {
      delete fd.directory_sort[directoryPath];
    } else {
      fd.directory_sort[directoryPath] = { col, desc };
      
      const keys = Object.keys(fd.directory_sort);
      if (keys.length > 100) {
         delete fd.directory_sort[keys[0]];
      }
    }
    
    Core.persistConfig();
  },

  sortCurrentState(directoryPath, col, desc) {
    if (!directoryPath) return; // No active directory, nothing to sort/persist.
    this.setSortPrefs(directoryPath, col, desc);
    const state = Core.getState();
    const sortedList = applySort(state.list, col, desc);
    
    // Keep the currently viewed file selected
    const newIdx = sortedList.findIndex(f => f.name === state.filename && !f.is_dir && !f.is_parent);
    Core.setListAndIndex(sortedList, newIdx);
  }

};
