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
export const DOWNLOAD_CONCURRENCY = 2;
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

// -- URL validation and normalization --

export function normalizeUrl(urlString) {
  if (typeof urlString !== 'string') return '';
  let trimmed = urlString.trim();
  if (!trimmed) return '';

  if (/^http:\/\//i.test(trimmed)) {
    trimmed = trimmed.replace(/^http:\/\//i, 'https://');
  } else if (!/^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(trimmed)) {
    trimmed = `https://${trimmed}`;
  }

  return trimmed;
}

export function isValidUrl(urlString) {
  const normalized = normalizeUrl(urlString);
  if (!normalized) return false;
  try {
    const parsed = new URL(normalized);
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
    this._items = items.map((item, i) => {
      const destPath = item.destPath || '';
      const filename = item.filename || (destPath ? destPath.replace(/\\/g, '/').split('/').pop() : '');
      return {
        url: item.url,
        destPath,
        filename,
        galleryIndex: item.galleryIndex ?? i,
        status: item.status || 'pending',
        retryCount: 0
      };
    });
    this._onItemStatusChanged = options.onItemStatusChanged || null;
    this._getActivePath = typeof options.getActivePath === 'function' ? options.getActivePath : null;
    this._cancelled = false;
    this._running = false;
    this._activeDestPath = null;
    this._visibleStart = options.visibleStart ?? 0;
    this._visibleEnd = options.visibleEnd ?? 0;
    this._inFlightItems = new Set();
    this._activeWorkers = 0;
  }

  get isActive() {
    return !this._cancelled;
  }

  get isRunning() {
    return this._running && !this._cancelled;
  }

  _findItem(targetPathOrName) {
    if (!targetPathOrName) return null;
    const cleanTarget = String(targetPathOrName).replace(/\\/g, '/').toLowerCase();
    const targetName = cleanTarget.split('/').pop();
    return this._items.find((item) => {
      if (!item.destPath) return false;
      const cleanItem = item.destPath.replace(/\\/g, '/').toLowerCase();
      if (cleanItem === cleanTarget) return true;
      if (item.filename && item.filename.toLowerCase() === targetName) return true;
      if (cleanTarget.endsWith('/' + item.filename.toLowerCase()) || cleanItem.endsWith('/' + targetName)) return true;
      return false;
    }) || null;
  }

  getStatus(destPath) {
    const item = this._findItem(destPath);
    if (!item) return null;
    if (this._inFlightItems.has(item)) return 'downloading';
    return item.status;
  }

  setVisibleRange(start, end) {
    this._visibleStart = start;
    this._visibleEnd = end;
    if (!this._cancelled) {
      this._spawnWorkers();
    }
  }

  prioritize(destPath) {
    const target = this._findItem(destPath);
    if (!target) return;
    this._activeDestPath = target.destPath;

    if (target.status === 'error') {
      target.status = 'pending';
      target.retryCount = 0;
    }

    const gi = target.galleryIndex;

    // Reorder all pending items: target first, then forward ascending (gi+1..N),
    // then wrap back descending (gi-1..0). Non-pending items keep their position.
    const pending = this._items.filter((i) => i.status === 'pending');
    const nonPending = this._items.filter((i) => i.status !== 'pending');

    const forward = [];
    const backward = [];
    for (const item of pending) {
      if (item === target) continue;
      if (item.galleryIndex >= gi) {
        forward.push(item);
      } else {
        backward.push(item);
      }
    }

    forward.sort((a, b) => a.galleryIndex - b.galleryIndex);
    backward.sort((a, b) => b.galleryIndex - a.galleryIndex);

    const reordered = [];
    if (target.status === 'pending') reordered.push(target);
    reordered.push(...forward, ...backward);

    // Rebuild: non-pending items stay at the front, reordered pending after
    this._items = [...nonPending, ...reordered];

    // If target is pending and not already downloading, cancel in-flight downloads to yield worker slot
    if (target.status === 'pending' && !this._inFlightItems.has(target) && this._inFlightItems.size > 0) {
      cancelDownload().catch(() => {});
    }

    // Wake up workers if target is pending
    if (target.status === 'pending' && !this._cancelled) {
      this._spawnWorkers();
    }
  }

  cancel() {
    this._cancelled = true;
    cancelDownload().catch(() => {});
    for (const item of this._inFlightItems) {
      this._updateStatus(item, 'pending');
    }
    this._inFlightItems.clear();
  }

  _isInViewport(item) {
    const gi = item.galleryIndex;
    return gi >= this._visibleStart && gi < this._visibleEnd;
  }

  _getNextItem() {
    if (this._getActivePath) {
      try {
        const activePath = this._getActivePath();
        if (activePath) {
          const target = this._findItem(activePath);
          if (target) {
            this._activeDestPath = target.destPath;
          }
        }
      } catch {}
    }

    const pending = this._items.filter((i) => i.status === 'pending' && !this._inFlightItems.has(i));
    if (pending.length === 0) return null;

    // 1. Top priority: Active viewer target (exempt from viewport gating)
    let pivotGi = 0;
    if (this._activeDestPath) {
      const target = this._findItem(this._activeDestPath);
      if (target) {
        if (target.status === 'pending' && !this._inFlightItems.has(target)) {
          return target;
        }
        pivotGi = target.galleryIndex;
      }
    } else if (isFinite(this._visibleStart)) {
      pivotGi = Math.max(0, this._visibleStart);
    }

    // 2. Candidate items: ONLY items in the visible file panel window (+ buffer)
    const visiblePending = pending.filter((i) => this._isInViewport(i));
    if (visiblePending.length === 0) {
      return null;
    }

    // 3. Within visible window: forward first from pivotGi, then wrap backward
    const forwardVisible = visiblePending.filter((i) => i.galleryIndex >= pivotGi);
    const backwardVisible = visiblePending.filter((i) => i.galleryIndex < pivotGi);

    if (forwardVisible.length > 0) {
      forwardVisible.sort((a, b) => a.galleryIndex - b.galleryIndex);
      return forwardVisible[0];
    }

    if (backwardVisible.length > 0) {
      backwardVisible.sort((a, b) => b.galleryIndex - a.galleryIndex);
      return backwardVisible[0];
    }

    return null;
  }

  async start() {
    if (this._cancelled) return;
    this._spawnWorkers();
  }

  _spawnWorkers() {
    if (this._cancelled) return;
    while (this._activeWorkers < DOWNLOAD_CONCURRENCY) {
      const next = this._getNextItem();
      if (!next) break;
      this._inFlightItems.add(next);
      this._activeWorkers++;
      this._runWorker(next).catch((err) => {
        console.warn('[DownloadQueue] Worker error:', err);
      });
    }
    this._running = this._activeWorkers > 0;
  }

  async _runWorker(initialItem) {
    let item = initialItem;
    try {
      while (!this._cancelled && item) {
        this._updateStatus(item, 'downloading');

        let success = false;
        while (!success && item.retryCount <= DOWNLOAD_QUEUE_RETRY_LIMIT && !this._cancelled) {
          try {
            await downloadFile(item.url, item.destPath);
            success = true;
          } catch (err) {
            const msg = String(err?.message || err || '');
            if (msg.includes('cancelled') || msg.includes('canceled')) {
              item.retryCount = 0;
              break;
            }
            item.retryCount++;
            if (item.retryCount > DOWNLOAD_QUEUE_RETRY_LIMIT) {
              console.warn(`[DownloadQueue] Failed to download ${item.url}:`, err);
            }
          }
        }

        this._inFlightItems.delete(item);

        if (this._cancelled && !success) {
          this._updateStatus(item, 'pending');
          break;
        }

        if (success) {
          this._updateStatus(item, 'completed');
        } else if (item.retryCount > DOWNLOAD_QUEUE_RETRY_LIMIT) {
          this._updateStatus(item, 'error');
        } else {
          this._updateStatus(item, 'pending');
        }

        item = null;
        if (!this._cancelled) {
          const next = this._getNextItem();
          if (next) {
            this._inFlightItems.add(next);
            item = next;
          }
        }
      }
    } finally {
      if (item) {
        this._inFlightItems.delete(item);
        if (item.status === 'downloading') {
          this._updateStatus(item, 'pending');
        }
      }
      this._activeWorkers--;
      this._running = this._activeWorkers > 0;

      if (this._activeWorkers === 0) {
        const allDone = this._items.every((i) => i.status === 'completed' || i.status === 'error');
        if (!this._cancelled && allDone && _FsUtils && _Core && _activeGalleryPath) {
          try {
            const state = _Core.getState();
            if (state.directory && _pathsEqual(state.directory, _activeGalleryPath)) {
              _FsUtils.refresh();
            }
          } catch {}
        }
      } else {
        this._spawnWorkers();
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

// -- Gallery Matching & Standalone Raw Cleanup --

export async function findMatchingGalleryImage(providerPath, directUrl, hash) {
  if (!window.__TAURI__) return null;
  try {
    const dirResult = await window.__TAURI__.core.invoke('read_directory', {
      path: providerPath,
      showHidden: false
    });
    if (!dirResult?.files) return null;

    const normalizedDirectUrl = normalizeUrl(directUrl);
    const targetHash = hash ? hash.toLowerCase() : null;

    for (const entry of dirResult.files) {
      if (!entry.is_dir) continue;
      const sidecarPath = `${entry.path}\\gallery.json`;
      try {
        const sidecarText = await window.__TAURI__.core.invoke('read_text_file', { path: sidecarPath });
        const sidecar = JSON.parse(sidecarText);
        if (!Array.isArray(sidecar.images)) continue;

        for (const img of sidecar.images) {
          const imgSource = normalizeUrl(img.sourceUrl || '');
          const imgFilename = img.filename || '';

          let isMatch = false;
          if (imgSource && normalizedDirectUrl && imgSource.toLowerCase() === normalizedDirectUrl.toLowerCase()) {
            isMatch = true;
          } else if (targetHash) {
            const sourceHashMatch = imgSource.match(/(?:i\.)?imgur\.com\/(?:a\/|gallery\/)?([a-zA-Z0-9]+)(?:\.[a-zA-Z0-9]+)?/i);
            const sourceHash = sourceHashMatch ? sourceHashMatch[1].toLowerCase() : null;
            if (sourceHash && sourceHash === targetHash) {
              isMatch = true;
            } else if (imgFilename.toLowerCase().includes(targetHash)) {
              isMatch = true;
            }
          }

          if (isMatch) {
            return {
              galleryPath: entry.path,
              targetName: img.filename,
              image: img
            };
          }
        }
      } catch {
        // Not a gallery directory or invalid JSON; continue scanning.
      }
    }
  } catch {
    // Provider directory may not exist yet or failed to read.
  }
  return null;
}

export async function cleanupMatchingRawFiles(providerPath, images) {
  if (!window.__TAURI__ || !Array.isArray(images) || images.length === 0) return;
  try {
    const dirResult = await window.__TAURI__.core.invoke('read_directory', {
      path: providerPath,
      showHidden: false
    });
    if (!dirResult?.files) return;

    const matchHashes = new Set();
    const matchFilenames = new Set();

    for (const img of images) {
      if (img.filename) matchFilenames.add(img.filename.toLowerCase());
      const src = img.sourceUrl || img.url || '';
      if (src) {
        const hashMatch = src.match(/(?:i\.)?imgur\.com\/(?:a\/|gallery\/)?([a-zA-Z0-9]+)(?:\.[a-zA-Z0-9]+)?/i);
        if (hashMatch) {
          matchHashes.add(hashMatch[1].toLowerCase());
        }
      }
    }

    for (const entry of dirResult.files) {
      if (entry.is_dir) continue;
      const lowerName = entry.name.toLowerCase();
      const dotIndex = lowerName.lastIndexOf('.');
      const fileBase = dotIndex > 0 ? lowerName.slice(0, dotIndex) : lowerName;

      if (matchHashes.has(fileBase) || matchFilenames.has(lowerName)) {
        try {
          await window.__TAURI__.core.invoke('remove_file', { path: entry.path });
        } catch {
          // Ignore individual file deletion errors.
        }
      }
    }
  } catch {
    // Provider directory does not exist or read failed.
  }
}

// -- Main orchestrator --

export async function loadUrl(urlString) {
  const url = normalizeUrl(urlString);
  if (!isValidUrl(url)) {
    throw new Error('Please enter a valid URL');
  }

  const manifest = await fetchManifest();
  const entry = findExtractor(url, manifest);
  if (!entry) {
    throw new Error('No extractor available for this site');
  }

  const mod = await loadExtractorModule(entry);
  const providerName = entry.name || 'Unknown';
  const providerDir = sanitizePathSegment(providerName);
  const libraryDir = await getLibraryDir();
  const providerPath = `${libraryDir}\\${providerDir}`;

  // Direct image handling (e.g. https://i.imgur.com/04XS16K.png)
  const isDirect = typeof mod.isDirectUrl === 'function' && mod.isDirectUrl(url);
  if (isDirect) {
    const directInfo = typeof mod.parseDirectUrl === 'function' ? mod.parseDirectUrl(url) : null;
    const hash = directInfo?.hash || null;
    const rawFilename = directInfo?.filename || (url.split('/').pop() || 'image.png');
    const downloadUrl = directInfo?.url || url;

    // 1. If direct URL has a matching gallery, jump directly to that file
    const match = await findMatchingGalleryImage(providerPath, url, hash);
    if (match) {
      return {
        galleryPath: match.galleryPath,
        targetName: match.targetName,
        isDirectMatch: true
      };
    }

    // 2. Otherwise, dump it raw under the provider root (e.g. Imgur/04XS16K.png)
    const destPath = `${providerPath}\\${rawFilename}`;
    if (window.__TAURI__) {
      await downloadFile(downloadUrl, destPath);
    }

    return {
      galleryPath: providerPath,
      targetName: rawFilename,
      isRaw: true
    };
  }

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

  // Prune any standalone raw files under the provider root that are part of this gallery
  await cleanupMatchingRawFiles(providerPath, result.images);

  // Background queue for remaining images (index 0 already downloaded eagerly)
  if (downloadItems.length > 1) {
    downloadItems[0].status = 'completed';
    _startGalleryQueue(galleryPath, downloadItems);
  } else {
    _activeGalleryPath = galleryPath;
    _activeGalleryItems = downloadItems;
  }

  return { galleryPath, result, targetName: result.images[0]?.filename || null };
}

// -- Gallery queue management and auto-resumption --

function _startGalleryQueue(galleryPath, items) {
  if (_activeQueue) {
    _activeQueue.cancel();
    _activeQueue = null;
  }

  _activeGalleryPath = galleryPath;
  _activeGalleryItems = items;

  let initialVisibleStart = 0;
  let initialVisibleEnd = 0;
  if (_getFileListViewportRange) {
    try {
      const range = _getFileListViewportRange();
      if (range && typeof range.start === 'number' && typeof range.end === 'number' && range.end > 0) {
        initialVisibleStart = range.start;
        initialVisibleEnd = range.end;
      }
    } catch {}
  }

  _activeQueue = new DownloadQueue(items, {
    visibleStart: initialVisibleStart,
    visibleEnd: initialVisibleEnd,
    getActivePath: () => {
      const s = _Core?.getState?.();
      if (!s?.list || s.index < 0 || s.index >= s.list.length) return null;
      const entry = s.list[s.index];
      return entry?.path || (entry?.name ? `${galleryPath}\\${entry.name}` : null);
    },
    onItemStatusChanged: (destPath, status) => {
      if (status === 'completed' && _Core && _FsUtils) {
        try {
          const state = _Core.getState();
          if (state.directory && _pathsEqual(state.directory, galleryPath)) {
            // Notify file panel to update row opacity for the completed download
            window.dispatchEvent(new CustomEvent('quivit-download-complete', {
              detail: { destPath, size: 1 }
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

    const allItems = [];
    data.images.forEach((img, index) => {
      const destPath = `${galleryPath}\\${img.filename}`;
      const size = sizeMap.get(img.filename.toLowerCase());
      const isDownloaded = size !== undefined && size > 0;
      allItems.push({
        url: img.sourceUrl || img.url,
        destPath,
        galleryIndex: index,
        status: isDownloaded ? 'completed' : 'pending'
      });
    });

    const hasPending = allItems.some((i) => i.status === 'pending');
    if (!hasPending) {
      return false;
    }

    _startGalleryQueue(galleryPath, allItems);
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
  if (_activeQueue) {
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

let _getFileListViewportRange = null;

export const UrlLoader = {
  init({ Core, FsUtils, urlOverlay, getFileListViewportRange }) {
    _Core = Core;
    _FsUtils = FsUtils;
    _urlOverlay = urlOverlay;
    _getFileListViewportRange = typeof getFileListViewportRange === 'function' ? getFileListViewportRange : null;

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

        // Same directory: resume if queue is missing or not active for this gallery
        if (!_activeQueue || !_activeQueue.isActive || !_pathsEqual(dir, _activeGalleryPath)) {
          if (dir) {
            resumeGalleryDownloads(dir, state.list).catch(() => {});
          }
          return;
        }

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
  normalizeUrl,
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
  findMatchingGalleryImage,
  cleanupMatchingRawFiles,
  DOWNLOAD_CONCURRENCY,
  DownloadQueue
};

