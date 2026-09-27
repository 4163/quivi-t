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
import { computeColumnOffsets, findAnchorIndex, computeWindowRange, seamOverlapForScale, computeTopAlignTy, computeBottomAlignTy, computeSlotHue, computeStripFitScale } from '../services/viewerMath.js';
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

/**
 * Adaptive width estimate. First decoded raster width wins, capped at the
 * default so an outlier never inflates the column. Reset per column build.
 * Heights keep the fixed default: width errors only move the box sideways,
 * height errors shift the view.
 */
let _estWidth = null;
function _widthEstimate() {
  return _estWidth || DEFAULT_ESTIMATED_WIDTH;
}

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
let _lastFitMode = null;
let _lastFitModeGen = -1;

/** Session cache for resolved ICO spritesheet data URIs. */
const _icoCache = new Map();

function _getIcoKey(entry, state) {
  return state.mode === 'archive' ? `${state.archivePath}:${entry.name}` : entry.path;
}

function _resolveIco(entry, state) {
  return state.mode === 'archive'
    ? FsUtils.buildArchiveEntrySrc(state.archivePath, entry.name)
    : FsUtils.buildFileSrc(entry.path);
}

function _buildSrc(entry, state) {
  const name = entry.name || entry.path || '';
  if (FsUtils.isIco(name)) {
    const key = _getIcoKey(entry, state);
    if (_icoCache.has(key)) return _icoCache.get(key);
  }
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
  img.removeAttribute('style');
  if (_freePool.length < STRIP_POOL_CAP) {
    _freePool.push(img);
  }
}

function _buildSlots() {
  if (!_strip) return;
  // Keep static strip children (slot grill backdrop), drop slots only.
  _strip.querySelectorAll('.manhwa-slot').forEach((n) => n.remove());
  _slots.clear();

  const total = _imageIndex.length;
  for (let i = 0; i < total; i++) {
    const item = _imageIndex[i];
    const slot = document.createElement('div');
    slot.className = 'manhwa-slot';
    slot.dataset.imgIdx = String(item.imgIdx);
    slot.dataset.listIndex = String(item.listIndex);

    const isSvg = /\.svg($|[?#])/i.test(item.entry?.name || item.entry?.path || '');
    const defW = isSvg ? 1000 : _widthEstimate();
    const defH = isSvg ? 1000 : DEFAULT_ESTIMATED_HEIGHT;
    const initialH = item.isVideo ? VIDEO_PLACEHOLDER_HEIGHT : (item.naturalHeight || defH);
    item.naturalHeight = initialH;
    item.naturalWidth = item.naturalWidth || defW;
    slot.style.height = `${initialH}px`;
    // Explicit width keeps the strip box at the widest known image so evicting
    // the widest mounted image never shrinks the column or clips the grill.
    slot.style.width = `${item.naturalWidth || defW}px`;

    if (total > 1) {
      const backdrop = document.createElement('div');
      backdrop.className = 'manhwa-slot-backdrop';
      slot.style.setProperty('--slot-backdrop-bg', computeSlotHue(i, total));
      slot.appendChild(backdrop);
    }

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

function _updateGrillAngles() {
  if (!_strip || !_viewportState) return;
  const grillAngle = _viewportState.getGrillAngle();
  _strip.style.setProperty('--grill-angle', grillAngle);
  _strip.style.setProperty('--slot-backdrop-angle', grillAngle === '45deg' ? '-45deg' : '45deg');
}

/** Zoom scale the column offsets were last built with. */
let _layoutScale = null;

function _updateLayout(anchorImgIdxToHold = null, oldAnchorTop = 0) {
  const scale = _viewportState?.getScale() || 1;
  _layoutScale = scale;
  const vpH = _viewport?.clientHeight || 800;
  const vw = _viewport?.clientWidth || 800;
  const oldTy = _viewportState?.getTy() || 0;
  const oldTotalH = _layout.totalHeight || 0;
  const oldMaxTy = Math.abs(oldTotalH * scale - vpH) / 2;
  const wasAtTop = oldTy >= oldMaxTy - 0.5;
  const wasAtBottom = oldTy <= -oldMaxTy + 0.5;

  _layout = computeColumnOffsets(_imageIndex, 1, seamOverlapForScale(scale));
  if (_viewportState) {
    _viewportState.setDimensions(_layout.widestWidth, _layout.totalHeight);
    const newTotalH = _layout.totalHeight || 0;
    const deltaTotalH = newTotalH - oldTotalH;
    const colH = newTotalH * scale;

    if (_anchorHoldover !== null && _layout.offsets[_anchorHoldover]) {
      if (_anchorHoldoverAlignTop) {
        const targetTy = computeTopAlignTy({
          slotTop: _layout.offsets[_anchorHoldover].top,
          totalHeight: newTotalH,
          scale,
          viewportHeight: vpH,
        });
        _viewportState.panTo(_viewportState.getTx(), targetTy);
      } else {
        const curTx = _viewportState.getTx();
        if (_anchorHoldover === 0) {
          _viewportState.panTo(curTx, Math.abs(colH - vpH) / 2);
        } else if (_anchorHoldover === _imageIndex.length - 1 && _imageIndex.length > 1) {
          _viewportState.panTo(curTx, -Math.abs(colH - vpH) / 2);
        } else if (colH <= vpH) {
          _viewportState.panTo(curTx, Math.abs(colH - vpH) / 2);
        } else {
          _centerColumnY(_layout.offsets[_anchorHoldover].top + _layout.offsets[_anchorHoldover].height / 2);
        }
      }
    } else if (anchorImgIdxToHold !== null && _layout.offsets[anchorImgIdxToHold]) {
      if (wasAtTop && !wasAtBottom) {
        // View was end-pinned: re-pin the end instead of holding the anchor.
        _viewportState.panTo(_viewportState.getTx(), Math.abs(colH - vpH) / 2);
      } else if (wasAtBottom && !wasAtTop) {
        _viewportState.panTo(_viewportState.getTx(), -Math.abs(colH - vpH) / 2);
      } else {
        const newAnchorTop = _layout.offsets[anchorImgIdxToHold].top;
        const deltaAnchorTop = newAnchorTop - oldAnchorTop;
        const targetTy = oldTy + (deltaTotalH * scale) / 2 - deltaAnchorTop * scale;
        _viewportState.panTo(_viewportState.getTx(), targetTy);
      }
    }
    _strip.style.transform = _viewportState.getTransform();
    _updateGrillAngles();
  }
  _positionSlotGrill();
}

function _onItemDecoded(imgIdx, nw, nh) {
  const item = _imageIndex[imgIdx];
  if (!item || item.isVideo) return;
  const oldH = item.naturalHeight;
  const oldAnchorTop = _layout.offsets[_anchorImgIdx]?.top || 0;
  const wasEstimated = !item.decoded;

  const isSvg = /\.svg($|[?#])/i.test(item.entry?.name || item.entry?.path || '');
  if (isSvg) {
    const isBrowserDefault = (nw === 150 && nh === 150) || (nw === 300 && nh === 150);
    const hasIntrinsic = nw > 0 && nh > 0 && !isBrowserDefault;
    if (!hasIntrinsic) {
      nw = 1000;
      nh = 1000;
    }
    const maxEdge = item.isAnimated ? 512 : 2048;
    if (nw > maxEdge || nh > maxEdge) {
      const s = Math.min(maxEdge / nw, maxEdge / nh);
      nw = Math.max(1, Math.round(nw * s));
      nh = Math.max(1, Math.round(nh * s));
    }
    const img = _mounted.get(imgIdx);
    if (!hasIntrinsic && img) {
      img.style.width = `${nw}px`;
      img.style.height = `${nh}px`;
    }
  }

  item.naturalWidth = nw;
  item.naturalHeight = nh;
  item.decoded = true;

  // First decoded raster width becomes the estimate for the rest. Uniform
  // directories converge at once; the default cap keeps outliers harmless.
  if (wasEstimated && !isSvg && _estWidth === null && nw > 0) {
    _estWidth = Math.min(nw, DEFAULT_ESTIMATED_WIDTH);
    for (let i = 0; i < _imageIndex.length; i++) {
      const other = _imageIndex[i];
      if (other.decoded || other.isVideo || i === imgIdx) continue;
      const otherSvg = /\.svg($|[?#])/i.test(other.entry?.name || other.entry?.path || '');
      if (otherSvg) continue;
      other.naturalWidth = _estWidth;
      const otherSlot = _slots.get(i);
      if (otherSlot) otherSlot.style.width = `${_estWidth}px`;
    }
  }

  const slot = _slots.get(imgIdx);
  if (slot) {
    slot.style.height = `${nh}px`;
    slot.style.width = `${nw}px`;
  }

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

/**
 * Span the group grill backdrop over the visible slots via custom properties.
 * Visible range never exceeds the viewport, so the painted layer stays small
 * on long chapters while covering exactly what is on screen.
 */
function _positionSlotGrill() {
  if (!_strip) return;
  const { startIndex, endIndex } = _computeVisibleRange();
  if (startIndex === -1 || endIndex === -1 || !_layout.offsets[startIndex] || !_layout.offsets[endIndex]) {
    _strip.style.setProperty('--slot-grill-top', '0px');
    _strip.style.setProperty('--slot-grill-height', '0px');
    return;
  }
  _strip.style.setProperty('--slot-grill-top', `${_layout.offsets[startIndex].top}px`);
  _strip.style.setProperty('--slot-grill-height', `${_layout.offsets[endIndex].bottom - _layout.offsets[startIndex].top}px`);
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

    const isIco = FsUtils.isIco(item.entry.name || item.entry.path || '');
    if (isIco) {
      const key = _getIcoKey(item.entry, state);
      if (!_icoCache.has(key)) {
        _resolveIco(item.entry, state).then((icoSrc) => {
          if (icoSrc) {
            _icoCache.set(key, icoSrc);
            if (!_active || _mounted.get(i) !== img) return;
            img.src = icoSrc;
          }
        }).catch(() => {});
      }
    }

    const isSvg = /\.svg($|[?#])/i.test(item.entry?.name || item.entry?.path || '');
    if (isSvg && item.decoded) {
      const isBrowserDefault = (item.naturalWidth === 150 && item.naturalHeight === 150) || (item.naturalWidth === 300 && item.naturalHeight === 150);
      if (isBrowserDefault || (item.naturalWidth === 1000 && item.naturalHeight === 1000)) {
        img.style.width = `${item.naturalWidth}px`;
        img.style.height = `${item.naturalHeight}px`;
      }
    }

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
  _lastAnchorTy = ty;
  _lastAnchorScale = scale;
  _lastAnchorVph = vpH;
  if (newAnchor !== -1 && newAnchor !== _anchorImgIdx) {
    _anchorImgIdx = newAnchor;
    _scheduleSettle();
  }
  _positionSlotGrill();
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
    const isIco = FsUtils.isIco(item.entry.name || item.entry.path || '');
    if (isIco) {
      const key = _getIcoKey(item.entry, state);
      if (!_icoCache.has(key)) {
        _resolveIco(item.entry, state).then((icoSrc) => {
          if (icoSrc) {
            _icoCache.set(key, icoSrc);
            if (!_active || !_prefetching.has(i)) return;
            pre.src = icoSrc;
          }
        }).catch(() => {});
      } else {
        pre.src = _icoCache.get(key);
      }
    } else {
      pre.src = _buildSrc(item.entry, state);
    }
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
  const hadHoldover = _anchorHoldover !== null;
  if (_anchorHoldover !== null) {
    const { startIndex: visStart, endIndex: visEnd } = _computeVisibleRange();
    if (visStart !== -1 && visEnd !== -1) {
      _anchorImgIdx = Math.max(visStart, Math.min(visEnd, _anchorHoldover));
    }
    _anchorHoldover = null;
    _anchorHoldoverAlignTop = true;
  }
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
  if (!hadHoldover && !anchorChanged && !visChanged) return;
  if (anchorChanged || hadHoldover) {
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
let _anchorHoldoverAlignTop = true;
/** View params the anchor was last derived from; layout-only changes keep it. */
let _lastAnchorTy = null;
let _lastAnchorScale = null;
let _lastAnchorVph = null;

function _applyFitMode(mode, targetImgIdx = null, alignTop = false) {
  if (!_active || !_viewportState || !_viewport || _imageIndex.length === 0) return;
  const fitMode = mode || Core.getState()?.fitMode || 'none';

  const maxW = (_layout.widestWidth && _layout.widestWidth > 0) ? _layout.widestWidth : DEFAULT_ESTIMATED_WIDTH;
  const vw = _viewport.clientWidth || 800;
  const vh = _viewport.clientHeight || 800;

  let rawSumH = 0;
  for (let i = 0; i < _imageIndex.length; i++) {
    const item = _imageIndex[i];
    rawSumH += typeof item === 'number' ? item : ((item && (item.naturalHeight ?? item.height)) || DEFAULT_ESTIMATED_HEIGHT);
  }

  const targetScale = computeStripFitScale({
    fitMode,
    vw,
    vh,
    maxW,
    rawSumH,
    itemCount: _imageIndex.length,
  });

  const anchorIdx = targetImgIdx !== null ? targetImgIdx : _anchorImgIdx;
  _anchorHoldover = anchorIdx;
  _anchorHoldoverScale = targetScale;
  _anchorHoldoverAlignTop = !!alignTop;

  _viewportState.zoomTo(targetScale, vw / 2, vh / 2);
  const colH = (_layout.totalHeight || 0) * targetScale;

  if (targetImgIdx === null) {
    if (colH <= vh + 0.5) {
      _viewportState.panTo(0, Math.abs(colH - vh) / 2);
    } else {
      _viewportState.panTo(0, _viewportState.getTy());
    }
  } else if (alignTop) {
    if (_layout.offsets[targetImgIdx]) {
      _topAlignColumnY(_layout.offsets[targetImgIdx].top, 0);
    } else if (colH <= vh + 0.5) {
      _viewportState.panTo(0, Math.abs(colH - vh) / 2);
    }
  } else {
    if (targetImgIdx === 0) {
      _viewportState.panTo(0, Math.abs(colH - vh) / 2);
    } else if (targetImgIdx === _imageIndex.length - 1 && _imageIndex.length > 1) {
      _viewportState.panTo(0, -Math.abs(colH - vh) / 2);
    } else if (colH <= vh + 0.5) {
      _viewportState.panTo(0, Math.abs(colH - vh) / 2);
    } else if (_layout.offsets[targetImgIdx]) {
      _centerColumnY(_layout.offsets[targetImgIdx].top + _layout.offsets[targetImgIdx].height / 2, 0);
    }
  }

  _strip.style.transform = _viewportState.getTransform();
  _strip.style.setProperty('--zoom-scale', targetScale);
  _updateGrillAngles();
  _updateWindow();
  _scheduleSettle();
}

export function alignListItemTop(listIndex) {
  if (!_active || !_viewportState) return false;
  const mapped = _listToImgIdx.get(listIndex);
  if (mapped === undefined || !_layout.offsets[mapped]) return false;
  _anchorImgIdx = mapped;
  _anchorHoldover = mapped;
  _anchorHoldoverAlignTop = true;
  const scale = _viewportState.getScale() || 1;
  _anchorHoldoverScale = scale;

  _topAlignColumnY(_layout.offsets[mapped].top);

  _strip.style.transform = _viewportState.getTransform();
  _updateGrillAngles();
  _updateWindow();
  _scheduleSettle();
  return true;
}

export function alignListItemBottom(listIndex) {
  if (!_active || !_viewportState) return false;
  const mapped = _listToImgIdx.get(listIndex);
  if (mapped === undefined || !_layout.offsets[mapped]) return false;
  _anchorImgIdx = mapped;
  _anchorHoldover = mapped;
  _anchorHoldoverAlignTop = false;
  const scale = _viewportState.getScale() || 1;
  _anchorHoldoverScale = scale;

  _bottomAlignColumnY(_layout.offsets[mapped].bottom);

  _strip.style.transform = _viewportState.getTransform();
  _updateGrillAngles();
  _updateWindow();
  _scheduleSettle();
  return true;
}

export function centerListItem(listIndex) {
  if (!_active || !_viewportState) return false;
  const mapped = _listToImgIdx.get(listIndex);
  if (mapped === undefined || !_layout.offsets[mapped]) return false;
  _anchorImgIdx = mapped;
  _anchorHoldover = mapped;
  _anchorHoldoverAlignTop = false;
  const scale = _viewportState.getScale() || 1;
  _anchorHoldoverScale = scale;

  const colH = (_layout.totalHeight || 0) * scale;
  const vh = _viewport?.clientHeight || 800;
  const curTx = _viewportState.getTx();
  if (mapped === 0) {
    _viewportState.panTo(curTx, Math.abs(colH - vh) / 2);
  } else if (mapped === _imageIndex.length - 1 && _imageIndex.length > 1) {
    _viewportState.panTo(curTx, -Math.abs(colH - vh) / 2);
  } else if (colH <= vh) {
    _viewportState.panTo(curTx, Math.abs(colH - vh) / 2);
  } else if (_layout.offsets[mapped]) {
    _centerColumnY(_layout.offsets[mapped].top + _layout.offsets[mapped].height / 2);
  }

  _strip.style.transform = _viewportState.getTransform();
  _updateGrillAngles();
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
    return alignListItemTop(state.index);
  }
  // Landed on a non-image entry: pin the nearest image top in travel direction.
  const dir = delta >= 0 ? 1 : -1;
  let candidate = -1;
  for (let i = 0; i < _imageIndex.length; i++) {
    const li = _imageIndex[i].listIndex;
    if (dir > 0 && li > state.index) { candidate = li; break; }
    if (dir < 0 && li < state.index) { candidate = li; }
  }
  if (candidate === -1) return false;
  Core.selectIndex(candidate);
  return alignListItemTop(candidate);
}

export function pageStrip(direction, pageMultiplier = 1) {
  if (!_active || !_viewportState || !_layout.offsets.length || _imageIndex.length === 0) return false;
  const scale = _viewportState.getScale() || 1;
  const vpH = _viewport?.clientHeight || 800;
  const colVisualH = (_layout.totalHeight || 0) * scale;

  if (colVisualH <= vpH) {
    const targetIdx = direction > 0 ? getLastImageIndex() : getFirstImageIndex();
    if (targetIdx !== -1) {
      if (Core.getState().index !== targetIdx) {
        Core.selectIndex(targetIdx);
      }
      if (direction > 0) {
        alignListItemBottom(targetIdx);
      } else {
        alignListItemTop(targetIdx);
      }
    }
    return true;
  }

  const ty = _viewportState.getTy() || 0;
  const maxTy = (colVisualH - vpH) / 2;
  const minTy = -(colVisualH - vpH) / 2;
  const step = Math.max(1, pageMultiplier) * vpH;

  if (direction < 0 && ty >= maxTy - 0.5) {
    const firstIdx = getFirstImageIndex();
    if (firstIdx !== -1) {
      if (Core.getState().index !== firstIdx) {
        Core.selectIndex(firstIdx);
      }
      alignListItemTop(firstIdx);
    }
    return true;
  }

  if (direction > 0 && ty <= minTy + 0.5) {
    const lastIdx = getLastImageIndex();
    if (lastIdx !== -1) {
      if (Core.getState().index !== lastIdx) {
        Core.selectIndex(lastIdx);
      }
      alignListItemBottom(lastIdx);
    }
    return true;
  }

  const targetTy = direction > 0 ? Math.max(minTy, ty - step) : Math.min(maxTy, ty + step);
  _viewportState.panTo(_viewportState.getTx(), targetTy);
  _strip.style.transform = _viewportState.getTransform();
  _updateWindow();
  _scheduleSettle();
  return true;
}

/**
 * Pan so column position colY (unzoomed) lands at the viewport top.
 * ty is screen px, clamped to column ends. Preserves horizontal pan.
 */
function _topAlignColumnY(colY, targetTx = null) {
  if (!_viewportState || !_layout.offsets.length) return;
  const scale = _viewportState.getScale() || 1;
  const vpH = _viewport?.clientHeight || 800;
  const targetTy = computeTopAlignTy({
    slotTop: colY,
    totalHeight: _layout.totalHeight || 0,
    scale,
    viewportHeight: vpH,
  });
  const tx = targetTx !== null ? targetTx : _viewportState.getTx();
  _viewportState.panTo(tx, targetTy);
  _strip.style.transform = _viewportState.getTransform();
}

/**
 * Pan so column position colY (unzoomed) lands at the viewport bottom.
 * ty is screen px, clamped to column ends. Preserves horizontal pan.
 */
function _bottomAlignColumnY(colY, targetTx = null) {
  if (!_viewportState || !_layout.offsets.length) return;
  const scale = _viewportState.getScale() || 1;
  const vpH = _viewport?.clientHeight || 800;
  const targetTy = computeBottomAlignTy({
    slotBottom: colY,
    totalHeight: _layout.totalHeight || 0,
    scale,
    viewportHeight: vpH,
  });
  const tx = targetTx !== null ? targetTx : _viewportState.getTx();
  _viewportState.panTo(tx, targetTy);
  _strip.style.transform = _viewportState.getTransform();
}

/**
 * Pan so column position colY (unzoomed) lands at the viewport center.
 * ty is screen px, so the offset scales with zoom. Preserves horizontal pan.
 */
function _centerColumnY(colY, targetTx = null) {
  if (!_viewportState || !_layout.offsets.length) return;
  const scale = _viewportState.getScale() || 1;
  const targetTy = (_layout.totalHeight / 2 - colY) * scale;
  const tx = targetTx !== null ? targetTx : _viewportState.getTx();
  _viewportState.panTo(tx, targetTy);
  _strip.style.transform = _viewportState.getTransform();
}

function _activate(state) {
  if (_active) return;
  _active = true;
  _viewport.classList.add('manhwa-active');

  const isLocked = state.archiveEncryption === 'password_required' || state.archiveEncryption === 'password_incorrect';
  _imageIndex = isLocked ? [] : _buildImageIndex(state.list || []);
  _estWidth = null;
  _lastList = state.list;
  _lastMode = state.mode;
  _lastArchivePath = state.archivePath;
  _lastDirectory = state.directory;
  _lastArchiveEncryption = state.archiveEncryption;
  _lastTy = null;
  _lastScale = null;
  _anchorHoldover = null;
  _anchorHoldoverAlignTop = true;
  _lastAnchorTy = null;
  _lastAnchorScale = null;
  _lastAnchorVph = null;
  _lastSyncedListIndex = null;
  _lastVisSig = null;
  _layoutScale = null;

  if (_strip) {
    _strip.dataset.scaling = state.scalingMode || 'bilinear';
    _updateGrillAngles();
  }

  _buildSlots();
  _updateLayout();

  const mapped = _listToImgIdx.get(state.index);
  _anchorImgIdx = mapped !== undefined ? mapped : 0;

  _lastFitMode = state.fitMode || state.config?.frontend_data?.fit_mode || 'none';
  _lastFitModeGen = state.fitModeGen !== undefined ? state.fitModeGen : -1;
  _applyFitMode(_lastFitMode, _anchorImgIdx);

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
  _lastFitMode = null;
  _lastFitModeGen = -1;
  _anchorHoldover = null;
  _anchorHoldoverAlignTop = true;
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
  if (_strip) _strip.querySelectorAll('.manhwa-slot').forEach((n) => n.remove());

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
    if (_strip) _strip.querySelectorAll('.manhwa-slot').forEach((n) => n.remove());

    _imageIndex = isLocked ? [] : _buildImageIndex(state.list || []);
    _estWidth = null;
    _lastList = state.list;
    _lastMode = state.mode;
    _lastArchivePath = state.archivePath;
    _lastDirectory = state.directory;
    _lastArchiveEncryption = state.archiveEncryption;
    _lastTy = null;
    _lastScale = null;
    _anchorHoldover = null;
    _anchorHoldoverAlignTop = true;
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

    _lastFitMode = state.fitMode || state.config?.frontend_data?.fit_mode || 'none';
    _lastFitModeGen = state.fitModeGen !== undefined ? state.fitModeGen : -1;
    _applyFitMode(_lastFitMode, _anchorImgIdx);

    _updateWindow();
    if (_imageIndex.length > 0) {
      _scheduleSettle();
    }
    return;
  }

  const fitModeChanged = (state.fitMode && state.fitMode !== _lastFitMode) || (state.fitModeGen !== undefined && state.fitModeGen !== _lastFitModeGen);
  if (fitModeChanged) {
    _lastFitMode = state.fitMode;
    _lastFitModeGen = state.fitModeGen !== undefined ? state.fitModeGen : _lastFitModeGen;
    _applyFitMode(state.fitMode);
    return;
  }

  // External index change (panel click/keyboard) — top align it.
  if (!_anchorUpdateInProgress && state.index >= 0) {
    const mapped = _listToImgIdx.get(state.index);
    if (mapped !== undefined && mapped !== _anchorImgIdx) {
      alignListItemTop(state.index);
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
    _updateGrillAngles();
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
    _applyFitMode(Core.getState()?.fitMode || _lastFitMode);
  });
  ro.observe(_viewport);
}

export function isManhwaStripActive() {
  return _active;
}

