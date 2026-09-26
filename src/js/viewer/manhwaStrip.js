/**
 * manhwaStrip.js: windowed loader for the manhwa vertical strip.
 *
 * Owns #manhwa-strip and the .manhwa-active class on #viewport.
 * Subscribes to Core.onStateChange. When manhwaEnabled flips on,
 * it builds a filtered image index from Core.list, populates a
 * bounded node pool, and loads a viewport-sized window of images.
 * Scroll events extend and evict images outside the window.
 */

import { Core } from '../core.js';
import { FsUtils } from '../fsUtils.js';
import { thumbnailCache } from '../filepanel/filePanel.js';
import { computeStripWidth } from '../services/viewerMath.js';

/** Max img nodes kept in the free pool after eviction. */
const STRIP_POOL_CAP = 10;

/** Buffer above and below the viewport, in multiples of viewport height. */
const STRIP_BUFFER_VIEWPORTS = 1;

/** Debounce for scroll-settle before loading new items (ms). */
const STRIP_SCROLL_SETTLE_MS = 60;

/** Default estimated height for images with unknown dimensions (px). */
const STRIP_DEFAULT_ITEM_HEIGHT = 800;

let _viewport = null;
let _strip = null;
let _active = false;

/** Filtered image entries: { listIndex, entry }[] */
let _imageIndex = [];

/** Map from listIndex → DOM img node for currently mounted items. */
const _mounted = new Map();

/** Free pool of recycled img nodes. */
const _freePool = [];

/** Cached natural dimensions: listIndex → { w, h } */
const _dimCache = new Map();

let _scrollRafId = 0;
let _scrollSettleTimer = 0;
let _lastList = null;
let _lastMode = null;
let _lastArchivePath = null;
let _lastDirectory = null;

function _buildSrc(entry, state) {
  if (state.mode === 'archive') {
    const archiveSrc = FsUtils.buildArchiveSrc(state.archivePath, entry.name);
    const cached = thumbnailCache.get(archiveSrc);
    if (typeof cached === 'string' && cached.startsWith('blob:')) return cached;
    return archiveSrc;
  }
  return FsUtils.buildFileSrcSync(entry.path);
}

function _buildImageIndex(list) {
  const result = [];
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (FsUtils.isImageEntry(entry)) {
      result.push({ listIndex: i, entry });
    }
  }
  return result;
}

function _acquireNode() {
  if (_freePool.length > 0) return _freePool.pop();
  const img = document.createElement('img');
  img.decoding = 'async';
  img.draggable = false;
  img.alt = '';
  return img;
}

function _releaseNode(img) {
  img.removeAttribute('src');
  img.removeAttribute('style');
  img.removeAttribute('data-list-index');
  if (_freePool.length < STRIP_POOL_CAP) {
    _freePool.push(img);
  }
}

function _evictOutsideWindow(topEdge, bottomEdge) {
  for (const [listIndex, img] of _mounted) {
    const rect = img.getBoundingClientRect();
    const stripRect = _strip.getBoundingClientRect();
    const relTop = rect.top - stripRect.top + _strip.scrollTop;
    const relBottom = relTop + rect.height;

    if (relBottom < topEdge || relTop > bottomEdge) {
      _mounted.delete(listIndex);
      img.remove();
      _releaseNode(img);
    }
  }
}

function _getStripWidth() {
  if (!_viewport) return null;
  const state = Core.getState();
  const fitMode = state.fitMode || state.config?.frontend_data?.fit_mode || 'width';
  return computeStripWidth(fitMode, _viewport.clientWidth);
}

function _applyStripWidth() {
  const w = _getStripWidth();
  if (w != null) {
    _strip.style.setProperty('--manhwa-strip-width', `${w}px`);
  } else {
    _strip.style.removeProperty('--manhwa-strip-width');
  }
}

function _estimateHeight(item) {
  const cached = _dimCache.get(item.listIndex);
  if (cached) {
    const w = _getStripWidth() || _viewport.clientWidth;
    return (cached.h / cached.w) * w;
  }
  return STRIP_DEFAULT_ITEM_HEIGHT;
}

function _loadWindow() {
  if (!_strip || !_active || _imageIndex.length === 0) return;

  const vh = _viewport.clientHeight;
  const scrollTop = _strip.scrollTop;
  const bufferPx = vh * STRIP_BUFFER_VIEWPORTS;
  const topEdge = Math.max(0, scrollTop - bufferPx);
  const bottomEdge = scrollTop + vh + bufferPx;

  _evictOutsideWindow(topEdge, bottomEdge);

  // Walk through the image index and mount items inside the window.
  let cumY = 0;
  const state = Core.getState();
  for (const item of _imageIndex) {
    const estH = _estimateHeight(item);
    const itemTop = cumY;
    const itemBottom = cumY + estH;
    cumY += estH;

    if (itemBottom < topEdge) continue;
    if (itemTop > bottomEdge) break;

    if (!_mounted.has(item.listIndex)) {
      const img = _acquireNode();
      img.dataset.listIndex = item.listIndex;
      const src = _buildSrc(item.entry, state);
      img.src = src;

      // Cache dims on decode.
      img.onload = () => {
        if (img.naturalWidth > 0 && img.naturalHeight > 0) {
          _dimCache.set(item.listIndex, { w: img.naturalWidth, h: img.naturalHeight });
        }
        img.onload = null;
      };

      // Insert in correct order.
      _insertAtPosition(img, item.listIndex);
      _mounted.set(item.listIndex, img);
    }
  }
}

function _insertAtPosition(img, listIndex) {
  // Find the right position to maintain sorted order.
  const children = _strip.children;
  for (let i = 0; i < children.length; i++) {
    const childIdx = parseInt(children[i].dataset.listIndex, 10);
    if (childIdx > listIndex) {
      _strip.insertBefore(img, children[i]);
      return;
    }
  }
  _strip.appendChild(img);
}

function _onScroll() {
  if (_scrollRafId) return;
  _scrollRafId = requestAnimationFrame(() => {
    _scrollRafId = 0;
    clearTimeout(_scrollSettleTimer);
    _scrollSettleTimer = setTimeout(_loadWindow, STRIP_SCROLL_SETTLE_MS);
  });
}

function _activate(state) {
  if (_active) return;
  _active = true;
  _viewport.classList.add('manhwa-active');

  _imageIndex = _buildImageIndex(state.list || []);
  _lastList = state.list;
  _lastMode = state.mode;
  _lastArchivePath = state.archivePath;
  _lastDirectory = state.directory;

  _applyStripWidth();
  _strip.scrollTop = 0;
  _loadWindow();
  _strip.addEventListener('scroll', _onScroll, { passive: true });
}

function _deactivate() {
  if (!_active) return;
  _active = false;
  _viewport.classList.remove('manhwa-active');
  _strip.removeEventListener('scroll', _onScroll);
  clearTimeout(_scrollSettleTimer);
  if (_scrollRafId) { cancelAnimationFrame(_scrollRafId); _scrollRafId = 0; }

  // Remove all mounted nodes.
  for (const [, img] of _mounted) {
    img.onload = null;
    img.remove();
    _releaseNode(img);
  }
  _mounted.clear();
  _imageIndex = [];
  _lastList = null;
}

function _onStateChange(state) {
  const manhwaOn = !!(state.manhwaEnabled ?? state.config?.frontend_data?.manhwa_enabled);

  if (manhwaOn && !_active) {
    _activate(state);
    return;
  }

  if (!manhwaOn && _active) {
    _deactivate();
    return;
  }

  if (!_active) return;

  // List or container changed while active — rebuild.
  const listChanged = state.list !== _lastList;
  const containerChanged = state.mode !== _lastMode ||
    state.archivePath !== _lastArchivePath ||
    state.directory !== _lastDirectory;

  if (listChanged || containerChanged) {
    // Tear down and rebuild.
    for (const [, img] of _mounted) {
      img.onload = null;
      img.remove();
      _releaseNode(img);
    }
    _mounted.clear();
    _dimCache.clear();

    _imageIndex = _buildImageIndex(state.list || []);
    _lastList = state.list;
    _lastMode = state.mode;
    _lastArchivePath = state.archivePath;
    _lastDirectory = state.directory;

    _strip.scrollTop = 0;
    _applyStripWidth();
    _loadWindow();
  }
}

export function initManhwaStrip() {
  _viewport = document.getElementById('viewport');
  _strip = document.getElementById('manhwa-strip');
  if (!_viewport || !_strip) return;

  Core.onStateChange(_onStateChange);

  // Recompute strip width on viewport resize.
  const ro = new ResizeObserver(() => {
    if (!_active) return;
    _applyStripWidth();
  });
  ro.observe(_viewport);
}
