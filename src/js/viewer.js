/**
 * viewer.js — QuiviT
 *
 * Viewport rendering: fit-to-screen, zoom, and pan.
 * Communicates with core.js via state callbacks.
 * All DOM writes are confined to the #viewport and #viewer-img elements.
 */

import { Core } from './core.js';
import { DEFAULT_FIT_MODE, DEFAULT_SCALING_MODE } from './keybinds.js';

const img = document.getElementById('viewer-img');
const statusZoom = document.getElementById('status-zoom');
const statusDims = document.getElementById('status-dims');

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
  img.style.transform = `translate(calc(-50% + ${_tx}px), calc(-50% + ${_ty}px)) rotate(${_rotation}deg) scale(${_flipX * _scale}, ${_flipY * _scale})`;
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
  if (!_naturalW || !_naturalH) return;

  const vp = document.getElementById('viewport');
  const vw = vp.clientWidth;
  const vh = vp.clientHeight;
  const padding = 0; // The screenshot didn't seem to have much padding, but we can adjust later.

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
  _ty = 0;
  _scheduleTransform();
}

// --- Zoom ---------------------------------------------------------------------

const ZOOM_STEP   = 0.12;
const ZOOM_MIN    = 0.05;
const ZOOM_MAX    = 32;

function zoomAt(delta, cx, cy) {
  const prevScale = _scale;
  const factor = 1 + delta * ZOOM_STEP;
  _scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, _scale * factor));

  // Switch to custom zoom (cancels fit mode)
  if (_scale !== prevScale) {
    Core.setFitMode('none');
  }

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

function _onWheel(e) {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 1 : -1;
  zoomAt(delta, e.clientX, e.clientY);
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
  _naturalW = img.naturalWidth;
  _naturalH = img.naturalHeight;
  _applyScaling();
  
  if (statusDims) statusDims.textContent = `${_naturalW} × ${_naturalH}`;
  applyFitMode();
});

// --- State subscription -------------------------------------------------------

Core.onStateChange((state) => {
  if (state.mode === 'empty') return;

  if (img.src !== state.src) {
    img.src = state.src;
    img.alt = state.filename;
    _rotation = 0;
    _flipX = 1;
    _flipY = 1;
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
viewport.addEventListener('wheel', _onWheel, { passive: false });

viewport.addEventListener('dblclick', () => {
  // Toggle between 100% and current fit mode, or just reset fit mode
  if (_currentFitMode === 'none') {
    Core.setFitMode(DEFAULT_FIT_MODE); // Reset to default without changing the saved preference.
  } else {
    Core.setFitMode('none');
    _scale = 1;
    _tx = 0;
    _ty = 0;
    _scheduleTransform();
  }
});

export const Viewer = { 
  applyFitMode, 
  zoomCenter,
  panBy,
  rotate,
  flipHorizontal,
  flipVertical,
  setScaling,
  setZoom(exactScale) {
    _scale = exactScale;
    _tx = 0;
    _ty = 0;
    Core.setFitMode('none');
    _scheduleTransform();
  }
};
