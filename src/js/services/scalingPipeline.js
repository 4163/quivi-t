// Initialize pica. Now that we fetch images as blobs to ensure they
// are same-origin, we can safely allow Web Workers and createImageBitmap
// without triggering DataCloneErrors. This moves the heavy WASM math
// completely off the main thread, keeping the UI buttery smooth.
const resampler = window.pica();

// Per-src blob cache. Fetching image bytes and creating a same-origin
// blob URL is required to avoid canvas tainting, but the fetch is
// expensive. Cache the decoded Image so repeated renders at different
// zoom levels skip the network round-trip entirely.
let _cachedSrc = null;
let _cachedBlobUrl = null;
let _cachedCleanImg = null;

const _destCanvas = document.createElement('canvas');
const _srcCanvas = document.createElement('canvas');

function _evictBlobCache() {
  if (_cachedBlobUrl) URL.revokeObjectURL(_cachedBlobUrl);
  _cachedSrc = null;
  _cachedBlobUrl = null;
  _cachedCleanImg = null;
}

async function _getCleanImage(src) {
  if (_cachedSrc === src && _cachedCleanImg) return _cachedCleanImg;
  _evictBlobCache();
  const resp = await fetch(src);
  const blob = await resp.blob();
  _cachedBlobUrl = URL.createObjectURL(blob);
  _cachedCleanImg = new Image();
  _cachedCleanImg.src = _cachedBlobUrl;
  await _cachedCleanImg.decode();
  _cachedSrc = src;
  return _cachedCleanImg;
}

const PICA_OPTIONS = {
  unsharpAmount: 80,
  unsharpRadius: 0.6,
  unsharpThreshold: 2
};

export function createScalingPipeline(mode) {
  let _activePromise = null;

  function cancel() {
    _activePromise = null;
  }

  function dispose() {
    cancel();
  }

  if (mode === 'none' || mode === 'bilinear') {
    return { render: () => Promise.resolve(null), cancel, dispose };
  }

  return {
    render: async (sourceImg, geom) => {
      const { scale, tx, ty, rotation, flipX, flipY, viewport } = geom;
      cancel();

      const nw = sourceImg.naturalWidth;
      const nh = sourceImg.naturalHeight;

      if (nw <= 0 || nh <= 0) return null;

      // Un-project viewport corners to imgWrapper local coordinates
      const cx = viewport.clientWidth / 2;
      const cy = viewport.clientHeight / 2;

      // Helper to map screen coordinate (px, py) to unscaled image coordinate
      const rad = -(rotation || 0) * Math.PI / 180;
      const cosR = Math.cos(rad);
      const sinR = Math.sin(rad);

      function screenToImg(px, py) {
        // 1. Untranslate
        const rx = px - tx;
        const ry = py - ty;
        // 2. Unrotate
        const sx = rx * cosR - ry * sinR;
        const sy = rx * sinR + ry * cosR;
        // 3. Unscale and unflip
        const lx = (sx / scale) * (flipX || 1);
        const ly = (sy / scale) * (flipY || 1);
        // 4. Translate to top-left origin
        return { x: lx + nw / 2, y: ly + nh / 2 };
      }

      // Map the 4 corners of the viewport
      const pts = [
        screenToImg(-cx, -cy),
        screenToImg(cx, -cy),
        screenToImg(cx, cy),
        screenToImg(-cx, cy)
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
        cleanImg = await _getCleanImage(sourceImg.src);
      } catch {
        return null;
      }

      // Draw the crop from the clean image to a temporary source canvas
      // Pica works best when resizing a full canvas to a full canvas
      _srcCanvas.width = cropW;
      _srcCanvas.height = cropH;
      const sctx = _srcCanvas.getContext('2d');
      sctx.drawImage(cleanImg, minX, minY, cropW, cropH, 0, 0, cropW, cropH);

      const renderPromise = resampler.resize(_srcCanvas, _destCanvas, PICA_OPTIONS);
      _activePromise = renderPromise;

      try {
        const resultCanvas = await renderPromise;
        if (_activePromise !== renderPromise) return null;
        
        // DEBUG: Uncomment the following three lines to visualize the Lanczos 
        // overlay bounding box. This is useful for verifying that viewport 
        // partial rendering is accurately cropping and positioning the canvas.
        const ctx = resultCanvas.getContext('2d');
        // ctx.fillStyle = 'rgba(255, 0, 0, 0.5)';
        // ctx.fillRect(0, 0, destW, destH);
        
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
