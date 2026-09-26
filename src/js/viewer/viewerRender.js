import { Core } from '../core.js';
import { FsUtils } from '../fsUtils.js';
import { thumbnailCache } from '../filepanel/filePanel.js';
import { Statusbar } from '../menubar/statusbar.js';

const PRELOAD_HALF = 1;
const VIEWER_IMAGE_POOL_CAPACITY = 4;
const TARGET_LOAD_DEBOUNCE_MS = 45;
const VIDEO_READY_TIMEOUT_MS = 2000;
const LOADING_LABEL = 'Loading...';

export function createViewerRenderer(viewportState, onActiveImageChanged = () => {}) {
  const _activeNodes = new Map();
  const _freeNodes = [];

  const imgWrapper = document.getElementById('viewer-img-wrapper');
  const bridgeLayer = document.getElementById('viewer-bridge-layer');
  if (imgWrapper) {
    const existingNodes = Array.from(document.querySelectorAll('.viewer-img:not(.is-placeholder)'));
    // Reuse existing nodes, don't remove and recreate
    for (let i = 0; i < existingNodes.length; i++) {
      if (i < VIEWER_IMAGE_POOL_CAPACITY) {
        existingNodes[i].classList.remove('active', 'bridge');
        if (existingNodes[i].parentElement !== imgWrapper) imgWrapper.appendChild(existingNodes[i]);
        _freeNodes.push(existingNodes[i]);
      } else {
        existingNodes[i].remove();
      }
    }
    for (let i = _freeNodes.length; i < VIEWER_IMAGE_POOL_CAPACITY; i++) {
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
  let _lastRenderedIsAnimated = false;
  let _lastRenderedArchivePath = null;
  let _activeVideoSrc = null;
  let _activeVideoEl = null;
  let _activeMedia = null;
  let _pendingVideoEl = null;
  let _videoGeneration = 0;
  let _videoWaitTimer = null;
  let _videoPreloadTimer = null;

  const videoEls = [
    document.getElementById('viewer-video'),
    document.getElementById('viewer-video-b'),
  ].filter(Boolean);
  for (const el of videoEls) {
    el.crossOrigin = 'anonymous';
    el.loop = true;
    el.muted = true;
    el.playsInline = true;
    el.preload = 'auto';
    el.addEventListener('loadedmetadata', () => _onVideoMetadata(el));
  }

  function _onVideoMetadata(el) {
    if (el !== _activeVideoEl || _activeMedia !== 'video') return;
    const w = el.videoWidth || 0;
    const h = el.videoHeight || 0;
    if (!w || !h) return;
    Core.setImageDimensions(w, h);
    const live = Core.getState();
    viewportState.applyFitMode(live.fitMode, w, h);
    Statusbar.setImage({ filename: live.filename || '', dims: `${w} × ${h}`, zoom: viewportState.getScale() });
    Statusbar.syncSpreadIndicator(live);
    onActiveImageChanged(el);
  }

  function _isVideoState(state) {
    const entry = state?.list?.[state.index];
    if (entry && !entry.is_dir && !entry.is_parent) {
      if (FsUtils.isVideoEntry?.(entry)) return true;
      if (FsUtils.isVideo?.(entry.name || entry.path || '')) return true;
    }
    if (state?.filename && FsUtils.isVideo?.(state.filename)) return true;
    return false;
  }

  function _pickIncomingVideoEl(videoSrc) {
    const buffered = videoEls.find((el) => el !== _activeVideoEl && el.dataset.vidSrc === videoSrc);
    if (buffered) return buffered;
    return videoEls.find((el) => el !== _activeVideoEl) || videoEls[0];
  }

  function _clearVideoWait() {
    if (_videoWaitTimer) clearTimeout(_videoWaitTimer);
    _videoWaitTimer = null;
  }

  function _clearVideoPreload() {
    if (_videoPreloadTimer) clearTimeout(_videoPreloadTimer);
    _videoPreloadTimer = null;
  }

  function _scheduleVideoPreload(state) {
    _clearVideoPreload();
    _videoPreloadTimer = setTimeout(() => {
      _videoPreloadTimer = null;
      const live = Core.getState();
      if (live.src !== state.src || live.index !== state.index) return;
      const neighbors = FsUtils.neighborVideoEntries(live, state.index, PRELOAD_HALF);
      const target = neighbors.find((src) => src && !videoEls.some((el) => el.dataset.vidSrc === src));
      if (!target) return;
      const idle = videoEls.find((el) => el !== _activeVideoEl && el !== _pendingVideoEl);
      if (!idle) return;
      idle.dataset.vidSrc = target;
      idle.src = target;
      idle.load();
    }, 120);
  }

  function _parkNodeInBridge(node) {
    const frozen = viewportState.getGeometry ? viewportState.getGeometry() : null;
    _cancelRetiringNode();
    if (node.tagName === 'VIDEO') node.pause();
    node.classList.remove('active');
    if (frozen && bridgeLayer) {
      node.style.setProperty('--bridge-tx', `${frozen.tx}px`);
      node.style.setProperty('--bridge-ty', `${frozen.ty}px`);
      node.style.setProperty('--bridge-rot', `${frozen.rotation}deg`);
      node.style.setProperty('--bridge-sx', `${frozen.flipX * frozen.scale}`);
      node.style.setProperty('--bridge-sy', `${frozen.flipY * frozen.scale}`);
      bridgeLayer.appendChild(node);
    }
    node.classList.add('bridge');
    _retiringNode = node;
    _retireRaf = requestAnimationFrame(() => {
      _retireRaf = requestAnimationFrame(() => {
        if (_retiringNode === node) {
          _releaseBridgeNode(node);
          _retiringNode = null;
        }
        _retireRaf = null;
      });
    });
  }

  function _swapInVideo(incoming, state) {
    _clearVideoWait();
    _videoGeneration += 1;
    _pendingVideoEl = null;
    const outgoingVideo = _activeVideoEl && _activeVideoEl !== incoming ? _activeVideoEl : null;
    if (outgoingVideo) {
      _parkNodeInBridge(outgoingVideo);
    } else if (_activeMedia === 'image' && img && img.src && img.classList.contains('active')) {
      _parkNodeInBridge(img);
      img = null;
    } else {
      _cancelRetiringNode();
      if (img) img.classList.remove('active');
    }
    if (imgWrapper && incoming.parentElement !== imgWrapper) imgWrapper.appendChild(incoming);
    incoming.classList.add('active');
    incoming.muted = true;
    _activeVideoEl = incoming;
    _activeVideoSrc = incoming.dataset.vidSrc || state.src;
    _activeMedia = 'video';
    _activeTargetSrc = state.src;
    _forceReloadTarget = false;
    onActiveImageChanged(incoming);
    viewportState.resetGeometry();
    const vw = incoming.videoWidth || 0;
    const vh = incoming.videoHeight || 0;
    if (vw && vh) {
      Core.setImageDimensions(vw, vh);
      viewportState.applyFitMode(state.fitMode, vw, vh);
      Statusbar.setImage({ filename: state.filename || '', dims: `${vw} × ${vh}`, zoom: viewportState.getScale() });
    } else {
      Statusbar.setImage({ filename: state.filename || '', zoom: viewportState.getScale() });
    }
    Statusbar.syncSpreadIndicator(state);
    incoming.play().catch(() => {});
    _lastFitModeGen = state.fitModeGen;
    _lastSpreadEnabled = state.spreadEnabled ?? state.config?.frontend_data?.spread_enabled ?? _lastSpreadEnabled;
    _lastSpreadDirection = state.spreadDirection ?? state.config?.frontend_data?.spread_direction ?? _lastSpreadDirection;
    _lastSpreadStep = state.spreadStep;
    _scheduleVideoPreload(state);
  }

  function _hideVideo() {
    _videoGeneration += 1;
    _clearVideoWait();
    _clearVideoPreload();
    _pendingVideoEl = null;
    for (const el of videoEls) {
      el.pause();
      el.classList.remove('active');
      el.removeAttribute('src');
      el.load();
      el.dataset.vidSrc = '';
      if (imgWrapper && el.parentElement !== imgWrapper) imgWrapper.appendChild(el);
    }
    _activeVideoEl = null;
    _activeVideoSrc = null;
    _activeMedia = null;
    onActiveImageChanged(null);
  }

  function _releaseBridgeNode(node) {
    node.classList.remove('bridge');
    node.style.removeProperty('--bridge-tx');
    node.style.removeProperty('--bridge-ty');
    node.style.removeProperty('--bridge-rot');
    node.style.removeProperty('--bridge-sx');
    node.style.removeProperty('--bridge-sy');
    if (imgWrapper && node.parentElement !== imgWrapper && !node.classList.contains('is-placeholder')) {
      imgWrapper.appendChild(node);
    }
  }

  function _cancelRetiringNode() {
    if (_retireRaf) {
      cancelAnimationFrame(_retireRaf);
      _retireRaf = null;
    }
    if (_retiringNode) {
      _releaseBridgeNode(_retiringNode);
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
      el.classList.remove('active');
      _releaseBridgeNode(el);
      if (el === img) {
        img = null;
        onActiveImageChanged(null);
      }
      _activeNodes.delete(src);
      _freeNodes.push(el);
      FsUtils.revokeIfObjectURL(src);
      while (_freeNodes.length > VIEWER_IMAGE_POOL_CAPACITY) _freeNodes.pop()?.remove();
    }
  }

  function _trimActiveNodes(allowedSrcs) {
    for (const src of Array.from(_activeNodes.keys())) {
      if (!allowedSrcs.has(src)) _recyclePoolNode(src);
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
      _parkNodeInBridge(img);
    }

    img = el;
    if (imgWrapper && img.parentElement !== imgWrapper && !img.classList.contains('is-placeholder')) {
      imgWrapper.appendChild(img);
    }
    img.dataset.played = 'true';
    img.classList.remove('bridge');
    img.style.removeProperty('--bridge-tx');
    img.style.removeProperty('--bridge-ty');
    img.style.removeProperty('--bridge-rot');
    img.style.removeProperty('--bridge-sx');
    img.style.removeProperty('--bridge-sy');
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
        // Reuse blob URL from file-panel thumbnail cache for archive entries.
        // Avoids redundant quivit:// fetch for neighbors (next/prev) when thumb already loaded.
        let actualSrc = src;
        const cached = thumbnailCache.get(src);
        if (typeof cached === 'string' && cached.startsWith('blob:')) actualSrc = cached;
        const preloader = new Image();
        preloader.decoding = 'async';
        preloader.crossOrigin = 'anonymous';
        _preloadImages.push(preloader);
        preloader.onload = () => {
          const idx = _preloadImages.indexOf(preloader);
          if (idx !== -1) _preloadImages.splice(idx, 1);
          preloader.onload = null;
          preloader.onerror = null;
          preloader.removeAttribute('src');
        };
        preloader.onerror = preloader.onload;
        preloader.src = actualSrc;
        if (preloader.decode) preloader.decode().catch(() => {});
      }, 100 + index * 45);
      _preloadTimers.push(timer);
    });
  }

  function clearDisplayedImage() {
    _cancelRetiringNode();
    _stopLoadingAnimation();
    _activeTargetSrc = null;
    _hideVideo();
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
      _videoGeneration += 1;
      _clearVideoWait();
      _clearVideoPreload();
      _pendingVideoEl = null;
    });

    window.addEventListener('quivit-download-complete', (e) => {
      const destPath = e.detail?.destPath;
      if (!destPath) return;
      const state = Core.getState();
      const currentEntry = state.list?.[state.index];
      const targetPath = currentEntry?.path || (currentEntry?.name && state.directory ? `${state.directory}\\${currentEntry.name}` : null);
      if (targetPath && targetPath.replace(/\\/g, '/').toLowerCase() === destPath.replace(/\\/g, '/').toLowerCase()) {
        _forceReloadTarget = true;
        _reloadTimestamp = Date.now();
        _activeTargetSrc = null;
        Core.setState({ fitModeGen: (state.fitModeGen || 0) + 1 });
      }
    });
  }

  Core.onStateChange((state) => {
    // Strip owns its own images; skip single-image pipeline when active.
    if (state.manhwaEnabled) {
      clearDisplayedImage();
      return;
    }

    const isArchive = state.mode === 'archive';
    const currentArchivePath = isArchive ? state.archivePath : null;
    const archiveChanged = isArchive && currentArchivePath !== _lastRenderedArchivePath;
    const exitedArchive = !isArchive && _lastRenderedArchivePath !== null;

    if (archiveChanged || exitedArchive) {
      clearDisplayedImage();
    }
    _lastRenderedArchivePath = currentArchivePath;

    const generation = ++_poolGeneration;
    _clearScheduledPreloads();

    if (state.mode === 'empty' || !state.src || !state.list || state.list.length === 0) {
      clearDisplayedImage();
      return;
    }

    if (_isVideoState(state) && videoEls.length > 0) {
      _clearTargetLoadTimer();
      _stopLoadingAnimation();
      const isVideoReload = _forceReloadTarget;
      let videoSrc = state.src;
      if (isVideoReload) {
        videoSrc = state.src.includes('?') ? `${state.src}&_t=${Date.now()}` : `${state.src}?_t=${Date.now()}`;
      }
      const videoChanged = videoSrc !== _activeVideoSrc || isVideoReload || _activeMedia !== 'video';
      _activeTargetSrc = state.src;
      _forceReloadTarget = false;
      if (videoChanged) {
        const gen = ++_videoGeneration;
        _clearVideoWait();
        _clearVideoPreload();
        const incoming = _pickIncomingVideoEl(videoSrc);
        _pendingVideoEl = incoming;
        const ready = () => {
          if (gen !== _videoGeneration || Core.getState().src !== state.src) return;
          _swapInVideo(incoming, state);
        };
        const onVideoError = () => {
          if (gen !== _videoGeneration || Core.getState().src !== state.src) return;
          _swapInVideo(incoming, state);
          Statusbar.setImage({ isError: true });
        };
        Statusbar.setImage({ filename: state.filename || '', zoom: viewportState.getScale() });
        if (incoming.getAttribute('src') === videoSrc && incoming.readyState >= 2) {
          ready();
        } else {
          incoming.dataset.vidSrc = videoSrc;
          incoming.src = videoSrc;
          incoming.load();
          incoming.addEventListener('canplay', ready, { once: true });
          incoming.addEventListener('error', onVideoError, { once: true });
          _videoWaitTimer = setTimeout(ready, VIDEO_READY_TIMEOUT_MS);
        }
      } else if (_activeVideoEl) {
        if (imgWrapper && _activeVideoEl.parentElement !== imgWrapper) imgWrapper.appendChild(_activeVideoEl);
        _activeVideoEl.classList.add('active');
        _activeVideoEl.play().catch(() => {});
        const vw = _activeVideoEl.videoWidth || 0;
        const vh = _activeVideoEl.videoHeight || 0;
        if (vw && vh && _lastFitModeGen !== state.fitModeGen) {
          viewportState.applyFitMode(state.fitMode, vw, vh);
          Statusbar.setImage({ filename: state.filename || '', dims: `${vw} × ${vh}`, zoom: viewportState.getScale() });
        }
        _lastFitModeGen = state.fitModeGen;
      }
      _lastSpreadEnabled = state.spreadEnabled ?? state.config?.frontend_data?.spread_enabled ?? _lastSpreadEnabled;
      _lastSpreadDirection = state.spreadDirection ?? state.config?.frontend_data?.spread_direction ?? _lastSpreadDirection;
      _lastSpreadStep = state.spreadStep;
      return;
    }
    if (_activeMedia === 'video') {
      _clearVideoWait();
      _clearVideoPreload();
      if (_pendingVideoEl && _pendingVideoEl !== _activeVideoEl) {
        _pendingVideoEl.removeAttribute('src');
        _pendingVideoEl.load();
        _pendingVideoEl.dataset.vidSrc = '';
        _pendingVideoEl = null;
      }
      if (img && !_isVisibleImage(img)) img = null;
    }

    const desiredSrcs = new Set([state.src]);
    if (_isVisibleImage(img) && img.dataset.poolSrc) desiredSrcs.add(img.dataset.poolSrc);

    const neighborSrcs = FsUtils.neighborEntries(state, state.index, PRELOAD_HALF);
    for (const nSrc of neighborSrcs) desiredSrcs.add(nSrc);

    _trimActiveNodes(desiredSrcs);

    for (const src of desiredSrcs) {
      _getPoolNode(src);
    }

    let activeEl = _activeNodes.get(state.src);
    const isReload = _forceReloadTarget;
    const activeChanged = state.src !== _activeTargetSrc || isReload;
    _lastRenderedIsAnimated = !!state.isAnimated;
    const hasPreviousBridge = !isReload && !!(img && img !== activeEl && _isVisibleImage(img));

    if (activeChanged) {
      _activeTargetSrc = state.src;
      _forceReloadTarget = false;
      _clearTargetLoadTimer();
      const activation = ++_activationGeneration;
      Statusbar.setImage({ isLoading: true });
      if (activeEl) activeEl.alt = LOADING_LABEL;

      const isAlreadyLoaded = !isReload && activeEl && activeEl.complete && activeEl.naturalWidth > 0;
      const isCacheWarm = !isAlreadyLoaded && thumbnailCache.has(state.src);
      if (!isAlreadyLoaded && !isCacheWarm) {
        _startLoadingAnimation(activeEl);
      }

      if (!hasPreviousBridge) {
        if (img && img !== activeEl) {
          img.classList.remove('active');
        }
        if (activeEl) {
          img = activeEl;
        }
      }

      const loadTarget = () => {
        if (activation !== _activationGeneration || Core.getState().src !== state.src) {
           _stopLoadingAnimation();
           return;
        }
        _targetLoadTimer = null;
        
        if (activeEl) {
          let newSrc = state.src;
          if (isReload) {
            newSrc = state.src.includes('?') ? `${state.src}&_t=${_reloadTimestamp}` : `${state.src}?_t=${_reloadTimestamp}`;
          } else if (state.isAnimated) {
            newSrc = state.src.includes('?') ? `${state.src}&_reset=${Date.now()}` : `${state.src}?_reset=${Date.now()}`;
          } else {
            const cached = thumbnailCache.get(state.src);
            if (typeof cached === 'string' && cached.startsWith('blob:')) {
              newSrc = cached;
            }
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
          if (_activeMedia === 'video' && _activeVideoEl) {
            _activeVideoEl.pause();
            _activeVideoEl.classList.remove('active');
            _activeVideoEl = null;
          }
          _activeMedia = 'image';
          if (activeEl) _activatePoolNode(activeEl, state.filename, state);
          _schedulePoolPreloads(neighborSrcs, generation);
          _scheduleVideoPreload(state);
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

      if (hasPreviousBridge && !isAlreadyLoaded && !isCacheWarm) {
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
      imgWrapper.style.setProperty('--grill-angle', viewportState.getGrillAngle());
    }
    if ((img && img.src) || _activeVideoEl) {
      Statusbar.setZoom(viewportState.getScale());
    }
  });
}
