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

let _cachedLiveSrc = null;
let _cachedLiveBlobUrl = null;
let _cachedLiveImg = null;

export function evictLiveBlobCache() {
  if (_cachedLiveBlobUrl) URL.revokeObjectURL(_cachedLiveBlobUrl);
  if (_cachedLiveImg) {
    _cachedLiveImg.src = '';
    _cachedLiveImg = null;
  }
  _cachedLiveSrc = null;
  _cachedLiveBlobUrl = null;
}

let _pendingLivePromise = null;
let _pendingLiveSrc = null;

export async function getLiveImage(src) {
  if (_cachedLiveSrc === src && _cachedLiveImg) return _cachedLiveImg;
  if (_pendingLiveSrc === src && _pendingLivePromise) return _pendingLivePromise;
  
  evictLiveBlobCache();
  
  _pendingLiveSrc = src;
  _pendingLivePromise = (async () => {
    try {
      const resp = await fetch(src);
      const blob = await resp.blob();
      
      const blobUrl = URL.createObjectURL(blob);
      const liveImg = new Image();
      liveImg.src = blobUrl;
      await new Promise((resolve, reject) => {
        liveImg.onload = resolve;
        liveImg.onerror = reject;
      });
      
      _cachedLiveBlobUrl = blobUrl;
      _cachedLiveImg = liveImg;
      _cachedLiveSrc = src;
      return liveImg;
    } finally {
      if (_pendingLiveSrc === src) {
        _pendingLiveSrc = null;
        _pendingLivePromise = null;
      }
    }
  })();
  
  return _pendingLivePromise;
}
