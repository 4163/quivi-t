import { Core } from '../core.js';
import { getEffectiveScaling, computeColumnComposite } from '../services/viewerMath.js';
import { createLanczosPipeline } from '../services/scaling/lanczos.js';
import { filter as lanczosWebGlModule } from '../services/scaling/lanczosWebGL.js';
import { createGlRuntime } from '../services/pipelines/glRuntime.js';
import { activeFilterId } from '../services/registry.js';
import { getFilterModule } from '../services/filterModules.js';
import { createTextureCache, uploadTexture } from '../services/pipelines/textureCache.js';
import { createQuadCompositor } from '../services/pipelines/quadCompositor.js';
import { prepareSvgForCanvas, resolveSvgDimensions } from '../shared/svgUtils.js';

const SVG_ANIMATED_MAX_EDGE = 1080;
const SVG_STATIC_MAX_EDGE = 2048;
const VIEWER_IMAGE_POOL_CAPACITY = 4;
const COLUMN_TEXTURE_CACHE_BYTES = 128 * 1024 * 1024; // 128 MB

const _scratchUV = { u0: 0, v0: 0, u1: 1, v1: 1 };
const _scratchDest = { x: 0, y: 0, width: 0, height: 0 };
const _scratchSize = { w: 0, h: 0 };
const _cachedDrawsScratch = [];
const _liveDrawsScratch = [];
const _rasterCandidatesScratch = [];
const _svgCandidatesScratch = [];
const _activeRastersScratch = [];
const _activeSvgsScratch = [];
const _failedRastersScratch = [];
const _scratchActiveIdx = new Set();
const _scratchStaleIdx = [];
const _scratchVisibleKeys = new Set();

function _drawSlotQuad(compositor, texture, draw, item, nodeW, nodeH, vpW, vpH, flipY, sampler) {
  if (!nodeW || !nodeH) return false;
  const itemW = (item && (item.naturalWidth ?? item.width)) || 0;
  const itemH = (item && (item.naturalHeight ?? item.height)) || 0;

  const sr = draw.sourceRect || {};
  const kx = itemW > 0 ? nodeW / itemW : 1;
  const ky = itemH > 0 ? nodeH / itemH : 1;
  const sx = Math.max(0, (sr.x ?? sr.sx ?? 0) * kx);
  const sy = Math.max(0, (sr.y ?? sr.sy ?? 0) * ky);
  const sw = Math.min(nodeW - sx, (sr.width ?? sr.sw ?? nodeW) * kx);
  const sh = Math.min(nodeH - sy, (sr.height ?? sr.sh ?? nodeH) * ky);
  if (sw <= 0 || sh <= 0) return false;

  const dr = draw.destRect || {};
  const dx = dr.x ?? dr.dx ?? 0;
  const dy = dr.y ?? dr.dy ?? 0;
  const dw = dr.width ?? dr.dw ?? 0;
  const dh = dr.height ?? dr.dh ?? 0;
  if (dw <= 0 || dh <= 0) return false;

  _scratchUV.u0 = sx / nodeW;
  _scratchUV.v0 = sy / nodeH;
  _scratchUV.u1 = (sx + sw) / nodeW;
  _scratchUV.v1 = (sy + sh) / nodeH;

  _scratchDest.x = dx;
  _scratchDest.y = dy;
  _scratchDest.width = dw;
  _scratchDest.height = dh;

  _scratchSize.w = nodeW;
  _scratchSize.h = nodeH;

  return compositor.drawQuad(texture, _scratchDest, _scratchUV, vpW, vpH, flipY, sampler, _scratchSize);
}

function isSvgSource(src, item = null) {
  if (item?.entry) {
    const name = item.entry.name || item.entry.path || '';
    if (/\.svg($|[?#])/i.test(name)) return true;
  }
  if (!src || typeof src !== 'string') return false;
  try {
    const url = new URL(src);
    return url.pathname.toLowerCase().endsWith('.svg');
  } catch {
    return src.split('?')[0].toLowerCase().endsWith('.svg');
  }
}

async function loadSvgCanvas(src) {
  try {
    const resp = await globalThis.fetch(src);
    if (!resp.ok) return null;
    const text = await resp.text();
    const cleanSvg = prepareSvgForCanvas(text);
    if (!cleanSvg) return null;
    const blob = new Blob([cleanSvg], { type: 'image/svg+xml' });
    const blobUrl = URL.createObjectURL(blob);
    try {
      const img = new Image();
      img.src = blobUrl;
      await new Promise((resolve, reject) => {
        if (img.complete && img.naturalWidth) resolve();
        else {
          img.onload = resolve;
          img.onerror = reject;
        }
      });

      const { width: w, height: h } = resolveSvgDimensions(
        img.naturalWidth,
        img.naturalHeight,
        cleanSvg,
        SVG_STATIC_MAX_EDGE
      );

      img.width = w;
      img.height = h;

      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, w, h);
      return canvas;
    } finally {
      URL.revokeObjectURL(blobUrl);
    }
  } catch (err) {
    console.warn('[loadSvgCanvas] Failed to load SVG canvas for', src, err);
    return null;
  }
}

export function createViewerPipelines(viewportState) {
  let _activeSource = null;
  let _activeIcoRow = false;
  let pipeline = null;
  let _singleTextureCache = null;
  let _lastScalingMode = Core.getState().scalingMode;
  let _lastActiveFilter = _resolveActiveFilter(Core.getState());
  let _lastAnime4kVariant = null;
  let _lastIsAnimated = !!Core.getState()?.isAnimated;
  
  let _rafPending = false;
  let _renderGeneration = 0;
  let _renderTimeout = null;
  
  let _livePumpRaf = null;
  let _livePumpSrc = null;
  let _livePumpImg = null;
  let _livePumpBlobUrl = null;
  let _livePumpLastDrawnFrameIndex = -1;
  let _livePumpGen = 0;
  let _videoReadyListener = null;
  const _liveStagingCanvas = document.createElement('canvas');

  const lanczosCanvas = document.getElementById('viewer-lanczos-canvas');
  const filterCanvas = document.getElementById('viewer-filter-canvas');
  if (filterCanvas) {
    filterCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
    });
    filterCanvas.addEventListener('webglcontextrestored', () => {
      _cancelRender();
      if (_singleTextureCache) {
        _singleTextureCache.dispose();
        _singleTextureCache = null;
      }
      if (pipeline) pipeline.dispose();
      pipeline = null;
      _applyScaling();
      _scheduleTransform();
      _triggerRender();
      _syncLivePump();
    });
  }

  function _isIcoNode(el) {
    try {
      return !!(el && el.closest && el.closest('.ico-container'));
    } catch {
      return false;
    }
  }

  function isVideoSource(el) {
    return el?.tagName === 'VIDEO';
  }

  // Pool sources can be blob URLs that hide the real extension, so the
  // state entry and filename back up the src check for SVG detection.
  function _isActiveSvg(state) {
    if (isSvgSource(_activeSource?.src)) return true;
    const entry = state?.list?.[state?.index];
    const name = entry?.name || entry?.path || state?.filename || '';
    return /\.svg($|[?#])/i.test(name || '');
  }

  function _resolveActiveFilter(state) {
    if (!state) return null;
    const fd = state.config?.frontend_data;
    if (!fd) return null;
    const active = activeFilterId(fd);
    // Anime4K does not support SVGs; silently fall back to no filter.
    // The UI intentionally ignores this fallback to keep the user's selection checked (intended UX).
    if (active === 'anime4k' && _isActiveSvg(state)) return null;
    return active;
  }

  function _cancelRender() {
    _renderGeneration++;
    if (pipeline) pipeline.cancel();
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

  function _teardownWebglCanvas() {
    if (filterCanvas) {
      filterCanvas.removeAttribute('data-render-ready');
      const gl = filterCanvas.getContext('webgl2');
      if (gl) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
      } else {
        filterCanvas.width = filterCanvas.width;
      }
    }
  }

  /** Cancel pending work without blanking the visible canvas. Pan/zoom moves
   * the existing pixels via transform, so the old canvas stays up until the
   * next render swaps in. Full _cancelRender is for source/filter changes. */
  function _cancelPendingRender() {
    _renderGeneration++;
    if (pipeline) pipeline.cancel();
    if (_renderTimeout) clearTimeout(_renderTimeout);
    _renderTimeout = null;
  }

  function _applyScaling(incomingFilter, incomingIsAnimated) {
    const live = Core.getState();
    const isVideo = isVideoSource(_activeSource);
    const isAnimated = incomingIsAnimated !== undefined ? incomingIsAnimated : !!live?.isAnimated;
    const isSvg = _isActiveSvg(live);
    const isIcoRow = _activeIcoRow || _isIcoNode(_activeSource);
    const isMoving = isAnimated || isVideo;
    const scaling = getEffectiveScaling(live?.scalingMode, isMoving, isSvg);

    const activeFilter = incomingFilter !== undefined ? incomingFilter : _resolveActiveFilter(live);
    
    const useWebGlForLanczos = scaling === 'lanczos' && isMoving && !isSvg && activeFilter === null;
    let usesWebgl = activeFilter !== null || useWebGlForLanczos;
    let usesLanczos = scaling === 'lanczos' && !usesWebgl;
    if (isIcoRow) {
      usesWebgl = false;
      usesLanczos = false;
    }
    
    const viewportNode = document.getElementById('viewport');
    if (viewportNode) {
      viewportNode.dataset.scaling = scaling;
      if (!usesWebgl) {
        viewportNode.removeAttribute('data-filter');
      }
    }

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
      if (!usesWebgl && !usesLanczos) {
        _teardownWebglCanvas();
        if (_singleTextureCache) {
          _singleTextureCache.dispose();
          _singleTextureCache = null;
        }
        pipeline.dispose();
        pipeline = null;
        needsNewPipeline = false;
      }
    }

    const filterChanged = activeFilter !== _lastActiveFilter;
    const anime4kVariant = activeFilter === 'anime4k' ? live?.config?.frontend_data?.filter_options?.anime4k?.variant : null;
    const variantChanged = anime4kVariant !== _lastAnime4kVariant;
    const scalingChanged = scaling !== _lastScalingMode;

    if (needsNewPipeline) {
      _livePumpLastDrawnFrameIndex = -1;
      if (pipeline) {
        _teardownWebglCanvas();
        if (_singleTextureCache) {
          _singleTextureCache.dispose();
          _singleTextureCache = null;
        }
        pipeline.dispose();
      }
      if (usesWebgl) {
        pipeline = createGlRuntime(filterCanvas);
        if (_singleTextureCache) {
          _singleTextureCache.dispose();
          _singleTextureCache = null;
        }
        _singleTextureCache = createTextureCache(pipeline.gl, {
          maxEntries: VIEWER_IMAGE_POOL_CAPACITY,
          maxBytes: 128 * 1024 * 1024,
        });
        if (useWebGlForLanczos) {
          pipeline.setFilter(lanczosWebGlModule);
          pipeline.filter = 'lanczos';
        } else {
          pipeline.setFilter(getFilterModule(activeFilter, live?.config?.frontend_data));
          pipeline.filter = activeFilter;
        }
      } else if (usesLanczos) {
        const fallbackDestCanvas = typeof OffscreenCanvas !== 'undefined' ? null : document.createElement('canvas');
        pipeline = createLanczosPipeline(fallbackDestCanvas);
      }
    } else if (usesWebgl && (filterChanged || variantChanged || scalingChanged)) {
      _livePumpLastDrawnFrameIndex = -1;
      if (useWebGlForLanczos) {
        pipeline.setFilter(lanczosWebGlModule);
        pipeline.filter = 'lanczos';
      } else {
        pipeline.setFilter(getFilterModule(activeFilter, live?.config?.frontend_data));
        pipeline.filter = activeFilter;
      }
    }
    
    _lastScalingMode = scaling;
    _lastActiveFilter = activeFilter;
    _lastAnime4kVariant = anime4kVariant;
    _lastIsAnimated = isAnimated;
  }

  async function _applyTransform() {
    if (_activeIcoRow || _isIcoNode(_activeSource)) return;
    if (!pipeline || pipeline.type !== 'webgl' || _lastIsAnimated || isVideoSource(_activeSource) || _isActiveSvg(Core.getState())) return;
    if (!_activeSource || !_activeSource.complete || _activeSource.naturalWidth <= 0 || _activeSource.naturalHeight <= 0) return;
    
    const src = _activeSource.currentSrc || _activeSource.src;
    if (!src) return;

    const geom = viewportState.getGeometry();
    const gen = _renderGeneration;
    const nw = _activeSource.naturalWidth;
    const nh = _activeSource.naturalHeight;

    if (!_singleTextureCache && pipeline.gl) {
      _singleTextureCache = createTextureCache(pipeline.gl, {
        maxEntries: VIEWER_IMAGE_POOL_CAPACITY,
        maxBytes: 128 * 1024 * 1024,
      });
    }

    let texEntry = _singleTextureCache ? _singleTextureCache.get(src) : null;
    if (!texEntry && _singleTextureCache) {
      try {
        texEntry = await _singleTextureCache.getOrCreate(src);
      } catch (e) {
        console.warn('Failed to load texture for single-image pipeline', e);
        return;
      }
    }
    if (gen !== _renderGeneration || !pipeline || pipeline.type !== 'webgl') return;
    if (!texEntry || !texEntry.texture) return;

    const ok = pipeline.renderFromTexture(texEntry.texture, geom, nw, nh);
    if (gen !== _renderGeneration) return;
    if (ok && filterCanvas) {
      filterCanvas.setAttribute('data-render-ready', 'true');
      const vp = document.getElementById('viewport');
      if (vp && (_lastActiveFilter || pipeline.filter === 'lanczos')) {
        vp.setAttribute('data-filter', _lastActiveFilter || pipeline.filter);
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
    if (_activeIcoRow || _isIcoNode(_activeSource)) return;
    const live = Core.getState();
    const isVideo = isVideoSource(_activeSource);
    const liveAnimated = !!live?.isAnimated || isVideo;
    const isSvg = _isActiveSvg(live);
    const scaling = getEffectiveScaling(live?.scalingMode, liveAnimated, isSvg);
    
    let activeFilter = _resolveActiveFilter(live);
    const useWebGlForLanczos = scaling === 'lanczos' && liveAnimated && !isSvg && activeFilter === null;
    const usesWebgl = activeFilter !== null || useWebGlForLanczos;
    const usesLanczos = scaling === 'lanczos' && !usesWebgl;
    
    if (useWebGlForLanczos) {
      activeFilter = 'lanczos';
    }

    if (lanczosCanvas && usesWebgl) {
      lanczosCanvas.removeAttribute('data-render-ready');
    }
    
    if (usesLanczos && _activeSource) {
      const gen = _renderGeneration;
      _renderTimeout = setTimeout(async () => {
        if (gen !== _renderGeneration) return;
        if (!_activeSource || !pipeline || pipeline.type !== 'lanczos') return;
        
        const geom = viewportState.getGeometry();
        if (lanczosCanvas) {
          const res = await pipeline.render(_activeSource, geom);
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

  let _visibilityListener = null;
  let _videoSeekListener = null;
  let _videoTimeListener = null;
  let _videoElAttached = null;

  // Loop flags land async after pump start and getState returns a copy,
  // so a captured loopCount stays stale. Prefer the live value when it
  // still describes the pumping file.
  function _readLiveLoopCount(live) {
    try {
      const now = Core.getState();
      if (now && now.src && live?.src && now.src === live.src) return now.loopCount || 0;
    } catch {
      // Fall through to the captured value.
    }
    return live?.loopCount || 0;
  }

  function _stopLivePump() {
    _livePumpGen++;
    if (_visibilityListener) {
      document.removeEventListener('visibilitychange', _visibilityListener);
      _visibilityListener = null;
    }
    if (_videoElAttached) {
      if (_videoReadyListener) _videoElAttached.removeEventListener('canplay', _videoReadyListener);
      if (_videoSeekListener) _videoElAttached.removeEventListener('seeked', _videoSeekListener);
      if (_videoTimeListener) _videoElAttached.removeEventListener('timeupdate', _videoTimeListener);
      _videoElAttached = null;
      _videoReadyListener = null;
      _videoSeekListener = null;
      _videoTimeListener = null;
    }
    if (_livePumpRaf) {
      cancelAnimationFrame(_livePumpRaf);
      _livePumpRaf = null;
    }
    if (_livePumpImg) {
      if (_livePumpImg.close) {
        try {
          _livePumpImg.close();
        } catch {
          // Already closed.
        }
      }
      if (_livePumpImg.tagName === 'IMG') _livePumpImg.classList.add('hidden');
      _livePumpImg = null;
    }
    if (_livePumpBlobUrl) {
      URL.revokeObjectURL(_livePumpBlobUrl);
      _livePumpBlobUrl = null;
    }
    _livePumpSrc = null;

    // Zero dimensions to release the off-DOM staging pixel buffer.
    // Not a visual mutation; canvas is recreated on the next pump tick.
    _liveStagingCanvas.width = 0;
    _liveStagingCanvas.height = 0;
  }

  async function _syncLivePump() {
    const live = Core.getState();
    const isVideo = isVideoSource(_activeSource);
    const isAnimated = !!live?.isAnimated;
    const isSvg = _isActiveSvg(live);
    const isMoving = isAnimated || isVideo;
    const scaling = getEffectiveScaling(live?.scalingMode, isMoving, isSvg);
    const activeFilter = _resolveActiveFilter(live);
    const useLivePump = (isMoving || isSvg) && (activeFilter !== null || scaling === 'lanczos');

    if (!useLivePump || !_activeSource) {
      _stopLivePump();
      return;
    }

    const currentSrc = _activeSource.dataset?.vidSrc || _activeSource.getAttribute('src') || _activeSource.src || '';
    if (_livePumpSrc === currentSrc) return;

    _stopLivePump();
    const gen = ++_livePumpGen;
    _livePumpSrc = currentSrc;
    _livePumpLastDrawnFrameIndex = -1;

    // --- Video Pump ---
    if (isVideo) {
      const videoEl = _activeSource;
      _videoElAttached = videoEl;
      let pumpVisible = false;
      let lastCurrentTime = -1;
      let lastGeometryHash = '';
      let lastFilter = pipeline?.filter;

      function renderFrame() {
        if (gen !== _livePumpGen || _livePumpSrc !== currentSrc || _activeSource !== videoEl) return;
        if (!pipeline || pipeline.type !== 'webgl') return;

        const vw = videoEl.videoWidth;
        const vh = videoEl.videoHeight;
        if (vw <= 0 || vh <= 0) return;

        const geom = viewportState.getGeometry();
        pipeline.updateSource(videoEl);
        pipeline.render(videoEl, geom, true);

        if (!pumpVisible) {
          pumpVisible = true;
          if (filterCanvas) filterCanvas.setAttribute('data-render-ready', 'true');
          const vpEl = document.getElementById('viewport');
          if (vpEl && (_lastActiveFilter || pipeline.filter === 'lanczos')) {
            vpEl.setAttribute('data-filter', _lastActiveFilter || pipeline.filter);
          }
        }
      }

      function startVideoLoop() {
        if (gen !== _livePumpGen || _livePumpSrc !== currentSrc) return;

        function pumpTickVideo() {
          if (gen !== _livePumpGen || _livePumpSrc !== currentSrc || _activeSource !== videoEl) return;

          if (videoEl.readyState >= 2 && videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
            const currentTime = videoEl.currentTime;
            const geom = viewportState.getGeometry();
            const geomHash = `${geom.scale}_${geom.tx}_${geom.ty}_${geom.rotation}_${geom.flipX}_${geom.flipY}_${geom.viewport?.clientWidth}_${geom.viewport?.clientHeight}`;
            const curFilter = pipeline?.filter;

            const needsRender = currentTime !== lastCurrentTime || geomHash !== lastGeometryHash || curFilter !== lastFilter || !pumpVisible;

            if (needsRender) {
              renderFrame();
              lastCurrentTime = currentTime;
              lastGeometryHash = geomHash;
              lastFilter = curFilter;
            }
          }

          _livePumpRaf = requestAnimationFrame(pumpTickVideo);
        }

        _videoSeekListener = () => renderFrame();
        _videoTimeListener = () => renderFrame();
        videoEl.addEventListener('seeked', _videoSeekListener);
        videoEl.addEventListener('timeupdate', _videoTimeListener);

        _livePumpRaf = requestAnimationFrame(pumpTickVideo);
      }

      if (videoEl.readyState >= 2 && videoEl.videoWidth > 0) {
        startVideoLoop();
      } else {
        _videoReadyListener = () => {
          _videoReadyListener = null;
          if (gen !== _livePumpGen || _livePumpSrc !== currentSrc) return;
          startVideoLoop();
        };
        videoEl.addEventListener('canplay', _videoReadyListener, { once: true });
      }
      return;
    }

    // --- SVG DOM Fallback Pump ---
    if (isSvg) {
      // SVGs cannot be parsed by WebCodecs ImageDecoder.
      // Fallback to DOM <img> drawing technique with sanitized entities and stripped foreignObject.
      let svgText = '';
      try {
        const resp = await fetch(currentSrc);
        if (gen !== _livePumpGen || _livePumpSrc !== currentSrc) return;
        svgText = await resp.text();
      } catch (e) {
        console.warn('[pump] Failed to fetch SVG:', e);
        _stopLivePump();
        return;
      }
      if (gen !== _livePumpGen || _livePumpSrc !== currentSrc) return;

      const cleanSvg = prepareSvgForCanvas(svgText);
      const blob = new Blob([cleanSvg], { type: 'image/svg+xml' });
      const blobUrl = URL.createObjectURL(blob);
      _livePumpBlobUrl = blobUrl;
      const liveImg = document.getElementById('viewer-svg-pump');
      liveImg.classList.remove('hidden');
      liveImg.src = blobUrl;
      _livePumpImg = liveImg;

      try {
        await new Promise((resolve, reject) => {
          if (liveImg.complete && liveImg.naturalWidth) resolve();
          else { liveImg.onload = resolve; liveImg.onerror = reject; }
        });
      } catch (err) {
        console.warn('[pump] Failed to load SVG image:', err);
        liveImg.classList.add('hidden');
        _stopLivePump();
        return;
      }
      if (gen !== _livePumpGen || _livePumpSrc !== currentSrc) {
        liveImg.classList.add('hidden');
        return;
      }

      let pumpVisible = false;
      let stagingCtx = null;
      let lastVpW = 0;
      let lastVpH = 0;
      let lastGeometryHash = '';
      let lastFilter = pipeline?.filter;

      const maxEdge = isAnimated ? SVG_ANIMATED_MAX_EDGE : SVG_STATIC_MAX_EDGE;

      function pumpTickSvg() {
        if (gen !== _livePumpGen || _livePumpSrc !== currentSrc) return;

        const vp = document.getElementById('viewport');
        const vpW = vp?.clientWidth || 1024;
        const vpH = vp?.clientHeight || 1024;
        const natW = liveImg.naturalWidth;
        const natH = liveImg.naturalHeight;
        // 150×150 and 300×150 are CSS replaced-element defaults, not real intrinsic SVG dimensions
        const isBrowserDefault = (natW === 150 && natH === 150) || (natW === 300 && natH === 150);
        const hasIntrinsic = natW > 0 && natH > 0 && !isBrowserDefault;

        let sw, sh;
        if (hasIntrinsic) {
          // Fit to viewport, preserving aspect ratio, capped at maxEdge
          const scale = Math.min(maxEdge / natW, maxEdge / natH, Math.max(vpW / natW, vpH / natH));
          sw = Math.max(1, Math.round(natW * scale));
          sh = Math.max(1, Math.round(natH * scale));
        } else {
          // No intrinsic dimensions. Use the display element's layout aspect ratio.
          const cw = _activeSource?.clientWidth || 150;
          const ch = _activeSource?.clientHeight || 150;
          const scale = Math.min(maxEdge / cw, maxEdge / ch, Math.max(vpW / cw, vpH / ch));
          sw = Math.max(1, Math.round(cw * scale));
          sh = Math.max(1, Math.round(ch * scale));
        }

        const geom = viewportState.getGeometry();
        const geomHash = `${geom.scale}_${geom.tx}_${geom.ty}_${geom.rotation}_${geom.flipX}_${geom.flipY}_${geom.viewport?.clientWidth}_${geom.viewport?.clientHeight}`;
        const curFilter = pipeline?.filter;

        const dimensionsChanged = _liveStagingCanvas.width !== sw || _liveStagingCanvas.height !== sh || vpW !== lastVpW || vpH !== lastVpH;
        const renderStateChanged = geomHash !== lastGeometryHash || curFilter !== lastFilter || !pumpVisible;

        if (isAnimated || dimensionsChanged || !stagingCtx) {
          if (_liveStagingCanvas.width !== sw) _liveStagingCanvas.width = sw;
          if (_liveStagingCanvas.height !== sh) _liveStagingCanvas.height = sh;
          if (!stagingCtx) stagingCtx = _liveStagingCanvas.getContext('2d');

          liveImg.width = sw;
          liveImg.height = sh;

          stagingCtx.clearRect(0, 0, sw, sh);
          stagingCtx.drawImage(liveImg, 0, 0, sw, sh);

          if (pipeline && pipeline.type === 'webgl') {
            pipeline.updateSource(_liveStagingCanvas);
          }
          lastVpW = vpW;
          lastVpH = vpH;
        }

        if (pipeline && pipeline.type === 'webgl' && (isAnimated || dimensionsChanged || renderStateChanged)) {
          // Use CSS display dimensions (set by _applySvgBounds) so the WebGL
          // geometry matches the pool image's actual display box, not the
          // browser-default naturalWidth which can be 150 for dimensionless SVGs.
          const cw = _activeSource.clientWidth || _activeSource.naturalWidth;
          const ch = _activeSource.clientHeight || _activeSource.naturalHeight;
          pipeline.render({ naturalWidth: cw, naturalHeight: ch }, geom, true);

          if (!pumpVisible) {
            pumpVisible = true;
            if (filterCanvas) filterCanvas.setAttribute('data-render-ready', 'true');
            const vpEl = document.getElementById('viewport');
            if (vpEl && (_lastActiveFilter || pipeline.filter === 'lanczos')) vpEl.setAttribute('data-filter', _lastActiveFilter || pipeline.filter);
          }
          lastGeometryHash = geomHash;
          lastFilter = curFilter;
        }
        _livePumpRaf = requestAnimationFrame(pumpTickSvg);
      }
      _livePumpRaf = requestAnimationFrame(pumpTickSvg);
      return;
    }

    // --- Raster WebCodecs Pump (GIF/APNG/WebP/AVIF) ---
    if (typeof ImageDecoder === 'undefined') {
      _lastIsAnimated = false;
      _stopLivePump();
      _scheduleTransform();
      _triggerRender();
      return;
    }

    let resp;
    try {
      resp = await fetch(currentSrc);
    } catch {
      _stopLivePump();
      return;
    }
    if (gen !== _livePumpGen || _livePumpSrc !== currentSrc) return;
    const ext = currentSrc.split('.').pop().toLowerCase().split('?')[0];
    let contentType = 'image/gif';
    if (ext === 'webp') contentType = 'image/webp';
    else if (ext === 'png' || ext === 'apng') contentType = 'image/png';
    else if (ext === 'avif') contentType = 'image/avif';

    let decoder;
    try {
      decoder = new ImageDecoder({ data: resp.body, type: contentType });
      await decoder.completed;
    } catch (e) {
      console.warn('[pump] ImageDecoder failed:', e.message);
      _lastIsAnimated = false;
      _stopLivePump();
      _scheduleTransform();
      _triggerRender();
      return;
    }
    if (gen !== _livePumpGen || _livePumpSrc !== currentSrc) {
      try {
        decoder.close();
      } catch {
        // Already closed.
      }
      return;
    }

    const track = decoder.tracks.selectedTrack;
    const frameCount = track.frameCount;
    if (frameCount < 2) { 
      try {
        decoder.close();
      } catch {
        // Already closed.
      }
      _lastIsAnimated = false;
      _stopLivePump();
      _scheduleTransform();
      _triggerRender();
      return; 
    }

    _livePumpImg = decoder;

    let frameIndex = 0;
    let currentLoopIteration = 1;
    let lastFrameTime = performance.now();
    let frameDurationMs = 100;
    let pumpVisible = false;
    let lastGeometryHash = '';

    _visibilityListener = () => {
      if (document.visibilityState === 'visible') lastFrameTime = performance.now();
    };
    document.addEventListener('visibilitychange', _visibilityListener);

    async function pumpTick() {
      if (gen !== _livePumpGen || _livePumpSrc !== currentSrc) return;

      const now = performance.now();
      let elapsed = now - lastFrameTime;

      if (elapsed > 1000) {
        lastFrameTime = now;
        elapsed = 0;
      }

      let frameChanged = false;
      // loopCount arrives async after pump start (getState returns a copy),
      // so read it fresh or a play-once GIF loops forever on first visit.
      const loopCount = _readLiveLoopCount(live);
      while (elapsed >= frameDurationMs) {
        if (frameIndex < frameCount - 1) {
          frameIndex++;
        } else if (loopCount === 0 || currentLoopIteration < loopCount) {
          frameIndex = 0;
          currentLoopIteration++;
        } else {
          break;
        }
        elapsed -= frameDurationMs;
        frameChanged = true;
      }

      if (frameChanged) {
        lastFrameTime = now - elapsed;
      }

      let vf;
      try {
        const result = await decoder.decode({ frameIndex });
        vf = result.image;
      } catch {
        // If decoding fails (e.g. decoder closed or corrupt frame), stop the pump.
        return;
      }
      if (gen !== _livePumpGen || _livePumpSrc !== currentSrc) {
        try {
          vf.close();
        } catch {
          // Already closed.
        }
        return;
      }

      const geom = viewportState.getGeometry();
      const geomHash = `${geom.scale}_${geom.tx}_${geom.ty}_${geom.rotation}_${geom.flipX}_${geom.flipY}`;
      
      const needsRender = frameIndex !== _livePumpLastDrawnFrameIndex || geomHash !== lastGeometryHash;
      if (!needsRender) {
        vf.close();
        _livePumpRaf = requestAnimationFrame(pumpTick);
        return;
      }

      if (vf.duration) frameDurationMs = Math.max(10, vf.duration / 1000);

      if (frameIndex !== _livePumpLastDrawnFrameIndex) {
        if (pipeline && pipeline.type === 'webgl') {
          pipeline.updateSource(vf);
        }
      }
      vf.close();

      if (pipeline && pipeline.type === 'webgl') {
        pipeline.render(_activeSource, geom, true);

        if (!pumpVisible) {
          pumpVisible = true;
          if (filterCanvas) filterCanvas.setAttribute('data-render-ready', 'true');
          const vp = document.getElementById('viewport');
          if (vp && (_lastActiveFilter || pipeline.filter === 'lanczos')) vp.setAttribute('data-filter', _lastActiveFilter || pipeline.filter);
        }
      }

      _livePumpLastDrawnFrameIndex = frameIndex;
      lastGeometryHash = geomHash;

      _livePumpRaf = requestAnimationFrame(pumpTick);
    }
    _livePumpRaf = requestAnimationFrame(pumpTick);
  }

  Core.onStateChange((state) => {
    const enteringManhwa = !!state.manhwaEnabled && !_columnWasManhwa;
    const exitingManhwa = !state.manhwaEnabled && _columnWasManhwa;
    _columnWasManhwa = !!state.manhwaEnabled;
    if (state.manhwaEnabled) {
      // Legacy pipeline parks. The column pipeline takes over from here.
      _cancelRender();
      _stopLivePump();
      if (enteringManhwa) {
        // Drop the stale legacy marker. It would hide the parked bridge
        // and the mounting slots while the column has not painted yet,
        // blanking the whole viewport. The first column paint re-sets it.
        const vp = document.getElementById('viewport');
        if (vp && vp.hasAttribute('data-filter')) vp.removeAttribute('data-filter');
        // Bridge the filtered frame: keep the legacy canvas up until the
        // column paints. Opacity still follows data-render-ready, so this
        // is a no-op when the legacy canvas never painted.
        if (vp) vp.classList.add('manhwa-warmup');
      }
      const containerKey = _columnKeyFor(state);
      const containerChanged = _columnContainerKey !== null && containerKey !== _columnContainerKey;
      if (containerChanged) {
        // Directory/archive switch: drop the previous column frame now.
        // The strip rebuilds behind the width gate while the canvas would
        // otherwise keep showing the old folder as a ghost until the first
        // new paint lands. Generation bump also aborts in-flight renders.
        _teardownColumn();
      }
      _columnContainerKey = containerKey;
      _syncColumnPipeline(state);
      if (!_columnPipeline) {
        // No WebGL column (filter off, bilinear): nothing to wait for.
        document.getElementById('viewport')?.classList.remove('manhwa-warmup');
      }
      if (containerChanged && _columnFilter) {
        // Teardown cleared the marker. Keep slots hidden behind the blank
        // canvas until the new column paints.
        const vp = document.getElementById('viewport');
        if (vp && vp.getAttribute('data-filter') !== _columnFilter) {
          vp.setAttribute('data-filter', _columnFilter);
        }
      }
      _requestColumnRender();
      return;
    }
    if (exitingManhwa) {
      _teardownWebglCanvas();
    }
    _columnContainerKey = null;

    if (_columnPipeline || _columnVisible) {
      const hadFrame = _columnVisible;
      _teardownColumn();
      if (hadFrame) {
        // Markers still hold pre-manhwa values and the legacy overlay was
        // cleared on entry, so repaint once instead of trusting the diff.
        _cancelRender();
        _applyScaling();
        _scheduleTransform();
        _triggerRender();
        _syncLivePump();
        return;
      }
    }

    const newFilter = _resolveActiveFilter(state);
    const isVideo = isVideoSource(_activeSource);
    const newIsAnimated = !!state.isAnimated;
    const newIsSvg = _isActiveSvg(state);
    const newScaling = getEffectiveScaling(state.scalingMode, newIsAnimated || isVideo, newIsSvg);
    const newVariant = newFilter === 'anime4k' ? state?.config?.frontend_data?.filter_options?.anime4k?.variant : null;
    
    if (newFilter !== _lastActiveFilter || newIsAnimated !== _lastIsAnimated || newScaling !== _lastScalingMode || newVariant !== _lastAnime4kVariant) {
      _cancelRender();
      _applyScaling(newFilter, newIsAnimated);
      _scheduleTransform();
      _triggerRender();
      _syncLivePump();
    }
  });

  // Pan path is render, not rebuild. Keep the current canvas visible while
  // the transform updates. Clearing here flashed the base image every pan
  // tick and doubled the LCP candidate on zoom.
  viewportState.subscribe(() => {
    if (Core.getState()?.manhwaEnabled) {
      // Keep the last column frame up while scrolling. The debounced
      // render below swaps the new frame in.
      _requestColumnRender();
      return;
    }
    _cancelPendingRender();
    _scheduleTransform();
    _triggerRender();
  });

  if (typeof window !== 'undefined' && window.addEventListener) {
    // Decode corrections rebuild layout without a viewport tick. Repaint
    // the column so the composite tracks the corrected offsets.
    window.addEventListener('quivit-manhwa-settle', () => {
      _requestColumnRender();
    });
  }

  // --- Manhwa column pipeline: textured quad composition into FBO ---
  // Renders visible slot quads into an offscreen FBO at viewport resolution
  // using bilinear hardware sampling, then runs the active post-processing
  // filter shader once over that composite texture. Textures are managed by
  // TextureCache with LRU VRAM budgeting.
  let _columnSourceProvider = null;
  let _columnPipeline = null;
  let _columnFilter = null;
  let _columnAnime4kVariant = null;
  let _columnScaling = null;
  let _columnVisible = false;
  let _columnRafId = 0;
  let _columnGeneration = 0;
  /** Container the column canvas was painted for. A switch drops the old
   * frame so the previous folder never lingers as a ghost while the strip
   * rebuilds behind the width gate. */
  let _columnContainerKey = null;
  /** Previous notify's manhwa state. Detects the legacy-to-manhwa edge so
   * entry work runs once instead of on every notify while active. */
  let _columnWasManhwa = false;

  function _columnKeyFor(state) {
    if (!state) return null;
    const container = state.mode === 'archive' ? (state.archivePath || '') : (state.directory || '');
    return `${state.mode || ''}|${container}|${state.archiveEncryption || ''}`;
  }
  let _columnTextureCache = null;
  let _columnQuadCompositor = null;
  const _columnLiveTextures = new Map();
  /** Max animated raster slots decoding concurrently. Excess falls back to static. */
  const MAX_CONCURRENT_LIVE_ANIMATED = 3;
  /** Map from imgIdx to live raster session { decoder, frameCount, loopCount, currentLoop, frameIndex, frameDurationMs, lastTime, src, needsUpload }. */
  const _columnAnimSessions = new Map();
  /** imgIdx with decoder creation in flight. Prevents fetch storms. */
  const _columnAnimPending = new Set();
  /** imgIdx that proved single-frame. Skips decoder retry, uses static cache. */
  const _columnAnimStatic = new Set();
  /** Map from imgIdx to live SVG session { img, blobUrl, staging, stagingCtx, src, width, height }. */
  const _columnSvgSessions = new Map();
  /** imgIdx with SVG fetch in flight. Prevents fetch storms. */
  const _columnSvgPending = new Set();
  /** Viewport geometry of the previous column pass. Detects pan/zoom renders. */
  const _columnLastGeom = { scale: 0, tx: 0, ty: 0, vpW: 0, vpH: 0 };
  let _columnLiveLoopId = 0;
  let _columnHasLive = false;
  let _columnRenderInFlight = false;
  let _columnCompositeFbo = null;
  const _columnCanvas = document.getElementById('manhwa-filter-canvas');
  if (_columnCanvas) {
    _columnCanvas.addEventListener('webglcontextlost', (e) => {
      e.preventDefault();
    });
    _columnCanvas.addEventListener('webglcontextrestored', () => {
      _teardownColumnCanvas();
      if (_columnPipeline) { _columnPipeline.dispose(); _columnPipeline = null; }
      _columnFilter = null;
      _columnLiveTextures.clear();
      _scratchStaleIdx.length = 0;
      for (const imgIdx of _columnAnimSessions.keys()) _scratchStaleIdx.push(imgIdx);
      for (let i = 0; i < _scratchStaleIdx.length; i++) _closeColumnAnimSession(_scratchStaleIdx[i]);
      _columnAnimPending.clear();
      _columnAnimStatic.clear();
      _scratchStaleIdx.length = 0;
      for (const imgIdx of _columnSvgSessions.keys()) _scratchStaleIdx.push(imgIdx);
      for (let i = 0; i < _scratchStaleIdx.length; i++) _closeColumnSvgSession(_scratchStaleIdx[i]);
      _columnSvgPending.clear();
      _syncColumnPipeline(Core.getState());
      _requestColumnRender();
    });
  }

  function _resolveColumnFilter(state) {
    if (!state) return null;
    const fd = state.config?.frontend_data;
    if (!fd) return null;
    return activeFilterId(fd);
  }

  function _columnNeedsWebGL(state) {
    if (!state) return false;
    if (_resolveColumnFilter(state) !== null) return true;
    return state.scalingMode === 'lanczos';
  }

  function _teardownColumnCanvas() {
    if (!_columnCanvas) return;
    _columnCanvas.removeAttribute('data-render-ready');
    const gl = _columnCanvas.getContext('webgl2');
    if (gl) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      _columnCanvas.width = _columnCanvas.width;
    }
  }

  function _ensureColumnCompositeFbo(gl, width, height) {
    if (!_columnCompositeFbo || _columnCompositeFbo.width !== width || _columnCompositeFbo.height !== height) {
      if (_columnCompositeFbo) {
        if (_columnCompositeFbo.tex) gl.deleteTexture(_columnCompositeFbo.tex);
        if (_columnCompositeFbo.fbo) gl.deleteFramebuffer(_columnCompositeFbo.fbo);
      }
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);

      const fbo = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);

      _columnCompositeFbo = { fbo, tex, width, height };
    }
    return _columnCompositeFbo;
  }

  function _columnAnimMimeFor(src, item) {
    const name = (item?.entry?.name || item?.entry?.path || src || '').toLowerCase().split('?')[0];
    if (name.endsWith('.webp')) return 'image/webp';
    if (name.endsWith('.png') || name.endsWith('.apng')) return 'image/png';
    if (name.endsWith('.avif')) return 'image/avif';
    return 'image/gif';
  }

  function _closeColumnAnimSession(imgIdx) {
    const session = _columnAnimSessions.get(imgIdx);
    if (session) {
      try {
        session.decoder?.close();
      } catch {
        // Already closed.
      }
      _columnAnimSessions.delete(imgIdx);
    }
    _columnAnimPending.delete(imgIdx);
  }

  function _pruneColumnAnimSessions(liveSlots, liveTypes) {
    _scratchStaleIdx.length = 0;
    for (const imgIdx of _columnAnimSessions.keys()) {
      if (!liveSlots?.has(imgIdx) || liveTypes?.get(imgIdx) !== 'raster') {
        _scratchStaleIdx.push(imgIdx);
      }
    }
    for (let i = 0; i < _scratchStaleIdx.length; i++) {
      _closeColumnAnimSession(_scratchStaleIdx[i]);
    }
    _scratchStaleIdx.length = 0;
    for (const imgIdx of _columnAnimStatic) {
      if (!liveSlots?.has(imgIdx)) _scratchStaleIdx.push(imgIdx);
    }
    for (let i = 0; i < _scratchStaleIdx.length; i++) {
      _columnAnimStatic.delete(_scratchStaleIdx[i]);
    }
  }

  function _closeColumnSvgSession(imgIdx) {
    const session = _columnSvgSessions.get(imgIdx);
    if (session) {
      if (session.blobUrl) {
        try {
          URL.revokeObjectURL(session.blobUrl);
        } catch {
          // Already revoked.
        }
      }
      try {
        session.img?.remove();
      } catch {
        // Already removed.
      }
      if (session.staging) {
        session.staging.width = 0;
        session.staging.height = 0;
      }
      _columnSvgSessions.delete(imgIdx);
    }
    _columnSvgPending.delete(imgIdx);
  }

  // SVGs are ignored under lanczos and anime4k: those slots keep native
  // DOM rendering while the column canvas leaves their region clear.
  function _columnSvgBypassed() {
    return _columnFilter === 'lanczos' || _columnFilter === 'anime4k';
  }

  function _pruneColumnSvgSessions(liveSlots, liveTypes) {
    _scratchStaleIdx.length = 0;
    for (const imgIdx of _columnSvgSessions.keys()) {
      if (!liveSlots?.has(imgIdx) || liveTypes?.get(imgIdx) !== 'svg') {
        _scratchStaleIdx.push(imgIdx);
      }
    }
    for (let i = 0; i < _scratchStaleIdx.length; i++) {
      _closeColumnSvgSession(_scratchStaleIdx[i]);
    }
  }

  // Establishes an SVG pump session off the render path. Fetches the source,
  // sanitizes it, and holds a blob-backed Image plus a capped 2D staging
  // canvas. Renders sample the Image each frame so SMIL keeps moving.
  function _launchColumnSvgSession(imgIdx, item, src, gen) {
    if (_columnSvgSessions.has(imgIdx) || _columnSvgPending.has(imgIdx)) return;
    _columnSvgPending.add(imgIdx);
    (async () => {
      let blobUrl = null;
      let pumpImg = null;
      const discardPumpImg = () => {
        if (!pumpImg) return;
        try {
          pumpImg.remove();
        } catch {
          // Already removed.
        }
        pumpImg = null;
      };
      const done = (session) => {
        _columnSvgPending.delete(imgIdx);
        if (gen !== _columnGeneration || !Core.getState()?.manhwaEnabled) {
          const urlToRevoke = session?.blobUrl || blobUrl;
          if (urlToRevoke) {
            try {
              URL.revokeObjectURL(urlToRevoke);
            } catch {
              // Already revoked.
            }
          }
          discardPumpImg();
          try {
            session?.img?.remove();
          } catch {
            // Already removed.
          }
          return;
        }
        if (!session) {
          discardPumpImg();
          return;
        }
        _columnSvgSessions.set(imgIdx, session);
        _requestColumnRender();
      };
      try {
        const resp = await fetch(src);
        if (!resp.ok) {
          done(null);
          return;
        }
        if (gen !== _columnGeneration) {
          done(null);
          return;
        }
        const text = await resp.text();
        const cleanSvg = prepareSvgForCanvas(text);
        if (!cleanSvg) {
          done(null);
          return;
        }
        const blob = new Blob([cleanSvg], { type: 'image/svg+xml' });
        blobUrl = URL.createObjectURL(blob);
        pumpImg = new Image();
        pumpImg.crossOrigin = 'anonymous';
        // The pump image stays in the render tree so SMIL keeps advancing.
        // Detached images can stall on the first frame.
        const pumpLayer = document.getElementById('manhwa-svg-pump-layer');
        if (pumpLayer) pumpLayer.appendChild(pumpImg);
        pumpImg.src = blobUrl;
        try {
          await new Promise((resolve, reject) => {
            if (pumpImg.complete && pumpImg.naturalWidth) resolve();
            else {
              pumpImg.onload = resolve;
              pumpImg.onerror = reject;
            }
          });
        } catch {
          try {
            URL.revokeObjectURL(blobUrl);
          } catch {
            // Already revoked.
          }
          discardPumpImg();
          done(null);
          return;
        }
        if (gen !== _columnGeneration) {
          try {
            URL.revokeObjectURL(blobUrl);
          } catch {
            // Already revoked.
          }
          discardPumpImg();
          done(null);
          return;
        }
        const { width: w, height: h } = resolveSvgDimensions(
          pumpImg.naturalWidth,
          pumpImg.naturalHeight,
          cleanSvg,
          SVG_ANIMATED_MAX_EDGE
        );
        const staging = document.createElement('canvas');
        staging.width = w;
        staging.height = h;
        const stagingCtx = staging.getContext('2d');
        if (!stagingCtx) {
          try {
            URL.revokeObjectURL(blobUrl);
          } catch {
            // Already revoked.
          }
          discardPumpImg();
          done(null);
          return;
        }
        done({ img: pumpImg, blobUrl, staging, stagingCtx, src, width: w, height: h });
      } catch {
        if (blobUrl) {
          try {
            URL.revokeObjectURL(blobUrl);
          } catch {
            // Already revoked.
          }
        }
        discardPumpImg();
        done(null);
      }
    })();
  }

  function _ensureColumnLiveTexture(gl, imgIdx, w, h) {
    let entry = _columnLiveTextures.get(imgIdx);
    if (!entry) {
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      entry = { texture: tex, width: w, height: h };
      _columnLiveTextures.set(imgIdx, entry);
      return entry;
    }
    gl.bindTexture(gl.TEXTURE_2D, entry.texture);
    if (entry.width !== w || entry.height !== h) {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      entry.width = w;
      entry.height = h;
    }
    return entry;
  }

  // Establishes a raster session off the render path. Renders never await
  // this: establishment costs a fetch plus a full header parse, which stalls
  // pan frames behind the gesture. Callers paint the static frame meanwhile;
  // completion kicks a fresh render through the live session.
  function _launchColumnAnimSession(imgIdx, item, src, gen) {
    if (_columnAnimSessions.has(imgIdx) || _columnAnimPending.has(imgIdx)) return;
    if (_columnAnimStatic.has(imgIdx)) return;
    if (typeof ImageDecoder === 'undefined') {
      _columnAnimStatic.add(imgIdx);
      return;
    }
    _columnAnimPending.add(imgIdx);
    (async () => {
      let decoder = null;
      const done = (session) => {
        _columnAnimPending.delete(imgIdx);
        if (gen !== _columnGeneration || !Core.getState()?.manhwaEnabled) {
          if (session) {
            try {
              session.decoder?.close();
            } catch {
              // Already closed.
            }
          }
          return;
        }
        if (!session) {
          _columnAnimStatic.add(imgIdx);
          return;
        }
        _columnAnimSessions.set(imgIdx, session);
        _requestColumnRender();
      };
      try {
        const resp = await fetch(src);
        if (!resp.ok) {
          done(null);
          return;
        }
        if (gen !== _columnGeneration) {
          done(null);
          return;
        }
        const contentType = _columnAnimMimeFor(src, item);
        decoder = new ImageDecoder({ data: resp.body, type: contentType });
        await decoder.completed;
        if (gen !== _columnGeneration) {
          try {
            decoder.close();
          } catch {
            // Already closed.
          }
          done(null);
          return;
        }
        const track = decoder.tracks?.selectedTrack;
        const frameCount = track?.frameCount || 0;
        if (frameCount < 2) {
          try {
            decoder.close();
          } catch {
            // Already closed.
          }
          done(null);
          return;
        }
        let loopCount = 0;
        try {
          const st = Core.getState() || {};
          const isArchive = st.mode === 'archive' && st.archivePath;
          const pathArg = isArchive
            ? (item?.entry?.name || item?.entry?.path)
            : (item?.entry?.path || item?.entry?.name);
          const archiveArg = isArchive ? st.archivePath : null;
          if (pathArg) {
            const status = await Core.checkIsAnimated(pathArg, archiveArg);
            if (gen !== _columnGeneration) {
              try {
                decoder.close();
              } catch {
                // Already closed.
              }
              done(null);
              return;
            }
            loopCount = status?.loop_count || 0;
          }
        } catch {
          loopCount = 0;
        }
        done({
          decoder,
          frameCount,
          loopCount,
          currentLoop: 1,
          frameIndex: 0,
          frameDurationMs: 100,
          lastTime: performance.now(),
          src,
          needsUpload: true,
        });
      } catch {
        if (decoder) {
          try {
            decoder.close();
          } catch {
            // Already closed.
          }
        }
        done(null);
      }
    })();
  }

  function _teardownColumn() {
    _columnGeneration++;
    document.getElementById('viewport')?.classList.remove('manhwa-warmup');
    if (_columnRafId) {
      cancelAnimationFrame(_columnRafId);
      _columnRafId = 0;
    }
    if (_columnLiveLoopId) {
      cancelAnimationFrame(_columnLiveLoopId);
      _columnLiveLoopId = 0;
    }
    _columnHasLive = false;
    _cachedDrawsScratch.length = 0;
    _liveDrawsScratch.length = 0;
    _scratchStaleIdx.length = 0;
    for (const imgIdx of _columnAnimSessions.keys()) _scratchStaleIdx.push(imgIdx);
    for (let i = 0; i < _scratchStaleIdx.length; i++) _closeColumnAnimSession(_scratchStaleIdx[i]);
    _columnAnimPending.clear();
    _columnAnimStatic.clear();
    _scratchStaleIdx.length = 0;
    for (const imgIdx of _columnSvgSessions.keys()) _scratchStaleIdx.push(imgIdx);
    for (let i = 0; i < _scratchStaleIdx.length; i++) _closeColumnSvgSession(_scratchStaleIdx[i]);
    _columnSvgPending.clear();
    _columnLastGeom.scale = 0;
    _columnLastGeom.tx = 0;
    _columnLastGeom.ty = 0;
    _columnLastGeom.vpW = 0;
    _columnLastGeom.vpH = 0;
    if (_columnPipeline?.gl) {
      const gl = _columnPipeline.gl;
      for (const entry of _columnLiveTextures.values()) {
        if (entry.texture) gl.deleteTexture(entry.texture);
      }
    }
    _columnLiveTextures.clear();
    if (_columnCompositeFbo && _columnPipeline?.gl) {
      const gl = _columnPipeline.gl;
      if (_columnCompositeFbo.tex) gl.deleteTexture(_columnCompositeFbo.tex);
      if (_columnCompositeFbo.fbo) gl.deleteFramebuffer(_columnCompositeFbo.fbo);
    }
    _columnCompositeFbo = null;
    _teardownColumnCanvas();
    if (_columnQuadCompositor) {
      _columnQuadCompositor.dispose();
      _columnQuadCompositor = null;
    }
    if (_columnTextureCache) {
      _columnTextureCache.dispose();
      _columnTextureCache = null;
    }
    if (_columnPipeline) {
      _columnPipeline.dispose();
      _columnPipeline = null;
    }
    if (_columnVisible) {
      _columnVisible = false;
      const vp = document.getElementById('viewport');
      if (vp && _columnFilter && vp.getAttribute('data-filter') === _columnFilter) {
        vp.removeAttribute('data-filter');
      }
    }
    _columnFilter = null;
    _columnAnime4kVariant = null;
    _columnScaling = null;
  }

  function _syncColumnPipeline(state) {
    if (!state || !state.manhwaEnabled || !_columnCanvas) {
      _teardownColumn();
      return;
    }
    const needs = _columnNeedsWebGL(state);
    if (!needs) {
      _teardownColumn();
      return;
    }
    const filter = _resolveColumnFilter(state);
    const scaling = state.scalingMode;
    const variant = filter === 'anime4k' ? state?.config?.frontend_data?.filter_options?.anime4k?.variant : null;
    const wantFilter = filter !== null ? filter : 'lanczos';
    if (!_columnPipeline) {
      _columnPipeline = createGlRuntime(_columnCanvas);
    }
    const gl = _columnPipeline.gl;
    if (gl) {
      if (!_columnQuadCompositor) {
        _columnQuadCompositor = createQuadCompositor(gl);
      }
      if (!_columnTextureCache) {
        _columnTextureCache = createTextureCache(gl, { maxBytes: COLUMN_TEXTURE_CACHE_BYTES });
      }
    }
    if (_columnPipeline.filter !== wantFilter || variant !== _columnAnime4kVariant) {
      if (wantFilter === 'lanczos') {
        _columnPipeline.setFilter(lanczosWebGlModule);
      } else {
        _columnPipeline.setFilter(getFilterModule(filter, state?.config?.frontend_data));
      }
      _columnPipeline.filter = wantFilter;
      _columnAnime4kVariant = variant;
    }
    _columnFilter = wantFilter;
    _columnScaling = scaling;
  }

  function _requestColumnRender() {
    const st = Core.getState();
    if (!st?.manhwaEnabled || !_columnPipeline) return;
    if (_columnRafId) return;
    _columnRafId = requestAnimationFrame(() => {
      _columnRafId = 0;
      if (!Core.getState()?.manhwaEnabled) return;
      if (!_columnPipeline) return;
      _renderColumn();
      _syncColumnLiveLoop();
    });
  }

  /** Run a continuous rAF loop while any visible slot is live (video, animated,
   * SVG). The loop re-renders the full column each frame so live frames stay
   * current under the filter. Stops itself when no live draws remain. */
  function _syncColumnLiveLoop() {
    if (!_columnHasLive) {
      if (_columnLiveLoopId) {
        cancelAnimationFrame(_columnLiveLoopId);
        _columnLiveLoopId = 0;
      }
      return;
    }
    if (_columnLiveLoopId) return;
    function tick() {
      _columnLiveLoopId = 0;
      if (!Core.getState()?.manhwaEnabled || !_columnPipeline || !_columnHasLive) return;
      _renderColumn();
      if (_columnHasLive) {
        _columnLiveLoopId = requestAnimationFrame(tick);
      }
    }
    _columnLiveLoopId = requestAnimationFrame(tick);
  }

  async function _renderColumn() {
    if (_columnRenderInFlight) return;
    _columnRenderInFlight = true;
    try {
      await _renderColumnInner();
    } finally {
      _columnRenderInFlight = false;
    }
  }

  async function _renderColumnInner() {
    const state = Core.getState();
    if (!state?.manhwaEnabled || !_columnPipeline || !_columnFilter) return;
    const gen = _columnGeneration;
    const vp = document.getElementById('viewport');
    const vpW = vp?.clientWidth || 0;
    const vpH = vp?.clientHeight || 0;
    if (vpW <= 0 || vpH <= 0) return;

    if (_columnCanvas && (_columnCanvas.width !== vpW || _columnCanvas.height !== vpH)) {
      _columnCanvas.width = vpW;
      _columnCanvas.height = vpH;
      _columnCanvas.style.removeProperty('width');
      _columnCanvas.style.removeProperty('height');
    }

    const snap = _columnSourceProvider ? _columnSourceProvider() : null;
    if (!snap || !snap.offsets || snap.offsets.length === 0) {
      if (_columnVisible) _teardownColumn();
      return;
    }

    const scale = viewportState.getScale() || 1;
    const tx = viewportState.getTx() || 0;
    const ty = viewportState.getTy() || 0;
    // A pan/zoom render must track the gesture, not the animation clock.
    // Decoding here stalls the frame behind the finger and reads as ghosting.
    const viewportMoved = _columnLastGeom.scale !== scale || _columnLastGeom.tx !== tx ||
      _columnLastGeom.ty !== ty || _columnLastGeom.vpW !== vpW || _columnLastGeom.vpH !== vpH;
    _columnLastGeom.scale = scale;
    _columnLastGeom.tx = tx;
    _columnLastGeom.ty = ty;
    _columnLastGeom.vpW = vpW;
    _columnLastGeom.vpH = vpH;
    const { drawList } = computeColumnComposite({
      offsets: snap.offsets,
      totalHeight: snap.totalHeight,
      columnWidth: snap.columnWidth,
      viewportWidth: vpW,
      viewportHeight: vpH,
      scale,
      tx,
      ty,
      overscan: 0,
      items: snap.items,
    });
    if (!drawList || drawList.length === 0) return;

    const gl = _columnPipeline.gl;
    if (!gl || !_columnQuadCompositor || !_columnTextureCache) return;

    // Prune entries in _columnLiveTextures whose imgIdx is no longer present in snap.liveSlots.
    if (_columnLiveTextures.size > 0) {
      for (const [imgIdx, entry] of _columnLiveTextures.entries()) {
        if (!snap.liveSlots || !snap.liveSlots.has(imgIdx)) {
          if (entry.texture) gl.deleteTexture(entry.texture);
          _columnLiveTextures.delete(imgIdx);
        }
      }
    }
    _pruneColumnAnimSessions(snap.liveSlots, snap.liveTypes);
    _pruneColumnSvgSessions(snap.liveSlots, snap.liveTypes);

    // Partition draws into cached stills, live videos, live SVG pumps, and live rasters.
    _cachedDrawsScratch.length = 0;
    _liveDrawsScratch.length = 0;
    _rasterCandidatesScratch.length = 0;
    _svgCandidatesScratch.length = 0;
    _activeRastersScratch.length = 0;
    _activeSvgsScratch.length = 0;
    _failedRastersScratch.length = 0;
    let hasLive = false;
    const svgBypassed = _columnSvgBypassed();
    if (svgBypassed) {
      _scratchStaleIdx.length = 0;
      for (const imgIdx of _columnSvgSessions.keys()) _scratchStaleIdx.push(imgIdx);
      for (let i = 0; i < _scratchStaleIdx.length; i++) _closeColumnSvgSession(_scratchStaleIdx[i]);
      _columnSvgPending.clear();
    }
    for (const draw of drawList) {
      const node = snap.nodes.get(draw.imgIdx);
      if (!node) continue;
      if (_isIcoNode(node)) continue;
      const item = snap.items ? snap.items[draw.imgIdx] : null;
      const entryName = item?.entry?.name || item?.entry?.path || '';
      if (entryName && entryName.toLowerCase().endsWith('.ico')) continue;
      const isLive = snap.liveSlots?.has(draw.imgIdx);
      if (!isLive) {
        const src = node.currentSrc || node.src;
        if (src) {
          const item = snap.items ? snap.items[draw.imgIdx] : null;
          const isSvg = isSvgSource(src, item);
          // Ignored SVGs keep native DOM rendering; the canvas stays clear.
          if (isSvg && svgBypassed) continue;
          _cachedDrawsScratch.push({ draw, node, src, isSvg });
        }
        continue;
      }
      const liveType = snap.liveTypes?.get(draw.imgIdx);
      if (liveType === 'raster') {
        const src = node.currentSrc || node.src;
        if (!src) continue;
        const item = snap.items ? snap.items[draw.imgIdx] : null;
        _rasterCandidatesScratch.push({ draw, node, src, item });
        continue;
      }
      if (liveType === 'svg') {
        const src = node.currentSrc || node.src;
        if (!src) continue;
        const item = snap.items ? snap.items[draw.imgIdx] : null;
        _svgCandidatesScratch.push({ draw, node, src, item });
        continue;
      }
      _liveDrawsScratch.push({ draw, node });
      hasLive = true;
    }
    // Bounded animated raster sessions closest to the viewport center first.
    // Snapshot carries no anchor index, so center proximity is the stand-in.
    // Sessions establish off-path (see _launchColumnAnimSession); this pass
    // only uses sessions that already exist. Anything else paints static.
    _rasterCandidatesScratch.sort((a, b) => {
      const aRect = a.draw.destRect || {};
      const bRect = b.draw.destRect || {};
      const aCy = (aRect.y ?? aRect.dy ?? 0) + ((aRect.height ?? aRect.dh ?? 0) / 2);
      const bCy = (bRect.y ?? bRect.dy ?? 0) + ((bRect.height ?? bRect.dh ?? 0) / 2);
      return Math.abs(aCy - vpH / 2) - Math.abs(bCy - vpH / 2);
    });
    for (let i = 0; i < _rasterCandidatesScratch.length; i++) {
      const cand = _rasterCandidatesScratch[i];
      if (_activeRastersScratch.length >= MAX_CONCURRENT_LIVE_ANIMATED || _columnAnimStatic.has(cand.draw.imgIdx)) {
        _cachedDrawsScratch.push({ draw: cand.draw, node: cand.node, src: cand.src, isSvg: false });
        continue;
      }
      const session = _columnAnimSessions.get(cand.draw.imgIdx);
      if (session && session.src !== cand.src) _closeColumnAnimSession(cand.draw.imgIdx);
      const ready = _columnAnimSessions.get(cand.draw.imgIdx);
      if (!ready) {
        if (_columnAnimSessions.size + _columnAnimPending.size < MAX_CONCURRENT_LIVE_ANIMATED) {
          _launchColumnAnimSession(cand.draw.imgIdx, cand.item, cand.src, gen);
        }
        const src = cand.node.currentSrc || cand.node.src;
        if (src) _cachedDrawsScratch.push({ draw: cand.draw, node: cand.node, src, isSvg: false });
        continue;
      }
      cand.session = ready;
      _activeRastersScratch.push(cand);
      hasLive = true;
    }
    // Sessions exist only for the active window. Anything else closes so at
    // most 3 decoders stay open and scrolled-out slots release theirs.
    if (_columnAnimSessions.size > 0) {
      _scratchActiveIdx.clear();
      for (let i = 0; i < _activeRastersScratch.length; i++) {
        _scratchActiveIdx.add(_activeRastersScratch[i].draw.imgIdx);
      }
      _scratchStaleIdx.length = 0;
      for (const imgIdx of _columnAnimSessions.keys()) {
        if (!_scratchActiveIdx.has(imgIdx)) _scratchStaleIdx.push(imgIdx);
      }
      for (let i = 0; i < _scratchStaleIdx.length; i++) {
        _closeColumnAnimSession(_scratchStaleIdx[i]);
      }
    }
    // SVG pump sessions establish off-path through blob URLs so the staging
    // canvas never sees a tainted quivit:// source. Missing sessions paint
    // their static frame until the pump is ready. Ignored SVGs (lanczos,
    // anime4k) skip the column entirely and keep native DOM rendering.
    if (!svgBypassed) {
      for (let i = 0; i < _svgCandidatesScratch.length; i++) {
        const cand = _svgCandidatesScratch[i];
        const session = _columnSvgSessions.get(cand.draw.imgIdx);
        if (session && session.src !== cand.src) _closeColumnSvgSession(cand.draw.imgIdx);
        const ready = _columnSvgSessions.get(cand.draw.imgIdx);
        if (!ready) {
          _launchColumnSvgSession(cand.draw.imgIdx, cand.item, cand.src, gen);
          const src = cand.node.currentSrc || cand.node.src;
          if (src) _cachedDrawsScratch.push({ draw: cand.draw, node: cand.node, src, isSvg: true });
          continue;
        }
        cand.session = ready;
        _activeSvgsScratch.push(cand);
        hasLive = true;
      }
    }
    if (_columnSvgSessions.size > 0) {
      _scratchActiveIdx.clear();
      for (let i = 0; i < _activeSvgsScratch.length; i++) {
        _scratchActiveIdx.add(_activeSvgsScratch[i].draw.imgIdx);
      }
      _scratchStaleIdx.length = 0;
      for (const imgIdx of _columnSvgSessions.keys()) {
        if (!_scratchActiveIdx.has(imgIdx)) _scratchStaleIdx.push(imgIdx);
      }
      for (let i = 0; i < _scratchStaleIdx.length; i++) {
        _closeColumnSvgSession(_scratchStaleIdx[i]);
      }
    }
    _columnHasLive = hasLive;
    if (_cachedDrawsScratch.length === 0 && _liveDrawsScratch.length === 0 && _activeRastersScratch.length === 0 && _activeSvgsScratch.length === 0) return;

    // Decode raster frames before touching GL. An await after the visible
    // canvas is cleared lets the browser composite a blank frame in
    // direct-screen (lanczos-only) mode. Filtered modes draw offscreen,
    // which is why they never flickered.
    const columnNow = performance.now();
    for (const r of _activeRastersScratch) {
      r.pendingVf = null;
      r.wantIndex = undefined;
      r.wantLoop = undefined;
      r.advanceMs = 0;
      const s = r.session;
      let need = s.needsUpload;
      if (!need && !_columnLiveTextures.has(r.draw.imgIdx)) need = true;
      if (!need && viewportMoved) {
        // Hold the current frame while panning so the slot tracks the
        // gesture. The clock follows wall time, so settle resumes at the
        // correct frame with no catch-up burst.
        s.lastTime = columnNow;
        continue;
      }
      if (!need) {
        const dur = Math.max(10, s.frameDurationMs);
        const elapsed = columnNow - s.lastTime;
        if (elapsed < dur) continue;
        let steps = Math.floor(elapsed / dur);
        if (steps < 1) steps = 1;
        if (steps > 4) steps = 4;
        let idx = s.frameIndex;
        let loop = s.currentLoop;
        let advanced = 0;
        for (let k = 0; k < steps; k++) {
          if (idx < s.frameCount - 1) {
            idx++;
            advanced++;
          } else if (s.loopCount === 0 || loop < s.loopCount) {
            idx = 0;
            loop++;
            advanced++;
          } else {
            break;
          }
        }
        if (advanced === 0) {
          s.lastTime = columnNow;
          continue;
        }
        r.wantIndex = idx;
        r.wantLoop = loop;
        r.advanceMs = advanced * dur;
      }
      try {
        const target = r.wantIndex !== undefined ? r.wantIndex : s.frameIndex;
        const result = await s.decoder.decode({ frameIndex: target });
        r.pendingVf = result.image;
      } catch {
        _failedRastersScratch.push(r);
      }
      if (gen !== _columnGeneration) {
        for (const fr of _activeRastersScratch) {
          if (fr.pendingVf) {
            try {
              fr.pendingVf.close();
            } catch {
              // Already closed.
            }
            fr.pendingVf = null;
          }
        }
        return;
      }
    }
    // Failed decodes fall back to their static frame this pass.
    if (_failedRastersScratch.length > 0) {
      _scratchActiveIdx.clear();
      for (let i = 0; i < _failedRastersScratch.length; i++) {
        const r = _failedRastersScratch[i];
        _scratchActiveIdx.add(r.draw.imgIdx);
        _cachedDrawsScratch.push({ draw: r.draw, node: r.node, src: r.src, isSvg: false });
      }
      for (let i = _activeRastersScratch.length - 1; i >= 0; i--) {
        if (_scratchActiveIdx.has(_activeRastersScratch[i].draw.imgIdx)) {
          _activeRastersScratch.splice(i, 1);
        }
      }
      if (_cachedDrawsScratch.length === 0 && _liveDrawsScratch.length === 0 && _activeRastersScratch.length === 0 && _activeSvgsScratch.length === 0) return;
    }

    // Load missing cached textures after pinning visible window slots.
    if (_cachedDrawsScratch.length > 0) {
      _scratchVisibleKeys.clear();
      for (let i = 0; i < _cachedDrawsScratch.length; i++) {
        _scratchVisibleKeys.add(_cachedDrawsScratch[i].src);
      }
      _columnTextureCache.setPinnedKeys(_scratchVisibleKeys);

      const missing = _cachedDrawsScratch.filter(({ src }) => !_columnTextureCache.has(src));
      if (missing.length > 0) {
        try {
          await Promise.all(missing.map(async ({ src, isSvg }) => {
            if (_columnTextureCache.has(src)) return;
            if (isSvg) {
              await _columnTextureCache.getOrCreate(src, loadSvgCanvas);
            } else {
              await _columnTextureCache.getOrCreate(src);
            }
          }));
        } catch (e) {
          console.warn('Failed to load textures for column composite', e);
        }
        if (gen !== _columnGeneration || !Core.getState()?.manhwaEnabled || !_columnPipeline) {
          return;
        }
      }
    }

    const isDirectScreen = _columnFilter === 'lanczos';
    // One scaler only: a real filter owns resampling, so the composite base
    // stays bilinear. Lanczos applies solely in lanczos-only direct mode.
    const sampler = isDirectScreen && _columnScaling === 'lanczos' ? 'lanczos' : 'bilinear';

    let compositeFbo = null;
    if (isDirectScreen) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, vpW, vpH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    } else {
      compositeFbo = _ensureColumnCompositeFbo(gl, vpW, vpH);
      gl.bindFramebuffer(gl.FRAMEBUFFER, compositeFbo.fbo);
      gl.viewport(0, 0, vpW, vpH);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }

    const flipY = isDirectScreen ? 1.0 : -1.0;

    let painted = 0;

    // Draw cached (still) slots from texture cache.
    for (const { draw, node, src } of _cachedDrawsScratch) {
      const texEntry = _columnTextureCache.get(src);
      if (!texEntry || !texEntry.texture) continue;
      const nodeW = texEntry.width || node.naturalWidth || 0;
      const nodeH = texEntry.height || node.naturalHeight || 0;
      const item = snap.items ? snap.items[draw.imgIdx] : null;
      if (_drawSlotQuad(_columnQuadCompositor, texEntry.texture, draw, item, nodeW, nodeH, vpW, vpH, flipY, sampler)) {
        painted++;
      }
    }

    // Draw live video slots from element upload.
    for (const { draw, node } of _liveDrawsScratch) {
      const isVideo = node.tagName === 'VIDEO';
      const nodeW = isVideo ? node.videoWidth : (node.naturalWidth || 0);
      const nodeH = isVideo ? node.videoHeight : (node.naturalHeight || 0);
      if (nodeW <= 0 || nodeH <= 0) continue;
      if (isVideo && node.readyState < 2) continue;

      const entry = _ensureColumnLiveTexture(gl, draw.imgIdx, nodeW, nodeH);
      try {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, node);
      } catch {
        continue;
      }
      const item = snap.items ? snap.items[draw.imgIdx] : null;
      if (_drawSlotQuad(_columnQuadCompositor, entry.texture, draw, item, nodeW, nodeH, vpW, vpH, flipY, sampler)) {
        painted++;
      }
    }

    // Draw live SVG slots from blob-backed staging canvas. Sampling the pump
    // Image each pass keeps SMIL moving without tainting the canvas.
    for (const r of _activeSvgsScratch) {
      const session = r.session;
      if (!session?.stagingCtx || !session?.staging) continue;
      if (session.width <= 0 || session.height <= 0) continue;
      try {
        session.stagingCtx.clearRect(0, 0, session.width, session.height);
        session.stagingCtx.drawImage(session.img, 0, 0, session.width, session.height);
      } catch {
        continue;
      }
      const entry = _ensureColumnLiveTexture(gl, r.draw.imgIdx, session.width, session.height);
      try {
        gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, session.staging);
      } catch {
        continue;
      }
      if (_drawSlotQuad(_columnQuadCompositor, entry.texture, r.draw, r.item, session.width, session.height, vpW, vpH, flipY, sampler)) {
        painted++;
      }
    }

    // Upload pre-decoded raster frames. No awaits past this point, so the
    // cleared frame always fills before present.
    for (const r of _activeRastersScratch) {
      const s = r.session;
      if (r.pendingVf) {
        const vf = r.pendingVf;
        r.pendingVf = null;
        try {
          const w = vf.displayWidth || vf.codedWidth || r.node.naturalWidth || 0;
          const h = vf.displayHeight || vf.codedHeight || r.node.naturalHeight || 0;
          if (w <= 0 || h <= 0) continue;
          const entry = _ensureColumnLiveTexture(gl, r.draw.imgIdx, w, h);
          gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, gl.RGBA, gl.UNSIGNED_BYTE, vf);
          if (r.wantIndex !== undefined) {
            s.frameIndex = r.wantIndex;
            s.currentLoop = r.wantLoop ?? s.currentLoop;
            s.lastTime += r.advanceMs;
          } else {
            s.lastTime = columnNow;
          }
          s.frameDurationMs = Math.max(10, (vf.duration || 100000) / 1000);
          s.needsUpload = false;
        } catch {
          continue;
        } finally {
          try {
            vf.close();
          } catch {
            // Already closed.
          }
        }
      }
      const liveEntry = _columnLiveTextures.get(r.draw.imgIdx);
      if (!liveEntry) continue;
      if (_drawSlotQuad(_columnQuadCompositor, liveEntry.texture, r.draw, r.item, liveEntry.width, liveEntry.height, vpW, vpH, flipY, sampler)) {
        painted++;
      }
    }

    if (painted === 0) return;
    if (gen !== _columnGeneration) return;

    let rendered = false;
    if (isDirectScreen) {
      rendered = true;
    } else if (compositeFbo) {
      // Sampling stays identity: the composite already holds the
      // panned/zoomed viewport view. The subject rect only pins filter
      // effect coordinates (e.g. the CRT frame) to column content.
      const colW = snap.columnWidth || 0;
      const colH = snap.totalHeight || 0;
      const geom = {
        scale: 1,
        tx: 0,
        ty: 0,
        rotation: 0,
        flipX: 1,
        flipY: 1,
        viewport: { clientWidth: vpW, clientHeight: vpH },
      };
      if (colW > 0 && colH > 0) {
        const colVisualW = colW * scale;
        const colVisualH = colH * scale;
        geom.subjectRect = {
          left: vpW / 2 + tx - colVisualW / 2,
          top: vpH / 2 + ty - colVisualH / 2,
          width: colVisualW,
          height: colVisualH,
        };
      }
      rendered = _columnPipeline.renderFromTexture(compositeFbo.tex, geom, vpW, vpH);
    }
    if (gen !== _columnGeneration) return;

    if (rendered && _columnCanvas) {
      _columnCanvas.setAttribute('data-render-ready', 'true');
      if (vp) vp.setAttribute('data-filter', _columnFilter);
      if (vp) vp.classList.remove('manhwa-warmup');
      _teardownWebglCanvas();
      _columnVisible = true;
    }
  }

  return {
    setSource(img) {
      if (Core.getState()?.manhwaEnabled) return;
      _activeIcoRow = _isIcoNode(img);
      if (_activeIcoRow) {
        _activeSource = img;
        if (lanczosCanvas) lanczosCanvas.removeAttribute('data-render-ready');
        _cancelRender();
        _teardownWebglCanvas();
        _stopLivePump();
        const vp = document.getElementById('viewport');
        if (vp) vp.removeAttribute('data-filter');
        return;
      }
      if (img && _activeSource === img) {
        _cancelRender();
        _applyScaling();
        _scheduleTransform();
        _triggerRender();
        _syncLivePump();
        return;
      }
      
      _activeSource = img;
      
      if (lanczosCanvas) lanczosCanvas.removeAttribute('data-render-ready');
      
      _cancelRender();
      _applyScaling();
      _scheduleTransform();
      _triggerRender();
      _syncLivePump();
    },
    forceRender() {
      if (Core.getState()?.manhwaEnabled) {
        _syncColumnPipeline(Core.getState());
        _requestColumnRender();
        return;
      }
      _cancelRender();
      if (pipeline && pipeline.type === 'webgl') {
        _applyTransform();
      } else {
        _scheduleTransform();
      }
      _triggerRender();
    },
    clear() {
      _activeSource = null;
      _activeIcoRow = false;
      _cancelRender();
      _stopLivePump();
      // In manhwa the renderer parks its single source on every notify, which
      // funnels here through onActiveImageChanged(null). The column lifecycle
      // stays state-driven through _syncColumnPipeline, so leave it alone.
      if (Core.getState()?.manhwaEnabled) return;
      _teardownColumn();
      if (pipeline) {
        _teardownWebglCanvas();
        if (_singleTextureCache) {
          _singleTextureCache.dispose();
          _singleTextureCache = null;
        }
        pipeline.dispose();
        pipeline = null;
      }
      const vp = document.getElementById('viewport');
      if (vp) vp.removeAttribute('data-filter');
    },
    setColumnSource(fn) {
      _columnSourceProvider = fn;
    },
    notifyColumnChanged() {
      _requestColumnRender();
    }
  };
}
