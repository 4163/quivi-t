import { Core } from '../core.js';
import { getEffectiveScaling } from '../services/viewerMath.js';
import { createLanczosPipeline } from '../services/scaling/lanczos.js';
import { filter as lanczosWebGlModule } from '../services/scaling/lanczosWebGL.js';
import { createGlRuntime } from '../services/pipelines/glRuntime.js';
import { activeFilterId, getFilterModule } from '../services/registry.js';

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
  const _liveStagingCanvas = document.createElement('canvas');

  const lanczosCanvas = document.getElementById('viewer-lanczos-canvas');
  const filterCanvas = document.getElementById('viewer-filter-canvas');

  function isSvgSource(src) {
    if (!src) return false;
    try {
      const url = new URL(src);
      return url.pathname.toLowerCase().endsWith('.svg');
    } catch {
      return src.toLowerCase().endsWith('.svg');
    }
  }

  function _resolveActiveFilter(state) {
    if (!state) return null;
    const fd = state.config?.frontend_data;
    if (!fd) return null;
    const active = activeFilterId(fd);
    if (active === 'anime4k' && isSvgSource(_activeSource?.src)) return null;
    return active;
  }

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

  function _applyScaling(incomingFilter, incomingIsAnimated) {
    const live = Core.getState();
    const isAnimated = incomingIsAnimated !== undefined ? incomingIsAnimated : !!live?.isAnimated;
    const isSvg = isSvgSource(_activeSource?.src);
    const scaling = getEffectiveScaling(live?.scalingMode, isAnimated, isSvg);

    const activeFilter = incomingFilter !== undefined ? incomingFilter : _resolveActiveFilter(live);
    
    const useWebGlForLanczos = scaling === 'lanczos' && isAnimated && !isSvg && activeFilter === null;
    const usesWebgl = activeFilter !== null || useWebGlForLanczos;
    const usesLanczos = scaling === 'lanczos' && !usesWebgl;
    
    if (_activeSource) {
      _activeSource.dataset.scaling = scaling;
    }
    
    const viewportNode = document.getElementById('viewport');
    if (viewportNode && !usesWebgl) {
      viewportNode.removeAttribute('data-filter');
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
        pipeline = createLanczosPipeline();
      }
    } else if (usesWebgl && (filterChanged || variantChanged || scalingChanged)) {
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
    if (!pipeline || pipeline.type !== 'webgl' || _lastIsAnimated) return;
    if (!_activeSource || !_activeSource.complete || _activeSource.naturalWidth <= 0 || _activeSource.naturalHeight <= 0) return;
    
    const geom = viewportState.getGeometry();
    const gen = _renderGeneration;
    
    pipeline.render(_activeSource, geom).then((ok) => {
      if (gen !== _renderGeneration) return;
      if (ok && filterCanvas) {
        filterCanvas.setAttribute('data-render-ready', 'true');
        const vp = document.getElementById('viewport');
        if (vp && _lastActiveFilter) vp.setAttribute('data-filter', _lastActiveFilter);
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
    const liveAnimated = !!live?.isAnimated;
    const scaling = getEffectiveScaling(live?.scalingMode, liveAnimated);
    
    const activeFilter = _resolveActiveFilter(live);
    const usesWebgl = activeFilter !== null;
    const usesLanczos = scaling === 'lanczos' && !usesWebgl;
    
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

  function _stopLivePump() {
    if (_livePumpRaf) {
      cancelAnimationFrame(_livePumpRaf);
      _livePumpRaf = null;
    }
    if (_livePumpImg) {
      if (_livePumpImg.close) _livePumpImg.close();
      if (_livePumpImg.parentNode) _livePumpImg.parentNode.removeChild(_livePumpImg);
      _livePumpImg = null;
    }
    _livePumpSrc = null;
  }

  async function _syncLivePump() {
    const live = Core.getState();
    const isAnimated = !!live?.isAnimated;
    const isSvg = isSvgSource(_activeSource?.src);
    const scaling = getEffectiveScaling(live?.scalingMode, isAnimated, isSvg);
    const activeFilter = _resolveActiveFilter(live);
    const useLivePump = isAnimated && (activeFilter !== null || scaling === 'lanczos');

    if (!useLivePump || !_activeSource) {
      _stopLivePump();
      return;
    }

    const currentSrc = _activeSource.src;
    if (_livePumpSrc === currentSrc && _livePumpRaf) return;

    _stopLivePump();
    _livePumpSrc = currentSrc;

    // --- SVG DOM Fallback Pump ---
    if (isSvg) {
      // SVGs cannot be parsed by WebCodecs ImageDecoder.
      // Fallback to DOM <img> drawing technique.
      const resp = await fetch(currentSrc);
      if (_livePumpSrc !== currentSrc) return;
      const blob = await resp.blob();
      if (_livePumpSrc !== currentSrc) return;

      const blobUrl = URL.createObjectURL(blob);
      const liveImg = document.createElement('img');

      const viewport = document.getElementById('viewport');
      liveImg.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;pointer-events:none;opacity:0.001;';
      viewport.insertBefore(liveImg, document.getElementById('viewer-filter-canvas'));
      liveImg.src = blobUrl;
      _livePumpImg = liveImg;

      await new Promise((resolve, reject) => {
        if (liveImg.complete && liveImg.naturalWidth) resolve();
        else { liveImg.onload = resolve; liveImg.onerror = reject; }
      });
      if (_livePumpSrc !== currentSrc) {
        liveImg.remove();
        URL.revokeObjectURL(blobUrl);
        return;
      }

      let pumpVisible = false;
      let stagingCtx = null;

      function pumpTickSvg() {
        if (_livePumpSrc !== currentSrc) return;

        let sw = liveImg.naturalWidth;
        let sh = liveImg.naturalHeight;
        if (!sw || !sh) {
          _livePumpRaf = requestAnimationFrame(pumpTickSvg);
          return;
        }

        // Scale up the rasterization size to match the viewport to keep the SVG sharp.
        const vp = document.getElementById('viewport');
        if (vp) {
          const SVG_MAX_EDGE = 512;
          const targetW = Math.min(vp.clientWidth || 1024, SVG_MAX_EDGE);
          const targetH = Math.min(vp.clientHeight || 1024, SVG_MAX_EDGE);
          
          let multiplier = Math.max(targetW / sw, targetH / sh);
          
          // Strictly cap at SVG_MAX_EDGE to prevent CPU exhaustion
          if (sw * multiplier > SVG_MAX_EDGE) multiplier = SVG_MAX_EDGE / sw;
          if (sh * multiplier > SVG_MAX_EDGE) multiplier = Math.min(multiplier, SVG_MAX_EDGE / sh);
          
          // Never scale down below natural size unless natural size is > SVG_MAX_EDGE
          if (sw <= SVG_MAX_EDGE && sh <= SVG_MAX_EDGE) {
            multiplier = Math.max(1, multiplier);
          }

          sw = Math.round(sw * multiplier);
          sh = Math.round(sh * multiplier);
        }

        if (_liveStagingCanvas.width !== sw) _liveStagingCanvas.width = sw;
        if (_liveStagingCanvas.height !== sh) _liveStagingCanvas.height = sh;
        if (!stagingCtx) stagingCtx = _liveStagingCanvas.getContext('2d', { willReadFrequently: true });

        stagingCtx.clearRect(0, 0, sw, sh);
        stagingCtx.drawImage(liveImg, 0, 0, sw, sh);

        if (pipeline && pipeline.type === 'webgl') {
          pipeline.updateSource(_liveStagingCanvas);
          pipeline.render(_activeSource, viewportState.getGeometry(), true);

          if (!pumpVisible) {
            pumpVisible = true;
            if (filterCanvas) filterCanvas.setAttribute('data-render-ready', 'true');
            const vp = document.getElementById('viewport');
            if (vp && _lastActiveFilter) vp.setAttribute('data-filter', _lastActiveFilter);
          }
        }
        _livePumpRaf = requestAnimationFrame(pumpTickSvg);
      }
      _livePumpRaf = requestAnimationFrame(pumpTickSvg);
      return;
    }

    // --- Raster WebCodecs Pump (GIF/APNG/WebP) ---
    if (typeof ImageDecoder === 'undefined') return;

    const resp = await fetch(currentSrc);
    if (_livePumpSrc !== currentSrc) return;
    const contentType = resp.headers.get('content-type') || 'image/gif';

    let decoder;
    try {
      decoder = new ImageDecoder({ data: resp.body, type: contentType });
      await decoder.completed;
    } catch (e) {
      console.warn('[pump] ImageDecoder failed:', e.message);
      return;
    }
    if (_livePumpSrc !== currentSrc) { decoder.close(); return; }

    const track = decoder.tracks.selectedTrack;
    const frameCount = track.frameCount;
    if (frameCount < 2) { decoder.close(); return; }

    _livePumpImg = decoder;

    const ANIME4K_MAX_EDGE = 2048;
    let pumpVisible = false;
    let stagingCtx = null;
    let frameIndex = 0;
    let lastFrameTime = performance.now();
    let frameDurationMs = 100;

    async function pumpTick() {
      if (_livePumpSrc !== currentSrc) return;

      const now = performance.now();
      const elapsed = now - lastFrameTime;

      // Advance frame when enough time has passed
      if (elapsed >= frameDurationMs) {
        frameIndex = (frameIndex + 1) % frameCount;
        lastFrameTime = now;
      }

      let vf;
      try {
        const result = await decoder.decode({ frameIndex });
        vf = result.image;
      } catch {
        _livePumpRaf = requestAnimationFrame(pumpTick);
        return;
      }
      if (_livePumpSrc !== currentSrc) { vf.close(); return; }

      // Update frame duration from this frame's metadata (microseconds → ms)
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
      if (!stagingCtx) stagingCtx = _liveStagingCanvas.getContext('2d', { willReadFrequently: true });

      stagingCtx.clearRect(0, 0, drawW, drawH);
      stagingCtx.drawImage(vf, 0, 0, drawW, drawH);
      vf.close();

      if (pipeline && pipeline.type === 'webgl') {
        pipeline.updateSource(_liveStagingCanvas);
        pipeline.render(_activeSource, viewportState.getGeometry(), true);

        if (!pumpVisible) {
          pumpVisible = true;
          if (filterCanvas) filterCanvas.setAttribute('data-render-ready', 'true');
          const vp = document.getElementById('viewport');
          if (vp && _lastActiveFilter) vp.setAttribute('data-filter', _lastActiveFilter);
        }
      }

      _livePumpRaf = requestAnimationFrame(pumpTick);
    }
    _livePumpRaf = requestAnimationFrame(pumpTick);
  }

  Core.onStateChange((state) => {
    const newFilter = _resolveActiveFilter(state);
    const newIsAnimated = !!state.isAnimated;
    const newScaling = getEffectiveScaling(state.scalingMode, newIsAnimated);
    const newVariant = newFilter === 'anime4k' ? state?.config?.frontend_data?.filter_options?.anime4k?.variant : null;
    
    if (newFilter !== _lastActiveFilter || newIsAnimated !== _lastIsAnimated || newScaling !== _lastScalingMode || newVariant !== _lastAnime4kVariant) {
      _cancelRender();
      _applyScaling(newFilter, newIsAnimated);
      _scheduleTransform();
      _triggerRender();
      _syncLivePump();
    }
  });

  // Pan path is render, not rebuild.
  viewportState.subscribe(() => {
    _cancelRender();
    _scheduleTransform();
    _triggerRender();
  });

  return {
    setSource(img) {
      _activeSource = img;
      _cancelRender();
      _applyScaling();
      _scheduleTransform();
      _triggerRender();
      _syncLivePump();
    },
    forceRender() {
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
      if (pipeline) {
        _teardownWebglCanvas();
        pipeline.dispose();
        pipeline = null;
      }
      const vp = document.getElementById('viewport');
      if (vp) vp.removeAttribute('data-filter');
    }
  };
}
