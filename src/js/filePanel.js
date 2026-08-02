/**
 * filePanel.js - file list rendering, sorting, and column resizing.
 */
import { DirectoryPrefs } from './directoryPrefs.js';

const MIN_COL_WIDTHS = {
  name: 64,
  ext: 38,
  date: 92,
};

let filePanel = null;
let breadcrumbEl = null;
let fileListUl = null;
let resizeHandle = null;
let Core = null;
let Viewer = null;

let isResizingPanel = false;
let resizingCol = null;
let startX = 0;
let startWidth = 0;
let columnResizeMoved = false;

let lastRenderedList = null;
let lastClickTime = 0;
let lastClickIndex = -1;
let currentPath = '';

// Favorites
const FAVORITES_KEY = 'quivit-favorites';
let favoritesExpanded = false;
let favoritesBtnEl = null;
let favoritesListUl = null;
let favoritesHeaderEl = null;

let columnsInitialized = false;

function setColumnWidth(col, width) {
  document.documentElement.style.setProperty(`--col-${col}-w`, `${Math.round(width)}px`);
}

function getColumnWidth(col) {
  const value = getComputedStyle(document.documentElement).getPropertyValue(`--col-${col}-w`).trim();
  const parsed = parseFloat(value);
  return Number.isFinite(parsed) ? parsed : MIN_COL_WIDTHS[col];
}

function normalizeColumnWidths(preferredCol = 'name', preferredWidth = null) {
  const panelWidth = Math.max(filePanel.getBoundingClientRect().width - 8, 120);
  const cols = {
    name: getColumnWidth('name'),
    ext: getColumnWidth('ext'),
    date: getColumnWidth('date'),
  };

  if (preferredWidth !== null) cols[preferredCol] = preferredWidth;

  cols.name = Math.max(MIN_COL_WIDTHS.name, cols.name);
  cols.ext = Math.max(MIN_COL_WIDTHS.ext, cols.ext);
  cols.date = Math.max(MIN_COL_WIDTHS.date, cols.date);

  const fixedOthers = Object.entries(cols)
    .filter(([col]) => col !== preferredCol)
    .reduce((sum, [, width]) => sum + width, 0);

  cols[preferredCol] = Math.max(
    MIN_COL_WIDTHS[preferredCol],
    Math.min(cols[preferredCol], panelWidth - fixedOthers),
  );

  let total = cols.name + cols.ext + cols.date;
  if (total > panelWidth) {
    const order = preferredCol === 'date'
      ? ['name', 'ext']
      : preferredCol === 'ext'
        ? ['name', 'date']
        : ['ext', 'date'];

    for (const col of order) {
      const overflow = total - panelWidth;
      if (overflow <= 0) break;
      const shrink = Math.min(overflow, cols[col] - MIN_COL_WIDTHS[col]);
      cols[col] -= shrink;
      total -= shrink;
    }
  }

  setColumnWidth('name', cols.name);
  setColumnWidth('ext', cols.ext);
  setColumnWidth('date', cols.date);
}

function initializeColumns() {
  if (columnsInitialized) return;
  columnsInitialized = true;

  const panelWidth = Math.max(filePanel.getBoundingClientRect().width - 8, 120);
  const date = 92;
  const ext = 46;
  setColumnWidth('date', date);
  setColumnWidth('ext', ext);
  setColumnWidth('name', Math.max(MIN_COL_WIDTHS.name, panelWidth - date - ext));
}

function updateSortIcons() {
  document.querySelectorAll('.header-cell .sort-icon').forEach(icon => icon.textContent = '');
  const prefs = DirectoryPrefs.getSortPrefs(currentPath);
  const activeCell = document.querySelector(`.header-cell[data-sort="${prefs.col}"]`);
  if (activeCell) {
    activeCell.querySelector('.sort-icon').textContent = prefs.desc ? '▼' : '▲';
  }
}

function formatBreadcrumbPath(path) {
  return path ? path.replace(/[\\/]+/g, ' > ') : '';
}

function renderBreadcrumb(state) {
  if (!breadcrumbEl) return;
  const path = state.mode === 'archive' ? state.archivePath : state.directory;
  breadcrumbEl.textContent = formatBreadcrumbPath(path);
  breadcrumbEl.title = path || '';
}

// --- Favorites helpers ---

function getFavorites() {
  try { return JSON.parse(localStorage.getItem(FAVORITES_KEY)) || []; } catch { return []; }
}

function saveFavorites(favs) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify(favs));
}

function isFavorite(path) {
  return getFavorites().some(f => f.path === path);
}

function toggleFavorite(entry) {
  let favs = getFavorites();
  const idx = favs.findIndex(f => f.path === entry.path);
  if (idx === -1) {
    favs.push({ path: entry.path, name: entry.name, is_dir: entry.is_dir, is_drive: entry.is_drive, ext: entry.ext });
  } else {
    favs.splice(idx, 1);
  }
  saveFavorites(favs);
  return idx === -1;
}

function updateFavoriteBtn(path) {
  if (!favoritesBtnEl) return;
  const starred = isFavorite(path);
  const svg = favoritesBtnEl.querySelector('svg');
  if (svg) svg.setAttribute('fill', starred ? 'currentColor' : 'none');
  favoritesBtnEl.title = starred ? 'Remove from Favorites' : 'Add to Favorites';
  favoritesBtnEl.classList.toggle('active', starred);
}

// Extensions with custom ICO files in /assets/icons/
const CUSTOM_ICON_EXTS = new Set(['apng', 'cbz', 'cbr', 'gif', 'svg', 'webp']);
// Map extensions to their icon filename (for grouped exts like cbr -> cbz.ico)
const ICON_FILE_MAP = {
  cbr: 'cbz',
};

function getIconSvg(item) {
  if (item.is_drive) {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"></line><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path><line x1="6" y1="16" x2="6.01" y2="16"></line><line x1="10" y1="16" x2="10.01" y2="16"></line></svg>';
  } else if (item.is_dir || item.is_parent) {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
  }

  const ext = (item.ext || '').toLowerCase();

  if (CUSTOM_ICON_EXTS.has(ext)) {
    const file = ICON_FILE_MAP[ext] || ext;
    return `<img src="/assets/icons/${file}.ico" width="14" height="14" style="object-fit:contain;image-rendering:auto" draggable="false">`;
  } else if (ext.match(/^(zip|rar|7z|cb7|tar|gz|bz2)$/)) {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20 6h-8l-2-2H4c-1.11 0-1.99.89-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2zm-9 3h2v2h-2V9zm0 4h2v2h-2v-2zm0 4h2v2h-2v-2z"/></svg>';
  } else {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>';
  }
}

function buildFavoriteEntry(fav) {
  const li = document.createElement('li');
  li.title = fav.name;
  
  const itemName = document.createElement('span');
  itemName.className = 'item-name';
  itemName.innerHTML = getIconSvg(fav);
  
  const itemLabel = document.createElement('span');
  itemLabel.className = 'item-label';
  itemLabel.textContent = fav.name;
  itemName.appendChild(itemLabel);
  
  const itemExt = document.createElement('span');
  itemExt.className = 'item-ext';
  itemExt.textContent = fav.ext || '';
  
  const itemDate = document.createElement('span');
  itemDate.className = 'item-date';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'fav-remove';
  removeBtn.title = 'Remove';
  removeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';
  removeBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    const favs = getFavorites().filter(f => f.path !== fav.path);
    saveFavorites(favs);
    renderFavorites();
    updateFavoriteBtn(Core.getState().list?.[Core.getState().index]?.path || '');
  });

  li.appendChild(itemName);
  li.appendChild(itemExt);
  li.appendChild(itemDate);
  li.appendChild(removeBtn);

  li.addEventListener('click', () => {
    const { FsUtils } = window._quivitFsUtils || {};
    if (FsUtils) {
      FsUtils.loadFile(fav.path).catch(console.error);
    } else if (window.__TAURI__) {
      window.dispatchEvent(new CustomEvent('quivit-load-file', { detail: fav.path }));
    }
  });

  return li;
}

function renderFavorites() {
  if (!favoritesListUl) return;
  const favs = getFavorites();
  
  if (favoritesHeaderEl) {
    favoritesHeaderEl.style.display = favs.length > 0 ? 'flex' : 'none';
  }
  
  favoritesListUl.innerHTML = '';
  if (favs.length === 0) {
    favoritesExpanded = false;
    const panel = document.getElementById('file-panel-favorites');
    if (panel) panel.classList.add('collapsed');
  } else {
    favs.forEach(fav => favoritesListUl.appendChild(buildFavoriteEntry(fav)));
  }
}

function toggleFavoritesExpanded() {
  favoritesExpanded = !favoritesExpanded;
  const panel = document.getElementById('file-panel-favorites');
  if (panel) panel.classList.toggle('collapsed', !favoritesExpanded);
  const icon = favoritesHeaderEl?.querySelector('.toggle-icon');
  if (icon) icon.textContent = favoritesExpanded ? '▲' : '▼';
  if (favoritesExpanded) renderFavorites();
}

function renderEntry(item, index, selectedIndex) {
  const li = document.createElement('li');
  if (index === selectedIndex) li.classList.add('selected');
  if (item.name !== '..') {
    li.title = item.name;
  }

  const itemName = document.createElement('span');
  itemName.className = 'item-name';

  itemName.innerHTML = getIconSvg(item);

  const itemLabel = document.createElement('span');
  itemLabel.className = 'item-label';
  itemLabel.textContent = item.name;
  itemName.appendChild(itemLabel);

  const itemExt = document.createElement('span');
  itemExt.className = 'item-ext';
  itemExt.textContent = item.ext || '';

  const itemDate = document.createElement('span');
  itemDate.className = 'item-date';
  itemDate.textContent = item.date || '';

  li.appendChild(itemName);
  li.appendChild(itemExt);
  li.appendChild(itemDate);
  
  li.setAttribute('role', 'option');
  li.setAttribute('tabindex', '0');

  li.addEventListener('focus', () => {
    if (Core.getState().index !== index) {
      Core.selectIndex(index);
    }
  });

  li.addEventListener('click', (e) => {
    Core.selectIndex(index);
    const now = Date.now();
    if (lastClickIndex === index && (now - lastClickTime < 400)) {
      Core.jumpToIndex(index);
      lastClickTime = 0;
      lastClickIndex = -1;
    } else {
      lastClickTime = now;
      lastClickIndex = index;
    }
  });

  return li;
}

function updateSelection(selectedIndex) {
  const previous = fileListUl.querySelector('.selected');
  if (previous) previous.classList.remove('selected');
  
  if (selectedIndex >= 0 && selectedIndex < fileListUl.children.length) {
    const li = fileListUl.children[selectedIndex];
    li.classList.add('selected');
    li.scrollIntoView({ block: 'nearest' });
    
    const wasFocused = document.activeElement && fileListUl.contains(document.activeElement);
    if (wasFocused) {
      li.focus({ preventScroll: true });
    }
  }
}

export function renderFilePanel(state) {
  filePanel.classList.toggle('hidden', !state.fileListVisible);
  renderBreadcrumb(state);

  // Update favorite star button for current entry (images and folders; not ..)
  {
    const entry = state.list[state.index];
    if (entry && !entry.is_parent) {
      updateFavoriteBtn(entry.path);
      if (favoritesBtnEl) favoritesBtnEl.disabled = false;
    } else {
      if (favoritesBtnEl) {
        favoritesBtnEl.disabled = true;
        const svg = favoritesBtnEl.querySelector('svg');
        if (svg) svg.setAttribute('fill', 'none');
        favoritesBtnEl.classList.remove('active');
      }
    }
  }

  const currentDir = state.mode === 'archive' ? state.archivePath : state.directory;
  if (currentDir !== currentPath) {
    currentPath = currentDir;
    updateSortIcons();
  }

  if (lastRenderedList === state.list) {
    updateSelection(state.index);
    return;
  }
  lastRenderedList = state.list;

  const wasFocused = document.activeElement && fileListUl.contains(document.activeElement);

  fileListUl.innerHTML = '';
  state.list.forEach((item, index) => {
    const li = renderEntry(item, index, state.index);
    fileListUl.appendChild(li);

    if (index === state.index) {
      li.scrollIntoView({ block: 'nearest' });
      if (wasFocused) {
        li.focus({ preventScroll: true });
      }
    }
  });
}

export function initFilePanel(deps) {
  ({ filePanel, breadcrumbEl, fileListUl, resizeHandle, Core, Viewer } = deps);

  // Wire favorites UI
  favoritesBtnEl = document.getElementById('btn-favorite-current');
  favoritesListUl = document.getElementById('favorites-list');
  favoritesHeaderEl = document.getElementById('file-panel-favorites-header');

  if (favoritesBtnEl) {
    favoritesBtnEl.disabled = true;
    favoritesBtnEl.addEventListener('click', () => {
      const state = Core.getState();
      const entry = state.list[state.index];
      if (!entry || entry.is_parent) return;
      const wasEmpty = getFavorites().length === 0;
      toggleFavorite(entry);
      updateFavoriteBtn(entry.path);
      renderFavorites();
      // Auto-expand when adding the very first favorite
      if (wasEmpty && getFavorites().length > 0 && !favoritesExpanded) {
        toggleFavoritesExpanded();
      }
    });
  }

  if (favoritesHeaderEl) {
    favoritesHeaderEl.addEventListener('click', toggleFavoritesExpanded);
    favoritesHeaderEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFavoritesExpanded(); }
    });
  }

  // Initialize favorites header visibility
  renderFavorites();

  // Allow favorites entries to load files via custom event
  window.addEventListener('quivit-load-file', (e) => {
    if (deps.FsUtils) deps.FsUtils.loadFile(e.detail).catch(console.error);
  });

  initializeColumns();
  updateSortIcons();

  fileListUl.addEventListener('click', (e) => {
    if (e.target === fileListUl) {
      Core.selectIndex(-1);
    }
  });

  // Composite widget keyboard navigation
  fileListUl.addEventListener('keydown', (e) => {
    const state = Core.getState();
    const list = state.list;
    if (!list.length) return;

    const currentIndex = state.index;

    switch (e.key) {
      case 'ArrowDown': {
        e.preventDefault();
        e.stopPropagation();
        const next = currentIndex === -1 ? 0 : Math.min(currentIndex + 1, list.length - 1);
        Core.selectIndex(next);
        break;
      }
      case 'ArrowUp': {
        e.preventDefault();
        e.stopPropagation();
        const prev = currentIndex === -1 ? list.length - 1 : Math.max(currentIndex - 1, 0);
        Core.selectIndex(prev);
        break;
      }
      case 'Home': {
        e.preventDefault();
        Core.selectIndex(0);
        break;
      }
      case 'End': {
        e.preventDefault();
        Core.selectIndex(list.length - 1);
        break;
      }
      case 'Enter':
      case ' ': {
        if (currentIndex !== -1) {
          e.preventDefault();
          Core.jumpToIndex(currentIndex);
        }
        break;
      }
      case 'Escape': {
        e.preventDefault();
        Core.selectIndex(-1);
        // Blurring the active li
        if (document.activeElement && fileListUl.contains(document.activeElement)) {
          document.activeElement.blur();
        }
        break;
      }
      default:
        break;
    }
  });

  resizeHandle.addEventListener('mousedown', (e) => {
    isResizingPanel = true;
    resizeHandle.classList.add('dragging');
    document.body.style.cursor = 'ew-resize';
    e.preventDefault();
  });

  document.querySelectorAll('.header-cell').forEach(cell => {
    cell.addEventListener('click', () => {
      if (resizingCol) return;
      if (columnResizeMoved) {
        columnResizeMoved = false;
        return;
      }

      const col = cell.dataset.sort;
      const prefs = DirectoryPrefs.getSortPrefs(currentPath);
      let desc = false;
      if (prefs.col === col) {
        desc = !prefs.desc;
      }
      
      DirectoryPrefs.sortCurrentState(currentPath, col, desc);
      updateSortIcons();
    });
  });

  document.querySelectorAll('.col-resizer').forEach(resizer => {
    resizer.addEventListener('mousedown', (e) => {
      resizingCol = resizer.parentElement;
      startX = e.clientX;
      startWidth = resizingCol.offsetWidth;
      columnResizeMoved = false;
      resizer.classList.add('dragging');
      document.body.style.cursor = 'col-resize';
      e.preventDefault();
      e.stopPropagation();
    });
  });

  window.addEventListener('mousemove', (e) => {
    if (isResizingPanel) {
      const oldWidth = filePanel.getBoundingClientRect().width;
      const newWidth = Math.min(480, Math.max(120, e.clientX));
      filePanel.style.width = `${newWidth}px`;
      normalizeColumnWidths('name', getColumnWidth('name') + (newWidth - oldWidth));
      Viewer.applyFitMode();
    }

    if (resizingCol) {
      const delta = e.clientX - startX;
      if (Math.abs(delta) > 2) columnResizeMoved = true;

      if (resizingCol.classList.contains('col-name')) {
        normalizeColumnWidths('name', startWidth + delta);
      } else if (resizingCol.classList.contains('col-ext')) {
        normalizeColumnWidths('ext', startWidth + delta);
      } else if (resizingCol.classList.contains('col-date')) {
        normalizeColumnWidths('date', startWidth + delta);
      }
    }
  });

  window.addEventListener('mouseup', () => {
    if (isResizingPanel) {
      isResizingPanel = false;
      resizeHandle.classList.remove('dragging');
      document.body.style.cursor = '';
    }

    if (resizingCol) {
      resizingCol.querySelector('.col-resizer').classList.remove('dragging');
      resizingCol = null;
      document.body.style.cursor = '';
    }
  });
}
