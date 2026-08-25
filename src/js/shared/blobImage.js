// Blob cache for same-origin texture uploads. Custom protocol images
// (quivit://, asset://) are cross-origin and taint canvas/WebGL contexts
// without this workaround.
let _cachedSrc = null;
let _cachedBlobUrl = null;
let _cachedCleanImg = null;

export function evictBlobCache() {
  if (_cachedBlobUrl) URL.revokeObjectURL(_cachedBlobUrl);
  _cachedSrc = null;
  _cachedBlobUrl = null;
  _cachedCleanImg = null;
}

export async function getCleanImage(src) {
  if (_cachedSrc === src && _cachedCleanImg) return _cachedCleanImg;
  evictBlobCache();
  
  const resp = await fetch(src);
  const blob = await resp.blob();
  
  _cachedBlobUrl = URL.createObjectURL(blob);
  _cachedCleanImg = new Image();
  _cachedCleanImg.src = _cachedBlobUrl;
  await _cachedCleanImg.decode();
  
  _cachedSrc = src;
  return _cachedCleanImg;
}
