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

let MIN_COL_WIDTHS = {};

function recalculateMinColWidths() {
  ['name', 'ext', 'date'].forEach(col => {
    const el = document.querySelector(`.header-cell.col-${col}`);
    if (el) {
      const clone = el.cloneNode(true);
      clone.classList.add('offscreen-measure');
      
      // Ensure we leave room for the sort icon, even if it's currently inactive
      const icon = clone.querySelector('.sort-icon');
      if (icon) icon.textContent = '▼';
      
      document.body.appendChild(clone);
      MIN_COL_WIDTHS[col] = Math.ceil(clone.getBoundingClientRect().width);
      document.body.removeChild(clone);
    }
  });
}

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

// Virtualization (VS Code RowCache pattern)
let activeRows = new Map();
let freePool = [];
let scrollSpacer = null;
let ROW_HEIGHT = 0;
let currentViewMode = null;
let btnToggleViewMode = null;
const OVERSCAN = 10;

// Deduplication tokens
let lastRenderedIndex = -1;
let lastRenderedViewMode = null;
let lastRenderedVisible = null;
let lastRenderedDirectory = null;

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
const MAX_HOVER_PRELOAD_BYTES = 15 * 1024 * 1024;

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

  recalculateMinColWidths();

  const panelWidth = Math.max(filePanel.getBoundingClientRect().width - 8, 120);
  const date = MIN_COL_WIDTHS.date;
  const ext = MIN_COL_WIDTHS.ext;
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



function fetchNativeIcon(path, ext, size = 'small') {
  const cacheKey = size === 'large' ? `large:${ext}` : ext;
  if (iconCache.has(cacheKey)) return;
  iconCache.set(cacheKey, 'pending');

  const applyIconSrc = (src) => {
    const finalSrc = src || '';
    iconCache.set(cacheKey, finalSrc);
    try { localStorage.setItem('icon:' + cacheKey, finalSrc); } catch (e) {}
    const selector = `img[data-icon-key="${CSS.escape(cacheKey)}"], img[data-ext="${CSS.escape(ext)}"]`;
    document.querySelectorAll(selector).forEach(img => {
      if (img.dataset.iconKey && img.dataset.iconKey !== cacheKey) return;
      if (src) {
        img.src = src;
        img.removeAttribute('data-icon-key');
        img.removeAttribute('data-ext');
      } else {
        const isFolder = ext === '__folder__' || ext.includes('\\') || ext.includes('/');
        const svgDim = size === 'large' ? 32 : 14;
        const svgContent = isFolder
          ? `<svg width="${svgDim}" height="${svgDim}" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`
          : `<svg width="${svgDim}" height="${svgDim}" viewBox="0 0 24 24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`;
        const svgSlot = img.parentElement?.querySelector('.item-icon-svg');
        if (svgSlot) {
          img.style.display = 'none';
          img.removeAttribute('data-icon-key');
          img.removeAttribute('data-ext');
          svgSlot.innerHTML = svgContent;
          svgSlot.style.display = '';
        } else {
          img.outerHTML = svgContent;
        }
      }
    });
  };

  const fetchIconViaIpc = () => {
    if (!window.__TAURI__) return;
    const args = { path, extKey: ext };
    if (size === 'large') args.size = 'large';
    window.__TAURI__.core.invoke('get_native_icon', args)
      .then(src => applyIconSrc(src || ''))
      .catch(err => console.error('Failed to get native icon:', err));
  };

  if (window.__TAURI__) {
    const protocolSrc = FsUtils.buildNativeIconSrc(path, ext, size);
    const probe = new Image();
    probe.onload = () => applyIconSrc(protocolSrc);
    probe.onerror = fetchIconViaIpc;
    probe.src = protocolSrc;
  }
}

function getIconHtml(item, size = 'small') {
  const ext = FsUtils.getIconExtKey(item);
  const cacheKey = size === 'large' ? `large:${ext}` : ext;
  const isFolder = item.is_dir || item.is_parent;
  const svgDim = size === 'large' ? 32 : 14;

  let fallbackSvg;
  if (item.is_drive) {
    fallbackSvg = `<svg width="${svgDim}" height="${svgDim}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"></line><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path><line x1="6" y1="16" x2="6.01" y2="16"></line><line x1="10" y1="16" x2="10.01" y2="16"></line></svg>`;
  } else if (isFolder) {
    fallbackSvg = `<svg width="${svgDim}" height="${svgDim}" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
  } else {
    fallbackSvg = `<svg width="${svgDim}" height="${svgDim}" viewBox="0 0 24 24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`;
    if (!ext) return fallbackSvg;
  }

  if (iconCache.has(cacheKey)) {
    const src = iconCache.get(cacheKey);
    if (src === 'pending') {
      return `<img data-ext="${CSS.escape(ext)}" data-icon-key="${CSS.escape(cacheKey)}" draggable="false" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCI+PC9zdmc+">`;
    }
    if (src) {
      return `<img src="${src}" draggable="false">`;
    }
    return fallbackSvg;
  }

  const stored = localStorage.getItem('icon:' + cacheKey);
  if (stored !== null) {
    iconCache.set(cacheKey, stored);
    if (stored) {
      return `<img src="${stored}" draggable="false">`;
    }
    return fallbackSvg;
  }

  fetchNativeIcon(item.path, ext, size);
  return `<img data-ext="${CSS.escape(ext)}" data-icon-key="${CSS.escape(cacheKey)}" draggable="false" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCI+PC9zdmc+">`;
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

  const state = Core.getState();

  // List mode elements
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

  // Thumbnail mode elements
  const thumbWrapper = document.createElement('div');
  thumbWrapper.className = 'item-thumbnail-wrapper';
  const thumbImg = document.createElement('img');
  thumbImg.className = 'item-thumbnail-img';
  thumbImg.draggable = false;
  thumbWrapper.appendChild(thumbImg);

  const thumbInfo = document.createElement('div');
  thumbInfo.className = 'item-thumbnail-info';
  const thumbTitle = document.createElement('span');
  thumbTitle.className = 'item-thumbnail-title';
  thumbTitle.textContent = fav.name;
  const thumbMeta = document.createElement('span');
  thumbMeta.className = 'item-thumbnail-meta';

  if (fav.is_drive) {
    thumbMeta.textContent = 'Drive';
  } else if (fav.is_dir) {
    thumbMeta.textContent = fav.date ? `Folder • ${fav.date}` : 'Folder';
  } else {
    const ext = (fav.ext || '').toUpperCase();
    thumbMeta.textContent = ext ? (fav.date ? `${ext} • ${fav.date}` : ext) : (fav.date || '');
  }
  thumbInfo.appendChild(thumbTitle);
  thumbInfo.appendChild(thumbMeta);

  const ext = FsUtils.getIconExtKey(fav);
  const targetSrc = FsUtils.buildThumbnailSrc(fav, state);
  thumbImg.onerror = () => {
    thumbImg.onerror = null;
    const cleanPath = fav.path && fav.path.includes('|') ? fav.path.slice(0, fav.path.indexOf('|')) : fav.path;
    thumbImg.src = FsUtils.buildNativeIconSrc(cleanPath, ext, 'large');
  };
  thumbImg.loading = 'lazy';
  thumbImg.src = targetSrc;

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
  li.appendChild(thumbWrapper);
  li.appendChild(thumbInfo);
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
  if (panel) panel.classList.toggle('is-empty', favs.length === 0);
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
  const isThumbnail = (Core ? Core.getState().fileListViewMode : 'list') === 'thumbnail';
  const sentinelId = isThumbnail ? 'file-list-thumbnail-sentinel' : 'file-list-sentinel';
  const sentinel = document.getElementById(sentinelId);
  const fallback = isThumbnail ? 52 : 22;
  const measured = sentinel ? Math.round(sentinel.getBoundingClientRect().height) : 0;
  ROW_HEIGHT = measured > 0 ? measured : fallback;
  return ROW_HEIGHT;
}

const TRANSPARENT_PIXEL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCI+PC9zdmc+';

function getFallbackSvg(type, svgDim = 14) {
  if (type === 'drive') {
    return `<svg width="${svgDim}" height="${svgDim}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="12" x2="2" y2="12"></line><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"></path><line x1="6" y1="16" x2="6.01" y2="16"></line><line x1="10" y1="16" x2="10.01" y2="16"></line></svg>`;
  }
  if (type === 'folder') {
    return `<svg width="${svgDim}" height="${svgDim}" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`;
  }
  return `<svg width="${svgDim}" height="${svgDim}" viewBox="0 0 24 24" fill="currentColor"><path d="M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z"/></svg>`;
}

function updateRowIcon(slots, item) {
  const ext = FsUtils.getIconExtKey(item);
  const isFolder = item.is_dir || item.is_parent;

  const showSvg = (type) => {
    slots.iconImg.style.display = 'none';
    slots.iconImg.removeAttribute('data-icon-key');
    slots.iconImg.removeAttribute('data-ext');
    slots.iconSvg.style.display = '';
    if (slots.iconSvg._type !== type) {
      slots.iconSvg.innerHTML = getFallbackSvg(type, 14);
      slots.iconSvg._type = type;
    }
  };

  const showImg = (src, isPending = false) => {
    slots.iconSvg.style.display = 'none';
    slots.iconImg.style.display = '';
    if (isPending) {
      slots.iconImg.dataset.ext = ext;
      slots.iconImg.dataset.iconKey = ext;
    } else {
      slots.iconImg.removeAttribute('data-icon-key');
      slots.iconImg.removeAttribute('data-ext');
    }
    if (slots.iconImg.getAttribute('src') !== src) {
      slots.iconImg.src = src;
    }
  };

  if (item.is_drive) {
    showSvg('drive');
    return;
  }

  if (iconCache.has(ext)) {
    const cached = iconCache.get(ext);
    if (cached === 'pending') {
      showImg(TRANSPARENT_PIXEL, true);
      return;
    }
    if (cached) {
      showImg(cached);
      return;
    }
    showSvg(isFolder ? 'folder' : 'file');
    return;
  }

  const stored = localStorage.getItem('icon:' + ext);
  if (stored !== null) {
    iconCache.set(ext, stored);
    if (stored) {
      showImg(stored);
      return;
    }
    showSvg(isFolder ? 'folder' : 'file');
    return;
  }

  fetchNativeIcon(item.path, ext, 'small');
  showImg(TRANSPARENT_PIXEL, true);
}

function ensureSpacer() {
  if (!scrollSpacer) {
    scrollSpacer = fileListUl?.querySelector('.scroll-spacer');
    if (!scrollSpacer && fileListUl) {
      scrollSpacer = document.createElement('div');
      scrollSpacer.className = 'scroll-spacer';
      scrollSpacer.setAttribute('aria-hidden', 'true');
      fileListUl.appendChild(scrollSpacer);
    }
  }
}

function wireRowListeners(li) {
  li.addEventListener('mousedown', () => {
    const idxStr = li.dataset.index;
    pendingClickIndex = idxStr ? parseInt(idxStr, 10) : -1;
  });

  li.addEventListener('click', () => {
    const index = pendingClickIndex;
    if (index === -1) return;
    fileListUl?.focus({ preventScroll: true });
    if (Core.getState().index !== index) {
      Core.selectIndex(index);
    }
    const now = Date.now();
    if (lastClickIndex === index && (now - lastClickTime < 400)) {
      panelKeyboardActive = true;
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
    const item = state.list?.[index];

    if (item && !item.is_dir && !item.is_parent && FsUtils.isImageEntry(item)) {
      if (item.size && item.size > MAX_HOVER_PRELOAD_BYTES) return;
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
      }, 150);
    }
  });

  li.addEventListener('mouseleave', () => {
    clearTimeout(hoverPreloadTimer);
    if (hoverPreloadImg) {
      hoverPreloadImg.removeAttribute('src');
      hoverPreloadImg = null;
    }
  });
}

function createPoolRow() {
  const li = document.createElement('li');
  li.style.display = 'none';
  li.setAttribute('role', 'option');

  // List mode elements
  const itemName = document.createElement('span');
  itemName.className = 'item-name';

  const iconImg = document.createElement('img');
  iconImg.draggable = false;
  iconImg.style.display = 'none';

  const iconSvg = document.createElement('span');
  iconSvg.className = 'item-icon-svg';
  iconSvg.style.display = 'none';

  const itemLabel = document.createElement('span');
  itemLabel.className = 'item-label';

  itemName.appendChild(iconImg);
  itemName.appendChild(iconSvg);
  itemName.appendChild(itemLabel);

  const itemExt = document.createElement('span');
  itemExt.className = 'item-ext';

  const itemDate = document.createElement('span');
  itemDate.className = 'item-date';

  li.appendChild(itemName);
  li.appendChild(itemExt);
  li.appendChild(itemDate);

  // Thumbnail mode elements
  const thumbWrapper = document.createElement('div');
  thumbWrapper.className = 'item-thumbnail-wrapper';
  const thumbImg = document.createElement('img');
  thumbImg.className = 'item-thumbnail-img';
  thumbImg.draggable = false;
  thumbWrapper.appendChild(thumbImg);

  const thumbInfo = document.createElement('div');
  thumbInfo.className = 'item-thumbnail-info';
  const thumbTitle = document.createElement('span');
  thumbTitle.className = 'item-thumbnail-title';
  const thumbMeta = document.createElement('span');
  thumbMeta.className = 'item-thumbnail-meta';
  thumbInfo.appendChild(thumbTitle);
  thumbInfo.appendChild(thumbMeta);

  li.appendChild(thumbWrapper);
  li.appendChild(thumbInfo);

  li._slots = {
    itemName,
    iconImg,
    iconSvg,
    label: itemLabel,
    ext: itemExt,
    date: itemDate,
    thumbWrapper,
    thumbImg,
    thumbTitle,
    thumbMeta,
  };

  wireRowListeners(li);
  if (fileListUl) fileListUl.appendChild(li);
  return li;
}

function initDomPool() {
  ensureSpacer();

  for (const li of activeRows.values()) {
    li.remove();
  }
  activeRows.clear();

  for (const li of freePool) {
    li.remove();
  }
  freePool = [];
}

function updateEntry(li, item, index) {
  if (!li || !item) return;
  li.dataset.index = index;
  li.title = item.name && item.name !== '..' ? item.name : '';
  li.classList.toggle('is-hidden-entry', !!item.is_hidden);

  const state = Core.getState();
  const isThumbnail = state.fileListViewMode === 'thumbnail';
  const slots = li._slots;
  if (!slots) return;

  if (isThumbnail) {
    if (slots.thumbTitle) slots.thumbTitle.textContent = item.name || '';
    if (slots.thumbMeta) {
      if (item.is_parent) {
        slots.thumbMeta.textContent = 'Parent folder';
      } else if (item.is_drive) {
        slots.thumbMeta.textContent = 'Drive';
      } else if (item.is_dir) {
        slots.thumbMeta.textContent = item.date ? `Folder • ${item.date}` : 'Folder';
      } else {
        const ext = (item.ext || '').toUpperCase();
        slots.thumbMeta.textContent = ext ? (item.date ? `${ext} • ${item.date}` : ext) : (item.date || '');
      }
    }

    if (slots.thumbImg) {
      const ext = FsUtils.getIconExtKey(item);
      const targetSrc = FsUtils.buildThumbnailSrc(item, state);

      slots.thumbImg.onerror = () => {
        slots.thumbImg.onerror = null;
        slots.thumbImg.src = FsUtils.buildNativeIconSrc(item.path, ext, 'large');
      };

      if (slots.thumbImg.getAttribute('src') !== targetSrc) {
        slots.thumbImg.loading = 'lazy';
        slots.thumbImg.src = targetSrc;
      }
    }
  } else {
    updateRowIcon(slots, item);
    if (slots.label) slots.label.textContent = item.name || '';
    if (slots.ext) slots.ext.textContent = item.is_dir ? 'DIR' : (item.ext || '');
    if (slots.date) slots.date.textContent = item.date || '';
  }

  li.style.top = `${index * ROW_HEIGHT}px`;
  li.style.display = '';
}

function renderVisibleSlice() {
  if (!fileListUl) return;
  ensureSpacer();

  if (!lastRenderedList || lastRenderedList.length === 0) {
    for (const li of activeRows.values()) {
      li.style.display = 'none';
      li.style.top = '';
      li.dataset.index = '';
      li.classList.remove('selected');
      freePool.push(li);
    }
    activeRows.clear();
    if (scrollSpacer) scrollSpacer.style.height = '0px';
    return;
  }

  const state = Core.getState();
  const list = state.list;
  if (!list) return;
  const total = list.length;

  if (!ROW_HEIGHT) measureRowHeight();

  // Set single static sizer height
  const totalHeight = `${total * ROW_HEIGHT}px`;
  if (scrollSpacer && scrollSpacer.style.height !== totalHeight) {
    scrollSpacer.style.height = totalHeight;
  }

  const scrollTop = fileListUl.scrollTop;
  const clientH = fileListUl.clientHeight || 600;
  const rawStart = Math.floor(scrollTop / ROW_HEIGHT);
  const visibleCount = Math.ceil(clientH / ROW_HEIGHT);
  const startIndex = Math.max(0, rawStart - OVERSCAN);
  const endIndex = Math.min(total, rawStart + visibleCount + OVERSCAN);

  // Phase 1: Reclaim offscreen rows into freePool (VS Code RowCache pattern)
  for (const [idx, li] of activeRows) {
    if (idx < startIndex || idx >= endIndex) {
      activeRows.delete(idx);
      li.style.display = 'none';
      li.style.top = '';
      li.dataset.index = '';
      li.classList.remove('selected');
      freePool.push(li);
    }
  }

  // Phase 2: Allocate or update only rows not already rendered
  for (let i = startIndex; i < endIndex; i++) {
    let li = activeRows.get(i);
    if (!li) {
      li = freePool.pop() || createPoolRow();
      updateEntry(li, list[i], i);
      activeRows.set(i, li);
    }
    li.classList.toggle('selected', i === state.index);
  }
}

function updateSelection(selectedIndex, forceFocus = false, wasFocused = false) {
  if (!lastRenderedList) return;

  const isDefaultFocus = !document.activeElement || document.activeElement === document.body;
  wasFocused = wasFocused || panelKeyboardActive || forceFocus ||
    (document.activeElement && fileListUl.contains(document.activeElement)) ||
    (isDefaultFocus && Core.getState().fileListVisible);

  let didScroll = false;
  if (selectedIndex >= 0 && selectedIndex < lastRenderedList.length) {
    if (selectedIndex !== lastScrolledIndex) {
      lastScrolledIndex = selectedIndex;
      const itemTop = selectedIndex * ROW_HEIGHT;
      const itemBottom = itemTop + ROW_HEIGHT;
      const viewTop = fileListUl.scrollTop;
      const clientH = fileListUl.clientHeight || 600;
      const viewBottom = viewTop + clientH;

      if (itemTop < viewTop) {
        fileListUl.scrollTop = itemTop;
        didScroll = true;
      } else if (itemBottom > viewBottom) {
        fileListUl.scrollTop = itemBottom - clientH;
        didScroll = true;
      }
    }
  }

  if (didScroll) {
    renderVisibleSlice();
  } else {
    // Surgical update: directly update .selected on active elements without re-rendering
    for (const [idx, li] of activeRows) {
      li.classList.toggle('selected', idx === selectedIndex);
    }
  }

  if (wasFocused) {
    fileListUl?.focus({ preventScroll: true });
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

  fileListUl?.classList.remove('refreshing');
  favoritesListUl?.classList.remove('refreshing');
}

export function renderFilePanel(state) {
  if (!filePanel) return;

  filePanel.classList.toggle('hidden', !state.fileListVisible);
  if (!state.fileListVisible) return;

  const viewMode = state.fileListViewMode || 'list';
  const isThumbnail = viewMode === 'thumbnail';
  filePanel.classList.toggle('view-mode-thumbnail', isThumbnail);

  if (!btnToggleViewMode) {
    btnToggleViewMode = document.getElementById('btn-toggle-view-mode');
  }
  if (btnToggleViewMode) {
    btnToggleViewMode.classList.toggle('active', isThumbnail);
    btnToggleViewMode.setAttribute('aria-pressed', isThumbnail ? 'true' : 'false');
  }

  if (currentViewMode !== viewMode) {
    currentViewMode = viewMode;
    measureRowHeight();
    lastRenderedList = null;
    initDomPool();
    renderFavorites();
  }

  if (!ROW_HEIGHT) {
    measureRowHeight();
    ensureSpacer();
  }

  const currentDir = state.mode === 'archive' ? state.archivePath : state.directory;

  // Deduplication guard: if file list state has not changed, exit early
  if (
    lastRenderedList === state.list &&
    lastRenderedIndex === state.index &&
    lastRenderedViewMode === viewMode &&
    lastRenderedVisible === state.fileListVisible &&
    lastRenderedDirectory === currentDir
  ) {
    return;
  }

  renderBreadcrumb(state);

  // Update the favorite star for the current entry. Skip `..`.
  {
    const entry = state.list?.[state.index];
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

  if (currentDir !== currentPath) {
    currentPath = currentDir;
    updateSortIcons();
  }

  const forceFocus = focusMainListOnNextRender;
  focusMainListOnNextRender = false;
  const isDefaultFocus = !document.activeElement || document.activeElement === document.body;
  const wasFocused = panelKeyboardActive || forceFocus ||
    (document.activeElement && filePanel.contains(document.activeElement)) ||
    (isDefaultFocus && state.fileListVisible);

  // If only the selection index changed (same list)
  if (lastRenderedList === state.list) {
    lastRenderedIndex = state.index;
    lastRenderedViewMode = viewMode;
    lastRenderedVisible = state.fileListVisible;
    lastRenderedDirectory = currentDir;
    updateSelection(state.index, forceFocus, wasFocused);
    return;
  }

  lastRenderedList = state.list;
  lastRenderedIndex = state.index;
  lastRenderedViewMode = viewMode;
  lastRenderedVisible = state.fileListVisible;
  lastRenderedDirectory = currentDir;
  lastScrolledIndex = -1;
  lastClickTime = 0;
  lastClickIndex = -1;
  initDomPool();

  renderVisibleSlice();

  if (state.index >= 0) {
    updateSelection(state.index, forceFocus, wasFocused);
  } else if (wasFocused) {
    fileListUl?.focus({ preventScroll: true });
  }
}

function isPointerOverActiveViewport() {
  const state = Core.getState();
  if (!state.src || state.mode === 'empty') return false;

  const dropOverlay = document.getElementById('drop-overlay');
  if (dropOverlay && !dropOverlay.classList.contains('hidden') && dropOverlay.classList.contains('active')) {
    return false;
  }
  const pwOverlay = document.getElementById('password-overlay');
  if (pwOverlay && pwOverlay.classList.contains('active')) {
    return false;
  }

  const vp = document.getElementById('viewport');
  return !!(vp && vp.matches(':hover'));
}

export function initFilePanel(deps) {
  ({ filePanel, breadcrumbEl, fileListUl, resizeHandle } = deps);

  ensureSpacer();

  fileListUl.addEventListener('scroll', () => {
    renderVisibleSlice();
  }, { passive: true });

  window.addEventListener('resize', () => {
    renderVisibleSlice();
  }, { passive: true });

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

  btnToggleViewMode = document.getElementById('btn-toggle-view-mode');
  if (btnToggleViewMode) {
    btnToggleViewMode.addEventListener('click', () => {
      Core.toggleFileListViewMode({ persist: true });
    });
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
    const oldHeight = ROW_HEIGHT;
    measureRowHeight();
    if (oldHeight !== ROW_HEIGHT) {
      initDomPool();
    }
    if (Core) renderFilePanel(Core.getState());
  });

  window.addEventListener('quivit-css-applied', () => {
    // Re-measure rows for live CSS previews.
    const oldHeight = ROW_HEIGHT;
    measureRowHeight();
    if (oldHeight !== ROW_HEIGHT) {
      initDomPool();
    }
    recalculateMinColWidths();
    normalizeColumnWidths('name');
    if (Core) renderFilePanel(Core.getState());
  });

  window.addEventListener('quivit-refresh-start', () => setRefreshingVisual(true));
  window.addEventListener('quivit-refresh-end', () => setRefreshingVisual(false));

  initializeColumns();
  updateSortIcons();

  fileListUl.addEventListener('click', (e) => {
    if (e.target === fileListUl) {
      fileListUl.focus({ preventScroll: true });
      const state = Core.getState();
      if (state.list?.length === 1 && state.list[0].is_parent) {
        return;
      }
      Core.selectIndex(-1);
    }
  });

  // Interacting with the main file list clears any highlighted favorite so the
  // action buttons target the list selection again.
  fileListUl.addEventListener('focusin', () => {
    highlightedFavoritePath = '';
  });

  // File-list keyboard navigation for virtualized list.
  fileListUl.addEventListener('keydown', (e) => {
    const state = Core.getState();
    const list = state.list;
    if (!list || !list.length) return;

    if (['ArrowDown', 'ArrowUp', ' '].includes(e.key) && isPointerOverActiveViewport()) {
      return;
    }

    let targetIdx = null;
    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        e.stopPropagation();
        panelKeyboardActive = true;
        targetIdx = state.index === -1 ? 0 : Math.min(state.index + 1, list.length - 1);
        break;
      case 'ArrowUp':
        e.preventDefault();
        e.stopPropagation();
        panelKeyboardActive = true;
        targetIdx = state.index === -1 ? list.length - 1 : Math.max(state.index - 1, 0);
        break;
      case 'PageDown':
        e.preventDefault();
        e.stopPropagation();
        panelKeyboardActive = true;
        targetIdx = Math.min((state.index === -1 ? 0 : state.index) + 10, list.length - 1);
        break;
      case 'PageUp':
        e.preventDefault();
        e.stopPropagation();
        panelKeyboardActive = true;
        targetIdx = Math.max((state.index === -1 ? 0 : state.index) - 10, 0);
        break;
      case 'Home':
        e.preventDefault();
        e.stopPropagation();
        panelKeyboardActive = true;
        targetIdx = 0;
        break;
      case 'End':
        e.preventDefault();
        e.stopPropagation();
        panelKeyboardActive = true;
        targetIdx = list.length - 1;
        break;
      case 'Enter': {
        if (state.index < 0 || state.index >= list.length) {
          break;
        }
        e.preventDefault();
        e.stopPropagation();
        panelKeyboardActive = true;

        const entry = list[state.index];
        if (entry.is_parent || entry.is_dir || FsUtils.isArchiveEntry(entry)) {
          Core.jumpToIndex(state.index);
        } else if (FsUtils.isImageEntry(entry)) {
          Core.selectIndex(state.index);
          document.getElementById('viewport')?.focus();
        }
        break;
      }
      case ' ': {
        if (state.index < 0 || state.index >= list.length) {
          break;
        }
        e.preventDefault();
        e.stopPropagation();
        panelKeyboardActive = true;

        const entry = list[state.index];
        if (entry.is_parent || entry.is_dir || FsUtils.isArchiveEntry(entry)) {
          Core.jumpToIndex(state.index);
        }
        break;
      }
      case 'Escape':
        e.preventDefault();
        e.stopPropagation();
        panelKeyboardActive = false;
        Core.selectIndex(-1);
        if (document.activeElement && fileListUl.contains(document.activeElement)) {
          document.activeElement.blur();
        }
        break;
    }

    if (targetIdx !== null && targetIdx !== state.index) {
      Core.selectIndex(targetIdx);
      updateSelection(targetIdx, true, true);
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

export function focusFileList() {
  if (fileListUl) {
    fileListUl.focus();
  }
}

export function isFileListFocused() {
  return !!(fileListUl && document.activeElement && fileListUl.contains(document.activeElement));
}

