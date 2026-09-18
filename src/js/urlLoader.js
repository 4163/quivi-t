/**
 * urlLoader.js: orchestrator for loading remote galleries via URL.
 *
 * Fetches a remote manifest, matches user URLs to site-specific
 * extractors, loads extractor modules via Blob URL + dynamic import(),
 * and coordinates page fetching and gallery extraction.
 *
 * Download lifecycle:
 * - Queue items track a galleryIndex so the viewport filter can decide
 *   which downloads are visible + buffer.
 * - On navigation jump, cancel_download aborts the in-flight HTTP
 *   stream (chunked reads with AtomicBool on the Rust side).
 * - On directory exit, the queue is cancelled and the active download
 *   is aborted.
 * - Image bridging: isPlaceholderFile() lets Core hold the previous
 *   viewer image until the target download completes.
 */

import { BoundedMap } from './services/cache.js';

const EXTRACTOR_MODULE_CACHE_CAPACITY = 20;
export const MAX_PAGINATION_PAGES = 50;
const DOWNLOAD_QUEUE_RETRY_LIMIT = 1;
const DOWNLOAD_QUEUE_IDLE_POLL_MS = 200;
const RESERVED_DEVICE_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;

let _urlOverlay = null;
let _Core = null;
let _FsUtils = null;
let _manifestCache = null;
let _libraryDirCache = null;
let _activeQueue = null;
let _activeGalleryPath = null;
let _activeGalleryItems = null;
let _coreStateUnsubscribe = null;

// Blob URLs tracked separately for revocation on cache eviction.
const _blobUrls = new Map();
const _extractorCache = new BoundedMap(EXTRACTOR_MODULE_CACHE_CAPACITY, (id) => {
  const url = _blobUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    _blobUrls.delete(id);
  }
});

// -- Path sanitization --

export function sanitizePathSegment(name) {
  if (typeof name !== 'string') return 'unnamed';
  let sanitized = name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '_')
    .trim()
    .replace(/[. ]+$/, '');

  if (!sanitized) return 'unnamed';

  if (RESERVED_DEVICE_NAMES.test(sanitized)) {
    sanitized = `_${sanitized}`;
  }

  if (sanitized.length > 100) {
    sanitized = sanitized.slice(0, 100).replace(/[. ]+$/, '');
    if (!sanitized) return 'unnamed';
  }

  return sanitized;
}

// -- URL validation --

export function isValidUrl(urlString) {
  if (typeof urlString !== 'string') return false;
  const trimmed = urlString.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

// -- Network & Shell proxies --

export async function fetchRemoteText(url) {
  if (!window.__TAURI__) {
    throw new Error('Backend network proxy unavailable in browser environment');
  }
  return await window.__TAURI__.core.invoke('fetch_text', { url });
}

export async function fetchExtractorText(relativePath) {
  if (!window.__TAURI__) {
    throw new Error('Backend network proxy unavailable in browser environment');
  }
  return await window.__TAURI__.core.invoke('fetch_extractor_text', { relativePath });
}

export async function downloadFile(url, destPath) {
  if (!window.__TAURI__) {
    throw new Error('Backend network proxy unavailable in browser environment');
  }
  return await window.__TAURI__.core.invoke('download_to_file', { url, destPath });
}

export async function cancelDownload() {
  if (!window.__TAURI__) return;
  return await window.__TAURI__.core.invoke('cancel_download');
}

export async function getLibraryDir() {
  if (_libraryDirCache) return _libraryDirCache;
  if (!window.__TAURI__) {
    throw new Error('Backend shell proxy unavailable in browser environment');
  }
  const dir = await window.__TAURI__.core.invoke('get_library_dir');
  _libraryDirCache = dir;
  return dir;
}

// -- Path comparison helper --

function _pathsEqual(a, b) {
  if (!a || !b) return false;
  return a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase();
}

// -- Sequential Download Queue --

export class DownloadQueue {
  constructor(items = [], options = {}) {
    this._items = items.map((item, i) => ({
      url: item.url,
      destPath: item.destPath,
      galleryIndex: item.galleryIndex ?? i,
      status: 'pending',
      retryCount: 0
    }));
    this._onItemStatusChanged = options.onItemStatusChanged || null;
    this._cancelled = false;
    this._running = false;
    this._activeDestPath = null;
    this._visibleStart = 0;
    this._visibleEnd = Infinity;
  }

  get isActive() {
    return this._running && !this._cancelled;
  }

  getStatus(destPath) {
    const item = this._items.find((i) => i.destPath === destPath);
    return item ? item.status : null;
  }

  setVisibleRange(start, end) {
    this._visibleStart = start;
    this._visibleEnd = end;
  }

  prioritize(destPath) {
    this._activeDestPath = destPath;
    const target = this._items.find((i) => i.destPath === destPath);
    if (!target) return;

    const gi = target.galleryIndex;

    // Reorder all pending items: target first, then forward (gi+1, gi+2...),
    // then backward (gi-1, gi-2...). Non-pending items keep their position.
    const pending = this._items.filter((i) => i.status === 'pending');
    const nonPending = this._items.filter((i) => i.status !== 'pending');

    const forward = [];
    const backward = [];
    for (const item of pending) {
      if (item.destPath === destPath) continue;
      if (item.galleryIndex >= gi) {
        forward.push(item);
      } else {
        backward.push(item);
      }
    }

    forward.sort((a, b) => a.galleryIndex - b.galleryIndex);
    backward.sort((a, b) => a.galleryIndex - b.galleryIndex);

    const reordered = [];
    if (target.status === 'pending') reordered.push(target);
    reordered.push(...forward, ...backward);

    // Rebuild: non-pending items stay at the front, reordered pending after
    this._items = [...nonPending, ...reordered];

    // Abort the in-flight download if it's no longer the prioritized item
    if (this._currentItem && this._currentItem.destPath !== destPath && this._currentItem.status === 'downloading') {
      cancelDownload().catch(() => {});
    }
  }

  cancel() {
    this._cancelled = true;
    cancelDownload().catch(() => {});
  }

  _isInViewport(item) {
    const gi = item.galleryIndex;
    return gi >= this._visibleStart - 1 && gi < this._visibleEnd + 1;
  }

  _getNextItem() {
    const pending = this._items.filter((i) => i.status === 'pending');
    if (pending.length === 0) return null;

    // 1. Tier 1: Active viewer target (exempt from viewport gating)
    if (this._activeDestPath) {
      const active = pending.find((i) => i.destPath === this._activeDestPath);
      if (active) return active;
    }

    // 2. Tier 2: Pending items within visible file panel slice (+ buffer)
    const visiblePending = pending.filter((i) => this._isInViewport(i));
    if (visiblePending.length > 0) {
      return visiblePending[0];
    }

    // 3. Tier 3: Gallery backlog outside viewport.
    // Continuously fetch remaining items while in gallery without stalling.
    return pending[0];
  }

  async start() {
    if (this._running) return;
    this._running = true;

    try {
      while (!this._cancelled) {
        const nextItem = this._getNextItem();
        if (!nextItem) {
          break;
        }

        this._currentItem = nextItem;
        this._updateStatus(nextItem, 'downloading');

        let success = false;
        while (!success && nextItem.retryCount <= DOWNLOAD_QUEUE_RETRY_LIMIT && !this._cancelled) {
          try {
            await downloadFile(nextItem.url, nextItem.destPath);
            success = true;
          } catch (err) {
            const msg = String(err?.message || err || '');
            if (msg.includes('cancelled') || msg.includes('canceled')) {
              // Abort requested (e.g. jumped to another image) — reset to pending
              nextItem.retryCount = 0;
              break;
            }
            nextItem.retryCount++;
            if (nextItem.retryCount > DOWNLOAD_QUEUE_RETRY_LIMIT) {
              console.warn(`[DownloadQueue] Failed to download ${nextItem.url}:`, err);
            }
          }
        }

        if (this._cancelled && !success) {
          this._updateStatus(nextItem, 'pending');
          break;
        }

        if (success) {
          this._updateStatus(nextItem, 'completed');
        } else if (nextItem.retryCount > DOWNLOAD_QUEUE_RETRY_LIMIT) {
          this._updateStatus(nextItem, 'error');
        } else {
          // Cancelled mid-download — reset to pending
          this._updateStatus(nextItem, 'pending');
        }

        this._currentItem = null;
        await Promise.resolve();
      }
    } finally {
      const wasActive = this._running;
      this._running = false;
      this._currentItem = null;
      if (wasActive && !this._cancelled && _FsUtils && _Core && _activeGalleryPath) {
        try {
          const state = _Core.getState();
          if (state.directory && _pathsEqual(state.directory, _activeGalleryPath)) {
            _FsUtils.refresh();
          }
        } catch {}
      }
    }
  }

  _updateStatus(item, status) {
    item.status = status;
    if (this._onItemStatusChanged) {
      try {
        this._onItemStatusChanged(item.destPath, status, item);
      } catch (e) {
        console.error('[DownloadQueue] onItemStatusChanged error:', e);
      }
    }
  }
}

// -- Manifest and extractor matching --

export async function fetchManifest() {
  if (_manifestCache) return _manifestCache;

  const text = await fetchExtractorText('manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(text);
  } catch (e) {
    throw new Error(`Failed to parse extractor manifest: ${e.message}`);
  }

  if (!manifest || typeof manifest.version !== 'number' || !Array.isArray(manifest.extractors)) {
    throw new Error('Invalid extractor manifest format');
  }

  _manifestCache = manifest;
  return manifest;
}

export function findExtractor(url, manifest) {
  if (!manifest?.extractors) return null;

  for (const entry of manifest.extractors) {
    if (!entry.patterns || !Array.isArray(entry.patterns)) continue;
    for (const pattern of entry.patterns) {
      try {
        if (new RegExp(pattern).test(url)) return entry;
      } catch {
        // Skip malformed patterns.
      }
    }
  }
  return null;
}

// -- Dynamic module loading --

export async function loadExtractorModule(entry) {
  const cached = _extractorCache.get(entry.id);
  if (cached) return cached;

  const source = await fetchExtractorText(entry.source);

  const blob = new Blob([source], { type: 'text/javascript' });
  const blobUrl = URL.createObjectURL(blob);

  let mod;
  try {
    mod = await import(blobUrl);
  } catch (e) {
    URL.revokeObjectURL(blobUrl);
    throw new Error(`Failed to load extractor '${entry.id}': ${e.message}`);
  }

  if (typeof mod.match !== 'function' || typeof mod.extract !== 'function') {
    URL.revokeObjectURL(blobUrl);
    throw new Error(`Extractor '${entry.id}' missing required match() or extract() export`);
  }

  _blobUrls.set(entry.id, blobUrl);
  _extractorCache.set(entry.id, mod);
  return mod;
}

// -- Gallery extraction --

function _validateResult(result) {
  if (!result || typeof result.provider !== 'string') {
    throw new Error("Extractor returned invalid result: missing 'provider' field");
  }
  if (!Array.isArray(result.images)) {
    throw new Error("Extractor returned invalid result: 'images' must be an array");
  }
  return result;
}

export function extractGallery(extractor, html, url, context = {}) {
  const result = extractor.extract(html, url, context);
  if (result && typeof result.then === 'function') {
    return result.then((res) => _validateResult(res));
  }
  return _validateResult(result);
}

// -- Main orchestrator --

export async function loadUrl(urlString) {
  if (!isValidUrl(urlString)) {
    throw new Error('Please enter a valid URL');
  }

  const url = urlString.trim();
  const manifest = await fetchManifest();
  const entry = findExtractor(url, manifest);
  if (!entry) {
    throw new Error('No extractor available for this site');
  }

  const mod = await loadExtractorModule(entry);
  const html = await fetchRemoteText(url);
  const result = await extractGallery(mod, html, url, { fetchText: fetchRemoteText });

  // Pagination: follow nextPageUrl until exhausted or safety cap reached.
  let pages = 0;
  let nextUrl = result.nextPageUrl;
  while (nextUrl && pages < MAX_PAGINATION_PAGES) {
    const pageHtml = await fetchRemoteText(nextUrl);
    const pageResult = await extractGallery(mod, pageHtml, nextUrl, { fetchText: fetchRemoteText });
    result.images.push(...pageResult.images);
    nextUrl = pageResult.nextPageUrl;
    pages++;
  }
  result.nextPageUrl = null;

  if (!result.images || result.images.length === 0) {
    throw new Error('No images found in gallery');
  }

  // Ensure filenames are populated
  result.images.forEach((img, index) => {
    if (!img.filename) {
      let ext = '.jpg';
      try {
        const pathname = new URL(img.url).pathname;
        const match = pathname.match(/\.([a-zA-Z0-9]+)$/);
        if (match) ext = `.${match[1]}`;
      } catch {}
      img.filename = `${String(index + 1).padStart(3, '0')}${ext}`;
    }
  });

  const libraryDir = await getLibraryDir();
  const providerDir = sanitizePathSegment(result.provider);
  const titleDir = sanitizePathSegment(result.title || 'Untitled Gallery');
  const galleryPath = `${libraryDir}\\${providerDir}\\${titleDir}`;

  // Prepopulate all gallery files as 0-byte placeholders on disk upfront
  if (window.__TAURI__) {
    const filenames = result.images.map((img) => img.filename);
    await window.__TAURI__.core.invoke('create_placeholder_files', {
      dir: galleryPath,
      filenames
    });
  }

  const downloadItems = result.images.map((img, i) => ({
    url: img.url,
    destPath: `${galleryPath}\\${img.filename}`,
    galleryIndex: i
  }));

  // Eagerly download image at index 0 first
  if (downloadItems.length > 0) {
    await downloadFile(downloadItems[0].url, downloadItems[0].destPath);
  }

  // Write gallery.json sidecar
  const sidecar = {
    url,
    provider: result.provider,
    title: result.title || '',
    timestamp: new Date().toISOString(),
    images: result.images.map((img) => ({
      filename: img.filename,
      displayName: img.filename.replace(/\.[^.]+$/, ''),
      description: img.displayName || '',
      sourceUrl: img.url
    }))
  };

  if (window.__TAURI__) {
    await window.__TAURI__.core.invoke('write_text_file', {
      path: `${galleryPath}\\gallery.json`,
      content: JSON.stringify(sidecar, null, 2)
    });
  }

  // Background queue for remaining images (index 0 already downloaded eagerly)
  if (downloadItems.length > 1) {
    const remainingItems = downloadItems.slice(1);
    _startGalleryQueue(galleryPath, remainingItems);
  } else {
    _activeGalleryPath = galleryPath;
    _activeGalleryItems = downloadItems;
  }

  return { galleryPath, result };
}

// -- Gallery queue management and auto-resumption --

function _startGalleryQueue(galleryPath, items) {
  if (_activeQueue) {
    _activeQueue.cancel();
    _activeQueue = null;
  }

  _activeGalleryPath = galleryPath;
  _activeGalleryItems = items;

  _activeQueue = new DownloadQueue(items, {
    onItemStatusChanged: (destPath, status) => {
      if (status === 'completed' && _Core && _FsUtils) {
        try {
          const state = _Core.getState();
          if (state.directory && _pathsEqual(state.directory, galleryPath)) {
            // Notify file panel to update row opacity for the completed download
            window.dispatchEvent(new CustomEvent('quivit-download-complete', {
              detail: { destPath }
            }));

            const currentEntry = state.list?.[state.index];
            const targetPath = currentEntry?.path || (currentEntry?.name ? `${galleryPath}\\${currentEntry.name}` : null);
            if (targetPath && _pathsEqual(targetPath, destPath)) {
              _Core.setState({ src: _FsUtils.buildFileSrcSync(destPath) });
            }
          }
        } catch {}
      }
    }
  });

  const state = _Core?.getState?.();
  if (state?.directory && _pathsEqual(state.directory, galleryPath) && state.list?.[state.index]) {
    const currentEntry = state.list[state.index];
    const targetPath = currentEntry?.path || (currentEntry?.name ? `${galleryPath}\\${currentEntry.name}` : null);
    if (targetPath) {
      _activeQueue.prioritize(targetPath);
    }
  }

  _activeQueue.start().catch((err) => {
    console.warn('[UrlLoader] Download queue error:', err);
  });
}

export async function resumeGalleryDownloads(galleryPath, list) {
  if (!galleryPath || !window.__TAURI__) return false;
  if (_activeQueue && _activeQueue.isActive && _pathsEqual(_activeGalleryPath, galleryPath)) {
    return true;
  }

  try {
    const sidecarPath = `${galleryPath}\\gallery.json`;
    const content = await window.__TAURI__.core.invoke('read_text_file', { path: sidecarPath });
    if (!content) return false;

    const data = JSON.parse(content);
    if (!data || !Array.isArray(data.images) || data.images.length === 0) {
      return false;
    }

    const sizeMap = new Map();
    if (Array.isArray(list)) {
      for (const item of list) {
        if (item && item.name) {
          sizeMap.set(item.name.toLowerCase(), item.size ?? 0);
        }
      }
    }

    const pendingItems = [];
    data.images.forEach((img, index) => {
      const destPath = `${galleryPath}\\${img.filename}`;
      const size = sizeMap.get(img.filename.toLowerCase());
      if (size === undefined || size === 0) {
        pendingItems.push({
          url: img.sourceUrl || img.url,
          destPath,
          galleryIndex: index
        });
      }
    });

    if (pendingItems.length === 0) {
      return false;
    }

    _startGalleryQueue(galleryPath, pendingItems);
    return true;
  } catch {
    return false;
  }
}

// -- Placeholder and bridging queries --

export function isPlaceholderFile(filePath) {
  if (!_activeQueue || !_activeQueue.isActive || !_activeGalleryPath) return false;
  if (!filePath) return false;
  const status = _activeQueue.getStatus(filePath);
  return status === 'pending' || status === 'downloading';
}

export function setVisibleRange(start, end) {
  if (_activeQueue && _activeQueue.isActive) {
    _activeQueue.setVisibleRange(start, end);
  }
}

// -- UI integration --

export function openPrompt() {
  if (_urlOverlay) {
    _urlOverlay.show();
  }
}

export function isGalleryDownloading(dirPath) {
  if (!_activeQueue || !_activeQueue.isActive || !_activeGalleryPath) return false;
  if (!dirPath) return false;
  return _pathsEqual(dirPath, _activeGalleryPath);
}

function _teardownActiveQueue() {
  if (_activeQueue) {
    _activeQueue.cancel();
    _activeQueue = null;
  }
  _activeGalleryPath = null;
  _activeGalleryItems = null;
}

export const UrlLoader = {
  init({ Core, FsUtils, urlOverlay }) {
    _Core = Core;
    _FsUtils = FsUtils;
    _urlOverlay = urlOverlay;

    // Register the placeholder check hook so core.js can bridge images
    // without importing urlLoader.js directly.
    if (_Core && typeof _Core.setPlaceholderCheck === 'function') {
      _Core.setPlaceholderCheck((path) => isPlaceholderFile(path));
    }

    if (_Core && typeof _Core.onStateChange === 'function' && !_coreStateUnsubscribe) {
      let _lastSyncDirectory = null;

      _coreStateUnsubscribe = _Core.onStateChange((state) => {
        const dir = state.directory;

        // Directory transition: leaving old gallery, entering new
        if (!_pathsEqual(dir, _lastSyncDirectory)) {
          _lastSyncDirectory = dir;

          if (_activeQueue && _activeQueue.isActive && _activeGalleryPath && !_pathsEqual(dir, _activeGalleryPath)) {
            _teardownActiveQueue();
          }

          if (dir) {
            resumeGalleryDownloads(dir, state.list).catch(() => {});
          }
          return;
        }

        // Same directory: resume if queue was not running but pending items exist
        if ((!_activeQueue || !_activeQueue.isActive) && dir) {
          resumeGalleryDownloads(dir, state.list).catch(() => {});
          return;
        }

        if (!_activeQueue || !_activeQueue.isActive) return;
        if (!_pathsEqual(dir, _activeGalleryPath)) return;
        if (!state.list || state.index < 0 || state.index >= state.list.length) return;

        const currentEntry = state.list[state.index];
        if (!currentEntry) return;

        const targetPath = currentEntry.path || (currentEntry.name ? `${_activeGalleryPath}\\${currentEntry.name}` : null);
        if (targetPath) {
          _activeQueue.prioritize(targetPath);
        }
      });
    }
  },
  openPrompt,
  loadUrl,
  resumeGalleryDownloads,
  isValidUrl,
  isGalleryDownloading,
  isPlaceholderFile,
  setVisibleRange,
  fetchRemoteText,
  fetchExtractorText,
  downloadFile,
  cancelDownload,
  getLibraryDir,
  sanitizePathSegment,
  fetchManifest,
  findExtractor,
  loadExtractorModule,
  extractGallery,
  DownloadQueue
};
