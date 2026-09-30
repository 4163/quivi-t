import { createViewportState } from '../services/viewerMath.js';
import { createViewerRenderer } from './viewerRender.js';
import { createViewerGestures } from './viewerGestures.js';
import { createViewerPipelines } from './viewerPipelines.js';
import { isManhwaStripActive, initManhwaStrip, isStripAtTop, triggerRevealListTop, resetZoom as resetStripZoom, setOnSlotMounted, setOnBridgeHandoff } from './manhwaStrip.js';


let _cachedViewport = { clientWidth: 1000, clientHeight: 1000, left: 0, top: 0 };

function _updateCachedViewport() {
  const vp = document.getElementById('viewport');
  if (!vp) return _cachedViewport;
  const rect = vp.getBoundingClientRect();
  _cachedViewport = {
    clientWidth: rect.width,
    clientHeight: rect.height,
    left: rect.left,
    top: rect.top
  };
  return _cachedViewport;
}

_updateCachedViewport();

const viewportState = createViewportState({
  getViewport: () => _cachedViewport
});

const pipelines = createViewerPipelines(viewportState);
const renderer = createViewerRenderer(viewportState, (img) => {
  if (img) pipelines.setSource(img);
  else pipelines.clear();
});
const gestures = createViewerGestures(viewportState);
initManhwaStrip(viewportState);
function _doubleRaf(fn) {
  requestAnimationFrame(() => requestAnimationFrame(fn));
}

setOnSlotMounted(() => {
  if (!isManhwaStripActive() || !renderer.isBridgeActive()) return;
  _doubleRaf(() => {
    // A toggle-off inside these two frames must not spend a stale release
    // on the fresh m->l bridge. The fallback timer owns that retirement.
    if (!isManhwaStripActive()) return;
    renderer.releaseBridge();
  });
});
setOnBridgeHandoff((node, natW, natH, fitMode) => {
  renderer.parkHandoff(node, natW, natH, fitMode);
});

const vpEl = document.getElementById('viewport');
if (vpEl) {
  const ro = new ResizeObserver((entries) => {
    for (const entry of entries) {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        _updateCachedViewport();
        viewportState.handleViewportResize(width, height);
        pipelines.forceRender();
      }
    }
  });
  ro.observe(vpEl);
}
window.addEventListener('resize', _updateCachedViewport);

function _getViewportCenter() {
  if (!_cachedViewport.clientWidth || !_cachedViewport.clientHeight) {
    _updateCachedViewport();
  }
  return {
    x: _cachedViewport.left + _cachedViewport.clientWidth / 2,
    y: _cachedViewport.top + _cachedViewport.clientHeight / 2
  };
}

export const Viewer = { 
  applyFitMode: (mode) => viewportState.applyFitMode(mode),
  handleViewportResize: (w, h) => viewportState.handleViewportResize(w, h),
  zoomAt: (delta, x, y) => {
    viewportState.zoomAt(delta, x, y);
  },
  zoomCenter: (delta) => {
    const c = _getViewportCenter();
    if (c) viewportState.zoomAt(delta, c.x, c.y);
  },
  panBy: (dx, dy) => {
    // Upward pan with the strip already top-pinned has nowhere to go:
    // hand it to the file list so `..` scrolls into view.
    if (dy > 0 && isManhwaStripActive() && isStripAtTop()) triggerRevealListTop();
    viewportState.panBy(dx, dy);
  },
  rotate: (deg) => {
    if (isManhwaStripActive()) return;
    viewportState.rotate(deg);
  },
  flipHorizontal: () => {
    viewportState.flip('x');
  },
  flipVertical: () => {
    viewportState.flip('y');
  },
  setZoom: (exactScale) => {
    if (isManhwaStripActive() && resetStripZoom(exactScale)) return;
    viewportState.resetZoomOnly(exactScale);
  },
  toggleCursorAutoHide: () => gestures.toggleCursorAutoHide()
};
