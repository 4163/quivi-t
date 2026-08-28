import { Core } from '../core.js';
import { FsUtils } from '../fsUtils.js';
import { Statusbar } from '../menubar/statusbar.js';
import { getEffectiveScaling } from '../services/viewerMath.js';
import { createScalingPipeline } from '../services/scalingPipeline.js';
import { createWebglPipeline } from '../services/webglPipeline.js';
import { activeFilterId } from '../services/registry.js';

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
    const existingNodes = Array.from(document.querySelectorAll('.viewer-img:not(.is-placeholder)'));
    existingNodes.slice(POOL_SIZE).forEach(el => el.remove());
    existingNodes.slice(0, POOL_SIZE).forEach(el => {
      el.classList.remove('active');
      _freeNodes.push(el);
    });
    for (let i = _freeNodes.length; i < POOL_SIZE; i++) {
      const el = document.createElement('img');
      el.className = 'viewer-img';
      el.draggable = false;
      el.crossOrigin = 'anonymous';
      el.decoding = 'async';
      imgWrapper.appendChild(el);
      _freeNodes.push(el);
    }
  }

  let img = null;
  let _rafPending = false;
  let _renderGeneration = 0;
  let _poolGeneration = 0;
  let _activationGeneration = 0;
  let _targetLoadTimer = null;
  const _preloadTimers = [];
  const _preloadImages = [];
  let _lastFitModeGen = -1;

  let pipeline = null;
  let _lastScalingMode = viewportState.getScaling();
  let _lastActiveFilter = _resolveActiveFilter(Core.getState());
  let _lastIsAnimated = Core.getState()?.isAnimated;
  const lanczosCanvas = document.getElementById('viewer-lanczos-canvas');
  const crtCanvas = document.getElementById('viewer-crt-canvas');
  const filterCanvas = document.getElementById('viewer-anime4k-canvas');
  let _renderTimeout = null;

  function _resolveActiveFilter(state) {
    if (!state || !!state.isAnimated) return null;
    const fd = state.config?.frontend_data;
    if (!fd) return null;
    return activeFilterId(fd);
  }

  Core.onStateChange((state) => {
    const newFilter = _resolveActiveFilter(state);
    const newIsAnimated = !!state.isAnimated;
    
    if (newFilter !== _lastActiveFilter || newIsAnimated !== _lastIsAnimated) {
      const willBridge = !!(_isVisibleImage(img) && state.src && img && img.src !== state.src);
      if (willBridge) return;
      _cancelRender();
      _applyScaling(newFilter, newIsAnimated);
      _lastActiveFilter = newFilter;
      _lastIsAnimated = newIsAnimated;
      _scheduleTransform();
      _triggerRender();
    }
  });

  function _cancelRender() {
    _renderGeneration++;
    if (pipeline && pipeline.type !== 'webgl') pipeline.cancel();
    if (_renderTimeout) clearTimeout(_renderTimeout);
    _renderTimeout = null;
    if (lanczosCanvas) {
      lanczosCanvas.removeAttribute('data-render-ready');
      const ctx = lanczosCanvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, lanczosCanvas.width, lanczosCanvas.height);
      lanczosCanvas.width = 0;
      lanczosCanvas.height = 0;
      lanczosCanvas.style.removeProperty('--crop-left');
      lanczosCanvas.style.removeProperty('--crop-top');
      lanczosCanvas.style.removeProperty('--crop-w');
      lanczosCanvas.style.removeProperty('--crop-h');
    }
  }

  function _applyTransform() {
    if (imgWrapper) {
      imgWrapper.style.transform = viewportState.getTransform();
      imgWrapper.style.setProperty('--zoom-scale', viewportState.getScale());
    }
    // Only report zoom when an image is active. This prevents the
    // "100%" flash on startup before any image is displayed.
    if (img && img.src) {
      Statusbar.setZoom(viewportState.getScale());
      
      // WebGL filters render every frame continuously during pan/zoom
      if (pipeline && pipeline.type === 'webgl' && !_lastIsAnimated && !Core.getState()?.isAnimated) {
        if (!img.complete || img.naturalWidth <= 0 || img.naturalHeight <= 0) return;
        const geom = viewportState.getGeometry();
        const gen = _renderGeneration;
        pipeline.render(img, geom).then((ok) => {
          if (gen !== _renderGeneration) return;
          if (ok) {
            const canvas = pipeline.filter === 'crt' ? crtCanvas : filterCanvas;
            if (canvas) canvas.setAttribute('data-render-ready', 'true');
          }
        });
      }
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

  function _triggerRender() {
    const live = Core.getState();
    const liveAnimated = !!live?.isAnimated;
    let scaling = viewportState.getScaling();
    if (liveAnimated && scaling === 'lanczos') scaling = 'bilinear';
    
    const activeFilter = _resolveActiveFilter(live);
    const usesWebgl = activeFilter !== null;
    const usesLanczos = scaling === 'lanczos' && !usesWebgl;
    
    if ((usesLanczos || activeFilter === 'crt') && img) {
      const gen = _renderGeneration;
      _renderTimeout = setTimeout(async () => {
        if (gen !== _renderGeneration) return;
        if (!img || !img.src || !pipeline) return;
        const live = Core.getState();
        const liveFilter = _resolveActiveFilter(live);
        const liveAnimated = !!live?.isAnimated;
        const liveUsesWebgl = liveFilter !== null;
        const liveUsesLanczos = viewportState.getScaling() === 'lanczos' && !liveUsesWebgl && !liveAnimated;
        const liveCrt = pipeline.type === 'webgl' && pipeline.filter === 'crt';
        
        if (!liveUsesLanczos && !liveCrt) return;
        const geom = viewportState.getGeometry();
        
        if (liveCrt && crtCanvas) {
          const res = await pipeline.render(img, geom);
          if (gen !== _renderGeneration) return;
          if (res) crtCanvas.setAttribute('data-render-ready', 'true');
        } else if (liveUsesLanczos && lanczosCanvas) {
          const res = await pipeline.render(img, geom);
          if (gen !== _renderGeneration) return;
          if (res && res.canvas) {
            lanczosCanvas.width = res.width;
            lanczosCanvas.height = res.height;
            const ctx = lanczosCanvas.getContext('2d');
            ctx.clearRect(0, 0, res.width, res.height);
            ctx.drawImage(res.canvas, 0, 0);
            
            if (res.cssLeft !== undefined) {
              lanczosCanvas.style.setProperty('--crop-left', res.cssLeft + 'px');
              lanczosCanvas.style.setProperty('--crop-top', res.cssTop + 'px');
              lanczosCanvas.style.setProperty('--crop-w', res.cssWidth + 'px');
              lanczosCanvas.style.setProperty('--crop-h', res.cssHeight + 'px');
            } else {
              lanczosCanvas.style.removeProperty('--crop-left');
              lanczosCanvas.style.removeProperty('--crop-top');
              lanczosCanvas.style.removeProperty('--crop-w');
              lanczosCanvas.style.removeProperty('--crop-h');
            }
            lanczosCanvas.setAttribute('data-render-ready', 'true');
          }
        }
      }, 80);
    }
  }

  viewportState.subscribe(() => {
    if (_targetLoadTimer) return;
    _cancelRender();
    _applyScaling();
    _scheduleTransform();
    _triggerRender();
  });

  function _applyScaling(incomingFilter, incomingIsAnimated) {
    if (!img) return;
    const live = Core.getState();
    const isAnimated = incomingIsAnimated !== undefined ? incomingIsAnimated : !!live?.isAnimated;
    const scaling = getEffectiveScaling(viewportState.getScaling(), isAnimated);

    const activeFilter = incomingFilter !== undefined ? incomingFilter : _resolveActiveFilter(live);
    const usesWebgl = activeFilter !== null;
    const usesLanczos = scaling === 'lanczos' && !usesWebgl;
    
    img.dataset.scaling = scaling;

    if (!usesLanczos && lanczosCanvas) {
      lanczosCanvas.removeAttribute('data-render-ready');
      const ctx = lanczosCanvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, lanczosCanvas.width, lanczosCanvas.height);
      lanczosCanvas.width = 0;
      lanczosCanvas.height = 0;
      lanczosCanvas.style.removeProperty('--crop-left');
      lanczosCanvas.style.removeProperty('--crop-top');
      lanczosCanvas.style.removeProperty('--crop-w');
      lanczosCanvas.style.removeProperty('--crop-h');
    }

    let needsNewPipeline = !pipeline;
    if (pipeline) {
      if (usesWebgl && pipeline.type !== 'webgl') needsNewPipeline = true;
      if (usesLanczos && pipeline.type !== 'lanczos') needsNewPipeline = true;
      if (needsNewPipeline || (!usesWebgl && !usesLanczos)) {
        _teardownWebglCanvas();
        pipeline.dispose();
        if (!usesWebgl && !usesLanczos) pipeline = null;
      }
    }

    const filterChanged = activeFilter !== _lastActiveFilter;

    if (needsNewPipeline || (usesWebgl && filterChanged)) {
      if (pipeline) {
        _teardownWebglCanvas();
        pipeline.dispose();
      }
      if (usesWebgl) {
        const canvas = activeFilter === 'crt' ? crtCanvas : filterCanvas;
        pipeline = createWebglPipeline(canvas, scaling, activeFilter);
      } else if (usesLanczos) {
        pipeline = createScalingPipeline(scaling);
      }
    }
    
    _lastScalingMode = scaling;
  }

  // Percentage-based SVGs (width="100%" height="100%") collapse to 0×0
  // clientWidth inside the shrink-wrap wrapper. Detect the collapse and
  // assign a concrete base resolution via CSS custom properties consumed
  // by the .viewer-img[data-svg-bounds] rule.
  function _applySvgBounds(el) {
    el.removeAttribute('data-svg-bounds');
    el.style.removeProperty('--svg-base-w');
    el.style.removeProperty('--svg-base-h');

    let natW = el.naturalWidth;
    let natH = el.naturalHeight;

    if (natW <= 0) {
      natW = 1000;
      natH = 1000;
      el.style.setProperty('--svg-base-w', '1000px');
      el.style.setProperty('--svg-base-h', '1000px');
      el.setAttribute('data-svg-bounds', '');
      return { natW, natH };
    }

    let clientW = el.clientWidth;
    let clientH = el.clientHeight;

    if (clientW === 0 && el.src && el.src.toLowerCase().includes('.svg')) {
      const scale = Math.min((window.innerWidth * 0.5) / natW, (window.innerHeight * 0.5) / natH);
      natW = Math.max(1, Math.round(el.naturalWidth * scale));
      natH = Math.max(1, Math.round(el.naturalHeight * scale));
      el.style.setProperty('--svg-base-w', natW + 'px');
      el.style.setProperty('--svg-base-h', natH + 'px');
      el.setAttribute('data-svg-bounds', '');
      clientW = el.clientWidth;
      clientH = el.clientHeight;
    }

    return { natW, natH, clientW, clientH };
  }

  function _attachLoadHandler(el) {
    el.addEventListener('load', () => {
      if (el !== img) return;
      if (!el.src) return;
      const state = Core.getState();

      el.classList.add('active');
      const bounds = _applySvgBounds(el);

      _applyScaling();

      const displayW = el.naturalWidth > 0 ? el.naturalWidth : 'SVG';
      const displayH = el.naturalHeight > 0 ? el.naturalHeight : 'SVG';
      Statusbar.setImage({ filename: state.filename || '', dims: `${displayW} × ${displayH}`, zoom: viewportState.getScale() });

      viewportState.applyFitMode(
        state.fitMode, bounds.natW, bounds.natH,
        bounds.clientW ?? el.clientWidth, bounds.clientH ?? el.clientHeight
      );
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
      el.crossOrigin = 'anonymous';
      el.decoding = 'async';
      imgWrapper.appendChild(el);
    }
    el.alt = '';
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
    return !!(el && el.src && el.classList.contains('active'));
  }

  function _activatePoolNode(el, filename, state) {
    _cancelRender();
    if (img && img !== el) {
      img.classList.remove('active');
    }
    img = el;
    img.classList.add('active');
    img.alt = filename || '';
    img.title = filename || '';
    
    _applyScaling();
    const live = Core.getState();
    _lastIsAnimated = !!live?.isAnimated;
    _lastActiveFilter = _resolveActiveFilter(live);
    viewportState.resetGeometry();

    const bounds = _applySvgBounds(img);

    const displayW = img.naturalWidth > 0 ? img.naturalWidth : 'SVG';
    const displayH = img.naturalHeight > 0 ? img.naturalHeight : 'SVG';

    Statusbar.setImage({ filename: filename || '', dims: `${displayW} × ${displayH}`, zoom: viewportState.getScale() });
    viewportState.applyFitMode(
      state.fitMode, bounds.natW, bounds.natH,
      bounds.clientW ?? img.clientWidth, bounds.clientH ?? img.clientHeight
    );
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
        preloader.crossOrigin = 'anonymous';
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

  function _teardownWebglCanvas() {
    [crtCanvas, filterCanvas].forEach(canvas => {
      if (!canvas) return;
      canvas.removeAttribute('data-render-ready');
      canvas.removeAttribute('data-crt');
      const gl = canvas.getContext('webgl2');
      if (gl) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } else {
        canvas.width = canvas.width;
      }
    });
  }

  function clearDisplayedImage() {
    _cancelRender();
    if (lanczosCanvas) {
      const ctx = lanczosCanvas.getContext('2d');
      if (ctx) ctx.clearRect(0, 0, lanczosCanvas.width, lanczosCanvas.height);
    }
    _teardownWebglCanvas();
    if (pipeline) pipeline.dispose();
    pipeline = null;
    _poolGeneration += 1;
    _activationGeneration += 1;
    _clearTargetLoadTimer();
    _clearScheduledPreloads();
    for (const src of _activeNodes.keys()) _recyclePoolNode(src);
    img = null;
  }

  Core.onStateChange((state) => {
    const generation = ++_poolGeneration;
    _activationGeneration += 1;
    _clearTargetLoadTimer();
    _clearScheduledPreloads();

    if (state.mode === 'empty' || !state.src || !state.list || state.list.length === 0) {
      clearDisplayedImage();
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
          img.classList.remove('active');
        }
        if (activeEl) {
          img = activeEl;
          img.classList.add('active');
        }
      }

      const loadTarget = () => {
        if (activation !== _activationGeneration || Core.getState().src !== state.src) return;
        _targetLoadTimer = null;
        if (activeEl) _loadPoolNode(activeEl, state.src);

        const ready = activeEl && activeEl.complete && (activeEl.naturalWidth > 0 || state.src.toLowerCase().endsWith('.svg') || state.src.includes('.svg?'));
        const decodePromise = (ready || !activeEl || !activeEl.decode) ? Promise.resolve() : activeEl.decode();
        
        decodePromise.then(() => {
          if (activation !== _activationGeneration || Core.getState().src !== state.src) return;
          if (activeEl) _activatePoolNode(activeEl, state.filename, state);
          _schedulePoolPreloads(neighborSrcs, generation);
        }).catch((err) => {
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
  });

  window.addEventListener('resize', () => {
    if (img) viewportState.applyFitMode(undefined, img.naturalWidth, img.naturalHeight, img.clientWidth, img.clientHeight);
  });
}
