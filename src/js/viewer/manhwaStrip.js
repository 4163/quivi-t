/**
 * manhwaStrip.js: index-driven loader for the manhwa vertical strip.
 *
 * Owns #manhwa-strip and the .manhwa-active class on #viewport.
 * The window is centered on an anchor index in the filtered image
 * list. Rendering N items around the anchor. External index changes
 * (panel click, keyboard) re-anchor and re-render. Wheel/key/hold
 * panning is wired in Slice 5.
 */

import { Core } from '../core.js';
import { FsUtils } from '../fsUtils.js';
import { thumbnailCache } from '../filepanel/filePanel.js';
import { computeStripWidth } from '../services/viewerMath.js';

/** Max img nodes kept in the free pool after eviction. */
const STRIP_POOL_CAP = 10;

/** Items rendered above and below the anchor (each direction). */
const STRIP_WINDOW_HALF = 5;

let _viewport = null;
let _strip = null;
let _active = false;

/** Filtered image entries: { listIndex, entry, imgIdx }[] */
let _imageIndex = [];

/** Reverse map: listIndex → imgIdx (position in _imageIndex). */
const _listToImgIdx = new Map();

/** Map from listIndex → DOM img node for currently mounted items. */
const _mounted = new Map();

/** Free pool of recycled img nodes. */
const _freePool = [];

let _anchorImgIdx = 0;
let _lastList = null;
let _lastMode = null;
let _lastArchivePath = null;
let _lastDirectory = null;
let _anchorUpdateInProgress = false;

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
  _listToImgIdx.clear();
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (FsUtils.isImageEntry(entry)) {
      const imgIdx = result.length;
      result.push({ listIndex: i, entry, imgIdx });
      _listToImgIdx.set(i, imgIdx);
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
  img.removeAttribute('data-list-index');
  if (_freePool.length < STRIP_POOL_CAP) {
    _freePool.push(img);
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

/**
 * Render items in the window [anchorImgIdx - HALF, anchorImgIdx + HALF].
 * Evict anything outside, mount anything missing.
 */
function _renderWindow() {
  if (!_strip || !_active || _imageIndex.length === 0) return;

  const lo = Math.max(0, _anchorImgIdx - STRIP_WINDOW_HALF);
  const hi = Math.min(_imageIndex.length - 1, _anchorImgIdx + STRIP_WINDOW_HALF);

  // Evict items outside the window.
  const windowListIndices = new Set();
  for (let i = lo; i <= hi; i++) {
    windowListIndices.add(_imageIndex[i].listIndex);
  }

  for (const [listIndex, img] of _mounted) {
    if (!windowListIndices.has(listIndex)) {
      _mounted.delete(listIndex);
      img.remove();
      _releaseNode(img);
    }
  }

  // Mount missing items in order.
  const state = Core.getState();
  for (let i = lo; i <= hi; i++) {
    const item = _imageIndex[i];
    if (_mounted.has(item.listIndex)) continue;

    const img = _acquireNode();
    img.dataset.listIndex = item.listIndex;
    const src = _buildSrc(item.entry, state);
    img.src = src;

    _insertAtPosition(img, item.listIndex);
    _mounted.set(item.listIndex, img);
  }

  // Sync Core selection to the anchor.
  const anchorItem = _imageIndex[_anchorImgIdx];
  if (anchorItem) {
    _anchorUpdateInProgress = true;
    Core.selectIndex(anchorItem.listIndex);
    _anchorUpdateInProgress = false;
  }
}

function _insertAtPosition(img, listIndex) {
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

/**
 * Set the anchor to a given image index and re-render the window.
 */
function _setAnchor(imgIdx) {
  if (imgIdx < 0 || imgIdx >= _imageIndex.length) return;
  _anchorImgIdx = imgIdx;
  _renderWindow();
}

/**
 * Navigate the anchor by delta images (positive = forward, negative = back).
 * Public API for Slice 5 (keyboard/wheel).
 */
export function stepAnchor(delta) {
  if (!_active || _imageIndex.length === 0) return;
  const next = Math.max(0, Math.min(_imageIndex.length - 1, _anchorImgIdx + delta));
  if (next !== _anchorImgIdx) _setAnchor(next);
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

  // Start at the current Core index if it maps to an image.
  const mapped = _listToImgIdx.get(state.index);
  _anchorImgIdx = mapped !== undefined ? mapped : 0;

  _applyStripWidth();
  _renderWindow();
}

function _deactivate() {
  if (!_active) return;
  _active = false;
  _viewport.classList.remove('manhwa-active');

  for (const [, img] of _mounted) {
    img.remove();
    _releaseNode(img);
  }
  _mounted.clear();
  _imageIndex = [];
  _listToImgIdx.clear();
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

  // List or container changed — rebuild.
  const listChanged = state.list !== _lastList;
  const containerChanged = state.mode !== _lastMode ||
    state.archivePath !== _lastArchivePath ||
    state.directory !== _lastDirectory;

  if (listChanged || containerChanged) {
    for (const [, img] of _mounted) {
      img.remove();
      _releaseNode(img);
    }
    _mounted.clear();

    _imageIndex = _buildImageIndex(state.list || []);
    _lastList = state.list;
    _lastMode = state.mode;
    _lastArchivePath = state.archivePath;
    _lastDirectory = state.directory;

    const mapped = _listToImgIdx.get(state.index);
    _anchorImgIdx = mapped !== undefined ? mapped : 0;

    _applyStripWidth();
    _renderWindow();
    return;
  }

  // External index change (panel click/keyboard) — re-anchor.
  if (!_anchorUpdateInProgress && state.index >= 0) {
    const mapped = _listToImgIdx.get(state.index);
    if (mapped !== undefined && mapped !== _anchorImgIdx) {
      _setAnchor(mapped);
    }
  }
}

export function initManhwaStrip() {
  _viewport = document.getElementById('viewport');
  _strip = document.getElementById('manhwa-strip');
  if (!_viewport || !_strip) return;

  Core.onStateChange(_onStateChange);

  const ro = new ResizeObserver(() => {
    if (!_active) return;
    _applyStripWidth();
  });
  ro.observe(_viewport);
}

export function isManhwaStripActive() {
  return _active;
}
