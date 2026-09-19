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
 * - On navigation jump, cancel_download aborts every in-flight HTTP
 *   stream and starts the new active image in a fresh generation.
 * - On directory exit, the queue is cancelled and the active download
 *   is aborted.
 * - Image bridging: isPlaceholderFile() lets Core hold the previous
 *   viewer image until the target download completes.
 */

import { BoundedMap } from './services/cache.js';

const EXTRACTOR_MODULE_CACHE_CAPACITY = 20;
export const EXTRACTOR_MANIFEST_VERSION = 1;
export const MAX_PAGINATION_PAGES = 50;
const DOWNLOAD_QUEUE_RETRY_LIMIT = 1;
export const PREFETCH_START_THRESHOLD_PERCENT = 50;
const RESERVED_DEVICE_NAMES = /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i;
const SAFE_EXTRACTOR_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_EXTRACTOR_SOURCE_RE = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*\.js$/i;
const WINDOWS_NAME_FORBIDDEN_RE = /[<>:"/\\|?*\x00-\x1F]/;
const SUPPORTED_IMAGE_EXTENSIONS = new Set([
  'apng', 'avif', 'bmp', 'gif', 'ico', 'jpeg', 'jpg', 'png', 'svg', 'webp'
]);
export const MAX_GALLERY_PATH_DEPTH = 8;

let _urlOverlay = null;
let _Core = null;
let _FsUtils = null;
let _manifestCache = null;
let _libraryDirCache = null;
let _activeQueue = null;
let _activeGalleryPath = null;
let _activeGalleryItems = null;
let _coreStateUnsubscribe = null;
let _downloadThresholdUnlisten = null;
let _nextDownloadQueueId = 0;

// Blob URLs tracked separately for revocation on cache eviction.
const _blobUrls = new Map();
const _extractorCache = new BoundedMap(EXTRACTOR_MODULE_CACHE_CAPACITY, (id) => {
  const url = _blobUrls.get(id);
  if (url) {
    URL.revokeObjectURL(url);
    _blobUrls.delete(id);
  }
});

function _validateWindowsName(value, label) {
  if (typeof value !== 'string' || !value || value !== value.trim()) {
    throw new Error(`Extractor returned an invalid ${label}`);
  }
  const deviceBase = value.split('.', 1)[0];
  if (value === '.' || value === '..' || value.length > 100
    || WINDOWS_NAME_FORBIDDEN_RE.test(value) || /[. ]$/.test(value)
    || RESERVED_DEVICE_NAMES.test(deviceBase)) {
    throw new Error(`Extractor returned an unsafe ${label}: ${value}`);
  }
  return value;
}

function _validateImage(image, index) {
  if (!image || typeof image !== 'object' || !isValidUrl(image.url)) {
    throw new Error(`Extractor returned an invalid image URL at index ${index}`);
  }

  const filename = _validateWindowsName(image.filename, `filename at index ${index}`);
  const extension = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  if (!extension || !SUPPORTED_IMAGE_EXTENSIONS.has(extension)) {
    throw new Error(`Extractor returned an unsupported image filename at index ${index}`);
  }
}

function _validateGallery(gallery) {
  if (!gallery || typeof gallery !== 'object' || typeof gallery.id !== 'string' || !gallery.id.trim()) {
    throw new Error("Extractor returned invalid result: missing gallery id");
  }
  if (!Array.isArray(gallery.relativePath) || gallery.relativePath.length === 0
    || gallery.relativePath.length > MAX_GALLERY_PATH_DEPTH) {
    throw new Error("Extractor returned invalid result: gallery relativePath must be a non-empty path");
  }
  for (const segment of gallery.relativePath) {
    _validateWindowsName(segment, 'gallery path segment');
  }
}

function _galleryMatches(a, b) {
  if (a?.id !== b?.id || a?.relativePath?.length !== b?.relativePath?.length) return false;
  return a.relativePath.every((segment, index) => segment === b.relativePath[index]);
}

function _validateGalleryImageNames(images) {
  const filenames = new Set();
  for (const image of images) {
    const filename = image.filename.toLowerCase();
    if (filenames.has(filename)) {
      throw new Error(`Extractor returned duplicate filename: ${image.filename}`);
    }
    filenames.add(filename);
  }
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

export async function downloadFile(url, destPath, options = {}) {
  if (!window.__TAURI__) {
    throw new Error('Backend network proxy unavailable in browser environment');
  }
  const args = { url, destPath };
  if (options.requestId) args.requestId = options.requestId;
  if (Number.isInteger(options.queueGeneration)) args.queueGeneration = options.queueGeneration;
  if (Number.isInteger(options.thresholdPercent)) args.thresholdPercent = options.thresholdPercent;
  return await window.__TAURI__.core.invoke('download_to_file', args);
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

// -- Staggered Download Queue --

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
    this._downloadFile = options.downloadFile || downloadFile;
    this._cancelDownload = options.cancelDownload || cancelDownload;
    this._prefetchStartThresholdPercent = options.prefetchStartThresholdPercent ?? PREFETCH_START_THRESHOLD_PERCENT;
    this._cancelled = false;
    this._activeDestPath = null;
    this._visibleStart = options.visibleStart ?? 0;
    this._visibleEnd = options.visibleEnd ?? 0;
    this._inFlightItems = new Map();
    this._generation = 0;
    this._requestSequence = 0;
    this._queueId = ++_nextDownloadQueueId;
    this._prefetchUnlocked = false;
    this._awaitingActiveStart = false;
  }

  get isActive() {
    return !this._cancelled;
  }

  get isRunning() {
    return this._inFlightItems.size > 0 && !this._cancelled;
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
    return this._inFlightItems.has(item) ? 'downloading' : item.status;
  }

  setVisibleRange(start, end) {
    this._visibleStart = start;
    this._visibleEnd = end;
    this._admitPendingPrefetch();
  }

  prioritize(destPath) {
    const target = this._findItem(destPath);
    if (!target) return;

    if (target.status === 'error') {
      target.status = 'pending';
      target.retryCount = 0;
    }

    if (_pathsEqual(target.destPath, this._activeDestPath)) {
      if (target.status === 'completed') {
        this._prefetchUnlocked = true;
        this._admitPendingPrefetch();
      } else if (target.status === 'pending' && !this._awaitingActiveStart && !this._inFlightItems.has(target)) {
        this._startAttempt(target, 'active', this._generation);
      }
      return;
    }

    this._startActiveCutover(target);
  }

  cancel() {
    if (this._cancelled) return;
    this._cancelled = true;
    this._generation++;
    this._awaitingActiveStart = false;
    for (const item of this._inFlightItems.keys()) {
      this._updateStatus(item, 'pending');
    }
    this._inFlightItems.clear();
    this._cancelDownload().catch(() => {});
  }

  _isInViewport(item) {
    return item.galleryIndex >= this._visibleStart && item.galleryIndex < this._visibleEnd;
  }

  _getNextPrefetchItem() {
    const pending = this._items.filter((item) => item.status === 'pending' && !this._inFlightItems.has(item));
    if (pending.length === 0) return null;

    let pivotGi = Math.max(0, this._visibleStart);
    const activeItem = this._findItem(this._activeDestPath);
    if (activeItem) pivotGi = activeItem.galleryIndex;

    const visiblePending = pending.filter((item) => this._isInViewport(item));
    if (visiblePending.length === 0) return null;

    const forward = visiblePending
      .filter((item) => item.galleryIndex >= pivotGi)
      .sort((a, b) => a.galleryIndex - b.galleryIndex);
    if (forward.length > 0) return forward[0];

    const backward = visiblePending
      .filter((item) => item.galleryIndex < pivotGi)
      .sort((a, b) => b.galleryIndex - a.galleryIndex);
    return backward[0] || null;
  }

  async start() {
    if (this._cancelled || !this._activeDestPath) return;
    const target = this._findItem(this._activeDestPath);
    if (target?.status === 'completed') {
      this._prefetchUnlocked = true;
      this._admitPendingPrefetch();
    }
  }

  handleDownloadThreshold(payload) {
    if (this._cancelled || !payload?.requestId) return;
    const attempt = Array.from(this._inFlightItems.values())
      .find((candidate) => candidate.requestId === payload.requestId);
    if (!attempt || attempt.generation !== this._generation || attempt.kind !== 'prefetch') return;
    if (Number.isInteger(payload.queueGeneration) && payload.queueGeneration !== attempt.generation) return;

    attempt.thresholdReached = true;
    this._admitPendingPrefetch();
  }

  _startActiveCutover(target) {
    const mustCancel = this._inFlightItems.size > 0;
    const generation = ++this._generation;
    this._activeDestPath = target.destPath;
    this._prefetchUnlocked = target.status === 'completed';
    this._awaitingActiveStart = target.status !== 'completed';

    for (const item of this._inFlightItems.keys()) {
      this._updateStatus(item, 'pending');
    }
    this._inFlightItems.clear();

    const begin = mustCancel ? this._cancelDownload().catch(() => {}) : Promise.resolve();
    begin.then(() => {
      if (this._cancelled || generation !== this._generation) return;
      this._awaitingActiveStart = false;
      if (target.status === 'completed') {
        this._admitPendingPrefetch();
      } else {
        this._startAttempt(target, 'active', generation);
      }
    });
  }

  _admitPendingPrefetch() {
    if (this._cancelled || !this._prefetchUnlocked) return;

    for (const attempt of this._inFlightItems.values()) {
      if (!attempt.thresholdReached || attempt.admittedSuccessor) continue;
      const next = this._getNextPrefetchItem();
      if (!next) return;
      attempt.admittedSuccessor = true;
      this._startAttempt(next, 'prefetch', this._generation);
    }

    if (!this._hasPrefetchAttempt()) {
      const next = this._getNextPrefetchItem();
      if (next) this._startAttempt(next, 'prefetch', this._generation);
    }
  }

  _hasPrefetchAttempt() {
    for (const attempt of this._inFlightItems.values()) {
      if (attempt.kind === 'prefetch') return true;
    }
    return false;
  }

  _startAttempt(item, kind, generation) {
    if (this._cancelled || generation !== this._generation || this._inFlightItems.has(item)) return;
    const attempt = {
      item,
      kind,
      generation,
      requestId: `${this._queueId}:${generation}:${++this._requestSequence}`,
      thresholdReached: false,
      admittedSuccessor: false
    };
    this._inFlightItems.set(item, attempt);
    this._updateStatus(item, 'downloading');
    this._runAttempt(attempt).catch((err) => {
      console.warn('[DownloadQueue] Worker error:', err);
    });
  }

  _isCurrentAttempt(attempt) {
    return !this._cancelled && attempt.generation === this._generation && this._inFlightItems.get(attempt.item) === attempt;
  }

  async _runAttempt(attempt) {
    const { item } = attempt;
    let success = false;

    while (!success && item.retryCount <= DOWNLOAD_QUEUE_RETRY_LIMIT && this._isCurrentAttempt(attempt)) {
      try {
        await this._downloadFile(item.url, item.destPath, {
          requestId: attempt.requestId,
          queueGeneration: attempt.generation,
          thresholdPercent: attempt.kind === 'prefetch' ? this._prefetchStartThresholdPercent : null
        });
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

    if (!this._isCurrentAttempt(attempt)) return;
    this._inFlightItems.delete(item);

    if (success) {
      this._updateStatus(item, 'completed');
      if (attempt.kind === 'active') {
        this._prefetchUnlocked = true;
      } else {
        attempt.thresholdReached = true;
      }
      this._admitPendingPrefetch();
      this._refreshWhenComplete();
      return;
    }

    if (item.retryCount > DOWNLOAD_QUEUE_RETRY_LIMIT) {
      this._updateStatus(item, 'error');
    } else {
      this._updateStatus(item, 'pending');
    }
  }

  _refreshWhenComplete() {
    const allDone = this._items.every((item) => item.status === 'completed' || item.status === 'error');
    if (!allDone || this._inFlightItems.size > 0 || this._cancelled || !_FsUtils || !_Core || !_activeGalleryPath) return;
    try {
      const state = _Core.getState();
      if (state.directory && _pathsEqual(state.directory, _activeGalleryPath)) {
        _FsUtils.refresh();
      }
    } catch {}
  }

  _updateStatus(item, status) {
    item.status = status;
    if (!this._onItemStatusChanged) return;
    try {
      this._onItemStatusChanged(item.destPath, status, item);
    } catch (err) {
      console.error('[DownloadQueue] onItemStatusChanged error:', err);
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

  _manifestCache = validateManifest(manifest);
  return manifest;
}

export function validateManifest(manifest) {
  if (!manifest || manifest.version !== EXTRACTOR_MANIFEST_VERSION || !Array.isArray(manifest.extractors)) {
    throw new Error('Unsupported extractor manifest version');
  }

  const ids = new Set();
  for (const entry of manifest.extractors) {
    if (!entry || !SAFE_EXTRACTOR_ID_RE.test(entry.id || '') || ids.has(entry.id)) {
      throw new Error('Extractor manifest contains an invalid or duplicate id');
    }
    if (typeof entry.name !== 'string' || !entry.name.trim()
      || typeof entry.libraryPath !== 'string'
      || !Number.isInteger(entry.version) || entry.version < 1
      || !SAFE_EXTRACTOR_SOURCE_RE.test(entry.source || '') || entry.source.includes('..')
      || !Array.isArray(entry.patterns) || entry.patterns.length === 0) {
      throw new Error(`Extractor manifest entry '${entry.id}' is invalid`);
    }
    _validateWindowsName(entry.libraryPath, `library path for '${entry.id}'`);
    for (const pattern of entry.patterns) {
      if (typeof pattern !== 'string') {
        throw new Error(`Extractor manifest entry '${entry.id}' has an invalid pattern`);
      }
      try {
        new RegExp(pattern);
      } catch {
        throw new Error(`Extractor manifest entry '${entry.id}' has a malformed pattern`);
      }
    }
    ids.add(entry.id);
  }

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
  const cacheKey = `${entry.id}@${entry.version}`;
  const cached = _extractorCache.get(cacheKey);
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

  _blobUrls.set(cacheKey, blobUrl);
  _extractorCache.set(cacheKey, mod);
  return mod;
}

// -- Gallery extraction --

export function validateExtractorResult(result, entry) {
  if (!result || typeof result.provider !== 'string') {
    throw new Error("Extractor returned invalid result: missing 'provider' field");
  }
  if (entry && result.provider !== entry.name) {
    throw new Error(`Extractor provider '${result.provider}' does not match manifest entry '${entry.name}'`);
  }
  _validateGallery(result.gallery);
  if (!Array.isArray(result.images)) {
    throw new Error("Extractor returned invalid result: 'images' must be an array");
  }
  result.images.forEach(_validateImage);
  _validateGalleryImageNames(result.images);
  return result;
}

export function extractGallery(extractor, html, url, context = {}, entry = null) {
  const result = extractor.extract(html, url, context);
  if (result && typeof result.then === 'function') {
    return result.then((res) => validateExtractorResult(res, entry));
  }
  return validateExtractorResult(result, entry);
}

// -- Gallery Matching & Standalone Raw Cleanup --

export async function findMatchingGalleryImage(providerPath, directUrl, hash) {
  if (typeof window === 'undefined' || !window.__TAURI__) return null;
  try {
    const normalizedDirectUrl = normalizeUrl(directUrl);
    const targetHash = hash ? hash.toLowerCase() : null;
    const directories = [{ path: providerPath, depth: 0 }];

    while (directories.length > 0) {
      const current = directories.shift();
      const sidecarPath = `${current.path}\\gallery.json`;
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
              galleryPath: current.path,
              targetName: img.filename,
              image: img
            };
          }
        }
      } catch {
        // Not a gallery directory or invalid JSON; continue scanning.
      }

      if (current.depth >= MAX_GALLERY_PATH_DEPTH) continue;
      const dirResult = await window.__TAURI__.core.invoke('read_directory', {
        path: current.path,
        showHidden: false
      });
      for (const entry of dirResult?.files || []) {
        if (entry.is_dir) directories.push({ path: entry.path, depth: current.depth + 1 });
      }
    }
  } catch {
    // Provider directory may not exist yet or failed to read.
  }
  return null;
}

export async function cleanupMatchingRawFiles(providerPath, images) {
  if (typeof window === 'undefined' || !window.__TAURI__ || !Array.isArray(images) || images.length === 0) return;
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
  if (!mod.match(url)) {
    throw new Error(`Extractor '${entry.id}' does not support this URL`);
  }
  const providerDir = entry.libraryPath;
  const libraryDir = await getLibraryDir();
  const providerPath = `${libraryDir}\\${providerDir}`;

  // Direct image handling (e.g. https://i.imgur.com/04XS16K.png)
  const isDirect = typeof mod.isDirectUrl === 'function' && mod.isDirectUrl(url);
  if (isDirect) {
    const directInfo = typeof mod.parseDirectUrl === 'function' ? mod.parseDirectUrl(url) : null;
    const hash = directInfo?.hash || null;
    const rawFilename = directInfo?.filename || (url.split('/').pop() || 'image.png');
    const downloadUrl = directInfo?.url || url;
    _validateImage({ url: downloadUrl, filename: rawFilename }, 0);

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
      window.dispatchEvent(new CustomEvent('quivit-library-updated'));
    }

    return {
      galleryPath: providerPath,
      targetName: rawFilename,
      isRaw: true
    };
  }

  const html = await fetchRemoteText(url);
  const result = await extractGallery(mod, html, url, { fetchText: fetchRemoteText }, entry);

  // Pagination: follow nextPageUrl until exhausted or safety cap reached.
  let pages = 0;
  let nextUrl = result.nextPageUrl;
  while (nextUrl && pages < MAX_PAGINATION_PAGES) {
    const pageHtml = await fetchRemoteText(nextUrl);
    const pageResult = await extractGallery(mod, pageHtml, nextUrl, { fetchText: fetchRemoteText }, entry);
    if (!_galleryMatches(result.gallery, pageResult.gallery)) {
      throw new Error('Extractor pagination returned a different gallery');
    }
    result.images.push(...pageResult.images);
    nextUrl = pageResult.nextPageUrl;
    pages++;
  }
  result.nextPageUrl = null;

  if (!result.images || result.images.length === 0) {
    throw new Error('No images found in gallery');
  }

  _validateGalleryImageNames(result.images);
  const galleryPath = [libraryDir, providerDir, ...result.gallery.relativePath].join('\\');

  await ensureGalleryOwnership(galleryPath, result.gallery, url);

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
    gallery: {
      id: result.gallery.id,
      relativePath: result.gallery.relativePath,
      extractorId: entry.id,
      extractorVersion: entry.version
    },
    images: result.images.map((img) => ({
      filename: img.filename,
      displayName: img.filename,
      description: img.description || img.displayName || '',
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

  window.dispatchEvent(new CustomEvent('quivit-library-updated'));

  return { galleryPath, result, targetName: result.images[0]?.filename || null };
}

async function ensureGalleryOwnership(galleryPath, gallery, sourceUrl) {
  if (typeof window === 'undefined' || !window.__TAURI__) return;
  try {
    const content = await window.__TAURI__.core.invoke('read_text_file', {
      path: `${galleryPath}\\gallery.json`
    });
    const existing = JSON.parse(content);
    const existingId = existing?.gallery?.id;
    const sameLegacyGallery = !existingId
      && normalizeUrl(existing?.url || '') === normalizeUrl(sourceUrl);
    if (existingId !== gallery.id && !sameLegacyGallery) {
      throw new Error(`Library path is already used by another gallery: ${gallery.relativePath.join(' / ')}`);
    }
  } catch (err) {
    if (String(err?.message || err).includes('Library path is already used')) throw err;
  }
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
    onItemStatusChanged: (destPath, status) => {
      window.dispatchEvent(new CustomEvent('quivit-download-status', {
        detail: { destPath, status }
      }));

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

  window.dispatchEvent(new CustomEvent('quivit-download-status', {
    detail: { galleryPath, status: 'queue_started' }
  }));

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
  const cleanPath = String(filePath).replace(/\\/g, '/').toLowerCase();
  const cleanGallery = _activeGalleryPath.replace(/\\/g, '/').toLowerCase();
  if (cleanPath.includes('/') && !cleanPath.startsWith(cleanGallery) && !cleanGallery.startsWith(cleanPath)) {
    return false;
  }
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

export function cancelGalleryDownloads(galleryPath) {
  if (!galleryPath) return;
  if (_activeGalleryPath && _pathsEqual(_activeGalleryPath, galleryPath)) {
    _teardownActiveQueue();
  }
}

function _teardownActiveQueue() {
  if (_activeQueue) {
    _activeQueue.cancel();
    _activeQueue = null;
  }
  _activeGalleryPath = null;
  _activeGalleryItems = null;
  window.dispatchEvent(new CustomEvent('quivit-download-status', {
    detail: { status: 'cancelled' }
  }));
}

let _getFileListViewportRange = null;

export const UrlLoader = {
  init({ Core, FsUtils, urlOverlay, getFileListViewportRange }) {
    _Core = Core;
    _FsUtils = FsUtils;
    _urlOverlay = urlOverlay;
    _getFileListViewportRange = typeof getFileListViewportRange === 'function' ? getFileListViewportRange : null;

    if (!_downloadThresholdUnlisten && window.__TAURI__?.event?.listen) {
      window.__TAURI__.event.listen('quivit-download-threshold', (event) => {
        _activeQueue?.handleDownloadThreshold(event.payload);
      }).then((unlisten) => {
        _downloadThresholdUnlisten = unlisten;
      }).catch(() => {});
    }

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
  cancelGalleryDownloads,
  isPlaceholderFile,
  setVisibleRange,
  fetchRemoteText,
  fetchExtractorText,
  downloadFile,
  cancelDownload,
  getLibraryDir,
  fetchManifest,
  validateManifest,
  findExtractor,
  loadExtractorModule,
  extractGallery,
  validateExtractorResult,
  findMatchingGalleryImage,
  cleanupMatchingRawFiles,
  PREFETCH_START_THRESHOLD_PERCENT,
  DownloadQueue
};
