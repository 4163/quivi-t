import { getCleanImage } from '../../shared/blobImage.js';
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

export function createLanczosPipeline(fallbackDestCanvas, fallbackSrcCanvas) {
  const _destCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : fallbackDestCanvas;
  const _srcCanvas = typeof OffscreenCanvas !== 'undefined' ? new OffscreenCanvas(1, 1) : fallbackSrcCanvas;
  let _activePromise = null;

  function cancel() {
    _activePromise = null;
  }

  function dispose() {
    cancel();
  }

  return {
    type: 'lanczos',
    render: async (sourceImg, geom) => {
      const { scale, tx, ty, rotation, flipX, flipY, viewport } = geom;
      cancel();

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
        cleanImg = await getCleanImage(sourceImg.src);
      } catch {
        return null;
      }

      // Draw the crop from the clean image to a temporary source canvas
      // Pica works best when resizing a full canvas to a full canvas
      _srcCanvas.width = cropW;
      _srcCanvas.height = cropH;
      const sctx = _srcCanvas.getContext('2d');
      sctx.drawImage(cleanImg, minX, minY, cropW, cropH, 0, 0, cropW, cropH);

      const resampler = getResampler();
      const renderPromise = resampler.resize(_srcCanvas, _destCanvas, PICA_OPTIONS);
      _activePromise = renderPromise;

      try {
        const resultCanvas = await renderPromise;
        if (_activePromise !== renderPromise) return null;
        
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
      }
    },
    cancel,
    dispose
  };
}
