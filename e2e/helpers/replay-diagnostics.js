/**
 * replay-diagnostics.js: Diagnostic frame-level observer injected during replay runs.
 * Validates viewport rendering invariants and detects blackout/flicker frames on every tick.
 */

export function initReplayDiagnostics() {
  if (window.__QUIVIT_DIAGNOSTICS__) return;

  let _activeMonitoring = false;
  let _stepLogs = [];
  let _blackoutFrames = [];
  let _stepEvents = [];
  let _rafId = null;
  let _currentStep = null;

  let _hadVisibleContentAtStepStart = false;
  let _hasRenderedContent = false;

  function _isContentVisible() {
    const imgWrapper = document.getElementById('viewer-img-wrapper');
    const activeImg = imgWrapper?.querySelector('.viewer-img.active');
    const bridgeImg = imgWrapper?.querySelector('.viewer-img.bridge');
    const lanczosCanvas = document.getElementById('viewer-lanczos-canvas');
    const filterCanvas = document.getElementById('viewer-filter-canvas');

    const activeOpacity = activeImg ? parseFloat(window.getComputedStyle(activeImg).opacity) : 0;
    const bridgeOpacity = bridgeImg ? parseFloat(window.getComputedStyle(bridgeImg).opacity) : 0;
    const lanczosOpacity = lanczosCanvas ? parseFloat(window.getComputedStyle(lanczosCanvas).opacity) : 0;
    const filterOpacity = filterCanvas ? parseFloat(window.getComputedStyle(filterCanvas).opacity) : 0;

    const lanczosReady = lanczosCanvas?.getAttribute('data-render-ready') === 'true';
    const filterReady = filterCanvas?.getAttribute('data-render-ready') === 'true';

    const hasVisibleActiveImg = !!(activeImg && activeOpacity > 0 && activeImg.complete && activeImg.naturalWidth > 0);
    const hasVisibleBridgeImg = !!(bridgeImg && bridgeOpacity > 0 && bridgeImg.naturalWidth > 0);
    const hasVisibleCanvas = (lanczosReady && lanczosOpacity > 0) || (filterReady && filterOpacity > 0);

    return hasVisibleActiveImg || hasVisibleBridgeImg || hasVisibleCanvas;
  }

  function _checkViewportFrame() {
    if (!_activeMonitoring) return;

    const statusbarFilename = document.querySelector('#statusbar .status-filename, #statusbar .filename')?.textContent?.trim() || '';
    if (statusbarFilename === '..' || statusbarFilename.endsWith('/') || statusbarFilename.endsWith('\\')) {
      _rafId = requestAnimationFrame(_checkViewportFrame);
      return;
    }

    const viewportEl = document.getElementById('viewport');
    const imgWrapper = document.getElementById('viewer-img-wrapper');
    const activeImg = imgWrapper?.querySelector('.viewer-img.active');
    const bridgeImg = imgWrapper?.querySelector('.viewer-img.bridge');
    const lanczosCanvas = document.getElementById('viewer-lanczos-canvas');
    const filterCanvas = document.getElementById('viewer-filter-canvas');

    const activeOpacity = activeImg ? parseFloat(window.getComputedStyle(activeImg).opacity) : 0;
    const bridgeOpacity = bridgeImg ? parseFloat(window.getComputedStyle(bridgeImg).opacity) : 0;
    const lanczosOpacity = lanczosCanvas ? parseFloat(window.getComputedStyle(lanczosCanvas).opacity) : 0;
    const filterOpacity = filterCanvas ? parseFloat(window.getComputedStyle(filterCanvas).opacity) : 0;

    const lanczosReady = lanczosCanvas?.getAttribute('data-render-ready') === 'true';
    const filterReady = filterCanvas?.getAttribute('data-render-ready') === 'true';
    const viewportFilter = viewportEl?.getAttribute('data-filter') || null;

    const hasVisibleActiveImg = !!(activeImg && activeOpacity > 0 && activeImg.complete && activeImg.naturalWidth > 0);
    const hasVisibleBridgeImg = !!(bridgeImg && bridgeOpacity > 0 && bridgeImg.naturalWidth > 0);
    const hasVisibleCanvas = (lanczosReady && lanczosOpacity > 0) || (filterReady && filterOpacity > 0);

    const isVisibleNow = hasVisibleActiveImg || hasVisibleBridgeImg || hasVisibleCanvas;
    if (isVisibleNow) {
      _hasRenderedContent = true;
    }

    const isBlackout = !isVisibleNow && (_hadVisibleContentAtStepStart || _hasRenderedContent);

    if (isBlackout) {
      _blackoutFrames.push({
        timestamp: performance.now(),
        viewportFilter,
        activeSrc: activeImg?.getAttribute('src') || activeImg?.src || null,
        activeComplete: activeImg?.complete || false,
        activeNaturalWidth: activeImg?.naturalWidth || 0,
        activeOpacity,
        bridgeSrc: bridgeImg?.getAttribute('src') || bridgeImg?.src || null,
        bridgeOpacity,
        lanczosReady,
        lanczosOpacity,
        filterReady,
        filterOpacity,
      });
    }

    _rafId = requestAnimationFrame(_checkViewportFrame);
  }

  window.__QUIVIT_DIAGNOSTICS__ = {
    recordEvent(source, event, data) {
      if (!_activeMonitoring) return;
      const now = performance.now();
      const relMs = _currentStep ? parseFloat((now - _currentStep.startTime).toFixed(1)) : 0;
      _stepEvents.push({
        t: relMs,
        source,
        event,
        data: data || null,
      });
    },

    startStep(stepIndex, actionId) {
      _currentStep = {
        stepIndex,
        actionId,
        startTime: performance.now(),
      };
      _blackoutFrames = [];
      _stepEvents = [];
      _hadVisibleContentAtStepStart = _isContentVisible();
      _hasRenderedContent = _hadVisibleContentAtStepStart;
      _activeMonitoring = true;
      if (_rafId) cancelAnimationFrame(_rafId);
      _rafId = requestAnimationFrame(_checkViewportFrame);
    },

    stopStep() {
      _activeMonitoring = false;
      if (_rafId) {
        cancelAnimationFrame(_rafId);
        _rafId = null;
      }
      const endTime = performance.now();
      const durationMs = _currentStep ? Math.round(endTime - _currentStep.startTime) : 0;
      const statusbarFilename = document.querySelector('#statusbar .status-filename, #statusbar .filename')?.textContent?.trim() || '';

      const report = {
        stepIndex: _currentStep?.stepIndex ?? -1,
        actionId: _currentStep?.actionId ?? '',
        filename: statusbarFilename,
        durationMs,
        blackoutFrameCount: _blackoutFrames.length,
        blackoutDetails: [..._blackoutFrames],
        events: [..._stepEvents],
      };

      _stepLogs.push(report);
      return report;
    },

    getAllLogs() {
      return [..._stepLogs];
    },
  };
}
