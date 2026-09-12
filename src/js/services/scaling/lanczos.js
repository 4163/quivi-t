import { getCleanImageCrop } from '../../shared/blobImage.js';
import { invertViewport } from '../viewerMath.js';

let _resampler = null;
function getResampler() {
  return _resampler ||= window.pica();
}

const PICA_OPTIONS = {
  unsharpAmount: 80,
  unsharpRadius: 0.6,
  unsharpThreshold: 2
};

export function createLanczosPipeline(fallbackDestCanvas) {
  const _destCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : fallbackDestCanvas;
  let _activePromise = null;
  let _generation = 0;

  function cancel() {
    _activePromise = null;
    _generation += 1;
  }

  function dispose() {
    cancel();
  }

  return {
    type: 'lanczos',
    render: async (sourceImg, geom) => {
      const { scale, tx, ty, rotation, flipX, flipY, viewport } = geom;
      cancel();
      const generation = _generation;

      const nw = sourceImg.naturalWidth;
      const nh = sourceImg.naturalHeight;

      if (nw <= 0 || nh <= 0) return null;

      // Un-project viewport corners to imgWrapper local coordinates
      const cx = viewport.clientWidth / 2;
      const cy = viewport.clientHeight / 2;

      // Map the 4 corners of the viewport
      const pts = [
        invertViewport(-cx, -cy, geom, nw, nh),
        invertViewport(cx, -cy, geom, nw, nh),
        invertViewport(cx, cy, geom, nw, nh),
        invertViewport(-cx, cy, geom, nw, nh)
      ];

      // Find the bounding box in source image coordinates
      let minX = nw, minY = nh, maxX = 0, maxY = 0;
      for (const p of pts) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.y < minY) minY = p.y;
        if (p.y > maxY) maxY = p.y;
      }

      // Clamp to image bounds
      minX = Math.max(0, Math.floor(minX));
      minY = Math.max(0, Math.floor(minY));
      maxX = Math.min(nw, Math.ceil(maxX));
      maxY = Math.min(nh, Math.ceil(maxY));

      const cropW = maxX - minX;
      const cropH = maxY - minY;

      if (cropW <= 0 || cropH <= 0) return null;
      if (cropW === nw && cropH === nh && scale === 1) return null;

      // The destination canvas size based on the crop size and current scale
      const destW = Math.round(cropW * scale);
      const destH = Math.round(cropH * scale);

      if (destW <= 0 || destH <= 0) return null;

      _destCanvas.width = destW;
      _destCanvas.height = destH;

      let cleanImg;
      try {
        cleanImg = await getCleanImageCrop(sourceImg.src, minX, minY, cropW, cropH);
      } catch {
        return null;
      }
      if (!cleanImg) return null;
      if (generation !== _generation) {
        if (cleanImg.close) cleanImg.close();
        return null;
      }

      const resampler = getResampler();
      const renderPromise = resampler.resize(cleanImg, _destCanvas, PICA_OPTIONS);
      _activePromise = renderPromise;

      try {
        const resultCanvas = await renderPromise;
        if (_activePromise !== renderPromise || generation !== _generation) return null;

        return {
          canvas: resultCanvas,
          width: destW,
          height: destH,
          cssLeft: minX,
          cssTop: minY,
          cssWidth: cropW,
          cssHeight: cropH
        };
      } catch {
        return null;
      } finally {
        if (cleanImg.close) cleanImg.close();
      }
    },
    cancel,
    dispose
  };
}
