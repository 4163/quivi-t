import { Core } from '../core.js';
import { FsUtils } from '../fsUtils.js';
import { Statusbar } from '../menubar/statusbar.js';

const PRELOAD_HALF = 7;
const TARGET_LOAD_DEBOUNCE_MS = 45;
const LOADING_LABEL = 'Loading...';

export function createViewerRenderer(viewportState) {
  const _activeNodes = new Map();
  const _freeNodes = [];
  const POOL_SIZE = 2; 

  const imgWrapper = document.getElementById('viewer-img-wrapper');
  if (imgWrapper) {
    const oldImg = document.getElementById('viewer-img');
    if (oldImg) oldImg.remove();
    const existingNodes = Array.from(document.querySelectorAll('.viewer-img'));
    existingNodes.slice(POOL_SIZE).forEach(el => el.remove());
    existingNodes.slice(0, POOL_SIZE).forEach(el => {
      el.classList.remove('active');
      _freeNodes.push(el);
    });
    for (let i = _freeNodes.length; i < POOL_SIZE; i++) {
      const el = document.createElement('img');
      el.className = 'viewer-img';
      el.draggable = false;
      el.decoding = 'async';
      el.style.display = 'none';
      imgWrapper.appendChild(el);
      _freeNodes.push(el);
    }
  }

  let img = null;
  let _rafPending = false;
  let _poolGeneration = 0;
  let _activationGeneration = 0;
  let _targetLoadTimer = null;
  const _preloadTimers = [];
  const _preloadImages = [];
  let _lastFitModeGen = -1;
  let _inStateChange = false;

  function _applyTransform() {
    if (imgWrapper) {
      imgWrapper.style.transform = viewportState.getTransform();
      imgWrapper.style.setProperty('--zoom-scale', viewportState.getScale());
    }
    // Only report zoom when an image is actually active — prevents the
    // "100%" flash on startup before any image is displayed.
    if (img && img.src) {
      Statusbar.setZoom(viewportState.getScale());
    }
  }

  function _scheduleTransform() {
    if (_rafPending) return;
    _rafPending = true;
    requestAnimationFrame(() => {
      _rafPending = false;
      _applyTransform();
    });
  }

  viewportState.subscribe(() => {
    _applyScaling();
    _scheduleTransform();
  });

  function _applyScaling() {
    if (!img) return;
    const scaling = viewportState.getScaling();
    img.dataset.scaling = scaling;
    img.style.imageRendering = scaling === 'none' ? 'pixelated' : 'auto';
  }

  function _attachLoadHandler(el) {
    el.addEventListener('load', () => {
      if (el !== img) return;
      if (!el.src) return;
      const state = Core.getState();
      
      let natW, natH;
      if (el.naturalWidth > 0) {
        natW = el.naturalWidth;
        natH = el.naturalHeight;
      } else {
        natW = el.clientWidth || 1000;
        natH = el.clientHeight || 1000;
      }
      el.classList.add('active');
      _applyScaling();
      
      if (!_inStateChange) Core.setState({ decodedSrc: state.src });
      Statusbar.setImage({ filename: state.filename || '', dims: `${natW} × ${natH}`, zoom: viewportState.getScale() });
      
      viewportState.applyFitMode(state.fitMode, natW, natH, el.clientWidth, el.clientHeight);
    });
  }

  function _getPoolNode(src) {
    let el = _activeNodes.get(src);
    if (el) return el;
    if (_freeNodes.length > 0) {
      el = _freeNodes.pop();
    } else {
      el = document.createElement('img');
      el.className = 'viewer-img';
      el.draggable = false;
      el.decoding = 'async';
      imgWrapper.appendChild(el);
    }
    el.alt = '';
    el.style.display = 'none';
    el.dataset.poolSrc = src;
    el.removeAttribute('src');
    _activeNodes.set(src, el);
    
    if (!el.hasAttribute('data-load-attached')) {
      el.setAttribute('data-load-attached', 'true');
      _attachLoadHandler(el);
    }
    return el;
  }

  function _recyclePoolNode(src) {
    const el = _activeNodes.get(src);
    if (el) {
      el.style.display = 'none';
      el.removeAttribute('src');
      el.removeAttribute('data-pool-src');
      el.classList.remove('active');
      if (el === img) img = null;
      _activeNodes.delete(src);
      _freeNodes.push(el);
      FsUtils.revokeIfObjectURL(src);
      while (_freeNodes.length > POOL_SIZE) _freeNodes.pop()?.remove();
    }
  }

  function _loadPoolNode(el, src) {
    if (!el || !src) return;
    el.dataset.poolSrc = src;
    if (el.getAttribute('src') === src || el.src === src) return;
    el.src = src;
  }

  function _isVisibleImage(el) {
    return !!(el && el.src && el.style.display !== 'none');
  }

  function _activatePoolNode(el, filename, state) {
    if (img && img !== el) {
      img.style.display = 'none';
      img.classList.remove('active');
    }
    img = el;
    img.style.display = 'block';
    img.classList.add('active');
    img.alt = filename || '';
    img.title = filename || '';
    
    if (!_inStateChange) Core.setState({ decodedSrc: state.src });
    _applyScaling();
    viewportState.resetGeometry();

    if (img.naturalWidth > 0) {
      Statusbar.setImage({ filename: filename || '', dims: `${img.naturalWidth} × ${img.naturalHeight}`, zoom: viewportState.getScale() });
      viewportState.applyFitMode(state.fitMode, img.naturalWidth, img.naturalHeight, img.clientWidth, img.clientHeight);
    } else {
      Statusbar.setImage({ filename: filename || '' });
    }
  }

  function _clearTargetLoadTimer() {
    if (_targetLoadTimer) clearTimeout(_targetLoadTimer);
    _targetLoadTimer = null;
  }

  function _clearScheduledPreloads() {
    while (_preloadTimers.length > 0) clearTimeout(_preloadTimers.pop());
    while (_preloadImages.length > 0) {
      const p = _preloadImages.pop();
      p.onload = null;
      p.onerror = null;
      p.removeAttribute('src');
    }
  }

  function _schedulePoolPreloads(srcs, generation) {
    _clearScheduledPreloads();
    srcs.forEach((src, index) => {
      const timer = setTimeout(() => {
        if (generation !== _poolGeneration) return;
        const preloader = new Image();
        preloader.decoding = 'async';
        _preloadImages.push(preloader);
        preloader.onload = () => {
          const idx = _preloadImages.indexOf(preloader);
          if (idx !== -1) _preloadImages.splice(idx, 1);
        };
        preloader.onerror = preloader.onload;
        preloader.src = src;
        if (preloader.decode) preloader.decode().catch(() => {});
      }, 100 + index * 45);
      _preloadTimers.push(timer);
    });
  }

  function clearDisplayedImage() {
    _poolGeneration += 1;
    _activationGeneration += 1;
    _clearTargetLoadTimer();
    _clearScheduledPreloads();
    for (const src of _activeNodes.keys()) _recyclePoolNode(src);
    img = null;
  }

  Core.onStateChange((state) => {
    if (_inStateChange) return;
    _inStateChange = true;
    const generation = ++_poolGeneration;
    _activationGeneration += 1;
    _clearTargetLoadTimer();
    _clearScheduledPreloads();

    if (state.mode === 'empty' || !state.src || !state.list || state.list.length === 0) {
      clearDisplayedImage();
      _inStateChange = false;
      return;
    }

    const desiredSrcs = new Set([state.src]);
    if (_isVisibleImage(img)) desiredSrcs.add(img.src);

    const neighborSrcs = FsUtils.neighborEntries(state, state.index, PRELOAD_HALF);

    for (const src of _activeNodes.keys()) {
      if (!desiredSrcs.has(src)) _recyclePoolNode(src);
    }

    for (const src of desiredSrcs) {
      _getPoolNode(src);
    }

    const activeEl = _activeNodes.get(state.src);
    const activeChanged = activeEl && activeEl !== img;
    const hasPreviousBridge = !!(img && img !== activeEl && _isVisibleImage(img));

    if (activeChanged) {
      const activation = _activationGeneration;
      Statusbar.setImage({ isLoading: true });
      if (activeEl) activeEl.alt = LOADING_LABEL;

      if (!hasPreviousBridge) {
        if (img && img !== activeEl) {
          img.style.display = 'none';
          img.classList.remove('active');
        }
        if (activeEl) {
          img = activeEl;
          img.style.display = 'block';
          img.classList.add('active');
        }
      }

      const loadTarget = () => {
        if (activation !== _activationGeneration || Core.getState().src !== state.src) return;
        _targetLoadTimer = null;
        if (activeEl) _loadPoolNode(activeEl, state.src);

        const ready = activeEl && activeEl.complete && (activeEl.naturalWidth > 0 || state.src.toLowerCase().endsWith('.svg'));
        const decodePromise = (ready || !activeEl || !activeEl.decode) ? Promise.resolve() : activeEl.decode();
        
        decodePromise.then(() => {
          if (activation !== _activationGeneration || Core.getState().src !== state.src) return;
          if (activeEl) _activatePoolNode(activeEl, state.filename, state);
          _schedulePoolPreloads(neighborSrcs, generation);
        }).catch(() => {
          if (activation !== _activationGeneration || Core.getState().src !== state.src) return;
          if (activeEl) _activatePoolNode(activeEl, state.filename ? `Failed to load ${state.filename}` : 'Failed to load image', state);
          Statusbar.setImage({ isError: true });
          _schedulePoolPreloads(neighborSrcs, generation);
        });
      };

      if (hasPreviousBridge) {
        _targetLoadTimer = setTimeout(loadTarget, TARGET_LOAD_DEBOUNCE_MS);
      } else {
        loadTarget();
      }
    } else {
      _schedulePoolPreloads(neighborSrcs, generation);
    }

    if (_lastFitModeGen !== state.fitModeGen) {
      _lastFitModeGen = state.fitModeGen;
      if (img) viewportState.applyFitMode(state.fitMode, img.naturalWidth, img.naturalHeight, img.clientWidth, img.clientHeight);
    }
    _inStateChange = false;
  });

  window.addEventListener('resize', () => {
    if (img) viewportState.applyFitMode(undefined, img.naturalWidth, img.naturalHeight, img.clientWidth, img.clientHeight);
  });
}
