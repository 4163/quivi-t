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

export const Viewer = { 
  applyFitMode: (mode) => viewportState.applyFitMode(mode),
  zoomAt: viewportState.zoomAt,
  zoomCenter: (delta) => {
    const vp = document.getElementById('viewport');
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    viewportState.zoomAt(delta, rect.left + rect.width / 2, rect.top + rect.height / 2);
  },
  panBy: viewportState.panBy,
  rotate: viewportState.rotate,
  flipHorizontal: () => viewportState.flip('x'),
  flipVertical: () => viewportState.flip('y'),
  setScaling: viewportState.setScaling,
  setZoom: (exactScale) => {
    const vp = document.getElementById('viewport');
    if (!vp) return;
    const rect = vp.getBoundingClientRect();
    viewportState.applyFitMode('none');
    viewportState.zoomTo(exactScale, rect.left + rect.width / 2, rect.top + rect.height / 2);
  }
};
