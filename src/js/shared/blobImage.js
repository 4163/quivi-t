// Blob cache for same-origin texture uploads. Custom protocol images
// (quivit://, asset://) are cross-origin and taint canvas/WebGL contexts
// without this workaround.
let _cachedSrc = null;
let _cachedBlobUrl = null;
let _cachedCleanImg = null;

export function evictBlobCache() {
  if (_cachedBlobUrl) URL.revokeObjectURL(_cachedBlobUrl);
  if (_cachedCleanImg && _cachedCleanImg.close) _cachedCleanImg.close();
  _cachedSrc = null;
  _cachedBlobUrl = null;
  _cachedCleanImg = null;
}

let _pendingPromise = null;
let _pendingSrc = null;

export async function getCleanImage(src) {
  if (_cachedSrc === src && _cachedCleanImg) return _cachedCleanImg;
  if (_pendingSrc === src && _pendingPromise) return _pendingPromise;
  
  evictBlobCache();
  
  _pendingSrc = src;
  _pendingPromise = (async () => {
    try {
      const resp = await fetch(src);
      const blob = await resp.blob();
      
      const blobUrl = URL.createObjectURL(blob);
      const cleanImg = await createImageBitmap(blob);
      
      _cachedBlobUrl = blobUrl;
      _cachedCleanImg = cleanImg;
      _cachedSrc = src;
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
