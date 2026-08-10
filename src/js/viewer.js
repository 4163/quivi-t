/**
 * viewer.js — QuiviT
 *
 * Viewport rendering: fit-to-screen, zoom, and pan.
 * Communicates with core.js via state callbacks.
 * All DOM writes are confined to the #viewport and #viewer-img elements.
 */

import { Core } from './core.js';
import { FsUtils } from './fsUtils.js';
import { DEFAULT_FIT_MODE, DEFAULT_SCALING_MODE } from './keybinds.js';

const img = document.getElementById('viewer-img');
const imgWrapper = document.getElementById('viewer-img-wrapper');
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
  if (img.naturalWidth > 0) {
    _naturalW = img.naturalWidth;
    _naturalH = img.naturalHeight;
  } else {
    const prevScale = _scale || 1;
    _naturalW = img.clientWidth  ? img.clientWidth  / prevScale : vw;
    _naturalH = img.clientHeight ? img.clientHeight / prevScale : vh;
  }

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

  _tx = 0;
  if (['none', 'width', 'width-if-larger'].includes(_currentFitMode)) {
    // Top-aligned modes: pin the image's top edge to the viewport top so tall
    // pages start at the top and you scroll down. Images that fit vertically
    // stay centered. The offset matches _clampPan()'s maxY bound exactly.
    const { height } = _visualSize();
    _ty = height > vh ? (height - vh) / 2 : 0;
  } else {
    _ty = 0;
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

function _onMouseDown(e) {
  if (e.button !== 0) return;
  _isPanning = true;
  _panStartX = e.clientX;
  _panStartY = e.clientY;
  _panOriginTx = _tx;
  _panOriginTy = _ty;
  document.body.style.cursor = 'grabbing';
}

function _onMouseMove(e) {
  if (!_isPanning) return;
  _tx = _panOriginTx + (e.clientX - _panStartX);
  _ty = _panOriginTy + (e.clientY - _panStartY);
  _clampPan();
  _scheduleTransform();
}

function _onMouseUp() {
  if (!_isPanning) return;
  _isPanning = false;
  document.body.style.cursor = '';
}

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

img.addEventListener('load', () => {
  if (img.naturalWidth > 0) {
    _naturalW = img.naturalWidth;
    _naturalH = img.naturalHeight;
  } else {
    // SVG with percentage dimensions — reset scale to 1 first so clientWidth
    // equals the intrinsic size, then applyFitMode will compute the correct scale.
    _scale = 1;
    _naturalW = img.clientWidth  || 1000;
    _naturalH = img.clientHeight || 1000;
  }
  _applyScaling();
  
  if (statusDims) statusDims.textContent = `${_naturalW} × ${_naturalH}`;
  applyFitMode();
});

// --- State subscription -------------------------------------------------------

let _currentPreloadSrc = null;
let _loadingAltTimer = null;

function stopLoadingAltAnimation() {
  if (_loadingAltTimer) {
    clearInterval(_loadingAltTimer);
    _loadingAltTimer = null;
  }
}

function startLoadingAltAnimation() {
  stopLoadingAltAnimation();
  let frame = 0;
  const labels = ['Loading.', 'Loading..', 'Loading...'];
  img.alt = labels[frame];
  _loadingAltTimer = setInterval(() => {
    frame = (frame + 1) % labels.length;
    img.alt = labels[frame];
  }, 320);
}

function clearDisplayedImage() {
  stopLoadingAltAnimation();
  _currentPreloadSrc = null;
  _naturalW = 0;
  _naturalH = 0;
  img.removeAttribute('src');
  img.alt = '';
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

  // Seamless loading: show the previous image until the new one is ready.
  // This effectively acts as the "spinner" and eliminates flickering.
  if (img.src !== state.src && _currentPreloadSrc !== state.src) {
    _currentPreloadSrc = state.src;
    
    // Show loading state in statusbar while the image is being fetched
    startLoadingAltAnimation();
    if (statusName) statusName.textContent = 'Loading...';
    if (statusDims) statusDims.textContent = 'Loading...';
    if (statusZoom) statusZoom.textContent = 'Loading...';

    const preloader = new Image();
    preloader.onload = () => {
      if (_currentPreloadSrc === state.src) {
        stopLoadingAltAnimation();
        img.src = state.src;
        img.alt = state.filename;
        _rotation = 0;
        _flipX = 1;
        _flipY = 1;
        // Restore filename and index now that the image is ready
        if (statusName) statusName.textContent = state.filename;
        if (statusIndex) statusIndex.textContent = FsUtils.formatStatusIndex(state);
      }
    };
    preloader.onerror = () => {
      if (_currentPreloadSrc === state.src) {
        stopLoadingAltAnimation();
        img.src = state.src; // Fallback so main img shows error state
        img.alt = state.filename ? `Failed to load ${state.filename}` : 'Failed to load image';
        if (statusName) statusName.textContent = state.filename;
        if (statusDims) statusDims.textContent = 'Error';
        if (statusZoom) statusZoom.textContent = 'N/A';
        if (statusIndex) statusIndex.textContent = FsUtils.formatStatusIndex(state);
      }
    };
    preloader.src = state.src;
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
