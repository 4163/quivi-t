import { BoundedMap } from './cache.js';
import { Core } from '../core.js';

let _activeViewerKey = null;
let _activeViewerBlob = null;
let _archiveBlobBytes = 0;
const _archiveBlobSizes = new Map();

export const ARCHIVE_BLOB_CACHE_CAPACITY = 8;
export const ARCHIVE_BLOB_CACHE_MAX_BYTES = 24 * 1024 * 1024;
export const ARCHIVE_BLOB_CACHE_ENTRY_MAX_BYTES = 4 * 1024 * 1024;

function _forgetArchiveBlobSize(key) {
  const size = _archiveBlobSizes.get(key);
  if (!size) return;
  _archiveBlobBytes = Math.max(0, _archiveBlobBytes - size);
  _archiveBlobSizes.delete(key);
}

function _rememberArchiveBlobSize(key, size) {
  _forgetArchiveBlobSize(key);
  if (!size) return;
  _archiveBlobSizes.set(key, size);
  _archiveBlobBytes += size;
}

function _trimArchiveBlobCache() {
  while (_archiveBlobSizes.size > ARCHIVE_BLOB_CACHE_CAPACITY || _archiveBlobBytes > ARCHIVE_BLOB_CACHE_MAX_BYTES) {
    let evicted = false;
    for (const key of _archiveBlobCache.keys()) {
      if (_archiveBlobSizes.has(key)) {
        _archiveBlobCache.delete(key);
        evicted = true;
        break;
      }
    }
    if (!evicted) break;
  }
}

function _revokeBlobEntry(key, value) {
  if (typeof value === 'string' && value.startsWith('blob:')) {
    _forgetArchiveBlobSize(key);
    const activeSrc = Core?.getState()?.src;
    if (activeSrc && (key === activeSrc || value === activeSrc)) {
      if (_activeViewerBlob && _activeViewerBlob !== value) {
        URL.revokeObjectURL(_activeViewerBlob);
      }
      _activeViewerKey = key;
      _activeViewerBlob = value;
      return;
    }
    URL.revokeObjectURL(value);
  }
}

const _archiveBlobCache = new BoundedMap(ARCHIVE_BLOB_CACHE_CAPACITY, _revokeBlobEntry);

let _archiveBlobGeneration = 0;
let _archiveBlobAbortController = null;
const _archiveBlobPromises = new Map();

export function ensureArchiveBlob(src) {
  if (!src || !src.includes('/archive/')) return Promise.resolve(null);
  const cached = _archiveBlobCache.get(src);
  if (typeof cached === 'string' && cached.startsWith('blob:')) return Promise.resolve(cached);
  if (_archiveBlobPromises.has(src)) return _archiveBlobPromises.get(src);

  const gen = _archiveBlobGeneration;
  let signal;
  if (typeof AbortController !== 'undefined') {
    if (!_archiveBlobAbortController) _archiveBlobAbortController = new AbortController();
    signal = _archiveBlobAbortController.signal;
  }

  const p = fetch(src, signal ? { signal } : {}).then(r => r.blob()).then(blob => {
    if (gen !== _archiveBlobGeneration) {
      _archiveBlobPromises.delete(src);
      return null;
    }
    if (blob.size > ARCHIVE_BLOB_CACHE_ENTRY_MAX_BYTES) {
      _archiveBlobPromises.delete(src);
      return null;
    }
    const existing = _archiveBlobCache.get(src);
    if (typeof existing === 'string' && existing.startsWith('blob:')) {
      _archiveBlobPromises.delete(src);
      return existing;
    }
    if (_archiveBlobCache.has(src)) {
      _archiveBlobPromises.delete(src);
      return null;
    }
    const blobUrl = URL.createObjectURL(blob);
    if (gen !== _archiveBlobGeneration) {
      URL.revokeObjectURL(blobUrl);
      _archiveBlobPromises.delete(src);
      return null;
    }
    _archiveBlobCache.set(src, blobUrl);
    _rememberArchiveBlobSize(src, blob.size);
    _trimArchiveBlobCache();
    _archiveBlobPromises.delete(src);
    return blobUrl;
  }).catch((err) => {
    if (gen !== _archiveBlobGeneration || err?.name === 'AbortError') {
      _archiveBlobPromises.delete(src);
      return null;
    }
    _archiveBlobPromises.delete(src);
    return null;
  });
  _archiveBlobPromises.set(src, p);
  return p;
}

export function getCachedArchiveBlob(src) {
  if (!src) return null;
  const cached = _archiveBlobCache.get(src);
  if (typeof cached === 'string' && cached.startsWith('blob:')) {
    return cached;
  }
  return null;
}

export function hasCachedArchiveBlob(src) {
  if (!src) return false;
  const cached = _archiveBlobCache.get(src);
  return typeof cached === 'string' && cached.startsWith('blob:');
}

export function clearArchiveBlobCache() {
  _archiveBlobGeneration++;
  if (_archiveBlobAbortController) {
    _archiveBlobAbortController.abort();
    _archiveBlobAbortController = null;
  }
  _archiveBlobPromises.clear();
  _archiveBlobSizes.clear();
  _archiveBlobBytes = 0;
  for (const [key, val] of _archiveBlobCache.entries()) {
    if (typeof val === 'string' && val.startsWith('blob:')) {
      const activeSrc = Core?.getState()?.src;
      if (activeSrc && (key === activeSrc || val === activeSrc)) {
        continue;
      }
      URL.revokeObjectURL(val);
    }
  }
  _archiveBlobCache.clear();
  if (_activeViewerBlob) {
    const activeSrc = Core?.getState()?.src;
    if (!activeSrc || (_activeViewerKey !== activeSrc && _activeViewerBlob !== activeSrc)) {
      URL.revokeObjectURL(_activeViewerBlob);
      _activeViewerKey = null;
      _activeViewerBlob = null;
    }
  }
}

let _lastArchivePath = null;
let _lastMode = null;

if (typeof Core !== 'undefined' && Core.onStateChange) {
  Core.onStateChange((state) => {
    if (_activeViewerBlob && state.src !== _activeViewerKey && state.src !== _activeViewerBlob) {
      let stillInCache = false;
      for (const val of _archiveBlobCache.values()) {
        if (val === _activeViewerBlob) {
          stillInCache = true;
          break;
        }
      }
      if (!stillInCache) {
        URL.revokeObjectURL(_activeViewerBlob);
        _activeViewerBlob = null;
        _activeViewerKey = null;
      }
    }

    const archiveChanged = state.mode !== _lastMode || state.archivePath !== _lastArchivePath;
    _lastMode = state.mode;
    _lastArchivePath = state.archivePath;
    if (archiveChanged) {
      clearArchiveBlobCache();
    }
  });
}

if (typeof window !== 'undefined') {
  window.addEventListener('quivit-refresh-start', () => {
    clearArchiveBlobCache();
  });
}
