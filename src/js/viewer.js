/**
 * viewer.js — QuiviT
 *
 * Viewport rendering: fit-to-screen, zoom, and pan, over a sliding DOM image
 * pool of .viewer-img nodes inside #viewer-img-wrapper.
 * Communicates with core.js via state callbacks.
 */

import { Core } from './core.js';
import { FsUtils } from './fsUtils.js';
import { activeKeys, MOUSE_BUTTON_NAMES } from './shortcuts.js';
import { DEFAULT_FIT_MODE, DEFAULT_SCALING_MODE } from './keybinds.js';

const POOL_HALF = 7;
const _activeNodes = new Map();
const _freeNodes = [];

const POOL_SIZE = POOL_HALF * 2 + 1; // 15

const imgWrapper = document.getElementById('viewer-img-wrapper');
if (imgWrapper) {
  const oldImg = document.getElementById('viewer-img');
  if (oldImg) oldImg.remove();
  
  const existingNodes = document.querySelectorAll('.viewer-img');
  existingNodes.forEach(el => _freeNodes.push(el));
  
  for (let i = existingNodes.length; i < POOL_SIZE; i++) {
    const el = document.createElement('img');
    el.className = 'viewer-img';
    el.draggable = false;
    el.decoding = 'async';
    el.style.display = 'none';
    imgWrapper.appendChild(el);
    _freeNodes.push(el);
  }
}

function _getPoolNode(src) {
  let el = _activeNodes.get(src);
  if (el) return el;
  if (_freeNodes.length > 0) {
    el = _freeNodes.pop();
  } else {
    // Fallback if pool is exhausted (should not happen since window size <= POOL_SIZE)
    el = document.createElement('img');
    el.className = 'viewer-img';
    el.draggable = false;
    el.decoding = 'async';
    imgWrapper.appendChild(el);
  }
  el.alt = '';
  el.style.display = 'none';
  el.src = src;
  _activeNodes.set(src, el);
  return el;
}

function _recyclePoolNode(src) {
  const el = _activeNodes.get(src);
  if (el) {
    el.style.display = 'none';
    el.removeAttribute('src');
    el.removeAttribute('data-decoded');
    if (el === _loadingEl) stopLoadingAltAnimation();
    _activeNodes.delete(src);
    _freeNodes.push(el);
    FsUtils.revokeIfObjectURL(src);
  }
}

// Title/alt text shown on the <img> element while a slow image is fetching.
// With no previous image on screen the node is displayed immediately, so the
// browser's default broken-image placeholder renders alongside the animated
// "Loading..." attribute text; once decoded, _activatePoolNode replaces it.
const LOADING_LABELS = ['Loading.', 'Loading..', 'Loading...'];

function _setElementLoadingLabel(el, label) {
  el.alt = label;
  el.title = label;
}

let img = null;
const imgGrill = document.getElementById('img-grill');
const grillBorder = document.getElementById('img-grill-border');
const statusZoom = document.querySelector('.status-zoom');
const statusDims = document.querySelector('.status-dims');
const statusName = document.querySelector('.status-filename');
const statusIndex = document.querySelector('.status-index');

let _scale  = 1;
let _tx     = 0;
let _ty     = 0;
let _naturalW = 0;
let _naturalH = 0;
let _rafPending = false;
let _currentFitMode = DEFAULT_FIT_MODE;
let _rotation = 0;
let _flipX = 1;
let _flipY = 1;
let _scaling = DEFAULT_SCALING_MODE;

function _applyScaling() {
  if (!img) return;
  img.dataset.scaling = _scaling;
  img.style.imageRendering = _scaling === 'none' ? 'pixelated' : 'auto';
}

function _visualSize() {
  const quarterTurns = Math.abs(Math.round(_rotation / 90)) % 2;
  const baseW = quarterTurns ? _naturalH : _naturalW;
  const baseH = quarterTurns ? _naturalW : _naturalH;
  return {
    width: baseW * _scale,
    height: baseH * _scale,
  };
}

function _clampPan() {
  if (!_naturalW || !_naturalH) {
    _tx = 0;
    _ty = 0;
    return;
  }

  const vp = document.getElementById('viewport');
  const { width, height } = _visualSize();
  const maxX = Math.abs(width - vp.clientWidth) / 2;
  const maxY = Math.abs(height - vp.clientHeight) / 2;

  _tx = maxX === 0 ? 0 : Math.min(maxX, Math.max(-maxX, _tx));
  _ty = maxY === 0 ? 0 : Math.min(maxY, Math.max(-maxY, _ty));
}

function _applyTransform() {
  _clampPan();
  const transform = `translate(calc(-50% + ${_tx}px), calc(-50% + ${_ty}px)) rotate(${_rotation}deg) scale(${_flipX * _scale}, ${_flipY * _scale})`;
  
  if (imgWrapper) {
    imgWrapper.style.transform = transform;
    // Pass the zoom scale down to CSS so the grill and border can counter-scale
    // their subpixel dimensions natively without needing manual JS positioning.
    imgWrapper.style.setProperty('--zoom-scale', _scale);
  }
  
  if (statusZoom) statusZoom.textContent = `${Math.round(_scale * 100)}%`;
}

function _scheduleTransform() {
  if (_rafPending) return;
  _rafPending = true;
  requestAnimationFrame(() => {
    _rafPending = false;
    _applyTransform();
  });
}

/**
 * Apply the current fit mode.
 */
function applyFitMode() {
  const vp = document.getElementById('viewport');
  const vw = vp.clientWidth;
  const vh = vp.clientHeight;
  
  // For SVGs with percentage-based dimensions (e.g. width="100%"), naturalWidth/Height is 0.
  // In that case img.clientWidth reflects the current layout size; dividing by the
  // previous _scale recovers the true intrinsic size so _visualSize() and _clampPan()
  // compute correct bounds.  Fall back to viewport size if scale is 0 or client dims unknown.
  if (img && img.naturalWidth > 0) {
    _naturalW = img.naturalWidth;
    _naturalH = img.naturalHeight;
  } else if (img) {
    const prevScale = _scale || 1;
    _naturalW = img.clientWidth  ? img.clientWidth  / prevScale : vw;
    _naturalH = img.clientHeight ? img.clientHeight / prevScale : vh;
  }

  if (!_naturalW || !_naturalH) return;

  const padding = 0;

  const scaleX = (vw - padding * 2) / _naturalW;
  const scaleY = (vh - padding * 2) / _naturalH;

  switch (_currentFitMode) {
    case 'none':
      _scale = 1;
      break;
    case 'width':
      _scale = scaleX;
      break;
    case 'height':
      _scale = scaleY;
      break;
    case 'window':
      _scale = Math.min(scaleX, scaleY);
      break;
    case 'width-if-larger':
      _scale = Math.min(scaleX, 1);
      break;
    case 'height-if-larger':
      _scale = Math.min(scaleY, 1);
      break;
    case 'window-if-larger':
    default:
      _scale = Math.min(scaleX, scaleY, 1);
      break;
  }

  // When fit mode is 'none', preserve the user's manual pan position across
  // resizes and only re-clamp to the new viewport bounds. Other fit modes reset
  // the pan to their default alignment (top-aligned or centered).
  if (_currentFitMode !== 'none') {
    _tx = 0;
    if (['width', 'width-if-larger'].includes(_currentFitMode)) {
      // Top-aligned modes: pin the image's top edge to the viewport top so tall
      // pages start at the top and you scroll down. Images that fit vertically
      // stay centered. The offset matches _clampPan()'s maxY bound exactly.
      const { height } = _visualSize();
      _ty = height > vh ? (height - vh) / 2 : 0;
    } else {
      _ty = 0;
    }
  }
  _scheduleTransform();
}

// --- Zoom ---------------------------------------------------------------------

const ZOOM_STEP   = 0.12;
const ZOOM_MIN    = 0.05;
const ZOOM_MAX    = 32;

function zoomTo(exactScale, cx, cy) {
  const prevScale = _scale;
  const targetScale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, exactScale));
  _scale = targetScale;

  const vp = document.getElementById('viewport');
  const rect = vp.getBoundingClientRect();
  const vw = rect.width;
  const vh = rect.height;

  // Local pointer pos within viewport
  const lx = cx - rect.left;
  const ly = cy - rect.top;

  const ratio = _scale / prevScale;
  const wx = (lx - vw / 2 - _tx);
  const wy = (ly - vh / 2 - _ty);

  _tx += wx - wx * ratio;
  _ty += wy - wy * ratio;

  _scheduleTransform();
}

function zoomAt(delta, cx, cy) {
  // We intentionally do not set fit mode to 'none' here so that window
  // resizes can fallback to recalculating the previously active fit.
  zoomTo(_scale * (1 + delta * ZOOM_STEP), cx, cy);
}

function zoomCenter(delta) {
  const vp = document.getElementById('viewport');
  const rect = vp.getBoundingClientRect();
  zoomAt(delta, rect.left + rect.width / 2, rect.top + rect.height / 2);
}

function rotate(deltaDegrees) {
  _rotation = (_rotation + deltaDegrees) % 360;
  _clampPan();
  _scheduleTransform();
}

function flipHorizontal() {
  _flipX *= -1;
  _scheduleTransform();
}

function flipVertical() {
  _flipY *= -1;
  _scheduleTransform();
}

// --- Pan -----------------------------------------------------------------------

let _isPanning = false;
let _panStartX = 0;
let _panStartY = 0;
let _panOriginTx = 0;
let _panOriginTy = 0;
const _panButtonsDown = new Set();

const PAN_BUTTONS = Object.fromEntries(
  Object.entries(MOUSE_BUTTON_NAMES).map(([num, name]) => [name.toLowerCase(), Number(num)])
);

const _panMouseButtons = new Set([0, 1]); // MouseLeft, MouseMiddle
const _panKeyboardKeys = new Set([' ']); // Space

function _updatePanKeysCache() {
  const binds = Core.getState().config?.frontend_data?.keybinds || {};
  let keys = binds['cmd-pan-drag'];
  if (!Array.isArray(keys)) {
    keys = typeof keys === 'string' ? [keys] : ['MouseLeft', 'MouseMiddle', 'Space'];
  }
  
  _panMouseButtons.clear();
  _panKeyboardKeys.clear();
  
  for (const key of keys) {
    const token = String(key).trim().toLowerCase();
    const btnId = PAN_BUTTONS[token];
    if (btnId !== undefined) {
      _panMouseButtons.add(btnId);
    } else {
      _panKeyboardKeys.add(token === 'space' ? ' ' : token);
    }
  }
}
window.addEventListener('quivit-config-loaded', _updatePanKeysCache);

function _keyPanHeld(exceptKey) {
  for (const held of _panKeyboardKeys) {
    if (held !== exceptKey && activeKeys.has(held)) return true;
  }
  return false;
}

function _isMousePanKey(e) {
  return _panMouseButtons.has(e.button);
}

function _panActive() {
  return _panButtonsDown.size > 0 || _keyPanHeld(null);
}

function _startPan(clientX, clientY) {
  _isPanning = true;
  _panStartX = clientX;
  _panStartY = clientY;
  _panOriginTx = _tx;
  _panOriginTy = _ty;
  document.body.style.cursor = 'move';
  if (_keyPanHeld(null)) _startCursorPoll();
}

function _stopPan() {
  _isPanning = false;
  _panButtonsDown.clear();
  _stopCursorPoll();
  document.body.style.cursor = '';
}

// Keyboard grab-pan: mousemove events stop at the window edge because there is
// no mouse button pressed (so no implicit pointer capture). While a keyboard
// pan key is held we poll the OS cursor position via Tauri instead, which keeps
// tracking outside the window exactly like a mouse-button drag does.
let _cursorPolling = false;
let _cursorPollTimer = null;
let _cursorPollInFlight = false;
let _winClientOriginX = 0;
let _winClientOriginY = 0;
let _winScaleFactor = 1;
let _unlistenWinMove = null;

function _cursorToClient(pos) {
  return {
    x: (pos.x - _winClientOriginX) / _winScaleFactor,
    y: (pos.y - _winClientOriginY) / _winScaleFactor,
  };
}

async function _startCursorPoll() {
  if (_cursorPolling || !window.__TAURI__?.window) return;
  _cursorPolling = true;
  const win = window.__TAURI__.window.getCurrentWindow();
  try {
    const [origin, scale] = await Promise.all([win.innerPosition(), win.scaleFactor()]);
    if (!_cursorPolling) return;
    _winClientOriginX = origin.x;
    _winClientOriginY = origin.y;
    _winScaleFactor = scale;
    _unlistenWinMove = await win.onMoved(async () => {
      try {
        const origin = await win.innerPosition();
        _winClientOriginX = origin.x;
        _winClientOriginY = origin.y;
      } catch {}
    });
  } catch {
    _cursorPolling = false;
    return;
  }
  if (!_cursorPolling) {
    if (_unlistenWinMove) {
      _unlistenWinMove();
      _unlistenWinMove = null;
    }
    return;
  }
  _cursorPollTimer = setInterval(_pollCursor, 16);
}

function _stopCursorPoll() {
  _cursorPolling = false;
  if (_cursorPollTimer) {
    clearInterval(_cursorPollTimer);
    _cursorPollTimer = null;
  }
  if (_unlistenWinMove) {
    _unlistenWinMove();
    _unlistenWinMove = null;
  }
}

async function _pollCursor() {
  if (!_cursorPolling || _cursorPollInFlight) return;
  _cursorPollInFlight = true;
  try {
    const pos = await window.__TAURI__.window.cursorPosition();
    const { x, y } = _cursorToClient(pos);
    _updatePan(x, y);
  } catch {}
  _cursorPollInFlight = false;
}

function _updatePan(clientX, clientY) {
  if (!_isPanning) return;
  _tx = _panOriginTx + (clientX - _panStartX);
  _ty = _panOriginTy + (clientY - _panStartY);
  _clampPan();
  _scheduleTransform();
}

function _onMouseDown(e) {
  const isPanKey = _isMousePanKey(e) || (e.button === 0 && _keyPanHeld(null));
  if (!isPanKey) return;
  e.preventDefault();
  if (_isMousePanKey(e)) _panButtonsDown.add(e.button);
  _startPan(e.clientX, e.clientY);
}

function _onMouseMove(e) {
  if (!_panActive()) {
    if (_isPanning) _stopPan();
    return;
  }
  if (!_isPanning) {
    if (_panButtonsDown.size === 0 && e.target.closest?.('#file-panel, .menubar, .dropdown-menu, #statusbar')) return;
    _startPan(e.clientX, e.clientY);
  }
  _updatePan(e.clientX, e.clientY);
}

function _onMouseUp(e) {
  _panButtonsDown.delete(e.button);
  if (_isPanning && !_panActive()) _stopPan();
}

window.addEventListener('keyup', (e) => {
  const released = e.key.toLowerCase();
  if (_isPanning && _panButtonsDown.size === 0 && !_keyPanHeld(released)) _stopPan();
});

// Losing focus while a keyboard pan key is held must end the grab; otherwise
// the OS-cursor poll would keep panning from wherever the pointer happens to be.
window.addEventListener('blur', () => {
  if (_isPanning && _panButtonsDown.size === 0) _stopPan();
});

function panBy(dx, dy) {
  _tx += dx;
  _ty += dy;
  _clampPan();
  _scheduleTransform();
}

function setScaling(mode) {
  _scaling = mode;
  _applyScaling();
}

// --- Image load ---------------------------------------------------------------

/**
 * Activate a pool node: hide the old active img, show the new one,
 * read its dimensions, and refit.
 */
function _activatePoolNode(el, filename, state) {
  stopLoadingAltAnimation();
  if (img && img !== el) {
    img.style.display = 'none';
  }

  img = el;
  img.style.display = 'block';
  img.alt = filename || '';
  img.title = filename || '';
  _applyScaling();

  _rotation = 0;
  _flipX = 1;
  _flipY = 1;

  if (img.naturalWidth > 0) {
    _naturalW = img.naturalWidth;
    _naturalH = img.naturalHeight;
    if (statusDims) statusDims.textContent = `${_naturalW} × ${_naturalH}`;
    applyFitMode();
  }

  if (statusName) statusName.textContent = filename || '';
  if (statusIndex) statusIndex.textContent = FsUtils.formatStatusIndex(state);
}

// Attach a load handler to every pool node so we pick up dimensions
// when the active image finishes decoding.
function _attachLoadHandler(el) {
  el.addEventListener('load', () => {
    if (el !== img) return; // Only process if this is the active image
    if (!el.src) return; // Placeholder node shown without a resource
    if (el.naturalWidth > 0) {
      _naturalW = el.naturalWidth;
      _naturalH = el.naturalHeight;
    } else {
      _scale = 1;
      _naturalW = el.clientWidth  || 1000;
      _naturalH = el.clientHeight || 1000;
    }
    _applyScaling();
    if (statusDims) statusDims.textContent = `${_naturalW} × ${_naturalH}`;
    applyFitMode();
  });
}

// --- State subscription -------------------------------------------------------

let _loadingAltTimer = null;
let _loadingEl = null;

function stopLoadingAltAnimation() {
  if (_loadingAltTimer) {
    clearInterval(_loadingAltTimer);
    _loadingAltTimer = null;
  }
  _loadingEl = null;
}

// Animate the "Loading..." text on the given element. In the legacy viewer a
// single img alternated its alt text while prefetching, so the browser's
// default 404/broken-image placeholder showed the animation; the pool keeps
// that behavior but only when there is no previous image to hold meanwhile.
function startLoadingAltAnimation(el) {
  stopLoadingAltAnimation();
  if (!el) return;
  _loadingEl = el;
  let frame = 0;
  _setElementLoadingLabel(el, LOADING_LABELS[frame]);
  _loadingAltTimer = setInterval(() => {
    if (!_loadingEl) return;
    frame = (frame + 1) % LOADING_LABELS.length;
    _setElementLoadingLabel(_loadingEl, LOADING_LABELS[frame]);
  }, 320);
}

function clearDisplayedImage() {
  stopLoadingAltAnimation();
  _naturalW = 0;
  _naturalH = 0;

  for (const src of _activeNodes.keys()) {
    _recyclePoolNode(src);
  }
  img = null;
}

Core.onStateChange((state) => {
  if (state.mode === 'empty') {
    clearDisplayedImage();
    return;
  }

  if (!state.src) {
    clearDisplayedImage();
    return;
  }

  const listLen = state.list ? state.list.length : 0;
  if (listLen === 0) return;

  const startIndex = Math.max(0, state.index - POOL_HALF);
  const endIndex = Math.min(listLen - 1, state.index + POOL_HALF);

  const desiredSrcs = new Set();
  
  // ── Build the sliding window ──
  for (let i = startIndex; i <= endIndex; i++) {
    const entry = state.list[i];
    if (!entry || entry.is_dir || entry.is_parent || !FsUtils.isImageEntry(entry)) continue;

    let src;
    if (state.mode === 'archive') {
      src = FsUtils.buildArchiveSrc(state.archivePath, entry.name);
    } else {
      src = entry.path.toLowerCase().endsWith('.ico') ? null : FsUtils.buildFileSrcSync(entry.path);
    }
    
    if (i === state.index) src = state.src;
    if (src) desiredSrcs.add(src);
  }

  // Always include the current active img to prevent recycling it while transitioning
  if (img && img.src) desiredSrcs.add(img.src);

  // ── Prune out-of-bounds nodes ──
  for (const src of _activeNodes.keys()) {
    if (!desiredSrcs.has(src)) _recyclePoolNode(src);
  }

  // ── Ensure nodes exist for all desired srcs ──
  for (const src of desiredSrcs) {
    const el = _getPoolNode(src);
    if (!el._quivitLoadAttached) {
      _attachLoadHandler(el);
      el._quivitLoadAttached = true;
    }
    if (el.decode) el.decode().catch(() => {});
  }

  // ── Activate the current image ──
  const activeEl = _activeNodes.get(state.src);
  if (activeEl && activeEl !== img) {
    if (statusName) statusName.textContent = 'Loading...';

    // First display (nothing on screen yet): show the node in the legacy
    // loading state — no src, animated "Loading..." alt/title text — while
    // the image is fetched through a hidden preloader; the real src is
    // attached only when it has decoded. When a previous image is on screen
    // we hold it instead — no loading feedback is needed there.
    if (!img) {
      img = activeEl;
      img.style.display = 'block';
      img.removeAttribute('src');
      startLoadingAltAnimation(activeEl);

      const preloader = new Image();
      preloader.onload = () => {
        if (Core.getState().src !== state.src) return;
        stopLoadingAltAnimation();
        img.src = state.src;
        _activatePoolNode(activeEl, state.filename, state);
      };
      preloader.onerror = () => {
        if (Core.getState().src !== state.src) return;
        stopLoadingAltAnimation();
        img.src = state.src; // keep the (unresolvable) src: browser shows the 404 frame + alt
        _activatePoolNode(activeEl, state.filename ? `Failed to load ${state.filename}` : 'Failed to load image', state);
        if (statusDims) statusDims.textContent = 'Error';
        if (statusZoom) statusZoom.textContent = 'N/A';
      };
      preloader.src = state.src;
    } else {
      activeEl.decode().then(() => {
        if (Core.getState().src === activeEl.src) {
          _activatePoolNode(activeEl, state.filename, state);
        }
      }).catch(() => {
        if (Core.getState().src === activeEl.src) {
          _activatePoolNode(activeEl, state.filename ? `Failed to load ${state.filename}` : 'Failed to load image', state);
          if (statusDims) statusDims.textContent = 'Error';
          if (statusZoom) statusZoom.textContent = 'N/A';
        }
      });
    }
  }

  if (_currentFitMode !== state.fitMode) {
    _currentFitMode = state.fitMode;
    applyFitMode();
  }
});

// --- Event listeners ----------------------------------------------------------

window.addEventListener('resize', applyFitMode);

const viewport = document.getElementById('viewport');
viewport.addEventListener('mousedown', _onMouseDown);
window.addEventListener('mousemove', _onMouseMove);
window.addEventListener('mouseup', _onMouseUp);

// Right-button pan: suppress the context menu so right-drag pans.
viewport.addEventListener('contextmenu', (e) => {
  if (_panMouseButtons.has(2)) e.preventDefault();
});

// Double-click is now a keybind gesture (cmd-fit-none default = DoubleClick),
// dispatched through shortcuts.js, so there is no hardcoded handler here.

export const Viewer = { 
  applyFitMode, 
  zoomAt,
  zoomCenter,
  panBy,
  rotate,
  flipHorizontal,
  flipVertical,
  setScaling,
  setZoom(exactScale) {
    // Zoom to the exact scale anchored on the viewport center so the content
    // currently under the middle of the screen stays there (no recenter jump).
    const vp = document.getElementById('viewport');
    const rect = vp.getBoundingClientRect();
    zoomTo(exactScale, rect.left + rect.width / 2, rect.top + rect.height / 2);
    _currentFitMode = 'none';
  }
};
