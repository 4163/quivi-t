/**
 * viewer.js — QuiviT
 *
 * Viewport rendering: fit-to-screen, zoom, and pan.
 * Communicates with core.js via state callbacks.
 * All DOM writes are confined to the #viewport and #viewer-img elements.
 *
 * Zoom is applied as a CSS transform on the <img> element.
 * Pan offsets are tracked internally and combined in a single rAF loop.
 */

import { Core } from './core.js';

// --- DOM refs -----------------------------------------------------------------
const img = document.getElementById('viewer-img');
const statusZoom = document.getElementById('status-zoom');

// --- Transform state ----------------------------------------------------------
let _scale  = 1;
let _tx     = 0;  // translate X offset in px
let _ty     = 0;  // translate Y offset in px

let _naturalW = 0;
let _naturalH = 0;

let _rafPending = false;

// --- Helpers ------------------------------------------------------------------

function _applyTransform() {
  img.style.transform =
    `translate(calc(-50% + ${_tx}px), calc(-50% + ${_ty}px)) scale(${_scale})`;
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
 * Scale the image to fit the viewport, with a small padding.
 * Called whenever a new image loads or the window resizes.
 */
function fitToScreen() {
  if (!_naturalW || !_naturalH) return;

  const vw = window.innerWidth;
  const vh = window.innerHeight - (document.body.classList.contains('has-image') ? 32 : 0);

  const padding = 32;
  const scaleX = (vw - padding * 2) / _naturalW;
  const scaleY = (vh - padding * 2) / _naturalH;

  _scale = Math.min(scaleX, scaleY, 1); // never upscale beyond 1x by default
  _tx = 0;
  _ty = 0;

  _scheduleTransform();
}

// --- Zoom --------------------------------------------------------------------- 

const ZOOM_STEP   = 0.12;
const ZOOM_MIN    = 0.05;
const ZOOM_MAX    = 32;

/**
 * Zoom toward a screen-space focal point (e.g. cursor position).
 * @param {number} delta  positive = zoom in, negative = zoom out
 * @param {number} cx     focal X in viewport px
 * @param {number} cy     focal Y in viewport px
 */
function zoomAt(delta, cx, cy) {
  const prevScale = _scale;
  const factor = 1 + delta * ZOOM_STEP;
  _scale = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, _scale * factor));

  // Shift translation so the pixel under the cursor stays fixed
  const ratio = _scale / prevScale;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  // World-space coords of cursor before zoom
  const wx = (cx - vw / 2 - _tx);
  const wy = (cy - vh / 2 - _ty);

  _tx += wx - wx * ratio;
  _ty += wy - wy * ratio;

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
  _scheduleTransform();
}

function _onMouseUp() {
  if (!_isPanning) return;
  _isPanning = false;
  document.body.style.cursor = '';
}

// --- Wheel -------------------------------------------------------------------- 

function _onWheel(e) {
  e.preventDefault();
  const delta = e.deltaY < 0 ? 1 : -1;
  zoomAt(delta, e.clientX, e.clientY);
}

// --- Image load --------------------------------------------------------------- 

img.addEventListener('load', () => {
  _naturalW = img.naturalWidth;
  _naturalH = img.naturalHeight;

  // Pixel-art mode for very small images
  img.style.imageRendering = (_naturalW <= 64 || _naturalH <= 64) ? 'pixelated' : 'auto';

  fitToScreen();
});

// --- State subscription ------------------------------------------------------- 

Core.onStateChange((state) => {
  if (state.mode === 'empty') return;

  img.src = state.src;
  img.alt = state.filename;
});

// --- Event listeners ---------------------------------------------------------- 

window.addEventListener('resize', fitToScreen);

const viewport = document.getElementById('viewport');
viewport.addEventListener('mousedown', _onMouseDown);
window.addEventListener('mousemove', _onMouseMove);
window.addEventListener('mouseup', _onMouseUp);
viewport.addEventListener('wheel', _onWheel, { passive: false });

// Double-click to reset to fit-to-screen
viewport.addEventListener('dblclick', () => {
  _tx = 0;
  _ty = 0;
  fitToScreen();
});

// --- Public API (consumed by main.js) ----------------------------------------

export const Viewer = { fitToScreen, zoomAt };
