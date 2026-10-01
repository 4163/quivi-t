import { Core } from '../core.js';
import { getEffectiveScaling, computeColumnComposite } from '../services/viewerMath.js';
import { createLanczosPipeline } from '../services/scaling/lanczos.js';
import { filter as lanczosWebGlModule } from '../services/scaling/lanczosWebGL.js';
import { createGlRuntime } from '../services/pipelines/glRuntime.js';
import { activeFilterId } from '../services/registry.js';
import { getFilterModule } from '../services/filterModules.js';
import { createTextureCache } from '../services/pipelines/textureCache.js';
import { createQuadCompositor } from '../services/pipelines/quadCompositor.js';

const SVG_ANIMATED_MAX_EDGE = 512;
const SVG_STATIC_MAX_EDGE = 2048;

export function createViewerPipelines(viewportState) {
  let _activeSource = null;
  let pipeline = null;
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
      if (pipeline) pipeline.dispose();
      pipeline = null;
      _applyScaling();
      _scheduleTransform();
      _triggerRender();
      _syncLivePump();
    });
  }

  function isSvgSource(src) {
    if (!src) return false;
    try {
      const url = new URL(src);
      return url.pathname.toLowerCase().endsWith('.svg');
    } catch {
      return src.toLowerCase().endsWith('.svg');
    }
  }

  function isVideoSource(el) {
    return el?.tagName === 'VIDEO';
  }

  function _resolveActiveFilter(state) {
    if (!state) return null;
    const fd = state.config?.frontend_data;
    if (!fd) return null;
    const active = activeFilterId(fd);
    // Anime4K does not support SVGs; silently fall back to no filter.
    // The UI intentionally ignores this fallback to keep the user's selection checked (intended UX).
    if (active === 'anime4k' && isSvgSource(_activeSource?.src)) return null;
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
    const isSvg = isSvgSource(_activeSource?.src);
    const isMoving = isAnimated || isVideo;
    const scaling = getEffectiveScaling(live?.scalingMode, isMoving, isSvg);

    const activeFilter = incomingFilter !== undefined ? incomingFilter : _resolveActiveFilter(live);
    
    const useWebGlForLanczos = scaling === 'lanczos' && isMoving && !isSvg && activeFilter === null;
    const usesWebgl = activeFilter !== null || useWebGlForLanczos;
    const usesLanczos = scaling === 'lanczos' && !usesWebgl;
    
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
        pipeline.dispose();
      }
      if (usesWebgl) {
        pipeline = createGlRuntime(filterCanvas);
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

  function _applyTransform() {
    if (!pipeline || pipeline.type !== 'webgl' || _lastIsAnimated || isVideoSource(_activeSource)) return;
    if (!_activeSource || !_activeSource.complete || _activeSource.naturalWidth <= 0 || _activeSource.naturalHeight <= 0) return;
    
    const geom = viewportState.getGeometry();
    const gen = _renderGeneration;
    
    pipeline.render(_activeSource, geom).then((ok) => {
      if (gen !== _renderGeneration) return;
      if (ok && filterCanvas) {
        filterCanvas.setAttribute('data-render-ready', 'true');
        const vp = document.getElementById('viewport');
        if (vp && (_lastActiveFilter || pipeline.filter === 'lanczos')) vp.setAttribute('data-filter', _lastActiveFilter || pipeline.filter);
      }
    });
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
    const isVideo = isVideoSource(_activeSource);
    const liveAnimated = !!live?.isAnimated || isVideo;
    const isSvg = isSvgSource(_activeSource?.src);
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

  function _stopLivePump() {
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
      if (_livePumpImg.close) _livePumpImg.close();
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
    const isSvg = isSvgSource(_activeSource?.src);
    const isMoving = isAnimated || isVideo;
    const scaling = getEffectiveScaling(live?.scalingMode, isMoving, isSvg);
    const activeFilter = _resolveActiveFilter(live);
    const useLivePump = (isMoving || isSvg) && (activeFilter !== null || scaling === 'lanczos');

    if (!useLivePump || !_activeSource) {
      _stopLivePump();
      return;
    }

    const currentSrc = _activeSource.dataset?.vidSrc || _activeSource.getAttribute('src') || _activeSource.src || '';
    if (_livePumpSrc === currentSrc && _livePumpRaf) return;

    _stopLivePump();
    _livePumpSrc = currentSrc;
    _livePumpLastDrawnFrameIndex = -1;

    // --- Video Pump ---
    if (isVideo) {
      const videoEl = _activeSource;
      _videoElAttached = videoEl;
      let pumpVisible = false;
      let stagingCtx = null;
      let lastCurrentTime = -1;
      let lastGeometryHash = '';
      let lastFilter = pipeline?.filter;
      const ANIME4K_MAX_EDGE = 2048;

      function renderFrame() {
        if (_livePumpSrc !== currentSrc || _activeSource !== videoEl) return;
        if (!pipeline || pipeline.type !== 'webgl') return;

        const vw = videoEl.videoWidth;
        const vh = videoEl.videoHeight;
        if (vw <= 0 || vh <= 0) return;

        let drawW = vw;
        let drawH = vh;

        if (_lastActiveFilter === 'anime4k') {
          const maxEdge = Math.max(vw, vh);
          if (maxEdge > ANIME4K_MAX_EDGE) {
            const ratio = ANIME4K_MAX_EDGE / maxEdge;
            drawW = Math.round(vw * ratio);
            drawH = Math.round(vh * ratio);
          }
        }

        if (_liveStagingCanvas.width !== drawW) _liveStagingCanvas.width = drawW;
        if (_liveStagingCanvas.height !== drawH) _liveStagingCanvas.height = drawH;
        if (!stagingCtx) stagingCtx = _liveStagingCanvas.getContext('2d');
        stagingCtx.drawImage(videoEl, 0, 0, drawW, drawH);

        const geom = viewportState.getGeometry();
        pipeline.updateSource(_liveStagingCanvas);
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
        if (_livePumpSrc !== currentSrc) return;

        function pumpTickVideo() {
          if (_livePumpSrc !== currentSrc || _activeSource !== videoEl) return;

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
          startVideoLoop();
        };
        videoEl.addEventListener('canplay', _videoReadyListener, { once: true });
      }
      return;
    }

    // --- SVG DOM Fallback Pump ---
    if (isSvg) {
      // SVGs cannot be parsed by WebCodecs ImageDecoder.
      // Fallback to DOM <img> drawing technique.
      const resp = await fetch(currentSrc);
      if (_livePumpSrc !== currentSrc) return;
      const blob = await resp.blob();
      if (_livePumpSrc !== currentSrc) return;

      const blobUrl = URL.createObjectURL(blob);
      _livePumpBlobUrl = blobUrl;
      const liveImg = document.getElementById('viewer-svg-pump');
      liveImg.classList.remove('hidden');
      liveImg.src = blobUrl;
      _livePumpImg = liveImg;

      await new Promise((resolve, reject) => {
        if (liveImg.complete && liveImg.naturalWidth) resolve();
        else { liveImg.onload = resolve; liveImg.onerror = reject; }
      });
      if (_livePumpSrc !== currentSrc) {
        liveImg.classList.add('hidden');
        return;
      }

      let pumpVisible = false;
      let stagingCtx = null;

      const maxEdge = isAnimated ? SVG_ANIMATED_MAX_EDGE : SVG_STATIC_MAX_EDGE;

      function pumpTickSvg() {
        if (_livePumpSrc !== currentSrc) return;

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

        if (_liveStagingCanvas.width !== sw) _liveStagingCanvas.width = sw;
        if (_liveStagingCanvas.height !== sh) _liveStagingCanvas.height = sh;
        if (!stagingCtx) stagingCtx = _liveStagingCanvas.getContext('2d');

        liveImg.width = sw;
        liveImg.height = sh;

        stagingCtx.clearRect(0, 0, sw, sh);
        stagingCtx.drawImage(liveImg, 0, 0, sw, sh);

        if (pipeline && pipeline.type === 'webgl') {
          pipeline.updateSource(_liveStagingCanvas);
          // Use CSS display dimensions (set by _applySvgBounds) so the WebGL
          // geometry matches the pool image's actual display box, not the
          // browser-default naturalWidth which can be 150 for dimensionless SVGs.
          const cw = _activeSource.clientWidth || _activeSource.naturalWidth;
          const ch = _activeSource.clientHeight || _activeSource.naturalHeight;
          pipeline.render({ naturalWidth: cw, naturalHeight: ch }, viewportState.getGeometry(), true);

          if (!pumpVisible) {
            pumpVisible = true;
            if (filterCanvas) filterCanvas.setAttribute('data-render-ready', 'true');
            const vpEl = document.getElementById('viewport');
            if (vpEl && (_lastActiveFilter || pipeline.filter === 'lanczos')) vpEl.setAttribute('data-filter', _lastActiveFilter || pipeline.filter);
          }
        }
        _livePumpRaf = requestAnimationFrame(pumpTickSvg);
      }
      _livePumpRaf = requestAnimationFrame(pumpTickSvg);
      return;
    }

    // --- Raster WebCodecs Pump (GIF/APNG/WebP/AVIF) ---
    if (typeof ImageDecoder === 'undefined') {
      _lastIsAnimated = false;
      _scheduleTransform();
      _triggerRender();
      return;
    }

    const resp = await fetch(currentSrc);
    if (_livePumpSrc !== currentSrc) return;
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
      _scheduleTransform();
      _triggerRender();
      return;
    }
    if (_livePumpSrc !== currentSrc) { decoder.close(); return; }

    const track = decoder.tracks.selectedTrack;
    const frameCount = track.frameCount;
    if (frameCount < 2) { 
      decoder.close();
      _lastIsAnimated = false;
      _scheduleTransform();
      _triggerRender();
      return; 
    }

    _livePumpImg = decoder;

    const ANIME4K_MAX_EDGE = 2048;
    let frameIndex = 0;
    let currentLoopIteration = 1;
    let lastFrameTime = performance.now();
    let frameDurationMs = 100;
    let pumpVisible = false;
    let stagingCtx = null;
    let lastGeometryHash = '';

    _visibilityListener = () => {
      if (document.visibilityState === 'visible') lastFrameTime = performance.now();
    };
    document.addEventListener('visibilitychange', _visibilityListener);

    async function pumpTick() {
      if (_livePumpSrc !== currentSrc) return;

      const now = performance.now();
      let elapsed = now - lastFrameTime;

      if (elapsed > 1000) {
        lastFrameTime = now;
        elapsed = 0;
      }

      let frameChanged = false;
      while (elapsed >= frameDurationMs) {
        if (frameIndex < frameCount - 1) {
          frameIndex++;
        } else if (live.loopCount === 0 || currentLoopIteration < live.loopCount) {
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
      if (_livePumpSrc !== currentSrc) { vf.close(); return; }

      const geom = viewportState.getGeometry();
      const geomHash = `${geom.scale}_${geom.tx}_${geom.ty}_${geom.rotation}_${geom.flipX}_${geom.flipY}`;
      
      const needsRender = frameIndex !== _livePumpLastDrawnFrameIndex || geomHash !== lastGeometryHash;
      if (!needsRender) {
        vf.close();
        _livePumpRaf = requestAnimationFrame(pumpTick);
        return;
      }

      if (vf.duration) frameDurationMs = Math.max(10, vf.duration / 1000);

      const sw = vf.displayWidth;
      const sh = vf.displayHeight;
      let drawW = sw, drawH = sh;

      if (_lastActiveFilter === 'anime4k') {
        const maxEdge = Math.max(sw, sh);
        if (maxEdge > ANIME4K_MAX_EDGE) {
          const ratio = ANIME4K_MAX_EDGE / maxEdge;
          drawW = Math.round(sw * ratio);
          drawH = Math.round(sh * ratio);
        }
      }

      if (_liveStagingCanvas.width !== drawW) _liveStagingCanvas.width = drawW;
      if (_liveStagingCanvas.height !== drawH) _liveStagingCanvas.height = drawH;
      if (!stagingCtx) stagingCtx = _liveStagingCanvas.getContext('2d');

      if (frameIndex !== _livePumpLastDrawnFrameIndex) {
        stagingCtx.clearRect(0, 0, drawW, drawH);
        stagingCtx.drawImage(vf, 0, 0, drawW, drawH);
        if (pipeline && pipeline.type === 'webgl') {
          pipeline.updateSource(_liveStagingCanvas);
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
    if (state.manhwaEnabled) {
      // Legacy pipeline parks. The column pipeline takes over from here.
      _cancelRender();
      _stopLivePump();
      _syncColumnPipeline(state);
      _requestColumnRender();
      return;
    }

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
    const newIsSvg = _activeSource?.src?.toLowerCase().includes('.svg') ?? false;
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
  let _columnTextureCache = null;
  let _columnQuadCompositor = null;
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

  function _teardownColumn() {
    _columnGeneration++;
    if (_columnRafId) {
      cancelAnimationFrame(_columnRafId);
      _columnRafId = 0;
    }
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
        _columnTextureCache = createTextureCache(gl, { maxBytes: 128 * 1024 * 1024 });
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
    });
  }

  async function _renderColumn() {
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

    const validDraws = [];
    for (const draw of drawList) {
      const node = snap.nodes.get(draw.imgIdx);
      if (!node || node.tagName === 'VIDEO') continue;
      const src = node.currentSrc || node.src;
      if (!src) continue;
      validDraws.push({ draw, node, src });
    }
    if (validDraws.length === 0) return;

    const missing = validDraws.some(({ src }) => !_columnTextureCache.has(src));
    if (missing) {
      try {
        await Promise.all(validDraws.map(({ src }) => _columnTextureCache.getOrCreate(src)));
      } catch (e) {
        console.warn('Failed to load textures for column composite', e);
      }
      if (gen !== _columnGeneration || !Core.getState()?.manhwaEnabled || !_columnPipeline) {
        return;
      }
    }

    const isDirectScreen = _columnFilter === 'lanczos';
    const sampler = _columnScaling === 'lanczos' ? 'lanczos' : 'bilinear';

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
    for (const { draw, node, src } of validDraws) {
      const texEntry = _columnTextureCache.get(src);
      if (!texEntry || !texEntry.texture) continue;

      const item = snap.items ? snap.items[draw.imgIdx] : null;
      const itemW = (item && (item.naturalWidth ?? item.width)) || 0;
      const itemH = (item && (item.naturalHeight ?? item.height)) || 0;
      const nodeW = node.naturalWidth || texEntry.width || 0;
      const nodeH = node.naturalHeight || texEntry.height || 0;
      if (!nodeW || !nodeH) continue;

      const sr = draw.sourceRect || {};
      const kx = itemW > 0 ? nodeW / itemW : 1;
      const ky = itemH > 0 ? nodeH / itemH : 1;
      const sx = Math.max(0, (sr.x ?? sr.sx ?? 0) * kx);
      const sy = Math.max(0, (sr.y ?? sr.sy ?? 0) * ky);
      const sw = Math.min(nodeW - sx, (sr.width ?? sr.sw ?? nodeW) * kx);
      const sh = Math.min(nodeH - sy, (sr.height ?? sr.sh ?? nodeH) * ky);
      if (sw <= 0 || sh <= 0) continue;

      const dr = draw.destRect || {};
      const dx = dr.x ?? dr.dx ?? 0;
      const dy = dr.y ?? dr.dy ?? 0;
      const dw = dr.width ?? dr.dw ?? 0;
      const dh = dr.height ?? dr.dh ?? 0;
      if (dw <= 0 || dh <= 0) continue;

      const sourceUV = {
        u0: sx / nodeW,
        v0: sy / nodeH,
        u1: (sx + sw) / nodeW,
        v1: (sy + sh) / nodeH,
      };

      const destRect = { x: dx, y: dy, width: dw, height: dh };
      const sourceSize = { w: nodeW, h: nodeH };

      const ok = _columnQuadCompositor.drawQuad(texEntry.texture, destRect, sourceUV, vpW, vpH, flipY, sampler, sourceSize);
      if (ok) painted++;
    }

    if (painted === 0) return;
    if (gen !== _columnGeneration) return;

    let rendered = false;
    if (isDirectScreen) {
      rendered = true;
    } else if (compositeFbo) {
      const geom = {
        scale: 1,
        tx: 0,
        ty: 0,
        rotation: 0,
        flipX: 1,
        flipY: 1,
        viewport: { clientWidth: vpW, clientHeight: vpH },
      };
      rendered = _columnPipeline.renderFromTexture(compositeFbo.tex, geom, vpW, vpH);
    }
    if (gen !== _columnGeneration) return;

    if (rendered && _columnCanvas) {
      _columnCanvas.setAttribute('data-render-ready', 'true');
      if (vp) vp.setAttribute('data-filter', _columnFilter);
      _columnVisible = true;
    }
  }

  return {
    setSource(img) {
      if (Core.getState()?.manhwaEnabled) return;
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
      _cancelRender();
      _stopLivePump();
      // In manhwa the renderer parks its single source on every notify, which
      // funnels here through onActiveImageChanged(null). The column lifecycle
      // stays state-driven through _syncColumnPipeline, so leave it alone.
      if (Core.getState()?.manhwaEnabled) return;
      _teardownColumn();
      if (pipeline) {
        _teardownWebglCanvas();
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
