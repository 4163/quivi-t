// Blob cache for same-origin texture uploads. Custom protocol images
// (quivit://, asset://) are cross-origin and taint canvas/WebGL contexts
// without this workaround.
import { BoundedMap } from '../services/cache.js';

export const TEXTURE_CACHE_CAPACITY = 1;

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
