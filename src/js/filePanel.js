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
let favoritesExpanded = false;
let configLoaded = false;
let favoritesBtnEl = null;
let favoritesListUl = null;
let favoritesHeaderEl = null;
let FsUtils = null;
let favLastClickPath = '';
let favLastClickTime = 0;
let highlightedFavoritePath = '';
let refreshPulseTimer = null;
let hoverPreloadImg = null;
let hoverPreloadTimer = null;

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
// persistence: favorites + collapsed state live in config (split into
// quivit_favorites.json by the backend), NOT WebView2 localStorage. See the
// persistence policy in core.js.

function getFavorites() {
  const favs = Core.getState().config?.frontend_data?.favorites;
  return Array.isArray(favs) ? favs : [];
}

function saveFavorites(favs) {
  Core.getState().config.frontend_data.favorites = favs;
  if (configLoaded) Core.persistConfig();
}

function getFavoritesCollapsed() {
  return Core.getState().config?.frontend_data?.favorites_collapsed === true;
}

function saveFavoritesCollapsed(collapsed) {
  Core.getState().config.frontend_data.favorites_collapsed = collapsed;
  if (configLoaded) Core.persistConfig();
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

export function toggleFavoriteCurrent() {
  if (!Core || !favoritesBtnEl) return;
  const state = Core.getState();
  const entry = state.list[state.index];
  if (!entry || entry.is_parent) return;
  const wasFavorite = isFavorite(entry.path);
  toggleFavorite(entry);
  updateFavoriteBtn(entry.path);
  // Always expand the section when a new favorite is added
  if (!wasFavorite) {
    favoritesExpanded = true;
    saveFavoritesCollapsed(false);
  }
  renderFavorites();
}

const iconCache = new Map();

function fetchNativeIcon(ext) {
  if (iconCache.has(ext)) return;
  iconCache.set(ext, 'pending'); // mark as pending

  if (window.__TAURI__) {
    const extArg = ext === '__folder__' ? ext : '.' + ext;
    window.__TAURI__.core.invoke('get_native_icon', { ext: extArg })
      .then(src => {
        iconCache.set(ext, src || '');
        document.querySelectorAll(`img[data-ext="${ext}"]`).forEach(img => {
          if (src) {
            img.src = src;
            img.style.imageRendering = 'pixelated';
            img.removeAttribute('data-ext');
          } else {
            // fallback generic icon
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
      return `<img data-ext="${ext}" width="14" height="14" style="object-fit:contain;image-rendering:auto" draggable="false" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCI+PC9zdmc+">`;
    }
    if (src) {
      return `<img src="${src}" width="14" height="14" style="object-fit:contain;image-rendering:pixelated" draggable="false">`;
    }
    return fallbackSvg;
  }

  fetchNativeIcon(ext);
  return `<img data-ext="${ext}" width="14" height="14" style="object-fit:contain;image-rendering:pixelated" draggable="false" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCI+PC9zdmc+">`;
}

function openFavorite(fav) {
  if (FsUtils) {
    FsUtils.loadFile(fav.path).catch(console.error);
  } else if (window.__TAURI__) {
    window.dispatchEvent(new CustomEvent('quivit-load-file', { detail: fav.path }));
  }
}

function buildFavoriteEntry(fav) {
  const li = document.createElement('li');
  // Full system path as tooltip. For archive entries ("archive|inner/path.png")
  // put the inner entry on its own line, keeping its native "/" separators.
  li.title = fav.path.includes('|')
    ? fav.path.replace('|', '\n→ ')
    : fav.path;
  li.dataset.path = fav.path;
  li.setAttribute('role', 'option');
  li.setAttribute('tabindex', '0');

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
    const isDirOrArchive = fav.is_dir || (fav.ext && FsUtils && FsUtils.isArchive(fav.name));
    if (isDirOrArchive) {
      highlightFavoriteByPath(fav.path);
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
      highlightFavoriteByPath(fav.path);
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

function renderEntry(item, index, selectedIndex) {
  const li = document.createElement('li');
  if (index === selectedIndex) li.classList.add('selected');
  if (item.name !== '..') {
    li.title = item.name;
  }

  const itemName = document.createElement('span');
  itemName.className = 'item-name';

  itemName.innerHTML = getIconHtml(item);
  if (item.is_hidden) {
    const icon = itemName.firstElementChild;
    if (icon) icon.style.opacity = '0.65';
  }

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

  // Pre-emptively load the image on hover to make clicks feel instant
  li.addEventListener('mouseenter', () => {
    clearTimeout(hoverPreloadTimer);
    if (hoverPreloadImg) {
      hoverPreloadImg.removeAttribute('src');
      hoverPreloadImg = null;
    }

    if (!item.is_dir && !item.is_parent && FsUtils.isImageEntry(item)) {
      hoverPreloadTimer = setTimeout(() => {
        const state = Core.getState();
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

export function renderFilePanel(state) {
  filePanel.classList.toggle('hidden', !state.fileListVisible);
  if (!state.fileListVisible) return;
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

  // Sync favorites highlighting to the currently active file-panel item
  updateFavoritesSelection(state);

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
  ({ filePanel, breadcrumbEl, fileListUl, resizeHandle, Core, Viewer, FsUtils } = deps);

  // Wire favorites UI
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

  // Composite widget keyboard navigation (mirrors the file list below)
  if (favoritesListUl) {
    favoritesListUl.addEventListener('keydown', (e) => {
      const items = Array.from(favoritesListUl.children);
      if (!items.length) return;

      const activeRow = document.activeElement && document.activeElement.closest('li');
      const currentIndex = activeRow && favoritesListUl.contains(activeRow) ? items.indexOf(activeRow) : -1;
      const onRemoveBtn = document.activeElement && document.activeElement.classList.contains('fav-remove');
      let nextIndex = null;

      switch (e.key) {
        case 'ArrowDown': {
          e.preventDefault();
          e.stopPropagation();
          nextIndex = currentIndex === -1 ? 0 : Math.min(currentIndex + 1, items.length - 1);
          break;
        }
        case 'ArrowUp': {
          e.preventDefault();
          e.stopPropagation();
          nextIndex = currentIndex === -1 ? items.length - 1 : Math.max(currentIndex - 1, 0);
          break;
        }
        case 'Home': {
          e.preventDefault();
          nextIndex = 0;
          break;
        }
        case 'End': {
          e.preventDefault();
          nextIndex = items.length - 1;
          break;
        }
        case 'Enter':
        case ' ': {
          if (!onRemoveBtn && currentIndex !== -1) {
            e.preventDefault();
            const fav = getFavorites().find(f => f.path === items[currentIndex].dataset.path);
            if (fav) openFavorite(fav);
          }
          break;
        }
        case 'Escape': {
          e.preventDefault();
          highlightFavoriteByPath('');
          if (document.activeElement && favoritesListUl.contains(document.activeElement)) {
            document.activeElement.blur();
          }
          break;
        }
        default:
          break;
      }

      if (nextIndex !== null) {
        items[nextIndex].focus();
      }
    });
  }

  // Restore the persisted collapsed state, then initialize header visibility.
  // Config loads asynchronously after init, so re-render once it arrives.
  favoritesExpanded = !getFavoritesCollapsed();
  renderFavorites();
  window.addEventListener('quivit-config-loaded', () => {
    configLoaded = true;
    favoritesExpanded = !getFavoritesCollapsed();
    renderFavorites();
  });

  // Allow favorites entries to load files via custom event
  window.addEventListener('quivit-load-file', (e) => {
    if (FsUtils) FsUtils.loadFile(e.detail).catch(console.error);
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
