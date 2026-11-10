// Blob cache for same-origin texture uploads. Custom protocol images
// (quivit://, asset://) are cross-origin and taint canvas/WebGL contexts
// without this workaround.
import { BoundedMap } from '../services/cache.js';

export const TEXTURE_CACHE_CAPACITY = 4;

function _evictEntry(entry) {
  if (!entry) return;
  if (entry.cleanImg && entry.cleanImg.close) entry.cleanImg.close();
}

const _textureCache = new BoundedMap(TEXTURE_CACHE_CAPACITY, (_key, entry) => _evictEntry(entry));

let _pendingPromise = null;
let _pendingSrc = null;

export async function getCleanImage(src) {
  const cached = _textureCache.get(src);
  if (cached) return cached.cleanImg;
  if (_pendingSrc === src && _pendingPromise) return _pendingPromise;

  _pendingSrc = src;
  _pendingPromise = (async () => {
    try {
      const resp = await fetch(src);
      const blob = await resp.blob();
      const cleanImg = await createImageBitmap(blob);

      if (_pendingSrc !== src) {
        if (cleanImg && cleanImg.close) cleanImg.close();
        return null;
      }

      _textureCache.set(src, { cleanImg });
      return cleanImg;
    } finally {
      if (_pendingSrc === src) {
        _pendingSrc = null;
        _pendingPromise = null;
      }
    }
  })();

  return _pendingPromise;
}

export async function getCleanImageCrop(src, sx, sy, sw, sh) {
  const resp = await fetch(src);
  const blob = await resp.blob();
  return createImageBitmap(blob, sx, sy, sw, sh);
}

let _sharedCoverCanvas = null;

export function generateCoverThumbnail(src, usePng = false) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => {
      try {
        const MAX_H = 300;
        const scale = Math.min(1, MAX_H / img.naturalHeight);
        const w = Math.round(img.naturalWidth * scale);
        const h = Math.round(img.naturalHeight * scale);
        if (!_sharedCoverCanvas && typeof document !== 'undefined') {
          _sharedCoverCanvas = document.createElement('canvas');
        }
        const canvas = _sharedCoverCanvas;
        if (!canvas) {
          reject(new Error('Canvas support unavailable'));
          return;
        }
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(usePng ? canvas.toDataURL('image/png') : canvas.toDataURL('image/jpeg', 0.8));
      } catch (err) {
        reject(err);
      }
    };
    img.onerror = reject;
    img.src = src;
  });
}
