/**
 * manhwaStrip.js: continuous column loader for the manhwa vertical strip.
 *
 * Owns #manhwa-strip and the .manhwa-active class on #viewport.
 * Appends every image entry top-down at 1:1 scale with transform-based
 * pan and zoom via viewportState. Slots reserve estimated heights before
 * decode and correct after without jumping the view. An item-count buffer
 * around the anchor mounts images before they scroll into view.
 */

import { Core } from '../core.js';
import { BoundedMap } from '../services/cache.js';
import { FsUtils } from '../fsUtils.js';
import { getCachedArchiveBlob } from '../services/archiveImageCache.js';
import { computeColumnOffsets, findAnchorIndex, computeWindowRange, seamOverlapForScale, computeTopAlignTy, computeBottomAlignTy, computeSlotHue, computeStripFitScale, firstLastHighlight } from '../services/viewerMath.js';
import { Statusbar } from '../menubar/statusbar.js';

/** Max img nodes kept in the free pool after eviction. */
const STRIP_POOL_CAP = 10;

/** Item-count buffer behind the anchor. Strict 1-image policy: index based,
 * so wrong height estimates never misalign it. */
const STRIP_BEHIND_COUNT = 1;

/** Item-count buffer ahead of the anchor. 1 image only. Anything outside
 * [anchor - BEHIND, anchor + AHEAD] unmounts. */
const STRIP_AHEAD_COUNT = 1;

/** Max completed off-DOM prefetched images retained in memory. Strict 1. */
const PREFETCH_CACHE_CAPACITY = 1;

/** Items preloaded beyond the mount window, in pan direction. Strict 1. */
const PREFETCH_AHEAD_COUNT = 1;

/** Entries past the mount window to warm in the Rust zip LRU, per side.
 * Covers the 1-ahead mount plus its prefetch, nothing more. */
const BACKEND_WARM_AHEAD = 2;

/** Max concurrent in-flight prefetch decodes. */
const PREFETCH_CONCURRENT_MAX = 2;

/** Hold-sync heartbeat. OS key repeat resets the 100 ms settle timer faster
 * than it fires, so the panel starves until key-up. Syncing the anchor at
 * this interval keeps the panel following mid-hold; settle still commits. */
const STRIP_SYNC_HEARTBEAT_MS = 150;

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

let _viewport = null;
let _strip = null;
let _viewportState = null;
let _active = false;
let _initialized = false;
let _topSpacer = null;
let _bottomSpacer = null;

/** Filtered image entries: { listIndex, entry, imgIdx, naturalWidth, naturalHeight, decoded }[].
 * Videos are excluded entirely: selecting one is highlight-only with the
 * drop overlay up, and the strip never reserves rows for them. */
let _imageIndex = [];

/** Reverse map: listIndex → imgIdx (position in _imageIndex). */
const _listToImgIdx = new Map();

/** Map from imgIdx → slot container element for currently mounted items. */
const _slots = new Map();

/** Map from imgIdx → DOM img node for currently mounted items. */
const _mounted = new Map();

/** Map from imgIdx → off-DOM Image currently decoding ahead of the window. */
const _prefetching = new Map();

/** Map from imgIdx → off-DOM Image that finished prefetch and is ready for instant mount. */
const _prefetchedImages = new Map();

/** Free pool of recycled img nodes. */
const _freePool = [];

/** Max slot container nodes kept in the free pool after eviction. */
const SLOT_POOL_CAP = 15;

/** Free pool of recycled slot container nodes. */
const _freeSlotPool = [];

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
/** Last backend warm key. Skips repeat warms while the window is static. */
let _lastBackendWarmKey = null;
let _lastTy = null;
let _lastPanAt = 0;
/** Last viewport scale change. Zoom and fit steps reschedule the debounced
 * settle like pans do, so without this the file list lags them whenever
 * decode bursts keep resetting the settle timer. */
let _lastZoomAt = 0;
let _lastHeartbeatAt = 0;
let _lastScale = null;
let _lastFitMode = null;
let _lastFitModeGen = -1;
/** Reapply the current column fit after ICO dimensions replace placeholders. */
let _fitRefreshPending = false;
/** One-shot entry refit. Entry scale derives from estimates, so the first
 * resolved raster width replays the entry fit once against real dims.
 * _entryRefreshEntry replays the arming fit's semantics: directory opens use
 * the fresh-open clamp, toggles replay legacy whole-column math. */
let _entryRefreshArmed = false;
let _entryRefreshArmedAt = 0;
let _entryRefreshPending = false;
let _entryRefreshEntry = false;

/** Sequential decode queue. Fresh items decode off-DOM here in scroll order
 * and mount only with known dims, so images never paint at estimated size.
 * Entries are { imgIdx, item, state }; no DOM node exists until decode. */
let _mountQueue = [];
/** imgIdx of the item currently decoding through the queue, -1 if idle. */
let _mountInFlight = -1;
/** Coalesced layout pass for decode bursts. One rebuild per frame. */
let _layoutRaf = 0;

/** Session cache for resolved ICO spritesheet data URIs. */
const ICO_CACHE_CAPACITY = 50;
const _icoCache = new BoundedMap(ICO_CACHE_CAPACITY);

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
    const cached = getCachedArchiveBlob(archiveSrc);
    if (cached) return cached;
    return archiveSrc;
  }
  return FsUtils.buildFileSrcSync(entry.path);
}

/** Pending downloads hold no slot and no height. They join the index when
 * their bytes land instead of painting placeholders that later shift. */
function _isPendingEntry(entry) {
  if (!entry || entry.is_dir || entry.is_parent) return false;
  if ((entry.size || 0) === 0) return true;
  try {
    if (Core.isPlaceholder(entry.path || entry.name || '')) return true;
  } catch {
    // Registry unavailable: size check above already decided.
  }
  return false;
}

function _buildImageIndex(list) {
  const result = [];
  _listToImgIdx.clear();
  for (let i = 0; i < list.length; i++) {
    const entry = list[i];
    if (FsUtils.isImageEntry(entry) && !FsUtils.isVideoEntry(entry) && !_isPendingEntry(entry)) {
      const imgIdx = result.length;
      result.push({
        listIndex: i,
        entry,
        imgIdx,
        naturalWidth: 0,
        naturalHeight: 0,
        decoded: false,
      });
      _listToImgIdx.set(i, imgIdx);
    }
  }
  return result;
}

function _setSlotDimensions(slot, width, height) {
  if (!slot) return;
  if (width !== undefined) slot.style.setProperty('--slot-width', `${width}px`);
  if (height !== undefined) slot.style.setProperty('--slot-height', `${height}px`);
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
  img.onload = null;
  img.onerror = null;
  img.removeAttribute('src');
  img.removeAttribute('data-list-index');
  img.removeAttribute('data-img-idx');
  img.removeAttribute('style');
  if (_freePool.length < STRIP_POOL_CAP) {
    _freePool.push(img);
  }
}

/** Shared mount handlers. One pair serves all slots, keyed by dataset.imgIdx. */
function _handleStripImgLoad(event) {
  const img = event?.currentTarget;
  const imgIdx = Number(img?.dataset?.imgIdx);
  if (!Number.isFinite(imgIdx)) return;
  _onItemDecoded(imgIdx, img.naturalWidth, img.naturalHeight);
  if (_mountInFlight === imgIdx) {
    _mountInFlight = -1;
    _advanceMountQueue();
  }
}

function _handleStripImgError(event) {
  const img = event?.currentTarget;
  const imgIdx = Number(img?.dataset?.imgIdx);
  if (!Number.isFinite(imgIdx)) return;
  const item = _imageIndex[imgIdx];
  // No failure UI by policy.
  _onItemDecoded(imgIdx, item?.naturalWidth || DEFAULT_ESTIMATED_WIDTH, item?.naturalHeight || DEFAULT_ESTIMATED_HEIGHT);
  if (_mountInFlight === imgIdx) {
    _mountInFlight = -1;
    _advanceMountQueue();
  }
}

function _trimPrefetchCache() {
  while (_prefetchedImages.size > PREFETCH_CACHE_CAPACITY) {
    let furthestIdx = -1;
    let maxDist = -1;
    for (const idx of _prefetchedImages.keys()) {
      const dist = Math.abs(idx - _anchorImgIdx);
      if (dist > maxDist) {
        maxDist = dist;
        furthestIdx = idx;
      }
    }
    if (furthestIdx === -1) break;
    const oldImg = _prefetchedImages.get(furthestIdx);
    _prefetchedImages.delete(furthestIdx);
    _releaseNode(oldImg);
  }
}

function _ensureStripSpacers() {
  if (!_strip) return;
  _topSpacer = _strip.querySelector('#manhwa-strip-spacer-top');
  if (!_topSpacer) {
    _topSpacer = document.createElement('div');
    _topSpacer.id = 'manhwa-strip-spacer-top';
    _strip.appendChild(_topSpacer);
  }
  _bottomSpacer = _strip.querySelector('#manhwa-strip-spacer-bottom');
  if (!_bottomSpacer) {
    _bottomSpacer = document.createElement('div');
    _bottomSpacer.id = 'manhwa-strip-spacer-bottom';
    _strip.appendChild(_bottomSpacer);
  }
}

function _updateSpacers(startIndex, endIndex) {
  if (!_strip) return;
  _strip.style.setProperty('--strip-width', `${_layout.widestWidth || 0}px`);
  if (!_layout.offsets || !_layout.offsets.length) {
    _strip.style.setProperty('--strip-spacer-top', '0px');
    _strip.style.setProperty('--strip-spacer-bottom', '0px');
    return;
  }
  const total = _imageIndex.length;
  if (startIndex < 0 || endIndex < 0 || startIndex >= total || endIndex >= total || startIndex > endIndex) {
    _strip.style.setProperty('--strip-spacer-top', '0px');
    _strip.style.setProperty('--strip-spacer-bottom', `${_layout.totalHeight || 0}px`);
    return;
  }
  const topH = _layout.offsets[startIndex] ? _layout.offsets[startIndex].top : 0;
  const bottomH = _layout.offsets[endIndex] ? Math.max(0, _layout.totalHeight - _layout.offsets[endIndex].bottom) : 0;
  _strip.style.setProperty('--strip-spacer-top', `${topH}px`);
  _strip.style.setProperty('--strip-spacer-bottom', `${bottomH}px`);
}

function _syncMountedSpacers() {
  if (_slots.size === 0) {
    _updateSpacers(-1, -1);
    return;
  }
  let minIdx = Infinity;
  let maxIdx = -Infinity;
  for (const idx of _slots.keys()) {
    if (idx < minIdx) minIdx = idx;
    if (idx > maxIdx) maxIdx = idx;
  }
  _updateSpacers(minIdx, maxIdx);
}

function _createSlotNode() {
  const slot = document.createElement('div');
  slot.className = 'manhwa-slot';
  const backdrop = document.createElement('div');
  backdrop.className = 'manhwa-slot-backdrop';
  slot.appendChild(backdrop);
  return slot;
}

function _acquireSlotNode(item, total) {
  const slot = _freeSlotPool.length > 0 ? _freeSlotPool.pop() : _createSlotNode();
  slot.className = 'manhwa-slot';
  slot.dataset.imgIdx = String(item.imgIdx);
  slot.dataset.listIndex = String(item.listIndex);
  _setSlotDimensions(slot, item.naturalWidth, item.naturalHeight);
  if (item.decoded) {
    slot.dataset.ready = 'true';
  } else {
    delete slot.dataset.ready;
  }
  if (total > 1) {
    slot.style.setProperty('--slot-backdrop-bg', computeSlotHue(item.imgIdx, total));
  } else {
    slot.style.removeProperty('--slot-backdrop-bg');
  }
  return slot;
}

function _releaseSlotNode(slot) {
  slot.removeAttribute('data-img-idx');
  slot.removeAttribute('data-list-index');
  delete slot.dataset.ready;
  slot.style.removeProperty('--slot-width');
  slot.style.removeProperty('--slot-height');
  slot.style.removeProperty('--slot-backdrop-bg');
  const img = slot.querySelector('img');
  if (img) img.remove();
  if (_freeSlotPool.length < SLOT_POOL_CAP) {
    _freeSlotPool.push(slot);
  }
}

function _insertSlotOrdered(slot, imgIdx) {
  if (!_strip) return;
  const existingSlots = _strip.querySelectorAll('.manhwa-slot');
  for (const existing of existingSlots) {
    const existingIdx = Number(existing.dataset.imgIdx);
    if (existingIdx > imgIdx) {
      _strip.insertBefore(slot, existing);
      return;
    }
  }
  if (_bottomSpacer && _bottomSpacer.parentNode === _strip) {
    _strip.insertBefore(slot, _bottomSpacer);
  } else {
    _strip.appendChild(slot);
  }
}

function _initEstimatedDimensions() {
  const total = _imageIndex.length;
  for (let i = 0; i < total; i++) {
    const item = _imageIndex[i];
    const isSvg = /\.svg($|[?#])/i.test(item.entry?.name || item.entry?.path || '');
    const defW = isSvg ? 1000 : _widthEstimate();
    const defH = isSvg ? 1000 : DEFAULT_ESTIMATED_HEIGHT;
    item.naturalHeight = item.naturalHeight || defH;
    item.naturalWidth = item.naturalWidth || defW;
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
  _viewportProgram++;
  try {
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
    const newTotalH = _layout.totalHeight || 0;
    const deltaTotalH = newTotalH - oldTotalH;
    const colH = newTotalH * scale;
    let targetTy = oldTy;

    if (_anchorHoldover !== null && _layout.offsets[_anchorHoldover]) {
      if (_anchorHoldoverAlignTop) {
        targetTy = computeTopAlignTy({
          slotTop: _layout.offsets[_anchorHoldover].top,
          totalHeight: newTotalH,
          scale,
          viewportHeight: vpH,
        });
      } else {
        if (_anchorHoldover === _imageIndex.length - 1 && _imageIndex.length > 1) {
          targetTy = -Math.abs(colH - vpH) / 2;
        } else if (colH <= vpH) {
          targetTy = Math.abs(colH - vpH) / 2;
        } else {
          const centerSlotY = _layout.offsets[_anchorHoldover].top + _layout.offsets[_anchorHoldover].height / 2;
          targetTy = (newTotalH / 2 - centerSlotY) * scale;
        }
      }
    } else if (anchorImgIdxToHold !== null && _layout.offsets[anchorImgIdxToHold]) {
      // End-pin re-pins snap the whole column. Gate them on quiet: replay
      // showed a top re-pin kicking ty mid-scroll when slot 1 decoded.
      const panning = performance.now() - _lastPanAt < 150;
      if (wasAtTop && !wasAtBottom && !panning) {
        // View was end-pinned: re-pin the end instead of holding the anchor.
        targetTy = Math.abs(colH - vpH) / 2;
      } else if (wasAtBottom && !wasAtTop && !panning) {
        targetTy = -Math.abs(colH - vpH) / 2;
      } else {
        const newAnchorTop = _layout.offsets[anchorImgIdxToHold].top;
        const deltaAnchorTop = newAnchorTop - oldAnchorTop;
        targetTy = oldTy + (deltaTotalH * scale) / 2 - deltaAnchorTop * scale;
      }
    }

    _viewportState.setDimensions(_layout.widestWidth, _layout.totalHeight, _viewportState.getTx(), targetTy);
    // Track what the viewport kept, not what was asked. Clamping inside
    // setDimensions would otherwise read back as a phantom manual pan that
    // clears the holdover and re-derives the anchor on the next pass.
    _lastTy = _viewportState.getTy();
    _lastAnchorTy = _lastTy;
    _strip.style.transform = _viewportState.getTransform();
    _strip.style.setProperty('--strip-width', `${_layout.widestWidth}px`);
    _updateGrillAngles();
  }
  _syncMountedSpacers();
  } finally {
    _viewportProgram--;
  }
}

function _onItemDecoded(imgIdx, nw, nh) {
  const item = _imageIndex[imgIdx];
  if (!item) return;
  const oldW = item.naturalWidth;
  const oldH = item.naturalHeight;
  // The anchor correction runs at flush time in _requestLayout, recomputed
  // from current state so a burst of decodes settles once, not once each.
  const wasEstimated = !item.decoded;

  const isSvg = /\.svg($|[?#])/i.test(item.entry?.name || item.entry?.path || '');
  const isIco = FsUtils.isIco(item.entry?.name || item.entry?.path || '');
  if (isSvg) {
    const isBrowserDefault = (nw === 150 && nh === 150) || (nw === 300 && nh === 150);
    const hasIntrinsic = nw > 0 && nh > 0 && !isBrowserDefault;
    if (!hasIntrinsic) {
      nw = 1000;
      nh = 1000;
    }
    // Animation status is unavailable on strip items without an async IPC
    // call per entry. Cap all SVGs at 2048px; animated SVGs in manhwa strips
    // are rare and 2048px is already bounded enough to avoid decode stalls.
    const maxEdge = 2048;
    if (nw > maxEdge || nh > maxEdge) {
      const s = Math.min(maxEdge / nw, maxEdge / nh);
      nw = Math.max(1, Math.round(nw * s));
      nh = Math.max(1, Math.round(nh * s));
    }
    // Slot drives display size via CSS height:100%. No per-img inline sizing.
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
      if (other.decoded || i === imgIdx) continue;
      const otherSvg = /\.svg($|[?#])/i.test(other.entry?.name || other.entry?.path || '');
      if (otherSvg) continue;
      other.naturalWidth = _estWidth;
      const otherSlot = _slots.get(i);
      if (otherSlot) {
        _setSlotDimensions(otherSlot, _estWidth);
      }
    }
    if (_entryRefreshArmed) _entryRefreshPending = true;
  }

  if (wasEstimated && isIco && nh > 0) {
    for (let i = 0; i < _imageIndex.length; i++) {
      const other = _imageIndex[i];
      if (other.decoded || i === imgIdx || !FsUtils.isIco(other.entry?.name || other.entry?.path || '')) continue;
      other.naturalHeight = nh;
      const otherSlot = _slots.get(i);
      if (otherSlot) {
        _setSlotDimensions(otherSlot, undefined, nh);
      }
    }
  }

  const slot = _slots.get(imgIdx);
  if (slot) {
    _setSlotDimensions(slot, nw, nh);
    // Exact dims from here on: reveal the tinted backdrop with the image
    // instead of painting it at estimated size first. Loaded images cover
    // their slot fully, so the backdrop is only ever visible for undecided
    // slots, which stay neutral until this flag lands.
    slot.dataset.ready = 'true';
  }

  if (oldH !== nh || oldW !== nw) {
    if (isIco && (Core.getState()?.fitMode || _lastFitMode) !== 'none') {
      _fitRefreshPending = true;
    }
    _requestLayout();
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
  // No anchor (open_first_image off with a non-image selection): nothing
  // mounts or derives until the user picks an image.
  if (_anchorImgIdx < 0 && _anchorHoldover === null) return;

  const scale = _viewportState.getScale() || 1;
  const ty = _viewportState.getTy() || 0;
  const vpH = _viewport?.clientHeight || 800;

  const isFirstBuild = _lastTy === null;
  const deltaTy = isFirstBuild ? 0 : ty - _lastTy;
  _lastTy = ty;
  if (deltaTy !== 0 && _viewportProgram === 0) {
    _lastPanAt = performance.now();
    _anchorHoldover = null;
  }

  const isPanningDown = deltaTy < 0;
  const isPanningUp = deltaTy > 0;

  // Zooming in reframes the window: warm both sides regardless of direction.
  const zoomedIn = _lastScale !== null && scale > _lastScale + 1e-9;
  if (_lastScale !== null && Math.abs(scale - _lastScale) > 1e-9) {
    _lastZoomAt = performance.now();
  }
  _lastScale = scale;
  const prefetchDir = zoomedIn ? 0 : isPanningDown ? 1 : isPanningUp ? -1 : 0;

  const centerColY = (_layout.totalHeight / 2) - (ty / scale);

  const { startIndex: visStart, endIndex: visEnd } = _computeVisibleRange();
  const lastIdx = _imageIndex.length - 1;
  let anchor = findAnchorIndex(_layout.offsets, centerColY);
  if (anchor === -1) anchor = Math.max(0, Math.min(lastIdx, _anchorImgIdx));

  // Item-count buffer around the anchor, unioned with the visible range so
  // zoomed-out views with many small items on screen stay covered.
  let startIndex = Math.max(0, anchor - STRIP_BEHIND_COUNT);
  let endIndex = Math.min(lastIdx, anchor + STRIP_AHEAD_COUNT);
  if (visStart !== -1 && visEnd !== -1) {
    startIndex = Math.min(startIndex, visStart);
    endIndex = Math.max(endIndex, visEnd);
  }

  if (startIndex > endIndex) return;

  // Evict everything outside the buffer. Mounted nodes stay bounded by
  // BEHIND + AHEAD plus whatever is visibly on screen.
  for (const [imgIdx, img] of _mounted) {
    if (imgIdx < startIndex || imgIdx > endIndex) {
      if (_mountInFlight === imgIdx) _mountInFlight = -1;
      _mounted.delete(imgIdx);
      img.remove();
      _releaseNode(img);
    }
  }
  for (const [imgIdx, slot] of _slots) {
    if (imgIdx < startIndex || imgIdx > endIndex) {
      _slots.delete(imgIdx);
      slot.remove();
      _releaseSlotNode(slot);
    }
  }
  for (const [imgIdx, img] of _prefetchedImages) {
    if (imgIdx < startIndex - PREFETCH_AHEAD_COUNT || imgIdx > endIndex + PREFETCH_AHEAD_COUNT) {
      _prefetchedImages.delete(imgIdx);
      _releaseNode(img);
    }
  }
  for (const [imgIdx, pre] of _prefetching) {
    if (imgIdx < startIndex - PREFETCH_AHEAD_COUNT || imgIdx > endIndex + PREFETCH_AHEAD_COUNT) {
      _prefetching.delete(imgIdx);
      pre.onload = null;
      pre.onerror = null;
      pre.removeAttribute('src');
    }
  }

  // Ensure slots are mounted for all items in the window [startIndex, endIndex].
  for (let i = startIndex; i <= endIndex; i++) {
    const item = _imageIndex[i];
    if (!item) continue;
    let slot = _slots.get(i);
    if (!slot) {
      slot = _acquireSlotNode(item, _imageIndex.length);
      _insertSlotOrdered(slot, i);
      _slots.set(i, slot);
    }
  }

  _updateSpacers(startIndex, endIndex);

  // Mount missing images inside [startIndex, endIndex]. Nodes mount only
  // with known dims: decoded prefetches append at once, everything else
  // decodes off-DOM through the sequential queue first, so images paint
  // once at the right size instead of stretching from the estimate.
  const state = Core.getState();
  const queued = new Set(_mountQueue.map((e) => e.imgIdx));
  if (_mountInFlight !== -1) queued.add(_mountInFlight);
  const newQueueEntries = [];
  for (let i = startIndex; i <= endIndex; i++) {
    const item = _imageIndex[i];
    if (_mounted.has(i) || queued.has(i)) continue;

    const slot = _slots.get(i);
    if (!slot) continue;

    if (_prefetchedImages.has(i)) {
      const img = _prefetchedImages.get(i);
      _prefetchedImages.delete(i);
      if (!item.decoded && img.naturalWidth > 0) {
        _onItemDecoded(i, img.naturalWidth, img.naturalHeight);
      }
      _claimSlot(i, item, slot, img);
      continue;
    }

    if (_prefetching.has(i)) {
      const pre = _prefetching.get(i);
      if (pre.complete && pre.naturalWidth > 0) {
        // Finished while off-DOM: take over, size the slot, then mount.
        _prefetching.delete(i);
        if (!item.decoded) {
          _onItemDecoded(i, pre.naturalWidth, pre.naturalHeight);
        }
        _claimSlot(i, item, slot, pre);
      }
      // Still loading: leave it off-DOM. Its onload hands to
      // _prefetchedImages, and a later pass appends it with known dims.
      continue;
    }

    // Fresh: decode off-DOM through the sequential queue before mounting.
    newQueueEntries.push({ imgIdx: i, item, state });
  }

  // Rebuild queue: drop entries that mounted through another path, append
  // new ones, sort in travel direction. Quiet passes (decode flushes with
  // no pan delta) must not re-sort: they would flip a bottom-first scroll-up
  // queue back to top-first mid-travel.
  _mountQueue = _mountQueue.filter((e) => !_mounted.has(e.imgIdx));
  for (const e of newQueueEntries) _mountQueue.push(e);
  if (prefetchDir !== 0) _sortMountQueue(anchor, prefetchDir);
  _advanceMountQueue();

  // Prefetch always runs, including the first build: the mount loop above
  // only appends decoded nodes, so window items outside the visible range
  // and the ahead item depend on this pre-decode path from the first window.
  _prefetchAhead(startIndex, endIndex, prefetchDir, state, visStart, visEnd);

  // Backend warm still waits one update after activate or rebuild so the
  // visible images get full CPU on cold open instead of racing warm
  // extractions on huge files.
  if (!isFirstBuild) {
    // Warm Rust extraction for entries past the window. JS prefetch fetches
    // through quivit:// with no-store, so without this each ahead mount pays
    // full extraction on arrival. Keyed off the strip lead edge, not Core
    // index, which only moves on settle and lags scrolling by ~175ms.
    _warmBackendAhead(state, startIndex, endIndex, prefetchDir);
  }

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
      if (visStart !== -1 && visEnd !== -1) {
        // When the primary selection sits at a column edge and is still
        // visible, hold that edge during zoom instead of drifting to center.
        const primaryImgIdx = _listToImgIdx.get(Core.getState()?.index);
        const last = _imageIndex.length - 1;
        if (primaryImgIdx !== undefined && (primaryImgIdx === 0 || primaryImgIdx === last) &&
            primaryImgIdx >= visStart && primaryImgIdx <= visEnd) {
          newAnchor = primaryImgIdx;
        } else if (visStart === visEnd) {
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
  // Heartbeat sync during hold and zoom. Repeat pan ticks and decode bursts
  // keep resetting the settle timer, so without this the panel never follows
  // until key-up or decode quiet. Zoom and fit steps reschedule the same
  // timer without touching pan recency, so they share the heartbeat.
  // Well below repeat rate; _syncAnchorToCore skips when nothing moved.
  const now = performance.now();
  const viewActive = now - _lastPanAt < 150 || now - _lastZoomAt < 150;
  if (viewActive && now - _lastHeartbeatAt >= STRIP_SYNC_HEARTBEAT_MS) {
    _lastHeartbeatAt = now;
    _syncAnchorToCore();
  }
}

function _prefetchAhead(startIndex, endIndex, direction, state, visStart = -1, visEnd = -1) {
  const targets = [];
  // Window items outside the visible range must pre-decode off-DOM because
  // the mount loop no longer mounts them raw. Enqueue first for priority.
  // The pan path passes the already-computed visible range so a pan tick
  // does not rescan the full chapter for it.
  let visS = visStart;
  let visE = visEnd;
  if (visS === -1 || visE === -1) {
    const vis = _computeVisibleRange();
    visS = vis.startIndex;
    visE = vis.endIndex;
  }
  for (let i = startIndex; i <= endIndex; i++) {
    if (visS !== -1 && visE !== -1 && i >= visS && i <= visE) continue;
    targets.push(i);
  }
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
    if (!item || _mounted.has(i) || _prefetching.has(i) || _prefetchedImages.has(i) || _isDecodeQueued(i)) {
      continue;
    }
    const pre = new Image();
    pre.decoding = 'async';
    _prefetching.set(i, pre);
    pre.onload = async () => {
      _prefetching.delete(i);
      if (!_active) return;
      const cur = _imageIndex[i];
      if (!cur) return;
      // Pre-decode gate: force rasterization off-DOM so the node paints on
      // its first frame in the slot. A node that fails the gate drops out
      // and the follow-up pass retries it through the sequential worker.
      let gated = true;
      try {
        if (typeof pre.decode === 'function') await pre.decode();
      } catch {
        gated = false;
      }
      if (!_active) return;
      const stillCur = _imageIndex[i];
      if (!stillCur) return;
      if (gated) {
        _prefetchedImages.set(i, pre);
        _trimPrefetchCache();
        if (!stillCur.decoded && pre.naturalWidth > 0) {
          _onItemDecoded(i, pre.naturalWidth, pre.naturalHeight);
        }
      }
      // Always follow up while active. Gate failures and already-decoded
      // hits schedule nothing above, so without this the slot sits blank
      // with no pass left to mount or retry it while idle.
      _requestLayout();
    };
    pre.onerror = () => {
      _prefetching.delete(i);
      if (_active) _requestLayout();
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
            if (typeof pre.decode === 'function') pre.decode().catch(() => {});
          }
        }).catch(() => {});
      } else {
        pre.src = _icoCache.get(key);
        if (typeof pre.decode === 'function') pre.decode().catch(() => {});
      }
    } else {
      pre.src = _buildSrc(item.entry, state);
      if (typeof pre.decode === 'function') pre.decode().catch(() => {});
    }
  }
}

/**
 * Warm the Rust zip LRU for entries past the mount window. Direct invoke
 * with no debounce: FsUtils.prefetchAhead keys off Core index and lags
 * scrolling, this keys off the strip lead edge every window advance.
 */
function _warmBackendAhead(state, startIndex, endIndex, direction) {
  if (state.mode !== 'archive' || !state.archivePath) return;
  const last = _imageIndex.length - 1;
  const names = [];
  if (direction >= 0) {
    for (let i = endIndex + 1; i <= endIndex + BACKEND_WARM_AHEAD && i <= last; i++) {
      const item = _imageIndex[i];
      if (!item || !item.entry) continue;
      names.push(item.entry.name);
    }
  }
  if (direction <= 0) {
    for (let i = startIndex - 1; i >= startIndex - BACKEND_WARM_AHEAD && i >= 0; i--) {
      const item = _imageIndex[i];
      if (!item || !item.entry) continue;
      names.push(item.entry.name);
    }
  }
  if (names.length === 0) return;
  const key = `${state.archivePath}|${direction}|${names[0]}|${names[names.length - 1]}|${names.length}`;
  if (key === _lastBackendWarmKey) return;
  _lastBackendWarmKey = key;
  FsUtils.prefetchArchiveEntries(state.archivePath, names);
}

/** Sort queue entries top-first (ascending index). When scrolling up,
 * reverse to bottom-first so items fill in the direction of travel. */
function _sortMountQueue(_anchor, direction) {
  _mountQueue.sort((a, b) =>
    direction < 0 ? b.imgIdx - a.imgIdx : a.imgIdx - b.imgIdx
  );
}

/** Coalesce decode-driven corrections into one layout pass per frame.
 * Serial decodes each shifting the column reads as a staircase; one pass
 * per burst settles once. Slot styles stay synchronous in _onItemDecoded,
 * so only the model rebuild and anchor correction are deferred, and the
 * anchor is recomputed here from current state. */
function _requestLayout() {
  if (_layoutRaf) return;
  _layoutRaf = requestAnimationFrame(() => {
    _layoutRaf = null;
    if (!_active || !_viewportState || !_strip) return;
    const scale = _viewportState.getScale() || 1;
    const ty = _viewportState.getTy() || 0;
    const centerColY = (_layout.totalHeight / 2) - (ty / scale);
    const currentAnchor = findAnchorIndex(_layout.offsets, centerColY);
    const anchorToHold = _anchorHoldover !== null && _layout.offsets[_anchorHoldover]
      ? _anchorHoldover
      : (_anchorImgIdx >= 0 && _layout.offsets[_anchorImgIdx]
        ? _anchorImgIdx
        : (currentAnchor !== -1 ? currentAnchor : 0));
    const oldAnchorTop = _layout.offsets[anchorToHold]?.top || 0;
    _updateLayout(anchorToHold, oldAnchorTop);
    if (_fitRefreshPending) {
      _fitRefreshPending = false;
      _applyFitMode(Core.getState()?.fitMode || _lastFitMode, _anchorImgIdx, _anchorHoldoverAlignTop);
      return;
    }
    if (_entryRefreshPending && !_fitRefreshPending) {
      const fit = Core.getState()?.fitMode || _lastFitMode;
      const quiet = _lastPanAt < _entryRefreshArmedAt && _lastZoomAt < _entryRefreshArmedAt;
      const replayEntry = _entryRefreshEntry;
      _disarmEntryRefresh();
      if (quiet && fit && fit !== 'none') {
        _applyFitMode(fit, _anchorImgIdx, _anchorHoldoverAlignTop, replayEntry);
        return;
      }
    }
    _updateWindow();
    _scheduleSettle();
  });
}

/** True while an index awaits or undergoes queued off-DOM decode. */
function _isDecodeQueued(imgIdx) {
  if (_mountInFlight === imgIdx) return true;
  for (const e of _mountQueue) {
    if (e.imgIdx === imgIdx) return true;
  }
  return false;
}

/** Stamp, attach, and append a decoded node. The slot already carries exact
 * dims, so the node paints once at the right size in the same task. */
function _claimSlot(imgIdx, item, slot, img) {
  img.dataset.imgIdx = String(imgIdx);
  img.dataset.listIndex = String(item.listIndex);
  img.onload = _handleStripImgLoad;
  img.onerror = _handleStripImgError;
  for (const old of Array.from(slot.querySelectorAll(':scope > img'))) {
    if (old === img) continue;
    old.onload = null;
    old.onerror = null;
    old.remove();
    _releaseNode(old);
  }
  slot.appendChild(img);
  _mounted.set(imgIdx, img);
  _onSlotMounted?.(imgIdx);
}

/** Mount a node whose decode failed. Error UI plus estimated sizing.
 * The slot is sized before the node enters DOM, same as the happy path. */
function _mountFailed(imgIdx, item, slot, img) {
  // No failure UI by policy: the slot keeps its estimate and stays imageless.
  _onItemDecoded(imgIdx, item.naturalWidth || DEFAULT_ESTIMATED_WIDTH, item.naturalHeight || DEFAULT_ESTIMATED_HEIGHT);
  _claimSlot(imgIdx, item, slot, img);
}

/** Decode the next queued entry off-DOM, then mount it with known dims.
 * One at a time, in scroll order. The slot is resized first in the same
 * task as the append, so the mounted node never paints at estimated size. */
function _advanceMountQueue() {
  if (_mountInFlight !== -1) return;
  while (_mountQueue.length > 0) {
    const entry = _mountQueue.shift();
    if (!_active) break;
    if (_mounted.has(entry.imgIdx)) continue;
    const item = _imageIndex[entry.imgIdx];
    if (!item || item !== entry.item) continue;

    _mountInFlight = entry.imgIdx;
    const pre = new Image();
    pre.decoding = 'async';

    const drop = () => {
      // Only reset if this flight still owns _mountInFlight. Stale decodes
      // from a previous container must not clobber a newer flight.
      if (_mountInFlight === entry.imgIdx) _mountInFlight = -1;
      _releaseNode(pre);
      if (_mountInFlight === -1) _advanceMountQueue();
    };
    const fail = () => {
      const idx = entry.imgIdx;
      _mountInFlight = -1;
      const cur = _imageIndex[idx];
      const slot = _slots.get(idx);
      if (_active && cur && cur === entry.item && slot && !_mounted.has(idx)) {
        _mountFailed(idx, cur, slot, pre);
      } else {
        _releaseNode(pre);
      }
      _advanceMountQueue();
    };

    pre.onload = async () => {
      if (_mountInFlight !== entry.imgIdx || !_active) {
        drop();
        return;
      }
      const cur = _imageIndex[entry.imgIdx];
      if (!cur || cur !== entry.item) {
        drop();
        return;
      }
      // Rasterize off-DOM so the node paints on its first frame in the slot.
      try {
        if (typeof pre.decode === 'function') await pre.decode();
      } catch {
        // Dims below still size the slot correctly.
      }
      if (_mountInFlight !== entry.imgIdx || !_active) {
        drop();
        return;
      }
      const now = _imageIndex[entry.imgIdx];
      if (!now || now !== entry.item || _mounted.has(entry.imgIdx)) {
        drop();
        return;
      }
      if (!(pre.naturalWidth > 0)) {
        fail();
        return;
      }
      const slot = _slots.get(entry.imgIdx);
      if (!slot) {
        drop();
        return;
      }
      _mountInFlight = -1;
      _onItemDecoded(entry.imgIdx, pre.naturalWidth, pre.naturalHeight);
      _claimSlot(entry.imgIdx, now, slot, pre);
      _advanceMountQueue();
    };
    pre.onerror = () => {
      if (_mountInFlight !== entry.imgIdx) {
        drop();
        return;
      }
      fail();
    };

    const entryName = entry.item.entry.name || entry.item.entry.path || '';
    if (FsUtils.isIco(entryName)) {
      const key = _getIcoKey(entry.item.entry, entry.state);
      const cached = _icoCache.get(key);
      if (cached) {
        pre.src = cached;
      } else {
        _resolveIco(entry.item.entry, entry.state).then((icoSrc) => {
          if (_mountInFlight !== entry.imgIdx) {
            _releaseNode(pre);
            return;
          }
          if (icoSrc) {
            _icoCache.set(key, icoSrc);
            if (!_active || _mountInFlight !== entry.imgIdx) {
              _releaseNode(pre);
              _advanceMountQueue();
              return;
            }
            pre.src = icoSrc;
          } else {
            fail();
          }
        }).catch(() => {
          if (_mountInFlight !== entry.imgIdx) {
            _releaseNode(pre);
            return;
          }
          fail();
        });
      }
    } else {
      pre.src = _buildSrc(entry.item.entry, entry.state);
    }
    return;
  }
}

function _resetMountQueue() {
  _mountQueue = [];
  _mountInFlight = -1;
  if (_layoutRaf) {
    cancelAnimationFrame(_layoutRaf);
    _layoutRaf = null;
  }
}

function _scheduleSettle() {  if (_settleTimer) clearTimeout(_settleTimer);
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
  const { startIndex, endIndex } = _computeVisibleRange();
  if (_anchorHoldover !== null) {
    if (startIndex !== -1 && endIndex !== -1) {
      _anchorImgIdx = Math.max(startIndex, Math.min(endIndex, _anchorHoldover));
    }
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
  const visSig = startIndex === -1 ? '' : `${startIndex}-${endIndex}`;
  const anchorChanged = anchorItem.listIndex !== _lastSyncedListIndex;
  const visChanged = visSig !== _lastVisSig;
  _lastSyncedListIndex = anchorItem.listIndex;
  _lastVisSig = visSig;
  if (!hadHoldover && !anchorChanged && !visChanged) return;
  // Never drag Core back onto a nearby image while a video or other
  // unmapped row stays deliberately highlighted.
  const liveMapped = _listToImgIdx.has(Core.getState().index);
  if ((anchorChanged || hadHoldover) && liveMapped) {
    _anchorUpdateInProgress = true;
    Core.selectIndex(anchorItem.listIndex);
    _anchorUpdateInProgress = false;
  }
  window.dispatchEvent(new CustomEvent('quivit-manhwa-settle'));
}

/** True while the strip sits pinned at the very top. A further upward pan
 * has nowhere to go in the viewport, so callers hand it to the file list. */
export function isStripAtTop() {
  if (!_active || !_viewportState) return false;
  const scale = _viewportState.getScale() || 1;
  const colH = (_layout.totalHeight || 0) * scale;
  const vpH = _viewport?.clientHeight || 800;
  if (colH <= vpH + 0.5) return true;
  const maxTy = Math.abs(colH - vpH) / 2;
  return _viewportState.getTy() >= maxTy - 0.5;
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

/** Fit modes that latch to top or bottom when a column end is highlighted. */
const LATCH_FIT_MODES = ['none', 'width', 'width-if-larger', 'window', 'window-if-larger'];
const STRIP_TOP_ALIGN_FITS = ['width', 'width-if-larger'];

/** Height-family fits clamp to the active image on entry instead of fitting
 * the whole column. The user looks at one image when the strip opens. */
const ENTRY_ACTIVE_FITS = ['height', 'height-if-larger', 'window', 'window-if-larger'];

function _disarmEntryRefresh() {
  _entryRefreshArmed = false;
  _entryRefreshArmedAt = 0;
  _entryRefreshPending = false;
  _entryRefreshEntry = false;
}

/** Arm the one-shot entry refit after an entry fit. Timestamped after the
 * entry zoom and pan so their own view changes never trip the quiet guard.
 * Directory opens arm fresh-open semantics, toggles arm legacy replay. */
function _armEntryRefresh(entry) {
  _entryRefreshPending = false;
  _entryRefreshEntry = !!entry;
  if (!_active || !_lastFitMode || _lastFitMode === 'none') {
    _entryRefreshArmed = false;
    return;
  }
  _entryRefreshArmed = true;
  _entryRefreshArmedAt = performance.now();
}

/** Which column end is highlighted, primary or secondary. Strict: only a
 * highlight on the first or last image counts, never proximity. */
function _firstLastEdge() {
  const total = _imageIndex.length;
  if (total === 0) return 'neither';
  const rawPrimary = _listToImgIdx.get(Core.getState()?.index);
  const primary = (rawPrimary !== undefined && rawPrimary >= 0) ? rawPrimary : _anchorImgIdx;
  const { startIndex, endIndex } = _computeVisibleRange();
  return firstLastHighlight({
    primary: primary ?? -1,
    visStart: startIndex,
    visEnd: endIndex,
    total,
  });
}

/** Resolve the opening anchor. Honors open_first_image off: an index with
 * no image mapping holds no anchor (-1), leaving the drop overlay up
 * instead of forcing the first image. */
function _resolveOpenAnchor(state) {
  const mapped = _listToImgIdx.get(state.index);
  if (mapped !== undefined) return mapped;
  // A video selection stays highlight-only regardless of the setting.
  const entry = state.list?.[state.index];
  if (entry && FsUtils.isVideoEntry(entry)) return -1;
  const openFirst = state.config?.frontend_data?.open_first_image === true;
  if (openFirst && _imageIndex.length > 0) return 0;
  return -1;
}

/** One-shot anchor request from explicit navigation, honored over re-derivation. */
let _anchorHoldover = null;
let _anchorHoldoverScale = 1;
let _anchorHoldoverAlignTop = true;
/** Nonzero while this module drives the viewport itself (fit, layout).
 * Nested window updates must not read our own zoomTo/panTo/setDimensions
 * as a manual pan that clears the holdover just set. */
let _viewportProgram = 0;
/** View params the anchor was last derived from; layout-only changes keep it. */
let _lastAnchorTy = null;
let _lastAnchorScale = null;
let _lastAnchorVph = null;

function _applyFitMode(mode, targetImgIdx = null, alignTop = false, entry = false) {
  if (!_active || !_viewportState || !_viewport || _imageIndex.length === 0) return;
  _viewportProgram++;
  try {
  if (!entry) _disarmEntryRefresh();
  const fitMode = mode || Core.getState()?.fitMode || 'none';

  // Decide first/last alignment on the highlighted state, before the zoom
  // below moves the visible window.
  if (targetImgIdx === null && LATCH_FIT_MODES.includes(fitMode)) {
    const edge = _firstLastEdge();
    if (edge === 'first' && _layout.offsets[0]) {
      targetImgIdx = 0;
      alignTop = true;
    } else if (edge === 'last' && _layout.offsets[_imageIndex.length - 1]) {
      targetImgIdx = _imageIndex.length - 1;
      alignTop = false;
    }
  }

  // Entry has no meaningful visible range yet (leftover single-image view),
  // so only the primary selection counts here. Fit-key presses above use
  // the full highlight check with secondaries.
  if (entry && LATCH_FIT_MODES.includes(fitMode)) {
    const total = _imageIndex.length;
    const primary = _listToImgIdx.get(Core.getState()?.index);
    if (total > 1 && primary === 0 && _layout.offsets[0]) {
      targetImgIdx = 0;
      alignTop = true;
    } else if (total > 1 && primary === total - 1 && _layout.offsets[total - 1]) {
      targetImgIdx = total - 1;
      alignTop = false;
    }
  }

  const vw = _viewport.clientWidth || 800;
  const vh = _viewport.clientHeight || 800;

  let maxW = (_layout.widestWidth && _layout.widestWidth > 0) ? _layout.widestWidth : DEFAULT_ESTIMATED_WIDTH;
  let rawSumH = 0;
  let itemCount = _imageIndex.length;
  const anchorIdxForEntry = targetImgIdx !== null ? targetImgIdx : _anchorImgIdx;
  const activeItem = (entry && ENTRY_ACTIVE_FITS.includes(fitMode)) ? _imageIndex[anchorIdxForEntry] : null;
  if (activeItem) {
    maxW = activeItem.naturalWidth || DEFAULT_ESTIMATED_WIDTH;
    rawSumH = activeItem.naturalHeight || DEFAULT_ESTIMATED_HEIGHT;
    itemCount = 1;
  } else {
    for (let i = 0; i < _imageIndex.length; i++) {
      const item = _imageIndex[i];
      rawSumH += typeof item === 'number' ? item : ((item && (item.naturalHeight ?? item.height)) || DEFAULT_ESTIMATED_HEIGHT);
    }
  }

  const targetScale = computeStripFitScale({
    fitMode,
    vw,
    vh,
    maxW,
    rawSumH,
    itemCount,
  });

  const anchorIdx = targetImgIdx !== null ? targetImgIdx : _anchorImgIdx;
  _anchorHoldover = anchorIdx >= 0 ? anchorIdx : null;
  _anchorHoldoverScale = targetScale;
  _anchorHoldoverAlignTop = !!alignTop;
  if (targetImgIdx !== null) {
    _anchorImgIdx = targetImgIdx;
    if (_imageIndex[targetImgIdx]) {
      _anchorUpdateInProgress = true;
      Core.selectIndex(_imageIndex[targetImgIdx].listIndex);
      _anchorUpdateInProgress = false;
    }
  }

  _viewportState.zoomTo(targetScale, vw / 2, vh / 2);
  const colH = (_layout.totalHeight || 0) * targetScale;

  if (targetImgIdx !== null) {
    if (alignTop) {
      if (_layout.offsets[targetImgIdx]) {
        _topAlignColumnY(_layout.offsets[targetImgIdx].top, 0);
      } else if (colH <= vh + 0.5) {
        _lastTy = Math.abs(colH - vh) / 2;
        _lastAnchorTy = _lastTy;
        _viewportState.panTo(0, _lastTy);
      }
    } else {
      if (targetImgIdx === _imageIndex.length - 1 && _imageIndex.length > 1) {
        _bottomAlignColumnY(_layout.offsets[targetImgIdx].bottom, 0);
      } else if (colH <= vh + 0.5) {
        _lastTy = Math.abs(colH - vh) / 2;
        _lastAnchorTy = _lastTy;
        _viewportState.panTo(0, _lastTy);
      } else if (_layout.offsets[targetImgIdx]) {
        _centerColumnY(_layout.offsets[targetImgIdx].top + _layout.offsets[targetImgIdx].height / 2, 0);
      }
    }
  } else if (colH <= vh + 0.5) {
    _lastTy = Math.abs(colH - vh) / 2;
    _lastAnchorTy = _lastTy;
    _viewportState.panTo(0, _lastTy);
  } else {
    _lastTy = _viewportState.getTy();
    _lastAnchorTy = _lastTy;
    _viewportState.panTo(0, _lastTy);
  }

  _strip.style.transform = _viewportState.getTransform();
  _strip.style.setProperty('--zoom-scale', targetScale);
  _updateGrillAngles();
  _updateWindow();
  if (targetImgIdx !== null) {
    _syncAnchorToCore();
  }
  _scheduleSettle();
  } finally {
    _viewportProgram--;
  }
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
  if (mapped === _imageIndex.length - 1 && _imageIndex.length > 1) {
    const targetTy = -Math.abs(colH - vh) / 2;
    _lastTy = targetTy;
    _lastAnchorTy = targetTy;
    _viewportState.panTo(curTx, targetTy);
  } else if (colH <= vh) {
    const targetTy = Math.abs(colH - vh) / 2;
    _lastTy = targetTy;
    _lastAnchorTy = targetTy;
    _viewportState.panTo(curTx, targetTy);
  } else if (_layout.offsets[mapped]) {
    _centerColumnY(_layout.offsets[mapped].top + _layout.offsets[mapped].height / 2);
  }

  _strip.style.transform = _viewportState.getTransform();
  _updateGrillAngles();
  _updateWindow();
  _scheduleSettle();
  return true;
}

/** Zoom to exactScale while keeping the current anchor and Y position.
 * Called from Viewer.setZoom when the strip is active so reset (X) does
 * not jump to the column center. */
export function resetZoom(exactScale) {
  if (!_active || !_viewportState || !_viewport) return false;
  _viewportProgram++;
  try {
    const vw = _viewport.clientWidth || 800;
    const vh = _viewport.clientHeight || 800;

    _anchorHoldover = _anchorImgIdx >= 0 ? _anchorImgIdx : null;
    _anchorHoldoverScale = exactScale;

    _viewportState.zoomTo(exactScale, vw / 2, vh / 2);

    // Re-pin the anchor at its current offset so ty stays stable.
    if (_anchorHoldover !== null && _layout.offsets[_anchorHoldover]) {
      if (_anchorHoldoverAlignTop) {
        _topAlignColumnY(_layout.offsets[_anchorHoldover].top, 0);
      } else {
        const colH = (_layout.totalHeight || 0) * exactScale;
        if (_anchorHoldover === _imageIndex.length - 1 && _imageIndex.length > 1) {
          _bottomAlignColumnY(_layout.offsets[_anchorHoldover].bottom, 0);
        } else if (colH <= vh + 0.5) {
          _lastTy = Math.abs(colH - vh) / 2;
          _lastAnchorTy = _lastTy;
          _viewportState.panTo(0, _lastTy);
        } else {
          _centerColumnY(_layout.offsets[_anchorHoldover].top + _layout.offsets[_anchorHoldover].height / 2, 0);
        }
      }
    }

    _strip.style.transform = _viewportState.getTransform();
    _strip.style.setProperty('--zoom-scale', exactScale);
    _updateGrillAngles();
    _updateWindow();
    _scheduleSettle();
  } finally {
    _viewportProgram--;
  }
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
    if (mapped === _imageIndex.length - 1 && _imageIndex.length > 1) {
      return alignListItemBottom(state.index);
    }
    return alignListItemTop(state.index);
  }
  // Landed on an entry with no image mapping (video, folder edge):
  // highlight-only. The row paints, the overlay shows, and the strip and
  // its anchor stay exactly where they are.
  return true;
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
        // Whole column fits: paging up lands on the top, so reveal `..`
        // in the same gesture instead of asking for a second press.
        triggerRevealListTop();
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
    // Nowhere left to go upstairs: hand the gesture to the file list so
    // one more page-up reveals `..`.
    triggerRevealListTop();
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
  _anchorHoldover = null;
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
  _lastTy = targetTy;
  _lastAnchorTy = targetTy;
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
  _lastTy = targetTy;
  _lastAnchorTy = targetTy;
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
  _lastTy = targetTy;
  _lastAnchorTy = targetTy;
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

  _ensureStripSpacers();

  _anchorImgIdx = _resolveOpenAnchor(state);

  const knownW = state.naturalWidth || (_viewportState?.getNaturalW?.() || 0);
  const knownH = state.naturalHeight || (_viewportState?.getNaturalH?.() || 0);
  if (_anchorImgIdx >= 0 && _imageIndex[_anchorImgIdx] && knownW > 0 && knownH > 0) {
    const anchorItem = _imageIndex[_anchorImgIdx];
    anchorItem.naturalWidth = knownW;
    anchorItem.naturalHeight = knownH;
    anchorItem.decoded = true;
    _estWidth = knownW;
  }

  _initEstimatedDimensions();
  _updateLayout();

  _lastFitMode = state.fitMode || state.config?.frontend_data?.fit_mode || 'none';
  _lastFitModeGen = state.fitModeGen !== undefined ? state.fitModeGen : -1;
  if (_anchorImgIdx < 0) {
    // No image selection: the overlay stays up. Scale still applies so a
    // later pick aligns correctly; nothing mounts or syncs until then.
    _applyFitMode(_lastFitMode);
    return;
  }
  // Toggling the view on keeps legacy whole-column fits. Fresh-open
  // semantics belong to directory opens in _onStateChange below.
  _applyFitMode(_lastFitMode, _anchorImgIdx, STRIP_TOP_ALIGN_FITS.includes(_lastFitMode));
  _armEntryRefresh(false);

  _updateWindow();
  _scheduleSettle();
}

function _clearCaches() {
  _resetMountQueue();
  for (const [, img] of _mounted) {
    img.onload = null;
    img.onerror = null;
    img.remove();
    _releaseNode(img);
  }
  _mounted.clear();

  for (const [, img] of _prefetchedImages) {
    _releaseNode(img);
  }
  _prefetchedImages.clear();

  for (const [, pre] of _prefetching) {
    pre.onload = null;
    pre.onerror = null;
    pre.removeAttribute('src');
  }
  _prefetching.clear();
  for (const [, slot] of _slots) {
    slot.remove();
    _releaseSlotNode(slot);
  }
  _slots.clear();
  _icoCache.clear();
  if (_strip) {
    _strip.querySelectorAll('.manhwa-slot').forEach((n) => n.remove());
    _strip.style.setProperty('--strip-spacer-top', '0px');
    _strip.style.setProperty('--strip-spacer-bottom', '0px');
    _strip.style.setProperty('--strip-width', '0px');
  }
}

function _deactivate() {
  if (!_active) return;
  _resetMountQueue();
  _active = false;
  _viewport.classList.remove('manhwa-active');

  _lastTy = null;
  _lastScale = null;
  _lastFitMode = null;
  _lastFitModeGen = -1;
  _fitRefreshPending = false;
  _disarmEntryRefresh();
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

  _clearCaches();

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
    // Same-container reload (manual refresh, queue-complete refresh): keep
    // the reading position instead of reopening. Only a real container
    // switch earns a refit.
    const preserveView = !containerChanged && _anchorImgIdx >= 0;
    const holdTop = preserveView ? _layout.offsets[_anchorImgIdx]?.top || 0 : 0;
    const holdListIndex = preserveView ? _imageIndex[_anchorImgIdx]?.listIndex : undefined;
    const holdEstWidth = _estWidth;
    // Same-container reload: carried dims keep slots exact so the refresh
    // remounts without replaying the estimate staircase.
    const carryDims = !containerChanged
      ? new Map(_imageIndex.map((it) => [it.listIndex, it]))
      : null;

    _clearCaches();

    _imageIndex = isLocked ? [] : _buildImageIndex(state.list || []);
    if (carryDims) {
      for (const it of _imageIndex) {
        const old = carryDims.get(it.listIndex);
        if (old && old.decoded) {
          it.naturalWidth = old.naturalWidth;
          it.naturalHeight = old.naturalHeight;
          it.decoded = true;
        }
      }
    }
    _estWidth = preserveView ? holdEstWidth : null;
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
    if (!preserveView) {
      _lastSyncedListIndex = null;
      _lastVisSig = null;
    }
    _disarmEntryRefresh();
    _layoutScale = null;

    _ensureStripSpacers();
    _initEstimatedDimensions();
    for (const [, slot] of _slots) {
      slot.remove();
      _releaseSlotNode(slot);
    }
    _slots.clear();

    if (preserveView) {
      const remapped = holdListIndex !== undefined
        ? _imageIndex.findIndex((it) => it.listIndex === holdListIndex)
        : -1;
      if (remapped >= 0) {
        _anchorImgIdx = remapped;
        _updateLayout(remapped, holdTop);
        _lastFitMode = state.fitMode || state.config?.frontend_data?.fit_mode || 'none';
        _lastFitModeGen = state.fitModeGen !== undefined ? state.fitModeGen : -1;
        _updateWindow();
        _scheduleSettle();
        return;
      }
      // Anchor file is gone: reopen from the surviving selection below.
    }

    _updateLayout();

    _anchorImgIdx = _resolveOpenAnchor(state);

    _lastFitMode = state.fitMode || state.config?.frontend_data?.fit_mode || 'none';
    _lastFitModeGen = state.fitModeGen !== undefined ? state.fitModeGen : -1;
    if (_anchorImgIdx < 0) {
      // No image selection: the overlay stays up. Scale still applies so a
      // later pick aligns correctly; nothing mounts or syncs until then.
      _applyFitMode(_lastFitMode);
      return;
    }
    _applyFitMode(_lastFitMode, _anchorImgIdx, STRIP_TOP_ALIGN_FITS.includes(_lastFitMode), true);
    _armEntryRefresh(true);

    _updateWindow();
    _scheduleSettle();
    return;
  }

  const fitModeChanged = (state.fitMode && state.fitMode !== _lastFitMode) || (state.fitModeGen !== undefined && state.fitModeGen !== _lastFitModeGen);
  if (fitModeChanged) {
    _lastFitMode = state.fitMode;
    _lastFitModeGen = state.fitModeGen !== undefined ? state.fitModeGen : _lastFitModeGen;
    _applyFitMode(state.fitMode);
    return;
  }

  // External index change (panel click/keyboard). Top align it. Ignored
  // while a pan is in flight: async Core notifies from heartbeat selects
  // land stale mid-hold and must not yank the strip back.
  if (!_anchorUpdateInProgress && state.index >= 0 && performance.now() - _lastPanAt > 150) {
    const mapped = _listToImgIdx.get(state.index);
    if (mapped !== undefined && mapped !== _anchorImgIdx) {
      if (mapped === _imageIndex.length - 1 && _imageIndex.length > 1) {
        alignListItemBottom(state.index);
      } else {
        alignListItemTop(state.index);
      }
    }
  }
}

export function setViewportState(vpState) {
  if (!vpState || _viewportState === vpState) return;
  _viewportState = vpState;
  _viewportState.subscribe(() => {
    if (!_active || !_strip) return;
    const scale = _viewportState.getScale() || 1;
    if (_layoutScale === null || seamOverlapForScale(_layoutScale) !== seamOverlapForScale(scale)) {
      // Seam overlap depends on zoom: rebuild offsets before positioning.
      // Offsets are built unzoomed, so only a seam change needs a rebuild.
      // Ordinary pan and zoom ticks at or above 100% keep seam at 1px and
      // stay on the indexed lookup path in _updateWindow.
      _updateLayout(_anchorImgIdx, _layout.offsets[_anchorImgIdx]?.top || 0);
    }
    _strip.style.transform = _viewportState.getTransform();
    _strip.style.setProperty('--zoom-scale', scale);
    _updateGrillAngles();
    // Programmatic viewport changes (fit, reset, layout) call _updateWindow
    // explicitly after the final ty is set. Intermediate zoomTo/panTo ticks
    // inside _viewportProgram would start mount flights at a transient ty,
    // whose slots get evicted when the next tick shifts the visible range.
    if (_viewportProgram === 0) {
      // During a manhwa-off toggle, the single-image viewer rewrites the
      // shared viewport state before _deactivate runs. The massive ty delta
      // from single-image geometry would clear the holdover and re-derive
      // the anchor to center. Gate on Core state to avoid clobbering the
      // index while deactivation is pending.
      const s = Core.getState();
      const stillManhwa = !!(s.manhwaEnabled ?? s.config?.frontend_data?.manhwa_enabled);
      if (!stillManhwa) return;
      _updateWindow();
      _scheduleSettle();
    }
  });
}

/** Admit a finished download into the index without tearing down mounted
 * nodes. Decoded dims ride over by stable listIndex, kept nodes reattach
 * to rebuilt slots, and only the new image decodes fresh. */
function _admitCompleted(destPath) {
  if (!_active || !destPath || _lastMode === 'archive' || !_lastDirectory) return;
  const norm = (p) => String(p || '').replace(/\//g, '\\').toLowerCase();
  if (!norm(destPath).startsWith(norm(_lastDirectory) + '\\')) return;
  const list = _lastList || [];
  const listIndex = list.findIndex((e) => norm(e.path) === norm(destPath));
  if (listIndex === -1) return;
  if (_listToImgIdx.has(listIndex)) return;
  const entry = list[listIndex];
  if (!entry || !FsUtils.isImageEntry(entry) || FsUtils.isVideoEntry(entry) || _isPendingEntry(entry)) return;

  const oldByList = new Map();
  for (const it of _imageIndex) oldByList.set(it.listIndex, it);
  const anchorListIndex = _anchorImgIdx >= 0 ? _imageIndex[_anchorImgIdx]?.listIndex : undefined;
  // Pre-growth anchor top: the column center moves as the admitted slot
  // lands, so the rebuild must hold the anchor like a decode correction.
  const holdTop = _anchorImgIdx >= 0 ? _layout.offsets[_anchorImgIdx]?.top || 0 : 0;

  _imageIndex = _buildImageIndex(list);
  const admitted = _listToImgIdx.get(listIndex);
  if (admitted === undefined) return;

  _initEstimatedDimensions();

  for (const it of _imageIndex) {
    const old = oldByList.get(it.listIndex);
    if (old && old.decoded) {
      it.naturalWidth = old.naturalWidth;
      it.naturalHeight = old.naturalHeight;
      it.decoded = true;
    }
  }

  // Remap mounted slots to new imgIdx without replacing DOM elements
  const newSlots = new Map();
  for (const [, slot] of _slots) {
    const li = Number(slot.dataset.listIndex);
    const ni = Number.isFinite(li) ? _listToImgIdx.get(li) : undefined;
    if (ni !== undefined) {
      slot.dataset.imgIdx = String(ni);
      if (_imageIndex.length > 1) {
        slot.style.setProperty('--slot-backdrop-bg', computeSlotHue(ni, _imageIndex.length));
      }
      newSlots.set(ni, slot);
    } else {
      slot.remove();
      _releaseSlotNode(slot);
    }
  }
  _slots.clear();
  for (const [k, v] of newSlots) _slots.set(k, v);

  // Remap mounted images to new imgIdx without replacing DOM elements
  const newMounted = new Map();
  for (const [, img] of _mounted) {
    const li = Number(img.dataset.listIndex);
    const ni = Number.isFinite(li) ? _listToImgIdx.get(li) : undefined;
    if (ni !== undefined) {
      img.dataset.imgIdx = String(ni);
      newMounted.set(ni, img);
    } else {
      img.remove();
      _releaseNode(img);
    }
  }
  _mounted.clear();
  for (const [k, v] of newMounted) _mounted.set(k, v);

  // Remap prefetched images
  const newPrefetched = new Map();
  for (const [, img] of _prefetchedImages) {
    const li = Number(img.dataset?.listIndex);
    const ni = Number.isFinite(li) ? _listToImgIdx.get(li) : undefined;
    if (ni !== undefined) {
      newPrefetched.set(ni, img);
    } else {
      _releaseNode(img);
    }
  }
  _prefetchedImages.clear();
  for (const [k, v] of newPrefetched) _prefetchedImages.set(k, v);

  // Remap mount queue entries
  _mountQueue = _mountQueue.map((e) => {
    const ni = _listToImgIdx.get(e.item.listIndex);
    return ni !== undefined ? { ...e, imgIdx: ni, item: _imageIndex[ni] } : null;
  }).filter(Boolean);

  if (_mountInFlight !== -1) {
    const inFlightItem = _imageIndex[_mountInFlight];
    if (inFlightItem) {
      const ni = _listToImgIdx.get(inFlightItem.listIndex);
      _mountInFlight = ni !== undefined ? ni : -1;
    }
  }

  if (anchorListIndex !== undefined) {
    const remapped = _imageIndex.findIndex((it) => it.listIndex === anchorListIndex);
    _anchorImgIdx = remapped;
  }

  // Preserve the user's zoom and position exactly: no re-fit on admit, and
  // the rebuild holds the anchor against the column growth the same way a
  // decode correction does. Without the hold, admitted pages above shove
  // everything below, which reads as a position reset mid-chapter.
  _updateLayout(_anchorImgIdx >= 0 ? _anchorImgIdx : null, holdTop);
  _updateWindow();
  _scheduleSettle();

  // The completed row itself was selected while pending: jump to it now.
  if (Core.getState().index === listIndex) {
    alignListItemTop(listIndex);
  }
}

export function initManhwaStrip(viewportState) {
  if (viewportState) setViewportState(viewportState);
  _viewport = document.getElementById('viewport');
  _strip = document.getElementById('manhwa-strip');
  if (!_viewport || !_strip) return;
  _ensureStripSpacers();

  if (_initialized) return;
  _initialized = true;

  Core.onStateChange(_onStateChange);

  window.addEventListener('quivit-download-complete', (e) => {
    _admitCompleted(e.detail?.destPath);
  });

  const ro = new ResizeObserver(() => {
    if (!_active || !_viewportState) return;
    const scale = _viewportState.getScale() || 1;
    if (_layoutScale === null || seamOverlapForScale(_layoutScale) !== seamOverlapForScale(scale)) {
      _updateLayout(_anchorImgIdx, _layout.offsets[_anchorImgIdx]?.top || 0);
    }
    _applyFitMode(Core.getState()?.fitMode || _lastFitMode, _anchorImgIdx, _anchorHoldoverAlignTop);
  });
  ro.observe(_viewport);
}

export function isManhwaStripActive() {
  return _active;
}

let _onRevealListTop = null;
export function setRevealListTop(fn) {
  _onRevealListTop = fn;
}


export function triggerRevealListTop() {
  _onRevealListTop?.();
}

let _onSlotMounted = null;
export function setOnSlotMounted(fn) {
  _onSlotMounted = fn;
}
