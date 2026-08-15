import { Core } from './core.js';

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
    if (!directoryPath) return; // No active directory — nothing to sort/persist
    this.setSortPrefs(directoryPath, col, desc);
    const state = Core.getState();
    const sortedList = this.applySort(state.list, col, desc);
    
    // Keep the currently viewed file selected
    const newIdx = sortedList.findIndex(f => f.name === state.filename && !f.is_dir && !f.is_parent);
    Core.setListAndIndex(sortedList, newIdx);
  },

  naturalCompare(a, b) {
    const ax = [], bx = [];
    a.replace(/(\d+)|(\D+)/g, function (_, $1, $2) { ax.push([$1 || Infinity, $2 || ""]); });
    b.replace(/(\d+)|(\D+)/g, function (_, $1, $2) { bx.push([$1 || Infinity, $2 || ""]); });
    while (ax.length && bx.length) {
      const an = ax.shift();
      const bn = bx.shift();
      const nn = (an[0] - bn[0]) || an[1].localeCompare(bn[1]);
      if (nn) return nn;
    }
    return ax.length - bx.length;
  },

  applySort(list, col, desc) {
    if (!list || list.length <= 1) return list;

    const parents = [];
    const dirs = [];
    const files = [];
    for (const item of list) {
      if (item.is_parent) parents.push(item);
      else if (item.is_dir || item.is_drive) dirs.push(item);
      else files.push(item);
    }

    const sortLogic = (a, b) => {
      let valA, valB;
      if (col === 'name') {
        valA = a.name.toLowerCase();
        valB = b.name.toLowerCase();
      } else if (col === 'ext') {
        valA = a.ext.toLowerCase();
        valB = b.ext.toLowerCase();
        if (valA === valB) {
          valA = a.name.toLowerCase();
          valB = b.name.toLowerCase();
        }
      } else if (col === 'date') {
        const dA = a.rawDate || 0;
        const dB = b.rawDate || 0;
        if (dA !== dB) return desc ? dB - dA : dA - dB;
        valA = a.name.toLowerCase();
        valB = b.name.toLowerCase();
      }

      if (col === 'name' || (col === 'ext' && a.ext.toLowerCase() === b.ext.toLowerCase()) || (col === 'date' && a.rawDate === b.rawDate)) {
        const cmp = this.naturalCompare(valA, valB);
        return desc ? -cmp : cmp;
      }

      if (valA < valB) return desc ? 1 : -1;
      if (valA > valB) return desc ? -1 : 1;
      return 0;
    };

    dirs.sort(sortLogic);
    files.sort(sortLogic);

    return parents.concat(dirs).concat(files);
  }
};
