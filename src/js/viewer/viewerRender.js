import { Core } from '../core.js';
import { FsUtils } from '../fsUtils.js';
import { Statusbar } from '../menubar/statusbar.js';

const PRELOAD_HALF = 1;
const TARGET_LOAD_DEBOUNCE_MS = 45;
const LOADING_LABEL = 'Loading...';

export function createViewerRenderer(viewportState, onActiveImageChanged = () => {}) {
  const _activeNodes = new Map();
  const _freeNodes = [];
  const POOL_SIZE = 10; 

  const imgWrapper = document.getElementById('viewer-img-wrapper');
  if (imgWrapper) {
    const existingNodes = Array.from(document.querySelectorAll('.viewer-img:not(.is-placeholder)'));
    // Reuse existing nodes, don't remove and recreate
    for (let i = 0; i < existingNodes.length; i++) {
      if (i < POOL_SIZE) {
        existingNodes[i].classList.remove('active');
        _freeNodes.push(existingNodes[i]);
      } else {
        existingNodes[i].remove();
      }
    }
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
  let _activeTargetSrc = null;
  let _forceReloadTarget = false;
  let _reloadTimestamp = 0;
  let _poolGeneration = 0;
  let _activationGeneration = 0;
  let _targetLoadTimer = null;
  const _preloadTimers = [];
  const _preloadImages = [];
  let _lastFitModeGen = -1;
  let _lastSpreadEnabled = null;
  let _lastSpreadDirection = null;
  let _lastSpreadStep = null;
  let _loadingAnimTimer = null;
  let _loadingDots = 0;
  let _retiringNode = null;
  let _retireRaf = null;

  function _cancelRetiringNode() {
    if (_retireRaf) {
      cancelAnimationFrame(_retireRaf);
      _retireRaf = null;
    }
    if (_retiringNode) {
      _retiringNode.classList.remove('bridge');
      _retiringNode = null;
    }
  }

  function _startLoadingAnimation(el) {
    _stopLoadingAnimation();
    _loadingDots = 0;
    _loadingAnimTimer = setInterval(() => {
      _loadingDots = (_loadingDots + 1) % 4;
      const dots = '.'.repeat(_loadingDots || 1);
      if (el) el.alt = `Loading${dots}`;
    }, 250);
  }

  function _stopLoadingAnimation() {
    if (_loadingAnimTimer) {
      clearInterval(_loadingAnimTimer);
      _loadingAnimTimer = null;
    }
  }

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

  function _syncActiveImage(el, filename, state) {
    if (!el) return;
    const bounds = _applySvgBounds(el);
    Core.setImageDimensions(bounds.natW, bounds.natH);
    const liveState = Core.getState();

    const spreadEnabled = liveState.spreadEnabled ?? liveState.config?.frontend_data?.spread_enabled ?? true;
    const spreadDirection = liveState.spreadDirection ?? liveState.config?.frontend_data?.spread_direction ?? 'rtl';
    _lastSpreadEnabled = spreadEnabled;
    _lastSpreadDirection = spreadDirection;
    _lastSpreadStep = liveState.spreadStep || 1;
    viewportState.setSpreadEnabled(spreadEnabled);
    viewportState.setSpreadDirection(spreadDirection);
    viewportState.setSpreadStep(liveState.spreadStep || 1);

    const displayW = el.naturalWidth > 0 ? el.naturalWidth : 'SVG';
    const displayH = el.naturalHeight > 0 ? el.naturalHeight : 'SVG';

    viewportState.applyFitMode(
      liveState.fitMode, bounds.natW, bounds.natH,
      bounds.clientW ?? el.clientWidth, bounds.clientH ?? el.clientHeight
    );

    Statusbar.setImage({ filename: filename || liveState.filename || '', dims: `${displayW} × ${displayH}`, zoom: viewportState.getScale() });
    Statusbar.syncSpreadIndicator(liveState);

    onActiveImageChanged(el);
  }

  function _attachLoadHandler(el) {
    el.addEventListener('load', () => {
      if (el !== img) return;
      if (!el.src) return;
      _stopLoadingAnimation();
      el.classList.add('active');
      _syncActiveImage(el, Core.getState().filename, Core.getState());
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
      if (el === _retiringNode) _cancelRetiringNode();
      el.removeAttribute('src');
      el.removeAttribute('data-pool-src');
      el.removeAttribute('data-played');
      el.removeAttribute('data-scaling');
      el.classList.remove('active', 'bridge');
      if (el === img) {
        img = null;
        onActiveImageChanged(null);
      }
      _activeNodes.delete(src);
      _freeNodes.push(el);
      FsUtils.revokeIfObjectURL(src);
      while (_freeNodes.length > POOL_SIZE) _freeNodes.pop()?.remove();
    }
  }

  function _loadPoolNode(el, actualSrc, poolSrc) {
    if (!el || !actualSrc) return;
    el.dataset.poolSrc = poolSrc || actualSrc;
    if (el.getAttribute('src') === actualSrc || el.src === actualSrc) return;
    el.src = actualSrc;
  }

  function _isVisibleImage(el) {
    return !!(el && el.src && el.classList.contains('active'));
  }

  function _activatePoolNode(el, filename, state) {
    if (img && img !== el) {
      _cancelRetiringNode();
      const outgoing = img;
      outgoing.classList.remove('active');
      outgoing.classList.add('bridge');
      _retiringNode = outgoing;
      _retireRaf = requestAnimationFrame(() => {
        _retireRaf = requestAnimationFrame(() => {
          if (_retiringNode === outgoing) {
            outgoing.classList.remove('bridge');
            _retiringNode = null;
          }
          _retireRaf = null;
        });
      });
    }

    img = el;
    img.dataset.played = 'true';
    img.classList.remove('bridge');
    img.classList.add('active');
    img.alt = filename || '';
    img.title = filename || '';
    
    viewportState.resetGeometry();
    _syncActiveImage(img, filename, state);
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

  function clearDisplayedImage() {
    _cancelRetiringNode();
    _stopLoadingAnimation();
    _activeTargetSrc = null;
    _poolGeneration += 1;
    _activationGeneration += 1;
    _clearTargetLoadTimer();
    _clearScheduledPreloads();
    for (const src of _activeNodes.keys()) _recyclePoolNode(src);
    img = null;
    onActiveImageChanged(null);
  }

  if (typeof window !== 'undefined' && window.addEventListener) {
    window.addEventListener('quivit-refresh-start', () => {
      _forceReloadTarget = true;
      _reloadTimestamp = Date.now();
      _activeTargetSrc = null;
    });
  }

  Core.onStateChange((state) => {
    const generation = ++_poolGeneration;
    _clearScheduledPreloads();

    if (state.mode === 'empty' || !state.src || !state.list || state.list.length === 0) {
      clearDisplayedImage();
      return;
    }

    const desiredSrcs = new Set([state.src]);
    if (_isVisibleImage(img) && img.dataset.poolSrc) desiredSrcs.add(img.dataset.poolSrc);

    const neighborSrcs = FsUtils.neighborEntries(state, state.index, PRELOAD_HALF);
    for (const nSrc of neighborSrcs) desiredSrcs.add(nSrc);

    if (_activeNodes.size > POOL_SIZE) {
      for (const src of _activeNodes.keys()) {
        if (!desiredSrcs.has(src)) {
          _recyclePoolNode(src);
          if (_activeNodes.size <= POOL_SIZE) break;
        }
      }
    }

    for (const src of desiredSrcs) {
      _getPoolNode(src);
    }

    let activeEl = _activeNodes.get(state.src);
    const isReload = _forceReloadTarget;
    const activeChanged = state.src !== _activeTargetSrc || isReload;
    const hasPreviousBridge = !isReload && !!(img && img !== activeEl && _isVisibleImage(img));

    if (activeChanged) {
      _activeTargetSrc = state.src;
      _forceReloadTarget = false;
      _clearTargetLoadTimer();
      const activation = ++_activationGeneration;
      Statusbar.setImage({ isLoading: true });
      if (activeEl) activeEl.alt = LOADING_LABEL;

      const isAlreadyLoaded = !isReload && activeEl && activeEl.complete && activeEl.naturalWidth > 0;
      if (!isAlreadyLoaded) {
        _startLoadingAnimation(activeEl);
      }

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
        if (activation !== _activationGeneration || Core.getState().src !== state.src) {
           _stopLoadingAnimation();
           return;
        }
        _targetLoadTimer = null;
        
        if (activeEl) {
          const isReEntry = state.isAnimated && activeEl.dataset.played === 'true';
          let newSrc = state.src;
          if (isReload) {
            newSrc = state.src.includes('?') ? `${state.src}&_t=${_reloadTimestamp}` : `${state.src}?_t=${_reloadTimestamp}`;
          } else if (isReEntry) {
            newSrc = state.src.includes('?') ? `${state.src}&_reset=${Date.now()}` : `${state.src}?_reset=${Date.now()}`;
          }
          _loadPoolNode(activeEl, newSrc, state.src);
        }

        const skipDecode = state.src.toLowerCase().endsWith('.ico') || state.src.includes('.ico?') || 
                           state.src.toLowerCase().endsWith('.svg') || state.src.includes('.svg?');
        const ready = !isReload && activeEl && activeEl.complete && (activeEl.naturalWidth > 0 || skipDecode);

        let decodePromise;
        if (ready || !activeEl) {
          decodePromise = Promise.resolve();
        } else if (!activeEl.decode || skipDecode) {
          decodePromise = new Promise((resolve) => {
            if (activeEl.complete) { resolve(); return; }
            const handler = () => {
              activeEl.removeEventListener('load', handler);
              activeEl.removeEventListener('error', handler);
              resolve();
            };
            activeEl.addEventListener('load', handler);
            activeEl.addEventListener('error', handler);
          });
        } else {
          decodePromise = activeEl.decode();
        }
        
        decodePromise.then(() => {
          if (activation !== _activationGeneration || Core.getState().src !== state.src) {
            _stopLoadingAnimation();
            return;
          }
          _stopLoadingAnimation();
          if (activeEl) _activatePoolNode(activeEl, state.filename, state);
          _schedulePoolPreloads(neighborSrcs, generation);
        }).catch((err) => {
          if (activation !== _activationGeneration || Core.getState().src !== state.src) {
            _stopLoadingAnimation();
            return;
          }
          _stopLoadingAnimation();
          if (activeEl) _activatePoolNode(activeEl, state.filename ? `Failed to load ${state.filename}` : 'Failed to load image', state);
          Statusbar.setImage({ isError: true });
          _schedulePoolPreloads(neighborSrcs, generation);
        });
      };

      if (hasPreviousBridge && !isAlreadyLoaded) {
        _targetLoadTimer = setTimeout(loadTarget, TARGET_LOAD_DEBOUNCE_MS);
      } else {
        loadTarget();
      }
    } else {
      _schedulePoolPreloads(neighborSrcs, generation);
    }

    if (_lastFitModeGen !== state.fitModeGen) {
      _lastFitModeGen = state.fitModeGen;
      if (img) {
        const bounds = _applySvgBounds(img);
        viewportState.applyFitMode(state.fitMode, bounds.natW, bounds.natH, bounds.clientW ?? img.clientWidth, bounds.clientH ?? img.clientHeight);
      }
    }

    const spreadEnabled = state.spreadEnabled ?? state.config?.frontend_data?.spread_enabled ?? true;
    const spreadDirection = state.spreadDirection ?? state.config?.frontend_data?.spread_direction ?? 'rtl';
    if (_lastSpreadEnabled !== spreadEnabled || _lastSpreadDirection !== spreadDirection) {
      _lastSpreadEnabled = spreadEnabled;
      _lastSpreadDirection = spreadDirection;
      viewportState.setSpreadEnabled(spreadEnabled);
      viewportState.setSpreadDirection(spreadDirection);
      if (img && img.src) {
        const bounds = _applySvgBounds(img);
        viewportState.applyFitMode(state.fitMode, bounds.natW, bounds.natH, bounds.clientW ?? img.clientWidth, bounds.clientH ?? img.clientHeight);
      }
    }

    if (_lastSpreadStep !== state.spreadStep) {
      _lastSpreadStep = state.spreadStep;
      viewportState.setSpreadStep(state.spreadStep);
    }
  });

  viewportState.subscribe(() => {
    if (imgWrapper) {
      imgWrapper.style.transform = viewportState.getTransform();
      imgWrapper.style.setProperty('--zoom-scale', viewportState.getScale());
    }
    if (img && img.src) {
      Statusbar.setZoom(viewportState.getScale());
    }
  });
}
