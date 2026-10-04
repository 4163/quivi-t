/**
 * base.js: Self-contained in-browser diagnostic engine for replay action traces.
 * Serializes across WebDriver into webviews to capture pipeline lifecycles,
 * Core state machine transitions, image/canvas rendering, and IPC timings.
 */

export function initReplayDiagnostics() {
  if (window.__QUIVIT_DIAGNOSTICS__) return window.__QUIVIT_DIAGNOSTICS__;

  // =========================================================================
  // 1. CORE DIAGNOSTIC ENGINE
  // =========================================================================
  let _activeMonitoring = false;
  let _stepLogs = [];
  let _stepEvents = [];
  let _anomalies = [];
  let _rafId = null;
  let _currentStep = null;
  let _lastFrameTime = 0;
  let _frameCount = 0;
  let _jankFrameCount = 0;

  const _probes = new Map();

  function _onError(event) {
    if (!_activeMonitoring) return;
    recordAnomaly('uncaught-error', {
      message: event.message,
      filename: event.filename,
      lineno: event.lineno,
      colno: event.colno,
      error: event.error ? String(event.error) : null,
    });
  }

  function _onUnhandledRejection(event) {
    if (!_activeMonitoring) return;
    recordAnomaly('unhandled-rejection', {
      reason: event.reason ? (event.reason.stack || String(event.reason)) : 'Unknown rejection',
    });
  }

  window.addEventListener('error', _onError);
  window.addEventListener('unhandledrejection', _onUnhandledRejection);

  function recordAnomaly(type, detail = {}) {
    const now = performance.now();
    const relMs = _currentStep ? parseFloat((now - _currentStep.startTime).toFixed(1)) : 0;
    const entry = {
      t: relMs,
      type,
      ...detail,
    };
    _anomalies.push(entry);
    return entry;
  }

  function recordEvent(source, event, data = null) {
    if (!_activeMonitoring) return;
    const now = performance.now();
    const relMs = _currentStep ? parseFloat((now - _currentStep.startTime).toFixed(1)) : 0;
    _stepEvents.push({
      t: relMs,
      source,
      event,
      data,
    });
  }

  function registerProbe(name, probe) {
    if (!probe) return;
    if (typeof probe === 'function') {
      _probes.set(name, { checkFrame: probe });
    } else {
      _probes.set(name, probe);
    }
  }

  function unregisterProbe(name) {
    _probes.delete(name);
  }

  function _frameTick(now) {
    if (!_activeMonitoring) return;

    _frameCount++;
    if (_lastFrameTime > 0) {
      const delta = now - _lastFrameTime;
      if (delta > 50) {
        _jankFrameCount++;
      }
    }
    _lastFrameTime = now;

    const frameCtx = {
      now,
      relMs: _currentStep ? parseFloat((now - _currentStep.startTime).toFixed(1)) : 0,
      step: _currentStep,
      frameCount: _frameCount,
    };

    for (const [name, probe] of _probes) {
      if (typeof probe.checkFrame !== 'function') continue;
      try {
        const result = probe.checkFrame(frameCtx);
        if (result) {
          recordAnomaly(result.type || name, result);
        }
      } catch (err) {
        recordAnomaly('probe-error', {
          probe: name,
          message: err?.message || String(err),
        });
      }
    }

    _rafId = requestAnimationFrame(_frameTick);
  }

  function startStep(stepIndex, actionId, context = {}) {
    _currentStep = {
      stepIndex,
      actionId,
      context,
      startTime: performance.now(),
    };
    _anomalies = [];
    _stepEvents = [];
    _frameCount = 0;
    _jankFrameCount = 0;
    _lastFrameTime = 0;
    _activeMonitoring = true;

    for (const [, probe] of _probes) {
      if (typeof probe.onStepStart === 'function') {
        try {
          probe.onStepStart(_currentStep);
        } catch (err) {
          recordAnomaly('probe-error', {
            phase: 'onStepStart',
            message: err?.message || String(err),
          });
        }
      }
    }

    if (_rafId) cancelAnimationFrame(_rafId);
    _rafId = requestAnimationFrame(_frameTick);
  }

  function stopStep() {
    _activeMonitoring = false;
    if (_rafId) {
      cancelAnimationFrame(_rafId);
      _rafId = null;
    }
    const endTime = performance.now();
    const durationMs = _currentStep ? Math.round(endTime - _currentStep.startTime) : 0;

    for (const [, probe] of _probes) {
      if (typeof probe.onStepStop === 'function') {
        try {
          probe.onStepStop(_currentStep);
        } catch (err) {
          recordAnomaly('probe-error', {
            phase: 'onStepStop',
            message: err?.message || String(err),
          });
        }
      }
    }

    const blackoutDetails = _anomalies.filter((a) => a.type === 'blackout');
    const currentFilename = document.querySelector('#statusbar .status-filename, #statusbar .filename')?.textContent?.trim() || '';

    const report = {
      stepIndex: _currentStep?.stepIndex ?? -1,
      actionId: _currentStep?.actionId ?? '',
      filename: currentFilename,
      durationMs,
      frameCount: _frameCount,
      jankFrameCount: _jankFrameCount,
      anomalies: [..._anomalies],
      anomalyCount: _anomalies.length,
      blackoutFrameCount: blackoutDetails.length,
      blackoutDetails,
      events: [..._stepEvents],
    };

    _stepLogs.push(report);
    return report;
  }

  const engine = {
    startStep,
    stopStep,
    recordEvent,
    recordAnomaly,
    registerProbe,
    unregisterProbe,
    getAllLogs() {
      return [..._stepLogs];
    },
    clear() {
      _stepLogs = [];
      _stepEvents = [];
      _anomalies = [];
    },
  };

  window.__QUIVIT_DIAGNOSTICS__ = engine;

  // =========================================================================
  // 2. CORE PIPELINE PROBE
  // =========================================================================
  let _coreProbeInitialized = false;
  async function _initCoreProbe() {
    if (_coreProbeInitialized) return;
    _coreProbeInitialized = true;

    try {
      const actionsModule = await import('/js/services/actions.js');
      if (actionsModule && typeof actionsModule.dispatch === 'function' && actionsModule.ACTION_MAP) {
        const origDispatch = actionsModule.dispatch;
        actionsModule.dispatch = async function(actionId, payload, ctx) {
          const startTime = performance.now();
          if (!actionsModule.ACTION_MAP.has(actionId)) {
            recordAnomaly('unknown-action', { actionId });
            return;
          }

          const payloadSummary = payload && typeof payload === 'object'
            ? { wheel: payload.wheel, clientX: payload.clientX, clientY: payload.clientY }
            : null;

          recordEvent('action', 'dispatch-start', { actionId, payload: payloadSummary });

          try {
            const result = await origDispatch.call(this, actionId, payload, ctx);
            const elapsedMs = parseFloat((performance.now() - startTime).toFixed(2));
            recordEvent('action', 'dispatch-end', { actionId, elapsedMs });
            return result;
          } catch (err) {
            recordAnomaly('action-error', { actionId, message: err?.message || String(err) });
            throw err;
          }
        };
      }
    } catch (err) {
      recordAnomaly('probe-init-error', { module: 'actions.js', message: String(err) });
    }

    try {
      const { Core } = await import('/js/core.js');
      if (Core && typeof Core.getState === 'function') {
        let previousState = { ...Core.getState() };
        const trackedKeys = [
          'mode', 'index', 'filename', 'src', 'archivePath',
          'archiveEncryption', 'isSpread', 'spreadStep', 'spreadEnabled',
          'spreadDirection', 'fitMode', 'scalingMode', 'fileListViewMode'
        ];

        Core.onStateChange((state) => {
          const diff = {};
          let hasChanges = false;

          for (const k of trackedKeys) {
            if (previousState[k] !== state[k]) {
              diff[k] = [previousState[k], state[k]];
              hasChanges = true;
            }
          }

          const prevLen = previousState.list?.length ?? 0;
          const nextLen = state.list?.length ?? 0;
          if (prevLen !== nextLen) {
            diff.listLength = [prevLen, nextLen];
            hasChanges = true;
          }

          previousState = { ...state };
          if (hasChanges) {
            recordEvent('core', 'state-change', diff);
          }
        });

        if (typeof Core.navigate === 'function') {
          const origNav = Core.navigate.bind(Core);
          Core.navigate = function(delta) {
            const st = Core.getState();
            recordEvent('core', 'navigate-call', {
              delta,
              fromIndex: st.index,
              spreadStep: st.spreadStep,
              isSpread: st.isSpread,
              spreadEnabled: st.spreadEnabled,
              listLength: st.list?.length ?? 0,
            });
            return origNav(delta);
          };
        }

        if (typeof Core.persistConfig === 'function') {
          const origPersist = Core.persistConfig.bind(Core);
          Core.persistConfig = function(options) {
            const fd = Core.getState().config?.frontend_data;
            recordEvent('core', 'persist-config', {
              immediate: options?.immediate || false,
              debounceMs: options?.debounceMs || 1500,
              lastOpenedPath: fd?.last_opened_path,
              lastActiveImage: fd?.last_active_image,
              scrollZoomLatched: fd?.scroll_zoom_latched,
            });
            return origPersist(options);
          };
        }
      }
    } catch (err) {
      recordAnomaly('probe-init-error', { module: 'core.js', message: String(err) });
    }
  }

  registerProbe('core-pipeline', {
    onStepStart() {
      _initCoreProbe();
    },
  });

  // =========================================================================
  // 3. VIEWER PIPELINE PROBE
  // =========================================================================
  let _viewerProbeInitialized = false;
  let _hadVisibleContentAtStart = false;
  let _hasRenderedContent = false;
  let _lastStripTy = null;

  function _getStripMetrics() {
    const strip = document.getElementById('manhwa-strip');
    if (!strip) return null;
    const transform = strip.style.transform || '';
    let ty = 0;
    const match = transform.match(/translate(?:3d)?\([^,]+,\s*([^,)]+)/);
    if (match) ty = parseFloat(match[1]);

    const zoomScale = parseFloat(strip.style.getPropertyValue('--zoom-scale')) || 1;
    const mountedSlots = strip.querySelectorAll('.manhwa-slot').length;
    const topSpacer = document.getElementById('manhwa-strip-spacer-top');
    const bottomSpacer = document.getElementById('manhwa-strip-spacer-bottom');
    const spacerTop = topSpacer ? parseFloat(topSpacer.style.getPropertyValue('--strip-spacer-top')) || 0 : 0;
    const spacerBottom = bottomSpacer ? parseFloat(bottomSpacer.style.getPropertyValue('--strip-spacer-bottom')) || 0 : 0;

    return {
      ty,
      zoomScale,
      mountedSlotCount: mountedSlots,
      spacerTop,
      spacerBottom,
    };
  }

  function _isViewerContentVisible() {
    const viewport = document.getElementById('viewport');
    if (viewport?.classList.contains('manhwa-active')) {
      const manhwaCanvas = document.getElementById('manhwa-filter-canvas');
      const hasFilter = viewport.hasAttribute('data-filter');
      if (hasFilter && manhwaCanvas) {
        const ready = manhwaCanvas.getAttribute('data-render-ready') === 'true';
        const opacity = parseFloat(window.getComputedStyle(manhwaCanvas).opacity) || 0;
        if (ready && opacity > 0) return true;
      }

      const strip = document.getElementById('manhwa-strip');
      const mountedImg = strip?.querySelector('.manhwa-slot img');
      if (mountedImg && mountedImg.complete && mountedImg.naturalWidth > 0) {
        if (!hasFilter || window.getComputedStyle(mountedImg).visibility !== 'hidden') {
          return true;
        }
      }

      const mountedVideo = strip?.querySelector('.manhwa-slot video');
      if (mountedVideo && mountedVideo.readyState >= 2 && mountedVideo.videoWidth > 0) {
        if (!hasFilter || window.getComputedStyle(mountedVideo).visibility !== 'hidden') {
          return true;
        }
      }
    }

    const imgWrapper = document.getElementById('viewer-img-wrapper');
    const activeImg = imgWrapper?.querySelector('.viewer-img.active');
    const bridgeImg = document.getElementById('viewer-bridge-layer')?.querySelector('.viewer-img.bridge') ?? imgWrapper?.querySelector('.viewer-img.bridge');
    const activeVideo = imgWrapper?.querySelector('.viewer-video.active');
    const bridgeVideo = document.getElementById('viewer-bridge-layer')?.querySelector('.viewer-video.bridge') ?? imgWrapper?.querySelector('.viewer-video.bridge');
    const lanczosCanvas = document.getElementById('viewer-lanczos-canvas');
    const filterCanvas = document.getElementById('viewer-filter-canvas');
    const manhwaCanvas = document.getElementById('manhwa-filter-canvas');

    const activeOpacity = activeImg ? parseFloat(window.getComputedStyle(activeImg).opacity) : 0;
    const bridgeOpacity = bridgeImg ? parseFloat(window.getComputedStyle(bridgeImg).opacity) : 0;
    const activeVideoOpacity = activeVideo ? parseFloat(window.getComputedStyle(activeVideo).opacity) : 0;
    const bridgeVideoOpacity = bridgeVideo ? parseFloat(window.getComputedStyle(bridgeVideo).opacity) : 0;
    const lanczosOpacity = lanczosCanvas ? parseFloat(window.getComputedStyle(lanczosCanvas).opacity) : 0;
    const filterOpacity = filterCanvas ? parseFloat(window.getComputedStyle(filterCanvas).opacity) : 0;
    const manhwaOpacity = manhwaCanvas ? parseFloat(window.getComputedStyle(manhwaCanvas).opacity) : 0;

    const lanczosReady = lanczosCanvas?.getAttribute('data-render-ready') === 'true';
    const filterReady = filterCanvas?.getAttribute('data-render-ready') === 'true';
    const manhwaReady = manhwaCanvas?.getAttribute('data-render-ready') === 'true';

    const hasActive = !!(activeImg && activeOpacity > 0 && activeImg.complete && activeImg.naturalWidth > 0);
    const hasBridge = !!(bridgeImg && bridgeOpacity > 0 && bridgeImg.naturalWidth > 0);
    const hasActiveVideo = !!(activeVideo && activeVideoOpacity > 0 && activeVideo.readyState >= 2 && activeVideo.videoWidth > 0);
    const hasBridgeVideo = !!(bridgeVideo && bridgeVideoOpacity > 0 && bridgeVideo.readyState >= 2);
    const hasCanvas = (lanczosReady && lanczosOpacity > 0) || (filterReady && filterOpacity > 0) || (manhwaReady && manhwaOpacity > 0);

    return hasActive || hasBridge || hasActiveVideo || hasBridgeVideo || hasCanvas;
  }

  function _initViewerProbe() {
    if (_viewerProbeInitialized) return;
    _viewerProbeInitialized = true;

    if (typeof HTMLImageElement !== 'undefined' && HTMLImageElement.prototype.decode) {
      const origDecode = HTMLImageElement.prototype.decode;
      HTMLImageElement.prototype.decode = async function() {
        if (!this.classList.contains('viewer-img')) return origDecode.call(this);

        const src = this.getAttribute('src') || this.src || '';
        const t0 = performance.now();
        recordEvent('viewer', 'image-decode-start', { src });

        try {
          const res = await origDecode.call(this);
          const elapsedMs = parseFloat((performance.now() - t0).toFixed(2));
          recordEvent('viewer', 'image-decode-end', {
            src,
            elapsedMs,
            naturalWidth: this.naturalWidth,
            naturalHeight: this.naturalHeight,
          });
          return res;
        } catch (err) {
          const elapsedMs = parseFloat((performance.now() - t0).toFixed(2));
          recordEvent('viewer', 'image-decode-fail', { src, elapsedMs, error: String(err) });
          throw err;
        }
      };
    }

    if (typeof window.createImageBitmap === 'function') {
      const origCreateBitmap = window.createImageBitmap;
      window.createImageBitmap = async function(...args) {
        const t0 = performance.now();
        try {
          const bitmap = await origCreateBitmap.apply(this, args);
          const elapsedMs = parseFloat((performance.now() - t0).toFixed(2));
          recordEvent('viewer', 'bitmap-create-end', {
            elapsedMs,
            width: bitmap.width,
            height: bitmap.height,
          });
          return bitmap;
        } catch (err) {
          const elapsedMs = parseFloat((performance.now() - t0).toFixed(2));
          recordEvent('viewer', 'bitmap-create-fail', { elapsedMs, error: String(err) });
          throw err;
        }
      };
    }

    if (typeof MutationObserver !== 'undefined') {
      const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
          if (m.type === 'attributes') {
            if (m.attributeName === 'class' && m.target.classList.contains('viewer-img')) {
              const isActive = m.target.classList.contains('active');
              const isBridge = m.target.classList.contains('bridge');
              const role = isActive ? 'active' : (isBridge ? 'bridge' : 'idle');
              recordEvent('viewer', 'img-role-change', {
                role,
                src: m.target.getAttribute('src') || m.target.src || null,
              });
            } else if (m.attributeName === 'class' && m.target.classList.contains('viewer-video')) {
              const isActive = m.target.classList.contains('active');
              const isBridge = m.target.classList.contains('bridge');
              const role = isActive ? 'active' : (isBridge ? 'bridge' : 'idle');
              recordEvent('viewer', 'video-role-change', {
                role,
                src: m.target.dataset?.vidSrc || m.target.getAttribute('src') || m.target.src || null,
              });
            } else if (m.attributeName === 'data-render-ready') {
              const ready = m.target.getAttribute('data-render-ready') === 'true';
              recordEvent('viewer', 'canvas-ready-change', {
                canvasId: m.target.id,
                ready,
              });
            } else if (m.attributeName === 'data-filter' && m.target.id === 'viewport') {
              recordEvent('viewer', 'viewport-filter-change', {
                filter: m.target.getAttribute('data-filter'),
              });
            }
          }
        }
      });

      const viewport = document.getElementById('viewport');
      if (viewport) {
        observer.observe(viewport, {
          attributes: true,
          subtree: true,
          attributeFilter: ['class', 'data-render-ready', 'data-filter'],
        });
      }
    }
  }

  registerProbe('viewer-pipeline', {
    onStepStart() {
      _initViewerProbe();
      _lastStripTy = null;
      _hadVisibleContentAtStart = _isViewerContentVisible();
      _hasRenderedContent = _hadVisibleContentAtStart;
      const strip = _getStripMetrics();
      if (strip) {
        recordEvent('viewer', 'strip-metrics', strip);
      }
    },
    onStepStop() {
      const strip = _getStripMetrics();
      if (strip) {
        recordEvent('viewer', 'strip-state', strip);
      }
    },
    checkFrame(frameCtx) {
      const viewport = document.getElementById('viewport');
      if (viewport?.classList.contains('manhwa-active')) {
        const strip = _getStripMetrics();
        if (strip && _lastStripTy !== null) {
          if (Math.abs(strip.ty - _lastStripTy) > 40000) {
            return {
              type: 'ty-teleport',
              t: frameCtx.relMs,
              prevTy: _lastStripTy,
              currTy: strip.ty,
              delta: Math.abs(strip.ty - _lastStripTy),
            };
          }
        }
        if (strip) _lastStripTy = strip.ty;
      }

      const statusbarFilename = document.querySelector('#statusbar .status-filename, #statusbar .filename')?.textContent?.trim() || '';
      if (statusbarFilename === '..' || statusbarFilename.endsWith('/') || statusbarFilename.endsWith('\\')) {
        return null;
      }

      const vp = document.getElementById('viewport');
      const vpRect = vp ? vp.getBoundingClientRect() : null;
      function intersectsVp(r) {
        if (!r || !vpRect) return false;
        const overlapH = Math.max(0, Math.min(r.bottom, vpRect.bottom) - Math.max(r.top, vpRect.top));
        const overlapW = Math.max(0, Math.min(r.right, vpRect.right) - Math.max(r.left, vpRect.left));
        return overlapH >= 50 && overlapW >= 50;
      }

      // Check real visual visibility on screen via getBoundingClientRect & computed style
      const bridgeEl = document.getElementById('viewer-bridge-layer')?.querySelector('.viewer-img.bridge, .viewer-video.bridge');
      const bRect = bridgeEl ? bridgeEl.getBoundingClientRect() : null;
      const bCs = bridgeEl ? window.getComputedStyle(bridgeEl) : null;
      const bridgeVisible = !!(
        bridgeEl &&
        bRect && bRect.width > 0 && bRect.height > 0 && intersectsVp(bRect) &&
        bCs && bCs.display !== 'none' && bCs.visibility !== 'hidden' && parseFloat(bCs.opacity) > 0 &&
        (bridgeEl.naturalWidth > 0 || bridgeEl.videoWidth > 0 || bridgeEl.readyState >= 2)
      );

      const strip = document.getElementById('manhwa-strip');
      const mountedImgs = Array.from(strip?.querySelectorAll('.manhwa-slot img') || []);
      const visibleStripImg = mountedImgs.find((sImg) => {
        if (!sImg || !sImg.complete || sImg.naturalWidth <= 0) return false;
        const sr = sImg.getBoundingClientRect();
        const sc = window.getComputedStyle(sImg);
        return sr.width > 0 && sr.height > 0 && intersectsVp(sr) &&
          sc.display !== 'none' && sc.visibility !== 'hidden' && parseFloat(sc.opacity) > 0;
      });
      const stripImgVisible = !!visibleStripImg;
      const sRect = visibleStripImg ? visibleStripImg.getBoundingClientRect() : (mountedImgs[0] ? mountedImgs[0].getBoundingClientRect() : null);
      const stripImg = visibleStripImg || mountedImgs[0] || null;

      const mountedVideos = Array.from(strip?.querySelectorAll('.manhwa-slot video') || []);
      const visibleStripVideo = mountedVideos.find((sVid) => {
        if (!sVid || sVid.readyState < 2 || sVid.videoWidth <= 0) return false;
        const sr = sVid.getBoundingClientRect();
        const sc = window.getComputedStyle(sVid);
        return sr.width > 0 && sr.height > 0 && intersectsVp(sr) &&
          sc.display !== 'none' && sc.visibility !== 'hidden' && parseFloat(sc.opacity) > 0;
      });
      const stripVideoVisible = !!visibleStripVideo;

      const imgWrapper = document.getElementById('viewer-img-wrapper');
      const activeImg = imgWrapper?.querySelector('.viewer-img.active');
      const aRect = activeImg ? activeImg.getBoundingClientRect() : null;
      const aCs = activeImg ? window.getComputedStyle(activeImg) : null;
      const activeImgVisible = !!(
        activeImg && activeImg.complete && activeImg.naturalWidth > 0 &&
        aRect && aRect.width > 0 && aRect.height > 0 && intersectsVp(aRect) &&
        aCs && aCs.display !== 'none' && aCs.visibility !== 'hidden' && parseFloat(aCs.opacity) > 0
      );

      const activeVideo = imgWrapper?.querySelector('.viewer-video.active');
      const avRect = activeVideo ? activeVideo.getBoundingClientRect() : null;
      const avCs = activeVideo ? window.getComputedStyle(activeVideo) : null;
      const activeVideoVisible = !!(
        activeVideo && activeVideo.readyState >= 2 && activeVideo.videoWidth > 0 &&
        avRect && avRect.width > 0 && avRect.height > 0 && intersectsVp(avRect) &&
        avCs && avCs.display !== 'none' && avCs.visibility !== 'hidden' && parseFloat(avCs.opacity) > 0
      );

      const manhwaCanvas = document.getElementById('manhwa-filter-canvas');
      const mcRect = manhwaCanvas ? manhwaCanvas.getBoundingClientRect() : null;
      const mcCs = manhwaCanvas ? window.getComputedStyle(manhwaCanvas) : null;
      const manhwaCanvasVisible = !!(
        manhwaCanvas && manhwaCanvas.getAttribute('data-render-ready') === 'true' &&
        mcRect && mcRect.width > 0 && mcRect.height > 0 && intersectsVp(mcRect) &&
        mcCs && mcCs.display !== 'none' && mcCs.visibility !== 'hidden' && parseFloat(mcCs.opacity) > 0
      );

      const filterCanvas = document.getElementById('viewer-filter-canvas');
      const fcRect = filterCanvas ? filterCanvas.getBoundingClientRect() : null;
      const fcCs = filterCanvas ? window.getComputedStyle(filterCanvas) : null;
      const filterCanvasVisible = !!(
        filterCanvas && filterCanvas.getAttribute('data-render-ready') === 'true' &&
        fcRect && fcRect.width > 0 && fcRect.height > 0 && intersectsVp(fcRect) &&
        fcCs && fcCs.display !== 'none' && fcCs.visibility !== 'hidden' && parseFloat(fcCs.opacity) > 0
      );

      const anyVisible = bridgeVisible || stripImgVisible || stripVideoVisible || activeImgVisible || activeVideoVisible || manhwaCanvasVisible || filterCanvasVisible;

      // Log frame-detail for the first 12 frames of each step
      if (frameCtx.frameCount <= 12 || !anyVisible) {
        recordEvent('viewer', 'frame-detail', {
          frameCount: frameCtx.frameCount,
          t: frameCtx.relMs,
          viewportManhwa: viewport?.classList.contains('manhwa-active') || false,
          bridgeVisible,
          bridgeRect: bRect ? { w: Math.round(bRect.width), h: Math.round(bRect.height), top: Math.round(bRect.top), left: Math.round(bRect.left) } : null,
          bridgeProps: bridgeEl ? {
            tx: bridgeEl.style.getPropertyValue('--bridge-tx'),
            ty: bridgeEl.style.getPropertyValue('--bridge-ty'),
            sx: bridgeEl.style.getPropertyValue('--bridge-sx'),
            sy: bridgeEl.style.getPropertyValue('--bridge-sy'),
          } : null,
          stripImgVisible,
          stripImgRect: sRect ? { w: Math.round(sRect.width), h: Math.round(sRect.height), top: Math.round(sRect.top), left: Math.round(sRect.left) } : null,
          mountedSlots: mountedImgs.map((img) => ({
            colIdx: img.dataset.imgIdx,
            top: Math.round(img.getBoundingClientRect().top),
            bottom: Math.round(img.getBoundingClientRect().bottom),
            nw: img.naturalWidth,
          })),
          activeImgVisible,
          activeImgRect: aRect ? { w: Math.round(aRect.width), h: Math.round(aRect.height) } : null,
          anyVisible,
        });
      }

      if (anyVisible) {
        _hasRenderedContent = true;
      }

      const isBlackout = !anyVisible && (_hadVisibleContentAtStart || _hasRenderedContent);
      if (!isBlackout) return null;

      return {
        type: 'blackout',
        t: frameCtx.relMs,
        viewportManhwa: viewport?.classList.contains('manhwa-active') || false,
        bridgeVisible,
        bridgeTag: bridgeEl?.tagName || null,
        bridgeSrc: bridgeEl?.getAttribute('src') || bridgeEl?.src || null,
        bridgeRect: bRect ? { w: Math.round(bRect.width), h: Math.round(bRect.height), top: Math.round(bRect.top), left: Math.round(bRect.left) } : null,
        stripImgVisible,
        stripMounted: strip?.querySelectorAll('.manhwa-slot').length || 0,
        stripImgSrc: stripImg?.getAttribute('src') || stripImg?.src || null,
        activeImgVisible,
        activeWrapperDisplay: imgWrapper ? window.getComputedStyle(imgWrapper).display : null,
      };
    },
  });

  // =========================================================================
  // 4. IPC AND PROTOCOL PROBE
  // =========================================================================
  let _ipcProbeInitialized = false;
  function _initIpcProbe() {
    if (_ipcProbeInitialized) return;
    _ipcProbeInitialized = true;

    const tauriCore = window.__TAURI__?.core || window.__TAURI__;
    if (tauriCore && typeof tauriCore.invoke === 'function') {
      const origInvoke = tauriCore.invoke;
      tauriCore.invoke = async function(cmd, args, options) {
        const t0 = performance.now();
        const argKeys = args && typeof args === 'object' ? Object.keys(args) : [];
        recordEvent('ipc', 'invoke-start', { cmd, argKeys });

        try {
          const result = await origInvoke.call(this, cmd, args, options);
          const elapsedMs = parseFloat((performance.now() - t0).toFixed(2));
          recordEvent('ipc', 'invoke-end', { cmd, elapsedMs });
          return result;
        } catch (err) {
          const elapsedMs = parseFloat((performance.now() - t0).toFixed(2));
          recordAnomaly('ipc-error', { cmd, elapsedMs, message: err?.message || String(err) });
          throw err;
        }
      };
    }

    if (typeof window.fetch === 'function') {
      const origFetch = window.fetch;
      window.fetch = async function(input, init) {
        const urlStr = typeof input === 'string' ? input : (input?.url || '');
        const isQuivit = urlStr.includes('quivit://') || urlStr.includes('quivit.localhost');
        const isAsset = urlStr.includes('asset://') || urlStr.includes('asset.localhost');

        if (!isQuivit && !isAsset) {
          return origFetch.apply(this, arguments);
        }

        let route = 'other';
        if (urlStr.includes('/archive/')) route = 'archive';
        else if (urlStr.includes('/thumb/')) route = 'thumb';
        else if (urlStr.includes('/icon/')) route = 'icon';
        else if (isAsset) route = 'asset';

        const t0 = performance.now();
        recordEvent('protocol', 'fetch-start', { route });

        try {
          const res = await origFetch.apply(this, arguments);
          const elapsedMs = parseFloat((performance.now() - t0).toFixed(2));
          const status = res.status;

          if (status >= 400) {
            recordAnomaly('protocol-status-error', { route, status, elapsedMs });
          } else {
            recordEvent('protocol', 'fetch-end', { route, status, elapsedMs });
          }
          return res;
        } catch (err) {
          const elapsedMs = parseFloat((performance.now() - t0).toFixed(2));
          recordAnomaly('protocol-fetch-fail', { route, elapsedMs, message: err?.message || String(err) });
          throw err;
        }
      };
    }
  }

  registerProbe('ipc-protocol', {
    onStepStart() {
      _initIpcProbe();
    },
  });

  // =========================================================================
  // 5. M-TO-L BRIDGE PROBE (investigation only)
  // Catches the manhwa-column teardown to legacy-filter-canvas handoff.
  // Logs per-frame paintability of both canvases plus bridge/active image
  // decode state, and flags any frame where nothing can paint.
  // =========================================================================
  let _mlPrevColReady = null;
  let _mlPrevLegReady = null;
  let _mlTearT = null;
  let _mlObserverOn = false;

  function _mlImgSig(img) {
    if (!img) return null;
    let op = 0;
    try { op = parseFloat(window.getComputedStyle(img).opacity) || 0; } catch { op = 0; }
    const r = img.getBoundingClientRect ? img.getBoundingClientRect() : null;
    return {
      complete: !!img.complete,
      nw: img.naturalWidth || 0,
      nh: img.naturalHeight || 0,
      op,
      w: r ? Math.round(r.width) : 0,
      srcTail: ((img.getAttribute && img.getAttribute('src')) || img.src || '').split('/').pop()?.slice(0, 24) || null,
    };
  }

  function _mlCanvasSig(id) {
    const c = document.getElementById(id);
    if (!c) return { exists: false };
    let op = 0;
    let display = '?';
    try {
      const cs = window.getComputedStyle(c);
      op = parseFloat(cs.opacity) || 0;
      display = cs.display || '?';
    } catch { op = 0; }
    const r = c.getBoundingClientRect ? c.getBoundingClientRect() : null;
    const ready = c.getAttribute('data-render-ready') === 'true';
    const w = r ? Math.round(r.width) : 0;
    const h = r ? Math.round(r.height) : 0;
    return {
      exists: true,
      ready,
      op,
      display,
      w,
      h,
      shown: ready && op > 0 && display !== 'none' && w > 0 && h > 0,
    };
  }

  // First/last timestamp of the unfiltered middle window per step, where
  // the legacy GL canvas is already hidden but the column has not painted.
  let _glGapStart = null;
  let _glGapEnd = null;

  registerProbe('ml-bridge', {
    onStepStart() {
      _mlPrevColReady = null;
      _mlPrevLegReady = null;
      _mlTearT = null;
      _glGapStart = null;
      _glGapEnd = null;
      const vp = document.getElementById('viewport');
      recordEvent('ml', 'step-start', {
        manhwa: vp?.classList.contains('manhwa-active') || false,
        col: _mlCanvasSig('manhwa-filter-canvas'),
        leg: _mlCanvasSig('viewer-filter-canvas'),
      });
      if (!_mlObserverOn && typeof MutationObserver !== 'undefined' && vp) {
        _mlObserverOn = true;
        const obs = new MutationObserver((mutations) => {
          for (const m of mutations) {
            if (m.type !== 'attributes' || m.attributeName !== 'data-render-ready') continue;
            const id = m.target.id || m.target.className || '?';
            if (id !== 'manhwa-filter-canvas' && id !== 'viewer-filter-canvas') continue;
            const wrap = document.getElementById('viewer-img-wrapper');
            const bridge = wrap?.querySelector('.viewer-img.bridge') || document.getElementById('viewer-bridge-layer')?.querySelector('.viewer-img.bridge');
            const active = wrap?.querySelector('.viewer-img.active');
            recordEvent('ml', 'canvas-flip', {
              canvasId: id,
              ready: m.target.getAttribute('data-render-ready') === 'true',
              manhwa: document.getElementById('viewport')?.classList.contains('manhwa-active') || false,
              bridge: _mlImgSig(bridge),
              active: _mlImgSig(active),
            });
          }
        });
        obs.observe(vp, { attributes: true, subtree: true, attributeFilter: ['data-render-ready'] });
      }
    },
    checkFrame(frameCtx) {
      const vp = document.getElementById('viewport');
      const col = _mlCanvasSig('manhwa-filter-canvas');
      const leg = _mlCanvasSig('viewer-filter-canvas');
      const wrap = document.getElementById('viewer-img-wrapper');
      const bridge = wrap?.querySelector('.viewer-img.bridge') || document.getElementById('viewer-bridge-layer')?.querySelector('.viewer-img.bridge');
      const active = wrap?.querySelector('.viewer-img.active');
      const b = _mlImgSig(bridge);
      const a = _mlImgSig(active);

      if (_mlPrevColReady === true && col.ready === false) {
        _mlTearT = frameCtx.relMs;
        recordEvent('ml', 'column-torn-down', { t: frameCtx.relMs, leg, bridge: b, active: a });
      }
      if (_mlPrevLegReady === false && leg.ready === true && _mlTearT !== null) {
        recordAnomaly('ml-handoff', {
          tearT: _mlTearT,
          paintT: frameCtx.relMs,
          gapMs: parseFloat((frameCtx.relMs - _mlTearT).toFixed(1)),
          bridge: b,
          active: a,
        });
        _mlTearT = null;
      }
      _mlPrevColReady = col.ready;
      _mlPrevLegReady = leg.ready;

      const colPaintable = col.exists && col.ready && col.op > 0 && col.w > 0;
      const legPaintable = leg.exists && leg.ready && leg.op > 0 && leg.w > 0;
      const imgPaintable = (s) => !!(s && s.complete && s.nw > 0 && s.op > 0 && s.w > 0);
      const strip = document.getElementById('manhwa-strip');
      const simgs = Array.from(strip?.querySelectorAll('.manhwa-slot img') || []);
      const stripDecoded = simgs.filter((im) => im && im.complete && im.naturalWidth > 0).length;
      const inManhwa = vp?.classList.contains('manhwa-active') || false;

      // Unfiltered middle window: legacy GL hidden, column not up, but
      // unfiltered DOM content (bridge or mounting slots) is on screen.
      // This is the stretch a WebGL bridge would keep filtered.
      const domCover = imgPaintable(b) || imgPaintable(a) || stripDecoded > 0;
      if (inManhwa && !col.shown && !leg.shown && domCover) {
        if (_glGapStart === null) {
          _glGapStart = frameCtx.relMs;
          recordEvent('ml', 'gl-gap-start', {
            t: frameCtx.relMs,
            legDisplay: leg.display,
            legReady: leg.ready,
            bridge: b,
            stripDecoded,
          });
        }
        _glGapEnd = frameCtx.relMs;
      } else if (_glGapStart !== null && (col.shown || !inManhwa)) {
        recordAnomaly('gl-gap', {
          startT: _glGapStart,
          endT: frameCtx.relMs,
          spanMs: parseFloat((frameCtx.relMs - _glGapStart).toFixed(1)),
        });
        _glGapStart = null;
        _glGapEnd = null;
      }
      if (!colPaintable && !legPaintable && !imgPaintable(b) && !imgPaintable(a) && stripDecoded === 0) {
        return {
          type: 'ml-blank',
          t: frameCtx.relMs,
          manhwa: vp?.classList.contains('manhwa-active') || false,
          colReady: col.ready,
          legReady: leg.ready,
          bridge: b,
          active: a,
          stripDecoded,
        };
      }
      return null;
    },
    onStepStop() {
      if (_glGapStart !== null) {
        recordAnomaly('gl-gap-open', { startT: _glGapStart, lastT: _glGapEnd });
        _glGapStart = null;
        _glGapEnd = null;
      }
    },
  });

  return engine;
}
