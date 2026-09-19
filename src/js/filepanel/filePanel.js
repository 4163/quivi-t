/**
 * filePanel.js: file list rendering, sorting, and column resizing.
 */
import { DirectoryPrefs } from '../directoryPrefs.js';
import { makeListNavigable, makeContainerNavigable } from '../keyboardNav.js';
import {
  getFavorites,
  getFavoritesCollapsed,
  saveFavoritesCollapsed,
  isFavorite,
  toggleFavorite,
  saveFavorites,
  reconcileFavorites
} from './favoritesStore.js';
import {
  fetchLibraryTree,
  hasLibraryEntries,
  deleteLibraryEntry,
  getProviderCollapsed,
  saveProviderCollapsed
} from './libraryStore.js';
import { Core } from '../core.js';
import { FsUtils } from '../fsUtils.js';
import { BoundedMap, BoundedSet } from '../services/cache.js';
import {
  setVisibleRange as setDownloadVisibleRange,
  cancelGalleryDownloads,
  getGalleryDownloadStatus,
  retryGalleryDownload,
  reloadLibraryDir,
  getCachedLibraryDir,
  remapLibraryPath,
  isLibraryLocationError
} from '../urlLoader.js';

let _activeViewerKey = null;
let _activeViewerBlob = null;
let _archiveBlobBytes = 0;
const _archiveBlobSizes = new Map();

export const ARCHIVE_BLOB_CACHE_CAPACITY = 8;
export const ARCHIVE_BLOB_CACHE_MAX_BYTES = 24 * 1024 * 1024;
export const ARCHIVE_BLOB_CACHE_ENTRY_MAX_BYTES = 4 * 1024 * 1024;

function _forgetArchiveBlobSize(key) {
  const size = _archiveBlobSizes.get(key);
  if (!size) return;
  _archiveBlobBytes = Math.max(0, _archiveBlobBytes - size);
  _archiveBlobSizes.delete(key);
}

function _rememberArchiveBlobSize(key, size) {
  _forgetArchiveBlobSize(key);
  if (!size) return;
  _archiveBlobSizes.set(key, size);
  _archiveBlobBytes += size;
}

function _trimArchiveBlobCache() {
  while (_archiveBlobSizes.size > ARCHIVE_BLOB_CACHE_CAPACITY || _archiveBlobBytes > ARCHIVE_BLOB_CACHE_MAX_BYTES) {
    let evicted = false;
    for (const key of thumbnailCache.keys()) {
      if (_archiveBlobSizes.has(key)) {
        thumbnailCache.delete(key);
        evicted = true;
        break;
      }
    }
    if (!evicted) break;
  }
}

function _revokeBlobEntry(key, value) {
  if (typeof value === 'string' && value.startsWith('blob:')) {
    _forgetArchiveBlobSize(key);
    const activeSrc = Core?.getState()?.src;
    if (activeSrc && (key === activeSrc || value === activeSrc)) {
      if (_activeViewerBlob && _activeViewerBlob !== value) {
        URL.revokeObjectURL(_activeViewerBlob);
      }
      _activeViewerKey = key;
      _activeViewerBlob = value;
      return;
    }
    URL.revokeObjectURL(value);
  }
}

// Bounded in-memory thumbnail cache: covers ~14 full screens (1080p) or typical volume chapters.
// Revokes blob URLs on capacity eviction, key replacement, and clear to prevent blob storage leaks.
export const THUMB_CACHE_CAPACITY = 250;
export const thumbnailCache = new BoundedMap(THUMB_CACHE_CAPACITY, _revokeBlobEntry);

let _archiveBlobGeneration = 0;
let _archiveBlobAbortController = null;

// Archive blob deduplication: viewer and nearby thumbnails share the same quivit:// fetch.
// Only one fetch per src, prioritized for viewer. Archive only. Disk thumbs are shell 96px, different URL.
const _archiveBlobPromises = new Map();
export function ensureArchiveBlob(src) {
  if (!src || !src.includes('/archive/')) return Promise.resolve(null);
  const cached = thumbnailCache.get(src);
  if (typeof cached === 'string' && cached.startsWith('blob:')) return Promise.resolve(cached);
  if (_archiveBlobPromises.has(src)) return _archiveBlobPromises.get(src);

  const gen = _archiveBlobGeneration;
  let signal;
  if (typeof AbortController !== 'undefined') {
    if (!_archiveBlobAbortController) _archiveBlobAbortController = new AbortController();
    signal = _archiveBlobAbortController.signal;
  }

  let p;
  p = fetch(src, signal ? { signal } : {}).then(r => r.blob()).then(blob => {
    if (gen !== _archiveBlobGeneration) {
      _archiveBlobPromises.delete(src);
      return null;
    }
    if (blob.size > ARCHIVE_BLOB_CACHE_ENTRY_MAX_BYTES) {
      _archiveBlobPromises.delete(src);
      return null;
    }
    const existing = thumbnailCache.get(src);
    if (typeof existing === 'string' && existing.startsWith('blob:')) {
      _archiveBlobPromises.delete(src);
      return existing;
    }
    if (thumbnailCache.has(src)) {
      // Thumbnail already set to true/retain while fetch was in flight, do not overwrite warm flag
      _archiveBlobPromises.delete(src);
      return null;
    }
    const blobUrl = URL.createObjectURL(blob);
    if (gen !== _archiveBlobGeneration) {
      URL.revokeObjectURL(blobUrl);
      _archiveBlobPromises.delete(src);
      return null;
    }
    thumbnailCache.set(src, blobUrl);
    _rememberArchiveBlobSize(src, blob.size);
    _trimArchiveBlobCache();
    _archiveBlobPromises.delete(src);
    return blobUrl;
  }).catch((err) => {
    if (gen !== _archiveBlobGeneration || err?.name === 'AbortError') {
      _archiveBlobPromises.delete(src);
      return null;
    }
    if (!thumbnailCache.has(src)) thumbnailCache.set(src, true);
    _archiveBlobPromises.delete(src);
    return null;
  });
  _archiveBlobPromises.set(src, p);
  return p;
}

export const FAVORITES_CACHE_CAPACITY = 250;
export const favoritesThumbnailCache = new BoundedMap(FAVORITES_CACHE_CAPACITY, _revokeBlobEntry);

export function clearLibraryPathCaches() {
  thumbnailCache.clear();
  favoritesThumbnailCache.clear();
}

// Canonical large format/folder icons (~20 entries).
// Separate from thumbnailCache so image scrolling can't evict them.
const staticIconCache = new Map();

function isSvgSrc(src) {
  if (!src) return false;
  try { return new URL(src).pathname.toLowerCase().endsWith('.svg'); }
  catch { return src.split('?')[0].split('#')[0].toLowerCase().endsWith('.svg'); }
}

const ANIMATED_SVG_CACHE_CAPACITY = 512;
const animatedSvgSrcs = new BoundedSet(ANIMATED_SVG_CACHE_CAPACITY);

async function markIfAnimatedSvg(targetSrc, filePath) {
  if (animatedSvgSrcs.has(targetSrc)) return;
  try {
    const anim = await Core.checkIsAnimated(filePath, null);
    if (anim.is_animated) animatedSvgSrcs.add(targetSrc);
  } catch { /* detection failed, treat as static */ }
}

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
function updateDownloadRow(destPath, status, size = 0) {
  if (!destPath) return;
  const state = Core.getState();
  for (const [idx, li] of activeRows) {
    if (li.dataset.index === undefined) continue;
    const item = state.list?.[idx];
    if (!item || !_pathsEqual(item.path, destPath)) continue;

    if (status === 'completed') {
      item.size = size || 1;
    }
    updateEntry(li, item, idx);

    if (status === 'completed' && state.fileListViewMode === 'thumbnail' && li._slots?.thumbImg) {
      const targetSrc = FsUtils.buildThumbnailSrc(item, state);
      if (targetSrc && li._slots.thumbImg.getAttribute('src') !== targetSrc) {
        li._slots.thumbImg.src = targetSrc;
        li._slots.thumbImg.classList.add('is-loaded');
      }
    }
    break;
  }
}

// Completed downloads gain their real size so future renders no longer treat
// them as placeholders. Queue status events repaint the visible row in place.
window.addEventListener('quivit-download-complete', (e) => {
  updateDownloadRow(e.detail?.destPath, 'completed', e.detail?.size);
});

window.addEventListener('quivit-download-status', (e) => {
  const { destPath, status } = e.detail || {};
  if (destPath && status) {
    updateDownloadRow(destPath, status);
  }
});
let freePool = [];
let scrollSpacer = null;
let ROW_HEIGHT = 0;
let currentViewMode = null;
let btnToggleViewMode = null;
const OVERSCAN = 10;

// Thumbnail scroll settling
let isScrolling = false;
let scrollDebounceTimer = null;
const THUMB_SCROLL_DEBOUNCE_MS = 100;
const TRANSPARENT_PIXEL = 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCI+PC9zdmc+';

// Viewport-bound thumbnail queue for heavy decodes (archive + 1:1 file assets)
const VIEWPORT_MARGIN = 1;
let imageViewportStart = 0;
let imageViewportEnd = 0;
let lastScrollTop = 0;
let scrollDirection = 1;
const PLACEHOLDER_HTML = '<svg class="placeholder-icon icon-image" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect><circle cx="8.5" cy="8.5" r="1.5"></circle><polyline points="21 15 16 10 5 21"></polyline></svg><svg class="placeholder-icon icon-folder" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path></svg><svg class="placeholder-icon icon-archive" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect width="20" height="5" x="2" y="3" rx="1"></rect><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"></path><path d="M10 12h4"></path></svg><svg class="placeholder-icon icon-file" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path><polyline points="14 2 14 8 20 8"></polyline></svg>';

export function getPlaceholderType(item) {
  if (!item) return 'file';
  if (item.is_dir || item.is_parent || item.is_drive) return 'folder';
  if (FsUtils.isArchiveEntry(item) || FsUtils.isArchive(item.name || item.path || '')) return 'archive';
  if (FsUtils.isImageEntry(item) || FsUtils.isImage(item.name || item.path || '')) return 'image';
  return 'file';
}

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

// Library
let libraryPanelEl = null;
let libLastClickPath = '';
let libLastClickTime = 0;
let highlightedLibraryPath = '';

let activeArmedRemoveBtn = null;
let activeArmedDisarmFn = null;
let activeArmedLibPath = '';

function disarmActiveRemoveBtn() {
  activeArmedLibPath = '';
  if (activeArmedDisarmFn) {
    const fn = activeArmedDisarmFn;
    activeArmedRemoveBtn = null;
    activeArmedDisarmFn = null;
    fn();
  }
}

// Global listener for interactions heard elsewhere: only disarm if interaction is elsewhere
window.addEventListener('pointerdown', (e) => {
  if (activeArmedRemoveBtn && !activeArmedRemoveBtn.contains(e.target)) {
    disarmActiveRemoveBtn();
  }
}, true);

window.addEventListener('keydown', (e) => {
  if (activeArmedRemoveBtn) {
    if (e.key === 'Escape') {
      disarmActiveRemoveBtn();
      e.preventDefault();
      e.stopPropagation();
    } else if (e.key !== 'Enter' && e.key !== ' ') {
      disarmActiveRemoveBtn();
    }
  }
}, true);

export const LIBRARY_CACHE_CAPACITY = 250;
export const libraryThumbnailCache = new BoundedMap(LIBRARY_CACHE_CAPACITY, _revokeBlobEntry);
const MIN_REFRESH_DURATION_MS = 200;
let refreshPulseTimer = null;
let refreshStartTime = 0;
let thumbRefreshTimestamp = 0;

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

  fetchNativeIcon(FsUtils._isPathSpecificIcon(ext) ? item.path : '', ext, size);
  return `<img data-ext="${CSS.escape(ext)}" data-icon-key="${CSS.escape(cacheKey)}" draggable="false" src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNCIgaGVpZ2h0PSIxNCI+PC9zdmc+">`;
}

function _pathsEqual(a, b) {
  if (!a || !b) return false;
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

const EMPTY_BOX_HTML = '<span class="lib-remove-box"></span>';
const CLOSE_X_SVG = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>';

function openFavorite(fav) {
  focusMainListOnNextRender = true;
  if (FsUtils) {
    FsUtils.loadFile(fav.path).catch(err => {
      console.error(err);
      refreshFavoritesAfterFilesystemChange();
    });
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
  thumbImg.onload = () => {
    if (thumbImg.getAttribute('src') && !thumbImg.getAttribute('src').startsWith('data:image/svg+xml')) {
      thumbImg.classList.add('is-loaded');
    }
  };
  thumbWrapper.appendChild(thumbImg);

  const thumbPlaceholder = document.createElement('span');
  thumbPlaceholder.className = 'item-thumbnail-placeholder';
  thumbPlaceholder.setAttribute('aria-hidden', 'true');
  thumbPlaceholder.dataset.type = getPlaceholderType(fav);
  thumbPlaceholder.innerHTML = PLACEHOLDER_HTML;
  thumbWrapper.appendChild(thumbPlaceholder);

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
  const targetSrc = FsUtils.buildThumbnailSrc(fav, null);
  thumbImg.onerror = () => {
    thumbImg.onerror = null;
    const currentSrc = thumbImg.getAttribute('src') || '';
    if (currentSrc.includes('/thumb/')) {
      thumbImg.onerror = () => {
        thumbImg.onerror = null;
        const iconPath = FsUtils._isPathSpecificIcon(ext) ? fav.path : '';
        const fallbackSrc = FsUtils.buildNativeIconSrc(iconPath, ext, 'large');
        favoritesThumbnailCache.set(targetSrc, fallbackSrc);
        thumbImg.src = fallbackSrc;
      };
      const directSrc = FsUtils.buildFileSrcSync(fav.path);
      favoritesThumbnailCache.set(targetSrc, directSrc);
      thumbImg.src = directSrc;
    } else {
      const iconPath = FsUtils._isPathSpecificIcon(ext) ? fav.path : '';
      const fallbackSrc = FsUtils.buildNativeIconSrc(iconPath, ext, 'large');
      favoritesThumbnailCache.set(targetSrc, fallbackSrc);
      thumbImg.src = fallbackSrc;
    }
  };
  thumbImg.onload = () => {
    const src = thumbImg.getAttribute('src');
    if (src && !src.startsWith('data:image/svg+xml')) {
      thumbImg.classList.add('is-loaded');
      if (!favoritesThumbnailCache.has(src)) {
        favoritesThumbnailCache.set(src, true);
      }
    }
  };
  const cachedFav = favoritesThumbnailCache.get(targetSrc);
  if (cachedFav !== undefined) {
    if (animatedSvgSrcs.has(targetSrc)) thumbImg.loading = 'eager';
    thumbImg.src = typeof cachedFav === 'string' ? cachedFav : targetSrc;
    thumbImg.classList.add('is-loaded');
  } else {
    thumbImg.loading = 'lazy';
    thumbImg.src = targetSrc;
  }
  if (isSvgSrc(targetSrc) && fav.path) {
    markIfAnimatedSvg(targetSrc, fav.path);
  }

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
  if (!favs.some(favorite => favorite.path === highlightedFavoritePath)) {
    highlightedFavoritePath = '';
  }
  
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

let favoritesRefreshTimer = null;

function refreshFavoritesAfterFilesystemChange() {
  clearTimeout(favoritesRefreshTimer);
  favoritesRefreshTimer = setTimeout(async () => {
    const movingLibrary = await window.__TAURI__?.core
      ?.invoke('library_move_in_progress')
      .catch(() => false);
    if (movingLibrary) return;

    reconcileFavorites().then(changed => {
      if (!changed) return;
      renderFavorites();
      const state = Core.getState();
      updateFavoriteBtn(state.list?.[state.index]?.path || '');
    }).catch(err => {
      console.error('[FilePanel] Failed to reconcile Favorites after a filesystem change:', err);
    });
  }, 250);
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

// -- Library Panel --

function openLibraryEntry(item) {
  focusMainListOnNextRender = true;
  if (FsUtils && item?.path) {
    FsUtils.loadFile(item.path).catch(console.error);
  }
}

function formatLibraryDate(dateStr) {
  if (!dateStr) return '';
  const millis = parseInt(dateStr, 10);
  if (!millis || isNaN(millis)) return dateStr;
  const d = new Date(millis);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function buildLibraryEntry(item, depth = 0) {
  const li = document.createElement('li');
  li.title = item.title ? `${item.title}\n${item.path}` : item.path;
  li.dataset.path = item.path;
  li.style.setProperty('--library-indent', `${depth * 12}px`);
  li.setAttribute('role', 'option');
  li.setAttribute('tabindex', '0');

  // List mode elements
  const itemName = document.createElement('span');
  itemName.className = 'item-name';
  itemName.innerHTML = getIconHtml(item);

  const itemLabel = document.createElement('span');
  itemLabel.className = 'item-label';
  itemLabel.textContent = item.title || item.name;
  itemName.appendChild(itemLabel);

  const itemExt = document.createElement('span');
  itemExt.className = 'item-ext';
  itemExt.textContent = item.is_dir ? 'DIR' : (item.name.includes('.') ? item.name.split('.').pop().toUpperCase() : '');

  const itemDate = document.createElement('span');
  itemDate.className = 'item-date';
  itemDate.textContent = formatLibraryDate(item.date);

  // Thumbnail mode elements
  const thumbWrapper = document.createElement('div');
  thumbWrapper.className = 'item-thumbnail-wrapper';
  const thumbImg = document.createElement('img');
  thumbImg.className = 'item-thumbnail-img';
  thumbImg.draggable = false;
  thumbImg.onload = () => {
    if (thumbImg.getAttribute('src') && !thumbImg.getAttribute('src').startsWith('data:image/svg+xml')) {
      thumbImg.classList.add('is-loaded');
    }
  };
  thumbWrapper.appendChild(thumbImg);

  const thumbPlaceholder = document.createElement('span');
  thumbPlaceholder.className = 'item-thumbnail-placeholder';
  thumbPlaceholder.setAttribute('aria-hidden', 'true');
  thumbPlaceholder.dataset.type = getPlaceholderType(item);
  thumbPlaceholder.innerHTML = PLACEHOLDER_HTML;
  thumbWrapper.appendChild(thumbPlaceholder);

  const thumbInfo = document.createElement('div');
  thumbInfo.className = 'item-thumbnail-info';
  const thumbTitle = document.createElement('span');
  thumbTitle.className = 'item-thumbnail-title';
  thumbTitle.textContent = item.title || item.name;
  const thumbMeta = document.createElement('span');
  thumbMeta.className = 'item-thumbnail-meta';

  if (item.is_dir) {
    thumbMeta.textContent = item.image_count > 0 ? `${item.image_count} images` : 'Folder';
  } else {
    thumbMeta.textContent = 'Image';
  }
  thumbInfo.appendChild(thumbTitle);
  thumbInfo.appendChild(thumbMeta);

  const ext = FsUtils.getIconExtKey(item);
  const targetSrc = FsUtils.buildThumbnailSrc(item, null);
  thumbImg.onerror = () => {
    thumbImg.onerror = null;
    const currentSrc = thumbImg.getAttribute('src') || '';
    if (currentSrc.includes('/thumb/')) {
      thumbImg.onerror = () => {
        thumbImg.onerror = null;
        const iconPath = FsUtils._isPathSpecificIcon(ext) ? item.path : '';
        const fallbackSrc = FsUtils.buildNativeIconSrc(iconPath, ext, 'large');
        libraryThumbnailCache.set(targetSrc, fallbackSrc);
        thumbImg.src = fallbackSrc;
      };
      const directSrc = FsUtils.buildFileSrcSync(item.path);
      libraryThumbnailCache.set(targetSrc, directSrc);
      thumbImg.src = directSrc;
    } else {
      const iconPath = FsUtils._isPathSpecificIcon(ext) ? item.path : '';
      const fallbackSrc = FsUtils.buildNativeIconSrc(iconPath, ext, 'large');
      libraryThumbnailCache.set(targetSrc, fallbackSrc);
      thumbImg.src = fallbackSrc;
    }
  };
  thumbImg.onload = () => {
    const src = thumbImg.getAttribute('src');
    if (src && !src.startsWith('data:image/svg+xml')) {
      thumbImg.classList.add('is-loaded');
      if (!libraryThumbnailCache.has(src)) {
        libraryThumbnailCache.set(src, true);
      }
    }
  };

  const cachedThumb = libraryThumbnailCache.get(targetSrc);
  if (cachedThumb !== undefined) {
    if (animatedSvgSrcs.has(targetSrc)) thumbImg.loading = 'eager';
    thumbImg.src = typeof cachedThumb === 'string' ? cachedThumb : targetSrc;
    thumbImg.classList.add('is-loaded');
  } else {
    thumbImg.loading = 'lazy';
    thumbImg.src = targetSrc;
  }
  if (isSvgSrc(targetSrc) && item.path) {
    markIfAnimatedSvg(targetSrc, item.path);
  }

  const canDelete = item.is_gallery || !item.is_dir;

  // Defensive deletion button (moves to Recycle Bin)
  const removeBtn = document.createElement('button');
  removeBtn.className = 'lib-remove';
  removeBtn.tabIndex = -1;
  removeBtn.hidden = !canDelete;
  removeBtn.title = 'Move to Recycle Bin';
  removeBtn.setAttribute('aria-label', 'Move to Recycle Bin');
  removeBtn.innerHTML = EMPTY_BOX_HTML;

  const disarm = () => {
    removeBtn.classList.remove('is-confirming');
    removeBtn.title = 'Move to Recycle Bin';
    removeBtn.setAttribute('aria-label', 'Move to Recycle Bin');
    removeBtn.innerHTML = EMPTY_BOX_HTML;
    if (_pathsEqual(activeArmedLibPath, item.path)) {
      activeArmedLibPath = '';
    }
    if (activeArmedRemoveBtn === removeBtn) {
      activeArmedRemoveBtn = null;
      activeArmedDisarmFn = null;
    }
  };

  const arm = () => {
    if (activeArmedRemoveBtn && activeArmedRemoveBtn !== removeBtn) {
      disarmActiveRemoveBtn();
    }
    removeBtn.classList.add('is-confirming');
    removeBtn.title = 'Delete local';
    removeBtn.setAttribute('aria-label', 'Delete local');
    removeBtn.innerHTML = CLOSE_X_SVG;
    activeArmedLibPath = item.path || '';
    activeArmedRemoveBtn = removeBtn;
    activeArmedDisarmFn = disarm;
  };

  if (canDelete && item.path && _pathsEqual(item.path, activeArmedLibPath)) {
    arm();
  }

  if (canDelete) {
    removeBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      if (!removeBtn.classList.contains('is-confirming')) {
        arm();
        return;
      }

      disarm();
      try {
        if (typeof cancelGalleryDownloads === 'function') {
          cancelGalleryDownloads(item.path);
        }

        const state = Core?.getState?.();
        const curDir = (state?.directory || '').replace(/\\/g, '/').toLowerCase();
        const targetDir = (item.path || '').replace(/\\/g, '/').toLowerCase();
        const isInside = curDir === targetDir || (targetDir && curDir.startsWith(targetDir + '/'));

        if (isInside && FsUtils?.openParent) {
          await FsUtils.openParent();
        }

        if (targetDir) {
          for (const key of Array.from(thumbnailCache.keys())) {
            const k = String(key).replace(/\\/g, '/').toLowerCase();
            if (k.includes(targetDir)) {
              thumbnailCache.delete(key);
            }
          }
        }

        await deleteLibraryEntry(item.path).catch(async (err) => {
          if (!isLibraryLocationError(err)) throw err;
          // The entry was rendered from a stale Library root (the location
          // moved in another window). Remap it onto the live root and retry.
          const staleRoot = typeof getCachedLibraryDir === 'function' ? getCachedLibraryDir() : '';
          const liveRoot = typeof reloadLibraryDir === 'function' ? await reloadLibraryDir() : '';
          const remapped = remapLibraryPath(item.path, staleRoot, liveRoot);
          if (remapped === item.path) throw err;
          await deleteLibraryEntry(remapped);
        });
        await renderLibrary();

        const parentOfTarget = targetDir.includes('/') ? targetDir.substring(0, targetDir.lastIndexOf('/')) : '';
        if (FsUtils?.refresh && (isInside || curDir === targetDir || curDir === parentOfTarget)) {
          await FsUtils.refresh();
        }
      } catch (err) {
        console.error('[FilePanel] Delete failed:', err);
      }
    });
  }

  li.appendChild(itemName);
  li.appendChild(itemExt);
  li.appendChild(itemDate);
  li.appendChild(thumbWrapper);
  li.appendChild(thumbInfo);
  li.appendChild(removeBtn);

  li.addEventListener('focus', () => {
    highlightLibraryByPath(item.path);
    if (libraryPanelEl) {
      for (const row of libraryPanelEl.querySelectorAll('.library-provider-list li')) {
        const btn = row.querySelector('.lib-remove');
        if (btn) btn.tabIndex = -1;
      }
    }
    removeBtn.tabIndex = canDelete ? 0 : -1;
  });

  removeBtn.addEventListener('focus', () => {
    if (libraryPanelEl) {
      for (const row of libraryPanelEl.querySelectorAll('.library-provider-list li')) {
        const btn = row.querySelector('.lib-remove');
        if (btn) btn.tabIndex = -1;
      }
    }
    removeBtn.tabIndex = 0;
  });

  li.addEventListener('click', () => {
    highlightLibraryByPath(item.path);
    if (item.is_dir) {
      const now = Date.now();
      if (libLastClickPath === item.path && (now - libLastClickTime < 400)) {
        libLastClickPath = '';
        libLastClickTime = 0;
        openLibraryEntry(item);
      } else {
        libLastClickPath = item.path;
        libLastClickTime = now;
      }
    } else {
      openLibraryEntry(item);
    }
  });

  return li;
}

export async function renderLibrary() {
  if (!libraryPanelEl) return;
  const tree = await fetchLibraryTree();
  const hasAny = hasLibraryEntries(tree);

  libraryPanelEl.classList.toggle('is-empty', !hasAny);
  libraryPanelEl.innerHTML = '';
  if (!hasAny) {
    disarmActiveRemoveBtn();
    return;
  }

  let allCollapsed = true;

  for (const provider of tree) {
    if (!provider.nodes || provider.nodes.length === 0) continue;

    const isProvCollapsed = getProviderCollapsed(provider.name);
    if (!isProvCollapsed) allCollapsed = false;

    const provHeader = document.createElement('div');
    provHeader.className = 'library-provider-header';
    provHeader.tabIndex = 0;
    provHeader.setAttribute('role', 'button');
    provHeader.setAttribute('aria-expanded', isProvCollapsed ? 'false' : 'true');
    provHeader.setAttribute('aria-controls', `library-list-${provider.name}`);
    provHeader.dataset.provider = provider.name;
    provHeader.innerHTML = `<span>${provider.name}</span><span class="toggle-icon">${isProvCollapsed ? '▼' : '▲'}</span>`;

    const listUl = document.createElement('ul');
    listUl.id = `library-list-${provider.name}`;
    listUl.className = 'library-provider-list';
    if (isProvCollapsed) listUl.classList.add('collapsed');
    listUl.setAttribute('role', 'listbox');
    listUl.setAttribute('aria-label', `${provider.name} library`);

    const toggleProv = () => {
      const nowCollapsed = !listUl.classList.contains('collapsed');
      listUl.classList.toggle('collapsed', nowCollapsed);
      saveProviderCollapsed(provider.name, nowCollapsed);
      provHeader.setAttribute('aria-expanded', nowCollapsed ? 'false' : 'true');
      const icon = provHeader.querySelector('.toggle-icon');
      if (icon) icon.textContent = nowCollapsed ? '▼' : '▲';

      const anyOpen = Array.from(libraryPanelEl.querySelectorAll('.library-provider-list')).some(ul => !ul.classList.contains('collapsed'));
      libraryPanelEl.classList.toggle('all-collapsed', !anyOpen);
    };

    provHeader.addEventListener('click', toggleProv);
    provHeader.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleProv();
      }
    });

    const appendNodes = (nodes, depth) => {
      for (const node of nodes) {
        if (!node.is_dir && depth > 0) continue;
        listUl.appendChild(buildLibraryEntry(node, depth));
        if (node.children?.length) appendNodes(node.children, depth + 1);
      }
    };
    appendNodes(provider.nodes, 0);

    libraryPanelEl.appendChild(provHeader);
    libraryPanelEl.appendChild(listUl);
  }

  libraryPanelEl.classList.toggle('all-collapsed', allCollapsed);

  if (activeArmedLibPath && (!activeArmedRemoveBtn || !libraryPanelEl.contains(activeArmedRemoveBtn))) {
    activeArmedLibPath = '';
    activeArmedRemoveBtn = null;
    activeArmedDisarmFn = null;
  }

  if (Core) updateLibrarySelection(Core.getState());
}

function updateLibrarySelection(state) {
  if (!libraryPanelEl) return;
  const items = Array.from(libraryPanelEl.querySelectorAll('.library-provider-list li'));
  if (!items.length) return;

  const containerPath = state.mode === 'archive' ? state.archivePath : state.directory;
  const isContainerInLibrary = containerPath && items.some(li => _pathsEqual(li.dataset.path, containerPath));

  let activePath = '';
  if (isContainerInLibrary) {
    activePath = containerPath;
  } else {
    const entry = state.list?.[state.index];
    if (entry && !entry.is_parent) {
      activePath = entry.path;
    }
  }
  for (const li of items) {
    li.classList.toggle('selected', _pathsEqual(li.dataset.path, activePath));
  }
}

export function highlightLibraryByPath(path) {
  highlightedLibraryPath = path;
  if (!libraryPanelEl) return;
  for (const li of libraryPanelEl.querySelectorAll('.library-provider-list li')) {
    li.classList.toggle('selected', _pathsEqual(li.dataset.path, path));
  }
}

export function getHighlightedLibrary() {
  if (!highlightedLibraryPath || !libraryPanelEl) return null;
  const el = libraryPanelEl.querySelector(`.library-provider-list li[data-path="${CSS.escape(highlightedLibraryPath)}"]`);
  return el ? { path: highlightedLibraryPath } : null;
}

export function navigateHighlightedLibrary(delta) {
  if (!libraryPanelEl) return;
  const items = Array.from(libraryPanelEl.querySelectorAll('.library-provider-list:not(.collapsed) li'));
  if (!items.length) return;
  const currentIndex = items.findIndex(li => _pathsEqual(li.dataset.path, highlightedLibraryPath));
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

  fetchNativeIcon(FsUtils._isPathSpecificIcon(ext) ? item.path : '', ext, 'small');
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
    const failedItem = Core.getState().list?.[index];
    if (failedItem?.path && retryGalleryDownload(failedItem.path)) {
      return;
    }
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
  thumbImg.onload = () => {
    const src = thumbImg.getAttribute('src');
    if (src && !src.startsWith('data:image/svg+xml')) {
      thumbImg.classList.add('is-loaded');
      if (!thumbnailCache.has(src)) {
        if (isSvgSrc(src)) {
          thumbnailCache.set(src, true);
        } else if (src.includes('/archive/')) {
          // Archive only: 1:1 thumb == viewer URL. Dedupe via shared promise, viewer prioritized.
          ensureArchiveBlob(src);
        } else {
          thumbnailCache.set(src, true);
        }
      }
    }
  };
  thumbWrapper.appendChild(thumbImg);

  const thumbPlaceholder = document.createElement('span');
  thumbPlaceholder.className = 'item-thumbnail-placeholder';
  thumbPlaceholder.setAttribute('aria-hidden', 'true');
  thumbPlaceholder.dataset.type = 'image';
  thumbPlaceholder.innerHTML = PLACEHOLDER_HTML;
  thumbWrapper.appendChild(thumbPlaceholder);

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
    thumbPlaceholder,
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
  // Restore visibility before src assignment so animated SVGs start SMIL in visible context (disk SVG only)
  li.style.top = `${index * ROW_HEIGHT}px`;
  li.style.display = '';
  li.dataset.index = index;
  const downloadStatus = getGalleryDownloadStatus(item.path);
  const hasDownloadError = downloadStatus === 'error';
  const isPendingDownload = !hasDownloadError
    && !item.is_dir
    && !item.is_parent
    && (downloadStatus === 'pending' || downloadStatus === 'downloading' || item.size === 0);

  li.title = item.name && item.name !== '..'
    ? (hasDownloadError ? `${item.displayName || item.name}\nDownload failed. Click to retry.` : (item.displayName || item.name))
    : '';
  li.classList.toggle('is-hidden-entry', !!item.is_hidden);
  li.classList.toggle('is-pending-download', isPendingDownload);
  li.classList.toggle('is-download-error', hasDownloadError);
  if (hasDownloadError) {
    li.dataset.downloadStatus = 'error';
  } else {
    delete li.dataset.downloadStatus;
  }

  const state = Core.getState();
  const isThumbnail = state.fileListViewMode === 'thumbnail';
  const slots = li._slots;
  if (!slots) return;

  if (isThumbnail) {
    if (slots.thumbTitle) slots.thumbTitle.textContent = item.displayName || item.name || '';
    if (slots.thumbMeta) {
      if (item.is_parent) {
        slots.thumbMeta.textContent = 'Parent folder';
      } else if (item.is_drive) {
        slots.thumbMeta.textContent = 'Drive';
      } else if (item.is_dir) {
        slots.thumbMeta.textContent = item.date ? `Folder • ${item.date}` : 'Folder';
      } else if (hasDownloadError) {
        slots.thumbMeta.textContent = 'Download failed. Click to retry.';
      } else {
        const ext = (item.ext || '').toUpperCase();
        slots.thumbMeta.textContent = ext ? (item.date ? `${ext} • ${item.date}` : ext) : (item.date || '');
      }
    }

    if (slots.thumbPlaceholder) {
      const pType = getPlaceholderType(item);
      if (slots.thumbPlaceholder.dataset.type !== pType) {
        slots.thumbPlaceholder.dataset.type = pType;
      }
    }

    if (slots.thumbImg) {
      const ext = FsUtils.getIconExtKey(item);
      const isImage = FsUtils.isImageEntry(item);
      let targetSrc = FsUtils.buildThumbnailSrc(item, state);
      const isConstrained = isImage && FsUtils.isConstrainedThumbnailSrc(targetSrc);
      const outsideViewport = isConstrained && (index < imageViewportStart || index >= imageViewportEnd);
      if (thumbRefreshTimestamp && isImage && targetSrc) {
        targetSrc = targetSrc.includes('?') ? `${targetSrc}&_t=${thumbRefreshTimestamp}` : `${targetSrc}?_t=${thumbRefreshTimestamp}`;
      }

      slots.thumbImg.onerror = () => {
        slots.thumbImg.onerror = null;
        const currentSrc = slots.thumbImg.getAttribute('src') || '';
        if (currentSrc.includes('/thumb/')) {
          slots.thumbImg.onerror = () => {
            slots.thumbImg.onerror = null;
            const iconPath = FsUtils._isPathSpecificIcon(ext) ? item.path : '';
            const fallbackSrc = FsUtils.buildNativeIconSrc(iconPath, ext, 'large');
            thumbnailCache.set(targetSrc, fallbackSrc);
            slots.thumbImg.src = fallbackSrc;
          };
          const directSrc = FsUtils.buildFileSrcSync(item.path);
          thumbnailCache.set(targetSrc, directSrc);
          slots.thumbImg.src = directSrc;
        } else {
          const iconPath = FsUtils._isPathSpecificIcon(ext) ? item.path : '';
          const fallbackSrc = FsUtils.buildNativeIconSrc(iconPath, ext, 'large');
          thumbnailCache.set(targetSrc, fallbackSrc);
          slots.thumbImg.src = fallbackSrc;
        }
      };

      const cachedEntry = thumbnailCache.get(targetSrc);
      const isCached = cachedEntry !== undefined;

      if (!isImage) {
        delete slots.thumbImg.dataset.pendingSrc;
        const isStaticCached = staticIconCache.has(targetSrc);
        if (slots.thumbImg.getAttribute('src') !== targetSrc) {
          slots.thumbImg.classList.remove('is-loaded');
          slots.thumbImg.loading = 'lazy';
          slots.thumbImg.src = targetSrc;
        }
        if (!isStaticCached) {
          slots.thumbImg.onload = () => {
            staticIconCache.set(targetSrc, true);
            slots.thumbImg.classList.add('is-loaded');
          };
        } else {
          slots.thumbImg.classList.add('is-loaded');
        }
      } else if (isCached) {
        // Thumbnail was previously loaded and is cached in memory.
        // Re-use immediately without deferral or skeleton placeholder flash.
        delete slots.thumbImg.dataset.pendingSrc;
        const finalSrc = typeof cachedEntry === 'string' ? cachedEntry : targetSrc;
        if (animatedSvgSrcs.has(finalSrc)) slots.thumbImg.loading = 'eager';
        if (slots.thumbImg.getAttribute('src') !== finalSrc) {
          slots.thumbImg.src = finalSrc;
        }
        slots.thumbImg.classList.add('is-loaded');
      } else if (outsideViewport && index !== Core.getState().index) {
        // Heavy thumbnail outside visible viewport + safety margin: defer for commit
        slots.thumbImg.dataset.pendingSrc = targetSrc;
        if (slots.thumbImg.getAttribute('src') !== TRANSPARENT_PIXEL) {
          slots.thumbImg.classList.remove('is-loaded');
          slots.thumbImg.src = TRANSPARENT_PIXEL;
        }
      } else if (isScrolling && index !== Core.getState().index) {
        // Uncached image thumbnail during rapid scrolling: defer decode to protect scroll performance
        // Exception: viewer active item must not wait for scroll settle. Prioritize viewer
        slots.thumbImg.dataset.pendingSrc = targetSrc;
        if (slots.thumbImg.getAttribute('src') !== TRANSPARENT_PIXEL) {
          slots.thumbImg.classList.remove('is-loaded');
          slots.thumbImg.src = TRANSPARENT_PIXEL;
        }
      } else {
        // Uncached image thumbnail when scroll is settled: initiate load
        // Viewer priority: active image loads immediately, others deferred to next tick so viewer fetch gets connection first
        delete slots.thumbImg.dataset.pendingSrc;
        if (slots.thumbImg.getAttribute('src') !== targetSrc) {
          if (index === Core.getState().index) {
            slots.thumbImg.classList.remove('is-loaded');
            slots.thumbImg.loading = 'eager';
            slots.thumbImg.src = targetSrc;
            if (isSvgSrc(targetSrc) && item.path) {
              markIfAnimatedSvg(targetSrc, item.path);
            }
            // Archive only: also warm blob cache for viewer reuse (deduplicated, low overhead)
            if (targetSrc.includes('/archive/')) ensureArchiveBlob(targetSrc);
          } else {
            slots.thumbImg.classList.remove('is-loaded');
            slots.thumbImg.loading = 'lazy';
            // Defer non-active thumbs so viewer image (same tick via Core listener) starts fetch first
            const pendingTarget = targetSrc;
            const pendingItemPath = item.path;
            setTimeout(() => {
              if (slots.thumbImg.getAttribute('src') === pendingTarget) return;
              // Check if still relevant (row may have been recycled)
              const currentIdx = parseInt(slots.thumbImg.closest('li')?.dataset.index, 10);
              if (!Number.isFinite(currentIdx) || currentIdx !== index) return;
              // Yield if viewer is still loading the active image (archive blob not yet ready)
              const viewerSrc = Core.getState().src;
              const viewerBlobPending = viewerSrc && viewerSrc.includes('/archive/') && !thumbnailCache.has(viewerSrc);
              if (viewerBlobPending) {
                // Retry after viewer blob settles
                setTimeout(() => {
                  if (slots.thumbImg.getAttribute('src') !== pendingTarget && parseInt(slots.thumbImg.closest('li')?.dataset.index, 10) === index) {
                    slots.thumbImg.src = pendingTarget;
                    if (isSvgSrc(pendingTarget) && pendingItemPath) markIfAnimatedSvg(pendingTarget, pendingItemPath);
                  }
                }, 120);
                return;
              }
              slots.thumbImg.src = pendingTarget;
              if (isSvgSrc(pendingTarget) && pendingItemPath) markIfAnimatedSvg(pendingTarget, pendingItemPath);
            }, 0);
          }
        }
      }
    }
  } else {
    updateRowIcon(slots, item);
    if (slots.label) slots.label.textContent = item.displayName || item.name || '';
    if (slots.ext) slots.ext.textContent = hasDownloadError ? 'FAILED' : (item.is_dir ? 'DIR' : (item.ext || ''));
    if (slots.date) slots.date.textContent = item.date || '';
  }
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
      const img = li._slots?.thumbImg;
      if (img) {
        delete img.dataset.pendingSrc;
        img.removeAttribute('loading');
        img.classList.remove('is-loaded');
        img.src = TRANSPARENT_PIXEL;
      }
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

  // Heavy-thumbnail viewport bounds: visible rows + 1-item safety margin for smooth scroll
  const isThumbnailView = state.fileListViewMode === 'thumbnail';
  if (isThumbnailView) {
    imageViewportStart = Math.max(0, rawStart - VIEWPORT_MARGIN);
    imageViewportEnd = Math.min(total, rawStart + visibleCount + VIEWPORT_MARGIN);
  } else {
    imageViewportStart = startIndex;
    imageViewportEnd = endIndex;
  }

  // Pipe viewport bounds to the URL download queue: visible rows + 1 buffer row on each side
  const downloadStart = Math.max(0, rawStart - VIEWPORT_MARGIN);
  const downloadEnd = Math.min(total, rawStart + visibleCount + VIEWPORT_MARGIN);
  setDownloadVisibleRange(downloadStart, downloadEnd);

  // Phase 1: Reclaim offscreen rows into freePool (VS Code RowCache pattern)
  for (const [idx, li] of activeRows) {
    if (idx < startIndex || idx >= endIndex) {
      activeRows.delete(idx);
      li.style.display = 'none';
      li.style.top = '';
      li.dataset.index = '';
      li.classList.remove('selected');
      const img = li._slots?.thumbImg;
      if (img) {
        delete img.dataset.pendingSrc;
        img.removeAttribute('loading');
        img.classList.remove('is-loaded');
        img.src = TRANSPARENT_PIXEL;
      }
      freePool.push(li);
    }
  }

  // Phase 1b: Clear heavy thumbnails on rows still in the DOM pool but outside viewport margin
  if (isThumbnailView) {
    for (const [idx, li] of activeRows) {
      if (idx < imageViewportStart || idx >= imageViewportEnd) {
        const img = li._slots?.thumbImg;
        if (img) {
          const src = img.getAttribute('src') || '';
          if (src && src !== TRANSPARENT_PIXEL && FsUtils.isConstrainedThumbnailSrc(src)) {
            img.dataset.pendingSrc = src;
            img.classList.remove('is-loaded');
            img.src = TRANSPARENT_PIXEL;
          }
        }
      }
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

function onScrollSettle() {
  isScrolling = false;
  scrollDebounceTimer = null;
  commitPendingThumbnails();
}

function commitPendingThumbnails() {
  const activeIdx = Core.getState().index;
  const isThumbnailView = Core.getState().fileListViewMode === 'thumbnail';

  // Filter to rows within viewport (constrained URLs only), sort by: active first, then scroll direction
  const ordered = Array.from(activeRows.values()).filter(li => {
    const img = li._slots?.thumbImg;
    if (!img || !img.dataset.pendingSrc) return false;
    if (!isThumbnailView) return true;
    if (!FsUtils.isConstrainedThumbnailSrc(img.dataset.pendingSrc)) return true;
    const idx = parseInt(li.dataset.index, 10);
    return idx >= imageViewportStart && idx < imageViewportEnd;
  }).sort((a, b) => {
    const ai = parseInt(a.dataset.index, 10);
    const bi = parseInt(b.dataset.index, 10);
    if (ai === activeIdx) return -1;
    if (bi === activeIdx) return 1;
    // Load in scroll direction: down (+1) loads ascending, up (-1) loads descending
    return scrollDirection >= 0 ? ai - bi : bi - ai;
  });

  for (let orderIdx = 0; orderIdx < ordered.length; orderIdx++) {
    const li = ordered[orderIdx];
    const img = li._slots?.thumbImg;
    if (img && img.dataset.pendingSrc) {
      const targetSrc = img.dataset.pendingSrc;
      delete img.dataset.pendingSrc;
      const cachedEntry = thumbnailCache.get(targetSrc);
      if (cachedEntry !== undefined) {
        const finalSrc = typeof cachedEntry === 'string' ? cachedEntry : targetSrc;
        if (animatedSvgSrcs.has(finalSrc)) img.loading = 'eager';
        if (img.getAttribute('src') !== finalSrc) {
          img.src = finalSrc;
        }
        img.classList.add('is-loaded');
      } else if (img.getAttribute('src') !== targetSrc) {
        const idx = parseInt(li.dataset.index, 10);
        const isActive = idx === activeIdx;
        if (isActive) {
          img.classList.remove('is-loaded');
          img.loading = 'eager';
          img.src = targetSrc;
          if (isSvgSrc(targetSrc)) {
            const item = Core.getState().list?.[idx];
            if (item?.path) markIfAnimatedSvg(targetSrc, item.path);
          }
          if (targetSrc.includes('/archive/')) ensureArchiveBlob(targetSrc);
        } else {
          // Defer non-active to let viewer fetch win connection race
          img.classList.remove('is-loaded');
          img.loading = 'lazy';
          const pendingSrc = targetSrc;
          setTimeout(() => {
            const currentIdx = parseInt(li.dataset.index, 10);
            if (currentIdx !== idx) return;
            if (img.getAttribute('src') === pendingSrc) return;
            const viewerSrc = Core.getState().src;
            const viewerBlobPending = viewerSrc && viewerSrc.includes('/archive/') && !thumbnailCache.has(viewerSrc);
            if (viewerBlobPending) {
              setTimeout(() => {
                if (parseInt(li.dataset.index, 10) === idx && img.getAttribute('src') !== pendingSrc) {
                  img.src = pendingSrc;
                  if (isSvgSrc(pendingSrc)) {
                    const it = Core.getState().list?.[idx];
                    if (it?.path) markIfAnimatedSvg(pendingSrc, it.path);
                  }
                }
              }, 120);
              return;
            }
            img.src = pendingSrc;
            if (isSvgSrc(pendingSrc)) {
              const it = Core.getState().list?.[idx];
              if (it?.path) markIfAnimatedSvg(pendingSrc, it.path);
            }
          }, 10 + orderIdx * 15);
        }
      }
    }
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
  if (!filePanel && !fileListUl && !favoritesListUl) return;
  clearTimeout(refreshPulseTimer);

  if (active) {
    _archiveBlobGeneration++;
    if (_archiveBlobAbortController) {
      _archiveBlobAbortController.abort();
      _archiveBlobAbortController = null;
    }
    _archiveBlobPromises.clear();
    thumbnailCache.clear();
    thumbRefreshTimestamp = Date.now();
    refreshStartTime = performance.now();
    filePanel?.classList.remove('refreshing');
    fileListUl?.classList.remove('refreshing');
    favoritesListUl?.classList.remove('refreshing');
    if (filePanel) void filePanel.offsetWidth;
    filePanel?.classList.add('refreshing');
    fileListUl?.classList.add('refreshing');
    favoritesListUl?.classList.add('refreshing');
    if (Core && Core.getState().fileListViewMode === 'thumbnail') {
      const list = Core.getState().list;
      if (list) {
        for (const [i, li] of activeRows) {
          if (list[i]) updateEntry(li, list[i], i);
        }
      }
      renderVisibleSlice();
    }
    return;
  }

  const elapsed = performance.now() - refreshStartTime;
  const remaining = Math.max(0, MIN_REFRESH_DURATION_MS - elapsed);

  refreshPulseTimer = setTimeout(() => {
    filePanel?.classList.remove('refreshing');
    fileListUl?.classList.remove('refreshing');
    favoritesListUl?.classList.remove('refreshing');
  }, remaining);
}

export function renderFilePanel(state) {
  if (!filePanel) return;

  if (_activeViewerBlob && state.src !== _activeViewerKey && state.src !== _activeViewerBlob) {
    let stillInCache = false;
    for (const val of thumbnailCache.values()) {
      if (val === _activeViewerBlob) {
        stillInCache = true;
        break;
      }
    }
    if (!stillInCache) {
      URL.revokeObjectURL(_activeViewerBlob);
      _activeViewerBlob = null;
      _activeViewerKey = null;
    }
  }

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
    const toggleLabel = isThumbnail ? 'Switch to List View' : 'Toggle Thumbnail View';
    btnToggleViewMode.setAttribute('title', toggleLabel);
    btnToggleViewMode.setAttribute('aria-label', toggleLabel);
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
      if (favoritesBtnEl) {
        favoritesBtnEl.disabled = false;
        favoritesBtnEl.tabIndex = 0;
      }
    } else {
      if (favoritesBtnEl) {
        favoritesBtnEl.disabled = true;
        favoritesBtnEl.tabIndex = -1;
        const svg = favoritesBtnEl.querySelector('svg');
        if (svg) svg.setAttribute('fill', 'none');
        favoritesBtnEl.classList.remove('active');
      }
    }
  }

  // Sync Favorites highlighting to the active file-panel item.
  updateFavoritesSelection(state);
  updateLibrarySelection(state);

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
  isScrolling = false;
  clearTimeout(scrollDebounceTimer);
  scrollDebounceTimer = null;
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
    const st = fileListUl.scrollTop;
    scrollDirection = st >= lastScrollTop ? 1 : -1;
    lastScrollTop = st;
    const state = Core.getState();
    if (state.fileListViewMode === 'thumbnail') {
      isScrolling = true;
      clearTimeout(scrollDebounceTimer);
      scrollDebounceTimer = setTimeout(onScrollSettle, THUMB_SCROLL_DEBOUNCE_MS);
    }
    renderVisibleSlice();
  }, { passive: true });

  if ('onscrollend' in window) {
    fileListUl.addEventListener('scrollend', () => {
      if (isScrolling) onScrollSettle();
    }, { passive: true });
  }

  window.addEventListener('resize', () => {
    renderVisibleSlice();
    commitPendingThumbnails();
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
    favoritesBtnEl.tabIndex = -1;
    favoritesBtnEl.addEventListener('click', toggleFavoriteCurrent);
  }

  const actionButtons = filePanel.querySelectorAll('.file-panel-actions .icon-btn');
  if (actionButtons.length) {
    makeListNavigable(actionButtons, { horizontal: true, vertical: false, loop: true });
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

  // Wire Library UI.
  libraryPanelEl = document.getElementById('file-panel-library');

  if (libraryPanelEl) {
    makeContainerNavigable(libraryPanelEl, '.library-provider-list:not(.collapsed) li', {
      vertical: true,
      horizontal: false,
      loop: false,
      onAction: (index, item, e) => {
        const path = item.dataset.path;
        if (path) {
          panelKeyboardActive = true;
          openLibraryEntry({ path, is_dir: true });
        }
      },
      onCancel: () => {
        panelKeyboardActive = false;
        highlightLibraryByPath('');
        if (document.activeElement && libraryPanelEl.contains(document.activeElement)) {
          document.activeElement.blur();
        }
      }
    });
  }

  renderLibrary();

  window.addEventListener('quivit-library-updated', () => {
    renderLibrary();
  });

  if (window.__TAURI__?.event?.listen) {
    window.__TAURI__.event.listen('library-changed', () => {
      renderLibrary().catch(err => {
        console.error('[FilePanel] Failed to refresh Library after a filesystem change:', err);
      });
      refreshFavoritesAfterFilesystemChange();
    }).catch(console.error);

    window.__TAURI__.event.listen('directory-changed', () => {
      refreshFavoritesAfterFilesystemChange();
    }).catch(console.error);
  }

  window.addEventListener('focus', refreshFavoritesAfterFilesystemChange);

  window.addEventListener('quivit-config-loaded', () => {
    favoritesExpanded = !getFavoritesCollapsed();
    renderFavorites();
    refreshFavoritesAfterFilesystemChange();
    // Re-measure rows so custom CSS font sizes apply.
    const oldHeight = ROW_HEIGHT;
    measureRowHeight();
    if (oldHeight !== ROW_HEIGHT) {
      initDomPool();
      lastRenderedList = null;
    }
    if (Core) renderFilePanel(Core.getState());
  });

  window.addEventListener('quivit-css-applied', () => {
    // Re-measure rows for live CSS previews.
    const oldHeight = ROW_HEIGHT;
    measureRowHeight();
    if (oldHeight !== ROW_HEIGHT) {
      initDomPool();
      lastRenderedList = null;
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

export function getFileListViewportRange() {
  if (!fileListUl) return { start: 0, end: 0 };
  if (!ROW_HEIGHT) measureRowHeight();
  const total = Core.getState().list?.length || 0;
  const scrollTop = fileListUl.scrollTop;
  const clientH = fileListUl.clientHeight || 600;
  const rowH = ROW_HEIGHT || 22;
  const rawStart = Math.floor(scrollTop / rowH);
  const visibleCount = Math.ceil(clientH / rowH);
  return {
    start: Math.max(0, rawStart - VIEWPORT_MARGIN),
    end: Math.min(total, rawStart + visibleCount + VIEWPORT_MARGIN)
  };
}
