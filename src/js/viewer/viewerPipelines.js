import { Core } from '../core.js';
import { getEffectiveScaling } from '../services/viewerMath.js';
import { createLanczosPipeline } from '../services/scaling/lanczos.js';
import { createGlRuntime } from '../services/pipelines/glRuntime.js';
import { activeFilterId, getFilterModule } from '../services/registry.js';

export function createViewerPipelines(viewportState) {
  let _activeSource = null;
  let pipeline = null;
  let _lastScalingMode = Core.getState().scalingMode;
  let _lastActiveFilter = _resolveActiveFilter(Core.getState());
  let _lastIsAnimated = !!Core.getState()?.isAnimated;
  
  let _rafPending = false;
  let _renderGeneration = 0;
  let _renderTimeout = null;

  const lanczosCanvas = document.getElementById('viewer-lanczos-canvas');
  const filterCanvas = document.getElementById('viewer-filter-canvas');

  function _resolveActiveFilter(state) {
    if (!state || !!state.isAnimated) return null;
    const fd = state.config?.frontend_data;
    if (!fd) return null;
    return activeFilterId(fd);
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
    const scaling = getEffectiveScaling(live?.scalingMode, isAnimated);

    const activeFilter = incomingFilter !== undefined ? incomingFilter : _resolveActiveFilter(live);
    const usesWebgl = activeFilter !== null;
    const usesLanczos = scaling === 'lanczos' && !usesWebgl;
    
    if (_activeSource) {
      _activeSource.dataset.scaling = scaling;
    }
    
    const viewportNode = document.getElementById('viewport');
    if (viewportNode) {
      if (usesWebgl) {
        viewportNode.setAttribute('data-filter', activeFilter);
      } else {
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

    if (needsNewPipeline) {
      if (pipeline) {
        _teardownWebglCanvas();
        pipeline.dispose();
      }
      if (usesWebgl) {
        pipeline = createGlRuntime(filterCanvas);
        pipeline.setFilter(getFilterModule(activeFilter));
        pipeline.filter = activeFilter;
      } else if (usesLanczos) {
        pipeline = createLanczosPipeline();
      }
    } else if (usesWebgl && filterChanged) {
      pipeline.setFilter(getFilterModule(activeFilter));
      pipeline.filter = activeFilter;
    }
    
    _lastScalingMode = scaling;
    _lastActiveFilter = activeFilter;
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
    let scaling = live?.scalingMode;
    if (liveAnimated && scaling === 'lanczos') scaling = 'bilinear';
    
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

  Core.onStateChange((state) => {
    const newFilter = _resolveActiveFilter(state);
    const newIsAnimated = !!state.isAnimated;
    const newScaling = getEffectiveScaling(state.scalingMode, newIsAnimated);
    
    if (newFilter !== _lastActiveFilter || newIsAnimated !== _lastIsAnimated || newScaling !== _lastScalingMode) {
      _cancelRender();
      _applyScaling(newFilter, newIsAnimated);
      _scheduleTransform();
      _triggerRender();
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
    },
    clear() {
      _activeSource = null;
      _cancelRender();
      if (pipeline) {
        _teardownWebglCanvas();
        pipeline.dispose();
        pipeline = null;
      }
    }
  };
}
