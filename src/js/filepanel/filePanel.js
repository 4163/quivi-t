/**
 * filePanel.js: file list rendering, sorting, and column resizing.
 */
import { DirectoryPrefs } from '../directoryPrefs.js';
import { makeContainerNavigable } from '../keyboardNav.js';
import {
  getFavorites,
  getFavoritesCollapsed,
  saveFavoritesCollapsed,
  isFavorite,
  toggleFavorite,
  saveFavorites
} from './favoritesStore.js';
import { Core } from '../core.js';
import { FsUtils } from '../fsUtils.js';

const MIN_COL_WIDTHS = {
  name: 64,
  ext: 38,
  date: 92,
};

let filePanel = null;
let breadcrumbEl = null;
let fileListUl = null;
let resizeHandle = null;

let isResizingPanel = false;
let resizingCol = null;
let startX = 0;
let startWidth = 0;
let columnResizeMoved = false;

let lastRenderedList = null;
let lastScrolledIndex = -1;
let lastClickTime = 0;
let lastClickIndex = -1;
let pendingClickIndex = -1;

let currentPath = '';

// Virtualization
let domPool = [];
let scrollSpacer = null;
let ROW_HEIGHT = 0;
let POOL_SIZE = 0;

// Favorites
let favoritesExpanded = false;
let favoritesBtnEl = null;
let favoritesListUl = null;
let favoritesHeaderEl = null;

let favLastClickPath = '';
let favLastClickTime = 0;
let highlightedFavoritePath = '';
let refreshPulseTimer = null;
let hoverPreloadImg = null;
let hoverPreloadTimer = null;

let columnsInitialized = false;

// True while the user is navigating the panel with the keyboard.
// Prevents the viewport's image-load cycle from stealing focus away.
let panelKeyboardActive = false;

// After opening a favorite, move focus to the main file list. Most users open a
// favorite and then navigate nearby entries with arrow keys; keyboard users
// should not need to tab out of Favorites first.
let focusMainListOnNextRender = false;

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

// Favorites rendering.

function updateFavoriteBtn(path) {
  if (!favoritesBtnEl) return;
  const starred = isFavorite(path);
  const svg = favoritesBtnEl.querySelector('svg');
  if (svg) svg.setAttribute('fill', starred ? 'currentColor' : 'none');
  favoritesBtnEl.title = starred ? 'Remove from Favorites' : 'Add to Favorites';
  favoritesBtnEl.classList.toggle('active', starred);
}

export function toggleFavoriteCurrent() {
  if (!Core || !favoritesBtnEl) return;
  const state = Core.getState();
  const entry = state.list[state.index];
  if (!entry || entry.is_parent) return;
  const wasFavorite = isFavorite(entry.path);
  toggleFavorite(entry);
  updateFavoriteBtn(entry.path);
  // Reveal newly added favorites.
  if (!wasFavorite) {
    favoritesExpanded = true;
    saveFavoritesCollapsed(false);
  }
  renderFavorites();
}

const iconCache = new Map();



function fetchNativeIcon(ext) {
  if (iconCache.has(ext)) return;
  iconCache.set(ext, 'pending');

  if (window.__TAURI__) {
    const extArg = ext === '__folder__' ? ext : '.' + ext;
      window.__TAURI__.core.invoke('get_native_icon', { ext: extArg })
      .then(src => {
        iconCache.set(ext, src || '');
        document.querySelectorAll(`img[data-ext="${CSS.escape(ext)}"]`).forEach(img => {
          if (src) {
            img.src = src;
            img.removeAttribute('data-ext');
          } else {
            // Generic fallback icon.
            const isFolder = ext === '__folder__';
            img.outerHTML = isFolder
              ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>'
              : '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>';
          }
        });
      })
      .catch(err => console.error('Failed to get native icon:', err));
  }
}

function getIconHtml(item) {
  if (item.is_drive) {
    return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"></line><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path><line x1="6" y1="16" x2="6.01" y2="16"></line><line x1="10" y1="16" x2="10.01" y2="16"></line></svg>';
  }
  
  let ext;
  let fallbackSvg;

  if (item.is_dir || item.is_parent) {
    ext = '__folder__';
    fallbackSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>';
  } else {
    ext = (item.ext || '').toLowerCase();
    fallbackSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>';
    if (!ext) return fallbackSvg;
  }

  if (iconCache.has(ext)) {
    const src = iconCache.get(ext);
    if (src === 'pending') {
      return `<img data-ext="${CSS.escape(ext)}" draggable="false" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCI+PC9zdmc+">`;
    }
    if (src) {
      return `<img src="${src}" draggable="false">`;
    }
    return fallbackSvg;
  }

  fetchNativeIcon(ext);
  return `<img data-ext="${CSS.escape(ext)}" draggable="false" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCI+PC9zdmc+">`;
}

function openFavorite(fav) {
  focusMainListOnNextRender = true;
  if (FsUtils) {
    FsUtils.loadFile(fav.path).catch(console.error);
  }
}

function buildFavoriteEntry(fav) {
  const li = document.createElement('li');
  // Full system path as tooltip. For archive entries ("archive|inner/path.png")
  // put the inner entry on its own line, keeping its native "/" separators.
  li.title = fav.path.includes('|')
    ? fav.path.replace('|', '\nEntry: ')
    : fav.path;
  li.dataset.path = fav.path;
  li.setAttribute('role', 'option');
  li.setAttribute('tabindex', '0');
  
  li.classList.toggle('is-hidden-entry', !!fav.is_hidden);

  const itemName = document.createElement('span');
  itemName.className = 'item-name';
  itemName.innerHTML = getIconHtml(fav);
  
  const itemLabel = document.createElement('span');
  itemLabel.className = 'item-label';
  itemLabel.textContent = fav.name;
  itemName.appendChild(itemLabel);
  
  const itemExt = document.createElement('span');
  itemExt.className = 'item-ext';
  itemExt.textContent = fav.is_dir ? 'DIR' : (fav.ext || '');
  
  const itemDate = document.createElement('span');
  itemDate.className = 'item-date';

  const removeBtn = document.createElement('button');
  removeBtn.className = 'fav-remove';
  removeBtn.title = 'Remove';
  removeBtn.tabIndex = -1;
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

  li.addEventListener('focus', () => {
    highlightFavoriteByPath(fav.path);
    if (favoritesListUl) {
      for (const row of favoritesListUl.children) {
        const btn = row.querySelector('.fav-remove');
        if (btn) btn.tabIndex = -1;
      }
    }
    removeBtn.tabIndex = 0;
  });

  removeBtn.addEventListener('focus', () => {
    if (favoritesListUl) {
      for (const row of favoritesListUl.children) {
        const btn = row.querySelector('.fav-remove');
        if (btn) btn.tabIndex = -1;
      }
    }
    removeBtn.tabIndex = 0;
  });

  li.addEventListener('click', () => {
    highlightFavoriteByPath(fav.path);
    const isDirOrArchive = fav.is_dir || (fav.ext && FsUtils && FsUtils.isArchive(fav.name));
    if (isDirOrArchive) {
      const now = Date.now();
      if (favLastClickPath === fav.path && (now - favLastClickTime < 400)) {
        favLastClickPath = '';
        favLastClickTime = 0;
        openFavorite(fav);
      } else {
        favLastClickPath = fav.path;
        favLastClickTime = now;
      }
    } else {
      openFavorite(fav);
    }
  });

  return li;
}

function renderFavorites() {
  if (!favoritesListUl) return;
  const favs = getFavorites();
  
  if (favoritesHeaderEl) {
    favoritesHeaderEl.classList.toggle('hidden', favs.length === 0);
  }
  
  favoritesListUl.innerHTML = '';
  const panel = document.getElementById('file-panel-favorites');
  if (favs.length === 0) {
    favoritesExpanded = false;
    saveFavoritesCollapsed(true);
  } else {
    favs.forEach(fav => favoritesListUl.appendChild(buildFavoriteEntry(fav)));
  }
  if (panel) {
    panel.classList.toggle('collapsed', !favoritesExpanded);
    const icon = favoritesHeaderEl?.querySelector('.toggle-icon');
    if (icon) icon.textContent = favoritesExpanded ? '▲' : '▼';
  }
  if (Core) updateFavoritesSelection(Core.getState());
}

function toggleFavoritesExpanded() {
  favoritesExpanded = !favoritesExpanded;
  saveFavoritesCollapsed(!favoritesExpanded);
  const panel = document.getElementById('file-panel-favorites');
  if (panel) panel.classList.toggle('collapsed', !favoritesExpanded);
  const icon = favoritesHeaderEl?.querySelector('.toggle-icon');
  if (icon) icon.textContent = favoritesExpanded ? '▲' : '▼';
  if (favoritesExpanded) renderFavorites();
}

function updateFavoritesSelection(state) {
  if (!favoritesListUl) return;
  // The current folder/archive takes priority over the selected entry, so a
  // favorited location stays highlighted no matter which item is active.
  const containerPath = state.mode === 'archive' ? state.archivePath : state.directory;
  let activePath = '';
  if (containerPath && isFavorite(containerPath)) {
    activePath = containerPath;
  } else {
    const entry = state.list?.[state.index];
    if (entry && !entry.is_parent) {
      activePath = entry.path;
    }
  }
  for (const li of favoritesListUl.children) {
    li.classList.toggle('selected', li.dataset.path === activePath);
  }
}

function highlightFavoriteByPath(path) {
  highlightedFavoritePath = path;
  if (!favoritesListUl) return;
  for (const li of favoritesListUl.children) {
    li.classList.toggle('selected', li.dataset.path === path);
  }
}

// Returns the favorite entry currently highlighted in the favorites list (via
// focus/click), else null so the file panel action buttons fall back to the
// main file-list selection.
export function getHighlightedFavorite() {
  if (!highlightedFavoritePath) return null;
  return getFavorites().find(f => f.path === highlightedFavoritePath) || null;
}

// Move the highlighted favorite by delta (mirrors ArrowDown/ArrowUp). Moves the
// row highlight only; opening still requires Enter/Space/click.
export function navigateHighlightedFavorite(delta) {
  if (!favoritesListUl) return;
  const items = Array.from(favoritesListUl.children);
  if (!items.length) return;
  const currentIndex = items.findIndex(li => li.dataset.path === highlightedFavoritePath);
  let nextIndex;
  if (currentIndex === -1) {
    nextIndex = delta > 0 ? 0 : items.length - 1;
  } else {
    nextIndex = (currentIndex + delta + items.length) % items.length;
  }
  items[nextIndex].focus();
}

function measureRowHeight() {
  const sentinel = document.getElementById('file-list-sentinel');
  ROW_HEIGHT = sentinel ? sentinel.getBoundingClientRect().height || 22 : 22;
}

function initDomPool() {
  // Clear existing pool elements after config reloads.
  domPool.forEach(li => li.remove());
  domPool = [];
  if (scrollSpacer) {
    scrollSpacer.remove();
    scrollSpacer = null;
  }

  POOL_SIZE = Math.ceil(window.screen.height / ROW_HEIGHT) + 20;
  
  for (let i = 0; i < POOL_SIZE; i++) {
    const li = document.createElement('li');
    li.style.display = 'none';
    
    const itemName = document.createElement('span');
    itemName.className = 'item-name';
    
    const itemLabel = document.createElement('span');
    itemLabel.className = 'item-label';
    itemName.appendChild(itemLabel);
    
    const itemExt = document.createElement('span');
    itemExt.className = 'item-ext';
    
    const itemDate = document.createElement('span');
    itemDate.className = 'item-date';
    
    li.appendChild(itemName);
    li.appendChild(itemExt);
    li.appendChild(itemDate);
    
    li.setAttribute('role', 'option');
    li.setAttribute('tabindex', '0');
    
    li.addEventListener('focus', () => {
      const idxStr = li.dataset.index;
      if (!idxStr) return;
      const index = parseInt(idxStr, 10);
      if (Core.getState().index !== index) {
        Core.selectIndex(index);
      }
    });

    li.addEventListener('mousedown', () => {
      const idxStr = li.dataset.index;
      pendingClickIndex = idxStr ? parseInt(idxStr, 10) : -1;
    });

    li.addEventListener('click', () => {
      const index = pendingClickIndex;
      if (index === -1) return;
      if (Core.getState().index !== index) {
        Core.selectIndex(index);
      }
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

    li.addEventListener('mouseenter', () => {
      clearTimeout(hoverPreloadTimer);
      if (hoverPreloadImg) {
        hoverPreloadImg.removeAttribute('src');
        hoverPreloadImg = null;
      }
      
      const idxStr = li.dataset.index;
      if (!idxStr) return;
      const index = parseInt(idxStr, 10);
      const state = Core.getState();
      const item = state.list[index];

      if (item && !item.is_dir && !item.is_parent && FsUtils.isImageEntry(item)) {
        hoverPreloadTimer = setTimeout(() => {
          let src;
          if (state.mode === 'archive') {
            src = FsUtils.isIco(item.name) ? null : FsUtils.buildArchiveSrc(state.archivePath, item.name);
          } else {
            src = FsUtils.isIco(item.path) ? null : FsUtils.buildFileSrcSync(item.path);
          }
          if (src && Core.getState().index !== index) {
            hoverPreloadImg = new Image();
            hoverPreloadImg.decoding = 'async';
            hoverPreloadImg.src = src;
            if (hoverPreloadImg.decode) hoverPreloadImg.decode().catch(() => {});
          }
        }, 90);
      }
    });

    li.addEventListener('mouseleave', () => {
      clearTimeout(hoverPreloadTimer);
      if (hoverPreloadImg) {
        hoverPreloadImg.removeAttribute('src');
        hoverPreloadImg = null;
      }
    });

    domPool.push(li);
    fileListUl.appendChild(li);
  }
  
  scrollSpacer = document.createElement('div');
  scrollSpacer.className = 'scroll-spacer';
  fileListUl.appendChild(scrollSpacer);
}

function updateEntry(li, item, index) {
  li.dataset.index = index;
  li.title = item.name !== '..' ? item.name : '';
  
  const itemName = li.querySelector('.item-name');
  itemName.innerHTML = getIconHtml(item);
  li.classList.toggle('is-hidden-entry', !!item.is_hidden);
  
  const itemLabel = document.createElement('span');
  itemLabel.className = 'item-label';
  itemLabel.textContent = item.name;
  itemName.appendChild(itemLabel);
  
  li.querySelector('.item-ext').textContent = item.ext || '';
  li.querySelector('.item-date').textContent = item.date || '';
  
  li.style.transform = `translateY(${index * ROW_HEIGHT}px)`;
  li.style.display = 'grid';
}

function renderVisibleSlice() {
  if (!lastRenderedList || lastRenderedList.length === 0) {
    domPool.forEach(li => li.style.display = 'none');
    if (scrollSpacer) scrollSpacer.style.height = '0px';
    return;
  }
  
  const state = Core.getState();
  const list = state.list;
  
  if (scrollSpacer) {
    scrollSpacer.style.height = `${list.length * ROW_HEIGHT}px`;
  }
  
  const scrollTop = fileListUl.scrollTop;
  const startIndex = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - 5);
  
  for (let i = 0; i < POOL_SIZE; i++) {
    const dataIndex = startIndex + i;
    const li = domPool[i];
    
    if (dataIndex >= 0 && dataIndex < list.length) {
      if (li.dataset.index !== String(dataIndex)) {
        updateEntry(li, list[dataIndex], dataIndex);
      }
      li.classList.toggle('selected', dataIndex === state.index);
    } else {
      li.style.display = 'none';
      li.dataset.index = '';
    }
  }
}

function updateSelection(selectedIndex, forceFocus = false, wasFocused = false) {
  if (!lastRenderedList) return;

  wasFocused = wasFocused || panelKeyboardActive || forceFocus ||
    (document.activeElement && fileListUl.contains(document.activeElement));

  if (selectedIndex >= 0 && selectedIndex < lastRenderedList.length && selectedIndex !== lastScrolledIndex) {
    lastScrolledIndex = selectedIndex;
    const itemTop = selectedIndex * ROW_HEIGHT;
    const itemBottom = itemTop + ROW_HEIGHT;
    const viewTop = fileListUl.scrollTop;
    const viewBottom = viewTop + fileListUl.clientHeight;
    
    if (itemTop < viewTop) {
      fileListUl.scrollTop = itemTop;
    } else if (itemBottom > viewBottom) {
      fileListUl.scrollTop = itemBottom - fileListUl.clientHeight;
    }
  }
  
  renderVisibleSlice();
  
  if (wasFocused && selectedIndex >= 0) {
    const activeLi = domPool.find(li => li.dataset.index === String(selectedIndex));
    if (activeLi && forceFocus) {
      activeLi.focus({ preventScroll: true });
    }
  }
}

function setRefreshingVisual(active) {
  if (!fileListUl && !favoritesListUl) return;
  clearTimeout(refreshPulseTimer);

  if (active) {
    fileListUl?.classList.remove('refreshing');
    favoritesListUl?.classList.remove('refreshing');
    requestAnimationFrame(() => {
      fileListUl?.classList.add('refreshing');
      favoritesListUl?.classList.add('refreshing');
    });
    return;
  }

  refreshPulseTimer = setTimeout(() => {
    fileListUl?.classList.remove('refreshing');
    favoritesListUl?.classList.remove('refreshing');
  }, 60);
}

function renderFilePanel(state) {
  filePanel.classList.toggle('hidden', !state.fileListVisible);
  if (!state.fileListVisible) return;
  renderBreadcrumb(state);

  // Update the favorite star for the current entry. Skip `..`.
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

  // Sync Favorites highlighting to the active file-panel item.
  updateFavoritesSelection(state);

  const currentDir = state.mode === 'archive' ? state.archivePath : state.directory;
  if (currentDir !== currentPath) {
    currentPath = currentDir;
    updateSortIcons();
  }

  if (!ROW_HEIGHT) {
    measureRowHeight();
    initDomPool();
  }

  if (lastRenderedList === state.list) {
    updateSelection(state.index);
    return;
  }
  lastRenderedList = state.list;
  lastScrolledIndex = -1;
  lastClickTime = 0;
  lastClickIndex = -1;
  domPool.forEach(li => li.dataset.index = '');

  const forceFocus = focusMainListOnNextRender;
  focusMainListOnNextRender = false;
  const wasFocused = panelKeyboardActive || forceFocus ||
    (document.activeElement && fileListUl.contains(document.activeElement));

  renderVisibleSlice();

  if (state.index >= 0) {
    updateSelection(state.index, forceFocus, wasFocused);
  }
}

export function initFilePanel(deps) {
  ({ filePanel, breadcrumbEl, fileListUl, resizeHandle } = deps);

  fileListUl.addEventListener('scroll', () => {
    if (ROW_HEIGHT) renderVisibleSlice();
  });

  Core.onStateChange(() => renderFilePanel(Core.getState()));

  // When focus leaves the file panel entirely (e.g. user clicks the viewport),
  // surrender keyboard ownership so arrow keys revert to the viewer.
  filePanel.addEventListener('focusout', (e) => {
    if (!filePanel.contains(e.relatedTarget)) {
      panelKeyboardActive = false;
    }
  });

  // Wire Favorites UI.
  favoritesBtnEl = document.getElementById('btn-favorite-current');
  favoritesListUl = document.getElementById('favorites-list');
  favoritesHeaderEl = document.getElementById('file-panel-favorites-header');

  if (favoritesBtnEl) {
    favoritesBtnEl.disabled = true;
    favoritesBtnEl.addEventListener('click', toggleFavoriteCurrent);
  }

  if (favoritesHeaderEl) {
    favoritesHeaderEl.addEventListener('click', toggleFavoritesExpanded);
    favoritesHeaderEl.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleFavoritesExpanded(); }
    });
  }

  // Keyboard navigation mirrors the file list below.
  if (favoritesListUl) {
    makeContainerNavigable(favoritesListUl, 'li', {
      vertical: true,
      horizontal: false,
      loop: false,
      onAction: (index, item, e) => {
        const fav = getFavorites().find(f => f.path === item.dataset.path);
        if (fav) { panelKeyboardActive = true; openFavorite(fav); }
      },
      onCancel: () => {
        panelKeyboardActive = false;
        highlightFavoriteByPath('');
        if (document.activeElement && favoritesListUl.contains(document.activeElement)) {
          document.activeElement.blur();
        }
      }
    });
  }

  // Restore the persisted collapsed state, then initialize header visibility.
  // Config loads asynchronously after init, so re-render once it arrives.
  favoritesExpanded = !getFavoritesCollapsed();
  renderFavorites();
  window.addEventListener('quivit-config-loaded', () => {
    favoritesExpanded = !getFavoritesCollapsed();
    renderFavorites();
    // Re-measure rows so custom CSS font sizes apply.
    ROW_HEIGHT = 0;
    if (Core) renderFilePanel(Core.getState());
  });

  window.addEventListener('quivit-css-applied', () => {
    // Re-measure rows for live CSS previews.
    ROW_HEIGHT = 0;
    if (Core) renderFilePanel(Core.getState());
  });

  window.addEventListener('quivit-refresh-start', () => setRefreshingVisual(true));
  window.addEventListener('quivit-refresh-end', () => setRefreshingVisual(false));

  initializeColumns();
  updateSortIcons();

  fileListUl.addEventListener('click', (e) => {
    if (e.target === fileListUl) {
      Core.selectIndex(-1);
    }
  });

  // Interacting with the main file list clears any highlighted favorite so the
  // action buttons target the list selection again.
  fileListUl.addEventListener('focusin', () => {
    highlightedFavoritePath = '';
  });

  // File-list keyboard navigation.
  makeContainerNavigable(fileListUl, 'li', {
    vertical: true,
    horizontal: false,
    loop: false,
    onAction: (index, item, e) => {
      panelKeyboardActive = true;
      Core.jumpToIndex(index);
    },
    onCancel: () => {
      panelKeyboardActive = false;
      Core.selectIndex(-1);
      if (document.activeElement && fileListUl.contains(document.activeElement)) {
        document.activeElement.blur();
      }
    },
    onSelectionChange: (nextIndex, nextItem) => {
      Core.selectIndex(nextIndex);
    }
  });

  resizeHandle.addEventListener('mousedown', (e) => {
    isResizingPanel = true;
    resizeHandle.classList.add('dragging');
    document.body.classList.toggle('resizing-panel', true);
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
    cell.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        cell.click();
      }
    });
  });

  document.querySelectorAll('.col-resizer').forEach(resizer => {
    resizer.addEventListener('mousedown', (e) => {
      resizingCol = resizer.parentElement;
      startX = e.clientX;
      startWidth = resizingCol.offsetWidth;
      columnResizeMoved = false;
      resizer.classList.add('dragging');
      document.body.classList.toggle('resizing-col', true);
      e.preventDefault();
      e.stopPropagation();
    });
  });

  window.addEventListener('mousemove', (e) => {
    if (isResizingPanel) {
      const oldWidth = filePanel.getBoundingClientRect().width;
      const newWidth = Math.min(480, Math.max(120, e.clientX));
      document.documentElement.style.setProperty('--panel-w', `${newWidth}px`);
      normalizeColumnWidths('name', getColumnWidth('name') + (newWidth - oldWidth));
      window.dispatchEvent(new CustomEvent('quivit-panel-resized'));
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
      document.body.classList.toggle('resizing-panel', false);
    }

    if (resizingCol) {
      resizingCol.querySelector('.col-resizer').classList.remove('dragging');
      resizingCol = null;
      document.body.classList.toggle('resizing-col', false);
    }
  });
}
