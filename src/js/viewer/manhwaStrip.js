/**
 * manhwaStrip.js: continuous column loader for the manhwa vertical strip.
 *
 * Owns #manhwa-strip and the .manhwa-active class on #viewport.
 * Appends every image entry top-down at 1:1 scale with transform-based
 * pan and zoom via viewportState. Slots reserve estimated heights before
 * decode and correct after without jumping the view. Loading windows off
 * the visible range plus a buffer.
 */

import { Core } from '../core.js';
import { FsUtils } from '../fsUtils.js';
import { thumbnailCache } from '../filepanel/filePanel.js';
import { computeColumnOffsets, findAnchorIndex, computeWindowRange } from '../services/viewerMath.js';

/** Max img nodes kept in the free pool after eviction. */
const STRIP_POOL_CAP = 10;

/** Buffer in pixels above and below the visible viewport. */
const STRIP_BUFFER_PX = 1500;

/** Initial estimated height for images before decode. */
const DEFAULT_ESTIMATED_HEIGHT = 1200;

/** Initial estimated width for images before decode. */
const DEFAULT_ESTIMATED_WIDTH = 800;

/** Fixed height for video entry placeholders. */
const VIDEO_PLACEHOLDER_HEIGHT = 400;

let _viewport = null;
let _strip = null;
let _viewportState = null;
let _active = false;
let _initialized = false;

/** Filtered image entries: { listIndex, entry, imgIdx, naturalWidth, naturalHeight, decoded, isVideo }[] */
let _imageIndex = [];

/** Reverse map: listIndex → imgIdx (position in _imageIndex). */
const _listToImgIdx = new Map();

/** Map from imgIdx → slot container element. */
const _slots = new Map();

/** Map from imgIdx → DOM img node for currently mounted items. */
const _mounted = new Map();

/** Free pool of recycled img nodes. */
const _freePool = [];

/** Current column layout: { widestWidth, columnWidth, totalHeight, offsets }. */
let _layout = { widestWidth: 0, columnWidth: 0, totalHeight: 0, offsets: [] };

let _anchorImgIdx = 0;
let _lastList = null;
let _lastMode = null;
let _lastArchivePath = null;
let _lastDirectory = null;
let _lastArchiveEncryption = null;
let _anchorUpdateInProgress = false;
let _settleTimer = null;

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
    if (FsUtils.isImageEntry(entry) || FsUtils.isVideoEntry(entry)) {
      const imgIdx = result.length;
      result.push({
        listIndex: i,
        entry,
        imgIdx,
        isVideo: FsUtils.isVideoEntry(entry),
        naturalWidth: 0,
        naturalHeight: 0,
        decoded: false,
      });
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
  img.removeAttribute('data-img-idx');
  if (_freePool.length < STRIP_POOL_CAP) {
    _freePool.push(img);
  }
}

function _buildSlots() {
  if (!_strip) return;
  _strip.replaceChildren();
  _slots.clear();

  for (let i = 0; i < _imageIndex.length; i++) {
    const item = _imageIndex[i];
    const slot = document.createElement('div');
    slot.className = 'manhwa-slot';
    slot.dataset.imgIdx = String(item.imgIdx);
    slot.dataset.listIndex = String(item.listIndex);

    const initialH = item.isVideo ? VIDEO_PLACEHOLDER_HEIGHT : (item.naturalHeight || DEFAULT_ESTIMATED_HEIGHT);
    item.naturalHeight = initialH;
    item.naturalWidth = item.naturalWidth || DEFAULT_ESTIMATED_WIDTH;
    slot.style.height = `${initialH}px`;

    if (item.isVideo) {
      const ph = document.createElement('div');
      ph.className = 'manhwa-video-placeholder';
      ph.textContent = `Video: ${item.entry.name || 'mp4'}`;
      slot.appendChild(ph);
    }

    _strip.appendChild(slot);
    _slots.set(item.imgIdx, slot);
  }
}

function _updateLayout(anchorImgIdxToHold = null, oldAnchorTop = 0) {
  _layout = computeColumnOffsets(_imageIndex, 1);
  if (_viewportState) {
    _viewportState.setDimensions(_layout.widestWidth, _layout.totalHeight);
    if (anchorImgIdxToHold !== null && _layout.offsets[anchorImgIdxToHold]) {
      const newAnchorTop = _layout.offsets[anchorImgIdxToHold].top;
      const deltaY = newAnchorTop - oldAnchorTop;
      if (deltaY !== 0) {
        const scale = _viewportState.getScale() || 1;
        _viewportState.panBy(0, -deltaY * scale);
      }
    }
    _strip.style.transform = _viewportState.getTransform();
  }
}

function _onItemDecoded(imgIdx, nw, nh) {
  const item = _imageIndex[imgIdx];
  if (!item || item.isVideo) return;
  const oldH = item.naturalHeight;
  const oldAnchorTop = _layout.offsets[_anchorImgIdx]?.top || 0;

  item.naturalWidth = nw;
  item.naturalHeight = nh;
  item.decoded = true;

  const slot = _slots.get(imgIdx);
  if (slot) slot.style.height = `${nh}px`;

  if (oldH !== nh || item.naturalWidth !== nw) {
    _updateLayout(_anchorImgIdx, oldAnchorTop);
    _updateWindow();
  }
}

function _updateWindow() {
  if (!_strip || !_active || _imageIndex.length === 0 || !_viewportState) return;

  const scale = _viewportState.getScale() || 1;
  const ty = _viewportState.getTy() || 0;
  const vpH = _viewport?.clientHeight || 800;

  const centerColY = (_layout.totalHeight / 2) - (ty / scale);
  const halfVpH = vpH / (2 * scale);
  const bufferH = STRIP_BUFFER_PX / scale;

  const windowTopY = centerColY - halfVpH - bufferH;
  const windowBottomY = centerColY + halfVpH + bufferH;

  const { startIndex, endIndex } = computeWindowRange(_layout.offsets, windowTopY, windowBottomY);

  if (startIndex === -1 || endIndex === -1) return;

  // Evict mounted images outside [startIndex, endIndex].
  for (const [imgIdx, img] of _mounted) {
    if (imgIdx < startIndex || imgIdx > endIndex) {
      _mounted.delete(imgIdx);
      img.onload = null;
      img.onerror = null;
      img.remove();
      _releaseNode(img);
    }
  }

  // Mount missing images inside [startIndex, endIndex].
  const state = Core.getState();
  for (let i = startIndex; i <= endIndex; i++) {
    const item = _imageIndex[i];
    if (item.isVideo || _mounted.has(i)) continue;

    const slot = _slots.get(i);
    if (!slot) continue;

    const img = _acquireNode();
    img.dataset.imgIdx = String(i);
    img.dataset.listIndex = String(item.listIndex);
    const src = _buildSrc(item.entry, state);
    img.src = src;

    img.onload = () => {
      _onItemDecoded(i, img.naturalWidth, img.naturalHeight);
    };
    img.onerror = () => {
      slot.classList.add('error');
      if (!slot.querySelector('.manhwa-error-placeholder')) {
        const errDiv = document.createElement('div');
        errDiv.className = 'manhwa-error-placeholder';
        errDiv.textContent = `Failed to load: ${item.entry?.name || 'image'}`;
        slot.appendChild(errDiv);
      }
      _onItemDecoded(i, item.naturalWidth || DEFAULT_ESTIMATED_WIDTH, item.naturalHeight || DEFAULT_ESTIMATED_HEIGHT);
    };

    slot.appendChild(img);
    _mounted.set(i, img);
  }

  // Find center anchor.
  const newAnchor = findAnchorIndex(_layout.offsets, centerColY);
  if (newAnchor !== -1 && newAnchor !== _anchorImgIdx) {
    _anchorImgIdx = newAnchor;
    _scheduleSettleAnchor();
  }
}

function _scheduleSettleAnchor() {
  if (_settleTimer) clearTimeout(_settleTimer);
  _settleTimer = setTimeout(() => {
    _settleTimer = null;
    _syncAnchorToCore();
  }, 100);
}

function _syncAnchorToCore() {
  const anchorItem = _imageIndex[_anchorImgIdx];
  if (!anchorItem) return;
  _anchorUpdateInProgress = true;
  Core.selectIndex(anchorItem.listIndex);
  _anchorUpdateInProgress = false;
  window.dispatchEvent(new CustomEvent('quivit-manhwa-settle'));
}

export function getVisibleImageIndices() {
  if (!_active || !_viewportState || _imageIndex.length === 0) return [];
  const scale = _viewportState.getScale() || 1;
  const ty = _viewportState.getTy() || 0;
  const vpH = _viewport?.clientHeight || 800;
  const centerColY = (_layout.totalHeight / 2) - (ty / scale);
  const halfVpH = vpH / (2 * scale);
  const visibleTopY = centerColY - halfVpH;
  const visibleBottomY = centerColY + halfVpH;

  const { startIndex, endIndex } = computeWindowRange(_layout.offsets, visibleTopY, visibleBottomY);
  if (startIndex === -1) return [];

  const listIndices = [];
  for (let i = startIndex; i <= endIndex; i++) {
    listIndices.push(_imageIndex[i].listIndex);
  }
  return listIndices;
}

export const STRIP_PAGE_DELTA = 5;

export function stepAnchor(delta) {
  if (!_active || _imageIndex.length === 0) return;
  let next;
  if (delta === -Infinity) {
    next = 0;
  } else if (delta === Infinity) {
    next = _imageIndex.length - 1;
  } else {
    next = Math.max(0, Math.min(_imageIndex.length - 1, _anchorImgIdx + delta));
  }
  if (next !== _anchorImgIdx) {
    _anchorImgIdx = next;
    if (_viewportState && _layout.offsets[next]) {
      const anchorCenter = _layout.offsets[next].top + _layout.offsets[next].height / 2;
      const targetTy = (_layout.totalHeight / 2) - anchorCenter;
      _viewportState.panTo(0, targetTy);
      _strip.style.transform = _viewportState.getTransform();
      _updateWindow();
      _syncAnchorToCore();
    }
  }
}

export function centerListItem(listIndex) {
  if (!_active || !_viewportState) return false;
  const mapped = _listToImgIdx.get(listIndex);
  if (mapped === undefined || !_layout.offsets[mapped]) return false;
  _anchorImgIdx = mapped;
  const anchorCenter = _layout.offsets[mapped].top + _layout.offsets[mapped].height / 2;
  const targetTy = (_layout.totalHeight / 2) - anchorCenter;
  _viewportState.panTo(0, targetTy);
  _strip.style.transform = _viewportState.getTransform();
  _updateWindow();
  _syncAnchorToCore();
  return true;
}

function _activate(state) {
  if (_active) return;
  _active = true;
  _viewport.classList.add('manhwa-active');

  const isLocked = state.archiveEncryption === 'password_required' || state.archiveEncryption === 'password_incorrect';
  _imageIndex = isLocked ? [] : _buildImageIndex(state.list || []);
  _lastList = state.list;
  _lastMode = state.mode;
  _lastArchivePath = state.archivePath;
  _lastDirectory = state.directory;
  _lastArchiveEncryption = state.archiveEncryption;

  if (_strip) {
    _strip.dataset.scaling = state.scalingMode || 'bilinear';
  }

  _buildSlots();
  _updateLayout();

  const mapped = _listToImgIdx.get(state.index);
  _anchorImgIdx = mapped !== undefined ? mapped : 0;

  if (_viewportState) {
    _viewportState.applyFitMode('none', _layout.widestWidth, _layout.totalHeight);
    if (_layout.offsets[_anchorImgIdx]) {
      const anchorCenter = _layout.offsets[_anchorImgIdx].top + _layout.offsets[_anchorImgIdx].height / 2;
      const targetTy = (_layout.totalHeight / 2) - anchorCenter;
      _viewportState.panTo(0, targetTy);
    }
    _strip.style.transform = _viewportState.getTransform();
    _strip.style.setProperty('--zoom-scale', _viewportState.getScale() || 1);
  }

  _updateWindow();
  if (_imageIndex.length > 0) {
    _syncAnchorToCore();
  }
}

function _deactivate() {
  if (!_active) return;
  _active = false;
  _viewport.classList.remove('manhwa-active');

  if (_settleTimer) {
    clearTimeout(_settleTimer);
    _settleTimer = null;
  }

  for (const [, img] of _mounted) {
    img.onload = null;
    img.onerror = null;
    img.remove();
    _releaseNode(img);
  }
  _mounted.clear();
  _slots.clear();
  if (_strip) _strip.replaceChildren();

  _imageIndex = [];
  _listToImgIdx.clear();
  _layout = { widestWidth: 0, columnWidth: 0, totalHeight: 0, offsets: [] };
  _lastList = null;
  _lastArchiveEncryption = null;
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

  if (_strip && state.scalingMode) {
    _strip.dataset.scaling = state.scalingMode;
  }

  const isLocked = state.archiveEncryption === 'password_required' || state.archiveEncryption === 'password_incorrect';
  const encryptionChanged = state.archiveEncryption !== _lastArchiveEncryption;
  const listChanged = state.list !== _lastList;
  const containerChanged = state.mode !== _lastMode ||
    state.archivePath !== _lastArchivePath ||
    state.directory !== _lastDirectory ||
    encryptionChanged;

  if (listChanged || containerChanged) {
    for (const [, img] of _mounted) {
      img.onload = null;
      img.onerror = null;
      img.remove();
      _releaseNode(img);
    }
    _mounted.clear();
    _slots.clear();
    if (_strip) _strip.replaceChildren();

    _imageIndex = isLocked ? [] : _buildImageIndex(state.list || []);
    _lastList = state.list;
    _lastMode = state.mode;
    _lastArchivePath = state.archivePath;
    _lastDirectory = state.directory;
    _lastArchiveEncryption = state.archiveEncryption;

    _buildSlots();
    _updateLayout();

    const mapped = _listToImgIdx.get(state.index);
    _anchorImgIdx = mapped !== undefined ? mapped : 0;

    if (_viewportState) {
      _viewportState.applyFitMode('none', _layout.widestWidth, _layout.totalHeight);
      if (_layout.offsets[_anchorImgIdx]) {
        const anchorCenter = _layout.offsets[_anchorImgIdx].top + _layout.offsets[_anchorImgIdx].height / 2;
        const targetTy = (_layout.totalHeight / 2) - anchorCenter;
        _viewportState.panTo(0, targetTy);
      }
      _strip.style.transform = _viewportState.getTransform();
      _strip.style.setProperty('--zoom-scale', _viewportState.getScale() || 1);
    }

    _updateWindow();
    if (_imageIndex.length > 0) {
      _syncAnchorToCore();
    }
    return;
  }

  // External index change (panel click/keyboard) — re-anchor.
  if (!_anchorUpdateInProgress && state.index >= 0) {
    const mapped = _listToImgIdx.get(state.index);
    if (mapped !== undefined && mapped !== _anchorImgIdx) {
      _anchorImgIdx = mapped;
      if (_viewportState && _layout.offsets[mapped]) {
        const anchorCenter = _layout.offsets[mapped].top + _layout.offsets[mapped].height / 2;
        const targetTy = (_layout.totalHeight / 2) - anchorCenter;
        _viewportState.panTo(0, targetTy);
        _strip.style.transform = _viewportState.getTransform();
        _updateWindow();
      }
    }
  }
}

export function setViewportState(vpState) {
  if (!vpState || _viewportState === vpState) return;
  _viewportState = vpState;
  _viewportState.subscribe(() => {
    if (!_active || !_strip) return;
    _strip.style.transform = _viewportState.getTransform();
    _strip.style.setProperty('--zoom-scale', _viewportState.getScale() || 1);
    _updateWindow();
  });
}

export function initManhwaStrip(viewportState) {
  if (viewportState) setViewportState(viewportState);
  _viewport = document.getElementById('viewport');
  _strip = document.getElementById('manhwa-strip');
  if (!_viewport || !_strip) return;

  if (_initialized) return;
  _initialized = true;

  Core.onStateChange(_onStateChange);

  const ro = new ResizeObserver(() => {
    if (!_active || !_viewportState) return;
    _strip.style.transform = _viewportState.getTransform();
    _updateWindow();
  });
  ro.observe(_viewport);
}

export function isManhwaStripActive() {
  return _active;
}
