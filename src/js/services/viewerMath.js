import { DEFAULT_FIT_MODE } from '../keybinds.js';
export { computeSlotHue } from './keybindDomain.js';

export function checkIsSpread(w, h) {
  if (!w || !h) return false;
  return (w / h) >= 1.2;
}

/**
 * Map a fit mode to a CSS width for the manhwa strip.
 * Width-based and window modes fill the viewport width.
 * 'none' returns null (natural width, no CSS override).
 * The zoom factor scales the result.
 */
export function computeStripWidth(fitMode, viewportWidth, zoom = 1) {
  if (!viewportWidth || viewportWidth <= 0) return null;
  switch (fitMode) {
    case 'none':
      return null;
    case 'width':
    case 'width-if-larger':
    case 'height':
    case 'height-if-larger':
    case 'window':
    case 'window-if-larger':
    default:
      return viewportWidth * zoom;
  }
}

/**
 * Compute column layout and per-item offsets from natural dimensions.
 * Column width fits the widest known item times zoom.
 * Per-item offsets derive from heights at that width.
 * seamOverlapPx subtracts the CSS inter-slot overlap per boundary so the
 * offsets match rendered positions (each slot after the first shifts up).
 */
export function computeColumnOffsets(items = [], zoom = 1, seamOverlapPx = 0) {
  if (!Array.isArray(items)) {
    return { widestWidth: 0, columnWidth: 0, totalHeight: 0, offsets: [] };
  }

  const seam = Math.max(0, seamOverlapPx);
  let widestWidth = 0;
  const offsets = [];
  let currentTop = 0;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    const w = typeof item === 'number' ? 0 : ((item && (item.naturalWidth ?? item.width)) || 0);
    if (w > widestWidth) widestWidth = w;
    const rawH = typeof item === 'number' ? item : ((item && (item.naturalHeight ?? item.height)) || 0);
    const h = rawH * zoom;
    const top = currentTop - i * seam;
    offsets.push({
      top,
      height: h,
      bottom: top + h,
    });
    currentTop += h;
  }

  const columnWidth = widestWidth * zoom;

  return {
    widestWidth,
    columnWidth,
    totalHeight: items.length > 0 ? currentTop - (items.length - 1) * seam : 0,
    offsets,
  };
}

export const computeColumnLayout = computeColumnOffsets;

/**
 * Inter-slot overlap in unzoomed px for a given zoom scale.
 * Mirrors the strip CSS rule `margin-top: min(-1px, calc(-1px / zoom))`:
 * one layout px at or above 100%, growing below so the visual overlap
 * stays one screen px. Offsets must use this or pins drift on zoom-out.
 */
export function seamOverlapForScale(scale) {
  const s = scale || 1;
  return s >= 1 ? 1 : 1 / s;
}

/**
 * Find index of item containing centerColY.
 * Clamps to 0 or last index when outside bounds.
 */
export function findAnchorIndex(offsets, centerColY) {
  if (!Array.isArray(offsets) || offsets.length === 0) return -1;
  if (centerColY <= offsets[0].top) return 0;
  const last = offsets.length - 1;
  if (centerColY >= offsets[last].bottom) return last;

  let lo = 0;
  let hi = last;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const item = offsets[mid];
    const visualBottom = (mid < last) ? offsets[mid + 1].top : item.bottom;
    if (centerColY < item.top) {
      hi = mid - 1;
    } else if (centerColY >= visualBottom) {
      lo = mid + 1;
    } else {
      return mid;
    }
  }
  return Math.max(0, Math.min(last, lo));
}

/**
 * Compute index range [startIndex, endIndex] of items overlapping [windowTopY, windowBottomY].
 * Uses visual slot boundaries so seam-overlapped preceding slots do not leak into the active range.
 * Returns { startIndex: -1, endIndex: -1 } when no items overlap.
 */
export function computeWindowRange(offsets, windowTopY, windowBottomY) {
  if (!Array.isArray(offsets) || offsets.length === 0) {
    return { startIndex: -1, endIndex: -1 };
  }
  const n = offsets.length;
  const lastBottom = offsets[n - 1].bottom;
  if (windowBottomY <= offsets[0].top || windowTopY >= lastBottom) {
    return { startIndex: -1, endIndex: -1 };
  }

  const EPSILON = 1e-4;
  const visualBottomAt = (i) => (i < n - 1 ? offsets[i + 1].top : offsets[i].bottom);

  let lo = 0;
  let hi = n - 1;
  let startIndex = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (visualBottomAt(mid) - windowTopY > EPSILON) {
      startIndex = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  if (startIndex === -1) {
    return { startIndex: -1, endIndex: -1 };
  }

  lo = startIndex;
  hi = n - 1;
  let firstBeyond = n;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (offsets[mid].top >= windowBottomY - EPSILON) {
      firstBeyond = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  const endIndex = firstBeyond - 1;
  if (endIndex < startIndex) {
    return { startIndex: -1, endIndex: -1 };
  }

  return { startIndex, endIndex };
}

/**
 * Compute the vertical pan (ty) so that a slot top lands at the viewport top.
 * When the column is shorter than the viewport, pins to the top of the column.
 * When the column is taller, clamps between the top pin and bottom pin.
 */
export function computeTopAlignTy({ slotTop = 0, totalHeight = 0, scale = 1, viewportHeight = 800 } = {}) {
  const colVisualH = totalHeight * scale;
  if (colVisualH <= viewportHeight) {
    return -(colVisualH - viewportHeight) / 2;
  }
  const maxTy = (colVisualH - viewportHeight) / 2;
  const minTy = -maxTy;
  const rawTy = (totalHeight / 2 - slotTop) * scale - viewportHeight / 2;
  return Math.max(minTy, Math.min(maxTy, rawTy));
}

/**
 * Compute the vertical pan (ty) so that a slot bottom lands at the viewport bottom.
 * When the column is shorter than the viewport, moves up towards viewport top.
 * When the column is taller, clamps between the top pin and bottom pin.
 */
export function computeBottomAlignTy({ slotBottom = 0, totalHeight = 0, scale = 1, viewportHeight = 800 } = {}) {
  const colVisualH = totalHeight * scale;
  if (colVisualH <= viewportHeight) {
    return (colVisualH - viewportHeight) / 2;
  }
  const maxTy = (colVisualH - viewportHeight) / 2;
  const minTy = -maxTy;
  const rawTy = (totalHeight / 2 - slotBottom) * scale + viewportHeight / 2;
  return Math.max(minTy, Math.min(maxTy, rawTy));
}

export function createViewportState({ getViewport = () => ({ clientWidth: 1000, clientHeight: 800, left: 0, top: 0 }) } = {}) {
  let _scale = 1;
  let _tx = 0;
  let _ty = 0;
  let _naturalW = 0;
  let _naturalH = 0;
  let _rotation = 0;
  let _flipX = 1;
  let _flipY = 1;
  let _currentFitMode = DEFAULT_FIT_MODE;
  let _spreadEnabled = false;
  let _spreadDirection = 'rtl';
  let _spreadStep = 1;
  let _userTransformed = false;
  let _prevVw = 0;
  let _prevVh = 0;

  const listeners = [];
  function notify() { listeners.forEach(fn => fn()); }

  function _visualSize() {
    const quarterTurns = Math.abs(Math.round(_rotation / 90)) % 2;
    const baseW = quarterTurns ? _naturalH : _naturalW;
    const baseH = quarterTurns ? _naturalW : _naturalH;
    return {
      width: baseW * _scale,
      height: baseH * _scale,
    };
  }

  function isSpreadActive() {
    return _spreadEnabled && checkIsSpread(_naturalW, _naturalH) && ['width', 'width-if-larger'].includes(_currentFitMode);
  }

  function _clampPan() {
    if (!_naturalW || !_naturalH) {
      _tx = 0;
      _ty = 0;
      return;
    }
    const vp = getViewport();
    const { width, height } = _visualSize();
    const maxX = Math.abs(width - vp.clientWidth) / 2;
    const maxY = Math.abs(height - vp.clientHeight) / 2;
    const minY = -maxY;

    _tx = maxX === 0 ? 0 : Math.min(maxX, Math.max(-maxX, _tx));
    _ty = maxY === 0 ? 0 : Math.min(maxY, Math.max(minY, _ty));
  }

  function applyFitMode(mode, naturalW, naturalH, clientW, clientH) {
    _userTransformed = false;
    if (mode !== undefined) _currentFitMode = mode;
    if (naturalW !== undefined) {
      _naturalW = naturalW;
      _naturalH = naturalH;
    }

    const vp = getViewport();
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    _prevVw = vw;
    _prevVh = vh;
    
    if (!_naturalW || !_naturalH) {
      const prevScale = _scale || 1;
      _naturalW = clientW ? clientW / prevScale : vw;
      _naturalH = clientH ? clientH / prevScale : vh;
    }
    if (!_naturalW || !_naturalH) return;

    const padding = 0;
    const isSpread = isSpreadActive();
    const effectiveW = isSpread ? (_naturalW / 2) : _naturalW;
    const scaleX = (vw - padding * 2) / effectiveW;
    const scaleY = (vh - padding * 2) / _naturalH;

    switch (_currentFitMode) {
      case 'none': _scale = 1; break;
      case 'width': _scale = scaleX; break;
      case 'height': _scale = scaleY; break;
      case 'window': _scale = Math.min(scaleX, scaleY); break;
      case 'width-if-larger': _scale = Math.min(scaleX, 1); break;
      case 'height-if-larger': _scale = Math.min(scaleY, 1); break;
      case 'window-if-larger':
      default: _scale = Math.min(scaleX, scaleY, 1); break;
    }

    if (_currentFitMode !== 'none') {
      if (['width', 'width-if-larger'].includes(_currentFitMode)) {
        const { width, height } = _visualSize();
        _ty = height > vh ? (height - vh) / 2 : 0;
        if (isSpread && width > vw) {
          const maxX = (width - vw) / 2;
          if (_spreadDirection === 'rtl') {
            _tx = _spreadStep === 1 ? -maxX : maxX;
          } else {
            _tx = _spreadStep === 1 ? maxX : -maxX;
          }
        } else {
          _tx = 0;
        }
      } else {
        _tx = 0;
        _ty = 0;
      }
    }
    _clampPan();
    notify();
  }

  function handleViewportResize(newVw, newVh) {
    if (!_naturalW || !_naturalH) return;
    if (!_prevVw || !_prevVh) {
      _prevVw = newVw;
      _prevVh = newVh;
      return;
    }

    if (!_userTransformed) {
      applyFitMode(undefined, _naturalW, _naturalH);
    } else {
      _clampPan();
      notify();
    }
    _prevVw = newVw;
    _prevVh = newVh;
  }

  function zoomTo(exactScale, cx, cy) {
    _userTransformed = true;
    const prevScale = _scale;
    const targetScale = Math.min(32, Math.max(0.05, exactScale));
    _scale = targetScale;

    const vp = getViewport();
    const vw = vp.clientWidth;
    const vh = vp.clientHeight;
    const lx = cx - vp.left;
    const ly = cy - vp.top;

    const ratio = _scale / prevScale;
    const wx = (lx - vw / 2 - _tx);
    const wy = (ly - vh / 2 - _ty);

    _tx += wx - wx * ratio;
    _ty += wy - wy * ratio;
    
    _clampPan();
    notify();
  }

  function zoomAt(delta, cx, cy) {
    zoomTo(_scale * (1 + delta * 0.12), cx, cy);
  }

  function panBy(dx, dy) {
    _userTransformed = true;
    _tx += dx;
    _ty += dy;
    _clampPan();
    notify();
  }

  function panTo(tx, ty) {
    const prevTransformed = _userTransformed;
    _userTransformed = true;
    const prevTx = _tx;
    const prevTy = _ty;
    _tx = tx;
    _ty = ty;
    _clampPan();
    if (!prevTransformed || _tx !== prevTx || _ty !== prevTy) {
      notify();
    }
  }

  function rotate(deltaDegrees) {
    _rotation = (_rotation + deltaDegrees) % 360;
    _clampPan();
    notify();
  }

  function flip(axis) {
    if (axis === 'x') _flipX *= -1;
    if (axis === 'y') _flipY *= -1;
    notify();
  }
  
  function resetGeometry() {
    _userTransformed = false;
    _scale = 1;
    _tx = 0;
    _ty = 0;
    _rotation = 0;
    _flipX = 1;
    _flipY = 1;
    _spreadStep = 1;
  }

  function setSpreadEnabled(enabled) {
    _spreadEnabled = !!enabled;
  }

  function getSpreadEnabled() {
    return _spreadEnabled;
  }

  function setSpreadDirection(direction) {
    _spreadDirection = direction === 'ltr' ? 'ltr' : 'rtl';
  }

  function getSpreadDirection() {
    return _spreadDirection;
  }

  function setSpreadMode(mode) {
    if (mode === 'off') {
      _spreadEnabled = false;
    } else {
      _spreadEnabled = true;
      _spreadDirection = mode === 'ltr' ? 'ltr' : 'rtl';
    }
  }

  function getSpreadMode() {
    return _spreadEnabled ? _spreadDirection : 'off';
  }

  function setSpreadStep(step) {
    _spreadStep = step === 2 ? 2 : 1;
    _userTransformed = false;
    if (isSpreadActive()) {
      const vp = getViewport();
      const vw = vp.clientWidth;
      const vh = vp.clientHeight;
      const { width, height } = _visualSize();
      if (width > vw) {
        const maxX = (width - vw) / 2;
        if (_spreadDirection === 'rtl') {
          _tx = _spreadStep === 1 ? -maxX : maxX;
        } else {
          _tx = _spreadStep === 1 ? maxX : -maxX;
        }
      } else {
        _tx = 0;
      }
      _ty = height > vh ? (height - vh) / 2 : 0;
      _clampPan();
      notify();
    }
  }

  function getSpreadStep() {
    return _spreadStep;
  }

  function getGrillAngle() {
    const isRot90or270 = Math.abs(Math.round(_rotation / 90)) % 2 === 1;
    const isFlipX = _flipX === -1;
    const isFlipY = _flipY === -1;
    const inverted = (isRot90or270 !== (isFlipX !== isFlipY));
    return inverted ? '45deg' : '-45deg';
  }

  function setDimensions(naturalW, naturalH, nextTx, nextTy) {
    if (naturalW !== undefined) _naturalW = naturalW;
    if (naturalH !== undefined) _naturalH = naturalH;
    if (nextTx !== undefined) _tx = nextTx;
    if (nextTy !== undefined) _ty = nextTy;
    _clampPan();
    notify();
  }

  return {
    subscribe: (fn) => listeners.push(fn),
    getTransform: () => `translate(calc(-50% + ${_tx}px), calc(-50% + ${_ty}px)) rotate(${_rotation}deg) scale(${_flipX * _scale}, ${_flipY * _scale})`,
    getGrillAngle,
    getScale: () => _scale,
    getTx: () => _tx,
    getTy: () => _ty,
    getRotation: () => _rotation,
    getFlipX: () => _flipX,
    getFlipY: () => _flipY,
    getGeometry: () => ({
      scale: _scale,
      tx: _tx,
      ty: _ty,
      rotation: _rotation,
      flipX: _flipX,
      flipY: _flipY,
      viewport: getViewport()
    }),
    getNaturalW: () => _naturalW,
    getNaturalH: () => _naturalH,
    getUserTransformed: () => _userTransformed,
    handleViewportResize,
    resetGeometry,
    applyFitMode,
    setDimensions,
    zoomTo,
    zoomAt,
    panBy,
    panTo,
    rotate,
    flip,
    setSpreadEnabled,
    getSpreadEnabled,
    setSpreadDirection,
    getSpreadDirection,
    setSpreadMode,
    getSpreadMode,
    setSpreadStep,
    getSpreadStep,
    isSpreadActive,
  };
}

export function getEffectiveScaling(scalingMode, isAnimated, isSvg = false) {
  if (isSvg && scalingMode === 'lanczos') return 'bilinear';
  return scalingMode;
}

export function invertViewport(px, py, geom, naturalW, naturalH) {
  const { scale, tx, ty, rotation, flipX, flipY } = geom;
  const rad = -(rotation || 0) * (Math.PI / 180);
  const cosR = Math.cos(rad);
  const sinR = Math.sin(rad);

  const rx = px - tx;
  const ry = py - ty;
  const sx = rx * cosR - ry * sinR;
  const sy = rx * sinR + ry * cosR;
  const lx = (sx / scale) * (flipX || 1);
  const ly = (sy / scale) * (flipY || 1);
  
  return {
    x: lx + (naturalW / 2),
    y: ly + (naturalH / 2)
  };
}

/**
 * Compute the zoom scale for a given fit mode in manhwa strip view.
 * Accounts for CSS inter-slot seam overlaps (which expand to 1/scale at zoom < 1)
 * so height and window fit modes match the viewport without bottom gaps.
 */
export function computeStripFitScale({
  fitMode = 'none',
  vw = 800,
  vh = 800,
  maxW = 1000,
  rawSumH = 0,
  itemCount = 0,
}) {
  const numSeams = Math.max(0, itemCount - 1);
  const scaleX = maxW > 0 ? vw / maxW : 1;

  let scaleY = 1;
  if (rawSumH > 0) {
    if (rawSumH - numSeams <= vh) {
      scaleY = (rawSumH - numSeams > 0) ? (vh / (rawSumH - numSeams)) : 1;
    } else {
      scaleY = (vh + numSeams) / rawSumH;
    }
  }

  let targetScale = 1;
  switch (fitMode) {
    case 'none':
      targetScale = 1;
      break;
    case 'width':
      targetScale = scaleX;
      break;
    case 'width-if-larger':
      targetScale = Math.min(scaleX, 1);
      break;
    case 'height':
      targetScale = scaleY;
      break;
    case 'height-if-larger':
      targetScale = Math.min(scaleY, 1);
      break;
    case 'window':
      targetScale = Math.min(scaleX, scaleY);
      break;
    case 'window-if-larger':
    default:
      targetScale = Math.min(scaleX, scaleY, 1);
      break;
  }

  return Math.min(32, Math.max(0.05, targetScale));
}

