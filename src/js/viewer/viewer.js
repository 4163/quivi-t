import { createViewportState } from '../services/viewerMath.js';
import { createViewerRenderer } from './viewerRender.js';
import { createViewerGestures } from './viewerGestures.js';

const viewportState = createViewportState({
  getViewport: () => {
    const vp = document.getElementById('viewport');
    if (!vp) return { clientWidth: 1000, clientHeight: 1000, left: 0, top: 0 };
    const rect = vp.getBoundingClientRect();
    return {
      clientWidth: rect.width,
      clientHeight: rect.height,
      left: rect.left,
      top: rect.top
    };
  }
});

createViewerRenderer(viewportState);
createViewerGestures(viewportState);

window.addEventListener('quivit-panel-resized', () => {
  viewportState.applyFitMode();
});

function _getViewportCenter() {
  const vp = document.getElementById('viewport');
  if (!vp) return null;
  const rect = vp.getBoundingClientRect();
  return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
}

export const Viewer = { 
  applyFitMode: (mode) => viewportState.applyFitMode(mode),
  zoomAt: viewportState.zoomAt,
  zoomCenter: (delta) => {
    const c = _getViewportCenter();
    if (c) viewportState.zoomAt(delta, c.x, c.y);
  },
  panBy: viewportState.panBy,
  rotate: viewportState.rotate,
  flipHorizontal: () => viewportState.flip('x'),
  flipVertical: () => viewportState.flip('y'),
  setScaling: viewportState.setScaling,
  setZoom: (exactScale) => {
    const c = _getViewportCenter();
    if (!c) return;
    viewportState.applyFitMode('none');
    viewportState.zoomTo(exactScale, c.x, c.y);
  }
};
