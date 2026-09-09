// Blob cache for same-origin texture uploads. Custom protocol images
// (quivit://, asset://) are cross-origin and taint canvas/WebGL contexts
// without this workaround.
import { BoundedMap } from '../services/cache.js';

const TEXTURE_CACHE_CAPACITY = 6;
const _textureCache = new BoundedMap(TEXTURE_CACHE_CAPACITY);

let _pendingPromise = null;
let _pendingSrc = null;

function _evictEntry(entry) {
  if (entry.blobUrl) URL.revokeObjectURL(entry.blobUrl);
  if (entry.cleanImg && entry.cleanImg.close) entry.cleanImg.close();
}

const _origSet = _textureCache.set.bind(_textureCache);
_textureCache.set = function (key, value) {
  if (this.size >= this.maxSize && !this.has(key)) {
    const oldestKey = this.keys().next().value;
    const evicted = this.get(oldestKey);
    if (evicted) _evictEntry(evicted);
  }
  return _origSet(key, value);
};

export async function getCleanImage(src) {
  const cached = _textureCache.get(src);
  if (cached) return cached.cleanImg;
  if (_pendingSrc === src && _pendingPromise) return _pendingPromise;

  _pendingSrc = src;
  _pendingPromise = (async () => {
    try {
      const resp = await fetch(src);
      const blob = await resp.blob();

      const blobUrl = URL.createObjectURL(blob);
      const cleanImg = await createImageBitmap(blob);

      if (_pendingSrc !== src) {
        URL.revokeObjectURL(blobUrl);
        if (cleanImg && cleanImg.close) cleanImg.close();
        return cleanImg;
      }

      _textureCache.set(src, { blobUrl, cleanImg });
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
