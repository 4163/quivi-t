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
import { computeColumnOffsets, findAnchorIndex, computeWindowRange, seamOverlapForScale } from '../services/viewerMath.js';
import { Statusbar } from '../menubar/statusbar.js';

/** Max img nodes kept in the free pool after eviction. */
const STRIP_POOL_CAP = 10;

/** Buffer in multiples of viewport height above and below the visible viewport. */
const STRIP_BUFFER_VIEWPORTS = 2;

/** Additional viewport height multiple to mount ahead in the pan direction. */
const STRIP_AHEAD_BUFFER_VIEWPORTS = 1;

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
let _lastTy = null;
let _lastScale = null;

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

/** Zoom scale the column offsets were last built with. */
let _layoutScale = null;

function _updateLayout(anchorImgIdxToHold = null, oldAnchorTop = 0) {
  const scale = _viewportState?.getScale() || 1;
  _layoutScale = scale;
  const vpH = _viewport?.clientHeight || 800;
  const oldTy = _viewportState?.getTy() || 0;
  const oldMaxTy = ((_layout.totalHeight || 0) * scale - vpH) / 2;
  const wasAtTop = oldTy >= oldMaxTy - 0.5;
  const wasAtBottom = oldTy <= -oldMaxTy + 0.5;

  _layout = computeColumnOffsets(_imageIndex, 1, seamOverlapForScale(scale));
  if (_viewportState) {
    _viewportState.setDimensions(_layout.widestWidth, _layout.totalHeight);
    const colH = (_layout.totalHeight || 0) * scale;
    if (anchorImgIdxToHold !== null && _layout.offsets[anchorImgIdxToHold]) {
      if (wasAtTop && !wasAtBottom) {
        // View was end-pinned: re-pin the end instead of holding the anchor.
        _viewportState.panTo(_viewportState.getTx(), (colH - vpH) / 2);
      } else if (wasAtBottom && !wasAtTop) {
        _viewportState.panTo(_viewportState.getTx(), -(colH - vpH) / 2);
      } else {
        const newAnchorTop = _layout.offsets[anchorImgIdxToHold].top;
        const deltaY = newAnchorTop - oldAnchorTop;
        if (deltaY !== 0) {
          _viewportState.panBy(0, -deltaY * scale);
        }
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
    _scheduleSettle();
  }
}

function _computeVisibleRange() {
  if (!_viewportState || _imageIndex.length === 0 || !_layout.offsets || !_layout.offsets.length) {
    return { startIndex: -1, endIndex: -1, centerColY: 0 };
  }
  const scale = _viewportState.getScale() || 1;
  const ty = _viewportState.getTy() || 0;
  const vpH = _viewport?.clientHeight || 800;
  const centerColY = (_layout.totalHeight / 2) - (ty / scale);
  const halfVpH = vpH / (2 * scale);
  const visibleTopY = centerColY - halfVpH;
  const visibleBottomY = centerColY + halfVpH;

  const { startIndex, endIndex } = computeWindowRange(_layout.offsets, visibleTopY, visibleBottomY);
  return { startIndex, endIndex, centerColY };
}

function _updateWindow() {
  if (!_strip || !_active || _imageIndex.length === 0 || !_viewportState) return;

  const scale = _viewportState.getScale() || 1;
  const ty = _viewportState.getTy() || 0;
  const vpH = _viewport?.clientHeight || 800;

  const deltaTy = _lastTy !== null ? ty - _lastTy : 0;
  _lastTy = ty;

  const isPanningDown = deltaTy < 0;
  const isPanningUp = deltaTy > 0;

  // Zooming in reframes the window: warm both sides regardless of direction.
  const zoomedIn = _lastScale !== null && scale > _lastScale + 1e-9;
  _lastScale = scale;
  const prefetchDir = zoomedIn ? 0 : isPanningDown ? 1 : isPanningUp ? -1 : 0;

  const baseBufferH = (vpH * STRIP_BUFFER_VIEWPORTS) / scale;
  const aheadBufferH = (vpH * STRIP_AHEAD_BUFFER_VIEWPORTS) / scale;
  const topBufferH = baseBufferH + (isPanningUp ? aheadBufferH : 0);
  const bottomBufferH = baseBufferH + (isPanningDown ? aheadBufferH : 0);

  const centerColY = (_layout.totalHeight / 2) - (ty / scale);
  const halfVpH = vpH / (2 * scale);

  const windowTopY = centerColY - halfVpH - topBufferH;
  const windowBottomY = centerColY + halfVpH + bottomBufferH;

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

  // Warm fetch plus decode for items just beyond the window so pixels arrive
  // before the viewport does. Off-DOM preloads, no nodes consumed.
  _prefetchAhead(startIndex, endIndex, prefetchDir, state);

  // Anchor follows view movement, not layout drift. Recompute only when the
  // view (ty, scale, viewport height) moved; decode corrections alone keep it.
  // An explicit center request holds through decodes until zoom reframes.
  const anchorViewChanged = _lastAnchorTy === null || _lastAnchorScale === null || _lastAnchorVph === null ||
    ty !== _lastAnchorTy || scale !== _lastAnchorScale || vpH !== _lastAnchorVph;
  let newAnchor = -1;
  if (_anchorHoldover !== null && scale === _anchorHoldoverScale && _layout.offsets[_anchorHoldover]) {
    newAnchor = _anchorHoldover;
  } else {
    if (_anchorHoldover !== null) _anchorHoldover = null;
    if (anchorViewChanged) {
      const { startIndex: visStart, endIndex: visEnd } = _computeVisibleRange();
      if (visStart !== -1 && visEnd !== -1) {
        if (visStart === visEnd) {
          newAnchor = visStart;
        } else {
          const candidate = findAnchorIndex(_layout.offsets, centerColY);
          newAnchor = Math.max(visStart, Math.min(visEnd, candidate));
        }
      }
    } else {
      newAnchor = _anchorImgIdx;
    }
  }
  _anchorHoldover = null;
  _lastAnchorTy = ty;
  _lastAnchorScale = scale;
  _lastAnchorVph = vpH;
  if (newAnchor !== -1 && newAnchor !== _anchorImgIdx) {
    _anchorImgIdx = newAnchor;
    _scheduleSettle();
  }
}

/** Items preloaded beyond the mount window, in pan direction. */
const PREFETCH_AHEAD_COUNT = 4;
const PREFETCH_CONCURRENT_MAX = 3;
/** imgIdx → off-DOM Image currently decoding ahead of the window. */
const _prefetching = new Map();

function _prefetchAhead(startIndex, endIndex, direction, state) {
  const targets = [];
  if (direction >= 0) {
    for (let i = endIndex + 1; i <= endIndex + PREFETCH_AHEAD_COUNT && i < _imageIndex.length; i++) {
      targets.push(i);
    }
  }
  if (direction <= 0) {
    for (let i = startIndex - 1; i >= startIndex - PREFETCH_AHEAD_COUNT && i >= 0; i--) {
      targets.push(i);
    }
  }
  for (const i of targets) {
    if (_prefetching.size >= PREFETCH_CONCURRENT_MAX) break;
    const item = _imageIndex[i];
    if (!item || item.isVideo || item.decoded || _mounted.has(i) || _prefetching.has(i)) continue;
    const pre = new Image();
    pre.decoding = 'async';
    _prefetching.set(i, pre);
    pre.onload = () => {
      _prefetching.delete(i);
      if (!_active) return;
      const cur = _imageIndex[i];
      if (!cur || cur.decoded || cur.isVideo) return;
      // Record real dims before mount so slots, pins, and anchors use them.
      _onItemDecoded(i, pre.naturalWidth, pre.naturalHeight);
    };
    pre.onerror = () => {
      _prefetching.delete(i);
    };
    pre.src = _buildSrc(item.entry, state);
  }
}

function _scheduleSettle() {
  if (_settleTimer) clearTimeout(_settleTimer);
  _settleTimer = setTimeout(() => {
    _settleTimer = null;
    _syncAnchorToCore();
  }, 100);
}

/** Last selection and visible range pushed out; settle stays quiet otherwise. */
let _lastSyncedListIndex = null;
let _lastVisSig = null;

function _syncAnchorToCore() {
  const anchorItem = _imageIndex[_anchorImgIdx];
  if (!anchorItem) return;
  const scale = _viewportState?.getScale() || 0;
  const w = anchorItem.naturalWidth || 0;
  const h = anchorItem.naturalHeight || 0;
  // Scale 1 reads 100%. Updates even when selection is unchanged (zoom).
  Statusbar.setImage({
    filename: anchorItem.entry?.name || '',
    dims: anchorItem.decoded && w > 0 && h > 0 ? `${w} × ${h}` : undefined,
    zoom: scale || undefined,
  });
  const { startIndex, endIndex } = _computeVisibleRange();
  const visSig = startIndex === -1 ? '' : `${startIndex}-${endIndex}`;
  const anchorChanged = anchorItem.listIndex !== _lastSyncedListIndex;
  const visChanged = visSig !== _lastVisSig;
  _lastSyncedListIndex = anchorItem.listIndex;
  _lastVisSig = visSig;
  if (!anchorChanged && !visChanged) return;
  if (anchorChanged) {
    _anchorUpdateInProgress = true;
    Core.selectIndex(anchorItem.listIndex);
    _anchorUpdateInProgress = false;
  }
  window.dispatchEvent(new CustomEvent('quivit-manhwa-settle'));
}

export function getVisibleImageIndices() {
  if (!_active) return [];
  const { startIndex, endIndex } = _computeVisibleRange();
  if (startIndex === -1 || endIndex === -1) return [];

  const listIndices = [];
  for (let i = startIndex; i <= endIndex; i++) {
    listIndices.push(_imageIndex[i].listIndex);
  }
  return listIndices;
}

/** One-shot anchor request from explicit navigation, honored over re-derivation. */
let _anchorHoldover = null;
let _anchorHoldoverScale = 1;
/** View params the anchor was last derived from; layout-only changes keep it. */
let _lastAnchorTy = null;
let _lastAnchorScale = null;
let _lastAnchorVph = null;

export function centerListItem(listIndex) {
  if (!_active || !_viewportState) return false;
  const mapped = _listToImgIdx.get(listIndex);
  if (mapped === undefined || !_layout.offsets[mapped]) return false;
  _anchorImgIdx = mapped;
  const scale = _viewportState.getScale() || 1;
  _anchorHoldover = mapped;
  _anchorHoldoverScale = scale;
  const vpH = _viewport?.clientHeight || 800;
  const colH = (_layout.totalHeight || 0) * scale;
  if (mapped === 0) {
    // First image pins to the top, never centers.
    _viewportState.panTo(_viewportState.getTx(), (colH - vpH) / 2);
  } else if (mapped === _imageIndex.length - 1) {
    // Last image pins to the bottom, never centers.
    _viewportState.panTo(_viewportState.getTx(), -(colH - vpH) / 2);
  } else {
    _centerColumnY(_layout.offsets[mapped].top + _layout.offsets[mapped].height / 2);
  }
  _strip.style.transform = _viewportState.getTransform();
  _updateWindow();
  _scheduleSettle();
  return true;
}

export function getFirstImageIndex() {
  return _imageIndex[0]?.listIndex ?? -1;
}

export function getLastImageIndex() {
  return _imageIndex[_imageIndex.length - 1]?.listIndex ?? -1;
}

export function navigateManhwa(delta) {
  if (!_active || _imageIndex.length === 0) return false;
  Core.navigate(delta);
  const state = Core.getState();
  const mapped = _listToImgIdx.get(state.index);
  if (mapped !== undefined) {
    return centerListItem(state.index);
  }
  // Landed on a non-image entry: center the nearest image in travel direction.
  const dir = delta >= 0 ? 1 : -1;
  let candidate = -1;
  for (let i = 0; i < _imageIndex.length; i++) {
    const li = _imageIndex[i].listIndex;
    if (dir > 0 && li > state.index) { candidate = li; break; }
    if (dir < 0 && li < state.index) { candidate = li; }
  }
  if (candidate === -1) return false;
  Core.selectIndex(candidate);
  return centerListItem(candidate);
}

export function pageStrip(direction) {
  if (!_active || !_viewportState || !_layout.offsets.length) return false;
  const scale = _viewportState.getScale() || 1;
  const vpH = _viewport?.clientHeight || 800;
  const colVisualH = (_layout.totalHeight || 0) * scale;
  if (colVisualH <= vpH) return false;

  const ty = _viewportState.getTy() || 0;
  const maxTy = (colVisualH - vpH) / 2;
  const minTy = -(colVisualH - vpH) / 2;

  const targetTy = direction > 0 ? Math.max(minTy, ty - vpH) : Math.min(maxTy, ty + vpH);
  _viewportState.panTo(_viewportState.getTx(), targetTy);
  _strip.style.transform = _viewportState.getTransform();
  _updateWindow();
  _scheduleSettle();
  return true;
}

/**
 * Pan so column position colY (unzoomed) lands at the viewport center.
 * ty is screen px, so the offset scales with zoom. Preserves horizontal pan.
 */
function _centerColumnY(colY) {
  if (!_viewportState || !_layout.offsets.length) return;
  const scale = _viewportState.getScale() || 1;
  const targetTy = (_layout.totalHeight / 2 - colY) * scale;
  _viewportState.panTo(_viewportState.getTx(), targetTy);
  _strip.style.transform = _viewportState.getTransform();
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
  _lastTy = null;
  _lastScale = null;
  _anchorHoldover = null;
  _lastAnchorTy = null;
  _lastAnchorScale = null;
  _lastAnchorVph = null;
  _lastSyncedListIndex = null;
  _lastVisSig = null;
  _layoutScale = null;

  if (_strip) {
    _strip.dataset.scaling = state.scalingMode || 'bilinear';
  }

  _buildSlots();
  _updateLayout();

  const mapped = _listToImgIdx.get(state.index);
  _anchorImgIdx = mapped !== undefined ? mapped : 0;

  if (_viewportState) {
    _viewportState.applyFitMode('none', _layout.widestWidth, _layout.totalHeight);
    const vpH = _viewport?.clientHeight || 800;
    const scale = _viewportState.getScale() || 1;
    const colH = (_layout.totalHeight || 0) * scale;
    if (colH <= vpH) {
      // Short column rests top-pinned; the symmetric clamp still allows panning.
      _viewportState.panTo(_viewportState.getTx(), (colH - vpH) / 2);
    } else if (_layout.offsets[_anchorImgIdx]) {
      const anchorCenter = _layout.offsets[_anchorImgIdx].top + _layout.offsets[_anchorImgIdx].height / 2;
      _centerColumnY(anchorCenter);
    }
    _strip.style.transform = _viewportState.getTransform();
    _strip.style.setProperty('--zoom-scale', _viewportState.getScale() || 1);
  }

  _updateWindow();
  if (_imageIndex.length > 0) {
    _scheduleSettle();
  }
}

function _deactivate() {
  if (!_active) return;
  _active = false;
  _viewport.classList.remove('manhwa-active');

  _lastTy = null;
  _lastScale = null;
  _anchorHoldover = null;
  _lastAnchorTy = null;
  _lastAnchorScale = null;
  _lastAnchorVph = null;
  _lastSyncedListIndex = null;
  _lastVisSig = null;
  _layoutScale = null;

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
  _prefetching.clear();
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
    _prefetching.clear();
    if (_strip) _strip.replaceChildren();

    _imageIndex = isLocked ? [] : _buildImageIndex(state.list || []);
    _lastList = state.list;
    _lastMode = state.mode;
    _lastArchivePath = state.archivePath;
    _lastDirectory = state.directory;
    _lastArchiveEncryption = state.archiveEncryption;
    _lastTy = null;
    _lastScale = null;
    _anchorHoldover = null;
    _lastAnchorTy = null;
    _lastAnchorScale = null;
    _lastAnchorVph = null;
    _lastSyncedListIndex = null;
    _lastVisSig = null;
    _layoutScale = null;

    _buildSlots();
    _updateLayout();

    const mapped = _listToImgIdx.get(state.index);
    _anchorImgIdx = mapped !== undefined ? mapped : 0;

    if (_viewportState) {
      _viewportState.applyFitMode('none', _layout.widestWidth, _layout.totalHeight);
      const vpH = _viewport?.clientHeight || 800;
      const colH = (_layout.totalHeight || 0) * (_viewportState.getScale() || 1);
      if (colH <= vpH) {
        // Short column rests top-pinned; the symmetric clamp still allows panning.
        _viewportState.panTo(_viewportState.getTx(), (colH - vpH) / 2);
      } else if (_layout.offsets[_anchorImgIdx]) {
        _centerColumnY(_layout.offsets[_anchorImgIdx].top + _layout.offsets[_anchorImgIdx].height / 2);
      }
      _strip.style.transform = _viewportState.getTransform();
      _strip.style.setProperty('--zoom-scale', _viewportState.getScale() || 1);
    }

    _updateWindow();
    if (_imageIndex.length > 0) {
      _scheduleSettle();
    }
    return;
  }

  // External index change (panel click/keyboard) — center it like any request.
  if (!_anchorUpdateInProgress && state.index >= 0) {
    const mapped = _listToImgIdx.get(state.index);
    if (mapped !== undefined && mapped !== _anchorImgIdx) {
      centerListItem(state.index);
    }
  }
}

export function setViewportState(vpState) {
  if (!vpState || _viewportState === vpState) return;
  _viewportState = vpState;
  _viewportState.subscribe(() => {
    if (!_active || !_strip) return;
    const scale = _viewportState.getScale() || 1;
    if (_layoutScale === null || _layoutScale !== scale) {
      // Seam overlap depends on zoom: rebuild offsets before positioning.
      _updateLayout(_anchorImgIdx, _layout.offsets[_anchorImgIdx]?.top || 0);
    }
    _strip.style.transform = _viewportState.getTransform();
    _strip.style.setProperty('--zoom-scale', scale);
    _updateWindow();
    _scheduleSettle();
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
    const scale = _viewportState.getScale() || 1;
    if (_layoutScale === null || _layoutScale !== scale) {
      _updateLayout(_anchorImgIdx, _layout.offsets[_anchorImgIdx]?.top || 0);
    }
    _strip.style.transform = _viewportState.getTransform();
    _updateWindow();
    _scheduleSettle();
  });
  ro.observe(_viewport);
}

export function isManhwaStripActive() {
  return _active;
}

