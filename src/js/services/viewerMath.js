import { DEFAULT_FIT_MODE } from '../keybinds.js';

export function checkIsSpread(w, h) {
  if (!w || !h) return false;
  return (w / h) >= 1.2;
}

export function createViewportState({ getViewport }) {
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

    _tx = maxX === 0 ? 0 : Math.min(maxX, Math.max(-maxX, _tx));
    _ty = maxY === 0 ? 0 : Math.min(maxY, Math.max(-maxY, _ty));
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
    _userTransformed = true;
    _tx = tx;
    _ty = ty;
    _clampPan();
    notify();
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

  return {
    subscribe: (fn) => listeners.push(fn),
    getTransform: () => `translate(calc(-50% + ${_tx}px), calc(-50% + ${_ty}px)) rotate(${_rotation}deg) scale(${_flipX * _scale}, ${_flipY * _scale})`,
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
